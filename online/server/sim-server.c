/*
 * Serpent.io ONLINE server simulation, compiled to WebAssembly and run by
 * server.js (Node). It is a copy of src/sim.c (the offline game) with the same
 * rules: movement, growth, collisions, eating, food, bot tiers and bot AI are
 * unchanged. What differs:
 *  - many human players (any slot not used by a bot), steered by the network;
 *  - full detail (collisions, eating, real AI) around EVERY human player, the
 *    offline "dumb equation" for bots far from all of them;
 *  - food is kept around every player; the collision/AI maps cover the whole world;
 *  - no rendering: server.js reads the state and sends each client what is near it.
 */
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;

/* Built natively (linked into the Rust server). Exported functions are sim_*. */
#define EXPORT(n)
#define PI 3.14159265f
#define TAU 6.28318531f
#define MAXS 128         /* snakes: bots in slots 1..NB, humans in every other slot */
#define RING 512         /* trail ring per snake (power of two) */
#define RMASK (RING - 1)
#define MAXSEG (RING - 1)
#define MAXF 32768       /* food pellets (around every player) */
#define WR 8000.f        /* world radius */
#define CELL 100.f       /* spatial hash cell size (>= max query radius) */
#define GN 160           /* grid cells per side: 2*WR/CELL */
#define GC (GN * GN)
#define MC 32.f          /* owner-map cell */
#define MN 512           /* owner-map cells per side: covers the whole world */
#define NODES (MAXS * RING) /* body grid: one fixed node per trail slot */
#define REBUILD 32       /* steps between food tidy-ups */


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
  i32 n, alive, boost, wantBoost, skin, kills, target, tier, near, orbit;
  float rushT;
  u32 pc; /* trail points pushed so far (monotonic across lives) */
  u32 tail; /* oldest trail point linked into the body grid: [tail, pc) are linked */
  float phx, phy; u32 ppc; /* state before the last fixed step (render interpolation) */
} Snake;

static Snake S[MAXS];
/* trail, fixed point (Q2), interleaved x,y: a byte copy goes to the GPU */
static short tr[MAXS][RING][2];
static i32 NS = 40;

/* Food, 8 bytes per pellet, in the exact layout the GPU draws from: the whole
   array is uploaded as-is and culled by the vertex shader, so the CPU does no
   per-frame food work at all. v = value in 1/16ths (0 = empty slot),
   born = tick/4 at spawn (fade-in); the pulse phase comes from the slot index. */
typedef struct { short x, y; u8 v, skin; unsigned short born; } Food;
static i32 freeList[MAXF]; /* empty slots below foodHigh (eaten pellets join at the next rebuild) */
static i32 nfree, foodHigh;
#define FOOD_DENSITY 7.2e-5f /* pellets per square unit around the player */
static float frT[256]; /* pellet radius by value byte (the food shader has the same formula) */
#define FV(i) ((float)F[i].v * (1.f / 16.f))

/* body grid: cell -> first node; node = snake * RING + ring slot */
static i32 gHead[GC], gNext[NODES], gPrev[NODES], gCell[NODES], gOm[NODES];
/* food cells: exact doubly linked lists (fCell = the cell a pellet is in, -1 = none) */
static i32 fHead[GC], fNext[MAXF], fPrev[MAXF], fCell[MAXF];
static unsigned short fCnt[GC]; /* pellets per cell: whole cells are counted without walking them */

/* Level of detail: one focus per human player (its view). Snakes near any focus
   get collisions, eating and real AI; everything else runs the statistical model. */
static float focX[MAXS + 1], focY[MAXS + 1], focR[MAXS + 1]; static i32 focS[MAXS + 1], nfoc;
/* food in each focus's disk, kept per owner (player slot; MAXS = the menu view), so
   players coming and going never force a recount of everyone else */
static i32 foodNear[MAXS + 1];
static float foodR(i32 f) { return focR[f] * 1.25f; } /* food exists inside this disk */
static u8 human[MAXS];           /* slot belongs to a network player */
/* How far behind a player's screen shows the other snakes, in steps: their measured
   network round trip plus the page's smoothing delay (set by the server, see sim_set_lag). */
