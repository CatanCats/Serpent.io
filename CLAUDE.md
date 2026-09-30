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
Status: the owner has a server (1 CPU, 1 GB RAM, Debian 12, Caddy + systemd already running other sites; apps live in `/srv/apps/<app>`, loopback ports 8002–8005 taken, 8001 reserved). `online/deploy/deploy.sh` is ready. The last session could not reach it, because the environment's network policy blocked SSH (port 22) and the container had no `ssh` client. The owner must allow the host in the environment's network settings.
1. Get server access from the owner through session secrets or environment variables (not the repo). The key and the host address must **never** be committed. Check the network policy allows SSH to the host; install an ssh client if missing. Then run `SERPENT_HOST=... SERPENT_KEY=... online/deploy/deploy.sh`, which covers steps 2–3 below.
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
  - Software rendering has **no fast clear**, so floor savings from "clear instead of draw" never show headless (the floor reads 26–32 ms there whatever you do). Judge those by screenshots and the owner's numbers.
  - The P panel is text on the page: after pressing `p`, read it with `document.body.innerText.match(/GPU[^\n]*/)`.
- To screenshot a camera position you can't easily reach (e.g. centre of the screen outside the world), copy `offline.html` to `/tmp`, `sed` a threshold in `floorPlan` (such as `d > WR` → `d > WR - 1500`), and screenshot near the edge.
- `window.floorPlan` can be wrapped in a test to log each frame's plan (read-only; the camera is already uploaded by then).
- Shader test helper idea: evaluate `render-gl.js` + `render-gpu.js` in Node to extract the WGSL (the `FLOOR_*` constants live in `render-gl.js`), then run `naga` on both the f32 and f16 versions.
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
- Protocol: snapshots carry only each snake's head (a byte per coordinate as a Q2 delta from the last head sent to that client) and size (mass×4, only when it changed). The client (`layTrail` in `client.js`) lays body points like `moveSnake` in the simulation. A whole body goes only when a snake comes into view, respawns (its point count jumps), or a snapshot was dropped (`reset`). Keep `client.js` and the protocol comment in `main.rs` in step.
- Your own snake online is **predicted on the client** (`pred` in `client.js`): the page applies the inputs as sent, with the sim's turn rate (`5.2/(1+(r-12)*0.045)` rad/s) and speeds (195, or 430 when boosting), and lays your trail from the predicted head. INPUT carries an 8-bit seq; SNAP echoes the last seq and the steps since it arrived, so the prediction at that same moment is compared with the server head, and 30% of the gap is corrected per snapshot (a restart from the server head if the gap is over 150 units). If you change the sim's movement rules, change `predStep` too. Measured with a 240 ms round trip: the head starts turning after ~55 ms, against ~460 ms without prediction (`?predict=0` turns it off for comparison). Median gap to the server is ~3 units.
- A delay proxy for latency tests: a small Node TCP proxy that `setTimeout`s each chunk; open `/?server=ws://localhost:<proxy>/ws`.
- `pkill -f <pattern>` / `pgrep -f` kill or match the shell running the command, because the pattern is in its own command line. Find processes with `ps -eo pid,comm` instead.
- On the owner's Intel iGPU, **writing pixels** is the GPU cost, not the maths per pixel. Removing texture reads and maths from a full-screen pass saved only ~17%; not writing most pixels (fast clear) saved ~70%. Any full-screen effect (vignette, gradients) costs about 1.5 ms there. Avoid adding one.
- Game rules (both `sim.c` copies):
  - Nothing spawns in the middle (the centre zone, 35% of the world radius). Bots spawn in the ring 0.4–0.88 WR, players on the rim. `spawnRoom()` takes the first of 40 tries at least `SPAWN_GAP` (600) from every other snake's head and body, else the roomiest.
  - Only snakes of mass ≥ `MID_MASS` (200 = length 2000 on screen) are drawn to the middle. Smaller ones pick their next roam spot a little way along the ring (`homePoint(mass, hx, hy, …)`), because a far target across the map made their straight path cross the middle.
  - Measured with a native harness over 5 simulated minutes: spawns in the middle 45 → 0; spawns under 300 units from a snake 8 → 0; small snakes in the middle 37% → 0% of the time.
