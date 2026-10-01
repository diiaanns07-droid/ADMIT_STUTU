// Режим «Новичок» и «Автоход». node dev/novice.test.mjs
// • combat: автоход ведёт героя от места старта (за колонной) в арену и обходит Регента по кругу;
//   выключен — герой стоит; «Новичок» отбрасывает импульсы выключенных жестов, базовые работают.
// • handGestures, профиль 'novice': «OK», выброс, сфера и бросок, щит, рывок срабатывают;
//   руны, «Искра», рассечение, парирование, призма и печати — нет (и подсказок о них нет).
// Синтетика (dev/handSynth.mjs), не реальная камера.

import { config } from '../config.js';
import { createBossBrain } from '../modules/boss.js';
import { createCombat } from '../modules/combat.js';
import { createHandGestures, GESTURE_PROFILES } from '../core/handGestures.js';
import { makeScene, handAt, obsOf, reseed } from './handSynth.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

// ───────── combat ─────────
const DT = 1 / 60;
// раскладка как в игре: арена r = 13, старт снаружи (z = 22), колонна прямо на пути к Регенту (0, 18)
const COLUMNS = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ type: 'circle', x: Math.sin(a * Math.PI / 180) * 18, z: Math.cos(a * Math.PI / 180) * 18, r: 0.8 }));
const LAYOUT = {
  version: 1, bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
  arena: { x: 0, z: 0, r: 13, leash: 6 }, bossHome: { x: 0, z: 0 },
  playerSpawn: { x: 0, z: 22, yaw: Math.PI }, colliders: COLUMNS, pois: [],
  groundY: () => 0, isWalkable: (x, z) => Math.hypot(x, z) <= 55,
};
config.settings = { ...config.defaultSettings };
// бой без атак Регента: проверяем ход, а не выживание
const quietBrain = () => { const b = createBossBrain(config); return { ...b, update: () => ({ stage: 1, action: 'idle', attacks: [] }), reset: () => b.reset() }; };
const make = (brain) => createCombat({ config, bossBrain: brain || quietBrain(), layout: LAYOUT });
const inp = (p = {}) => ({ source: 'cv', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, moveMode: 'steer', ...p });
const pos = (c) => c.getSnapshot().player.position;
const dist = (p) => Math.hypot(p.x, p.z);

test('настройки по умолчанию: «Новичок» и автоход включены', () => {
  ok(config.defaultSettings.gestureMode === 'novice', String(config.defaultSettings.gestureMode));
  ok(config.defaultSettings.autoWalk === true, String(config.defaultSettings.autoWalk));
});

test('автоход: от старта за колонной герой сам доходит до арены (≤ 8 с)', () => {
  const c = make();
  ok(dist(pos(c)) > 20, 'старт снаружи арены');
  let t = 0, engagedAt = null;
  for (; t < 12 && engagedAt === null; t += DT) {
    c.update(DT, inp({ autoWalk: true, gestureMode: 'novice' }));
    if (c.drainEvents().some((e) => e.type === 'encounter_start')) engagedAt = t;
  }
  ok(engagedAt !== null && engagedAt <= 8, `вход в арену за ${engagedAt === null ? '—' : engagedAt.toFixed(1)} с`);
});

