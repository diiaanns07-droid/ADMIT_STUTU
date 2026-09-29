// ASHEN OATH — общая конфигурация сборки. Владелец: №1 (сборщик).
// Все версии закреплены. Three.js подключается ОДИН раз через importmap в index.html;
// версия там обязана совпадать с DEPS.three.version (main.js проверяет THREE.REVISION).
//
// Разделы читают модули:
//   combat  → modules/combat.js (№4; пустой объект = баланс по умолчанию №4)
//   boss    → modules/boss.js   (№5; seed задаёт main.js при старте страницы)
//   vision  → modules/vision.js (№2; неизвестные ключи игнорируются)
//   world   → modules/world.js  (№3)
//   effects → modules/effects.js (№6)
//   settings — ЖИВОЙ объект настроек игрока; main.js мутирует его на месте,
//              world/effects читают reducedMotion/quality оттуда.

export const API_VERSION = 'ASHEN_V1';

export const DEPS = {
  three: {
    version: '0.185.1',
    revision: '185',
    moduleUrl: 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.js',
    license: 'MIT',
  },
  // 0.10.35 выбрана сознательно: бандл 1.0.x содержит отправку метрик использования
  // на odml.pa.googleapis.com/v1/log, что противоречит требованию «без аналитики».
  mediaPipe: {
    version: '0.10.35',
    moduleUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs',
    wasmRoot: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    handModelUrl: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    license: 'Apache-2.0',
  },
};

// Параметры рендера, которыми владеет main.js (тени и детали — у world/effects).
export const QUALITY_PRESETS = {
  low:    { pixelRatioCap: 1.0 },
  medium: { pixelRatioCap: 1.5 },
  high:   { pixelRatioCap: 2.0 },
};

export const config = {
  apiVersion: API_VERSION,

  loop: {
    maxDt: 1 / 20,           // визуальный dt режется; combat сам режет до 0.1 и шагает по 1/120
    stallSec: 0.25,          // кадр длиннее — разрыв (свёрнутая вкладка): бой не продвигаем
  },

  camera: {
    fov: 58,
    distance: 4.9,           // позади героя
    minDistance: 4.0,
    maxDistance: 5.8,
    height: 2.75,            // выше плеча: герой в нижней трети, босс над ним
    shoulderOffset: 1.35,    // камера над правым плечом → герой левее центра
    lookShoulder: 0.35,      // доля сдвига, перенесённая на точку взгляда
    lookHeightPlayer: 1.2,
    lookHeightBoss: 2.8,
    lookBias: 0.6,           // точка взгляда: 0 = герой, 1 = босс
    angleSharpness: 7,       // сглаживание орбитального угла (1/с)
    distSharpness: 3,
    maxRadiusFromCenter: 11.6, // не заходить за ступени и кольцо руин (r≈17+)
    maxImpulse: 0.12,
  },

  tracking: {
    // Отсчёт идёт от момента, когда vision перестал видеть плечи (debug.bodyVisible=false)
    // или ввод стал невалидным. vision сам ждёт lostGraceMs=700 мс до valid=false —
    // поэтому бой замораживаем раньше, чтобы потеря камеры не приводила к урону.
    freezeSec: 0.12,         // бой перестаёт продвигаться (враг не бьёт), ввод уже отпущен
    lostPauseSec: 0.8,       // экран паузы «Трекинг потерян» (позже lostGraceMs=700 у vision, чтобы UI
                             // сразу видел статус lost, а не «восстановлен»); продолжение — только кнопкой
    resumeGraceSec: 1.0,     // после «Продолжить бой» враг ещё столько стоит (успеть опустить руки)
  },

  combat: {},

  boss: {
    seed: 20260928,          // main.js заменяет на случайный при загрузке страницы
  },

  vision: {
    sensitivity: 1,
    mirror: true,            // превью зеркалится CSS (только <video>)
    overlay: false,          // overlay рисует core/trackingHud.js (main.js), а не vision
    hands: true,             // «Перстни»: MediaPipe HandLandmarker, жесты пальцев
    mediaPipe: {
      moduleUrl: DEPS.mediaPipe.moduleUrl,
      wasmRoot: DEPS.mediaPipe.wasmRoot,
      modelUrl: DEPS.mediaPipe.modelUrl,
      handModelUrl: DEPS.mediaPipe.handModelUrl,
    },
  },

  world: {
    manageFog: true,
    manageShadowMap: true,   // world включает renderer.shadowMap; тени на Low гасит castShadow
    ambientAsh: true,
  },

  effects: {},

  // Звук временно выключен по просьбе владельца: AudioContext не создаётся, ползунок громкости скрыт.
  // Включить обратно: enabled: true.
  audio: { enabled: false },

  defaultSettings: {
    quality: 'medium',
    volume: 0.6,
    reducedMotion: false,
    sensitivity: 1.0,
    // [V5] схема движения левой рукой: 'steer' — «Руль» (высота руки — ход, в сторону — поворот),
    // 'stick' — прежний джойстик (поднять руку и замереть — центр)
    moveMode: 'steer',
    hero: 'ashen',          // выбранный герой: ashen | warrior | elf (modules/heroModel.js)
    fxMagic: true,          // [VFX] эффекты V6 (modules/fx): false — прежние эффекты effects.js
    bdoUi: true,            // [BDO] интерфейс в стиле Black Desert (false — прежний вид)
  },

  settings: null,            // заполняет main.js (живой объект)
  qualityPresets: QUALITY_PRESETS,
};
