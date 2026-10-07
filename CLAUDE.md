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
  - **Automatic deploy:** `.github/workflows/deploy.yml` runs on every push to main that touches `online/server/**` or the pages (or by hand: Actions → Deploy → Run workflow). It needs repository secrets `SERPENT_HOST` (`deploy@<address>`) and `SERPENT_SSH_KEY`; without them it only warns. It checks the host key fingerprint, uploads the source and pages, builds in `~/serpent-src` (`CC=clang`, `-j1`), keeps `serpent-server.prev`, restarts, and rolls back if `/status` doesn't report the new version. Tested here against a fake home folder and a stand-in for `systemctl`.
  - `/status` includes `"version"` (the commit; `build.rs` reads `SERPENT_VERSION` or `git rev-parse`). Use it to see whether the live server has the latest fixes.
  - Redeploy by hand: copy the source over, rebuild, `install` the binary and pages into `/srv/apps/serpent/`, `systemctl restart serpent`. Pages alone need no restart (read from disk per request). Check `curl https://br8t.com/slither.io/status`.
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
- **Delay compensation** (online): when the page connects it sends 5 PINGs (type 5), then one every 4 s. The connection task answers each at once with PONG (8), not via the game loop. The page sends the median of the last 5 round trips as DELAY (6, u16 ms) when it changes by more than 8 ms, and on every join. The server turns that into `lag_steps = rtt × 0.06 + 5` (round trip in steps + INTERP 4 + half a snapshot) and calls `sim_set_lag`. In `hitTest` for a human, another snake's points laid within that many steps (`lag × DT × speed / spacing + 1`) don't count: they weren't on the player's screen yet. Bots' own tests are unchanged, so a bot that rams you still dies. Capped at 24 steps. Tested by placing snakes in `sim-server.c` (`human[0] = 1`; its grid covers the whole world, so `syncBody()` after placing). With 100 ms ping, a snake that crossed 3 points ago no longer kills you; one that crossed 17 points ago still does. Headless Chromium measures about 100 ms too high, because its main thread is slow under software rendering; Node measures the true value.
- The online P panel shows `ping`. The page reports the **fastest** of the last 5 round trips (never too high), not the median.
- **Prediction (page) must match the server exactly**, or the snake gets pulled sideways:
  - fixed 1/60 s steps with moveSnake's rotation series (a long frame runs several steps), drawn ahead by the leftover fraction (`predShown`);
  - boost mass drain predicted (`pred.m`). It stops when the server already has the boost press (`boostSeq` acked) but reports not boosting;
  - comparisons skipped while a newer input is still in flight (a stall);
  - big gaps closed in place, never by jumping to the (older) server head; the start is placed a round trip ahead.
  - Measured with a 120 ms link plus 150 ms stalls every 3 s: largest gap 40–127 units → ~22, median ~3 (`window.__predLog` collects comparisons for tests). What remains: boosting right at mass 14, where eating decides.
- Server env `DEBUG_LATE=1` prints every input measured late.
- **Chat (online):**
  - CHAT messages: client→server 7 `u8 len, text`; server→client 9 `u8 slot, u8 namelen, name, u8 len, text`, to everyone.
  - Joined players only, one line per 1.2 s, at most 80 characters and 240 bytes, control characters removed. The on_msg size limit allows type 7 up to 250 bytes.
  - The page shows the last 6 lines, which fade after 10 s. Under the chat are two buttons: "💬 Chat" opens/closes the box (Enter does too, and opening un-hides), and "Hide"/"Show" hides or shows the messages, remembered in `serpent.chat`. The box has a Send button on every device (the owner asked for one); Enter sends, Esc closes. The input stops key events, so typing never steers. Text is inserted as text nodes, never as HTML.
  - The page keeps its own 1.25 s gap (says "One message per second") and, since the server echoes every line to its writer, shows "The server didn't answer: it may need updating" if no echo comes within 3 s (an older server ignores type 7). The first "chat doesn't work" report was the live server not yet redeployed plus 💬 only hiding the chat.
