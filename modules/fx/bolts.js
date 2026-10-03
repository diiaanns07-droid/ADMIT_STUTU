// ASHEN OATH — modules/fx/bolts.js. Владелец: №7 [VFX].
// Молнии и электрические разряды V6: главный удар с ветвлением, короткий треск между точками,
// разряды, ползущие по земле. ВСЁ рисуется ОДНИМ draw call: общая динамическая BufferGeometry
// из лент (quad на сегмент), развёрнутых к камере в вершинном шейдере, + billboard-«звёзды».
//  - поперечная координата ленты (-1..1) → во фрагменте белое тонкое ядро + цветной мягкий ореол
//    (гауссианы) — это и даёт «дорогой» вид; яркость > 1.2 цветёт bloom (см. glsl.js);
//  - путь — смещение средней точки (midpoint displacement) с сид-ГСЧ: детерминирован по seed и
//    номеру перегенерации; повторные «удары» молнии сохраняют крупную форму канала и меняют мелкую;
//  - точки путей хранятся в локальной рамке from→to (метры), поэтому handle.set({from,to}) и
//    follow() двигают разряд целиком без перегенерации;
//  - без аллокаций в кадре: слоты, ручки и типизированные массивы фиксированного размера.
// Координаты — в пространстве root (в игре root без трансформации = мир).
import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const TAU = Math.PI * 2;
const MAX_QUADS = 2048;   // ёмкость буфера (high); low/medium режут через Q.cap
const SLOTS = 32;         // одновременных эффектов (удар/дуга/земля — каждый в своём слоте)
const HANDLES = 96;       // кольцо ручек (устаревшая ручка не трогает чужой эффект)
const MAXP = 360;         // точек путей на слот
const MAXC = 30;          // цепочек (канал, призрак, ветви) на слот
const GRID = 64;          // сетка смещения средней точки
const MAXG = 12;          // дуг в groundArcs
const GP = 16;            // точек на одну земляную дугу (максимум)
const HALO = 3.0;         // полуширина ленты = width * HALO (ореол шире ядра)
const T_STRIKE = 1, T_ARC = 2, T_GROUND = 3;
const K_MAIN = 0, K_GHOST = 1, K_BRANCH = 2, K_SUB = 3;
const P_MAIN = 0, P_TAPER = 1, P_ARC = 2;

