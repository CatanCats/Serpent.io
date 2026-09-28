// Serpent.io online server.
// Runs the game simulation (sim-server.wasm, built from sim-server.c: the offline
// rules, extended for many players) at a fixed 60 Hz and sends every client only
// what is near it, 30 times a second, as compact binary WebSocket messages.
// It also serves the online page (../../online.html) at /, so one process is
// the whole online game.
//
//   npm install && node server.js          (PORT=8080 by default)
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpus, totalmem } from "node:os";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const BOTS = +(process.env.BOTS || 60);
const MAX_PER_IP = +(process.env.MAX_PER_IP || 8);

/* ---------------- simulation ---------------- */
const { instance } = await WebAssembly.instantiate(readFileSync(join(here, "sim-server.wasm")), { env: { now: () => performance.now() } });
const W = instance.exports;
W.init((Math.random() * 4294967295) >>> 0, BOTS);
const mem = W.memory.buffer; // static: never grows, so views stay valid
const MAXS = W.maxSnakes(), RING = W.ring(), RMASK = RING - 1, MAXF = W.maxFood(), WR = W.worldRadius(), NB = W.botCount();
// Pub record per slot: f32 hx, hy, ang, mass, r, spacing | u32 pc, n, alive, skin, tier, boost, kills, human
const PUB_F = new Float32Array(mem, W.pubPtr(), MAXS * 14), PUB_U = new Uint32Array(mem, W.pubPtr(), MAXS * 14);
const P = (s, i) => PUB_F[s * 14 + i], PU = (s, i) => PUB_U[s * 14 + i];
const trail = new Int16Array(mem, W.trailPtr(), MAXS * RING * 2);
const food8 = new Uint8Array(mem, W.foodPtr(), MAXF * 8), food32 = new Uint32Array(mem, W.foodPtr(), MAXF * 2);
const food16 = new Int16Array(mem, W.foodPtr(), MAXF * 4);

/* ---------------- protocol (little-endian) ----------------
   client -> server
     1 JOIN   u8 skin, u16 aspect*1000, u8 len, name (utf-8)   (also respawns)
     2 INPUT  u16 aim (-pi..pi), u8 boost
     3 VIEW   u16 aspect*1000
     4 LEAVE  back to the menu (snake removed)
   server -> client
     1 WELCOME u8 maxSnakes, u16 ring, f32 worldRadius, u8 bots, u8 playersOnline
     2 SNAP    u32 tick, u8 you (255 none), u8 spectate, u16 nSnakes, snakes..., u16 nFood, food...
               snake: u8 slot, u8 flags(1 boost, 2 human, 4 full trail), u8 skin, u8 tier,
                      f32 x, f32 y, f32 ang, f32 mass, u16 n, u32 pc, u16 kills, u16 count, count x (i16 x, i16 y) Q2
               food:  u16 index, 8 bytes (x i16, y i16, value u8, skin u8, born u16), value 0 = gone
     3 BOARD   u16 alive, u16 yourRank, u8 count, count x (u8 slot, u8 tier, u8 skin, u8 human, f32 mass)
     4 NAME    u8 slot, u8 len, name
     5 DEATH   u8 killer (255 = world edge), u16 kills, f32 mass
     6 MINI    u16 count, count x (u8 slot, u8 skin, i16 x, i16 y, u16 mass)
     7 FULL    server is full */

