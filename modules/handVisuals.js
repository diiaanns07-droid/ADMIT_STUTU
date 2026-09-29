// ASHEN OATH — [HAND] modules/handVisuals.js: 3D-заглушки способностей [HAND] (Сумеречный Лук и «магия рукой»)
// в сцене Three.js. Простые, но «дорогие» на вид; позже их заменит агент VFX (см. setDelegated). Владелец: №6 [HAND].
//
// API:
//   createHandVisuals({ THREE, scene, config }) -> {
//     update(dt, snap, events, anchors), setQuality('low'|'medium'|'high'), reset(), dispose(),
//     setDelegated({ arrows, orbs, bow, palm?, rain? }), info(), root }
//   THREE передаётся снаружи (модуль three не импортирует). config.settings — живой объект { quality, reducedMotion }:
//     reducedMotion читается каждый кадр, quality — когда меняется (setQuality() тоже работает).
//   snap — снимок боя или null: status, player{ position(ступни), yaw (вперёд = (sin yaw, 0, cos yaw)),
//     bow{ active, phase 'idle'|'ready'|'nocked'|'drawing', draw 0..1, aimX, aimY, charged, element },
//     handSpell{ phase 'idle'|'form'|'hold'|'throw', element, power, size, twoHand } }, projectiles[] —
//     рисуются ТОЛЬКО kind 'arrow' и 'hand_orb' (остальное — modules/effects.js).
//   events — события кадра { id, type, position, data }: arrow_hit, hand_spell_hit, arrow_rain {center, radius, delay},
//     bow_release, hand_spell_form, hand_spell_cancel, hand_spell_throw. Повтор id игнорируется.
//   anchors — { heroHandL, heroHandR, heroChest, heroHead, heroFeet } (world.getAnchors()) или null: тогда кисти
//     выводятся из position + yaw (вправо r = (-cos yaw, 0, sin yaw): при взгляде на +Z левая рука героя — +X).
//   setDelegated: true — эту часть взял агент VFX, своё прячем. arrows — стрелы в полёте, их шлейфы и вспышки
//     arrow_hit; orbs — сгустки в полёте и вспышки hand_spell_hit; bow — лук, тетива, наложенная стрела, вспышка
//     выстрела; palm (по умолчанию = orbs) — сгусток в ладони; rain (по умолчанию = arrows) — метка «Дождя стрел».
//
// Что рисуется:
//   лук — рекурсивный (TubeGeometry по CatmullRom, сужение к кончикам, ~1,25 м), тёмное дерево, кожа, латунь;
//     светящаяся рунная жила (аддитивная, HDR > 1 для bloom), тетива из 5 точек, гнётся с натяжением, дрожит после
//     выстрела; наложенная стрела с горящим наконечником цвета стихии (charged — пульсирует ярче);
//   сгусток в ладони — горячее ядро + френель-оболочка с узором стихии (огонь течёт вверх, молния — прожилки,
//     лёд — грани, земля — лава в трещинах камня) + ореол; огонь — искры и языки, молния — разряды и искры,
//     лёд — вращающиеся осколки и морозный пар, земля — камешки на орбите и пыль; рождение за 0,25 с;
//   стрелы в полёте (пул 24) — древко с оперением + наконечник (InstancedMesh) + свечение + шлейф-лента;
//   сгустки в полёте (пул 6) — ядро, оболочка, ореол, шлейф, twoHand — крупнее и с вращающимся кольцом;
//   вспышки попаданий (пул 10), выпуск стрелы, рождение/угасание сгустка; метка «Дождя стрел» (пул 3) —
//     рунный круг на земле, сжимающееся кольцо и световая стена, пульсирует delay секунд, затем гаснет.
//
// Производительность: все билборды (ореолы, искры, вспышки, свечения) — ОДИН draw call (instanced-квады с
//   атласом 4 кадров); все ленты (шлейфы, разряды, свечение тетивы) — ОДИН draw call; стрелы — 2 InstancedMesh;
//   осколки и камешки — по InstancedMesh. Без источников света (новый свет = перекомпиляция всех шейдеров сцены),
//   без теней. Пулы фиксированного размера, временные векторы переиспользуются, в кадре нет аллокаций.
//   quality 'low' — без частиц и шлейфов; 'high' — больше частиц и длиннее шлейфы. reducedMotion — без пульсаций,
//   мерцаний и дрожи тетивы.

export const HAND_VISUALS_VERSION = 'HAND-vis-1';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const approach = (v, t, step) => (v < t ? Math.min(t, v + step) : Math.max(t, v - step));
const easeOut = (t) => { const u = 1 - clamp01(t); return 1 - u * u * u; };
const easeOutBack = (t) => { t = clamp01(t); const u = t - 1; return 1 + 2.4 * u * u * u + 1.4 * u * u; };
const rnd = (a, b) => a + Math.random() * (b - a);
const EMPTY = Object.freeze({});

const ARROW_CAP = 24, ORB_CAP = 6, FLASH_CAP = 10, RAIN_CAP = 3;
const TP = 12;                 // точек истории шлейфа на снаряд (верхняя граница)
const BB_CAP = 720;            // билбордов за кадр
const RIB_CAP = 4200;          // вершин лент за кадр
const P_CAP = 400;             // частиц
const ARC_CAP = 18, ARC_PTS = 7;
const SHARD_CAP = 32;
const PL_MAX = 16;             // точек в одной ломаной ленты

const QUALITY = {
  low:    { particles: 0,   emit: 0,   trails: false, trailLen: 0,   arcs: 2, palmShards: 5, orbShards: 0, sparks: 0 },
  medium: { particles: 220, emit: 1,   trails: true,  trailLen: 1,   arcs: 3, palmShards: 6, orbShards: 3, sparks: 1 },
  high:   { particles: 400, emit: 1.7, trails: true,  trailLen: 1.3, arcs: 5, palmShards: 7, orbShards: 4, sparks: 1.6 },
};

// Стихии: 0 без стихии (золото), 1 огонь, 2 молния (голубой + фиолет), 3 лёд, 4 земля.
const EL_HEX = [0xf3e2b0, 0xff7a2a, 0x8fd0ff, 0x9fe8ff, 0xd49a4a];
const EL_CORE_HEX = [0xfff6da, 0xffd27a, 0xeef8ff, 0xe8fbff, 0xffcf7a];
const EL_ACC_HEX = [0xffc978, 0xff4a1a, 0xc9a0ff, 0xd8f6ff, 0xff9a3a];   // вторичный оттенок (фиолет молнии и т.п.)
const EL_DEEP_HEX = [0xb07a30, 0xa0200a, 0x5a34d8, 0x2f86c8, 0x7a3a12];  // куда гаснут частицы
function elIndex(e) {
  switch (e) {
    case 'fire': case 'flame': return 1;
    case 'storm': case 'lightning': case 'thunder': return 2;
    case 'frost': case 'ice': return 3;
    case 'earth': case 'stone': case 'rock': return 4;
    default: return 0;
  }
}

// Лук в локальных осях: +Z — направление выстрела, +Y — верхнее плечо, +X — левая сторона героя; лучник на −Z.
// Верхнее плечо (y, z) от кончика к рукояти; нижнее — зеркально.
const BOW_PTS = [[0.635, -0.1], [0.612, -0.142], [0.566, -0.162], [0.48, -0.138], [0.36, -0.082], [0.22, -0.022], [0.1, 0.012], [0, 0.016]];
const STR_TIP = [0.628, -0.112], STR_LIFT = [0.566, -0.17]; // тетива: кончик → точка схода с плеча
const NOCK_Y = 0.03, REST_X = 0.02;                        // стрела ложится слева от рукояти, чуть выше центра
const ARROW_LEN = 0.8;
const AIM_YAW = 28 * Math.PI / 180, AIM_PITCH = 22 * Math.PI / 180, BOW_CANT = 0.2;
const BOW_SHOW_YAW = -0.42;      // [HAND] лук чуть развёрнут к камере за спиной, чтобы читалась дуга плеч

