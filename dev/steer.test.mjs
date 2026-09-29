// Тесты core/steerStick.js (схема движения «Руль») и её пути через core/handGestures.js.
// node dev/steer.test.mjs
// Синтетика: центр ладони задаётся напрямую (кадр с поправкой на аспект, y вниз, незеркальный кадр).
// Не живая рука: проверяется логика порогов, знаков, гистерезиса, рывка и подсказок.

import { createSteerStick, DEFAULT_STEER_CONFIG as C } from '../core/steerStick.js';
import { createHandGestures } from '../core/handGestures.js';
import { hintInfo } from '../core/gestureCoach.js';
import { createCombat, DEFAULT_LAYOUT } from '../modules/combat.js';
import { createCameraRig } from '../core/cameraRig.js';
import { config as gameConfig } from '../config.js';
import { createDebugInput } from '../core/debugInput.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const near = (a, b, eps, m) => { if (!(Math.abs(a - b) <= eps)) throw new Error(`${m || ''}: ${a} ≉ ${b} (±${eps})`); };

const ASPECT = 4 / 3, SCALE = 0.1;
const BODY = { x: 0.5 * ASPECT, y: 0.4, sw: 0.25 };
// ладонь левой руки: out — sw наружу от нейтрали (к левому боку игрока; в незеркальном кадре вправо),
// v — уровень в sw над линией плеч (вниз — минус)
const P = (out, v, body = BODY) => ({ x: body.x + (C.neutralX + out) * body.sw, y: body.y - v * body.sw });
const CHEST = -0.25;   // рука поднята на уровень груди — шаг

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
function run(st, t0, ms, pos, { body = () => BODY, busy = false, mirror = true, jitter = 0, wrist = () => null, dt = 33 } = {}) {
  let t = t0;
  for (; t < t0 + ms; t += dt) {
    const p = pos(t), b = body(t);
    const hand = p ? { x: p.x + rnd() * jitter * b.sw, y: p.y + rnd() * jitter * b.sw, scale: SCALE * b.sw / BODY.sw } : null;
    st.push({ t, hand, wrist: wrist(t), body: b, mirror, aspect: ASPECT, busy });
  }
  return t;
}
function raised(v = CHEST, t0 = 1000, opts) {
  const st = createSteerStick();
  const t = run(st, t0, 500, () => P(0, v), opts);
  return { st, t };
}

test('рука поднята на уровень груди → шаг вперёд без поворота, без хватки и «замри»', () => {
  const st = createSteerStick();
  st.push({ t: 1000, hand: { ...P(0, CHEST), scale: SCALE }, body: BODY, mirror: true, aspect: ASPECT });
  const r0 = st.read(1000);
  ok(r0.engaged && r0.z > 0, 'идёт с первого же кадра: ' + JSON.stringify({ e: r0.engaged, z: r0.z }));
  const { st: s2, t } = raised();
  const r = s2.read(t);
  ok(r.mode === 'steer' && r.engaged && !r.rest, 'поднята');
  ok(r.z >= C.walkMin - 1e-9 && r.z <= C.walkMag + 1e-9, `шаг: z=${r.z}`);
  near(r.x, 0, 1e-9, 'без поворота');
  ok(r.gait === 'walk', 'походка walk');
  ok(r.moveX === r.x && r.moveZ === r.z, 'совместимость с джойстиком: moveX/moveZ');
});

test('выше — быстрее: у груди шаг, у плеча и выше — бег (1.0); гистерезис бег ↔ шаг', () => {
  const zAt = (v) => { const { st, t } = raised(v); return st.read(t); };
  const lo = zAt(-0.5), mid = zAt(-0.15), hi = zAt(0.3);
  ok(lo.z < mid.z && lo.gait === 'walk' && mid.gait === 'walk', `шаг растёт с высотой: ${lo.z} < ${mid.z}`);
  ok(hi.z === 1 && hi.gait === 'run', 'бег: ' + JSON.stringify({ z: hi.z, g: hi.gait }));
  // между runOff и runOn: снизу — шаг, сверху — остаётся бег
  const mid2 = (C.runOn + C.runOff) / 2;
  let { st, t } = raised(-0.3);
  t = run(st, t, 400, () => P(0, mid2));
  ok(st.read(t).gait === 'walk', 'снизу в полосу гистерезиса — шаг');
  ({ st, t } = raised(0.3));
  t = run(st, t, 400, () => P(0, mid2));
  ok(st.read(t).gait === 'run', 'сверху в полосу гистерезиса — бег');
});

test('зеркальный экран: рука к левому боку игрока (влево на экране) → поворот влево (x < 0); к середине груди → вправо', () => {
  let { st, t } = raised();
  t = run(st, t, 500, () => P(0.5, CHEST));
  let r = st.read(t);
  ok(r.x < -0.4 && r.z > 0, `влево: x=${r.x.toFixed(2)} z=${r.z.toFixed(2)}`);
  ok(r.hand.x < r.anchor.x, 'на зеркальном превью ладонь левее нейтрали');
  ({ st, t } = raised());
  t = run(st, t, 500, () => P(-0.5, CHEST));
  r = st.read(t);
  ok(r.x > 0.4, `вправо: x=${r.x.toFixed(2)}`);
  ({ st, t } = raised(CHEST, 1000, { mirror: false }));
  t = run(st, t, 500, () => P(0.5, CHEST), { mirror: false });
  ok(st.read(t).x > 0.4, 'без зеркала — знак как у джойстика (наоборот)');
});

