// Счётчик приседаний с контролем техники (ASHEN_V2). Владелец: №1.
// Чистая логика: без DOM, время приходит в аргументах. Вход — 33 точки позы MediaPipe
// (нормированные x,y + visibility): бёдра 23/24, колени 25/26, лодыжки 27/28, пятки 29/30,
// носки 31/32, плечи 11/12. Ось x домножается на соотношение сторон кадра.
//
// Угол колена. Сбоку его видно прямо (бедро–колено–лодыжка). Спереди бедро уходит «в камеру»,
// и плоский угол почти не меняется, поэтому берём оценку по бедру: h = (y колена − y таза) /
// длина бедра стоя (1 — стоим, 0 — таз на уровне колена), угол ≈ 180° − acos(h).
// Итоговый угол — меньший из двух. Вид (спереди/сбоку) — по ширине таза относительно бедра.
//
// Повтор: стоим (угол ≥ lockDeg) → вниз (≤ downDeg, таз около колена) → снова выпрямились.
// Ошибки (повтор не засчитывается, у каждой код и подсказка SQUAT_HINTS):
//   shallow — не дошёл до глубины; valgus — колени внутрь (спереди); knees_forward — колени далеко
//   за носками (сбоку); lean — корпус наклонён сильнее leanDeg; heels — пятки оторвались;
//   fast — повтор короче minRepMs; lockout — не выпрямился наверху; frame — не видно ног до стоп.
//
// createSquatCounter(cfg?) → { push({tMs, landmarks, frameW, frameH}), read(), drain(), reset(), getDebug() }

export const SQUAT_VERSION = 'ASHEN_V2-squat-1';

export const SQUAT_HINTS = Object.freeze({
  shallow: 'Садись глубже — бёдра до параллели с полом',
  valgus: 'Колени заваливаются внутрь — разводи их в стороны, по линии носков',
  knees_forward: 'Колени выходят за носки — отводи таз назад, как будто садишься на стул',
  lean: 'Спина падает вперёд — держи грудь выше, смотри вперёд',
  fast: 'Слишком быстро — опускайся подконтрольно, 2 секунды вниз',
  heels: 'Пятки отрываются от пола — дави пятками в пол, вес на всю стопу',
  lockout: 'Выпрямись полностью наверху',
  frame: 'Отойди от камеры — нужно видеть тебя целиком, до стоп',
});
// Порядок важности: если в повторе несколько ошибок, подсказка — про первую из списка.
export const SQUAT_FAULT_ORDER = Object.freeze(['shallow', 'valgus', 'knees_forward', 'lean', 'heels', 'fast', 'lockout']);

