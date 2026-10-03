// ASHEN OATH — Сияющий лес (зона большой карты, [FOREST], V6).
//
// Яркий эльфийский лес к северу от арены (ориентир — Камасильва из Black Desert): гигантские древние
// деревья с корнями-арками, золотой свет сквозь кроны, бирюзовое озеро под скальной грядой с
// водопадом, ручей до заводи, светящиеся цветы и грибы, пыльца, светлячки, бабочки, падающие листья,
// эльфийское святилище-руина, рунные менгиры, мостики. В центре — «Поляна дуэлей» для PvP (№3):
// ровный круг r = 20 м без препятствий, кольцо рунных камней, укрытия, две точки появления.
// Пока герой в лесу (weight 0..1), небо светлое и тёплое (свой купол поверх затмения), туман
// бирюзово-золотой (atmosphere.setZoneMood, если есть), пепел не падает (world.js по weight).
//
// Рельеф зоны задаёт чистая функция brightForestHeight(x, z, y0) — её вызывает world.terrainH,
// поэтому видимая земля, раскладка боя и эта зона видят одну и ту же землю.
// Всё мелкое — InstancedMesh / Points / слитые меши; уровни качества QF (low/medium/high).
// Вне зоны (камера дальше ~120 м от центра; арена — 169 м) root скрыт; дальнее сияние над кронами видно с дороги.
//
// export: BRIGHT_FOREST (C7), brightForestHeight(x, z, y0), brightForestTint(x, z), FOREST_PLAN,
//   createBrightForest({ THREE, parent|scene, groundY, quality, reducedMotion, camera, atmosphere, lightUnit, seed })
//     → { root, colliders, groundAt(x, z), get weight, update(dt, heroPos), setQuality(q), configure(patch),
//         dispose(), mood, center, radius, stats() }

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, v) => smooth01(clamp((v - a) / (b - a), 0, 1));
const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Сглаженная ломаная Катмулла–Рома без THREE: [{x,z}] → плотные точки с шагом ~step м.
function catmull(pts, step = 1) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  let L = 0;
  out.forEach((p, i) => { if (i) L += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z); p.s = L; });
  for (const p of out) p.t = L > 0 ? p.s / L : 0;
  return out;
}
// Расстояние до ломаной: { d, t (0..1 вдоль), i }; bb — грубый бокс для раннего выхода.
function polyDist(x, z, pts, bb) {
  if (bb && (x < bb.x0 || x > bb.x1 || z < bb.z0 || z > bb.z1)) return { d: 1e9, t: 0, i: 0 };
  let best = 1e9, bt = 0, bi = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
    const u = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
    const dd = (x - a.x - ex * u) ** 2 + (z - a.z - ez * u) ** 2;
    if (dd < best) { best = dd; bt = lerp(a.t, b.t, u); bi = i; }
  }
  return { d: Math.sqrt(best), t: bt, i: bi };
}
const bbox = (pts, m) => {
  const b = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
  for (const p of pts) { b.x0 = Math.min(b.x0, p.x - m); b.x1 = Math.max(b.x1, p.x + m); b.z0 = Math.min(b.z0, p.z - m); b.z1 = Math.max(b.z1, p.z + m); }
  return b;
};

/* =============================== ЗОНА (C7) =============================== */
// Центр — к северу от арены (−Z). Край мира на этом азимуте world.js отодвигает (edgeBulge).
const CX = 18, CZ = -168, LEVEL = -2.2;
const W = (dx, dz) => ({ x: CX + dx, z: CZ + dz });
export const BRIGHT_FOREST = Object.freeze({
  id: 'bright-forest', name: 'Сияющий лес', subtitle: 'Земли Древа',
  x: CX, z: CZ, r: 62, level: LEVEL,
  // Поляна дуэлей (PvP №3): ровный круг без препятствий; игроки появляются друг напротив друга
  // по оси запад–восток (солнце на севере — свет одинаково сбоку у обоих), лицом к центру.
  duel: Object.freeze({
    x: CX, z: CZ, r: 20,
    spawns: Object.freeze([
      Object.freeze({ x: CX - 12, z: CZ, yaw: Math.PI / 2 }),
      Object.freeze({ x: CX + 12, z: CZ, yaw: -Math.PI / 2 }),
    ]),
  }),
  // старт «Сияющий лес» (settings.startZone = 'forest'): у эльфийских врат, лицом в лес (на север)
  start: Object.freeze({ x: CX - 4, z: CZ + 71, yaw: Math.PI }),
  gate: Object.freeze({ x: CX - 4, z: CZ + 62 }),
  // места под угли клятвы (world.js ставит алтари, как в других зонах)
  embers: Object.freeze([Object.freeze({ x: CX - 55, z: CZ + 10 }), Object.freeze({ x: CX + 26, z: CZ - 13 })]),
  // край мира на этом азимуте отодвинут на столько метров (world.js, edgeDist)
  edgeBulge: Object.freeze({ az: Math.atan2(CX, CZ), m: 34, w: 0.42 }),
  // дорога от арены (world.js ROADS): последние точки — к вратам
  road: Object.freeze([[-2, -38], [2, -62], [9, -84], [CX - 4, CZ + 72]]),
});

