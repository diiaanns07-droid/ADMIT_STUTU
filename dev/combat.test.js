// =============================================================================
// combat.test.js — проверки combat.js (ASHEN_V2: свободное движение, приёмы двух рук). Без фреймворков.
// Node 22+:   node combat.test.js
// Браузер:    import('./combat.test.js').then(m => console.table(m.runCombatTests().results))
//
// ВНИМАНИЕ: все bossBrain ниже — ТЕСТОВЫЕ ЗАГЛУШКИ No4 с предсказуемым
// поведением. Это НЕ реализация No5 и не предложение по дизайну босса.
// =============================================================================
import { createCombat, sweptCylinderHit, DEFAULT_COMBAT_CONFIG, COMBAT_API_VERSION, DEFAULT_LAYOUT } from '../modules/combat.js';
import { createCameraRig } from '../core/cameraRig.js';
import { config as gameConfig } from '../config.js';

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
  // [ASHEN_V2] свободное движение: дистанция до босса ≥ minBossDistance, герой на плато заглушки (R 45 м)
  const d = Math.hypot(s.player.position.x - s.boss.position.x, s.player.position.z - s.boss.position.z);
  near(d, s.player.orbitRadius, 1e-6, 'дистанция до босса = orbitRadius');
  assert(d >= cfg.player.minBossDistance - 1e-6, `ближе тела Регента: ${d}`);
  assert(Math.hypot(s.player.position.x, s.player.position.z) <= 45 + 1e-6, 'герой ушёл с плато');
  assert(['explore', 'engaged'].includes(s.player.encounter), 'encounter');
  assert(s.cooldowns.throwRemaining >= 0 && s.cooldowns.throwRemaining <= s.cooldowns.throwTotal + 1e-9, 'throw cooldown вне диапазона');
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
  assert(COMBAT_API_VERSION === 'ASHEN_V2', 'версия');
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  for (const k of ['reset', 'update', 'getSnapshot', 'drainEvents']) assert(typeof c[k] === 'function', k);
  let threw = false;
  try { createCombat({ config: {} }); } catch { threw = true; }
  assert(threw, 'без bossBrain должен быть TypeError');
  const s = c.getSnapshot();
  near(s.player.position.z, 6, 1e-9, 'старт z (заглушка раскладки)');
  near(s.player.yaw, Math.PI, 1e-9, 'yaw героя к боссу');
  assert(s.status === 'playing' && s.boss.stage === 1, 'старт');
  assert(s.player.encounter === 'engaged' && s.player.lockedOn === true, 'старт в арене — бой');
  for (const k of ['velocity', 'speed', 'locomotion', 'lockedOn', 'encounter', 'parryWindow', 'dashDir']) assert(k in s.player, 'поле V2 ' + k);
  assert('home' in s.boss, 'boss.home');
});

test('нейтральный ввод: стоим, ничего не тратим; после движения остановка без «льда»', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev = runFor(c, 3, 60, () => I(), checkInvariants);
  const s = c.getSnapshot();
  near(s.player.position.x, 0, 1e-12, 'x'); near(s.player.position.z, 6, 1e-12, 'z');
  assert(s.player.action === 'idle' && s.player.locomotion === 'idle', 'idle');
  assert(s.player.energy === 100, 'энергия полна');
  assert(ev.length === 0, `событий быть не должно, есть ${ev.length}`);
  runFor(c, 1, 60, () => I({ moveX: 1 }));
  runFor(c, 0.5, 60, () => I());
  assert(c.getSnapshot().player.speed === 0, 'скорость обнулена через 0.5 с');
  const p1 = c.getSnapshot().player.position;
  runFor(c, 1, 60, () => I());
  const p2 = c.getSnapshot().player.position;
  near(Math.hypot(p2.x - p1.x, p2.z - p1.z), 0, 1e-12, 'после остановки не дрейфуем');
  runFor(c, 2, 60, (t) => I({ moveX: 0.05 * Math.sin(t * 30) }));
  const p3 = c.getSnapshot().player.position;
  near(Math.hypot(p3.x - p2.x, p3.z - p2.z), 0, 1e-12, 'шум в мёртвой зоне');
});

test('стрейф в lock-on: +moveX = вправо на экране, герой смотрит на Регента, бег ≈ runSpeed×strafeFactor, полстика — шаг', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const s0 = c.getSnapshot();
  runFor(c, 0.1, 60, () => I({ moveX: 1 }));
  assert(c.getSnapshot().player.position.x > s0.player.position.x, '+moveX двигает вправо на экране');
  let maxSpeed = 0;
  runFor(c, 1.9, 60, () => I({ moveX: 1 }), (cc) => {
    const s = checkInvariants(cc);
    const dx = s.boss.position.x - s.player.position.x, dz = s.boss.position.z - s.player.position.z;
    const l = Math.hypot(dx, dz);
    const dot = Math.sin(s.player.yaw) * dx / l + Math.cos(s.player.yaw) * dz / l;
    assert(dot > 0.9999, 'yaw смотрит на босса');
    maxSpeed = Math.max(maxSpeed, s.player.speed);
  });
  const cfg = c.getConfig().player;
  facts.strafeSpeedV2 = +maxSpeed.toFixed(3);
  near(maxSpeed, cfg.runSpeed * cfg.strafeFactor, 0.05, 'скорость бега боком');
  const st = c.getSnapshot().player;
  assert(st.action === 'move' && st.locomotion === 'strafe', `action=${st.action} locomotion=${st.locomotion}`);
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c2, 2, 60, () => I({ moveX: -1 }));
  near(c2.getSnapshot().player.orbitAngle, -c.getSnapshot().player.orbitAngle, 1e-9, 'симметрия влево');
  const c3 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c3, 1, 60, () => I({ moveX: 0.53 }));
  const sp3 = c3.getSnapshot().player.speed;
  assert(sp3 > 0.5 && sp3 <= cfg.walkSpeed + 1e-6, `полстика — шаг: ${sp3}`);
  const c4 = createCombat({ config: { player: { moveSign: -1 } }, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(c4, 0.5, 60, () => I({ moveX: 1 }));
  assert(c4.getSnapshot().player.position.x < 0, 'moveSign=-1 инвертирует для зеркальной камеры');
});

