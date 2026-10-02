// Тесты modules/techniqueTrainer.js: демо каждого жеста проходит путь «ошибка → исправление → Идеально!»
// через настоящий распознаватель; живой режим (checks из core/handGestures.js) и устойчивость к мусору.
// node dev/techniqueTrainer.test.mjs
import { createTechniqueTrainer, TRAINER_GESTURES, synthHand, gestureIcon } from '../modules/techniqueTrainer.js';
import { createHandGestures } from '../core/handGestures.js';
import { COACH_HINTS } from '../core/gestureCoach.js';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); } catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// Прогон демо: последовательность «что исправить» (без повторов) и момент первого «Идеально!».
function runDemo(id, seconds = 11, fps = 30) {
  const t = createTechniqueTrainer();
  t.select(id); t.setDemo(true);
  const focus = [];
  let idealAt = null, views = 0, last = null, maxCount = 0;
  for (let i = 0; i < seconds * fps; i++) {
    const now = 5000 + (i * 1000) / fps;
    const v = t.frame(now, null);
    views++;
    last = v;
    if (v.focus && focus[focus.length - 1] !== v.focus.code) focus.push(v.focus.code);
    if (v.ideal && idealAt === null) idealAt = (i / fps);
    maxCount = Math.max(maxCount, v.idealCount);
  }
  return { focus, idealAt, last, maxCount };
}

const EXPECT = {
  ok: ['ok_ring_open', 'ok_fingers'],
  shield: ['shield_palm', 'shield_push'],
  spark: ['spark_one'],
  burst: ['burst_short'],
  parry: ['parry_palm'],
  orb: ['orb_facing', 'orb_dy'],
  squat: ['valgus'],
  pushup: ['sag'],
};

for (const g of TRAINER_GESTURES) {
  test(`демо «${g.title}»: сначала ошибки ${EXPECT[g.id].join(' → ')}, потом «Идеально!» за ≤ 9 с`, () => {
    const r = runDemo(g.id);
    for (const code of EXPECT[g.id]) ok(r.focus.includes(code), `нет подсказки ${code}: ${r.focus.join(',')}`);
    const firstErr = r.focus.indexOf(EXPECT[g.id][0]);
    ok(firstErr >= 0, 'ошибка не показана');
    ok(r.idealAt !== null && r.idealAt <= 9, `«Идеально!» не наступило (${r.idealAt})`);
    ok(r.maxCount >= 1, 'счётчик «Идеально»');
  });
}

test('демо: строки чек-листа подписаны по-русски, у ошибки есть исправление и пиктограмма', () => {
  for (const g of TRAINER_GESTURES) {
    const t = createTechniqueTrainer(); t.select(g.id); t.setDemo(true);
    let v = null, focus = null;
    for (let i = 0; i < 200; i++) { v = t.frame(1000 + i * 33, null); if (v.focus && !focus) focus = v.focus; }
    ok(v.rows.length >= 3, `${g.id}: строк ${v.rows.length}`);
    for (const r of v.rows) ok(/[а-яё]/i.test(r.label) && r.label !== r.key, `${g.id}.${r.key}: подпись «${r.label}»`);
    ok(focus && focus.fix && focus.text, `${g.id}: исправление`);
    ok(focus.pictogram && focus.pictogram.startsWith('<svg'), `${g.id}: пиктограмма ${focus.code}`);
    ok(gestureIcon(g.id).startsWith('<svg'), `${g.id}: иконка жеста`);
    ok(v.synthHands || v.synthPose, `${g.id}: синтетика для превью`);
  }
});

