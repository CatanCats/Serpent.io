# serpent.io

A slither.io-style snake game in a single, self-contained `index.html`: 60 AI bots in five tiers (Rookie, Casual, Hunter, Elite and the rare Legend), a big circular world, boosting, and snakes that burst into food when they die.

**Play:** open `index.html` in any modern browser. It needs no server or install.

## Controls
| Action | Mouse | Keyboard | Touch |
| --- | --- | --- | --- |
| Steer | move the pointer | ← → / A D | drag |
| Boost (costs length) | hold click | Space / Shift / ↑ | two fingers |
| Respawn / menu | | Enter / Esc | |
| Performance overlay | | P | |

## How it's built for speed
- **The simulation runs in WebAssembly** (`src/sim.c`, compiled with clang to a 17 KB module with no libc and no malloc). All state is in static memory, so JS makes its typed-array views once and never allocates per frame.
- **Bodies never move:** each snake is a ring buffer of its head's trail in 16-bit fixed point, so a step is O(1) per snake. The spatial hash is updated incrementally and compacted every 32 steps. Bots check danger with a 32-unit ownership byte map.
- **Bot AI:** bots look for food by value over distance and hunt smaller snakes by cutting in front of them. They probe 13 candidate headings for obstacles and the world border. Their thinking is staggered across alternate steps.
- **Rendering takes 3 draw calls per frame:** the hex floor, all food as one instanced draw, and all snakes as one triangle strip. The snake shader works out which segment circle is on top at each pixel and shades it, so the classic scaled look costs about 1× overdraw instead of about 5×.
- The game uses a fixed ≤1/60 s substep. DPR is capped at 2, and DOM updates for the leaderboard and minimap run only 4× per second.

Measured headless: about 0.3 ms of simulation per frame with 40 bots and about 3,600 food pellets.

- **Detail only near the player:** full collisions, eating and AI run only around the camera. Far-away bots use a cheap statistical model: higher tiers grow faster and almost never die. Food and the bot obstacle map exist only around the player, so the cost doesn't depend on map size.
- **GPU-built snakes:** the vertex shader builds each snake's ribbon straight from a texture that's a byte copy of the WASM trail memory. The CPU writes 48 bytes per visible snake.
- **Fixed 60 Hz simulation** with render interpolation, so the game behaves the same at any refresh rate.

## Rebuilding
Edit `src/sim.c` or `src/index.html`, then run:
```sh
node build.mjs   # needs clang with the wasm32 target
```
This compiles the WASM and inlines it (base64) into `index.html`.