test('один рывок: смещение ≈ dash.distance, стоимость, конечные i-frames; dashDir — в любую сторону', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const cfg = c.getConfig();
  let invulAt = {};
  const p0 = c.getSnapshot().player.position;
  const ev = runFor(c, 1.5, 60, (t0) => I({ dash: t0 === 0 ? 1 : 0 }), (cc, e, t) => {
    const s = cc.getSnapshot();
    if (Math.abs(t - 0.1) < 0.009) { invulAt.early = s.player.invulnerable; invulAt.action = s.player.action; invulAt.dashDir = s.player.dashDir; }
    if (Math.abs(t - 0.4) < 0.009) invulAt.late = s.player.invulnerable;
  });
  assert(count(ev, 'player_dash') === 1, 'ровно один рывок');
  assert(count(ev, 'ability_denied') === 0, 'отказов нет');
  const p1 = c.getSnapshot().player.position;
  near(Math.hypot(p1.x - p0.x, p1.z - p0.z), cfg.dash.distance, 0.06, 'длина рывка');
  assert(invulAt.early === true && invulAt.late === false, 'окно неуязвимости конечно');
  assert(invulAt.action === 'dash' && invulAt.dashDir && invulAt.dashDir.x > 0.99, 'action dash, мировой dashDir');
  const e = ev.find(x => x.type === 'player_dash');
  assert(e.data.direction === 1 && e.data.worldDirection.x > 0.99 && e.data.cameraDirection.x === 1, 'направление рывка вправо');
  // рывок вперёд (к Регенту) и назад — только в V2
  for (const [dz, sign] of [[1, -1], [-1, 1]]) {
    const d = createCombat({ config: { player: { orbitRadius: 9 } }, bossBrain: createIdleTestBrain_NOT_No5() });
    runFor(d, 1, 60, (t0) => I({ dashDir: t0 === 0 ? { x: 0, z: dz } : null }));
    const pz = d.getSnapshot().player.position.z;
    assert(Math.sign(pz - 9) === sign && Math.abs(Math.abs(pz - 9) - cfg.dash.distance) < 0.06, `рывок z=${dz}: ${pz}`);
  }
  // импульс в кадре, где не прошёл ни один фиксированный шаг (144 Гц), не теряется и не дублируется
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  c2.update(0.004, I({ dash: -1 }));
  c2.update(0.004, I());
  c2.update(0.5, I());
  const ev2 = c2.drainEvents();
  assert(count(ev2, 'player_dash') === 1, 'импульс при dt<шага исполнен один раз');
  assert(c2.getSnapshot().player.position.x < 0, 'рывок влево');
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

// ------------------------------------------------------------ глубина (moveZ) и бросок (throw)
const radiusOf = (c) => c.getSnapshot().player.orbitRadius;
const THROW = (o = {}) => ({ kind: 'orb', size: 0.5, power: 1, aimX: 0, ...o });
// экранная X-проекция сдвига героя через настоящий cameraRig (как в tools/qa_node.mjs)
function screenDx(before, after, bossPos) {
  const rig = createCameraRig(gameConfig.camera);
  rig.reset(before, bossPos);
  const cam = rig.update(1 / 60, before, bossPos, null);
  const f = { x: cam.target.x - cam.position.x, z: cam.target.z - cam.position.z };
  const right = { x: -f.z, z: f.x }; // f × up
  return (after.x - before.x) * right.x + (after.z - before.z) * right.z;
}
// Боковое смещение точки p от прямой «a → b» в XZ, со знаком экранно-правого вектора героя.
function lateralOffset(p, a, b, right) {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / (l * l);
  const qx = a.x + dx * t, qz = a.z + dz * t;
  return (p.x - qx) * right.x + (p.z - qz) * right.z;
}

test('moveZ: + к Регенту, − назад; тело Регента не пройти; мёртвая зона; остановка; щит ×0.5; мусор', () => {
  const cfg = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() }).getConfig();
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  let prevR = 6, monotonic = true, radialSeen = 0, action = '';
  runFor(c, 0.5, 60, () => I({ moveZ: 1 }), (cc) => {
    const s = checkInvariants(cc);
    if (s.player.orbitRadius > prevR + 1e-12) monotonic = false;
    prevR = s.player.orbitRadius; radialSeen = s.player.radial; action = s.player.action;
  });
  assert(monotonic, 'дистанция монотонно уменьшается');
  assert(radialSeen > 0.95 && action === 'move', `snapshot.radial=${radialSeen}, action=${action}`);
  near(c.getSnapshot().player.orbitAngle, 0, 1e-9, 'чистое сближение не меняет угол');
  runFor(c, 3, 60, () => I({ moveZ: 1 }), checkInvariants);
  near(radiusOf(c), cfg.player.minBossDistance, 1e-6, 'упёрлись в тело Регента');
  runFor(c, 0.5, 60, () => I({ moveZ: -1 }));
  assert(c.getSnapshot().player.locomotion === 'back', 'пятимся: locomotion back');
  runFor(c, 0.6, 60, () => I());
  const rStop = radiusOf(c);
  runFor(c, 1, 60, () => I());
  near(radiusOf(c), rStop, 1e-12, 'после остановки не дрейфуем');
  runFor(c, 2, 60, (t) => I({ moveZ: 0.05 * Math.sin(t * 30) }));
  near(radiusOf(c), rStop, 1e-12, 'шум moveZ в мёртвой зоне');
  const a = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const b = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(a, 0.5, 60, () => I({ moveX: 1 }));
  runFor(b, 0.5, 60, () => I({ moveX: 1, shield: true }));
  near(b.getSnapshot().player.speed / a.getSnapshot().player.speed, cfg.shield.moveSpeedFactor, 0.02, 'щит замедляет');
  const g = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(g, 0.5, 60, () => I({ moveZ: NaN }));
  runFor(g, 0.5, 60, () => I({ moveZ: 'far' }));
  near(radiusOf(g), 6, 1e-12, 'NaN/строка в moveZ');
  const h1 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const h2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(h1, 0.5, 60, () => I({ moveX: 7, moveZ: 7 }));
  runFor(h2, 0.5, 60, () => I({ moveX: 0.7071, moveZ: 0.7071 }));
  near(h1.getSnapshot().player.speed, h2.getSnapshot().player.speed, 1e-3, 'вектор больше 1 ограничен длиной 1 (диагональ не быстрее)');
});

