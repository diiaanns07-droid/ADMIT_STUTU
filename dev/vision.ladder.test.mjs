/*
 * ASHEN OATH — vision.ladder.test.mjs · [W5-КАМЕРА]
 * Запуск: node dev/vision.ladder.test.mjs   (Node 18+, без зависимостей)
 *
 * Лестница отката распознавания на МЕДЛЕННОМ воркере: воркер GPU → воркер CPU → главный поток GPU →
 * главный поток CPU, таймауты под слабую встроенную видеокарту, тексты статуса на экране камеры.
 * Владелец игры: «игра не видит камеру» — воркер молчал на прогреве GPU 30 с, потом главный поток и
 * «Нет новых кадров с камеры». Здесь задержки воркера 1–5 с:
 *   • прогрев (пробный кадр) — в настоящем времени (таймер инициализации vision.js — setTimeout);
 *   • ответы на кадры — в поддельных часах (сторож vision.js считает время кадра по performance.now).
 * Настоящий vision-worker.js исполняется в этом же процессе с поддельным MediaPipe — как в dev/vision.test.mjs.
 */

const V = await import('../modules/vision.js');
const { createVision, DEFAULT_VISION_CONFIG } = V;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(cond, msg) { if (!cond) throw new Error(msg || 'условие не выполнено'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ожидалось равенство'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ───────────────────── синтетическая поза (как в dev/vision.test.mjs) ─────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) { const u = Math.max(1e-12, rng()); const v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function makeLandmarks(rng) {
  const n = () => 0.0015 * gauss(rng);
  const cx = 0.5, shY = 0.55, sw = 0.26;
  const out = [];
  for (let i = 0; i < 33; i++) out.push({ x: cx + n(), y: 0.95, z: 0, visibility: 0.3 });
  out[0] = { x: cx + n(), y: shY - 0.25 + n(), z: -0.2, visibility: 0.99 };
  const arm = (dir) => ({
    sh: { x: cx + dir * sw / 2 + n(), y: shY + n(), z: 0, visibility: 0.99 },
    el: { x: cx + dir * sw * 0.65 + n(), y: shY + 0.2 + n(), z: 0, visibility: 0.95 },
    wr: { x: cx + dir * sw * 0.6 + n(), y: shY + 0.33 + n(), z: 0, visibility: 0.95 },
  });
  const R = arm(-1), L = arm(1);
  out[12] = R.sh; out[14] = R.el; out[16] = R.wr;
  out[11] = L.sh; out[13] = L.el; out[15] = L.wr;
  return out;
}

// ───────────────────── поддельные браузерные API ─────────────────────
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await flush(); }
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = { t: 80000 };

const gfx = { bitmaps: [] };
function fakeBitmap(tag, w = 640, h = 480) {
  const b = { tag, width: w, height: h, closed: false, __bitmap: true, close() { this.closed = true; } };
  gfx.bitmaps.push(b);
  return b;
}
class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext(type) {
    if (type === '2d') return { fillStyle: '', fillRect() {}, clearRect() {} };
    if (type === 'webgl2') return { getExtension: () => ({ loseContext() {} }) };
    return null;
  }
  transferToImageBitmap() { return fakeBitmap('warmup', this.width, this.height); }
}

// Поддельный MediaPipe (ES-модуль по data: URL); поведение — через globalThis.__fakeMP.
const FAKE_MP_SRC = `
const H = () => globalThis.__fakeMP;
export const FilesetResolver = { async forVisionTasks(root, useModule) { return { wasmLoaderPath: root + (useModule ? '/m.js' : '/c.js') }; } };
export const PoseLandmarker = {
  async createFromOptions(fileset, opts) {
    const h = H(); const d = opts.baseOptions.delegate;
    h.calls.push({ fn: 'create', delegate: d });
    if (h.failCreate && h.failCreate(d)) throw new Error('fake create failure ' + d);
    const inst = { delegate: d, closed: false, detectForVideo(src, ts) { return h.detect(src, ts, inst); }, close() { inst.closed = true; } };
    return inst;
  },
};`;
const FAKE_MP = {
  moduleUrl: 'data:text/javascript;base64,' + Buffer.from(FAKE_MP_SRC).toString('base64'),
  wasmRoot: 'https://fake.invalid/npm/@mediapipe/tasks-vision@0.10.35/wasm',
  modelUrl: 'https://fake.invalid/pose_landmarker_lite.task',
};
function resetFakeMP(over = {}) {
  const rng = mulberry32(7);
  const h = {
    calls: [], detects: [],
    detect(src, ts, inst) {
      h.detects.push({ delegate: inst.delegate, main: !src.__bitmap });
      if (h.onDetect) h.onDetect(src, ts, inst);
      if (h.detectThrows && h.detectThrows(src, inst)) throw new Error('fake detect failure ' + inst.delegate);
      const r = { landmarks: [makeLandmarks(rng)], worldLandmarks: [], close() {} };
      return r;
    },
    ...over,
  };
  globalThis.__fakeMP = h;
  return h;
}

