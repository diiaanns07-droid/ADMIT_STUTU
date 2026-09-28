// Тесты счётчика приседаний (core/squatCounter.js) на синтетической позе. node dev/squat.test.mjs
// Синтетика, не реальная камера: поза — схема вида спереди и сбоку (synthSquatPose).
import { createSquatCounter, synthSquatPose, topSquatFault, SQUAT_HINTS } from '../core/squatCounter.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

// Прогон: reps повторов (вниз downS, вверх upS, пауза наверху holdS) после 1 с стойки.
// o.depth — глубина (1 — ниже параллели); o.topK — докуда выпрямляется между повторами.
function run(c, view, reps, o = {}) {
  const fps = o.fps ?? 30, dt = 1000 / fps;
  const downS = o.downS ?? 1.0, upS = o.upS ?? 0.8, holdS = o.holdS ?? 0.4, depth = o.depth ?? 1, topK = o.topK ?? 0;
  let t = o.t0 ?? 1000;
  const frame = (k) => { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: synthSquatPose(k, view, o) }); t += dt; };
  for (let i = 0; i < fps * 1; i++) frame(0);
  let from = 0;
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < fps * downS; i++) { const u = 0.5 - 0.5 * Math.cos(Math.PI * i / (fps * downS)); frame(from + (depth - from) * u); }
    const to = r === reps - 1 ? 0 : topK;
    for (let i = 0; i < fps * upS; i++) { const u = 0.5 - 0.5 * Math.cos(Math.PI * i / (fps * upS)); frame(depth + (to - depth) * u); }
    for (let i = 0; i < fps * holdS; i++) frame(to);
    from = to;
  }
  for (let i = 0; i < fps * 0.6; i++) frame(0);
  return t;
}

test('вид спереди: 8 чистых повторов = 8, оценка техники 100%', () => {
  const c = createSquatCounter();
  run(c, 'front', 8);
  const r = c.read();
  assert(r.reps === 8 && r.attempts === 8 && r.formScore === 1, JSON.stringify(c.getDebug()));
  assert(r.view === 'front' && r.phase === 'top' && r.lastHint === null, 'вид/фаза/подсказка ' + r.view + ' ' + r.phase);
});

test('вид сбоку: 6 повторов = 6; drain отдаёт каждый повтор один раз', () => {
  const c = createSquatCounter();
  run(c, 'side', 6);
  const d = c.drain();
  assert(c.read().reps === 6 && d.length === 6 && d[5].rep === 6, 'reps ' + c.read().reps + ' drain ' + d.length + ' ' + JSON.stringify(c.getDebug()));
  assert(c.drain().length === 0, 'второй drain пуст');
  assert(d.every((x) => x.minKnee <= 100 && x.ms >= 800), 'угол и длительность в событии ' + JSON.stringify(d[0]));
  assert(c.read().view === 'side', 'вид ' + c.read().view);
});

test('глубина и угол колена: наверху ~180° и 0, внизу ≤100° и 1', () => {
  const c = createSquatCounter();
  let t = 1000;
  for (let i = 0; i < 40; i++) { c.push({ tMs: t, landmarks: synthSquatPose(0, 'side') }); t += 33; }
  assert(c.read().knee >= 175 && c.read().depth === 0, 'верх ' + JSON.stringify(c.read()));
  for (let i = 0; i < 20; i++) { c.push({ tMs: t, landmarks: synthSquatPose(i / 19, 'side') }); t += 50; }
  for (let i = 0; i < 10; i++) { c.push({ tMs: t, landmarks: synthSquatPose(1, 'side') }); t += 33; }
  assert(c.read().knee <= 100 && c.read().depth === 1, 'низ ' + JSON.stringify(c.read()));
});

for (const view of ['front', 'side']) {
  test(`${view}: неглубоко — не засчитано, «Садись глубже»`, () => {
    const c = createSquatCounter();
    run(c, view, 4, { depth: 0.5 });
    const r = c.read();
    assert(r.reps === 0 && r.attempts === 4 && r.faults.shallow === 4, JSON.stringify(r));
    assert(r.lastHint && r.lastHint.code === 'shallow' && r.lastHint.text === SQUAT_HINTS.shallow, 'подсказка');
  });
}

test('спереди: колени внутрь — valgus с подсказкой', () => {
  const c = createSquatCounter();
  run(c, 'front', 3, { valgus: 1 });
  const r = c.read();
  assert(r.reps === 0 && r.faults.valgus === 3 && r.lastHint.code === 'valgus', JSON.stringify(r));
  assert(/Колени заваливаются внутрь/.test(r.lastHint.text), r.lastHint.text);
});

test('сбоку: колени за носки — knees_forward', () => {
  const c = createSquatCounter();
  run(c, 'side', 3, { kneesForward: 1 });
  const r = c.read();
  assert(r.reps === 0 && r.faults.knees_forward === 3 && r.lastHint.code === 'knees_forward', JSON.stringify(r));
});

for (const view of ['side', 'front']) {
  test(`${view}: корпус падает вперёд — lean`, () => {
    const c = createSquatCounter();
    run(c, view, 3, { lean: 1 });
    const r = c.read();
    assert(r.reps === 0 && r.faults.lean === 3 && r.lastHint.code === 'lean', JSON.stringify(r));
  });
}

