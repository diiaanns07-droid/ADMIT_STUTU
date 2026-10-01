// ASHEN OATH — главный сборщик. Владелец: №1.
// Единственный renderer и единственный игровой requestAnimationFrame живут здесь.
// Порядок кадра: свежий ввод → combat.update (если бой идёт) → snapshot/events →
// world/effects (один и тот же массив событий) → камера → render → UI.
//
// Адаптеры интеграции (всё, что модули специалистов не знали друг о друге):
//  - маршрут экранов по onStart({from}) из ui.js №7;
//  - Escape обрабатывает только main (ui: keyboardPause=false), чтобы не было двойной паузы;
//  - tracking для UI дополняется картой точек (parts) из debug-данных vision №2;
//  - событие combat 'boss_projectile' дублируется как boss_impact{attackKind:'orb', launch}
//    для вспышки выпуска орба у effects №6 и позы удара у world №3 (урон не наносит);
//  - <video> и overlay живут в ui.cameraSlot; CSS зеркалит только <video> (overlay №2 зеркалит сам).

import * as THREE from 'three';
import { config, DEPS, API_VERSION } from './config.js';
import { createCameraRig } from './core/cameraRig.js';
import { createDebugInput, emptyInput } from './core/debugInput.js';
import { createBossBrain } from './modules/boss.js';
import { createCombat } from './modules/combat.js';
import { createWorld } from './modules/world.js';
import { createHeroModel, HEROES, configureHeroes } from './modules/heroModel.js';
import { createEffects } from './modules/effects.js';
import { createUI } from './modules/ui.js';
import { createVision } from './modules/vision.js';
import { createTrackingHud } from './core/trackingHud.js';
import { createBattleHud } from './core/battleHud.js';
import { createCoachStats, hintInfo } from './core/gestureCoach.js';
import { createProgression } from './core/progression.js';
import { createPushupCounter } from './core/pushupCounter.js';
import { createSquatCounter, topSquatFault, synthSquatPose } from './core/squatCounter.js';
import { createHandZone, createHeroBowPose } from './core/handZone.js'; // [HAND] лук и магия рукой
import { createPerfTuner } from './core/perfTuner.js'; // [PERF] автоподстройка под железо
import { createPerfHud } from './core/perfHud.js';     // [PERF] F3 — кадры и трекинг

const boot = window.__aoBoot || { fail: (m) => console.error(m), done: () => {} };

function fatal(msg, err) {
  console.error('[ASHEN]', msg, err || '');
  boot.fail(msg + (err && err.message ? `\n\n${err.message}` : ''));
  throw err || new Error(msg);
}

if (THREE.REVISION !== DEPS.three.revision) {
  console.warn(`[ASHEN] Three.js r${THREE.REVISION}, ожидалась r${DEPS.three.revision}: проверьте importmap в index.html`);
}

// ---------------------------------------------------------------- DOM
const canvas = document.getElementById('ao-canvas');
const uiRoot = document.getElementById('ao-ui-root');
const video = document.getElementById('ao-video');
const overlay = document.getElementById('ao-overlay');
const hudCanvas = document.getElementById('ao-hud-canvas');

// ---------------------------------------------------------------- настройки (удобство для зрителя)
const SETTINGS_KEY = 'ashen-oath.settings.v1';
function sanitizeSettings(patch, base) {
  const out = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  // [PERF] quality — текущий уровень (его читают world/effects); qualityAuto — уровень и разрешение выбирает core/perfTuner.js
  if ('qualityAuto' in patch) out.qualityAuto = patch.qualityAuto !== false;
  if (patch.quality === 'auto') out.qualityAuto = true;
  else if (['low', 'medium', 'high'].includes(patch.quality)) { out.quality = patch.quality; if (!('qualityAuto' in patch)) out.qualityAuto = false; }
  if (Number.isFinite(+patch.volume) && patch.volume !== null && patch.volume !== '') out.volume = Math.max(0, Math.min(1, +patch.volume));
  if (Number.isFinite(+patch.sensitivity) && patch.sensitivity !== null && patch.sensitivity !== '') out.sensitivity = Math.max(0.5, Math.min(2, +patch.sensitivity));
  if ('reducedMotion' in patch) out.reducedMotion = !!patch.reducedMotion;
  if (patch.moveMode === 'steer' || patch.moveMode === 'stick') out.moveMode = patch.moveMode; // [V5] «Руль» / «Джойстик»
  if (typeof patch.hero === 'string' && HEROES[patch.hero]) out.hero = patch.hero;
  // [HERO] C1: шейдинг героев
  if (patch.heroShading === 'realistic' || patch.heroShading === 'anime') out.heroShading = patch.heroShading;
  // [FOREST] место старта: Пепельное плато / Сияющий лес; [ONBOARD] 'edge' — сразу у края арены
  if (patch.startZone === 'edge' || patch.startZone === 'arena' || patch.startZone === 'forest') out.startZone = patch.startZone;
  if (patch.startZoneV >= 2) out.startZoneV = 2;
  // [NET] имя в онлайн-дуэли и IP ретранслятора LAN
  if (typeof patch.netName === 'string') out.netName = patch.netName.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16);
  if (typeof patch.netLanHost === 'string') out.netLanHost = patch.netLanHost.replace(/[^0-9A-Za-z.:\-]/g, '').slice(0, 64);
  // [VFX] эффекты V6 «больше магии» (false — прежние эффекты)
  if ('fxMagic' in patch) out.fxMagic = patch.fxMagic !== false;
  // [BDO] интерфейс в стиле Black Desert
  if ('bdoUi' in patch) out.bdoUi = patch.bdoUi !== false;
  // [HAND] лук и магия рукой
  if ('handCombat' in patch) out.handCombat = patch.handCombat !== false;
  return out;
}
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { /* хранилище недоступно */ }
  // [PERF] сохранения до автоподстройки: прежний «средний» уровень был значением по умолчанию — переводим в «Авто»
  if (saved && typeof saved === 'object' && !('qualityAuto' in saved)) saved = { ...saved, qualityAuto: true };
  // [ONBOARD] старт у края арены стал значением по умолчанию: прежнее «Плато» было умолчанием, а не выбором
  if (saved && typeof saved === 'object' && !(saved.startZoneV >= 2)) saved = { ...saved, startZone: saved.startZone === 'forest' ? 'forest' : 'edge', startZoneV: 2 };
  return sanitizeSettings(saved, config.defaultSettings);
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

// Живой объект настроек: world/effects читают его через config.settings.
const settings = loadSettings();
config.settings = settings;
config.boss.seed = (Math.random() * 0xffffffff) >>> 0; // разный порядок атак от запуска к запуску

// ---------------------------------------------------------------- renderer / scene / camera
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  fatal('WebGL недоступен. Включите аппаратное ускорение в настройках браузера (Chrome/Edge → Система) и перезапустите браузер.', e);
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;          // рекомендация №3, под неё подобран свет
renderer.shadowMap.type = THREE.PCFShadowMap;

// [PERF] автоподстройка под железо (core/perfTuner.js): предел кадров кратно частоте экрана,
// динамическое разрешение, уровень качества в режиме «Авто», стартовые настройки распознавания.
// ?uncapped=1 — без предела кадров (замеры QA), ?pose=lite|full — модель позы вручную.
const PERF_Q = new URLSearchParams(location.search);
const UNCAPPED = PERF_Q.get('uncapped') === '1';
// [ONBOARD] быстрый вход: «Играть» → камера с автокалибровкой → обучение → бой у края арены.
// ?demo — для живой презентации: без меню, сразу камера → бой; ?classic=1 — прежний поток экранов с кнопками.
const DEMO = PERF_Q.has('demo') && PERF_Q.get('demo') !== '0';
const CLASSIC = PERF_Q.get('classic') === '1' && !DEMO;
const QUICK = !CLASSIC;
let perfTuner = null;
try {
  perfTuner = createPerfTuner({ renderer });
  perfTuner.setAuto(settings.qualityAuto !== false);
  if (settings.qualityAuto !== false) settings.quality = perfTuner.tier;   // до создания мира: он читает уровень при старте
  console.info('[perf]', JSON.stringify({ gpu: perfTuner.hardware.gpu, class: perfTuner.hardware.gpuClass, tier: perfTuner.tier, scale: perfTuner.scale, pose: perfTuner.profile.vision.poseModel }));
} catch (e) { console.warn('[PERF] автоподстройка недоступна:', e); perfTuner = null; }

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(config.camera.fov, 1, 0.1, 1200); // небо затмения ~900 м, шпили до ~700 м
scene.add(camera);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  if (typeof postfx !== 'undefined' && postfx) { try { postfx.setSize(w, h, renderer.getPixelRatio()); } catch (e) { /* ignore */ } }
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- модули
function make(name, fn) {
  try { return fn(); } catch (e) { fatal(`Модуль ${name} не создан`, e); }
}
const app = {
  screen: 'menu',
  debug: false,               // DEBUG-ввод с клавиатуры (явно включается пользователем)
  appliedQuality: null,
  error: null,
  pauseReason: null,          // 'user' | 'tracking'
  lostTime: 0,
  lastInput: null,
  resumeAt: 0,               // performance.now(), до которого бой после продолжения стоит
  intro: { t: 0, duration: 1.8, awakened: false, skip: false }, // screen 'intro': облёт камеры, пробуждение стража; [ONBOARD] 1,8 с, пропуск
  introShown: false,         // интро показывается при первом бое после меню, не на каждом повторе
  resumableFight: false,     // камера упала во время паузы: после переподключения вернуться в бой
  nav: [],                   // [ASHEN_V2] стек возврата для экранов «Клятва героя» и «Тренировка»
  // [ONBOARD] экран камеры сам включает камеру, калибрует и идёт дальше; autoResume — отсчёт 3-2-1 после потери трекинга
  onb: { autoEnabled: false, calibP: null, retryAt: 0, okSince: null, restored: false, calibratedAt: 0 },
  autoResume: null,          // { at, badSince } — performance.now() продолжения боя
  gate: { ok: true, reason: '', since: 0, flashUntil: 0 }, // причина недоступности «В бой»/«Продолжить» для кнопок UI
};