function setGlobals(map) {
  const saved = {};
  for (const [k, v] of Object.entries(map)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    if (v === undefined) delete globalThis[k];
    else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: false });
  }
  return () => { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } };
}

let importSeq = 0;
function makeScope() {
  const scope = {
    listeners: {},
    addEventListener(t, fn) { (scope.listeners[t] ||= []).push(fn); },
    postMessage(msg, transfer) { if (scope.onPost) scope.onPost(msg, transfer || []); },
    close() {},
    send(data) { globalThis.self = scope; for (const fn of scope.listeners.message || []) fn({ data }); },
  };
  return scope;
}

// Медленный воркер. Исполняет настоящий vision-worker.js; задержки — хуками:
//   hooks.initDelayMs(msg, delegate) — настоящие мс до доставки сообщения инициализации (прогрев = после 'warmup');
//   hooks.frameDelayMs(delegate, n)  — мс ПОДДЕЛЬНЫХ часов до ответа на n-й кадр этого воркера (Infinity — молчит).
class SlowWorker {
  static created = [];
  static hooks = {};
  static held = [];
  static reset() { SlowWorker.created = []; SlowWorker.hooks = {}; SlowWorker.held = []; }
  // ответы, чьё время по поддельным часам наступило
  static deliverDue() {
    const due = SlowWorker.held.filter((h) => !h.w.terminated && clock.t >= h.dueT);
    SlowWorker.held = SlowWorker.held.filter((h) => !due.includes(h) && !h.w.terminated);
    for (const h of due) h.w.emit(h.msg);
  }
  constructor(url, opts) {
    SlowWorker.created.push(this);
    this.url = String(url); this.opts = opts; this.listeners = {}; this.terminated = false;
    this.delegate = null; this.warmedUp = false; this.frames = 0; this.sentAt = new Map();
    const scope = makeScope();
    scope.onPost = (msg) => {
      if (this.terminated) return;
      if (msg.type === 'progress' && msg.stage === 'warmup') this.warmedUp = true;
      if (msg.type === 'result' || msg.type === 'frame-error') {
        const n = ++this.frames;
        const d = SlowWorker.hooks.frameDelayMs ? SlowWorker.hooks.frameDelayMs(this.delegate, n) : 0;
        if (d > 0) { SlowWorker.held.push({ w: this, msg, dueT: (this.sentAt.get(msg.seq) ?? clock.t) + d }); return; }
        setTimeout(() => this.emit(msg), 0);
        return;
      }
      // сообщения инициализации после 'warmup' (кисти, ready, init-error) приходят, когда закончится прогрев
      const afterWarmup = this.warmedUp && !(msg.type === 'progress' && msg.stage === 'warmup');
      const d = afterWarmup && SlowWorker.hooks.initDelayMs ? SlowWorker.hooks.initDelayMs(msg, this.delegate) : 0;
      setTimeout(() => this.emit(msg), d || 0);
    };
    this.scope = scope;
    this.loaded = (async () => { globalThis.self = scope; await import(`../modules/vision-worker.js?ladder=${++importSeq}`); })();
  }
  emit(msg) { if (!this.terminated) for (const fn of (this.listeners.message || []).slice()) fn({ data: msg }); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  postMessage(msg) {
    if (this.terminated) { if (msg.bitmap) msg.bitmap.close(); return; }
    if (msg.type === 'init') this.delegate = msg.delegate;
    if (msg.type === 'frame') this.sentAt.set(msg.seq, clock.t);
    this.loaded.then(() => setTimeout(() => {
      if (this.terminated) { if (msg.bitmap) msg.bitmap.close(); return; }
      this.scope.send(msg);
    }, 0), () => {});
  }
  terminate() { this.terminated = true; }
}

function makeEnv(o = {}) {
  const env = { statuses: [], framesOn: true, nextFrame: clock.t, captures: 0 };
  const track = { readyState: 'live', stop() {}, getSettings: () => ({ width: 640, height: 480, frameRate: 30 }), addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  env.mediaDevices = { async getUserMedia() { if (o.gumError) throw Object.assign(new Error(o.gumError), { name: o.gumError }); return stream; } };
  env.video = {
    readyState: 0, videoWidth: 0, videoHeight: 0, paused: true, currentTime: 0, srcObject: null, presented: 0, cbs: new Map(), nextId: 0,
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    play() { this.paused = false; this.readyState = 4; this.videoWidth = 640; this.videoHeight = 480; return Promise.resolve(); },
    pause() { this.paused = true; },
    requestVideoFrameCallback(cb) { const id = ++this.nextId; this.cbs.set(id, cb); return id; },
    cancelVideoFrameCallback(id) { this.cbs.delete(id); },
    present(now) { this.presented++; const cbs = [...this.cbs.values()]; this.cbs.clear(); for (const cb of cbs) cb(now, { presentedFrames: this.presented }); },
  };
  env.createImageBitmap = async () => { env.captures++; return fakeBitmap('capture'); };
  return env;
}

async function withShell(o, fn) {
  const env = makeEnv(o);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  const worker = o.worker !== false;
  const restore = setGlobals({
    performance: { now: () => clock.t, timeOrigin: 0 },
    navigator: { mediaDevices: env.mediaDevices, userAgent: 'test' },
    isSecureContext: true,
    Worker: worker ? SlowWorker : undefined,
    OffscreenCanvas: worker ? FakeOffscreenCanvas : undefined,
    createImageBitmap: worker ? env.createImageBitmap : undefined,
  });
  const prevSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  SlowWorker.reset();
  gfx.bitmaps.length = 0;
  env.warns = warns;
  env.h = resetFakeMP();
  let vision = null;
  try {
    vision = await createVision({
      video: env.video,
      onStatus: (s) => env.statuses.push({ status: s.status, message: s.message, t: clock.t }),
      config: { mediaPipe: FAKE_MP, rvfcStarveMs: 1e9, useWorker: worker ? 'auto' : 'off', hands: false, ...(o.config || {}) },
    });
    env.vision = vision;
    await fn(env, vision);
  } finally {
    try { if (vision) vision.dispose(); } catch { /* ignore */ }
    await settle(4);
    restore();
    if (prevSelf) Object.defineProperty(globalThis, 'self', prevSelf); else delete globalThis.self;
    console.warn = origWarn;
  }
}

// камера 30 к/с в поддельном времени; между кадрами — доставка «созревших» ответов воркера и сторож (200 мс настоящих)
async function pump(env, ms, opt = {}) {
  const end = clock.t + ms;
  if (env.nextFrame < clock.t) env.nextFrame = clock.t;
  let lastWatch = Date.now();
  while (clock.t < end - 1e-9) {
    const tn = Math.min(end, clock.t + 1000 / 60);
    while (env.nextFrame <= tn) {
      clock.t = Math.max(clock.t, env.nextFrame);
      if (env.framesOn) env.video.present(clock.t);
      env.nextFrame += 1000 / 30;
      SlowWorker.deliverDue();
      await settle(3);
    }
    clock.t = Math.max(clock.t, tn);
    SlowWorker.deliverDue();
    await flush();
    // сторож vision.js — setInterval 200 мс настоящего времени: даём ему сработать примерно раз в 0,25 с поддельных
    if (opt.watch !== false && Math.floor((clock.t - (end - ms)) / 250) !== Math.floor((clock.t - (end - ms) - 1000 / 60) / 250)) {
      const left = 210 - (Date.now() - lastWatch);
      if (left > 0) await realWait(left);
      lastWatch = Date.now();
      await settle(3);
    }
    if (opt.until && opt.until()) break;
  }
}
// ждать (настоящее время), пока условие не выполнится
async function waitFor(cond, maxMs, env) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (cond()) return true;
    if (env) { clock.t += 1000 / 30; env.video.present(clock.t); env.nextFrame = clock.t + 1000 / 30; SlowWorker.deliverDue(); }
    await realWait(20);
  }
  return cond();
}
const messages = (env) => env.statuses.map((s) => s.message);
const lostNoFrames = (env) => env.statuses.filter((s) => s.status === 'lost' && /Нет новых кадров/.test(s.message));