// ---------------------------------------------------------------- шейдеры
// Билборды: aPos(xyz, размер), aCol(rgb, поворот), aVel(вектор вытягивания в мире, кадр атласа 0..3 + 4·k —
// подтянуть квад к камере на 0,1·k размера).
const BB_VS = /* glsl */`
attribute vec4 aPos; attribute vec4 aCol; attribute vec4 aVel;
varying vec2 vUv; varying vec3 vCol;
void main() {
  vCol = aCol.rgb;
  float fr = mod(aVel.w + 0.001, 4.0) - 0.001, pull = floor((aVel.w + 0.001) / 4.0) * 0.1;
  vUv = vec2((uv.x + floor(fr + 0.5)) * 0.25, uv.y);
  vec4 mv = modelViewMatrix * vec4(aPos.xyz, 1.0);
  vec2 p = position.xy; float sz = aPos.w;
  // вспышка у поверхности: квад подтянут к камере на pull·размер, чтобы не резался о стену/землю
  if (pull > 0.0) mv.xyz *= max(0.05, 1.0 - pull * sz / max(length(mv.xyz), 1e-3));
  vec3 sv = (modelViewMatrix * vec4(aVel.xyz, 0.0)).xyz;
  float sl = length(sv.xy);
  if (sl > 1e-4) {
    vec2 d = sv.xy / sl; vec2 n = vec2(-d.y, d.x);
    mv.xy += d * (p.x * (sz + sl) - sl * 0.5) + n * (p.y * sz);
  } else {
    float c = cos(aCol.w), s = sin(aCol.w);
    mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y) * sz;
  }
  gl_Position = projectionMatrix * mv;
}`;
const BB_FS = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv; varying vec3 vCol;
void main() {
  gl_FragColor = vec4(vCol, texture2D(uMap, vUv).a);
  #include <colorspace_fragment>
}`;
// Ленты: ломаная, развёрнутая к камере в вершинном шейдере (сторона ⟂ касательной и лучу взгляда).
const RIB_VS = /* glsl */`
attribute vec3 aTan; attribute float aSide; attribute vec3 aCol;
varying vec3 vCol; varying float vS;
void main() {
  vCol = aCol; vS = sign(aSide);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 tv = (modelViewMatrix * vec4(aTan, 0.0)).xyz;
  vec3 sd = cross(tv, normalize(mv.xyz));
  float l = length(sd);
  sd = l > 1e-6 ? sd / l : vec3(1.0, 0.0, 0.0);
  mv.xyz += sd * aSide;
  gl_Position = projectionMatrix * mv;
}`;
const RIB_FS = /* glsl */`
varying vec3 vCol; varying float vS;
void main() {
  float a = 1.0 - vS * vS;
  gl_FragColor = vec4(vCol * (0.3 * a + 0.9 * a * a * a * a), 1.0);
  #include <colorspace_fragment>
}`;
// Оболочка сгустка: френель + узор стихии (uStyle 0..4), аддитивно.
const SHELL_VS = /* glsl */`
varying vec3 vN; varying vec3 vV; varying vec3 vO;
void main() {
  vO = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const SHELL_FS = /* glsl */`
uniform vec3 uColor; uniform vec3 uAccent; uniform vec3 uCore;
uniform float uTime; uniform float uStyle; uniform float uAlpha; uniform float uRim; uniform float uDetail;
varying vec3 vN; varying vec3 vV; varying vec3 vO;
float hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float fr = 1.0 - ndv; float rim = fr * fr;
  vec3 p = normalize(vO); float t = uTime; float pat;
  if (uStyle < 0.5) {
    float n = noise(p * 3.0 + vec3(t * 0.3, t * 0.55, -t * 0.2));
    float r = 1.0 - abs(noise(p * 5.0 - vec3(0.0, t * 0.7, 0.0)) * 2.0 - 1.0);
    pat = smoothstep(0.66, 0.9, n) * 0.55 + smoothstep(0.93, 0.99, r) * 0.9 * uDetail;
  } else if (uStyle < 1.5) {
    vec3 q = p * vec3(2.6, 1.7, 2.6);
    float n = noise(q - vec3(0.0, t * 2.3, 0.0)) * 0.62 + noise(q * 2.2 - vec3(0.0, t * 3.6, 0.0)) * 0.38 * uDetail;
    pat = smoothstep(0.52, 0.86, n) * (0.4 + 0.65 * (p.y * 0.5 + 0.5));
  } else if (uStyle < 2.5) {
    float r1 = 1.0 - abs(noise(p * 3.4 + vec3(t * 1.9, -t * 1.2, t * 0.8)) * 2.0 - 1.0);
    float r2 = 1.0 - abs(noise(p * 7.0 - vec3(t * 2.6, t * 1.4, -t * 1.9)) * 2.0 - 1.0);
    pat = smoothstep(0.9, 0.985, r1) * 1.7 + smoothstep(0.93, 0.99, r2) * 0.9 * uDetail;
  } else if (uStyle < 3.5) {
    float n = noise(p * 4.2 + vec3(t * 0.12));
    float edge = 1.0 - abs(noise(p * 3.1 + 7.0 + vec3(t * 0.08)) * 2.0 - 1.0);
    pat = smoothstep(0.6, 0.64, n) * 0.28 + smoothstep(0.94, 0.985, edge) * 1.3 + smoothstep(0.96, 0.995, 1.0 - abs(noise(p * 6.5) * 2.0 - 1.0)) * 0.7 * uDetail;
  } else {
    float r = 1.0 - abs(noise(p * 3.3 + vec3(0.0, t * 0.12, 0.0)) * 2.0 - 1.0);
    float r2 = 1.0 - abs(noise(p * 7.5 + 3.1) * 2.0 - 1.0);
    pat = pow(r, 13.0) * 2.0 + pow(r2, 20.0) * 1.0 * uDetail;
  }
  // тело оболочки ниже порога bloom (≈0.15..0.9), светятся только прожилки узора и тонкий край
  vec3 col = uColor * (0.07 + rim * uRim * 0.5) + uColor * pat * 1.5 + uAccent * pat * 0.55 * (1.0 - rim) + uCore * ndv * ndv * ndv * 0.08;
  gl_FragColor = vec4(col * uAlpha, 1.0);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- фабрика
export function createHandVisuals({ THREE, scene, config } = {}) {
  if (!THREE || !scene) throw new Error('[handVisuals] need THREE and scene');
  const cfg = config || EMPTY;
  const owned = { geo: [], mat: [], tex: [] };
  const G = (g) => (owned.geo.push(g), g);
  const M = (m) => (owned.mat.push(m), m);

  const S = {
    q: 'medium', Q: QUALITY.medium, lastSettingsQ: null, rm: false, time: 0, errors: 0, lastWarn: -1e9, disposed: false,
    dlg: { arrows: false, orbs: false, bow: false, palm: null, rain: null },
  };
  const dlgPalm = () => (S.dlg.palm === null ? S.dlg.orbs : S.dlg.palm);
  const dlgRain = () => (S.dlg.rain === null ? S.dlg.arrows : S.dlg.rain);

  // цвета стихий в линейном пространстве
  const _col = new THREE.Color();
  const lin = (hex) => { _col.setHex(hex); return new Float32Array([_col.r, _col.g, _col.b]); };
  const EC = EL_HEX.map(lin), ECORE = EL_CORE_HEX.map(lin), EACC = EL_ACC_HEX.map(lin), EDEEP = EL_DEEP_HEX.map(lin);

  // временные объекты (без аллокаций в кадре)
  const V = [], Q4 = [];
  for (let i = 0; i < 10; i++) V.push(new THREE.Vector3());
  for (let i = 0; i < 4; i++) Q4.push(new THREE.Quaternion());
  const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _sc = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0), AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
  const qCant = new THREE.Quaternion().setFromAxisAngle(AX_Z, BOW_CANT);
  const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.15);

  const root = new THREE.Group();
  root.name = 'handVisuals';
  scene.add(root);

  // ---------------------------------------------------------------- текстуры
  function canvasOf(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  // Атлас 4×128: 0 мягкое свечение · 1 звезда-вспышка · 2 кольцо · 3 горячая точка
  function makeAtlas() {
    const cv = canvasOf(512, 128);
    let tex;
    if (cv) {
      const g = cv.getContext('2d');
      const radial = (cx, r, stops) => {
        const gr = g.createRadialGradient(cx, 64, 0, cx, 64, r);
        for (const [o, a] of stops) gr.addColorStop(o, `rgba(255,255,255,${a})`);
        g.fillStyle = gr; g.fillRect(cx - 64, 0, 128, 128);
      };
      radial(64, 62, [[0, 1], [0.1, 0.82], [0.25, 0.42], [0.45, 0.16], [0.7, 0.045], [1, 0]]);
      g.globalCompositeOperation = 'lighter';
      const ray = (ang, len, th, a) => {
        g.save(); g.translate(192, 64); g.rotate(ang); g.scale(1, th);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, len);
        gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.25, `rgba(255,255,255,${a * 0.35})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(0, 0, len, 0, TAU); g.fill(); g.restore();
      };
      ray(0, 62, 0.045, 1); ray(Math.PI / 2, 62, 0.045, 1); ray(Math.PI / 4, 40, 0.035, 0.45); ray(-Math.PI / 4, 40, 0.035, 0.45);
      g.save(); g.beginPath(); g.rect(128, 0, 128, 128); g.clip();
      const gc = g.createRadialGradient(192, 64, 0, 192, 64, 26);
      gc.addColorStop(0, 'rgba(255,255,255,1)'); gc.addColorStop(0.35, 'rgba(255,255,255,0.4)'); gc.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gc; g.fillRect(128, 0, 128, 128); g.restore();
      g.globalCompositeOperation = 'source-over';
      radial(320, 62, [[0, 0], [0.42, 0], [0.66, 0.18], [0.8, 0.62], [0.88, 0.3], [1, 0]]);
      radial(448, 62, [[0, 1], [0.14, 0.95], [0.28, 0.4], [0.5, 0.1], [0.75, 0.02], [1, 0]]);
      tex = new THREE.CanvasTexture(cv);
    } else {
      // без DOM (тесты в node): простой радиальный градиент во всех кадрах
      const w = 128, data = new Uint8Array(512 * 128 * 4);
      for (let y = 0; y < w; y++) for (let x = 0; x < 512; x++) {
        const dx = (x % w) - 63.5, dy = y - 63.5, d = Math.min(1, Math.hypot(dx, dy) / 62);
        const i = (y * 512 + x) * 4; data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = Math.round(255 * Math.pow(1 - d, 2.4));
      }
      tex = new THREE.DataTexture(data, 512, 128); tex.needsUpdate = true;
    }
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    owned.tex.push(tex);
    return tex;
  }
  // Рунный круг «Дождя стрел»: двойное кольцо, пояс рун, стрелки к центру, мягкая заливка к краю.
  function makeSigil() {
    const cv = canvasOf(512, 512);
    let tex;
    if (cv) {
      const g = cv.getContext('2d');
      g.translate(256, 256);
      let seed = 1337;
      const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const fill = g.createRadialGradient(0, 0, 0, 0, 0, 250);
      fill.addColorStop(0, 'rgba(255,255,255,0)'); fill.addColorStop(0.55, 'rgba(255,255,255,0.03)');
      fill.addColorStop(0.9, 'rgba(255,255,255,0.2)'); fill.addColorStop(0.96, 'rgba(255,255,255,0.05)'); fill.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = fill; g.fillRect(-256, -256, 512, 512);
      g.strokeStyle = '#fff'; g.shadowColor = '#fff';
      const ring = (r, w, a, blur) => { g.globalAlpha = a; g.lineWidth = w; g.shadowBlur = blur; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); };
      ring(238, 6, 1, 14); ring(214, 2.2, 0.8, 6); ring(122, 1.6, 0.45, 4); ring(70, 1.2, 0.3, 0);
      g.shadowBlur = 5; g.lineCap = 'round';
      const N = 40;
      for (let i = 0; i < N; i++) {
        g.save(); g.rotate((i / N) * TAU); g.translate(0, -226); g.globalAlpha = 0.65 + rand() * 0.35; g.lineWidth = 1.8;
        g.beginPath();
        const k = (rand() * 5) | 0;
        g.moveTo(0, -7); g.lineTo(0, 7);
        if (k === 0) { g.moveTo(-4, -5); g.lineTo(4, 1); }
        else if (k === 1) { g.moveTo(0, -2); g.lineTo(4, -6); g.moveTo(0, 2); g.lineTo(-4, 6); }
        else if (k === 2) { g.moveTo(-4, 0); g.lineTo(4, 0); }
        else if (k === 3) { g.moveTo(0, -7); g.lineTo(4, -3); g.lineTo(0, 1); }
        else { g.moveTo(-4, -7); g.lineTo(0, -3); g.lineTo(4, -7); }
        g.stroke(); g.restore();
      }
      for (let i = 0; i < 8; i++) {
        g.save(); g.rotate((i / 8) * TAU + Math.PI / 8); g.translate(0, -168); g.globalAlpha = 0.75; g.lineWidth = 3; g.shadowBlur = 8;
        g.beginPath(); g.moveTo(-11, -9); g.lineTo(0, 5); g.lineTo(11, -9); g.stroke();
        g.globalAlpha = 0.4; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, 12); g.lineTo(0, 40); g.stroke();
        g.restore();
      }
      g.globalAlpha = 0.5; g.lineWidth = 2; g.shadowBlur = 4;
      g.beginPath(); g.moveTo(0, -18); g.lineTo(12, 0); g.lineTo(0, 18); g.lineTo(-12, 0); g.closePath(); g.stroke();
      tex = new THREE.CanvasTexture(cv);
    } else {
      const w = 64, data = new Uint8Array(w * w * 4);
      for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - 31.5, y - 31.5) / 31, i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = d > 0.88 && d < 0.97 ? 255 : Math.round(60 * clamp01(d) * (d < 1 ? 1 : 0));
      }
      tex = new THREE.DataTexture(data, w, w); tex.needsUpdate = true;
    }
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    owned.tex.push(tex);
    return tex;
  }
  const atlas = makeAtlas();
  const sigilTex = makeSigil();

  // ---------------------------------------------------------------- материалы-«свет»
  const addBasic = (hex, extra) => M(new THREE.MeshBasicMaterial(Object.assign({
    color: hex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  }, extra || EMPTY)));

  // ---------------------------------------------------------------- билборды (один draw call)
  const bbQuad = G(new THREE.PlaneGeometry(1, 1));
  const bbGeo = G(new THREE.InstancedBufferGeometry());
  bbGeo.index = bbQuad.index;
  bbGeo.setAttribute('position', bbQuad.attributes.position);
  bbGeo.setAttribute('uv', bbQuad.attributes.uv);
  const bbArr = new Float32Array(BB_CAP * 12);
  const bbBuf = new THREE.InstancedInterleavedBuffer(bbArr, 12, 1);
  bbBuf.setUsage(THREE.DynamicDrawUsage);
  bbGeo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(bbBuf, 4, 0));
  bbGeo.setAttribute('aCol', new THREE.InterleavedBufferAttribute(bbBuf, 4, 4));
  bbGeo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(bbBuf, 4, 8));
  bbGeo.instanceCount = 0;
  const bbMat = M(new THREE.ShaderMaterial({
    uniforms: { uMap: { value: atlas } }, vertexShader: BB_VS, fragmentShader: BB_FS,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  }));
  const bbMesh = new THREE.Mesh(bbGeo, bbMat);
  bbMesh.frustumCulled = false; bbMesh.renderOrder = 20; bbMesh.visible = false;
  root.add(bbMesh);
  let bbN = 0;
  function bb(x, y, z, size, r, g, b, rot, sx, sy, sz, frame) {
    if (bbN >= BB_CAP || !(size > 0)) return;
    const o = bbN++ * 12;
    bbArr[o] = x; bbArr[o + 1] = y; bbArr[o + 2] = z; bbArr[o + 3] = size;
    bbArr[o + 4] = r; bbArr[o + 5] = g; bbArr[o + 6] = b; bbArr[o + 7] = rot;
    bbArr[o + 8] = sx; bbArr[o + 9] = sy; bbArr[o + 10] = sz; bbArr[o + 11] = frame;
  }
  const bbc = (x, y, z, size, c, k, frame, rot) => bb(x, y, z, size, c[0] * k, c[1] * k, c[2] * k, rot || 0, 0, 0, 0, frame);

  // ---------------------------------------------------------------- ленты (один draw call)
  const ribGeo = G(new THREE.BufferGeometry());
  const ribPos = new Float32Array(RIB_CAP * 3), ribTan = new Float32Array(RIB_CAP * 3), ribSide = new Float32Array(RIB_CAP), ribCol = new Float32Array(RIB_CAP * 3);
  const ribAttrs = [
    new THREE.BufferAttribute(ribPos, 3), new THREE.BufferAttribute(ribTan, 3), new THREE.BufferAttribute(ribSide, 1), new THREE.BufferAttribute(ribCol, 3),
  ];
  ['position', 'aTan', 'aSide', 'aCol'].forEach((n, i) => { ribAttrs[i].setUsage(THREE.DynamicDrawUsage); ribGeo.setAttribute(n, ribAttrs[i]); });
  ribGeo.setDrawRange(0, 0);
  const ribMat = M(new THREE.ShaderMaterial({
    vertexShader: RIB_VS, fragmentShader: RIB_FS, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  }));
  const ribMesh = new THREE.Mesh(ribGeo, ribMat);
  ribMesh.frustumCulled = false; ribMesh.renderOrder = 19; ribMesh.visible = false;
  root.add(ribMesh);
  let ribN = 0;
  function rv(x, y, z, tx, ty, tz, s, r, g, b) {
    const i = ribN++, o = i * 3;
    ribPos[o] = x; ribPos[o + 1] = y; ribPos[o + 2] = z; ribTan[o] = tx; ribTan[o + 1] = ty; ribTan[o + 2] = tz;
    ribSide[i] = s; ribCol[o] = r; ribCol[o + 1] = g; ribCol[o + 2] = b;
  }
  // ломаная: точки, полуширина, цвет → треугольники (касательная — по соседям, стыки без щелей)
  const plP = new Float32Array(PL_MAX * 3), plW = new Float32Array(PL_MAX), plC = new Float32Array(PL_MAX * 3), plT = new Float32Array(PL_MAX * 3), plL = new Float32Array(PL_MAX);
  let plN = 0;
  function plAdd(x, y, z) {
    if (plN >= PL_MAX) return false;
    const o = plN * 3;
    plP[o] = x; plP[o + 1] = y; plP[o + 2] = z;
    plL[plN] = plN ? plL[plN - 1] + Math.hypot(x - plP[o - 3], y - plP[o - 2], z - plP[o - 1]) : 0;
    plN++; return true;
  }
  function plStyle(i, w, c, k) { plW[i] = w; const o = i * 3; plC[o] = c[0] * k; plC[o + 1] = c[1] * k; plC[o + 2] = c[2] * k; }
  function plFlush() {
    const n = plN; plN = 0;
    if (n < 2 || ribN + (n - 1) * 6 > RIB_CAP) return;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3, o = i * 3;
      plT[o] = plP[b] - plP[a]; plT[o + 1] = plP[b + 1] - plP[a + 1]; plT[o + 2] = plP[b + 2] - plP[a + 2];
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 3, b = a + 3;
      const ax = plP[a], ay = plP[a + 1], az = plP[a + 2], bx = plP[b], by = plP[b + 1], bz = plP[b + 2];
      const tax = plT[a], tay = plT[a + 1], taz = plT[a + 2], tbx = plT[b], tby = plT[b + 1], tbz = plT[b + 2];
      const wa = plW[i], wb = plW[i + 1];
      const ra = plC[a], ga = plC[a + 1], ba = plC[a + 2], rb = plC[b], gb = plC[b + 1], bbv = plC[b + 2];
      rv(ax, ay, az, tax, tay, taz, -wa, ra, ga, ba); rv(ax, ay, az, tax, tay, taz, wa, ra, ga, ba); rv(bx, by, bz, tbx, tby, tbz, wb, rb, gb, bbv);
      rv(ax, ay, az, tax, tay, taz, -wa, ra, ga, ba); rv(bx, by, bz, tbx, tby, tbz, wb, rb, gb, bbv); rv(bx, by, bz, tbx, tby, tbz, -wb, rb, gb, bbv);
    }
  }

  // ---------------------------------------------------------------- частицы (в билбордах)
  const pPos = new Float32Array(P_CAP * 3), pVel = new Float32Array(P_CAP * 3), pC0 = new Float32Array(P_CAP * 3), pC1 = new Float32Array(P_CAP * 3);
  const pLife = new Float32Array(P_CAP), pMax = new Float32Array(P_CAP), pS0 = new Float32Array(P_CAP), pS1 = new Float32Array(P_CAP);
  const pGrav = new Float32Array(P_CAP), pDrag = new Float32Array(P_CAP), pStr = new Float32Array(P_CAP), pFlick = new Float32Array(P_CAP);
  const pFrame = new Uint8Array(P_CAP);
  let pN = 0;
  function emit(x, y, z, vx, vy, vz, life, s0, s1, c0, k0, c1, k1, grav, drag, str, frame, flick) {
    if (pN >= S.Q.particles || pN >= P_CAP) return;
    const i = pN++, o = i * 3;
    pPos[o] = x; pPos[o + 1] = y; pPos[o + 2] = z; pVel[o] = vx; pVel[o + 1] = vy; pVel[o + 2] = vz;
    pC0[o] = c0[0] * k0; pC0[o + 1] = c0[1] * k0; pC0[o + 2] = c0[2] * k0; pC1[o] = c1[0] * k1; pC1[o + 1] = c1[1] * k1; pC1[o + 2] = c1[2] * k1;
    pLife[i] = pMax[i] = Math.max(0.02, life); pS0[i] = s0; pS1[i] = s1; pGrav[i] = grav; pDrag[i] = drag; pStr[i] = str; pFrame[i] = frame; pFlick[i] = flick || 0;
  }
  function killParticle(i) {
    const j = --pN;
    if (i === j) return;
    const o = i * 3, p = j * 3;
    for (let k = 0; k < 3; k++) { pPos[o + k] = pPos[p + k]; pVel[o + k] = pVel[p + k]; pC0[o + k] = pC0[p + k]; pC1[o + k] = pC1[p + k]; }
    pLife[i] = pLife[j]; pMax[i] = pMax[j]; pS0[i] = pS0[j]; pS1[i] = pS1[j]; pGrav[i] = pGrav[j]; pDrag[i] = pDrag[j]; pStr[i] = pStr[j]; pFrame[i] = pFrame[j]; pFlick[i] = pFlick[j];
  }
  function updateParticles(dt) {
    const t = S.time, rm = S.rm;
    for (let i = 0; i < pN;) {
      pLife[i] -= dt;
      if (pLife[i] <= 0) { killParticle(i); continue; }
      const o = i * 3, dr = 1 / (1 + pDrag[i] * dt);
      pVel[o] *= dr; pVel[o + 1] = pVel[o + 1] * dr - pGrav[i] * dt; pVel[o + 2] *= dr;
      pPos[o] += pVel[o] * dt; pPos[o + 1] += pVel[o + 1] * dt; pPos[o + 2] += pVel[o + 2] * dt;
      const k = pLife[i] / pMax[i];
      let a = k > 0.82 ? (1 - k) / 0.18 : 1;
      if (k < 0.4) a *= k / 0.4;
      if (pFlick[i] > 0 && !rm) a *= 0.55 + 0.45 * Math.sin(t * pFlick[i] + i * 1.7);
      const s = pStr[i];
      bb(pPos[o], pPos[o + 1], pPos[o + 2], lerp(pS1[i], pS0[i], k),
        lerp(pC1[o], pC0[o], k) * a, lerp(pC1[o + 1], pC0[o + 1], k) * a, lerp(pC1[o + 2], pC0[o + 2], k) * a,
        i * 0.7, pVel[o] * s, pVel[o + 1] * s, pVel[o + 2] * s, pFrame[i]);
      i++;
    }
  }
  // случайное направление на сфере → V[9]
  function randDir(out) {
    const u = Math.random() * 2 - 1, a = Math.random() * TAU, r = Math.sqrt(1 - u * u);
    return out.set(r * Math.cos(a), u, r * Math.sin(a));
  }
  function burst(n, x, y, z, e, speed, upBias, life, size) {
    const d = V[9];
    for (let i = 0; i < n; i++) {
      randDir(d); d.y = d.y * 0.8 + upBias;
      const sp = speed * rnd(0.35, 1);
      emit(x, y, z, d.x * sp, d.y * sp, d.z * sp, life * rnd(0.6, 1.1), size * rnd(0.7, 1.2), size * 0.35,
        ECORE[e], 3, e === 2 && i & 1 ? EACC[e] : EC[e], 1.1, 5.5, 2.4, 0.045, 3, 0);
    }
  }
  // «дыхание» стихии вокруг точки (ладонь, сгусток в полёте, удар); m — множитель темпа, back — снос назад
  function emitElement(src, e, cx, cy, cz, R, rate, dt, bx, by, bz) {
    src.acc += rate * S.Q.emit * dt;
    let guard = 12;
    const d = V[9];
    while (src.acc >= 1 && guard-- > 0) {
      src.acc -= 1;
      randDir(d);
      const px = cx + d.x * R * 0.85, py = cy + d.y * R * 0.85, pz = cz + d.z * R * 0.85;
      if (e === 1) {
        if (Math.random() < 0.72) emit(px, py, pz, rnd(-0.14, 0.14) + bx, rnd(0.3, 0.8) + by, rnd(-0.14, 0.14) + bz, rnd(0.45, 0.95), rnd(0.018, 0.036), 0.008, ECORE[1], 2.6, EDEEP[1], 0.9, -0.35, 1.2, 0.06, 3, 16);
        else emit(cx + d.x * R * 0.4, cy + R * 0.3, cz + d.z * R * 0.4, bx * 0.5, rnd(0.5, 1.0) + by * 0.5, bz * 0.5, rnd(0.22, 0.38), R * 1.0, R * 0.25, EC[1], 0.32, EDEEP[1], 0.08, -0.6, 2.2, 0, 0, 0);
      } else if (e === 2) {
        const sp = rnd(1.0, 2.6);
        emit(px, py, pz, d.x * sp + bx, d.y * sp + by, d.z * sp + bz, rnd(0.08, 0.2), rnd(0.014, 0.024), 0.006, ECORE[2], 3.2, Math.random() < 0.45 ? EACC[2] : EC[2], 1.3, 2.5, 3.5, 0.05, 3, 0);
      } else if (e === 3) {
        if (Math.random() < 0.7) emit(cx + d.x * R * 1.1, cy + d.y * R * 0.9, cz + d.z * R * 1.1, d.x * 0.06 + bx * 0.4, rnd(-0.2, -0.05) + by * 0.4, d.z * 0.06 + bz * 0.4, rnd(0.8, 1.3), R * 0.55, R * 1.1, EC[3], 0.3, EDEEP[3], 0.0, 0.05, 1.5, 0, 0, 0);
        else emit(px, py, pz, bx * 0.3, by * 0.3, bz * 0.3, rnd(0.18, 0.34), rnd(0.035, 0.06), 0.01, ECORE[3], 2.4, EC[3], 0.8, 0, 3, 0, 1, 22);
      } else if (e === 4) {
        emit(cx + d.x * R * 1.4, cy + d.y * R * 0.6, cz + d.z * R * 1.4, d.x * 0.1 + bx * 0.5, rnd(-0.1, 0.12) + by * 0.5, d.z * 0.1 + bz * 0.5, rnd(0.6, 1.0), rnd(0.014, 0.026), 0.006, ECORE[4], 2.0, EDEEP[4], 0.5, 0.6, 1.2, 0.02, 3, 0);
      } else {
        emit(px, py, pz, d.x * 0.08 + bx, rnd(0.2, 0.45) + by, d.z * 0.08 + bz, rnd(0.6, 1.0), rnd(0.014, 0.024), 0.006, ECORE[0], 2.2, EC[0], 0.6, -0.1, 1.0, 0.02, 3, 12);
      }
    }
    if (src.acc > 4) src.acc = 4;
  }

  // ---------------------------------------------------------------- разряды молнии (в лентах)
  const arcs = [];
  for (let i = 0; i < ARC_CAP; i++) arcs.push({ on: false, life: 0, max: 0.1, src: -1, ax: 0, ay: 0, az: 0, pts: new Float32Array(ARC_PTS * 3), w: 0.01, k: 1, violet: false });
  function spawnArc(src, ax, ay, az, r0, r1, w, life, k) {
    let a = null;
    for (let i = 0; i < ARC_CAP; i++) if (!arcs[i].on) { a = arcs[i]; break; }
    if (!a) return;
    a.on = true; a.src = src; a.ax = ax; a.ay = ay; a.az = az; a.life = a.max = life; a.w = w; a.k = k; a.violet = Math.random() < 0.4;
    const d0 = randDir(V[8]), d1 = V[9];
    randDir(d1); d1.multiplyScalar(0.7).add(d0).normalize();
    const sx = d0.x * r0, sy = d0.y * r0, sz = d0.z * r0, ex = d1.x * r1, ey = d1.y * r1, ez = d1.z * r1;
    const len = Math.hypot(ex - sx, ey - sy, ez - sz), amp = len * 0.28;
    for (let i = 0; i < ARC_PTS; i++) {
      const t = i / (ARC_PTS - 1), j = i === 0 || i === ARC_PTS - 1 ? 0 : amp * Math.sin(Math.PI * t);
      a.pts[i * 3] = lerp(sx, ex, t) + rnd(-j, j); a.pts[i * 3 + 1] = lerp(sy, ey, t) + rnd(-j, j); a.pts[i * 3 + 2] = lerp(sz, ez, t) + rnd(-j, j);
    }
  }
  function countArcs(src) { let n = 0; for (let i = 0; i < ARC_CAP; i++) if (arcs[i].on && arcs[i].src === src) n++; return n; }
  function killArcs(src) { for (let i = 0; i < ARC_CAP; i++) if (arcs[i].src === src) arcs[i].on = false; }
  function arcAnchor(a, out) {
    if (a.src === 0) return palm.shown ? out.copy(palm.pos) : null;
    if (a.src >= 1) { const s = orbSlots[a.src - 1]; return s && s.on && !s.dying ? out.copy(s.pos) : null; }
    return out.set(a.ax, a.ay, a.az);
  }
  function updateArcs(dt) {
    const c = V[7];
    for (let i = 0; i < ARC_CAP; i++) {
      const a = arcs[i];
      if (!a.on) continue;
      a.life -= dt;
      if (a.life <= 0 || !arcAnchor(a, c)) { a.on = false; continue; }
      const fl = S.rm ? 1 : 0.7 + 0.6 * Math.random();
      const col = a.violet ? EACC[2] : EC[2];
      const k = a.k * fl * (0.5 + 0.5 * (a.life / a.max));
      for (let j = 0; j < ARC_PTS; j++) {
        const o = j * 3;
        plAdd(c.x + a.pts[o], c.y + a.pts[o + 1], c.z + a.pts[o + 2]);
        const t = j / (ARC_PTS - 1);
        plStyle(j, a.w * (1 - 0.6 * t), j === 0 ? ECORE[2] : col, k * (j === 0 ? 1.4 : 1));
      }
      plFlush();
    }
  }

  // ---------------------------------------------------------------- геометрия лука
  function mergeGeos(list) {
    let nv = 0, ni = 0;
    for (const it of list) { nv += it.g.attributes.position.count; ni += it.g.index ? it.g.index.count : it.g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const it of list) {
      const g = it.g, P = g.attributes.position, N = g.attributes.normal, n = P.count;
      _col.setHex(it.c);
      for (let i = 0; i < n; i++) {
        const o = (vo + i) * 3;
        pos[o] = P.getX(i); pos[o + 1] = P.getY(i); pos[o + 2] = P.getZ(i);
        nor[o] = N ? N.getX(i) : 0; nor[o + 1] = N ? N.getY(i) : 1; nor[o + 2] = N ? N.getZ(i) : 0;
        col[o] = _col.r; col[o + 1] = _col.g; col[o + 2] = _col.b;
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
      else for (let i = 0; i < n; i++) idx[io++] = i + vo;
      vo += n;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return G(out);
  }
  const bowRadius = (u) => lerp(0.0185, 0.0072, Math.pow(Math.abs(u - 0.5) * 2, 1.1));
  const LIMB_W = 1.6, LIMB_T = 0.72; // плечи плоские: шире по X, тоньше по Z
  function bowCurvePoints(side) {
    const pts = [];
    for (let i = 0; i < BOW_PTS.length; i++) pts.push(new THREE.Vector3(0, -BOW_PTS[i][0], BOW_PTS[i][1]));
    for (let i = BOW_PTS.length - 2; i >= 0; i--) pts.push(new THREE.Vector3(0, BOW_PTS[i][0], BOW_PTS[i][1]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    if (!side) return curve;
    // та же линия, вынесенная на лицевую (+Z, side 1) или тыльную (−Z, side −1) грань плеча
    const out = [], tan = new THREE.Vector3();
    for (let i = 0; i <= 60; i++) {
      const u = 0.1 + (i / 60) * 0.8;
      const p = curve.getPointAt(u); curve.getTangentAt(u, tan);
      const off = (bowRadius(u) * LIMB_T + 0.0016) * side;
      out.push(new THREE.Vector3(0, p.y - tan.z * off, p.z + tan.y * off));
    }
    return new THREE.CatmullRomCurve3(out, false, 'centripetal');
  }
  function makeBowBody() {
    const curve = bowCurvePoints(false);
    const TS = 72, RS = 8;
    const limb = new THREE.TubeGeometry(curve, TS, 1, RS, false);
    const P = limb.attributes.position, N = limb.attributes.normal, c = new THREE.Vector3();
    for (let i = 0; i <= TS; i++) {
      const u = i / TS, r = bowRadius(u);
      curve.getPointAt(u, c);
      for (let j = 0; j <= RS; j++) {
        const k = i * (RS + 1) + j;
        P.setXYZ(k, c.x + (P.getX(k) - c.x) * r * LIMB_W, c.y + (P.getY(k) - c.y) * r * LIMB_T, c.z + (P.getZ(k) - c.z) * r * LIMB_T);
        const nx = N.getX(k) / LIMB_W, ny = N.getY(k) / LIMB_T, nz = N.getZ(k) / LIMB_T, nl = Math.hypot(nx, ny, nz) || 1;
        N.setXYZ(k, nx / nl, ny / nl, nz / nl);
      }
    }
    const parts = [{ g: limb, c: 0x4a3222 }];
    const grip = new THREE.CylinderGeometry(0.024, 0.024, 0.17, 12, 1, false);
    grip.scale(1.4, 1, 1.12); grip.translate(0, 0, 0.004);
    parts.push({ g: grip, c: 0x21160f });
    for (const y of [-0.094, 0.094]) {
      const ring = new THREE.TorusGeometry(0.027, 0.0048, 6, 18);
      ring.rotateX(Math.PI / 2); ring.scale(1.4, 1, 1.12); ring.translate(0, y, 0.004);
      parts.push({ g: ring, c: 0xa0804c });
    }
    for (const sgn of [-1, 1]) {
      const cap = new THREE.SphereGeometry(0.0105, 8, 6);
      cap.translate(0, sgn * BOW_PTS[0][0], BOW_PTS[0][1]);
      parts.push({ g: cap, c: 0xa0804c });
      const horn = new THREE.ConeGeometry(0.0085, 0.07, 5);
      horn.translate(0, 0.035, 0);
      horn.rotateX(sgn > 0 ? 1.02 : Math.PI - 1.02);
      horn.translate(0, sgn * BOW_PTS[0][0], BOW_PTS[0][1]);
      parts.push({ g: horn, c: 0x2a2622 });
      const fitting = new THREE.CylinderGeometry(0.014, 0.012, 0.03, 8);
      fitting.translate(0, sgn * 0.2, 0);
      fitting.rotateX(sgn * 0.26);
      fitting.translate(0, 0, -0.012);
      parts.push({ g: fitting, c: 0x8a6c40 });
    }
    return mergeGeos(parts);
  }
  function makeArrowShaft() {
    const L = ARROW_LEN, parts = [];
    const shaft = new THREE.CylinderGeometry(0.0055, 0.0055, L - 0.1, 6, 1, true);
    shaft.translate(0, 0.02 + (L - 0.1) / 2, 0);
    parts.push({ g: shaft, c: 0x5a3e28 });
    const nock = new THREE.CylinderGeometry(0.0068, 0.0062, 0.026, 6);
    nock.translate(0, 0.013, 0);
    parts.push({ g: nock, c: 0xd8ccb0 });
    const band = new THREE.CylinderGeometry(0.0068, 0.0068, 0.022, 6);
    band.translate(0, L - 0.095, 0);
    parts.push({ g: band, c: 0xa0804c });
    for (let k = 0; k < 3; k++) {
      const v = new THREE.BufferGeometry(), r0 = 0.0055, y0 = 0.03;
      v.setAttribute('position', new THREE.BufferAttribute(new Float32Array([r0, y0, 0, r0 + 0.017, y0 + 0.012, 0, r0 + 0.016, y0 + 0.07, 0, r0, y0 + 0.13, 0]), 3));
      v.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
      v.setIndex([0, 1, 2, 0, 2, 3]);
      v.rotateY((k / 3) * TAU);
      parts.push({ g: v, c: k === 0 ? 0xb8452a : 0xd9c89a });
    }
    return mergeGeos(parts);
  }
  function makeArrowHead() {
    const h = new THREE.ConeGeometry(0.021, 0.09, 4, 1);
    h.scale(1, 1, 0.3); h.translate(0, ARROW_LEN - 0.085 + 0.045, 0);
    return G(h);
  }
  const bowGeo = makeBowBody();
  // рунная жила на лицевой грани и на «брюшке» (к лучнику — её видно из-за спины героя)
  const runeGeo = mergeGeos([{ g: new THREE.TubeGeometry(bowCurvePoints(1), 64, 0.0024, 4, false), c: 0xffffff }, { g: new THREE.TubeGeometry(bowCurvePoints(-1), 64, 0.003, 4, false), c: 0xffffff }]);
  const shaftGeo = makeArrowShaft();
  const headGeo = makeArrowHead();

  // ---------------------------------------------------------------- лук
  const bowMat = M(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.22, transparent: true, opacity: 1, side: THREE.DoubleSide }));
  const runeMat = addBasic(0xffffff);
  const bowGroup = new THREE.Group(); bowGroup.visible = false; root.add(bowGroup);
  const bowBody = new THREE.Mesh(bowGeo, bowMat); bowGroup.add(bowBody);
  const runeMesh = new THREE.Mesh(runeGeo, runeMat); runeMesh.renderOrder = 5; bowBody.add(runeMesh);
  const strGeo = G(new THREE.BufferGeometry());
  const strPos = new Float32Array(5 * 3);
  strGeo.setAttribute('position', new THREE.BufferAttribute(strPos, 3).setUsage(THREE.DynamicDrawUsage));
  const strMat = M(new THREE.LineBasicMaterial({ color: 0xd9ccaa, transparent: true, opacity: 0.9, toneMapped: false }));
  const strLine = new THREE.Line(strGeo, strMat); strLine.frustumCulled = false; strLine.visible = false; root.add(strLine);
  const nockShaftMat = M(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, emissive: 0x120a05, transparent: true, side: THREE.DoubleSide }));
  const nockHeadMat = M(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true }));
  const nockArrow = new THREE.Group(); nockArrow.visible = false; root.add(nockArrow);
  nockArrow.add(new THREE.Mesh(shaftGeo, nockShaftMat));
  const nockHead = new THREE.Mesh(headGeo, nockHeadMat); nockArrow.add(nockHead);
  const bow = {
    vis: 0, draw: 0, aim: new THREE.Vector3(0, 0, 1), aimInit: false, q: new THREE.Quaternion(), grip: new THREE.Vector3(), nock: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, 1), relT: 9, el: 0, charged: 0, plaus: 0, arrowVis: 0, src: { acc: 0 }, runeU: null,
  };
  { const rc = bowCurvePoints(-1); bow.runeU = [0.2, 0.33, 0.67, 0.8].map((u) => rc.getPointAt((u - 0.1) / 0.8)); }
  // [HAND] свечение вдоль плеч лука: билборды видны под любым углом (сзади лук виден ребром)
  const limbGlowU = (() => { const cv = bowCurvePoints(false), out = []; for (let i = 0; i < 12; i++) { const u = 0.06 + (i / 11) * 0.88; if (Math.abs(u - 0.5) > 0.06) out.push(cv.getPointAt(u)); } return out; })();
  const qShow = new THREE.Quaternion().setFromAxisAngle(AX_Y, BOW_SHOW_YAW);

  // ---------------------------------------------------------------- сгустки (ладонь + полёт)
  const coreGeo = G(new THREE.SphereGeometry(1, 20, 14));
  const shellGeo = G(new THREE.SphereGeometry(1, 30, 20));
  const ringGeo = G(new THREE.TorusGeometry(1, 0.03, 6, 56));
  const rockGeo = (() => {
    const g = new THREE.IcosahedronGeometry(1, 1), P = g.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const k = 1 + 0.16 * Math.sin(x * 5.1 + y * 2.3) * Math.cos(z * 4.7 - x * 1.3) + 0.08 * Math.sin(y * 9.0 + z * 3.0);
      P.setXYZ(i, x * k, y * k, z * k);
    }
    g.computeVertexNormals();
    return G(g);
  })();
  const rockMat = M(new THREE.MeshStandardMaterial({ color: 0x3e3024, roughness: 0.92, metalness: 0.05, emissive: 0x2a1406, emissiveIntensity: 1, flatShading: true }));
  function makeShellMat() {
    return M(new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 1, 1) }, uAccent: { value: new THREE.Vector3(1, 1, 1) }, uCore: { value: new THREE.Vector3(1, 1, 1) },
        uTime: { value: 0 }, uStyle: { value: 0 }, uAlpha: { value: 1 }, uRim: { value: 1.6 }, uDetail: { value: 1 },
      },
      vertexShader: SHELL_VS, fragmentShader: SHELL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
  }
  function makeOrbRig() {
    const group = new THREE.Group(); group.visible = false; root.add(group);
    const coreMat = M(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }));
    const core = new THREE.Mesh(coreGeo, coreMat); core.renderOrder = 4;
    const rock = new THREE.Mesh(rockGeo, rockMat); rock.renderOrder = 4; rock.visible = false;
    const shell = new THREE.Mesh(shellGeo, makeShellMat()); shell.renderOrder = 6;
    const ringMat = addBasic(0xffffff);
    const ring = new THREE.Mesh(ringGeo, ringMat); ring.renderOrder = 7; ring.visible = false;
    group.add(core, rock, shell, ring);
    return { group, core, coreMat, rock, shell, ring, ringMat };
  }
  // обновить вид сгустка: e — стихия, R — радиус (м), k — яркость 0..~1.5
  function styleRig(rig, e, R, k, t) {
    const u = rig.shell.material.uniforms, c = EC[e], a = EACC[e], cr = ECORE[e];
    const earth = e === 4;
    rig.core.visible = !earth; rig.rock.visible = earth;
    const coreK = e === 2 ? 0.34 : e === 3 ? 0.4 : 0.42;
    if (earth) { rig.rock.scale.setScalar(R * 0.8); rig.rock.rotation.set(t * 0.4, t * 0.65, 0); }
    else {
      rig.core.scale.setScalar(R * coreK);
      // ядро чуть выше порога bloom и подкрашено стихией (иначе бледные стихии уходят в белое пятно)
      const ck = (e === 1 ? 1.4 : e === 2 ? 1.45 : e === 3 ? 1.15 : 1.25) * k, mx = e === 1 ? 0.15 : 0.4;
      rig.coreMat.color.setRGB(lerp(cr[0], c[0], mx) * ck, lerp(cr[1], c[1], mx) * ck, lerp(cr[2], c[2], mx) * ck);
    }
    rig.shell.scale.setScalar(R * (earth ? 1.02 : 1));
    rig.shell.rotation.set(0, t * (e === 3 ? 0.25 : 0.6), 0);
    const hk = 0.95 * k;
    u.uColor.value.set(c[0] * hk, c[1] * hk, c[2] * hk);
    u.uAccent.value.set(a[0] * hk, a[1] * hk, a[2] * hk);
    u.uCore.value.set(cr[0] * k, cr[1] * k, cr[2] * k);
    u.uTime.value = S.rm ? t * 0.35 : t; u.uStyle.value = e; u.uAlpha.value = 1;
    u.uRim.value = earth ? 0.9 : e === 3 ? 1.3 : 1.7; u.uDetail.value = S.q === 'low' ? 0.5 : 1;
  }

  // осколки льда и камешки земли: InstancedMesh на ладонь и все сгустки в полёте
  const shardMat = M(new THREE.MeshStandardMaterial({ color: 0xd4f4ff, emissive: 0x3aa8dc, emissiveIntensity: 1.5, roughness: 0.12, metalness: 0.05, flatShading: true, transparent: true, opacity: 0.92 }));
  const pebbleMat = M(new THREE.MeshStandardMaterial({ color: 0x5e4a36, emissive: 0x3a1a06, emissiveIntensity: 1, roughness: 0.85, metalness: 0.05, flatShading: true }));
  const shardGeo = G(new THREE.OctahedronGeometry(1, 0));
  const pebbleGeo = G(new THREE.DodecahedronGeometry(1, 0));
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, SHARD_CAP);
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, SHARD_CAP);
  for (const im of [shards, pebbles]) { im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = 0; im.frustumCulled = false; im.visible = false; root.add(im); }
  let shardN = 0, pebbleN = 0;
  // n спутников вокруг (cx, cy, cz) на радиусе R·(1.55..2), своя фаза seed
  function satellites(e, cx, cy, cz, R, n, t, seed, scaleK) {
    const earth = e === 4, im = earth ? pebbles : shards;
    const p = V[6], q = Q4[3];
    const spd = S.rm ? 0.25 : earth ? 0.9 : 0.55;
    for (let i = 0; i < n; i++) {
      if (earth ? pebbleN >= SHARD_CAP : shardN >= SHARD_CAP) return;
      const ph = seed * 7.3 + (i / n) * TAU, a = t * spd * (1 + 0.15 * (i % 3)) + ph;
      const rr = R * (1.55 + 0.45 * ((i * 0.618 + seed) % 1));
      const tilt = 0.45 * Math.sin(ph * 1.7);
      p.set(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * tilt + (S.rm ? 0 : 0.25 * R * Math.sin(t * 1.3 + ph)), cz + Math.sin(a) * rr);
      _e.set(t * 0.8 + ph, t * 1.2 + ph * 2, ph);
      q.setFromEuler(_e);
      const s = (earth ? rnd01(i, seed) * 0.014 + 0.022 : 0.03) * scaleK;
      if (earth) _sc.set(s, s * 0.85, s * 1.1); else _sc.set(s * 0.45, s * 1.5, s * 0.45);
      _m.compose(p, q, _sc);
      im.setMatrixAt(earth ? pebbleN++ : shardN++, _m);
    }
  }
  const rnd01 = (i, seed) => { const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };

  const palm = { on: false, shown: false, vis: 0, birth: 0, el: 0, fz: 0, pos: new THREE.Vector3(), R: 0, rig: makeOrbRig(), acc: 0, seed: Math.random(), power: 0, size: 0, two: 0 };

  // ---------------------------------------------------------------- стрелы в полёте (instanced)
  const flyShaftMat = M(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, emissive: 0x160c06, side: THREE.DoubleSide }));
  const flyHeadMat = M(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const flyShafts = new THREE.InstancedMesh(shaftGeo, flyShaftMat, ARROW_CAP);
  const flyHeads = new THREE.InstancedMesh(headGeo, flyHeadMat, ARROW_CAP);
  flyHeads.setColorAt(0, _col.setRGB(1, 1, 1));
  for (const im of [flyShafts, flyHeads]) { im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = 0; im.frustumCulled = false; im.visible = false; root.add(im); }
  if (flyHeads.instanceColor) flyHeads.instanceColor.setUsage(THREE.DynamicDrawUsage);
  const mkSlot = () => ({ on: false, id: null, seen: false, dying: 0, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), el: 0, charged: false, two: false, r: 0.2,
    tr: new Float32Array(TP * 3), trHead: 0, trN: 0, acc: 0, seed: 0, age: 0 });
  const arrowSlots = [], orbSlots = [];
  for (let i = 0; i < ARROW_CAP; i++) arrowSlots.push(mkSlot());
  for (let i = 0; i < ORB_CAP; i++) { const s = mkSlot(); s.rig = makeOrbRig(); orbSlots.push(s); }

  // ---------------------------------------------------------------- вспышки и метки дождя
  const FL_HIT = 0, FL_BIG = 1, FL_REL = 2, FL_BIRTH = 3, FL_FIZZ = 4, FL_THROW = 5;
  const PULL = 20; // + к кадру атласа: квад вспышки подтянут к камере на 0,5 размера
  const flashes = [];
  for (let i = 0; i < FLASH_CAP; i++) flashes.push({ on: false, t: 0, dur: 0.3, x: 0, y: 0, z: 0, e: 0, size: 1, kind: 0, rot: 0, dx: 0, dy: 0, dz: 0 });
  function flash(kind, x, y, z, e, size, dur, dx, dy, dz) {
    let f = null, oldest = -1;
    for (let i = 0; i < FLASH_CAP; i++) {
      const c = flashes[i];
      if (!c.on) { f = c; break; }
      const k = c.t / c.dur;
      if (k > oldest) { oldest = k; f = c; }
    }
    f.on = true; f.t = 0; f.dur = dur; f.x = x; f.y = y; f.z = z; f.e = e; f.size = size; f.kind = kind; f.rot = Math.random() * TAU;
    f.dx = dx || 0; f.dy = dy || 0; f.dz = dz || 0;
  }
  function updateFlashes(dt) {
    for (let i = 0; i < FLASH_CAP; i++) {
      const f = flashes[i];
      if (!f.on) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.on = false; continue; }
      const c = EC[f.e], cr = ECORE[f.e], s = f.size, eo = easeOut(k), inv = 1 - k;
      if (f.kind === FL_HIT || f.kind === FL_BIG) {
        bbc(f.x, f.y, f.z, s * (0.7 + 0.9 * eo), c, 0.9 * Math.pow(inv, 1.6), PULL);
        bbc(f.x, f.y, f.z, s * 0.4 * (1 - 0.5 * k), cr, 2.2 * inv * inv, PULL);
        bbc(f.x, f.y, f.z, s * 1.3 * (1 - 0.3 * k), cr, 0.7 * inv * inv * inv, PULL + 1, f.rot);
        if (f.kind === FL_BIG) {
          bbc(f.x, f.y, f.z, s * (0.4 + 1.5 * eo), c, 0.55 * Math.pow(inv, 1.3), PULL + 2, f.rot);
          bbc(f.x, f.y, f.z, s * (1.2 + 0.8 * eo), c, 0.35 * inv, PULL);
        }
      } else if (f.kind === FL_REL) {
        bbc(f.x, f.y, f.z, s * (0.5 + 0.5 * eo), c, 0.8 * inv * inv, 0);
        const L = 0.9 * eo;
        bb(f.x + f.dx * L * 0.6, f.y + f.dy * L * 0.6, f.z + f.dz * L * 0.6, s * 0.3, cr[0] * 1.2 * inv, cr[1] * 1.2 * inv, cr[2] * 1.2 * inv, 0, f.dx * L, f.dy * L, f.dz * L, 0);
      } else if (f.kind === FL_BIRTH) {
        bbc(f.x, f.y, f.z, s * (2.4 - 1.8 * eo), c, 0.7 * Math.sin(Math.PI * k), 2, f.rot);
        bbc(f.x, f.y, f.z, s * (0.6 + 0.6 * eo), cr, 0.9 * inv * inv, 0);
        bbc(f.x, f.y, f.z, s * 1.2, cr, 0.6 * inv * inv * inv, 1, f.rot);
      } else if (f.kind === FL_FIZZ) {
        const fl = S.rm ? 1 : 0.6 + 0.4 * Math.sin(f.t * 60);
        bbc(f.x, f.y, f.z, s * (0.8 + 0.8 * eo), c, 0.45 * inv * fl, 0);
      } else {
        bbc(f.x, f.y, f.z, s * (0.7 + 0.8 * eo), c, 0.7 * inv * inv, 0);
        bbc(f.x, f.y, f.z, s * 1.1 * (1 - 0.4 * k), cr, 0.6 * inv * inv * inv, 1, f.rot);
      }
    }
  }

  const discGeo = G(new THREE.PlaneGeometry(2, 2)); discGeo.rotateX(-Math.PI / 2);
  const closeGeo = G(new THREE.RingGeometry(0.965, 1, 96)); closeGeo.rotateX(-Math.PI / 2);
  const wallGeo = (() => {
    const g = new THREE.CylinderGeometry(1, 1, 1, 64, 1, true); g.translate(0, 0.5, 0);
    const P = g.attributes.position, col = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { const k = Math.pow(1 - clamp01(P.getY(i)), 2.4); col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return G(g);
  })();
  const rains = [];
  for (let i = 0; i < RAIN_CAP; i++) {
    const group = new THREE.Group(); group.visible = false; root.add(group);
    const discMat = addBasic(0xffffff, { map: sigilTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const closeMat = addBasic(0xffffff, { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide });
    const wallMat = addBasic(0xffffff, { vertexColors: true, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(discGeo, discMat), close = new THREE.Mesh(closeGeo, closeMat), wall = new THREE.Mesh(wallGeo, wallMat);
    disc.renderOrder = 2; close.renderOrder = 3; wall.renderOrder = 8;
    group.add(disc, close, wall);
    rains.push({ on: false, t: 0, delay: 1, R: 3, e: 0, group, disc, close, wall, discMat, closeMat, wallMat, acc: 0, x: 0, y: 0, z: 0, hit: false });
  }
  const RAIN_FADE = 0.6;
  function spawnRain(c, R, delay, e) {
    let r = rains[0];
    for (let i = 0; i < RAIN_CAP; i++) { if (!rains[i].on) { r = rains[i]; break; } if (rains[i].t - rains[i].delay > r.t - r.delay) r = rains[i]; }
    r.on = true; r.t = 0; r.delay = clamp(num(delay, 1), 0.1, 8); r.R = clamp(num(R, 3), 0.5, 20); r.e = e; r.acc = 0; r.hit = false;
    r.x = c.x; r.y = c.y + 0.03; r.z = c.z;
    r.group.position.set(r.x, r.y, r.z); r.group.visible = true;
    r.disc.scale.setScalar(r.R); r.wall.scale.set(r.R, Math.min(4.5, 1.6 + r.R * 0.5), r.R);
  }
  function updateRains(dt) {
    for (let i = 0; i < RAIN_CAP; i++) {
      const r = rains[i];
      if (!r.on) continue;
      r.t += dt;
      const c = EC[r.e], cr = ECORE[r.e];
      let k, ringS, wallK;
      if (r.t < r.delay) {
        const u = r.t / r.delay, fin = clamp01(r.t / 0.18);
        const pulse = S.rm ? 1 : 0.78 + 0.22 * Math.sin(r.t * (7 + 9 * u));
        k = fin * (0.8 + 0.5 * u) * pulse;
        ringS = r.R * (1.4 - 0.4 * easeOut(u));
        wallK = fin * (0.05 + 0.05 * u) * pulse;
      } else {
        if (!r.hit) { r.hit = true; flash(FL_HIT, r.x, r.y + 0.4, r.z, r.e, r.R * 0.6, 0.45); }
        const u = (r.t - r.delay) / RAIN_FADE;
        if (u >= 1) { r.on = false; r.group.visible = false; continue; }
        const f = 1 - u;
        k = (1.2 * Math.max(0, 1 - u * 4) + 1.0) * f * f;
        ringS = r.R * (1 + 0.25 * easeOut(u));
        wallK = 0.12 * f * f;
      }
      r.discMat.color.setRGB(c[0] * 1.15 * k, c[1] * 1.15 * k, c[2] * 1.15 * k);
      r.closeMat.color.setRGB(cr[0] * 1.5 * k, cr[1] * 1.5 * k, cr[2] * 1.5 * k);
      r.wallMat.color.setRGB(c[0] * wallK, c[1] * wallK, c[2] * wallK);
      r.close.scale.setScalar(ringS);
      if (!S.rm) r.disc.rotation.y += dt * 0.25;
      if (r.t < r.delay) {
        // искры поднимаются вдоль световой стены
        r.acc += 26 * r.R * 0.35 * S.Q.emit * dt;
        let g = 8;
        while (r.acc >= 1 && g-- > 0) {
          r.acc -= 1;
          const a = Math.random() * TAU, rr = r.R * rnd(0.92, 1.0);
          emit(r.x + Math.cos(a) * rr, r.y + 0.05, r.z + Math.sin(a) * rr, 0, rnd(0.8, 1.8), 0, rnd(0.6, 1.1), rnd(0.03, 0.05), 0.01, cr, 2.2, c, 0.5, -0.2, 0.6, 0.05, 3, 0);
        }
      }
    }
  }

  // ---------------------------------------------------------------- события
  const seenIds = new Array(96).fill(undefined);
  let seenAt = 0;
  function seenBefore(id) {
    if (id === undefined || id === null) return false;
    for (let i = 0; i < seenIds.length; i++) if (seenIds[i] === id) return true;
    seenIds[seenAt] = id; seenAt = (seenAt + 1) % seenIds.length;
    return false;
  }
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object' || seenBefore(ev.id)) return;
    const d = ev.data && typeof ev.data === 'object' ? ev.data : EMPTY, p = hasVec(ev.position) ? ev.position : null;
    const sp = S.Q.sparks;
    // события соперника (data.remote, NET) не трогают лук и ладонь своего героя — только вспышки в мире
    if (d.remote && (ev.type === 'bow_release' || ev.type === 'hand_spell_form' || ev.type === 'hand_spell_cancel' || ev.type === 'hand_spell_throw' || ev.type === 'bow_draw_start' || ev.type === 'bow_cancel')) return;
    switch (ev.type) {
      case 'arrow_hit': {
        if (S.dlg.arrows || !p) return;
        const e = elIndex(d.element), ch = !!d.charged;
        flash(FL_HIT, p.x, p.y, p.z, e, ch ? 1.15 : 0.75, ch ? 0.36 : 0.3);
        if (sp) {
          burst(Math.round((ch ? 14 : 8) * sp), p.x, p.y, p.z, e, ch ? 6 : 4.5, 0.35, 0.4, 0.03);
          elementHit(e, p.x, p.y, p.z, ch ? 0.5 : 0.3, Math.round((ch ? 8 : 4) * sp));
        }
        if (e === 2) for (let i = 0; i < (ch ? 3 : 2); i++) spawnArc(-1, p.x, p.y, p.z, 0.05, ch ? 0.9 : 0.6, 0.012, rnd(0.08, 0.16), 3);
        return;
      }
      case 'hand_spell_hit': {
        if (S.dlg.orbs || !p) return;
        const e = elIndex(d.element), two = !!d.twoHand;
        flash(FL_BIG, p.x, p.y, p.z, e, two ? 3.4 : 2.4, two ? 0.55 : 0.45);
        if (sp) {
          burst(Math.round((two ? 36 : 24) * sp), p.x, p.y, p.z, e, two ? 9 : 7, 0.4, 0.6, 0.045);
          elementHit(e, p.x, p.y, p.z, two ? 1.4 : 1, Math.round((two ? 18 : 12) * sp));
        }
        if (e === 2) for (let i = 0; i < (two ? 7 : 5); i++) spawnArc(-1, p.x, p.y, p.z, 0.1, rnd(1.2, two ? 2.6 : 2), 0.02, rnd(0.12, 0.28), 3.4);
        return;
      }
      case 'arrow_rain': {
        if (dlgRain()) return;
        const c = hasVec(d.center) ? d.center : p;
        if (!c) return;
        spawnRain(c, d.radius, d.delay, elIndex(d.element));
        return;
      }
      case 'bow_release': {
        if (S.dlg.bow) return;
        bow.relT = 0;
        const src = bow.vis > 0.05 ? bow.grip : p;
        if (!src) return;
        const a = bow.aim;
        flash(FL_REL, src.x + a.x * 0.06, src.y + a.y * 0.06, src.z + a.z * 0.06, elIndex(d.element !== undefined ? d.element : bowElement()), bow.charged > 0.5 ? 0.7 : 0.5, 0.2, a.x, a.y, a.z);
        return;
      }
      case 'hand_spell_form': {
        if (dlgPalm() || !haveHands) return;
        const e = elIndex(d.element !== undefined ? d.element : palm.el);
        palm.birth = 0;
        flash(FL_BIRTH, HR.x, HR.y + 0.12, HR.z, e, 0.32, 0.32);
        return;
      }
      case 'hand_spell_cancel': {
        if (dlgPalm()) return;
        if (palm.shown) {
          palm.fz = FIZZ_DUR;
          flash(FL_FIZZ, palm.pos.x, palm.pos.y, palm.pos.z, palm.el, Math.max(0.3, palm.R * 3), 0.35);
          if (sp) for (let i = 0; i < 10 * sp; i++) emit(palm.pos.x + rnd(-0.08, 0.08), palm.pos.y, palm.pos.z + rnd(-0.08, 0.08), rnd(-0.2, 0.2), rnd(-0.6, 0.1), rnd(-0.2, 0.2), rnd(0.3, 0.6), 0.03, 0.01, EC[palm.el], 1.2, EDEEP[palm.el], 0.2, 2.5, 1.5, 0.03, 3, 30);
        }
        return;
      }
      case 'hand_spell_throw': {
        if (dlgPalm()) return;
        if (palm.shown) flash(FL_THROW, palm.pos.x, palm.pos.y, palm.pos.z, palm.el, Math.max(0.35, palm.R * 3.2), 0.25);
        palm.vis = 0; palm.on = false; palm.shown = false;
        return;
      }
      default:
    }
  }
  // стихийный «почерк» удара
  function elementHit(e, x, y, z, k, n) {
    for (let i = 0; i < n; i++) {
      const d = randDir(V[9]);
      if (e === 1) emit(x + d.x * 0.1, y + d.y * 0.1, z + d.z * 0.1, d.x * 1.2 * k, rnd(0.8, 2.2) * k, d.z * 1.2 * k, rnd(0.5, 1.0), rnd(0.025, 0.045), 0.01, ECORE[1], 2.8, EDEEP[1], 0.8, -0.6, 1.4, 0.05, 3, 14);
      else if (e === 3) emit(x + d.x * 0.15, y + d.y * 0.15, z + d.z * 0.15, d.x * 2.5 * k, d.y * 2.5 * k, d.z * 2.5 * k, rnd(0.25, 0.5), rnd(0.05, 0.09), 0.02, ECORE[3], 2.6, EC[3], 0.9, 1.5, 3, 0, 1, 20);
      else if (e === 4) emit(x, y, z, d.x * 3 * k, Math.abs(d.y) * 3.5 * k, d.z * 3 * k, rnd(0.5, 0.9), rnd(0.03, 0.05), 0.015, ECORE[4], 2.2, EDEEP[4], 0.5, 9, 0.8, 0.02, 3, 0);
      else if (e === 0) emit(x, y, z, d.x * 1.5 * k, d.y * 1.5 * k + 0.4, d.z * 1.5 * k, rnd(0.4, 0.8), rnd(0.02, 0.035), 0.008, ECORE[0], 2.4, EC[0], 0.6, 0.4, 2, 0.03, 3, 12);
      else emit(x, y, z, d.x * 4 * k, d.y * 4 * k, d.z * 4 * k, rnd(0.1, 0.25), 0.02, 0.008, ECORE[2], 3, EACC[2], 1.2, 3, 3, 0.05, 3, 0);
    }
  }
  const FIZZ_DUR = 0.35;

  // ---------------------------------------------------------------- кисти героя
  const HL = new THREE.Vector3(), HR = new THREE.Vector3(), FWD = new THREE.Vector3(0, 0, 1), RIGHT = new THREE.Vector3(-1, 0, 0), FEET = new THREE.Vector3();
  let haveHands = false, haveAnchors = false;
  let curBow = null;
  const bowElement = () => (curBow && curBow.element) || null;
  function resolveHands(pl, anchors) {
    haveHands = false; haveAnchors = false;
    const yaw = pl ? num(pl.yaw, 0) : 0;
    FWD.set(Math.sin(yaw), 0, Math.cos(yaw)); RIGHT.set(-Math.cos(yaw), 0, Math.sin(yaw));
    if (anchors && hasVec(anchors.heroHandL) && hasVec(anchors.heroHandR)) {
      HL.copy(anchors.heroHandL); HR.copy(anchors.heroHandR);
      if (hasVec(anchors.heroFeet)) FEET.copy(anchors.heroFeet); else if (pl && hasVec(pl.position)) FEET.copy(pl.position);
      haveHands = haveAnchors = true;
      return;
    }
    if (!pl || !hasVec(pl.position)) return;
    FEET.copy(pl.position);
    HL.copy(FEET).addScaledVector(RIGHT, -0.25).addScaledVector(FWD, 0.45); HL.y += 1.35;
    HR.copy(FEET).addScaledVector(RIGHT, 0.25).addScaledVector(FWD, 0.45); HR.y += 1.35;
    haveHands = true;
  }

  // ---------------------------------------------------------------- лук: кадр
  function updateBow(dt, b, pl, playing) {
    const phase = b && typeof b.phase === 'string' ? b.phase : 'idle';
    const want = !S.dlg.bow && playing && haveHands && !!b && (b.active === true || phase === 'ready' || phase === 'nocked' || phase === 'drawing');
    bow.vis = approach(bow.vis, want ? 1 : 0, dt / 0.2);
    bow.relT += dt;
    if (bow.vis <= 0.001) {
      bowGroup.visible = false; strLine.visible = false; nockArrow.visible = false; bow.aimInit = false; bow.arrowVis = 0;
      return;
    }
    const vis = bow.vis, sIn = 0.82 + 0.18 * easeOut(vis);
    if (b) {
      const draw = clamp01(num(b.draw, 0));
      bow.draw += (draw - bow.draw) * (1 - Math.exp(-dt * 28));
      bow.el = elIndex(b.element);
      bow.charged = approach(bow.charged, b.charged ? 1 : 0, dt / 0.15);
      // прицел: вперёд героя, повёрнутый на aimX·28° вправо и aimY·22° вверх
      const yaw = num(pl.yaw, 0) - clamp(num(b.aimX, 0), -1.5, 1.5) * AIM_YAW, pitch = clamp(num(b.aimY, 0), -1.5, 1.5) * AIM_PITCH;
      const a = V[0].set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      if (!bow.aimInit) { bow.aim.copy(a); bow.aimInit = true; } else bow.aim.lerp(a, 1 - Math.exp(-dt * 18)).normalize();
    }
    const nocked = !!b && (phase === 'nocked' || phase === 'drawing');
    const draw = nocked ? bow.draw : 0;
    const aim = bow.aim;
    // ориентация: локальная +Z — прицел, +Y — вверх, лёгкий завал верхнего плеча вправо
    const x = V[1].crossVectors(UP, aim);
    if (x.lengthSq() < 1e-6) x.copy(RIGHT).negate(); else x.normalize();
    const y = V[2].crossVectors(aim, x);
    _m.makeBasis(x, y, aim);
    bow.q.setFromRotationMatrix(_m).multiply(qCant).multiply(qShow);
    // кисть без якорей: вытянутая левая рука перед плечом
    if (!haveAnchors) {
      HL.copy(FEET).addScaledVector(RIGHT, -0.16); HL.y += 1.42; HL.addScaledVector(aim, 0.55);
    }
    bow.grip.copy(HL);
    const flexY = 1 - 0.035 * draw, flexZ = 1 + 0.5 * draw;
    bowGroup.visible = true; bowGroup.position.copy(bow.grip); bowGroup.quaternion.copy(bow.q);
    bowBody.scale.set(sIn, sIn * flexY, sIn * flexZ);
    bowMat.opacity = vis;
    // куда тянется тетива: к правой кисти, если она правдоподобно позади лука, иначе — к «уху» лучника
    const synth = V[3].copy(bow.grip).addScaledVector(aim, -0.7); synth.y += 0.05; synth.addScaledVector(RIGHT, 0.04);
    let plaus = 0;
    if (haveAnchors) {
      const tx = HR.x - bow.grip.x, ty = HR.y - bow.grip.y, tz = HR.z - bow.grip.z, dist = Math.hypot(tx, ty, tz);
      if (dist > 0.05 && dist < 1.15) plaus = clamp01((-(tx * aim.x + ty * aim.y + tz * aim.z) / dist - 0.72) / 0.15);
    }
    bow.plaus += (plaus - bow.plaus) * (1 - Math.exp(-dt * 10));
    const target = V[4].copy(synth).lerp(HR, bow.plaus);
    // точки тетивы в мире
    const loc = V[5], q = bow.q, g = bow.grip;
    const toW = (lx, ly, lz, out) => out.set(lx, ly, lz).applyQuaternion(q).add(g);
    const rest = toW(0, NOCK_Y * sIn, STR_LIFT[1] * sIn * flexZ, V[6]);
    bow.nock.copy(rest).lerp(target, draw);
    if (!S.rm && bow.relT < 0.45) {
      const vib = 0.03 * Math.exp(-bow.relT * 11) * Math.sin(bow.relT * 95);
      loc.set(0, 0, vib).applyQuaternion(q); bow.nock.add(loc);
    }
    const w = (ly, lz, i) => { toW(0, ly * sIn * flexY, lz * sIn * flexZ, loc); strPos[i * 3] = loc.x; strPos[i * 3 + 1] = loc.y; strPos[i * 3 + 2] = loc.z; };
    w(STR_TIP[0], STR_TIP[1], 0); w(STR_LIFT[0], STR_LIFT[1], 1);
    strPos[6] = bow.nock.x; strPos[7] = bow.nock.y; strPos[8] = bow.nock.z;
    w(-STR_LIFT[0], STR_LIFT[1], 3); w(-STR_TIP[0], STR_TIP[1], 4);
    strGeo.attributes.position.needsUpdate = true;
    strLine.visible = true;
    const c = EC[bow.el], cr = ECORE[bow.el];
    const pulse = S.rm ? 1 : 1 + 0.35 * Math.sin(S.time * 11);
    const ch = bow.charged, chK = 1 + ch * 0.9 * pulse;
    strMat.opacity = 0.9 * vis;
    const sm = draw * 0.3 + ch * 0.35;
    strMat.color.setRGB(lerp(0.62, c[0] * 1.5, sm), lerp(0.56, c[1] * 1.5, sm), lerp(0.44, c[2] * 1.5, sm));
    const rk = vis * (1.25 + 0.6 * draw) * (1 + 0.45 * ch * pulse);
    runeMat.color.setRGB(c[0] * rk, c[1] * rk, c[2] * rk);
    // руны-узлы на плечах и мягкое свечение натянутой тетивы
    for (let i = 0; i < 4; i++) {
      const u = bow.runeU[i];
      toW(u.x * sIn, u.y * sIn * flexY, u.z * sIn * flexZ, loc);
      bbc(loc.x, loc.y, loc.z, 0.07 + 0.03 * draw, c, 0.7 * vis * (1 + 0.5 * ch), 3);
    }
    for (let i = 0; i < limbGlowU.length; i++) {
      const u = limbGlowU[i];
      toW(u.x * sIn, u.y * sIn * flexY, u.z * sIn * flexZ, loc);
      bbc(loc.x, loc.y, loc.z, 0.075 + 0.03 * draw, c, 0.22 * vis * (1 + 0.6 * ch * pulse), 0);
    }
    if (draw > 0.02 || ch > 0) {
      const sk = (0.1 + 0.28 * draw) * vis * (1 + 0.8 * ch * pulse);
      for (let i = 0; i < 5; i++) plAdd(strPos[i * 3], strPos[i * 3 + 1], strPos[i * 3 + 2]);
      for (let i = 0; i < 5; i++) plStyle(i, 0.005 + 0.003 * ch, i === 2 ? cr : c, sk * (i === 2 ? 1.3 : 0.8));
      plFlush();
    }
    // [HAND] дуга прицела: баллистика стрелы из snap.player.bow.launch (combatHand, с аим-ассистом)
    const L = b && b.launch;
    if (nocked && draw > 0.1 && L && L.from && L.vel && Number.isFinite(L.vel.x) && Number.isFinite(L.from.x)) {
      const g = num(L.g, 9), sp = Math.hypot(L.vel.x, L.vel.y, L.vel.z) || 1, T = Math.min(1.4, 40 / sp), n = 18;
      const k0 = vis * (0.16 + 0.34 * draw) * (L.assist ? 1.35 : 1) * (1 + 0.5 * ch);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const t = (T * (i + 1)) / n;
        const px = L.from.x + L.vel.x * t, py = L.from.y + L.vel.y * t - 0.5 * g * t * t, pz = L.from.z + L.vel.z * t;
        if (py < L.from.y - 6 || !plAdd(px, py, pz)) break;
        m++;
      }
      for (let i = 0; i < m; i++) plStyle(i, 0.006 + 0.004 * ch, i % 2 ? c : cr, k0 * (1 - i / Math.max(1, m)));
      plFlush();
    }
    // наложенная стрела: от точки натяжения вперёд сквозь полочку лука
    const wantArrow = nocked && bow.relT > 0.08;
    bow.arrowVis = wantArrow ? approach(bow.arrowVis, 1, dt / 0.08) : 0;
    if (bow.arrowVis > 0.01) {
      const restPt = toW(REST_X * sIn, NOCK_Y * sIn, 0.004, V[7]);
      const dir = bow.dir.copy(restPt).sub(bow.nock);
      if (dir.lengthSq() < 0.0025) dir.copy(aim); else dir.normalize();
      nockArrow.visible = true;
      nockArrow.position.copy(bow.nock);
      nockArrow.quaternion.setFromUnitVectors(AX_Y, dir);
      nockArrow.scale.setScalar(sIn);
      const av = bow.arrowVis * vis;
      nockShaftMat.opacity = av; nockHeadMat.opacity = av;
      const hk = (1.8 + 0.8 * draw) * chK;
      nockHeadMat.color.setRGB(c[0] * hk, c[1] * hk, c[2] * hk);
      const tip = V[8].copy(bow.nock).addScaledVector(dir, ARROW_LEN * sIn * 0.97);
      bbc(tip.x, tip.y, tip.z, (0.16 + 0.12 * draw + 0.12 * ch) * (S.rm ? 1 : 1 + 0.12 * ch * Math.sin(S.time * 11)), c, (0.32 + 0.28 * draw) * av * (1 + 0.6 * ch), 0);
      bbc(tip.x, tip.y, tip.z, 0.05 + 0.035 * draw, cr, 1.3 * av * (1 + 0.4 * ch), 3);
      if (ch > 0.5) bbc(tip.x, tip.y, tip.z, 0.26 + 0.05 * pulse, cr, 0.4 * av * ch, 1, S.rm ? 0.3 : S.time * 1.5);
      if (S.Q.emit && draw > 0.4) {
        bow.src.acc = Math.min(4, bow.src.acc + (6 + 22 * ch) * S.Q.emit * dt);
        while (bow.src.acc >= 1) {
          bow.src.acc -= 1;
          const d = randDir(V[9]);
          if (bow.el === 1 || bow.el === 0 || ch > 0.5) emit(tip.x + d.x * 0.02, tip.y + d.y * 0.02, tip.z + d.z * 0.02, d.x * 0.25, 0.25 + Math.random() * 0.3, d.z * 0.25, rnd(0.3, 0.6), rnd(0.012, 0.022), 0.005, cr, 2.6, EC[bow.el], 0.7, -0.2, 1.5, 0.03, 3, 18);
        }
      }
    } else nockArrow.visible = false;
  }

  // ---------------------------------------------------------------- сгусток в ладони: кадр
  function updatePalm(dt, hs, playing) {
    const phase = hs && typeof hs.phase === 'string' ? hs.phase : 'idle';
    const active = !dlgPalm() && playing && haveHands && (phase === 'form' || phase === 'hold');
    const rig = palm.rig;
    if (active) {
      const e = elIndex(hs.element);
      if (!palm.on || e !== palm.el) { palm.on = true; palm.birth = 0; palm.el = e; palm.fz = 0; palm.acc = 0; }
      palm.birth = Math.min(1, palm.birth + dt / 0.25);
      palm.vis = 1;
      palm.power += (clamp01(num(hs.power, 0)) - palm.power) * (1 - Math.exp(-dt * 10));
      palm.size += (clamp01(num(hs.size, 0.3)) - palm.size) * (1 - Math.exp(-dt * 10));
      palm.two = approach(palm.two, hs.twoHand ? 1 : 0, dt / 0.25);
    } else {
      palm.on = false;
      if (palm.fz > 0) { palm.fz -= dt; if (palm.fz <= 0) { palm.fz = 0; palm.vis = 0; } } else palm.vis = approach(palm.vis, 0, dt / 0.12);
      if (phase === 'throw') { palm.vis = 0; palm.fz = 0; }
    }
    const fzK = palm.fz > 0 ? Math.pow(clamp01(palm.fz / FIZZ_DUR), 0.7) : 1;
    const show = (palm.vis > 0.001 || palm.fz > 0) && haveHands && playing;
    palm.shown = show;
    if (!show) { rig.group.visible = false; killArcs(0); return; }
    const e = palm.el;
    let R = lerp(0.08, 0.22, palm.size) * easeOutBack(palm.birth) * fzK * (palm.fz > 0 ? 1 : palm.vis);
    R *= 1 - 0.2 * palm.two;
    palm.R = R;
    // над раскрытой ладонью; лёд — под ладонью (ладонь вниз); земля — в кулаке
    const p = palm.pos.copy(HR).addScaledVector(FWD, 0.03);
    p.y += e === 3 ? -(R * 0.9 + 0.03) : e === 4 ? R * 0.55 + 0.02 : R * 0.9 + 0.035;
    if (palm.two > 0) { V[0].copy(HL).add(HR).multiplyScalar(0.5); p.lerp(V[0], palm.two); }
    if (R < 0.004) { rig.group.visible = false; return; }
    const t = S.time;
    const flick = palm.fz > 0 && !S.rm ? 0.5 + 0.5 * Math.sin(t * 70) : 1;
    let k = (0.8 + 0.3 * palm.power) * flick;
    if (!S.rm) k *= e === 1 ? 1 + 0.08 * Math.sin(t * 13) + 0.05 * Math.sin(t * 29) : e === 2 ? 0.9 + 0.2 * Math.random() : 1 + 0.06 * Math.sin(t * 4);
    rig.group.visible = true; rig.group.position.copy(p);
    styleRig(rig, e, R, k, t);
    rig.ring.visible = false;
    const c = EC[e], cr = ECORE[e];
    bbc(p.x, p.y, p.z, R * 4.4, c, 0.2 * k, 0);
    bbc(p.x, p.y, p.z, R * 1.9, cr, 0.08 * k, 0);
    if (e === 1) bbc(p.x, p.y + R * 0.8, p.z, R * 2.8, c, 0.14 * k, 0);
    if (e === 3 || e === 4) satellites(e, p.x, p.y, p.z, R, S.Q.palmShards, t, palm.seed, R / 0.15);
    if (e === 2 && palm.fz <= 0) {
      const want = S.Q.arcs;
      for (let n = countArcs(0); n < want; n++) spawnArc(0, 0, 0, 0, R * 0.5, R * rnd(1.6, 2.6), 0.0055 + R * 0.03, rnd(0.05, 0.12), 2.6 * k);
    }
    if (palm.fz <= 0) emitElement(palm, e, p.x, p.y, p.z, R, (e === 1 ? 44 : e === 2 ? 40 : e === 3 ? 22 : e === 4 ? 14 : 16) * (0.6 + 0.6 * palm.power), dt, 0, 0, 0);
  }

  // ---------------------------------------------------------------- снаряды: кадр
  function findSlot(arr, id) { for (let i = 0; i < arr.length; i++) if (arr[i].on && arr[i].id === id) return arr[i]; return null; }
  function freeSlot(arr) { for (let i = 0; i < arr.length; i++) if (!arr[i].on) return arr[i]; return null; }
  function trPush(s, force) {
    const o = ((s.trHead - 1 + TP) % TP) * 3;
    if (!force && s.trN > 0 && Math.hypot(s.pos.x - s.tr[o], s.pos.y - s.tr[o + 1], s.pos.z - s.tr[o + 2]) < 0.2) return;
    const w = s.trHead * 3;
    s.tr[w] = s.pos.x; s.tr[w + 1] = s.pos.y; s.tr[w + 2] = s.pos.z;
    s.trHead = (s.trHead + 1) % TP; s.trN = Math.min(TP, s.trN + 1);
  }
  // шлейф: голова (со сдвигом back назад) → точки истории, обрезка по длине maxLen
  function trail(s, back, maxLen, w0, e, k0) {
    const dx = s.dir.x * back, dy = s.dir.y * back, dz = s.dir.z * back;
    plAdd(s.pos.x - dx, s.pos.y - dy, s.pos.z - dz);
    for (let j = 0; j < s.trN && plN < PL_MAX; j++) {
      const o = ((s.trHead - 1 - j + TP * 2) % TP) * 3;
      const x = s.tr[o] - dx, y = s.tr[o + 1] - dy, z = s.tr[o + 2] - dz;
      const po = (plN - 1) * 3, seg = Math.hypot(x - plP[po], y - plP[po + 1], z - plP[po + 2]);
      if (seg < 1e-3) continue;
      const acc = plL[plN - 1];
      if (acc + seg >= maxLen) { const f = (maxLen - acc) / seg; plAdd(plP[po] + (x - plP[po]) * f, plP[po + 1] + (y - plP[po + 1]) * f, plP[po + 2] + (z - plP[po + 2]) * f); break; }
      plAdd(x, y, z);
    }
    const n = plN;
    if (n < 2) { plN = 0; return; }
    const total = Math.max(plL[n - 1], maxLen * 0.4), c = EC[e], cr = ECORE[e];
    for (let i = 0; i < n; i++) {
      const u = plL[i] / total, f = Math.pow(1 - u, 1.4);
      plStyle(i, w0 * (1 - 0.75 * u), i === 0 ? cr : c, k0 * f);
    }
    plFlush();
  }
  function updateProjectiles(dt, list) {
    for (let i = 0; i < ARROW_CAP; i++) arrowSlots[i].seen = false;
    for (let i = 0; i < ORB_CAP; i++) orbSlots[i].seen = false;
    const n = Array.isArray(list) ? Math.min(list.length, 256) : 0;
    for (let i = 0; i < n; i++) {
      const pr = list[i];
      if (!pr || typeof pr !== 'object' || !hasVec(pr.position)) continue;
      const isArrow = pr.kind === 'arrow', isOrb = pr.kind === 'hand_orb';
      if (!isArrow && !isOrb) continue;
      if (isArrow ? S.dlg.arrows : S.dlg.orbs) continue;
      const arr = isArrow ? arrowSlots : orbSlots, id = pr.id !== undefined ? pr.id : i;
      let s = findSlot(arr, id);
      if (s && s.dying > 0) s = null;
      if (!s) {
        s = freeSlot(arr);
        if (!s) continue;
        s.on = true; s.id = id; s.dying = 0; s.trN = 0; s.trHead = 0; s.acc = 0; s.seed = Math.random(); s.age = 0;
        s.pos.copy(pr.position); trPush(s, true);
      }
      s.seen = true;
      s.pos.copy(pr.position);
      if (hasVec(pr.velocity)) {
        const vx = pr.velocity.x, vy = pr.velocity.y, vz = pr.velocity.z, l = Math.hypot(vx, vy, vz);
        if (l > 1e-3) s.dir.set(vx / l, vy / l, vz / l);
      }
      s.el = elIndex(pr.element); s.charged = !!pr.charged; s.two = !!pr.twoHand; s.r = clamp(num(pr.radius, 0.2), 0.06, 1.2);
      trPush(s, false);
    }
    // стрелы
    let na = 0;
    const q = Q4[0], sc = _sc, t = S.time, trails = S.Q.trails, tl = S.Q.trailLen;
    for (let i = 0; i < ARROW_CAP; i++) {
      const s = arrowSlots[i];
      if (!s.on) continue;
      if (!s.seen) { if (s.dying <= 0) s.dying = 1e-4; s.dying += dt; if (s.dying > 0.2 || !trails) { s.on = false; continue; } }
      s.age += dt;
      const c = EC[s.el], cr = ECORE[s.el], ch = s.charged;
      const fade = s.dying > 0 ? 1 - s.dying / 0.2 : 1;
      if (trails) trail(s, ARROW_LEN * 0.9, (ch ? 3.0 : 2.1) * tl, ch ? 0.03 : 0.018, s.el, (ch ? 1.5 : 1.0) * fade);
      if (s.dying > 0) continue;
      // тело стрелы: наконечник в позиции снаряда
      q.setFromUnitVectors(AX_Y, s.dir);
      const L = ARROW_LEN * 1.12;
      V[0].copy(s.pos).addScaledVector(s.dir, -L);
      sc.setScalar(1.12);
      _m.compose(V[0], q, sc);
      flyShafts.setMatrixAt(na, _m); flyHeads.setMatrixAt(na, _m);
      const pulse = ch && !S.rm ? 1 + 0.3 * Math.sin(t * 14 + s.seed * 9) : 1;
      const hk = (ch ? 2.8 : 2.0) * pulse;
      flyHeads.setColorAt(na, _col.setRGB(c[0] * hk, c[1] * hk, c[2] * hk));
      na++;
      bbc(s.pos.x, s.pos.y, s.pos.z, (ch ? 0.5 : 0.32) * pulse, c, ch ? 0.6 : 0.45, 0);
      bbc(s.pos.x, s.pos.y, s.pos.z, ch ? 0.12 : 0.08, cr, 1.6, 3);
      if (ch) bbc(s.pos.x, s.pos.y, s.pos.z, 0.45, cr, 0.35 * pulse, 1, S.rm ? 0.4 : t * 3 + s.seed * 6);
      if (S.Q.emit && (ch || s.el > 0)) emitElement(s, s.el, s.pos.x, s.pos.y, s.pos.z, 0.05, ch ? 26 : 12, dt, -s.dir.x * 0.5, -s.dir.y * 0.5, -s.dir.z * 0.5);
    }
    flyShafts.count = flyHeads.count = na;
    flyShafts.visible = flyHeads.visible = na > 0;
    if (na > 0) {
      flyShafts.instanceMatrix.needsUpdate = true; flyHeads.instanceMatrix.needsUpdate = true;
      if (flyHeads.instanceColor) flyHeads.instanceColor.needsUpdate = true;
    }
    // сгустки
    for (let i = 0; i < ORB_CAP; i++) {
      const s = orbSlots[i], rig = s.rig;
      if (!s.on) { rig.group.visible = false; continue; }
      if (!s.seen) { if (s.dying <= 0) { s.dying = 1e-4; killArcs(i + 1); } s.dying += dt; if (s.dying > 0.22 || !trails) { s.on = false; rig.group.visible = false; continue; } }
      s.age += dt;
      const e = s.el, c = EC[e], cr = ECORE[e];
      const R = clamp(s.r * (s.two ? 1.25 : 1), 0.1, 0.8) * Math.min(1, 0.55 + s.age * 6);
      const fade = s.dying > 0 ? 1 - s.dying / 0.22 : 1;
      if (trails) trail(s, R * 0.4, (2.2 + R * 3) * tl, R * 0.75, e, 1.1 * fade);
      if (s.dying > 0) { rig.group.visible = false; continue; }
      let k = 1.1 + (s.two ? 0.25 : 0);
      if (!S.rm) k *= e === 2 ? 0.9 + 0.2 * Math.random() : 1 + 0.06 * Math.sin(t * 12 + s.seed * 5);
      rig.group.visible = true; rig.group.position.copy(s.pos);
      styleRig(rig, e, R, k, t + s.seed * 10);
      rig.ring.visible = s.two;
      if (s.two) {
        q.setFromUnitVectors(AX_Z, s.dir);
        Q4[1].setFromAxisAngle(AX_Z, S.rm ? 0.6 : t * 4.5);
        rig.ring.quaternion.copy(q).multiply(Q4[1]).multiply(qTilt);
        rig.ring.scale.setScalar(1.5);
        rig.ringMat.color.setRGB(cr[0] * 2.4, cr[1] * 2.4, cr[2] * 2.4);
      }
      bbc(s.pos.x, s.pos.y, s.pos.z, R * 4.6, c, 0.24 * k, 0);
      bbc(s.pos.x, s.pos.y, s.pos.z, R * 2.0, cr, 0.1 * k, 0);
      if ((e === 3 || e === 4) && S.Q.orbShards) satellites(e, s.pos.x, s.pos.y, s.pos.z, R, S.Q.orbShards + (s.two ? 2 : 0), t, s.seed, R / 0.15);
      if (e === 2) for (let a = countArcs(i + 1); a < (S.q === 'low' ? 1 : 2 + (s.two ? 2 : 0)); a++) spawnArc(i + 1, 0, 0, 0, R * 0.6, R * rnd(1.6, 2.4), 0.008 + R * 0.03, rnd(0.05, 0.1), 2.6);
      emitElement(s, e, s.pos.x, s.pos.y, s.pos.z, R, (e === 1 ? 70 : e === 2 ? 45 : 36) * (s.two ? 1.5 : 1), dt, -s.dir.x * 0.8, -s.dir.y * 0.8, -s.dir.z * 0.8);
    }
  }

  // ---------------------------------------------------------------- update
  function readSettings() {
    const st = cfg.settings && typeof cfg.settings === 'object' ? cfg.settings : null;
    S.rm = !!(st && st.reducedMotion);
    const q = st && st.quality;
    if (q !== S.lastSettingsQ) { S.lastSettingsQ = q; if (QUALITY[q]) applyQuality(q); }
  }
  function applyQuality(q) {
    if (!QUALITY[q]) return;
    S.q = q; S.Q = QUALITY[q];
    if (pN > S.Q.particles) pN = S.Q.particles;
  }
  function update(dt, snap, events, anchors) {
    if (S.disposed) return;
    try {
      dt = clamp(num(dt, 1 / 60), 0, 0.1);
      readSettings();
      S.time += dt;
      bbN = 0; ribN = 0; shardN = 0; pebbleN = 0; plN = 0;
      const sn = snap && typeof snap === 'object' ? snap : null;
      const pl = sn && sn.player && typeof sn.player === 'object' ? sn.player : null;
      const playing = !!pl && (sn.status === undefined || sn.status === null || sn.status === 'playing');
      const b = pl && pl.bow && typeof pl.bow === 'object' ? pl.bow : null;
      curBow = b;
      resolveHands(pl, anchors);
      if (Array.isArray(events)) for (let i = 0, n = Math.min(events.length, 256); i < n; i++) onEvent(events[i]);
      updateBow(dt, b, pl, playing);
      updatePalm(dt, pl && pl.handSpell && typeof pl.handSpell === 'object' ? pl.handSpell : null, playing);
      updateProjectiles(dt, sn ? sn.projectiles : null);
      updateFlashes(dt);
      updateRains(dt);
      updateArcs(dt);
      updateParticles(dt);
      finish();
    } catch (err) {
      S.errors++;
      if (S.time - S.lastWarn > 5) { S.lastWarn = S.time; try { console.warn('[handVisuals] update error', err); } catch (e) { /* ignore */ } }
    }
  }
  function upload(attr, n) {
    if (typeof attr.clearUpdateRanges === 'function') { attr.clearUpdateRanges(); attr.addUpdateRange(0, n); }
    attr.needsUpdate = true;
  }
  function finish() {
    bbGeo.instanceCount = bbN; bbMesh.visible = bbN > 0;
    if (bbN > 0) upload(bbBuf, bbN * 12);
    ribGeo.setDrawRange(0, ribN); ribMesh.visible = ribN > 0;
    if (ribN > 0) { upload(ribAttrs[0], ribN * 3); upload(ribAttrs[1], ribN * 3); upload(ribAttrs[2], ribN); upload(ribAttrs[3], ribN * 3); }
    shards.count = shardN; shards.visible = shardN > 0; if (shardN) shards.instanceMatrix.needsUpdate = true;
    pebbles.count = pebbleN; pebbles.visible = pebbleN > 0; if (pebbleN) pebbles.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- прочее API
  function setQuality(q) { applyQuality(q); }
  function setDelegated(opts) {
    if (!opts || typeof opts !== 'object') return;
    for (const k of ['arrows', 'orbs', 'bow']) if (k in opts) S.dlg[k] = !!opts[k];
    for (const k of ['palm', 'rain']) if (k in opts) S.dlg[k] = opts[k] === null || opts[k] === undefined ? null : !!opts[k];
  }
  function reset() {
    try {
      bow.vis = 0; bow.draw = 0; bow.aimInit = false; bow.relT = 9; bow.charged = 0; bow.arrowVis = 0;
      bowGroup.visible = false; strLine.visible = false; nockArrow.visible = false;
      palm.on = false; palm.shown = false; palm.vis = 0; palm.fz = 0; palm.birth = 0; palm.rig.group.visible = false;
      for (const s of arrowSlots) { s.on = false; s.trN = 0; }
      for (const s of orbSlots) { s.on = false; s.trN = 0; s.rig.group.visible = false; }
      for (const f of flashes) f.on = false;
      for (const r of rains) { r.on = false; r.group.visible = false; }
      for (const a of arcs) a.on = false;
      pN = 0; bbN = 0; ribN = 0; shardN = 0; pebbleN = 0;
      finish();
      flyShafts.count = flyHeads.count = 0; flyShafts.visible = flyHeads.visible = false;
      seenIds.fill(undefined);
    } catch (e) { /* ignore */ }
  }
  function dispose() {
    if (S.disposed) return;
    S.disposed = true;
    try {
      scene.remove(root);
      for (const im of [flyShafts, flyHeads, shards, pebbles]) if (im.dispose) im.dispose();
      for (const g of owned.geo) g.dispose();
      for (const m of owned.mat) m.dispose();
      for (const t of owned.tex) t.dispose();
      owned.geo.length = owned.mat.length = owned.tex.length = 0;
    } catch (e) { /* ignore */ }
  }
  function info() {
    let arrows = 0, orbs = 0, fl = 0, rn = 0;
    for (const s of arrowSlots) if (s.on && !s.dying) arrows++;
    for (const s of orbSlots) if (s.on && !s.dying) orbs++;
    for (const f of flashes) if (f.on) fl++;
    for (const r of rains) if (r.on) rn++;
    return {
      version: HAND_VISUALS_VERSION, quality: S.q, reducedMotion: S.rm, bow: bow.vis > 0.001, bowDraw: bow.draw, palm: palm.shown ? palm.el : null,
      arrows, orbs, flashes: fl, rains: rn, particles: pN, billboards: bbN, ribbonVerts: ribN, shards: shardN + pebbleN, errors: S.errors, delegated: { ...S.dlg },
    };
  }

  return { update, setQuality, reset, dispose, setDelegated, info, root };
}
