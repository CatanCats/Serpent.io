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
#define MAXF 10000       /* food pellets */
#define WR 4000.f        /* world radius */
#define CELL 100.f       /* spatial hash cell size (>= max query radius) */
#define GN 80            /* grid cells per side: 2*WR/CELL */
#define GC (GN * GN)
#define MAXI 8192        /* food sprites */
#define MAXV 12288       /* ribbon vertices */
#define MC 32.f          /* owner-map cell */
#define MN 250           /* owner-map cells per side: 2*WR/MC */
#define POOL 32768       /* segment grid nodes */
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
  float ang, tang, mass, r, spacing, dropT, dropMass, aiT, tx, ty, respawnT, huntT, aggr, hx, hy;
  i32 n, alive, boost, wantBoost, skin, bot, kills, target;
  u32 pc; /* trail points pushed so far (monotonic across lives) */
} Snake;

static Snake S[MAXS];
static short trx[MAXS][RING], try_[MAXS][RING]; /* trail, fixed point Q3 */
static i32 NS = 40;

static float fx[MAXF], fy[MAXF], fr[MAXF], fv[MAXF];
static u8 fs[MAXF], fa[MAXF], fph[MAXF];
static i32 freeList[MAXF], nfree, pend[MAXF], npend, foodAlive, foodHigh, foodTarget = 3600;

static i32 gHead[GC], gNext[POOL], gN; static u32 gC[POOL]; static u8 gS[POOL];
static i32 fHead[GC], fNext[MAXF];
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
#define TX(s, j) UQ(trx[s][(S[s].pc - 1u - (u32)(j)) & RMASK])
#define TY(s, j) UQ(try_[s][(S[s].pc - 1u - (u32)(j)) & RMASK])

static float radiusFor(float m) { return minf(10.f + sqrtf_(m) * 0.9f, 44.f); }
static i32 segsFor(float m) { i32 n = 14 + (i32)(5.5f * sqrtf_(m)); return n > MAXSEG ? MAXSEG : n; }

/* ---------- spatial hash ---------- */
static void segInsert(i32 s, u32 c) {
  if (gN >= POOL) return; /* compaction is forced before this can matter */
  i32 i = gN++, cell = cellOf(UQ(trx[s][c & RMASK]), UQ(try_[s][c & RMASK]));
  gS[i] = (u8)s; gC[i] = c; gNext[i] = gHead[cell]; gHead[cell] = i;
  i32 mx = (i32)((UQ(trx[s][c & RMASK]) + WR) * (1.f / MC)), my = (i32)((UQ(try_[s][c & RMASK]) + WR) * (1.f / MC));
  if ((u32)mx < MN && (u32)my < MN) { u8 *m = &omap[my * MN + mx], v = (u8)(s + 1); *m = *m == 0 || *m == v ? v : 255; }
}
/* node -> valid segment of a live snake? */
static i32 segLive(i32 i) {
  Snake *o = &S[gS[i]];
  return o->alive && o->pc - gC[i] <= (u32)o->n;
}
static void foodInsert(i32 i) { i32 c = cellOf(fx[i], fy[i]); fNext[i] = fHead[c]; fHead[c] = i; }

static void rebuild(void) {
  for (i32 c = 0; c < GC; c++) gHead[c] = -1, fHead[c] = -1;
  __builtin_memset(omap, 0, sizeof omap);
  gN = 0;
  for (i32 s = 0; s < NS; s++)
    if (S[s].alive) for (i32 j = S[s].n - 1; j >= 0; j--) segInsert(s, S[s].pc - 1u - (u32)j);
  while (npend) freeList[nfree++] = pend[--npend]; /* slots are unlinked now: reusable */
  for (i32 i = 0; i < foodHigh; i++) if (fa[i]) foodInsert(i);
}

static void killFood(i32 i) { fa[i] = 0; pend[npend++] = i; foodAlive--; }
static void spawnFood(float x, float y, float v, i32 skin) {
  if (!nfree) return;
  i32 i = freeList[--nfree];
  if (i >= foodHigh) foodHigh = i + 1;
  fx[i] = x; fy[i] = y; fv[i] = v; fs[i] = (u8)skin; fa[i] = 1; fph[i] = (u8)rnd();
  fr[i] = minf(3.5f + sqrtf_(v) * 2.6f, 15.f);
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
  trx[s][i] = q3(x); try_[s][i] = q3(y);
  segInsert(s, k->pc);
  k->pc++;
}

