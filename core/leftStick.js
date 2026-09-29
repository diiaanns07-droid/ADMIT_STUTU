// ASHEN OATH — левая рука как джойстик (ASHEN_V3). Владелец: №21 (реализация №1).
// Чистая логика: без DOM и импортов; время — только из аргументов (мс).
//
// Идея: игрок поднимает левую руку и на мгновение замирает — это «хватка», центр джойстика.
// Дальше смещение ладони от центра (в «ладонях» S, в плоскости кадра) — направление и сила хода:
// рука вправо на зеркальном экране → x > 0, рука вверх → вперёд (z > 0). Опустил руку к коленям —
// герой стоит, центр сбрасывается. Резкий дёрг рукой — рывок в сторону дёрга.
// Центр хранится относительно середины плеч, поэтому наклон корпуса героя не двигает.
//
// Вход push(): { t, hand: {x, y, scale} | null, wrist: {x, y} | null, body: {x, y, sw} | null, mirror, busy }
//   x, y — центр ладони в кадре с поправкой на аспект (x·aspect, y вниз, y в высотах кадра 0..1),
//   незеркальный кадр; scale — размер ладони в высотах кадра (из handGestures); body — середина
//   плеч в тех же единицах и ширина плеч sw; busy — руки заняты чарами (выход ноль, рывка нет);
//   wrist — левое запястье ПОЗЫ (те же единицы): если кисть потерялась посреди кадра (кулак, смаз),
//   джойстик ведётся по запястью со смещением «запястье → ладонь».
//
// V3 (по аудиту с симуляцией живого модуля):
//  • Остановка = опустить руку. Центр никогда не тянется вниз; кисть, ушедшая за нижний край кадра
//    или быстро вниз, — сразу покой, без рывка и без бега «назад».
//  • Рывок в два уровня: A — очень резкий короткий дёрг от центра (мгновенно); B — «щелчок»:
//    выход от центра и быстрый возврат руки (срабатывает на возврате). Обычное быстрое ведение,
//    возврат в центр, разворот и опускание руки рывка не дают.
//  • Две явные ступени хода с гистерезисом: шаг (сила 0.2…0.6) и бег (1.0) — анимация не мигает.
//  • Единица S = выученный коэффициент «ладонь/плечи» × ширина плеч (старт по медиане), без
//    плеч S не меняется. Опорная точка плеч сглажена (τ 250 мс). Центр «плавает» за рукой вбок и
//    вперёд. Направление мягко притягивается к осям, ход «назад» короче.
//  • Фильтр One Euro острее (задержка ~35 мс вместо ~75).

