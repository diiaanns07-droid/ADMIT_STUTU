// Тесты счётчика отжиманий (core/pushupCounter.js) на синтетической позе. node dev/pushup.test.mjs
// Синтетика, не реальная камера: форма позы — схема вида спереди и сбоку.
import { createPushupCounter } from '../core/pushupCounter.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

const P = (x, y, v = 0.95) => ({ x, y, z: 0, visibility: v });
// k — глубина 0 (верх) … 1 (низ). view: 'front' | 'side'. o: { scale, cx, cy, wristFollow, noWrists, elbowBend }
function pose(k, view, o = {}) {
  const L = new Array(33).fill(null);
  const sc = o.scale ?? 1, cx = o.cx ?? 0.5, cy = o.cy ?? 0.6;
  const T = (x, y) => ({ x: cx + (x - 0.5) * sc, y: cy + (y - 0.6) * sc });
  const put = (i, x, y, v) => { const p = T(x, y); L[i] = P(p.x, p.y, v); };
  const bend = o.elbowBend ?? k;
  if (view === 'front') {
    const sy = 0.45 + k * 0.27, wy = 0.85 - (o.wristFollow ? k * 0.3 : 0);
    put(0, 0.5, sy - 0.12); put(11, 0.625, sy); put(12, 0.375, sy);
    put(13, 0.64 + bend * 0.1, (sy + wy) / 2 + bend * 0.05); put(14, 0.36 - bend * 0.1, (sy + wy) / 2 + bend * 0.05);
    if (!o.noWrists) { put(15, 0.65, wy); put(16, 0.35, wy); }
    put(23, 0.6, sy + 0.05, 0.3); put(24, 0.4, sy + 0.05, 0.3);
  } else {
    const sy = 0.40 + k * 0.22, wy = 0.80 - (o.wristFollow ? k * 0.25 : 0);
    put(0, 0.36, sy - 0.02); put(11, 0.5, sy); put(12, 0.51, sy + 0.005, 0.6);
    put(13, 0.5 + bend * 0.13, (sy + wy) / 2 - bend * 0.03); put(14, 0.51 + bend * 0.13, (sy + wy) / 2 - bend * 0.03, 0.6);
    if (!o.noWrists) { put(15, 0.5, wy); put(16, 0.51, wy, 0.6); }
    const hipDy = o.hip === 'sag' ? 0.06 : o.hip === 'pike' ? -0.07 : 0;  // [ОШИБКА] таз ниже/выше линии тела
    put(23, 0.78, sy + 0.04 + hipDy * Math.min(1, k * 3)); put(24, 0.79, sy + 0.04 + hipDy * Math.min(1, k * 3), 0.6);
    put(25, 0.93, sy + 0.064); put(26, 0.94, sy + 0.064, 0.6);
  }
  return L;
}
// Прогон: reps повторов (вниз downS, вверх upS, пауза наверху holdS) после 1 с стойки наверху.
function run(c, view, reps, o = {}) {
  const fps = o.fps ?? 30, dt = 1000 / fps;
  const downS = o.downS ?? 0.7, upS = o.upS ?? 0.7, holdS = o.holdS ?? 0.35, depth = o.depth ?? 1;
  let t = o.t0 ?? 1000;
  const frame = (k, extra = {}) => { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: pose(k, view, { ...o, ...extra }) }); t += dt; };
  for (let i = 0; i < fps * 1; i++) frame(0);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < fps * downS; i++) frame(depth * (0.5 - 0.5 * Math.cos(Math.PI * i / (fps * downS))));
    for (let i = 0; i < fps * upS; i++) frame(depth * (0.5 + 0.5 * Math.cos(Math.PI * i / (fps * upS))));
    for (let i = 0; i < fps * holdS; i++) frame(0);
  }
  return t;
}

test('[ОШИБКА] вид сбоку: таз провисает → не засчитано, подсказка «таз провисает»', () => {
  const c = createPushupCounter();
  run(c, 'side', 3, { hip: 'sag' });
  const r = c.read();
  assert(r.reps === 0 && r.faults.sag === 3, 'reps ' + r.reps + ' ' + JSON.stringify(r.faults) + ' line ' + r.line);
  assert(/провисает/.test(r.message), r.message);
});

test('[ОШИБКА] вид сбоку: таз задран → не засчитано, подсказка «таз задран»', () => {
  const c = createPushupCounter();
  run(c, 'side', 2, { hip: 'pike' });
  const r = c.read();
  assert(r.reps === 0 && r.faults.pike === 2, 'reps ' + r.reps + ' ' + JSON.stringify(r.faults));
  assert(/задран/.test(r.message), r.message);
});

