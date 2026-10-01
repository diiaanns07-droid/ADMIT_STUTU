// Счётчик отжиманий по позе MediaPipe (ASHEN_V2). Владелец: №1.
// Камера спереди (ноутбук на полу перед головой) или сбоку — сигнал один: высота плеч над кистями.
// Кисти стоят на полу, плечи опускаются к ним и поднимаются. Высота нормируется на «верх»
// (руки прямые), поэтому рост человека и расстояние до камеры не важны.
// Повтор: верх → низ (плечи прошли ≥ depthDown хода или локоть согнут < elbowDownDeg) → верх.
// Не засчитывается: кисти ездят (машут руками, а не упор), слишком быстро, слишком мелко
// (подсказка «ниже»), таз провисает или задран (вид сбоку: плечо—таз—колено не на одной линии),
// нет плеч или кистей в кадре. Кадры обрабатываются на месте, ничего не хранится.
//
// createPushupCounter(cfg?) → { push({tMs, landmarks, frameW, frameH}), read(), drain(), reset(), getDebug() }

export const PUSHUP_VERSION = 'ASHEN_V2-pushup-1';

export const DEFAULT_PUSHUP_CONFIG = Object.freeze({
  minVisibility: 0.5,
  upLevel: 0.86,          // n ≥ — руки прямые (верх)
  downLevel: 0.62,        // n ≤ — низ (плечи опустились на ≥ 38% хода)
  shallowLevel: 0.82,     // дошёл только до (downLevel, shallowLevel] — «ниже»
  elbowDownDeg: 100,      // или локоть согнут сильнее — тоже низ
  topDecayPerSec: 0.03,   // «верх» медленно забывается (сменил позу/отъехал)
  setupMs: 450,           // верх должен постоять, прежде чем считать
  minRepMs: 400,
  maxRepMs: 8000,
  wristSlip: 0.35,        // кисти сдвинулись больше этой доли «верха» — не упор
  lostMs: 600,
  minTopShoulder: 0.55,   // «верх» ≥ этой доли ширины плеч (иначе это не прямые руки)
  // [ОШИБКА] линия тела сбоку: отклонение таза от прямой плечо→колено (или лодыжка), в длинах этой прямой
  sagDev: 0.07,           // таз ниже линии — провисает
  pikeDev: 0.09,          // таз выше линии — «горка»
});

