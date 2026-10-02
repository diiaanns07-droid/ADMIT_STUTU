// ASHEN OATH — [W3-SPIRIT] Дух игрока: огромный полупрозрачный силуэт из света, который в реальном
// времени повторяет руки игрока — плечи, локти, кисти и все пальцы. Жюри сразу видит: игра видит меня
// целиком, до пальца.
//
// Данные (main.js раз в кадр зовёт frame()):
//   vision.getPose()  — 33 точки, заполнены COMPACT_INDICES (0, 7, 8, 11–16, 23–28); СЫРЫЕ — x не зеркален;
//   vision.getHands() — core/handGestures.js: left/right — стороны ИГРОКА, landmarks — 21 точка в
//                       координатах ПОКАЗА (уже зеркальные, только x/y; глубину кисти берём у запястья позы).
// Зеркало как на превью камеры (core/trackingHud.js): игрок поднял левую руку — на экране поднялась рука
// с той же стороны.
//
// Координаты тела («b»): центр плеч (0, 0), ширина плеч = 1, x — вправо на экране, y — вверх,
// z < 0 — к веб-камере (вперёд от игрока). Сглаживание: One-Euro на частоте распознавания (15–30 Гц:
// в покое не дрожит, в рывке не отстаёт) + экспоненциальная интерполяция на частоте кадра (без ступенек).
//
// Где виден:
//   «в кадре» — экраны камеры, калибровки и обучения: свой WebGL-холст в слоте превью камеры, дух совмещён
//               с телом игрока на видео («я тебя вижу»); 3D-сцену там закрывают панели интерфейса.
//               В режиме презентации P превью крупное и в бою — дух в нём тоже, ярче.
//   «над аренной» — бой и пауза: 13–16 м, полупрозрачно в небе справа от Регента (за ним по глубине —
//               Регента он никогда не закрывает), к нам спиной, как тень игрока над ареной.
//   Трекинг потерян — плавно гаснет. Интро, меню, итоги — скрыт.
// Реакции: распознанный жест — вспышка и кольцо на нужной руке цветом стихии героя; подсказка «ОШИБКА» —
// короткая красная вспышка на этой руке; щит — купол в ладони; заряд ладонями (player.sigilCharge; пока
// его нет — сфера/призма двумя руками) — сфера и молнии между ладонями, а ось растяжения (player.sigilAxis:
// 'h' — «Врата бури», 'v' — «Столп небес») — щель света между ладонями; каст (событие 'sigil_cast') —
// вспышка и щель во весь размах. Ультимейт «Небесный суд»: 'ultimate_ready' — нимб зовёт «руки вверх»,
// 'ultimate_start' — дух поднимает руки и вспыхивает (держит их, пока идёт сцена), 'ultimate_strike' —
// удар, 'ultimate_end' — выдох; без шкалы ультимейта — по рукам вверх ~0,5 с. Над ареной дух всегда дальше
// и героя, и Регента — облёт камеры его не ставит между камерой и героем; во время сцены он приглушён.
// «Уменьшенное движение» — без шлейфа, мерцания молний и пульсаций.
// Качество 'low' — линии и точки стандартных материалов, без шлейфа (3 вызова отрисовки).
// В «Отладке с клавиатуры» дух двигают синтетические руки (модель кисти как в dev/handSynth.mjs):
// пальцы «считают» 1–5, клавиши J/K/L/O/P/U/I/F/Z… показывают жесты.

export const SPIRIT_SW = 3.6;          // ширина плеч духа над ареной, м (на дистанции 20 м): 10 м, руки вверх — ~15 м
export const HAND_BONES = Object.freeze([[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]]);
const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];

// суставы духа: тело, кисть игрока слева на экране (HL + 0..20), справа (HR + 0..20)
export const J = Object.freeze({ HEAD: 0, LS: 1, RS: 2, LE: 3, RE: 4, LW: 5, RW: 6, NECK: 7, PELVIS: 8, LH: 9, RH: 10, HL: 11, HR: 32, COUNT: 53 });
const N = J.COUNT;
const G_BODY = 0, G_ARM_L = 1, G_ARM_R = 2, G_HAND_L = 3, G_HAND_R = 4;

// кости: [a, b, радиус (b), группа, яркость у a, яркость у b]
const BONES = [];
{
  const bone = (a, b, r, g, ea = 1, eb = 1) => BONES.push([a, b, r, g, ea, eb]);
  bone(J.LS, J.RS, 0.07, G_BODY, 0.9, 0.9);
  bone(J.NECK, J.HEAD, 0.075, G_BODY, 1, 0.35);
  bone(J.LS, J.LE, 0.1, G_ARM_L); bone(J.LE, J.LW, 0.085, G_ARM_L);
  bone(J.RS, J.RE, 0.1, G_ARM_R); bone(J.RE, J.RW, 0.085, G_ARM_R);
  bone(J.NECK, J.PELVIS, 0.035, G_BODY, 0.75, 0);     // позвоночник света; корпус — дымка, растворяется книзу
  for (const [base, g] of [[J.HL, G_HAND_L], [J.HR, G_HAND_R]]) {
    for (const [a, b] of HAND_BONES) {
      const palm = a === 0 || (a === 5 && b === 9) || (a === 9 && b === 13) || (a === 13 && b === 17);
      bone(base + a, base + b, palm ? 0.034 : TIPS.includes(b) ? 0.022 : 0.027, g, 1, TIPS.includes(b) ? 1.15 : 1);
    }
  }
}
const NB = BONES.length;
const B_A = Int16Array.from(BONES, (b) => b[0]), B_B = Int16Array.from(BONES, (b) => b[1]);
const B_R = Float32Array.from(BONES, (b) => b[2]), B_G = Uint8Array.from(BONES, (b) => b[3]);
const B_EA = Float32Array.from(BONES, (b) => b[4]), B_EB = Float32Array.from(BONES, (b) => b[5]);
const HEAD_SEG = 16;                     // окружность головы в упрощённом виде
const RINGS = 8;                         // волны вспышек (плюс нимб над головой)
const VIS_IDX = [0, 11, 12, 13, 14, 15, 16];
const ARM_JOINTS = [J.LE, J.RE, J.LW, J.RW];

// огоньки суставов: размер (b), усиление, группа
const PT_SIZE = new Float32Array(N), PT_GAIN = new Float32Array(N), PT_GROUP = new Uint8Array(N);
{
  const set = (j, s, g, grp) => { PT_SIZE[j] = s; PT_GAIN[j] = g; PT_GROUP[j] = grp; };
  set(J.LS, 0.26, 1, G_ARM_L); set(J.RS, 0.26, 1, G_ARM_R);
  set(J.LE, 0.22, 1, G_ARM_L); set(J.RE, 0.22, 1, G_ARM_R);
  set(J.LW, 0.23, 1.1, G_ARM_L); set(J.RW, 0.23, 1.1, G_ARM_R);
  set(J.NECK, 0.15, 0.8, G_BODY);
  for (const [base, g] of [[J.HL, G_HAND_L], [J.HR, G_HAND_R]]) {
    for (let i = 1; i < 21; i++) {
      const tip = TIPS.includes(i), knuckle = i === 1 || i === 5 || i === 9 || i === 13 || i === 17;
      set(base + i, tip ? 0.11 : knuckle ? 0.075 : 0.06, tip ? 1.6 : 1, g);
    }
  }
}

// дымка духа: мягкие пятна света вдоль тела — объём «из света» (bloom их подхватывает)
// [сустав a, сустав b, доля a→b, размер (b), яркость, группа]
const AURA = [
  [J.NECK, J.PELVIS, 0.12, 1.45, 0.12, G_BODY], [J.NECK, J.PELVIS, 0.4, 1.6, 0.095, G_BODY],
  [J.NECK, J.PELVIS, 0.7, 1.85, 0.065, G_BODY], [J.NECK, J.PELVIS, 1.0, 2.3, 0.04, G_BODY],
  [J.LS, J.RS, 0.12, 0.75, 0.07, G_BODY], [J.LS, J.RS, 0.88, 0.75, 0.07, G_BODY],
  [J.NECK, J.HEAD, 1.0, 1.15, 0.075, G_BODY],
  [J.LS, J.LE, 0.3, 0.58, 0.07, G_ARM_L], [J.LS, J.LE, 0.75, 0.55, 0.07, G_ARM_L], [J.LE, J.LW, 0.3, 0.5, 0.07, G_ARM_L], [J.LE, J.LW, 0.75, 0.48, 0.07, G_ARM_L],
  [J.RS, J.RE, 0.3, 0.58, 0.07, G_ARM_R], [J.RS, J.RE, 0.75, 0.55, 0.07, G_ARM_R], [J.RE, J.RW, 0.3, 0.5, 0.07, G_ARM_R], [J.RE, J.RW, 0.75, 0.48, 0.07, G_ARM_R],
  [J.HL, J.HL + 9, 0.75, 0.8, 0.11, G_HAND_L], [J.HR, J.HR + 9, 0.75, 0.8, 0.11, G_HAND_R],
];
const NA = AURA.length;
const AU_A = Int16Array.from(AURA, (a) => a[0]), AU_B = Int16Array.from(AURA, (a) => a[1]), AU_T = Float32Array.from(AURA, (a) => a[2]);
const AU_S = Float32Array.from(AURA, (a) => a[3]), AU_K = Float32Array.from(AURA, (a) => a[4]), AU_G = Uint8Array.from(AURA, (a) => a[5]);

// шлейф-призрак: кончики пяти пальцев каждой кисти и запястья
const TRAIL_J = [...TIPS.map((i) => J.HL + i), ...TIPS.map((i) => J.HR + i), J.LW, J.RW];
const NT = TRAIL_J.length;
const NS_MAX = 20;
const QUALITY = {
  low: { full: false, trail: 0 },
  medium: { full: true, trail: 12 },
  high: { full: true, trail: 20 },
};

// экраны
const FRAME_SCREENS = new Set(['camera', 'calibration', 'tutorial']);   // дух в превью камеры
const SKY_SCREENS = new Set(['playing', 'paused']);                    // дух над ареной
const PRESENT_SLOT_SCREENS = new Set(['playing', 'paused']);           // P: крупное превью и в бою

// цвета (sRGB hex)
const COL_BASE = 0x8fd6ff, COL_LEFT = 0x6fb6ff, COL_RIGHT = 0xffb46e, COL_MISTAKE = 0xff3d3d, COL_FALLBACK = 0xff7a2a;

const DEPTH_K = 0.6;                     // глубина позы MediaPipe шумная — в духе она приглушена
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v) => typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
const approach = (v, target, dt, tIn, tOut) => {
  const tau = target > v ? tIn : tOut;
  return v + (target - v) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
};

