"use strict";
/* Serpent.io ONLINE client. Based on src/app.js (offline), but the world comes
   from the server (online/server): this page only draws it, with the same two
   renderers as the offline game (src/render-gpu.js, src/render-gl.js, unchanged).

   The renderers read one memory block laid out exactly like the offline
   WebAssembly memory (frame uniforms | snake headers | minimap | food | trails).
   Here that block is a plain ArrayBuffer that this file fills from the network:
   snapshots bring only each snake's head and size (a body once, when it comes
   into view) and changed food; this page lays the body points along the head's
   path itself, like the simulation. Heads are interpolated ~70 ms in the past so
   motion is smooth at any refresh rate. */

const SKINS = [
  ["#34d399", "#059669"], ["#38bdf8", "#0369a1"], ["#a78bfa", "#6d28d9"], ["#f472b6", "#be185d"],
  ["#fbbf24", "#b45309"], ["#fb7185", "#be123c"], ["#a3e635", "#4d7c0f"], ["#22d3ee", "#0e7490"],
  ["#fb923c", "#c2410c"], ["#818cf8", "#4338ca"], ["#f1f5f9", "#64748b"], ["#facc15", "#27272a"],
];
// Skins 12..127: the colour picker's choices (everyone builds the same list, so only the number is sent).
// 24 hues x 4 lightnesses, 12 soft hues, 8 greys; the stripe colour is a darker shade of the same.
{
  const hsl = (h, s, l) => { const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0"); }; return "#" + f(0) + f(8) + f(4); };
  const add = (h, s, l) => SKINS.push([hsl(h, s, l), hsl(h, s, l * 0.55)]);
  for (const l of [0.35, 0.5, 0.65, 0.8]) for (let h = 0; h < 360; h += 15) add(h, 0.85, l);
  for (let h = 0; h < 360; h += 30) add(h, 0.35, 0.6);
  for (let i = 0; i < 8; i++) add(0, 0, 0.12 + i * 0.115);
}
const nearestSkin = (hex) => { // the picker's colour → the closest skin from 12 on
  const c = (h) => [1, 3, 5].map((o) => parseInt(h.substr(o, 2), 16)), [r, g, b] = c(hex);
  let best = 12, bd = 1e9;
  for (let i = 12; i < SKINS.length; i++) { const [R, G, B] = c(SKINS[i][0]), d = 2 * (R - r) ** 2 + 4 * (G - g) ** 2 + 3 * (B - b) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
};
const BOT_NAMES = ["Noodle", "Slinky", "Viper", "Kaa", "Mamba", "Wiggles", "Nagini", "Zigzag", "Sir Hiss", "Boop", "Cobra Kai",
  "Pythonista", "Rattler", "Sidewinder", "Jormungandr", "Ouroboros", "Danger Noodle", "Spaghetti", "Slithers", "Taipan",
  "Adder", "Asp", "Basilisk", "Garter", "Krait", "Anaconda", "Boa", "Copperhead", "Hognose", "Kingsnake", "Milk Snake",
  "Racer", "Whip", "Coral", "Sssam", "Hisssy", "Zero Cool", "Lil Fang", "Mr. Scales", "Big Tony", "Worm", "Longboi", "Snek", "Nope Rope", "Sneaky", "Wriggle", "Laces"];

(async () => {
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  /* ---------------- the memory block the renderers read ---------------- */
  const NS = 160, RING = 512, RMASK = RING - 1, MAXF = 8192, INTERP = 4; // INTERP: ticks behind the newest snapshot
  const HDR = 48, MINI = HDR + NS * 48, FOOD = MINI + (NS + 4) * 16, TRAIL = (FOOD + MAXF * 8 + 15) & ~15;
  const mem = new ArrayBuffer(TRAIL + NS * RING * 4);
  const frameBlk = new Float32Array(mem, 0, 12), frameOut = new Int32Array(8);
  const hdrF = new Float32Array(mem, HDR, NS * 12), hdrU = new Uint32Array(mem, HDR, NS * 12);
  const miniF = new Float32Array(mem, MINI, (NS + 4) * 4), miniU = new Uint32Array(mem, MINI, (NS + 4) * 4);
  const food32 = new Uint32Array(mem, FOOD, MAXF * 2);
  const trail = new Int16Array(mem, TRAIL, NS * RING * 2);
  const tup = new Uint32Array(8192 * 3); let ntup = 0;
  const SLOT_W = 150, SLOT_H = 34, LS = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), CELLS_X = 8, CELLS_Y = NS / CELLS_X;
  const E = {
    mem, NS, RING, SLOT_W, SLOT_H, CELLS_X, CELLS_Y, AW: SLOT_W * LS * CELLS_X, AH: SLOT_H * LS * CELLS_Y,
    frameBlk, frameOut, trail, tup, ptr: { trail: TRAIL },
    arena: { base: 0, hdr: HDR, mini: MINI, food: FOOD, size: FOOD + MAXF * 8 },
  };
  E.arenaBytes = new Uint8Array(mem, 0, E.arena.size);
  E.palette = new Float32Array(SKINS.length * 8); // 128 main colours, then 128 stripe colours
  SKINS.forEach(([a, b], i) => [a, b].forEach((h, k) => [1, 3, 5].forEach((o, c) => { E.palette[(k * SKINS.length + i) * 4 + c] = parseInt(h.substr(o, 2), 16) / 255; })));

  /* ---------------- Renderer: WebGPU, or WebGL 2 when chosen ----------------
     If WebGPU fails (at start or later: driver reset, GPU process restart) the game
     stops and shows why, with "Try again" and "Use WebGL instead"; it never
     switches silently. ?renderer=webgl (or the menu) picks WebGL directly. */
  const canvas = $("gl");
  const saved = store.get("serpent.renderer") || "auto";
  const want = new URLSearchParams(location.search).get("renderer") || saved;
  // Is this browser running the site with its JavaScript/WebAssembly optimizer off
  // (Edge "Enhance your security on the web", Chrome "V8 optimizer" blocked)? That
  // mode also turns WebGPU off and makes the game ~30x slower. A tight loop tells:
  // a few ms with the optimizer, 10x more without it.
  function optimizerOff() { // fastest of 3 runs: the first one includes compiling
    let best = 1e9;
    for (let k = 0; k < 3; k++) {
      const t = performance.now(); let x = 0;
      for (let i = 0; i < 3e6; i++) x = (x + i * 7) | 0;
      best = Math.min(best, performance.now() - t + (x & 0));
    }
    return best > 25; // ~5 ms with the optimizer, 50+ without
  }
  const site = location.hostname || "this file";
  const securityHint = () => `<p style="margin:0 0 14px;padding:10px;border-radius:10px;background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.3);font-size:14px;line-height:1.5">
    <b>Likely cause:</b> your browser runs this site in a high-security mode (its JavaScript/WebAssembly optimizer is off here), which also turns off WebGPU and makes the game run about 30× slower.
    <b>Edge:</b> Settings → Privacy, search and services → “Enhance your security on the web” → Exceptions → add <b>${site}</b> (or choose Basic).
    <b>Chrome:</b> Settings → Privacy and security → Site settings → JavaScript optimization → allow <b>${site}</b>. Then reload.</p>`;
  function gpuProblem(title, detail) { // resolves when the player picks WebGL
    return new Promise((done) => {
      const el = document.createElement("div");
      el.className = "screen"; el.style.cssText = "z-index:50;background:rgba(4,6,12,.9)";
      el.innerHTML = `<div class="card glass" style="text-align:left"><h2 style="font-size:24px;margin-bottom:10px">${title}</h2>
        <p style="font:12.5px/1.5 ui-monospace,monospace;color:#fde68a;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:10px;padding:10px;word-break:break-word"></p>
        <p style="margin:12px 0 18px;color:var(--dim);font-size:14px;line-height:1.5">Step-by-step fixes: <a href="https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips"
        target="_blank" rel="noopener" style="color:var(--accent2)">WebGPU troubleshooting guide</a>.</p>
        ${optimizerOff() ? securityHint() : ""}
        <button class="play" data-a="retry">TRY AGAIN</button>
        <button class="play" data-a="gl" style="margin-top:10px;background:rgba(255,255,255,.08);color:var(--text);box-shadow:none">Use WebGL instead</button></div>`;
      el.querySelector("p").textContent = detail;
      el.querySelector('[data-a="retry"]').onclick = () => { location.href = location.pathname; };
      el.querySelector('[data-a="gl"]').onclick = () => { store.set("serpent.renderer", "webgl"); el.remove(); done(); }; // remembered; the menu switch changes it back
      document.body.appendChild(el);
    });
  }
  const toWebGL = () => { location.href = location.pathname + "?renderer=webgl"; };
  let R = null, gpuDown = false, gpuRestarts = 0;
  const touchDevice = matchMedia("(hover: none)").matches || navigator.maxTouchPoints > 0;
  if (want !== "webgl") {
    try { R = await createGPU(canvas, E); }
    catch (e) {
      console.warn("WebGPU failed:", e);
      // a browser with no WebGPU at all has nothing to fix: Auto goes straight to WebGL
      if (want !== "auto" || navigator.gpu) await gpuProblem("WebGPU isn't working", String(e && e.message || e));
      R = null;
      if (canvas.getContext("webgpu")) canvas.replaceWith(canvas.cloneNode()); // a failed WebGPU attempt holds the canvas
    }
    if (R) watchGPU(R);
  }
  // Phones and tablets drop the graphics device when you leave the page (another app, the
  // home screen, a locked screen). There WebGPU is simply made again when you come back,
  // with every snake's trail and name label sent anew; elsewhere a lost device is shown.
  function watchGPU(r) {
    r.device.lost.then((info) => {
      if (info.reason === "destroyed" || R !== r) return;
      if (touchDevice || document.hidden) restartGPU();
      else gpuProblem("WebGPU stopped", `The graphics device was lost: ${info.message || "no reason given"}`).then(toWebGL);
    });
    let shown = false; // a WebGPU error while playing: show the first one (the rest are usually the same)
    r.device.addEventListener("uncapturederror", (ev) => { if (!shown && R === r && !gpuDown) { shown = true; gpuProblem("WebGPU error", ev.error.message).then(toWebGL); } });
  }
  async function restartGPU() {
    if (gpuDown) return;
    gpuDown = true; // the main loop skips drawing meanwhile
    if (document.hidden) await new Promise((ok) => { const f = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", f); ok(); } }; document.addEventListener("visibilitychange", f); });
    for (let i = 0; i < 4; i++) {
      try {
        const r = await createGPU(canvas, E);
        R = r; watchGPU(r); resize(); slotKey.fill(""); gpuDown = false; gpuRestarts++;
        return;
      } catch (e) { console.warn("WebGPU restart failed:", e); await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); }
    }
    gpuProblem("WebGPU stopped", "The graphics device was lost and could not be started again.").then(toWebGL);
  }
  if (!R) R = createGL($("gl"), E);
  if (!R) { document.body.innerHTML = '<p style="padding:40px;font:18px system-ui;color:#fff">This game needs WebGPU or WebGL 2.</p>'; return; }
  const cv = $("gl");
  const QUAL = { sharp: 2, balanced: 1.25, fast: 1 };
  let quality = store.get("serpent.quality") || "sharp";
  for (const b of $("rsw").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", b.dataset.r === (store.get("serpent.renderer") || "auto")); // after any "Use WebGL instead"
    b.onclick = () => { store.set("serpent.renderer", b.dataset.r); location.href = location.pathname; };
  }
  $("rnow").textContent = R.name;
  const qEl = $("qsw");
  const markQ = () => { for (const b of qEl.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.q === quality); };
  for (const b of qEl.querySelectorAll("button")) b.onclick = () => { quality = b.dataset.q; store.set("serpent.quality", quality); markQ(); resize(); };
  markQ();

  let vw = 0, vh = 0;
  const miniEl = $("mini");
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, QUAL[quality] || 2);  // always full sharpness: never lowered automatically
    vw = Math.round(innerWidth * dpr); vh = Math.round(innerHeight * dpr);
    if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
    R.resize(vw, vh);
    const r = miniEl.getBoundingClientRect();
    R.placeMini(((r.left + r.width / 2) / innerWidth) * 2 - 1, 1 - ((r.top + r.height / 2) / innerHeight) * 2, (r.width / 2 - 3) * (vw / innerWidth));
    sendView();
  }
  addEventListener("resize", resize);

  /* ---------------- mirror of what the server told us ---------------- */
  let WR = 8000, me = -1, spectate = 1;
  const alive = new Uint8Array(NS), skin = new Uint8Array(NS), tier = new Uint8Array(NS), human = new Uint8Array(NS), boost = new Uint8Array(NS);
  const segN = new Uint16Array(NS), pcOf = new Uint32Array(NS), mass = new Float32Array(NS), kills = new Uint16Array(NS);
  const hist = Array.from({ length: NS }, () => []); // [{t, x, y, a}] newest last
  const pnames = new Array(NS).fill("");
  const botName = (s) => BOT_NAMES[(s * 7 + 3) % BOT_NAMES.length] + ["", " II", " III", " IV"][Math.min(3, Math.floor(s / BOT_NAMES.length))];
  const nameOf = (s) => (human[s] || pnames[s] ? pnames[s] || "Player" : botName(s));
  const radius = (m) => Math.min(10 + Math.sqrt(m) * 0.45, 40);
  const segsFor = (m) => Math.min(14 + Math.floor(3.6 * Math.sqrt(m)), RING - 1);
  const angOf = new Float32Array(NS);
  const fixq = (v) => { v *= 2; return Math.max(-32767, Math.min(32767, Math.trunc(v + (v >= 0 ? 0.5 : -0.5)))); }; // as sim.c fix()
  function uploadRun(s, a0, cnt) { const first = Math.min(cnt, RING - a0); upload(s, a0, first); if (first < cnt) upload(s, 0, cnt - first); }
  // Lay body points toward the new head, one every `spacing`, exactly the way the
  // simulation builds its trail: the server sends only the head, never the points.
  function layTrail(s, x, y) {
    const sp = radius(mass[s]) * 0.42; let pc = pcOf[s], cnt = 0;
    for (; cnt < 8; cnt++) {
      const j = (s * RING + ((pc - 1) & RMASK)) * 2, lx = trail[j] * 0.5, ly = trail[j + 1] * 0.5, dx = x - lx, dy = y - ly, d2 = dx * dx + dy * dy;
      if (d2 < sp * sp) break;
      const f = sp / Math.sqrt(d2), k = (s * RING + (pc & RMASK)) * 2;
      trail[k] = fixq(lx + dx * f); trail[k + 1] = fixq(ly + dy * f); pc++;
    }
    if (cnt) uploadRun(s, (pcOf[s] & RMASK), cnt);
    pcOf[s] = pc;
  }

  /* Your own snake is predicted here. Waiting for the server (a round trip, plus the
     ~70 ms other snakes are drawn in the past) makes turning feel slow, so your snake
     moves on this device at once, with the simulation's own turning and speed rules and
     the inputs exactly as sent. Each snapshot says which input the server last had and
     how many steps ago; the prediction at that same moment is compared with the server's
     head, and the difference is corrected gently (the server stays in charge). */
  const PREDICT = new URLSearchParams(location.search).get("predict") !== "0"; // ?predict=0: off (for comparison)
  const LAGTEST = new URLSearchParams(location.search).get("lagtest") === "1"; // ?lagtest=1: fake stalls (testing)
  const pred = { on: false, x: 0, y: 0, a: 0, hist: [] }; // hist: {t, x, y}, newest last
  const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function predStart(x, y, a) { pred.on = true; pred.x = x; pred.y = y; pred.a = a; pred.dx = Math.cos(a); pred.dy = Math.sin(a); pred.acc = 0; pred.m = mass[me]; pred.hist.length = 0; }
  // Fixed 1/60 s steps with exactly the simulation's maths (moveSnake): rotate the heading
  // by at most the turn rate, then move. A long frame runs several steps, so the path bends
  // the way the server's does (one big turn-then-move made it drift sideways).
  const STEP = 1 / 60;
  function predStep(now, dt) {
    pred.acc = Math.min((pred.acc || 0) + dt, 0.5);
    while (pred.acc >= STEP) {
      pred.acc -= STEP;
      const turn = 5.2 / (1 + (radius(mass[me]) - 12) * 0.045) * STEP;
      let da = wrapA(sentAim - pred.a); da = Math.max(-turn, Math.min(turn, da));
      if (da !== 0) {
        pred.a = wrapA(pred.a + da);
        const d2 = da * da, c = 1 - d2 * 0.5 + d2 * d2 / 24, sn = da * (1 - d2 / 6);
        const x = pred.dx * c - pred.dy * sn, y = pred.dx * sn + pred.dy * c, f = 1.5 - 0.5 * (x * x + y * y);
        pred.dx = x * f; pred.dy = y * f;
      }
      // boosting needs mass over 14 and uses it up (as moveSnake): predict that too, or the
      // boost would run on here after the server has stopped it, and the snake jump back
      const boosting = lastBoostSent > 0 && pred.m > 14;
      if (boosting) pred.m -= (6 + pred.m * 0.006) * STEP;
      const v = (boosting ? 430 : 195) * STEP;
      pred.x += pred.dx * v; pred.y += pred.dy * v;
      pred.hist.push({ t: now - pred.acc * 1000, x: pred.x, y: pred.y }); if (pred.hist.length > 240) pred.hist.shift();
    }
  }
  // where to draw the head: the last step, carried forward by the part of a step since
  const predShown = () => { const v = (lastBoostSent > 0 && pred.m > 14 ? 430 : 195) * (pred.acc || 0); return [pred.x + pred.dx * v, pred.y + pred.dy * v]; };
  function predCorrect(seq, steps, sx, sy) { // server head (sx, sy), `steps` steps after it received input `seq`
    const h = pred.hist, t = sentAt[seq] + steps * (1000 / 60);
    if (!pred.on || h.length < 2 || t < h[0].t || t > h[h.length - 1].t) return;
    // Compare only a moment for which the server had every input this page had sent by then.
    // If the next input was sent before that moment but hadn't reached the server (a stall),
    // the server's head is still on the old course while ours has turned: "correcting" toward
    // it would pull the snake sideways and back again when the input arrives.
    const nxt = (seq + 1) & 255;
    if (inSeq !== seq && sentAt[nxt] > sentAt[seq] && sentAt[nxt] < t - 4) return;
    let i = h.length - 2; while (i > 0 && h[i].t > t) i--;
    const f = (t - h[i].t) / Math.max(1e-6, h[i + 1].t - h[i].t);
    const ex = sx - (h[i].x + (h[i + 1].x - h[i].x) * f), ey = sy - (h[i].y + (h[i + 1].y - h[i].y) * f);
    pred.err = Math.hypot(ex, ey);
    if (window.__predLog) window.__predLog.push({ t: performance.now(), err: pred.err, seq, steps, boost: lastBoostSent, mass: mass[me], aimGap: wrapA(sentAim - pred.a), hist: h.length });
    // 30% of the gap per 2 steps (whatever the snapshot rate): smooth, settles in ~0.2 s. A big
    // gap (the server was told otherwise, e.g. after a lag spike) is closed at once, but here
    // and now: the server head is from a moment ago, so jumping to it would throw the snake back.
    const k = ex * ex + ey * ey > 60 * 60 ? 1 : 1 - Math.pow(0.7, snapInt / 2), kx = ex * k, ky = ey * k;
    pred.x += kx; pred.y += ky; for (const e of h) { e.x += kx; e.y += ky; }
  }
  // food: server slot -> local slot (local slots stay dense so the GPU draws few)
  const toLocal = new Int32Array(32768).fill(-1), freeL = []; let foodHigh = 0;
  const miniList = []; // from the 4 Hz MINI message: [slot, skin, x, y, mass]
  let board = { alive: 0, rank: 0, top: [] };
  let estTick = -1, lastSnapAt = 0, bytesIn = 0;
  /* Adaptive smoothing delay (a jitter buffer, as in most action games). Other snakes are
     drawn between snapshots, a little in the past; the delay only has to cover one snapshot
     interval, how late snapshots *usually* arrive, and a step of margin.
     Measured Brisbane -> Kansas City (TCP over the Pacific): 95% of snapshots arrive within
     ~9 ms of the fastest, but a lost packet stalls everything for 100-300 ms a few times a
     minute. Sizing the delay for those stalls (the old 98% of the last 1.5 s, shrinking at
     half a step a second) kept it at ~120 ms all the time, and the stalls still froze snakes.
     Now: 95% of the last 10 s, at most 6 steps, back down within a couple of seconds; a stall
     is bridged by carrying snakes on along their course (see interp) instead of waiting.
     Arrivals are timed when the browser received them (msgAt), against the fastest. */
  const ARR_N = 600, INTERP_MAX = 6, EXTRA_MAX = 10; // window (10 s of snapshots), steps
  const arrOff = [], gaps = []; let arrLo = 0, interpGoal = INTERP, interpT = INTERP, interpSent = INTERP, rtS = -1, lastRt = 0, snapInt = 2, lastSnapTick = -1;
  function noteArrival(t) {
    arrOff.push((msgAt || performance.now()) - t * (1000 / 60)); if (arrOff.length > ARR_N) arrOff.shift();
    if (lastSnapTick >= 0 && t > lastSnapTick && t - lastSnapTick < 8) { gaps.push(t - lastSnapTick); if (gaps.length > 30) gaps.shift(); }
    lastSnapTick = t;
    if (gaps.length >= 5) snapInt = [...gaps].sort((a, b) => a - b)[gaps.length >> 1]; // steps between snapshots (1 or 2)
    if (arrOff.length < 10) return;
    let lo = Infinity; for (const o of arrOff) if (o < lo) lo = o; arrLo = lo;
    const late = arrOff.map((o) => (o - arrLo) * 0.06).sort((a, b) => a - b); // steps late, each
    interpGoal = Math.min(INTERP_MAX, Math.max(snapInt + 1, snapInt + late[Math.floor(late.length * 0.95)] + 1)); // +1: margin
  }

  function clearWorld() {
    alive.fill(0); for (const h of hist) h.length = 0;
    food32.fill(0); toLocal.fill(-1); freeL.length = 0; foodHigh = 0;
  }
  function upload(s, first, count) { // trail range to (re)send to the GPU
    if (ntup >= 8190) { ntup = 0; for (let i = 0; i < NS; i++) if (alive[i]) { tup[ntup * 3] = i; tup[ntup * 3 + 1] = 0; tup[ntup * 3 + 2] = RING; ntup++; } return; }
    tup[ntup * 3] = s; tup[ntup * 3 + 1] = first; tup[ntup * 3 + 2] = count; ntup++;
  }

  function onSnap(d) {
    let o = 1;
    const tick = d.getUint32(o, true); o += 4;
    me = d.getUint8(o) === 255 ? -1 : d.getUint8(o); spectate = d.getUint8(o + 1);
    if (d.getUint8(o + 2) & 1) clearWorld(); // server resync
    if (me >= 0) kills[me] = d.getUint16(o + 3, true);
    const ackSeq = d.getUint8(o + 5), ackSteps = d.getUint8(o + 6);
    o += 7;
    const n = d.getUint8(o); o += 1;
    const seen = new Uint8Array(NS);
    for (let k = 0; k < n; k++) {
      const s = d.getUint8(o), fl = d.getUint8(o + 1); o += 2;
      boost[s] = fl & 1; human[s] = fl & 2 ? 1 : 0;
      let x, y;
      if (fl & 4) { // the whole body: when it comes into view (or after a resync)
        skin[s] = d.getUint8(o) % 12; tier[s] = d.getUint8(o + 1);
        x = d.getInt16(o + 2, true) * 0.5; y = d.getInt16(o + 4, true) * 0.5; mass[s] = d.getUint16(o + 6, true) / 4;
        const cnt = d.getUint16(o + 8, true); o += 10;
        const base = (pcOf[s] + RING) >>> 0; // a fresh stretch of the ring
        let px = d.getInt16(o, true), py = d.getInt16(o + 2, true); o += 4;
        for (let i = 0; i < cnt; i++) {
          if (i) { px += d.getInt8(o); py += d.getInt8(o + 1); o += 2; }
          const j = (s * RING + ((base + i) & RMASK)) * 2; trail[j] = px; trail[j + 1] = py;
        }
        pcOf[s] = (base + cnt) >>> 0; upload(s, 0, RING);
        hist[s].length = 0;
        const j = (s * RING + ((pcOf[s] - 1) & RMASK)) * 2;
        if (x !== trail[j] * 0.5 || y !== trail[j + 1] * 0.5) angOf[s] = Math.atan2(y - trail[j + 1] * 0.5, x - trail[j] * 0.5);
      } else { // only the head (and the size when it changed)
        const h = hist[s], last = h[h.length - 1];
        if (fl & 8) { x = d.getInt16(o, true) * 0.5; y = d.getInt16(o + 2, true) * 0.5; o += 4; }
        else { x = (last ? last.x : 0) + d.getInt8(o) * 0.5; y = (last ? last.y : 0) + d.getInt8(o + 1) * 0.5; o += 2; }
        if (fl & 16) { mass[s] = d.getUint16(o, true) / 4; o += 2;
          if (s === me && pred.on) pred.m = mass[s] - (lastBoostSent > 0 && mass[s] > 14 ? (6 + mass[s] * 0.006) * rttMs / 1000 : 0); } // (that server mass is a round trip old)
        if (last && (x !== last.x || y !== last.y)) angOf[s] = Math.atan2(y - last.y, x - last.x);
        if (s === me && pred.on) {
          if (!(fl & 1) && lastBoostSent > 0 && ((ackSeq - boostSeq) & 255) < 128 && pred.m > 14) pred.m = 14; // it has our boost press but isn't boosting: too small
          predCorrect(ackSeq, ackSteps, x, y); // your body follows the prediction instead
        }
        else layTrail(s, x, y);
      }
      segN[s] = segsFor(mass[s]); alive[s] = 1; seen[s] = 1;
      const h = hist[s]; h.push({ t: tick, x, y, a: angOf[s] }); if (h.length > 24) h.shift(); // 24: back to a crash before a grace wait
    }
    for (let s = 0; s < NS; s++) if (!seen[s] && alive[s]) { alive[s] = 0; hist[s].length = 0; }
    const m = d.getUint16(o, true); o += 2;
    const bornNow = (tick >> 2) & 0xffff, bornOld = ((tick >> 2) - 255) & 0xffff;
    for (let k = 0; k < m; k++) {
      const v = d.getUint16(o, true), srv = v & 0x7fff; o += 2;
      let j = toLocal[srv];
      if (!(v & 0x8000)) { if (j >= 0) { food32[j * 2] = food32[j * 2 + 1] = 0; freeL.push(j); toLocal[srv] = -1; } continue; } // gone
      const lo = d.getUint32(o, true), sk = d.getUint8(o + 5);
      const hi = (d.getUint8(o + 4) | ((sk & 127) << 8) | ((sk & 128 ? bornNow : bornOld) << 16)) >>> 0; o += 6; // value, skin, born
      if (j < 0) { j = freeL.length ? freeL.pop() : foodHigh < MAXF ? foodHigh++ : -1; if (j < 0) continue; toLocal[srv] = j; }
      food32[j * 2] = lo; food32[j * 2 + 1] = hi;
    }
    while (foodHigh && !food32[(foodHigh - 1) * 2 + 1]) { // keep the drawn range tight
      foodHigh--; const i = freeL.indexOf(foodHigh); if (i >= 0) freeL.splice(i, 1);
    }
    // server clock: advance smoothly, nudge toward what arrives
    if (estTick < 0 || Math.abs(tick - estTick) > 30) estTick = tick; else estTick += (tick - estTick) * 0.08;
    noteArrival(tick);
    lastSnapAt = performance.now();
  }

  /* ---------------- network ---------------- */
  const params = new URLSearchParams(location.search);
  const DEFAULT_SERVER = "__SERVER_URL__";
  const serverURL = params.get("server") ||
    (/^https?:$/.test(location.protocol) && !location.hostname.endsWith("github.io") ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + location.pathname.replace(/[^/]*$/, "") + "ws"
      : DEFAULT_SERVER.startsWith("__") ? "" : DEFAULT_SERVER);
  let ws = null, connected = false, retry = 0;
  const statusEl = $("net");
  function setStatus(txt, cls) { statusEl.textContent = txt; statusEl.className = "net " + (cls || ""); }
  function connect() {
    if (!serverURL) { setStatus("", ""); $("play").disabled = true; return; } // no server set up for this copy of the page
    setStatus("Connecting to server…");
    try { ws = new WebSocket(serverURL); } catch { setStatus("Can't reach the server", "bad"); return; }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => { connected = true; retry = 0; $("play").disabled = false; sendView(); startPings(); if (state !== "menu") join(); };
    const take = (data, at) => { bytesIn += data.byteLength; msgAt = at; onMessage(new DataView(data)); };
    let held = null; // ?lagtest=1: every 4 s, hold everything for 200 ms (what a lost packet does to TCP)
    ws.onmessage = (e) => {
      if (LAGTEST && (held || performance.now() % 4000 < 200)) {
        if (!held) { held = []; setTimeout(() => { const q = held; held = null; for (const d of q) take(d, performance.now()); }, 200); }
        held.push(e.data); return;
      }
      take(e.data, e.timeStamp || performance.now());
    };
    ws.onclose = () => {
      connected = false; clearInterval(pingTimer); $("play").disabled = true; clearWorld(); me = -1;
      if (state === "play") { state = "dead"; showOver("Lost connection to the server"); }
      setStatus("Can't reach the server — retrying… (or play offline)", "bad");
      setTimeout(connect, Math.min(10000, 1500 * ++retry));
    };
  }
  const sendRaw = (bytes) => { if (connected && ws.readyState === 1) ws.send(bytes); };
  /* Delay test: tiny PING messages, answered at once by the server. A burst of 5 when the
     connection opens, then one every 4 s in the background. The fastest of the last 5
     round trips goes to the server, which allows for it when judging your collisions. */
  const pingAt = new Float64Array(256), rtts = []; let pingId = 0, rttMs = 0, rttSent = -1, pingTimer = 0;
  let msgAt = 0; // when the browser received the last message (not when this page got to it)
  function ping() { pingId = (pingId + 1) & 255; pingAt[pingId] = performance.now(); sendRaw(new Uint8Array([5, pingId])); }
  function onPong(id) {
    rtts.push(Math.max(0, msgAt - pingAt[id])); if (rtts.length > 5) rtts.shift();
    rttMs = Math.min(...rtts); // the fastest recent round trip: the true delay plus as little extra as possible (never too high)
    if (rtts.length >= 3 && Math.abs(rttMs - rttSent) > 8) sendDelay();
  }
  function sendDelay() { // round trip, and the smoothing delay in tenths of a step: together, how late we see others
    const b = new Uint8Array(4); b[0] = 6; new DataView(b.buffer).setUint16(1, Math.min(1000, Math.round(rttMs)), true); b[3] = Math.round(interpT * 10);
    sendRaw(b); rttSent = rttMs; interpSent = interpT;
  }
  function startPings() {
    rtts.length = 0; rttSent = -1; clearInterval(pingTimer);
    for (let i = 0; i < 5; i++) setTimeout(ping, i * 150);
    pingTimer = setInterval(ping, 4000);
  }
  function sendView() { const b = new Uint8Array(3); b[0] = 3; new DataView(b.buffer).setUint16(1, Math.round((vw / Math.max(1, vh)) * 1000), true); sendRaw(b); }
  function join() {
    const nm = new TextEncoder().encode(playerName()).slice(0, 48);
    const b = new Uint8Array(5 + nm.length), dv = new DataView(b.buffer);
    b[0] = 1; b[1] = skinSel; dv.setUint16(2, Math.round((vw / Math.max(1, vh)) * 1000), true); b[4] = nm.length; b.set(nm, 5);
    sendRaw(b);
    if (rtts.length >= 3) sendDelay(); // the server applies it to the new snake
  }
  let lastAimSent = 9, lastBoostSent = -1, lastInputAt = 0, sentAim = 0, inSeq = 0, boostSeq = 0; // boostSeq: the input that pressed boost
  const sentAt = new Float64Array(256); // when each input (by its 8-bit number) was sent
  function sendInput(now, aim, b) {
    if (Math.abs(wrapA(aim - lastAimSent)) < 0.004 && b === lastBoostSent && now - lastInputAt < 250) return;
    if (now - lastInputAt < 15 && b === lastBoostSent) return; // at most ~60/s
    const u = new Uint8Array(7), dv = new DataView(u.buffer);
    let a = aim; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI;
    const q = Math.round(((a + Math.PI) / (2 * Math.PI)) * 65535);
    inSeq = (inSeq + 1) & 255; sentAt[inSeq] = now;
    if (b && lastBoostSent <= 0) boostSeq = inSeq;
    u[0] = 2; dv.setUint16(1, q, true); u[3] = b; u[4] = inSeq;
    dv.setUint16(5, Math.floor(now) & 0xffff, true); // when it was made (this page's clock, ms): the server sees how late each input arrives
    sendRaw(u); lastAimSent = aim; lastBoostSent = b; lastInputAt = now;
    sentAim = q / 65535 * 2 * Math.PI - Math.PI; // exactly what the server will steer toward
  }
  function onMessage(d) {
    switch (d.getUint8(0)) {
      case 1: WR = d.getFloat32(4, true); setStatus(`Online · ${d.getUint8(9)} player${d.getUint8(9) === 1 ? "" : "s"} playing`, "ok"); break;
      case 2: onSnap(d); break;
      case 3: {
        board = { alive: d.getUint16(1, true), rank: d.getUint16(3, true), top: [] };
        for (let i = 0, k = d.getUint8(5), o = 6; i < k; i++, o += 8) board.top.push([d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3), d.getFloat32(o + 4, true)]);
        break;
      }
      case 4: { const s = d.getUint8(1), len = d.getUint8(2); pnames[s] = new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset + 3, len)); human[s] = len ? 1 : human[s]; slotKey[s] = ""; break; }
      case 5: // newer servers add the crash's step and head (Q1): the picture is drawn as at that moment
        // the picture: what this screen showed when your head touched (taken on the spot), else
        // the server's crash step (newer servers add its step and head, Q1)
        deathPose = localShot && performance.now() - localShot.t < 1500 ? null :
          d.byteLength >= 16 && me >= 0 ? { s: me, t: d.getUint32(8, true), x: d.getInt16(12, true) * 0.5, y: d.getInt16(14, true) * 0.5 } : null;
        onDeath(d.getUint8(1), d.getUint16(2, true), d.getFloat32(4, true)); break;
      case 6: {
        miniList.length = 0;
        for (let i = 0, k = d.getUint16(1, true), o = 3; i < k; i++, o += 5) { // slot, x, y (a byte each), skin, size
          const sz = d.getUint8(o + 4) * 4;
          miniList.push([d.getUint8(o), d.getUint8(o + 3) & 127, (d.getUint8(o + 1) / 255 * 2 - 1) * WR, (d.getUint8(o + 2) / 255 * 2 - 1) * WR, sz * sz]);
        }
        break;
      }
      case 8: onPong(d.getUint8(1)); break;
      case 9: { // chat line: slot, name, text
        const nl = d.getUint8(2), td = new TextDecoder();
        const name = td.decode(new Uint8Array(d.buffer, d.byteOffset + 3, nl)), tl = d.getUint16(3 + nl, true);
        const text = td.decode(new Uint8Array(d.buffer, d.byteOffset + 5 + nl, tl));
        if (text === chatLast) clearTimeout(chatWait); // our own line came back: chat works
        addChat(name || "Player", text);
        break;
      }
      case 7: setStatus("The server is full right now — try again soon, or play offline", "bad"); state = "menu"; showMenu(); break;
    }
  }

  /* ---------------- UI ---------------- */
  let skinSel = (+(store.get("serpent.skin") ?? 0) | 0) & 127;
  const skinsEl = $("skins");
  const pickSkin = (i) => { skinSel = i; store.set("serpent.skin", i); [...skinsEl.children].forEach((c, j) => c.setAttribute("aria-pressed", j === Math.min(i, 12))); };
  const stripes = ([a, b]) => `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;
  SKINS.slice(0, 12).forEach((sk, i) => {
    const el = document.createElement("button");
    el.className = "skin"; el.title = `Skin ${i + 1}`; el.style.background = stripes(sk);
    el.onclick = () => pickSkin(i);
    skinsEl.appendChild(el);
  });
  { // last: any colour (a colour picker; the snake gets the nearest of 116 shades)
    const el = document.createElement("label"), inp = document.createElement("input");
    el.className = "skin pick"; el.title = "Pick your own colour"; inp.type = "color";
    const show = () => { el.style.background = skinSel >= 12 ? stripes(SKINS[skinSel]) : ""; };
    inp.value = SKINS[skinSel >= 12 ? skinSel : 12][0];
    inp.addEventListener("input", () => { pickSkin(nearestSkin(inp.value)); show(); });
    el.onclick = () => { if (skinSel < 12) { pickSkin(nearestSkin(inp.value)); show(); } };
    el.appendChild(inp); skinsEl.appendChild(el); show();
  }
  pickSkin(skinSel);
  const nameEl = $("name"); nameEl.value = store.get("serpent.name") ?? "";
  let best = +(store.get("serpent.best.online") ?? 0);
  const playerName = () => nameEl.value.trim() || "You";
  let state = "menu"; // menu | play | dead

  // this run's numbers, for the information sheet
  const run = { t0: 0, peak: 0, rankBest: 0, rankNow: 0, total: 0 }; let lastRun = null, grabPending = false;
  function start() {
    if (!connected) return;
    Object.assign(run, { t0: performance.now(), peak: 0, rankBest: 0, rankNow: 0, total: 0 }); localShot = null; touching = false;
    store.set("serpent.name", nameEl.value.trim());
    join();
    state = "play"; document.body.classList.add("playing");
    $("menu").classList.add("hidden"); $("over").classList.add("hidden");
    nameEl.blur();
  }
  function showMenu() { document.body.classList.remove("playing"); $("over").classList.add("hidden"); $("menu").classList.remove("hidden"); requestAnimationFrame(() => { chatLog.scrollTop = chatLog.scrollHeight; }); }
  function toMenu() { if (state !== "menu") sendRaw(new Uint8Array([4])); state = "menu"; showMenu(); }
  function showOver(by) {
    $("by").innerHTML = by;
    setTimeout(() => { if (state === "dead") { $("over").classList.remove("hidden"); document.body.classList.remove("playing"); } }, 900);
  }
  const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  /* The moment of death for the information sheet: every snake as at the server's crash step
     (no smoothing), each body cut back to that head (its newer points were laid after: your
     own ones by the prediction, ahead of the server). Undone after the one frame drawn so. */
  let deathPose = null, localShot = null, touching = false, touchShot = false;
  // Your head as drawn on this screen against the bodies as drawn (and the edge), with the
  // server's front-of-head rule. When a contact starts, that frame is copied for the sheet.
  function localHit() {
    const s = me, R = radius(mass[s]), x = hx[s], y = hy[s];
    if (x * x + y * y > (WR - R * 0.5) ** 2) return true;
    const dx = Math.cos(ha[s]), dy = Math.sin(ha[s]);
    for (let o = 0; o < NS; o++) {
      if (o === s || !shown[o]) continue;
      const r = radius(mass[o]), n = segN[o], ex = hx[o] - x, ey = hy[o] - y, reach = n * r * 0.42 + R + r + 40;
      if (ex * ex + ey * ey > reach * reach) continue;
      const a = Math.max(R * 0.5, R - r * 0.5), fx = x + dx * a, fy = y + dy * a, t2 = (r * 0.8) ** 2, base = o * RING, pc = pcOf[o];
      for (let j = 0; j < n; j++) {
        const i = (base + ((pc - 1 - j) >>> 0 & RMASK)) * 2, qx = trail[i] * 0.5 - fx, qy = trail[i + 1] * 0.5 - fy;
        if (qx * qx + qy * qy < t2) return true;
      }
    }
    return false;
  }
  function poseAt(p) {
    const undo = [];
    for (let s = 0; s < NS; s++) {
      const h = hist[s]; let x = p.x, y = p.y; // yours: exactly where the server had your head (even if a snapshot already dropped you)
      if (s !== p.s) {
        if (!alive[s] || !h.length) continue;
        let a = h[0], b = h[0];
        if (p.t >= h[h.length - 1].t) a = b = h[h.length - 1];
        else for (let i = 0; i < h.length - 1; i++) if (h[i + 1].t > p.t) { a = h[i]; b = h[i + 1]; break; }
        const f = b.t > a.t ? Math.min(1, Math.max(0, (p.t - a.t) / (b.t - a.t))) : 1;
        x = a.x + (b.x - a.x) * f; y = a.y + (b.y - a.y) * f;
      }
      let bj = 0, bd = 1e18;
      for (let j = 0; j < Math.min(60, segN[s]); j++) { const [qx, qy] = TXY(s, j), d = (qx - x) ** 2 + (qy - y) ** 2; if (d < bd) { bd = d; bj = j; } }
      undo.push([s, pcOf[s]]); pcOf[s] -= bj;
      const [bx, by] = TXY(s, 1);
      hx[s] = x; hy[s] = y; ha[s] = Math.atan2(y - by, x - bx); shown[s] = 1;
    }
    return undo;
  }
  function onDeath(killer, k, m) {
    if (state !== "play") return;
    state = "dead";
    const len = Math.floor(m * 10), isBest = len > best;
    if (isBest) { best = len; store.set("serpent.best.online", best); }
    $("oLen").textContent = len; $("oKills").textContent = k; $("oBest").textContent = best; $("oBest").classList.toggle("new", isBest);
    showOver(killer !== 255 ? `Crashed into <b>${esc(nameOf(killer))}</b>` : "You hit the edge of the world");
    if (localShot && performance.now() - localShot.t < 1500) deathShot.img = localShot.img; // already taken: no new copy
    lastRun = { name: playerName(), mode: "Online", length: len, peak: Math.max(run.peak, len), best, kills: k, rankNow: run.rankNow, rankBest: run.rankBest,
      total: run.total, killer: killer !== 255 ? nameOf(killer) : "The edge of the world", seconds: (performance.now() - run.t0) / 1000, colour: SKINS[skinSel][0] };
    grabPending = !(localShot && performance.now() - localShot.t < 1500); // else the next frame drawn is copied
  }
  $("play").onclick = start; $("again").onclick = start;
  $("toStart").onclick = toMenu;
  $("sheet").onclick = () => { if (lastRun) downloadDeathSheet(lastRun); };
  $("play").disabled = true;
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); e.stopPropagation(); });

  /* ---------------- input (as offline) ---------------- */
  let aim = 0, mouseBoost = false, keyBoost = false, touchBoost = false, keyTurn = 0, usingKeys = false; const keysDown = new Set();
  let mx = innerWidth / 2 + 100, my = innerHeight / 2;
  // The mouse takes over again only when it really moves: browsers also send "moves" when
  // the page changes under a still cursor, which used to swing the snake toward it.
  let keyAnchorX = 0, keyAnchorY = 0;
  // Keys steer relative to where your snake is heading NOW (the prediction): aim a little to
  // that side (it turns at its own top speed) or straight ahead. An aim that ran on by
  // itself could get more than half a turn ahead of a slow-turning big snake, which then
  // turned the other way. Called every frame, and also straight from input events, so a
  // move goes out at once instead of at the next frame (sendInput limits it to ~60/s).
  function steerNow(now) {
    if (state !== "play") return;
    if (usingKeys) aim = (pred.on ? pred.a : me >= 0 ? ha[me] : aim) + keyTurn * 0.6;
    else aim = Math.atan2(my - innerHeight / 2, mx - innerWidth / 2);
    sendInput(now, aim, mouseBoost || keyBoost || touchBoost ? 1 : 0);
  }
  const onMouseMove = (e) => {
    if (e.pointerType !== "mouse") return;
    mx = e.clientX; my = e.clientY;
    if (usingKeys && Math.hypot(mx - keyAnchorX, my - keyAnchorY) > 6) usingKeys = false;
    steerNow(performance.now());
  };
  // pointerrawupdate (Chrome, Edge; secure pages) arrives as the mouse moves; pointermove is
  // held back to the next frame. Use the first where there is one.
  cv.addEventListener("onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove", onMouseMove);
  cv.addEventListener("mousedown", () => { mouseBoost = true; steerNow(performance.now()); });
  addEventListener("mouseup", () => { mouseBoost = false; steerNow(performance.now()); });
  const touches = new Map();
  const onTouch = () => { touchBoost = touches.size >= 2; const t = touches.values().next().value; if (t) { mx = t.clientX; my = t.clientY; usingKeys = false; } steerNow(performance.now()); };
  cv.addEventListener("touchstart", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  cv.addEventListener("touchmove", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  const endT = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); onTouch(); };
  cv.addEventListener("touchend", endT); cv.addEventListener("touchcancel", endT);
  /* ---------------- chat (small, bottom-left; on the start page too) ----------------
     The 💬 Chat button turns it on/off (greyed out when off; remembered). Next to it, while on,
     the small green ➤: it opens a box to type in (so does Enter in game), and sends. */
  const chatEl = $("chat"), chatLog = $("chatLog"), chatIn = $("chatIn"), chatTog = $("chatTog");
  let chatHidden = store.get("serpent.chat") === "off", chatSentAt = -1e9, chatWait = 0, chatLast = "";
  const showChatState = () => {
    chatEl.classList.toggle("hidden", chatHidden); chatTog.classList.toggle("off", chatHidden);
    chatTog.title = chatHidden ? "Chat is off: click to turn it on" : "Chat is on: click to turn it off";
    document.body.classList.toggle("chatOn", !chatHidden);
  };
  showChatState();
  for (const el of [chatTog, $("chatSend")]) el.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the typing focus
  chatTog.onclick = () => { chatHidden = !chatHidden; store.set("serpent.chat", chatHidden ? "off" : "on"); if (chatHidden) closeChat(); showChatState(); };
  function addChat(name, text, sys) {
    const el = document.createElement("div");
    if (sys) el.className = "sys";
    else { const b = document.createElement("b"); b.textContent = name + ": "; el.append(b); } // text only: nothing in a message is read as HTML
    el.append(document.createTextNode(text));
    const atEnd = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatLog.append(el);
    while (chatLog.children.length > 100) chatLog.firstChild.remove(); // the start page shows them all (scrollable), the game the last 6
    if (atEnd) chatLog.scrollTop = chatLog.scrollHeight;             // follow new lines unless scrolled back to read
    setTimeout(() => el.classList.add("old"), 10000);                 // then they fade in game (still shown while typing)
  }
  function openChat() { if (chatHidden) return; chatEl.classList.add("open"); chatIn.focus(); }
  function closeChat() { chatEl.classList.remove("open"); chatIn.value = ""; chatIn.blur(); }
  function sendChat(t) {
    const now = performance.now();
    if (now - chatSentAt < 1250) { addChat("", "One message per second, please.", true); return; } // the server drops faster ones
    if (!connected || ws.readyState !== 1) { addChat("", "Not connected to the server.", true); return; }
    chatSentAt = now; chatLast = t;
    // text, then the typed name (the server uses it only before you join)
    const enc = new TextEncoder(), tb = enc.encode(t).slice(0, 480), nb = enc.encode(nameEl.value.trim()).slice(0, 48);
    const m = new Uint8Array(4 + tb.length + nb.length); m[0] = 7; m[1] = tb.length & 255; m[2] = tb.length >> 8; m.set(tb, 3); m[3 + tb.length] = nb.length; m.set(nb, 4 + tb.length);
    sendRaw(m);
    // the server sends every line back to its writer too: no echo means it doesn't know chat (an older server)
    clearTimeout(chatWait);
    chatWait = setTimeout(() => addChat("", "The server didn't answer: it may need updating to the version with chat.", true), 3000);
  }
  const submitChat = () => { const t = chatIn.value.trim(); if (t) sendChat(t); closeChat(); };
  $("chatSend").onclick = () => { if (chatIn.value.trim()) submitChat(); else openChat(); }; // ➤: write, then send
  chatIn.addEventListener("focus", () => chatEl.classList.add("open"));
  chatIn.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing never steers or boosts
    if (e.key === "Enter") submitChat();
    else if (e.key === "Escape") closeChat();
  });
  chatIn.addEventListener("keyup", (e) => e.stopPropagation());
  chatIn.addEventListener("blur", () => chatEl.classList.remove("open"));

  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "Enter" && state === "play") { e.preventDefault(); openChat(); return; }
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") { keyBoost = true; e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "a" || k === "ArrowRight" || k === "d") {
      keysDown.add(k === "ArrowLeft" || k === "a" ? "L" : "R"); keyTurn = (keysDown.has("R") ? 1 : 0) - (keysDown.has("L") ? 1 : 0);
      if (!usingKeys) { usingKeys = true; keyAnchorX = mx; keyAnchorY = my; }
    }
    else if (k === "p" || k === "P") $("perf").classList.toggle("off");
    else if (k === "Enter" && state !== "play") start();
    else if (k === "Escape" && state !== "menu") toMenu();
    steerNow(performance.now()); // a key turn or boost goes out at once
  });
  addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") keyBoost = false;
    else if (k === "ArrowLeft" || k === "a" || k === "ArrowRight" || k === "d") {
      keysDown.delete(k === "ArrowLeft" || k === "a" ? "L" : "R"); keyTurn = (keysDown.has("R") ? 1 : 0) - (keysDown.has("L") ? 1 : 0);
    }
    steerNow(performance.now()); // a key turn or boost goes out at once
  });
  addEventListener("blur", () => { keyBoost = mouseBoost = false; keyTurn = 0; keysDown.clear(); });

  /* ---------------- labels (as offline: one atlas slot per snake) ---------------- */
  const TIERS = ["ROOKIE", "CASUAL", "HUNTER", "ELITE", "LEGEND"];
  const TIER_COL = ["#6ee7b7", "#7dd3fc", "#fcd34d", "#fda4af", "#fbbf24"];
  const slotKey = new Array(NS).fill("");
  const slotCanvas = document.createElement("canvas");
  slotCanvas.width = SLOT_W * LS; slotCanvas.height = SLOT_H * LS;
  const sc = slotCanvas.getContext("2d");
  const FONT = 'Outfit, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  function drawSlot(s, key) {
    slotKey[s] = key;
    sc.setTransform(LS, 0, 0, LS, 0, 0); sc.clearRect(0, 0, SLOT_W, SLOT_H);
    sc.textAlign = "center"; sc.textBaseline = "alphabetic";
    sc.shadowColor = "rgba(0,0,0,.6)"; sc.shadowBlur = 2.5; sc.shadowOffsetY = 0.5;
    sc.font = `600 12px ${FONT}`; sc.fillStyle = "rgba(255,255,255,.92)";
    if (human[s]) {
      sc.fillText(s === me ? playerName() : nameOf(s), SLOT_W / 2, SLOT_H - 6);
    } else {
      const t = tier[s];
      sc.fillText(nameOf(s), SLOT_W / 2, SLOT_H - 17);
      sc.font = `600 9.5px ${FONT}`; sc.fillStyle = TIER_COL[t]; sc.letterSpacing = "0.6px";
      sc.fillText(`LV ${t + 1} · ${TIERS[t]}`, SLOT_W / 2, SLOT_H - 6); sc.letterSpacing = "0px";
    }
    R.labelSlot(slotCanvas, (s % CELLS_X) * SLOT_W * LS, Math.floor(s / CELLS_X) * SLOT_H * LS);
  }
  document.fonts?.ready.then(() => slotKey.fill(""));

  /* ---------------- HUD ---------------- */
  const lbEl = $("lb");
  // leaderboard text size: − / + in its title; remembered (phones start smaller).
  // On phones and touch screens the level shows as one coloured letter until the board is made full size.
  const boardEl = $("board"), smallScreen = matchMedia("(max-width: 640px), (hover: none)");
  let lbScale = parseFloat(store.get("serpent.lbscale"));
  if (!(lbScale >= 0.6 && lbScale <= 1.5)) lbScale = matchMedia("(max-width: 640px)").matches ? 0.8 : 1;
  const setLbScale = (v, save) => {
    lbScale = Math.round(Math.max(0.6, Math.min(1.5, v)) * 100) / 100;
    boardEl.style.setProperty("--lbs", lbScale);
    boardEl.classList.toggle("short", smallScreen.matches && lbScale < 1);
    if (save) store.set("serpent.lbscale", lbScale);
  };
  setLbScale(lbScale);
  smallScreen.addEventListener("change", () => setLbScale(lbScale));
  for (const bt of document.querySelectorAll(".lbsz button[data-d]")) {
    bt.addEventListener("pointerdown", (e) => e.stopPropagation());
    bt.onclick = (e) => { setLbScale(lbScale + 0.1 * +bt.dataset.d, true); e.currentTarget.blur(); };
  }
  // Resize in any direction: the left edge sets the width, the bottom edge the height (rows
  // past it are cut off), the bottom-left corner both. The board is pinned top-right, so
  // dragging left/down grows it. × folds it to its title bar (▾ opens it). All remembered.
  const lbOl = $("lb"), lbX = $("lbX");
  let lbW = parseFloat(store.get("serpent.lbw")) || 0, lbH = parseFloat(store.get("serpent.lbh")) || 0; // 0: fit the content
  const applyLbSize = () => {
    boardEl.style.width = lbW ? lbW + "px" : ""; lbOl.style.maxHeight = lbH ? lbH + "px" : "";
    boardEl.classList.toggle("sized", !!(lbW || lbH));
  };
  const setLbClosed = (c) => { boardEl.classList.toggle("closed", c); document.body.classList.toggle("lbOpen", !c); lbX.textContent = c ? "▾" : "×"; lbX.title = c ? "Show the leaderboard" : "Hide the leaderboard"; };
  applyLbSize(); setLbClosed(store.get("serpent.lbclosed") === "1");
  lbX.addEventListener("pointerdown", (e) => e.stopPropagation());
  lbX.onclick = (e) => { const c = !boardEl.classList.contains("closed"); setLbClosed(c); store.set("serpent.lbclosed", c ? "1" : "0"); e.currentTarget.blur(); };
  for (const h of boardEl.querySelectorAll("[data-rs]")) h.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation(); h.setPointerCapture(e.pointerId);
    const dir = h.dataset.rs, x0 = e.clientX, y0 = e.clientY, w0 = boardEl.offsetWidth, h0 = lbOl.offsetHeight;
    const move = (m) => { // screen pixels → the board's own (it may be scaled)
      if (dir.includes("w")) lbW = Math.round(Math.max(150, Math.min(640, w0 + (x0 - m.clientX) / lbScale)));
      if (dir.includes("s")) lbH = Math.round(Math.max(20, Math.min(lbOl.scrollHeight, h0 + (m.clientY - y0) / lbScale)));
      applyLbSize();
    };
    const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); store.set("serpent.lbw", lbW); store.set("serpent.lbh", lbH); };
    h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  });
  // a double click on any edge goes back to fitting the content
  for (const h of boardEl.querySelectorAll("[data-rs]")) h.addEventListener("dblclick", () => { lbW = lbH = 0; applyLbSize(); store.set("serpent.lbw", 0); store.set("serpent.lbh", 0); });
  let lastLb = "";
  function updateHud() {
    let html = "";
    board.top.forEach(([s, t, sk, hu, m], i) => {
      const tag = s === me ? `<span class="tg you" data-l="YOU" data-s="Y"></span>` : hu ? `<span class="tg pl" data-l="PLAYER" data-s="P"></span>` : `<span class="tg t${t}" title="${TIERS[t]}" data-l="${TIERS[t]}" data-s="${TIERS[t][0]}"></span>`;
      html += `<li class="${s === me ? "me" : ""}"><span class="n">${i + 1}</span><span class="dot" style="background:${SKINS[sk & 127][0]}"></span><span class="nm">${esc(s === me ? playerName() : hu ? pnames[s] || "Player" : botName(s))}</span>${tag}<span class="sc">${Math.floor(m * 10)}</span></li>`;
    });
    if (html !== lastLb) { lbEl.innerHTML = html; lastLb = html; }
    for (let s = 0; s < NS; s++) {
      if (!alive[s]) continue;
      const key = human[s] ? "p:" + (s === me ? playerName() : pnames[s]) : "t" + tier[s];
      if (key !== slotKey[s]) drawSlot(s, key);
    }
    if (connected && state === "menu") {
      let players = 0; for (const e of miniList) players += human[e[0]] || pnames[e[0]] ? 1 : 0;
      setStatus(`Online · ${players} player${players === 1 ? "" : "s"} playing`, "ok");
    }
    if (state !== "play" || me < 0) return;
    $("len").textContent = Math.floor(mass[me] * 10);
    run.peak = Math.max(run.peak, Math.floor(mass[me] * 10)); run.rankNow = board.rank; run.total = board.alive;
    if (board.rank > 0) run.rankBest = run.rankBest ? Math.min(run.rankBest, board.rank) : board.rank;
    $("rank").textContent = board.rank || "–";
    $("total").textContent = board.alive;
    $("kills").textContent = kills[me];
  }

  /* ---------------- per-frame: interpolate, cull, fill the GPU block ---------------- */
  const hx = new Float32Array(NS), hy = new Float32Array(NS), ha = new Float32Array(NS), shown = new Uint8Array(NS);
  // Stall bridging: when the drawn moment runs past the newest snapshot (a lost packet held
  // the connection up), a snake carries on at its last speed and heading for up to EXTRA_MAX
  // steps instead of freezing. When the real positions arrive, the difference from where it
  // was drawn is blended away over ~0.1 s instead of jumping. (rx, ry: the unblended position.)
  const rx = new Float32Array(NS), ry = new Float32Array(NS), vx = new Float32Array(NS), vy = new Float32Array(NS);
  const offX = new Float32Array(NS), offY = new Float32Array(NS), wasEx = new Uint8Array(NS), seenR = new Uint8Array(NS);
  let interpRt = -1;
  function interp(rt, dt) {
    let dSteps = interpRt < 0 ? 0 : rt - interpRt; interpRt = rt;
    if (dSteps < 0 || dSteps > 30) { dSteps = 0; seenR.fill(0); wasEx.fill(0); } // the drawn clock was reset: start over
    const decay = Math.exp(-dt * 25);
    for (let s = 0; s < NS; s++) {
      const h = hist[s];
      shown[s] = alive[s] && h.length ? 1 : 0;
      if (!shown[s]) { seenR[s] = 0; offX[s] = offY[s] = 0; wasEx[s] = 0; continue; }
      const L = h[h.length - 1];
      let x, y, ex = 0;
      if (rt >= L.t) {
        x = L.x; y = L.y; ha[s] = L.a;
        const P = h.length > 1 ? h[0] : null; // the oldest kept: snakes far from players move every few steps, so the last two can be equal
        if (P && L.t > P.t) {
          const ux = (L.x - P.x) / (L.t - P.t), uy = (L.y - P.y) / (L.t - P.t);
          if (ux * ux + uy * uy < 100) { ex = Math.min(rt - L.t, EXTRA_MAX); x += ux * ex; y += uy * ex; } // not across a respawn jump
        }
      } else {
        let a = h[0], b = h[0];
        for (let i = 0; i < h.length - 1; i++) if (h[i + 1].t > rt) { a = h[i]; b = h[i + 1]; break; }
        const f = b.t > a.t ? Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t))) : 1;
        x = a.x + (b.x - a.x) * f; y = a.y + (b.y - a.y) * f;
        let da = b.a - a.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
        ha[s] = a.a + da * f;
      }
      if (seenR[s] && wasEx[s]) {
        // where it would be had nothing new arrived, against where it really is: blend the gap
        const gx = rx[s] + vx[s] * dSteps - x, gy = ry[s] + vy[s] * dSteps - y;
        if (gx * gx + gy * gy < 60 * 60) { offX[s] += gx; offY[s] += gy; }
      }
      offX[s] *= decay; offY[s] *= decay;
      if (seenR[s] && dSteps > 0) { vx[s] = (x - rx[s]) / dSteps; vy[s] = (y - ry[s]) / dSteps; }
      rx[s] = x; ry[s] = y; seenR[s] = 1; wasEx[s] = ex > 0 ? 1 : 0;
      hx[s] = x + offX[s]; hy[s] = y + offY[s];
    }
  }
  const TXY = (s, j) => { const i = (s * RING + ((pcOf[s] - 1 - j) >>> 0 & RMASK)) * 2; return [trail[i] * 0.5, trail[i + 1] * 0.5]; };
  function renderPrep(cx, cy, hw, hh, px) { // port of the offline renderPrep (sim.c)
    let nvis = 0, maxK = 0;
    for (let o = 0; o <= NS; o++) {
      const s = o === NS ? me : o === me ? -1 : o;   // the player is drawn last (on top)
      if (s < 0 || !shown[s]) continue;
      const x = hx[s], y = hy[s], r = radius(mass[s]), sp = r * 0.42, n = segN[s];
      const legend = !human[s] && tier[s] === 4;
      const W = boost[s] ? 1.9 : legend ? 1.5 : 1.08, m = r * W * 2 + 20;
      const x0 = cx - hw - m, x1 = cx + hw + m, y0 = cy - hh - m, y1 = cy + hh + m;
      let any = x > x0 && x < x1 && y > y0 && y < y1;
      const reach = n * sp;
      if (!any && (x < x0 - reach || x > x1 + reach || y < y0 - reach || y > y1 + reach)) continue;
      for (let i = 0; i < n && !any; i += 16) { const [tx, ty] = TXY(s, i), g = sp * 15; any = tx > x0 - g && tx < x1 + g && ty > y0 - g && ty < y1 + g; } // every 16th point, margin 15 spacings
      if (!any) continue;
      // the interpolated head is behind the newest points: attach to the newest one it is ahead of
      const ca = Math.cos(ha[s]), sa = Math.sin(ha[s]);
      let j0 = 0;
      for (; j0 < 40; j0++) { const [tx, ty] = TXY(s, j0); if ((x - tx) * ca + (y - ty) * sa >= 0) break; }
      const [tx, ty] = TXY(s, j0), dx = x - tx, dy = y - ty;
      const spx = sp / px, stride = spx < 1.2 ? 4 : spx < 2.5 ? 2 : 1, nn = n;
      const K = Math.floor((nn - 1 + stride - 1) / stride);
      if (K > maxK) maxK = K;
      const b = nvis++ * 12;
      hdrF[b] = x; hdrF[b + 1] = y; hdrF[b + 2] = 1 - Math.min(Math.hypot(dx, dy) / sp, 1); hdrF[b + 3] = r;
      hdrF[b + 4] = sp; hdrF[b + 5] = stride; hdrF[b + 6] = ha[s]; hdrF[b + 7] = W;
      hdrU[b + 8] = s; hdrU[b + 9] = (pcOf[s] - 1 - j0) >>> 0 & RMASK; hdrU[b + 10] = nn;
      hdrU[b + 11] = skin[s] | ((boost[s] | (s === me ? 2 : 0) | (legend ? 4 : 0)) << 8);
    }
    frameOut[1] = nvis; frameOut[2] = maxK;
  }
  function miniPrep(camX, camY, hw, hh) {
    let n = 0;
    const put = (x, y, size, info) => { miniF[n * 4] = x; miniF[n * 4 + 1] = y; miniF[n * 4 + 2] = size; miniU[n * 4 + 3] = info; n++; };
    put(0, 0, 1, 0);
    for (const [s, sk, x, y, m] of miniList) {
      if (s === me || n >= NS + 2) continue;
      const near = shown[s];
      put((near ? hx[s] : x) / WR, (near ? hy[s] : y) / WR, (2 + Math.sqrt(m) * 0.16) / 166, 1 | (sk << 8) | ((near ? 235 : 120) << 16));
    }
    put(camX / WR, camY / WR, hw / WR, (3 | (Math.floor(Math.min(hh / WR, 1) * 16777215) << 8)) >>> 0);
    if (me >= 0 && shown[me]) put(hx[me] / WR, hy[me] / WR, 10 / 166, 2);
    frameOut[4] = n;
  }

  /* ---------------- main loop ---------------- */
  const perfEl = $("perf");
  let camX = 0, camY = 0, camH = 900, frameNo = 0, last = performance.now(), hudT = 0, perfT = 0, fpsN = 0, prepMs = 0, drawMs = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const playing = state === "play";
    if (!playing && now - last < 30) return; // menu / game over: ~30 fps is plenty
    const dt = Math.min((now - last) / 1000, 0.25); last = now;
    if (playing) {
      // Keys steer relative to where your snake is heading NOW (the prediction): aim a little to
      // that side (it turns at its own top speed) or straight ahead. An aim that ran on by
      // itself could get more than half a turn ahead of a slow-turning big snake, which then
      // turned the other way.
      steerNow(now);
    }
    const t0 = performance.now();
    if (estTick >= 0) estTick += dt * 60;
    let rt = estTick - INTERP;
    if (arrOff.length >= 10) { // the adaptive delay (see noteArrival); the drawn clock warps by at most 10%, never jumps
      interpT += Math.max(-dt * 2, Math.min(dt * 6, interpGoal - interpT)); // shrink in a couple of seconds, grow fast
      const target = (now - arrLo) * 0.06 - interpT;
      if (rtS < 0 || Math.abs(target - rtS) > 20) rtS = target;
      else rtS += dt * 60 * (1 + Math.max(-0.1, Math.min(0.1, (target - rtS) * 0.3)));
      rt = rtS;
      if (rtts.length >= 3 && Math.abs(interpT - interpSent) > 0.5) sendDelay();
    }
    const mine = PREDICT && playing && me >= 0 && alive[me] && hist[me].length;
    if (!mine) pred.on = false;
    else {
      if (!pred.on) { // start where the server's snake is NOW: its last head is from a round trip ago
        const l = hist[me][hist[me].length - 1], ahead = 195 * Math.min(rttMs, 500) / 1000;
        predStart(l.x + Math.cos(l.a) * ahead, l.y + Math.sin(l.a) * ahead, l.a);
      }
      predStep(now, dt);
    }
    lastRt = rt; interp(rt, dt);
    if (pred.on) { const [px, py] = predShown(); hx[me] = px; hy[me] = py; ha[me] = pred.a; shown[me] = 1; layTrail(me, pred.x, pred.y); }
    // camera, exactly like offline
    let tx = camX, ty = camY, tH = camH;
    if (playing && me >= 0 && shown[me]) { tx = hx[me]; ty = hy[me]; tH = 560 + (radius(mass[me]) - 12) * 18; }
    else if (state === "dead") tH = camH * (1 + 0.12 * dt);
    else if (shown[spectate]) { tx = hx[spectate]; ty = hy[spectate]; tH = 900; }
    const kp = 1 - Math.exp(-dt * (playing ? 14 : 2.5)), kz = 1 - Math.exp(-dt * 2);
    if (Math.hypot(tx - camX, ty - camY) > 3000) { camX = tx; camY = ty; } // first frame / respawn: jump
    camX += (tx - camX) * kp; camY += (ty - camY) * kp; camH += (tH - camH) * kz;
    const hh = camH, hw = camH * vw / vh, px = hh * 2 / vh;
    const poseUndo = grabPending && deathPose ? poseAt(deathPose) : null; // the moment of death (one frame)
    if (playing && me >= 0 && shown[me]) { // a contact starting on this screen: copy this frame for the sheet
      const hit = localHit();
      if (hit && !touching && (!localShot || now - localShot.t > 300)) touchShot = true;
      touching = hit;
    }
    renderPrep(camX, camY, hw, hh, px);
    miniPrep(camX, camY, hw, hh);
    frameOut[0] = foodHigh; frameOut[3] = ntup;
    frameBlk[0] = camX; frameBlk[1] = camY; frameBlk[2] = hw; frameBlk[3] = hh;
    frameBlk[4] = px; frameBlk[5] = (now / 1000) % 3600; frameBlk[6] = vw / innerWidth; frameBlk[7] = ((rt / 4) % 65536 + 65536) % 65536; // food clock in quarter-steps, smooth (fractions)
    frameBlk[8] = vw; frameBlk[9] = vh; frameBlk[10] = WR; frameBlk[11] = 0;
    const t1 = performance.now();
    if (!gpuDown) { try { R.draw(frameNo++, playing, !perfEl.classList.contains("off")); } catch (e) { if (R.device && touchDevice) restartGPU(); else throw e; } }
    if (grabPending && !gpuDown) { grabPending = false; grabDeathShot(cv); } // copied right after drawing, while the canvas holds it
    if (touchShot) { touchShot = false; if (!gpuDown) { const img = copyCanvas(cv); if (img) localShot = { img, t: performance.now() }; } }
    if (poseUndo) { for (const [s, pc] of poseUndo) pcOf[s] = pc; deathPose = null; }
    ntup = 0;
    const t2 = performance.now();
    prepMs += t1 - t0; drawMs += t2 - t1; fpsN++;
    if ((hudT += dt) > 0.25) { hudT = 0; updateHud(); }
    if ((perfT += dt) > 0.5) {
      if (!perfEl.classList.contains("off")) {
        const gpu = R.gpuMs >= 0 ? `<b>${R.gpuMs.toFixed(2)} ms</b>` + (R.passMs ? " (" + R.passMs.map((v, i) => `${R.passNames[i]} ${v.toFixed(2)}`).join(" · ") + ")" : "") : R.canTime ? "…" : "n/a";
        const age = lastSnapAt ? Math.round(now - lastSnapAt) : -1;
        perfEl.innerHTML = `<b>${Math.round(fpsN / perfT)}</b> fps · <b>${R.name}</b> · online · CPU/frame: prep <b>${(prepMs / fpsN).toFixed(2)}</b> · draw <b>${(drawMs / fpsN).toFixed(2)}</b> ms` +
          `<br>GPU ${gpu}<br>${foodHigh} food slots · ${frameOut[1]} snakes drawn · ping <b>${Math.round(rttMs)} ms</b> · smoothing <b>${Math.round(interpT * 1000 / 60)} ms</b> · download <b>${(bytesIn / perfT / 1024).toFixed(1)} KB/s</b> · last update ${age} ms ago`;
      }
      perfT = 0; fpsN = 0; prepMs = drawMs = 0; bytesIn = 0;
    }
  }
  resize();
  connect();
  window.__serpent = { renderer: () => R.name, get device() { return R.device; }, state: () => ({ connected, me, state, foodHigh, alive: [...alive].reduce((a, b) => a + b, 0) }),
                      dbg: () => ({ me, hx, hy, ha, shown, trail, pcOf, segN, mass, RING, interpT, estTick, newest: Math.max(...hist.map((h) => h.length ? h[h.length - 1].t : 0)), rt: lastRt }), // drawn state, for tests
                      head: () => (me >= 0 ? { x: hx[me], y: hy[me], a: ha[me], pred: pred.on, err: pred.err } : null) };
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
