/*
 * ASHEN OATH — vision-worker.js
 * API_VERSION=ASHEN_V1 · роль №2. Module worker для MediaPipe Pose Landmarker.
 *
 * Создаётся из vision.js: new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' }).
 * Своих URL MediaPipe здесь нет: moduleUrl / wasmRoot / modelUrl приходят в сообщении init
 * из config.mediaPipe главного модуля, поэтому версия библиотеки везде одна.
 *
 * Протокол (главный поток → worker):
 *   { type:'init', apiVersion, mp:{moduleUrl, wasmRoot, modelUrl}, delegate:'GPU'|'CPU', options }
 *   { type:'frame', seq, tMs, w, h, bitmap:ImageBitmap }   // bitmap передаётся (transfer)
 *   { type:'close' }
 * worker → главный поток:
 *   { type:'progress', stage:'module'|'wasm'|'model'|'warmup', progress }
 *   { type:'ready', delegate, warmupMs, fallbackFrom }
 *   { type:'init-error', message }
 *   { type:'result', seq, tMs, w, h, inferMs, landmarks:Float32Array|null } // Float32Array передаётся
 *   { type:'frame-error', seq, message }
 *
 * Самопроверка: ready отправляется только после загрузки JS-модуля, WASM, модели и
 * успешного пробного detectForVideo в этом окружении. Иначе — init-error, и vision.js
 * переходит в главный поток. Каждый полученный ImageBitmap закрывается в finally.
 */

import { API_VERSION, COMPACT_INDICES, COMPACT_STRIDE } from './vision.js';

let landmarker = null;
let readyDelegate = null;
let lastTs = 0;
let initState = 'none'; // none | loading | ready | failed | closed

const post = (msg, transfer) => {
  try { self.postMessage(msg, transfer || []); } catch (e) { /* главный поток уже завершил worker */ }
};
const errText = (e) => String((e && (e.message || e.name)) || e || 'неизвестная ошибка');

// GPU-делегату нужен WebGL2 на OffscreenCanvas внутри worker; иначе сразу CPU.
function hasWebGL2() {
  try {
    if (typeof OffscreenCanvas !== 'function') return false;
    const c = new OffscreenCanvas(1, 1);
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ext = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_lose_context') : null;
    if (ext && typeof ext.loseContext === 'function') ext.loseContext();
    return true;
  } catch {
    return false;
  }
}

// Пробный кадр: первый detect на GPU компилирует шейдеры; заодно проверяет, что
// ImageBitmap действительно принимается моделью в этом окружении.
function warmup(lm) {
  if (typeof OffscreenCanvas !== 'function') throw new Error('в worker нет OffscreenCanvas');
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext('2d');
  if (!g) throw new Error('в worker нет 2D-контекста OffscreenCanvas');
  g.fillStyle = '#777';
  g.fillRect(0, 0, 64, 64);
  const bmp = c.transferToImageBitmap();
  let res = null;
  try {
    res = lm.detectForVideo(bmp, 1);
  } finally {
    try { if (res && typeof res.close === 'function') res.close(); } catch { /* ignore */ }
    try { bmp.close(); } catch { /* ignore */ }
  }
  lastTs = 1;
}

