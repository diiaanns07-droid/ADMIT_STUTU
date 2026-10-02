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
import { createCoachStats, hintInfo, noteHint, getActiveHint, createCoachHistory, compareCoach } from './core/gestureCoach.js';
import { createProgression } from './core/progression.js';
import { createPushupCounter } from './core/pushupCounter.js';
import { createSquatCounter, topSquatFault, synthSquatPose } from './core/squatCounter.js';
import { createPoseRecorder } from './core/poseRecorder.js'; // [W3-SQUAT] запись позы на тренировке (F8)
import { createHandZone, createHeroBowPose } from './core/handZone.js'; // [HAND] лук и магия рукой
import { createPerfTuner } from './core/perfTuner.js'; // [PERF] автоподстройка под железо
import { createPerfHud } from './core/perfHud.js';     // [PERF] F3 — кадры и трекинг
import { feelOfEvents, FEEL_TIME } from './core/gameFeel.js';     // [FEEL] остановка кадра, замедление, тряска по силе удара
import { CHALLENGE, createChallengeBrain, createChallengeSession, createChallengeHud, createTally, createHall, buildResult } from './modules/challenge.js'; // [W3-CHALLENGE]
import { createPosterCanvas, posterBlob, posterFontsReady, downloadPoster, posterFileName, skeletonFromVision, demoSkeleton } from './modules/posterCard.js'; // [W3-CHALLENGE] постер
import { createCueTracker } from './modules/sfx.js';    // [SFX] «✓ Распознано» и «ОШИБКА» на обучении и в бою
import { createCoachOverlay } from './core/coachOverlay.js'; // [ТВИСТ «ОШИБКА»] подсветка ошибки на превью камеры
import { createTechniqueTrainer } from './modules/techniqueTrainer.js'; // [ТВИСТ «ОШИБКА»] «Тренажёр техники»
import { createUltimateGesture, ultTimeScale, ultCameraKeys } from './core/ultimate.js'; // [W3-ULT] «Небесный суд»
import { createVoiceCoach, createVoiceDirector, createVoiceRecords } from './modules/voiceCoach.js'; // [W3-VOICE] подсказки и диктор — вслух
import { createHandCursor } from './core/handCursor.js'; // [W3-CURSOR] курсор-кисть вместо мыши

const boot = window.__aoBoot || { fail: (m) => console.error(m), done: () => {} };
// [W3-CURSOR] MediaPipe в главном потоке (запасной путь, если worker не прошёл самопроверку) пишет служебные строки glog
// уровней I/W («W1002 … gl_context.cc:1118] OpenGL error checking is disabled») — не сбои игры; в консоль их не пускаем.
// Тот же фильтр — в modules/vision-worker.js. Ошибки (E/F) и все остальные сообщения проходят как раньше.
{
  const GLOG_NOISE = /^[IW]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+\s+[\w.-]+:\d+\]/;
  for (const k of ['log', 'info', 'warn']) {
    const orig = console[k];
    if (typeof orig === 'function') console[k] = (...a) => { if (typeof a[0] === 'string' && GLOG_NOISE.test(a[0])) return; orig.apply(console, a); };
  }
}

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
  if (patch.difficulty === 'easy' || patch.difficulty === 'normal') out.difficulty = patch.difficulty; // [FEEL] сложность боя с Регентом
  if ('muted' in patch) out.muted = patch.muted === true; // [SFX] «Без звука» (кнопка в меню и паузе, клавиша M)
  if ('voice' in patch) out.voice = patch.voice !== false; // [W3-VOICE] «Голос тренера» (кнопка рядом с «Без звука», клавиша V)
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
  // [НОВИЧОК] набор жестов и автоход; смена режима ставит автоход по умолчанию режима (если его не задали явно)
  if (patch.gestureMode === 'novice' || patch.gestureMode === 'master') {
    if (patch.gestureMode !== base.gestureMode && !('autoWalk' in patch)) out.autoWalk = patch.gestureMode === 'novice';
    out.gestureMode = patch.gestureMode;
  }
  if ('autoWalk' in patch) out.autoWalk = patch.autoWalk !== false;
  if ('spiritAvatar' in patch) out.spiritAvatar = patch.spiritAvatar !== false; // [W3-SPIRIT] «Дух игрока»
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
// [НОВИЧОК] лук и магия рукой камерой — только в «Мастере»; «Отладка с клавиатуры» — как раньше, со всеми жестами
const handCombatOn = () => settings.handCombat !== false && (app.debug || settings.gestureMode !== 'novice');

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
// [W3-CHALLENGE] ?challenge — сразу «Испытание · 60 с» (камера → 3-2-1 → минута боя → итоги); ?reset-hall — очистить зал славы дня
const CHALLENGE_Q = PERF_Q.has('challenge') && PERF_Q.get('challenge') !== '0';
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

// [ПРОЕКТОР] размер игровой области — по канвасу: в режиме презентации (ui.js, html.ao-present) это правые 60 % окна
function viewW() { return canvas.clientWidth || window.innerWidth; }
function viewH() { return canvas.clientHeight || window.innerHeight; }
function resize() {
  const w = viewW(), h = viewH();
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
  outroAt: 0,                // [FEEL] performance.now() исхода боя: экран итогов — после замедленного финала
};
// [W3-CHALLENGE] «Испытание · 60 с»: фазы попытки, подсчёт очков (в каждом бою — для постера), зал славы дня,
// кадр боя и линии скелета в момент последнего удара. Логика — modules/challenge.js, функции — блок ниже.
const chal = {
  session: createChallengeSession(),
  tally: createTally(),
  hall: (() => { try { return createHall(window.localStorage); } catch (e) { return createHall(null); } })(),
  hallView: { list: [], best: null },
  hud: null,
  result: null,              // итог попытки (экран «Время вышло», зал, постер)
  posterUrl: '',
  shot: { canvas: null, want: false, at: 0, has: false },
  skeleton: null,
  hudAt: 0, live: { score: 0, rank: 'D' },
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
const bossBrain = make('boss.js', () => createChallengeBrain(createBossBrain, config)); // [W3-CHALLENGE] в испытании — фиксированный seed
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
    postfx.setSize(viewW(), viewH(), renderer.getPixelRatio());
  } catch (e) { console.warn('[ASHEN] postfx недоступен, обычный рендер:', e); postfx = null; }
}).catch((e) => console.warn('[ASHEN] core/postfx.js не загружен, обычный рендер:', e && e.message));
const rig = createCameraRig(config.camera);
// [W3-КИНО] сцены Регента: переход в фазу 2 и гибель (modules/fx/bossFinale.js); нет модуля — бой как был
let bossFinale = null;
import('./modules/fx/bossFinale.js').then((m) => {
  try { bossFinale = m.createBossFinale({ THREE, scene, world, cue, shake: (k) => rig.shake(k), reducedMotion: () => !!settings.reducedMotion, quality: () => settings.quality }); } catch (e) { console.warn('[W3-КИНО] финал Регента', e); }
}).catch((e) => console.warn('[W3-КИНО] bossFinale.js не загружен:', e && e.message));
// [W3-КИНО] события боя → импульсы экрана (core/cinemaFeed.js); гроза второй фазы → гром и отсвет молнии
let cinema = null;
import('./core/cinemaFeed.js').then((m) => {
  try { cinema = m.createCinemaFeed({ pulse: (kind, k, pos, o) => (postfx && typeof postfx.pulse === 'function' ? postfx.pulse(kind, k, pos, o) : false) }); } catch (e) { console.warn('[W3-КИНО] cinemaFeed', e); }
}).catch((e) => console.warn('[W3-КИНО] cinemaFeed.js не загружен:', e && e.message));
// Гроза второй фазы (modules/atmosphere.js): гром — низкий раскат на сэмпле удара Регента (тем тише и ниже, чем
// дальше молния), молния — короткий холодный отсвет на экране. Только в бою; на low и в reducedMotion молний нет.
const STORM_FLASH = { color: 0xc9d6ff, dur: 0.14 };
const _thunder = { gain: 0, rate: 1 };
try {
  if (world && world.atmosphere && typeof world.atmosphere.setStormListener === 'function') {
    world.atmosphere.setStormListener((type, k) => {
      if (app.screen !== 'playing') return;
      if (type === 'thunder') { _thunder.gain = 0.22 + 0.4 * k; _thunder.rate = 0.5 + 0.12 * k; cue('boss_slam', _thunder); }
      else if (type === 'bolt' && postfx && typeof postfx.pulse === 'function') postfx.pulse('flash', 0.08 + 0.08 * k, null, STORM_FLASH);
    });
  }
} catch (e) { console.warn('[W3-КИНО] гроза', e); }
const combatCfg = typeof combat.getConfig === 'function' ? combat.getConfig() : null;