test('сила поворота растёт со смещением и не больше 1', () => {
  let prev = -1;
  for (const d of [0.1, 0.18, 0.25, 0.35, 0.5, 0.62, 0.9]) {
    let { st, t } = raised();
    t = run(st, t, 600, () => P(d, CHEST));
    const m = Math.abs(st.read(t).x);
    if (d < C.dzOn) near(m, 0, 1e-9, `мёртвая зона d=${d}`);
    ok(m >= prev - 1e-9, `монотонность d=${d}: ${m} < ${prev}`);
    ok(m <= 1 + 1e-9, 'не больше 1');
    prev = m;
  }
  ok(prev > 0.97, 'полный поворот: ' + prev);
});

test('дрожание в мёртвой зоне (±0.1 sw по обеим осям, 10 с) — ни поворота, ни смены шаг/стоп/бег, ни рывка', () => {
  const st = createSteerStick();
  let t = run(st, 1000, 500, () => P(0, CHEST));
  let maxTurn = 0, flips = 0, prevGait = st.read(t).gait;
  for (let k = 0; k < 300; k++) {
    t = run(st, t, 33, () => P(0.05, CHEST), { jitter: 0.2 }); // равномерный шум ±0.1 sw
    const r = st.read(t);
    maxTurn = Math.max(maxTurn, Math.abs(r.x));
    if (r.gait !== prevGait) flips++;
    prevGait = r.gait;
  }
  near(maxTurn, 0, 1e-9, 'поворот от шума');
  ok(flips === 0, `походка мигала ${flips} раз`);
  ok(!st.takeDash() && st.getDebug().counters.dashes === 0, 'рывок от шума');
});

test('гистерезис мёртвой зоны: 0.17 sw с места — нет; после поворота на 0.17 — ещё поворот; на 0.1 — прямо', () => {
  let { st, t } = raised();
  t = run(st, t, 500, () => P(0.17, CHEST));
  near(st.read(t).x, 0, 1e-9, 'с места 0.17 — прямо');
  t = run(st, t, 400, () => P(0.3, CHEST));
  ok(st.read(t).x < 0, 'поворачиваем');
  t = run(st, t, 400, () => P(0.17, CHEST));
  ok(st.read(t).x < 0, 'на 0.17 поворот держится (гистерезис)');
  t = run(st, t, 500, () => P(0.1, CHEST));
  near(st.read(t).x, 0, 1e-3, 'на 0.1 — снова прямо');
});

test('рука опущена ниже груди → стоп на первом же кадре; на колени — стоп и покой', () => {
  let { st, t } = raised(0.2);
  t = run(st, t, 300, () => P(0.5, 0.2));
  ok(st.read(t).engaged && st.read(t).z === 1, 'бежит с поворотом');
  // один кадр ниже порога
  st.push({ t, hand: { ...P(0.5, C.walkOff - 0.05), scale: SCALE }, body: BODY, mirror: true, aspect: ASPECT });
  let r = st.read(t);
  ok(!r.engaged && r.x === 0 && r.z === 0 && r.rest, 'стоп сразу: ' + JSON.stringify({ e: r.engaged, x: r.x, z: r.z }));
  t = run(st, t + 33, 300, () => P(0, -1.6));
  r = st.read(t);
  ok(!r.engaged && r.x === 0 && r.z === 0 && r.gait === 'idle', 'на коленях — стоим');
  // снова поднять — сразу идём, «замри» не нужно
  t = run(st, t, 66, () => P(0, CHEST));
  ok(st.read(t).engaged && st.read(t).z > 0, 'подняли — идём');
});

test('между «стоп» и «шаг» — гистерезис: рука у порога с шумом не мигает', () => {
  const edge = (C.walkOn + C.walkOff) / 2;
  let { st, t } = raised();
  let flips = 0, prev = true;
  for (let k = 0; k < 200; k++) { t = run(st, t, 33, () => P(0, edge), { jitter: 0.08 }); const e = st.read(t).engaged; if (e !== prev) flips++; prev = e; }
  ok(flips === 0, `идёт/стоит мигало ${flips} раз (сверху)`);
  ({ st, t } = { st: createSteerStick(), t: 1000 });
  t = run(st, t, 500, () => P(0, -1.5));
  flips = 0; prev = false;
  for (let k = 0; k < 200; k++) { t = run(st, t, 33, () => P(0, edge), { jitter: 0.08 }); const e = st.read(t).engaged; if (e !== prev) flips++; prev = e; }
  ok(flips === 0, `идёт/стоит мигало ${flips} раз (снизу)`);
});

test('кисть не видна → стоп за lostStopMs; ушла через нижний край — стоп сразу', () => {
  let { st, t } = raised();
  t = run(st, t, C.lostStopMs + 40, () => null);
  let r = st.read(t);
  ok(!r.engaged && r.x === 0 && r.z === 0, 'нет кисти — стоим');
  ({ st, t } = raised());
  t = run(st, t, 200, (tt) => P(0, CHEST - 3 * (tt - t) / 200));   // быстро вниз к краю
  st.push({ t, hand: null, body: BODY, mirror: true, aspect: ASPECT });
  r = st.read(t);
  ok(!r.engaged && r.z === 0, 'ушла вниз — стоп сразу');
});