test('экранное направление: +moveX вправо на экране (cameraRig) на дистанциях 3.8 / 6 / 9; вместе с moveZ', () => {
  const detail = [];
  for (const r0 of [3.8, 6, 9]) {
    for (const startMoves of [0, 55, 140]) {
      for (const dir of [1, -1]) {
        const c = createCombat({ config: { player: { orbitRadius: r0 } }, bossBrain: createIdleTestBrain_NOT_No5() });
        near(c.getSnapshot().player.orbitRadius, r0, 1e-9, 'стартовая дистанция из конфига');
        runFor(c, startMoves / 60, 60, () => I({ moveX: 1 }));
        const s0 = c.getSnapshot();
        runFor(c, 20 / 60, 60, () => I({ moveX: dir }));
        const s1 = c.getSnapshot();
        const dx = screenDx(s0.player.position, s1.player.position, s0.boss.position);
        detail.push(`r${r0}#${startMoves}:${dir}→${dx.toFixed(3)}`);
        assert(Math.sign(dx) === dir, `экранное направление неверно: ${detail[detail.length - 1]}`);
      }
    }
  }
  for (const mz of [1, -1]) {
    const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
    runFor(c, 0.3, 60, () => I({ moveZ: mz }));
    for (let k = 0; k < 8; k++) {
      const s0 = c.getSnapshot();
      runFor(c, 0.15, 60, () => I({ moveX: 1, moveZ: mz }), checkInvariants);
      const dx = screenDx(s0.player.position, c.getSnapshot().player.position, s0.boss.position);
      assert(dx > 0, `moveX=1, moveZ=${mz}, шаг ${k}: экранный сдвиг ${dx}`);
    }
  }
  facts.screenRightByRadius = detail.length;
});

test('[V2] оси камеры: стик поворачивается на viewYaw в 8 направлениях', () => {
  for (const vy of [0, Math.PI / 3, Math.PI, -2.2]) {
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2;
      const mx = Math.cos(a), mz = Math.sin(a);
      const c = createCombat({ config: { encounter: { enabled: false } }, bossBrain: createIdleTestBrain_NOT_No5() });
      const p0 = c.getSnapshot().player.position;
      runFor(c, 0.4, 60, () => I({ moveX: mx, moveZ: mz, viewYaw: vy }));
      const p1 = c.getSnapshot().player.position;
      // ожидание: вперёд = (sin vy, cos vy), вправо на экране = (−cos vy, sin vy)
      const wx = mx * -Math.cos(vy) + mz * Math.sin(vy), wz = mx * Math.sin(vy) + mz * Math.cos(vy);
      const gx = p1.x - p0.x, gz = p1.z - p0.z, gl = Math.hypot(gx, gz);
      assert(gl > 0.5, 'сдвинулись');
      const cos = (gx * wx + gz * wz) / gl;
      assert(cos > 0.97, `viewYaw=${vy.toFixed(2)} сектор ${k}: cos=${cos.toFixed(3)}`);
    }
  }
});

test('[V2] коллизии: колонна не проходима, скольжение вдоль, рывок не проскакивает; край плато', () => {
  const col = DEFAULT_LAYOUT.colliders.find((q) => Math.abs(q.x) < 1e-6 && q.z > 0); // колонна на (0, 18)
  const lay = { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 15, yaw: 0 }, arena: { x: 0, z: 0, r: 13, leash: 6 } };
  const c = createCombat({ config: { encounter: { enabled: false } }, bossBrain: createIdleTestBrain_NOT_No5(), layout: lay });
  runFor(c, 2, 60, () => I({ moveZ: 1, viewYaw: 0 }));
  let p = c.getSnapshot().player.position;
  assert(Math.hypot(p.x - col.x, p.z - col.z) >= col.r + 0.45 - 1e-6, 'в колонну не вошли');
  const c2 = createCombat({ config: { encounter: { enabled: false } }, bossBrain: createIdleTestBrain_NOT_No5(), layout: lay });
  runFor(c2, 1, 60, (t0) => I({ dashDir: t0 === 0 ? { x: 0, z: 1 } : null, viewYaw: 0 }));
  p = c2.getSnapshot().player.position;
  assert(p.z < col.z, `рывок не проскочил колонну: z=${p.z}`);
  const c3 = createCombat({ config: { encounter: { enabled: false } }, bossBrain: createIdleTestBrain_NOT_No5(), layout: { ...lay, playerSpawn: { x: 0.3, z: 15, yaw: 0 } } });
  runFor(c3, 2, 60, () => I({ moveZ: 1, viewYaw: 0 }));
  p = c3.getSnapshot().player.position;
  assert(p.z > col.z + 0.5, `соскользнули вдоль колонны и пошли дальше: z=${p.z}`);
  const c4 = createCombat({ config: { encounter: { enabled: false } }, bossBrain: createIdleTestBrain_NOT_No5(), layout: { ...lay, playerSpawn: { x: 30, z: 30, yaw: 0 } } });
  runFor(c4, 6, 60, () => I({ moveZ: 1, viewYaw: Math.PI / 4 }), checkInvariants);
  p = c4.getSnapshot().player.position;
  assert(Math.hypot(p.x, p.z) <= 45 + 1e-6, 'край плато не пройти');
});