// [ASHEN_V2] прогресс героя: очки клятвы (отжимания, угли на плато) → улучшения боя.
// Хранится только в localStorage этого браузера.
const progression = createProgression();
const pushups = createPushupCounter();
let squats = createSquatCounter({ mode: squatMode() });   // [W3-SQUAT] профиль — по режиму жестов
// [ТВИСТ «ОШИБКА»] «Тренажёр техники»: чек-лист условий жеста вживую (свои счётчики упражнений, очков не даёт)
const trainer = createTechniqueTrainer();
let techView = null;
// exercise: 'pushups' | 'squats'. sim — клавиатурная имитация приседа в DEBUG (без камеры).
const train = { reps: 0, lastPoseT: -1, lastRepAt: -1e9, exercise: 'pushups', hintRef: null, hintAt: -1e9, sim: { k: 0, t: 0, keys: new Set() }, clean: 0, points: 0, lastRep: null };
function resetTraining() {
  if (squats.config.mode !== squatMode()) squats = createSquatCounter({ mode: squatMode() });   // [W3-SQUAT]
  pushups.reset(); squats.reset();
  train.reps = 0; train.lastPoseT = -1; train.lastRepAt = -1e9; train.sim.k = 0; train.sim.t = 0; train.sim.keys.clear();
  train.hintRef = null; train.hintAt = -1e9;
  train.clean = 0; train.points = 0; train.lastRep = null;   // [W3-SQUAT]
}
// [W3-SQUAT] приседания у живой камеры. Профиль счётчика — по режиму жестов: «Новичок» — глубина ≈115–120°, лодыжки
// не обязательны, повтор с ошибкой +1 очко и карточка, чистый +2; «Мастер» — как раньше (100°, только чистые, до стоп).
// Запись позы на экране тренировки — последние 90 с в памяти, F8 сохраняет файл (разбор: node dev/squat_replay.mjs).
// Точная модель позы (full) на экране тренировки, если видеокарта не программная (core/perfTuner.js); на выходе — прежняя.
function squatMode() { return settings.gestureMode === 'master' ? 'master' : 'novice'; }
const poseRec = createPoseRecorder({ maxFrames: 2700, meta: { source: 'ashen-game' } });
function savePoseRecording() {
  const rec = poseRec.snapshot({ note: 'F8', exercise: train.exercise, mode: squatMode(), poseModel: visionStatus().debug ? visionStatus().debug.poseModel : null, debugSim: app.debug });
  if (!rec.frames.length) { flashRecNote('Запись позы пуста — включите камеру и встаньте в кадр'); return; }
  poseRec.clear();
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ashen-pose-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  flashRecNote(`Сохранено: последние ${Math.round((rec.frames[rec.frames.length - 1].t - rec.frames[0].t) / 1000)} с позы → ${a.download}`);
}
// Страховка: точная модель на слабой видеокарте медленнее 6 Гц дольше 8 с (камера ≥ 20 к/с) — до конца сессии быстрая.
// Счётчику приседаний хватает и 6 Гц (dev/squatSim.mjs), поэтому порог низкий.
const trainPose = { active: false, prevUrl: null, slowSince: null, slow: false };
function trainPoseTick() {
  if (!vision || typeof vision.setPoseModel !== 'function' || !DEPS.mediaPipe.modelFullUrl) return;
  // ?trainpose=full|lite — модель на тренировке вручную (QA: проверить смену и на программном рендере)
  const forced = PERF_Q.get('trainpose') || (PERF_Q.get('pose') === 'lite' ? 'lite' : null);
  if (trainPose.active && trainPose.prevUrl && forced !== 'full') {
    const d = visionStatus().debug, now = performance.now();
    const slow = d && d.poseModel === 'full' && !d.poseSwitching && Number.isFinite(d.inferenceHz) && Number.isFinite(d.cameraFps) && d.cameraFps >= 20 && d.inferenceHz < 6;
    trainPose.slowSince = slow ? (trainPose.slowSince ?? now) : null;
    if (slow && now - trainPose.slowSince > 8000) { trainPose.slow = true; console.warn(`[W3-SQUAT] точная модель позы на тренировке не успевает (${d.inferenceHz} Гц) — быстрая`); }
  }
  const want = app.screen === 'training' && !app.debug && !trainPose.slow && forced !== 'lite' && (forced === 'full' || !perfTuner || perfTuner.trainingPoseModel() === 'full');
  if (want && !trainPose.active) {
    const vs = visionStatus(), d = vs.debug;
    // не во время запуска камеры и загрузки модели: смена пересоздаёт движок, start() держит прежний
    if ((d && d.poseSwitching) || !(vs.status === 'ready' || vs.status === 'lost' || vs.status === 'idle')) return;
    trainPose.active = true;
    trainPose.prevUrl = d && d.poseModel === 'full' ? null : DEPS.mediaPipe.modelUrl;
    if (trainPose.prevUrl) vision.setPoseModel(DEPS.mediaPipe.modelFullUrl).catch(() => {});
  } else if (!want && trainPose.active) {
    trainPose.active = false; trainPose.slowSince = null;
    if (trainPose.prevUrl) vision.setPoseModel(trainPose.prevUrl).catch(() => {});
    trainPose.prevUrl = null;
  }
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
  const step = rate * Math.min(0.5, dt);   // [W3-SQUAT] по времени: и при 2–5 кадрах/с (слабая машина) присед доходит до низа
  sim.k = sim.k < target ? Math.min(target, sim.k + step) : Math.max(target, sim.k - step);
  const kf = K.has('KeyG');
  return synthSquatPose(sim.k, kf ? 'side' : 'front', { valgus: K.has('KeyV'), kneesForward: kf, lean: K.has('KeyT'), heels: K.has('KeyH') });
}
function applyUpgrades() {
  if (typeof combat.setUpgrades !== 'function') return;
  try { combat.setUpgrades(chal.session.active ? {} : progression.mods()); } catch (e) { console.warn('[ASHEN] setUpgrades', e); } // [W3-CHALLENGE] в испытании — без улучшений
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
  if (chal.session.active) { combat.setSpawn(edgeSpawn()); return; }   // [W3-CHALLENGE] испытание — всегда у края арены
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
  const scale = s.debug && s.debug.reliability ? s.debug.reliability.scaleWarning : null;   // сохранённая калибровка с другого расстояния
  if (scale === 'far') return 'Сядьте ближе к камере';
  if (scale === 'near') return 'Отодвиньтесь от камеры';
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
  screenAudio(screen);
  renderUI();
}

function resetFight() {
  applyStartZone();            // [FOREST] место старта
  if (typeof combat.setDifficulty === 'function') { try { combat.setDifficulty(chal.session.active ? CHALLENGE.difficulty : settings.difficulty); } catch (e) { console.warn('[FEEL] сложность', e); } } // [FEEL] HP и урон Регента
  combat.reset();              // сбрасывает и bossBrain
  world.reset();
  effects.reset();
  if (bossFinale) bossFinale.reset();   // [W3-КИНО] осколки и кинокамера прошлого боя
  if (cinema) cinema.reset();           // [W3-КИНО] отложенные импульсы прошлого боя
  if (handVisuals) { try { handVisuals.reset(); } catch (e) { /* [HAND] */ } }
  if (handZone) handZone.reset(); // [HAND]
  debugInput.clear();
  readInput();                 // выбросить накопленные импульсы
  combat.drainEvents();
  lastSnapshot = combat.getSnapshot();
  rig.reset(rigState(lastSnapshot, ZERO));
  app.lostTime = 0;
  app.outroAt = 0;             // [FEEL] финал и замедление прошлого боя не переходят в новый
  timeFx.slowUntil = 0; timeFx.stopUntil = 0;
  ultReset();                  // [W3-ULT] сцена и удержание жеста не переходят в новый бой
}

// [ASHEN_V2] состояние камеры из снимка: вне арены — камера исследования, в арене — lock-on.
function rigState(snap, impulse) {
  const P = snap.player;
  return {
    player: P.position, playerYaw: P.yaw, velocity: P.velocity, boss: snap.boss.position,
    engaged: P.encounter !== 'explore', impulse, colliders: worldLayout ? worldLayout.colliders : null,
    groundY: worldLayout ? worldLayout.groundY : null,   // [ASHEN_V3] камера над рельефом большой карты
    steer: P.moveMode === 'steer',                        // [V5] «Руль»: камера держится за спиной героя
    reducedMotion: !!settings.reducedMotion,              // [FEEL] без тряски камеры
    cineT: ULT.cine ? ULT.cine.t : null,                  // [W3-ULT] время облёта «Небесного суда»
  };
}

function startFight() {
  if (pvpCtl && pvpCtl.active && pvpCtl.inMatch) { app.introShown = true; setScreen('playing'); return; } // [PVP] матч идёт: вернуться в бой без сброса
  challengePrepare();          // [W3-CHALLENGE] seed Регента, сложность, улучшения — до сброса боя
  resetFight();
  battleHud.reset();
  resetCoach();
  app.resumableFight = false;
  app.resumeAt = 0;
  effects.setVolume(gameVolume());
  if (challengeStart()) return; // [W3-CHALLENGE] испытание — без облёта, отсчёт 3-2-1
  if (!app.introShown && settings.startZone !== 'forest') {   // [FOREST] облёт интро — только у арены
    app.introShown = true;
    // [ONBOARD] облёт 1,8 с (было 5 с): первый удар успевает за 3 с после «В бой»; любая клавиша, клик или жест — пропустить
    app.intro = { t: 0, duration: CLASSIC ? (settings.reducedMotion ? 2.6 : 5) : settings.reducedMotion ? 1.5 : 1.8, awakened: false, skip: false };
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
  if (app.resumableFight) {
    // пауза игрока (Esc) остаётся паузой игрока; автопродолжение — только после потери трекинга
    const why = app.resumableReason === 'user' ? 'user' : 'tracking';
    app.resumableFight = false; app.resumableReason = null;
    app.pauseReason = why; setScreen('paused'); app.pauseReason = why;
    return;
  }
  if (DEMO || chal.session.phase === 'armed' || (pvpCtl && pvpCtl.active && pvpCtl.inMatch)) { startFight(); return; }   // [W3-CHALLENGE] испытание — без обучения   // [PVP] дуэль уже идёт — обратно в бой
  setScreen('tutorial');
}

// [ONBOARD] пауза «Трекинг потерян» снимается сама: тело снова в кадре → отсчёт 3-2-1 → бой.
// Кратковременное пропадание плеч (<0,3 с) отсчёт не сбрасывает. Пауза игрока (Esc, «Пауза») — только кнопкой.
const AUTO_RESUME_MS = 3000;
function autoResumeTick(now) {
  const auto = QUICK && !app.debug && app.screen === 'paused' && app.pauseReason === 'tracking';
  if (!auto) { app.autoResume = null; return; }
  const r = app.autoResume;
  if (trackingReady() && !cursorHolds()) {   // [W3-CURSOR] палец на кнопке паузы — отсчёт ждёт
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
  if (app.outroAt) return;     // [FEEL] бой уже окончен: замедленный финал не ставится на паузу
  setScreen('paused');
  app.pauseReason = reason || 'user';
  renderUI();                // [SFX] звук паузы — в screenAudio(): петли щита/полёта орбов молчат всю паузу
}

const AUDIO_ON = !(config.audio && config.audio.enabled === false);
let voiceDuck = 1; // [W3-VOICE] пока звучит голос тренера — SFX чуть тише
const gameVolume = () => (AUDIO_ON && !settings.muted ? settings.volume * voiceDuck : 0);
function unlockAudio() { if (!AUDIO_ON) return; try { effects.unlockAudio().catch(() => {}); } catch (e) { /* ignore */ } }
// [SFX] Громкость по экрану: пока бой приостановлен (пауза, «Клятва героя»/«Тренировка» из паузы, переподключение
// камеры посреди боя), боевые звуки и петли молчат — снимок боя заморожен, и щит/орбы иначе гудели бы без конца;
// проба громкости и интерфейс слышны. На остальных экранах звук возвращается (раньше выход из паузы в меню
// оставлял игру без звука).
function screenAudio(screen) {
  try {
    const suspended = screen === 'paused' || (screen !== 'playing' && (app.resumableFight || app.nav.includes('paused')));
    if (effects && typeof effects.setAudioPaused === 'function') { effects.setAudioPaused(suspended); effects.setVolume(gameVolume()); }
    else effects.setVolume(screen === 'paused' ? 0 : gameVolume());
    if (screen === 'tutorial') sfxCues.reset();
  } catch (e) { /* до инициализации звука */ }
}
const sfxCues = createCueTracker();
function cue(name, param) { if (name && AUDIO_ON && effects && typeof effects.cue === 'function') { try { effects.cue(name, param); } catch (e) { /* ignore */ } } }   // [W3-КИНО] param: { gain, rate } — гром
let previewTimer = 0;
function previewVolume() { clearTimeout(previewTimer); previewTimer = setTimeout(() => cue('ui_ok'), 120); } // проба после остановки ползунка
// [SFX] AudioContext разблокируется первым же кликом или клавишей (браузер не даёт звук без жеста игрока)
for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, () => unlockAudio(), { capture: true, passive: true });
// [SFX] M — «Без звука». В отладочном бою M занят огненным шаром (core/handZone.js, capture + preventDefault).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type)))) return;
  callbacks.onSettings({ muted: !settings.muted });
});
// [SFX] «✓ Распознано»: карточка обучения перешла в data-state=seen (атрибут меняется только на переходе)
if (typeof MutationObserver === 'function' && uiRoot) {
  new MutationObserver((records) => {
    if (app.screen !== 'tutorial') return;
    for (const r of records) {
      const t = r.target;
      if (r.oldValue === 'seen' || !t.classList || !t.classList.contains('ao-chip') || t.getAttribute('data-state') !== 'seen') continue;
      const card = t.closest('.ao-tut-card');
      cue(sfxCues.chip(card && card.dataset ? card.dataset.key : null));
    }
  }).observe(uiRoot, { subtree: true, attributes: true, attributeFilter: ['data-state'], attributeOldValue: true });
}

