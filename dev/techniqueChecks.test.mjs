// Тесты прогресса условий техники (тренажёр, твист «ОШИБКА»): checks() в core/handGestures.js и
// read().checks в core/squatCounter.js / core/pushupCounter.js. node dev/techniqueChecks.test.mjs
// Синтетика (dev/handSynth.mjs, synthSquatPose, поза отжиманий как в dev/pushup.test.mjs), не реальная камера.
// Главное: условия считаются теми же порогами, что решения распознавателя («все ✓» ⇒ жест распознан),
// и чтение checks ничего не меняет в распознавании.

import { createHandGestures, CHECK_GESTURES, CHECK_WINDOW_MS } from '../core/handGestures.js';
import { createSquatCounter, synthSquatPose } from '../core/squatCounter.js';
import { createPushupCounter } from '../core/pushupCounter.js';
import { makeHand, SHAPES, reseed } from './handSynth.mjs';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// ───────── кисти ─────────
const obsOf = (t, hands) => ({ tMs: t, frameW: 640, frameH: 480, mirror: true, hands, poseWrists: null, bodyCenter: null, shoulderWidth: 0.35 });
function run(g, t0, ms, fn, each) {
  let t = t0;
  for (; t < t0 + ms; t += 33) { g.push(obsOf(t, fn(t))); const f = g.read(t); if (each) each(f, t); }
  return t;
}
const R_AT = (o = {}) => makeHand({ side: 'right', cx: 0.36, cy: 0.55, size: 0.12, ...o });
const L_AT = (o = {}) => makeHand({ side: 'left', cx: 0.62, cy: 0.55, size: 0.12, ...o });
// щит: ладонь стоит, затем толчок к камере (кисть растёт в кадре), как в dev/handGestures.test.mjs
function pushLeft(g, t0, o = {}, each) {
  let t = run(g, t0, 500, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12, ...o })], each);
  t = run(g, t, 200, (tt) => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12 + 0.04 * Math.min(1, (tt - t) / 180), ...o })], each);
  return run(g, t, 150, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.16, ...o })], each);
}
// СФЕРА: обе ладони друг к другу (поворот вокруг вертикали), кисти по бокам от центра
function orbPose(o = {}) {
  const { half = 0.12, cx = 0.5, cy = 0.55, size = 0.14, yaw = 1.2, dy = 0 } = o;
  return [
    makeHand({ ...SHAPES.open, side: 'left', cx: cx + half, cy, yaw, size }),
    makeHand({ ...SHAPES.open, side: 'right', cx: cx - half, cy: cy - dy, yaw: -yaw, size }),
  ];
}
const byKey = (blk) => Object.fromEntries(blk.items.map((i) => [i.key, i]));
const allOk = (blk) => blk.items.every((i) => i.ok === true);
const fmt = (blk) => `present=${blk.present} rec=${blk.recognized} ` + blk.items.map((i) => `${i.key}:${i.ok}/${i.value}`).join(' ');
// жест держится ms — checks в конце
function hold(id, hands, ms = 600) {
  const g = createHandGestures();
  const t = run(g, 1000, ms, () => hands);
  return { g, t, c: g.checks(t)[id] };
}

// ───────── API ─────────
test('API: CHECK_GESTURES, checks(t) и getDebug().checks; поля условий; value = 1 ⇔ ok', () => {
  eq(CHECK_GESTURES.join(','), 'ok,shield,spark,burst,parry,orb', 'список жестов');
  ok(Object.isFrozen(CHECK_GESTURES), 'список заморожен');
  ok(CHECK_WINDOW_MS >= 1000 && CHECK_WINDOW_MS <= 2000, 'окно условий-движений ~1,5 с');
  const keys = {
    ok: 'ring,others,index,frame,near', shield: 'open,facing,push,frame,near', spark: 'load,index,middle,rest,frame,near',
    burst: 'fist,charge,snap,frame,near', parry: 'fist,facing,snap,frame', orb: 'both,open,facing,level,gap',
  };
  const hands = { ok: 'right', shield: 'left', spark: 'right', burst: 'right', parry: 'left', orb: 'both' };
  const { g, t } = hold('ok', [R_AT({ ...SHAPES.ok }), L_AT({ ...SHAPES.open })]);
  const c = g.checks(t);
  eq(c.t, t - 33, 't — время последнего наблюдения');
  for (const id of CHECK_GESTURES) {
    const b = c[id];
    eq(b.id, id, 'id'); eq(b.hand, hands[id], `${id}.hand`);
    eq(b.items.map((i) => i.key).join(','), keys[id], `${id}: ключи и порядок`);
    for (const i of b.items) {
      ok(typeof i.value === 'number' && i.value >= 0 && i.value <= 1, `${id}.${i.key}: value ${i.value}`);
      ok(i.ok === true || i.ok === false || i.ok === null, `${id}.${i.key}: ok ${i.ok}`);
      ok((i.ok === true) === (i.value === 1), `${id}.${i.key}: value=1 ⇔ ok (${i.ok}/${i.value})`);
      ok(i.hint === null || typeof i.hint === 'string', `${id}.${i.key}: hint`);
      ok(Array.isArray(i.landmarks) && i.landmarks.length && i.landmarks.every((k) => Number.isInteger(k) && k >= 0 && k <= 20), `${id}.${i.key}: landmarks`);
      ok(['left', 'right', 'both'].includes(i.hand), `${id}.${i.key}: hand ${i.hand}`);
      eq(typeof i.transient, 'boolean', `${id}.${i.key}: transient`);
    }
  }
  eq(JSON.stringify(g.getDebug().checks), JSON.stringify(g.checks(c.t)), 'getDebug().checks = checks(время последнего кадра)');
  // условия-движения помечены transient
  eq(c.shield.items.filter((i) => i.transient).map((i) => i.key).join(','), 'push', 'щит: transient');
  eq(c.burst.items.filter((i) => i.transient).map((i) => i.key).join(','), 'fist,charge,snap', 'выброс: transient');
});

