/* ============================================================================
   WebGPU renderer (preferred). Same passes and same look as the WebGL one.
   - One upload per frame (a byte copy of the WASM per-frame block), plus the
     new trail points of snakes on screen.
   - Five direct draws in one pass with one shared bind group (measured
     cheaper than bundles + indirect draws for so few draws).
   - Optional per-pass GPU timestamps (when the browser exposes them).
   ========================================================================== */
async function createGPU(canvas, E) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const canTime = adapter.features.has("timestamp-query"), F16 = adapter.features.has("shader-f16");
  const device = await adapter.requestDevice({ requiredFeatures: [...(canTime ? ["timestamp-query"] : []), ...(F16 ? ["shader-f16"] : [])] });
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });
  const { NS, RING } = E;
  const q = device.queue, U = GPUBufferUsage, TU = GPUTextureUsage;
  device.pushErrorScope("validation");

  const WGSL = /* wgsl */ `${F16 ? "enable f16;" : ""}
// colour maths in half precision where the GPU supports it (big win on mobile GPUs)
alias hf = ${F16 ? "f16" : "f32"}; alias hv3 = vec3<hf>; alias hv4 = vec4<hf>;
struct Frame { camHalf: vec4f, pxTime: vec4f, resWR: vec4f };
struct Mini { c: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var linRep: sampler;
@group(0) @binding(2) var tileTex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> trail: array<u32>; // x | y<<16, a byte copy of WASM memory
@group(0) @binding(4) var atlasTex: texture_2d<f32>;
@group(0) @binding(5) var linClamp: sampler;
@group(0) @binding(6) var<uniform> M: Mini;
// skin palette (12 main, then 12 stripe colours): read once per vertex, passed to pixels flat
@group(0) @binding(7) var<uniform> PAL: array<vec4f, 24>;
const RM: i32 = ${RING - 1};
const CR: f32 = 2.38095238;   // 1 / 0.42: circle radius in segment units
const SP: f32 = 0.42;

fn quad(vi: u32) -> vec2f { return vec2f(f32(vi & 1u), f32(vi >> 1u)); }

// ---------- floor ----------
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2. - 1., 0., 1.);
}
struct BgO { @builtin(position) pos: vec4f, @location(0) w: vec2f, @location(1) ndc: vec2f };
@vertex fn vsBg(@builtin(vertex_index) i: u32) -> BgO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2. - 1.;
  var o: BgO; o.pos = vec4f(p, 0., 1.); o.ndc = vec2f(p.x, -p.y);   // y down, like world space
  o.w = F.camHalf.xy + o.ndc * F.camHalf.zw;                        // interpolated: no per-pixel maths
  return o;
}
@fragment fn fsBg(i: BgO) -> @location(0) vec4f {
  let ndc = i.ndc; let w = i.w;
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
  @location(1) @interpolate(flat) r: f32, @location(2) @interpolate(flat) info: vec4u, @location(3) @interpolate(flat) col: vec3f };
@vertex fn vsFood(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: vec4u) -> FoodO {
  let q = quad(vi) * 2. - 1.;
  let tiny = p.z / F.pxTime.x < 1.6;                       // under ~1.6 px: no halo
  let l = q * select(p.z * 1.9, p.z * .7 + F.pxTime.x * 1.5, tiny);
  let c = (p.xy + l - F.camHalf.xy) / F.camHalf.zw;
  var o: FoodO; o.pos = vec4f(c.x, -c.y, 0., 1.); o.l = l; o.r = p.z; o.info = info; o.col = PAL[info.y % 12u].rgb; return o;
}
@fragment fn fsFood(i: FoodO) -> @location(0) vec4f {
  let d = length(i.l); let r = i.r; let aa = F.pxTime.x * 1.2;
  let c = i.col;
  let pulse = .75 + .25 * sin(F.pxTime.y * 4. + f32(i.info.z) * .0245);
  let born = smoothstep(0., 10., f32(i.info.w));
  let rr = r * (.4 + .6 * born);
  let core = hf((1. - smoothstep(rr * .7 - aa, rr * .7 + aa, d)) * born);
  var glow = hf(0.);
  if (r / F.pxTime.x >= 1.6) { let t = min(d / (rr * 1.9), 1.); let g = 1. - t * t; glow = hf(g * g * pulse * born); } // fuller halo, same quad
  let ch = hv3(c);
  let rgb = ch * glow + mix(ch, hv3(1.), hf(.55 * (1. - d / (rr * .7)))) * core;
  return vec4f(vec3f(rgb), f32(core));
}

// ---------- snakes: ribbons built from the trail texture ----------
struct RibO { @builtin(position) pos: vec4f, @location(0) t: f32, @location(1) v: f32, @location(2) dir: vec2f,
  @location(3) @interpolate(flat) ca: vec3f, @location(4) @interpolate(flat) fl: u32,
  @location(5) @interpolate(flat) r: f32, @location(6) @interpolate(flat) nl: f32, @location(7) @interpolate(flat) cb: vec3f };
fn T(h2: vec4u, k: i32) -> vec2f {
  let v = trail[h2.x * ${RING}u + u32((i32(h2.y) - k) & RM)];
  return vec2f(f32(bitcast<i32>(v << 16u) >> 16u), f32(bitcast<i32>(v) >> 16u)) * .25;
}
fn fwd(h1: vec4f) -> vec2f { return vec2f(cos(h1.z), sin(h1.z)); }
// Strip order: tail cap, body samples tail->head, head, head cap. All snakes share
// one instanced draw sized for the longest, so spare vertices must be nearly free:
// they repeat the head cap (no texture reads) and form zero-area triangles.
@vertex fn vsRib(@builtin(vertex_index) vi: u32, @location(0) h0: vec4f, @location(1) h1: vec4f, @location(2) h2: vec4u) -> RibO {
  let n = i32(h2.z); let st = i32(h1.y); let K = (n - 1 + st - 1) / st;
  let j = i32(vi >> 1u); let side = (vi & 1u) == 0u;
  let W = h1.w; let hr = h0.w * W;
  var p: vec2f; var tg: vec2f; var t: f32;
  if (j <= 0) {                       // tail cap: 2 texture reads
    let a = T(h2, n - 2); let b = T(h2, n - 1); var d = b - a; let l = length(d);
    if (l > 1e-3) { d = d / l; } else { d = -fwd(h1); }
    p = mix(a, b, h0.z) + d * hr; tg = -d; t = f32(n - 1) + CR * W;
  } else if (j <= K) {                // body sample: 3 texture reads
    let i = max(n - 1 - (j - 1) * st, 1);
    let a = T(h2, i - 1); let b = T(h2, i); let d = a - T(h2, i + 1); let l = length(d);
    p = mix(a, b, h0.z); if (l > 1e-3) { tg = d / l; } else { tg = fwd(h1); } t = f32(i);
  } else if (j == K + 1) { p = h0.xy; tg = fwd(h1); t = 0.; }       // head
  else { tg = fwd(h1); p = h0.xy + tg * hr; t = -CR * W; }           // head cap (and spares)
  let nrm = vec2f(-tg.y, tg.x) * hr;
  let c = (p + select(-nrm, nrm, side) - F.camHalf.xy) / F.camHalf.zw;
  var o: RibO;
  o.pos = vec4f(c.x, -c.y, 0., 1.); o.t = t; o.v = select(-W, W, side); o.dir = tg;
  let sk = (h2.w & 255u) % 12u; o.ca = PAL[sk].rgb; o.cb = PAL[12u + sk].rgb;
  o.fl = h2.w >> 8u; o.r = h0.w; o.nl = f32(n - 1);
  return o;
}
fn shade(k: f32, l: vec2f, nd: f32, f: vec2f, ca: vec3f, cb: vec3f, r: f32) -> vec3f {
  let ki = u32(k);
  var base = ca; if (ki != 0u && ((ki >> 2u) & 1u) == 1u) { base = cb; }
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
  if (av > 1. + aa && (i.fl & 5u) == 0u) { discard; } // outside the body and no glow: skip everything
  let f = normalize(i.dir); let side = vec2f(-f.y, f.x);
  var h = 0.; if (av < 1.) { h = sqrt(1. - av * av) * CR; }
  let k0 = clamp(select(floor(i.t + .5), ceil(i.t - h), av < 1.), 0., i.nl); let k1 = min(k0 + 1., i.nl);
  let l0 = -f * (i.t - k0) * SP + side * i.v; let l1 = -f * (i.t - k1) * SP + side * i.v;
  let n0 = length(l0); let n1 = length(l1);
  let e0 = 1. - smoothstep(1. - aa, 1. + aa, n0); let e1 = (1. - smoothstep(1. - aa, 1. + aa, n1)) * (1. - e0);
  let a = e0 + e1;
  var gc = i.ca * 1.2; var glow = 0.;
  let gd = min(n0, n1); // distance to the nearest scale circle: round glow, also at head and tail
  if ((i.fl & 1u) != 0u) { glow = exp(-pow(max(gd - .8, 0.) / .45, 2.)) * (.55 + .25 * sin(F.pxTime.y * 18.)) * (1. - a); }
  else if ((i.fl & 4u) != 0u) { glow = exp(-pow(max(gd - .85, 0.) / .3, 2.)) * (.45 + .15 * sin(F.pxTime.y * 2.5 + i.t * .3)) * (1. - a); gc = vec3f(1., .78, .3); }
  if (a <= 0. && glow <= .003) { discard; }
  var c = vec3f(0.);
  if (e0 > 0.) { c += shade(k0, l0, n0, f, i.ca, i.cb, i.r) * e0; }
  if (e1 > 0.) { c += shade(k1, l1, n1, f, i.ca, i.cb, i.r) * e1; }
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
struct MiniO { @builtin(position) pos: vec4f, @location(0) l: vec2f, @location(1) s: vec2f, @location(2) @interpolate(flat) info: u32, @location(3) @interpolate(flat) col: vec3f };
@vertex fn vsMini(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: u32) -> MiniO {
  let kind = info & 255u;
  let q = quad(vi) * 2. - 1.;
  var ext = vec2f(p.z * select(1., 1.03, kind == 0u) + 1.5 / M.c.z);
  if (kind == 3u) { ext = vec2f(p.z, f32(info >> 8u) / 16777215.) + 6. / M.c.z; }
  let m = p.xy + q * ext;
  var o: MiniO;
  o.pos = vec4f(M.c.xy + vec2f(m.x, -m.y) * M.c.z * 2. / F.resWR.xy, 0., 1.);
  o.l = q * ext; o.s = ext; o.info = info; o.col = PAL[((info >> 8u) & 255u) % 12u].rgb; return o;
}
fn over(a: hv4, b: hv4) -> hv4 { return a + b * (hf(1.) - a.a); }
@fragment fn fsMini(i: MiniO) -> @location(0) vec4f {
  let kind = i.info & 255u; let aa = 1. / M.c.z;
  var c = hv4(0.);
  if (kind == 0u) {
    let d = length(i.l); let inside = hf(1. - smoothstep(1. - aa, 1. + aa, d));
    c = hv4(hv3(.047, .066, .118) * hf(.9), hf(.9)) * inside;
    c = over(hv4(hv3(.98, .44, .52) * hf(.07), hf(.07)) * hf(1. - smoothstep(.35 - aa, .35 + aa, d)), c);
    c = over(hv4(hv3(.98, .44, .52) * hf(.5), hf(.5)) * hf(1. - smoothstep(0., 2. * aa, abs(d - (1. - 2. * aa)))), c);
  } else if (kind == 1u) {
    let r = i.s.x - 1.5 * aa;
    let a = hf((1. - smoothstep(r - aa, r + aa, length(i.l))) * f32((i.info >> 16u) & 255u) / 255.);
    c = hv4(hv3(i.col) * a, a);
  } else if (kind == 2u) {
    let d = length(i.l); let r = i.s.x - 1.5 * aa;
    c = over(hv4(1.) * hf(1. - smoothstep(r * .55 - aa, r * .55 + aa, d)), hv4(hv3(.3), hf(.3)) * hf(1. - smoothstep(r - aa, r + aa, d)));
  } else {
    let h = i.s - 6. * aa; let e = abs(i.l) - h; let d = abs(max(e.x, e.y));
    let a = hf((1. - smoothstep(.5 * aa, 1.5 * aa, d)) * .4); c = hv4(hv3(a), a);
  }
  return vec4f(c);
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
  // ONE buffer mirrors the WASM per-frame block: frame uniforms + all instance data
  const A = E.arena, arenaBuf = buf(A.size, U.UNIFORM | U.VERTEX | U.COPY_DST);
  const miniUBuf = buf(16, U.UNIFORM | U.COPY_DST);
  const palBuf = buf(E.palette.byteLength, U.UNIFORM | U.COPY_DST);
  q.writeBuffer(palBuf, 0, E.palette);
  const trailBuf = buf(NS * RING * 4, U.STORAGE | U.COPY_DST);
  // trail copy on the GPU: rows of on-screen snakes are kept in sync by WASM's upload list
  const mips = (w, h) => 1 + Math.floor(Math.log2(Math.max(w, h)));
  const tileTex = device.createTexture({ size: [512, 296], format: "rg8unorm", mipLevelCount: mips(512, 296),
    usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT });
  const atlasTex = device.createTexture({ size: [E.AW, E.AH], format: "rgba8unorm", // drawn ~1:1 with the screen: no mips
    usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_DST });
  const linRep = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" }); // no anisotropy: the floor is seen straight on
  const linClamp = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });

  const V = GPUShaderStage.VERTEX, FR = GPUShaderStage.FRAGMENT;
  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: V | FR, buffer: {} },
    { binding: 1, visibility: FR, sampler: {} },
    { binding: 2, visibility: FR, texture: {} },
    { binding: 3, visibility: V, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: FR, texture: {} },
    { binding: 5, visibility: FR, sampler: {} },
    { binding: 6, visibility: V | FR, buffer: {} },
    { binding: 7, visibility: V, buffer: {} },
  ] });
  const bind = device.createBindGroup({ layout: bgl, entries: [
    { binding: 0, resource: { buffer: arenaBuf, offset: 0, size: 48 } }, { binding: 1, resource: linRep },
    { binding: 2, resource: tileTex.createView() }, { binding: 3, resource: { buffer: trailBuf } },
    { binding: 4, resource: atlasTex.createView() }, { binding: 5, resource: linClamp },
    { binding: 6, resource: { buffer: miniUBuf } },
    { binding: 7, resource: { buffer: palBuf } },
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
    bg: pipe("vsBg", "fsBg", [], undefined, format, false),
    food: pipe("vsFood", "fsFood", foodL, PREMUL),
    rib: pipe("vsRib", "fsRib", hdrL, PREMUL),
    lbl: pipe("vsLbl", "fsLbl", lblL, PREMUL),
    mini: pipe("vsMini", "fsMini", miniL, PREMUL),
  };

  // ---- one-off: bake the floor tile and its mipmaps ----
  const mipMod = device.createShaderModule({ code: MIP_WGSL });
  const mipPipe = device.createRenderPipeline({ layout: "auto", vertex: { module: mipMod, entryPoint: "vs" },
    fragment: { module: mipMod, entryPoint: "fs", targets: [{ format: "rg8unorm" }] }, primitive: { topology: "triangle-list" } });
  function genMips(tex) {
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
  // The five draws: [pipeline, vertex-data offset in the arena]
  const DRAWS = [[P.bg, -1], [P.food, A.inst], [P.rib, A.hdr], [P.lbl, A.hdr], [P.mini, A.mini]];
  // reused every frame: no per-frame allocations
  const counts = new Uint32Array([3, 1, 4, 0, 0, 0, 4, 0, 4, 0]); // (vertices, instances) x5
  const mainAtt = { view: null, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] };
  const mainDesc = { colorAttachments: [mainAtt] };
  // pairs (vertices, instances): floor, food, snakes, labels, minimap
  const setCounts = (food, maxK, nVis, nMini) => { counts[3] = food; counts[4] = 2 * (maxK + 3); counts[5] = nVis; counts[7] = nVis; counts[9] = nMini; };
  const encodeDirect = (pass, i) => {
    const [p, off] = DRAWS[i], vc = counts[i * 2], ic = counts[i * 2 + 1];
    if (!ic) return;
    pass.setPipeline(p);
    if (off >= 0) pass.setVertexBuffer(0, arenaBuf, off);
    pass.draw(vc, ic);
  };

  // ---- GPU timestamps (optional) ----
  let qset = null, resolveBuf = null, readBuf = null, reading = false, mapping = false;
  if (canTime) {
    qset = device.createQuerySet({ type: "timestamp", count: 12 });
    resolveBuf = device.createBuffer({ size: 96, usage: U.QUERY_RESOLVE | U.COPY_SRC });
    readBuf = device.createBuffer({ size: 96, usage: U.MAP_READ | U.COPY_DST });
  }
  const err = await device.popErrorScope();
  if (err) throw new Error("WebGPU setup: " + err.message);

  const R = {
    name: "WebGPU" + (F16 ? " (f16)" : ""), gpuMs: -1, passMs: null, canTime, device,
    passNames: ["clear", "floor", "food", "snakes", "labels", "map"],
    resize() {},
    placeMini(cx, cy, r) { q.writeBuffer(miniUBuf, 0, new Float32Array([cx, cy, r, 0])); },
    labelSlot(src, x, y) {
      q.copyExternalImageToTexture({ source: src }, { texture: atlasTex, origin: { x, y }, premultipliedAlpha: true }, [src.width, src.height]);
    },
    draw(frameNo, playing, timing) {
      const o = E.frameOut, instCount = o[0], nVis = o[1], maxK = o[2], nMini = playing ? o[4] : 0;
      // ONE upload for all per-frame data, straight from WebAssembly memory
      q.writeBuffer(arenaBuf, 0, E.mem, A.base, A.inst + instCount * 16);
      // trail: new points of snakes on screen only (runs listed by WASM)
      for (let i = 0, n = o[3]; i < n; i++) {
        const off = (E.tup[i * 3] * RING + E.tup[i * 3 + 1]) * 4;
        q.writeBuffer(trailBuf, off, E.mem, E.ptr.trail + off, E.tup[i * 3 + 2] * 4);
      }
      const enc = device.createCommandEncoder();
      const view = ctx.getCurrentTexture().createView();
      setCounts(instCount, maxK, nVis, nMini);
      if (!(timing && canTime && !reading)) {
        mainAtt.view = view;
        const pass = enc.beginRenderPass(mainDesc);
        pass.setBindGroup(0, bind);
        for (let i = 0; i < 5; i++) encodeDirect(pass, i);
        pass.end();
      } else { // measuring: the clear, then one pass per draw, each timestamped
        for (let i = 0; i < 6; i++) {
          const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: i ? "load" : "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
            timestampWrites: { querySet: qset, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } });
          if (i) { pass.setBindGroup(0, bind); encodeDirect(pass, i - 1); }
          pass.end();
        }
        enc.resolveQuerySet(qset, 0, 12, resolveBuf, 0);
        enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 96);
        reading = true;
      }
      q.submit([enc.finish()]);
      if (reading && !mapping) {
        mapping = true;
        readBuf.mapAsync(GPUMapMode.READ).then(() => {
          const t = new BigUint64Array(readBuf.getMappedRange());
          const ms = [0, 1, 2, 3, 4, 5].map((i) => Number(t[i * 2 + 1] - t[i * 2]) / 1e6);
          readBuf.unmap(); reading = mapping = false;
          if (ms.every((v) => v >= 0 && v < 1000)) { R.passMs = ms; R.gpuMs = ms.reduce((a, b) => a + b, 0); }
        }, () => { reading = mapping = false; });
      }
    },
  };
  return R;
}