// ---------------------------------------------------------------- [W3-VOICE] голос тренера
// Подсказки «ОШИБКА», счёт на тренировке и реплики диктора звучат вслух (modules/voiceCoach.js, фразы —
// core/voicePhrases.js): жюри в 3–5 м от проектора мелкий текст не прочитает, а «Сомкни кольцо!» слышит весь зал.
// Громкость — общий ползунок, «Без звука» (M) глушит и голос; пока звучит речь, SFX тише (voiceDuck в gameVolume).
// V — «Голос тренера» вкл/выкл. В обучении голос читает ту подсказку, что на экране (data-voice-hint у карточки ui.js),
// и «Распознано!» — на шаге, перешедшем в data-state=ok.
let voiceCoach = null, voiceDirector = null, voiceWasOn = settings.voice !== false;
const voiceTut = { hint: null, ok: null, n: 0, trainer: null };
function voiceVolume() { const v = AUDIO_ON ? settings.volume : 0; return v > 0 ? Math.min(1, 0.4 + 0.6 * v) : 0; } // речь разборчива и на тихом ползунке
try {
  let records = null;
  try { records = createVoiceRecords(window.localStorage); } catch (e) { records = createVoiceRecords(null); }
  voiceCoach = createVoiceCoach({
    enabled: settings.voice !== false, muted: !!settings.muted, volume: voiceVolume(),
    onDuck: (on) => { voiceDuck = on ? 0.6 : 1; try { effects.setVolume(gameVolume()); } catch (e) { /* звук ещё не создан */ } },
  });
  voiceDirector = createVoiceDirector(voiceCoach, { records });
} catch (e) { console.warn('[VOICE] голос тренера недоступен', e); voiceCoach = null; voiceDirector = null; }
function voiceSettings() {
  if (!voiceCoach) return;
  const on = settings.voice !== false;
  voiceCoach.setVolume(voiceVolume()); voiceCoach.setMuted(!!settings.muted); voiceCoach.setEnabled(on);
  if (on && !voiceWasOn && voiceDirector) voiceDirector.announce('voiceOn');
  voiceWasOn = on;
}
function voiceView() { return { on: settings.voice !== false, state: voiceCoach ? voiceCoach.state : 'no-api' }; }
// V — как M, но в отладке V занята: печать «Дельта» в бою (core/debugInput.js гасит её preventDefault) и «колени внутрь» в имитации приседа
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (app.debug ? (app.screen === 'playing' || app.screen === 'intro' || app.screen === 'tutorial' || simActive()) : e.defaultPrevented) return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type)))) return;
  callbacks.onSettings({ voice: settings.voice === false });
});
if (typeof MutationObserver === 'function' && uiRoot) {
  new MutationObserver((records) => {
    if (app.screen !== 'tutorial') return;
    for (const r of records) {
      const t = r.target, cl = t.classList;
      if (!cl) continue;
      if (r.attributeName === 'data-voice-hint') {
        const [code, at] = String(t.getAttribute('data-voice-hint') || '').split('|');
        if (code) voiceTut.hint = { code, tMs: +at || 0, ...(hintInfo(code) || {}) };
        continue;
      }
      const st = t.getAttribute('data-state');
      if ((cl.contains('ao-trn-pill') && st === 'ok' && r.oldValue !== 'ok') || (cl.contains('ao-chip') && st === 'seen' && r.oldValue !== 'seen')) voiceTut.ok = `ok|${++voiceTut.n}`;
    }
  }).observe(uiRoot, { subtree: true, attributes: true, attributeFilter: ['data-state', 'data-voice-hint'], attributeOldValue: true });
}
// Раз в кадр (после HUD): подсказки, события боя, отсчёт, тренировка.
function voiceFrame(now, input, events) {
  if (!voiceDirector) return;
  try {
    const scr = app.screen, pvp = !!(pvpCtl && pvpCtl.active);
    let hint = input && input.hint && input.hint.code ? input.hint : null;
    if (scr === 'tutorial') {
      if (voiceTut.trainer === null) voiceTut.trainer = !!uiRoot.querySelector('[data-voice-hint], .ao-trn-coach');
      if (voiceTut.trainer) hint = voiceTut.hint;   // тренажёр показывает не каждую подсказку — говорим показанную
    } else { voiceTut.hint = null; voiceTut.ok = null; }
    let training = null;
    if (scr === 'training') {
      if (train.exercise === 'squats') { const q = squats.read(); training = { exercise: 'squats', reps: train.reps, attempts: q.attempts, hint: q.lastHint }; }
      else { const r = pushups.read(); training = { exercise: 'pushups', reps: train.reps, attempts: train.reps + (r.rejected | 0) + (r.shallow | 0), hint: r.lastHint }; }
    }
    // отсчёт: автопродолжение после потери трекинга (пауза) и раунд дуэли
    let countdown = 0;
    if (scr === 'paused' && app.autoResume) countdown = (app.autoResume.at - performance.now()) / 1000;
    else if (pvp && scr === 'playing') {
      const ss = pvpCtl.session;
      if (ss && ss.phase === 'countdown' && ss.state && ss.config && ss.config.rounds) countdown = ss.config.rounds.countdown - (performance.now() - ss.state.phaseAt) / 1000;
    }
    const b = lastSnapshot && lastSnapshot.boss;
    let won = false;
    if (Array.isArray(events)) for (const e of events) if (e && e.type === 'victory') won = true;
    voiceDirector.frame(now, {
      screen: scr, hint, events, pvp, countdown, training, recognized: voiceTut.ok,
      boss: b && !app.outroAt ? { hp: b.hp, maxHp: b.maxHp } : null,
      fight: won && lastSnapshot ? { time: lastSnapshot.time, accuracy: coachStats.summary().accuracy } : null, // рекорд победы
    });
  } catch (e) { console.warn('[VOICE] кадр', e); }
}

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
  const slow = !trainPose.active && d.poseModel === 'full' && Number.isFinite(d.inferenceHz) && Number.isFinite(d.cameraFps) && d.cameraFps >= 20 && d.inferenceHz < 16;
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
      video, overlayCanvas: overlay, config: { ...config.vision, ...visionProfile(), sensitivity: settings.sensitivity, moveMode: settings.moveMode, gestureMode: settings.gestureMode },
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

