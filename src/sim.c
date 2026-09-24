/*
 * Serpent.io simulation core — compiled to WebAssembly (no libc, no malloc).
 *
 * Everything lives in static memory, so the JS side can create typed-array
 * views once and never re-allocate.
 *
 * Old-machine tricks:
 *  - A body is never moved. Each snake is a ring buffer of its head's trail
 *    (16-bit fixed point); a step only pushes a point when the head has
 *    travelled one segment spacing, so movement is O(1) per snake, not O(len).
 *    Segments are the trail sampled at equal arc length (exact, smooth).
 *  - Spatial hash is incremental: new trail points / pellets are linked into
 *    their cell as they appear, stale nodes are skipped by a validity check,
 *    and the lists are compacted only every REBUILD steps.
 * Rendering data is written into a flat instance buffer that JS uploads to the
 * GPU with a single bufferSubData and draws with a single instanced call.
 */
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;

#define EXPORT(n) __attribute__((export_name(n)))
#define PI 3.14159265f
#define TAU 6.28318531f
#define MAXS 48          /* snakes (slot 0 = player) */
#define RING 512         /* trail ring per snake (power of two) */
#define RMASK (RING - 1)
#define MAXSEG (RING - 1)
#define MAXF 8192        /* food pellets */
#define WR 4000.f        /* world radius */
#define CELL 100.f       /* spatial hash cell size (>= max query radius) */
#define GN 80            /* grid cells per side: 2*WR/CELL */
#define GC (GN * GN)
#define MAXI 4096        /* food sprites */
#define MC 32.f          /* owner-map cell */
#define MN 250           /* owner-map cells per side: 2*WR/MC */
#define POOL 16384       /* segment grid nodes */
#define REBUILD 32       /* steps between grid compactions */

/* freestanding: the compiler may emit calls to these for struct copies */
void *memcpy(void *d, const void *s, unsigned long n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int v, unsigned long n) { u8 *a = d; while (n--) *a++ = (u8)v; return d; }

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
  i32 n, alive, boost, wantBoost, skin, bot, kills, target, tier, near;
  u32 pc; /* trail points pushed so far (monotonic across lives) */
  float phx, phy; u32 ppc; /* state before the last fixed step (render interpolation) */
} Snake;

static Snake S[MAXS];
/* trail, fixed point Q3, interleaved x,y: uploaded as-is to an RG16I texture */
static short tr[MAXS][RING][2];
static i32 NS = 40;

/* food: 16-bit fixed-point position, value in 1/16ths -> 8 bytes per pellet */
static short fx[MAXF], fy[MAXF];
static u8 fv[MAXF], fs[MAXF], fa[MAXF], fph[MAXF];
static short freeList[MAXF], pend[MAXF];
static i32 nfree, npend, foodAlive, foodHigh, foodTarget = 3600;
static float frT[256]; /* pellet radius by value byte */
#define FV(i) ((float)fv[i] * (1.f / 16.f))

static short gHead[GC], gNext[POOL], fHead[GC], fNext[MAXF];
static u32 gC[POOL]; static u8 gS[POOL]; static i32 gN;

/* Level of detail: only snakes near the focus (the camera) get collisions,
   eating and real AI. Everything else runs a cheap statistical model. */
static float focX, focY, focR = 2000.f;

/* Bot tiers: rookie, casual, hunter, elite */
static const i32 T_EVERY[4] = {4, 2, 2, 1};             /* think every N steps */
static const float T_LOOK[4] = {0.6f, 1.f, 1.2f, 1.45f}; /* probe reach */
static const float T_AGGR[4] = {0.f, 0.25f, 0.6f, 1.f};  /* hunting appetite */
static const float T_NOISE[4] = {0.35f, 0.12f, 0.04f, 0.f};
static const float T_GROW[4] = {0.35f, 0.6f, 0.9f, 1.2f}; /* far-away growth, mass/s */
static const float T_RISK[4] = {1.f / 50, 1.f / 80, 1.f / 130, 1.f / 200}; /* far-away deaths/s */
static const float T_CAP[4] = {300.f, 700.f, 1400.f, 2200.f};
static const float T_MASS[4] = {50.f, 190.f, 470.f, 840.f}; /* spawn mass spread */
/* Owner map: which snake (id+1) left a trail point in each 32x32 area, 255 =
   several. Bots test danger with a handful of byte reads. Cleared at compaction,
   so a vacated tail area stays "occupied" for at most REBUILD steps (safe side). */
