/*
 * Serpent.io simulation core — compiled to WebAssembly (no libc, no malloc).
 *
 * Everything lives in static memory, so the JS side can create typed-array
 * views once and never re-allocate. Per step:
 *   move all snakes -> rebuild spatial hash (counting sort, O(n)) ->
 *   collisions / eating via 3x3 cell queries -> bot AI (staggered) -> respawn.
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
#define MAXSEG 512       /* segments per snake */
#define MAXF 10000       /* food pellets */
#define WR 4000.f        /* world radius */
#define CELL 100.f       /* spatial hash cell size (>= max query radius) */
#define GN 80            /* grid cells per side: 2*WR/CELL */
#define GC (GN * GN)
#define MAXI 65536       /* render instances */

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
  float ang, tang, mass, r, spacing, dropT, dropMass, aiT, tx, ty, respawnT, huntT, aggr;
  i32 n, alive, boost, wantBoost, skin, bot, kills, target;
} Snake;

static Snake S[MAXS];
static float px[MAXS][MAXSEG], py[MAXS][MAXSEG];
static i32 NS = 40;

static float fx[MAXF], fy[MAXF], fr[MAXF], fv[MAXF];
static u8 fs[MAXF], fa[MAXF], fph[MAXF];
static i32 freeList[MAXF], nfree, foodAlive, foodTarget = 3600;

static i32 gStart[GC + 1], gCur[GC], gItems[MAXS * MAXSEG], gTmp[MAXS * MAXSEG];
static i32 fStart[GC + 1], fItems[MAXF], fTmp[MAXF];

typedef struct { float x, y, r; u32 info; } Inst;
static Inst inst[MAXI];

static u32 tick;
static i32 playerKiller = -1;

/* ---------- helpers ---------- */
static i32 cellX(float x) { i32 c = (i32)((x + WR) * (1.f / CELL)); return c < 0 ? 0 : c >= GN ? GN - 1 : c; }
static i32 cellOf(float x, float y) { return cellX(y) * GN + cellX(x); }

static float radiusFor(float m) { return minf(10.f + sqrtf_(m) * 0.9f, 44.f); }
static i32 segsFor(float m) { i32 n = 14 + (i32)(5.5f * sqrtf_(m)); return n > MAXSEG - 1 ? MAXSEG - 1 : n; }

static void killFood(i32 i) { fa[i] = 0; freeList[nfree++] = i; foodAlive--; }
static void spawnFood(float x, float y, float v, i32 skin) {
  if (!nfree) return;
  i32 i = freeList[--nfree];
  fx[i] = x; fy[i] = y; fv[i] = v; fs[i] = (u8)skin; fa[i] = 1; fph[i] = (u8)rnd();
  fr[i] = minf(3.5f + sqrtf_(v) * 2.6f, 15.f);
  foodAlive++;
}
static void randomDisk(float rad, float *x, float *y) {
  float a = frand() * TAU, d = rad * sqrtf_(frand());
  *x = cosf_(a) * d; *y = sinf_(a) * d;
}

/* ---------- spatial hash (counting sort) ---------- */
static void buildGrids(void) {
  for (i32 c = 0; c <= GC; c++) gStart[c] = 0, fStart[c] = 0;
  i32 k = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive) continue;
    for (i32 i = 0; i < S[s].n; i++) { i32 c = cellOf(px[s][i], py[s][i]); gTmp[k++] = c; gStart[c + 1]++; }
  }
  for (i32 c = 0; c < GC; c++) gStart[c + 1] += gStart[c];
  for (i32 c = 0; c < GC; c++) gCur[c] = gStart[c];
  k = 0;
  for (i32 s = 0; s < NS; s++) {
    if (!S[s].alive) continue;
    for (i32 i = 0; i < S[s].n; i++) gItems[gCur[gTmp[k++]]++] = (s << 16) | i;
  }
  for (i32 i = 0; i < MAXF; i++) { i32 c = fa[i] ? cellOf(fx[i], fy[i]) : -1; fTmp[i] = c; if (c >= 0) fStart[c + 1]++; }
  for (i32 c = 0; c < GC; c++) fStart[c + 1] += fStart[c];
  for (i32 c = 0; c < GC; c++) gCur[c] = fStart[c];
  for (i32 i = 0; i < MAXF; i++) if (fTmp[i] >= 0) fItems[gCur[fTmp[i]]++] = i;
}

/* Is a circle at (x,y,rad) touching the border or any other snake? */
static i32 dangerAt(i32 self, float x, float y, float rad) {
  float lim = WR - rad - 30.f;
  if (x * x + y * y > lim * lim) return 1;
  i32 cx = cellX(x), cy = cellX(y);
  for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GN) continue;
    for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GN) continue;
      i32 c = gy * GN + gx;
      for (i32 j = gStart[c]; j < gStart[c + 1]; j++) {
        i32 it = gItems[j], o = it >> 16;
        if (o == self) continue;
        i32 i = it & 0xffff;
        float dx = px[o][i] - x, dy = py[o][i] - y, t = rad + S[o].r;
        if (dx * dx + dy * dy < t * t) return 1;
      }
    }
  }
  return 0;
}

