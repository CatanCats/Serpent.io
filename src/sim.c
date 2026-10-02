/*
 * Serpent.io simulation core, compiled to WebAssembly (no libc, no malloc).
 *
 * All state is static, so JS makes typed-array views once and never allocates.
 * One exported call per frame, frame(), runs input -> fixed 60 Hz steps ->
 * interpolation -> camera -> culling -> GPU data, and writes everything the GPU
 * needs into one contiguous block that JS uploads as-is.
 *
 *  - Bodies are never moved: each snake is a ring buffer of its head's trail
 *    (16-bit fixed point). A step pushes a point only when the head has moved
 *    one segment spacing, so movement is O(1) per snake. Segments are the trail
 *    sampled at equal arc length (the GPU does the sampling).
 *  - Detail only where the player looks: snakes near the camera get collisions,
 *    eating and real AI; the rest move at quarter rate and live or die by a
 *    per-tier statistical model. Food and the collision/AI maps exist only
 *    around the camera, so cost does not grow with the map.
 *  - Body grid and food grid are exact: a trail point is linked into its cell
 *    when the head lays it and unlinked the moment it leaves the tail (or the
 *    snake dies); the bots' danger map counts occupants per cell, so it is exact
 *    too. Nothing is rebuilt every few steps and no query checks "still alive?".
 *    Queries visit only the cells their reach overlaps.
 *  - Food cells are exact: a pellet is linked into its grid cell when it spawns
 *    and unlinked the moment it is eaten or moves out, so eating, bots and the
 *    renderer walk only pellets that really are there, with no "still here?"
 *    tests. Each frame the pellets of the cells in view are copied (8 bytes
 *    each, already in the GPU's vertex layout) into the draw list.
 */
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;

#define EXPORT(n) __attribute__((export_name(n)))
#define PI 3.14159265f
#define TAU 6.28318531f
#define MAXS 64          /* snakes (slot 0 = player) */
#define RING 512         /* trail ring per snake (power of two) */
#define RMASK (RING - 1)
#define MAXSEG (RING - 1)
#define MAXF 8192        /* food pellets */
#define WR 8000.f        /* world radius */
#define CELL 100.f       /* spatial hash cell size (>= max query radius) */
#define GN 160           /* grid cells per side: 2*WR/CELL */
#define GC (GN * GN)
#define MC 32.f          /* owner-map cell */
#define MN 320           /* owner-map window (cells per side), follows the player */
#define NODES (MAXS * RING) /* body grid: one fixed node per trail slot */
#define REBUILD 32       /* steps between food tidy-ups */

/* Freestanding: the compiler may call these; with -mbulk-memory they become the
   native memory.copy / memory.fill instructions. */
void *memcpy(void *d, const void *s, unsigned long n) { __builtin_memcpy(d, s, n); return d; }
void *memset(void *d, int v, unsigned long n) { __builtin_memset(d, v, n); return d; }

/* ---------- math (no libm available) ---------- */
static float sqrtf_(float x) { return __builtin_sqrtf(x); }
static float absf(float x) { return __builtin_fabsf(x); }
static float minf(float a, float b) { return a < b ? a : b; }
static float maxf(float a, float b) { return a > b ? a : b; }
static float wrapa(float a) {
  while (a > PI) a -= TAU;
  while (a < -PI) a += TAU;
  return a;
}
static float sinf_(float x) {
  x = wrapa(x);
  if (x > PI * 0.5f) x = PI - x;
  else if (x < -PI * 0.5f) x = -PI - x;
  float x2 = x * x;
  return x * (1.f + x2 * (-1.f / 6 + x2 * (1.f / 120 + x2 * (-1.f / 5040 + x2 * (1.f / 362880)))));
}
static float cosf_(float x) { return sinf_(x + PI * 0.5f); }
static float atan2f_(float y, float x) {
  float ax = absf(x), ay = absf(y);
  float mx = maxf(ax, ay), mn = minf(ax, ay);
  if (mx == 0.f) return 0.f;
  float a = mn / mx, s = a * a;
  float r = ((-0.0464964749f * s + 0.15931422f) * s - 0.327622764f) * s * a + a;
  if (ay > ax) r = PI * 0.5f - r;
  if (x < 0) r = PI - r;
  if (y < 0) r = -r;
  return r;
}

