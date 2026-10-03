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
 *
 * [W5-СЛОЖНОСТЬ] ПОВЕДЕНИЕ ПО СЛОЖНОСТИ. Уровень приходит в снимке (snapshot.difficulty — его ставит
 * combat.setDifficulty) или через brain.setDifficulty(level). «Лёгкая», «Обычная» и «Испытание» — начальный
 * баланс без изменений; «Сложная» и «Кошмар» — профили BOSS_DIFFICULTY поверх него:
 *   короче замахи и паузы, раньше вторая стадия, упреждение прицела (удар и сфера — туда, куда идёт герой),
 *   связки (следующая атака сразу после удара, без окна отдыха), новые приёмы в мешке атак:
 *   'double' — двойной удар ладонью, 'volley' — залп сфер веером, 'trap' — «Каменный капкан» (Кошмар:
 *   несколько кругов удара на полу вокруг героя, выход — рывок поперёк), и финт (замах обрывается —
 *   decision.cancelIds — и сразу начинается настоящая атака с полным честным замахом).
 *   Честность для камеры: любой замах не короче FAIR_MIN_WINDUP (0,45 с), реакции (cvLatency + human + margin)
 *   и cue + lead — «!» над Регентом успевает у каждой атаки; профили только сужают этот запас, не отменяют.
 */

export const BOSS_API_VERSION = 'ASHEN_V1';


/**
 * [FEEL] Подписи телеграфа для HUD: как называется атака и чем на неё ответить. Ответ честный:
 * щит предлагается только для blockable-атак (удар ладонью щитом не держится — только уйти).
 */
export function telegraphCounter(kind, blockable, move) {
  // [W5-СЛОЖНОСТЬ] составные приёмы «Сложной» и «Кошмара» — свои подписи (ответ тот же, что у базового вида)
  if (move === 'double') return { name: 'ДВОЙНОЙ УДАР', counter: 'РЫВОК из круга — и ещё раз' };
  if (move === 'volley') return { name: 'ЗАЛП СФЕР', counter: blockable ? 'ЩИТ — держи до последней' : 'РЫВОК с линии' };
  if (move === 'trap') return { name: 'КАМЕННЫЙ КАПКАН', counter: 'РЫВОК к Регенту или от него' };
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
// [W5-СЛОЖНОСТЬ] приёмы в мешке атак: базовые виды + составные. Составной приём — несколько AttackSpec
// базовых видов (визуал и разрешение удара — как у обычных, новой графики не нужно).
const MOVES = Object.freeze(['slam', 'orb', 'nova', 'double', 'volley', 'trap']);
const BASE_OF_MOVE = Object.freeze({ slam: 'slam', orb: 'orb', nova: 'nova', double: 'slam', volley: 'orb', trap: 'slam' });
/** [W5-СЛОЖНОСТЬ] Абсолютный пол замаха: задержка камеры 100–200 мс + реакция — короче не бывает ни на одном уровне. */
export const FAIR_MIN_WINDUP = 0.45;
// [W5-СЛОЖНОСТЬ] финт обрывает замах не позже чем за FEINT_CUE_MARGIN до «!» и не раньше FEINT_MIN_SHOWN от начала
const FEINT_CUE_MARGIN = 0.1;
const FEINT_MIN_SHOWN = 0.2;

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
  // [W5-СЛОЖНОСТЬ] Приёмы «Сложной» и «Кошмара». В начальном балансе выключены (нули), пары [стадия1, стадия2].
  aimLead: [0, 0],           // упреждение: доля пути героя за время до удара (0 — бьёт туда, где герой сейчас)
  aimLeadMax: 4.5,           // м: дальше упреждение не выносится
  chain: {
    chance: [0, 0],          // после удара — сразу следующая атака (без recover и паузы) с этой вероятностью
    gap: 0.15,               // с: пауза между ударом и замахом связки
    windupMul: 0.85,         // замах связки короче (но не ниже пола честности)
  },
  feint: { chance: [0, 0], at: [0.35, 0.6] }, // финт: замах обрывается на доле at — и сразу настоящая атака
  double: { windup: 0.8 },   // второй удар «двойного удара»: замах (не ниже пола), цель — куда ушёл герой
  volley: { count: 3, spreadDeg: 14, stagger: 0.18, damageMul: 0.8 }, // залп сфер веером, сферы — одна за другой
  trap: { count: 3, spacing: 2.9, windup: [1.2, 1.05], damageMul: 0.9 }, // «Каменный капкан»: круги вдоль пути героя
});

