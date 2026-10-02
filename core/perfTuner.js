// ASHEN OATH — автоподстройка под железо игрока [PERF]. Владелец: №1.
//
// Три рычага, по порядку цены:
//  1) предел кадров кратно частоте экрана (~60 к/с): на экране 165 Гц игра не гонит 165 кадров,
//     видеокарта не упирается в потолок и оставляет время MediaPipe (кисти и поза считаются на том же GPU);
//  2) динамическое разрешение рендера (доля пиксельной плотности 0.6…1), по времени кадра на GPU
//     (EXT_disjoint_timer_query_webgl2) или, без таймера, по пропущенным кадрам;
//  3) уровень качества high → medium → low (только в режиме «Авто»), если разрешение уже на минимуме.
// Стартовые уровни — по классу видеокарты (строка WEBGL_debug_renderer_info), ядрам и памяти.
// Приватность: сведения о железе читаются локально и хранятся только в localStorage этого браузера.
//
// createPerfTuner({ renderer, storage? , now? }) →
//   { beginFrame(now) → bool (false — кадр пропустить), endFrame(now, cpuMs), noteStall(),
//     setAuto(bool), setTier(q), setVision({ hz, cameraFps, inferMs, model }), onChange(fn), trainingPoseModel(),
//     get tier, get scale, get capFps, state(), profile }

export const PERF_DEFAULTS = Object.freeze({
  targetFps: 60,          // желаемый предел кадров (выбирается кратное частоте экрана, см. pickCap)
  minCapFps: 50,          // делитель частоты экрана не опускает предел ниже этого (кроме режима 30)
  lowTargetFps: 30,       // если даже на минимуме не держим предел — ровные 30 вместо рваных 40
  minScale: 0.6, maxScale: 1,
  stepDown: 0.88, stepUp: 1.06, quantum: 0.05,
  windowMs: 1500,         // окно статистики
  cooldownMs: 1300,       // между сменами разрешения
  upHoldMs: 5000,         // столько подряд «запас есть» — шаг вверх
  gpuHigh: 0.85, gpuLow: 0.55, // доля бюджета кадра на GPU: выше — вниз, ниже — можно вверх
  missFps: 0.9,           // без таймера GPU: fps ниже 0.9·предела при свободном CPU — вниз
  cpuBound: 0.7,          // JS кадра дольше этой доли бюджета — разрешение не поможет
  tierDownHoldMs: 3000,   // на минимуме разрешения столько подряд плохо — уровень качества вниз
  lowModeHoldMs: 6000,    // на low + минимуме столько подряд плохо — предел 30 к/с
  settleMs: 3000,         // после смены уровня (компиляция шейдеров) решения не принимаются
  stallMs: 250,           // кадр длиннее — разовый рывок (вкладка, компиляция), в статистику не идёт
  visionStarve: 0.7,      // распознавание медленнее этой доли кадров камеры при нагруженном GPU — вниз
  starveHoldMs: 2500,     // …если это держится столько подряд
  tierUpLoad: 0.35, tierUpHoldMs: 10000, // запас по GPU для возврата уровня качества (только в меню/паузе)
  savedMaxAgeMs: 7 * 24 * 3600 * 1000,   // выученный уровень старше недели не используется
});

export const PERF_STORAGE_KEY = 'ashen-oath.perf.v1';
const TIERS = ['low', 'medium', 'high'];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- класс видеокарты
export function classifyGpu(name) {
  const s = String(name || '').toLowerCase();
  if (!s || s === 'n/a') return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|basic render|software|lavapipe/.test(s)) return 'software';
  if (/geforce (mx|gt )\s?\d|mx\s?[1-5]\d0\b/.test(s)) return 'integrated';   // MX150…MX550 — слабые дискретные
  if (/nvidia|geforce|quadro|rtx|gtx|radeon rx|radeon pro|rx \d{3,4}|arc\(tm\) a|arc a\d|firepro/.test(s)) return 'discrete';
  if (/apple m\d/.test(s)) return 'integrated-strong';
  if (/iris\(r\) xe|iris xe|arc\(tm\) graphics|radeon 7[4-9]0m|radeon 8[4-9]0m|radeon 6[6-8]0m|radeon\(tm\) 7[4-9]0m|radeon\(tm\) 8[4-9]0m/.test(s)) return 'integrated-strong';
  if (/intel|uhd|hd graphics|iris|radeon\(tm\) graphics|radeon graphics|vega|mali|adreno|powervr|apple gpu/.test(s)) return 'integrated';
  return 'unknown';
}