/* ---------- rng (xorshift32) ---------- */
static u32 rs = 0x9E3779B9u;
static u32 rnd(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static float frand(void) { return (float)(rnd() >> 8) * (1.f / 16777216.f); }

/* ---------- state ---------- */
typedef struct {
  float ang, tang, mass, r, spacing, dropT, dropMass, aiT, tx, ty, respawnT, huntT, hx, hy;
  float dcx, dcy; /* heading as a unit vector (no trig per step) */
  i32 n, alive, boost, wantBoost, skin, kills, target, tier, near, orbit, seen; /* seen: drawn last frame */
  float rushT;
  u32 pc; /* trail points pushed so far (monotonic across lives) */
  u32 tail; /* oldest trail point linked into the body grid: [tail, pc) are linked */
  float phx, phy; u32 ppc; /* state before the last fixed step (render interpolation) */
} Snake;

static Snake S[MAXS];
/* trail, fixed point (Q2), interleaved x,y: a byte copy goes to the GPU */
static short tr[MAXS][RING][2];
static i32 NS = 40;

/* Food, 8 bytes per pellet, in the exact layout the GPU draws from.
   v = value in 1/16ths (0 = empty slot), born = tick/4 at spawn (fade-in). */
typedef struct { short x, y; u8 v, skin; unsigned short born; } Food;
static Food F[MAXF];
static short freeList[MAXF]; /* empty slots below foodHigh */
static i32 nfree, foodHigh, foodNear; /* foodNear: pellets inside the food disk */
#define FOOD_DENSITY 7.2e-5f /* pellets per square unit around the player */
static float frT[256]; /* pellet radius by value byte (the food shader has the same formula) */
#define FV(i) ((float)F[i].v * (1.f / 16.f))

/* body grid: cell -> first node; node = snake * RING + ring slot (so the snake and
   the point come straight from the node number) */
static i32 gHead[GC], gNext[NODES], gPrev[NODES], gCell[NODES], gOm[NODES];
/* food cells: exact doubly linked lists (fCell = the cell a pellet is in, -1 = none) */
static short fHead[GC], fNext[MAXF], fPrev[MAXF], fCell[MAXF];
/* one bit per cell: has food. Lets the renderer jump straight to non-empty cells. */
#define FW (GN / 32) /* 32-bit words per grid row (GN = 160: 5) */
static u32 fBits[GN * FW];

/* Level of detail: only snakes near the focus (the camera) get collisions,
   eating and real AI. Everything else runs a cheap statistical model. */
static float focX, focY, focR = 2000.f;
static float foodR(void) { return focR * 1.25f; } /* food exists inside this disk */

/* Bot tiers: rookie, casual, hunter, elite, legend */
#define LEGEND 4
static const i32 T_EVERY[5] = {4, 2, 2, 1, 1};                    /* think every N steps */
static const float T_LOOK[5] = {0.6f, 1.f, 1.2f, 1.45f, 1.8f};    /* probe reach */
static const float T_AGGR[5] = {0.f, 0.25f, 0.6f, 1.f, 0.25f};    /* hunting appetite (legends survive by staying calm) */
static const float T_NOISE[5] = {0.35f, 0.12f, 0.04f, 0.f, 0.f};  /* steering sloppiness */
/* The "dumb equation" used out of the player's view: growth and death odds by tier */
static const float T_GROW[5] = {0.05f, 0.3f, 1.3f, 3.2f, 5.f};    /* mass/s */
static const float T_RISK[5] = {1.f / 35, 1.f / 90, 1.f / 400, 1.f / 6000, 0.f}; /* deaths/s */
static const float T_CAP[5] = {150.f, 450.f, 1500.f, 3500.f, 6000.f};
static const float T_MASS0[5] = {10.f, 10.f, 30.f, 120.f, 1500.f}; /* spawn mass: base */
static const float T_MASS[5] = {40.f, 150.f, 450.f, 1200.f, 2500.f}; /*   + spread */

/* cos/sin of k*spread for k = -half..half (steering candidates), filled in init() */
static float ROT[13 * 2], ROT_WIDE[7 * 2];

/* recent death (vultures: hunters and above rush to the food) */
static float deathX, deathY; static u32 deathTick = 0xffff0000u;

static u8 omap[MN * MN + 16];              /* owner of each cell: 0 none, s+1, 255 several (+16: SWAR reads) */
static unsigned short ocnt[MN * MN];        /* body points in each cell, so it empties exactly */
static float omX0 = -MN * MC * 0.5f, omY0 = -MN * MC * 0.5f; /* world position of the window's corner */

typedef struct { float hx, hy, u, r, spacing, stride, ang, W; u32 row, newest, n, info; } Head;
typedef struct { float x, y, size; u32 info; } Mini; /* info: kind | skin<<8 | alpha<<16, rect: kind | halfH<<8 */
/* GPU copy of the trails: only snakes on screen are kept in sync. For each one we
   send just the points pushed since its last sync (a contiguous run of the ring,
   split in two where it wraps), or the whole row if it is stale or respawned. */
static u32 gpuPc[MAXS]; static u8 gpuOk[MAXS];
static u32 tup[MAXS * 2 * 3], ntup; /* (row, first index, count) */
static void trailSync(i32 s) {
  Snake *k = &S[s];
  u32 from = gpuPc[s];
  if (!gpuOk[s] || k->pc - from >= RING) { tup[ntup * 3] = (u32)s; tup[ntup * 3 + 1] = 0; tup[ntup * 3 + 2] = RING; ntup++; }
  else if (k->pc != from) {
    u32 a = from & RMASK, n = k->pc - from;
    u32 first = a + n > RING ? RING - a : n;
    tup[ntup * 3] = (u32)s; tup[ntup * 3 + 1] = a; tup[ntup * 3 + 2] = first; ntup++;
    if (first < n) { tup[ntup * 3] = (u32)s; tup[ntup * 3 + 1] = 0; tup[ntup * 3 + 2] = n - first; ntup++; }
  }
  gpuPc[s] = k->pc; gpuOk[s] = 1;
}

/* Everything the GPU needs each frame, contiguous so it goes up in ONE upload:
   frame uniforms | snake headers | minimap | food (only the used prefix). */
static struct {
  float frameBlk[12];  /* std140 Frame block: camX camY halfW halfH | px time lblScale tick/4 | vw vh WR 0 */
  Head hdr[MAXS];
  Mini mini[MAXS + 4];
  Food vis[MAXF];       /* this frame's pellets in view, copied from F */
} AR __attribute__((aligned(16)));
#define frameBlk AR.frameBlk
#define hdr AR.hdr
#define mini AR.mini
#define VIS AR.vis

static u32 tick;
static i32 playerKiller = -1;

#define DT (1.f / 60.f)

/* ---------- helpers ---------- */
static i32 cellX(float x) { i32 c = (i32)((x + WR) * (1.f / CELL)); return c < 0 ? 0 : c >= GN ? GN - 1 : c; }
static i32 cellOf(float x, float y) { return cellX(y) * GN + cellX(x); }
/* for each grid cell overlapping the square (x +- R, y +- R): usually 1-4 cells, not a fixed 3x3 */
#define FOR_CELLS(x, y, R, c) \
  for (i32 gy_ = cellX((y) - (R)), gy1_ = cellX((y) + (R)), gx0_ = cellX((x) - (R)), gx1_ = cellX((x) + (R)); gy_ <= gy1_; gy_++) \
    for (i32 gx_ = gx0_, c; gx_ <= gx1_ && (c = gy_ * GN + gx_, 1); gx_++)

/* fixed point Q2: +-8191 units at 0.25 precision (sub-pixel at normal zoom) */
static short fix(float v) { v *= 4.f; v += v >= 0 ? 0.5f : -0.5f; return (short)(v > 32767.f ? 32767.f : v < -32767.f ? -32767.f : v); }
#define UQ(v) ((float)(v) * 0.25f)
/* trail point j (0 = newest) */
#define TX(s, j) UQ(tr[s][(S[s].pc - 1u - (u32)(j)) & RMASK][0])
#define TY(s, j) UQ(tr[s][(S[s].pc - 1u - (u32)(j)) & RMASK][1])

/* growth curves (slow on purpose: size is earned) */
static float radiusFor(float m) { return minf(10.f + sqrtf_(m) * 0.45f, 40.f); }
static i32 segsFor(float m) { i32 n = 14 + (i32)(3.6f * sqrtf_(m)); return n > MAXSEG ? MAXSEG : n; }

/* ---------- spatial hash ---------- */
/* Link trail point pc of snake s into the body grid and the danger map. Integer
   maths straight on the 16-bit point (Q2: quarter units). */
static void segLink(i32 s, u32 pc) {
  i32 node = s * RING + (i32)(pc & RMASK);
  i32 xq = tr[s][pc & RMASK][0], yq = tr[s][pc & RMASK][1];
  i32 mx = (xq - (i32)omX0 * 4) >> 7, my = (yq - (i32)omY0 * 4) >> 7; /* danger-map cell: 32 units = 128 Q2 */
  /* only points inside the window around the player matter: nothing far away is
     ever collision-tested (far snakes use the statistical model) */
  if ((u32)mx >= MN || (u32)my >= MN) { gCell[node] = -1; return; }
  i32 gx = (xq + (i32)(WR * 4.f)) / (i32)(CELL * 4.f), gy = (yq + (i32)(WR * 4.f)) / (i32)(CELL * 4.f);
  gx = gx < 0 ? 0 : gx >= GN ? GN - 1 : gx; gy = gy < 0 ? 0 : gy >= GN ? GN - 1 : gy;
  i32 cell = gy * GN + gx, h = gHead[cell];
  gCell[node] = cell; gPrev[node] = -1; gNext[node] = h;
  if (h >= 0) gPrev[h] = node;
  gHead[cell] = node;
  i32 om = my * MN + mx; u8 v = (u8)(s + 1);
  gOm[node] = om;
  omap[om] = ocnt[om]++ == 0 || omap[om] == v ? v : 255;
}
static void segUnlink(i32 node) {
  i32 c = gCell[node], p = gPrev[node], n = gNext[node];
  if (c < 0) return;
  if (p >= 0) gNext[p] = n; else gHead[c] = n;
  if (n >= 0) gPrev[n] = p;
  gCell[node] = -1;
  i32 om = gOm[node];
  if (--ocnt[om] == 0) omap[om] = 0;
}
/* Keep exactly the newest n points of snake s linked: [pc - n, pc). Called after
   it moves, grows or shrinks, so the tail leaves the grid the moment it leaves the body. */
static void syncBody(i32 s) {
  Snake *k = &S[s];
  u32 want = k->pc - (u32)k->n;
  while ((i32)(want - k->tail) > 0) { segUnlink(s * RING + (i32)(k->tail & RMASK)); k->tail++; }
  while ((i32)(k->tail - want) > 0) { k->tail--; segLink(s, k->tail); }
}
static void unlinkBody(i32 s) {
  Snake *k = &S[s];
  while (k->tail != k->pc) { segUnlink(s * RING + (i32)(k->tail & RMASK)); k->tail++; }
}
static void foodLink(i32 i, i32 c) {
  i32 h = fHead[c];
  fCell[i] = (short)c; fPrev[i] = -1; fNext[i] = (short)h;
  if (h >= 0) fPrev[h] = (short)i;
  fHead[c] = (short)i;
  fBits[c >> 5] |= 1u << (c & 31); /* rows are exactly FW words, so cell c's bit is bit c */
}
static void foodUnlink(i32 i) {
  i32 c = fCell[i], p = fPrev[i], n = fNext[i];
  if (c < 0) return;
  if (p >= 0) fNext[p] = (short)n; else { fHead[c] = (short)n; if (n < 0) fBits[c >> 5] &= ~(1u << (c & 31)); }
  if (n >= 0) fPrev[n] = (short)p;
  fCell[i] = -1;
}

/* Re-centre the collision window on the focus and relink every body. Needed only
   when the player has moved far from the window's centre (every several seconds). */
static void segRebuild(void) {
  __builtin_memset(gHead, 0xff, sizeof gHead); /* -1 = empty (bulk memory.fill) */
  __builtin_memset(gCell, 0xff, sizeof gCell);
  __builtin_memset(omap, 0, sizeof omap);
  __builtin_memset(ocnt, 0, sizeof ocnt);
  omX0 = (float)(i32)(focX - MN * MC * 0.5f); omY0 = (float)(i32)(focY - MN * MC * 0.5f); /* whole units: integer maths in segLink */
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    k->tail = k->pc;
    if (!k->alive) continue;
    /* a body lies within n*spacing of its head: skip snakes entirely outside the window */
    float reach = (float)k->n * k->spacing, hx = k->hx, hy = k->hy;
    if (hx < omX0 - reach || hy < omY0 - reach || hx > omX0 + MN * MC + reach || hy > omY0 + MN * MC + reach) { k->tail = k->pc - (u32)k->n; continue; }
    syncBody(s);
  }
}
static i32 windowDrifted(void) {
  float c = MN * MC * 0.5f, lim = MN * MC * 0.25f;
  return absf(focX - (omX0 + c)) > lim || absf(focY - (omY0 + c)) > lim;
}

