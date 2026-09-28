// Builds the two pages: offline.html (the original game: src/sim.c compiled to
// WebAssembly with clang, inlined with the renderers and app) and index.html (the
// online front page: online/client + the same renderers).  Usage: node build.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

mkdirSync("build", { recursive: true });
execFileSync("clang", [
  "--target=wasm32", "-O3", "-flto", "-nostdlib", "-mbulk-memory", "-msimd128", "-Wall", "-Wextra",
  "-Wl,--no-entry", "-Wl,--strip-all", "-Wl,--lto-O3",
  "src/sim.c", "-o", "build/sim.wasm",
], { stdio: "inherit" });

// Optional: Binaryen's wasm-opt (smaller file; speed is already at clang's level).
// Uses $WASM_OPT, or wasm-opt on PATH; skipped if neither exists.
for (const bin of [process.env.WASM_OPT, "wasm-opt"].filter(Boolean)) {
  try {
    execFileSync(bin, ["build/sim.wasm", "-O3", "--enable-simd", "--enable-bulk-memory", "--enable-sign-ext",
      "--enable-mutable-globals", "--enable-nontrapping-float-to-int", "-o", "build/sim.wasm"], { stdio: "ignore" });
    console.log(`wasm-opt: ${bin}`);
    break;
  } catch {}
}
const wasm = readFileSync("build/sim.wasm");
const inline = (f) => readFileSync(f, "utf8").replace(/<\/script/gi, "<\\/script");
// Offline game (the original): everything runs on the player's device.
const offline = readFileSync("src/index.html", "utf8")
  .replace("/*__RENDER_GL__*/", () => inline("src/render-gl.js"))
  .replace("/*__RENDER_GPU__*/", () => inline("src/render-gpu.js"))
  .replace("/*__APP__*/", () => inline("src/app.js"))
  .replace("__WASM_BASE64__", wasm.toString("base64"));
writeFileSync("offline.html", offline);
// Online game (the front page): the same renderers, the world comes from the server.
// SERVER_URL (e.g. wss://play.example.com/ws) is where the page connects when it is
// not served by the game server itself (e.g. from GitHub Pages).
const online = readFileSync("online/client/online.html", "utf8")
  .replace("/*__RENDER_GL__*/", () => inline("src/render-gl.js"))
  .replace("/*__RENDER_GPU__*/", () => inline("src/render-gpu.js"))
  .replace("/*__APP__*/", () => inline("online/client/client.js").replace("__SERVER_URL__", process.env.SERVER_URL || "__SERVER_URL__"));
writeFileSync("index.html", online);
console.log(`sim.wasm ${wasm.length} B -> offline.html ${offline.length} B · online index.html ${online.length} B`);
