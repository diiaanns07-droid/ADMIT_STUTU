// Счётчик приседаний с контролем техники (ASHEN_V2, [W3-SQUAT]). Владелец: №1.
// Чистая логика: без DOM, время приходит в аргументах. Вход — 33 точки позы MediaPipe
// (нормированные x,y + visibility): бёдра 23/24, колени 25/26, лодыжки 27/28, пятки 29/30,
// носки 31/32, плечи 11/12. Ось x домножается на соотношение сторон кадра. В живой игре из worker
// приходят только COMPACT_INDICES (modules/vision.js) — без пяток и носков.
//
// [W3-SQUAT] Живая камера: точки дрожат на 1–3 % кадра, распознавание 12–15 Гц, лодыжки у ноутбука на столе
// часто не видны. Поэтому точки сначала сглаживаются фильтром One-Euro (стоя — сильно, в движении — слабо),
// эталоны «стоя» (длина бедра, голени, корпуса, высота таза) — перцентили по последним 2,5 с стойки, а не
// максимум (шум раздувал максимум, и стоящий человек читался как «колено 150°» — подготовка не кончалась).
//
// Угол колена. Сбоку его видно прямо (бедро–колено–лодыжка). Спереди бедро уходит «в камеру»,
// и плоский угол почти не меняется, поэтому берём оценку по бедру: h = (y колена − y таза) /
// длина бедра стоя (1 — стоим, 0 — таз на уровне колена), угол ≈ 180° − acos(h) (= 180° − наклон бедра).
// «Мастер»: меньший из двух, ноги нужны до лодыжек. «Новичок»: угол по бедру (среднее ног) вместе с
// опусканием таза относительно длины корпуса — лодыжки не нужны (режим без стоп), про стопы — совет.
// Вид (спереди/сбоку) — по ширине таза относительно бедра.
//
// Повтор: стоим (угол ≥ lockDeg) → вниз (≤ downDeg, таз около колена) → снова выпрямились.
// Ошибки (у каждой код и подсказка SQUAT_HINTS):
//   shallow — не дошёл до глубины; valgus — колени внутрь (спереди); knees_forward — колени далеко
//   за носками (сбоку); lean — корпус наклонён сильнее leanDeg; heels — пятки оторвались;
//   fast — повтор короче minRepMs; lockout — не выпрямился наверху; frame — не видно ног.
// «Мастер» (по умолчанию): засчитывается только чистый повтор (глубина 100° и ни одной ошибки).
// «Новичок» (SQUAT_PROFILES.novice): глубина ≈ 115–120° (порог 129° — запас на перспективу и сглаживание), с ошибкой — засчитан (+1 очко и карточка,
// что улучшить), чистый — +2. Неглубокий (не дошёл до глубины) — не повтор.
//
// createSquatCounter(cfg?) → { push({tMs, landmarks, frameW, frameH}), read(), drain(), reset(), getDebug() }
// cfg.mode: 'master' | 'novice' (профиль SQUAT_PROFILES), остальные поля — поверх профиля.

export const SQUAT_VERSION = 'ASHEN_W3-squat-2';

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
// [W3-SQUAT] «Новичок»: те же коды, тексты мягче (глубина — до ~115°, ноги — до колен)
export const SQUAT_HINTS_NOVICE = Object.freeze({
  shallow: 'Чуть глубже — садись, как на стул, ещё на ладонь вниз',
  frame: 'Не вижу ног до колен — отойди на шаг назад',
});
// Порядок важности: если в повторе несколько ошибок, подсказка — про первую из списка.
export const SQUAT_FAULT_ORDER = Object.freeze(['shallow', 'valgus', 'knees_forward', 'lean', 'heels', 'fast', 'lockout']);

export const DEFAULT_SQUAT_CONFIG = Object.freeze({
  mode: 'master',
  minVisibility: 0.5,
  visHyst: 0.15,         // [W3-SQUAT] видимая точка гаснет только ниже minVisibility − visHyst (без мигания)
  lockDeg: 160,          // выпрямлен (верх)
  startDeg: 150,         // ниже — начался повтор
  attemptDeg: 140,       // дошёл хотя бы сюда — это попытка (иначе дрожь, не считаем)
  downDeg: 100,          // глубина засчитана
  riseDeg: 10,           // поднялся от минимума на столько — фаза подъёма
  relockDropDeg: 12,     // на подъёме снова пошёл вниз на столько, не выпрямившись, — «выпрямись»
  stuckMs: 1600,         // завис на подъёме между attemptDeg и lockDeg — «выпрямись»
  plateauMs: 2200,       // [W3-SQUAT] застыл на спуске выше глубины (отошёл от камеры, переминается) — не попытка
  setupMs: 450,          // постоять выпрямившись, прежде чем считать
  minRepMs: 800,
  maxRepMs: 12000,
  lostMs: 500,
  smoothMs: 60,          // сглаживание признаков угла (постоянная времени)
  refWindowMs: 2500,     // [W3-SQUAT] эталоны «стоя» — по последним кадрам стойки на столько мс
  filterMinCutoff: 1.2,  // [W3-SQUAT] One-Euro для точек: срез стоя, Гц
  filterBeta: 2,         //   …прибавка среза на единицу скорости (доли кадра в секунду)
  filterDCutoff: 1,      //   …срез для оценки скорости, Гц
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
  // [W3-SQUAT] правила режима
  needFeet: true,        // без лодыжек ноги «не видны» (Мастер); false — режим без стоп
  faultsBlock: true,     // повтор с ошибкой не засчитывается (Мастер)
  cleanBonus: 0,         // доп. очки за чистый повтор
  dropWeight: 0,         // доля оценки по опусканию таза (относительно корпуса) в угле
});

