// Тесты сложности боя с Регентом (combat.setDifficulty, config.combat.difficulty) и «бот-новичок».
// node dev/difficulty.test.mjs
//
// «Новичок» — грубая модель человека с камерой: решения по снимку с задержкой (CV + реакция),
// ввод обновляется с частотой распознавания (8–15 Гц), «OK» держится урывками и иногда теряется,
// на часть атак Регента человек не успевает ответить. Это НЕ проверка реального трекинга —
// только ориентир баланса: на «Лёгкой» новичок должен уверенно побеждать.
import { createCombat, DIFFICULTY_LEVELS } from '../modules/combat.js';
import { createBossBrain } from '../modules/boss.js';
import { config as gameConfig } from '../config.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
const DT = 1 / 60;
const I = (o = {}) => ({ source: 'cv', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, ...o });
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const FACTS = {};

function makeFight(level, seed, cfg = {}) {
  const c = createCombat({ config: cfg, bossBrain: createBossBrain({ seed }) });
  c.setDifficulty(level);
  c.reset();
  return c;
}

// Профили игроков: hz — частота распознавания, lag — задержка решения (с), atkOn/atkOff — сколько держит
// и отпускает «OK» (мин + разброс), drop — доля кадров, где жест потерян, skill — доля атак Регента, на
// которые игрок успевает ответить, dash — уходит ли рывком, burst — шанс выброса на решение.
const PROFILES = {
  novice10: { hz: 10, lag: 0.45, atkOn: [0.6, 1.2], atkOff: [0.8, 1.6], drop: 0.25, skill: 0.55, dash: false, burst: 0.05 },
  novice8: { hz: 8, lag: 0.55, atkOn: [0.5, 1.0], atkOff: [1.0, 2.0], drop: 0.3, skill: 0.45, dash: false, burst: 0.03 },
  confident: { hz: 15, lag: 0.35, atkOn: [1.0, 2.0], atkOff: [0.4, 0.8], drop: 0.12, skill: 0.8, dash: true, burst: 0.2 },
};

function runHuman(level, seed, prof, maxSec = 400) {
  const c = makeFight(level, seed);
  const rnd = lcg(seed * 7 + 3);
  const LAG = Math.round(prof.lag / DT), PERIOD = Math.max(1, Math.round(1 / prof.hz / DT));
  const hist = [];
  const react = new Map();
  let cur = I(), atkUntil = 0, atkNext = 1.0, lastTel = null;
  for (let i = 0; i < maxSec / DT; i++) {
    const s = c.getSnapshot();
    if (s.status !== 'playing') return { status: s.status, t: s.time, hp: s.player.hp, bossHp: s.boss.hp, taken: s.stats.damageTaken };
    hist.push(s);
    if (hist.length > LAG + 1) hist.shift();
    if (i % PERIOD === 0) {
      const v = hist[0], t = v.time;
      const inp = I();
      if (t >= atkNext) { atkUntil = t + prof.atkOn[0] + rnd() * prof.atkOn[1]; atkNext = atkUntil + prof.atkOff[0] + rnd() * prof.atkOff[1]; }
      inp.attack = t < atkUntil && rnd() > prof.drop;
      const tel = v.telegraphs[0];
      if (tel) {
        lastTel = tel.id;
        if (!react.has(tel.id)) react.set(tel.id, rnd() < prof.skill);
        if (react.get(tel.id)) {
          const p = v.player.position;
          if (tel.kind === 'slam') {
            if (Math.hypot(p.x - tel.target.x, p.z - tel.target.z) < tel.radius + 1.0) {
              if (prof.dash && tel.remaining < 0.7 && rnd() < 0.5) inp.dash = 1; else inp.moveX = 1;
            }
          } else if (tel.remaining < 0.8) { inp.shield = true; inp.attack = false; }
        }
      }
      if (lastTel && react.get(lastTel) && v.projectiles.some((pr) => pr.owner === 'boss')) { inp.shield = true; inp.attack = false; }
      if (v.player.energy >= 70 && v.cooldowns.burstRemaining <= 0 && rnd() < prof.burst) { inp.burst = true; inp.burstPower = 0.6; }
      cur = inp;
    } else cur = { ...cur, burst: false, dash: 0 };
    c.update(DT, cur);
    c.drainEvents();
  }
  const s = c.getSnapshot();
  return { status: 'timeout', t: s.time, hp: s.player.hp, bossHp: s.boss.hp, taken: s.stats.damageTaken };
}

function summary(level, prof, seeds = 20) {
  const rs = [];
  for (let seed = 1; seed <= seeds; seed++) rs.push(runHuman(level, seed, prof));
  const wins = rs.filter((r) => r.status === 'victory');
  const ts = wins.map((r) => r.t).sort((a, b) => a - b);
  return { wins: wins.length, of: seeds, median: ts.length ? +ts[ts.length >> 1].toFixed(1) : null, min: ts.length ? +ts[0].toFixed(1) : null, max: ts.length ? +ts[ts.length - 1].toFixed(1) : null };
}

test('уровни: easy и normal; по умолчанию в бою — normal (прежний баланс)', () => {
  assert(DIFFICULTY_LEVELS.join(',') === 'easy,normal', 'уровни');
  const c = createCombat({ config: {}, bossBrain: createBossBrain({ seed: 1 }) });
  const d = c.getDifficulty();
  assert(d.level === 'normal' && d.bossMaxHp === 1000 && d.bossHpMul === 1 && d.bossDamageMul === 1, JSON.stringify(d));
  assert(c.getSnapshot().boss.hp === 1000 && c.getSnapshot().boss.maxHp === 1000, 'HP Регента 1000');
});

