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

// [W3-CHALLENGE] итоги «Испытания · 60 с»: зал славы дня из 11 попыток, своя запись — 'me'
const HALL_DAY = [['ТИМ', 12380, 'S', 93], ['АНЯ', 9120, 'A', 91], ['ДАН', 7410, 'A', 84], ['ЖАН', 6950, 'B', 80], ['ЕВА', 6020, 'B', 77],
  ['', 5480, 'B', 82], ['МИР', 4410, 'B', 71], ['ОЛЯ', 3950, 'C', 69], ['КАЙ', 2870, 'C', 64], ['ЛЕВ', 2110, 'C', 58], ['ИЯ', 1340, 'D', 52]]
  .map(([name, score, rank, acc], i) => ({ id: i === 5 ? 'me' : `h${i}`, name, score, rank, acc, mode: i === 2 ? 'master' : 'novice', t: i, day: '2026-10-02', dmg: Math.round(score / 13), combo: 12, hero: 'ashen', won: score > 12000 }));
function challengeVm(record) {
  const parts = record
    ? [['damage', 'Урон', '700', 7000], ['combo', 'Лучшая серия', '×38', 1140], ['accuracy', 'Точность жестов', '91%', 1092], ['magic', 'Магия и ультимейт', '2 чары · ультимейт ×1', 2100], ['victory', 'Регент повержен', '+17 с в запасе', 3520]]
    : [['damage', 'Урон', '412', 4120], ['combo', 'Лучшая серия', '×19', 570], ['accuracy', 'Точность жестов', '82%', 790], ['magic', 'Магия и ультимейт', '—', 0]];
  const score = parts.reduce((a, p) => a + p[3], 0);
  const hall = record ? [{ ...HALL_DAY[5], name: 'ДИА', score, rank: 'S', acc: 91 }, ...HALL_DAY.filter((e) => e.id !== 'me')] : HALL_DAY.map((e) => (e.id === 'me' ? { ...e, score } : e));
  return {
    result: {
      kind: 'challenge', score, rank: record ? 'S' : 'B', rankTitle: record ? 'Легенда арены' : 'Страж', outcome: record ? 'victory' : 'timeup', elapsed: record ? 43 : 60,
      parts: parts.map(([id, label, detail, points]) => ({ id, label, detail, points })), next: record ? null : { id: 'A', need: 7000 - score },
      place: record ? 1 : 6, total: 11, isRecord: record, entryId: 'me', name: record ? 'ДИА' : '', named: record,
    },
    hall, best: hall[0], posterUrl: '',
  };
}

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
  // [W3-CHALLENGE] итоги испытания: ввод имени (6-е место из 11) и рекорд дня с именем
  challenge: vm({ screen: 'challenge', tracking: { ...READY }, challenge: challengeVm(false) }),
  'challenge-record': vm({ screen: 'challenge', tracking: { ...READY }, challenge: challengeVm(true) }),

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
  // [W3-SQUAT] подготовка: ноутбук на столе, стопы не в кадре — «вижу до колен ✓» и совет; «Новичок»: засчитан с ошибкой
  'training-squat-prep': vm({
    screen: 'training', tracking: { ...READY }, progress: PROGRESS_MID,
    training: {
      exercise: 'squats', mode: 'novice', reps: 0, attempts: 0, state: 'top', message: 'Готово — приседай!', depth: 0, knee: 171, view: 'front', feet: false,
      lastOk: null, sinceRepMs: 1e9, lastHint: null, sinceHintMs: null, faults: {}, formScore: null, topFault: null, clean: 0, points: 0,
      framing: { full: false, upper: true, ready: true, readyMs: 900, status: 'okNoFeet', statusText: 'Вижу до колен ✓ — можно приседать',
        tip: { code: 'tiltDown', text: 'Стопы не в кадре — наклони экран ноутбука чуть вперёд или отойди на шаг' },
        points: { 0: { v: 0.99, ok: true }, 11: { v: 0.99, ok: true }, 12: { v: 0.99, ok: true }, 23: { v: 0.93, ok: true }, 24: { v: 0.92, ok: true }, 25: { v: 0.81, ok: true }, 26: { v: 0.78, ok: true }, 27: { v: 0.32, ok: false }, 28: { v: 0.12, ok: false } } },
      pose: { model: 'full', switching: false, hz: 15, recFrames: 450 },
    },
  }),
  'training-squat-counted': vm({
    screen: 'training', tracking: { ...READY }, progress: PROGRESS_MID,
    training: {
      exercise: 'squats', mode: 'novice', reps: 3, attempts: 3, clean: 2, points: 5, state: 'top', message: '', depth: 0, knee: 172, view: 'front', feet: false,
      lastOk: true, sinceRepMs: 400, lastHint: { code: 'fast', text: 'Слишком быстро — опускайся подконтрольно, 2 секунды вниз', tMs: 9000 }, sinceHintMs: 400,
      lastRep: { tMs: 9000, ok: true, clean: false, faults: ['fast'], minKnee: 121, ms: 640, reason: 'Слишком быстро — опускайся подконтрольно, 2 секунды вниз' },
      lastEvent: { tMs: 9000, rep: 3, clean: false, points: 1, faults: ['fast'] },
      faults: { fast: 1 }, formScore: 0.667, topFault: { code: 'fast', text: 'Слишком быстро — опускайся подконтрольно, 2 секунды вниз', count: 1 },
      framing: { full: false, upper: true, ready: true, readyMs: 9000, status: 'okNoFeet', statusText: 'Вижу до колен ✓ — можно приседать', tip: { code: 'tiltDown', text: 'Стопы не в кадре — наклони экран ноутбука чуть вперёд или отойди на шаг' }, points: {} },
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
