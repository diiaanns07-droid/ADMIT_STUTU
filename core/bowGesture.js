// ASHEN OATH — [HAND] «Сумеречный Лук» (CANON B1): стрельба из лука руками. Владелец: №6 [HAND].
// Чистая логика: без DOM и без импортов; время — только из аргументов (tMs).
//
// Стойка: левая рука вытянута вперёд КУЛАКОМ на уровне груди/плеча (держит лук). Правая ЩЕПОТЬ
// (кончики большого и указательного вместе) подносится к левому кулаку — стрела наложена
// (active=true, в бою — bow_draw_start). Натяжение: щепоть тянется назад к правому плечу/уху.
// draw 0..1 — расстояние между кистями в ширинах плеч плюс «глубина» (левый кулак ближе к камере,
// правая кисть уходит назад: отношение масштабов кистей растёт). Полное натяжение, удержанное
// 0,35 с, — charged. Прицел: где левый кулак относительно центра плеч → aimX/aimY. Разжать
// щепоть — выстрел (release=true на один read()). Высоко вверх с полным натяжением — «Дождь стрел».
// Руна, нарисованная при поднятом луке (offerRune), заряжает следующую стрелу стихией.
// Лук включается ТОЛЬКО связкой «левый кулак в зоне + правая щепоть у кулака»; выход из стойки —
// с гистерезисом 0,2 с. Пока лук активен, левая рука не рулит, щит и парирование молчат (core/handZone.js).
//
// Этот же файл даёт общую геометрию кисти для core/handMagic.js: buildHandFrame(obs, pose) —
// кадр с обеими кистями в координатах ПОКАЗА (x зеркалится при obs.mirror, единицы — высоты
// кадра: x·aspect, y), признаками пальцев, нормалью ладони и корпусом (центр и ширина плеч).
//
// obs — то же наблюдение, что modules/vision.js отдаёт core/handGestures.js:
//   { tMs, frameW, frameH, mirror, hands:[{landmarks, world, handedness, score}], poseWrists:{left,right},
//     bodyCenter:{x,y}|null (центр плеч, НЕзеркальный кадр), shoulderWidth (высоты кадра) }
// pose — необязательно: 33 точки MediaPipe Pose (НЕзеркальный кадр) для плеч и ушей.

export const BOW_VERSION = 'HAND-bow-1';

