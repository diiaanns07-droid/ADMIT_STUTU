// ASHEN OATH — modules/fx/shieldHex.js. Владелец: №7 [VFX].
// Гексагональный энергетический щит V6 (в духе блока BDO).
//  - kind 'front' — сферический сегмент ~110° перед героем (ось — yaw), 'dome' — полусфера-бастион вокруг;
//  - сетка шестигранников в «карте» сферы (азимутальная равнопромежуточная проекция вокруг оси: θ·dir),
//    яркие рёбра + узлы, слабая заливка ячеек, френель по кромке, бегущая по рёбрам энергия
//    (шумовые сгустки + кольцевые импульсы от центра), «стекло» — лёгкое осветление/затемнение ячеек;
//  - open 0..1: масштаб/прозрачность + ячейки «выщёлкиваются» от центра наружу со вспышкой;
//  - hit(): кольцо ряби по сетке от точки удара + ТРЕЩИНЫ (ломаные радиальные разломы и рваное кольцо),
//    держатся ~0.4 с, к ~0.9 с «зарастают» от кончиков. До 4 ударов одновременно (uniform vec4 uHits[4]:
//    xy — точка удара в карте (рад), z — сила, w — возраст с).
//  - [W4-УДАР] «звон»: после удара рёбра всей сетки дрожат затухающей частотой (щит звенит, как стекло);
//    setState({ damage }) — накопленный урон 0..1: часть ячеек «надтреснута» (ломаная трещина поперёк ячейки,
//    раскалённые рёбра мерцают) и не зарастает, пока щит под нагрузкой; shatter({ point, strength }) — пролом:
//    ячейки вспыхивают и осыпаются от точки пролома наружу (~0,3 с), а шестигранные пластины-осколки
//    разлетаются, вращаясь, и гаснут (общий пул SHARD_MAX, физика — в вершинном шейдере, 1 draw call
//    на все осколки; на low пластин нет — осколки рисует combatFx частицами).
// Каждый щит — свой Mesh (1 draw call на видимый щит), материалы делят одну программу. Пул 4 щита.
// Координаты — в пространстве root (в игре root без трансформации = мир), метры, Y вверх.
import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const POOL = 4;
const HITS = 4;
const HIT_LIFE = 1.0;
const D2R = Math.PI / 180;
const KIND = Object.freeze({
  front: Object.freeze({ cap: 55 * D2R, cell: 0.2, back: 1.0, rim: 1.0 }),
  dome: Object.freeze({ cap: 90 * D2R, cell: 0.32, back: 0.45, rim: 0.7 }),
});
const QL = Object.freeze({
  low: Object.freeze({ sa: 32, sp: 10, sq: 0, shards: 0 }),
  medium: Object.freeze({ sa: 48, sp: 16, sq: 1, shards: 16 }),
  high: Object.freeze({ sa: 64, sp: 22, sq: 2, shards: 28 }),
});
const SHARD_MAX = 48;      // [W4-УДАР] пул пластин-осколков (на все щиты)
const BREAK_DUR = 0.32;    // [W4-УДАР] сек: ячейки осыпаются от точки пролома

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const easeOutBack = (t) => { const c = 1.9, x = clamp01(t) - 1; return 1 + (c + 1) * x * x * x + c * x * x; };

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
uniform float uCap;
varying vec3 vL;
varying vec3 vW;
varying vec3 vN;
void main() {
  float ph = position.x * 6.2831853, th = position.y * uCap;
  vec3 l = vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));
  vL = l;
  vec4 w = modelMatrix * vec4(l, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * l);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FS = /* glsl */`
#define TAU 6.2831853
uniform vec3 uCol;
uniform vec3 uHot;
uniform float uI;
uniform float uOpen;
uniform float uFade;
uniform float uTime;
uniform float uCap;
uniform float uCell;
uniform float uRival;
uniform float uSeed;
uniform float uBack;
uniform float uRim;
uniform vec4 uHits[${HITS}];
uniform float uDmg;     // [W4-УДАР] накопленный урон 0..1
uniform vec4 uBreak;    // [W4-УДАР] xy — точка пролома в карте (рад), z — прогресс 0..1, w — 1: пролом идёт
varying vec3 vL;
varying vec3 vW;
varying vec3 vN;
${FX_RIVAL}
${FX_NOISE}
float PX;
float ln(float d, float w) { float ww = max(w, PX * 0.5); return clamp((ww - d) / PX + 0.5, 0.0, 1.0) * (w / ww); }
const vec2 HS = vec2(1.0, 1.7320508);
// xy — смещение от центра ячейки, zw — центр ячейки (единицы сетки: расстояние между центрами = 1)
vec4 hexCell(vec2 p) {
  vec2 a = floor(p / HS + 0.5) * HS;
  vec2 b = (floor((p - HS * 0.5) / HS + 0.5) + 0.5) * HS;
  vec2 da = p - a, db = p - b;
  return dot(da, da) < dot(db, db) ? vec4(da, a) : vec4(db, b);
}
float hexD(vec2 p) { p = abs(p); return max(p.x, dot(p, vec2(0.5, 0.8660254))); }

#if SQ > 0
// трещины вокруг удара: q — от точки удара (рад), ломаные радиальные разломы + рваное кольцо
float crackAt(vec2 q, float age, float s, float sd, out float glow) {
  glow = 0.0;
  float r = length(q);
  float L = 0.2 + 0.28 * s;
  if (r > L + 0.04) return 0.0;
  float grow = clamp(age / 0.07, 0.0, 1.0);
  float heal = smoothstep(0.4, 0.9, age);
  float N = SQ > 1 ? 7.0 : 5.0;
  float sa = (atan(q.y, q.x) / TAU + 0.5) * N + sd;
  float k = mod(floor(sa), N), f = fract(sa);
  float hk = k * 13.7 + sd * 31.0;
  float x = r * 34.0, xi = floor(x);
  float zz = mix(fxH1(xi + hk), fxH1(xi + 1.0 + hk), fract(x)) - 0.5;   // кусочно-линейный зигзаг
  float cen = 0.5 + (fxH1(hk + 3.1) - 0.5) * 0.36 + zz * 0.34 * clamp(r * 12.0, 0.0, 1.0);
  float d = abs(f - cen) * (TAU / N) * r;
  float Lk = L * (0.5 + 0.5 * fxH1(hk + 7.3)) * grow * (1.0 - heal);
  float tip = 1.0 - smoothstep(Lk * 0.55, Lk + 1e-4, r);
  float w = mix(0.0075, 0.002, clamp(r / max(Lk, 1e-3), 0.0, 1.0));
  float c = ln(d, w) * tip;
  glow = (w * w * 9.0) / (d * d + w * w * 9.0) * tip;
#if SQ > 1
  float rc = L * 0.45;
  float gap = step(0.42, fxH1(hk + floor(f * 3.0) * 1.7 + 0.5));
  float rr = ln(abs(r - rc + zz * 0.014), 0.0024) * gap * grow * (1.0 - smoothstep(0.25, 0.7, age));
  c = max(c, rr);
  glow = max(glow, rr * 0.5);
#endif
  return c;
}
#endif

void main() {
  vec3 l = normalize(vL);
  float th = acos(clamp(l.z, -1.0, 1.0));
  float rxy = length(l.xy);
  vec2 m = rxy > 1e-6 ? l.xy * (th / rxy) : vec2(0.0);     // карта сферы (рад)
  PX = max(length(fwidth(m)), 1e-5);
  vec2 g = m / uCell;
  vec4 hc = hexCell(g);
  vec2 cc = hc.zw * uCell;
  float e = 0.5 - hexD(hc.xy);                              // до ребра, ед. сетки
  float pg = max(length(fwidth(g)), 1e-4);
  float h1 = fxH2(hc.zw + uSeed);
  float t = uTime;
  // появление ячеек от центра наружу
  float pt = length(cc) / uCap * 0.8 + h1 * 0.2;
  float cv = clamp((uOpen * 1.22 - pt) / 0.14, 0.0, 1.0);
  float pop = cv * (1.0 - cv) * 4.0;
  float capD = uCap - th;
  float capK = smoothstep(0.0, 0.05, capD);
  // рёбра, узлы, энергия
  float lw = 0.05, ww = max(lw, pg * 0.6);
  float edge = clamp((ww - e) / pg + 0.5, 0.0, 1.0) * (lw / ww);
  float eg = exp(-e * 11.0);
  float corner = smoothstep(0.52, 0.577, length(hc.xy)) * edge;
  float pulse = pow(0.5 + 0.5 * sin(length(g) * 0.85 - t * 3.3), 10.0);
#if SQ > 0
  float fl = smoothstep(0.6, 0.86, fxNoise2(g * 0.3 + vec2(t * 0.55, -t * 0.4) + uSeed));
#else
  float fl = 0.0;
#endif
#if SQ > 1
  float glass = fxNoise2(hc.zw * 0.42 + vec2(t * 0.22, t * 0.13) + uSeed);
#else
  float glass = 0.5;
#endif
  float fill = (0.015 + 0.03 * h1) * (0.45 + glass);
  // френель
  vec3 V = normalize(cameraPosition - vW);
  float ndv = dot(normalize(vN), V);
  float fres = pow(1.0 - abs(ndv), 3.0);
  // удары
  float rip = 0.0, cellHit = 0.0, flash = 0.0, cr = 0.0, cg = 0.0, ring = 0.0;
  for (int i = 0; i < ${HITS}; i++) {
    vec4 H = uHits[i];
    if (H.w > ${HIT_LIFE.toFixed(2)}) continue;
    vec2 dq = m - H.xy;
    float dist = length(dq);
    float rr = H.w * 1.9;
    float fo = 1.0 - smoothstep(0.25, 0.85, H.w);
    rip += exp(-pow((dist - rr) / 0.045, 2.0)) * fo * H.z;
    cellHit += (1.0 - smoothstep(0.25, 1.1, abs(length(cc - H.xy) - rr) / uCell)) * fo * H.z;
    flash += exp(-dist / 0.07) * exp(-H.w * 6.0) * H.z;
    // [W4-УДАР] звон: вся сетка дрожит затухающей частотой (дальше от удара — с запаздыванием)
    ring += exp(-H.w * 4.5) * (0.5 + 0.5 * cos(H.w * 62.0 - dist * 9.0)) * H.z;
#if SQ > 0
    float gl;
    cr += crackAt(dq, H.w, H.z, float(i) * 0.37 + H.x * 3.7 + H.y * 1.3, gl);
    cg += gl;
#endif
  }
  vec3 col = uCol, hot = uHot;
  float E = edge * (0.3 + 0.9 * fl + 0.6 * pulse) + corner * 0.6; // [VFX] тоньше и прозрачнее: щит не закрывает героя
  E *= 1.0 + min(ring, 1.5) * 0.9;                                  // [W4-УДАР] звон
  vec3 Lc = col * (fill + eg * 0.16) + mix(col, hot, 0.4) * E + hot * pop * (0.2 + edge * 1.4);
  Lc += hot * (cellHit * (0.12 + edge * 1.5) + rip * (0.3 + edge * 1.1));
#if SQ > 0
  // [W4-УДАР] накопленный урон: надтреснутые ячейки — ломаная трещина поперёк ячейки и мерцающие рёбра
  if (uDmg > 0.01) {
    float hk = fxH2(hc.zw * 1.37 + uSeed + 4.1);
    float st = 1.0 - smoothstep(uDmg * 0.8 - 0.05, uDmg * 0.8, hk);
    if (st > 0.0) {
      float a = hk * 40.0;
      vec2 ca = vec2(cos(a), sin(a));
      float zz = (fxH1(floor(dot(hc.xy, vec2(-ca.y, ca.x)) * 9.0) + hk * 17.0) - 0.5) * 0.05;
      float cl = ln(abs(dot(hc.xy, ca) + zz) * uCell, 0.004) * (1.0 - smoothstep(0.35, 0.5, length(hc.xy)));
      float fk = 0.65 + 0.35 * sin(t * (9.0 + 7.0 * hk) + hk * 30.0);
      Lc += hot * st * (cl * 1.8 + edge * 0.9 * fk) + col * st * 0.05;
    }
  }
#endif
  // [W4-УДАР] пролом: ячейки вспыхивают и осыпаются от точки пролома наружу
  float gone = 0.0;
  if (uBreak.w > 0.5) {
    float bt = length(cc - uBreak.xy) / max(uCap, 0.1) * 0.75 + h1 * 0.25;
    float bk = uBreak.z * 1.25;
    gone = step(bt, bk);
    float pre = smoothstep(bt - 0.18, bt, bk) * (1.0 - gone);
    Lc += hot * pre * (0.4 + edge * 2.2);
  }
  Lc *= cv * capK * (1.0 - gone);
  float rimL = ln(abs(capD - 0.014), 0.005) + ln(abs(capD - 0.042), 0.0022) * 0.6;
  Lc += (col * fres * 0.55 * cv + hot * rimL * 1.5 * uRim + col * exp(-max(capD, 0.0) / 0.06) * 0.25 * uRim) * uOpen
    * (1.0 - step(0.5, uBreak.w) * smoothstep(0.3, 0.9, uBreak.z));   // [W4-УДАР] пролом гасит и кромку
  Lc += hot * (cr * 2.6 + flash * 1.3) + mix(col, hot, 0.5) * cg * 0.55;
  Lc *= uI * uFade * (ndv < 0.0 ? uBack : 1.0);
  float dA = SQ > 1 ? (1.0 - glass) * 0.06 * cv * uFade * (1.0 - gone) : 0.0;
  gl_FragColor = vec4(fxRival(Lc, uRival), dA);
${FX_OUT}
}
`;