async function init(msg) {
  if (initState !== 'none') throw new Error(`повторный init (состояние ${initState})`);
  initState = 'loading';
  if (msg.apiVersion !== API_VERSION) throw new Error(`несовпадение API: ${msg.apiVersion} ≠ ${API_VERSION}`);
  const mp = msg.mp || {};
  if (!mp.moduleUrl || !mp.wasmRoot || !mp.modelUrl) throw new Error('в init нет URL MediaPipe');

  post({ type: 'progress', stage: 'module', progress: 0.35 });
  const mod = await import(mp.moduleUrl);
  const { FilesetResolver, PoseLandmarker } = mod;
  if (!FilesetResolver || !PoseLandmarker) throw new Error('в модуле MediaPipe нет FilesetResolver/PoseLandmarker');

  post({ type: 'progress', stage: 'wasm', progress: 0.45 });
  // true → vision_wasm_module_internal.js: ES-модульный загрузчик. В module worker нет
  // рабочего importScripts, а классический загрузчик рассчитан именно на него.
  const fileset = await FilesetResolver.forVisionTasks(mp.wasmRoot, true);

  const webgl2 = hasWebGL2();
  const order = msg.delegate === 'CPU' ? ['CPU'] : webgl2 ? ['GPU', 'CPU'] : ['CPU'];
  const notes = [];
  if (msg.delegate !== 'CPU' && !webgl2) notes.push('GPU: нет WebGL2 в worker');
  const opts = msg.options && typeof msg.options === 'object' ? msg.options : {};
  let lastErr = null;
  for (const delegate of order) {
    let lm = null;
    try {
      post({ type: 'progress', stage: 'model', progress: 0.6 });
      lm = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: mp.modelUrl, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: opts.minPoseDetectionConfidence,
        minPosePresenceConfidence: opts.minPosePresenceConfidence,
        minTrackingConfidence: opts.minTrackingConfidence,
        outputSegmentationMasks: false,
      });
      post({ type: 'progress', stage: 'warmup', progress: 0.85 });
      const t0 = performance.now();
      warmup(lm);
      const warmupMs = performance.now() - t0;
      if (initState === 'closed') { try { lm.close(); } catch { /* ignore */ } return; }
      landmarker = lm;
      readyDelegate = delegate;
      initState = 'ready';
      post({ type: 'ready', delegate, warmupMs, fallbackFrom: notes.length ? notes.join('; ') : null });
      return;
    } catch (e) {
      lastErr = e;
      notes.push(`${delegate}: ${errText(e)}`);
      try { if (lm) lm.close(); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error('не удалось создать PoseLandmarker');
}

function onFrame(msg) {
  const bmp = msg.bitmap;
  let res = null;
  try {
    if (initState !== 'ready' || !landmarker) throw new Error('worker не готов');
    if (!bmp) throw new Error('кадр без bitmap');
    // Метки VIDEO-режима должны строго расти.
    const ts = Math.max(lastTs + 1, Math.round(Number(msg.tMs) || 0));
    lastTs = ts;
    const t0 = performance.now();
    res = landmarker.detectForVideo(bmp, ts);
    const inferMs = performance.now() - t0;
    const pose = res && res.landmarks && res.landmarks.length ? res.landmarks[0] : null;
    let out = null;
    if (pose && pose.length > COMPACT_INDICES[COMPACT_INDICES.length - 1]) {
      out = new Float32Array(COMPACT_INDICES.length * COMPACT_STRIDE);
      for (let k = 0; k < COMPACT_INDICES.length; k++) {
        const p = pose[COMPACT_INDICES[k]];
        const o = k * COMPACT_STRIDE;
        if (p) {
          out[o] = p.x; out[o + 1] = p.y; out[o + 2] = p.z;
          out[o + 3] = typeof p.visibility === 'number' ? p.visibility : 0;
        } else {
          out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN; out[o + 3] = 0;
        }
      }
    }
    post({ type: 'result', seq: msg.seq, tMs: msg.tMs, w: msg.w, h: msg.h, inferMs, landmarks: out }, out ? [out.buffer] : []);
  } catch (e) {
    post({ type: 'frame-error', seq: msg.seq, message: errText(e) });
  } finally {
    try { if (res && typeof res.close === 'function') res.close(); } catch { /* ignore */ }
    try { if (bmp && typeof bmp.close === 'function') bmp.close(); } catch { /* ignore */ }
  }
}

function shutdown() {
  initState = 'closed';
  try { if (landmarker) landmarker.close(); } catch { /* ignore */ }
  landmarker = null;
  readyDelegate = null;
  try { if (typeof self.close === 'function') self.close(); } catch { /* ignore */ }
}

self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'frame') onFrame(msg);
  else if (msg.type === 'init') {
    init(msg).catch((e) => {
      if (initState === 'closed') return;
      initState = 'failed';
      post({ type: 'init-error', message: errText(e) });
    });
  } else if (msg.type === 'close') shutdown();
  else if (msg.bitmap && typeof msg.bitmap.close === 'function') {
    try { msg.bitmap.close(); } catch { /* ignore */ }
  }
});

// Ошибка без обработчика во время загрузки тоже означает непройденную самопроверку.
self.addEventListener('unhandledrejection', (ev) => {
  if (initState === 'loading' || initState === 'none') {
    initState = 'failed';
    post({ type: 'init-error', message: `необработанная ошибка: ${errText(ev && ev.reason)}` });
  }
});