export const DEFAULT_BOW_CONFIG = Object.freeze({
  staleMs: 350,            // кадр старше — лук «не видит» рук
  lostGraceMs: 200,        // [гистерезис] левый кулак пропал/раскрылся не дольше — стойка держится
  pulseTtlMs: 400,         // непрочитанный выстрел сгорает
  // формы (пороги по мотивам core/handGestures.js: вылет кончика / сгиб суставов)
  reachExtended: 1.15, bendExtended: 88,
  reachCurled: 1.04, bendCurled: 110,
  // щепоть подобрана по HaGRID «ok» (0.15–0.77) и кулакам (у кулака указательный короче: вылет ≤ 0.78)
  pinchOn: 0.6,            // |кончик большого − кончик указательного| / длина ладони: меньше — щепоть
  pinchOff: 0.8,           // больше — пальцы разжаты (выстрел)
  pinchOffExt: 0.62,       // …или больше этого при почти выпрямленном указательном (вылет ≥ pinchExtReach)
  pinchExtReach: 1.2,
  pinchOpenReach: 1.27,    // …или указательный выпрямлен совсем (у «ok» HaGRID вылет ≤ 1.22)
  pinchIndexMinReach: 0.8, // указательный в щепоти не загнут в кулак целиком…
  pinchIndexMaxReach: 1.26,//   …и не выпрямлен, как у открытой ладони
  pinchTight: 0.35,        // кончики совсем сомкнуты (у ладоней HaGRID ≥ 0.47) — щепоть и при почти прямом указательном…
  pinchTightMaxReach: 1.34,//   …до такого вылета
  // зона лука (левый кулак) относительно центра плеч, в ширинах плеч (x — от центра к правой руке игрока, y — вниз)
  zoneX: [-1.75, 0.75], zoneY: [-0.85, 1.1],
  zoneXKeep: [-2.1, 1.0], zoneYKeep: [-1.1, 1.35],
  readyMs: 140,            // кулак в зоне столько — лук поднят (phase 'ready')
  fistForward: 0.3,        // «вытянут вперёд»: размер кисти / ширина плеч не меньше (у тела ≈ 0.25; рука к камере — больше)
  nockDist: 0.62,          // щепоть ближе к кулаку (ширин плеч) — можно накладывать стрелу
  nockDistHand: 2.6,       // …или ближе стольких размеров кисти (если плечи не видны)
  nockMs: 110,             // щепоть у кулака столько — стрела наложена
  stanceKeepMs: 1500,      // после выстрела/наложения стойка держится столько без новой щепоти
  // натяжение
  drawFull: 0.75,          // |щепоть − кулак| (ширин плеч) при полном натяжении: кулак перед грудью → щепоть у правого плеча ≈ 0.75, у уха ≈ 0.9
  drawBaseMin: 0.12,       // стартовое расстояние (от него считаем) не меньше
  drawDepthFull: 1.6,      // рост отношения масштабов кистей (левая / правая) с момента наложения — «полная глубина»
  drawDepthWeight: 0.45,
  drawTauMs: 45,
  chargedOn: 0.85, chargedOff: 0.68, chargedHoldMs: 350,
  minDraw: 0.12,           // меньше — «опустил тетиву», выстрела нет
  peakWindowMs: 140,       // натяжение выстрела = максимум за столько до раскрытия щепоти
  rapidWindowMs: 700,      // выстрел быстрее после прошлого…
  rapidDraw: 0.6,          //   …и слабее этого — «серия недонатянутых»: слабая стрела
  // прицел: нейтраль — кулак чуть левее и ниже центра плеч
  aimNeutral: { x: -0.35, y: 0.3 },
  aimRange: { x: 0.95, y: 0.75 },
  aimTauMs: 60,
  aimFreezeMs: 70,         // прицел выстрела — каким был за столько до раскрытия (рука дёргается при выпуске)
  rainAimY: 0.62,          // «Дождь стрел»: прицел выше этого и полное натяжение
  rainDraw: 0.88,
  runeElementMs: 12000,    // стихия от руны ждёт выстрела столько
  // подсказки «ОШИБКА»
  hintCooldownMs: 6000, hintGapMs: 2200,
  hintFistMs: 550,         // щепоть у открытой левой ладони столько — «сожми кулак»
  hintPinchMs: 700,        // правая кисть у кулака без щепоти столько — «сведи щепоть»
  hintDrawMs: 1300,        // стрела наложена, а натяжения нет столько — «тяни к уху»
  hintReleaseMs: 2600,     // натянуто и держится столько — «отпусти»
  hintLowMs: 700,          // кулак со щепотью ниже зоны столько — «подними кулак»
  hintStillSpeed: 0.9,     // ширин плеч в секунду: правая кисть «стоит» (не рисует руну)
  hintForwardMs: 700,      // кулак со щепотью у тела (не вытянут) столько — «вытяни кулак вперёд»
});

// Руна → стихия стрелы/сгустка (руны — core/handGestures.js RUNES)
export const RUNE_ELEMENT = Object.freeze({
  ignis: 'fire', stella: 'fire',
  fulgur: 'storm', spira: 'storm', alpha: 'storm',
  caret: 'frost', clepsydra: 'frost', lemnis: 'frost',
  vee: 'earth', orbis: 'earth',
});
export const ELEMENTS = Object.freeze(['fire', 'storm', 'frost', 'earth']);

// Коды подсказок режима «ОШИБКА» (тексты — core/gestureCoach.js, блок [HAND])
export const BOW_HINTS = Object.freeze({
  bow_fist: 'Сожми левую руку в кулак, как будто держишь лук',
  bow_pinch: 'Сведи большой и указательный в щепоть у левого кулака',
  bow_draw: 'Тяни правую руку назад к уху',
  bow_release: 'Отпусти стрелу — разожми пальцы',
  bow_low: 'Подними левый кулак до груди или плеча',
  bow_forward: 'Вытяни левый кулак вперёд, к камере — как будто держишь лук',
});

// ───────────────────────────── геометрия кисти (общая с handMagic) ─────────────────────────────
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const isObj = (v) => v !== null && typeof v === 'object';
const DEG = 180 / Math.PI;
function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function dist3(a, b) { return len(sub(a, b)); }
function dist2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function angleBetween(u, v) {
  const lu = len(u), lv = len(v);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  return Math.acos(clamp((u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv), -1, 1)) * DEG;
}
export function mergeConfig(base, patch) {
  const out = { ...base };
  if (!isObj(patch)) return out;
  for (const k of Object.keys(patch)) {
    if (!(k in base)) continue;
    const b = base[k], v = patch[k];
    if (Array.isArray(b)) { if (Array.isArray(v) && v.length === b.length && v.every(fin)) out[k] = v.slice(); }
    else if (isObj(b)) { if (isObj(v)) out[k] = { ...b, ...v }; }
    else if (typeof b === 'number') { if (fin(v)) out[k] = v; }
    else if (typeof b === typeof v) out[k] = v;
  }
  return out;
}