/* =============================== ПЛАН ЗОНЫ =============================== */
// Локальные координаты (dx, dz) от центра поляны; дальше — в мировых (W).
const GLADE_R = BRIGHT_FOREST.duel.r;
const WATER_Y = LEVEL - 0.62;                          // уровень озера
const LAKE = { ...W(-28, -28), r: 11.5 };
const lakeR = (a) => LAKE.r + 1.3 * Math.sin(3 * a + 1.1) + 0.7 * Math.sin(5 * a + 2.3);   // волнистый берег
const RIDGE_H = 11.5;
const cliffZ = (dx) => -42 + 3 * Math.sin(dx * 0.09 + 0.5);   // линия подножия гряды (локальная dz)
const RIDGE_X1 = 34;                                            // восточнее гряда сходит на нет
// Ручей: из озера на юго-запад, вдоль западной стороны до заводи.
const STREAM = catmull([W(-36, -22), W(-41, -10), W(-42, 3), W(-38, 16), W(-33, 29), W(-29, 42), W(-27, 52)], 0.8);
const STREAM_BB = bbox(STREAM, 8);
const POOL = { ...W(-26, 57), r: 5.4 };                // заводь в конце ручья
const streamHalfW = (t) => lerp(1.5, 1.9, t);
const streamY = (t) => lerp(WATER_Y - 0.02, WATER_Y - 0.55, t);
// Верхний ручеёк на гряде к водопаду.
const TOP_STREAM = catmull([W(-24, -66), W(-26, -58), W(-28, -50.6)], 0.8);
const TOP_BB = bbox(TOP_STREAM, 6);
const FALL = { lip: { ...W(-28, cliffZ(-28) - 4.4) }, foot: { ...W(-28, -38.8) }, width: 3.4 };
// Тропы (ширина ~1.7 м): от врат на поляну, к святилищу, к озеру, на запад через мост к роще.
const PATHS = [
  catmull([W(-4, 76), W(-4, 62), W(-3, 47), W(-1, 33), W(0, 21)], 0.9),       // врата → поляна (под корнем-аркой)
  catmull([W(20, 0), W(30, -3), W(38, -6)], 0.9),                             // → святилище
  catmull([W(-14, -14), W(-18, -18.5)], 0.9),                                 // → озеро (смотровая)
  catmull([W(-20, 1), W(-30, 2), W(-42, 3.2), W(-53, 6)], 0.9),               // → мост → западная роща
  catmull([W(-3, 47), W(-14, 50), W(-26, 50), W(-38, 47)], 0.9),              // петля к заводи и мостику
];
const PATH_BB = PATHS.map((p) => bbox(p, 4));
const PATH_HW = 0.95;
// Мостики: поперёк ручья там, где его пересекают тропы.
const BRIDGES = [];
// Святилище-руина (восток, смотрит на поляну) и великие деревья.
const SHRINE = { ...W(44, -8), yaw: -Math.PI / 2 - 0.12 };
const GIANTS = [
  { ...W(9, 42), r: 3.0, h: 34, crown: 17, arch: { to: W(-11, 39), h: 3.6 } },   // Древо у входа: корень-арка над тропой
  { ...W(31, -27), r: 2.2, h: 27, crown: 13 },
  { ...W(-9, -40), r: 2.3, h: 29, crown: 14 },
  { ...W(35, 25), r: 2.5, h: 30, crown: 15 },
  { ...W(-25, 25), r: 2.0, h: 25, crown: 12 },
  { ...W(-54, -13), r: 2.4, h: 28, crown: 14 },
  { ...W(52, 17), r: 2.1, h: 26, crown: 12 },
  { ...W(20, 57), r: 1.8, h: 24, crown: 11 },
  { ...W(-47, 38), r: 2.2, h: 27, crown: 13 },
];
// Укрытия на краю поляны: 4 по диагоналям (корень, валуны) + 2 низких камня севернее/южнее центра.
const COVERS = [
  { ...W(12.5, 12.5), kind: 'root', yaw: Math.PI * 0.25 },
  { ...W(-12.5, 12.5), kind: 'rock', yaw: -Math.PI * 0.25 },
  { ...W(-12.5, -12.5), kind: 'root', yaw: Math.PI * 1.25 },
  { ...W(12.5, -12.5), kind: 'rock', yaw: Math.PI * 0.75 },
  { ...W(0, 8.5), kind: 'low', yaw: 0 },
  { ...W(0, -8.5), kind: 'low', yaw: Math.PI },
];
const RUNE_RING_R = 23.5;

// Мостики: где тропа пересекает ручей — пролёт вдоль тропы (опоры на берегах).
(function findBridges() {
  PATHS.forEach((path) => {
    let best = null;
    for (let i = 0; i < path.length; i++) {
      const si = polyDist(path[i].x, path[i].z, STREAM, STREAM_BB);
      if (si.d < 0.6 && (!best || si.d < best.d)) best = { i, d: si.d, t: si.t };
    }
    if (!best) return;
    const a = path[Math.max(0, best.i - 2)], b = path[Math.min(path.length - 1, best.i + 2)];
    const L0 = Math.hypot(b.x - a.x, b.z - a.z) || 1, ux = (b.x - a.x) / L0, uz = (b.z - a.z) / L0;
    const c = path[best.i], half = streamHalfW(best.t) + 1.7;
    BRIDGES.push({ cx: c.x, cz: c.z, ax: c.x - ux * half, az: c.z - uz * half, bx: c.x + ux * half, bz: c.z + uz * half, ux, uz, len: half * 2, w: 0.95, rise: 0.55, t: best.t });
  });
})();
function distPaths(x, z) {
  let d = 1e9;
  for (let i = 0; i < PATHS.length; i++) { const r = polyDist(x, z, PATHS[i], PATH_BB[i]); if (r.d < d) d = r.d; }
  return d;
}
function streamInfo(x, z) { return polyDist(x, z, STREAM, STREAM_BB); }