// [W3-SQUAT] Профили: «Мастер» — строгость как раньше; «Новичок» — мягче и без обязательных стоп.
export const SQUAT_PROFILES = Object.freeze({
  master: Object.freeze({ mode: 'master' }),
  novice: Object.freeze({
    // порог 129° — по показаниям: у ноутбука на столе (камера выше таза) перспектива завышает угол по бедру
    // на 8–11°, по тазу — на 4–7° (dev/squatSim.mjs), поэтому таз весит больше, а настоящие 115–120° читаются ≈125°
    mode: 'novice', downDeg: 129, lockDeg: 155, startDeg: 145, attemptDeg: 138, setupMs: 400,
    needFeet: false, faultsBlock: false, cleanBonus: 1, dropWeight: 0.7, smoothMs: 80,
  }),
});
export function squatConfig(userCfg) {
  const u = userCfg && typeof userCfg === 'object' ? userCfg : {};
  const prof = SQUAT_PROFILES[u.mode] || SQUAT_PROFILES.master;
  return { ...DEFAULT_SQUAT_CONFIG, ...prof, ...u, mode: prof.mode };
}

// Фазы повтора по-русски (диагностика, экран тренировки)
export const SQUAT_PHASE_RU = Object.freeze({ noPose: 'нет позы', setup: 'подготовка', top: 'стоя', descent: 'вниз', bottom: 'внизу', ascent: 'вверх' });

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEG = 180 / Math.PI;
const SIDES = [
  { hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31, sh: 11 },
  { hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32, sh: 12 },
];
// [ОШИБКА] прогресс условий техники (тренажёр): ошибки позы нижней части повтора и точки позы, куда смотреть
const POSTURE_FAULTS = ['valgus', 'knees_forward', 'lean', 'heels'];
const downTo = (x, lim, hi) => clamp((hi - x) / Math.max(1e-9, hi - lim), 0, 1);   // меньше — лучше: hi → 0, lim → 1
const FRAME_IDS = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const TRACK_IDS = [11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const CHECK_ITEMS = Object.freeze([   // [key, код SQUAT_HINTS, точки позы 0..32]
  ['frame', 'frame', Object.freeze([11, 12, 27, 28, 31, 32])],
  ['depth', 'shallow', Object.freeze([23, 24, 25, 26])],
  ['valgus', 'valgus', Object.freeze([25, 26, 27, 28])],
  ['knees_forward', 'knees_forward', Object.freeze([25, 26, 31, 32])],
  ['lean', 'lean', Object.freeze([11, 12, 23, 24])],
  ['heels', 'heels', Object.freeze([29, 30, 31, 32])],
  ['lockout', 'lockout', Object.freeze([23, 24, 25, 26, 27, 28])],
]);
const JUDGED_MS = 5000;   // итог повтора «только что был» столько после него

// [W3-SQUAT] опускание таза в длинах бедра при наклоне бедра θ (голень наклоняется на ~θ/3, её длина ≈ бедру):
// g(θ) = (1 − cos θ) + (1 − cos θ/3). Таблица на 0…130° и обратная функция.
const DROP_TABLE = (() => { const a = new Float64Array(131); for (let d = 0; d <= 130; d++) { const r = d / DEG; a[d] = (1 - Math.cos(r)) + (1 - Math.cos(r / 3)); } return a; })();
function dropToThighDeg(x) {
  if (!(x > 0)) return 0;
  if (x >= DROP_TABLE[130]) return 130;
  let lo = 0, hi = 130;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (DROP_TABLE[mid] <= x) lo = mid; else hi = mid; }
  return lo + (x - DROP_TABLE[lo]) / (DROP_TABLE[hi] - DROP_TABLE[lo]);
}

// [W3-SQUAT] фильтр One-Euro (Casiez и др., 2012): стоя срез низкий — дрожь гасится; в движении срез растёт — без запаздывания
function oneEuro() { return { x: null, dx: 0 }; }
function euroStep(f, v, dt, cfg) {
  if (f.x === null || !(dt > 0)) { f.x = v; f.dx = 0; return v; }
  const a = (cut) => { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); };
  const d = (v - f.x) / dt;
  f.dx += (d - f.dx) * a(cfg.filterDCutoff);
  f.x += (v - f.x) * a(cfg.filterMinCutoff + cfg.filterBeta * Math.abs(f.dx));
  return f.x;
}