static void spawnSnake(i32 s, float mass, i32 bot, i32 skin) {
  Snake *k = &S[s];
  float x = 0, y = 0;
  for (i32 t = 0; t < 30; t++) { randomDisk(WR * 0.75f, &x, &y); if (!dangerAt(s, x, y, 260.f)) break; }
  k->ang = k->tang = frand() * TAU - PI;
  k->mass = mass; k->r = radiusFor(mass); k->spacing = k->r * 0.42f; k->n = segsFor(mass);
  k->bot = bot; k->skin = skin; k->kills = 0; k->boost = k->wantBoost = 0;
  k->dropT = k->dropMass = 0; k->aiT = 0; k->huntT = 0; k->target = -1; k->aggr = frand();
  k->tx = x; k->ty = y; k->hx = x; k->hy = y;
  /* lay a full ring of trail behind the head; pc keeps counting so nodes from a
     previous life can never look valid again */
  float cx = cosf_(k->ang), sy = sinf_(k->ang);
  k->pc += RING;
  for (u32 j = 0; j < RING; j++) {
    u32 i = (k->pc - 1u - j) & RMASK;
    trx[s][i] = q3(x - cx * k->spacing * (float)j); try_[s][i] = q3(y - sy * k->spacing * (float)j);
  }
  k->alive = 1;
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
        float dx = UQ(trx[o][j]) - hx, dy = UQ(try_[o][j]) - hy, t = (k->r + S[o].r) * 0.66f;
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
        float dx = fx[i] - hx, dy = fy[i] - hy, d2 = dx * dx + dy * dy, er = k->r + fr[i] * 0.5f;
        if (d2 < er * er) { k->mass += fv[i]; killFood(i); }
        else if (d2 < att2) { fx[i] -= dx * pull; fy[i] -= dy * pull; }
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
    if (frand() < k->aggr * 0.35f) {
      float best = 650.f * 650.f;
      for (i32 o = 0; o < NS; o++) {
        if (o == s || !S[o].alive || S[o].mass > k->mass * 1.3f) continue;
        float dx = S[o].hx - hx, dy = S[o].hy - hy, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; k->target = o; }
      }
      if (k->target >= 0) k->huntT = 1.f + frand() * 1.5f;
    }
    if (k->target < 0) {
      /* best food by value / distance, favouring what is in front */
      float ca = cosf_(k->ang), sa = sinf_(k->ang), bestScore = 0;
      i32 cx = cellX(hx), cy = cellX(hy);
      for (i32 gy = cy - 2; gy <= cy + 2; gy++) {
        if (gy < 0 || gy >= GN) continue;
        for (i32 gx = cx - 2; gx <= cx + 2; gx++) {
          if (gx < 0 || gx >= GN) continue;
          for (i32 i = fHead[gy * GN + gx]; i >= 0; i = fNext[i]) {
            if (!fa[i]) continue;
            float dx = fx[i] - hx, dy = fy[i] - hy, d = sqrtf_(dx * dx + dy * dy) + 1.f;
            float score = fv[i] / (d + 60.f) * (1.6f + (dx * ca + dy * sa) / d);
            if (score > bestScore) { bestScore = score; k->tx = fx[i]; k->ty = fy[i]; }
          }
        }
      }
      if (bestScore == 0) randomDisk(WR * 0.6f, &k->tx, &k->ty);
    }
  }

  float desired = atan2f_(k->ty - hy, k->tx - hx);
  float l1 = k->r * 1.6f + 55.f, l2 = k->r * 1.6f + 170.f, pr = k->r * 1.15f;
  float bestA = desired, bestCost = 1e9f;
  for (i32 c = 0; c < 13; c++) {
    float a = c < 12 ? k->ang + ((float)c - 5.5f) * 0.3f : desired;
    float ca = cosf_(a), sa = sinf_(a);
    float cost = absf(wrapa(a - desired));
    if (cost >= bestCost) continue;
    if (dangerAt(s, hx + ca * l1, hy + sa * l1, pr)) cost += 100.f;
    else if (dangerAt(s, hx + ca * l2, hy + sa * l2, pr)) cost += 20.f;
    if (cost < bestCost) { bestCost = cost; bestA = a; }
  }
  k->tang = bestA;
  float dx = k->tx - hx, dy = k->ty - hy;
  k->wantBoost = (k->huntT > 0 && k->mass > 30.f && dx * dx + dy * dy < 450.f * 450.f && bestCost < 20.f) ||
                 (bestCost >= 100.f && k->mass > 40.f && frand() < 0.05f);
}

