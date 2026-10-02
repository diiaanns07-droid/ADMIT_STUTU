// ASHEN OATH — ультимейт «Небесный суд» [W3-ULT]. Чистая логика: без DOM, Three.js и камеры.
//
// Движение всем телом, а не пальцами: когда шкала «Ярость клятвы» полна, игрок поднимает ОБЕ руки
// над головой и держит 0,8 с — с неба на Регента падает меч из света.
//
//  • armsRaised(landmarks, opts) — один кадр позы MediaPipe (33 точки, x/y в долях кадра, y вниз):
//    у каждой руки «запястье выше носа» и «локоть выше плеча» с запасом в долях ширины плеч.
//    Запястье, ушедшее за верхний край кадра, MediaPipe достраивает с низкой видимостью — такое
//    засчитывается, если локоть уже высоко (рука прямо вверх у человека близко к камере).
//  • createUltimateGesture(opts) — автомат удержания по кадрам позы: гистерезис порогов, короткие
//    провалы трекинга (≤ graceSec) не сбрасывают удержание. push(pose, tMs, {armed}) → кадр:
//    { phase, progress 0..1, fired (импульс), hint (импульс: код core/gestureCoach.js), side, count }.
//    Подсказки «ОШИБКА» (только при полной шкале): одна рука вверху ≥ oneHandSec — 'ult_one_hand';
//    обе подняли и опустили раньше 0,8 с — 'ult_early'. Каждая — не чаще раза в hintCooldownSec.
//  • ultTimeScale(t, dur, strikeAt) — замедление сцены по времени ультимейта (main.js → мир и эффекты).
//  • ultCameraKeys({...}) — ключевые точки кинокамеры (core/cameraRig.js cinematic): облёт героя
//    с подъёмом, взгляд в небо над Регентом, удар, общий план.
//
// Тесты: dev/ultimate.test.mjs.

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Точки позы MediaPipe: 0 нос, 2/5 глаза, 7/8 уши, 11/12 плечи, 13/14 локти, 15/16 запястья
// («левый» — левый у самого человека).
export const POSE = Object.freeze({ nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16 });

export const ULT_GESTURE_DEFAULTS = Object.freeze({
  holdSec: 0.8,          // столько держать обе руки вверху
  graceSec: 0.18,        // провал трекинга короче — удержание не сбрасывается
  oneHandSec: 0.7,       // одна рука вверху столько — подсказка «обе руки»
  earlyMinSec: 0.22,     // обе руки держали хотя бы столько и опустили раньше holdSec — подсказка «держи дольше»
  hintCooldownSec: 4,    // одна и та же подсказка — не чаще
  staleMs: 400,          // кадр позы старше — данных нет
  // запасы в долях ширины плеч (вход / выход — гистерезис)
  wristIn: 0.06, wristOut: 0.0,     // запястье выше носа
  elbowIn: 0.1, elbowOut: 0.02,     // локоть выше плеча (и на выходе — не ниже линии плеч)
  minShoulderVis: 0.5, minVis: 0.3, wristVis: 0.25,
});

function pt(L, i) {
  const q = L && L[i];
  if (!q || !fin(q.x) || !fin(q.y)) return null;
  return q;
}
const vis = (q) => (q && fin(q.visibility) ? q.visibility : 1);

/**
 * Один кадр позы → какие руки подняты.
 * @param {Array<{x,y,visibility?}>} L — 33 точки MediaPipe Pose (доли кадра, y вниз)
 * @param {{aspect?:number, wristIn?, elbowIn?, ...}} [o] — aspect = ширина/высота кадра; пороги (см. ULT_GESTURE_DEFAULTS)
 * @returns {{ok:boolean, reason?:string, sw:number, left:object, right:object, count:number, both:boolean}}
 *   left/right: { up, wristUp, elbowUp, wristMargin, elbowMargin } — запасы в ширинах плеч (+ — выше порога)
 */