const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
const SCALE_SEGS = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17]];
const SCALE_SEGS_2D = [[0, 9, 1], [0, 5, 1], [0, 17, 1.12], [5, 17, 1.45]];

function validLm(arr) {
  if (!Array.isArray(arr) || arr.length < 21) return false;
  for (let i = 0; i < 21; i++) { const p = arr[i]; if (!p || !fin(p.x) || !fin(p.y)) return false; }
  return true;
}

/**
 * Признаки одной кисти. landmarks — нормализованные НЕзеркальные (0..1), world — метры (или null).
 * Возвращает точки ПОКАЗА D[21] ({x: (зерк. x)·aspect, y}), центр, масштаб S (высоты кадра),
 * сгибы/вылеты пальцев, щепоть, растопыренность, форму и нормаль ладони (оси показа: x вправо, y вниз, z от камеры).
 */
export function handFeatures(landmarks, world, aspect, mirror, side, cfg = DEFAULT_BOW_CONFIG) {
  if (!validLm(landmarks)) return null;
  const W = validLm(world) && world.every((p) => fin(p.z)) ? world : null;
  const P = W || landmarks.map((p) => ({ x: p.x * aspect, y: p.y, z: (fin(p.z) ? p.z : 0) * aspect }));
  const D = landmarks.map((p) => ({ x: (mirror ? 1 - p.x : p.x) * aspect, y: p.y, z: fin(p.z) ? p.z : 0 }));
  const palm = Math.max(1e-6, dist3(P[0], P[9]));
  const width = Math.max(1e-6, dist3(P[5], P[17]));
  const bends = FINGERS.map(([m, p, d, t]) => angleBetween(sub(P[p], P[m]), sub(P[d], P[p])) + angleBetween(sub(P[d], P[p]), sub(P[t], P[d])));
  const reach = FINGERS.map(([, p, , t]) => dist3(P[t], P[0]) / Math.max(1e-6, dist3(P[p], P[0])));
  const extended = bends.map((b, i) => reach[i] > cfg.reachExtended && b < cfg.bendExtended);
  const curled = bends.map((b, i) => b > cfg.bendCurled || reach[i] < cfg.reachCurled);
  const pinchD = dist3(P[4], P[8]) / palm;
  const thumbSpread = dist3(P[4], P[5]) / width;
  const tipSpread = dist3(P[8], P[20]) / width;
  // масштаб кисти (как в handGestures: устойчив к ракурсу)
  const I = landmarks.map((p) => ({ x: p.x * aspect, y: p.y }));
  let scale = 0;
  if (W) {
    let ppm = 0;
    for (const [a, b] of SCALE_SEGS) { const l3 = dist3(W[a], W[b]); if (l3 > 1e-4) ppm = Math.max(ppm, dist2(I[a], I[b]) / l3); }
    scale = ppm * dist3(W[0], W[9]);
  }
  if (!(scale > 1e-6)) { for (const [a, b, k] of SCALE_SEGS_2D) scale = Math.max(scale, k * dist2(I[a], I[b])); }
  scale = Math.max(1e-6, scale);
  // нормаль ладони наружу: (P5 − P0) × (P17 − P0) — для правой кисти наружу, для левой — внутрь
  const a = sub(P[5], P[0]), b = sub(P[17], P[0]);
  let n = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  const nl = len(n);
  let normal = null;
  if (nl > 1e-12) {
    const s = side === 'left' ? -1 : 1;
    n = { x: (s * n.x) / nl, y: (s * n.y) / nl, z: (s * n.z) / nl };
    normal = { x: mirror ? -n.x : n.x, y: n.y, z: n.z };
  }
  const center = { x: 0, y: 0 };
  for (const k of [0, 5, 9, 13, 17]) { center.x += D[k].x / 5; center.y += D[k].y / 5; }
  const pinchPt = { x: (D[4].x + D[8].x) / 2, y: (D[4].y + D[8].y) / 2 };
  const nCurled = curled.filter(Boolean).length, nExt = extended.filter(Boolean).length;
  // полусогнутые пальцы «когтей»: не выпрямлены, но и не в кулаке
  const semi = bends.map((bd, i) => !extended[i] && reach[i] >= 0.9 && bd >= 40 && bd <= 215);
  const nSemi = semi.filter(Boolean).length;
  // щепоть: кончики большого и указательного вместе, указательный полусогнут (не кулак и не ладонь)
  const pinchLike = (pinchD < cfg.pinchOn && reach[0] >= cfg.pinchIndexMinReach && reach[0] <= cfg.pinchIndexMaxReach)
    || (pinchD < cfg.pinchTight && reach[0] >= cfg.pinchIndexMinReach && reach[0] <= cfg.pinchTightMaxReach); // кончики сомкнуты при почти прямом указательном
  const pinchOpen = pinchD > cfg.pinchOff || (pinchD > cfg.pinchTight && reach[0] > cfg.pinchOpenReach) || (pinchD > cfg.pinchOffExt && reach[0] >= cfg.pinchExtReach);
  let shape = 'other';
  if (!pinchLike && (nCurled === 4 || (nCurled === 3 && !extended[0] && curled[1] && curled[2] && reach[0] < 1.1))) shape = 'fist';
  else if (pinchLike) shape = 'pinch';
  else if (extended[0] && extended[1] && extended[2] && (extended[3] || !curled[3])) shape = 'open';
  else if (nSemi >= 3 && tipSpread >= 1.0 && thumbSpread >= 0.55 && nCurled <= 2) shape = 'claw';
  else if (extended[0] && curled[1] && curled[2]) shape = 'point';
  return {
    side, D, center, pinchPt, scale, palm, width, bends, reach, extended, curled, semi,
    nCurled, nExt, nSemi, pinchD, pinchLike, pinchOpen, thumbSpread, tipSpread, normal, shape,
    wrist: { x: D[0].x, y: D[0].y },
  };
}

