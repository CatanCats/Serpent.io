# Serpent.io online

Many people play together in one world, with the same rules and bots as the
offline game. The server runs the world; each player's browser only draws it.

```
online/
  server/            the game server
    sim-server.c     the simulation: a copy of src/sim.c (same rules), extended for many
                     players; compiled to native code and linked into the server
    src/main.rs      Rust: 60 Hz game loop, WebSockets, serves the pages
  client/            the online page (built into /index.html by `./build.sh`)
    client.js        receives the world and feeds it to the offline game's renderers
  deploy/            systemd service + Caddy (HTTPS) config
```

## How it works
- **One game thread** steps the C simulation at a fixed 60 Hz. Around every player
  there is full detail (collisions, eating, bot AI); bots far from everyone use the
  offline game's cheap statistical model, so cost grows with players, not map size.
- **Every 2 steps (30 Hz)** each client gets a binary snapshot of only what is near it:
  for each nearby snake only its **head and size**, 4-6 bytes (a head move in bytes, the size
  when it changed), and the food changes in its view. The browser lays the body points
  along the head's path itself, exactly as the simulation does; a snake's whole body is
  sent once, when it comes into view (a byte per coordinate from point to point).
- **Food** changes are 8 bytes (added) or 2 bytes (gone); the minimap is 4 bytes per
  snake, twice a second.
- **Food is event-driven, not compared.** The simulation logs every pellet that spawns,
  is eaten or moves. The server files pellets into 200-unit sectors (slither.io uses 300);
  a client subscribed to the sectors its view covers gets a sector's food once when it
  comes into view, then only the logged changes in it, each pellet at most once per
  snapshot. Food cells in the simulation are exact lists too, so nothing ever checks
  "is this pellet still here?".
- **Networking** is async Rust (tokio + axum). A client that can't keep up is resynced
  instead of queueing a backlog.
- **The browser** draws ~70 ms in the past and interpolates between snapshots, so
  movement is smooth at any refresh rate, using the offline game's WebGPU/WebGL renderers.
- **Delay compensation:** the page measures its round trip with tiny pings when it connects
  and every 4 s, and tells the server. When judging whether *you* crashed, the server ignores the
  part of other snakes that was laid too recently to be on your screen yet, given your delay.
- **Lag spikes don't kill you:** each input carries the time it was made, so the server sees
  how late each one arrives compared with your usual delay. If you hit a snake, it waits a moment
  for late inputs and replays your last steps with them on time; if that path is clear, you
  live. Inputs that arrived on time are never moved, so turning after a hit doesn't help.
- **Your own snake is predicted** in the browser (same turning and speed rules as the
  simulation), so it turns the moment you move the mouse instead of a round trip plus
  ~70 ms later; the server stays in charge and the prediction is corrected smoothly
  toward it. With a 240 ms round trip, turning starts after ~55 ms instead of ~460 ms.

Measured on a 4-core 2.1 GHz Xeon, 60 bots (each step has a 16.7 ms budget):

| players | simulation | networking (game thread) | whole process | RAM | download per player |
| --- | --- | --- | --- | --- | --- |
| 8  | 0.05 ms/step | 0.03 ms/step | 4% of one core | 7 MB | ~12 KB/s |
| 50 | 0.11 ms/step | 0.10 ms/step | 8% of one core | 9 MB | ~12 KB/s |
| 66 | 0.12 ms/step | 0.16 ms/step | 8% of one core | 10 MB | ~12 KB/s |

Download per player after the "head and size only" protocol (load test, bots steering
randomly, 5% boosting): **4.2 KB/s** with 40 players crowded together (was 10.3 KB/s),
**3.3 KB/s** with 5 (was 8.1). Snake data went from 3.6 to 0.9 KB/s; most of what is left
is food appearing (1.8 KB/s) and the minimap.

Notable wins, each measured: food as events instead of comparisons (networking
1.2-1.4 -> 0.27 ms/step), per-sector subscriber lists, shared snake headers with
trail points copied as raw bytes, grid-based food counting, and small WebSocket
read buffers (the library zero-filled a 128 KB buffer on every read: ~70% of all
server CPU). Building snapshots on several threads was measured slower and is not used.

## Run it
```sh
./build.sh                           # builds /index.html (online) and /offline.html
cd online/server
cargo build --release                # needs Rust (rustup.rs) and a C compiler
WEB_ROOT=../.. ./target/release/serpent-server   # http://localhost:8080
```
Settings (environment): `PORT` (8080), `BOTS` (60), `WEB_ROOT` (folder with index.html),
`MAX_PER_IP` (8 connections per address), `LOG_SECS` (30). `GET /status` returns players online.

## Deploy
`online/deploy/deploy.sh` does all of this on a Debian box that already runs Caddy:
builds a portable binary here, copies it to `/srv/apps/serpent/`, installs the systemd unit
(bound to 127.0.0.1, memory- and CPU-capped), adds a Caddy site block (validated, with the
old file restored if it fails) and checks `/status`. The host and key come from the
environment (`SERPENT_HOST`, `SERPENT_KEY`, optional `SERPENT_DOMAIN`, `SERPENT_PORT`),
never from the repository.

By hand:
1. On the server: install Rust and a C compiler, clone the repo to `/opt/serpent`,
   run the two build commands above, create a `serpent` user.
2. `online/deploy/serpent.service` → `/etc/systemd/system/`, then `systemctl enable --now serpent`.
3. HTTPS (needed: GitHub Pages is https, so the page may only connect to `wss://`):
   install Caddy, use `online/deploy/Caddyfile` with your domain. Open ports 80 and 443.
4. Rebuild the pages with the server's address so the GitHub Pages copy connects to it:
   `SERVER_URL=wss://play.example.com/ws ./build.sh`, commit, push.
   (The page served by the game server itself always connects to its own host.)
