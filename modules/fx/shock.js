// ASHEN OATH — modules/fx/shock.js. Владелец: №7 [VFX].
// Ударные волны, сферы-«хлопки» и марево жара V6.
//  - ring(opts)   — кольцо по земле (или любой плоскости): раскалённая кромка, пыльный шлейф с радиальными
//                   штрихами, полоса «дрожащего воздуха» и низкая стена пыли/воздуха по фронту;
//  - sphere(opts) — расширяющаяся френелевская оболочка: импостор на диске, в шейдере луч × сфера
//                   (кромка яркая, центр прозрачен), рябь по нормали; гаснет, если камера рядом/внутри;
//  - haze(opts)   — колонна марева: вертикальный квад, развёрнутый к камере, бегущий вверх шум.
// ВСЁ — ОДИН draw call: InstancedBufferGeometry, общая сетка SEG×ROWS (u — угол/ширина, v — ряд),
// форма каждого экземпляра строится в вершинном шейдере по типу (кольцо, стена, диск сферы, квад марева).
// Рефракция: setSceneTexture(tex) — ЛИНЕЙНАЯ копия кадра (цель postfx до эффектов); тогда кромки/марево
// смещают UV кадра. Без текстуры — дешёвая подделка: светлое/тёмное дрожание высокочастотного шума.
// Координаты — в пространстве root (в игре root без трансформации = мир), метры, Y вверх.
import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const RING_MAX = 8, SPH_MAX = 4, HAZE_MAX = 4;
const INST_MAX = RING_MAX * 2 + SPH_MAX + HAZE_MAX;   // кольцо = плоскость + стена
const ROWS = 3;
const T_RING = 0, T_WALL = 1, T_SPH = 2, T_HAZE = 3;
const QL = Object.freeze({
  low: Object.freeze({ ring: 4, sph: 2, haze: 2, seg: 32, wall: false, gq: 0 }),
  medium: Object.freeze({ ring: 6, sph: 3, haze: 3, seg: 48, wall: true, gq: 1 }),
  high: Object.freeze({ ring: RING_MAX, sph: SPH_MAX, haze: HAZE_MAX, seg: 64, wall: true, gq: 2 }),
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
attribute vec3 iPos;
attribute vec3 iU;
attribute vec3 iV;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
attribute vec4 iF;
varying vec2 vP;
varying vec3 vW;
varying vec3 vCen;
varying float vH;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec4 vE;
varying vec4 vF;
#if SCENE
varying vec4 vClip;
varying vec4 vCClip;
#endif
void main() {
  float u = position.x, v = position.y;
  float ang = u * 6.2831853;
  vec2 cs = vec2(cos(ang), sin(ang));
  float ty = iA.x;
  vec3 w;
  vH = v;
  if (ty < 0.5) {                       // кольцо: кольцевая полоса rIn..rOut (доли R) в плоскости U,V
    vP = cs * mix(iA.z, iA.w, v);
    w = iPos + (iU * vP.x + iV * vP.y) * iA.y;
  } else if (ty < 1.5) {                // стена: цилиндр по фронту, наклон наружу iA.w, высота iA.z
    vec3 N = normalize(cross(iU, iV));
    vP = cs;
    w = iPos + (iU * cs.x + iV * cs.y) * (iA.y * (1.0 + v * iA.w)) + N * (v * iA.z);
  } else if (ty < 2.5) {                // сфера: диск к камере, выдвинут к ней на 0.7R (не тонет в теле босса)
    vec3 toC = normalize(cameraPosition - iPos);
    vP = cs * v;
    w = iPos + toC * (iA.y * 0.7) + (iU * cs.x + iV * cs.y) * (v * iA.z);
  } else {                              // марево: квад, iU — полуширина (к камере), iV — высота
    vP = vec2(u * 2.0 - 1.0, v);
    w = iPos + iU * vP.x + iV * v;
  }
  vW = w; vCen = iPos;
  vA = iA; vB = iB; vC = iC; vD = iD; vE = iE; vF = iF;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
#if SCENE
  vClip = gl_Position;
  vCClip = projectionMatrix * viewMatrix * vec4(iPos, 1.0);
#endif
}
`;

// vA: x тип, y R (м), z/w — по типу | vB: x жизнь 0..1, y возраст (с), z seed, w затухание
// vC: rgb цвет, w rival | vD: rgb горячий, w яркость | vE: x толщина, y distort, z пыль, w — | vF: rgb пыль
const FS = /* glsl */`
#define TAU 6.2831853
varying vec2 vP;
varying vec3 vW;
varying vec3 vCen;
varying float vH;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec4 vE;
varying vec4 vF;
#if SCENE
uniform sampler2D uScene;
varying vec4 vClip;
varying vec4 vCClip;
#endif
${FX_RIVAL}
${FX_NOISE}

// L — аддитивный свет, dA — «пыль»/затемнение (альфа), off — сдвиг UV кадра, rm — маска рефракции
void shadeRing(inout vec3 L, inout float dA, inout vec2 off, inout float rm) {
  float r = length(vP);
  vec2 dir = vP / max(r, 1e-4);
  float life = vB.x, age = vB.y, seed = vB.z;
  float th = max(vE.x, 0.01);
  float pr = max(fwidth(r), 1e-5);
  float dj = r - 1.0 + (fxNoise2(dir * 4.0 + seed) - 0.5) * 0.035;   // фронт не идеально круглый
#if GQ > 0
  dj += (fxNoise2(dir * 19.0 - seed) - 0.5) * 0.014;
#endif
  float w = mix(0.012, 0.005, life);
  float ww = max(w, pr * 0.5);
  float rim = clamp((ww - abs(dj)) / pr + 0.5, 0.0, 1.0) * (w / ww);
  float glow = dj < 0.0 ? exp(dj / (th * 0.22)) : exp(-dj / 0.02);
  float x = -dj / th;                                                // 0 — кромка, 1 — хвост шлейфа
  float band = smoothstep(0.0, 0.08, x) * (1.0 - smoothstep(0.25, 1.0, x));
#if GQ > 1
  float st = fxNoise3(vec3(dir * 15.0, r * 2.5 - age * 1.5 + seed)) * 0.65 + fxNoise2(dir * 43.0 + seed) * 0.35;
#else
  float st = fxNoise2(dir * 15.0 + seed) * 0.6 + fxNoise2(dir * 43.0 + seed) * 0.4;
#endif
  float streak = smoothstep(0.32, 0.85, st);
  vec3 col = vC.rgb, hot = vD.rgb;
  L += hot * rim * 2.6 + mix(col, hot, 0.3) * glow * (0.75 + 0.5 * streak) + col * band * (0.08 + 0.55 * streak);
  float d = band * (0.18 + 0.5 * streak) * vE.z;
  // дрожащий воздух: полоса высокочастотного шума сразу за кромкой (светлее/темнее)
  float sb = exp(-pow((x - 0.3) / 0.28, 2.0)) * vE.y;
  float sh = fxNoise2(vP * 34.0 + vec2(age * 5.0, -age * 3.5) + seed) - 0.5;
#if GQ > 1
  sh = sh * 0.7 + (fxNoise2(vP * 71.0 - vec2(age * 7.0, age * 2.0)) - 0.5) * 0.6;
#endif
  L += hot * max(sh, 0.0) * sb * 0.55;
  d += max(-sh, 0.0) * sb * 0.6;
  L += hot * exp(-life * 10.0) * (1.0 - smoothstep(0.0, 1.0, r)) * 0.55;   // вспышка в центре
  dA += d;
#if SCENE
  vec2 sd = vClip.xy / vClip.w - vCClip.xy / vCClip.w;
  sd /= max(length(sd), 1e-5);
  off += sd * (sb * 0.012 + rim * 0.004 + sh * sb * 0.01) * vE.y;
  rm = max(rm, sb * 0.9);
#endif
}

void shadeWall(inout vec3 L, inout float dA, inout vec2 off, inout float rm) {
  vec2 dir = vP;
  float h = vH, age = vB.y, seed = vB.z;
  float fall = 1.0 - h; fall *= fall;
#if GQ > 1
  float n = fxNoise3(vec3(dir * 12.0 + seed, h * 1.7 - age * 2.4));
#else
  float n = fxNoise2(dir * 12.0 + seed);
#endif
  float n2 = fxNoise2(dir * 31.0 - seed);
  float curtain = smoothstep(0.3, 0.8, n * 0.7 + n2 * 0.3) * fall;
  float base = exp(-h * 8.0);
  vec3 col = vC.rgb, hot = vD.rgb;
  float sh = fxNoise2(dir * 40.0 + vec2(h * 6.0 - age * 6.0, seed)) - 0.5;
  float sm = fall * vE.y * 0.7;
  float cf = smoothstep(0.6, 2.0, length(cameraPosition - vW));      // камера у стены — гасим
  L += (hot * base * 0.9 + col * curtain * 0.5 + mix(col, hot, 0.5) * fall * 0.07 + hot * max(sh, 0.0) * sm * 0.5) * cf;
  dA += (curtain * 0.4 * vE.z + max(-sh, 0.0) * sm * 0.45) * cf;
#if SCENE
  vec2 sd = vClip.xy / vClip.w - vCClip.xy / vCClip.w;
  off += sd / max(length(sd), 1e-5) * sh * sm * 0.012;
  rm = max(rm, sm * 0.8 * cf);
#endif
}

void shadeSphere(inout vec3 L, inout float dA, inout vec2 off, inout float rm) {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vW - ro);
  vec3 oc = vCen - ro;
  float tc = dot(oc, rd);
  float R = vA.y;
  float q = sqrt(max(dot(oc, oc) - tc * tc, 0.0)) / R;             // расстояние луча от центра / R
  float pq = max(fwidth(q), 1e-4);
  float life = vB.x, age = vB.y, seed = vB.z;
  float z = sqrt(max(1.0 - q * q, 0.0));
  float ins = 1.0 - smoothstep(1.0 - pq, 1.0 + pq, q);
  vec3 N = (ro + rd * (tc - z * R) - vCen) / R;                        // нормаль передней поверхности
  float fres = pow(1.0 - z, 2.4) * ins;
  float w = mix(0.022, 0.009, life);
  float rim = exp(-pow((q - 1.0 + w) / (w + pq), 2.0));
  float halo = q > 1.0 ? exp(-(q - 1.0) * 13.0) : 0.0;
#if GQ > 0
  float rip = fxNoise3(N * 3.2 + vec3(0.0, -age * 2.2, seed));
#else
  float rip = fxNoise2(N.xy * 3.2 + seed + age);
#endif
  vec3 col = vC.rgb, hot = vD.rgb;
  L += hot * rim * 1.9 + col * fres * (0.2 + 1.2 * rip) + col * halo * 0.35;
  L += hot * exp(-life * 12.0) * z * z * 0.7 * ins;                    // первая вспышка
  float band = smoothstep(0.4, 0.9, q) * ins * vE.y;
#if GQ > 1
  float sh = fxNoise3(N * 10.0 + vec3(age * 3.5, 0.0, seed)) - 0.5;
#else
  float sh = fxNoise2(N.xy * 10.0 + age * 3.5) - 0.5;
#endif
  L += hot * max(sh, 0.0) * band * 0.5;
  dA += max(-sh, 0.0) * band * 0.4;
#if SCENE
  vec3 nv = (viewMatrix * vec4(N, 0.0)).xyz;
  off += nv.xy * (0.015 + 0.03 * band + sh * 0.01) * vE.y * ins;
  rm = max(rm, (0.3 + 0.6 * band) * ins * vE.y);
#endif
}

void shadeHaze(inout vec3 L, inout float dA, inout vec2 off, inout float rm) {
  vec2 p = vP;                                                        // x -1..1, y 0..1
  float age = vB.y, seed = vB.z;
  float mx = 1.0 - p.x * p.x; mx *= mx;
  float my = smoothstep(0.0, 0.18, p.y) * (1.0 - smoothstep(0.45, 1.0, p.y));
  float m = mx * my * vE.y * smoothstep(0.35, 1.2, length(cameraPosition - vW));
  vec2 q = vec2(p.x * vA.y, p.y * vA.z);                              // метры
  float n1 = fxNoise2(vec2(q.x * 3.2, q.y * 2.2 - age * 2.1) + seed);
  float wv = sin(q.y * 15.0 - age * 9.0 + n1 * 5.0 + q.x * 4.0);
#if GQ > 0
  float n2 = fxNoise2(vec2(q.x * 7.5 + n1 * 1.3, q.y * 5.5 - age * 3.4) + seed * 1.7);
#else
  float n2 = 0.5;
#endif
  float s = (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.8 + wv * 0.25;
  L += vD.rgb * m * (0.05 + max(s, 0.0) * 0.28);
  dA += max(-s, 0.0) * m * 0.16;
#if SCENE
  off += vec2(s, wv * 0.35) * m * 0.006;
  rm = max(rm, m * 0.95);
#endif
}

void main() {
  vec3 L = vec3(0.0);
  float dA = 0.0, rm = 0.0;
  vec2 off = vec2(0.0);
  float ty = vA.x;
  if (ty < 0.5) shadeRing(L, dA, off, rm);
  else if (ty < 1.5) shadeWall(L, dA, off, rm);
  else if (ty < 2.5) shadeSphere(L, dA, off, rm);
  else shadeHaze(L, dA, off, rm);
  float fk = vB.w;
  dA = clamp(dA * fk, 0.0, 0.85);
  vec3 c = fxRival(L * (vD.w * fk) + vF.rgb * dA, vC.w);
  float a = dA;
#if SCENE
  rm = clamp(rm * fk, 0.0, 0.95);
  if (rm > 0.002) {
    vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;
    vec3 sc = texture2D(uScene, clamp(uv + off, vec2(0.001), vec2(0.999))).rgb;
    c += sc * rm * (1.0 - dA);
    a = dA + rm * (1.0 - dA);
  }
#endif
  gl_FragColor = vec4(c, a);
${FX_OUT}
}
`;

// ---------------------------------------------------------------- модуль
function gridGeoData(seg) {
  const pos = new Float32Array((seg + 1) * (ROWS + 1) * 3);
  let k = 0;
  for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= seg; i++) { pos[k++] = i / seg; pos[k++] = j / ROWS; pos[k++] = 0; }
  const idx = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  return { pos, idx };
}

export function createShock(deps) {
  const d = deps || {};
  const THREE = d.THREE;
  if (!THREE) throw new Error('createShock: нужен deps.THREE');
  const root = d.root || null;
  const camera = d.camera || null;

  let quality = 'high', Q = QL.high, orderSeq = 0, seedSeq = 0, time = 0;

  const geo = new THREE.InstancedBufferGeometry();
  const grids = {};
  function gridFor(q) {
    const seg = QL[q].seg;
    if (!grids[seg]) {
      const g = gridGeoData(seg);
      grids[seg] = { pos: new THREE.Float32BufferAttribute(g.pos, 3), idx: new THREE.Uint16BufferAttribute(g.idx, 1) };
    }
    return grids[seg];
  }
  const g0 = gridFor('high');
  geo.setAttribute('position', g0.pos); geo.setIndex(g0.idx);
  const mk = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(INST_MAX * size), size);
    a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a;
  };
  const aPos = mk('iPos', 3), aU = mk('iU', 3), aV = mk('iV', 3);
  const aA = mk('iA', 4), aB = mk('iB', 4), aC = mk('iC', 4), aD = mk('iD', 4), aE = mk('iE', 4), aF = mk('iF', 4);
  const ATTRS = [aPos, aU, aV, aA, aB, aC, aD, aE, aF];
  geo.instanceCount = 0;

  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  dummy.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScene: { value: dummy } },
    vertexShader: VS, fragmentShader: FS,
    defines: { GQ: Q.gq, SCENE: 0 },
    side: THREE.DoubleSide, depthTest: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    ...premulBlend(THREE),
  });
  mat.depthWrite = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-shock'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false; mesh.renderOrder = 3; mesh.visible = false;
  if (root && typeof root.add === 'function') root.add(mesh);

  // --- пулы (объект слота = handle; kill() на мёртвом — no-op)
  function baseSlot(kind, i) {
    const s = {
      kind, i, alive: false, order: 0,
      px: 0, py: 0, pz: 0, ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: -1,
      dur: 0.5, age: 0, seed: 0, rival: 0, intensity: 1.5,
      col: [1, 1, 1], hot: [1, 1, 1], dust: [0, 0, 0],
      r0: 0.3, r1: 5, thick: 0.18, distort: 1, dustAmt: 1, wall: 0.8, lift: 0.03,
      radius: 0.6, height: 2.2, strength: 1, follow: null,
    };
    s.kill = () => { if (s.alive) release(s); return s; };
    s.set = (o) => {
      if (!s.alive || !o || typeof o !== 'object') return s;
      if (hasVec(o.pos)) { s.px = o.pos.x; s.py = o.pos.y; s.pz = o.pos.z; }
      if (isNum(o.intensity)) s.intensity = clamp(o.intensity, 0, 30);
      if (isNum(o.strength)) s.strength = clamp(o.strength, 0, 3);
      if (isNum(o.rival)) s.rival = clamp01(o.rival);
      return s;
    };
    return s;
  }
  const rings = [], sphs = [], hazes = [];
  for (let i = 0; i < RING_MAX; i++) rings.push(baseSlot('ring', i));
  for (let i = 0; i < SPH_MAX; i++) sphs.push(baseSlot('sphere', i));
  for (let i = 0; i < HAZE_MAX; i++) hazes.push(baseSlot('haze', i));

  function release(s) { s.alive = false; s.follow = null; }
  function take(pool, cap) {
    let free = null, oldest = null, n = 0;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (!s.alive) { if (!free || s.order < free.order) free = s; continue; }
      n++;
      if (!oldest || s.order < oldest.order) oldest = s;
    }
    if (free && n < cap) return free;
    if (oldest) { release(oldest); return oldest; }
    return free;
  }
  function common(s, o, defCol, defHot) {
    s.alive = true; s.order = ++orderSeq; s.age = 0;
    s.seed = ((++seedSeq * 7.31) % 53) + 0.41;
    s.px = o.pos.x; s.py = o.pos.y; s.pz = o.pos.z;
    hexLin((isNum(o.color) ? o.color : defCol) & 0xffffff, s.col);
    hexLin((isNum(o.hot) ? o.hot : defHot) & 0xffffff, s.hot);
    s.rival = clamp01(num(o.rival, 0));
  }
  // базис плоскости кольца: U, V ⟂ N, U × V = N
  function planeBasis(s, n) {
    let nx = 0, ny = 1, nz = 0;
    if (hasVec(n)) { const l = len3(n.x, n.y, n.z); if (l > 1e-6) { nx = n.x / l; ny = n.y / l; nz = n.z / l; } }
    let hx = 0, hy = 0, hz = 1;
    if (Math.abs(nz) > 0.9) { hx = 1; hz = 0; }
    let ux = hy * nz - hz * ny, uy = hz * nx - hx * nz, uz = hx * ny - hy * nx;
    const ul = len3(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    s.ux = ux; s.uy = uy; s.uz = uz;
    s.vx = ny * uz - nz * uy; s.vy = nz * ux - nx * uz; s.vz = nx * uy - ny * ux;   // V = N × U
    s.nx = nx; s.ny = ny; s.nz = nz;
  }

  function ring(opts) {
    try {
      const o = opts || {};
      if (!hasVec(o.pos)) return null;
      const s = take(rings, Q.ring);
      if (!s) return null;
      common(s, o, ELEMENTS.gold.mid, ELEMENTS.gold.core);
      planeBasis(s, o.normal);
      hexLin((isNum(o.dust) ? o.dust : ELEMENTS.earth.smoke) & 0xffffff, s.dust);
      s.r0 = clamp(num(o.r0, 0.3), 0, 80);
      s.r1 = clamp(num(o.r1, 5), s.r0 + 0.01, 120);
      s.dur = clamp(num(o.dur, 0.5), 0.05, 20);
      s.intensity = clamp(num(o.intensity, 1.8), 0, 30);
      s.thick = clamp(num(o.thickness, 0.18), 0.02, 0.8);
      s.distort = clamp01(num(o.distort, 1));
      s.dustAmt = clamp(num(o.dustAmount, 1), 0, 3);
      s.wall = clamp(num(o.wall, Math.min(1.1, 0.12 + s.r1 * 0.12)), 0, 6);
      s.lift = clamp(num(o.lift, 0.03), 0, 1);
      return s;
    } catch (e) { return null; }
  }

  function sphere(opts) {
    try {
      const o = opts || {};
      if (!hasVec(o.pos)) return null;
      const s = take(sphs, Q.sph);
      if (!s) return null;
      common(s, o, ELEMENTS.gold.mid, ELEMENTS.gold.core);
      s.r0 = clamp(num(o.r0, 0.2), 0.01, 60);
      s.r1 = clamp(num(o.r1, 3), s.r0 + 0.01, 100);
      s.dur = clamp(num(o.dur, 0.4), 0.05, 20);
      s.intensity = clamp(num(o.intensity, 1.5), 0, 30);
      s.distort = clamp01(num(o.distort, 1));
      return s;
    } catch (e) { return null; }
  }

  function haze(opts) {
    try {
      const o = opts || {};
      const fol = typeof o.follow === 'function' ? o.follow : null;
      let p = o.pos;
      if (!hasVec(p) && fol) { try { p = fol(); } catch (e) { p = null; } }
      if (!hasVec(p)) return null;
      const s = take(hazes, Q.haze);
      if (!s) return null;
      common(s, { pos: p, color: o.color, hot: isNum(o.tint) ? o.tint : o.hot, rival: o.rival }, ELEMENTS.fire.mid, ELEMENTS.fire.hot);
      s.radius = clamp(num(o.radius, 0.6), 0.05, 20);
      s.height = clamp(num(o.height, 2.2), 0.05, 40);
      s.dur = o.dur === Infinity ? Infinity : clamp(num(o.dur, 1.2), 0.1, 60);
      s.strength = clamp(num(o.strength, 1), 0, 3);
      s.intensity = clamp(num(o.intensity, 1), 0, 10);
      s.follow = fol;
      hexLin(ELEMENTS.fire.smoke & 0xffffff, s.dust);
      return s;
    } catch (e) { return null; }
  }

  // --- запись экземпляров
  function put(j, ty, px, py, pz, ux, uy, uz, vx, vy, vz, a1, a2, a3, b0, b1, b2, b3, s, e0, e1, e2) {
    const j3 = j * 3, j4 = j * 4;
    let a = aPos.array; a[j3] = px; a[j3 + 1] = py; a[j3 + 2] = pz;
    a = aU.array; a[j3] = ux; a[j3 + 1] = uy; a[j3 + 2] = uz;
    a = aV.array; a[j3] = vx; a[j3 + 1] = vy; a[j3 + 2] = vz;
    a = aA.array; a[j4] = ty; a[j4 + 1] = a1; a[j4 + 2] = a2; a[j4 + 3] = a3;
    a = aB.array; a[j4] = b0; a[j4 + 1] = b1; a[j4 + 2] = b2; a[j4 + 3] = b3;
    a = aC.array; a[j4] = s.col[0]; a[j4 + 1] = s.col[1]; a[j4 + 2] = s.col[2]; a[j4 + 3] = s.rival;
    a = aD.array; a[j4] = s.hot[0]; a[j4 + 1] = s.hot[1]; a[j4 + 2] = s.hot[2]; a[j4 + 3] = s.intensity;
    a = aE.array; a[j4] = e0; a[j4 + 1] = e1; a[j4 + 2] = e2; a[j4 + 3] = 0;
    a = aF.array; a[j4] = s.dust[0]; a[j4 + 1] = s.dust[1]; a[j4 + 2] = s.dust[2]; a[j4 + 3] = 0;
  }

  function update(dt, clock) {
    try {
      const h = isNum(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
      time = isNum(clock) ? clock : time + h;
      let cx = 0, cy = 2, cz = 10, rx = 1, ry = 0, rz = 0, qx = 0, qy = 1, qz = 0;
      if (camera && camera.matrixWorld) {
        const e = camera.matrixWorld.elements;
        cx = e[12]; cy = e[13]; cz = e[14]; rx = e[0]; ry = e[1]; rz = e[2]; qx = e[4]; qy = e[5]; qz = e[6];
      }
      let n = 0;
      for (let i = 0; i < RING_MAX; i++) {
        const s = rings[i];
        if (!s.alive) continue;
        s.age += h;
        const t = s.age / s.dur;
        if (t >= 1) { release(s); continue; }
        const k = 1 - Math.pow(1 - t, 2.4);
        const R = s.r0 + (s.r1 - s.r0) * k;
        if (R < 0.02) continue;
        const fk = Math.min(1, s.age / 0.03) * Math.pow(1 - t, 1.1);
        const th = s.thick * (0.7 + 0.9 * t);
        const rIn = clamp(1 - th * 1.25 - 0.04 - 1.3 * Math.exp(-t * 9), 0, 0.97);
        const rOut = 1 + 0.12;
        const lx = s.px + s.nx * s.lift, ly = s.py + s.ny * s.lift, lz = s.pz + s.nz * s.lift;
        put(n++, T_RING, lx, ly, lz, s.ux, s.uy, s.uz, s.vx, s.vy, s.vz, R, rIn, rOut, t, s.age, s.seed, fk, s, th, s.distort, s.dustAmt);
        if (Q.wall && s.wall > 0.01) {
          const H = s.wall * (1 - Math.pow(1 - t, 3)) * (1 - 0.55 * t);
          if (H > 0.02) {
            put(n++, T_WALL, lx, ly, lz, s.ux, s.uy, s.uz, s.vx, s.vy, s.vz, R, H, (0.35 * H) / R, t, s.age, s.seed + 3.3, fk * (1 - t), s, th, s.distort, s.dustAmt);
          }
        }
      }
      for (let i = 0; i < SPH_MAX; i++) {
        const s = sphs[i];
        if (!s.alive) continue;
        s.age += h;
        const t = s.age / s.dur;
        if (t >= 1) { release(s); continue; }
        const R = s.r0 + (s.r1 - s.r0) * (1 - Math.pow(1 - t, 3));
        const D = len3(cx - s.px, cy - s.py, cz - s.pz);
        const cam = sstep(R * 1.1, R * 1.7, D);               // камера у/внутри оболочки — гасим
        if (cam <= 0.001) continue;
        const fk = Math.min(1, s.age / 0.03) * Math.pow(1 - t, 1.4) * cam;
        const Dp = Math.max(0.05, D - 0.7 * R);
        const disc = Math.min(R * 6, (Dp * R) / Math.sqrt(Math.max(1e-4, D * D - R * R)) * 1.35);
        put(n++, T_SPH, s.px, s.py, s.pz, rx, ry, rz, qx, qy, qz, R, disc, 0, t, s.age, s.seed, fk, s, 0, s.distort, 0);
      }
      for (let i = 0; i < HAZE_MAX; i++) {
        const s = hazes[i];
        if (!s.alive) continue;
        s.age += h;
        if (s.dur !== Infinity && s.age >= s.dur) { release(s); continue; }
        if (s.follow) {
          try { const p = s.follow(); if (hasVec(p)) { s.px = p.x; s.py = p.y; s.pz = p.z; } } catch (e) { /* no-op */ }
        }
        const fin = Math.min(1, s.age / 0.25);
        const fout = s.dur === Infinity ? 1 : clamp01((s.dur - s.age) / (s.dur * 0.4));
        let tx = cx - s.px, tz = cz - s.pz;
        const tl = Math.sqrt(tx * tx + tz * tz);
        if (tl < 1e-4) { tx = 0; tz = 1; } else { tx /= tl; tz /= tl; }
        const W = s.radius;
        put(n++, T_HAZE, s.px, s.py, s.pz, tz * W, 0, -tx * W, 0, s.height, 0, W, s.height, 0, 0, s.age, s.seed, fin * fout, s, 0, s.strength, 0);
      }
      geo.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) {
        for (let k = 0; k < ATTRS.length; k++) {
          const at = ATTRS[k];
          if (at.clearUpdateRanges) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); }
          at.needsUpdate = true;
        }
      }
    } catch (e) { /* эффекты не роняют кадр */ }
  }

  function trim(pool, cap) {
    let alive = 0;
    for (let i = 0; i < pool.length; i++) if (pool[i].alive) alive++;
    while (alive > cap) {
      let oldest = null;
      for (let i = 0; i < pool.length; i++) { const s = pool[i]; if (s.alive && (!oldest || s.order < oldest.order)) oldest = s; }
      if (!oldest) break;
      release(oldest); alive--;
    }
  }
  function setQuality(name) {
    const q = Object.prototype.hasOwnProperty.call(QL, name) ? name : 'high';
    if (q === quality) return;
    quality = q; Q = QL[q];
    const g = gridFor(q);
    geo.setAttribute('position', g.pos); geo.setIndex(g.idx);
    mat.defines.GQ = Q.gq; mat.needsUpdate = true;
    trim(rings, Q.ring); trim(sphs, Q.sph); trim(hazes, Q.haze);
  }

  let sceneTex = null;
  function setSceneTexture(tex) {
    const t = tex && tex.isTexture ? tex : null;
    if (t === sceneTex) return;
    const had = !!sceneTex;
    sceneTex = t;
    mat.uniforms.uScene.value = t || dummy;
    if (had !== !!t) { mat.defines.SCENE = t ? 1 : 0; mat.needsUpdate = true; }
  }

  function countAlive() {
    let a = 0;
    for (let i = 0; i < RING_MAX; i++) if (rings[i].alive) a++;
    for (let i = 0; i < SPH_MAX; i++) if (sphs[i].alive) a++;
    for (let i = 0; i < HAZE_MAX; i++) if (hazes[i].alive) a++;
    return a;
  }
  function clear() {
    for (let i = 0; i < RING_MAX; i++) release(rings[i]);
    for (let i = 0; i < SPH_MAX; i++) release(sphs[i]);
    for (let i = 0; i < HAZE_MAX; i++) release(hazes[i]);
    geo.instanceCount = 0; mesh.visible = false;
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose(); mat.dispose(); dummy.dispose();
  }
  function stats() {
    return { active: countAlive(), drawCalls: mesh.visible ? 1 : 0, instances: geo.instanceCount, quality, refraction: !!sceneTex };
  }

  return { ring, sphere, haze, update, setQuality, setSceneTexture, clear, dispose, stats, mesh };
}