/* Every REBUILD steps: drop food left far behind, count what is near, pack the slots. */
static void foodTidy(void) {
  /* food: drop pellets left far behind, count the ones near, and list the holes
     lowest-first so the slots in use stay packed */
  nfree = 0;
  i32 hi = 0; float FR2 = foodR() * foodR();
  foodNear = 0;
  for (i32 i = 0; i < foodHigh; i++) {
    if (!F[i].v) continue;
    float dx = UQ(F[i].x) - focX, dy = UQ(F[i].y) - focY, d2 = dx * dx + dy * dy;
    if (d2 > FR2 * 1.6f) { foodUnlink(i); F[i].v = 0; continue; } /* left far behind, off screen: dropped */
    hi = i + 1; foodNear += d2 < FR2;
  }
  for (i32 i = hi - 1; i >= 0; i--) if (!F[i].v) freeList[nfree++] = (short)i; /* holes, lowest on top */
  foodHigh = hi;
}
static void rebuild(void) { segRebuild(); foodTidy(); }

static void killFood(i32 i) { foodUnlink(i); F[i].v = 0; freeList[nfree++] = (short)i; }
static void spawnFood(float x, float y, float v, i32 skin) {
  i32 i = nfree ? freeList[--nfree] : foodHigh < MAXF ? foodHigh++ : -1;
  if (i < 0) return;
  F[i] = (Food){fix(x), fix(y), (u8)(i32)minf(v * 16.f + 0.5f, 255.f), (u8)skin, (unsigned short)(tick >> 2)};
  foodLink(i, cellOf(x, y));
}
static void randomDisk(float rad, float *x, float *y) {
  float a = frand() * TAU, d = rad * sqrtf_(frand());
  *x = cosf_(a) * d; *y = sinf_(a) * d;
}

/* Is a circle at (x,y,rad) near the border or another snake? (coarse, for AI) */
static i32 dangerAt(i32 self, float x, float y, float rad) {
  float lim = WR - rad - 30.f;
  if (x * x + y * y > lim * lim) return 1;
  float R = rad + 30.f;
  i32 x0 = (i32)((x - R - omX0) * (1.f / MC)), x1 = (i32)((x + R - omX0) * (1.f / MC));
  i32 y0 = (i32)((y - R - omY0) * (1.f / MC)), y1 = (i32)((y + R - omY0) * (1.f / MC));
  if (x1 < 0 || y1 < 0 || x0 >= MN || y0 >= MN) return 0; /* outside the window: only far bots ask */
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= MN) x1 = MN - 1; if (y1 >= MN) y1 = MN - 1;
  u8 me = (u8)(self + 1);
  i32 w = x1 - x0 + 1;
  if (w <= 8) {
    /* 8 cells per row in one go (SWAR): load them as one 64-bit word and flag the
       bytes that are neither empty (0) nor ours (me), with no per-cell branches.
       omap has 16 bytes of padding, so reading past a row end is safe. */
    typedef unsigned long long u64;
    const u64 L = 0x7f7f7f7f7f7f7f7full, H = 0x8080808080808080ull, ME = (u64)me * 0x0101010101010101ull;
    const u64 keep = w == 8 ? ~0ull : (1ull << (8 * w)) - 1; /* cells outside the box read as empty */
    for (i32 my = y0; my <= y1; my++) {
      u64 v; __builtin_memcpy(&v, &omap[my * MN + x0], 8);
      v &= keep;
      u64 y = v ^ ME;
      u64 z0 = ~(((v & L) + L) | v | L), zm = ~(((y & L) + L) | y | L); /* 0x80 where byte == 0 / == me */
      if (~(z0 | zm) & H) return 1;
    }
    return 0;
  }
  for (i32 my = y0; my <= y1; my++) {
    const u8 *row = &omap[my * MN];
    for (i32 mx = x0; mx <= x1; mx++) if (row[mx] && row[mx] != me) return 1;
  }
  return 0;
}

/* ---------- snakes ---------- */
static void pushTrail(i32 s, float x, float y) {
  Snake *k = &S[s];
  u32 i = k->pc & RMASK;
  tr[s][i][0] = fix(x); tr[s][i][1] = fix(y);
  segLink(s, k->pc);
  k->pc++;
}

static void randomRing(float r0, float r1, float *x, float *y) {
  float a = frand() * TAU, d = sqrtf_(r0 * r0 + (r1 * r1 - r0 * r0) * frand());
  *x = cosf_(a) * d; *y = sinf_(a) * d;
}
/* The middle (the centre zone on the minimap, 35% of the world radius) belongs to big
   snakes: only from MID_MASS (length 5000 on screen: length = mass x 10) are snakes drawn
   to it. Nothing spawns in it. */
#define MID_MASS 500.f
static void homePoint(float mass, float *x, float *y) {
  if (mass >= MID_MASS) randomDisk(WR * 0.35f, x, y); else randomRing(WR * 0.3f, WR * 0.88f, x, y);
}
/* How far (x, y) is from the nearest other living snake: its head and every 8th body
   point (points are ~5-17 units apart). Exact over the whole world, unlike dangerAt,
   which only sees the collision window. Only used when a snake spawns. */