static u8 omap[MN * MN];

typedef struct { float x, y, r; u32 info; } Inst;
static Inst inst[MAXI];

static u32 tick;
static i32 playerKiller = -1;

/* ---------- helpers ---------- */
static i32 cellX(float x) { i32 c = (i32)((x + WR) * (1.f / CELL)); return c < 0 ? 0 : c >= GN ? GN - 1 : c; }
static i32 cellOf(float x, float y) { return cellX(y) * GN + cellX(x); }

static short q3(float v) { v *= 8.f; v += v >= 0 ? 0.5f : -0.5f; return (short)(v > 32767.f ? 32767.f : v < -32767.f ? -32767.f : v); }
#define UQ(v) ((float)(v) * 0.125f)
/* trail point j (0 = newest) */
#define TX(s, j) UQ(tr[s][(S[s].pc - 1u - (u32)(j)) & RMASK][0])
#define TY(s, j) UQ(tr[s][(S[s].pc - 1u - (u32)(j)) & RMASK][1])

/* growth curves (slow on purpose: size is earned) */
static float radiusFor(float m) { return minf(10.f + sqrtf_(m) * 0.6f, 40.f); }
static i32 segsFor(float m) { i32 n = 14 + (i32)(4.5f * sqrtf_(m)); return n > MAXSEG ? MAXSEG : n; }

/* ---------- spatial hash ---------- */
static void segInsert(i32 s, u32 c) {
  if (gN >= POOL) return; /* compaction is forced before this can matter */
  i32 i = gN++, cell = cellOf(UQ(tr[s][c & RMASK][0]), UQ(tr[s][c & RMASK][1]));
  gS[i] = (u8)s; gC[i] = c; gNext[i] = gHead[cell]; gHead[cell] = (short)i;
  i32 mx = (i32)((UQ(tr[s][c & RMASK][0]) + WR) * (1.f / MC)), my = (i32)((UQ(tr[s][c & RMASK][1]) + WR) * (1.f / MC));
  if ((u32)mx < MN && (u32)my < MN) { u8 *m = &omap[my * MN + mx], v = (u8)(s + 1); *m = *m == 0 || *m == v ? v : 255; }
}
/* node -> valid segment of a live snake? */
static i32 segLive(i32 i) {
  Snake *o = &S[gS[i]];
  return o->alive && o->pc - gC[i] <= (u32)o->n;
}
static void foodInsert(i32 i) { i32 c = cellOf(UQ(fx[i]), UQ(fy[i])); fNext[i] = fHead[c]; fHead[c] = (short)i; }

static void rebuild(void) {
  for (i32 c = 0; c < GC; c++) gHead[c] = -1, fHead[c] = -1;
  __builtin_memset(omap, 0, sizeof omap);
  gN = 0;
  for (i32 s = 0; s < NS; s++)
    if (S[s].alive) for (i32 j = S[s].n - 1; j >= 0; j--) segInsert(s, S[s].pc - 1u - (u32)j);
  while (npend) freeList[nfree++] = pend[--npend]; /* slots are unlinked now: reusable */
  for (i32 i = 0; i < foodHigh; i++) if (fa[i]) foodInsert(i);
}

