// node dev/visionPlan.test.mjs — план распознавания под железо (core/visionPlan.js): поза реже кистей на слабой
// видеокарте по измеренной цене кадра (гистерезис, выдержка, экраны) и подсказка про гибридный ноутбук.
import { createPosePlanner, hybridTipDue, PLAN_DEFAULTS, HYBRID_TIP_TEXT } from '../core/visionPlan.js';
import { createHybridTip, HYBRID_TIP_KEY } from '../core/hybridTip.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(v, msg) { if (!v) throw new Error(msg || 'ожидалось истинное значение'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ожидалось равенство'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const memStorage = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
// прогон: раз в 500 мс (как perfVisionTick) столько секунд с одними и теми же измерениями
function run(p, t0, sec, v) { let t = t0, last = null; for (let i = 0; i <= sec * 2; i++) { t = t0 + i * 500; last = p.update(t, v); } return { t, every: last }; }

test('сильная машина (6 мс/кадр): поза на каждом кадре на любом экране — поведение не меняется', () => {
  const p = createPosePlanner();
  for (const screen of ['menu', 'playing', 'tutorial', 'training', 'camera']) {
    const r = run(p, 1000, 20, { screen, inferMs: 4, handsMs: 2.4, gpuClass: 'discrete', handsReady: true });
    eq(r.every, 1, `экран ${screen}`);
  }
  ok(!p.slow, 'не «медленно»');
});

test('слабая встроенная (поза 40 + кисти 35 мс): после выдержки поза на каждом 2-м в бою, 3-м в меню, каждом на тренировке', () => {
  const p = createPosePlanner({ warmMs: 0 });   // прогрев проверяется отдельным тестом
  const v = { inferMs: 40, handsMs: 35, gpuClass: 'integrated', handsReady: true };
  eq(p.update(1000, { ...v, screen: 'playing' }), 1, 'сразу не переключается');
  eq(p.update(1000 + PLAN_DEFAULTS.holdMs - 100, { ...v, screen: 'playing' }), 1, 'выдержка ещё идёт');
  eq(p.update(1000 + PLAN_DEFAULTS.holdMs, { ...v, screen: 'playing' }), PLAN_DEFAULTS.fightEvery, 'бой');
  eq(p.update(5000, { ...v, screen: 'menu' }), PLAN_DEFAULTS.menuEvery, 'меню');
  eq(p.update(5500, { ...v, screen: 'paused' }), PLAN_DEFAULTS.menuEvery, 'пауза');
  eq(p.update(6000, { ...v, screen: 'training' }), 1, 'тренировка: поза всегда на каждом кадре');
  eq(p.update(6500, { ...v, screen: 'camera' }), PLAN_DEFAULTS.fightEvery, 'экран камеры');
  eq(p.update(7000, { ...v, screen: 'playing', handsReady: false }), 1, 'без кистей поза — единственный ввод');
  ok(/медленно/.test(p.state().reason), 'причина записана');
});

test('гистерезис: между порогами решение не меняется, обратно — только после быстрых кадров с выдержкой', () => {
  const p = createPosePlanner({ warmMs: 0 });
  run(p, 1000, 5, { screen: 'playing', inferMs: 50, handsMs: 20, gpuClass: 'integrated', handsReady: true });
  eq(p.every, 2, 'медленно → 2');
  run(p, 10000, 5, { screen: 'playing', inferMs: 20, handsMs: 15, gpuClass: 'integrated', handsReady: true });   // 35 мс: между fast и slow
  eq(p.every, 2, 'между порогами — остаётся 2');
  const r = run(p, 20000, 5, { screen: 'playing', inferMs: 12, handsMs: 10, gpuClass: 'integrated', handsReady: true }); // 22 мс < fastMs
  eq(r.every, 1, 'быстро с выдержкой → снова каждый кадр');
});

test('кратковременный всплеск цены кадра (короче выдержки) не переключает', () => {
  const p = createPosePlanner();
  const fast = { screen: 'playing', inferMs: 5, handsMs: 3, gpuClass: 'discrete', handsReady: true };
  run(p, 1000, 3, fast);
  p.update(5000, { ...fast, inferMs: 80 }); p.update(5500, { ...fast, inferMs: 80 }); p.update(6000, { ...fast, inferMs: 80 });   // 1,5 с
  eq(p.update(6500, fast), 1, 'всплеск 1,5 с < holdMs');
});

test('программный рендер (нет видеокарты): поза реже сразу, без измерений', () => {
  const p = createPosePlanner();
  eq(p.update(1000, { screen: 'playing', inferMs: null, handsMs: null, gpuClass: 'software', handsReady: true }), 2);
});