- **Leaderboard (both pages):** whole **snake names** always (no ellipsis; the board grows to fit). The owner's "whole names" meant the snake's name, not the level. The level tag: full name (ROOKIE…LEGEND, PLAYER, YOU) on computers, and on phones/touch screens once the board is at full size or bigger; below that on phones/touch it is one coloured letter (`#board.short`, set in JS from `(max-width: 640px), (hover: none)` and scale < 1). The span carries both in `data-l` / `data-s`; CSS `::after { content: attr(...) }` picks one. Size: − / + in the title (±0.1) or drag the grip at the board's bottom-left corner; `--lbs` with `transform: scale`, 0.6–1.5, remembered in `serpent.lbscale`; phones start at 0.8.
- **Keyboard steering (both pages):**
  - The keys aim relative to the snake's **current** heading: `aim = heading ± 0.6` while a key is held, `= heading` when released. Offline the heading comes from `W.playerAng()` (export), online from `pred.a`.
  - The old rule (`aim += keyTurn × dt × 4.2`) ran ahead of big snakes, which turn slower: a head radius of 40 turns at 2.3 rad/s. More than half a turn ahead, the snake turned the other way: 29 of 180 steps while holding Left.
  - The mouse takes over only after a real move of more than 6 px from where it was when the keys took over. Browsers send `pointermove` with no movement when the page changes under the cursor.
  - Both arrow keys are tracked (`keysDown`).
  - Browser test: hold, release, fake move, key swap, real mouse — all correct offline and online. Through a 120 ms link with stalls, the prediction gap is ~5 units median and ~21 max.
- **Late-input rescue** (`rescue()` in `sim-server.c`; lateness measured in `input_late` in `main.rs`):
  - Because the page predicts its own snake, an input arriving with the player's usual delay is **on time**. Never move on-time inputs: the first version moved every input back by the ping, and players slipped through the backs of snakes by turning just after hitting them.
  - INPUT carries the page's clock in ms (u16). For each input the server computes (arrival − made) minus the smallest such gap over the last 180 inputs: its lateness in **whole** steps (floor, not round: arriving anywhere inside a step is normal), 0–12. It passes that to `sim_set_input(s, aim, boost, late)`. The 90th percentile + 1 is the player's grace (`sim_set_jitter`, 1–10 steps).
  - `hist[s][tick & 31]` records, before each move: head, heading, pc, and the input in effect. `inLog[s]` (64 entries) records **every** input: the step it took effect, its lateness, aim, boost, pc. Several inputs can arrive in one step after a stall; keeping only the last one per step lost the ones that mattered.
  - A late input is applied **at once** at its meant step (`rescue(s, 1)` when one arrives, if the path is clear), not only on a hit. Otherwise the server stays on the late path and the page pulls your snake sideways. A replay that moves the head under 10 units doesn't bump pc (no full-body resend).
  - On a hit (not the world edge), the death waits the grace. Each step, `rescue` replays from the earliest step a late input was meant for (window ≥ waited + 13, ≤ 30). The input in effect at step t is the arrived input whose meant step (arrival − late) is the latest ≤ t. Only if that changes some input, and the dry-run head path (`hitAt`) is clear, does it commit:
    - `unlinkBody`, restore, `moveSnake` W times with mass and boost food held, rewriting `hist` positions;
    - then `pc += RING`, so clients take the whole new body.
  - A snake that died hitting a rescued player's old position is re-checked. Mutual hits (head-on) get no grace, and delay compensation is off when the two heads touch.
  - The server log prints each player's input lateness in steps (usual, max).