// [ASHEN_V2] мир создаётся первым: его раскладка (коллайдеры, земля, арена, старт) нужна бою и камере.
const world = make('world.js', () => createWorld({ THREE, scene, renderer, camera, config }));
const worldLayout = world && world.layout ? world.layout : null;
// [ASHEN_V3] выбор героя: процедурный Пепельный страж или VRoid-героини (CC0, VRM) с анимациями Quaternius
let heroModel = null;
try {
  // [HERO] C5: общие настройки (атмосфера, шейдинг) — и для удалённого героя NET
  configureHeroes({ atmosphere: world && world.atmosphere, shading: settings.heroShading, quality: settings.quality, camera });
  if (world && world.hero) heroModel = createHeroModel({ THREE, heroRoot: world.hero.root, heroBody: world.hero.body, extras: world.hero.extras, markers: world.hero.markers, atmosphere: world.atmosphere, shading: settings.heroShading, quality: settings.quality, hero: settings.hero, baseUrl: new URL('./assets/quaternius/', import.meta.url).href }); // [HERO] markers/atmosphere/shading
} catch (e) { console.warn('[ASHEN] heroModel', e); }
// [HERO] витрина героя в меню: кинематографичный свет и облёт (modules/heroShowcase.js); ошибка — прежняя камера меню
let heroShowcase = null;
if (heroModel && world && world.hero) import('./modules/heroShowcase.js').then((m) => { try { heroShowcase = m.createHeroShowcase({ THREE, scene, heroRoot: world.hero.root, heroModel, getPostfx: () => postfx, settings, dom: canvas }); } catch (e) { console.warn('[HERO] витрина', e); } }).catch((e) => console.warn('[HERO] heroShowcase.js', e && e.message));
const bossBrain = make('boss.js', () => createBossBrain(config));
const combat = make('combat.js', () => createCombat({ config, bossBrain, layout: worldLayout }));
const effects = make('effects.js', () => createEffects({ THREE, scene, camera, renderer, config }));
// [VFX] эффекты V6 крепятся к рукам героя (C5 heroModel.getAnchors → world.getAnchors) и к рельефу карты
try {
  if (effects.setAnchors) effects.setAnchors(() => (heroModel && typeof heroModel.getAnchors === 'function' ? heroModel.getAnchors() : (world && typeof world.getAnchors === 'function' ? world.getAnchors() : null)));
  if (effects.setGround && worldLayout && typeof worldLayout.groundY === 'function') effects.setGround(worldLayout.groundY);
  if (effects.setHeroGhosts) effects.setHeroGhosts(() => !!(heroModel && heroModel.afterimages)); // [HERO] V7.2 свои остаточные образы рывка
  // [VFX] PvP: заклинания соперника — от рук его модели (net/session.js → modules/remotePlayer.js getAnchors)
  if (effects.setRemoteAnchors) effects.setRemoteAnchors(() => (netSession && netSession.remote && typeof netSession.remote.getAnchors === 'function' ? netSession.remote.getAnchors() : null));
} catch (e) { console.warn('[ASHEN] effects V6 hooks', e); }
const debugInput = createDebugInput(window);
// Постобработка (core/postfx.js) грузится динамически: до готовности и при любой ошибке — обычный render().
let postfx = null;
import('./core/postfx.js').then((m) => {
  try {
    postfx = m.createPostFX({ THREE, renderer, scene, camera, quality: settings.quality });
    postfx.setReducedMotion(!!settings.reducedMotion);
    postfx.setSize(window.innerWidth, window.innerHeight, renderer.getPixelRatio());
  } catch (e) { console.warn('[ASHEN] postfx недоступен, обычный рендер:', e); postfx = null; }
}).catch((e) => console.warn('[ASHEN] core/postfx.js не загружен, обычный рендер:', e && e.message));
const rig = createCameraRig(config.camera);
const combatCfg = typeof combat.getConfig === 'function' ? combat.getConfig() : null;

// [ASHEN_V2] прогресс героя: очки клятвы (отжимания, угли на плато) → улучшения боя.
// Хранится только в localStorage этого браузера.
const progression = createProgression();
const pushups = createPushupCounter();
const squats = createSquatCounter();
// exercise: 'pushups' | 'squats'. sim — клавиатурная имитация приседа в DEBUG (без камеры).
const train = { reps: 0, lastPoseT: -1, lastRepAt: -1e9, exercise: 'pushups', hintRef: null, hintAt: -1e9, sim: { k: 0, t: 0, keys: new Set() } };
function resetTraining() {
  pushups.reset(); squats.reset();
  train.reps = 0; train.lastPoseT = -1; train.lastRepAt = -1e9; train.sim.k = 0; train.sim.t = 0; train.sim.keys.clear();
  train.hintRef = null; train.hintAt = -1e9;
}
// [ASHEN_V2] DEBUG-приседания: S или ↓ (держать) — вниз, отпустить — вверх; Shift — быстро;
// V — колени внутрь, G — колени за носки (вид сбоку), T — наклон корпуса, H — пятки, B — не выпрямляться.
const SIM_KEYS = ['KeyS', 'ArrowDown', 'ShiftLeft', 'ShiftRight', 'KeyV', 'KeyG', 'KeyT', 'KeyH', 'KeyB'];
function simActive() { return app.debug && app.screen === 'training' && train.exercise === 'squats'; }
window.addEventListener('keydown', (e) => { if (simActive() && SIM_KEYS.includes(e.code)) { train.sim.keys.add(e.code); if (e.code === 'ArrowDown') e.preventDefault(); } });
window.addEventListener('keyup', (e) => { train.sim.keys.delete(e.code); });
window.addEventListener('blur', () => train.sim.keys.clear());
function simSquatFrame(now, dt) {
  const K = train.sim.keys, sim = train.sim;
  const down = K.has('KeyS') || K.has('ArrowDown');
  const rate = K.has('ShiftLeft') || K.has('ShiftRight') ? 4 : 1;       // глубина в секунду
  const floor = K.has('KeyB') ? 0.25 : 0;
  const target = down ? 1 : floor;
  const step = rate * Math.min(0.1, dt);
  sim.k = sim.k < target ? Math.min(target, sim.k + step) : Math.max(target, sim.k - step);
  const kf = K.has('KeyG');
  return synthSquatPose(sim.k, kf ? 'side' : 'front', { valgus: K.has('KeyV'), kneesForward: kf, lean: K.has('KeyT'), heels: K.has('KeyH') });
}
function applyUpgrades() {
  if (typeof combat.setUpgrades !== 'function') return;
  try { combat.setUpgrades(progression.mods()); } catch (e) { console.warn('[ASHEN] setUpgrades', e); }
}
applyUpgrades();
progression.onChange((why) => { if (why === 'buy' || why === 'reset') applyUpgrades(); });
const EMBER_TOTAL = worldLayout && Array.isArray(worldLayout.pois) ? worldLayout.pois.filter((p) => p && p.kind === 'ember').length : 0;
// Зажжённые раньше угли (из сохранения) горят с самого начала.
if (worldLayout && Array.isArray(worldLayout.pois) && typeof world.setPoiState === 'function') {
  for (const poi of worldLayout.pois) if (poi.kind === 'ember' && progression.isEmberLit(poi.id)) world.setPoiState(poi.id, { lit: true });
}
// Герой у незажжённого угля → очки клятвы и событие ember_lit (world, effects, battleHud).
function checkEmbers(snap, events) {
  if (!worldLayout || !Array.isArray(worldLayout.pois) || !snap || !snap.player) return events;
  const p = snap.player.position;
  let out = events;
  for (const poi of worldLayout.pois) {
    if (poi.kind !== 'ember' || progression.isEmberLit(poi.id)) continue;
    if (Math.hypot(p.x - poi.x, p.z - poi.z) > poi.r) continue;
    const pts = progression.lightEmber(poi.id);
    if (out === NO_EVENTS) out = [];
    out.push({ id: `ember-lit-${poi.id}`, type: 'ember_lit', position: { x: poi.x, y: poi.y + 1, z: poi.z },
      data: { id: poi.id, points: pts, lit: progression.getView().embers.length, total: EMBER_TOTAL } });
  }
  return out;
}
// [FOREST] вход в Сияющий лес → событие zone_enter (титр зоны рисует ui/battleHud, №8)
function forestZoneEvents(events, snap) {
  const f = world && world.forest;
  if (!f || typeof f.drainEvents !== 'function') return events;
  const got = f.drainEvents();
  if (!got.length) return events;
  const out = events === NO_EVENTS ? [] : events;
  const p = snap && snap.player ? snap.player.position : { x: 0, y: 0, z: 0 };
  for (const z of got) out.push({ id: `zone-enter-${z.zoneId}-${Math.round(performance.now())}`, type: 'zone_enter', position: { x: p.x, y: p.y, z: p.z }, data: { zoneId: z.zoneId, name: z.name, subtitle: z.subtitle } });
  return out;
}
// [FOREST] место старта из настроек: combat.setSpawn до reset (точки — world.layout.spawns)
function applyStartZone() {
  if (typeof combat.setSpawn !== 'function' || !worldLayout || !worldLayout.spawns) return;
  if (app.netInfo && app.netInfo.spawn) { combat.setSpawn(app.netInfo.spawn); return; } // [NET] дуэль по сети: своя точка поляны
  if (settings.startZone === 'edge') { combat.setSpawn(edgeSpawn()); return; }   // [ONBOARD] сразу у края арены
  combat.setSpawn(settings.startZone === 'forest' ? worldLayout.spawns.forest : null);
}
// [ONBOARD] точка у края арены со стороны камеры (+Z), лицом к Регенту: внутри круга бой начинается сразу,
// снаряд долетает до стража за ~0,5 с. Свободное от коллайдеров место ищется так же, как старт world.js.
let _edgeSpawn;
function edgeSpawn() {
  if (_edgeSpawn !== undefined) return _edgeSpawn;
  _edgeSpawn = null;
  const A = worldLayout && worldLayout.arena;
  if (!A || !Number.isFinite(A.r)) return null;
  const cols = Array.isArray(worldLayout.colliders) ? worldLayout.colliders : [];
  const free = (x, z) => cols.every((c) => {
    if (c.type === 'circle') return Math.hypot(x - c.x, z - c.z) > c.r + 0.9;
    if (c.type !== 'segment') return true;
    const ex = c.bx - c.ax, ez = c.bz - c.az, L2 = ex * ex + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / L2));
    return Math.hypot(x - c.ax - ex * u, z - c.az - ez * u) > c.r + 0.9;
  }) && (typeof worldLayout.isWalkable !== 'function' || worldLayout.isWalkable(x, z));
  for (const k of [0.82, 0.78, 0.74, 0.86, 0.7]) {
    for (const deg of [0, 6, -6, 12, -12, 20, -20]) {
      const a = deg * Math.PI / 180, r = A.r * k;
      const x = A.x + Math.sin(a) * r, z = A.z + Math.cos(a) * r;
      if (free(x, z)) { _edgeSpawn = { x, z, yaw: Math.atan2(A.x - x, A.z - z) }; return _edgeSpawn; }
    }
  }
  return null;
}
function unlitEmbers() {
  if (!worldLayout || !Array.isArray(worldLayout.pois)) return null;
  return worldLayout.pois.filter((q) => q.kind === 'ember' && !progression.isEmberLit(q.id));
}
function openSub(screen) {
  const i = app.nav.indexOf(screen);
  if (i >= 0) app.nav.length = i;                 // экран уже в стеке — вернуться к нему
  else if (app.screen !== screen) app.nav.push(app.screen);
  if (app.nav.length > 8) app.nav.splice(0, app.nav.length - 8);
  setScreen(screen);
}

let vision = null;
let visionPromise = null;
let lastVisionStatus = { status: 'idle', message: 'Камера не включена', progress: 0, confidence: 0, calibrated: false };

let lastSnapshot = null;       // null в меню: world/effects показывают idle
combat.drainEvents();

