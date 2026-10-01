// ASHEN OATH — «Тренажёр техники»: твист «ОШИБКА» за 20 секунд.
// Игрок выбирает жест и видит вживую чек-лист его условий с полосками 0–100 %: «кольцо сомкнуто ✓»,
// «ладонь к камере ✗»… Первое невыполненное условие показано крупно: пиктограмма «как сейчас → как надо»
// и что исправить; на превью камеры подсвечены нужные точки. Все условия выполнены и жест распознан —
// «Идеально!». То же для приседаний и отжиманий: «глубина ✓», «колени внутрь ✗», «спина ✓».
//
// Условия считает сам распознаватель (core/handGestures.js checks(), core/squatCounter.js и
// core/pushupCounter.js read().checks) теми же формулами и порогами, что и в бою, — тренажёр только
// показывает их. Без камеры (или в «Отладке с клавиатуры») — демо: синтетическая кисть/поза проходит
// путь «ошибка → исправление → идеально» через тот же распознаватель.
//
// createTechniqueTrainer() → { select(id), reset(), setDemo(on), frame(nowMs, live) → view, gesture, demo }
//   live = { checks (vision.getStatus().debug.handGestures.checks), hands (vision.getHands()), pose (vision.getPose()) } | null
// createTechniqueScreen(kit) — экран ui.js (kit — DOM-помощники ui.js), callbacks: onTechniqueGesture(id),
//   onTechniqueDemo(on), onEnableCamera(), onBack().

import { createHandGestures } from '../core/handGestures.js';
import { createSquatCounter, synthSquatPose, SQUAT_HINTS } from '../core/squatCounter.js';
import { createPushupCounter, PUSHUP_FAULTS } from '../core/pushupCounter.js';
import { COACH_HINTS, hintPictogram } from '../core/gestureCoach.js';
import { pictogramSvg } from '../core/coachPictograms.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isObj = (v) => v !== null && typeof v === 'object';

export const TRAINER_GESTURES = Object.freeze([
  { id: 'ok', chip: '«OK»', title: '«OK» · снаряд', hand: 'right', kind: 'hand', how: 'Правая рука: кончики большого и указательного — в кольцо, остальные три пальца прямо вверх.' },
  { id: 'shield', chip: 'Щит', title: 'Щит', hand: 'left', kind: 'hand', how: 'Левая раскрытая ладонь к камере — резкий толчок вперёд сантиметров на 20, и держать.' },
  { id: 'spark', chip: 'Искра', title: 'Искра', hand: 'right', kind: 'hand', how: 'Правый кулак, большой у кончика указательного → резко выпрямить только указательный.' },
  { id: 'burst', chip: 'Выброс', title: 'Выброс', hand: 'right', kind: 'hand', how: 'Правый кулак подержать полсекунды → резко раскрыть все пальцы разом.' },
  { id: 'parry', chip: 'Парирование', title: 'Парирование', hand: 'left', kind: 'hand', how: 'Левый кулак → быстро раскрыть ладонью к камере.' },
  { id: 'orb', chip: 'Сфера', title: 'Сфера', hand: 'both', kind: 'hand', how: 'Обе раскрытые ладони друг к другу на ширине плеч, на одной высоте — будто держишь мяч.' },
  { id: 'squat', chip: 'Приседания', title: 'Приседания', hand: 'pose', kind: 'body', how: 'Ноутбук в 2–3 м, в кадре всё тело до стоп. Садись до параллели бёдер, колени по линии носков.' },
  { id: 'pushup', chip: 'Отжимания', title: 'Отжимания', hand: 'pose', kind: 'body', how: 'Ноутбук на полу сбоку: в кадре плечи, кисти и таз. Опускайся до кистей, тело одной линией.' },
]);
const BY_ID = Object.fromEntries(TRAINER_GESTURES.map((g) => [g.id, g]));
const HAND_NAME = { left: 'левая рука', right: 'правая рука', both: 'обе руки', pose: 'всё тело' };

