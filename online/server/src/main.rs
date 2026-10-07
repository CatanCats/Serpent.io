//! Serpent.io online server.
//!
//! * The game is the offline game's simulation (`sim-server.c`: same rules, extended
//!   for many players), compiled to native machine code and linked in.
//! * One game thread owns it and steps it at a fixed 60 Hz. Every 2 steps it
//!   builds, for each client, a binary snapshot of only what is near that client:
//!   new trail points of nearby snakes and changed food in view.
//! * Networking is async (tokio + axum WebSockets). Connections hand messages to the
//!   game thread over a channel and receive their snapshots over a bounded
//!   channel; a client that can't keep up gets a full resync instead of a backlog.
//! * The same process serves the game pages: `/` (online) and `/offline.html`.
//!
//! Run: `cargo run --release` (PORT=8080, BOTS=60, WEB_ROOT=../.. by default).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::{mpsc as smpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::ListenerExt;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

#[cfg(target_endian = "big")]
compile_error!("the trail is sent as raw little-endian bytes");

/* ---------------- the simulation (C, native) ---------------- */

#[repr(C)]
#[derive(Clone, Copy)]
struct Pub { hx: f32, hy: f32, ang: f32, mass: f32, r: f32, spacing: f32, pc: u32, n: u32, alive: u32, skin: u32, tier: u32, boost: u32, kills: u32, human: u32 }

extern "C" {
    fn sim_init(seed: u32, bots: i32);
    fn sim_add_human() -> i32;
    fn sim_remove_human(s: i32);
    fn sim_spawn_human(s: i32, skin: i32);
    fn sim_set_input(s: i32, aim: f32, boost: i32, late: i32);
    fn sim_set_jitter(s: i32, steps: i32);
    fn sim_set_lag(s: i32, steps: f32);
    fn sim_set_aspect(s: i32, a: f32);
    fn sim_set_menu_focus(on: i32, x: f32, y: f32, r: f32);
    fn sim_step();
    fn sim_tick() -> u32;
    fn sim_pub() -> *const Pub;
    fn sim_trail() -> *const i16;
    fn sim_food() -> *const u64;
    fn sim_food_events() -> *const u32;
    fn sim_food_event_count() -> i32;
    fn sim_food_events_lost() -> i32;
    fn sim_food_events_clear();
    fn sim_max_food() -> i32;
    fn sim_ring() -> i32;
    fn sim_max_snakes() -> i32;
    fn sim_bot_count() -> i32;
    fn sim_world_radius() -> f32;
    fn sim_killed_by(s: i32) -> i32;
}

/// Read-only views of the simulation's static memory. Only the game thread uses
/// them, and never while a sim_* call is running, so plain pointer reads are sound.
struct Sim { pubs: *const Pub, trail: *const i16, food: *const u64,
             maxs: usize, ring: usize, maxf: usize, bots: usize, wr: f32 }
impl Sim {
    fn new(seed: u32, bots: i32) -> Sim {
        unsafe {
            sim_init(seed, bots);
            Sim { pubs: sim_pub(), trail: sim_trail(), food: sim_food(),
                  maxs: sim_max_snakes() as usize, ring: sim_ring() as usize, maxf: sim_max_food() as usize,
                  bots: sim_bot_count() as usize, wr: sim_world_radius() }
        }
    }
    #[inline] fn p(&self, s: usize) -> Pub { unsafe { *self.pubs.add(s) } }
    /// `count` trail points of snake s from ring slot a, as raw bytes (4 per point).
    #[inline] fn trail_bytes(&self, s: usize, a: usize, count: usize) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.trail.add((s * self.ring + a) * 2) as *const u8, count * 4) }
    }
    #[inline] fn food(&self, i: usize) -> u64 { unsafe { *self.food.add(i) } }
}

/* ---------------- protocol (little-endian; mirrored in online/client/client.js) ----------------
 client -> server:  1 JOIN  u8 skin, u16 aspect*1000, u8 len, name   (also respawns)
                    2 INPUT u16 aim (-pi..pi), u8 boost, u8 seq (counts up; echoed back for the client's prediction),
                          u16 when it was made (the page's clock, ms): how late each input arrives, see on_input
                    3 VIEW  u16 aspect*1000
                    4 LEAVE (back to the menu)
                    5 PING  u8 id   (answered at once with PONG, by the connection, not the game loop)
                    6 DELAY u16 round trip in ms (the page's measurement; used to compensate collisions)
                    7 CHAT  u8 len, text (UTF-8, at most 80 characters; one message per 1.2 s; joined players only)
 server -> client:  1 WELCOME u8 maxSnakes, u16 ring, f32 worldRadius, u8 bots, u8 players
                    2 SNAP  u32 tick, u8 you (255 none), u8 spectate, u8 flags (1 = reset), u16 your kills,
                          u8 last input seq received, u8 steps since it was received, u8 n, snakes, u16 m, food
                        snake: u8 slot, u8 flags (1 boost, 2 human, 4 full body, 8 absolute head, 16 size follows), then
                          full body:  u8 skin, u8 tier, i16 x, i16 y (head, Q2), u16 mass*4, u16 count,
                                      i16 x, i16 y (oldest point), count-1 x (i8 dx, i8 dy) (Q2 steps to the next point)
                          otherwise:  i8 dx, i8 dy (head moved, Q2), or i16 x, i16 y with flag 8; u16 mass*4 with flag 16
                          Only the head and size are sent: the client lays the body points itself, the way the
                          simulation does (a point every `spacing` along the head's path).
                        food:  u16 slot | 0x8000 = added/changed: i16 x, i16 y (Q2), u8 value, u8 skin (+128: just
                               spawned, fades in); u16 slot alone = gone
                    3 BOARD u16 alive, u16 yourRank, u8 k, k x (u8 slot, u8 tier, u8 skin, u8 human, f32 mass)
                    4 NAME  u8 slot, u8 len, name
                    5 DEATH u8 killer (255 = world edge), u16 kills, f32 mass
                    6 MINI  u16 k, k x (u8 slot, u8 x, u8 y (0..255 across the world), u8 skin | size<<4)
                    7 FULL  (server full)
                    8 PONG  u8 id
                    9 CHAT  u8 slot, u8 len, name, u8 len, text (to everyone) */

