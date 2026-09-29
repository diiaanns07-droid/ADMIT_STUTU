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
import { createHeroModel, HEROES } from './modules/heroModel.js';
import { createEffects } from './modules/effects.js';
import { createUI } from './modules/ui.js';
import { createVision } from './modules/vision.js';
import { createTrackingHud } from './core/trackingHud.js';
import { createBattleHud } from './core/battleHud.js';
import { createCoachStats, hintInfo } from './core/gestureCoach.js';
import { createProgression } from './core/progression.js';
import { createPushupCounter } from './core/pushupCounter.js';
import { createSquatCounter, topSquatFault, synthSquatPose } from './core/squatCounter.js';

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
  if (['low', 'medium', 'high'].includes(patch.quality)) out.quality = patch.quality;
  if (Number.isFinite(+patch.volume) && patch.volume !== null && patch.volume !== '') out.volume = Math.max(0, Math.min(1, +patch.volume));
  if (Number.isFinite(+patch.sensitivity) && patch.sensitivity !== null && patch.sensitivity !== '') out.sensitivity = Math.max(0.5, Math.min(2, +patch.sensitivity));
  if ('reducedMotion' in patch) out.reducedMotion = !!patch.reducedMotion;
  if (patch.moveMode === 'steer' || patch.moveMode === 'stick') out.moveMode = patch.moveMode; // [V5] «Руль» / «Джойстик»
  if (typeof patch.hero === 'string' && HEROES[patch.hero]) out.hero = patch.hero;
  // [FOREST] место старта: Пепельное плато / Сияющий лес
  if (patch.startZone === 'arena' || patch.startZone === 'forest') out.startZone = patch.startZone;
  return out;
}
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { /* хранилище недоступно */ }
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
  intro: { t: 0, duration: 5, awakened: false }, // screen 'intro': облёт камеры, пробуждение стража
  introShown: false,         // интро показывается при первом бое после меню, не на каждом повторе
  resumableFight: false,     // камера упала во время паузы: после переподключения вернуться в бой
  nav: [],                   // [ASHEN_V2] стек возврата для экранов «Клятва героя» и «Тренировка»
};

// [ASHEN_V2] мир создаётся первым: его раскладка (коллайдеры, земля, арена, старт) нужна бою и камере.
const world = make('world.js', () => createWorld({ THREE, scene, renderer, camera, config }));
const worldLayout = world && world.layout ? world.layout : null;
// [ASHEN_V3] выбор героя: процедурный Пепельный страж или VRoid-героини (CC0, VRM) с анимациями Quaternius
let heroModel = null;
try {
  if (world && world.hero) heroModel = createHeroModel({ THREE, heroRoot: world.hero.root, heroBody: world.hero.body, extras: world.hero.extras, hero: settings.hero, baseUrl: new URL('./assets/quaternius/', import.meta.url).href });
} catch (e) { console.warn('[ASHEN] heroModel', e); }
const bossBrain = make('boss.js', () => createBossBrain(config));
const combat = make('combat.js', () => createCombat({ config, bossBrain, layout: worldLayout }));
const effects = make('effects.js', () => createEffects({ THREE, scene, camera, renderer, config }));
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
  combat.setSpawn(settings.startZone === 'forest' ? worldLayout.spawns.forest : null);
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

// ---------------------------------------------------------------- переходы
function setScreen(screen) {
  if (app.screen === screen) return;
  app.screen = screen;
  if (screen !== 'paused') app.pauseReason = null;
  if (screen !== 'playing') debugInput.clear();
  renderUI();
}

