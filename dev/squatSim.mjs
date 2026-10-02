// ASHEN OATH — симулятор позы человека, приседающего перед камерой ноутбука (dev). Нужен, чтобы проверять
// core/squatCounter.js на данных, похожих на живые: дрожь точек MediaPipe, лодыжки за кадром,
// неглубокие приседы, распознавание 12–15 Гц. Чистая логика: без DOM; случайность — только свой сидовый
// ГПСЧ (makeRng): один seed — одни и те же кадры. Проверки самого симулятора: node dev/squatSim.test.mjs
//
// Тело — 3D, метры: u — вверх от пола, f — куда смотрит человек, r — к его правой руке. Пропорции по
// антропометрии (Winter), H — рост: голень 0,246·H, бедро 0,245·H, корпус плечо–таз 0,30·H, таз (между
// тазобедренными суставами) 0,19·H, плечи 0,23·H, лодыжка ≈ 0,07 м над полом. Стопы на ширине плеч,
// носки развёрнуты на 20°. Присед: бедро наклоняется от вертикали на θ (0 — стоя, 90 — параллель),
// голень вперёд на φ = 0,35·θ, колени по линии носков (kneesOut — шире, valgus — внутрь), корпус вперёд
// на α — так, чтобы центр масс оставался над стопами (или leanDeg явно), руки вперёд для равновесия.
//
// Камера — обскура: кадр 640×480, вертикальный угол обзора 45°, высота cameraHeightM (1,0 — ноутбук на
// столе, 0,05 — на полу), наклон cameraPitchDeg (+ вверх, как раскрытая крышка); человек на distanceM,
// повёрнут на yawDeg (0 — лицом, 90 — боком), смещён по x на offsetX (м).
//
// Шум MediaPipe: дрожь каждой точки (гаусс, σ = jitter/2 доли высоты кадра) и редкие выбросы (σ×3),
// медленное «плавание» точек (wobble), покачивание тела (sway, м, маятник от стоп), точка бедра на дне
// выше настоящей (hipShiftM). Видимость по группам точек (плечи ≈ 0,99, бёдра ≈ 0,9, колени ≈ 0,8,
// лодыжки ≈ 0,65 у lite на 2 м), падает с расстоянием (full — медленнее), у края кадра и за краем
// (там 0,02–0,3, позиция экстраполирована: поджата к краю и шумит), на дальней стороне боком; случайные
// провалы (dropoutRate), anklesHidden — лодыжки всегда 0,05–0,45; видимость шумит от кадра к кадру.
// Частота hz с неравномерными интервалами (±20%) и пропусками кадров.
//
// Кадры — как vision.getPose(): { tMs, frameW, frameH, mirror: true, landmarks[33] }; x, y нормированы
// на ширину/высоту кадра (y вниз), координаты НЕзеркальные (правая рука человека — слева в кадре), как
// у modules/vision.js; mirror — только флаг превью. Заполнены COMPACT_INDICES (как в живой игре),
// с withFeet — ещё пятки/носки 29–32; остальные null.
//
// simulateSquatSession(opts) → { frames, truth: { reps, standingIntervals, events, durationMs, opts, trace? } }
// repsPreset(name, n, seed) → [{ thighDeg, downS, upS, bottomS, topS, leanDeg? }]
// synthPoseAt(state, camera?, noise?, rng?) → landmarks[33] (по умолчанию без шума);
// poseGeometry(state, camera?) → точки в 3D и в кадре без шума, истинные углы.
// Помощники: thighForEst / estForThigh (estDeg = 180 − θ), kneeForThigh(θ) — истинный угол колена, bodyFor(H),
// armFor(style, θ), makeRng(seed).