/// How many steps behind the server a player's screen shows the other snakes: its round
/// trip (your own snake is predicted ahead by half of it, the others arrive half of it
/// late), plus the page's smoothing delay (INTERP = 4 steps) and half a snapshot interval.
fn lag_steps(rtt_ms: u16) -> f32 { if rtt_ms == 0 { 0. } else { rtt_ms as f32 * 0.06 + 5. } }

/// World units to 16-bit fixed point (quarter units), the trail's own format.
#[inline] fn q2(v: f32) -> i16 { (v * 4.).round().clamp(-32767., 32767.) as i16 }

struct Out(Vec<u8>);
impl Out {
    #[inline] fn u8(&mut self, v: u8) { self.0.push(v) }
    #[inline] fn u16(&mut self, v: u16) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn u32(&mut self, v: u32) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn i16(&mut self, v: i16) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn f32(&mut self, v: f32) { self.0.extend_from_slice(&v.to_le_bytes()) }
    fn patch16(&mut self, at: usize, v: u16) { self.0[at..at + 2].copy_from_slice(&v.to_le_bytes()) }
}

enum Ev { Open { id: u64, tx: mpsc::Sender<Vec<u8>> }, Msg { id: u64, data: Vec<u8>, at: Instant }, Close { id: u64 } }

struct Client {
    tx: mpsc::Sender<Vec<u8>>,
    slot: i32, alive: bool, aspect: f32,
    last: (f32, f32, f32), // last camera (x, y, half height) while alive
    sent_pc: Vec<u32>,     // per snake: trail points this client has up to (0 = it doesn't have the snake)
    sent_from: Vec<u32>,   // per snake: the oldest trail point it has
    sent_head: Vec<(i16, i16, u16)>, // per snake: the head (Q2) and mass*4 it was last sent
    rect: Rect,            // food sectors this client is subscribed to (its view)
    pend: Vec<u8>,         // food changes in those sectors since the last snapshot
    npend: u32,
    rtt_ms: u16,           // its measured network round trip
    chat_at: Option<Instant>, // its last chat message (rate limit)
    clk: i64, clk_lo: u16, clk_ok: bool, // the page's clock, unwrapped from its 16-bit stamps
    offs: std::collections::VecDeque<i64>, lates: std::collections::VecDeque<u8>, jitter: i32, late_max: i32, // (late_max: for the log)
    in_seq: u8, in_tick: u32, // the last input it sent and the step count when it arrived
    reset: bool,           // a snapshot was dropped: resend everything
    cap: usize,            // size of its last snapshot: the next buffer is allocated once, right-sized
    msgs: u32,
}

#[derive(Default)]
struct Stats { players: AtomicU32, conns: AtomicU32, tick: AtomicU32, step_ns: AtomicU64, send_ns: AtomicU64 }

/// A chat line as sent on: no control characters, at most 80 characters, trimmed.
fn clean_chat(b: &[u8]) -> String {
    let s: String = String::from_utf8_lossy(b).chars().filter(|c| !c.is_control()).take(80).collect();
    let mut t = s.trim().to_string();
    while t.len() > 240 { t.pop(); } // its byte length must fit the u8 on the wire
    t
}

fn clean_name(b: &[u8]) -> String {
    let s: String = String::from_utf8_lossy(b).chars().filter(|c| !c.is_control() && !"<>&\"".contains(*c)).take(16).collect();
    let t = s.trim();
    if t.is_empty() { "Player".into() } else { t.into() }
}

/* ---------------- the game thread ---------------- */

struct Game {
    sim: Sim, clients: HashMap<u64, Client>, names: Vec<String>,
    t0: Instant, spectate: usize, spec_t: f32, stats: Arc<Stats>, snakes_out: Vec<SnakeOut>, live: Vec<u8>,
    food: FoodIndex,
}

impl Game {
    fn send(c: &mut Client, m: Vec<u8>) {
        if let Err(mpsc::error::TrySendError::Full(_)) = c.tx.try_send(m) { c.reset = true; }
    }
    fn name_msg(&self, s: usize) -> Vec<u8> {
        let b = self.names[s].as_bytes();
        let mut o = Out(Vec::with_capacity(3 + b.len()));
        o.u8(4); o.u8(s as u8); o.u8(b.len() as u8); o.0.extend_from_slice(b);
        o.0
    }
    fn broadcast_except(&mut self, skip: u64, m: Vec<u8>) { for (id, c) in self.clients.iter_mut() { if *id != skip { Self::send(c, m.clone()); } } }
    fn broadcast(&mut self, m: Vec<u8>) { for c in self.clients.values_mut() { Self::send(c, m.clone()); } }