test('вид спереди: 10 чистых повторов = 10', () => {
  const c = createPushupCounter();
  run(c, 'front', 10);
  const r = c.read();
  assert(r.reps === 10, 'reps ' + r.reps + ' ' + JSON.stringify(c.getDebug()));
  assert(r.state === 'up' && r.rejected === 0, 'состояние');
});

test('вид сбоку: 8 повторов = 8; drain отдаёт каждый повтор один раз', () => {
  const c = createPushupCounter();
  run(c, 'side', 8);
  const d = c.drain();
  assert(c.read().reps === 8 && d.length === 8 && d[7].rep === 8, 'reps ' + c.read().reps + ' drain ' + d.length);
  assert(c.drain().length === 0, 'второй drain пуст');
  assert(d.every((x) => x.depth > 0.4 && x.ms >= 400), 'глубина и длительность в событии');
});

test('мелкие повторы (25% хода) не считаются, подсказка «ниже»', () => {
  const c = createPushupCounter();
  run(c, 'front', 6, { depth: 0.3, elbowBend: 0.2 });
  const r = c.read();
  assert(r.reps === 0 && r.shallow >= 5 && /Ниже/.test(r.message), JSON.stringify(r));
});

test('слишком быстро (0,15 с вниз и вверх) — не засчитано', () => {
  const c = createPushupCounter();
  run(c, 'front', 5, { downS: 0.15, upS: 0.15 });
  const r = c.read();
  assert(r.reps === 0 && r.rejected >= 4 && r.lastRep.reason === 'fast', JSON.stringify(r));
});

test('кисти едут вместе с плечами (сгибание рук стоя) — не упор, не засчитано', () => {
  const c = createPushupCounter();
  run(c, 'front', 5, { wristFollow: true });
  const r = c.read();
  assert(r.reps === 0, 'reps ' + r.reps + ' ' + JSON.stringify(r));
});

test('дрожь наверху (±1%) не даёт повторов', () => {
  const c = createPushupCounter();
  let t = 1000;
  for (let i = 0; i < 300; i++) { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: pose(Math.abs(Math.sin(i * 1.7)) * 0.04, 'front') }); t += 33; }
  assert(c.read().reps === 0 && c.read().state === 'up', JSON.stringify(c.read()));
});

test('пропали кисти → noPose; вернулись — счёт продолжается', () => {
  const c = createPushupCounter();
  let t = run(c, 'front', 3);
  for (let i = 0; i < 40; i++) { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: pose(0.5, 'front', { noWrists: true }) }); t += 33; }
  assert(c.read().state === 'noPose', 'noPose: ' + c.read().state);
  run(c, 'front', 2, { t0: t + 33 });
  assert(c.read().reps === 5, 'reps ' + c.read().reps);
});

test('локоть согнут < 100° при умеренной глубине — тоже низ', () => {
  const c = createPushupCounter({ downLevel: 0.4 });
  run(c, 'side', 4, { depth: 0.75, elbowBend: 1 });
  assert(c.read().reps === 4, 'reps ' + c.read().reps + ' elbow ' + c.read().elbow);
});

test('человек дальше от камеры (масштаб 0,6) и сбоку кадра — счёт тот же', () => {
  const c = createPushupCounter();
  run(c, 'front', 6, { scale: 0.6, cx: 0.35, cy: 0.62 });
  assert(c.read().reps === 6, 'reps ' + c.read().reps);
});

test('медленные повторы (2,5 с вниз, 2 с вверх) считаются; 15 fps тоже', () => {
  const c = createPushupCounter();
  run(c, 'front', 3, { downS: 2.5, upS: 2 });
  assert(c.read().reps === 3, 'медленные ' + c.read().reps);
  const c2 = createPushupCounter();
  run(c2, 'side', 4, { fps: 15 });
  assert(c2.read().reps === 4, '15 fps ' + c2.read().reps);
});

test('мусорный ввод не бросает; время назад игнорируется', () => {
  const c = createPushupCounter();
  for (const x of [null, undefined, 5, {}, { tMs: NaN }, { tMs: 1, landmarks: 'x' }, { tMs: 2, landmarks: [null, { x: NaN }] }, { tMs: 3, landmarks: new Array(33).fill({ x: 0.5, y: 0.5, visibility: 'a' }) }]) c.push(x);
  c.push({ tMs: 100, landmarks: pose(0, 'front') });
  c.push({ tMs: 50, landmarks: pose(1, 'front') });
  const r = c.read();
  assert(r.reps === 0 && typeof r.message === 'string', JSON.stringify(r));
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed (синтетика, не реальная камера)`);
if (pass !== tests.length) process.exitCode = 1;