export function armsRaised(L, o = {}) {
  const C = { ...ULT_GESTURE_DEFAULTS, ...o };
  const ax = fin(o.aspect) && o.aspect > 0 ? o.aspect : 4 / 3;   // x в высотах кадра — изотропно
  const none = { up: false, wristUp: false, elbowUp: false, wristMargin: -1, elbowMargin: -1 };
  const sL = pt(L, POSE.shL), sR = pt(L, POSE.shR);
  if (!sL || !sR || vis(sL) < C.minShoulderVis || vis(sR) < C.minShoulderVis) {
    return { ok: false, reason: 'shoulders', sw: 0, left: none, right: none, count: 0, both: false };
  }
  const sw = Math.hypot((sL.x - sR.x) * ax, sL.y - sR.y);
  if (!(sw > 0.02)) return { ok: false, reason: 'scale', sw, left: none, right: none, count: 0, both: false };
  // высота носа: сам нос, иначе глаза/уши, иначе ≈0,6 ширины плеч над линией плеч
  const shY = (sL.y + sR.y) / 2;
  let noseY = NaN;
  const n = pt(L, POSE.nose);
  if (n && vis(n) >= C.minVis) noseY = n.y;
  else {
    const face = [POSE.eyeL, POSE.eyeR, POSE.earL, POSE.earR].map((i) => pt(L, i)).filter((q) => q && vis(q) >= C.minVis);
    noseY = face.length ? face.reduce((s, q) => s + q.y, 0) / face.length + sw * 0.08 : shY - sw * 0.6;
  }
  const arm = (S, iE, iW, prev) => {
    const E = pt(L, iE), Wr = pt(L, iW);
    if (!E) return none;
    const elbowMargin = (S.y - E.y) / sw;
    // локоть за верхним краем кадра (сидят близко к камере): MediaPipe достраивает его с низкой видимостью —
    // верим, только если он явно высоко над плечом
    if (vis(E) < C.minVis && !(vis(E) >= 0.05 && elbowMargin >= 0.3)) return none;
    let wristMargin = -1;
    if (Wr) {
      const raw = (noseY - Wr.y) / sw;
      if (vis(Wr) >= C.wristVis) wristMargin = raw;
      // запястье за верхним краем кадра (или почти невидимо): верим, если оно выше локтя, а локоть — выше плеча
      else if ((Wr.y < 0.04 || Wr.y < E.y - sw * 0.25) && elbowMargin > C.elbowIn) wristMargin = raw;
    }
    // гистерезис: рука, которая уже «вверху», держится по мягким порогам
    const wIn = prev ? C.wristOut : C.wristIn, eIn = prev ? C.elbowOut : C.elbowIn;
    const wristUp = wristMargin >= wIn, elbowUp = elbowMargin >= eIn;
    return { up: wristUp && elbowUp, wristUp, elbowUp, wristMargin, elbowMargin };
  };
  const left = arm(sL, POSE.elL, POSE.wrL, !!(o.prev && o.prev.left));
  const right = arm(sR, POSE.elR, POSE.wrR, !!(o.prev && o.prev.right));
  const count = (left.up ? 1 : 0) + (right.up ? 1 : 0);
  return { ok: true, sw, left, right, count, both: count === 2 };
}

/**
 * Автомат жеста «обе руки над головой, 0,8 с».
 * push(pose, nowMs, {armed}) — pose = vision.getPose() ({tMs, frameW, frameH, landmarks}) или null.
 * Новые кадры позы (tMs изменился) двигают автомат; между кадрами возвращается прежнее состояние.
 */
