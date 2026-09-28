// Тесты core/leftStick.js (левая рука-джойстик). node dev/leftStick.test.mjs
// Синтетика: центр ладони задаётся напрямую (кадр с поправкой на аспект, y вниз). Не живая рука.

import { createLeftStick, DEFAULT_STICK_CONFIG } from '../core/leftStick.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const near = (a, b, eps, m) => { if (!(Math.abs(a - b) <= eps)) throw new Error(`${m || ''}: ${a} ≉ ${b} (±${eps})`); };

const ASPECT = 4 / 3, S = 0.12;
const BODY = { x: 0.5 * ASPECT, y: 0.4, sw: 0.25 };
const A = { x: 0.62 * ASPECT, y: BODY.y + 0.6 * BODY.sw }; // левая рука игрока — справа в незеркальном кадре, на уровне груди

// кадры по 33 мс; pos(t) → {x, y} | null; body(t) опционально
function run(st, t0, ms, pos, { body = () => BODY, busy = false, mirror = true, jitter = 0 } = {}) {
  let t = t0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (; t < t0 + ms; t += 33) {
    const p = pos(t);
    const hand = p ? { x: p.x + rnd() * jitter * S, y: p.y + rnd() * jitter * S, scale: S } : null;
    st.push({ t, hand, body: body(t), mirror, aspect: ASPECT, busy });
  }
  return t;
}
function grabbed(t0 = 1000, opts) {
  const st = createLeftStick();
  const t = run(st, t0, 400, () => A, opts);
  return { st, t };
}
const at = (dxS, dyS) => ({ x: A.x + dxS * S, y: A.y + dyS * S });

test('хватка: замереть с поднятой рукой → engaged, выход 0', () => {
  const { st, t } = grabbed();
  const r = st.read(t);
  ok(r.engaged, 'не взят');
  near(r.x, 0, 1e-9); near(r.z, 0, 1e-9);
  ok(r.anchor && r.hand, 'для HUD есть центр и рука');
});

test('зеркальный экран: рука вправо на экране → x > 0; вверх → вперёд (z > 0)', () => {
  let { st, t } = grabbed();
  t = run(st, t, 400, () => at(-1.5, 0)); // в незеркальном кадре влево = на зеркальном экране вправо
  let r = st.read(t);
  ok(r.x > 0.6 && Math.abs(r.z) < 0.15, `вправо: x=${r.x} z=${r.z}`);
  ({ st, t } = grabbed());
  t = run(st, t, 400, () => at(0, -1.5)); // вверх в кадре
  r = st.read(t);
  ok(r.z > 0.6 && Math.abs(r.x) < 0.15, `вперёд: x=${r.x} z=${r.z}`);
  ({ st, t } = grabbed());
  t = run(st, t, 400, () => at(-1.5, 0), { mirror: false });
  ok(st.read(t).x < -0.6, 'без зеркала — наоборот');
});

test('8 направлений: угол выхода совпадает с направлением руки (±10°), длина ≤ 1', () => {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const wantX = Math.cos(a), wantZ = Math.sin(a);
    // экран: x вправо → в кадре −x (зеркало); вперёд → вверх в кадре (−y)
    let { st, t } = grabbed();
    t = run(st, t, 450, () => at(-wantX * 2.0, -wantZ * 2.0));
    const r = st.read(t);
    const got = Math.atan2(r.z, r.x), err = Math.abs(Math.atan2(Math.sin(got - a), Math.cos(got - a))) * 180 / Math.PI;
    ok(err <= 10, `сектор ${k}: ошибка ${err.toFixed(1)}°`);
    ok(Math.hypot(r.x, r.z) <= 1 + 1e-9 && Math.hypot(r.x, r.z) > 0.95, `длина ${Math.hypot(r.x, r.z)}`);
  }
});

test('мёртвая зона и монотонность величины', () => {
  let prev = -1;
  for (const d of [0.2, 0.3, 0.5, 0.8, 1.1, 1.4, 1.7, 2.2]) {
    const { st, t } = grabbed();
    const t2 = run(st, t, 500, () => at(-d, 0));
    const m = Math.hypot(st.read(t2).x, st.read(t2).z);
    if (d < DEFAULT_STICK_CONFIG.deadzone) near(m, 0, 1e-9, `мёртвая зона d=${d}`);
    ok(m >= prev - 1e-9, `монотонность d=${d}: ${m} < ${prev}`);
    prev = m;
  }
  ok(prev > 0.99, 'полный ход');
});

test('дрожание руки в центре не выводит из мёртвой зоны', () => {
  const st = createLeftStick();
  let t = run(st, 1000, 400, () => A);
  let maxM = 0;
  for (let k = 0; k < 60; k++) { t = run(st, t, 33, () => A, { jitter: 0.25 }); maxM = Math.max(maxM, Math.hypot(st.read(t).x, st.read(t).z)); }
  near(maxM, 0, 1e-9, 'движение от шума');
  eq0(st.getDebug().counters.dashes, 'рывков от шума');
});
function eq0(v, m) { if (v !== 0) throw new Error(`${m}: ${v}`); }

