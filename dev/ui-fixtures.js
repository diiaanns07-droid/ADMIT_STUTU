/*
 * ASHEN OATH — ui-fixtures.js
 * Набор тестовых viewModel для быстрой проверки всех состояний ui.js.
 * API_VERSION = ASHEN_V1. Файл не нужен в релизной сборке.
 *
 *   import { FIXTURES, fixture, makeSnapshot } from './ui-fixtures.js';
 *   ui.update(fixture('paused-lost'));
 */

import { createProgression } from '../core/progression.js';
import { createCoachStats, compareCoach, compactSummary } from '../core/gestureCoach.js';

export const API_VERSION = 'ASHEN_V1';

// [ASHEN_V2] прогресс героя для экранов «Клятва героя» и «Тренировка» — из настоящего модуля
function progressView(pushups, buys, embers = []) {
  const p = createProgression({ storage: null });
  p.addPushups(pushups);
  for (const e of embers) p.lightEmber(e);
  for (const id of buys) p.buy(id);
  return { ...p.getView(), emberTotal: 5 };
}
const PROGRESS_MID = progressView(31, ['vitality', 'vitality', 'spark', 'stride', 'ward'], ['ember-0', 'ember-2']);
const PROGRESS_NEW = progressView(0, []);

// [ТВИСТ «ОШИБКА»] итог боя из настоящей статистики: удачи/ошибки по жестам и прошлый бой для сравнения
function coachEnd(goods, mistakes, prevGoods, prevMistakes) {
  const make = (g, m) => {
    const s = createCoachStats();
    for (const [k, n] of Object.entries(g)) for (let i = 0; i < n; i++) s.success(k);
    for (const [k, n] of Object.entries(m)) for (let i = 0; i < n; i++) s.mistake(k);
    return s.summary();
  };
  const cur = make(goods, mistakes);
  const prev = prevGoods ? compactSummary(make(prevGoods, prevMistakes), 0) : null;
  return { ...cur, prev, compare: compareCoach(cur, prev) };
}
const COACH_WIN = coachEnd(
  { attack: 14, shield: 6, burst: 5, rune: 4, spark: 3, throw: 2 },
  { ok_ring_open: 4, shield_push: 2, burst_short: 1, rune_open: 2, hand_edge: 1 },
  { attack: 9, shield: 3, burst: 4, rune: 2, spark: 3 },
  { ok_ring_open: 6, shield_push: 4, shield_palm: 2, burst_short: 2, rune_open: 3 },
);
const COACH_LOSS = coachEnd(
  { attack: 7, shield: 1, burst: 2, spark: 1 },
  { shield_push: 5, shield_palm: 3, ok_ring_open: 3, ok_fingers: 2, burst_slow: 2, steer_low: 1 },
);

export const DEFAULT_SETTINGS = Object.freeze({ quality: 'medium', volume: 0.8, reducedMotion: false, sensitivity: 1 });