const clients = new Set();
const names = new Array(MAXS).fill("");
const out = new ArrayBuffer(1 << 20), dv = new DataView(out), u8 = new Uint8Array(out);
const enc = new TextEncoder(), dec = new TextDecoder();
const cleanName = (s) => s.replace(/[\u0000-\u001f\u007f<>&"]/g, "").trim().slice(0, 16) || "Player";

function send(c, len) { if (c.ws.readyState === 1 && c.ws.bufferedAmount < 1 << 20) c.ws.send(u8.slice(0, len)); }
function broadcastName(slot) {
  const b = enc.encode(names[slot]);
  u8[0] = 4; u8[1] = slot; u8[2] = b.length; u8.set(b, 3);
  for (const c of clients) send(c, 3 + b.length);
}

let spectate = 1, specT = 0;
function pickSpectate() {
  let best = -1;
  for (let s = 1; s <= NB; s++) if (PU(s, 8) && (best < 0 || P(s, 3) > P(best, 3))) best = s;
  if (best >= 0) spectate = best;
}

function onMessage(c, data) {
  if (!(data instanceof Buffer) || data.length < 1 || data.length > 64) return;
  const d = new DataView(data.buffer, data.byteOffset, data.length), t = data[0];
  if (t === 1 && data.length >= 5) { // JOIN / respawn
    const skin = data[1], asp = d.getUint16(2, true) / 1000, len = Math.min(data[4], data.length - 5);
    if (c.slot < 0) {
      const s = W.addHuman();
      if (s < 0) { u8[0] = 7; send(c, 1); return; }
      c.slot = s;
    }
    names[c.slot] = cleanName(dec.decode(data.subarray(5, 5 + len)));
    W.setAspect(c.slot, asp); c.aspect = asp;
    W.spawnHuman(c.slot, skin);
    c.alive = true; c.sentPc.fill(0);
    broadcastName(c.slot);
  } else if (t === 2 && data.length >= 4 && c.slot >= 0) {
    W.setInput(c.slot, (d.getUint16(1, true) / 65535) * 2 * Math.PI - Math.PI, data[3]);
  } else if (t === 3 && data.length >= 3) {
    c.aspect = Math.min(4, Math.max(0.3, d.getUint16(1, true) / 1000));
    if (c.slot >= 0) W.setAspect(c.slot, c.aspect);
  } else if (t === 4) leave(c);
}
function leave(c) {
  if (c.slot < 0) return;
  W.removeHuman(c.slot); names[c.slot] = ""; broadcastName(c.slot);
  c.slot = -1; c.alive = false;
}

/* ---------------- per-client snapshot: only what is near ----------------
   The view is sized like the offline camera; snakes whose body can reach into
   it are sent with just the trail points the client doesn't have yet; food is
   diffed against what this client already holds (a shadow copy). */
function snapshot(c, tick) {
  const me = c.slot, alive = me >= 0 && PU(me, 8);
  let cx, cy, camH;
  if (alive) { cx = P(me, 0); cy = P(me, 1); camH = 560 + (P(me, 4) - 12) * 18; c.lastX = cx; c.lastY = cy; c.lastH = camH; }
  else if (me >= 0) { cx = c.lastX; cy = c.lastY; camH = (c.lastH || 900) * 1.6; } // dead: client zooms out
  else { cx = P(spectate, 0); cy = P(spectate, 1); camH = 900; }
  const hh = camH + 250, hw = camH * c.aspect + 250; // + margin for the client's smoothed camera
  let o = 0;
  dv.setUint8(o, 2); dv.setUint32(o + 1, tick, true); dv.setUint8(o + 5, me >= 0 ? me : 255); dv.setUint8(o + 6, spectate);
  const nPos = o + 7; o += 9;
  let n = 0;
  for (let s = 0; s < MAXS; s++) {
    if (!PU(s, 8)) { c.sentPc[s] = 0; continue; }
    const x = P(s, 0), y = P(s, 1), r = P(s, 4), len = PU(s, 7), reach = len * P(s, 5) + r * 2 + 50;
    if (s !== me && (Math.abs(x - cx) > hw + reach || Math.abs(y - cy) > hh + reach)) { c.sentPc[s] = 0; continue; }
    const pc = PU(s, 6), prev = c.sentPc[s];
    let full = 0, count = pc - prev;
    if (!prev || count > len + 2) { full = 4; count = Math.min(len + 2, RING); }
    if (o + 32 + count * 4 > out.byteLength - 70000) break; // leave room for food
    dv.setUint8(o, s); dv.setUint8(o + 1, PU(s, 11) | (PU(s, 13) ? 2 : 0) | full); dv.setUint8(o + 2, PU(s, 9)); dv.setUint8(o + 3, PU(s, 10));
    dv.setFloat32(o + 4, x, true); dv.setFloat32(o + 8, y, true); dv.setFloat32(o + 12, P(s, 2), true); dv.setFloat32(o + 16, P(s, 3), true);
    dv.setUint16(o + 20, len, true); dv.setUint32(o + 22, pc, true); dv.setUint16(o + 26, Math.min(PU(s, 12), 65535), true); dv.setUint16(o + 28, count, true);
    o += 30;
    for (let p = pc - count; p !== pc; p = (p + 1) >>> 0) { // points in push order
      const i = ((s * RING) + (p & RMASK)) * 2;
      dv.setInt16(o, trail[i], true); dv.setInt16(o + 2, trail[i + 1], true); o += 4;
    }
    c.sentPc[s] = pc; n++;
  }
  dv.setUint16(nPos, n, true);
  // food: diff against the shadow of what this client holds
  const fPos = o; o += 2;
  let nf = 0;
  const fx0 = (cx - hw - 100) * 4, fx1 = (cx + hw + 100) * 4, fy0 = (cy - hh - 100) * 4, fy1 = (cy + hh + 100) * 4;
  const hi = Math.max(W.foodCount(), c.foodHigh), sh = c.shadow;
  let newHigh = 0;
  for (let i = 0; i < hi && o < out.byteLength - 16; i++) {
    let a = 0, b = 0;
    if (food8[i * 8 + 4]) { // value != 0: alive
      const fx = food16[i * 4], fy = food16[i * 4 + 1];
      if (fx > fx0 && fx < fx1 && fy > fy0 && fy < fy1) { a = food32[i * 2]; b = food32[i * 2 + 1]; }
    }
    if (a || b) newHigh = i + 1;
    if (sh[i * 2] === a && sh[i * 2 + 1] === b) continue;
    sh[i * 2] = a; sh[i * 2 + 1] = b;
    dv.setUint16(o, i, true); dv.setUint32(o + 2, a, true); dv.setUint32(o + 6, b, true); o += 10; nf++;
  }
  c.foodHigh = newHigh;
  dv.setUint16(fPos, nf, true);
  send(c, o);
}

function board(c, order, nAlive) {
  let o = 0, rank = 0;
  for (let i = 0; i < nAlive; i++) if (order[i] === c.slot) rank = i + 1;
  dv.setUint8(o, 3); dv.setUint16(o + 1, nAlive, true); dv.setUint16(o + 3, rank, true);
  const k = Math.min(10, nAlive); dv.setUint8(o + 5, k); o += 6;
  for (let i = 0; i < k; i++) {
    const s = order[i];
    dv.setUint8(o, s); dv.setUint8(o + 1, PU(s, 10)); dv.setUint8(o + 2, PU(s, 9)); dv.setUint8(o + 3, PU(s, 13)); dv.setFloat32(o + 4, P(s, 3), true); o += 8;
  }
  send(c, o);
}
function miniMsg() { // same for everyone: every living snake, coarse
  let o = 3, n = 0;
  for (let s = 0; s < MAXS; s++) {
    if (!PU(s, 8)) continue;
    dv.setUint8(o, s); dv.setUint8(o + 1, PU(s, 9));
    dv.setInt16(o + 2, Math.round((P(s, 0) / WR) * 32767), true); dv.setInt16(o + 4, Math.round((P(s, 1) / WR) * 32767), true);
    dv.setUint16(o + 6, Math.min(65535, Math.round(P(s, 3))), true); o += 8; n++;
  }
  dv.setUint8(0, 6); dv.setUint16(1, n, true);
  return o;
}

/* ---------------- fixed 60 Hz loop ---------------- */
const STEP_MS = 1000 / 60;
let next = performance.now(), tickNo = 0, stepUs = 0, sendUs = 0, statN = 0;
const order = new Int32Array(MAXS);
function loop() {
  const now = performance.now();
  for (let k = 0; now >= next && k < 5; k++) {
    const t0 = performance.now();
    W.tick(); tickNo++;
    const t1 = performance.now();
    // deaths of players
    for (const c of clients) {
      if (c.slot >= 0 && c.alive && !PU(c.slot, 8)) {
        c.alive = false;
        const kb = W.killedBy(c.slot);
        dv.setUint8(0, 5); dv.setUint8(1, kb >= 0 ? kb : 255); dv.setUint16(2, Math.min(PU(c.slot, 12), 65535), true); dv.setFloat32(4, P(c.slot, 3), true);
        send(c, 8);
      }
    }
    if ((specT += STEP_MS) > 8000 || !PU(spectate, 8)) { specT = 0; pickSpectate(); }
    if (tickNo % 2 === 0) for (const c of clients) snapshot(c, W.now());
    if (tickNo % 15 === 0) { // 4 Hz: leaderboard + minimap
      let nA = 0;
      for (let s = 0; s < MAXS; s++) if (PU(s, 8)) {
        let j = nA++;
        while (j > 0 && P(order[j - 1], 3) < P(s, 3)) { order[j] = order[j - 1]; j--; }
        order[j] = s;
      }
      for (const c of clients) board(c, order, nA);
      const len = miniMsg();
      for (const c of clients) send(c, len);
    }
    stepUs += (t1 - t0) * 1000; sendUs += (performance.now() - t1) * 1000; statN++;
    next += STEP_MS;
  }
  if (now - next > 250) next = now; // stalled (e.g. suspended): don't fast-forward
  setTimeout(loop, Math.max(0, next - performance.now()));
}

/* ---------------- HTTP (serves the online page) + WebSocket ---------------- */
const pagePath = join(here, "..", "..", "online.html");
const http = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/online.html" || url === "/index.html") {
    try { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); res.end(readFileSync(pagePath)); }
    catch { res.writeHead(500); res.end("online.html not built: run node online/build.mjs"); }
  } else if (url === "/status") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ players: [...clients].filter((c) => c.slot >= 0).length, connections: clients.size, tick: W.now(),
      stepUs: +(stepUs / Math.max(1, statN)).toFixed(1), sendUs: +(sendUs / Math.max(1, statN)).toFixed(1), cpus: cpus().length }));
  } else { res.writeHead(404); res.end(); }
});
const perIp = new Map();
const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 256, perMessageDeflate: false });
wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  if ((perIp.get(ip) || 0) >= MAX_PER_IP) { ws.close(1008, "too many connections"); return; }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  ws.binaryType = "nodebuffer";
  const c = { ws, slot: -1, alive: false, aspect: 1.78, sentPc: new Uint32Array(MAXS), shadow: new Uint32Array(MAXF * 2), foodHigh: 0, msgs: 0 };
  clients.add(c);
  dv.setUint8(0, 1); dv.setUint8(1, MAXS); dv.setUint16(2, RING, true); dv.setFloat32(4, WR, true); dv.setUint8(8, NB);
  dv.setUint8(9, Math.min(255, [...clients].filter((k) => k.slot >= 0).length));
  send(c, 10);
  for (let s = 0; s < MAXS; s++) if (names[s]) { const b = enc.encode(names[s]); u8[0] = 4; u8[1] = s; u8[2] = b.length; u8.set(b, 3); send(c, 3 + b.length); }
  ws.on("message", (data) => { if (++c.msgs <= 240) onMessage(c, data); }); // flood guard: 240 msgs/s
  ws.on("close", () => { leave(c); clients.delete(c); perIp.set(ip, perIp.get(ip) - 1); if (!perIp.get(ip)) perIp.delete(ip); });
  ws.on("error", () => {});
});
setInterval(() => { for (const c of clients) c.msgs = 0; }, 1000);
setInterval(() => {
  if (!statN) return;
  console.log(`players ${[...clients].filter((c) => c.slot >= 0).length} · connections ${clients.size} · sim ${(stepUs / statN).toFixed(0)} µs/step · network ${(sendUs / statN).toFixed(0)} µs/step`);
  stepUs = sendUs = statN = 0;
}, 30000);

http.listen(PORT, () => {
  console.log(`serpent.io online server on :${PORT}  (${BOTS} bots, CPU: ${cpus()[0]?.model || "?"} x${cpus().length}, RAM ${(totalmem() / 2 ** 30).toFixed(1)} GB)`);
  console.log(`sim benchmark: ${W.bench(1).toFixed(0)} µs/step (warm-up)`);
  next = performance.now(); loop();
});
