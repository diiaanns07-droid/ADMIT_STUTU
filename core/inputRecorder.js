// ASHEN OATH — запись наблюдений кистей с живой камеры для разбора управления (V6 · [CONTROLS]).
// Чистая логика: без DOM. Пишет ровно то, что modules/vision.js отдаёт core/handGestures.js
// (push(obs)): кисти (21 точка кадра + world), запястья позы, середину и ширину плеч. Видео
// не пишется — только числа (≈1,5 КБ на кадр, минута при 30 кадр/с ≈ 3 МБ).
//
// В игре запись идёт всегда (последние 90 с в памяти): F8 — сохранить файл, когда что-то пошло не так
// (запись продолжается с чистого листа). С ?rec=1 — длинная запись (до 10 мин) и значок «● ЗАПИСЬ». Разбор: node dev/replay.mjs файл.json — где поднимался щит, рывки, остановки,
// дрожь руля; тот же файл можно прогнать с другими порогами (--cfg '{…}').
//
// Формат (version 1): { version, kind: 'ashen-hands', createdAt, moveMode, frames: [
//   { t, w, h, m (mirror 0/1), bc: [x, y] | null, sw, pw: { l: [x, y, vis] | null, r: … },
//     hs: [{ hd: 'Left'|'Right'|null, sc, lm: [x, y, z, …] (63 числа), wd: [x, y, z, …] | null }] } ] }

export const RECORDING_VERSION = 1;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

function flat(points, round) {
  if (!Array.isArray(points) || points.length < 21) return null;
  const out = new Array(63);
  for (let i = 0; i < 21; i++) {
    const p = points[i];
    if (!p || !fin(p.x) || !fin(p.y)) return null;
    out[i * 3] = round(p.x); out[i * 3 + 1] = round(p.y); out[i * 3 + 2] = round(fin(p.z) ? p.z : 0);
  }
  return out;
}
function unflat(arr) {
  if (!Array.isArray(arr) || arr.length < 63) return null;
  const out = new Array(21);
  for (let i = 0; i < 21; i++) out[i] = { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
  return out;
}
const wrist = (w) => (w && fin(w.x) && fin(w.y) ? [r4(w.x), r4(w.y), fin(w.visibility) ? r4(w.visibility) : 1] : null);

/** Сжать наблюдение handGestures.push(obs) в кадр записи. */
export function packObservation(obs) {
  if (!obs || !fin(obs.tMs)) return null;
  const hs = [];
  for (const h of Array.isArray(obs.hands) ? obs.hands.slice(0, 2) : []) {
    if (!h) continue;
    const lm = flat(h.landmarks, r4);
    if (!lm) continue;
    hs.push({ hd: h.handedness === 'Left' || h.handedness === 'Right' ? h.handedness : null, sc: fin(h.score) ? r4(h.score) : null, lm, wd: flat(h.world, r5) });
  }
  const pw = obs.poseWrists || {};
  const bc = obs.bodyCenter && fin(obs.bodyCenter.x) && fin(obs.bodyCenter.y) ? [r4(obs.bodyCenter.x), r4(obs.bodyCenter.y)] : null;
  return {
    t: Math.round(obs.tMs * 10) / 10, w: fin(obs.frameW) ? obs.frameW : 640, h: fin(obs.frameH) ? obs.frameH : 480, m: obs.mirror === false ? 0 : 1,
    bc, sw: fin(obs.shoulderWidth) ? r4(obs.shoulderWidth) : null, pw: { l: wrist(pw.left), r: wrist(pw.right) }, hs,
  };
}

/** Кадр записи → наблюдение для handGestures.push(obs). */
export function unpackFrame(f) {
  if (!f || !fin(f.t)) return null;
  const w = (a) => (Array.isArray(a) ? { x: a[0], y: a[1], visibility: a[2] } : null);
  return {
    tMs: f.t, frameW: f.w, frameH: f.h, mirror: f.m !== 0,
    hands: (f.hs || []).map((h) => ({ landmarks: unflat(h.lm), world: unflat(h.wd), handedness: h.hd, score: fin(h.sc) ? h.sc : undefined })).filter((h) => h.landmarks),
    poseWrists: { left: w(f.pw && f.pw.l), right: w(f.pw && f.pw.r) },
    bodyCenter: Array.isArray(f.bc) ? { x: f.bc[0], y: f.bc[1] } : null,
    shoulderWidth: fin(f.sw) ? f.sw : null,
  };
}

// в памяти точки кистей — Float32Array (≈1 КБ на кисть вместо ≈3 КБ массивов); в файл — обычные числа
const compact = (f) => ({ ...f, hs: f.hs.map((h) => ({ ...h, lm: Float32Array.from(h.lm), wd: h.wd ? Float32Array.from(h.wd) : null })) });
const expand = (f) => ({ ...f, hs: f.hs.map((h) => ({ ...h, lm: Array.from(h.lm, r4), wd: h.wd ? Array.from(h.wd, r5) : null })) });

/** Запись в памяти: add(obs) на каждый кадр, snapshot() — объект для JSON, clear() — с чистого листа. */
export function createInputRecorder({ maxFrames = 18000, meta = {} } = {}) {
  let frames = [];
  let dropped = 0;
  return {
    add(obs) {
      const f = packObservation(obs);
      if (!f) return;
      frames.push(compact(f));
      if (frames.length > maxFrames) { frames.shift(); dropped++; }
    },
    size: () => frames.length,
    clear() { frames = []; dropped = 0; },
    snapshot(extra = {}) {
      return { version: RECORDING_VERSION, kind: 'ashen-hands', createdAt: new Date().toISOString(), dropped, ...meta, ...extra, frames: frames.map(expand) };
    },
  };
}