// ------------------------------------------------------------------ модель кисти (как dev/handSynth.mjs)
// Локальная система: ладонь в z=0, пальцы вдоль +y, камера смотрит вдоль +z; базовая раскладка —
// ЛЕВАЯ кисть ладонью к камере в незеркальном кадре. Выход — координаты тела (зеркально, как показ).
const MCP = [[-0.034, 0.088], [-0.012, 0.094], [0.01, 0.089], [0.03, 0.078]];
const SEG = [[0.043, 0.025, 0.021], [0.047, 0.029, 0.022], [0.044, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [70, 95, 65];
const SPLAY = [0.12, 0.03, -0.06, -0.16];
const THUMB_OUT = [[-0.75, 0.62, -0.2], [-0.55, 0.8, -0.2], [-0.4, 0.9, -0.15]];
const THUMB_IN = [[-0.3, 0.6, -0.75], [0.45, 0.55, -0.7], [0.85, 0.3, -0.45]];
const THUMB_LEN = [0.032, 0.03, 0.026];
const HAND_K = 2.6;                      // единицы модели → ширины плеч (ладонь ≈ 0,24 ширины плеч)
const _lx = new Float32Array(21), _ly = new Float32Array(21), _lz = new Float32Array(21);

/**
 * Кисть в координатах тела. h: { x, y, z — запястье; ang — поворот (0 — пальцы вверх, π — вниз);
 * curls[4] 0..1; thumbIn 0..1; pinch 0..1; away — ладонь от камеры }. out[o + i*3] — 21 точка.
 */
export function buildHand(out, o, side, h) {
  _lx[0] = 0; _ly[0] = 0; _lz[0] = 0;
  for (let f = 0; f < 4; f++) {
    const curl = clamp(h.curls[f], 0, 1), splay = -SPLAY[f];
    let x = MCP[f][0], y = MCP[f][1], z = 0, phi = 0;
    const k0 = 5 + f * 4;
    _lx[k0] = x; _ly[k0] = y; _lz[k0] = z;
    for (let j = 0; j < 3; j++) {
      phi += (curl * FLEX[j] * Math.PI) / 180;
      x += Math.sin(splay) * Math.cos(phi) * SEG[f][j];
      y += Math.cos(splay) * Math.cos(phi) * SEG[f][j];
      z += -Math.sin(phi) * SEG[f][j];
      _lx[k0 + 1 + j] = x; _ly[k0 + 1 + j] = y; _lz[k0 + 1 + j] = z;
    }
  }
  const ti = clamp(h.thumbIn || 0, 0, 1);
  let x = -0.022, y = 0.018, z = -0.005;
  _lx[1] = x; _ly[1] = y; _lz[1] = z;
  for (let j = 0; j < 3; j++) {
    const a = THUMB_OUT[j], b = THUMB_IN[j];
    const dx = a[0] + (b[0] - a[0]) * ti, dy = a[1] + (b[1] - a[1]) * ti, dz = a[2] + (b[2] - a[2]) * ti;
    const l = Math.hypot(dx, dy, dz) || 1;
    x += (dx / l) * THUMB_LEN[j]; y += (dy / l) * THUMB_LEN[j]; z += (dz / l) * THUMB_LEN[j];
    _lx[2 + j] = x; _ly[2 + j] = y; _lz[2 + j] = z;
  }
  const pinch = clamp(h.pinch || 0, 0, 1);
  if (pinch > 0) {                       // щепоть / «OK»: кончик большого — к кончику указательного
    const tx = _lx[8] - 0.004, ty = _ly[8] - 0.004, tz = _lz[8] - 0.003;
    _lx[4] += (tx - _lx[4]) * pinch; _ly[4] += (ty - _ly[4]) * pinch; _lz[4] += (tz - _lz[4]) * pinch;
    const mx = (_lx[2] + _lx[4]) / 2 - 0.006, my = (_ly[2] + _ly[4]) / 2, mz = (_lz[2] + _lz[4]) / 2 - 0.004;
    _lx[3] += (mx - _lx[3]) * pinch; _ly[3] += (my - _ly[3]) * pinch; _lz[3] += (mz - _lz[3]) * pinch;
  }
  // правая — зеркально; ладонь от камеры — разворот; показ — зеркальный кадр
  const sx = (side === 'right' ? -1 : 1) * (h.away ? -1 : 1) * -1, sz = h.away ? -1 : 1;
  const c = Math.cos(h.ang || 0), s = Math.sin(h.ang || 0);
  for (let i = 0; i < 21; i++) {
    const px = _lx[i] * sx, py = _ly[i];
    out[o + i * 3] = h.x + (px * c - py * s) * HAND_K;
    out[o + i * 3 + 1] = h.y + (px * s + py * c) * HAND_K;
    out[o + i * 3 + 2] = h.z + _lz[i] * sz * HAND_K;
  }
}

// Локоть по плечу и запястью (точки локтя нет — сидя у ноутбука локти обычно ниже кадра): локоть «висит»
// вниз и чуть наружу, а если запястье так не достать — двухзвенная ИК ближе к висящему положению.
const UPPER = 0.82, FORE = 0.74;
function solveElbow(P, s, w, e, sign) {
  const sx = P[s * 3], sy = P[s * 3 + 1], sz = P[s * 3 + 2];
  const wx = P[w * 3], wy = P[w * 3 + 1];
  const dx = wx - sx, dy = wy - sy, dz = P[w * 3 + 2] - sz;
  const d = Math.hypot(dx, dy) || 1e-6;
  let ex = sx + sign * 0.24 * UPPER, ey = sy - 0.97 * UPPER;
  if (Math.hypot(ex - wx, ey - wy) > FORE) {
    if (d >= UPPER + FORE - 0.02) { ex = sx + (dx / d) * UPPER; ey = sy + (dy / d) * UPPER; }
    else {
      const a = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
      const bx = sx + (dx / d) * a, by = sy + (dy / d) * a, nx = -dy / d, ny = dx / d;
      const x1 = bx + nx * h, y1 = by + ny * h, x2 = bx - nx * h, y2 = by - ny * h;
      const pick1 = Math.hypot(x1 - ex, y1 - ey) <= Math.hypot(x2 - ex, y2 - ey);
      ex = pick1 ? x1 : x2; ey = pick1 ? y1 : y2;
    }
  }
  P[e * 3] = ex; P[e * 3 + 1] = ey; P[e * 3 + 2] = sz + dz * 0.5;
}

// поза покоя (руки опущены, кисти расслаблены) и поза «руки вверх» (ультимейт)
function makePose(kind) {
  const P = new Float32Array(N * 3);
  const put = (j, x, y, z = 0) => { P[j * 3] = x; P[j * 3 + 1] = y; P[j * 3 + 2] = z; };
  put(J.HEAD, 0, 0.82); put(J.LS, -0.5, 0); put(J.RS, 0.5, 0); put(J.NECK, 0, 0);
  put(J.PELVIS, 0, -1.45); put(J.LH, -0.32, -1.42); put(J.RH, 0.32, -1.42);
  const up = kind === 'up';
  put(J.LW, up ? -0.62 : -0.62, up ? 1.95 : -1.48, up ? -0.1 : 0);
  put(J.RW, up ? 0.62 : 0.62, up ? 1.95 : -1.48, up ? -0.1 : 0);
  solveElbow(P, J.LS, J.LW, J.LE, -1); solveElbow(P, J.RS, J.RW, J.RE, 1);
  const curls = up ? [0, 0, 0, 0] : [0.28, 0.32, 0.36, 0.4];
  buildHand(P, J.HL * 3, 'left', { x: P[J.LW * 3], y: P[J.LW * 3 + 1], z: P[J.LW * 3 + 2], ang: up ? 0.12 : Math.PI - 0.1, curls, thumbIn: up ? 0 : 0.35 });
  buildHand(P, J.HR * 3, 'right', { x: P[J.RW * 3], y: P[J.RW * 3 + 1], z: P[J.RW * 3 + 2], ang: up ? -0.12 : -Math.PI + 0.1, curls, thumbIn: up ? 0 : 0.35 });
  return P;
}

// ------------------------------------------------------------------ шейдеры
const BONE_VS = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aEnds;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
varying vec2 vE;
varying float vS;
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
  vV = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
  vS = position.y;
  vE = aEnds;
  vC = aColor;
  gl_Position = projectionMatrix * mv;
}`;
// кость: неоновая трубка — яркая кромка (френель) и тонкая сердцевина, по кости бежит свет
const BONE_FS = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform float uFlow;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
varying vec2 vE;
varying float vS;
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.0);
  float core = pow(ndv, 7.0);
  float flow = 1.0 - uFlow + uFlow * (0.55 + 0.45 * sin(vS * 6.2832 - uTime * 4.2));
  float a = mix(vE.x, vE.y, vS) * uOpacity;
  float lum = dot(vC, vec3(0.3333));
  vec3 c = vC * (0.1 + 1.9 * rim * flow + 0.55 * core) + vec3(lum * 0.45 * pow(1.0 - ndv, 4.0));
  gl_FragColor = vec4(c * a, 1.0);
  #include <colorspace_fragment>
}`;
// световой «рукав»: та же кость, шире в uGlowR раз; ярче по оси, к краям гаснет — объём без bloom
const GLOW_VS = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aEnds;
attribute float aGlow;
uniform float uGlowR;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
varying vec2 vE;
varying float vS;
void main() {
  vec3 p = vec3(position.x * uGlowR, position.y, position.z * uGlowR);
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
  vV = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
  vS = position.y;
  vE = aEnds * aGlow;
  vC = aColor;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = /* glsl */ `
uniform float uOpacity;
uniform float uGlowK;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
varying vec2 vE;
varying float vS;
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float g = pow(ndv, 2.2) * smoothstep(0.0, 0.2, vS) * (1.0 - smoothstep(0.8, 1.0, vS));
  float a = mix(vE.x, vE.y, vS) * uOpacity * uGlowK;
  gl_FragColor = vec4(vC * (g * a), 1.0);
  #include <colorspace_fragment>
}`;
// сфера (голова, заряд между ладонями): кромка + ядро
const ORB_FS = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying vec3 vC;
varying vec2 vE;
varying float vS;
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.3);
  float core = pow(ndv, 2.6);
  float swirl = 0.85 + 0.15 * sin(vS * 9.0 + uTime * 3.0);
  vec3 c = vC * (vE.x * rim * 1.8 * swirl + vE.y * core + 0.03);
  gl_FragColor = vec4(c * uOpacity, 1.0);
  #include <colorspace_fragment>
}`;
const PTS_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uPx;
uniform float uScale;
varying vec3 vC;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = isOrthographic ? 1.0 : max(0.05, -mv.z);
  gl_PointSize = clamp(aSize * uScale * uPx / d, 0.0, 256.0);
  vC = aColor;
}`;
// огонёк сустава: мягкое гало + горячая точка
const SPARK_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vC;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 5.0) * 0.5 + exp(-r2 * 32.0) * 0.95;
  gl_FragColor = vec4(vC * (g * uOpacity), 1.0);
  #include <colorspace_fragment>
}`;
// дымка: широкое мягкое пятно без горячей точки
const AURA_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vC;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float g = exp(-r2 * 3.2) - 0.04;
  gl_FragColor = vec4(vC * (max(g, 0.0) * uOpacity), 1.0);
  #include <colorspace_fragment>
}`;
// кольцо: нимб над головой и волна вспышки на ладони
const RING_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vC;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ring = smoothstep(0.58, 0.84, r) * (1.0 - smoothstep(0.84, 1.0, r));
  float fill = (1.0 - r) * 0.1;
  gl_FragColor = vec4(vC * ((ring + fill) * uOpacity), 1.0);
  #include <colorspace_fragment>
}`;
// шлейф: лента, развёрнутая к камере в вершинном шейдере
const TRAIL_VS = /* glsl */ `
attribute vec3 aTan;
attribute float aSide;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vC;
varying float vS;
void main() {
  vC = aColor;
  vS = sign(aSide);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = (modelViewMatrix * vec4(aTan, 0.0)).xyz;
  vec3 vd = isOrthographic ? vec3(0.0, 0.0, -1.0) : normalize(mv.xyz);
  vec3 sd = cross(tv, vd);
  float l = length(sd);
  sd = l > 1e-6 ? sd / l : vec3(1.0, 0.0, 0.0);
  mv.xyz += sd * (aSide * uScale);
  gl_Position = projectionMatrix * mv;
}`;
const TRAIL_FS = /* glsl */ `
uniform float uOpacity;
varying vec3 vC;
varying float vS;
void main() {
  float a = 1.0 - vS * vS;
  gl_FragColor = vec4(vC * (uOpacity * (0.3 * a + 0.8 * a * a * a)), 1.0);
  #include <colorspace_fragment>
}`;
const SHIELD_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;
// купол щита в ладони: френель, сетка рун и бегущая волна; удар по щиту — вспышка
const SHIELD_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
uniform float uHit;
varying vec3 vN;
varying vec3 vV;
varying vec2 vUv;
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float rim = pow(1.0 - ndv, 2.2);
  float g1 = abs(fract(vUv.x * 16.0) - 0.5), g2 = abs(fract(vUv.y * 5.0 - uTime * 0.35) - 0.5);
  float grid = smoothstep(0.43, 0.5, max(g1, g2));
  float wave = 1.0 - smoothstep(0.0, 0.07, abs(vUv.y - fract(uTime * 0.8)));
  vec3 c = uColor * (0.05 + 1.25 * rim + 0.3 * grid + 0.5 * wave + 1.4 * uHit * (1.0 - vUv.y));
  gl_FragColor = vec4(c * uAlpha, 1.0);
  #include <colorspace_fragment>
}`;

function palmOf(P, base, out) {
  out[0] = out[1] = out[2] = 0;
  for (let k = 0; k < PALM.length; k++) { const o = (base + PALM[k]) * 3; out[0] += P[o] / 5; out[1] += P[o + 1] / 5; out[2] += P[o + 2] / 5; }
}