// ═══════════════════════════════ тесты ═══════════════════════════════

test('L00 ступени лестницы по умолчанию и таймауты под слабую видеокарту', () => withShell({}, async (env, v) => {
  eq(v.getStatus().debug.ladder.join(' → '), 'worker-gpu → worker-cpu → main-gpu → main-cpu', 'лестница');
  ok(DEFAULT_VISION_CONFIG.workerWarmupTimeoutMs >= 10000 && DEFAULT_VISION_CONFIG.workerWarmupTimeoutMs < DEFAULT_VISION_CONFIG.workerInitTimeoutMs, 'прогрев GPU — 10…30 с');
  ok(DEFAULT_VISION_CONFIG.workerFirstFrameTimeoutMs > DEFAULT_VISION_CONFIG.workerFrameTimeoutMs, 'первые кадры ждём дольше обычного');
  ok(DEFAULT_VISION_CONFIG.firstFramesGraceMs >= DEFAULT_VISION_CONFIG.workerFirstFrameTimeoutMs, '«нет кадров» — не раньше таймаута первого кадра');
}));

test('L01 прогрев GPU 1 с (слабая видеокарта) — остаёмся на воркере GPU, «Проверка распознавания…», без отката', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.initDelayMs = (msg, d) => (d === 'GPU' ? 1000 : 0);
  const t0 = Date.now();
  const p = v.start();
  await waitFor(() => env.statuses.some((s) => /Проверка распознавания/.test(s.message)), 2000);
  await p;
  ok(Date.now() - t0 >= 900, `прогрев длился ${Date.now() - t0} мс`);
  const s = v.getStatus();
  eq(s.debug.engineStep, 'worker-gpu', 'ступень');
  eq(s.debug.ladderHistory.length, 0, 'откатов нет');
  await pump(env, 600);
  eq(v.getStatus().status, 'ready', 'трекинг работает');
}));

