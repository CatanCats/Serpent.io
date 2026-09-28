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
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

/* ---------------- the simulation (C, native) ---------------- */

#[repr(C)]
#[derive(Clone, Copy)]
struct Pub { hx: f32, hy: f32, ang: f32, mass: f32, r: f32, spacing: f32, pc: u32, n: u32, alive: u32, skin: u32, tier: u32, boost: u32, kills: u32, human: u32 }

extern "C" {
    fn sim_init(seed: u32, bots: i32);
    fn sim_add_human() -> i32;
    fn sim_remove_human(s: i32);
    fn sim_spawn_human(s: i32, skin: i32);
    fn sim_set_input(s: i32, aim: f32, boost: i32);
    fn sim_set_aspect(s: i32, a: f32);
    fn sim_set_menu_focus(on: i32, x: f32, y: f32, r: f32);
    fn sim_step();
    fn sim_tick() -> u32;
    fn sim_pub() -> *const Pub;
    fn sim_trail() -> *const i16;
    fn sim_food() -> *const u64;
    fn sim_food_head() -> *const i32;
    fn sim_food_next() -> *const i32;
    fn sim_grid_n() -> i32;
    fn sim_cell() -> f32;
    fn sim_max_food() -> i32;
    fn sim_ring() -> i32;
    fn sim_max_snakes() -> i32;
    fn sim_bot_count() -> i32;
    fn sim_world_radius() -> f32;
    fn sim_killed_by(s: i32) -> i32;
}

/// Read-only views of the simulation's static memory. Only the game thread uses
/// them, and never while a sim_* call is running, so plain pointer reads are sound.
struct Sim { pubs: *const Pub, trail: *const i16, food: *const u64, fhead: *const i32, fnext: *const i32,
             maxs: usize, ring: usize, maxf: usize, bots: usize, wr: f32, gn: i32, cell: f32 }
impl Sim {
    fn new(seed: u32, bots: i32) -> Sim {
        unsafe {
            sim_init(seed, bots);
            Sim { pubs: sim_pub(), trail: sim_trail(), food: sim_food(), fhead: sim_food_head(), fnext: sim_food_next(),
                  maxs: sim_max_snakes() as usize, ring: sim_ring() as usize, maxf: sim_max_food() as usize,
                  bots: sim_bot_count() as usize, wr: sim_world_radius(), gn: sim_grid_n(), cell: sim_cell() }
        }
    }
    #[inline] fn p(&self, s: usize) -> Pub { unsafe { *self.pubs.add(s) } }
    #[inline] fn pt(&self, s: usize, pc: u32) -> (i16, i16) {
        let i = (s * self.ring + (pc as usize & (self.ring - 1))) * 2;
        unsafe { (*self.trail.add(i), *self.trail.add(i + 1)) }
    }
    #[inline] fn food(&self, i: usize) -> u64 { unsafe { *self.food.add(i) } }
    #[inline] fn cell_x(&self, x: f32) -> i32 { (((x + self.wr) / self.cell) as i32).clamp(0, self.gn - 1) }
}

/* ---------------- protocol (little-endian; mirrored in online/client/client.js) ----------------
 client -> server:  1 JOIN  u8 skin, u16 aspect*1000, u8 len, name   (also respawns)
                    2 INPUT u16 aim (-pi..pi), u8 boost
                    3 VIEW  u16 aspect*1000
                    4 LEAVE (back to the menu)
 server -> client:  1 WELCOME u8 maxSnakes, u16 ring, f32 worldRadius, u8 bots, u8 players
                    2 SNAP  u32 tick, u8 you (255 none), u8 spectate, u8 flags (1 = reset), u16 n, snakes, u16 m, food
                        snake: u8 slot, u8 flags (1 boost, 2 human, 4 full trail), u8 skin, u8 tier, f32 x, f32 y,
                               f32 ang, f32 mass, u16 n, u32 pc, u16 kills, u16 count, count x (i16 x, i16 y) in Q2
                        food:  u16 slot, 8 bytes (i16 x, i16 y, u8 value, u8 skin, u16 born); value 0 = gone
                    3 BOARD u16 alive, u16 yourRank, u8 k, k x (u8 slot, u8 tier, u8 skin, u8 human, f32 mass)
                    4 NAME  u8 slot, u8 len, name
                    5 DEATH u8 killer (255 = world edge), u16 kills, f32 mass
                    6 MINI  u16 k, k x (u8 slot, u8 skin, i16 x, i16 y, u16 mass)
                    7 FULL  (server full) */