    fn on_event(&mut self, ev: Ev) {
        match ev {
            Ev::Open { id, tx } => {
                let players = self.clients.values().filter(|c| c.slot >= 0).count().min(255) as u8;
                let mut c = Client { tx, slot: -1, alive: false, aspect: 1.78, last: (0., 0., 900.), sent_pc: vec![0; self.sim.maxs], sent_from: vec![0; self.sim.maxs], sent_head: vec![(0, 0, 0); self.sim.maxs],
                                     rect: Rect::EMPTY, pend: Vec::new(), npend: 0, rtt_ms: 0, chat_at: None, clk: 0, clk_lo: 0, clk_ok: false, offs: Default::default(), lates: Default::default(), jitter: -1, late_max: 0, in_seq: 0, in_tick: 0, reset: false, cap: 1024, msgs: 0 };
                let mut o = Out(Vec::new());
                o.u8(1); o.u8(self.sim.maxs as u8); o.u16(self.sim.ring as u16); o.f32(self.sim.wr); o.u8(self.sim.bots as u8); o.u8(players);
                Self::send(&mut c, o.0);
                for s in 0..self.sim.maxs { if !self.names[s].is_empty() { let m = self.name_msg(s); Self::send(&mut c, m); } }
                self.clients.insert(id, c);
            }
            Ev::Msg { id, data, at } => self.on_msg(id, &data, at),
            Ev::Close { id } => { if let Some(mut c) = self.clients.remove(&id) { self.food.resubscribe(id, c.rect, Rect::EMPTY); self.leave(&mut c); } }
        }
    }

    fn leave(&mut self, c: &mut Client) {
        if c.slot < 0 { return; }
        let s = c.slot as usize;
        unsafe { sim_remove_human(c.slot) };
        c.slot = -1; c.alive = false;
        self.names[s].clear();
        let m = self.name_msg(s); self.broadcast(m);
    }

    fn on_msg(&mut self, id: u64, d: &[u8], at: Instant) {
        let Some(mut c) = self.clients.remove(&id) else { return };
        c.msgs += 1;
        if c.msgs <= 240 && !d.is_empty() && (d.len() <= 64 || (d[0] == 7 && d.len() <= 250)) {
            match d[0] {
                1 if d.len() >= 5 => { // join / respawn
                    let aspect = (u16::from_le_bytes([d[2], d[3]]) as f32 / 1000.).clamp(0.3, 4.);
                    let len = (d[4] as usize).min(d.len() - 5);
                    if c.slot < 0 {
                        let s = unsafe { sim_add_human() };
                        if s < 0 { Self::send(&mut c, vec![7]); self.clients.insert(id, c); return; }
                        c.slot = s;
                    }
                    let s = c.slot as usize;
                    self.names[s] = clean_name(&d[5..5 + len]);
                    c.aspect = aspect;
                    unsafe { sim_set_aspect(c.slot, aspect); sim_spawn_human(c.slot, d[1] as i32); sim_set_lag(c.slot, lag_steps(c.rtt_ms)); if c.jitter >= 0 { sim_set_jitter(c.slot, c.jitter); } }
                    c.alive = true; c.sent_pc.iter_mut().for_each(|v| *v = 0);
                    let m = self.name_msg(s);
                    self.clients.insert(id, c);
                    self.broadcast(m);
                    return;
                }
                2 if d.len() >= 4 && c.slot >= 0 => {
                    let aim = u16::from_le_bytes([d[1], d[2]]) as f32 / 65535. * std::f32::consts::TAU - std::f32::consts::PI;
                    let late = if d.len() >= 7 { self.input_late(&mut c, u16::from_le_bytes([d[5], d[6]]), at) } else { 0 };
                    unsafe { sim_set_input(c.slot, aim, d[3] as i32, late) };
                    if d.len() >= 5 { c.in_seq = d[4]; c.in_tick = unsafe { sim_tick() }; } // applied by the next step
                }
                3 if d.len() >= 3 => {
                    c.aspect = (u16::from_le_bytes([d[1], d[2]]) as f32 / 1000.).clamp(0.3, 4.);
                    if c.slot >= 0 { unsafe { sim_set_aspect(c.slot, c.aspect) }; }
                }
                4 => { self.leave(&mut c); }
                7 if d.len() >= 2 && c.slot >= 0 => { // chat: joined players, one line per 1.2 s
                    let len = (d[1] as usize).min(d.len() - 2);
                    let text = clean_chat(&d[2..2 + len]);
                    if !text.is_empty() && c.chat_at.map_or(true, |t| at.duration_since(t) >= Duration::from_millis(1200)) {
                        c.chat_at = Some(at);
                        let (name, tb) = (self.names[c.slot as usize].as_bytes().to_vec(), text.into_bytes());
                        let mut o = Out(Vec::with_capacity(4 + name.len() + tb.len()));
                        o.u8(9); o.u8(c.slot as u8); o.u8(name.len() as u8); o.0.extend_from_slice(&name); o.u8(tb.len() as u8); o.0.extend_from_slice(&tb);
                        let m = o.0;
                        Self::send(&mut c, m.clone());
                        self.clients.insert(id, c);
                        self.broadcast_except(id, m);
                        return;
                    }
                }
                6 if d.len() >= 3 => {
                    c.rtt_ms = u16::from_le_bytes([d[1], d[2]]).min(1000);
                    if c.slot >= 0 { unsafe { sim_set_lag(c.slot, lag_steps(c.rtt_ms)) }; }
                }
                _ => {}
            }
        }
        self.clients.insert(id, c);
    }