test('L02 прогрев GPU молчит 5 с (таймаут прогрева 3 с) → воркер CPU; текст «Видеокарта не успевает…»', () => withShell({ config: { workerWarmupTimeoutMs: 3000 } }, async (env, v) => {
  SlowWorker.hooks.initDelayMs = (msg, d) => (d === 'GPU' ? 5000 : 0);
  const t0 = Date.now();
  await v.start();
  const ms = Date.now() - t0;
  ok(ms >= 2900 && ms < 4900, `переход через ${ms} мс (таймаут 3 с, а не 30 с и не 5 с ожидания)`);
  const s = v.getStatus();
  eq(s.mode, 'worker'); eq(s.delegate, 'CPU', 'воркер на CPU');
  eq(s.debug.engineStep, 'worker-cpu');
  eq(s.debug.ladderHistory[0].step, 'worker-gpu');
  ok(/молчит 3 с \(этап: warmup\)/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
  ok(messages(env).some((m) => /Видеокарта не успевает — распознавание переходит на процессор/.test(m)), `тексты: ${[...new Set(messages(env))].join(' | ')}`);
  eq(SlowWorker.created.length, 2, 'второй воркер');
  ok(SlowWorker.created[0].terminated, 'GPU-воркер завершён');
  eq(SlowWorker.created[1].delegate, 'CPU', 'второй воркер запущен с delegate CPU');
  await pump(env, 800);
  eq(v.getStatus().status, 'ready', 'трекинг работает на CPU');
  eq(lostNoFrames(env).length, 0, '«Нет новых кадров» не показывалось');
}));

test('L03 первый кадр после прогрева идёт 5 с (новые шейдеры) — ждём: «Ожидание первых кадров…», не «Нет новых кадров», без отката', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d, n) => (n === 1 ? 5000 : 30);
  await v.start();
  await pump(env, 4500);
  let s = v.getStatus();
  eq(s.status, 'loading', 'пока ждём первый кадр');
  eq(s.message, 'Ожидание первых кадров…');
  eq(s.debug.engineStep, 'worker-gpu', 'ступень не сменилась');
  await pump(env, 1500);
  s = v.getStatus();
  eq(s.status, 'ready', 'после первого кадра — готово');
  eq(s.debug.ladderHistory.length, 0, 'откатов нет');
  ok(s.debug.firstResultMs >= 4900, `первый ответ через ${s.debug.firstResultMs} мс`);
  eq(lostNoFrames(env).length, 0, '«Нет новых кадров» не показывалось');
}));

test('L04 кадры на GPU идут по 3 с (после первых) → таймаут кадра 2,5 с → воркер CPU, трекинг продолжается', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d, n) => (d === 'GPU' ? (n <= 5 ? 30 : 3000) : 25);
  await v.start();
  await pump(env, 400);
  eq(v.getStatus().status, 'ready');
  await pump(env, 3200);
  await waitFor(() => v.getStatus().debug.engineStep === 'worker-cpu', 3000, env);
  const s = v.getStatus();
  eq(s.debug.engineStep, 'worker-cpu', 'ступень ниже');
  ok(/не ответил на кадр за 2500 мс/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
  await pump(env, 800);
  eq(v.getStatus().status, 'ready', 'трекинг продолжается на CPU');
  ok(messages(env).some((m) => /Видеокарта не успевает/.test(m)), 'игрок видит причину');
}));

test('L05 воркер GPU и воркер CPU молчат на кадрах → главный поток GPU; затем повторные ошибки GPU → главный поток CPU', () => withShell({ config: { workerFirstFrameTimeoutMs: 1000, workerFrameTimeoutMs: 1000, cpuWorkerFrameTimeoutMs: 1000 } }, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = () => Infinity;
  await v.start();
  await pump(env, 1400);
  await waitFor(() => v.getStatus().debug.engineStep === 'worker-cpu', 3000, env);
  eq(v.getStatus().debug.engineStep, 'worker-cpu', 'сначала воркер CPU');
  await pump(env, 1400);
  await waitFor(() => v.getStatus().mode === 'main', 3000, env);
  let s = v.getStatus();
  eq(s.debug.engineStep, 'main-gpu', 'потом главный поток GPU');
  eq(s.debug.ladderHistory.map((h) => h.step).join(','), 'worker-gpu,worker-cpu');
  ok(messages(env).some((m) => /Фоновый поток не справился/.test(m)), 'текст перехода в главный поток');
  await pump(env, 400);
  eq(v.getStatus().status, 'ready', 'трекинг в главном потоке');
  env.h.detectThrows = (src, inst) => inst.delegate === 'GPU';
  await pump(env, 500);
  await waitFor(() => v.getStatus().debug.engineStep === 'main-cpu', 3000, env);
  s = v.getStatus();
  eq(s.debug.engineStep, 'main-cpu', 'последняя ступень — главный поток CPU');
  await pump(env, 400);
  eq(v.getStatus().status, 'ready', 'трекинг на CPU в главном потоке');
  ok(env.h.detects.slice(-3).every((d) => d.delegate === 'CPU' && d.main), 'кадры считает CPU в главном потоке');
}));

