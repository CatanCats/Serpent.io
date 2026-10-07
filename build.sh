#!/usr/bin/env bash
# Builds the two game pages (no Node.js needed: bash, clang, base64):
#   offline.html  the original game: src/sim.c compiled to WebAssembly, inlined with the renderers
#   index.html    the online front page: online/client + the same renderers
# SERVER_URL=wss://your.domain/ws ./build.sh  sets where the online page connects when it is
# not served by the game server itself (e.g. from GitHub Pages).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
clang --target=wasm32 -O3 -flto -nostdlib -mbulk-memory -msimd128 -Wall -Wextra \
  -Wl,--no-entry -Wl,--strip-all -Wl,--lto-O3 src/sim.c -o build/sim.wasm
# optional: Binaryen's wasm-opt makes the module smaller
if command -v "${WASM_OPT:-wasm-opt}" >/dev/null 2>&1; then
  "${WASM_OPT:-wasm-opt}" build/sim.wasm -O3 --enable-simd --enable-bulk-memory --enable-sign-ext \
    --enable-mutable-globals --enable-nontrapping-float-to-int -o build/sim.wasm
fi
WASM_B64="$(base64 < build/sim.wasm | tr -d '\n')"

# inline <template> <out>: each placeholder line /*__NAME__*/ becomes that file's contents
inline() {
  awk -v gl=src/render-gl.js -v gpu=src/render-gpu.js -v sheet=src/sheet.js -v app="$3" '
    function cat(f,   l) { while ((getline l < f) > 0) print l; close(f) }
    /\/\*__SHEET__\*\//      { cat(sheet); next }
    /\/\*__RENDER_GL__\*\//  { cat(gl);  next }
    /\/\*__RENDER_GPU__\*\// { cat(gpu); next }
    /\/\*__APP__\*\//        { cat(app); next }
    { print }' "$1" > "$2"
}
inline src/index.html offline.html src/app.js
sed -i.bak "s|__WASM_BASE64__|$WASM_B64|" offline.html
inline online/client/online.html index.html online/client/client.js
sed -i.bak "s|__SERVER_URL__|${SERVER_URL:-__SERVER_URL__}|" index.html
rm -f offline.html.bak index.html.bak
echo "sim.wasm $(wc -c < build/sim.wasm) B -> offline.html $(wc -c < offline.html) B · online index.html $(wc -c < index.html) B"
