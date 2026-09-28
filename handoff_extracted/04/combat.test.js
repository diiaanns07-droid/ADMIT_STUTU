// =============================================================================
// combat.test.js — проверки combat.js (ASHEN_V1, роль No4). Без фреймворков.
// Node 22+:   node combat.test.js
// Браузер:    import('./combat.test.js').then(m => console.table(m.runCombatTests().results))
//
// ВНИМАНИЕ: все bossBrain ниже — ТЕСТОВЫЕ ЗАГЛУШКИ No4 с предсказуемым
// поведением. Это НЕ реализация No5 и не предложение по дизайну босса.
// =============================================================================
import { createCombat, sweptCylinderHit, DEFAULT_COMBAT_CONFIG, COMBAT_API_VERSION } from './combat.js';

// ------------------------------------------------------------ тестовые мозги
function createIdleTestBrain_NOT_No5() {
  const b = { resets: 0, calls: 0 };
  b.reset = () => { b.resets++; };
  b.update = () => { b.calls++; return { stage: 1, action: 'idle', attacks: [] }; };
  return b;
}

// Выдаёт заранее заданные AttackSpec в указанные моменты собственного времени.
function createScriptTestBrain_NOT_No5(entries, opts = {}) {
  const b = { resets: 0, calls: 0, t: 0, done: new Set() };
  b.reset = () => { b.resets++; b.t = 0; b.done = new Set(); };
  b.update = (dt, snap) => {
    b.calls++;
    b.t += dt;
    const attacks = [];
    entries.forEach((e, i) => {
      if (!b.done.has(i) && b.t + 1e-9 >= e.at) {
        b.done.add(i);
        attacks.push(typeof e.spec === 'function' ? e.spec(snap) : { ...e.spec });
      }
    });
    return { stage: opts.stage || 1, action: attacks.length || snap.telegraphs.length ? 'windup' : 'idle', attacks };
  };
  return b;
}

// Нарушает протокол: присылает ОДИН И ТОТ ЖЕ spec каждый шаг.
function createRepeatTestBrain_NOT_No5(spec) {
  const b = { resets: 0, calls: 0 };
  b.reset = () => { b.resets++; };
  b.update = () => { b.calls++; return { stage: 1, action: 'windup', attacks: [{ ...spec }] }; };
  return b;
}

// Представительный цикл slam → orb → nova → orb, быстрее во 2-й стадии.
// Нужен только для проверок «можно выиграть / можно проиграть».
function createLoopTestBrain_NOT_No5() {
  const b = { resets: 0, calls: 0 };
  let time = 0, next = 1.5, seq = 0, i = 0;
  b.reset = () => { b.resets++; time = 0; next = 1.5; seq = 0; i = 0; };
  b.update = (dt, snap) => {
    b.calls++;
    time += dt;
    const stage = snap.boss.hp <= snap.boss.maxHp * 0.5 ? 2 : 1;
    const attacks = [];
    if (time >= next) {
      const kind = ['slam', 'orb', 'nova', 'orb'][i++ % 4];
      const f = stage === 2 ? 0.8 : 1;
      const pp = snap.player.position;
      const id = `test-loop-${++seq}`;
      if (kind === 'slam') attacks.push({ id, kind, origin: { x: 0, y: 0, z: 0 }, target: { x: pp.x, y: 0, z: pp.z }, windup: 1.1 * f, radius: 2.2, damage: 22, blockable: false, projectileSpeed: 0 });
      if (kind === 'orb') attacks.push({ id, kind, origin: { x: 0, y: 2.8, z: 0 }, target: { x: pp.x, y: 1.0, z: pp.z }, windup: 0.8 * f, radius: 0.55, damage: 14, blockable: true, projectileSpeed: 12 });
      if (kind === 'nova') attacks.push({ id, kind, origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 1.5 * f, radius: 8.5, damage: 20, blockable: true, projectileSpeed: 0 });
      next = time + (stage === 2 ? 1.9 : 2.6);
    }
    return { stage, action: attacks.length || snap.telegraphs.length ? 'windup' : 'idle', attacks };
  };
  return b;
}

// Стресс: новая атака почти каждый шаг (детерминированный ГПСЧ).
function createSpamTestBrain_NOT_No5() {
  const b = { resets: 0, calls: 0, enabled: true };
  let seed = 12345, seq = 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  b.reset = () => { b.resets++; seed = 12345; seq = 0; };
  b.update = (dt, snap) => {
    b.calls++;
    if (!b.enabled) return { stage: 1, action: 'idle', attacks: [] };
    const kind = ['slam', 'orb', 'nova'][Math.floor(rnd() * 3)];
    const pp = snap.player.position;
    return {
      stage: 1, action: 'windup', attacks: [{
        id: `spam-${++seq}`, kind, origin: { x: 0, y: 2.5, z: 0 },
        target: { x: pp.x + (rnd() - 0.5) * 4, y: 1, z: pp.z + (rnd() - 0.5) * 4 },
        windup: 0.4 + rnd() * 2, radius: kind === 'orb' ? 0.5 : 1 + rnd() * 3, damage: 5,
        blockable: rnd() > 0.5, projectileSpeed: 5 + rnd() * 30,
      }],
    };
  };
  return b;
}

function createThrowTestBrain_NOT_No5() {
  return { reset() {}, update() { throw new Error('тестовое исключение мозга'); } };
}

// ------------------------------------------------------------ вспомогательное
const H = DEFAULT_COMBAT_CONFIG.sim.fixedStep;
const I = (o = {}) => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, dash: 0, attack: false, shield: false, burst: false, ...o });
const INVALID = () => ({ source: 'none', valid: false, calibrated: false, tMs: 0, moveX: 0.9, dash: 1, attack: true, shield: true, burst: true });
const QUIET = { log: [] };
const origError = console.error;