static float lagSteps[MAXS];
/* Late inputs (online). The page predicts its own snake, so an input that arrives with
   the player's usual delay is on time: the server applies it exactly where the page showed
   it. Only a lag spike makes one late; the server measures that per input (main.rs:
   input_late) and passes it with the input.
   When a player's head hits a snake, the death waits graceSteps[s] (the player's usual
   lateness + 1) for inputs still on their way. Each step of the wait, the server replays the
   player's recent steps with every late input moved back to when it should have arrived:
   if that path is clear, the player lives, on that path. On-time inputs are never moved,
   so a turn made after hitting a snake never saves anyone. */
static float graceSteps[MAXS];
static i32 pendT[MAXS], pendK[MAXS]; /* pendT: steps waited + 1 (0 = none) */
static i32 inArrived[MAXS], inLate[MAXS]; /* an input arrived since the last step, and the most steps late of them */
/* Every input as it arrived (several can arrive in one step, e.g. after a stall): the step it
   took effect, how late it was, and what it said. */
typedef struct { u32 at, pc; i32 late; float aim; u32 boost; } InRec;
static InRec inLog[MAXS][64]; static u32 inN[MAXS];
/* Each player's state before each of the last 32 steps, for replays (see rescue). */
typedef struct { float hx, hy, ang, dcx, dcy, aim; u32 pc, wantBoost, arrived, late; } HState; /* aim, wantBoost: the input in effect */
static HState hist[MAXS][32];
static i32 killedBy[MAXS];       /* who killed each human (-1: the world edge) */
static float aspect[MAXS];       /* each player's screen width/height: sets its view */
static i32 NB = 60;              /* bots live in slots 1..NB */
static i32 isBot(i32 s) { return s >= 1 && s <= NB; }
static i32 inFocus(i32 f, float x, float y, float extra) {
  float dx = x - focX[f], dy = y - focY[f], R = focR[f] + extra;
  return dx * dx + dy * dy < R * R;
}
static i32 nearFocus(float x, float y, float extra) {
  for (i32 f = 0; f < nfoc; f++) if (inFocus(f, x, y, extra)) return 1;
  return 0;
}
/* Snake s is near a player? It almost always stays near the same one, so that one
   is tried first (one check) before the whole list. The hint never changes the answer. */
static i32 lastFoc[MAXS];
static i32 snakeNear(i32 s, float x, float y, float extra) {
  i32 h = lastFoc[s];
  if (h < nfoc && inFocus(h, x, y, extra)) return 1;
  for (i32 f = 0; f < nfoc; f++) if (inFocus(f, x, y, extra)) { lastFoc[s] = f; return 1; }
  return 0;
}

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
static const float omX0 = -MN * MC * 0.5f, omY0 = -MN * MC * 0.5f; /* fixed: the map covers the world */

static Food F[MAXF] __attribute__((aligned(16))); /* same 8-byte layout the client's GPU draws */
/* Food change log: every slot that spawned, was eaten or moved this step. The
   server forwards these to the players who can see them, instead of comparing
   all food every update. On overflow it rescans everything. */
#define MAXEV 65536
static u32 fev[MAXEV]; static i32 nfev, fevLost;
static void foodChanged(i32 i) { if (nfev < MAXEV) fev[nfev++] = (u32)i; else fevLost = 1; }

static u32 tick;

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
  fCell[i] = c; fPrev[i] = -1; fNext[i] = h;
  if (h >= 0) fPrev[h] = i;
  fHead[c] = i;
  fCnt[c]++;
}
static void foodUnlink(i32 i) {
  i32 c = fCell[i], p = fPrev[i], n = fNext[i];
  if (c < 0) return;
  if (p >= 0) fNext[p] = n; else fHead[c] = n;
  if (n >= 0) fPrev[n] = p;
  fCell[i] = -1;
  fCnt[c]--;
}

/* (The body grid never needs rebuilding here: its window is the whole world.) */
/* Count the food in each player's disk by walking only the grid cells it covers
   (cost: that disk's cells and pellets, not all food times all players). */