test('чтение checks не меняет распознавание: два одинаковых потока кадров — одинаковые решения', () => {
  // смешанный сценарий с шумом: выброс, парирование, щит, «Искра», сфера, «OK», руки опущены
  reseed(99);
  const frames = [];
  const add = (ms, fn) => { const n = Math.round(ms / 33); for (let i = 0; i < n; i++) frames.push(fn(i / n)); };
  const nz = { noise: 0.01 };
  add(500, () => [R_AT({ ...SHAPES.open, ...nz })]);
  add(900, () => [R_AT({ ...SHAPES.fist, ...nz })]);
  add(400, () => [R_AT({ ...SHAPES.open, ...nz })]);
  add(500, () => [L_AT({ ...SHAPES.fist, ...nz })]);
  add(400, () => [L_AT({ ...SHAPES.open, ...nz })]);
  add(500, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12, ...nz })]);
  add(200, (k) => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12 + 0.04 * k, ...nz })]);
  add(300, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.16, ...nz })]);
  add(600, () => [R_AT({ ...SHAPES.fist, ...nz })]);
  add(330, () => [R_AT({ ...SHAPES.point, ...nz })]);
  add(900, () => orbPose());
  add(600, () => [R_AT({ ...SHAPES.ok, ...nz }), L_AT({ ...SHAPES.open, ...nz })]);
  add(600, () => [R_AT({ curls: [0.55, 0, 0, 0], thumb: 'in', ...nz })]);
  add(400, () => []);
  const a = createHandGestures(), b = createHandGestures();
  let t = 1000, diff = null;
  for (const hands of frames) {
    a.push(obsOf(t, hands)); b.push(obsOf(t, hands));
    b.checks(t); b.getDebug(); b.checks(t + 500);   // b читает условия каждый кадр (и «из будущего»)
    const fa = JSON.stringify(a.read(t)), fb = JSON.stringify(b.read(t));
    if (fa !== fb && !diff) diff = `кадр ${t}: ${fa.slice(0, 200)} ≠ ${fb.slice(0, 200)}`;
    t += 33;
  }
  ok(!diff, diff);
  const da = a.getDebug(), db = b.getDebug();
  eq(JSON.stringify(da.counters), JSON.stringify(db.counters), 'счётчики');
  eq(JSON.stringify(da.hints), JSON.stringify(db.hints), 'подсказки');
  ok(da.counters.bursts >= 1 && da.counters.parries >= 1 && da.counters.sparks >= 1 && da.counters.conjures >= 1, 'сценарий прошёл жесты: ' + JSON.stringify(da.counters));
});

// ───────── «OK» ─────────
test('«OK»: правильный → все условия ✓, recognized', () => {
  const { c } = hold('ok', [R_AT({ ...SHAPES.ok })]);
  ok(c.present && allOk(c) && c.recognized, fmt(c));
});

