// Тесты «отклика» в боевом HUD (core/battleHud.js) на фальшивом 2D-контексте: какие надписи рисуются
// на события боя. frame() глотает исключения, поэтому проверяем по нарисованному тексту: упало — текста нет.
// node dev/battleHudFeel.test.mjs
import { createBattleHud } from '../core/battleHud.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

function fakeCanvas() {
  const texts = [];
  const state = { font: '10px sans-serif', shadowBlur: 0, globalAlpha: 1, lineDash: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'fillText' || k === 'strokeText') return (s) => { texts.push(String(s)); };
      if (k === 'measureText') return (s) => { const m = /(\d+(?:\.\d+)?)px/.exec(t.font); const px = m ? +m[1] : 10; return { width: String(s).length * px * 0.55 }; };
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => grad;
      if (k === 'setLineDash') return (a) => { t.lineDash = a; };
      if (k === 'getLineDash') return () => t.lineDash;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { canvas: { width: 0, height: 0, clientWidth: 1366, clientHeight: 768, getContext: () => ctx }, texts, state };
}

// Простая проекция: камера за героем на (0, 3, 11) смотрит на Регента в (0, 2, 0).
function project(p) {
  const cz = 11 - p.z, cy = p.y - 3;
  if (cz < 0.1) return { x: 0, y: 0, behind: true };
  const f = 1 / Math.tan((58 * Math.PI / 180) / 2);
  return { x: 683 + (p.x / cz) * f * 384, y: 384 - (cy / cz) * f * 384, behind: false };
}
function snap(over = {}) {
  return {
    status: 'playing', time: 42.4,
    player: { position: { x: 0.5, y: 0, z: 6 }, yaw: Math.PI, hp: 80, maxHp: 100, energy: 60, maxEnergy: 100, action: 'idle', combo: 0, comboMultiplier: 1, comboTimer: 0, encounter: 'engaged', ...(over.player || {}) },
    boss: { position: { x: 0, y: 0, z: 0 }, hp: 500, maxHp: 700, action: 'idle', stage: 1, ...(over.boss || {}) },
    telegraphs: over.telegraphs || [], projectiles: [], cooldowns: {}, stats: {},
  };
}
let evId = 0;
const ev = (type, data = {}, position = { x: 0, y: 3, z: 0 }) => ({ id: `t-${++evId}`, type, position, data });
function frame(hud, s, events = [], extra = {}) {
  hud.frame({ dtReal: 1 / 60, timeScale: 1, screen: 'playing', snapshot: s, events, input: null, project, viewport: { w: 1366, h: 768 }, intro: { active: false, t: 0, duration: 5 }, settings: { reducedMotion: !!extra.rm }, resumeLeftMs: 0, pois: [], coach: null, layout: null });
}
function run(events, s = snap(), frames = 6, extra = {}) {
  const fc = fakeCanvas();
  const hud = createBattleHud({ canvas: fc.canvas });
  frame(hud, s, events, extra);
  for (let i = 1; i < frames; i++) frame(hud, s, [], extra);
  return fc.texts;
}
const has = (texts, re) => texts.some((t) => re.test(t));

test('каждый приём — крупная надпись: ИСКРА, РАССЕЧЕНИЕ, ЩИТ, РЫВОК, ВЫСТРЕЛ, БЛОК, СНАРЯД', () => {
  const cases = [
    [ev('player_cast', { ability: 'spark' }), /^ИСКРА!$/],
    [ev('player_slash', { hit: true, cut: 0 }), /^РАССЕЧЕНИЕ!$/],
    [ev('shield_start', { energy: 80 }), /^ЩИТ!$/],
    [ev('player_dash', { direction: 1 }), /^РЫВОК!$/],
    [ev('bow_release', { charged: false, rain: false }), /^ВЫСТРЕЛ!$/],
    [ev('bow_release', { charged: true, rain: false }), /^ЗАРЯЖЕННЫЙ ВЫСТРЕЛ!$/],
    [ev('block', { prevented: true }), /^БЛОК!$/],
    [ev('player_cast', { ability: 'bolt' }), /^СНАРЯД$/],
    [ev('perfect_dodge', { energy: 20 }), /^ИДЕАЛЬНЫЙ РЫВОК!$/],
    [ev('hand_spell_throw', { element: 'fire' }), /^ОГОНЬ!$/],
  ];
  for (const [e, re] of cases) assert(has(run([e]), re), `${e.type} ${JSON.stringify(e.data)} → нет ${re}`);
});

test('ПАРИРОВАНО! на успешное парирование; промах — «ПАРИРОВАНИЕ» с подсказкой', () => {
  assert(has(run([ev('parry', { success: true, projectileId: 'p1' })]), /^ПАРИРОВАНО!$/), 'успех');
  const miss = run([ev('parry', { success: false })]);
  assert(has(miss, /^ПАРИРОВАНИЕ$/) && has(miss, /ждите летящую сферу/), 'промах');
});

test('ВЫБРОС ×N учитывает силу, обе руки и множитель комбо из boss_hit', () => {
  const t = run([ev('burst', { power: 0.8, both: true }), ev('boss_hit', { amount: 180, source: 'burst', multiplier: 1.3 })]);
  // (0.5 + 0.8) × 1.25 × 1.3 = 2.1
  assert(has(t, /^ВЫБРОС ×2\.1$/), t.filter((x) => /ВЫБРОС/.test(x)).join(','));
});

