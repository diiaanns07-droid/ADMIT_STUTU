// ASHEN OATH — [W4-ПОЗЫ] выразительные движения героев поверх клипов KayKit (modules/heroModel.js).
// Только CPU-смешивание костей нормализованного скелета: ни материалов, ни источников света, ни проходов,
// ни аллокаций в кадре (все векторы — заранее). Всё масштабируется по settings.quality:
//   low    — дыхание, взгляд, каст-позы рук и корпуса; таз и ноги не трогаем, лицо не двигается;
//   medium — + смена опорной ноги и выпады (IK двух костей ног: стопы стоят на месте), мимика;
//   high   — + «живые» пальцы и мелкая дрожь заряда, плечи «дышат» отдельно.
//
// Слои — heroModel.update зовёт по порядку:
//   body(ctx) — после applyLife, до позы лука/посоха: таз (контрапост, присед выпада, колено поражения),
//               ноги (IK: стопа — где была в клипе, плюс шаг свободной ногой), корпус, плечи, голова
//               (взгляд на Регента / в камеру витрины), дыхание (после каста — глубже и чаще);
//   arms(ctx) — после applyPose: руки каст-поз (IK двух костей «дельтой» от позы клипа — без рывков и
//               без потери кручения), кисти (пальцы и большой палец по осям героя), рука на поясе;
//   fingers(want) — пожелания пальцев (раскрыта, «когти», «OK», указательный, кулак) поверх handWants;
//   face      — мимика (rigFace): брови и уголки рта — кости-дети головы, вершины лица привязаны к ним
//               (морфов и костей лица у моделей Quaternius нет; шейдер скиннинга берёт кости из текстуры —
//               новых программ нет), веки — шторки heroGear (прищур).
// Действия: каст-позы на события боя — щит (выпад ладонью), «OK»-снаряд (резкий жест кистью), выброс
// (замах и раскрытие), сфера (лепка двумя руками), «Врата бури» (руки в стороны), «Столп небес» (вверх и
// вниз), «Небесный суд» (руки к небу, на ударе — приговор вниз); вздрагивание при ранении, победа и
// поражение (колено). Переходы — 0,12–0,2 с (smoothstep), между действиями — перекрёстно.
// Витрина меню: позы-«визитки» signaturePose(id) — своя у каждого героя (setSignature в heroModel).
//
// Оси героя (как в heroModel): +z — вперёд, +x — влево героя, +y — вверх. Цели рук — от своего плеча,
// в длинах руки, в «боковых» осях: o — наружу (у левой +x, у правой −x), u — вверх, f — вперёд.

import { HERO_SPELL_POSE } from '../core/handMagic.js';
import { termsLow, termsLowSide, kneeMayTouch } from './vrmKit.js';   // [W5-ПОЛ] нижняя точка подошвы, колена и голени (точки сетки ног)

export const POSES_VERSION = 'W4-poses-1';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const smooth01 = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const EASE = {
  lin: (x) => x,
  io: smooth01,
  out: (x) => 1 - (1 - x) * (1 - x) * (1 - x),
  in: (x) => x * x,
  // удар: быстрый старт и мягкая остановка (пик скорости — 2/T: кисть не «телепортируется»)
  out2: (x) => 1 - (1 - x) * (1 - x),
};

// ---------------------------------------------------------------- вектор позы
// Корпус и ноги — добавки к позе клипа (0 — без изменений); руки — абсолютные цели с весом.
let _n = 0;
const I = {};
for (const k of ['HX', 'HY', 'HZ', 'HR', 'HYW', 'HP', 'SP', 'SY', 'SR', 'CP', 'CY', 'CR', 'NP', 'NY', 'EP', 'EY', 'ER', 'SHL', 'SHR',
  'FLX', 'FLY', 'FLZ', 'FRX', 'FRY', 'FRZ', 'FLP', 'FRP', 'FLYW', 'FRYW']) I[k] = _n++;
const ARM = ['W', 'O', 'U', 'F', 'PO', 'PU', 'PF', 'DO', 'DU', 'DF', 'TO', 'TU', 'TF', 'HW'];
const AL = _n; _n += ARM.length;
const AR = _n; _n += ARM.length;
for (const k of ['SMILE', 'FROWN', 'BROW', 'SQUINT', 'PAIN']) I[k] = _n++;
const FING = ['open', 'claw', 'grip', 'ok', 'point', 'soft'];
const FL = _n; _n += FING.length;
const FR = _n; _n += FING.length;
I.SDO = _n++; I.SDU = _n++; I.SDF = _n++;   // древко посоха в правой (боковые оси правой руки)
I.ACT = _n++;     // насколько действие владеет телом (гасит слой покоя)
I.LEG = _n++;     // вес IK ног действия (колено, широкая стойка)
const N = _n;
const BODY_END = AL;
export const POSE_LAYOUT = Object.freeze({ N, I: Object.freeze({ ...I }), AL, AR, FL, FR, ARM: Object.freeze(ARM.slice()), FING: Object.freeze(FING.slice()) });

// поза из описания: { hx, sp, …, L: { w, at: [o,u,f], pole: [o,u,f], dir: [o,u,f], thumb: [o,u,f], hw }, R: {…},
//   fL: { open: 1 }, fR: {…}, smile, frown, brow, squint, pain, act, leg }
const ARM_DEF = { w: 0, at: [0.15, -0.9, 0.2], pole: [0.6, -0.4, -0.7], dir: [0, -1, 0.2], thumb: [0, 0, 1], hw: 0 };
function pose(d = {}) {
  const v = new Float32Array(N);
  const body = { hx: 'HX', hy: 'HY', hz: 'HZ', hr: 'HR', hyw: 'HYW', hp: 'HP', sp: 'SP', sy: 'SY', sr: 'SR', cp: 'CP', cy: 'CY', cr: 'CR', np: 'NP', ny: 'NY', ep: 'EP', ey: 'EY', er: 'ER', shl: 'SHL', shr: 'SHR',
    flx: 'FLX', fly: 'FLY', flz: 'FLZ', frx: 'FRX', fry: 'FRY', frz: 'FRZ', flp: 'FLP', frp: 'FRP', flyw: 'FLYW', fryw: 'FRYW',
    smile: 'SMILE', frown: 'FROWN', brow: 'BROW', squint: 'SQUINT', pain: 'PAIN', act: 'ACT', leg: 'LEG' };
  for (const [k, n] of Object.entries(body)) if (fin(d[k])) v[I[n]] = d[k];
  if (!('act' in d)) v[I.ACT] = 1;
  const sd = d.staff || [0.06, 1, 0.16];
  v[I.SDO] = sd[0]; v[I.SDU] = sd[1]; v[I.SDF] = sd[2];
  for (const [side, base] of [['L', AL], ['R', AR]]) {
    const a = { ...ARM_DEF, ...(d[side] || {}) };
    if (d[side] && !('w' in d[side])) a.w = 1;
    if (d[side] && !('hw' in d[side])) a.hw = a.w;
    v[base] = a.w;
    v.set(a.at, base + 1); v.set(a.pole, base + 4); v.set(a.dir, base + 7); v.set(a.thumb, base + 10);
    v[base + 13] = a.hw;
  }
  for (const [side, base] of [['fL', FL], ['fR', FR]]) {
    const f = d[side];
    if (f) FING.forEach((k, i) => { if (fin(f[k])) v[base + i] = f[k]; });
  }
  return v;
}
const ZERO = (() => { const z = pose(); z[I.ACT] = 0; return z; })();
// списки для циклов кадра — заранее (без литералов-массивов в каждом кадре)
const ARM_BASES = Object.freeze([AL, AR]);
const FINGER_SIDES = Object.freeze([Object.freeze([AL, FL, 'left']), Object.freeze([AR, FR, 'right'])]);
const FACE_KEYS = Object.freeze(['smile', 'frown', 'brow', 'pain']);
const rotXYZ = (b, x, y, z) => { if (!b) return; if (x) b.rotateX(x); if (y) b.rotateY(y); if (z) b.rotateZ(z); };
const STAFF_I = [I.SDO, I.SDU, I.SDF];