struct Out(Vec<u8>);
impl Out {
    #[inline] fn u8(&mut self, v: u8) { self.0.push(v) }
    #[inline] fn u16(&mut self, v: u16) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn u32(&mut self, v: u32) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn i16(&mut self, v: i16) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn f32(&mut self, v: f32) { self.0.extend_from_slice(&v.to_le_bytes()) }
    #[inline] fn u64(&mut self, v: u64) { self.0.extend_from_slice(&v.to_le_bytes()) }
    fn patch16(&mut self, at: usize, v: u16) { self.0[at..at + 2].copy_from_slice(&v.to_le_bytes()) }
}

enum Ev { Open { id: u64, tx: mpsc::Sender<Vec<u8>> }, Msg { id: u64, data: Vec<u8> }, Close { id: u64 } }

struct Client {
    tx: mpsc::Sender<Vec<u8>>,
    slot: i32, alive: bool, aspect: f32,
    last: (f32, f32, f32), // last camera (x, y, half height) while alive
    sent_pc: Vec<u32>,     // per snake: trail points this client has up to
    sent_from: Vec<u32>,   // per snake: the oldest trail point it has
    shadow: Vec<u64>,      // per food slot: the record this client holds (0 = none)
    held: Vec<u16>,        // food slots this client holds
    reset: bool,           // a snapshot was dropped: resend everything
    msgs: u32,
}

#[derive(Default)]
struct Stats { players: AtomicU32, conns: AtomicU32, tick: AtomicU32, step_ns: AtomicU64, send_ns: AtomicU64 }

fn clean_name(b: &[u8]) -> String {
    let s: String = String::from_utf8_lossy(b).chars().filter(|c| !c.is_control() && !"<>&\"".contains(*c)).take(16).collect();
    let t = s.trim();
    if t.is_empty() { "Player".into() } else { t.into() }
}

/* ---------------- the game thread ---------------- */

struct Game {
    sim: Sim, clients: HashMap<u64, Client>, names: Vec<String>,
    spectate: usize, spec_t: f32, mark: Vec<u32>, gen: u32, stats: Arc<Stats>,
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
    fn broadcast(&mut self, m: Vec<u8>) { for c in self.clients.values_mut() { Self::send(c, m.clone()); } }

    fn on_event(&mut self, ev: Ev) {
        match ev {
            Ev::Open { id, tx } => {
                let players = self.clients.values().filter(|c| c.slot >= 0).count().min(255) as u8;
                let mut c = Client { tx, slot: -1, alive: false, aspect: 1.78, last: (0., 0., 900.), sent_pc: vec![0; self.sim.maxs], sent_from: vec![0; self.sim.maxs],
                                     shadow: vec![0; self.sim.maxf], held: Vec::new(), reset: false, msgs: 0 };
                let mut o = Out(Vec::new());
                o.u8(1); o.u8(self.sim.maxs as u8); o.u16(self.sim.ring as u16); o.f32(self.sim.wr); o.u8(self.sim.bots as u8); o.u8(players);
                Self::send(&mut c, o.0);
                for s in 0..self.sim.maxs { if !self.names[s].is_empty() { let m = self.name_msg(s); Self::send(&mut c, m); } }
                self.clients.insert(id, c);
            }
            Ev::Msg { id, data } => self.on_msg(id, &data),
            Ev::Close { id } => { if let Some(mut c) = self.clients.remove(&id) { self.leave(&mut c); } }
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

    fn on_msg(&mut self, id: u64, d: &[u8]) {
        let Some(mut c) = self.clients.remove(&id) else { return };
        c.msgs += 1;
        if c.msgs <= 240 && !d.is_empty() && d.len() <= 64 {
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
                    unsafe { sim_set_aspect(c.slot, aspect); sim_spawn_human(c.slot, d[1] as i32); }
                    c.alive = true; c.sent_pc.iter_mut().for_each(|v| *v = 0);
                    let m = self.name_msg(s);
                    self.clients.insert(id, c);
                    self.broadcast(m);
                    return;
                }
                2 if d.len() >= 4 && c.slot >= 0 => {
                    let aim = u16::from_le_bytes([d[1], d[2]]) as f32 / 65535. * std::f32::consts::TAU - std::f32::consts::PI;
                    unsafe { sim_set_input(c.slot, aim, d[3] as i32) };
                }
                3 if d.len() >= 3 => {
                    c.aspect = (u16::from_le_bytes([d[1], d[2]]) as f32 / 1000.).clamp(0.3, 4.);
                    if c.slot >= 0 { unsafe { sim_set_aspect(c.slot, c.aspect) }; }
                }
                4 => { self.leave(&mut c); }
                _ => {}
            }
        }
        self.clients.insert(id, c);
    }

