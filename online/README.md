# Serpent.io online

Many people play together in one world, with the same rules and bots as the
offline game. The server runs the world; each player's browser only draws it.

```
online/
  server/            the game server
    sim-server.c     the simulation: a copy of src/sim.c (same rules), extended for many
                     players; compiled to native code and linked into the server
    src/main.rs      Rust: 60 Hz game loop, WebSockets, serves the pages
  client/            the online page (built into /index.html by `node build.mjs`)
    client.js        receives the world and feeds it to the offline game's renderers
  deploy/            systemd service + Caddy (HTTPS) config
```

## How it works
- **One game thread** steps the C simulation at a fixed 60 Hz. Around every player
  there is full detail (collisions, eating, bot AI); bots far from everyone use the
  offline game's cheap statistical model, so cost grows with players, not map size.
- **Every 2 steps (30 Hz)** each client gets a binary snapshot of only what is near it:
  nearby snakes with just the trail points it doesn't have yet, and food that changed
  in its view (a food record is 8 bytes, so "changed?" is one 64-bit compare).
- **Networking** is async Rust (tokio + axum). A client that can't keep up is resynced
  instead of queueing a backlog.
- **The browser** draws ~70 ms in the past and interpolates between snapshots, so
  movement is smooth at any refresh rate, using the offline game's WebGPU/WebGL renderers.

Measured on a 4-core 2.1 GHz Xeon, 60 bots:

| players | simulation | networking | whole process | download per player |
| --- | --- | --- | --- | --- |
| 8  | 0.04 ms/step | 0.1 ms/step | 4% of one core | ~13–16 KB/s |
| 50 | 0.1 ms/step  | 0.9 ms/step | 15% of one core | ~13–16 KB/s |
| 68 (full) | 0.12 ms/step | 1.4 ms/step | 24% of one core | ~13–16 KB/s |

## Run it
```sh
node build.mjs                       # builds /index.html (online) and /offline.html
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
   `SERVER_URL=wss://play.example.com/ws node build.mjs`, commit, push.
   (The page served by the game server itself always connects to its own host.)