    /// How many steps late this input arrived, compared with this player's normal delay:
    /// (arrival - when it was made) minus the smallest such gap seen lately. Inputs on a steady
    /// connection come out at 0, so there is nothing to make up for; a lag spike shows up here.
    /// Also keeps the player's usual lateness (90th percentile) up to date: how long the server
    /// waits, after a hit, for an input still on its way.
    fn input_late(&self, c: &mut Client, made: u16, at: Instant) -> i32 {
        c.clk = if c.clk_ok { c.clk + made.wrapping_sub(c.clk_lo) as i16 as i64 } else { made as i64 };
        c.clk_lo = made; c.clk_ok = true;
        let off = at.duration_since(self.t0).as_millis() as i64 - c.clk;
        c.offs.push_back(off); if c.offs.len() > 180 { c.offs.pop_front(); }
        let base = *c.offs.iter().min().unwrap();
        let late = (((off - base) as f32 / (1000. / 60.)).floor() as i32).clamp(0, 12); // whole steps only: arriving anywhere inside a step is normal
        c.late_max = c.late_max.max(late);
        if late > 0 && std::env::var_os("DEBUG_LATE").is_some() { eprintln!("late input: {late} steps (gap {} ms over the usual)", off - base); }
        c.lates.push_back(late as u8); if c.lates.len() > 180 { c.lates.pop_front(); }
        let mut v: Vec<u8> = c.lates.iter().copied().collect(); v.sort_unstable();
        let jitter = v[(v.len() * 9) / 10].min(9) as i32 + 1;
        if jitter != c.jitter && c.slot >= 0 { c.jitter = jitter; unsafe { sim_set_jitter(c.slot, jitter) }; }
        late
    }

    fn pick_spectate(&mut self) {
        let mut best: Option<usize> = None;
        for s in 1..=self.sim.bots {
            let p = self.sim.p(s);
            if p.alive != 0 && best.map_or(true, |b| p.mass > self.sim.p(b).mass) { best = Some(s); }
        }
        if let Some(b) = best { self.spectate = b; }
    }

}

/// Per snake, what every client's snapshot shares this update: computed once.
struct SnakeOut { hx: f32, hy: f32, reach: f32, pc: u32, n: u32, qx: i16, qy: i16, m4: u16, flags: u8, skin: u8, tier: u8 }
fn shared_snakes(sim: &Sim, out: &mut Vec<SnakeOut>, live: &mut Vec<u8>) {
    out.clear(); live.clear();
    for s in 0..sim.maxs {
        let p = sim.p(s);
        if p.alive != 0 { live.push(s as u8); } // each snapshot looks at these only
        out.push(SnakeOut { hx: p.hx, hy: p.hy, reach: p.n as f32 * p.spacing + p.r * 2. + 50., pc: p.pc, n: p.n,
                            qx: q2(p.hx), qy: q2(p.hy), m4: (p.mass * 4.).round().min(65535.) as u16,
                            flags: p.boost as u8 | if p.human != 0 { 2 } else { 0 }, skin: p.skin as u8, tier: p.tier as u8 });
    }
}

/// A food slot as sent: 2 bytes when gone, 8 when there (see the protocol).
#[inline] fn food_rec(o: &mut Vec<u8>, i: u16, w: u64, tick: u32) {
    if (w >> 32) as u8 == 0 { o.extend_from_slice(&i.to_le_bytes()); return; }
    let fresh = ((tick >> 2) as u16).wrapping_sub((w >> 48) as u16) < 10; // still fading in
    o.extend_from_slice(&(i | 0x8000).to_le_bytes());
    o.extend_from_slice(&(w as u32).to_le_bytes());                        // x, y
    o.push((w >> 32) as u8); o.push((w >> 40) as u8 | if fresh { 128 } else { 0 }); // value, skin
}

