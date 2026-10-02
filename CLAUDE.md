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
- `index.html`: the **online** front page (on GitHub Pages it redirects to br8t.com/slither.io/), built from `online/client/` (`client.js`, `online.html`) plus the same two renderers. It connects to the game server. With no server configured it shows no message and PLAY stays disabled; the "Play offline instead" link goes to `offline.html`.
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

## The server is live
The online game is live at **https://br8t.com/slither.io/** (deployed 30 Sep 2026). The server's address and SSH key are not in the repo; the owner supplies them.
- Pages: https://br8t.com/slither.io/ (online) and https://br8t.com/slither.io/offline.html. The GitHub Pages copy is now at https://catancats.github.io/Serpent.io/ (the old `/Snake-Game/` address is gone since the repo was renamed). Its online page (`index.html`) redirects to br8t.com/slither.io/ with a script in the head that only runs on `github.io`; `offline.html` must **never** redirect.
- Search info: titles, descriptions, canonical links (the br8t.com copies) and JSON-LD are in the heads of `online/client/online.html` and `src/index.html`. br8t.com has a `robots.txt` and `sitemap.xml` (in the br8t.com home site, not this repo) listing both game pages.
- The page connects to `ws` next to itself (`wss://br8t.com/slither.io/ws`); at a site root that is still `/ws`.
- On the server (Debian 12, 1 CPU AMD EPYC Milan, 845 MB RAM, shared with other sites):
  - `serpent.service` runs `/srv/apps/serpent/serpent-server` on `127.0.0.1:8010` as user `serpent` (limits: 150 MB RAM, 60% CPU), with `index.html` and `offline.html` beside it. `serpent-server.prev` is the previous binary for rollback.
  - Caddy: inside the `br8t.com` block, `redir /slither.io /slither.io/ 308` and `handle_path /slither.io/* { reverse_proxy 127.0.0.1:8010 }`.
  - Built **on the server**, with `CC=clang` for the C simulation: source in `~deploy/serpent-src`, `cargo build --release -j1` (about 25 s after the first build). gcc, clang 14 and Rust (rustup, minimal profile) are installed for the `deploy` user; there is no wasm linker there, so the pages are built elsewhere and committed.
  - Redeploy: copy the source over, rebuild, `install` the binary and pages into `/srv/apps/serpent/`, `systemctl restart serpent`. Pages alone need no restart (read from disk per request). Check `curl https://br8t.com/slither.io/status`.
  - Measured: 60 bots with no players ≈ 13 µs per step; one viewer ≈ 100 µs per step (under 1% of the core); about 5–6 MB RAM.
- `online/deploy/deploy.sh` assumes its own domain and building locally; the live setup above differs (sub-path, built on the server).

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
  - Only snakes of mass ≥ `MID_MASS` (500 = length 5000 on screen) are drawn to the middle. Smaller ones roam the ring 0.3–0.88 WR as before; the owner asked to remove the extra code that kept them out of the middle.
  - Spawn check, measured with a native harness over 5 simulated minutes: spawns in the middle 45 → 0; spawns under 300 units from a snake 8 → 0.
- Collisions (`hitTest`, both copies): a head touching the **head end** of another snake (its newest 6 trail points) means both heads touch, so both used to die, including a player whose neck was rammed from the side. Now the snake with the larger closing speed toward the other dies, and the other is spared; equal closing speeds still kill both. Tested by placing two straight snakes and calling `hitTest` directly (call `segRebuild()` with `focX = focY = 0` first: the collision grid is a window around the focus).
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