export const COMPACT_INDICES = Object.freeze([0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);   // как modules/vision.js
export const FEET_INDICES = Object.freeze([29, 30, 31, 32]);

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (fin(v) ? v : d);
const logit = (p) => Math.log(p / (1 - p));
const sigm = (x) => 1 / (1 + Math.exp(-x));
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r2 = (v) => Math.round(v * 100) / 100;
const mj = (u) => { const x = clamp(u, 0, 1); return x * x * x * (10 - 15 * x + 6 * x * x); };   // минимальный рывок 0→1
const bump = (u, a) => (u < a ? mj(u / a) : u > 1 - a ? mj((1 - u) / a) : 1);                    // 0 → 1 (держит) → 0

// ---- ГПСЧ (mulberry32) и гаусс; fork(k) — независимый поток (сценарий, шум, время не мешают друг другу)
export function makeRng(seed = 1) {
  const s0 = typeof seed === 'string' ? [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) : Math.floor(num(seed, 1));
  let a = (s0 ^ 0x5bd1e995) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.range = (lo, hi) => lo + (hi - lo) * rnd();
  rnd.gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  rnd.fork = (k) => makeRng((Math.imul((s0 >>> 0) + 0x9e3779b9 * (k + 1), 0x85ebca6b) ^ (k * 0x27d4eb2f)) >>> 0);
  return rnd;
}

// ---- «угол по бедру» (условность счётчика): estDeg = 180 − θ
export const thighForEst = (estDeg) => 180 - estDeg;
export const estForThigh = (thighDeg) => 180 - thighDeg;

/** Пропорции тела (метры) по росту H; over — переопределить любые. */
export function bodyFor(heightM = 1.75, over) {
  const H = clamp(num(heightM, 1.75), 1.2, 2.2);
  return {
    H, ankleH: 0.039 * H, shin: 0.246 * H, thigh: 0.245 * H, torso: 0.30 * H,
    hipW: 0.19 * H, shoulderW: 0.23 * H, stanceW: 0.23 * H, toeOutDeg: 20,
    upperArm: 0.186 * H, forearm: 0.146 * H,
    neck: 0.09 * H, nose: 0.05 * H, earW: 0.04 * H,
    heelBack: 0.03 * H, toeFwd: 0.11 * H, footH: 0.012 * H,
    shinRatio: 0.35,
    ...(over && typeof over === 'object' ? over : {}),
  };
}

// ---- скелет. Поза st: thL/thR — θ бёдер (°), lean — α корпуса (°), arm — { flex, bend, abd, foreAbd } (°:
// сгибание в плече вперёд от «висят», локоть, отведение в сторону плеча и предплечья), valgus/kneesOut 0..1,
// shiftR — сдвиг таза вбок (м), feet — [{ r, f, lift }] смещения стоп (м). Координаты точек — { r, u, f }.
const FEET0 = Object.freeze([Object.freeze({ r: 0, f: 0, lift: 0 }), Object.freeze({ r: 0, f: 0, lift: 0 })]);

function legChain(B, side, th, st, foot) {
  const a = B.stanceW / 2, h = B.hipW / 2;
  const ank = { r: side * a + foot.r, u: B.ankleH + foot.lift, f: foot.f };
  const phi = B.shinRatio * th * RAD;
  // азимут колена от «вперёд» (наружу +): по линии носков; kneesOut — шире, valgus — внутрь
  const psi = (B.toeOutDeg + 20 * (st.kneesOut || 0) - 60 * (st.valgus || 0)) * RAD;
  const gam = Math.atan2(a - h, B.shin + B.thigh);   // стоя нога — прямая лодыжка → таз (чуть внутрь)
  const out = Math.sin(phi) * Math.sin(psi) - Math.sin(gam) * Math.cos(phi);
  const fw = Math.sin(phi) * Math.cos(psi);
  const up = Math.sqrt(Math.max(0, 1 - out * out - fw * fw));
  const knee = { r: ank.r + side * out * B.shin, u: ank.u + up * B.shin, f: ank.f + fw * B.shin };
  // таз: бедро под углом θ к вертикали, по ширине — на месте тазобедренного сустава
  const hr = side * h + (st.shiftR || 0);
  const dx = Math.abs(knee.r - hr), D = B.thigh * Math.sin(th * RAD);
  const hip = D > dx
    ? { r: hr, u: knee.u + B.thigh * Math.cos(th * RAD), f: knee.f - Math.sqrt(D * D - dx * dx) }
    : { r: hr, u: knee.u + Math.sqrt(Math.max(0, B.thigh * B.thigh - dx * dx)), f: knee.f };
  const fr = side * Math.sin(B.toeOutDeg * RAD), ff = Math.cos(B.toeOutDeg * RAD);
  const heel = { r: ank.r - fr * B.heelBack, u: B.footH + foot.lift, f: ank.f - ff * B.heelBack };
  const toe = { r: ank.r + fr * B.toeFwd, u: B.footH + foot.lift, f: ank.f + ff * B.toeFwd };
  return { ank, knee, hip, heel, toe };
}

function armDir(side, flex, abd) {
  return { r: side * Math.sin(abd * RAD), u: -Math.cos(flex * RAD) * Math.cos(abd * RAD), f: Math.sin(flex * RAD) * Math.cos(abd * RAD) };
}

function skeleton(st, B) {
  const P = {};
  const legs = [-1, 1].map((side, k) => legChain(B, side, k ? st.thR : st.thL, st, (st.feet || FEET0)[k] || FEET0[k]));
  legs.forEach((g, k) => { P[23 + k] = g.hip; P[25 + k] = g.knee; P[27 + k] = g.ank; P[29 + k] = g.heel; P[31 + k] = g.toe; });
  const pc = { r: (legs[0].hip.r + legs[1].hip.r) / 2, u: (legs[0].hip.u + legs[1].hip.u) / 2, f: (legs[0].hip.f + legs[1].hip.f) / 2 };
  const al = st.lean * RAD;
  const sc = { r: pc.r, u: pc.u + B.torso * Math.cos(al), f: pc.f + B.torso * Math.sin(al) };
  const arm = st.arm;
  [-1, 1].forEach((side, k) => {
    const sh = { r: sc.r + side * B.shoulderW / 2, u: sc.u, f: sc.f };
    const d1 = armDir(side, arm.flex, arm.abd), d2 = armDir(side, arm.flex + arm.bend, arm.foreAbd ?? arm.abd);
    const el = { r: sh.r + d1.r * B.upperArm, u: sh.u + d1.u * B.upperArm, f: sh.f + d1.f * B.upperArm };
    P[11 + k] = sh; P[13 + k] = el;
    P[15 + k] = { r: el.r + d2.r * B.forearm, u: el.u + d2.u * B.forearm, f: el.f + d2.f * B.forearm };
  });
  // голова: шея наклоняется вдвое меньше корпуса, взгляд чуть вниз
  const ah = 0.5 * al, pd = 0.3 * al;
  const hc = { r: sc.r, u: sc.u + B.neck * Math.cos(ah), f: sc.f + B.neck * Math.sin(ah) };
  const fu = -Math.sin(pd), ff = Math.cos(pd), back = 0.012 * B.H;
  P[0] = { r: hc.r, u: hc.u + B.nose * fu - 0.004 * B.H, f: hc.f + B.nose * ff };
  P[7] = { r: hc.r - B.earW, u: hc.u - back * fu, f: hc.f - back * ff };
  P[8] = { r: hc.r + B.earW, u: hc.u - back * fu, f: hc.f - back * ff };
  return { P, legs, pc, sc, hc };
}

function kneeAngle(g) {
  const ax = g.hip.r - g.knee.r, ay = g.hip.u - g.knee.u, az = g.hip.f - g.knee.f;
  const bx = g.ank.r - g.knee.r, by = g.ank.u - g.knee.u, bz = g.ank.f - g.knee.f;
  const c = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
  return Math.acos(clamp(c, -1, 1)) * DEG;
}

// центр масс по ходу «вперёд» (доли массы сегментов и положение их ЦМ — Winter)
function comF(sk) {
  const { P } = sk;
  let m = 0, f = 0;
  const add = (w, a, b, k) => { m += w; f += w * (a.f + (b.f - a.f) * k); };
  for (let k = 0; k < 2; k++) {
    add(0.0145, P[29 + k], P[31 + k], 0.5); add(0.0465, P[25 + k], P[27 + k], 0.567); add(0.1, P[23 + k], P[25 + k], 0.433);
    add(0.028, P[11 + k], P[13 + k], 0.436); add(0.022, P[13 + k], P[15 + k], 0.682);
  }
  add(0.497, sk.pc, sk.sc, 0.5); add(0.081, sk.hc, sk.hc, 0);
  return f / m;
}

// руки по θ: 'forward' — вперёд для равновесия (по умолчанию), 'down' — висят, 'chest' — у груди
export function armFor(style, th) {
  const k = clamp(th / 90, 0, 1.15);
  if (style === 'down') return { flex: 4 + 6 * k, bend: 10 + 5 * k, abd: 6, foreAbd: 6 };
  if (style === 'chest') return { flex: 25, bend: 110, abd: 12, foreAbd: -25 };
  return { flex: 6 + 76 * Math.pow(k, 0.8), bend: 12 + 8 * k, abd: 8 - 4 * k, foreAbd: 4 - 6 * k };
}

// автонаклон корпуса: α, при котором ЦМ над стопами там же, где стоя (α стоя = 2°). Ниже параллели таз
// уходит под колени и равновесию хватает меньшего α, но живой человек не выпрямляется — берём огибающую
// (α не убывает с θ). Таблица через 1°, между — линейно.
const LEAN_CACHE = new Map();
function makeAutoLean(B, armStyle) {
  const key = JSON.stringify(B) + '|' + armStyle;
  if (LEAN_CACHE.has(key)) return LEAN_CACHE.get(key);
  const pose = (th, lean) => ({ thL: th, thR: th, lean, feet: FEET0, arm: armFor(armStyle, th) });
  const target = comF(skeleton(pose(0, 2), B));
  const bal = (t) => {
    let lo = 0, hi = 65;
    if (comF(skeleton(pose(t, lo), B)) >= target) return lo;
    if (comF(skeleton(pose(t, hi), B)) <= target) return hi;
    for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (comF(skeleton(pose(t, mid), B)) < target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  const tab = [];
  for (let t = 0; t <= 130; t++) tab.push(Math.max(bal(t), t ? tab[t - 1] : 0));
  const fn = (th) => {
    const t = clamp(num(th, 0), 0, 130), k = Math.min(Math.floor(t), 129);
    return tab[k] + (tab[k + 1] - tab[k]) * (t - k);
  };
  if (LEAN_CACHE.size > 64) LEAN_CACHE.clear();
  LEAN_CACHE.set(key, fn);
  return fn;
}

// ---- камера и проекция. place: { x, z (м, от камеры по горизонтали), yaw (рад), sway: { r, f } }
const cameraOf = (c = {}) => ({
  heightM: num(c.heightM, 1.0), pitchDeg: num(c.pitchDeg, 8), vFovDeg: clamp(num(c.vFovDeg, 45), 10, 120),
  frameW: num(c.frameW, 640), frameH: num(c.frameH, 480),
});

// лицом к камере (yaw 0): «вперёд» человека — к камере (−Z), его правая рука — слева в кадре (−X)
function toWorld(p, place, H) {
  const c = Math.cos(place.yaw), s = Math.sin(place.yaw);
  const sw = place.sway, k = sw ? p.u / H : 0;
  const r = p.r + (sw ? sw.r * k : 0), f = p.f + (sw ? sw.f * k : 0);
  return { x: place.x + f * s - r * c, y: p.u, z: place.z - f * c - r * s };
}

function project(Pw, cam) {
  const p = cam.pitchDeg * RAD, cp = Math.cos(p), sp = Math.sin(p);
  const dy = Pw.y - cam.heightM;
  const yc = dy * cp - Pw.z * sp, zc = Math.max(0.05, dy * sp + Pw.z * cp);
  const k = 0.5 / Math.tan(cam.vFovDeg * RAD / 2);
  return { x: 0.5 + (Pw.x / zc) * k * cam.frameH / cam.frameW, y: 0.5 - (yc / zc) * k, zc };
}

// ---- видимость и шум MediaPipe
// базовая видимость лицом на 2 м (модель lite); в логитах падает на perM за метр дальше (верх тела — втрое
// медленнее); full держит нижнюю часть тела выше (lower) и теряет медленнее
const VIS_BASE = Object.freeze({ 0: 0.99, 7: 0.93, 8: 0.93, 11: 0.995, 12: 0.995, 13: 0.94, 14: 0.94, 15: 0.9, 16: 0.9, 23: 0.9, 24: 0.9, 25: 0.8, 26: 0.8, 27: 0.65, 28: 0.65, 29: 0.55, 30: 0.55, 31: 0.6, 32: 0.6 });
const VIS_MODEL = Object.freeze({ lite: { perM: 0.3, lower: 0 }, full: { perM: 0.12, lower: 0.5 } });
const PAIR = Object.freeze({ 7: 8, 8: 7, 11: 12, 12: 11, 13: 14, 14: 13, 15: 16, 16: 15, 23: 24, 24: 23, 25: 26, 26: 25, 27: 28, 28: 27, 29: 30, 30: 29, 31: 32, 32: 31 });
const EDGE = 0.04;   // у края кадра (доля) видимость начинает падать

// Без шума: ideal: true у сессии и synthPoseAt по умолчанию (явно заданные поля сильнее)
const IDEAL = Object.freeze({ jitter: 0, outlierRate: 0, wobble: 0, sway: 0, hipShiftM: 0, dropoutRate: 0, hzJitter: 0, frameDropRate: 0, visNoise: 0, extrapErr: 0, poseLossRate: 0 });

// состояние шума по точкам: AR видимости, «плавание» (Орнштейн–Уленбек), провал, сжатие экстраполяции
function createPoseNoise(o, rng) {
  const ids = o.withFeet ? [...COMPACT_INDICES, ...FEET_INDICES] : COMPACT_INDICES;
  const per = {};
  for (const i of ids) per[i] = { e: 0, wx: 0, wy: 0, drop: 0, dropVis: 0, comp: rng.range(0.15, 0.35) };
  return { ids, per, rng };
}

// скелет → landmarks[33] кадра. hipLift — смещение точек бёдер вверх (м) [лев, прав]; dt — с прошлого кадра (с)
function renderLandmarks(sk, place, cam, B, o, N, dt, hipLift) {
  const rng = N.rng, ax = cam.frameH / cam.frameW;
  const kf = 0.5 / Math.tan(cam.vFovDeg * RAD / 2);
  const dist = project(toWorld(sk.pc, place, B.H), cam).zc;
  const vm = VIS_MODEL[o.model] || VIS_MODEL.lite;
  const syaw = Math.abs(Math.sin(place.yaw));
  const pr = {};
  for (const i of N.ids) {
    let p = sk.P[i];
    if ((i === 23 || i === 24) && hipLift && hipLift[i - 23]) p = { ...p, u: p.u + hipLift[i - 23] };
    pr[i] = project(toWorld(p, place, B.H), cam);
  }
  const kw = dt > 0 ? Math.exp(-dt / 0.35) : 1, ks = Math.sqrt(1 - kw * kw);
  const out = new Array(33).fill(null);
  for (const i of N.ids) {
    const q = pr[i], s = N.per[i];
    // видимость: база точки − расстояние − дальняя сторона (боком) + шум кадра; край и за краем — отдельно
    let L = logit(VIS_BASE[i]);
    const lower = i >= 23 || i === 15 || i === 16;
    L -= (lower ? vm.perM : vm.perM * 0.3) * (dist - 2);
    if (i >= 23) L += vm.lower;
    const j = PAIR[i];
    if (j !== undefined && pr[j] && q.zc > pr[j].zc) L -= (i === 7 || i === 8 ? 3 : 1.2) * syaw;
    s.e = s.e * 0.8 + 0.3 * o.visNoise * rng.gauss();
    L += s.e + 0.15 * o.visNoise * rng.gauss();
    const m = Math.min(q.x, 1 - q.x, q.y, 1 - q.y), outD = Math.max(0, -m);
    let v;
    if (m < 0) v = clamp(0.02 + 0.28 * Math.exp(-outD / 0.08) + 0.03 * o.visNoise * rng.gauss(), 0.02, 0.3);
    else v = sigm(m < EDGE ? L - 2 * (1 - m / EDGE) : L);
    const hidden = o.anklesHidden && i >= 27;
    if (hidden) v = Math.min(v, 0.05 + 0.4 * sigm(1.5 * s.e + 0.4 * o.visNoise * rng.gauss()));
    // провал: точка на кадр-два теряет уверенность
    let dropping = false;
    if (s.drop > 0) { s.drop--; dropping = true; }
    else if (o.dropoutRate > 0 && rng() < o.dropoutRate) { s.drop = rng() < 0.5 ? 0 : 1; s.dropVis = rng.range(0.1, 0.4); dropping = true; }
    if (dropping) v = Math.min(v, s.dropVis);
    // позиция: за краем — экстраполяция (поджата к краю); дрожь сильнее у неуверенных точек
    let x = q.x, y = q.y;
    if (outD > 0 && o.extrapErr > 0) {
      const c = 1 - s.comp * o.extrapErr;
      if (x < 0) x *= c; else if (x > 1) x = 1 + (x - 1) * c;
      if (y < 0) y *= c; else if (y > 1) y = 1 + (y - 1) * c;
    }
    const sg = (o.jitter / 2) * (1 + 1.5 * Math.max(0, 0.6 - v)) * (dropping ? 2 : 1);
    const sgE = ((outD > 0 ? 0.004 + 0.1 * outD : 0) + (hidden ? 0.008 : 0)) * o.extrapErr;
    s.wx = s.wx * kw + o.wobble * ks * rng.gauss();
    s.wy = s.wy * kw + o.wobble * ks * rng.gauss();
    let dx = sg * rng.gauss() + sgE * rng.gauss() + s.wx, dy = sg * rng.gauss() + sgE * rng.gauss() + s.wy;
    if (o.outlierRate > 0 && rng() < o.outlierRate) { dx += 3 * sg * rng.gauss(); dy += 3 * sg * rng.gauss(); }
    const z = (q.zc - dist) * kf * ax / dist + 3 * sg * rng.gauss();
    out[i] = { x: r5(x + dx * ax), y: r5(y + dy), z: r5(z), visibility: Math.round(clamp(v, 0.001, 0.999) * 1e4) / 1e4 };
  }
  return out;
}

// ---- сценарий
const PRESETS = {
  clean: { th: [85, 100], down: [1.0, 1.4], up: [0.8, 1.2], bottom: [0.1, 0.3], top: [0.6, 1.1] },
  novice: { th: [55, 75], down: [0.6, 1.0], up: [0.6, 0.9], bottom: [0, 0.15], top: [0.3, 0.8], lean: [38, 50] },
  shallow115: { th: [60, 70], down: [0.8, 1.2], up: [0.7, 1.0], bottom: [0.05, 0.2], top: [0.5, 0.9] },
  tooShallow: { th: [25, 40], down: [0.6, 1.0], up: [0.5, 0.8], bottom: [0, 0.15], top: [0.5, 1.0] },
  fast: { th: [80, 95], down: [0.3, 0.4], up: [0.3, 0.4], bottom: [0, 0.05], top: [0.2, 0.4] },
  deep: { th: [95, 110], down: [1.2, 1.6], up: [1.0, 1.3], bottom: [0.2, 0.4], top: [0.6, 1.0] },
  slow: { th: [85, 100], down: [2.2, 3.0], up: [1.8, 2.5], bottom: [0.3, 0.6], top: [0.8, 1.2] },
};
export const SQUAT_PRESETS = Object.freeze(Object.keys(PRESETS));

/**
 * Повторы по шаблону: 'clean' (θ 85–100, 1,0–1,4 с вниз), 'novice' (θ 55–75, 0,6–1,0 с, пауза 0,3–0,8 с,
 * корпус вперёд), 'shallow115' (estDeg 110–120), 'tooShallow' (θ 25–40 — не присед), 'fast' (0,3–0,4 с
 * вниз и вверх), 'deep', 'slow'. Один seed — одни и те же повторы.
 */
export function repsPreset(name, n = 5, seed = 1) {
  const p = PRESETS[name];
  if (!p) throw new Error(`squatSim: нет шаблона «${name}» (${SQUAT_PRESETS.join(', ')})`);
  const rng = makeRng(seed).fork(17);
  const R = (a) => r2(rng.range(a[0], a[1]));
  const out = [];
  for (let i = 0; i < Math.max(0, Math.floor(num(n, 5))); i++) {
    const rep = { thighDeg: Math.round(rng.range(p.th[0], p.th[1]) * 10) / 10, downS: R(p.down), upS: R(p.up), bottomS: R(p.bottom), topS: R(p.top) };
    if (p.lean) rep.leanDeg = Math.round(rng.range(p.lean[0], p.lean[1]));
    out.push(rep);
  }
  return out;
}

function normRep(r, rng) {
  const x = r && typeof r === 'object' ? r : {};
  const rep = {
    thighDeg: clamp(num(x.thighDeg, 90), 0, 130), downS: Math.max(0.05, num(x.downS, 1.2)), upS: Math.max(0.05, num(x.upS, 1.0)),
    bottomS: Math.max(0, num(x.bottomS, 0.15)), topS: Math.max(0, num(x.topS, 0.8)),
  };
  if (fin(x.leanDeg)) rep.leanDeg = clamp(x.leanDeg, 0, 80);
  if (fin(x.valgus)) rep.valgus = clamp(x.valgus, 0, 1);
  if (fin(x.kneesOut)) rep.kneesOut = clamp(x.kneesOut, 0, 1);
  if (x.noLockout) { rep.noLockout = true; rep.topDeg = fin(x.topDeg) ? x.topDeg : Math.round(rng.range(25, 35) * 10) / 10; }
  return rep;
}

// где вставить помеху: true — после каждого второго повтора, число — столько раз равномерно, массив — после
// этих повторов (−1 — до первого)
function gapsFor(spec, n) {
  if (!spec) return [];
  if (Array.isArray(spec)) return spec.filter((k) => Number.isInteger(k) && k >= -1 && k < n);
  if (typeof spec === 'number' && spec > 0) {
    const out = [];
    for (let j = 0; j < Math.floor(spec); j++) out.push(clamp(Math.round(((j + 1) * n) / (Math.floor(spec) + 1)) - 1, -1, n - 1));
    return out;
  }
  const out = [];
  for (let k = 1; k < n - 1; k += 2) out.push(k);
  return out.length ? out : [n >= 2 ? 0 : -1];
}

export const SIM_DEFAULTS = Object.freeze({
  seed: 1, t0: 1000,
  heightM: 1.75, body: null,
  frameW: 640, frameH: 480, vFovDeg: 45, cameraHeightM: 1.0, cameraPitchDeg: 8,
  distanceM: 2.5, yawDeg: 0, offsetX: 0,
  standS: 2, tailS: 1.5, reps: 'clean', n: 5,
  leanDeg: null, valgus: 0, kneesOut: 0, armStyle: 'forward', shinRatio: 0.35,
  walk: false, fidget: false, arms: false,
  hz: 15, hzJitter: 0.2, frameDropRate: 0.03, poseLossRate: 0,
  model: 'lite', jitter: 0.015, outlierRate: 0.005, wobble: 0.004, sway: 0.01, hipShiftM: 0.04,
  dropoutRate: 0.01, anklesHidden: false, withFeet: false, visNoise: 1, extrapErr: 1,
  ideal: false, trace: false,
});

function resolveOpts(opts) {
  const u = {};
  for (const [k, v] of Object.entries(opts && typeof opts === 'object' ? opts : {})) if (v !== undefined) u[k] = v;
  const o = { ...SIM_DEFAULTS, ...(u.ideal ? IDEAL : {}), ...u };
  o.hz = clamp(num(o.hz, 15), 1, 120);
  for (const k of ['jitter', 'outlierRate', 'wobble', 'sway', 'hipShiftM', 'dropoutRate', 'hzJitter', 'frameDropRate', 'visNoise', 'extrapErr', 'poseLossRate']) o[k] = Math.max(0, num(o[k], SIM_DEFAULTS[k]));
  o.hzJitter = Math.min(o.hzJitter, 0.9); o.frameDropRate = Math.min(o.frameDropRate, 0.9);
  if (o.model !== 'full') o.model = 'lite';
  return o;
}

/**
 * Сессия приседаний перед камерой. Главное в opts (см. SIM_DEFAULTS): seed, heightM, distanceM, yawDeg,
 * offsetX, cameraHeightM, cameraPitchDeg, vFovDeg, frameW/H; standS, reps (массив { thighDeg, downS, upS,
 * bottomS, topS, leanDeg?, valgus?, kneesOut?, noLockout? } или имя шаблона + n), tailS, leanDeg, valgus,
 * kneesOut, armStyle; помехи walk / fidget / arms (true | число | [после каких повторов]); hz, hzJitter,
 * frameDropRate; шум jitter, outlierRate, wobble, sway, hipShiftM, dropoutRate, anklesHidden, model,
 * withFeet; ideal: true — без шума (явно заданные поля сильнее); trace: true — истинные θ/α на каждый кадр.
 */
export function simulateSquatSession(opts = {}) {
  const o = resolveOpts(opts);
  const root = makeRng(o.seed), rScen = root.fork(1), rNoise = root.fork(2), rTime = root.fork(3), rSway = root.fork(4);
  const B = bodyFor(o.heightM, { shinRatio: o.shinRatio, ...(o.body || {}) });
  const cam = cameraOf({ heightM: o.cameraHeightM, pitchDeg: o.cameraPitchDeg, vFovDeg: o.vFovDeg, frameW: o.frameW, frameH: o.frameH });
  const reps = (Array.isArray(o.reps) ? o.reps : repsPreset(String(o.reps), o.n, o.seed)).map((r) => normRep(r, rScen));
  const autoLean = makeAutoLean(B, o.armStyle);
  const leanFor = (th, rep) => {
    const want = rep && fin(rep.leanDeg) ? rep.leanDeg : fin(o.leanDeg) ? o.leanDeg : null;
    if (want === null) return autoLean(th);
    const thB = rep ? Math.max(rep.thighDeg, 1) : 90, aB = autoLean(thB);
    return aB > 3 ? autoLean(th) * (want / aB) : 2 + (want - 2) * clamp(th / thB, 0, 1);
  };

  // план: отрезки времени (с от начала) с позой fn(u, s) → { th, thL?, thR?, lean?, arm?, shiftR?, feet?, dz? }
  const segs = [], truthReps = [], events = [];
  let t = 0, th = 0, dz = 0, walkDir = 0;
  const seg = (kind, dur, fn, rep = null) => { segs.push({ kind, t0: t, t1: t + dur, fn, rep, dz }); t += dur; };
  const ms = (s) => Math.round((o.t0 + s * 1000) * 10) / 10;
  const nuisances = [
    ...gapsFor(o.walk, reps.length).map((k) => ({ k, kind: 'walk' })),
    ...gapsFor(o.fidget, reps.length).map((k) => ({ k, kind: 'fidget' })),
    ...gapsFor(o.arms, reps.length).map((k) => ({ k, kind: 'arms' })),
  ];
  const insertAfter = (k) => {
    if (th !== 0) return;   // не выпрямился — помеху не вставляем
    for (const nz of nuisances.filter((x) => x.k === k)) {
      const t0 = t;
      if (nz.kind === 'walk') {
        // 2–3 шага назад/вперёд по оси камеры, потом приставить вторую ногу
        if (!walkDir) walkDir = o.distanceM + dz < 3 ? 1 : -1;
        const D = walkDir * rScen.range(0.3, 0.6), n = rScen() < 0.5 ? 2 : 3, stepS = rScen.range(0.5, 0.65), z0 = dz;
        walkDir = -walkDir;
        const target = (j) => z0 + (D * Math.min(j + 1, n)) / n;
        seg('walk', (n + 1) * stepS, (u, s) => {
          const k2 = Math.min(Math.floor(s / stepS), n), w = clamp((s - k2 * stepS) / stepS, 0, 1);
          const base = k2 < n ? z0 + (D * (k2 + mj(w))) / n : z0 + D;
          const foot = [z0, z0], lift = [0, 0], bend = [0, 0];
          for (let j = 0; j <= k2; j++) {
            const leg = j % 2, prev = foot[leg];
            if (j < k2) foot[leg] = target(j);
            else { foot[leg] = prev + (target(j) - prev) * mj(w); lift[leg] = 0.06 * Math.sin(Math.PI * w); bend[leg] = 22 * Math.sin(Math.PI * w); }
          }
          const c = Math.cos(o.yawDeg * RAD), sn = Math.sin(o.yawDeg * RAD);
          const feet = [0, 1].map((leg) => { const d = foot[leg] - base; return { r: -sn * d, f: -c * d, lift: lift[leg] }; });
          return { th: 0, thL: bend[0], thR: bend[1], feet, dz: base, lean: 4, arm: { flex: 5 + 12 * Math.sin(2 * Math.PI * s / (2 * stepS)), bend: 15, abd: 6 } };
        });
        dz = z0 + D;
        events.push({ kind: 'walk', tStart: ms(t0), tEnd: ms(t), fromM: r2(o.distanceM + z0), toM: r2(o.distanceM + dz) });
      } else if (nz.kind === 'fidget') {
        // переминается с ноги на ногу и наклоняется к ноутбуку — без приседа
        const dur = rScen.range(2.5, 3.5), lean = rScen.range(30, 45), f0 = rScen.range(0.7, 1.1);
        seg('fidget', dur, (u, s) => {
          const b = bump(u, 0.3), w = Math.sin(2 * Math.PI * f0 * s);
          return { th: 8 * b, thL: 6 * Math.max(0, w), thR: 6 * Math.max(0, -w), shiftR: 0.035 * w, lean: 2 + lean * b, arm: { flex: 6 + 45 * b, bend: 15 + 25 * b, abd: 6 } };
        });
        events.push({ kind: 'fidget', tStart: ms(t0), tEnd: ms(t), leanDeg: Math.round(2 + lean) });
      } else {
        // машет руками над головой
        const dur = rScen.range(2, 3), f0 = rScen.range(1.0, 1.5);
        seg('arms', dur, (u, s) => ({ th: 0, arm: { flex: 15, bend: 20, abd: 20 + 130 * (0.5 - 0.5 * Math.cos(2 * Math.PI * f0 * s)) } }));
        events.push({ kind: 'arms', tStart: ms(t0), tEnd: ms(t) });
      }
    }
  };

  seg('stand', Math.max(0, num(o.standS, 2)), () => ({ th: 0 }));
  insertAfter(-1);
  reps.forEach((r, i) => {
    const from = th, top = r.noLockout ? r.topDeg : 0, tStart = t;
    seg('down', r.downS, (u) => ({ th: from + (r.thighDeg - from) * mj(u) }), r);
    const tBottom = t;
    seg('bottom', r.bottomS, () => ({ th: r.thighDeg }), r);
    const tRise = t;
    seg('up', r.upS, (u) => ({ th: r.thighDeg + (top - r.thighDeg) * mj(u) }), r);
    const tEnd = t;
    seg('top', r.topS, () => ({ th: top }), r);
    th = top;
    const st = poseOf({ th: r.thighDeg }, r);
    const sk = skeleton(st, B);
    truthReps.push({
      i, tStart: ms(tStart), tBottom: ms(tBottom), tRise: ms(tRise), tEnd: ms(tEnd),
      thighDeg: r.thighDeg, kneeDeg: Math.round(((kneeAngle(sk.legs[0]) + kneeAngle(sk.legs[1])) / 2) * 10) / 10,
      estDeg: Math.round(estForThigh(r.thighDeg) * 10) / 10, leanDeg: Math.round(st.lean * 10) / 10,
      topDeg: top, lockout: !r.noLockout, downS: r.downS, upS: r.upS,
    });
    insertAfter(i);
  });
  if (th > 0) { const from = th; seg('up', 0.6, (u) => ({ th: from * (1 - mj(u)) })); th = 0; }
  seg('stand', Math.max(0, num(o.tailS, 1.5)), () => ({ th: 0 }));
  const dur = t;

  function poseOf(p, rep) {
    const thM = p.th;
    return {
      thL: thM + (p.thL || 0), thR: thM + (p.thR || 0),
      lean: fin(p.lean) ? p.lean : leanFor(thM, rep),
      valgus: rep && fin(rep.valgus) ? rep.valgus : o.valgus, kneesOut: rep && fin(rep.kneesOut) ? rep.kneesOut : o.kneesOut,
      shiftR: p.shiftR || 0, feet: p.feet || FEET0, arm: p.arm || armFor(o.armStyle, thM),
    };
  }

  // интервалы «стоит выпрямившись» (θ = 0, без помех)
  const standingIntervals = [];
  for (const s of segs) {
    if (s.t1 <= s.t0 || !(s.kind === 'stand' || (s.kind === 'top' && !(s.rep && s.rep.noLockout)))) continue;
    const last = standingIntervals[standingIntervals.length - 1];
    if (last && Math.abs(last.tEnd - ms(s.t0)) < 0.2) last.tEnd = ms(s.t1);
    else standingIntervals.push({ tStart: ms(s.t0), tEnd: ms(s.t1) });
  }

  // покачивание тела: сумма трёх синусов 0,1–0,5 Гц (амплитуда sway — на уровне головы)
  const swayW = [0.6, 0.3, 0.1].map((a) => ({ a, fr: rSway.range(0.1, 0.5), pr: rSway.range(0, 2 * Math.PI), ff: rSway.range(0.1, 0.5), pf: rSway.range(0, 2 * Math.PI) }));
  const swayAt = (s) => {
    if (!o.sway) return null;
    let r = 0, f = 0;
    for (const w of swayW) { r += w.a * Math.sin(2 * Math.PI * w.fr * s + w.pr); f += w.a * Math.sin(2 * Math.PI * w.ff * s + w.pf); }
    return { r: o.sway * r, f: o.sway * f * 0.7 };
  };

  const N = createPoseNoise(o, rNoise);
  const frames = [], trace = o.trace ? [] : null;
  let si = 0, s = 0, lastS = null;
  const base = 1 / o.hz;
  while (s <= dur + 1e-9) {
    const drop = frames.length > 0 && rTime() < o.frameDropRate;
    if (!drop) {
      while (si < segs.length - 1 && s >= segs[si].t1) si++;
      const sg = segs[si], len = sg.t1 - sg.t0;
      const p = sg.fn(len > 0 ? clamp((s - sg.t0) / len, 0, 1) : 1, s - sg.t0);
      const st = poseOf(p, sg.rep);
      const sk = skeleton(st, B);
      const place = { x: o.offsetX, z: o.distanceM + (fin(p.dz) ? p.dz : sg.dz), yaw: o.yawDeg * RAD, sway: swayAt(s) };
      const lift = o.hipShiftM ? [st.thL, st.thR].map((a) => o.hipShiftM * Math.pow(clamp(a / 90, 0, 1.2), 2)) : null;
      const dt = lastS === null ? 0 : s - lastS;
      lastS = s;
      const lost = o.poseLossRate > 0 && rNoise() < o.poseLossRate;
      const landmarks = lost ? null : renderLandmarks(sk, place, cam, B, o, N, dt, lift);
      const tMs = ms(s);
      frames.push({ tMs, frameW: cam.frameW, frameH: cam.frameH, mirror: true, landmarks });
      if (trace) trace.push({ tMs, thighDeg: r2((st.thL + st.thR) / 2), leanDeg: r2(st.lean), kind: sg.kind, rep: sg.rep ? reps.indexOf(sg.rep) : -1 });
    }
    s += base * (1 + o.hzJitter * (2 * rTime() - 1));
  }

  const truth = { reps: truthReps, standingIntervals, events, durationMs: Math.round(dur * 1000), opts: { ...o, reps } };
  if (trace) truth.trace = trace;
  return { frames, truth };
}

// ---- одна поза (точечные тесты). state: { thighDeg | thL/thR, leanDeg?, valgus, kneesOut, armStyle, arm?,
// shiftR, feet, heightM, body, distanceM, yawDeg, offsetX, swayR, swayF }; camera: { heightM, pitchDeg,
// vFovDeg, frameW, frameH }; noise — поля шума как у simulateSquatSession (по умолчанию без шума).
function stateOf(state) {
  const x = state && typeof state === 'object' ? state : {};
  const B = bodyFor(x.heightM, x.body);
  const th = num(x.thighDeg, 0), style = x.armStyle || 'forward';
  const st = {
    thL: num(x.thL, th), thR: num(x.thR, th), valgus: num(x.valgus, 0), kneesOut: num(x.kneesOut, 0),
    shiftR: num(x.shiftR, 0), feet: Array.isArray(x.feet) ? x.feet : FEET0, arm: x.arm || armFor(style, th),
  };
  st.lean = fin(x.leanDeg) ? x.leanDeg : makeAutoLean(B, style)((st.thL + st.thR) / 2);
  const place = { x: num(x.offsetX, 0), z: num(x.distanceM, 2.5), yaw: num(x.yawDeg, 0) * RAD, sway: x.swayR || x.swayF ? { r: num(x.swayR, 0), f: num(x.swayF, 0) } : null };
  return { B, st, place };
}

export function synthPoseAt(state = {}, camera = {}, noise = {}, rng = makeRng(1)) {
  const { B, st, place } = stateOf(state);
  const o = { ...SIM_DEFAULTS, ...IDEAL, ...(noise && typeof noise === 'object' ? noise : {}) };
  const lift = o.hipShiftM ? [st.thL, st.thR].map((a) => o.hipShiftM * Math.pow(clamp(a / 90, 0, 1.2), 2)) : null;
  return renderLandmarks(skeleton(st, B), place, cameraOf(camera), B, o, createPoseNoise(o, rng), 0, lift);
}

/** Без шума: точки в 3D (м, X вправо в кадре, Y вверх, Z от камеры) и в кадре, истинные углы колен и корпуса. */
export function poseGeometry(state = {}, camera = {}) {
  const { B, st, place } = stateOf(state);
  const cam = cameraOf(camera), sk = skeleton(st, B);
  const world = {}, image = {};
  for (const [i, p] of Object.entries(sk.P)) {
    const w = toWorld(p, place, B.H), q = project(w, cam);
    world[i] = w;
    image[i] = { x: q.x, y: q.y, zc: q.zc, inFrame: q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 };
  }
  return { world, image, kneeDeg: sk.legs.map(kneeAngle), thighDeg: [st.thL, st.thR], leanDeg: st.lean, body: B };
}

/** Истинный угол колена (3D) при θ бедра (стоя лицом, без ошибок техники). */
export function kneeForThigh(thighDeg, heightM = 1.75) {
  const g = poseGeometry({ thighDeg, heightM });
  return (g.kneeDeg[0] + g.kneeDeg[1]) / 2;
}