export const DEFAULT_STICK_CONFIG = Object.freeze({
  // отклик, в ладонях S
  deadzone: 0.4,           // круговая мёртвая зона (начало шага)
  walkFull: 1.05,          // здесь шаг достигает walkMag
  walkMin: 0.2,            // сила хода сразу за мёртвой зоной
  walkMag: 0.6,            // верх ступени «шаг»
  runOn: 1.2,              // дальше — бег (сила 1)
  runOff: 0.95,            // ближе — снова шаг (гистерезис)
  full: 1.6,               // «полный ход» для HUD и плавающего центра
  curve: 1.0,              // (совместимость) степень внутри ступени шага
  // хватка и покой
  grabStillSpeed: 1.6,     // S/с: медленнее — рука «замерла»
  grabMs: 220,             // столько замереть, чтобы взять джойстик
  restDropSW: 1.3,         // покой: ладонь ниже середины плеч на столько ширин плеч…
  restMaxY: 0.85,          // …или ниже этой доли кадра (ноутбук: колени вне кадра)
  restDownS: 2.0,          // после хватки: и ниже точки хватки больше чем на столько S
  exitBottomY: 0.8,        // кисть пропала ниже этой доли кадра — это «опустил руку»
  exitDownSpeed: 3,        // или пропала, двигаясь вниз быстрее (S/с)
  lowerSpeed: 3.5,         // рука ниже центра идёт вниз быстрее (S/с) — «опускает руку»: хода назад нет
  lowerExitY: 0.78,        // и уже ниже этой доли кадра — сразу покой
  stillWindowMs: 110,      // скорость «замер» — по смещению за это окно
  staleMs: 250,            // кисть не видна дольше — выход ноль
  lostResetMs: 900,        // не видна дольше — центр сбрасывается (нужна новая хватка)
  // сглаживание (One Euro): частота среза растёт со скоростью
  minCutoffHz: 1.5,
  beta: 1.2,               // Гц на S/с
  bodyTauMs: 250,          // сглаживание середины плеч (наклон корпуса медленнее — компенсация сохраняется)
  // медленный дрейф центра, пока рука стоит в мёртвой зоне (против усталости)
  driftDelayMs: 2000,
  driftPerSec: 0.5,
  // рывок, уровень A — резкий дёрг
  dashTravel: 1.5,         // хорда, S
  dashWindowMs: 120,       // набрана не дольше чем за столько
  dashSpeed: 12.5,         // средняя скорость, S/с
  dashPeakSpeed: 16,       // пиковая мгновенная скорость, S/с
  dashMinSpanMs: 40,
  dashStraightness: 1.3,   // длина пути / хорда
  dashStartNear: 0.8,      // (A) дёрг от центра…
  dashPreSteady: 1.5,      // дёрг только от спокойной руки: перед началом скорость меньше стольких S/с
  dashPreMs: 100,          //    (за столько мс до начала) — пронос руки через центр при развороте — не дёрг
  dashDownMax: 0.6,        // уровень A не вниз (доля хорды вниз по кадру)
  // рывок, уровень B — «щелчок» с возвратом
  flickTravel: 1.0,        // выход, S
  flickSpeed: 8,           // средняя скорость выхода, S/с
  flickWindowMs: 220,      // выход набран не дольше чем за столько
  flickReturnMs: 450,      // возврат не позже стольких мс от начала выхода
  flickReturnFrac: 0.5,    // вернуть не меньше этой доли выхода
  flickMinOutFrames: 1,    // рука «снаружи» хотя бы столько кадров (схема «Руль» — 2: выброс трекинга не щелчок)
  dashRefractoryMs: 600,
  dashRearmSpeed: 2.5,     // S/с: медленнее столько мс — рывок снова взведён
  dashRearmMs: 110,
  dashFreezeMs: 150,       // после рывка выход держится на значении до дёрга
  glitchSpeed: 60,         // S/с: быстрее — сбой трекинга, история сбрасывается
  // масштаб и запасной источник
  scaleTauMs: 4000,        // постоянная времени коэффициента «ладонь / плечи»
  scaleWarmTauMs: 1500,    // первые scaleWarmMs — быстрее
  scaleWarmMs: 3000,
  floatK: 1.3,             // рука дальше floatK·full вбок/вперёд — центр подтягивается (плавающий джойстик)
  snapDeg: 12,             // притяжение направления к осям в пределах ±snapDeg
  backGain: 1.25,          // ход «назад» (рука вниз) короче: вниз руке тесно у колен
  wristBlend: 0.35,        // скорость выучивания смещения «запястье → ладонь» (1/с·10)
  wristMinSamples: 5,      // запястьем ведём, только если смещение выучено хотя бы по стольким кадрам
  wristMaxGapMs: 800,      // запястьем ведём не дольше столько после потери кисти
  freeDash: 0,             // 1 — рывок ловится и без хватки (схема «Руль», core/steerStick.js: там свой гейт)
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function merge(base, patch) {
  const out = { ...base };
  if (patch && typeof patch === 'object') for (const k of Object.keys(base)) if (fin(patch[k])) out[k] = patch[k];
  return out;
}

// hooks.acceptA({ x, z, t0, t }) → false: резкий дёрг уровня A не срабатывает сразу, а остаётся
// кандидатом «щелчка» (рывок — на возврате руки). x, z — направление в осях выхода (как у рывка).
export function createLeftStick(configPatch = {}, hooks = {}) {
  let cfg = merge(DEFAULT_STICK_CONFIG, configPatch);
  let s;
  function reset() {
    s = {
      lastT: null, lastSeen: null, mirror: true,
      filt: null, filtV: 0,            // отфильтрованная позиция (отн. плеч) и её скорость (S/с)
      S: 0.1, rest: true,
      engaged: false, anchor: null, grabY: null, // центр (отн. плеч); высота точки хватки
      stillSince: null, driftSince: null,
      out: { x: 0, z: 0 }, running: false, gait: 'idle',
      hist: [],                        // {t, x, y} сырые позиции (отн. плеч) для рывка
      outHist: [],                     // {t, x, z} выход для «заморозки» при рывке
      dashArmed: true, dashBlockedUntil: -Infinity, slowSince: null, freezeUntil: -Infinity, freezeOut: null,
      flick: null,                     // кандидат «щелчка»: {t0, x0, y0, ux, uy, d, peak}
      pendingDash: null, handDisp: null, anchorDisp: null, body: null, bodyF: null,
      k: null, kSamples: [], firstScaleT: null, // коэффициент S / ширина плеч
      wOff: null, wOffN: 0, lastHandT: null, lastHandY: null, lastVy: 0, source: 'none', prevSource: 'none',
      counters: { pushes: 0, grabs: 0, dashes: 0, dashA: 0, dashB: 0, glitches: 0, wristFrames: 0, floats: 0, exits: 0 },
    };
  }
  reset();

  // координаты показа: 0..1, x зеркален как превью
  function toDisplay(p, aspect) {
    if (!p) return null;
    const x = p.x / aspect;
    return { x: s.mirror ? 1 - x : x, y: p.y };
  }

  function enterRest() {
    s.engaged = false; s.anchor = null; s.grabY = null; s.stillSince = null; s.out = { x: 0, z: 0 };
    s.running = false; s.gait = 'idle';
    s.dashArmed = true; s.pendingDash = null; s.flick = null; s.freezeUntil = -Infinity; s.freezeOut = null;
    s.anchorDisp = null;
  }

  function learnScale(h, sw, t, dtS) {
    if (!sw || !fin(h.scale) || h.scale <= 1e-4 || !(h.y < 0.9)) return;
    const r = h.scale / sw;
    if (s.k === null) {
      // старт — медиана первых 8 кадров (первый кадр у края часто искажён)
      s.kSamples.push(r);
      if (s.firstScaleT === null) s.firstScaleT = t;
      if (s.kSamples.length >= 8 || (s.kSamples.length >= 3 && t - s.firstScaleT > 600)) {
        const q = [...s.kSamples].sort((a, b) => a - b);
        s.k = q[q.length >> 1];
      }
      return;
    }
    const tau = t - s.firstScaleT < cfg.scaleWarmMs ? cfg.scaleWarmTauMs : cfg.scaleTauMs;
    s.k += (r - s.k) * clamp(dtS * 1000 / tau, 0, 1);
  }

  function push(obs) {
    if (!obs || !fin(obs.t)) return;
    const t = obs.t;
    if (s.lastT !== null && t <= s.lastT) return;
    const dtS = s.lastT === null ? 0 : Math.min(0.25, (t - s.lastT) / 1000);
    s.lastT = t;
    s.counters.pushes++;
    s.mirror = obs.mirror !== false;
    const aspect = fin(obs.aspect) && obs.aspect > 0 ? obs.aspect : 4 / 3;
    s.aspect = aspect;
    const b = obs.body && fin(obs.body.x) && fin(obs.body.y) ? obs.body : null;
    if (b) {
      s.body = b;
      // сглаженная опорная точка: шум и провалы плеч позы не трясут джойстик
      if (!s.bodyF || dtS <= 0) s.bodyF = { x: b.x, y: b.y };
      else { const k = clamp(dtS * 1000 / cfg.bodyTauMs, 0, 1); s.bodyF.x += (b.x - s.bodyF.x) * k; s.bodyF.y += (b.y - s.bodyF.y) * k; }
    }
    const sw = b && fin(b.sw) && b.sw > 1e-3 ? b.sw : null;
    const wr = obs.wrist && fin(obs.wrist.x) && fin(obs.wrist.y) ? obs.wrist : null;
    let h = obs.hand && fin(obs.hand.x) && fin(obs.hand.y) ? obs.hand : null;
    if (h) {
      s.lastHandT = t; s.source = 'hand';
      learnScale(h, sw, t, dtS);
      if (wr) {
        const S0 = Math.max(0.02, s.S);
        const off = { x: (h.x - wr.x) / S0, y: (h.y - wr.y) / S0 };
        if (Math.hypot(off.x, off.y) < 3) {
          const k = clamp(dtS * cfg.wristBlend * 10, 0, 1);
          s.wOff = s.wOff ? { x: s.wOff.x + (off.x - s.wOff.x) * k, y: s.wOff.y + (off.y - s.wOff.y) * k } : off;
          s.wOffN++;
        }
      }
    } else {
      // кисть пропала. Внизу кадра или на быстром движении вниз — это «опустил руку»: сразу покой.
      const exiting = s.lastHandY !== null && (s.lastHandY > cfg.exitBottomY || s.lastVy > cfg.exitDownSpeed);
      if (s.engaged && exiting && s.lastHandT !== null && t - s.lastHandT < cfg.lostResetMs) {
        if (s.source !== 'exit') { s.counters.exits++; enterRest(); s.rest = true; }
        s.source = 'exit'; s.handDisp = null;
        return;
      }
      if (wr && !exiting && s.engaged && s.lastHandT !== null && t - s.lastHandT <= cfg.wristMaxGapMs && s.wOff && s.wOffN >= cfg.wristMinSamples) {
        // посреди кадра (кулак, смаз) — ведём по запястью позы со смещением к центру ладони
        const S0 = Math.max(0.02, s.S);
        h = { x: wr.x + s.wOff.x * S0, y: wr.y + s.wOff.y * S0, scale: null };
        s.source = 'wrist'; s.counters.wristFrames++;
      } else if (s.source !== 'exit') s.source = 'none';
    }

    if (!h) {
      if (s.lastSeen !== null && t - s.lastSeen > cfg.lostResetMs) { enterRest(); s.filt = null; s.hist.length = 0; }
      if (s.lastSeen === null || t - s.lastSeen > cfg.staleMs) s.out = { x: 0, z: 0 };
      s.handDisp = null;
      return;
    }
    s.lastSeen = t;
    // смена источника (кисть ↔ запястье) — скачок позиции не должен стать рывком
    if (s.source !== s.prevSource) { s.hist.length = 0; s.flick = null; s.prevSource = s.source; }
    // S = коэффициент × ширина плеч (стабильно); без плеч S не меняется; без плеч вообще — размер ладони
    let target = null;
    if (sw && s.k !== null) target = s.k * sw;
    else if (!sw && s.k === null && fin(h.scale) && h.scale > 1e-4) target = h.scale;
    else if (sw && s.k === null && fin(h.scale) && h.scale > 1e-4) target = h.scale;
    if (target !== null) s.S = s.S === 0.1 && !s.filt ? target : s.S + (target - s.S) * clamp(dtS * 4, 0, 1);
    const S = Math.max(0.02, s.S);
    const ref = s.bodyF || { x: 0, y: 0 };
    const rel = { x: h.x - ref.x, y: h.y - ref.y };
    s.handDisp = toDisplay(h, aspect);

    // сбой трекинга: скачок быстрее glitchSpeed — начать заново
    const prevRaw = s.hist[s.hist.length - 1];
    if (prevRaw && dtS > 0) {
      const v = Math.hypot(rel.x - prevRaw.x, rel.y - prevRaw.y) / S / Math.max(1e-3, (t - prevRaw.t) / 1000);
      if (v > cfg.glitchSpeed) { s.hist.length = 0; s.flick = null; s.counters.glitches++; }
    }
    s.hist.push({ t, x: rel.x, y: rel.y });
    while (s.hist.length > 48 || (s.hist.length && t - s.hist[0].t > 600)) s.hist.shift();
    // вертикальная скорость кисти в кадре (для «опустил руку»)
    if (s.source === 'hand') {
      if (s.lastHandY !== null && dtS > 0) s.lastVy += ((h.y - s.lastHandY) / S / dtS - s.lastVy) * clamp(dtS * 12, 0, 1);
      s.lastHandY = h.y;
    }

    // One Euro: адаптивная частота среза по скорости
    if (!s.filt || dtS <= 0) { s.filt = { ...rel }; s.filtV = 0; }
    else {
      const vx = (rel.x - s.filt.x) / dtS / S, vy = (rel.y - s.filt.y) / dtS / S;
      const vRaw = Math.hypot(vx, vy);
      s.filtV += (vRaw - s.filtV) * (1 - Math.exp(-dtS * 2 * Math.PI * 1.0));
      const fc = cfg.minCutoffHz + cfg.beta * s.filtV;
      const a = 1 - Math.exp(-dtS * 2 * Math.PI * fc);
      s.filt.x += (rel.x - s.filt.x) * a;
      s.filt.y += (rel.y - s.filt.y) * a;
    }
    // скорость «замер»: смещение сырых точек за короткое окно
    let speed = 0;
    for (let i = s.hist.length - 2; i >= 0; i--) {
      const p = s.hist[i], span = t - p.t;
      if (span >= cfg.stillWindowMs || i === 0) { speed = span > 0 ? Math.hypot(rel.x - p.x, rel.y - p.y) / S / (span / 1000) : 0; break; }
    }

    // покой: ладонь у колен (ниже плеч на restDropSW·sw или ниже restMaxY кадра);
    // после хватки — ещё и заметно ниже точки хватки
    const restY = b && sw ? Math.min(cfg.restMaxY, b.y + cfg.restDropSW * sw) : cfg.restMaxY;
    const low = h.y > restY;
    // «опускает руку»: ниже центра и уверенно идёт вниз
    const lowering = s.engaged && s.anchor && s.source === 'hand' && s.lastVy > cfg.lowerSpeed && s.filt.y > s.anchor.y;
    if (s.engaged && s.anchor) s.rest = (low && s.grabY !== null && (s.filt.y - s.grabY) / S > cfg.restDownS) || (lowering && h.y > cfg.lowerExitY);
    else s.rest = low;
    if (s.rest) { enterRest(); s.rest = true; return; }

    // хватка
    if (!s.engaged) {
      if (speed < cfg.grabStillSpeed) {
        if (s.stillSince === null) s.stillSince = t;
        if (t - s.stillSince >= cfg.grabMs) {
          s.engaged = true; s.anchor = { ...rel }; s.grabY = rel.y; s.filt = { ...rel }; s.driftSince = null; s.stillSince = null;
          s.running = false; s.counters.grabs++;
        }
      } else s.stillSince = null;
    }

    let out = { x: 0, z: 0 };
    let r = 0;
    if (s.engaged && s.anchor && !obs.busy) {
      let ox = (s.filt.x - s.anchor.x) / S, oy = (s.filt.y - s.anchor.y) / S;
      // плавающий центр: вбок и вперёд центр подтягивается за рукой; когда рука ниже центра —
      // никогда (иначе опускание руки превращалось бы в бег назад; ход там и так насыщен бегом)
      {
        const rr = Math.hypot(ox, oy), lim = cfg.full * cfg.floatK;
        if (rr > lim && oy <= 0) {
          const k = (rr - lim) / rr;
          s.anchor.x += (s.filt.x - s.anchor.x) * k;
          s.anchor.y += (s.filt.y - s.anchor.y) * k;
          ox = (s.filt.x - s.anchor.x) / S; oy = (s.filt.y - s.anchor.y) / S;
          s.counters.floats++;
        }
      }
      const oyG = oy > 0 ? oy * cfg.backGain : oy;              // вниз (назад) ход короче
      r = Math.hypot(ox, oyG);
      // две ступени с гистерезисом: шаг 0.2…0.6, бег 1.0
      if (s.running ? r < cfg.runOff : r >= cfg.runOn) s.running = !s.running;
      if (r > cfg.deadzone || s.running) {
        let mag;
        if (s.running) mag = 1;
        else {
          const u = clamp((r - cfg.deadzone) / Math.max(1e-3, cfg.walkFull - cfg.deadzone), 0, 1);
          mag = cfg.walkMin + (cfg.walkMag - cfg.walkMin) * Math.pow(u, cfg.curve);
        }
        let a = Math.atan2(s.mirror ? -ox : ox, -oyG);           // угол выхода: 0 — вперёд, + — вправо
        a = snapAxes(a, cfg.snapDeg * Math.PI / 180);
        out = { x: Math.sin(a) * mag, z: Math.cos(a) * mag };
        if (lowering && out.z < 0) { out = { x: 0, z: 0 }; s.running = false; } // опускание — не бег назад
        s.driftSince = null;
      } else if (speed < cfg.grabStillSpeed) {
        if (s.driftSince === null) s.driftSince = t;
        if (t - s.driftSince >= cfg.driftDelayMs) {
          const k = clamp(cfg.driftPerSec * dtS, 0, 1);
          s.anchor.x += (s.filt.x - s.anchor.x) * k;
          s.anchor.y += (s.filt.y - s.anchor.y) * k;
        }
      } else s.driftSince = null;
    } else s.running = false;
    s.gait = !s.engaged || obs.busy ? 'idle' : s.running ? 'run' : r > cfg.deadzone ? 'walk' : 'idle';
    s.anchorDisp = s.anchor ? toDisplay({ x: s.anchor.x + ref.x, y: s.anchor.y + ref.y }, aspect) : null;

    // рывок — только когда джойстик взят, руки не заняты и кисть не у нижнего края
    detectDash(t, S, !!((s.engaged || cfg.freeDash > 0) && !obs.busy && h.y < cfg.restMaxY));

    s.outHist.push({ t, x: out.x, z: out.z });
    while (s.outHist.length > 40 || (s.outHist.length && t - s.outHist[0].t > 700)) s.outHist.shift();
    if (t < s.freezeUntil && s.freezeOut) out = { ...s.freezeOut };
    s.out = out;
  }

  // притяжение к осям: до ±0.6w от «вперёд/назад/вбок» — ровно по оси, до ±w — плавный переход
  function snapAxes(a, w) {
    if (!(w > 0)) return a;
    const q = Math.PI / 2;
    const c = Math.round(a / q) * q, d = a - c, ad = Math.abs(d);
    if (ad >= w) return a;
    const u = clamp((ad - 0.6 * w) / (0.4 * w), 0, 1);
    return c + Math.sign(d) * w * u * u * (3 - 2 * u);
  }

  function fireDash(t, ux, uy, speed, t0, tier) {
    s.pendingDash = { t, t0, x: s.mirror ? -ux : ux, z: -uy, speed, tier };
    s.dashArmed = false; s.slowSince = null; s.flick = null;
    s.dashBlockedUntil = t + cfg.dashRefractoryMs;
    s.counters.dashes++;
    if (tier === 'A') s.counters.dashA++; else s.counters.dashB++;
    // выход замирает на значении до начала дёрга
    let pre = { x: 0, z: 0 };
    for (let i = s.outHist.length - 1; i >= 0; i--) if (s.outHist[i].t <= t0) { pre = { x: s.outHist[i].x, z: s.outHist[i].z }; break; }
    s.freezeOut = pre;
    s.freezeUntil = t + cfg.dashFreezeMs;
  }

  function detectDash(t, S, allowed) {
    const n = s.hist.length;
    const instV = (i) => { const a = s.hist[i - 1], c = s.hist[i]; return Math.hypot(c.x - a.x, c.y - a.y) / S / Math.max(1e-3, (c.t - a.t) / 1000); };
    const vNow = n >= 2 ? instV(n - 1) : 0;
    if (!s.dashArmed) {
      if (vNow < cfg.dashRearmSpeed) {
        if (s.slowSince === null) s.slowSince = t;
        if (t - s.slowSince >= cfg.dashRearmMs && t >= s.dashBlockedUntil) s.dashArmed = true;
      } else s.slowSince = null;
      return;
    }
    if (!allowed || t < s.dashBlockedUntil || n < 3 || (!s.anchor && !(cfg.freeDash > 0))) { if (!allowed) s.flick = null; return; }
    const now = s.hist[n - 1];
    // рука перед началом дёрга стояла спокойно: пронос через центр при развороте — не дёрг.
    // Прошлое неизвестно (история только что сброшена сбоем или сменой источника) — тоже не дёрг.
    const steadyBefore = (i) => {
      const p = s.hist[i];
      for (let j = i - 1; j >= 0; j--) {
        const q = s.hist[j];
        if (p.t - q.t >= cfg.dashPreMs) return Math.hypot(p.x - q.x, p.y - q.y) / S / ((p.t - q.t) / 1000) < cfg.dashPreSteady;
      }
      return false;
    };

    // уровень B: идёт кандидат «щелчка» — ждём возврата
    if (s.flick) {
      const F = s.flick;
      const proj = ((now.x - F.x0) * F.ux + (now.y - F.y0) * F.uy) / S;
      if (proj > F.peak) F.peak = proj;
      if (proj >= 0.6 * F.d) F.outN++;
      // рука пробыла «снаружи» хотя бы flickMinOutFrames кадров: выброс трекинга (кисть на один кадр
      // прыгнула и вернулась) щелчком не считается
      if (F.peak - proj >= cfg.flickReturnFrac * F.d && F.peak >= F.d * 0.9 && F.outN >= cfg.flickMinOutFrames) { fireDash(t, F.ux, F.uy, F.v, F.t0, 'B'); return; }
      if (t - F.t0 > cfg.flickReturnMs) s.flick = null;          // возврата нет — это было ведение
    }

    // уровень A и начало «щелчка»: ищем хорду от точки возле центра (все точки окна)
    let cand = null;
    for (let i = n - 2; i >= 0; i--) {
      const p = s.hist[i];
      const span = now.t - p.t;
      if (span > cfg.flickWindowMs) break;
      if (span < cfg.dashMinSpanMs) continue;
      if (!steadyBefore(i)) continue;
      const dx = (now.x - p.x) / S, dy = (now.y - p.y) / S;
      const d = Math.hypot(dx, dy);
      if (d < cfg.flickTravel) continue;
      const v = d / (span / 1000);
      let path = 0, peak = 0;
      for (let j = i + 1; j < n; j++) { path += Math.hypot(s.hist[j].x - s.hist[j - 1].x, s.hist[j].y - s.hist[j - 1].y) / S; peak = Math.max(peak, instV(j)); }
      if (path / d > cfg.dashStraightness) continue;
      const ux = dx / d, uy = dy / d;
      if (span <= cfg.dashWindowMs && d >= cfg.dashTravel && v >= cfg.dashSpeed && peak >= cfg.dashPeakSpeed && uy < cfg.dashDownMax
        && (!hooks.acceptA || hooks.acceptA({ x: s.mirror ? -ux : ux, z: -uy, t0: p.t, t }) !== false)) {
        fireDash(t, ux, uy, v, p.t, 'A');
        return;
      }
      if (v >= cfg.flickSpeed && (!cand || d > cand.d)) cand = { t0: p.t, x0: p.x, y0: p.y, ux, uy, d, v, peak: d, outN: 1 };
    }
    if (cand && !s.flick) s.flick = cand;
  }

  function read(tMs) {
    const t = fin(tMs) ? tMs : (s.lastT ?? 0);
    const fresh = s.lastSeen !== null && t - s.lastSeen <= cfg.staleMs;
    const engaged = fresh && s.engaged && !s.rest;
    const x = engaged ? s.out.x : 0, z = engaged ? s.out.z : 0;
    return {
      engaged, x, z, moveX: x, moveZ: z,
      gait: engaged ? s.gait : 'idle',
      rest: s.rest, grabbing: fresh && !s.engaged && !s.rest && s.stillSince !== null,
      hand: fresh ? s.handDisp : null, anchor: engaged ? s.anchorDisp : null,
      deadzone: cfg.deadzone * s.S, full: cfg.full * s.S, runOn: cfg.runOn * s.S, aspect: s.aspect || 4 / 3,
      grabMs: cfg.grabMs, grabProgress: fresh && !s.engaged && s.stillSince !== null ? Math.min(1, (t - s.stillSince) / cfg.grabMs) : 0,
      source: fresh ? s.source : 'none',
    };
  }

  // Импульс рывка: один раз на дёрг, TTL — у потребителя.
  function takeDash() { const d = s.pendingDash; s.pendingDash = null; return d; }
  function peekDash() { return s.pendingDash; }

  function configure(patch) { cfg = merge(cfg, patch); }
  function getConfig() { return { ...cfg }; }
  function getDebug() {
    return {
      engaged: s.engaged, rest: s.rest, S: Math.round(s.S * 1000) / 1000, speed: Math.round(s.filtV * 100) / 100,
      anchor: s.anchor, out: s.out, gait: s.gait, dashArmed: s.dashArmed, flick: !!s.flick, counters: { ...s.counters },
      k: s.k === null ? null : Math.round(s.k * 1000) / 1000, source: s.source,
    };
  }

  return { push, read, takeDash, peekDash, reset: () => reset(), configure, getConfig, getDebug };
}