export function createUltimateGesture(opts = {}) {
  const C = { ...ULT_GESTURE_DEFAULTS, ...opts };
  const s = {
    lastPoseT: null, lastT: null,
    hold: 0, gap: 0, one: 0, oneSide: null,
    prev: { left: false, right: false },
    latched: false,                 // выстрелил — ждём, пока руки опустятся
    hintAt: Object.create(null),    // код → время последнего показа (с)
    out: { phase: 'idle', progress: 0, fired: false, hint: null, side: null, count: 0, both: false, armed: false },
  };
  function resetHold() { s.hold = 0; s.gap = 0; }
  function reset() {
    s.lastPoseT = null; s.lastT = null; resetHold(); s.one = 0; s.oneSide = null;
    s.prev.left = false; s.prev.right = false; s.latched = false;
    for (const k of Object.keys(s.hintAt)) delete s.hintAt[k];
    Object.assign(s.out, { phase: 'idle', progress: 0, fired: false, hint: null, side: null, count: 0, both: false, armed: false });
  }
  function hint(code, t) {
    const last = s.hintAt[code];
    if (fin(last) && t - last < C.hintCooldownSec) return null;
    s.hintAt[code] = t;
    return code;
  }

  function push(pose, nowMs, { armed = true } = {}) {
    const o = s.out;
    o.fired = false; o.hint = null; o.armed = !!armed;
    const tNow = (fin(nowMs) ? nowMs : 0) / 1000;
    const fresh = pose && Array.isArray(pose.landmarks) && fin(pose.tMs) && (!fin(nowMs) || nowMs - pose.tMs <= C.staleMs);
    if (!armed) { resetHold(); s.one = 0; s.latched = false; o.phase = 'idle'; o.progress = 0; o.count = 0; o.both = false; s.lastT = tNow; return o; }
    if (!fresh) {
      // нет свежей позы: провал трекинга — удержание живёт graceSec
      if (s.lastT !== null) s.gap += clamp(tNow - s.lastT, 0, 0.25);
      s.lastT = tNow;
      if (s.gap > C.graceSec) { resetHold(); s.one = 0; s.lastPoseT = null; o.phase = 'idle'; o.progress = 0; o.count = 0; o.both = false; }   // после долгого провала — отсчёт заново
      return o;
    }
    if (pose.tMs === s.lastPoseT) { s.lastT = tNow; return o; }   // тот же кадр камеры
    const t = pose.tMs / 1000;
    const dt = s.lastPoseT === null ? 0 : clamp(t - s.lastPoseT / 1000, 0, 0.15);   // медленная камера (8 Гц) — до 0,125 с
    s.lastPoseT = pose.tMs; s.lastT = tNow;
    const W = fin(pose.frameW) ? pose.frameW : 640, H = fin(pose.frameH) ? pose.frameH : 480;
    const r = armsRaised(pose.landmarks, { ...C, aspect: H > 0 ? W / H : 4 / 3, prev: s.prev });
    s.prev.left = r.left.up; s.prev.right = r.right.up;
    o.count = r.count; o.both = r.both;
    if (s.latched) {
      // после «выстрела» — новый не раньше, чем руки опустятся
      if (r.count === 0) s.latched = false;
      o.phase = 'fired'; o.progress = 1;
      return o;
    }
    if (r.both) {
      s.hold += dt; s.gap = 0; s.one = 0;
      if (s.hold >= C.holdSec) {
        o.fired = true; s.latched = true; resetHold();
        o.phase = 'fired'; o.progress = 1; o.side = null;
        return o;
      }
      o.phase = 'hold'; o.progress = clamp(s.hold / C.holdSec, 0, 1);
      return o;
    }
    // не обе: короткий провал не сбрасывает удержание
    if (s.hold > 0) {
      s.gap += dt;
      if (s.gap <= C.graceSec) { o.phase = 'hold'; o.progress = clamp(s.hold / C.holdSec, 0, 1); return o; }
      if (s.hold >= C.earlyMinSec) { o.hint = hint('ult_early', t); o.side = null; }
      resetHold();
    }
    o.progress = 0;
    if (r.count === 1) {
      const side = r.left.up ? 'left' : 'right';
      s.one = s.oneSide === side ? s.one + dt : dt;
      s.oneSide = side;
      o.phase = 'one';
      if (s.one >= C.oneHandSec && !o.hint) {
        const h = hint('ult_one_hand', t);
        // «сторона» подсказки — рука, которую надо поднять (опущенная)
        if (h) { o.hint = h; o.side = side === 'left' ? 'right' : 'left'; }
      }
    } else { s.one = 0; s.oneSide = null; o.phase = 'idle'; }
    return o;
  }

  return {
    push, reset,
    get state() { return s.out; },
    get holding() { return s.out.phase === 'hold'; },
  };
}