/// Returns the client's previous and new food rectangle when it changed (for the subscriber lists).
fn snapshot(sim: &Sim, food: &FoodIndex, snakes: &[SnakeOut], live: &[u8], spectate: usize, c: &mut Client, tick: u32) -> Option<(Rect, Rect)> {
        let me = c.slot;
        let alive = me >= 0 && sim.p(me as usize).alive != 0;
        let (cx, cy, cam_h) = if alive {
            let p = sim.p(me as usize);
            c.last = (p.hx, p.hy, 560. + (p.r - 12.) * 18.);
            c.last
        } else if me >= 0 { (c.last.0, c.last.1, c.last.2 * 1.6) } // dead: the client zooms out
        else { let p = sim.p(spectate); (p.hx, p.hy, 900.) };
        let (hh, hw) = (cam_h + 250., cam_h * c.aspect + 250.); // + margin for the client's smoothed camera

        let reset = c.reset;
        if reset {
            c.reset = false;
            c.sent_pc.iter_mut().for_each(|v| *v = 0);
        }
        let mut o = Out(Vec::with_capacity(c.cap));
        let kills = if me >= 0 { sim.p(me as usize).kills.min(65535) as u16 } else { 0 };
        o.u8(2); o.u32(tick); o.u8(if me >= 0 { me as u8 } else { 255 }); o.u8(spectate as u8); o.u8(reset as u8); o.u16(kills);
        o.u8(c.in_seq); o.u8(tick.wrapping_sub(c.in_tick).min(255) as u8);
        let n_at = o.0.len(); o.u8(0);
        let mut n = 0u8;
        // living snakes only: one that died and respawns comes back with a jump in its
        // point count, which sends its whole body again
        for &s in live {
            let (s, p) = (s as usize, &snakes[s as usize]);
            if s as i32 != me && ((p.hx - cx).abs() > hw + p.reach || (p.hy - cy).abs() > hh + p.reach) { c.sent_pc[s] = 0; continue; }
            let prev = c.sent_pc[s];
            // the whole body if it has nothing, fell behind (or respawned), or the body grew past the oldest point it has
            if prev == 0 || p.pc.wrapping_sub(prev) > p.n + 2 || p.pc.wrapping_sub(c.sent_from[s]) < p.n + 2 {
                let count = (p.n + 34).min(sim.ring as u32) as usize; // + margin: the client draws from ~70 ms back
                c.sent_from[s] = p.pc.wrapping_sub(count as u32);
                o.u8(s as u8); o.u8(p.flags | 4); o.u8(p.skin); o.u8(p.tier); o.i16(p.qx); o.i16(p.qy); o.u16(p.m4); o.u16(count as u16);
                let a = (p.pc.wrapping_sub(count as u32) as usize) & (sim.ring - 1);
                let pt = |k: usize| { let b = sim.trail_bytes(s, (a + k) & (sim.ring - 1), 1); (i16::from_le_bytes([b[0], b[1]]), i16::from_le_bytes([b[2], b[3]])) };
                let (mut lx, mut ly) = pt(0); o.i16(lx); o.i16(ly);
                for k in 1..count { // neighbours are one spacing apart: a byte per coordinate
                    let (x, y) = pt(k);
                    let (dx, dy) = (x.wrapping_sub(lx).clamp(-127, 127), y.wrapping_sub(ly).clamp(-127, 127));
                    o.u8(dx as i8 as u8); o.u8(dy as i8 as u8);
                    lx = lx.wrapping_add(dx); ly = ly.wrapping_add(dy);
                }
                c.sent_head[s] = (p.qx, p.qy, p.m4);
            } else { // only the head and size
                let (sx, sy, sm) = c.sent_head[s];
                let (dx, dy) = (p.qx as i32 - sx as i32, p.qy as i32 - sy as i32);
                let small = dx.abs() <= 127 && dy.abs() <= 127;
                o.u8(s as u8); o.u8(p.flags | if small { 0 } else { 8 } | if p.m4 != sm { 16 } else { 0 });
                if small { o.u8(dx as i8 as u8); o.u8(dy as i8 as u8); } else { o.i16(p.qx); o.i16(p.qy); }
                if p.m4 != sm { o.u16(p.m4); }
                c.sent_head[s] = (p.qx, p.qy, p.m4);
            }
            c.sent_pc[s] = p.pc; n += 1;
        }
        o.0[n_at] = n;

        // Food: the changes logged in its sectors since the last snapshot, then whole
        // sectors that came into view (all their food) or left it (removals).
        let m_at = o.0.len(); o.u16(0);
        let sx = |x: f32| FoodIndex::sec_x(x, sim.wr);
        let new = Rect { x0: sx(cx - hw), x1: sx(cx + hw), y0: sx(cy - hh), y1: sx(cy + hh) }; // hw, hh include a 250-unit margin
        let prev = c.rect;
        let old = if reset { Rect::EMPTY } else { prev };
        if reset { c.pend.clear(); c.npend = 0; }
        let mut m = c.npend;
        o.0.extend_from_slice(&c.pend);
        c.pend.clear(); c.npend = 0;
        if new != old { for sy in new.y0.min(old.y0)..=new.y1.max(old.y1) {
            for sxx in new.x0.min(old.x0)..=new.x1.max(old.x1) {
                let (in_new, in_old) = (new.has(sxx, sy), old.has(sxx, sy));
                if in_new == in_old { continue; }
                for &i in &food.sectors[(sy * NSEC + sxx) as usize] {
                    food_rec(&mut o.0, i, if in_new { sim.food(i as usize) } else { 0 }, tick); m += 1;
                }
            }
        } }
        c.rect = new;
        if m > 65535 { c.reset = true; m = 0; o.0.truncate(m_at + 2); } // absurd burst: resync next time
        o.patch16(m_at, m as u16);
        c.cap = (o.0.len() + 64).next_power_of_two().min(1 << 16);
        Game::send(c, o.0);
        if prev != new { Some((prev, new)) } else { None }
}