/**
 * [W5-СЛОЖНОСТЬ] Поведение Регента по сложности — поверх начального баланса (createBossBrain(config) — база).
 * easy / normal / challenge / base: null — начальный баланс без изменений («Испытание» и прежние тесты те же).
 * Замахи: «Сложная» — от 0,85 с (cue 0,7 + lead 0,15), «Кошмар» — от 0,7 с (0,58 + 0,12); оба выше FAIR_MIN_WINDUP.
 */
export const BOSS_DIFFICULTY = deepFreeze({
  easy: null,
  normal: null,
  hard: {
    openingDelay: 2.0,
    stage2Threshold: 0.6,    // вторая стадия раньше: при 60% здоровья
    shiftDuration: 1.6,
    reaction: { cvLatency: 0.2, human: 0.45, margin: 0.1 },
    telegraph: { cue: 0.7, lead: 0.15 },
    minRecover: 0.5,
    // серии с передышками: связки и составные приёмы, между сериями — пауза (угроз в минуту ненамного больше, чем
    // на «Обычной», но каждая требует ответа — упреждение не даёт автоходу уйти самому)
    idle: { base: [2.3, 1.8], jitter: [0.4, 0.3] },
    bag: {
      stage1: { slam: 1, orb: 2, nova: 1, double: 1, volley: 1, trap: 0 },
      stage2: { slam: 1, orb: 1, nova: 1, double: 2, volley: 2, trap: 0 },
    },
    novaMinGap: [3, 3],
    aimLead: [0.45, 0.6],
    chain: { chance: [0.25, 0.35], gap: 0.15, windupMul: 0.9 },
    feint: { chance: [0.1, 0.15], at: [0.35, 0.6] },
    double: { windup: 1.0 },
    volley: { count: 3, spreadDeg: 14, stagger: 0.18, damageMul: 0.8 },
    attacks: {
      slam: { windup: [1.3, 1.15], recover: [1.0, 0.85], damage: [15, 17] },
      orb: { windup: [1.05, 0.95], recover: [0.85, 0.7], speed: [12, 13.5] },
      nova: { windup: [1.65, 1.45], recover: [1.25, 1.05], damage: [24, 28] },
    },
  },
  nightmare: {
    openingDelay: 1.6,
    stage2Threshold: 0.7,    // вторая стадия почти сразу — при 70% здоровья
    shiftDuration: 1.3,
    reaction: { cvLatency: 0.15, human: 0.4, margin: 0.1 },
    telegraph: { cue: 0.58, lead: 0.12 },
    minRecover: 0.4,
    idle: { base: [2.0, 1.6], jitter: [0.35, 0.3] },
    bag: {
      stage1: { slam: 2, orb: 1, nova: 1, double: 1, volley: 1, trap: 1 },
      stage2: { slam: 1, orb: 1, nova: 1, double: 2, volley: 2, trap: 2 },
    },
    novaMinGap: [2, 2],
    aimLead: [0.75, 0.9],
    chain: { chance: [0.35, 0.45], gap: 0.12, windupMul: 0.85 },
    feint: { chance: [0.15, 0.2], at: [0.3, 0.55] },
    double: { windup: 0.8 },
    volley: { count: 4, spreadDeg: 12, stagger: 0.16, damageMul: 0.8 },
    trap: { count: 3, spacing: 2.9, windup: [1.05, 0.95], damageMul: 0.9 },
    attacks: {
      slam: { windup: [1.1, 0.95], recover: [0.8, 0.65], radius: [2.2, 2.3] },
      orb: { windup: [0.9, 0.8], recover: [0.65, 0.55], speed: [13, 14.5] },
      nova: { windup: [1.4, 1.2], recover: [1.0, 0.85] },
    },
  },
});

/** [W5-СЛОЖНОСТЬ] Уровень из снимка: строка или { level }. Неизвестное — null (начальный баланс). */
export function difficultyOfSnapshot(s) {
  const d = isObj(s) ? s.difficulty : null;
  const lv = typeof d === 'string' ? d : isObj(d) && typeof d.level === 'string' ? d.level : null;
  return lv;
}

/** [FEEL] За сколько секунд до удара HUD ставит «!» над Регентом — из начального баланса (telegraph.cue). */
export const BOSS_CUE_SEC = DEFAULT_BOSS_CONFIG.telegraph.cue;