// ───────── сцена ─────────
// Темп мира во время сцены (t — секунды от начала, dur — длина, strikeAt — касание меча):
// вход в замедление 0,3 с → медленно (облёт) → глубже у удара → отпускает к концу.
export function ultTimeScale(t, dur = 3.6, strikeAt = 2.3, reduced = false) {
  if (!fin(t) || t < 0 || t >= dur) return 1;
  const slow = reduced ? 0.6 : 0.3, deep = reduced ? 0.5 : 0.14;
  const smooth = (k) => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
  let v;
  if (t < 0.3) v = 1 + (slow - 1) * smooth(t / 0.3);
  else v = slow;
  const ds = Math.abs(t - strikeAt);
  if (ds < 0.35) v = Math.min(v, deep + (slow - deep) * smooth(ds / 0.35));
  const out = dur - 0.55;
  if (t > out) v = v + (1 - v) * smooth((t - out) / 0.55);
  return clamp(v, 0.05, 1);
}

/**
 * Ключевые точки кинокамеры (мировые координаты) для core/cameraRig.js cinematic(keys).
 * p — герой, b — Регент (центр арены), dur/strikeAt — из события ultimate_start.
 * Герой смотрит на Регента: f — от героя к Регенту, r — вправо. Облёт идёт по дуге вокруг героя
 * (спереди-снизу → сбоку выше → за спиной высоко, взгляд в небо над Регентом) — удар — общий план.
 * maxR — камера не дальше этого радиуса от Регента (кольцо руин), ground(x,z) — высота земли.
 */
export function ultCameraKeys({ p, b, dur = 3.6, strikeAt = 2.3, maxR = 11.6, ground = null, skyH = 17 } = {}) {
  const P = { x: fin(p && p.x) ? p.x : 0, y: fin(p && p.y) ? p.y : 0, z: fin(p && p.z) ? p.z : 6 };
  const B = { x: fin(b && b.x) ? b.x : 0, y: fin(b && b.y) ? b.y : 0, z: fin(b && b.z) ? b.z : 0 };
  let fx = B.x - P.x, fz = B.z - P.z;
  const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
  const rx = -fz, rz = fx;
  // точка = герой + f·a + r·c + вверх·h
  const at = (a, c, h) => {
    let x = P.x + fx * a + rx * c, z = P.z + fz * a + rz * c;
    const d = Math.hypot(x - B.x, z - B.z);
    if (fin(maxR) && d > maxR) { const k = maxR / d; x = B.x + (x - B.x) * k; z = B.z + (z - B.z) * k; }
    let y = P.y + h;
    if (typeof ground === 'function') { let g = NaN; try { g = Number(ground(x, z)); } catch (e) { g = NaN; } if (fin(g) && y < g + 0.6) y = g + 0.6; }
    return { x, y, z };
  };
  const look = (a, c, h) => ({ x: P.x + fx * a + rx * c, y: P.y + h, z: P.z + fz * a + rz * c });
  const sky = { x: B.x, y: B.y + skyH, z: B.z };
  const boss = { x: B.x, y: B.y + 3.2, z: B.z };
  const k = (t, pos, tgt) => ({ t: clamp(t, 0, dur), pos, look: tgt });
  const s = strikeAt;
  return [
    k(0.45, at(2.4, 1.6, 1.05), look(0, 0, 1.6)),                   // спереди-снизу: герой поднимает руки
    k(s * 0.55, at(0.4, -3.1, 2.3), look(0.6, 0, 2.4)),             // сбоку, выше: облёт
    k(s - 0.35, at(-3.6, -1.6, 4.4), { x: sky.x, y: sky.y - 2, z: sky.z }), // за спиной высоко: небо раскалывается, меч падает
    k(s + 0.08, at(-3.2, -1.0, 3.6), boss),                         // удар
    k(Math.min(dur - 0.6, s + 0.75), at(-5.2, 1.8, 5.6), { x: B.x, y: B.y + 2.2, z: B.z }), // общий план
  ];
}
