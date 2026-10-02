// =============================================================================
// combat.js — ASHEN OATH · роль No4/№22 (бой, движение, попадания) · API ASHEN_V2
// -----------------------------------------------------------------------------
// Чистая JS-симуляция боя. Без DOM, Three.js, webcam, requestAnimationFrame и
// импортов чужих модулей. Единственный владелец HP, энергии, позиций,
// cooldown, снарядов, телеграфов и исхода боя. Остальные модули получают
// только копии состояния через getSnapshot() и события через drainEvents().
//
// Порядок внутри одного фиксированного шага (документированный арбитраж):
//   1) bossBrain.update(h, snapshot) → стадия, действие, новые AttackSpec
//   2) таймеры (cooldown, i-frames, grace, реакции)
//   3) щит → парирование (окно) → попытка рывка → движение (свободное, в осях камеры
//      input.viewYaw; коллизии по раскладке карты) → встреча explore/engaged → энергия
//   4) burst (мгновенный урон боссу) → руна → бросок сферы/призмы → «Рассечение» → «Искра»
//      → обычный огонь
//   5) снаряды героя → урон боссу; призма раскалывает орбы на пути
//                                           (смерть босса = победа, шаг прерван)
//   6) телеграфы: slam/nova бьют, orb вылетает (смерть героя = поражение)
//   7) снаряды босса → попадания в героя   (смерть героя = поражение)
//   8) поворот босса
// Следствие: если в одном шаге смертельны оба удара, побеждает игрок, потому
// что его урон разрешается раньше. Второй исход не наступает, событие
// результата выпускается ровно одно.
//
// [W3-ULT] «Ярость клятвы» и ультимейт «Небесный суд»: шкала 0..furyMax копится от урона по
// Регенту, длинных серий, идеальных уклонений и парирований. Полная шкала + input.ultimate
// (обе руки над головой 0,8 с — core/ultimate.js; в отладке — U) → сцена C.ultimate.duration с:
// бой стоит (ввод игнорируется, мозг Регента не думает, его удары и сферы рассеяны), в strikeAt
// с неба падает меч — damagePct от максимума HP Регента. В дуэли ультимейта нет.
// =============================================================================

import { createCombatHand } from './combatHand.js'; // [HAND] лук и магия рукой: стрелы и сгустки

export const COMBAT_API_VERSION = 'ASHEN_V2';

// Заглушка раскладки карты (контракт ASHEN_V2, К.9), пока мир не передал свою: плато R = 45 м,
// арена R = 13 м в центре, 8 колонн на радиусе 18 м, старт в арене на (0, 0, 6).
const DEFAULT_COLUMNS = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({
  type: 'circle', x: Math.round(Math.sin(a * Math.PI / 180) * 18 * 1000) / 1000, z: Math.round(Math.cos(a * Math.PI / 180) * 18 * 1000) / 1000, r: 0.8,
}));
// [ASHEN_V3] руны правой руки и двуручные печати
export const RUNE_IDS = Object.freeze(['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha']);
export const SIGIL_IDS = Object.freeze(['clap', 'gate', 'frame', 'delta', 'cor']);

export const DEFAULT_LAYOUT = Object.freeze({
  version: 1,
  bounds: { minX: -46, maxX: 46, minZ: -46, maxZ: 46 },
  arena: { x: 0, z: 0, r: 13, leash: 6 },
  bossHome: { x: 0, z: 0 },
  playerSpawn: { x: 0, z: 6, yaw: Math.PI },
  colliders: DEFAULT_COLUMNS,
  pois: [],
  groundY: () => 0,
  isWalkable: (x, z) => Math.hypot(x, z) <= 45,
});

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;
const ATTACK_KINDS = new Set(['slam', 'orb', 'nova']);
export const DIFFICULTY_LEVELS = Object.freeze(['easy', 'normal']);   // [FEEL] уровни сложности боя с Регентом
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
    orbitRadius: 6,         // СТАРТОВАЯ дистанция до босса; дальше её меняет moveZ
    minRadius: 3.8,         // ближе не подойти (корпус стража — 1.7 м)
    maxRadius: 9.0,         // дальше не отойти (nova 9.5 м всё ещё накрывает)
    radialSpeed: 3.2,       // м/с к боссу/от босса при |moveZ| = 1
    radialAccelTime: 0.1,   // та же схема разгона/остановки, что у стрейфа
    radialStopTime: 0.06,
    hitRadius: 0.45,        // тело героя для снарядов (вертикальный цилиндр)
    height: 1.9,
    chestHeight: 1.1,
    strafeSpeed: 4.0,       // (V1, орбита) — в V2 не используется
    moveDeadzone: 0.06,     // круговая мёртвая зона вектора (moveX, moveZ)
    accelTime: 0.08,        // постоянная времени разгона (V3: 0.12 → 0.08 — отклик на руку живее)
    stopTime: 0.06,         // постоянная времени остановки при нейтрали
    // [ASHEN_V2] свободное движение
    walkSpeed: 2.4,         // м/с при walkShare хода стика (V3: стик даёт шаг 0.2…0.6 и бег 1.0)
    runSpeed: 5.5,          // м/с при полном ходе
    walkShare: 0.62,        // доля хода стика, до которой — ходьба
    backpedalFactor: 0.7,   // в lock-on: пятиться медленнее
    strafeFactor: 0.9,      // в lock-on: боком чуть медленнее
    turnRate: 12,           // рад/с: разворот корпуса (explore — по движению, engaged — на босса)
    minBossDistance: 2.8,   // ближе к боссу не подойти (тело Регента)
    moveSign: 1,            // +1: +moveX → вправо на экране
    // [ASHEN_V3] «замок кадра» вне арены: ось управления фиксируется, когда игрок выбрал
    // направление, и не крутится вслед за камерой исследования (иначе «вправо» — бег по кругу).
    frameLock: true,
    frameLockTurnDeg: 35,   // стик повернули сильнее — кадр берётся заново с текущей камеры
    frameLockIdle: 0.25,    // стик в нейтрали дольше — кадр сбрасывается
    frameLockResync: 2.5,   // 1/с: при беге «вперёд» кадр плавно догоняет камеру
    frameLockResyncDeg: 8,  // «вперёд» — это в пределах ±столько градусов (шире — герой и камера гоняются)
    frameLockBlend: 0.25,   // с: новый кадр после поворота стика перенимается плавно
    // [ASHEN_V4] движение по большой карте
    sprintSpeed: 8.2,       // м/с: спринт вне арены (держишь полный бег, не поворачивая)
    sprintDelay: 0.9,       // с полного бега до начала разгона
    sprintRamp: 0.6,        // с на разгон до спринта
    sprintTurnDeg: 45,      // резкий поворот (градусов) сбивает спринт
    slopeUp: 0.35,          // в гору: скорость × (1 − slopeUp·уклон)
    slopeDown: 0.12,        // с горы: × (1 + slopeDown·уклон)
    slopeMin: 0.6, slopeMax: 1.12,
    orbitStrafe: true,      // в арене боковой ход — по окружности вокруг Регента (дистанция не «уплывает»)
    cruiseHold: 0.5,        // автобег: спринт держался столько на полной скорости…
    cruiseMaxTime: 20,      // …и рука опущена — герой бежит сам (до стольких секунд), пока руку не поднимут
    // [ASHEN_V5] схема «Руль» (input.moveMode / input.stick.mode === 'steer'): вне арены moveX — поворот
    // героя, moveZ (0..1) — ход вперёд по его курсу, камера держится за спиной; в арене — обход Регента
    // по кругу (moveX) и сближение (moveZ), хода назад нет (только рывок). Автобега нет: рука вниз — стоп.
    steerTurnRate: 2.4,     // рад/с при полном повороте (≈140°/с; разворот на месте ≈1,3 с)
    steerTurnSlow: 0.5,     // на крутом повороте ход вперёд × (1 − steerTurnSlow·поворот²) — радиус меньше
    steerStrafeWalk: 0.6,   // в арене: обход при шаге (при беге — полный)
    steerApproachCut: 1.4,  // в арене: сближение × (1 − cut·|поворот|) — рука вбок = чистый обход
    energyRegen: 20,        // ед./с
    energyRegenDelay: 0.5,  // пауза регена после траты энергии
    hitGrace: 0.35,         // неуязвимость после полученного удара
    hitReactTime: 0.3,      // action 'hit', огонь подавлен
  },
  // [НОВИЧОК] «Автоход» (input.autoWalk): герой сам идёт к Регенту, а в арене обходит его по кругу.
  // Ввод движения рукой не нужен — левая свободна для щита и рывка; рывок, щит и чары работают как обычно.
  autoWalk: {
    approachSpeed: 4.6,     // м/с: от места старта к арене (≈4 с с плато)
    orbitRadius: 6.5,       // м: дистанция обхода (снаряды долетают, «удар об землю» Регента — не всегда)
    orbitSpeed: 2.3,        // м/с по окружности
    radialGain: 1.6,        // 1/с: поправка дистанции к orbitRadius
    radialMax: 2.2,         // м/с: не быстрее
    flipEvery: 9,           // с: обход меняет сторону (не зависает у одной колонны, выглядит живо)
    stuckRatio: 0.35,       // прошли меньше этой доли желаемого пути…
    stuckTime: 0.45,        // …столько секунд — упёрлись: обход препятствия
    detourDeg: 70,          // обход препятствия: курс уводится вбок на столько градусов…
    detourTime: 1.2,        // …на столько секунд
  },
  dash: {
    distance: 3.6,          // м в направлении рывка (V2: любое направление)
    duration: 0.22,
    cost: 20,
    cooldown: 0.8,          // от начала рывка
    iframeDuration: 0.28,   // от начала рывка
    buffer: 0.25,           // [V4] дёрг раньше конца отката не больше чем на столько — запоминается и срабатывает при готовности
  },
  // [ASHEN_V2] «Искра» (правая, щелчок): быстрый снаряд
  spark: { damage: 14, cost: 5, cooldown: 0.3, speed: 38, radius: 0.16, lifetime: 1.1, castTime: 0.15, spawnHeight: 1.4, spawnForward: 0.6, spawnSide: 0.3 },
  // [ASHEN_V2] «Рассечение» (правая, взмах ребром): дуга перед героем
  slash: { damageMin: 25, damageMax: 55, cost: 12, cooldown: 0.55, radius: 4.5, angleDeg: 110, recoverBonus: 1.5, castTime: 0.28 },
  // [ASHEN_V2] парирование (левая, кулак → ладонь): отражает орбы босса
  parry: { window: 0.2, whiffCooldown: 0.6, reflectDamageMul: 1.5, reflectSpeedMul: 1.4, energyGain: 15, reach: 1.6, castTime: 0.25 },
  // [ASHEN_V2] встреча: босс атакует только в арене
  encounter: { enabled: true, leash: 6, aggroMemory: 6 }, // удар по Регенту издали будит его; забывает героя за aggroMemory с
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
    moveSpeedFactor: 0.5,
  },
  burst: {
    cost: 40,
    cooldown: 12,
    damage: 80,
    clearRadius: 5,         // рассеивает орбы босса в этом радиусе от героя
    castTime: 0.4,
    bothHandsBonus: 0.25,   // [ASHEN_V2] выброс двумя руками: +25% урона
  },
  // [№1, «Перстни»] руны, нарисованные пальцем; комбо; идеальный рывок
  runes: {
    ignis: { cooldown: 10, energy: 25, damage: 70 },            // огненное копьё
    fulgur: { cooldown: 16, energy: 30, damage: 20, stun: 2.5 }, // оглушение: срыв замаха
    orbis: { cooldown: 18, energy: 20, heal: 22, ward: 6 },      // лечение + оберег на один удар
    // [ASHEN_V3] новые фигуры правой руки
    stella: { cooldown: 22, energy: 40, damage: 18, count: 5, interval: 0.18 },    // ★ звездопад
    spira: { cooldown: 14, energy: 25, duration: 3, radius: 7, speedBonus: 0.25 }, // @ вихрь: гасит сферы, бег быстрее
    lemnis: { cooldown: 26, energy: 30, heal: 45, duration: 6 },                   // ∞ вечность: лечение за время
    caret: { cooldown: 7, energy: 18, damage: 15, count: 3, spreadDeg: 9 },        // ^ залп игл
    vee: { cooldown: 14, energy: 25, damage: 30, heal: 20 },                       // V жатва: урон + лечение
    clepsydra: { cooldown: 24, energy: 35, duration: 5, slow: 0.45 },              // ⧗ время: Регент медленнее
    alpha: { cooldown: 30, energy: 0, energyGain: 35 },                            // α начало: откаты сброшены
    castTime: 0.35,
  },
  // [ASHEN_V3] двуручные печати (input.sigil): хлопок, врата, рамка
  sigils: {
    clap: { energy: 25, cooldown: 12, radius: 7, damage: 25, stun: 1.2, reach: 9 },   // громовой хлопок
    gate: { energy: 30, cooldown: 20, duration: 5, reduction: 0.6 },                  // бастион: −60% урона, орбы гаснут
    frame: { energy: 20, cooldown: 18, duration: 8, bonus: 0.3 },                     // метка цели: +30% урона по Регенту
    delta: { energy: 50, cooldown: 30, ticks: 4, damage: 40, interval: 0.2, width: 1.2 }, // ▲ двумя руками: луч, гасит сферы на линии
    cor: { energy: 40, cooldown: 35, heal: 45, duration: 3, ward: 6 },                 // ♥ двумя руками: лечение за 3 с + оберег
    castTime: 0.3,
  },
  combo: {
    perHit: 0.02,           // +2% урона за каждое попадание подряд
    maxBonus: 0.5,          // до ×1.5
    decay: 3.0,             // без попаданий дольше — серия гаснет
    breakMin: 5,            // combo_break выпускается для серии от стольких
  },
  perfectDodge: {
    window: 0.2,            // уклонение в первые 0.2 с рывка
    energy: 20,
  },
  // Сфера/призма, слепленная двумя руками и брошенная (input.throw).
  // Урон = round(damageBase + damagePower·power·(sizeFloor + (1−sizeFloor)·size)), призма ×(1+prismBonus).
  throw: {
    cooldown: 0.9,
    energyBase: 8,          // стоимость = energyBase + energyPerSize·size
    energyPerSize: 18,
    damageBase: 25,
    damagePower: 85,
    sizeFloor: 0.6,
    prismBonus: 0.15,       // призма: +15% урона и раскалывает орбы стража на пути
    speedMin: 15,           // м/с при power = 0 …
    speedMax: 18,           // … и при power = 1
    radiusBase: 0.22,       // радиус снаряда = radiusBase + radiusPerSize·size
    radiusPerSize: 0.5,
    spawnHeight: 1.25,      // между ладонями героя: грудь, чуть впереди
    spawnForward: 0.55,
    curve: 0.35,            // боковой изгиб: смещение контрольной точки на метр дистанции при |aimX| = 1
    loft: 0.1,              // подъём контрольной точки на метр дистанции
    lifetime: 2.5,
    castTime: 0.3,          // action 'cast' у героя после броска
  },
  // [W3-ULT] «Ярость клятвы» и «Небесный суд»
  ultimate: {
    furyMax: 100,
    fillAt: 0.45,           // шкала полна от урона в такую долю максимума HP Регента (от сложности не зависит)…
    perCombo: 0.25,         // …быстрее — за каждое попадание в серии от comboFrom
    comboFrom: 5,
    perfectDodge: 12,       // идеальное уклонение
    parry: 14,              // отражённая сфера
    duration: 3.6,          // с: вся сцена (бой стоит)
    strikeAt: 2.3,          // с от начала: меч касается Регента
    damagePct: 0.28,        // урон — доля максимума HP Регента (без множителей комбо и метки)
    graceAfter: 0.8,        // неуязвимость героя после сцены — успеть сориентироваться
    bossReact: 1.2,         // Регент шатается после удара
  },
  boss: {
    maxHp: 1000,
    hitRadius: 1.7,         // вертикальный цилиндр для болтов
    height: 5,
    aimHeight: 2.2,
    turnRate: 2.5,          // рад/с
    hitReactTime: 0.35,     // только от burst, только в idle/recover
  },
  // [FEEL] сложность боя с Регентом: множители здоровья и урона стража. Уровень выбирает игрок
  // (settings.difficulty → setDifficulty), здесь по умолчанию 'normal' — прежний баланс без изменений.
  difficulty: {
    level: 'normal',        // 'easy' | 'normal'
    easy: { bossHp: 0.7, bossDamage: 0.7 },
    normal: { bossHp: 1, bossDamage: 1 },
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
  p.minRadius = clamp(p.minRadius, 1.5, C.arena.radius);
  p.maxRadius = clamp(p.maxRadius, p.minRadius, C.arena.radius);
  p.orbitRadius = clamp(p.orbitRadius, p.minRadius, p.maxRadius);
  p.radialSpeed = Math.max(0, p.radialSpeed);
  p.radialAccelTime = Math.max(0.005, p.radialAccelTime);
  p.radialStopTime = Math.max(0.005, p.radialStopTime);
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
  p.walkSpeed = Math.max(0, p.walkSpeed);
  p.runSpeed = Math.max(p.walkSpeed, p.runSpeed);
  p.walkShare = clamp(p.walkShare, 0.05, 0.95);
  p.turnRate = Math.max(0.5, p.turnRate);
  p.minBossDistance = clamp(p.minBossDistance, 0, 20);
  for (const k of ['damage', 'cost', 'cooldown', 'castTime']) C.spark[k] = Math.max(0, C.spark[k]);
  C.spark.speed = clamp(C.spark.speed, 1, 150); C.spark.radius = clamp(C.spark.radius, 0.02, 2); C.spark.lifetime = clamp(C.spark.lifetime, 0.05, 5);
  for (const k of ['damageMin', 'damageMax', 'cost', 'cooldown', 'castTime']) C.slash[k] = Math.max(0, C.slash[k]);
  C.slash.damageMax = Math.max(C.slash.damageMin, C.slash.damageMax);
  C.slash.radius = clamp(C.slash.radius, 0.5, 20); C.slash.angleDeg = clamp(C.slash.angleDeg, 10, 360); C.slash.recoverBonus = Math.max(0, C.slash.recoverBonus);
  C.parry.window = clamp(C.parry.window, 0.02, 2);
  for (const k of ['whiffCooldown', 'reflectDamageMul', 'reflectSpeedMul', 'energyGain', 'reach', 'castTime']) C.parry[k] = Math.max(0, C.parry[k]);
  C.encounter.leash = clamp(C.encounter.leash, 0, 100);
  C.encounter.aggroMemory = clamp(C.encounter.aggroMemory, 0, 120);
  C.burst.bothHandsBonus = clamp(C.burst.bothHandsBonus, 0, 3);
  const df = C.difficulty;   // [FEEL] сложность: множители в разумных пределах, неизвестный уровень — обычная
  for (const lv of DIFFICULTY_LEVELS) { df[lv].bossHp = clamp(df[lv].bossHp, 0.2, 3); df[lv].bossDamage = clamp(df[lv].bossDamage, 0, 3); }
  if (!DIFFICULTY_LEVELS.includes(df.level)) df.level = 'normal';
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
  for (const k of RUNE_IDS) {
    const r = C.runes[k];
    r.cooldown = Math.max(0, r.cooldown); r.energy = Math.max(0, r.energy);
  }
  for (const k of SIGIL_IDS) {
    const g = C.sigils[k];
    g.cooldown = Math.max(0, g.cooldown); g.energy = Math.max(0, g.energy);
  }
  C.sigils.gate.reduction = clamp(C.sigils.gate.reduction, 0, 1);
  C.sigils.frame.bonus = clamp(C.sigils.frame.bonus, 0, 3);
  C.runes.fulgur.stun = clamp(C.runes.fulgur.stun, 0, 8);
  C.combo.perHit = clamp(C.combo.perHit, 0, 0.2); C.combo.maxBonus = clamp(C.combo.maxBonus, 0, 3);
  const th = C.throw;
  for (const k of ['cooldown', 'energyBase', 'energyPerSize', 'damageBase', 'damagePower', 'prismBonus', 'loft', 'castTime']) th[k] = Math.max(0, th[k]);
  th.sizeFloor = clamp(th.sizeFloor, 0, 1);
  th.speedMin = clamp(th.speedMin, 1, 60);
  th.speedMax = clamp(th.speedMax, th.speedMin, 60);
  th.radiusBase = clamp(th.radiusBase, 0.02, 2);
  th.radiusPerSize = clamp(th.radiusPerSize, 0, 2);
  th.spawnHeight = clamp(th.spawnHeight, 0.2, 3);
  th.spawnForward = clamp(th.spawnForward, 0, 1.5);
  th.curve = clamp(th.curve, 0, 1);
  th.lifetime = clamp(th.lifetime, 0.2, 6);
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

// [ASHEN_V3] Большая карта — сотни коллайдеров: равномерная сетка 8 м. В ячейку попадает всё, что
// ближе pad к её границе (pad > радиус героя + подшаг + выталкивание), поэтому для точки хватает
// одной ячейки. Для маленьких раскладок сетки нет — перебор как раньше.
const GRID_EMPTY = Object.freeze([]);
function buildColliderGrid(colliders, cell = 8, pad = 1.6) {
  if (!Array.isArray(colliders) || colliders.length < 48) return null;
  const cells = new Map();
  const key = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  for (const c of colliders) {
    let x0, x1, z0, z1;
    if (c.type === 'circle') { x0 = c.x - c.r; x1 = c.x + c.r; z0 = c.z - c.r; z1 = c.z + c.r; }
    else { const r = c.r || 0; x0 = Math.min(c.ax, c.bx) - r; x1 = Math.max(c.ax, c.bx) + r; z0 = Math.min(c.az, c.bz) - r; z1 = Math.max(c.az, c.bz) + r; }
    const ix0 = Math.floor((x0 - pad) / cell), ix1 = Math.floor((x1 + pad) / cell);
    const iz0 = Math.floor((z0 - pad) / cell), iz1 = Math.floor((z1 + pad) / cell);
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > 4096) continue;   // абсурдно большой — пропуск (защита)
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = key(ix, iz);
      let l = cells.get(k);
      if (!l) { l = []; cells.set(k, l); }
      l.push(c);
    }
  }
  return { near: (x, z) => cells.get(key(Math.floor(x / cell), Math.floor(z / cell))) || GRID_EMPTY };
}

