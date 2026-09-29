// [HAND] Тесты core/handZone.js: связка лука/магии с InputFrame, гашение конфликтов (C2), DEBUG-клавиши
// B/N/M, двуручный бросок, интеграция с modules/combat.js (стрела и сгусток бьют Регента). node dev/handZone.test.mjs

import { createHandZone, createHeroBowPose } from '../core/handZone.js';
import { createCombat } from '../modules/combat.js';
import { emptyInput } from '../core/debugInput.js';
import { makeScene, handAt, obsOf, lerp, SHAPES } from './handSynth.mjs';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

// поддельная цель клавиатуры (capture-слушатели, как у window)
function fakeTarget() {
  const L = { keydown: [], keyup: [], blur: [] };
  return {
    addEventListener(type, fn) { (L[type] || (L[type] = [])).push(fn); },
    removeEventListener(type, fn) { L[type] = (L[type] || []).filter((f) => f !== fn); },
    key(type, code, o = {}) { const e = { code, shiftKey: !!o.shift, repeat: false, target: null, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; for (const f of L[type]) f(e); return e; },
  };
}
// «время» для performance.now() в DEBUG-клавишах
let fakeNow = 1000;
const realNow = performance.now.bind(performance);
performance.now = () => fakeNow;

const cvInput = (o = {}) => ({ ...emptyInput('cv'), source: 'cv', valid: true, calibrated: true, ...o });
const dbgInput = (o = {}) => ({ ...emptyInput('debug'), source: 'debug', valid: true, calibrated: true, ...o });

test('DEBUG: B — стойка (Shift+B не перехватывается), N — натяжение, отпускание — один выстрел', () => {
  const T = fakeTarget();
  const z = createHandZone({ target: T });
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  const eB = T.key('keydown', 'KeyB');
  ok(eB.stopped && eB.prevented, 'B не перехвачена у debugInput');
  const eSB = T.key('keydown', 'KeyB', { shift: true });
  ok(!eSB.stopped, 'Shift+B (печать «Кор») перехвачена');
  T.key('keyup', 'KeyB');
  let inp = z.apply(dbgInput({ moveX: 1, moveZ: 1 }), fakeNow, { debug: true, playing: true });
  ok(inp.bow.phase === 'ready' && !inp.bow.active, `стойка: ${JSON.stringify(inp.bow)}`);
  ok(inp.moveZ === 1, 'в стойке без стрелы герой ходит');
  T.key('keydown', 'KeyN');
  fakeNow += 400;
  inp = z.apply(dbgInput({ moveX: 1, moveZ: 1, parry: true, attack: true }), fakeNow, { debug: true, playing: true });
  ok(inp.bow.active && inp.bow.draw > 0.4 && inp.bow.draw < 0.8, `натяжение ${inp.bow.draw}`);
  ok(inp.moveX === 0 && inp.moveZ === 0 && !inp.parry && !inp.attack, 'C2: левая рука не рулит, парирование и огонь молчат');
  fakeNow += 800;
  inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  ok(inp.bow.draw === 1 && inp.bow.charged, 'полное натяжение и заряд');
  T.key('keyup', 'KeyN');
  inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  ok(inp.bow.release && inp.bow.draw === 1 && inp.bow.charged, `выстрел ${JSON.stringify(inp.bow)}`);
  inp = z.apply(dbgInput(), fakeNow + 16, { debug: true, playing: true });
  ok(!inp.bow.release, 'выстрел — один кадр');
});
test('DEBUG: цифра-руна в стойке → стихия стрелы (руна не кастуется); W + полное натяжение → дождь', () => {
  const T = fakeTarget();
  const z = createHandZone({ target: T });
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  T.key('keydown', 'KeyB'); T.key('keyup', 'KeyB');
  let inp = z.apply(dbgInput({ rune: 'ignis', runeScore: 1 }), fakeNow, { debug: true, playing: true });
  ok(inp.rune === null && inp.bow.element === 'fire' && inp.bow.rune === 'ignis', `руна: ${inp.rune}, ${JSON.stringify(inp.bow)}`);
  T.key('keydown', 'KeyW'); T.key('keydown', 'KeyN');
  fakeNow += 1200;
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  T.key('keyup', 'KeyN');
  inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  ok(inp.bow.release && inp.bow.rain && inp.bow.element === 'fire', `дождь: ${JSON.stringify(inp.bow)}`);
  T.key('keyup', 'KeyW');
});
test('DEBUG: M — сгусток (form → hold, power растёт), отпускание — бросок; Shift+M — следующая стихия', () => {
  const T = fakeTarget();
  const z = createHandZone({ target: T });
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  T.key('keydown', 'KeyM', { shift: true });
  T.key('keydown', 'KeyM');
  let inp = z.apply(dbgInput({ attack: true, spark: true }), fakeNow, { debug: true, playing: true });
  ok(inp.handSpell.phase === 'form' && inp.handSpell.formed && inp.handSpell.element === 'storm', `form ${JSON.stringify(inp.handSpell)}`);
  ok(!inp.attack && !inp.spark, 'жесты правой молчат');
  fakeNow += 1000;
  inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  ok(inp.handSpell.phase === 'hold' && inp.handSpell.power > 0.5, `hold ${JSON.stringify(inp.handSpell)}`);
  T.key('keyup', 'KeyM');
  inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  ok(inp.handSpell.phase === 'throw' && inp.handSpell.power > 0.5, `throw ${inp.handSpell.phase}`);
  inp = z.apply(dbgInput(), fakeNow + 20, { debug: true, playing: true });
  ok(inp.handSpell.phase === 'idle', 'после броска — idle');
});
test('DEBUG: сгусток + сфера (O) → бросок сферы становится усиленным броском стихии', () => {
  const T = fakeTarget();
  const z = createHandZone({ target: T });
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  T.key('keydown', 'KeyM');
  z.apply(dbgInput(), fakeNow, { debug: true, playing: true });
  fakeNow += 600;
  let inp = z.apply(dbgInput({ conjure: { kind: 'orb', size: 0.6, charge: 0.5, heldMs: 400 } }), fakeNow, { debug: true, playing: true });
  ok(inp.handSpell.twoHand, 'twoHand');
  inp = z.apply(dbgInput({ throw: { kind: 'orb', size: 0.7, power: 0.9, aimX: 0.2, how: 'push' } }), fakeNow + 16, { debug: true, playing: true });
  ok(inp.throw === null && inp.handSpell.phase === 'throw' && inp.handSpell.twoHand && inp.handSpell.power >= 0.9, `twoHand throw ${JSON.stringify(inp.handSpell)}`);
  T.key('keyup', 'KeyM');
});
test('выключено (settings.handCombat = false): поля null, ввод не трогается', () => {
  const z = createHandZone({ target: fakeTarget() });
  const inp = z.apply(cvInput({ moveX: 0.5, parry: true }), fakeNow, { debug: false, playing: true, enabled: false });
  ok(inp.bow === null && inp.handSpell === null && inp.moveX === 0.5 && inp.parry, 'ввод изменён');
});

// ───────── камера: синтетические кадры → pushObs → apply ─────────
function cvShot(z, o = {}) {
  const S = makeScene();
  const frames = [];
  let t = 2000;
  const L = () => handAt(S, 'left', -0.42, 0.3, 'fist', { size: 0.1 });
  const R = (x, y, sh, size) => handAt(S, 'right', x, y, sh, { size });
  const add = (right, extra = {}) => { t += 33; frames.push({ t, obs: obsOf(S, t, { left: L(), right }), extra }); };
  for (let i = 0; i < 8; i++) add(R(0.7, 1.5, 'open', 0.075));
  for (let i = 0; i < 10; i++) add(R(-0.27, 0.3, SHAPES.pinch, 0.1), { attack: true });
  for (let i = 1; i <= 15; i++) { const k = i / 15; add(R(lerp(-0.27, 0.28, k), lerp(0.3, -0.45, k), SHAPES.pinch, lerp(0.1, 0.075, k)), { moveZ: 0.8, dashDir: i === 7 ? { x: 1, z: 0 } : null }); }
  for (let i = 0; i < 14; i++) add(R(0.28, -0.45, SHAPES.pinch, 0.075));
  for (let i = 0; i < 4; i++) add(R(0.32, -0.47, SHAPES.pinchOpen, 0.075), { burst: true, burstPower: 0.6, spark: i === 1 });
  // левый кулак раскрыт ладонью к камере сразу после стойки — это не парирование
  for (let i = 0; i < 20; i++) { t += 33; frames.push({ t, obs: obsOf(S, t, { left: handAt(S, 'left', -0.42, 0.3, 'open', { size: 0.1 }), right: R(0.5, 1.5, 'open', 0.075) }), extra: i < 6 ? { parry: true } : {} }); }
  const res = { releases: [], leaked: [], activeMove: 0 };
  for (const f of frames) {
    z.pushObs({ ...f.obs, pose: S.pose() });
    const inp = z.apply(cvInput({ moveZ: f.extra.moveZ || 0, attack: !!f.extra.attack, parry: !!f.extra.parry, burst: !!f.extra.burst, spark: !!f.extra.spark, dashDir: f.extra.dashDir || null }), f.t + 5, { debug: false, playing: true });
    if (inp.bow.release) res.releases.push(inp.bow);
    if (inp.bow.active && (inp.moveZ || inp.dashDir)) res.activeMove++;
    for (const k of ['parry', 'burst', 'spark']) if (inp[k]) res.leaked.push(`${k}@${f.t}`);
    if (inp.attack && inp.bow.active) res.leaked.push(`attack@${f.t}`);
  }
  return res;
}
test('камера: полный выстрел — один release; пока лук активен — ни движения, ни рывка; выброс/искра/парирование не просачиваются', () => {
  const z = createHandZone({ target: fakeTarget() });
  const r = cvShot(z);
  ok(r.releases.length === 1 && r.releases[0].draw >= 0.85 && r.releases[0].charged, `выстрелы ${JSON.stringify(r.releases)}`);
  ok(r.activeMove === 0, `движение при активном луке: ${r.activeMove}`);
  ok(r.leaked.length === 0, `просочились: ${r.leaked.join(', ')}`);
});

// ───────── интеграция с боем ─────────
test('бой: DEBUG-выстрел и DEBUG-сгусток бьют Регента (events arrow_hit, hand_spell_hit)', () => {
  const T = fakeTarget();
  const z = createHandZone({ target: T });
  const c = createCombat({ config: {}, bossBrain: { reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } } });
  const ev = [];
  const frame = (ms = 16) => { fakeNow += ms; const inp = z.apply(dbgInput(), fakeNow, { debug: true, playing: true }); c.update(ms / 1000, inp); ev.push(...c.drainEvents()); };
  frame();
  T.key('keydown', 'KeyB'); T.key('keyup', 'KeyB');
  T.key('keydown', 'KeyN');
  for (let i = 0; i < 80; i++) frame();
  T.key('keyup', 'KeyN');
  for (let i = 0; i < 90; i++) frame();
  ok(ev.some((e) => e.type === 'bow_draw_start') && ev.some((e) => e.type === 'bow_release') && ev.some((e) => e.type === 'arrow_hit'), `события лука: ${[...new Set(ev.map((e) => e.type))].join(',')}`);
  T.key('keydown', 'KeyB'); T.key('keyup', 'KeyB');
  for (let i = 0; i < 40; i++) frame();
  T.key('keydown', 'KeyM');
  for (let i = 0; i < 70; i++) frame();
  T.key('keyup', 'KeyM');
  for (let i = 0; i < 100; i++) frame();
  ok(ev.some((e) => e.type === 'hand_spell_form') && ev.some((e) => e.type === 'hand_spell_throw') && ev.some((e) => e.type === 'hand_spell_hit'), `события сгустка: ${[...new Set(ev.map((e) => e.type))].join(',')}`);
});
test('поза героя: setPose у heroModel вызывается; процедурные суставы доворачиваются', () => {
  const calls = [];
  const hm = { setPose: (p) => calls.push(p) };
  const mk = () => ({ rotation: { x: 0, y: 0, z: 0 } });
  const J = { shL: mk(), elL: mk(), shR: mk(), elR: mk(), wrL: mk(), wrR: mk() };
  const root = { getObjectByName: (n) => J[n] };
  const pose = createHeroBowPose();
  const snap = { player: { action: 'cast', bow: { active: true, phase: 'drawing', draw: 1, aimX: 0, aimY: 0, charged: true }, handSpell: { phase: 'idle' } } };
  for (let i = 0; i < 30; i++) pose.update(1 / 60, { root, heroModel: hm, snap });
  ok(calls.length === 30 && calls[29].bowDraw > 0.8, `setPose ${JSON.stringify(calls[29])}`);
  ok(J.shL.rotation.x < -1.2 && J.elR.rotation.x < -1.5, `суставы ${JSON.stringify(J.shL.rotation)} ${JSON.stringify(J.elR.rotation)}`);
});

performance.now = realNow;
for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