function runFor(c, seconds, fps, inputFn = () => I(), onFrame) {
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  const events = [];
  let t = 0;
  for (let f = 0; f < frames; f++) {
    const snap = c.getSnapshot();
    const inp = inputFn(t, t + dt, snap);
    c.update(dt, inp);
    t += dt;
    const ev = c.drainEvents();
    for (const e of ev) events.push(e);
    if (onFrame) onFrame(c, ev, t);
  }
  return events;
}
const count = (events, type, pred) => events.filter(e => e.type === type && (!pred || pred(e))).length;
const crossed = (t0, t1, at) => t0 <= at + 1e-9 && t1 > at + 1e-9;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (±${tol})`); }

function allFinite(obj, path = 'snap') {
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) throw new Error(`не конечное число в ${path}`); return; }
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) allFinite(obj[k], `${path}.${k}`);
}
function checkInvariants(c) {
  const s = c.getSnapshot();
  const cfg = c.getConfig();
  allFinite(s);
  assert(s.player.hp >= 0 && s.player.hp <= s.player.maxHp, 'hp героя вне диапазона');
  assert(s.boss.hp >= 0 && s.boss.hp <= s.boss.maxHp, 'hp босса вне диапазона');
  assert(s.player.energy >= 0 && s.player.energy <= s.player.maxEnergy + 1e-9, 'энергия вне диапазона');
  assert(s.cooldowns.dashRemaining >= 0 && s.cooldowns.dashRemaining <= s.cooldowns.dashTotal + 1e-9, 'dash cooldown вне диапазона');
  assert(s.cooldowns.burstRemaining >= 0 && s.cooldowns.burstRemaining <= s.cooldowns.burstTotal + 1e-9, 'burst cooldown вне диапазона');
  assert(s.projectiles.length <= cfg.sim.maxProjectiles, 'слишком много снарядов');
  assert(s.telegraphs.length <= cfg.sim.maxTelegraphs, 'слишком много телеграфов');
  const d = Math.hypot(s.player.position.x - s.boss.position.x, s.player.position.z - s.boss.position.z);
  near(d, cfg.player.orbitRadius, 1e-6, 'дистанция до босса');
  for (const t of s.telegraphs) assert(t.remaining <= t.duration + 1e-9 && t.remaining >= 0, 'remaining телеграфа');
  return s;
}
function angleOf(s) { return s.player.orbitAngle; }

// Тестовый «разумный игрок» для проверки выигрываемости. Не часть игры.
function makeCompetentBot(lead = 0) { // lead — насколько раньше бот реагирует (упреждение)
  const dashed = new Set();
  return (t0, t1, snap) => {
    if (snap.status !== 'playing') return I();
    const p = snap.player, pp = p.position, a = p.orbitAngle;
    const right = { x: Math.cos(a), z: -Math.sin(a) };
    let shield = false, moveX = 0, dash = 0;
    for (const t of snap.telegraphs) {
      if (t.kind === 'slam') {
        const dx = pp.x - t.center.x, dz = pp.z - t.center.z;
        const d = Math.hypot(dx, dz);
        if (d <= t.radius + 0.6) {
          const dir = dx * right.x + dz * right.z >= 0 ? 1 : -1;
          moveX = dir;
          const need = (t.radius + 0.3 - d) / 4.0;
          if (!dashed.has(t.id) && t.remaining < need + 0.2 + lead && p.energy >= 20 && snap.cooldowns.dashRemaining === 0) {
            dash = dir; dashed.add(t.id);
          }
        }
      } else if (t.blockable && t.remaining < 0.3 + lead) shield = true;
    }
    for (const pr of snap.projectiles) {
      if (pr.owner === 'boss' && Math.hypot(pr.position.x - pp.x, pr.position.z - pp.z) < 4 + lead * 12) shield = true;
    }
    const burst = snap.cooldowns.burstRemaining === 0 && p.energy >= 70;
    return I({ moveX, dash, attack: !shield, shield, burst });
  };
}

// Тот же бот, но видит мир с задержкой (имитация задержки CV/реакции).
function makeLaggyBot(lagSec, fps, anticipate) {
  const inner = makeCompetentBot(anticipate ? lagSec : 0);
  const buf = [];
  const lagFrames = Math.round(lagSec * fps);
  return (t0, t1, snap) => {
    buf.push(snap);
    const old = buf.length > lagFrames ? buf.shift() : buf[0];
    if (snap.status !== 'playing') return I();
    return inner(t0, t1, old);
  };
}

// ------------------------------------------------------------ тесты
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const facts = {}; // фактические измерения для отчёта

test('api: версия и экспорт', () => {
  assert(COMBAT_API_VERSION === 'ASHEN_V1', 'версия');
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  for (const k of ['reset', 'update', 'getSnapshot', 'drainEvents']) assert(typeof c[k] === 'function', k);
  let threw = false;
  try { createCombat({ config: {} }); } catch { threw = true; }
  assert(threw, 'без bossBrain должен быть TypeError');
  const s = c.getSnapshot();
  near(s.player.position.z, 6, 1e-9, 'старт z');
  near(s.player.yaw, Math.PI, 1e-9, 'yaw героя к боссу');
  assert(s.status === 'playing' && s.boss.stage === 1, 'старт');
});

test('нейтральный ввод: стоим, ничего не тратим; после стрейфа остановка без «льда»', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev = runFor(c, 3, 60, () => I(), checkInvariants);
  const s = c.getSnapshot();
  near(s.player.position.x, 0, 1e-12, 'x'); near(s.player.position.z, 6, 1e-12, 'z');
  assert(s.player.action === 'idle', 'action idle');
  assert(s.player.energy === 100, 'энергия полна');
  assert(ev.length === 0, `событий быть не должно, есть ${ev.length}`);
  runFor(c, 1, 60, () => I({ moveX: 1 }));
  runFor(c, 0.3, 60, () => I());
  const a1 = angleOf(c.getSnapshot());
  assert(Math.abs(c.getSnapshot().player.lateral) === 0, 'скорость обнулена через 0.3 с');
  runFor(c, 1, 60, () => I());
  near(angleOf(c.getSnapshot()), a1, 1e-12, 'после остановки не дрейфуем');
  // малый шум ниже мёртвой зоны не двигает
  const a2 = angleOf(c.getSnapshot());
  runFor(c, 2, 60, (t) => I({ moveX: 0.05 * Math.sin(t * 30) }));
  near(angleOf(c.getSnapshot()), a2, 1e-12, 'шум в мёртвой зоне');
});

test('непрерывный стрейф: дуга, постоянная дистанция, +moveX = вправо на экране, yaw к боссу', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const s0 = c.getSnapshot();
  runFor(c, 0.1, 60, () => I({ moveX: 1 }));
  const s1 = c.getSnapshot();
  // камера за героем смотрит на босса: экранно-правый вектор при angle=0 = +X
  assert(s1.player.position.x > s0.player.position.x, '+moveX двигает вправо на экране');
  runFor(c, 1.9, 60, () => I({ moveX: 1 }), (cc) => {
    const s = checkInvariants(cc);
    const dx = s.boss.position.x - s.player.position.x, dz = s.boss.position.z - s.player.position.z;
    const l = Math.hypot(dx, dz);
    const dot = Math.sin(s.player.yaw) * dx / l + Math.cos(s.player.yaw) * dz / l;
    assert(dot > 0.999999, 'yaw смотрит на босса');
  });
  const arc = angleOf(c.getSnapshot()) * 6;
  facts.strafeArc2s = +arc.toFixed(3);
  near(arc, 4 * 2 - 4 * 0.08, 0.1, 'длина дуги за 2 с');
  assert(c.getSnapshot().player.action === 'move', 'action move');
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c2, 2, 60, () => I({ moveX: -1 }));
  near(angleOf(c2.getSnapshot()), -angleOf(c.getSnapshot()), 1e-9, 'симметрия влево');
  const c3 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c3, 2, 60, () => I({ moveX: 0.53 }));
  const ratio = angleOf(c3.getSnapshot()) / angleOf(c.getSnapshot());
  near(ratio, 0.5, 0.02, 'аналоговая скорость');
  const c4 = createCombat({ config: { player: { moveSign: -1 } }, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c4, 0.5, 60, () => I({ moveX: 1 }));
  assert(c4.getSnapshot().player.position.x < 0, 'moveSign=-1 инвертирует для зеркальной камеры');
});

test('один dash: одно смещение ~3.2 м, стоимость, конечные i-frames', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  let invulAt = {};
  const ev = runFor(c, 1.5, 60, (t0) => I({ dash: t0 === 0 ? 1 : 0 }), (cc, e, t) => {
    const s = cc.getSnapshot();
    if (Math.abs(t - 0.1) < 0.009) invulAt.early = s.player.invulnerable;
    if (Math.abs(t - 0.4) < 0.009) invulAt.late = s.player.invulnerable;
    if (Math.abs(t - 0.1) < 0.009) invulAt.action = s.player.action;
  });
  assert(count(ev, 'player_dash') === 1, 'ровно один рывок');
  assert(count(ev, 'ability_denied') === 0, 'отказов нет');
  const s = c.getSnapshot();
  near(angleOf(s) * 6, 3.2, 1e-6, 'длина рывка по дуге');
  assert(invulAt.early === true && invulAt.late === false, 'окно неуязвимости конечно');
  assert(invulAt.action === 'dash', 'action dash');
  const e = ev.find(x => x.type === 'player_dash');
  assert(e.data.direction === 1 && e.data.worldDirection.x > 0.99, 'направление рывка вправо');
  // импульс в кадре, где не прошёл ни один фиксированный шаг (144 Гц), не теряется и не дублируется
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  c2.update(0.004, I({ dash: -1 }));
  c2.update(0.004, I());
  c2.update(0.5, I());
  const ev2 = c2.drainEvents();
  assert(count(ev2, 'player_dash') === 1, 'импульс при dt<шага исполнен один раз');
  assert(angleOf(c2.getSnapshot()) < 0, 'рывок влево');
});

test('залипший dash=1 каждый кадр не даёт вечной неуязвимости и бесконечных рывков', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  let invFrames = 0, frames = 0;
  const ev = runFor(c, 6, 60, () => I({ dash: 1 }), (cc) => { frames++; if (cc.getSnapshot().player.invulnerable) invFrames++; });
  const dashes = count(ev, 'player_dash');
  facts.stuckDash6s = { dashes, invulnerableShare: +(invFrames / frames).toFixed(3) };
  assert(dashes <= Math.ceil(6 / 0.9) + 1, `слишком много рывков: ${dashes}`);
  assert(invFrames / frames <= 0.3 / 0.9 + 0.02, 'доля неуязвимости ограничена i-frames/cooldown');
});

test('cooldown: рывок и burst отклоняются до окончания, не уходят в минус', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev = runFor(c, 1.5, 60, (t0, t1) => I({ dash: t0 === 0 || crossed(t0, t1, 0.5) || crossed(t0, t1, 1.0) ? 1 : 0 }), checkInvariants);
  assert(count(ev, 'player_dash') === 2, 'рывки в 0 и 1.0');
  assert(count(ev, 'ability_denied', e => e.data.ability === 'dash' && e.data.reason === 'cooldown') === 1, 'отказ в 0.5');
  runFor(c, 3, 60);
  assert(c.getSnapshot().cooldowns.dashRemaining === 0, 'cooldown ровно 0');
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev2 = runFor(c2, 13, 60, (t0, t1) => I({ burst: t0 === 0 || crossed(t0, t1, 5) || crossed(t0, t1, 12.1) }), checkInvariants);
  assert(count(ev2, 'burst') === 2, 'burst в 0 и 12.1');
  assert(count(ev2, 'ability_denied', e => e.data.ability === 'burst' && e.data.reason === 'cooldown') === 1, 'отказ burst в 5 с');
  assert(c2.getSnapshot().cooldowns.burstRemaining >= 0, 'burst cooldown ≥ 0');
});

const orbAtPlayer = (at, extra = {}) => ({ at, spec: (snap) => ({
  id: `orb-${at}`, kind: 'orb', origin: { x: 0, y: 2.5, z: 0 },
  target: { x: snap.player.position.x, y: 1, z: snap.player.position.z },
  windup: 0.6, radius: 0.5, damage: 14, blockable: true, projectileSpeed: 12, ...extra }) });

test('orb: телеграф → настоящий снаряд → одно попадание', () => {
  const brain = createScriptTestBrain_NOT_No5([orbAtPlayer(0.1)]);
  const c = createCombat({ config: {}, bossBrain: brain });
  let telSeen = null, projSeen = null;
  const ev = runFor(c, 2.5, 60, () => I(), (cc) => {
    const s = checkInvariants(cc);
    if (s.telegraphs.length && !telSeen) telSeen = s.telegraphs[0];
    if (s.projectiles.length && !projSeen) projSeen = s.projectiles[0];
  });
  assert(telSeen && telSeen.kind === 'orb' && telSeen.radius === 0.5 && telSeen.blockable, 'телеграф орба');
  assert(projSeen && projSeen.owner === 'boss' && projSeen.kind === 'orb' && projSeen.radius === 0.5, 'снаряд орба');
  assert(count(ev, 'boss_windup') === 1 && count(ev, 'boss_projectile') === 1, 'подготовка и вылет');
  assert(count(ev, 'player_hit') === 1, 'одно попадание');
  assert(count(ev, 'projectile_impact', e => e.data.result === 'hit') === 1, 'impact');
  const s = c.getSnapshot();
  assert(s.player.hp === 86 && s.stats.damageTaken === 14, 'урон 14');
  assert(s.projectiles.length === 0, 'орб удалён');
  const hitEv = ev.find(e => e.type === 'player_hit');
  assert(hitEv.data.attackKind === 'orb' && hitEv.data.direction.z > 0.9, 'направление удара от босса');
});

test('orb: быстрый снаряд при грубом шаге не пролетает сквозь героя (swept)', () => {
  const brain = createScriptTestBrain_NOT_No5([orbAtPlayer(0.1, { radius: 0.2, projectileSpeed: 40 })]);
  const c = createCombat({ config: { sim: { fixedStep: 1 / 20 } }, bossBrain: brain });
  const ev = runFor(c, 2, 20);
  assert(count(ev, 'player_hit') === 1, 'попадание при шаге 2 м > суммы радиусов 0.65 м');
  // чистая функция
  const a0 = { x: -5, y: 1, z: 0 }, a1 = { x: 5, y: 1, z: 0 }, b = { x: 0, y: 0, z: 0 };
  assert(sweptCylinderHit(a0, a1, b, b, 0.5, 0, 2).hit, 'пересечение пути');
  assert(!sweptCylinderHit({ x: -5, y: 1, z: 1 }, { x: 5, y: 1, z: 1 }, b, b, 0.5, 0, 2).hit, 'мимо');
  assert(!sweptCylinderHit({ x: -5, y: 3, z: 0 }, { x: 5, y: 3, z: 0 }, b, b, 0.5, 0, 2).hit, 'выше цели');
  near(sweptCylinderHit(a0, a1, b, b, 0.5, 0, 2).t, 0.45, 1e-9, 'момент касания');
  // движущаяся цель уходит с пути — относительное движение
  assert(!sweptCylinderHit({ x: 0, y: 1, z: -1 }, { x: 0, y: 1, z: 1 }, { x: -3, y: 0, z: 0 }, { x: -3, y: 0, z: 0 }, 0.5, 0, 2).hit, 'цель далеко');
  assert(sweptCylinderHit({ x: 0, y: 1, z: -1 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: -2 }, 0.5, 0, 2).hit, 'встречное движение');
});

test('orb: стрейф с линии огня = промах, орб исчезает', () => {
  const brain = createScriptTestBrain_NOT_No5([orbAtPlayer(0.1)]);
  const c = createCombat({ config: {}, bossBrain: brain });
  const ev = runFor(c, 3, 60, () => I({ moveX: 1 }));
  assert(count(ev, 'player_hit') === 0, 'промах');
  assert(c.getSnapshot().projectiles.length === 0 && c.getSnapshot().player.hp === 100, 'снаряд удалён, hp цел');
});

test('щит: блок blockable, пробитие unblockable, подавление огня', () => {
  const brain = createScriptTestBrain_NOT_No5([
    orbAtPlayer(0.1),
    { at: 2.0, spec: (s) => ({ id: 'slam-1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { ...s.player.position }, windup: 0.6, radius: 2, damage: 20, blockable: false, projectileSpeed: 0 }) },
  ]);
  const c = createCombat({ config: {}, bossBrain: brain });
  const ev = runFor(c, 3.2, 60, (t0) => I({ shield: t0 >= 0.3, attack: true }), checkInvariants);
  assert(count(ev, 'shield_start') === 1, 'щит включён один раз');
  assert(count(ev, 'block') === 1, 'орб заблокирован');
  assert(count(ev, 'projectile_impact', e => e.data.result === 'block') === 1, 'impact block');
  const hits = ev.filter(e => e.type === 'player_hit');
  assert(hits.length === 1 && hits[0].data.shieldPierced === true && hits[0].data.attackKind === 'slam', 'slam пробил щит');
  assert(c.getSnapshot().player.hp === 80, 'hp 80');
  const firstShieldT = 0.3;
  const castsDuringShield = ev.filter(e => e.type === 'player_cast').length;
  // до щита успели 0.3 с огня → 1..2 выстрела; во время щита — ни одного
  assert(castsDuringShield <= 2, `огонь во время щита подавлен (выстрелов: ${castsDuringShield})`);
  assert(c.getSnapshot().stats.blocks === 1, 'stats.blocks');
  void firstShieldT;
});

test('исчерпание энергии: щит гаснет, не перезапускается без отпускания, рывок отклоняется', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  let depletedAt = -1, zeroEnergy = false, deniedDash = 0, deniedBurst = 0, askedAt = -1;
  const ev = runFor(c, 6, 60, (t0) => {
    // сразу после истощения (в пределах паузы регена) пробуем рывок и burst
    const ask = depletedAt > 0 && askedAt < 0;
    if (ask) askedAt = t0;
    return I({ shield: true, dash: ask ? 1 : 0, burst: ask });
  }, (cc, e, t) => {
    if (depletedAt < 0 && e.some(x => x.type === 'shield_end' && x.data.reason === 'depleted')) {
      depletedAt = t; zeroEnergy = cc.getSnapshot().player.energy === 0;
    }
    deniedDash += count(e, 'ability_denied', x => x.data.ability === 'dash' && x.data.reason === 'energy');
    deniedBurst += count(e, 'ability_denied', x => x.data.ability === 'burst' && x.data.reason === 'energy');
  });
  facts.shieldDepletedAt = +depletedAt.toFixed(3);
  near(depletedAt, 4.0, 0.03, 'щит на 100 энергии ~4 с');
  assert(zeroEnergy, 'энергия 0');
  assert(deniedDash === 1 && deniedBurst === 1, 'рывок и burst без энергии отклонены');
  assert(count(ev, 'shield_start') === 1, 'повторного старта при удержании нет');
  assert(!c.getSnapshot().player.shielding, 'щит выключен');
  assert(c.getSnapshot().player.energy > 20, 'при удержании после истощения энергия восстанавливается');
  const ev3 = runFor(c, 0.2, 60, (t0) => I({ shield: t0 > 0.05 }));
  assert(count(ev3, 'shield_start') === 1, 'после отпускания щит снова доступен');
});

test('burst: одно событие, урон, cooldown, рассеивание орбов', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev = runFor(c, 0.5, 60, (t0) => I({ burst: t0 < 0.05 }));
  assert(count(ev, 'burst') === 1, 'один burst на серию импульсов');
  assert(count(ev, 'boss_hit', e => e.data.source === 'burst' && e.data.amount === 80) === 1, 'урон 80');
  const s = c.getSnapshot();
  assert(s.boss.hp === 920 && s.cooldowns.burstRemaining > 11 && s.player.energy < 61, 'hp/cd/энергия');
  const brain = createScriptTestBrain_NOT_No5([orbAtPlayer(0.1, { projectileSpeed: 6 })]);
  const c2 = createCombat({ config: {}, bossBrain: brain });
  let fired = false;
  const ev2 = runFor(c2, 2.5, 60, (t0, t1, snap) => {
    const orb = snap.projectiles.find(p => p.owner === 'boss');
    if (!fired && orb && Math.hypot(orb.position.x - snap.player.position.x, orb.position.z - snap.player.position.z) < 3) { fired = true; return I({ burst: true }); }
    return I();
  });
  assert(count(ev2, 'projectile_impact', e => e.data.result === 'dispelled') === 1, 'орб рассеян');
  assert(count(ev2, 'player_hit') === 0, 'урона нет');
});

test('nova: щит блокирует; рывок в нужный момент даёт dodge; попадание по радиусу', () => {
  const nova = (at, id) => ({ at, spec: { id, kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 1.0, radius: 8, damage: 20, blockable: true, projectileSpeed: 0 } });
  const c = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([nova(0.1, 'n1')]) });
  const ev = runFor(c, 2, 60, (t0, t1) => I({ dash: crossed(t0, t1, 0.95) ? 1 : 0 }));
  assert(count(ev, 'dodge') === 1 && count(ev, 'player_hit') === 0, 'dodge рывком');
  assert(c.getSnapshot().stats.dodges === 1, 'stats.dodges');
  const c2 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([nova(0.1, 'n2')]) });
  const ev2 = runFor(c2, 2, 60, (t0, t1) => I({ dash: crossed(t0, t1, 0.4) ? 1 : 0 }));
  assert(count(ev2, 'dodge') === 0 && count(ev2, 'player_hit') === 1, 'слишком ранний рывок не спасает');
});

test('зона: визуальный радиус = реальная hit-зона (slam и nova, граница ±0.01)', () => {
  const slamAt = (z, id) => ({ at: 0.05, spec: { id, kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z }, windup: 0.5, radius: 2, damage: 10, blockable: false, projectileSpeed: 0 } });
  const cIn = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slamAt(6 - 1.99, 'in')]) });
  let rad = 0;
  const evIn = runFor(cIn, 1, 60, () => I(), (cc) => { const t = cc.getSnapshot().telegraphs[0]; if (t) rad = t.radius; });
  assert(rad === 2, 'радиус телеграфа 2');
  assert(count(evIn, 'player_hit') === 1, 'внутри 1.99 → попадание');
  const cOut = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slamAt(6 - 2.01, 'out')]) });
  const evOut = runFor(cOut, 1, 60);
  assert(count(evOut, 'player_hit') === 0 && count(evOut, 'boss_impact') === 1, 'снаружи 2.01 → промах, но удар был');
  const novaR = (r, id) => ({ at: 0.05, spec: { id, kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 0.5, radius: r, damage: 10, blockable: true, projectileSpeed: 0 } });
  const n1 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([novaR(6.01, 'a')]) });
  const n2 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([novaR(5.99, 'b')]) });
  assert(count(runFor(n1, 1, 60), 'player_hit') === 1, 'nova 6.01 попадает');
  assert(count(runFor(n2, 1, 60), 'player_hit') === 0, 'nova 5.99 не попадает');
});

test('один удар = одно повреждение (стоим в зоне после удара)', () => {
  const brain = createScriptTestBrain_NOT_No5([
    { at: 0.05, spec: (s) => ({ id: 's', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { ...s.player.position }, windup: 0.6, radius: 3, damage: 15, blockable: false, projectileSpeed: 0 }) },
    { at: 2.0, spec: { id: 'n', kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 0.6, radius: 9, damage: 15, blockable: true, projectileSpeed: 0 } },
  ]);
  const c = createCombat({ config: {}, bossBrain: brain });
  const ev = runFor(c, 5, 60);
  assert(count(ev, 'player_hit') === 2, 'ровно два попадания за два удара');
  assert(c.getSnapshot().player.hp === 70, 'hp 70');
});

test('уникальность attack id: один и тот же spec каждый шаг → один телеграф', () => {
  const brain = createRepeatTestBrain_NOT_No5({ id: 'same', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.8, radius: 2, damage: 10, blockable: false, projectileSpeed: 0 });
  const c = createCombat({ config: {}, bossBrain: brain });
  const ev = runFor(c, 3, 60);
  assert(count(ev, 'boss_windup') === 1 && count(ev, 'boss_impact') === 1 && count(ev, 'player_hit') === 1, 'один раз');
  const dbg = c.getDebugInfo();
  facts.duplicateSpecsIgnored3s = dbg.duplicateAttacks;
  assert(dbg.duplicateAttacks > 300, 'дубликаты посчитаны и отброшены');
});

test('победа и поражение: однократный переход, после исхода — тишина', () => {
  // пассивный игрок проигрывает
  const brainA = createLoopTestBrain_NOT_No5();
  const a = createCombat({ config: {}, bossBrain: brainA });
  let tDef = -1;
  const evA = runFor(a, 60, 60, () => I(), (cc, e, t) => { if (tDef < 0 && e.some(x => x.type === 'defeat')) tDef = t; });
  assert(count(evA, 'defeat') === 1 && count(evA, 'victory') === 0, 'одно поражение');
  assert(a.getSnapshot().status === 'defeat' && a.getSnapshot().player.action === 'dead', 'статус');
  const callsAtEnd = brainA.calls;
  const after = runFor(a, 5, 60, () => I({ attack: true, dash: 1, burst: true, shield: true }));
  assert(after.length === 0 && brainA.calls === callsAtEnd, 'после поражения нет событий и атак');
  assert(a.getSnapshot().projectiles.length === 0 && a.getSnapshot().telegraphs.length === 0, 'списки очищены');
  facts.passiveDefeatAt = +tDef.toFixed(2);
  // только огонь без защиты
  const b = createCombat({ config: {}, bossBrain: createLoopTestBrain_NOT_No5() });
  let resB = null;
  runFor(b, 120, 60, () => I({ attack: true }), (cc, e, t) => { if (!resB && cc.getSnapshot().status !== 'playing') resB = { status: cc.getSnapshot().status, t: +t.toFixed(2), bossHp: cc.getSnapshot().boss.hp }; });
  facts.fireOnly = resB;
  // разумный игрок побеждает
  const brainC = createLoopTestBrain_NOT_No5();
  const c = createCombat({ config: {}, bossBrain: brainC });
  let tWin = -1, phaseEvents = 0;
  const evC = runFor(c, 180, 60, makeCompetentBot(), (cc, e, t) => {
    checkInvariants(cc);
    if (tWin < 0 && e.some(x => x.type === 'victory')) tWin = t;
  });
  phaseEvents = count(evC, 'boss_phase');
  const sC = c.getSnapshot();
  assert(count(evC, 'victory') === 1 && count(evC, 'defeat') === 0, `разумный бот должен победить (status=${sC.status})`);
  assert(sC.boss.action === 'dead' && sC.boss.hp === 0, 'босс мёртв');
  assert(phaseEvents === 1 && sC.boss.stage === 2, 'одна смена фазы');
  const last = evC[evC.length - 1];
  assert(last.type === 'victory', 'victory — последнее событие');
  facts.competentBot = { victoryAt: +tWin.toFixed(2), hpLeft: sC.player.hp, blocks: sC.stats.blocks, dodges: sC.stats.dodges, damageTaken: sC.stats.damageTaken };
  // Информативно (не условие прохождения): бот с задержкой реакции.
  facts.laggyBot = {};
  for (const anticipate of [false, true]) {
    for (const lag of [0.15, 0.25, 0.4]) {
      const L = createCombat({ config: {}, bossBrain: createLoopTestBrain_NOT_No5() });
      let tEnd = -1;
      runFor(L, 180, 60, makeLaggyBot(lag, 60, anticipate), (cc, e, t) => { if (tEnd < 0 && cc.getSnapshot().status !== 'playing') tEnd = t; });
      const sL = L.getSnapshot();
      facts.laggyBot[`${anticipate ? 'anticipating' : 'naive'}_lag${lag}`] = { status: sL.status, t: +tEnd.toFixed(2), hpLeft: sL.player.hp, bossHp: sL.boss.hp, damageTaken: sL.stats.damageTaken };
    }
  }
});

test('одновременные летальные удары: игрок разрешается первым, один экран результата', () => {
  const slam = { id: 'lethal', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.5, radius: 2, damage: 30, blockable: false, projectileSpeed: 0 };
  const cfg = { boss: { maxHp: 50 }, player: { maxHp: 10 } };
  const mk = () => createCombat({ config: cfg, bossBrain: createScriptTestBrain_NOT_No5([{ at: 0, spec: slam }]) });
  const c = mk();
  for (let i = 0; i < 59; i++) c.update(H, I());
  assert(c.getSnapshot().telegraphs.length === 1 && c.getSnapshot().status === 'playing', 'удар ещё не наступил');
  c.update(H, I({ burst: true })); // шаг 60: и burst, и slam
  const ev = c.drainEvents();
  assert(count(ev, 'victory') === 1 && count(ev, 'defeat') === 0 && count(ev, 'player_hit') === 0, 'победа, без поражения');
  assert(ev[ev.length - 1].type === 'victory' && c.getSnapshot().player.hp === 10, 'последнее событие victory');
  const c2 = mk();
  for (let i = 0; i < 60; i++) c2.update(H, I());
  const ev2 = c2.drainEvents();
  assert(count(ev2, 'defeat') === 1, 'контроль: без burst — поражение');
  // два смертельных удара босса в одном шаге → одно поражение, один player_hit
  const two = createCombat({ config: cfg, bossBrain: createScriptTestBrain_NOT_No5([{ at: 0, spec: slam }, { at: 0, spec: { ...slam, id: 'lethal2' } }]) });
  for (let i = 0; i < 70; i++) two.update(H, I());
  const ev3 = two.drainEvents();
  assert(count(ev3, 'defeat') === 1 && count(ev3, 'player_hit') === 1, 'один удар засчитан, второй не применяется');
  assert(two.getSnapshot().stats.damageTaken === 10, 'урон ограничен HP');
});

test('reset дважды: всё возвращается, мозг сброшен, id принимаются заново', () => {
  const brain = createLoopTestBrain_NOT_No5();
  const c = createCombat({ config: {}, bossBrain: brain });
  const fresh = JSON.stringify(c.getSnapshot());
  runFor(c, 8, 60, (t) => I({ moveX: 1, attack: true, shield: t > 3 && t < 4, dash: 0, burst: t < 0.02 }));
  assert(c.getSnapshot().projectiles.length + c.getSnapshot().telegraphs.length > 0 || c.getSnapshot().boss.hp < 1000, 'бой шёл');
  runFor(c, 0.1, 60, () => I({ attack: true })); // события не забраны
  const r0 = brain.resets;
  c.reset();
  assert(c.drainEvents().length === 0, 'события очищены');
  assert(JSON.stringify(c.getSnapshot()) === fresh, 'снимок как у нового боя');
  c.reset();
  assert(brain.resets === r0 + 2, 'bossBrain.reset вызван при каждом reset');
  assert(JSON.stringify(c.getSnapshot()) === fresh, 'второй reset идемпотентен');
  const acc0 = c.getDebugInfo().acceptedAttacks;
  assert(acc0 === 0, 'счётчик атак сброшен');
  runFor(c, 3, 60);
  assert(c.getDebugInfo().acceptedAttacks >= 1 && c.getDebugInfo().duplicateAttacks === 0, 'те же id после reset приняты');
  // reset после исхода
  const d = createCombat({ config: { player: { maxHp: 1 } }, bossBrain: createLoopTestBrain_NOT_No5() });
  runFor(d, 10, 60);
  assert(d.getSnapshot().status === 'defeat', 'поражение');
  d.reset();
  assert(d.getSnapshot().status === 'playing' && d.getSnapshot().player.action === 'idle', 'после reset снова бой');
});

test('30 / 60 / 144 FPS дают одинаковый баланс', () => {
  const scenario = () => createScriptTestBrain_NOT_No5([
    orbAtPlayer(1.0),
    { at: 3.0, spec: (s) => ({ id: 'sl', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { ...s.player.position }, windup: 1.0, radius: 2.2, damage: 20, blockable: false, projectileSpeed: 0 }) },
    { at: 6.0, spec: { id: 'nv', kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 1.2, radius: 8, damage: 20, blockable: true, projectileSpeed: 0 } },
    orbAtPlayer(9.0),
  ]);
  const inputs = (t0, t1) => I({
    moveX: Math.sin(t0 * 1.3) * 0.8,
    attack: !(t0 > 6.9 && t0 < 7.5),
    shield: t0 > 6.9 && t0 < 7.5,
    dash: crossed(t0, t1, 3.7) ? -1 : 0,
    burst: crossed(t0, t1, 5.0),
  });
  const res = {};
  for (const fps of [30, 60, 144]) {
    const c = createCombat({ config: {}, bossBrain: scenario() });
    const ev = runFor(c, 12, fps, inputs);
    const s = c.getSnapshot();
    res[fps] = { angle: s.player.orbitAngle, hp: s.player.hp, bossHp: s.boss.hp, energy: s.player.energy, casts: count(ev, 'player_cast'), hits: count(ev, 'player_hit'), blocks: s.stats.blocks };
  }
  facts.fpsScenario12s = Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { ...v, angle: +v.angle.toFixed(4), energy: +v.energy.toFixed(2) }]));
  for (const fps of [30, 144]) {
    near(res[fps].angle, res[60].angle, 0.03, `угол ${fps} vs 60`);
    assert(res[fps].hp === res[60].hp, `hp ${fps} vs 60`);
    near(res[fps].bossHp, res[60].bossHp, 12, `hp босса ${fps} vs 60`);
    near(res[fps].energy, res[60].energy, 3, `энергия ${fps} vs 60`);
    assert(res[fps].blocks === res[60].blocks, 'блоки');
  }
  const wins = {};
  for (const fps of [30, 60, 144]) {
    const c = createCombat({ config: {}, bossBrain: createLoopTestBrain_NOT_No5() });
    let tw = -1;
    runFor(c, 180, fps, makeCompetentBot(), (cc, e, t) => { if (tw < 0 && cc.getSnapshot().status !== 'playing') tw = t; });
    wins[fps] = { status: c.getSnapshot().status, t: +tw.toFixed(2), hp: c.getSnapshot().player.hp };
  }
  facts.competentBotByFps = wins;
  for (const fps of [30, 60, 144]) assert(wins[fps].status === 'victory', `бот побеждает на ${fps} FPS`);
  near(wins[30].t, wins[60].t, 2, 'время победы 30 vs 60');
  near(wins[144].t, wins[60].t, 2, 'время победы 144 vs 60');
});

test('нет бессрочных объектов: стресс 60 с, затем всё истекает; события ограничены', () => {
  const brain = createSpamTestBrain_NOT_No5();
  const c = createCombat({ config: { player: { maxHp: 1e7 }, boss: { maxHp: 1e7 } }, bossBrain: brain });
  let maxP = 0, maxT = 0;
  runFor(c, 60, 60, (t) => I({ attack: true, moveX: Math.sin(t) }), (cc) => {
    const s = checkInvariants(cc);
    maxP = Math.max(maxP, s.projectiles.length); maxT = Math.max(maxT, s.telegraphs.length);
  });
  facts.stress60s = { maxProjectiles: maxP, maxTelegraphs: maxT, accepted: c.getDebugInfo().acceptedAttacks, rejected: c.getDebugInfo().rejectedAttacks };
  brain.enabled = false;
  runFor(c, 8, 60);
  const s = c.getSnapshot();
  assert(s.projectiles.length === 0 && s.telegraphs.length === 0, `остались объекты: ${s.projectiles.length}/${s.telegraphs.length}`);
  // события без drain ограничены
  brain.enabled = true;
  for (let i = 0; i < 2000; i++) c.update(1 / 60, I({ attack: true }));
  const q = c.getDebugInfo().queuedEvents;
  assert(q <= c.getConfig().sim.maxEvents, `очередь событий ${q}`);
  const drained = c.drainEvents();
  assert(new Set(drained.map(e => e.id)).size === drained.length, 'id событий уникальны');
  assert(drained.every(e => e.data && typeof e.data === 'object' && e.position && Number.isFinite(e.position.x)), 'форма события');
});

test('надёжность dt: NaN/отриц./Infinity/строка/огромный скачок', () => {
  const brain = createScriptTestBrain_NOT_No5([0, 1, 2, 3, 4, 5].map(k => ({ at: 0.05 + k * 0.5, spec: { id: `s${k}`, kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.4, radius: 2, damage: 30, blockable: false, projectileSpeed: 0 } })));
  const c = createCombat({ config: {}, bossBrain: brain });
  for (const bad of [NaN, -1, Infinity, -Infinity, 'abc', undefined, null, 0]) c.update(bad, I());
  assert(c.getSnapshot().time === 0, 'некорректный dt не двигает время');
  c.update(1e9, I());
  assert(c.getSnapshot().time <= 0.1 + 1e-9, 'огромный dt обрезан до maxFrameDt');
  c.update(30, I());
  assert(c.getSnapshot().time <= 0.2 + 1e-9, 'второй скачок тоже обрезан');
  assert(c.getSnapshot().player.hp === 100, 'накопленные атаки не убили за один скачок');
  checkInvariants(c);
});

test('невалидный ввод обнуляет управление и не продолжает атаку/щит/импульсы', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev1 = runFor(c, 1, 60, () => I({ attack: true, shield: false }));
  assert(count(ev1, 'player_cast') >= 3, 'огонь при валидном вводе');
  runFor(c, 0.2, 60, () => I({ shield: true }));
  const ev2 = runFor(c, 1, 60, () => INVALID());
  assert(count(ev2, 'player_cast') === 0 && count(ev2, 'player_dash') === 0 && count(ev2, 'burst') === 0, 'ничего не продолжено');
  assert(count(ev2, 'shield_end', e => e.data.reason === 'input_lost') === 1, 'щит снят с причиной input_lost');
  const a = angleOf(c.getSnapshot());
  runFor(c, 1, 60, () => null);
  runFor(c, 1, 60, () => ({ valid: true, source: 'debug', moveX: NaN, dash: 'x', attack: 'yes', shield: 1, burst: 1 }));
  near(angleOf(c.getSnapshot()), a, 1e-12, 'мусорный ввод не двигает');
  assert(c.drainEvents().length === 0, 'и не порождает событий');
});

test('некорректные AttackSpec отклоняются, корректные ограничиваются', () => {
  const brain = createScriptTestBrain_NOT_No5([
    { at: 0, spec: { kind: 'slam', origin: { x: 0, z: 0 }, target: { x: 0, z: 6 }, windup: 1, radius: 2, damage: 10 } },
    { at: 0, spec: { id: 'k', kind: 'laser', origin: { x: 0, z: 0 }, target: { x: 0, z: 6 }, windup: 1, radius: 2, damage: 10 } },
    { at: 0, spec: { id: 'n', kind: 'slam', origin: { x: 0, z: 0 }, target: { x: NaN, z: 6 }, windup: 1, radius: 2, damage: 10 } },
    { at: 0, spec: { id: 'w', kind: 'slam', origin: { x: 0, z: 0 }, target: { x: 0, z: 6 }, windup: 0.01, radius: 99, damage: 1e6, blockable: false } },
  ]);
  const c = createCombat({ config: {}, bossBrain: brain });
  c.update(H, I());
  const s = c.getSnapshot();
  assert(s.telegraphs.length === 1, 'принят один корректный');
  const t = s.telegraphs[0];
  assert(t.duration === 0.35 && t.radius === 12 && t.damage === 60, `ограничения windup/radius/damage (${t.duration}/${t.radius}/${t.damage})`);
  assert(c.getDebugInfo().rejectedAttacks === 3, 'три отклонено');
});

test('снимок только для чтения: мутации потребителей не влияют на бой; сбой мозга не роняет бой', () => {
  const mutBrain = createIdleTestBrain_NOT_No5();
  mutBrain.update = (dt, snap) => { snap.player.hp = -999; snap.player.position.x = 50; snap.projectiles.push({}); return { stage: 1, action: 'idle', attacks: [] }; };
  const c = createCombat({ config: {}, bossBrain: mutBrain });
  runFor(c, 0.5, 60);
  const s = c.getSnapshot();
  s.boss.hp = 0; s.player.position.z = -3; s.telegraphs.push({});
  const s2 = checkInvariants(c);
  assert(s2.player.hp === 100 && s2.boss.hp === 1000 && s2.projectiles.length === 0, 'состояние не испорчено');
  near(s2.player.position.z, 6, 1e-12, 'позиция не испорчена');
  const fz = createCombat({ config: { sim: { freezeSnapshots: true } }, bossBrain: createIdleTestBrain_NOT_No5() });
  assert(Object.isFrozen(fz.getSnapshot().player.position), 'freezeSnapshots=true замораживает');
  console.error = (...a) => QUIET.log.push(a);
  try {
    const t = createCombat({ config: {}, bossBrain: createThrowTestBrain_NOT_No5() });
    runFor(t, 1, 60, () => I({ attack: true }));
    assert(t.getDebugInfo().brainErrors === 120 && t.getSnapshot().status === 'playing', 'ошибки мозга посчитаны, бой идёт');
    assert(QUIET.log.length === 1, 'предупреждение один раз');
  } finally { console.error = origError; }
});

test('краевые пути: рывок во время рывка, стадия только 1→2, реакция босса, вырожденный орб, платный огонь', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  c.update(H, I({ dash: 1 }));
  c.update(H * 3, I({ dash: 1 }));
  const ev = c.drainEvents();
  assert(count(ev, 'ability_denied', e => e.data.reason === 'active') === 1, 'повторный импульс во время рывка отклонён');
  // стадия: 2 → попытка вернуть 1 игнорируется
  let n = 0;
  const stBrain = { reset() { n = 0; }, update() { n++; return { stage: n < 10 ? 1 : n < 20 ? 2 : 1, action: 'dead', attacks: [] }; } };
  const c2 = createCombat({ config: {}, bossBrain: stBrain });
  const ev2 = runFor(c2, 1, 60);
  assert(count(ev2, 'boss_phase') === 1 && c2.getSnapshot().boss.stage === 2, 'стадия монотонна');
  assert(c2.getSnapshot().boss.action === 'idle', "'dead' от мозга при живом боссе игнорируется");
  // реакция босса на burst видна в idle
  const c3 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  c3.update(H, I({ burst: true }));
  assert(c3.getSnapshot().boss.action === 'hit', 'boss action hit после burst');
  // вырожденный орб (target = origin) и origin за ареной не ломают симуляцию
  const c4 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([
    { at: 0, spec: { id: 'deg', kind: 'orb', origin: { x: 0, y: 2, z: 0 }, target: { x: 0, y: 2, z: 0 }, windup: 0.4, radius: 0.5, damage: 5, blockable: true, projectileSpeed: 15 } },
    { at: 0, spec: { id: 'far', kind: 'orb', origin: { x: 50, y: 2, z: 0 }, target: { x: 0, y: 1, z: 6 }, windup: 0.4, radius: 0.5, damage: 5, blockable: true, projectileSpeed: 15 } },
  ]) });
  const ev4 = runFor(c4, 4, 60, () => I(), checkInvariants);
  assert(count(ev4, 'player_hit') >= 1, 'вырожденный орб летит к герою');
  assert(c4.getSnapshot().projectiles.length === 0, 'все орбы истекли');
  // платный огонь (energyCost > 0) расходует энергию и останавливается на нуле
  const c5 = createCombat({ config: { bolt: { energyCost: 10 }, player: { energyRegen: 0 } }, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev5 = runFor(c5, 5, 60, () => I({ attack: true }), checkInvariants);
  assert(count(ev5, 'player_cast') === 10 && c5.getSnapshot().player.energy === 0, 'ровно 10 выстрелов по 10 энергии');
});

// ------------------------------------------------------------ запуск
export function runCombatTests({ verbose = true } = {}) {
  const results = [];
  let failed = 0;
  const t0 = Date.now();
  for (const t of tests) {
    const start = Date.now();
    try { t.fn(); results.push({ name: t.name, ok: true, ms: Date.now() - start }); }
    catch (e) { failed++; results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e && e.message }); }
  }
  if (verbose) {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms} ms)${r.ok ? '' : '\n      → ' + r.error}`);
    console.log(`\n${results.length - failed}/${results.length} passed, ${Date.now() - t0} ms`);
    console.log('FACTS ' + JSON.stringify(facts, null, 1));
  }
  return { passed: results.length - failed, failed, results, facts };
}

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
if (isNode) {
  const r = runCombatTests();
  process.exitCode = r.failed ? 1 : 0;
}