/** Кадр для распознавателей лука и магии рукой: стороны игрока, признаки кистей, корпус. */
export function buildHandFrame(obs, pose, cfg = DEFAULT_BOW_CONFIG) {
  if (!isObj(obs) || !fin(obs.tMs)) return null;
  const fw = fin(obs.frameW) && obs.frameW > 0 ? obs.frameW : 640;
  const fh = fin(obs.frameH) && obs.frameH > 0 ? obs.frameH : 480;
  const aspect = fw / fh;
  const mirror = obs.mirror !== false;
  const dx = (x) => (mirror ? 1 - x : x) * aspect;
  const lms = Array.isArray(pose) ? pose : isObj(pose) && Array.isArray(pose.landmarks) ? pose.landmarks : null;
  const lm = (i, minVis = 0.5) => {
    const p = lms && lms[i];
    if (!p || !fin(p.x) || !fin(p.y) || (fin(p.visibility) && p.visibility < minVis)) return null;
    return { x: dx(p.x), y: p.y };
  };
  // стороны: ближайшее запястье позы, иначе метка handedness (на незеркальном кадре она совпадает со стороной игрока)
  const hands = Array.isArray(obs.hands) ? obs.hands.filter((h) => isObj(h) && validLm(h.landmarks) && (!fin(h.score) || h.score >= 0.4)).slice(0, 2) : [];
  const pw = isObj(obs.poseWrists) ? obs.poseWrists : {};
  const okW = (w) => isObj(w) && fin(w.x) && fin(w.y) && (!fin(w.visibility) || w.visibility >= 0.3);
  const WL = okW(pw.left) ? pw.left : null, WR = okW(pw.right) ? pw.right : null;
  const dW = (h, w) => Math.hypot((h.landmarks[0].x - w.x) * aspect, h.landmarks[0].y - w.y);
  const out = { left: null, right: null };
  if (hands.length === 2 && WL && WR) {
    const a = dW(hands[0], WL) + dW(hands[1], WR), b = dW(hands[0], WR) + dW(hands[1], WL);
    if (a <= b) { out.left = hands[0]; out.right = hands[1]; } else { out.left = hands[1]; out.right = hands[0]; }
  } else {
    for (const h of hands) {
      let side;
      if (WL && WR) side = dW(h, WL) <= dW(h, WR) ? 'left' : 'right';
      else if (WL || WR) { const near = dW(h, WL || WR) <= 0.15; side = (WL ? near : !near) ? 'left' : 'right'; }
      else if (h.handedness === 'Left' || h.handedness === 'Right') side = h.handedness === 'Left' ? 'left' : 'right';
      else side = h.landmarks[0].x < 0.5 ? 'right' : 'left';
      if (out[side]) { const o = side === 'left' ? 'right' : 'left'; if (!out[o]) out[o] = h; } else out[side] = h;
    }
  }
  const L = out.left ? handFeatures(out.left.landmarks, out.left.world, aspect, mirror, 'left', cfg) : null;
  const R = out.right ? handFeatures(out.right.landmarks, out.right.world, aspect, mirror, 'right', cfg) : null;
  // корпус: центр и ширина плеч (высоты кадра)
  let body = null;
  const shL = lm(11, 0.5), shR = lm(12, 0.5);
  if (isObj(obs.bodyCenter) && fin(obs.bodyCenter.x) && fin(obs.bodyCenter.y)) {
    body = { cx: dx(obs.bodyCenter.x), cy: obs.bodyCenter.y, sw: fin(obs.shoulderWidth) && obs.shoulderWidth > 0.02 ? obs.shoulderWidth : null };
  } else if (shL && shR) body = { cx: (shL.x + shR.x) / 2, cy: (shL.y + shR.y) / 2, sw: null };
  if (body && !body.sw && shL && shR) body.sw = Math.max(0.02, dist2(shL, shR));
  if (body && !body.sw) { const hs = (L && L.scale) || (R && R.scale); body.sw = hs ? hs * 3.6 : 0.3; }
  return {
    tMs: obs.tMs, aspect, mirror, left: L, right: R, body,
    shoulders: shL && shR ? { left: shL, right: shR } : null,
    ears: { left: lm(7, 0.4), right: lm(8, 0.4) },
  };
}