test('короткий провал трекинга (1 кадр) при поднятой руке — ход не прерывается', () => {
  let { st, t } = raised();
  st.push({ t, hand: null, body: BODY, mirror: true, aspect: ASPECT });
  ok(st.read(t).engaged && st.read(t).z > 0, 'один пустой кадр — идём дальше');
});

test('кисть потеряна (кулак, смаз) — ведём по запястью позы', () => {
  const WR = (p) => ({ x: p.x, y: p.y + 0.3 * BODY.sw });
  const st = createSteerStick();
  let t = run(st, 1000, 600, () => P(0, CHEST), { wrist: () => WR(P(0, CHEST)) });
  t = run(st, t, 500, () => null, { wrist: () => WR(P(0.5, CHEST)) });
  const r = st.read(t);
  ok(r.engaged && r.source === 'wrist' && r.x < -0.3, `по запястью: ${JSON.stringify({ e: r.engaged, s: r.source, x: r.x })}`);
  t = run(st, t, 900, () => null, { wrist: () => WR(P(0.5, CHEST)) });
  ok(!st.read(t).engaged, 'по запястью — не дольше wristMaxGapMs');
});

test('одинаково на разном расстоянии: пороги в ширинах плеч', () => {
  const outAt = (sw, out, v) => {
    const body = { x: 0.5 * ASPECT, y: 0.42, sw };
    const st = createSteerStick();
    const t = run(st, 1000, 700, () => P(out, v, body), { body: () => body });
    return st.read(t);
  };
  for (const [out, v] of [[0, CHEST], [0.4, -0.3], [-0.45, 0.2], [0, -0.9]]) {
    const a = outAt(0.14, out, v), b = outAt(0.4, out, v);
    near(a.x, b.x, 1e-6, `x при out=${out}`); near(a.z, b.z, 1e-6, `z при v=${v}`);
    ok(a.engaged === b.engaged, 'engaged');
  }
});

test('наклон корпуса вместе с рукой не поворачивает, но виден как lean (для подсказки)', () => {
  let { st, t } = raised();
  const t0 = t;
  const bodyAt = (tt) => ({ ...BODY, x: BODY.x + 0.45 * BODY.sw * Math.min(1, (tt - t0) / 400) });
  t = run(st, t, 900, (tt) => P(0, CHEST, bodyAt(tt)), { body: bodyAt });
  const r = st.read(t);
  near(r.x, 0, 1e-6, 'поворота нет');
  ok(Math.abs(r.lean) > 0.3, 'lean ' + r.lean);
});

test('руки заняты чарами (busy): выход 0, рывка нет', () => {
  let { st, t } = raised();
  const t0 = t;
  t = run(st, t, 300, (tt) => P(0.8 * Math.min(1, (tt - t0) / 90), CHEST), { busy: true });
  const r = st.read(t);
  ok(!r.engaged && r.x === 0 && r.z === 0, 'стоим');
  ok(!st.takeDash(), 'рывок при чарах');
});

// рывок: дёрг на d sw за durMs и возврат за 300 мс
function jerk(st, t, dOut, dV, { durMs = 99, base = [0, CHEST], back = true } = {}) {
  const t0 = t, dashes = [], turns = [];
  t = run(st, t, durMs + 34, (tt) => { const k = Math.min(1, (tt - t0) / durMs); return P(base[0] + dOut * k, base[1] + dV * k); });
  let d = st.takeDash(); if (d) dashes.push(d);
  const t1 = t;
  if (back) {
    for (let i = 0; i < 20; i++) {
      t = run(st, t, 33, (tt) => { const k = Math.min(1, (tt - t1) / 300); return P(base[0] + dOut * (1 - k), base[1] + dV * (1 - k)); });
      d = st.takeDash(); if (d) dashes.push(d);
      turns.push(st.read(t).x);
    }
  }
  return { t, dashes, turns };
}

test('рывок работает: дёрг влево на экране → уклон влево; вправо — вправо; вверх — вперёд; ровно один', () => {
  for (const [dOut, dV, wx, wz, name] of [[0.8, 0, -1, 0, 'влево'], [-0.8, 0, 1, 0, 'вправо'], [0, 0.8, 0, 1, 'вперёд']]) {
    const { st, t } = raised();
    const r = jerk(st, t, dOut, dV);
    ok(r.dashes.length === 1, `${name}: рывков ${r.dashes.length} (${JSON.stringify(st.getDebug().counters)})`);
    ok(r.dashes[0].x * wx + r.dashes[0].z * wz > 0.85, `${name}: направление (${r.dashes[0].x.toFixed(2)}, ${r.dashes[0].z.toFixed(2)})`);
  }
});

test('рывок назад: дёрг вниз с возвратом (поднятая рука) → назад, и герой не останавливается насовсем', () => {
  const { st, t } = raised(0.1);
  const r = jerk(st, t, 0, -0.75, { base: [0, 0.1], durMs: 120 });
  ok(r.dashes.length === 1 && r.dashes[0].z < -0.85, 'назад: ' + JSON.stringify(r.dashes.map((d) => [d.x.toFixed(2), d.z.toFixed(2)])));
  ok(st.read(r.t).engaged, 'рука вернулась — снова идём');
});

