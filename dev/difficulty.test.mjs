// Тесты сложности боя с Регентом (combat.setDifficulty, config.combat.difficulty) и баланс ботом.
// node dev/difficulty.test.mjs
//
// [W5-СЛОЖНОСТЬ] Четыре уровня: «Лёгкая», «Обычная», «Сложная», «Кошмар» (+ служебные 'base' — прежний баланс модуля
// без выбора и 'challenge' — «Испытание · 60 с», прежняя «Лёгкая»). Баланс — бот dev/balanceBot.mjs: игрок с камерой
// (задержка 100–200 мс, реакция, внимание, сбои распознавания), режим «Новичок» с автоходом. Это ориентир баланса
// между уровнями, не проверка трекинга. Цели из задачи волны 5 — по «среднему» боту.
import { createCombat, DIFFICULTY_LEVELS, DIFFICULTY_PRESETS } from '../modules/combat.js';
import { createBossBrain } from '../modules/boss.js';
import { config as gameConfig } from '../config.js';
import { CHALLENGE } from '../modules/challenge.js';
import { runSeries } from './balanceBot.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
const DT = 1 / 60;
const I = (o = {}) => ({ source: 'cv', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, ...o });
const FACTS = {};
const GAME = gameConfig.combat;   // как в игре: множители из config.js

// мозг, который один раз выпускает заданную атаку
const oneShot = (spec) => { let sent = false; return { reset() { sent = false; }, update() { if (sent) return { stage: 1, action: 'idle', attacks: [] }; sent = true; return { stage: 1, action: 'windup', attacks: [{ ...spec }] }; } }; };

test('уровни: Лёгкая, Обычная, Сложная, Кошмар + служебные; без выбора — прежний баланс (1000 HP)', () => {
  assert(DIFFICULTY_LEVELS.join(',') === 'easy,normal,hard,nightmare', 'уровни');
  assert(DIFFICULTY_PRESETS.includes('base') && DIFFICULTY_PRESETS.includes('challenge'), 'служебные');
  const c = createCombat({ config: {}, bossBrain: createBossBrain({ seed: 1 }) });
  const d = c.getDifficulty();
  assert(d.level === 'base' && d.bossMaxHp === 1000 && d.bossHpMul === 1 && d.bossDamageMul === 1 && !d.selectable, JSON.stringify(d));
  assert(c.getSnapshot().boss.hp === 1000 && c.getSnapshot().difficulty === 'base', 'HP Регента 1000, уровень в снимке');
});

test('setDifficulty: здоровье из config.js, свежий бой обновляется сразу; мусор → «Обычная»', () => {
  const c = createCombat({ config: GAME, bossBrain: createBossBrain({ seed: 1 }) });
  for (const lv of DIFFICULTY_LEVELS) {
    const d = c.setDifficulty(lv);
    const want = Math.round(1000 * GAME.difficulty[lv].bossHp);
    assert(d.level === lv && d.bossMaxHp === want && d.selectable, `${lv}: ${JSON.stringify(d)}`);
    assert(c.getSnapshot().boss.hp === want && c.getSnapshot().difficulty === lv, `${lv}: свежий бой ${c.getSnapshot().boss.hp}`);
  }
  assert(c.setDifficulty('ultra').level === 'normal', 'неизвестный уровень → normal');
  c.reset();
  assert(c.getSnapshot().boss.hp === Math.round(1000 * GAME.difficulty.normal.bossHp), 'normal после reset');
  // уровни идут по возрастанию: здоровье не меньше, очки — множитель
  const hp = DIFFICULTY_LEVELS.map((lv) => GAME.difficulty[lv].bossHp);
  assert(hp.every((v, i) => i === 0 || v >= hp[i - 1]), `здоровье по уровням ${hp}`);
  assert(c.setDifficulty('hard').scoreMul === 1.5 && c.setDifficulty('nightmare').scoreMul === 2 && c.setDifficulty('normal').scoreMul === 1, 'очки ×1,5 и ×2');
});

