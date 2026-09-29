// ASHEN OATH — левая рука как «руль» (схема движения «Руль», по умолчанию). Владелец: №1.
// Чистая логика: без DOM; время — только из аргументов (мс). API и форма read() совместимы
// с core/leftStick.js (джойстик), чтобы handGestures / vision / combat / HUD работали с обоими.
//
// Идея — без калибровки и без «замри»: нейтраль задана ТЕЛОМ (середина и ширина плеч из позы).
//  • Высота ладони относительно линии плеч (в ширинах плеч sw):
//      ниже груди / на коленях / не видна → СТОП сразу;
//      на уровне груди и выше           → ШАГ вперёд (0.3…0.6 — чем выше, тем быстрее);
//      у плеча / подбородка и выше       → БЕГ (1.0; держать ровно ~1 с вне арены — спринт в бою).
//  • Смещение ладони вбок от её нейтрали (перед левым плечом) → ПОВОРОТ: наружу (влево на
//    зеркальном экране) — влево, к середине груди — вправо. Мёртвая зона и гистерезис, сила
//    поворота растёт со смещением (кривая — тонкое подруливание у центра), выход сглажен.
//  • Резкий дёрг левой рукой — рывок (детектор core/leftStick.js, режим freeDash): вбок — уклон,
//    вверх — вперёд, вниз (с возвратом) — назад. Рывок принимается, только если рука перед дёргом
//    уже стояла поднятой (≥ dashArmMs) — подъём руки с колен рывком не считается; из положения
//    «рука опущена, но в кадре» — только боковой рывок.
// Все пороги — в ширинах плеч, поэтому схема не зависит от расстояния до камеры.
//
// Вход push(): { t, hand: {x, y, scale} | null, wrist: {x, y} | null, body: {x, y, sw} | null,
//   mirror, aspect, busy } — те же единицы, что у leftStick: x·aspect, y вниз в высотах кадра,
//   незеркальный кадр. Левая рука игрока в незеркальном кадре — ПРАВЕЕ середины плеч.
// Выход read(): { mode:'steer', engaged, x (поворот, + вправо на экране), z (вперёд 0..1), turn, fwd,
//   gait, rest, hand/anchor (координаты показа), level/lateral (в sw), levels, turnZone, lean, … }.

import { createLeftStick } from './leftStick.js';