test('L06 GPU отвечает, но раз в 1 с (видеокарту занял рендер), камера 30 к/с → через 8 с воркер CPU', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d) => (d === 'GPU' ? 1000 : 25);
  await v.start();
  await pump(env, 5000);
  eq(v.getStatus().debug.engineStep, 'worker-gpu', 'за 5 с ещё GPU (кадр 1 с < таймаута 2,5 с)');
  await pump(env, 8000, { until: () => v.getStatus().debug.engineStep === 'worker-cpu' });
  await waitFor(() => v.getStatus().debug.engineStep === 'worker-cpu', 3000, env);
  const s = v.getStatus();
  eq(s.debug.engineStep, 'worker-cpu', 'медленный GPU → CPU');
  ok(/реже 3 раз\/с/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
  await pump(env, 800);
  ok(v.getStatus().debug.inferenceHz > 10, `частота на CPU ${v.getStatus().debug.inferenceHz}`);
}));

test('L07 после отката новые движки (смена модели позы) начинаются с достигнутой ступени, а не снова с GPU', () => withShell({ config: { workerWarmupTimeoutMs: 1500 } }, async (env, v) => {
  SlowWorker.hooks.initDelayMs = (msg, d) => (d === 'GPU' ? 4000 : 0);
  await v.start();
  eq(v.getStatus().debug.engineStep, 'worker-cpu');
  const n = SlowWorker.created.length;
  const t0 = Date.now();
  eq(await v.setPoseModel('https://fake.invalid/pose_landmarker_full.task'), true, 'модель сменилась');
  ok(Date.now() - t0 < 1400, `без повторного ожидания GPU: ${Date.now() - t0} мс`);
  eq(SlowWorker.created.length, n + 1, 'один новый воркер');
  eq(SlowWorker.created[n].delegate, 'CPU', 'сразу CPU');
}));

test('L08 настройка delegate CPU и браузер без воркера — свои лестницы', async () => {
  await withShell({ config: { delegate: 'CPU' } }, async (env, v) => {
    eq(v.getStatus().debug.ladder.join(','), 'worker-cpu,main-cpu');
    await v.start();
    eq(v.getStatus().debug.engineStep, 'worker-cpu');
  });
  await withShell({ worker: false }, async (env, v) => {
    eq(v.getStatus().debug.ladder.join(','), 'main-gpu,main-cpu');
    await v.start();
    eq(v.getStatus().debug.engineStep, 'main-gpu');
    await pump(env, 300);
    eq(v.getStatus().status, 'ready');
  });
});

test('L09 воркер сообщил ошибку инициализации (сам пробовал GPU и CPU) → сразу главный поток, без лишнего воркера CPU', () => withShell({}, async (env, v) => {
  env.h.failCreate = () => true;
  let mainCreate = 0;
  const orig = env.h.failCreate;
  env.h.failCreate = (d) => { if (SlowWorker.created.every((w) => w.terminated)) { mainCreate++; return false; } return orig(d); };
  await v.start();
  const s = v.getStatus();
  eq(s.mode, 'main', 'главный поток');
  eq(SlowWorker.created.length, 1, 'воркер CPU отдельно не запускался — он бы повторил ту же ошибку');
  ok(mainCreate >= 1, 'модель создана в главном потоке');
}));

test('L10 «Нет новых кадров с камеры» — только когда камера не шлёт кадры; кадры идут, а ответов нет — «Распознавание не успевает»', async () => {
  await withShell({ config: { workerFirstFrameTimeoutMs: 60000, workerFrameTimeoutMs: 60000, firstFramesGraceMs: 2000, slowGpuHz: 0 } }, async (env, v) => {
    SlowWorker.hooks.frameDelayMs = (d, n) => (n <= 10 ? 30 : Infinity);
    await v.start();
    await pump(env, 600);
    eq(v.getStatus().status, 'ready');
    await pump(env, 2500);
    const s = v.getStatus();
    eq(s.status, 'lost');
    eq(s.message, 'Распознавание не успевает за камерой', 'камера жива, распознавание стоит');
  });
  await withShell({}, async (env, v) => {
    await v.start();
    await pump(env, 600);
    eq(v.getStatus().status, 'ready');
    env.framesOn = false;
    await pump(env, 2500);
    const s = v.getStatus();
    eq(s.status, 'lost');
    eq(s.message, 'Нет новых кадров с камеры', 'камера замолчала');
  });
});