// Фаза мозга -> BossDecision.action. 'shift' (смена стойки) — окно для игрока.
const ACTION_OF_PHASE = Object.freeze({
  idle: 'idle', windup: 'windup', attack: 'attack',
  recover: 'recover', shift: 'recover', dead: 'dead',
});

export function createBossBrain(config) {
  // [W5-СЛОЖНОСТЬ] база (config) + профиль уровня; нормализованные конфиги — в кэше по уровню
  const baseInput = isObj(config) ? config : {};
  const cfgCache = new Map();
  let level = null;
  let cfg = configFor(null);
  let st = freshState();

  function configFor(lv) {
    const key = lv && BOSS_DIFFICULTY[lv] ? lv : '';
    if (!cfgCache.has(key)) cfgCache.set(key, normalizeConfig(key ? withProfile(baseInput, BOSS_DIFFICULTY[key]) : baseInput));
    return cfgCache.get(key);
  }
  // Сменить уровень: со следующего кадра. Пока бой не начался (пауза перед первой атакой) — и пауза по уровню.
  function useLevel(lv) {
    const next = typeof lv === 'string' && lv ? lv : null;
    if (next === level) return;
    level = next;
    const prevOpening = cfg.openingDelay;
    cfg = configFor(level);
    if (st.phase === 'idle' && st.idCounter === 0 && st.phaseDuration === prevOpening) st.phaseDuration = cfg.openingDelay;
  }

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
      current: null,   // только в windup/attack: {id, ids, kind, move, attackDur, recover, aim, feintAt}
      lag: 0,
      shifts: 0,
      lastSnapshotTime: null,
      followUp: null,  // [W5-СЛОЖНОСТЬ] связка: { move|null, windupMul, windup } — следующая атака без отдыха
      chains: 0, feints: 0,
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
    st.followUp = null;
    st.forced = (st.introQueue.length === 0 && cfg.stage2Opener) ? cfg.stage2Opener : null;
    out.stageChanged = true;
    setPhase('shift', Math.max(cfg.shiftDuration, minDuration), carry);
  }

  function enterDead() {
    st.current = null;
    st.followUp = null;
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
  const moveAllowed = (move, snap) => isAllowed(BASE_OF_MOVE[move] || move, snap);
  let windupMulHint = 1;   // [W5-СЛОЖНОСТЬ] множитель замаха выбираемой атаки (связка короче) — для честности новы

  // NOVA честна, если у игрока есть реальная контригра: энергия на щит
  // или рывок, который успеет перезарядиться до удара.
  function novaIsFair(snap, i) {
    const f = cfg.novaFairness;
    const energyKnown = isNum(snap.energy) && isNum(snap.maxEnergy) && snap.maxEnergy > 0;
    const energyOk = !energyKnown || snap.energy >= snap.maxEnergy * f.minEnergyFraction;
    // [W5-СЛОЖНОСТЬ] нова из связки — с укороченным замахом: проверяем тот замах, который будет на самом деле
    const windup = windupMulHint === 1 ? cfg.attacks.nova.windup[i] : Math.max(cfg.windupFloor, cfg.attacks.nova.windup[i] * windupMulHint);
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
    for (const k of MOVES) for (let c = 0; c < (counts[k] || 0); c++) arr.push(k);
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
      if (moveAllowed(st.bag[i], snap)) return st.bag.splice(i, 1)[0];
    }
    return fallbackKind(snap);
  }

  // [W5-СЛОЖНОСТЬ] упреждение: куда придёт герой за t секунд (доля aimLead пути, не дальше aimLeadMax)
  function leadPoint(snap, t) {
    const p = snap.playerPos, v = snap.playerVel, k = cfg.aimLead[st.stage - 1];
    if (!(k > 0) || !v) return { x: p.x, y: p.y, z: p.z };
    let dx = v.x * t * k, dz = v.z * t * k;
    const d = Math.hypot(dx, dz);
    if (d > cfg.aimLeadMax) { dx *= cfg.aimLeadMax / d; dz *= cfg.aimLeadMax / d; }
    return clampToArena({ x: p.x + dx, y: p.y, z: p.z + dz }, cfg.arenaRadius);
  }

  function makeSpec(kind, windup, snap, opt) {
    const o = opt || {};
    const i = st.stage - 1;
    const a = cfg.attacks[kind];
    const b = snap.bossPos;
    let origin;
    let target;
    let projectileSpeed = 0;
    if (kind === 'slam') {
      origin = { x: b.x, y: 0, z: b.z };
      const c = o.at || leadPoint(snap, windup);
      target = clampToArena({ x: c.x, y: 0, z: c.z }, cfg.arenaRadius);
    } else if (kind === 'orb') {
      const p0 = o.at || snap.playerPos;
      const dx = p0.x - b.x;
      const dz = p0.z - b.z;
      const dist = Math.hypot(dx, dz);
      const ux = dist > 1e-4 ? dx / dist : 0;
      const uz = dist > 1e-4 ? dz / dist : 1;
      const fwd = Math.min(a.originForward, dist * 0.5);
      origin = { x: b.x + ux * fwd, y: b.y + a.originHeight, z: b.z + uz * fwd };
      projectileSpeed = a.speed[i];
      // упреждение сферы: замах + полёт
      const p = o.at ? p0 : leadPoint(snap, windup + Math.max(0, dist - fwd) / projectileSpeed);
      target = { x: p.x, y: snap.playerPos.y, z: p.z };
    } else {
      origin = { x: b.x, y: 0, z: b.z };
      target = { x: b.x, y: 0, z: b.z };
    }
    st.idCounter += 1;
    return {
      id: 'boss-' + st.idCounter + '-' + kind,
      kind,
      origin,
      target,
      windup,
      radius: a.radius[i],
      damage: Math.round(a.damage[i] * (isNum(o.damageMul) ? o.damageMul : 1)),
      blockable: a.blockable,
      projectileSpeed,
      stage: st.stage, // расширение: для визуала стадии
      cue: Math.min(cfg.telegraph.cue, windup), // [FEEL] расширение: за сколько секунд до удара «!» над Регентом
      ...(o.move && o.move !== kind ? { move: o.move } : {}), // [W5-СЛОЖНОСТЬ] расширение: составной приём (подпись HUD)
    };
  }

  // Выпуск атаки (одного или нескольких AttackSpec) в начале кадра. Возвращает массив.
  function beginAttack(snap, opts) {
    const o = opts || {};
    const fu = o.followUp || null;
    windupMulHint = fu && !fu.move && fu.windupMul ? fu.windupMul : 1;
    const move = fu && fu.move ? fu.move : chooseKind(snap);
    windupMulHint = 1;
    const label = fu && fu.from ? fu.from : move;   // второй удар «двойного» подписан как «двойной»
    const kind = BASE_OF_MOVE[move] || 'slam';
    const i = st.stage - 1;
    const a = cfg.attacks[kind];
    const fair = (w) => Math.max(cfg.windupFloor, w);
    let windup = fu ? fair(fu.windup !== undefined ? fu.windup : a.windup[i] * fu.windupMul) : a.windup[i];
    const specs = [];
    if (move === 'volley') {
      // залп: сферы веером вокруг упреждённой точки, каждая следующая — позже на stagger
      const V = cfg.volley;
      const b = snap.bossPos;
      const c = leadPoint(snap, windup + 0.4);
      const n = V.count;
      for (let k = 0; k < n; k++) {
        const ang = ((k - (n - 1) / 2) * V.spreadDeg) * Math.PI / 180;
        const dx = c.x - b.x, dz = c.z - b.z;
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const at = { x: b.x + dx * cs - dz * sn, y: snap.playerPos.y, z: b.z + dx * sn + dz * cs };
        specs.push(makeSpec('orb', windup + k * V.stagger, snap, { at, damageMul: V.damageMul, move }));
      }
    } else if (move === 'trap') {
      // «Каменный капкан»: круги вдоль пути героя (по касательной к обходу), выход — поперёк, к Регенту или от него
      const T = cfg.trap;
      windup = fu ? windup : fair(T.windup[i]);
      const c = leadPoint(snap, windup);
      const b = snap.bossPos;
      const rx = c.x - b.x, rz = c.z - b.z, r = Math.hypot(rx, rz) || 1;
      const tx = -rz / r, tz = rx / r;
      const n = T.count;
      for (let k = 0; k < n; k++) {
        const off = (k - (n - 1) / 2) * T.spacing;
        specs.push(makeSpec('slam', windup, snap, { at: { x: c.x + tx * off, y: 0, z: c.z + tz * off }, damageMul: T.damageMul, move }));
      }
    } else {
      specs.push(makeSpec(kind, windup, snap, { move: label }));
    }
    const last = specs[specs.length - 1];
    const aim = kind === 'nova' ? { x: snap.playerPos.x, y: 0, z: snap.playerPos.z } : copyVec(last.target);
    // финт: только у обычной атаки не из связки; замах оборвётся на доле at (feintAt — от начала замаха)
    let feintAt = null;
    if (!fu && !o.noFeint && specs.length === 1 && cfg.feint.chance[i] > 0 && st.rng() < cfg.feint.chance[i]) {
      const f = cfg.feint.at;
      const at = windup * (f[0] + st.rng() * Math.max(0, f[1] - f[0]));
      // обрыв — до «!» над Регентом: «!» значит «удар будет», после него финта нет (замах слишком короткий — без финта)
      const latest = windup - Math.min(cfg.telegraph.cue, windup) - FEINT_CUE_MARGIN;
      if (latest >= FEINT_MIN_SHOWN) feintAt = Math.min(at, latest);
    }
    st.current = {
      id: last.id, ids: specs.map((s) => s.id), kind, move,
      attackDur: a.attack, recover: a.recover[i], aim, feintAt,
      // [W5-СЛОЖНОСТЬ] залп: у каждой сферы свой момент удара — impactIds в свой кадр (по возрастанию замаха)
      impacts: specs.map((sp) => ({ id: sp.id, at: sp.windup })).sort((x, y) => x.at - y.at),
    };
    st.history.push(kind);
    if (st.history.length > 4) st.history.shift();
    st.attacksSinceNova = kind === 'nova' ? 0 : st.attacksSinceNova + 1;
    // двойной удар: второй удар — связкой сразу после первого, туда, куда ушёл герой
    st.followUp = move === 'double' ? { move: 'slam', windup: cfg.double.windup, from: 'double' } : null;
    setPhase('windup', Math.max(...specs.map((s) => s.windup)), 0);
    return specs;
  }

  // После удара: связка (сразу следующая атака) или обычный отдых
  function afterAttack(out, carry) {
    const rec = st.current.recover;
    st.current = null;
    if (st.stage2Pending) { st.followUp = null; enterShift(out, carry, rec); return; }
    const i = st.stage - 1;
    if (!st.followUp && cfg.chain.chance[i] > 0 && st.introQueue.length === 0 && st.rng() < cfg.chain.chance[i]) {
      st.followUp = { move: null, windupMul: cfg.chain.windupMul };
    }
    if (st.followUp) {
      st.chains += 1;
      setPhase('idle', cfg.chain.gap, carry);
      return;
    }
    setPhase('recover', rec, carry);
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

    const lvSnap = difficultyOfSnapshot(snapshot); // [W5-СЛОЖНОСТЬ] уровень из снимка (combat.setDifficulty)
    if (lvSnap !== null) useLevel(lvSnap);
    const snap = readSnapshot(snapshot);
    st.lastSnapshotTime = snap.time;

    if (snap.bossDead) { enterDead(); return finish(out); }
    if (st.halted) return finish(out);
    if (snap.playerDead) {
      st.halted = true;
      st.current = null;
      st.followUp = null;
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
    // [W5-СЛОЖНОСТЬ] финт: замах обрывается (combat снимает телеграфы по cancelIds) — и сразу настоящая атака
    if (st.phase === 'windup' && st.current && st.current.feintAt !== null &&
        st.phaseElapsed >= st.current.feintAt - BOSS_TIME_EPSILON) {
      out.cancelIds = st.current.ids.slice();
      st.current = null;
      st.feints += 1;
      out.attacks.push(...beginAttack(snap, { noFeint: true }));
    }
    if (st.phase === 'idle' && reached()) {
      st.lag = clamp(st.phaseElapsed - st.phaseDuration, 0, cfg.maxDt);
      const fu = st.followUp;
      st.followUp = null;
      if (fu) st.lag = 0;
      out.attacks.push(...beginAttack(snap, { followUp: fu }));
    }

    // --- продвижение ---
    st.clock += step;
    st.phaseElapsed += step;

    // --- конец кадра ---
    if (st.phase === 'windup' && st.current) {
      const im = st.current.impacts;
      while (im.length > 1 && im[0].at <= st.phaseElapsed + BOSS_TIME_EPSILON) out.impactIds.push(im.shift().id);
    }
    for (let guard = 0; guard < 6 && reached(); guard++) {
      const carry = Math.max(0, st.phaseElapsed - st.phaseDuration);
      if (st.phase === 'windup') {
        out.impactIds.push(...st.current.impacts.map((x) => x.id));
        setPhase('attack', st.current.attackDur, carry);
      } else if (st.phase === 'attack') {
        afterAttack(out, carry);
        if (st.phase === 'idle') break; // связка: замах — в начале следующего кадра
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
      // [W5-СЛОЖНОСТЬ]
      level,
      currentMove: st.current ? st.current.move : null,
      chains: st.chains,
      feints: st.feints,
    };
  }

  // [W5-СЛОЖНОСТЬ] уровень напрямую (тесты, стенды); в игре он приходит в снимке от combat
  function setDifficulty(lv) { useLevel(lv); return level; }

  return { reset, update, getDebug, getConfig: () => cfg, setDifficulty };
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
    playerVel: isObj(player.velocity) && isNum(player.velocity.x) && isNum(player.velocity.z)   // [W5-СЛОЖНОСТЬ] для упреждения
      ? { x: player.velocity.x, z: player.velocity.z } : null,
  };
}