test('подсказка про гибридный ноутбук: встроенная + медленно дольше tipHoldMs; дискретная/быстро/тусклый свет/«Понятно» — нет', () => {
  const st = {};
  const slow = { gpuClass: 'integrated', hz: 9, cameraFps: 30 };
  eq(hybridTipDue(1000, slow, st), false, 'сразу — нет');
  eq(hybridTipDue(1000 + PLAN_DEFAULTS.tipHoldMs, slow, st), true, 'после выдержки — да');
  eq(hybridTipDue(1000 + PLAN_DEFAULTS.tipHoldMs, { ...slow, dismissed: true }, {}), false, 'после «Понятно» — нет');
  const d = {};
  for (let t = 0; t < 20000; t += 500) ok(!hybridTipDue(t, { gpuClass: 'discrete', hz: 5, cameraFps: 30 }, d), 'дискретная — никогда');
  const f = {};
  for (let t = 0; t < 20000; t += 500) ok(!hybridTipDue(t, { gpuClass: 'integrated', hz: 24, cameraFps: 30 }, f), 'успевает — нет');
  const dim = {};
  for (let t = 0; t < 20000; t += 500) ok(!hybridTipDue(t, { gpuClass: 'integrated', hz: 7, cameraFps: 8 }, dim), 'камера сама 8 к/с (тусклый свет) — не про видеокарту');
  const broken = {};
  hybridTipDue(0, slow, broken); eq(hybridTipDue(3000, { gpuClass: 'integrated', hz: 20, cameraFps: 30 }, broken), false); ok(broken.since === null, 'серия сбрасывается');
  ok(/Google Chrome/.test(HYBRID_TIP_TEXT) && /Высокая производительность/.test(HYBRID_TIP_TEXT), 'текст с путём к настройке');
});

test('карточка подсказки: без DOM — заглушка; запомненное «Понятно» — не показывать', () => {
  const t = createHybridTip({ root: null, storage: memStorage() });
  t.update(1000, { gpuClass: 'integrated', hz: 5, cameraFps: 30, screen: 'camera' });
  eq(t.shown, false);
  const t2 = createHybridTip({ root: null, storage: memStorage({ [HYBRID_TIP_KEY]: '1' }) });
  eq(t2.dismissed, true);
});

test('дискретная видеокарта (NVIDIA): поза на каждом кадре даже при медленном кадре — как до планировщика', () => {
  const p = createPosePlanner();
  for (const screen of ['menu', 'playing', 'tutorial', 'camera']) {
    const r = run(p, 1000, 30, { screen, inferMs: 30, handsMs: 25, gpuClass: 'discrete', handsReady: true });   // 55 мс > slowMs
    eq(r.every, 1, `экран ${screen}`);
  }
  ok(!p.slow, 'на дискретной «медленно» не включается');
});

test('прогрев: всплеск в первые секунды распознавания (сборка шейдеров) не переключает; затем 35 мс — тоже нет', () => {
  const p = createPosePlanner();
  const v = { screen: 'tutorial', gpuClass: 'integrated', handsReady: true };
  run(p, 1000, 5, { ...v, inferMs: 60, handsMs: 30 });                 // 90 мс, 5 с — внутри прогрева
  eq(p.every, 1, 'всплеск на прогреве — поза на каждом кадре');
  const r = run(p, 6500, 20, { ...v, inferMs: 20, handsMs: 15 });       // 35 мс — между порогами
  eq(r.every, 1, 'после прогрева цена между порогами — не переключает');
});

test('прогрев: долгая медленная работа после прогрева переключает; пауза измерений > gapMs — снова прогрев', () => {
  const p = createPosePlanner();
  const v = { screen: 'playing', gpuClass: 'integrated', handsReady: true, inferMs: 45, handsMs: 30 };   // 75 мс
  const r = run(p, 1000, 10, v);
  eq(r.every, PLAN_DEFAULTS.fightEvery, 'медленно дольше прогрева + выдержки → поза через кадр');
  const p2 = createPosePlanner({ warmMs: 0 });
  run(p2, 1000, 3, { ...v, inferMs: 10, handsMs: 8 });
  eq(p2.every, 1);
  const p3 = createPosePlanner();
  run(p3, 1000, 10, { ...v, inferMs: 10, handsMs: 8 });                  // быстро, прогрев прошёл
  const r3 = run(p3, 1000 + 10000 + PLAN_DEFAULTS.gapMs + 1000, 4, v);    // камера была выключена → прогрев заново
  eq(r3.every, 1, 'сразу после паузы — прогрев, не переключает');
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} пройдено`);
if (failed) process.exit(1);