static void countFood(i32 f) {
  float R = foodR(f), R2 = R * R, fx = focX[f], fy = focY[f];
  i32 n = 0;
  i32 gy0 = cellX(fy - R), gy1 = cellX(fy + R);
  for (i32 gy = gy0; gy <= gy1; gy++) {
    /* this row of cells: the x-range that touches the disk and the x-range of cells wholly
       inside it (one sqrt each); inside cells add their count, edge cells check each pellet */
    float y0 = (float)gy * CELL - WR - fy, y1 = y0 + CELL;
    float ny = y0 > 0 ? y0 : y1 < 0 ? -y1 : 0, fy2 = maxf(y0 * y0, y1 * y1);
    if (ny * ny >= R2) continue;
    float tx = sqrtf_(R2 - ny * ny), ix = fy2 < R2 ? sqrtf_(R2 - fy2) : -1.f;
    i32 ta = cellX(fx - tx), tb = cellX(fx + tx);
    i32 ia = ix > 0 ? (i32)((fx - ix + WR) / CELL) + 1 : 1, ib = ix > 0 ? (i32)((fx + ix + WR) / CELL) - 1 : 0; /* cells wholly within +-ix */
    for (i32 gx = ta, c = gy * GN + ta; gx <= tb; gx++, c++) {
      if (!fCnt[c]) continue;
      if (gx >= ia && gx <= ib) { n += fCnt[c]; continue; }
      for (i32 i = fHead[c]; i >= 0; i = fNext[i]) {
        float dx = UQ(F[i].x) - fx, dy = UQ(F[i].y) - fy;
        n += dx * dx + dy * dy < R2;
      }
    }
  }
  foodNear[focS[f]] = n;
}
/* Every REBUILD steps: count, drop pellets far from every player (their cell is
   not near anyone's disk), and list the holes lowest-first so the array stays short. */
static u32 cellMark[GC], markGen;
static void rebuild(void) {
  for (i32 f = 0; f < nfoc; f++) countFood(f);
  markGen++;
  for (i32 f = 0; f < nfoc; f++) { FOR_CELLS(focX[f], focY[f], foodR(f) * 1.27f, c) cellMark[c] = markGen; } /* 1.27 = sqrt 1.6 */
  nfree = 0;
  i32 hi = 0;
  for (i32 i = 0; i < foodHigh; i++) {
    if (!F[i].v) continue;
    if (cellMark[fCell[i]] != markGen) { foodUnlink(i); F[i].v = 0; foodChanged(i); continue; } /* far from everyone: dropped */
    hi = i + 1;
  }
  for (i32 i = hi - 1; i >= 0; i--) if (!F[i].v) freeList[nfree++] = i; /* holes, lowest on top */
  foodHigh = hi;
}

static void killFood(i32 i) { foodUnlink(i); F[i].v = 0; freeList[nfree++] = i; foodChanged(i); }
static void spawnFood(float x, float y, float v, i32 skin) {
  i32 i = nfree ? freeList[--nfree] : foodHigh < MAXF ? foodHigh++ : -1;
  if (i < 0) return;
  F[i] = (Food){fix(x), fix(y), (u8)(i32)minf(v * 16.f + 0.5f, 255.f), (u8)skin, (unsigned short)(tick >> 2)};
  foodLink(i, cellOf(x, y)); foodChanged(i);
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
  for (i32 o = 0; o < MAXS; o++) {
    if (o == self || !S[o].alive) continue;
    float dx = S[o].hx - x, dy = S[o].hy - y, d2 = dx * dx + dy * dy, reach = (float)S[o].n * S[o].spacing;
    if (d2 < best) best = d2;
    /* where its head will be in about 1.5 s: don't appear in front of a moving snake */
    float fx = S[o].hx + S[o].dcx * 300.f - x, fy = S[o].hy + S[o].dcy * 300.f - y, f2 = fx * fx + fy * fy;
    if (f2 < best) best = f2;
    if (d2 > (reach + 1000.f) * (reach + 1000.f)) continue; /* its whole body is far away */
    for (i32 j = 8; j < S[o].n; j += 8) {
      float bx = TX(o, j) - x, by = TY(o, j) - y, b2 = bx * bx + by * by;
      if (b2 < best) best = b2;
    }
  }
  return sqrtf_(best);
}
#define SPAWN_GAP 600.f /* no other snake (head or body) closer than this to a new one, when possible */
/* Room for a whole new snake: its head at (x, y) and its straight body laid back along -(cx, cy)
   for len units. The body needs a third of the head's room; it must lie inside the world. */
static float spawnFit(i32 self, float x, float y, float cx, float cy, float len) {
  float c = spawnRoom(self, x, y), lim = WR * 0.97f;
  for (float d = 120.f; d < len + 60.f && c > 0.f; d += 120.f) {
    float px = x - cx * d, py = y - cy * d;
    if (px * px + py * py > lim * lim) return 0.f;
    float b = spawnRoom(self, px, py) * 3.f;
    if (b < c) c = b;
  }
  return c;
}