// [W5-СЛОЖНОСТЬ] профиль уровня поверх базы: объекты сливаются по ключам, числа и массивы — заменяются
function withProfile(input, profile) {
  const raw = isObj(input) ? input : {};
  const src = isObj(raw.boss)
    ? Object.assign({}, raw.boss, { seed: raw.boss.seed !== undefined ? raw.boss.seed : raw.seed })
    : raw;
  return mergeDeep(src, profile);
}
function mergeDeep(a, b) {
  if (!isObj(b)) return a;
  const out = Object.assign({}, isObj(a) ? a : {});
  for (const k of Object.keys(b)) out[k] = isObj(b[k]) ? mergeDeep(out[k], b[k]) : b[k];
  return out;
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
  const windupFloor = Math.max(FAIR_MIN_WINDUP, num(src.minWindup, D.minWindup, 0),   // [W5-СЛОЖНОСТЬ] пол 0,45 с
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

  // [W5-СЛОЖНОСТЬ] приёмы «Сложной» и «Кошмара» (в начальном балансе — нули)
  const ch = o(src.chain), fe = o(src.feint), db = o(src.double), vo = o(src.volley), tr = o(src.trap);
  const chance = (v, d) => pair(v, d, 0).map((x) => clamp(x, 0, 0.9));
  const extra = {
    aimLead: pair(src.aimLead, D.aimLead, 0).map((x) => clamp(x, 0, 1.2)),
    aimLeadMax: num(src.aimLeadMax, D.aimLeadMax, 0),
    chain: {
      chance: chance(ch.chance, D.chain.chance),
      gap: num(ch.gap, D.chain.gap, 0.05),
      windupMul: clamp(num(ch.windupMul, D.chain.windupMul, 0.3), 0.3, 1),
    },
    feint: { chance: chance(fe.chance, D.feint.chance), at: pair(fe.at, D.feint.at, 0.1).map((x) => clamp(x, 0.1, 0.7)) },
    double: { windup: Math.max(windupFloor, num(db.windup, D.double.windup, 0)) },
    volley: {
      count: clamp(Math.floor(num(vo.count, D.volley.count, 1)), 1, 4),   // combat принимает до 4 атак за шаг
      spreadDeg: clamp(num(vo.spreadDeg, D.volley.spreadDeg, 0), 0, 45),
      stagger: clamp(num(vo.stagger, D.volley.stagger, 0), 0, 0.6),
      damageMul: clamp(num(vo.damageMul, D.volley.damageMul, 0), 0, 2),
    },
    trap: {
      count: clamp(Math.floor(num(tr.count, D.trap.count, 1)), 1, 4),
      spacing: clamp(num(tr.spacing, D.trap.spacing, 0.5), 0.5, 6),
      windup: pair(tr.windup, D.trap.windup, 0.01).map((w) => Math.max(w, windupFloor)),
      damageMul: clamp(num(tr.damageMul, D.trap.damageMul, 0), 0, 2),
    },
  };

  return deepFreeze({
    ...extra,
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
  for (const k of MOVES) {   // [W5-СЛОЖНОСТЬ] + составные приёмы (по умолчанию 0)
    const c = s[k];
    out[k] = isNum(c) && c >= 0 && c <= 10 ? Math.floor(c) : (fallback[k] || 0);
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