test('во время и после дёрга руль не дёргается (поворот держится на значении до рывка)', () => {
  const { st, t } = raised();
  const r = jerk(st, t, 0.8, 0);
  ok(r.dashes.length === 1, 'рывок есть');
  const worst = Math.max(...r.turns.map(Math.abs));
  ok(worst < 0.2, `поворот при возврате руки ${worst.toFixed(2)}`);
});

test('подъём руки с колен (даже резкий) рывком не считается; обычное руление — тоже', () => {
  for (const ms of [120, 200, 350]) {
    const st = createSteerStick();
    let t = run(st, 1000, 600, () => P(0, -1.1));   // рука опущена, но в кадре
    const t0 = t;
    t = run(st, t, ms + 400, (tt) => P(0, -1.1 + (1.1 + CHEST) * Math.min(1, (tt - t0) / ms)));
    ok(!st.takeDash() && st.getDebug().counters.dashes === 0, `подъём за ${ms} мс дал рывок`);
    ok(st.read(t).engaged, 'после подъёма идём');
  }
  let { st, t } = raised();
  const t0 = t;
  t = run(st, t, 700, (tt) => P(0.55 * Math.min(1, (tt - t0) / 350), CHEST)); // руление: 0.55 sw за 0.35 с
  ok(!st.takeDash(), 'руление — не рывок');
  ok(st.read(t).x < -0.5, 'повернули');
});

test('рука опущена, но в кадре: боковой дёрг — уклон; дёрг вверх — нет', () => {
  let st = createSteerStick();
  let t = run(st, 1000, 600, () => P(0, -0.95));
  ok(!st.read(t).engaged, 'стоим');
  let r = jerk(st, t, -0.8, 0, { base: [0, -0.95] });
  ok(r.dashes.length === 1 && r.dashes[0].x > 0.85, 'боковой уклон вправо из покоя: ' + r.dashes.length);
  st = createSteerStick();
  t = run(st, 1000, 600, () => P(0, -0.95));
  r = jerk(st, t, 0, 0.8, { base: [0, -0.95], back: true });
  ok(r.dashes.length === 0, 'вверх из покоя — не рывок');
});

// ───────── [V6] ровный ход: провалы трекинга, плавный разгон, руль без дрожи ─────────
test('[V6] провал трекинга на ~¼ с при поднятой руке — герой не спотыкается (ход и поворот держатся)', () => {
  let { st, t } = raised();
  t = run(st, t, 400, () => P(0.45, CHEST));
  const before = st.read(t);
  let minZ = 1;
  for (let k = 0; k < 8; k++, t += 33) { st.push({ t, hand: null, body: BODY, mirror: true, aspect: ASPECT }); minZ = Math.min(minZ, st.read(t).z); }
  ok(minZ >= before.z - 1e-9 && st.read(t).x < -0.3, `ход не прервался: z≥${minZ} x=${st.read(t).x}`);
  t = run(st, t, 100, () => P(0.45, CHEST));
  ok(st.read(t).engaged, 'кисть вернулась — идём дальше');
});

test('[V6] шаг → бег разгоняется плавно (не рывком), бег → стоп — сразу', () => {
  let { st, t } = raised(-0.3);
  const walkZ = st.read(t).z;
  // рука поднимается к плечу за ~0,3 с (живой темп, не дёрг-рывок)
  const t0 = t;
  let zs = [];
  t = run(st, t, 330, (tt) => { zs.push(st.read(tt).z); return P(0, -0.3 + 0.6 * Math.min(1, (tt - t0) / 300)); });
  zs.push(st.read(t).z);
  let maxStep = 0;
  for (let i = 1; i < zs.length; i++) maxStep = Math.max(maxStep, zs[i] - zs[i - 1]);
  ok(st.getDebug().counters.dashes === 0, 'подъём руки — не рывок');
  ok(maxStep < 0.25, `разгон без скачка: наибольший шаг за кадр ${maxStep.toFixed(2)} (было бы ${(1 - walkZ).toFixed(2)})`);
  t = run(st, t, 700, () => P(0, 0.3));
  ok(st.read(t).z === 1, 'через ~0,7 с — полный бег: ' + st.read(t).z);
  st.push({ t, hand: { ...P(0, -1.6), scale: SCALE }, body: BODY, mirror: true, aspect: ASPECT });
  ok(st.read(t).z === 0 && !st.read(t).engaged, 'рука вниз — стоп на том же кадре');
});

test('[V6] руль не дрожит: рука в зоне поворота с шумом ±0.06 sw — разброс поворота мал', () => {
  let { st, t } = raised();
  t = run(st, t, 600, () => P(0.4, CHEST));
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 90; k++) { t = run(st, t, 33, () => P(0.4, CHEST), { jitter: 0.12 }); const x = st.read(t).x; lo = Math.min(lo, x); hi = Math.max(hi, x); }
  ok(hi < -0.2, 'поворачиваем влево: ' + hi);
  ok(hi - lo < 0.12, `разброс поворота ${(hi - lo).toFixed(3)}`);
});

