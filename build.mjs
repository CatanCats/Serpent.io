// Builds the self-contained index.html: compiles src/sim.c to WebAssembly with
// clang, then inlines it (base64) and the renderer/app scripts into src/index.html.  Usage: node build.mjs
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
const html = readFileSync("src/index.html", "utf8")
  .replace("/*__RENDER_GL__*/", () => inline("src/render-gl.js"))
  .replace("/*__RENDER_GPU__*/", () => inline("src/render-gpu.js"))
  .replace("/*__APP__*/", () => inline("src/app.js"))
  .replace("__WASM_BASE64__", wasm.toString("base64"));
writeFileSync("index.html", html);
console.log(`sim.wasm ${wasm.length} B -> index.html ${html.length} B`);