test('пятки отрываются — heels', () => {
  const c = createSquatCounter();
  run(c, 'side', 2, { heels: 1 });
  const r = c.read();
  assert(r.reps === 0 && r.faults.heels === 2 && r.lastHint.code === 'heels', JSON.stringify(r));
});

test('слишком быстро (0,3 с вниз и вверх) — fast', () => {
  const c = createSquatCounter();
  run(c, 'front', 4, { downS: 0.3, upS: 0.3 });
  const r = c.read();
  assert(r.reps === 0 && r.faults.fast === 4 && r.lastHint.code === 'fast', JSON.stringify(r));
});

test('не выпрямляется наверху между повторами — lockout; последний (выпрямился) засчитан', () => {
  const c = createSquatCounter();
  run(c, 'side', 4, { topK: 0.25, holdS: 0.1 });
  const r = c.read();
  assert(r.faults.lockout === 3 && r.reps === 1 && r.attempts === 4, JSON.stringify(r));
  assert(r.formScore === 0.25, 'formScore ' + r.formScore);
});

test('завис на подъёме, не выпрямившись, — lockout по таймеру', () => {
  const c = createSquatCounter();
  let t = 1000;
  const f = (k) => { c.push({ tMs: t, landmarks: synthSquatPose(k, 'front') }); t += 33; };
  for (let i = 0; i < 30; i++) f(0);
  for (let i = 0; i < 30; i++) f(i / 29);
  for (let i = 0; i < 20; i++) f(1 - 0.75 * i / 19);
  for (let i = 0; i < 70; i++) f(0.25);
  const r = c.read();
  assert(r.faults.lockout === 1 && r.reps === 0 && r.lastHint.code === 'lockout', JSON.stringify(r));
  assert(r.lastHint.text === 'Выпрямись полностью наверху', r.lastHint.text);
});

test('ног не видно (нет лодыжек) → frame; вернулись — счёт продолжается', () => {
  const c = createSquatCounter();
  let t = run(c, 'front', 2);
  for (let i = 0; i < 30; i++) {
    const L = synthSquatPose(0, 'front');
    for (const j of [27, 28, 29, 30, 31, 32]) L[j] = { ...L[j], visibility: 0.1 };
    c.push({ tMs: t, landmarks: L }); t += 33;
  }
  const r = c.read();
  assert(r.phase === 'noPose' && r.lastHint.code === 'frame' && /до стоп/.test(r.message) && r.faults.frame === 1, JSON.stringify(r));
  run(c, 'front', 2, { t0: t + 33 });
  assert(c.read().reps === 4, 'reps ' + c.read().reps);
});

test('несколько ошибок: подсказка — про главную; самая частая ошибка для итога', () => {
  const c = createSquatCounter();
  run(c, 'front', 2, { valgus: 1, downS: 0.3, upS: 0.3 });
  const r = c.read();
  assert(r.lastRep.faults.includes('valgus') && r.lastRep.faults.includes('fast') && r.lastHint.code === 'valgus', JSON.stringify(r.lastRep));
  run(c, 'front', 3, { lean: 1, t0: 100000 });
  const top = topSquatFault(c.read().faults);
  assert(top && top.code === 'lean' && top.count === 3 && top.text === SQUAT_HINTS.lean, JSON.stringify(top));
  assert(topSquatFault({}) === null, 'пусто — null');
});

test('дрожь наверху и покачивание (до 150°) не дают повторов и ошибок', () => {
  const c = createSquatCounter();
  let t = 1000;
  for (let i = 0; i < 300; i++) { c.push({ tMs: t, landmarks: synthSquatPose(Math.abs(Math.sin(i * 0.2)) * 0.2, 'front') }); t += 33; }
  const r = c.read();
  assert(r.reps === 0 && r.attempts === 0 && r.lastHint === null, JSON.stringify(r));
});

test('человек дальше (масштаб 0,55) и сбоку кадра; 15 fps; медленные повторы', () => {
  const c = createSquatCounter();
  run(c, 'front', 4, { scale: 0.55, cx: 0.3 });
  assert(c.read().reps === 4, 'масштаб ' + JSON.stringify(c.read()));
  const c2 = createSquatCounter();
  run(c2, 'side', 3, { fps: 15 });
  assert(c2.read().reps === 3, '15 fps ' + c2.read().reps);
  const c3 = createSquatCounter();
  run(c3, 'front', 2, { downS: 3, upS: 2.5 });
  assert(c3.read().reps === 2, 'медленные ' + c3.read().reps);
});

test('мусорный ввод не бросает; время назад игнорируется', () => {
  const c = createSquatCounter();
  for (const x of [null, undefined, 5, {}, { tMs: NaN }, { tMs: 1, landmarks: 'x' }, { tMs: 2, landmarks: [null, { x: NaN }] }, { tMs: 3, landmarks: new Array(33).fill({ x: 0.5, y: 0.5, visibility: 'a' }) }]) c.push(x);
  c.push({ tMs: 100, landmarks: synthSquatPose(0, 'front') });
  c.push({ tMs: 50, landmarks: synthSquatPose(1, 'front') });
  const r = c.read();
  assert(r.reps === 0 && typeof r.message === 'string', JSON.stringify(r));
  c.reset();
  assert(c.read().reps === 0 && c.read().phase === 'noPose', 'reset');
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed (синтетика, не реальная камера)`);
if (pass !== tests.length) process.exitCode = 1;
