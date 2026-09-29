// ASHEN OATH — modules/fx/kit.js. Владелец: №7 [VFX].
// Общая база эффектов V6 («больше магии»): всё, из чего собираются руны, печати, лук и удары.
//
//  - GPU-частицы: один InstancedMesh (квад на частицу), вся физика — в вершинном шейдере
//    (снос с сопротивлением, гравитация, турбулентность, закрутка вокруг оси, земля). CPU пишет
//    атрибуты только в момент рождения (кольцевой буфер + addUpdateRange), каждый кадр — одна
//    uniform uTime. Цвет по жизни — строка градиентной текстуры (RAMP), форма — атлас спрайтов.
//    Аддитив и «обычные» (дым, пыль, осколки) — один проход с премультипликацией.
//  - вспышки: те же частицы (спрайты glow/flare/star/ring), HDR-яркость, подтяжка к камере;
//  - свет: пул 0–3 PointLight (low — нет), огибающая вспышки, слежение за точкой;
//  - акторы и таймлайн: after(sec, fn), actor({dur, update, end}) — в боевом времени эффектов;
//  - экранная вспышка (один кадр молнии), тряска/толчок камеры и хит-стоп — через колбэки effects.js.
//
// createFxKit(deps) → kit. Ничего не рендерит сам, ничего не делает с камерой.

import { FX_OUT, FX_SRGB, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

export const KIT_VERSION = 'ASHEN_V6-fx-1';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);

// Уровни качества V6. particles — ёмкость GPU-пула (вместе со старыми пулами effects.js ≤ 6000 на medium).
export const KIT_QUALITY = Object.freeze({
  low: Object.freeze({ name: 'low', particles: 1400, decor: 0.45, lights: 0, distort: false, glyphDetail: 0, trails: 8, screen: 0.7 }),
  medium: Object.freeze({ name: 'medium', particles: 4200, decor: 0.8, lights: 2, distort: true, glyphDetail: 1, trails: 16, screen: 1 }),
  high: Object.freeze({ name: 'high', particles: 8000, decor: 1.0, lights: 3, distort: true, glyphDetail: 2, trails: 24, screen: 1 }),
});
const MAX_PARTICLES = KIT_QUALITY.high.particles;

// ---------------------------------------------------------------- градиенты (цвет и альфа по жизни)
// Каждая строка — 64 точки sRGB + альфа. Узлы: [t, hex, alpha].
const RAMP_W = 64, RAMP_ROWS = 48;
const E = ELEMENTS;
const RAMP_DEFS = {
  fire:    [[0, 0xfff6e0, 1], [0.12, 0xffd070, 1], [0.35, 0xff7a1e, 0.95], [0.65, 0xc2300c, 0.6], [1, 0x3a1810, 0]],
  flame:   [[0, 0xffffff, 0.2], [0.08, 0xfff0c0, 1], [0.3, 0xffa030, 1], [0.7, 0xe0400c, 0.55], [1, 0x601008, 0]],
  ember:   [[0, 0xffe2a0, 1], [0.3, 0xff8a2a, 1], [0.75, 0xc8340c, 0.8], [1, 0x501008, 0]],
  storm:   [[0, 0xffffff, 1], [0.15, 0xd8f2ff, 1], [0.5, 0x6ab8ff, 0.8], [1, 0x2030a0, 0]],
  heal:    [[0, 0xfffbe8, 1], [0.25, 0xffe38a, 1], [0.6, 0xa8f07a, 0.8], [1, 0x2f9a58, 0]],
  star:    [[0, 0xffffff, 1], [0.2, 0xffe6b0, 1], [0.55, 0xff9a70, 0.8], [1, 0x7a3cff, 0]],
  wind:    [[0, 0xf4fffa, 0.9], [0.3, 0xc6f5e4, 0.8], [0.7, 0x7fc8b8, 0.5], [1, 0x4a6a66, 0]],
  eternal: [[0, 0xffffff, 1], [0.25, 0xffe9a8, 1], [0.6, 0xf2b0ff, 0.8], [1, 0x6a3cc0, 0]],
  frost:   [[0, 0xffffff, 1], [0.2, 0xdaf8ff, 1], [0.6, 0x7fd0ff, 0.8], [1, 0x2f5fb0, 0]],
  void:    [[0, 0xfbeaff, 1], [0.2, 0xd8a0ff, 1], [0.55, 0x8a3cf0, 0.85], [1, 0x200640, 0]],
  time:    [[0, 0xffffff, 1], [0.25, 0xd0eeff, 1], [0.65, 0x7ab0e0, 0.7], [1, 0x28406a, 0]],
  reset:   [[0, 0xffffff, 1], [0.3, 0xfff0c0, 1], [0.7, 0x8ab4ff, 0.7], [1, 0x3050c0, 0]],
  gold:    [[0, 0xfff3d6, 1], [0.3, 0xffcf80, 1], [0.7, 0xe8a14a, 0.75], [1, 0x8a4020, 0]],
  rival:   [[0, 0xffffff, 1], [0.25, 0xe0ccff, 1], [0.6, 0x9a6bff, 0.8], [1, 0x3a1a8a, 0]],
  blood:   [[0, 0xff6a50, 1], [0.3, 0xc01c10, 1], [1, 0x400806, 0]],
  // «обычные» (blend:'alpha'): тёмные, мягкое появление и уход
  smoke:   [[0, 0x6a625a, 0], [0.15, 0x4a4440, 0.55], [0.6, 0x2c2a28, 0.4], [1, 0x1a1a1a, 0]],
  firesmoke: [[0, 0x803010, 0], [0.12, 0x3a2418, 0.6], [0.6, 0x221c18, 0.45], [1, 0x121212, 0]],
  ash:     [[0, 0xff9a40, 1], [0.15, 0x4a4038, 0.9], [1, 0x2a2622, 0]],
  dust:    [[0, 0x9c968c, 0], [0.1, 0x8a8278, 0.6], [1, 0x5a544e, 0]],
  stone:   [[0, 0x8a8680, 1], [0.8, 0x6a665e, 1], [1, 0x4a4640, 0]],
  wood:    [[0, 0x9a6a3a, 1], [0.8, 0x6a4424, 1], [1, 0x3a2412, 0]],
  leaf:    [[0, 0x8aa040, 1], [0.5, 0x6a7a2a, 1], [1, 0x4a4a1a, 0]],
  frostsmoke: [[0, 0xe8f8ff, 0], [0.15, 0xc0e0f0, 0.45], [1, 0x6a8aa0, 0]],
  voidsmoke: [[0, 0x6a3aa0, 0], [0.15, 0x2a1440, 0.6], [1, 0x0a0612, 0]],
  white:   [[0, 0xffffff, 1], [1, 0xffffff, 0]],
  whiteHold: [[0, 0xffffff, 1], [0.7, 0xffffff, 1], [1, 0xffffff, 0]],
};
const RAMP_IDS = Object.keys(RAMP_DEFS);
const RAMP_CUSTOM0 = RAMP_IDS.length; // дальше — строки по hex, по требованию