// [ONBOARD] камера нужна на экранах камеры, калибровки, обучения, тренировки и в бою/паузе — не в меню и не в DEBUG
function cameraWanted() { return !app.debug && ((app.screen !== 'menu' && app.screen !== 'oath' && app.screen !== 'error') || cursorWantsCamera()); } // [W3-CURSOR]
async function enableCamera() {
  unlockAudio();
  app.error = null;
  if (app.screen === 'menu' || app.screen === 'error') setScreen('camera');
  try {
    const v = await ensureVision();
    try { await v.start(); }
    catch (e) {
      if (!(e && e.code === 'aborted')) throw e;
      if (!cameraWanted()) return;   // [ONBOARD] «В меню» / DEBUG, пока камера запускалась: не включать её снова
      await v.start();
    }
    if (!cameraWanted()) { v.stop(); return; }
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
      if (arg.debug && app.debug) { if (chal.session.phase === 'armed') startFight(); else setScreen('tutorial'); return; } // [W3-CHALLENGE]
      if (QUICK && trackingReady()) { leaveCamera(); return; }   // [ONBOARD] калибровка уже есть — дальше
      setScreen('calibration');
      return;
    }
    if (from === 'calibration') {
      if (app.resumableFight) { const why = app.resumableReason === 'user' ? 'user' : 'tracking'; app.resumableFight = false; app.resumableReason = null; app.pauseReason = why; setScreen('paused'); return; }
      if (chal.session.phase === 'armed') { startFight(); return; } // [W3-CHALLENGE]
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
    setScreen('playing');      // [SFX] громкость вернёт screenAudio()
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
    // [SFX] сдвинули ползунок — звук включается обратно и звучит проба новой громкости
    const volumeMoved = patch && 'volume' in patch && next.volume !== settings.volume;
    if (volumeMoved && next.volume > 0 && !('muted' in patch)) next.muted = false;
    Object.assign(settings, next); // мутация на месте: config.settings === settings
    if (zoneChanged && app.screen === 'menu') { try { resetFight(); } catch (e) { console.warn('[ASHEN] startZone', e); } }   // [FOREST] герой в меню — у выбранного места старта
    applySettings();
    if (motionChanged && typeof world.configure === 'function') world.configure({ reducedMotion: settings.reducedMotion });
    if (motionChanged && postfx) { try { postfx.setReducedMotion(!!settings.reducedMotion); } catch (e) { /* ignore */ } }
    saveSettings(settings);
    renderUI();
    if (volumeMoved || (patch && patch.muted === false)) previewVolume();
  },

  onDebug(enabled) {
    const on = enabled === undefined ? !app.debug : !!enabled;
    app.debug = on;
    debugInput.setEnabled(on);
    if (on) trainer.setDemo(true);        // [ТВИСТ «ОШИБКА»] тренажёр без камеры — демо
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
  // [ТВИСТ «ОШИБКА»] «Тренажёр техники»: камера включается сразу; в отладке с клавиатуры — демо без камеры
  onTechnique() {
    unlockAudio();
    trainer.reset();
    trainer.setDemo(app.debug);
    openSub('technique');
    if (!app.debug) enableCamera();
  },
  onTechniqueGesture(id) { trainer.select(id); renderUI(); },
  onPoseRecord() { savePoseRecording(); },   // [W3-SQUAT] «Сохранить запись позы» на экране тренировки
  onTechniqueDemo(on) { if (app.debug) return; trainer.setDemo(on); renderUI(); },
  onBuyUpgrade(id) { if (progression.buy(id).ok) renderUI(); },
  onBack() {
    const to = app.nav.pop() || 'menu';
    if (to === 'menu' && vision && !app.resumableFight && !cursorCamAllowed()) vision.stop();   // в меню камера не нужна ([W3-CURSOR] — кроме курсора-кисти)
    setScreen(to);
  },

  onNet() { openNet().catch((e) => { app.error = `Онлайн-модуль не загрузился: ${(e && e.message) || e}`; setScreen('error'); }); }, // [NET]

  onExit() {
    if (pvpCtl && pvpCtl.active) pvpCtl.stop();   // [PVP] выход из дуэли: бой возвращается к Регенту
    challengeExit();                      // [W3-CHALLENGE] обычный бой: случайный seed, улучшения клятвы
    app.nav = [];
    app.resumableFight = false;
    app.introShown = false;
    app.autoResume = null;                // [ONBOARD]
    if (vision && !cursorCamAllowed()) vision.stop();   // в меню камера выключается (калибровка сохраняется в vision); [W3-CURSOR] — кроме курсора-кисти
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
// ---------------------------------------------------------------- [W3-CURSOR] курсор-кисть
// «Камера вместо джойстика» — и вместо мыши: на экранах с кнопками указательный палец правой руки ведёт
// светящееся кольцо (core/handCursor.js), клик — задержать на кнопке 0,8 с или щепоть. В бою, интро, на шагах обучения
// (жесты там — упражнение), на экранах камеры и в «Отладке с клавиатуры» курсора нет; обучение пройдено — курсор
// нажимает «В бой». ?cursor=0 — выключить совсем.
// В меню камера включается сама, если разрешение на неё уже дано (окно запроса браузера не всплывает);
// при первом запуске разрешение спрашивает «Играть» (Enter), дальше мышь не нужна.
const CURSOR_ON = PERF_Q.get('cursor') !== '0';
const CURSOR_SCREENS = new Set(['menu', 'paused', 'victory', 'defeat', 'oath', 'technique', 'training', 'error', 'challenge']); // + итоги «Испытания» (имя в зал славы, «Ещё раз»)
const CURSOR_NO_PINCH = new Set(['technique', 'training']);   // в тренажёре щепоть «OK» — упражнение, а не клик
// там, где руки заняты упражнением, кнопка нажимается дольше — случайное движение её не заденет
const CURSOR_DWELL = { technique: 1200, training: 1500 };
let handCursor = null, cursorOut = null;
const cursorCam = { granted: false, startP: null };
if (CURSOR_ON) {
  try { handCursor = createHandCursor({ onClick: () => cue('ui_ok') }); } catch (e) { console.warn('[W3-CURSOR] курсор', e); handCursor = null; }
  try {
    if (handCursor && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'camera' }).then((p) => {
        cursorCam.granted = cursorCam.granted || p.state === 'granted';
        p.onchange = () => { cursorCam.granted = p.state === 'granted'; };
      }, () => { /* браузер не знает разрешения «camera» — камера в меню после первого запуска */ });
    }
  } catch (e) { /* то же */ }
}
// камера в меню нужна курсору: не отладка, разрешение уже есть
function cursorCamAllowed() { return !!handCursor && !app.debug && cursorCam.granted; }
function cursorWantsCamera() { return cursorCamAllowed() && !app.error && (app.screen === 'menu' || app.screen === 'oath'); }
// кольцо на кнопке: игрок выбирает пункт паузы — автопродолжение 3-2-1 не перебивает его
function cursorHolds() { return !!(cursorOut && cursorOut.visible && cursorOut.targetId !== null); }
function cursorTick(now) {
  if (!handCursor) return;
  const vst = vision ? visionStatus().status : 'idle';
  if (vst === 'ready' || vst === 'calibrating' || vst === 'lost') cursorCam.granted = true;   // камера уже работала — разрешение есть
  if (cursorWantsCamera() && !cursorCam.startP && vst === 'idle') {
    cursorCam.startP = ensureVision().then((v) => (cursorWantsCamera() ? v.start() : null))
      .catch((e) => console.info('[W3-CURSOR] камера в меню не включилась:', e && (e.code || e.message)))
      .finally(() => { cursorCam.startP = null; });
  }
  const book = !!uiRoot.querySelector('.ao-screen--book:not([hidden])');
  const tutDone = app.screen === 'tutorial' && !!uiRoot.querySelector('.ao-trn-stage.is-done');
  const active = !app.debug && !!vision && (CURSOR_SCREENS.has(app.screen) || book || tutDone);
  let hands = null, pose = null;
  if (active) { try { hands = vision.getHands(); pose = vision.getPose(); } catch (e) { hands = null; pose = null; } }
  try { cursorOut = handCursor.update(now, { hands, pose, active, pinch: !CURSOR_NO_PINCH.has(app.screen) || book, dwellMs: book ? 0 : CURSOR_DWELL[app.screen] || 0 }); } catch (e) { console.warn('[W3-CURSOR]', e); handCursor = null; cursorOut = null; }
}
// [ТВИСТ «ОШИБКА»] свой слой поверх overlay: точки, которые надо исправить (getActiveHint) и условия тренажёра.
// COACH_OVERLAY = false — выключить (например, если подсветку рисует сам трекинг-HUD).
const COACH_OVERLAY = true;
let coachOverlay = null;
if (COACH_OVERLAY && slot) { try { coachOverlay = createCoachOverlay({ slot }); } catch (e) { console.warn('[ASHEN] coachOverlay', e); coachOverlay = null; } }
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
// [W3-SPIRIT] дух игрока: светящийся силуэт повторяет руки и пальцы игрока — в превью камеры и над ареной (modules/spiritAvatar.js)
let spirit = null;
import('./modules/spiritAvatar.js').then((m) => { try { spirit = m.createSpiritAvatar({ THREE, scene, camera, renderer, slot, overlay, heroes: HEROES, settings }); } catch (e) { console.warn('[W3-SPIRIT]', e); } }).catch((e) => console.warn('[W3-SPIRIT] modules/spiritAvatar.js', e && e.message));
const battleHud = createBattleHud({ canvas: hudCanvas });
// [ТВИСТ «ОШИБКА»] удачные жесты и подсказки за бой → точность и частая ошибка на экране итогов
const coachStats = createCoachStats();
// итог боя для экрана итогов: точность по жестам, топ-3 ошибок и сравнение с прошлым боем (localStorage)
let coachHistory = null;
try { coachHistory = createCoachHistory(window.localStorage); } catch (e) { coachHistory = createCoachHistory(null); }
const coachEdge = { attack: false, shield: false };   // начало удержания «OK» и щита — удачный жест
let coachEnd = null;                                   // { ...summary, prev, compare } — замораживается в конце боя
function finishCoach() {
  if (coachEnd) return;
  const s = coachStats.summary();
  const prev = coachHistory ? coachHistory.push(s, Date.now()) : null;
  coachEnd = { ...s, prev, compare: compareCoach(s, prev) };
}
function resetCoach() { coachStats.reset(); coachEnd = null; coachEdge.attack = false; coachEdge.shield = false; }
// [PVP] дуэль игрок против игрока (modules/pvp.js, №3): грузится динамически; при ошибке — обычный бой.
// ?pvp=local — две вкладки одного браузера (DEBUG, клавиатура). Лобби №2: window.__ashenPvp.start(net, {name, hero}).
let pvpCtl = null;
import('./modules/pvp.js').then((m) => {
  try {
    pvpCtl = m.createPvpController({
      THREE, scene, camera, combat, config, settings, arena: worldLayout && worldLayout.arena,
      host: {
        startFight() { resetFight(); battleHud.reset(); resetCoach(); app.resumableFight = false; app.resumeAt = 0; app.introShown = true; setScreen('playing'); },
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

// ---------------------------------------------------------------- [W3-CHALLENGE] «Испытание · 60 с»
// Одна и та же минута для каждого члена жюри: фиксированный seed Регента (порядок атак), «Лёгкая» сложность,
// без улучшений «Клятвы героя», старт у края арены, без облёта — отсчёт 3-2-1. Очки и ранг — modules/challenge.js,
// зал славы дня — localStorage этого ноутбука, постер — modules/posterCard.js (кадр боя и линии скелета в момент
// последнего удара; видео камеры не сохраняется). Подсчёт очков идёт в каждом бою: постер есть и после обычного.
try { chal.hud = createChallengeHud({ root: uiRoot }); } catch (e) { console.warn('[W3-CHALLENGE] таймер', e); chal.hud = null; }
function refreshHall() { const all = chal.hall.all(); chal.hallView = { list: all, best: all[0] || null }; }   // экран сам выбирает топ-10 и своё место
refreshHall();
if (PERF_Q.has('reset-hall')) {
  chal.hall.clear(); refreshHall();
  try { const u = new URL(location.href); u.searchParams.delete('reset-hall'); history.replaceState(null, '', u.href); } catch (e) { /* адрес останется прежним */ }
  setTimeout(() => flashRecNote('Зал славы дня очищен — можно начинать финал'), 400);
}
// новая попытка или обычный бой: до resetFight (он читает сложность и место старта, combat.reset — мозг Регента)
function challengePrepare() {
  const on = chal.session.active && !(pvpCtl && pvpCtl.active);
  if (on) chal.session.arm(); else chal.session.disarm();
  try { bossBrain.useChallenge(on); } catch (e) { console.warn('[W3-CHALLENGE] seed', e); }
  applyUpgrades();
  chal.result = null; chal.skeleton = null; chal.shot.has = false; chal.shot.want = false; chal.shot.at = 0;
  setPosterUrl('');
}
// бой сброшен: подсчёт с нуля; в испытании — сразу на арену и отсчёт 3-2-1 (true — облёт не нужен)
function challengeStart() {
  chal.tally.reset(lastSnapshot);
  if (!chal.session.active) return false;
  app.introShown = true;
  chal.session.begin(performance.now(), lastSnapshot);
  chal.live = { score: 0, rank: 'D' };
  setScreen('playing');
  return true;
}
function challengeExit() {
  if (!chal.session.active) return;
  chal.session.disarm();
  try { bossBrain.useChallenge(false); } catch (e) { /* ignore */ }
  applyUpgrades();
}
function challengeResult(kind) {
  const hero = HEROES[settings.hero] || {};
  return buildResult({
    tally: chal.tally, snap: lastSnapshot, coach: coachEnd || coachStats.summary(), session: kind === 'challenge' ? chal.session : null, kind,
    mode: app.debug ? 'debug' : settings.gestureMode, hero: settings.hero, heroName: hero.name || '',
  });
}
// конец попытки: итог → зал славы дня (имя впишут на экране итогов) → постер
function finishChallenge() {
  finishCoach();
  const r = challengeResult('challenge');
  const h = chal.hall.add({ ...r, name: '' });
  chal.result = { ...r, place: h.place, total: h.total, isRecord: h.isRecord, entryId: h.entry.id, name: '', named: false };
  refreshHall();
  buildPosterPreview();
}
// кадр боя: очки в каждом бою; в испытании — отсчёт, таймер, конец минуты
function challengeFrame(now, events) {
  if (chal.tally.add(events, lastSnapshot.time)) noteHitMoment(now);
  if (!chal.session.active || (pvpCtl && pvpCtl.active)) return;
  const done = lastSnapshot.status === 'victory' || lastSnapshot.status === 'defeat';
  if (done && chal.session.end(lastSnapshot.status, lastSnapshot)) { finishChallenge(); return; }   // итоги — после замедленного финала
  const sig = chal.session.frame(now, lastSnapshot);
  if (sig === 'tick') cue('ui_ok');
  else if (sig === 'go') cue('perfect');
  else if (sig === 'timeup') { app.outroAt = now; cue('boss_phase'); finishChallenge(); }   // outroAt: бой окончен — без паузы и подсчёта жестов
  else if (sig === 'show') { app.outroAt = 0; setScreen(challengeRoute(false)); }
}
// куда после финала боя: итоги испытания (с фанфарами рекорда) или обычные «Победа» / «Поражение»
function challengeRoute(win) {
  if (chal.session.active && chal.session.phase === 'done' && chal.result) {
    if (chal.result.isRecord) {
      cue('victory');
      if (chal.hud) { try { chal.hud.celebrate({ reducedMotion: !!settings.reducedMotion }); } catch (e) { /* не критично */ } }
    }
    return 'challenge';
  }
  return win ? 'victory' : 'defeat';
}
// крупный таймер и живые очки над боем (очки пересчитываются 8 раз в секунду)
function challengeHud(now) {
  if (!chal.hud) return;
  const ph = chal.session.phase;
  const show = app.screen === 'playing' && (ph === 'countdown' || ph === 'running' || ph === 'timeup' || (ph === 'done' && !!app.outroAt));
  if (show && ph === 'running' && now - chal.hudAt > 120) {
    chal.hudAt = now;
    const r = challengeResult('challenge');
    chal.live = { score: r.score, rank: r.rank };
  } else if (chal.result && (ph === 'timeup' || ph === 'done')) chal.live = { score: chal.result.score, rank: chal.result.rank };
  const hint = app.debug ? 'J — снаряды · K — щит · L — выброс · пробел — рывок' : '«OK» правой — снаряды · толкни ладонь к камере — щит · кулак → ладонь — выброс';
  try { chal.hud.update({ show, ...chal.session.view(now), outcome: chal.session.outcome, score: chal.live.score, rank: chal.live.rank, hint }); } catch (e) { console.warn('[W3-CHALLENGE] таймер', e); chal.hud = null; }
}
// момент попадания по Регенту: линии скелета (точки позы и кистей, не видео) и кадр боя — не чаще раза в 0,6 с
function noteHitMoment(now) {
  if (!app.debug && vision) { try { const sk = skeletonFromVision(vision.getPose(), vision.getHands()); if (sk) chal.skeleton = sk; } catch (e) { /* без скелета */ } }
  if (now - chal.shot.at >= 600) { chal.shot.at = now; chal.shot.want = true; }
}
function grabShot() {
  chal.shot.want = false;
  try {
    const W = 760, H = Math.max(1, Math.round(W * viewH() / Math.max(1, viewW())));
    const c = chal.shot.canvas || (chal.shot.canvas = document.createElement('canvas'));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    c.getContext('2d').drawImage(canvas, 0, 0, W, H);
    chal.shot.has = true;
  } catch (e) { chal.shot.has = false; }
}
function posterData() {
  const r = chal.result || challengeResult('fight');
  const hero = HEROES[settings.hero] || {};
  return {
    ...r, heroName: hero.name || '', heroCls: [hero.cls, hero.element].filter(Boolean).join(' · '),
    art: chal.shot.has ? chal.shot.canvas : null,
    skeleton: chal.skeleton || (app.debug ? demoSkeleton() : null),   // в отладке с клавиатуры — поза-образец
    date: Date.now(),
  };
}
function setPosterUrl(url) {
  if (chal.posterUrl) { try { URL.revokeObjectURL(chal.posterUrl); } catch (e) { /* ignore */ } }
  chal.posterUrl = url || '';
}
// превью постера на экране итогов испытания
let posterSeq = 0;
function buildPosterPreview() {
  const seq = ++posterSeq;
  const data = posterData();
  posterFontsReady(document)
    .then(() => posterBlob(createPosterCanvas(document, data)))
    .then((b) => { if (seq === posterSeq && chal.result) { setPosterUrl(URL.createObjectURL(b)); renderUI(); } })
    .catch((e) => console.warn('[W3-CHALLENGE] постер', e));
}
Object.assign(callbacks, {
  // «Испытание · 60 с» из меню, с экрана итогов («Ещё раз») или по ?challenge
  onChallenge() {
    unlockAudio();
    if (pvpCtl && pvpCtl.active) return;
    chal.session.arm();
    if (app.debug || trackingReady()) { startFight(); return; }   // камера уже откалибрована (повтор) или клавиатура
    setScreen('camera');                                           // дальше сами: камера, калибровка, сразу бой (без обучения)
    if (QUICK) { app.onb.autoEnabled = true; enableCamera(); }
  },
  onChallengeName(arg) {
    const id = arg && arg.id, name = arg && arg.name;
    if (!chal.result || chal.result.entryId !== id || !chal.hall.rename(id, name)) return;
    const e = chal.hall.all().find((x) => x.id === id);
    chal.result = { ...chal.result, name: e ? e.name : '', named: true, place: chal.hall.placeOf(id) || chal.result.place };
    refreshHall();
    cue('ui_ok');
    buildPosterPreview();   // имя — и на постере
    renderUI();
  },
  // «Сохранить картинку» (испытание) и «Сохранить постер» (обычный бой): PNG 1200×630
  onPosterSave() {
    const data = posterData();
    return posterFontsReady(document).then(() => posterBlob(createPosterCanvas(document, data))).then((b) => {
      const name = posterFileName(data);
      downloadPoster(document, b, name);
      flashRecNote(`Постер сохранён: ${name}`);
    }).catch((e) => { console.warn('[W3-CHALLENGE] постер', e); flashRecNote('Постер не сохранился — попробуйте ещё раз'); });
  },
});

const _proj = new THREE.Vector3();
function projectToScreen(p) {
  _proj.set(p.x, p.y, p.z).project(camera);
  return { x: (_proj.x + 1) * 0.5 * viewW(), y: (1 - _proj.y) * 0.5 * viewH(), behind: _proj.z > 1 };
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
  screenAudio(app.screen);
  voiceSettings(); // [W3-VOICE]
  if (vision) vision.configure({ sensitivity: settings.sensitivity, moveMode: settings.moveMode, gestureMode: settings.gestureMode });
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
  if (app.debug || !vision) { trackingHud.clear(); drawCoachOverlay(now, null, null); return; }
  // [ПРОЕКТОР] режим рисунка задаёт слот камеры ui.js (data-hud-mode: панель презентации — 'full'), иначе — экран
  const forced = overlay.parentNode && overlay.parentNode.getAttribute ? overlay.parentNode.getAttribute('data-hud-mode') : null;
  const mode = forced === 'full' || forced === 'mini' ? forced : app.screen === 'playing' ? 'mini' : 'full';
  let hands = null, pose = null;
  try { hands = vision.getHands(); pose = vision.getPose(); } catch (e) { /* ignore */ }
  trackingHud.draw(now, { pose, status: visionStatus(), input, settings, mode, hands });
  if (handFx && handZone && handCombatOn()) { try { handFx.draw(now, { ...handZone.overlay(now), pose, settings, mode }); } catch (e) { /* [HAND] оверлей не критичен */ } } // [HAND]
  drawCoachOverlay(now, hands, pose, mode);
}
// [ТВИСТ «ОШИБКА»] подсказка в бою и на обучении — на превью камеры
function drawCoachOverlay(now, hands, pose, mode) {
  if (!coachOverlay) return;
  try {
    if (app.screen === 'technique' && techView) {
      // тренажёр: точки условий жеста; в демо — синтетическая кисть/поза вместо камеры
      const demo = techView.demo;
      coachOverlay.draw(now, { hands: demo ? techView.synthHands : hands, pose: demo ? techView.synthPose : pose, marks: techView.marks, skeleton: demo, mode: 'full', reducedMotion: settings.reducedMotion });
      return;
    }
    const show = app.screen === 'playing' || app.screen === 'tutorial';
    coachOverlay.draw(now, { hands, pose, hint: show ? getActiveHint(now) : null, mode: mode || (app.screen === 'playing' ? 'mini' : 'full'), reducedMotion: settings.reducedMotion });
  } catch (e) { /* не критично */ }
}

// ---------------------------------------------------------------- UI
function renderUI() {
  uiRoot.classList.toggle('ao-intro', app.screen === 'intro' || !!ULT.cine);   // [W3-ULT] на время сцены DOM-HUD прячется
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
    technique: app.screen === 'technique' ? techView : null,
    voice: voiceView(), // [W3-VOICE] «Голос тренера»: включён ли и найден ли русский голос
    coach: app.screen === 'victory' || app.screen === 'defeat' ? (coachEnd || coachStats.summary()) : null, // [ТВИСТ «ОШИБКА»] итог, сравнение с прошлым боем
    challenge: { result: app.screen === 'challenge' ? chal.result : null, hall: chal.hallView.list, best: chal.hallView.best, posterUrl: chal.posterUrl }, // [W3-CHALLENGE]
    // [ONBOARD] причина на кнопках «В бой»/«Продолжить бой»; отсчёт автопродолжения; калибровка из сохранения
    gate: { ok: app.gate.ok, reason: app.gate.reason },
    autoResumeMs: app.autoResume ? Math.max(0, app.autoResume.at - performance.now()) : null,
    onboard: { quick: QUICK, restored: app.onb.restored, demo: DEMO,
      starting: app.screen === 'camera' && app.onb.autoEnabled && !app.error && (!vision || visionStatus().status === 'idle') }, // камера уже запрошена
  });
}
// [W3-SQUAT] модель позы и частота распознавания — для подготовки и диагностики
function squatPoseInfo() {
  const v = visionStatus(), d = v && v.debug;
  return { model: d ? d.poseModel : null, switching: !!(d && d.poseSwitching), hz: d ? d.inferenceHz : null, recFrames: poseRec.size(), status: v ? v.status : 'idle' };
}
// [W3-SQUAT] F3: строки о приседаниях (на экране тренировки)
const VIS_RU = [[11, 12, 'плечи'], [23, 24, 'бёдра'], [25, 26, 'колени'], [27, 28, 'лодыжки']];
function squatHudLines() {
  if (app.screen !== 'training' || train.exercise !== 'squats') return null;
  const q = squats.read(), d = q.diag, L = q.lastRep;
  const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  return [
    `ПРИСЕДАНИЯ · ${d.mode === 'novice' ? 'Новичок' : 'Мастер'} · ${d.feet === false ? 'без стоп' : d.feet ? 'до стоп' : '—'}`,
    `Угол колена ${d.knee ?? '—'}° (сырой ${d.kneeRaw ?? '—'}°, бедро ${d.thighDeg ?? '—'}°, таз ${d.dropDeg ?? '—'}°) · глубина ≤ ${d.downDeg}° · фаза: ${d.phaseRu}`,
    'Видимость Л/П: ' + VIS_RU.map(([a, b, n]) => `${n} ${f(d.vis[a])}/${f(d.vis[b])}`).join(' · '),
    `Повторов ${q.reps} из ${q.attempts} · чистых ${q.clean}` + (L ? ` · последний: ${L.ok ? (L.clean ? 'чисто' : 'засчитан') : 'не засчитан'}${L.reason ? ' — ' + L.reason : ''} (${L.minKnee}°, ${L.ms} мс)` : ''),
    `Кадр: ${q.framing.statusText || q.framing.tip.text} · запись позы ${Math.round(poseRec.size() / Math.max(1, d.hz || 30))} с (F8)`,
  ];
}
function trainingView() {
  if (train.exercise === 'squats') {
    const q = squats.read();
    return {
      exercise: 'squats', debugSim: app.debug, reps: train.reps, attempts: q.attempts, state: q.phase, message: q.message,
      depth: q.depth, knee: q.knee, view: q.view, lastOk: q.lastRep ? q.lastRep.ok : null,
      sinceRepMs: performance.now() - train.lastRepAt, lastHint: q.lastHint,
      sinceHintMs: q.lastHint ? performance.now() - train.hintAt : null,
      faults: q.faults, formScore: q.formScore, topFault: topSquatFault(q.faults, q.mode),
      // [W3-SQUAT] режим, очки подхода, последний засчитанный повтор, подготовка (кадр), диагностика, модель позы
      mode: q.mode, clean: q.clean, points: train.points, downDeg: q.downDeg, feet: q.feet,
      lastRep: q.lastRep, lastEvent: train.lastRep, framing: q.framing, diag: q.diag,
      pose: squatPoseInfo(),
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
window.addEventListener('keydown', (e) => { if (e.code === 'F8' && !e.repeat) { e.preventDefault(); if (app.screen === 'training') savePoseRecording(); else saveRecording(); } }); // [W3-SQUAT] на тренировке — поза
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
// [FEEL] правила — core/gameFeel.js (прежние стоп-кадры и замедление идеального рывка сохранены там же):
// сильные удары по Регенту — остановка кадра 60–90 мс, парирование — замедление 0,3 с, тряска камеры по
// силе урона. «Уменьшенное движение»: без тряски, остановка кадра короче.
const timeFx = { slowUntil: 0, slowScale: 0.3, slowMs: 650, stopUntil: 0 };
function timeEvents(events, now) {
  if (!events.length) return;
  const f = feelOfEvents(events, { reducedMotion: !!settings.reducedMotion });
  if (f.stopMs > 0) timeFx.stopUntil = Math.max(timeFx.stopUntil, now + f.stopMs);
  if (f.slowMs > 0 && now + f.slowMs >= timeFx.slowUntil) { timeFx.slowUntil = now + f.slowMs; timeFx.slowMs = f.slowMs; timeFx.slowScale = f.slowScale; }
  if (f.shake > 0 && typeof rig.shake === 'function') rig.shake(f.shake);
}
function timeScale(now) {
  if (ULT.cine && app.screen === 'playing') return ultScale(now);   // [W3-ULT] замедление сцены
  if (now < timeFx.stopUntil) return 0.04;
  if (now < timeFx.slowUntil) {
    const left = (timeFx.slowUntil - now) / Math.max(1, timeFx.slowMs);
    return timeFx.slowScale + (1 - timeFx.slowScale) * Math.max(0, 1 - left * 1.6); // плавный выход
  }
  return 1;
}
// [FEEL] финал боя: последний удар замедлен, HUD пишет «ПОБЕДА» / «РЕГЕНТ УСТОЯЛ», потом — экран итогов.
const OUTRO = { victoryMs: 1700, defeatMs: 1200, victoryScale: 0.25, defeatScale: 0.45 };
OUTRO.victoryMs = 2600;   // [W3-КИНО] гибель Регента (modules/fx/bossFinale.js): перегрев 0,55 с, осколки, облёт камеры

// ---------------------------------------------------------------- [W3-ULT] «Небесный суд»
// Полная шкала «Ярость клятвы» (combat) → жест «обе руки над головой 0,8 с» по позе камеры (core/ultimate.js)
// или U в отладке → input.ultimate → бой начинает сцену (ultimate_start). Сцена здесь: время (бой — в реальном
// времени, мир и эффекты замедлены), облёт камеры (core/cameraRig.js cinematic), меч из света
// (modules/fx/ultimate.js), вспышка (postfx.pulse, если есть; иначе рывок экрана и вспышка HUD), звук, HUD.
const ULT = { gesture: createUltimateGesture(), g: null, fx: null, q: null, cine: null, flashByPost: false };
import('./modules/fx/ultimate.js').then((m) => {
  try {
    ULT.fx = m.createUltimateFx({ THREE, scene, camera, getKit: () => (effects && effects.v6 && effects.v6.enabled ? effects.v6.kit : null),
      groundY: worldLayout && typeof worldLayout.groundY === 'function' ? worldLayout.groundY : null, reducedMotion: () => !!settings.reducedMotion });
  } catch (e) { console.warn('[W3-ULT] эффект', e); ULT.fx = null; }
}).catch((e) => console.warn('[W3-ULT] modules/fx/ultimate.js', e && e.message));
// ?fury=100 — бой начинается с полной шкалой (показ «Небесного суда» на сцене сразу, QA)
const ULT_FURY0 = PERF_Q.has('fury') ? Math.max(0, Math.min(100, Number(PERF_Q.get('fury')) || 100)) : 0;
function ultReset() {
  if (ULT_FURY0 > 0 && typeof combat.setFury === 'function') { try { combat.setFury(ULT_FURY0); } catch (e) { /* ignore */ } }
  ULT.cine = null; ULT.g = null; ULT.gesture.reset();
  if (ULT.fx) { try { ULT.fx.reset(); } catch (e) { /* ignore */ } }
  if (typeof rig.stopCinematic === 'function') rig.stopCinematic();
}
function ultArmed() {
  const s = lastSnapshot;
  return !!(s && s.status === 'playing' && s.player && s.player.furyReady && !ULT.cine && !app.outroAt && !(pvpCtl && pvpCtl.active));
}
// Жест с камеры → импульс ultimate и подсказки «ОШИБКА» (до разбора подсказок в кадре)
function ultInput(input, now) {
  if (!input) return;
  if (ULT.cine) { input.hint = null; input.ultimate = false; return; }   // в сцене ввод не нужен
  if (app.debug || !vision || app.screen !== 'playing') { ULT.g = null; ULT.gesture.push(null, now, { armed: false }); return; }
  let pose = null;
  try { pose = vision.getPose(); } catch (e) { pose = null; }
  const g = ULT.gesture.push(pose, now, { armed: ultArmed() });
  ULT.g = g;
  if (g.fired) input.ultimate = true;
  // руки над головой: подсказки кистей («у края кадра» и т. п.) сейчас мешают — только свои
  if (g.phase === 'hold' || g.phase === 'fired' || g.phase === 'one') input.hint = null;
  if (g.hint) input.hint = { code: g.hint, side: g.side, guess: null, tMs: now };
}
function ultScale(now) {
  const c = ULT.cine;
  const v = ultTimeScale(c.t, c.dur, c.strikeAt, !!settings.reducedMotion);
  return now < timeFx.stopUntil ? Math.min(v, 0.04) : v;
}
function ultPostPulse(kind, pos) {
  if (!postfx || !postfx.enabled) return false;
  let x = 0.5, y = 0.5;
  if (pos) { _sunV.set(pos.x, pos.y || 0, pos.z).project(camera); if (_sunV.z < 1) { x = _sunV.x * 0.5 + 0.5; y = _sunV.y * 0.5 + 0.5; } }
  let ok = false;
  if (typeof postfx.pulse === 'function') { try { postfx.pulse(kind, { x, y, strength: 1 }); ok = true; } catch (e) { ok = false; } }
  if (kind === 'shockwave' && typeof postfx.punch === 'function') { try { postfx.punch(1, x, y); } catch (e) { /* ignore */ } }
  return ok;
}
// События боя этого кадра → старт сцены, удар
function ultEvents(events, now) {
  if (!events || !events.length) return;
  for (const e of events) {
    if (!e) continue;
    const d = e.data || {};
    if (e.type === 'ultimate_ready') cue('perfect');
    else if (e.type === 'ultimate_start') {
      const snap = lastSnapshot || combat.getSnapshot();
      const hero = snap.player.position, target = d.target || snap.boss.position;
      ULT.cine = { t: 0, dur: Number.isFinite(d.duration) ? d.duration : 3.6, strikeAt: Number.isFinite(d.strikeAt) ? d.strikeAt : 2.3,
        struck: false, amount: 0, pct: 0, target: { x: target.x, y: target.y, z: target.z } };
      ULT.flashByPost = false;
      if (typeof rig.cinematic === 'function') {
        const keys = settings.reducedMotion ? [] : ultCameraKeys({ p: hero, b: snap.boss.position, dur: ULT.cine.dur, strikeAt: ULT.cine.strikeAt,
          maxR: config.camera.maxRadiusFromCenter, ground: worldLayout ? worldLayout.groundY : null });
        if (keys.length) rig.cinematic(keys, { duration: ULT.cine.dur, blendOut: 0.6 });
      }
      if (ULT.fx) { try { ULT.fx.start({ target, hero, duration: ULT.cine.dur, strikeAt: ULT.cine.strikeAt }); } catch (err) { console.warn('[W3-ULT] fx.start', err); } }
      cue('rune_light'); cue('burst');
    } else if (e.type === 'ultimate_strike' && ULT.cine) {
      ULT.cine.struck = true;
      ULT.cine.amount = Number(d.amount) || 0;
      const mx = lastSnapshot && lastSnapshot.boss ? lastSnapshot.boss.maxHp : 0;
      ULT.cine.pct = mx > 0 ? (ULT.cine.amount / mx) * 100 : 0;
      if (!settings.reducedMotion) {
        if (typeof rig.shake === 'function') rig.shake(1);
        ULT.flashByPost = ultPostPulse('flash', e.position);
        ultPostPulse('shockwave', e.position);
      }
      cue('boss_slam'); cue('boss_nova'); cue('rune_storm');
    }
  }
}
// Время сцены: по бою (снимок), а если бой окончен ударом — по настенным часам до конца облёта
function ultTick(dtReal) {
  if (ULT.fx && ULT.q !== settings.quality) { ULT.q = settings.quality; try { ULT.fx.setQuality(settings.quality); } catch (e) { /* ignore */ } }
  const c = ULT.cine;
  if (!c) return;
  const su = lastSnapshot && lastSnapshot.ultimate;
  if (su && su.active) c.t = su.t;
  else if (app.screen === 'playing' || app.screen === 'intro') c.t += dtReal;
  if (c.t >= c.dur || (app.screen !== 'playing' && app.screen !== 'paused')) {
    ULT.cine = null;
    if (ULT.fx && app.screen !== 'playing') { try { ULT.fx.reset(); } catch (e) { /* ignore */ } }
  }
  if (ULT.fx) { try { ULT.fx.update(c.t, app.screen === 'paused' ? 0 : dtReal); } catch (e) { console.warn('[W3-ULT] fx.update', e); ULT.fx = null; } }
}
// В отладке (руки героя не повторяют руки игрока) на время сцены герой сам поднимает руки к небу
const ULT_ARMS_UP = { valid: true, left: { upper: { x: -0.32, y: -0.95 }, fore: { x: -0.1, y: -0.99 } }, right: { upper: { x: 0.32, y: -0.95 }, fore: { x: 0.1, y: -0.99 } }, lean: 0, depth: 0 };
function ultMirror(m) { return ULT.cine && !(m && m.valid) ? ULT_ARMS_UP : m; }
const _ultView = { fury: 0, furyMax: 100, ready: false, gesture: null, debug: false, flash: false, cine: null };   // один объект на кадр HUD
function ultView() {
  const s = lastSnapshot, P = s && s.player;
  if (!P || !Number.isFinite(P.fury)) return null;
  const v = _ultView;
  v.fury = P.fury; v.furyMax = P.furyMax; v.ready = !!P.furyReady; v.gesture = ULT.g; v.debug = app.debug; v.flash = ULT.flashByPost;
  v.cine = ULT.cine;   // { t, dur, strikeAt, struck, amount, pct } — HUD только читает
  return v;
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
  // «OK» и щит — удержания: удача — момент, когда жест распознан (а не каждый кадр удержания)
  const atk = !!input.attack, shd = !!input.shield;
  if (atk && !coachEdge.attack) coachStats.success('attack');
  if (shd && !coachEdge.shield) coachStats.success('shield');
  coachEdge.attack = atk; coachEdge.shield = shd;
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
  feedCinema(events);   // [W3-КИНО]
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

// [W3-КИНО] экранные события боя → postfx.pulse (core/cinemaFeed.js: волна, рывок, ранение, «Врата бури»,
// «Столп небес», удар ультимейта); цвет фаз — из атмосферы (atmosphere.look)
function feedCinema(events) {
  const atmo = world && world.atmosphere;
  if (typeof postfx.setLook === 'function') postfx.setLook(atmo && atmo.look ? atmo.look : null);
  if (cinema) { try { cinema.feed(events, lastSnapshot); } catch (e) { console.warn('[W3-КИНО] cinemaFeed', e); cinema = null; } }
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
const CALM_SCREENS = new Set(['menu', 'paused', 'camera', 'calibration', 'tutorial', 'oath', 'training', 'technique', 'victory', 'defeat', 'challenge']); // [W3-CHALLENGE] + challenge
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
  const dt = dtReal * ts * (bossFinale && app.screen === 'playing' ? bossFinale.timeScale() : 1);   // [W3-КИНО] сцена перехода в фазу 2

  const input = readInput();
  // [HAND] лук и магия рукой → input.bow / input.handSpell; конфликтующие жесты гасятся (C2)
  if (handZone) { try { handZone.apply(input, now, { debug: app.debug, playing: app.screen === 'playing', enabled: handCombatOn() }); } catch (e) { console.warn('[HAND] apply', e); } }
  try { ultInput(input, now); } catch (e) { console.warn('[W3-ULT] жест', e); }   // [W3-ULT] обе руки над головой → «Небесный суд»
  // [ТВИСТ «ОШИБКА»] код подсказки → жест и текст исправления (для HUD, обучения и итогов)
  if (input && input.hint && hintInfo(input.hint.code)) { input.hint = { ...input.hint, ...hintInfo(input.hint.code) }; noteHint(input.hint, now); }
  if (input && input.hint && (app.screen === 'tutorial' || app.screen === 'playing')) cue(sfxCues.hint(input.hint, now)); // [SFX] мягкий «тук»
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
    // [ONBOARD] пропуск в тот же кадр, что и «пробуждение», — переход на следующий кадр, чтобы world/effects получили событие
    if (I.t >= I.duration || (I.skip && events === NO_EVENTS)) { rig.reset(lastSnapshot.player.position, lastSnapshot.boss.position); readInput(); setScreen('playing'); } // из облёта — в lock-on, дальше камера сама перейдёт в explore
  }
  showIntroHint(QUICK && app.screen === 'intro');

  if (app.screen === 'playing') {
    let frozen = false;
    if (!app.debug && !app.outroAt) {   // [FEEL] в замедленном финале потеря трекинга не ставит паузу
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
    if (chal.session.frozen(now)) frozen = true;   // [W3-CHALLENGE] 3-2-1 и «ВРЕМЯ ВЫШЛО»
    if (app.screen === 'playing' && !frozen && !app.outroAt) trackCoach(input);   // [FEEL] после исхода жесты не считаются
    if (app.screen === 'playing' && dt > 0 && !frozen) {
      // [ASHEN_V2] стик — в осях камеры: «вперёд на стике» = «вперёд на экране»
      if (Number.isFinite(rig.inputYaw)) input.viewYaw = rig.inputYaw;   // [V3] курс управления без плечевого сдвига
      else if (Number.isFinite(rig.yaw)) input.viewYaw = rig.yaw;
      input.moveMode = settings.moveMode;   // [V5] «Руль»: moveX — поворот героя, moveZ — вперёд по его курсу
      // [НОВИЧОК] combat гасит импульсы выключенных жестов и ведёт героя сам (автоход); клавиатура и дуэль — как раньше
      input.gestureMode = app.debug ? 'master' : settings.gestureMode;
      input.autoWalk = settings.autoWalk !== false && !app.debug && !(pvpCtl && pvpCtl.active);
      let inputC = input;
      if (pvpCtl && pvpCtl.active) { try { inputC = pvpCtl.beforeUpdate(input); } catch (e) { console.error('[PVP] beforeUpdate', e); } } // [PVP] фазы раунда, оглушение, соперник
      try { combat.update(ULT.cine ? dtReal : dt, inputC); } catch (e) { console.error('[ASHEN] combat.update', e); }   // [W3-ULT] сцена идёт по настенным часам, замедлен только мир
    }
    events = adaptEvents(combat.drainEvents());
    if (pvpCtl && pvpCtl.active) { try { events = pvpCtl.afterUpdate(events); } catch (e) { console.error('[PVP] afterUpdate', e); } } // [PVP] сеть, раунды
    timeEvents(events, now);
    lastSnapshot = combat.getSnapshot();
    try { ultEvents(events, now); } catch (e) { console.warn('[W3-ULT] события', e); }   // [W3-ULT]
    events = checkEmbers(lastSnapshot, events);
    events = forestZoneEvents(events, lastSnapshot);   // [FOREST]
    challengeFrame(now, events);                       // [W3-CHALLENGE] очки, таймер, момент удара
    if (lastSnapshot.status === 'victory' || lastSnapshot.status === 'defeat') finishCoach();   // [ТВИСТ «ОШИБКА»] итог — в историю (один раз; жесты финала уже не считаются)
    if (lastSnapshot.status === 'victory' || lastSnapshot.status === 'defeat') {
      // [FEEL] экран итогов — после замедленного финала (в дуэли и при «Уменьшенном движении» — короче)
      const win = lastSnapshot.status === 'victory';
      const hold = pvpCtl && pvpCtl.active ? 0 : (win ? OUTRO.victoryMs : OUTRO.defeatMs) * (settings.reducedMotion ? 0.6 : 1);
      if (!app.outroAt) {
        app.outroAt = now;
        if (hold > 0) { timeFx.slowUntil = now + hold; timeFx.slowMs = hold; timeFx.slowScale = win ? OUTRO.victoryScale : OUTRO.defeatScale; }
      }
      if (now - app.outroAt >= hold) { app.outroAt = 0; setScreen(challengeRoute(win)); }   // [W3-CHALLENGE] испытание → свои итоги
    }
  }

  // [ASHEN_V2] тренировка: поза → счётчик отжиманий → очки клятвы
  if (app.screen === 'training') { try { trainPoseTick(); } catch (e) { console.warn('[W3-SQUAT] модель позы', e); } } else if (trainPose.active) trainPoseTick();
  if (app.screen === 'training' && train.exercise === 'squats') {
    if (squats.config.mode !== squatMode()) resetTraining();   // [W3-SQUAT] сменили режим «Новичок»/«Мастер»
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
      poseRec.add(pose);   // [W3-SQUAT] F8 — сохранить для разбора
    }
    const got = squats.drain();
    if (got.length) {
      // [W3-SQUAT] очки события: 1 за повтор, в «Новичке» чистый — 2
      const pts = got.reduce((a, g) => a + (Number.isFinite(g.points) ? g.points : 1), 0);
      train.reps += got.length; train.lastRepAt = now; train.points += pts; train.clean += got.filter((g) => g.clean !== false).length;
      train.lastRep = got[got.length - 1];
      progression.addSquats(got.length, pts - got.length);
    }
    const hint = squats.read().lastHint;
    if (hint && hint !== train.hintRef) { train.hintRef = hint; train.hintAt = now; }
  } else if (app.screen === 'training' && vision) {
    let pose = null;
    try { pose = vision.getPose(); } catch (e) { pose = null; }
    if (pose && pose.tMs !== train.lastPoseT) {
      train.lastPoseT = pose.tMs;
      pushups.push({ tMs: pose.tMs, landmarks: pose.landmarks, frameW: pose.frameW, frameH: pose.frameH });
      poseRec.add(pose);   // [W3-SQUAT] запись позы и для отжиманий (F8)
    }
    const got = pushups.drain();
    if (got.length) { train.reps += got.length; train.lastRepAt = now; progression.addPushups(got.length); }
  }

  // [ТВИСТ «ОШИБКА»] тренажёр техники: условия из распознавателя (vision → handGestures.checks), поза — счётчикам
  if (app.screen === 'technique') {
    let live = null;
    // пока камера и модель включаются (несколько секунд) — демо, чтобы твист был виден сразу
    const vst = vision ? visionStatus().status : 'idle';
    trainer.setAuto(!app.debug && !(vst === 'ready' || vst === 'lost' || vst === 'calibrating'));
    if (!app.debug && vision) {
      try {
        const vs = visionStatus();
        const hg = vs && vs.debug && vs.debug.handGestures;
        live = { checks: hg && hg.checks ? hg.checks : null, hands: vision.getHands(), pose: vision.getPose() };
      } catch (e) { live = null; }
    }
    try { techView = trainer.frame(now, live); } catch (e) { console.warn('[ASHEN] тренажёр', e); techView = null; }
  } else techView = null;

  if (app.screen === 'paused' && !app.debug && vision) {
    const vs = visionStatus();
    if (vs.status === 'error' || vs.status === 'idle') { app.resumableFight = true; app.resumableReason = app.pauseReason || 'tracking'; setScreen('camera'); }   // [ONBOARD] причина паузы — после переподключения
  }
  // [ONBOARD] экран камеры ведёт сам, пауза «Трекинг потерян» снимается сама, причина недоступности кнопок
  try { onboardTick(now); autoResumeTick(now); gateTick(now); } catch (e) { console.warn('[ONBOARD]', e); }

  if (typeof world.setMirror === 'function') {
    try { world.setMirror(ultMirror(app.debug ? null : mirrorFromPose(input, now))); } catch (e) { /* ignore */ }   // [W3-ULT] в сцене руки к небу
  }
  // [HERO] руки VRM-героя повторяют руки игрока; C5: поза лука и чар рукой из ввода C2
  if (heroModel && heroModel.setMirror) { try { heroModel.setMirror(ultMirror(app.debug ? null : mirrorFromPose(input, now))); if (app.screen !== 'menu') heroModel.setPose(heroPoseFromInput(input)); } catch (e) { /* ignore */ } }
  // [NET] соперник: отправка st/ev/pr, его модель; его события (data.remote=true) и снаряды — в эффекты.
  // world и heroModel получают только свои события: иначе свой герой повторял бы чужие удары.
  let fxEvents = events, fxSnap = lastSnapshot;
  if (netSession) { try { const r = netSession.frame(dtReal, now, lastSnapshot, input, events, app.screen); fxEvents = r.events; fxSnap = r.snapshot; } catch (e) { console.warn('[NET] frame', e); } }
  try { world.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] world.update', e); }
  if (heroModel) { try { heroModel.update(dt, lastSnapshot, events); } catch (e) { console.error('[ASHEN] heroModel.update', e); } }
  if (effects.setInput) effects.setInput(input); // [VFX] след руны в воздухе, свечение ладоней
  if (heroBowPose) { try { heroBowPose.update(dt, { root: world.hero && world.hero.root, heroModel, snap: lastSnapshot }); } catch (e) { /* [HAND] */ } } // [HAND] поза лука/ладони
  try { effects.update(dt, fxSnap, fxEvents); } catch (e) { console.error('[ASHEN] effects.update', e); } // [NET] fxSnap/fxEvents
  if (bossFinale) { try { bossFinale.update(dt, dtReal, lastSnapshot, events); } catch (e) { console.warn('[W3-КИНО] финал', e); bossFinale = null; } }   // [W3-КИНО]
  if (effects.takeHitStop && app.screen === 'playing') { const hs = Math.min(effects.takeHitStop(), settings.reducedMotion ? FEEL_TIME.reducedStopMaxMs : Infinity); if (hs > 0) timeFx.stopUntil = Math.max(timeFx.stopUntil, now + hs); } // [VFX] хит-стоп по силе удара; [FEEL] «Уменьшенное движение» — не дольше 40 мс
  if (handVisuals && effects.linkHandVisuals) effects.linkHandVisuals(handVisuals); // [VFX] стрелы/сгустки/попадания — V6, лук — №6
  if (handVisuals) { try { handVisuals.update(dt, fxSnap, fxEvents, handAnchors()); } catch (e) { /* [HAND] */ } } // [HAND] (fxSnap — со стрелами соперника)

  try { ultTick(dtReal); } catch (e) { console.warn('[W3-ULT] сцена', e); }   // [W3-ULT] время сцены и меч из света
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
    if (bossFinale) bossFinale.applyCamera(camera, dtReal);   // [W3-КИНО] наезд на Регента / облёт места гибели
  }

  if (spirit) spirit.frame(dtReal, now, { screen: app.screen, debug: app.debug, vision, status: vision ? visionStatus() : null, input, events, snapshot: lastSnapshot, hero: heroModel ? heroModel.hero : settings.hero }); // [W3-SPIRIT]
  if (heroShowcase) { try { heroShowcase.update(dtReal, app.screen === 'menu', camera); } catch (e) { console.warn('[HERO] витрина', e); heroShowcase = null; } } // [HERO] свет и облёт витрины
  if (pvpCtl) { try { pvpCtl.frame(lastSnapshot, app.screen); } catch (e) { console.error('[PVP] frame', e); } } // [PVP] фазы хоста, готовность, панель
  if (postfx && typeof postfx.setMode === 'function') { try { postfx.setMode(app.screen, settings); } catch (e) { /* ignore */ } } // [BDO] DOF меню и грейд по экрану
  if (postfx) feedPostFx(events);   // [W3-КИНО] и на low: цвет фаз, ранение, засветка
  let rendered = false;
  if (perfTuner) perfTuner.gpuBegin();
  if (postfx) { try { postfx.render(dtReal); rendered = true; } catch (e) { console.warn('[ASHEN] postfx.render', e); postfx = null; } }   // [W3-КИНО] на low — обычный кадр + наложение
  if (!rendered) renderer.render(scene, camera);
  if (perfTuner) perfTuner.gpuEnd();
  if (chal.shot.want) grabShot();   // [W3-CHALLENGE] кадр боя в момент удара (до показа буфера)
  renderUI();
  challengeHud(now);                // [W3-CHALLENGE] таймер и очки над боем
  drawTracking(now, input);
  cursorTick(now);   // [W3-CURSOR]
  battleHud.frame({
    dtReal, timeScale: ts, screen: app.screen, snapshot: lastSnapshot, events, input: app.debug ? null : input,
    project: projectToScreen, viewport: { w: viewW(), h: viewH() },
    intro: { active: app.screen === 'intro', t: app.intro.t, duration: app.intro.duration },
    settings, resumeLeftMs: app.screen === 'playing' ? Math.max(0, app.resumeAt - now) : 0,
    pois: unlitEmbers(),
    coach: coachView(input),
    layout: worldLayout, // [BDO] мини-карта и названия зон
    ult: ultView(),      // [W3-ULT] шкала «Ярость клятвы», зов, сцена
  });
  voiceFrame(now, input, events); // [W3-VOICE] подсказки и реплики — вслух

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
  if (perfHud && perfHud.visible) { try { perfHud.update(now, { perf: perfTuner ? perfTuner.state() : null, tracking: vision ? visionStatus() : null, screen: app.screen, extra: squatHudLines }); } catch (e) { /* ignore */ } }
}

applySettings();
resize();
if (settings.startZone !== 'arena') { try { resetFight(); } catch (e) { console.warn('[ASHEN] startZone', e); } }   // [FOREST] в меню герой у врат леса; [ONBOARD] у края арены
// [ONBOARD] ?demo — живая презентация: без меню сразу экран камеры (камера и калибровка — сами), затем бой
if (DEMO && !CHALLENGE_Q) { setScreen('camera'); app.onb.autoEnabled = true; enableCamera(); }
if (CHALLENGE_Q) callbacks.onChallenge({ from: 'url' });   // [W3-CHALLENGE] ?challenge — сразу испытание
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
  kino: () => { try { return JSON.parse(JSON.stringify({ storm: world.atmosphere.storm, look: world.atmosphere.look, fx: postfx ? postfx.info().fx : null, cinema: cinema ? cinema.debug() : null, finale: bossFinale ? bossFinale.debug() : null })); } catch (e) { return null; } },   // [W3-КИНО] QA: гроза, импульсы, сцены
  get resumeGraceLeft() { return Math.max(0, app.resumeAt - performance.now()); },
  snapshot: () => (lastSnapshot ? JSON.parse(JSON.stringify(lastSnapshot)) : null),
  canvasCount: () => document.querySelectorAll('canvas#ao-canvas').length,
  worldAssets: () => (world && world.assets ? world.assets : null),
  progress: () => progression.getView(),
  pushups: () => pushups.getDebug(),
  coach: () => coachStats.summary(),
  coachEnd: () => (coachEnd ? JSON.parse(JSON.stringify(coachEnd)) : null), // [ТВИСТ «ОШИБКА»] итог боя со сравнением
  activeHint: () => { const a = getActiveHint(); return a ? { ...a, pictogram: a.pictogram ? a.pictogram.length : 0 } : null; },
  hero: () => (heroModel ? heroModel.state() : null),
  heroShowcase: () => (heroShowcase ? { weight: heroShowcase.weight, zoom: +heroShowcase.zoom.toFixed(2), lights: heroShowcase.group.children.filter((o) => o.isLight).map((l) => [l.name, +l.intensity.toFixed(1)]) } : null), // [HERO] QA
  heroAnchors: () => { if (!heroModel || !heroModel.getAnchors) return null; const a = heroModel.getAnchors(), v = new THREE.Vector3(); return Object.fromEntries(Object.entries(a).map(([k, o]) => { o.getWorldPosition(v); return [k, { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3), attached: !!o.parent }]; })); }, // [HERO] C5
  net: () => (netSession ? netSession.debug() : null),             // [NET]
  netSession: () => netSession,                                    // [NET] для тестов и №3
  hand: () => (handZone ? handZone.getDebug() : null), // [HAND] лук и магия рукой
  challenge: () => ({ phase: chal.session.phase, left: chal.session.timeLeft(), live: { ...chal.live }, seed: bossBrain.challenge, result: chal.result ? JSON.parse(JSON.stringify(chal.result)) : null, hall: chal.hallView.list.map((e) => ({ ...e })), poster: !!chal.posterUrl, shot: chal.shot.has, skeleton: !!chal.skeleton }), // [W3-CHALLENGE] QA
  challengeFinish: () => chal.session.finishNow(), // [W3-CHALLENGE] QA: конец минуты на следующем кадре (в headless бой почти стоит)
  cursor: () => (handCursor ? handCursor.getDebug() : null), // [W3-CURSOR] курсор-кисть: видимость, цель, удержание, клики
  fx: () => { try { return JSON.parse(JSON.stringify(effects.getDebugInfo())); } catch (e) { return null; } }, // [VFX] QA: частицы и слой V6
  fxLayer: () => (effects && effects.v6) || null, // [W3-МАГИЯ] QA: слой V6 (события магий и подмена заряда для видео)
  heroStep: (dt, snap, events) => { if (heroModel) heroModel.update(dt, snap, events || []); return heroModel ? heroModel.state() : null; }, // QA: шаг анимации без rAF
  squats: () => squats.getDebug(),
  voice: () => (voiceCoach ? voiceCoach.status() : null), // [W3-VOICE] голос, очередь, последние фразы
  technique: () => (techView ? JSON.parse(JSON.stringify({ ...techView, synthHands: null, synthPose: null, focus: techView.focus ? { ...techView.focus, pictogram: !!techView.focus.pictogram } : null })) : null), // [ТВИСТ «ОШИБКА»] QA тренажёра
  pvp: () => (pvpCtl ? pvpCtl.debug() : null),   // [PVP] QA: фаза, счёт, статистика дуэли
  ult: () => ({ cine: ULT.cine ? { ...ULT.cine } : null, gesture: ULT.g ? { ...ULT.g } : null, rig: !!rig.cinematicActive, fx: !!(ULT.fx && ULT.fx.active) }),   // [W3-ULT] QA
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
