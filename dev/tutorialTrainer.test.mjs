// Тесты тренажёра «Научись за 60 секунд» (core/tutorialTrainer.js). node dev/tutorialTrainer.test.mjs
// 1) логика шагов на синтетических InputFrame; 2) настоящий распознаватель кистей (core/handGestures.js)
// на синтетических кистях dev/handSynth.mjs; 3) настоящий адаптер «Отладки с клавиатуры» (W, K, J, L, H).
import { createTutorialTrainer, stepSignal, TRAINER_STEPS, TRAINER_FRAME_HINTS } from '../core/tutorialTrainer.js';
import { COACH_HINTS } from '../core/gestureCoach.js';
import { createHandGestures } from '../core/handGestures.js';
import { createDebugInput } from '../core/debugInput.js';
import { makeHand, SHAPES } from './handSynth.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
const I = (o = {}) => ({ source: 'cv', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, stick: null, attack: false, shield: false, burst: false, charge: 0, hint: null, ...o });

// прогон: fn(t) → InputFrame, шаг dt мс; возвращает последнее время
function feed(tr, t0, ms, fn, dt = 33, opts) {
  let t = t0, v = null;
  for (; t < t0 + ms; t += dt) v = tr.update(fn(t), t, opts);
  return { t, v };
}

test('шаги: ровно 4 базовых жеста, у каждого клавиша отладки и подсказки из core/gestureCoach.js', () => {
  assert(TRAINER_STEPS.length === 4, 'шагов ' + TRAINER_STEPS.length);
  assert(TRAINER_STEPS.map((s) => s.id).join(',') === 'walk,shield,shot,burst', 'порядок');
  assert(TRAINER_STEPS.map((s) => s.key).join('') === 'WKJL', 'клавиши W K J L');
  for (const s of TRAINER_STEPS) {
    assert(s.title && s.effect && s.tip && s.hand, 'тексты ' + s.id);
    for (const h of s.hints) assert(COACH_HINTS[h], `подсказка ${h} есть в gestureCoach`);
  }
  for (const h of TRAINER_FRAME_HINTS) assert(COACH_HINTS[h], 'кадр ' + h);
});

test('старт: шаг 1 из 4, фаза try, ничего не распознано', () => {
  const tr = createTutorialTrainer();
  const v = tr.update(I(), 1000);
  assert(v.index === 0 && v.number === 1 && v.total === 4 && v.phase === 'try' && !v.done, JSON.stringify(v));
  assert(v.progress === 0 && v.recognized === 0 && v.skipped === 0, 'пусто');
});

test('ход: удержание ≥ 0,7 с → «Распознано», через 0,8 с — шаг 2', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 1000);
  let r = feed(tr, 1000, 400, () => I({ moveZ: 0.8 }));
  assert(r.v.phase === 'try' && r.v.progress > 0.4 && r.v.progress < 1, 'ещё рано: ' + r.v.progress);
  assert(r.v.live, 'жест виден');
  let t = r.t;
  for (; tr.view().phase === 'try' && t < r.t + 600; t += 33) tr.update(I({ moveZ: 0.8 }), t);
  let v = tr.view();
  assert(v.phase === 'ok' && v.results[0] === 'ok' && v.progress === 1, 'распознано: ' + v.phase);
  const okT = t - 33, okSeq = v.seq;
  v = tr.update(I(), okT + 750);
  assert(v.phase === 'ok' && v.index === 0 && v.okLeftMs > 0 && v.okLeftMs <= 50, 'пауза «✓ Распознано!» держится 0,8 с: ' + v.okLeftMs);
  v = tr.update(I(), okT + 810);
  assert(v.phase === 'try' && v.index === 1 && v.number === 2 && v.seq > okSeq, 'переход на шаг 2: ' + JSON.stringify({ i: v.index, p: v.phase }));
});

test('ход: «Руль» засчитывает поднятую ладонь (stick.engaged, gait walk) даже при малом moveZ', () => {
  const st = { mode: 'steer', engaged: true, gait: 'walk', fwd: 0.1 };
  assert(stepSignal(TRAINER_STEPS[0], I({ moveZ: 0.1, stick: st })).active, 'руль');
  assert(!stepSignal(TRAINER_STEPS[0], I({ moveZ: 0.1, stick: { ...st, engaged: false, gait: 'idle' } })).active, 'опущенная рука — нет');
  assert(stepSignal(TRAINER_STEPS[0], I({ moveX: -0.6 }), { moveMode: 'stick' }).active, 'джойстик: вбок тоже ведёт');
  assert(!stepSignal(TRAINER_STEPS[0], I({ moveZ: 1, valid: false })).active, 'невалидный кадр не считается');
});