// Стартовый профиль: уровень качества, разрешение и настройки распознавания.
// vision.poseModel: 'full' — точнее держит плечи при руках перед корпусом (дороже ~×1.6), 'lite' — быстрый.
export function pickProfile(hw) {
  const cls = hw && hw.gpuClass ? hw.gpuClass : 'unknown';
  const cores = hw && fin(hw.cores) ? hw.cores : 4;
  const mem = hw && fin(hw.memory) ? hw.memory : 8;
  let tier = 'medium', scale = 1;
  let vision = { poseModel: 'lite', camera: { width: 640, height: 480 }, captureMaxWidth: 640, maxInferenceHz: 30 };
  if (cls === 'software') {
    tier = 'low'; scale = 0.6;
    vision = { poseModel: 'lite', camera: { width: 640, height: 480 }, captureMaxWidth: 480, maxInferenceHz: 15 };
  } else if (cls === 'integrated') {
    tier = 'low'; scale = 0.85;
  } else if (cls === 'integrated-strong') {
    tier = 'medium'; scale = 0.9;
  } else if (cls === 'discrete') {
    tier = 'high'; scale = 1;
    // 960×720 (4:3): Chrome берёт родной 720p и обрезает края — тот же угол обзора, что у 640×480,
    // но в 1,5 раза больше пикселей на кисти (точнее кончики пальцев для рун)
    vision = { poseModel: 'full', camera: { width: 960, height: 720 }, captureMaxWidth: 960, maxInferenceHz: 30 };
  }
  if (cores <= 4) {
    if (tier === 'high') tier = 'medium';
    vision = { ...vision, poseModel: 'lite', captureMaxWidth: Math.min(vision.captureMaxWidth, 640), camera: { width: 640, height: 480 } };
  }
  if (mem <= 4 && tier !== 'low') tier = 'low';
  return { tier, scale, vision, gpuClass: cls };
}

// [W3-SQUAT] модель позы на экране тренировки: точная (full) держит колени и лодыжки на 2–3 м лучше быстрой;
// приседания медленные — хватает и 12–15 Гц. Только на программном рендере (нет видеокарты) — быстрая.
export function trainingPoseModel(gpuClass) { return gpuClass === 'software' ? 'lite' : 'full'; }

