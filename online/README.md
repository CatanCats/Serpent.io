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
  nearby snakes with just the trail points it doesn't have yet (22-byte header each),
  and the food changes in its view.
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

Measured on a 4-core 2.1 GHz Xeon, 60 bots (each step has a 16.7 ms budget):

| players | simulation | networking | whole process | RAM | download per player |
| --- | --- | --- | --- | --- | --- |
| 8  | 0.04 ms/step | 0.03 ms/step | 4% of one core | 7 MB | ~12 KB/s |
| 50 | 0.10 ms/step | 0.16 ms/step | 11% of one core | 14 MB | ~12 KB/s |
| 66 | 0.13 ms/step | 0.27 ms/step | 13% of one core | 17 MB | ~12 KB/s |

(Before the food events: 0.9–1.4 ms/step of networking at 50–66 players.)

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
1. On the server: install Rust and a C compiler, clone the repo to `/opt/serpent`,
   run the two build commands above, create a `serpent` user.
2. `online/deploy/serpent.service` → `/etc/systemd/system/`, then `systemctl enable --now serpent`.
3. HTTPS (needed: GitHub Pages is https, so the page may only connect to `wss://`):
   install Caddy, use `online/deploy/Caddyfile` with your domain. Open ports 80 and 443.
4. Rebuild the pages with the server's address so the GitHub Pages copy connects to it:
   `SERVER_URL=wss://play.example.com/ws ./build.sh`, commit, push.
   (The page served by the game server itself always connects to its own host.)