test('удержание прощает короткие провалы трекинга, но не копится без жеста', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 1000);
  let r = feed(tr, 1000, 450, () => I({ moveZ: 1 }));
  r = feed(tr, r.t, 66, () => I());                         // 2 кадра провала
  const mid = r.v.progress;
  assert(mid > 0.3, 'провал не обнулил: ' + mid);
  r = feed(tr, r.t, 450, () => I({ moveZ: 1 }));
  assert(r.v.phase === 'ok', 'досчитал после провала');
  const tr2 = createTutorialTrainer();
  tr2.update(I(), 1000);
  const r2 = feed(tr2, 1000, 3000, () => I());
  assert(r2.v.progress === 0 && r2.v.phase === 'try', 'без жеста — 0');
  assert(r2.v.stepMs >= 2900, 'время на шаге');
});

test('щит и «OK»: удержания; выброс — импульс, шкала показывает заряд кулака', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  let r = feed(tr, 0, 800, () => I({ moveZ: 1 }));
  r = feed(tr, r.t, 900, () => I());
  assert(r.v.index === 1, 'шаг щита');
  r = feed(tr, r.t, 200, () => I({ attack: true }));
  assert(r.v.progress === 0, '«OK» не засчитывается за щит');
  r = feed(tr, r.t, 400, () => I({ shield: true }));
  assert(r.v.phase === 'ok' && r.v.results[1] === 'ok', 'щит');
  r = feed(tr, r.t, 900, () => I());
  assert(r.v.index === 2, 'шаг «OK»');
  r = feed(tr, r.t, 450, () => I({ attack: true }));
  assert(r.v.phase === 'ok' && r.v.results[2] === 'ok', '«OK»');
  r = feed(tr, r.t, 900, () => I());
  assert(r.v.index === 3, 'шаг выброса');
  r = feed(tr, r.t, 300, (t) => I({ charge: 0.6 }));
  assert(r.v.phase === 'try' && Math.abs(r.v.progress - 0.6) < 1e-9 && r.v.live, 'заряд на шкале: ' + r.v.progress);
  r.v = tr.update(I({ burst: true }), r.t);
  assert(r.v.phase === 'ok' && r.v.results[3] === 'ok', 'выброс');
  r = feed(tr, r.t + 33, 900, () => I());
  assert(r.v.done && r.v.phase === 'done' && r.v.recognized === 4 && r.v.skipped === 0 && r.v.step === null, 'финал: ' + JSON.stringify(r.v.results));
});

test('«Пропустить»: шаг помечен skip, сразу следующий; в фазе «Распознано» пропуск не действует', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  assert(tr.skip(10) === true, 'пропуск');
  let v = tr.update(I(), 20);
  assert(v.index === 1 && v.results[0] === 'skip' && v.phase === 'try', 'шаг 2');
  feed(tr, 20, 400, () => I({ shield: true }));
  assert(tr.view().phase === 'ok', 'щит распознан');
  assert(tr.skip(500) === false, 'во время «✓» пропуск игнорируется');
  tr.skip(2000); // ещё фаза ok — игнор
  v = tr.update(I(), 1400);
  assert(v.index === 2, 'автопереход');
  tr.skip(1500); tr.skip(1600);
  v = tr.update(I(), 1700);
  assert(v.done && v.recognized === 1 && v.skipped === 3, 'итог: ' + JSON.stringify(v.results));
  assert(tr.skip(1800) === false, 'после финала пропускать нечего');
  tr.restart(1900);
  v = tr.update(I(), 1950);
  assert(v.index === 0 && v.phase === 'try' && v.results.every((x) => x === null), 'перезапуск');
});

test('«Пропустить обучение»: остальные шаги — skip, распознанные остаются ok, сразу итог', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  feed(tr, 0, 800, () => I({ moveZ: 1 }));
  assert(tr.view().phase === 'ok', 'шаг 1 распознан');
  assert(tr.skipAll(900) === true, 'пропуск всего');
  const v = tr.update(I(), 950);
  assert(v.done && v.results.join(',') === 'ok,skip,skip,skip' && v.recognized === 1 && v.skipped === 3, JSON.stringify(v.results));
  assert(tr.skipAll(1000) === false, 'на итоге — нечего');
});