test('«OK»: кольцо разомкнуто → ring ✗ (ok_ring_open, точки 4 и 8), остальное ✓, не распознан', () => {
  for (const pose of [{ curls: [0.45, 0, 0, 0], thumb: 'out' }, { curls: [0.55, 0, 0, 0], thumb: 'in' }]) {
    const { c } = hold('ok', [R_AT(pose)]);
    const k = byKey(c);
    eq(k.ring.ok, false, 'ring ' + fmt(c));
    eq(k.ring.hint, 'ok_ring_open', 'код подсказки');
    ok(k.ring.landmarks.includes(4) && k.ring.landmarks.includes(8), 'точки кольца');
    ok(k.ring.value > 0.5 && k.ring.value < 1, 'почти сомкнуто — прогресс высокий: ' + k.ring.value);
    for (const key of ['others', 'index', 'frame', 'near']) eq(k[key].ok, true, `${key} ${fmt(c)}`);
    eq(c.recognized, false, 'не распознан');
  }
});

test('«OK»: согнуты средний и безымянный → others ✗ (ok_fingers), кольцо ✓', () => {
  for (const pose of [{ curls: [0.45, 0.8, 0.9, 0], thumb: 'pinch' }, { curls: [0.45, 0.2, 0.9, 0.9], thumb: 'pinch' }]) {
    const { c } = hold('ok', [R_AT(pose)]);
    const k = byKey(c);
    eq(k.others.ok, false, 'others ' + fmt(c));
    eq(k.others.hint, 'ok_fingers', 'код подсказки');
    eq(k.ring.ok, true, 'кольцо сомкнуто ' + fmt(c));
    eq(c.recognized, false, 'не распознан');
  }
});

test('«OK»: на сетке поз «все ✓» ⇔ распознан (те же пороги, что у classify)', () => {
  let n = 0, both = 0;
  const bad = [];
  for (const thumb of ['pinch', 'in', 'out']) for (const c0 of [0, 0.3, 0.45, 0.7]) for (const c1 of [0, 0.5]) for (const c2 of [0, 0.9]) for (const roll of [-0.4, 0.3]) {
    const pose = { curls: [c0, c1, c2, c2 * 0.5], thumb, roll };
    const { c } = hold('ok', [R_AT(pose)]);
    n++; if (allOk(c) && c.recognized) both++;
    if (allOk(c) !== c.recognized) bad.push(JSON.stringify(pose) + ' ' + fmt(c));
  }
  ok(!bad.length, `${bad.length} из ${n}: ${bad.slice(0, 3).join(' | ')}`);
  ok(both >= 4, 'на сетке есть правильные «OK»: ' + both);
});

// ───────── щит ─────────
test('щит: толчок ладонью к камере → push ✓ и recognized, все условия ✓', () => {
  const g = createHandGestures();
  const t = pushLeft(g, 1000);
  const c = g.checks(t).shield;
  ok(allOk(c) && c.recognized, fmt(c));
  ok(g.peek(t).shield, 'щит поднят и в HandIntent');
});

test('щит: ладонь тыльной стороной (толчок был) → facing ✗ (shield_palm), не распознан', () => {
  const g = createHandGestures();
  const t = pushLeft(g, 1000, { palm: 'away' });
  const c = g.checks(t).shield, k = byKey(c);
  eq(k.facing.ok, false, 'facing ' + fmt(c));
  eq(k.facing.hint, 'shield_palm', 'код');
  eq(k.open.ok, true, 'ладонь раскрыта');
  eq(c.recognized, false, 'щита нет');
});

test('щит: ладонь ребром → facing ✗ с частичным прогрессом; ладонь просто стоит → push ✗ (shield_push)', () => {
  let g = createHandGestures();
  let t = pushLeft(g, 1000, { yaw: 1.35 });
  let k = byKey(g.checks(t).shield);
  ok(k.facing.ok === false && k.facing.value > 0 && k.facing.value < 1, 'ребром: ' + JSON.stringify(k.facing));
  g = createHandGestures();
  t = run(g, 1000, 900, () => [L_AT({ ...SHAPES.open })]);
  const c = g.checks(t).shield;
  k = byKey(c);
  eq(k.push.ok, false, 'без толчка ' + fmt(c));
  eq(k.push.hint, 'shield_push', 'код');
  ok(k.facing.ok && k.open.ok, 'ладонь к камере раскрыта');
  eq(c.recognized, false, 'щита нет');
});

test('щит: на сетке толчков «все ✓» ⇔ щит поднят (джойстик и «Руль»)', () => {
  const bad = [];
  let rec = 0;
  for (const moveMode of ['stick', 'steer']) for (const palm of ['camera', 'away']) for (const yaw of [0, 1.35]) for (const grow of [0.01, 0.03, 0.05]) for (const growMs of [60, 180, 400]) {
    const g = createHandGestures({ moveMode });
    let everAll = false, everRec = false, t = 1000;
    const step = (size) => { g.push(obsOf(t, [makeHand({ ...SHAPES.open, side: 'left', cx: 0.62, cy: 0.5, palm, yaw, size })])); g.read(t); const c = g.checks(t).shield; everAll = everAll || allOk(c); everRec = everRec || c.recognized; t += 33; };
    for (let i = 0; i < 16; i++) step(0.12);
    const t0 = t;
    while (t < t0 + growMs + 40) step(0.12 + grow * Math.min(1, (t - t0) / growMs));
    for (let i = 0; i < 12; i++) step(0.12 + grow);
    if (everRec) rec++;
    if (everAll !== everRec) bad.push(JSON.stringify({ moveMode, palm, yaw, grow, growMs, everAll, everRec }));
  }
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  ok(rec >= 4, 'на сетке есть настоящие толчки: ' + rec);
});