/* ---------- simulation step ---------- */
static i32 deaths[MAXS * 2];

static void step(float dt) {
  tick++;
  if (tick % REBUILD == 0 || gN > POOL - 4096 || npend > MAXF / 2) rebuild();
  for (i32 s = 0; s < NS; s++) if (S[s].alive) moveSnake(s, dt);

  i32 nd = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive) continue;
    i32 h = hitTest(s);
    if (h != -1) { deaths[nd++] = s; deaths[nd++] = h; }
  }
  for (i32 i = 0; i < nd; i += 2) killSnake(deaths[i], deaths[i + 1] >= 0 ? deaths[i + 1] : -1);

  for (i32 s = 0; s < NS; s++) if (S[s].alive) eat(s, dt);
  for (i32 s = 1; s < NS; s++) if (S[s].alive && ((tick + (u32)s) & 1u) == 0) botThink(s, dt * 2.f);

  for (i32 s = 1; s < NS; s++) {
    if (S[s].alive) continue;
    S[s].respawnT -= dt;
    if (S[s].respawnT <= 0) { float t = frand(); spawnSnake(s, 10.f + t * t * t * 520.f, 1, (i32)(rnd() % 12)); }
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
  for (i32 i = MAXF - 1; i >= 0; i--) { fa[i] = 0; freeList[nfree++] = i; }
  for (i32 s = 0; s < MAXS; s++) S[s].alive = 0;
  rebuild();
  for (i32 s = 1; s < NS; s++) { float t = frand(); spawnSnake(s, 10.f + t * t * t * 520.f, 1, (i32)(rnd() % 12)); }
  while (foodAlive < foodTarget) {
    float x, y; randomDisk(WR * 0.98f, &x, &y);
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
  }
}

EXPORT("spawnPlayer") void spawnPlayer(i32 skin) { spawnSnake(0, 10.f, 0, skin); playerKiller = -1; }
EXPORT("killPlayer") void killPlayer(void) { S[0].alive = 0; }

EXPORT("setInput") void setInput(float ang, i32 boost) { S[0].tang = ang; S[0].wantBoost = boost; }

EXPORT("update") void update(float dt) {
  if (dt > 0.1f) dt = 0.1f;
  i32 steps = (i32)(dt * 60.f + 0.95f);
  if (steps < 1) steps = 1;
  float h = dt / (float)steps;
  for (i32 i = 0; i < steps; i++) step(h);
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
        if (fa[i] && fx[i] > x0 && fx[i] < x1 && fy[i] > y0 && fy[i] < y1) push(fx[i], fy[i], fr[i], 0, fs[i], fph[i], 0, &n);
  return n;
}

/* ---------- snake ribbons ----------
   Each snake is ONE triangle strip along its body (all snakes joined with
   degenerate triangles -> one draw call). The fragment shader reconstructs the
   classic overlapping-circle scales analytically, so the look is unchanged but
   every pixel is shaded once instead of ~5 times. */
typedef struct { float x, y, t; u8 skin, flags, rq, spare; unsigned short nlast; signed char dx, dy; } Vert;
static Vert rib[MAXV];
static float qx[MAXSEG + 3], qy[MAXSEG + 3], qt[MAXSEG + 3];
static i32 nv;

static void vput(float x, float y, float t, u8 skin, u8 fl, u8 rq, float tx, float ty, u32 nl) {
  if (nv >= MAXV) return;
  Vert *v = &rib[nv++];
  v->x = x; v->y = y; v->t = t; v->skin = skin; v->flags = fl; v->rq = rq; v->spare = 0; v->nlast = (unsigned short)nl;
  v->dx = (signed char)(i32)(tx * 127.f); v->dy = (signed char)(i32)(ty * 127.f); /* tangent, snorm8 */
}