static float spawnRoom(i32 self, float x, float y) {
  float best = 1e18f;
  for (i32 o = 0; o < NS; o++) {
    if (o == self || !S[o].alive) continue;
    float dx = S[o].hx - x, dy = S[o].hy - y, d2 = dx * dx + dy * dy, reach = (float)S[o].n * S[o].spacing;
    if (d2 < best) best = d2;
    if (d2 > (reach + 1000.f) * (reach + 1000.f)) continue; /* its whole body is far away */
    for (i32 j = 8; j < S[o].n; j += 8) {
      float bx = TX(o, j) - x, by = TY(o, j) - y, b2 = bx * bx + by * by;
      if (b2 < best) best = b2;
    }
  }
  return sqrtf_(best);
}
#define SPAWN_GAP 600.f /* no other snake (head or body) closer than this to a new one, when possible */

static void spawnSnake(i32 s, float mass, i32 skin) {
  i32 bot = s != 0;
  Snake *k = &S[s];
  float x = 0, y = 0, bx = 0, by = 0, bc = -1.f;
  for (i32 t = 0; t < 40; t++) { /* the first spot at least SPAWN_GAP from everyone, else the roomiest tried */
    if (!bot) randomRing(WR * 0.72f, WR * 0.86f, &x, &y); /* player: outer rim */
    else randomRing(WR * 0.4f, WR * 0.88f, &x, &y);     /* bots: anywhere but the middle */
    float dx = x - focX, dy = y - focY;
    if (bot && t < 30 && dx * dx + dy * dy < (focR + 300.f) * (focR + 300.f)) continue; /* never pop in on screen */
    float c = spawnRoom(s, x, y);
    if (c > bc) { bc = c; bx = x; by = y; }
    if (c >= SPAWN_GAP) break;
  }
  x = bx; y = by;
  k->ang = k->tang = frand() * TAU - PI; k->dcx = cosf_(k->ang); k->dcy = sinf_(k->ang);
  k->mass = mass; k->r = radiusFor(mass); k->spacing = k->r * 0.42f; k->n = segsFor(mass);
  k->skin = skin; k->kills = 0; k->boost = k->wantBoost = 0;
  k->dropT = k->dropMass = 0; k->aiT = 0; k->huntT = 0; k->target = -1; k->near = 1; k->rushT = 0; k->orbit = 1;
  k->tx = x; k->ty = y; k->hx = x; k->hy = y;
  /* lay a full ring of trail behind the head; pc keeps counting so nodes from a
     previous life can never look valid again */
  float cx = cosf_(k->ang), sy = sinf_(k->ang);
  unlinkBody(s); /* whatever is left of a previous life */
  k->pc += RING; k->tail = k->pc;
  for (u32 j = 0; j < RING; j++) {
    u32 i = (k->pc - 1u - j) & RMASK;
    tr[s][i][0] = fix(x - cx * k->spacing * (float)j); tr[s][i][1] = fix(y - sy * k->spacing * (float)j);
  }
  k->alive = 1; k->phx = x; k->phy = y; k->ppc = k->pc;
  gpuOk[s] = 0; /* whole ring rewritten: the GPU needs the full row */
  syncBody(s);
}

static void killSnake(i32 s, i32 killer) {
  Snake *k = &S[s];
  if (!k->alive) return;
  k->alive = 0;
  unlinkBody(s);
  if (k->near) {
    float per = k->mass * 0.85f / (float)(k->n / 2 + 1), j = k->r * 0.6f;
    for (i32 i = 0; i < k->n; i += 2)
      spawnFood(TX(s, i) + (frand() - 0.5f) * j, TY(s, i) + (frand() - 0.5f) * j, per * (0.6f + frand() * 0.8f), k->skin);
    deathX = TX(s, k->n / 3); deathY = TY(s, k->n / 3); deathTick = tick;
  }
  if (killer >= 0) S[killer].kills++;
  if (s == 0) playerKiller = killer;
  k->respawnT = 1.5f + frand() * 3.f;
}

static void moveSnake(i32 s, float dt) {
  Snake *k = &S[s];
  float turn = 5.2f / (1.f + (k->r - 12.f) * 0.045f) * dt;
  float da = wrapa(k->tang - k->ang);
  if (da > turn) da = turn; else if (da < -turn) da = -turn;
  if (da != 0.f) { /* rotate the heading vector by da (|da| < 0.1: short series is exact to ~1e-9) */
    k->ang = wrapa(k->ang + da);
    float d2 = da * da, c = 1.f - d2 * 0.5f + d2 * d2 * (1.f / 24.f), sn = da * (1.f - d2 * (1.f / 6.f));
    float x = k->dcx * c - k->dcy * sn, y = k->dcx * sn + k->dcy * c, l2 = x * x + y * y, f = 1.5f - 0.5f * l2; /* renormalise */
    k->dcx = x * f; k->dcy = y * f;
  }

  k->boost = k->wantBoost && k->mass > 14.f;
  float speed = k->boost ? 430.f : 195.f;
  k->hx += k->dcx * speed * dt;
  k->hy += k->dcy * speed * dt;

  if (k->boost) {
    float lose = (6.f + k->mass * 0.006f) * dt;
    k->mass -= lose; k->dropMass += lose; k->dropT += dt;
    if (k->dropT > 0.1f) {
      spawnFood(TX(s, k->n - 1), TY(s, k->n - 1), k->dropMass * 0.8f, k->skin);
      k->dropT = 0; k->dropMass = 0;
    }
  }

  float sq = sqrtf_(k->mass); /* one sqrt for both growth curves */
  k->r = minf(10.f + sq * 0.45f, 40.f);
  k->spacing = k->r * 0.42f;
  i32 want = 14 + (i32)(3.6f * sq); if (want > MAXSEG) want = MAXSEG;
  k->n = want; /* the body grid follows in syncBody below */

  /* head-driven trail: push points at exact spacing (O(1) per snake) */
  float sp = k->spacing;
  for (i32 t = 0; t < 4; t++) {
    float lx = TX(s, 0), ly = TY(s, 0), dx = k->hx - lx, dy = k->hy - ly, d2 = dx * dx + dy * dy;
    if (d2 < sp * sp) break;
    float f = sp / sqrtf_(d2);
    pushTrail(s, lx + dx * f, ly + dy * f);
  }
  syncBody(s); /* the tail (and any shrink from boosting) leaves the grid now */
}

static i32 hitTest(i32 s) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  float lim = WR - k->r * 0.5f;
  if (hx * hx + hy * hy > lim * lim) return -2;
  FOR_CELLS(hx, hy, (k->r + 40.f) * 0.66f, c) /* 40 = largest radius */
    for (i32 i = gHead[c]; i >= 0; i = gNext[i]) {
      i32 o = i / RING;
      if (o == s) continue;
      i32 j = i & RMASK;
      float dx = UQ(tr[o][j][0]) - hx, dy = UQ(tr[o][j][1]) - hy, t = (k->r + S[o].r) * 0.66f;
      if (dx * dx + dy * dy >= t * t) continue;
      /* Touching the other's head end (its newest points, about two radii): the heads
         are touching too, so both would "hit" and whichever is checked first would die.
         Decide fairly instead: the one driving INTO the other dies. A head ramming your
         neck from the side dies; your head, moving along, is spared. */
      if (((S[o].pc - 1u - (u32)j) & RMASK) < 6u) {
        Snake *q = &S[o];
        float ox = q->hx - hx, oy = q->hy - hy;
        float mine = k->dcx * ox + k->dcy * oy, theirs = -(q->dcx * ox + q->dcy * oy); /* closing speed of each head */
        if (mine < theirs) continue; /* it is ramming me: it dies in its own test */
      }
      return o;
    }
  return -1;
}


