// ASHEN OATH — план распознавания под железо [PERF]. Владелец: №1. Чистая логика, тесты — dev/visionPlan.test.mjs.
//
// 1) createPosePlanner — как часто считать позу. Кисти (жесты) нужны на каждом кадре, а плечи и запястья позы
//    меняются медленно: на слабой видеокарте, где поза + кисти не укладываются в кадр камеры, поза считается
//    на каждом 2-м кадре (в бою) или 3-м (меню: курсор-кисть), кисти — на каждом. На экране тренировки
//    (приседания, отжимания) поза всегда на каждом кадре. Решение — по измеренной цене кадра (мс позы + кисти),
//    с гистерезисом и выдержкой: сильная машина (≈6 мс на кадр) никогда не меняет поведения.
// 2) hybridTipDue — когда показать подсказку про гибридный ноутбук: Chrome на встроенной видеокарте и
//    распознавание медленнее tipMinHz дольше tipHoldMs. На дискретной — никогда.

export const PLAN_DEFAULTS = Object.freeze({
  slowMs: 45,        // поза + кисти дольше этого (мс/кадр, ≈ медленнее 22 Гц) — поза реже
  fastMs: 28,        // …и быстрее этого (≈ быстрее 35 Гц) — снова на каждом кадре
  holdMs: 2000,      // условие должно держаться столько подряд
  fightEvery: 2,     // бой, обучение, камера, калибровка: поза на каждом 2-м кадре
  menuEvery: 3,      // меню, пауза, итоги: курсору-кисти плечи нужны лишь как рамка — на каждом 3-м
  tipMinHz: 15,      // подсказка про гибридный ноутбук: распознавание медленнее…
  tipMinCamFps: 15,  // …при живой камере (не тусклый свет с 8 к/с)
  tipHoldMs: 6000,   // …дольше этого
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const FULL_POSE_SCREENS = new Set(['training']);
const MENU_SCREENS = new Set(['menu', 'oath', 'paused', 'victory', 'defeat', 'challenge', 'error']);

export function createPosePlanner(config = {}) {
  const C = { ...PLAN_DEFAULTS, ...config };
  const s = { slow: false, since: null, cost: null, every: 1, reason: 'start' };
  return {
    // now — мс; v: { screen, inferMs (поза), handsMs (кисти), gpuClass, handsReady } → poseEvery (1…menuEvery)
    update(now, v = {}) {
      const cost = fin(v.inferMs) ? v.inferMs + (fin(v.handsMs) ? v.handsMs : 0) : null;
      s.cost = cost;
      if (v.gpuClass === 'software') { s.slow = true; s.since = null; s.reason = 'software'; }
      else if (cost !== null) {
        const want = s.slow ? !(cost < C.fastMs) : cost > C.slowMs;   // гистерезис
        if (want === s.slow) s.since = null;
        else { if (s.since === null) s.since = now; if (now - s.since >= C.holdMs) { s.slow = want; s.since = null; s.reason = want ? `медленно: ${Math.round(cost)} мс/кадр` : `быстро: ${Math.round(cost)} мс/кадр`; } }
      }
      // без кистей поза — единственный ввод: всегда на каждом кадре
      if (!s.slow || v.handsReady === false || FULL_POSE_SCREENS.has(v.screen)) s.every = 1;
      else s.every = MENU_SCREENS.has(v.screen) ? C.menuEvery : C.fightEvery;
      return s.every;
    },
    get every() { return s.every; },
    get slow() { return s.slow; },
    state() { return { ...s }; },
  };
}

// Подсказка про гибридный ноутбук: v: { gpuClass, hz, cameraFps, dismissed }; состояние st: { since } (мутируется).
// true — показать (условие держится tipHoldMs); на дискретной видеокарте или после «Понятно» — никогда.
export function hybridTipDue(now, v = {}, st = {}, config = {}) {
  const C = { ...PLAN_DEFAULTS, ...config };
  const integrated = v.gpuClass === 'integrated' || v.gpuClass === 'integrated-strong';
  const slow = fin(v.hz) && fin(v.cameraFps) && v.cameraFps >= C.tipMinCamFps && v.hz < C.tipMinHz;
  if (v.dismissed || !integrated || !slow) { st.since = null; return false; }
  if (!fin(st.since) || st.since === null) st.since = now;
  return now - st.since >= C.tipHoldMs;
}

export const HYBRID_TIP_TEXT = 'Похоже, Chrome работает на встроенной видеокарте. Если в ноутбуке есть NVIDIA/AMD Radeon RX: '
  + 'Параметры Windows → Система → Дисплей → Графика → Google Chrome → «Высокая производительность», затем перезапустите Chrome.';