EXPORT("buildRibbons") i32 buildRibbons(float cx, float cy, float hw, float hh) {
  nv = 0;
  for (i32 o = 1; o <= NS; o++) {
    i32 s = o == NS ? 0 : o;
    Snake *k = &S[s];
    if (!k->alive) continue;
    float r = k->r, W = k->boost ? 1.9f : 1.08f, hr = r * W, R = 1.f / 0.42f, m = hr * 2.f + 20.f;
    float x0 = cx - hw - m, x1 = cx + hw + m, y0 = cy - hh - m, y1 = cy + hh + m;
    i32 n = k->n;
    /* integer pre-cull on the raw 16-bit trail: skip snakes wholly off-screen */
    {
      i32 qx0 = (i32)(x0 * 8.f), qx1 = (i32)(x1 * 8.f), qy0 = (i32)(y0 * 8.f), qy1 = (i32)(y1 * 8.f), any = 0;
      const short *X = trx[s], *Y = try_[s];
      for (i32 i = 0; i < n && !any; i++) {
        u32 j = (k->pc - 1u - (u32)i) & RMASK;
        any = X[j] > qx0 && X[j] < qx1 && Y[j] > qy0 && Y[j] < qy1;
      }
      if (!any && !(k->hx > x0 && k->hx < x1 && k->hy > y0 && k->hy < y1)) continue;
    }
    /* sample the path tail -> head, with a cap point beyond each end */
    float dx = k->hx - TX(s, 0), dy = k->hy - TY(s, 0);
    float u = 1.f - minf(sqrtf_(dx * dx + dy * dy) / k->spacing, 1.f);
    i32 q = 1;
    for (i32 i = n - 1; i >= 1; i--) {
      float ax = TX(s, i - 1), ay = TY(s, i - 1);
      qx[q] = ax + (TX(s, i) - ax) * u; qy[q] = ay + (TY(s, i) - ay) * u; qt[q] = (float)i; q++;
    }
    qx[q] = k->hx; qy[q] = k->hy; qt[q] = 0; q++;
    float ca = cosf_(k->ang), sa = sinf_(k->ang);
    qx[q] = k->hx + ca * r; qy[q] = k->hy + sa * r; qt[q] = -R; q++;
    { float ex = qx[1] - qx[2], ey = qy[1] - qy[2], el = sqrtf_(ex * ex + ey * ey);
      if (el < 1e-3f) { ex = -ca; ey = -sa; el = 1; }
      qx[0] = qx[1] + ex / el * r; qy[0] = qy[1] + ey / el * r; qt[0] = (float)(n - 1) + R; }
    u8 fl = (u8)(k->boost | (s == 0 ? 2 : 0)), rq = (u8)(i32)(r * 5.f + 0.5f), sk = (u8)k->skin;
    i32 open = 0;
    for (i32 j = 0; j < q; j++) {
      i32 a = j > 0 ? j - 1 : j, b = j < q - 1 ? j + 1 : j;
      i32 vis = (qx[j] > x0 && qx[j] < x1 && qy[j] > y0 && qy[j] < y1) ||
                (qx[a] > x0 && qx[a] < x1 && qy[a] > y0 && qy[a] < y1) ||
                (qx[b] > x0 && qx[b] < x1 && qy[b] > y0 && qy[b] < y1);
      if (!vis) { open = 0; continue; }
      float tx = qx[b] - qx[a], ty = qy[b] - qy[a], tl = sqrtf_(tx * tx + ty * ty);
      if (tl < 1e-4f) { tx = ca; ty = sa; tl = 1; }
      tx /= tl; ty /= tl;
      float nx = -ty * hr, ny = tx * hr;
      if (!open && nv > 0 && nv + 2 < MAXV) { /* degenerate join */
        rib[nv] = rib[nv - 1]; nv++;
        vput(qx[j] + nx, qy[j] + ny, qt[j], sk, fl | 128, rq, tx, ty, (u32)(n - 1));
      }
      open = 1;
      vput(qx[j] + nx, qy[j] + ny, qt[j], sk, fl | 128, rq, tx, ty, (u32)(n - 1));
      vput(qx[j] - nx, qy[j] - ny, qt[j], sk, fl, rq, tx, ty, (u32)(n - 1));
    }
  }
  return nv;
}
EXPORT("ribPtr") Vert *ribPtr(void) { return rib; }
EXPORT("maxVerts") i32 maxVerts(void) { return MAXV; }

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