static void eat(i32 s, float dt) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  float att = k->r * 1.5f + 34.f, att2 = att * att, pull = minf(1.f, dt * 10.f);
  FOR_CELLS(hx, hy, att, c)
    for (i32 i = fHead[c], nx; i >= 0; i = nx) {
      nx = fNext[i]; /* read first: eating unlinks i */
      float px = UQ(F[i].x), py = UQ(F[i].y);
      float dx = px - hx, dy = py - hy, d2 = dx * dx + dy * dy, er = k->r + frT[F[i].v] * 0.5f;
      if (d2 < er * er) { k->mass += FV(i) * 0.75f; killFood(i); }
      else if (d2 < att2) { /* pulled toward the mouth; moves to another cell if it crosses */
        float qx = px - dx * pull, qy = py - dy * pull;
        F[i].x = fix(qx); F[i].y = fix(qy);
        i32 nc = cellOf(qx, qy);
        if (nc != fCell[i]) { foodUnlink(i); foodLink(i, nc); }
      }
    }
}

/* ---------- bot brain ---------- */
/* Exact free space around (x,y): distance to the nearest other body edge
   (segment grid, 3x3 cells), capped at 100. Only used when a bot is boxed in. */
static float clearance(i32 self, float x, float y) {
  float best = 100.f;
  float lim = WR - sqrtf_(x * x + y * y); if (lim < best) best = lim;
  FOR_CELLS(x, y, 100.f, c)
    for (i32 i = gHead[c]; i >= 0; i = gNext[i]) {
      i32 o = i / RING;
      if (o == self) continue;
      i32 j = i & RMASK;
      float dx = UQ(tr[o][j][0]) - x, dy = UQ(tr[o][j][1]) - y, d = sqrtf_(dx * dx + dy * dy) - S[o].r;
      if (d < best) best = d;
    }
  return best;
}

/* Elite+ also avoid where other heads will be in ~0.4 s (no head-on crashes). */
/* where every near head will be in 0.4 s: computed once per step, not per probe */
static float phX[MAXS], phY[MAXS], phR[MAXS]; static i32 phId[MAXS], nph;
static void predictHeads(void) {
  nph = 0;
  for (i32 o = 0; o < NS; o++) {
    Snake *q = &S[o];
    if (!q->alive || !q->near) continue;
    float v = (q->boost ? 430.f : 195.f) * 0.4f;
    phX[nph] = q->hx + q->dcx * v; phY[nph] = q->hy + q->dcy * v; phR[nph] = q->r * 2.f; phId[nph++] = o;
  }
}
/* A thinking bot first keeps only the predicted heads its probes can reach
   (usually 0-3), so each probe checks those instead of every head near the player. */
static float lhX[MAXS], lhY[MAXS], lhR[MAXS]; static i32 nlh;
static void nearHeads(i32 self, float x, float y, float reach) {
  nlh = 0;
  for (i32 i = 0; i < nph; i++) {
    float dx = phX[i] - x, dy = phY[i] - y, t = reach + phR[i];
    if (phId[i] != self && dx * dx + dy * dy < t * t) { lhX[nlh] = phX[i]; lhY[nlh] = phY[i]; lhR[nlh++] = phR[i]; }
  }
}
static i32 headDanger(float x, float y, float rad) {
  for (i32 i = 0; i < nlh; i++) {
    float dx = lhX[i] - x, dy = lhY[i] - y, t = rad + lhR[i];
    if (dx * dx + dy * dy < t * t) return 1;
  }
  return 0;
}

static void botThink(i32 s, float dt) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  i32 tier = k->tier;
  k->aiT -= dt; k->rushT -= dt;

  if (k->huntT > 0) {
    k->huntT -= dt;
    Snake *o = &S[k->target];
    if (k->target < 0 || !o->alive) k->huntT = 0;
    else {
      float dx = o->hx - hx, dy = o->hy - hy, d2 = dx * dx + dy * dy, R = o->r * 3.f + k->r * 3.f + 40.f;
      if (tier >= 3 && k->n > o->n + 10 && d2 < (R * 2.2f) * (R * 2.2f)) {
        /* encircle: orbit the prey's head so it runs into our body */
        float a = atan2f_(hy - o->hy, hx - o->hx) + (float)k->orbit * 0.9f;
        k->tx = o->hx + cosf_(a) * R; k->ty = o->hy + sinf_(a) * R;
      } else {
        /* cut off: aim where its head will be; better bots lead further */
        float lead = o->r * 4.f + 70.f + (tier >= 3 ? 90.f : 0.f);
        k->tx = o->hx + o->dcx * lead;
        k->ty = o->hy + o->dcy * lead;
      }
    }
  }
  if (k->huntT <= 0 && k->aiT <= 0) {
    k->aiT = 0.25f + frand() * 0.5f;
    k->target = -1;
    float ddx = deathX - hx, ddy = deathY - hy;
    if (tier >= 2 && tier != LEGEND && tick - deathTick < 200u && ddx * ddx + ddy * ddy < 900.f * 900.f) {
      /* vulture: rush to fresh remains */
      k->tx = deathX; k->ty = deathY; k->rushT = 1.2f; k->aiT = 1.f;
    } else if (frand() < T_AGGR[tier] * (tier >= 3 ? 0.6f : 0.35f)) {
      /* aggressive bots look for prey (elites prefer the player) */
      float best = (tier >= 3 ? 800.f : 650.f); best *= best;
      for (i32 o = 0; o < NS; o++) {
        if (o == s || !S[o].alive || S[o].mass > k->mass * (tier >= 3 ? 0.9f : 1.3f)) continue;
        float dx = S[o].hx - hx, dy = S[o].hy - hy, d2 = (dx * dx + dy * dy) * (o == 0 && tier >= 3 ? 0.6f : 1.f);
        if (d2 < best) { best = d2; k->target = o; }
      }
      if (k->target >= 0) {
        k->huntT = 1.f + frand() * (tier >= 3 ? 3.f : 1.5f);
        Snake *o = &S[k->target];
        k->orbit = ((o->hx - hx) * o->dcy - (o->hy - hy) * o->dcx) > 0 ? 1 : -1;
      }
    }
    if (k->target < 0 && k->rushT <= 0 && k->mass >= MID_MASS && hx * hx + hy * hy > WR * WR * 0.2f && frand() < 0.5f) {
      homePoint(k->mass, &k->tx, &k->ty); /* big snakes drift back to the middle */
      k->aiT = 1.5f;
    } else if (k->target < 0 && k->rushT <= 0) {
      /* best food by value / distance, favouring what is in front */
      float ca = k->dcx, sa = k->dcy, bestScore = 0;
      FOR_CELLS(hx, hy, tier == 0 ? CELL : 2.f * CELL, c) /* rookies look less far */
        for (i32 i = fHead[c]; i >= 0; i = fNext[i]) {
          float px = UQ(F[i].x), py = UQ(F[i].y);
          float dx = px - hx, dy = py - hy, d = sqrtf_(dx * dx + dy * dy) + 1.f;
          float score = FV(i) / (d + 60.f) * (1.6f + (dx * ca + dy * sa) / d);
          if (score > bestScore) { bestScore = score; k->tx = px; k->ty = py; }
        }
      if (bestScore == 0) homePoint(k->mass, &k->tx, &k->ty);
    }
  }

  /* Steering. Candidate headings are the current heading rotated by multiples of
     `spread` (unit vectors from a precomputed table, no trig), plus the exact goal
     direction. They are tried nearest-to-goal first; since any danger costs more
     than any angle, the first safe one is the best and the search stops there. */
  const float *rc = tier == 0 ? ROT_WIDE : ROT;
  i32 half = tier == 0 ? 3 : 6;
  float spread = tier == 0 ? 0.45f : 0.3f;
  float gx = k->tx - hx, gy = k->ty - hy, gl = sqrtf_(gx * gx + gy * gy);
  if (gl < 1.f) { gx = k->dcx; gy = k->dcy; } else { gx /= gl; gy /= gl; }
  float rel = atan2f_(gx * k->dcy * -1.f + gy * k->dcx, gx * k->dcx + gy * k->dcy); /* goal angle relative to heading */
  i32 legend = tier == LEGEND;
  float L = T_LOOK[tier], pr = k->r * (legend ? 1.35f : 1.15f);
  float l0 = k->r * 1.2f + 12.f; /* right in front of the head: what the far probes cannot see */
  float l1 = (k->r * 1.6f + 55.f) * L, l2 = (k->r * 1.6f + 170.f) * L, l3 = (k->r * 1.6f + 320.f) * L;
  float bx = gx, by = gy, bestCost = 1e9f;
  if (tier >= 3) nearHeads(s, hx, hy, l1 + pr); /* probes reach at most l1 + pr */
  i32 k0 = (i32)(rel / spread + (rel >= 0 ? 0.5f : -0.5f));   /* table index nearest the goal */
  if (k0 < -half) k0 = -half; if (k0 > half) k0 = half;
  for (i32 c = -1; c <= 4 * half; c++) {                       /* goal, then k0, k0-1, k0+1, k0-2, ... */
    float vx, vy, ang;
    if (c < 0) { if (absf(rel) > (float)half * spread) continue; vx = gx; vy = gy; ang = 0.f; }
    else {
      i32 idx = k0 + ((c & 1) ? -(c + 1) / 2 : c / 2);
      if (idx < -half || idx > half) continue;
      const float *r = &rc[(idx + half) * 2];
      vx = k->dcx * r[0] - k->dcy * r[1]; vy = k->dcx * r[1] + k->dcy * r[0];
      ang = absf((float)idx * spread - rel);
    }
    float cost = ang;
    if (tier > 0 && (dangerAt(s, hx + vx * l0, hy + vy * l0, k->r) || (tier >= 3 && headDanger(hx + vx * l0, hy + vy * l0, k->r)))) cost += 200.f; /* rookies don't look this close */
    else if (dangerAt(s, hx + vx * l1, hy + vy * l1, pr) || (tier >= 3 && headDanger(hx + vx * l1, hy + vy * l1, pr))) cost += 100.f;
    else if (dangerAt(s, hx + vx * l2, hy + vy * l2, pr)) cost += 20.f;
    else if (tier >= 3 && dangerAt(s, hx + vx * l3, hy + vy * l3, pr)) cost += 5.f;
    if (cost < bestCost) { bestCost = cost; bx = vx; by = vy; }
    if (cost < 5.f) break; /* safe, and nearest to the goal: nothing later can beat it */
  }
  float room = 100.f;
  if (bestCost >= 200.f) { /* boxed in by the coarse map: pick the direction with the most real space */
    room = -1e9f;
    for (i32 idx = -half; idx <= half; idx++) {
      const float *r = &rc[(idx + half) * 2];
      float vx = k->dcx * r[0] - k->dcy * r[1], vy = k->dcx * r[1] + k->dcy * r[0];
      float c = minf(clearance(s, hx + vx * l0, hy + vy * l0), clearance(s, hx + vx * l0 * 2.f, hy + vy * l0 * 2.f));
      if (c > room) { room = c; bx = vx; by = vy; }
    }
  }
  float bestA = atan2f_(by, bx);
  k->tang = bestA + (frand() - 0.5f) * 2.f * T_NOISE[tier];
  float dx = k->tx - hx, dy = k->ty - hy, d2 = dx * dx + dy * dy;
  k->wantBoost =
      (tier >= 2 && k->huntT > 0 && k->mass > 30.f && d2 < 450.f * 450.f && bestCost < 20.f) || /* strike */
      (tier >= 2 && k->rushT > 0 && k->mass > 60.f && bestCost < 20.f) ||                        /* vulture */
      (tier >= 3 && bestCost >= 100.f && room > k->r && k->mass > 40.f) ||                    /* escape through a real gap */
      (tier == 1 && bestCost >= 100.f && k->mass > 40.f && frand() < 0.05f);
}