// [W3-SQUAT] перцентиль по кольцевому буферу (scratch — без аллокаций)
const REF_N = 96;
function createRefBuf() { return { v: new Float64Array(REF_N), n: 0, i: 0 }; }
function refPush(b, v) { if (!fin(v)) return; b.v[b.i] = v; b.i = (b.i + 1) % REF_N; if (b.n < REF_N) b.n++; }
const SCRATCH = new Float64Array(REF_N);
// последние count кадров стойки (во время повтора не пополняется — эталон заморожен)
function refPct(b, count, q) {
  const k = Math.min(b.n, Math.max(1, count));
  if (!b.n) return null;
  for (let j = 0; j < k; j++) SCRATCH[j] = b.v[(b.i - 1 - j + REF_N) % REF_N];
  const a = SCRATCH.subarray(0, k).sort();
  return a[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))];
}

// [W3-SQUAT] Оценка кадра для подготовки: видно ли ноги, куда отойти/наклонить экран.
// vis — сглаженная видимость точек { id: 0..1 }, pos — сырые точки. Возвращает { full, upper, tip: { code, text }, points }.
export const SQUAT_FRAME_TIPS = Object.freeze({
  noPerson: 'Встань перед камерой в 2–3 шагах, лицом к ней',
  tiltUp: 'Не видно головы — наклони экран ноутбука назад',
  stepBack: 'Отойди на шаг назад — ноги не помещаются в кадр',
  tiltDown: 'Стопы не в кадре — наклони экран ноутбука чуть вперёд или отойди на шаг',
  closer: 'Подойди на шаг ближе — так точнее',
  center: 'Встань по центру кадра',
  ok: 'Вижу тебя целиком ✓',
  okNoFeet: 'Вижу до колен ✓ — можно приседать',
});
const FRAME_POINTS = [0, 11, 12, 23, 24, 25, 26, 27, 28];
export function assessSquatFrame(vis, pos, minVis = 0.5) {
  const seen = (i) => fin(vis[i]) && vis[i] >= minVis;
  const yOf = (i) => (pos && pos[i] && fin(pos[i].y) ? pos[i].y : null);
  const any = (a, b) => seen(a) || seen(b);
  const sh = any(11, 12), hip = any(23, 24), knee = any(25, 26);
  const ankY = [27, 28].filter((i) => seen(i)).map(yOf).filter(fin);
  const ankle = ankY.length > 0 && Math.max(...ankY) < 0.995;
  const full = sh && hip && knee && ankle;
  const upper = sh && hip && knee;
  const kneeY = [25, 26].filter((i) => seen(i)).map(yOf).filter(fin);
  const headY = seen(0) ? yOf(0) : null;
  const shY = [11, 12].filter((i) => seen(i)).map(yOf).filter(fin);
  const top = fin(headY) ? headY : shY.length ? Math.min(...shY) - 0.08 : null;
  const bottom = ankle ? Math.max(...ankY) : kneeY.length ? Math.max(...kneeY) + 0.2 : null;
  const hipX = [23, 24].filter((i) => seen(i) && pos[i] && fin(pos[i].x)).map((i) => pos[i].x);
  const hipMx = hipX.length ? hipX.reduce((a, b) => a + b, 0) / hipX.length : null;
  const headCut = (!fin(headY) || headY < 0.02) && (!shY.length || Math.min(...shY) < 0.15);
  let code;
  if (!sh && !hip) code = 'noPerson';
  else if (headCut && !ankle) code = 'stepBack';   // обрезано и сверху, и снизу — слишком близко
  else if (headCut) code = 'tiltUp';
  else if (!knee || (kneeY.length && Math.max(...kneeY) > 0.9)) code = 'stepBack';
  else if (!ankle) code = fin(top) && top > 0.12 ? 'tiltDown' : 'stepBack';
  else if (fin(top) && fin(bottom) && bottom - top < 0.45) code = 'closer';
  else if (fin(hipMx) && (hipMx < 0.18 || hipMx > 0.82)) code = 'center';
  else code = 'ok';
  const points = {};
  for (const i of FRAME_POINTS) points[i] = { v: fin(vis[i]) ? Math.round(vis[i] * 100) / 100 : 0, ok: seen(i) };
  return { full, upper, tip: { code, text: SQUAT_FRAME_TIPS[code] }, points };
}