    fn pick_spectate(&mut self) {
        let mut best: Option<usize> = None;
        for s in 1..=self.sim.bots {
            let p = self.sim.p(s);
            if p.alive != 0 && best.map_or(true, |b| p.mass > self.sim.p(b).mass) { best = Some(s); }
        }
        if let Some(b) = best { self.spectate = b; }
    }

    /// One client's snapshot: nearby snakes (only trail points it lacks) and food diffs in view.
    fn snapshot(&mut self, id: u64, tick: u32) {
        let sim = &self.sim;
        let c = self.clients.get_mut(&id).unwrap();
        let me = c.slot;
        let alive = me >= 0 && sim.p(me as usize).alive != 0;
        let (cx, cy, cam_h) = if alive {
            let p = sim.p(me as usize);
            c.last = (p.hx, p.hy, 560. + (p.r - 12.) * 18.);
            c.last
        } else if me >= 0 { (c.last.0, c.last.1, c.last.2 * 1.6) } // dead: the client zooms out
        else { let p = sim.p(self.spectate); (p.hx, p.hy, 900.) };
        let (hh, hw) = (cam_h + 250., cam_h * c.aspect + 250.); // + margin for the client's smoothed camera

        let reset = c.reset;
        if reset {
            c.reset = false;
            for &i in &c.held { c.shadow[i as usize] = 0; }
            c.held.clear();
            c.sent_pc.iter_mut().for_each(|v| *v = 0);
        }
        let mut o = Out(Vec::with_capacity(16 * 1024));
        o.u8(2); o.u32(tick); o.u8(if me >= 0 { me as u8 } else { 255 }); o.u8(self.spectate as u8); o.u8(reset as u8);
        let n_at = o.0.len(); o.u16(0);
        let mut n = 0u16;
        for s in 0..sim.maxs {
            let p = sim.p(s);
            if p.alive == 0 { c.sent_pc[s] = 0; continue; }
            let reach = p.n as f32 * p.spacing + p.r * 2. + 50.;
            if s as i32 != me && ((p.hx - cx).abs() > hw + reach || (p.hy - cy).abs() > hh + reach) { c.sent_pc[s] = 0; continue; }
            let prev = c.sent_pc[s];
            let (mut full, mut count) = (0u8, p.pc.wrapping_sub(prev));
            // full resend if it has nothing, fell behind, or the body grew past the oldest point it has
            if prev == 0 || count > p.n + 2 || p.pc.wrapping_sub(c.sent_from[s]) < p.n + 2 {
                full = 4; count = (p.n + 34).min(sim.ring as u32); // + margin: the client draws from ~70 ms back
                c.sent_from[s] = p.pc.wrapping_sub(count);
            }
            o.u8(s as u8); o.u8(p.boost as u8 | if p.human != 0 { 2 } else { 0 } | full); o.u8(p.skin as u8); o.u8(p.tier as u8);
            o.f32(p.hx); o.f32(p.hy); o.f32(p.ang); o.f32(p.mass);
            o.u16(p.n as u16); o.u32(p.pc); o.u16(p.kills.min(65535) as u16); o.u16(count as u16);
            let mut q = p.pc.wrapping_sub(count);
            while q != p.pc { let (x, y) = sim.pt(s, q); o.i16(x); o.i16(y); q = q.wrapping_add(1); }
            c.sent_pc[s] = p.pc; n += 1;
        }
        o.patch16(n_at, n);

        // Food: only cells the view overlaps (plus what the client already holds).
        // A record is 8 bytes, so "changed?" is a single 64-bit compare.
        let m_at = o.0.len(); o.u16(0);
        let mut m = 0u32;
        self.gen = self.gen.wrapping_add(1);
        let gen = self.gen;
        let (fx0, fx1, fy0, fy1) = (((cx - hw - 100.) * 4.) as i32, ((cx + hw + 100.) * 4.) as i32, ((cy - hh - 100.) * 4.) as i32, ((cy + hh + 100.) * 4.) as i32);
        let visible = |w: u64| {
            let (x, y, v) = (w as u16 as i16 as i32, (w >> 16) as u16 as i16 as i32, (w >> 32) as u8);
            v != 0 && x > fx0 && x < fx1 && y > fy0 && y < fy1
        };
        let mut held = std::mem::take(&mut c.held);
        held.retain(|&i| {
            let i = i as usize;
            let w = sim.food(i);
            if visible(w) {
                self.mark[i] = gen;
                if w != c.shadow[i] && m < 60000 { c.shadow[i] = w; o.u16(i as u16); o.u64(w); m += 1; }
                true
            } else {
                c.shadow[i] = 0; o.u16(i as u16); o.u64(0); m += 1;
                false
            }
        });
        let (gx0, gx1, gy0, gy1) = (sim.cell_x(cx - hw - 100.), sim.cell_x(cx + hw + 100.), sim.cell_x(cy - hh - 100.), sim.cell_x(cy + hh + 100.));
        'cells: for gy in gy0..=gy1 {
            for gx in gx0..=gx1 {
                let mut i = unsafe { *sim.fhead.add((gy * sim.gn + gx) as usize) };
                let mut guard = 0;
                while i >= 0 && guard < 4096 {
                    let iu = i as usize;
                    if self.mark[iu] != gen {
                        self.mark[iu] = gen;
                        let w = sim.food(iu);
                        if c.shadow[iu] == 0 && visible(w) {
                            if m >= 60000 { break 'cells; }
                            c.shadow[iu] = w; held.push(iu as u16); o.u16(iu as u16); o.u64(w); m += 1;
                        }
                    }
                    i = unsafe { *sim.fnext.add(iu) };
                    guard += 1;
                }
            }
        }
        c.held = held;
        o.patch16(m_at, m as u16);
        Self::send(c, o.0);
    }