// ───────── СФЕРА ─────────
test('сфера: ладони друг к другу → все условия ✓, recognized', () => {
  const { c } = hold('orb', orbPose(), 700);
  ok(c.present && allOk(c) && c.recognized, fmt(c));
});

test('сфера: одна рука выше → level ✗ (orb_dy), остальное ✓; ладони к камере → facing ✗ (orb_facing)', () => {
  let { c } = hold('orb', (() => { const [l, r] = orbPose({ half: 0.1 }); r.landmarks = r.landmarks.map((p) => ({ ...p, y: p.y - 0.2 })); return [l, r]; })(), 700);
  let k = byKey(c);
  eq(k.level.ok, false, 'level ' + fmt(c));
  eq(k.level.hint, 'orb_dy', 'код');
  for (const key of ['both', 'open', 'facing', 'gap']) eq(k[key].ok, true, `${key} ${fmt(c)}`);
  eq(c.recognized, false, 'не сфера');
  ({ c } = hold('orb', orbPose({ yaw: 0 }), 700));
  k = byKey(c);
  eq(k.facing.ok, false, 'facing ' + fmt(c));
  eq(k.facing.hint, 'orb_facing', 'код');
  eq(c.recognized, false, 'не сфера');
});

test('сфера: руки слишком широко → gap ✗ (orb_far); видна одна кисть → both ✗ (hands_missing), прочее не оценить', () => {
  let { c } = hold('orb', orbPose({ half: 0.42, size: 0.1 }), 700);
  let k = byKey(c);
  eq(k.gap.ok, false, 'gap ' + fmt(c));
  eq(k.gap.hint, 'orb_far', 'код');
  ({ c } = hold('orb', [orbPose()[0]], 700));
  k = byKey(c);
  eq(c.present, false, 'present');
  ok(k.both.ok === false && k.both.hint === 'hands_missing' && k.both.value === 0.5, 'both ' + JSON.stringify(k.both));
  eq(k.both.hand, 'right', 'не хватает правой');
  for (const key of ['open', 'facing', 'level', 'gap']) eq(k[key].ok, null, key);
});

test('сфера: на сетке поз «все ✓» ⇔ сфера вызвана (кроме позы призмы — тогда вызвана призма)', () => {
  const bad = [];
  let rec = 0;
  for (const half of [0.1, 0.14, 0.2, 0.3, 0.4]) for (const yaw of [0, 0.4, 0.8, 1.2, 1.5]) for (const dy of [0, 0.1, 0.2]) {
    const { g, c } = hold('orb', orbPose({ half, yaw, dy }), 700);
    if (c.recognized) rec++;
    const ev = g.getDebug().conjure.eval;
    if (allOk(c) !== c.recognized && !(ev && ev.kind === 'prism')) bad.push(JSON.stringify({ half, yaw, dy }) + ' ' + fmt(c));
  }
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  ok(rec >= 4, 'на сетке есть сферы: ' + rec);
});

// ───────── «Искра», выброс, парирование ─────────
test('«Искра»: кулак → указательный → все условия ✓, recognized; «V» → middle ✗ (spark_one)', () => {
  let g = createHandGestures();
  let t = run(g, 1000, 600, () => [R_AT({ ...SHAPES.fist })]);
  let k = byKey(g.checks(t).spark);
  ok(k.load.ok && k.middle.ok && k.rest.ok && !k.index.ok, 'в кулаке: заряд ✓, указательный ещё согнут ' + fmt(g.checks(t).spark));
  t = run(g, t, 200, () => [R_AT({ ...SHAPES.point })]);
  let c = g.checks(t).spark;
  ok(allOk(c) && c.recognized, fmt(c));
  g = createHandGestures();
  t = run(g, 1000, 600, () => [R_AT({ ...SHAPES.fist })]);
  t = run(g, t, 200, () => [R_AT({ ...SHAPES.victory })]);
  k = byKey(g.checks(t).spark);
  ok(k.middle.ok === false && k.middle.hint === 'spark_one' && k.middle.landmarks.includes(12), 'middle ' + JSON.stringify(k.middle));
});