test('[V2] встреча: вне арены explore (Регент не атакует, герой смотрит по движению), в арене engaged', () => {
  const lay = { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 30, yaw: Math.PI } };
  const spam = createSpamTestBrain_NOT_No5();
  const c = createCombat({ config: {}, bossBrain: spam, layout: lay });
  let s = c.getSnapshot();
  assert(s.player.encounter === 'explore' && !s.player.lockedOn, 'старт снаружи — explore');
  const ev0 = runFor(c, 1, 60, () => I({ moveX: 1, viewYaw: Math.PI }));
  assert(count(ev0, 'boss_windup') === 0 && c.getSnapshot().telegraphs.length === 0, 'снаружи босс не атакует');
  s = c.getSnapshot();
  near(s.player.yaw, Math.atan2(s.player.velocity.x, s.player.velocity.z), 0.05, 'в explore смотрит по движению');
  const ev1 = runFor(c, 6, 60, (t0, t1, snap) => I({ moveZ: snap.player.encounter === 'engaged' ? 0 : 1, viewYaw: Math.atan2(-snap.player.position.x, -snap.player.position.z) }));
  assert(count(ev1, 'encounter_start') === 1, 'вход в арену');
  assert(c.getSnapshot().player.encounter === 'engaged', 'engaged');
  assert(count(ev1, 'boss_windup') > 0, 'в арене босс атакует');
  const ev2 = runFor(c, 6, 60, (t0, t1, snap) => I({ moveZ: -1, viewYaw: Math.atan2(-snap.player.position.x, -snap.player.position.z) }));
  assert(count(ev2, 'encounter_end', (e) => e.data.reason === 'left_arena') === 1, 'выход из арены');
  s = c.getSnapshot();
  assert(s.player.encounter === 'explore' && s.telegraphs.length === 0 && !s.projectiles.some((q) => q.owner === 'boss'), 'телеграфы и орбы сняты');
  assert(s.boss.hp === s.boss.maxHp || s.boss.hp > 0, 'HP сохраняются');
});

test('[V3] замок кадра: вне арены «вправо» при доворачивающей камере — прямая, а не круг; в арене — как раньше', () => {
  const lay = { ...DEFAULT_LAYOUT, colliders: [], playerSpawn: { x: 0, z: 30, yaw: Math.PI } };
  const run = (frameLock) => {
    const c = createCombat({ config: { player: { frameLock } }, bossBrain: createIdleTestBrain_NOT_No5(), layout: lay });
    let cam = Math.PI;                          // камера смотрит на −Z (за спиной героя)
    const p0 = c.getSnapshot().player.position;
    let path = 0, prev = { ...p0 };
    runFor(c, 3, 60, (t0, t1, snap) => {
      const v = snap.player.velocity;
      if (Math.hypot(v.x, v.z) > 1) cam += wrapA(Math.atan2(v.x, v.z) - cam) * 0.05;   // камера доворачивает за бегом
      const p = snap.player.position; path += Math.hypot(p.x - prev.x, p.z - prev.z); prev = { ...p };
      return I({ moveX: 1, viewYaw: cam });
    });
    const p1 = c.getSnapshot().player.position;
    return { disp: Math.hypot(p1.x - p0.x, p1.z - p0.z), path, dir: Math.atan2(p1.x - p0.x, p1.z - p0.z) };
  };
  const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const on = run(true), off = run(false);
  // вправо на экране при камере на −Z — это −X (right(ψ=π) = (−cos π, sin π) = (1, 0)? считаем по факту первого шага)
  assert(on.disp / on.path > 0.97, `с замком — почти прямая: ${(on.disp / on.path).toFixed(3)}`);
  assert(off.disp / off.path < on.disp / on.path - 0.05, `без замка путь кривее: ${(off.disp / off.path).toFixed(3)} vs ${(on.disp / on.path).toFixed(3)}`);
  // в арене замок не действует: стрейф идёт по дуге вокруг Регента
  const c2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  assert(c2.getSnapshot().player.encounter === 'engaged', 'старт в арене');
  const a0 = c2.getSnapshot().player.orbitAngle;
  runFor(c2, 1.5, 60, () => I({ moveX: 1 }));
  assert(Math.abs(c2.getSnapshot().player.orbitRadius - 6) < 0.8 && Math.abs(c2.getSnapshot().player.orbitAngle - a0) > 0.5, 'в lock-on обход по кругу');
});

test('[V2] агро: искра издали будит Регента; за поводком бой держится aggroMemory, потом explore', () => {
  const lay = { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 22, yaw: Math.PI } };
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5(), layout: lay });
  const mem = c.getConfig().encounter.aggroMemory;
  assert(c.getSnapshot().player.encounter === 'explore', 'старт за поводком — explore');
  const ev = runFor(c, 1, 60, (t0) => I({ spark: t0 < 0.001 }));
  assert(count(ev, 'boss_hit') >= 1, 'искра долетела');
  assert(count(ev, 'encounter_start', (e) => e.data.reason === 'aggro') === 1, 'удар будит Регента');
  assert(c.getSnapshot().player.encounter === 'engaged', 'engaged по агро');
  const ev2 = runFor(c, mem - 2, 60, () => I());
  assert(count(ev2, 'encounter_end') === 0 && c.getSnapshot().player.encounter === 'engaged', 'пока помнит — бой не снимается');
  const ev3 = runFor(c, 3, 60, () => I());
  assert(count(ev3, 'encounter_end') === 1 && c.getSnapshot().player.encounter === 'explore', 'забыл героя за поводком — explore');
  const s = c.getSnapshot();
  assert(s.boss.hp < s.boss.maxHp, 'HP Регента не восстановлены выходом');
});

test('[V3] печать ХЛОПОК: вблизи — оглушение, урон, срыв замаха; повтор — откат; издали — без оглушения', () => {
  const cfg = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() }).getConfig().sigils.clap;
  const c = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([orbAtPlayer(0.05)]) });
  runFor(c, 0.3, 60, () => I());
  assert(c.getSnapshot().telegraphs.length === 1, 'замах начался');
  const hp0 = c.getSnapshot().boss.hp, e0 = c.getSnapshot().player.energy;
  const ev = runFor(c, 0.2, 60, (t0) => I({ sigil: t0 < 0.001 ? 'clap' : null }));
  const s = c.getSnapshot();
  assert(count(ev, 'sigil_cast', (e) => e.data.sigil === 'clap' && e.data.stunned) === 1, 'печать с оглушением');
  assert(s.boss.stunned && s.telegraphs.length === 0, 'Регент оглушён, замах сорван');
  near(hp0 - s.boss.hp, cfg.damage, 1e-6, 'урон хлопка');
  assert(e0 - s.player.energy >= cfg.energy - 1, 'энергия списана');
  const ev2 = runFor(c, 0.1, 60, (t0) => I({ sigil: t0 < 0.001 ? 'clap' : null }));
  assert(count(ev2, 'ability_denied', (e) => e.data.ability === 'sigil' && e.data.reason === 'cooldown') === 1, 'откат');
  const far = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5(), layout: { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 22, yaw: Math.PI } } });
  const ev3 = runFor(far, 0.2, 60, (t0) => I({ sigil: t0 < 0.001 ? 'clap' : null }));
  assert(count(ev3, 'sigil_cast', (e) => e.data.sigil === 'clap' && !e.data.stunned) === 1 && !far.getSnapshot().boss.stunned && far.getSnapshot().boss.hp === far.getSnapshot().boss.maxHp, 'издали — только волна');
});