// ---------------------------------------------------------------- ввод и трекинг
function readInput() {
  // Импульсы потребляются каждый кадр, даже вне боя: после паузы не «выстрелит» старый жест.
  if (app.debug) return debugInput.read();
  if (vision) {
    try { return vision.read(); } catch (e) { console.warn('[ASHEN] vision.read', e); }
  }
  return emptyInput('none');
}

function visionStatus() {
  if (!vision) return lastVisionStatus;
  try { lastVisionStatus = vision.getStatus(); } catch (e) { /* оставить прошлый */ }
  return lastVisionStatus;
}

// Карта точек для экрана калибровки №7 из того, что vision №2 реально знает.
function trackingForUI() {
  const s = visionStatus();
  const d = s && s.debug;
  if (!d || !d.reliability) return s;
  const running = s.status === 'ready' || s.status === 'calibrating' || s.status === 'lost';
  if (!running) return s;
  const shoulders = !!d.reliability.shouldersOk;
  const arm = (a) => (a && typeof a.visible === 'boolean' ? a.visible : undefined);
  return {
    ...s,
    parts: {
      leftShoulder: shoulders, rightShoulder: shoulders,
      leftWrist: arm(d.arms && d.arms.left), rightWrist: arm(d.arms && d.arms.right),
    },
  };
}

function trackingReady() {
  const s = visionStatus();
  return !!vision && s.status === 'ready' && !!s.calibrated && !(s.debug && s.debug.bodyVisible === false);
}
function canResume() { return app.debug || trackingReady(); }

// [ONBOARD] почему нельзя в бой прямо сейчас — те же условия, что trackingReady(); причина видна на кнопке
// «В бой» / «Продолжить бой» (раньше UI включал кнопку по статусу ready, а main молча отказывал без плеч).
function gateNow() {
  if (app.debug) return '';
  const s = visionStatus();
  if (!vision || s.status === 'idle') return 'Камера выключена';
  if (s.status === 'error') return 'Камера не работает';
  if (s.status === 'permission' || s.status === 'loading') return 'Камера запускается…';
  if (s.status === 'calibrating') return 'Идёт калибровка…';
  if (!s.calibrated) return 'Нужна калибровка';
  if (s.status === 'lost' || (s.debug && s.debug.bodyVisible === false)) return 'Не вижу плечи — сядьте в кадр';
  return '';
}
// Показ причины с задержкой 0,35 с: короткое моргание трекинга не дёргает надпись. После отказа по нажатию — сразу.
function gateTick(now) {
  const g = app.gate, reason = gateNow();
  if (!reason) { g.ok = true; g.reason = ''; g.since = 0; return; }
  if (!g.since) g.since = now;
  if (now - g.since >= 350 || now < g.flashUntil || !g.ok) { g.ok = false; g.reason = reason; }
}
function gateRefuse() {
  const g = app.gate, now = performance.now();
  g.flashUntil = now + 1500; g.since = g.since || now;
  gateTick(now);
  renderUI();
}

// ---------------------------------------------------------------- переходы
function setScreen(screen) {
  if (app.screen === screen) return;
  app.screen = screen;
  if (screen !== 'paused') app.pauseReason = null;
  if (screen !== 'playing') debugInput.clear();
  if (screen === 'camera') { app.onb.autoEnabled = false; app.onb.okSince = null; }   // [ONBOARD] экран камеры сам включит камеру
  renderUI();
}

function resetFight() {
  applyStartZone();            // [FOREST] место старта
  combat.reset();              // сбрасывает и bossBrain
  world.reset();
  effects.reset();
  if (handVisuals) { try { handVisuals.reset(); } catch (e) { /* [HAND] */ } }
  if (handZone) handZone.reset(); // [HAND]
  debugInput.clear();
  readInput();                 // выбросить накопленные импульсы
  combat.drainEvents();
  lastSnapshot = combat.getSnapshot();
  rig.reset(rigState(lastSnapshot, ZERO));
  app.lostTime = 0;
}

// [ASHEN_V2] состояние камеры из снимка: вне арены — камера исследования, в арене — lock-on.
function rigState(snap, impulse) {
  const P = snap.player;
  return {
    player: P.position, playerYaw: P.yaw, velocity: P.velocity, boss: snap.boss.position,
    engaged: P.encounter !== 'explore', impulse, colliders: worldLayout ? worldLayout.colliders : null,
    groundY: worldLayout ? worldLayout.groundY : null,   // [ASHEN_V3] камера над рельефом большой карты
    steer: P.moveMode === 'steer',                        // [V5] «Руль»: камера держится за спиной героя
  };
}

function startFight() {
  if (pvpCtl && pvpCtl.active && pvpCtl.inMatch) { app.introShown = true; setScreen('playing'); return; } // [PVP] матч идёт: вернуться в бой без сброса
  resetFight();
  battleHud.reset();
  coachStats.reset();
  app.resumableFight = false;
  app.resumeAt = 0;
  effects.setVolume(gameVolume());
  if (!app.introShown && settings.startZone !== 'forest') {   // [FOREST] облёт интро — только у арены
    app.introShown = true;
    // [ONBOARD] облёт 1,8 с (было 5 с): первый удар успевает за 3 с после «В бой»; любая клавиша, клик или жест — пропустить
    app.intro = { t: 0, duration: settings.reducedMotion ? 1.5 : 1.8, awakened: false, skip: false };
    setScreen('intro');
    return;
  }
  setScreen('playing');
}

// [ONBOARD] пропуск интро: клавиша, клик/касание или жест (кадр ввода с действием или заметным движением рук)
const INTRO_GESTURE_AFTER = 0.35;   // с: поза, с которой нажали «В бой», интро сразу не обрывает
function introGesture(input) {
  if (!input || !input.valid || input.source === 'debug') return false;
  const b = input.bow, h = input.handSpell;
  return !!(input.attack || input.shield || input.burst || input.dash || input.dashDir || input.spark || input.slash ||
    input.parry || input.rune || input.sigil || input.conjure || input.throw || (b && b.active) ||
    (h && h.phase && h.phase !== 'idle') || Math.abs(input.moveX || 0) > 0.35 || Math.abs(input.moveZ || 0) > 0.35);
}
function skipIntro() { if (app.screen === 'intro') app.intro.skip = true; }
window.addEventListener('keydown', (e) => {
  if (app.screen !== 'intro' || e.repeat || ['Shift', 'Control', 'Alt', 'Meta', 'F8', 'F3'].includes(e.key)) return;
  skipIntro();
});
window.addEventListener('pointerdown', () => skipIntro(), true);
let introHint = null;
function showIntroHint(on) {
  if (on && !introHint) {
    introHint = document.createElement('div');
    introHint.className = 'ao-introskip';
    introHint.textContent = 'Пропустить — любая клавиша, клик или жест';
    document.body.appendChild(introHint);
  }
  if (introHint) introHint.hidden = !on;
}

// [ONBOARD] экран камеры без кнопок: камера включается сама; плечи в кадре → калибровка (vision ждёт 1,5 с
// неподвижности, прогресс — кольцо на превью); откалиброван (сейчас или из сохранения) и плечи видны
// ONB_ADVANCE_MS → дальше: обучение, в ?demo — сразу бой, после отвала камеры посреди боя — пауза с автопродолжением.
const ONB_ADVANCE_MS = 500;
const ONB_RETRY_MS = 900;
function onboardTick(now) {
  const o = app.onb;
  if (!QUICK || app.screen !== 'camera' || app.debug) { o.okSince = null; return; }
  const s = visionStatus();
  if (!o.autoEnabled && (!vision || s.status === 'idle') && !app.error) { o.autoEnabled = true; enableCamera(); return; }
  if (!vision || !(s.status === 'ready' || s.status === 'lost' || s.status === 'calibrating')) { o.okSince = null; return; }
  const body = !!(s.debug && s.debug.bodyVisible);
  if (s.status === 'calibrating') { o.okSince = null; return; }
  if (!s.calibrated) {
    o.okSince = null;
    if (body && !o.calibP && now >= o.retryAt) {
      o.calibP = calibrateAndSave()
        .catch(() => { o.retryAt = performance.now() + ONB_RETRY_MS; })   // таймаут/перезапуск — новая попытка, когда плечи снова видны
        .finally(() => { o.calibP = null; });
    }
    return;
  }
  if (s.status === 'ready' && body) {
    if (o.okSince === null) o.okSince = now;
    if (now - o.okSince >= ONB_ADVANCE_MS) leaveCamera();
  } else o.okSince = null;
}
function leaveCamera() {
  app.onb.okSince = null;
  if (app.resumableFight) { app.resumableFight = false; app.pauseReason = 'tracking'; setScreen('paused'); app.pauseReason = 'tracking'; return; }
  if (DEMO || (pvpCtl && pvpCtl.active && pvpCtl.inMatch)) { startFight(); return; }   // [PVP] дуэль уже идёт — обратно в бой
  setScreen('tutorial');
}

// [ONBOARD] пауза «Трекинг потерян» снимается сама: тело снова в кадре → отсчёт 3-2-1 → бой.
// Кратковременное пропадание плеч (<0,3 с) отсчёт не сбрасывает. Пауза игрока (Esc, «Пауза») — только кнопкой.
const AUTO_RESUME_MS = 3000;
function autoResumeTick(now) {
  const auto = QUICK && !app.debug && app.screen === 'paused' && app.pauseReason === 'tracking';
  if (!auto) { app.autoResume = null; return; }
  const r = app.autoResume;
  if (trackingReady()) {
    if (!r) { app.autoResume = { at: now + AUTO_RESUME_MS, badSince: 0 }; return; }
    r.badSince = 0;
    if (now >= r.at) callbacks.onResume({ auto: true });
  } else if (r) {
    if (!r.badSince) r.badSince = now;
    if (now - r.badSince > 300) app.autoResume = null;
  }
}

function pause(reason) {
  if (app.screen !== 'playing') return;
  setScreen('paused');
  app.pauseReason = reason || 'user';
  effects.setVolume(0); // петли щита/полёта орбов не звучат всю паузу
  renderUI();
}

const AUDIO_ON = !(config.audio && config.audio.enabled === false);
const gameVolume = () => (AUDIO_ON ? settings.volume : 0);
function unlockAudio() { if (!AUDIO_ON) return; try { effects.unlockAudio().catch(() => {}); } catch (e) { /* ignore */ } }

const REC_ON = /[?&]rec=1\b/.test(location.search); // [CONTROLS] запись кистей (см. saveRecording)