const ALL_PARTS = {
  head: true,
  leftShoulder: true,
  rightShoulder: true,
  leftElbow: true,
  rightElbow: true,
  leftWrist: true,
  rightWrist: true,
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** Снимок боя в форме контракта ASHEN_V1 (Snapshot). */
export function makeSnapshot(over = {}) {
  const base = {
    status: 'playing',
    time: 42.5,
    player: {
      position: { x: 0, y: 0, z: 6 },
      yaw: Math.PI,
      hp: 82,
      maxHp: 100,
      energy: 64,
      maxEnergy: 100,
      action: 'idle',
      invulnerable: false,
      shielding: false,
    },
    boss: {
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      hp: 710,
      maxHp: 1000,
      stage: 1,
      action: 'idle',
    },
    cooldowns: { dashRemaining: 0, dashTotal: 1.2, burstRemaining: 0, burstTotal: 8 },
    projectiles: [],
    telegraphs: [],
    stats: { damageDealt: 290, damageTaken: 18, dodges: 3, blocks: 2 },
  };
  return merge(base, over);
}

function vm(over = {}) {
  return merge(
    {
      screen: 'menu',
      snapshot: null,
      tracking: { status: 'idle', message: '', progress: 0, confidence: 0 },
      debug: false,
      settings: { ...DEFAULT_SETTINGS },
      error: null,
    },
    over,
  );
}

const READY = { status: 'ready', message: '', progress: 1, confidence: 0.86, calibrated: true, parts: { ...ALL_PARTS } };
const LOST = { status: 'lost', message: 'Поза не найдена в кадре', progress: 1, confidence: 0.08, calibrated: true };

export const FIXTURES = {
  menu: vm(),
  'menu-debug': vm({ debug: true }),

  'camera-idle': vm({ screen: 'camera' }),
  'camera-permission': vm({ screen: 'camera', tracking: { status: 'permission', message: 'Запрос доступа к камере' } }),
  'camera-loading': vm({ screen: 'camera', tracking: { status: 'loading', message: 'Загрузка pose_landmarker_lite.task', progress: 0.45 } }),
  'camera-error-denied': vm({
    screen: 'camera',
    tracking: { status: 'error', message: 'NotAllowedError: Permission denied' },
    error: 'NotAllowedError: Permission denied',
  }),
  'camera-ready': vm({ screen: 'camera', tracking: { status: 'ready', confidence: 0.82, parts: { ...ALL_PARTS } } }),

  'calibration-ready': vm({ screen: 'calibration', tracking: { status: 'ready', confidence: 0.78, calibrated: false, parts: { ...ALL_PARTS } } }),
  'calibration-progress': vm({
    screen: 'calibration',
    tracking: { status: 'calibrating', message: 'Держите нейтральную позу', progress: 0.55, confidence: 0.8, parts: { ...ALL_PARTS } },
  }),
  'calibration-partial': vm({
    screen: 'calibration',
    tracking: { status: 'ready', confidence: 0.52, calibrated: false, parts: { ...ALL_PARTS, leftWrist: false, rightWrist: false } },
  }),
  'calibration-lost': vm({ screen: 'calibration', tracking: { status: 'lost', message: 'Поза не найдена в кадре', confidence: 0.05, calibrated: false } }),
  'calibration-done': vm({ screen: 'calibration', tracking: { ...READY } }),

  'tutorial-waiting': vm({ screen: 'tutorial', tracking: { ...LOST } }),
  'tutorial-ready': vm({ screen: 'tutorial', tracking: { ...READY } }),
  'tutorial-live': vm({
    screen: 'tutorial',
    tracking: { ...READY },
    input: { source: 'cv', valid: true, calibrated: true, tMs: 1000, moveX: 0.62, dash: 0, attack: true, shield: false, burst: false },
  }),
  'tutorial-debug': vm({ screen: 'tutorial', debug: true, tracking: { status: 'idle' } }),

  playing: vm({
    screen: 'playing',
    tracking: { ...READY },
    snapshot: makeSnapshot({
      cooldowns: { dashRemaining: 0.7, dashTotal: 1.2, burstRemaining: 3.4, burstTotal: 8 },
      telegraphs: [
        {
          id: 't1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 1.2, y: 0, z: 5.6 },
          radius: 2.4, remaining: 0.8, duration: 1.4, blockable: true,
        },
      ],
    }),
  }),
  'playing-stage2-lowhp': vm({
    screen: 'playing',
    tracking: { status: 'ready', confidence: 0.55, calibrated: true },
    snapshot: makeSnapshot({
      time: 131,
      player: { hp: 19, energy: 12, action: 'shield', shielding: true },
      boss: { hp: 380, stage: 2, action: 'windup' },
      cooldowns: { dashRemaining: 0, dashTotal: 1.2, burstRemaining: 0, burstTotal: 8 },
      telegraphs: [
        {
          id: 't7', kind: 'nova', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 },
          radius: 5, remaining: 1.1, duration: 1.6, blockable: false,
        },
      ],
      stats: { damageDealt: 620, damageTaken: 81, dodges: 7, blocks: 5 },
    }),
  }),
  'playing-debug': vm({
    screen: 'playing',
    debug: true,
    tracking: { status: 'idle' },
    input: { source: 'debug', valid: true, calibrated: false, tMs: 1000, moveX: -1, dash: 0, attack: true, shield: false, burst: false },
    snapshot: makeSnapshot({ player: { action: 'move' } }),
  }),
  'playing-lost': vm({ screen: 'playing', tracking: { ...LOST }, snapshot: makeSnapshot() }),

  'paused-user': vm({ screen: 'paused', pauseReason: 'user', tracking: { ...READY }, snapshot: makeSnapshot() }),
  'paused-lost': vm({ screen: 'paused', pauseReason: 'tracking', tracking: { ...LOST }, snapshot: makeSnapshot() }),
  'paused-restored': vm({ screen: 'paused', pauseReason: 'tracking', tracking: { ...READY }, snapshot: makeSnapshot() }),
  'paused-debug': vm({ screen: 'paused', debug: true, pauseReason: 'user', tracking: { status: 'idle' }, snapshot: makeSnapshot() }),

  victory: vm({
    screen: 'victory',
    tracking: { ...READY },
    snapshot: makeSnapshot({
      status: 'victory',
      time: 167.4,
      player: { hp: 46 },
      boss: { hp: 0, stage: 2, action: 'dead' },
      stats: { damageDealt: 1000, damageTaken: 54, dodges: 9, blocks: 6 },
    }),
    coach: COACH_WIN,
  }),
  defeat: vm({
    screen: 'defeat',
    tracking: { ...READY },
    snapshot: makeSnapshot({
      status: 'defeat',
      time: 98.2,
      player: { hp: 0, action: 'dead' },
      boss: { hp: 420, stage: 2, action: 'idle' },
      stats: { damageDealt: 580, damageTaken: 100, dodges: 2, blocks: 0 },
    }),
    coach: COACH_LOSS,
  }),

  'error-webgl': vm({ screen: 'error', error: 'WebGL: Error creating WebGL context.' }),
  'error-model': vm({
    screen: 'error',
    error: 'TypeError: Failed to fetch (pose_landmarker_lite.task)\n    at loadModel (vision.js:120:11)\n    at async start (vision.js:88:5)',
  }),
  'error-secure': vm({ screen: 'error', error: 'SecurityError: getUserMedia requires a secure context' }),

  oath: vm({ screen: 'oath', progress: PROGRESS_MID }),
  'oath-new': vm({ screen: 'oath', progress: PROGRESS_NEW }),
  'training-idle': vm({ screen: 'training', progress: PROGRESS_NEW, training: { reps: 0, state: 'noPose', message: 'Не видно плеч и кистей — поставьте камеру так, чтобы они были в кадре', depth: 0 } }),
  'training-live': vm({
    screen: 'training', tracking: { ...READY }, progress: PROGRESS_MID,
    training: { reps: 7, state: 'down', message: '7', depth: 0.64, lastOk: true, sinceRepMs: 200 },
  }),
  'training-squat-fault': vm({
    screen: 'training', tracking: { ...READY }, progress: PROGRESS_MID,
    training: {
      exercise: 'squats', reps: 4, attempts: 6, state: 'bottom', message: '', depth: 0.92, knee: 104, view: 'front',
      lastOk: false, sinceRepMs: 4000, lastHint: { code: 'valgus', text: 'Колени заваливаются внутрь — разводи их в стороны, по линии носков', tMs: 1 }, sinceHintMs: 300,
      faults: { shallow: 1, valgus: 1 }, formScore: 0.667, topFault: { code: 'shallow', text: 'Садись глубже — бёдра до параллели с полом', count: 1 },
    },
  }),
  'training-squat-clean': vm({
    screen: 'training', tracking: { ...READY }, progress: PROGRESS_MID,
    training: { exercise: 'squats', reps: 5, attempts: 5, state: 'top', message: '5', depth: 0, knee: 176, view: 'side', lastOk: true, sinceRepMs: 300, lastHint: null, sinceHintMs: null, faults: {}, formScore: 1, topFault: null },
  }),
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** Глубокая копия фикстуры с необязательными переопределениями. */
export function fixture(name, over) {
  const base = FIXTURES[name];
  if (!base) throw new Error(`Нет фикстуры ${name}`);
  const copy = JSON.parse(JSON.stringify(base));
  return over ? merge(copy, over) : copy;
}