test('[V3] печать ВРАТА: бастион режет урон удара на 60% и гасит орб; истекает', () => {
  const cfg = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() }).getConfig().sigils.gate;
  const slam = { at: 0.3, spec: (s) => ({ id: 'sl', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { ...s.player.position }, windup: 0.5, radius: 3, damage: 20, blockable: false, projectileSpeed: 0 }) };
  const c = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slam, orbAtPlayer(1.6)]) });
  const ev = runFor(c, 3, 60, (t0) => I({ sigil: t0 < 0.001 ? 'gate' : null }));
  assert(count(ev, 'bastion_start') === 1, 'бастион поднят');
  const hit = ev.find((e) => e.type === 'player_hit');
  assert(hit && Math.abs(hit.data.amount - 20 * (1 - cfg.reduction)) < 1e-6, 'урон удара срезан: ' + (hit && hit.data.amount));
  assert(count(ev, 'block', (e) => e.data.bastion) === 1, 'орб погашен бастионом');
  runFor(c, cfg.duration, 60, () => I());
  assert(!c.getSnapshot().player.bastion, 'бастион истёк');
});

test('[V3] печать РАМКА: метка цели +30% урона по Регенту, истекает', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const cfg = c.getConfig();
  runFor(c, 0.1, 60, (t0) => I({ sigil: t0 < 0.001 ? 'frame' : null }));
  assert(c.getSnapshot().boss.marked, 'метка');
  const ev = runFor(c, 1.2, 60, (t0) => I({ spark: t0 < 0.001 }));
  const hit = ev.find((e) => e.type === 'boss_hit');
  assert(hit && hit.data.marked && hit.data.amount >= cfg.spark.damage * (1 + cfg.sigils.frame.bonus) - 1e-6, 'урон с меткой: ' + (hit && hit.data.amount));
  runFor(c, cfg.sigils.frame.duration, 60, () => I());
  assert(!c.getSnapshot().boss.marked, 'метка истекла');
});

test('[V3] неизвестная печать и руна игнорируются; снимок содержит откаты печатей', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev = runFor(c, 0.2, 60, (t0) => I({ sigil: t0 < 0.001 ? 'hack' : null, rune: t0 < 0.001 ? 'nope' : null }));
  assert(count(ev, 'sigil_cast') === 0 && count(ev, 'rune_cast') === 0, 'игнор');
  const s = c.getSnapshot();
  assert(s.cooldowns.sigils && s.cooldowns.sigils.clap && s.cooldowns.sigils.gate && s.cooldowns.sigils.frame, 'откаты в снимке');
});

test('[V2] «Искра»: снаряд spark, урон, энергия, кулдаун, отказ на откате', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const cfg = c.getConfig().spark;
  const ev = runFor(c, 1.2, 60, (t0) => I({ spark: t0 < 0.001 || Math.abs(t0 - 0.1) < 0.001 }));
  assert(count(ev, 'player_cast', (e) => e.data.ability === 'spark') === 1, 'одна искра');
  assert(count(ev, 'ability_denied', (e) => e.data.ability === 'spark' && e.data.reason === 'cooldown') === 1, 'вторая — на откате');
  assert(count(ev, 'boss_hit', (e) => e.data.source === 'player' || e.data.amount > 0) >= 1, 'попала');
  const s = c.getSnapshot();
  assert(s.boss.hp < s.boss.maxHp && s.boss.hp >= s.boss.maxHp - cfg.damage * 1.6, 'урон искры');
});

test('[V2] «Рассечение»: дуга бьёт Регента вблизи, мимо — вдали; бонус в recover; рассекает орбы', () => {
  const lay = { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 4, yaw: Math.PI } };
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5(), layout: lay });
  const ev = runFor(c, 0.3, 60, (t0) => I({ slash: t0 === 0 ? { dir: 1, power: 1 } : null }));
  const sl = ev.find((e) => e.type === 'player_slash');
  assert(sl && sl.data.hit === true && sl.data.arc.radius === 4.5, 'попадание вблизи');
  assert(c.getSnapshot().boss.hp <= c.getSnapshot().boss.maxHp - 54, 'урон по power=1');
  const far = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5(), layout: { ...lay, playerSpawn: { x: 0, z: 9, yaw: Math.PI } } });
  const ev2 = runFor(far, 0.3, 60, (t0) => I({ slash: t0 === 0 ? { dir: -1, power: 0.5 } : null }));
  assert(ev2.find((e) => e.type === 'player_slash').data.hit === false, 'вдали мимо');
  // орб в дуге рассекается
  const orbBrain = createScriptTestBrain_NOT_No5([orbAtPlayer(0.1)]);
  const o = createCombat({ config: {}, bossBrain: orbBrain, layout: lay });
  let cut = 0;
  const ev3 = runFor(o, 3, 60, (t0, t1, snap) => {
    const near1 = snap.projectiles.some((q) => q.owner === 'boss' && Math.hypot(q.position.x - snap.player.position.x, q.position.z - snap.player.position.z) < 2.5);
    return I({ slash: near1 && !cut++ ? { dir: 1, power: 0.6 } : null });
  });
  assert(count(ev3, 'projectile_impact', (e) => e.data.result === 'dispelled' && e.data.by === 'slash') === 1, 'орб рассечён');
  assert(count(ev3, 'player_hit') === 0, 'и не попал');
});