test('«Испытание · 60 с» — своя сложность: прежняя «Лёгкая» (700 HP, урон ×0,7), поведение Регента прежнее', () => {
  assert(CHALLENGE.difficulty === 'challenge', CHALLENGE.difficulty);
  const c = createCombat({ config: GAME, bossBrain: createBossBrain({ seed: 1 }) });
  const d = c.setDifficulty(CHALLENGE.difficulty);
  assert(d.bossMaxHp === 700 && d.bossDamageMul === 0.7 && d.scoreMul === 1 && d.furyMul === 1 && !d.selectable, JSON.stringify(d));
});

test('урон атак Регента: множитель уровня на телеграфе и попадании', () => {
  const spec = { id: 'tst-slam-1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.5, radius: 2, damage: 20, blockable: false };
  for (const lv of ['base', 'challenge', ...DIFFICULTY_LEVELS]) {
    const want = Math.round(20 * (lv === 'base' ? 1 : lv === 'challenge' ? 0.7 : GAME.difficulty[lv].bossDamage));
    const c = createCombat({ config: GAME, bossBrain: oneShot(spec) });
    c.setDifficulty(lv); c.reset();
    let hit = null, tel = null;
    for (let i = 0; i < 90 && !hit; i++) {
      c.update(DT, I());
      if (!tel && c.getSnapshot().telegraphs[0]) tel = c.getSnapshot().telegraphs[0];
      hit = c.drainEvents().find((e) => e.type === 'player_hit') || null;
    }
    assert(tel && tel.damage === want, `${lv}: телеграф ${tel && tel.damage} ≠ ${want}`);
    assert(hit && hit.data.amount === want, `${lv}: попадание ${hit && hit.data.amount}`);
  }
});

test('сложность не режет награду за парирование: отражённая сфера бьёт Регента одинаково на всех уровнях', () => {
  const spec = { id: 'tst-orb-1', kind: 'orb', origin: { x: 0, y: 1.2, z: 1.4 }, target: { x: 0, y: 1, z: 6 }, windup: 0.5, radius: 0.55, damage: 20, blockable: true, projectileSpeed: 8 };
  const reflected = {};
  for (const lv of ['normal', 'easy', 'nightmare']) {
    const c = createCombat({ config: GAME, bossBrain: oneShot(spec) });
    c.setDifficulty(lv); c.reset();
    let parried = false, hit = null;
    for (let i = 0; i < 300 && !hit; i++) {
      const s = c.getSnapshot();
      const orb = s.projectiles.find((p) => p.owner === 'boss');
      const near = orb && Math.hypot(orb.position.x - s.player.position.x, orb.position.z - s.player.position.z) < 2.2;
      c.update(DT, I(near && !parried ? { parry: true } : {}));
      if (near) parried = true;
      hit = c.drainEvents().find((e) => e.type === 'boss_hit') || null;
    }
    assert(hit, `${lv}: отражённая сфера не попала`);
    reflected[lv] = hit.data.amount;
  }
  assert(reflected.easy === reflected.normal && reflected.nightmare === reflected.normal && reflected.normal >= 30, JSON.stringify(reflected));
});

test('«Сложная» и «Кошмар»: меньше восстановления — ярость, лечение, расход щита, энергия', () => {
  const idle = { reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } };
  // одно и то же здоровье Регента на всех уровнях — сравниваются только множители восстановления
  const SAME = { difficulty: Object.fromEntries(DIFFICULTY_LEVELS.map((lv) => [lv, { ...GAME.difficulty[lv], bossHp: 1 }])) };
  const run = (lv, fn) => { const c = createCombat({ config: SAME, bossBrain: idle }); c.setDifficulty(lv); c.reset(); return fn(c); };
  // ярость за одну и ту же серию «OK»-огня
  const fury = (lv) => run(lv, (c) => { for (let i = 0; i < 300; i++) c.update(DT, I({ attack: true })); return c.getSnapshot().player.fury; });
  const fN = fury('normal'), fH = fury('hard'), fK = fury('nightmare');
  assert(fN > 0 && Math.abs(fH / fN - GAME.difficulty.hard.fury) < 0.02, `ярость hard ${fH} / normal ${fN}`);
  assert(fK < fH, `ярость кошмар ${fK} < сложная ${fH}`);
  // щит: расход за 1 с удержания
  const drain = (lv) => run(lv, (c) => { const e0 = c.getSnapshot().player.energy; for (let i = 0; i < 60; i++) c.update(DT, I({ shield: true })); return e0 - c.getSnapshot().player.energy; });
  const dN = drain('normal'), dK = drain('nightmare');
  assert(Math.abs(dK / dN - GAME.difficulty.nightmare.shieldDrain) < 0.03, `щит: ${dN} → ${dK}`);
  // восстановление энергии: после траты на щит
  const regen = (lv) => run(lv, (c) => { for (let i = 0; i < 120; i++) c.update(DT, I({ shield: true })); for (let i = 0; i < 40; i++) c.update(DT, I()); const e1 = c.getSnapshot().player.energy; for (let i = 0; i < 60; i++) c.update(DT, I()); return c.getSnapshot().player.energy - e1; });
  const rN = regen('normal'), rH = regen('hard');
  assert(rN > 10 && Math.abs(rH / rN - GAME.difficulty.hard.energyRegen) < 0.03, `энергия: ${rN} → ${rH}`);
  // лечение руной «Орбис» (Мастер): после попадания
  const spec = { id: 'tst-heal-slam', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.4, radius: 2, damage: 60, blockable: false };
  const healed = {};
  for (const lv of ['normal', 'nightmare']) {
    const c = createCombat({ config: GAME, bossBrain: oneShot(spec) });
    c.setDifficulty(lv); c.reset();
    for (let i = 0; i < 60; i++) c.update(DT, I());
    const hp0 = c.getSnapshot().player.hp;
    c.update(DT, I({ rune: 'orbis' }));
    healed[lv] = c.getSnapshot().player.hp - hp0;
  }
  assert(healed.normal > 0 && Math.abs(healed.nightmare / healed.normal - GAME.difficulty.nightmare.heal) < 0.05, `лечение ${JSON.stringify(healed)}`);
  // «Кор» (печать) и «Лемниска» (руна): подпись «+N HP» в событии — сколько вылечит на самом деле
  for (const [lv, k] of [['normal', 1], ['nightmare', GAME.difficulty.nightmare.heal]]) {
    const c = createCombat({ config: SAME, bossBrain: idle });
    c.setDifficulty(lv); c.reset();
    c.update(DT, I({ sigil: 'cor' }));
    let ev = c.drainEvents();
    const cor = ev.find((e) => e.type === 'sigil_cast' && e.data.sigil === 'cor');
    for (let i = 0; i < 2400; i++) c.update(DT, I());
    c.drainEvents();
    c.update(DT, I({ rune: 'lemnis' }));
    ev = c.drainEvents();
    const lem = ev.find((e) => e.type === 'rune_cast' && e.data.rune === 'lemnis');
    assert(cor && cor.data.heal === Math.round(45 * k), `${lv}: «Кор» +${cor && cor.data.heal}`);
    assert(lem && lem.data.heal === Math.round(45 * k), `${lv}: «Лемниска» +${lem && lem.data.heal}`);
  }
});