test('подсказки «ОШИБКА»: только своего шага и про кадр; гаснут через 4,5 с и при успехе', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  let v = tr.update(I({ hint: { code: 'rune_open', side: 'right' } }), 33);
  assert(v.hint === null, 'подсказка про руны на шаге хода не показывается');
  v = tr.update(I({ hint: { code: 'steer_low', side: 'left' } }), 66);
  assert(v.hint && v.hint.code === 'steer_low' && v.hint.text === COACH_HINTS.steer_low.text && v.hint.side === 'left', 'своя подсказка');
  v = tr.update(I(), 66 + 4400);
  assert(v.hint, 'ещё видна');
  v = tr.update(I(), 66 + 4600);
  assert(!v.hint, 'погасла');
  v = tr.update(I({ hint: { code: 'hands_missing' } }), 5000);
  assert(v.hint && v.hint.code === 'hands_missing', 'общая про кадр');
  feed(tr, 5000, 800, () => I({ moveZ: 1 }));
  assert(tr.view().phase === 'ok' && !tr.view().hint, 'успех гасит подсказку');
});

test('застрял: через 15 с без успеха stuck=true (предложить «Пропустить»)', () => {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  assert(!tr.update(I(), 14000).stuck, 'рано');
  assert(tr.update(I(), 15100).stuck, 'застрял');
});

test('шаг времени ограничен: после ухода вкладки удержание не «докапывается»', () => {
  const tr = createTutorialTrainer();
  tr.update(I({ moveZ: 1 }), 0);
  const v = tr.update(I({ moveZ: 1 }), 60000);
  assert(v.phase === 'try' && v.progress < 0.4, 'один кадр после паузы ≠ 0,7 с удержания: ' + v.progress);
});

test('мусор на входе не ломает тренажёр', () => {
  const tr = createTutorialTrainer();
  for (const x of [null, undefined, 5, 'x', {}, { valid: true, moveZ: NaN, charge: Infinity, hint: 'oops' }, { valid: true, hint: { code: 42 } }]) tr.update(x, 100);
  const v = tr.update(I(), 200);
  assert(v.index === 0 && v.phase === 'try' && Number.isFinite(v.progress), JSON.stringify(v));
});

// ---------------------------------------------------------------- настоящий распознаватель кистей
function obsOf(t, hands) {
  return { tMs: t, frameW: 640, frameH: 480, mirror: true, hands, poseWrists: null, bodyCenter: null, shoulderWidth: 0.35 };
}
// кадр распознавателя → InputFrame, как его собирает modules/vision.js (поля, которые читает тренажёр)
function frameOf(f) {
  return { source: 'cv', valid: true, attack: !!f.attack, shield: !!f.shield, burst: !!f.burst, charge: f.charge || 0, moveX: f.moveX || 0, moveZ: f.moveZ || 0, stick: f.stick || null, hint: f.hint || null };
}
function runCv(g, tr, t0, ms, hands, dt = 33) {
  let t = t0, v = null;
  for (; t < t0 + ms; t += dt) { g.push(obsOf(t, hands(t))); v = tr.update(frameOf(g.read(t)), t); }
  return { t, v };
}
const R = (o) => makeHand({ side: 'right', cx: 0.35, ...o });
const L = (o) => makeHand({ side: 'left', cx: 0.65, ...o });
function trainerAt(stepIndex) {
  const tr = createTutorialTrainer();
  tr.update(I(), 0);
  for (let i = 0; i < stepIndex; i++) tr.skip(1);
  return tr;
}

test('камера: правая «OK» (кольцо + три пальца вверх) проходит шаг 3', () => {
  const g = createHandGestures();
  const tr = trainerAt(2);
  const r = runCv(g, tr, 1000, 1200, () => [R(SHAPES.ok)]);
  assert(tr.view().results[2] === 'ok', '«OK» не распознан: ' + JSON.stringify(r.v));
});

test('камера: кольцо не сомкнуто → подсказка ok_ring_open под пиктограммой шага 3', () => {
  const g = createHandGestures();
  const tr = trainerAt(2);
  let seen = null;
  let t = 1000;
  for (; t < 3000 && !seen; t += 33) { g.push(obsOf(t, [R({ curls: [0.55, 0, 0, 0], thumb: 'in' })])); const v = tr.update(frameOf(g.read(t)), t); if (v.hint) seen = v.hint; }
  assert(seen && seen.code === 'ok_ring_open' && seen.text === COACH_HINTS.ok_ring_open.text, 'подсказка: ' + JSON.stringify(seen));
  assert(tr.view().phase === 'try', 'шаг не засчитан');
});