static void spawnSnake(i32 s, float mass, i32 skin) {
  i32 bot = !human[s];
  Snake *k = &S[s];
  float x = 0, y = 0, bx = 0, by = 0, bc = -1.f, ba = 0.f, len = (float)segsFor(mass) * radiusFor(mass) * 0.42f;
  for (i32 t = 0; t < 40; t++) { /* the first spot at least SPAWN_GAP from everyone, else the roomiest tried */
    if (!bot) randomRing(WR * 0.72f, WR * 0.86f, &x, &y); /* players: outer rim */
    else randomRing(WR * 0.4f, WR * 0.88f, &x, &y);     /* bots: anywhere but the middle */
    if (bot && t < 30 && nearFocus(x, y, 300.f)) continue; /* never pop in on anyone's screen */
    float a = frand() * TAU - PI, c = spawnFit(s, x, y, cosf_(a), sinf_(a), len); /* the head, and the body behind it */
    if (c > bc) { bc = c; bx = x; by = y; ba = a; }
    if (c >= SPAWN_GAP) break;
  }
  x = bx; y = by;
  k->ang = k->tang = ba; k->dcx = cosf_(k->ang); k->dcy = sinf_(k->ang);
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
  if (human[s]) killedBy[s] = killer;
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

static i32 hitAt(i32 s, float hx, float hy, float hdx, float hdy);
static void moveSnake(i32 s, float dt);
/* Replay player s's last W steps with each late input moved back to the step it should
   have arrived at (others as they are now). Only if that changes some input, and the new
   head path is clear, is it committed: return 1. */
static i32 rescue(i32 s, i32 W) {
  Snake *k = &S[s];
  if (W < 1) W = 1;
  /* the inputs of this life that took effect in the last 31 steps, oldest first */
  InRec *ins[64]; i32 ni = 0;
  for (u32 q = inN[s] > 64u ? inN[s] - 64u : 0u; q != inN[s]; q++) {
    InRec *e = &inLog[s][q & 63u];
    if ((i32)(tick - e->at) > 30 || (i32)(e->at - tick) > 0 || k->pc - e->pc > 128u) continue;
    ins[ni++] = e;
    i32 need = (i32)(tick - (e->at - (u32)e->late)) + 1; /* reach back to the step it was meant for */
    if (e->late && need > W) W = need;
  }
  if (W > 30) W = 30;
  if (W < 1) W = 1;
  u32 t0 = tick - (u32)W + 1u; /* the first replayed step */
  HState h = hist[s][t0 & 31u];
  if (k->pc - h.pc > 128u || k->pc - h.pc + (u32)k->n + 8u > RING) return 0; /* history doesn't reach (or respawned) */
  float aims[32]; i32 boosts[32], late = 0;
  for (i32 i = 0; i < W; i++) {
    u32 t = t0 + (u32)i;
    /* the input in effect at step t if every input had arrived on time: the one meant for
       the latest step <= t (later in the log wins a tie: messages arrive in order) */
    InRec *best = 0; u32 bestMeant = 0;
    for (i32 q = 0; q < ni; q++) {
      u32 meant = ins[q]->at - (u32)ins[q]->late;
      if ((i32)(meant - t) <= 0 && (!best || (i32)(meant - bestMeant) >= 0)) { best = ins[q]; bestMeant = meant; }
    }
    if (best) { aims[i] = best->aim; boosts[i] = (i32)best->boost; }
    else { aims[i] = hist[s][(t0 - 1u) & 31u].aim; boosts[i] = (i32)hist[s][(t0 - 1u) & 31u].wantBoost; }
    HState *o = &hist[s][t & 31u]; float d = wrapa(aims[i] - o->aim);
    late |= d > 0.01f || d < -0.01f || boosts[i] != (i32)o->wantBoost;
  }
  if (!late) return 0; /* nothing arrived late: the hit stands as it happened */
  /* dry run: the head only, steered and sped exactly as moveSnake does */
  float x = h.hx, y = h.hy, a = h.ang, dx = h.dcx, dy = h.dcy;
  float turn = 5.2f / (1.f + (k->r - 12.f) * 0.045f) * DT;
  for (i32 i = 0; i < W; i++) {
    float da = wrapa(aims[i] - a); if (da > turn) da = turn; else if (da < -turn) da = -turn;
    if (da != 0.f) { a = wrapa(a + da); float d2 = da * da, c = 1.f - d2 * 0.5f + d2 * d2 * (1.f / 24.f), sn = da * (1.f - d2 * (1.f / 6.f));
      float nx = dx * c - dy * sn, ny = dx * sn + dy * c, f = 1.5f - 0.5f * (nx * nx + ny * ny); dx = nx * f; dy = ny * f; }
    float sp = (boosts[i] && k->mass > 14.f ? 430.f : 195.f) * DT; x += dx * sp; y += dy * sp;
    if (hitAt(s, x, y, dx, dy) != -1) return 0;
  }
  /* clear: rewind for real and replay. Mass, and the boost food it would drop, stay as they
     are (the boosting already happened and was paid for once). */
  float mass = k->mass, r = k->r, spc = k->spacing, aim = k->tang, dm = k->dropMass, dt_ = k->dropT, ox = k->hx, oy = k->hy; i32 n = k->n, wb = k->wantBoost;
  unlinkBody(s);
  k->hx = h.hx; k->hy = h.hy; k->ang = h.ang; k->dcx = h.dcx; k->dcy = h.dcy; k->pc = k->tail = h.pc;
  for (i32 i = 0; i < W; i++) {
    HState *e = &hist[s][(t0 + (u32)i) & 31u]; /* the history now follows the new path (inputs as they arrived) */
    e->hx = k->hx; e->hy = k->hy; e->ang = k->ang; e->dcx = k->dcx; e->dcy = k->dcy; e->pc = k->pc;
    k->tang = aims[i]; k->wantBoost = boosts[i]; k->dropT = 0.f; k->dropMass = 0.f;
    moveSnake(s, DT); k->mass = mass;
  }
  k->mass = mass; k->r = r; k->spacing = spc; k->n = n; k->wantBoost = wb; k->tang = aim; k->dropMass = dm; k->dropT = dt_;
  syncBody(s);
  /* A real change of path: bump pc (same ring slots) so every client takes the whole new
     body. A small nudge (a few units) isn't worth re-sending bodies for. */
  float mx = k->hx - ox, my = k->hy - oy;
  if (mx * mx + my * my > 10.f * 10.f) {
    k->pc += RING; k->tail += RING;
    for (i32 i = 0; i < W; i++) hist[s][(t0 + (u32)i) & 31u].pc += RING;
  }
  k->phx = k->hx; k->phy = k->hy; k->ppc = k->pc;
  return 1;
}
static i32 hitTest(i32 s) { return hitAt(s, S[s].hx, S[s].hy, S[s].dcx, S[s].dcy); }
/* Would snake s's head at (hx, hy), heading (hdx, hdy), hit something? */
static i32 hitAt(i32 s, float hx, float hy, float hdx, float hdy) {
  Snake *k = &S[s];
  float lim = WR - k->r * 0.5f;
  if (hx * hx + hy * hy > lim * lim) return -2;
  /* Only the FRONT of the head counts: the point half a head-radius ahead of its centre
     must be well inside the other's body (within 80% of its radius of the body's centre
     line). Brushing past a body with the side of the head, or the body behind it, is fine. */
  float fx = hx + hdx * k->r * 0.5f, fy = hy + hdy * k->r * 0.5f;
  FOR_CELLS(fx, fy, 40.f * 0.8f, c) /* 40 = largest radius */
    for (i32 i = gHead[c]; i >= 0; i = gNext[i]) {
      i32 o = i / RING;
      if (o == s) continue;
      i32 j = i & RMASK;
      float dx = UQ(tr[o][j][0]) - fx, dy = UQ(tr[o][j][1]) - fy, t = S[o].r * 0.8f;
      if (dx * dx + dy * dy >= t * t) continue;
      float th = (k->r + S[o].r) * 0.66f; /* heads this close touch each other (head-on) */
      /* Delay compensation: a player sees other snakes lagSteps late. Points the other
         laid within that time (the very front of it) were not on the player's screen
         yet, so the player cannot have steered around them: they don't count against
         the player. (The other snake's own test is unaffected: if it rams the player's
         body, it dies.) */
      /* (Not when the two heads touch each other: that is a head-on, decided below the same
         way for everyone; else a slower connection would win every head-on.) */
      float hdx2 = S[o].hx - hx, hdy2 = S[o].hy - hy;
      if (human[s] && lagSteps[s] > 0.f && hdx2 * hdx2 + hdy2 * hdy2 >= th * th) {
        float laid = lagSteps[s] * DT * (S[o].boost ? 430.f : 195.f) / S[o].spacing + 1.f;
        if ((float)((S[o].pc - 1u - (u32)j) & RMASK) < laid) continue;
      }
      /* Touching the other's head end (its newest points, about two radii): the heads
         are touching too, so both would "hit" and whichever is checked first would die.
         Decide fairly instead: the one driving INTO the other dies. A head ramming your
         neck from the side dies; your head, moving along, is spared. */
      if (((S[o].pc - 1u - (u32)j) & RMASK) < 6u) {
        Snake *q = &S[o];
        float ox = q->hx - hx, oy = q->hy - hy;
        float mine = hdx * ox + hdy * oy, theirs = -(q->dcx * ox + q->dcy * oy); /* closing speed of each head */
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
        F[i].x = fix(qx); F[i].y = fix(qy); foodChanged(i);
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
      /* aggressive bots look for prey (elites prefer players) */
      float best = (tier >= 3 ? 800.f : 650.f); best *= best;
      for (i32 o = 0; o < NS; o++) {
        if (o == s || !S[o].alive || S[o].mass > k->mass * (tier >= 3 ? 0.9f : 1.3f)) continue;
        float dx = S[o].hx - hx, dy = S[o].hy - hy, d2 = (dx * dx + dy * dy) * (human[o] && tier >= 3 ? 0.6f : 1.f);
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
  for (i32 o = 1; o <= NB; o++) legends += S[o].alive && S[o].tier == LEGEND;
  /* rookie 30%, casual 28%, hunter 20%, elite 12%, legend 10% (at most 6 alive at once) */
  i32 tier = r < 0.30f ? 0 : r < 0.58f ? 1 : r < 0.78f ? 2 : r < 0.90f || legends >= 6 ? 3 : LEGEND;
  S[s].tier = tier;
  spawnSnake(s, T_MASS0[tier] + t * t * T_MASS[tier], tier == LEGEND ? 11 : (i32)(rnd() % 11));
}

/* Food only exists around players: keep the same density as offline inside
   each player's food disk. Cost is independent of the map size. */
static void maintainFood(i32 f, i32 budget) {
  float FR = foodR(f), want = FOOD_DENSITY * PI * FR * FR;
  i32 *near = &foodNear[focS[f]];
  for (i32 t = 0; t < budget && (float)*near < want; t++) {
    float x, y; randomDisk(FR, &x, &y); x += focX[f]; y += focY[f];
    if (x * x + y * y > WR * WR * 0.96f) continue;
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
    (*near)++;
  }
}

/* ---------- state for server.js: one flat record per slot, written after every step ---------- */
typedef struct { float hx, hy, ang, mass, r, spacing; u32 pc, n, alive, skin, tier, boost, kills, human; } Pub;
static Pub pub[MAXS];
static void publish(void) {
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s]; Pub *p = &pub[s];
    p->alive = (u32)k->alive; p->human = human[s];
    if (!k->alive) continue;
    p->hx = k->hx; p->hy = k->hy; p->ang = k->ang; p->mass = k->mass; p->r = k->r; p->spacing = k->spacing;
    p->pc = k->pc; p->n = (u32)k->n; p->skin = (u32)k->skin; p->tier = (u32)k->tier; p->boost = (u32)k->boost; p->kills = (u32)k->kills;
  }
}

/* ---------- simulation step ---------- */
static i32 deaths[MAXS * 2];

/* one focus per living human: its view, sized exactly like the offline camera;
   plus the snake the menu is showing, while anyone is on the menu */
static float exX, exY, exR; static i32 exOn, exRecount;
static void setFoci(void) {
  nfoc = 0;
  if (exOn) { focX[0] = exX; focY[0] = exY; focR[0] = exR; focS[0] = MAXS; nfoc = 1; }
  for (i32 s = 0; s < NS; s++) {
    if (!human[s] || !S[s].alive) continue;
    float camH = 560.f + (S[s].r - 12.f) * 18.f, a = aspect[s];
    focX[nfoc] = S[s].hx; focY[nfoc] = S[s].hy; focR[nfoc] = sqrtf_(camH * camH * (1.f + a * a)) + 450.f; focS[nfoc] = s;
    nfoc++;
  }
}

static void step(float dt) {
  tick++;
  setFoci();
  if (exRecount && exOn) { exRecount = 0; countFood(0); } /* the menu view moved: its focus is slot 0 */
  if (tick % REBUILD == 0) rebuild();
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    /* far bots move every 4th step; they recheck on those steps too (the near
       zone already reaches 450 units past each player's screen) */
    if (human[s]) { k->near = 1; hist[s][tick & 31] = (HState){k->hx, k->hy, k->ang, k->dcx, k->dcy, k->tang, k->pc, (u32)k->wantBoost, (u32)inArrived[s], (u32)inLate[s]}; inArrived[s] = 0; inLate[s] = 0; }
    else if (k->near || ((tick + (u32)s) & 3u) == 0) k->near = snakeNear(s, k->hx, k->hy, k->r * 2.f);
    if (k->near) moveSnake(s, dt);
    else if (((tick + (u32)s) & 3u) == 0) moveSnake(s, dt * 4.f); /* far away: quarter rate, same speed */
  }

  i32 nd = 0, anyRescue = 0; u8 rescued[MAXS] = {0};
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive || !S[s].near) continue;
    /* A player's input arrived late (a lag spike): apply it at the step it was meant for,
       right away (if that path is clear), so the server's snake follows the path the player
       saw on their screen instead of being pulled sideways later. */
    if (human[s] && hist[s][tick & 31u].late && !pendT[s] && rescue(s, 1)) { rescued[s] = 1; anyRescue = 1; }
    i32 h = hitTest(s);
    if (human[s] && h != -2) {
      if (h >= 0 && !pendT[s]) { pendT[s] = 1; pendK[s] = h; }
      if (pendT[s]) {
        /* replay with late inputs moved to when they should have arrived */
        if (rescue(s, pendT[s] + 13)) { pendT[s] = 0; rescued[s] = 1; anyRescue = 1; continue; } /* clear: lives */
        if ((float)pendT[s]++ < graceSteps[s]) continue;              /* a turn may still be on its way */
        if (h == -1) h = pendK[s];                                     /* the first hit stands */
        pendT[s] = 0;
      }
    }
    if (h != -1) { deaths[nd++] = s; deaths[nd++] = h; }
  }
  /* A rescued player's snake moved: a snake that hit its old position is checked again. */
  if (anyRescue) {
    i32 m = 0;
    for (i32 i = 0; i < nd; i += 2) {
      i32 v = deaths[i], kl = deaths[i + 1];
      if (kl >= 0 && rescued[kl] && hitTest(v) == -1) continue; /* what it hit is no longer there */
      deaths[m++] = v; deaths[m++] = kl;
    }
    nd = m;
  }
  /* A player waiting for a late turn whose crash was mutual (the other snake dies from
     hitting the player in this same step, e.g. head-on) gets no grace: both die, as offline. */
  for (i32 s = 0; s < NS; s++) if (human[s] && pendT[s] == 2 && S[s].alive)
    for (i32 i = 0; i < nd; i += 2) if (deaths[i] == pendK[s] && deaths[i + 1] == s) { deaths[nd++] = s; deaths[nd++] = pendK[s]; pendT[s] = 0; break; }
  for (i32 i = 0; i < nd; i += 2) killSnake(deaths[i], deaths[i + 1] >= 0 ? deaths[i + 1] : -1);

  for (i32 s = 0; s < NS; s++) if (S[s].alive && S[s].near) eat(s, dt);
  predictHeads();
  for (i32 s = 1; s <= NB; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    if (k->near) {
      i32 e = T_EVERY[k->tier];
      if ((tick + (u32)s) % (u32)e == 0) botThink(s, dt * (float)e);
    } else {
      if (((tick + (u32)s) & 15u) == 0) farThink(s, dt * 16.f);
    }
  }

  for (i32 s = 1; s <= NB; s++) if (!S[s].alive && (S[s].respawnT -= dt) <= 0) spawnBot(s);

  for (i32 f = 0; f < nfoc; f++) maintainFood(f, 24);
  publish();
}

