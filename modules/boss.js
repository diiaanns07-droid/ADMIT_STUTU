/*
 * ASHEN OATH — boss.js
 * Роль №5: режиссура и логика каменного стража. API_VERSION = ASHEN_V1.
 *
 *   export function createBossBrain(config)
 *     -> { reset(), update(dt, snapshot) -> BossDecision }
 *
 * Чистая логика. Нет DOM, Three.js, веб-камеры, requestAnimationFrame, Math.random,
 * Date.now и performance.now. Единственный источник времени — dt из update().
 * Пока бой на паузе и update не вызывается, все таймеры стоят. Снимок только читается.
 *
 * МОДЕЛЬ ВРЕМЕНИ (под порядок вызовов combat из контракта):
 *   combat.update(dt): d = brain.update(dt, снимок_до_кадра)
 *                      -> создать телеграфы из d.attacks (remaining = windup)
 *                      -> продвинуть телеграфы на ЭТОТ ЖЕ dt
 *                      -> ударить, когда remaining <= BOSS_TIME_EPSILON.
 *   1. Начало кадра, по снимку: смерть, стадия, старт новой атаки. AttackSpec
 *      выпускается только здесь, поэтому кадр выпуска целиком входит в windup —
 *      ровно как у телеграфа в combat.
 *   2. Фаза продвигается на dt.
 *   3. Конец кадра: windup→attack в том же update, где сумма dt с кадра выпуска
 *      достигла spec.windup (в этом же кадре combat снимает телеграф и бьёт);
 *      attack→recover→idle с переносом остатка, чтобы темп не зависел от FPS.
 *      Задержка старта атаки до начала кадра (< 1 кадра) вычитается из следующего
 *      idle, поэтому ошибка расписания ограничена и не накапливается.
 */

export const BOSS_API_VERSION = 'ASHEN_V1';


/**
 * [FEEL] Подписи телеграфа для HUD: как называется атака и чем на неё ответить. Ответ честный:
 * щит предлагается только для blockable-атак (удар ладонью щитом не держится — только уйти).
 */
export function telegraphCounter(kind, blockable) {
  const name = kind === 'slam' ? 'УДАР ЛАДОНЬЮ' : kind === 'orb' ? 'СФЕРА' : kind === 'nova' ? 'НОВА' : 'АТАКА';
  let counter;
  if (kind === 'slam') counter = blockable ? 'ЩИТ или РЫВОК из круга' : 'РЫВОК — уйди из круга';
  else if (kind === 'orb') counter = blockable ? 'ЩИТ или РЫВОК' : 'РЫВОК с линии';
  else counter = blockable ? 'ЩИТ или РЫВОК' : 'РЫВОК в момент удара';
  return { name, counter };
}

/** Общий допуск сравнения времени. Combat должен снимать телеграф при remaining <= этого значения. */
export const BOSS_TIME_EPSILON = 1e-6;

const KINDS = Object.freeze(['slam', 'orb', 'nova']);

/**
 * Начальный баланс. Пары [стадия1, стадия2]. Это настраиваемые предположения
 * до проверки человеком с реальной камерой, а не доказанная идеальная настройка.
 */