const QUALITY = Object.freeze({
  low: Object.freeze({ cap: 400, seg: 0.6, br: 0.5, sub: false, ghost: false, ground: 0.6, gp: 8, hq: 0, tips: false }),
  medium: Object.freeze({ cap: 900, seg: 0.8, br: 0.8, sub: true, ghost: true, ground: 0.85, gp: 11, hq: 1, tips: true }),
  high: Object.freeze({ cap: MAX_QUADS, seg: 1.0, br: 1.0, sub: true, ghost: true, ground: 1.0, gp: 14, hq: 1, tips: true }),
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampi = (v, a, b) => clamp(Math.round(v), a, b);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z); // Math.hypot в V8 аллоцирует
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
// ближайшая степень двойки: точки пути ложатся ровно на узлы сетки (острые изломы не сглаживаются)
const pow2 = (v, a, b) => { let g = a; while (g < b && g * 1.41 < v) g <<= 1; return g; };
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- сид-ГСЧ (mulberry32, без аллокаций)
const RS = new Int32Array(1); // состояние в типизированном массиве: без HeapNumber на каждый вызов
const srand = (s) => { RS[0] = (s | 0) || 0x1e3779b9; };
const rnd = () => {
  const t0 = (RS[0] + 0x6d2b79f5) | 0; RS[0] = t0; let t = t0;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rs2 = () => rnd() * 2 - 1;
const hashSeed = (a, b) => {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x165667b1); return (h ^ (h >>> 16)) >>> 0;
};

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
attribute vec4 aTan;   // лента: касательная + lift к камере; billboard: (угол, лучи, кольцо, подтяжка к камере)
attribute vec4 aSide;  // (поперёк -1..1 | x угла, вдоль (м) | y угла, полуширина | размер, режим 0 лента/1 billboard/2 диск)
attribute vec4 aCol;   // линейный цвет ореола, яркость
attribute vec4 aCore;  // линейный цвет ядра (с весом), rival
uniform float uViewH;
uniform float uMinPx;
varying vec3 vUvM;
varying vec4 vCol;
varying vec4 vCore;
varying vec2 vBill;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 toCam = cameraPosition - wp;
  float dist = max(length(toCam), 0.05);
  vec3 vd = toCam / dist;
  float pxw = 2.0 * dist / (max(projectionMatrix[1][1], 1e-3) * max(uViewH, 1.0)); // м на пиксель
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vCol = aCol; vCore = aCore; vBill = vec2(0.0);
  if (aSide.w < 0.5) {
    vec3 t = mat3(modelMatrix) * aTan.xyz;
    vec3 s = cross(t, vd); float sl = length(s);
    s = sl > 1e-7 ? s / sl : camR;
    wp += vd * min(aTan.w, dist * 0.5);   // lift: разряд по телу не прячется в поверхности
    float hw = aSide.z, hwc = max(hw, uMinPx * pxw);
    vCol.a *= sqrt(hw / hwc);           // далёкий/тонкий кончик: не толще, а тусклее (и без алиасинга)
    wp += s * (aSide.x * hwc);
    vUvM = vec3(aSide.x, aSide.y, 0.0);
  } else {
    float c = cos(aTan.x), sn = sin(aTan.x);
    vec2 q = vec2(aSide.x * c - aSide.y * sn, aSide.x * sn + aSide.y * c);
    if (aSide.w > 1.5) {
      wp += vec3(q.x, 0.0, q.y) * aSide.z;  // плоский диск на земле (световое пятно, кольцо)
    } else {
      float sz = max(aSide.z, uMinPx * 1.6 * pxw);
      wp += vd * min(aTan.w, dist * 0.5); // подтягиваем к камере: вспышку не режет тело босса
      wp += (camR * q.x + camU * q.y) * sz;
    }
    vUvM = vec3(aSide.xy, 1.0);
    vBill = aTan.yz;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FS = /* glsl */`
uniform float uHQ;
varying vec3 vUvM;
varying vec4 vCol;
varying vec4 vCore;
varying vec2 vBill;
${FX_NOISE}
${FX_RIVAL}
void main() {
  vec2 p = vUvM.xy;
  vec3 col;
  if (vUvM.z < 0.5) {
    // лента: белое ядро + насыщенная середина + широкий мягкий ореол (к краю ровно в 0)
    float x2 = p.x * p.x;
    float core = exp(-x2 * 100.0);
    float halo = exp(-x2 * 3.6) * (1.0 - x2);
    if (uHQ > 0.5) {
      float y = p.y * 2.7, i = floor(y), f = fract(y);
      float bead = 0.78 + 0.44 * mix(fxH1(i), fxH1(i + 1.0), f * f * (3.0 - 2.0 * f)); // «бусины» канала
      float mid = exp(-x2 * 20.0);
      vec3 hot = mix(vCol.rgb, vCore.rgb, 0.3);
      col = vCore.rgb * core * bead + hot * (mid * 0.85 * bead) + vCol.rgb * (halo * 0.42);
    } else {
      col = vCore.rgb * core + vCol.rgb * (exp(-x2 * 18.0) * 0.6 + halo * 0.5);
    }
  } else {
    // billboard: горячая точка, ореол, 4+4 луча, тонкое кольцо ударной волны
    float r2 = dot(p, p);
    if (r2 >= 1.0) discard;
    float fall = 1.0 - r2;
    float g = exp(-r2 * 28.0);
    float h = exp(-r2 * 5.5) * fall;
    float sp = 0.0;
    if (vBill.x > 0.0) {
      vec2 a = abs(p);
      sp = exp(-a.y * 70.0) * (1.0 - a.x) + exp(-a.x * 70.0) * (1.0 - a.y);
      vec2 dg = abs(vec2(p.x + p.y, p.x - p.y)) * 0.7071;
      sp += 0.4 * (exp(-dg.y * 80.0) * max(0.0, 1.0 - dg.x * 1.7) + exp(-dg.x * 80.0) * max(0.0, 1.0 - dg.y * 1.7));
      sp *= vBill.x * fall;
    }
    float ring = 0.0;
    if (vBill.y > 0.0) { float rr = sqrt(r2) - vBill.y; ring = exp(-rr * rr * 420.0) * fall; }
    col = vCore.rgb * (g + sp * 0.75) + vCol.rgb * (h * 0.55 + sp * 0.55 + ring * 0.9);
  }
  col *= vCol.a;
  col = fxRival(col, vCore.a);
  gl_FragColor = vec4(max(col, vec3(0.0)), 0.0); // аддитивный свет в премультиплицированном смешивании
  ${FX_OUT}
}
`;

export function createBolts(deps) {
  const d = deps || {};
  const THREE = d.THREE, root = d.root;
  if (!THREE || !root || typeof root.add !== 'function') throw new Error('createBolts: нужны THREE и root');

  let Q = QUALITY.high;
  let reducedMotion = false;
  let disposed = false;
  let seedCounter = 0x1234567;
  let quadN = 0, activeN = 0;

  // ---------------------------------------------------------------- общая геометрия
  const NV = MAX_QUADS * 4;
  const aPos = new Float32Array(NV * 3), aTan = new Float32Array(NV * 4), aSide = new Float32Array(NV * 4);
  const aCol = new Float32Array(NV * 4), aCore = new Float32Array(NV * 4);
  const idx = new Uint16Array(MAX_QUADS * 6);
  for (let i = 0; i < MAX_QUADS; i++) {
    const v = i * 4, o = i * 6;
    idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
  }
  const geo = new THREE.BufferGeometry();
  const mkAttr = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const attrs = [mkAttr(aPos, 3), mkAttr(aTan, 4), mkAttr(aSide, 4), mkAttr(aCol, 4), mkAttr(aCore, 4)];
  geo.setAttribute('position', attrs[0]); geo.setAttribute('aTan', attrs[1]); geo.setAttribute('aSide', attrs[2]);
  geo.setAttribute('aCol', attrs[3]); geo.setAttribute('aCore', attrs[4]);
  const ranges = attrs.map(() => ({ start: 0, count: 0 }));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  geo.setDrawRange(0, 0);

  const uniforms = { uViewH: { value: 720 }, uMinPx: { value: 3.6 }, uHQ: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VS, fragmentShader: FS,
    ...premulBlend(THREE), depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ashen-fx-bolts'; mesh.frustumCulled = false; mesh.renderOrder = 26;
  mesh.castShadow = false; mesh.receiveShadow = false; mesh.visible = false;
  const _vh = new THREE.Vector2();
  mesh.onBeforeRender = (r) => {
    try {
      const rt = r.getRenderTarget && r.getRenderTarget();
      if (rt && rt.height) uniforms.uViewH.value = rt.height;
      else { r.getDrawingBufferSize(_vh); if (_vh.y > 0) uniforms.uViewH.value = _vh.y; }
    } catch (e) { /* не критично */ }
  };
  root.add(mesh);

  // ---------------------------------------------------------------- слоты и ручки
  function makeSlot(i) {
    return {
      i, active: false, gen: 0, type: 0, age: 0, dur: 1, seed: 1, regen: 0, rt: 0, rate: 20,
      fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, L0: 1,
      width: 0.09, jitter: 0.12, segs: 18, branches: 4, intensity: 3, rival: 0, flick: true, amp: 1,
      star: true, origin: true, lift: 0, rv: 0.05, half: 0.2, t1: 0, t2: 0, ang: 0, bead: 0,
      col: [0, 0, 0], core: [0, 0, 0], follow: null,
      P: new Float32Array(MAXP * 4), nP: 0,
      cS: new Int16Array(MAXC), cN: new Int16Array(MAXC), cI: new Float32Array(MAXC),
      cK: new Uint8Array(MAXC), cT: new Float32Array(MAXC), cOn: new Uint8Array(MAXC), nC: 0, nMain: 0,
      G: new Float32Array(MAXG * 6), gCount: 0, gN: 8, radius: 3,
    };
  }
  const slots = [];
  for (let i = 0; i < SLOTS; i++) slots.push(makeSlot(i));

  class BoltHandle {
    constructor() { this._s = null; this._g = -1; }
    get alive() { const s = this._s; return !!s && s.active && s.gen === this._g && !disposed; }
    kill(fade) {
      if (!this.alive) return;
      const s = this._s;
      if (fade) {
        if (s.type === T_STRIKE) s.age = Math.max(s.age, s.half);
        else s.age = Math.max(s.age, s.dur - Math.min(0.12, s.dur * 0.4));
      } else freeSlot(s);
    }
    set(o) {
      if (!this.alive || !o || typeof o !== 'object') return;
      const s = this._s;
      if (hasVec(o.from)) { s.fx = o.from.x; s.fy = o.from.y; s.fz = o.from.z; }
      if (hasVec(o.to)) { s.tx = o.to.x; s.ty = o.to.y; s.tz = o.to.z; }
      if (hasVec(o.center)) { s.fx = o.center.x; s.fy = o.center.y; s.fz = o.center.z; }
      if (isNum(o.intensity)) s.intensity = Math.min(3, clamp(o.intensity, 0, 50) * 0.75); // [W4-ЗАКЛИНАНИЯ] та же калибровка, что при спавне
      if (isNum(o.rival)) s.rival = clamp(o.rival, 0, 1);
      if (isNum(o.color)) hexLin(o.color, s.col);
      if (isNum(o.core)) hexLin(o.core, s.core);
    }
  }
  const handles = [];
  for (let i = 0; i < HANDLES; i++) handles.push(new BoltHandle());
  let handleHead = 0;
  const DEAD = new BoltHandle(); // возвращается, когда спавн невозможен (всё — no-op)

  function freeSlot(s) { s.active = false; s.gen++; s.follow = null; }
  function takeSlot() {
    let best = null, bestK = -1;
    for (let i = 0; i < SLOTS; i++) {
      const s = slots[i];
      if (!s.active) { best = s; break; }
      const k = s.age / Math.max(s.dur, 1e-3); // крадём самый «догоревший»
      if (k > bestK) { bestK = k; best = s; }
    }
    if (best.active) freeSlot(best);
    best.gen++; best.active = true; best.age = 0; best.regen = 0; best.rt = 0; best.nP = 0; best.nC = 0; best.follow = null;
    return best;
  }
  function handleFor(s) {
    const h = handles[handleHead]; handleHead = (handleHead + 1) % HANDLES;
    h._s = s; h._g = s.gen; return h;
  }
  function nextSeed(o) {
    seedCounter = hashSeed(seedCounter, 0x51ed27);
    return o && isNum(o.seed) ? hashSeed(o.seed | 0, 0x7f4a7c15) : seedCounter;
  }
  function readCommon(s, o, defW, defI, defJ, defSeg, defDur) {
    hexLin(isNum(o.color) ? o.color : ELEMENTS.storm.mid, s.col);
    hexLin(isNum(o.core) ? o.core : ELEMENTS.storm.core, s.core);
    s.width = clamp(num(o.width, defW), 0.002, 2);
    s.intensity = Math.min(3, clamp(num(o.intensity, defI), 0, 50) * 0.75); // [VFX] калибровка под bloom игры
    s.rival = clamp(num(o.rival, 0), 0, 1);
    s.jitter = clamp(num(o.jitter, defJ), 0, 1);
    s.segs = clampi(num(o.segments, defSeg), 2, 48);
    s.dur = clamp(num(o.dur, defDur), 0.02, 60);
    s.seed = nextSeed(o);
  }

  // ---------------------------------------------------------------- генерация путей (локальная рамка: x — вдоль, метры)
  const DU = new Float32Array(GRID + 1), DV = new Float32Array(GRID + 1);
  // смещение средней точки на сетке G (степень 2); первые keepLv уровней — от seedA (крупная форма)
  function mpd(G, amp, rough, seedA, seedB, keepLv) {
    DU[0] = DV[0] = DU[G] = DV[G] = 0;
    let lv = 0;
    for (let step = G; step > 1; step >>= 1, lv++) {
      srand(hashSeed(lv < keepLv ? seedA : seedB, lv + 11));
      const h = step >> 1;
      for (let i = h; i < G; i += step) {
        DU[i] = (DU[i - h] + DU[i + h]) * 0.5 + rs2() * amp;
        DV[i] = (DV[i - h] + DV[i + h]) * 0.5 + rs2() * amp;
      }
      amp *= rough;
    }
  }
  function prof(kind, t) {
    if (kind === P_MAIN) return 0.62 + 0.38 * sstep(0, 0.18, t);
    if (kind === P_TAPER) return Math.pow(1 - t, 0.85);
    return 0.3 + 0.7 * Math.sin(Math.PI * t);
  }
  // пишет n+1 точек от A до B; возвращает индекс первой точки или -1
  function genChain(s, ax, ay, az, bx, by, bz, n, jit, seedA, seedB, keepLv, pk, w0) {
    const st = s.nP;
    if (st + n + 1 > MAXP) return -1;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = len3(dx, dy, dz) || 1e-4;
    const nx = dx / L, ny = dy / L, nz = dz / L;
    // перпендикулярный базис p1, p2
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(ny) > 0.9) { rx = 1; ry = 0; }
    let p1x = ny * rz - nz * ry, p1y = nz * rx - nx * rz, p1z = nx * ry - ny * rx;
    const pl = len3(p1x, p1y, p1z) || 1; p1x /= pl; p1y /= pl; p1z /= pl;
    const p2x = ny * p1z - nz * p1y, p2y = nz * p1x - nx * p1z, p2z = nx * p1y - ny * p1x;
    let G = 2; while (G < n && G < GRID) G <<= 1;
    mpd(G, jit * L * 0.9, 0.58, seedA, seedB, keepLv);
    const P = s.P;
    for (let j = 0; j <= n; j++) {
      const t = j / n, x = t * G;
      const i = Math.min(G - 1, Math.floor(x)), f = x - i;
      const du = DU[i] + (DU[i + 1] - DU[i]) * f, dv = DV[i] + (DV[i + 1] - DV[i]) * f;
      const o = (st + j) * 4;
      P[o] = ax + dx * t + p1x * du + p2x * dv;
      P[o + 1] = ay + dy * t + p1y * du + p2y * dv;
      P[o + 2] = az + dz * t + p1z * du + p2z * dv;
      P[o + 3] = prof(pk, t) * w0;
    }
    s.nP = st + n + 1;
    return st;
  }
  function addChain(s, st, cnt, I, kind, forkT, on) {
    if (st < 0 || s.nC >= MAXC) return -1;
    const c = s.nC++;
    s.cS[c] = st; s.cN[c] = cnt; s.cI[c] = I; s.cK[c] = kind; s.cT[c] = forkT; s.cOn[c] = on ? 1 : 0;
    return c;
  }
  // точка цепочки c по параметру t → _fp (локально)
  const _fp = [0, 0, 0];
  function chainAt(s, st, n, t) {
    const x = clamp(t, 0, 1) * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i, P = s.P;
    const o0 = (st + i) * 4, o1 = o0 + 4;
    _fp[0] = P[o0] + (P[o1] - P[o0]) * f; _fp[1] = P[o0 + 1] + (P[o1 + 1] - P[o0 + 1]) * f; _fp[2] = P[o0 + 2] + (P[o1 + 2] - P[o0 + 2]) * f;
    return P[o0 + 3] + (P[o1 + 3] - P[o0 + 3]) * f;
  }
  // ответвление от точки (px,py,pz) под углом ang к направлению (ux,uy,uz), азимут phi
  function genFork(s, px, py, pz, ux, uy, uz, ang, phi, len, n, jit, sa, sb, w0) {
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(uy) > 0.9) { rx = 1; ry = 0; }
    let p1x = uy * rz - uz * ry, p1y = uz * rx - ux * rz, p1z = ux * ry - uy * rx;
    const pl = len3(p1x, p1y, p1z) || 1; p1x /= pl; p1y /= pl; p1z /= pl;
    const p2x = uy * p1z - uz * p1y, p2y = uz * p1x - ux * p1z, p2z = ux * p1y - uy * p1x;
    const ca = Math.cos(ang), sa2 = Math.sin(ang), cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = ux * ca + (p1x * cp + p2x * sp) * sa2, dy = uy * ca + (p1y * cp + p2y * sp) * sa2, dz = uz * ca + (p1z * cp + p2z * sp) * sa2;
    return genChain(s, px, py, pz, px + dx * len, py + dy * len, pz + dz * len, n, jit, sa, sb, 1, P_TAPER, w0);
  }

  function genStrike(s, regen) {
    const L = s.L0, seedA = s.seed, seedB = hashSeed(s.seed, regen + 1);
    const n = pow2(Math.max(s.segs * Q.seg, L * 2.6 * Q.seg), 4, 32);
    // предыдущий канал → «призрак» (остаточное изображение)
    const ghost = Q.ghost && s.flick;
    const copied = ghost && regen > 0 && s.nMain === n + 1; // при смене качества посреди удара призрак пропускаем
    if (copied) s.P.copyWithin(s.nMain * 4, 0, s.nMain * 4);
    s.nP = 0; s.nC = 0;
    const m0 = genChain(s, 0, 0, 0, L, 0, 0, n, s.jitter, seedA, seedB, 2, P_MAIN, 1);
    addChain(s, m0, n + 1, 1, K_MAIN, 0, 1); s.nMain = n + 1;
    if (ghost) { const g0 = s.nP; s.nP += n + 1; addChain(s, g0, n + 1, 1, K_GHOST, 0, copied); }
    const nb = clampi(s.branches * Q.br, 0, 8);
    for (let b = 0; b < nb; b++) {
      srand(hashSeed(seedA, 100 + b));
      const ft = 0.12 + rnd() * 0.72, phi = rnd() * TAU, ang = 0.36 + rnd() * 0.5;
      const bl = L * (0.14 + rnd() * 0.22) * (1 - ft * 0.4);
      const subR = rnd(), subT = 0.3 + rnd() * 0.3, subPhi = rnd() * TAU, subAng = 0.45 + rnd() * 0.45;
      srand(hashSeed(seedB, 300 + b));
      const on = regen === 0 || rnd() < 0.72;
      const wf = chainAt(s, m0, n + 1, ft) * 0.55;
      const fx = _fp[0], fy = _fp[1], fz = _fp[2];
      // направление основного канала в точке развилки
      chainAt(s, m0, n + 1, Math.min(1, ft + 0.08));
      let ux = _fp[0] - fx, uy = _fp[1] - fy, uz = _fp[2] - fz;
      const ul = len3(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const bn = clampi(n * (bl / L) * 1.9, 3, 14);
      const c0 = genFork(s, fx, fy, fz, ux, uy, uz, ang, phi, bl, bn, 0.2, hashSeed(seedA, 200 + b), hashSeed(seedB, 200 + b), wf);
      if (addChain(s, c0, bn + 1, 0.85, K_BRANCH, ft, on) < 0) break;
      if (Q.sub && subR < 0.6) {
        const wf2 = chainAt(s, c0, bn + 1, subT) * 0.6;
        const sx = _fp[0], sy = _fp[1], sz = _fp[2];
        chainAt(s, c0, bn + 1, subT + 0.15);
        let vx = _fp[0] - sx, vy = _fp[1] - sy, vz = _fp[2] - sz;
        const vl = len3(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl;
        const sl = bl * (0.35 + 0.25 * subR), sn = clampi(bn * 0.55, 2, 8);
        const c1 = genFork(s, sx, sy, sz, vx, vy, vz, subAng, subPhi, sl, sn, 0.22, hashSeed(seedA, 400 + b), hashSeed(seedB, 400 + b), wf2);
        addChain(s, c1, sn + 1, 0.7, K_SUB, ft + (1 - ft) * 0.2, on);
      }
    }
  }

  function genArc(s) {
    const L = s.L0, sb = hashSeed(s.seed, s.regen + 1);
    const n = pow2(s.segs * Q.seg, 4, 32);
    s.nP = 0; s.nC = 0;
    const m0 = genChain(s, 0, 0, 0, L, 0, 0, n, s.jitter, sb, sb, 0, P_ARC, 1);
    addChain(s, m0, n + 1, 1, K_MAIN, 0, 1);
    srand(hashSeed(sb, 77));
    s.amp = reducedMotion ? 0.9 : 0.55 + 0.6 * rnd();
    s.bead = rnd() * 50;
    if (Q.sub && rnd() < 0.5) {
      const ft = 0.3 + rnd() * 0.4, phi = rnd() * TAU, ang = 0.5 + rnd() * 0.5, bl = L * (0.22 + rnd() * 0.25);
      const wf = chainAt(s, m0, n + 1, ft) * 0.6;
      const c0 = genFork(s, _fp[0], _fp[1], _fp[2], 1, 0, 0, ang, phi, bl, 3, 0.3, sb ^ 5, sb ^ 9, wf);
      addChain(s, c0, 4, 0.8, K_BRANCH, ft, 1);
    }
  }

  function genGround(s, regen) {
    const nA = s.gCount, np = s.gN, G = s.G, P = s.P;
    if (regen === 0) {
      srand(hashSeed(s.seed, 5));
      const off = rnd() * TAU;
      for (let k = 0; k < nA; k++) {
        const o = k * 6;
        G[o] = off + (k / nA) * TAU + rs2() * (1.6 / nA);  // азимут
        G[o + 1] = rs2() * 0.9;                            // закрутка по радиусу
        G[o + 2] = rnd() * 0.14 * s.dur;                   // задержка старта
        G[o + 3] = 1;                                      // яркость (стробируется)
        G[o + 4] = 0.85 + rnd() * 0.3;                     // доля радиуса
        G[o + 5] = 0;                                      // вилка: индекс точки (0 — нет)
      }
    }
    srand(hashSeed(s.seed, 1000 + regen));
    for (let k = 0; k < nA; k++) {
      const o = k * 6;
      G[o + 3] = reducedMotion ? 0.9 : 0.55 + 0.6 * rnd();
      G[o + 5] = Q.sub && rnd() < 0.55 ? 2 + Math.floor(rnd() * (np - 4)) : 0;
      for (let j = 0; j < np; j++) {
        const p = (k * GP + j) * 4;
        P[p] = j === 0 ? 0 : rs2();          // поперечный зигзаг
        P[p + 1] = rnd();                    // подскок над землёй
        P[p + 2] = rs2();                    // вилка: поперечное направление
        P[p + 3] = 0;
      }
    }
    s.bead = rnd() * 50;
  }

  // ---------------------------------------------------------------- запись вершин
  const CX = new Float32Array(64), CY = new Float32Array(64), CZ = new Float32Array(64), CW = new Float32Array(64);
  // «кисть» текущей цепочки: r,g,b, яркость, ядро r,g,b, rival, lift (Float64Array — запись без аллокаций)
  const BR = new Float64Array(9);
  function paint(s, I, coreW) {
    BR[0] = s.col[0]; BR[1] = s.col[1]; BR[2] = s.col[2]; BR[3] = I;
    BR[4] = s.core[0] * coreW; BR[5] = s.core[1] * coreW; BR[6] = s.core[2] * coreW; BR[7] = s.rival;
  }
  function vert(v, x, y, z, t0, t1, t2, t3, s0, s1, s2, s3) {
    let o = v * 3; aPos[o] = x; aPos[o + 1] = y; aPos[o + 2] = z;
    o = v * 4;
    aTan[o] = t0; aTan[o + 1] = t1; aTan[o + 2] = t2; aTan[o + 3] = t3;
    aSide[o] = s0; aSide[o + 1] = s1; aSide[o + 2] = s2; aSide[o + 3] = s3;
    aCol[o] = BR[0]; aCol[o + 1] = BR[1]; aCol[o + 2] = BR[2]; aCol[o + 3] = BR[3];
    aCore[o] = BR[4]; aCore[o + 1] = BR[5]; aCore[o + 2] = BR[6]; aCore[o + 3] = BR[7];
  }
  // лента по точкам CX..CW (n точек), along0 — сдвиг «бусин»
  function ribbon(n, along0) {
    if (n < 2 || BR[3] <= 1e-4) return;
    let along = along0;
    for (let j = 0; j < n - 1; j++) {
      if (quadN >= Q.cap) return;
      const a = j > 0 ? j - 1 : 0, b = j + 1, c = j + 2 < n ? j + 2 : n - 1;
      const t0x = CX[b] - CX[a], t0y = CY[b] - CY[a], t0z = CZ[b] - CZ[a];
      const t1x = CX[c] - CX[j], t1y = CY[c] - CY[j], t1z = CZ[c] - CZ[j];
      const seg = len3(CX[b] - CX[j], CY[b] - CY[j], CZ[b] - CZ[j]);
      const w0 = CW[j], w1 = CW[b], al1 = along + seg;
      const v = quadN * 4;
      vert(v, CX[j], CY[j], CZ[j], t0x, t0y, t0z, BR[8], -1, along, w0, 0);
      vert(v + 1, CX[j], CY[j], CZ[j], t0x, t0y, t0z, BR[8], 1, along, w0, 0);
      vert(v + 2, CX[b], CY[b], CZ[b], t1x, t1y, t1z, BR[8], -1, al1, w1, 0);
      vert(v + 3, CX[b], CY[b], CZ[b], t1x, t1y, t1z, BR[8], 1, al1, w1, 0);
      along = al1; quadN++;
    }
  }
  function bill(x, y, z, size, ang, spikes, ring, pull) {
    if (quadN >= Q.cap || BR[3] <= 1e-4 || !(size > 0)) return;
    const v = quadN * 4;
    vert(v, x, y, z, ang, spikes, ring, pull, -1, -1, size, 1);
    vert(v + 1, x, y, z, ang, spikes, ring, pull, 1, -1, size, 1);
    vert(v + 2, x, y, z, ang, spikes, ring, pull, -1, 1, size, 1);
    vert(v + 3, x, y, z, ang, spikes, ring, pull, 1, 1, size, 1);
    quadN++;
  }
  function disc(x, y, z, size, ring) {
    if (quadN >= Q.cap || BR[3] <= 1e-4 || !(size > 0)) return;
    const v = quadN * 4;
    vert(v, x, y, z, 0, 0, ring, 0, -1, -1, size, 2);
    vert(v + 1, x, y, z, 0, 0, ring, 0, 1, -1, size, 2);
    vert(v + 2, x, y, z, 0, 0, ring, 0, -1, 1, size, 2);
    vert(v + 3, x, y, z, 0, 0, ring, 0, 1, 1, size, 2);
    quadN++;
  }

  // рамка from→to: world = F + (Dn*a + U*b + V*c) * sc
  const FR = new Float64Array(14); // F(0..2) D(3..5) U(6..8) V(9..11) масштаб(12) длина(13)
  function frame(s) {
    FR[0] = s.fx; FR[1] = s.fy; FR[2] = s.fz;
    let dx = s.tx - s.fx, dy = s.ty - s.fy, dz = s.tz - s.fz;
    let L = len3(dx, dy, dz);
    if (!(L > 1e-4)) { dx = 0; dy = -1; dz = 0; L = 1e-4; } else { dx /= L; dy /= L; dz /= L; }
    FR[3] = dx; FR[4] = dy; FR[5] = dz; FR[13] = L; FR[12] = L / Math.max(s.L0, 1e-4);
    let rx = 0, ry = 1, rz = 0;
    if (Math.abs(dy) > 0.95) { rx = 1; ry = 0; }
    FR[6] = dy * rz - dz * ry; FR[7] = dz * rx - dx * rz; FR[8] = dx * ry - dy * rx;
    const ul = len3(FR[6], FR[7], FR[8]) || 1; FR[6] /= ul; FR[7] /= ul; FR[8] /= ul;
    FR[9] = dy * FR[8] - dz * FR[7]; FR[10] = dz * FR[6] - dx * FR[8]; FR[11] = dx * FR[7] - dy * FR[6];
  }
  // цепочка c слота → CX..CW (с частичным раскрытием frac), затем лента
  function drawChain(s, c, frac, hwMul, along0) {
    const st = s.cS[c], n = s.cN[c], P = s.P;
    if (n < 2 || frac <= 0) return;
    let m = n, k = n - 1, f = 0;
    if (frac < 1) { const x = frac * (n - 1); k = Math.floor(x); f = x - k; m = Math.min(n, k + 2); }
    const hw = s.width * HALO * hwMul;
    for (let j = 0; j < m && j < 64; j++) {
      let o = (st + j) * 4, a = P[o], b = P[o + 1], cc = P[o + 2], w = P[o + 3];
      if (frac < 1 && j === k + 1) { // интерполированный фронт лидера
        const q = (st + k) * 4;
        a = P[q] + (a - P[q]) * f; b = P[q + 1] + (b - P[q + 1]) * f; cc = P[q + 2] + (cc - P[q + 2]) * f; w = P[q + 3] + (w - P[q + 3]) * f;
      }
      CX[j] = FR[0] + (FR[3] * a + FR[6] * b + FR[9] * cc) * FR[12];
      CY[j] = FR[1] + (FR[4] * a + FR[7] * b + FR[10] * cc) * FR[12];
      CZ[j] = FR[2] + (FR[5] * a + FR[8] * b + FR[11] * cc) * FR[12];
      CW[j] = w * hw;
    }
    ribbon(Math.min(m, 64), along0);
  }
  // сглаженная прореженная копия цепочки (широкая «корона»: без складок ленты на изломах)
  function drawCorona(s, c, stride, hwMul) {
    const st = s.cS[c], n = s.cN[c], P = s.P, hw = s.width * HALO * hwMul;
    let m = 0;
    for (let j = 0; ; j += stride) {
      const i = Math.min(n - 1, j), i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const o = (st + i) * 4, o0 = (st + i0) * 4, o1 = (st + i1) * 4;
      const a = (P[o0] + P[o] * 2 + P[o1]) * 0.25, b = (P[o0 + 1] + P[o + 1] * 2 + P[o1 + 1]) * 0.25, cc = (P[o0 + 2] + P[o + 2] * 2 + P[o1 + 2]) * 0.25;
      CX[m] = FR[0] + (FR[3] * a + FR[6] * b + FR[9] * cc) * FR[12];
      CY[m] = FR[1] + (FR[4] * a + FR[7] * b + FR[10] * cc) * FR[12];
      CZ[m] = FR[2] + (FR[5] * a + FR[8] * b + FR[11] * cc) * FR[12];
      CW[m] = P[o + 3] * hw * (m === 0 ? 0.3 : 1);
      m++;
      if (i >= n - 1 || m >= 64) break;
    }
    ribbon(m, 0);
  }

  // ---------------------------------------------------------------- отрисовка типов
  function drawStrike(s) {
    frame(s); BR[8] = s.lift;
    const age = s.age, rv = s.rv, half = s.half, strobe = s.flick && !reducedMotion;
    let I, Ib, Ig, cw, rvF = 1;
    if (age < rv) { rvF = age / rv; I = 0.65; Ib = 0.55; Ig = 0; cw = 0.9; }
    else if (age < half) {
      if (strobe) {
        const k = age >= s.t2 ? 2 : age >= s.t1 ? 1 : 0;
        const tk = k === 2 ? s.t2 : k === 1 ? s.t1 : rv, amp = k === 0 ? 1 : k === 1 ? 0.72 : 0.9;
        I = amp * (0.5 + 0.5 * Math.exp(-(age - tk) / 0.03));
        const nx = k === 0 ? s.t1 : k === 1 ? s.t2 : 1e9;
        if (nx - age < 0.018) I *= 0.3; // тёмный провал перед повторным ударом
      } else I = 1 - 0.3 * (age - rv) / Math.max(half - rv, 1e-3);
      Ib = I * 0.8; Ig = 0.32 * I; cw = 1;
    } else {
      const u = clamp((age - half) / Math.max(s.dur - half, 1e-3), 0, 1), e = Math.pow(1 - u, 1.6);
      I = 0.42 * e; Ib = 0.5 * e * (1 - u) * (1 - u); Ig = 0.22 * e; cw = 1 - 0.75 * u;
    }
    const base = s.intensity;
    for (let c = 0; c < s.nC; c++) {
      if (!s.cOn[c]) continue;
      const kind = s.cK[c];
      let frac = 1, Ic = I, wm = 1, cwc = cw;
      if (kind === K_MAIN) frac = rvF;
      else if (kind === K_GHOST) { if (age < rv) continue; Ic = Ig; wm = 1.25; cwc = 0.35; }
      else { frac = clamp((rvF - s.cT[c]) / 0.3, 0, 1); Ic = Ib * (kind === K_SUB ? 0.8 : 1); cwc = cw * 0.85; }
      paint(s, base * Ic * s.cI[c], cwc);
      drawChain(s, c, frac, wm, s.bead + c * 7.3);
      if (kind === K_MAIN && Q.hq && age >= rv && age < half) { // широкая «корона» вокруг канала во вспышке
        paint(s, base * I * 0.1, 0);
        drawCorona(s, c, 4, 4.0);
      }
      if (Q.tips && kind >= K_BRANCH && frac >= 1 && age < half) { // светящиеся кончики ветвей
        const n = s.cN[c];
        paint(s, base * Ic * 0.35, cwc);
        bill(CX[n - 1], CY[n - 1], CZ[n - 1], s.width * 1.6, 0, 0, 0, 0.05);
      }
    }
    // точка выхода
    if (s.origin) {
      paint(s, base * Math.max(I, 0.2) * 0.45, 0.8);
      bill(s.fx, s.fy, s.fz, s.width * 4.2, 0, 0, 0, s.width * 2);
    }
    if (age >= rv) {
      const tx = s.tx, ty = s.ty, tz = s.tz;
      // остаточное свечение в точке удара
      paint(s, base * I * 0.55, cw);
      bill(tx, ty, tz, s.width * 5.5, 0, 0, 0, s.width * 5);
      // звезда удара: первые 0.1 с
      const sf = (age - rv) / 0.1;
      if (s.star && sf < 1) {
        const e = (1 - sf) * (1 - sf);
        paint(s, base * 0.6 * e, 1);
        bill(tx, ty, tz, s.width * (11 + 9 * sf), s.ang + sf * 0.25, 1, 0.22 + 0.62 * sf, 1.0);
      }
    }
  }

  function drawArc(s) {
    frame(s); BR[8] = s.lift;
    const age = s.age, fo = Math.min(0.12, s.dur * 0.4);
    const fin = Math.min(1, age / 0.03), fout = age > s.dur - fo ? Math.max(0, (s.dur - age) / fo) : 1;
    const I = s.intensity * s.amp * fin * fout;
    for (let c = 0; c < s.nC; c++) {
      if (!s.cOn[c]) continue;
      paint(s, I * s.cI[c], 1);
      drawChain(s, c, 1, 1, s.bead + c * 5.1);
    }
    // точки контакта
    if (Q.tips) {
      paint(s, I * 0.4, 0.9);
      const sz = s.width * 4.5;
      bill(s.fx, s.fy, s.fz, sz, 0, 0, 0, sz); bill(s.tx, s.ty, s.tz, sz, 0, 0, 0, sz);
    }
  }

  function drawGround(s) {
    BR[8] = 0;
    const age = s.age, dur = s.dur, R = s.radius, r0 = Math.min(0.25, R * 0.2), np = s.gN, G = s.G, P = s.P;
    const cx = s.fx, cy = s.fy + 0.05, cz = s.fz;
    const fout = age > dur * 0.65 ? Math.max(0, (dur - age) / (dur * 0.35)) : 1;
    const hw = s.width * HALO;
    let ringR = 0, ringN = 0;
    for (let k = 0; k < s.gCount; k++) {
      const o = k * 6, delay = G[o + 2];
      let f = (age - delay) / (dur * 0.72);
      if (f <= 0) continue;
      f = Math.min(f, 1);
      const Rk = R * G[o + 4];
      const rh = r0 + (Rk - r0) * (1 - (1 - f) * (1 - f));
      const rt = r0 * 0.5 + (rh - r0) * sstep(0.3, 1.0, f) * 0.85;
      const I = s.intensity * G[o + 3] * Math.min(1, (age - delay) / 0.04) * fout;
      if (I <= 1e-3) continue;
      const th = G[o], curl = G[o + 1];
      ringR += rh; ringN++;
      for (let j = 0; j < np; j++) {
        const q = j / (np - 1), r = rt + (rh - rt) * q;
        const p = (k * GP + j) * 4;
        const ang = th + curl * (r / R);
        const lat = P[p] * (0.1 + 0.1 * Math.min(1, r)) * (j === np - 1 ? 0.3 : 1);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        CX[j] = cx + ca * r - sa * lat;
        CZ[j] = cz + sa * r + ca * lat;
        CY[j] = cy + P[p + 1] * 0.13 * Math.sin(Math.PI * q);
        CW[j] = hw * (0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, 0.12 + q * 0.95)));
      }
      paint(s, I, 1);
      ribbon(np, s.bead + k * 9.7);
      const hx = CX[np - 1], hy = CY[np - 1], hz = CZ[np - 1];
      // вилка у одной из точек: короткий отросток в сторону
      const fj = G[o + 5] | 0;
      if (fj > 0 && fj < np - 1) {
        const p = (k * GP + fj) * 4, side = P[p + 2] >= 0 ? 1 : -1;
        const bx = CX[fj], by = CY[fj], bz = CZ[fj];
        const ang = th + curl * (0.5) + side * (0.6 + 0.5 * Math.abs(P[p + 2]));
        const len = 0.35 + 0.35 * Math.abs(P[p + 2]);
        const w0 = CW[fj] * 0.7;
        for (let j = 0; j < 4; j++) {
          const q = j / 3, jit = j === 0 ? 0 : P[(k * GP + ((fj + j) % np)) * 4] * 0.08;
          CX[j] = bx + Math.cos(ang) * len * q - Math.sin(ang) * jit;
          CZ[j] = bz + Math.sin(ang) * len * q + Math.cos(ang) * jit;
          CY[j] = cy + (by - cy) * (1 - q) + 0.03 * q;
          CW[j] = w0 * (1 - q * 0.95);
        }
        paint(s, I * 0.75, 0.9);
        ribbon(4, s.bead + k * 3.1);
      }
      // горячая голова
      paint(s, I * 0.8, 1);
      bill(hx, hy, hz, s.width * 5.5, 0, 0, 0, s.width * 3);
    }
    // световое пятно на земле + кольцо фронта разрядов (читается с камеры за спиной)
    if (ringN > 0) {
      const ds = R * 1.15;
      paint(s, s.intensity * 0.2 * fout, 0.25);
      disc(cx, s.fy + 0.02, cz, ds, clamp(ringR / ringN / ds, 0.05, 0.97));
    }
    // вспышка в центре
    const cf = Math.max(0, 1 - age / (dur * 0.45));
    if (cf > 0) {
      paint(s, s.intensity * 0.55 * cf * cf, 1);
      bill(cx, cy + 0.12, cz, Math.min(1.4, R * 0.28), 0, 0, 0, 0.4);
    }
  }

  // ---------------------------------------------------------------- API
  function strike(opts) {
    if (disposed) return DEAD;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!hasVec(o.from) || !hasVec(o.to)) return DEAD;
    const s = takeSlot();
    s.type = T_STRIKE;
    readCommon(s, o, 0.09, 3.0, 0.12, 18, 0.45);
    s.fx = o.from.x; s.fy = o.from.y; s.fz = o.from.z; s.tx = o.to.x; s.ty = o.to.y; s.tz = o.to.z;
    s.L0 = Math.max(1e-3, len3(s.tx - s.fx, s.ty - s.fy, s.tz - s.fz));
    s.branches = clampi(num(o.branches, 4), 0, 8);
    s.flick = o.flicker !== false;
    s.star = o.star !== false; s.origin = o.origin !== false;
    s.lift = clamp(num(o.lift, 0), 0, 2);
    s.rv = Math.min(0.05, s.dur * 0.12);
    s.half = Math.max(s.rv + 0.02, s.dur * 0.5);
    s.t1 = s.rv + (s.half - s.rv) * 0.36; s.t2 = s.rv + (s.half - s.rv) * 0.7;
    srand(hashSeed(s.seed, 9)); s.ang = rnd() * TAU; s.bead = rnd() * 50;
    s.nMain = 0;
    genStrike(s, 0);
    return handleFor(s);
  }
  function arc(opts) {
    if (disposed) return DEAD;
    const o = opts && typeof opts === 'object' ? opts : {};
    const follow = typeof o.follow === 'function' ? o.follow : null;
    let from = o.from, to = o.to;
    if ((!hasVec(from) || !hasVec(to)) && follow) {
      try { const r = follow(); if (r) { from = r.from; to = r.to; } } catch (e) { /* пусто */ }
    }
    if (!hasVec(from) || !hasVec(to)) return DEAD;
    const s = takeSlot();
    s.type = T_ARC;
    readCommon(s, o, 0.03, 2.0, 0.25, 8, 0.3);
    s.fx = from.x; s.fy = from.y; s.fz = from.z; s.tx = to.x; s.ty = to.y; s.tz = to.z;
    s.L0 = Math.max(1e-3, len3(s.tx - s.fx, s.ty - s.fy, s.tz - s.fz));
    s.rate = clamp(num(o.rate, 20), 0, 120);
    s.follow = follow;
    s.lift = clamp(num(o.lift, 0.2), 0, 2);
    genArc(s);
    return handleFor(s);
  }
  function groundArcs(opts) {
    if (disposed) return DEAD;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!hasVec(o.center)) return DEAD;
    const s = takeSlot();
    s.type = T_GROUND;
    readCommon(s, o, 0.04, 2.2, 0.2, 10, 0.6);
    s.fx = o.center.x; s.fy = o.center.y; s.fz = o.center.z;
    s.radius = clamp(num(o.radius, 3), 0.2, 30);
    s.gCount = clampi(num(o.count, 6) * Q.ground, 1, MAXG);
    s.gN = Q.gp;
    s.rate = reducedMotion ? 8 : 24;
    genGround(s, 0);
    return handleFor(s);
  }

  function update(dt, clock) {
    if (disposed) return;
    const h = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    quadN = 0; activeN = 0;
    try {
      for (let i = 0; i < SLOTS; i++) {
        const s = slots[i];
        if (!s.active) continue;
        s.age += h;
        if (s.age >= s.dur) { freeSlot(s); continue; }
        activeN++;
        if (s.type === T_STRIKE) {
          if (s.flick && !reducedMotion) {
            if (s.regen === 0 && s.age >= s.t1) { s.regen = 1; genStrike(s, 1); }
            else if (s.regen === 1 && s.age >= s.t2) { s.regen = 2; genStrike(s, 2); }
          }
          drawStrike(s);
        } else if (s.type === T_ARC) {
          if (s.follow) {
            let r = null;
            try { r = s.follow(); } catch (e) { r = null; }
            if (r && hasVec(r.from) && hasVec(r.to)) { s.fx = r.from.x; s.fy = r.from.y; s.fz = r.from.z; s.tx = r.to.x; s.ty = r.to.y; s.tz = r.to.z; }
          }
          const rate = reducedMotion ? Math.min(s.rate, 6) : s.rate;
          s.rt += h * rate;
          if (s.rt >= 1) {
            s.rt -= Math.floor(s.rt); s.regen++;
            s.L0 = Math.max(1e-3, len3(s.tx - s.fx, s.ty - s.fy, s.tz - s.fz));
            genArc(s);
          }
          drawArc(s);
        } else if (s.type === T_GROUND) {
          s.rt += h * s.rate;
          if (s.rt >= 1) { s.rt -= Math.floor(s.rt); s.regen++; genGround(s, s.regen); }
          drawGround(s);
        }
      }
    } catch (e) { /* эффекты не роняют кадр */ }
    const n = quadN;
    mesh.visible = n > 0;
    geo.setDrawRange(0, n * 6);
    if (n > 0) {
      for (let a = 0; a < 5; a++) {
        // свой объект диапазона вместо addUpdateRange({…}) — без аллокации в кадре (рендерер сам очищает список)
        const at = attrs[a], R = ranges[a];
        R.start = 0; R.count = n * 4 * at.itemSize;
        at.clearUpdateRanges(); at.updateRanges.push(R); at.needsUpdate = true;
      }
    }
  }

  function setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    Q = q;
    uniforms.uHQ.value = q.hq;
  }
  function setReducedMotion(v) { reducedMotion = !!v; }
  function clear() {
    for (let i = 0; i < SLOTS; i++) if (slots[i].active) freeSlot(slots[i]);
    quadN = 0; activeN = 0; geo.setDrawRange(0, 0); mesh.visible = false;
  }
  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose(); mat.dispose();
  }
  function stats() { return { active: activeN, drawCalls: mesh.visible ? 1 : 0, quads: quadN, cap: Q.cap }; }

  return { strike, arc, groundArcs, update, setQuality, setReducedMotion, clear, dispose, stats, mesh };
}