// [PERF] распознавание под железо: на дискретной видеокарте — точная модель позы и камера 960×720 (4:3),
// на встроенной — быстрая модель и 640×480, на программном рендере — ещё и реже кадры.
function visionProfile() {
  const vp = perfTuner ? perfTuner.profile.vision : null;
  const forced = PERF_Q.get('pose');
  const model = forced === 'lite' || forced === 'full' ? forced : (vp ? vp.poseModel : 'lite');
  const out = { mediaPipe: { ...config.vision.mediaPipe, modelUrl: model === 'full' && DEPS.mediaPipe.modelFullUrl ? DEPS.mediaPipe.modelFullUrl : DEPS.mediaPipe.modelUrl } };
  if (vp) {
    out.camera = { width: vp.camera.width, height: vp.camera.height, frameRate: 30 };
    out.captureMaxWidth = vp.captureMaxWidth;
    out.maxInferenceHz = vp.maxInferenceHz;
  }
  return out;
}
// [PERF] распознавание → автоподстройке (рендер уступает GPU, если MediaPipe не успевает за камерой);
// точная модель позы не держит частоту — переход на быструю (сейчас, если не в бою, и в следующие запуски).
const perfVis = { t: 0, slowSince: null, wantLite: false, switched: false };
function perfVisionTick(now) {
  if (!perfTuner || now - perfVis.t < 500) return;
  perfVis.t = now;
  const s = vision ? visionStatus() : null;
  const d = s && s.debug;
  if (!d || !(s.status === 'ready' || s.status === 'calibrating' || s.status === 'lost')) { perfTuner.setVision(null); perfVis.slowSince = null; return; }
  perfTuner.setVision({ hz: d.inferenceHz, cameraFps: d.cameraFps, inferMs: d.inferMs });
  const slow = d.poseModel === 'full' && Number.isFinite(d.inferenceHz) && Number.isFinite(d.cameraFps) && d.cameraFps >= 20 && d.inferenceHz < 16;
  if (slow) { if (perfVis.slowSince === null) perfVis.slowSince = now; if (now - perfVis.slowSince > 6000) perfVis.wantLite = true; }
  else perfVis.slowSince = null;
  if (perfVis.wantLite && !perfVis.switched && app.screen !== 'playing' && app.screen !== 'intro' && typeof vision.setPoseModel === 'function') {
    perfVis.switched = true;
    perfTuner.markPoseSlow();
    console.warn(`[PERF] точная модель позы не успевает (${d.inferenceHz} Гц при камере ${d.cameraFps} к/с) — переход на быструю`);
    vision.setPoseModel(DEPS.mediaPipe.modelUrl).catch(() => {});
  }
}

async function ensureVision() {
  if (vision) return vision;
  if (!visionPromise) {
    visionPromise = createVision({
      video, overlayCanvas: overlay, config: { ...config.vision, ...visionProfile(), sensitivity: settings.sensitivity, moveMode: settings.moveMode },
      onStatus: (s) => { lastVisionStatus = s; },
    }).then((v) => {
      vision = v;
      restoreCalibration(v);   // [ONBOARD] прошлая калибровка — экран камеры её не повторяет
      if (handZone && typeof v.setHandTap === 'function') v.setHandTap((o) => handZone.pushObs(o)); // [HAND]
      // [CONTROLS] запись кистей всегда: последние 90 с (≈3 МБ в памяти) — F8 сохраняет их файлом, когда
      // что-то пошло не так (щит встал сам, герой споткнулся). ?rec=1 — длинная запись (10 мин) и значок.
      if (typeof v.startRecording === 'function') { v.startRecording({ source: 'ashen-game', hero: settings.hero }, REC_ON ? 18000 : 2700); if (REC_ON) showRecBadge(); }
      return v;
    }, (e) => { visionPromise = null; throw e; });
  }
  return visionPromise;
}

// [ONBOARD] калибровка между входами: результат — в localStorage, при следующем запуске камеры он подставляется
// в vision (формат кадра сверяется на первом кадре). «Перекалибровать» в паузе записывает новую.
const CALIB_KEY = 'ashen-oath.calibration.v1';
function loadCalibration() { try { return JSON.parse(localStorage.getItem(CALIB_KEY) || 'null'); } catch (e) { return null; } }
function saveCalibration() {
  if (!vision || typeof vision.getCalibration !== 'function') return;
  try { const c = vision.getCalibration(); if (c) localStorage.setItem(CALIB_KEY, JSON.stringify(c)); } catch (e) { /* хранилище недоступно */ }
}
function restoreCalibration(v) {
  if (!QUICK || typeof v.setCalibration !== 'function') return false;
  const c = loadCalibration();
  let ok = false;
  try { ok = !!(c && v.setCalibration(c)); } catch (e) { ok = false; }
  app.onb.restored = ok;
  return ok;
}
function calibrateAndSave() {
  app.onb.calibratedAt = 0;
  return vision.calibrate().then((r) => { saveCalibration(); app.onb.calibratedAt = performance.now(); return r; });
}

async function enableCamera() {
  unlockAudio();
  app.error = null;
  if (app.screen === 'menu' || app.screen === 'error') setScreen('camera');
  try {
    const v = await ensureVision();
    try { await v.start(); }
    catch (e) { if (e && e.code === 'aborted') await v.start(); else throw e; }
    if (!QUICK && app.resumableFight && app.screen === 'camera') setScreen('calibration');   // [ONBOARD] в быстром потоке дальше ведёт onboardTick
  } catch (e) {
    // Ошибки камеры/модели vision показывает статусом error; UI выводит их на экране камеры.
    console.warn('[ASHEN] камера:', e && e.code, e && e.message);
    if (!vision) { app.error = `Модуль камеры не запустился: ${(e && e.message) || e}`; setScreen('error'); }
  }
}

const callbacks = {
  onStart(arg = {}) {
    unlockAudio();
    const from = arg && arg.from;
    if (from === 'menu') {
      setScreen('camera');
      if (QUICK && !app.debug) { app.onb.autoEnabled = true; enableCamera(); }   // [ONBOARD] «Играть» сразу запрашивает камеру — без второго клика
      return;
    }
    if (from === 'camera') {
      if (arg.debug && app.debug) { setScreen('tutorial'); return; }
      if (QUICK && trackingReady()) { leaveCamera(); return; }   // [ONBOARD] калибровка уже есть — дальше
      setScreen('calibration');
      return;
    }
    if (from === 'calibration') {
      if (app.resumableFight) { app.resumableFight = false; app.pauseReason = 'tracking'; setScreen('paused'); return; }
      setScreen('tutorial');
      return;
    }
    if (from === 'tutorial') {
      if (!app.debug && !trackingReady()) { gateRefuse(); return; } // [ONBOARD] причина — на кнопке
      startFight();
    }
  },

  onEnableCamera() { return enableCamera(); },

  onCalibrate() {
    unlockAudio();
    if (app.debug) return Promise.resolve(true);
    if (!vision) return Promise.reject(new Error('Сначала включите камеру'));
    return calibrateAndSave();
  },

  onPause() { pause('user'); },

  onResume(arg) {
    if (app.screen !== 'paused') return;
    if (!canResume()) { gateRefuse(); return; }   // [ONBOARD] причина — на кнопке
    const auto = !!(arg && arg.auto);
    app.autoResume = null;
    readInput();               // сжечь импульсы, накопившиеся за паузу
    debugInput.clear();
    app.lostTime = 0;
    // [ONBOARD] после отсчёта 3-2-1 враг уже дал время сесть — без дополнительной заминки
    app.resumeAt = performance.now() + (auto ? 0 : config.tracking.resumeGraceSec * 1000);
    effects.setVolume(gameVolume());
    setScreen('playing');
  },

  onRestart() {
    unlockAudio();
    if (app.screen === 'error') { location.reload(); return; }
    if (pvpCtl && pvpCtl.active) { if (app.screen === 'paused' && canResume()) callbacks.onResume(); return; } // [PVP] в дуэли «заново» = продолжить (без лечения посреди раунда)
    if (!app.debug && !trackingReady()) { resetFight(); setScreen(vision && !QUICK ? 'calibration' : 'camera'); return; }   // [ONBOARD] калибрует экран камеры
    startFight();
  },

  onSettings(patch) {
    const next = sanitizeSettings(patch, settings);
    if (heroModel && next.hero !== settings.hero) heroModel.setHero(next.hero);
    if (heroModel && next.heroShading !== settings.heroShading) { try { heroModel.setShading(next.heroShading); configureHeroes({ shading: next.heroShading }); } catch (e) { /* ignore */ } } // [HERO]
    const motionChanged = next.reducedMotion !== settings.reducedMotion;
    const zoneChanged = next.startZone !== settings.startZone;   // [FOREST]
    Object.assign(settings, next); // мутация на месте: config.settings === settings
    if (zoneChanged && app.screen === 'menu') { try { resetFight(); } catch (e) { console.warn('[ASHEN] startZone', e); } }   // [FOREST] герой в меню — у выбранного места старта
    applySettings();
    if (motionChanged && typeof world.configure === 'function') world.configure({ reducedMotion: settings.reducedMotion });
    if (motionChanged && postfx) { try { postfx.setReducedMotion(!!settings.reducedMotion); } catch (e) { /* ignore */ } }
    saveSettings(settings);
    renderUI();
  },

  onDebug(enabled) {
    const on = enabled === undefined ? !app.debug : !!enabled;
    app.debug = on;
    debugInput.setEnabled(on);
    if (on && vision) vision.stop();      // в DEBUG камера не используется и выключается
    renderUI();
  },

  // [ASHEN_V2] клятва героя (улучшения) и тренировка (отжимания)
  onOath() { openSub('oath'); },
  onTraining() {
    resetTraining();
    openSub('training');
  },
  // [ASHEN_V2] выбор упражнения на экране тренировки: 'pushups' | 'squats'
  onExercise(kind) {
    const k = kind === 'squats' ? 'squats' : 'pushups';
    if (k === train.exercise) return;
    train.exercise = k;
    resetTraining();
    renderUI();
  },
  onBuyUpgrade(id) { if (progression.buy(id).ok) renderUI(); },
  onBack() {
    const to = app.nav.pop() || 'menu';
    if (to === 'menu' && vision && !app.resumableFight) vision.stop();   // в меню камера не нужна
    setScreen(to);
  },

  onNet() { openNet().catch((e) => { app.error = `Онлайн-модуль не загрузился: ${(e && e.message) || e}`; setScreen('error'); }); }, // [NET]

  onExit() {
    if (pvpCtl && pvpCtl.active) pvpCtl.stop();   // [PVP] выход из дуэли: бой возвращается к Регенту
    app.nav = [];
    app.resumableFight = false;
    app.introShown = false;
    app.autoResume = null;                // [ONBOARD]
    if (vision) vision.stop();            // в меню камера выключается (калибровка сохраняется в vision)
    resetFight();
    lastSnapshot = null;
    app.error = null;
    setScreen('menu');
  },
};