/* ---------- exports (used by server.js) ---------- */
void sim_init(u32 seed, i32 bots) {
  rs = seed ? seed : 1u;
  NS = MAXS; NB = bots < MAXS - 2 ? bots : MAXS - 2;
  nfree = 0; foodHigh = 0; tick = 0; nfoc = 0;
  for (i32 i = 0; i < MAXF; i++) { F[i].v = 0; fCell[i] = -1; }
  __builtin_memset(gHead, 0xff, sizeof gHead); __builtin_memset(gCell, 0xff, sizeof gCell); /* empty body grid */
  __builtin_memset(fHead, 0xff, sizeof fHead); __builtin_memset(fCnt, 0, sizeof fCnt); /* every cell empty */
  for (i32 s = 0; s < MAXS; s++) { S[s].alive = 0; human[s] = 0; killedBy[s] = -1; aspect[s] = 1.78f; }
  rebuild();
  for (i32 i = 0; i < 256; i++) frT[i] = minf(3.5f + sqrtf_((float)i / 16.f) * 2.6f, 15.f);
  for (i32 i = 0; i < 13; i++) { float a = (float)(i - 6) * 0.3f; ROT[i * 2] = cosf_(a); ROT[i * 2 + 1] = sinf_(a); }
  for (i32 i = 0; i < 7; i++) { float a = (float)(i - 3) * 0.45f; ROT_WIDE[i * 2] = cosf_(a); ROT_WIDE[i * 2 + 1] = sinf_(a); }
  deathTick = 0xffff0000u;
  for (i32 s = 1; s <= NB; s++) spawnBot(s);
  publish();
}