test('L11 отказ камеры: тексты mapCameraError доходят до статуса (код ошибки для «Что делать»)', async () => {
  for (const [name, code] of [['NotReadableError', 'device-busy'], ['NotAllowedError', 'permission-denied'], ['NotFoundError', 'no-device']]) {
    await withShell({ gumError: name }, async (env, v) => {
      let err = null;
      try { await v.start(); } catch (e) { err = e; }
      ok(err && err.code === code, `${name} → ${err && err.code}`);
      const s = v.getStatus();
      eq(s.status, 'error'); eq(s.error, code);
      ok(s.message.length > 20, s.message);
    });
  }
});

test('L12 диагностика в статусе: ступень, лестница, история, прогрев, первый ответ, частота камеры', () => withShell({}, async (env, v) => {
  await v.start();
  await pump(env, 1200);
  const d = v.getStatus().debug;
  for (const k of ['engineStep', 'ladder', 'ladderHistory', 'ladderSwitching', 'warmupMs', 'firstResultMs', 'cameraFps', 'inferenceHz', 'loopMode', 'workerFallbackReason', 'loadStage']) ok(k in d, `нет поля debug.${k}`);
  ok(d.cameraFps > 25 && d.cameraFps < 35, `камера ${d.cameraFps} к/с`);
  ok(d.inferenceHz > 20, `распознаваний ${d.inferenceHz}/с`);
  eq(JSON.parse(JSON.stringify(d)).engineStep, 'worker-gpu', 'сериализуется для отчёта');
}));

test('L15 основной поток: кадр на GPU идёт 3 с (интерфейс висит) → та же модель на CPU в основном потоке', () => withShell({ worker: false }, async (env, v) => {
  await v.start();
  await pump(env, 400);
  eq(v.getStatus().debug.engineStep, 'main-gpu');
  // видеокарту занял рендер: detect на GPU в основном потоке длится 3 с (поддельные часы идут вперёд)
  env.h.onDetect = (src, ts, inst) => { if (inst.delegate === 'GPU' && !src.__bitmap) clock.t += 3000; };
  await pump(env, 2000);
  await waitFor(() => v.getStatus().debug.engineStep === 'main-cpu', 3000, env);
  const s = v.getStatus();
  eq(s.debug.engineStep, 'main-cpu', 'ступень ниже');
  ok(/кадр на GPU в основном потоке \d+ мс/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
  await pump(env, 400);
  eq(v.getStatus().status, 'ready', 'трекинг продолжается');
}));

// файлы MediaPipe до воркера: поддельный fetch с потоковым телом (порции по 1 МБ через delayMs настоящего времени)
function fakeFetch(o = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), priority: init && init.priority });
    const size = 3 * 1048576;
    let sent = 0;
    const signal = init && init.signal;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(size) : null) },
      body: {
        getReader: () => ({
          async read() {
            if (o.stall) { await new Promise((res, rej) => { if (signal) signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); }
            if (sent >= size) return { done: true };
            await realWait(o.delayMs || 5);
            sent += 1048576;
            return { done: false, value: { byteLength: 1048576 } };
          },
        }),
      },
    };
  };
  fn.calls = calls;
  return fn;
}
const HTTP_MP = { ...FAKE_MP, handModelUrl: 'https://fake.invalid/hand_landmarker.task' };

test('L13 медленная сеть: файлы MediaPipe качаются до воркера, на экране — «Загрузка распознавания: N МБ…»; воркер стартует после', async () => {
  const f = fakeFetch({ delayMs: 40 });
  const restore = setGlobals({ window: {}, fetch: f });
  try {
    await withShell({ config: { mediaPipe: HTTP_MP, hands: true } }, async (env, v) => {
      await v.start();
      const urls = f.calls.map((c) => c.url);
      ok(urls.some((u) => /vision_wasm_module_internal\.wasm$/.test(u)), `WASM воркера заранее: ${urls.join(', ')}`);
      ok(urls.some((u) => /pose_landmarker_lite\.task$/.test(u)) && urls.some((u) => /hand_landmarker\.task$/.test(u)), 'модели заранее');
      ok(f.calls.every((c) => c.priority === 'high'), 'с высоким приоритетом');
      const dl = env.statuses.filter((s) => /^Загрузка распознавания: \d+(,\d)? МБ…$/.test(s.message));
      ok(dl.length >= 2, `прогресс загрузки на экране: ${[...new Set(messages(env))].join(' | ')}`);
      eq(v.getStatus().debug.engineStep, 'worker-gpu', 'потом обычный запуск воркера');
    });
  } finally { restore(); }
});