function resetFight() {
  applyStartZone();            // [FOREST] место старта
  combat.reset();              // сбрасывает и bossBrain
  world.reset();
  effects.reset();
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
  resetFight();
  battleHud.reset();
  coachStats.reset();
  app.resumableFight = false;
  app.resumeAt = 0;
  effects.setVolume(gameVolume());
  if (!app.introShown && settings.startZone !== 'forest') {   // [FOREST] облёт интро — только у арены
    app.introShown = true;
    app.intro = { t: 0, duration: settings.reducedMotion ? 2.6 : 5, awakened: false };
    setScreen('intro');
    return;
  }
  setScreen('playing');
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

async function ensureVision() {
  if (vision) return vision;
  if (!visionPromise) {
    visionPromise = createVision({
      video, overlayCanvas: overlay, config: { ...config.vision, sensitivity: settings.sensitivity, moveMode: settings.moveMode },
      onStatus: (s) => { lastVisionStatus = s; },
    }).then((v) => { vision = v; return v; }, (e) => { visionPromise = null; throw e; });
  }
  return visionPromise;
}

async function enableCamera() {
  unlockAudio();
  app.error = null;
  if (app.screen === 'menu' || app.screen === 'error') setScreen('camera');
  try {
    const v = await ensureVision();
    try { await v.start(); }
    catch (e) { if (e && e.code === 'aborted') await v.start(); else throw e; }
    if (app.resumableFight && app.screen === 'camera') setScreen('calibration');
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
    if (from === 'menu') { setScreen('camera'); return; }
    if (from === 'camera') {
      if (arg.debug && app.debug) { setScreen('tutorial'); return; }
      setScreen('calibration');
      return;
    }
    if (from === 'calibration') {
      if (app.resumableFight) { app.resumableFight = false; app.pauseReason = 'tracking'; setScreen('paused'); return; }
      setScreen('tutorial');
      return;
    }
    if (from === 'tutorial') {
      if (!app.debug && !trackingReady()) return; // UI и так держит кнопку неактивной
      startFight();
    }
  },

  onEnableCamera() { return enableCamera(); },

  onCalibrate() {
    unlockAudio();
    if (app.debug) return Promise.resolve(true);
    if (!vision) return Promise.reject(new Error('Сначала включите камеру'));
    return vision.calibrate();
  },

  onPause() { pause('user'); },

  onResume() {
    if (app.screen !== 'paused' || !canResume()) return;
    readInput();               // сжечь импульсы, накопившиеся за паузу
    debugInput.clear();
    app.lostTime = 0;
    app.resumeAt = performance.now() + config.tracking.resumeGraceSec * 1000;
    effects.setVolume(gameVolume());
    setScreen('playing');
  },

  onRestart() {
    unlockAudio();
    if (app.screen === 'error') { location.reload(); return; }
    if (!app.debug && !trackingReady()) { resetFight(); setScreen(vision ? 'calibration' : 'camera'); return; }
    startFight();
  },

  onSettings(patch) {
    const next = sanitizeSettings(patch, settings);
    if (heroModel && next.hero !== settings.hero) heroModel.setHero(next.hero);
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

  onExit() {
    app.nav = [];
    app.resumableFight = false;
    app.introShown = false;
    if (vision) vision.stop();            // в меню камера выключается (калибровка сохраняется в vision)
    resetFight();
    lastSnapshot = null;
    app.error = null;
    setScreen('menu');
  },
};

const ui = make('ui.js', () => createUI({
  root: uiRoot,
  callbacks,
  options: {
    keyboardPause: false,
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
const battleHud = createBattleHud({ canvas: hudCanvas });
// [ТВИСТ «ОШИБКА»] удачные жесты и подсказки за бой → точность и частая ошибка на экране итогов
const coachStats = createCoachStats();
const _proj = new THREE.Vector3();
function projectToScreen(p) {
  _proj.set(p.x, p.y, p.z).project(camera);
  return { x: (_proj.x + 1) * 0.5 * window.innerWidth, y: (1 - _proj.y) * 0.5 * window.innerHeight, behind: _proj.z > 1 };
}
video.style.transform = config.vision.mirror === false ? 'none' : 'scaleX(-1)';

// ---------------------------------------------------------------- настройки
function applySettings() {
  const q = config.qualityPresets[settings.quality] || config.qualityPresets.medium;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
  resize();
  if (app.appliedQuality !== settings.quality) {
    app.appliedQuality = settings.quality;
    world.setQuality(settings.quality);   // тени (castShadow), пепел, огни жаровен, декор
    effects.setQuality(settings.quality); // пулы частиц, вспышечный свет
    if (postfx) { try { postfx.setQuality(settings.quality); } catch (e) { /* ignore */ } }
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

// ---------------------------------------------------------------- трекинг-HUD
function drawTracking(now, input) {
  if (app.debug || !vision) { trackingHud.clear(); return; }
  const mini = app.screen === 'playing';
  let hands = null, pose = null;
  try { hands = vision.getHands(); pose = vision.getPose(); } catch (e) { /* ignore */ }
  trackingHud.draw(now, { pose, status: visionStatus(), input, settings, mode: mini ? 'mini' : 'full', hands });
}

// ---------------------------------------------------------------- UI
function renderUI() {
  uiRoot.classList.toggle('ao-intro', app.screen === 'intro');
  ui.update({
    screen: app.screen === 'intro' ? 'playing' : app.screen,
    snapshot: lastSnapshot,
    tracking: trackingForUI(),   // всегда настоящий статус CV; DEBUG передаётся флагом debug
    debug: app.debug,
    settings,
    error: app.error,
    input: app.lastInput,
    pauseReason: app.pauseReason,
    progress: { ...progression.getView(), emberTotal: EMBER_TOTAL },
    training: app.screen === 'training' ? trainingView() : null,
    coach: app.screen === 'victory' || app.screen === 'defeat' ? coachStats.summary() : null, // [ТВИСТ «ОШИБКА»] итог
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

function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.max(0, (now - last) / 1000);
  last = now;
  const stalled = raw > config.loop.stallSec;       // после ухода вкладки не догоняем
  const dtReal = stalled ? 0 : Math.min(raw, config.loop.maxDt);
  const ts = app.screen === 'playing' ? timeScale(now) : 1;
  const dt = dtReal * ts;

  const input = readInput();
  // [ТВИСТ «ОШИБКА»] код подсказки → жест и текст исправления (для HUD, обучения и итогов)
  if (input && input.hint && hintInfo(input.hint.code)) input.hint = { ...input.hint, ...hintInfo(input.hint.code) };
  app.lastInput = input;
  let events = NO_EVENTS;

  if (app.screen === 'intro') {
    const I = app.intro;
    I.t += dtReal;
    lastSnapshot = combat.getSnapshot();
    if (!I.awakened && I.t >= I.duration * 0.3) {
      I.awakened = true; // «пробуждение»: рёв стража у world, волна и звук у effects (урона нет)
      events = [{ id: `intro-awaken-${Math.round(now)}`, type: 'boss_phase', position: { ...lastSnapshot.boss.position, y: 3 }, data: { stage: 1, awaken: true } }];
    }
    if (I.t >= I.duration) { rig.reset(lastSnapshot.player.position, lastSnapshot.boss.position); readInput(); setScreen('playing'); } // из облёта — в lock-on, дальше камера сама перейдёт в explore
  }

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
      try { combat.update(dt, input); } catch (e) { console.error('[ASHEN] combat.update', e); }
    }
    events = adaptEvents(combat.drainEvents());
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

  if (typeof world.setMirror === 'function') {
    try { world.setMirror(app.debug ? null : mirrorFromPose(input, now)); } catch (e) { /* ignore */ }
  }
  try { world.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] world.update', e); }
  if (heroModel) { try { heroModel.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] heroModel.update', e); } }
  try { effects.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] effects.update', e); }

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

  if (postfx && postfx.enabled) feedPostFx(events);
  let rendered = false;
  if (postfx && postfx.enabled) { try { postfx.render(dtReal); rendered = true; } catch (e) { console.warn('[ASHEN] postfx.render', e); postfx = null; } }
  if (!rendered) renderer.render(scene, camera);
  renderUI();
  drawTracking(now, input);
  battleHud.frame({
    dtReal, timeScale: ts, screen: app.screen, snapshot: lastSnapshot, events, input: app.debug ? null : input,
    project: projectToScreen, viewport: { w: window.innerWidth, h: window.innerHeight },
    intro: { active: app.screen === 'intro', t: app.intro.t, duration: app.intro.duration },
    settings, resumeLeftMs: app.screen === 'playing' ? Math.max(0, app.resumeAt - now) : 0,
    pois: unlitEmbers(),
    coach: coachView(input),
  });

  perf.frames++;
  if (now - perf.t0 >= 1000) { perf.fps = (perf.frames * 1000) / (now - perf.t0); perf.frames = 0; perf.t0 = now; }
}

applySettings();
resize();
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
  heroStep: (dt, snap, events) => { if (heroModel) heroModel.update(dt, snap, events || []); return heroModel ? heroModel.state() : null; }, // QA: шаг анимации без rAF
  squats: () => squats.getDebug(),
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