/* =============================== РЕЛЬЕФ =============================== */
// Локальная высота без учёта мира; вес зоны смешивает её с общим рельефом (y0).
function localHeight(x, z) {
  const dx = x - CX, dz = z - CZ;
  let h = LEVEL + 0.9 * Math.sin(dx * 0.061 + 0.7) * Math.cos(dz * 0.053 - 0.4) + 0.45 * Math.sin(dx * 0.13 - dz * 0.09 + 2.1);
  // поляна дуэлей: идеально ровно
  const dg = Math.hypot(dx, dz);
  h = lerp(h, LEVEL, smoothstep(GLADE_R + 11, GLADE_R + 2, dg));
  // тропы: складки мягче
  const dp = distPaths(x, z);
  if (dp < 5) h = lerp(h, LEVEL + (h - LEVEL) * 0.45, smoothstep(5, 1, dp));
  // скальная гряда на севере (водопад падает с неё в озеро)
  const cz = cliffZ(dx), rx = smoothstep(RIDGE_X1 + 14, RIDGE_X1, dx);
  if (rx > 0 && dz < cz + 2) {
    const rise = RIDGE_H * smoothstep(cz + 1, cz - 4.5, dz) + Math.max(0, cz - 4.5 - dz) * 0.16;
    const jag = 0.7 * Math.sin(dx * 0.7 + dz * 0.3) * smoothstep(cz + 1, cz - 2, dz) * (1 - smoothstep(cz - 4, cz - 6, dz));
    h += (rise + jag) * rx;
  }
  // верхний ручеёк — ложбина на гряде
  const dt = polyDist(x, z, TOP_STREAM, TOP_BB);
  if (dt.d < 4) h -= 0.55 * smoothstep(4, 0.8, dt.d);
  // озеро: чаша с волнистым берегом
  const lx = x - LAKE.x, lz = z - LAKE.z, dl = Math.hypot(lx, lz);
  if (dl < LAKE.r + 9) {
    const R = lakeR(Math.atan2(lx, lz)), q = dl / R;
    const bowl = dl < R ? WATER_Y - 2.2 + 2.0 * q * q : WATER_Y - 0.2 + (dl - R) * 0.35;
    h = lerp(h, Math.min(h, bowl), smoothstep(R + 7, R - 0.5, dl));
  }
  // ручей: русло ниже воды, берега плавно
  const si = streamInfo(x, z);
  if (si.d < 5) {
    const hw = streamHalfW(si.t), bed = streamY(si.t) - 0.45;
    const bank = Math.max(bed, streamY(si.t) + 0.12 + (si.d - hw) * 0.4);
    const target = si.d < hw ? bed + (si.d / hw) * (si.d / hw) * 0.35 : bank;
    h = lerp(h, Math.min(h, target), smoothstep(5, hw * 0.6, si.d));
  }
  // заводь
  const dq = Math.hypot(x - POOL.x, z - POOL.z);
  if (dq < POOL.r + 5) {
    const q = dq / POOL.r;
    const bowl = dq < POOL.r ? streamY(1) - 1.2 + 1.1 * q * q : streamY(1) - 0.1 + (dq - POOL.r) * 0.3;
    h = lerp(h, Math.min(h, bowl), smoothstep(POOL.r + 4, POOL.r - 0.4, dq));
  }
  return h;
}
// Вес зоны для рельефа: внутри r+4 — только лес, до r+30 — плавно к общему рельефу.
for (const b of BRIDGES) {
  b.yA = localHeight(b.ax, b.az); b.yB = localHeight(b.bx, b.bz);
  b.deckY = (u) => lerp(b.yA, b.yB, u) + 0.07 + b.rise * Math.sin(Math.PI * clamp(u, 0, 1));
}
export function brightForestHeight(x, z, y0) {
  const d = Math.hypot(x - CX, z - CZ);
  if (d > BRIGHT_FOREST.r + 30) return y0;
  const w = smoothstep(BRIGHT_FOREST.r + 30, BRIGHT_FOREST.r + 4, d);
  return lerp(y0, localHeight(x, z), w);
}
// Тон земли под травой (world.js — цвет вершин рельефа): мох, золото; 0 — вне зоны.
export function brightForestTint(x, z) {
  const d = Math.hypot(x - CX, z - CZ);
  return smoothstep(BRIGHT_FOREST.r + 22, BRIGHT_FOREST.r - 2, d);
}
// План для QA, стендов и PvP (только чтение).
export const FOREST_PLAN = Object.freeze({
  waterY: WATER_Y, lake: LAKE, pool: POOL, fall: FALL, shrine: SHRINE, glade: { x: CX, z: CZ, r: GLADE_R },
  giants: GIANTS.map((g) => ({ x: g.x, z: g.z, r: g.r, h: g.h })), covers: COVERS.map((c) => ({ x: c.x, z: c.z, kind: c.kind })),
  paths: PATHS.map((p) => p.filter((_, i) => i % 4 === 0).map((q) => ({ x: q.x, z: q.z }))),
});

/* =============================== КАЧЕСТВО =============================== */
const QF = {
  low:    { grass: 0.35, flowers: 0.45, leaves: 0.5, trees: 0.55, flies: 120, pollen: 200, butterflies: 10, falling: 60, shafts: 5, shadow: false, visR: 100 },
  medium: { grass: 0.7,  flowers: 0.75, leaves: 0.78, trees: 0.8, flies: 260, pollen: 480, butterflies: 22, falling: 140, shafts: 9, shadow: true, visR: 118 },
  high:   { grass: 1.0,  flowers: 1.0,  leaves: 1.0, trees: 1.0,  flies: 420, pollen: 900, butterflies: 36, falling: 260, shafts: 12, shadow: true, visR: 135 },
};
const normQ = (q) => (q === 'low' || q === 'high' ? q : 'medium');