test('[V2] парирование: отражённый орб бьёт Регента, +энергия; промах — кулдаун', () => {
  const c = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([orbAtPlayer(0.1)]) });
  let fired = false;
  const ev = runFor(c, 4, 60, (t0, t1, snap) => {
    const close = snap.projectiles.some((q) => q.owner === 'boss' && Math.hypot(q.position.x - snap.player.position.x, q.position.y - 1.1 - snap.player.position.y, q.position.z - snap.player.position.z) < 2.2);
    const parry = close && !fired; if (parry) fired = true;
    return I({ parry });
  });
  assert(count(ev, 'parry', (e) => e.data.success) === 1, 'успешное парирование');
  assert(count(ev, 'projectile_reflected') === 1, 'отражение');
  assert(count(ev, 'player_hit') === 0, 'орб не попал в героя');
  assert(count(ev, 'boss_hit') >= 1 && c.getSnapshot().boss.hp < c.getSnapshot().boss.maxHp, 'отражённый орб попал в Регента');
  const w = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ev2 = runFor(w, 1, 60, (t0) => I({ parry: t0 === 0 || Math.abs(t0 - 0.3) < 0.001 }));
  assert(count(ev2, 'parry', (e) => e.data.success === false) === 1, 'промах');
  assert(count(ev2, 'ability_denied', (e) => e.data.ability === 'parry' && e.data.reason === 'cooldown') === 1, 'после промаха — откат');
});

test('[V2] выброс двумя руками сильнее на bothHandsBonus', () => {
  const a = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const b = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const ea = runFor(a, 0.2, 60, (t0) => I({ burst: t0 === 0, burstPower: 0.5, burstHand: 'right' }));
  const eb = runFor(b, 0.2, 60, (t0) => I({ burst: t0 === 0, burstPower: 0.5, burstHand: 'both' }));
  const da = ea.find((e) => e.type === 'burst').data.amount, db = eb.find((e) => e.type === 'burst').data.amount;
  near(db / da, 1 + a.getConfig().burst.bothHandsBonus, 1e-9, 'бонус двух рук');
});

test('атаки Регента при свободном движении: slam обходится шагом, орб по линии огня не обходится сближением, nova — отходом', () => {
  const slam = { at: 0.05, spec: (s) => ({ id: 'sl', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { ...s.player.position }, windup: 1.1, radius: 2.0, damage: 20, blockable: false, projectileSpeed: 0 }) };
  const stay = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slam]) });
  assert(count(runFor(stay, 2, 60), 'player_hit') === 1, 'контроль: стоя — попадание');
  const away = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slam]) });
  assert(count(runFor(away, 2, 60, () => I({ moveZ: -1 })), 'player_hit') === 0, 'отход назад уводит из круга 2 м');
  const side = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([slam]) });
  assert(count(runFor(side, 2, 60, () => I({ moveX: 1 })), 'player_hit') === 0, 'шаг вбок уводит из круга');
  const orb = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([orbAtPlayer(0.1)]) });
  assert(count(runFor(orb, 2.5, 60, () => I({ moveZ: 1 })), 'player_hit') === 1, 'орб по линии огня попадает и при сближении');
  const nova = { at: 1.5, spec: { id: 'n95', kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 0.5, radius: 9.5, damage: 20, blockable: true, projectileSpeed: 0 } };
  const n1 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([nova]) });
  assert(count(runFor(n1, 3, 60, () => I()), 'player_hit', (e) => e.data.attackKind === 'nova') === 1, 'стоя на 6 м nova 9.5 попадает');
  const n2 = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([nova]) });
  const ev2 = runFor(n2, 3, 60, () => I({ moveZ: -1 }));
  assert(count(ev2, 'player_hit', (e) => e.data.attackKind === 'nova') === 0, 'отход за радиус nova спасает');
});