// ───────────────────────────── распознаватель лука ─────────────────────────────
function emptyBow() {
  return { active: false, draw: 0, aimX: 0, aimY: 0, charged: false, release: false, element: null, phase: 'idle', rain: false, rapid: false };
}

export function createBowGesture(configPatch = {}) {
  let cfg = mergeConfig(DEFAULT_BOW_CONFIG, configPatch);
  let st;
  function reset() {
    st = {
      phase: 'idle',          // idle | ready (лук поднят) | nocked (стрела у кулака) | drawing
      active: false, lastT: null,
      fistSince: null, fistLostAt: null, lastFist: null,
      nockSince: null, nockedAt: null, keepUntil: -Infinity,
      rightLostAt: null,
      base: 0.3, ratio0: 1, drawRaw: 0, draw: 0, hist: [],   // hist: {t, draw, aimX, aimY}
      fullSince: null, charged: false,
      aimX: 0, aimY: 0,
      pinchClosed: false,
      pulse: null, lastReleaseT: -Infinity,
      element: null, elementUntil: -Infinity, elementRune: null,
      hint: null, hints: { until: {}, gapUntil: -Infinity, since: {} },
      prevR: null,
      counters: { frames: 0, nocks: 0, releases: 0, letdowns: 0, cancels: 0, rains: 0, hints: 0, runes: 0 },
      lastEvent: null,
    };
  }
  reset();

  function zoneOf(L, body, keep) {
    if (!L) return 'none';
    if (!body) return 'in';
    const x = (L.center.x - body.cx) / body.sw, y = (L.center.y - body.cy) / body.sw;
    const zx = keep ? cfg.zoneXKeep : cfg.zoneX, zy = keep ? cfg.zoneYKeep : cfg.zoneY;
    if (y > zy[1]) return 'low';
    if (x < zx[0] || x > zx[1] || y < zy[0]) return 'out';
    return 'in';
  }
  const isFist = (L, keep) => !!L && (L.shape === 'fist' || (keep && L.nCurled >= 2 && L.nExt <= 1));
  function isPinch(R, keep) {
    if (!R) return false;
    if (keep) return !R.pinchOpen;
    return R.pinchLike;
  }
  function nockClose(L, R, body, mul = 1) {
    if (!L || !R) return false;
    const d = dist2(R.pinchPt, L.center);
    if (body && body.sw) return d / body.sw <= cfg.nockDist * mul;
    return d / Math.max(1e-6, L.scale) <= cfg.nockDistHand * mul;
  }

  function hint(code, t) {
    const H = st.hints;
    if (t < H.gapUntil || t < (H.until[code] || -Infinity)) return;
    H.until[code] = t + cfg.hintCooldownMs;
    H.gapUntil = t + cfg.hintGapMs;
    st.hint = { code, side: code === 'bow_fist' || code === 'bow_low' || code === 'bow_forward' ? 'left' : 'right', guess: 'bow', tMs: t };
    st.counters.hints++;
  }
  function since(key, cond, t) {
    const S = st.hints.since;
    if (!cond) { S[key] = null; return 0; }
    if (S[key] === null || S[key] === undefined) S[key] = t;
    return t - S[key];
  }

  function computeDraw(L, R, body, dt) {
    const sw = body && body.sw ? body.sw : Math.max(1e-6, L.scale) * 3.6;
    const d = dist2(R.pinchPt, L.center) / sw;
    const d2 = clamp01((d - st.base) / Math.max(0.2, cfg.drawFull - st.base));
    const ratio = L.scale / Math.max(1e-6, R.scale);
    const dz = clamp01(Math.log(Math.max(1e-6, ratio / st.ratio0)) / Math.log(cfg.drawDepthFull));
    const w = cfg.drawDepthWeight;
    st.drawRaw = clamp01(Math.max(d2, (1 - w) * d2 + w * dz));
    const k = dt > 0 ? 1 - Math.exp(-dt / Math.max(1, cfg.drawTauMs)) : 1;
    st.draw += (st.drawRaw - st.draw) * k;
    if (st.draw < 0.002) st.draw = 0;
  }
  function computeAim(L, body, dt) {
    if (!body) return;
    const nx = body.cx + cfg.aimNeutral.x * body.sw, ny = body.cy + cfg.aimNeutral.y * body.sw;
    const ax = clamp((L.center.x - nx) / (cfg.aimRange.x * body.sw), -1, 1);
    const ay = clamp(-(L.center.y - ny) / (cfg.aimRange.y * body.sw), -1, 1);
    const k = dt > 0 ? 1 - Math.exp(-dt / Math.max(1, cfg.aimTauMs)) : 1;
    st.aimX += (ax - st.aimX) * k;
    st.aimY += (ay - st.aimY) * k;
  }
  function pushHist(t) {
    st.hist.push({ t, draw: st.draw, raw: st.drawRaw, aimX: st.aimX, aimY: st.aimY });
    const keep = Math.max(cfg.peakWindowMs, cfg.aimFreezeMs) + 120;
    while (st.hist.length > 2 && t - st.hist[0].t > keep) st.hist.shift();
  }
  function peakDraw(t) {
    let m = st.draw;
    for (const h of st.hist) if (t - h.t <= cfg.peakWindowMs) m = Math.max(m, h.draw, h.raw * 0.95);
    return clamp01(m);
  }
  function frozenAim(t) {
    let best = null;
    for (const h of st.hist) if (t - h.t >= cfg.aimFreezeMs) best = h;
    return best ? { x: best.aimX, y: best.aimY } : { x: st.aimX, y: st.aimY };
  }

  function unnock(t, why) {
    if (st.phase === 'nocked' || st.phase === 'drawing') {
      if (why === 'cancel') st.counters.cancels++;
      st.lastEvent = { type: why, t };
    }
    st.phase = st.fistSince !== null ? 'ready' : 'idle';
    st.nockSince = null; st.nockedAt = null; st.fullSince = null; st.charged = false;
    st.draw = 0; st.drawRaw = 0; st.hist.length = 0; st.pinchClosed = false;
  }
  function endStance(t) {
    if (st.phase === 'nocked' || st.phase === 'drawing') unnock(t, 'cancel');
    st.phase = 'idle'; st.active = false; st.fistSince = null; st.fistLostAt = null; st.keepUntil = -Infinity;
  }

  function fire(t) {
    const draw = peakDraw(t);
    if (draw < cfg.minDraw) { st.counters.letdowns++; unnock(t, 'letdown'); return; }
    const aim = frozenAim(t);
    const rain = aim.y >= cfg.rainAimY && (st.charged || draw >= cfg.rainDraw);
    const rapid = t - st.lastReleaseT < cfg.rapidWindowMs && draw < cfg.rapidDraw;
    const element = st.element && t <= st.elementUntil ? st.element : null;
    st.pulse = { t, draw, charged: st.charged, aimX: aim.x, aimY: aim.y, rain, rapid, element, rune: element ? st.elementRune : null };
    st.counters.releases++;
    if (rain) st.counters.rains++;
    st.lastReleaseT = t;
    st.element = null; st.elementRune = null; st.elementUntil = -Infinity;
    st.keepUntil = t + cfg.stanceKeepMs;
    st.lastEvent = { type: 'release', t };
    unnock(t, 'release');
    st.phase = 'ready';
  }

  function push(frame) {
    if (!isObj(frame) || !fin(frame.tMs)) return;
    const t = frame.tMs;
    if (st.lastT !== null && t < st.lastT - 1000) reset();       // время пошло назад (новая сессия)
    const dt = st.lastT === null ? 0 : clamp(t - st.lastT, 0, 250);
    st.lastT = t;
    st.counters.frames++;
    const L = frame.left, R = frame.right, body = frame.body;
    const inStance = st.phase !== 'idle';

    // ── левый кулак (лук)
    const zone = zoneOf(L, body, inStance);
    const forward = !L || !body || inStance || L.scale / body.sw >= cfg.fistForward;
    const fistNow = isFist(L, inStance) && zone === 'in' && forward;
    if (fistNow) {
      st.lastFist = L; st.fistLostAt = null;
      if (st.fistSince === null) st.fistSince = t;
      if (st.phase === 'idle' && t - st.fistSince >= cfg.readyMs) st.phase = 'ready';
    } else if (inStance) {
      if (st.fistLostAt === null) st.fistLostAt = t;
      if (t - st.fistLostAt > cfg.lostGraceMs) endStance(t);
    } else st.fistSince = null;
    const Lx = fistNow ? L : st.phase !== 'idle' ? st.lastFist : null;

    // ── правая щепоть
    if (st.phase === 'ready' && Lx) {
      const pinchNear = R && isPinch(R, false) && nockClose(Lx, R, body);
      if (pinchNear && fistNow) {
        if (st.nockSince === null) st.nockSince = t;
        if (t - st.nockSince >= cfg.nockMs) {
          st.phase = 'nocked'; st.nockedAt = t; st.active = true; st.pinchClosed = true;
          const sw = body && body.sw ? body.sw : Math.max(1e-6, Lx.scale) * 3.6;
          st.base = Math.max(cfg.drawBaseMin, dist2(R.pinchPt, Lx.center) / sw);
          st.ratio0 = clamp(Lx.scale / Math.max(1e-6, R.scale), 0.5, 2);
          st.draw = 0; st.drawRaw = 0; st.hist.length = 0;
          st.counters.nocks++;
          st.keepUntil = t + cfg.stanceKeepMs;
          st.lastEvent = { type: 'nock', t };
        }
      } else st.nockSince = null;
    }
    if (st.phase === 'nocked' || st.phase === 'drawing') {
      if (!R) {
        if (st.rightLostAt === null) st.rightLostAt = t;
        if (t - st.rightLostAt > cfg.lostGraceMs) unnock(t, 'cancel');
      } else {
        st.rightLostAt = null;
        // разжатая щепоть — выстрел (или «опустил тетиву», если натяжения не было). Натяжение кадра
        // выпуска не считаем: у раскрытой кисти «щепоть» (середина большого и указательного) прыгает.
        if (!isPinch(R, true)) fire(t);
        else {
          if (Lx) computeDraw(Lx, R, body, dt);
          if (st.phase === 'nocked' && st.draw >= cfg.minDraw) st.phase = 'drawing';
          // полное натяжение → заряд
          if (st.draw >= cfg.chargedOn) { if (st.fullSince === null) st.fullSince = t; if (t - st.fullSince >= cfg.chargedHoldMs) st.charged = true; }
          else if (st.draw < cfg.chargedOff) { st.fullSince = null; st.charged = false; }
          pushHist(t);
        }
      }
    }
    if (Lx && (st.phase !== 'idle')) computeAim(Lx, body, dt);

    // ── активность стойки (C2): только после наложения стрелы; держится между выстрелами
    if (st.phase === 'nocked' || st.phase === 'drawing') st.active = true;
    else if (st.phase === 'ready' && st.active) {
      const pinchNear = R && isPinch(R, false) && Lx && nockClose(Lx, R, body, 1.4);
      if (pinchNear) st.keepUntil = Math.max(st.keepUntil, t + 300);
      if (t > st.keepUntil) st.active = false;
    } else st.active = false;
    if (st.element && t > st.elementUntil) { st.element = null; st.elementRune = null; }

    // ── подсказки «ОШИБКА»
    const sw = body && body.sw ? body.sw : 0.3;
    let rSpeed = 0;
    if (R && st.prevR && dt > 0) rSpeed = dist2(R.center, st.prevR.center) / sw / (dt / 1000);
    st.prevR = R ? { center: { ...R.center } } : null;
    const still = rSpeed < cfg.hintStillSpeed;
    // щепоть у открытой левой ладони в зоне лука — «сожми кулак»
    const pinchAtOpen = !!(L && R && L.shape === 'open' && zone === 'in' && isPinch(R, false) && nockClose(L, R, body));
    if (since('fist', pinchAtOpen && still && st.phase === 'idle', t) >= cfg.hintFistMs) hint('bow_fist', t);
    // лук поднят, правая у кулака, но без щепоти — «сведи щепоть»
    const nearNoPinch = !!(st.phase === 'ready' && !st.active && R && Lx && !isPinch(R, true) && nockClose(Lx, { ...R, pinchPt: R.center }, body, 1.2) && (R.shape === 'open' || R.shape === 'other'));
    if (since('pinch', nearNoPinch && still, t) >= cfg.hintPinchMs) hint('bow_pinch', t);
    // стрела наложена, натяжения нет
    if (since('draw', st.phase === 'nocked' && st.draw < 0.15, t) >= cfg.hintDrawMs) hint('bow_draw', t);
    // натянуто и держится — «отпусти»
    if (since('release', (st.phase === 'drawing') && st.charged, t) >= cfg.hintReleaseMs) hint('bow_release', t);
    // кулак со щепотью, но ниже груди
    const low = !!(L && R && isFist(L, false) && zoneOf(L, body, false) === 'low' && isPinch(R, false) && nockClose(L, R, body));
    if (since('low', low, t) >= cfg.hintLowMs) hint('bow_low', t);
    // кулак со щепотью в зоне, но у самого тела — «вытяни вперёд»
    const back = !!(st.phase === 'idle' && L && R && !forward && isFist(L, false) && zone === 'in' && isPinch(R, false) && nockClose(L, R, body));
    if (since('forward', back, t) >= cfg.hintForwardMs) hint('bow_forward', t);
  }

  function view(now, consume) {
    const t = fin(now) ? now : st.lastT;
    const stale = st.lastT === null || (fin(t) && t - st.lastT > cfg.staleMs);
    const out = emptyBow();
    if (!stale) {
      out.active = st.active;
      out.phase = st.phase;
      out.draw = st.phase === 'nocked' || st.phase === 'drawing' ? clamp01(st.draw) : 0;
      out.aimX = st.aimX; out.aimY = st.aimY;
      out.charged = st.charged;
      out.element = st.element && (!fin(t) || t <= st.elementUntil) ? st.element : null;
      out.nocked = st.phase === 'nocked' || st.phase === 'drawing';
    }
    const p = st.pulse;
    if (p && (!fin(t) || t - p.t <= cfg.pulseTtlMs)) {
      out.release = true;
      out.draw = p.draw; out.charged = p.charged; out.aimX = p.aimX; out.aimY = p.aimY;
      out.rain = p.rain; out.rapid = p.rapid; out.element = p.element; out.rune = p.rune;
      out.active = true;
      if (consume) st.pulse = null;
    } else if (p && consume) st.pulse = null;
    if (st.hint) { out.hint = st.hint; if (consume) st.hint = null; }
    return out;
  }

  /** Руна, нарисованная при поднятом луке, заряжает следующую стрелу. true — руна «забрана» луком. */
  function offerRune(runeId, now) {
    const el = RUNE_ELEMENT[runeId];
    if (!el || st.phase === 'idle') return false;
    const t = fin(now) ? now : st.lastT || 0;
    st.element = el; st.elementRune = runeId; st.elementUntil = t + cfg.runeElementMs;
    st.counters.runes++;
    return true;
  }

  return {
    push,
    read: (now) => view(now, true),
    peek: (now) => view(now, false),
    offerRune,
    reset,
    configure(patch) { cfg = mergeConfig(cfg, patch); },
    get config() { return cfg; },
    getDebug() {
      return { version: BOW_VERSION, phase: st.phase, active: st.active, draw: st.draw, drawRaw: st.drawRaw, base: st.base, ratio0: st.ratio0, aimX: st.aimX, aimY: st.aimY, charged: st.charged, element: st.element, counters: { ...st.counters }, lastEvent: st.lastEvent };
    },
  };
}