export const PUSHUP_FAULTS = Object.freeze({
  shallow: 'Ниже! Плечи почти до кистей',
  fast: 'Слишком быстро — медленнее и до конца',
  slow: 'Слишком долго внизу — повтор не засчитан',
  hands: 'Кисти должны стоять на полу',
  sag: 'Таз провисает — напряги пресс и ягодицы, тело одной линией',
  pike: 'Таз задран вверх — опусти бёдра, тело одной линией от плеч до пяток',
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// [ОШИБКА] прогресс условий техники (тренажёр): условия, коды подсказок PUSHUP_FAULTS и точки позы, куда смотреть
const downTo = (x, lim, hi) => clamp((hi - x) / Math.max(1e-9, hi - lim), 0, 1);   // меньше — лучше: hi → 0, lim → 1
const FRAME_IDS = [11, 12, 15, 16];
const CHECK_ITEMS = Object.freeze([   // [key, код по умолчанию, точки позы 0..32]
  ['frame', null, Object.freeze([11, 12, 15, 16])],
  ['depth', 'shallow', Object.freeze([11, 12, 13, 14])],
  ['hands', 'hands', Object.freeze([15, 16])],
  ['line', 'sag', Object.freeze([11, 12, 23, 24, 25, 26])],
  ['tempo', 'fast', Object.freeze([11, 12])],
]);
const JUDGED_MS = 5000;   // итог повтора «только что был» столько после него

export function createPushupCounter(userCfg) {
  const cfg = { ...DEFAULT_PUSHUP_CONFIG, ...(userCfg && typeof userCfg === 'object' ? userCfg : {}) };
  let s;
  function reset() {
    s = {
      reps: 0, state: 'noPose', top: 0, lastT: null, lastSeen: null, upSince: null,
      repStart: null, repMin: 1, wrist0: null, maxSlip: 0, n: 0, elbow: null, message: 'Встаньте в упор лёжа: плечи и кисти в кадре',
      lastRep: null, pending: [], rejected: 0, shallow: 0, lineMax: 0, lineMin: 0, line: null, faults: {},
      lastHint: null,   // [ОШИБКА] { code, text, tMs } — при каждом незасчитанном повторе (как у приседаний)
      // [ОШИБКА] только для показа (решения не читают): кадр, линия тела в повторе, итог прошлого повтора
      chk: { seen: false, vis: 0, lineSeen: false, last: null },
    };
  }
  reset();

  const vis = (p) => p && fin(p.x) && fin(p.y) && (!fin(p.visibility) || p.visibility >= cfg.minVisibility);
  function angle(a, b, c, ax) {
    const v1x = (a.x - b.x) * ax, v1y = a.y - b.y, v2x = (c.x - b.x) * ax, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) return null;
    return Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * 180 / Math.PI;
  }

  function measure(L, ax) {
    let dSum = 0, dN = 0, wx = 0, wy = 0, eSum = 0, eN = 0;
    for (const [sh, el, wr] of [[11, 13, 15], [12, 14, 16]]) {
      const S = L[sh], W = L[wr], E = L[el];
      if (!vis(S) || !vis(W)) continue;
      dSum += W.y - S.y; dN++; wx += W.x * ax; wy += W.y;
      if (vis(E)) { const a = angle(S, E, W, ax); if (a !== null) { eSum += a; eN++; } }
    }
    if (!dN) return null;
    const sw = vis(L[11]) && vis(L[12]) ? Math.hypot((L[11].x - L[12].x) * ax, L[11].y - L[12].y) : 0;
    // линия тела (сбоку): таз относительно прямой плечо → колено/лодыжка; + — таз ниже (провис)
    let line = null;
    for (const [sh, hp, kn, an] of [[11, 23, 25, 27], [12, 24, 26, 28]]) {
      const S = L[sh], Hh = L[hp], F = vis(L[an]) ? L[an] : L[kn];
      if (!vis(S) || !vis(Hh) || !vis(F)) continue;
      const dx = (F.x - S.x) * ax, dy = F.y - S.y, len = Math.hypot(dx, dy);
      if (len < 1e-4 || Math.abs(dx) < 1.5 * Math.abs(dy)) continue; // тело не горизонтально — не вид сбоку
      const u = ((Hh.x - S.x) * ax) / dx;
      if (u < 0.15 || u > 0.9) continue;
      line = (Hh.y - (S.y + dy * u)) / len;
      break;
    }
    return { d: dSum / dN, wx: wx / dN, wy: wy / dN, elbow: eN ? eSum / eN : null, sw, line };
  }

  function setState(st, msg) { s.state = st; if (msg !== undefined) s.message = msg; }

  function push(obs) {
    if (!obs || !fin(obs.tMs)) return;
    const t = obs.tMs;
    if (s.lastT !== null && t <= s.lastT) return;
    const dt = s.lastT === null ? 0 : Math.min(0.5, (t - s.lastT) / 1000);
    s.lastT = t;
    const L = Array.isArray(obs.landmarks) ? obs.landmarks : null;
    const ax = fin(obs.frameW) && fin(obs.frameH) && obs.frameH > 0 ? obs.frameW / obs.frameH : 4 / 3;
    const m = L ? measure(L, ax) : null;
    s.chk.seen = !!m;
    s.chk.vis = L ? FRAME_IDS.filter((i) => vis(L[i])).length / FRAME_IDS.length : 0;
    if (!m) {
      if (s.lastSeen === null || t - s.lastSeen > cfg.lostMs) {
        if (s.state !== 'noPose') { s.repStart = null; s.upSince = null; }
        setState('noPose', 'Не видно плеч и кистей — поставьте камеру так, чтобы они были в кадре');
      }
      return;
    }
    s.lastSeen = t;
    s.elbow = m.elbow;
    // «верх»: максимум высоты плеч над кистями, медленно забывается
    const floorTop = cfg.minTopShoulder * m.sw;
    if (m.d > s.top) s.top = m.d;
    else s.top = Math.max(m.d, s.top * (1 - cfg.topDecayPerSec * dt));
    if (m.d <= 0 || s.top <= 1e-4 || s.top < floorTop) {
      s.repStart = null; s.upSince = null; s.n = 0;
      setState('setup', 'Кисти — под плечами, руки прямые');
      return;
    }
    const n = m.d / s.top;
    s.n = n;
    const elbowDown = m.elbow !== null && m.elbow < cfg.elbowDownDeg;

    if (s.state === 'noPose' || s.state === 'setup') {
      if (n >= cfg.upLevel) {
        if (s.upSince === null) s.upSince = t;
        if (t - s.upSince >= cfg.setupMs) setState('up', s.reps ? s.message : 'Готово — опускайтесь');
      } else s.upSince = null;
      return;
    }
    if (s.state === 'up') {
      if (n < cfg.upLevel) {
        // начало повтора: запомнить, где стоят кисти
        if (s.repStart === null) { s.repStart = t; s.repMin = n; s.wrist0 = { x: m.wx, y: m.wy }; s.lineMax = 0; s.lineMin = 0; s.chk.lineSeen = false; }
        s.repMin = Math.min(s.repMin, n);
        if (n <= cfg.downLevel || elbowDown) setState('down');
      } else if (s.repStart !== null) {
        // вернулся наверх, не дойдя до низа
        if (s.repMin <= cfg.shallowLevel) {
          s.shallow++; s.faults.shallow = (s.faults.shallow || 0) + 1; s.lastRep = { tMs: t, ok: false, reason: 'shallow' }; s.message = PUSHUP_FAULTS.shallow;
          s.lastHint = { code: 'shallow', text: PUSHUP_FAULTS.shallow, tMs: t };
          noteRepEnd(t, false, null, s.maxSlip);
        }
        s.repStart = null;
      }
    } else if (s.state === 'down') {
      s.repMin = Math.min(s.repMin, n);
      if (n >= cfg.upLevel) {
        const dur = t - s.repStart;
        const slip = s.wrist0 ? Math.hypot(m.wx - s.wrist0.x, m.wy - s.wrist0.y) / s.top : 0;
        let reason = null;
        if (dur < cfg.minRepMs) reason = 'fast';
        else if (dur > cfg.maxRepMs) reason = 'slow';
        else if (s.maxSlip > cfg.wristSlip || slip > cfg.wristSlip) reason = 'hands';
        else if (s.lineMax > cfg.sagDev) reason = 'sag';
        else if (s.lineMin < -cfg.pikeDev) reason = 'pike';
        noteRepEnd(t, true, dur, Math.max(s.maxSlip || 0, slip));
        if (!reason) {
          s.reps++;
          s.pending.push({ tMs: t, rep: s.reps, depth: +(1 - s.repMin).toFixed(3), ms: Math.round(dur) });
          s.lastRep = { tMs: t, ok: true, reason: null };
          s.message = `${s.reps}`;
        } else {
          s.rejected++;
          s.faults[reason] = (s.faults[reason] || 0) + 1;
          s.lastRep = { tMs: t, ok: false, reason };
          s.message = PUSHUP_FAULTS[reason];
          s.lastHint = { code: reason, text: PUSHUP_FAULTS[reason], tMs: t };
        }
        s.repStart = null; s.maxSlip = 0;
        setState('up');
        return;
      }
    }
    // линия тела во время повтора (сглаживаем: берём экстремумы только устойчивого сигнала)
    s.line = m.line === null ? null : s.line === null ? m.line : s.line + (m.line - s.line) * 0.35;
    if (s.repStart !== null && s.line !== null) { s.lineMax = Math.max(s.lineMax, s.line); s.lineMin = Math.min(s.lineMin, s.line); s.chk.lineSeen = true; }
    // кисти в упоре: следим за сдвигом во время повтора
    if (s.repStart !== null && s.wrist0) s.maxSlip = Math.max(s.maxSlip || 0, Math.hypot(m.wx - s.wrist0.x, m.wy - s.wrist0.y) / s.top);
    if (s.repStart !== null && t - s.repStart > cfg.maxRepMs * 1.5) { s.repStart = null; s.maxSlip = 0; setState('up'); }
  }

  // [ОШИБКА] итог повтора для checks (каждое условие отдельно, пороги — те же, что у решения): держится
  // до следующего повтора. deep — дошёл до низа; dur — длительность (null — повтор оборван «мелко»).
  function noteRepEnd(t, deep, dur, slip) {
    s.chk.last = { tMs: t, deep, repMin: s.repMin, dur, slip, lineSeen: s.chk.lineSeen, lineMax: s.lineMax, lineMin: s.lineMin };
  }

  // [ОШИБКА] прогресс условий техники для тренажёра: { items: [{ key, value, ok, hint, landmarks }], judged }.
  // Во время повтора — живые значения, после — итог последнего повтора; ok:null — в этом ракурсе/фазе не оценивается.
  function checks() {
    const inRep = s.repStart !== null, last = s.chk.last, C = s.chk;
    const depthOf = (n) => clamp((1 - n) / (1 - cfg.downLevel), 0, 1);
    const v = { frame: { ok: C.seen && s.state !== 'noPose', value: C.seen ? 1 : C.vis } };
    const lineV = (seen, mx, mn) => {
      if (!seen) return { ok: null, value: 0 };
      const sag = mx > cfg.sagDev, pike = mn < -cfg.pikeDev;
      return { ok: !sag && !pike, value: Math.min(downTo(mx, cfg.sagDev, 2 * cfg.sagDev), downTo(-mn, cfg.pikeDev, 2 * cfg.pikeDev)), hint: sag ? 'sag' : pike ? 'pike' : mx >= -mn ? 'sag' : 'pike' };
    };
    const slipV = (slip) => ({ ok: !(slip > cfg.wristSlip), value: downTo(slip, cfg.wristSlip, 2 * cfg.wristSlip) });
    if (inRep) {
      const dur = fin(s.lastT) ? s.lastT - s.repStart : 0;
      v.depth = s.state === 'down' ? { ok: true, value: 1 } : { ok: null, value: depthOf(Math.min(s.repMin, s.n)) };
      v.hands = slipV(s.maxSlip || 0);
      v.line = lineV(C.lineSeen, s.lineMax, s.lineMin);
      v.tempo = dur > cfg.maxRepMs ? { ok: false, value: downTo(dur, cfg.maxRepMs, 2 * cfg.maxRepMs), hint: 'slow' } : { ok: null, value: 0 };
    } else if (last) {
      v.depth = last.deep ? { ok: true, value: 1 } : { ok: false, value: depthOf(last.repMin) };
      v.hands = slipV(last.slip || 0);
      v.line = lineV(last.lineSeen, last.lineMax, last.lineMin);
      const d = last.dur;
      v.tempo = !fin(d) ? { ok: null, value: 0 }
        : d < cfg.minRepMs ? { ok: false, value: d / cfg.minRepMs, hint: 'fast' }
          : d > cfg.maxRepMs ? { ok: false, value: downTo(d, cfg.maxRepMs, 2 * cfg.maxRepMs), hint: 'slow' } : { ok: true, value: 1 };
    } else for (const k of ['depth', 'hands', 'line', 'tempo']) v[k] = { ok: null, value: 0 };
    const items = CHECK_ITEMS.map(([key, hint, landmarks]) => {
      const e = v[key];
      const val = e.ok === true ? 1 : clamp(fin(e.value) ? e.value : 0, 0, e.ok === false ? 0.99 : 1);
      return { key, value: Math.round(val * 100) / 100, ok: e.ok, hint: e.hint !== undefined ? e.hint : hint, landmarks };
    });
    return { items, judged: inRep || !!(last && s.lastT - last.tMs <= JUDGED_MS) };
  }

  function read() {
    const down = s.state === 'down' || s.state === 'up';
    return {
      reps: s.reps, state: s.state, message: s.message,
      depth: down ? clamp((1 - s.n) / (1 - cfg.downLevel), 0, 1) : 0,
      elbow: s.elbow === null ? null : Math.round(s.elbow),
      lastRep: s.lastRep, rejected: s.rejected, shallow: s.shallow,
      line: s.line === null ? null : +s.line.toFixed(3), faults: { ...s.faults },
      lastHint: s.lastHint,
      checks: checks(),   // [ОШИБКА] прогресс условий техники (тренажёр)
    };
  }
  // Новые засчитанные повторы с прошлого вызова (для начисления очков).
  function drain() { const out = s.pending; s.pending = []; return out; }
  function getDebug() { return { ...read(), top: +s.top.toFixed(4), n: +s.n.toFixed(3), repStart: s.repStart, version: PUSHUP_VERSION }; }

  return { push, read, drain, reset, getDebug };
}