static void killFood(i32 i) { fa[i] = 0; pend[npend++] = (short)i; foodAlive--; }
static void spawnFood(float x, float y, float v, i32 skin) {
  if (!nfree) return;
  i32 i = freeList[--nfree];
  if (i >= foodHigh) foodHigh = i + 1;
  fx[i] = q3(x); fy[i] = q3(y); fv[i] = (u8)(i32)minf(v * 16.f + 0.5f, 255.f); fs[i] = (u8)skin; fa[i] = 1; fph[i] = (u8)rnd();
  foodInsert(i);
  foodAlive++;
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
  i32 x0 = (i32)((x - R + WR) * (1.f / MC)), x1 = (i32)((x + R + WR) * (1.f / MC));
  i32 y0 = (i32)((y - R + WR) * (1.f / MC)), y1 = (i32)((y + R + WR) * (1.f / MC));
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= MN) x1 = MN - 1; if (y1 >= MN) y1 = MN - 1;
  u8 me = (u8)(self + 1);
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
  tr[s][i][0] = q3(x); tr[s][i][1] = q3(y);
  segInsert(s, k->pc);
  k->pc++;
}

static void randomRing(float r0, float r1, float *x, float *y) {
  float a = frand() * TAU, d = sqrtf_(r0 * r0 + (r1 * r1 - r0 * r0) * frand());
  *x = cosf_(a) * d; *y = sinf_(a) * d;
}
/* big snakes live in the middle, small ones roam the rest */
static void homePoint(float mass, float *x, float *y) {
  if (mass > 250.f) randomDisk(WR * 0.35f, x, y); else randomRing(WR * 0.3f, WR * 0.88f, x, y);
}

static void spawnSnake(i32 s, float mass, i32 bot, i32 skin) {
  Snake *k = &S[s];
  float x = 0, y = 0;
  for (i32 t = 0; t < 40; t++) {
    if (!bot) randomRing(WR * 0.72f, WR * 0.86f, &x, &y); /* player: outer rim */
    else homePoint(mass, &x, &y);
    float dx = x - focX, dy = y - focY;
    if (bot && t < 30 && dx * dx + dy * dy < (focR + 300.f) * (focR + 300.f)) continue; /* never pop in on screen */
    if (!dangerAt(s, x, y, 300.f)) break;
  }
  k->ang = k->tang = frand() * TAU - PI;
  k->mass = mass; k->r = radiusFor(mass); k->spacing = k->r * 0.42f; k->n = segsFor(mass);
  k->bot = bot; k->skin = skin; k->kills = 0; k->boost = k->wantBoost = 0;
  k->dropT = k->dropMass = 0; k->aiT = 0; k->huntT = 0; k->target = -1; k->near = 1;
  k->tx = x; k->ty = y; k->hx = x; k->hy = y;
  /* lay a full ring of trail behind the head; pc keeps counting so nodes from a
     previous life can never look valid again */
  float cx = cosf_(k->ang), sy = sinf_(k->ang);
  k->pc += RING;
  for (u32 j = 0; j < RING; j++) {
    u32 i = (k->pc - 1u - j) & RMASK;
    tr[s][i][0] = q3(x - cx * k->spacing * (float)j); tr[s][i][1] = q3(y - sy * k->spacing * (float)j);
  }
  k->alive = 1; k->phx = x; k->phy = y; k->ppc = k->pc;
  for (i32 j = k->n - 1; j >= 0; j--) segInsert(s, k->pc - 1u - (u32)j);
}

static void killSnake(i32 s, i32 killer) {
  Snake *k = &S[s];
  if (!k->alive) return;
  k->alive = 0;
  float per = k->mass * 0.85f / (float)(k->n / 2 + 1), j = k->r * 0.6f;
  for (i32 i = 0; i < k->n; i += 2)
    spawnFood(TX(s, i) + (frand() - 0.5f) * j, TY(s, i) + (frand() - 0.5f) * j, per * (0.6f + frand() * 0.8f), k->skin);
  if (killer >= 0) S[killer].kills++;
  if (s == 0) playerKiller = killer;
  k->respawnT = 1.5f + frand() * 3.f;
}