// ------------------------------------------------------------------ визуальный «скелет» (один на сцену)
// Одна сборка рисует состояние духа в своей сцене: над ареной (камера игры) и в превью (свой холст).
function createRig(THREE, name) {
  const root = new THREE.Group();
  root.name = name;
  const owned = [];                     // всё, что освобождается в dispose()
  const own = (x) => (owned.push(x), x);
  const U = {
    uTime: { value: 0 }, uOpacity: { value: 1 }, uFlow: { value: 1 },
    uPx: { value: 600 }, uScale: { value: 1 },
  };
  const DYN = THREE.DynamicDrawUsage;
  const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false };
  const mats = [];                      // материалы с depthTest, зависящим от сцены
  const M = (m) => (mats.push(m), own(m));
  const attr = (n, k, usage = DYN) => new THREE.BufferAttribute(new Float32Array(n * k), k).setUsage(usage);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Euler();
  const UP = new THREE.Vector3(0, 1, 0);
  const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
  let full = null, low = null, tier = null;

  function buildFull() {
    const group = new THREE.Group(); group.name = `${name}-full`;
    // кости — одна инстанс-отрисовка сужающихся трубок
    const boneGeo = own(new THREE.CylinderGeometry(0.8, 1, 1, 10, 1, true));
    boneGeo.translate(0, 0.5, 0);
    const bCol = new THREE.InstancedBufferAttribute(new Float32Array(NB * 3), 3).setUsage(DYN);
    const bEnd = new THREE.InstancedBufferAttribute(new Float32Array(NB * 2), 2);
    for (let k = 0; k < NB; k++) { bEnd.array[k * 2] = BONES[k][4]; bEnd.array[k * 2 + 1] = BONES[k][5]; }
    boneGeo.setAttribute('aColor', bCol); boneGeo.setAttribute('aEnds', bEnd);
    // «рукав» — только у костей кистей: короткие кости перекрываются, у длинных края рукава заметны (там — дымка)
    boneGeo.setAttribute('aGlow', new THREE.InstancedBufferAttribute(Float32Array.from(BONES, (b) => (b[3] >= G_HAND_L ? 1 : 0)), 1));
    const boneMat = M(new THREE.ShaderMaterial({ name: 'spirit-bone', uniforms: { uTime: U.uTime, uOpacity: U.uOpacity, uFlow: U.uFlow }, vertexShader: BONE_VS, fragmentShader: BONE_FS, ...ADD }));
    const bones = own(new THREE.InstancedMesh(boneGeo, boneMat, NB));
    bones.instanceMatrix.setUsage(DYN); bones.frustumCulled = false; bones.renderOrder = 6;
    const glowMat = M(new THREE.ShaderMaterial({ name: 'spirit-glow', uniforms: { uOpacity: U.uOpacity, uGlowR: { value: 2.8 }, uGlowK: { value: 0.22 } }, vertexShader: GLOW_VS, fragmentShader: GLOW_FS, side: THREE.BackSide, ...ADD }));
    const glow = own(new THREE.InstancedMesh(boneGeo, glowMat, NB));
    glow.instanceMatrix = bones.instanceMatrix;           // те же матрицы костей — без второй записи
    glow.frustumCulled = false; glow.renderOrder = 5;
    // голова и сфера заряда
    const orbGeo = own(new THREE.IcosahedronGeometry(1, 2));
    const oCol = new THREE.InstancedBufferAttribute(new Float32Array(2 * 3), 3).setUsage(DYN);
    const oEnd = new THREE.InstancedBufferAttribute(new Float32Array([1.25, 0.06, 0.9, 1.5]), 2);
    orbGeo.setAttribute('aColor', oCol); orbGeo.setAttribute('aEnds', oEnd);
    const orbMat = M(new THREE.ShaderMaterial({ name: 'spirit-orb', uniforms: { uTime: U.uTime, uOpacity: U.uOpacity }, vertexShader: BONE_VS, fragmentShader: ORB_FS, ...ADD }));
    const orbs = own(new THREE.InstancedMesh(orbGeo, orbMat, 2));
    orbs.instanceMatrix.setUsage(DYN); orbs.frustumCulled = false; orbs.renderOrder = 6;
    // нимб над головой — наклонное кольцо (тот же шейдер сферы)
    const haloGeo = own(new THREE.TorusGeometry(1, 0.05, 6, 48));
    const hCol = new THREE.InstancedBufferAttribute(new Float32Array(3), 3).setUsage(DYN);
    haloGeo.setAttribute('aColor', hCol); haloGeo.setAttribute('aEnds', new THREE.InstancedBufferAttribute(new Float32Array([0.7, 1.2]), 2));
    const halo = own(new THREE.InstancedMesh(haloGeo, orbMat, 1));
    halo.instanceMatrix.setUsage(DYN); halo.frustumCulled = false; halo.renderOrder = 6;
    // огоньки суставов
    const jGeo = own(new THREE.BufferGeometry());
    jGeo.setAttribute('position', attr(N, 3)); jGeo.setAttribute('aColor', attr(N, 3)); jGeo.setAttribute('aSize', attr(N, 1));
    const ptsU = { uOpacity: U.uOpacity, uPx: U.uPx, uScale: U.uScale };
    const jMat = M(new THREE.ShaderMaterial({ name: 'spirit-spark', uniforms: ptsU, vertexShader: PTS_VS, fragmentShader: SPARK_FS, ...ADD }));
    const joints = new THREE.Points(jGeo, jMat); joints.frustumCulled = false; joints.renderOrder = 7;
    // дымка вдоль тела
    const auGeo = own(new THREE.BufferGeometry());
    auGeo.setAttribute('position', attr(NA, 3)); auGeo.setAttribute('aColor', attr(NA, 3)); auGeo.setAttribute('aSize', attr(NA, 1));
    const auMat = M(new THREE.ShaderMaterial({ name: 'spirit-aura', uniforms: ptsU, vertexShader: PTS_VS, fragmentShader: AURA_FS, ...ADD }));
    const aura = new THREE.Points(auGeo, auMat); aura.frustumCulled = false; aura.renderOrder = 4;
    // кольца: нимб + волны вспышек
    const rGeo = own(new THREE.BufferGeometry());
    rGeo.setAttribute('position', attr(RINGS + 1, 3)); rGeo.setAttribute('aColor', attr(RINGS + 1, 3)); rGeo.setAttribute('aSize', attr(RINGS + 1, 1));
    const rMat = M(new THREE.ShaderMaterial({ name: 'spirit-ring', uniforms: ptsU, vertexShader: PTS_VS, fragmentShader: RING_FS, ...ADD }));
    const rings = new THREE.Points(rGeo, rMat); rings.frustumCulled = false; rings.renderOrder = 7;
    // шлейф-призрак: ленты кончиков пальцев и запястий, одна отрисовка
    const TV = NT * NS_MAX * 2;
    const tGeo = own(new THREE.BufferGeometry());
    tGeo.setAttribute('position', attr(TV, 3)); tGeo.setAttribute('aTan', attr(TV, 3));
    tGeo.setAttribute('aColor', attr(TV, 3)); tGeo.setAttribute('aSide', attr(TV, 1));
    const idx = [];
    for (let t = 0; t < NT; t++) for (let i = 0; i < NS_MAX - 1; i++) { const v = (t * NS_MAX + i) * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    tGeo.setIndex(idx);
    const tMat = M(new THREE.ShaderMaterial({ name: 'spirit-trail', uniforms: { uOpacity: U.uOpacity, uScale: U.uScale }, vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, side: THREE.DoubleSide, ...ADD }));
    const trails = new THREE.Mesh(tGeo, tMat); trails.frustumCulled = false; trails.renderOrder = 5;
    // купол щита: полусфера выпуклостью вперёд (−z — к веб-камере игрока)
    const sGeo = own(new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI * 0.5));
    sGeo.rotateX(-Math.PI / 2);
    const sMat = M(new THREE.ShaderMaterial({ name: 'spirit-shield', uniforms: { uColor: { value: new THREE.Color(COL_FALLBACK) }, uAlpha: { value: 0 }, uTime: U.uTime, uHit: { value: 0 } }, vertexShader: SHIELD_VS, fragmentShader: SHIELD_FS, side: THREE.DoubleSide, ...ADD }));
    const shield = new THREE.Mesh(sGeo, sMat); shield.frustumCulled = false; shield.visible = false; shield.renderOrder = 8;
    group.add(aura, glow, trails, bones, orbs, halo, joints, rings, shield);
    return { group, bones, bCol, orbs, oCol, halo, hCol, jGeo, auGeo, rGeo, tGeo, trails, shield, sMat };
  }

  function buildLow() {
    const group = new THREE.Group(); group.name = `${name}-low`;
    const NV = (NB + HEAD_SEG) * 2;
    const lGeo = own(new THREE.BufferGeometry());
    lGeo.setAttribute('position', attr(NV, 3)); lGeo.setAttribute('color', attr(NV, 3));
    const lMat = M(new THREE.LineBasicMaterial({ name: 'spirit-lines', vertexColors: true, ...ADD }));
    const lines = new THREE.LineSegments(lGeo, lMat); lines.frustumCulled = false; lines.renderOrder = 6;
    // огоньки: точки с мягкой текстурой (DataTexture — без DOM)
    const S = 32, px = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1, r2 = dx * dx + dy * dy;
      const v = Math.round(255 * clamp(Math.exp(-r2 * 5) * 0.55 + Math.exp(-r2 * 30) * 0.9, 0, 1));
      const o = (y * S + x) * 4; px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
    }
    const dot = own(new THREE.DataTexture(px, S, S, THREE.RGBAFormat));
    dot.needsUpdate = true;
    const pGeo = own(new THREE.BufferGeometry());
    pGeo.setAttribute('position', attr(N + 2, 3)); pGeo.setAttribute('color', attr(N + 2, 3));
    const pMat = M(new THREE.PointsMaterial({ name: 'spirit-dots', size: 1, map: dot, vertexColors: true, sizeAttenuation: true, ...ADD }));
    const pts = new THREE.Points(pGeo, pMat); pts.frustumCulled = false; pts.renderOrder = 7;
    const shGeo = own(new THREE.IcosahedronGeometry(1, 1));
    const shMat = M(new THREE.MeshBasicMaterial({ name: 'spirit-shield-low', color: COL_FALLBACK, wireframe: true, opacity: 1, ...ADD }));
    const shield = new THREE.Mesh(shGeo, shMat); shield.frustumCulled = false; shield.visible = false;
    group.add(lines, pts, shield);
    return { group, lGeo, pGeo, pMat, shield, shMat };
  }

  // молнии заряда между ладонями — общие для обоих видов (стандартные линии)
  // [W3-MAGIC] + щель света по оси растяжения ладоней — прямые лучи в той же геометрии (вызов отрисовки тот же)
  const ARC_N = 3, ARC_SEG = 10, SLIT_N = 5;
  const SLIT_OFF = [-0.032, -0.016, 0, 0.016, 0.032], SLIT_E = [0.35, 0.75, 1.5, 0.75, 0.35];
  const ARC_V = (ARC_N * ARC_SEG + SLIT_N) * 2;
  const aGeo = own(new THREE.BufferGeometry());
  aGeo.setAttribute('position', attr(ARC_V, 3)); aGeo.setAttribute('color', attr(ARC_V, 3));
  const aMat = M(new THREE.LineBasicMaterial({ name: 'spirit-arcs', vertexColors: true, ...ADD }));
  const arcs = new THREE.LineSegments(aGeo, aMat); arcs.frustumCulled = false; arcs.visible = false; arcs.renderOrder = 8;
  root.add(arcs);

  function setTier(q) {
    const wantFull = (QUALITY[q] || QUALITY.medium).full;
    if (wantFull && !full) { full = buildFull(); root.add(full.group); }
    if (!wantFull && !low) { low = buildLow(); root.add(low.group); }
    if (full) full.group.visible = wantFull;
    if (low) low.group.visible = !wantFull;
    tier = q;
  }

  function upload(a, n) {
    if (typeof a.clearUpdateRanges === 'function') { a.clearUpdateRanges(); a.addUpdateRange(0, n); }
    a.needsUpdate = true;
  }

  // точки этого вида: над ареной кисти крупнее (духу можно), в превью — точно по рукам игрока
  const Pv = new Float32Array(N * 3), pL = new Float32Array(3), pR = new Float32Array(3), pC = new Float32Array(3);
  function viewPoints(st, k) {
    const P = st.P;
    Pv.set(P);
    if (k !== 1) {
      for (let s = 0; s < 2; s++) {
        const base = s ? J.HR : J.HL, w = s ? J.RW : J.LW;
        const wx = P[w * 3], wy = P[w * 3 + 1], wz = P[w * 3 + 2];
        for (let i = 0; i < 21; i++) {
          const o = (base + i) * 3;
          Pv[o] = wx + (P[o] - wx) * k; Pv[o + 1] = wy + (P[o + 1] - wy) * k; Pv[o + 2] = wz + (P[o + 2] - wz) * k;
        }
      }
    }
    palmOf(Pv, J.HL, pL); palmOf(Pv, J.HR, pR);
    if (st.chargeBoth) { for (let c = 0; c < 3; c++) pC[c] = (pL[c] + pR[c]) / 2; }
    else { pC[0] = st.chargePos[0]; pC[1] = st.chargePos[1]; pC[2] = st.chargePos[2]; }
  }

  // st — состояние духа (createSpiritAvatar), v — вид этой сцены:
  // { alpha, px, scale, depthTest, q, lowPointSize, thick, headK, bodyK, auraK, handK }
  function write(st, v) {
    if (v.q !== tier) setTier(v.q);
    U.uTime.value = st.time; U.uOpacity.value = v.alpha; U.uFlow.value = st.rm ? 0 : 1;
    U.uPx.value = v.px; U.uScale.value = v.scale;
    for (const m of mats) if (m.depthTest !== v.depthTest) m.depthTest = v.depthTest;
    viewPoints(st, v.handK);
    if (full && full.group.visible) writeFull(st, Pv, st.jA, st.gCol, v);
    if (low && low.group.visible) writeLow(st, Pv, st.jA, st.gCol, v);
    writeArcs(st, v);
  }

  function writeFull(st, P, A, GC, v) {
    const f = full;
    // кости
    const bc = f.bCol.array;
    for (let k = 0; k < NB; k++) {
      const a = B_A[k], b = B_B[k], r = B_R[k], g = B_G[k];
      const al = Math.min(A[a], A[b]) * (g === G_BODY ? v.bodyK : 1);
      _a.set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]); _b.set(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      _d.subVectors(_b, _a);
      let len = _d.length();
      if (b === J.HEAD) len = Math.max(0, len - st.headR * 0.8);       // шея — до подбородка, не сквозь голову
      if (len < 1e-4 || al < 0.004) f.bones.setMatrixAt(k, ZERO_M);
      else {
        _d.multiplyScalar(1 / len); _q.setFromUnitVectors(UP, _d);
        const rr = r * v.thick * (g >= G_HAND_L ? v.handK : 1); _s.set(rr, len, rr);
        _m.compose(_a, _q, _s); f.bones.setMatrixAt(k, _m);
      }
      bc[k * 3] = GC[g * 3] * al; bc[k * 3 + 1] = GC[g * 3 + 1] * al; bc[k * 3 + 2] = GC[g * 3 + 2] * al;
    }
    f.bones.instanceMatrix.needsUpdate = true; f.bCol.needsUpdate = true;
    // голова и заряд
    const oc = f.oCol.array, ha = A[J.HEAD] * v.headK;
    _a.set(P[J.HEAD * 3], P[J.HEAD * 3 + 1], P[J.HEAD * 3 + 2]); _q.identity();
    const hr = st.headR * 0.86 * (1 + (st.rm ? 0 : 0.04 * Math.sin(st.time * 2.1)));
    if (ha < 0.004) f.orbs.setMatrixAt(0, ZERO_M); else { _s.set(hr, hr, hr); _m.compose(_a, _q, _s); f.orbs.setMatrixAt(0, _m); }
    oc[0] = GC[0] * ha; oc[1] = GC[1] * ha; oc[2] = GC[2] * ha;
    const ch = st.charge;
    if (ch < 0.02) f.orbs.setMatrixAt(1, ZERO_M);
    else {
      const cr = (0.07 + 0.3 * ch + (st.rm ? 0 : 0.03 * Math.sin(st.time * 11))) * v.handK;
      // [W3-MAGIC] ось растяжения — сфера сплющивается в щель света (по горизонтали или по вертикали)
      const ax = Math.max(st.axisH, st.axisV), sh = st.axisH >= st.axisV ? 1 : 0;
      const long = cr * (1 + 2.4 * ax), thin = cr * Math.max(0.22, 1 - 0.75 * ax);
      if (sh) _s.set(long, thin, thin); else _s.set(thin, long, thin);
      _a.set(pC[0], pC[1], pC[2]); _m.compose(_a, _q, _s); f.orbs.setMatrixAt(1, _m);
    }
    const cc = st.colElem2;
    oc[3] = cc[0] * ch * 2.2; oc[4] = cc[1] * ch * 2.2; oc[5] = cc[2] * ch * 2.2;
    f.orbs.instanceMatrix.needsUpdate = true; f.oCol.needsUpdate = true;
    // огоньки суставов
    const jp = f.jGeo.attributes.position.array, jc = f.jGeo.attributes.aColor.array, js = f.jGeo.attributes.aSize.array;
    for (let j = 0; j < N; j++) {
      const g = PT_GROUP[j], al = A[j] * PT_GAIN[j] * (g === G_BODY ? v.bodyK : 1);
      jp[j * 3] = P[j * 3]; jp[j * 3 + 1] = P[j * 3 + 1]; jp[j * 3 + 2] = P[j * 3 + 2];
      const fl = g === G_ARM_L || g === G_HAND_L ? st.flash[0] : g === G_ARM_R || g === G_HAND_R ? st.flash[1] : 0;
      js[j] = PT_SIZE[j] * (1 + 0.7 * fl) * v.thick * (g >= G_HAND_L ? v.handK : 1);
      jc[j * 3] = GC[g * 3] * al * 1.8; jc[j * 3 + 1] = GC[g * 3 + 1] * al * 1.8; jc[j * 3 + 2] = GC[g * 3 + 2] * al * 1.8;
    }
    upload(f.jGeo.attributes.position, N * 3); upload(f.jGeo.attributes.aColor, N * 3); upload(f.jGeo.attributes.aSize, N);
    // дымка
    const ap = f.auGeo.attributes.position.array, acl = f.auGeo.attributes.aColor.array, as = f.auGeo.attributes.aSize.array;
    for (let i = 0; i < NA; i++) {
      const ja = AU_A[i], jb = AU_B[i], t = AU_T[i], size = AU_S[i], gain = AU_K[i], g = AU_G[i];
      for (let c = 0; c < 3; c++) ap[i * 3 + c] = P[ja * 3 + c] + (P[jb * 3 + c] - P[ja * 3 + c]) * t;
      const fl = g === G_ARM_L || g === G_HAND_L ? st.flash[0] : g === G_ARM_R || g === G_HAND_R ? st.flash[1] : 0;
      const e = Math.min(A[ja], A[jb]) * gain * (1 + 1.2 * fl + 0.5 * st.ult) * v.auraK;
      as[i] = size * (g >= G_HAND_L ? v.handK : 1);
      acl[i * 3] = GC[g * 3] * e; acl[i * 3 + 1] = GC[g * 3 + 1] * e; acl[i * 3 + 2] = GC[g * 3 + 2] * e;
    }
    upload(f.auGeo.attributes.position, NA * 3); upload(f.auGeo.attributes.aColor, NA * 3); upload(f.auGeo.attributes.aSize, NA);
    // кольца
    const rp = f.rGeo.attributes.position.array, rc = f.rGeo.attributes.aColor.array, rs = f.rGeo.attributes.aSize.array;
    // нимб: кольцо над головой, к зрителю чуть наклонено; вспыхивает в ультимейт
    const halo = A[J.HEAD] * (0.55 + 1.4 * st.ult + 0.6 * st.up + st.ready * (0.7 + (st.rm ? 0.25 : 0.5 * Math.sin(st.time * 6)))) * Math.max(v.headK, 0.7);
    if (halo < 0.004) f.halo.setMatrixAt(0, ZERO_M);
    else {
      const hr2 = st.headR * (0.78 + 0.25 * st.ult);
      _a.set(P[J.HEAD * 3], P[J.HEAD * 3 + 1] + st.headR * 1.12, P[J.HEAD * 3 + 2]);
      _e.set(v.haloTilt, 0, 0.04 * Math.sin(st.time * 0.9)); _q.setFromEuler(_e); _s.set(hr2, hr2, hr2);
      _m.compose(_a, _q, _s); f.halo.setMatrixAt(0, _m);
    }
    // готовый ультимейт — нимб цвета стихии героя
    const hc = st.ready, e2 = st.colElem2;
    f.hCol.array[0] = (GC[0] + (e2[0] * 1.6 - GC[0]) * hc) * halo * 1.3; f.hCol.array[1] = (GC[1] + (e2[1] * 1.6 - GC[1]) * hc) * halo * 1.3; f.hCol.array[2] = (GC[2] + (e2[2] * 1.6 - GC[2]) * hc) * halo * 1.3;
    f.halo.instanceMatrix.needsUpdate = true; f.hCol.needsUpdate = true;
    rs[0] = 0; rc[0] = rc[1] = rc[2] = 0;
    for (let i = 0; i < RINGS; i++) {
      const R = st.rings[i], o = i + 1;
      if (!R.on) { rs[o] = 0; rc[o * 3] = rc[o * 3 + 1] = rc[o * 3 + 2] = 0; continue; }
      const pp = R.side === 0 ? pL : R.side === 1 ? pR : R.side === 2 ? pC : null;   // 2 — между ладонями ([W3-MAGIC])
      rp[o * 3] = pp ? pp[0] : R.x; rp[o * 3 + 1] = pp ? pp[1] : R.y; rp[o * 3 + 2] = (pp ? pp[2] : R.z) - 0.05;
      const k = R.t / R.dur, fade = (1 - k) * (1 - k);
      rs[o] = (R.s0 + (R.s1 - R.s0) * Math.sqrt(k)) * (pp ? v.handK : 1);
      rc[o * 3] = R.r * fade; rc[o * 3 + 1] = R.g * fade; rc[o * 3 + 2] = R.b * fade;
    }
    upload(f.rGeo.attributes.position, (RINGS + 1) * 3); upload(f.rGeo.attributes.aColor, (RINGS + 1) * 3); upload(f.rGeo.attributes.aSize, RINGS + 1);
    // шлейф: история в координатах тела; кончики пальцев — с тем же увеличением кисти от текущего запястья
    const ns = st.trailN;
    if (ns < 2) { f.trails.visible = false; } else {
      f.trails.visible = true;
      const tp = f.tGeo.attributes.position.array, tt = f.tGeo.attributes.aTan.array;
      const tc = f.tGeo.attributes.aColor.array, tsd = f.tGeo.attributes.aSide.array;
      const H = st.trail, head = st.trailHead, hk = v.handK;
      for (let t = 0; t < NT; t++) {
        const al = st.trailA[t], w0 = t < 10 ? 0.034 : 0.07, g = t < 5 ? G_HAND_L : t < 10 ? G_HAND_R : t === 10 ? G_ARM_L : G_ARM_R;
        const wj = t < 5 ? J.LW : t < 10 ? J.RW : -1;
        const wx = wj >= 0 ? P[wj * 3] : 0, wy = wj >= 0 ? P[wj * 3 + 1] : 0, wz = wj >= 0 ? P[wj * 3 + 2] : 0, k2 = wj >= 0 ? hk : 1;
        for (let i = 0; i < NS_MAX; i++) {
          const v2 = (t * NS_MAX + i) * 2;
          const ii = Math.min(i, ns - 1);
          const at = (head - ii + NS_MAX) % NS_MAX, prev = (head - Math.max(0, ii - 1) + NS_MAX) % NS_MAX, next = (head - Math.min(ns - 1, ii + 1) + NS_MAX) % NS_MAX;
          const o = (t * NS_MAX + at) * 3, op = (t * NS_MAX + prev) * 3, on = (t * NS_MAX + next) * 3;
          const age = ii / (ns - 1), k = i < ns ? (1 - age) : 0;
          const w = w0 * Math.pow(k, 0.7) * v.thick * k2, c = al * k * k * 0.85;
          const x = wj >= 0 ? wx + (H[o] - wx) * k2 : H[o], y = wj >= 0 ? wy + (H[o + 1] - wy) * k2 : H[o + 1], z = wj >= 0 ? wz + (H[o + 2] - wz) * k2 : H[o + 2];
          for (let s = 0; s < 2; s++) {
            const vo = (v2 + s) * 3;
            tp[vo] = x; tp[vo + 1] = y; tp[vo + 2] = z;
            tt[vo] = H[op] - H[on]; tt[vo + 1] = H[op + 1] - H[on + 1]; tt[vo + 2] = H[op + 2] - H[on + 2];
            tc[vo] = GC[g * 3] * c; tc[vo + 1] = GC[g * 3 + 1] * c; tc[vo + 2] = GC[g * 3 + 2] * c;
            tsd[v2 + s] = s ? -w : w;
          }
        }
      }
      const TV = NT * NS_MAX * 2;
      upload(f.tGeo.attributes.position, TV * 3); upload(f.tGeo.attributes.aTan, TV * 3);
      upload(f.tGeo.attributes.aColor, TV * 3); upload(f.tGeo.attributes.aSide, TV);
    }
    // щит — купол в левой ладони
    const sh = st.shield;
    f.shield.visible = sh > 0.01;
    if (f.shield.visible) {
      const s = 0.95 * st.shieldPop * v.thick * Math.max(1, v.handK * 0.9);
      f.shield.position.set(pL[0], pL[1], pL[2] - 0.12);
      f.shield.scale.set(s, s, s);
      f.sMat.uniforms.uAlpha.value = sh * v.alpha;
      f.sMat.uniforms.uHit.value = st.shieldHit;
      const ec = st.colElem; f.sMat.uniforms.uColor.value.setRGB(ec[0] * 1.4, ec[1] * 1.4, ec[2] * 1.4);
    }
  }

  function writeLow(st, P, A, GC, v) {
    const l = low;
    const lp = l.lGeo.attributes.position.array, lc = l.lGeo.attributes.color.array;
    let o = 0;
    for (let k = 0; k < NB; k++) {
      const a = B_A[k], b = B_B[k], g = B_G[k], ea = B_EA[k], eb = B_EB[k];
      const al = Math.min(A[a], A[b]) * v.alpha * (g === G_BODY ? v.bodyK : 1);
      for (let s = 0; s < 2; s++) {
        const j = s ? b : a, e = (s ? eb : ea) * al;
        lp[o] = P[j * 3]; lp[o + 1] = P[j * 3 + 1]; lp[o + 2] = P[j * 3 + 2];
        lc[o] = GC[g * 3] * e; lc[o + 1] = GC[g * 3 + 1] * e; lc[o + 2] = GC[g * 3 + 2] * e;
        o += 3;
      }
    }
    const hx = P[J.HEAD * 3], hy = P[J.HEAD * 3 + 1], hz = P[J.HEAD * 3 + 2], hr = st.headR * 0.86, ha = A[J.HEAD] * v.alpha * Math.max(v.headK, 0.5);
    for (let i = 0; i < HEAD_SEG; i++) {
      for (let s = 0; s < 2; s++) {
        const ang = ((i + s) / HEAD_SEG) * Math.PI * 2;
        lp[o] = hx + Math.cos(ang) * hr; lp[o + 1] = hy + Math.sin(ang) * hr; lp[o + 2] = hz;
        lc[o] = GC[0] * ha; lc[o + 1] = GC[1] * ha; lc[o + 2] = GC[2] * ha;
        o += 3;
      }
    }
    upload(l.lGeo.attributes.position, o); upload(l.lGeo.attributes.color, o);
    const pp = l.pGeo.attributes.position.array, pc = l.pGeo.attributes.color.array;
    for (let j = 0; j < N; j++) {
      const g = PT_GROUP[j], al = PT_SIZE[j] > 0 ? A[j] * PT_GAIN[j] * v.alpha * (g === G_BODY ? v.bodyK : 1) : 0;
      const fl = g === G_ARM_L || g === G_HAND_L ? st.flash[0] : g === G_ARM_R || g === G_HAND_R ? st.flash[1] : 0;
      pp[j * 3] = P[j * 3]; pp[j * 3 + 1] = P[j * 3 + 1]; pp[j * 3 + 2] = P[j * 3 + 2];
      const e = al * (1 + fl);
      pc[j * 3] = GC[g * 3] * e; pc[j * 3 + 1] = GC[g * 3 + 1] * e; pc[j * 3 + 2] = GC[g * 3 + 2] * e;
    }
    // сфера заряда — две точки (ядро и гало)
    const ch = st.charge * v.alpha, cc = st.colElem2;
    for (let i = 0; i < 2; i++) {
      const j = N + i;
      pp[j * 3] = pC[0]; pp[j * 3 + 1] = pC[1]; pp[j * 3 + 2] = pC[2];
      pc[j * 3] = cc[0] * ch * 1.5; pc[j * 3 + 1] = cc[1] * ch * 1.5; pc[j * 3 + 2] = cc[2] * ch * 1.5;
    }
    upload(l.pGeo.attributes.position, (N + 2) * 3); upload(l.pGeo.attributes.color, (N + 2) * 3);
    l.pMat.size = v.lowPointSize;
    const sh = st.shield;
    l.shield.visible = sh > 0.01;
    if (l.shield.visible) {
      const s = 0.9 * st.shieldPop * v.thick * Math.max(1, v.handK * 0.9);
      l.shield.position.set(pL[0], pL[1], pL[2] - 0.12);
      l.shield.scale.set(s, s, s * 0.5);
      const ec = st.colElem, e = sh * v.alpha * (0.6 + st.shieldHit);
      l.shMat.color.setRGB(ec[0] * e, ec[1] * e, ec[2] * e);
    }
  }

  function writeArcs(st, v) {
    const on = st.charge > 0.05 && st.arcSeed > 0;
    const axW = Math.max(st.axisH, st.axisV) * Math.min(1, st.charge * 3), slitW = Math.max(axW, st.slit);
    arcs.visible = on || slitW > 0.02;
    if (!arcs.visible) return;
    const ap = aGeo.attributes.position.array, ac = aGeo.attributes.color.array;
    const cc = st.colElem2;
    let o = 0;
    // щель света: 5 параллельных лучей через центр между ладонями; каст — во весь размах и гаснет
    if (slitW > 0.02) {
      const hz = st.axisH + st.axisV > 0.02 ? st.axisH / (st.axisH + st.axisV) : st.slitH;   // 1 — по горизонтали
      const ux = hz, uy = 1 - hz, ul = Math.hypot(ux, uy) || 1, dx = ux / ul, dy = uy / ul;
      const half = (0.22 + 0.75 * st.charge * axW + 1.9 * st.slit) * v.handK;
      const jit = st.rm ? 0 : ((st.arcSeed % 97) / 97 - 0.5) * 0.012;
      for (let i = 0; i < SLIT_N; i++) {
        const off = (SLIT_OFF[i] + (i === 2 ? 0 : jit)) * v.handK * (1 + 1.5 * st.slit), e = SLIT_E[i] * slitW * v.alpha * (1 + st.slit);
        const cx = pC[0] - dy * off, cy = pC[1] + dx * off, cz = pC[2] - 0.02;
        const hl = half * (i === 2 ? 1 : 0.82);
        ap[o] = cx - dx * hl; ap[o + 1] = cy - dy * hl; ap[o + 2] = cz; ac[o] = cc[0] * e; ac[o + 1] = cc[1] * e; ac[o + 2] = cc[2] * e; o += 3;
        ap[o] = cx + dx * hl; ap[o + 1] = cy + dy * hl; ap[o + 2] = cz; ac[o] = cc[0] * e; ac[o + 1] = cc[1] * e; ac[o + 2] = cc[2] * e; o += 3;
      }
    }
    if (!on) { upload(aGeo.attributes.position, o); upload(aGeo.attributes.color, o); aGeo.setDrawRange(0, o / 3); return; }
    const L = st.chargeBoth ? pL : pC, R = st.chargeBoth ? pR : pC;
    const dx = R[0] - L[0], dy = R[1] - L[1], len = Math.max(0.25, Math.hypot(dx, dy));
    const nx = -dy / len, ny = dx / len;
    let seed = st.arcSeed;
    for (let a = 0; a < ARC_N; a++) {
      let px = L[0], py = L[1], pz = L[2];
      for (let i = 1; i <= ARC_SEG; i++) {
        const k = i / ARC_SEG, amp = Math.sin(Math.PI * k) * 0.16 * len * (0.6 + st.charge);
        seed = (seed * 16807) % 2147483647; const r1 = seed / 2147483647 - 0.5;
        seed = (seed * 16807) % 2147483647; const r2 = seed / 2147483647 - 0.5;
        seed = (seed * 16807) % 2147483647; const r3 = seed / 2147483647 - 0.5;
        const x = L[0] + dx * k + nx * r1 * amp, y = L[1] + dy * k + ny * r2 * amp, z = L[2] + (R[2] - L[2]) * k + r3 * amp * 0.5;
        const e = st.charge * (0.55 + 0.45 * Math.sin(Math.PI * k)) * v.alpha * 1.6;
        ap[o] = px; ap[o + 1] = py; ap[o + 2] = pz; ac[o] = cc[0] * e; ac[o + 1] = cc[1] * e; ac[o + 2] = cc[2] * e; o += 3;
        ap[o] = x; ap[o + 1] = y; ap[o + 2] = z; ac[o] = cc[0] * e; ac[o + 1] = cc[1] * e; ac[o + 2] = cc[2] * e; o += 3;
        px = x; py = y; pz = z;
      }
    }
    upload(aGeo.attributes.position, o); upload(aGeo.attributes.color, o);
    aGeo.setDrawRange(0, o / 3);
  }

  function dispose() {
    if (root.parent) root.parent.remove(root);
    for (const x of owned) { try { x.dispose(); } catch (e) { /* уже освобождён */ } }
    owned.length = 0; mats.length = 0;
    full = null; low = null;
  }

  return { root, write, setTier, dispose, get tier() { return tier; }, get owned() { return owned; } };
}

