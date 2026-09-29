# serpent.io  a Open Source slither.io-style snake game for the browser

 Serpent.io is a fast, free io game in the style of slither.io. It runs in most browsers on desktop or mobile. The offline game is a single self-contained `offline.html`.

-  **Different difficuly levels for the AI bots** Rookie, Casual, Hunter, Elite and Legend.
-  Has a minimap, allowing you to the positions of different snakes.
-  **Fast** a WebAssembly simulation and WebGPU rendering (with WebGL 2 as backup) means that The game runs fast even on older machines and doesn't hog resources.
- Mouse, keyboard and touch controls.

**Play the game here: [catancats.github.io/Snake-Game](https://catancats.github.io/Snake-Game/)**. The front page plays **online** with other people once the server is up; **[offline.html](https://catancats.github.io/Snake-Game/offline.html)** is the original offline game, running entirely on your device (download it to play without internet). Each menu has a link to switch.

## Online
The online version uses the same rules and bots. A server runs the world (the offline game's C simulation compiled to native code, plus Rust networking), and your browser only draws it. Details, measurements and how to run or deploy it: [online/README.md](online/README.md).

## Controls
| Action | Mouse | Keyboard | Touch |
| --- | --- | --- | --- |
| Steer | move the pointer | ← → / A D | drag |
| Boost (costs length) | hold click | Space / Shift / ↑ / W | two fingers |
| Respawn / menu | | Enter / Esc | |
| Performance overlay (off by default) | | P | |

On the menu you can also pick Quality (Sharp / Balanced / Fast: caps the pixel density at 2× / 1.25× / 1×) and Renderer (Auto / WebGPU / WebGL). `?renderer=webgl` in the address forces WebGL.

## The game
- **Tiers**
-  bots from Rookie to Legend differ in how far they look ahead, how cleanly they steer, and how much they hunt. Hunters and above predict other heads and swoop on fresh kills.
- **Map**
- the player spawns on the outer rim; big snakes gather in the centre. The whole world wraps around the one snake you control.

## How the game is fast
Each frame, JavaScript makes one **WebAssembly call*, and then **one upload* of a contiguous block of WebAssembly memory to the GPU, followed by five draws.

**Simulation** (`src/sim.c`, C compiled with clang to a ~39 KB WebAssembly module; no libc, no malloc, all memory static):
- Fixed 60 Hz steps with interpolated rendering, so the game plays the same at any refresh rate.
- Bodies never move. Each snake is a ring buffer of its head's trail in 16-bit fixed point, so movement is O(1) per snake.
- Snakes near the camera get collisions, eating and full AI. The rest move at quarter rate and live or die by a per-tier formula that runs every 16 steps. Food and the collision maps exist only around the camera, so cost does not grow with the map.
- Incremental spatial hash, and efficient bot steering candidate headings come from precomputed rotation tables (no trig). The goal direction is tried first, and the search stops at the first safe heading. Danger checks read a byte map of which snake is in which cell.
- Food pellets use small amounts of resources. Pellets are 8-byte records in exactly the layout the GPU reads. The array is uploaded while the vertex shader skips empty and off-screen slots. The array is compacted during the regular rebuild.

**Rendering** (`src/render-gpu.js` WebGPU, `src/render-gl.js` WebGL 2; same look and the same five draws):
- Snakes are built on the GPU, the vertex shader builds each ribbon straight from a GPU copy of the trail memory. Only the new trail points of snakes on screen are uploaded. The fragment shader works out which scale is on top at each pixel, so the scaled look costs about 1× overdraw. The CPU writes 48 bytes per visible snake.
- Labels (the name and level) are put into a texture atlas when they change, then drawn as one instanced draw.
- The minimap is drawn on the game canvas, with no Canvas2D.
- The floor has no texture and almost no per-pixel work: a coarse 48×28 grid works out the soft shading (glow, vignette) per corner and the GPU blends it across each cell; the hex lines are thin instanced quads; the exact world-edge glow is drawn only when the edge is on screen.
- Dynamic resolution removes pixels before dropping frames.

## Measuring
Press **P* for:
- fps, and CPU time per part (sim, prep, draw, DOM);
- GPU time per pass (floor, food, snakes, labels, map), when the browser supports GPU timers;
- a simulation benchmark in µs per step, normal being 10–40 µs.

## Source layout
- `src/sim.c`: the whole simulation (WebAssembly).
- `src/app.js`: UI, input, HUD, labels and the main loop.
- `src/render-gpu.js` / `src/render-gl.js`: the two renderers.
- `src/index.html`: the page.
- `build.sh` builds `offline.html` (the offline game) and `index.html` (the online front page).

## Rebuilding
```sh
./build.sh   # needs bash and clang with the wasm32 target; uses Binaryen's wasm-opt if it is on PATH
```