test('бросок: спавн между ладонями, событие, снаряд sphere, попадание, урон по формуле, энергия, откат', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  c.update(H, I({ throw: THROW({ size: 0.5, power: 1 }) }));
  let ev = c.drainEvents();
  const cast = ev.find(e => e.type === 'player_cast');
  assert(cast && cast.data.ability === 'throw' && cast.data.kind === 'sphere', 'player_cast throw/sphere');
  assert(cast.data.size === 0.5 && cast.data.power === 1 && typeof cast.data.projectileId === 'string', 'size/power/projectileId в событии');
  near(cast.position.y, 1.25, 1e-9, 'высота спавна (грудь)');
  near(cast.position.z, 6 - 0.55, 1e-9, 'чуть впереди героя, к стражу');
  let s = c.getSnapshot();
  near(s.player.conjurePoint.z, 5.45, 1e-9, 'conjurePoint = точка спавна');
  const pr = s.projectiles.find(p => p.id === cast.data.projectileId);
  assert(pr && pr.owner === 'player' && pr.kind === 'sphere', 'снаряд героя kind sphere');
  near(pr.radius, 0.22 + 0.5 * 0.5, 1e-9, 'радиус 0.22+0.5·size');
  const sp = Math.hypot(pr.velocity.x, pr.velocity.y, pr.velocity.z);
  near(sp, 18, 1e-6, 'скорость при power 1 = 18 м/с');
  near(s.player.energy, 100 - (8 + 18 * 0.5), 1e-9, 'энергия −(8+18·size)');
  assert(s.cooldowns.throwRemaining > 0.85 && s.cooldowns.throwTotal === 0.9, 'откат 0.9 с в снимке');
  assert(s.player.action === 'cast', 'action cast после броска');
  let impactAt = -1;
  ev = runFor(c, 1, 60, () => I(), (cc, e, t) => { checkInvariants(cc); if (impactAt < 0 && e.some(x => x.type === 'projectile_impact' && x.data.owner === 'player')) impactAt = t; });
  const imp = ev.find(e => e.type === 'projectile_impact' && e.data.owner === 'player');
  assert(imp && imp.data.kind === 'sphere' && imp.data.result === 'boss' && imp.data.projectileId === cast.data.projectileId, 'projectile_impact sphere → boss');
  const hit = ev.find(e => e.type === 'boss_hit');
  assert(hit && hit.data.source === 'throw' && hit.data.kind === 'sphere', 'boss_hit source throw');
  assert(hit.data.amount === Math.round(25 + 85 * 1 * (0.6 + 0.4 * 0.5)), `урон ${hit.data.amount}`);
  assert(c.getSnapshot().projectiles.length === 0, 'снаряд удалён после попадания');
  facts.throwFlightFromR6 = +impactAt.toFixed(3);
  assert(impactAt > 0 && impactAt < 0.5, `полёт с 6 м: ${impactAt} с`);
  // формула урона на сетке size × power; призма +15%
  const dmgOf = (kind, size, power) => {
    const cc = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
    const e2 = runFor(cc, 1, 60, (t0) => I({ throw: t0 === 0 ? THROW({ kind, size, power }) : null }));
    const h2 = e2.filter(e => e.type === 'boss_hit' && e.data.source === 'throw');
    assert(h2.length === 1, `одно попадание (${kind} ${size}/${power})`);
    return h2[0].data.amount;
  };
  const table = {};
  for (const size of [0, 0.5, 1]) for (const power of [0, 0.5, 1]) {
    const base = 25 + 85 * power * (0.6 + 0.4 * size);
    const got = dmgOf('orb', size, power), gotP = dmgOf('prism', size, power);
    assert(got === Math.round(base), `sphere ${size}/${power}: ${got} ≠ ${Math.round(base)}`);
    assert(gotP === Math.round(base * 1.15), `prism ${size}/${power}: ${gotP} ≠ ${Math.round(base * 1.15)}`);
    table[`${size}/${power}`] = [got, gotP];
  }
  facts.throwDamage_sphere_prism = table;
  assert(table['1/1'][0] === 110 && table['0/0'][0] === 25, 'крайние значения 25 … 110');
  // откат: второй бросок через 0.5 с — отказ, через 1.0 с — проходит
  const cd = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const evCd = runFor(cd, 1.5, 60, (t0, t1) => I({ throw: t0 === 0 || crossed(t0, t1, 0.5) || crossed(t0, t1, 1.0) ? THROW({ size: 0 }) : null }), checkInvariants);
  assert(count(evCd, 'player_cast', e => e.data.ability === 'throw') === 2, 'броски в 0 и 1.0');
  assert(count(evCd, 'ability_denied', e => e.data.ability === 'throw' && e.data.reason === 'cooldown') === 1, 'отказ по откату в 0.5');
  // энергия: не хватает — ability_denied energy, ничего не списано
  const en = createCombat({ config: { player: { maxEnergy: 20 } }, bossBrain: createIdleTestBrain_NOT_No5() });
  en.update(H, I({ throw: THROW({ size: 1 }) }));
  let e3 = en.drainEvents();
  assert(count(e3, 'ability_denied', e => e.data.ability === 'throw' && e.data.reason === 'energy' && e.data.cost === 26) === 1, 'size 1 стоит 26 > 20 → отказ');
  assert(count(e3, 'player_cast') === 0 && en.getSnapshot().player.energy === 20, 'энергия не списана');
  en.update(H, I({ throw: THROW({ size: 0 }) }));
  e3 = en.drainEvents();
  assert(count(e3, 'player_cast', e => e.data.ability === 'throw') === 1 && en.getSnapshot().player.energy === 12, 'size 0 стоит 8');
  // щит приоритетнее броска
  const shc = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(shc, 0.1, 60, () => I({ shield: true }));
  shc.update(H, I({ shield: true, throw: THROW() }));
  assert(count(shc.drainEvents(), 'ability_denied', e => e.data.ability === 'throw' && e.data.reason === 'shield') === 1, 'во время щита — отказ shield');
  // импульс: один throw — один бросок, даже если в кадре не прошёл ни один шаг (144 Гц)
  const imp2 = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  imp2.update(0.004, I({ throw: THROW() }));
  imp2.update(0.004, I());
  imp2.update(0.5, I());
  assert(count(imp2.drainEvents(), 'player_cast', e => e.data.ability === 'throw') === 1, 'импульс при dt<шага исполнен один раз');
});

test('бросок: дуга по aimX (вправо/влево на экране), затем доводка; попадает с 3.8 и 9.0 м и при грубом шаге', () => {
  const res = {};
  for (const r0 of [3.8, 6, 9]) {
    for (const aimX of [-1, 0, 1]) {
      for (const fixedStep of [1 / 120, 1 / 20]) {
        const c = createCombat({ config: { player: { orbitRadius: r0 }, sim: { fixedStep } }, bossBrain: createIdleTestBrain_NOT_No5() });
        runFor(c, 0.4, 60, () => I({ moveX: 1 })); // не на оси Z: проверка в произвольной точке круга
        runFor(c, 0.3, 60, () => I()); // остановиться: спавн = conjurePoint снимка s0
        const s0 = c.getSnapshot();
        const a = s0.player.orbitAngle;
        const right = { x: Math.cos(a), z: -Math.sin(a) };
        let maxOff = 0, flight = -1;
        const ev = runFor(c, 1.2, 60, (t0) => I({ throw: t0 === 0 ? THROW({ aimX }) : null }), (cc, e, t) => {
          const p = cc.getSnapshot().projectiles.find(x => x.owner === 'player');
          if (p) { const off = lateralOffset(p.position, s0.player.conjurePoint, s0.boss.position, right); if (Math.abs(off) > Math.abs(maxOff)) maxOff = off; }
          if (flight < 0 && e.some(x => x.type === 'boss_hit')) flight = t;
        });
        const hits = count(ev, 'boss_hit', e => e.data.source === 'throw');
        assert(hits === 1, `r=${r0} aimX=${aimX} step=${fixedStep.toFixed(3)}: попаданий ${hits}`);
        assert(count(ev, 'projectile_impact', e => e.data.owner === 'player' && e.data.result === 'floor') === 0, 'без промаха');
        if (fixedStep === 1 / 120) {
          res[`r${r0}_aim${aimX}`] = { flight: +flight.toFixed(3), maxLateral: +maxOff.toFixed(2) };
          if (aimX === 0) assert(Math.abs(maxOff) < 0.05, `прямой бросок без бокового ухода: ${maxOff}`);
          else if (r0 >= 6) assert(Math.sign(maxOff) === aimX && Math.abs(maxOff) > 0.4, `дуга в сторону aimX=${aimX}: ${maxOff}`);
        }
      }
    }
  }
  facts.throwArc = res;
});