test('L14 загрузка встала (ни байта дольше prefetchStallMs) — не висим: дальше без неё, воркер качает сам', async () => {
  const f = fakeFetch({ stall: true });
  const restore = setGlobals({ window: {}, fetch: f });
  try {
    // свои адреса: уже скачанное в L13 повторно не качается
    const mp = { ...HTTP_MP, modelUrl: 'https://fake.invalid/stall/pose_landmarker_lite.task', handModelUrl: 'https://fake.invalid/stall/hand_landmarker.task' };
    await withShell({ config: { mediaPipe: mp, prefetchStallMs: 1200 } }, async (env, v) => {
      const t0 = Date.now();
      await v.start();
      const ms = Date.now() - t0;
      ok(ms >= 1100 && ms < 4000, `ждали ${ms} мс`);
      eq(v.getStatus().debug.engineStep, 'worker-gpu');
      ok(env.warns.some((w) => /заранее не скачались/.test(w)), 'причина в консоли');
    });
  } finally { restore(); }
});

test('L16 «Играть», пока меню докачивает MediaPipe: файл, который уже качается, не качается второй раз — прогресс общий', async () => {
  const f = fakeFetch({ delayMs: 30 });
  const restore = setGlobals({ fetch: f });
  try {
    const urls = ['https://fake.invalid/l16/a.wasm', 'https://fake.invalid/l16/b.task', 'https://fake.invalid/l16/c.task'];
    const seen = [];
    const menu = V.preloadMediaPipe(urls, { priority: 'low' });            // предзагрузка меню (offline.js)
    await realWait(50);                                                     // первый файл уже идёт
    const cam = V.preloadMediaPipe(urls, { priority: 'high', onProgress: (p) => seen.push(p.loaded) }); // запуск камеры
    const [a, b] = await Promise.all([menu, cam]);
    ok(a.ok && b.ok, `обе загрузки без ошибок: ${a.errors} ${b.errors}`);
    const per = urls.map((u) => f.calls.filter((c) => c.url === u).length);
    eq(per.join(','), '1,1,1', 'каждый файл — один запрос');
    ok(seen.some((n) => n > 0 && n < 9 * 1048576), `прогресс чужой загрузки виден: ${seen.slice(0, 8).join(', ')}`);
    eq(seen[seen.length - 1], 9 * 1048576, 'в конце — всё скачано');
  } finally { restore(); }
});

test('L17 снимок кадра для воркера готов через 6 с (грузится витрина) — воркер не виноват: без отката', () => withShell({}, async (env, v) => {
  await v.start();
  await pump(env, 400);
  eq(v.getStatus().status, 'ready');
  let release = null;
  globalThis.createImageBitmap = () => new Promise((res) => { release = () => res(fakeBitmap('capture')); });
  await pump(env, 6000);
  ok(!!release, 'снимок кадра начат');
  let s = v.getStatus();
  eq(s.debug.engineStep, 'worker-gpu', 'ступень прежняя');
  eq(s.debug.ladderHistory.length, 0, `откатов нет: ${JSON.stringify(s.debug.ladderHistory)}`);
  globalThis.createImageBitmap = env.createImageBitmap;
  release();
  await pump(env, 600);
  s = v.getStatus();
  eq(s.status, 'ready', 'трекинг продолжается в воркере');
  eq(s.mode, 'worker');
}));

test('L18 снимок кадра не готов дольше captureStallMs → сразу главный поток (воркер на CPU не поможет)', () => withShell({ config: { captureStallMs: 3000 } }, async (env, v) => {
  await v.start();
  await pump(env, 400);
  globalThis.createImageBitmap = () => new Promise(() => {});
  await pump(env, 3600);
  await waitFor(() => v.getStatus().mode === 'main', 3000, env);
  const s = v.getStatus();
  eq(s.mode, 'main', 'главный поток');
  eq(s.debug.ladderHistory.map((h) => h.step).join(','), 'worker-gpu', 'воркер на CPU пропущен');
  ok(/снимок кадра для воркера не готов/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
  await pump(env, 600);
  eq(v.getStatus().status, 'ready', 'трекинг продолжается');
}));

test('L19 главный поток стоял 3 с, ответ воркера ждал в очереди — сторож не винит воркер; настоящее молчание — ступень ниже', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d, n) => (n <= 5 ? 0 : n === 6 ? 100 : Infinity);
  await v.start();
  await pump(env, 400);
  eq(v.getStatus().status, 'ready');
  // кадр №6 ушёл воркеру; ответ готов через 100 мс, но главный поток стоит 3 с (часы и настенное время идут вместе)
  await pump(env, 300, { until: () => SlowWorker.held.length > 0 });
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    clock.t += 3000; skew += 3000;
    await realWait(260);   // первым после простоя сработал сторож, ответ ещё в очереди
    await settle(3);
    eq(v.getStatus().debug.ladderHistory.length, 0, `простой главного потока не засчитан воркеру: ${JSON.stringify(v.getStatus().debug.ladderHistory)}`);
  } finally { Date.now = realNow; }
  // дальше воркер молчит по-настоящему — таймаут кадра считается как обычно
  await pump(env, 3200);
  await waitFor(() => v.getStatus().debug.engineStep === 'worker-cpu', 3000, env);
  ok(/не ответил на кадр/.test(v.getStatus().debug.ladderHistory[0].reason), JSON.stringify(v.getStatus().debug.ladderHistory));
}));