static void moveSnake(i32 s, float dt) {
  Snake *k = &S[s];
  float turn = 5.2f / (1.f + (k->r - 12.f) * 0.045f) * dt;
  float da = wrapa(k->tang - k->ang);
  if (da > turn) da = turn; else if (da < -turn) da = -turn;
  k->ang = wrapa(k->ang + da);

  k->boost = k->wantBoost && k->mass > 14.f;
  float speed = k->boost ? 430.f : 195.f;
  k->hx += cosf_(k->ang) * speed * dt;
  k->hy += sinf_(k->ang) * speed * dt;

  if (k->boost) {
    float lose = (6.f + k->mass * 0.006f) * dt;
    k->mass -= lose; k->dropMass += lose; k->dropT += dt;
    if (k->dropT > 0.1f) {
      spawnFood(TX(s, k->n - 1), TY(s, k->n - 1), k->dropMass * 0.8f, k->skin);
      k->dropT = 0; k->dropMass = 0;
    }
  }

  k->r = radiusFor(k->mass);
  k->spacing = k->r * 0.42f;
  i32 want = segsFor(k->mass);
  /* growth reveals older trail points: link them into the grid */
  while (k->n < want) { segInsert(s, k->pc - 1u - (u32)k->n); k->n++; }
  k->n = want;

  /* head-driven trail: push points at exact spacing (O(1) per snake) */
  float sp = k->spacing;
  for (i32 t = 0; t < 4; t++) {
    float lx = TX(s, 0), ly = TY(s, 0), dx = k->hx - lx, dy = k->hy - ly, d2 = dx * dx + dy * dy;
    if (d2 < sp * sp) break;
    float f = sp / sqrtf_(d2);
    pushTrail(s, lx + dx * f, ly + dy * f);
  }
}

static i32 hitTest(i32 s) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  float lim = WR - k->r * 0.5f;
  if (hx * hx + hy * hy > lim * lim) return -2;
  i32 cx = cellX(hx), cy = cellX(hy);
  for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GN) continue;
    for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GN) continue;
      for (i32 i = gHead[gy * GN + gx]; i >= 0; i = gNext[i]) {
        i32 o = gS[i];
        if (o == s || !segLive(i)) continue;
        u32 j = gC[i] & RMASK;
        float dx = UQ(tr[o][j][0]) - hx, dy = UQ(tr[o][j][1]) - hy, t = (k->r + S[o].r) * 0.66f;
        if (dx * dx + dy * dy < t * t) return o;
      }
    }
  }
  return -1;
}

static void eat(i32 s, float dt) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  float att = k->r * 1.5f + 34.f, att2 = att * att, pull = minf(1.f, dt * 10.f);
  i32 cx = cellX(hx), cy = cellX(hy);
  for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GN) continue;
    for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GN) continue;
      for (i32 i = fHead[gy * GN + gx]; i >= 0; i = fNext[i]) {
        if (!fa[i]) continue;
        float px = UQ(fx[i]), py = UQ(fy[i]);
        float dx = px - hx, dy = py - hy, d2 = dx * dx + dy * dy, er = k->r + frT[fv[i]] * 0.5f;
        if (d2 < er * er) { k->mass += FV(i); killFood(i); }
        else if (d2 < att2) { fx[i] = q3(px - dx * pull); fy[i] = q3(py - dy * pull); }
      }
    }
  }
}