impl Game {
    fn step(&mut self) {
        // someone on the menu: the snake it shows gets food and full detail, like offline
        let menu = self.clients.values().any(|c| c.slot < 0);
        let sp = self.sim.p(self.spectate);
        unsafe { sim_set_menu_focus((menu && sp.alive != 0) as i32, sp.hx, sp.hy, 2400.) };
        let t0 = Instant::now();
        unsafe { sim_step() };
        let t1 = Instant::now();
        self.food_events();
        let tick = unsafe { sim_tick() };
        // players who just died
        let dead: Vec<u64> = self.clients.iter().filter(|(_, c)| c.slot >= 0 && c.alive && self.sim.p(c.slot as usize).alive == 0).map(|(id, _)| *id).collect();
        for id in dead {
            let c = self.clients.get_mut(&id).unwrap();
            c.alive = false;
            let p = self.sim.p(c.slot as usize);
            let kb = unsafe { sim_killed_by(c.slot) };
            let mut o = Out(Vec::new());
            o.u8(5); o.u8(if kb >= 0 { kb as u8 } else { 255 }); o.u16(p.kills.min(65535) as u16); o.f32(p.mass);
            Self::send(c, o.0);
        }
        self.spec_t += 1. / 60.;
        if self.spec_t > 8. || self.sim.p(self.spectate).alive == 0 { self.spec_t = 0.; self.pick_spectate(); }
        if tick % 2 == 0 {
            self.food_flush(tick);
            shared_snakes(&self.sim, &mut self.snakes_out, &mut self.live);
            let (sim, food, sp, sn, live) = (&self.sim, &self.food, self.spectate, &self.snakes_out, &self.live);
            // Sequential on purpose: spreading this over threads was measured slower
            // (~0.2 ms of work is less than the cost of waking them).
            let mut moved = Vec::new();
            for (id, c) in self.clients.iter_mut() { if let Some((a, b)) = snapshot(sim, food, sn, live, sp, c, tick) { moved.push((*id, a, b)); } }
            for (id, a, b) in moved { self.food.resubscribe(id, a, b); }
        }
        if tick % 15 == 0 { self.board_and_mini(tick % 30 == 0); } // board 4x, minimap 2x per second
        let t2 = Instant::now();
        self.stats.step_ns.fetch_add((t1 - t0).as_nanos() as u64, Relaxed);
        self.stats.send_ns.fetch_add((t2 - t1).as_nanos() as u64, Relaxed);
        self.stats.tick.store(tick, Relaxed);
    }

    fn board_and_mini(&mut self, with_mini: bool) {
        let sim = &self.sim;
        let mut order: Vec<usize> = (0..sim.maxs).filter(|&s| sim.p(s).alive != 0).collect();
        order.sort_unstable_by(|&a, &b| sim.p(b).mass.total_cmp(&sim.p(a).mass));
        let mut top = Out(Vec::new());
        for &s in order.iter().take(10) { let p = sim.p(s); top.u8(s as u8); top.u8(p.tier as u8); top.u8(p.skin as u8); top.u8(p.human as u8); top.f32(p.mass); }
        let mut mini = Out(Vec::with_capacity(3 + order.len() * 4));
        mini.u8(6); mini.u16(order.len() as u16);
        let b = |v: f32| ((v / sim.wr * 0.5 + 0.5) * 255.).round().clamp(0., 255.) as u8; // a byte per coordinate: plenty for the minimap
        for &s in &order {
            let p = sim.p(s);
            mini.u8(s as u8); mini.u8(b(p.hx)); mini.u8(b(p.hy));
            mini.u8(p.skin as u8 % 12 | ((p.mass.sqrt() / 4.).round().min(15.) as u8) << 4);
        }
        let n = order.len();
        for c in self.clients.values_mut() {
            let rank = if c.slot >= 0 { order.iter().position(|&s| s as i32 == c.slot).map_or(0, |r| r + 1) } else { 0 };
            let mut o = Out(Vec::with_capacity(6 + top.0.len()));
            o.u8(3); o.u16(n as u16); o.u16(rank as u16); o.u8(n.min(10) as u8); o.0.extend_from_slice(&top.0);
            Self::send(c, o.0);
            if with_mini { Self::send(c, mini.0.clone()); }
        }
        let players = self.clients.values().filter(|c| c.slot >= 0).count() as u32;
        self.stats.players.store(players, Relaxed);
        self.stats.conns.store(self.clients.len() as u32, Relaxed);
        for c in self.clients.values_mut() { c.msgs = 0; } // flood guard window: 240 messages per 0.25 s
    }
}

/* ---------------- food: sectors + change events ----------------
   The world is split into 200-unit sectors (slither.io uses 300). Each food slot is
   listed in the sector it lies in. A client subscribes to the sectors its view
   covers: entering one sends its food once; after that only the simulation's
   change events (spawned, eaten, moved) in those sectors are forwarded. Nothing
   is compared or scanned per update. */
const SEC: f32 = 200.;
const NSEC: i32 = 80; // 16000 / 200: sectors per side
const NONE: u16 = u16::MAX;

#[derive(Clone, Copy, PartialEq)]
struct Rect { x0: i32, x1: i32, y0: i32, y1: i32 }
impl Rect {
    const EMPTY: Rect = Rect { x0: NSEC, x1: -1, y0: NSEC, y1: -1 };
    #[inline] fn has(&self, x: i32, y: i32) -> bool { x >= self.x0 && x <= self.x1 && y >= self.y0 && y <= self.y1 }
}