test('призма раскалывает орб стража на пути и летит дальше; сфера — нет', () => {
  const scenario = (kind) => {
    const c = createCombat({ config: {}, bossBrain: createScriptTestBrain_NOT_No5([orbAtPlayer(0.1, { projectileSpeed: 5 })]) });
    let thrown = false;
    const ev = runFor(c, 3, 60, (t0, t1, snap) => {
      const orb = snap.projectiles.find(p => p.owner === 'boss');
      if (!thrown && orb && Math.hypot(orb.position.x - snap.player.position.x, orb.position.z - snap.player.position.z) < 3.5) { thrown = true; return I({ throw: THROW({ kind, size: 0.5 }) }); }
      return I();
    }, checkInvariants);
    return { ev, c, thrown };
  };
  const P = scenario('prism');
  assert(P.thrown, 'бросок сделан, пока орб в полёте');
  const castP = P.ev.find(e => e.type === 'player_cast' && e.data.ability === 'throw');
  assert(castP.data.kind === 'prism', 'kind prism');
  const shattered = P.ev.filter(e => e.type === 'projectile_impact' && e.data.owner === 'boss' && e.data.result === 'dispelled' && e.data.by === 'prism');
  assert(shattered.length === 1 && shattered[0].data.byProjectileId === castP.data.projectileId, 'орб расколот призмой');
  assert(count(P.ev, 'player_hit') === 0, 'расколотый орб не попал в героя');
  const hitP = P.ev.find(e => e.type === 'boss_hit' && e.data.source === 'throw');
  assert(hitP && hitP.data.kind === 'prism', 'призма после орба долетела до стража');
  const impP = P.ev.find(e => e.type === 'projectile_impact' && e.data.owner === 'player');
  assert(impP.data.result === 'boss' && impP.data.pierced === 1, 'в impact призмы pierced = 1');
  const S = scenario('orb');
  assert(count(S.ev, 'projectile_impact', e => e.data.owner === 'boss' && e.data.result === 'dispelled') === 0, 'сфера орб не раскалывает');
  assert(count(S.ev, 'boss_hit', e => e.data.source === 'throw' && e.data.kind === 'sphere') === 1, 'сфера всё равно попала в стража');
  assert(count(S.ev, 'player_hit') === 1, 'орб долетел до героя (сфера его не остановила)');
});

test('conjure: снимок зеркалит очищенный ввод; невалидный ввод чистит conjure и сжигает бросок; огонь подавлен', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  assert(c.getSnapshot().player.conjure === null, 'по умолчанию null');
  const conj = { kind: 'prism', size: 0.6, charge: 0.4, center: { x: 0.5, y: 0.6 }, heldMs: 420 };
  c.update(1 / 60, I({ conjure: conj }));
  let s = c.getSnapshot();
  assert(JSON.stringify(s.player.conjure) === JSON.stringify({ kind: 'prism', size: 0.6, charge: 0.4 }), `conjure: ${JSON.stringify(s.player.conjure)}`);
  s.player.conjure.size = 99;
  assert(c.getSnapshot().player.conjure.size === 0.6, 'снимок — копия');
  c.update(1 / 60, I({ conjure: { kind: 'orb', size: 7, charge: NaN } }));
  s = c.getSnapshot();
  assert(s.player.conjure.kind === 'orb' && s.player.conjure.size === 1 && s.player.conjure.charge === 0, 'ограничение 0..1 и NaN → 0');
  for (const bad of [{ kind: 'cube', size: 0.5 }, 'orb', 5, { size: 0.5 }]) {
    c.update(1 / 60, I({ conjure: bad }));
    assert(c.getSnapshot().player.conjure === null, `мусор ${JSON.stringify(bad)} → null`);
  }
  c.update(1 / 60, I({ conjure: conj }));
  c.update(1 / 60, INVALID());
  assert(c.getSnapshot().player.conjure === null, 'невалидный ввод → conjure null');
  c.update(1 / 60, { ...INVALID(), conjure: conj, throw: THROW() });
  assert(c.getSnapshot().player.conjure === null, 'поля невалидного кадра игнорируются');
  // бросок, пришедший в кадре без шага, сгорает, если следующий кадр невалиден
  const b = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  b.update(0.004, I({ throw: THROW() }));
  b.update(0.004, INVALID());
  b.update(0.5, INVALID());
  assert(count(b.drainEvents(), 'player_cast') === 0, 'импульс броска сожжён невалидным вводом');
  // мусорный throw ничего не делает
  const g = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(g, 0.2, 60, () => I({ throw: { kind: 'laser', size: 1, power: 1 } }));
  runFor(g, 0.2, 60, () => I({ throw: true }));
  assert(g.drainEvents().length === 0 && g.getSnapshot().projectiles.length === 0, 'мусорный throw игнорируется');
  // пока руки лепят заклинание, щипок-огонь не стреляет
  const f = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const evF = runFor(f, 1, 60, () => I({ attack: true, conjure: conj }));
  assert(count(evF, 'player_cast') === 0, 'огонь подавлен во время conjure');
  // после исхода conjure не показывается
  const v = createCombat({ config: { boss: { maxHp: 10 } }, bossBrain: createIdleTestBrain_NOT_No5() });
  runFor(v, 1, 60, (t0) => I({ conjure: conj, throw: t0 === 0 ? THROW() : null }));
  assert(v.getSnapshot().status === 'victory' && v.getSnapshot().player.conjure === null, 'после победы conjure null');
});

test('reset очищает радиус, conjure, откат броска и снаряды броска', () => {
  const c = createCombat({ config: {}, bossBrain: createIdleTestBrain_NOT_No5() });
  const fresh = JSON.stringify(c.getSnapshot());
  runFor(c, 0.6, 60, (t0) => I({ moveZ: 1, conjure: { kind: 'orb', size: 0.3, charge: 0.2 }, throw: t0 === 0 ? THROW() : null }));
  assert(radiusOf(c) < 6 && c.getSnapshot().cooldowns.throwRemaining > 0, 'состояние изменилось');
  c.reset();
  assert(JSON.stringify(c.getSnapshot()) === fresh, 'снимок как у нового боя');
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