test('цифры урона: крит (по открытому Регенту) — «КРИТ!», отражённая сфера — тоже крит, обычный — без', () => {
  const crit = run([ev('boss_hit', { amount: 33, source: 'slash', recoverBonus: true })]);
  assert(has(crit, /^КРИТ!$/) && has(crit, /^33$/), 'крит рассечения');
  const plain = run([ev('boss_hit', { amount: 7, source: 'bolt' })]);
  assert(has(plain, /^7$/) && !has(plain, /^КРИТ!$/), 'обычный');
  const refl = run([ev('parry', { success: true, projectileId: 'orb-9' }), ev('projectile_impact', { result: 'boss', projectileId: 'orb-9' }), ev('boss_hit', { amount: 21, source: 'bolt' })]);
  assert(has(refl, /^КРИТ!$/), 'отражённая сфера');
  // крит не «залипает»: следующий обычный удар — без крита
  const fc = fakeCanvas(); const hud = createBattleHud({ canvas: fc.canvas });
  frame(hud, snap(), [ev('parry', { success: true, projectileId: 'x' }), ev('projectile_impact', { result: 'boss', projectileId: 'x' }), ev('boss_hit', { amount: 21, source: 'bolt' })]);
  for (let i = 0; i < 80; i++) frame(hud, snap());
  fc.texts.length = 0;
  frame(hud, snap(), [ev('boss_hit', { amount: 6, source: 'bolt' })]);
  assert(!has(fc.texts, /^КРИТ!$/), 'крит не переносится на следующий удар');
});

test('комбо крупно: «×7» и «КОМБО»', () => {
  const t = run([], snap({ player: { combo: 7, comboMultiplier: 1.14, comboTimer: 2 } }));
  assert(has(t, /^×7$/) && has(t, /^КОМБО$/), t.slice(0, 20).join(','));
});

test('телеграф: красная зона с подписью ответа и «!» над Регентом за ≤ 0,9 с до удара', () => {
  const slam = (remaining, target = { x: 0.5, y: 0, z: 6 }) => ({ id: 'a1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target, center: target, radius: 2, remaining, duration: 1.7, blockable: false, damage: 13 });
  const early = run([], snap({ telegraphs: [slam(1.4)] }), 2);
  assert(has(early, /РЫВОК — уйди из круга/) && !has(early, /^!$/), 'рано: подпись есть, «!» ещё нет');
  const late = run([], snap({ telegraphs: [slam(0.6)] }), 2);
  assert(has(late, /^!$/) && has(late, /УДАР ЛАДОНЬЮ/), 'поздно: «!» и название атаки');
  const safe = run([], snap({ telegraphs: [slam(0.6, { x: 6, y: 0, z: 0 })] }), 2);
  assert(has(safe, /вы вне круга/), 'герой вне круга');
  const nova = run([], snap({ telegraphs: [{ id: 'n1', kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 }, radius: 9.5, remaining: 0.5, duration: 2.1, blockable: true, damage: 15 }] }), 2);
  assert(has(nova, /ЩИТ или РЫВОК/), 'нова: щит или рывок');
  const fly = run([], { ...snap(), projectiles: [{ id: 'o1', owner: 'boss', kind: 'orb', position: { x: 0, y: 1.2, z: 3 }, velocity: { x: 0, y: 0, z: 11 }, radius: 0.55 }] }, 2);
  assert(has(fly, /СФЕРА ЛЕТИТ/) && has(fly, /ЩИТ или ПАРИРОВАНИЕ/), 'сфера в полёте: подсказка до попадания');
});

test('финал: «ПОБЕДА» и время боя; поражение — «РЕГЕНТ УСТОЯЛ» с остатком здоровья Регента', () => {
  const v = run([ev('victory', { time: 102.3 })], snap({ boss: { hp: 0, action: 'dead' } }), 30);
  assert(has(v, /^ПОБЕДА$/) && has(v, /время боя 1:42/), v.filter((x) => /ПОБЕДА|время/.test(x)).join(','));
  const d = run([ev('defeat', { time: 50 })], { ...snap({ boss: { hp: 161, maxHp: 700 } }), status: 'defeat' }, 30);
  assert(has(d, /^РЕГЕНТ УСТОЯЛ$/) && has(d, /23%/), d.filter((x) => /РЕГЕНТ|%/.test(x)).join(','));
});

test('«Уменьшенное движение»: надписи есть (без «щелчка» и тряски); мусор в событиях не ломает HUD', () => {
  const t = run([ev('shield_start'), ev('boss_hit', { amount: 50, source: 'burst' })], snap(), 4, { rm: true });
  assert(has(t, /^ЩИТ!$/) && has(t, /^50$/), 'надписи при rm');
  const junk = run([null, 5, { type: 'boss_hit' }, { type: 'player_cast', data: null }, ev('parry', null), ev('ability_denied', { ability: 'shield', reason: 'energy' })]);
  assert(has(junk, /ЩИТ: НЕТ ЭНЕРГИИ/), 'отказ — честная надпись');
  const rune = run([ev('ability_denied', { ability: 'rune', reason: 'cooldown' })]);
  assert(has(rune, /^РУНА: ПЕРЕЗАРЯДКА$/) && !has(rune, /РУНА: РУНА/), 'руна на откате — без повтора слова');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed && typeof process !== 'undefined') process.exitCode = 1;