test('финт: мозг обрывает замах (cancelIds) — телеграф снят с reason feint, новая атака принята в том же шаге', () => {
  const a = { id: 'f-1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 1.2, radius: 2, damage: 20, blockable: false, cue: 0.7 };
  const b = { ...a, id: 'f-2', kind: 'orb', target: { x: 0, y: 1, z: 6 }, origin: { x: 0, y: 1.2, z: 1.4 }, radius: 0.55, blockable: true, projectileSpeed: 10 };
  let n = 0;
  const brain = { reset() { n = 0; }, update() { n++; if (n === 1) return { stage: 1, action: 'windup', attacks: [a] }; if (n === 40) return { stage: 1, action: 'windup', attacks: [b], cancelIds: ['f-1'] }; return { stage: 1, action: 'windup', attacks: [] }; } };
  const c = createCombat({ config: GAME, bossBrain: brain });
  c.setDifficulty('hard'); c.reset();
  const ev = [];
  for (let i = 0; i < 30; i++) { c.update(DT, I()); ev.push(...c.drainEvents()); }
  const s = c.getSnapshot();
  assert(s.telegraphs.length === 1 && s.telegraphs[0].id === 'f-2' && s.telegraphs[0].cue === 0.7, JSON.stringify(s.telegraphs.map((t) => [t.id, t.cue])));
  const ci = ev.findIndex((e) => e.type === 'telegraph_cancel' && e.data.attackId === 'f-1' && e.data.reason === 'feint');
  const wi = ev.findIndex((e) => e.type === 'boss_windup' && e.data.attackId === 'f-2');
  assert(ci >= 0 && wi > ci, `cancel ${ci}, windup ${wi}`);
  assert(!ev.some((e) => e.type === 'boss_impact' && e.data.attackId === 'f-1'), 'финт не бьёт');
});

test('мозг Регента видит уровень боя в снимке: «Сложная» — свои приёмы, «Лёгкая» — прежний порядок', () => {
  // здоровье одно на всех уровнях (иначе вторая стадия наступает в разное время)
  const SAME = { difficulty: Object.fromEntries(DIFFICULTY_PRESETS.map((lv) => [lv, { bossHp: 1, bossDamage: 1 }])) };
  const seq = (lv, seed) => {
    const brain = createBossBrain({ seed });
    const c = createCombat({ config: SAME, bossBrain: brain });
    c.setDifficulty(lv); c.reset();
    const out = [];
    for (let i = 0; i < 60 * 40; i++) {
      c.update(DT, I({ autoWalk: true, gestureMode: 'novice', shield: (i % 200) > 150, attack: (i % 200) < 150 }));
      for (const e of c.drainEvents()) if (e.type === 'boss_windup') out.push(e.data.move || e.data.attackKind);
      if (c.getSnapshot().status !== 'playing') break;
    }
    return { out, dbg: brain.getDebug() };
  };
  const e = seq('easy', 5), b = seq('base', 5), h = seq('hard', 5);
  assert(e.out.join() === b.out.join(), 'Лёгкая: порядок атак как у прежнего мозга');
  assert(e.dbg.level === 'easy' && h.dbg.level === 'hard', `${e.dbg.level} ${h.dbg.level}`);
  assert(h.out.some((k) => k === 'volley' || k === 'double'), `Сложная: составные приёмы ${h.out.join(',')}`);
});

// ---- баланс ботом (цели задачи волны 5 — по «среднему» боту) ----
const SEEDS = 12;
const series = (level, skill, seeds = SEEDS) => { const r = runSeries({ level, skill, seeds, maxSec: 900, config: GAME }); FACTS[`${level}/${skill}`] = r.summary; return r.summary; };

test('бот «средний»: Лёгкая 1,5–3 мин, Обычная 3–4 мин — побеждает', () => {
  const e = series('easy', 'medium'), n = series('normal', 'medium');
  assert(e.wins === e.n && e.median >= 90 && e.median <= 180, `Лёгкая: ${JSON.stringify(e)}`);
  assert(n.wins >= n.n - 1 && n.median >= 180 && n.median <= 240, `Обычная: ${JSON.stringify(n)}`);
});

test('бот «средний»: Сложная 4–6 мин с заметным шансом проиграть; Кошмар — проигрывает чаще, чем выигрывает', () => {
  const h = series('hard', 'medium'), k = series('nightmare', 'medium');
  assert(h.median >= 240 && h.median <= 360, `Сложная: время ${JSON.stringify(h)}`);
  assert(h.losses >= 1 && h.wins >= h.n / 2, `Сложная: побед ${h.wins}, поражений ${h.losses}`);
  assert(k.losses > k.wins, `Кошмар: побед ${k.wins}, поражений ${k.losses}`);
});

test('первый бой новичка: бот-новичок на «Лёгкой» побеждает; «Кошмар» опытному под силу, но не всегда', () => {
  const ne = series('easy', 'novice');
  assert(ne.wins >= ne.n - 1, `новичок на Лёгкой: ${JSON.stringify(ne)}`);
  const xk = series('nightmare', 'expert');
  assert(xk.wins >= 1 && xk.losses >= 1, `опытный на Кошмаре: ${JSON.stringify(xk)}`);
});

let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  const s = Date.now();
  try { t.fn(); console.log(`PASS  ${t.name}  (${Date.now() - s} ms)`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed, ${Date.now() - t0} ms`);
console.log('FACTS', JSON.stringify(FACTS));
if (failed && typeof process !== 'undefined') process.exitCode = 1;