/* ---------- bot brain ---------- */
static void botThink(i32 s, float dt) {
  Snake *k = &S[s];
  float hx = k->hx, hy = k->hy;
  k->aiT -= dt;

  if (k->huntT > 0) {
    k->huntT -= dt;
    Snake *o = &S[k->target];
    if (k->target < 0 || !o->alive) k->huntT = 0;
    else {
      float lead = o->r * 4.f + 70.f;
      k->tx = o->hx + cosf_(o->ang) * lead;
      k->ty = o->hy + sinf_(o->ang) * lead;
    }
  }
  if (k->huntT <= 0 && k->aiT <= 0) {
    k->aiT = 0.25f + frand() * 0.5f;
    k->target = -1;
    /* aggressive bots look for prey */
    if (frand() < T_AGGR[k->tier] * 0.35f) {
      float best = 650.f * 650.f;
      for (i32 o = 0; o < NS; o++) {
        if (o == s || !S[o].alive || S[o].mass > k->mass * 1.3f) continue;
        float dx = S[o].hx - hx, dy = S[o].hy - hy, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; k->target = o; }
      }
      if (k->target >= 0) k->huntT = 1.f + frand() * 1.5f;
    }
    if (k->target < 0 && k->mass > 250.f && hx * hx + hy * hy > WR * WR * 0.2f && frand() < 0.5f) {
      homePoint(k->mass, &k->tx, &k->ty); /* big snakes drift back to the middle */
      k->aiT = 1.5f;
    } else if (k->target < 0) {
      /* best food by value / distance, favouring what is in front */
      float ca = cosf_(k->ang), sa = sinf_(k->ang), bestScore = 0;
      i32 cx = cellX(hx), cy = cellX(hy), w = k->tier == 0 ? 1 : 2;
      for (i32 gy = cy - w; gy <= cy + w; gy++) {
        if (gy < 0 || gy >= GN) continue;
        for (i32 gx = cx - w; gx <= cx + w; gx++) {
          if (gx < 0 || gx >= GN) continue;
          for (i32 i = fHead[gy * GN + gx]; i >= 0; i = fNext[i]) {
            if (!fa[i]) continue;
            float px = UQ(fx[i]), py = UQ(fy[i]);
            float dx = px - hx, dy = py - hy, d = sqrtf_(dx * dx + dy * dy) + 1.f;
            float score = FV(i) / (d + 60.f) * (1.6f + (dx * ca + dy * sa) / d);
            if (score > bestScore) { bestScore = score; k->tx = px; k->ty = py; }
          }
        }
      }
      if (bestScore == 0) homePoint(k->mass, &k->tx, &k->ty);
    }
  }

  float desired = atan2f_(k->ty - hy, k->tx - hx);
  float L = T_LOOK[k->tier];
  float l1 = (k->r * 1.6f + 55.f) * L, l2 = (k->r * 1.6f + 170.f) * L, pr = k->r * 1.15f;
  float bestA = desired, bestCost = 1e9f;
  i32 nc = k->tier == 0 ? 7 : 13;
  float spread = k->tier == 0 ? 0.45f : 0.3f;
  for (i32 c = 0; c < nc; c++) {
    float a = c < nc - 1 ? k->ang + ((float)c - (float)(nc - 2) * 0.5f) * spread : desired;
    float ca = cosf_(a), sa = sinf_(a);
    float cost = absf(wrapa(a - desired));
    if (cost >= bestCost) continue;
    if (dangerAt(s, hx + ca * l1, hy + sa * l1, pr)) cost += 100.f;
    else if (dangerAt(s, hx + ca * l2, hy + sa * l2, pr)) cost += 20.f;
    if (cost < bestCost) { bestCost = cost; bestA = a; }
  }
  k->tang = bestA + (frand() - 0.5f) * 2.f * T_NOISE[k->tier];
  float dx = k->tx - hx, dy = k->ty - hy;
  k->wantBoost = (k->tier >= 2 && k->huntT > 0 && k->mass > 30.f && dx * dx + dy * dy < 450.f * 450.f && bestCost < 20.f) ||
                 (k->tier >= 1 && bestCost >= 100.f && k->mass > 40.f && frand() < 0.05f);
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
}

