// ASHEN OATH — запись позы с живой камеры на экране тренировки для разбора счётчиков без видео.
// Чистая логика: без DOM. Пишет ровно то, что vision.getPose() отдаёт счётчикам приседаний и отжиманий
// (core/squatCounter.js, core/pushupCounter.js): время, размер кадра, зеркало и точки позы (в игре —
// 15 точек: нос, уши, плечи, локти, запястья, бёдра, колени, лодыжки). Видео не пишется — только числа
// (≈ 0,55 КБ на кадр в файле, минута при 30 кадр/с ≈ 1 МБ; в памяти — столько же, 90 с ≈ 1,5 МБ).
//
// На экране тренировки запись идёт всегда (последние 90 с в памяти): F8 — сохранить файл, когда счёт
// ошибся (запись продолжается с чистого листа). Разбор: node dev/squat_replay.mjs файл.json — повторы,
// незасчитанные попытки и причины, фазы, видимость точек; тот же файл можно прогнать в другом режиме
// (--mode novice|master) и с другими порогами (--cfg '{…}').
//
// Формат (version 1): { version, kind: 'ashen-pose', createdAt, dropped, …meta, frames: [
//   { t, w, h, m (mirror 0/1), lm: { "<индекс 0..32>": [x, y, z, vis] } } ] } — только непустые точки;
// x, y, z — до 1e-4, vis — до 1e-3. Кадр без точек (поза потеряна) тоже пишется: по нему счётчик видит потерю.

export const POSE_RECORDING_VERSION = 1;

const N = 33;
const STRIDE = 5;   // в памяти на точку: индекс, x, y, z, vis
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r3 = (v) => Math.round(v * 1e3) / 1e3;
// z и visibility могут отсутствовать (читаются как 0 и 1, как у счётчиков); нечисло или бесконечность — точка не пишется
const opt = (v, d) => (v === undefined || v === null ? d : fin(v) ? v : NaN);

function packPoint(p) {
  if (!p || typeof p !== 'object' || !fin(p.x) || !fin(p.y)) return null;
  const z = opt(p.z, 0), vis = opt(p.visibility, 1);
  if (!fin(z) || !fin(vis)) return null;
  return [r4(p.x), r4(p.y), r4(z), r3(vis)];
}

/** Сжать позу vision.getPose() ({ tMs, frameW, frameH, mirror, landmarks[33] }) в кадр записи; мусор → null. */
export function packPose(pose) {
  if (!pose || typeof pose !== 'object' || !fin(pose.tMs)) return null;
  const lm = {};
  const L = Array.isArray(pose.landmarks) ? pose.landmarks : null;
  if (L) for (let i = 0; i < Math.min(N, L.length); i++) { const a = packPoint(L[i]); if (a) lm[i] = a; }
  return {
    t: Math.round(pose.tMs * 10) / 10,
    w: fin(pose.frameW) && pose.frameW > 0 ? pose.frameW : 640, h: fin(pose.frameH) && pose.frameH > 0 ? pose.frameH : 480,
    m: pose.mirror === false ? 0 : 1, lm,
  };
}

/** Кадр записи → поза, как её отдаёт vision.getPose(): landmarks — 33 элемента, null где точки нет. */
export function unpackPoseFrame(f) {
  if (!f || typeof f !== 'object' || !fin(f.t)) return null;
  const landmarks = new Array(N).fill(null);
  const lm = f.lm && typeof f.lm === 'object' ? f.lm : {};
  for (const k of Object.keys(lm)) {
    const i = Number(k), a = lm[k];
    if (!Number.isInteger(i) || i < 0 || i >= N || !Array.isArray(a) || !fin(a[0]) || !fin(a[1])) continue;
    landmarks[i] = { x: a[0], y: a[1], z: fin(a[2]) ? a[2] : 0, visibility: fin(a[3]) ? a[3] : 1 };
  }
  return { tMs: f.t, frameW: fin(f.w) ? f.w : 640, frameH: fin(f.h) ? f.h : 480, mirror: f.m !== 0, landmarks };
}

