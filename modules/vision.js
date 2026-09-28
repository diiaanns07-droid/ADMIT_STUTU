/*
 * ASHEN OATH — vision.js
 * API_VERSION=ASHEN_V1 · роль №2: CV-контроллер сидящего игрока.
 *
 * Поток: webcam (только видео) → MediaPipe Pose Landmarker (module worker; если он не
 * прошёл самопроверку — главный поток с ограничением частоты) → интерпретатор поз →
 * InputFrame. Видеокадры обрабатываются локально: не отправляются, не записываются.
 * По сети загружаются только библиотека, WASM и модель — URL берутся из config.mediaPipe.
 *
 * Файл состоит из двух частей:
 *  1) createPoseInterpreter — чистая логика без DOM (калибровка, стрейф, рывок, руки,
 *     политика ненадёжного ввода). Тестируется на искусственных landmarks в Node.
 *  2) createVision — браузерная оболочка по контракту ASHEN_V1.
 */

export const API_VERSION = 'ASHEN_V2';

// [№1, «Перстни»] жесты пальцев: чистая логика, тесты в dev/handGestures*.test.mjs
import { createHandGestures } from '../core/handGestures.js';

// Версия проверена по реестру npm 28.09.2026 (см. отчёт в 02_HANDOFF.txt).
// Главный сборщик может передать свои URL через config.mediaPipe — тогда эти не используются.
// [№1, интеграция] 0.10.35 вместо 1.0.1: бандл 1.0.x отправляет метрики на odml.pa.googleapis.com/v1/log.
export const MEDIAPIPE_VERSION = '0.10.35';
export const DEFAULT_MEDIAPIPE = Object.freeze({
  moduleUrl: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
  wasmRoot: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  // [№1] модель кистей (21 точка на кисть); та же версия WASM/библиотеки
  handModelUrl: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
});

// Индексы MediaPipe Pose (33 точки). «Левое/правое» — стороны самого человека.
export const LANDMARK = Object.freeze({
  NOSE: 0, LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14, LEFT_WRIST: 15, RIGHT_WRIST: 16,
});
// Компактная передача из worker: только нужные точки, по 4 числа (x, y, z, visibility).
// [ASHEN_V2] + уши (7, 8), бёдра, колени, щиколотки (23–28): для режима отжиманий (modules/training.js).
export const COMPACT_INDICES = Object.freeze([0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);
export const COMPACT_STRIDE = 4;

/*
 * Все пороги — НАЧАЛЬНЫЕ значения для настройки на реальной камере, не измеренные истины.
 * Единицы: «sw» = ширина плеч по калибровке (в 2D-кадре), время — мс performance.now().
 * Скорости в sw/с — это экранные единицы, а не метры в секунду.
 */
export const DEFAULT_VISION_CONFIG = Object.freeze({
  // [ASHEN_V2] Корпус больше не двигает героя: движение — левая рука-джойстик (core/leftStick.js),
  // рывок — дёрг левой рукой. true возвращает прежний стрейф/сближение/рывок корпусом (для тестов и отката).
  torsoMove: false,
  // Маппинг
  mirror: true,            // true: наклон игрока к СВОЕЙ правой стороне → moveX>0 (как в зеркальном превью)
  swapHands: false,        // для камер/драйверов, которые сами зеркалят поток
  sensitivity: 1,          // 0.5..2 из UI; делит пороги стрейфа и рывка
  // Стрейф (sw)
  deadZone: 0.06,
  minDeadZone: 0.02,
  noiseDeadZoneK: 3,       // мёртвая зона не меньше K·σ шума калибровки
  moveFull: 0.24,          // отклонение, при котором |moveX| = 1
  moveCurve: 1.3,          // степень кривой отклика после мёртвой зоны
  moveTauMs: 70,           // постоянная времени сглаживания для moveX
  fastTauMs: 30,           // лёгкое сглаживание для детектора рывка
  // Глубина (moveZ): наклон к камере/от камеры. Сигнал — ширина плеч относительно калибровки
  // (шире = ближе = вперёд), плюс ограниченная добавка от опускания носа к линии плеч.
  // Пороги делятся на sensitivity, как у стрейфа. Начальные значения, на живом игроке не подобраны.
  depthDeadZone: 0.055,    // |ширина/калибровка − 1| меньше — нейтраль
  minDepthDeadZone: 0.025,
  noiseDepthK: 2,          // мёртвая зона не меньше K·(относительный шум ширины за калибровку, до фильтра)
  depthFull: 0.17,         // при этом отклонении |moveZ| = 1
  depthCurve: 1.2,
  depthTauMs: 110,         // EMA по реальному dt (ширина шумнее центра плеч)
  depthSpikeAbs: 0.12,     // скачок ширины за кадр больше этого (+ depthSpikeSpeed·dt) ждёт подтверждения
  depthSpikeSpeed: 1.0,    // доли ширины в секунду
  depthNoseWeight: 0.2,    // вес смещения носа (sw); 0 — только ширина плеч
  depthNoseCap: 0.6,       // вклад носа ≤ 0.6·мёртвой зоны: кивок (взгляд на руки) сам героя не двигает
  depthLateralComp: true,  // стрейф считается с поправкой на перспективу: наклон вперёд не сносит вбок
  // Защита от выбросов
  spikeAbs: 0.25,          // допустимый скачок за кадр (sw) + spikeSpeed·dt
  spikeSpeed: 3.0,         // sw/с
  gapResetMs: 220,         // разрыв данных плеч дольше этого — сброс истории движения
  // Рывок
  dashAmplitude: 0.28,     // амплитуда от нейтрали (sw)
  dashMinOverDeadZone: 0.10,
  noiseDashK: 6,
  dashMaxMs: 320,          // за сколько мс от выхода из нейтрали нужно набрать амплитуду
  dashMinSpeed: 1.1,       // средняя экранная скорость (sw/с)
  dashMinSamples: 2,       // минимум качественных измерений вне нейтрали
  rearmNeutralMs: 160,     // устойчивая нейтраль для повторного взвода
  // Руки (подъём запястья над линией плеча, в sw; вверх — положительно)
  minShoulderConf: 0.5,
  minArmConf: 0.5,
  raiseOn: -0.10,          // запястье не ниже 0.10 sw под линией плеча
  raiseHysteresis: 0.20,
  raiseAboveRest: 0.45,    // и минимум на 0.45 sw выше естественной высоты руки (если она известна)
  forearmUp: 0.05,         // запястье выше локтя (если локоть виден)
  forearmHysteresis: 0.10,
  noElbowExtra: 0.15,      // локоть не виден — порог по запястью строже
  armTauMs: 50,
  singleHoldMs: 120,       // короткое удержание одиночной руки
  pairWindowMs: 160,       // окно согласования двух рук
  burstHoldMs: 380,        // удержание обеих рук для burst
  armsDownRearmMs: 100,    // обе руки опущены — взвод burst и одиночных жестов
  // Надёжность
  useVisibility: 'auto',   // 'auto' | 'always' | 'never'
  visibilityZeroFrames: 30,
  inFrameMargin: 0.02,
  minShoulderWidth: 0.05,  // в долях высоты кадра
  // Ширина плеч относительно калибровки — вне полосы плечи недостоверны («сядьте ближе/дальше»).
  // Полоса заведомо шире рабочего диапазона moveZ (±depthFull, не больше ±0.3 при любой
  // чувствительности), поэтому полный наклон вперёд/назад не считается потерей.
  widthRatioMin: 0.55,
  widthRatioMax: 1.8,
  staleMs: 250,            // кадр старше — удержания и moveX отпускаются
  lostGraceMs: 700,        // плеч нет дольше — valid=false, статус lost
  pulseTtlMs: 300,         // непрочитанный импульс dash/burst сгорает
  // Калибровка
  calibrationMs: 1500,
  // Порог по числу кадров — для слабых ноутбуков: при позе+кистях инференс бывает ~6 Гц
  // (≈9 кадров за 1,5 с), поэтому 12 кадров там не набиралось никогда, и калибровка падала по таймауту.
  calibrationMinSamples: 6,
  calibrationMaxSpread: 0.05,
  calibrationMaxWidthSpread: 0.06,
  calibrationGapMs: 700,   // было 300: на 6 Гц одиночная задержка кадра сбрасывала накопленное
  calibrationTimeoutMs: 25000,
  minNoise: 0.004,
  // Движок и производительность
  useWorker: 'auto',       // 'auto' | 'off' (или false)
  workerUrl: null,         // по умолчанию ./vision-worker.js рядом с vision.js
  workerInitTimeoutMs: 30000, // без сообщений от worker дольше — откат в главный поток
  workerFrameTimeoutMs: 2500,
  delegate: 'GPU',         // 'GPU' (с откатом на CPU) | 'CPU'
  maxInferenceHz: 30,
  fallbackMaxHz: 15,       // главный поток: не чаще
  fallbackMaxLoad: 0.35,   // главный поток: inference занимает не больше этой доли времени
  captureMaxWidth: 640,
  rvfcStarveMs: 600,
  videoReadyTimeoutMs: 10000,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  // Прочее
  overlay: false,
  overlayMirror: null,     // null = как mirror (overlay совпадает с CSS-зеркальным превью)
  // [№1, «Перстни»] кисти и пальцы
  hands: true,             // false — только поза (как раньше)
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minHandTrackingConfidence: 0.5,
  handGestures: Object.freeze({}), // патч DEFAULT_HAND_CONFIG
  camera: Object.freeze({ width: 640, height: 480, frameRate: 30, deviceId: null }),
  mediaPipe: DEFAULT_MEDIAPIPE,
});

// ───────────────────────────── утилиты ─────────────────────────────

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r3 = (v) => (finite(v) ? Math.round(v * 1000) / 1000 : null);
const r1 = (v) => (finite(v) ? Math.round(v * 10) / 10 : null);
const nowMs = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
  ? performance.now() : Date.now());