export function probeHardware(renderer) {
  let gpu = 'n/a';
  try {
    const gl = renderer && renderer.getContext ? renderer.getContext() : null;
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String((gl && gl.getParameter(gl.RENDERER)) || 'n/a');
  } catch (e) { /* нет контекста */ }
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof window !== 'undefined' ? window : {};
  return {
    gpu,
    gpuClass: classifyGpu(gpu),
    cores: fin(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null,
    memory: fin(nav.deviceMemory) ? nav.deviceMemory : null,
    dpr: fin(scr.devicePixelRatio) ? scr.devicePixelRatio : 1,
    pixels: fin(scr.innerWidth) ? Math.round(scr.innerWidth * scr.innerHeight * (scr.devicePixelRatio || 1) ** 2) : null,
  };
}

// Предел кадров: делитель частоты экрана, ближайший к targetFps, но не ниже minFps (k=1 — всегда можно).
export function pickCap(hz, targetFps = 60, minFps = 50) {
  if (!fin(hz) || hz <= 0) return targetFps;
  let best = hz, bestD = Math.abs(hz - targetFps);
  for (let k = 2; k <= 8; k++) {
    const f = hz / k;
    if (f < minFps) break;
    const d = Math.abs(f - targetFps);
    if (d < bestD - 1e-6) { best = f; bestD = d; }
  }
  return best;
}

// ---------------------------------------------------------------- таймер GPU
function createGpuTimer(renderer) {
  let gl = null, ext = null;
  try {
    gl = renderer && renderer.getContext ? renderer.getContext() : null;
    ext = gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  } catch (e) { ext = null; }
  if (!ext) return null;
  const pending = [];
  let active = null;
  return {
    begin() {
      if (active || pending.length > 4) return;
      try { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); active = q; } catch (e) { active = null; }
    },
    end() {
      if (!active) return;
      try { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); } catch (e) { try { gl.deleteQuery(active); } catch (e2) { /* ignore */ } }
      active = null;
    },
    // готовые результаты, мс
    poll(out) {
      let disjoint = false;
      try { disjoint = !!gl.getParameter(ext.GPU_DISJOINT_EXT); } catch (e) { disjoint = true; }
      while (pending.length) {
        const q = pending[0];
        let ready = false;
        try { ready = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); } catch (e) { ready = true; disjoint = true; }
        if (!ready) break;
        pending.shift();
        if (!disjoint) { try { out.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); } catch (e) { /* ignore */ } }
        try { gl.deleteQuery(q); } catch (e) { /* ignore */ }
      }
    },
  };
}

