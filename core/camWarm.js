// ASHEN OATH — core/camWarm.js [W5-КАМЕРА]. Рендер уступает видеокарту распознаванию.
//
// MediaPipe (поза и кисти) считается в воркере на той же видеокарте, что рисует игру. Пока модель прогревается
// (первый кадр компилирует шейдеры) и пока идёт калибровка, полная витрина и мир отнимают у неё GPU: на слабой
// встроенной видеокарте прогрев не укладывался в таймаут воркера — «игра не видит камеру».
//
//  1) camWarmWanted(ctx) — «дешёвый кадр», пока камера запускается: статус permission / loading / calibrating
//     (на экранах камеры и калибровки — и пока калибровки ещё нет). main.js тогда снижает плотность пикселей,
//     прячет частицы и портал витрины, не обновляет карту теней и рисует не чаще ~30 кадров/с.
//  2) createFightGuard() — в бою: распознаваний в секунду меньше 12 дольше 3 с (а камера даёт больше) — графика
//     ступенью ниже (уровень качества через perfTuner, затем предел 30 к/с); распознавание восстановилось
//     (≥ 16 в секунду 5 с) — ступень обратно. Сразу после возврата снова плохо — до конца боя без возвратов.
// Чистая логика без DOM и WebGL: тесты — dev/camWarm.test.mjs.

export const CAM_WARM = Object.freeze({
  statuses: Object.freeze(['permission', 'loading', 'calibrating']),
  screens: Object.freeze(['camera', 'calibration']), // здесь «дешёвый кадр» и до калибровки (камера ждёт игрока в кадре)
  prK: 0.6,        // доля плотности пикселей
  gapMs: 25,       // кадр не чаще, чем раз в 25 мс: 60/120 Гц → 30 к/с, 144 Гц → 36, 165 Гц → 27,5
});

// ctx: { screen, status, calibrated, debug, off } — off: ?uncapped=1 (замеры QA) и ?benchcam (замер боя с камерой)
export function camWarmWanted(ctx) {
  const c = ctx || {};
  if (c.debug || c.off) return false;
  if (CAM_WARM.statuses.includes(c.status)) return true;
  // экран камеры и калибровки: камера работает, но калибровки ещё нет — распознавание всё ещё главное
  return CAM_WARM.screens.includes(c.screen) && (c.status === 'ready' || c.status === 'lost') && c.calibrated !== true;
}

export const GUARD_DEFAULTS = Object.freeze({
  lowHz: 12,          // распознаваний в секунду меньше этого…
  badMs: 3000,        // …дольше этого — графика ступенью ниже
  okHz: 16,           // столько и больше…
  okMs: 5000,         // …дольше этого — ступень обратно
  camK: 0.8,          // камера сама даёт мало кадров (тусклый свет): «медленно» — только ниже этой доли её частоты
  relapseMs: 20000,   // после возврата снова плохо раньше этого — до конца боя без возвратов
  maxLevel: 2,        // 1 — уровень качества ниже, 2 — ещё и предел 30 к/с
});
const TIERS = ['low', 'medium', 'high'];