test('«Искра»: указательный выпрямлен медленно (после sparkFlickMs) → load ✗, искры нет', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => [R_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [R_AT({ ...SHAPES.claw })]);
  t = run(g, t, 300, () => [R_AT({ ...SHAPES.point })]);
  const c = g.checks(t).spark, k = byKey(c);
  eq(c.recognized, false, 'искры нет ' + fmt(c));
  eq(k.load.ok, false, 'load ' + fmt(c));
  ok(k.index.ok, 'указательный выпрямлен');
});

test('выброс: кулак 0,9 с → ладонь → все условия ✓, recognized; короткий кулак → charge ✗ (burst_short)', () => {
  let g = createHandGestures();
  let t = run(g, 1000, 900, () => [R_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [R_AT({ ...SHAPES.open })]);
  let c = g.checks(t).burst;
  ok(allOk(c) && c.recognized, fmt(c));
  g = createHandGestures();
  t = run(g, 1000, 500, () => [R_AT({ ...SHAPES.open })]);
  t = run(g, t, 280, () => [R_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [R_AT({ ...SHAPES.open })]);
  c = g.checks(t).burst;
  const k = byKey(c);
  ok(k.charge.ok === false && k.charge.hint === 'burst_short' && k.charge.value > 0.5, 'charge ' + JSON.stringify(k.charge));
  ok(k.fist.ok && k.snap.ok, 'кулак был, раскрыл резко ' + fmt(c));
  eq(c.recognized, false, 'выброса нет');
});

test('выброс: раскрыл медленно (через полусжатую кисть) → snap ✗ (burst_slow), и подсказка та же', () => {
  const g = createHandGestures();
  const codes = [];
  let t = run(g, 1000, 900, () => [R_AT({ ...SHAPES.fist })]);
  // полусжатая кисть («коготь») сменяет кулак через hold.unknown, дальше окно releaseWindowMs уходит
  t = run(g, t, 900, () => [R_AT({ ...SHAPES.claw })], (f) => { if (f.hint) codes.push(f.hint.code); });
  t = run(g, t, 300, () => [R_AT({ ...SHAPES.open })], (f) => { if (f.hint) codes.push(f.hint.code); });
  const c = g.checks(t).burst, k = byKey(c);
  ok(k.snap.ok === false && k.snap.hint === 'burst_slow' && k.snap.value < 1, 'snap ' + JSON.stringify(k.snap));
  ok(k.charge.ok && k.fist.ok, 'кулак с зарядом был ' + fmt(c));
  eq(c.recognized, false, 'выброса нет');
  ok(codes.includes('burst_slow'), 'распознаватель подсказал то же: ' + codes);
});

test('парирование: кулак 0,5 с → ладонь к камере → все ✓, recognized; ладонь от камеры → facing ✗ (parry_palm)', () => {
  let g = createHandGestures();
  let t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [L_AT({ ...SHAPES.open })]);
  let c = g.checks(t).parry;
  ok(allOk(c) && c.recognized, fmt(c));
  g = createHandGestures();
  t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [L_AT({ ...SHAPES.open, palm: 'away' })]);
  c = g.checks(t).parry;
  const k = byKey(c);
  ok(k.facing.ok === false && k.facing.hint === 'parry_palm', 'facing ' + JSON.stringify(k.facing));
  eq(c.recognized, false, 'парирования нет');
  // мимолётный кулак — fist ✗
  g = createHandGestures();
  t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.open })]);
  t = run(g, t, 150, () => [L_AT({ ...SHAPES.fist })]);
  t = run(g, t, 300, () => [L_AT({ ...SHAPES.open })]);
  c = g.checks(t).parry;
  ok(byKey(c).fist.ok === false && !c.recognized, 'короткий кулак ' + fmt(c));
});

test('условия-движения держатся окно CHECK_WINDOW_MS, потом гаснут', () => {
  const g = createHandGestures();
  let t = pushLeft(g, 1000);
  ok(byKey(g.checks(t).shield).push.ok, 'сразу после толчка');
  // ладонь убрали назад — щит опускается; через окно толчок уже не засчитан
  t = run(g, t, CHECK_WINDOW_MS + 300, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12 })]);
  const c = g.checks(t).shield;
  eq(c.recognized, false, 'щит опущен ' + fmt(c));
  eq(byKey(c).push.ok, false, 'толчок устарел');
});