// ---------------------------------------------------------------- тюнер
export function createPerfTuner(opts = {}) {
  const C = { ...PERF_DEFAULTS, ...(opts.config || {}) };
  const storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  const hw = opts.hardware || probeHardware(opts.renderer);
  const profile = pickProfile(hw);
  const gpuTimer = opts.gpuTimer !== undefined ? opts.gpuTimer : createGpuTimer(opts.renderer);

  // выученное прошлыми запусками на этой видеокарте (уровень, разрешение, медленная модель позы)
  let saved = null;
  try { saved = storage ? JSON.parse(storage.getItem(PERF_STORAGE_KEY) || 'null') : null; } catch (e) { saved = null; }
  if (!saved || saved.gpu !== hw.gpu) saved = null;
  if (saved && saved.poseSlow && profile.vision.poseModel === 'full') profile.vision = { ...profile.vision, poseModel: 'lite' };
  const wallNow = typeof Date !== 'undefined' ? Date.now() : 0;
  const savedFresh = !!(saved && fin(saved.t) && wallNow - saved.t < C.savedMaxAgeMs);
  // выученный уровень — не ниже стартового минус один (разовая просадка не приговаривает машину к low)
  const savedTier = savedFresh && TIERS.includes(saved.tier)
    ? TIERS[Math.max(TIERS.indexOf(saved.tier), TIERS.indexOf(profile.tier) - 1, 0)] : null;

  const s = {
    auto: true,
    calm: false,             // меню/пауза: можно дорогие смены (уровень вверх)
    tier: savedTier || profile.tier,
    scale: savedFresh && saved.tier === savedTier && fin(saved.scale) ? clamp(saved.scale, C.minScale, C.maxScale) : profile.scale,
    lowMode: false,          // режим 30 к/с
    refreshHz: null, capFps: C.targetFps,
    rafT: null, rafDts: [], lastRender: null, prevSkipped: false, vsyncN: 0,
    frames: [],              // { t, dt, cpu }
    gpu: [],                 // { t, ms }
    lastChange: -1e9, settleUntil: 0, goodSince: null, badAtMinSince: null, starveSince: null, lastStallT: -1e9,
    ceiling: C.maxScale, ceilingUntil: 0, lastUp: -1e9,
    vision: null,
    log: [],
  };
  const listeners = [];
  const emit = (why) => { for (const f of listeners) { try { f(why, api.state()); } catch (e) { /* ignore */ } } };
  const note = (t, text) => { s.log.push({ t: Math.round(t), text }); if (s.log.length > 20) s.log.shift(); };
  function persist() {
    if (!storage) return;
    try { storage.setItem(PERF_STORAGE_KEY, JSON.stringify({ gpu: hw.gpu, tier: s.tier, scale: +s.scale.toFixed(2), poseSlow: !!(saved && saved.poseSlow), t: Date.now() })); } catch (e) { /* ignore */ }
  }

  // Частота экрана — только по интервалам после ПРОПУЩЕННОГО вызова rAF: между ними ничего не рисовалось,
  // это чистый период vsync. Интервалы после нарисованного кадра тяжёлый кадр растягивает (70 «Гц» вместо 165).
  // Пока пропусков нет (экран 60 Гц или кадры тяжелее периода), предел — targetFps.
  function updateRefresh(now) {
    if (s.rafT !== null && s.prevSkipped) {
      const d = now - s.rafT;
      if (d > 2.5 && d < 50) { s.rafDts.push(d); if (s.rafDts.length > 60) s.rafDts.shift(); s.vsyncN++; }
    }
    s.rafT = now;
    if (s.rafDts.length >= 8 && (s.vsyncN % 8 === 0 || s.refreshHz === null)) {
      const a = s.rafDts.slice().sort((x, y) => x - y);
      const hz = 1000 / a[Math.floor(a.length / 2)];
      // только вверх: под нагрузкой браузер зовёт rAF реже, интервал — кратное периода, а не сам период
      if (s.refreshHz === null || hz > s.refreshHz * 1.05) setRefresh(hz);
    }
  }
  function setRefresh(hz) {
    if (!fin(hz) || hz < 20 || hz > 500) return;
    s.refreshHz = hz;
    s.capFps = pickCap(s.refreshHz, s.lowMode ? C.lowTargetFps : C.targetFps, s.lowMode ? 24 : C.minCapFps);
  }
  // частота, измеренная на экране загрузки (index.html), — самая надёжная
  const hint = fin(opts.refreshHint) ? opts.refreshHint : (typeof window !== 'undefined' && fin(window.__aoRefreshHz) ? window.__aoRefreshHz : null);
  if (hint) setRefresh(hint);

  const api = {
    profile, hardware: hw,
    get tier() { return s.tier; },
    get scale() { return s.scale; },
    get capFps() { return s.capFps; },
    get auto() { return s.auto; },

    // false — этот вызов rAF пропускается (предел кадров); при true — кадр рисуется, таймер GPU запущен.
    // force — рисовать всегда (QA ?uncapped=1), статистика и подстройка разрешения продолжают работать.
    beginFrame(now, force = false) {
      updateRefresh(now);
      const vsync = s.refreshHz ? 1000 / s.refreshHz : 0;
      const interval = 1000 / s.capFps;
      // допуск: полпериода vsync (кадры приходят на vsync), но не меньше 2 мс — экран 60 Гц при пределе 60 не теряет кадров
      if (!force && s.lastRender !== null && now - s.lastRender < interval - Math.max(vsync * 0.5, 2)) { s.prevSkipped = true; return false; }
      s.prevSkipped = false;
      const dt = s.lastRender === null ? null : now - s.lastRender;
      s.lastRender = now;
      s._dt = dt;
      return true;
    },
    // таймер GPU вокруг рендера сцены (не вокруг JS кадра: иначе в него попадает простой GPU)
    gpuBegin() { if (gpuTimer) gpuTimer.begin(); },
    gpuEnd() { if (gpuTimer) gpuTimer.end(); },

    endFrame(now, cpuMs) {
      if (gpuTimer) {
        gpuTimer.end();
        const got = [];
        gpuTimer.poll(got);
        for (const ms of got) if (ms > 0 && ms < 1000) s.gpu.push({ t: now, ms });
      }
      const dt = s._dt;
      if (dt !== null && dt !== undefined && dt < C.stallMs) s.frames.push({ t: now, dt, cpu: fin(cpuMs) ? cpuMs : 0 });
      else if (dt !== null && dt !== undefined) s.lastStallT = now; // рывок (загрузка героя, компиляция) — окно нерепрезентативно
      while (s.frames.length && now - s.frames[0].t > C.windowMs) s.frames.shift();
      while (s.gpu.length && now - s.gpu[0].t > C.windowMs) s.gpu.shift();
      decide(now);
    },

    noteStall(now) { s.settleUntil = Math.max(s.settleUntil, (fin(now) ? now : 0) + C.settleMs); },
    setAuto(on) { s.auto = !!on; if (!s.auto) { s.lowMode = false; } },
    setCalm(on) { s.calm = !!on; },
    setTier(q) { if (TIERS.includes(q)) s.tier = q; },
    setVision(v) { s.vision = v && typeof v === 'object' ? { ...v } : null; },
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); },
    // модель позы оказалась медленной на этой машине: в следующий раз сразу lite
    markPoseSlow() { saved = { ...(saved || {}), gpu: hw.gpu, poseSlow: true }; persist(); },
    trainingPoseModel() { return trainingPoseModel(hw.gpuClass); },   // [W3-SQUAT] модель позы на экране тренировки

    state() {
      const n = s.frames.length;
      const sumDt = s.frames.reduce((a, f) => a + f.dt, 0);
      const fps = n > 1 && sumDt > 0 ? (n * 1000) / sumDt : null;
      const gpuMs = s.gpu.length ? s.gpu.reduce((a, g) => a + g.ms, 0) / s.gpu.length : null;
      const cpuMs = n ? s.frames.reduce((a, f) => a + f.cpu, 0) / n : null;
      return {
        auto: s.auto, tier: s.tier, scale: +s.scale.toFixed(2), capFps: +s.capFps.toFixed(1), lowMode: s.lowMode,
        refreshHz: s.refreshHz ? +s.refreshHz.toFixed(1) : null, fps: fps ? +fps.toFixed(1) : null,
        gpuMs: gpuMs !== null ? +gpuMs.toFixed(2) : null, cpuMs: cpuMs !== null ? +cpuMs.toFixed(2) : null,
        gpuTimer: !!gpuTimer, gpu: hw.gpu, gpuClass: hw.gpuClass, cores: hw.cores, memory: hw.memory,
        profileTier: profile.tier, poseModel: profile.vision.poseModel, log: s.log.slice(-6),
      };
    },
  };

  function setScale(v, now, why) {
    const cap = s.gpu.length ? C.maxScale : Math.min(C.maxScale, s.ceiling); // потолок — только без таймера GPU
    const q = Math.round(clamp(v, C.minScale, cap) / C.quantum) * C.quantum;
    const nv = clamp(+q.toFixed(2), C.minScale, C.maxScale);
    if (Math.abs(nv - s.scale) < 1e-3) return false;
    const up = nv > s.scale;
    s.scale = nv; s.lastChange = now;
    if (up) s.lastUp = now;
    s.frames.length = 0; s.gpu.length = 0; s.goodSince = null;
    note(now, `${why}: разрешение ${Math.round(nv * 100)}%`);
    emit('scale');
    persist();
    return true;
  }

  function decide(now) {
    if (!s.auto || now < s.settleUntil || now - s.lastChange < C.cooldownMs) return;
    if (now - s.lastStallT < C.windowMs + 500) return; // недавно был рывок: соседние кадры тоже «грязные»
    const n = s.frames.length;
    if (n < 12) return;
    const span = s.frames[n - 1].t - s.frames[0].t;
    if (span < C.windowMs * 0.6) return;
    // fps по сумме интервалов учтённых кадров: разовые рывки (> stallMs) выброшены и не занижают его
    const fps = (n * 1000) / Math.max(1, s.frames.reduce((a, f) => a + f.dt, 0));
    const budget = 1000 / s.capFps;
    const cpu = s.frames.reduce((a, f) => a + f.cpu, 0) / n;
    const gpuMs = s.gpu.length >= 6 ? s.gpu.reduce((a, g) => a + g.ms, 0) / s.gpu.length : null;
    const load = gpuMs !== null ? gpuMs / budget : null;
    const cpuBound = cpu > budget * C.cpuBound;
    const slowFps = fps < s.capFps * C.missFps;
    // распознавание голодает (кадров камеры больше, чем успевает MediaPipe), а GPU занят рендером;
    // держится дольше starveHoldMs (прогрев модели и первые кадры камеры — не повод)
    const v = s.vision;
    const starvingNow = !!(v && fin(v.hz) && fin(v.cameraFps) && v.cameraFps > 10 && v.hz < Math.min(v.cameraFps, 30) * C.visionStarve && (load === null || load > 0.45));
    if (!starvingNow) s.starveSince = null; else if (s.starveSince === null) s.starveSince = now;
    const starving = starvingNow && now - s.starveSince >= C.starveHoldMs;
    const bad = (load !== null ? load > C.gpuHigh : slowFps && !cpuBound) || (slowFps && load !== null && load > 0.7) || starving;
    const good = load !== null ? load < C.gpuLow && !slowFps && !starving : !slowFps && !starving;

    if (bad) {
      s.goodSince = null;
      if (s.scale > C.minScale + 1e-3) {
        // вверх недавно — этот уровень не держится: потолок на минуту
        if (now - s.lastUp < 6000) { s.ceiling = s.scale - C.quantum; s.ceilingUntil = now + 60000; }
        setScale(s.scale * C.stepDown, now, starving ? 'распознаванию не хватает GPU' : 'кадр не укладывается');
        return;
      }
      if (s.badAtMinSince === null) s.badAtMinSince = now;
      const held = now - s.badAtMinSince;
      const ti = TIERS.indexOf(s.tier);
      if (held >= C.tierDownHoldMs && ti > 0) {
        s.tier = TIERS[ti - 1];
        s.badAtMinSince = null;
        s.settleUntil = now + C.settleMs;
        s.scale = 0.85; s.ceiling = C.maxScale;
        s.frames.length = 0; s.gpu.length = 0;
        note(now, `качество → ${s.tier}`);
        emit('tier');
        persist();
      } else if (held >= C.lowModeHoldMs && ti === 0 && !s.lowMode && (cpuBound || slowFps)) {
        s.lowMode = true;
        s.badAtMinSince = null;
        s.capFps = pickCap(s.refreshHz, C.lowTargetFps, 24);
        s.frames.length = 0; s.gpu.length = 0;
        note(now, `ровные ${Math.round(s.capFps)} к/с`);
        emit('cap');
      }
      return;
    }
    s.badAtMinSince = null;
    // потолок снимается по времени или когда запас стал большим (сцена сменилась — причины потолка нет)
    if (now > s.ceilingUntil || (load !== null && load < C.tierUpLoad)) s.ceiling = C.maxScale;
    if (good) {
      if (s.goodSince === null) s.goodSince = now;
      const held = now - s.goodSince;
      // с таймером GPU — прогноз: нагрузка растёт как площадь пикселей; шаг вверх, только если кадр уложится.
      // Без таймера — потолок после неудачного шага вверх (см. выше).
      const next = Math.min(C.maxScale, s.scale * C.stepUp);
      const fits = load !== null ? load * (next / s.scale) ** 2 < C.gpuHigh * 0.9 : s.scale < Math.min(C.maxScale, s.ceiling) - 1e-3;
      if (held >= C.upHoldMs && s.scale < C.maxScale - 1e-3 && fits) setScale(s.scale * C.stepUp, now, 'есть запас');
      else if (s.calm && load !== null && load < C.tierUpLoad && held >= C.tierUpHoldMs && s.scale >= C.maxScale - 1e-3
        && TIERS.indexOf(s.tier) < TIERS.indexOf(profile.tier)) {
        // уровень вверх — только в меню/паузе (компиляция шейдеров) и не выше стартового для этого железа
        s.tier = TIERS[TIERS.indexOf(s.tier) + 1];
        s.settleUntil = now + C.settleMs; s.goodSince = null;
        s.frames.length = 0; s.gpu.length = 0;
        note(now, `качество → ${s.tier}`);
        emit('tier');
        persist();
      }
    } else s.goodSince = null;
  }

  return api;
}