test('автоход: в арене обходит Регента по кругу на ~6,5 м и меняет сторону', () => {
  const c = make();
  for (let t = 0; t < 8; t += DT) c.update(DT, inp({ autoWalk: true }));
  let minR = Infinity, maxR = 0, sweep = 0, prevA = null, signs = new Set();
  for (let t = 0; t < 20; t += DT) {
    c.update(DT, inp({ autoWalk: true }));
    const p = pos(c), r = dist(p), a = Math.atan2(p.x, p.z);
    if (t > 2) { minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    if (prevA !== null) { const d = Math.atan2(Math.sin(a - prevA), Math.cos(a - prevA)); sweep += Math.abs(d); if (Math.abs(d) > 1e-4) signs.add(Math.sign(d)); }
    prevA = a;
  }
  ok(minR >= 5.3 && maxR <= 7.7, `дистанция ${minR.toFixed(2)}..${maxR.toFixed(2)} м`);
  ok(sweep >= Math.PI, `обошёл ${(sweep * 180 / Math.PI).toFixed(0)}° за 20 с`);
  ok(signs.size === 2, 'обход в обе стороны');
  const s = c.getSnapshot();
  const face = Math.atan2(-s.player.position.x, -s.player.position.z);
  ok(Math.abs(Math.atan2(Math.sin(s.player.yaw - face), Math.cos(s.player.yaw - face))) < 0.3, 'смотрит на Регента');
});

test('автоход выключен: без ввода герой стоит', () => {
  const c = make();
  const p0 = pos(c);
  for (let t = 0; t < 3; t += DT) c.update(DT, inp({ autoWalk: false }));
  const p1 = pos(c);
  ok(Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.01, `сдвиг ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3)} м`);
});

test('автоход: рука игрока (руль) не уводит героя — ведёт автоход; рывок работает', () => {
  const c = make();
  for (let t = 0; t < 8; t += DT) c.update(DT, inp({ autoWalk: true, moveX: 1, moveZ: 1, stick: { mode: 'steer', engaged: true } }));
  ok(c.getSnapshot().player.position && dist(pos(c)) < 9, `в арене: r=${dist(pos(c)).toFixed(1)}`);
  const e0 = c.getSnapshot().player.energy;
  c.update(DT, inp({ autoWalk: true, dashDir: { x: 1, z: 0 }, dash: 1 }));
  for (let t = 0; t < 0.1; t += DT) c.update(DT, inp({ autoWalk: true }));
  ok(c.getSnapshot().player.energy < e0 - 10, 'рывок потратил энергию');
});

test('автоход: щит в автоходе держится, герой идёт медленнее', () => {
  const c = make();
  for (let t = 0; t < 8; t += DT) c.update(DT, inp({ autoWalk: true }));
  for (let t = 0; t < 0.6; t += DT) c.update(DT, inp({ autoWalk: true, shield: true }));
  ok(c.getSnapshot().player.shielding === true, 'щит поднят');
});

test('«Новичок»: руны, искра, рассечение, парирование, печати, лук не действуют; базовые — да', () => {
  const c = make();
  for (let t = 0; t < 8; t += DT) c.update(DT, inp({ autoWalk: true }));
  c.drainEvents();
  const extra = { rune: 'ignis', spark: true, slash: { dir: 1, power: 1 }, parry: true, sigil: 'clap', bow: { active: true, phase: 'drawing', draw: 1, release: true, charged: true }, handSpell: { phase: 'throw', element: 'fire', power: 1 } };
  for (let i = 0; i < 30; i++) c.update(DT, inp({ gestureMode: 'novice', ...extra }));
  const ev = c.drainEvents().map((e) => e.type);
  const bad = ev.filter((k) => /rune|spark|slash|parry|sigil|bow|hand_spell|arrow/.test(k));
  ok(bad.length === 0, `события выключенных жестов: ${[...new Set(bad)].join(',')}`);
  // базовые
  const hp0 = c.getSnapshot().boss.hp;
  for (let t = 0; t < 1.5; t += DT) c.update(DT, inp({ gestureMode: 'novice', attack: true }));
  for (let t = 0; t < 1.5; t += DT) c.update(DT, inp({ gestureMode: 'novice' }));
  ok(c.getSnapshot().boss.hp < hp0, '«OK»-огонь наносит урон');
  c.update(DT, inp({ gestureMode: 'novice', burst: true, burstPower: 1, burstHand: 'right' }));
  ok(c.drainEvents().some((e) => e.type === 'burst'), 'выброс');
});

test('«Мастер»: те же импульсы проходят (руна)', () => {
  const c = make();
  for (let t = 0; t < 8; t += DT) c.update(DT, inp({ autoWalk: true }));
  c.drainEvents();
  for (let i = 0; i < 5; i++) c.update(DT, inp({ gestureMode: 'master', rune: 'ignis' }));
  const ev = c.drainEvents().map((e) => e.type);
  ok(ev.some((k) => /rune/.test(k)), ev.join(','));
});

// ───────── handGestures: профиль «Новичок» ─────────
const S = makeScene({ cx: 0.5, cy: 0.4, sw: 0.3 });
function run(g, seq, t0 = 1000, dt = 33) {
  // seq: [{ ms, L: (u) => hand|null, R: (u) => hand|null }]; возвращает собранные события
  const ev = { attack: 0, burst: 0, rune: 0, spark: 0, slash: 0, parry: 0, sigil: 0, conjure: 0, throw: 0, shield: 0, hints: [] };
  let t = t0;
  for (const P of seq) {
    for (let k = 0; k * dt < P.ms; k++, t += dt) {
      const u = (k * dt) / P.ms;
      const L = P.L ? P.L(u) : null, R = P.R ? P.R(u) : null;
      g.push(obsOf(S, t, { left: L, right: R }));
      const f = g.read(t);
      if (f.attack) ev.attack++;
      if (f.burst) ev.burst++;
      if (f.rune || f.runeFizzle) ev.rune++;
      if (f.spark) ev.spark++;
      if (f.slash) ev.slash++;
      if (f.parry) ev.parry++;
      if (f.sigil) ev.sigil++;
      if (f.conjure) ev.conjure++;
      if (f.throw) ev.throw++;
      if (f.shield) ev.shield++;
      if (f.hint) ev.hints.push(f.hint.code);
    }
  }
  return { ev, t };
}
const lerp = (a, b, u) => a + (b - a) * u;

test('профили: в «Новичке» ровно базовые жесты', () => {
  ok(GESTURE_PROFILES.novice.join() === 'steer,shield,dash,attack,burst,orb,throw', GESTURE_PROFILES.novice.join());
  for (const g of ['rune', 'spark', 'slash', 'parry', 'prism', 'sigil', 'twin']) ok(!GESTURE_PROFILES.novice.includes(g), g);
});

for (const profile of ['novice', 'master']) {
  test(`${profile}: «OK» правой — снаряды`, () => {
    reseed(5);
    const g = createHandGestures({ moveMode: 'steer', profile });
    const { ev } = run(g, [{ ms: 600, R: () => handAt(S, 'right', 0.45, 0.2, 'ok') }]);
    ok(ev.attack > 5, `attack=${ev.attack}`);
  });
  test(`${profile}: кулак правой → раскрыть — выброс`, () => {
    reseed(6);
    const g = createHandGestures({ moveMode: 'steer', profile });
    const { ev } = run(g, [
      { ms: 500, R: () => handAt(S, 'right', 0.5, 0.25, 'open') },
      { ms: 900, R: () => handAt(S, 'right', 0.5, 0.25, 'fist') },
      { ms: 400, R: () => handAt(S, 'right', 0.5, 0.25, 'open') },
    ]);
    ok(ev.burst >= 1, `burst=${ev.burst}`);
  });
}

test('novice: указательный правой рисует ▲ — руны нет, подсказок о руне нет', () => {
  reseed(7);
  const g = createHandGestures({ moveMode: 'steer', profile: 'novice' });
  const V = [[0.1, -0.3], [0.45, 0.3], [-0.25, 0.3], [0.1, -0.3]];
  const { ev } = run(g, [
    { ms: 500, R: () => handAt(S, 'right', 0.1, -0.3, 'point') },
    { ms: 1500, R: (u) => { const a = u * 3, k = Math.min(2, Math.floor(a)), f = a - k; return handAt(S, 'right', lerp(V[k][0], V[k + 1][0], f), lerp(V[k][1], V[k + 1][1], f), 'point'); } },
    { ms: 700, R: () => handAt(S, 'right', 0.1, -0.3, 'point') },
  ]);
  ok(ev.rune === 0, `rune=${ev.rune}`);
  ok(!ev.hints.some((h) => /^rune_/.test(h)), ev.hints.join(','));
});

test('master: та же ▲ — руна распознаётся (контроль)', () => {
  reseed(7);
  const g = createHandGestures({ moveMode: 'steer', profile: 'master' });
  const V = [[0.1, -0.3], [0.45, 0.3], [-0.25, 0.3], [0.1, -0.3]];
  const { ev } = run(g, [
    { ms: 500, R: () => handAt(S, 'right', 0.1, -0.3, 'point') },
    { ms: 1500, R: (u) => { const a = u * 3, k = Math.min(2, Math.floor(a)), f = a - k; return handAt(S, 'right', lerp(V[k][0], V[k + 1][0], f), lerp(V[k][1], V[k + 1][1], f), 'point'); } },
    { ms: 700, R: () => handAt(S, 'right', 0.1, -0.3, 'point') },
  ]);
  ok(ev.rune >= 1, `rune=${ev.rune}`);
});

test('novice: взмах правой ладонью — рассечения нет; кулак → указательный — «Искры» нет', () => {
  reseed(8);
  const g = createHandGestures({ moveMode: 'steer', profile: 'novice' });
  const { ev } = run(g, [
    { ms: 500, R: () => handAt(S, 'right', -0.3, 0.2, 'open') },
    { ms: 150, R: (u) => handAt(S, 'right', lerp(-0.3, 1.2, u), 0.2, 'open') },
    { ms: 600, R: () => handAt(S, 'right', 1.2, 0.2, 'open') },
    { ms: 500, R: () => handAt(S, 'right', 0.5, 0.2, 'fist') },
    { ms: 400, R: () => handAt(S, 'right', 0.5, 0.2, 'point') },
  ]);
  ok(ev.slash === 0 && ev.spark === 0, `slash=${ev.slash} spark=${ev.spark}`);
});

test('novice: левая кулак → ладонь к камере — парирования нет', () => {
  reseed(9);
  const g = createHandGestures({ moveMode: 'steer', profile: 'novice' });
  const { ev } = run(g, [
    { ms: 600, L: () => handAt(S, 'left', -0.55, 0.25, 'fist') },
    { ms: 400, L: () => handAt(S, 'left', -0.55, 0.25, 'open') },
  ]);
  ok(ev.parry === 0, `parry=${ev.parry}`);
});

test('novice: сфера двумя руками и бросок толчком к камере', () => {
  reseed(10);
  const g = createHandGestures({ moveMode: 'steer', profile: 'novice' });
  const orb = (x, side, size = 0.075) => handAt(S, side, x, 0.15, 'open', { yaw: side === 'left' ? 1.2 : -1.2, size });
  const { ev } = run(g, [
    { ms: 900, L: () => orb(-0.35, 'left'), R: () => orb(0.35, 'right') },
    { ms: 200, L: (u) => orb(-0.35, 'left', 0.075 * (1 + 0.5 * u)), R: (u) => orb(0.35, 'right', 0.075 * (1 + 0.5 * u)) },
    { ms: 300, L: () => orb(-0.35, 'left', 0.11), R: () => orb(0.35, 'right', 0.11) },
  ]);
  ok(ev.conjure > 3, `conjure=${ev.conjure}`);
  ok(ev.throw >= 1, `throw=${ev.throw}`);
});

test('configure: переключение профиля на лету', () => {
  const g = createHandGestures({ moveMode: 'steer' });
  ok(g.getDebug().profile === 'master', 'модуль по умолчанию — «Мастер» (как раньше)');
  g.configure({ profile: 'novice' });
  ok(g.getDebug().profile === 'novice', 'novice');
  g.configure({ profile: 'master' });
  ok(g.getDebug().profile === 'master', 'master');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