// Раскладка карты → проверенная копия: коллайдеры с конечными числами, функции-заглушки.
function normalizeLayout(layout, boss) {
  const L = isPlainObject(layout) ? layout : null;
  const src = L || DEFAULT_LAYOUT;
  const arena = isPlainObject(src.arena) && Number.isFinite(Number(src.arena.r))
    ? { x: fin(Number(src.arena.x), boss.x), z: fin(Number(src.arena.z), boss.z), r: Math.max(2, Number(src.arena.r)) }
    : { x: boss.x, z: boss.z, r: 13 };
  const colliders = [];
  for (const c of Array.isArray(src.colliders) ? src.colliders : []) {
    if (!isPlainObject(c)) continue;
    if (c.type === 'circle' && [c.x, c.z, c.r].every(Number.isFinite) && c.r > 0) colliders.push({ type: 'circle', x: c.x, z: c.z, r: c.r });
    else if (c.type === 'segment' && [c.ax, c.az, c.bx, c.bz].every(Number.isFinite)) colliders.push({ type: 'segment', ax: c.ax, az: c.az, bx: c.bx, bz: c.bz, r: Number.isFinite(c.r) ? Math.max(0, c.r) : 0 });
  }
  const safe = (fn, dflt) => (typeof fn === 'function'
    ? (x, z) => { try { const v = fn(x, z); return v; } catch (e) { return dflt(x, z); } }
    : dflt);
  const gy = safe(src.groundY, () => 0);
  const walk = safe(src.isWalkable, (x, z) => Math.hypot(x - arena.x, z - arena.z) <= 45);
  const sp = isPlainObject(src.playerSpawn) && Number.isFinite(src.playerSpawn.x) && Number.isFinite(src.playerSpawn.z)
    ? { x: src.playerSpawn.x, z: src.playerSpawn.z, yaw: Number.isFinite(src.playerSpawn.yaw) ? src.playerSpawn.yaw : NaN } : null;
  return {
    custom: !!L,
    arena, colliders, playerSpawn: sp,
    grid: buildColliderGrid(colliders),
    groundY: (x, z) => { const v = Number(gy(x, z)); return Number.isFinite(v) ? v : 0; },
    isWalkable: (x, z) => walk(x, z) !== false,
    resolveMove: typeof src.resolveMove === 'function' && L ? src.resolveMove : null,
  };
}

