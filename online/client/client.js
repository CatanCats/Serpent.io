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
const BOT_NAMES = ["Noodle", "Slinky", "Viper", "Kaa", "Mamba", "Wiggles", "Nagini", "Zigzag", "Sir Hiss", "Boop", "Cobra Kai",
  "Pythonista", "Rattler", "Sidewinder", "Jormungandr", "Ouroboros", "Danger Noodle", "Spaghetti", "Slithers", "Taipan",
  "Adder", "Asp", "Basilisk", "Garter", "Krait", "Anaconda", "Boa", "Copperhead", "Hognose", "Kingsnake", "Milk Snake",
  "Racer", "Whip", "Coral", "Sssam", "Hisssy", "Zero Cool", "Lil Fang", "Mr. Scales", "Big Tony", "Worm", "Longboi", "Snek", "Nope Rope", "Sneaky", "Wriggle", "Laces"];

(async () => {
  const $ = (id) => document.getElementById(id);
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  /* ---------------- the memory block the renderers read ---------------- */
  const NS = 128, RING = 512, RMASK = RING - 1, MAXF = 8192, INTERP = 4; // INTERP: ticks behind the newest snapshot
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
  E.palette = new Float32Array(96);
  SKINS.forEach(([a, b], i) => [a, b].forEach((h, k) => [1, 3, 5].forEach((o, c) => { E.palette[(k * 12 + i) * 4 + c] = parseInt(h.substr(o, 2), 16) / 255; })));

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
  let R = null;
  if (want !== "webgl") {
    try { R = await createGPU(canvas, E); }
    catch (e) {
      console.warn("WebGPU failed:", e);
      // a browser with no WebGPU at all has nothing to fix: Auto goes straight to WebGL
      if (want !== "auto" || navigator.gpu) await gpuProblem("WebGPU isn't working", String(e && e.message || e));
      R = null;
      if (canvas.getContext("webgpu")) canvas.replaceWith(canvas.cloneNode()); // a failed WebGPU attempt holds the canvas
    }
    if (R) {
      R.device.lost.then((info) => { if (info.reason !== "destroyed") gpuProblem("WebGPU stopped", `The graphics device was lost: ${info.message || "no reason given"}`).then(toWebGL); });
      let shown = false; // a WebGPU error while playing: show the first one (the rest are usually the same)
      R.device.addEventListener("uncapturederror", (ev) => { if (!shown) { shown = true; gpuProblem("WebGPU error", ev.error.message).then(toWebGL); } });
    }
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
  const botName = (s) => BOT_NAMES[(s * 7 + 3) % BOT_NAMES.length] + (s >= BOT_NAMES.length ? " II" : "");
  const nameOf = (s) => (human[s] || pnames[s] ? pnames[s] || "Player" : botName(s));
  const radius = (m) => Math.min(10 + Math.sqrt(m) * 0.45, 40);
  const segsFor = (m) => Math.min(14 + Math.floor(3.6 * Math.sqrt(m)), RING - 1);
  const angOf = new Float32Array(NS);
  const fixq = (v) => { v *= 4; return Math.max(-32767, Math.min(32767, Math.trunc(v + (v >= 0 ? 0.5 : -0.5)))); }; // as sim.c fix()
  function uploadRun(s, a0, cnt) { const first = Math.min(cnt, RING - a0); upload(s, a0, first); if (first < cnt) upload(s, 0, cnt - first); }
  // Lay body points toward the new head, one every `spacing`, exactly the way the
  // simulation builds its trail: the server sends only the head, never the points.
  function layTrail(s, x, y) {
    const sp = radius(mass[s]) * 0.42; let pc = pcOf[s], cnt = 0;
    for (; cnt < 8; cnt++) {
      const j = (s * RING + ((pc - 1) & RMASK)) * 2, lx = trail[j] * 0.25, ly = trail[j + 1] * 0.25, dx = x - lx, dy = y - ly, d2 = dx * dx + dy * dy;
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
  const pred = { on: false, x: 0, y: 0, a: 0, hist: [] }; // hist: {t, x, y}, newest last
  const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function predStart(x, y, a) { pred.on = true; pred.x = x; pred.y = y; pred.a = a; pred.hist.length = 0; }
  function predStep(now, dt) {
    const turn = 5.2 / (1 + (radius(mass[me]) - 12) * 0.045) * dt; // as moveSnake in the simulation
    const da = Math.max(-turn, Math.min(turn, wrapA(sentAim - pred.a)));
    pred.a = wrapA(pred.a + da);
    const v = (lastBoostSent > 0 && mass[me] > 14 ? 430 : 195) * dt;
    pred.x += Math.cos(pred.a) * v; pred.y += Math.sin(pred.a) * v;
    pred.hist.push({ t: now, x: pred.x, y: pred.y }); if (pred.hist.length > 240) pred.hist.shift();
  }
  function predCorrect(seq, steps, sx, sy) { // server head (sx, sy), `steps` steps after it received input `seq`
    const h = pred.hist, t = sentAt[seq] + steps * (1000 / 60);
    if (!pred.on || h.length < 2 || t < h[0].t || t > h[h.length - 1].t) return;
    let i = h.length - 2; while (i > 0 && h[i].t > t) i--;
    const f = (t - h[i].t) / Math.max(1e-6, h[i + 1].t - h[i].t);
    const ex = sx - (h[i].x + (h[i + 1].x - h[i].x) * f), ey = sy - (h[i].y + (h[i + 1].y - h[i].y) * f);
    if (ex * ex + ey * ey > 150 * 150) { predStart(sx, sy, pred.a); return; } // far off (lag spike): start again from the server
    pred.err = Math.hypot(ex, ey);
    const kx = ex * 0.3, ky = ey * 0.3; // a third per snapshot: smooth, settles in ~0.2 s
    pred.x += kx; pred.y += ky; for (const e of h) { e.x += kx; e.y += ky; }
  }
  // food: server slot -> local slot (local slots stay dense so the GPU draws few)
  const toLocal = new Int32Array(32768).fill(-1), freeL = []; let foodHigh = 0;
  const miniList = []; // from the 4 Hz MINI message: [slot, skin, x, y, mass]
  let board = { alive: 0, rank: 0, top: [] };
  let estTick = -1, lastSnapAt = 0, bytesIn = 0;

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
        x = d.getInt16(o + 2, true) * 0.25; y = d.getInt16(o + 4, true) * 0.25; mass[s] = d.getUint16(o + 6, true) / 4;
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
        if (x !== trail[j] * 0.25 || y !== trail[j + 1] * 0.25) angOf[s] = Math.atan2(y - trail[j + 1] * 0.25, x - trail[j] * 0.25);
      } else { // only the head (and the size when it changed)
        const h = hist[s], last = h[h.length - 1];
        if (fl & 8) { x = d.getInt16(o, true) * 0.25; y = d.getInt16(o + 2, true) * 0.25; o += 4; }
        else { x = (last ? last.x : 0) + d.getInt8(o) * 0.25; y = (last ? last.y : 0) + d.getInt8(o + 1) * 0.25; o += 2; }
        if (fl & 16) { mass[s] = d.getUint16(o, true) / 4; o += 2; }
        if (last && (x !== last.x || y !== last.y)) angOf[s] = Math.atan2(y - last.y, x - last.x);
        if (s === me && pred.on) predCorrect(ackSeq, ackSteps, x, y); // your body follows the prediction instead
        else layTrail(s, x, y);
      }
      segN[s] = segsFor(mass[s]); alive[s] = 1; seen[s] = 1;
      const h = hist[s]; h.push({ t: tick, x, y, a: angOf[s] }); if (h.length > 8) h.shift();
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
    ws.onopen = () => { connected = true; retry = 0; $("play").disabled = false; sendView(); if (state !== "menu") join(); };
    ws.onmessage = (e) => { bytesIn += e.data.byteLength; onMessage(new DataView(e.data)); };
    ws.onclose = () => {
      connected = false; $("play").disabled = true; clearWorld(); me = -1;
      if (state === "play") { state = "dead"; showOver("Lost connection to the server"); }
      setStatus("Can't reach the server — retrying… (or play offline)", "bad");
      setTimeout(connect, Math.min(10000, 1500 * ++retry));
    };
  }
  const sendRaw = (bytes) => { if (connected && ws.readyState === 1) ws.send(bytes); };
  function sendView() { const b = new Uint8Array(3); b[0] = 3; new DataView(b.buffer).setUint16(1, Math.round((vw / Math.max(1, vh)) * 1000), true); sendRaw(b); }
  function join() {
    const nm = new TextEncoder().encode(playerName()).slice(0, 48);
    const b = new Uint8Array(5 + nm.length), dv = new DataView(b.buffer);
    b[0] = 1; b[1] = skinSel; dv.setUint16(2, Math.round((vw / Math.max(1, vh)) * 1000), true); b[4] = nm.length; b.set(nm, 5);
    sendRaw(b);
  }
  let lastAimSent = 9, lastBoostSent = -1, lastInputAt = 0, sentAim = 0, inSeq = 0;
  const sentAt = new Float64Array(256); // when each input (by its 8-bit number) was sent
  function sendInput(now, aim, b) {
    if (Math.abs(aim - lastAimSent) < 0.004 && b === lastBoostSent && now - lastInputAt < 250) return;
    if (now - lastInputAt < 15 && b === lastBoostSent) return; // at most ~60/s
    const u = new Uint8Array(5), dv = new DataView(u.buffer);
    let a = aim; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI;
    const q = Math.round(((a + Math.PI) / (2 * Math.PI)) * 65535);
    inSeq = (inSeq + 1) & 255; sentAt[inSeq] = now;
    u[0] = 2; dv.setUint16(1, q, true); u[3] = b; u[4] = inSeq;
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
      case 5: onDeath(d.getUint8(1), d.getUint16(2, true), d.getFloat32(4, true)); break;
      case 6: {
        miniList.length = 0;
        for (let i = 0, k = d.getUint16(1, true), o = 3; i < k; i++, o += 4) { // slot, x, y (a byte each), skin | size<<4
          const b = d.getUint8(o + 3), sz = (b >> 4) * 4;
          miniList.push([d.getUint8(o), (b & 15) % 12, (d.getUint8(o + 1) / 255 * 2 - 1) * WR, (d.getUint8(o + 2) / 255 * 2 - 1) * WR, sz * sz]);
        }
        break;
      }
      case 7: setStatus("The server is full right now — try again soon, or play offline", "bad"); state = "menu"; showMenu(); break;
    }
  }

  /* ---------------- UI ---------------- */
  let skinSel = +(store.get("serpent.skin") ?? 0) % 12;
  const skinsEl = $("skins");
  SKINS.forEach(([a, b], i) => {
    const el = document.createElement("button");
    el.className = "skin"; el.title = `Skin ${i + 1}`;
    el.style.background = `repeating-linear-gradient(135deg, ${a} 0 7px, ${b} 7px 14px)`;
    el.setAttribute("aria-pressed", i === skinSel);
    el.onclick = () => { skinSel = i; store.set("serpent.skin", i); [...skinsEl.children].forEach((c, j) => c.setAttribute("aria-pressed", j === i)); };
    skinsEl.appendChild(el);
  });
  const nameEl = $("name"); nameEl.value = store.get("serpent.name") ?? "";
  let best = +(store.get("serpent.best.online") ?? 0);
  const playerName = () => nameEl.value.trim() || "You";
  let state = "menu"; // menu | play | dead

  function start() {
    if (!connected) return;
    store.set("serpent.name", nameEl.value.trim());
    join();
    state = "play"; document.body.classList.add("playing");
    $("menu").classList.add("hidden"); $("over").classList.add("hidden");
    nameEl.blur();
  }
  function showMenu() { document.body.classList.remove("playing"); $("over").classList.add("hidden"); $("menu").classList.remove("hidden"); }
  function toMenu() { if (state !== "menu") sendRaw(new Uint8Array([4])); state = "menu"; showMenu(); }
  function showOver(by) {
    $("by").innerHTML = by;
    setTimeout(() => { if (state === "dead") { $("over").classList.remove("hidden"); document.body.classList.remove("playing"); } }, 900);
  }
  const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  function onDeath(killer, k, m) {
    if (state !== "play") return;
    state = "dead";
    const len = Math.floor(m * 10), isBest = len > best;
    if (isBest) { best = len; store.set("serpent.best.online", best); }
    $("oLen").textContent = len; $("oKills").textContent = k; $("oBest").textContent = best; $("oBest").classList.toggle("new", isBest);
    showOver(killer !== 255 ? `Crashed into <b>${esc(nameOf(killer))}</b>` : "You hit the edge of the world");
  }
  $("play").onclick = start; $("again").onclick = start;
  $("play").disabled = true;
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); e.stopPropagation(); });

  /* ---------------- input (as offline) ---------------- */
  let aim = 0, mouseBoost = false, keyBoost = false, touchBoost = false, keyTurn = 0, usingKeys = false;
  let mx = innerWidth / 2 + 100, my = innerHeight / 2;
  cv.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mx = e.clientX; my = e.clientY; usingKeys = false; } });
  cv.addEventListener("mousedown", () => { mouseBoost = true; });
  addEventListener("mouseup", () => { mouseBoost = false; });
  const touches = new Map();
  const onTouch = () => { touchBoost = touches.size >= 2; const t = touches.values().next().value; if (t) { mx = t.clientX; my = t.clientY; usingKeys = false; } };
  cv.addEventListener("touchstart", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  cv.addEventListener("touchmove", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  const endT = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); onTouch(); };
  cv.addEventListener("touchend", endT); cv.addEventListener("touchcancel", endT);
  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") { keyBoost = true; e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "a") { keyTurn = -1; usingKeys = true; }
    else if (k === "ArrowRight" || k === "d") { keyTurn = 1; usingKeys = true; }
    else if (k === "p" || k === "P") $("perf").classList.toggle("off");
    else if (k === "Enter" && state !== "play") start();
    else if (k === "Escape" && state !== "menu") toMenu();
  });
  addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") keyBoost = false;
    else if ((k === "ArrowLeft" || k === "a") && keyTurn < 0) keyTurn = 0;
    else if ((k === "ArrowRight" || k === "d") && keyTurn > 0) keyTurn = 0;
  });
  addEventListener("blur", () => { keyBoost = mouseBoost = false; keyTurn = 0; });

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
  let lastLb = "";
  function updateHud() {
    let html = "";
    board.top.forEach(([s, t, sk, hu, m], i) => {
      const tag = s === me ? `<span class="tg you">YOU</span>` : hu ? `<span class="tg pl">PLAYER</span>` : `<span class="tg t${t}">${TIERS[t]}</span>`;
      html += `<li class="${s === me ? "me" : ""}"><span class="n">${i + 1}</span><span class="dot" style="background:${SKINS[sk % 12][0]}"></span><span class="nm">${esc(s === me ? playerName() : hu ? pnames[s] || "Player" : botName(s))}</span>${tag}<span class="sc">${Math.floor(m * 10)}</span></li>`;
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
    $("rank").textContent = board.rank || "–";
    $("total").textContent = board.alive;
    $("kills").textContent = kills[me];
  }

  /* ---------------- per-frame: interpolate, cull, fill the GPU block ---------------- */
  const hx = new Float32Array(NS), hy = new Float32Array(NS), ha = new Float32Array(NS), shown = new Uint8Array(NS);
  function interp(rt) {
    for (let s = 0; s < NS; s++) {
      const h = hist[s];
      shown[s] = alive[s] && h.length ? 1 : 0;
      if (!shown[s]) continue;
      let a = h[0], b = h[0];
      if (rt >= h[h.length - 1].t) a = b = h[h.length - 1];
      else for (let i = 0; i < h.length - 1; i++) if (h[i + 1].t > rt) { a = h[i]; b = h[i + 1]; break; }
      const f = b.t > a.t ? Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t))) : 1;
      hx[s] = a.x + (b.x - a.x) * f; hy[s] = a.y + (b.y - a.y) * f;
      let da = b.a - a.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      ha[s] = a.a + da * f;
    }
  }
  const TXY = (s, j) => { const i = (s * RING + ((pcOf[s] - 1 - j) >>> 0 & RMASK)) * 2; return [trail[i] * 0.25, trail[i + 1] * 0.25]; };
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
      if (usingKeys) aim += keyTurn * dt * 4.2; else aim = Math.atan2(my - innerHeight / 2, mx - innerWidth / 2);
      sendInput(now, aim, mouseBoost || keyBoost || touchBoost ? 1 : 0);
    }
    const t0 = performance.now();
    if (estTick >= 0) estTick += dt * 60;
    const rt = estTick - INTERP;
    const mine = PREDICT && playing && me >= 0 && alive[me] && hist[me].length;
    if (!mine) pred.on = false;
    else { if (!pred.on) { const l = hist[me][hist[me].length - 1]; predStart(l.x, l.y, l.a); } predStep(now, dt); }
    interp(rt);
    if (pred.on) { hx[me] = pred.x; hy[me] = pred.y; ha[me] = pred.a; shown[me] = 1; layTrail(me, pred.x, pred.y); }
    // camera, exactly like offline
    let tx = camX, ty = camY, tH = camH;
    if (playing && me >= 0 && shown[me]) { tx = hx[me]; ty = hy[me]; tH = 560 + (radius(mass[me]) - 12) * 18; }
    else if (state === "dead") tH = camH * (1 + 0.12 * dt);
    else if (shown[spectate]) { tx = hx[spectate]; ty = hy[spectate]; tH = 900; }
    const kp = 1 - Math.exp(-dt * (playing ? 14 : 2.5)), kz = 1 - Math.exp(-dt * 2);
    if (Math.hypot(tx - camX, ty - camY) > 3000) { camX = tx; camY = ty; } // first frame / respawn: jump
    camX += (tx - camX) * kp; camY += (ty - camY) * kp; camH += (tH - camH) * kz;
    const hh = camH, hw = camH * vw / vh, px = hh * 2 / vh;
    renderPrep(camX, camY, hw, hh, px);
    miniPrep(camX, camY, hw, hh);
    frameOut[0] = foodHigh; frameOut[3] = ntup;
    frameBlk[0] = camX; frameBlk[1] = camY; frameBlk[2] = hw; frameBlk[3] = hh;
    frameBlk[4] = px; frameBlk[5] = (now / 1000) % 3600; frameBlk[6] = vw / innerWidth; frameBlk[7] = ((rt / 4) % 65536 + 65536) % 65536; // food clock in quarter-steps, smooth (fractions)
    frameBlk[8] = vw; frameBlk[9] = vh; frameBlk[10] = WR; frameBlk[11] = 0;
    const t1 = performance.now();
    R.draw(frameNo++, playing, !perfEl.classList.contains("off"));
    ntup = 0;
    const t2 = performance.now();
    prepMs += t1 - t0; drawMs += t2 - t1; fpsN++;
    if ((hudT += dt) > 0.25) { hudT = 0; updateHud(); }
    if ((perfT += dt) > 0.5) {
      if (!perfEl.classList.contains("off")) {
        const gpu = R.gpuMs >= 0 ? `<b>${R.gpuMs.toFixed(2)} ms</b>` + (R.passMs ? " (" + R.passMs.map((v, i) => `${R.passNames[i]} ${v.toFixed(2)}`).join(" · ") + ")" : "") : R.canTime ? "…" : "n/a";
        const age = lastSnapAt ? Math.round(now - lastSnapAt) : -1;
        perfEl.innerHTML = `<b>${Math.round(fpsN / perfT)}</b> fps · <b>${R.name}</b> · online · CPU/frame: prep <b>${(prepMs / fpsN).toFixed(2)}</b> · draw <b>${(drawMs / fpsN).toFixed(2)}</b> ms` +
          `<br>GPU ${gpu}<br>${foodHigh} food slots · ${frameOut[1]} snakes drawn · download <b>${(bytesIn / perfT / 1024).toFixed(1)} KB/s</b> · last update ${age} ms ago`;
      }
      perfT = 0; fpsN = 0; prepMs = drawMs = 0; bytesIn = 0;
    }
  }
  resize();
  connect();
  window.__serpent = { renderer: () => R.name, state: () => ({ connected, me, state, foodHigh, alive: [...alive].reduce((a, b) => a + b, 0) }),
                      head: () => (me >= 0 ? { x: hx[me], y: hy[me], a: ha[me], pred: pred.on, err: pred.err } : null) };
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