test('«Лёгкая»: у Регента на 30% меньше здоровья, свежий бой обновляется сразу; мусор → обычная', () => {
  const c = createCombat({ config: {}, bossBrain: createBossBrain({ seed: 1 }) });
  const d = c.setDifficulty('easy');
  assert(d.level === 'easy' && d.bossMaxHp === 700 && d.bossDamageMul === 0.7, JSON.stringify(d));
  const s = c.getSnapshot();
  assert(s.boss.hp === 700 && s.boss.maxHp === 700, `свежий бой: ${s.boss.hp}/${s.boss.maxHp}`);
  c.reset();
  assert(c.getSnapshot().boss.hp === 700, 'после reset — 700');
  assert(c.setDifficulty('ultra').level === 'normal' && c.getSnapshot().boss.maxHp === 1000, 'неизвестный уровень → normal');
  c.reset();
  assert(c.getSnapshot().boss.hp === 1000, 'normal после reset — 1000');
});

test('«Лёгкая»: урон атак Регента ×0.7 (телеграф и попадание)', () => {
  const spec = { id: 'tst-slam-1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.5, radius: 2, damage: 20, blockable: false };
  const brain = () => { let sent = false; return { reset() { sent = false; }, update() { if (sent) return { stage: 1, action: 'idle', attacks: [] }; sent = true; return { stage: 1, action: 'windup', attacks: [{ ...spec }] }; } }; };
  for (const [level, want] of [['normal', 20], ['easy', 14]]) {
    const c = createCombat({ config: {}, bossBrain: brain() });
    c.setDifficulty(level); c.reset();
    let hit = null, tel = null;
    for (let i = 0; i < 90 && !hit; i++) {
      c.update(DT, I());
      if (!tel && c.getSnapshot().telegraphs[0]) tel = c.getSnapshot().telegraphs[0];
      hit = c.drainEvents().find((e) => e.type === 'player_hit') || null;
    }
    assert(tel && tel.damage === want, `${level}: телеграф ${tel && tel.damage}`);
    assert(hit && hit.data.amount === want, `${level}: попадание ${hit && hit.data.amount}`);
  }
});

test('«Лёгкая» не режет награду за парирование: отражённая сфера бьёт Регента так же, как на «Обычной»', () => {
  const spec = { id: 'tst-orb-1', kind: 'orb', origin: { x: 0, y: 1.2, z: 1.4 }, target: { x: 0, y: 1, z: 6 }, windup: 0.5, radius: 0.55, damage: 20, blockable: true, projectileSpeed: 8 };
  const brain = () => { let sent = false; return { reset() { sent = false; }, update() { if (sent) return { stage: 1, action: 'idle', attacks: [] }; sent = true; return { stage: 1, action: 'windup', attacks: [{ ...spec }] }; } }; };
  const reflected = {};
  for (const level of ['normal', 'easy']) {
    const c = createCombat({ config: {}, bossBrain: brain() });
    c.setDifficulty(level); c.reset();
    let parried = false, hit = null;
    for (let i = 0; i < 300 && !hit; i++) {
      const s = c.getSnapshot();
      const orb = s.projectiles.find((p) => p.owner === 'boss');
      const near = orb && Math.hypot(orb.position.x - s.player.position.x, orb.position.z - s.player.position.z) < 2.2;
      c.update(DT, I(near && !parried ? { parry: true } : {}));
      if (near) parried = true;
      hit = c.drainEvents().find((e) => e.type === 'boss_hit') || null;
    }
    assert(hit, `${level}: отражённая сфера не попала`);
    reflected[level] = hit.data.amount;
  }
  assert(reflected.easy === reflected.normal && reflected.normal >= 30, JSON.stringify(reflected));
});

test('config.js: множители «Лёгкой» из раздела combat; уровень по умолчанию в настройках — easy', () => {
  assert(gameConfig.defaultSettings.difficulty === 'easy', 'первый бой — «Лёгкая»');
  const c = createCombat({ config: gameConfig, bossBrain: createBossBrain({ seed: 2 }) });
  assert(c.getDifficulty().level === 'normal', 'config.js сам уровень не задаёт (его выбирает игрок)');
  assert(c.setDifficulty('easy').bossMaxHp === Math.round(1000 * gameConfig.combat.difficulty.easy.bossHp), 'множитель HP из config.js');
});

test('бот-новичок 10 Гц: на «Лёгкой» побеждает почти всегда, на «Обычной» — заметно реже', () => {
  const e = summary('easy', PROFILES.novice10), n = summary('normal', PROFILES.novice10);
  FACTS.novice10 = { easy: e, normal: n };
  assert(e.wins >= 17, `easy: побед ${e.wins}/${e.of}`);
  assert(n.wins < e.wins, `normal (${n.wins}) должна быть труднее easy (${e.wins})`);
});

test('бот-новичок 8 Гц и уверенный игрок: «Лёгкая» не хуже «Обычной»', () => {
  const e8 = summary('easy', PROFILES.novice8), n8 = summary('normal', PROFILES.novice8);
  const ec = summary('easy', PROFILES.confident), nc = summary('normal', PROFILES.confident);
  FACTS.novice8 = { easy: e8, normal: n8 };
  FACTS.confident = { easy: ec, normal: nc };
  assert(e8.wins >= n8.wins + 5, `8 Гц: easy ${e8.wins} vs normal ${n8.wins}`);
  assert(ec.wins === ec.of, `уверенный на easy: ${ec.wins}/${ec.of}`);
});

let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  const s = Date.now();
  try { t.fn(); console.log(`PASS  ${t.name}  (${Date.now() - s} ms)`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed, ${Date.now() - t0} ms`);
console.log('FACTS', JSON.stringify(FACTS, null, 1));
if (failed && typeof process !== 'undefined') process.exitCode = 1;