// [NET] онлайн-дуэль: сеть, второй герой и лобби создаются только по кнопке «Онлайн-дуэль»
// (ленивый import net/session.js). В одиночной игре netSession === null — ноль накладных расходов.
// №3 [PVP]: app.onNetReady = (info) => {...} — старт дуэли, когда оба нажали «Готов»
// (info: { net, remote, isHost, code, opponent, mode, seed }); remote.getState() → snap.opponent.
let netSession = null;
let netSessionP = null;
function openNet() {
  if (!netSessionP) {
    netSessionP = import('./net/session.js').then((m) => {
      netSession = m.createNetSession({
        THREE, scene, world, camera, heroes: HEROES, settings,
        heroFactory: (o) => createHeroModel({ THREE, atmosphere: world.atmosphere, shading: settings.heroShading, quality: settings.quality, ...o, baseUrl: new URL('./assets/quaternius/', import.meta.url).href }),
        hooks: {
          saveSettings: (patch) => callbacks.onSettings(patch),
          isDebug: () => app.debug,
          setDebug: (on) => callbacks.onDebug(on),
          onReady: (info) => {
            app.netInfo = info;
            // [NET] хост и гость — на разных точках Поляны дуэлей (C7), друг напротив друга
            const duel = worldLayout && worldLayout.spawns && worldLayout.spawns.duel;
            if (Array.isArray(duel) && duel.length >= 2 && !info.spawn) info.spawn = duel[info.isHost ? 0 : 1];
            if (typeof app.onNetReady === 'function') { app.onNetReady(info); return; }
            app.introShown = true;                        // без облёта Регента
            if (app.debug) startFight(); else setScreen('camera');
          },
          onLeave: () => { app.netInfo = null; if (pvpCtl && pvpCtl.active) pvpCtl.stop(true); },   // [PVP] соперник/лобби закрыты — дуэль кончилась
          fxSupportsRemote: () => !!(effects && effects.supportsRemote),   // [NET] №7: true — эффекты сами рисуют события соперника
        },
      });
      return netSession;
    }).catch((e) => { netSessionP = null; console.error('[NET] онлайн-модуль не загрузился', e); throw e; });
  }
  return netSessionP.then((ns) => { if (!ns.lobbyOpen) ns.openLobby(); return ns; });
}
if (/[?&]netAuto=/.test(location.search)) { if (/[?&]debug=1/.test(location.search)) { app.debug = true; debugInput.setEnabled(true); } openNet().catch(() => {}); } // [NET] тесты

const ui = make('ui.js', () => createUI({
  root: uiRoot,
  callbacks,
  options: {
    keyboardPause: false,
    quickStart: QUICK,          // [ONBOARD] экран камеры с рамкой-силуэтом и автокалибровкой; false (?classic=1) — прежний
    showVolume: !(config.audio && config.audio.enabled === false),
    abilityCosts: combatCfg ? {
      bolt: combatCfg.bolt.energyCost,
      shield: combatCfg.shield.minEnergyToStart,
      burst: combatCfg.burst.cost,
    } : undefined,
  },
}));

// Единственные <video> и overlay — внутри слота UI (он сам переносит слот между экранами
// и никогда не скрывает его через display:none).
const slot = ui.cameraSlot || document.getElementById('ui-camera-slot');
if (slot) { slot.appendChild(video); slot.appendChild(overlay); }
// Трекинг-HUD («tracking edit»: рамки, координаты, скелет кистей, след руны) рисует на overlay;
// собственный overlay vision выключен (config.vision.overlay=false).
const trackingHud = createTrackingHud({ canvas: overlay });
// [HAND] лук и магия рукой: связка ввода (core/handZone.js), поза героя, оверлей на превью камеры,
// простые 3D-заглушки (modules/handVisuals.js; их заменит №7 [VFX]). Любая ошибка — игра без них.
let handZone = null, heroBowPose = null, handFx = null, handVisuals = null;
// точки кистей активного героя (C5 heroModel.getAnchors — у VRM и процедурного), иначе — маркеры мира
const _hAnc = { heroHandL: { x: 0, y: 0, z: 0 }, heroHandR: { x: 0, y: 0, z: 0 }, heroChest: { x: 0, y: 0, z: 0 }, heroHead: { x: 0, y: 0, z: 0 }, heroBow: false }, _hV = new THREE.Vector3();
// [HAND] у героя свой лук (лучницы HERO: снаряжение 'bow' переходит в левую руку) — 3D-лук handVisuals не рисуем, чтобы не было двух луков
let _hBowKey = null, _hBowAt = -1e9;
function heroOwnBow() {
  const key = `${heroModel.hero}|${heroModel.ready}`, t = performance.now();
  if (key !== _hBowKey || t - _hBowAt > 2000) {
    _hBowKey = key; _hBowAt = t;
    let st = null; try { st = heroModel.state(); } catch (e) { st = null; }
    _hAnc.heroBow = !!(st && Array.isArray(st.gear) && st.gear.includes('bow'));
  }
  return _hAnc.heroBow;
}
function handAnchors() {
  try {
    const a = heroModel && typeof heroModel.getAnchors === 'function' ? heroModel.getAnchors() : null;
    if (a && a.handL && a.handR && a.handL.parent && a.handR.parent) {
      for (const [k, n] of [['heroHandL', 'handL'], ['heroHandR', 'handR'], ['heroChest', 'chest'], ['heroHead', 'head']]) {
        const o = a[n]; if (!o) continue;
        o.getWorldPosition(_hV); _hAnc[k].x = _hV.x; _hAnc[k].y = _hV.y; _hAnc[k].z = _hV.z;
      }
      heroOwnBow();
      return _hAnc;
    }
  } catch (e) { /* ниже — маркеры мира */ }
  return typeof world.getAnchors === 'function' ? world.getAnchors() : null;
}
try { handZone = createHandZone({ target: window }); heroBowPose = createHeroBowPose(); } catch (e) { console.warn('[HAND] handZone', e); handZone = null; }
import('./core/handFxOverlay.js').then((m) => { try { handFx = m.createHandFxOverlay({ canvas: overlay }); } catch (e) { console.warn('[HAND] handFxOverlay', e); } }).catch((e) => console.warn('[HAND] core/handFxOverlay.js', e && e.message));
import('./modules/handVisuals.js').then((m) => { try { handVisuals = m.createHandVisuals({ THREE, scene, config }); handVisuals.setQuality(settings.quality); } catch (e) { console.warn('[HAND] handVisuals', e); handVisuals = null; } }).catch((e) => console.warn('[HAND] modules/handVisuals.js', e && e.message));
const battleHud = createBattleHud({ canvas: hudCanvas });
// [ТВИСТ «ОШИБКА»] удачные жесты и подсказки за бой → точность и частая ошибка на экране итогов
const coachStats = createCoachStats();
// [PVP] дуэль игрок против игрока (modules/pvp.js, №3): грузится динамически; при ошибке — обычный бой.
// ?pvp=local — две вкладки одного браузера (DEBUG, клавиатура). Лобби №2: window.__ashenPvp.start(net, {name, hero}).
let pvpCtl = null;
import('./modules/pvp.js').then((m) => {
  try {
    pvpCtl = m.createPvpController({
      THREE, scene, camera, combat, config, settings, arena: worldLayout && worldLayout.arena,
      host: {
        startFight() { resetFight(); battleHud.reset(); coachStats.reset(); app.resumableFight = false; app.resumeAt = 0; app.introShown = true; setScreen('playing'); },
        exitToMenu() { callbacks.onExit(); },
        setDebug(on) { callbacks.onDebug(on); },
        isDebug: () => app.debug,
        toCamera() { app.introShown = true; setScreen(vision && trackingReady() ? 'tutorial' : 'camera'); },
        leaveNet() { if (netSession) netSession.leave(); },
        coach: () => coachStats.summary(),
      },
    });
    window.__ashenPvp = { start: (net, opts) => pvpCtl.startWithNet(net, opts), startLocal: (code) => pvpCtl.startLocal(code), get active() { return pvpCtl.active; } };
    // лобби №2: оба «Готов» → дуэль №3 вместо обычного боя (C6 + remote.getState() → combat.setOpponent)
    app.onNetReady = (info) => {
      const o = info && info.opponent;
      pvpCtl.startWithNet(info.net, { remote: info.remote, isHost: info.isHost, name: settings.netName || (info.isHost ? 'Хост' : 'Гость'), hero: settings.hero, opponent: o })
        .catch((e) => { console.error('[PVP] start', e); app.introShown = true; if (app.debug) startFight(); else setScreen('camera'); });
    };
    pvpCtl.autoStart(location.search);
  } catch (e) { console.warn('[ASHEN] pvp недоступен:', e); pvpCtl = null; }
}).catch((e) => console.warn('[ASHEN] modules/pvp.js не загружен:', e && e.message));

const _proj = new THREE.Vector3();
function projectToScreen(p) {
  _proj.set(p.x, p.y, p.z).project(camera);
  return { x: (_proj.x + 1) * 0.5 * window.innerWidth, y: (1 - _proj.y) * 0.5 * window.innerHeight, behind: _proj.z > 1 };
}
video.style.transform = config.vision.mirror === false ? 'none' : 'scaleX(-1)';

// ---------------------------------------------------------------- настройки
// [PERF] плотность пикселей рендера: потолок уровня качества × доля разрешения автоподстройки
function targetPixelRatio() {
  const q = config.qualityPresets[settings.quality] || config.qualityPresets.medium;
  const base = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap);
  const k = perfTuner && settings.qualityAuto !== false ? perfTuner.scale : 1;
  return Math.max(0.5, Math.round(base * k * 100) / 100);
}
function applyPixelRatio() {
  const pr = targetPixelRatio();
  if (Math.abs(renderer.getPixelRatio() - pr) > 1e-3) { renderer.setPixelRatio(pr); resize(); }
}
function applySettings() {
  if (perfTuner) {
    perfTuner.setAuto(settings.qualityAuto !== false);
    if (settings.qualityAuto !== false) settings.quality = perfTuner.tier;
  }
  renderer.setPixelRatio(targetPixelRatio());
  resize();
  if (app.appliedQuality !== settings.quality) {
    const first = app.appliedQuality === null;
    app.appliedQuality = settings.quality;
    if (!first) schedulePrecompile('quality');   // [PERF] новые варианты шейдеров — параллельно, а не рывком при появлении
    world.setQuality(settings.quality);   // тени (castShadow), пепел, огни жаровен, декор
    effects.setQuality(settings.quality); // пулы частиц, вспышечный свет
    if (handVisuals) { try { handVisuals.setQuality(settings.quality); } catch (e) { /* [HAND] */ } }
    if (postfx) { try { postfx.setQuality(settings.quality); } catch (e) { /* ignore */ } }
    if (heroModel && heroModel.setQuality) { try { heroModel.setQuality(settings.quality); configureHeroes({ quality: settings.quality }); } catch (e) { /* ignore */ } } // [HERO]
  }
  effects.setVolume(app.screen === 'paused' ? 0 : gameVolume());
  if (vision) vision.configure({ sensitivity: settings.sensitivity, moveMode: settings.moveMode });
  if (typeof debugInput.setMoveMode === 'function') debugInput.setMoveMode(settings.moveMode); // [V5] WASD как «Руль»
}