test('L20 воркер на CPU: кадр 4 с (процессор занят загрузкой) — остаёмся в воркере; завис дольше 8 с — главный поток', () => withShell({ config: { delegate: 'CPU' } }, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d, n) => (n <= 5 ? 0 : n === 6 ? 4000 : n <= 12 ? 0 : Infinity);
  await v.start();
  await pump(env, 400);
  eq(v.getStatus().debug.engineStep, 'worker-cpu');
  await pump(env, 5000);
  let s = v.getStatus();
  eq(s.debug.ladderHistory.length, 0, `медленный кадр — не повод уходить: ${JSON.stringify(s.debug.ladderHistory)}`);
  eq(s.mode, 'worker');
  await pump(env, 9000);
  await waitFor(() => v.getStatus().mode === 'main', 3000, env);
  s = v.getStatus();
  eq(s.mode, 'main', 'завис — главный поток');
  ok(/не ответил на кадр за 8000 мс/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
}));

test('L21 файлы уже скачаны: воркер на CPU молчит на прогреве дольше cpuWorkerInitTimeoutMs → главный поток; без скачанных файлов — прежние 30 с', async () => {
  const f = fakeFetch({ delayMs: 1 });
  const restore = setGlobals({ window: {}, fetch: f });
  try {
    const mp = { ...HTTP_MP, modelUrl: 'https://fake.invalid/l21/pose_landmarker_lite.task', handModelUrl: 'https://fake.invalid/l21/hand_landmarker.task' };
    await withShell({ config: { mediaPipe: mp, delegate: 'CPU', cpuWorkerInitTimeoutMs: 1500 } }, async (env, v) => {
      SlowWorker.hooks.initDelayMs = (msg, d) => (d === 'CPU' && msg.type === 'ready' ? 4000 : 0);
      const t0 = Date.now();
      await v.start();
      const ms = Date.now() - t0;
      const s = v.getStatus();
      eq(s.mode, 'main', 'главный поток');
      ok(/worker молчит 2 с \(этап: warmup\)/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
      ok(ms < 3900, `ждали ${ms} мс — меньше задержки воркера`);
    });
  } finally { restore(); }
  // без window/fetch (prefetch не шёл) — этап ждёт workerInitTimeoutMs, а не cpuWorkerInitTimeoutMs
  await withShell({ config: { delegate: 'CPU', cpuWorkerInitTimeoutMs: 1500 } }, async (env, v) => {
    SlowWorker.hooks.initDelayMs = (msg, d) => (d === 'CPU' && msg.type === 'ready' ? 2500 : 0);
    await v.start();
    const s = v.getStatus();
    eq(s.mode, 'worker', 'дождались воркер');
    eq(s.debug.ladderHistory.length, 0);
  });
});

test('L22 GPU раз в 1 с, основной поток видит 5 кадров/с (видеокарта занята), счётчик плеера — 30 к/с → воркер CPU', () => withShell({}, async (env, v) => {
  SlowWorker.hooks.frameDelayMs = (d) => (d === 'GPU' ? 1000 : 25);
  env.video.getVideoPlaybackQuality = () => ({ totalVideoFrames: Math.floor(clock.t / (1000 / 30)) });
  await v.start();
  const present = env.video.present.bind(env.video);
  let k = 0;
  env.video.present = (t) => { if (k++ % 6 === 0) present(t); };   // до обработчиков доходит каждый шестой кадр
  await pump(env, 3000);
  const cam = v.getStatus().debug.camera;
  ok(cam.videoFps > 25 && !(cam.fps >= 10), `камера по счётчику ${cam.videoFps}, по обработчикам ${cam.fps}`);
  await pump(env, 10000, { until: () => v.getStatus().debug.engineStep === 'worker-cpu' });
  await waitFor(() => v.getStatus().debug.engineStep === 'worker-cpu', 3000, env);
  const s = v.getStatus();
  eq(s.debug.engineStep, 'worker-cpu', 'медленный GPU → CPU');
  ok(/реже 3 раз\/с/.test(s.debug.ladderHistory[0].reason), s.debug.ladderHistory[0].reason);
}));

// ───────────────────────────── запуск ─────────────────────────────
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let passed = 0;
let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  if (only && !only.test(t.name)) continue;
  try {
    await t.fn();
    passed++;
    console.log(`PASS ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n     ')}`);
  }
}
console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено (${Date.now() - t0} мс). Подделки воркера и MediaPipe — не настоящая видеокарта.`);
process.exitCode = failed ? 1 : 0;