struct FoodIndex {
    sec_of: Vec<u16>, pos: Vec<u32>, sectors: Vec<Vec<u16>>,
    dirty: Vec<u16>, is_dirty: Vec<bool>, // slots changed since the last snapshot (each once)
    sent_sec: Vec<u16>,                   // sector each slot was in at the last snapshot
    subs: Vec<Vec<u64>>,                  // per sector: the clients whose view covers it
}
impl FoodIndex {
    fn new(maxf: usize) -> Self {
        FoodIndex { sec_of: vec![NONE; maxf], pos: vec![0; maxf], sectors: vec![Vec::new(); (NSEC * NSEC) as usize],
                    dirty: Vec::new(), is_dirty: vec![false; maxf], sent_sec: vec![NONE; maxf],
                    subs: vec![Vec::new(); (NSEC * NSEC) as usize] }
    }
    #[inline] fn sec_x(x: f32, wr: f32) -> i32 { (((x + wr) / SEC) as i32).clamp(0, NSEC - 1) }
    #[inline] fn sector(w: u64, wr: f32) -> u16 {
        if (w >> 32) as u8 == 0 { return NONE; } // value 0: empty slot
        let (x, y) = (w as u16 as i16 as f32 * 0.25, (w >> 16) as u16 as i16 as f32 * 0.25);
        (Self::sec_x(y, wr) * NSEC + Self::sec_x(x, wr)) as u16
    }
    /// Client `id` now covers `new` instead of `old`: update the sector subscriber lists.
    fn resubscribe(&mut self, id: u64, old: Rect, new: Rect) {
        for y in new.y0.min(old.y0)..=new.y1.max(old.y1) {
            for x in new.x0.min(old.x0)..=new.x1.max(old.x1) {
                let (a, b) = (old.has(x, y), new.has(x, y));
                if a == b { continue; }
                let list = &mut self.subs[(y * NSEC + x) as usize];
                if b { list.push(id); } else if let Some(k) = list.iter().position(|&v| v == id) { list.swap_remove(k); }
            }
        }
    }
    /// Moves slot i to sector `new`; returns the sector it was in.
    fn place(&mut self, i: usize, new: u16) -> u16 {
        let old = self.sec_of[i];
        if old == new { return old; }
        if old != NONE { // swap-remove from the old sector's list
            let list = &mut self.sectors[old as usize];
            let p = self.pos[i] as usize;
            list.swap_remove(p);
            if p < list.len() { self.pos[list[p] as usize] = p as u32; }
        }
        if new != NONE { let list = &mut self.sectors[new as usize]; self.pos[i] = list.len() as u32; list.push(i as u16); }
        self.sec_of[i] = new;
        old
    }
}

impl Game {
    /// After every step: file this step's food changes (a pellet pulled toward a
    /// mouth changes every step; it is sent once per snapshot, in its final state).
    fn food_events(&mut self) {
        let (n, lost) = unsafe { (sim_food_event_count() as usize, sim_food_events_lost() != 0) };
        let ev = unsafe { std::slice::from_raw_parts(sim_food_events(), n) };
        let (wr, f) = (self.sim.wr, &mut self.food);
        if lost { // log overflowed: re-index everything and resync every client
            for i in 0..self.sim.maxf { let s = FoodIndex::sector(self.sim.food(i), wr); f.place(i, s); f.sent_sec[i] = s; }
            for c in self.clients.values_mut() { c.reset = true; }
        } else {
            for &i in ev {
                let i = i as usize;
                f.place(i, FoodIndex::sector(self.sim.food(i), wr));
                if !f.is_dirty[i] { f.is_dirty[i] = true; f.dirty.push(i as u16); }
            }
        }
        unsafe { sim_food_events_clear() };
    }
    /// Before the snapshots: queue each changed pellet for the clients whose
    /// sectors it was in or is now in (removal if it left their view).
    fn food_flush(&mut self, tick: u32) {
        let f = &mut self.food;
        for &i in &f.dirty {
            let iu = i as usize;
            f.is_dirty[iu] = false;
            let (new, old) = (f.sec_of[iu], f.sent_sec[iu]);
            f.sent_sec[iu] = new;
            if new == NONE && old == NONE { continue; }
            // only the clients subscribed to its sectors: usually a few, not everyone
            let w = self.sim.food(iu);
            let (nx, ny) = ((new as i32) % NSEC, (new as i32) / NSEC);
            let push = |c: &mut Client, v: u64| { food_rec(&mut c.pend, i, v, tick); c.npend += 1; };
            if new != NONE { for id in &f.subs[new as usize] { if let Some(c) = self.clients.get_mut(id) { push(c, w); } } }
            if old != NONE && old != new {
                for id in &f.subs[old as usize] {
                    if let Some(c) = self.clients.get_mut(id) { if new == NONE || !c.rect.has(nx, ny) { push(c, 0); } } // left its view
                }
            }
        }
        f.dirty.clear();
    }
}

fn game_thread(rx: smpsc::Receiver<Ev>, stats: Arc<Stats>, bots: i32) {
    let seed = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u32) | 1;
    let sim = Sim::new(seed, bots);
    let (maxs, maxf) = (sim.maxs, sim.maxf);
    let mut g = Game { t0: Instant::now(), sim, clients: HashMap::new(), names: vec![String::new(); maxs], spectate: 1, spec_t: 99., stats: stats.clone(), food: FoodIndex::new(maxf), snakes_out: Vec::new(), live: Vec::new() };
    let dt = Duration::from_nanos(1_000_000_000 / 60);
    let mut next = Instant::now();
    let mut log_t = Instant::now();
    let mut steps = 0u64;
    loop {
        while let Ok(ev) = rx.try_recv() { g.on_event(ev); }
        let now = Instant::now();
        if now < next { std::thread::sleep((next - now).min(Duration::from_millis(2))); continue; }
        if now - next > Duration::from_millis(250) { next = now; } // stalled: don't fast-forward
        g.step(); steps += 1;
        next += dt;
        if log_t.elapsed() > Duration::from_secs(std::env::var("LOG_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30)) {
            let (s, n) = (stats.step_ns.swap(0, Relaxed), stats.send_ns.swap(0, Relaxed));
            let lates: Vec<(i32, i32)> = g.clients.values().filter(|c| c.slot >= 0 && c.jitter >= 0).map(|c| (c.jitter - 1, c.late_max)).collect();
            for c in g.clients.values_mut() { c.late_max = 0; }
            println!("players {} · connections {} · sim {:.0} µs/step · network {:.0} µs/step · input lateness in steps (usual, max) {:?}",
                     stats.players.load(Relaxed), stats.conns.load(Relaxed), s as f64 / 1e3 / steps as f64, n as f64 / 1e3 / steps as f64, lates);
            steps = 0; log_t = Instant::now();
        }
    }
}