test('демо: отметки на превью — красная с меткой у того, что исправить', () => {
  const t = createTechniqueTrainer(); t.setDemo(true);
  let v = null;
  for (let i = 0; i < 40; i++) v = t.frame(1000 + i * 33, null);
  eq(v.focus && v.focus.code, 'ok_ring_open', 'ошибка кольца');
  const ring = v.marks.find((m) => m.points.includes(4) && m.points.includes(8));
  ok(ring && !ring.ok && ring.label === 'СОМКНИ' && ring.hand === 'right', 'метка «СОМКНИ» на кончиках 4 и 8: ' + JSON.stringify(ring));
  ok(ring.links.some(([a, b]) => a === 4 && b === 8), 'линия «сомкни» между 4 и 8');
  ok(v.synthHands.right.landmarks.length === 21, 'синтетическая кисть');
});

// Живой режим: checks настоящего распознавателя на синтетической кисти
function liveRun(handOpts, frames = 30) {
  const g = createHandGestures();
  const tr = createTechniqueTrainer();
  let v = null, hint = null;
  for (let i = 0; i < frames; i++) {
    const t = 1000 + i * 33;
    const h = synthHand(handOpts);
    g.push({ tMs: t, frameW: 640, frameH: 480, mirror: true, hands: [h], poseWrists: null, bodyCenter: null, shoulderWidth: 0.35 });
    const f = g.read(t);
    if (f.hint) hint = f.hint.code;
    v = tr.frame(t, { checks: g.getDebug().checks, hands: g.peek(t), pose: null });
  }
  return { v, hint };
}

test('камера: правильный «OK» — всё зелёное, «Идеально!», подсказок нет', () => {
  const { v, hint } = liveRun({ side: 'right', cx: 0.4, cy: 0.55, curls: [0.45, 0, 0, 0], thumb: 'pinch' });
  ok(v.present && v.recognized && v.ideal && !v.focus, JSON.stringify(v.rows.map((r) => [r.key, r.ok])));
  ok(v.rows.every((r) => r.ok === true), 'все условия');
  eq(hint, null, 'подсказка');
  eq(v.source, 'camera');
});

test('камера: кольцо разомкнуто — красное «Кольцо сомкнуто», исправление «Сомкни кольцо»', () => {
  const { v } = liveRun({ side: 'right', cx: 0.4, cy: 0.55, curls: [0.45, 0, 0, 0], thumb: 'out' });
  const ring = v.rows.find((r) => r.key === 'ring');
  ok(ring && ring.ok === false && ring.value < 1, 'ring');
  ok(!v.ideal && v.focus && v.focus.code === 'ok_ring_open' && v.focus.fix === COACH_HINTS.ok_ring_open.fix, JSON.stringify(v.focus));
});

test('камера: нет кисти — подсказка показать руку, без «Идеально»', () => {
  const tr = createTechniqueTrainer();
  const g = createHandGestures();
  g.push({ tMs: 1000, frameW: 640, frameH: 480, mirror: true, hands: [], poseWrists: null });
  const v = tr.frame(1000, { checks: g.getDebug().checks, hands: null, pose: null });
  ok(!v.present && !v.ideal, 'present/ideal');
  ok(/правую руку/.test(v.message) || (v.focus && v.focus.code === 'hands_missing'), v.message + ' ' + JSON.stringify(v.focus));
});

test('мусорный ввод не бросает; смена жеста и демо сбрасывают прогресс', () => {
  const tr = createTechniqueTrainer();
  for (const live of [null, undefined, {}, { checks: 5 }, { checks: { ok: { items: 'x' } } }, { checks: { ok: { items: [null, 3, { key: 'ring', value: NaN }] } } }, { pose: { landmarks: 'x' } }]) {
    tr.frame(1000, live); tr.frame(NaN, live);
  }
  tr.select('нет такого'); eq(tr.gesture, 'ok');
  tr.select('squat'); eq(tr.gesture, 'squat');
  tr.frame(2000, { pose: { tMs: 1, landmarks: new Array(33).fill(null) } });
  tr.setDemo(true); ok(tr.demo); tr.setDemo(false); ok(!tr.demo);
  const v = tr.frame(3000, null);
  eq(v.idealCount, 0, 'сброс счётчика');
});

for (const line of out) console.log(line);
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
