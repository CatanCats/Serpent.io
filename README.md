# serpent.io – a free slither.io-style snake game for the browser

**Eat, grow and cut off 60 AI snakes.** Serpent.io is a fast, free io game in the style of slither.io. It runs in any modern browser on desktop or mobile: no download, no sign-up, and it works offline. The whole game is one self-contained `index.html` (about 125 KB).

- 🐍 **60 AI bots in five tiers:** Rookie, Casual, Hunter, Elite and the rare Legend.
- 🏆 Live leaderboard, minimap, boosting, and snakes that burst into food when they die.
- ⚡ **Built for speed:** a WebAssembly simulation and WebGPU rendering (with WebGL 2 as backup) keep it smooth even on laptops with integrated graphics.
- 📱 Mouse, keyboard and touch controls.

**▶ Play online: [catancats.github.io/Snake-Game](https://catancats.github.io/Snake-Game/)**, or download `index.html` and open it in your browser.

## Controls
| Action | Mouse | Keyboard | Touch |
| --- | --- | --- | --- |
| Steer | move the pointer | ← → / A D | drag |
| Boost (costs length) | hold click | Space / Shift / ↑ / W | two fingers |
| Respawn / menu | | Enter / Esc | |
| Performance overlay (off by default) | | P | |

On the menu you can also pick **Quality** (Sharp / Balanced / Fast: caps the pixel density at 2× / 1.25× / 1×) and **Renderer** (Auto / WebGPU / WebGL). `?renderer=webgl` in the address forces WebGL.

## The game
- **Tiers:** bots from Rookie to Legend differ in how far they look ahead, how cleanly they steer, and how much they hunt. Hunters and above predict other heads and swoop on fresh kills.
- **Legends are strong but fair.** They follow the same physics and turn rate as every snake and die when they crash. They survive by driving carefully: a close-range probe, an exact free-space check when boxed in, and a calm temperament.
- **Map:** the player spawns on the outer rim; big snakes gather in the centre. The whole world wraps around the one snake you control.

## How it's built for speed
Each frame, JavaScript makes **one WebAssembly call**, then **one upload** of a contiguous block of WebAssembly memory to the GPU, followed by five draws.

**Simulation** (`src/sim.c`, C compiled with clang to a ~39 KB WebAssembly module; no libc, no malloc, all memory static):
- **Fixed 60 Hz steps** with interpolated rendering, so the game plays the same at any refresh rate.
- **Bodies never move.** Each snake is a ring buffer of its head's trail in 16-bit fixed point, so movement is O(1) per snake.
- **Detail only where you look.** Snakes near the camera get collisions, eating and full AI. The rest move at quarter rate and live or die by a per-tier formula that runs every 16 steps. Food and the collision maps exist only around the camera, so cost does not grow with the map.
- **Incremental spatial hash**, compacted every 32 steps. Collision, eating and free-space queries visit only the grid cells their reach overlaps (usually 1–4, not a fixed 3×3).
- **Cheap bot steering:** candidate headings come from precomputed rotation tables (no trig). The goal direction is tried first and the search stops at the first safe heading. Danger checks read a byte map of who owns each 32-unit cell.
- **Food costs no CPU per frame.** Pellets are 8-byte records in exactly the layout the GPU reads. The whole array is uploaded as-is and the vertex shader skips empty and off-screen slots. The array is compacted during the regular rebuild.

**Rendering** (`src/render-gpu.js` WebGPU, `src/render-gl.js` WebGL 2; same look and the same five draws):
- **Snakes are built on the GPU.** The vertex shader builds each ribbon straight from a GPU copy of the trail memory. Only the new trail points of snakes on screen are uploaded. The fragment shader works out which scale is on top at each pixel, so the scaled look costs about 1× overdraw. The CPU writes 48 bytes per visible snake.
- **Labels** (name and level) are drawn into a texture atlas only when they change, then drawn as one instanced draw.
- The **minimap** is drawn on the game canvas, with no Canvas2D.
- The **floor** is one hex tile baked once into a mipmapped texture and drawn without blending.
- **Dynamic resolution** drops pixels before dropping frames.

## Measuring
Press **P** for:
- fps, and CPU time per part (sim, prep, draw, DOM);
- GPU time per pass (floor, food, snakes, labels, map), when the browser supports GPU timers;
- a simulation benchmark in µs per step, taken on the menu after warm-up. Typical is 10–40 µs. If it is far higher, the menu shows a note.

## Source layout
- `src/sim.c`: the whole simulation (WebAssembly).
- `src/app.js`: UI, input, HUD, labels and the main loop.
- `src/render-gpu.js` / `src/render-gl.js`: the two renderers.
- `src/index.html`: the page.
- `build.mjs` inlines everything into `index.html`.

## Rebuilding
```sh
node build.mjs   # needs clang with the wasm32 target; uses Binaryen's wasm-opt if it is on PATH
```