static void spawnBot(i32 s) {
  float r = frand(), t = frand();
  i32 tier = r < 0.35f ? 0 : r < 0.7f ? 1 : r < 0.9f ? 2 : 3;
  S[s].tier = tier;
  spawnSnake(s, 10.f + t * t * T_MASS[tier], 1, (i32)(rnd() % 12));
}

/* ---------- simulation step ---------- */
static i32 deaths[MAXS * 2];

static void step(float dt) {
  tick++;
  if (tick % REBUILD == 0 || gN > POOL - 4096 || npend > MAXF / 2) rebuild();
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    float dx = k->hx - focX, dy = k->hy - focY, R = focR + k->r * 2.f;
    k->near = s == 0 || dx * dx + dy * dy < R * R;
    moveSnake(s, dt);
  }

  i32 nd = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive || !S[s].near) continue;
    i32 h = hitTest(s);
    if (h != -1) { deaths[nd++] = s; deaths[nd++] = h; }
  }
  for (i32 i = 0; i < nd; i += 2) killSnake(deaths[i], deaths[i + 1] >= 0 ? deaths[i + 1] : -1);

  for (i32 s = 0; s < NS; s++) if (S[s].alive && S[s].near) eat(s, dt);
  for (i32 s = 1; s < NS; s++) {
    Snake *k = &S[s];
    if (!k->alive) continue;
    if (k->near) {
      i32 e = T_EVERY[k->tier];
      if ((tick + (u32)s) % (u32)e == 0) botThink(s, dt * (float)e);
    } else {
      if ((tick + (u32)s) % 16u == 0) farThink(s, dt * 16.f);
      if (k->mass < T_CAP[k->tier]) k->mass += T_GROW[k->tier] * dt;
      if (frand() < T_RISK[k->tier] * dt) killSnake(s, -1);
    }
  }

  for (i32 s = 1; s < NS; s++) if (!S[s].alive && (S[s].respawnT -= dt) <= 0) spawnBot(s);

  /* old food far from the player fades so the world never floods */
  for (i32 t = 0; t < 4 && foodAlive > foodTarget + 800 && foodHigh; t++) {
    i32 i = (i32)(rnd() % (u32)foodHigh);
    float dx = UQ(fx[i]) - focX, dy = UQ(fy[i]) - focY;
    if (fa[i] && dx * dx + dy * dy > focR * focR) killFood(i);
  }
  for (i32 t = 0; t < 24 && foodAlive < foodTarget; t++) {
    float x, y; randomDisk(WR * 0.98f, &x, &y);
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
  }
}

/* ---------- exports ---------- */
EXPORT("init") void init(u32 seed, i32 bots) {
  rs = seed ? seed : 1u;
  NS = bots + 1 > MAXS ? MAXS : bots + 1;
  nfree = 0; npend = 0; foodAlive = 0; foodHigh = 0; tick = 0; playerKiller = -1;
  for (i32 i = MAXF - 1; i >= 0; i--) { fa[i] = 0; freeList[nfree++] = (short)i; }
  for (i32 s = 0; s < MAXS; s++) S[s].alive = 0;
  rebuild();
  for (i32 i = 0; i < 256; i++) frT[i] = minf(3.5f + sqrtf_((float)i / 16.f) * 2.6f, 15.f);
  focX = focY = 0; focR = 2000.f;
  for (i32 s = 1; s < NS; s++) spawnBot(s);
  while (foodAlive < foodTarget) {
    float x, y; randomDisk(WR * 0.98f, &x, &y);
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
  }
}

EXPORT("spawnPlayer") void spawnPlayer(i32 skin) { S[0].tier = 3; spawnSnake(0, 10.f, 0, skin); playerKiller = -1; }
EXPORT("setFocus") void setFocus(float x, float y, float r) { focX = x; focY = y; focR = r; }
EXPORT("killPlayer") void killPlayer(void) { S[0].alive = 0; }

EXPORT("setInput") void setInput(float ang, i32 boost) { S[0].tang = ang; S[0].wantBoost = boost; }

