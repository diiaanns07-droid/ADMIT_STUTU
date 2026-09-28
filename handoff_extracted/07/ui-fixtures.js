/*
 * ASHEN OATH — ui-fixtures.js
 * Набор тестовых viewModel для быстрой проверки всех состояний ui.js.
 * API_VERSION = ASHEN_V1. Файл не нужен в релизной сборке.
 *
 *   import { FIXTURES, fixture, makeSnapshot } from './ui-fixtures.js';
 *   ui.update(fixture('paused-lost'));
 */

export const API_VERSION = 'ASHEN_V1';

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
  }),

  'error-webgl': vm({ screen: 'error', error: 'WebGL: Error creating WebGL context.' }),
  'error-model': vm({
    screen: 'error',
    error: 'TypeError: Failed to fetch (pose_landmarker_lite.task)\n    at loadModel (vision.js:120:11)\n    at async start (vision.js:88:5)',
  }),
  'error-secure': vm({ screen: 'error', error: 'SecurityError: getUserMedia requires a secure context' }),
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** Глубокая копия фикстуры с необязательными переопределениями. */
export function fixture(name, over) {
  const base = FIXTURES[name];
  if (!base) throw new Error(`Нет фикстуры ${name}`);
  const copy = JSON.parse(JSON.stringify(base));
  return over ? merge(copy, over) : copy;
}
