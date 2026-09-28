// =============================================================================
// combat.js — ASHEN OATH · роль No4 (бой, движение, попадания) · API ASHEN_V1
// -----------------------------------------------------------------------------
// Чистая JS-симуляция боя. Без DOM, Three.js, webcam, requestAnimationFrame и
// импортов чужих модулей. Единственный владелец HP, энергии, позиций,
// cooldown, снарядов, телеграфов и исхода боя. Остальные модули получают
// только копии состояния через getSnapshot() и события через drainEvents().
//
// Порядок внутри одного фиксированного шага (документированный арбитраж):
//   1) bossBrain.update(h, snapshot) → стадия, действие, новые AttackSpec
//   2) таймеры (cooldown, i-frames, grace, реакции)
//   3) щит → попытка рывка → движение → восстановление энергии
//   4) burst (мгновенный урон боссу) → обычный огонь
//   5) снаряды героя → урон боссу          (смерть босса = победа, шаг прерван)
//   6) телеграфы: slam/nova бьют, orb вылетает (смерть героя = поражение)
//   7) снаряды босса → попадания в героя   (смерть героя = поражение)
//   8) поворот босса
// Следствие: если в одном шаге смертельны оба удара, побеждает игрок, потому
// что его урон разрешается раньше. Второй исход не наступает, событие
// результата выпускается ровно одно.
// =============================================================================

export const COMBAT_API_VERSION = 'ASHEN_V1';

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;
const ATTACK_KINDS = new Set(['slam', 'orb', 'nova']);
const BOSS_ACTIONS = new Set(['idle', 'windup', 'attack', 'recover']);
const MISS = Object.freeze({ hit: false, t: -1 });

// Начальный баланс. Все значения — секунды, метры, единицы HP/энергии.
export const DEFAULT_COMBAT_CONFIG = deepFreeze({
  sim: {
    fixedStep: 1 / 120,     // фиксированный шаг; итог не зависит от FPS рендера
    maxFrameDt: 0.1,        // больший dt отбрасывается, а не «догоняется»
    maxEvents: 256,         // очередь событий между drainEvents()
    maxProjectiles: 48,
    maxTelegraphs: 8,
    maxAttacksPerStep: 4,   // сколько AttackSpec за один шаг принимается
    maxSeenAttackIds: 1024, // память уникальности id (FIFO)
    freezeSnapshots: false, // true → getSnapshot() отдаёт deep-frozen объект
  },
  arena: {
    radius: 10,
    bossPosition: { x: 0, y: 0, z: 0 },
    startAngle: 0,          // 0 → герой в (0,0,6)
  },
  player: {
    maxHp: 100,
    maxEnergy: 100,
    orbitRadius: 6,         // дистанция до босса держится игрой
    hitRadius: 0.45,        // тело героя для снарядов (вертикальный цилиндр)
    height: 1.9,
    chestHeight: 1.1,
    strafeSpeed: 4.0,       // м/с вдоль дуги при |moveX| = 1
    moveDeadzone: 0.06,
    accelTime: 0.08,        // постоянная времени разгона (без «льда»)
    stopTime: 0.05,         // постоянная времени остановки при нейтрали
    moveSign: 1,            // +1: +moveX → вправо на экране (см. handoff)
    energyRegen: 20,        // ед./с
    energyRegenDelay: 0.5,  // пауза регена после траты энергии
    hitGrace: 0.35,         // неуязвимость после полученного удара
    hitReactTime: 0.3,      // action 'hit', огонь подавлен
  },
  dash: {
    distance: 3.2,          // м по дуге (~30° на радиусе 6)
    duration: 0.24,
    cost: 20,
    cooldown: 0.9,          // от начала рывка
    iframeDuration: 0.3,    // от начала рывка
  },
  bolt: {
    interval: 0.3,          // ~3.3 выстрела/с при удержании
    speed: 22,
    radius: 0.22,
    damage: 6,
    lifetime: 1.4,
    energyCost: 0,          // обычный огонь бесплатный
    spawnHeight: 1.35,
    spawnForward: 0.6,
    spawnSide: 0.25,        // правая рука (экранно-правая сторона)
  },
  shield: {
    drainPerSec: 25,        // 100 энергии = 4 с непрерывного щита
    minEnergyToStart: 12,
    blockEnergyCost: 6,
    moveSpeedFactor: 0.7,
  },
  burst: {
    cost: 40,
    cooldown: 12,
    damage: 80,
    clearRadius: 5,         // рассеивает орбы босса в этом радиусе от героя
    castTime: 0.4,
  },
  boss: {
    maxHp: 1000,
    hitRadius: 1.7,         // вертикальный цилиндр для болтов
    height: 5,
    aimHeight: 2.2,
    turnRate: 2.5,          // рад/с
    hitReactTime: 0.35,     // только от burst, только в idle/recover
  },
  bossAttack: {             // санитарные границы AttackSpec от bossBrain
    minWindup: 0.35,
    maxWindup: 6,
    minRadius: 0.3,
    maxRadius: 12,
    orbMinRadius: 0.2,
    orbMaxRadius: 2,
    maxDamage: 60,
    defaultOrbSpeed: 10,
    minOrbSpeed: 3,
    maxOrbSpeed: 40,
    orbMaxLifetime: 6,
    orbMinSpawnHeight: 0.4,
    orbDefaultTargetHeight: 1.0, // если target.y≈0, орб целится на эту высоту
  },
});