test('камера: правый кулак 1,3 с → раскрыть = выброс (шаг 4), шкала растёт с зарядом', () => {
  const g = createHandGestures();
  const tr = trainerAt(3);
  let r = runCv(g, tr, 1000, 500, () => [R(SHAPES.open)]);
  r = runCv(g, tr, r.t, 1300, () => [R(SHAPES.fist)]);
  assert(r.v.phase === 'try' && r.v.progress > 0.8, 'заряд на шкале: ' + r.v.progress);
  r = runCv(g, tr, r.t, 400, () => [R(SHAPES.open)]);
  assert(tr.view().results[3] === 'ok', 'выброс не распознан: ' + JSON.stringify(r.v));
});

test('камера: короткий кулак → подсказка burst_short, шаг 4 не засчитан', () => {
  const g = createHandGestures();
  const tr = trainerAt(3);
  let r = runCv(g, tr, 1000, 500, () => [R(SHAPES.open)]);
  r = runCv(g, tr, r.t, 280, () => [R(SHAPES.fist)]);
  let seen = null;
  for (let t = r.t; t < r.t + 500 && !seen; t += 33) { g.push(obsOf(t, [R(SHAPES.open)])); const v = tr.update(frameOf(g.read(t)), t); if (v.hint) seen = v.hint; }
  assert(seen && seen.code === 'burst_short', 'подсказка: ' + JSON.stringify(seen));
  assert(tr.view().results[3] === null, 'не засчитан');
});

test('камера: толчок левой ладонью к камере → щит (шаг 2); ладонь просто стоит → подсказка shield_push', () => {
  const g = createHandGestures();
  const tr = trainerAt(1);
  let r = runCv(g, tr, 1000, 500, () => [L({ ...SHAPES.open, size: 0.12 })]);
  const t1 = r.t;
  r = runCv(g, tr, t1, 200, (tt) => [L({ ...SHAPES.open, size: 0.12 + 0.04 * Math.min(1, (tt - t1) / 180) })]);
  r = runCv(g, tr, r.t, 600, () => [L({ ...SHAPES.open, size: 0.16 })]);
  assert(tr.view().results[1] === 'ok', 'щит не распознан: ' + JSON.stringify(r.v));
  const g2 = createHandGestures();
  const tr2 = trainerAt(1);
  let seen = null;
  for (let t = 1000; t < 3800 && !seen; t += 33) { g2.push(obsOf(t, [L({ ...SHAPES.open })])); const v = tr2.update(frameOf(g2.read(t)), t); if (v.hint) seen = v.hint; }
  assert(seen && seen.code === 'shield_push', 'подсказка: ' + JSON.stringify(seen));
});

// ---------------------------------------------------------------- «Отладка с клавиатуры»
function fakeKeys() {
  const ls = {};
  return {
    target: { addEventListener: (ty, fn) => { (ls[ty] || (ls[ty] = [])).push(fn); }, removeEventListener() {} },
    down: (code) => (ls.keydown || []).forEach((fn) => fn({ code, repeat: false, target: null, preventDefault() {} })),
    up: (code) => (ls.keyup || []).forEach((fn) => fn({ code, target: null })),
  };
}

test('отладка: W, K, J, L проходят 4 шага; H показывает пример подсказки текущего шага', () => {
  const k = fakeKeys();
  const dbg = createDebugInput(k.target);
  dbg.setEnabled(true);
  const tr = createTutorialTrainer();
  let t = 0;
  const tick = (ms) => { let v; for (const end = t + ms; t < end; t += 33) v = tr.update(dbg.read(), t); return v; };
  tick(100);
  k.down('KeyH'); let v = tick(40); k.up('KeyH');
  assert(v.hint && TRAINER_STEPS[0].hints.includes(v.hint.code), 'H на шаге хода: ' + JSON.stringify(v.hint));
  for (const [i, key] of [['0', 'KeyW'], ['1', 'KeyK'], ['2', 'KeyJ']]) {
    k.down(key); v = tick(800); k.up(key);
    assert(v.results[+i] === 'ok', `клавиша ${key}: ${JSON.stringify(v.results)}`);
    v = tick(900);
    assert(v.index === +i + 1, 'переход после ' + key);
  }
  k.down('KeyH'); v = tick(40); k.up('KeyH');
  assert(v.hint && TRAINER_STEPS[3].hints.includes(v.hint.code), 'H на шаге выброса: ' + JSON.stringify(v.hint));
  k.down('KeyL'); v = tick(40); k.up('KeyL');
  assert(v.results[3] === 'ok', 'L — выброс');
  v = tick(900);
  assert(v.done && v.recognized === 4, 'финал');
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed`);
if (pass !== tests.length) process.exitCode = 1;