// ------------------------------------------------------------------ дух игрока

/**
 * createSpiritAvatar({ THREE, scene, camera, slot?, overlay?, heroes?, settings?, frameRenderer? })
 *   scene/camera — сцена игры (дух над ареной висит на камере: scene.add(camera) в main.js);
 *   slot — слот превью камеры ui.js (холст духа «в кадре» ставится под overlay трекинг-HUD);
 *   heroes — HEROES (modules/heroModel.js): цвет стихии героя fx.color / fx.color2.
 * frame(dt, now, ctx): ctx = { screen, debug, vision | pose+hands, status, input, events, snapshot, hero, present? }.
 */
export function createSpiritAvatar(opts = {}) {
  const { THREE, scene = null, camera = null, heroes = null } = opts;
  if (!THREE) throw new Error('spiritAvatar: нужен THREE');
  const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
  let slot = opts.slot || null;
  const overlayEl = opts.overlay || null;
  const allowFrameRenderer = opts.frameRenderer !== false && hasDom;
  let liveSettings = opts.settings || null;

  // ---- состояние скелета (координаты тела)
  const REST = makePose('rest'), RAISED = makePose('up');
  const P = new Float32Array(REST);          // показываемые точки
  const T = new Float32Array(N * 3);         // цель кадра
  const jA = new Float32Array(N);            // видимость суставов 0..1
  const jOk = new Uint8Array(N);             // точка есть в данных этого кадра
  const handRel = [new Float32Array(63), new Float32Array(63)];   // форма кисти от запястья (для потерянной кисти)
  for (let s = 0; s < 2; s++) {
    const base = s ? J.HR : J.HL, w = s ? J.RW : J.LW;
    for (let i = 0; i < 21; i++) for (let c = 0; c < 3; c++) handRel[s][i * 3 + c] = REST[(base + i) * 3 + c] - REST[w * 3 + c];
  }
  // ---- фильтр камеры: «изо»-координаты кадра (x·aspect, y вниз, z·aspect), One-Euro по каждой оси
  const iso = new Float32Array(N * 3), isoDx = new Float32Array(N * 3), isoInit = new Uint8Array(N);
  const isoOkAt = new Float64Array(N).fill(-1e9);
  const raw = new Float32Array(N * 3), rawOk = new Uint8Array(N);
  const ref = { x: 0.5 * 4 / 3, y: 0.45, z: 0, sw: 0.3, ok: false, asp: 4 / 3, headR: 0.32 };
  const src = { poseT: -1, sampleAt: -1e9, handRef: [null, null], handAt: [-1e9, -1e9], lastSampleT: -1 };
  // ---- синтетика «Отладки с клавиатуры»
  const syn = createSynth();

  const st = {
    time: 0, rm: false, P, jA, headR: 0.3,
    gCol: new Float32Array(5 * 3), colElem: new Float32Array([1, 0.48, 0.16]), colElem2: new Float32Array([1, 0.8, 0.55]),
    flash: new Float32Array(2), flashCol: [new Float32Array([1, 1, 1]), new Float32Array([1, 1, 1])],
    shield: 0, shieldPop: 1, shieldHit: 0, charge: 0, chargePos: new Float32Array(3),
    palmL: new Float32Array(3), palmR: new Float32Array(3), chargeBoth: false,
    ult: 0, up: 0, ready: 0, arcSeed: 1, viewAlpha: 1,
    axisH: 0, axisV: 0, slit: 0, slitH: 1,     // [W3-MAGIC] ось растяжения ладоней и вспышка каста (slitH: 1 — по горизонтали, 0 — по вертикали)
    cine: 0,                                    // [W3-ULT] идёт сцена «Небесного суда» (0..1)
    rings: Array.from({ length: RINGS }, () => ({ on: false, side: 0, t: 0, dur: 0.6, s0: 0.2, s1: 1.4, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0 })),
    trail: new Float32Array(NT * NS_MAX * 3), trailA: new Float32Array(NT), trailHead: 0, trailN: 0, trailFill: 0, trailAcc: 0,
  };
  const handA = new Float32Array(2);       // кисть в данных (0..1)
  let presence = 0;                        // трекинг есть (0..1, с плавным угасанием)
  let skyA = 0, frameA = 0;                // видимость духа над ареной и в кадре
  const edge = { attack: false, shield: false, conjure: false, hintCode: null, hintSide: null };
  let upLatch = false, ultCool = 0, chargeT = 0, arcT = 0, slitCool = 0;
  const elemCache = { hero: null };
  let quality = 'medium';
  let enabled = true, disposed = false, warnAt = 0, warm = 3;
  let source = 'none';

  // ---- сцены
  const sky = createRig(THREE, 'spirit-sky');
  if (camera) camera.add(sky.root); else if (scene) scene.add(sky.root);
  sky.root.visible = true;                 // первые кадры — невидимая отрисовка: шейдеры компилируются заранее
  let fr = null;                           // дух «в кадре»: { canvas, renderer, scene, cam, rig }
  let frameHiddenAt = 0;
  const _v = new THREE.Vector3(), _vs = new THREE.Vector2();
  const renderer = opts.renderer || null;  // размер буфера кадра — для огоньков над ареной

  // ------------------------------------------------------------ источник: камера
  function readVision(now, ctx) {
    let pose = null, hands = null;
    const v = ctx.vision;
    if (v) {
      try { pose = typeof v.getPose === 'function' ? v.getPose() : null; } catch (e) { pose = null; }
      try { hands = typeof v.getHands === 'function' ? v.getHands() : null; } catch (e) { hands = null; }
    } else { pose = ctx.pose || null; hands = ctx.hands || null; }
    const stt = ctx.status && ctx.status.status;
    const dead = stt === 'idle' || stt === 'error' || stt === 'permission' || stt === 'loading';
    // свежесть кисти — по смене массива landmarks (handGestures даёт новый массив на каждый кадр, где кисть видна)
    for (let s = 0; s < 2; s++) {
      const h = hands && (s ? hands.right : hands.left);
      const L = h && Array.isArray(h.landmarks) && h.landmarks.length >= 21 ? h.landmarks : null;
      if (L && L !== src.handRef[s]) { src.handRef[s] = L; src.handAt[s] = now; }
      if (!L) src.handRef[s] = null;
    }
    if (dead || !pose || !fin(pose.tMs)) return false;
    if (pose.tMs === src.poseT) return now - src.sampleAt < 450;
    src.poseT = pose.tMs;
    if (!Array.isArray(pose.landmarks)) return false;
    ingest(pose, hands, now);
    return true;
  }

  // точка позы годится: в кадре и видима (visibility, как у trackingHud: если у всех точек 0 — ей не верим)
  let inAnyVis = false, inMir = true, inAsp = 4 / 3;
  function okPt(q) {
    return !!q && fin(q.x) && fin(q.y) && q.x > -0.15 && q.x < 1.15 && q.y > -0.15 && q.y < 1.2 && (!inAnyVis || !fin(q.visibility) || q.visibility >= 0.5);
  }
  function put(j, q) {
    if (!okPt(q)) return false;
    raw[j * 3] = (inMir ? 1 - q.x : q.x) * inAsp; raw[j * 3 + 1] = q.y; raw[j * 3 + 2] = (fin(q.z) ? q.z : 0) * inAsp;
    rawOk[j] = 1; return true;
  }

  function ingest(pose, hands, now) {
    const L = pose.landmarks;
    const W = fin(pose.frameW) && pose.frameW > 0 ? pose.frameW : 640, H = fin(pose.frameH) && pose.frameH > 0 ? pose.frameH : 480;
    const asp = W / H, mir = pose.mirror !== false;
    ref.asp = asp; inAsp = asp; inMir = mir;
    rawOk.fill(0);
    inAnyVis = false;
    for (let k = 0; k < VIS_IDX.length; k++) { const q = L[VIS_IDX[k]]; if (q && q.visibility > 0) { inAnyVis = true; break; } }
    // плечи 11/12 — левое/правое ИГРОКА; после зеркала левое — слева на экране
    put(J.LS, L[11]); put(J.RS, L[12]); put(J.LE, L[13]); put(J.RE, L[14]); put(J.LW, L[15]); put(J.RW, L[16]);
    put(J.LH, L[23]); put(J.RH, L[24]);
    // голова: середина ушей, иначе нос
    const e7 = L[7], e8 = L[8], nose = L[0];
    if (okPt(e7) && okPt(e8)) {
      raw[J.HEAD * 3] = ((mir ? 1 - e7.x : e7.x) + (mir ? 1 - e8.x : e8.x)) * 0.5 * asp;
      raw[J.HEAD * 3 + 1] = (e7.y + e8.y) * 0.5;
      raw[J.HEAD * 3 + 2] = ((fin(e7.z) ? e7.z : 0) + (fin(e8.z) ? e8.z : 0)) * 0.5 * asp;
      rawOk[J.HEAD] = 1;
      const ed = Math.hypot((e7.x - e8.x) * asp, e7.y - e8.y);
      ref.headR += (clamp(ed * 0.62, 0.05, 0.4) - ref.headR) * 0.2;
    } else if (put(J.HEAD, nose)) raw[J.HEAD * 3 + 1] -= 0.01;
    // опорный кадр: центр и ширина плеч (медленно — наклон корпуса виден, но дух не «уезжает»)
    const dtS = src.lastSampleT >= 0 ? clamp((pose.tMs - src.lastSampleT) / 1000, 1 / 120, 0.25) : 1 / 30;
    src.lastSampleT = pose.tMs; src.sampleAt = now;
    if (rawOk[J.LS] && rawOk[J.RS]) {
      const cx = (raw[J.LS * 3] + raw[J.RS * 3]) / 2, cy = (raw[J.LS * 3 + 1] + raw[J.RS * 3 + 1]) / 2, cz = (raw[J.LS * 3 + 2] + raw[J.RS * 3 + 2]) / 2;
      const sw = clamp(Math.hypot(raw[J.LS * 3] - raw[J.RS * 3], raw[J.LS * 3 + 1] - raw[J.RS * 3 + 1]), 0.06, 0.9);
      if (!ref.ok) { ref.x = cx; ref.y = cy; ref.z = cz; ref.sw = sw; ref.ok = true; }
      else {
        const kS = 1 - Math.exp(-dtS / 0.45), kC = 1 - Math.exp(-dtS / 2.2), kZ = 1 - Math.exp(-dtS / 0.6);
        ref.sw += (sw - ref.sw) * kS; ref.x += (cx - ref.x) * kC; ref.y += (cy - ref.y) * kC; ref.z += (cz - ref.z) * kZ;
        const lim = 0.7 * ref.sw;
        ref.x = clamp(ref.x, cx - lim, cx + lim); ref.y = clamp(ref.y, cy - lim, cy + lim);
      }
    }
    // кисти: 21 точка показа; глубина — как у запястья позы. Запястье руки — по кисти (она точнее позы)
    for (let s = 0; s < 2; s++) {
      const h = hands && (s ? hands.right : hands.left);
      const Lh = h && Array.isArray(h.landmarks) && h.landmarks.length >= 21 ? h.landmarks : null;
      if (!Lh || now - src.handAt[s] > 60) continue;           // кисть не обновилась в этом кадре — старые точки не берём
      let ok = true;
      for (let i = 0; i < 21; i++) { const q = Lh[i]; if (!q || !fin(q.x) || !fin(q.y)) { ok = false; break; } }
      if (!ok) continue;
      const base = s ? J.HR : J.HL, w = s ? J.RW : J.LW;
      const z = rawOk[w] ? raw[w * 3 + 2] : ref.z;
      for (let i = 0; i < 21; i++) {
        const j = base + i;
        raw[j * 3] = Lh[i].x * asp; raw[j * 3 + 1] = Lh[i].y; raw[j * 3 + 2] = z; rawOk[j] = 1;
      }
      raw[w * 3] = raw[base * 3]; raw[w * 3 + 1] = raw[base * 3 + 1]; raw[w * 3 + 2] = z; rawOk[w] = 1;
    }
    // One-Euro: точки, пропавшие дольше 0,3 с, начинают с нового места (без «подлёта»)
    for (let j = 0; j < N; j++) {
      if (!rawOk[j]) continue;
      const hand = j >= J.HL;
      const fresh = isoInit[j] && now - isoOkAt[j] < 300;
      for (let c = 0; c < 3; c++) {
        const i = j * 3 + c, x = raw[i];
        if (!fresh) { iso[i] = x; isoDx[i] = 0; continue; }
        const minC = c === 2 ? 0.6 : hand ? 1.5 : 1.1, beta = c === 2 ? 1.0 : hand ? 5 : 4;
        const dx = (x - iso[i]) / dtS;
        const aD = euroA(1.0, dtS);
        isoDx[i] += (dx - isoDx[i]) * aD;
        const a = euroA(minC + beta * Math.abs(isoDx[i]), dtS);
        iso[i] += (x - iso[i]) * a;
      }
      isoInit[j] = 1; isoOkAt[j] = now;
    }
  }
  function euroA(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }

  // из изо-координат кадра — в координаты тела
  function isoToT(j) {
    const sw = ref.sw;
    T[j * 3] = (iso[j * 3] - ref.x) / sw;
    T[j * 3 + 1] = -(iso[j * 3 + 1] - ref.y) / sw;
    T[j * 3 + 2] = clamp(((iso[j * 3 + 2] - ref.z) / sw) * DEPTH_K, -1.4, 0.9);
  }

  // ------------------------------------------------------------ цель кадра: камера → тело, пропуски → покой
  function solveFromCamera(now) {
    for (let j = 0; j < N; j++) jOk[j] = isoInit[j] && now - isoOkAt[j] < (j >= J.HL ? 260 : 320) ? 1 : 0;
    for (let j = 0; j < N; j++) if (jOk[j]) isoToT(j);
    finishTargets();
  }

  // недостающие точки: плечи — покой, локоть — по плечу и запястью, запястье — опущено, кисть — прежней формы
  function finishTargets() {
    if (!jOk[J.LS]) copyRest(J.LS);
    if (!jOk[J.RS]) copyRest(J.RS);
    if (jOk[J.LS] && !jOk[J.RS]) { T[J.RS * 3] = T[J.LS * 3] + 1; T[J.RS * 3 + 1] = T[J.LS * 3 + 1]; T[J.RS * 3 + 2] = T[J.LS * 3 + 2]; }
    if (jOk[J.RS] && !jOk[J.LS]) { T[J.LS * 3] = T[J.RS * 3] - 1; T[J.LS * 3 + 1] = T[J.RS * 3 + 1]; T[J.LS * 3 + 2] = T[J.RS * 3 + 2]; }
    for (let c = 0; c < 3; c++) T[J.NECK * 3 + c] = (T[J.LS * 3 + c] + T[J.RS * 3 + c]) / 2;
    if (!jOk[J.HEAD]) { T[J.HEAD * 3] = T[J.NECK * 3]; T[J.HEAD * 3 + 1] = T[J.NECK * 3 + 1] + 0.82; T[J.HEAD * 3 + 2] = T[J.NECK * 3 + 2]; }
    for (let side = 0; side < 2; side++) {
      const s = side ? J.RS : J.LS, e = side ? J.RE : J.LE, w = side ? J.RW : J.LW;
      if (!jOk[w]) { for (let c = 0; c < 3; c++) T[w * 3 + c] = T[s * 3 + c] + REST[w * 3 + c] - REST[s * 3 + c]; }
      if (!jOk[e]) solveElbow(T, s, w, e, side ? 1 : -1);
    }
    // корпус: бёдра из позы (стоя) или растворяющийся книзу торс
    if (jOk[J.LH] && jOk[J.RH]) { for (let c = 0; c < 3; c++) T[J.PELVIS * 3 + c] = (T[J.LH * 3 + c] + T[J.RH * 3 + c]) / 2; }
    else {
      T[J.PELVIS * 3] = T[J.NECK * 3]; T[J.PELVIS * 3 + 1] = T[J.NECK * 3 + 1] - 1.45; T[J.PELVIS * 3 + 2] = T[J.NECK * 3 + 2];
      for (let side = 0; side < 2; side++) { const j = side ? J.RH : J.LH; T[j * 3] = T[J.PELVIS * 3] + (side ? 0.32 : -0.32); T[j * 3 + 1] = T[J.PELVIS * 3 + 1] + 0.03; T[j * 3 + 2] = T[J.PELVIS * 3 + 2]; }
    }
    for (let s = 0; s < 2; s++) {
      const base = s ? J.HR : J.HL, w = s ? J.RW : J.LW;
      if (jOk[base]) {
        // форма кисти запоминается — пропавшая кисть «едет» за запястьем, а не исчезает рывком
        for (let i = 0; i < 21; i++) for (let c = 0; c < 3; c++) handRel[s][i * 3 + c] = T[(base + i) * 3 + c] - T[base * 3 + c];
      } else {
        for (let i = 0; i < 21; i++) for (let c = 0; c < 3; c++) T[(base + i) * 3 + c] = T[w * 3 + c] + handRel[s][i * 3 + c];
      }
    }
  }
  function copyRest(j) { T[j * 3] = REST[j * 3]; T[j * 3 + 1] = REST[j * 3 + 1]; T[j * 3 + 2] = REST[j * 3 + 2]; }

  // ------------------------------------------------------------ синтетика: пальцы считают, клавиши — жесты
  function createSynth() {
    const mk = (x, y) => ({ x, y, z: 0, ang: 0, curls: [0, 0, 0, 0], thumbIn: 0, pinch: 0, away: false });
    const cur = [mk(-0.62, -0.42), mk(0.62, -0.32)], tgt = [mk(-0.62, -0.42), mk(0.62, -0.32)];
    const tm = { burst: -9, burstBoth: false, sigil: -9, spark: -9, slash: -9, parry: -9, dash: -9, dashX: 0, ult: -9, stretch: -9, stretchH: true, t: 0 };
    const COUNT = [[1, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 1, 1], [0, 0, 0, 1, 1], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]];
    function setShape(h, c0, c1, c2, c3, thumbIn, pinch = 0) { h.curls[0] = c0; h.curls[1] = c1; h.curls[2] = c2; h.curls[3] = c3; h.thumbIn = thumbIn; h.pinch = pinch; }
    // opt.ultByInput: в бою без шкалы ультимейта руки вверх — по импульсу ввода; со шкалой («Небесный суд») —
    // только по событию ultimate_start (ult()), иначе отказ боя (шкала не полна) выглядел бы успехом
    function step(dt, input, opt) {
      const t = (tm.t += dt), I = input || {};
      const L = tgt[0], R = tgt[1];
      // покой: левая плавно качается, пальцы шевелятся; правая считает 1–5, машет и показывает «OK»
      L.x = -0.62 + 0.05 * Math.sin(t * 0.9); L.y = -0.42 + 0.06 * Math.sin(t * 1.3); L.z = 0; L.ang = 0.18 + 0.12 * Math.sin(t * 0.8); L.away = false;
      setShape(L, 0.12 + 0.12 * Math.sin(t * 2.6), 0.1 + 0.12 * Math.sin(t * 2.6 + 0.7), 0.12 + 0.12 * Math.sin(t * 2.6 + 1.4), 0.15 + 0.12 * Math.sin(t * 2.6 + 2.1), 0.15);
      R.x = 0.6 + 0.04 * Math.sin(t * 1.1); R.y = -0.28 + 0.05 * Math.sin(t * 1.5); R.z = 0; R.ang = -0.12; R.away = false;
      const ph = t % 9;
      if (ph < 6) { const c = COUNT[Math.floor(ph)]; setShape(R, c[1], c[2], c[3], c[4], c[0] ? 1 : 0); }
      else if (ph < 7.5) { setShape(R, 0, 0, 0, 0, 0); R.ang = -0.12 + 0.45 * Math.sin(t * 7); }
      else setShape(R, 0.45, 0, 0, 0, 0, 1);
      // жесты с клавиатуры
      if (Math.abs(I.moveZ || 0) > 0.05 || Math.abs(I.moveX || 0) > 0.05) { L.y += (I.moveZ || 0) * 0.4; L.x += (I.moveX || 0) * 0.3; setShape(L, 0, 0, 0, 0, 0); L.ang = 0; }
      if (I.shield) { L.x = -0.3; L.y = -0.12; L.z = -1.0; L.ang = 0; setShape(L, 0, 0, 0, 0, 0); }
      if (I.attack) { R.x = 0.48; R.y = -0.08; R.z = -0.45; R.ang = -0.2; setShape(R, 0.45, 0, 0, 0, 0, 1); }
      if ((I.charge || 0) > 0.05) setShape(R, 1, 1, 1, 1, 1);
      if (I.burst) { tm.burst = t; tm.burstBoth = I.burstHand === 'both'; }
      if (I.sigil === 'gate' || I.sigil === 'pillar') { tm.stretch = t; tm.stretchH = I.sigil === 'gate'; }   // [W3-MAGIC] растянуть ладони
      else if (I.sigil) tm.sigil = t;
      if (I.spark) tm.spark = t;
      if (I.slash) tm.slash = t;
      if (I.parry) tm.parry = t;
      if (I.dashDir) { tm.dash = t; tm.dashX = Math.sign(I.dashDir.x || 0) || -1; }
      if ((I.ultimate || I.ult) && !(opt && opt.ultByInput === false)) tm.ult = t;
      const sBurst = t - tm.burst, sSpark = t - tm.spark, sSlash = t - tm.slash, sParry = t - tm.parry, sDash = t - tm.dash, sSigil = t - tm.sigil, sUlt = t - tm.ult;
      if (sBurst < 0.7) {
        for (let s = tm.burstBoth ? 0 : 1; s < 2; s++) {
          const h = tgt[s];
          if (sBurst < 0.12) setShape(h, 1, 1, 1, 1, 1); else { setShape(h, 0, 0, 0, 0, 0); h.z = -1.1 * Math.max(0, 1 - (sBurst - 0.12) / 0.5); h.ang = 0; }
        }
      }
      if (sSpark < 0.35) { setShape(R, 0, 1, 1, 1, 1); R.ang = -0.2 + 0.5 * Math.sin(sSpark * 30); }
      if (sSlash < 0.4) { const k = sSlash / 0.4; R.x = 0.95 - 0.85 * k; R.y = 0.35 - 0.9 * k; R.ang = -0.9; setShape(R, 0, 0, 0, 0, 0); }
      if (sParry < 0.5) { if (sParry < 0.15) setShape(L, 1, 1, 1, 1, 1); else setShape(L, 0, 0, 0, 0, 0); L.z = -0.6; L.ang = 0; }
      if (sDash < 0.3) L.x += tm.dashX * 0.45 * Math.sin((sDash / 0.3) * Math.PI);
      if (I.conjure) {
        const c = clamp(I.conjure.charge || 0, 0, 1);
        L.x = -0.24 - 0.1 * c; L.y = -0.18; L.z = -0.5; L.ang = -0.55; setShape(L, 0.3, 0.3, 0.3, 0.3, 0.2);
        R.x = 0.24 + 0.1 * c; R.y = -0.18; R.z = -0.5; R.ang = 0.55; setShape(R, 0.3, 0.3, 0.3, 0.3, 0.2);
      }
      if (sSigil < 0.45) { const k = Math.sin((sSigil / 0.45) * Math.PI); L.x += (-0.06 - L.x) * k; R.x += (0.06 - R.x) * k; L.y = R.y = -0.08; L.ang = -0.2; R.ang = 0.2; setShape(L, 0, 0, 0, 0, 0); setShape(R, 0, 0, 0, 0, 0); }
      // [W3-MAGIC] заряд ладонями (X/G): ладони сомкнуты перед грудью; каст — растянуть в стороны или вверх-вниз
      const sc = clamp(+I.sigilCharge || 0, 0, 1), sStr = t - tm.stretch;
      if (sc > 0.02) { L.x = -0.075; R.x = 0.075; L.y = R.y = -0.12; L.z = R.z = -0.45; L.ang = -0.25; R.ang = 0.25; setShape(L, 0, 0, 0, 0, 0); setShape(R, 0, 0, 0, 0, 0); }
      if (sStr < 0.7) {
        const k = Math.min(1, sStr / 0.22);
        setShape(L, 0, 0, 0, 0, 0); setShape(R, 0, 0, 0, 0, 0); L.z = R.z = -0.4;
        if (tm.stretchH) { L.x = -0.075 - 0.85 * k; R.x = 0.075 + 0.85 * k; L.y = R.y = -0.12; L.ang = -0.25; R.ang = 0.25; }
        else { L.x = -0.09; R.x = 0.09; L.y = -0.12 - 0.5 * k; R.y = -0.12 + 0.75 * k; L.ang = -0.1; R.ang = 0.1; }
      }
      if (sUlt < 1.6) { L.x = -0.6; L.y = 1.95; L.ang = 0.12; R.x = 0.6; R.y = 1.95; R.ang = -0.12; setShape(L, 0, 0, 0, 0, 0); setShape(R, 0, 0, 0, 0, 0); }
      // плавно к цели (как живая рука), затем — кисти и локти
      const k = 1 - Math.exp(-dt / 0.085);
      for (let s = 0; s < 2; s++) {
        const c = cur[s], g = tgt[s];
        c.x += (g.x - c.x) * k; c.y += (g.y - c.y) * k; c.z += (g.z - c.z) * k; c.ang += (g.ang - c.ang) * k;
        for (let f = 0; f < 4; f++) c.curls[f] += (g.curls[f] - c.curls[f]) * k;
        c.thumbIn += (g.thumbIn - c.thumbIn) * k; c.pinch += (g.pinch - c.pinch) * k; c.away = g.away;
      }
      const br = 0.015 * Math.sin(t * 1.7);                       // дыхание
      T[J.LS * 3] = -0.5; T[J.LS * 3 + 1] = br; T[J.LS * 3 + 2] = 0;
      T[J.RS * 3] = 0.5; T[J.RS * 3 + 1] = br; T[J.RS * 3 + 2] = 0;
      T[J.HEAD * 3] = 0.03 * Math.sin(t * 0.6); T[J.HEAD * 3 + 1] = 0.82 + br; T[J.HEAD * 3 + 2] = 0;
      for (let s = 0; s < 2; s++) {
        const c = cur[s], w = s ? J.RW : J.LW, base = s ? J.HR : J.HL;
        T[w * 3] = c.x; T[w * 3 + 1] = c.y; T[w * 3 + 2] = c.z;
        buildHand(T, base * 3, s ? 'right' : 'left', c);
      }
      jOk.fill(0);
      jOk[J.LS] = jOk[J.RS] = jOk[J.HEAD] = jOk[J.LW] = jOk[J.RW] = 1;
      for (let i = 0; i < 21; i++) { jOk[J.HL + i] = 1; jOk[J.HR + i] = 1; }
      finishTargets();
    }
    return { step, reset() { tm.t = 0; }, ult() { tm.ult = tm.t; } };
  }

  // ------------------------------------------------------------ реакции
  function elemColors(heroId) {
    if (heroId === elemCache.hero) return;
    elemCache.hero = heroId;
    const fx = heroes && heroes[heroId] && heroes[heroId].fx ? heroes[heroId].fx : null;
    const c = new THREE.Color(fx && fx.color != null ? fx.color : COL_FALLBACK), c2 = new THREE.Color(fx && fx.color2 != null ? fx.color2 : (fx && fx.color) || COL_FALLBACK);
    st.colElem[0] = c.r; st.colElem[1] = c.g; st.colElem[2] = c.b;
    st.colElem2[0] = c2.r; st.colElem2[1] = c2.g; st.colElem2[2] = c2.b;
  }
  const _cM = new THREE.Color(COL_MISTAKE);
  function flashHand(side, mistake) {
    for (let s = side === 2 ? 0 : side, e = side === 2 ? 1 : side; s <= e; s++) {
      st.flash[s] = 1;
      const fc = st.flashCol[s];
      if (mistake) { fc[0] = _cM.r; fc[1] = _cM.g; fc[2] = _cM.b; } else { fc[0] = st.colElem[0]; fc[1] = st.colElem[1]; fc[2] = st.colElem[2]; }
      ring(s, mistake ? 0.5 : 0.65, 0.25, mistake ? 0.9 : 1.6, fc);
    }
  }
  function ring(side, dur, s0, s1, col) {
    let R = st.rings[0];
    for (const r of st.rings) { if (!r.on) { R = r; break; } if (r.t / r.dur > R.t / R.dur) R = r; }
    R.on = true; R.side = side; R.t = 0; R.dur = dur; R.s0 = s0; R.s1 = s1; R.r = col[0] * 1.1; R.g = col[1] * 1.1; R.b = col[2] * 1.1;
  }
  // [W3-MAGIC] каст «магии ладонями»: щель света во весь размах по оси растяжения
  function castSlit(axis) {
    if (slitCool > 0) return;                 // импульс ввода и событие боя приходят в соседних кадрах — одна вспышка
    slitCool = 0.35;
    st.slit = 1; st.slitH = axis === 'v' ? 0 : 1;
    flashHand(2);
    ring(2, 0.7, 0.3, 2.6, st.colElem2);
  }
  function triggerUlt() {
    if (ultCool > 0) return;
    ultCool = 1.2; st.ult = 1;
    ring(0, 0.9, 0.3, 2.2, st.colElem); ring(1, 0.9, 0.3, 2.2, st.colElem); ring(3, 1.1, 0.4, 3.2, st.colElem2);
  }

  function react(dt, ctx) {
    const I = ctx.input || null, snap = ctx.snapshot || null, ev = Array.isArray(ctx.events) ? ctx.events : null;
    const pl = snap && snap.player ? snap.player : null;
    elemColors(ctx.hero || (liveSettings && liveSettings.hero) || 'ashen');
    // распознанные жесты — по импульсам ввода (они же на обучении); удержания — по началу
    if (I && I.valid !== false) {
      const atk = !!I.attack, shd = !!I.shield, cj = !!I.conjure;
      if (atk && !edge.attack) flashHand(1);
      if (shd && !edge.shield) flashHand(0);
      if (cj && !edge.conjure) flashHand(2);
      edge.attack = atk; edge.shield = shd; edge.conjure = cj;
      if (I.spark || I.slash || I.rune || (I.bow && I.bow.release) || (I.handSpell && I.handSpell.phase === 'throw')) flashHand(1);
      if (I.parry || I.dashDir || I.dash) flashHand(0);
      if (I.burst) flashHand(I.burstHand === 'both' ? 2 : 1);
      if (I.sigil === 'gate' || I.sigil === 'pillar') castSlit(I.sigil === 'gate' ? 'h' : 'v');   // [W3-MAGIC] «Врата бури» / «Столп небес»
      else if (I.sigil || I.throw) flashHand(2);
      // «ОШИБКА»: короткая красная вспышка на руке, к которой относится подсказка
      const h = I.hint && I.hint.code ? I.hint : null;
      if (h && (h.code !== edge.hintCode || h.side !== edge.hintSide)) flashHand(h.side === 'left' ? 0 : h.side === 'right' ? 1 : 2, true);
      edge.hintCode = h ? h.code : null; edge.hintSide = h ? h.side : null;
    } else { edge.attack = false; edge.shield = false; edge.conjure = false; }
    // события боя: удар по щиту, ультимейт «Небесный суд» (ultimate_start — сцена, ultimate_strike — удар), победа
    if (ev) for (const e of ev) {
      const ty = e && e.type;
      if (!ty) continue;
      if (ty === 'block') st.shieldHit = 1;
      else if (ty === 'ultimate_start' || ty === 'ultimate' || ty === 'victory') { triggerUlt(); if (source === 'synth' && ty !== 'victory') syn.ult(); }
      else if (ty === 'ultimate_strike') { st.ult = 1; ring(3, 1.0, 0.5, 3.6, st.colElem2); }
      else if (ty === 'ultimate_ready') { st.ready = 1; ring(3, 0.8, 0.4, 2.0, st.colElem2); }   // [W3-ULT] шкала полна — нимб зовёт
      else if (ty === 'ultimate_end') { st.ult = Math.min(st.ult, 0.5); ring(3, 0.9, 0.5, 1.7, st.colElem); }   // [W3-ULT] выдох: руки опускаются
      else if (ty === 'sigil_cast') { const sg = e.data && e.data.sigil; if (sg === 'gate' || sg === 'pillar') castSlit(sg === 'gate' ? 'h' : 'v'); else flashHand(2); }   // [W3-MAGIC]
      else if (ty === 'perfect_dodge') flashHand(0);
    }
    // шкала ультимейта есть (player.fury) — полная: нимб пульсирует «руки вверх!»; идёт сцена — руки духа подняты
    const furySys = !!(pl && fin(pl.fury));
    st.ready = approach(st.ready, pl && pl.furyReady ? 1 : 0, dt, 0.2, 0.3);
    const cineOn = !!(snap && snap.ultimate && snap.ultimate.active);
    if (cineOn) st.ult = Math.max(st.ult, 0.75);
    st.cine = approach(st.cine, cineOn ? 1 : 0, dt, 0.25, 0.6);
    // руки вверх ~0,5 с — дух поднимает руки и светится; без шкалы ультимейта — ещё и вспыхивает
    const headY = P[J.HEAD * 3 + 1];
    const handsUp = presence > 0.5 && jA[J.LW] > 0.6 && jA[J.RW] > 0.6 && P[J.LW * 3 + 1] > headY + 0.1 && P[J.RW * 3 + 1] > headY + 0.1;
    st.up = clamp(st.up + (handsUp ? dt / 0.5 : -dt / 0.25), 0, 1);   // ~0,5 с удержания
    if (st.up >= 1 && !upLatch) { upLatch = true; if (!furySys) triggerUlt(); }
    if (st.up < 0.3) upLatch = false;
    ultCool = Math.max(0, ultCool - dt);
    st.ult = Math.max(0, st.ult - dt / 1.6);
    // щит — купол в левой ладони
    const shieldOn = !!(I && I.shield) || !!(pl && pl.shielding);
    const wasOff = st.shield < 0.05;
    st.shield = approach(st.shield, shieldOn ? 1 : 0, dt, 0.08, 0.22);
    if (shieldOn && wasOff) chargeT = 0;
    st.shieldPop = shieldOn ? 1 + 0.25 * Math.exp(-chargeT * 9) * Math.sin(chargeT * 18) : 1;
    chargeT += dt;
    st.shieldHit = Math.max(0, st.shieldHit - dt * 3);
    // заряд между ладонями: player.sigilCharge (новые магии), сфера/призма двумя руками
    let ch = 0;
    if (pl && fin(pl.sigilCharge)) ch = Math.max(ch, pl.sigilCharge);
    if (I && fin(I.sigilCharge)) ch = Math.max(ch, I.sigilCharge);
    if (I && I.conjure) ch = Math.max(ch, 0.25 + 0.75 * clamp(+I.conjure.charge || 0, 0, 1));
    if (pl && pl.conjure) ch = Math.max(ch, 0.25 + 0.75 * clamp(+pl.conjure.charge || 0, 0, 1));
    st.charge = approach(st.charge, clamp(ch, 0, 1), dt, 0.1, 0.3);
    // [W3-MAGIC] ось растяжения: 'h' — щель по горизонтали («Врата бури»), 'v' — по вертикали («Столп небес»)
    const axOf = (o) => (o && (o.sigilAxis === 'h' || o.sigilAxis === 'v') ? o.sigilAxis : null);
    const ax = axOf(pl) || axOf(I);
    st.axisH = approach(st.axisH, ax === 'h' ? 1 : 0, dt, 0.08, 0.25);
    st.axisV = approach(st.axisV, ax === 'v' ? 1 : 0, dt, 0.08, 0.25);
    if (ax) st.slitH = ax === 'h' ? 1 : 0;
    st.slit = Math.max(0, st.slit - dt / 0.6);
    slitCool = Math.max(0, slitCool - dt);
    for (let s = 0; s < 2; s++) st.flash[s] = Math.max(0, st.flash[s] * Math.exp(-dt * (st.rm ? 6 : 3.2)) - dt * 0.05);
    arcT -= dt;
    if (arcT <= 0 && !st.rm) { arcT = 0.055; st.arcSeed = 1 + ((st.arcSeed * 48271) % 2147483646); }   // «Уменьшенное движение» — молнии не мерцают
  }

  // ------------------------------------------------------------ кадр
  function frame(dt, now, ctx = {}) {
    if (disposed) return;
    try { frameInner(dt, now, ctx); } catch (e) {
      if (now - warnAt > 5000) { warnAt = now; console.warn('[W3-SPIRIT] дух игрока:', e); }
    }
  }

  function frameInner(dt, now, ctx) {
    dt = fin(dt) ? clamp(dt, 0, 0.1) : 0;
    if (!fin(now)) now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (ctx.settings) liveSettings = ctx.settings;
    const S = liveSettings || {};
    const on = enabled && S.spiritAvatar !== false;
    quality = QUALITY[S.quality] ? S.quality : 'medium';
    st.rm = !!S.reducedMotion;
    st.time += dt;
    const screen = ctx.screen || 'playing';
    const present = ctx.present !== undefined ? !!ctx.present : hasDom && !!document.documentElement && document.documentElement.classList.contains('ao-present');
    // выключен в настройках и уже погас — не тратим кадр (холст в превью освободится сам)
    if (!on && skyA < 0.003 && frameA < 0.003 && warm <= 0) { skyA = frameA = 0; sky.root.visible = false; frameTick(now, 0, ctx); return; }

    // источник: синтетика в отладке, иначе камера
    let live = false;
    if (ctx.debug) {
      if (source !== 'synth') { source = 'synth'; syn.reset(); }
      const furySys = !!(ctx.snapshot && ctx.snapshot.player && fin(ctx.snapshot.player.fury));
      syn.step(dt, ctx.input, { ultByInput: !furySys });
      live = true;
    } else {
      if (source !== 'camera') { source = 'camera'; isoInit.fill(0); ref.ok = false; }
      live = readVision(now, ctx);
      if (live) solveFromCamera(now); else { jOk.fill(0); finishTargets(); }
    }
    presence = approach(presence, live ? 1 : 0, dt, 0.25, 0.5);
    // показ: плавно к цели; пропавшие точки — медленнее (к покою)
    const kOk = 1 - Math.exp(-dt / 0.045), kLost = 1 - Math.exp(-dt / 0.28);
    for (let j = 0; j < N; j++) {
      const k = jOk[j] ? kOk : kLost;
      for (let c = 0; c < 3; c++) P[j * 3 + c] += (T[j * 3 + c] - P[j * 3 + c]) * k;
      const hand = j >= J.HL;
      const base = j === J.NECK || j === J.PELVIS || j === J.LH || j === J.RH || j === J.HEAD ? 1 : hand ? 0.3 : 0.4;
      jA[j] = approach(jA[j], jOk[j] ? 1 : base, dt, 0.12, 0.3);
    }
    // плечи и шея держат корпус: если их нет — гаснут вместе с духом
    for (let s = 0; s < 2; s++) handA[s] = jA[s ? J.HR : J.HL];
    // ультимейт: дух поднимает руки, даже если игрок поднял их не до конца
    const w = Math.min(1, st.ult * 1.6);
    if (w > 0.001) {
      for (let a = 0; a < ARM_JOINTS.length; a++) { const j = ARM_JOINTS[a]; for (let c = 0; c < 3; c++) P[j * 3 + c] += (RAISED[j * 3 + c] - P[j * 3 + c]) * w * 0.35; }
      for (let i = J.HL; i < N; i++) for (let c = 0; c < 3; c++) P[i * 3 + c] += (RAISED[i * 3 + c] - P[i * 3 + c]) * w * 0.35;
    }
    st.headR = clamp(source === 'camera' ? ref.headR / Math.max(0.05, ref.sw) : 0.36, 0.22, 0.48);
    // ладони
    palmOf(P, J.HL, st.palmL); palmOf(P, J.HR, st.palmR);
    st.chargeBoth = jA[J.HL] > 0.5 && jA[J.HR] > 0.5;
    if (st.chargeBoth) { for (let c = 0; c < 3; c++) st.chargePos[c] = (st.palmL[c] + st.palmR[c]) / 2; }
    else { st.chargePos[0] = P[J.NECK * 3]; st.chargePos[1] = P[J.NECK * 3 + 1] - 0.55; st.chargePos[2] = P[J.NECK * 3 + 2] - 0.5; }
    react(dt, ctx);
    // кольца следуют за ладонью/головой
    for (const R of st.rings) {
      if (!R.on) continue;
      R.t += dt;
      if (R.t >= R.dur) { R.on = false; continue; }
      const p = R.side === 0 ? st.palmL : R.side === 1 ? st.palmR : R.side === 2 ? st.chargePos : null;
      if (p) { R.x = p[0]; R.y = p[1]; R.z = p[2] - 0.05; }
      else { R.x = P[J.NECK * 3]; R.y = P[J.NECK * 3 + 1] + 0.2; R.z = P[J.NECK * 3 + 2]; }
    }
    colors();
    trails(dt);

    // где виден
    const wantSky = on && SKY_SCREENS.has(screen) && !!camera;
    const wantFrame = on && (FRAME_SCREENS.has(screen) || (present && PRESENT_SLOT_SCREENS.has(screen)));
    skyA = approach(skyA, wantSky ? 1 : 0, dt, 0.35, 0.3);
    frameA = approach(frameA, wantFrame ? 1 : 0, dt, 0.25, 0.25);
    const flare = 1 + 0.55 * st.ult + 0.25 * st.up;
    // над ареной
    const skyAlpha = skyA * presence * (present ? 0.85 : 0.55) * flare * (1 - 0.45 * st.cine);   // [W3-ULT] в сцене — приглушён
    skyDt = dt;
    if (warm > 0) { warm--; sky.root.visible = true; placeSky(ctx, present); writeRig(sky, 0, skyView); }
    else if (skyAlpha > 0.003) { sky.root.visible = true; placeSky(ctx, present); writeRig(sky, skyAlpha, skyView); }
    else sky.root.visible = false;
    // в кадре
    const frameAlpha = frameA * presence * (present ? 1.25 : 1) * flare;
    frameTick(now, frameAlpha, ctx);
  }

  // цвета групп: дух голубой, руки чуть тонированы (левая — синяя, правая — тёплая, как на превью) + вспышки
  const _cb = new THREE.Color(COL_BASE), _cl = new THREE.Color(COL_LEFT), _cr = new THREE.Color(COL_RIGHT);
  function groupColor(g, tint, k, fl, fc) {
    const G = st.gCol, bo = 1 + 0.45 * st.ult;
    const r = _cb.r + (tint.r - _cb.r) * k, gg = _cb.g + (tint.g - _cb.g) * k, b = _cb.b + (tint.b - _cb.b) * k;
    G[g * 3] = (r + (fc[0] * 1.5 - r) * fl) * bo; G[g * 3 + 1] = (gg + (fc[1] * 1.5 - gg) * fl) * bo; G[g * 3 + 2] = (b + (fc[2] * 1.5 - b) * fl) * bo;
  }
  function colors() {
    const G = st.gCol, E = st.colElem, bo = 1 + 0.45 * st.ult, f0 = st.flash[0], f1 = st.flash[1];
    // корпус чуть окрашен стихией героя
    G[0] = (_cb.r * 0.82 + E[0] * 0.18) * bo; G[1] = (_cb.g * 0.82 + E[1] * 0.18) * bo; G[2] = (_cb.b * 0.82 + E[2] * 0.18) * bo;
    groupColor(G_ARM_L, _cl, 0.25, f0 * 0.6, st.flashCol[0]); groupColor(G_ARM_R, _cr, 0.25, f1 * 0.6, st.flashCol[1]);
    groupColor(G_HAND_L, _cl, 0.35, f0, st.flashCol[0]); groupColor(G_HAND_R, _cr, 0.35, f1, st.flashCol[1]);
  }

  // шлейф-призрак: история кончиков пальцев и запястий в координатах тела
  function trails(dt) {
    const ns = st.rm ? 0 : (QUALITY[quality] || QUALITY.medium).trail;
    if (ns !== st.trailN) { st.trailN = ns; st.trailFill = 0; }
    if (ns < 2) return;
    st.trailAcc += dt;
    if (st.trailAcc < 1 / 60 && st.trailFill > 0) return;
    st.trailAcc = 0;
    st.trailHead = (st.trailHead + 1) % NS_MAX;
    const H = st.trail, h = st.trailHead;
    for (let t = 0; t < NT; t++) {
      const j = TRAIL_J[t], side = t < 5 || t === 10 ? 0 : 1;
      const a = Math.min(jA[j], handA[side] > 0.5 ? 1 : 0.5) * (t >= 10 ? 0.6 : 1);
      const o = (t * NS_MAX + h) * 3;
      const prev = (t * NS_MAX + (h - 1 + NS_MAX) % NS_MAX) * 3;
      H[o] = P[j * 3]; H[o + 1] = P[j * 3 + 1]; H[o + 2] = P[j * 3 + 2];
      // пропуск, скачок или первый кадр — шлейф начинается заново (без длинной полосы через экран)
      const jump = st.trailFill > 0 && Math.hypot(H[o] - H[prev], H[o + 1] - H[prev + 1]) > 0.6;
      if (st.trailFill === 0 || jump || jA[j] < 0.35) for (let i = 0; i < NS_MAX; i++) { const q = (t * NS_MAX + i) * 3; H[q] = H[o]; H[q + 1] = H[o + 1]; H[q + 2] = H[o + 2]; }
      st.trailA[t] = a;
    }
    st.trailFill = Math.min(ns, st.trailFill + 1);
  }

  // ------------------------------------------------------------ над ареной: в небе справа от Регента
  // Корень висит на камере игры: постоянный размер на экране, за Регентом по глубине (он всегда ближе).
  let skyNy = 0.36, skyDt = 0;
  const skyView = { alpha: 0, px: 600, scale: 1, depthTest: true, q: 'medium', lowPointSize: 1, thick: 1, headK: 0.75, bodyK: 1, auraK: 1, handK: 1.3, haloTilt: -0.55 };
  function placeSky(ctx, present) {
    if (!camera) return;
    const fov = (camera.fov || 58) * Math.PI / 180, tanH = Math.tan(fov / 2), aspect = camera.aspect || 16 / 9;
    // [W3-ULT] дальше и Регента, и героя: в бою камера за героем, а облёт «Небесного суда» может встать перед ним —
    // дух всё равно позади обоих (и тест глубины прячет его за ними), между камерой и героем он не встаёт
    let dFar = 14;
    const snap = ctx.snapshot;
    camera.getWorldPosition(_v);
    const bp = snap && snap.boss && snap.boss.position, hp = snap && snap.player && snap.player.position;
    if (bp && fin(bp.x) && fin(bp.z)) dFar = Math.hypot(bp.x - _v.x, (bp.y || 0) + 3 - _v.y, bp.z - _v.z);
    if (hp && fin(hp.x) && fin(hp.z)) dFar = Math.max(dFar, Math.hypot(hp.x - _v.x, (hp.y || 0) + 1.2 - _v.y, hp.z - _v.z));
    const D = clamp(dFar + 9, 20, 60);
    const scale = SPIRIT_SW * (D / 20) * (present ? 0.85 : 1);
    // верх духа (голова или поднятые кисти) — не выше 0,9 высоты кадра: руки вверх — дух опускается
    let top = P[J.HEAD * 3 + 1] + 0.45;
    for (let s = 0; s < 2; s++) { const w = s ? J.RW : J.LW, tip = (s ? J.HR : J.HL) + 12; top = Math.max(top, P[w * 3 + 1] + (P[tip * 3 + 1] - P[w * 3 + 1]) * skyView.handK + 0.15); }
    const kNdc = scale / (D * tanH);
    skyNy += (Math.min(0.36, 0.9 - top * kNdc) - skyNy) * (1 - Math.exp(-skyDt / 0.35));
    const nx = present ? 0.5 : 0.42, ny = skyNy;
    sky.root.position.set(nx * tanH * aspect * D, ny * tanH * D, -D);
    sky.root.quaternion.identity();
    sky.root.scale.set(scale, scale, scale);   // z > 0: «к веб-камере» — в глубину, к Регенту (дух к нам спиной)
    let h = 720;
    if (renderer) { renderer.getDrawingBufferSize(_vs); h = _vs.y || h; }
    skyView.px = h / (2 * tanH);
    skyView.scale = scale;
    skyView.lowPointSize = (0.1 * scale) / tanH;
    skyView.q = quality;
  }

  function writeRig(rig, alpha, view) {
    view.alpha = alpha;
    st.viewAlpha = alpha;
    rig.write(st, view);
  }

  // ------------------------------------------------------------ в кадре: свой холст в слоте превью камеры
  // в кадре кости тоньше (поверх рук на видео), сфера головы почти прозрачна — лицо игрока видно
  const frameView = { alpha: 0, px: 400, scale: 1, depthTest: false, q: 'medium', lowPointSize: 4, thick: 0.7, headK: 0.22, bodyK: 0.35, auraK: 0.4, handK: 1, haloTilt: -1.2 };
  function frameTick(now, alpha, ctx) {
    if (alpha <= 0.003) {
      if (fr) {
        if (fr.canvas.style.display !== 'none') { fr.canvas.style.display = 'none'; frameHiddenAt = now; }
        else if (now - frameHiddenAt > 4000) disposeFrame();   // давно не нужен — освободить контекст
      }
      return;
    }
    if (!allowFrameRenderer) { frameView.q = quality; writeFrameState(alpha, ctx); return; }
    if (!slot) slot = document.getElementById('ui-camera-slot');
    if (!slot) return;
    if (!fr && !createFrame()) return;
    if (fr.canvas.parentNode !== slot) attachCanvas();
    const cw = fr.canvas.clientWidth | 0, ch = fr.canvas.clientHeight | 0;
    if (fr.canvas.style.display === 'none') fr.canvas.style.display = '';
    if (cw < 16 || ch < 16) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, quality === 'high' ? 2 : 1.5);
    if (fr.w !== cw || fr.h !== ch || fr.dpr !== dpr) { fr.w = cw; fr.h = ch; fr.dpr = dpr; fr.renderer.setPixelRatio(dpr); fr.renderer.setSize(cw, ch, false); }
    // прямоугольник видео «contain» (как video и trackingHud)
    const asp = ref.asp || 4 / 3;
    let rw, rh, rx, ry;
    if (cw / ch > asp) { rh = ch; rw = ch * asp; rx = (cw - rw) / 2; ry = 0; } else { rw = cw; rh = cw / asp; rx = 0; ry = (ch - rh) / 2; }
    writeFrameState(alpha, ctx, rh * dpr);
    fr.renderer.setViewport(rx, ch - ry - rh, rw, rh);
    fr.renderer.render(fr.scene, fr.cam);
  }
  function writeFrameState(alpha, ctx, pxH = 400) {
    const rig = fr ? fr.rig : null;
    if (!rig) { frameView.alpha = alpha; return; }
    // координаты тела → кадр: без камеры (отладка) — дух по центру превью
    const asp = ref.asp || 4 / 3;
    const real = source === 'camera' && ref.ok;
    const sw = real ? ref.sw : 0.3, cx = real ? ref.x : asp * 0.5, cy = real ? ref.y : 0.42;
    fr.cam.left = 0; fr.cam.right = asp; fr.cam.top = 0; fr.cam.bottom = -1; fr.cam.updateProjectionMatrix();
    rig.root.position.set(cx, -cy, 0);
    rig.root.scale.set(sw, sw, -sw);          // лицом к игроку: «к веб-камере» — к зрителю
    frameView.px = pxH;
    frameView.scale = sw;
    frameView.lowPointSize = 0.1 * sw * pxH / (fr.dpr || 1);
    frameView.q = quality;
    writeRig(rig, alpha, frameView);
  }
  function createFrame() {
    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'ao-spirit-frame';
      canvas.setAttribute('aria-hidden', 'true');
      // поверх видео, под рисунком трекинг-HUD; «экран» — чёрное прозрачно, свет складывается с видео
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;mix-blend-mode:screen;';
      const r = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
      r.setClearColor(0x000000, 1);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.toneMapping = THREE.NoToneMapping;
      const sc = new THREE.Scene();
      const cam = new THREE.OrthographicCamera(0, 4 / 3, 0, -1, -10, 10);
      cam.position.set(0, 0, 5);
      const rig = createRig(THREE, 'spirit-frame');
      sc.add(rig.root);
      fr = { canvas, renderer: r, scene: sc, cam, rig, w: 0, h: 0, dpr: 0 };
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); disposeFrame(); }, { once: true });
      attachCanvas();
      if (typeof r.compileAsync === 'function') r.compileAsync(sc, cam).catch(() => {});
      return true;
    } catch (e) {
      console.warn('[W3-SPIRIT] холст духа в превью недоступен:', e && e.message);
      fr = null;
      return false;
    }
  }
  function attachCanvas() {
    const ov = overlayEl && overlayEl.parentNode === slot ? overlayEl : slot.querySelector('#ao-overlay');
    if (ov) slot.insertBefore(fr.canvas, ov); else slot.appendChild(fr.canvas);
  }
  function disposeFrame() {
    if (!fr) return;
    const f = fr; fr = null;
    try { f.rig.dispose(); } catch (e) { /* ignore */ }
    try { f.renderer.dispose(); if (typeof f.renderer.forceContextLoss === 'function') f.renderer.forceContextLoss(); } catch (e) { /* ignore */ }
    if (f.canvas.parentNode) f.canvas.parentNode.removeChild(f.canvas);
  }

  // ------------------------------------------------------------ API
  const api = {
    frame,
    /** Для тестов и стендов: кадр по готовым данным { pose, hands, now, status?, input?, events?, snapshot?, screen?, debug? }. */
    update(dt, data = {}) { frame(dt, data.now, { screen: 'playing', ...data }); },
    setEnabled(v) { enabled = v !== false; },
    setQuality(q) { if (QUALITY[q]) { liveSettings = { ...(liveSettings || {}), quality: q }; } },
    get root() { return sky.root; },
    get frameRig() { return fr ? fr.rig : null; },
    /** Для теста утечек: все геометрии, материалы и текстуры духа (освобождаются в dispose). */
    resources() { return [...sky.owned, ...(fr ? fr.rig.owned : [])]; },
    info() {
      const j = (k) => ({ x: +P[k * 3].toFixed(3), y: +P[k * 3 + 1].toFixed(3), z: +P[k * 3 + 2].toFixed(3) });
      let fl = 0, fr2 = 0;
      for (let i = 0; i < 21; i++) { if (jA[J.HL + i] > 0.6) fl++; if (jA[J.HR + i] > 0.6) fr2++; }
      return {
        source, quality, presence: +presence.toFixed(3), alpha: +(skyA * presence).toFixed(3), frameAlpha: +(frameA * presence).toFixed(3),
        skyVisible: sky.root.visible, frameCanvas: !!fr, fingers: { left: fl, right: fr2 },
        joints: { leftShoulder: j(J.LS), rightShoulder: j(J.RS), leftElbow: j(J.LE), rightElbow: j(J.RE), leftWrist: j(J.LW), rightWrist: j(J.RW), head: j(J.HEAD), leftIndexTip: j(J.HL + 8), rightIndexTip: j(J.HR + 8) },
        flash: [+st.flash[0].toFixed(3), +st.flash[1].toFixed(3)], shield: +st.shield.toFixed(3), charge: +st.charge.toFixed(3),
        ult: +st.ult.toFixed(3), up: +st.up.toFixed(3), ready: +st.ready.toFixed(3), rings: st.rings.filter((r) => r.on).length, trail: st.trailN,
        axis: st.axisH > 0.5 ? 'h' : st.axisV > 0.5 ? 'v' : null, slit: +st.slit.toFixed(3), slitH: st.slitH, cine: +st.cine.toFixed(3), arcSeed: st.arcSeed,   // [W3-MAGIC] [W3-ULT]
        skyDepth: +(-sky.root.position.z).toFixed(2),
        tier: sky.tier, elem: [+st.colElem[0].toFixed(3), +st.colElem[1].toFixed(3), +st.colElem[2].toFixed(3)],
        flashColor: [Array.from(st.flashCol[0], (v) => +v.toFixed(3)), Array.from(st.flashCol[1], (v) => +v.toFixed(3))],
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sky.dispose();
      disposeFrame();
    },
  };
  if (hasDom) { try { window.__ashenSpirit = api; } catch (e) { /* ignore */ } }   // QA: __ashenSpirit.info()
  return api;
}