// -----------------------------------------------------------------------------
// Чистые утилиты
// -----------------------------------------------------------------------------
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function fin(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }
function vec(x, y, z) { return { x, y, z }; }
function vcopy(v) { return { x: v.x, y: v.y, z: v.z }; }
function distXZ(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); }
function wrapAngle(a) {
  a = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return a;
}
function easeOutQuad(u) { const w = 1 - u; return 1 - w * w; }
function readVec(v) {
  if (!v || typeof v !== 'object') return null;
  const x = Number(v.x), z = Number(v.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const y = Number.isFinite(Number(v.y)) ? Number(v.y) : 0;
  return { x, y, z };
}

function mergeConfig(base, patch) {
  const out = {};
  for (const key of Object.keys(base)) {
    const b = base[key];
    const p = isPlainObject(patch) ? patch[key] : undefined;
    if (isPlainObject(b)) out[key] = mergeConfig(b, isPlainObject(p) ? p : {});
    else if (typeof b === 'number') out[key] = fin(p, b);
    else if (typeof b === 'boolean') out[key] = typeof p === 'boolean' ? p : b;
    else if (typeof b === 'string') out[key] = typeof p === 'string' ? p : b;
    else out[key] = b;
  }
  return out;
}

function normalizeConfig(C) {
  const s = C.sim;
  s.fixedStep = clamp(s.fixedStep, 1 / 240, 1 / 20);
  s.maxFrameDt = clamp(s.maxFrameDt, s.fixedStep, 0.25);
  for (const k of ['maxEvents', 'maxProjectiles', 'maxTelegraphs', 'maxAttacksPerStep', 'maxSeenAttackIds']) {
    s[k] = Math.max(1, Math.floor(s[k]));
  }
  C.arena.radius = Math.max(2, C.arena.radius);
  const p = C.player;
  p.maxHp = Math.max(1, p.maxHp);
  p.maxEnergy = Math.max(1, p.maxEnergy);
  p.orbitRadius = clamp(p.orbitRadius, 1.5, C.arena.radius);
  p.hitRadius = clamp(p.hitRadius, 0.05, 2);
  p.height = Math.max(0.5, p.height);
  p.strafeSpeed = Math.max(0, p.strafeSpeed);
  p.moveDeadzone = clamp(p.moveDeadzone, 0, 0.5);
  p.accelTime = Math.max(0.005, p.accelTime);
  p.stopTime = Math.max(0.005, p.stopTime);
  p.moveSign = p.moveSign < 0 ? -1 : 1;
  p.energyRegen = Math.max(0, p.energyRegen);
  p.energyRegenDelay = Math.max(0, p.energyRegenDelay);
  p.hitGrace = Math.max(0, p.hitGrace);
  p.hitReactTime = Math.max(0, p.hitReactTime);
  const d = C.dash;
  d.duration = clamp(d.duration, 0.03, 1);
  d.distance = Math.max(0, d.distance);
  d.cost = Math.max(0, d.cost);
  d.cooldown = Math.max(d.duration, d.cooldown);
  d.iframeDuration = clamp(d.iframeDuration, 0, 1);
  const bo = C.bolt;
  bo.interval = Math.max(0.05, bo.interval);
  bo.speed = clamp(bo.speed, 1, 120);
  bo.radius = clamp(bo.radius, 0.02, 2);
  bo.damage = Math.max(0, bo.damage);
  bo.lifetime = clamp(bo.lifetime, 0.05, 5);
  bo.energyCost = Math.max(0, bo.energyCost);
  const sh = C.shield;
  sh.drainPerSec = Math.max(0, sh.drainPerSec);
  sh.minEnergyToStart = Math.max(0, sh.minEnergyToStart);
  sh.blockEnergyCost = Math.max(0, sh.blockEnergyCost);
  sh.moveSpeedFactor = clamp(sh.moveSpeedFactor, 0, 1);
  const bu = C.burst;
  bu.cost = Math.max(0, bu.cost);
  bu.cooldown = Math.max(0, bu.cooldown);
  bu.damage = Math.max(0, bu.damage);
  bu.clearRadius = Math.max(0, bu.clearRadius);
  bu.castTime = Math.max(0, bu.castTime);
  const b = C.boss;
  b.maxHp = Math.max(1, b.maxHp);
  b.hitRadius = clamp(b.hitRadius, 0.2, 5);
  b.height = Math.max(0.5, b.height);
  b.turnRate = Math.max(0, b.turnRate);
  b.hitReactTime = Math.max(0, b.hitReactTime);
  const a = C.bossAttack;
  a.minWindup = Math.max(0, a.minWindup);
  a.maxWindup = Math.max(a.minWindup, a.maxWindup);
  a.minRadius = Math.max(0.05, a.minRadius);
  a.maxRadius = Math.max(a.minRadius, a.maxRadius);
  a.orbMinRadius = Math.max(0.05, a.orbMinRadius);
  a.orbMaxRadius = Math.max(a.orbMinRadius, a.orbMaxRadius);
  a.maxDamage = Math.max(0, a.maxDamage);
  a.minOrbSpeed = Math.max(0.5, a.minOrbSpeed);
  a.maxOrbSpeed = Math.max(a.minOrbSpeed, a.maxOrbSpeed);
  a.defaultOrbSpeed = clamp(a.defaultOrbSpeed, a.minOrbSpeed, a.maxOrbSpeed);
  a.orbMaxLifetime = clamp(a.orbMaxLifetime, 0.2, 20);
  return C;
}

/**
 * Проверка пролёта между кадрами (swept test) для движущегося объекта A
 * и вертикального цилиндра B (тоже может двигаться). Движение считается
 * линейным в пределах шага; проверяется относительный путь, поэтому быстрый
 * объект не «перепрыгивает» цель.
 * a0/a1 — позиция A в начале/конце шага, b0/b1 — основание цилиндра B.
 * radius — сумма радиусов, yMin/yMax — допустимая высота A относительно основания B.
 * Возвращает {hit, t}, где t ∈ [0,1] — первый момент касания.
 */
export function sweptCylinderHit(a0, a1, b0, b1, radius, yMin, yMax) {
  const px = a0.x - b0.x, pz = a0.z - b0.z;
  const qx = a1.x - b1.x, qz = a1.z - b1.z;
  const py0 = a0.y - b0.y, py1 = a1.y - b1.y;
  const dx = qx - px, dz = qz - pz;
  const A = dx * dx + dz * dz;
  const Bh = px * dx + pz * dz;
  const Cc = px * px + pz * pz - radius * radius;
  let t0, t1;
  if (A < 1e-12) {
    if (Cc > 0) return MISS;
    t0 = 0; t1 = 1;
  } else {
    const disc = Bh * Bh - A * Cc;
    if (disc < 0) return MISS;
    const s = Math.sqrt(disc);
    t0 = (-Bh - s) / A;
    t1 = (-Bh + s) / A;
    if (t1 < 0 || t0 > 1) return MISS;
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
  }
  const dy = py1 - py0;
  if (Math.abs(dy) < 1e-12) {
    if (py0 < yMin || py0 > yMax) return MISS;
    return { hit: true, t: t0 };
  }
  let ta = (yMin - py0) / dy, tb = (yMax - py0) / dy;
  if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
  const u0 = Math.max(t0, ta), u1 = Math.min(t1, tb);
  if (u0 > u1) return MISS;
  return { hit: true, t: u0 };
}

// -----------------------------------------------------------------------------
// Фабрика
// -----------------------------------------------------------------------------
export function createCombat({ config, bossBrain } = {}) {
  if (!bossBrain || typeof bossBrain.update !== 'function' || typeof bossBrain.reset !== 'function') {
    throw new TypeError('createCombat: нужен bossBrain с методами update(dt, snapshot) и reset()');
  }
  // Принимается либо конфиг боя, либо общий конфиг игры с полем combat.
  const src = isPlainObject(config) && isPlainObject(config.combat) ? config.combat : config;
  const C = normalizeConfig(mergeConfig(DEFAULT_COMBAT_CONFIG, isPlainObject(src) ? src : {}));
  const frozenConfig = deepFreeze(JSON.parse(JSON.stringify(C)));

  const H = C.sim.fixedStep;
  const MAX_STEPS = Math.ceil(C.sim.maxFrameDt / H) + 1;
  const BOSS = vcopy(C.arena.bossPosition);
  const R = C.player.orbitRadius;

  let eventSeq = 0;   // не сбрасывается: id событий уникальны на всю сессию
  let fightGen = 0;   // растёт при каждом reset: id снарядов не повторяются
  let projSeq = 0;
  let st = null;
  let warnedBrain = false;

  function freshState() {
    const angle = C.arena.startAngle;
    const pp = orbitPoint(angle);
    return {
      status: 'playing',
      time: 0,
      acc: 0,
      p: {
        angle, vLat: 0, lateralNow: 0,
        hp: C.player.maxHp, energy: C.player.maxEnergy,
        dashing: false, dashElapsed: 0, dashDir: 0, dashCd: 0,
        iframe: 0, grace: 0, hitReact: 0, regenDelay: 0,
        shielding: false, shieldLock: false,
        fireTimer: 0, firing: false, castTimer: 0, burstCd: 0,
        dead: false,
      },
      b: {
        hp: C.boss.maxHp, stage: 1,
        yaw: Math.atan2(pp.x - BOSS.x, pp.z - BOSS.z),
        decisionAction: 'idle', hitReact: 0, dead: false,
      },
      projectiles: [],
      telegraphs: [],
      events: [],
      seenIds: new Set(),
      seenOrder: [],
      stats: { damageDealt: 0, damageTaken: 0, dodges: 0, blocks: 0 },
      input: { moveX: 0, attack: false, shield: false, valid: false },
      pendingDash: 0,
      pendingBurst: false,
      debug: {
        steps: 0, brainCalls: 0, brainErrors: 0,
        acceptedAttacks: 0, rejectedAttacks: 0, duplicateAttacks: 0,
        droppedEvents: 0, droppedProjectiles: 0, clampedFrames: 0, lastReject: '',
      },
    };
  }

  // ---------------------------------------------------------------- геометрия
  function orbitPoint(angle) {
    return vec(BOSS.x + R * Math.sin(angle), BOSS.y, BOSS.z + R * Math.cos(angle));
  }
  function playerPos() { return orbitPoint(st.p.angle); }
  function playerChest() { const p = playerPos(); p.y += C.player.chestHeight; return p; }
  function bossAim() { return vec(BOSS.x, BOSS.y + C.boss.aimHeight, BOSS.z); }
  // Экранно-правый вектор для камеры за спиной героя, смотрящей на босса.
  function screenRight() {
    const a = st.p.angle, s = C.player.moveSign;
    return vec(s * Math.cos(a), 0, -s * Math.sin(a));
  }

  // ---------------------------------------------------------------- события
  function emit(type, position, data) {
    const ev = {
      id: `ev${++eventSeq}`,
      type,
      position: position ? vcopy(position) : vcopy(BOSS),
      data: isPlainObject(data) ? data : {},
    };
    st.events.push(ev);
    if (st.events.length > C.sim.maxEvents) {
      let idx = st.events.findIndex(e => e.type !== 'victory' && e.type !== 'defeat');
      if (idx < 0) idx = 0;
      st.events.splice(idx, 1);
      st.debug.droppedEvents++;
    }
  }

  // ---------------------------------------------------------------- снимок
  function playerAction() {
    const P = st.p;
    if (P.dead) return 'dead';
    if (P.hitReact > 0) return 'hit';
    if (P.dashing) return 'dash';
    if (P.shielding) return 'shield';
    if (P.firing || P.castTimer > 0) return 'cast';
    if (Math.abs(P.lateralNow) > 0.08 * Math.max(0.1, C.player.strafeSpeed)) return 'move';
    return 'idle';
  }
  function bossAction() {
    const B = st.b;
    if (B.dead) return 'dead';
    if (B.hitReact > 0 && (B.decisionAction === 'idle' || B.decisionAction === 'recover')) return 'hit';
    return B.decisionAction;
  }

  function buildSnapshot() {
    const P = st.p, B = st.b;
    const pp = playerPos();
    const snap = {
      status: st.status,
      time: st.time,
      player: {
        position: pp,
        yaw: Math.atan2(BOSS.x - pp.x, BOSS.z - pp.z),
        hp: P.hp, maxHp: C.player.maxHp,
        energy: P.energy, maxEnergy: C.player.maxEnergy,
        action: playerAction(),
        invulnerable: P.iframe > 0 || P.grace > 0,
        shielding: P.shielding,
        // --- расширения ASHEN_V1 (No4) ---
        orbitAngle: P.angle,
        orbitRadius: R,
        lateral: C.player.strafeSpeed > 0 ? P.lateralNow / C.player.strafeSpeed : 0,
        dashing: P.dashing,
        dashDirection: P.dashing ? P.dashDir : 0,
        invulnerableSource: P.iframe > 0 ? 'dash' : P.grace > 0 ? 'hit' : 'none',
      },
      boss: {
        position: vcopy(BOSS),
        yaw: B.yaw,
        hp: B.hp, maxHp: C.boss.maxHp,
        stage: B.stage,
        action: bossAction(),
      },
      cooldowns: {
        dashRemaining: P.dashCd, dashTotal: C.dash.cooldown,
        burstRemaining: P.burstCd, burstTotal: C.burst.cooldown,
      },
      projectiles: st.projectiles.map(pr => {
        const o = {
          id: pr.id, owner: pr.owner, kind: pr.kind,
          position: vcopy(pr.position), velocity: vcopy(pr.velocity), radius: pr.radius,
        };
        if (pr.attackId) o.attackId = pr.attackId;
        return o;
      }),
      telegraphs: st.telegraphs.map(t => {
        const o = {
          id: t.id, kind: t.kind,
          origin: vcopy(t.origin), target: vcopy(t.target), radius: t.radius,
          remaining: Math.max(0, t.remaining), duration: t.duration, blockable: t.blockable,
          // --- расширения: точный центр опасной зоны и урон ---
          center: vcopy(t.center), damage: t.damage,
        };
        if (t.kind === 'orb') { o.pathEnd = vcopy(t.pathEnd); o.projectileSpeed = t.speed; }
        return o;
      }),
      stats: { ...st.stats },
    };
    return C.sim.freezeSnapshots ? deepFreeze(snap) : snap;
  }

  // ---------------------------------------------------------------- ввод
  function readInput(input) {
    const ok = isPlainObject(input) && input.valid === true && input.source !== 'none';
    if (!ok) {
      st.input.moveX = 0; st.input.attack = false; st.input.shield = false; st.input.valid = false;
      st.pendingDash = 0; st.pendingBurst = false;
      return;
    }
    let mx = Number(input.moveX);
    if (!Number.isFinite(mx)) mx = 0;
    st.input.moveX = clamp(mx, -1, 1);
    st.input.attack = input.attack === true;
    st.input.shield = input.shield === true;
    st.input.valid = true;
    const dsh = Number(input.dash);
    if (Number.isFinite(dsh) && dsh !== 0) st.pendingDash = dsh > 0 ? 1 : -1;
    if (input.burst === true) st.pendingBurst = true;
  }

  // ---------------------------------------------------------------- босс: решения
  function callBrain(h) {
    let decision = null;
    try {
      decision = bossBrain.update(h, buildSnapshot());
      st.debug.brainCalls++;
    } catch (err) {
      st.debug.brainErrors++;
      if (!warnedBrain && typeof console !== 'undefined') {
        warnedBrain = true;
        console.error('[combat] bossBrain.update бросил исключение; шаг продолжен без решения босса', err);
      }
      decision = null;
    }
    applyDecision(decision);
  }

  function applyDecision(dec) {
    if (!isPlainObject(dec)) return;
    const B = st.b;
    if (dec.stage === 2 && B.stage === 1) {
      B.stage = 2;
      emit('boss_phase', bossAim(), { stage: 2, from: 1 });
    }
    B.decisionAction = BOSS_ACTIONS.has(dec.action) ? dec.action : 'idle';
    if (Array.isArray(dec.attacks)) {
      const n = Math.min(dec.attacks.length, C.sim.maxAttacksPerStep);
      for (let i = 0; i < n; i++) registerAttack(dec.attacks[i]);
    }
  }

  function reject(reason) {
    st.debug.rejectedAttacks++;
    st.debug.lastReject = reason;
    return false;
  }

  function rememberId(id) {
    st.seenIds.add(id);
    st.seenOrder.push(id);
    if (st.seenOrder.length > C.sim.maxSeenAttackIds) st.seenIds.delete(st.seenOrder.shift());
  }

  function registerAttack(spec) {
    if (st.status !== 'playing') return false;
    if (!isPlainObject(spec)) return reject('spec не объект');
    const id = spec.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return reject('некорректный id');
    if (st.seenIds.has(id)) { st.debug.duplicateAttacks++; return false; }
    if (!ATTACK_KINDS.has(spec.kind)) return reject(`неизвестный kind у ${id}`);
    const origin = readVec(spec.origin), target = readVec(spec.target);
    if (!origin || !target) return reject(`нечисловые origin/target у ${id}`);
    const windup = Number(spec.windup), radius = Number(spec.radius), damage = Number(spec.damage);
    if (!Number.isFinite(windup) || !Number.isFinite(radius) || !Number.isFinite(damage)) {
      return reject(`нечисловые windup/radius/damage у ${id}`);
    }
    if (st.telegraphs.length >= C.sim.maxTelegraphs) return reject('лимит телеграфов');

    const A = C.bossAttack;
    const kind = spec.kind;
    const tel = {
      id, kind,
      origin, target, center: null,
      radius: 0,
      windup: clamp(windup, A.minWindup, A.maxWindup),
      remaining: 0, duration: 0,
      damage: clamp(damage, 0, A.maxDamage),
      blockable: spec.blockable === true,
      speed: 0, dir: null, pathEnd: null, travel: 0,
    };
    tel.remaining = tel.duration = tel.windup;

    if (kind === 'slam') {
      tel.radius = clamp(radius, A.minRadius, A.maxRadius);
      tel.center = vec(target.x, BOSS.y, target.z);
    } else if (kind === 'nova') {
      tel.radius = clamp(radius, A.minRadius, A.maxRadius);
      tel.center = vec(origin.x, BOSS.y, origin.z);
    } else {
      tel.radius = clamp(radius, A.orbMinRadius, A.orbMaxRadius);
      setupOrbPath(tel, spec);
    }
    rememberId(id);
    st.telegraphs.push(tel);
    st.debug.acceptedAttacks++;
    emit('boss_windup', tel.center, {
      attackId: id, attackKind: kind, windup: tel.windup, radius: tel.radius,
      damage: tel.damage, blockable: tel.blockable,
      origin: vcopy(tel.origin), target: vcopy(tel.target), center: vcopy(tel.center),
      ...(kind === 'orb' ? { pathEnd: vcopy(tel.pathEnd), projectileSpeed: tel.speed } : {}),
    });
    return true;
  }

  // Путь орба фиксируется при объявлении: от origin через сохранённый target
  // по прямой до выхода с арены или пола. Никакого скрытого самонаведения.
  function setupOrbPath(tel, spec) {
    const A = C.bossAttack;
    const spawn = vcopy(tel.origin);
    spawn.y = clamp(spawn.y, A.orbMinSpawnHeight, 6);
    const lim = C.arena.radius;
    const sr = distXZ(spawn, BOSS);
    if (sr > lim) { // origin за пределами арены — прижимаем к краю
      const k = lim / sr;
      spawn.x = BOSS.x + (spawn.x - BOSS.x) * k;
      spawn.z = BOSS.z + (spawn.z - BOSS.z) * k;
    }
    const aim = vcopy(tel.target);
    aim.y = aim.y < 0.05 ? A.orbDefaultTargetHeight : clamp(aim.y, 0, 5);
    let dx = aim.x - spawn.x, dy = aim.y - spawn.y, dz = aim.z - spawn.z;
    let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.1) { // вырожденная цель: горизонтально к текущей позиции героя
      const pp = playerPos();
      dx = pp.x - spawn.x; dy = 0; dz = pp.z - spawn.z;
      len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.1) { dx = 0; dz = 1; len = 1; }
    }
    const dir = vec(dx / len, dy / len, dz / len);
    let speed = Number(spec.projectileSpeed);
    speed = Number.isFinite(speed) && speed > 0 ? clamp(speed, A.minOrbSpeed, A.maxOrbSpeed) : A.defaultOrbSpeed;
    // выход с арены (круг радиуса arena+1 в XZ)
    const Ra = C.arena.radius + 1;
    const ox = spawn.x - BOSS.x, oz = spawn.z - BOSS.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    let tExit = Infinity;
    if (a > 1e-9) {
      const b = ox * dir.x + oz * dir.z;
      const c = ox * ox + oz * oz - Ra * Ra;
      const disc = b * b - a * c;
      tExit = disc >= 0 ? Math.max(0, (-b + Math.sqrt(disc)) / a) : 0;
    }
    const tFloor = dir.y < -1e-9 ? (spawn.y + tel.radius) / -dir.y : Infinity;
    const travel = Math.min(tExit, tFloor, speed * A.orbMaxLifetime);
    tel.origin = spawn;
    tel.target = aim;
    tel.center = vcopy(spawn);
    tel.dir = dir;
    tel.speed = speed;
    tel.travel = travel;
    tel.pathEnd = vec(spawn.x + dir.x * travel, Math.max(0, spawn.y + dir.y * travel), spawn.z + dir.z * travel);
  }

  // ---------------------------------------------------------------- исход
  function finish(result) {
    if (st.status !== 'playing') return; // однократный переход
    const P = st.p, B = st.b;
    if (P.shielding) {
      P.shielding = false;
      emit('shield_end', playerPos(), { reason: 'fight_end' });
    }
    st.status = result;
    st.projectiles.length = 0;
    st.telegraphs.length = 0;
    st.pendingDash = 0;
    st.pendingBurst = false;
    st.acc = 0;
    P.dashing = false; P.firing = false; P.lateralNow = 0; P.vLat = 0;
    const stats = { ...st.stats };
    if (result === 'victory') {
      B.dead = true;
      emit('victory', bossAim(), { time: st.time, stats });
    } else {
      P.dead = true;
      P.iframe = 0; P.grace = 0;
      emit('defeat', playerPos(), { time: st.time, stats });
    }
  }

  function damageBoss(amount, source, point) {
    if (st.status !== 'playing' || !(amount > 0)) return;
    const B = st.b;
    const dealt = Math.min(B.hp, amount);
    B.hp -= dealt;
    if (B.hp < 1e-6) B.hp = 0;
    st.stats.damageDealt += dealt;
    if (source === 'burst') B.hitReact = C.boss.hitReactTime;
    emit('boss_hit', point, { amount: dealt, source, hpAfter: B.hp });
    if (B.hp <= 0) finish('victory');
  }

  // Результат удара босса определяется ДО событий (чистая функция).
  function outcomeFor(att) {
    const P = st.p;
    if (!(att.damage > 0)) return 'none';
    if (P.iframe > 0) return 'dodge';
    if (P.grace > 0) return 'grace';
    if (P.shielding && att.blockable) return 'block';
    return 'hit';
  }

  function commitOutcome(att, outcome, point, sourcePos) {
    const P = st.p;
    if (outcome === 'dodge') {
      st.stats.dodges++;
      emit('dodge', playerPos(), { attackId: att.id, attackKind: att.kind, method: 'dash' });
    } else if (outcome === 'block') {
      st.stats.blocks++;
      P.energy = Math.max(0, P.energy - C.shield.blockEnergyCost);
      P.regenDelay = C.player.energyRegenDelay;
      emit('block', point, { attackId: att.id, attackKind: att.kind, prevented: att.damage, energyAfter: P.energy });
      if (P.energy <= 0 && P.shielding) endShield('depleted');
    } else if (outcome === 'hit') {
      const amount = Math.min(P.hp, att.damage);
      P.hp -= amount;
      if (P.hp < 1e-6) P.hp = 0;
      st.stats.damageTaken += amount;
      P.grace = C.player.hitGrace;
      P.hitReact = C.player.hitReactTime;
      const pp = playerPos();
      let dx = pp.x - sourcePos.x, dz = pp.z - sourcePos.z;
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > 1e-6) { dx /= l; dz /= l; } else { dx = 0; dz = 0; }
      emit('player_hit', point, {
        amount, attackId: att.id, attackKind: att.kind,
        direction: vec(dx, 0, dz), shieldPierced: P.shielding && !att.blockable, hpAfter: P.hp,
      });
      if (P.hp <= 0) finish('defeat');
    }
  }

  // ---------------------------------------------------------------- герой
  function endShield(reason) {
    const P = st.p;
    if (!P.shielding) return;
    P.shielding = false;
    if (reason === 'depleted') P.shieldLock = true; // до отпускания щита
    emit('shield_end', playerPos(), { reason, energy: P.energy });
  }

  function updateShield(h) {
    const P = st.p, I = st.input;
    if (!I.shield) P.shieldLock = false;
    if (P.shielding) {
      if (!I.shield) { endShield(I.valid ? 'released' : 'input_lost'); return; }
      P.energy -= C.shield.drainPerSec * h;
      P.regenDelay = C.player.energyRegenDelay;
      if (P.energy <= EPS) { P.energy = 0; endShield('depleted'); }
    } else if (I.shield && !P.shieldLock) {
      if (P.energy >= C.shield.minEnergyToStart) {
        P.shielding = true;
        emit('shield_start', playerPos(), { energy: P.energy });
      } else {
        P.shieldLock = true; // одно сообщение об отказе на одно нажатие
        emit('ability_denied', playerPos(), { ability: 'shield', reason: 'energy' });
      }
    }
  }

  function tryDash() {
    const P = st.p;
    const dir = st.pendingDash;
    if (dir === 0) return;
    st.pendingDash = 0; // одна попытка на один импульс
    let reason = '';
    if (P.dashing) reason = 'active';
    else if (P.dashCd > EPS) reason = 'cooldown';
    else if (P.energy < C.dash.cost) reason = 'energy';
    if (reason) {
      emit('ability_denied', playerPos(), { ability: 'dash', reason, direction: dir });
      return;
    }
    P.dashing = true;
    P.dashElapsed = 0;
    P.dashDir = dir;
    P.dashCd = C.dash.cooldown;
    P.iframe = C.dash.iframeDuration;
    P.energy -= C.dash.cost;
    P.regenDelay = C.player.energyRegenDelay;
    const right = screenRight();
    emit('player_dash', playerPos(), {
      direction: dir,
      worldDirection: vec(right.x * dir, 0, right.z * dir),
      distance: C.dash.distance, duration: C.dash.duration, iframes: C.dash.iframeDuration,
    });
  }

  function movePlayer(h) {
    const P = st.p, cfg = C.player;
    if (P.dashing) {
      const T = C.dash.duration;
      const u0 = P.dashElapsed / T;
      const u1 = Math.min(1, (P.dashElapsed + h) / T);
      const ds = C.dash.distance * (easeOutQuad(u1) - easeOutQuad(u0));
      P.angle += cfg.moveSign * P.dashDir * ds / R;
      P.lateralNow = P.dashDir * ds / h;
      P.dashElapsed += h;
      if (P.dashElapsed >= T - EPS) {
        P.dashing = false;
        P.dashElapsed = 0;
        P.vLat = 0; // ease-out заканчивается нулевой скоростью
      }
      return;
    }
    let mx = st.input.moveX;
    const dz = cfg.moveDeadzone;
    const amx = Math.abs(mx);
    mx = amx <= dz ? 0 : Math.sign(mx) * (amx - dz) / (1 - dz);
    const target = mx * cfg.strafeSpeed * (P.shielding ? C.shield.moveSpeedFactor : 1);
    const tau = target === 0 ? cfg.stopTime : cfg.accelTime;
    P.vLat += (target - P.vLat) * (1 - Math.exp(-h / tau));
    if (target === 0 && Math.abs(P.vLat) < 0.02) P.vLat = 0;
    P.angle += cfg.moveSign * P.vLat * h / R;
    P.lateralNow = P.vLat;
  }

  function regen(h) {
    const P = st.p;
    if (P.shielding) return;
    if (P.regenDelay > 0) { P.regenDelay = Math.max(0, P.regenDelay - h); return; }
    P.energy = Math.min(C.player.maxEnergy, P.energy + C.player.energyRegen * h);
  }

  function tryBurst() {
    const P = st.p;
    if (!st.pendingBurst) return;
    st.pendingBurst = false;
    let reason = '';
    if (P.burstCd > EPS) reason = 'cooldown';
    else if (P.energy < C.burst.cost) reason = 'energy';
    if (reason) { emit('ability_denied', playerPos(), { ability: 'burst', reason }); return; }
    P.energy -= C.burst.cost;
    P.burstCd = C.burst.cooldown;
    P.regenDelay = C.player.energyRegenDelay;
    P.castTimer = C.burst.castTime;
    const pp = playerPos();
    const chest = playerChest();
    // рассеять орбы босса рядом с героем
    let cleared = 0;
    const keep = [];
    for (const pr of st.projectiles) {
      if (pr.owner === 'boss' && distXZ(pr.position, pp) <= C.burst.clearRadius) {
        cleared++;
        emit('projectile_impact', pr.position, {
          owner: 'boss', kind: pr.kind, projectileId: pr.id, attackId: pr.attackId, result: 'dispelled',
        });
      } else keep.push(pr);
    }
    st.projectiles = keep;
    const to = bossAim();
    emit('burst', chest, { amount: C.burst.damage, cleared, from: vcopy(chest), to: vcopy(to), radius: C.burst.clearRadius });
    damageBoss(C.burst.damage, 'burst', to);
  }

  function addProjectile(pr) {
    if (st.projectiles.length >= C.sim.maxProjectiles) {
      let idx = st.projectiles.findIndex(x => x.owner === 'player');
      if (idx < 0) idx = 0;
      st.projectiles.splice(idx, 1);
      st.debug.droppedProjectiles++;
    }
    st.projectiles.push(pr);
  }

  function spawnBolt() {
    const B = C.bolt;
    const pp = playerPos();
    const toBossX = BOSS.x - pp.x, toBossZ = BOSS.z - pp.z;
    const l = Math.sqrt(toBossX * toBossX + toBossZ * toBossZ) || 1;
    const fx = toBossX / l, fz = toBossZ / l;
    const right = screenRight();
    const spawn = vec(
      pp.x + fx * B.spawnForward + right.x * B.spawnSide,
      pp.y + B.spawnHeight,
      pp.z + fz * B.spawnForward + right.z * B.spawnSide,
    );
    const aim = bossAim();
    let vx = aim.x - spawn.x, vy = aim.y - spawn.y, vz = aim.z - spawn.z;
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    vx = vx / vl * B.speed; vy = vy / vl * B.speed; vz = vz / vl * B.speed;
    const id = `bolt:${fightGen}:${++projSeq}`;
    addProjectile({
      id, owner: 'player', kind: 'bolt',
      position: spawn, velocity: vec(vx, vy, vz), radius: B.radius,
      age: 0, lifetime: B.lifetime, damage: B.damage, attackId: null, passed: false,
    });
    if (B.energyCost > 0) {
      st.p.energy = Math.max(0, st.p.energy - B.energyCost);
      st.p.regenDelay = C.player.energyRegenDelay;
    }
    emit('player_cast', spawn, { ability: 'bolt', projectileId: id, velocity: vec(vx, vy, vz) });
  }

  function fireBolts(h) {
    const P = st.p;
    const can = st.input.attack && !P.shielding && !P.dashing && P.hitReact <= 0 &&
      (C.bolt.energyCost <= 0 || P.energy >= C.bolt.energyCost);
    P.firing = can;
    if (can) {
      let guard = 0;
      while (P.fireTimer <= EPS && guard++ < 4) {
        spawnBolt();
        P.fireTimer += C.bolt.interval;
      }
    }
    P.fireTimer = Math.max(0, P.fireTimer - h);
  }

  // ---------------------------------------------------------------- снаряды
  function updatePlayerProjectiles(h) {
    const list = st.projectiles;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (pr.owner !== 'player') { list[w++] = pr; continue; }
      const prev = vcopy(pr.position);
      pr.position.x += pr.velocity.x * h;
      pr.position.y += pr.velocity.y * h;
      pr.position.z += pr.velocity.z * h;
      pr.age += h;
      const hit = sweptCylinderHit(prev, pr.position, BOSS, BOSS,
        pr.radius + C.boss.hitRadius, -pr.radius, C.boss.height + pr.radius);
      if (hit.hit) {
        const point = vec(prev.x + (pr.position.x - prev.x) * hit.t,
          prev.y + (pr.position.y - prev.y) * hit.t,
          prev.z + (pr.position.z - prev.z) * hit.t);
        emit('projectile_impact', point, { owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'boss' });
        damageBoss(pr.damage, 'bolt', point);
        if (st.status !== 'playing') return; // finish уже очистил списки
        continue;
      }
      if (pr.age >= pr.lifetime || distXZ(pr.position, BOSS) > C.arena.radius + 3 || pr.position.y < -1) continue;
      list[w++] = pr;
    }
    list.length = w;
  }

  function updateTelegraphs(h) {
    const list = st.telegraphs;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      t.remaining -= h;
      if (t.remaining > EPS) { list[w++] = t; continue; }
      t.remaining = 0;
      resolveTelegraph(t);
      if (st.status !== 'playing') return;
    }
    list.length = w;
  }

  function resolveTelegraph(t) {
    if (t.kind === 'orb') {
      const id = `orb:${fightGen}:${t.id}`;
      const v = vec(t.dir.x * t.speed, t.dir.y * t.speed, t.dir.z * t.speed);
      addProjectile({
        id, owner: 'boss', kind: 'orb',
        position: vcopy(t.origin), velocity: v, radius: t.radius,
        age: 0, lifetime: Math.min(C.bossAttack.orbMaxLifetime, t.travel / t.speed + 0.1),
        damage: t.damage, blockable: t.blockable, attackId: t.id, passed: false,
      });
      emit('boss_projectile', t.origin, {
        attackId: t.id, attackKind: 'orb', projectileId: id, velocity: vcopy(v),
        radius: t.radius, pathEnd: vcopy(t.pathEnd),
      });
      return;
    }
    // slam / nova: один импульс в момент окончания windup
    emit('boss_impact', t.center, { attackId: t.id, attackKind: t.kind, radius: t.radius, blockable: t.blockable });
    const pp = playerPos();
    // Попадание: точка героя (центр под ногами) внутри нарисованного круга.
    if (distXZ(pp, t.center) <= t.radius + EPS) {
      const att = { id: t.id, kind: t.kind, damage: t.damage, blockable: t.blockable };
      const outcome = outcomeFor(att);
      const point = playerChest();
      commitOutcome(att, outcome, point, t.center);
    }
  }

  function updateBossProjectiles(h, playerPrev) {
    const list = st.projectiles;
    const playerNow = playerPos();
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (pr.owner !== 'boss') { list[w++] = pr; continue; }
      const prev = vcopy(pr.position);
      pr.position.x += pr.velocity.x * h;
      pr.position.y += pr.velocity.y * h;
      pr.position.z += pr.velocity.z * h;
      pr.age += h;
      if (!pr.passed) {
        const hit = sweptCylinderHit(prev, pr.position, playerPrev, playerNow,
          pr.radius + C.player.hitRadius, -pr.radius, C.player.height + pr.radius);
        if (hit.hit) {
          const point = vec(prev.x + (pr.position.x - prev.x) * hit.t,
            prev.y + (pr.position.y - prev.y) * hit.t,
            prev.z + (pr.position.z - prev.z) * hit.t);
          const att = { id: pr.attackId, kind: 'orb', damage: pr.damage, blockable: pr.blockable };
          const outcome = outcomeFor(att);
          if (outcome === 'dodge' || outcome === 'grace' || outcome === 'none') {
            pr.passed = true; // пролетает сквозь, повторно героя не проверяет
            commitOutcome(att, outcome, point, prev);
          } else {
            emit('projectile_impact', point, {
              owner: 'boss', kind: 'orb', projectileId: pr.id, attackId: pr.attackId, result: outcome,
            });
            commitOutcome(att, outcome, point, prev);
            if (st.status !== 'playing') return;
            continue; // орб поглощён
          }
        }
      }
      if (pr.position.y < -pr.radius) {
        emit('projectile_impact', vec(pr.position.x, 0, pr.position.z), {
          owner: 'boss', kind: 'orb', projectileId: pr.id, attackId: pr.attackId, result: 'floor',
        });
        continue;
      }
      if (pr.age >= pr.lifetime || distXZ(pr.position, BOSS) > C.arena.radius + 3) continue;
      list[w++] = pr;
    }
    list.length = w;
  }

  function updateBossYaw(h) {
    const B = st.b;
    const pp = playerPos();
    let tx = pp.x, tz = pp.z;
    if ((B.decisionAction === 'windup' || B.decisionAction === 'attack') && st.telegraphs.length) {
      const t = st.telegraphs[0];
      const focus = t.kind === 'nova' ? null : t.target;
      if (focus && distXZ(focus, BOSS) > 0.5) { tx = focus.x; tz = focus.z; }
    }
    const desired = Math.atan2(tx - BOSS.x, tz - BOSS.z);
    const diff = wrapAngle(desired - B.yaw);
    const maxTurn = C.boss.turnRate * h;
    B.yaw = wrapAngle(B.yaw + clamp(diff, -maxTurn, maxTurn));
  }

  function tickTimers(h) {
    const P = st.p, B = st.b;
    P.dashCd = Math.max(0, P.dashCd - h);
    P.burstCd = Math.max(0, P.burstCd - h);
    P.iframe = Math.max(0, P.iframe - h);
    P.grace = Math.max(0, P.grace - h);
    P.hitReact = Math.max(0, P.hitReact - h);
    P.castTimer = Math.max(0, P.castTimer - h);
    B.hitReact = Math.max(0, B.hitReact - h);
  }

  // ---------------------------------------------------------------- шаг
  function step(h) {
    callBrain(h);
    if (st.status !== 'playing') return;
    st.time += h;
    st.debug.steps++;
    tickTimers(h);
    const playerPrev = playerPos();
    updateShield(h);
    tryDash();
    movePlayer(h);
    regen(h);
    tryBurst();
    if (st.status !== 'playing') return;
    fireBolts(h);
    updatePlayerProjectiles(h);
    if (st.status !== 'playing') return;
    updateTelegraphs(h);
    if (st.status !== 'playing') return;
    updateBossProjectiles(h, playerPrev);
    if (st.status !== 'playing') return;
    updateBossYaw(h);
  }

  // ---------------------------------------------------------------- публичный API
  function update(dt, input) {
    readInput(input);
    if (st.status !== 'playing') return; // после исхода: ни шагов, ни атак
    let d = typeof dt === 'number' ? dt : Number(dt);
    if (!Number.isFinite(d) || d <= 0) d = 0;
    if (d > C.sim.maxFrameDt) { d = C.sim.maxFrameDt; st.debug.clampedFrames++; }
    st.acc += d;
    let n = 0;
    while (st.acc + EPS >= H && n < MAX_STEPS && st.status === 'playing') {
      step(H);
      st.acc -= H;
      n++;
    }
    if (st.acc < 0) st.acc = 0;
    if (st.acc > H) st.acc = H;
  }

  function reset() {
    fightGen++;
    st = freshState();
    try {
      bossBrain.reset();
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[combat] bossBrain.reset бросил исключение', err);
    }
  }

  function getSnapshot() { return buildSnapshot(); }

  function drainEvents() {
    const out = st.events;
    st.events = [];
    return out;
  }

  function getDebugInfo() {
    return {
      apiVersion: COMBAT_API_VERSION,
      ...st.debug,
      accumulator: st.acc,
      fixedStep: H,
      projectiles: st.projectiles.length,
      telegraphs: st.telegraphs.length,
      queuedEvents: st.events.length,
      seenAttackIds: st.seenIds.size,
    };
  }

  function getConfig() { return frozenConfig; }

  reset();
  return { reset, update, getSnapshot, drainEvents, getDebugInfo, getConfig };
}