// ---------------------------------------------------------------- зеркало рук героя
// Векторы плечо→локоть и локоть→кисть рук ИГРОКА в экранных координатах (x вправо, y вниз),
// зеркально как превью: правая рука игрока — справа. world.setMirror() переводит их в позу героя.
function mirrorFromPose(input, now) {
  if (!vision || typeof vision.getPose !== 'function') return null;
  const pose = vision.getPose();
  if (!pose || !Array.isArray(pose.landmarks) || now - pose.tMs > 400) return null;
  const L = pose.landmarks, W = pose.frameW || 640, H = pose.frameH || 480, mir = pose.mirror !== false;
  const P = (i) => {
    const q = L[i];
    if (!q || !(q.x === q.x) || (typeof q.visibility === 'number' && q.visibility < 0.4)) return null;
    return { x: (mir ? 1 - q.x : q.x) * W, y: q.y * H };
  };
  const unit = (a, b) => {
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    return l > 1e-6 ? { x: dx / l, y: dy / l } : null;
  };
  const arm = (s, e, w) => {
    const S = P(s), E = P(e), Wr = P(w);
    const upper = unit(S, E), fore = unit(E, Wr);
    return upper && fore ? { upper, fore } : null;
  };
  const left = arm(11, 13, 15), right = arm(12, 14, 16);
  return {
    valid: !!(input && input.valid) && !!(left || right),
    left, right,
    lean: input && input.valid ? input.moveX || 0 : 0,
    depth: input && input.valid ? input.moveZ || 0 : 0,
  };
}

// [HERO] C2 → C5: input.bow / input.handSpell → heroModel.setPose (№6 может звать setPose и сам)
const _heroPose = { bowActive: false, bowDraw: 0, aim: { x: 0, y: 0 }, handSpell: 0 };
function heroPoseFromInput(input) {
  const b = input && input.bow, h = input && input.handSpell;
  _heroPose.bowActive = !!(b && b.active);
  _heroPose.bowDraw = b && b.active ? Math.max(0, Math.min(1, +b.draw || 0)) : 0;
  _heroPose.aim.x = b && b.active ? +b.aimX || 0 : h && h.dir ? +h.dir.x || 0 : 0;
  _heroPose.aim.y = b && b.active ? +b.aimY || 0 : h && h.dir ? -(+h.dir.y || 0) : 0;
  _heroPose.handSpell = h && (h.phase === 'form' || h.phase === 'hold') ? Math.max(0.35, Math.min(1, +h.power || 0)) : 0;
  return _heroPose;
}

// ---------------------------------------------------------------- трекинг-HUD
function drawTracking(now, input) {
  if (app.debug || !vision) { trackingHud.clear(); return; }
  const mini = app.screen === 'playing';
  let hands = null, pose = null;
  try { hands = vision.getHands(); pose = vision.getPose(); } catch (e) { /* ignore */ }
  trackingHud.draw(now, { pose, status: visionStatus(), input, settings, mode: mini ? 'mini' : 'full', hands });
  if (handFx && handZone && settings.handCombat !== false) { try { handFx.draw(now, { ...handZone.overlay(now), pose, settings, mode: mini ? 'mini' : 'full' }); } catch (e) { /* [HAND] оверлей не критичен */ } } // [HAND]
}

// ---------------------------------------------------------------- UI
function renderUI() {
  uiRoot.classList.toggle('ao-intro', app.screen === 'intro');
  ui.update({
    screen: app.screen === 'intro' ? 'playing' : app.screen,
    snapshot: lastSnapshot,
    tracking: trackingForUI(),   // всегда настоящий статус CV; DEBUG передаётся флагом debug
    debug: app.debug,
    settings: settings.qualityAuto !== false ? { ...settings, quality: 'auto' } : settings, // [PERF] переключатель показывает «Авто»
    error: app.error,
    input: app.lastInput,
    pauseReason: app.pauseReason,
    progress: { ...progression.getView(), emberTotal: EMBER_TOTAL },
    training: app.screen === 'training' ? trainingView() : null,
    coach: app.screen === 'victory' || app.screen === 'defeat' ? coachStats.summary() : null, // [ТВИСТ «ОШИБКА»] итог
    // [ONBOARD] причина на кнопках «В бой»/«Продолжить бой»; отсчёт автопродолжения; калибровка из сохранения
    gate: { ok: app.gate.ok, reason: app.gate.reason },
    autoResumeMs: app.autoResume ? Math.max(0, app.autoResume.at - performance.now()) : null,
    onboard: { quick: QUICK, restored: app.onb.restored, demo: DEMO },
  });
}
function trainingView() {
  if (train.exercise === 'squats') {
    const q = squats.read();
    return {
      exercise: 'squats', debugSim: app.debug, reps: train.reps, attempts: q.attempts, state: q.phase, message: q.message,
      depth: q.depth, knee: q.knee, view: q.view, lastOk: q.lastRep ? q.lastRep.ok : null,
      sinceRepMs: performance.now() - train.lastRepAt, lastHint: q.lastHint,
      sinceHintMs: q.lastHint ? performance.now() - train.hintAt : null,
      faults: q.faults, formScore: q.formScore, topFault: topSquatFault(q.faults),
    };
  }
  const r = pushups.read();
  return { exercise: 'pushups', reps: train.reps, state: r.state, message: r.message, depth: r.depth, lastOk: r.lastRep ? r.lastRep.ok : null, sinceRepMs: performance.now() - train.lastRepAt };
}

// ---------------------------------------------------------------- системные события
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    debugInput.clear();
    pause('user');
  }
});
// [CONTROLS] запись кистей для разбора управления: F8 — сохранить последние 90 с (с ?rec=1 — всю запись
// до 10 мин и значок). Разбор: node dev/replay.mjs файл.json. Видео не пишется — только точки кистей и плеч.
let recBadge = null;
function showRecBadge() {
  if (recBadge || typeof document === 'undefined') return;
  recBadge = document.createElement('div');
  recBadge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px/1.3 system-ui,sans-serif;color:#fff;background:rgba(160,20,20,.75);padding:3px 8px;border-radius:4px;pointer-events:none';
  document.body.appendChild(recBadge);
  const tick = () => { if (!recBadge) return; const n = vision && vision.recordingSize ? vision.recordingSize() : 0; recBadge.textContent = `● ЗАПИСЬ КИСТЕЙ · ${Math.round(n / 30)} с · F8 — сохранить`; };
  tick(); setInterval(tick, 1000);
}
function saveRecording() {
  if (!vision || typeof vision.takeRecording !== 'function') return;
  const rec = vision.takeRecording({ note: 'F8' });
  if (!rec || !rec.frames.length) { flashRecNote('Запись кистей пуста — включите камеру'); return; }
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ashen-hands-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  flashRecNote(`Сохранено: последние ${Math.round((rec.frames[rec.frames.length - 1].t - rec.frames[0].t) / 1000)} с кистей → ${a.download}`);
}
function flashRecNote(text) {
  if (typeof document === 'undefined') return;
  const n = document.createElement('div');
  n.textContent = text;
  n.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;font:13px/1.3 system-ui,sans-serif;color:#fff;background:rgba(20,24,30,.9);border:1px solid #c9a45c;padding:6px 12px;border-radius:4px;pointer-events:none';
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3500);
}
window.addEventListener('keydown', (e) => { if (e.code === 'F8' && !e.repeat) { e.preventDefault(); saveRecording(); } });
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || e.repeat) return;
  if (app.screen === 'playing') { e.preventDefault(); pause('user'); }
});
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  pause('user');
  app.error = 'WebGL: графический контекст потерян. Обновите страницу.';
  setScreen('error');
});

// ---------------------------------------------------------------- адаптер событий
function adaptEvents(events) {
  let extra = null;
  for (const e of events) {
    if (e.type === 'rune_cast') {
      (extra || (extra = [])).push({ id: `${e.id}-cast`, type: 'player_cast', position: e.position, data: { ability: 'rune', rune: e.data && e.data.rune } });
    }
    if (e.type === 'boss_projectile' && e.data && e.data.attackKind === 'orb') {
      (extra || (extra = [])).push({
        id: `${e.id}-launch`, type: 'boss_impact', position: e.position,
        data: { attackKind: 'orb', attackId: e.data.attackId, launch: true },
      });
    }
  }
  if (extra) for (const x of extra) events.push(x);
  return events;
}

// ---------------------------------------------------------------- темп: замедление и стоп-кадр
// Боевое время масштабируется (combat/world/effects), камера и CV живут в реальном времени.
const timeFx = { slowUntil: 0, slowScale: 0.3, stopUntil: 0 };
function timeEvents(events, now) {
  for (const e of events) {
    if (e.type === 'perfect_dodge') timeFx.slowUntil = now + 650;
    else if (e.type === 'rune_cast' || e.type === 'burst' || e.type === 'boss_phase' || e.type === 'sigil_cast') timeFx.stopUntil = Math.max(timeFx.stopUntil, now + 80);
    else if (e.type === 'player_hit' && e.data && e.data.amount >= 20) timeFx.stopUntil = Math.max(timeFx.stopUntil, now + 60);
  }
}
function timeScale(now) {
  if (now < timeFx.stopUntil) return 0.04;
  if (now < timeFx.slowUntil) {
    const left = (timeFx.slowUntil - now) / 650;
    return timeFx.slowScale + (1 - timeFx.slowScale) * Math.max(0, 1 - left * 1.6); // плавный выход
  }
  return 1;
}

// ---------------------------------------------------------------- [ТВИСТ «ОШИБКА»]
// Импульсы удачных жестов и коды подсказок из распознавателя → статистика боя.
function trackCoach(input) {
  if (!input) return;
  if (input.burst) coachStats.success('burst');
  if (input.rune) coachStats.success('rune');
  if (input.spark) coachStats.success('spark');
  if (input.slash) coachStats.success('slash');
  if (input.parry) coachStats.success('parry');
  if (input.throw) coachStats.success('throw');
  if (input.sigil) coachStats.success('sigil');
  if (input.bow && input.bow.release) coachStats.success('bow');                        // [HAND]
  if (input.handSpell && input.handSpell.phase === 'throw') coachStats.success('hand_spell'); // [HAND]
  if (input.hint && input.hint.code) coachStats.mistake(input.hint.code);
}
function coachView(input) {
  const h = input && input.hint && hintInfo(input.hint.code) ? { ...input.hint, ...hintInfo(input.hint.code) } : null;
  const s = coachStats.summary();
  return { hint: h, accuracy: s.accuracy, good: s.good, mistakes: s.mistakes };
}

// ---------------------------------------------------------------- постобработка: лучи короны и рывок экрана
const _sunV = new THREE.Vector3();
const PUNCH = { burst: 0.9, rune_cast: 0.75, sigil_cast: 0.6, boss_impact: 0.8, perfect_dodge: 0.5 };
function feedPostFx(events) {
  const atmo = world && world.atmosphere;
  if (atmo && atmo.sunDir && typeof postfx.setSun === 'function') {
    _sunV.copy(atmo.sunDir).multiplyScalar(400).add(camera.position).project(camera);
    const inFront = _sunV.z < 1;
    const edge = Math.max(Math.abs(_sunV.x), Math.abs(_sunV.y));
    postfx.setSun(_sunV.x * 0.5 + 0.5, _sunV.y * 0.5 + 0.5, inFront ? 1 - Math.min(1, Math.max(0, (edge - 1) / 0.6)) : 0);
  }
  if (!Array.isArray(events) || typeof postfx.punch !== 'function') return;
  for (const e of events) {
    let k = e && PUNCH[e.type];
    if (!k) continue;
    if (e.type === 'burst') k *= 0.6 + 0.4 * Math.min(1, (e.data && e.data.power) || 0.5);
    let x = 0.5, y = 0.5;
    if (e.position) { _sunV.set(e.position.x, e.position.y || 0, e.position.z).project(camera); if (_sunV.z < 1) { x = _sunV.x * 0.5 + 0.5; y = _sunV.y * 0.5 + 0.5; } }
    postfx.punch(k, x, y);
  }
}