    fn step(&mut self) {
        // someone on the menu: the snake it shows gets food and full detail, like offline
        let menu = self.clients.values().any(|c| c.slot < 0);
        let sp = self.sim.p(self.spectate);
        unsafe { sim_set_menu_focus((menu && sp.alive != 0) as i32, sp.hx, sp.hy, 2400.) };
        let t0 = Instant::now();
        unsafe { sim_step() };
        let t1 = Instant::now();
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
            let ids: Vec<u64> = self.clients.keys().copied().collect();
            for id in ids { self.snapshot(id, tick); }
        }
        if tick % 15 == 0 { self.board_and_mini(); }
        let t2 = Instant::now();
        self.stats.step_ns.fetch_add((t1 - t0).as_nanos() as u64, Relaxed);
        self.stats.send_ns.fetch_add((t2 - t1).as_nanos() as u64, Relaxed);
        self.stats.tick.store(tick, Relaxed);
    }

    fn board_and_mini(&mut self) {
        let sim = &self.sim;
        let mut order: Vec<usize> = (0..sim.maxs).filter(|&s| sim.p(s).alive != 0).collect();
        order.sort_unstable_by(|&a, &b| sim.p(b).mass.total_cmp(&sim.p(a).mass));
        let mut top = Out(Vec::new());
        for &s in order.iter().take(10) { let p = sim.p(s); top.u8(s as u8); top.u8(p.tier as u8); top.u8(p.skin as u8); top.u8(p.human as u8); top.f32(p.mass); }
        let mut mini = Out(Vec::with_capacity(3 + order.len() * 8));
        mini.u8(6); mini.u16(order.len() as u16);
        for &s in &order {
            let p = sim.p(s);
            mini.u8(s as u8); mini.u8(p.skin as u8);
            mini.i16((p.hx / sim.wr * 32767.) as i16); mini.i16((p.hy / sim.wr * 32767.) as i16); mini.u16(p.mass.min(65535.) as u16);
        }
        let n = order.len();
        for c in self.clients.values_mut() {
            let rank = if c.slot >= 0 { order.iter().position(|&s| s as i32 == c.slot).map_or(0, |r| r + 1) } else { 0 };
            let mut o = Out(Vec::with_capacity(6 + top.0.len()));
            o.u8(3); o.u16(n as u16); o.u16(rank as u16); o.u8(n.min(10) as u8); o.0.extend_from_slice(&top.0);
            Self::send(c, o.0);
            Self::send(c, mini.0.clone());
        }
        let players = self.clients.values().filter(|c| c.slot >= 0).count() as u32;
        self.stats.players.store(players, Relaxed);
        self.stats.conns.store(self.clients.len() as u32, Relaxed);
        for c in self.clients.values_mut() { c.msgs = 0; } // flood guard window: 240 messages per 0.25 s
    }
}

