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
 *   { type:'result', seq, tMs, w, h, inferMs, landmarks:Float32Array|null,   // Float32Array передаётся
 *     hands:Float32Array|null, handsMeta:[{handedness, score}], handsMs }  // [№1] кисти, см. HAND_STRIDE
 *
 * [№1, «Перстни»] init может нести hands:{ modelUrl, numHands, minHandDetectionConfidence, ... }.
 * HandLandmarker создаётся на том же fileset и делегате; его сбой не валит самопроверку позы:
 * ready сообщает handsReady:false и handsError, и worker продолжает только с позой.
 *   { type:'frame-error', seq, message }
 *
 * Самопроверка: ready отправляется только после загрузки JS-модуля, WASM, модели и
 * успешного пробного detectForVideo в этом окружении. Иначе — init-error, и vision.js
 * переходит в главный поток. Каждый полученный ImageBitmap закрывается в finally.
 */

import { API_VERSION, COMPACT_INDICES, COMPACT_STRIDE } from './vision.js';

// [W3-CURSOR] служебные строки glog из WASM MediaPipe («W1002 … gl_context.cc:1118] OpenGL error checking is disabled»,
// «… landmark_projection_calculator.cc:81] Using NORM_RECT …») — не сбои игры, в консоль игрока их не пускаем.
// Только уровни I (info) и W (warning) в формате glog; E/F (ошибки) и всё остальное — как раньше.
const GLOG_NOISE = /^[IW]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+\s+[\w.-]+:\d+\]/;
for (const k of ['log', 'info', 'warn']) {
  const orig = console[k];
  if (typeof orig === 'function') console[k] = (...a) => { if (typeof a[0] === 'string' && GLOG_NOISE.test(a[0])) return; orig.apply(console, a); };
}

let landmarker = null;
let handLandmarker = null;
let readyDelegate = null;
// кисть: 21 точка image (x,y,z) + 21 точка world (x,y,z)
const HAND_POINTS = 21;
const HAND_STRIDE = HAND_POINTS * 6;
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
      const hands = await initHands(mod, fileset, delegate, msg.hands);
      if (initState === 'closed') return;
      initState = 'ready';
      post({ type: 'ready', delegate, warmupMs, fallbackFrom: notes.length ? notes.join('; ') : null, handsReady: hands.ok, handsError: hands.error, handsDelegate: hands.delegate });
      return;
    } catch (e) {
      lastErr = e;
      notes.push(`${delegate}: ${errText(e)}`);
      try { if (lm) lm.close(); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error('не удалось создать PoseLandmarker');
}

// [№1] HandLandmarker на том же fileset. Ошибка не фатальна: игра продолжает с позой.
async function initHands(mod, fileset, delegate, h) {
  if (!h || !h.modelUrl || !mod.HandLandmarker) return { ok: false, error: h && h.modelUrl ? 'в модуле нет HandLandmarker' : null, delegate: null };
  post({ type: 'progress', stage: 'hands', progress: 0.9 });
  const order = delegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];
  let lastErr = null;
  for (const d of order) {
    let lm = null;
    try {
      // MediaPipe после создания задачи обнуляет self.ModuleFactory, а модульный загрузчик WASM
      // из кэша import() повторно не выполняется → «ModuleFactory not set». Возвращаем фабрику сами.
      if (!self.ModuleFactory && fileset && fileset.wasmLoaderPath) {
        const loader = await import(fileset.wasmLoaderPath);
        self.ModuleFactory = loader.default || loader.ModuleFactory;
      }
      lm = await mod.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: h.modelUrl, delegate: d },
        runningMode: 'VIDEO',
        numHands: h.numHands || 2,
        minHandDetectionConfidence: h.minHandDetectionConfidence,
        minHandPresenceConfidence: h.minHandPresenceConfidence,
        minTrackingConfidence: h.minTrackingConfidence,
      });
      // пробный кадр (компиляция шейдеров GPU)
      const c = new OffscreenCanvas(64, 64);
      const g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 64, 64);
      const bmp = c.transferToImageBitmap();
      try { lm.detectForVideo(bmp, 2); } finally { try { bmp.close(); } catch { /* ignore */ } }
      handLandmarker = lm;
      return { ok: true, error: null, delegate: d };
    } catch (e) {
      lastErr = e;
      try { if (lm) lm.close(); } catch { /* ignore */ }
    }
  }
  return { ok: false, error: errText(lastErr), delegate: null };
}

function packHands(res) {
  const list = res && res.landmarks ? res.landmarks : [];
  const n = Math.min(2, list.length);
  if (!n) return { buf: null, meta: [] };
  const buf = new Float32Array(n * HAND_STRIDE);
  const meta = [];
  for (let i = 0; i < n; i++) {
    const img = list[i];
    const world = res.worldLandmarks && res.worldLandmarks[i];
    const o = i * HAND_STRIDE;
    for (let k = 0; k < HAND_POINTS; k++) {
      const p = img[k] || { x: NaN, y: NaN, z: NaN };
      buf[o + k * 3] = p.x; buf[o + k * 3 + 1] = p.y; buf[o + k * 3 + 2] = p.z;
      const w = world && world[k];
      const ow = o + HAND_POINTS * 3 + k * 3;
      buf[ow] = w ? w.x : NaN; buf[ow + 1] = w ? w.y : NaN; buf[ow + 2] = w ? w.z : NaN;
    }
    const cat = res.handedness && res.handedness[i] && res.handedness[i][0];
    meta.push({ handedness: cat ? cat.categoryName : null, score: cat ? cat.score : 0, world: !!world });
  }
  return { buf, meta };
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
    let hands = { buf: null, meta: [] };
    let handsMs = null;
    if (handLandmarker) {
      let hr = null;
      const h0 = performance.now();
      try {
        hr = handLandmarker.detectForVideo(bmp, ts);
        hands = packHands(hr);
      } catch (e) { /* кадр без рук; поза важнее */ }
      finally { try { if (hr && typeof hr.close === 'function') hr.close(); } catch { /* ignore */ } }
      handsMs = performance.now() - h0;
    }
    const transfer = [];
    if (out) transfer.push(out.buffer);
    if (hands.buf) transfer.push(hands.buf.buffer);
    post({ type: 'result', seq: msg.seq, tMs: msg.tMs, w: msg.w, h: msg.h, inferMs, landmarks: out, hands: hands.buf, handsMeta: hands.meta, handsMs }, transfer);
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
  try { if (handLandmarker) handLandmarker.close(); } catch { /* ignore */ }
  landmarker = null;
  handLandmarker = null;
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