// ---------------------------------------------------------------- атлас спрайтов (4×4 клетки по 64 px, R = маска)
export const SPRITES = Object.freeze({
  dot: 0, glow: 1, spark: 2, streak: 3, smoke: 4, star: 5, petal: 6, leaf: 7,
  shard: 8, ember: 9, ring: 10, rune: 11, flame: 12, wisp: 13, debris: 14, flake: 15,
});
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) { let s = 0, a = 0.5; for (let i = 0; i < 4; i++) { s += a * vnoise(x, y); x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; a *= 0.5; } return s; }
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// u,v ∈ [-1,1]; возвращает маску 0..1
const SPRITE_FN = [
  (u, v) => { const d = u * u + v * v; return Math.exp(-d * 4.5) * (1 - smooth(0.85, 1, Math.sqrt(d))); },                  // dot
  (u, v) => { const d = Math.sqrt(u * u + v * v); return Math.pow(sat(1 - d), 2.2); },                                     // glow
  (u, v) => { const d = Math.sqrt(u * u + v * v); return sat(Math.exp(-d * d * 60) * 1.2 + Math.pow(sat(1 - d), 3) * 0.45); }, // spark
  (u, v) => { const d = Math.sqrt(u * u * 0.9 + v * v * 9); return Math.pow(sat(1 - d), 1.6) * (1 - smooth(0.7, 1, Math.abs(u))); }, // streak
  (u, v) => { const d = Math.sqrt(u * u + v * v); const n = fbm(u * 2.2 + 5, v * 2.2 + 9); return sat((1 - smooth(0.25, 1, d + (n - 0.5) * 0.7)) * (0.55 + 0.6 * n)) * (1 - smooth(0.8, 0.98, d)); }, // smoke
  (u, v) => { const d = Math.sqrt(u * u + v * v); const r = Math.exp(-Math.abs(u) * 14) * sat(1 - Math.abs(v)) + Math.exp(-Math.abs(v) * 14) * sat(1 - Math.abs(u)); return sat(Math.pow(sat(1 - d), 3) * 0.9 + r * 0.8 * sat(1 - d * 0.85)); }, // star
  (u, v) => { const y = (v + 1) * 0.5; const w = Math.sin(Math.PI * Math.pow(sat(y), 0.8)) * 0.62; const e = Math.abs(u) / Math.max(1e-3, w); return sat((1 - smooth(0.7, 1, e)) * (0.7 + 0.3 * y)) * (y < 0.98 ? 1 : 0); }, // petal
  (u, v) => { const y = (v + 1) * 0.5; const w = Math.sin(Math.PI * sat(y)) * 0.5; const e = Math.abs(u) / Math.max(1e-3, w); const rib = Math.exp(-u * u * 900) * 0.35; return sat((1 - smooth(0.75, 1, e)) * (0.75 - rib + 0.25 * vnoise(u * 8, v * 8))); }, // leaf
  (u, v) => { const y = (v + 1) * 0.5; const w = (1 - y) * 0.45; const e = Math.abs(u) / Math.max(1e-3, w); const edge = smooth(0.55, 0.95, e); return sat((1 - smooth(0.9, 1, e)) * (0.45 + 0.55 * edge + 0.3 * (1 - y))) * (y > 0.02 ? 1 : 0); }, // shard
  (u, v) => { const d = Math.sqrt(u * u + v * v) + (fbm(u * 3 + 1, v * 3 + 2) - 0.5) * 0.5; return sat(Math.exp(-d * d * 7) * 1.3); }, // ember
  (u, v) => { const d = Math.sqrt(u * u + v * v); return sat(Math.exp(-Math.pow((d - 0.78) / 0.07, 2)) + 0.25 * Math.exp(-Math.pow((d - 0.78) / 0.2, 2))) * (1 - smooth(0.9, 0.99, d)); }, // ring
  (u, v) => { const a = Math.max(Math.exp(-u * u * 180) * sat(1 - Math.abs(v) * 1.05), Math.exp(-Math.pow(v - 0.35 * u, 2) * 180) * sat(1 - Math.abs(u) * 1.6)); const d = Math.sqrt(u * u + v * v); return sat(a + Math.pow(sat(1 - d), 3) * 0.3); }, // rune
  (u, v) => { const y = (v + 1) * 0.5; const w = 0.55 * Math.pow(sat(1 - y), 0.6) * sat(y * 3); const n = fbm(u * 3, v * 2 + 4); const e = Math.abs(u + (n - 0.5) * 0.35 * y) / Math.max(1e-3, w); return sat((1 - smooth(0.3, 1, e)) * (0.6 + 0.6 * (1 - y))); }, // flame (вершина вверх — v=+1)
  (u, v) => { const y = (v + 1) * 0.5; const head = Math.exp(-(u * u + Math.pow(v - 0.55, 2)) * 14); const tail = Math.exp(-u * u * 40 / Math.max(0.05, y + 0.1)) * sat(y * 1.4) * sat(1 - y) * 0.8; return sat(head + tail); }, // wisp
  (u, v) => { const a = Math.atan2(v, u); const r = 0.62 + 0.18 * Math.sin(a * 3 + 1) + 0.12 * Math.sin(a * 5 + 2); const d = Math.sqrt(u * u + v * v); const sh = 0.7 + 0.3 * vnoise(u * 6 + 3, v * 6); return (1 - smooth(r - 0.06, r, d)) * sh; }, // debris
  (u, v) => { const a = Math.atan2(v, u); const d = Math.sqrt(u * u + v * v); const arm = Math.pow(Math.abs(Math.cos(a * 3)), 40) * sat(1 - d); return sat(arm + Math.exp(-d * d * 30) * 0.9 + Math.pow(Math.abs(Math.cos(a * 3 + 0.52)), 60) * sat(0.6 - d) * 0.8); }, // flake
];