test('кисти нет → present:false, кадр ✗ (hands_missing), остальные условия не оценить (null)', () => {
  const g = createHandGestures();
  ok(!g.checks(0).ok.present, 'до первого кадра');
  const t = run(g, 1000, 400, () => []);
  for (const id of ['ok', 'shield', 'spark', 'burst', 'parry']) {
    const c = g.checks(t)[id], k = byKey(c);
    eq(c.present, false, id);
    ok(k.frame.ok === false && k.frame.hint === 'hands_missing', `${id}.frame ${JSON.stringify(k.frame)}`);
    ok(c.items.filter((i) => i.key !== 'frame').every((i) => i.ok === null && i.value === 0), `${id}: ${fmt(c)}`);
  }
  ok(g.checks(t).orb.items[0].ok === false, 'сфера: both ✗');
  // кисть у края кадра — frame ✗ (hand_edge)
  const h = hold('ok', [R_AT({ ...SHAPES.ok, cx: 0.03 })]).c;
  ok(byKey(h).frame.ok === false && byKey(h).frame.hint === 'hand_edge', 'у края ' + fmt(h));
});

test('правильные жесты не вызывают подсказок, даже когда условия читают каждый кадр', () => {
  const hintsOf = (g) => g.getDebug().counters.hints;
  const each = (g) => () => { g.checks(); g.getDebug(); };
  let g = createHandGestures();
  let t = run(g, 1000, 900, () => [R_AT({ ...SHAPES.fist })], each(g));
  run(g, t, 400, () => [R_AT({ ...SHAPES.open })], each(g));
  eq(hintsOf(g), 0, 'выброс: ' + JSON.stringify(g.getDebug().hints));
  g = createHandGestures();
  t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })], each(g));
  run(g, t, 400, () => [L_AT({ ...SHAPES.open })], each(g));
  eq(hintsOf(g), 0, 'парирование');
  g = createHandGestures(); pushLeft(g, 1000, {}, each(g));
  eq(hintsOf(g), 0, 'щит толчком');
  g = createHandGestures();
  t = run(g, 1000, 600, () => [R_AT({ ...SHAPES.fist })], each(g));
  run(g, t, 330, () => [R_AT({ ...SHAPES.point })], each(g));
  eq(hintsOf(g), 0, 'искра');
  g = createHandGestures(); run(g, 1000, 1500, () => orbPose(), each(g));
  eq(hintsOf(g), 0, 'сфера: ' + JSON.stringify(g.getDebug().hints));
  g = createHandGestures(); run(g, 1000, 1500, () => [R_AT({ ...SHAPES.ok })], each(g));
  eq(hintsOf(g), 0, '«OK»');
});

// ───────── приседания ─────────
// Прогон как в dev/squat.test.mjs: стойка 1 с, reps повторов, пауза; onFrame(c, k) — после каждого кадра.
function squats(c, view, reps, o = {}, onFrame) {
  const fps = 30, dt = 1000 / fps, downS = o.downS ?? 1.0, upS = o.upS ?? 0.8, holdS = 0.4, depth = o.depth ?? 1;
  let t = o.t0 ?? 1000;
  const frame = (k, phase) => { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: synthSquatPose(k, view, o) }); t += dt; if (onFrame) onFrame(c, k, phase); };
  for (let i = 0; i < fps; i++) frame(0, 'top');
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < fps * downS; i++) frame(depth * (0.5 - 0.5 * Math.cos(Math.PI * i / (fps * downS))), 'down');
    for (let i = 0; i < fps * upS; i++) frame(depth * (0.5 + 0.5 * Math.cos(Math.PI * i / (fps * upS))), 'up');
    for (let i = 0; i < fps * holdS; i++) frame(0, 'top');
  }
  return t;
}
const sqKeys = (ch) => Object.fromEntries(ch.items.map((i) => [i.key, i]));
const sqFmt = (ch) => ch.items.map((i) => `${i.key}:${i.ok}/${i.value}`).join(' ') + ` judged=${ch.judged}`;

test('приседания: форма read().checks — ключи, коды SQUAT_HINTS, точки позы 0..32', () => {
  const c = createSquatCounter();
  const ch = c.read().checks;
  eq(ch.items.map((i) => i.key).join(','), 'frame,depth,valgus,knees_forward,lean,heels,lockout', 'ключи');
  eq(ch.items.map((i) => i.hint).join(','), 'frame,shallow,valgus,knees_forward,lean,heels,lockout', 'коды');
  for (const i of ch.items) ok(i.landmarks.length && i.landmarks.every((k) => k >= 0 && k <= 32), i.key);
  eq(ch.judged, false, 'до повторов');
  eq(sqKeys(ch).frame.ok, false, 'позы нет');
});