/* Fixed 60 Hz simulation (Fiedler, "Fix Your Timestep"): identical behaviour at
   any refresh rate; rendering interpolates between the last two states. */
#define DT (1.f / 60.f)
static float acc, alpha;
EXPORT("update") void update(float dt) {
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

static void push(float x, float y, float r, u32 kind, u32 skin, u32 extra, u32 flags, i32 *n) {
  if (*n >= MAXI) return;
  Inst *p = &inst[(*n)++];
  p->x = x; p->y = y; p->r = r;
  p->info = kind | (skin << 8) | ((extra & 255u) << 16) | (flags << 24);
}

/* View-culled food sprites. */
EXPORT("build") i32 build(float cx, float cy, float hw, float hh) {
  i32 n = 0;
  float x0 = cx - hw - 60.f, x1 = cx + hw + 60.f, y0 = cy - hh - 60.f, y1 = cy + hh + 60.f;
  i32 gx0 = cellX(x0 - CELL), gx1 = cellX(x1 + CELL), gy0 = cellX(y0 - CELL), gy1 = cellX(y1 + CELL);
  for (i32 gy = gy0; gy <= gy1; gy++)
    for (i32 gx = gx0; gx <= gx1; gx++)
      for (i32 i = fHead[gy * GN + gx]; i >= 0; i = fNext[i])
        if (fa[i]) {
          float px = UQ(fx[i]), py = UQ(fy[i]);
          if (px > x0 && px < x1 && py > y0 && py < y1) push(px, py, frT[fv[i]], 0, fs[i], fph[i], 0, &n);
        }
  return n;
}

/* ---------- snake ribbons (built on the GPU) ----------
   The vertex shader pulls trail points straight from an RG16I texture that is
   a byte-for-byte copy of tr[][][], and generates the ribbon strip itself
   (one instance per visible snake). The CPU only writes a 48-byte header per
   visible snake. The fragment shader then reconstructs the overlapping-circle
   scales analytically (~1x overdraw). */
typedef struct { float hx, hy, u, r, spacing, stride, ang, W; u32 row, newest, n, info; } Head;
static Head hdr[MAXS];
static i32 nvis, maxK;
/* per-snake snapshot for JS (camera, HUD, minimap, labels): one read, no calls */
typedef struct { float alive, x, y, mass, r, skin, tier, near, onScreen, kills; } Snap;
static Snap snap[MAXS];

static float ihx[MAXS], ihy[MAXS], iu[MAXS]; static u32 inew[MAXS];

/* Interpolated state for this frame (call after update). */
EXPORT("snapshot") void snapshot(void) {
  for (i32 s = 0; s < NS; s++) {
    Snake *k = &S[s];
    Snap *sn = &snap[s];
    sn->alive = (float)k->alive;
    if (!k->alive) { sn->onScreen = 0; continue; }
    /* interpolated head; if the last step pushed trail points the head is now
       "behind" them, so step back to the newest point it is still ahead of */
    float hx = k->phx + (k->hx - k->phx) * alpha, hy = k->phy + (k->hy - k->phy) * alpha;
    float ca = cosf_(k->ang), sa = sinf_(k->ang);
    u32 j0 = 0, pushes = k->pc - k->ppc;
    if (pushes > 4) pushes = 4;
    while (j0 < pushes && (hx - TX(s, j0)) * ca + (hy - TY(s, j0)) * sa < 0) j0++;
    float dx = hx - TX(s, j0), dy = hy - TY(s, j0);
    ihx[s] = hx; ihy[s] = hy; inew[s] = (k->pc - 1u - j0) & RMASK;
    iu[s] = 1.f - minf(sqrtf_(dx * dx + dy * dy) / k->spacing, 1.f);
    sn->x = hx; sn->y = hy; sn->mass = k->mass; sn->r = k->r; sn->skin = (float)k->skin;
    sn->tier = (float)k->tier; sn->near = (float)k->near; sn->kills = (float)k->kills;
  }
}

/* Cull against the camera, write one GPU header per visible snake. */
EXPORT("renderPrep") i32 renderPrep(float cx, float cy, float hw, float hh, float px) {
  nvis = 0; maxK = 0;
  for (i32 o = 1; o <= NS; o++) {
    i32 s = o == NS ? 0 : o;
    Snake *k = &S[s];
    if (!k->alive) continue;
    float hx = ihx[s], hy = ihy[s];
    snap[s].onScreen = (float)(hx > cx - hw && hx < cx + hw && hy > cy - hh && hy < cy + hh);
    i32 n = k->n;
    float W = k->boost ? 1.9f : 1.08f, m = k->r * W * 2.f + 20.f;
    float x0 = cx - hw - m, x1 = cx + hw + m, y0 = cy - hh - m, y1 = cy + hh + m;
    /* integer cull on the raw 16-bit trail */
    i32 any = hx > x0 && hx < x1 && hy > y0 && hy < y1;
    if (!any) {
      i32 qx0 = (i32)(x0 * 8.f), qx1 = (i32)(x1 * 8.f), qy0 = (i32)(y0 * 8.f), qy1 = (i32)(y1 * 8.f);
      for (i32 i = 0; i < n && !any; i++) {
        const short *t = tr[s][(k->pc - 1u - (u32)i) & RMASK];
        any = t[0] > qx0 && t[0] < qx1 && t[1] > qy0 && t[1] < qy1;
      }
    }
    if (!any) continue;
    float spx = k->spacing / px;
    i32 stride = spx < 1.2f ? 4 : spx < 2.5f ? 2 : 1;
    i32 K = (n - 1 + stride - 1) / stride;
    if (K > maxK) maxK = K;
    Head *h = &hdr[nvis++];
    h->hx = hx; h->hy = hy; h->u = iu[s]; h->r = k->r; h->spacing = k->spacing; h->stride = (float)stride;
    h->ang = k->ang; h->W = W; h->row = (u32)s; h->newest = inew[s]; h->n = (u32)n;
    h->info = (u32)k->skin | ((u32)(k->boost | (s == 0 ? 2 : 0)) << 8);
  }
  return nvis;
}
EXPORT("hdrPtr") Head *hdrPtr(void) { return hdr; }
EXPORT("maxK") i32 maxKOut(void) { return maxK; }
EXPORT("snapPtr") Snap *snapPtr(void) { return snap; }
EXPORT("trailPtr") short *trailPtr(void) { return &tr[0][0][0]; }
EXPORT("ring") i32 ringSize(void) { return RING; }

EXPORT("instPtr") Inst *instPtr(void) { return inst; }
EXPORT("maxInst") i32 maxInst(void) { return MAXI; }
EXPORT("worldRadius") float worldRadius(void) { return WR; }
EXPORT("snakeCount") i32 snakeCount(void) { return NS; }
EXPORT("alive") i32 alive(i32 s) { return S[s].alive; }
EXPORT("mass") float mass(i32 s) { return S[s].mass; }
EXPORT("radius") float radius(i32 s) { return S[s].r; }
EXPORT("headX") float headX(i32 s) { return S[s].hx; }
EXPORT("headY") float headY(i32 s) { return S[s].hy; }
EXPORT("kills") i32 kills(i32 s) { return S[s].kills; }
EXPORT("skin") i32 skin(i32 s) { return S[s].skin; }
EXPORT("segments") i32 segments(i32 s) { return S[s].n; }
EXPORT("foodCount") i32 foodCount(void) { return foodAlive; }
EXPORT("killer") i32 killer(void) { return playerKiller; }
EXPORT("tier") i32 tier(i32 s) { return S[s].tier; }
EXPORT("isNear") i32 isNear(i32 s) { return S[s].alive && S[s].near; }