test('рука опущена к коленям → стоп сразу и центр сброшен; снова поднять — новая хватка', () => {
  let { st, t } = grabbed();
  t = run(st, t, 300, () => at(-1.5, 0));
  ok(st.read(t).x > 0.5);
  t = run(st, t, 99, () => ({ x: A.x, y: BODY.y + 2.1 * BODY.sw })); // руки на коленях
  const r = st.read(t);
  ok(!r.engaged && r.x === 0 && r.z === 0 && r.rest, 'стоп в покое');
  t = run(st, t, 400, () => at(-1.0, 0)); // подняли в другом месте и замерли
  const r2 = st.read(t);
  ok(r2.engaged && Math.hypot(r2.x, r2.z) < 1e-9, 'новый центр там, где взяли');
});

test('кисть пропала → выход 0 за staleMs; надолго → нужна новая хватка', () => {
  let { st, t } = grabbed();
  t = run(st, t, 300, () => at(-1.5, 0));
  t = run(st, t, DEFAULT_STICK_CONFIG.staleMs + 50, () => null);
  const r = st.read(t);
  ok(r.x === 0 && r.z === 0 && !r.engaged, 'ноль без кисти');
  t = run(st, t, DEFAULT_STICK_CONFIG.lostResetMs + 100, () => null);
  t = run(st, t, 33, () => at(-1.5, 0));
  ok(!st.read(t).engaged, 'после долгой потери центр сброшен');
});

test('наклон корпуса вместе с рукой не двигает героя (центр привязан к плечам)', () => {
  let { st, t } = grabbed();
  const t0 = t;
  t = run(st, t, 600, (tt) => { const k = Math.min(1, (tt - t0) / 400); return at(-1.5 * k, 0); },
    { body: (tt) => { const k = Math.min(1, (tt - t0) / 400); return { x: BODY.x - 1.5 * k * S, y: BODY.y, sw: BODY.sw }; } });
  const r = st.read(t);
  near(Math.hypot(r.x, r.z), 0, 1e-6, 'корпус и рука сдвинулись вместе');
});

test('резкий дёрг → ровно один рывок в сторону дёрга; медленный возврат второго не даёт', () => {
  for (const [dx, dy, wx, wz] of [[-1.8, 0, 1, 0], [1.8, 0, -1, 0], [0, -1.8, 0, 1], [0, 1.8, 0, -1]]) {
    let { st, t } = grabbed();
    const dashes = [];
    const t0 = t;
    t = run(st, t, 130, (tt) => { const k = Math.min(1, (tt - t0) / 100); return at(dx * k, dy * k); });
    let d = st.takeDash(); if (d) dashes.push(d);
    const t1 = t;
    t = run(st, t, 900, (tt) => { const k = Math.min(1, (tt - t1) / 700); return at(dx * (1 - k), dy * (1 - k)); });
    d = st.takeDash(); if (d) dashes.push(d);
    ok(dashes.length === 1, `рывков ${dashes.length} для (${dx},${dy})`);
    ok(dashes[0].x * wx + dashes[0].z * wz > 0.9, `направление (${dashes[0].x.toFixed(2)}, ${dashes[0].z.toFixed(2)})`);
  }
});

test('обычное ведение джойстика (быстро, но не дёрг) рывка не даёт', () => {
  let { st, t } = grabbed();
  const t0 = t;
  t = run(st, t, 700, (tt) => { const k = Math.min(1, (tt - t0) / 400); return at(-1.8 * k, 0); });
  ok(!st.takeDash(), 'рывок от ведения 1.8 S за 0.4 с');
});

test('во время дёрга выход замирает на прежнем значении', () => {
  let { st, t } = grabbed();
  const t0 = t;
  t = run(st, t, 120, (tt) => { const k = Math.min(1, (tt - t0) / 90); return at(-2.0 * k, 0); });
  ok(st.peekDash(), 'рывок есть');
  near(st.read(t).x, 0, 1e-6, 'выход держится на значении до дёрга (0)');
});

test('руки заняты чарами (busy): выход 0 и рывка нет', () => {
  let { st, t } = grabbed();
  const t0 = t;
  t = run(st, t, 200, (tt) => { const k = Math.min(1, (tt - t0) / 100); return at(-1.8 * k, 0); }, { busy: true });
  const r = st.read(t);
  ok(r.x === 0 && r.z === 0, 'движение при чарах');
  ok(!st.takeDash(), 'рывок при чарах');
});

test('медленный дрейф центра, пока рука стоит в мёртвой зоне', () => {
  let { st, t } = grabbed();
  const a0 = { ...st.getDebug().anchor };
  t = run(st, t, 4000, () => at(-0.25, 0));
  const a1 = st.getDebug().anchor;
  ok(Math.abs(a1.x - a0.x) > 0.1 * S, `центр не сдвинулся: ${a0.x} → ${a1.x}`);
});