test('[V6] привычка игрока: рука «прямо» на 0.3 sw не там, где ждёт игра — после пары подъёмов герой идёт прямо', () => {
  const st = createSteerStick();
  const HAB = -0.3;   // игроку удобнее держать ладонь ближе к середине груди
  let t = run(st, 1000, 400, () => P(HAB, -1.5));
  t = run(st, t, 330, () => P(HAB, CHEST));
  const before = Math.abs(st.read(t).x);
  ok(before > 0.1, 'пока привычка не выучена, такая рука заворачивает: ' + before);
  t = run(st, t, 900, () => P(HAB, CHEST));
  for (let k = 0; k < 2; k++) { t = run(st, t, 400, () => P(HAB, -1.5)); t = run(st, t, 1200, () => P(HAB, CHEST)); }
  const after = Math.abs(st.read(t).x);
  ok(after < 0.02, `после двух подъёмов — прямо: |x|=${after.toFixed(3)} (нейтраль ${st.getDebug().neutral})`);
  // и поворот от новой нейтрали работает в обе стороны
  t = run(st, t, 500, () => P(HAB + 0.45, CHEST));
  ok(st.read(t).x < -0.3, 'наружу — влево: ' + st.read(t).x);
  t = run(st, t, 500, () => P(HAB - 0.45, CHEST));
  ok(st.read(t).x > 0.3, 'к груди — вправо: ' + st.read(t).x);
});

test('[V6] привычка не «съедает» поворот: подняли руку и сразу увели вбок — нейтраль не сдвигается', () => {
  const st = createSteerStick();
  let t = run(st, 1000, 400, () => P(0, -1.5));
  const n0 = st.getDebug().neutral;
  t = run(st, t, 66, () => P(0, CHEST));
  t = run(st, t, 900, () => P(0.5, CHEST));
  ok(st.getDebug().neutral === n0, `нейтраль ${n0} → ${st.getDebug().neutral}`);
  ok(st.read(t).x < -0.4, 'поворот полный: ' + st.read(t).x);
});

test('[V6] быстрый перехват руля (поворот влево → резко вправо) и резкий подъём к плечу — не рывок', () => {
  let { st, t } = raised();
  t = run(st, t, 600, () => P(0.45, CHEST));
  ok(st.read(t).x < -0.3, 'сначала поворот влево');
  // резко (≈0,1 с) — на поворот вправо, без возврата
  const t0 = t;
  t = run(st, t, 700, (tt) => P(0.45 - 0.85 * Math.min(1, (tt - t0) / 100), CHEST));
  ok(!st.takeDash() && st.getDebug().counters.dashes === 0, 'перехват руля — не рывок: ' + JSON.stringify(st.getDebug().counters));
  ok(st.read(t).x > 0.3, 'поворачиваем вправо: ' + st.read(t).x);
  // резко к плечу — бег, а не рывок вперёд
  const t1 = t;
  t = run(st, t, 600, (tt) => P(-0.4, CHEST + 0.55 * Math.min(1, (tt - t1) / 100)));
  ok(!st.takeDash() && st.getDebug().counters.dashes === 0, 'рука к плечу — не рывок: ' + JSON.stringify(st.getDebug().counters));
  ok(st.read(t).gait === 'run', 'бежим');
});

test('мусор на входе не ломает модуль', () => {
  const st = createSteerStick();
  st.push(null); st.push({}); st.push({ t: NaN }); st.push({ t: 5, hand: { x: NaN, y: 1 } });
  st.push({ t: 6, hand: { x: 1, y: 1, scale: -3 }, body: { x: 'a' } });
  st.push({ t: 7, hand: { x: 1, y: 0.2, scale: 0.1 }, body: null });  // плеч не было ни разу — опора по умолчанию
  const r = st.read(10);
  ok(r && Number.isFinite(r.x) && Number.isFinite(r.z), 'числа');
});

// ───────── через конвейер кистей (core/handGestures.js) ─────────
// makeHand из dev/handGestures.test.mjs здесь не нужен: хватает «кисти»-заглушки с 21 точкой.
function fakeHand(cx, cy, { side = 'left', fist = false, size = 0.12 } = {}) {
  // грубая раскрытая ладонь (или кулак) вокруг (cx, cy) в незеркальном кадре; размер ≈ 0.12 кадра
  const s = size, L = [];
  const at = (dx, dy) => ({ x: cx + dx * s / ASPECT, y: cy + dy * s, z: 0 });
  L[0] = at(0, 0.45);
  const base = [[-0.3, 0.1], [-0.1, 0], [0.1, 0], [0.28, 0.08]];
  L[1] = at(-0.25, 0.35); L[2] = at(-0.4, 0.2); L[3] = at(-0.5, 0.05); L[4] = at(-0.58, -0.08);
  for (let f = 0; f < 4; f++) {
    const [bx, by] = base[f];
    for (let j = 0; j < 4; j++) L[5 + f * 4 + j] = fist ? at(bx * 0.8, by + 0.05 * j) : at(bx, by - 0.2 * j);
  }
  return { landmarks: L, world: null, handedness: side === 'left' ? 'Left' : 'Right', score: 0.95 };
}
const BODYN = { x: 0.5, y: 0.4 }, SWN = 0.25; // нормализованный кадр
const obs = (t, hands, extra = {}) => ({ tMs: t, frameW: 640, frameH: 480, mirror: true, hands, poseWrists: { left: { x: 0.64, y: 0.6, visibility: 0.9 }, right: { x: 0.36, y: 0.6, visibility: 0.9 } }, bodyCenter: extra.body || BODYN, shoulderWidth: SWN });
// левая ладонь: out/v в sw (как P выше), в нормализованных координатах кадра
const LH = (out, v, body = BODYN, size) => fakeHand(body.x + (C.neutralX + out) * SWN / ASPECT, body.y - v * SWN, { size });
function g8(g, t0, ms, fn, extra) { let t = t0; for (; t < t0 + ms; t += 33) g.push(obs(t, fn(t), typeof extra === 'function' ? extra(t) : extra)); return t; }