/* =============================== ЛЕС =============================== */
export function createBrightForest({
  THREE, parent = null, scene = null, groundY, quality = 'medium', reducedMotion = false, camera = null,
  atmosphere = null, lightUnit = 1, seed = 5151, builders = [],
} = {}) {
  const host = parent || scene;
  if (!THREE || !host || typeof groundY !== 'function') throw new Error('[brightForest] нужны THREE, parent и groundY');
  const BF = BRIGHT_FOREST;
  const rnd = mulberry32(seed);
  const gy = (x, z) => { const y = groundY(x, z); return Number.isFinite(y) ? y : LEVEL; };
  const state = { disposed: false, quality: normQ(quality), reduced: !!reducedMotion, time: 0, frame: 0, weight: 0, inside: false, visible: true };

  const owned = { geo: new Set(), mat: new Set(), tex: new Set() };
  const G = (g) => { owned.geo.add(g); return g; };
  const M = (m) => { owned.mat.add(m); return m; };
  const T = (t) => { owned.tex.add(t); return t; };
  function tex(c, { repeat = true, srgb = true } = {}) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return T(t);
  }

  const root = new THREE.Group();
  root.name = 'bright-forest';
  host.add(root);
  const colliders = [];
  const circle = (x, z, r) => colliders.push({ type: 'circle', x, z, r });
  const segment = (ax, az, bx, bz, r) => colliders.push({ type: 'segment', ax, az, bx, bz, r });

  /* ------------------------------ Общие uniform-ы ------------------------------ */
  const shared = {
    uTime: { value: 0 }, uMotion: { value: state.reduced ? 0.3 : 1 },
    uWind: { value: new THREE.Vector4(0.8, 0.6, 1, 0) },
    uHero: { value: new THREE.Vector3(CX + 999, 0, CZ + 999) },
    uHero2: { value: new THREE.Vector3(CX + 999, 0, CZ + 999) },
    uWeight: { value: 0 },
    uSunDir: { value: new THREE.Vector3(-0.1, 0.32, -0.94).normalize() },
  };

  /* ------------------------------ План в мировых координатах ------------------------------ */
  const waterDist = (x, z) => {
    const lx = x - LAKE.x, lz = z - LAKE.z, dl = Math.hypot(lx, lz);
    let d = dl - lakeR(Math.atan2(lx, lz));
    d = Math.min(d, Math.hypot(x - POOL.x, z - POOL.z) - POOL.r);
    const si = streamInfo(x, z);
    d = Math.min(d, si.d - streamHalfW(si.t));
    return d;
  };
  const trunkDist = (x, z) => { let d = 1e9; for (const g of GIANTS) d = Math.min(d, Math.hypot(x - g.x, z - g.z) - g.r); return d; };
  const structures = [];   // {x,z,r} — святилище, менгиры, укрытия, врата: трава и деревья обходят
  function blocked(x, z, m = 0, { paths = true, glade = true, water = true } = {}) {
    if (glade && Math.hypot(x - CX, z - CZ) < GLADE_R + m) return true;
    if (water && waterDist(x, z) < 0.4 + m) return true;
    if (paths && distPaths(x, z) < PATH_HW + 0.3 + m) return true;
    if (trunkDist(x, z) < 1.2 + m) return true;
    for (const s of structures) if (Math.hypot(x - s.x, z - s.z) < s.r + m) return true;
    return false;
  }
  const plan = {
    center: { x: CX, y: LEVEL, z: CZ }, level: LEVEL, radius: BF.r,
    glade: { x: CX, z: CZ, r: GLADE_R },
    lake: { x: LAKE.x, z: LAKE.z, r: LAKE.r, waterY: WATER_Y, shoreR: (a) => lakeR(a) },
    pool: { x: POOL.x, z: POOL.z, r: POOL.r, waterY: streamY(1) },
    stream: STREAM.map((p) => ({ x: p.x, z: p.z, t: p.t, w: streamHalfW(p.t) * 2, y: streamY(p.t) })),
    topStream: TOP_STREAM.map((p) => ({ x: p.x, z: p.z, t: p.t })),
    waterfall: { top: { x: FALL.lip.x, y: gy(FALL.lip.x, FALL.lip.z), z: FALL.lip.z }, bottom: { x: FALL.foot.x, y: WATER_Y, z: FALL.foot.z }, width: FALL.width },
    paths: PATHS.map((p) => p.map((q) => ({ x: q.x, z: q.z }))),
    pathHalfW: PATH_HW,
    bridges: BRIDGES,
    giants: GIANTS,
    covers: COVERS,
    shrine: SHRINE,
    runeRingR: RUNE_RING_R,
    structures,
    blocked, waterDist, pathDist: distPaths, trunkDist,
    cliffZ: (x) => CZ + cliffZ(x - CX), ridgeX1: CX + RIDGE_X1,
  };

  /* ------------------------------ Карта зоны (для шейдеров травы) ------------------------------ */
  // RGBA half-float: R — высота земли, G — плотность травы, B — пятна цветов (0..1), A — тропа.
  const MAP_N = 256, MAP_SPAN = 2 * (BF.r + 22), MAP_X0 = CX - MAP_SPAN / 2, MAP_Z0 = CZ - MAP_SPAN / 2;
  const mapData = new Uint16Array(MAP_N * MAP_N * 4);
  const mapF = new Float32Array(MAP_N * MAP_N * 4);
  {
    const toHalf = THREE.DataUtils.toHalfFloat;
    const flowerNoise = (x, z) => 0.5 + 0.5 * Math.sin(x * 0.23 + Math.sin(z * 0.17) * 2.1) * Math.cos(z * 0.21 - Math.sin(x * 0.13) * 1.7);
    for (let j = 0; j < MAP_N; j++) for (let i = 0; i < MAP_N; i++) {
      const x = MAP_X0 + (i + 0.5) * (MAP_SPAN / MAP_N), z = MAP_Z0 + (j + 0.5) * (MAP_SPAN / MAP_N);
      const h = gy(x, z);
      const dc = Math.hypot(x - CX, z - CZ);
      const edge = smoothstep(BF.r + 20, BF.r + 4, dc);
      const wd = waterDist(x, z), pd = distPaths(x, z), td = trunkDist(x, z);
      const slope = Math.abs(gy(x + 0.7, z) - gy(x - 0.7, z)) + Math.abs(gy(x, z + 0.7) - gy(x, z - 0.7));
      let grass = edge * smoothstep(0.1, 1.2, wd) * smoothstep(PATH_HW * 0.7, PATH_HW + 0.9, pd) * smoothstep(0.4, 1.6, td) * (1 - smoothstep(0.9, 1.8, slope));
      const flowers = grass * smoothstep(0.55, 0.85, flowerNoise(x, z)) * (Math.hypot(x - CX, z - CZ) < GLADE_R - 1 ? 0.25 : 1);
      const path = 1 - smoothstep(PATH_HW - 0.2, PATH_HW + 0.6, pd);
      const k = (j * MAP_N + i) * 4;
      mapF[k] = h; mapF[k + 1] = grass; mapF[k + 2] = flowers; mapF[k + 3] = path;
      mapData[k] = toHalf(h); mapData[k + 1] = toHalf(grass); mapData[k + 2] = toHalf(flowers); mapData[k + 3] = toHalf(path);
    }
  }
  const mapTex = T(new THREE.DataTexture(mapData, MAP_N, MAP_N, THREE.RGBAFormat, THREE.HalfFloatType));
  mapTex.magFilter = THREE.LinearFilter; mapTex.minFilter = THREE.LinearFilter;
  mapTex.wrapS = mapTex.wrapT = THREE.ClampToEdgeWrapping;
  mapTex.needsUpdate = true;
  const map = {
    texture: mapTex, size: MAP_N, x0: MAP_X0, z0: MAP_Z0, span: MAP_SPAN,
    uniform: { value: new THREE.Vector4(MAP_X0, MAP_Z0, 1 / MAP_SPAN, MAP_N) },
    sample(x, z) {   // билинейно: { h, grass, flowers, path }
      const fx = clamp((x - MAP_X0) / MAP_SPAN * MAP_N - 0.5, 0, MAP_N - 1.001), fz = clamp((z - MAP_Z0) / MAP_SPAN * MAP_N - 0.5, 0, MAP_N - 1.001);
      const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
      const at = (c) => {
        const a = mapF[((j * MAP_N + i) * 4) + c], b = mapF[((j * MAP_N + i + 1) * 4) + c];
        const d = mapF[(((j + 1) * MAP_N + i) * 4) + c], e = mapF[(((j + 1) * MAP_N + i + 1) * 4) + c];
        return lerp(lerp(a, b, u), lerp(d, e, u), v);
      };
      return { h: at(0), grass: at(1), flowers: at(2), path: at(3) };
    },
  };

  const ctx = { THREE, root, parent: host, camera, BF, rnd, gy, G, M, T, tex, quality: state.quality, QF, reducedMotion: state.reduced,
    shared, plan, map, colliders, circle, segment, atmosphere, lightUnit, smoothstep, lerp, clamp, mulberry32 };

  /* ------------------------------ Строители содержимого ------------------------------ */
  const parts = [];
  function run(name, fn) {
    try {
      const p = fn(ctx);
      if (p) { p.name = p.name || name; parts.push(p); }
    } catch (e) { console.error(`[brightForest] ${name} не построен:`, e); }
  }
  for (const [name, fn] of BUILDERS) run(name, fn);
  for (const b of builders || []) if (typeof b === 'function') run(b.name || 'extra', b);

  /* ------------------------------ Настроение зоны ------------------------------ */
  // Отдаётся наружу: world.js передаёт в atmosphere.setZoneMood (если есть) и прореживает пепел.
  // Формат — контракт №8 (atmosphere.setZoneMood, ZONE_MOODS): sky/fog/sun/exposure/grade; weight — каждый кадр.
  const mood = {
    weight: 0,
    sky: { top: new THREE.Color(0x2f7fd0), horizon: new THREE.Color(0xffe3b0), corona: new THREE.Color(0xfff1cf), coronaIntensity: 0.5, sunDisc: 1 },
    fog: { color: new THREE.Color(0x86c9b4), glow: new THREE.Color(0xffd88a), density: 0.0055 },   // бирюза с золотом; плотность абсолютная
    sun: { color: new THREE.Color(0xffe6b0), intensity: 1.5, env: 3.0 },                         // intensity — множитель ключа
    exposure: 1.18,
    grade: { shadow: [-0.012, 0.018, 0.024], high: [0.032, 0.018, -0.014], sat: 1.12, contrast: 0.2 },
  };
  for (const p of parts) if (p.setMood) { try { p.setMood(mood); } catch (e) { /* ignore */ } }

  /* ------------------------------ Качество ------------------------------ */
  function setQuality(q) {
    if (state.disposed) return;
    state.quality = normQ(q);
    ctx.quality = state.quality;
    for (const p of parts) if (p.setQuality) { try { p.setQuality(state.quality); } catch (e) { console.warn('[brightForest] setQuality', p.name, e); } }
  }
  function configure(patch = {}) {
    if (patch && 'reducedMotion' in patch) { state.reduced = !!patch.reducedMotion; shared.uMotion.value = state.reduced ? 0.3 : 1; ctx.reducedMotion = state.reduced; }
    if (patch && 'quality' in patch) setQuality(patch.quality);
  }

  /* ------------------------------ Кадр ------------------------------ */
  const _cam = { x: 0, y: 0, z: 0 };
  function update(dt, heroPos, hero2Pos = null) {
    if (state.disposed) return;
    dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
    state.time += dt; state.frame++;
    const t = state.time;
    const cam = camera ? camera.position : null;
    const px = heroPos && Number.isFinite(heroPos.x) ? heroPos.x : cam ? cam.x : CX + 999;
    const pz = heroPos && Number.isFinite(heroPos.z) ? heroPos.z : cam ? cam.z : CZ + 999;
    const py = heroPos && Number.isFinite(heroPos.y) ? heroPos.y : gy(px, pz);
    _cam.x = cam ? cam.x : px; _cam.y = cam ? cam.y : py + 3; _cam.z = cam ? cam.z : pz;
    const dP = Math.hypot(px - CX, pz - CZ), dC = Math.hypot(_cam.x - CX, _cam.z - CZ);
    // вес: 0 за r+25, 1 внутри r−5 (переход 30 м)
    const w = smoothstep(BF.r + 25, BF.r - 5, dP);
    state.weight = w;
    mood.weight = w;
    shared.uWeight.value = w;
    shared.uTime.value = t;
    shared.uHero.value.set(px, py, pz);
    if (hero2Pos && Number.isFinite(hero2Pos.x)) shared.uHero2.value.set(hero2Pos.x, hero2Pos.y || 0, hero2Pos.z); else shared.uHero2.value.set(CX + 999, 0, CZ + 999);
    // ветер: медленные порывы
    const gust = 0.55 + 0.45 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1.3);
    shared.uWind.value.set(0.8, 0.6, 1, gust);
    if (atmosphere && (atmosphere.keyDir || atmosphere.sunDir)) shared.uSunDir.value.copy(atmosphere.keyDir || atmosphere.sunDir);   // свет (выше диска)
    // вход в зону (гистерезис): событие zone_enter забирает world.js через drainEvents()
    if (!state.inside && dP < BF.r - 2) { state.inside = true; pending.push({ type: 'zone_enter', zoneId: BF.id, name: BF.name, subtitle: BF.subtitle }); }
    else if (state.inside && dP > BF.r + 6) state.inside = false;
    const vis = dC < QF[state.quality].visR;
    if (root.visible !== vis) root.visible = vis;
    state.visible = vis;
    for (const p of parts) {
      if (!p.update) continue;
      if (!vis && !p.always) continue;
      try { p.update(dt, t, shared.uHero.value, _cam, w); } catch (e) { if (!p.warned) { p.warned = true; console.warn('[brightForest] update', p.name, e); } }
    }
  }
  const pending = [];
  function drainEvents() { return pending.splice(0); }

  // Высота опоры на мостиках (для героя) или null — обычная земля.
  function groundAt(x, z) {
    for (const b of BRIDGES) {
      const dx = x - b.ax, dz = z - b.az, L = b.len;
      const u = (dx * b.ux + dz * b.uz) / L;
      if (u < 0 || u > 1) continue;
      if (Math.abs(-dx * b.uz + dz * b.ux) > b.w) continue;
      return b.deckY(u);
    }
    return null;
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    for (const p of parts) if (p.dispose) { try { p.dispose(); } catch (e) { /* ignore */ } }
    root.traverse((o) => { if (o.isInstancedMesh && o.dispose) o.dispose(); });
    if (root.parent) root.parent.remove(root);
    for (const p of parts) if (p.extraRoots) for (const o of p.extraRoots) if (o.parent) o.parent.remove(o);
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) m.dispose();
    for (const tx of owned.tex) tx.dispose();
    owned.geo.clear(); owned.mat.clear(); owned.tex.clear();
  }

  setQuality(state.quality);

  return {
    root, colliders, groundAt, update, setQuality, configure, dispose, drainEvents, mood, plan, map,
    floorLift: (x, z) => forestFloorLift(BF, plan, x, z),   // [W5-ПОЛ] высота подстилки над рельефом
    center: plan.center, radius: BF.r,
    get weight() { return state.weight; },
    get inside() { return state.inside; },
    stats: () => ({
      quality: state.quality, weight: +state.weight.toFixed(3), inside: state.inside, visible: state.visible,
      colliders: colliders.length, parts: parts.map((p) => (p.stats ? { name: p.name, ...p.stats() } : { name: p.name })),
    }),
  };
}