test('приседания: чистый повтор спереди и сбоку → все оцениваемые условия ✓', () => {
  for (const view of ['front', 'side']) {
    const c = createSquatCounter();
    squats(c, view, 2);
    const r = c.read(), k = sqKeys(r.checks);
    eq(r.reps, 2, view + ' засчитано');
    ok(r.checks.items.every((i) => i.ok !== false), view + ': ' + sqFmt(r.checks));
    for (const key of ['frame', 'depth', 'lean', 'heels', 'lockout']) eq(k[key].ok, true, `${view}.${key}`);
    eq(k.valgus.ok, view === 'front' ? true : null, view + ': колени внутрь — только спереди');
    eq(k.knees_forward.ok, view === 'side' ? true : null, view + ': колени за носки — только сбоку');
    eq(r.checks.judged, true, 'только что был повтор');
  }
});

test('приседания: колени внутрь → valgus ✗ в нижней точке и держится до следующего повтора', () => {
  const c = createSquatCounter();
  let seenLive = false;
  const t = squats(c, 'front', 1, { valgus: 1 }, (cc, k, phase) => { if (phase === 'down' && k > 0.8 && sqKeys(cc.read().checks).valgus.ok === false) seenLive = true; });
  ok(seenLive, 'живое значение в нижней части');
  let ch = c.read().checks;
  const v = sqKeys(ch).valgus;
  ok(v.ok === false && v.value < 1 && v.hint === 'valgus', 'итог повтора: ' + sqFmt(ch));
  ok(['depth', 'lean', 'heels', 'lockout'].every((key) => sqKeys(ch)[key].ok === true), 'прочее ✓: ' + sqFmt(ch));
  // постояли наверху — ✗ держится
  let tt = t;
  for (let i = 0; i < 60; i++) { c.push({ tMs: tt, frameW: 640, frameH: 480, landmarks: synthSquatPose(0, 'front') }); tt += 33; }
  eq(sqKeys(c.read().checks).valgus.ok, false, 'держится наверху');
  // следующий чистый повтор — снова ✓
  squats(c, 'front', 1, { t0: tt + 33 });
  ch = c.read().checks;
  eq(sqKeys(ch).valgus.ok, true, 'после чистого повтора: ' + sqFmt(ch));
  eq(c.read().reps, 1, 'чистый засчитан');
});

test('приседания: корпус вперёд → lean ✗; пятки → heels ✗; колени за носки → knees_forward ✗; мелко → depth ✗', () => {
  const cases = [['side', { lean: 1 }, 'lean'], ['front', { lean: 1 }, 'lean'], ['side', { heels: 1 }, 'heels'], ['side', { kneesForward: 1 }, 'knees_forward'], ['front', { depth: 0.5 }, 'depth'], ['side', { depth: 0.5 }, 'depth']];
  for (const [view, o, key] of cases) {
    const c = createSquatCounter();
    squats(c, view, 1, o);
    const ch = c.read().checks;
    eq(sqKeys(ch)[key].ok, false, `${view} ${JSON.stringify(o)}: ${sqFmt(ch)}`);
    eq(c.read().reps, 0, 'не засчитан');
  }
});

test('приседания: во время спуска глубина растёт (ok:null — ещё не оценена), внизу ✓', () => {
  const c = createSquatCounter();
  const seen = [];
  squats(c, 'side', 1, {}, (cc, k, phase) => { if (phase === 'down') { const d = sqKeys(cc.read().checks).depth; seen.push(d); } });
  const mid = seen.filter((d) => d.ok === null && d.value > 0.2 && d.value < 1);
  ok(mid.length > 3, 'промежуточные значения: ' + seen.map((d) => `${d.ok}/${d.value}`).join(' '));
  ok(seen.some((d) => d.ok === true), 'глубина взята');
  const vals = mid.map((d) => d.value);
  ok(vals.every((v, i) => i === 0 || v >= vals[i - 1] - 1e-9), 'не убывает');
});