test('по умолчанию handGestures — джойстик (старые сценарии не меняются); moveMode:steer — руль', () => {
  const g0 = createHandGestures();
  let t = g8(g0, 1000, 400, () => [LH(0, CHEST)]);
  ok(g0.peek(t).stick && g0.peek(t).stick.mode !== 'steer', 'по умолчанию джойстик');
  const g = createHandGestures({ moveMode: 'steer' });
  t = g8(g, 1000, 400, () => [LH(0, CHEST)]);
  const f = g.peek(t);
  ok(f.stick && f.stick.mode === 'steer' && f.stick.engaged, 'руль: ' + JSON.stringify(g.getDebug().stick));
  ok(f.moveZ > 0 && Math.abs(f.moveX) < 1e-9, `вперёд: moveX=${f.moveX} moveZ=${f.moveZ}`);
});

test('конвейер: наружу → moveX < 0 (влево), к груди → > 0; опустить на колени → стоп; configure переключает схему', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  let t = g8(g, 1000, 66, () => [LH(0, CHEST)]);
  ok(g.peek(t).stick.mode === 'steer' && g.peek(t).moveZ > 0, 'руль: идём сразу, без хватки');
  t = g8(g, t, 500, () => [LH(0.5, CHEST)]);
  ok(g.peek(t).moveX < -0.4, 'влево: ' + g.peek(t).moveX);
  t = g8(g, t, 500, () => [LH(-0.5, CHEST)]);
  ok(g.peek(t).moveX > 0.4, 'вправо: ' + g.peek(t).moveX);
  t = g8(g, t, 200, () => [LH(0, -1.7)]);
  ok(g.peek(t).moveX === 0 && g.peek(t).moveZ === 0, 'стоп');
  g.configure({ moveMode: 'stick' });
  t = g8(g, t, 400, () => [LH(0, CHEST)]);
  ok(g.peek(t).stick.mode !== 'steer', 'переключились на джойстик');
});

test('[V6] «Руль»: подъём руки с колен (кисть растёт в кадре) и ходьба с шумом размера — щит НЕ поднимается', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  let t = g8(g, 1000, 600, () => [LH(0, -1.4, BODYN, 0.1)]);
  const t0 = t;
  let shield = false, stopped = 0, walking = 0;
  // поднимаем руку к груди, кисть при этом приближается к камере (0.10 → 0.13)
  t = g8(g, t, 400, (tt) => { const u = Math.min(1, (tt - t0) / 350); shield = shield || g.peek(tt).shield; return [LH(0, -1.4 + 1.15 * u, BODYN, 0.1 + 0.03 * u)]; });
  // идём 6 с: рука чуть гуляет к камере и обратно (±9% размера) и вбок — шум живой руки
  let k = 0;
  t = g8(g, t, 6000, (tt) => {
    const f = g.peek(tt); shield = shield || f.shield;
    if (f.moveZ > 0) walking++; else stopped++;
    k++;
    const wob = 0.13 * (1 + 0.09 * Math.sin(k * 0.9) + 0.03 * rnd());
    return [LH(0.04 * Math.sin(k * 0.3), CHEST + 0.05 * rnd(), BODYN, wob)];
  });
  ok(!shield, 'щит не поднялся сам: ' + JSON.stringify(g.getDebug().counters));
  ok(stopped === 0 && walking > 150, `герой шёл без остановок: шёл ${walking}, стоял ${stopped}`);
});

test('[V6] «Руль»: осознанный толчок ладонью — щит (герой стоит); убрал ладонь назад — щит опустился, идём', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  let t = g8(g, 1000, 900, () => [LH(0, CHEST, BODYN, 0.12)]);
  ok(g.peek(t).moveZ > 0 && !g.peek(t).shield, 'идём, щита нет');
  const t0 = t;
  t = g8(g, t, 220, (tt) => [LH(0, CHEST, BODYN, 0.12 + 0.05 * Math.min(1, (tt - t0) / 180))]);
  t = g8(g, t, 200, () => [LH(0, CHEST, BODYN, 0.17)]);
  let f = g.peek(t);
  ok(f.shield && f.moveZ === 0, 'толчок → щит, герой стоит: ' + JSON.stringify({ sh: f.shield, z: f.moveZ }));
  // пропал один кадр кисти — щит не мигает
  g.push(obs(t, []));
  ok(g.peek(t).shield, 'один пустой кадр — щит держится');
  t += 33;
  t = g8(g, t, 600, () => [LH(0, CHEST, BODYN, 0.17)]);
  ok(g.peek(t).shield, 'ладонь впереди — щит держится');
  const t1 = t;
  t = g8(g, t, 600, (tt) => [LH(0, CHEST, BODYN, 0.17 - 0.05 * Math.min(1, (tt - t1) / 200))]);
  f = g.peek(t);
  ok(!f.shield && f.moveZ > 0, 'убрал ладонь назад → щит опущен, идём: ' + JSON.stringify({ sh: f.shield, z: f.moveZ }));
});