// Подписи условий (ключи — из распознавателей). Неизвестный ключ показывается как есть.
const FRAME = 'Кисть целиком в кадре', NEAR = 'Кисть достаточно крупно';
const LABELS = {
  ok: { ring: 'Кольцо сомкнуто', others: 'Три пальца прямо вверх', index: 'Указательный загнут в кольцо', frame: FRAME, near: NEAR },
  shield: { open: 'Ладонь раскрыта', facing: 'Ладонь смотрит в камеру', push: 'Резкий толчок к камере', frame: FRAME, near: NEAR },
  spark: { load: 'Заряд: кулак, большой у указательного', index: 'Указательный выпрямлен', middle: 'Средний согнут', rest: 'Безымянный и мизинец согнуты', frame: FRAME, near: NEAR },
  burst: { fist: 'Кулак сжат', charge: 'Заряд набран (кулак ≈0,5 с)', snap: 'Раскрыт резко, все пальцы разом', frame: FRAME, near: NEAR },
  parry: { fist: 'Кулак держался ≥ 0,25 с', facing: 'Раскрыт ладонью к камере', snap: 'Раскрыт быстро (≤ 0,15 с)', frame: FRAME, near: NEAR },
  orb: { both: 'Видны обе кисти', open: 'Обе ладони раскрыты', facing: 'Ладони друг к другу', level: 'Руки на одной высоте', gap: 'Расстояние ≈ ширина плеч' },
  squat: { frame: 'Всё тело в кадре, до стоп', depth: 'Глубина: бёдра до параллели', valgus: 'Колени по линии носков', knees_forward: 'Колени не дальше носков', lean: 'Спина ровная, грудь вверх', heels: 'Пятки на полу', lockout: 'Наверху — выпрямиться' },
  pushup: { frame: 'Плечи и кисти в кадре', depth: 'Глубина: плечи почти до кистей', hands: 'Кисти стоят на месте', line: 'Тело одной линией', tempo: 'Темп: вниз и вверх подконтрольно' },
};
// Короткие исправления для приседаний и отжиманий (у жестов рук — COACH_HINTS[code].fix)
const SQUAT_FIX = { shallow: 'Садись глубже', valgus: 'Колени — наружу', knees_forward: 'Таз — назад', lean: 'Грудь — выше', heels: 'Пятки — в пол', fast: 'Медленнее', lockout: 'Выпрямись наверху', frame: 'Отойди от камеры' };
const PUSHUP_FIX = { shallow: 'Опускайся ниже', fast: 'Медленнее', slow: 'Не зависай внизу', hands: 'Кисти — на пол', sag: 'Подтяни таз', pike: 'Опусти таз', frame: 'Плечи и кисти — в кадр' };
const SQUAT_KEY_HINT = { depth: 'shallow', frame: 'frame' };
const PUSHUP_KEY_HINT = { depth: 'shallow', line: 'sag', tempo: 'fast', frame: 'frame' };
// Связи точек для подсветки условий на превью (кольцо «OK» — «сомкни» между кончиками)
const ITEM_LINKS = { 'ok.ring': [[4, 8]], 'ok.index': [[6, 8]], 'shield.facing': [[0, 5], [5, 17], [17, 0]], 'orb.facing': [[0, 5], [5, 17], [17, 0]], 'parry.facing': [[0, 5], [5, 17], [17, 0]] };

// Что исправить по коду: { code, fix, text, pictogram (SVG) } для жестов рук, приседаний и отжиманий.
function fixInfo(kind, code) {
  if (!code) return null;
  if (kind === 'squat') {
    const text = SQUAT_HINTS[code];
    return text ? { code, fix: SQUAT_FIX[code] || '', text, pictogram: safeSvg('squat_' + code) } : null;
  }
  if (kind === 'pushup') {
    const text = PUSHUP_FAULTS[code] || (code === 'frame' ? 'Поставьте камеру так, чтобы плечи и кисти были в кадре' : '');
    // у кадра своей пиктограммы отжиманий нет — общая «в кадр»
    return text ? { code, fix: PUSHUP_FIX[code] || '', text, pictogram: safeSvg('pushup_' + code) || hintPictogram('hands_missing', { width: 210, height: 90, labels: true }) } : null;
  }
  const e = COACH_HINTS[code];
  return e ? { code, fix: e.fix, text: e.text, mark: e.mark, pictogram: hintPictogram(code, { width: 210, height: 90, labels: true }) } : null;
}
const svgMemo = new Map();
function safeSvg(id, opts = { width: 210, height: 90, labels: true }) {
  const k = `${id}|${opts.width}|${opts.only || ''}`;
  if (!svgMemo.has(k)) { let s = ''; try { s = pictogramSvg(id, opts) || ''; } catch (e) { s = ''; } svgMemo.set(k, s); }
  return svgMemo.get(k);
}
export function gestureIcon(id) { return safeSvg('g_' + id, { width: 56, height: 40, labels: false, only: 'good' }); }