export const DEFAULT_BOSS_CONFIG = deepFreeze({
  seed: 20260928,
  maxDt: 0.1,                // защитный clamp; сборщик должен ограничивать dt не выше этого
  arenaRadius: 10,
  openingDelay: 2.5,         // пауза перед первой атакой после старта боя
  stage2Threshold: 0.5,      // hp <= maxHp * 0.5 -> стадия 2 (ровно один раз)
  shiftDuration: 2.0,        // смена стойки: безопасное окно, action = 'recover'
  stage2Opener: 'slam',      // первая атака стадии 2 — знакомая и без затрат энергии
  intro: ['slam', 'orb', 'nova'],
  // Запас на реакцию: задержка CV + реакция человека + запас на распознавание жеста.
  // Любой windup принудительно не короче суммы (или minWindup, если он больше).
  reaction: { cvLatency: 0.25, human: 0.45, margin: 0.3 },
  // [FEEL] читаемость атак: красная зона на земле видна весь замах, а за cue секунд до удара над Регентом
  // встаёт «!» (HUD, core/battleHud.js). Любой windup не короче cue + lead — «!» успевает у каждой атаки.
  telegraph: { cue: 0.9, lead: 0.2 },
  minWindup: 0,
  minRecover: 0.6,           // у каждой атаки есть recover не короче этого
  idle: { base: [1.1, 0.8], jitter: [0.25, 0.2] },
  bag: {
    stage1: { slam: 2, orb: 2, nova: 1 },
    stage2: { slam: 3, orb: 3, nova: 2 },
  },
  novaMinGap: [2, 2],        // минимум других атак между двумя nova
  novaFairness: {
    minEnergyFraction: 0.35, // nova только если энергии хватает на щит...
    dashSlack: 0.6,          // ...или рывок будет готов хотя бы за 0.6 с до удара
  },
  attacks: {
    slam: {
      windup: [1.7, 1.5], attack: 0.35, recover: [1.2, 1.0],
      radius: [2.0, 2.0], damage: [18, 22], blockable: false,
    },
    orb: {
      windup: [1.25, 1.1], attack: 0.3, recover: [1.0, 0.85],
      radius: [0.55, 0.6], damage: [12, 15], blockable: true,
      speed: [11, 12.5], originHeight: 1.2, originForward: 1.4,
    },
    nova: {
      windup: [2.1, 1.85], attack: 0.45, recover: [1.6, 1.35],
      radius: [9.5, 9.5], damage: [22, 26], blockable: true,
    },
  },
});

/** [FEEL] За сколько секунд до удара HUD ставит «!» над Регентом — из начального баланса (telegraph.cue). */
export const BOSS_CUE_SEC = DEFAULT_BOSS_CONFIG.telegraph.cue;

// Фаза мозга -> BossDecision.action. 'shift' (смена стойки) — окно для игрока.
const ACTION_OF_PHASE = Object.freeze({
  idle: 'idle', windup: 'windup', attack: 'attack',
  recover: 'recover', shift: 'recover', dead: 'dead',
});