export const DEFAULT_SQUAT_CONFIG = Object.freeze({
  minVisibility: 0.5,
  lockDeg: 160,          // выпрямлен (верх)
  startDeg: 150,         // ниже — начался повтор
  attemptDeg: 140,       // дошёл хотя бы сюда — это попытка (иначе дрожь, не считаем)
  downDeg: 100,          // глубина засчитана
  riseDeg: 10,           // поднялся от минимума на столько — фаза подъёма
  relockDropDeg: 12,     // на подъёме снова пошёл вниз на столько, не выпрямившись, — «выпрямись»
  stuckMs: 1600,         // завис на подъёме между attemptDeg и lockDeg — «выпрямись»
  setupMs: 450,          // постоять выпрямившись, прежде чем считать
  minRepMs: 800,
  maxRepMs: 12000,
  lostMs: 500,
  smoothMs: 60,          // сглаживание угла (постоянная времени)
  refDecayPerSec: 0.03,  // длины сегментов «стоя» медленно забываются (только в фазе top)
  frontRatio: 0.45,      // ширина таза / бедро ≥ — вид спереди
  sideRatio: 0.3,        // < — вид сбоку; между — 45°
  checkDeg: 135,         // ошибки позы проверяются, когда угол колена ниже этого
  holdFrames: 3,         // ошибка должна продержаться столько кадров подряд
  valgusRatio: 0.75,     // колени ближе, чем 0,75 ширины лодыжек, — завал внутрь
  minStanceRatio: 0.3,   // ширина лодыжек / бедро меньше — стопы вместе, завал не судим
  kneeToeMax: 0.25,      // колено дальше носка на 25% голени (сбоку)
  leanDeg: 50,           // наклон корпуса от вертикали (сбоку)
  leanFrontRatio: 0.6,   // спереди: корпус укоротился до 60% длины стоя (≈ 53°)
  heelRise: 0.07,        // пятка поднялась относительно носка на 7% голени
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = 180 / Math.PI;
const SIDES = [
  { hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31, sh: 11 },
  { hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32, sh: 12 },
];

export function createSquatCounter(userCfg) {
  const cfg = { ...DEFAULT_SQUAT_CONFIG, ...(userCfg && typeof userCfg === 'object' ? userCfg : {}) };
  let s;
  function reset() {
    s = {
      reps: 0, attempts: 0, phase: 'noPose', lastT: null, lastSeen: null, upSince: null,
      knee: null, kneeRaw: null, view: null, depth: 0,
      thighRef: 0, shinRef: 0, torsoRef: 0, heel0: [null, null],
      rep: null, message: 'Встаньте в полный рост: в кадре — от плеч до стоп',
      lastRep: null, lastHint: null, pending: [],
      faults: Object.fromEntries(Object.keys(SQUAT_HINTS).map((k) => [k, 0])),
    };
  }
  reset();

  const vis = (p) => p && fin(p.x) && fin(p.y) && (!fin(p.visibility) || p.visibility >= cfg.minVisibility);
  const wvis = (p) => (p && fin(p.visibility) ? p.visibility : 1);

  function hint(code, t) {
    s.lastHint = { code, text: SQUAT_HINTS[code], tMs: t };
    s.message = SQUAT_HINTS[code];
  }

  function measure(L, ax, dt) {
    const P = (i) => (vis(L[i]) ? { x: L[i].x * ax, y: L[i].y } : null);
    const legs = SIDES.map((d) => {
      const hip = P(d.hip), knee = P(d.knee), ankle = P(d.ankle);
      if (!hip || !knee || !ankle) return null;
      return {
        hip, knee, ankle, heel: P(d.heel), toe: P(d.toe), sh: P(d.sh),
        w: wvis(L[d.hip]) + wvis(L[d.knee]) + wvis(L[d.ankle]) + wvis(L[d.toe]),
      };
    });
    const ok = legs.filter(Boolean);
    if (!ok.length) return null;
    const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    // эталонные длины «стоя»: максимум, медленно забывается; бедро не короче 0,8 голени
    let thigh = 0, shin = 0;
    for (const g of ok) { thigh = Math.max(thigh, len(g.hip, g.knee)); shin = Math.max(shin, len(g.knee, g.ankle)); }
    // забываем только стоя (фаза top): в полуприседе бедро укорочено и не должно стать эталоном
    const decay = s.phase === 'top' ? 1 - cfg.refDecayPerSec * dt : 1;
    s.shinRef = Math.max(shin, s.shinRef * decay);
    s.thighRef = Math.max(thigh, s.thighRef * decay, 0.8 * s.shinRef);
    if (s.thighRef < 1e-4 || s.shinRef < 1e-4) return null;
    // угол колена: плоский и оценка по высоте таза над коленом; берём меньший
    let kneeDeg = 180;
    for (const g of ok) {
      const v1x = g.hip.x - g.knee.x, v1y = g.hip.y - g.knee.y, v2x = g.ankle.x - g.knee.x, v2y = g.ankle.y - g.knee.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      const flat = l1 > 1e-6 && l2 > 1e-6 ? Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * DEG : 180;
      const h = clamp((g.knee.y - g.hip.y) / s.thighRef, -1, 1);
      const est = 180 - Math.acos(h) * DEG;
      kneeDeg = Math.min(kneeDeg, flat, est);
    }
    const both = legs[0] && legs[1];
    const hipW = both ? Math.abs(legs[0].hip.x - legs[1].hip.x) : 0;
    const ratio = hipW / s.thighRef;
    const view = !both ? 'side' : ratio >= cfg.frontRatio ? 'front' : ratio < cfg.sideRatio ? 'side' : 'diag';
    const main = ok.slice().sort((a, b) => b.w - a.w)[0];
    return { legs, ok, both, view, kneeDeg, main };
  }

  // ошибки позы на текущем кадре (только в нижней части повтора)
  function postureFaults(m) {
    const out = [];
    const { legs, both, view, main } = m;
    if (both && view !== 'side') {
      const kd = legs[0].knee.x - legs[1].knee.x, ad = legs[0].ankle.x - legs[1].ankle.x;
      if (Math.abs(ad) >= cfg.minStanceRatio * s.thighRef) {
        const lim = view === 'front' ? cfg.valgusRatio : cfg.valgusRatio * 0.9;
        if (Math.sign(kd) !== Math.sign(ad) || Math.abs(kd) < lim * Math.abs(ad)) out.push('valgus');
      }
    }
    if (view === 'side' && main.toe && main.heel) {
      const dir = Math.sign(main.toe.x - main.heel.x) || Math.sign(main.toe.x - main.ankle.x);
      if (dir && (main.knee.x - main.toe.x) * dir > cfg.kneeToeMax * s.shinRef) out.push('knees_forward');
    }
    // корпус: середина плеч над серединой таза
    const shs = m.ok.filter((g) => g.sh);
    if (shs.length) {
      const sx = shs.reduce((a, g) => a + g.sh.x, 0) / shs.length, sy = shs.reduce((a, g) => a + g.sh.y, 0) / shs.length;
      const hx = shs.reduce((a, g) => a + g.hip.x, 0) / shs.length, hy = shs.reduce((a, g) => a + g.hip.y, 0) / shs.length;
      const tl = Math.hypot(sx - hx, sy - hy);
      if (view === 'front') {
        if (s.torsoRef > 1e-4 && (hy - sy) < cfg.leanFrontRatio * s.torsoRef) out.push('lean');
      } else if (tl > 1e-4) {
        const ang = Math.atan2(Math.abs(sx - hx), hy - sy) * DEG;
        if (ang > cfg.leanDeg) out.push('lean');
      }
    }
    for (let i = 0; i < 2; i++) {
      const g = legs[i];
      if (!g || !g.heel || !g.toe || s.heel0[i] === null) continue;
      const rise = (s.heel0[i] - (g.heel.y - g.toe.y)) / s.shinRef;
      if (rise > cfg.heelRise) { out.push('heels'); break; }
    }
    return out;
  }

  // эталоны позы «стоя»: длина корпуса, положение пяток относительно носков
  function learnStanding(m) {
    const shs = m.ok.filter((g) => g.sh);
    if (shs.length) {
      const tl = shs.reduce((a, g) => a + (g.hip.y - g.sh.y), 0) / shs.length;
      s.torsoRef = s.torsoRef ? Math.max(tl, s.torsoRef * 0.995) : tl;
    }
    for (let i = 0; i < 2; i++) {
      const g = m.legs[i];
      if (!g || !g.heel || !g.toe) continue;
      const d = g.heel.y - g.toe.y;
      s.heel0[i] = s.heel0[i] === null ? d : s.heel0[i] * 0.9 + d * 0.1;
    }
  }

  function startRep(t) {
    s.rep = { start: t, min: s.knee, peak: s.knee, deep: false, rising: false, streak: {}, faults: new Set(), live: new Set(), riseSince: null };
    s.phase = 'descent';
  }

  function finishRep(t, extra) {
    const r = s.rep;
    if (!r) return;
    const faults = new Set(r.faults);
    if (extra) faults.add(extra);
    if (!r.deep) faults.add('shallow');
    if (t - r.start < cfg.minRepMs && extra !== 'lockout') faults.add('fast');
    s.attempts++;
    const list = SQUAT_FAULT_ORDER.filter((f) => faults.has(f));
    for (const f of list) s.faults[f]++;
    if (!list.length) {
      s.reps++;
      s.pending.push({ tMs: t, rep: s.reps, minKnee: Math.round(r.min), ms: Math.round(t - r.start) });
      s.lastRep = { tMs: t, ok: true, faults: [] };
      s.message = `${s.reps}`;
    } else {
      s.lastRep = { tMs: t, ok: false, faults: list };
      hint(list[0], t);
    }
    s.rep = null;
  }

  function push(obs) {
    if (!obs || !fin(obs.tMs)) return;
    const t = obs.tMs;
    if (s.lastT !== null && t <= s.lastT) return;
    const dt = s.lastT === null ? 0 : Math.min(0.5, (t - s.lastT) / 1000);
    s.lastT = t;
    const L = Array.isArray(obs.landmarks) ? obs.landmarks : null;
    const ax = fin(obs.frameW) && fin(obs.frameH) && obs.frameH > 0 ? obs.frameW / obs.frameH : 4 / 3;
    const m = L ? measure(L, ax, dt) : null;
    if (!m) {
      if (s.lastSeen === null || t - s.lastSeen > cfg.lostMs) {
        if (s.phase !== 'noPose') {
          s.rep = null; s.upSince = null; s.knee = null; s.thighRef = 0; s.shinRef = 0;
          hint('frame', t);
          s.faults.frame++;
        }
        s.phase = 'noPose';
        s.message = SQUAT_HINTS.frame;
      }
      return;
    }
    s.lastSeen = t;
    s.view = m.view;
    s.kneeRaw = m.kneeDeg;
    const a = dt > 0 ? 1 - Math.exp(-dt * 1000 / cfg.smoothMs) : 1;
    s.knee = s.knee === null ? m.kneeDeg : s.knee + (m.kneeDeg - s.knee) * a;
    const k = s.knee;
    s.depth = clamp((180 - k) / (180 - cfg.downDeg), 0, 1);

    if (s.phase === 'noPose' || s.phase === 'setup') {
      s.phase = 'setup';
      if (k >= cfg.lockDeg) {
        learnStanding(m);
        if (s.upSince === null) s.upSince = t;
        if (t - s.upSince >= cfg.setupMs) { s.phase = 'top'; if (!s.attempts) s.message = 'Готово — приседайте'; }
      } else { s.upSince = null; if (!s.attempts) s.message = 'Встаньте прямо, ноги на ширине плеч'; }
      return;
    }
    if (s.phase === 'top') {
      if (k >= cfg.lockDeg) { learnStanding(m); return; }
      if (k < cfg.startDeg) startRep(t);
      else return;
    }
    const r = s.rep;
    if (!r) { s.phase = 'top'; return; }
    if (t - r.start > cfg.maxRepMs) { s.rep = null; s.phase = 'setup'; s.upSince = null; return; }

    // ошибки позы в нижней части: держатся holdFrames кадров — фиксируем и сразу подсказываем
    if (k < cfg.checkDeg) {
      const now = new Set(postureFaults(m));
      for (const f of ['valgus', 'knees_forward', 'lean', 'heels']) {
        r.streak[f] = now.has(f) ? (r.streak[f] || 0) + 1 : 0;
        if (r.streak[f] >= cfg.holdFrames && !r.faults.has(f)) { r.faults.add(f); hint(f, t); }
      }
    }
    if (!r.rising) {
      r.min = Math.min(r.min, k);
      if (k <= cfg.downDeg) { r.deep = true; s.phase = 'bottom'; }
      if (k >= r.min + cfg.riseDeg) {
        if (!r.deep && r.min > cfg.attemptDeg) {
          // не попытка, а покачивание: ждём возврата наверх
          if (k >= cfg.lockDeg) { s.rep = null; s.phase = 'top'; }
          return;
        }
        r.rising = true; r.peak = k; s.phase = 'ascent';
        if (!r.deep && !r.live.has('shallow')) { r.live.add('shallow'); hint('shallow', t); }
      }
    }
    if (r.rising) {
      if (k >= cfg.lockDeg) { finishRep(t, null); s.phase = 'top'; learnStanding(m); return; }
      if (k > r.peak) {
        // заметный рост (≥ 3°) — ещё поднимается; мелкое доползание сглаживания таймер не сбрасывает
        if (r.riseSince !== null && k - r.peakAt >= 3) r.riseSince = null;
        r.peak = k;
      }
      if (r.riseSince === null) r.peakAt = r.peak;
      if (k <= r.peak - cfg.relockDropDeg) {
        // пошёл вниз, не выпрямившись: попытка закрыта с ошибкой, новый повтор начинается здесь
        finishRep(t, 'lockout');
        startRep(t);
        s.rep.min = k;
        return;
      }
      if (r.peak >= cfg.attemptDeg) {
        if (r.riseSince === null) r.riseSince = t;
        if (t - r.riseSince > cfg.stuckMs) { finishRep(t, 'lockout'); s.phase = 'setup'; s.upSince = null; }
      }
    }
  }

  function read() {
    const live = s.phase !== 'noPose' && s.phase !== 'setup';
    return {
      reps: s.reps, attempts: s.attempts, phase: s.phase, state: s.phase, message: s.message,
      knee: s.knee === null ? null : Math.round(s.knee),
      depth: live ? +s.depth.toFixed(3) : 0,
      view: s.view,
      lastRep: s.lastRep, lastHint: s.lastHint,
      faults: { ...s.faults },
      rejected: s.attempts - s.reps,
      formScore: s.attempts ? +(s.reps / s.attempts).toFixed(3) : null,
    };
  }
  // Новые чистые повторы с прошлого вызова (для начисления очков).
  function drain() { const out = s.pending; s.pending = []; return out; }
  function getDebug() {
    return { ...read(), kneeRaw: s.kneeRaw === null ? null : +s.kneeRaw.toFixed(1), thighRef: +s.thighRef.toFixed(4), shinRef: +s.shinRef.toFixed(4), torsoRef: +s.torsoRef.toFixed(4), rep: s.rep ? { start: s.rep.start, min: Math.round(s.rep.min), deep: s.rep.deep, rising: s.rep.rising, faults: [...s.rep.faults] } : null, version: SQUAT_VERSION };
  }

  return { push, read, drain, reset, getDebug };
}

// Самая частая ошибка по счётчикам read().faults (без frame) → { code, text, count } или null.
export function topSquatFault(faults) {
  let best = null;
  for (const code of SQUAT_FAULT_ORDER) {
    const n = faults && fin(faults[code]) ? faults[code] : 0;
    if (n > 0 && (!best || n > best.count)) best = { code, text: SQUAT_HINTS[code], count: n };
  }
  return best;
}

// Синтетическая поза приседа (для тестов и клавиатурной отладки без камеры).
// k — глубина 0 (стоя) … 1 (глубокий присед). view: 'front' | 'side'.
// o: { valgus, kneesForward, lean, heels, scale, cx } — ошибки техники 0…1.
export function synthSquatPose(k, view = 'front', o = {}) {
  const L = new Array(33).fill(null);
  const sc = o.scale ?? 1, cx = o.cx ?? 0.5;
  const S = 0.2 * sc, T = 0.2 * sc, U = 0.25 * sc, groundY = 0.9;
  const rad = Math.PI / 180;
  const aS = k * (o.kneesForward ? 55 : 30) * rad;   // голень вперёд от вертикали
  const aT = k * 95 * rad;                            // бедро от вертикали
  const aU = k * (o.lean ? 70 : 30) * rad;            // корпус от вертикали
  const lift = o.heels ? k * 0.14 * S : 0;
  const P = (x, y, v = 0.95) => ({ x, y, z: 0, visibility: v });
  if (view === 'side') {
    // смотрит вправо (+x); кадр 4:3 — x делим на соотношение сторон
    const ax = 4 / 3, X = (x) => cx + x / ax;
    const ank = { x: 0, y: groundY - 0.03 * sc };
    const knee = { x: ank.x + S * Math.sin(aS), y: ank.y - S * Math.cos(aS) };
    const hip = { x: knee.x - T * Math.sin(aT), y: knee.y - T * Math.cos(aT) };
    const sh = { x: hip.x + U * Math.sin(aU), y: hip.y - U * Math.cos(aU) };
    const pts = { hip, knee, ankle: ank, heel: { x: -0.05 * sc, y: groundY - 0.01 * sc - lift }, toe: { x: 0.08 * sc, y: groundY } };
    const put = (i, p, v) => { L[i] = P(X(p.x), p.y, v); };
    for (const [side, v, dx] of [[0, 0.95, 0], [1, 0.6, 0.004]]) {
      const d = SIDES[side];
      const sh2 = { x: sh.x + dx, y: sh.y };
      put(d.hip, { x: pts.hip.x + dx, y: pts.hip.y }, v); put(d.knee, { x: pts.knee.x + dx, y: pts.knee.y }, v);
      put(d.ankle, { x: pts.ankle.x + dx, y: pts.ankle.y }, v); put(d.heel, { x: pts.heel.x + dx, y: pts.heel.y }, v);
      put(d.toe, { x: pts.toe.x + dx, y: pts.toe.y }, v); put(d.sh, sh2, v);
    }
    L[0] = P(X(sh.x + 0.05 * sc), sh.y - 0.08 * sc);
    return L;
  }
  // вид спереди: бедро «в камеру» укорачивается, колени по линии носков (или внутрь при valgus)
  const aw = 0.075 * sc, hw = 0.07 * sc, sw = 0.09 * sc;
  const ankY = groundY - 0.03 * sc;
  const kneeY = ankY - S * Math.cos(aS);
  const hipY = kneeY - T * Math.cos(aT);
  const shY = hipY - U * Math.cos(aU);
  const kx = o.valgus ? aw * (1 - 0.7 * k) : aw + 0.01 * sc * k;
  for (const [side, sg] of [[0, 1], [1, -1]]) {
    const d = SIDES[side];
    L[d.hip] = P(cx + sg * hw, hipY); L[d.knee] = P(cx + sg * kx, kneeY); L[d.ankle] = P(cx + sg * aw, ankY);
    L[d.heel] = P(cx + sg * aw, ankY + 0.01 * sc - lift); L[d.toe] = P(cx + sg * (aw + 0.015 * sc), groundY + 0.01 * sc);
    L[d.sh] = P(cx + sg * sw, shY);
  }
  L[0] = P(cx, shY - 0.1 * sc);
  return L;
}