// ---------------------------------------------------------------- главный цикл
const NO_EVENTS = Object.freeze([]);
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
let last = performance.now();
let menuAngle = 0.6;
const perf = { fps: 0, frames: 0, t0: performance.now() };

// [PERF] предкомпиляция шейдеров: все объекты сцены, в том числе скрытые (пулы эффектов, герои),
// компилируются параллельно (KHR_parallel_shader_compile) — без рывков по 0,3–1,7 с при первом появлении.
const precomp = { pending: false, heroKey: null, fight: false, boot: false };
// Без KHR_parallel_shader_compile (программный рендер, старые драйверы) compile() компилирует всё
// синхронно и вешает страницу на секунды — там шейдеры по-старому собираются при первом показе.
const PARALLEL_COMPILE = (() => { try { return !!(renderer.extensions && renderer.extensions.has('KHR_parallel_shader_compile')); } catch (e) { return false; } })();
function schedulePrecompile(why) {
  if (!PARALLEL_COMPILE || precomp.pending || typeof renderer.compileAsync !== 'function') return;
  precomp.pending = true;
  const t0 = performance.now();
  if (perfTuner) perfTuner.noteStall(t0);
  Promise.resolve()
    .then(() => renderer.compileAsync(scene, camera))
    .then(() => console.info(`[perf] шейдеры (${why}) готовы за ${Math.round(performance.now() - t0)} мс, программ ${renderer.info.programs ? renderer.info.programs.length : '?'}`))
    .catch((e) => console.warn('[PERF] предкомпиляция шейдеров:', e && e.message))
    .finally(() => { precomp.pending = false; if (perfTuner) perfTuner.noteStall(performance.now()); });
}
function precompileTick() {
  if (!precomp.boot) { precomp.boot = true; schedulePrecompile('старт'); return; }
  const hk = heroModel ? `${heroModel.hero}|${heroModel.ready}` : null;
  if (hk !== precomp.heroKey) { precomp.heroKey = hk; if (heroModel && heroModel.ready) schedulePrecompile('герой'); }
  if (!precomp.fight && app.screen === 'playing') { precomp.fight = true; schedulePrecompile('бой'); }
}
const CALM_SCREENS = new Set(['menu', 'paused', 'camera', 'calibration', 'tutorial', 'oath', 'training', 'victory', 'defeat']);
let perfHud = null;
try { perfHud = createPerfHud({ root: document.body }); } catch (e) { console.warn('[PERF] панель', e); }
if (perfTuner) perfTuner.onChange((why, st) => {
  if (why === 'tier' && settings.qualityAuto !== false) { settings.quality = st.tier; applySettings(); saveSettings(settings); console.info(`[perf] уровень качества → ${st.tier}`); }
  else if (why === 'scale') applyPixelRatio();
});