/* A player joins: claim a free non-bot slot (-1 = server full). */
i32 sim_add_human(void) {
  for (i32 s = 0; s < MAXS; s++) if (!isBot(s) && !human[s] && !S[s].alive) { human[s] = 1; killedBy[s] = -1; return s; }
  return -1;
}
void sim_remove_human(i32 s) {
  if (s < 0 || s >= MAXS || !human[s]) return;
  killSnake(s, -1); human[s] = 0; /* leaves food behind, like any death */
}
/* (Re)spawn a player's snake on the outer rim, like offline. */
void sim_spawn_human(i32 s, i32 skin) {
  if (s >= 0 && s < MAXS) { pendT[s] = 0; inArrived[s] = 0; if (graceSteps[s] < 1.f) graceSteps[s] = 1.f; }
  if (s < 0 || s >= MAXS || !human[s] || S[s].alive) return;
  S[s].tier = 0; killedBy[s] = -1;
  spawnSnake(s, 10.f, (skin % 12 + 12) % 12);
  setFoci(); /* count and fill the new player's view with food at once, like offline */
  for (i32 f = 0; f < nfoc; f++) if (focS[f] == s) { countFood(f); maintainFood(f, 4000); }
  publish();
}
void sim_set_lag(i32 s, float steps) { if (s >= 0 && s < MAXS) lagSteps[s] = steps < 0.f ? 0.f : steps > 24.f ? 24.f : steps; }
void sim_set_jitter(i32 s, i32 steps) { if (s >= 0 && s < MAXS) graceSteps[s] = (float)(steps < 1 ? 1 : steps > 10 ? 10 : steps); }
void sim_set_input(i32 s, float aim, i32 boost, i32 late) {
  if (s < 0 || s >= MAXS || !human[s] || !S[s].alive) return;
  S[s].tang = wrapa(aim); S[s].wantBoost = boost != 0;
  late = late < 0 ? 0 : late > 12 ? 12 : late;
  inLog[s][inN[s] & 63u] = (InRec){tick + 1u, S[s].pc, late, S[s].tang, (u32)S[s].wantBoost}; inN[s]++;
  inArrived[s] = 1; if (late > inLate[s]) inLate[s] = late;
}
void sim_set_menu_focus(i32 on, float x, float y, float r) {
  float dx = x - exX, dy = y - exY;
  if (on && (!exOn || dx * dx + dy * dy > 500.f * 500.f)) exRecount = 1; /* new place: count its food */
  exOn = on; exX = x; exY = y; exR = r;
}
void sim_set_aspect(i32 s, float a) { if (s >= 0 && s < MAXS) aspect[s] = a < 0.3f ? 0.3f : a > 4.f ? 4.f : a; }

/* Fixed 60 Hz steps, driven by server.js. */
void sim_step(void) { step(DT); }
u32 sim_tick(void) { return tick; }

/* Food change log (see foodChanged), drained by the server after every step. */
u32 *sim_food_events(void) { return fev; }
i32 sim_food_event_count(void) { return nfev; }
i32 sim_food_events_lost(void) { return fevLost; }
void sim_food_events_clear(void) { nfev = 0; fevLost = 0; }

Pub *sim_pub(void) { return pub; }
short *sim_trail(void) { return &tr[0][0][0]; }
Food *sim_food(void) { return F; }
i32 sim_max_food(void) { return MAXF; }
i32 sim_ring(void) { return RING; }
i32 sim_max_snakes(void) { return MAXS; }
i32 sim_bot_count(void) { return NB; }
float sim_world_radius(void) { return WR; }
i32 sim_killed_by(i32 s) { return killedBy[s]; }