/* =============================== СТРОИТЕЛИ =============================== */
// Каждый строитель: fn(ctx) → { update?(dt, t, hero, cam, weight), setQuality?(q), stats?(), dispose?(), always? }
// Порядок важен: мостики и постройки раньше травы/деревьев (они читают plan.structures/bridges).

// Общий GLSL: хеш и value-noise (для земли, неба).
const BF_NOISE_GLSL = /* glsl */`
float bfH12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float bfVN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( bfH12( i ), bfH12( i + vec2( 1.0, 0.0 ) ), u.x ), mix( bfH12( i + vec2( 0.0, 1.0 ) ), bfH12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float bfFbm( vec2 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 4; i ++ ) { s += a * bfVN( p ); p = p * 2.03 + vec2( 17.1, 9.2 ); a *= 0.5; } return s / 0.9375; }
`;

/* ------------------------------ Небо зоны ------------------------------ */
// Купол поверх неба затмения (atmosphere.js): светлое тёплое небо, солнце вместо диска затмения,
// кучевые облака с золотой кромкой. Прозрачность = вес зоны; ниже горизонта гаснет (там море тумана).
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = ( modelMatrix * vec4( position, 0.0 ) ).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const SKY_FRAG = /* glsl */`
uniform vec3 uSun;
uniform float uW;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uFog;
varying vec3 vDir;
${BF_NOISE_GLSL}
void main() {
  vec3 d = normalize( vDir );
  float el = d.y;
  float cs = max( dot( d, uSun ), 0.0 );
  vec3 col = mix( uHorizon, uMid, smoothstep( 0.0, 0.22, el ) );
  col = mix( col, uTop, smoothstep( 0.18, 0.85, el ) );
  // тёплое сияние вокруг солнца и золотая дымка у горизонта со стороны солнца
  col += vec3( 1.0, 0.72, 0.38 ) * pow( cs, 6.0 ) * 0.55 + vec3( 1.0, 0.85, 0.55 ) * pow( cs, 48.0 ) * 1.2;
  col = mix( col, uHorizon * 1.08, ( 1.0 - smoothstep( 0.0, 0.12, el ) ) * pow( cs, 2.0 ) * 0.5 );
  // облака: плоский слой
  vec2 p = d.xz / ( max( el, 0.0 ) + 0.12 );
  float c = bfFbm( p * 0.9 + vec2( uTime * 0.006, uTime * 0.002 ) );
  float cm = smoothstep( 0.5, 0.78, c ) * smoothstep( 0.02, 0.16, el ) * ( 1.0 - smoothstep( 0.55, 0.9, el ) );
  vec3 cloud = mix( vec3( 1.0, 0.98, 0.95 ), vec3( 0.82, 0.86, 0.92 ), smoothstep( 0.6, 0.9, c ) );
  cloud += vec3( 1.0, 0.7, 0.35 ) * pow( cs, 4.0 ) * 0.9;
  col = mix( col, cloud, cm * 0.85 );
  // солнце: диск > 1 для bloom и лучей постобработки
  float sd = acos( clamp( dot( d, uSun ), -1.0, 1.0 ) );
  col += vec3( 1.0, 0.93, 0.78 ) * ( 1.0 - smoothstep( 0.028, 0.034, sd ) ) * 7.0 * ( 1.0 - cm * 0.8 );
  col += vec3( 1.0, 0.8, 0.5 ) * exp( - sd / 0.05 ) * 0.9;
  // ниже горизонта — в цвет тумана и прозрачно (море тумана мира остаётся)
  col = mix( col, uFog, 1.0 - smoothstep( -0.02, 0.06, el ) );
  float a = uW * smoothstep( -0.12, 0.0, el );
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function buildSky(ctx) {
  const { THREE, camera, shared, parent } = ctx;
  const R = ctx.atmosphere && ctx.atmosphere.skyRadius ? ctx.atmosphere.skyRadius * 0.93 : 700;
  const u = {
    uSun: { value: new THREE.Vector3(-0.1, 0.32, -0.94).normalize() }, uW: shared.uWeight, uTime: shared.uTime,
    uTop: { value: new THREE.Color(0x2f7fd0) }, uMid: { value: new THREE.Color(0x8fd0ee) }, uHorizon: { value: new THREE.Color(0xffe3b0) },
    uFog: { value: new THREE.Color(0x9fd6c4) },
  };
  const mat = ctx.M(new THREE.ShaderMaterial({ uniforms: u, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }));
  const sky = new THREE.Mesh(ctx.G(new THREE.SphereGeometry(R, 48, 24)), mat);
  sky.name = 'bright-forest-sky';
  sky.renderOrder = -9;
  sky.frustumCulled = false;
  sky.visible = false;
  parent.add(sky);
  return {
    always: true, extraRoots: [sky],
    setMood(m) { u.uFog.value.copy(m.fog.color); u.uHorizon.value.copy(m.sky.horizon); u.uTop.value.copy(m.sky.top); },
    update(dt, t, hero, cam, w) {
      sky.visible = w > 0.002;
      if (!sky.visible) return;
      if (camera) sky.position.copy(camera.position);
      if (ctx.atmosphere && ctx.atmosphere.sunDir) u.uSun.value.copy(ctx.atmosphere.sunDir);
    },
    stats: () => ({ visible: sky.visible }),
  };
}

/* ------------------------------ Свет зоны ------------------------------ */
// Тёплая полусфера (без теней): число источников постоянно — меняется только интенсивность.
function buildLight(ctx) {
  const { THREE, parent } = ctx;
  const hemi = new THREE.HemisphereLight(0xfff0d0, 0x4f8a3c, 0);
  hemi.name = 'bright-forest-hemi';
  parent.add(hemi);
  return {
    always: true, extraRoots: [hemi],
    update(dt, t, hero, cam, w) { hemi.intensity = 1.35 * w; },
    stats: () => ({ hemi: +hemi.intensity.toFixed(2) }),
  };
}

/* ------------------------------ Лесная подстилка ------------------------------ */
// Сетка 1.2 м по зоне точно по рельефу (+5 см): мох и трава с пятнами, тропы (утоптанная земля с
// камешками), влажно у воды, солнечные пятна сквозь листву (дрожат на ветру). Край зоны — дизеринг.
// [W5-ПОЛ] подстилка лежит на FLOOR_LIFT выше рельефа (иначе рельеф с другой сеткой проступал бы сквозь неё); у края
// зоны тает — floorLift(x, z) повторяет её высоту для земли героя (world.layoutGroundY), иначе стопы уходили в неё на 5 см
export const FLOOR_LIFT = 0.05;
export function forestFloorLift(BF, plan, x, z) {
  const R = BF.r + 24, d = Math.hypot(x - BF.x, z - BF.z);
  if (d > R || plan.waterDist(x, z) < -1.6) return 0;
  return FLOOR_LIFT * (1 - smoothstep(R - 20, R, d));
}
function buildFloor(ctx) {
  const { THREE, BF, plan, gy, map } = ctx;
  const R = BF.r + 24, step = 1.2, N = Math.ceil((2 * R) / step);
  const pos = [], col = [], attr = [], idx = [], id = new Int32Array((N + 1) * (N + 1)).fill(-1);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = BF.x - R + i * step, z = BF.z - R + j * step, d = Math.hypot(x - BF.x, z - BF.z);
    if (d > R + step) continue;
    const wd = plan.waterDist(x, z);
    if (wd < -1.6) continue;                              // глубоко под водой земля не нужна
    id[j * (N + 1) + i] = pos.length / 3;
    pos.push(x, gy(x, z) + FLOOR_LIFT, z);   // [W5-ПОЛ]
    const s = map.sample(x, z);
    const fade = 1 - ctx.smoothstep(R - 20, R, d);
    let shade = 0;
    for (const g of plan.giants) { const dg = Math.hypot(x - g.x, z - g.z); shade = Math.max(shade, ctx.smoothstep(g.crown * 1.1, g.crown * 0.35, dg)); }
    col.push(1, 1, 1, fade);
    attr.push(s.path, ctx.smoothstep(2.2, -0.2, wd), shade, ctx.smoothstep(0.9, 2.0, Math.abs(gy(x + 0.8, z) - gy(x - 0.8, z)) + Math.abs(gy(x, z + 0.8) - gy(x, z - 0.8))));
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = id[j * (N + 1) + i], b = id[j * (N + 1) + i + 1], c = id[(j + 1) * (N + 1) + i], e = id[(j + 1) * (N + 1) + i + 1];
    if (a < 0 || b < 0 || c < 0 || e < 0) continue;
    idx.push(a, c, b, b, c, e);
  }
  const g = ctx.G(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('aF', new THREE.Float32BufferAttribute(attr, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  // край — мягкая прозрачность (альфа вершин); рисуется первой из прозрачных и пишет глубину
  const mat = ctx.M(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0, transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  const U = { uTime: ctx.shared.uTime, uMotion: ctx.shared.uMotion, uWind: ctx.shared.uWind };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aF;\nvarying vec4 vF;\nvarying vec3 vBfW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vF = aF;\n  vBfW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uMotion;\nuniform vec4 uWind;\nvarying vec4 vF;\nvarying vec3 vBfW;\n' + BF_NOISE_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 wp = vBfW.xz;
    float n1 = bfFbm( wp * 0.07 ), n2 = bfVN( wp * 0.9 ), n3 = bfVN( wp * 3.7 + 11.0 );
    vec3 moss = mix( vec3( 0.2, 0.42, 0.1 ), vec3( 0.44, 0.66, 0.16 ), n1 );
    moss = mix( moss, vec3( 0.62, 0.64, 0.2 ), smoothstep( 0.62, 0.85, n1 ) * 0.6 );          // золотистые поляны
    moss = mix( moss, vec3( 0.12, 0.34, 0.2 ), smoothstep( 0.35, 0.1, n1 ) * 0.5 );           // изумрудная тень
    moss *= 0.82 + 0.3 * n2 + 0.12 * ( n3 - 0.5 );
    // опавшие листья и цветочные крапинки
    float leaf = smoothstep( 0.78, 0.86, bfVN( wp * 2.3 + 5.0 ) );
    moss = mix( moss, vec3( 0.78, 0.52, 0.16 ), leaf * 0.5 );
    float dots = smoothstep( 0.93, 0.97, bfH12( floor( wp * 6.0 ) ) ) * smoothstep( 0.45, 0.7, n1 );
    moss = mix( moss, mix( vec3( 1.0, 0.9, 0.6 ), vec3( 0.5, 1.0, 0.95 ), step( 0.5, bfH12( floor( wp * 6.0 ) + 3.0 ) ) ), dots * 0.7 );
    // тропа: утоптанная тёплая земля с плоскими камешками
    vec3 dirt = mix( vec3( 0.46, 0.36, 0.24 ), vec3( 0.6, 0.5, 0.36 ), n2 );
    float st = smoothstep( 0.6, 0.66, bfVN( wp * 1.6 + 2.0 ) );
    dirt = mix( dirt, vec3( 0.72, 0.7, 0.62 ), st * 0.7 );
    vec3 c = mix( moss, dirt, smoothstep( 0.25, 0.75, vF.x + ( n3 - 0.5 ) * 0.3 ) );
    // влажный берег, скалы
    c = mix( c, c * vec3( 0.55, 0.62, 0.55 ), vF.y * 0.8 );
    c = mix( c, vec3( 0.46, 0.5, 0.44 ) * ( 0.75 + 0.5 * n2 ), vF.w * 0.85 );
    // солнечные пятна сквозь листву (в тени крон) — дрожат на ветру
    vec2 wv = wp + uWind.xy * uTime * 0.25 * uMotion;
    float dap = smoothstep( 0.58, 0.72, bfVN( wv * 0.55 ) * 0.65 + bfVN( wv * 1.3 + 7.0 ) * 0.35 );
    c *= mix( 1.0, 0.62 + 0.75 * dap, vF.z );
    diffuseColor.rgb = c;
  }`);
  };
  mat.customProgramCacheKey = () => 'bfFloor';
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'bright-forest-floor';
  mesh.renderOrder = -2;
  mesh.receiveShadow = true;
  ctx.root.add(mesh);
  return { stats: () => ({ verts: pos.length / 3, tris: idx.length / 3 }) };
}

const BUILDERS = [['sky', buildSky], ['light', buildLight], ['floor', buildFloor]];