// -----------------------------------------------------------------------------
// Фабрика
// -----------------------------------------------------------------------------
export function createCombat({ config, bossBrain, layout } = {}) {
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
  let hand = null; // [HAND] modules/combatHand.js (создаётся в конце фабрики)
  // [ASHEN_V2] раскладка карты: коллизии, земля, арена. Функции раскладки — чистые.
  const LAY = normalizeLayout(layout, BOSS);

  let eventSeq = 0;   // не сбрасывается: id событий уникальны на всю сессию
  let fightGen = 0;   // растёт при каждом reset: id снарядов не повторяются
  let projSeq = 0;
  let st = null;
  let warnedBrain = false;
  let PV = null;      // [PVP] дуэль игрок против игрока: логика — modules/pvp.js (attachPvp); null/off — бой с боссом

  function freshState() {
    // старт: точка раскладки; если раскладка — заглушка, то по-старому (startAngle, orbitRadius)
    const sp = LAY.custom && LAY.playerSpawn ? LAY.playerSpawn
      : { x: BOSS.x + C.player.orbitRadius * Math.sin(C.arena.startAngle), z: BOSS.z + C.player.orbitRadius * Math.cos(C.arena.startAngle), yaw: NaN };
    const pp = vec(sp.x, LAY.groundY(sp.x, sp.z), sp.z);
    const yaw0 = Number.isFinite(sp.yaw) ? sp.yaw : Math.atan2(BOSS.x - pp.x, BOSS.z - pp.z);
    const engaged0 = !C.encounter.enabled || distXZ(pp, LAY.arena) <= LAY.arena.r;
    return {
      status: 'playing',
      time: 0,
      acc: 0,
      p: {
        x: pp.x, y: pp.y, z: pp.z, vx: 0, vz: 0, yaw: yaw0, // [ASHEN_V2] свободная позиция и скорость (мир)
        dashVec: { x: 0, z: 0 },
        sparkCd: 0, slashCd: 0, parryCd: 0, parryWin: 0, parryHit: false, parryT: 0, slashT: 0, sparkT: 0,
        throwCd: 0,
        hp: C.player.maxHp, energy: C.player.maxEnergy,
        dashing: false, dashElapsed: 0, dashDir: 0, dashCd: 0,
        iframe: 0, grace: 0, hitReact: 0, regenDelay: 0,
        shielding: false, shieldLock: false,
        fireTimer: 0, firing: false, castTimer: 0, burstCd: 0,
        runeCd: Object.fromEntries(RUNE_IDS.map((k) => [k, 0])), ward: 0, charge: 0,
        sigilCd: Object.fromEntries(SIGIL_IDS.map((k) => [k, 0])), bastion: 0, beam: [],
        vortex: 0, regen: 0, regenRate: 0, meteors: [],
        combo: 0, comboTimer: 0,
        fury: 0,                 // [W3-ULT] «Ярость клятвы»
        dead: false,
      },
      b: {
        hp: C.boss.maxHp, stage: 1,
        yaw: Math.atan2(pp.x - BOSS.x, pp.z - BOSS.z),
        decisionAction: 'idle', hitReact: 0, dead: false, stun: 0, mark: 0, slow: 0,
      },
      projectiles: [],
      telegraphs: [],
      events: [],
      seenIds: new Set(),
      seenOrder: [],
      stats: { damageDealt: 0, damageTaken: 0, dodges: 0, blocks: 0 },
      input: { moveX: 0, moveZ: 0, attack: false, shield: false, valid: false, conjure: null, viewYaw: NaN, steer: false, autoWalk: false },
      auto: { dir: 1, flipT: 0, stuckT: 0, detourT: 0, detourSign: 1, lastX: null, lastZ: null, want: 0 },   // [НОВИЧОК] автоход
      engaged: engaged0,
      frame: { yaw: null, stickA: 0, idle: 0, target: null },
      move: { sprintT: 0, sprint: 0, dir: null, fullT: 0, cruise: null, blockedT: 0 },   // [V4] спринт и автобег
      aggroT: 0,
      pendingDash: 0,
      pendingDashCam: null,
      pendingSpark: false,
      pendingSlash: null,
      pendingParry: false,
      pendingBurstBoth: false,
      pendingBurst: false,
      pendingBurstPower: null,
      pendingRune: null,
      pendingSigil: null,
      dashBuffer: null,
      pendingThrow: null,
      pendingUlt: false, ult: null, furyFullSent: false,   // [W3-ULT] импульс, сцена { t, duration, strikeAt, struck, amount }
      debug: {
        steps: 0, brainCalls: 0, brainErrors: 0,
        acceptedAttacks: 0, rejectedAttacks: 0, duplicateAttacks: 0,
        droppedEvents: 0, droppedProjectiles: 0, clampedFrames: 0, lastReject: '',
      },
    };
  }

  // ---------------------------------------------------------------- геометрия
  function playerPos() { const P = st.p; return vec(P.x, P.y, P.z); }
  function playerChest() { const p = playerPos(); p.y += C.player.chestHeight; return p; }
  function bossAim() { if (PV && PV.on) return PV.aim(); return vec(BOSS.x, BOSS.y + C.boss.aimHeight, BOSS.z); } // [PVP] цель — грудь соперника
  // Точка между ладонями героя (там висит слепленная сфера и оттуда она вылетает).
  function conjurePoint() {
    const pp = playerPos();
    const dx = BOSS.x - pp.x, dz = BOSS.z - pp.z;
    const l = Math.sqrt(dx * dx + dz * dz) || 1;
    const T = C.throw;
    return vec(pp.x + dx / l * T.spawnForward, pp.y + T.spawnHeight, pp.z + dz / l * T.spawnForward);
  }
  // Экранно-правый вектор для камеры за спиной героя, смотрящей на босса (lock-on).
  function toBossUnit() {
    const P = st.p;
    const dx = BOSS.x - P.x, dz = BOSS.z - P.z;
    const l = Math.sqrt(dx * dx + dz * dz);
    return l > 1e-6 ? { x: dx / l, z: dz / l } : { x: -Math.sin(P.yaw), z: -Math.cos(P.yaw) };
  }
  function screenRight() {
    const f = toBossUnit(), s = C.player.moveSign;
    return vec(-f.z * s, 0, f.x * s);
  }
  // Оси камеры для ввода: yaw «вперёд» камеры (input.viewYaw) или, без него, от героя к боссу (V1).
  function rawViewYaw() {
    const v = st.input.viewYaw;
    if (Number.isFinite(v)) return v;
    const f = toBossUnit();
    return Math.atan2(f.x, f.z);
  }
  function viewYaw() {
    if (st.input.steer && !st.engaged) return st.p.yaw;     // [V5] «Руль»: оси ввода — курс героя (камера за спиной)
    const F = st.frame;
    return !st.engaged && C.player.frameLock && F && F.yaw !== null ? F.yaw : rawViewYaw();
  }
  // [ASHEN_V3] замок кадра: обновляется раз за шаг до расчёта движения
  function updateFrame(h, ix, iz) {
    const F = st.frame;
    if (!F) return;
    const m = Math.hypot(ix, iz);
    if (st.engaged || !C.player.frameLock || st.input.steer) { F.yaw = null; F.idle = 0; return; }
    if (m <= C.player.moveDeadzone) {
      F.idle += h;
      if (F.idle >= C.player.frameLockIdle) F.yaw = null;
      return;
    }
    F.idle = 0;
    const a = Math.atan2(ix, iz), raw = rawViewYaw();
    const turn = Math.abs(wrapAngle(a - F.stickA)) * 180 / Math.PI;
    if (F.yaw === null) { F.yaw = raw; F.target = null; F.stickA = a; return; }
    if (turn > C.player.frameLockTurnDeg) { F.target = raw; F.stickA = a; }   // новый кадр — перенять плавно
    else F.stickA += wrapAngle(a - F.stickA) * 0.15;         // мелкое подруливание не сбрасывает кадр
    if (F.target !== null && F.target !== undefined) {
      const d = wrapAngle(F.target - F.yaw);
      F.yaw = wrapAngle(F.yaw + d * (1 - Math.exp(-h / Math.max(0.02, C.player.frameLockBlend))));
      if (Math.abs(d) < 0.01) F.target = null;
    }
    if (Math.abs(a) < C.player.frameLockResyncDeg * Math.PI / 180) F.yaw = wrapAngle(F.yaw + wrapAngle(raw - F.yaw) * (1 - Math.exp(-C.player.frameLockResync * h)));
  }
  function camToWorld(cx, cz) {
    const y = viewYaw(), s = C.player.moveSign;
    const fx = Math.sin(y), fz = Math.cos(y), rx = -Math.cos(y), rz = Math.sin(y);
    return { x: cx * s * rx + cz * fx, z: cx * s * rz + cz * fz };
  }
  function orbitAngle() { const P = st.p; return Math.atan2(P.x - BOSS.x, P.z - BOSS.z); }
  function orbitRadius() { return distXZ(st.p, BOSS); }

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
    if (st.ult) return 'cast';   // [W3-ULT] руки к небу
    if (P.hitReact > 0) return 'hit';
    if (P.dashing) return 'dash';
    if (P.parryT > 0) return 'parry';
    if (P.slashT > 0) return 'slash';
    if (st.input.conjure) return 'conjure';
    if (P.shielding) return 'shield';
    if (P.sparkT > 0) return 'spark';
    if (P.firing || P.castTimer > 0) return 'cast';
    if (Math.hypot(P.vx, P.vz) > 0.3) return 'move';
    return 'idle';
  }
  function bossAction() {
    if (st.b.stun > 0 && !st.b.dead) return 'hit';
    const B = st.b;
    if (B.dead) return 'dead';
    if (B.hitReact > 0 && (B.decisionAction === 'idle' || B.decisionAction === 'recover')) return 'hit';
    return B.decisionAction;
  }

  function lockAxes() {
    const P = st.p, r = screenRight(), f = toBossUnit(), full = Math.max(0.1, C.player.runSpeed);
    return { lateral: (P.vx * r.x + P.vz * r.z) / full, radial: (P.vx * f.x + P.vz * f.z) / full };
  }
  function locomotion() {
    const P = st.p;
    if (P.dashing) return 'dash';
    const sp = Math.hypot(P.vx, P.vz);
    if (sp < 0.3) return 'idle';
    if (st.engaged) {
      const a = lockAxes();
      if (a.radial < -0.35 * Math.abs(a.lateral) - 0.05 && -a.radial > Math.abs(a.lateral)) return 'back';
      if (Math.abs(a.lateral) > Math.abs(a.radial)) return 'strafe';
    }
    // [V3] гистерезис: бег с 4.2 м/с, обратно в шаг — ниже 3.2 (анимация не мигает на границе)
    if (P.gait === 'run' ? sp < 3.2 : sp > 4.2) P.gait = P.gait === 'run' ? 'walk' : 'run';
    if (P.gait === 'run' && st.move.sprint > 0.5) return 'sprint';
    return P.gait === 'run' ? 'run' : 'walk';
  }
  function buildSnapshot() {
    const P = st.p, B = st.b;
    const pp = playerPos();
    const snap = {
      status: st.status,
      time: st.time,
      player: {
        position: pp,
        yaw: P.yaw,                 // [V2] куда смотрит герой (engaged — на босса, explore — по движению)
        hp: P.hp, maxHp: C.player.maxHp,
        energy: P.energy, maxEnergy: C.player.maxEnergy,
        action: playerAction(),
        invulnerable: P.iframe > 0 || P.grace > 0,
        shielding: P.shielding,
        // --- расширения ASHEN_V1 (No4) ---
        orbitAngle: orbitAngle(),
        orbitRadius: orbitRadius(),
        // скорость в осях lock-on (−1..1 от бега): lateral — вправо по экрану, radial — + = к Регенту
        lateral: lockAxes().lateral,
        radial: lockAxes().radial,
        // [ASHEN_V2]
        velocity: { x: P.vx, z: P.vz },
        speed: Math.hypot(P.vx, P.vz),
        locomotion: locomotion(),
        sprint: Math.round(st.move.sprint * 1000) / 1000,
        cruise: !!st.move.cruise,
        moveMode: st.input.steer ? 'steer' : 'stick',   // [V5] схема движения (камера за спиной в «Руле»)
        lockedOn: st.engaged,
        encounter: st.engaged ? 'engaged' : 'explore',
        parryWindow: C.parry.window > 0 ? clamp(P.parryWin / C.parry.window, 0, 1) : 0,
        dashDir: P.dashing ? { x: P.dashVec.x, z: P.dashVec.z } : null,
        // слепленное двумя руками заклинание (удержание) и точка между ладонями героя
        conjure: st.status === 'playing' && st.input.conjure ? { ...st.input.conjure } : null,
        conjurePoint: conjurePoint(),
        dashing: P.dashing,
        dashDirection: P.dashing ? P.dashDir : 0, // V1: знак боковой составляющей рывка
        invulnerableSource: P.iframe > 0 ? 'dash' : P.grace > 0 ? 'hit' : 'none',
        // [№1] «Перстни»: заряд кулака (для эффектов рук), оберег, комбо
        burstCharge: P.charge,
        warded: P.ward > 0, wardRemaining: P.ward,
        bastion: P.bastion > 0, bastionRemaining: P.bastion,
        vortex: P.vortex > 0, vortexRemaining: P.vortex, regen: P.regen > 0, regenRemaining: P.regen,
        combo: P.combo, comboMultiplier: 1 + comboBonus(), comboTimer: P.comboTimer,
        // [W3-ULT] «Ярость клятвы»: шкала и готовность «Небесного суда» (в дуэли — нет)
        fury: P.fury, furyMax: C.ultimate.furyMax, furyReady: ultReady(),
      },
      boss: {
        position: vcopy(BOSS),
        home: vcopy(BOSS),
        yaw: B.yaw,
        hp: B.hp, maxHp: C.boss.maxHp,
        stage: B.stage,
        action: bossAction(),
        stunned: B.stun > 0, stunRemaining: B.stun,
        marked: B.mark > 0, markRemaining: B.mark,
        slowed: B.slow > 0, slowRemaining: B.slow,
      },
      cooldowns: {
        dashRemaining: P.dashCd, dashTotal: C.dash.cooldown,
        burstRemaining: P.burstCd, burstTotal: C.burst.cooldown,
        throwRemaining: P.throwCd, throwTotal: C.throw.cooldown,
        sparkRemaining: P.sparkCd, sparkTotal: C.spark.cooldown,
        slashRemaining: P.slashCd, slashTotal: C.slash.cooldown,
        parryRemaining: P.parryCd, parryTotal: C.parry.whiffCooldown,
        runes: Object.fromEntries(RUNE_IDS.map((k) => [k, { remaining: P.runeCd[k], total: C.runes[k].cooldown }])),
        sigils: Object.fromEntries(SIGIL_IDS.map((k) => [k, { remaining: P.sigilCd[k], total: C.sigils[k].cooldown }])),
      },
      projectiles: st.projectiles.map(pr => {
        const o = {
          id: pr.id, owner: pr.owner, kind: pr.kind,
          position: vcopy(pr.position), velocity: vcopy(pr.velocity), radius: pr.radius,
        };
        if (pr.attackId) o.attackId = pr.attackId;
        if (pr.path) { o.size = pr.size; o.power = pr.power; o.target = vcopy(pr.path.p2); }
        if (pr.reflected) o.reflected = true;
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
    // [W3-ULT] идущая сцена «Небесного суда» (только пока бой идёт)
    snap.ultimate = st.ult && st.status === 'playing'
      ? { active: true, t: st.ult.t, duration: st.ult.duration, strikeAt: st.ult.strikeAt, struck: st.ult.struck, amount: st.ult.amount }
      : null;
    if (hand) { try { hand.decorateSnapshot(snap); } catch (e) { /* [HAND] снимок без стрел */ } } // [HAND]
    // [PVP] C4: режим, соперник и цель lock-on (в бою с боссом — Регент)
    snap.mode = PV && PV.on ? 'pvp' : 'boss';
    snap.opponent = null;
    snap.lockTarget = { position: vcopy(BOSS), kind: 'boss' };
    if (PV && PV.on) PV.decorate(snap);
    return C.sim.freezeSnapshots ? deepFreeze(snap) : snap;
  }

  // ---------------------------------------------------------------- ввод
  function readInput(input) {
    const ok = isPlainObject(input) && input.valid === true && input.source !== 'none';
    if (!ok) {
      st.input.moveX = 0; st.input.moveZ = 0; st.input.attack = false; st.input.shield = false; st.input.valid = false;
      st.input.conjure = null; st.input.autoWalk = false;
      st.pendingDash = 0; st.pendingDashCam = null; st.pendingBurst = false; st.pendingRune = null; st.pendingThrow = null; st.p.charge = 0;
      st.pendingSpark = false; st.pendingSlash = null; st.pendingParry = false;
      st.pendingUlt = false;   // [W3-ULT]
      if (hand) hand.clearInput(); // [HAND]
      return;
    }
    const vy = Number(input.viewYaw);
    st.input.viewYaw = Number.isFinite(vy) ? vy : NaN;
    // [V5] схема движения: явная (main.js — из настроек) или по форме стика; нет данных — прежняя
    const mm = input.moveMode === 'steer' || input.moveMode === 'stick' ? input.moveMode
      : isPlainObject(input.stick) && (input.stick.mode === 'steer' || input.stick.mode === 'stick') ? input.stick.mode : null;
    if (mm) st.input.steer = mm === 'steer';
    let mx = Number(input.moveX);
    if (!Number.isFinite(mx)) mx = 0;
    let mz = Number(input.moveZ);
    if (!Number.isFinite(mz)) mz = 0;
    mx = clamp(mx, -1, 1); mz = clamp(mz, -1, 1);
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; } // вектор, а не две независимые оси
    st.input.moveX = mx;
    st.input.moveZ = mz;
    // [НОВИЧОК] автоход: main.js включает его настройкой (не в дуэли и не с клавиатуры)
    st.input.autoWalk = input.autoWalk === true && !(PV && PV.on);
    // [НОВИЧОК] режим жестов: в «Новичке» бой принимает только базовые действия (ход, щит, рывок,
    // «OK»-огонь, выброс, сфера); импульсы остальных жестов отбрасываются, даже если их кто-то прислал
    const novice = input.gestureMode === 'novice';
    st.input.conjure = readConjure(input.conjure);
    const thr = readThrow(input.throw);
    if (thr) st.pendingThrow = thr; // импульс: исполняется в ближайшем шаге, один раз
    st.input.attack = input.attack === true;
    st.input.shield = input.shield === true;
    st.input.valid = true;
    // [V4] состояние левой руки для автобега: опущена (покой) / взята (джойстик)
    st.input.handDown = isPlainObject(input.stick) && input.stick.rest === true;
    st.input.handUp = isPlainObject(input.stick) && input.stick.engaged === true;
    const dd = readVec2(input.dashDir);
    const dsh = Number(input.dash);
    if (dd) st.pendingDashCam = dd;
    else if (Number.isFinite(dsh) && dsh !== 0) st.pendingDashCam = { x: dsh > 0 ? 1 : -1, z: 0 };
    if (st.pendingDashCam) st.pendingDash = st.pendingDashCam.x >= 0 ? 1 : -1;
    if (input.spark === true && !novice) st.pendingSpark = true;
    if (isPlainObject(input.slash) && !novice) {
      const dir = Number(input.slash.dir) < 0 ? -1 : 1;
      st.pendingSlash = { dir, power: unit(input.slash.power, 0.6) };
    }
    if (input.parry === true && !novice) st.pendingParry = true;
    if (input.burst === true) {
      st.pendingBurstBoth = input.burstHand === 'both';
      st.pendingBurst = true;
      const bp = Number(input.burstPower);
      st.pendingBurstPower = Number.isFinite(bp) && bp > 0 ? clamp(bp, 0, 1) : null;
    }
    if (typeof input.rune === 'string' && RUNE_IDS.includes(input.rune) && !novice) st.pendingRune = input.rune;
    if (typeof input.sigil === 'string' && SIGIL_IDS.includes(input.sigil) && !novice) st.pendingSigil = input.sigil;
    const ch = Number(input.charge);
    st.p.charge = Number.isFinite(ch) ? clamp(ch, 0, 1) : 0;
    if (hand) { try { hand.readInput(novice ? { ...input, bow: null, handSpell: null } : input); } catch (e) { console.warn('[combat] hand.readInput', e); } } // [HAND] input.bow / input.handSpell; [НОВИЧОК] без лука и магии рукой
    // [W3-ULT] «Небесный суд» — и в «Новичке»; во время сцены любой ввод игнорируется
    if (input.ultimate === true) st.pendingUlt = true;
    if (st.ult) ultMuteInput();
  }

  function readVec2(v) {
    if (!isPlainObject(v)) return null;
    const x = Number(v.x), z = Number(v.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const l = Math.hypot(x, z);
    return l > 1e-6 ? { x: x / l, z: z / l } : null;
  }

  // Контракт HandIntent: kind 'orb' | 'prism' ('sphere' принимается как синоним 'orb').
  function spellKind(k) { return k === 'orb' || k === 'sphere' ? 'orb' : k === 'prism' ? 'prism' : null; }
  function unit(v, fallback) { const n = Number(v); return Number.isFinite(n) ? clamp(n, 0, 1) : fallback; }
  function readConjure(c) {
    if (!isPlainObject(c)) return null;
    const kind = spellKind(c.kind);
    if (!kind) return null;
    return { kind, size: unit(c.size, 0), charge: unit(c.charge, 0) };
  }
  function readThrow(t) {
    if (!isPlainObject(t)) return null;
    const kind = spellKind(t.kind);
    if (!kind) return null;
    const ax = Number(t.aimX);
    return { kind, size: unit(t.size, 0.5), power: unit(t.power, 0.5), aimX: Number.isFinite(ax) ? clamp(ax, -1, 1) : 0 };
  }

  function comboBonus() {
    return Math.min(C.combo.maxBonus, st.p.combo * C.combo.perHit);
  }
  function breakCombo(reason) {
    const P = st.p;
    if (P.combo >= C.combo.breakMin) emit('combo_break', playerPos(), { combo: P.combo, reason });
    P.combo = 0; P.comboTimer = 0;
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
      damage: scaleBossDamage(clamp(damage, 0, A.maxDamage)),   // [FEEL] множитель сложности — после санитарного предела
      baseDamage: clamp(damage, 0, A.maxDamage),                // [FEEL] без сложности: от него — урон отражённой сферы
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
    st.pendingUlt = false; st.ult = null;   // [W3-ULT] сцена (если шла) не переживает исход
    st.projectiles.length = 0;
    if (hand) hand.clear(); // [HAND]
    st.telegraphs.length = 0;
    st.pendingDash = 0;
    st.pendingBurst = false;
    st.pendingRune = null;
    st.pendingThrow = null;
    st.acc = 0;
    P.dashing = false; P.firing = false; P.vx = 0; P.vz = 0; P.parryWin = 0;
    st.pendingSpark = false; st.pendingSlash = null; st.pendingParry = false; st.pendingDashCam = null;
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

  function damageBoss(amount, source, point, extra) {
    if (PV && PV.on) { PV.damage(amount, source, point, extra); return; } // [PVP] урон уходит сопернику сообщением hit
    if (C.encounter.enabled) { st.aggroT = C.encounter.aggroMemory; engage('aggro'); }
    if (st.status !== 'playing' || !(amount > 0)) return;
    const B = st.b;
    const P = st.p;
    const mult = extra && extra.flat ? 1 : (1 + comboBonus()) * (B.mark > 0 ? 1 + C.sigils.frame.bonus : 1);   // [W3-ULT] flat — урон ультимейта
    const dealt = Math.min(B.hp, amount * mult);
    B.hp -= dealt;
    if (B.hp < 1e-6) B.hp = 0;
    st.stats.damageDealt += dealt;
    if (source === 'burst' || source === 'rune' || source === 'throw' || source === 'sigil') B.hitReact = C.boss.hitReactTime;
    P.combo++;
    P.comboTimer = C.combo.decay;
    if (source !== 'ultimate') addFury(dealt * C.ultimate.furyMax / (C.ultimate.fillAt * C.boss.maxHp) + (P.combo >= C.ultimate.comboFrom ? C.ultimate.perCombo : 0));   // [W3-ULT]
    emit('boss_hit', point, { ...(extra || {}), amount: dealt, source, hpAfter: B.hp, combo: P.combo, multiplier: Math.round(mult * 100) / 100, marked: B.mark > 0 });
    if (B.hp <= 0) finish('victory');
  }

  // Результат удара босса определяется ДО событий (чистая функция).
  function outcomeFor(att) {
    const P = st.p;
    if (!(att.damage > 0)) return 'none';
    if (P.iframe > 0) return 'dodge';
    if (P.grace > 0) return 'grace';
    if (P.ward > 0) return 'ward';
    if (P.bastion > 0 && att.kind === 'orb') return 'bastion';
    if (P.shielding && att.blockable) return 'block';
    return 'hit';
  }

  function commitOutcome(att, outcome, point, sourcePos) {
    const P = st.p;
    if (outcome === 'dodge') {
      st.stats.dodges++;
      const perfect = P.iframe >= C.dash.iframeDuration - C.perfectDodge.window;
      emit('dodge', playerPos(), { attackId: att.id, attackKind: att.kind, method: 'dash', perfect });
      if (perfect) {
        P.energy = Math.min(C.player.maxEnergy, P.energy + C.perfectDodge.energy);
        emit('perfect_dodge', playerPos(), { attackId: att.id, attackKind: att.kind, energy: C.perfectDodge.energy });
        addFury(C.ultimate.perfectDodge);   // [W3-ULT]
      }
    } else if (outcome === 'ward') {
      st.stats.blocks++;
      P.ward = 0;
      emit('block', point, { attackId: att.id, attackKind: att.kind, prevented: att.damage, ward: true, energyAfter: P.energy });
      emit('ward_end', playerPos(), { reason: 'absorbed' });
    } else if (outcome === 'bastion') {
      st.stats.blocks++;
      emit('block', point, { attackId: att.id, attackKind: att.kind, prevented: att.damage, bastion: true, energyAfter: P.energy });
    } else if (outcome === 'block') {
      st.stats.blocks++;
      P.energy = Math.max(0, P.energy - C.shield.blockEnergyCost);
      P.regenDelay = C.player.energyRegenDelay;
      emit('block', point, { attackId: att.id, attackKind: att.kind, prevented: att.damage, energyAfter: P.energy });
      if (P.energy <= 0 && P.shielding) endShield('depleted');
    } else if (outcome === 'hit') {
      const amount = Math.min(P.hp, att.damage * (P.bastion > 0 ? 1 - C.sigils.gate.reduction : 1));
      P.hp -= amount;
      if (P.hp < 1e-6) P.hp = 0;
      st.stats.damageTaken += amount;
      breakCombo('hit');
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
    let cam = st.pendingDashCam;
    let dir = st.pendingDash;
    // [V4] буфер рывка: дёрг за миг до конца отката/текущего рывка не теряется, а срабатывает при готовности
    if ((!cam || dir === 0) && st.dashBuffer && st.dashBuffer.t > 0) { cam = st.dashBuffer.cam; dir = st.dashBuffer.dir; st.dashBuffer = null; }
    if (!cam || dir === 0) { st.pendingDash = 0; st.pendingDashCam = null; return; }
    st.pendingDash = 0; st.pendingDashCam = null; // одна попытка на один импульс
    let reason = '';
    if (P.dashing) reason = 'active';
    else if (P.dashCd > EPS) reason = 'cooldown';
    else if (P.energy < C.dash.cost) reason = 'energy';
    if (reason) {
      const left = Math.max(P.dashing ? Math.max(0, C.dash.duration - P.dashElapsed) : 0, P.dashCd);   // до настоящей готовности
      if (reason !== 'energy' && left <= C.dash.buffer) { st.dashBuffer = { cam, dir, t: C.dash.buffer + 0.05 }; return; }
      emit('ability_denied', playerPos(), { ability: 'dash', reason, direction: dir });
      return;
    }
    st.dashBuffer = null;
    const w = camToWorld(cam.x, cam.z);
    const wl = Math.hypot(w.x, w.z) || 1;
    P.dashing = true;
    P.dashElapsed = 0;
    P.dashVec = { x: w.x / wl, z: w.z / wl };
    const right = screenRight();
    const lat = P.dashVec.x * right.x + P.dashVec.z * right.z;
    P.dashDir = Math.abs(lat) > 0.25 ? Math.sign(lat) : dir;
    P.dashCd = C.dash.cooldown;
    P.iframe = C.dash.iframeDuration;
    P.energy -= C.dash.cost;
    P.regenDelay = C.player.energyRegenDelay;
    emit('player_dash', playerPos(), {
      direction: P.dashDir,
      worldDirection: vec(P.dashVec.x, 0, P.dashVec.z),
      cameraDirection: { x: cam.x, z: cam.z },
      distance: C.dash.distance, duration: C.dash.duration, iframes: C.dash.iframeDuration,
    });
  }

  // ---------------------------------------------------------------- [НОВИЧОК] автоход
  // Желаемая скорость героя (мир, м/с) без руки игрока: вне арены — к Регенту (упёрся в препятствие —
  // обходит вбок), в арене — по кругу на orbitRadius, сторона обхода меняется раз в flipEvery секунд.
  // Пока слеплены чары, герой стоит (руки заняты, как и при ручном ходе).
  function autoWalkVelocity(h) {
    const P = st.p, A = st.auto, K = C.autoWalk;
    // упёрлись: за прошлый шаг прошли заметно меньше желаемого
    if (A.lastX !== null && A.want > 0.5 && h > 0) {
      const got = Math.hypot(P.x - A.lastX, P.z - A.lastZ) / h;
      A.stuckT = got < A.want * K.stuckRatio ? A.stuckT + h : 0;
      if (A.stuckT >= K.stuckTime) { A.stuckT = 0; A.detourT = K.detourTime; A.detourSign = -A.detourSign; if (st.engaged) A.dir = -A.dir; }
    }
    A.lastX = P.x; A.lastZ = P.z;
    if (A.detourT > 0) A.detourT = Math.max(0, A.detourT - h);
    if (st.input.conjure || P.dead) { A.want = 0; return { x: 0, z: 0 }; }
    const rx = P.x - BOSS.x, rz = P.z - BOSS.z, r = Math.hypot(rx, rz) || 1e-6;
    const ur = { x: rx / r, z: rz / r };
    let vx, vz;
    if (st.engaged) {
      A.flipT += h;
      if (A.flipT >= K.flipEvery) { A.flipT = 0; A.dir = -A.dir; }
      const vr = clamp((K.orbitRadius - r) * K.radialGain, -K.radialMax, K.radialMax);
      vx = -ur.z * A.dir * K.orbitSpeed + ur.x * vr;
      vz = ur.x * A.dir * K.orbitSpeed + ur.z * vr;
    } else {
      A.flipT = 0;
      vx = -ur.x * K.approachSpeed; vz = -ur.z * K.approachSpeed;
    }
    if (A.detourT > 0) {
      const a = A.detourSign * K.detourDeg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      [vx, vz] = [vx * c + vz * sn, -vx * sn + vz * c];
    }
    A.want = Math.hypot(vx, vz);
    return { x: vx, z: vz };
  }

  // ---------------------------------------------------------------- [ASHEN_V2] движение
  // Свободное движение в осях камеры: кривая «ходьба → бег», разгон/торможение без «льда»,
  // коллизии по раскладке (подшаги — без проскоков на скорости рывка), земля по groundY.
  function movePlayer(h) {
    const P = st.p, cfg = C.player;
    let tx, tz;
    if (P.dashing) {
      const T = C.dash.duration;
      const u0 = P.dashElapsed / T;
      const u1 = Math.min(1, (P.dashElapsed + h) / T);
      const ds = C.dash.distance * (easeOutQuad(u1) - easeOutQuad(u0));
      tx = P.dashVec.x * ds; tz = P.dashVec.z * ds;
      P.vx = tx / h; P.vz = tz / h;
      P.dashElapsed += h;
      if (P.dashElapsed >= T - EPS) {
        P.dashing = false;
        P.dashElapsed = 0;
        P.vx *= 0.3; P.vz *= 0.3; // выход из рывка — с небольшим остатком скорости
      }
    } else {
      let ix = st.input.moveX, iz = st.input.moveZ;
      const AW = st.input.autoWalk ? autoWalkVelocity(h) : null;   // [НОВИЧОК] автоход ведёт сам, ввод рукой не нужен
      if (AW) { ix = 0; iz = 0; }
      // [V5] «Руль»: вне арены moveX поворачивает героя, moveZ ведёт его вперёд по курсу (оси ввода =
      // курс героя, см. viewYaw); в арене — обход Регента по кругу и сближение, без хода назад
      if (st.input.steer && !AW) {
        const turn = clamp(ix, -1, 1), fwd = Math.max(0, iz);
        if (!st.engaged) {
          P.yaw = wrapAngle(P.yaw - turn * cfg.moveSign * cfg.steerTurnRate * h);
          ix = 0; iz = fwd * (1 - cfg.steerTurnSlow * turn * turn);
        } else {
          ix = turn * (fwd >= 0.99 ? 1 : cfg.steerStrafeWalk);
          iz = fwd * clamp(1 - cfg.steerApproachCut * Math.abs(turn), 0, 1);
        }
      }
      updateFrame(h, ix, iz);
      const m = Math.min(1, Math.hypot(ix, iz));
      let tvx = 0, tvz = 0;
      const dz = cfg.moveDeadzone;
      const M = st.move;
      // [V4] автобег: после спринта рука опущена — герой бежит сам; поднять руку (хватка) — стоп
      if (M.cruise && AW) M.cruise = null;
      if (M.cruise) {
        M.cruise.t += h;
        const why = st.engaged ? 'engaged' : st.input.steer ? 'mode' : st.input.handUp || m > dz ? 'hand' : M.cruise.t > cfg.cruiseMaxTime ? 'timeout' : M.blockedT > 0.35 ? 'blocked' : P.shielding ? 'shield' : null;
        if (why) { emit('cruise_end', playerPos(), { reason: why }); M.cruise = null; M.sprint = why === 'hand' ? M.sprint : 0; M.blockedT = 0; }
      }
      if (AW) {
        const k = P.shielding ? C.shield.moveSpeedFactor : 1;
        tvx = AW.x * k; tvz = AW.z * k; st.auto.want *= k;   // со щитом медленнее — это не «упёрлись»
        M.sprintT = 0; M.fullT = 0; M.sprint = 0; M.dir = null;
      } else if (M.cruise && m <= dz) {
        const ux = Math.sin(M.cruise.dir), uz = Math.cos(M.cruise.dir);
        const g0 = LAY.groundY(P.x, P.z), g1 = LAY.groundY(P.x + ux * 0.6, P.z + uz * 0.6), sl = (g1 - g0) / 0.6;
        const k = clamp(1 - cfg.slopeUp * Math.max(0, sl) + cfg.slopeDown * Math.max(0, -sl), cfg.slopeMin, cfg.slopeMax);
        tvx = ux * cfg.sprintSpeed * k; tvz = uz * cfg.sprintSpeed * k;
        M.sprint = 1;
      } else if (m > dz) {
        const mm = (m - dz) / (1 - dz);
        const spd = mm <= cfg.walkShare ? cfg.walkSpeed * (mm / cfg.walkShare)
          : cfg.walkSpeed + (cfg.runSpeed - cfg.walkSpeed) * (mm - cfg.walkShare) / (1 - cfg.walkShare);
        const w = camToWorld(ix / m, iz / m);
        const wl = Math.hypot(w.x, w.z) || 1;
        const ux = w.x / wl, uz = w.z / wl;
        let k = P.shielding ? C.shield.moveSpeedFactor : 1;
        if (P.vortex > 0) k *= 1 + C.runes.spira.speedBonus;
        // [V4] спринт вне арены: полный ход держится, направление ровное
        {
          const M = st.move, a = Math.atan2(ux, uz);
          const full = mm >= 0.97 && !st.engaged && !P.shielding;
          const turned = M.dir !== null && Math.abs(wrapAngle(a - M.dir)) * 180 / Math.PI > cfg.sprintTurnDeg * h * 4;
          if (full && !turned) M.sprintT += h; else if (!full || Math.abs(wrapAngle(a - (M.dir ?? a))) > Math.PI / 3) M.sprintT = 0;
          M.dir = a;
          const want = M.sprintT >= cfg.sprintDelay ? 1 : 0;
          M.sprint = want >= M.sprint ? Math.min(1, M.sprint + h / cfg.sprintRamp) : Math.max(0, M.sprint - h / 0.25);
        }
        // [V4] склон: в гору медленнее, с горы чуть быстрее
        {
          const g0 = LAY.groundY(P.x, P.z), g1 = LAY.groundY(P.x + ux * 0.6, P.z + uz * 0.6);
          const sl = (g1 - g0) / 0.6;
          k *= clamp(1 - cfg.slopeUp * Math.max(0, sl) + cfg.slopeDown * Math.max(0, -sl), cfg.slopeMin, cfg.slopeMax);
        }
        if (st.engaged) {
          const f = toBossUnit();
          const along = ux * f.x + uz * f.z;
          if (along < -0.5) k *= cfg.backpedalFactor;
          else if (Math.abs(along) < 0.5) k *= cfg.strafeFactor;
        }
        const spdS = spd + (cfg.sprintSpeed - cfg.runSpeed) * st.move.sprint * clamp((mm - 0.9) / 0.1, 0, 1);
        tvx = ux * spdS * k; tvz = uz * spdS * k;
        M.fullT = M.sprint >= 0.999 ? M.fullT + h : 0;
      } else if (!st.engaged && !st.input.steer && M.sprint >= 0.999 && M.fullT >= cfg.cruiseHold && st.input.handDown && M.dir !== null && !P.shielding) {
        M.cruise = { dir: M.dir, t: 0 }; M.blockedT = 0;
        emit('cruise_start', playerPos(), { direction: M.dir });
        tvx = Math.sin(M.dir) * cfg.sprintSpeed; tvz = Math.cos(M.dir) * cfg.sprintSpeed;
      } else { M.sprintT = 0; M.fullT = 0; M.sprint = Math.max(0, M.sprint - h / 0.2); M.dir = null; }
      const speeding = tvx * tvx + tvz * tvz >= P.vx * P.vx + P.vz * P.vz;
      const a = 1 - Math.exp(-h / (speeding ? cfg.accelTime : cfg.stopTime));
      P.vx += (tvx - P.vx) * a;
      P.vz += (tvz - P.vz) * a;
      if (tvx === 0 && tvz === 0 && P.vx * P.vx + P.vz * P.vz < 0.0009) { P.vx = 0; P.vz = 0; }
      tx = P.vx * h; tz = P.vz * h;
      // [V4] в арене боковая составляющая хода идёт по окружности вокруг Регента: касательный шаг
      // иначе каждый кадр чуть отодвигает героя, и за полминуты кружения дистанция «уплывает»
      if (st.engaged && cfg.orbitStrafe) {
        const rx = P.x - BOSS.x, rz = P.z - BOSS.z, r = Math.hypot(rx, rz);
        if (r > 1) {
          const ur = { x: rx / r, z: rz / r }, ut = { x: -ur.z, z: ur.x };
          const rad = tx * ur.x + tz * ur.z, lat = tx * ut.x + tz * ut.z;
          const th = lat / r, c = Math.cos(th), sn = Math.sin(th);
          const nx = rx * c - rz * sn, nz = rx * sn + rz * c;          // поворот вокруг Регента на дугу lat
          const r2 = Math.max(0.5, r + rad);
          tx = BOSS.x + nx / r * r2 - P.x; tz = BOSS.z + nz / r * r2 - P.z;
        }
      }
    }
    const x0 = P.x, z0 = P.z;
    const to = resolveMove(P.x, P.z, P.x + tx, P.z + tz);
    P.x = to.x; P.z = to.z;
    // [V4] в арене скорость «переносится» вместе с поворотом героя вокруг Регента: иначе сглаженная
    // скорость отстаёт от касательной, получает наружную составляющую, и дистанция растёт при кружении
    if (st.engaged && C.player.orbitStrafe && !P.dashing) {
      const a0 = Math.atan2(x0 - BOSS.x, z0 - BOSS.z), a1 = Math.atan2(P.x - BOSS.x, P.z - BOSS.z);
      const d = wrapAngle(a1 - a0), c = Math.cos(d), sn = Math.sin(d);
      const vx = P.vx * c + P.vz * sn, vz = -P.vx * sn + P.vz * c;
      P.vx = vx; P.vz = vz;
    }
    if (h > 0 && !P.dashing) {
      // упёрлись в стену — скорость гасится вдоль нормали (скольжение сохраняется)
      const rx = (P.x - x0) / h, rz = (P.z - z0) / h;
      if (st.move.cruise) {
        const want = Math.hypot(tx, tz) / h, got = Math.hypot(rx, rz);
        st.move.blockedT = want > 1 && got < want * 0.3 ? st.move.blockedT + h : 0;
      }
      if (rx * rx + rz * rz < P.vx * P.vx + P.vz * P.vz) { P.vx = rx; P.vz = rz; }
    }
    P.y = LAY.groundY(P.x, P.z);
    updateFacing(h);
    updateEncounter();
  }

  // Коллизии: круги и отрезки раскладки, тело Регента, проходимость (обрыв). Подшаги ≤ 0.2 м.
  function resolveMove(x0, z0, x1, z1) {
    const r = C.player.hitRadius;
    if (typeof LAY.resolveMove === 'function') {
      const o = LAY.resolveMove({ x: x0, z: z0 }, { x: x1, z: z1 }, r);
      if (o && Number.isFinite(o.x) && Number.isFinite(o.z)) return keepFromBoss(o.x, o.z, r);
    }
    const dx = x1 - x0, dz = z1 - z0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.2));
    let x = x0, z = z0;
    for (let i = 0; i < n; i++) {
      let nx = x + dx / n, nz = z + dz / n;
      ({ x: nx, z: nz } = pushOut(nx, nz, r));
      if (!LAY.isWalkable(nx, nz)) {
        // скольжение вдоль края: пробуем оси по отдельности
        const ax = pushOut(x + dx / n, z, r), az = pushOut(x, z + dz / n, r);
        if (LAY.isWalkable(ax.x, ax.z)) ({ x: nx, z: nz } = ax);
        else if (LAY.isWalkable(az.x, az.z)) ({ x: nx, z: nz } = az);
        else { nx = x; nz = z; }
      }
      x = nx; z = nz;
    }
    return { x, z };
  }
  function keepFromBoss(x, z, r) {
    const dx = x - BOSS.x, dz = z - BOSS.z, d = Math.hypot(dx, dz), R = C.player.minBossDistance;
    if (d < R) {
      if (d < 1e-6) return { x: BOSS.x + R, z: BOSS.z };
      return { x: BOSS.x + dx / d * R, z: BOSS.z + dz / d * R };
    }
    return { x, z };
  }
  function pushOut(x, z, r) {
    const list = LAY.grid ? LAY.grid.near(x, z) : LAY.colliders;   // [ASHEN_V3] сетка на большой карте
    for (const c of list) {
      if (c.type === 'circle') {
        const dx = x - c.x, dz = z - c.z, R = c.r + r, d2 = dx * dx + dz * dz;
        if (d2 < R * R) {
          const d = Math.sqrt(d2);
          if (d < 1e-6) { x = c.x + R; } else { x = c.x + dx / d * R; z = c.z + dz / d * R; }
        }
      } else if (c.type === 'segment') {
        const ex = c.bx - c.ax, ez = c.bz - c.az, L2 = ex * ex + ez * ez;
        const u = L2 > 0 ? clamp(((x - c.ax) * ex + (z - c.az) * ez) / L2, 0, 1) : 0;
        const qx = c.ax + ex * u, qz = c.az + ez * u;
        const dx = x - qx, dz = z - qz, R = (c.r || 0) + r, d2 = dx * dx + dz * dz;
        if (d2 < R * R) {
          const d = Math.sqrt(d2);
          if (d < 1e-6) { x = qx - ez / Math.sqrt(L2 || 1) * R; z = qz + ex / Math.sqrt(L2 || 1) * R; }
          else { x = qx + dx / d * R; z = qz + dz / d * R; }
        }
      }
    }
    return keepFromBoss(x, z, r);
  }

  function updateFacing(h) {
    const P = st.p;
    let target = null;
    if (st.engaged) { const f = toBossUnit(); target = Math.atan2(f.x, f.z); }
    else if (st.input.steer && !st.input.autoWalk) return;    // [V5] «Руль»: курс задаёт рука, не скорость ([НОВИЧОК] в автоходе — по ходу)
    else if (P.vx * P.vx + P.vz * P.vz > 0.16) target = Math.atan2(P.vx, P.vz);
    if (target === null) return;
    const diff = wrapAngle(target - P.yaw);
    const maxT = C.player.turnRate * h;
    P.yaw = wrapAngle(P.yaw + clamp(diff, -maxT, maxT));
  }

  // Встреча: в арене — бой (lock-on, босс атакует), за её пределами дальше leash — исследование.
  function engage(reason) {
    if (st.engaged) return;
    st.engaged = true;
    emit('encounter_start', playerPos(), { reason, arena: { x: LAY.arena.x, z: LAY.arena.z, r: LAY.arena.r } });
  }
  function updateEncounter() {
    if (PV && PV.on) { PV.encounter(); return; }   // [PVP] engaged — соперник ближе ~35 м
    if (!C.encounter.enabled) { st.engaged = true; return; }
    const d = distXZ(st.p, LAY.arena);
    if (!st.engaged && d <= LAY.arena.r) engage('arena');
    else if (st.engaged && d > LAY.arena.r + C.encounter.leash && st.aggroT <= 0) {
      st.engaged = false;
      for (const t of st.telegraphs) emit('telegraph_cancel', t.center, { attackId: t.id, attackKind: t.kind, reason: 'left_arena' });
      st.telegraphs.length = 0;
      st.projectiles = st.projectiles.filter((pr) => pr.owner !== 'boss');
      st.b.decisionAction = 'idle';
      emit('encounter_end', playerPos(), { reason: 'left_arena' });
    }
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
    const both = st.pendingBurstBoth;
    st.pendingBurstBoth = false;
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
    const power = st.pendingBurstPower === null ? 0.5 : st.pendingBurstPower;
    st.pendingBurstPower = null;
    const dmg = C.burst.damage * (0.5 + power) * (both ? 1 + C.burst.bothHandsBonus : 1); // заряд кулака: ×0.5 … ×1.5; двумя руками — бонус
    if (PV && PV.on && PV.burst(dmg, power, both, cleared, chest, to)) return;   // [PVP] выброс — волна в соперника
    emit('burst', chest, { amount: dmg, power, both, cleared, from: vcopy(chest), to: vcopy(to), radius: C.burst.clearRadius * (0.7 + 0.6 * power) });
    damageBoss(dmg, 'burst', to);
  }

  // [ASHEN_V3] двуручные печати
  function trySigil() {
    const P = st.p, B = st.b;
    const sg = st.pendingSigil;
    if (!sg) return;
    st.pendingSigil = null;
    const S = C.sigils[sg];
    let reason = '';
    if (P.sigilCd[sg] > EPS) reason = 'cooldown';
    else if (P.energy < S.energy) reason = 'energy';
    else if (st.input.conjure) reason = 'busy';
    if (reason) { emit('ability_denied', playerPos(), { ability: 'sigil', sigil: sg, reason }); return; }
    P.energy -= S.energy;
    P.regenDelay = C.player.energyRegenDelay;
    P.sigilCd[sg] = S.cooldown;
    P.castTimer = Math.max(P.castTimer, C.sigils.castTime);
    const pp = playerPos(), chest = playerChest(), to = bossAim();
    if (PV && PV.on && PV.sigil(sg, S, chest, to)) return;   // [PVP] печати против игрока
    if (sg === 'clap') {
      let cleared = 0;
      const keep = [];
      for (const pr of st.projectiles) {
        if (pr.owner === 'boss' && distXZ(pr.position, pp) <= S.radius) {
          cleared++;
          emit('projectile_impact', pr.position, { owner: 'boss', kind: pr.kind, projectileId: pr.id, attackId: pr.attackId, result: 'dispelled' });
        } else keep.push(pr);
      }
      st.projectiles = keep;
      const near = distXZ(pp, BOSS) <= S.reach;
      emit('sigil_cast', chest, { sigil: 'clap', radius: S.radius, cleared, stunned: near, from: vcopy(chest), to: vcopy(to) });
      if (near) {
        for (const t of st.telegraphs) emit('telegraph_cancel', t.center, { attackId: t.id, attackKind: t.kind, reason: 'stun' });
        st.telegraphs.length = 0;
        B.stun = Math.max(B.stun, S.stun);
        emit('boss_stunned', to, { duration: S.stun, source: 'clap' });
        damageBoss(S.damage, 'sigil', to, { sigil: 'clap' });
      }
    } else if (sg === 'gate') {
      P.bastion = S.duration;
      emit('sigil_cast', chest, { sigil: 'gate', duration: S.duration, reduction: S.reduction, from: vcopy(chest), to: vcopy(chest) });
      emit('bastion_start', pp, { duration: S.duration });
    } else if (sg === 'frame') {
      B.mark = S.duration;
      emit('sigil_cast', chest, { sigil: 'frame', duration: S.duration, bonus: S.bonus, from: vcopy(chest), to: vcopy(to) });
      emit('mark_start', to, { duration: S.duration, bonus: S.bonus });
    } else if (sg === 'delta') {
      // луч: гасит сферы Регента на линии «герой → Регент», затем ticks ударов
      const ax = pp.x, az = pp.z, bx = BOSS.x, bz = BOSS.z, ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
      let cleared = 0;
      const keep = [];
      for (const pr of st.projectiles) {
        if (pr.owner === 'boss') {
          const u = clamp(((pr.position.x - ax) * ex + (pr.position.z - az) * ez) / L2, 0, 1);
          if (Math.hypot(pr.position.x - ax - ex * u, pr.position.z - az - ez * u) <= S.width) {
            cleared++;
            emit('projectile_impact', pr.position, { owner: 'boss', kind: pr.kind, projectileId: pr.id, attackId: pr.attackId, result: 'dispelled' });
            continue;
          }
        }
        keep.push(pr);
      }
      st.projectiles = keep;
      P.beam = Array.from({ length: S.ticks }, (_, i) => ({ i, t: 0.15 + i * S.interval }));
      emit('sigil_cast', chest, { sigil: 'delta', ticks: S.ticks, amount: S.ticks * S.damage, cleared, from: vcopy(chest), to: vcopy(to) });
    } else if (sg === 'cor') {
      P.regen = S.duration; P.regenRate = S.heal / Math.max(0.1, S.duration);
      P.ward = S.ward;
      emit('sigil_cast', chest, { sigil: 'cor', heal: S.heal, duration: S.duration, ward: S.ward, from: vcopy(chest), to: vcopy(chest) });
      emit('ward_start', pp, { duration: S.ward });
    }
  }

  // [№1, «Перстни»] руны
  function tryRune() {
    const P = st.p, B = st.b;
    const rune = st.pendingRune;
    if (!rune) return;
    st.pendingRune = null;
    const R = C.runes[rune];
    let reason = '';
    if (P.runeCd[rune] > EPS) reason = 'cooldown';
    else if (P.energy < R.energy) reason = 'energy';
    if (reason) { emit('ability_denied', playerPos(), { ability: 'rune', rune, reason }); return; }
    P.energy -= R.energy;
    P.regenDelay = C.player.energyRegenDelay;
    P.runeCd[rune] = R.cooldown;
    P.castTimer = C.runes.castTime;
    const chest = playerChest();
    const to = bossAim();
    if (PV && PV.on && PV.rune(rune, R, chest, to)) return;   // [PVP] руны против игрока: снаряды и fx
    if (rune === 'ignis') {
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(to), amount: R.damage });
      damageBoss(R.damage, 'rune', to);
    } else if (rune === 'fulgur') {
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(to), stun: R.stun, cancelled: st.telegraphs.length });
      for (const t of st.telegraphs) emit('telegraph_cancel', t.center, { attackId: t.id, attackKind: t.kind, reason: 'stun' });
      st.telegraphs.length = 0;
      B.stun = R.stun;
      emit('boss_stunned', to, { duration: R.stun });
      damageBoss(R.damage, 'rune', to);
    } else if (rune === 'orbis') {
      const before = P.hp;
      P.hp = Math.min(C.player.maxHp, P.hp + R.heal);
      P.ward = R.ward;
      emit('rune_cast', chest, { rune, heal: P.hp - before, ward: R.ward, from: vcopy(chest), to: vcopy(chest) });
      emit('ward_start', playerPos(), { duration: R.ward });
    } else if (rune === 'stella') {
      P.meteors = Array.from({ length: R.count }, (_, i) => ({ i, t: 0.25 + i * R.interval }));
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(to), count: R.count, amount: R.damage * R.count });
    } else if (rune === 'spira') {
      P.vortex = R.duration;
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(chest), duration: R.duration, radius: R.radius });
    } else if (rune === 'lemnis') {
      P.regen = R.duration; P.regenRate = R.heal / Math.max(0.1, R.duration);
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(chest), heal: R.heal, duration: R.duration });
    } else if (rune === 'caret') {
      const S = C.spark;
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(to), count: R.count });
      for (let i = 0; i < R.count; i++) {
        const off = (i - (R.count - 1) / 2) * R.spreadDeg * Math.PI / 180;
        let vx = to.x - chest.x, vy = to.y - chest.y, vz = to.z - chest.z;
        const c = Math.cos(off), sn = Math.sin(off);
        [vx, vz] = [vx * c - vz * sn, vx * sn + vz * c];
        const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        const id = `caret:${fightGen}:${++projSeq}`;
        addProjectile({
          id, owner: 'player', kind: 'spark', position: vcopy(chest),
          velocity: vec(vx / vl * S.speed, vy / vl * S.speed, vz / vl * S.speed), radius: S.radius * 1.2,
          age: 0, lifetime: S.lifetime * 1.5, damage: R.damage, attackId: null, passed: false, homing: true,
        });
      }
    } else if (rune === 'vee') {
      const before = P.hp;
      P.hp = Math.min(C.player.maxHp, P.hp + R.heal);
      emit('rune_cast', chest, { rune, from: vcopy(to), to: vcopy(chest), heal: P.hp - before, amount: R.damage });
      damageBoss(R.damage, 'rune', to, { rune: 'vee' });
    } else if (rune === 'clepsydra') {
      B.slow = R.duration;
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(to), duration: R.duration, slow: R.slow });
      emit('slow_start', to, { duration: R.duration, slow: R.slow });
    } else if (rune === 'alpha') {
      P.dashCd = 0; P.sparkCd = 0; P.slashCd = 0; P.throwCd = 0; P.parryCd = 0;
      P.energy = Math.min(C.player.maxEnergy, P.energy + R.energyGain);
      emit('rune_cast', chest, { rune, from: vcopy(chest), to: vcopy(chest), energy: R.energyGain });
    }
  }

  // [бросок] Сфера (из conjure 'orb') или призма, брошенная двумя руками.
  // Полёт — квадратичная кривая Безье от ладоней героя к центру стража: контрольная точка
  // смещена вбок по aimX (экранно-вправо при aimX > 0) и чуть вверх, поэтому снаряд сначала
  // уходит дугой, а потом «доворачивает» в цель. Кривая заканчивается ВНУТРИ цилиндра стража,
  // значит пересечение гарантировано; попадание всё равно считается swept-тестом, как у болтов.
  function throwDamage(kind, size, power) {
    const T = C.throw;
    let d = T.damageBase + T.damagePower * power * (T.sizeFloor + (1 - T.sizeFloor) * size);
    if (kind === 'prism') d *= 1 + T.prismBonus;
    return Math.round(d);
  }
  function throwCost(size) { return C.throw.energyBase + C.throw.energyPerSize * size; }

  function tryThrow() {
    const P = st.p;
    const t = st.pendingThrow;
    if (!t) return;
    st.pendingThrow = null; // одна попытка на один импульс
    const kind = t.kind === 'prism' ? 'prism' : 'sphere';
    const cost = throwCost(t.size);
    let reason = '';
    if (P.throwCd > EPS) reason = 'cooldown';
    else if (P.shielding) reason = 'shield';   // щит (левая ладонь) приоритетнее, как у огня
    else if (P.energy < cost) reason = 'energy';
    if (reason) {
      emit('ability_denied', conjurePoint(), { ability: 'throw', kind, reason, cost, energy: P.energy });
      return;
    }
    P.energy -= cost;
    P.regenDelay = C.player.energyRegenDelay;
    P.throwCd = C.throw.cooldown;
    P.castTimer = Math.max(P.castTimer, C.throw.castTime);
    spawnThrow(kind, t.size, t.power, t.aimX, cost);
  }

  function spawnThrow(kind, size, power, aimX, cost) {
    const T = C.throw;
    const p0 = conjurePoint();
    const p2 = bossAim();
    const dx = p2.x - p0.x, dz = p2.z - p0.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const right = screenRight();
    const side = aimX * T.curve * dist;
    const p1 = vec(
      (p0.x + p2.x) / 2 + right.x * side,
      (p0.y + p2.y) / 2 + T.loft * dist,
      (p0.z + p2.z) / 2 + right.z * side,
    );
    const speed = T.speedMin + (T.speedMax - T.speedMin) * power;
    const radius = T.radiusBase + T.radiusPerSize * size;
    const damage = throwDamage(kind, size, power);
    const id = `${kind}:${fightGen}:${++projSeq}`;
    const path = { p0, p1, p2, u: 0 };
    const velocity = bezierVelocity(path, 0, speed);
    addProjectile({
      id, owner: 'player', kind,
      position: vcopy(p0), velocity, radius,
      age: 0, lifetime: T.lifetime, damage, attackId: null, passed: false,
      path, speed, size, power, pierced: 0,
    });
    emit('player_cast', p0, {
      ability: 'throw', kind, size, power, aimX, projectileId: id,
      damage, radius, energyCost: cost, velocity: vcopy(velocity), from: vcopy(p0), to: vcopy(p2),
    });
  }

  // ---------------------------------------------------------------- [ASHEN_V2] приёмы двух рук
  function deny(ability, reason, extra) {
    emit('ability_denied', playerPos(), { ability, reason, energy: st.p.energy, ...(extra || {}) });
  }

  // «Искра»: быстрый одиночный снаряд из правой руки.
  function trySpark() {
    const P = st.p, S = C.spark;
    if (!st.pendingSpark) return;
    st.pendingSpark = false;
    let reason = '';
    if (P.sparkCd > EPS) reason = 'cooldown';
    else if (P.shielding) reason = 'shield';
    else if (P.hitReact > 0) reason = 'hit';
    else if (st.input.conjure) reason = 'busy';
    else if (P.energy < S.cost) reason = 'energy';
    if (reason) { deny('spark', reason); return; }
    const pp = playerPos();
    const f = st.engaged ? toBossUnit() : { x: Math.sin(P.yaw), z: Math.cos(P.yaw) };
    const right = { x: -f.z, z: f.x };
    const spawn = vec(pp.x + f.x * S.spawnForward + right.x * S.spawnSide, pp.y + S.spawnHeight, pp.z + f.z * S.spawnForward + right.z * S.spawnSide);
    let vx, vy, vz;
    if (st.engaged) {
      const aim = bossAim();
      vx = aim.x - spawn.x; vy = aim.y - spawn.y; vz = aim.z - spawn.z;
    } else { vx = f.x; vy = 0; vz = f.z; }
    const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    vx = vx / vl * S.speed; vy = vy / vl * S.speed; vz = vz / vl * S.speed;
    const id = `spark:${fightGen}:${++projSeq}`;
    addProjectile({
      id, owner: 'player', kind: 'spark',
      position: spawn, velocity: vec(vx, vy, vz), radius: S.radius,
      age: 0, lifetime: S.lifetime, damage: S.damage, attackId: null, passed: false,
    });
    P.energy -= S.cost;
    P.regenDelay = C.player.energyRegenDelay;
    P.sparkCd = S.cooldown;
    P.sparkT = S.castTime;
    P.castTimer = Math.max(P.castTimer, S.castTime);
    emit('player_cast', spawn, { ability: 'spark', projectileId: id, velocity: vec(vx, vy, vz) });
  }

  // «Рассечение»: мгновенная дуга перед героем. Бьёт Регента (×recoverBonus в фазе recover)
  // и рассекает орбы в дуге.
  function trySlash() {
    const P = st.p, S = C.slash;
    const req = st.pendingSlash;
    if (!req) return;
    st.pendingSlash = null;
    let reason = '';
    if (P.slashCd > EPS) reason = 'cooldown';
    else if (P.shielding) reason = 'shield';
    else if (P.hitReact > 0) reason = 'hit';
    else if (st.input.conjure) reason = 'busy';
    else if (P.energy < S.cost) reason = 'energy';
    if (reason) { deny('slash', reason, { dir: req.dir }); return; }
    const pp = playerPos();
    const face = st.engaged ? toBossUnit() : { x: Math.sin(P.yaw), z: Math.cos(P.yaw) };
    const yaw = Math.atan2(face.x, face.z);
    const half = (S.angleDeg * Math.PI / 180) / 2;
    const inArc = (x, z, extra) => {
      const dx = x - pp.x, dz = z - pp.z, d = Math.hypot(dx, dz);
      if (d > S.radius + extra) return false;
      if (d < 1e-6) return true;
      return Math.abs(wrapAngle(Math.atan2(dx, dz) - yaw)) <= half + Math.atan2(extra, Math.max(d, 1e-3));
    };
    P.energy -= S.cost;
    P.regenDelay = C.player.energyRegenDelay;
    P.slashCd = S.cooldown;
    P.slashT = S.castTime;
    P.castTimer = Math.max(P.castTimer, S.castTime);
    // орбы босса в дуге рассекаются
    let cut = 0;
    for (const o of st.projectiles) {
      if (o.owner !== 'boss' || o.shattered) continue;
      if (!inArc(o.position.x, o.position.z, o.radius) || o.position.y > C.player.height + 1.5) continue;
      o.shattered = true; cut++;
      emit('projectile_impact', o.position, { owner: 'boss', kind: o.kind, projectileId: o.id, attackId: o.attackId, result: 'dispelled', by: 'slash' });
    }
    if (cut) st.projectiles = st.projectiles.filter((o) => !o.shattered);
    const chest = playerChest();
    const hit = !st.b.dead && inArc(BOSS.x, BOSS.z, C.boss.hitRadius);
    emit('player_cast', chest, { ability: 'slash', dir: req.dir, power: req.power });
    emit('player_slash', chest, {
      dir: req.dir, power: req.power, hit, cut,
      arc: { origin: vcopy(chest), yaw, radius: S.radius, angleDeg: S.angleDeg },
    });
    if (hit) {
      const bonus = st.b.decisionAction === 'recover' ? S.recoverBonus : 1;
      const dmg = (S.damageMin + (S.damageMax - S.damageMin) * req.power) * bonus;
      damageBoss(dmg, 'slash', bossAim(), { dir: req.dir, power: req.power, recoverBonus: bonus > 1 });
    }
  }

  // Парирование: открывает окно; орбы босса, которые за это окно попали бы в героя (или уже рядом),
  // отражаются в Регента. Промах — короткий кулдаун.
  function tryParry() {
    const P = st.p;
    if (!st.pendingParry) return;
    st.pendingParry = false;
    let reason = '';
    if (P.parryCd > EPS) reason = 'cooldown';
    else if (P.parryWin > 0) reason = 'active';
    else if (P.hitReact > 0) reason = 'hit';
    else if (st.input.conjure) reason = 'busy';
    if (reason) { deny('parry', reason); return; }
    P.parryWin = C.parry.window;
    P.parryHit = false;
    P.parryT = C.parry.castTime;
  }
  function updateParry(h) {
    const P = st.p, Q = C.parry;
    if (P.parryWin <= 0) return;
    const chest = playerChest();
    for (const o of st.projectiles) {
      if (o.owner !== 'boss' || o.shattered || o.passed) continue;
      const dx = chest.x - o.position.x, dy = chest.y - o.position.y, dz = chest.z - o.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const vl = Math.sqrt(o.velocity.x ** 2 + o.velocity.y ** 2 + o.velocity.z ** 2) || 1;
      const closing = (o.velocity.x * dx + o.velocity.y * dy + o.velocity.z * dz) / vl; // скорость сближения
      const tHit = closing > 0 ? (d - o.radius - C.player.hitRadius) / closing * (vl / Math.max(vl, 1e-6)) : Infinity;
      if (d > Q.reach + o.radius && !(tHit <= P.parryWin)) continue;
      // отражение: снаряд становится снарядом героя и летит в Регента
      const aim = bossAim();
      let ax = aim.x - o.position.x, ay = aim.y - o.position.y, az = aim.z - o.position.z;
      const al = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      const sp = vl * Q.reflectSpeedMul;
      o.owner = 'player';
      o.reflected = true;
      o.velocity = vec(ax / al * sp, ay / al * sp, az / al * sp);
      o.damage = Math.round((o.baseDamage || o.damage || 20) * Q.reflectDamageMul);   // [FEEL] сложность не режет награду за парирование
      o.age = 0;
      o.lifetime = Math.max(o.lifetime || 0, al / sp + 0.5);
      o.passed = false;
      P.parryHit = true;
      P.energy = Math.min(C.player.maxEnergy, P.energy + Q.energyGain);
      emit('parry', vcopy(o.position), { success: true, projectileId: o.id });
      addFury(C.ultimate.parry);   // [W3-ULT]
      emit('projectile_reflected', vcopy(o.position), { projectileId: o.id, owner: 'player' });
    }
    P.parryWin = Math.max(0, P.parryWin - h);
    if (P.parryWin <= 0 && !P.parryHit) {
      P.parryCd = Q.whiffCooldown;
      emit('parry', chest, { success: false });
    }
  }

  function bezierPoint(path, u) {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    const { p0, p1, p2 } = path;
    return vec(a * p0.x + b * p1.x + c * p2.x, a * p0.y + b * p1.y + c * p2.y, a * p0.z + b * p1.z + c * p2.z);
  }
  function bezierTangent(path, u) {
    const { p0, p1, p2 } = path;
    const a = 2 * (1 - u), b = 2 * u;
    return vec(a * (p1.x - p0.x) + b * (p2.x - p1.x), a * (p1.y - p0.y) + b * (p2.y - p1.y), a * (p1.z - p0.z) + b * (p2.z - p1.z));
  }
  function bezierVelocity(path, u, speed) {
    const d = bezierTangent(path, u);
    const l = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
    return vec(d.x / l * speed, d.y / l * speed, d.z / l * speed);
  }
  // Шаг по кривой с почти постоянной скоростью: du по длине касательной в середине шага.
  function advanceOnPath(pr, h) {
    const path = pr.path;
    const len = (u) => { const d = bezierTangent(path, u); return Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z); };
    const ds = pr.speed * h;
    const du0 = ds / Math.max(1e-6, len(path.u));
    const du = ds / Math.max(1e-6, len(Math.min(1, path.u + du0 / 2)));
    path.u = Math.min(1, path.u + du);
    const p = bezierPoint(path, path.u);
    pr.position.x = p.x; pr.position.y = p.y; pr.position.z = p.z;
    const v = bezierVelocity(path, path.u, pr.speed);
    pr.velocity.x = v.x; pr.velocity.y = v.y; pr.velocity.z = v.z;
  }

  // Минимальное расстояние от отрезка a→b до точки c (для призмы против орбов).
  function segmentPointDist(a, b, c) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const l2 = abx * abx + aby * aby + abz * abz;
    let t = l2 > 1e-12 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2 : 0;
    t = clamp(t, 0, 1);
    const x = a.x + abx * t - c.x, y = a.y + aby * t - c.y, z = a.z + abz * t - c.z;
    return Math.sqrt(x * x + y * y + z * z);
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
    // Пока руки лепят заклинание (conjure), огонь щипком не идёт: обе руки заняты.
    const can = st.input.attack && !P.shielding && !P.dashing && P.hitReact <= 0 && !st.input.conjure &&
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
  // Призма раскалывает орбы стража, которых касается на этом шаге, и летит дальше.
  // Орбы помечаются и удаляются после цикла (их позиция — с прошлого шага: при
  // относительном смещении ≤ 0.3 м за шаг и сумме радиусов ≥ 0.4 м пролёт не пропускается).
  function prismPierce(pr, prev) {
    for (const o of st.projectiles) {
      if (o.owner !== 'boss' || o.shattered) continue;
      if (segmentPointDist(prev, pr.position, o.position) > pr.radius + o.radius) continue;
      o.shattered = true;
      pr.pierced++;
      emit('projectile_impact', o.position, {
        owner: 'boss', kind: o.kind, projectileId: o.id, attackId: o.attackId, result: 'dispelled',
        by: 'prism', byProjectileId: pr.id,
      });
    }
  }

  function updatePlayerProjectiles(h) {
    const list = st.projectiles;
    let w = 0;
    let shattered = false;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (pr.owner !== 'player') { list[w++] = pr; continue; }
      const prev = vcopy(pr.position);
      if (pr.homing && !pr.path) {
        // [V3] иглы «Акус» доворачивают к Регенту (веер сходится в цель)
        const to = bossAim(), sp = Math.hypot(pr.velocity.x, pr.velocity.y, pr.velocity.z) || 1;
        let dx = to.x - pr.position.x, dy = to.y - pr.position.y, dz = to.z - pr.position.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const k = 1 - Math.exp(-7 * h);
        let vx = pr.velocity.x + (dx / dl * sp - pr.velocity.x) * k, vy = pr.velocity.y + (dy / dl * sp - pr.velocity.y) * k, vz = pr.velocity.z + (dz / dl * sp - pr.velocity.z) * k;
        const vl = Math.hypot(vx, vy, vz) || 1;
        pr.velocity.x = vx / vl * sp; pr.velocity.y = vy / vl * sp; pr.velocity.z = vz / vl * sp;
      }
      if (pr.path) advanceOnPath(pr, h);
      else {
        pr.position.x += pr.velocity.x * h;
        pr.position.y += pr.velocity.y * h;
        pr.position.z += pr.velocity.z * h;
      }
      pr.age += h;
      if (pr.kind === 'prism') { const n = pr.pierced; prismPierce(pr, prev); if (pr.pierced > n) shattered = true; }
      const hit = sweptCylinderHit(prev, pr.position, BOSS, BOSS,
        pr.radius + C.boss.hitRadius, -pr.radius, C.boss.height + pr.radius);
      if (hit.hit) {
        const point = vec(prev.x + (pr.position.x - prev.x) * hit.t,
          prev.y + (pr.position.y - prev.y) * hit.t,
          prev.z + (pr.position.z - prev.z) * hit.t);
        if (PV && PV.on) { PV.projectileHit(pr, point); continue; }   // [PVP] попадание в капсулу соперника → hit
        if (pr.path) {
          emit('projectile_impact', point, {
            owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'boss',
            damage: pr.damage, size: pr.size, power: pr.power, radius: pr.radius, pierced: pr.pierced,
          });
          damageBoss(pr.damage, 'throw', point, { kind: pr.kind, projectileId: pr.id, size: pr.size, power: pr.power });
        } else {
          emit('projectile_impact', point, { owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'boss' });
          damageBoss(pr.damage, 'bolt', point);
        }
        if (st.status !== 'playing') return; // finish уже очистил списки
        continue;
      }
      // [ASHEN_V2] открытая карта: дальность — по времени жизни (стреляют и из-за арены)
      const fy = PV && PV.on ? PV.floorY : 0;   // [PVP] поляна дуэли может лежать ниже нуля (лес −2.2): пол — от земли бойцов
      const expired = pr.age >= pr.lifetime || distXZ(pr.position, BOSS) > 80 || pr.position.y < fy - 1 ||
        (pr.path && pr.path.u >= 1) || (pr.path && pr.position.y < fy);
      if (expired) {
        // Кривая броска кончается внутри стража, так что это страховка (например, другой
        // arena.bossPosition в конфиге); болты по-прежнему исчезают молча.
        if (pr.path) {
          emit('projectile_impact', vec(pr.position.x, Math.max(0, pr.position.y), pr.position.z), {
            owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'floor', pierced: pr.pierced,
          });
        }
        continue;
      }
      list[w++] = pr;
    }
    list.length = w;
    if (shattered) st.projectiles = st.projectiles.filter(o => !o.shattered);
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
        damage: t.damage, baseDamage: t.baseDamage, blockable: t.blockable, attackId: t.id, passed: false,
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
      if (pr.age >= pr.lifetime || distXZ(pr.position, BOSS) > 80) continue; // дальность — по времени жизни
      list[w++] = pr;
    }
    list.length = w;
  }

  function updateBossYaw(h) {
    const B = st.b;
    if (B.stun > 0) return;
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
    P.throwCd = Math.max(0, P.throwCd - h);
    P.sparkCd = Math.max(0, P.sparkCd - h);
    st.aggroT = Math.max(0, st.aggroT - h);
    P.slashCd = Math.max(0, P.slashCd - h);
    P.parryCd = Math.max(0, P.parryCd - h);
    P.parryT = Math.max(0, P.parryT - h);
    P.slashT = Math.max(0, P.slashT - h);
    P.sparkT = Math.max(0, P.sparkT - h);
    P.iframe = Math.max(0, P.iframe - h);
    P.grace = Math.max(0, P.grace - h);
    P.hitReact = Math.max(0, P.hitReact - h);
    P.castTimer = Math.max(0, P.castTimer - h);
    B.hitReact = Math.max(0, B.hitReact - h);
    for (const k of RUNE_IDS) P.runeCd[k] = Math.max(0, P.runeCd[k] - h);
    if (st.dashBuffer) { st.dashBuffer.t -= h; if (st.dashBuffer.t <= 0) st.dashBuffer = null; }
    for (const k of SIGIL_IDS) P.sigilCd[k] = Math.max(0, P.sigilCd[k] - h);
    if (P.bastion > 0) { P.bastion = Math.max(0, P.bastion - h); if (P.bastion <= 0) emit('bastion_end', playerPos(), { reason: 'expired' }); }
    if (B.mark > 0) { B.mark = Math.max(0, B.mark - h); if (B.mark <= 0) emit('mark_end', vcopy(BOSS), { reason: 'expired' }); }
    if (B.slow > 0) { B.slow = Math.max(0, B.slow - h); if (B.slow <= 0) emit('slow_end', vcopy(BOSS), { reason: 'expired' }); }
    if (P.vortex > 0) {
      P.vortex = Math.max(0, P.vortex - h);
      // вихрь гасит сферы Регента вокруг героя, пока крутится
      const pp = playerPos(), R = C.runes.spira.radius;
      let any = false;
      const keep = [];
      for (const pr of st.projectiles) {
        if (pr.owner === 'boss' && distXZ(pr.position, pp) <= R) { any = true; emit('projectile_impact', pr.position, { owner: 'boss', kind: pr.kind, projectileId: pr.id, attackId: pr.attackId, result: 'dispelled' }); }
        else keep.push(pr);
      }
      if (any) st.projectiles = keep;
      if (P.vortex <= 0) emit('vortex_end', pp, { reason: 'expired' });
    }
    if (P.regen > 0) {
      const dtR = Math.min(h, P.regen);
      P.regen = Math.max(0, P.regen - h);
      if (P.hp > 0) P.hp = Math.min(C.player.maxHp, P.hp + P.regenRate * dtR);
      if (P.regen <= 0) emit('regen_end', playerPos(), { reason: 'expired' });
    }
    if (P.beam.length) {
      for (const m of P.beam) m.t -= h;
      while (P.beam.length && P.beam[0].t <= 0 && st.status === 'playing') {
        const m = P.beam.shift();
        const to = bossAim();
        emit('sigil_hit', to, { sigil: 'delta', index: m.i, amount: C.sigils.delta.damage, from: playerChest() });
        damageBoss(C.sigils.delta.damage, 'sigil', to, { sigil: 'delta' });
      }
    }
    if (P.meteors.length) {
      for (const m of P.meteors) m.t -= h;
      while (P.meteors.length && P.meteors[0].t <= 0 && st.status === 'playing') {
        const m = P.meteors.shift();
        const to = bossAim();
        emit('rune_hit', to, { rune: 'stella', index: m.i, amount: C.runes.stella.damage });
        damageBoss(C.runes.stella.damage, 'rune', to, { rune: 'stella' });
      }
    }
    if (P.ward > 0) { P.ward = Math.max(0, P.ward - h); if (P.ward <= 0) emit('ward_end', playerPos(), { reason: 'expired' }); }
    if (B.stun > 0) B.stun = Math.max(0, B.stun - h);
    if (P.comboTimer > 0) { P.comboTimer = Math.max(0, P.comboTimer - h); if (P.comboTimer <= 0 && P.combo > 0) breakCombo('timeout'); }
  }

  // ---------------------------------------------------------------- шаг
  function step(h) {
    if (st.ult && st.status === 'playing') { stepUltimate(h); return; }   // [W3-ULT] сцена: бой стоит
    // оглушённый страж «замирает»: часы мозга стоят; вне арены (explore) босс не думает об атаках
    const bh = st.b.slow > 0 ? h * (1 - C.runes.clepsydra.slow) : h;   // [V3] «Клепсидра»: время Регента медленнее
    if (PV && PV.on) PV.preStep(h);                     // [PVP] босса нет: соперник, статусы fx, отсечка ввода
    else if (st.b.stun <= 0 && st.engaged) callBrain(bh);
    if (st.status !== 'playing') return;
    st.time += h;
    st.debug.steps++;
    tickTimers(h);
    if (tryUltimate()) return;   // [W3-ULT] «Небесный суд» начался — остаток шага пропущен
    const playerPrev = playerPos();
    updateShield(h);
    tryParry();
    tryDash();
    movePlayer(h);
    regen(h);
    tryBurst();
    if (st.status !== 'playing') return;
    tryRune();
    if (st.status !== 'playing') return;
    trySigil();
    if (st.status !== 'playing') return;
    tryThrow();
    trySlash();
    if (st.status !== 'playing') return;
    trySpark();
    fireBolts(h);
    updatePlayerProjectiles(h);
    if (st.status !== 'playing') return;
    if (hand) { try { hand.step(h); } catch (e) { console.warn('[combat] hand.step', e); } if (st.status !== 'playing') return; } // [HAND] стрелы и сгустки
    updateTelegraphs(bh);
    if (st.status !== 'playing') return;
    updateParry(h);
    updateBossProjectiles(bh, playerPrev);
    if (st.status !== 'playing') return;
    updateBossYaw(h);
  }

  // ---------------------------------------------------------------- [W3-ULT] «Ярость клятвы» и «Небесный суд»
  function ultAllowed() { return !(PV && PV.on); }   // в дуэли ультимейта нет
  function ultReady() { return ultAllowed() && st.p.fury >= C.ultimate.furyMax - 1e-6; }
  function addFury(v) {
    const P = st.p;
    if (!(v > 0) || st.ult || !ultAllowed() || st.status !== 'playing') return;
    P.fury = Math.min(C.ultimate.furyMax, P.fury + v);
    if (P.fury >= C.ultimate.furyMax - 1e-6 && !st.furyFullSent) {
      st.furyFullSent = true;
      emit('ultimate_ready', playerPos(), { fury: P.fury });
    }
  }
  // во время сцены импульсы и удержания не копятся «на потом»
  function ultMuteInput() {
    st.input.attack = false; st.input.shield = false; st.input.conjure = null;
    st.pendingDash = 0; st.pendingDashCam = null; st.dashBuffer = null; st.pendingBurst = false; st.pendingRune = null; st.pendingSigil = null;
    st.pendingThrow = null; st.pendingSpark = false; st.pendingSlash = null; st.pendingParry = false; st.pendingUlt = false; st.p.charge = 0;
    if (hand) hand.clearInput();
  }
  function tryUltimate() {
    if (!st.pendingUlt) return false;
    st.pendingUlt = false;   // одна попытка на импульс
    if (!ultReady() || st.status !== 'playing' || st.p.dead) return false;
    if (C.encounter.enabled && !st.engaged) { deny('ultimate', 'far'); return false; }
    const P = st.p, U = C.ultimate;
    // небо раскалывается: телеграфы и сферы Регента рассеяны, щит опущен
    for (const pr of st.projectiles) {
      if (pr.owner === 'boss') emit('projectile_impact', pr.position, { owner: 'boss', kind: pr.kind, projectileId: pr.id, attackId: pr.attackId, result: 'dispelled' });
    }
    st.projectiles = st.projectiles.filter((pr) => pr.owner !== 'boss');
    st.telegraphs.length = 0;
    if (P.shielding) endShield('ultimate');
    P.dashing = false; P.firing = false; P.vx = 0; P.vz = 0; P.parryWin = 0;
    P.fury = 0; st.furyFullSent = false;
    const amount = Math.round(C.boss.maxHp * U.damagePct);
    st.ult = { t: 0, duration: U.duration, strikeAt: Math.min(U.strikeAt, U.duration), struck: false, amount };
    ultMuteInput();
    emit('ultimate_start', playerChest(), { target: bossAim(), duration: U.duration, strikeAt: st.ult.strikeAt, amount });
    return true;
  }
  function stepUltimate(h) {
    const U = st.ult, P = st.p, B = st.b;
    st.time += h;
    st.debug.steps++;
    U.t += h;
    P.vx = 0; P.vz = 0;
    P.yaw = Math.atan2(BOSS.x - P.x, BOSS.z - P.z);   // лицом к Регенту
    if (!U.struck && U.t + 1e-9 >= U.strikeAt) {
      U.struck = true;
      const to = bossAim();
      const dealt = Math.min(B.hp, U.amount);
      emit('ultimate_strike', to, { amount: dealt, from: { x: to.x, y: to.y + 30, z: to.z } });
      damageBoss(U.amount, 'ultimate', to, { flat: true, ultimate: true });
      if (st.status !== 'playing') return;   // меч добил Регента — победа
      B.hitReact = C.ultimate.bossReact;
    }
    if (U.t + 1e-9 >= U.duration) {
      st.ult = null;
      P.grace = Math.max(P.grace, C.ultimate.graceAfter);
      emit('ultimate_end', playerPos(), { struck: U.struck });
    }
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
    if (hand) hand.reset(); // [HAND]
    if (PV && PV.on) PV.onReset();   // [PVP] статусы дуэли (оглушение, горение, метеоры) не переживают сброс
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

  // [FEEL] сложность боя с Регентом (C.difficulty): здоровье стража и урон его атак.
  // Здоровье меняется со следующего reset() (или сразу, если бой ещё не начат), урон — с ближайшей атаки.
  const BOSS_HP0 = C.boss.maxHp;
  function difficultyMods() { return C.difficulty[C.difficulty.level] || C.difficulty.normal; }
  function scaleBossDamage(dmg) { const m = difficultyMods().bossDamage; return m === 1 ? dmg : Math.round(dmg * m); }
  function applyDifficulty() { C.boss.maxHp = Math.max(1, Math.round(BOSS_HP0 * difficultyMods().bossHp)); }
  function getDifficulty() {
    const m = difficultyMods();
    return { level: C.difficulty.level, bossMaxHp: C.boss.maxHp, bossHpMul: m.bossHp, bossDamageMul: m.bossDamage };
  }
  function setDifficulty(level) {
    C.difficulty.level = DIFFICULTY_LEVELS.includes(level) ? level : 'normal';
    applyDifficulty();
    const B = st.b;
    if (st.status === 'playing' && !B.dead && st.stats.damageDealt === 0) B.hp = C.boss.maxHp;
    return getDifficulty();
  }
  applyDifficulty();

  // [ASHEN_V2] улучшения героя (core/progression.js → mods): поля пересчитываются от базового
  // конфига, поэтому повторный вызов не накапливает бонусы. Полные HP/энергия остаются полными.
  const BASE = JSON.parse(JSON.stringify(C));
  let upgradeMods = {};
  function setUpgrades(mods) {
    const m = isPlainObject(mods) ? mods : {};
    if (PV && PV.on) { upgradeMods = { ...m }; return getEffectiveConfig(); }   // [PVP] в дуэли улучшения не действуют (честный баланс)
    const f = (k, d) => (Number.isFinite(m[k]) ? m[k] : d);
    const P = st.p;
    const hpFull = P.hp >= C.player.maxHp - 1e-6, enFull = P.energy >= C.player.maxEnergy - 1e-6;
    C.player.maxHp = Math.max(1, BASE.player.maxHp + f('maxHp', 0));
    C.player.maxEnergy = Math.max(1, BASE.player.maxEnergy + f('maxEnergy', 0));
    C.player.energyRegen = BASE.player.energyRegen * clamp(f('energyRegenMul', 1), 0.1, 5);
    C.player.runSpeed = BASE.player.runSpeed * clamp(f('runSpeedMul', 1), 0.5, 2);
    C.dash.cooldown = Math.max(0.3, BASE.dash.cooldown * clamp(f('dashCooldownMul', 1), 0.2, 2));
    C.spark.damage = BASE.spark.damage * clamp(f('sparkDamageMul', 1), 0.1, 10);
    const sm = clamp(f('slashDamageMul', 1), 0.1, 10);
    C.slash.damageMin = BASE.slash.damageMin * sm; C.slash.damageMax = BASE.slash.damageMax * sm;
    C.slash.angleDeg = clamp(BASE.slash.angleDeg + f('slashAngleAdd', 0), 10, 360);
    const dm = clamp(f('shieldDrainMul', 1), 0.1, 2);
    C.shield.drainPerSec = BASE.shield.drainPerSec * dm; C.shield.blockEnergyCost = BASE.shield.blockEnergyCost * dm;
    C.parry.window = clamp(BASE.parry.window + f('parryWindowAdd', 0), 0.02, 2);
    C.burst.damage = BASE.burst.damage * clamp(f('burstDamageMul', 1), 0.1, 10);
    C.burst.cooldown = Math.max(1, BASE.burst.cooldown * clamp(f('burstCooldownMul', 1), 0.2, 2));
    P.hp = hpFull ? C.player.maxHp : Math.min(P.hp, C.player.maxHp);
    P.energy = enFull ? C.player.maxEnergy : Math.min(P.energy, C.player.maxEnergy);
    upgradeMods = { ...m };
    return getEffectiveConfig();
  }
  function getEffectiveConfig() { return JSON.parse(JSON.stringify(C)); }
  function getUpgrades() { return { ...upgradeMods }; }

  // [PVP] хуки дуэли. attachPvp(factory): factory(K) → объект хуков modules/pvp.js; setMode('pvp'|'boss');
  // setOpponent(state) — интерполированный соперник (remotePlayer.getState); applyRemoteHit(hit) — входящий удар.
  const K = {
    get st() { return st; }, C, BOSS, H, BASE_BOSS: vcopy(C.arena.bossPosition), LAY,
    emit, vec, vcopy, clamp, distXZ, wrapAngle, playerPos, playerChest, addProjectile, resolveMove, endShield,
    breakCombo, toBossUnit, screenRight, conjurePoint, newId: (kind) => `${kind}:${fightGen}:${++projSeq}`,
  };
  function attachPvp(factory) {
    try { if (PV && PV.on) { PV.disable(); setUpgrades(upgradeMods); } } catch (e) { /* ignore */ }
    PV = null;
    if (typeof factory === 'function') PV = factory(K) || null;
    return !!PV;
  }
  function setMode(mode) {
    if (mode === 'pvp' && !PV) return false;
    // в дуэли улучшения «Клятвы героя» не действуют: вход — от базового конфига, выход — улучшения заново
    if (PV) {
      if (mode === 'pvp') { if (!PV.on) { const keep = upgradeMods; setUpgrades({}); upgradeMods = keep; PV.enable(); } }
      else if (PV.on) { PV.disable(); setUpgrades(upgradeMods); }
    }
    reset();
    return true;
  }
  function getMode() { return PV && PV.on ? 'pvp' : 'boss'; }
  function setOpponent(state) { if (PV && PV.on) PV.setOpponent(state); }
  function applyRemoteHit(hit) { return PV && PV.on ? PV.applyRemoteHit(hit) : { applied: false, reason: 'mode' }; }

  // [FOREST] место старта (settings.startZone, точки дуэли PvP): действует со следующего reset();
  // null — старт раскладки по умолчанию (layout.playerSpawn).
  const SPAWN0 = LAY.playerSpawn;
  function setSpawn(sp) {
    if (isPlainObject(sp) && Number.isFinite(sp.x) && Number.isFinite(sp.z)) LAY.playerSpawn = { x: sp.x, z: sp.z, yaw: Number.isFinite(sp.yaw) ? sp.yaw : NaN };
    else LAY.playerSpawn = SPAWN0;
    return !!LAY.custom;
  }

  // [HAND] лук и магия рукой (modules/combatHand.js): доступ к бою изнутри замыкания (st — геттером: reset его заменяет)
  try {
    hand = createCombatHand({
      C, BOSS, get st() { return st; }, playerPos, playerChest, bossAim, toBossUnit, damageBoss, emit, deny,
      groundY: (x, z) => LAY.groundY(x, z),
      get pvp() { return PV && PV.on ? PV : null; },   // [HAND] дуэль: стрелы/сгустки → PV.projectileHit со стихией (fx)
    });
  } catch (e) { hand = null; console.warn('[combat] combatHand недоступен', e); }


  reset();
  return { reset, update, getSnapshot, drainEvents, getDebugInfo, getConfig, setUpgrades, getUpgrades, getEffectiveConfig, setSpawn, get hand() { return hand; } /* [HAND] */,
    setDifficulty, getDifficulty,   // [FEEL]
    attachPvp, setMode, getMode, setOpponent, applyRemoteHit };   // [PVP]
}