/* ---------- snakes ---------- */
static void layout(i32 s, float x, float y) {
  Snake *k = &S[s];
  float cx = cosf_(k->ang), sy = sinf_(k->ang);
  for (i32 i = 0; i < k->n; i++) { px[s][i] = x - cx * k->spacing * i; py[s][i] = y - sy * k->spacing * i; }
}

static void spawnSnake(i32 s, float mass, i32 bot, i32 skin) {
  Snake *k = &S[s];
  float x = 0, y = 0;
  for (i32 t = 0; t < 30; t++) { randomDisk(WR * 0.75f, &x, &y); if (!dangerAt(s, x, y, 260.f)) break; }
  k->ang = k->tang = frand() * TAU - PI;
  k->mass = mass; k->r = radiusFor(mass); k->spacing = k->r * 0.42f; k->n = segsFor(mass);
  k->alive = 1; k->bot = bot; k->skin = skin; k->kills = 0; k->boost = k->wantBoost = 0;
  k->dropT = k->dropMass = 0; k->aiT = 0; k->huntT = 0; k->target = -1; k->aggr = frand();
  k->tx = x; k->ty = y;
  layout(s, x, y);
}

static void killSnake(i32 s, i32 killer) {
  Snake *k = &S[s];
  if (!k->alive) return;
  k->alive = 0;
  float per = k->mass * 0.85f / (float)(k->n / 2 + 1);
  for (i32 i = 0; i < k->n; i += 2) {
    float j = k->r * 0.6f;
    spawnFood(px[s][i] + (frand() - 0.5f) * j, py[s][i] + (frand() - 0.5f) * j, per * (0.6f + frand() * 0.8f), k->skin);
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
  k->ang = wrapa(k->ang + da);

  k->boost = k->wantBoost && k->mass > 14.f;
  float speed = k->boost ? 430.f : 195.f;
  px[s][0] += cosf_(k->ang) * speed * dt;
  py[s][0] += sinf_(k->ang) * speed * dt;

  if (k->boost) {
    float lose = (6.f + k->mass * 0.006f) * dt;
    k->mass -= lose; k->dropMass += lose; k->dropT += dt;
    if (k->dropT > 0.1f) {
      i32 t = k->n - 1;
      spawnFood(px[s][t], py[s][t], k->dropMass * 0.8f, k->skin);
      k->dropT = 0; k->dropMass = 0;
    }
  }

  k->r = radiusFor(k->mass);
  k->spacing = k->r * 0.42f;
  i32 want = segsFor(k->mass);
  while (k->n < want) { px[s][k->n] = px[s][k->n - 1]; py[s][k->n] = py[s][k->n - 1]; k->n++; }
  if (k->n > want) k->n = want;

  /* follow-the-leader chain constraint */
  float sp = k->spacing, sp2 = sp * sp;
  float *X = px[s], *Y = py[s];
  for (i32 i = 1; i < k->n; i++) {
    float dx = X[i] - X[i - 1], dy = Y[i] - Y[i - 1], d2 = dx * dx + dy * dy;
    if (d2 > sp2) { float f = sp / sqrtf_(d2); X[i] = X[i - 1] + dx * f; Y[i] = Y[i - 1] + dy * f; }
  }
}

static i32 hitTest(i32 s) {
  Snake *k = &S[s];
  float hx = px[s][0], hy = py[s][0];
  float lim = WR - k->r * 0.5f;
  if (hx * hx + hy * hy > lim * lim) return -2;
  i32 cx = cellX(hx), cy = cellX(hy);
  for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GN) continue;
    for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GN) continue;
      i32 c = gy * GN + gx;
      for (i32 j = gStart[c]; j < gStart[c + 1]; j++) {
        i32 it = gItems[j], o = it >> 16;
        if (o == s || !S[o].alive) continue;
        i32 i = it & 0xffff;
        float dx = px[o][i] - hx, dy = py[o][i] - hy, t = (k->r + S[o].r) * 0.66f;
        if (dx * dx + dy * dy < t * t) return o;
      }
    }
  }
  return -1;
}