// ───────── [V3] ─────────
function runW(st, t0, ms, handFn, wristFn, { body = () => BODY, scaleFn = () => S } = {}) {
  let t = t0;
  for (; t < t0 + ms; t += 33) {
    const p = handFn(t), w = wristFn ? wristFn(t) : null;
    st.push({ t, hand: p ? { x: p.x, y: p.y, scale: scaleFn(t) } : null, wrist: w, body: body(t), mirror: true, aspect: ASPECT, busy: false });
  }
  return t;
}
const WOFF = 0.6 * S; // запястье ниже центра ладони

test('[V3] кисть потеряна (кулак/смаз) — ведём по запястью позы; без запястья — стоп', () => {
  const st = createLeftStick();
  let t = runW(st, 1000, 600, () => A, () => ({ x: A.x, y: A.y + WOFF }));
  ok(st.read(t).engaged, 'взят');
  // кисть пропала, запястье уходит вправо на экране (влево в незеркальном кадре)
  t = runW(st, t, 500, () => null, (tt) => ({ x: A.x - 1.6 * S * Math.min(1, (tt - t) / 250), y: A.y + WOFF }));
  const r = st.read(t);
  ok(r.x > 0.6 && r.source === 'wrist', `по запястью: x=${r.x.toFixed(2)} source=${r.source}`);
  ok(!st.peekDash(), 'смена источника не дала рывка');
  t = runW(st, t, 400, () => null, () => null);
  near(st.read(t).x, 0, 1e-9, 'ни кисти, ни запястья — стоп');
});

test('[V3] размер ладони скачет ±25% (поворот кисти) — сила хода почти не дрожит', () => {
  const st = createLeftStick();
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  let t = runW(st, 1000, 3000, () => A, null, { scaleFn: () => S * (1 + rnd() * 0.5) });
  const vals = [];
  t = runW(st, t, 300, () => at(-1.0, 0), null, { scaleFn: () => S * (1 + rnd() * 0.5) });
  for (let i = 0; i < 40; i++) { t = runW(st, t, 33, () => at(-1.0, 0), null, { scaleFn: () => S * (1 + rnd() * 0.5) }); vals.push(st.read(t).x); }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  ok(sd < 0.02, `разброс силы ${sd.toFixed(4)} (среднее ${mean.toFixed(2)})`);
});

test('[V3] плавающий центр: рука ушла далеко за полный ход — центр подтянулся; обратный ход останавливает раньше', () => {
  const { st, t: t0 } = grabbed();
  let t = run(st, t0, 500, () => at(-4, 0));
  ok(st.read(t).x > 0.95, 'полный ход вправо');
  t = run(st, t, 500, () => at(-2, 0));
  const r = st.read(t);
  ok(Math.abs(r.x) < 0.2, `после возврата на полпути — почти стоп, x=${r.x.toFixed(2)}`);
  ok(st.getDebug().counters.floats > 0, 'центр подтягивался');
});

test('[V3] притяжение к осям: 8° от «вперёд» → ровно вперёд; 25° — как есть', () => {
  const ang = (deg) => { const { st, t: t0 } = grabbed(); const a = deg * Math.PI / 180; const t = run(st, t0, 400, () => at(-Math.sin(a) * 1.4, -Math.cos(a) * 1.4)); const r = st.read(t); return Math.atan2(r.x, r.z) * 180 / Math.PI; };
  ok(Math.abs(ang(8)) < 2.5, `8° → ${ang(8).toFixed(1)}°`);
  ok(Math.abs(ang(25) - 25) < 3, `25° → ${ang(25).toFixed(1)}°`);
  ok(Math.abs(ang(95) - 90) < 2.5, `95° → ${ang(95).toFixed(1)}°`);
});

test('[V3] ход назад короче: рука вниз на 1 S даёт больше, чем вверх на 1 S', () => {
  let { st, t } = grabbed();
  t = run(st, t, 400, () => at(0, 1.0));
  const back = -st.read(t).z;
  ({ st, t } = grabbed());
  t = run(st, t, 400, () => at(0, -1.0));
  const fwd = st.read(t).z;
  ok(back > fwd + 0.05 && back > 0, `назад ${back.toFixed(2)} > вперёд ${fwd.toFixed(2)}`);
});

test('мусор на входе не ломает модуль', () => {
  const st = createLeftStick();
  st.push(null); st.push({}); st.push({ t: NaN }); st.push({ t: 5, hand: { x: NaN, y: 1 } });
  st.push({ t: 6, hand: { x: 1, y: 1, scale: -3 }, body: { x: 'a' } });
  const r = st.read(10);
  ok(r && r.x === 0 && r.z === 0, 'ноль');
});

test('производительность: push + read', () => {
  const st = createLeftStick();
  const t0 = performance.now();
  let t = 0;
  for (let i = 0; i < 20000; i++) { t += 33; st.push({ t, hand: at(Math.sin(i / 20), Math.cos(i / 30)), body: BODY, mirror: true, aspect: ASPECT }); st.read(t); }
  const us = ((performance.now() - t0) / 20000) * 1000;
  ok(us < 50, `${us.toFixed(1)} мкс/кадр`);
  results.push(`     (push+read: ${us.toFixed(1)} мкс/кадр)`);
});

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