test('[ОШИБКА] рука поднята, но ниже груди → подсказка steer_low (одна, не спам)', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  let t = g8(g, 1000, 600, () => [LH(0, -1.5)]);
  const t0 = t, codes = [];
  t = g8(g, t, 6000, (tt) => { const f = g.read(tt); if (f.hint) codes.push(f.hint.code); return [LH(0, -1.5 + 0.7 * Math.min(1, (tt - t0) / 400))]; });
  const n = codes.filter((c) => c === 'steer_low').length;
  ok(n === 1, `steer_low: ${n} (${codes})`);
  ok(hintInfo('steer_low') && /груди/.test(hintInfo('steer_low').text), 'текст подсказки');
  // просто держать руку на коленях — без подсказки
  const g2 = createHandGestures({ moveMode: 'steer' });
  const c2 = [];
  g8(g2, 1000, 6000, (tt) => { const f = g2.read(tt); if (f.hint) c2.push(f.hint.code); return [LH(0, -1.5)]; });
  ok(!c2.includes('steer_low'), 'рука спокойно внизу — подсказки нет: ' + c2);
});

test('[ОШИБКА] поворот наклоном корпуса → подсказка steer_lean', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  let t = g8(g, 1000, 800, () => [LH(0, CHEST)]);
  const t0 = t, codes = [];
  const bodyAt = (tt) => ({ x: BODYN.x + 0.45 * SWN / ASPECT * Math.min(1, (tt - t0) / 300), y: BODYN.y });
  t = g8(g, t, 2500, (tt) => { const f = g.read(tt); if (f.hint) codes.push(f.hint.code); return [LH(0, CHEST, bodyAt(tt))]; }, (tt) => ({ body: bodyAt(tt) }));
  ok(codes.includes('steer_lean'), 'steer_lean: ' + codes);
  ok(hintInfo('steer_lean') && /корпус/.test(hintInfo('steer_lean').text), 'текст подсказки');
});

// ───────── бой (modules/combat.js) и камера (core/cameraRig.js) в схеме «Руль» ─────────
const idleBrain = () => ({ reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } });
const IN = (o = {}) => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, moveMode: 'steer', ...o });
function fight(spawn = { x: 0, z: 30, yaw: Math.PI }) {
  return createCombat({ config: {}, bossBrain: idleBrain(), layout: { ...DEFAULT_LAYOUT, playerSpawn: spawn } });
}
function runC(c, sec, fn, fps = 60) {
  const ev = [];
  for (let i = 0, n = Math.round(sec * fps); i < n; i++) { c.update(1 / fps, fn(c.getSnapshot(), i / fps)); ev.push(...c.drainEvents()); }
  return ev;
}
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

test('бой, вне арены: moveZ ведёт героя по его курсу (viewYaw не важен); moveX поворачивает', () => {
  const c = fight();
  const p0 = c.getSnapshot().player.position;
  runC(c, 1, () => IN({ moveZ: 1, viewYaw: 0.7 }));
  let s = c.getSnapshot();
  ok(s.player.encounter === 'explore' && s.player.moveMode === 'steer', 'explore + steer');
  near(wrapA(s.player.yaw - Math.PI), 0, 1e-6, 'курс не менялся');
  ok(p0.z - s.player.position.z > 3.5 && Math.abs(s.player.position.x - p0.x) < 0.05, `шёл прямо по курсу: Δz=${(p0.z - s.player.position.z).toFixed(2)} Δx=${(s.player.position.x - p0.x).toFixed(3)}`);
  // поворот на месте: полный поворот влево 0.5 с
  const y0 = s.player.yaw;
  runC(c, 0.5, () => IN({ moveX: -1 }));
  s = c.getSnapshot();
  const turned = wrapA(s.player.yaw - y0);
  near(Math.abs(turned), 2.4 * 0.5, 0.05, 'скорость поворота');
  // влево для камеры за спиной: вперёд (sin y, cos y), вправо (−cos y, sin y) → курс повернулся к «левому»
  const left0 = { x: Math.cos(y0), z: -Math.sin(y0) };
  const f1 = { x: Math.sin(s.player.yaw), z: Math.cos(s.player.yaw) };
  ok(f1.x * left0.x + f1.z * left0.z > 0.5, 'повернул налево: ' + JSON.stringify(f1));
});

test('бой: рука вниз (moveZ=0) — стоп; после спринта автобега в «Руле» нет', () => {
  const c = fight({ x: 0, z: 60, yaw: Math.PI });
  const ev = runC(c, 3, () => IN({ moveZ: 1 }));
  ok(c.getSnapshot().player.sprint > 0.9, 'спринт набран: ' + c.getSnapshot().player.sprint);
  const ev2 = runC(c, 0.4, () => IN({ moveZ: 0, stick: { mode: 'steer', rest: true, engaged: false } }));
  const s = c.getSnapshot();
  ok(s.player.speed < 0.1, 'стоит: ' + s.player.speed.toFixed(2));
  ok(![...ev, ...ev2].some((e) => e.type === 'cruise_start'), 'автобега нет');
});