// Смешивание: корпус/лицо/пальцы — линейно; руки — линейно, но где у одной стороны вес 0, цели берутся
// у другой (иначе кисть «проезжала» бы через случайную точку, пока вес растёт).
function mix(out, a, b, k) {
  if (k <= 0) { out.set(a); return out; }
  if (k >= 1) { out.set(b); return out; }
  for (let i = 0; i < N; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  for (const base of ARM_BASES) {
    const wa = a[base], wb = b[base];
    if (wa < 1e-3 && wb >= 1e-3) for (let j = 1; j < 13; j++) out[base + j] = b[base + j];
    else if (wb < 1e-3 && wa >= 1e-3) for (let j = 1; j < 13; j++) out[base + j] = a[base + j];
  }
  return out;
}

// Ключи действия: [время, поза, сглаживание до этого ключа]
function track(keys, t, out) {
  if (t <= keys[0][0]) { out.set(keys[0][1]); return out; }
  for (let i = 1; i < keys.length; i++) {
    const [t1, p1, e] = keys[i];
    if (t <= t1) {
      const [t0, p0] = keys[i - 1];
      return mix(out, p0, p1, (EASE[e] || EASE.io)((t - t0) / Math.max(1e-4, t1 - t0)));
    }
  }
  out.set(keys[keys.length - 1][1]);
  return out;
}

// ---------------------------------------------------------------- библиотека поз
// Общие кисти: ладонь от себя (щит), ладонь вверх (сфера), ладони друг к другу, ладонь наружу
const PALM_OUT = { dir: [0.05, 1, 0.18], thumb: [-1, 0, 0] };            // пальцы вверх, ладонь вперёд
const PALM_UP = { dir: [-0.15, 0.1, 1], thumb: [1, 0.2, 0] };             // пальцы вперёд, ладонь вверх
const PALM_IN = { dir: [-0.1, 0.25, 1], thumb: [0, 1, 0] };               // пальцы вперёд, ладонь внутрь
const PALM_SIDE = { dir: [0.35, 1, 0.05], thumb: [0, 0.1, 1] };           // пальцы вверх, ладонь наружу
const PALM_SKY = { dir: [0.12, 1, 0.12], thumb: [-0.5, 0, -1] };          // руки к небу, ладони вперёд-вверх
const PALM_DOWN = { dir: [0.1, -0.15, 1], thumb: [-1, -0.1, 0] };         // пальцы вперёд, ладонь вниз
const PRAY = { dir: [-0.2, 1, 0.35], thumb: [-0.2, 0.25, -1] };           // ладони сомкнуты, пальцы вверх
const P_ELB_DOWN = [0.55, -0.8, -0.2], P_ELB_OUT = [1, -0.25, -0.35], P_ELB_BACK = [0.4, -0.5, -1];
const OPEN = { open: 1 }, CLAW = { claw: 1 }, SOFT = { soft: 1 }, FIST = { grip: 1 };

// при посохе в правой — правая держит его (кулак); цели правой руки у посоха свои
const POSES = {
  // щит: уверенный выпад ладонью — левая вперёд, ладонь от себя; корпус левым плечом вперёд, присед
  shieldPrep: pose({ staff: [0.1, 1, -0.05], hy: -0.03, cy: -0.12, sp: 0.04, L: { at: [0.1, -0.2, 0.42], pole: P_ELB_DOWN, ...PALM_OUT }, fL: SOFT, R: { at: [0.18, -0.72, 0.12], pole: P_ELB_BACK, dir: [0, -1, 0.3], thumb: [0, 0, 1] }, fR: SOFT, frown: 0.4, squint: 0.2 }),
  shield: pose({ staff: [0.12, 1, -0.12], hy: -0.06, hz: 0.05, sp: 0.1, cy: -0.3, cr: 0.03, ep: 0.05, ey: 0.12, flz: 0.1, frz: -0.06, leg: 1,
    L: { at: [0.06, 0.02, 0.96], pole: P_ELB_DOWN, ...PALM_OUT }, fL: OPEN,
    R: { at: [0.2, -0.62, -0.05], pole: P_ELB_BACK, dir: [0.1, -1, 0.35], thumb: [0, 0, 1] }, fR: SOFT, frown: 0.55, squint: 0.25 }),
  // «OK»-снаряд: кисть у плеча → резкий выброс вперёд со щелчком запястья
  okPrep: pose({ staff: [0, 1, 0.3], cy: 0.08, R: { at: [0.06, 0.08, 0.42], pole: P_ELB_DOWN, dir: [0, 1, 0.35], thumb: [-1, 0.2, 0] }, fR: { ok: 1 }, frown: 0.3 }),
  okStrike: pose({ staff: [0, 0.55, 1], cy: 0.22, sp: 0.05, ey: -0.08, hz: 0.02, R: { at: [0.02, 0.07, 0.98], pole: P_ELB_DOWN, dir: [0.05, 0.25, 1], thumb: [-1, 0.3, 0] }, fR: { point: 0.6, open: 0.4 }, frown: 0.45, squint: 0.2 }),
  // выброс: замах (руки к бёдрам, корпус сжат) → раскрытие (руки вперёд и в стороны, ладони от себя)
  burstWind: pose({ staff: [0.1, 1, -0.25], hy: -0.05, hz: -0.03, sp: -0.06, cp: -0.12, ep: 0.12, L: { at: [0.22, -0.66, -0.18], pole: P_ELB_BACK, dir: [0, -1, -0.2], thumb: [0, 0, 1] }, fL: FIST,
    R: { at: [0.22, -0.66, -0.18], pole: P_ELB_BACK, dir: [0, -1, -0.2], thumb: [0, 0, 1] }, fR: FIST, frown: 0.7, squint: 0.35 }),
  burstOpen: pose({ staff: [0.4, 1, 0.3], hy: -0.03, hz: 0.06, sp: 0.12, cp: 0.08, ep: -0.06, flz: 0.08, leg: 1,
    L: { at: [0.42, 0.1, 0.86], pole: P_ELB_OUT, dir: [0.35, 0.75, 0.55], thumb: [-1, 0, 0] }, fL: OPEN,
    R: { at: [0.42, 0.1, 0.86], pole: P_ELB_OUT, dir: [0.35, 0.75, 0.55], thumb: [-1, 0, 0] }, fR: OPEN, frown: 0.35, brow: 0.3 }),
  // сфера: лепка двумя руками — база (кисти считаются вживую вокруг центра сферы)
  sculpt: pose({ staff: [0.6, 1, 0.15], hy: -0.02, sp: 0.07, cp: 0.04, ep: 0.2, L: { at: [-0.2, -0.32, 0.6], pole: P_ELB_DOWN, ...PALM_IN }, fL: { claw: 0.5, soft: 0.5 },
    R: { at: [-0.2, -0.32, 0.6], pole: P_ELB_DOWN, ...PALM_IN }, fR: { claw: 0.5, soft: 0.5 }, frown: 0.5, squint: 0.25 }),
  // бросок сферы: обе ладони толкают вперёд
  sphereThrow: pose({ staff: [0, 0.8, 0.6], hz: 0.05, sp: 0.1, cp: 0.06, ep: 0.0, flz: 0.06, leg: 1, L: { at: [-0.08, -0.06, 1.0], pole: P_ELB_DOWN, ...PALM_OUT }, fL: OPEN,
    R: { at: [-0.08, -0.06, 1.0], pole: P_ELB_DOWN, ...PALM_OUT }, fR: OPEN, brow: 0.3 }),
  // заряд печати: ладони сомкнуты у груди, голова склонена
  pray: pose({ hy: -0.015, sp: 0.05, ep: 0.26, L: { at: [-0.27, -0.46, 0.4], pole: P_ELB_DOWN, ...PRAY }, fL: { soft: 0.4, open: 0.6 },
    R: { at: [-0.27, -0.46, 0.4], pole: P_ELB_DOWN, ...PRAY }, fR: { soft: 0.4, open: 0.6 }, frown: 0.6, squint: 0.4, staff: [0.75, 1, 0.15] }),
  // «Врата бури»: руки разлетаются в стороны, грудь раскрыта, подбородок вверх
  gate: pose({ staff: [0.65, 1, 0.05], hy: -0.03, sp: -0.05, cp: -0.16, ep: -0.3, flx: 0.05, frx: -0.05, leg: 1,
    L: { at: [0.97, 0.14, 0.2], pole: [0, -0.6, -1], ...PALM_SIDE }, fL: OPEN, R: { at: [0.97, 0.14, 0.2], pole: [0, -0.6, -1], ...PALM_SIDE }, fR: OPEN, brow: 0.55, smile: 0.1 }),
  // «Столп небес»: правая — в небо, левая — к земле
  pillar: pose({ staff: [0, 1, 0.06], hy: -0.04, sp: -0.04, cp: -0.12, cr: 0.06, ep: -0.4, er: 0.04, leg: 1,
    R: { at: [0.06, 0.98, 0.12], pole: [1, 0, -0.4], dir: [0.05, 1, 0.08], thumb: [-1, 0, -0.3] }, fR: OPEN,
    L: { at: [0.26, -0.9, 0.24], pole: [0.4, 0.2, -1], dir: [0.15, -0.8, 0.55], thumb: [-1, 0, 0.1] }, fL: OPEN, brow: 0.5 }),
  // «Небесный суд»: руки к небу, грудь выгнута; приговор — ладони вниз-вперёд
  skyPrep: pose({ staff: [0, 1, 0.2], hy: -0.03, sp: 0.04, ep: 0.12, L: { at: [0.06, -0.38, 0.46], pole: P_ELB_DOWN, ...PALM_UP }, fL: SOFT, R: { at: [0.06, -0.38, 0.46], pole: P_ELB_DOWN, ...PALM_UP }, fR: SOFT, frown: 0.3 }),
  sky: pose({ staff: [0.05, 1, 0.05], hz: 0.03, sp: -0.08, cp: -0.2, ep: -0.6, L: { at: [0.34, 0.92, 0.16], pole: [1, 0, -0.3], ...PALM_SKY }, fL: OPEN, R: { at: [0.34, 0.92, 0.16], pole: [1, 0, -0.3], ...PALM_SKY }, fR: OPEN, brow: 0.6, smile: 0.25 }),
  verdict: pose({ staff: [0, 0.35, 1], hy: -0.06, hz: 0.06, sp: 0.16, cp: 0.08, ep: 0.05, flz: 0.1, leg: 1, L: { at: [0.16, 0.0, 0.96], pole: P_ELB_DOWN, ...PALM_DOWN }, fL: OPEN,
    R: { at: [0.16, 0.0, 0.96], pole: P_ELB_DOWN, ...PALM_DOWN }, fR: OPEN, frown: 0.6, squint: 0.2 }),
  // магия ладони: правая кисть перед грудью держит сгусток (форма — по стихии, HERO_SPELL_POSE), левая — у пояса
  orbHold: pose({ staff: [0.2, 1, 0.05], sp: 0.04, cy: 0.12, ep: 0.12, ey: -0.08, R: { at: [-0.12, -0.36, 0.56], pole: P_ELB_DOWN, ...PALM_UP }, fR: OPEN,
    L: { at: [0.16, -0.62, 0.22], pole: P_ELB_OUT, dir: [0.2, -0.5, 0.85], thumb: [0, 0.3, 1] }, fL: SOFT, frown: 0.45, squint: 0.2 }),
  orbThrow: pose({ staff: [0, 0.6, 1], hz: 0.05, sp: 0.1, cy: 0.26, ep: 0.0, flz: 0.07, leg: 1, R: { at: [-0.02, 0.05, 1.0], pole: P_ELB_DOWN, ...PALM_OUT }, fR: OPEN,
    L: { at: [0.3, -0.55, -0.05], pole: P_ELB_BACK, dir: [0.1, -1, 0.3], thumb: [0, 0, 1] }, fL: SOFT, brow: 0.25 }),
  // поражение: на колено, корпус склонён, рука на колене
  kneel: pose({ staff: [0.05, 1, 0.25], hy: -0.42, hz: -0.04, sp: 0.32, cp: 0.12, ep: 0.78, er: 0.06, flz: 0.34, fly: 0.0, frz: -0.38, fry: 0.06, frp: 0.9, leg: 1,
    L: { at: [0.02, -0.66, 0.58], pole: [1, -0.3, 0.2], dir: [0, -0.7, 0.7], thumb: [-1, 0, 0] }, fL: SOFT,
    R: { at: [0.28, -0.98, 0.18], pole: [0.6, 0.3, -1], dir: [0.1, -1, 0.3], thumb: [0, 0, 1] }, fR: SOFT, pain: 0.55, squint: 0.4 }),
  stagger: pose({ staff: [0.15, 1, 0], hz: -0.06, sp: -0.12, cp: -0.1, ep: -0.14, L: { at: [0.34, -0.55, 0.3], pole: P_ELB_OUT, dir: [0.2, -0.6, 0.8], thumb: [0, 0.2, 1] }, fL: SOFT,
    R: { at: [0.34, -0.55, 0.3], pole: P_ELB_OUT, dir: [0.2, -0.6, 0.8], thumb: [0, 0.2, 1] }, fR: SOFT, pain: 1, squint: 0.7 }),
};

// Победа: посох/лук к небу, подбородок вверх; затем — гордая стойка (кулак у груди / лук у плеча)
function victoryPoses(kind) {
  const bow = kind === 'bow';
  const raise = bow
    ? pose({ sp: -0.05, cp: -0.14, ep: -0.4, er: 0.05, L: { at: [0.18, 0.96, 0.14], pole: [1, 0, -0.3], dir: [0, 1, 0.1], thumb: [0, 0.2, 1] }, fL: FIST, R: { at: [0.28, -0.5, 0.42], pole: P_ELB_OUT, dir: [0, 0.4, 1], thumb: [0, 1, 0] }, fR: FIST, smile: 1, brow: 0.3 })
    : pose({ staff: [0.02, 1, 0.08], sp: -0.05, cp: -0.14, ep: -0.4, er: -0.05, R: { at: [0.16, 0.95, 0.14], pole: [1, 0, -0.3], dir: [-0.1, 0.2, 1], thumb: [0, 1, 0.1] }, fR: FIST, L: { at: [-0.12, -0.4, 0.4], pole: P_ELB_OUT, dir: [-0.6, 0.6, 0.4], thumb: [0, 1, 0] }, fL: FIST, smile: 1, brow: 0.3 });
  const proud = bow
    ? pose({ hx: 0.03, hr: 0.05, cr: -0.04, sp: -0.03, ep: -0.1, er: -0.06, flz: 0.06, flyw: -0.25, leg: 1, L: { at: [0.16, -0.18, 0.32], pole: [0.5, -1, 0.1], dir: [-0.45, 0.1, 1], thumb: [0.05, 1, 0.1] }, fL: FIST, R: HIP_R, fR: SOFT, smile: 0.8, brow: 0.25 })
    : pose({ staff: [0.08, 1, 0.12], sp: -0.03, ep: -0.1, R: { at: [0.18, -0.48, 0.42], pole: P_ELB_OUT, dir: [-0.1, -0.15, 1], thumb: [0, 1, 0.1] }, fR: FIST, L: { at: [-0.18, -0.36, 0.34], pole: P_ELB_OUT, dir: [-0.7, 0.55, 0.4], thumb: [0, 1, 0] }, fL: FIST, smile: 0.8, brow: 0.25 });
  return { raise, proud };
}
// рука на поясе: запястье на гребне таза, локоть наружу-назад, пальцы вперёд-вниз
const HIP_L = { at: [0.02, -0.52, -0.02], pole: [1, 0.15, -0.6], dir: [-0.5, -0.55, 0.6], thumb: [0, 0.2, -1], w: 1, hw: 0.9 };
const HIP_R = { ...HIP_L };

// ---------------------------------------------------------------- позы-визитки витрины меню
// stance — клип-основа (heroModel.setStance); bow — лук в руке (rest — у плеча, draw — натянут);
// orb — ладонь со сферой/бурей (для эффекта витрины №5: якорь handL/handR); look — взгляд в камеру
export const SIGNATURES = Object.freeze({
  ashen: Object.freeze({ id: 'ashen', title: 'Страж с посохом-клинком', stance: 'Stance', bow: null, orb: null, mood: 'resolve',
    text: 'Посох-клинок наискось перед собой, вторая рука на древке; широкая стойка.' }),
  elf: Object.freeze({ id: 'elf', title: 'Лук у плеча', stance: 'IdleCalm', bow: 'rest', orb: null, mood: 'gentle',
    text: 'Лук стоит у плеча в левой руке, правая на поясе; контрапост, голова чуть склонена к камере.' }),
  dark: Object.freeze({ id: 'dark', title: 'Посох и сфера', stance: 'IdleCalm', bow: null, orb: Object.freeze({ hand: 'L', kind: 'orb' }), mood: 'mystery',
    text: 'Посох опущен в правой, на раскрытой левой ладони парит сфера; взгляд исподлобья.' }),
  ranger: Object.freeze({ id: 'ranger', title: 'Натянутый лук', stance: 'IdleCalm', bow: 'draw', orb: null, mood: 'focus',
    text: 'Медленно натягивает тетиву, держит прицел и отпускает — дыхание в такт.' }),
  archmage: Object.freeze({ id: 'archmage', title: 'Буря в ладони', stance: 'Idle', bow: null, orb: Object.freeze({ hand: 'L', kind: 'storm' }), mood: 'power',
    text: 'Левая ладонь вскинута — в ней буря; посох у бедра, взгляд на ладонь и в камеру.' }),
});
export function signaturePose(id) { return SIGNATURES[id] || null; }

function signatureBase(id, female) {
  void female;
  switch (id) {
    case 'ashen': // посох-клинок наискось: правая у бедра, левая выше по древку (точка древка — вживую)
      return pose({ staff: [-0.5, 1, 0.28], hy: -0.035, sp: 0.02, cy: 0.12, ep: 0.08, ey: -0.1, flx: 0.06, frx: -0.06, flz: 0.04, leg: 1,
        R: { at: [-0.04, -0.6, 0.4], pole: P_ELB_OUT, dir: [-0.85, 0.15, 0.5], thumb: [-0.35, 0.9, 0.3] }, fR: FIST,
        L: { at: [-0.3, -0.18, 0.5], pole: P_ELB_DOWN, dir: [-0.6, 0.3, 0.75], thumb: [-0.35, 0.9, 0.3] }, fL: FIST, frown: 0.25, act: 0.6 });
    case 'elf': // лук у плеча: левая согнута, кулак у плеча, лук вертикально; правая на поясе
      return pose({ hx: 0.035, hr: 0.07, hyw: 0.08, cr: -0.06, cy: 0.06, ep: 0.04, er: -0.1, frz: 0.07, frx: 0.02, fryw: -0.35, leg: 1,
        L: { at: [0.14, -0.2, 0.3], pole: [0.5, -1, 0.1], dir: [-0.45, 0.1, 1], thumb: [0.05, 1, 0.1] }, fL: FIST,
        R: HIP_R, fR: SOFT, smile: 0.45, act: 0.6 });
    case 'dark': // посох опущен в правой, сфера на левой ладони перед грудью
      return pose({ staff: [0.06, 1, 0.04], hx: -0.03, hr: -0.06, hyw: -0.06, cr: 0.05, cy: -0.1, ep: 0.12, er: 0.08, flz: 0.07, flyw: 0.3, leg: 1,
        R: { at: [0.3, -0.84, 0.18], pole: P_ELB_OUT, dir: [0.1, -0.15, 1], thumb: [0, 1, 0.05] }, fR: FIST,
        L: { at: [-0.06, -0.3, 0.62], pole: P_ELB_DOWN, ...PALM_UP }, fL: { soft: 0.6, claw: 0.4 }, smile: 0.15, frown: 0.15, act: 0.6 });
    case 'ranger': // лук натянут (руки ведёт поза лука heroModel) — здесь только стойка и лицо
      return pose({ hy: -0.02, flz: 0.08, flx: 0.03, frx: -0.04, leg: 1, frown: 0.3, squint: 0.3, act: 0.35 });
    case 'archmage': // буря в ладони: левая вперёд-вверх ладонью вверх, посох у бедра
      return pose({ staff: [0.06, 1, 0.04], hy: -0.02, cy: -0.08, cp: -0.04, ep: -0.08, ey: 0.16, flz: 0.06, leg: 1,
        L: { at: [0.2, -0.16, 0.72], pole: P_ELB_DOWN, dir: [0.25, 0.15, 1], thumb: [1, 0.45, -0.2] }, fL: { claw: 0.55, soft: 0.45 },
        R: { at: [0.3, -0.84, 0.16], pole: P_ELB_OUT, dir: [0.1, -0.15, 1], thumb: [0, 1, 0.05] }, fR: FIST, brow: 0.3, smile: 0.1, act: 0.6 });
    default: return pose({ act: 0.3 });
  }
}
// жест визитки (витрина раз в 10–16 с, heroShowcase зовёт flourish): [ключи] поверх базы
function signatureGesture(id, base) {
  const P = (d) => { const v = new Float32Array(base); const add = pose(d); for (let i = 0; i < BODY_END; i++) v[i] += add[i]; for (const k of ['SMILE', 'BROW', 'FROWN']) v[I[k]] = add[I[k]] || v[I[k]]; for (const sb of [[AL, 'L'], [AR, 'R']]) if (d[sb[1]]) v.set(add.subarray(sb[0], sb[0] + ARM.length), sb[0]); if (d.fL) v.set(add.subarray(FL, FL + FING.length), FL); if (d.fR) v.set(add.subarray(FR, FR + FING.length), FR); if (d.staff) for (const k of STAFF_I) v[k] = add[k]; return v; };
  switch (id) {
    case 'ashen': { const up = P({ staff: [0.02, 1, 0.06], cp: -0.1, ep: -0.28, R: { at: [0.12, 0.92, 0.2], pole: [1, 0, -0.3], dir: [-0.1, 0.2, 1], thumb: [0, 1, 0.1] }, fR: FIST, L: { at: [-0.15, -0.38, 0.38], pole: P_ELB_OUT, dir: [-0.7, 0.55, 0.4], thumb: [0, 1, 0] }, fL: FIST, smile: 0.3, brow: 0.4 });
      return [[0, base], [0.45, up, 'out'], [1.6, up], [2.3, base, 'io']]; }
    case 'elf': { const tilt = P({ er: 0.15, ep: -0.03, smile: 0.9, L: { at: [0.16, 0.0, 0.34], pole: [0.5, -1, 0.1], dir: [-0.35, 0.25, 1], thumb: [0.15, 1, 0.05] }, fL: FIST });
      return [[0, base], [0.6, tilt, 'io'], [1.9, tilt], [2.6, base, 'io']]; }
    case 'dark': { const raise = P({ ep: -0.06, L: { at: [-0.02, 0.05, 0.7], pole: P_ELB_DOWN, ...PALM_UP }, fL: CLAW, brow: 0.2, smile: 0.4 });
      return [[0, base], [0.55, raise, 'out'], [1.7, raise], [2.4, base, 'io']]; }
    case 'archmage': { const flare = P({ cp: -0.12, ep: -0.32, L: { at: [0.18, 0.62, 0.62], pole: P_ELB_DOWN, dir: [-0.1, 0.6, 0.8], thumb: [1, 0.3, 0] }, fL: OPEN, brow: 0.5 });
      return [[0, base], [0.4, flare, 'out2'], [1.4, flare], [2.1, base, 'io']]; }
    default: return null;
  }
}

// ---------------------------------------------------------------- слой поз героя
// rig: { bones (нормализованные, + ноги), hands (heroModel.setupHands), model, vrm, orientHand(h, dir, thumb, w),
//        female, staff: () => bool, bowRest: () => bool, soles? } — [W5-ПОЛ] soles: точки подошвы и колена (vrmKit.soleMarkers)
export function createHeroPoses(THREE, { quality = 'medium', heroId = 'ashen', female = false, stance = 'staff' } = {}) {
  const V = () => new THREE.Vector3();
  const Q = () => new THREE.Quaternion();
  const _qm = Q(), _qmi = Q(), _q = Q(), _q1 = Q(), _pq = Q(), _qf = Q();
  const _p = V(), _s = V(), _a = V(), _b = V(), _c = V(), _d = V(), _m = V(), _t = V(), _u = V(), _w = V(), _o = V(), _o2 = V();
  const footW = [V(), V()], footQ = [Q(), Q()], kneeW = [V(), V()], hipW = [V(), V()];
  const _ia = V(), _ib = V(), _ic = V(), _id = V(), _im = V(), _it = V(), _iu = V(), _iw = V();   // только для ik2
  const _sp = V(), _qF = Q();   // [W5-ПОЛ] точка подошвы; поворот стопы в мире (ik2 пишет в общий _q)
  const footT = [V(), V()], poleU = [V(), V()], footR = [Q(), Q()], _kr = new Float64Array(3);   // [W5-ПОЛ] цели ног — для колена
  // aout — смесь слоя действий (перекрёст только по нему: иначе смещения покоя в первом кадре удвоились бы),
  // out — итог кадра (действие + покой + вздрагивание)
  const out = new Float32Array(N), aout = new Float32Array(N), act = new Float32Array(N), idle = new Float32Array(N), prev = new Float32Array(N);
  const st = {
    q: quality, hero: heroId, female, stance,
    a: null, at: 0, fade: 1, fadeDur: 0.15, prevSet: false,   // текущее действие, его время, перекрёст
    ws: 0, wsFrom: 0, wsTo: 1, wsT: 1, wsNext: 3, wsDur: 1.4,   // смена опорной ноги: −1 — на правой, +1 — на левой
    exert: 0, breathPh: 0,                                       // одышка после кастов
    hit: 0, hitDir: 0, blockK: 0,                                 // вздрагивание, отдача щита
    expr: { smile: 0, frown: 0, brow: 0, squint: 0, pain: 0 }, smileT: 0, smileCool: 0,
    sig: null, sigBase: null, sigG: null, sigT: 0, gesture: null, gestureT: 0,
    lookY: 0, lookP: 0, lookR: 0, glance: 0,
    ms: 0, msAvg: 0, legOk: true, faceOk: true,
    ult: null, victory: null, defeat: null, lastStatus: '',
  };
  let rig = null;
  const _ew = { smile: 0, frown: 0, brow: 0, squint: 0, pain: 0 };
  let rigArms = null, rigLegs = null;   // кости рук и ног — один раз на героя

  // на low ноги не трогаем — кроме поражения (колено без IK ног не встанет)
  const legsOn = () => st.q !== 'low' || !!(st.a && st.a.def === ACTIONS.defeat);
  const faceOn = () => st.q !== 'low';
  const fineOn = () => st.q === 'high';

  // ---------------------------------------------------------------- действия
  // def: { id, keys | live(t, ctx, out), dur, hold (держится, пока hold(ctx)), enter, exit, loopFrom }
  function start(def, opt = {}) {
    if (st.a && st.a.def === def && opt.restart === false) return;
    prev.set(aout);               // перекрёст: от того, что сейчас играет слой действий
    for (let i = 0; i < N; i++) if (!Number.isFinite(prev[i])) prev[i] = 0;
    st.prevSet = true;
    st.a = { def, opt };
    st.at = opt.t0 || 0;
    st.fade = 0;
    st.fadeDur = def.enter ?? 0.15;
  }
  function stop(exit = 0.2) {
    if (!st.a) return;
    prev.set(aout);
    st.a = null; st.fade = 0; st.fadeDur = exit;
  }
  const ACTIONS = {
    shield: { id: 'shield', enter: 0.12, exit: 0.2, keys: [[0, POSES.shieldPrep], [0.07, POSES.shieldPrep], [0.27, POSES.shield, 'out2']], hold: true,
      live(t, c, v) {
        // удержание: ладонь чуть дышит, отдача от удара по щиту — толчок назад
        const b = st.blockK;
        v[AL + 3] -= 0.12 * b; v[I.HZ] -= 0.04 * b; v[I.CP] -= 0.08 * b; v[I.EP] -= 0.06 * b;
        v[AL + 2] += 0.012 * Math.sin(t * 2.1);
      } },
    ok: { id: 'ok', enter: 0.16, exit: 0.2, dur: 0.5, keys: [[0, POSES.okPrep], [0.1, POSES.okPrep], [0.22, POSES.okStrike, 'out2'], [0.4, POSES.okStrike], [0.5, POSES.okStrike]],
      live(t, c, v) {
        // щелчок залпа: кисть чуть вверх и назад и снова в цель (0,18 с)
        const f = st.flick || 0;
        if (f > 0) { const k = Math.sin(Math.PI * f); v[AR + 2] += 0.05 * k; v[AR + 3] -= 0.06 * k; v[AR + 8] += 0.5 * k; st.flick = Math.max(0, f - c.dt / 0.18); }
      } },
    burst: { id: 'burst', enter: 0.18, exit: 0.25, dur: 0.95, keys: [[0, POSES.burstWind], [0.16, POSES.burstWind, 'io'], [0.38, POSES.burstOpen, 'out2'], [0.75, POSES.burstOpen], [0.95, POSES.burstOpen]] },
    conjure: { id: 'conjure', enter: 0.16, exit: 0.2, keys: [[0, POSES.sculpt]], hold: true,
      live(t, c, v) {
        // лепка: кисти обходят сферу — одна сверху-слева, другая снизу-справа; сфера растёт с зарядом
        const ch = clamp01(c.conjure), r = 0.2 + 0.14 * ch, a = t * 1.7;
        const ca = Math.cos(a), sa = Math.sin(a);
        // центр сферы — перед грудью (в осях рук: o — к середине, цели от своего плеча)
        v[AL + 1] = -0.32 + r * (0.55 + 0.25 * ca); v[AL + 2] = -0.3 + r * 0.55 * sa; v[AL + 3] = 0.6 + 0.08 * ca;
        v[AR + 1] = -0.32 + r * (0.55 - 0.25 * ca); v[AR + 2] = -0.3 - r * 0.55 * sa; v[AR + 3] = 0.6 - 0.08 * ca;
        // ладони смотрят на центр: большие пальцы вверх/вниз по кругу
        v[AL + 11] = 0.8 * ca + 0.2; v[AL + 10] = -0.6 * sa;
        v[AR + 11] = 0.8 * ca + 0.2; v[AR + 10] = 0.6 * sa;
        v[I.SY] = 0.05 * Math.sin(a * 0.5);
        v[I.FROWN] = 0.4 + 0.3 * ch;
      } },
    sphereThrow: { id: 'sphereThrow', enter: 0.12, exit: 0.25, dur: 0.6, keys: [[0, POSES.sculpt], [0.2, POSES.sphereThrow, 'out2'], [0.45, POSES.sphereThrow], [0.6, POSES.sphereThrow]] },
    orb: { id: 'orb', enter: 0.16, exit: 0.2, keys: [[0, POSES.orbHold]], hold: true,
      live(t, c, v) {
        // форма кисти — как у игрока; сгусток крупнеет с силой — ладонь чуть отходит от груди
        const f = HERO_SPELL_POSE[c.spellEl] || HERO_SPELL_POSE.fire, pw = clamp01(c.spellPower);
        const P = f.palm === 'down' ? PALM_DOWN : f.palm === 'forward' ? PALM_OUT : PALM_UP;
        v.set(P.dir, AR + 7); v.set(P.thumb, AR + 10);
        for (let j = 0; j < FING.length; j++) v[FR + j] = 0;
        v[FR + FING.indexOf(f.fingers === 'grip' ? 'grip' : f.fingers === 'claw' ? 'claw' : 'open')] = 1;
        v[AR + 3] += 0.08 * pw; v[AR + 2] += 0.03 * pw + 0.01 * Math.sin(t * 2.4);
        // двумя руками: левая подставляет ладонь под сгусток
        if (c.spellTwo) { v[AL] = 1; v[AL + 1] = -0.26; v[AL + 2] = -0.42; v[AL + 3] = 0.52; v.set(PALM_UP.dir, AL + 7); v.set(PALM_UP.thumb, AL + 10); v[FL] = 1; v[FL + 5] = 0; }
      } },
    orbThrow: { id: 'orbThrow', enter: 0.12, exit: 0.25, dur: 0.6, keys: [[0, POSES.orbHold], [0.2, POSES.orbThrow, 'out2'], [0.45, POSES.orbThrow], [0.6, POSES.orbThrow]],
      live(t, c, v) { v[AR + 1] += 0.35 * c.throwX; v[AR + 2] += 0.3 * c.throwY; } },   // x — вправо в кадре = наружу у правой
    pray: { id: 'pray', enter: 0.16, exit: 0.15, keys: [[0, POSES.pray]], hold: true,
      live(t, c, v) {
        // заряд дрожит в ладонях: дрожь растёт с зарядом, голова склоняется ниже
        const ch = clamp01(c.sigilCharge), tr = (fineOn() ? 0.012 : 0.006) * ch;
        v[AL + 1] += tr * Math.sin(t * 41); v[AR + 1] += tr * Math.sin(t * 41 + 1.3); v[AL + 2] += tr * Math.sin(t * 37);
        v[AR + 2] += tr * Math.sin(t * 37 + 0.7);
        v[I.EP] += 0.08 * ch; v[I.HY] -= 0.015 * ch; v[I.SQUINT] = 0.3 + 0.4 * ch;
      } },
    gate: { id: 'gate', enter: 0.12, exit: 0.3, dur: 1.15, keys: [[0, POSES.pray], [0.24, POSES.gate, 'out2'], [0.85, POSES.gate], [1.15, POSES.gate]] },
    pillar: { id: 'pillar', enter: 0.12, exit: 0.32, dur: 1.2, keys: [[0, POSES.pray], [0.3, POSES.pillar, 'out2'], [0.9, POSES.pillar], [1.2, POSES.pillar]] },
    // «Небесный суд»: время — по сцене боя (snap.ultimate.t), не по dt (dt в сцене замедлен)
    ultimate: { id: 'ultimate', enter: 0.2, exit: 0.4, hold: true,
      live(t, c, v) {
        const u = c.ult;
        const ut = u ? u.t : t, sa = u && fin(u.strikeAt) ? u.strikeAt : 2.3;
        if (ut < 0.35) mix(v, POSES.skyPrep, POSES.sky, EASE.io(ut / 0.35) * 0.3);
        else if (ut < sa - 0.12) mix(v, POSES.skyPrep, POSES.sky, 0.3 + 0.7 * EASE.out((ut - 0.35) / 0.5));
        else if (ut < sa + 0.14) mix(v, POSES.sky, POSES.verdict, EASE.out2(clamp01((ut - sa + 0.12) / 0.26)));
        else v.set(POSES.verdict);
        // руки к небу «тянутся»: лёгкий подъём на вдохе
        v[AL + 2] += 0.02 * Math.sin(ut * 3); v[AR + 2] += 0.02 * Math.sin(ut * 3 + 0.4);
      } },
    victory: { id: 'victory', enter: 0.2, exit: 0.3, hold: true,
      live(t, c, v) {
        const P = st.victory || (st.victory = victoryPoses(c.bowHero ? 'bow' : 'staff'));
        if (t < 0.4) mix(v, ZERO_ACT, P.raise, EASE.out(t / 0.4));
        else if (t < 1.9) v.set(P.raise);
        else mix(v, P.raise, P.proud, EASE.io((t - 1.9) / 0.9));
        v[I.EP] -= 0.02 * Math.sin(t * 1.4);
      } },
    defeat: { id: 'defeat', enter: 0.15, exit: 0.4, hold: true,
      live(t, c, v) {
        if (t < 0.3) mix(v, ZERO_ACT, POSES.stagger, EASE.out(t / 0.3));
        else if (t < 0.55) v.set(POSES.stagger);
        else mix(v, POSES.stagger, POSES.kneel, EASE.io((t - 0.55) / 0.65));
        // тяжёлое дыхание на колене
        const k = clamp01((t - 1.2) / 0.5);
        v[I.SP] += 0.03 * k * Math.sin(t * 3.2); v[I.EP] += 0.03 * k * Math.sin(t * 3.2 + 0.5);
      } },
    signature: { id: 'signature', enter: 0.45, exit: 0.4, hold: true,
      live(t, c, v) {
        v.set(st.sigBase || ZERO);
        if (st.gesture) {
          const g = st.gesture, gt = (st.gestureT += c.dt);
          if (gt >= g[g.length - 1][0]) st.gesture = null; else track(g, gt, v);
        }
        // визитки живут: сфера на ладони чуть парит, лук у плеча покачивается с дыханием
        const s = Math.sin(t * 1.3);
        if (st.sig === 'dark' || st.sig === 'archmage') { v[AL + 2] += 0.012 * s; v[AL + 3] += 0.008 * Math.sin(t * 0.9); }
        if (st.sig === 'elf') v[AL + 2] += 0.006 * s;
        // приближение витрины (портрет): руки спокойнее, лицо — к игроку
        if (c.gaze > 0.5) { v[AL] *= 0.6; v[AR] *= 0.6; v[I.SMILE] = Math.max(v[I.SMILE], 0.5); }
      } },
  };
  const ZERO_ACT = (() => { const z = new Float32Array(ZERO); z[I.ACT] = 1; return z; })();
  const CAST_HOLDS = new Set();   // действия, под которыми не нужен застывший Cast1
  for (const a of [ACTIONS.ok, ACTIONS.burst, ACTIONS.gate, ACTIONS.pillar, ACTIONS.sphereThrow, ACTIONS.ultimate, ACTIONS.orb, ACTIONS.orbThrow]) CAST_HOLDS.add(a);

  // ---------------------------------------------------------------- события боя
  const handled = new Set(['burst', 'sigil_cast', 'shield', 'conjure', 'ultimate', 'bolt', 'throw']);
  function claims(e) {
    if (!e) return false;
    const d = e.data || {};
    if (e.type === 'burst') return true;
    if (e.type === 'sigil_cast') return d.sigil === 'gate' || d.sigil === 'pillar';
    if (e.type === 'player_cast') return d.ability === 'bolt' || d.ability === 'throw' || d.ability === 'hand_orb';
    if (e.type === 'hand_spell_throw') return true;
    return false;
  }
  function claimsHold(key, P, snap = null) {
    if (key === 'shield' || key === 'conjure') return true;
    if (key === 'cast') {
      if (P && P.sigilCharge > 0.02) return true;
      if (st.ult || (snap && snap.ultimate && snap.ultimate.active)) return true;   // и первый кадр «Небесного суда»
      if (P && P.handSpell && (P.handSpell.phase === 'form' || P.handSpell.phase === 'hold')) return true;
      return !!(st.a && CAST_HOLDS.has(st.a.def));
    }
    return false;
  }
  function recognized() {
    // «Распознано»: успешный жест — короткая уверенная улыбка (не чаще раза в 3,5 с)
    if (st.smileCool > 0) return;
    st.smileT = 0.95; st.smileCool = 3.5;
  }
  function events(list, remote = false) {
    for (const e of list) {
      if (!e) continue;
      const d = e.data || {};
      if (!!d.remote !== !!remote) continue;   // события соперника — только его модели
      switch (e.type) {
        case 'burst': start(ACTIONS.burst); st.exert = Math.min(1, st.exert + 0.45); recognized(); break;
        case 'sigil_cast':
          if (d.sigil === 'gate') start(ACTIONS.gate); else if (d.sigil === 'pillar') start(ACTIONS.pillar);
          st.exert = Math.min(1, st.exert + 0.5); recognized(); break;
        case 'player_cast':
          if (d.ability === 'bolt') {
            // залп: повтор жеста — с удара (без замаха), если прошлый ещё идёт
            // залп: рука уже вытянута — новый снаряд щелчком кисти, без возврата к плечу
            if (st.a && st.a.def === ACTIONS.ok && st.at < 0.5) { st.flick = 1; if (st.at > 0.26) st.at = 0.26; } else start(ACTIONS.ok);
            st.exert = Math.min(1, st.exert + 0.06);
          } else if (d.ability === 'throw') { start(ACTIONS.sphereThrow); st.exert = Math.min(1, st.exert + 0.3); recognized(); }
          else if (d.ability === 'spark' || d.ability === 'slash' || d.ability === 'rune') recognized();
          break;
        case 'shield_start': recognized(); break;
        case 'parry': if (d.success) recognized(); break;
        case 'hand_spell_throw':
          ctx0.throwX = d.dir && fin(d.dir.x) ? clamp(d.dir.x, -1, 1) : 0; ctx0.throwY = d.dir && fin(d.dir.y) ? clamp(d.dir.y, -1, 1) : 0;
          start(ACTIONS.orbThrow); st.exert = Math.min(1, st.exert + 0.3); recognized(); break;
        case 'perfect_dodge': case 'bow_release': recognized(); break;
        case 'block': st.blockK = 1; break;
        case 'player_hit': st.hit = 1; st.hitDir = d.direction && fin(d.direction.x) ? Math.sign(d.direction.x) || 1 : (Math.random() < 0.5 ? -1 : 1); st.smileT = 0; break;
        case 'ultimate_start': st.exert = 1; break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- кадр: что держит тело
  const ctx0 = { conjure: 0, sigilCharge: 0, ult: null, bowHero: false, gaze: 0, dt: 0, spellEl: 'fire', spellPower: 0, spellTwo: false, throwX: 0, throwY: 0 };
  function think(dt, c) {
    // c: { P, snap, status, menu, idleW, moving, bowW, spellW, mirrorW, gaze, lookTarget, camera, bowHero }
    const P = c.P;
    ctx0.dt = dt; ctx0.gaze = c.gaze || 0; ctx0.bowHero = !!c.bowHero;
    const status = c.status || 'playing';
    const dead = status === 'defeat' || !!(P && (P.action === 'dead' || P.dead));
    const u = c.snap && c.snap.ultimate && c.snap.ultimate.active ? c.snap.ultimate : null;
    st.ult = u; ctx0.ult = u;
    ctx0.conjure = P && P.conjure ? clamp01(+P.conjure.charge || 0) : 0;
    ctx0.sigilCharge = P && fin(P.sigilCharge) ? P.sigilCharge : 0;
    const hs = P && P.handSpell && (P.handSpell.phase === 'form' || P.handSpell.phase === 'hold') ? P.handSpell : null;
    if (hs) { ctx0.spellEl = hs.element || 'fire'; ctx0.spellPower = fin(hs.power) ? hs.power : 0; ctx0.spellTwo = !!hs.twoHand; }
    let want = null;
    if (c.menu) want = st.sig ? ACTIONS.signature : null;
    else if (dead) want = ACTIONS.defeat;
    else if (status === 'victory') want = ACTIONS.victory;
    else if (u) want = ACTIONS.ultimate;
    else if (P && (P.action === 'shield' || P.shielding) && c.bowW < 0.5) want = ACTIONS.shield;
    else if (P && P.conjure && P.action !== 'dash') want = ACTIONS.conjure;
    else if (ctx0.sigilCharge > 0.02) want = ACTIONS.pray;
    else if (hs && c.bowW < 0.5) want = ACTIONS.orb;
    const cur = st.a && st.a.def;
    if (want) {
      // удержание сменяет импульс сразу; импульс (выброс, печать) поверх удержания доигрывает своё
      const impulse = cur && !cur.hold && st.at < cur.dur;
      if (cur !== want && !(impulse && (want === ACTIONS.shield || want === ACTIONS.pray || want === ACTIONS.conjure || want === ACTIONS.orb))) start(want);
    } else if (cur && cur.hold) stop(cur.exit);
    else if (cur && !cur.hold && st.at >= cur.dur) stop(cur.exit);
    if (status !== st.lastStatus) { if (status !== 'victory') st.victory = null; st.lastStatus = status; }
  }

  function evalAction(dt, c) {
    if (st.a) {
      st.at += dt;
      const def = st.a.def;
      if (def.keys) track(def.keys, st.at, act); else act.set(ZERO_ACT);
      if (def.live) def.live(st.at, ctx0, act);
    } else act.set(ZERO);
    st.fade = Math.min(1, st.fade + dt / Math.max(0.04, st.fadeDur));
    mix(aout, prev, act, smooth01(st.fade));
    out.set(aout);
    void c;
  }

  // ---------------------------------------------------------------- слой покоя
  function evalIdle(dt, c) {
    idle.set(ZERO);
    const still = clamp01(c.idleW);
    // смена опорной ноги раз в 5–9 с (переход 1,4 с), у героинь — заметнее
    st.wsNext -= dt;
    if (st.wsNext <= 0 && st.wsT >= 1) { st.wsFrom = st.ws; st.wsTo = st.ws > 0 ? -1 : 1; st.wsT = 0; st.wsNext = 5 + Math.random() * 4; }
    if (st.wsT < 1) { st.wsT = Math.min(1, st.wsT + dt / st.wsDur); st.ws = st.wsFrom + (st.wsTo - st.wsFrom) * smooth01(st.wsT); }
    const s = st.ws, f = st.female ? 1 : 0.55;
    idle[I.HX] = 0.034 * s * f;
    idle[I.HR] = 0.075 * s * f;
    idle[I.HY] = -0.012 - 0.008 * Math.abs(s);
    idle[I.HYW] = 0.05 * s * f;
    idle[I.CR] = -0.05 * s * f;
    idle[I.ER] = 0.035 * s * f;
    // свободная нога: чуть вперёд и развёрнута носком наружу; переставляется с подъёмом стопы
    const freeL = clamp01(-s), freeR = clamp01(s), lift = st.wsT < 1 ? Math.sin(Math.PI * st.wsT) * 0.028 : 0;
    idle[I.FLZ] = 0.07 * freeL * f; idle[I.FLX] = -0.01 * freeL; idle[I.FLYW] = 0.32 * freeL * f; idle[I.FLY] = lift * (st.wsTo < 0 ? 1 : 0.3);
    idle[I.FRZ] = 0.07 * freeR * f; idle[I.FRX] = 0.01 * freeR; idle[I.FRYW] = -0.32 * freeR * f; idle[I.FRY] = lift * (st.wsTo > 0 ? 1 : 0.3);
    // рука на поясе у героинь (в покое дольше 1,2 с; не когда руки ведёт зеркало игрока)
    st.hipT = still > 0.9 && !c.menu && !st.a && out[I.ACT] < 0.05 && c.mirrorW < 0.3 && c.bowW < 0.1 && c.spellW < 0.1 ? (st.hipT || 0) + dt : 0;
    // рука ложится за 0,8 с после 1,2 с покоя, уходит за 0,15 с (вместе с перекрёстом действия — без рывка)
    const hipWant = st.hipT > 1.2 ? 1 : 0;
    st.hipW = clamp((st.hipW || 0) + clamp(hipWant - (st.hipW || 0), -dt / 0.15, dt / 0.8), 0, 1);
    const hip = smooth01(st.hipW);
    // у стража и архимага — «рука у оружия»: левая ложится на древко посоха выше правой (руки — в arms)
    st.staffRest = !st.female && c.staffR ? hip : 0;
    if (hip > 0 && st.female) {
      const side = c.staffR ? AL : (st.ws >= 0 ? AR : AL);
      const H = side === AL ? HIP_L : HIP_R;
      idle[side] = hip; idle.set(H.at, side + 1); idle.set(H.pole, side + 4); idle.set(H.dir, side + 7); idle.set(H.thumb, side + 10); idle[side + 13] = hip * H.hw;
      idle[(side === AL ? FL : FR) + 5] = hip;
    }
    // стойка героя на месте весь слой, на ходу — только корпус (ноги ведёт передвижение)
    for (let i = I.HX; i <= I.HP; i++) idle[i] *= still;
    for (let i = I.FLX; i <= I.FRYW; i++) idle[i] *= still;
    idle[I.LEG] = still;
  }

  // ---------------------------------------------------------------- применение к костям
  const getPos = (o, v) => v.setFromMatrixPosition(o.matrixWorld);
  function rotateWorld(bone, qW) {
    bone.parent.matrixWorld.decompose(_p, _pq, _s);
    _q1.copy(_pq).invert().multiply(qW).multiply(_pq);
    bone.quaternion.premultiply(_q1);
    bone.updateWorldMatrix(false, false);
  }
  // IK двух костей «дельтой»: поворачиваем кости от их текущих направлений — кручение клипа сохраняется
  function ik2(a, b, c, T, pole, w, reach = 0.999) {
    if (!a || !b || !c || w <= 1e-3) return;
    const A = _ia, Bp = _ib, C = _ic, D = _id, M = _im, X = _it, U = _iu, Wv = _iw;
    a.updateWorldMatrix(true, false); b.updateWorldMatrix(false, false); c.updateWorldMatrix(false, false);
    getPos(a, A); getPos(b, Bp); getPos(c, C);
    const L1 = A.distanceTo(Bp), L2 = Bp.distanceTo(C);
    D.subVectors(T, A);
    let dist = D.length();
    if (dist < 1e-5 || L1 < 1e-5 || L2 < 1e-5) return;
    D.divideScalar(dist);
    dist = clamp(dist, Math.abs(L1 - L2) * 1.05 + 1e-4, (L1 + L2) * reach);
    const ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sa = Math.sqrt(1 - ca * ca);
    M.copy(pole).addScaledVector(D, -pole.dot(D));
    if (M.lengthSq() < 1e-8) { M.subVectors(Bp, A); M.addScaledVector(D, -M.dot(D)); }
    if (M.lengthSq() < 1e-8) M.set(0, -1, 0);
    M.normalize();
    X.copy(A).addScaledVector(D, L1 * ca).addScaledVector(M, L1 * sa);      // новый локоть/колено
    U.subVectors(Bp, A).normalize(); Wv.subVectors(X, A).normalize();
    _q.setFromUnitVectors(U, Wv); if (w < 1) _q.slerp(_qf.identity(), 1 - w);
    rotateWorld(a, _q);
    b.updateWorldMatrix(false, false); c.updateWorldMatrix(false, false);
    getPos(b, Bp); getPos(c, C);
    X.copy(A).addScaledVector(D, dist);                                         // цель (в досягаемости)
    U.subVectors(C, Bp).normalize(); Wv.subVectors(X, Bp).normalize();
    _q.setFromUnitVectors(U, Wv); if (w < 1) _q.slerp(_qf.identity(), 1 - w);
    rotateWorld(b, _q);
    c.updateWorldMatrix(false, false);
  }
  // [W5-ПОЛ] нижняя точка подошвы стопы i (0 — левая, 1 — правая) в мире; бедро, голень и стопа уже обновлены (ik2).
  // Точно — по вершинам сетки (vrmKit.termsLowSide, та же подошва, что у heroModel); без них — жёсткие точки на стопе
  function soleLow(i) {
    if (rig.soles.fast) return termsLowSide(rig.soles.fast, i, _kr)[i];
    const list = rig.soles[i ? 'R' : 'L'], f = rigLegs[i][2];
    let lo = Infinity;
    for (let j = 0; j < list.length; j++) {
      const { node, p } = list[j];
      if (node !== f) node.updateWorldMatrix(false, false);
      const y = _sp.copy(p).applyMatrix4(node.matrixWorld).y;
      if (y < lo) lo = y;
    }
    return lo;
  }
  // вектор из «боковых» осей руки (o наружу, u, f) → оси героя → мир
  function sideDir(v, base, j, sgn, outV) { return outV.set(v[base + j] * sgn, v[base + j + 1], v[base + j + 2]); }

  const armLen = { L: 0, R: 0 };
  function body(dt, c) {
    if (!rig) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    think(dt, c);
    evalAction(dt, c);
    evalIdle(dt, c);
    // слой покоя гаснет, пока действие владеет телом
    const ia = 1 - clamp01(out[I.ACT]);
    for (let i = 0; i < BODY_END; i++) out[i] += idle[i] * ia;
    // руки покоя (рука на поясе) — там, где действие руку не держит
    // смешивание по весам: доля покоя в цели — wi / (wa + wi), вес — сумма (непрерывно при любом угасании)
    for (const base of ARM_BASES) {
      const wa = out[base], wi = idle[base] * ia * (1 - clamp01(wa));
      if (wi < 1e-3) continue;
      if (wa < 1e-3) for (let j = 1; j < ARM.length; j++) out[base + j] = idle[base + j];
      else { const k = wi / (wa + wi); for (let j = 1; j < ARM.length; j++) out[base + j] += (idle[base + j] - out[base + j]) * k; }
      out[base] = wa + wi;
    }
    for (let j = 0; j < FING.length; j++) { out[FL + j] += idle[FL + j] * ia; out[FR + j] += idle[FR + j] * ia; }
    out[I.LEG] = Math.max(out[I.LEG], idle[I.LEG] * ia);
    // на ходу таз и стопы ведёт передвижение: выпад/присед действия — только стоя
    const sw = clamp01(fin(c.standW) ? c.standW : 1);
    if (sw < 1) { for (let i = I.HX; i <= I.HP; i++) out[i] *= sw; for (let i = I.FLX; i <= I.FRYW; i++) out[i] *= sw; out[I.LEG] *= sw; }
    // вздрагивание при ранении: рывок корпуса назад, голова в сторону, плечи вверх
    st.hit = Math.max(0, st.hit - dt / 0.42);
    if (st.hit > 0) {
      const h = Math.sin(Math.PI * Math.min(1, (1 - st.hit) / 0.3)) * Math.min(1, st.hit * 1.6);
      out[I.SP] -= 0.1 * h; out[I.CP] -= 0.12 * h; out[I.EP] -= 0.18 * h; out[I.EY] += 0.22 * h * st.hitDir; out[I.SHL] += 0.12 * h; out[I.SHR] += 0.12 * h;
    }
    st.blockK = Math.max(0, st.blockK - dt / 0.3);
    applyBody(c);
    st.msBody = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  }

  function applyBody(c) {
    const B = rig.bones, vrm = rig.vrm;
    vrm.scene.updateWorldMatrix(true, false);
    vrm.scene.getWorldQuaternion(_qm); _qmi.copy(_qm).invert();
    const legW = legsOn() && st.legOk ? clamp01(out[I.LEG]) : 0;
    const hipsMove = legW > 0.01 && B.hips && B.leftUpperLeg && B.rightUpperLeg && B.leftFoot && B.rightFoot;
    const floorY = rig.model && rig.model.matrixWorld ? rig.model.matrixWorld.elements[13] : 0;   // [W5-ПОЛ] пол — начало обёртки
    // стопы до сдвига таза: где их поставил клип
    if (hipsMove) {
      const legs = rigLegs;
      for (let i = 0; i < 2; i++) {
        const u = legs[i][0], l = legs[i][1], f = legs[i][2];
        u.updateWorldMatrix(true, false); l.updateWorldMatrix(false, false); f.updateWorldMatrix(false, false);
        getPos(f, footW[i]); getPos(l, kneeW[i]); getPos(u, hipW[i]);
        f.matrixWorld.decompose(_p, footQ[i], _s);
      }
      // таз: сдвиг в осях героя (м) и повороты
      const hs = (rig.height || 1.75) / 1.75;
      _o.set(out[I.HX] * hs, out[I.HY] * hs, out[I.HZ] * hs).applyQuaternion(_qm).multiplyScalar(legW);
      B.hips.parent.matrixWorld.decompose(_p, _pq, _s);
      _o.applyQuaternion(_pq.invert()).divideScalar(_s.x || 1);
      B.hips.position.add(_o);
      if (out[I.HR]) B.hips.rotateZ(out[I.HR] * legW);
      if (out[I.HYW]) B.hips.rotateY(out[I.HYW] * legW);
      if (out[I.HP]) B.hips.rotateX(out[I.HP] * legW);
      B.hips.updateWorldMatrix(true, false);
      // ноги: стопа — на месте клипа плюс шаг свободной ноги (оси героя), колено — туда же, куда смотрело
      for (let i = 0; i < 2; i++) {
        const u = legs[i][0], l = legs[i][1], f = legs[i][2];
        const ox = i ? I.FRX : I.FLX;
        _o.set(out[ox], out[ox + 1], out[ox + 2]).multiplyScalar((rig.height || 1.75) / 1.75).applyQuaternion(_qm);
        _t.copy(footW[i]).addScaledVector(_o, legW);
        _m.copy(kneeW[i]).sub(hipW[i]).add(kneeW[i]).sub(footW[i]);      // колено «вперёд» от линии бедро—стопа
        // на колено (поражение): колено опорной ноги вниз-вперёд
        _w.set(0, 0, 1).applyQuaternion(_qm);
        _m.normalize().lerp(_w, 0.5).normalize();
        _u.copy(_m);
        // [W5-ПОЛ] IK — всегда в цель (вес 1): сдвиг таза и шаг стопы уже взяты с весом legW; частичный поворот
        // (прежний вес legW) тянул стопу вниз вместе с тазом — при переходе к колену поражения носок уходил в пол
        ik2(u, l, f, _t, _u, 1, 0.9995);
        // стопа: прежний поворот в мире + разворот носка (рысканье) и наклон (колено поражения)
        l.matrixWorld.decompose(_p, _pq, _s);
        const yw = out[i ? I.FRYW : I.FLYW] * legW, pt = out[i ? I.FRP : I.FLP] * legW;
        _qF.copy(footQ[i]);
        if (yw) { _w.set(0, 1, 0).applyQuaternion(_qm); _q1.setFromAxisAngle(_w, yw); _qF.premultiply(_q1); }
        if (pt) { _w.set(1, 0, 0).applyQuaternion(_qm); _q1.setFromAxisAngle(_w, pt); _qF.premultiply(_q1); }
        f.quaternion.copy(_pq.invert().multiply(_qF));
        f.updateWorldMatrix(false, false);
        // [W5-ПОЛ] подошва не ниже пола: нижняя точка стопы (rig.soles — точки подошвы heroModel) под полом (носок
        // на колене, наклон стопы, шаг) — цель стопы выше на столько же, IK заново и тот же поворот стопы (_qF:
        // общий _q ik2 перезаписывает поворотом голени — стопа вставала по осям мира и висела над полом)
        const pen = rig.soles ? floorY - soleLow(i) : 0;
        if (pen > 1e-4) {
          _t.y += pen;
          ik2(u, l, f, _t, _u, 1, 0.9995);
          l.matrixWorld.decompose(_p, _pq, _s);
          f.quaternion.copy(_pq.invert().multiply(_qF));
          f.updateWorldMatrix(false, false);
        }
        footT[i].copy(_t); poleU[i].copy(_u); footR[i].copy(_qF);
      }
      // [W5-ПОЛ] колено и голень не ниже пола (поза на колене — поражение): нижняя точка оболочки сетки ног
      // (rig.soles.knee) под полом — таз выше на столько же, ноги заново в те же цели стоп с тем же поворотом стоп
      // (подошвы остаются на полу); колено поднимается чуть меньше таза — до трёх шагов
      const kn = rig.soles && rig.soles.knee && kneeMayTouch(rig.soles.knee, floorY) ? rig.soles.knee : null;   // колени высоко — не считаем
      for (let it = 0; kn && it < 3; it++) {
        const kp = floorY - termsLow(kn, _kr)[2];
        if (kp <= 1e-4) break;
        B.hips.parent.matrixWorld.decompose(_p, _pq, _s);
        _o.set(0, kp, 0).applyQuaternion(_pq.invert()).divideScalar(_s.x || 1);
        B.hips.position.add(_o);
        B.hips.updateWorldMatrix(true, false);
        for (let i = 0; i < 2; i++) {
          const u = legs[i][0], l = legs[i][1], f = legs[i][2];
          ik2(u, l, f, footT[i], poleU[i], 1, 0.9995);
          l.matrixWorld.decompose(_p, _pq, _s);
          f.quaternion.copy(_pq.invert().multiply(footR[i]));
          f.updateWorldMatrix(false, false);
        }
      }
    }
    // корпус: позвоночник, грудь, шея, голова (локально — у нормализованных костей покой единичный)
    const rot = rotXYZ;
    rot(B.spine, out[I.SP], out[I.SY], out[I.SR]);
    rot(B.upperChest || B.chest, out[I.CP], out[I.CY], out[I.CR]);
    rot(B.neck, out[I.NP] + out[I.EP] * 0.35, out[I.NY] + out[I.EY] * 0.4, 0);
    // взгляд: Регент (в бою) или камера (витрина) — голова довернётся, остальное — шея
    look(c);
    // голова держит взгляд: наклон корпуса вперёд/назад гасится на 60% (поза, где голова склонена, задаёт ep сама)
    rot(B.head, out[I.EP] * 0.65 + st.lookP - 0.6 * (out[I.SP] + out[I.CP]), out[I.EY] * 0.6 + st.lookY, out[I.ER] + st.lookR);
    // плечи: подъём (вздрагивание, торжество) и дыхание
    if (B.leftShoulder && out[I.SHL]) B.leftShoulder.rotateZ(out[I.SHL]);
    if (B.rightShoulder && out[I.SHR]) B.rightShoulder.rotateZ(-out[I.SHR]);
  }

  // взгляд головы: к цели (Регент) чуть вверх; в витрине — наклон головы к камере у героинь
  function look(c) {
    let yaw = 0, pitch = 0, roll = 0;
    const tgt = c.lookTarget;
    if (tgt && rig.bones.head && !c.menu) {
      // докрутка головы к Регенту: остаток между тем, куда голова уже смотрит (клип, грудь к цели), и целью
      const hb = rig.bones.head;
      hb.updateWorldMatrix(true, false);
      getPos(hb, _a);
      _d.subVectors(tgt, _a).applyQuaternion(_qmi);
      _d.y += 2.2;                                                   // Регент высокий — смотрим ему в лицо
      _u.setFromMatrixColumn(hb.matrixWorld, 2).normalize().applyQuaternion(_qmi);   // «вперёд» головы (покой — +z)
      const hz = Math.max(0.8, Math.hypot(_d.x, _d.z));
      yaw = clamp(wrapA(Math.atan2(_d.x, _d.z) - Math.atan2(_u.x, _u.z)), -0.6, 0.6) * 0.65;
      pitch = -clamp(Math.atan2(_d.y, hz) - Math.asin(clamp(_u.y, -1, 1)), -0.15, 0.3) * 0.5;
      // в каст-позе голова ведёт свою линию (печать, суд, лепка) — докрутка слабее
      const k = 1 - 0.6 * clamp01(out[I.ACT]);
      yaw *= k; pitch *= k;
    }
    if (c.menu && st.female) roll = 0.06 * (c.gaze > 0.5 ? 1 : 0.5) * (st.sig === 'dark' ? -1 : 1);
    const k = 1 - Math.exp(-4 * Math.max(1e-3, ctx0.dt));
    st.lookY += (yaw - st.lookY) * k; st.lookP += (pitch - st.lookP) * k; st.lookR += (roll - st.lookR) * k;
  }

  function arms(dt, c) {
    if (!rig) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const B = rig.bones;
    rig.vrm.scene.updateWorldMatrix(true, false);
    rig.vrm.scene.getWorldQuaternion(_qm);
    const staffR = !!c.staffR;
    for (let ai = 0; ai < 2; ai++) {
      const A = rigArms[ai], base = A.base, sgn = A.sgn, up = A.up, lo = A.lo, hand = A.hand, h = A.h;
      // лук в руке (поза лука heroModel) — руки его; зеркало игрока делит руку с позой
      let w = out[base] * (1 - clamp01(c.bowW) * (st.a && st.a.def === ACTIONS.signature && st.sig === 'elf' ? 0 : 1));
      if (w <= 1e-3 || !up || !lo || !hand) continue;
      const side = A.side;
      if (!armLen[side]) {
        up.updateWorldMatrix(true, false); lo.updateWorldMatrix(false, false); hand.updateWorldMatrix(false, false);
        armLen[side] = getPos(up, _a).distanceTo(getPos(lo, _b)) + _b.distanceTo(getPos(hand, _c));
      }
      up.updateWorldMatrix(true, false);
      getPos(up, _a);
      sideDir(out, base, 1, sgn, _o).applyQuaternion(_qm);
      _o2.copy(_a).addScaledVector(_o, armLen[side]);
      sideDir(out, base, 4, sgn, _m).applyQuaternion(_qm).normalize();
      _b.copy(_m);
      ik2(up, lo, hand, _o2, _b, w);
      const hw = out[base + 13] * w / Math.max(1e-3, out[base]);
      if (h && hw > 1e-3 && rig.orientHand) {
        sideDir(out, base, 7, sgn, _u); sideDir(out, base, 10, sgn, _w);
        // кисть с посохом: древко (вдоль большого пальца) — по направлению позы, пальцы — поперёк него
        if (staffR && base === AR) {
          _w.set(-out[I.SDO], out[I.SDU], out[I.SDF]).normalize();
          _u.addScaledVector(_w, -_u.dot(_w));
          if (_u.lengthSq() < 1e-4) { _u.set(0, 0, 1).addScaledVector(_w, -_w.z); }
          _u.normalize();
        }
        rig.orientHand(h, _u, _w, clamp01(hw));
      }
    }
    // левая на древке посоха: визитка стража (посох-клинок наискось) и «рука у оружия» в покое
    const onSig = st.a && st.a.def === ACTIONS.signature && st.sig === 'ashen' ? out[AL] * 0.95 : 0;
    const onRest = (st.staffRest || 0) * (1 - clamp01(out[I.ACT])) * (1 - clamp01(c.mirrorW));
    const ws = Math.max(onSig, onRest);
    if (ws > 1e-3 && rig.staffAxis && B.leftUpperArm && rig.staffAxis(_a, _b)) {   // точка хвата (мир) и направление к навершию
      _t.copy(_a).addScaledVector(_b, (onSig >= onRest ? 0.42 : 0.2) * (rig.height || 1.8) / 1.8);
      _m.set(1, -0.6, -0.2).applyQuaternion(_qm);
      ik2(B.leftUpperArm, B.leftLowerArm, B.leftHand, _t, _m, ws);
      // кисть обхватывает древко: большой палец — вдоль древка, пальцы — поперёк (к правому боку)
      if (rig.hands && rig.hands.left && rig.orientHand && onRest > onSig) {
        _qmi.copy(_qm).invert();
        _w.copy(_b).applyQuaternion(_qmi); _u.set(-1, 0, 0.35); _u.addScaledVector(_w, -_u.dot(_w)).normalize();
        rig.orientHand(rig.hands.left, _u, _w, ws);
      }
    }
    st.staffGrip = ws;
    st.msArms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    st.ms = (st.msBody || 0) + st.msArms + (st.msFace || 0);
    st.msAvg += (st.ms - st.msAvg) * 0.05;
    void dt;
  }

  // пальцы: пожелания действия поверх handWants (с посохом правая всегда в кулаке)
  const FMAP = { open: 'open', claw: 'claw', grip: 'grip', ok: 'ok', point: 'point', soft: 'relax' };   // формы — HAND_POSES heroModel
  function fingers(want, c) {
    // левая на древке — кулак
    if ((st.staffGrip || 0) > 0.05) { const W = want.left, g = st.staffGrip; for (const k in W) W[k] *= 1 - g; W.grip = (W.grip || 0) + g; }
    for (let fi = 0; fi < 2; fi++) {
      const base = FINGER_SIDES[fi][0], fb = FINGER_SIDES[fi][1], side = FINGER_SIDES[fi][2];
      const w = clamp01(out[base]);
      if (w < 0.05) continue;
      if (side === 'right' && c.staffR) continue;
      if (side === 'left' && c.bowHeld) continue;
      let sum = 0;
      for (let j = 0; j < FING.length; j++) sum += Math.max(0, out[fb + j]);
      if (sum < 0.05) continue;
      const W = want[side];
      for (const k in W) W[k] *= 1 - w;
      for (let j = 0; j < FING.length; j++) { const k = FMAP[FING[j]]; W[k] = (W[k] || 0) + w * Math.max(0, out[fb + j]) / sum; }
    }
    return want;
  }

  // мимика: улыбка «Распознано», сосредоточенность (заряд), боль (ранение), торжество (победа)
  function expression(dt, c) {
    st.smileT = Math.max(0, st.smileT - dt); st.smileCool = Math.max(0, st.smileCool - dt);
    const E = st.expr;
    const sm = smooth01(st.smileT / 0.35) * (st.smileT > 0 ? 1 : 0);
    const base = c.menu ? (st.female ? 0.3 : 0.12) : 0;
    const want = _ew;
    want.smile = clamp01(Math.max(out[I.SMILE], base, 0.85 * sm) - 0.6 * st.hit);
    want.frown = clamp01(out[I.FROWN] * (1 - sm) * (1 - st.hit));
    want.brow = clamp01(out[I.BROW] + 0.25 * sm);
    want.squint = clamp01(Math.max(out[I.SQUINT], 0.2 * sm, st.hit > 0.55 ? 0.95 : 0));
    want.pain = clamp01(Math.max(out[I.PAIN], st.hit));
    const k = 1 - Math.exp(-dt / 0.09);
    for (const key in E) E[key] += (want[key] - E[key]) * (key === 'pain' || key === 'squint' ? Math.min(1, k * 1.8) : k);
    return E;
  }

  return {
    get version() { return POSES_VERSION; },
    bind(r) {
      rig = r; armLen.L = 0; armLen.R = 0; st.victory = null;
      const B = r.bones;
      rigArms = [
        { base: AL, sgn: 1, side: 'L', up: B.leftUpperArm, lo: B.leftLowerArm, hand: B.leftHand, h: r.hands && r.hands.left },
        { base: AR, sgn: -1, side: 'R', up: B.rightUpperArm, lo: B.rightLowerArm, hand: B.rightHand, h: r.hands && r.hands.right },
      ];
      rigLegs = [[B.leftUpperLeg, B.leftLowerLeg, B.leftFoot], [B.rightUpperLeg, B.rightLowerLeg, B.rightFoot]];
    },
    unbind() { rig = null; st.a = null; },
    // [W5-ПОЛ] стопа i (0 — левая, 1 — правая) выше на dy м в мире — IK ноги (колено гнётся, поворот стопы в мире тот
    // же): стопа на ступени, когда земля под ней выше пола героя (heroModel.groundFeet). Вызывать после позы кадра.
    raiseFoot(i, dy) {
      const L = rigLegs && rigLegs[i];
      if (!rig || !L || !L[0] || !L[1] || !L[2] || !(dy > 0)) return false;
      const u = L[0], l = L[1], f = L[2];
      u.updateWorldMatrix(true, false); l.updateWorldMatrix(false, false); f.updateWorldMatrix(false, false);
      f.matrixWorld.decompose(_p, _qF, _s);
      getPos(f, _t); _t.y += dy;
      // колено — туда же, куда смотрело: 2·колено − бедро − стопа
      getPos(l, _m); getPos(u, _w); getPos(f, _o);
      _u.copy(_m).multiplyScalar(2).sub(_w).sub(_o);
      ik2(u, l, f, _t, _u, 1, 0.9995);
      l.matrixWorld.decompose(_p, _pq, _s);
      f.quaternion.copy(_pq.invert().multiply(_qF));
      f.updateWorldMatrix(false, false);
      return true;
    },
    setHero(id, opts = {}) { st.hero = id; st.female = !!opts.female; st.stance = opts.stance || 'staff'; st.victory = null; if (st.sig) setSignature(id); },
    setQuality(q) { st.q = q === 'low' || q === 'high' ? q : 'medium'; },
    events, claims, claimsHold, body, arms, fingers, expression,
    // одышка после кастов: дыхание глубже и чаще, гаснет за ~5 с
    breath(dt, idle) {
      st.exert = Math.max(0, st.exert - dt / 5);
      const rate = 1.55 + 1.1 * st.exert;
      st.breathPh += dt * rate;
      const x = st.breathPh % (Math.PI * 2);
      // вдох короче выдоха: фаза «сжата» в первой половине
      const s = x < Math.PI * 0.8 ? Math.sin((x / (Math.PI * 0.8)) * Math.PI / 2) : Math.cos(((x - Math.PI * 0.8) / (Math.PI * 1.2)) * Math.PI / 2);
      return (s * 2 - 1) * 0.024 * (idle ? 1 : 0.45) * (1 + 1.3 * st.exert);
    },
    // прищур для век-шторок heroGear (поверх моргания)
    lids(bw) { return Math.max(bw, st.expr.squint * 0.32, st.hit > 0.6 ? 0.9 : 0); },
    setSignature,
    flourish() {
      if (!st.sig || !st.sigBase) return false;
      const g = signatureGesture(st.sig, st.sigBase);
      if (!g) return false;
      st.gesture = g; st.gestureT = 0;
      return true;
    },
    get signature() { return st.sig; },
    get active() { return st.a ? st.a.def.id : ''; },
    get weight() { return +clamp01(out[I.ACT]).toFixed(2); },
    get out() { return out; },
    state() {
      return { act: st.a ? st.a.def.id : '', t: +st.at.toFixed(2), w: +clamp01(out[I.ACT]).toFixed(2), ws: +st.ws.toFixed(2), exert: +st.exert.toFixed(2), sig: st.sig, q: st.q,
        expr: Object.fromEntries(Object.entries(st.expr).map(([k, v]) => [k, +v.toFixed(2)])), ms: +st.msAvg.toFixed(3), armL: +clamp01(out[AL]).toFixed(2), armR: +clamp01(out[AR]).toFixed(2) };
    },
    dispose() { rig = null; st.a = null; },
  };

  function setSignature(id) {
    const s = id ? SIGNATURES[id] || null : null;
    st.sig = s ? s.id : null;
    st.sigBase = s ? signatureBase(s.id, st.female) : null;
    st.gesture = null;
  }
}

// ---------------------------------------------------------------- мимика: кости лица
// У моделей Quaternius нет морфов и костей лица. К общему скелету героя (GLTFLoader даёт один Skeleton на
// все сетки) добавляем кости-дети головы: брови (внутренний и внешний край каждой) и уголки рта героинь
// (у архимага рот под бородой — только брови); вершины рядом с ними получают вес этих костей (гаусс).
// Шейдер скиннинга читает кости из текстуры (20×20 и для 65, и для 71 кости) — новых программ, материалов
// и текстур нет. Позу привязки берём из boneInverses головы — в покое кости лица ничего не сдвигают.
// Звать после dressUp (подгонка волос по весам головы уже сделана) и до первого снимка остаточных
// образов (heroGhost копирует список костей при сборке набора).
export function rigFace(THREE, vrm, { mouth = true } = {}) {
  const head = vrm.humanoid && (vrm.humanoid.getRawBoneNode ? vrm.humanoid.getRawBoneNode('head') : null);
  if (!head) return null;
  const meshes = [];
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton || !o.geometry || !o.geometry.attributes.skinIndex) return;
    const mat = Array.isArray(o.material) ? null : o.material;
    // [W4-СБОРКА] у героинь с лицом волны 4 брови модели заменены лентой BrowStrands (heroShading): в ней брови
    // и подводка — мимика двигает только вершины бровей (geometry.userData.browV)
    const brows = /Eyebrow/i.test(o.name) || (o.name === 'BrowStrands' && Array.isArray(o.geometry.userData.browV));
    const face = !!mat && /^MI_Regular_Female/.test(mat.name || '');
    if (brows || (face && mouth)) meshes.push({ o, brows });
  });
  if (!meshes.length) return null;
  const parts = [];   // { bone, rest (локально головы), restMesh, lin (сетка → голова), kind, side }
  const _v = new THREE.Vector3();
  const grown = new Set();
  for (const { o, brows } of meshes) {
    const sk = o.skeleton, hi = sk.bones.indexOf(head);
    if (hi < 0) continue;
    const g = o.geometry, pa = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!pa || !si || !sw || si.normalized) continue;
    // сетка → локально головы в позе привязки: boneInverse(head) · bindMatrix
    const toHead = new THREE.Matrix4().copy(sk.boneInverses[hi]).multiply(o.bindMatrix);
    const lin = new THREE.Matrix3().setFromMatrix4(toHead);
    const mine = [];
    const addBone = (name, restMesh, kind, side) => {
      const b = new THREE.Bone(); b.name = `face-${name}`;
      const rest = restMesh.clone().applyMatrix4(toHead);
      b.position.copy(rest);
      head.add(b);
      // обратная матрица привязки: (Head_bind · T(rest))⁻¹ = T(−rest) · boneInverse(head)
      sk.bones.push(b);
      sk.boneInverses.push(new THREE.Matrix4().makeTranslation(-rest.x, -rest.y, -rest.z).multiply(sk.boneInverses[hi]));
      grown.add(sk);
      const p = { bone: b, rest, restMesh: restMesh.clone(), lin, kind, side, idx: sk.bones.length - 1 };
      parts.push(p); mine.push(p);
      return p;
    };
    const n = pa.count;
    const newSI = new si.array.constructor(n * 4), newSW = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) { newSI[i * 4 + j] = si.getComponent(i, j); newSW[i * 4 + j] = sw.getComponent(i, j); }
    // вес новой кости — в место с наименьшим весом, остальные нормируются к (1 − w)
    const put = (i, bi, w) => {
      if (w < 1e-3) return;
      let jm = 0; for (let j = 1; j < 4; j++) if (newSW[i * 4 + j] < newSW[i * 4 + jm]) jm = j;
      let sum = 0; for (let j = 0; j < 4; j++) if (j !== jm) sum += newSW[i * 4 + j];
      for (let j = 0; j < 4; j++) if (j !== jm) newSW[i * 4 + j] = sum > 1e-6 ? (newSW[i * 4 + j] / sum) * (1 - w) : 0;
      newSI[i * 4 + jm] = bi; newSW[i * 4 + jm] = w;
    };
    if (brows) {
      // две брови в одной сетке: сторона — по знаку x; внутренний/внешний край — по |x|
      const bv = g.userData.browV, inBrow = (i) => !bv || bv.some(([a, b]) => i >= a && i < b);
      for (const side of [1, -1]) {
        let x0 = Infinity, x1 = -Infinity; const ids = [];
        for (let i = 0; i < n; i++) { const x = pa.getX(i); if (Math.sign(x) !== side || !inBrow(i)) continue; ids.push(i); const ax = Math.abs(x); x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); }
        if (ids.length < 6 || x1 - x0 < 1e-3) continue;
        const cIn = new THREE.Vector3(), cOut = new THREE.Vector3(); let nIn = 0, nOut = 0;
        for (const i of ids) { const t = (Math.abs(pa.getX(i)) - x0) / (x1 - x0); _v.fromBufferAttribute(pa, i); if (t < 0.35) { cIn.add(_v); nIn++; } else if (t > 0.65) { cOut.add(_v); nOut++; } }
        if (!nIn || !nOut) continue;
        const pIn = addBone(`brow${side > 0 ? 'L' : 'R'}In`, cIn.divideScalar(nIn), 'browIn', side);
        const pOut = addBone(`brow${side > 0 ? 'L' : 'R'}Out`, cOut.divideScalar(nOut), 'browOut', side);
        for (const i of ids) {
          // бровь целиком на своих двух костях (они дети головы: в покое движение то же)
          const t = smooth01((Math.abs(pa.getX(i)) - x0) / (x1 - x0));
          for (let j = 0; j < 4; j++) newSW[i * 4 + j] = 0;
          newSI[i * 4] = pIn.idx; newSW[i * 4] = 1 - t; newSI[i * 4 + 1] = pOut.idx; newSW[i * 4 + 1] = t;
        }
      }
    } else {
      // уголки рта — как smileFace: губы на атласе (эллипс), крайние по x вершины; вес — гаусс ~11 мм
      const uv = g.attributes.uv;
      if (!uv) continue;
      const lips = [];
      for (let i = 0; i < n; i++) { const du = (uv.getX(i) - 0.1797) / 0.03, dv = (uv.getY(i) - 0.2598) / 0.0125; if (du * du + dv * dv < 1) lips.push(i); }
      if (lips.length < 6) continue;
      let iL = lips[0], iR = lips[0];
      for (const i of lips) { if (pa.getX(i) > pa.getX(iL)) iL = i; if (pa.getX(i) < pa.getX(iR)) iR = i; }
      if (Math.abs(pa.getX(iL) - pa.getX(iR)) < 0.02) continue;
      const cs = [[iL, 1], [iR, -1]].map(([i, side]) => addBone(`mouth${side > 0 ? 'L' : 'R'}`, _v.fromBufferAttribute(pa, i).clone(), 'mouth', side));
      const S2 = 0.011 * 0.011;
      for (let i = 0; i < n; i++) {
        _v.fromBufferAttribute(pa, i);
        for (const p of cs) { const d2 = _v.distanceToSquared(p.restMesh); if (d2 < S2 * 9) put(i, p.idx, Math.exp(-d2 / S2) * 0.92); }
      }
    }
    if (!mine.length) continue;
    g.setAttribute('skinIndex', new THREE.BufferAttribute(newSI, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(newSW, 4));
  }
  // скелет вырос: матрицы и текстура костей — заново (размер текстуры тот же, пересоздаёт рендер)
  for (const sk of grown) {
    sk.boneMatrices = new Float32Array(16 * sk.bones.length);
    if (sk.boneTexture) { sk.boneTexture.dispose(); sk.boneTexture = null; }
  }
  if (!parts.length) return null;
  // смещения (метры сетки: y — вверх, z — вперёд, x — наружу по знаку стороны)
  const OFF = {
    browIn: { brow: [0, 0.0024, 0.0004], frown: [-0.0011, -0.0016, 0.0004], pain: [-0.0006, 0.0026, 0], smile: [0, 0.0005, 0] },
    browOut: { brow: [0, 0.0018, 0], frown: [0, -0.0006, 0], pain: [0, -0.0009, 0], smile: [0, 0.0004, 0] },
    mouth: { smile: [0.0013, 0.0042, -0.0013], frown: [-0.0005, -0.0003, 0], pain: [0.0011, -0.0014, -0.0002] },
  };
  const _d = new THREE.Vector3();
  const last = new Float32Array(4).fill(NaN);
  return {
    bones: parts.length,
    // E: { smile, frown, brow, pain } 0..1 — сдвиг костей лица от покоя
    update(E) {
      // кости не трогаем, пока выражение стоит (сравнение с точностью 1e-3)
      let same = true;
      for (let i = 0; i < 4; i++) { const v = E[FACE_KEYS[i]] || 0; if (!(Math.abs(v - last[i]) < 1e-3)) { same = false; last[i] = v; } }
      if (same) return;
      for (const p of parts) {
        const T = OFF[p.kind];
        _d.set(0, 0, 0);
        for (let i = 0; i < 4; i++) { const k = FACE_KEYS[i], o = T[k], w = last[i]; if (o && w) { _d.x += o[0] * w * p.side; _d.y += o[1] * w; _d.z += o[2] * w; } }
        _d.applyMatrix3(p.lin);
        p.bone.position.copy(p.rest).add(_d);
      }
    },
    dispose() { for (const p of parts) if (p.bone.parent) p.bone.parent.remove(p.bone); },
  };
}
