// node dev/perfTuner.test.mjs — автоподстройка под железо (core/perfTuner.js) на фейковых часах.
// rAF частоты экрана, фейковый таймер GPU (время кадра ∝ площади пикселей), хранилище в памяти.
// Это модель, а не замер на железе: реальные цифры — tools/… и панель F3 в игре.
import { classifyGpu, pickCap, pickProfile, createPerfTuner, PERF_STORAGE_KEY, trainingPoseModel } from '../core/perfTuner.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(v, msg) { if (!v) throw new Error(msg || 'ожидалось истинное значение'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ожидалось равенство'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'ожидалась близость'}: ${a} vs ${b} (±${tol})`); }

const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const UHD = 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)';
function memStorage(init) { const m = new Map(init ? Object.entries(init) : []); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }

// Фейковый таймер GPU: время кадра = base·scale² (заполнение пикселей) + fixed
function fakeGpu() {
  const g = { ms: 5, pending: [], active: false };
  return {
    g,
    begin() { g.active = true; },
    end() { if (g.active) { g.pending.push(g.ms); g.active = false; } },
    poll(out) { while (g.pending.length) out.push(g.pending.shift()); },
  };
}
// Симуляция: rAF с частотой hz, кадр рисуется, если beginFrame=true; gpuFn(scale) → мс GPU; cpuMs — JS кадра
function sim(tuner, { hz = 165, ms = 5000, gpu = null, gpuFn = null, cpuMs = 3, t0 = 1000, onFrame = null } = {}) {
  let t = t0, rendered = 0;
  const period = 1000 / hz;
  const end = t0 + ms;
  while (t < end) {
    let work = 0.3; // пропущенный вызов rAF почти ничего не стоит
    if (tuner.beginFrame(t)) {
      rendered++;
      if (gpu && gpuFn) gpu.g.ms = gpuFn(tuner.scale, tuner.tier);
      tuner.gpuBegin(); tuner.gpuEnd();
      tuner.endFrame(t + cpuMs, cpuMs);
      if (onFrame) onFrame(t);
      work = gpu && gpuFn ? Math.max(cpuMs, gpu.g.ms) : cpuMs;
    }
    // тяжёлый кадр задерживает следующий rAF до ближайшего vsync после окончания работы
    t += Math.max(period, Math.ceil(work / period) * period);
  }
  return { rendered, fps: (rendered * 1000) / ms, t };
}
const hwRtx = { gpu: RTX, gpuClass: 'discrete', cores: 24, memory: 32 };

// ───────────────────────────── классы и профили ─────────────────────────────
test('классы видеокарт по строке WEBGL_debug_renderer_info', () => {
  eq(classifyGpu(RTX), 'discrete');
  eq(classifyGpu('ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'discrete');
  eq(classifyGpu(UHD), 'integrated');
  eq(classifyGpu('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated-strong');
  eq(classifyGpu('ANGLE (AMD, AMD Radeon(TM) 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated-strong');
  eq(classifyGpu('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated');
  eq(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'integrated', 'MX — слабая дискретная');
  eq(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'), 'integrated-strong');
  eq(classifyGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'software');
  eq(classifyGpu(''), 'unknown'); eq(classifyGpu('n/a'), 'unknown');
});

test('предел кадров — делитель частоты экрана, ближайший к 60 (не ниже 50)', () => {
  near(pickCap(165), 55, 0.01, '165 Гц');
  near(pickCap(144), 72, 0.01, '144 Гц');
  near(pickCap(120), 60, 0.01, '120 Гц');
  near(pickCap(60), 60, 0.01, '60 Гц');
  near(pickCap(75), 75, 0.01, '75 Гц');
  near(pickCap(240), 60, 0.01, '240 Гц');
  near(pickCap(90), 90, 0.01, '90 Гц (45 < 50)');
  near(pickCap(165, 30, 24), 27.5, 0.01, 'режим 30 на 165 Гц');
  eq(pickCap(null), 60, 'частота неизвестна');
});

test('стартовый профиль: RTX — среднее (high с камерой упирается в процессор), точная поза, камера 960×720; UHD — низкое, быстрая поза; софт — ещё реже', () => {
  const d = pickProfile(hwRtx);
  eq(d.tier, 'medium'); eq(d.vision.poseModel, 'full'); eq(d.vision.camera.width, 960); eq(d.vision.camera.height, 720);
  const i = pickProfile({ gpuClass: 'integrated', cores: 8, memory: 8 });
  eq(i.tier, 'low'); eq(i.vision.poseModel, 'lite'); eq(i.vision.camera.width, 640);
  const s = pickProfile({ gpuClass: 'software', cores: 8, memory: 8 });
  eq(s.tier, 'low'); eq(s.scale, 0.6); eq(s.vision.captureMaxWidth, 480); eq(s.vision.maxInferenceHz, 15);
  const weakCpu = pickProfile({ gpuClass: 'discrete', cores: 4, memory: 16 });
  eq(weakCpu.tier, 'medium', '4 ядра: не высокое'); eq(weakCpu.vision.poseModel, 'lite', '4 ядра: быстрая поза');
  eq(pickProfile({ gpuClass: 'integrated-strong', cores: 8, memory: 4 }).tier, 'low', '4 ГБ памяти — низкое');
});

// ───────────────────────────── предел кадров ─────────────────────────────
test('165 Гц: рисуется ~55 кадров/с (каждый третий vsync); частота экрана из подсказки загрузчика', () => {
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: null, refreshHint: 164.9 });
  const r = sim(t, { hz: 165, ms: 4000 });
  near(r.fps, 55, 1.5, 'кадров/с');
  near(t.capFps, 55, 0.2, 'предел');
});

test('165 Гц без подсказки: частота находится по пропущенным вызовам rAF → 55', () => {
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: null, refreshHint: null });
  const r = sim(t, { hz: 165, ms: 4000 });
  near(t.state().refreshHz, 165, 3, 'найденная частота');
  near(r.fps, 55, 3, 'кадров/с');
});

test('60 Гц: ни один кадр не теряется (допуск ≥ 2 мс на дрожание vsync)', () => {
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: null, refreshHint: 60 });
  const r = sim(t, { hz: 60, ms: 3000 });
  near(r.fps, 60, 0.5);
});

test('тяжёлые кадры не занижают частоту экрана (оценка только вверх)', () => {
  const gpu = fakeGpu();
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: gpu, refreshHint: 164.9 });
  t.setAuto(false);
  sim(t, { hz: 165, ms: 4000, gpu, gpuFn: () => 13 });
  near(t.state().refreshHz, 164.9, 1, 'частота экрана осталась 165');
});

test('?uncapped: force рисует каждый вызов, статистика идёт', () => {
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: null, refreshHint: 165 });
  let n = 0;
  for (let i = 0; i < 330; i++) if (t.beginFrame(1000 + i * 1000 / 165, true)) { n++; t.endFrame(1000 + i * 1000 / 165 + 1, 1); }
  eq(n, 330);
  ok(t.state().fps > 150, `fps ${t.state().fps}`);
});

// ───────────────────────────── разрешение и уровень ─────────────────────────────
test('GPU не успевает (19 мс при бюджете 18,2) → разрешение вниз до укладывания; запас → обратно вверх', () => {
  const gpu = fakeGpu();
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: gpu, refreshHint: 165 });
  let heavy = true;
  const fn = (sc) => (heavy ? 2 + 17 * sc * sc : 2 + 5 * sc * sc);
  sim(t, { hz: 165, ms: 15000, gpu, gpuFn: fn });
  ok(t.scale < 1 && t.scale >= 0.6, `разрешение ${t.scale}`);
  ok(fn(t.scale) / (1000 / 55) <= 0.86, `нагрузка после подстройки ${(fn(t.scale) / (1000 / 55)).toFixed(2)}`);
  eq(t.tier, 'medium', 'уровень качества не тронут, раз разрешения хватило');
  heavy = false;
  sim(t, { hz: 165, ms: 60000, gpu, gpuFn: fn, t0: 20000 });
  eq(t.scale, 1, 'лёгкая сцена — разрешение вернулось к 100%');
});

test('на минимуме разрешения всё ещё тяжело → уровень качества вниз (medium → low), событие tier', () => {
  const gpu = fakeGpu();
  const events = [];
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: gpu, refreshHint: 165 });
  t.onChange((why, st) => events.push([why, st.tier]));
  sim(t, { hz: 165, ms: 30000, gpu, gpuFn: (sc, tier) => (tier === 'medium' ? 30 : 8) });
  eq(t.tier, 'low');
  ok(events.some(([w, q]) => w === 'tier' && q === 'low'), JSON.stringify(events));
});

test('режим вручную: разрешение и уровень не меняются', () => {
  const gpu = fakeGpu();
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: gpu, refreshHint: 165 });
  t.setAuto(false);
  sim(t, { hz: 165, ms: 20000, gpu, gpuFn: () => 30 });
  eq(t.scale, 1); eq(t.tier, 'medium');
});

test('распознавание голодает при занятом GPU → разрешение вниз, но не от короткого прогрева (< 2,5 с)', () => {
  const gpu = fakeGpu();
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: gpu, refreshHint: 165 });
  t.setVision({ hz: 12, cameraFps: 30 });
  sim(t, { hz: 165, ms: 2000, gpu, gpuFn: () => 10 });
  eq(t.scale, 1, 'прогрев 2 с — без реакции');
  sim(t, { hz: 165, ms: 4000, gpu, gpuFn: () => 10, t0: 3000 });
  ok(t.scale < 1, `голод держится — разрешение ${t.scale}`);
  const t2 = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: fakeGpu(), refreshHint: 165 });
  t2.setVision({ hz: 29, cameraFps: 30 });
  sim(t2, { hz: 165, ms: 6000, gpu, gpuFn: () => 10 });
  eq(t2.scale, 1, 'успевает — не трогаем');
});

test('разовые рывки (компиляция шейдеров, > 250 мс) не считаются медленными кадрами', () => {
  const t = createPerfTuner({ hardware: hwRtx, storage: memStorage(), gpuTimer: null, refreshHint: 60 });
  let tt = 1000;
  for (let i = 0; i < 900; i++) {
    const stall = i % 60 === 30 ? 400 : 0;
    tt += 1000 / 60 + stall;
    if (t.beginFrame(tt)) t.endFrame(tt + 2, 2);
  }
  eq(t.scale, 1, 'разрешение не тронуто');
  near(t.state().fps, 60, 1.5, 'fps без рывков');
});

test('уровень вверх только в меню/паузе и не выше стартового', () => {
  const gpu = fakeGpu();
  const st = memStorage();
  st.setItem(PERF_STORAGE_KEY, JSON.stringify({ gpu: RTX, tier: 'low', scale: 1, t: Date.now() }));
  const t = createPerfTuner({ hardware: hwRtx, storage: st, gpuTimer: gpu, refreshHint: 165 });
  eq(t.tier, 'low', 'выученный уровень');
  sim(t, { hz: 165, ms: 20000, gpu, gpuFn: () => 3 });
  eq(t.tier, 'low', 'в бою уровень не растёт');
  t.setCalm(true);
  sim(t, { hz: 165, ms: 15000, gpu, gpuFn: () => 3, t0: 30000 });
  eq(t.tier, 'medium', 'в меню с запасом — вверх');
  sim(t, { hz: 165, ms: 15000, gpu, gpuFn: () => 3, t0: 50000 });
  eq(t.tier, 'medium', 'выше стартового (medium) не растёт');
});

// ───────────────────────────── память ─────────────────────────────
test('выученное: свежий уровень берётся (не ниже стартового − 1), старше недели — нет; медленная поза → lite', () => {
  const low = memStorage({ [PERF_STORAGE_KEY]: JSON.stringify({ gpu: RTX, tier: 'low', scale: 0.7, t: Date.now() }) });
  eq(createPerfTuner({ hardware: hwRtx, storage: low, gpuTimer: null }).tier, 'low', 'low на RTX → low (стартовый medium − 1)');
  const high = memStorage({ [PERF_STORAGE_KEY]: JSON.stringify({ gpu: RTX, tier: 'high', scale: 1, t: Date.now() }) });
  eq(createPerfTuner({ hardware: hwRtx, storage: high, gpuTimer: null }).tier, 'medium', 'выученный high выше стартового — medium');
  const old = memStorage({ [PERF_STORAGE_KEY]: JSON.stringify({ gpu: RTX, tier: 'medium', scale: 0.7, t: Date.now() - 8 * 86400e3 }) });
  const t = createPerfTuner({ hardware: hwRtx, storage: old, gpuTimer: null });
  eq(t.tier, 'medium', 'старое не используется'); eq(t.scale, 1);
  const other = memStorage({ [PERF_STORAGE_KEY]: JSON.stringify({ gpu: UHD, tier: 'low', t: Date.now() }) });
  eq(createPerfTuner({ hardware: hwRtx, storage: other, gpuTimer: null }).tier, 'medium', 'чужая видеокарта');
  const st = memStorage();
  const a = createPerfTuner({ hardware: hwRtx, storage: st, gpuTimer: null });
  eq(a.profile.vision.poseModel, 'full');
  a.markPoseSlow();
  eq(createPerfTuner({ hardware: hwRtx, storage: st, gpuTimer: null }).profile.vision.poseModel, 'lite', 'в следующий запуск — lite');
});

// [W3-SQUAT] модель позы на экране тренировки: точная, если видеокарта не программная (и на слабой встроенной тоже)
test('тренировка: модель позы full на любой видеокарте, кроме программного рендера', () => {
  eq(trainingPoseModel('discrete'), 'full', 'дискретная');
  eq(trainingPoseModel('integrated'), 'full', 'встроенная');
  eq(trainingPoseModel('unknown'), 'full', 'неизвестная');
  eq(trainingPoseModel('software'), 'lite', 'программный рендер');
  eq(createPerfTuner({ hardware: { gpu: UHD, gpuClass: classifyGpu(UHD), cores: 4, memory: 8 }, storage: memStorage(), gpuTimer: null }).trainingPoseModel(), 'full', 'UHD 620 → full на тренировке (в бою lite)');
  eq(createPerfTuner({ hardware: { gpu: 'SwiftShader', gpuClass: 'software', cores: 4, memory: 8 }, storage: memStorage(), gpuTimer: null }).trainingPoseModel(), 'lite', 'SwiftShader → lite');
});

// ───────────────────────────── запуск ─────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`PASS ${t.name}`); }
  catch (e) { failed++; console.log(`FAIL ${t.name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 3).join('\n     ')}`); }
}
console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено. Модель на фейковых часах, не замер железа.`);
process.exitCode = failed ? 1 : 0;