fn game_thread(rx: smpsc::Receiver<Ev>, stats: Arc<Stats>, bots: i32) {
    let seed = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u32) | 1;
    let sim = Sim::new(seed, bots);
    let (maxs, maxf) = (sim.maxs, sim.maxf);
    let mut g = Game { sim, clients: HashMap::new(), names: vec![String::new(); maxs], spectate: 1, spec_t: 99., mark: vec![0; maxf], gen: 0, stats: stats.clone() };
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
            println!("players {} · connections {} · sim {:.0} µs/step · network {:.0} µs/step",
                     stats.players.load(Relaxed), stats.conns.load(Relaxed), s as f64 / 1e3 / steps as f64, n as f64 / 1e3 / steps as f64);
            steps = 0; log_t = Instant::now();
        }
    }
}

/* ---------------- HTTP + WebSocket ---------------- */

struct App { ev: Mutex<smpsc::Sender<Ev>>, next_id: AtomicU64, per_ip: Mutex<HashMap<IpAddr, u32>>, max_per_ip: u32, web_root: String, stats: Arc<Stats> }

async fn page(app: &App, file: &str) -> Response {
    match tokio::fs::read(format!("{}/{}", app.web_root, file)).await {
        Ok(b) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], b).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, format!("{file} not found: run `node build.mjs` in the repository")).into_response(),
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
    ws.max_message_size(256).on_upgrade(move |sock| connection(sock, app, ip))
}

async fn connection(sock: WebSocket, app: Arc<App>, ip: IpAddr) {
    let id = app.next_id.fetch_add(1, Relaxed);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(48);
    let _ = app.ev.lock().unwrap().send(Ev::Open { id, tx });
    let (mut sink, mut stream) = sock.split();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await { if sink.send(Message::Binary(m.into())).await.is_err() { break; } }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(b) => { let _ = app.ev.lock().unwrap().send(Ev::Msg { id, data: b.to_vec() }); }
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
             format!("{{\"players\":{},\"connections\":{},\"tick\":{}}}", s.players.load(Relaxed), s.conns.load(Relaxed), s.tick.load(Relaxed)))
        }))
        .route("/ws", get(ws_route))
        .with_state(app);
    println!("serpent.io server on :{port} · {bots} bots · {}", machine_info());
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("port in use?");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
}