export const DEFAULT_STEER_CONFIG = Object.freeze({
  // поворот (всё в ширинах плеч sw; «наружу» = к левому краю тела игрока)
  neutralX: 0.55,          // нейтраль ладони: столько sw от середины плеч наружу (≈ перед левым плечом)
  neutralAdapt: 0.35,      // нейтраль подстраивается под привычное положение руки в пределах ±столько
                           // ([V6] 0.15 → 0.35: рука «не там» на 10 см — и герой всё время заворачивал)
  neutralTauMs: 5000,      // медленно: пока рука в мёртвой зоне
  // [V6] привычка игрока: после подъёма руки она спокойно встаёт «прямо» — там, где удобно этому
  // игроку. Среднее положение за окно после подъёма сдвигает нейтраль (на долю learnWeight за подъём),
  // если рука стояла спокойно (не рулила сразу же). За 2–3 подъёма нейтраль встаёт под игрока.
  learnFromMs: 150,        // окно после подъёма руки: с этого момента…
  learnFrames: 8,          //   …столько кадров кисти (трекер теряет кадры — окно по кадрам, а не по времени)…
  learnToMs: 1000,         //   …но не позже этого
  learnWeight: 0.5,        //   …сдвиг нейтрали к среднему за подъём
  learnMaxSd: 0.07,        //   рука стояла спокойно: разброс по горизонтали меньше (sw)…
  learnMaxMove: 0.15,      //   …и не ушла вбок от места подъёма дальше (sw): подняли и сразу рулят — не привычка
  dzOn: 0.2,               // поворот начинается дальше стольких sw от нейтрали…
  dzOff: 0.13,             // …и кончается ближе стольких (гистерезис — не мигает)
  turnFull: 0.62,          // здесь поворот полный (1)
  turnCurve: 1.35,         // степень: у центра — тонкое подруливание
  turnTauMs: 120,          // сглаживание выхода поворота ([V6] 90 → 120: курс не «рыскает» от дрожи руки)
  fastHoldSpeed: 4.0,      // sw/с: ладонь летит быстрее — это дёрг (рывок), а не руление: поворот не меняется
  fastWindowMs: 70,        //   скорость — по смещению за это окно
  // вперёд: уровень ладони v = (линия плеч − ладонь) / sw, вверх — плюс
  walkOn: -0.55,           // ладонь на уровне груди — шаг
  walkOff: -0.72,          // ниже — стоп (гистерезис 0.17 sw ≈ 6 см)
  runOn: 0.05,             // у плеча и выше — бег
  runOff: -0.12,
  walkMin: 0.3,            // сила шага у порога…
  walkMag: 0.6,            // …и под порогом бега
  fwdUpTauMs: 200,         // [V6] разгон шаг → бег плавный (не рывок 2 → 5 м/с за кадр); стоп — сразу
  fwdDownTauMs: 110,       //   сбросить с бега на шаг — чуть быстрее
  // потеря кисти
  // [V6] MediaPipe теряет кисть на 3–8 кадров (смаз, край кадра, свет) — раньше герой спотыкался:
  // стоп через 120 мс и выход «протух» через 250. Теперь провал до ~⅓ с ход не прерывает; нарочно
  // опущенная рука по-прежнему останавливает сразу (уход вниз / через нижний край — см. exit*).
  staleMs: 400,            // выход read() без свежих кадров — ноль
  lostStopMs: 330,         // кисть не видна дольше (и запястья нет) — стоп
  exitBottomY: 0.8,        // кисть пропала ниже этой доли кадра — это «опустил руку»: стоп сразу
  exitDownSpeed: 2.5,      // или пропала, уходя вниз быстрее (sw/с)
  wristMaxGapMs: 800,      // запястье позы ведёт вместо кисти (кулак, смаз) не дольше столько
  wristMinSamples: 5,
  // фильтры
  posTauMs: 60,            // (прежний фильтр центра ладони; с V6 — One Euro ниже)
  // [V6] One Euro для центра ладони: рука стоит — сильное сглаживание (руль не дрожит),
  // рука движется — частота среза растёт, задержки почти нет
  minCutoffHz: 1.7,
  beta: 1.1,               // Гц на sw/с
  dCutoffHz: 1.2,
  bodyTauMs: 120,          // середина плеч по горизонтали: быстро — наклон корпуса вместе с рукой не рулит
  bodyTauYMs: 250,         //   и по вертикали (порог «шаг/стоп» не дрожит от шума плеч)
  swTauMs: 500,            // ширина плеч
  leanTauMs: 6000,         // медленная «база» корпуса (подсказка: поворот наклоном корпуса)
  fallbackBodyY: 0.45,     // плеч ещё ни разу не видно: середина плеч по умолчанию (доля кадра)
  fallbackSw: 0.27,        //   и ширина плеч (высот кадра)
  // рывок
  dashArmMs: 220,          // перед дёргом рука уже столько в одном положении (поднята / опущена в кадре)
  dashLowMinV: -1.25,      // «опущена, но в кадре»: не ниже стольких sw под плечами
  dashLowLateral: 0.7,     // из опущенного положения — только боковой рывок (|x| не меньше)
  dashFreezeMs: 350,       // после рывка выход держится на значении до дёрга (рука возвращается)
  // [V6] резкий дёрг без возврата (уровень A) из зоны поворота к нейтрали или через неё — это
  // перехват руля (был поворот влево — резко вправо), а резко вверх — «к плечу, бегу»; это не рывки.
  // «Щелчок» с возвратом — рывок всегда.
  dashReverseFrom: 0.2,    // рука перед дёргом была дальше стольких sw от нейтрали…
  // подсказки
  riseWindowMs: 1500,      // «поднимал руку» — уровень вырос на riseMin за это окно…
  riseMin: 0.3,
  riseHoldMs: 2500,        //   …и это было не раньше стольких мс назад
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function merge(base, patch) {
  const out = { ...base };
  if (patch && typeof patch === 'object') for (const k of Object.keys(base)) if (fin(patch[k])) out[k] = patch[k];
  return out;
}

export function createSteerStick(configPatch = {}) {
  let cfg = merge(DEFAULT_STEER_CONFIG, configPatch);
  // детектор рывка — тот же, что у джойстика; хватка ему не нужна (гейт — здесь)
  const dash = createLeftStick({ freeDash: 1 }, { acceptA: (d) => acceptSharp(d) });
  let s;
  function reset() {
    s = {
      lastT: null, lastSeen: null, lastHandT: null, mirror: true, aspect: 4 / 3,
      bodyF: null, swF: null, bodySlowX: null,
      pos: null, posV: 0, level: null, outward: null, vy: 0, lastLevelRaw: null, lastHandY: null,
      source: 'none', raised: false, raisedSince: null, running: false,
      turning: false, turnF: 0, fwdF: null, lastTgt: 0, neutral: cfg.neutralX, rawHist: [],
      out: { x: 0, z: 0 }, gait: 'idle', busy: false,
      learn: null,           // [V6] накопление положения ладони после подъёма: { n, sum, sum2, done }
      wOff: null, wOffN: 0,
      zone: 'none', zoneHist: [{ t: -Infinity, zone: 'none' }],
      levelHist: [], outHist: [], latHist: [], riseT: -Infinity,
      freezeUntil: -Infinity, freezeOut: null, pendingDash: null,
      handDisp: null,
      counters: { pushes: 0, raises: 0, stops: 0, exits: 0, dashes: 0, dashRejected: 0, dashSteer: 0, wristFrames: 0, learned: 0 },
    };
    dash.reset();
  }
  reset();

  const sw = () => s.swF || cfg.fallbackSw;
  const ref = () => s.bodyF || { x: s.aspect * 0.5, y: cfg.fallbackBodyY };
  function toDisplay(p) {
    if (!p) return null;
    const x = p.x / s.aspect;
    return { x: s.mirror ? 1 - x : x, y: p.y };
  }

  function stop(t, why) {
    if (s.raised) { s.counters.stops++; if (why === 'exit') s.counters.exits++; }
    s.raised = false; s.raisedSince = null; s.running = false; s.turning = false; s.turnF = 0; s.lastTgt = 0;
    s.out = { x: 0, z: 0 }; s.gait = 'idle'; s.fwdF = null;
    s.freezeUntil = -Infinity; s.freezeOut = null;
  }

  function setZone(t, zone) {
    if (zone === s.zone) return;
    s.zone = zone;
    s.zoneHist.push({ t, zone });
    while (s.zoneHist.length > 2 && t - s.zoneHist[1].t > 2500) s.zoneHist.shift();
  }
  function zoneEntryAt(t0) {
    let e = s.zoneHist[0];
    for (const z of s.zoneHist) if (z.t <= t0) e = z;
    return e;
  }

  function push(obs) {
    if (!obs || !fin(obs.t)) return;
    const t = obs.t;
    if (s.lastT !== null && t <= s.lastT) return;
    const dtS = s.lastT === null ? 0 : Math.min(0.25, (t - s.lastT) / 1000);
    s.lastT = t;
    s.counters.pushes++;
    s.mirror = obs.mirror !== false;
    s.aspect = fin(obs.aspect) && obs.aspect > 0 ? obs.aspect : 4 / 3;
    s.busy = !!obs.busy;

    // опора — середина и ширина плеч (сглажены; пропали — держим последние)
    const b = obs.body && fin(obs.body.x) && fin(obs.body.y) ? obs.body : null;
    if (b) {
      if (!s.bodyF || dtS <= 0) s.bodyF = { x: b.x, y: b.y };
      else {
        s.bodyF.x += (b.x - s.bodyF.x) * clamp(dtS * 1000 / cfg.bodyTauMs, 0, 1);
        s.bodyF.y += (b.y - s.bodyF.y) * clamp(dtS * 1000 / cfg.bodyTauYMs, 0, 1);
      }
      if (s.bodySlowX === null) s.bodySlowX = s.bodyF.x;
      else s.bodySlowX += (s.bodyF.x - s.bodySlowX) * clamp(dtS * 1000 / cfg.leanTauMs, 0, 1);
      if (fin(b.sw) && b.sw > 1e-3) s.swF = s.swF === null ? b.sw : s.swF + (b.sw - s.swF) * clamp(dtS * 1000 / cfg.swTauMs, 0, 1);
    }
    const W = sw(), R = ref();

    // источник: кисть; кулак/смаз посреди кадра — запястье позы со смещением к ладони
    const wr = obs.wrist && fin(obs.wrist.x) && fin(obs.wrist.y) ? obs.wrist : null;
    let h = obs.hand && fin(obs.hand.x) && fin(obs.hand.y) ? obs.hand : null;
    if (h) {
      s.lastHandT = t; s.source = 'hand';
      if (wr) {
        const off = { x: (h.x - wr.x) / W, y: (h.y - wr.y) / W };
        if (Math.hypot(off.x, off.y) < 1.5) {
          const k = s.wOff ? clamp(dtS * 3.5, 0, 1) : 1;
          s.wOff = s.wOff ? { x: s.wOff.x + (off.x - s.wOff.x) * k, y: s.wOff.y + (off.y - s.wOff.y) * k } : off;
          s.wOffN++;
        }
      }
    } else {
      // кисть пропала у нижнего края или на быстром движении вниз — «опустил руку»: стоп сразу
      const exiting = s.lastHandY !== null && s.lastHandT !== null && t - s.lastHandT < 600
        && (s.lastHandY > cfg.exitBottomY || s.vy < -cfg.exitDownSpeed);
      if (exiting) { if (s.source !== 'exit') stop(t, 'exit'); s.source = 'exit'; }
      else if (wr && s.wOff && s.wOffN >= cfg.wristMinSamples && s.lastHandT !== null && t - s.lastHandT <= cfg.wristMaxGapMs) {
        h = { x: wr.x + s.wOff.x * W, y: wr.y + s.wOff.y * W, scale: null };
        s.source = 'wrist'; s.counters.wristFrames++;
      } else if (s.source !== 'exit') s.source = 'none';
    }

    if (!h) {
      if (s.lastSeen === null || t - s.lastSeen > cfg.lostStopMs || s.source === 'exit') {
        if (s.raised) stop(t, 'lost');
        s.pos = null; s.rawHist.length = 0; s.lastLevelRaw = null; s.vy = 0;
      }
      s.handDisp = null;
      s.level = null; s.outward = null;
      setZone(t, s.raised ? 'up' : 'none');
      feedDash(obs, t);
      return;
    }
    s.lastSeen = t;

    // фильтр центра ладони
    if (!s.pos || dtS <= 0) { s.pos = { x: h.x, y: h.y }; s.posV = 0; }
    else {
      // [V6] One Euro: скорость (в sw/с) сглажена, частота среза растёт с ней
      const vRaw = Math.hypot(h.x - s.pos.x, h.y - s.pos.y) / W / dtS;
      s.posV += (vRaw - s.posV) * (1 - Math.exp(-dtS * 2 * Math.PI * cfg.dCutoffHz));
      const a = 1 - Math.exp(-dtS * 2 * Math.PI * (cfg.minCutoffHz + cfg.beta * s.posV));
      s.pos.x += (h.x - s.pos.x) * a; s.pos.y += (h.y - s.pos.y) * a;
    }
    const lvRaw = (R.y - h.y) / W;
    const lv = (R.y - s.pos.y) / W;
    const outward = (s.pos.x - R.x) / W;       // + наружу: к левому боку игрока (в незеркальном кадре — вправо)
    if (s.source === 'hand') {
      if (s.lastLevelRaw !== null && dtS > 0) s.vy += ((lvRaw - s.lastLevelRaw) / dtS - s.vy) * clamp(dtS * 12, 0, 1);
      s.lastLevelRaw = lvRaw; s.lastHandY = h.y;
    }
    s.level = lv; s.outward = outward;
    s.handDisp = toDisplay(s.pos);
    s.levelHist.push({ t, v: lv });
    while (s.levelHist.length && t - s.levelHist[0].t > cfg.riseWindowMs) s.levelHist.shift();
    { let mn = Infinity; for (const p of s.levelHist) mn = Math.min(mn, p.v); if (lv - mn >= cfg.riseMin) s.riseT = t; }
    // скорость сырой ладони за короткое окно (sw/с): быстрый дёрг не рулит
    const rx = (h.x - R.x) / W;
    s.rawHist.push({ t, x: rx, v: lvRaw });
    while (s.rawHist.length > 2 && t - s.rawHist[1].t >= cfg.fastWindowMs) s.rawHist.shift();
    const r0 = s.rawHist[0], spanS = (t - r0.t) / 1000;
    const fast = spanS > 0 && Math.hypot(rx - r0.x, lvRaw - r0.v) / spanS > cfg.fastHoldSpeed;

    // вперёд: поднята ли рука (гистерезис; опускание — по сырому уровню, без задержки фильтра)
    if (!s.raised) {
      // подъём — по сырому уровню (отклик без задержки фильтра); от дрожания у порога — гистерезис walkOn/walkOff
      if (lvRaw >= cfg.walkOn) { s.raised = true; s.raisedSince = t; s.counters.raises++; s.learn = { n: 0, sum: 0, sum2: 0, done: false, x0: (h.x - R.x) / W }; }
    } else if (lvRaw < cfg.walkOff || h.y > cfg.exitBottomY) stop(t, 'lowered');

    // [V6] привычное положение руки: окно после подъёма → нейтраль
    if (s.raised && s.learn && !s.learn.done && s.source === 'hand') {
      const since = t - s.raisedSince, L = s.learn;
      if (since >= cfg.learnFromMs && since <= cfg.learnToMs && L.n < cfg.learnFrames) { L.n++; L.sum += outward; L.sum2 += outward * outward; }
      if (L.n >= cfg.learnFrames || since > cfg.learnToMs) {
        L.done = true;
        const m = L.n ? L.sum / L.n : 0, sd = L.n ? Math.sqrt(Math.max(0, L.sum2 / L.n - m * m)) : Infinity;
        // рука встала там же, где была при подъёме (подняли — и держат), а не ушла вбок рулить
        if (L.n >= 5 && sd <= cfg.learnMaxSd && Math.abs(m - L.x0) <= cfg.learnMaxMove) {
          s.neutral = clamp(s.neutral + (m - s.neutral) * cfg.learnWeight, cfg.neutralX - cfg.neutralAdapt, cfg.neutralX + cfg.neutralAdapt);
          s.counters.learned++;
        }
      }
    }

    let out = { x: 0, z: 0 };
    if (s.raised) {
      if (s.running ? lv < cfg.runOff : lv >= cfg.runOn) s.running = !s.running;
      const fwdT = s.running ? 1 : cfg.walkMin + (cfg.walkMag - cfg.walkMin) * clamp((lv - cfg.walkOn) / Math.max(1e-3, cfg.runOn - cfg.walkOn), 0, 1);
      // поворот: смещение от нейтрали, мёртвая зона с гистерезисом, кривая, сглаживание
      const d = outward - s.neutral, ad = Math.abs(d);
      if (s.turning ? ad < cfg.dzOff : ad > cfg.dzOn) s.turning = !s.turning;
      let tgt = 0;
      const frozen = t < s.freezeUntil && s.freezeOut;
      if (frozen) { tgt = s.freezeOut.x; s.turnF = tgt; }        // после рывка руль держится (рука возвращается)
      else if (fast) tgt = s.lastTgt;                                 // дёрг: руль держится как был
      else if (s.turning) {
        const u = clamp((ad - cfg.dzOff) / Math.max(1e-3, cfg.turnFull - cfg.dzOff), 0, 1);
        // наружу (d > 0) — к левому боку игрока: на зеркальном экране это влево (x < 0)
        tgt = (s.mirror ? -1 : 1) * Math.sign(d) * Math.pow(u, cfg.turnCurve);
      } else if (ad < cfg.dzOff) {
        // рука спокойно в мёртвой зоне — нейтраль медленно подстраивается под привычное положение
        const k = clamp(dtS * 1000 / cfg.neutralTauMs, 0, 1);
        s.neutral = clamp(s.neutral + (outward - s.neutral) * k, cfg.neutralX - cfg.neutralAdapt, cfg.neutralX + cfg.neutralAdapt);
      }
      s.lastTgt = tgt;
      s.turnF += (tgt - s.turnF) * (dtS > 0 ? 1 - Math.exp(-dtS * 1000 / cfg.turnTauMs) : 1);
      if (Math.abs(s.turnF) < 1e-3 && tgt === 0) s.turnF = 0;
      // [V6] ход вперёд сглажен; только что подняли руку — сразу с целевого значения (отклик без задержки)
      if (s.fwdF === null || dtS <= 0) s.fwdF = fwdT;
      else s.fwdF += (fwdT - s.fwdF) * (1 - Math.exp(-dtS * 1000 / (fwdT > s.fwdF ? cfg.fwdUpTauMs : cfg.fwdDownTauMs)));
      if (Math.abs(s.fwdF - fwdT) < 0.01) s.fwdF = fwdT;
      const fwd = s.fwdF;
      out = { x: clamp(s.turnF, -1, 1), z: fwd };
      s.gait = s.running ? 'run' : 'walk';
    } else s.gait = 'idle';

    setZone(t, s.raised ? 'up' : lv >= cfg.dashLowMinV ? 'low' : 'none');
    s.outHist.push({ t, x: out.x, z: out.z });
    s.latHist.push({ t, d: outward - s.neutral });
    while (s.latHist.length > 40 || (s.latHist.length && t - s.latHist[0].t > 800)) s.latHist.shift();
    while (s.outHist.length > 40 || (s.outHist.length && t - s.outHist[0].t > 800)) s.outHist.shift();
    feedDash(obs, t);
    if (t < s.freezeUntil && s.freezeOut && s.raised) out = { ...s.freezeOut };
    s.out = out;
  }

  // [V6] Резкий дёрг без возврата (уровень A) в «Руле» срабатывает сразу, только если это не руление:
  // из зоны поворота к нейтрали или через неё — перехват руля; резко вверх — «к плечу, бегу».
  // Такой дёрг остаётся кандидатом «щелчка»: вернул руку — рывок (детектор core/leftStick.js).
  function acceptSharp({ x, z, t0 }) {
    if (z > 0 && z >= Math.abs(x)) { s.counters.dashSteer++; return false; }
    if (Math.abs(x) > Math.abs(z)) {
      let d0 = null;
      for (let i = s.latHist.length - 1; i >= 0; i--) if (s.latHist[i].t <= t0) { d0 = s.latHist[i].d; break; }
      const mo = (s.mirror ? -1 : 1) * x;   // боковая часть дёрга в «наружу»-единицах (+ — к левому боку игрока)
      if (d0 !== null && Math.abs(d0) > cfg.dashReverseFrom && d0 * mo < 0) { s.counters.dashSteer++; return false; }
    }
    return true;
  }

  // Рывок: детектор джойстика (без хватки) + свой гейт по положению руки в момент начала дёрга.
  function feedDash(obs, t) {
    const h = obs.hand && fin(obs.hand.x) && fin(obs.hand.y) ? obs.hand : null;
    dash.push({ t, hand: h ? { x: h.x, y: h.y, scale: h.scale } : null, wrist: obs.wrist, body: obs.body, mirror: s.mirror, aspect: s.aspect, busy: s.busy || s.zone === 'none' });
    const d = dash.takeDash();
    if (!d) return;
    const t0 = fin(d.t0) ? d.t0 : d.t;
    const e = zoneEntryAt(t0);
    const stable = t0 - e.t >= cfg.dashArmMs;
    const ok = stable && (e.zone === 'up' || (e.zone === 'low' && Math.abs(d.x) >= cfg.dashLowLateral));
    if (!ok) { s.counters.dashRejected++; return; }
    s.pendingDash = { t, x: d.x, z: d.z, speed: d.speed, tier: d.tier, from: e.zone };
    s.counters.dashes++;
    let pre = { x: 0, z: 0 };
    for (let i = s.outHist.length - 1; i >= 0; i--) if (s.outHist[i].t <= t0) { pre = { x: s.outHist[i].x, z: s.outHist[i].z }; break; }
    s.freezeOut = pre;
    s.freezeUntil = t + cfg.dashFreezeMs;
  }

  function read(tMs) {
    const t = fin(tMs) ? tMs : (s.lastT ?? 0);
    const fresh = s.lastSeen !== null && t - s.lastSeen <= cfg.staleMs;
    const engaged = fresh && s.raised && !s.busy;
    const x = engaged ? s.out.x : 0, z = engaged ? s.out.z : 0;
    const W = sw(), R = ref();
    const mirrorSign = s.mirror ? -1 : 1;
    const rising = fresh && t - s.riseT <= cfg.riseHoldMs;   // руку недавно поднимали (для подсказки «выше»)
    return {
      mode: 'steer', engaged, x, z, moveX: x, moveZ: z, turn: x, fwd: z,
      gait: engaged ? s.gait : 'idle',
      rest: !(fresh && s.raised), grabbing: false, grabProgress: 0, grabMs: 0,
      busy: s.busy,
      hand: fresh ? s.handDisp : null,
      // нейтраль руля на высоте «шаг» — для колечка на превью камеры (core/trackingHud.js)
      anchor: fresh ? toDisplay({ x: R.x + s.neutral * W, y: R.y - cfg.walkOn * W }) : null,
      deadzone: cfg.dzOn * W, full: cfg.turnFull * W, runOn: cfg.turnFull * W, aspect: s.aspect,
      source: fresh ? s.source : 'none',
      // для крупного индикатора (core/battleHud.js) и подсказок: всё в ширинах плеч
      level: fresh ? s.level : null,
      lateral: fresh && s.outward !== null ? mirrorSign * (s.outward - s.neutral) : null, // + вправо на экране
      levels: { walkOn: cfg.walkOn, walkOff: cfg.walkOff, runOn: cfg.runOn, runOff: cfg.runOff },
      turnZone: { dzOn: cfg.dzOn, dzOff: cfg.dzOff, full: cfg.turnFull },
      lean: s.bodyF && s.bodySlowX !== null ? mirrorSign * (s.bodyF.x - s.bodySlowX) / W : 0,
      rising,
      raisedAt: fresh && s.raised ? s.raisedSince : null,   // [V6] когда подняли руку (щит не путает подъём с толчком)
      levelSpeed: fresh ? Math.abs(s.vy) : 0,                // [V6] как быстро рука идёт вверх/вниз, sw/с (толчок щита — к камере, не вверх)
    };
  }

  function takeDash() { const d = s.pendingDash; s.pendingDash = null; return d; }
  function peekDash() { return s.pendingDash; }
  function configure(patch) { cfg = merge(cfg, patch); }
  function getConfig() { return { ...cfg }; }
  function getDebug() {
    const r3 = (v) => (fin(v) ? Math.round(v * 1000) / 1000 : null);
    return {
      mode: 'steer', raised: s.raised, running: s.running, turning: s.turning, turn: r3(s.turnF),
      level: r3(s.level), outward: r3(s.outward), neutral: r3(s.neutral), sw: r3(s.swF), zone: s.zone,
      source: s.source, out: s.out, gait: s.gait, counters: { ...s.counters }, dash: dash.getDebug().counters,
    };
  }

  return { push, read, takeDash, peekDash, reset: () => reset(), configure, getConfig, getDebug };
}