- Test suite (recreate in `/tmp/simtest`; one process per scenario): `#include "sim-server.c"`, place snakes, `sim_step`, plus a grid consistency check (linked = `pc − tail` = `n`).
  - In tests, never let a later-made input arrive before a late one: messages arrive in order.
  - Results (2 Oct): last safe turn at no lag is step 43. That turn arriving 2–12 steps late lives, including while boosting and with two walls.
  - Turning on time just after the hit (1–8 steps after) dies. A turn made too late dies even with a spike. Never turning dies. Head-on: both die.
  - Random stress (24 players, random lateness spikes, 60 bots, 8 seeds): grid consistent, 3–10 rescues per run. ASan/UBSan clean.
  - Through a delay proxy: a steady connection measures 0 steps late; a 150 ms stall measures 9.
- A delay proxy for latency tests: a small Node TCP proxy that `setTimeout`s each chunk; open `/?server=ws://localhost:<proxy>/ws`.
- `pkill -f <pattern>` / `pgrep -f` kill or match the shell running the command, because the pattern is in its own command line. Find processes with `ps -eo pid,comm` instead.
- On the owner's Intel iGPU, **writing pixels** is the GPU cost, not the maths per pixel. Removing texture reads and maths from a full-screen pass saved only ~17%; not writing most pixels (fast clear) saved ~70%. Any full-screen effect (vignette, gradients) costs about 1.5 ms there. Avoid adding one.
- Game rules (both `sim.c` copies):
  - Nothing spawns in the middle (the centre zone, 35% of the world radius). Bots spawn in the ring 0.4–0.88 WR, players on the rim.
  - Each of 40 tries picks a spot **and a direction**. `spawnFit()` checks the head (`spawnRoom`: other heads, every 8th body point, and where each other head will be in ~1.5 s) and the whole straight body that will be laid behind it, sampled every 120 units: it needs a third of the head's room and must stay inside the world. It takes the first fit of at least `SPAWN_GAP` (600), else the best.
  - Measured on the whole new snake vs every other snake's points (5 sim-minutes): within 300 units 7 → 0. The old check only looked at the head, and a big bot's body (up to ~3800 units) could land across others.
  - Only snakes of mass ≥ `MID_MASS` (500 = length 5000 on screen) are drawn to the middle. Smaller ones roam the ring 0.3–0.88 WR as before; the owner asked to remove the extra code that kept them out of the middle.
  - Spawn check, measured with a native harness over 5 simulated minutes: spawns in the middle 45 → 0; spawns under 300 units from a snake 8 → 0.
- **Crash rule (both copies, `hitTest`/`hitAt`):** only the FRONT of the head counts. The point half a head radius ahead of the head centre must be within 80% of the other snake's radius of one of its body points (its centre line). The side of the head brushing a body no longer kills. Placed-snake tests: a body crossing just behind your head survives (it used to kill); running into a crossing body head-first dies.
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
- Food fade-in: `frameBlk[7]` is a **smooth** food clock in quarter-steps, with fractions: offline `(tick - 1 + alpha) / 4`, online `rt / 4`. The shaders compute `age = mod(clock - born, 65536)` as a float, and an age above 60000 ("born in the future", online, because the page draws about 4 steps in the past) counts as 0. The old integer clock grew pellets in 15 Hz jumps, and online a new pellet flashed at full size for about 4 frames before snapping small. `vI.w` carries `age × 16`.
- Food: one 4-vertex quad per pellet, halo radius `FOOD_GLOW` = 1.7 pellet radii (was 1.9). An octagon version (fewer pixels, 8 vertices) measured slower on the owner's iGPU (food 0.20 → 0.33 ms) and was reverted.
- Minimap: pixels that would add nothing are discarded (no blend), and the flat inside areas skip the edge maths.
- No dynamic resolution: the owner asked that sharpness is never lowered automatically. Only the Quality setting (Sharp / Balanced / Fast) chooses the pixel density. Don't add it back.
- GPU timing (P panel) runs on 1 frame in 8, because splitting a frame into timed passes costs CPU and GPU; the CPU figures now show normal frames.
- Headless CPU "draw" times swing ±40% between runs (software GPU), so small CPU savings can't be measured there. `T` in `app.js` (`T.gl / T.n`) is the average draw time; a test copy can expose it on `window.__serpent`.