// update(now, { active, hz, cameraFps, tier, auto }) → null | { level, tier?, cap, why }
//   active — идёт бой (экран боя, не пауза, не отладка с клавиатуры); tier — текущий уровень качества;
//   auto — уровень выбирает perfTuner («Авто»): только тогда страж меняет уровень, иначе — лишь предел кадров.
// Возвращённое действие main.js применяет: tier (если есть) — через perfTuner.setTier, cap — предел 30 к/с.
export function createFightGuard(opts = {}) {
  const C = { ...GUARD_DEFAULTS, ...opts };
  const s = { level: 0, badSince: null, okSince: null, restoredAt: -Infinity, pinned: false, baseTier: null, tierSet: null, log: [] };
  const note = (now, text) => { s.log.push({ t: Math.round(now), text }); if (s.log.length > 10) s.log.shift(); };

  function slow(hz, cam) {
    if (!(typeof hz === 'number' && Number.isFinite(hz))) return false;
    const lim = typeof cam === 'number' && Number.isFinite(cam) && cam > 0 ? Math.min(C.lowHz, cam * C.camK) : C.lowHz;
    return hz < lim;
  }
  function fine(hz, cam) {
    if (!(typeof hz === 'number' && Number.isFinite(hz))) return false;
    const lim = typeof cam === 'number' && Number.isFinite(cam) && cam > 0 ? Math.min(C.okHz, cam * 0.9) : C.okHz;
    return hz >= lim;
  }
  // уровень можно понизить: его выбирает perfTuner («Авто») и он выше low
  const canLower = (auto) => !!auto && s.baseTier !== null && TIERS.indexOf(s.baseTier) > 0;
  // уровень на ступени: 1 и выше — на один ниже исходного
  function tierFor(level, auto) {
    if (!canLower(auto)) return null;
    return level >= 1 ? TIERS[TIERS.indexOf(s.baseTier) - 1] : s.baseTier;
  }
  function act(now, level, auto, why) {
    const prev = s.level;
    s.level = level;
    const tier = tierFor(level, auto);
    const out = { level, cap: level >= 2, why };
    if (tier && tier !== s.tierSet) { out.tier = tier; s.tierSet = tier; }
    note(now, `${why}: ступень ${prev} → ${level}${out.tier ? `, качество ${out.tier}` : ''}${out.cap ? ', 30 к/с' : ''}`);
    return out;
  }

  return {
    update(now, v = {}) {
      if (!v.active) { s.badSince = null; s.okSince = null; return null; }
      if (s.level === 0) { s.baseTier = TIERS.includes(v.tier) ? v.tier : null; s.tierSet = s.baseTier; }
      else if (s.tierSet && v.tier && v.tier !== s.tierSet) { s.baseTier = null; s.tierSet = null; } // уровень сменили извне — не наш
      const auto = !!v.auto;
      if (slow(v.hz, v.cameraFps)) {
        s.okSince = null;
        if (s.badSince === null) s.badSince = now;
        if (now - s.badSince >= C.badMs && s.level < C.maxLevel) {
          s.badSince = now;   // следующая ступень — после ещё badMs плохого распознавания
          if (now - s.restoredAt < C.relapseMs) s.pinned = true;
          // уровень уже low (или выбран вручную) — первая же ступень даёт предел кадров
          const next = s.level === 0 && !canLower(auto) ? C.maxLevel : s.level + 1;
          return act(now, next, auto, `распознаваний ${Math.round(v.hz * 10) / 10}/с`);
        }
        return null;
      }
      s.badSince = null;
      if (s.level > 0 && !s.pinned && fine(v.hz, v.cameraFps)) {
        if (s.okSince === null) s.okSince = now;
        if (now - s.okSince >= C.okMs) {
          s.okSince = now;
          s.restoredAt = now;
          const next = s.level >= 2 && !canLower(auto) ? 0 : s.level - 1;
          return act(now, next, auto, 'распознавание восстановилось');
        }
      } else s.okSince = null;
      return null;
    },
    // конец боя (меню, итоги): всё как было
    reset(now = 0) {
      const had = s.level > 0;
      const tier = had && s.baseTier && s.tierSet !== s.baseTier ? s.baseTier : null;
      s.level = 0; s.badSince = null; s.okSince = null; s.pinned = false; s.restoredAt = -Infinity; s.tierSet = s.baseTier;
      if (had) note(now, 'бой окончен: графика как была');
      return had ? { level: 0, cap: false, why: 'бой окончен', ...(tier ? { tier } : {}) } : null;
    },
    get level() { return s.level; },
    state() { return { level: s.level, pinned: s.pinned, baseTier: s.baseTier, tier: s.tierSet, badSince: s.badSince, okSince: s.okSince, log: s.log.slice(-6) }; },
  };
}
