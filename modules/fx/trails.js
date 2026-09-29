// ASHEN OATH — modules/fx/trails.js. Владелец: №7 [VFX].
// Ленты-следы V6 (хвосты снарядов, росчерки рук, дым за метеором, призрачные шлейфы).
//  - ВСЕ ленты — ОДИН draw call: общая динамическая BufferGeometry (пара вершин на точку),
//    лента разворачивается к камере в вершинном шейдере: side = normalize(cross(tangent, toCamera));
//  - атрибуты вершины: uv.x — возраст точки 0 (голова)..1 (хвост), uv.y — поперёк -1..1,
//    дуга s (м, для шума, привязанного к ленте), координата головы (для круглого «носа»),
//    стиль, линейные цвета mid/hot, яркость, rival;
//  - стили: energy (белое ядро + мягкий ореол + бегущие искры), fire (fbm-языки пламени,
//    рампа hot→mid→deep по возрасту), smoke (тёмный премультиплицированный дым, расширяется),
//    ghost (бледные полупрозрачные пряди с волной);
//  - spiral > 0: точки смещены вокруг направления полёта вращающимся вектором → спиральный хвост;
//  - без аллокаций в кадре: слоты, ручки и типизированные массивы фиксированного размера.
// Координаты — в пространстве root (в игре root без трансформации = мир).
import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const SLOTS = 24;          // ёмкость пула (high); medium/low режут через Q.cap
const MAXP = 48;           // зафиксированных точек на ленту (максимум)
const PF = 8;              // floats на точку: rx,ry,rz (путь), x,y,z (со спиралью), birth, s
const RP = MAXP + 3;       // точек рендера на ленту: голова + точки + хвост + «нос»
const NV = SLOTS * RP * 2;
const NI = SLOTS * (RP - 1) * 6;
const HANDLES = 128;       // кольцо ручек (живую ручку не переиспользуем)
const IDLE = 4;            // сек без push и без видимых точек → слот освобождается сам
const STYLES = Object.freeze({ energy: 0, fire: 1, smoke: 2, ghost: 3 });
const DEF = Object.freeze([
  Object.freeze({ color: ELEMENTS.storm.mid, hot: ELEMENTS.storm.core, width: 0.25, life: 0.35 }),
  Object.freeze({ color: ELEMENTS.fire.mid, hot: ELEMENTS.fire.core, width: 0.25, life: 0.35 }),
  Object.freeze({ color: ELEMENTS.fire.smoke, hot: ELEMENTS.fire.deep, width: 0.5, life: 1.0 }),
  Object.freeze({ color: ELEMENTS.frost.hot, hot: ELEMENTS.frost.core, width: 0.3, life: 0.6 }),
]);
const QUALITY = Object.freeze({
  low: Object.freeze({ cap: 8, pts: 0.6, hq: 0 }),
  medium: Object.freeze({ cap: 16, pts: 0.8, hq: 1 }),
  high: Object.freeze({ cap: SLOTS, pts: 1, hq: 1 }),
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampI = (v, a, b) => clamp(Math.round(v), a, b);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
attribute vec4 aTan;   // касательная (к голове), полуширина (м)
attribute vec4 aUv;    // возраст 0..1, поперёк -1..1, дуга s (м), голова (в полуширинах; <0 — «нос»)
attribute vec4 aCol;   // линейный mid, яркость
attribute vec4 aHot;   // линейный hot, rival
attribute float aSty;  // стиль
uniform float uTime;
uniform float uViewH;
uniform float uMinPx;
varying vec4 vUv;
varying vec4 vCol;
varying vec4 vHot;
varying float vSty;
varying float vW;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 toCam = cameraPosition - wp;
  float dist = max(length(toCam), 0.05);
  vec3 vd = toCam / dist;
  vec3 t = mat3(modelMatrix) * aTan.xyz;
  vec3 s = cross(t, vd); float sl = length(s);
  s = sl > 1e-6 ? s / sl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  float pxw = 2.0 * dist / (max(projectionMatrix[1][1], 1e-3) * max(uViewH, 1.0)); // м на пиксель
  float hw = aTan.w, hwc = max(hw, uMinPx * pxw);
  vW = hw > 0.0 ? sqrt(hw / hwc) : 0.0;  // далёкая/тонкая лента: не толще, а тусклее
  if (aSty > 2.5) wp += s * (sin(aUv.z * 2.6 - uTime * 7.0) * hwc * 0.9 * aUv.x); // призрак: волна
  wp += s * (aUv.y * hwc);
  vUv = aUv; vCol = aCol; vHot = aHot; vSty = aSty;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FS = /* glsl */`
uniform float uTime;
uniform float uHQ;
varying vec4 vUv;
varying vec4 vCol;
varying vec4 vHot;
varying float vSty;
varying float vW;
${FX_NOISE}
${FX_RIVAL}
void main() {
  float a = clamp(vUv.x, 0.0, 1.0), x = vUv.y, s = vUv.z, hc = vUv.w;
  float cap = clamp(-hc, 0.0, 1.0);
  float x2 = x * x + cap * cap;               // круглый «нос» у головы
  if (x2 >= 1.0) discard;
  float headK = exp(-max(hc, 0.0) * 0.45);    // горячая голова (~2 полуширины)
  float life = 1.0 - a;
  vec3 mid = vCol.rgb, hot = vHot.rgb;
  float I = vCol.a * vW;
  vec3 col = vec3(0.0);
  float al = 0.0;                             // премультиплицированная «плотность» (0 — чистый аддитив)
  if (vSty < 0.5) {
    // energy: белое ядро + насыщенная середина + мягкий ореол, бегущие искры
    float core = exp(-x2 * 38.0);
    float body = exp(-x2 * 9.0);
    float halo = exp(-x2 * 2.6) * (1.0 - x2);
    float sp = 0.0;
    if (uHQ > 0.5) {
      float n = fxNoise2(vec2(s * 7.0 - uTime * 16.0, x * 2.2 + 3.7));
      sp = pow(n, 7.0) * 3.0 * body;
    }
    col = hot * (core * (life * 1.3 + headK * 1.2))
        + mix(mid, hot, 0.25) * (body * 0.55 * life)
        + mid * (halo * 0.38 * sqrt(life)) + hot * (sp * life);
    col *= I;
  } else if (vSty < 1.5) {
    // fire: языки пламени (fbm бежит к хвосту), рампа hot → mid → deep по возрасту
    vec2 q = vec2(s * 2.3 - uTime * 5.5, x * 1.35 + uTime * 0.9);
    float n = uHQ > 0.5 ? fxFbm2(q) : fxNoise2(q) * 0.94;
    float body = 1.0 - x2;
    float thr = 0.18 + a * 0.62;
    float m = smoothstep(thr, thr + 0.22, n * 0.85 + body * 0.62 - a * 0.1 + headK * 0.25);
    float temp = clamp(m * (1.05 - a * 0.9) * (0.35 + body * 0.75) + headK * 0.45 * body, 0.0, 1.0);
    vec3 deep = mid * mid * 0.8;
    vec3 ramp = temp > 0.55 ? mix(mid, hot, (temp - 0.55) / 0.45) : mix(deep, mid, temp / 0.55);
    col = ramp * (m * I * (0.45 + temp * 1.35));
    al = m * 0.08 * life;                     // лёгкая плотность: пламя не «стеклянное»
  } else if (vSty < 2.5) {
    // smoke: тёмный мягкий шумный дым (премультиплицированная альфа)
    vec2 q = vec2(s * 1.25 - uTime * 0.7, x * 0.9 - uTime * 0.35);
    float n = uHQ > 0.5 ? fxFbm2(q) : fxNoise2(q) * 0.94;
    float soft = 1.0 - x2; soft *= soft;
    float d = soft * smoothstep(0.2, 0.7, n + soft * 0.25) * pow(life, 1.3) * smoothstep(0.0, 0.06, a);
    al = clamp(d * 0.8 * min(vCol.a * 0.5, 1.5) * vW, 0.0, 0.95);
    col = mid * (0.55 + n * 0.8) * al + hot * (headK * soft * 0.6 * vCol.a * vW); // тлеющий край у источника
  } else {
    // ghost: бледные пряди, волна по ширине
    float w = fxNoise2(vec2(s * 1.8 - uTime * 1.6, x * 1.4 + a * 2.0));
    float soft = exp(-x2 * 2.4) * (1.0 - x2);
    float strands = 0.5 + 0.5 * sin(x * 7.0 + s * 3.2 - uTime * 3.5 + w * 4.0);
    float d = soft * (0.4 + 0.6 * strands * w) * pow(life, 1.2);
    vec3 pale = mix(mid, hot, 0.55 + 0.45 * headK);
    col = pale * (d * I * 0.75) + hot * (exp(-x2 * 30.0) * headK * I * 0.6);
    al = d * 0.22 * vW;
  }
  col = fxRival(col, vHot.a);
  gl_FragColor = vec4(col, al);
  ${FX_OUT}
}
`;

/**
 * createTrails({ THREE, root, camera }) → { create(opts) → handle, update(dt, clock), setQuality, clear, dispose, stats }
 * opts: { width:0.25, life:0.35, color, hot, intensity:2.0, taper:1, rival:0, style:'energy'|'fire'|'smoke'|'ghost',
 *         maxPoints:32, minDist:0.05, spiral:0, spiralRate:18 }
 * handle: { alive, push(pos), stop(), kill(), setIntensity(v) }
 */
export function createTrails(deps) {
  const d = deps || {};
  const THREE = d.THREE, root = d.root;
  if (!THREE || !root || typeof root.add !== 'function') throw new Error('createTrails: нужны THREE и root');

  let Q = QUALITY.high;
  let disposed = false;
  let tNow = 0, uClock = 0;
  let activeN = 0, vertN = 0, idxN = 0;
  let seedCounter = 1;

  // ---------------------------------------------------------------- общая геометрия
  const aPos = new Float32Array(NV * 3), aTan = new Float32Array(NV * 4), aUv = new Float32Array(NV * 4);
  const aCol = new Float32Array(NV * 4), aHot = new Float32Array(NV * 4), aSty = new Float32Array(NV);
  const idx = new Uint16Array(NI);
  const geo = new THREE.BufferGeometry();
  const mkAttr = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const attrs = [mkAttr(aPos, 3), mkAttr(aTan, 4), mkAttr(aUv, 4), mkAttr(aCol, 4), mkAttr(aHot, 4), mkAttr(aSty, 1)];
  geo.setAttribute('position', attrs[0]); geo.setAttribute('aTan', attrs[1]); geo.setAttribute('aUv', attrs[2]);
  geo.setAttribute('aCol', attrs[3]); geo.setAttribute('aHot', attrs[4]); geo.setAttribute('aSty', attrs[5]);
  const idxAttr = mkAttr(idx, 1);
  geo.setIndex(idxAttr);
  const ranges = attrs.map(() => ({ start: 0, count: 0 }));
  const idxRange = { start: 0, count: 0 };
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  geo.setDrawRange(0, 0);

  const uniforms = { uTime: { value: 0 }, uHQ: { value: 1 }, uViewH: { value: 720 }, uMinPx: { value: 1.6 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VS, fragmentShader: FS,
    ...premulBlend(THREE), depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ashen-fx-trails'; mesh.frustumCulled = false; mesh.renderOrder = 24;
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

  // ---------------------------------------------------------------- слоты
  function makeSlot(i) {
    return {
      i, active: false, gen: 0, stopped: false, style: 0, width: 0.25, life: 0.35, taper: 1, intensity: 2, rival: 0,
      maxP: 32, minDist: 0.05, spiral: 0, spiralRate: 18, phase0: 0, sOff: 0, born: 0, lastPush: 0,
      col: [0, 0, 0], hot: [0, 0, 0],
      P: new Float32Array(MAXP * PF), nP: 0,
      hasHead: false, hr: [0, 0, 0], hd: [0, 0, 0], hB: 0, dir: [0, 0, -1],
      lastT: 0, // время последней зафиксированной точки (для подразбиения спирали)
    };
  }
  const slots = [];
  for (let i = 0; i < SLOTS; i++) slots.push(makeSlot(i));

  class TrailHandle {
    constructor() { this._s = null; this._g = -1; }
    get alive() { const s = this._s; return !!s && s.active && s.gen === this._g && !disposed; }
    push(pos) { if (this.alive && hasVec(pos)) { try { pushPoint(this._s, pos.x, pos.y, pos.z); } catch (e) { /* не роняем */ } } }
    stop() { if (this.alive) this._s.stopped = true; }
    kill() { if (this.alive) freeSlot(this._s); }
    setIntensity(v) { if (this.alive && isNum(v)) this._s.intensity = clamp(v, 0, 50); }
  }
  const handles = [];
  for (let i = 0; i < HANDLES; i++) handles.push(new TrailHandle());
  let handleHead = 0;
  const DEAD = new TrailHandle(); // возвращается, когда создать нельзя (всё — no-op)

  function freeSlot(s) { s.active = false; s.gen++; s.nP = 0; s.hasHead = false; }
  function takeSlot() {
    const cap = Q.cap;
    let best = null, bestK = -Infinity;
    for (let i = 0; i < cap; i++) {
      const s = slots[i];
      if (!s.active) { best = s; break; }
      // крадём: сначала остановленные, из них — давно не двигавшиеся
      const k = (s.stopped ? 1e6 : 0) + (tNow - s.lastPush);
      if (k > bestK) { bestK = k; best = s; }
    }
    if (!best) return null;
    if (best.active) freeSlot(best);
    best.gen++; best.active = true; best.stopped = false; best.nP = 0; best.hasHead = false;
    return best;
  }
  function handleFor(s) {
    // пропускаем живые ручки: чужой эффект никогда не перехватывается
    let h = null;
    for (let k = 0; k < HANDLES; k++) {
      const c = handles[handleHead]; handleHead = (handleHead + 1) % HANDLES;
      if (!c.alive) { h = c; break; }
    }
    if (!h) return DEAD;
    h._s = s; h._g = s.gen; return h;
  }

  function create(opts) {
    if (disposed) return DEAD;
    const o = opts && typeof opts === 'object' ? opts : {};
    const s = takeSlot();
    if (!s) return DEAD;
    const st = STYLES[o.style] !== undefined ? STYLES[o.style] : 0;
    const df = DEF[st];
    s.style = st;
    s.width = clamp(num(o.width, df.width), 0.005, 6);
    s.life = clamp(num(o.life, df.life), 0.03, 10);
    s.taper = clamp(num(o.taper, 1), 0, 1);
    s.intensity = Math.min(3, clamp(num(o.intensity, 2.0), 0, 50) * 0.75); // [VFX] калибровка под bloom игры
    s.rival = clamp(num(o.rival, 0), 0, 1);
    s.maxP = clampI(num(o.maxPoints, 32) * Q.pts, 4, MAXP);
    s.minDist = clamp(num(o.minDist, 0.05), 0.001, 5);
    s.spiral = clamp(num(o.spiral, 0), 0, 3);
    s.spiralRate = clamp(num(o.spiralRate, 18), -200, 200);
    hexLin(isNum(o.color) ? o.color : df.color, s.col);
    hexLin(isNum(o.hot) ? o.hot : df.hot, s.hot);
    seedCounter = (seedCounter * 16807) % 2147483647;
    const r = seedCounter / 2147483647;
    s.phase0 = r * Math.PI * 2;
    s.sOff = r * 97.3;
    s.born = tNow; s.lastPush = tNow; s.lastT = tNow;
    s.dir[0] = 0; s.dir[1] = 0; s.dir[2] = -1;
    return handleFor(s);
  }
  // смещение спирали вокруг направления полёта (в out[0..2])
  const _off = [0, 0, 0];
  function spiralOff(s, t) {
    if (s.spiral <= 0) { _off[0] = 0; _off[1] = 0; _off[2] = 0; return _off; }
    const dx = s.dir[0], dy = s.dir[1], dz = s.dir[2];
    // u = normalize(dir × ax), v = u × dir
    let ax = 0, ay = 1, az = 0;
    if (Math.abs(dy) > 0.95) { ax = 1; ay = 0; }
    let ux = dy * az - dz * ay, uy = dz * ax - dx * az, uz = dx * ay - dy * ax;
    const ul = len3(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = uy * dz - uz * dy, vy = uz * dx - ux * dz, vz = ux * dy - uy * dx;
    const ph = s.phase0 + s.spiralRate * t, c = Math.cos(ph) * s.spiral, sn = Math.sin(ph) * s.spiral;
    _off[0] = ux * c + vx * sn; _off[1] = uy * c + vy * sn; _off[2] = uz * c + vz * sn;
    return _off;
  }
  function commit(s, x, y, z, t, arc) {
    const P = s.P, keep = Math.min(s.nP, s.maxP - 1);
    if (keep > 0) P.copyWithin(PF, 0, keep * PF);
    const off = spiralOff(s, t);
    P[0] = x; P[1] = y; P[2] = z; P[3] = x + off[0]; P[4] = y + off[1]; P[5] = z + off[2]; P[6] = t; P[7] = arc;
    s.nP = keep + 1; s.lastT = t;
  }
  function pushPoint(s, x, y, z) {
    if (s.stopped) return;
    const t = tNow, P = s.P;
    s.lastPush = t;
    if (s.nP === 0) {
      commit(s, x, y, z, t, s.sOff);
    } else {
      const px = P[0], py = P[1], pz = P[2];
      const dx = x - px, dy = y - py, dz = z - pz, dl = len3(dx, dy, dz);
      if (dl > 1e-5) { s.dir[0] = dx / dl; s.dir[1] = dy / dl; s.dir[2] = dz / dl; }
      if (dl >= s.minDist) {
        // подразбиение: спираль остаётся гладкой и при низком fps, большие скачки — без изломов
        const t0 = s.lastT, s0 = P[7];
        let k = 1;
        if (s.spiral > 0) k = Math.ceil(Math.abs(s.spiralRate * (t - t0)) / 0.4);
        k = clamp(Math.max(k, Math.ceil(dl / 0.45)), 1, 4);
        for (let j = 1; j <= k; j++) {
          const f = j / k;
          commit(s, px + dx * f, py + dy * f, pz + dz * f, t0 + (t - t0) * f, s0 + dl * f);
        }
      }
    }
    const off = spiralOff(s, t);
    s.hr[0] = x; s.hr[1] = y; s.hr[2] = z;
    s.hd[0] = x + off[0]; s.hd[1] = y + off[1]; s.hd[2] = z + off[2];
    s.hB = t; s.hasHead = true;
  }

  // ---------------------------------------------------------------- сборка вершин
  const RX = new Float32Array(RP * 3), RA = new Float32Array(RP), RS = new Float32Array(RP), RW = new Float32Array(RP);
  const RT = new Float32Array(RP * 3);
  function env(s, a) {
    const tp = s.taper;
    switch (s.style) {
      case 1: return (1 - tp * a) * (1 + 0.3 * Math.sin(a * Math.PI));          // пламя: «брюшко»
      case 2: return (0.45 + 1.35 * Math.sqrt(a)) * (1 - 0.5 * tp * a * a);      // дым расширяется
      case 3: return (1 - tp * a * 0.85) * (0.8 + 0.5 * Math.sin(a * Math.PI));  // призрак
      default: return 1 - tp * a;
    }
  }
  function addR(n, x, y, z, a, sArc) { RX[n * 3] = x; RX[n * 3 + 1] = y; RX[n * 3 + 2] = z; RA[n] = a; RS[n] = sArc; return n + 1; }

  function buildSlot(s) {
    const P = s.P, life = s.life, t = tNow, inv = 1 / life;
    let k = 0;
    while (k < s.nP && (t - P[k * PF + 6]) < life) k++;
    if (s.nP > k + 1) s.nP = k + 1; // лишние мёртвые точки выбрасываем (одна остаётся для интерполяции хвоста)
    const headOk = s.hasHead && (t - s.hB) < life;
    const visible = headOk || k > 0;
    if (!visible) {
      if (s.stopped || (t - s.lastPush) > IDLE) freeSlot(s);
      return false;
    }
    let n = 0;
    let sHead = s.nP > 0 ? P[7] : s.sOff;
    if (headOk && (s.nP === 0 || len3(s.hr[0] - P[0], s.hr[1] - P[1], s.hr[2] - P[2]) > 1e-4)) {
      if (s.nP > 0) sHead = P[7] + len3(s.hr[0] - P[0], s.hr[1] - P[1], s.hr[2] - P[2]);
      n = addR(n, s.hd[0], s.hd[1], s.hd[2], (t - s.hB) * inv, sHead);
    }
    for (let i = 0; i < k && n < RP - 2; i++) {
      const o = i * PF;
      n = addR(n, P[o + 3], P[o + 4], P[o + 5], (t - P[o + 6]) * inv, P[o + 7]);
    }
    // хвост: точно на возрасте 1 между последней живой и первой мёртвой точкой → плавное укорачивание
    if (k < s.nP && n > 0 && n < RP - 1) {
      const o = k * PF, a1 = (t - P[o + 6]) * inv, a0 = RA[n - 1];
      const f = a1 > a0 + 1e-5 ? clamp((1 - a0) / (a1 - a0), 0, 1) : 1;
      const j = (n - 1) * 3;
      n = addR(n, RX[j] + (P[o + 3] - RX[j]) * f, RX[j + 1] + (P[o + 4] - RX[j + 1]) * f, RX[j + 2] + (P[o + 5] - RX[j + 2]) * f,
        1, RS[n - 1] + (P[o + 7] - RS[n - 1]) * f);
    }
    if (n < 2) return true;
    // дым поднимается и расширяется с возрастом
    const rise = s.style === 2 ? 0.35 * Math.min(life, 2) : 0;
    const w0 = s.width * 0.5;
    for (let i = 0; i < n; i++) {
      const a = clamp(RA[i], 0, 1);
      RW[i] = w0 * Math.max(0, env(s, a));
      if (rise > 0) RX[i * 3 + 1] += rise * a * a;
    }
    // касательные (к голове): центральные разности
    let ltx = s.dir[0], lty = s.dir[1], ltz = s.dir[2];
    for (let i = 0; i < n; i++) {
      const i0 = i > 0 ? i - 1 : i, i1 = i < n - 1 ? i + 1 : i;
      let tx = RX[i0 * 3] - RX[i1 * 3], ty = RX[i0 * 3 + 1] - RX[i1 * 3 + 1], tz = RX[i0 * 3 + 2] - RX[i1 * 3 + 2];
      const tl = len3(tx, ty, tz);
      if (tl > 1e-6) { tx /= tl; ty /= tl; tz /= tl; ltx = tx; lty = ty; ltz = tz; } else { tx = ltx; ty = lty; tz = ltz; }
      RT[i * 3] = tx; RT[i * 3 + 1] = ty; RT[i * 3 + 2] = tz;
    }
    const need = (n + 1) * 2;
    if (vertN + need > NV) return true;
    const cr = s.col, hr = s.hot, I = s.intensity, rv = s.rival, st = s.style;
    const hwH = RW[0] > 1e-4 ? RW[0] : w0;
    const v0 = vertN;
    // «нос»: точка впереди головы на полуширину (круглый торец), координата головы -1
    const put = (px, py, pz, i, a, sArc, hcoord) => {
      for (let sd = -1; sd <= 1; sd += 2) {
        const v = vertN++;
        aPos[v * 3] = px; aPos[v * 3 + 1] = py; aPos[v * 3 + 2] = pz;
        aTan[v * 4] = RT[i * 3]; aTan[v * 4 + 1] = RT[i * 3 + 1]; aTan[v * 4 + 2] = RT[i * 3 + 2]; aTan[v * 4 + 3] = RW[i];
        aUv[v * 4] = a; aUv[v * 4 + 1] = sd; aUv[v * 4 + 2] = sArc; aUv[v * 4 + 3] = hcoord;
        aCol[v * 4] = cr[0]; aCol[v * 4 + 1] = cr[1]; aCol[v * 4 + 2] = cr[2]; aCol[v * 4 + 3] = I;
        aHot[v * 4] = hr[0]; aHot[v * 4 + 1] = hr[1]; aHot[v * 4 + 2] = hr[2]; aHot[v * 4 + 3] = rv;
        aSty[v] = st;
      }
    };
    const cw = RW[0];
    put(RX[0] + RT[0] * cw, RX[1] + RT[1] * cw, RX[2] + RT[2] * cw, 0, clamp(RA[0], 0, 1), RS[0] + cw, -1);
    const sH = RS[0];
    for (let i = 0; i < n; i++) put(RX[i * 3], RX[i * 3 + 1], RX[i * 3 + 2], i, clamp(RA[i], 0, 1), RS[i], (sH - RS[i]) / hwH);
    // индексы: квад между соседними точками
    for (let i = 0; i < n; i++) {
      const a0 = v0 + i * 2, o = idxN;
      idx[o] = a0; idx[o + 1] = a0 + 1; idx[o + 2] = a0 + 2; idx[o + 3] = a0 + 2; idx[o + 4] = a0 + 1; idx[o + 5] = a0 + 3;
      idxN += 6;
    }
    return true;
  }

  function update(dt, clock) {
    if (disposed) return;
    const h = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    tNow += h;
    uClock = isNum(clock) ? clock : tNow;
    uniforms.uTime.value = uClock % 1000;
    activeN = 0; vertN = 0; idxN = 0;
    try {
      // два прохода: сначала дым (премультиплированная альфа), затем аддитивные ленты — дым не гасит огонь
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < SLOTS; i++) {
          const s = slots[i];
          if (!s.active || (s.style === 2) !== (pass === 0)) continue;
          if (buildSlot(s)) activeN++;
        }
      }
    } catch (e) { /* эффекты не роняют кадр */ }
    mesh.visible = idxN > 0;
    geo.setDrawRange(0, idxN);
    if (idxN > 0) {
      // свой объект диапазона вместо addUpdateRange({…}) — без аллокации в кадре
      for (let a = 0; a < attrs.length; a++) {
        const at = attrs[a], R = ranges[a];
        R.start = 0; R.count = vertN * at.itemSize;
        at.clearUpdateRanges(); at.updateRanges.push(R); at.needsUpdate = true;
      }
      idxRange.start = 0; idxRange.count = idxN;
      idxAttr.clearUpdateRanges(); idxAttr.updateRanges.push(idxRange); idxAttr.needsUpdate = true;
    }
  }

  function setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    Q = q;
    uniforms.uHQ.value = q.hq;
  }
  function clear() {
    for (let i = 0; i < SLOTS; i++) if (slots[i].active) freeSlot(slots[i]);
    activeN = 0; vertN = 0; idxN = 0; geo.setDrawRange(0, 0); mesh.visible = false;
  }
  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose(); mat.dispose();
  }
  function stats() { return { active: activeN, drawCalls: mesh.visible ? 1 : 0, verts: vertN, cap: Q.cap }; }

  return { create, update, setQuality, clear, dispose, stats, mesh };
}