function frame(now) {
  requestAnimationFrame(frame);
  // [PERF] предел кадров кратно частоте экрана: лишние вызовы rAF пропускаются (время и dt — от прошлого кадра)
  if (perfTuner && !perfTuner.beginFrame(now, UNCAPPED)) return;
  const tFrame0 = performance.now();
  const raw = Math.max(0, (now - last) / 1000);
  last = now;
  const stalled = raw > config.loop.stallSec;       // после ухода вкладки не догоняем
  const dtReal = stalled ? 0 : Math.min(raw, config.loop.maxDt);
  const ts = app.screen === 'playing' ? (pvpCtl && pvpCtl.active ? pvpCtl.timeScale(now) : timeScale(now)) : 1; // [PVP] в дуэли без стоп-кадров
  const dt = dtReal * ts;

  const input = readInput();
  // [HAND] лук и магия рукой → input.bow / input.handSpell; конфликтующие жесты гасятся (C2)
  if (handZone) { try { handZone.apply(input, now, { debug: app.debug, playing: app.screen === 'playing', enabled: settings.handCombat !== false }); } catch (e) { console.warn('[HAND] apply', e); } }
  // [ТВИСТ «ОШИБКА»] код подсказки → жест и текст исправления (для HUD, обучения и итогов)
  if (input && input.hint && hintInfo(input.hint.code)) input.hint = { ...input.hint, ...hintInfo(input.hint.code) };
  app.lastInput = input;
  let events = NO_EVENTS;

  if (app.screen === 'intro') {
    const I = app.intro;
    I.t += Math.min(raw, config.loop.stallSec);   // [ONBOARD] настенное время (тяжёлый первый кадр — не больше stallSec): облёт не растягивается на слабом ноутбуке
    lastSnapshot = combat.getSnapshot();
    if (!app.debug && I.t >= INTRO_GESTURE_AFTER && introGesture(input)) I.skip = true;   // [ONBOARD]
    if (!I.awakened && (I.t >= I.duration * 0.3 || I.skip)) {
      I.awakened = true; // «пробуждение»: рёв стража у world, волна и звук у effects (урона нет)
      events = [{ id: `intro-awaken-${Math.round(now)}`, type: 'boss_phase', position: { ...lastSnapshot.boss.position, y: 3 }, data: { stage: 1, awaken: true } }];
    }
    if (I.t >= I.duration || I.skip) { rig.reset(lastSnapshot.player.position, lastSnapshot.boss.position); readInput(); setScreen('playing'); } // из облёта — в lock-on, дальше камера сама перейдёт в explore
  }
  showIntroHint(app.screen === 'intro');

  if (app.screen === 'playing') {
    let frozen = false;
    if (!app.debug) {
      const vs = visionStatus();
      const bodyHidden = !!(vs && vs.debug && vs.debug.bodyVisible === false);
      // [V3.1] рука, уведённая вперёд/вправо, закрывает плечо — видимость плеч падает. Если кисти
      // отслеживаются и ввод валиден, это не «потеря»: бой не замирает и не встаёт на паузу.
      let handsOn = false;
      if (bodyHidden && input.valid) { try { const hh = vision && vision.getHands(); handsOn = !!(hh && hh.available); } catch (e) { handsOn = false; } }
      const bad = !input.valid || (bodyHidden && !handsOn);
      if (bad) {
        app.lostTime += Math.min(raw, 0.25);
        frozen = app.lostTime >= config.tracking.freezeSec;
        if (app.lostTime >= config.tracking.lostPauseSec) pause('tracking');
      } else app.lostTime = 0;
    }
    if (now < app.resumeAt) frozen = true;
    if (app.screen === 'playing' && !frozen) trackCoach(input);
    if (app.screen === 'playing' && dt > 0 && !frozen) {
      // [ASHEN_V2] стик — в осях камеры: «вперёд на стике» = «вперёд на экране»
      if (Number.isFinite(rig.inputYaw)) input.viewYaw = rig.inputYaw;   // [V3] курс управления без плечевого сдвига
      else if (Number.isFinite(rig.yaw)) input.viewYaw = rig.yaw;
      input.moveMode = settings.moveMode;   // [V5] «Руль»: moveX — поворот героя, moveZ — вперёд по его курсу
      let inputC = input;
      if (pvpCtl && pvpCtl.active) { try { inputC = pvpCtl.beforeUpdate(input); } catch (e) { console.error('[PVP] beforeUpdate', e); } } // [PVP] фазы раунда, оглушение, соперник
      try { combat.update(dt, inputC); } catch (e) { console.error('[ASHEN] combat.update', e); }
    }
    events = adaptEvents(combat.drainEvents());
    if (pvpCtl && pvpCtl.active) { try { events = pvpCtl.afterUpdate(events); } catch (e) { console.error('[PVP] afterUpdate', e); } } // [PVP] сеть, раунды
    timeEvents(events, now);
    lastSnapshot = combat.getSnapshot();
    events = checkEmbers(lastSnapshot, events);
    events = forestZoneEvents(events, lastSnapshot);   // [FOREST]
    if (lastSnapshot.status === 'victory') setScreen('victory');
    else if (lastSnapshot.status === 'defeat') setScreen('defeat');
  }

  // [ASHEN_V2] тренировка: поза → счётчик отжиманий → очки клятвы
  if (app.screen === 'training' && train.exercise === 'squats') {
    // поза с камеры, в DEBUG — клавиатурная имитация (время — performance.now)
    let pose = null;
    if (app.debug) {
      const dtSim = train.sim.t ? (now - train.sim.t) / 1000 : 0;
      train.sim.t = now;
      pose = { tMs: now, landmarks: simSquatFrame(now, dtSim), frameW: 640, frameH: 480 };
    } else if (vision) { try { pose = vision.getPose(); } catch (e) { pose = null; } }
    if (pose && pose.tMs !== train.lastPoseT) {
      train.lastPoseT = pose.tMs;
      squats.push({ tMs: pose.tMs, landmarks: pose.landmarks, frameW: pose.frameW, frameH: pose.frameH });
    }
    const got = squats.drain();
    if (got.length) { train.reps += got.length; train.lastRepAt = now; progression.addSquats(got.length); }
    const hint = squats.read().lastHint;
    if (hint && hint !== train.hintRef) { train.hintRef = hint; train.hintAt = now; }
  } else if (app.screen === 'training' && vision) {
    let pose = null;
    try { pose = vision.getPose(); } catch (e) { pose = null; }
    if (pose && pose.tMs !== train.lastPoseT) {
      train.lastPoseT = pose.tMs;
      pushups.push({ tMs: pose.tMs, landmarks: pose.landmarks, frameW: pose.frameW, frameH: pose.frameH });
    }
    const got = pushups.drain();
    if (got.length) { train.reps += got.length; train.lastRepAt = now; progression.addPushups(got.length); }
  }

  if (app.screen === 'paused' && !app.debug && vision) {
    const vs = visionStatus();
    if (vs.status === 'error' || vs.status === 'idle') { app.resumableFight = true; setScreen('camera'); }
  }
  // [ONBOARD] экран камеры ведёт сам, пауза «Трекинг потерян» снимается сама, причина недоступности кнопок
  try { onboardTick(now); autoResumeTick(now); gateTick(now); } catch (e) { console.warn('[ONBOARD]', e); }

  if (typeof world.setMirror === 'function') {
    try { world.setMirror(app.debug ? null : mirrorFromPose(input, now)); } catch (e) { /* ignore */ }
  }
  // [HERO] руки VRM-героя повторяют руки игрока; C5: поза лука и чар рукой из ввода C2
  if (heroModel && heroModel.setMirror) { try { heroModel.setMirror(app.debug ? null : mirrorFromPose(input, now)); if (app.screen !== 'menu') heroModel.setPose(heroPoseFromInput(input)); } catch (e) { /* ignore */ } }
  // [NET] соперник: отправка st/ev/pr, его модель; его события (data.remote=true) и снаряды — в эффекты.
  // world и heroModel получают только свои события: иначе свой герой повторял бы чужие удары.
  let fxEvents = events, fxSnap = lastSnapshot;
  if (netSession) { try { const r = netSession.frame(dtReal, now, lastSnapshot, input, events, app.screen); fxEvents = r.events; fxSnap = r.snapshot; } catch (e) { console.warn('[NET] frame', e); } }
  try { world.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] world.update', e); }
  if (heroModel) { try { heroModel.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] heroModel.update', e); } }
  if (effects.setInput) effects.setInput(input); // [VFX] след руны в воздухе, свечение ладоней
  if (heroBowPose) { try { heroBowPose.update(dt, { root: world.hero && world.hero.root, heroModel, snap: lastSnapshot }); } catch (e) { /* [HAND] */ } } // [HAND] поза лука/ладони
  try { effects.update(dt, fxSnap, fxEvents); } catch (e) { console.error('[ASHEN] effects.update', e); } // [NET] fxSnap/fxEvents
  if (effects.takeHitStop && app.screen === 'playing') { const hs = effects.takeHitStop(); if (hs > 0) timeFx.stopUntil = Math.max(timeFx.stopUntil, now + hs); } // [VFX] хит-стоп по силе удара
  if (handVisuals && effects.linkHandVisuals) effects.linkHandVisuals(handVisuals); // [VFX] стрелы/сгустки/попадания — V6, лук — №6
  if (handVisuals) { try { handVisuals.update(dt, fxSnap, fxEvents, handAnchors()); } catch (e) { /* [HAND] */ } } // [HAND] (fxSnap — со стрелами соперника)

  // камера
  if (app.screen === 'intro' && lastSnapshot) {
    // облёт: спереди-снизу у стража → вверх и за спину героя, к стартовому ракурсу боя
    const I = app.intro;
    const k = Math.min(1, I.t / I.duration);
    const e = k * k * (3 - 2 * k);
    const start = rig.update(0, lastSnapshot.player.position, lastSnapshot.boss.position, ZERO);
    const a0 = -0.9, a1 = Math.atan2(start.position.x, start.position.z);
    const a = settings.reducedMotion ? a1 : a0 + (a1 - a0) * e;
    const r = settings.reducedMotion ? Math.hypot(start.position.x, start.position.z) : 6.5 + (Math.hypot(start.position.x, start.position.z) - 6.5) * e;
    const y = settings.reducedMotion ? start.position.y : 1.2 + (start.position.y - 1.2) * e;
    camera.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
    const ly = 3.6 - (3.6 - start.target.y) * e;
    camera.lookAt(start.target.x * e, ly, start.target.z * e);
  } else if (app.screen === 'menu' && world && world.hero) {
    // [ASHEN_V3] меню: камера у выбранного героя (панель меню слева — герой в правой части кадра)
    menuAngle += dt * (settings.reducedMotion ? 0.02 : 0.08);
    const hp = world.hero.root.position, hy = world.hero.root.rotation.y + 0.45 * Math.sin(menuAngle);
    camera.position.set(hp.x + Math.sin(hy) * 3.0, hp.y + 1.45, hp.z + Math.cos(hy) * 3.0);
    const rx = Math.cos(hy), rz = -Math.sin(hy);     // «вправо» для камеры, смотрящей на героя
    camera.lookAt(hp.x - rx * 0.95, hp.y + 1.1, hp.z - rz * 0.95); // смотрим левее героя — он справа от панели
  } else if (app.screen === 'menu' || !lastSnapshot) {
    menuAngle += dt * (settings.reducedMotion ? 0.02 : 0.06);
    camera.position.set(Math.sin(menuAngle) * 12.5, 4.0, Math.cos(menuAngle) * 12.5);
    camera.lookAt(0, 2.6, 0);
  } else {
    const imp = settings.reducedMotion ? ZERO : effects.getCameraImpulse();
    const c = rig.update(dtReal, rigState(lastSnapshot, imp));
    camera.position.set(c.position.x, c.position.y, c.position.z);
    camera.lookAt(c.target.x, c.target.y, c.target.z);
  }

  if (heroShowcase) { try { heroShowcase.update(dtReal, app.screen === 'menu', camera); } catch (e) { console.warn('[HERO] витрина', e); heroShowcase = null; } } // [HERO] свет и облёт витрины
  if (pvpCtl) { try { pvpCtl.frame(lastSnapshot, app.screen); } catch (e) { console.error('[PVP] frame', e); } } // [PVP] фазы хоста, готовность, панель
  if (postfx && typeof postfx.setMode === 'function') { try { postfx.setMode(app.screen, settings); } catch (e) { /* ignore */ } } // [BDO] DOF меню и грейд по экрану
  if (postfx && postfx.enabled) feedPostFx(events);
  let rendered = false;
  if (perfTuner) perfTuner.gpuBegin();
  if (postfx && postfx.enabled) { try { postfx.render(dtReal); rendered = true; } catch (e) { console.warn('[ASHEN] postfx.render', e); postfx = null; } }
  if (!rendered) renderer.render(scene, camera);
  if (perfTuner) perfTuner.gpuEnd();
  renderUI();
  drawTracking(now, input);
  battleHud.frame({
    dtReal, timeScale: ts, screen: app.screen, snapshot: lastSnapshot, events, input: app.debug ? null : input,
    project: projectToScreen, viewport: { w: window.innerWidth, h: window.innerHeight },
    intro: { active: app.screen === 'intro', t: app.intro.t, duration: app.intro.duration },
    settings, resumeLeftMs: app.screen === 'playing' ? Math.max(0, app.resumeAt - now) : 0,
    pois: unlitEmbers(),
    coach: coachView(input),
    layout: worldLayout, // [BDO] мини-карта и названия зон
  });

  perf.frames++;
  if (now - perf.t0 >= 1000) { perf.fps = (perf.frames * 1000) / (now - perf.t0); perf.frames = 0; perf.t0 = now; }
  // [PERF] статистика кадра → автоподстройка; распознавание → ей же; шейдеры заранее; панель F3
  if (perfTuner) {
    try {
      perfTuner.setCalm(CALM_SCREENS.has(app.screen));
      perfVisionTick(now);
      perfTuner.endFrame(performance.now(), performance.now() - tFrame0);
    } catch (e) { console.warn('[PERF] подстройка', e); }
  }
  try { precompileTick(); } catch (e) { /* ignore */ }
  if (perfHud && perfHud.visible) { try { perfHud.update(now, { perf: perfTuner ? perfTuner.state() : null, tracking: vision ? visionStatus() : null, screen: app.screen }); } catch (e) { /* ignore */ } }
}

applySettings();
resize();
if (settings.startZone !== 'arena') { try { resetFight(); } catch (e) { console.warn('[ASHEN] startZone', e); } }   // [FOREST] в меню герой у врат леса; [ONBOARD] у края арены
// [ONBOARD] ?demo — живая презентация: без меню сразу экран камеры (камера и калибровка — сами), затем бой
if (DEMO) { setScreen('camera'); app.onb.autoEnabled = true; enableCamera(); }
renderUI();
requestAnimationFrame(frame);
boot.done();

// Диагностика для QA (только чтение). Не используется игровой логикой.
window.__ASHEN__ = Object.freeze({
  apiVersion: API_VERSION,
  deps: DEPS,
  threeRevision: THREE.REVISION,
  get screen() { return app.screen; },
  get debug() { return app.debug; },
  get pauseReason() { return app.pauseReason; },
  get fps() { return Math.round(perf.fps); },
  perf: () => (perfTuner ? perfTuner.state() : null), // [PERF] автоподстройка: предел кадров, разрешение, уровень
  programs: () => (renderer.info.programs || []).map((p) => ({ id: p.id, name: p.name, key: String(p.cacheKey).slice(0, 240) })), // [PERF] QA: какие шейдеры компилируются
  get tracking() { return visionStatus(); },
  hands: () => { try { const h = vision && vision.getHands(); return h ? JSON.parse(JSON.stringify({ ...h, left: h.left && { shape: h.left.shape, palmFacing: h.left.palmFacing, charge: h.left.charge }, right: h.right && { shape: h.right.shape, palmFacing: h.right.palmFacing, charge: h.right.charge } })) : null; } catch (e) { return null; } },
  get timeScale() { return timeScale(performance.now()); },
  get postfx() { return postfx ? { enabled: postfx.enabled } : null; },
  get resumeGraceLeft() { return Math.max(0, app.resumeAt - performance.now()); },
  snapshot: () => (lastSnapshot ? JSON.parse(JSON.stringify(lastSnapshot)) : null),
  canvasCount: () => document.querySelectorAll('canvas#ao-canvas').length,
  worldAssets: () => (world && world.assets ? world.assets : null),
  progress: () => progression.getView(),
  pushups: () => pushups.getDebug(),
  coach: () => coachStats.summary(),
  hero: () => (heroModel ? heroModel.state() : null),
  heroShowcase: () => (heroShowcase ? { weight: heroShowcase.weight, zoom: +heroShowcase.zoom.toFixed(2), lights: heroShowcase.group.children.filter((o) => o.isLight).map((l) => [l.name, +l.intensity.toFixed(1)]) } : null), // [HERO] QA
  heroAnchors: () => { if (!heroModel || !heroModel.getAnchors) return null; const a = heroModel.getAnchors(), v = new THREE.Vector3(); return Object.fromEntries(Object.entries(a).map(([k, o]) => { o.getWorldPosition(v); return [k, { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3), attached: !!o.parent }]; })); }, // [HERO] C5
  net: () => (netSession ? netSession.debug() : null),             // [NET]
  netSession: () => netSession,                                    // [NET] для тестов и №3
  hand: () => (handZone ? handZone.getDebug() : null), // [HAND] лук и магия рукой
  fx: () => { try { return JSON.parse(JSON.stringify(effects.getDebugInfo())); } catch (e) { return null; } }, // [VFX] QA: частицы и слой V6
  heroStep: (dt, snap, events) => { if (heroModel) heroModel.update(dt, snap, events || []); return heroModel ? heroModel.state() : null; }, // QA: шаг анимации без rAF
  squats: () => squats.getDebug(),
  pvp: () => (pvpCtl ? pvpCtl.debug() : null),   // [PVP] QA: фаза, счёт, статистика дуэли
  zoneMood: (m) => { try { world.atmosphere.setZoneMood(m); return true; } catch (e) { return false; } }, // [BDO] QA: настроение зоны
  heroMax: () => { const c = typeof combat.getEffectiveConfig === 'function' ? combat.getEffectiveConfig() : null; return c ? { hp: c.player.maxHp, energy: c.player.maxEnergy } : null; },
  embers: () => (worldLayout && Array.isArray(worldLayout.pois) ? worldLayout.pois.map((q) => ({ id: q.id, x: q.x, z: q.z, lit: progression.isEmberLit(q.id) })) : []),
  renderInfo: () => {
    let shadowLights = 0;
    scene.traverse((o) => { if (o.isLight && o.castShadow && o.visible) shadowLights++; });
    return {
      shadowMap: renderer.shadowMap.enabled, shadowLights, pixelRatio: renderer.getPixelRatio(),
      calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      programs: renderer.info.programs ? renderer.info.programs.length : null,
    };
  },
});