// ---------------------------------------------------------------- [W4-УДАР] пластины-осколки пролома
// Экземпляр — шестиугольник (центр + 6 вершин). iA: старт xyz, t0 | iB: скорость xyz, жизнь | iC: ось вращения xyz,
// угловая скорость | iD: нормаль пластины xyz, размер | iE: цвет (лин.) rgb, земля | iF: hot (лин.) rgb, rival.
const SHARD_VS = /* glsl */`
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
attribute vec4 iF;
uniform float uTime;
varying vec2 vQ;
varying vec4 vK;     // x — жизнь 0..1, y — rival, z — френель-грань, w — мерцание
varying vec3 vCol;
varying vec3 vHot;
vec3 rotA(vec3 v, vec3 ax, float a) { float c = cos(a), s = sin(a); return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c); }
void main() {
  float age = uTime - iA.w;
  float k = age / max(iB.w, 1e-3);
  if (age < 0.0 || k >= 1.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vK = vec4(1.0); vQ = vec2(0.0); vCol = vec3(0.0); vHot = vec3(0.0); return; }
  vec3 n = normalize(iD.xyz);
  vec3 t = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  vec2 q = position.xy;
  float sz = iD.w * (1.0 - 0.35 * k * k);
  vec3 ax = normalize(iC.xyz);
  float ang = iC.w * age;
  vec3 off = rotA((t * q.x + b * q.y) * sz, ax, ang);
  vec3 nn = rotA(n, ax, ang);
  float drag = 1.6;
  vec3 p = iA.xyz + iB.xyz * ((1.0 - exp(-drag * age)) / drag);
  p.y -= 0.5 * 7.5 * age * age;
  p.y = max(p.y, iE.w + 0.02);
  vec3 w = p + off;
  vQ = q;
  vec3 V = normalize(cameraPosition - p);
  vK = vec4(k, iF.w, 1.0 - abs(dot(nn, V)), 0.7 + 0.3 * sin(age * 31.0 + iA.x * 13.0 + iA.z * 7.0));
  vCol = iE.rgb; vHot = iF.rgb;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;
const SHARD_FS = /* glsl */`
uniform float uI;
varying vec2 vQ;
varying vec4 vK;
varying vec3 vCol;
varying vec3 vHot;
${FX_RIVAL}
void main() {
  if (vK.x >= 1.0) discard;
  vec2 a = abs(vQ);
  float hx = max(a.x * 0.8660254 + a.y * 0.5, a.y);           // шестиугольник (вершины на ±y)
  float edge = smoothstep(0.62, 0.96, hx);
  float fade = pow(1.0 - vK.x, 1.4) * smoothstep(0.0, 0.05, vK.x + 0.02);
  vec3 L = vHot * (edge * 1.9 + vK.z * 0.9) * vK.w + vCol * 0.28 + vHot * exp(-vK.x * 9.0) * 1.2;
  L *= uI * fade;
  gl_FragColor = vec4(fxRival(L, vK.y), (0.05 + edge * 0.05) * fade);
${FX_OUT}
}
`;

function gridData(sa, sp) {
  const pos = new Float32Array((sa + 1) * (sp + 1) * 3);
  let k = 0;
  for (let j = 0; j <= sp; j++) for (let i = 0; i <= sa; i++) { pos[k++] = i / sa; pos[k++] = j / sp; pos[k++] = 0; }
  const idx = [];
  for (let j = 0; j < sp; j++) {
    for (let i = 0; i < sa; i++) {
      const a = j * (sa + 1) + i, b = a + 1, c = a + sa + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  return { pos, idx };
}

export function createHexShield(deps) {
  const d = deps || {};
  const THREE = d.THREE;
  if (!THREE) throw new Error('createHexShield: нужен deps.THREE');
  const root = d.root || null;

  let quality = 'high', Q = QL.high, orderSeq = 0, time = 0;
  const geos = {};
  function geoFor(q) {
    if (!geos[q]) {
      const g = gridData(QL[q].sa, QL[q].sp);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setIndex(g.idx);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.2);
      geos[q] = geo;
    }
    return geos[q];
  }

  const slots = [];
  function makeSlot(i) {
    const hits = [];
    for (let k = 0; k < HITS; k++) hits.push(new THREE.Vector4(0, 0, 0, 99));
    const uniforms = {
      uCol: { value: new THREE.Vector3(1, 1, 1) }, uHot: { value: new THREE.Vector3(1, 1, 1) },
      uI: { value: 1.4 }, uOpen: { value: 0 }, uFade: { value: 0 }, uTime: { value: 0 },
      uCap: { value: KIND.front.cap }, uCell: { value: KIND.front.cell }, uRival: { value: 0 },
      uSeed: { value: i * 3.17 + 0.5 }, uBack: { value: 1 }, uRim: { value: 1 },
      uHits: { value: hits },
      uDmg: { value: 0 }, uBreak: { value: new THREE.Vector4(0, 0, 0, 0) },   // [W4-УДАР]
    };
    const mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: VS, fragmentShader: FS, defines: { SQ: Q.sq },
      side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE),
    });
    mat.depthWrite = false;
    const mesh = new THREE.Mesh(geoFor(quality), mat);
    mesh.name = 'fx-hexshield-' + i; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false; mesh.renderOrder = 4; mesh.visible = false;
    if (root && typeof root.add === 'function') root.add(mesh);
    const s = {
      i, alive: false, gen: 0, order: 0, kind: 'front', K: KIND.front, mesh, mat, uniforms, hits, hitNext: 0,
      px: 0, py: 0, pz: 0, radius: 1, open: 0, yaw: 0, intensity: 1.4, rival: 0, cell: KIND.front.cell,
      xx: 1, xy: 0, xz: 0, yx: 0, yy: 1, yz: 0, zx: 0, zy: 0, zz: 1,
      col: [1, 1, 1], hot: [1, 1, 1],
      dmg: 0, brk: -1, bx: 0, by: 0,   // [W4-УДАР] накопленный урон, прогресс пролома (<0 — нет), точка пролома в карте
    };
    return s;
  }
  for (let i = 0; i < POOL; i++) slots.push(makeSlot(i));

  // локальный базис: z — ось щита; x, y — карта сетки
  function basis(s) {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    if (s.kind === 'dome') {
      s.zx = 0; s.zy = 1; s.zz = 0;
      s.xx = c; s.xy = 0; s.xz = -sn;
      s.yx = -sn; s.yy = 0; s.yz = -c;
    } else {
      s.zx = -sn; s.zy = 0; s.zz = -c;         // yaw = 0 → лицом к -Z (как rotation.y героя)
      s.xx = -c; s.xy = 0; s.xz = sn;
      s.yx = 0; s.yy = 1; s.yz = 0;
    }
  }

  function applyState(s, o) {
    if (!o || typeof o !== 'object') return;
    if (hasVec(o.pos)) { s.px = o.pos.x; s.py = o.pos.y; s.pz = o.pos.z; }
    if (isNum(o.radius) && o.radius > 0) s.radius = clamp(o.radius, 0.05, 40);
    if (isNum(o.open)) s.open = clamp01(o.open);
    if (isNum(o.intensity)) s.intensity = clamp(o.intensity, 0, 30);
    if (isNum(o.rival)) s.rival = clamp01(o.rival);
    if (isNum(o.color)) hexLin(o.color & 0xffffff, s.col);
    if (isNum(o.hot)) hexLin(o.hot & 0xffffff, s.hot);
    if (isNum(o.yaw) && o.yaw !== s.yaw) { s.yaw = o.yaw % (Math.PI * 2); basis(s); }
    if (isNum(o.damage)) s.dmg = clamp01(o.damage);   // [W4-УДАР]
  }

  // точка мира → карта сферы щита (рад): _m[0], _m[1]
  const _m = [0, 0];
  function toMap(s, pt) {
    const dx = pt.x - s.px, dy = pt.y - s.py, dz = pt.z - s.pz;
    const lx = dx * s.xx + dy * s.xy + dz * s.xz, ly = dx * s.yx + dy * s.yy + dz * s.yz, lz = dx * s.zx + dy * s.zy + dz * s.zz;
    const l = len3(lx, ly, lz);
    _m[0] = 0; _m[1] = 0;
    if (l > 1e-6) {
      const th = Math.min(Math.acos(clamp(lz / l, -1, 1)), s.K.cap * 0.93);
      const rxy = Math.sqrt(lx * lx + ly * ly);
      if (rxy > 1e-6) { _m[0] = (lx / rxy) * th; _m[1] = (ly / rxy) * th; }
    }
    return _m;
  }
  function addHit(s, o) {
    if (!o || typeof o !== 'object' || !hasVec(o.point)) return;
    toMap(s, o.point);
    const mx = _m[0], my = _m[1];
    // слот: свободный или самый старый
    let k = -1, oldest = -1, oa = -1;
    for (let j = 0; j < HITS; j++) {
      const a = s.hits[j].w;
      if (a > HIT_LIFE) { k = j; break; }
      if (a > oa) { oa = a; oldest = j; }
    }
    if (k < 0) k = oldest >= 0 ? oldest : 0;
    s.hits[k].set(mx, my, clamp(num(o.strength, 1), 0.05, 1), 0);
  }

  function release(s) {
    s.alive = false; s.gen++; s.mesh.visible = false;
    for (let j = 0; j < HITS; j++) s.hits[j].w = 99;
    s.dmg = 0; s.brk = -1;
  }

  // ---------------------------------------------------------------- [W4-УДАР] осколки пролома
  const shardGeo = new THREE.InstancedBufferGeometry();
  {
    const hp = [0, 0, 0];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 2 + k * Math.PI / 3; hp.push(Math.cos(a), Math.sin(a), 0); }
    const hi = [];
    for (let k = 0; k < 6; k++) hi.push(0, 1 + k, 1 + ((k + 1) % 6));
    shardGeo.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
    shardGeo.setIndex(hi);
  }
  const SH_ATTR = {};
  for (const k of ['iA', 'iB', 'iC', 'iD', 'iE', 'iF']) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(SHARD_MAX * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage); shardGeo.setAttribute(k, a); SH_ATTR[k] = a;
  }
  shardGeo.instanceCount = 0;
  shardGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  const shardMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uI: { value: 1.6 } },
    vertexShader: SHARD_VS, fragmentShader: SHARD_FS,
    side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE),
  });
  shardMat.depthWrite = false;
  const shardMesh = new THREE.Mesh(shardGeo, shardMat);
  shardMesh.name = 'fx-hexshield-shards'; shardMesh.frustumCulled = false; shardMesh.castShadow = false; shardMesh.receiveShadow = false;
  shardMesh.matrixAutoUpdate = false; shardMesh.renderOrder = 5; shardMesh.visible = false;
  if (root && typeof root.add === 'function') root.add(shardMesh);
  const shardDeath = new Float32Array(SHARD_MAX);
  let shardCursor = 0, shardHigh = 0, shardLo = Infinity, shardHi = -1, shardTotal = 0;
  function shardPut(i, px, py, pz, vx, vy, vz, life, ax, ay, az, w, nx, ny, nz, size, gy, s) {
    const o = i * 4;
    let a = SH_ATTR.iA.array; a[o] = px; a[o + 1] = py; a[o + 2] = pz; a[o + 3] = time;
    a = SH_ATTR.iB.array; a[o] = vx; a[o + 1] = vy; a[o + 2] = vz; a[o + 3] = life;
    a = SH_ATTR.iC.array; a[o] = ax; a[o + 1] = ay; a[o + 2] = az; a[o + 3] = w;
    a = SH_ATTR.iD.array; a[o] = nx; a[o + 1] = ny; a[o + 2] = nz; a[o + 3] = size;
    a = SH_ATTR.iE.array; a[o] = s.col[0]; a[o + 1] = s.col[1]; a[o + 2] = s.col[2]; a[o + 3] = gy;
    a = SH_ATTR.iF.array; a[o] = s.hot[0]; a[o + 1] = s.hot[1]; a[o + 2] = s.hot[2]; a[o + 3] = s.rival;
    shardDeath[i] = time + life;
    if (i + 1 > shardHigh) { shardHigh = i + 1; shardGeo.instanceCount = shardHigh; }
    if (i < shardLo) shardLo = i;
    if (i > shardHi) shardHi = i;
    shardTotal++;
  }
  // пролом: n пластин из ячеек вокруг точки (карта mx, my), разлёт наружу по нормали и от точки, вращение
  function spawnShards(s, mx, my, strength, n, gy) {
    const S = s.radius * (0.8 + 0.2 * easeOutBack(s.open));
    const cell = s.cell / Math.max(s.radius, 0.05);
    for (let j = 0; j < n; j++) {
      const ra = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * (0.12 + 0.55 * strength) * s.K.cap;
      let ux = mx + Math.cos(ra) * rr, uy = my + Math.sin(ra) * rr;
      const th0 = Math.sqrt(ux * ux + uy * uy);
      if (th0 > s.K.cap * 0.95) { ux *= s.K.cap * 0.95 / th0; uy *= s.K.cap * 0.95 / th0; }
      const th = Math.sqrt(ux * ux + uy * uy), st = th > 1e-6 ? Math.sin(th) / th : 1;
      const lx = ux * st, ly = uy * st, lz = Math.cos(th);
      // локаль → мир (оси xx.., yx.., zx..)
      const nx = s.xx * lx + s.yx * ly + s.zx * lz, ny = s.xy * lx + s.yy * ly + s.zy * lz, nz = s.xz * lx + s.yz * ly + s.zz * lz;
      const px = s.px + nx * S, py = s.py + ny * S, pz = s.pz + nz * S;
      // от точки пролома по сфере (касательная) + наружу + вверх
      const dx = ux - mx, dy = uy - my, dl = Math.sqrt(dx * dx + dy * dy) || 1;
      const tx = (s.xx * dx + s.yx * dy) / dl, ty = (s.xy * dx + s.yy * dy) / dl, tz = (s.xz * dx + s.yz * dy) / dl;
      const sp = 1.6 + Math.random() * (2.2 + 3.2 * strength), tg = 0.8 + Math.random() * 2.2 * strength;
      const vx = nx * sp + tx * tg, vy = ny * sp + ty * tg + 0.8 + Math.random() * 1.6, vz = nz * sp + tz * tg;
      let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
      const al = len3(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
      const size = S * cell * (0.32 + Math.random() * 0.3);
      shardPut(shardCursor, px, py, pz, vx, vy, vz, 0.75 + Math.random() * 0.6, ax, ay, az, (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 11), nx, ny, nz, size, gy, s);
      shardCursor = (shardCursor + 1) % SHARD_MAX;
    }
  }
  function shatter(s, o) {
    const strength = clamp(num(o && o.strength, 1), 0.1, 1);
    if (o && hasVec(o.point)) toMap(s, o.point); else { _m[0] = 0; _m[1] = 0; }
    s.bx = _m[0]; s.by = _m[1]; s.brk = 0;
    s.uniforms.uBreak.value.set(s.bx, s.by, 0, 1);
    const n = Math.round(Q.shards * (0.45 + 0.55 * strength));
    if (n > 0) spawnShards(s, s.bx, s.by, strength, n, num(o && o.ground, s.py - 1.4));
  }

  function take() {
    let free = null, oldest = null;
    for (let i = 0; i < POOL; i++) {
      const s = slots[i];
      if (!s.alive) { if (!free) free = s; continue; }
      if (!oldest || s.order < oldest.order) oldest = s;
    }
    if (free) return free;
    if (oldest) release(oldest);   // пул полон — отбираем самый старый
    return oldest;
  }

  function create(opts) {
    try {
      const o = opts || {};
      const s = take();
      if (!s) return null;
      s.kind = o.kind === 'dome' ? 'dome' : 'front';
      s.K = KIND[s.kind];
      s.alive = true; s.order = ++orderSeq; s.gen++;
      s.px = 0; s.py = 0; s.pz = 0; s.radius = s.kind === 'dome' ? 1.6 : 1; s.open = 0; s.yaw = 0; s.intensity = 1.4;
      s.cell = clamp(num(o.cell, s.K.cell), 0.03, 0.6);
      s.rival = clamp01(num(o.rival, 0));
      s.dmg = 0; s.brk = -1; s.uniforms.uBreak.value.set(0, 0, 0, 0);   // [W4-УДАР]
      hexLin((isNum(o.color) ? o.color : ELEMENTS.gold.mid) & 0xffffff, s.col);
      hexLin((isNum(o.hot) ? o.hot : ELEMENTS.gold.core) & 0xffffff, s.hot);
      for (let j = 0; j < HITS; j++) s.hits[j].set(0, 0, 0, 99);
      basis(s);
      applyState(s, o);
      const gen = s.gen;
      const live = () => s.alive && s.gen === gen;
      const h = {
        get alive() { return live(); },
        get kind() { return s.kind; },
        setState(st) { try { if (live()) applyState(s, st); } catch (e) { /* no-op */ } return h; },
        hit(hopts) { try { if (live()) addHit(s, hopts); } catch (e) { /* no-op */ } return h; },
        // [W4-УДАР] пролом: { point, strength 0..1, ground } — ячейки осыпаются, пластины разлетаются
        shatter(hopts) { try { if (live() && s.brk < 0) shatter(s, hopts); } catch (e) { /* no-op */ } return h; },
        get broken() { return live() && s.brk >= 0; },
        dispose() { if (live()) release(s); },
      };
      return h;
    } catch (e) { return null; }
  }

  function update(dt, clock) {
    try {
      const h = isNum(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
      time = isNum(clock) ? clock : time + h;
      for (let i = 0; i < POOL; i++) {
        const s = slots[i];
        if (!s.alive) continue;
        for (let j = 0; j < HITS; j++) { const v = s.hits[j]; if (v.w <= HIT_LIFE) v.w += h; }
        const u = s.uniforms;
        // [W4-УДАР] пролом идёт BREAK_DUR, потом ячеек нет — щит невидим, пока его не закроют
        if (s.brk >= 0) { s.brk = Math.min(1, s.brk + h / BREAK_DUR); u.uBreak.value.z = s.brk; if (s.brk >= 1) { s.mesh.visible = false; continue; } }
        u.uDmg.value = s.dmg;
        if (s.open <= 0.001) { s.mesh.visible = false; continue; }
        const S = s.radius * (0.8 + 0.2 * easeOutBack(s.open));
        s.mesh.matrix.set(
          s.xx * S, s.yx * S, s.zx * S, s.px,
          s.xy * S, s.yy * S, s.zy * S, s.py,
          s.xz * S, s.yz * S, s.zz * S, s.pz,
          0, 0, 0, 1);
        s.mesh.matrixWorldNeedsUpdate = true;
        s.mesh.visible = true;
        u.uCol.value.set(s.col[0], s.col[1], s.col[2]);
        u.uHot.value.set(s.hot[0], s.hot[1], s.hot[2]);
        u.uI.value = s.intensity; u.uOpen.value = s.open; u.uFade.value = clamp01(s.open / 0.35);
        u.uTime.value = time % 1000; u.uCap.value = s.K.cap; u.uCell.value = s.cell / s.radius;
        u.uRival.value = s.rival; u.uBack.value = s.K.back; u.uRim.value = s.K.rim;
      }
      // [W4-УДАР] осколки: выгрузка только записанных ячеек, меш виден, пока жив хоть один
      shardMat.uniforms.uTime.value = time;
      if (shardHi >= 0) {
        for (const k in SH_ATTR) {
          const at = SH_ATTR[k];
          if (at.clearUpdateRanges) { at.clearUpdateRanges(); at.addUpdateRange(shardLo * 4, (shardHi - shardLo + 1) * 4); }
          at.needsUpdate = true;
        }
        shardLo = Infinity; shardHi = -1;
      }
      let anyShard = false;
      for (let i = 0; i < shardHigh; i++) if (shardDeath[i] > time) { anyShard = true; break; }
      shardMesh.visible = anyShard;
    } catch (e) { /* эффекты не роняют кадр */ }
  }

  function setQuality(name) {
    const q = Object.prototype.hasOwnProperty.call(QL, name) ? name : 'high';
    if (q === quality) return;
    quality = q; Q = QL[q];
    const g = geoFor(q);
    for (let i = 0; i < POOL; i++) { const s = slots[i]; s.mesh.geometry = g; s.mat.defines.SQ = Q.sq; s.mat.needsUpdate = true; }
  }

  function clear() {
    for (let i = 0; i < POOL; i++) if (slots[i].alive) release(slots[i]);
    shardDeath.fill(0); shardMesh.visible = false;   // [W4-УДАР]
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    for (let i = 0; i < POOL; i++) { const s = slots[i]; if (s.mesh.parent) s.mesh.parent.remove(s.mesh); s.mat.dispose(); }
    for (const k in geos) geos[k].dispose();
    if (shardMesh.parent) shardMesh.parent.remove(shardMesh);   // [W4-УДАР]
    shardGeo.dispose(); shardMat.dispose();
  }

  function stats() {
    let a = 0, v = 0, sh = 0;
    for (let i = 0; i < POOL; i++) { if (slots[i].alive) a++; if (slots[i].mesh.visible) v++; }
    for (let i = 0; i < shardHigh; i++) if (shardDeath[i] > time) sh++;
    return { active: a, drawCalls: v + (shardMesh.visible ? 1 : 0), quality, shards: sh, shardsSpawned: shardTotal };
  }

  return { create, update, setQuality, clear, dispose, stats };
}