// ───────────────────────── синтетика для демо ─────────────────────────
// Параметрическая кисть (как dev/handSynth.mjs): ладонь в плоскости z=0, пальцы вдоль +y; базовая
// раскладка — левая кисть ладонью к камере. Координаты — НЕзеркальный кадр, как у MediaPipe.
const MCP = [[-0.034, 0.088], [-0.012, 0.094], [0.01, 0.089], [0.03, 0.078]];
const SEG = [[0.043, 0.025, 0.021], [0.047, 0.029, 0.022], [0.044, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [70, 95, 65];
function fingerChain(base, segs, curl, splay) {
  const pts = [];
  let p = { x: base[0], y: base[1], z: 0 };
  pts.push(p);
  let phi = 0;
  for (let j = 0; j < 3; j++) {
    phi += (curl * FLEX[j] * Math.PI) / 180;
    const d = { x: Math.sin(splay) * Math.cos(phi), y: Math.cos(splay) * Math.cos(phi), z: -Math.sin(phi) };
    p = { x: p.x + d.x * segs[j], y: p.y + d.y * segs[j], z: p.z + d.z * segs[j] };
    pts.push(p);
  }
  return pts;
}
export function synthHand(opts = {}) {
  const o = { side: 'right', curls: [0, 0, 0, 0], thumb: 'out', palm: 'camera', roll: 0, pitch: 0, yaw: 0, cx: 0.4, cy: 0.5, size: 0.14, aspect: 4 / 3, ...opts };
  const L = new Array(21);
  L[0] = { x: 0, y: 0, z: 0 };
  const splays = [0.12, 0.03, -0.06, -0.16];
  for (let f = 0; f < 4; f++) {
    const ch = fingerChain(MCP[f], SEG[f], o.curls[f], -splays[f]);
    for (let j = 0; j < 4; j++) L[5 + f * 4 + j] = ch[j];
  }
  const cmc = { x: -0.022, y: 0.018, z: -0.005 };
  const dirs = o.thumb === 'out'
    ? [{ x: -0.75, y: 0.62, z: -0.2 }, { x: -0.55, y: 0.8, z: -0.2 }, { x: -0.4, y: 0.9, z: -0.15 }]
    : [{ x: -0.3, y: 0.6, z: -0.75 }, { x: 0.45, y: 0.55, z: -0.7 }, { x: 0.85, y: 0.3, z: -0.45 }];
  const tl = [0.032, 0.03, 0.026];
  L[1] = cmc;
  let p = cmc;
  for (let j = 0; j < 3; j++) { const d = dirs[j], l = Math.hypot(d.x, d.y, d.z); p = { x: p.x + (d.x / l) * tl[j], y: p.y + (d.y / l) * tl[j], z: p.z + (d.z / l) * tl[j] }; L[2 + j] = p; }
  if (o.thumb === 'pinch') {
    const tip = L[8];
    const target = { x: tip.x - 0.004, y: tip.y - 0.004, z: tip.z - 0.003 };
    L[4] = target;
    L[3] = { x: (L[2].x + target.x) / 2 - 0.006, y: (L[2].y + target.y) / 2, z: (L[2].z + target.z) / 2 - 0.004 };
  }
  const tr = L.map((q) => {
    let x = q.x, y = q.y, z = q.z;
    if (o.side === 'right') x = -x;
    if (o.palm === 'away') { x = -x; z = -z; }
    const cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw);
    [x, z] = [x * cyw + z * syw, -x * syw + z * cyw];
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    const cr = Math.cos(o.roll), sr = Math.sin(o.roll);
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    return { x, y, z };
  });
  let px = 0, py = 0;
  for (const k of [0, 5, 9, 13, 17]) { px += tr[k].x / 5; py += tr[k].y / 5; }
  const scale = o.size / 0.09;
  const img = tr.map((q) => ({ x: o.cx + ((q.x - px) * scale) / o.aspect, y: o.cy - (q.y - py) * scale, z: q.z * scale }));
  let mx = 0, my = 0, mz = 0;
  for (const q of tr) { mx += q.x / 21; my += q.y / 21; mz += q.z / 21; }
  const world = tr.map((q) => ({ x: q.x - mx, y: -(q.y - my), z: q.z - mz }));
  return { landmarks: img, world, handedness: o.side === 'right' ? 'Right' : 'Left', score: 0.95 };
}
function lerpHand(a, b, k) {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const mix = (P, Q) => P.map((p, i) => ({ x: p.x + (Q[i].x - p.x) * k, y: p.y + (Q[i].y - p.y) * k, z: p.z + (Q[i].z - p.z) * k }));
  return { landmarks: mix(a.landmarks, b.landmarks), world: mix(a.world, b.world), handedness: a.handedness, score: 0.95 };
}
const SH = {
  open: { curls: [0, 0, 0, 0], thumb: 'out' },
  fist: { curls: [1, 1, 1, 1], thumb: 'in' },
  point: { curls: [0, 1, 1, 1], thumb: 'in' },
  victory: { curls: [0, 0, 1, 1], thumb: 'in' },
  ok: { curls: [0.45, 0, 0, 0], thumb: 'pinch' },
  okOpen: { curls: [0.45, 0, 0, 0], thumb: 'out' },        // кольцо разомкнуто
  okBentOut: { curls: [0.45, 0.62, 0.8, 0.85], thumb: 'out' }, // переход: сначала сгибаются пальцы, потом смыкается кольцо
  okBent: { curls: [0.45, 0.62, 0.8, 0.85], thumb: 'pinch' }, // кольцо есть, но три пальца согнуты
  sparkV: { curls: [0, 0, 1, 1], thumb: 'pinch' },          // «Искра» с выпрямленным средним: большой ещё у указательного
};
// крупная кисть по центру превью (в демо камеры нет — кисть и есть картинка)
const R0 = { side: 'right', cx: 0.47, cy: 0.56, size: 0.24 };
const L0 = { side: 'left', cx: 0.53, cy: 0.56, size: 0.24 };
// Сценарии демо: ключевые кадры { at (с), hands: { left?, right? } (параметры synthHand) }, между ними —
// плавный переход за morph с; петля длиной loop с. Пары «ошибка → исправление» — те же, что в тестах распознавателя.
const DEMO = {
  ok: { loop: 10.5, keys: [
    { at: 0, right: { ...R0, ...SH.okOpen } },
    { at: 2.8, morph: 0.45, right: { ...R0, ...SH.okBentOut } },
    { at: 3.25, morph: 0.4, right: { ...R0, ...SH.okBent } },
    { at: 5.8, morph: 0.6, right: { ...R0, ...SH.ok } },
    { at: 9.8, morph: 0.5, right: { ...R0, ...SH.okOpen } },
  ] },
  shield: { loop: 10, keys: [
    { at: 0, left: { ...L0, ...SH.open, palm: 'away', size: 0.2 } },
    { at: 2.6, morph: 0.7, left: { ...L0, ...SH.open, size: 0.2 } },
    { at: 5.2, morph: 0.18, left: { ...L0, ...SH.open, size: 0.27 } },
    { at: 8.8, morph: 0.8, left: { ...L0, ...SH.open, size: 0.2 } },
  ] },
  spark: { loop: 9, keys: [
    { at: 0, right: { ...R0, ...SH.fist } },
    { at: 1.4, morph: 0.12, right: { ...R0, ...SH.sparkV } },
    { at: 3.6, morph: 0.4, right: { ...R0, ...SH.fist } },
    { at: 5.0, morph: 0.12, right: { ...R0, ...SH.point } },
    { at: 8.2, morph: 0.4, right: { ...R0, ...SH.fist } },
  ] },
  burst: { loop: 8.5, keys: [
    { at: 0, right: { ...R0, ...SH.open } },
    { at: 1.0, morph: 0.08, right: { ...R0, ...SH.fist } },
    { at: 1.2, morph: 0.05, right: { ...R0, ...SH.open } },
    { at: 3.4, morph: 0.08, right: { ...R0, ...SH.fist } },
    { at: 4.7, morph: 0.05, right: { ...R0, ...SH.open } },
  ] },
  parry: { loop: 8.5, keys: [
    { at: 0, left: { ...L0, ...SH.open } },
    { at: 0.8, morph: 0.08, left: { ...L0, ...SH.fist } },
    { at: 1.4, morph: 0.08, left: { ...L0, ...SH.open, palm: 'away' } },
    { at: 3.4, morph: 0.3, left: { ...L0, ...SH.open } },
    { at: 4.0, morph: 0.08, left: { ...L0, ...SH.fist } },
    { at: 4.6, morph: 0.05, left: { ...L0, ...SH.open } },
  ] },
  orb: { loop: 10.5, keys: [
    { at: 0, left: { ...SH.open, side: 'left', cx: 0.65, cy: 0.55, size: 0.18, yaw: 0 }, right: { ...SH.open, side: 'right', cx: 0.35, cy: 0.55, size: 0.18, yaw: 0 } },
    { at: 2.8, morph: 0.4, left: { ...SH.open, side: 'left', cx: 0.65, cy: 0.38, size: 0.18, yaw: 0 }, right: { ...SH.open, side: 'right', cx: 0.35, cy: 0.7, size: 0.18, yaw: 0 } },
    { at: 3.2, morph: 0.5, left: { ...SH.open, side: 'left', cx: 0.65, cy: 0.38, size: 0.18, yaw: 1.2 }, right: { ...SH.open, side: 'right', cx: 0.35, cy: 0.7, size: 0.18, yaw: -1.2 } },
    { at: 5.8, morph: 0.7, left: { ...SH.open, side: 'left', cx: 0.65, cy: 0.55, size: 0.18, yaw: 1.2 }, right: { ...SH.open, side: 'right', cx: 0.35, cy: 0.55, size: 0.18, yaw: -1.2 } },
    { at: 9.8, morph: 0.5, left: { ...SH.open, side: 'left', cx: 0.65, cy: 0.55, size: 0.18, yaw: 0 }, right: { ...SH.open, side: 'right', cx: 0.35, cy: 0.55, size: 0.18, yaw: 0 } },
  ] },
};
function demoHands(sc, tSec) {
  const keys = sc.keys;
  let i = 0;
  while (i + 1 < keys.length && tSec >= keys[i + 1].at) i++;
  const cur = keys[i], prev = keys[i - 1] || keys[keys.length - 1];
  const k = cur.morph ? clamp((tSec - cur.at) / cur.morph, 0, 1) : 1;
  const out = {};
  for (const side of ['left', 'right']) {
    if (!cur[side]) continue;
    const b = synthHand(cur[side]);
    out[side] = prev[side] && k < 1 ? lerpHand(synthHand(prev[side]), b, k * k * (3 - 2 * k)) : b;
  }
  return out;
}
// Синтетическая поза отжимания сбоку (как dev/pushup.test.mjs): k — глубина 0…1, hip 'sag' | 'pike' | null.
export function synthPushupPose(k, hip = null) {
  const L = new Array(33).fill(null);
  const P = (x, y, v = 0.95) => ({ x, y, z: 0, visibility: v });
  const sy = 0.40 + k * 0.22, wy = 0.80;
  L[0] = P(0.36, sy - 0.02); L[11] = P(0.5, sy); L[12] = P(0.51, sy + 0.005, 0.6);
  L[13] = P(0.5 + k * 0.13, (sy + wy) / 2 - k * 0.03); L[14] = P(0.51 + k * 0.13, (sy + wy) / 2 - k * 0.03, 0.6);
  L[15] = P(0.5, wy); L[16] = P(0.51, wy, 0.6);
  const hipDy = hip === 'sag' ? 0.06 : hip === 'pike' ? -0.07 : 0;
  L[23] = P(0.78, sy + 0.04 + hipDy * Math.min(1, k * 3)); L[24] = P(0.79, sy + 0.04 + hipDy * Math.min(1, k * 3), 0.6);
  L[25] = P(0.93, sy + 0.064); L[26] = P(0.94, sy + 0.064, 0.6);
  return L;
}
// Демо упражнений: глубина и ошибка по времени петли.
const BODY_DEMO = {
  squat: { loop: 8, at(t) {
    const rep = (t0, dur) => { const u = clamp((t - t0) / dur, 0, 1); return 0.5 - 0.5 * Math.cos(2 * Math.PI * u); };
    if (t < 1.2) return { k: 0, o: {} };
    if (t < 3.4) return { k: rep(1.2, 2.2), o: { valgus: true } };
    if (t < 4.2) return { k: 0, o: {} };
    if (t < 6.4) return { k: rep(4.2, 2.2), o: {} };
    return { k: 0, o: {} };
  } },
  pushup: { loop: 7.5, at(t) {
    const rep = (t0, dur) => { const u = clamp((t - t0) / dur, 0, 1); return 0.5 - 0.5 * Math.cos(2 * Math.PI * u); };
    if (t < 1.2) return { k: 0, hip: null };
    if (t < 2.8) return { k: rep(1.2, 1.6), hip: 'sag' };
    if (t < 3.8) return { k: 0, hip: null };
    if (t < 5.4) return { k: rep(3.8, 1.6), hip: null };
    return { k: 0, hip: null };
  } },
};

// ───────────────────────── логика тренажёра ─────────────────────────
const IDEAL_SHOW_MS = 1800;
const TRANSIENT_MS = 1500;   // условие-движение (толчок, резкое раскрытие) зелёное столько после выполнения

export function createTechniqueTrainer() {
  let gid = 'ok';
  let demoUser = false;   // демо включил игрок (или отладка с клавиатуры)
  let autoOn = false;     // демо само, пока камера включается
  const d = { interp: null, squat: null, pushup: null, t0: null, simT: 0, lastLoop: -1, hands: null, pose: null };
  const live = { squat: createSquatCounter(), pushup: createPushupCounter(), lastPoseT: null };
  let latch = {};
  let ideal = { at: -1e9, count: 0, was: false, recognizedWas: false };

  function resetProgress() { latch = {}; ideal = { at: -1e9, count: 0, was: false, recognizedWas: false }; }
  function resetDemo() { d.interp = null; d.squat = null; d.pushup = null; d.t0 = null; d.simT = 0; d.lastLoop = -1; d.hands = null; d.pose = null; }
  function reset() { live.squat.reset(); live.pushup.reset(); live.lastPoseT = null; resetDemo(); resetProgress(); }

  // демо: синтетические кадры 30 к/с до текущего времени петли, через настоящий распознаватель
  function demoStep(now) {
    const g = BY_ID[gid];
    if (d.t0 === null) d.t0 = now;
    const elapsed = Math.max(0, (now - d.t0) / 1000);
    if (g.kind === 'body') {
      const sc = BODY_DEMO[gid];
      const loopN = Math.floor(elapsed / sc.loop);
      const counter = gid === 'squat' ? (d.squat || (d.squat = createSquatCounter())) : (d.pushup || (d.pushup = createPushupCounter()));
      if (loopN !== d.lastLoop) { counter.reset(); d.lastLoop = loopN; d.simT = loopN * sc.loop * 1000; resetProgress(); }
      const target = elapsed * 1000;
      let steps = 0;
      while (d.simT + 33 <= target && steps < 12) {
        d.simT += 33; steps++;
        const tl = (d.simT / 1000) % sc.loop;
        const s = sc.at(tl);
        const lm = gid === 'squat' ? synthSquatPose(s.k, 'front', s.o) : synthPushupPose(s.k, s.hip);
        counter.push({ tMs: d.simT + 1000, landmarks: lm, frameW: 640, frameH: 480 });
        d.pose = { tMs: d.simT + 1000, landmarks: lm, frameW: 640, frameH: 480, mirror: true };
      }
      if (d.simT + 33 <= target) d.t0 += target - d.simT;   // медленные кадры или скрытая вкладка: демо замедляется, а не прыгает
      return { counter };
    }
    const sc = DEMO[gid];
    const loopN = Math.floor(elapsed / sc.loop);
    if (!d.interp || loopN !== d.lastLoop) { d.interp = createHandGestures(); d.lastLoop = loopN; d.simT = loopN * sc.loop * 1000; resetProgress(); }
    const target = elapsed * 1000;
    let steps = 0;
    while (d.simT + 33 <= target && steps < 12) {
      d.simT += 33; steps++;
      const hs = demoHands(sc, (d.simT / 1000) % sc.loop);
      const arr = [hs.left, hs.right].filter(Boolean);
      d.interp.push({ tMs: d.simT + 1000, frameW: 640, frameH: 480, mirror: true, hands: arr, poseWrists: null, bodyCenter: null, shoulderWidth: 0.35 });
      d.hands = hs;
    }
    if (d.simT + 33 <= target) d.t0 += target - d.simT;   // без скачков: пропуск кадров распознаватель счёл бы потерей кисти
    const t = d.simT + 1000;
    return { checks: typeof d.interp.checks === 'function' ? d.interp.checks(t) : null, peek: d.interp.peek(t) };
  }

  // Условия жеста рук → строки чек-листа. Условия-движения «защёлкиваются» на TRANSIENT_MS после выполнения.
  function handRows(gc, now) {
    const items = gc && Array.isArray(gc.items) ? gc.items.filter((it) => isObj(it) && typeof it.key === 'string') : [];
    return items.map((it) => {
      const key = `${gid}.${it.key}`;
      let value = fin(it.value) ? clamp(it.value, 0, 1) : 0;
      let ok = it.ok === true ? true : it.ok === false ? false : null;
      if (it.transient) {
        const L = latch[key] || (latch[key] = { okAt: -1e9, best: 0, bestAt: -1e9 });
        if (ok) L.okAt = now;
        if (value >= L.best || now - L.bestAt > TRANSIENT_MS) { L.best = value; L.bestAt = now; }
        if (now - L.okAt < TRANSIENT_MS) { ok = true; value = 1; } else value = Math.max(value, L.best);
      }
      return { key: it.key, label: (LABELS[gid] && LABELS[gid][it.key]) || it.label || it.key, value, ok, hint: it.hint || null, landmarks: Array.isArray(it.landmarks) ? it.landmarks : [], hand: it.hand || BY_ID[gid].hand, links: ITEM_LINKS[key] || [] };
    });
  }
  function bodyRows(ck) {
    const items = ck && Array.isArray(ck.items) ? ck.items.filter((it) => isObj(it) && typeof it.key === 'string') : [];
    const keyHint = gid === 'squat' ? SQUAT_KEY_HINT : PUSHUP_KEY_HINT;
    return items.map((it) => ({
      key: it.key, label: (LABELS[gid] && LABELS[gid][it.key]) || it.key,
      value: fin(it.value) ? clamp(it.value, 0, 1) : 0,
      ok: it.ok === true ? true : it.ok === false ? false : null,
      hint: it.hint || keyHint[it.key] || it.key, landmarks: Array.isArray(it.landmarks) ? it.landmarks : [], hand: 'pose', links: [],
    }));
  }

  function frame(nowMs, liveIn) {
    const now = fin(nowMs) ? nowMs : 0;
    const g = BY_ID[gid];
    const demoOn = demoUser || autoOn;
    const src = demoOn ? (demoUser ? 'demo' : 'demo-auto') : liveIn ? 'camera' : 'none';
    let rows = [], recognized = false, present = false, clean = 0, message = '';
    let hands = null, pose = null;
    if (g.kind === 'hand') {
      let gc = null;
      if (demoOn) {
        const r = demoStep(now);
        gc = r.checks && r.checks[gid];
        hands = d.hands ? { left: d.hands.left ? { landmarks: d.hands.left.landmarks.map((p) => ({ x: 1 - p.x, y: p.y })) } : null, right: d.hands.right ? { landmarks: d.hands.right.landmarks.map((p) => ({ x: 1 - p.x, y: p.y })) } : null } : null;
        const pk = r.peek;
        if (pk && ((gid === 'spark' && pk.spark) || (gid === 'burst' && pk.burst) || (gid === 'parry' && pk.parry))) recognized = true;
      } else if (liveIn) {
        const ck = liveIn.checks;
        gc = ck && ck[gid];
        hands = liveIn.hands || null;
      }
      if (gc) { present = !!gc.present; recognized = recognized || !!gc.recognized; }
      rows = handRows(gc, now);
      if (!present && !demoOn) message = g.hand === 'both' ? 'Покажите камере обе ладони' : `Покажите камере ${g.hand === 'left' ? 'левую' : 'правую'} руку`;
    } else {
      let counter = null;
      if (demoOn) { counter = demoStep(now).counter; pose = d.pose; }
      else if (liveIn && liveIn.pose && Array.isArray(liveIn.pose.landmarks)) {
        counter = gid === 'squat' ? live.squat : live.pushup;
        const p = liveIn.pose;
        if (p.tMs !== live.lastPoseT) { live.lastPoseT = p.tMs; counter.push({ tMs: p.tMs, landmarks: p.landmarks, frameW: p.frameW, frameH: p.frameH }); }
        pose = p;
      } else counter = gid === 'squat' ? live.squat : live.pushup;
      const r = counter.read();
      clean = counter.drain().length;
      rows = bodyRows(r.checks);
      present = r.phase !== 'noPose' && r.state !== 'noPose';
      if (clean > 0) recognized = true;
      message = typeof r.message === 'string' && !/^\d+$/.test(r.message) ? r.message : '';
    }
    // «Идеально!» — только когда распознаватель жест действительно засчитал (у упражнений — чистый повтор):
    // зелёный чек-лист без распознавания (переход между позами, условия-движения ещё «защёлкнуты») — не идеал
    const judged = rows.filter((r) => r.ok !== null);
    const allOk = judged.length > 0 && judged.every((r) => r.ok);
    const nowIdeal = recognized;
    if (nowIdeal && !ideal.was) { ideal.count++; ideal.at = now; }
    if (nowIdeal) ideal.at = now;
    ideal.was = nowIdeal;
    const showIdeal = now - ideal.at < IDEAL_SHOW_MS;
    // что исправить: первое невыполненное условие
    const bad = present || g.kind === 'body' || !demoOn ? rows.find((r) => r.ok === false) : null;   // демо: кадр перезапуска петли без кисти — не ошибка
    const focus = !showIdeal && bad ? fixInfo(g.kind === 'body' ? gid : 'hand', bad.hint) : null;
    if (focus) focus.key = bad.key;
    // отметки на превью: точки условий (зелёные/красные), метка — у того, что исправить
    const marks = rows.filter((r) => r.landmarks.length && r.ok !== null).map((r) => ({
      hand: r.hand === 'both' ? 'both' : r.hand, points: r.landmarks, links: r.links, ok: r.ok, label: bad && r.key === bad.key && focus ? (focus.mark || focus.fix || '').toUpperCase() : '',
    })).flatMap((m) => (m.hand === 'both' ? [{ ...m, hand: 'left' }, { ...m, hand: 'right' }] : [m]));
    return {
      id: gid, title: g.title, hand: g.hand, handName: HAND_NAME[g.hand] || '', kind: g.kind, how: g.how,
      source: src, demo: demoOn, demoAuto: demoOn && !demoUser, present, recognized, allOk, rows, focus,
      ideal: showIdeal, idealCount: ideal.count, message,
      marks, synthHands: demoOn ? hands : null, synthPose: demoOn ? pose : null,
    };
  }

  return {
    get gesture() { return gid; },
    get demo() { return demoUser || autoOn; },
    select(id) { if (!BY_ID[id] || id === gid) return; gid = id; reset(); },
    setDemo(on) { const v = !!on; if (v === demoUser) return; demoUser = v; reset(); },
    // демо, пока камера включается (модель грузится несколько секунд): твист виден сразу
    setAuto(on) { const v = !!on; if (v === autoOn) return; autoOn = v; if (!demoUser) reset(); },
    reset,
    frame,
  };
}

// ───────────────────────── экран (DOM, внутри ui.js) ─────────────────────────
// kit: { uid, el, btn, setBtn, listen, heading, screenSection, statusLine, paintStatus, describe(tr) → info, setText,
//        setHidden, setAttr, setClass, setStyle, invoke, announce, pressEnable, cameraStarting:[…], debugInfo }
const DEMO_INFO = Object.freeze({ tone: 'debug', label: 'Демо: тот же распознаватель, без камеры' });
export function createTechniqueScreen(kit) {
  const { el, btn, setText, setHidden, setAttr, setClass, setStyle, invoke } = kit;
  const uid = kit.uid || 'ao';
  const hid = `${uid}-tech-h`;
  const h = kit.heading('h2', hid, 'Тренажёр техники', 'ao-h2');
  const lead = el('p', { class: 'ao-lead', text: 'Покажите жест камере: игра проверяет каждое условие и говорит, что исправить — как режим «ОШИБКА» в бою.' });
  const chips = {};
  const chipRow = el('div', { class: 'ao-tt__chips', role: 'group', 'aria-label': 'Жест' });
  for (const g of TRAINER_GESTURES) {
    const b = el('button', { type: 'button', class: 'ao-tt__chip', 'aria-pressed': 'false', 'data-id': g.id },
      el('span', { class: 'ao-tt__chipic', 'aria-hidden': 'true', html: gestureIcon(g.id) }),
      el('span', { class: 'ao-tt__chiplab', text: g.chip }));
    kit.listen(b, 'click', () => invoke('onTechniqueGesture', g.id));
    chips[g.id] = b;
    chipRow.append(b);
  }
  const host = el('div', { class: 'ao-slothost ao-tt__cam' });
  const srcTag = el('span', { class: 'ao-tt__src' });
  const status = kit.statusLine();
  const enable = btn('Разрешить камеру', () => kit.pressEnable(), { variant: 'primary', iconName: 'camera' });
  const demoBtn = btn('Демо без камеры', () => invoke('onTechniqueDemo', !state.demo), { variant: 'secondary' });
  const title = el('h3', { class: 'ao-tt__title' });
  const handTag = el('span', { class: 'ao-tt__hand' });
  const how = el('p', { class: 'ao-tt__how' });
  const list = el('ul', { class: 'ao-tt__list', 'aria-label': 'Условия жеста' });
  const vIdeal = el('div', { class: 'ao-tt__ideal', hidden: true },
    el('strong', { class: 'ao-tt__idealh', text: 'Идеально!' }),
    el('span', { class: 'ao-tt__idealt' }));
  const vPic = el('div', { class: 'ao-tt__pic', 'aria-hidden': 'true' });
  const vFix = el('strong', { class: 'ao-tt__fix' });
  const vText = el('p', { class: 'ao-tt__text' });
  const vFixBox = el('div', { class: 'ao-tt__fixbox', hidden: true }, vPic, el('div', { class: 'ao-tt__fixbody' }, el('span', { class: 'ao-tt__fixk', text: 'Ошибка — исправь' }), vFix, vText));
  const vWait = el('p', { class: 'ao-tt__wait', hidden: true });
  const counter = el('p', { class: 'ao-note ao-tt__count' });
  const back = btn('В меню', () => invoke('onBack'), { variant: 'quiet' });
  // слева — превью камеры с подсветкой и крупный вердикт под ним, справа — чек-лист условий
  const panel = el('div', { class: 'ao-panel ao-panel--tech ao-frame' },
    el('div', { class: 'ao-tt__top' }, el('div', { class: 'ao-head' }, h, lead), back.node),
    chipRow,
    el('div', { class: 'ao-cols ao-tt__cols' },
      el('div', { class: 'ao-col ao-col--media ao-tt__left' }, host, el('div', { class: 'ao-tt__under' }, srcTag, status.node), vIdeal, vFixBox, vWait),
      el('div', { class: 'ao-col ao-tt__main' },
        el('div', { class: 'ao-tt__head' }, title, handTag),
        how, list, counter,
        el('div', { class: 'ao-actions ao-actions--inline' }, enable.node, demoBtn.node))));
  const state = { id: null, demo: false, rows: [], focusKey: '', idealWas: false };

  function buildRows(rows) {
    state.rows = rows.map((r) => {
      const mark = el('span', { class: 'ao-tt__mk', 'aria-hidden': 'true' });
      const fill = el('span', { class: 'ao-tt__fill' });
      const pctEl = el('span', { class: 'ao-tt__pct' });
      const node = el('li', { class: 'ao-tt__item', 'data-ok': 'na', 'data-key': r.key }, mark, el('span', { class: 'ao-tt__lab', text: r.label }), el('span', { class: 'ao-tt__bar', 'aria-hidden': 'true' }, fill), pctEl);
      return { key: r.key, node, mark, fill, pctEl, ok: undefined };
    });
    list.replaceChildren(...state.rows.map((x) => x.node));
  }

  return {
    section: kit.screenSection('technique', panel, hid),
    heading: h,
    host,
    focus: () => chips[state.id || 'ok'] || back.node,
    update(ctx) {
      const v = ctx.vm.technique && typeof ctx.vm.technique === 'object' ? ctx.vm.technique : null;
      const st = ctx.tr.status;
      const camOn = ['ready', 'lost', 'calibrating'].includes(st);
      kit.paintStatus(status, v && v.demo ? DEMO_INFO : ctx.debug ? kit.debugInfo : kit.describe(ctx.tr), '');
      setAttr(host, 'data-tone', v && v.ideal ? 'good' : v && v.focus ? 'bad' : ctx.debug ? 'debug' : kit.describe(ctx.tr).tone);
      kit.setBtn(enable, { hidden: ctx.debug || camOn || !!(v && v.demo && !v.demoAuto), disabled: kit.cameraStarting.includes(st) });
      if (!v) return;
      state.demo = v.demo && !v.demoAuto;   // кнопка переключает только демо, выбранное игроком
      // в «Отладке с клавиатуры» камеры нет — демо включено всегда
      kit.setBtn(demoBtn, { label: v.demo && !v.demoAuto ? (ctx.debug ? 'Демо (отладка без камеры)' : 'Вернуться к камере') : 'Демо без камеры', disabled: ctx.debug });
      const who = v.kind === 'body' ? 'синтетическая поза' : 'синтетическая кисть';
      setText(srcTag, v.demoAuto ? `ДЕМО, пока включается камера · ${who}` : v.demo ? `ДЕМО · ${who} проходит путь «ошибка → исправление»` : camOn ? 'КАМЕРА · вживую' : '');
      setHidden(srcTag, !(v.demo || camOn));
      if (v.id !== state.id) {
        state.id = v.id;
        for (const [id, b] of Object.entries(chips)) setAttr(b, 'aria-pressed', id === v.id ? 'true' : 'false');
        setText(title, v.title);
        setText(handTag, v.handName);
        setText(how, v.how);
        state.rows = [];
      }
      if (state.rows.length !== v.rows.length || state.rows.some((r, i) => r.key !== v.rows[i].key)) buildRows(v.rows);
      v.rows.forEach((r, i) => {
        const x = state.rows[i];
        const okS = r.ok === true ? 'yes' : r.ok === false ? 'no' : 'na';
        if (x.ok !== okS) { x.ok = okS; setAttr(x.node, 'data-ok', okS); setText(x.mark, okS === 'yes' ? '✓' : okS === 'no' ? '✗' : '–'); }
        const pct = Math.round(r.value * 100);
        setStyle(x.fill, 'width', `${pct}%`);
        setText(x.pctEl, okS === 'na' ? '—' : `${pct}%`);
        setClass(x.node, 'is-focus', !!v.focus && v.focus.key === r.key);
      });
      setHidden(vIdeal, !v.ideal);
      if (v.ideal) {
        setText(vIdeal.lastChild, v.kind === 'body' ? 'Чистый повтор — все условия выполнены' : 'Жест распознан — все условия выполнены');
        if (!state.idealWas) kit.announce('Идеально!');
      }
      state.idealWas = v.ideal;
      setHidden(vFixBox, !v.focus);
      if (v.focus) {
        if (state.focusKey !== v.focus.code) {
          state.focusKey = v.focus.code;
          vPic.innerHTML = v.focus.pictogram || '';   // SVG из core/coachPictograms.js
          kit.announce(`Ошибка: ${v.focus.fix || v.focus.text}`);
        }
        setText(vFix, v.focus.fix || '');
        setText(vText, v.focus.text || '');
      } else state.focusKey = '';
      const waitText = !v.ideal && !v.focus ? (v.message || (v.present ? 'Держите жест — условия проверяются…' : '')) : '';
      setText(vWait, waitText);
      setHidden(vWait, !waitText);
      setText(counter, v.idealCount ? `Идеально получилось: ${v.idealCount} ${v.idealCount % 10 === 1 && v.idealCount % 100 !== 11 ? 'раз' : [2, 3, 4].includes(v.idealCount % 10) && ![12, 13, 14].includes(v.idealCount % 100) ? 'раза' : 'раз'}` : '');
    },
  };
}