function emaAlpha(dtMs, tauMs) {
  if (!(tauMs > 0)) return 1;
  if (!(dtMs > 0)) return 0;
  return 1 - Math.exp(-dtMs / tauMs);
}
function median(values) {
  const a = values.filter(finite).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  const m = n >> 1;
  return n % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
function mad(values, med) { return median(values.map((v) => Math.abs(v - med))); }
function emaValue(prev, value, k) { return finite(prev) ? prev + k * (value - prev) : value; }
function visionError(code, message, cause) {
  const e = new Error(message);
  e.code = code;
  if (cause !== undefined) e.cause = cause;
  return e;
}

export function mergeVisionConfig(base, patch) {
  const out = {};
  for (const k of Object.keys(base)) {
    const v = base[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : v;
  }
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    if (!(k in DEFAULT_VISION_CONFIG)) continue; // неизвестные ключи (quality, volume…) игнорируются
    const v = patch[k];
    const d = DEFAULT_VISION_CONFIG[k];
    if (v === undefined) continue;
    if (d && typeof d === 'object') { if (v && typeof v === 'object') out[k] = { ...out[k], ...v }; }
    else if (typeof d === 'number') { if (finite(v)) out[k] = v; }
    else if (typeof d === 'boolean') out[k] = !!v;
    else out[k] = v;
  }
  out.sensitivity = clamp(finite(out.sensitivity) ? out.sensitivity : 1, 0.25, 4);
  return out;
}

export function unpackCompactLandmarks(arr) {
  if (!arr || arr.length < COMPACT_INDICES.length * COMPACT_STRIDE) return null;
  const out = new Array(33).fill(null);
  for (let k = 0; k < COMPACT_INDICES.length; k++) {
    const o = k * COMPACT_STRIDE;
    out[COMPACT_INDICES[k]] = { x: arr[o], y: arr[o + 1], z: arr[o + 2], visibility: arr[o + 3] };
  }
  return out;
}
function copyLandmarks(pose) {
  if (!pose || pose.length <= LANDMARK.RIGHT_WRIST) return null;
  const out = new Array(33).fill(null);
  for (const i of COMPACT_INDICES) {
    const p = pose[i];
    if (p) out[i] = { x: p.x, y: p.y, z: p.z, visibility: p.visibility };
  }
  return out;
}

// ─────────────────────── 1. интерпретатор поз ───────────────────────

export function createPoseInterpreter(configPatch = {}) {
  let cfg = mergeVisionConfig(DEFAULT_VISION_CONFIG, configPatch);
  let derived = null;
  let baseline = null;
  let frame = { w: 0, h: 0 };
  let active = true;
  let calib = null;
  let lat = null;
  let dash = null;
  let lastDash = null;
  let lastResetReason = 'init';
  const arms = { left: newArm(), right: newArm() };
  const gest = { attack: false, shield: false, state: 'idle', blocked: true, blockReason: 'start', burstLatched: true, downSince: null };
  const pulses = { dash: null, burst: null };
  const track = {
    lastObsT: null, lastBodyOkT: null, shouldersOk: false, conf: 0, confT: null,
    visZeroStreak: 0, visibilityUnavailable: false, scaleWarning: null, recoveredAt: null, calibrationInvalid: null,
  };
  const counters = { observations: 0, rejectedSpikes: 0, rejectedDepthSpikes: 0, discontinuities: 0, resets: 0, dashes: 0, bursts: 0, reacquired: 0 };
  const lastLateral = { raw: null, moveX: 0 };
  // Глубина: отсечка одиночных выбросов ширины → EMA.
  let dep = null;
  const lastDepth = { raw: null, widthRatio: null, nose: null, moveZ: 0 };

  function newArm() {
    return { visible: false, rise: null, lastT: null, raised: false, since: null, forearm: null, threshold: null };
  }

  function recompute() {
    const s = cfg.sensitivity;
    const noise = baseline ? baseline.noise : 0;
    const dead = Math.max(cfg.deadZone / s, cfg.noiseDeadZoneK * noise, cfg.minDeadZone);
    const full = Math.max(cfg.moveFull / s, dead + 0.06);
    const amp = Math.max(cfg.dashAmplitude / s, dead + cfg.dashMinOverDeadZone, cfg.noiseDashK * noise);
    // Глубина: верх диапазона ограничен (≤ 0.3), чтобы полный ход всегда был внутри полосы
    // widthRatioMin/Max и не превращался в «потерю плеч».
    const wNoise = baseline && finite(baseline.widthNoise) ? baseline.widthNoise : 0;
    const dDead = Math.min(0.2, Math.max(cfg.depthDeadZone / s, cfg.noiseDepthK * wNoise, cfg.minDepthDeadZone));
    const dFull = Math.max(dDead + 0.05, Math.min(cfg.depthFull / s, 0.3));
    derived = {
      sensitivity: s, deadZone: dead, moveFull: full, dashAmplitude: amp, dashMinSpeed: cfg.dashMinSpeed / s,
      depthDeadZone: dDead, depthFull: dFull,
    };
  }

  function resetMotion(reason) {
    lat = { has: false, gT: 0, gX: 0, pending: null, fast: null, slow: null, lastT: null };
    dash = { state: 'disarmed', reason, neutralSince: null, anchor: null, samples: 0 };
    dep = { gT: null, gX: 0, pending: null, slow: null, lastT: null };
    lastDepth.moveZ = 0;
    lastLateral.moveX = 0;
    pulses.dash = null;
    counters.resets++;
    lastResetReason = reason;
  }

  function blockGestures(reason) {
    gest.blocked = true;
    gest.blockReason = reason;
    gest.burstLatched = true;
    gest.attack = false;
    gest.shield = false;
    gest.downSince = null;
    pulses.burst = null;
  }

  function sideIdx(side) {
    const useRightLandmarks = cfg.swapHands ? side !== 'right' : side === 'right';
    return useRightLandmarks
      ? { s: LANDMARK.RIGHT_SHOULDER, e: LANDMARK.RIGHT_ELBOW, w: LANDMARK.RIGHT_WRIST }
      : { s: LANDMARK.LEFT_SHOULDER, e: LANDMARK.LEFT_ELBOW, w: LANDMARK.LEFT_WRIST };
  }

  function useVisibility() {
    if (cfg.useVisibility === 'never') return false;
    if (cfg.useVisibility === 'always') return true;
    return !track.visibilityUnavailable;
  }

  // Точка в единицах высоты кадра: X = x·(W/H), Y = y. c — достоверность 0..1.
  function readPoint(lms, i, aspect, useVis) {
    const p = lms ? lms[i] : null;
    if (!p || !finite(p.x) || !finite(p.y)) return null;
    const m = cfg.inFrameMargin;
    let c = p.x >= -m && p.x <= 1 + m && p.y >= -m && p.y <= 1 + m ? 1 : 0;
    if (useVis) {
      if (finite(p.visibility)) c = Math.min(c, p.visibility);
      if (finite(p.presence)) c = Math.min(c, p.presence);
    }
    return { X: p.x * aspect, Y: p.y, c };
  }

  // Если модель не заполняет visibility (все нули), доверие только к геометрии кадра.
  function updateVisibilityHeuristic(lms) {
    if (!lms) return;
    let seen = 0;
    let zeros = 0;
    for (let k = 1; k < COMPACT_INDICES.length; k++) {
      const p = lms[COMPACT_INDICES[k]];
      if (p) { seen++; if (p.visibility === 0) zeros++; }
    }
    if (!seen) return;
    if (zeros === seen) {
      track.visZeroStreak++;
      if (track.visZeroStreak >= cfg.visibilityZeroFrames) track.visibilityUnavailable = true;
    } else {
      track.visZeroStreak = 0;
      track.visibilityUnavailable = false;
    }
  }

  function onFrameSize(w, h) {
    const had = frame.w > 0 && frame.h > 0;
    frame = { w, h };
    if (had) resetMotion('frame-size');
    if (baseline && Math.abs(w / h - baseline.aspect) / baseline.aspect > 0.02) {
      baseline = null;
      track.calibrationInvalid = 'aspect';
      recompute();
      blockGestures('frame-size');
    }
  }

  // Защита от выбросов: одиночный скачок откладывается и отбрасывается, если следующий
  // кадр его не подтвердил. Подтверждённый большой скачок = разрыв (перезахват трекера),
  // он переинициализирует фильтры и никогда не превращается в рывок.
  function gateSample(t, raw) {
    const out = [];
    if (!lat.has) {
      lat.has = true; lat.gT = t; lat.gX = raw;
      out.push({ t, x: raw, disc: true });
      return out;
    }
    if (lat.pending) {
      const p = lat.pending;
      lat.pending = null;
      const allowP = cfg.spikeAbs + cfg.spikeSpeed * Math.max(0, t - p.t) / 1000;
      if (Math.abs(raw - p.x) <= allowP) {
        counters.discontinuities++;
        lat.gT = t; lat.gX = raw;
        out.push({ t: p.t, x: p.x, disc: true });
        out.push({ t, x: raw, disc: false });
        return out;
      }
      counters.rejectedSpikes++;
    }
    const allow = cfg.spikeAbs + cfg.spikeSpeed * Math.max(0, t - lat.gT) / 1000;
    if (Math.abs(raw - lat.gX) > allow) {
      lat.pending = { t, x: raw };
      return out;
    }
    lat.gT = t; lat.gX = raw;
    out.push({ t, x: raw, disc: false });
    return out;
  }

  function feedLateral(t, raw) {
    for (const s of gateSample(t, raw)) {
      if (s.disc || lat.fast === null) {
        lat.fast = s.x; lat.slow = s.x; lat.lastT = s.t;
        dash.state = 'disarmed'; dash.reason = 'discontinuity'; dash.neutralSince = null; dash.samples = 0;
      } else {
        const dt = s.t - lat.lastT;
        lat.lastT = s.t;
        lat.fast += emaAlpha(dt, cfg.fastTauMs) * (s.x - lat.fast);
        lat.slow += emaAlpha(dt, cfg.moveTauMs) * (s.x - lat.slow);
      }
      dashStep(s.t, lat.fast);
    }
  }

  // Латч рывка: disarmed → (нейтраль) rearming → (нейтраль rearmNeutralMs) armed →
  // (быстрый выход с амплитудой) импульс → disarmed. Возврат к центру проходит через
  // нейтраль слишком коротко для взвода, поэтому не даёт противоположного рывка.
  function dashStep(t, x) {
    const d = derived;
    const inNeutral = Math.abs(x) <= d.deadZone;
    if (dash.state === 'disarmed') {
      if (inNeutral) { dash.state = 'rearming'; dash.neutralSince = t; }
      return;
    }
    if (dash.state === 'rearming') {
      if (!inNeutral) { dash.state = 'disarmed'; dash.neutralSince = null; return; }
      if (t - dash.neutralSince >= cfg.rearmNeutralMs) {
        dash.state = 'armed'; dash.reason = 'neutral'; dash.anchor = { t, x }; dash.samples = 0;
      }
      return;
    }
    // armed
    if (inNeutral) { dash.anchor = { t, x }; dash.samples = 0; return; }
    dash.samples++;
    const dir = x > 0 ? 1 : -1;
    // Амплитуда — от калиброванной нейтрали (не зависит от того, в какой точке мёртвой
    // зоны пришёлся последний нейтральный кадр); скорость — от этого кадра.
    const amp = x * dir;
    const elapsed = t - dash.anchor.t;
    if (elapsed > cfg.dashMaxMs) { dash.state = 'disarmed'; dash.reason = 'slow-lean'; return; }
    const speed = elapsed > 0 ? (((x - dash.anchor.x) * dir) / elapsed) * 1000 : 0;
    if (amp >= d.dashAmplitude && dash.samples >= cfg.dashMinSamples && speed >= d.dashMinSpeed) {
      pulses.dash = { value: dir, tMs: t };
      lastDash = { dir, tMs: t, amp: r3(amp), elapsedMs: r1(elapsed), speed: r3(speed) };
      counters.dashes++;
      dash.state = 'disarmed';
      dash.reason = 'fired';
    }
  }

  function computeMove(x) {
    const d = derived;
    const ax = Math.abs(x);
    if (!finite(x) || ax <= d.deadZone) return 0;
    const u = clamp((ax - d.deadZone) / (d.moveFull - d.deadZone), 0, 1);
    return Math.sign(x) * Math.pow(u, cfg.moveCurve);
  }

  function computeDepth(x) {
    const d = derived;
    const ax = Math.abs(x);
    if (!finite(x) || ax <= d.depthDeadZone) return 0;
    const u = clamp((ax - d.depthDeadZone) / (d.depthFull - d.depthDeadZone), 0, 1);
    return Math.sign(x) * Math.pow(u, cfg.depthCurve);
  }

  // raw: + = ближе к камере (вперёд). Отсечка выбросов как у стрейфа (большой скачок ждёт
  // подтверждения следующим кадром, обычное движение проходит без задержки), затем EMA по dt.
  function acceptDepth(t, x) {
    dep.gT = t; dep.gX = x;
    if (dep.slow === null || dep.lastT === null) dep.slow = x;
    else dep.slow += emaAlpha(t - dep.lastT, cfg.depthTauMs) * (x - dep.slow);
    dep.lastT = t;
    lastDepth.moveZ = computeDepth(dep.slow);
  }
  function feedDepth(t, raw) {
    if (dep.gT === null) { acceptDepth(t, raw); return; }
    if (dep.pending) {
      const p = dep.pending;
      dep.pending = null;
      if (Math.abs(raw - p.x) <= cfg.depthSpikeAbs + cfg.depthSpikeSpeed * Math.max(0, t - p.t) / 1000) {
        acceptDepth(p.t, p.x); // подтверждённый быстрый наклон: сглаживание не сбрасывается
        acceptDepth(t, raw);
        return;
      }
      counters.rejectedDepthSpikes++;
    }
    if (Math.abs(raw - dep.gX) > cfg.depthSpikeAbs + cfg.depthSpikeSpeed * Math.max(0, t - dep.gT) / 1000) {
      dep.pending = { t, x: raw }; // moveZ держит прежнее значение один кадр
      return;
    }
    acceptDepth(t, raw);
  }

  // Сырой сигнал глубины для текущего кадра (в долях калиброванной ширины плеч).
  function depthSample(width, cy, lms, aspect, useVis) {
    const ratio = width / baseline.width;
    let raw = ratio - 1;
    let nose = null;
    if (cfg.depthNoseWeight > 0 && finite(baseline.noseGap)) {
      const N = readPoint(lms, LANDMARK.NOSE, aspect, useVis);
      if (N && N.c >= cfg.minShoulderConf) {
        // Наклон вперёд: голова опускается к линии плеч сильнее, чем сами плечи → зазор меньше.
        const gap = (cy - N.Y) / width;
        const cap = cfg.depthNoseCap * derived.depthDeadZone;
        nose = clamp((baseline.noseGap - gap) * cfg.depthNoseWeight, -cap, cap);
        raw += nose;
      }
    }
    lastDepth.widthRatio = ratio;
    lastDepth.nose = nose;
    lastDepth.raw = raw;
    return raw;
  }

  function wristRise(lms, idx, aspect, useVis, S, ref) {
    const W = readPoint(lms, idx.w, aspect, useVis);
    if (!S || !W || W.c < cfg.minArmConf || !(ref > 0)) return null;
    return (S.Y - W.Y) / ref;
  }

  function updateArm(side, t, lms, idx, aspect, useVis, ref) {
    const a = arms[side];
    const S = readPoint(lms, idx.s, aspect, useVis);
    const W = readPoint(lms, idx.w, aspect, useVis);
    const E = readPoint(lms, idx.e, aspect, useVis);
    const ok = S && W && S.c >= cfg.minShoulderConf && W.c >= cfg.minArmConf && ref > 0;
    if (!ok) { Object.assign(a, newArm()); return; } // не продолжаем заклинание по старым данным
    const rise = (S.Y - W.Y) / ref;
    a.rise = a.lastT === null ? rise : a.rise + emaAlpha(t - a.lastT, cfg.armTauMs) * (rise - a.rise);
    a.lastT = t;
    a.visible = true;
    const rest = baseline ? baseline.restRise[side] : null;
    let on = cfg.raiseOn;
    if (finite(rest)) on = Math.max(on, rest + cfg.raiseAboveRest);
    const elbowOk = !!E && E.c >= cfg.minArmConf;
    if (!elbowOk) on += cfg.noElbowExtra;
    const off = on - cfg.raiseHysteresis;
    a.forearm = elbowOk ? (E.Y - W.Y) / ref : null;
    const foreOn = !elbowOk || a.forearm >= cfg.forearmUp;
    const foreOff = !elbowOk || a.forearm >= cfg.forearmUp - cfg.forearmHysteresis;
    const raised = a.raised ? a.rise >= off && foreOff : a.rise >= on && foreOn;
    if (raised && !a.raised) a.since = t;
    if (!raised) a.since = null;
    a.raised = raised;
    a.threshold = on;
  }

  // Арбитраж: обе руки → burst (разово) → щит → атака. Одиночное действие ждёт
  // max(singleHoldMs, pairWindowMs), чтобы подъём двух рук не дал сначала выстрел.
  // Любой эпизод «обе руки» блокирует одиночные жесты до опускания обеих рук.
  function updateGesture(t) {
    const R = arms.right;
    const L = arms.left;
    const rUp = R.raised && R.since !== null;
    const lUp = L.raised && L.since !== null;
    if (!R.raised && !L.raised) {
      if (gest.downSince === null) gest.downSince = t;
      if (gest.blocked && t - gest.downSince >= cfg.armsDownRearmMs) {
        gest.blocked = false; gest.blockReason = null; gest.burstLatched = false;
      }
    } else {
      gest.downSince = null;
    }
    gest.attack = false;
    gest.shield = false;
    if (rUp && lUp) {
      const bothSince = Math.max(R.since, L.since);
      if (!gest.blocked) { gest.blocked = true; gest.blockReason = 'pair'; }
      if (gest.burstLatched) gest.state = 'burst-latched';
      else if (t - bothSince >= cfg.burstHoldMs) {
        pulses.burst = { value: true, tMs: t };
        counters.bursts++;
        gest.burstLatched = true;
        gest.state = 'burst';
      } else gest.state = 'pair-pending';
      return;
    }
    if (gest.blocked) { gest.state = rUp || lUp ? 'blocked' : 'rearming'; return; }
    const singleDelay = Math.max(cfg.singleHoldMs, cfg.pairWindowMs);
    if (lUp && t - L.since >= singleDelay) { gest.shield = true; gest.state = 'shield'; }
    else if (rUp && t - R.since >= singleDelay) { gest.attack = true; gest.state = 'attack'; }
    else gest.state = rUp || lUp ? 'single-pending' : 'idle';
  }

  function calibStep(t, shOk, cx, cy, width, lms, aspect, useVis, rsP, lsP) {
    const c = calib;
    if (t - c.startT > cfg.calibrationTimeoutMs) { failCalibration(calibrationTimeoutMessage()); return; }
    const gapTooLong = c.lastGoodT !== null && t - c.lastGoodT > cfg.calibrationGapMs;
    if (gapTooLong) c.samples.length = 0;
    if (!shOk) {
      c.hint = 'Не видно обоих плеч — сядьте так, чтобы плечи были в кадре';
      c.progress = calibrationProgress(t);
      return;
    }
    const riseR = wristRise(lms, sideIdx('right'), aspect, useVis, rsP, width);
    const riseL = wristRise(lms, sideIdx('left'), aspect, useVis, lsP, width);
    if ((riseR !== null && riseR > cfg.raiseOn) || (riseL !== null && riseL > cfg.raiseOn)) {
      c.hint = 'Опустите руки и сидите ровно';
      return;
    }
    c.lastGoodT = t;
    const N = readPoint(lms, LANDMARK.NOSE, aspect, useVis);
    const gap = N && N.c >= cfg.minShoulderConf && width > 0 ? (cy - N.Y) / width : null;
    c.samples.push({ t, cx, cy, w: width, riseR, riseL, gap });
    // Самое короткое окно, покрывающее calibrationMs (устойчиво к дробному шагу кадров).
    while (c.samples.length > 1 && t - c.samples[1].t >= cfg.calibrationMs) c.samples.shift();
    c.progress = calibrationProgress(t);
    c.hint = 'Сидите спокойно…';
    const dur = t - c.samples[0].t;
    if (dur < cfg.calibrationMs * 0.95 || c.samples.length < cfg.calibrationMinSamples) return;
    const ws = c.samples.map((s) => s.w);
    const medW = median(ws);
    const xs = c.samples.map((s) => s.cx);
    const medX = median(xs);
    const spread = (1.4826 * mad(xs, medX)) / medW;
    const wSpread = (1.4826 * mad(ws, medW)) / medW;
    if (spread <= cfg.calibrationMaxSpread && wSpread <= cfg.calibrationMaxWidthSpread) {
      const n = c.samples.length;
      const restOf = (key) => {
        const v = c.samples.map((s) => s[key]).filter(finite);
        return v.length >= Math.max(3, 0.3 * n) ? median(v) : null;
      };
      baseline = {
        cx: medX, cy: median(c.samples.map((s) => s.cy)), width: medW,
        aspect: frame.w > 0 && frame.h > 0 ? frame.w / frame.h : 4 / 3,
        frameW: frame.w, frameH: frame.h,
        noise: Math.max(cfg.minNoise, spread),
        widthNoise: Math.max(cfg.minNoise, wSpread), // относительный шум ширины плеч (для moveZ)
        noseGap: restOf('gap'),                      // (линия плеч − нос) / ширина, sw; null — нос не виден
        restRise: { right: restOf('riseR'), left: restOf('riseL') },
        samples: n, tMs: t,
      };
      recompute();
      resetMotion('calibrated');
      blockGestures('calibrated');
      c.result = 'done'; c.progress = 1; c.hint = 'Калибровка завершена'; c.message = c.hint;
    } else {
      c.hint = 'Слишком много движения — посидите неподвижно';
      c.samples.splice(0, Math.ceil(c.samples.length / 2));
      c.progress = calibrationProgress(t);
    }
  }
  function calibrationProgress(t) {
    const c = calib;
    if (!c || !c.samples.length) return 0;
    return clamp((t - c.samples[0].t) / cfg.calibrationMs, 0, 0.99);
  }
  function calibrationTimeoutMessage() {
    return 'Калибровка не удалась: сядьте ровно, чтобы плечи были видны, опустите руки и повторите';
  }
  function failCalibration(message) {
    if (!calib || calib.result) return;
    calib.result = 'failed';
    calib.message = message;
    calib.hint = message;
  }

  function pushObservation(obs) {
    if (!obs || !finite(obs.tMs)) return false;
    const t = obs.tMs;
    if (track.lastObsT !== null && t <= track.lastObsT) return false; // дубль или старый кадр
    counters.observations++;
    const fw = obs.frameW | 0;
    const fh = obs.frameH | 0;
    if (fw > 0 && fh > 0 && (fw !== frame.w || fh !== frame.h)) onFrameSize(fw, fh);
    track.lastObsT = t;
    const aspect = frame.w > 0 && frame.h > 0 ? frame.w / frame.h : 4 / 3;
    const lms = Array.isArray(obs.landmarks) && obs.landmarks.length ? obs.landmarks : null;
    updateVisibilityHeuristic(lms);
    const useVis = useVisibility();
    const R = sideIdx('right');
    const L = sideIdx('left');
    const rsP = readPoint(lms, R.s, aspect, useVis);
    const lsP = readPoint(lms, L.s, aspect, useVis);

    let shOk = !!(rsP && lsP) && Math.min(rsP.c, lsP.c) >= cfg.minShoulderConf;
    let cx = 0;
    let cy = 0;
    let width = 0;
    track.scaleWarning = null;
    if (shOk) {
      cx = (rsP.X + lsP.X) / 2;
      cy = (rsP.Y + lsP.Y) / 2;
      width = Math.hypot(lsP.X - rsP.X, lsP.Y - rsP.Y);
      if (!(width >= cfg.minShoulderWidth)) shOk = false;
    }
    const shOkForCalibration = shOk;
    if (shOk && baseline) {
      const ratio = width / baseline.width;
      if (ratio < cfg.widthRatioMin || ratio > cfg.widthRatioMax) {
        shOk = false;
        track.scaleWarning = ratio < 1 ? 'far' : 'near';
      }
    }

    if (calib && !calib.result) calibStep(t, shOkForCalibration, cx, cy, width, lms, aspect, useVis, rsP, lsP);

    if (shOk) {
      const first = track.lastBodyOkT === null;
      const gap = first ? Infinity : t - track.lastBodyOkT;
      const wasLost = !first && gap > cfg.lostGraceMs;
      if (first || wasLost || gap > cfg.gapResetMs) {
        resetMotion(first ? 'acquired' : wasLost ? 'reacquired' : 'gap');
        if (first) blockGestures('acquired');
        if (wasLost) { blockGestures('reacquired'); track.recoveredAt = t; counters.reacquired++; }
      }
      track.lastBodyOkT = t;
      const c = Math.min(rsP.c, lsP.c);
      track.conf = track.confT === null ? c : track.conf + emaAlpha(t - track.confT, 200) * (c - track.conf);
      track.confT = t;
    } else {
      if (dash.state === 'armed' && dash.samples > 0) { dash.state = 'disarmed'; dash.reason = 'dropout'; }
      lat.pending = null;
    }
    track.shouldersOk = shOk;

    if (shOk && baseline) {
      const sign = cfg.mirror ? -1 : 1; // в несзеркаленном кадре собственная правая сторона игрока — слева
      let raw;
      if (cfg.depthLateralComp) {
        // Камера-обскура: смещение от оптической оси (≈ центр кадра) растёт пропорционально
        // близости, как и ширина плеч. Нормируя на ТЕКУЩУЮ ширину, получаем боковой наклон
        // в долях ширины тела, не зависящий от наклона вперёд: сидящий сбоку от камеры игрок,
        // наклоняясь к ней, не «уезжает» вбок. При той же ширине совпадает с прежней формулой.
        const c0 = aspect / 2;
        raw = sign * ((cx - c0) / width - (baseline.cx - c0) / baseline.width);
      } else {
        raw = (sign * (cx - baseline.cx)) / baseline.width;
      }
      lastLateral.raw = raw;
      feedLateral(t, raw);
      lastLateral.moveX = computeMove(lat.slow);
      feedDepth(t, depthSample(width, cy, lms, aspect, useVis));
    } else {
      lastLateral.raw = null;
      lastLateral.moveX = 0; // плечи недостоверны — движение отпускается сразу
      lastDepth.raw = null; lastDepth.widthRatio = null; lastDepth.nose = null;
      lastDepth.moveZ = 0;   // и по глубине тоже
      dep.pending = null;
    }

    const ref = baseline ? baseline.width : width;
    updateArm('right', t, lms, R, aspect, useVis, ref);
    updateArm('left', t, lms, L, aspect, useVis, ref);
    updateGesture(t);
    return true;
  }

  function isLost(now) {
    return track.lastBodyOkT === null || now - track.lastBodyOkT > cfg.lostGraceMs;
  }

  function peek(now = nowMs()) {
    const calibrated = !!baseline;
    const calibrating = !!(calib && !calib.result);
    const valid = active && calibrated && !calibrating && !isLost(now);
    const tMs = track.lastObsT === null ? now : track.lastObsT;
    const source = active ? 'cv' : 'none';
    // conjure/throw приходят от кистей (createVision.read); поза сама их не порождает.
    if (!valid) {
      return { source, valid: false, calibrated, tMs, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, conjure: null, throw: null };
    }
    const fresh = now - track.lastObsT <= cfg.staleMs;
    const torso = cfg.torsoMove === true;
    const moveX = torso && fresh && track.shouldersOk ? lastLateral.moveX : 0;
    const moveZ = torso && fresh && track.shouldersOk ? lastDepth.moveZ : 0;
    const dashV = torso && pulses.dash && now - pulses.dash.tMs <= cfg.pulseTtlMs ? pulses.dash.value : 0;
    const burst = !!(pulses.burst && now - pulses.burst.tMs <= cfg.pulseTtlMs);
    return {
      source, valid: true, calibrated, tMs, moveX, moveZ, dash: dashV,
      attack: fresh && gest.attack, shield: fresh && gest.shield, burst, conjure: null, throw: null,
    };
  }

  function read(now = nowMs()) {
    const f = peek(now);
    pulses.dash = null; // импульсы потребляются, даже если истекли или ввод невалиден
    pulses.burst = null;
    return f;
  }

  function getTracking(now = nowMs()) {
    const fresh = track.lastObsT !== null && now - track.lastObsT <= cfg.staleMs;
    const lost = isLost(now);
    let confidence = 0;
    if (!lost) confidence = clamp(track.conf * (track.shouldersOk && fresh ? 1 : 0.5), 0, 1);
    return {
      active, calibrated: !!baseline, calibrating: !!(calib && !calib.result),
      bodyVisible: track.shouldersOk && fresh, fresh, lost, confidence,
      frameAgeMs: track.lastObsT === null ? null : now - track.lastObsT,
      scaleWarning: track.scaleWarning, recoveredAt: track.recoveredAt,
      calibrationInvalid: track.calibrationInvalid,
    };
  }

  function armDebug(a, now) {
    return {
      visible: a.visible, rise: r3(a.rise), forearm: r3(a.forearm), threshold: r3(a.threshold),
      raised: a.raised, heldMs: a.since === null ? 0 : r1(now - a.since),
    };
  }

  function getDebug(now = nowMs()) {
    const d = derived;
    return {
      torsoMove: cfg.torsoMove === true,
      baseline: baseline ? {
        centerX: r3(baseline.cx / baseline.aspect), centerY: r3(baseline.cy),
        shoulderWidth: r3(baseline.width), noise: r3(baseline.noise),
        restRiseLeft: r3(baseline.restRise.left), restRiseRight: r3(baseline.restRise.right),
        frameW: baseline.frameW, frameH: baseline.frameH, samples: baseline.samples,
        widthNoise: r3(baseline.widthNoise), noseGap: r3(baseline.noseGap),
      } : null,
      lateral: { raw: r3(lastLateral.raw), fast: r3(lat.fast), filtered: r3(lat.slow), moveX: r3(lastLateral.moveX) },
      // + = ближе к камере (наклон вперёд → герой идёт к стражу)
      depth: {
        raw: r3(lastDepth.raw), widthRatio: r3(lastDepth.widthRatio), nose: r3(lastDepth.nose),
        filtered: r3(dep.slow), moveZ: r3(lastDepth.moveZ),
      },
      thresholds: {
        depthDeadZone: r3(d.depthDeadZone), depthFull: r3(d.depthFull),
        widthRatioMin: cfg.widthRatioMin, widthRatioMax: cfg.widthRatioMax,
        sensitivity: r3(d.sensitivity), deadZone: r3(d.deadZone), moveFull: r3(d.moveFull),
        dashAmplitude: r3(d.dashAmplitude), dashMaxMs: cfg.dashMaxMs, dashMinSpeed: r3(d.dashMinSpeed),
        rearmNeutralMs: cfg.rearmNeutralMs, singleDelayMs: Math.max(cfg.singleHoldMs, cfg.pairWindowMs),
        burstHoldMs: cfg.burstHoldMs,
      },
      dash: { state: dash.state, reason: dash.reason, armed: dash.state === 'armed', excursionSamples: dash.samples, lastDash },
      arms: { left: armDebug(arms.left, now), right: armDebug(arms.right, now) },
      gesture: {
        state: gest.state, attack: gest.attack, shield: gest.shield,
        blocked: gest.blocked, blockReason: gest.blockReason, burstLatched: gest.burstLatched,
      },
      reliability: {
        shouldersOk: track.shouldersOk, visibilityUnavailable: track.visibilityUnavailable,
        scaleWarning: track.scaleWarning, lastResetReason, calibrationInvalid: track.calibrationInvalid,
      },
      counters: { ...counters },
    };
  }

  function configure(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    const prevMirror = cfg.mirror;
    const prevSwap = cfg.swapHands;
    cfg = mergeVisionConfig(cfg, patch);
    recompute();
    if (cfg.mirror !== prevMirror) resetMotion('mirror');
    if (cfg.swapHands !== prevSwap) {
      arms.left = newArm();
      arms.right = newArm();
      blockGestures('swap-hands');
    }
  }

  function beginCalibration(t = nowMs()) {
    calib = { startT: t, samples: [], lastGoodT: null, progress: 0, hint: 'Сядьте ровно, опустите руки и не двигайтесь', result: null, message: '' };
    baseline = null;
    track.calibrationInvalid = null;
    recompute();
    resetMotion('calibration');
    blockGestures('calibration');
  }

  recompute();
  resetMotion('init');

  return {
    pushObservation,
    read,
    peek,
    getTracking,
    getDebug,
    configure,
    beginCalibration,
    cancelCalibration: (message) => failCalibration(message || 'Калибровка отменена'),
    tick: (now = nowMs()) => { if (calib && !calib.result && now - calib.startT > cfg.calibrationTimeoutMs) failCalibration(calibrationTimeoutMessage()); },
    calibrationStatus: () => (calib ? { active: !calib.result, progress: calib.progress, hint: calib.hint, result: calib.result, message: calib.message } : null),
    ackCalibration: () => { if (calib && calib.result) calib = null; },
    resetMotion: (reason = 'manual') => resetMotion(reason),
    clearCalibration: () => { baseline = null; recompute(); resetMotion('calibration-cleared'); },
    setActive: (v) => { active = !!v; if (!active) { pulses.dash = null; pulses.burst = null; } },
    getBaseline: () => (baseline ? { ...baseline, restRise: { ...baseline.restRise } } : null),
    getDerived: () => ({ ...derived }),
    getConfig: () => mergeVisionConfig(cfg, {}),
  };
}

// ───────────────────── 2. браузерная оболочка ─────────────────────

export function resolveMediaPipe(mp) {
  const src = { ...DEFAULT_MEDIAPIPE, ...(mp && typeof mp === 'object' ? mp : {}) };
  let base;
  try {
    if (typeof document !== 'undefined' && document.baseURI) base = document.baseURI;
    else if (typeof location !== 'undefined' && location.href) base = location.href;
  } catch { base = undefined; }
  const abs = (u) => { try { return base ? new URL(u, base).href : new URL(u).href; } catch { return String(u); } };
  const out = { moduleUrl: abs(src.moduleUrl), wasmRoot: abs(src.wasmRoot).replace(/\/+$/, ''), modelUrl: abs(src.modelUrl), handModelUrl: src.handModelUrl ? abs(src.handModelUrl) : null };
  const ver = (u) => { const m = /tasks-vision@([^/]+)/.exec(u); return m ? m[1] : null; };
  const vm = ver(out.moduleUrl);
  const vw = ver(out.wasmRoot);
  out.version = vm || vw || null;
  out.versionMismatch = !!(vm && vw && vm !== vw);
  return out;
}

export function mapCameraError(err) {
  const name = err && err.name ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { code: 'permission-denied', message: 'Доступ к камере запрещён. Разрешите камеру для сайта (значок слева от адреса) и нажмите «Включить камеру» снова. Во встроенном превью камера может быть заблокирована.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { code: 'no-device', message: 'Камера не найдена. Подключите веб-камеру и попробуйте снова.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { code: 'device-busy', message: 'Камера занята другой программой или недоступна. Закройте другие приложения с камерой и попробуйте снова.' };
    case 'TypeError':
      return { code: 'unsupported', message: 'Браузер не смог открыть камеру. Используйте Chrome или Edge через localhost или HTTPS.' };
    default:
      return { code: 'camera-failed', message: `Не удалось включить камеру${name ? ` (${name})` : ''}. Попробуйте снова.` };
  }
}

const STAGE_TEXT = {
  module: 'Загрузка библиотеки MediaPipe…',
  wasm: 'Загрузка WASM-среды…',
  model: 'Загрузка модели позы…',
  warmup: 'Проверка распознавания…',
  fallback: 'Фоновый поток недоступен — запуск в основном потоке…',
};

export async function createVision(options = {}) {
  const video = options.video;
  const overlayCanvas = options.overlayCanvas || null;
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  if (!video) throw visionError('no-video', 'createVision: не передан элемент video');

  let cfg = mergeVisionConfig(DEFAULT_VISION_CONFIG, options.config || {});
  const interp = createPoseInterpreter(cfg);
  interp.setActive(false);
  // options.handInterpreter — только для тестов: подмена core/handGestures.js объектом
  // с тем же API { push, read, peek, configure, reset, getDebug }.
  const hi = options.handInterpreter;
  const handsInterp = hi && typeof hi.read === 'function' && typeof hi.push === 'function'
    ? hi : createHandGestures(cfg.handGestures || {});
  let lastPose = null;      // { tMs, frameW, frameH, mirror, landmarks[33] } — для трекинг-HUD
  let lastBody = null;      // [V3.1] последняя надёжная середина плеч {x, y, t}
  // [V3.1] «Чувствительность движений» из паузы действует и на джойстик левой руки:
  // выше — короче ход до бега и уже мёртвая зона (рывок не трогаем — он в ладонях).
  function applyStickSensitivity() {
    if (!handsInterp || typeof handsInterp.configure !== 'function') return;
    const k = clamp(finite(cfg.sensitivity) ? cfg.sensitivity : 1, 0.5, 2);
    try {
      handsInterp.configure({ stick: { deadzone: 0.4 / Math.sqrt(k), walkFull: 1.05 / k, runOn: 1.2 / k, runOff: 0.95 / k, full: 1.6 / k } });
    } catch { /* ignore */ }
  }
  applyStickSensitivity();
  let handsStatus = { enabled: !!cfg.hands, ready: false, error: null, delegate: null };

  const st = { status: 'idle', message: 'Камера не включена', progress: 0, emittedProgress: 0, code: null };
  let running = false;
  let disposed = false;
  let stream = null;
  let trackEnded = null;
  let engine = null;
  let enginePromise = null;
  let switching = false;
  let startPromise = null;
  let startToken = 0;
  let runningSince = 0;
  let calibWaiter = null;
  let workerFallbackReason = null;
  let loadStage = null;
  let stickyNote = null;
  let mpResolved = resolveMediaPipe(cfg.mediaPipe);
  const loop = {
    mode: null, rvfcId: null, pollId: null, watchdogId: null, frameIntervalMs: 33.3,
    lastKey: undefined, busy: false, busySince: 0, dirty: false, dirtyKey: undefined,
    seq: 0, inflightSeq: null, lastRvfcT: 0, pollFrames: -1, pollFramesT: 0, rvfcStarved: false,
  };
  const perf = {
    arrivals: [], hz: 0, inferMs: null, latencyMs: null, results: 0,
    skippedBusy: 0, skippedRate: 0, errors: 0, consecutiveErrors: 0, captureErrors: 0,
    lastInferT: -Infinity, minIntervalMs: 0,
  };
  if (mpResolved.versionMismatch) console.warn('[vision] версии moduleUrl и wasmRoot MediaPipe различаются', mpResolved);

  // ── статус ──
  function setStatus(status, message, progress = st.progress, code = null) {
    const p = clamp(finite(progress) ? progress : 0, 0, 1);
    const changed = status !== st.status || message !== st.message || code !== st.code || Math.abs(p - st.emittedProgress) >= 0.02 || (p === 1 && st.emittedProgress !== 1);
    st.status = status; st.message = message; st.progress = p; st.code = code;
    if (!changed) return;
    st.emittedProgress = p;
    if (onStatus) { try { onStatus(getStatus()); } catch (e) { console.warn('[vision] onStatus:', e); } }
  }

  function getStatus() {
    const now = nowMs();
    const tr = interp.getTracking(now);
    const f = interp.peek(now);
    const arr = perf.arrivals;
    return {
      apiVersion: API_VERSION,
      status: st.status,
      message: st.message,
      progress: st.progress,
      error: st.code,
      confidence: running ? r3(tr.confidence) : 0,
      calibrated: tr.calibrated,
      valid: running && f.valid,
      mode: engine ? engine.kind : null,
      delegate: engine ? engine.delegate : null,
      hands: { ...handsStatus },
      debug: {
        ...interp.getDebug(now),
        frameAgeMs: r1(tr.frameAgeMs),
        bodyVisible: tr.bodyVisible,
        inferenceHz: arr.length >= 2 ? r1(perf.hz) : null,
        inferMs: r1(perf.inferMs),
        latencyMs: r1(perf.latencyMs),
        results: perf.results,
        skippedBusy: perf.skippedBusy,
        skippedRate: perf.skippedRate,
        errors: perf.errors,
        captureErrors: perf.captureErrors,
        loopMode: loop.mode,
        rvfcStarved: loop.rvfcStarved,
        workerFallbackReason,
        loadStage,
        video: { w: video.videoWidth || 0, h: video.videoHeight || 0 },
        mediaPipe: { version: mpResolved.version, versionMismatch: mpResolved.versionMismatch },
        handGestures: cfg.hands ? handsInterp.getDebug() : null,
      },
    };
  }

  function noteLoadStage(stage, progress) {
    loadStage = stage;
    if (st.status === 'loading') setStatus('loading', STAGE_TEXT[stage] || 'Загрузка…', Math.max(st.progress, progress || 0));
  }

  function updateTrackingStatus(now, note = null) {
    if (note) stickyNote = { text: note, until: now + 4000 };
    if (!running || st.status === 'error') return;
    const c = interp.calibrationStatus();
    if (c && !c.result) return;
    const tr = interp.getTracking(now);
    const noFramesYet = tr.frameAgeMs === null || now - tr.frameAgeMs < runningSince;
    if (noFramesYet && now - runningSince < 5000) {
      setStatus('loading', 'Ожидание первых кадров…', Math.max(st.progress, 0.95));
      return;
    }
    if (tr.lost) {
      let msg = 'Не видно плеч — сядьте в кадр';
      if (noFramesYet || !tr.fresh) msg = 'Нет новых кадров с камеры';
      else if (tr.scaleWarning === 'far') msg = 'Вы дальше, чем при калибровке — сядьте ближе';
      else if (tr.scaleWarning === 'near') msg = 'Вы ближе, чем при калибровке — отодвиньтесь';
      stickyNote = null; // после потери старая подсказка неактуальна
      setStatus('lost', msg, 0);
      return;
    }
    let msg = 'Трекинг активен';
    if (stickyNote && now < stickyNote.until) msg = stickyNote.text;
    else if (tr.calibrationInvalid === 'aspect') msg = 'Формат кадра изменился — повторите калибровку';
    else if (!tr.calibrated) msg = 'Камера готова — выполните калибровку';
    else if (tr.recoveredAt !== null && now - tr.recoveredAt < 2500) msg = 'Трекинг восстановлен';
    setStatus('ready', msg, 1);
  }

  // ── окружение и камера ──
  function checkEnvironment() {
    if (typeof globalThis.isSecureContext === 'boolean' && !globalThis.isSecureContext) {
      return { code: 'insecure-context', message: 'Камера работает только через https:// или http://localhost. Откройте игру через локальный сервер.' };
    }
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') {
      return { code: 'unsupported', message: 'Этот браузер не даёт доступ к камере. Используйте Chrome или Edge через localhost или HTTPS.' };
    }
    return null;
  }

  async function openCamera() {
    const c = cfg.camera || {};
    const v = { facingMode: 'user' };
    if (finite(c.width)) v.width = { ideal: c.width };
    if (finite(c.height)) v.height = { ideal: c.height };
    if (finite(c.frameRate)) v.frameRate = { ideal: c.frameRate };
    if (c.deviceId) v.deviceId = { exact: c.deviceId };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: v });
    } catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError')) {
        return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      throw e;
    }
  }

  function stopStream(s) {
    if (!s) return;
    try { for (const t of s.getTracks()) t.stop(); } catch { /* уже остановлен */ }
  }

  function attachVideo(s) {
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    if (typeof video.setAttribute === 'function') { video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); }
    video.srcObject = s;
    return new Promise((resolve, reject) => {
      let done = false;
      let iv = null;
      let to = null;
      const evs = ['loadedmetadata', 'loadeddata', 'canplay', 'resize', 'playing'];
      const cleanup = () => {
        clearInterval(iv); clearTimeout(to);
        if (typeof video.removeEventListener === 'function') for (const e of evs) video.removeEventListener(e, check);
      };
      const ready = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
      function check() {
        if (done || !ready()) return;
        done = true; cleanup(); resolve();
      }
      if (typeof video.addEventListener === 'function') for (const e of evs) video.addEventListener(e, check);
      iv = setInterval(check, 50);
      to = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('видео не готово за отведённое время')); } }, cfg.videoReadyTimeoutMs);
      Promise.resolve().then(() => (typeof video.play === 'function' ? video.play() : null)).then(check, (e) => {
        if (!done) { done = true; cleanup(); reject(e); }
      });
    });
  }

  function detachTrackEnded() {
    if (!trackEnded) return;
    try { trackEnded.track.removeEventListener('ended', trackEnded.fn); } catch { /* ignore */ }
    trackEnded = null;
  }

  function fail(code, message, cause) {
    running = false;
    interp.setActive(false);
    stopLoop();
    detachTrackEnded();
    stopStream(stream);
    stream = null;
    try { video.srcObject = null; } catch { /* нет srcObject */ }
    if (cause) console.warn(`[vision] ${code}:`, cause);
    setStatus('error', message, 0, code);
    rejectCalibration('error', message);
    return visionError(code, message, cause);
  }

  function onTrackEnded() {
    if (!running) return;
    fail('device-lost', 'Камера отключилась. Подключите её и нажмите «Включить камеру».');
  }

  // ── движок MediaPipe ──
  function poseOptions() {
    return {
      numPoses: 1,
      minPoseDetectionConfidence: cfg.minPoseDetectionConfidence,
      minPosePresenceConfidence: cfg.minPosePresenceConfidence,
      minTrackingConfidence: cfg.minTrackingConfidence,
      outputSegmentationMasks: false,
    };
  }

  function handOptions(mp) {
    if (!cfg.hands || !mp.handModelUrl) return null;
    return {
      modelUrl: mp.handModelUrl, numHands: cfg.numHands,
      minHandDetectionConfidence: cfg.minHandDetectionConfidence,
      minHandPresenceConfidence: cfg.minHandPresenceConfidence,
      minTrackingConfidence: cfg.minHandTrackingConfidence,
    };
  }

  function workerSupport() {
    if (typeof Worker !== 'function') return { ok: false, reason: 'нет Worker' };
    if (typeof OffscreenCanvas !== 'function') return { ok: false, reason: 'нет OffscreenCanvas' };
    if (typeof createImageBitmap !== 'function') return { ok: false, reason: 'нет createImageBitmap' };
    return { ok: true, reason: null };
  }

  function ensureEngine() {
    if (engine) return Promise.resolve(engine);
    if (!enginePromise) {
      enginePromise = loadEngine().then((e) => {
        if (disposed) { closeEngine(e); throw visionError('disposed', 'Модуль камеры освобождён'); }
        engine = e;
        updateMinInterval();
        return e;
      }, (e) => { enginePromise = null; throw e; });
    }
    return enginePromise;
  }

  async function loadEngine() {
    mpResolved = resolveMediaPipe(cfg.mediaPipe);
    const sup = workerSupport();
    const wantWorker = !(cfg.useWorker === false || cfg.useWorker === 'off');
    if (wantWorker && sup.ok) {
      try {
        return await loadWorkerEngine(mpResolved);
      } catch (e) {
        workerFallbackReason = String((e && e.message) || e);
        console.warn('[vision] worker не прошёл самопроверку, откат в главный поток:', workerFallbackReason);
        noteLoadStage('fallback', 0.35);
      }
    } else {
      workerFallbackReason = wantWorker ? sup.reason : 'worker отключён настройкой useWorker';
    }
    return loadMainEngine(mpResolved);
  }

  function workerScriptUrl() {
    if (cfg.workerUrl) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : import.meta.url;
      return new URL(cfg.workerUrl, base).href;
    }
    return new URL('./vision-worker.js', import.meta.url).href;
  }

  function loadWorkerEngine(mp) {
    return new Promise((resolve, reject) => {
      let w;
      let timer = null;
      let done = false;
      try {
        w = new Worker(workerScriptUrl(), { type: 'module', name: 'ashen-vision' });
      } catch (e) {
        reject(new Error(`Worker не создан: ${(e && e.message) || e}`));
        return;
      }
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.removeEventListener('message', onMsg);
        w.removeEventListener('error', onErr);
        w.removeEventListener('messageerror', onErr);
        if (err) { try { w.terminate(); } catch { /* уже завершён */ } reject(err); } else resolve(value);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`worker молчит ${Math.round(cfg.workerInitTimeoutMs / 1000)} с (этап: ${loadStage || 'старт'})`)), cfg.workerInitTimeoutMs);
      };
      const onMsg = (ev) => {
        const m = ev.data || {};
        if (m.type === 'progress') { arm(); noteLoadStage(m.stage, m.progress); }
        else if (m.type === 'ready') finish(null, makeWorkerEngine(w, m));
        else if (m.type === 'init-error') finish(new Error(m.message || 'ошибка инициализации worker'));
      };
      const onErr = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        finish(new Error(`скрипт worker не загрузился: ${(ev && ev.message) || 'проверьте путь к vision-worker.js и раздачу по http(s)'}`));
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.addEventListener('messageerror', onErr);
      arm();
      w.postMessage({ type: 'init', apiVersion: API_VERSION, mp: { moduleUrl: mp.moduleUrl, wasmRoot: mp.wasmRoot, modelUrl: mp.modelUrl }, delegate: cfg.delegate, options: poseOptions(), hands: handOptions(mp) });
    });
  }

  function makeWorkerEngine(w, info) {
    const e = { kind: 'worker', delegate: info.delegate || null, worker: w, warmupMs: info.warmupMs, note: info.fallbackFrom || null };
    handsStatus = { enabled: !!cfg.hands, ready: !!info.handsReady, error: info.handsError || null, delegate: info.handsDelegate || null };
    if (cfg.hands && !info.handsReady) console.warn('[vision] кисти недоступны, работает только поза:', info.handsError);
    w.addEventListener('message', (ev) => onWorkerMessage(e, ev));
    w.addEventListener('error', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (engine === e) switchToMainFallback(`ошибка worker во время работы: ${(ev && ev.message) || ''}`);
    });
    return e;
  }

  async function loadMainEngine(mp) {
    noteLoadStage('module', 0.35);
    const mod = await import(/* @vite-ignore */ mp.moduleUrl);
    const FilesetResolver = mod.FilesetResolver;
    const PoseLandmarker = mod.PoseLandmarker;
    if (!FilesetResolver || !PoseLandmarker) throw new Error('в модуле MediaPipe нет FilesetResolver/PoseLandmarker');
    noteLoadStage('wasm', 0.45);
    const fileset = await FilesetResolver.forVisionTasks(mp.wasmRoot); // классический загрузчик через <script>
    const order = cfg.delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
    let lastErr = null;
    for (const delegate of order) {
      let lm = null;
      try {
        noteLoadStage('model', 0.6);
        lm = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: mp.modelUrl, delegate },
          runningMode: 'VIDEO',
          ...poseOptions(),
        });
        noteLoadStage('warmup', 0.85);
        const t0 = nowMs();
        warmupMain(lm);
        let hands = null;
        const ho = handOptions(mp);
        if (ho && mod.HandLandmarker) {
          try {
            hands = await mod.HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: ho.modelUrl, delegate }, runningMode: 'VIDEO', numHands: ho.numHands,
              minHandDetectionConfidence: ho.minHandDetectionConfidence, minHandPresenceConfidence: ho.minHandPresenceConfidence, minTrackingConfidence: ho.minTrackingConfidence,
            });
            handsStatus = { enabled: true, ready: true, error: null, delegate };
          } catch (he) {
            handsStatus = { enabled: true, ready: false, error: String((he && he.message) || he), delegate: null };
            console.warn('[vision] кисти недоступны в главном потоке:', he);
          }
        }
        return { kind: 'main', delegate, landmarker: lm, hands, lastTs: 1, warmupMs: nowMs() - t0, note: lastErr ? String(lastErr.message || lastErr) : null };
      } catch (e) {
        lastErr = e;
        try { if (lm) lm.close(); } catch { /* ignore */ }
      }
    }
    throw lastErr || new Error('не удалось создать PoseLandmarker');
  }

  // Первый detect на GPU компилирует шейдеры; делаем это на экране загрузки, а не в бою.
  function warmupMain(lm) {
    let canvas = null;
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') canvas = document.createElement('canvas');
    else if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(64, 64);
    if (!canvas) return;
    canvas.width = 64;
    canvas.height = 64;
    const g = canvas.getContext('2d');
    if (g) { g.fillStyle = '#777'; g.fillRect(0, 0, 64, 64); }
    const r = lm.detectForVideo(canvas, 1);
    if (r && typeof r.close === 'function') r.close();
  }

  function closeEngine(e) {
    if (!e) return;
    if (e.kind === 'worker') {
      try { e.worker.postMessage({ type: 'close' }); } catch { /* ignore */ }
      try { e.worker.terminate(); } catch { /* ignore */ }
    } else if (e.landmarker) {
      try { e.landmarker.close(); } catch { /* ignore */ }
      try { if (e.hands) e.hands.close(); } catch { /* ignore */ }
    }
  }

  async function switchToMainFallback(reason) {
    if (switching || disposed) return;
    switching = true;
    const old = engine;
    engine = null;
    enginePromise = null; // иначе повторный start() получил бы уже закрытый движок
    loop.busy = false; loop.inflightSeq = null; loop.dirty = false;
    closeEngine(old);
    workerFallbackReason = reason;
    console.warn('[vision] переключение в главный поток:', reason);
    try {
      const e = await loadMainEngine(mpResolved);
      if (disposed) { closeEngine(e); return; }
      engine = e;
      enginePromise = Promise.resolve(e);
      updateMinInterval();
    } catch (err) {
      fail('model-failed', 'Распознавание позы остановилось и не перезапустилось. Обновите страницу.', err);
    } finally {
      switching = false;
    }
  }

  function updateMinInterval() {
    const maxHz = Math.max(1, cfg.maxInferenceHz);
    if (engine && engine.kind === 'main') {
      const hz = Math.max(1, Math.min(cfg.fallbackMaxHz, maxHz));
      const loadCap = finite(perf.inferMs) && cfg.fallbackMaxLoad > 0 ? perf.inferMs / cfg.fallbackMaxLoad : 0;
      perf.minIntervalMs = Math.max((1000 / hz) * 0.9, loadCap);
    } else {
      perf.minIntervalMs = (1000 / maxHz) * 0.8; // допуск на дрожание кадров камеры
    }
  }

  // ── цикл новых видеокадров ──
  function startLoop() {
    stopLoop();
    loop.lastKey = undefined; loop.busy = false; loop.dirty = false; loop.inflightSeq = null;
    loop.rvfcStarved = false; loop.pollFrames = -1;
    let fr = 30;
    try {
      const vt = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
      const s = vt && vt.getSettings ? vt.getSettings() : null;
      if (s && finite(s.frameRate) && s.frameRate > 1) fr = s.frameRate;
    } catch { /* нет настроек */ }
    loop.frameIntervalMs = 1000 / clamp(fr, 5, 60);
    loop.lastRvfcT = nowMs();
    if (typeof video.requestVideoFrameCallback === 'function') {
      loop.mode = 'rvfc';
      loop.rvfcId = video.requestVideoFrameCallback(onRvfc);
    } else {
      loop.mode = 'poll';
      schedulePoll();
    }
    loop.watchdogId = setInterval(watchdogTick, 200);
  }

  function stopLoop() {
    if (loop.rvfcId !== null && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(loop.rvfcId); } catch { /* ignore */ }
    }
    loop.rvfcId = null;
    clearTimeout(loop.pollId); loop.pollId = null;
    clearInterval(loop.watchdogId); loop.watchdogId = null;
    loop.mode = null;
  }

  function onRvfc(_now, meta) {
    if (!running || loop.mode !== 'rvfc') return;
    loop.lastRvfcT = nowMs();
    loop.rvfcId = video.requestVideoFrameCallback(onRvfc);
    let key;
    if (meta && finite(meta.presentedFrames)) key = `p${meta.presentedFrames}`;
    else if (meta && finite(meta.mediaTime)) key = `m${meta.mediaTime}`;
    else key = `c${video.currentTime}`;
    onNewFrame(key);
  }

  function schedulePoll() {
    clearTimeout(loop.pollId);
    loop.pollId = setTimeout(pollTick, loop.frameIntervalMs);
  }
  function pollTick() {
    if (!running || loop.mode !== 'poll') return;
    schedulePoll();
    if (video.readyState < 2) return;
    onNewFrame(pollFrameKey());
  }
  // Без rVFC новый кадр определяется по счётчику кадров плеера; если он не растёт —
  // квантованием по частоте камеры (приблизительно, но не чаще кадров камеры).
  function pollFrameKey() {
    const now = nowMs();
    if (typeof video.getVideoPlaybackQuality === 'function') {
      let n = NaN;
      try { n = video.getVideoPlaybackQuality().totalVideoFrames; } catch { /* ignore */ }
      if (finite(n) && n > 0) {
        if (n !== loop.pollFrames) { loop.pollFrames = n; loop.pollFramesT = now; return `f${n}`; }
        if (now - loop.pollFramesT < 250) return loop.lastKey;
      }
    }
    return `t${Math.floor(now / loop.frameIntervalMs)}`;
  }

  function onNewFrame(key) {
    if (!running || !engine || switching) return;
    if (key === loop.lastKey) return; // этот кадр уже обработан
    const now = nowMs();
    if (engine.kind === 'worker') {
      if (loop.busy) { loop.dirty = true; loop.dirtyKey = key; perf.skippedBusy++; return; }
      if (now - perf.lastInferT < perf.minIntervalMs) { perf.skippedRate++; return; }
      loop.lastKey = key;
      captureToWorker(engine);
    } else {
      if (now - perf.lastInferT < perf.minIntervalMs) { perf.skippedRate++; return; }
      loop.lastKey = key;
      detectOnMain(engine, now);
    }
  }

  function bitmapOptions(w, h) {
    const cap = cfg.captureMaxWidth;
    if (!(cap > 0) || !(w > cap)) return undefined;
    return { resizeWidth: cap, resizeHeight: Math.max(1, Math.round((h * cap) / w)), resizeQuality: 'low' };
  }

  // Не более одного кадра в работе и ноль в очереди: пока worker занят, новые кадры
  // только помечаются (dirty); по готовности берётся самый свежий кадр видео.
  async function captureToWorker(e) {
    loop.busy = true;
    loop.busySince = nowMs();
    loop.dirty = false;
    const seq = ++loop.seq;
    loop.inflightSeq = seq;
    const tMs = nowMs();
    perf.lastInferT = tMs;
    const w = video.videoWidth;
    const h = video.videoHeight;
    let bmp = null;
    try {
      const o = bitmapOptions(w, h);
      bmp = o ? await createImageBitmap(video, o) : await createImageBitmap(video);
    } catch (err) {
      if (loop.inflightSeq === seq) { loop.inflightSeq = null; loop.busy = false; }
      perf.captureErrors++;
      return;
    }
    if (!running || engine !== e || loop.inflightSeq !== seq) {
      try { bmp.close(); } catch { /* ignore */ }
      if (loop.inflightSeq === seq) { loop.inflightSeq = null; loop.busy = false; }
      return;
    }
    try {
      e.worker.postMessage({ type: 'frame', seq, tMs, w, h, bitmap: bmp }, [bmp]);
    } catch (err) {
      try { bmp.close(); } catch { /* ignore */ }
      loop.inflightSeq = null; loop.busy = false;
      perf.captureErrors++;
    }
  }

  function onWorkerMessage(e, ev) {
    const m = ev.data || {};
    if (engine !== e) return;
    if (m.type !== 'result' && m.type !== 'frame-error') return;
    if (m.seq !== loop.inflightSeq) return; // ответ на кадр до stop/перезапуска
    loop.inflightSeq = null;
    loop.busy = false;
    if (m.type === 'frame-error') {
      perf.errors++;
      perf.consecutiveErrors++;
      if (perf.consecutiveErrors >= 3) { switchToMainFallback(`повторные ошибки в worker: ${m.message || ''}`); return; }
    } else {
      perf.consecutiveErrors = 0;
      if (running) handleResult(m.tMs, m.landmarks ? unpackCompactLandmarks(m.landmarks) : null, m.w, m.h, m.inferMs, unpackHands(m.hands, m.handsMeta));
    }
    if (running && loop.dirty && nowMs() - perf.lastInferT >= perf.minIntervalMs) {
      loop.lastKey = loop.dirtyKey;
      captureToWorker(e);
    }
  }

  // Главный поток: detectForVideo синхронный и блокирует интерфейс на время inference.
  function detectOnMain(e, now) {
    const ts = Math.max(e.lastTs + 1, Math.round(now));
    e.lastTs = ts;
    perf.lastInferT = now;
    const t0 = nowMs();
    let res = null;
    let lms = null;
    try {
      res = e.landmarker.detectForVideo(video, ts);
      const pose = res && res.landmarks ? res.landmarks[0] : null;
      lms = pose ? copyLandmarks(pose) : null;
      perf.consecutiveErrors = 0;
    } catch (err) {
      perf.errors++;
      perf.consecutiveErrors++;
      if (perf.consecutiveErrors >= 5) fail('model-failed', 'Сбой распознавания позы. Обновите страницу.', err);
      return;
    } finally {
      try { if (res && typeof res.close === 'function') res.close(); } catch { /* ignore */ }
    }
    let hands = [];
    if (e.hands) {
      let hr = null;
      try { hr = e.hands.detectForVideo(video, ts); hands = handsFromResult(hr); }
      catch { /* кадр без рук */ }
      finally { try { if (hr && typeof hr.close === 'function') hr.close(); } catch { /* ignore */ } }
    }
    handleResult(now, lms, video.videoWidth, video.videoHeight, nowMs() - t0, hands);
  }

  function handsFromResult(res) {
    const out = [];
    const list = res && res.landmarks ? res.landmarks : [];
    for (let i = 0; i < Math.min(2, list.length); i++) {
      const cat = res.handedness && res.handedness[i] && res.handedness[i][0];
      out.push({
        landmarks: list[i].map((p) => ({ x: p.x, y: p.y, z: p.z })),
        world: res.worldLandmarks && res.worldLandmarks[i] ? res.worldLandmarks[i].map((p) => ({ x: p.x, y: p.y, z: p.z })) : null,
        handedness: cat ? cat.categoryName : null, score: cat ? cat.score : 0,
      });
    }
    return out;
  }

  function unpackHands(buf, meta) {
    if (!buf || !Array.isArray(meta)) return [];
    const S = 21 * 6;
    const out = [];
    for (let i = 0; i < meta.length && (i + 1) * S <= buf.length; i++) {
      const o = i * S;
      const landmarks = [], world = [];
      for (let k = 0; k < 21; k++) {
        landmarks.push({ x: buf[o + k * 3], y: buf[o + k * 3 + 1], z: buf[o + k * 3 + 2] });
        const ow = o + 63 + k * 3;
        world.push({ x: buf[ow], y: buf[ow + 1], z: buf[ow + 2] });
      }
      out.push({ landmarks, world: meta[i].world ? world : null, handedness: meta[i].handedness, score: meta[i].score });
    }
    return out;
  }

  function handleResult(tMs, lms, w, h, inferMs, hands) {
    const arrived = nowMs();
    perf.results++;
    perf.arrivals.push(arrived);
    if (perf.arrivals.length > 16) perf.arrivals.shift();
    const a = perf.arrivals;
    if (a.length >= 2 && a[a.length - 1] > a[0]) perf.hz = ((a.length - 1) * 1000) / (a[a.length - 1] - a[0]);
    if (finite(inferMs)) perf.inferMs = emaValue(perf.inferMs, inferMs, 0.15);
    perf.latencyMs = emaValue(perf.latencyMs, arrived - tMs, 0.15);
    updateMinInterval();
    interp.pushObservation({ tMs, frameW: w, frameH: h, landmarks: lms });
    lastPose = { tMs, frameW: w, frameH: h, mirror: !!cfg.mirror, landmarks: lms };
    if (cfg.hands) {
      const wr = (i) => (lms && lms[i] ? { x: lms[i].x, y: lms[i].y, visibility: lms[i].visibility } : null);
      // [V3.1] середина плеч — только из надёжно видимых плеч: рука, уведённая вперёд/вправо,
      // закрывает левое плечо и сдвигает его точку. Иначе — последняя хорошая (до 700 мс).
      const shOk = (p) => p && finite(p.x) && finite(p.y) && (!finite(p.visibility) || p.visibility >= 0.6);
      let body = null;
      if (lms && shOk(lms[11]) && shOk(lms[12])) { body = { x: (lms[11].x + lms[12].x) / 2, y: (lms[11].y + lms[12].y) / 2 }; lastBody = { ...body, t: tMs }; }
      else if (lastBody && tMs - lastBody.t <= 700) body = { x: lastBody.x, y: lastBody.y };
      // ширина плеч (в высотах кадра): толчок кистями к камере отличаем от наклона всем корпусом
      const sw = lms && shOk(lms[11]) && shOk(lms[12]) && h > 0 ? Math.hypot((lms[11].x - lms[12].x) * (w / h), lms[11].y - lms[12].y) : null;
      handsInterp.push({ tMs, frameW: w, frameH: h, mirror: !!cfg.mirror, hands: Array.isArray(hands) ? hands : [], poseWrists: { left: wr(15), right: wr(16) }, bodyCenter: body, shoulderWidth: sw });
    }
    processCalibration(arrived);
    if (cfg.overlay) drawOverlay(lms);
    updateTrackingStatus(arrived);
  }

  function watchdogTick() {
    if (!running) return;
    const now = nowMs();
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (loop.mode === 'rvfc' && !hidden && now - loop.lastRvfcT > cfg.rvfcStarveMs && !video.paused && video.readyState >= 2) {
      // rVFC может не вызываться для невидимого <video>; переходим на опрос.
      if (loop.rvfcId !== null && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(loop.rvfcId); } catch { /* ignore */ }
      }
      loop.rvfcId = null;
      loop.rvfcStarved = true;
      loop.mode = 'poll';
      schedulePoll();
    }
    if (engine && engine.kind === 'worker' && loop.busy && now - loop.busySince > cfg.workerFrameTimeoutMs) {
      switchToMainFallback(`worker не ответил на кадр за ${cfg.workerFrameTimeoutMs} мс`);
    }
    interp.tick(now);
    processCalibration(now);
    updateTrackingStatus(now);
  }

  // ── калибровка ──
  function processCalibration(now) {
    const c = interp.calibrationStatus();
    if (!c) return;
    if (c.result === 'done') {
      interp.ackCalibration();
      const w = calibWaiter;
      calibWaiter = null;
      updateTrackingStatus(now, 'Калибровка завершена');
      if (w) w.resolve();
    } else if (c.result === 'failed') {
      interp.ackCalibration();
      const w = calibWaiter;
      calibWaiter = null;
      updateTrackingStatus(now, c.message);
      if (w) w.reject(visionError('calibration-failed', c.message));
    } else if (running) {
      setStatus('calibrating', c.hint, c.progress);
    }
  }

  function rejectCalibration(code, message) {
    const c = interp.calibrationStatus();
    if (c && !c.result) interp.cancelCalibration(message);
    if (c) interp.ackCalibration();
    const w = calibWaiter;
    calibWaiter = null;
    if (w) w.reject(visionError(code, message));
  }

  // ── overlay (необязательный, без видео) ──
  function clearOverlay() {
    if (!overlayCanvas || typeof overlayCanvas.getContext !== 'function') return;
    const ctx = overlayCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }

  function drawOverlay(lms) {
    if (!overlayCanvas || typeof overlayCanvas.getContext !== 'function') return;
    const ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) { overlayCanvas.width = vw; overlayCanvas.height = vh; }
    ctx.clearRect(0, 0, vw, vh);
    const mir = cfg.overlayMirror === null ? cfg.mirror : !!cfg.overlayMirror;
    const mx = (x) => (mir ? 1 - x : x) * vw;
    const b = interp.getBaseline();
    const d = interp.getDerived();
    if (b) {
      const cxN = b.cx / b.aspect;
      const bandN = (d.deadZone * b.width) / b.aspect;
      const dashN = (d.dashAmplitude * b.width) / b.aspect;
      ctx.fillStyle = 'rgba(150,170,200,0.12)';
      ctx.fillRect(Math.min(mx(cxN - bandN), mx(cxN + bandN)), 0, Math.abs(mx(cxN + bandN) - mx(cxN - bandN)), vh);
      ctx.strokeStyle = 'rgba(200,164,90,0.55)';
      ctx.lineWidth = 1;
      for (const s of [-1, 1]) { const x = mx(cxN + s * dashN); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, vh); ctx.stroke(); }
    }
    if (!lms) return;
    const P = (i) => { const p = lms[i]; return p ? { x: mx(p.x), y: p.y * vh, v: finite(p.visibility) ? p.visibility : 1 } : null; };
    const dbg = interp.getDebug();
    const raisedIdx = new Set();
    const rIdx = cfg.swapHands ? LANDMARK.LEFT_WRIST : LANDMARK.RIGHT_WRIST;
    const lIdx = cfg.swapHands ? LANDMARK.RIGHT_WRIST : LANDMARK.LEFT_WRIST;
    if (dbg.arms.right.raised) raisedIdx.add(rIdx);
    if (dbg.arms.left.raised) raisedIdx.add(lIdx);
    ctx.lineWidth = Math.max(2, vw / 220);
    for (const [a, c] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16]]) {
      const A = P(a); const C = P(c);
      if (!A || !C) continue;
      ctx.strokeStyle = `rgba(205,215,230,${0.25 + 0.6 * Math.min(A.v, C.v)})`;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(C.x, C.y); ctx.stroke();
    }
    for (const i of [11, 12, 13, 14, 15, 16]) {
      const p = P(i);
      if (!p) continue;
      ctx.fillStyle = raisedIdx.has(i) ? 'rgba(232,170,80,0.95)' : `rgba(170,190,215,${0.3 + 0.6 * p.v})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, raisedIdx.has(i) ? vw / 70 : vw / 110, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ── публичный API ──
  function start() {
    if (disposed) return Promise.reject(visionError('disposed', 'Модуль камеры уже освобождён'));
    if (running) return Promise.resolve();
    if (startPromise) return startPromise;
    startPromise = doStart().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function doStart() {
    const token = ++startToken;
    const env = checkEnvironment();
    if (env) throw fail(env.code, env.message);
    const engineP = ensureEngine();
    engineP.catch(() => { /* обрабатывается ниже */ });
    setStatus('permission', 'Разрешите доступ к камере в окне браузера', 0);
    let s;
    try {
      s = await openCamera();
    } catch (e) {
      if (token !== startToken) throw visionError('aborted', 'Запуск камеры отменён');
      const m = mapCameraError(e);
      throw fail(m.code, m.message, e);
    }
    const aborted = () => token !== startToken || disposed;
    if (aborted()) { stopStream(s); throw visionError('aborted', 'Запуск камеры отменён'); }
    stream = s;
    const vt = s.getVideoTracks ? s.getVideoTracks()[0] : null;
    if (vt && typeof vt.addEventListener === 'function') {
      trackEnded = { track: vt, fn: () => onTrackEnded() };
      vt.addEventListener('ended', trackEnded.fn);
    }
    setStatus('loading', 'Подготовка видео…', 0.15);
    try {
      await attachVideo(s);
    } catch (e) {
      if (aborted()) throw visionError('aborted', 'Запуск камеры отменён');
      throw fail('video-failed', 'Видео с камеры не запустилось. Переподключите камеру и попробуйте снова.', e);
    }
    if (aborted()) throw visionError('aborted', 'Запуск камеры отменён');
    if (!engine) setStatus('loading', STAGE_TEXT[loadStage] || 'Загрузка модели позы…', Math.max(0.3, st.progress));
    try {
      await engineP;
    } catch (e) {
      if (aborted()) throw visionError('aborted', 'Запуск камеры отменён');
      throw fail('model-failed', 'Не удалось загрузить модель распознавания позы. Проверьте интернет и обновите страницу.', e);
    }
    if (aborted()) throw visionError('aborted', 'Запуск камеры отменён');
    running = true;
    runningSince = nowMs();
    perf.consecutiveErrors = 0;
    interp.setActive(true);
    interp.resetMotion('start');
    startLoop();
    updateTrackingStatus(nowMs());
  }

  function calibrate() {
    if (disposed) return Promise.reject(visionError('disposed', 'Модуль камеры уже освобождён'));
    if (!running) return Promise.reject(visionError('not-running', 'Сначала включите камеру'));
    rejectCalibration('restarted', 'Калибровка перезапущена');
    interp.beginCalibration(nowMs());
    stickyNote = null;
    setStatus('calibrating', 'Сядьте ровно, опустите руки и не двигайтесь', 0);
    return new Promise((resolve, reject) => { calibWaiter = { resolve, reject }; });
  }

  // [№1, «Перстни»] Слияние: кисть, которую видно, заменяет жест «поднятой рукой» своей стороны
  // (иначе рисование руны поднятой правой рукой стреляло бы). Нет кистей — прежнее управление позой.
  // [conjure/throw] Контракт HandIntent: conjure — удержание «лепки» двумя руками, throw — импульс.
  // Здесь только очистка значений; сама логика жестов — в core/handGestures.js.
  const unit01 = (v, d) => (finite(v) ? clamp(v, 0, 1) : d);
  const spellKind = (k) => (k === 'orb' || k === 'prism' ? k : null);
  function cleanConjure(c) {
    if (!c || typeof c !== 'object' || !spellKind(c.kind)) return null;
    const ce = c.center && finite(c.center.x) && finite(c.center.y) ? { x: c.center.x, y: c.center.y } : { x: 0.5, y: 0.5 };
    return { ...c, kind: c.kind, size: unit01(c.size, 0), charge: unit01(c.charge, 0), center: ce, heldMs: finite(c.heldMs) ? Math.max(0, c.heldMs) : 0 };
  }
  function cleanThrow(t) {
    if (!t || typeof t !== 'object' || !spellKind(t.kind)) return null;
    return { ...t, kind: t.kind, size: unit01(t.size, 0.5), power: unit01(t.power, 0.5), aimX: finite(t.aimX) ? clamp(t.aimX, -1, 1) : 0 };
  }

  // [ASHEN_V2] InputFrame: движение и рывок — левая рука-джойстик, жесты — обе руки (core/handGestures.js).
  // Без кистей остаются только запасные жесты позы (поднятая рука — огонь/щит, обе — выброс).
  const V2_EMPTY = { dashDir: null, stick: null, spark: false, slash: null, parry: false, burstHand: null, sigil: null, hint: null };
  function read() {
    const now = nowMs();
    const f = interp.read(now);
    const h = cfg.hands ? handsInterp.read(now) : null;
    const base = { ...f, ...V2_EMPTY, burstHand: f.valid && f.burst ? 'both' : null };
    if (!h) return base;
    const out = { ...base, burstPower: 0, charge: 0, rune: null, runeScore: 0, runeFizzle: false, hands: null, conjure: null, throw: null };
    if (!f.valid) { out.burstHand = null; return out; } // контракт: невалидный кадр — всё обнулено (импульсы кистей уже сожжены)
    const R = h.right, L = h.left;
    out.attack = R ? h.attack : f.attack;
    out.shield = L ? h.shield : f.shield;
    const handBurst = h.burst;
    const poseBurst = !R && !L && f.burst;
    out.burst = handBurst || poseBurst;
    out.burstPower = handBurst ? h.burstPower : poseBurst ? 0.5 : 0;
    out.burstHand = handBurst ? h.burstHand : poseBurst ? 'both' : null;
    // движение: джойстик левой руки; корпус — только если включён откат torsoMove и джойстик не взят
    const stickOn = !!(h.stick && h.stick.engaged);
    out.stick = h.stick || null;
    out.moveX = stickOn ? h.moveX : f.moveX;
    out.moveZ = stickOn ? h.moveZ : f.moveZ;
    out.dashDir = h.dashDir || null;
    out.dash = h.dashDir ? h.dash : f.dash;
    out.spark = !!h.spark;
    out.slash = h.slash || null;
    out.parry = !!h.parry;
    out.sigil = h.sigil || null;          // [V3] двуручная печать: clap | gate | frame
    out.charge = h.charge;
    out.rune = h.rune;
    out.runeScore = h.runeScore;
    out.runeFizzle = h.runeFizzle;
    out.conjure = cleanConjure(h.conjure);
    out.throw = cleanThrow(h.throw);
    out.hint = h.hint || null;           // [ТВИСТ «ОШИБКА»] почти-правильный жест → код подсказки
    if (out.conjure) {
      // Обе руки заняты заклинанием: стоим, одиночные жесты (и запасные по позе) не действуют.
      out.attack = false; out.shield = false;
      out.burst = false; out.burstPower = 0; out.burstHand = null;
      out.rune = null; out.runeScore = 0;
      out.moveX = 0; out.moveZ = 0; out.dash = 0; out.dashDir = null;
      out.spark = false; out.slash = null; out.parry = false; out.sigil = null;
      if (out.stick) out.stick = { ...out.stick, engaged: false, x: 0, z: 0, moveX: 0, moveZ: 0 };
    }
    if (out.throw) {
      // Толчок ладонями вперёд при броске похож на «кулак → ладонь»: выброс/руна/парирование в этом кадре не считаются.
      out.burst = false; out.burstPower = 0; out.burstHand = null;
      out.rune = null; out.runeScore = 0; out.parry = false; out.slash = null;
    }
    if (out.burst) { out.attack = false; out.spark = false; }
    out.hands = {
      available: h.available,
      left: L ? { shape: L.shape, palmFacing: L.palmFacing, charge: L.charge, center: L.center } : null,
      right: R ? { shape: R.shape, palmFacing: R.palmFacing, charge: R.charge, center: R.center, tip: R.tip } : null,
      drawing: h.drawing, trail: h.trail, lastRune: h.lastRune,
    };
    return out;
  }

  function getStick() { const h = cfg.hands ? handsInterp.peek(nowMs()) : null; return h ? h.stick : null; }

  function getPose() { return lastPose; }
  function getHands() { return cfg.hands ? handsInterp.peek(nowMs()) : null; }

  function configure(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    cfg = mergeVisionConfig(cfg, patch);
    interp.configure(patch);
    if (patch.handGestures) handsInterp.configure(patch.handGestures);
    if ('sensitivity' in patch) applyStickSensitivity();
    if ('overlay' in patch && !cfg.overlay) clearOverlay();
    if ('mediaPipe' in patch && engine) console.warn('[vision] новые URL MediaPipe применятся после dispose/createVision');
    updateMinInterval();
  }

  function stop() {
    startToken++;
    running = false;
    interp.setActive(false);
    stopLoop();
    detachTrackEnded();
    stopStream(stream);
    stream = null;
    try { if (typeof video.pause === 'function') video.pause(); } catch { /* ignore */ }
    try { video.srcObject = null; } catch { /* ignore */ }
    loop.busy = false; loop.inflightSeq = null; loop.dirty = false;
    rejectCalibration('stopped', 'Калибровка прервана: камера остановлена');
    interp.resetMotion('stopped');
    handsInterp.reset('stopped');
    lastPose = null;
    lastBody = null;
    clearOverlay();
    if (st.status !== 'error') setStatus('idle', 'Камера выключена', 0);
  }

  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
    closeEngine(engine);
    engine = null;
    enginePromise = null;
    perf.arrivals.length = 0;
  }

  return { start, calibrate, read, getStatus, configure, stop, dispose, getPose, getHands, getStick };
}