/* Far from the player: steer to a home point, grow and die statistically. */
static void farThink(i32 s, float dt) {
  Snake *k = &S[s];
  k->wantBoost = 0; k->huntT = 0;
  float dx = k->tx - k->hx, dy = k->ty - k->hy;
  if ((k->aiT -= dt) <= 0 || dx * dx + dy * dy < 150.f * 150.f || k->hx * k->hx + k->hy * k->hy > WR * WR * 0.8f) {
    homePoint(k->mass, &k->tx, &k->ty);
    k->aiT = 3.f + frand() * 5.f;
  }
  k->tang = atan2f_(k->ty - k->hy, k->tx - k->hx);
  /* the "dumb equation": growth and death odds by tier */
  if (k->mass < T_CAP[k->tier]) k->mass += T_GROW[k->tier] * dt;
  if (frand() < T_RISK[k->tier] * dt) killSnake(s, -1);
}

static void spawnBot(i32 s) {
  float r = frand(), t = frand();
  i32 legends = 0;
  for (i32 o = 1; o < NS; o++) legends += S[o].alive && S[o].tier == LEGEND;
  /* rookie 30%, casual 28%, hunter 20%, elite 12%, legend 10% (at most 6 alive at once) */
  i32 tier = r < 0.30f ? 0 : r < 0.58f ? 1 : r < 0.78f ? 2 : r < 0.90f || legends >= 6 ? 3 : LEGEND;
  S[s].tier = tier;
  spawnSnake(s, T_MASS0[tier] + t * t * T_MASS[tier], tier == LEGEND ? 11 : (i32)(rnd() % 11));
}

/* Food only exists around the player: keep a steady density inside the food
   disk, let pellets outside it fade. Cost is independent of the map size. */
static void maintainFood(i32 budget) {
  float FR = foodR(), want = FOOD_DENSITY * PI * FR * FR;
  if (want > MAXF - 1500) want = MAXF - 1500;
  for (i32 t = 0; t < budget && (float)foodNear < want; t++) {
    float x, y; randomDisk(FR, &x, &y); x += focX; y += focY;
    if (x * x + y * y > WR * WR * 0.96f) continue;
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
    foodNear++;
  }
}

static void refillFood(void);

/* ---------- simulation step ---------- */
static i32 deaths[MAXS * 2];

static void step(float dt) {
  tick++;
  if (tick % REBUILD == 0) foodTidy();
  if (windowDrifted()) segRebuild(); /* the player moved far: re-centre the collision window */
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    float dx = k->hx - focX, dy = k->hy - focY, R = focR + k->r * 2.f;
    k->near = s == 0 || dx * dx + dy * dy < R * R;
    if (k->near || k->seen) moveSnake(s, dt); /* anything on screen moves every step */
    else if (((tick + (u32)s) & 3u) == 0) moveSnake(s, dt * 4.f); /* far away: quarter rate, same speed */
  }

  i32 nd = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive || !S[s].near) continue;
    i32 h = hitTest(s);
    if (h != -1) { deaths[nd++] = s; deaths[nd++] = h; }
  }
  for (i32 i = 0; i < nd; i += 2) killSnake(deaths[i], deaths[i + 1] >= 0 ? deaths[i + 1] : -1);

  for (i32 s = 0; s < NS; s++) if (S[s].alive && S[s].near) eat(s, dt);
  predictHeads();
  for (i32 s = 1; s < NS; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    if (k->near) {
      i32 e = T_EVERY[k->tier];
      if ((tick + (u32)s) % (u32)e == 0) botThink(s, dt * (float)e);
    } else {
      if (((tick + (u32)s) & 15u) == 0) farThink(s, dt * 16.f);
    }
  }

  for (i32 s = 1; s < NS; s++) if (!S[s].alive && (S[s].respawnT -= dt) <= 0) spawnBot(s);

  maintainFood(24);
}