// ───────── отжимания ─────────
const P = (x, y, v = 0.95) => ({ x, y, z: 0, visibility: v });
// поза как в dev/pushup.test.mjs: k — глубина 0 (верх) … 1 (низ)
function pushPose(k, view, o = {}) {
  const L = new Array(33).fill(null);
  const T = (x, y) => ({ x, y });
  const put = (i, x, y, v) => { const p = T(x, y); L[i] = P(p.x, p.y, v); };
  const bend = k;
  if (view === 'front') {
    const sy = 0.45 + k * 0.27, wy = 0.85;
    put(0, 0.5, sy - 0.12); put(11, 0.625, sy); put(12, 0.375, sy);
    put(13, 0.64 + bend * 0.1, (sy + wy) / 2 + bend * 0.05); put(14, 0.36 - bend * 0.1, (sy + wy) / 2 + bend * 0.05);
    put(15, 0.65, wy); put(16, 0.35, wy);
    put(23, 0.6, sy + 0.05, 0.3); put(24, 0.4, sy + 0.05, 0.3);
  } else {
    const sy = 0.40 + k * 0.22, wy = 0.80;
    put(0, 0.36, sy - 0.02); put(11, 0.5, sy); put(12, 0.51, sy + 0.005, 0.6);
    put(13, 0.5 + bend * 0.13, (sy + wy) / 2 - bend * 0.03); put(14, 0.51 + bend * 0.13, (sy + wy) / 2 - bend * 0.03, 0.6);
    put(15, 0.5, wy); put(16, 0.51, wy, 0.6);
    const hipDy = o.hip === 'sag' ? 0.06 : o.hip === 'pike' ? -0.07 : 0;
    put(23, 0.78, sy + 0.04 + hipDy * Math.min(1, k * 3)); put(24, 0.79, sy + 0.04 + hipDy * Math.min(1, k * 3), 0.6);
    put(25, 0.93, sy + 0.064); put(26, 0.94, sy + 0.064, 0.6);
  }
  return L;
}
function pushups(c, view, reps, o = {}) {
  const fps = 30, dt = 1000 / fps, downS = o.downS ?? 0.7, upS = o.upS ?? 0.7, depth = o.depth ?? 1;
  let t = o.t0 ?? 1000;
  const frame = (k) => { c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: pushPose(k, view, o) }); t += dt; };
  for (let i = 0; i < fps; i++) frame(0);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < fps * downS; i++) frame(depth * (0.5 - 0.5 * Math.cos(Math.PI * i / (fps * downS))));
    for (let i = 0; i < fps * upS; i++) frame(depth * (0.5 + 0.5 * Math.cos(Math.PI * i / (fps * upS))));
    for (let i = 0; i < fps * 0.35; i++) frame(0);
  }
  return t;
}

test('отжимания: форма read().checks и lastHint', () => {
  const c = createPushupCounter();
  const r = c.read();
  eq(r.checks.items.map((i) => i.key).join(','), 'frame,depth,hands,line,tempo', 'ключи');
  eq(r.lastHint, null, 'подсказки ещё нет');
  for (const i of r.checks.items) ok(i.landmarks.every((k) => k >= 0 && k <= 32), i.key);
});

test('отжимания: провис таза сбоку → line ✗ (sag) и lastHint; задран → line ✗ (pike)', () => {
  for (const [hip, code, re] of [['sag', 'sag', /провисает/], ['pike', 'pike', /задран/]]) {
    const c = createPushupCounter();
    pushups(c, 'side', 1, { hip });
    const r = c.read(), k = sqKeys(r.checks);
    ok(k.line.ok === false && k.line.hint === code && k.line.value < 1, `${hip}: ${sqFmt(r.checks)}`);
    ok(k.depth.ok && k.hands.ok && k.tempo.ok, 'прочее ✓: ' + sqFmt(r.checks));
    ok(r.lastHint && r.lastHint.code === code && re.test(r.lastHint.text) && typeof r.lastHint.tMs === 'number', 'lastHint ' + JSON.stringify(r.lastHint));
    eq(r.reps, 0, 'не засчитан');
  }
});

test('отжимания: чистые повторы → всё ✓ (линия тела — только сбоку), lastHint нет', () => {
  for (const view of ['side', 'front']) {
    const c = createPushupCounter();
    pushups(c, view, 2);
    const r = c.read(), k = sqKeys(r.checks);
    eq(r.reps, 2, view);
    ok(r.checks.items.every((i) => i.ok !== false), view + ': ' + sqFmt(r.checks));
    eq(k.line.ok, view === 'side' ? true : null, view + ': линия тела');
    eq(r.lastHint, null, 'подсказки нет');
    eq(r.checks.judged, true, 'только что был повтор');
  }
});

test('отжимания: слишком быстро → tempo ✗ (fast); мелко → depth ✗ (shallow) и lastHint', () => {
  let c = createPushupCounter();
  pushups(c, 'front', 1, { downS: 0.15, upS: 0.15 });
  let r = c.read();
  ok(sqKeys(r.checks).tempo.ok === false && sqKeys(r.checks).tempo.hint === 'fast', sqFmt(r.checks));
  eq(r.lastHint && r.lastHint.code, 'fast', 'lastHint');
  c = createPushupCounter();
  pushups(c, 'front', 1, { depth: 0.3 });
  r = c.read();
  ok(sqKeys(r.checks).depth.ok === false, 'мелко: ' + sqFmt(r.checks) + ' ' + JSON.stringify(r.faults));
  eq(r.lastHint && r.lastHint.code, 'shallow', 'lastHint');
});

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
