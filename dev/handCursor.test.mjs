// [W3-CURSOR] Тесты ядра core/handCursor.js: рамка досягаемости у правого плеча, клик удержанием 0,8 с,
// щепоть, широкие зоны попадания с гистерезисом, опущенная рука не кликает. node dev/handCursor.test.mjs

import { createCursorCore, reachBox, mapTip, pickTarget, pinchRatio, CURSOR_DEFAULTS } from '../core/handCursor.js';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m || ''} ${a} ≉ ${b}`);

const VW = 1366, VH = 768;
const VIEW = { w: VW, h: VH };
// поза: камера 640×480, плечи на уровне 0.55; правое плечо игрока в НЕзеркальном кадре слева (x=0.4)
const POSE = { landmarks: Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.2 })), mirror: true, frameW: 640, frameH: 480, tMs: 0 };
POSE.landmarks[11] = { x: 0.6, y: 0.55, visibility: 0.99 };
POSE.landmarks[12] = { x: 0.4, y: 0.55, visibility: 0.99 };
const BOX = reachBox(POSE);

// кисть: кончик указательного в долях ЭКРАНА (u, v) → координаты показа по рамке; pinch — щепоть
function hand(u, v, { pinch = false, box = BOX } = {}) {
  const x = box.x0 + u * (box.x1 - box.x0), y = box.y0 + v * (box.y1 - box.y0);
  const L = Array.from({ length: 21 }, () => ({ x, y: y + 0.08 }));
  L[0] = { x, y: y + 0.12 };            // запястье
  L[9] = { x, y: y + 0.06 };            // основание среднего — длина ладони 0.06
  L[8] = { x, y };                      // кончик указательного
  L[4] = pinch ? { x: x + 0.004, y: y + 0.004 } : { x: x - 0.04, y: y + 0.05 };
  return { available: true, right: { tip: L[8], landmarks: L, shape: pinch ? 'pinch' : 'point' }, left: null };
}
const px = (x, y) => ({ u: x / VW, v: y / VH });
const at = (x, y, o) => { const p = px(x, y); return hand(p.u, p.v, o); };
// кнопки: «Играть» и «Тренажёр» рядом, «Отключённая» отдельно
const TARGETS = [
  { id: 1, x0: 100, y0: 300, x1: 300, y1: 360 },
  { id: 2, x0: 310, y0: 300, x1: 510, y1: 360 },
  { id: 3, x0: 700, y0: 600, x1: 900, y1: 650, disabled: true },
];
function run(core, frames, { t0 = 0, dt = 33, targets = TARGETS, pose = POSE, active = true, pinch = true } = {}) {
  let t = t0;
  const clicks = [];
  let o = null;
  for (const h of frames) {
    t += dt;
    o = core.step({ t, viewport: VIEW, hands: h, pose, targets, active, pinch });
    if (o.click !== null) clicks.push({ id: o.click, how: o.how, t });
  }
  return { o: { ...o }, clicks, t };
}
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('рамка досягаемости — справа от центра кадра, у правого плеча, выше линии плеч', () => {
  ok(BOX, 'рамка есть');
  ok(BOX.x0 > 0.45 && BOX.x1 > 0.75 && BOX.x1 < 0.95, `x ${BOX.x0.toFixed(3)}..${BOX.x1.toFixed(3)}`);
  ok(BOX.y0 < 0.55 && BOX.y1 > 0.55 && BOX.y1 < 0.65, `y ${BOX.y0.toFixed(3)}..${BOX.y1.toFixed(3)}`);
  const m = mapTip({ x: (BOX.x0 + BOX.x1) / 2, y: (BOX.y0 + BOX.y1) / 2 }, BOX);
  near(m.u, 0.5, 1e-9); near(m.v, 0.5, 1e-9); ok(m.visible);
});

test('без позы — запасная рамка в долях кадра', () => {
  ok(reachBox(null) === null && reachBox({ landmarks: [] }) === null);
  const m = mapTip({ x: 0.675, y: 0.37 }, null);
  near(m.u, 0.5, 1e-6); near(m.v, 0.5, 1e-6); ok(m.visible);
  const core = createCursorCore();
  const fb = CURSOR_DEFAULTS.fallback;
  const r = run(core, rep(10, () => hand(0.5, 0.5, { box: fb })), { pose: null });
  ok(r.o.visible, 'курсор виден и без позы');
});

test('рука опущена (ниже рамки) — курсора нет, кликов нет', () => {
  const core = createCursorCore();
  const r = run(core, rep(60, () => hand(0.2, 1.8)));
  ok(!r.o.visible && r.clicks.length === 0);
});

test('удержание 0,8 с на кнопке — ровно один клик, кольцо заполняется', () => {
  const core = createCursorCore();
  const half = run(core, rep(15, () => at(200, 330)));          // ~0,5 с
  ok(half.o.visible && half.o.targetId === 1, 'кнопка под кольцом');
  ok(half.clicks.length === 0 && half.o.progress > 0.3 && half.o.progress < 0.9, `прогресс ${half.o.progress}`);
  const rest = run(core, rep(60, () => at(200, 330)), { t0: half.t });
  ok(rest.clicks.length === 1 && rest.clicks[0].id === 1 && rest.clicks[0].how === 'dwell', JSON.stringify(rest.clicks));
  near(rest.clicks[0].t, 800 + 33 * 2, 70, 'клик на ~0,8 с');
  ok(rest.o.locked && rest.o.progress === 0, 'та же кнопка не нажимается снова, пока кольцо не ушло');
});

test('ушли с кнопки и вернулись — можно нажать снова', () => {
  const core = createCursorCore();
  let r = run(core, rep(30, () => at(200, 330)));
  ok(r.clicks.length === 1);
  r = run(core, rep(20, () => at(650, 150)), { t0: r.t });      // в пустоту
  ok(r.o.targetId === null);
  r = run(core, rep(40, () => at(200, 330)), { t0: r.t });
  ok(r.clicks.length === 1, 'второй клик после возврата');
});

test('переход на соседнюю кнопку сбрасывает удержание', () => {
  const core = createCursorCore();
  let r = run(core, rep(15, () => at(200, 330)));
  r = run(core, rep(15, () => at(420, 330)), { t0: r.t });
  ok(r.o.targetId === 2 && r.clicks.length === 0 && r.o.progress < 0.7, `прогресс ${r.o.progress}`);
});

test('зона попадания шире кнопки (snap), отпускание с запасом (stick)', () => {
  ok(pickTarget(TARGETS, 200, 380, null).id === 1, '20 px ниже — ещё кнопка');
  ok(pickTarget(TARGETS, 200, 420, null) === null, '60 px ниже — уже нет');
  ok(pickTarget(TARGETS, 200, 405, 1).id === 1, 'текущая держится до stickPx');
  ok(pickTarget(TARGETS, 305, 330, null).id === 1 || pickTarget(TARGETS, 305, 330, null).id === 2, 'между кнопками — ближайшая');
  ok(pickTarget(TARGETS, 312, 330, 1).id === 2, 'внутри соседней кнопки — переход на неё');
});

test('дрожание пальца ±4 px не мигает подсветкой и не сбивает удержание', () => {
  const core = createCursorCore();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
  const r = run(core, rep(30, () => at(290 + rnd(), 330 + rnd())));
  ok(r.clicks.length === 1 && r.clicks[0].id === 1, JSON.stringify(r.clicks));
});

test('отключённая кнопка подсвечивается серым и не нажимается', () => {
  const core = createCursorCore();
  const r = run(core, rep(60, () => at(800, 625)));
  ok(r.o.targetId === 3 && r.o.disabled && r.clicks.length === 0 && r.o.progress === 0);
});

test('щепоть на кнопке — мгновенный клик', () => {
  const core = createCursorCore();
  let r = run(core, rep(8, () => at(400, 330)));                // ~0,26 с на кнопке, пальцы разжаты
  ok(r.clicks.length === 0);
  r = run(core, rep(3, () => at(400, 330, { pinch: true })), { t0: r.t });
  ok(r.clicks.length === 1 && r.clicks[0].id === 2 && r.clicks[0].how === 'pinch', JSON.stringify(r.clicks));
  ok(pinchRatio(at(0, 0, { pinch: true }).right, 4 / 3) < 0.3 && pinchRatio(at(0, 0).right, 4 / 3) > 0.5, 'длина щепоти');
});

test('«OK», поднесённый к кнопке уже сведённым, щепотью не кликает', () => {
  const core = createCursorCore();
  const r = run(core, rep(12, () => at(400, 330, { pinch: true })));
  ok(r.clicks.length === 0, JSON.stringify(r.clicks));
});

test('щепоть выключена (тренажёр) — клик только удержанием', () => {
  const core = createCursorCore();
  let r = run(core, rep(8, () => at(400, 330)), { pinch: false });
  r = run(core, rep(4, () => at(400, 330, { pinch: true })), { t0: r.t, pinch: false });
  ok(r.clicks.length === 0, 'щепоть не кликает');
  r = run(core, rep(20, () => at(400, 330, { pinch: true })), { t0: r.t, pinch: false });
  ok(r.clicks.length === 1 && r.clicks[0].how === 'dwell');
});

test('экран без курсора (бой) — кольца нет, кликов нет; кисть пропала ненадолго — кольцо держится', () => {
  const core = createCursorCore();
  let r = run(core, rep(40, () => at(200, 330)), { active: false });
  ok(!r.o.visible && r.clicks.length === 0);
  r = run(core, rep(6, () => at(650, 150)));
  ok(r.o.visible);
  r = run(core, rep(5, () => null), { t0: r.t });              // 165 мс без кисти
  ok(r.o.visible, 'короткий пропуск кадра не гасит кольцо');
  r = run(core, rep(10, () => null), { t0: r.t });
  ok(!r.o.visible, 'кисть пропала — кольцо погасло');
});

test('сглаживание: рывок кисти через экран — кольцо догоняет быстро (без вязкости)', () => {
  const core = createCursorCore();
  let r = run(core, rep(10, () => at(200, 200)));
  r = run(core, rep(6, () => at(1100, 600)), { t0: r.t });     // 0,2 с
  ok(Math.hypot(r.o.x - 1100, r.o.y - 600) < 60, `кольцо в ${Math.round(r.o.x)},${Math.round(r.o.y)}`);
});

for (const line of out) console.log(line);
console.log(`\nhandCursor: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
