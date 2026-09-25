/* ============================================================================
   WebGL 2 renderer (fallback when WebGPU is unavailable).
   Interface shared with the WebGPU renderer:
     name, resize(vw, vh), placeMini(cx, cy, rPx), labelSlot(canvas, x, y),
     labelsDone(), draw(frameNo, playing, timing), gpuMs, passMs
   ========================================================================== */
function createGL(canvas, E) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: true, powerPreference: "high-performance" });
  if (!gl) return null;
  const { NS, RING } = E;
  const PAL = E.SKINS.map(([a, b]) => [a, b].map((h) => [1, 3, 5].map((i) => (parseInt(h.substr(i, 2), 16) / 255).toFixed(4)).join(",")));
  const palGLSL = `const vec3 SKA[12]=vec3[](${PAL.map((p) => `vec3(${p[0]})`).join(",")});
const vec3 SKB[12]=vec3[](${PAL.map((p) => `vec3(${p[1]})`).join(",")});`;
  // Per-frame values shared by every program: ONE uniform-buffer upload per frame.
  // highp members: fragment shaders below default to mediump (half precision on mobile GPUs)
  const FRAME = `layout(std140) uniform Frame { highp vec4 uCamHalf; highp vec4 uPxTime; highp vec4 uResWR; };`;

  const BG_VS = `#version 300 es
  void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.-1.,0,1); }`;
  // One hex period rendered once into a mipmapped texture: sampling it is
  // cheaper than the math and mipmaps stop the thin lines shimmering at zoom-out.
  const TILE_FS = `#version 300 es
  precision highp float;
  uniform vec2 uSize; out vec4 o;
  float hexD(vec2 p){ p=abs(p); return max(dot(p,vec2(.8660254,.5)),p.y); }
  void main(){
    vec2 uv=gl_FragCoord.xy/uSize*vec2(1.7320508,1.);
    const vec2 R=vec2(1.7320508,1.); vec2 H=R*.5;
    vec2 a=mod(uv,R)-H, b=mod(uv-H,R)-H; vec2 g=dot(a,a)<dot(b,b)?a:b;
    float e=.5-hexD(g);
    // two blend factors only (RG8: half the bytes of RGBA8); colours are applied when drawing
    o=vec4(smoothstep(.0,.5,e), 1.-smoothstep(.0,.03,e), 0, 1);
  }`;
  const BGW_VS = `#version 300 es
  ${FRAME}
  out vec2 vW, vN;
  void main(){
    vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.-1.;
    gl_Position=vec4(p,0,1); vN=p; vW=uCamHalf.xy+vec2(p.x,-p.y)*uCamHalf.zw; // interpolated: no per-pixel maths
  }`;
  const BG_FS = `#version 300 es
  precision highp float;
  in vec2 vW, vN;
  ${FRAME}
  uniform sampler2D uTile;
  out vec4 o;
  void main(){
    vec2 ndc=vN, w=vW;
    float px=uCamHalf.w*2./uResWR.y/46.;
    vec2 tf=texture(uTile, w/46./vec2(1.7320508,1.)).rg;
    vec3 col=mix(mix(vec3(.052,.066,.108),vec3(.07,.088,.14),tf.x),vec3(.028,.035,.06),tf.y*.85);
    float WRr=uResWR.z, r=length(w), rw=14.+px*46.;
    if(r>WRr-2.) col=mix(col,col*vec3(.55,.22,.28)+vec3(.05,0,.01),smoothstep(WRr-2.,WRr+2.,r));
    if(abs(r-WRr)<rw*6.) col+=vec3(1.,.25,.35)*exp(-abs(r-WRr)/rw)*(.7+.3*sin(uPxTime.y*3.))*.55;
    // faint glow over the crowded centre zone
    if(r<WRr*.37) col+=vec3(.9,.3,.4)*.035*(1.-smoothstep(WRr*.3,WRr*.37,r));
    col*=1.-.35*dot(ndc*.72,ndc*.72);
    o=vec4(col,1);
  }`;

  // Food: instanced glowing orbs.
  const VS = `#version 300 es
  ${FRAME}
  layout(location=0) in vec3 aP; layout(location=1) in uvec4 aI;
  out vec2 vL; out float vR; flat out uvec4 vI;
  void main(){
    vec2 q = vec2(float(gl_VertexID&1), float(gl_VertexID>>1))*2.-1.;
    bool tiny = aP.z/uPxTime.x < 1.6;                       // pellet under ~1.6 px: no halo
    vec2 l = q*(tiny ? aP.z*.7+uPxTime.x*1.5 : aP.z*1.9);
    vec2 c = (aP.xy+l-uCamHalf.xy)/uCamHalf.zw;
    gl_Position = vec4(c.x,-c.y,0,1);
    vL=l; vR=aP.z; vI=aI;
  }`;
  const FS = `#version 300 es
  precision mediump float;
  ${palGLSL}
  ${FRAME}
  in vec2 vL; in float vR; flat in uvec4 vI;
  out vec4 o;
  void main(){
    float d=length(vL), r=vR, aa=uPxTime.x*1.2;
    vec3 c=SKA[vI.y%12u];
    highp float ph=uPxTime.y*4.+float(vI.z)*.0245;
    float pulse=.75+.25*sin(ph);
    float born=smoothstep(0.,10.,float(vI.w));   // fade in over ~0.6 s: no popping
    float rr=r*(.4+.6*born);
    float core=(1.-smoothstep(rr*.7-aa,rr*.7+aa,d))*born;
    float t=min(d/(rr*1.9),1.), g=1.-t*t;
    float glow = r/uPxTime.x < 1.6 ? 0. : g*g*pulse*born; // fuller halo, still 0 at the quad edge
    o=vec4(c*glow + mix(c,vec3(1),.55*(1.-d/(rr*.7)))*core, core);
  }`;

  // Snakes: the GPU builds the ribbons itself ("vertex pulling"). Each instance
  // is one visible snake; its vertices read trail points straight out of an
  // RG16I texture that is a byte copy of WebAssembly memory. CPU work per snake:
  // one 48-byte header.
  const RVS = `#version 300 es
  precision highp float; precision highp int; precision highp isampler2D;
  ${FRAME}
  uniform highp isampler2D uTrail;
  layout(location=0) in vec4 aH0;  // head x, y, u, radius
  layout(location=1) in vec4 aH1;  // spacing, stride, angle, width factor
  layout(location=2) in uvec4 aH2; // row, newest trail index, segments, skin|flags<<8
  out float vT, vV; out vec2 vDir; flat out uint vSk, vFl; flat out float vR, vNl;
  const float CR=1./.42;
  vec2 T(int k){ return vec2(texelFetch(uTrail, ivec2((int(aH2.y)-k)&${RING - 1}, int(aH2.x)), 0).rg)*.25; }
  vec2 body(int i){ return i<=0 ? aH0.xy : mix(T(i-1),T(i),aH0.z); }
  vec2 fwd(){ return vec2(cos(aH1.z),sin(aH1.z)); }
  // strip order: tail cap, body samples tail->head, head, head cap
  vec3 seqPt(int j,int n,int st,int K){
    if(j<=0){ vec2 a=body(n-1), d=a-body(n-2); float l=length(d); d=l>1e-3?d/l:-fwd(); return vec3(a+d*aH0.w*aH1.w, float(n-1)+CR*aH1.w); }
    if(j<=K){ int i=max(n-1-(j-1)*st,1); return vec3(body(i),float(i)); }
    if(j==K+1) return vec3(aH0.xy,0.);
    return vec3(aH0.xy+fwd()*aH0.w*aH1.w,-CR*aH1.w); // caps as wide as the glow
  }
  void main(){
    int n=int(aH2.z), st=int(aH1.y), K=(n-1+st-1)/st, last=K+2;
    int j=min(gl_VertexID>>1,last); bool side=(gl_VertexID&1)==0;
    vec3 p=seqPt(j,n,st,K);
    vec2 tg=seqPt(min(j+1,last),n,st,K).xy-seqPt(max(j-1,0),n,st,K).xy;
    float tl=length(tg); tg=tl>1e-4?tg/tl:fwd();
    vec2 nrm=vec2(-tg.y,tg.x)*aH0.w*aH1.w;
    vec2 c=(p.xy+(side?nrm:-nrm)-uCamHalf.xy)/uCamHalf.zw;
    gl_Position=vec4(c.x,-c.y,0,1);
    vT=p.z; vV=side?aH1.w:-aH1.w; vDir=tg;
    vSk=(aH2.w&255u)%12u; vFl=aH2.w>>8; vR=aH0.w; vNl=float(n-1);
  }`;
  const RFS = `#version 300 es
  precision highp float;
  ${palGLSL}
  ${FRAME}
  in float vT, vV; in vec2 vDir; flat in uint vSk, vFl; flat in float vR, vNl;
  out vec4 o;
  const float SP=.42, CR=1./.42;
  vec3 shade(float k, vec2 l, float nd, vec2 f){
    uint ki=uint(k);
    vec3 base = ki==0u ? SKA[vSk] : (((ki>>2u)&1u)==0u ? SKA[vSk] : SKB[vSk]);
    base=mix(base,SKB[vSk]*.85,smoothstep(.45,1.,abs(vV))*.35);   // flanks lean darker: rounder body
    vec3 c=base*(1.08-.5*nd*nd);                                   // spherical scale
    c*=1.+.16*clamp(dot(l,f),0.,1.);                               // front of each scale lit: layered scales
    vec2 sp=l-vec2(-.28,-.36);
    c+=vec3(.3)*exp(-dot(sp,sp)*8.);                               // specular
    c=mix(c*.42,c,1.-smoothstep(.78,1.,nd));                       // crisp scale outline
    if(ki==0u){ // head: eyes with a glint
      vec2 sd=vec2(-f.y,f.x); float aa=uPxTime.x*1.2/vR;
      for(int e=0;e<2;e++){
        vec2 ec=f*.32+sd*(e==0?.45:-.45), pc=ec+f*.11;
        c=mix(c,vec3(.97),1.-smoothstep(.32-aa,.32+aa,length(l-ec)));
        c=mix(c,vec3(.03,.04,.07),1.-smoothstep(.17-aa,.17+aa,length(l-pc)));
        c=mix(c,vec3(1),1.-smoothstep(.055-aa,.055+aa,length(l-pc-f*.05+sd*.06)));
      }
    }
    return c;
  }
  void main(){
    float aa=uPxTime.x*1.2/vR, av=abs(vV);
    vec2 f=normalize(vDir), side=vec2(-f.y,f.x);
    float h=av<1. ? sqrt(1.-av*av)*CR : 0.;
    float k0=clamp(av<1. ? ceil(vT-h) : floor(vT+.5), 0., vNl), k1=min(k0+1.,vNl);
    vec2 l0=-f*(vT-k0)*SP+side*vV, l1=-f*(vT-k1)*SP+side*vV;
    float n0=length(l0), n1=length(l1);
    float e0=1.-smoothstep(1.-aa,1.+aa,n0), e1=(1.-smoothstep(1.-aa,1.+aa,n1))*(1.-e0);
    float a=e0+e1, glow=0.;
    vec3 gc=SKA[vSk]*1.2;
    float gd=min(n0,n1); // distance to the nearest scale circle: round glow, also at head and tail
    if((vFl&1u)!=0u) glow=exp(-pow(max(gd-.8,0.)/.45,2.))*(.55+.25*sin(uPxTime.y*18.))*(1.-a);
    else if((vFl&4u)!=0u){ glow=exp(-pow(max(gd-.85,0.)/.3,2.))*(.45+.15*sin(uPxTime.y*2.5+vT*.3))*(1.-a); gc=vec3(1.,.78,.3); }
    if(a<=0. && glow<=.003) discard;
    vec3 c=(e0>0. ? shade(k0,l0,n0,f)*e0 : vec3(0)) + (e1>0. ? shade(k1,l1,n1,f)*e1 : vec3(0));
    if((vFl&4u)!=0u) c+=vec3(1.,.85,.4)*.18*a*(.5+.5*sin(vT*.8-uPxTime.y*3.)); // shimmering scales
    o=vec4(c+gc*glow, a);
  }`;

  // Name + level labels: pre-drawn once per snake into a texture atlas, drawn
  // as one instanced quad per visible snake at a constant on-screen size.
  const LVS = `#version 300 es
  ${FRAME}
  layout(location=0) in vec4 aH0; layout(location=2) in uvec4 aH2;
  uniform vec2 uSlot, uCells; // slot size in CSS px, atlas grid
  out vec2 vUV;
  void main(){
    vec2 q=vec2(float(gl_VertexID&1), float(gl_VertexID>>1));     // 0..1, y down
    vec2 c=(aH0.xy-vec2(0.,aH0.w*1.25)-uCamHalf.xy)/uCamHalf.zw;   // anchor just above the head
    vec2 off=vec2(q.x-.5, q.y-1.)*uSlot*uPxTime.z;                // screen px, y down
    gl_Position=vec4(c.x+off.x*2./uResWR.x, -c.y-off.y*2./uResWR.y, 0, 1);
    float slot=float(aH2.x);
    vUV=(vec2(mod(slot,uCells.x), floor(slot/uCells.x))+q)/uCells;
  }`;
  const LFS = `#version 300 es
  precision mediump float;
  uniform sampler2D uAtlas; in vec2 vUV; out vec4 o;
  void main(){ o=texture(uAtlas,vUV); }`;

  // Minimap: one instanced draw in a corner of the same canvas (no Canvas2D).
  const MVS = `#version 300 es
  layout(location=0) in vec3 aP; layout(location=1) in uint aI;
  uniform vec3 uMini; // centre (clip) and radius in device px
  uniform vec2 uRes;
  out vec2 vL; out vec2 vS; flat out uint vI;
  void main(){
    uint kind=aI&255u;
    vec2 q=vec2(float(gl_VertexID&1), float(gl_VertexID>>1))*2.-1.;
    vec2 ext = kind==3u ? vec2(aP.z, float(aI>>8)/16777215.) + 6./uMini.z : vec2(aP.z*(kind==0u?1.03:1.) + 1.5/uMini.z);
    vec2 m=aP.xy+q*ext;                       // minimap units (disc radius 1), y down
    gl_Position=vec4(uMini.xy+vec2(m.x,-m.y)*uMini.z*2./uRes,0,1);
    vL=q*ext; vS=ext; vI=aI;
  }`;
  const MFS = `#version 300 es
  precision mediump float;
  ${palGLSL}
  uniform highp vec3 uMini;
  in vec2 vL; in vec2 vS; flat in uint vI; out vec4 o;
  vec4 over(vec4 a, vec4 b){ return a+b*(1.-a.a); } // premultiplied "a over b"
  void main(){
    uint kind=vI&255u; float aa=1./uMini.z; vec4 c=vec4(0);
    if(kind==0u){ // backdrop + centre zone + rim
      float d=length(vL), in_=1.-smoothstep(1.-aa,1.+aa,d);
      c=vec4(vec3(.047,.066,.118)*.9,.9)*in_;
      c=over(vec4(vec3(.98,.44,.52)*.07,.07)*(1.-smoothstep(.35-aa,.35+aa,d)), c);
      c=over(vec4(vec3(.98,.44,.52)*.5,.5)*(1.-smoothstep(0.,2.*aa,abs(d-(1.-2.*aa)))), c);
    } else if(kind==1u){
      float r=vS.x-1.5*aa, a=(1.-smoothstep(r-aa,r+aa,length(vL)))*float((vI>>16)&255u)/255.;
      c=vec4(SKA[(vI>>8)&255u]*a,a);
    } else if(kind==2u){ // you
      float d=length(vL), r=vS.x-1.5*aa;
      c=over(vec4(vec3(1),1)*(1.-smoothstep(r*.55-aa,r*.55+aa,d)), vec4(vec3(.3),.3)*(1.-smoothstep(r-aa,r+aa,d)));
    } else { // view rectangle outline
      vec2 h=vS-6.*aa, e=abs(vL)-h; float d=abs(max(e.x,e.y));
      float a=(1.-smoothstep(.5*aa,1.5*aa,d))*.4; c=vec4(vec3(a),a);
    }
    o=c;
  }`;


  function prog(vs, fs, ubo = true) {
    const p = gl.createProgram();
    for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    if (ubo) gl.uniformBlockBinding(p, gl.getUniformBlockIndex(p, "Frame"), 0);
    return p;
  }
  const bgP = prog(BGW_VS, BG_FS), foodP = prog(VS, FS), ribP = prog(RVS, RFS), lblP = prog(LVS, LFS), miniP = prog(MVS, MFS, false);

  // Textures live on fixed units for the whole run (no per-frame rebinding):
  // unit 0 trail (two, alternating), unit 1 floor tile, unit 2 label atlas.
  const tileTex = gl.createTexture();
  {
    const TW = 512, TH = 296, tp = prog(BG_VS, TILE_FS, false);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tileTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.floor(Math.log2(TW)), gl.RG8, TW, TH);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tileTex, 0);
    gl.viewport(0, 0, TW, TH); gl.useProgram(tp); gl.uniform2f(gl.getUniformLocation(tp, "uSize"), TW, TH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // no anisotropic filtering: the floor is always seen straight on, so it would cost time for nothing
  }
  const atlas = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, atlas);
  gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.floor(Math.log2(Math.max(E.AW, E.AH))), gl.RGBA8, E.AW, E.AH);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);

  gl.useProgram(bgP); gl.uniform1i(gl.getUniformLocation(bgP, "uTile"), 1);
  gl.useProgram(ribP); gl.uniform1i(gl.getUniformLocation(ribP, "uTrail"), 0);
  gl.useProgram(lblP);
  gl.uniform1i(gl.getUniformLocation(lblP, "uAtlas"), 2);
  gl.uniform2f(gl.getUniformLocation(lblP, "uSlot"), E.SLOT_W, E.SLOT_H);
  gl.uniform2f(gl.getUniformLocation(lblP, "uCells"), E.CELLS_X, E.CELLS_Y);

  // ONE buffer per frame mirrors the WASM per-frame block (uniforms + all instance
  // data), double-buffered so the CPU never waits for the GPU. The UBO is a range of it.
  const A = E.arena, arena = [], foodVao = [], hdrVao = [], miniVao = [];
  const inst = (loc, n, type, stride, off, int) => {
    gl.enableVertexAttribArray(loc);
    if (int) gl.vertexAttribIPointer(loc, n, type, stride, off); else gl.vertexAttribPointer(loc, n, type, false, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  };
  for (let i = 0; i < 2; i++) {
    arena[i] = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, arena[i]);
    gl.bufferData(gl.ARRAY_BUFFER, A.size, gl.DYNAMIC_DRAW);
    foodVao[i] = gl.createVertexArray(); gl.bindVertexArray(foodVao[i]);
    inst(0, 3, gl.FLOAT, 16, A.inst); inst(1, 4, gl.UNSIGNED_BYTE, 16, A.inst + 12, true);
    hdrVao[i] = gl.createVertexArray(); gl.bindVertexArray(hdrVao[i]);
    inst(0, 4, gl.FLOAT, 48, A.hdr); inst(1, 4, gl.FLOAT, 48, A.hdr + 16); inst(2, 4, gl.UNSIGNED_INT, 48, A.hdr + 32, true);
    miniVao[i] = gl.createVertexArray(); gl.bindVertexArray(miniVao[i]);
    inst(0, 3, gl.FLOAT, 16, A.mini); inst(1, 1, gl.UNSIGNED_INT, 16, A.mini + 12, true);
  }
  // Trail: one RG16I texture; rows of on-screen snakes are kept in sync from WASM's upload list.
  const trailTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, trailTex); // unit 0
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16I, RING, NS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const emptyVao = gl.createVertexArray();
  gl.bindVertexArray(null);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied (enabled after the floor)

  // GPU timing per pass (EXT_disjoint_timer_query_webgl2), read back without stalling.
  const tq = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const pending = []; // frames of 5 queries
  const miniU = gl.getUniformLocation(miniP, "uMini"), miniRes = gl.getUniformLocation(miniP, "uRes");
  let vw = 1, vh = 1;

  const R = {
    name: "WebGL 2", gpuMs: -1, passMs: null, canTime: !!tq, passNames: ["floor", "food", "snakes", "labels", "map"],
    resize(w, h) { vw = w; vh = h; },
    placeMini(cx, cy, r) { gl.useProgram(miniP); gl.uniform3f(miniU, cx, cy, r); gl.uniform2f(miniRes, vw, vh); },
    labelSlot(src, x, y) {
      gl.activeTexture(gl.TEXTURE2);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.activeTexture(gl.TEXTURE0);
    },
    labelsDone() { gl.activeTexture(gl.TEXTURE2); gl.generateMipmap(gl.TEXTURE_2D); gl.activeTexture(gl.TEXTURE0); },
    draw(frameNo, playing, timing) {
      const o = E.frameOut, instCount = o[0], nVis = o[1], maxK = o[2], nMini = playing ? o[4] : 0;
      const f = frameNo & 1;
      const qs = timing && tq && pending.length < 3 ? [] : null;
      const mark = () => { if (!qs) return; if (qs.length) gl.endQuery(tq.TIME_ELAPSED_EXT); const q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); qs.push(q); };
      // ONE upload: uniforms + snake headers + minimap + used food, from WASM memory
      gl.bindBuffer(gl.ARRAY_BUFFER, arena[f]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, E.arenaBytes, 0, A.inst + instCount * 16);
      gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, arena[f], 0, 48);

      // trail: new points of snakes on screen only (runs listed by WASM), unit 0
      for (let i = 0, n = o[3]; i < n; i++) {
        const row = E.tup[i * 3], x = E.tup[i * 3 + 1];
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, row, E.tup[i * 3 + 2], 1, gl.RG_INTEGER, gl.SHORT, E.trail, (row * RING + x) * 2);
      }
      // last frame's pixels are never needed: lets tiled/integrated GPUs skip reloading them
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR]);
      gl.viewport(0, 0, vw, vh);

      mark(); // floor: opaque, so no blending (saves reading the whole screen back)
      gl.disable(gl.BLEND);
      gl.useProgram(bgP); gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.BLEND);
      mark(); // food
      if (instCount) { gl.useProgram(foodP); gl.bindVertexArray(foodVao[f]); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instCount); }
      mark(); // snakes
      if (nVis) { gl.useProgram(ribP); gl.bindVertexArray(hdrVao[f]); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (maxK + 3), nVis); }
      mark(); // labels (same headers)
      if (nVis) { gl.useProgram(lblP); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nVis); }
      mark(); // minimap
      if (nMini) { gl.useProgram(miniP); gl.bindVertexArray(miniVao[f]); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nMini); }
      if (qs) { gl.endQuery(tq.TIME_ELAPSED_EXT); pending.push(qs); }
      while (pending.length && gl.getQueryParameter(pending[0][4], gl.QUERY_RESULT_AVAILABLE)) {
        const done = pending.shift(), ok = !gl.getParameter(tq.GPU_DISJOINT_EXT);
        const ms = done.map((q) => { const v = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; gl.deleteQuery(q); return v; });
        if (ok) { R.passMs = ms; R.gpuMs = ms.reduce((a, b) => a + b, 0); }
      }
    },
  };
  return R;
}
