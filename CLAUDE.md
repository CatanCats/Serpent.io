# Notes for the next session (serpent.io)

Read this first. It sums up the project and where it stands so you don't have to rediscover it.

## Owner's preferences
- Work on **`main` only**: no branches, no pull requests unless asked. Commit and push when a change is done and tested.
- The owner cares a lot about speed (CPU, GPU and RAM). Measure before and after; report real numbers; say so when something did not help.
- Explain things in plain words. The owner often tests on Windows + Edge with Intel integrated graphics.
- **Never commit secrets** (server passwords, SSH keys, tokens). The repo is public. Server access must come from environment variables or secrets in the session settings, never from files in the repo or pasted chat text.

## What exists
- `offline.html`: the original game, fully on the player's device. Built from `src/`:
  - `sim.c` → WebAssembly (the whole simulation),
  - `app.js` (UI and main loop),
  - `render-gpu.js` (WebGPU) and `render-gl.js` (WebGL 2).
- `index.html`: the **online** front page, built from `online/client/` (`client.js`, `online.html`) plus the same two renderers. It connects to the game server. With no server configured it shows no message and PLAY stays disabled; the "Play offline instead" link goes to `offline.html`.
- `online/server/`: the game server, in Rust (tokio + axum WebSockets). `sim-server.c` is a copy of `src/sim.c` with the same rules, extended for many human players, and compiled natively by `build.rs`.
  - Protocol: documented at the top of `src/main.rs`, and mirrored in `online/client/client.js`.
- `online/deploy/`: a systemd unit (`serpent.service`) and a Caddy config (HTTPS).
- `online/README.md`: how it works, measured numbers, how to run and deploy.

## Build and run
```sh
./build.sh                                    # needs bash + clang (wasm32 target) → offline.html + index.html
SERVER_URL=wss://your.domain/ws ./build.sh    # makes the GitHub Pages copy of index.html connect there
cd online/server && cargo build --release     # needs Rust + a C compiler
WEB_ROOT=../.. ./target/release/serpent-server   # http://localhost:8080 serves index.html, offline.html, /ws, /status
```
Server environment variables: `PORT` (8080), `BOTS` (60), `WEB_ROOT`, `MAX_PER_IP` (8), `LOG_SECS` (30). At startup it prints the CPU model, core count and RAM.

## Next job: put the server online
1. Get server access from the owner through session secrets or environment variables (not the chat, not the repo). Check the network policy allows SSH to the host.
2. On the server:
   - install Rust and a C compiler;
   - clone the repo to `/opt/serpent`;
   - run `./build.sh`;
   - run `cargo build --release` in `online/server`;
   - create a `serpent` user;
   - install `online/deploy/serpent.service`.
3. HTTPS is required, because GitHub Pages is https and the page may only use `wss://`. Use Caddy with `online/deploy/Caddyfile` and a domain, or `<ip-with-dashes>.sslip.io` if there's no domain. Open ports 80 and 443.
4. Rebuild the pages with `SERVER_URL=wss://<domain>/ws ./build.sh`, then commit and push. The live site is https://catancats.github.io/Snake-Game/ (the repo may show as CatanCats/Serpent.io).
5. Tell the owner the server's CPU and RAM (the server prints them at startup) and the load numbers it logs.

## Testing (the tools are not in the repo; recreate as needed)
- Browser tests: Playwright from `/opt/node22/lib/node_modules/playwright`, with Chromium at `/opt/pw-browsers`.
  - WebGPU in headless Chromium: `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --use-angle=swiftshader --disable-vulkan-surface`.
  - Without those flags there is no WebGPU adapter, and the game shows its "WebGPU isn't working" screen. Open pages with `?renderer=webgl` in WebGL tests.
- SwiftShader has **no shader-f16**, so the WebGPU f16 shader path never runs in these tests. Validate the WGSL with `naga` (`cargo install naga-cli`) for both the f16 and f32 variants.
- Headless GPU times come from software rendering. They're useful to compare passes against each other, not as absolute numbers. Real numbers come from the owner's P panel.
- CPU profiling: `valgrind --tool=callgrind`.
  - For the WebAssembly simulation, compile `src/sim.c` natively with a small `main`.
  - For the server, build with `SERPENT_PORTABLE=1` (valgrind can't run the AVX-512 code from `-march=native`) and dump with `callgrind_control -d <pid>`.
- Load test: many WebSocket clients sending JOIN and INPUT. Set `MAX_PER_IP` high for local tests.

## Pitfalls already hit (don't repeat)
- **Never put a `//` comment in the middle of a line** in JS or shader strings. Twice it silently commented out code: once the online client's culling check, once the WebGL food colour lookup. Run `node --check` on JS and look at the result.
- The per-snake snapshot record the offline page reads (`Snap` in `sim.c`) is 8 floats: alive, x, y, mass, skin, tier, near, kills. `app.js` uses `SN = 8`.
- Edge's "Enhance your security on the web" (default level: Balanced) can turn off the JS/WebAssembly optimizer **and WebGPU** for less-visited sites. The game detects this and tells the player how to add an exception. That was the cause of "WebGPU switches to WebGL" and of a 30× slower simulation.
- WebSocket read buffers must stay small (`read_buffer_size(512)`): the library zero-fills its buffer on every read, and at 128 KB that was about 70% of the server's CPU.
- Building snapshots on several threads (rayon) was measured **slower** at this scale; it's deliberately single-threaded.

## Current numbers (for comparison)
- Offline, owner's laptop (Edge, WebGPU f16, Intel iGPU): CPU per frame about 0.2 ms; GPU about 1.0 ms (floor 0.52, food 0.2, snakes 0.13, map 0.13) mid-map; sim benchmark 35–40 µs per step.
- Server, 4-core 2.1 GHz Xeon: 66 players ≈ 8% of one core, 10 MB RAM, about 12 KB/s per player.

## Floor design (clear + only what differs)
- `floorPlan()` in `render-gl.js` is shared by both renderers. It picks the clear colour, which glow shapes are on screen, the hex range and the line fade.
- The pass clears to the floor colour, or to base + centre glow when the whole screen is inside the glow's flat middle. A clear is nearly free (GPUs fast-clear whole blocks).
- Inside and outside the world are each one flat colour. Whichever side holds the camera centre is the clear colour; the other side is drawn flat (no per-pixel maths), and only when it is on screen.
- Then, only when on screen: the centre-glow disc and the thin world-edge glow band (both opaque, exact per-pixel shading). Last come the hex outlines as instanced quads, multiply-blended.
- History: texture tile 1.97 ms → per-vertex grid 1.64 ms → clear-based 0.52 ms (mid-map; it was slower near the edge until the outside area became flat) on the owner's Intel iGPU (the grid still wrote every pixel; writing pixels was the real cost). The screen-edge vignette was dropped for this, because it touched every pixel.