// в памяти точки — Float32Array [индекс, x, y, z, vis, …] (15 точек — 300 байт); в файл — обычные числа
function compact(f) {
  const ks = Object.keys(f.lm);
  const a = new Float32Array(ks.length * STRIDE);
  for (let j = 0; j < ks.length; j++) {
    const p = f.lm[ks[j]], o = j * STRIDE;
    a[o] = +ks[j]; a[o + 1] = p[0]; a[o + 2] = p[1]; a[o + 3] = p[2]; a[o + 4] = p[3];
  }
  return { t: f.t, w: f.w, h: f.h, m: f.m, a };
}
function expand(c) {
  const lm = {};
  for (let o = 0; o < c.a.length; o += STRIDE) lm[c.a[o]] = [r4(c.a[o + 1]), r4(c.a[o + 2]), r4(c.a[o + 3]), r3(c.a[o + 4])];
  return { t: c.t, w: c.w, h: c.h, m: c.m, lm };
}

/** Запись в памяти: add(pose) на каждый кадр (повтор того же tMs подряд и мусор — мимо), snapshot() — объект
 *  для JSON, clear() — с чистого листа. Кольцевой буфер последних maxFrames кадров (2700 ≈ 90 с при 30 кадр/с). */
export function createPoseRecorder({ maxFrames = 2700, meta = {} } = {}) {
  const cap = fin(maxFrames) && maxFrames >= 1 ? Math.floor(maxFrames) : 2700;
  let buf, head, n, dropped, lastT;
  function clear() { buf = new Array(cap); head = 0; n = 0; dropped = 0; lastT = null; }
  clear();
  return {
    add(pose) {
      const f = packPose(pose);
      if (!f || f.t === lastT) return false;
      lastT = f.t;
      if (n < cap) buf[(head + n++) % cap] = compact(f);
      else { buf[head] = compact(f); head = (head + 1) % cap; dropped++; }
      return true;
    },
    size: () => n,
    clear,
    snapshot(extra = {}) {
      const frames = new Array(n);
      for (let i = 0; i < n; i++) frames[i] = expand(buf[(head + i) % cap]);
      return { version: POSE_RECORDING_VERSION, kind: 'ashen-pose', createdAt: new Date().toISOString(), dropped, ...meta, ...extra, frames };
    },
  };
}

/** Прочитать файл записи (строка JSON или объект) → { meta, poses[] }; чужой файл — понятная ошибка. */
export function loadPoseRecording(src) {
  let rec = src;
  if (typeof src === 'string') {
    try { rec = JSON.parse(src.replace(/^﻿/, '')); } catch (e) { throw new Error(`файл не читается как JSON (${e.message}) — нужна запись позы ashen-pose-….json`); }
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('это не запись позы ASHEN OATH: ожидался объект { kind: "ashen-pose", frames: […] }');
  if (rec.kind === 'ashen-hands') {
    throw new Error('это запись кистей (ashen-hands, её разбирает node dev/replay.mjs), а не позы. Запись позы — F8 на экране тренировки (приседания или отжимания).');
  }
  if (rec.kind !== 'ashen-pose') throw new Error(`это не запись позы ASHEN OATH (kind: ${JSON.stringify(rec.kind ?? null)}, нужен "ashen-pose")`);
  if (rec.version !== POSE_RECORDING_VERSION) throw new Error(`запись позы версии ${JSON.stringify(rec.version ?? null)}, а разбор понимает версию ${POSE_RECORDING_VERSION}`);
  if (!Array.isArray(rec.frames)) throw new Error('в записи позы нет списка кадров (frames)');
  const { frames, ...meta } = rec;
  return { meta, poses: frames.map(unpackPoseFrame).filter(Boolean) };
}