- Native test builds of `sim.c` need `-Dmemset=simMemset -Dmemcpy=simMemcpy`: its own `memset` calls `__builtin_memset`, which natively becomes a call to itself and hangs. Also provide `double nowMs(void)`, and drive it with `frame()` rather than `step()`.
- Graphics changes go in `src/render-*.js` only; `build.sh` puts them into both `offline.html` and `index.html`. Game-rule changes must be made in **both** `src/sim.c` and `online/server/sim-server.c`, and UI changes in both `src/app.js` and `online/client/client.js`.

## Current numbers (for comparison)
- Offline, owner's laptop (Edge, WebGPU f16, Intel iGPU): CPU per frame about 0.2 ms; GPU about 1.0 ms (floor 0.52, food 0.2, snakes 0.13, map 0.13) mid-map, measured before the flat hex lines, octagon food and minimap discards; sim benchmark 35–40 µs per step. Ask the owner for new readings, mid-map and at the world edge.
- Server, 4-core 2.1 GHz Xeon: 66 players ≈ 8% of one core, 10 MB RAM.
- Download per player (head-and-size protocol): 4.2 KB/s in a 40-player crowd, 3.3 KB/s with 5 (was 10.3 and 8.1). The load-test script must divide by seconds *and* clients (an old one printed 5× too much).
- Wall-clock server timings on the shared test container swing 2–3× between runs; compare with callgrind instruction counts instead.

## Floor design (every part one flat colour; almost nothing drawn)
- The pass clears to the floor colour (or `FLOOR_DARK` when the camera centre is outside the world). A clear is nearly free (GPUs fast-clear whole blocks). No centre glow, no vignette.
- Nothing floor-specific is uploaded: the vertex shaders work out the shapes from the Frame block. `floorPlan()` in `render-gl.js` (shared) only picks the clear colour and the hex instance count (with a row of margin, since the shader rounds its own column count).
- **No floor pixel does maths or blending.** Every shape gets one flat colour from its vertex shader.
- Hex lines: opaque quads exactly one device pixel wide (`FLOOR_BASE × FLOOR_LINE_K`). Hexes centred outside the world are skipped.
- Ring shapes by kind (instance index; WebGPU picks them with the draw's first instance, WebGL with a `uFirst` uniform), 512 segments:
  - 0: inside area (camera outside);
  - 1: thin dark ring `WR+hw..WR+32` (camera outside);
  - 2: the red edge line `WR±hw`, `FLOOR_RIM_COL`;
  - 3: darkness outside (camera inside).
- Order: 0 → hex lines → 1+2 or 2+3. The dark rings hide hex lines poking past the edge.
- History on the owner's Intel iGPU: texture tile 1.97 ms → per-vertex grid 1.64 → clear-based 0.52 → flat lighter lines 0.26 (mid-map). The edge was 1.70 ms total GPU with the old glow; now all flat, not yet re-measured. Writing pixels is the real cost.

## Other GPU details
- Food: one 4-vertex quad per pellet, halo radius `FOOD_GLOW` = 1.7 pellet radii (was 1.9). An octagon version (fewer pixels, 8 vertices) measured slower on the owner's iGPU (food 0.20 → 0.33 ms) and was reverted.
- Minimap: pixels that would add nothing are discarded (no blend), and the flat inside areas skip the edge maths.
- No dynamic resolution: the owner asked that sharpness is never lowered automatically. Only the Quality setting (Sharp / Balanced / Fast) chooses the pixel density. Don't add it back.
- GPU timing (P panel) runs on 1 frame in 8, because splitting a frame into timed passes costs CPU and GPU; the CPU figures now show normal frames.
- Headless CPU "draw" times swing ±40% between runs (software GPU), so small CPU savings can't be measured there. `T` in `app.js` (`T.gl / T.n`) is the average draw time; a test copy can expose it on `window.__serpent`.