function buildAtlas(THREE) {
  const C = 64, N = 4, S = C * N;
  const data = new Uint8Array(S * S * 4);
  for (let cell = 0; cell < SPRITE_FN.length; cell++) {
    const cx = (cell % N) * C, cy = Math.floor(cell / N) * C, fn = SPRITE_FN[cell];
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        // 1 px поля по краю клетки — чтобы мипы не «протекали» в соседей
        const u = ((x + 0.5) / C) * 2.12 - 1.06, v = ((y + 0.5) / C) * 2.12 - 1.06;
        const m = Math.abs(u) > 1 || Math.abs(v) > 1 ? 0 : sat(fn(u, v));
        const i = ((cy + y) * S + cx + x) * 4;
        const b = Math.round(m * 255);
        data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = b;
      }
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function buildRampTexture(THREE) {
  const data = new Uint8Array(RAMP_W * RAMP_ROWS * 4);
  const tex = new THREE.DataTexture(data, RAMP_W, RAMP_ROWS, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const writeRow = (row, nodes) => {
    for (let x = 0; x < RAMP_W; x++) {
      const t = x / (RAMP_W - 1);
      let j = 0;
      while (j < nodes.length - 2 && t > nodes[j + 1][0]) j++;
      const a = nodes[j], b = nodes[Math.min(j + 1, nodes.length - 1)];
      const k = b[0] > a[0] ? sat((t - a[0]) / (b[0] - a[0])) : 0;
      const i = (row * RAMP_W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const sh = 16 - c * 8;
        const ca = (a[1] >> sh) & 255, cb = (b[1] >> sh) & 255;
        data[i + c] = Math.round(ca + (cb - ca) * k);
      }
      data[i + 3] = Math.round((a[2] + (b[2] - a[2]) * k) * 255);
    }
    tex.needsUpdate = true;
  };
  RAMP_IDS.forEach((id, row) => writeRow(row, RAMP_DEFS[id]));
  return { tex, writeRow };
}

// ---------------------------------------------------------------- шейдеры частиц
const VS_PART = /* glsl */`
attribute vec4 iA; // p0.xyz, t0
attribute vec4 iB; // v0.xyz, life
attribute vec4 iC; // size0, size1, rot0, spin
attribute vec4 iD; // gravity, drag, turb, stretch
attribute vec4 iE; // ramp row, intensity, alpha, flags(sprite + 16*alphaBlend + 32*rival)
attribute vec4 iF; // orbit cx, cz, w, rgrow
attribute vec4 iG; // groundY, fadeIn, sizeCurve, seed
uniform float uTime;
uniform float uRampRows;
uniform float uMaxAng;
uniform float uHdr;
uniform sampler2D uRamp;
varying vec2 vUv;
varying vec4 vCol;
varying float vBlend;
${FX_SRGB}
${FX_RIVAL}
void main() {
  float age = uTime - iA.w;
  float life = iB.w;
  float k = age / life;
  if (age < 0.0 || k >= 1.0 || life <= 0.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vCol = vec4(0.0); return; }
  float drag = iD.y;
  float dk = drag > 0.001 ? (1.0 - exp(-drag * age)) / drag : age;
  float ek = drag > 0.001 ? exp(-drag * age) : 1.0;
  vec3 p = iA.xyz + iB.xyz * dk;
  p.y -= 0.5 * iD.x * age * age;
  vec3 vel = iB.xyz * ek - vec3(0.0, iD.x * age, 0.0);
  float seed = iG.w;
  if (iD.z > 0.0) {
    vec3 q = iA.xyz * 1.3 + seed;
    float T = age * 1.7;
    vec3 tw = vec3(sin(q.y * 2.1 + T + seed * 3.0) + sin(q.z * 3.7 - T * 1.3),
                   sin(q.z * 1.9 + T * 1.1 + seed * 5.0) * 0.6 + 0.4 * sin(q.x * 2.9 + T * 0.7),
                   sin(q.x * 2.3 - T * 0.9 + seed * 7.0) + sin(q.y * 3.1 + T * 1.5));
    p += tw * (iD.z * age * 0.5);
    vel += tw * iD.z * 0.5;
  }
  if (iF.z != 0.0 || iF.w != 0.0) {
    vec2 d = p.xz - iF.xy;
    float a = iF.z * age;
    float ca = cos(a), sa = sin(a);
    d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y) * (1.0 + iF.w * age);
    p.xz = iF.xy + d;
    vel.xz += vec2(-d.y, d.x) * iF.z;
  }
  p.y = max(p.y, iG.x);
  // цвет по жизни (вершинная выборка градиента)
  vec4 rc = texture2D(uRamp, vec2(k, (iE.x + 0.5) / uRampRows));
  float fl = iE.w;
  float rival = step(32.0, fl);
  fl -= rival * 32.0;
  float ab = step(16.0, fl);
  fl -= ab * 16.0;
  float spr = floor(fl + 0.5);
  float fin = iG.y > 0.0 ? clamp(k / iG.y, 0.0, 1.0) : 1.0;
  vec3 col = fxRival(fxLin(rc.rgb), rival) * min(iE.y, 3.0) * uHdr; // uHdr — калибровка под bloom игры
  vCol = vec4(col, rc.a * iE.z * fin);
  vBlend = ab;
  float size = mix(iC.x, iC.y, pow(k, iG.z));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  size = min(size, uMaxAng * max(-mv.z, 0.1)); // у камеры частица не шире ~20° поля зрения
  vec2 corner = position.xy;
  vec2 ax = vec2(1.0, 0.0), ay = vec2(0.0, 1.0);
  float sx = size, sy = size;
  if (iD.w > 0.0) {
    vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    // перспективная длина хвоста: смещение проекции за 1/60 с
    float l = length(vv.xy);
    if (l > 1e-4) { ax = vv.xy / l; ay = vec2(-ax.y, ax.x); sx = size + l * iD.w; }
  } else {
    float r = iC.z + iC.w * age;
    float cr = cos(r), sr = sin(r);
    ax = vec2(cr, sr); ay = vec2(-sr, cr);
  }
  mv.xy += ax * corner.x * sx + ay * corner.y * sy;
  gl_Position = projectionMatrix * mv;
  float cell = spr;
  vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + (uv * 0.9434 + 0.0283)) * 0.25;
}
`;
const FS_PART = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vCol;
varying float vBlend;
void main() {
  float m = texture2D(uAtlas, vUv).r;
  float a = vCol.a * m;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * a, a * vBlend);
  ${FX_OUT}
}
`;

// Полноэкранная вспышка (молния): квад прямо в clip-space.
const VS_SCREEN = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FS_SCREEN = /* glsl */`
uniform vec3 uColor;
uniform float uAmount;
uniform float uEdge;
varying vec2 vUv;
void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float vig = mix(1.0, smoothstep(0.2, 1.4, length(c)), uEdge);
  gl_FragColor = vec4(uColor * uAmount * vig, 0.0);
  ${FX_OUT}
}
`;

// ================================================================== createFxKit
/**
 * deps: { THREE, root, camera, renderer, quality:'medium', reducedMotion:()=>bool,
 *         lightUnit:30, onShake(trauma), onKick(dir,disp), anchor(name,out,remote)->out|null, groundY(x,z,fallback) }
 */
export function createFxKit(deps) {
  const { THREE, root, camera, renderer } = deps;
  if (!THREE || !root) throw new Error('[fx/kit] THREE и root обязательны');
  const V3 = THREE.Vector3;
  const reduced = typeof deps.reducedMotion === 'function' ? deps.reducedMotion : () => false;
  const LIGHT_UNIT = num(deps.lightUnit, 30);
  let Q = KIT_QUALITY.medium;
  let clock = 0;
  const stats = { spawned: 0, dropped: 0, actors: 0 };

  // ---------------------------------------------------------------- GPU-частицы
  const atlas = buildAtlas(THREE);
  const ramp = buildRampTexture(THREE);
  const rampIndex = new Map(RAMP_IDS.map((id, i) => [id, i]));
  let customRow = RAMP_CUSTOM0;
  const customByHex = new Map();
  function rampRow(r) {
    if (isNum(r)) return clamp(Math.floor(r), 0, RAMP_ROWS - 1);
    if (typeof r === 'string' && rampIndex.has(r)) return rampIndex.get(r);
    return rampIndex.get('gold');
  }
  // Градиент под произвольный цвет: ядро → цвет → тёмный край (кэш по hex).
  function rampFor(hex, deep) {
    const key = hex * 4096 + (deep || 0);
    if (customByHex.has(key)) return customByHex.get(key);
    if (customRow >= RAMP_ROWS) return rampIndex.get('gold');
    const row = customRow++;
    const d = isNum(deep) ? deep : (((hex >> 17) & 127) << 16) | (((hex >> 9) & 127) << 8) | ((hex >> 1) & 127);
    ramp.writeRow(row, [[0, 0xffffff, 1], [0.15, hex, 1], [0.7, hex, 0.7], [1, d, 0]]);
    customByHex.set(key, row);
    return row;
  }

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  geo.setAttribute('uv', quad.getAttribute('uv'));
  const A = {};
  const ARR = {};
  for (const k of ['iA', 'iB', 'iC', 'iD', 'iE', 'iF', 'iG']) {
    const arr = new Float32Array(MAX_PARTICLES * 4);
    const at = new THREE.InstancedBufferAttribute(arr, 4);
    at.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, at);
    A[k] = at; ARR[k] = arr;
  }
  // «мёртвые» по умолчанию: life = 0
  geo.instanceCount = 0;
  const partMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uRamp: { value: ramp.tex }, uAtlas: { value: atlas }, uRampRows: { value: RAMP_ROWS }, uMaxAng: { value: 0.36 }, uHdr: { value: num(deps.hdr, 0.7) },
    },
    vertexShader: VS_PART, fragmentShader: FS_PART,
    depthTest: true, side: THREE.DoubleSide, ...premulBlend(THREE),
  });
  const partMesh = new THREE.Mesh(geo, partMat);
  partMesh.frustumCulled = false;
  partMesh.renderOrder = 30;
  partMesh.name = 'ashen-fx-v6-particles';
  root.add(partMesh);
  let cap = Q.particles, cursor = 0, highWater = 0;
  let dirtyLo = Infinity, dirtyHi = -1, wrapped = false, lastIdx = -1;
  const deathAt = new Float32Array(MAX_PARTICLES);

  function markDirty(i) {
    if (dirtyHi >= 0 && i < lastIdx) wrapped = true; // кольцо перешло через конец за этот кадр
    lastIdx = i;
    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;
  }
  function flushParticles() {
    if (dirtyHi < 0) return;
    const lo = wrapped ? 0 : dirtyLo, hi = wrapped ? Math.max(cap, highWater) - 1 : dirtyHi;
    for (const k in A) {
      const at = A[k];
      // Диапазоны копятся до рендера (three сам очищает их после выгрузки): если здесь их стереть,
      // а рендера между двумя flush не было (clear() → update()), на GPU останутся старые частицы.
      if (at.updateRanges && at.updateRanges.length > 24) { at.clearUpdateRanges(); at.addUpdateRange(0, Math.max(cap, highWater) * 4); }
      else at.addUpdateRange(lo * 4, (hi - lo + 1) * 4);
      at.needsUpdate = true;
    }
    dirtyLo = Infinity; dirtyHi = -1; wrapped = false; lastIdx = -1;
  }
  // Низкоуровневое рождение одной частицы (все параметры уже числа).
  function spawnRaw(px, py, pz, vx, vy, vz, t0, life, s0, s1, rot, spin, grav, drag, turb, stretch, row, inten, alpha, flags, ox, oz, ow, og, gy, fadeIn, curve, seed) {
    const i = cursor;
    cursor = (cursor + 1) % cap;
    deathAt[i] = t0 + life;
    const o = i * 4;
    let a = ARR.iA; a[o] = px; a[o + 1] = py; a[o + 2] = pz; a[o + 3] = t0;
    a = ARR.iB; a[o] = vx; a[o + 1] = vy; a[o + 2] = vz; a[o + 3] = life;
    a = ARR.iC; a[o] = s0; a[o + 1] = s1; a[o + 2] = rot; a[o + 3] = spin;
    a = ARR.iD; a[o] = grav; a[o + 1] = drag; a[o + 2] = turb; a[o + 3] = stretch;
    a = ARR.iE; a[o] = row; a[o + 1] = inten; a[o + 2] = alpha; a[o + 3] = flags;
    a = ARR.iF; a[o] = ox; a[o + 1] = oz; a[o + 2] = ow; a[o + 3] = og;
    a = ARR.iG; a[o] = gy; a[o + 1] = fadeIn; a[o + 2] = curve; a[o + 3] = seed;
    if (i + 1 > highWater) { highWater = i + 1; geo.instanceCount = highWater; }
    markDirty(i);
    stats.spawned++;
    return i;
  }

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (v, d) => (Array.isArray(v) ? rnd(num(v[0], d), num(v[1], num(v[0], d))) : num(v, d));
  const _d = new V3(), _n = new V3(), _t = new V3(), _b = new V3(), _c = new V3(), _cam = new V3();
  function cameraPos(out) {
    if (camera && camera.matrixWorld) { const e = camera.matrixWorld.elements; return out.set(e[12], e[13], e[14]); }
    return out.set(0, 3, 10);
  }
  function randomUnit(out) {
    const u = Math.random() * 2 - 1, th = Math.random() * TAU, s = Math.sqrt(1 - u * u);
    return out.set(s * Math.cos(th), u, s * Math.sin(th));
  }
  function basis(nx, ny, nz) { // _n = нормаль, _t/_b — касательные
    _n.set(nx, ny, nz); if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); _n.normalize();
    if (Math.abs(_n.y) < 0.9) _t.set(0, 1, 0); else _t.set(1, 0, 0);
    _b.crossVectors(_n, _t).normalize(); _t.crossVectors(_b, _n).normalize();
  }

  /**
   * Выброс частиц. Все поля необязательны, кроме at.
   * { at, count:10, shape:'point'|'sphere'|'shell'|'ring'|'disk'|'box'|'line', radius:0, normal:up, to (line), box:{x,y,z},
   *   dir:null (базовое направление), cone:π (разброс вокруг dir, рад), speed:[1,3], radial:0 (скорость от центра),
   *   tangent:0 (скорость по касательной к кольцу), vel:{x,y,z} (добавка всем), life:[0.4,0.8], size:[0.1,0.02],
   *   sizeVar:0.3, ramp:'gold'|row, color:hex (свой градиент), intensity:1.5, alpha:1, sprite:'dot', blend:'add'|'alpha',
   *   gravity:0, drag:0, turb:0, stretch:0 (хвост по скорости), spin:[−2,2], rot:случайно, orbit:0 (рад/с вокруг центра),
   *   center:at (ось закрутки), rgrow:0, ground:−1e4, fadeIn:0.08, curve:1, delay:0 (разброс старта, с),
   *   rival:false, essential:false }
   */
  function emit(o) {
    if (!o || !o.at) return 0;
    const at = o.at;
    if (!isNum(at.x) || !isNum(at.y) || !isNum(at.z)) return 0;
    let n = num(o.count, 10);
    if (!o.essential) n *= Q.decor;
    n = Math.max(0, Math.round(n));
    if (!n) return 0;
    const shape = o.shape || (num(o.radius, 0) > 0 ? 'sphere' : 'point');
    const R = num(o.radius, 0);
    const nrm = o.normal || null;
    if (shape === 'ring' || shape === 'disk') basis(nrm ? nrm.x : 0, nrm ? nrm.y : 1, nrm ? nrm.z : 0);
    const dir = o.dir || null;
    const cone = num(o.cone, dir ? 0.35 : Math.PI);
    const radial = num(o.radial, 0), tangent = num(o.tangent, 0);
    const row = o.color !== undefined && isNum(o.color) ? rampFor(o.color, o.deep) : rampRow(o.ramp);
    const inten = num(o.intensity, 1.5), alpha = num(o.alpha, 1);
    const spr = isNum(o.sprite) ? o.sprite : (SPRITES[o.sprite] ?? 0);
    const flags = spr + (o.blend === 'alpha' ? 16 : 0) + (o.rival ? 32 : 0);
    const grav = num(o.gravity, 0), drag = num(o.drag, 0), turb = num(o.turb, 0), stretch = num(o.stretch, 0);
    const orbit = num(o.orbit, 0), rgrow = num(o.rgrow, 0);
    const cx = o.center ? num(o.center.x, at.x) : at.x, cz = o.center ? num(o.center.z, at.z) : at.z;
    const gy = num(o.ground, -1e4), fadeIn = num(o.fadeIn, 0.08), curve = num(o.curve, 1);
    const delay = num(o.delay, 0);
    const sizeVar = num(o.sizeVar, 0.3);
    const sz = o.size;
    const s0b = Array.isArray(sz) ? num(sz[0], 0.1) : num(sz, 0.1);
    const s1b = Array.isArray(sz) ? num(sz[1], s0b * 0.3) : s0b * 0.3;
    const vx0 = o.vel ? num(o.vel.x, 0) : 0, vy0 = o.vel ? num(o.vel.y, 0) : 0, vz0 = o.vel ? num(o.vel.z, 0) : 0;
    const to = o.to;
    const cosCone = Math.cos(Math.min(Math.PI, cone));
    for (let i = 0; i < n; i++) {
      // точка рождения
      let px = at.x, py = at.y, pz = at.z, ux = 0, uy = 0, uz = 0; // u — направление «от центра»
      if (shape === 'sphere' || shape === 'shell') {
        randomUnit(_c);
        const r = shape === 'shell' ? R : R * Math.cbrt(Math.random());
        px += _c.x * r; py += _c.y * r; pz += _c.z * r; ux = _c.x; uy = _c.y; uz = _c.z;
      } else if (shape === 'ring' || shape === 'disk') {
        const a = Math.random() * TAU, r = shape === 'ring' ? R : R * Math.sqrt(Math.random());
        const ca = Math.cos(a), sa = Math.sin(a);
        ux = _t.x * ca + _b.x * sa; uy = _t.y * ca + _b.y * sa; uz = _t.z * ca + _b.z * sa;
        px += ux * r; py += uy * r; pz += uz * r;
      } else if (shape === 'box' && o.box) {
        px += (Math.random() * 2 - 1) * num(o.box.x, 0); py += (Math.random() * 2 - 1) * num(o.box.y, 0); pz += (Math.random() * 2 - 1) * num(o.box.z, 0);
      } else if (shape === 'line' && to) {
        const u = Math.random();
        px += (to.x - at.x) * u; py += (to.y - at.y) * u; pz += (to.z - at.z) * u;
        if (R > 0) { randomUnit(_c); px += _c.x * R; py += _c.y * R; pz += _c.z * R; }
      }
      // направление скорости
      if (dir) {
        _d.set(num(dir.x, 0), num(dir.y, 0), num(dir.z, 0));
        if (_d.lengthSq() < 1e-8) _d.set(0, 1, 0);
        _d.normalize();
        if (cone > 1e-3) {
          // равномерно в конусе вокруг _d
          const z = 1 - Math.random() * (1 - cosCone), th = Math.random() * TAU, s = Math.sqrt(Math.max(0, 1 - z * z));
          if (Math.abs(_d.y) < 0.9) _c.set(0, 1, 0); else _c.set(1, 0, 0);
          _b.crossVectors(_d, _c).normalize(); _c.crossVectors(_b, _d);
          _d.multiplyScalar(z).addScaledVector(_b, s * Math.cos(th)).addScaledVector(_c, s * Math.sin(th));
        }
      } else if (shape === 'point' || (ux === 0 && uy === 0 && uz === 0)) randomUnit(_d);
      else _d.set(ux, uy, uz);
      const sp = pick(o.speed, 1.5);
      let vx = _d.x * sp + ux * radial + vx0, vy = _d.y * sp + uy * radial + vy0, vz = _d.z * sp + uz * radial + vz0;
      if (tangent) { // по касательной вокруг нормали кольца
        const tx = _n.y * uz - _n.z * uy, ty = _n.z * ux - _n.x * uz, tz = _n.x * uy - _n.y * ux;
        vx += tx * tangent; vy += ty * tangent; vz += tz * tangent;
      }
      const life = Math.max(0.03, pick(o.life, 0.6));
      const sj = 1 + (Math.random() * 2 - 1) * sizeVar;
      const rot = isNum(o.rot) ? o.rot : Math.random() * TAU;
      const spin = pick(o.spin, 0);
      const t0 = clock + (delay > 0 ? Math.random() * delay : 0) + num(o.at0, 0);
      spawnRaw(px, py, pz, vx, vy, vz, t0, life, s0b * sj, s1b * sj, rot, spin, grav, drag, turb, stretch,
        row, inten, alpha, flags, cx, cz, orbit, rgrow, gy, fadeIn, curve, Math.random() * 10);
    }
    return n;
  }

  /**
   * HDR-вспышка (частица-спрайт на месте). { color:hex | ramp, size:[s0,s1], dur:0.2, intensity:3,
   *   sprite:'glow'|'star'|'ring'|'spark'|'flare', pull:0.25 (к камере, м), rot, rival, alpha, hold (ramp whiteHold) }
   */
  function flash(pos, o) {
    if (!pos || !isNum(pos.x)) return;
    o = o || {};
    const pull = num(o.pull, 0.25);
    cameraPos(_cam);
    _d.set(_cam.x - pos.x, _cam.y - pos.y, _cam.z - pos.z);
    const L = _d.length();
    if (L > 1e-4) _d.multiplyScalar(Math.min(pull, L * 0.5) / L); else _d.set(0, 0, 0);
    const sz = o.size;
    // вспышка у камеры (удар по нашему герою) не шире ~25° поля зрения
    const cap = Math.max(0.3, 0.45 * L);
    const s0 = Math.min(cap, Array.isArray(sz) ? num(sz[0], 0.3) : num(sz, 0.6) * 0.4);
    const s1 = Math.min(cap, Array.isArray(sz) ? num(sz[1], s0 * 3) : num(sz, 0.6));
    const row = isNum(o.color) ? rampFor(o.color, o.deep) : rampRow(o.ramp || 'white');
    const sprName = o.sprite === 'flare' ? 'star' : (o.sprite || 'glow');
    const spr = SPRITES[sprName] ?? 1;
    // калибровка по bloom игры: ядра ≤ 3.4, ореолы мягче
    let inten = Math.min(num(o.intensity, 3) * 0.75, 3.4);
    if (reduced()) inten = Math.min(inten, 2.0);
    spawnRaw(pos.x + _d.x, pos.y + _d.y, pos.z + _d.z, 0, 0, 0, clock + num(o.delay, 0), Math.max(0.03, num(o.dur, 0.2)),
      s0, s1, isNum(o.rot) ? o.rot : (sprName === 'star' ? Math.random() * 0.4 - 0.2 : Math.random() * TAU), num(o.spin, 0),
      0, 0, 0, 0, row, inten, num(o.alpha, 1), spr + (o.rival ? 32 : 0), 0, 0, 0, 0, -1e4, num(o.fadeIn, 0.04), num(o.curve, 0.45), 0);
  }

  // ---------------------------------------------------------------- свет
  const lights = [];
  for (let i = 0; i < KIT_QUALITY.high.lights; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 12, 2);
    l.castShadow = false; l.name = 'ashen-fx-v6-light-' + i;
    root.add(l);
    lights.push({ l, t: 1, dur: 1, attack: 0.05, peak: 0, follow: null, busy: false });
  }
  function applyLightCount() {
    // Число видимых источников меняется только при смене качества (одна перекомпиляция материалов).
    for (let i = 0; i < lights.length; i++) {
      lights[i].l.visible = i < Q.lights;
      if (i >= Q.lights) { lights[i].l.intensity = 0; lights[i].busy = false; }
    }
  }
  /** Вспышка света. { color:hex, intensity:1 (единицы effects.js), range:10, dur:0.4, attack:0.05, follow:()=>pos } */
  function light(pos, o) {
    if (!Q.lights || !pos) return null;
    o = o || {};
    // калибровка по игре: мокрый пол арены отражает точечный свет, bloom его раздувает — держим свет скромным
    const peak = Math.min(num(o.intensity, 1), 1.4) * LIGHT_UNIT * 0.5 * (reduced() ? 0.6 : 1);
    let best = null, bestV = Infinity;
    for (let i = 0; i < Q.lights; i++) {
      const s = lights[i];
      const v = s.busy ? s.l.intensity + (s.dur - s.t) * 10 : -1;
      if (v < bestV) { bestV = v; best = s; }
    }
    if (!best) return null;
    if (best.busy && best.l.intensity > peak * 1.2) return null; // не перебиваем более сильную вспышку
    best.l.position.set(pos.x, pos.y, pos.z);
    best.l.color.setHex(num(o.color, 0xffc080));
    best.l.distance = num(o.range, 10);
    best.t = 0; best.dur = Math.max(0.05, num(o.dur, 0.4)); best.attack = clamp(num(o.attack, 0.05), 0.001, 0.9);
    best.peak = peak; best.follow = typeof o.follow === 'function' ? o.follow : null; best.busy = true;
    return best;
  }
  function updateLights(dt) {
    for (let i = 0; i < lights.length; i++) {
      const s = lights[i];
      if (!s.busy) continue;
      s.t += dt;
      const k = s.t / s.dur;
      if (k >= 1) { s.busy = false; s.l.intensity = 0; s.follow = null; continue; }
      const a = s.attack;
      s.l.intensity = s.peak * (k < a ? k / a : Math.pow(1 - (k - a) / (1 - a), 1.6));
      if (s.follow) { try { const p = s.follow(); if (p && isNum(p.x)) s.l.position.set(p.x, p.y, p.z); } catch (e) { s.follow = null; } }
    }
  }

  // ---------------------------------------------------------------- экранная вспышка
  const scrMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uAmount: { value: 0 }, uEdge: { value: 0.3 } },
    vertexShader: VS_SCREEN, fragmentShader: FS_SCREEN,
    depthTest: false, ...premulBlend(THREE),
  });
  const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), scrMat);
  scrMesh.frustumCulled = false; scrMesh.renderOrder = 1000; scrMesh.visible = false; scrMesh.name = 'ashen-fx-v6-screen';
  root.add(scrMesh);
  const scr = { t: 1, dur: 1, peak: 0 };
  const _lin = [0, 0, 0];
  /** Вспышка всего экрана: strength 0..1 (≈ доля белого), dur — затухание. reducedMotion — втрое слабее и мягче. */
  function screenFlash(hex, strength, dur) {
    let s = clamp(num(strength, 0.3), 0, 1) * Q.screen * 0.6; // экранная вспышка идёт через bloom — втрое мягче «сырой»
    let d = Math.max(0.03, num(dur, 0.12));
    if (reduced()) { s *= 0.3; d = Math.max(d, 0.35); }
    if (scr.t < scr.dur && scrMat.uniforms.uAmount.value > s) return;
    hexLin(num(hex, 0xffffff), _lin);
    scrMat.uniforms.uColor.value.setRGB(_lin[0], _lin[1], _lin[2]);
    scr.t = 0; scr.dur = d; scr.peak = s;
    scrMesh.visible = true;
  }
  function updateScreen(dt) {
    if (!scrMesh.visible) return;
    scr.t += dt;
    const k = scr.t / scr.dur;
    if (k >= 1) { scrMesh.visible = false; scrMat.uniforms.uAmount.value = 0; return; }
    scrMat.uniforms.uAmount.value = scr.peak * Math.pow(1 - k, 2);
  }

  // ---------------------------------------------------------------- акторы / таймлайн
  const actors = [];
  const ACTOR_CAP = 96;
  /** actor({ dur, update(t, k, dt, a) → false (закончить), end(a), data }) — живёт dur секунд боевого времени. */
  function actor(o) {
    if (!o) return null;
    let a = null;
    for (let i = 0; i < actors.length; i++) if (!actors[i].alive) { a = actors[i]; break; }
    if (!a) {
      if (actors.length >= ACTOR_CAP) { stats.dropped++; return null; }
      a = { alive: false, t: 0, dur: 0, update: null, end: null, data: null, kill() { if (this.alive) { this.alive = false; finish(this); } } };
      actors.push(a);
    }
    a.alive = true; a.t = 0; a.dur = Math.max(0, num(o.dur, 1)); a.update = o.update || null; a.end = o.end || null; a.data = o.data || null;
    return a;
  }
  function finish(a) { const e = a.end; a.end = null; a.update = null; if (e) { try { e(a); } catch (err) { warn('actor.end', err); } } }
  function after(sec, fn) { return actor({ dur: Math.max(0, num(sec, 0)), end: fn }); }
  function updateActors(dt) {
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (!a.alive) continue;
      a.t += dt;
      const k = a.dur > 0 ? Math.min(1, a.t / a.dur) : 1;
      if (a.update) {
        let r;
        try { r = a.update(a.t, k, dt, a); } catch (err) { warn('actor.update', err); r = false; }
        if (r === false) { a.alive = false; finish(a); continue; }
      }
      if (a.t >= a.dur) { a.alive = false; finish(a); }
    }
  }
  const warned = new Set();
  function warn(key, err) { if (warned.has(key)) return; warned.add(key); console.warn('[fx/kit]', key, err); }

  // ---------------------------------------------------------------- камера / хит-стоп
  let hitStopMs = 0;
  function shake(trauma) { if (typeof deps.onShake === 'function' && !reduced()) deps.onShake(clamp(num(trauma, 0), 0, 1)); }
  function kick(dir, disp) { if (typeof deps.onKick === 'function' && !reduced() && dir) deps.onKick(dir, num(disp, 0.02)); }
  function hitstop(ms) { hitStopMs = Math.max(hitStopMs, clamp(num(ms, 0), 0, 160) * (reduced() ? 0.5 : 1)); }
  function takeHitStop() { const v = hitStopMs; hitStopMs = 0; return v; }

  // ---------------------------------------------------------------- искажение воздуха (postfx №8)
  // Если core/postfx.js экспортирует queueShockwave(u, v, strength) — настоящая волна искажения на экране.
  let queueWave = null;
  try {
    import('../../core/postfx.js').then((m) => { if (m && typeof m.queueShockwave === 'function') queueWave = m.queueShockwave; }).catch(() => {});
  } catch (e) { /* нет динамического импорта */ }
  const _pw = new V3();
  /** Волна искажения в точке мира (strength 0..1). Без поддержки postfx — ничего. */
  function distort(pos, strength) {
    if (!queueWave || !camera || !pos || !Q.distort) return false;
    _pw.set(pos.x, pos.y, pos.z).project(camera);
    if (_pw.z > 1 || Math.abs(_pw.x) > 1.3 || Math.abs(_pw.y) > 1.3) return false;
    try { queueWave(_pw.x * 0.5 + 0.5, _pw.y * 0.5 + 0.5, clamp(num(strength, 0.5), 0, 1) * (reduced() ? 0.4 : 1)); return true; } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- опорные точки
  const _anch = new V3();
  function anchor(name, out, remote) {
    const o = out || _anch;
    if (typeof deps.anchor === 'function') {
      try { const r = deps.anchor(name, o, !!remote); if (r) return r; } catch (e) { warn('anchor', e); }
    }
    return o.set(0, 1.2, 0);
  }
  function groundY(x, z, fallback) {
    if (typeof deps.groundY === 'function') { try { const y = deps.groundY(x, z, fallback); if (isNum(y)) return y; } catch (e) { /* ignore */ } }
    return num(fallback, 0);
  }

  // ---------------------------------------------------------------- жизненный цикл
  function update(dt) {
    dt = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    clock += dt;
    partMat.uniforms.uTime.value = clock;
    updateActors(dt);
    updateLights(dt);
    updateScreen(dt);
    flushParticles();
  }
  function setQuality(name) {
    Q = KIT_QUALITY[name] || KIT_QUALITY.medium;
    const newCap = Q.particles;
    if (newCap !== cap) {
      cap = newCap; cursor = 0;
      if (highWater > cap) { for (let i = cap; i < highWater; i++) { ARR.iB[i * 4 + 3] = 0; deathAt[i] = 0; } markDirty(0); markDirty(highWater - 1); wrapped = true; }
      highWater = Math.min(highWater, cap); geo.instanceCount = highWater;
    }
    applyLightCount();
  }
  function clear() {
    for (let i = 0; i < highWater; i++) { ARR.iB[i * 4 + 3] = 0; deathAt[i] = 0; }
    if (highWater > 0) { markDirty(0); markDirty(highWater - 1); wrapped = true; }
    cursor = 0;
    for (const a of actors) { a.alive = false; a.update = null; a.end = null; a.data = null; }
    for (const s of lights) { s.busy = false; s.l.intensity = 0; s.follow = null; }
    scrMesh.visible = false; scr.t = scr.dur;
    hitStopMs = 0;
    flushParticles();
  }
  function aliveCount() { let n = 0; for (let i = 0; i < highWater; i++) if (deathAt[i] > clock) n++; return n; }
  function dispose() {
    clear();
    root.remove(partMesh); root.remove(scrMesh);
    for (const s of lights) root.remove(s.l);
    geo.dispose(); quad.dispose(); partMat.dispose(); scrMat.dispose(); scrMesh.geometry.dispose();
    atlas.dispose(); ramp.tex.dispose();
  }

  setQuality(deps.quality || 'medium');

  return {
    version: KIT_VERSION, THREE, root, camera, renderer,
    get clock() { return clock; },
    get Q() { return Q; },
    reduced,
    emit, flash, light, screenFlash, actor, after, distort,
    shake, kick, hitstop, takeHitStop,
    anchor, groundY, cameraPos,
    rampFor, rampRow, SPRITES, ELEMENTS,
    update, setQuality, clear, dispose,
    stats: () => ({ particles: aliveCount(), cap, highWater, actors: actors.filter((a) => a.alive).length, lights: lights.filter((s) => s.busy).length, spawned: stats.spawned, dropped: stats.dropped }),
  };
}