export function createBossBrain(config) {
  const cfg = normalizeConfig(config);
  let st = freshState();

  function freshState() {
    return {
      clock: 0,
      phase: 'idle',
      phaseElapsed: 0,
      phaseDuration: cfg.openingDelay,
      stage: 1,
      stage2Pending: false,
      halted: false,
      rng: mulberry32(cfg.seed),
      idCounter: 0,
      introQueue: cfg.intro.slice(),
      forced: null,
      bag: [],
      history: [],
      attacksSinceNova: Infinity,
      current: null,   // только в windup/attack: {id, kind, attackDur, recover, aim}
      lag: 0,
      shifts: 0,
      lastSnapshotTime: null,
    };
  }

  function reset() {
    st = freshState();
  }

  function setPhase(phase, duration, elapsed) {
    st.phase = phase;
    st.phaseDuration = duration;
    st.phaseElapsed = elapsed;
  }

  function reached() {
    return st.phaseElapsed >= st.phaseDuration - BOSS_TIME_EPSILON;
  }

  function rollIdle() {
    const i = st.stage - 1;
    const u = st.rng() * 2 - 1; // один вызов ГПСЧ на цикл атаки, не на кадр
    return Math.max(0.2, cfg.idle.base[i] + u * cfg.idle.jitter[i]);
  }

  function enterIdle(carry) {
    const duration = rollIdle();
    setPhase('idle', duration, carry + st.lag);
    st.lag = 0;
  }

  function enterShift(out, carry, minDuration) {
    st.stage = 2;
    st.stage2Pending = false;
    st.shifts += 1;
    st.bag = [];
    st.current = null;
    st.forced = (st.introQueue.length === 0 && cfg.stage2Opener) ? cfg.stage2Opener : null;
    out.stageChanged = true;
    setPhase('shift', Math.max(cfg.shiftDuration, minDuration), carry);
  }

  function enterDead() {
    st.current = null;
    st.stage2Pending = false;
    setPhase('dead', Infinity, 0);
  }

  function isAllowed(kind, snap) {
    const i = st.stage - 1;
    const h = st.history;
    const n = h.length;
    if (n >= 2 && h[n - 1] === kind && h[n - 2] === kind) return false; // без троек подряд
    if (kind === 'nova') {
      if (n >= 1 && h[n - 1] === 'nova') return false;
      if (st.attacksSinceNova < cfg.novaMinGap[i]) return false;
      if (!novaIsFair(snap, i)) return false;
    }
    return true;
  }

  // NOVA честна, если у игрока есть реальная контригра: энергия на щит
  // или рывок, который успеет перезарядиться до удара.
  function novaIsFair(snap, i) {
    const f = cfg.novaFairness;
    const energyKnown = isNum(snap.energy) && isNum(snap.maxEnergy) && snap.maxEnergy > 0;
    const energyOk = !energyKnown || snap.energy >= snap.maxEnergy * f.minEnergyFraction;
    const windup = cfg.attacks.nova.windup[i];
    const dashOk = isNum(snap.dashRemaining) && snap.dashRemaining <= Math.max(0, windup - f.dashSlack);
    return energyOk || dashOk;
  }

  function fallbackKind(snap) {
    if (isAllowed('slam', snap)) return 'slam';
    if (isAllowed('orb', snap)) return 'orb';
    return 'slam';
  }

  function makeBag() {
    const counts = st.stage === 1 ? cfg.bag.stage1 : cfg.bag.stage2;
    const arr = [];
    for (const k of KINDS) for (let c = 0; c < counts[k]; c++) arr.push(k);
    for (let i = arr.length - 1; i > 0; i--) { // Fisher–Yates на seed-ГПСЧ
      const j = Math.floor(st.rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function chooseKind(snap) {
    if (st.introQueue.length > 0) {
      const k = st.introQueue[0];
      if (isAllowed(k, snap)) { st.introQueue.shift(); return k; }
      return fallbackKind(snap); // знакомство продолжится, когда атака станет честной
    }
    if (st.forced) {
      const k = st.forced;
      st.forced = null;
      if (isAllowed(k, snap)) return k;
    }
    if (st.bag.length === 0) st.bag = makeBag();
    for (let i = 0; i < st.bag.length; i++) {
      if (isAllowed(st.bag[i], snap)) return st.bag.splice(i, 1)[0];
    }
    return fallbackKind(snap);
  }

  function beginAttack(snap) {
    const kind = chooseKind(snap);
    const i = st.stage - 1;
    const a = cfg.attacks[kind];
    const b = snap.bossPos;
    const p = snap.playerPos;
    let origin;
    let target;
    let aim;
    let projectileSpeed = 0;

    if (kind === 'slam') {
      origin = { x: b.x, y: 0, z: b.z };
      target = clampToArena({ x: p.x, y: 0, z: p.z }, cfg.arenaRadius);
      aim = copyVec(target);
    } else if (kind === 'orb') {
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      const dist = Math.hypot(dx, dz);
      const ux = dist > 1e-4 ? dx / dist : 0;
      const uz = dist > 1e-4 ? dz / dist : 1;
      const fwd = Math.min(a.originForward, dist * 0.5);
      origin = { x: b.x + ux * fwd, y: b.y + a.originHeight, z: b.z + uz * fwd };
      target = { x: p.x, y: p.y, z: p.z };
      aim = copyVec(target);
      projectileSpeed = a.speed[i];
    } else {
      origin = { x: b.x, y: 0, z: b.z };
      target = { x: b.x, y: 0, z: b.z };
      aim = { x: p.x, y: 0, z: p.z };
    }

    st.idCounter += 1;
    const spec = {
      id: 'boss-' + st.idCounter + '-' + kind,
      kind,
      origin,
      target,
      windup: a.windup[i],
      radius: a.radius[i],
      damage: a.damage[i],
      blockable: a.blockable,
      projectileSpeed,
      stage: st.stage, // расширение: для визуала стадии
      cue: Math.min(cfg.telegraph.cue, a.windup[i]), // [FEEL] расширение: за сколько секунд до удара «!» над Регентом
    };

    st.current = { id: spec.id, kind, attackDur: a.attack, recover: a.recover[i], aim };
    st.history.push(kind);
    if (st.history.length > 4) st.history.shift();
    st.attacksSinceNova = kind === 'nova' ? 0 : st.attacksSinceNova + 1;
    setPhase('windup', spec.windup, 0);
    return spec;
  }

  function finish(out) {
    out.stage = st.stage;
    out.pose = st.phase;
    out.action = ACTION_OF_PHASE[st.phase] || 'idle';
    out.kind = st.current ? st.current.kind : null;
    out.aim = st.current ? copyVec(st.current.aim) : null;
    return out;
  }

  function update(dt, snapshot) {
    const step = sanitizeDt(dt, cfg.maxDt);
    const out = {
      stage: st.stage, action: 'idle', attacks: [],
      impactIds: [], stageChanged: false, pose: 'idle', kind: null, aim: null,
    };

    if (st.phase === 'dead') return finish(out);
    if (!snapshot || typeof snapshot !== 'object') return finish(out); // нет данных — время не идёт

    const snap = readSnapshot(snapshot);
    st.lastSnapshotTime = snap.time;

    if (snap.bossDead) { enterDead(); return finish(out); }
    if (st.halted) return finish(out);
    if (snap.playerDead) {
      st.halted = true;
      st.current = null;
      st.stage2Pending = false;
      setPhase('idle', Infinity, 0);
      return finish(out);
    }
    if (snap.status !== 'playing') return finish(out); // неизвестный статус: заморозка

    // --- начало кадра ---
    if (st.stage === 1 && !st.stage2Pending && snap.hpKnown &&
        snap.hp <= snap.maxHp * cfg.stage2Threshold) {
      st.stage2Pending = true; // объявленная атака не отменяется: смена стойки после неё
    }
    if (st.stage2Pending && (st.phase === 'idle' || st.phase === 'recover')) {
      enterShift(out, 0, 0);
    }
    if (st.phase === 'idle' && reached()) {
      st.lag = clamp(st.phaseElapsed - st.phaseDuration, 0, cfg.maxDt);
      out.attacks.push(beginAttack(snap));
    }

    // --- продвижение ---
    st.clock += step;
    st.phaseElapsed += step;

    // --- конец кадра ---
    for (let guard = 0; guard < 6 && reached(); guard++) {
      const carry = Math.max(0, st.phaseElapsed - st.phaseDuration);
      if (st.phase === 'windup') {
        out.impactIds.push(st.current.id);
        setPhase('attack', st.current.attackDur, carry);
      } else if (st.phase === 'attack') {
        const rec = st.current.recover;
        st.current = null;
        if (st.stage2Pending) enterShift(out, carry, rec);
        else setPhase('recover', rec, carry);
      } else if (st.phase === 'recover' || st.phase === 'shift') {
        enterIdle(carry);
      } else {
        break; // idle: новая атака стартует только в начале следующего кадра
      }
    }
    return finish(out);
  }

  /** Расширение для debug-оверлея и тестов. Возвращает копию, ничего не меняет. */
  function getDebug() {
    return {
      phase: st.phase,
      phaseElapsed: st.phaseElapsed,
      phaseDuration: st.phaseDuration,
      phaseRemaining: Math.max(0, st.phaseDuration - st.phaseElapsed),
      stage: st.stage,
      stage2Pending: st.stage2Pending,
      halted: st.halted,
      clock: st.clock,
      lastSnapshotTime: st.lastSnapshotTime,
      idCounter: st.idCounter,
      currentAttackId: st.current ? st.current.id : null,
      currentKind: st.current ? st.current.kind : null,
      // [FEEL] до удара и до «!» над Регентом (только в windup)
      impactIn: st.phase === 'windup' ? Math.max(0, st.phaseDuration - st.phaseElapsed) : null,
      cueIn: st.phase === 'windup' ? Math.max(0, st.phaseDuration - st.phaseElapsed - cfg.telegraph.cue) : null,
      introQueue: st.introQueue.slice(),
      bag: st.bag.slice(),
      history: st.history.slice(),
      shifts: st.shifts,
    };
  }

  return { reset, update, getDebug, getConfig: () => cfg };
}

/**
 * Таблица начального баланса из фактической конфигурации.
 * assumptions — предположения о combat (радиус героя, дистанция), не проверенные значения.
 */
export function describeBossBalance(config, assumptions) {
  const cfg = normalizeConfig(config);
  const as = Object.assign({ playerRadius: 0.45, distance: 6 }, assumptions || {});
  const react = cfg.reaction.cvLatency + cfg.reaction.human;
  const rows = [];
  for (let i = 0; i < 2; i++) {
    for (const kind of KINDS) {
      const a = cfg.attacks[kind];
      const row = {
        stage: i + 1,
        kind,
        windup: a.windup[i],
        attack: a.attack,
        recover: a.recover[i],
        idle: cfg.idle.base[i],
        punishWindow: round(a.attack + a.recover[i] + cfg.idle.base[i]),
        damage: a.damage[i],
        radius: a.radius[i],
        blockable: a.blockable,
        counter: '',
        note: '',
      };
      if (kind === 'slam') {
        const avail = a.windup[i] - react;
        row.counter = 'выйти из круга / рывок';
        row.note = 'нужна скорость стрейфа >= ' + round((a.radius[i] + as.playerRadius) / avail) + ' м/с';
      } else if (kind === 'orb') {
        const fwd = Math.min(a.originForward, as.distance * 0.5);
        const flight = Math.hypot(as.distance - fwd, a.originHeight) / a.speed[i];
        const avail = a.windup[i] + flight - react;
        row.counter = 'сместиться / щит';
        row.note = 'полёт ~' + round(flight) + ' с; стрейф >= ' + round((a.radius[i] + as.playerRadius) / avail) + ' м/с';
      } else {
        row.counter = 'щит / рывок в момент удара';
        row.note = 'запас на подъём щита ' + round(a.windup[i] - react) + ' с';
      }
      rows.push(row);
    }
  }
  return {
    windupFloor: cfg.windupFloor,
    reactionAssumed: round(react),
    rows,
  };
}

// ----------------------------------------------------------------------------
// Внутренние помощники

function readSnapshot(s) {
  const boss = isObj(s.boss) ? s.boss : {};
  const player = isObj(s.player) ? s.player : {};
  const cd = isObj(s.cooldowns) ? s.cooldowns : {};
  const status = typeof s.status === 'string' ? s.status : 'playing';
  const bossPos = readVec(boss.position, { x: 0, y: 0, z: 0 });
  const playerPos = readVec(player.position, { x: bossPos.x, y: 0, z: bossPos.z + 6 });
  const hp = boss.hp;
  const maxHp = boss.maxHp;
  return {
    status,
    time: isNum(s.time) ? s.time : null,
    bossPos,
    playerPos,
    hp,
    maxHp,
    hpKnown: isNum(hp) && isNum(maxHp) && maxHp > 0,
    bossDead: status === 'victory' || boss.action === 'dead' || (isNum(hp) && hp <= 0),
    playerDead: status === 'defeat' || player.action === 'dead' || (isNum(player.hp) && player.hp <= 0),
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    dashRemaining: cd.dashRemaining,
  };
}

function normalizeConfig(input) {
  const raw = isObj(input) ? input : {};
  const src = isObj(raw.boss)
    ? Object.assign({}, raw.boss, { seed: raw.boss.seed !== undefined ? raw.boss.seed : raw.seed })
    : raw;
  const D = DEFAULT_BOSS_CONFIG;
  const o = (v) => (isObj(v) ? v : {});

  const rs = o(src.reaction);
  const reaction = {
    cvLatency: num(rs.cvLatency, D.reaction.cvLatency, 0),
    human: num(rs.human, D.reaction.human, 0),
    margin: num(rs.margin, D.reaction.margin, 0),
  };
  const ts = o(src.telegraph);
  const telegraph = { cue: clamp(num(ts.cue, D.telegraph.cue, 0), 0, 3), lead: clamp(num(ts.lead, D.telegraph.lead, 0), 0, 2) };
  const windupFloor = Math.max(num(src.minWindup, D.minWindup, 0),
    reaction.cvLatency + reaction.human + reaction.margin, telegraph.cue + telegraph.lead);
  const minRecover = num(src.minRecover, D.minRecover, 0);

  const as = o(src.attacks);
  const attacks = {};
  for (const kind of KINDS) {
    const s = o(as[kind]);
    const d = D.attacks[kind];
    attacks[kind] = {
      windup: pair(s.windup, d.windup, 0.01).map((w) => Math.max(w, windupFloor)),
      attack: num(s.attack, d.attack, 0.05),
      recover: pair(s.recover, d.recover, 0).map((r) => Math.max(r, minRecover)),
      radius: pair(s.radius, d.radius, 0.05),
      damage: pair(s.damage, d.damage, 0),
      blockable: typeof s.blockable === 'boolean' ? s.blockable : d.blockable,
      speed: kind === 'orb' ? pair(s.speed, d.speed, 0.5) : [0, 0],
      originHeight: kind === 'orb' ? num(s.originHeight, d.originHeight, 0) : 0,
      originForward: kind === 'orb' ? num(s.originForward, d.originForward, 0) : 0,
    };
  }

  const is = o(src.idle);
  const idleBase = pair(is.base, D.idle.base, 0.2);
  const idleJitter = pair(is.jitter, D.idle.jitter, 0);

  const bs = o(src.bag);
  const bag = { stage1: readBag(bs.stage1, D.bag.stage1), stage2: readBag(bs.stage2, D.bag.stage2) };

  const intro = Array.isArray(src.intro)
    ? src.intro.filter((k) => KINDS.includes(k)).slice(0, 6)
    : D.intro.slice();

  let opener = D.stage2Opener;
  if (src.stage2Opener === null) opener = null;
  else if (KINDS.includes(src.stage2Opener)) opener = src.stage2Opener;

  const nf = o(src.novaFairness);
  const gap = pair(src.novaMinGap, D.novaMinGap, 0).map((g) => Math.floor(g));

  const thr = src.stage2Threshold;

  return deepFreeze({
    seed: normalizeSeed(src.seed, D.seed),
    maxDt: num(src.maxDt, D.maxDt, 0.001),
    arenaRadius: num(src.arenaRadius, D.arenaRadius, 1),
    openingDelay: num(src.openingDelay, D.openingDelay, 0),
    stage2Threshold: isNum(thr) && thr > 0 && thr < 1 ? thr : D.stage2Threshold,
    shiftDuration: num(src.shiftDuration, D.shiftDuration, 0),
    stage2Opener: opener,
    intro,
    reaction,
    telegraph,
    windupFloor,
    minRecover,
    idle: { base: idleBase, jitter: idleJitter },
    bag,
    novaMinGap: gap,
    novaFairness: {
      minEnergyFraction: clamp(num(nf.minEnergyFraction, D.novaFairness.minEnergyFraction, 0), 0, 1),
      dashSlack: num(nf.dashSlack, D.novaFairness.dashSlack, 0),
    },
    attacks,
  });
}

function readBag(v, fallback) {
  const s = isObj(v) ? v : {};
  const out = {};
  let total = 0;
  for (const k of KINDS) {
    const c = s[k];
    out[k] = isNum(c) && c >= 0 && c <= 10 ? Math.floor(c) : fallback[k];
    total += out[k];
  }
  if (total === 0 || out.slam + out.orb === 0) return Object.assign({}, fallback);
  return out;
}

function sanitizeDt(dt, maxDt) {
  if (!isNum(dt) || dt <= 0) return 0;
  return dt > maxDt ? maxDt : dt;
}

function readVec(v, fallback) {
  if (isObj(v) && isNum(v.x) && isNum(v.z)) {
    return { x: v.x, y: isNum(v.y) ? v.y : 0, z: v.z };
  }
  return { x: fallback.x, y: fallback.y, z: fallback.z };
}

function clampToArena(p, radius) {
  const r = Math.hypot(p.x, p.z);
  if (r <= radius || r === 0) return p;
  const k = radius / r;
  return { x: p.x * k, y: p.y, z: p.z * k };
}

function copyVec(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function pair(v, fallback, min) {
  if (Array.isArray(v)) {
    const a = num(v[0], fallback[0], min);
    const b = num(v.length > 1 ? v[1] : v[0], fallback[1], min);
    return [a, b];
  }
  if (isNum(v)) return [num(v, fallback[0], min), num(v, fallback[1], min)];
  return [fallback[0], fallback[1]];
}

function num(v, fallback, min) {
  return isNum(v) && v >= min ? v : fallback;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function normalizeSeed(seed, fallback) {
  if (isNum(seed)) return (Math.floor(seed) >>> 0) || 1;
  if (typeof seed === 'string' && seed.length > 0) {
    let h = 0x811c9dc5; // FNV-1a
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h || 1;
  }
  return fallback;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}
