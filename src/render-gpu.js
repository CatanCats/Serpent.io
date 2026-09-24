/* ============================================================================
   WebGPU renderer (preferred). Same passes and same look as the WebGL one.
   - Every pass is a pre-recorded render bundle; draw counts come from an
     indirect-args buffer that WebAssembly fills, so a frame is ~10 JS calls.
   - One bind group shared by all pipelines.
   - Optional per-pass GPU timestamps (when the browser exposes them).
   ========================================================================== */
async function createGPU(canvas, E) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const canTime = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: canTime ? ["timestamp-query"] : [] });
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const { NS, RING } = E;
  const q = device.queue, U = GPUBufferUsage, TU = GPUTextureUsage;
  device.pushErrorScope("validation");

  const hex = (h) => [1, 3, 5].map((i) => (parseInt(h.substr(i, 2), 16) / 255).toFixed(4)).join(",");
  const PAL = `var<private> SKA: array<vec3f,12> = array<vec3f,12>(${E.SKINS.map(([a]) => `vec3f(${hex(a)})`).join(",")});
var<private> SKB: array<vec3f,12> = array<vec3f,12>(${E.SKINS.map(([, b]) => `vec3f(${hex(b)})`).join(",")});`;

  const WGSL = /* wgsl */ `
struct Frame { camHalf: vec4f, pxTime: vec4f, resWR: vec4f };
struct Mini { c: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var linRep: sampler;
@group(0) @binding(2) var tileTex: texture_2d<f32>;
@group(0) @binding(3) var trailTex: texture_2d<i32>;
@group(0) @binding(4) var atlasTex: texture_2d<f32>;
@group(0) @binding(5) var linClamp: sampler;
@group(0) @binding(6) var<uniform> M: Mini;
${PAL}
const RM: i32 = ${RING - 1};
const CR: f32 = 2.38095238;   // 1 / 0.42: circle radius in segment units
const SP: f32 = 0.42;

fn quad(vi: u32) -> vec2f { return vec2f(f32(vi & 1u), f32(vi >> 1u)); }

// ---------- floor ----------
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2. - 1., 0., 1.);
}
@fragment fn fsBg(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ndc = fc.xy / F.resWR.xy * 2. - 1.;               // y down, like world space
  let w = F.camHalf.xy + ndc * F.camHalf.zw;
  let tf = textureSample(tileTex, linRep, w / 46. / vec2f(1.7320508, 1.)).rg;
  var col = mix(mix(vec3f(.052, .066, .108), vec3f(.07, .088, .14), tf.x), vec3f(.028, .035, .06), tf.y * .85);
  let px = F.camHalf.w * 2. / F.resWR.y / 46.;
  let WR = F.resWR.z; let r = length(w); let rw = 14. + px * 46.;
  if (r > WR - 2.) { col = mix(col, col * vec3f(.55, .22, .28) + vec3f(.05, 0., .01), smoothstep(WR - 2., WR + 2., r)); }
  if (abs(r - WR) < rw * 6.) { col += vec3f(1., .25, .35) * exp(-abs(r - WR) / rw) * (.7 + .3 * sin(F.pxTime.y * 3.)) * .55; }
  if (r < WR * .37) { col += vec3f(.9, .3, .4) * .035 * (1. - smoothstep(WR * .3, WR * .37, r)); }
  col *= 1. - .35 * dot(ndc * .72, ndc * .72);
  return vec4f(col, 1.);
}
fn hexD(p0: vec2f) -> f32 { let p = abs(p0); return max(dot(p, vec2f(.8660254, .5)), p.y); }
@fragment fn fsTile(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let R = vec2f(1.7320508, 1.); let H = R * .5;
  let uv = fc.xy / vec2f(512., 296.) * R;
  let a = uv - floor(uv / R) * R - H; let b0 = uv - H; let b = b0 - floor(b0 / R) * R - H;
  var g = b; if (dot(a, a) < dot(b, b)) { g = a; }
  let e = .5 - hexD(g);
  // two blend factors only (rg8unorm: half the bytes of rgba8); colours are applied when drawing
  return vec4f(smoothstep(0., .5, e), 1. - smoothstep(0., .03, e), 0., 1.);
}

// ---------- food ----------
struct FoodO { @builtin(position) pos: vec4f, @location(0) l: vec2f,
  @location(1) @interpolate(flat) r: f32, @location(2) @interpolate(flat) info: vec4u };
@vertex fn vsFood(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: vec4u) -> FoodO {
  let q = quad(vi) * 2. - 1.;
  let tiny = p.z / F.pxTime.x < 1.6;                       // under ~1.6 px: no halo
  let l = q * select(p.z * 1.9, p.z * .7 + F.pxTime.x * 1.5, tiny);
  let c = (p.xy + l - F.camHalf.xy) / F.camHalf.zw;
  var o: FoodO; o.pos = vec4f(c.x, -c.y, 0., 1.); o.l = l; o.r = p.z; o.info = info; return o;
}
@fragment fn fsFood(i: FoodO) -> @location(0) vec4f {
  let d = length(i.l); let r = i.r; let aa = F.pxTime.x * 1.2;
  let c = SKA[i.info.y % 12u];
  let pulse = .75 + .25 * sin(F.pxTime.y * 4. + f32(i.info.z) * .0245);
  let born = smoothstep(0., 10., f32(i.info.w));
  let rr = r * (.4 + .6 * born);
  let core = (1. - smoothstep(rr * .7 - aa, rr * .7 + aa, d)) * born;
  var glow = 0.;
  if (r / F.pxTime.x >= 1.6) { glow = max(exp(-d * d / (rr * rr * 1.1)) - .0376, 0.) / .9624 * .9 * pulse * born; }
  return vec4f(c * glow + mix(c, vec3f(1.), .55 * (1. - d / (rr * .7))) * core, core);
}

// ---------- snakes: ribbons built from the trail texture ----------
struct RibO { @builtin(position) pos: vec4f, @location(0) t: f32, @location(1) v: f32, @location(2) dir: vec2f,
  @location(3) @interpolate(flat) sk: u32, @location(4) @interpolate(flat) fl: u32,
  @location(5) @interpolate(flat) r: f32, @location(6) @interpolate(flat) nl: f32 };
fn T(h2: vec4u, k: i32) -> vec2f {
  return vec2f(textureLoad(trailTex, vec2i((i32(h2.y) - k) & RM, i32(h2.x)), 0).xy) * .25;
}
fn body(h0: vec4f, h2: vec4u, i: i32) -> vec2f {
  if (i <= 0) { return h0.xy; }
  return mix(T(h2, i - 1), T(h2, i), h0.z);
}
fn fwd(h1: vec4f) -> vec2f { return vec2f(cos(h1.z), sin(h1.z)); }
// strip order: tail cap, body samples tail->head, head, head cap
fn seqPt(j: i32, n: i32, st: i32, K: i32, h0: vec4f, h1: vec4f, h2: vec4u) -> vec3f {
  if (j <= 0) {
    let a = body(h0, h2, n - 1); var d = a - body(h0, h2, n - 2); let l = length(d);
    if (l > 1e-3) { d = d / l; } else { d = -fwd(h1); }
    return vec3f(a + d * h0.w * h1.w, f32(n - 1) + CR * h1.w);
  }
  if (j <= K) { let i = max(n - 1 - (j - 1) * st, 1); return vec3f(body(h0, h2, i), f32(i)); }
  if (j == K + 1) { return vec3f(h0.xy, 0.); }
  return vec3f(h0.xy + fwd(h1) * h0.w * h1.w, -CR * h1.w);
}
@vertex fn vsRib(@builtin(vertex_index) vi: u32, @location(0) h0: vec4f, @location(1) h1: vec4f, @location(2) h2: vec4u) -> RibO {
  let n = i32(h2.z); let st = i32(h1.y); let K = (n - 1 + st - 1) / st; let last = K + 2;
  let j = min(i32(vi >> 1u), last); let side = (vi & 1u) == 0u;
  let p = seqPt(j, n, st, K, h0, h1, h2);
  var tg = seqPt(min(j + 1, last), n, st, K, h0, h1, h2).xy - seqPt(max(j - 1, 0), n, st, K, h0, h1, h2).xy;
  let tl = length(tg); if (tl > 1e-4) { tg = tg / tl; } else { tg = fwd(h1); }
  let nrm = vec2f(-tg.y, tg.x) * h0.w * h1.w;
  let c = (p.xy + select(-nrm, nrm, side) - F.camHalf.xy) / F.camHalf.zw;
  var o: RibO;
  o.pos = vec4f(c.x, -c.y, 0., 1.); o.t = p.z; o.v = select(-h1.w, h1.w, side); o.dir = tg;
  o.sk = (h2.w & 255u) % 12u; o.fl = h2.w >> 8u; o.r = h0.w; o.nl = f32(n - 1);
  return o;
}
fn shade(k: f32, l: vec2f, nd: f32, f: vec2f, sk: u32, r: f32) -> vec3f {
  let ki = u32(k);
  var base = SKA[sk]; if (ki != 0u && ((ki >> 2u) & 1u) == 1u) { base = SKB[sk]; }
  var c = base * (1.05 - .55 * nd * nd);
  let sp = l - vec2f(-.28, -.36);
  c += vec3f(.28) * exp(-dot(sp, sp) * 7.);
  c = mix(c * .55, c, 1. - smoothstep(.82, 1., nd));
  if (ki == 0u) { // head: eyes
    let sd = vec2f(-f.y, f.x); let aa = F.pxTime.x * 1.2 / r;
    for (var e = 0; e < 2; e++) {
      let ec = f * .32 + sd * select(-.45, .45, e == 0);
      c = mix(c, vec3f(.97), 1. - smoothstep(.3 - aa, .3 + aa, length(l - ec)));
      c = mix(c, vec3f(.03, .04, .07), 1. - smoothstep(.16 - aa, .16 + aa, length(l - ec - f * .11)));
    }
  }
  return c;
}
@fragment fn fsRib(i: RibO) -> @location(0) vec4f {
  let aa = F.pxTime.x * 1.2 / i.r; let av = abs(i.v);
  let f = normalize(i.dir); let side = vec2f(-f.y, f.x);
  var h = 0.; if (av < 1.) { h = sqrt(1. - av * av) * CR; }
  let k0 = clamp(select(floor(i.t + .5), ceil(i.t - h), av < 1.), 0., i.nl); let k1 = min(k0 + 1., i.nl);
  let l0 = -f * (i.t - k0) * SP + side * i.v; let l1 = -f * (i.t - k1) * SP + side * i.v;
  let n0 = length(l0); let n1 = length(l1);
  let e0 = 1. - smoothstep(1. - aa, 1. + aa, n0); let e1 = (1. - smoothstep(1. - aa, 1. + aa, n1)) * (1. - e0);
  let a = e0 + e1;
  var gc = SKA[i.sk] * 1.2; var glow = 0.;
  let gd = min(n0, n1); // distance to the nearest scale circle: round glow, also at head and tail
  if ((i.fl & 1u) != 0u) { glow = exp(-pow(max(gd - .8, 0.) / .45, 2.)) * (.55 + .25 * sin(F.pxTime.y * 18.)) * (1. - a); }
  else if ((i.fl & 4u) != 0u) { glow = exp(-pow(max(gd - .85, 0.) / .3, 2.)) * (.45 + .15 * sin(F.pxTime.y * 2.5 + i.t * .3)) * (1. - a); gc = vec3f(1., .78, .3); }
  if (a <= 0. && glow <= .003) { discard; }
  var c = vec3f(0.);
  if (e0 > 0.) { c += shade(k0, l0, n0, f, i.sk, i.r) * e0; }
  if (e1 > 0.) { c += shade(k1, l1, n1, f, i.sk, i.r) * e1; }
  if ((i.fl & 4u) != 0u) { c += vec3f(1., .85, .4) * .18 * a * (.5 + .5 * sin(i.t * .8 - F.pxTime.y * 3.)); } // shimmering scales
  return vec4f(c + gc * glow, a);
}

// ---------- labels: one quad per visible snake, from the atlas ----------
struct LblO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsLbl(@builtin(vertex_index) vi: u32, @location(0) h0: vec4f, @location(2) h2: vec4u) -> LblO {
  let q = quad(vi);
  let c = (h0.xy - vec2f(0., h0.w * 1.25) - F.camHalf.xy) / F.camHalf.zw;
  let off = vec2f(q.x - .5, q.y - 1.) * vec2f(${E.SLOT_W}., ${E.SLOT_H}.) * F.pxTime.z;
  var o: LblO;
  o.pos = vec4f(c.x + off.x * 2. / F.resWR.x, -c.y - off.y * 2. / F.resWR.y, 0., 1.);
  let slot = h2.x;
  o.uv = (vec2f(f32(slot % ${E.CELLS_X}u), f32(slot / ${E.CELLS_X}u)) + q) / vec2f(${E.CELLS_X}., ${E.CELLS_Y}.);
  return o;
}
@fragment fn fsLbl(i: LblO) -> @location(0) vec4f { return textureSample(atlasTex, linClamp, i.uv); }

// ---------- minimap ----------
struct MiniO { @builtin(position) pos: vec4f, @location(0) l: vec2f, @location(1) s: vec2f, @location(2) @interpolate(flat) info: u32 };
@vertex fn vsMini(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: u32) -> MiniO {
  let kind = info & 255u;
  let q = quad(vi) * 2. - 1.;
  var ext = vec2f(p.z * select(1., 1.03, kind == 0u) + 1.5 / M.c.z);
  if (kind == 3u) { ext = vec2f(p.z, f32(info >> 8u) / 16777215.) + 6. / M.c.z; }
  let m = p.xy + q * ext;
  var o: MiniO;
  o.pos = vec4f(M.c.xy + vec2f(m.x, -m.y) * M.c.z * 2. / F.resWR.xy, 0., 1.);
  o.l = q * ext; o.s = ext; o.info = info; return o;
}
fn over(a: vec4f, b: vec4f) -> vec4f { return a + b * (1. - a.a); }
@fragment fn fsMini(i: MiniO) -> @location(0) vec4f {
  let kind = i.info & 255u; let aa = 1. / M.c.z;
  var c = vec4f(0.);
  if (kind == 0u) {
    let d = length(i.l); let inside = 1. - smoothstep(1. - aa, 1. + aa, d);
    c = vec4f(vec3f(.047, .066, .118) * .9, .9) * inside;
    c = over(vec4f(vec3f(.98, .44, .52) * .07, .07) * (1. - smoothstep(.35 - aa, .35 + aa, d)), c);
    c = over(vec4f(vec3f(.98, .44, .52) * .5, .5) * (1. - smoothstep(0., 2. * aa, abs(d - (1. - 2. * aa)))), c);
  } else if (kind == 1u) {
    let r = i.s.x - 1.5 * aa;
    let a = (1. - smoothstep(r - aa, r + aa, length(i.l))) * f32((i.info >> 16u) & 255u) / 255.;
    c = vec4f(SKA[(i.info >> 8u) & 255u] * a, a);
  } else if (kind == 2u) {
    let d = length(i.l); let r = i.s.x - 1.5 * aa;
    c = over(vec4f(1.) * (1. - smoothstep(r * .55 - aa, r * .55 + aa, d)), vec4f(vec3f(.3), .3) * (1. - smoothstep(r - aa, r + aa, d)));
  } else {
    let h = i.s - 6. * aa; let e = abs(i.l) - h; let d = abs(max(e.x, e.y));
    let a = (1. - smoothstep(.5 * aa, 1.5 * aa, d)) * .4; c = vec4f(vec3f(a), a);
  }
  return c;
}
`;
  const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(p * 2. - 1., 0., 1.);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  return textureSample(src, smp, fc.xy / (vec2f(textureDimensions(src)) * .5));
}`;

  const mod = device.createShaderModule({ code: WGSL });
  const info = await mod.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === "error");
  if (errs.length) throw new Error("WGSL: " + errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"));

  // ---- resources ----
  const buf = (size, usage) => device.createBuffer({ size: Math.ceil(size / 4) * 4, usage });
  const frameBuf = buf(48, U.UNIFORM | U.COPY_DST), miniUBuf = buf(16, U.UNIFORM | U.COPY_DST);
  const indBuf = buf(80, U.INDIRECT | U.COPY_DST);
  const foodBuf = buf(E.instBytes.byteLength, U.VERTEX | U.COPY_DST);
  const hdrBuf = buf(E.hdrBytes.byteLength, U.VERTEX | U.COPY_DST);
  const miniBuf = buf(E.miniBytes.byteLength, U.VERTEX | U.COPY_DST);
  const trailTex = device.createTexture({ size: [RING, NS], format: "rg16sint", usage: TU.TEXTURE_BINDING | TU.COPY_DST });
  const mips = (w, h) => 1 + Math.floor(Math.log2(Math.max(w, h)));
  const tileTex = device.createTexture({ size: [512, 296], format: "rg8unorm", mipLevelCount: mips(512, 296),
    usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_DST });
  const atlasTex = device.createTexture({ size: [E.AW, E.AH], format: "rgba8unorm", mipLevelCount: mips(E.AW, E.AH),
    usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_DST });
  const linRep = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" }); // no anisotropy: the floor is seen straight on
  const linClamp = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

  const V = GPUShaderStage.VERTEX, FR = GPUShaderStage.FRAGMENT;
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: V | FR, buffer: {} },
    { binding: 1, visibility: FR, sampler: {} },
    { binding: 2, visibility: FR, texture: {} },
    { binding: 3, visibility: V, texture: { sampleType: "sint" } },
    { binding: 4, visibility: FR, texture: {} },
    { binding: 5, visibility: FR, sampler: {} },
    { binding: 6, visibility: V | FR, buffer: {} },
  ] });
  const bind = device.createBindGroup({ layout: bgl, entries: [
    { binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: linRep },
    { binding: 2, resource: tileTex.createView() }, { binding: 3, resource: trailTex.createView() },
    { binding: 4, resource: atlasTex.createView() }, { binding: 5, resource: linClamp },
    { binding: 6, resource: { buffer: miniUBuf } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const PREMUL = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
  const pipe = (vs, fs, buffers, blend, fmt = format, strip = true) => device.createRenderPipeline({
    layout, vertex: { module: mod, entryPoint: vs, buffers },
    fragment: { module: mod, entryPoint: fs, targets: [{ format: fmt, blend }] },
    primitive: { topology: strip ? "triangle-strip" : "triangle-list" },
  });
  const inst = (stride, attrs) => [{ arrayStride: stride, stepMode: "instance", attributes: attrs.map(([l, o, f]) => ({ shaderLocation: l, offset: o, format: f })) }];
  const foodL = inst(16, [[0, 0, "float32x3"], [1, 12, "uint8x4"]]);
  const hdrL = inst(48, [[0, 0, "float32x4"], [1, 16, "float32x4"], [2, 32, "uint32x4"]]);
  const lblL = inst(48, [[0, 0, "float32x4"], [2, 32, "uint32x4"]]);
  const miniL = inst(16, [[0, 0, "float32x3"], [1, 12, "uint32"]]);
  const P = {
    bg: pipe("vsFull", "fsBg", [], undefined, format, false),
    food: pipe("vsFood", "fsFood", foodL, PREMUL),
    rib: pipe("vsRib", "fsRib", hdrL, PREMUL),
    lbl: pipe("vsLbl", "fsLbl", lblL, PREMUL),
    mini: pipe("vsMini", "fsMini", miniL, PREMUL),
  };

  // ---- one-off: bake the floor tile, and a small mipmap generator ----
  const mipMod = device.createShaderModule({ code: MIP_WGSL });
  const mipPipes = {};
  const mipPipeFor = (fmt) => mipPipes[fmt] ??= device.createRenderPipeline({ layout: "auto", vertex: { module: mipMod, entryPoint: "vs" },
    fragment: { module: mipMod, entryPoint: "fs", targets: [{ format: fmt }] }, primitive: { topology: "triangle-list" } });
  function genMips(tex) {
    const mipPipe = mipPipeFor(tex.format);
    const enc = device.createCommandEncoder();
    for (let l = 1; l < tex.mipLevelCount; l++) {
      const bg = device.createBindGroup({ layout: mipPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }) }, { binding: 1, resource: linClamp }] });
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView({ baseMipLevel: l, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(mipPipe); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
    }
    q.submit([enc.finish()]);
  }
  {
    // own "auto" layout: the tile can't be bound as a texture while it is being rendered to
    const tilePipe = device.createRenderPipeline({ layout: "auto", vertex: { module: mod, entryPoint: "vsFull" },
      fragment: { module: mod, entryPoint: "fsTile", targets: [{ format: "rg8unorm" }] }, primitive: { topology: "triangle-list" } });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tileTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(tilePipe); pass.draw(3); pass.end();
    q.submit([enc.finish()]);
    genMips(tileTex);
  }

  // ---- record the five passes once; replayed every frame ----
  const bundle = (p, vbuf, draw) => {
    const be = device.createRenderBundleEncoder({ colorFormats: [format] });
    be.setPipeline(p); be.setBindGroup(0, bind);
    if (vbuf) be.setVertexBuffer(0, vbuf);
    be.drawIndirect(indBuf, draw * 16);
    return be.finish();
  };
  const bundles = [bundle(P.bg, null, 0), bundle(P.food, foodBuf, 1), bundle(P.rib, hdrBuf, 2), bundle(P.lbl, hdrBuf, 3), bundle(P.mini, miniBuf, 4)];

  // ---- GPU timestamps (optional) ----
  let qset = null, resolveBuf = null, readBuf = null, reading = false;
  if (canTime) {
    qset = device.createQuerySet({ type: "timestamp", count: 10 });
    resolveBuf = device.createBuffer({ size: 80, usage: U.QUERY_RESOLVE | U.COPY_SRC });
    readBuf = device.createBuffer({ size: 80, usage: U.MAP_READ | U.COPY_DST });
  }
  const err = await device.popErrorScope();
  if (err) throw new Error("WebGPU setup: " + err.message);

  const memBuf = E.mem;
  const R = {
    name: "WebGPU", gpuMs: -1, passMs: null, canTime, device,
    resize() {},
    placeMini(cx, cy, r) { q.writeBuffer(miniUBuf, 0, new Float32Array([cx, cy, r, 0])); },
    labelSlot(src, x, y) {
      q.copyExternalImageToTexture({ source: src }, { texture: atlasTex, origin: { x, y }, premultipliedAlpha: true }, [src.width, src.height]);
    },
    labelsDone() { genMips(atlasTex); },
    draw(frameNo, playing, timing) {
      const o = E.frameOut, instCount = o[0], nVis = o[1], nRuns = o[3], nMini = o[4];
      // uploads: straight from WebAssembly memory
      q.writeBuffer(frameBuf, 0, memBuf, E.ptr.frameBlk, 48);
      q.writeBuffer(indBuf, 0, memBuf, E.ptr.indirect, 80);
      if (instCount) q.writeBuffer(foodBuf, 0, memBuf, E.ptr.inst, instCount * 16);
      if (nVis) {
        q.writeBuffer(hdrBuf, 0, memBuf, E.ptr.hdr, nVis * 48);
        for (let i = 0; i < nRuns; i++) {
          const r0 = E.runs[i * 2], cnt = E.runs[i * 2 + 1];
          q.writeTexture({ texture: trailTex, origin: { x: 0, y: r0 } }, memBuf,
            { offset: E.ptr.trail + r0 * RING * 4, bytesPerRow: RING * 4, rowsPerImage: cnt }, [RING, cnt]);
        }
      }
      if (playing && nMini) q.writeBuffer(miniBuf, 0, memBuf, E.ptr.mini, nMini * 16);

      const enc = device.createCommandEncoder();
      const view = ctx.getCurrentTexture().createView();
      const perPass = timing && canTime && !reading;
      if (!perPass) {
        const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
        pass.executeBundles(bundles); pass.end();
      } else { // measuring: one pass per bundle, each timestamped
        for (let i = 0; i < 5; i++) {
          const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: i ? "load" : "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
            timestampWrites: { querySet: qset, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } });
          pass.executeBundles([bundles[i]]); pass.end();
        }
        enc.resolveQuerySet(qset, 0, 10, resolveBuf, 0);
        enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 80);
      }
      q.submit([enc.finish()]);
      if (perPass) {
        reading = true;
        readBuf.mapAsync(GPUMapMode.READ).then(() => {
          const t = new BigUint64Array(readBuf.getMappedRange());
          const ms = [0, 1, 2, 3, 4].map((i) => Number(t[i * 2 + 1] - t[i * 2]) / 1e6);
          readBuf.unmap(); reading = false;
          if (ms.every((v) => v >= 0 && v < 1000)) { R.passMs = ms; R.gpuMs = ms.reduce((a, b) => a + b, 0); }
        }, () => { reading = false; });
      }
    },
  };
  return R;
}