export function createSquatCounter(userCfg) {
  const cfg = squatConfig(userCfg);
  const novice = cfg.mode === 'novice';
  const hintText = (code) => (novice && SQUAT_HINTS_NOVICE[code]) || SQUAT_HINTS[code];
  let s;
  function reset() {
    s = {
      reps: 0, attempts: 0, clean: 0, points: 0, phase: 'noPose', lastT: null, lastSeen: null, upSince: null,
      knee: null, kneeRaw: null, view: null, depth: 0, thighDeg: null, dropDeg: null, feet: null,
      thighRef: 0, shinRef: 0, torsoRef: 0, hipY0: null, heel0: [null, null],
      rep: null, message: novice ? 'Встань в полный рост лицом к камере — в кадре от плеч до колен' : 'Встаньте в полный рост: в кадре — от плеч до стоп',
      lastRep: null, lastHint: null, pending: [],
      faults: Object.fromEntries(Object.keys(SQUAT_HINTS).map((k) => [k, 0])),
      // [W3-SQUAT] сглаженные точки, эталоны «стоя», видимость для подготовки и диагностики
      trk: Object.fromEntries(TRACK_IDS.map((i) => [i, { on: false, lastT: -1e9, fx: oneEuro(), fy: oneEuro(), p: { x: 0, y: 0 } }])),
      ref: { thigh: createRefBuf(), shin: createRefBuf(), torso: createRefBuf(), hipY: createRefBuf() },
      vis: Object.fromEntries(FRAME_POINTS.concat([29, 30, 31, 32]).map((i) => [i, 0])), visRaw: {},
      frm: null, frmOkSince: null, dtAvg: null, fs: { h: null, flat: null, drop: null },
      // [ОШИБКА] только для показа (решения не читают): кадр, метрики текущего повтора, итог прошлого
      chk: { seen: false, vis: 0, live: null, liveT: null, rep: null, last: null },
    };
  }
  reset();

  const vis = (p) => p && fin(p.x) && fin(p.y) && (!fin(p.visibility) || p.visibility >= cfg.minVisibility);
  const wvis = (p) => (p && fin(p.visibility) ? p.visibility : 1);

  function hint(code, t) {
    s.lastHint = { code, text: hintText(code), tMs: t };
    s.message = hintText(code);
  }

  // [W3-SQUAT] сглаженная точка или null; видимость с гистерезисом; фильтр сбрасывается после пропуска > 300 мс
  function track(L, ax, t, dt) {
    for (const i of TRACK_IDS) {
      const tr = s.trk[i], p = L[i];
      const ok = p && fin(p.x) && fin(p.y);
      const v = ok ? (fin(p.visibility) ? p.visibility : 1) : 0;
      const on = ok && v >= (tr.on ? cfg.minVisibility - cfg.visHyst : cfg.minVisibility);
      if (on) {
        if (!tr.on || t - tr.lastT > 300) { tr.fx = oneEuro(); tr.fy = oneEuro(); }
        const gap = t - tr.lastT > 300 ? 0 : dt;
        tr.p.x = euroStep(tr.fx, p.x * ax, gap, cfg);
        tr.p.y = euroStep(tr.fy, p.y, gap, cfg);
        tr.lastT = t;
      }
      tr.on = on;
    }
  }
  const P = (i) => (s.trk[i].on ? s.trk[i].p : null);

  function measure(L, ax, dt, t) {
    track(L, ax, t, dt);
    const legs = SIDES.map((d) => {
      const hip = P(d.hip), knee = P(d.knee), ankle = P(d.ankle);
      if (!hip || !knee || (cfg.needFeet && !ankle)) return null;
      return {
        hip, knee, ankle, heel: ankle ? P(d.heel) : null, toe: ankle ? P(d.toe) : null, sh: P(d.sh),
        w: Math.min(wvis(L[d.hip]), wvis(L[d.knee])) + 0.25 * (ankle ? wvis(L[d.ankle]) : 0) + 0.25 * wvis(L[d.toe]),
      };
    });
    const ok = legs.filter(Boolean);
    if (!ok.length) return null;
    const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mean = (arr, f) => { let a = 0, n = 0; for (const g of arr) { const v = f(g); if (fin(v)) { a += v; n++; } } return n ? a / n : null; };
    // эталоны «стоя» — только из кадров подготовки и стойки: перцентиль за refWindowMs (выбросы и полуприсед не влияют)
    const R = s.ref;
    if (s.phase === 'noPose' || s.phase === 'setup' || s.phase === 'top') {
      refPush(R.thigh, mean(ok, (g) => len(g.hip, g.knee)));
      refPush(R.shin, mean(ok, (g) => (g.ankle ? len(g.knee, g.ankle) : null)));
      refPush(R.torso, mean(ok, (g) => (g.sh ? g.hip.y - g.sh.y : null)));
      refPush(R.hipY, mean(ok, (g) => g.hip.y));
    }
    const W = Math.round(cfg.refWindowMs / Math.max(16, (s.dtAvg || 1 / 30) * 1000));   // окно в кадрах
    const thigh = refPct(R.thigh, W, 0.75), shin = refPct(R.shin, W, 0.75);
    s.shinRef = shin || s.shinRef;
    s.thighRef = Math.max(thigh || 0, 0.8 * (s.shinRef || 0));
    s.torsoRef = refPct(R.torso, W, 0.5) || s.torsoRef;
    s.hipY0 = refPct(R.hipY, W, 0.25) ?? s.hipY0;
    if (s.thighRef < 1e-4) return null;
    const both = legs[0] && legs[1];
    const hipW = both ? Math.abs(legs[0].hip.x - legs[1].hip.x) : 0;
    const ratio = hipW / s.thighRef;
    const view = !both ? 'side' : ratio >= cfg.frontRatio ? 'front' : ratio < cfg.sideRatio ? 'side' : 'diag';
    const flatOf = (g) => {
      const v1x = g.hip.x - g.knee.x, v1y = g.hip.y - g.knee.y, v2x = g.ankle.x - g.knee.x, v2y = g.ankle.y - g.knee.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      return l1 > 1e-6 && l2 > 1e-6 ? Math.acos(clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1)) * DEG : 180;
    };
    // [W3-SQUAT] признаки сглаживаются ДО нелинейностей (acos, «меньший из»): иначе дрожь смещает угол вниз
    // и стоящий человек читается «полуприседом». Высота таза над коленом — в длинах бедра, взвешенное среднее ног.
    const fa = dt > 0 ? 1 - Math.exp(-dt * 1000 / cfg.smoothMs) : 1;
    const ema = (key, v) => { if (!fin(v)) { s.fs[key] = null; return null; } s.fs[key] = s.fs[key] === null ? v : s.fs[key] + (v - s.fs[key]) * fa; return s.fs[key]; };
    let hs = 0, ws = 0;
    for (const g of ok) { hs += ((g.knee.y - g.hip.y) / s.thighRef) * g.w; ws += g.w; }
    const hRaw = hs / Math.max(1e-9, ws);
    const thighDeg = Math.acos(clamp(ema('h', hRaw), -1, 1)) * DEG;   // наклон бедра от вертикали
    const thighRaw = Math.acos(clamp(hRaw, -1, 1)) * DEG;
    let kneeDeg, kneeRaw, dropDeg = null;
    if (!novice) {
      // «Мастер»: плоский угол (сбоку виден прямо) и оценка по бедру — меньший, как раньше. Спереди плоский угол
      // говорит не о глубине, а о смещении колена вбок, и дрожь его занижает — там только оценка по бедру.
      const withAnk = view === 'front' ? [] : ok.filter((g) => g.ankle);
      const flatRaw = withAnk.length ? mean(withAnk, flatOf) : null;
      const flat = ema('flat', flatRaw);
      kneeDeg = Math.min(180 - thighDeg, fin(flat) ? flat : 180);
      kneeRaw = Math.min(180 - thighRaw, fin(flatRaw) ? flatRaw : 180);
    } else {
      // «Новичок»: наклон бедра + опускание таза относительно длины корпуса (лодыжки не нужны)
      let th = thighDeg, thR = thighRaw;
      const hipY = mean(ok, (g) => g.hip.y);
      if (cfg.dropWeight > 0 && ok.some((g) => g.sh) && s.torsoRef > 1e-4 && fin(s.hipY0) && fin(hipY)) {
        const q = s.thighRef / s.torsoRef;   // бедро в длинах корпуса (стоя)
        const xRaw = ((hipY - s.hipY0) / s.torsoRef) / q;   // опускание таза в длинах бедра
        dropDeg = dropToThighDeg(ema('drop', xRaw));
        th = (1 - cfg.dropWeight) * thighDeg + cfg.dropWeight * dropDeg;
        thR = (1 - cfg.dropWeight) * thighRaw + cfg.dropWeight * dropToThighDeg(xRaw);
      } else ema('drop', null);
      kneeDeg = 180 - th;
      kneeRaw = 180 - thR;
    }
    const main = ok.slice().sort((x, y) => y.w - x.w)[0];
    const feet = ok.some((g) => g.ankle);
    return { legs, ok, both, view, kneeDeg, kneeRaw, main, thighDeg, dropDeg, feet };
  }

  // Метрики техники на текущем кадре (только в нижней части повтора). Общая функция для решений и для
  // checks: по каждой ошибке позы — { bad: нарушена (пороги прежние), value: прогресс 0..1 к норме } или null,
  // если в этом ракурсе/кадре её не оценить.
  function postureMetrics(m) {
    const out = { valgus: null, knees_forward: null, lean: null, heels: null };
    const { legs, both, view, main } = m;
    if (both && view !== 'side' && legs[0].ankle && legs[1].ankle) {
      const kd = legs[0].knee.x - legs[1].knee.x, ad = legs[0].ankle.x - legs[1].ankle.x;
      if (Math.abs(ad) >= cfg.minStanceRatio * s.thighRef) {
        const lim = view === 'front' ? cfg.valgusRatio : cfg.valgusRatio * 0.9;
        // колени по линии носков: расстояние между коленями в долях расстояния между лодыжками (внутрь — меньше)
        const q = (Math.sign(kd) === Math.sign(ad) ? Math.abs(kd) : -Math.abs(kd)) / Math.abs(ad);
        out.valgus = { bad: Math.sign(kd) !== Math.sign(ad) || Math.abs(kd) < lim * Math.abs(ad), value: clamp(q / lim, 0, 1) };
      }
    }
    if (view === 'side' && main.toe && main.heel && main.ankle && s.shinRef > 1e-4) {
      const dir = Math.sign(main.toe.x - main.heel.x) || Math.sign(main.toe.x - main.ankle.x);
      if (dir) {
        const over = (main.knee.x - main.toe.x) * dir / s.shinRef;   // колено за носком, в голенях
        out.knees_forward = { bad: (main.knee.x - main.toe.x) * dir > cfg.kneeToeMax * s.shinRef, value: downTo(over, cfg.kneeToeMax, cfg.kneeToeMax * 2) };
      }
    }
    // корпус: середина плеч над серединой таза
    const shs = m.ok.filter((g) => g.sh);
    if (shs.length) {
      const sx = shs.reduce((a, g) => a + g.sh.x, 0) / shs.length, sy = shs.reduce((a, g) => a + g.sh.y, 0) / shs.length;
      const hx = shs.reduce((a, g) => a + g.hip.x, 0) / shs.length, hy = shs.reduce((a, g) => a + g.hip.y, 0) / shs.length;
      const tl = Math.hypot(sx - hx, sy - hy);
      if (view === 'front') {
        if (s.torsoRef > 1e-4) out.lean = { bad: (hy - sy) < cfg.leanFrontRatio * s.torsoRef, value: clamp((hy - sy) / s.torsoRef / cfg.leanFrontRatio, 0, 1) };
      } else if (tl > 1e-4) {
        const ang = Math.atan2(Math.abs(sx - hx), hy - sy) * DEG;
        out.lean = { bad: ang > cfg.leanDeg, value: downTo(ang, cfg.leanDeg, 90) };
      }
    }
    let rise = null;
    for (let i = 0; i < 2; i++) {
      const g = legs[i];
      if (!g || !g.heel || !g.toe || s.heel0[i] === null || !(s.shinRef > 1e-4)) continue;
      const r = (s.heel0[i] - (g.heel.y - g.toe.y)) / s.shinRef;
      rise = rise === null ? r : Math.max(rise, r);
    }
    if (rise !== null) out.heels = { bad: rise > cfg.heelRise, value: downTo(rise, cfg.heelRise, cfg.heelRise * 2) };
    return out;
  }
  // ошибки позы на текущем кадре (только в нижней части повтора)
  const faultsOf = (pm) => POSTURE_FAULTS.filter((f) => pm[f] && pm[f].bad);

  // эталон позы «стоя»: положение пяток относительно носков (длины — в measure, перцентилями)
  function learnStanding(m) {
    for (let i = 0; i < 2; i++) {
      const g = m.legs[i];
      if (!g || !g.heel || !g.toe) continue;
      const d = g.heel.y - g.toe.y;
      s.heel0[i] = s.heel0[i] === null ? d : s.heel0[i] * 0.9 + d * 0.1;
    }
  }

  function startRep(t) {
    s.rep = { start: t, min: s.knee, peak: s.knee, deep: false, rising: false, streak: {}, faults: new Set(), live: new Set(), riseSince: null, moveK: s.knee, moveT: t };
    s.phase = 'descent';
    s.chk.rep = { n: 0, worst: {}, on: {} }; s.chk.live = null;
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
    const clean = !list.length;
    // «Мастер»: засчитан только чистый; «Новичок»: дошёл до глубины — засчитан, ошибки — карточкой
    const counted = cfg.faultsBlock ? clean : r.deep;
    const minKnee = Math.round(r.min), ms = Math.round(t - r.start);
    if (counted) {
      s.reps++;
      if (clean) s.clean++;
      const points = 1 + (clean ? cfg.cleanBonus : 0);
      s.points += points;
      s.pending.push({ tMs: t, rep: s.reps, minKnee, ms, clean, faults: list, points });
    }
    s.lastRep = { tMs: t, ok: counted, clean, faults: list, minKnee, ms, reason: clean ? null : hintText(list[0]) };
    if (clean) s.message = novice ? `Чисто! +${1 + cfg.cleanBonus}` : `${s.reps}`;
    else hint(list[0], t);
    // [ОШИБКА] итог повтора для checks: держится до следующего повтора
    const R = s.chk.rep || { n: 0, worst: {}, on: {} };
    s.chk.last = { tMs: t, faults: list, worst: { ...R.worst }, on: { ...R.on }, n: R.n, minKnee: r.min, peak: r.peak };
    s.rep = null;
  }

  // [W3-SQUAT] сглаженная видимость точек и оценка кадра (подготовка, диагностика) — по сырым точкам
  function noteFrame(L, t, dt) {
    const a = dt > 0 ? 1 - Math.exp(-dt / 0.25) : 1;
    for (const k of Object.keys(s.vis)) {
      const p = L ? L[k] : null;
      const v = p && fin(p.x) && fin(p.y) ? (fin(p.visibility) ? clamp(p.visibility, 0, 1) : 1) : 0;
      s.visRaw[k] = v;
      s.vis[k] += (v - s.vis[k]) * a;
    }
    s.frm = assessSquatFrame(s.vis, L || [], cfg.minVisibility);
    const good = novice ? s.frm.upper : s.frm.full;
    if (good) { if (s.frmOkSince === null) s.frmOkSince = t; } else s.frmOkSince = null;
  }

  function push(obs) {
    if (!obs || !fin(obs.tMs)) return;
    const t = obs.tMs;
    if (s.lastT !== null && t <= s.lastT) return;
    const dt = s.lastT === null ? 0 : Math.min(0.5, (t - s.lastT) / 1000);
    if (dt > 0) s.dtAvg = s.dtAvg === null ? dt : s.dtAvg + (dt - s.dtAvg) * 0.1;
    s.lastT = t;
    const L = Array.isArray(obs.landmarks) ? obs.landmarks : null;
    const ax = fin(obs.frameW) && fin(obs.frameH) && obs.frameH > 0 ? obs.frameW / obs.frameH : 4 / 3;
    noteFrame(L, t, dt);
    const m = L ? measure(L, ax, dt, t) : null;
    s.chk.seen = !!m;
    s.chk.vis = L ? FRAME_IDS.filter((i) => vis(L[i])).length / FRAME_IDS.length : 0;
    if (!m) {
      if (s.lastSeen === null || t - s.lastSeen > cfg.lostMs) {
        if (s.phase !== 'noPose') {
          s.rep = null; s.upSince = null; s.knee = null; s.thighRef = 0; s.shinRef = 0; s.fs = { h: null, flat: null, drop: null };
          for (const b of Object.values(s.ref)) { b.n = 0; b.i = 0; }
          hint('frame', t);
          s.faults.frame++;
        }
        s.phase = 'noPose';
        s.message = hintText('frame');
      }
      return;
    }
    s.lastSeen = t;
    s.view = m.view;
    s.feet = m.feet;
    s.thighDeg = m.thighDeg; s.dropDeg = m.dropDeg;
    s.kneeRaw = m.kneeRaw;
    s.knee = m.kneeDeg;   // признаки уже сглажены в measure
    const k = s.knee;
    s.depth = clamp((180 - k) / (180 - cfg.downDeg), 0, 1);

    if (s.phase === 'noPose' || s.phase === 'setup') {
      s.phase = 'setup';
      if (k >= cfg.lockDeg) {
        learnStanding(m);
        if (s.upSince === null) s.upSince = t;
        if (t - s.upSince >= cfg.setupMs) { s.phase = 'top'; if (!s.attempts) s.message = novice ? 'Готово — приседай!' : 'Готово — приседайте'; }
      } else { s.upSince = null; if (!s.attempts) s.message = novice ? 'Встань прямо, ноги на ширине плеч' : 'Встаньте прямо, ноги на ширине плеч'; }
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
      const pm = postureMetrics(m);
      const now = new Set(faultsOf(pm));
      for (const f of POSTURE_FAULTS) {
        r.streak[f] = now.has(f) ? (r.streak[f] || 0) + 1 : 0;
        if (r.streak[f] >= cfg.holdFrames && !r.faults.has(f)) { r.faults.add(f); hint(f, t); }
      }
      noteRepChecks(pm, t);
    }
    if (!r.rising) {
      r.min = Math.min(r.min, k);
      if (k <= cfg.downDeg) { r.deep = true; s.phase = 'bottom'; }
      // [W3-SQUAT] застыл выше глубины (отошёл от камеры, переминается) — это не попытка: снова подготовка
      if (Math.abs(k - r.moveK) > 6) { r.moveK = k; r.moveT = t; }
      if (!r.deep && t - r.moveT > cfg.plateauMs) { s.rep = null; s.phase = 'setup'; s.upSince = null; return; }
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

  // [ОШИБКА] метрики кадра в нижней части повтора — для показа (худшее значение за повтор)
  function noteRepChecks(pm, t) {
    const C = s.chk;
    C.live = pm; C.liveT = t;
    const R = C.rep;
    if (!R) return;
    R.n++;
    for (const f of POSTURE_FAULTS) if (pm[f]) { R.on[f] = true; R.worst[f] = Math.min(R.worst[f] ?? 1, pm[f].value); }
  }

  // [ОШИБКА] прогресс условий техники для тренажёра: { items: [{ key, value, ok, hint, landmarks }], judged }.
  // Живые значения (кадр в нижней части повтора) + итог последнего повтора: нарушенное условие держит ok:false
  // до следующего повтора. ok:null — в этом ракурсе/фазе не оценивается. Пороги — те же, что у решений.
  function checks() {
    const r = s.rep, C = s.chk, last = C.last;
    const live = r && C.liveT === s.lastT ? C.live : null;   // этот кадр — в нижней части повтора
    const depthOf = (k) => clamp((180 - k) / (180 - cfg.downDeg), 0, 1);
    const lockOf = (k) => (fin(k) ? clamp((k - cfg.downDeg) / (cfg.lockDeg - cfg.downDeg), 0, 1) : 0);
    const v = { frame: { ok: C.seen, value: C.seen ? 1 : C.vis } };
    if (r) v.depth = { ok: r.deep ? true : r.rising ? false : null, value: depthOf(fin(s.knee) ? Math.min(r.min, s.knee) : r.min) };
    else if (last) v.depth = { ok: !last.faults.includes('shallow'), value: depthOf(last.minKnee) };
    else v.depth = { ok: null, value: 0 };
    for (const f of POSTURE_FAULTS) {
      if (r) {
        const R = C.rep || { worst: {}, on: {} };
        if (r.faults.has(f)) v[f] = { ok: false, value: R.worst[f] ?? 0 };
        else if (live && live[f]) v[f] = { ok: !live[f].bad, value: live[f].value };
        else v[f] = { ok: R.on[f] ? true : null, value: R.on[f] ? 1 : 0 };
      } else if (last) v[f] = { ok: last.faults.includes(f) ? false : last.on[f] ? true : null, value: last.worst[f] ?? 0 };
      else v[f] = { ok: null, value: 0 };
    }
    if (r) v.lockout = { ok: null, value: r.rising ? lockOf(s.knee) : 0 };
    else if (last) v.lockout = { ok: !last.faults.includes('lockout'), value: last.faults.includes('lockout') ? lockOf(last.peak) : 1 };
    else v.lockout = { ok: fin(s.knee) ? s.knee >= cfg.lockDeg : null, value: lockOf(s.knee) };
    const items = CHECK_ITEMS.map(([key, hint, landmarks]) => {
      const { ok, value } = v[key];
      const val = ok === true ? 1 : clamp(fin(value) ? value : 0, 0, ok === false ? 0.99 : 1);
      return { key, value: Math.round(val * 100) / 100, ok, hint, landmarks };
    });
    return { items, judged: !!r || !!(last && s.lastT - last.tMs <= JUDGED_MS) };
  }

  // [W3-SQUAT] подготовка: силуэт с точками ног, совет, автопроверка «вижу тебя целиком ✓» (держится 0,5 с)
  function framing() {
    const f = s.frm || assessSquatFrame({}, [], cfg.minVisibility);
    const readyMs = s.frmOkSince === null || s.lastT === null ? 0 : s.lastT - s.frmOkSince;
    const ready = readyMs >= 500;
    // «Новичок» без стоп: можно приседать, а про стопы — совет
    const status = f.full ? 'ok' : f.upper && novice ? 'okNoFeet' : null;
    return { ...f, ready, readyMs: Math.round(readyMs), status, statusText: status ? SQUAT_FRAME_TIPS[status] : null };
  }
  // [W3-SQUAT] диагностика: видимость точек ног, угол, фаза, причина отказа последнего повтора
  function diag() {
    const v = {};
    for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) v[i] = Math.round((s.visRaw[i] || 0) * 100) / 100;
    const r1 = (x) => (fin(x) ? Math.round(x * 10) / 10 : null);
    return {
      vis: v, knee: r1(s.knee), kneeRaw: r1(s.kneeRaw), thighDeg: r1(s.thighDeg), dropDeg: r1(s.dropDeg),
      phase: s.phase, phaseRu: SQUAT_PHASE_RU[s.phase] || s.phase, feet: s.feet, mode: cfg.mode,
      downDeg: cfg.downDeg, lockDeg: cfg.lockDeg, hz: s.dtAvg ? Math.round(10 / s.dtAvg) / 10 : null,
      last: s.lastRep ? { ...s.lastRep } : null,
    };
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
      formScore: s.attempts ? +(s.clean / s.attempts).toFixed(3) : null,
      checks: checks(),   // [ОШИБКА] прогресс условий техники (тренажёр)
      mode: cfg.mode, clean: s.clean, points: s.points, feet: s.feet, downDeg: cfg.downDeg,   // [W3-SQUAT]
      framing: framing(), diag: diag(),
    };
  }
  // Новые засчитанные повторы с прошлого вызова (для начисления очков): { tMs, rep, minKnee, ms, clean, faults, points }.
  function drain() { const out = s.pending; s.pending = []; return out; }
  function getDebug() {
    return { ...read(), kneeRaw: s.kneeRaw === null ? null : +s.kneeRaw.toFixed(1), thighRef: +s.thighRef.toFixed(4), shinRef: +(s.shinRef || 0).toFixed(4), torsoRef: +(s.torsoRef || 0).toFixed(4), hipY0: fin(s.hipY0) ? +s.hipY0.toFixed(4) : null, rep: s.rep ? { start: s.rep.start, min: Math.round(s.rep.min), deep: s.rep.deep, rising: s.rep.rising, faults: [...s.rep.faults] } : null, version: SQUAT_VERSION };
  }

  return { push, read, drain, reset, getDebug, config: cfg };
}

// Самая частая ошибка по счётчикам read().faults (без frame) → { code, text, count } или null.
export function topSquatFault(faults, mode) {
  let best = null;
  for (const code of SQUAT_FAULT_ORDER) {
    const n = faults && fin(faults[code]) ? faults[code] : 0;
    if (n > 0 && (!best || n > best.count)) best = { code, text: (mode === 'novice' && SQUAT_HINTS_NOVICE[code]) || SQUAT_HINTS[code], count: n };
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
