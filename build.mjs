// Builds the self-contained index.html: compiles src/sim.c to WebAssembly with
// clang and inlines it (base64) into src/index.html.  Usage: node build.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

mkdirSync("build", { recursive: true });
execFileSync("clang", [
  "--target=wasm32", "-O3", "-flto", "-nostdlib", "-mbulk-memory", "-msimd128", "-Wall", "-Wextra",
  "-Wl,--no-entry", "-Wl,--strip-all", "-Wl,--lto-O3",
  "src/sim.c", "-o", "build/sim.wasm",
], { stdio: "inherit" });

const wasm = readFileSync("build/sim.wasm");
const html = readFileSync("src/index.html", "utf8").replace("__WASM_BASE64__", wasm.toString("base64"));
writeFileSync("index.html", html);
console.log(`sim.wasm ${wasm.length} B -> index.html ${html.length} B`);