/* ---------- exports ---------- */
EXPORT("init") void init(u32 seed, i32 bots) {
  rs = seed ? seed : 1u;
  NS = bots + 1 > MAXS ? MAXS : bots + 1;
  nfree = 0; foodHigh = 0; tick = 0; playerKiller = -1;
  for (i32 i = 0; i < MAXF; i++) { F[i].v = 0; fCell[i] = -1; }
  __builtin_memset(fHead, 0xff, sizeof fHead); __builtin_memset(fBits, 0, sizeof fBits); /* every cell empty */
  for (i32 s = 0; s < MAXS; s++) S[s].alive = 0;
  rebuild();
  for (i32 i = 0; i < 256; i++) frT[i] = minf(3.5f + sqrtf_((float)i / 16.f) * 2.6f, 15.f);
  for (i32 i = 0; i < 13; i++) { float a = (float)(i - 6) * 0.3f; ROT[i * 2] = cosf_(a); ROT[i * 2 + 1] = sinf_(a); }
  for (i32 i = 0; i < 7; i++) { float a = (float)(i - 3) * 0.45f; ROT_WIDE[i * 2] = cosf_(a); ROT_WIDE[i * 2 + 1] = sinf_(a); }
  focX = focY = 0; focR = 2000.f;
  deathTick = 0xffff0000u;
  for (i32 s = 1; s < NS; s++) spawnBot(s);
  refillFood();
}

static float camX, camY;
EXPORT("spawnPlayer") void spawnPlayer(i32 skin) {
  S[0].tier = 0; spawnSnake(0, 10.f, skin); playerKiller = -1;
  camX = focX = S[0].hx; camY = focY = S[0].hy;
  refillFood(); /* also re-centres the collision window on the new view at once */
}
/* Fill food around a new focus at once (spawn, respawn, menu). */
static void refillFood(void) { rebuild(); for (i32 t = 0; t < 400; t++) maintainFood(64); }
EXPORT("killPlayer") void killPlayer(void) { S[0].alive = 0; unlinkBody(0); }


/* Fixed 60 Hz simulation (Fiedler, "Fix Your Timestep"): identical behaviour at
   any refresh rate; rendering interpolates between the last two states. */
static float acc, alpha;
static void update(float dt) {
  if (dt > 0.25f) dt = 0.25f; /* tab was asleep: don't fast-forward */
  acc += dt;
  for (i32 n = 0; acc >= DT && n < 8; n++) {
    for (i32 s = 0; s < NS; s++) { S[s].phx = S[s].hx; S[s].phy = S[s].hy; S[s].ppc = S[s].pc; }
    step(DT);
    acc -= DT;
  }
  if (acc > DT) acc = DT;
  alpha = acc / DT;
}

/* ---------- snake ribbons (built on the GPU) ----------
   The vertex shader pulls trail points straight from an RG16I texture that is
   a byte-for-byte copy of tr[][][], and generates the ribbon strip itself
   (one instance per visible snake). The CPU only writes a 48-byte header per
   visible snake. The fragment shader then reconstructs the overlapping-circle
   scales analytically (~1x overdraw). */

static i32 nvis, maxK;
/* per-snake snapshot for JS (camera, HUD, minimap, labels): one read, no calls */
typedef struct { float alive, x, y, mass, skin, tier, near, kills; } Snap;
static Snap snap[MAXS];


/* Interpolated state for this frame (call after update). */
EXPORT("snapshot") void snapshot(void) {
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    Snap *sn = &snap[s];
    sn->alive = (float)k->alive;
    if (!k->alive) continue;
    float hx = k->phx + (k->hx - k->phx) * alpha, hy = k->phy + (k->hy - k->phy) * alpha;
    sn->x = hx; sn->y = hy; sn->mass = k->mass; sn->skin = (float)k->skin;
    sn->tier = (float)k->tier; sn->near = (float)k->near; sn->kills = (float)k->kills;
  }
}


/* The pellets in view: walk the (exact) cells the view overlaps and copy each
   8-byte record into the draw list. No per-pellet tests: the cell lists only
   ever hold live pellets. */
static i32 foodInView(float cx, float cy, float hw, float hh) {
  i32 n = 0, x0 = cellX(cx - hw - 60.f), x1 = cellX(cx + hw + 60.f), y0 = cellX(cy - hh - 60.f), y1 = cellX(cy + hh + 60.f);
  for (i32 gy = y0; gy <= y1; gy++) {
    i32 a = gy * GN + x0, b = gy * GN + x1; /* cell range of this row: visit only cells with food */
    for (i32 w = a >> 5; w <= b >> 5; w++) {
      u32 bits = fBits[w];
      if (w == a >> 5) bits &= ~0u << (a & 31);
      if (w == b >> 5 && (b & 31) != 31) bits &= (1u << ((b & 31) + 1)) - 1;
      while (bits) {
        i32 c = (w << 5) + __builtin_ctz(bits);
        bits &= bits - 1;
        for (i32 i = fHead[c]; i >= 0 && n < MAXF; i = fNext[i]) VIS[n++] = F[i];
      }
    }
  }
  return n;
}

/* Cull against the camera, write one GPU header per visible snake. */
static i32 renderPrep(float cx, float cy, float hw, float hh, float px) {
  nvis = 0; maxK = 0; ntup = 0;
  for (i32 o = 1; o <= NS; o++) {
    i32 s = o == NS ? 0 : o;
    Snake *k = &S[s];
    k->seen = 0;
    if (!k->alive) continue;
    float hx = snap[s].x, hy = snap[s].y; /* interpolated head */
    i32 n = k->n;
    i32 legend = s != 0 && k->tier == LEGEND;
    float W = k->boost ? 1.9f : legend ? 1.5f : 1.08f, m = k->r * W * 2.f + 20.f;
    float x0 = cx - hw - m, x1 = cx + hw + m, y0 = cy - hh - m, y1 = cy + hh + m;
    /* integer cull on the raw 16-bit trail (after a cheap body-length reject) */
    i32 any = hx > x0 && hx < x1 && hy > y0 && hy < y1;
    float reach = (float)n * k->spacing;
    if (!any && (hx < x0 - reach || hx > x1 + reach || hy < y0 - reach || hy > y1 + reach)) continue;
    if (!any) { /* every 16th point, box grown by 15 spacings: points in between can't be further out */
      float g = k->spacing * 15.f;
      i32 qx0 = (i32)((x0 - g) * 4.f), qx1 = (i32)((x1 + g) * 4.f), qy0 = (i32)((y0 - g) * 4.f), qy1 = (i32)((y1 + g) * 4.f);
      for (i32 i = 0; i < n && !any; i += 16) {
        const short *t = tr[s][(k->pc - 1u - (u32)i) & RMASK];
        any = t[0] > qx0 && t[0] < qx1 && t[1] > qy0 && t[1] < qy1;
      }
    }
    if (!any) continue;
    /* the interpolated head can be "behind" points the last step pushed: attach the
       ribbon to the newest point it is still ahead of */
    float ca = k->dcx, sa = k->dcy;
    u32 j0 = 0, pushes = k->pc - k->ppc;
    if (pushes > 4) pushes = 4;
    while (j0 < pushes && (hx - TX(s, j0)) * ca + (hy - TY(s, j0)) * sa < 0) j0++;
    float dx = hx - TX(s, j0), dy = hy - TY(s, j0);
    float spx = k->spacing / px;
    i32 stride = spx < 1.2f ? 4 : spx < 2.5f ? 2 : 1;
    i32 K = (n - 1 + stride - 1) / stride;
    if (K > maxK) maxK = K;
    Head *h = &hdr[nvis++];
    h->hx = hx; h->hy = hy; h->u = 1.f - minf(sqrtf_(dx * dx + dy * dy) / k->spacing, 1.f); h->r = k->r; h->spacing = k->spacing; h->stride = (float)stride;
    h->ang = k->ang; h->W = W; h->row = (u32)s; h->newest = (k->pc - 1u - j0) & RMASK; h->n = (u32)n;
    h->info = (u32)k->skin | ((u32)(k->boost | (s == 0 ? 2 : 0) | (legend ? 4 : 0)) << 8);
    trailSync(s);
    k->seen = 1;
  }
  return nvis;
}


