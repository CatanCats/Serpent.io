"use strict";

/* Skin palette — must match the shader's table (index = skin id). */
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
  const snap = new Float32Array(mem, W.snapPtr(), NS * 10); // alive,x,y,mass,r,skin,tier,near,onScreen,kills
  const lb = new Int32Array(mem, W.rankPrep(), 12);
  const frameBlk = new Float32Array(mem, W.frameBlkPtr(), 12); // std140 Frame block, written by WASM
  const frameOut = new Int32Array(mem, W.frameOutPtr(), 8);    // counts for this frame
  const frameMs = new Float32Array(mem, W.frameMsPtr(), 2);    // WASM-side timings
  // label atlas at the screen's own pixel density (not always 2x): smaller texture, same sharpness
  const SLOT_W = 150, SLOT_H = 34, LS = Math.min(2, Math.max(1, window.devicePixelRatio || 1)), CELLS_X = 8, CELLS_Y = Math.ceil(NS / CELLS_X);
  const E = {
    W, mem, NS, RING, SKINS, SLOT_W, SLOT_H, CELLS_X, CELLS_Y, AW: SLOT_W * LS * CELLS_X, AH: SLOT_H * LS * CELLS_Y,
    frameBlk, frameOut,
    trail: new Int16Array(mem, W.trailPtr(), NS * RING * 2),
    tup: new Uint32Array(mem, W.tupPtr(), NS * 6),          // trail uploads: (row, first index, count)...
    ptr: { trail: W.trailPtr() },
  };
  // The per-frame GPU block in WASM memory: offsets relative to its start (frame uniforms at 0)
  const base = W.frameBlkPtr();
  E.arena = { base, hdr: W.hdrPtr() - base, mini: W.miniPtr() - base,
              inst: W.instPtr() - base, size: W.instPtr() - base + W.maxInst() * 16 };
  E.arenaBytes = new Uint8Array(mem, base, E.arena.size);

  /* ---------------- Renderer: WebGPU first, WebGL 2 as the backup ----------------
     ?renderer=webgl forces the backup. A lost WebGPU device reloads into WebGL. */
  const canvas = $("gl");
  const saved = store.get("serpent.renderer") || "auto";
  const want = new URLSearchParams(location.search).get("renderer") || (sessionStorage.getItem("serpent.gl") ? "webgl" : saved);
  let R = null;
  if (want !== "webgl") {
    try { R = await createGPU(canvas, E); }
    catch (e) { console.warn("WebGPU unavailable, using WebGL 2:", e); R = null; }
    if (!R && canvas.getContext("webgpu")) { // the canvas is taken by a failed WebGPU attempt: swap it
      const c2 = canvas.cloneNode(); canvas.replaceWith(c2);
    }
    if (R) R.device.lost.then((info) => { if (info.reason !== "destroyed") { sessionStorage.setItem("serpent.gl", "1"); location.reload(); } });
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
    b.setAttribute("aria-pressed", b.dataset.r === saved);
    b.onclick = () => { store.set("serpent.renderer", b.dataset.r); sessionStorage.removeItem("serpent.gl"); location.href = location.pathname; };
  }
  $("rnow").textContent = R.name;
  const qEl = $("qsw");
  const markQ = () => { for (const b of qEl.querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.q === quality); };
  for (const b of qEl.querySelectorAll("button")) b.onclick = () => { quality = b.dataset.q; store.set("serpent.quality", quality); markQ(); resize(); };
  markQ();

  let vw = 0, vh = 0, resScale = 1;
  const miniEl = $("mini");
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, QUAL[quality] || 2) * resScale;
    vw = Math.round(innerWidth * dpr); vh = Math.round(innerHeight * dpr);
    if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
    R.resize(vw, vh);
    const r = miniEl.getBoundingClientRect();
    R.placeMini(((r.left + r.width / 2) / innerWidth) * 2 - 1, 1 - ((r.top + r.height / 2) / innerHeight) * 2, (r.width / 2 - 3) * (vw / innerWidth));
  }
  addEventListener("resize", resize); resize();

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
  let aim = 0, mouseBoost = false, keyBoost = false, touchBoost = false, keyTurn = 0, usingKeys = false;
  let mx = innerWidth / 2 + 100, my = innerHeight / 2;
  cv.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mx = e.clientX; my = e.clientY; usingKeys = false; } });
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
    else if (k === "ArrowLeft" || k === "a") { keyTurn = -1; usingKeys = true; }
    else if (k === "ArrowRight" || k === "d") { keyTurn = 1; usingKeys = true; }
    else if (k === "p" || k === "P") $("perf").classList.toggle("off");
    else if ((k === "b" || k === "B") && state !== "play") runBench();
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

  /* ---------------- HUD (throttled DOM work; ranking done in WASM) ---------------- */
  const TIERS = ["ROOKIE", "CASUAL", "HUNTER", "ELITE", "LEGEND"];
  const TIER_COL = ["#6ee7b7", "#7dd3fc", "#fcd34d", "#fda4af", "#fbbf24"];
  const lbEl = $("lb");
  const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  let lastMass = 10, lastLb = "";
  function updateHud() {
    W.rankPrep(); // fills lb: [alive, player rank, top 10 ids...]
    let html = "";
    for (let i = 0; i < 10 && lb[2 + i] >= 0; i++) {
      const s = lb[2 + i], b = s * 10, t = snap[b + 6];
      const tag = s === 0 ? `<span class="tg you">YOU</span>` : `<span class="tg t${t}">${TIERS[t]}</span>`;
      html += `<li class="${s === 0 ? "me" : ""}"><span class="n">${i + 1}</span><span class="dot" style="background:${SKINS[snap[b + 5]][0]}"></span><span class="nm">${esc(s === 0 ? playerName() : names[s])}</span>${tag}<span class="sc">${Math.floor(snap[b + 3] * 10)}</span></li>`;
    }
    if (html !== lastLb) { lbEl.innerHTML = html; lastLb = html; }
    // keep label atlas slots in sync (bots change level when they respawn)
    for (let s = 0; s < NS; s++) {
      const key = s === 0 ? "p:" + playerName() : snap[s * 10] ? "t" + snap[s * 10 + 6] : slotKey[s];
      if (key !== slotKey[s]) drawSlot(s, key);
    }
    if (atlasDirty) { R.labelsDone(); atlasDirty = false; }
    if (state !== "play") return;
    $("len").textContent = Math.floor(snap[3] * 10);
    $("rank").textContent = lb[1];
    $("total").textContent = lb[0];
    $("kills").textContent = snap[9];
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
  let atlasDirty = false;
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
    atlasDirty = true;
  }
  // re-draw every label once the web font has loaded
  document.fonts?.ready.then(() => slotKey.fill(""));

  /* ---------------- Benchmark (B on the menu) ----------------
     Times 600 simulation steps in one go, so coarse or jittered browser timers
     (privacy protections) can't distort it. */
  let benchTxt = "";
  function runBench() {
    const us = W.bench(600);
    benchTxt = `<br>bench: <b>${us.toFixed(1)} µs</b> per sim step (${(us * 60 / 10).toFixed(2)}% of one core at 60 Hz)`;
    $("perf").classList.remove("off"); perfT = 1;
  }

  /* ---------------- Main loop ----------------
     JS gathers input, makes ONE WebAssembly call and hands its output to the GPU. */
  const perfEl = $("perf");
  const noGpuTime = new URLSearchParams(location.search).get("gputime") === "0"; // for A/B CPU measurements
  const T = { sim: 0, prep: 0, gl: 0, hud: 0, n: 0 };
  let resDrops = 1, frameNo = 0, last = performance.now(), fpsAcc = 0, perfT = 0, hudT = 0, avgDt = 1 / 60, resT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const playing = state === "play";
    if (!playing && now - last < 30) return; // menu / game-over: ~30 fps is plenty
    const dt = Math.min((now - last) / 1000, 0.25); last = now;
    // dynamic resolution: drop pixels before dropping frames, recover after a long calm spell
    if (playing) {
      avgDt += (Math.min(dt, 0.1) - avgDt) * 0.05; resT += dt;
      if (resT > 1 && avgDt > 1 / 48 && resScale > 0.55) { resScale = Math.max(0.5, resScale - 0.1); resT = 0; resDrops++; resize(); }
      else if (resT > 8 * resDrops && avgDt < 1 / 57 && resScale < 1) { resScale = Math.min(1, resScale + 0.1); resT = 0; resize(); }
      if (usingKeys) aim += keyTurn * dt * 4.2;
      else aim = Math.atan2(my - innerHeight / 2, mx - innerWidth / 2);
    }

    // --- everything but drawing: input, 60 Hz sim, camera, culling, render data, draw counts
    W.frame(dt, aim, mouseBoost || keyBoost || touchBoost ? 1 : 0, playing ? 0 : state === "dead" ? 1 : 2, vw, vh, innerWidth, (now / 1000) % 3600);
    if (playing && !snap[0]) onDeath();
    if (snap[0]) lastMass = snap[3];
    const t2 = performance.now();

    const timing = !perfEl.classList.contains("off") && !noGpuTime;
    R.draw(frameNo++, playing, timing);
    const t3 = performance.now();

    if ((hudT += dt) > 0.25) { hudT = 0; updateHud(); } // DOM: 4x per second
    const t4 = performance.now();

    T.sim += frameMs[0]; T.prep += frameMs[1]; T.gl += t3 - t2; T.hud += t4 - t3; T.n++; fpsAcc += dt;
    if ((perfT += dt) > 0.5 && !perfEl.classList.contains("off")) {
      const a = (v) => (v / T.n).toFixed(2);
      let near = 0; for (let s = 1; s < NS; s++) near += snap[s * 10] && snap[s * 10 + 7] ? 1 : 0;
      const gpu = R.gpuMs >= 0 ? `<b>${R.gpuMs.toFixed(2)} ms</b>` + (R.passMs ? " (" + R.passMs.map((v, i) => `${R.passNames[i]} ${v.toFixed(2)}`).join(" · ") + ")" : "") : R.canTime ? "…" : "n/a";
      perfEl.innerHTML = `<b>${Math.round(T.n / fpsAcc)}</b> fps · <b>${R.name}</b> · CPU/frame: sim <b>${a(T.sim)}</b> · prep <b>${a(T.prep)}</b> · draw <b>${a(T.gl)}</b> · dom <b>${a(T.hud)}</b> ms` +
        `<br>GPU ${gpu}<br>${frameOut[0]} food · ${frameOut[1]} snakes drawn · res <b>${Math.round(resScale * 100)}%</b> · full-detail bots <b>${near}</b> / ${NS - 1}` + benchTxt;
      perfT = 0; fpsAcc = 0; T.sim = T.prep = T.gl = T.hud = T.n = 0;
    }
  }
  // Is WebAssembly running at full speed? A healthy browser does a sim step in
  // ~5-30 us; 20x slower means its compilers are off (e.g. Edge "Enhance your
  // security on the web"), which also slows JavaScript.
  {
    const us = W.bench(30);
    if (us > 300) {
      const n = $("slowNote"); n.hidden = false;
      n.innerHTML = `WebAssembly is running ~${Math.round(us / 10)}× slower than normal in this browser. In Edge: click the padlock / site-info icon in the address bar and turn off <b>Enhance security for this site</b>, or set edge://settings/privacy → "Enhance your security on the web" to <b>Basic</b>.`;
    }
  }
  W.snapshot(); updateHud();
  window.__serpent = { W, snap, names, renderer: () => R.name }; // debugging / automated tests
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