static void eat(i32 s, float dt) {
  Snake *k = &S[s];
  float hx = px[s][0], hy = py[s][0];
  float att = k->r * 1.5f + 34.f, att2 = att * att, pull = minf(1.f, dt * 10.f);
  i32 cx = cellX(hx), cy = cellX(hy);
  for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= GN) continue;
    for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= GN) continue;
      i32 c = gy * GN + gx;
      for (i32 j = fStart[c]; j < fStart[c + 1]; j++) {
        i32 i = fItems[j];
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
  float hx = px[s][0], hy = py[s][0];
  k->aiT -= dt;

  if (k->huntT > 0) {
    k->huntT -= dt;
    Snake *o = &S[k->target];
    if (k->target < 0 || !o->alive) k->huntT = 0;
    else {
      float lead = o->r * 4.f + 70.f;
      k->tx = px[k->target][0] + cosf_(o->ang) * lead;
      k->ty = py[k->target][0] + sinf_(o->ang) * lead;
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
        float dx = px[o][0] - hx, dy = py[o][0] - hy, d2 = dx * dx + dy * dy;
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
          i32 c = gy * GN + gx;
          for (i32 j = fStart[c]; j < fStart[c + 1]; j++) {
            i32 i = fItems[j];
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
  for (i32 s = 0; s < NS; s++) if (S[s].alive) moveSnake(s, dt);
  buildGrids();

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
  nfree = 0; foodAlive = 0; tick = 0; playerKiller = -1;
  for (i32 i = MAXF - 1; i >= 0; i--) { fa[i] = 0; freeList[nfree++] = i; }
  for (i32 s = 0; s < MAXS; s++) S[s].alive = 0;
  buildGrids();
  for (i32 s = 1; s < NS; s++) { float t = frand(); spawnSnake(s, 10.f + t * t * t * 520.f, 1, (i32)(rnd() % 12)); }
  while (foodAlive < foodTarget) {
    float x, y; randomDisk(WR * 0.98f, &x, &y);
    float v = frand(); spawnFood(x, y, 0.6f + v * v * 2.4f, (i32)(rnd() % 12));
  }
  buildGrids();
}

EXPORT("spawnPlayer") void spawnPlayer(i32 skin) { buildGrids(); spawnSnake(0, 10.f, 0, skin); playerKiller = -1; }
EXPORT("killPlayer") void killPlayer(void) { S[0].alive = 0; }

EXPORT("setInput") void setInput(float ang, i32 boost) { S[0].tang = ang; S[0].wantBoost = boost; }

EXPORT("update") void update(float dt) {
  if (dt > 0.1f) dt = 0.1f;
  i32 steps = (i32)(dt * 60.f) + 1;
  float h = dt / (float)steps;
  for (i32 i = 0; i < steps; i++) step(h);
}

static void push(float x, float y, float r, u32 kind, u32 skin, u32 extra, u32 flags, i32 *n) {
  if (*n >= MAXI) return;
  Inst *p = &inst[(*n)++];
  p->x = x; p->y = y; p->r = r;
  p->info = kind | (skin << 8) | ((extra & 255u) << 16) | (flags << 24);
}

/* Writes view-culled instances (food, then snakes tail->head, player on top). */
EXPORT("build") i32 build(float cx, float cy, float hw, float hh) {
  i32 n = 0;
  float x0 = cx - hw - 60.f, x1 = cx + hw + 60.f, y0 = cy - hh - 60.f, y1 = cy + hh + 60.f;
  i32 gx0 = cellX(x0), gx1 = cellX(x1), gy0 = cellX(y0), gy1 = cellX(y1);
  for (i32 gy = gy0; gy <= gy1; gy++)
    for (i32 gx = gx0; gx <= gx1; gx++) {
      i32 c = gy * GN + gx;
      for (i32 j = fStart[c]; j < fStart[c + 1]; j++) {
        i32 i = fItems[j];
        if (fa[i]) push(fx[i], fy[i], fr[i], 0, fs[i], fph[i], 0, &n);
      }
    }
  for (i32 t = 1; t <= NS; t++) {
    i32 s = t == NS ? 0 : t;
    Snake *k = &S[s];
    if (!k->alive) continue;
    float m = k->r * 2.f;
    for (i32 i = k->n - 1; i >= 0; i--) {
      float x = px[s][i], y = py[s][i];
      if (x < x0 - m || x > x1 + m || y < y0 - m || y > y1 + m) continue;
      u32 extra = i == 0 ? (u32)((k->ang + PI) * (256.f / TAU)) : (u32)i;
      push(x, y, k->r, i == 0 ? 2u : 1u, (u32)k->skin, extra, (u32)k->boost | (s == 0 ? 2u : 0u), &n);
    }
  }
  return n;
}

EXPORT("instPtr") Inst *instPtr(void) { return inst; }
EXPORT("maxInst") i32 maxInst(void) { return MAXI; }
EXPORT("worldRadius") float worldRadius(void) { return WR; }
EXPORT("snakeCount") i32 snakeCount(void) { return NS; }
EXPORT("alive") i32 alive(i32 s) { return S[s].alive; }
EXPORT("mass") float mass(i32 s) { return S[s].mass; }
EXPORT("radius") float radius(i32 s) { return S[s].r; }
EXPORT("headX") float headX(i32 s) { return px[s][0]; }
EXPORT("headY") float headY(i32 s) { return py[s][0]; }
EXPORT("kills") i32 kills(i32 s) { return S[s].kills; }
EXPORT("skin") i32 skin(i32 s) { return S[s].skin; }
EXPORT("segments") i32 segments(i32 s) { return S[s].n; }
EXPORT("foodCount") i32 foodCount(void) { return foodAlive; }
EXPORT("killer") i32 killer(void) { return playerKiller; }