/* Leaderboard: [alive count, player rank (0 = dead), top 10 snake ids...] */
static i32 lb[12];
EXPORT("rankPrep") i32 *rankPrep(void) {
  i32 ord[MAXS], n = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive) continue;
    i32 j = n++;
    while (j > 0 && S[ord[j - 1]].mass < S[s].mass) { ord[j] = ord[j - 1]; j--; } /* insertion sort, ~60 items */
    ord[j] = s;
  }
  lb[0] = n; lb[1] = 0;
  for (i32 i = 0; i < n; i++) if (ord[i] == 0) lb[1] = i + 1;
  for (i32 i = 0; i < 10; i++) lb[2 + i] = i < n ? ord[i] : -1;
  return lb;
}

EXPORT("tupPtr") u32 *tupPtr(void) { return tup; }
EXPORT("hdrPtr") Head *hdrPtr(void) { return hdr; }
EXPORT("snapPtr") Snap *snapPtr(void) { return snap; }
EXPORT("trailPtr") short *trailPtr(void) { return &tr[0][0][0]; }
EXPORT("ring") i32 ringSize(void) { return RING; }

/* ---------- minimap (drawn by WebGL, not Canvas2D) ----------
   Coordinates are normalised to the minimap disc (radius 1). */

static i32 miniPrep(float camX, float camY, float hw, float hh) {
  i32 n = 0;
  const float k = 1.f / WR;
  mini[n++] = (Mini){0.f, 0.f, 1.f, 0u}; /* backdrop, centre zone, rim */
  for (i32 s = 1; s < NS; s++) {
    if (!S[s].alive) continue;
    mini[n++] = (Mini){snap[s].x * k, snap[s].y * k, (2.f + sqrtf_(S[s].mass) * .16f) / 166.f,
                       1u | ((u32)S[s].skin << 8) | ((S[s].near ? 235u : 120u) << 16)};
  }
  mini[n++] = (Mini){camX * k, camY * k, hw * k, 3u | ((u32)(minf(hh * k, 1.f) * 16777215.f) << 8)};
  if (S[0].alive) mini[n++] = (Mini){snap[0].x * k, snap[0].y * k, 10.f / 166.f, 2u};
  return n;
}
EXPORT("miniPtr") Mini *miniPtr(void) { return mini; }

/* ---------- one call per frame ----------
   input -> fixed-step sim -> interpolated snapshot -> camera -> culling ->
   render headers + trail sync list -> minimap -> the std140 "Frame" uniform block that JS
   uploads as-is. Timings come from an imported clock. */
extern double nowMs(void) __attribute__((import_module("env"), import_name("now")));
static float expf_(float x) { /* 2^(x*log2 e), enough for smoothing factors */
  float t = x * 1.44269504f, fi = (float)(i32)t; if (t < fi) fi -= 1.f;
  float f = t - fi, p = 1.f + f * (0.6931472f + f * (0.2402265f + f * (0.0555041f + f * 0.0096181f)));
  i32 e = (i32)fi; if (e < -126) return 0.f;
  union { float f; u32 u; } v = {p}; v.u += (u32)e << 23; return v.f;
}
static float camH = 900.f, specT = 99.f;
static i32 spectate = 1;
static i32 frameOut[8];        /* food slots, snakes drawn, maxK, trail uploads, minimap items */
/* Accurate simulation cost on this device: time many steps in one go, so the
   browser's coarse/jittered timer doesn't matter. Advances the game. */
EXPORT("bench") float bench(i32 steps) {
  double t = nowMs();
  for (i32 i = 0; i < steps; i++) step(DT);
  return (float)((nowMs() - t) * 1000.0 / steps); /* microseconds per step */
}
static float frameMs[2];       /* sim, render prep */
EXPORT("frameBlkPtr") float *frameBlkPtr(void) { return frameBlk; }
EXPORT("frameOutPtr") i32 *frameOutPtr(void) { return frameOut; }
EXPORT("frameMsPtr") float *frameMsPtr(void) { return frameMs; }

/* mode: 0 playing, 1 dead (hold + slow zoom out), 2 menu (follow the biggest) */
EXPORT("frame") void frame(float dt, float aim, i32 boost, i32 mode, float vw, float vh, float cssW, float time) {
  double t0 = nowMs();
  if (mode == 0 && S[0].alive) { S[0].tang = aim; S[0].wantBoost = boost; }
  focX = camX; focY = camY; focR = sqrtf_(camH * camH * (1.f + (vw / vh) * (vw / vh))) + 450.f;
  update(dt);
  snapshot();
  double t1 = nowMs();

  float tx = camX, ty = camY, tH = camH;
  if (mode == 0 && S[0].alive) { tx = snap[0].x; ty = snap[0].y; tH = 560.f + (S[0].r - 12.f) * 18.f; }
  else if (mode == 1) tH = camH * (1.f + 0.12f * dt);
  else if (mode == 2) {
    if (!S[spectate].alive || (specT += dt) > 8.f) {
      float best = 0; specT = 0;
      for (i32 s = 1; s < NS; s++) if (S[s].alive && S[s].mass > best) { best = S[s].mass; spectate = s; }
    }
    tx = snap[spectate].x; ty = snap[spectate].y; tH = 900.f;
  }
  float kp = 1.f - expf_(-dt * (mode == 0 ? 14.f : 2.5f)), kz = 1.f - expf_(-dt * 2.f);
  camX += (tx - camX) * kp; camY += (ty - camY) * kp; camH += (tH - camH) * kz;

  float hh = camH, hw = camH * vw / vh, px = hh * 2.f / vh;
  frameOut[0] = foodInView(camX, camY, hw, hh);
  frameOut[1] = renderPrep(camX, camY, hw, hh, px);
  frameOut[2] = maxK; frameOut[3] = (i32)ntup;
  frameOut[4] = miniPrep(camX, camY, hw, hh);
  frameBlk[0] = camX; frameBlk[1] = camY; frameBlk[2] = hw; frameBlk[3] = hh;
  frameBlk[4] = px; frameBlk[5] = time; frameBlk[6] = vw / cssW; frameBlk[7] = ((float)(tick & 0x3ffffu) - 1.f + alpha) * 0.25f; /* food clock in quarter-steps, at the drawn moment (smooth) */
  frameBlk[8] = vw; frameBlk[9] = vh; frameBlk[10] = WR; frameBlk[11] = 0;
  frameMs[0] = (float)(t1 - t0); frameMs[1] = (float)(nowMs() - t1);
}

EXPORT("foodPtr") Food *foodPtr(void) { return VIS; }
EXPORT("maxFood") i32 maxFood(void) { return MAXF; }
EXPORT("worldRadius") float worldRadius(void) { return WR; }
EXPORT("snakeCount") i32 snakeCount(void) { return NS; }
EXPORT("kills") i32 kills(i32 s) { return S[s].kills; }
EXPORT("killer") i32 killer(void) { return playerKiller; }