/* ---------------- HTTP + WebSocket ---------------- */

struct App { ev: Mutex<smpsc::Sender<Ev>>, next_id: AtomicU64, per_ip: Mutex<HashMap<IpAddr, u32>>, max_per_ip: u32, web_root: String, stats: Arc<Stats> }

async fn page(app: &App, file: &str) -> Response {
    match tokio::fs::read(format!("{}/{}", app.web_root, file)).await {
        Ok(b) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], b).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("{file} not found: run `./build.sh` in the repository")).into_response(),
    }
}

async fn ws_route(ws: WebSocketUpgrade, ConnectInfo(addr): ConnectInfo<SocketAddr>, headers: HeaderMap, State(app): State<Arc<App>>) -> Response {
    // behind a reverse proxy (Caddy/nginx) the real address is in X-Forwarded-For
    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()).and_then(|v| v.trim().parse().ok()).unwrap_or(addr.ip());
    {
        let mut m = app.per_ip.lock().unwrap();
        let n = m.entry(ip).or_insert(0);
        if *n >= app.max_per_ip { return (StatusCode::TOO_MANY_REQUESTS, "too many connections").into_response(); }
        *n += 1;
    }
    // small buffers: messages are tiny, and the library zero-fills its read buffer
    // on every read (a 128 KB default cost ~70% of the whole server's CPU)
    ws.max_message_size(256).read_buffer_size(512).write_buffer_size(0).on_upgrade(move |sock| connection(sock, app, ip))
}

async fn connection(sock: WebSocket, app: Arc<App>, ip: IpAddr) {
    let id = app.next_id.fetch_add(1, Relaxed);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(48);
    let pong_tx = tx.clone(); // PING is answered here, at once: the game loop's step would add to the measurement
    let _ = app.ev.lock().unwrap().send(Ev::Open { id, tx });
    let (mut sink, mut stream) = sock.split();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await { if sink.send(Message::Binary(m.into())).await.is_err() { break; } }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) if b.len() == 2 && b[0] == 5 => { let _ = pong_tx.try_send(vec![8, b[1]]); }
            Message::Binary(b) => { let _ = app.ev.lock().unwrap().send(Ev::Msg { id, data: b.to_vec(), at: Instant::now() }); }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = app.ev.lock().unwrap().send(Ev::Close { id });
    writer.abort();
    let mut m = app.per_ip.lock().unwrap();
    if let Some(n) = m.get_mut(&ip) { *n -= 1; if *n == 0 { m.remove(&ip); } }
}

fn machine_info() -> String {
    let cpu = std::fs::read_to_string("/proc/cpuinfo").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()))
        .unwrap_or_else(|| "unknown CPU".into());
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let ram = std::fs::read_to_string("/proc/meminfo").ok()
        .and_then(|s| s.lines().next().and_then(|l| l.split_whitespace().nth(1)).and_then(|k| k.parse::<f64>().ok()))
        .map(|kb| format!("{:.1} GB RAM", kb / 1048576.)).unwrap_or_default();
    format!("{cpu} × {cores} cores, {ram}")
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let bots: i32 = std::env::var("BOTS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    let web_root = std::env::var("WEB_ROOT").unwrap_or_else(|_| "../..".into());
    let stats = Arc::new(Stats::default());
    let (etx, erx) = smpsc::channel();
    { let s = stats.clone(); std::thread::Builder::new().name("game".into()).spawn(move || game_thread(erx, s, bots)).unwrap(); }
    let app = Arc::new(App { ev: Mutex::new(etx), next_id: AtomicU64::new(1), per_ip: Mutex::new(HashMap::new()),
                             max_per_ip: std::env::var("MAX_PER_IP").ok().and_then(|v| v.parse().ok()).unwrap_or(8), web_root, stats });
    let router = Router::new()
        .route("/", get(|State(a): State<Arc<App>>| async move { page(&a, "index.html").await }))
        .route("/index.html", get(|State(a): State<Arc<App>>| async move { page(&a, "index.html").await }))
        .route("/offline.html", get(|State(a): State<Arc<App>>| async move { page(&a, "offline.html").await }))
        .route("/status", get(|State(a): State<Arc<App>>| async move {
            let s = &a.stats;
            ([(header::CONTENT_TYPE, "application/json"), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
             format!("{{\"players\":{},\"connections\":{},\"tick\":{},\"version\":\"{}\"}}", s.players.load(Relaxed), s.conns.load(Relaxed), s.tick.load(Relaxed), env!("SERPENT_VERSION")))
        }))
        .route("/ws", get(ws_route))
        .with_state(app);
    println!("serpent.io server on :{port} · {bots} bots · {}", machine_info());
    let bind = std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0".into()); // 127.0.0.1 behind a reverse proxy
    let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await.expect("port in use?")
        .tap_io(|tcp| { let _ = tcp.set_nodelay(true); }); // no Nagle delay on small updates
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}
