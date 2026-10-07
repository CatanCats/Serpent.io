"use strict";

/* Skin palette — must match the shader's table (index = skin id). */
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
  if (location.protocol === "file:") $("dl")?.remove(); // already a downloaded copy
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                  set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  /* ---------------- WebAssembly ---------------- */
  const bin = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bin, { env: { now: () => performance.now() } });
  const W = instance.exports;
  const BOTS = 60;
  W.init((Math.random() * 4294967295) >>> 0, BOTS);
  const WR = W.worldRadius();

  /* ---------------- Zero-copy views into WebAssembly memory ----------------
     Memory never grows (all static), so these stay valid forever. */
  const mem = W.memory.buffer, NS = W.snakeCount(), RING = W.ring();
  const SN = 8, snap = new Float32Array(mem, W.snapPtr(), NS * SN); // per snake: alive, x, y, mass, skin, tier, near, kills
  const lb = new Int32Array(mem, W.rankPrep(), 12);
  const frameBlk = new Float32Array(mem, W.frameBlkPtr(), 12); // std140 Frame block, written by WASM
  const frameOut = new Int32Array(mem, W.frameOutPtr(), 8);    // counts for this frame
  const frameMs = new Float32Array(mem, W.frameMsPtr(), 2);    // WASM-side timings
  // label atlas at the screen's own pixel density (not always 2x): smaller texture, same sharpness
  const SLOT_W = 150, SLOT_H = 34, LS = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), CELLS_X = 8, CELLS_Y = Math.ceil(NS / CELLS_X);
  const E = {
    mem, NS, RING, SLOT_W, SLOT_H, CELLS_X, CELLS_Y, AW: SLOT_W * LS * CELLS_X, AH: SLOT_H * LS * CELLS_Y,
    frameBlk, frameOut,
    trail: new Int16Array(mem, W.trailPtr(), NS * RING * 2),
    tup: new Uint32Array(mem, W.tupPtr(), NS * 6),          // trail uploads: (row, first index, count)...
    ptr: { trail: W.trailPtr() },
  };
  // The per-frame GPU block in WASM memory: offsets relative to its start (frame uniforms at 0)
  const base = W.frameBlkPtr();
  E.arena = { base, hdr: W.hdrPtr() - base, mini: W.miniPtr() - base,
              food: W.foodPtr() - base, size: W.foodPtr() - base + W.maxFood() * 8 };
  E.arenaBytes = new Uint8Array(mem, base, E.arena.size);
  // skin palette as 24 vec4s (12 main colours, then 12 stripe colours) for a uniform buffer
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
  // Pixel density cap: GPU cost is mostly pixels, so on integrated graphics a
  // lower cap is the biggest single saving (Sharp = up to 2x, Balanced 1.25x, Fast 1x).
  const QUAL = { sharp: 2, balanced: 1.25, fast: 1 };
  let quality = store.get("serpent.quality") || "sharp";
  $("tech").textContent = `WebAssembly sim · GPU-built snakes · 5 draws`;
  // Renderer switch (Auto = WebGPU if available). Applying it needs a fresh page.
  const rsEl = $("rsw");
  for (const b of rsEl.querySelectorAll("button")) {
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
  }
  addEventListener("resize", resize); resize();

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
  let best = +(store.get("serpent.best") ?? 0);
  const names = []; for (let i = 0; i < 64; i++) names.push(BOT_NAMES[(i * 7 + 3) % BOT_NAMES.length] + (i >= BOT_NAMES.length ? " II" : ""));
  const playerName = () => nameEl.value.trim() || "You";

  let state = "menu"; // menu | play | dead

  function start() {
    store.set("serpent.name", nameEl.value.trim());
    W.spawnPlayer(skinSel); // also moves the camera there and fills food around it
    state = "play"; document.body.classList.add("playing");
    $("menu").classList.add("hidden"); $("over").classList.add("hidden");
    nameEl.blur();
  }
  function toMenu() {
    if (state === "play") W.killPlayer();
    state = "menu"; document.body.classList.remove("playing");
    $("over").classList.add("hidden"); $("menu").classList.remove("hidden");
  }
  function onDeath() {
    state = "dead";
    const len = Math.floor(lastMass * 10), k = W.kills(0);
    const isBest = len > best; if (isBest) { best = len; store.set("serpent.best", best); }
    $("oLen").textContent = len; $("oKills").textContent = k; $("oBest").textContent = best;
    $("oBest").classList.toggle("new", isBest);
    const killer = W.killer();
    $("by").innerHTML = killer > 0 ? `Crashed into <b>${names[killer]}</b>` : "You hit the edge of the world";
    setTimeout(() => { if (state === "dead") { $("over").classList.remove("hidden"); document.body.classList.remove("playing"); } }, 900);
  }
  $("play").onclick = start; $("again").onclick = start;
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") start(); e.stopPropagation(); });

  /* ---------------- Input ---------------- */
  let aim = 0, mouseBoost = false, keyBoost = false, touchBoost = false, keyTurn = 0, usingKeys = false; const keysDown = new Set();
  let mx = innerWidth / 2 + 100, my = innerHeight / 2;
  // The mouse takes over again only when it really moves: browsers also send "moves" when
  // the page changes under a still cursor, which used to swing the snake toward it.
  let keyAnchorX = 0, keyAnchorY = 0;
  cv.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    mx = e.clientX; my = e.clientY;
    if (usingKeys && Math.hypot(mx - keyAnchorX, my - keyAnchorY) > 6) usingKeys = false;
  });
  cv.addEventListener("mousedown", () => { mouseBoost = true; });
  addEventListener("mouseup", () => { mouseBoost = false; });
  const touches = new Map();
  cv.addEventListener("touchstart", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  cv.addEventListener("touchmove", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); onTouch(); e.preventDefault(); }, { passive: false });
  const endT = (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); onTouch(); };
  cv.addEventListener("touchend", endT); cv.addEventListener("touchcancel", endT);
  function onTouch() {
    touchBoost = touches.size >= 2;
    const t = touches.values().next().value;
    if (t) { mx = t.clientX; my = t.clientY; usingKeys = false; }
  }
  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") { keyBoost = true; e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "a" || k === "ArrowRight" || k === "d") {
      keysDown.add(k === "ArrowLeft" || k === "a" ? "L" : "R"); keyTurn = (keysDown.has("R") ? 1 : 0) - (keysDown.has("L") ? 1 : 0);
      if (!usingKeys) { usingKeys = true; keyAnchorX = mx; keyAnchorY = my; }
    }
    else if (k === "p" || k === "P") $("perf").classList.toggle("off");
    else if (k === "Enter" && state !== "play") start();
    else if (k === "Escape" && state !== "menu") toMenu();
  });
  addEventListener("keyup", (e) => {
    const k = e.key;
    if (k === " " || k === "Shift" || k === "ArrowUp" || k === "w") keyBoost = false;
    else if (k === "ArrowLeft" || k === "a" || k === "ArrowRight" || k === "d") {
      keysDown.delete(k === "ArrowLeft" || k === "a" ? "L" : "R"); keyTurn = (keysDown.has("R") ? 1 : 0) - (keysDown.has("L") ? 1 : 0);
    }
  });
  addEventListener("blur", () => { keyBoost = mouseBoost = false; keyTurn = 0; keysDown.clear(); });

  /* ---------------- HUD (throttled DOM work; ranking done in WASM) ---------------- */
  const TIERS = ["ROOKIE", "CASUAL", "HUNTER", "ELITE", "LEGEND"];
  const TIER_COL = ["#6ee7b7", "#7dd3fc", "#fcd34d", "#fda4af", "#fbbf24"];
  const lbEl = $("lb");
  // leaderboard size: − / + in its title, or drag the corner grip; remembered (phones start smaller).
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
  for (const bt of document.querySelectorAll(".lbsz button")) {
    bt.addEventListener("pointerdown", (e) => e.stopPropagation());
    bt.onclick = (e) => { setLbScale(lbScale + 0.1 * +bt.dataset.d, true); e.currentTarget.blur(); };
  }
  const grip = $("lbGrip"); // bottom-left corner: the board is pinned top-right, so dragging down/left grows it
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
    const r = boardEl.getBoundingClientRect(), x0 = r.right, y0 = r.top, d0 = Math.hypot(x0 - e.clientX, e.clientY - y0), s0 = lbScale;
    const move = (m) => setLbScale(s0 * Math.hypot(x0 - m.clientX, m.clientY - y0) / Math.max(20, d0));
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up); setLbScale(lbScale, true); };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
  });
  const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  let lastMass = 10, lastLb = "";
  function updateHud() {
    W.rankPrep(); // fills lb: [alive, player rank, top 10 ids...]
    let html = "";
    for (let i = 0; i < 10 && lb[2 + i] >= 0; i++) {
      const s = lb[2 + i], b = s * SN, t = snap[b + 5];
      const tag = s === 0 ? `<span class="tg you" data-l="YOU" data-s="Y"></span>` : `<span class="tg t${t}" title="${TIERS[t]}" data-l="${TIERS[t]}" data-s="${TIERS[t][0]}"></span>`;
      html += `<li class="${s === 0 ? "me" : ""}"><span class="n">${i + 1}</span><span class="dot" style="background:${SKINS[snap[b + 4]][0]}"></span><span class="nm">${esc(s === 0 ? playerName() : names[s])}</span>${tag}<span class="sc">${Math.floor(snap[b + 3] * 10)}</span></li>`;
    }
    if (html !== lastLb) { lbEl.innerHTML = html; lastLb = html; }
    // keep label atlas slots in sync (bots change level when they respawn)
    for (let s = 0; s < NS; s++) {
      const key = s === 0 ? "p:" + playerName() : snap[s * SN] ? "t" + snap[s * SN + 5] : slotKey[s];
      if (key !== slotKey[s]) drawSlot(s, key);
    }
    if (state !== "play") return;
    $("len").textContent = Math.floor(snap[3] * 10);
    $("rank").textContent = lb[1];
    $("total").textContent = lb[0];
    $("kills").textContent = snap[7];
  }

  /* ---------------- Name + level labels (GPU) ----------------
     Each snake owns one slot of a texture atlas. A slot is re-drawn with Canvas2D
     only when its text changes (bot respawns with another level); every frame
     the labels are a single instanced draw that reuses the snake headers. */
  const slotKey = new Array(NS).fill("");
  const slotCanvas = document.createElement("canvas");
  slotCanvas.width = SLOT_W * LS; slotCanvas.height = SLOT_H * LS;
  const sc = slotCanvas.getContext("2d");
  const FONT = 'Outfit, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  function drawSlot(s, key) {
    slotKey[s] = key;
    sc.setTransform(LS, 0, 0, LS, 0, 0);
    sc.clearRect(0, 0, SLOT_W, SLOT_H);
    sc.textAlign = "center"; sc.textBaseline = "alphabetic";
    sc.shadowColor = "rgba(0,0,0,.6)"; sc.shadowBlur = 2.5; sc.shadowOffsetY = 0.5;
    sc.font = `600 12px ${FONT}`; sc.fillStyle = "rgba(255,255,255,.92)";
    const name = s === 0 ? playerName() : names[s];
    if (s === 0) { sc.fillText(name, SLOT_W / 2, SLOT_H - 6); }
    else {
      const t = +key.slice(1);
      sc.fillText(name, SLOT_W / 2, SLOT_H - 17);
      sc.font = `600 9.5px ${FONT}`; sc.fillStyle = TIER_COL[t]; sc.letterSpacing = "0.6px";
      sc.fillText(`LV ${t + 1} · ${TIERS[t]}`, SLOT_W / 2, SLOT_H - 6);
      sc.letterSpacing = "0px";
    }
    R.labelSlot(slotCanvas, (s % CELLS_X) * SLOT_W * LS, Math.floor(s / CELLS_X) * SLOT_H * LS);
  }
  // re-draw every label once the web font has loaded
  document.fonts?.ready.then(() => slotKey.fill(""));

  /* ---------------- Main loop ----------------
     JS gathers input, makes ONE WebAssembly call and hands its output to the GPU. */
  const perfEl = $("perf");
  const T = { sim: 0, prep: 0, gl: 0, hud: 0, n: 0 };
  let frameNo = 0, last = performance.now(), fpsAcc = 0, perfT = 0, hudT = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const playing = state === "play";
    if (!playing && now - last < 30) return; // menu / game-over: ~30 fps is plenty
    const dt = Math.min((now - last) / 1000, 0.25); last = now;
    if (playing) {
      // Keys steer relative to where the snake is heading NOW: aim a little to that side
      // (it then turns at its own top speed) or straight ahead. An aim that ran on by itself
      // could get more than half a turn ahead of a slow-turning big snake, which then turned
      // the other way.
      if (usingKeys) aim = W.playerAng() + keyTurn * 0.6;
      else aim = Math.atan2(my - innerHeight / 2, mx - innerWidth / 2);
    }

    // --- everything but drawing: input, 60 Hz sim, camera, culling, render data, draw counts
    W.frame(dt, aim, mouseBoost || keyBoost || touchBoost ? 1 : 0, playing ? 0 : state === "dead" ? 1 : 2, vw, vh, innerWidth, (now / 1000) % 3600);
    if (playing && !snap[0]) onDeath();
    if (snap[0]) lastMass = snap[3];
    const t2 = performance.now();

    const timing = !perfEl.classList.contains("off");
    R.draw(frameNo++, playing, timing);
    const t3 = performance.now();

    if ((hudT += dt) > 0.25) { hudT = 0; updateHud(); } // DOM: 4x per second
    const t4 = performance.now();

    T.sim += frameMs[0]; T.prep += frameMs[1]; T.gl += t3 - t2; T.hud += t4 - t3; T.n++; fpsAcc += dt;
    if ((perfT += dt) > 0.5 && !perfEl.classList.contains("off")) {
      const a = (v) => (v / T.n).toFixed(2);
      let near = 0; for (let s = 1; s < NS; s++) near += snap[s * SN] && snap[s * SN + 6] ? 1 : 0;
      const gpu = R.gpuMs >= 0 ? `<b>${R.gpuMs.toFixed(2)} ms</b>` + (R.passMs ? " (" + R.passMs.map((v, i) => `${R.passNames[i]} ${v.toFixed(2)}`).join(" · ") + ")" : "") : R.canTime ? "…" : "n/a";
      perfEl.innerHTML = `<b>${Math.round(T.n / fpsAcc)}</b> fps · <b>${R.name}</b> · CPU/frame: sim <b>${a(T.sim)}</b> · prep <b>${a(T.prep)}</b> · draw <b>${a(T.gl)}</b> · dom <b>${a(T.hud)}</b> ms` +
        `<br>GPU ${gpu}<br>${frameOut[0]} food slots (GPU-culled) · ${frameOut[1]} snakes drawn · full-detail bots <b>${near}</b> / ${NS - 1}` + benchTxt;
      perfT = 0; fpsAcc = 0; T.sim = T.prep = T.gl = T.hud = T.n = 0;
    }
  }
  // Simulation speed on this device, measured once warmed up (the first calls include
  // compiling). Timing 120 steps in one go keeps coarse/jittered browser timers out of it.
  let benchTxt = "";
  setTimeout(() => {
    if (state !== "menu") return;
    const us = W.bench(120);
    benchTxt = `<br>sim benchmark: <b>${us.toFixed(1)} µs</b> per step`;
    if (us > 150) {
      const n = $("slowNote"); n.hidden = false;
      n.innerHTML = optimizerOff() ? securityHint() :
        `The simulation is running slowly here (${Math.round(us)} µs per step; typical is 10–40). Check for battery saver / efficiency mode or a busy CPU.`;
    }
  }, 2500);
  W.snapshot(); updateHud();
  window.__serpent = { W, snap, names, renderer: () => R.name, device: R.device }; // debugging / automated tests
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