test('бой, в арене: moveX — обход Регента по кругу (дистанция держится), moveZ — сближение, назад не идёт', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  let s = c.getSnapshot();
  ok(s.player.encounter === 'engaged', 'старт в арене');
  const r0 = s.player.orbitRadius, a0 = s.player.orbitAngle;
  runC(c, 3, () => IN({ moveX: 1, moveZ: 0.45 }));
  s = c.getSnapshot();
  ok(Math.abs(s.player.orbitRadius - r0) < 0.25, `дистанция ${r0.toFixed(2)} → ${s.player.orbitRadius.toFixed(2)}`);
  ok(Math.abs(wrapA(s.player.orbitAngle - a0)) > 0.5, 'обошёл по кругу');
  const r1 = s.player.orbitRadius;
  runC(c, 0.8, () => IN({ moveZ: 1 }));
  ok(c.getSnapshot().player.orbitRadius < r1 - 1.5, 'сближение');
  const r2 = c.getSnapshot().player.orbitRadius;
  runC(c, 0.8, () => IN({ moveZ: -1 }));
  ok(c.getSnapshot().player.orbitRadius <= r2 + 0.05, 'назад в «Руле» не ходит');
});

test('бой: рывок в «Руле» — относительно героя (влево от курса), а не от viewYaw', () => {
  const c = fight({ x: 0, z: 40, yaw: Math.PI / 2 });
  let got = null;
  runC(c, 0.1, (snap, t) => IN({ viewYaw: 0, dashDir: t === 0 ? { x: -1, z: 0 } : null }));
  const s = c.getSnapshot();
  ok(s.player.dashDir, 'рывок идёт');
  const y = s.player.yaw, left = { x: Math.cos(y), z: -Math.sin(y) };
  got = s.player.dashDir;
  ok(got.x * left.x + got.z * left.z > 0.95, 'влево от курса героя: ' + JSON.stringify(got));
});

test('камера: в «Руле» вне арены держится за спиной героя (курс камеры догоняет курс героя)', () => {
  const c = fight();
  const rig = createCameraRig(gameConfig.camera);
  const st = (snap) => ({ player: snap.player.position, playerYaw: snap.player.yaw, velocity: snap.player.velocity, boss: snap.boss.position, engaged: snap.player.encounter !== 'explore', steer: snap.player.moveMode === 'steer' });
  rig.reset(st(c.getSnapshot()));
  let maxLag = 0;
  for (let i = 0; i < 180; i++) {
    c.update(1 / 60, IN({ moveX: i < 90 ? -1 : 0, moveZ: 0.6, viewYaw: rig.inputYaw }));
    rig.update(1 / 60, st(c.getSnapshot()));
    maxLag = Math.max(maxLag, Math.abs(wrapA(rig.inputYaw - c.getSnapshot().player.yaw)));
  }
  const lag = Math.abs(wrapA(rig.inputYaw - c.getSnapshot().player.yaw));
  ok(lag < 0.05, `через 1.5 с после поворота камера за спиной: отставание ${(lag * 180 / Math.PI).toFixed(1)}°`);
  ok(maxLag < 0.6, `на повороте отставание не больше ~35°: ${(maxLag * 180 / Math.PI).toFixed(1)}°`);
});

test('DEBUG-клавиатура в «Руле»: W — вперёд, A/D — поворот (на месте — без хода), S — стоп; «Джойстик» — как раньше', () => {
  const handlers = {};
  const target = { addEventListener: (k, f) => { handlers[k] = f; }, removeEventListener() {} };
  const dbg = createDebugInput(target);
  dbg.setEnabled(true);
  const key = (type, code) => handlers[type]({ code, repeat: false, target: null, preventDefault() {} });
  key('keydown', 'KeyW'); key('keydown', 'KeyA');
  let f = dbg.read();
  ok(f.moveMode === 'steer' && f.stick.mode === 'steer', 'схема руль');
  ok(f.moveX === -1 && f.moveZ === 1, `W+A: moveX=${f.moveX} moveZ=${f.moveZ}`);
  key('keydown', 'KeyS');
  f = dbg.read();
  ok(f.moveZ === 0 && f.moveX === -1, 'S — стоп хода, поворот остаётся');
  key('keyup', 'KeyS'); key('keyup', 'KeyW');
  // A на месте: герой поворачивается, но не идёт
  const c = fight();
  const y0 = c.getSnapshot().player.yaw, p0 = c.getSnapshot().player.position;
  for (let i = 0; i < 30; i++) c.update(1 / 60, { ...dbg.read(), viewYaw: 0 });
  const s = c.getSnapshot();
  ok(Math.abs(wrapA(s.player.yaw - y0)) > 0.5, 'повернулся на месте');
  ok(Math.hypot(s.player.position.x - p0.x, s.player.position.z - p0.z) < 0.01, 'и не сдвинулся');
  dbg.setMoveMode('stick');
  key('keydown', 'KeyW');
  f = dbg.read();
  ok(f.moveMode === 'stick' && f.stick.mode !== 'steer' && Math.abs(Math.hypot(f.moveX, f.moveZ) - 1) < 1e-9, 'джойстик: вектор нормирован');
});

test('производительность: push + read', () => {
  const st = createSteerStick();
  const t0 = performance.now();
  let t = 0;
  for (let i = 0; i < 20000; i++) { t += 33; st.push({ t, hand: { ...P(Math.sin(i / 20) * 0.6, Math.cos(i / 30) * 0.8 - 0.2), scale: SCALE }, body: BODY, mirror: true, aspect: ASPECT }); st.read(t); }
  const us = ((performance.now() - t0) / 20000) * 1000;
  ok(us < 60, `${us.toFixed(1)} мкс/кадр`);
  results.push(`     (push+read: ${us.toFixed(1)} мкс/кадр)`);
});

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
