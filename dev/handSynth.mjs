// [HAND] Синтетика для тестов лука и магии рукой (dev/bow.test.mjs, dev/handMagic.test.mjs).
// Параметрическая кисть — та же, что в dev/handGestures.test.mjs (локальная система: ладонь в z=0,
// пальцы вдоль +y, камера смотрит вдоль +z; базовая раскладка — ЛЕВАЯ кисть ладонью к камере),
// плюс «сцена» игрока: корпус (центр и ширина плеч), запястья позы, 33 точки позы.
// Все позиции сцены задаются в координатах ПОКАЗА (зеркальное превью) в ширинах плеч от центра плеч:
// x — к правой руке игрока, y — вниз.

let seed = 12345;
export function reseed(s) { seed = s >>> 0 || 1; }
export const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
export const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
export const lerp = (a, b, k) => a + (b - a) * k;

const MCP = [[-0.034, 0.088], [-0.012, 0.094], [0.01, 0.089], [0.03, 0.078]];
const SEG = [[0.043, 0.025, 0.021], [0.047, 0.029, 0.022], [0.044, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [70, 95, 65];

function fingerChain(base, segs, curl, splay) {
  const pts = [];
  let p = { x: base[0], y: base[1], z: 0 };
  pts.push(p);
  let phi = 0;
  for (let j = 0; j < 3; j++) {
    phi += (curl * FLEX[j] * Math.PI) / 180;
    const d = { x: Math.sin(splay) * Math.cos(phi), y: Math.cos(splay) * Math.cos(phi), z: -Math.sin(phi) };
    p = { x: p.x + d.x * segs[j], y: p.y + d.y * segs[j], z: p.z + d.z * segs[j] };
    pts.push(p);
  }
  return pts;
}

/**
 * opts: side, curls [4] 0..1, thumb 'out'|'in'|'pinch'|'L', palm 'camera'|'away', roll, pitch, yaw (рад),
 *       cx, cy (центр ладони, НЕзеркальные нормализованные), size (доля высоты кадра), noise, aspect, spread (множитель разведения)
 */
export function makeHand(opts = {}) {
  const o = { side: 'right', curls: [0, 0, 0, 0], thumb: 'out', palm: 'camera', roll: 0, pitch: 0, yaw: 0, cx: 0.4, cy: 0.5, size: 0.14, noise: 0, aspect: 4 / 3, spread: 1, ...opts };
  const L = new Array(21);
  L[0] = { x: 0, y: 0, z: 0 };
  const splays = [0.12, 0.03, -0.06, -0.16].map((s) => s * o.spread);
  for (let f = 0; f < 4; f++) {
    const ch = fingerChain(MCP[f], SEG[f], o.curls[f], -splays[f]);
    for (let j = 0; j < 4; j++) L[5 + f * 4 + j] = ch[j];
  }
  const cmc = { x: -0.022, y: 0.018, z: -0.005 };
  let dirs;
  if (o.thumb === 'out') dirs = [{ x: -0.75, y: 0.62, z: -0.2 }, { x: -0.55, y: 0.8, z: -0.2 }, { x: -0.4, y: 0.9, z: -0.15 }];
  else if (o.thumb === 'L') dirs = [{ x: -0.95, y: 0.25, z: -0.1 }, { x: -1, y: 0.05, z: -0.05 }, { x: -1, y: -0.05, z: 0 }];
  else dirs = [{ x: -0.3, y: 0.6, z: -0.75 }, { x: 0.45, y: 0.55, z: -0.7 }, { x: 0.85, y: 0.3, z: -0.45 }];
  const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const tl = [0.032, 0.03, 0.026];
  L[1] = cmc;
  let p = cmc;
  for (let j = 0; j < 3; j++) { const d = norm(dirs[j]); p = { x: p.x + d.x * tl[j], y: p.y + d.y * tl[j], z: p.z + d.z * tl[j] }; L[2 + j] = p; }
  if (o.thumb === 'pinch') {
    const tip = L[8];
    const target = { x: tip.x - 0.004, y: tip.y - 0.004, z: tip.z - 0.003 };
    L[4] = target;
    L[3] = { x: (L[2].x + target.x) / 2 - 0.006, y: (L[2].y + target.y) / 2, z: (L[2].z + target.z) / 2 - 0.004 };
  }
  const tr = L.map((q) => {
    let x = q.x, y = q.y, z = q.z;
    if (o.side === 'right') x = -x;
    if (o.palm === 'away') { x = -x; z = -z; }
    const cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw);
    [x, z] = [x * cyw + z * syw, -x * syw + z * cyw];
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    const cr = Math.cos(o.roll), sr = Math.sin(o.roll);
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    return { x, y, z };
  });
  // центр ладони (среднее 0,5,9,13,17) ставим в (cx, cy)
  let px = 0, py = 0;
  for (const k of [0, 5, 9, 13, 17]) { px += tr[k].x / 5; py += tr[k].y / 5; }
  const scale = o.size / 0.09;
  const n = o.noise * o.size;
  const img = tr.map((q) => ({
    x: o.cx + ((q.x - px) * scale) / o.aspect + (n ? gauss() * n / o.aspect : 0),
    y: o.cy - (q.y - py) * scale + (n ? gauss() * n : 0),
    z: q.z * scale,
  }));
  let mx = 0, my = 0, mz = 0;
  for (const q of tr) { mx += q.x; my += q.y; mz += q.z; }
  mx /= 21; my /= 21; mz /= 21;
  const wn = o.noise * 0.09;
  const world = tr.map((q) => ({ x: q.x - mx + (wn ? gauss() * wn * 0.5 : 0), y: -(q.y - my) + (wn ? gauss() * wn * 0.5 : 0), z: q.z - mz + (wn ? gauss() * wn * 0.5 : 0) }));
  return { landmarks: img, world, handedness: o.side === 'right' ? 'Right' : 'Left', score: 0.95 };
}

// Формы
export const SHAPES = {
  open: { curls: [0, 0, 0, 0], thumb: 'out' },
  fist: { curls: [1, 1, 1, 1], thumb: 'in' },
  point: { curls: [0, 1, 1, 1], thumb: 'in' },
  victory: { curls: [0, 0, 1, 1], thumb: 'in' },
  ok: { curls: [0.45, 0, 0, 0], thumb: 'pinch' },
  pinch: { curls: [0.45, 0.85, 0.9, 0.9], thumb: 'pinch' },   // щепоть лучника: большой и указательный вместе, остальные поджаты
  pinchOpen: { curls: [0.15, 0.6, 0.7, 0.7], thumb: 'out' },  // разжатая щепоть (после выстрела)
  claw: { curls: [0.55, 0.55, 0.55, 0.55], thumb: 'out', spread: 1.8 },
};

/**
 * Сцена игрока. body: центр плеч в НЕзеркальном кадре (0..1), sw — ширина плеч в высотах кадра.
 * at(x, y) — позиция в координатах показа (ширины плеч от центра плеч; x к правой руке игрока) → {cx, cy} НЕзеркальные.
 */
export function makeScene(o = {}) {
  const S = { cx: 0.5, cy: 0.42, sw: 0.3, aspect: 4 / 3, frameW: 640, frameH: 480, ...o };
  S.at = (x, y) => ({ cx: S.cx - (x * S.sw) / S.aspect, cy: S.cy + y * S.sw });
  S.pose = (extra = {}) => {
    const P = new Array(33).fill(null).map(() => ({ x: S.cx, y: S.cy + 0.6, z: 0, visibility: 0.2 }));
    const put = (i, x, y, vis = 0.95) => { const q = S.at(x, y); P[i] = { x: q.cx, y: q.cy, z: 0, visibility: vis }; };
    put(11, -0.5, 0); put(12, 0.5, 0);          // плечи: 11 — левое игрока (в показе слева)
    put(7, -0.18, -0.55); put(8, 0.18, -0.55);  // уши
    put(0, 0, -0.6);
    if (extra.lw) put(15, extra.lw.x, extra.lw.y); else put(15, -0.6, 1.6, 0.3);
    if (extra.rw) put(16, extra.rw.x, extra.rw.y); else put(16, 0.6, 1.6, 0.3);
    return P;
  };
  return S;
}

/** Кисть в позиции сцены (координаты показа в ширинах плеч). */
export function handAt(S, side, x, y, shape, extra = {}) {
  const q = S.at(x, y);
  const sh = typeof shape === 'string' ? SHAPES[shape] : shape;
  return makeHand({ side, aspect: S.aspect, size: 0.075, ...sh, ...extra, cx: q.cx, cy: q.cy });
}

/** Наблюдение как у modules/vision.js → handGestures.push(obs). hands: {left, right} (кисти makeHand) или массив. */
export function obsOf(S, t, hands) {
  const arr = Array.isArray(hands) ? hands : [hands.left, hands.right].filter(Boolean);
  const wr = (h) => (h ? { x: h.landmarks[0].x, y: h.landmarks[0].y, visibility: 0.9 } : null);
  const poseWrists = Array.isArray(hands) ? null : { left: wr(hands.left), right: wr(hands.right) };
  return {
    tMs: t, frameW: S.frameW, frameH: S.frameH, mirror: true, hands: arr,
    poseWrists, bodyCenter: { x: S.cx, y: S.cy }, shoulderWidth: S.sw,
  };
}
