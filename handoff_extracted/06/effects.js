/*
 * ASHEN OATH — effects.js
 * API_VERSION = ASHEN_V1
 * Роль №6: магия, обратная связь, телеграфы атак босса и звук.
 *
 * Модуль ТОЛЬКО презентационный:
 *  - не наносит урон, не меняет snapshot/events (читает их как read-only);
 *  - не вызывает renderer.render(), не запускает requestAnimationFrame;
 *  - не меняет camera.position (getCameraImpulse() только возвращает смещение);
 *  - все объекты висят на одном root-группе, удаляемой в dispose();
 *  - частицы, вспышки, кольца, телеграфы и снаряды берутся из пулов фиксированного размера;
 *  - звук синтезируется Web Audio, AudioContext создаётся только в unlockAudio().
 *
 * Экспорт: createEffects({THREE, scene, camera, renderer, config}) и API_VERSION.
 */

export const API_VERSION = 'ASHEN_V1';

const TAU = Math.PI * 2;
const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

const EVENT_CACHE_SIZE = 1024;     // ограниченный кэш id событий
const MAX_EVENTS_PER_FRAME = 256;  // защита от случайно огромного массива
const TELE_CAP = 16;               // визуалов телеграфов одновременно
const PROJ_CAP = 40;               // визуалов снарядов одновременно
const TRAIL_MAX = 16;              // точек шлейфа на снаряд (верхняя граница)
const MAX_GLOW = 1100;             // аддитивные частицы (искры, мотыльки света)
const MAX_DUST = 480;              // пыль/каменная крошка (обычное смешивание)
const IMPULSE_MAX = 0.15;          // |getCameraImpulse()| в метрах

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const rnd = (a, b) => a + Math.random() * (b - a);

function hexToRaw(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

// Палитра: янтарь/старое золото героя, холодный свет стража, приглушённая «опасность».
const PAL = Object.freeze({
  heroCore: 0xffe2b0,
  heroAmber: 0xe8a14a,
  heroGold: 0xc79a55,
  heroEmber: 0xb4602e,
  guardCore: 0xe0eeff,
  guardCold: 0x9cc5e3,
  guardDeep: 0x5c87ab,
  dangerRim: 0xc95d45,   // неблокируемая зона: тёплый приглушённый красный + зубчатая кромка
  dangerHot: 0xf2d0c2,
  hitEmber: 0xcf5a3a,
  dust: 0x6e6962,
  dustLight: 0x9c968c,
});
// Сырые sRGB-значения для ShaderMaterial (у шейдеров нет цветового преобразования на выходе).
const RAW = {};
for (const k of Object.keys(PAL)) RAW[k] = hexToRaw(PAL[k]);
Object.freeze(RAW);

// Уровни качества меняют реальные параметры. Телеграфы и «существенные» частицы попаданий
// не зависят от decor и присутствуют на всех уровнях.
const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({ glowCap: 280, dustCap: 140, decor: 0.3, trailPts: 6, ghosts: 2, light: false, shell: false, projSparks: 0, motes: 0 }),
  medium: Object.freeze({ glowCap: 650, dustCap: 300, decor: 0.7, trailPts: 10, ghosts: 3, light: true, shell: true, projSparks: 0.6, motes: 0.6 }),
  high: Object.freeze({ glowCap: MAX_GLOW, dustCap: MAX_DUST, decor: 1.0, trailPts: 14, ghosts: 4, light: true, shell: true, projSparks: 1.0, motes: 1.0 }),
});

// ------------------------------------------------------------------ GLSL
// Код пишется в стиле GLSL ES 1.0 (gl_FragColor/varying); three.js сам переводит его для WebGL2.
// fwidth/derivatives не используются, чтобы шейдеры компилировались и в WebGL1-режиме старых three.

const GLSL_BAND = `
float band(float x, float c, float w, float s) {
  return 1.0 - smoothstep(w, w + s, abs(x - c));
}
`;

const VS_UV = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Наземные маркеры. uMode: 0 slam, 1 nova, 2 прицел orb, 3 ударная волна, 4 трещины удара.
const FS_ZONE = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uOpacity;
uniform float uProgress;
uniform float uTime;
uniform float uMode;
uniform float uBlockable;
uniform float uFlash;
uniform float uRadius;
varying vec2 vUv;
${GLSL_BAND}
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * 1.12;
  float r = length(p);
  if (r > 1.12) discard;
  float a = atan(p.y, p.x + 1e-5);
  float m = 1.0 / max(uRadius, 0.25);
  float s = 0.03 * m + 0.004;
  float prog = clamp(uProgress, 0.0, 1.0);
  float late = smoothstep(0.7, 1.0, prog);
  vec3 col = vec3(0.0);

  if (uMode < 1.5) {
    float edgeR = 0.985;
    float rimW = 0.045 * m + 0.004;
    float inside = 1.0 - smoothstep(edgeR - s, edgeR, r);
    float rim = band(r, edgeR - rimW, rimW, s);
    float halo = (1.0 - smoothstep(0.0, 0.3 * m + 0.02, r - edgeR)) * step(edgeR, r) * 0.45;
    float pulse = 0.5 + 0.5 * sin(uTime * mix(4.0, 20.0, late));
    float innerEdge = edgeR - rimW * 2.0;
    float mark = 0.0;
    if (uBlockable > 0.5) {
      mark = band(r, innerEdge - 0.07 * m - 0.012, 0.012 * m + 0.002, s) * 0.8;
    } else {
      float tt = fract(a / 6.2831853 * 28.0);
      float tri = 1.0 - abs(tt * 2.0 - 1.0);
      float depth = (0.16 * m + 0.03) * tri;
      mark = smoothstep(innerEdge - depth - s, innerEdge - depth, r)
           * (1.0 - smoothstep(innerEdge, innerEdge + s, r)) * 0.85;
    }
    float pattern = 0.0;
    if (uMode < 0.5) {
      float w = fract((p.x + p.y) * uRadius * 1.4 - uTime * 0.35);
      pattern = (smoothstep(0.0, 0.08, w) - smoothstep(0.28, 0.36, w)) * 0.10 * inside;
    } else {
      float rr = fract(r * max(uRadius, 1.0) * 0.45 - uTime * mix(0.6, 2.2, late));
      pattern = (smoothstep(0.0, 0.1, rr) - smoothstep(0.18, 0.3, rr)) * 0.12 * inside;
      float tick = step(0.82, fract(a / 6.2831853 * 60.0))
                 * band(r, innerEdge - 0.05 * m - 0.03, 0.03 * m + 0.012, s);
      pattern += tick * 0.55;
    }
    float fillR = prog * edgeR;
    float fill = (1.0 - smoothstep(fillR - s, fillR, r)) * inside;
    float fillEdge = band(r, fillR, 0.02 * m + 0.004, s) * step(0.001, prog) * inside;
    float base = 0.07 * inside;
    col = uColor * (rim * (0.8 + 0.3 * late * pulse) + halo * 0.8 + mark + pattern + base + fill * (0.13 + 0.2 * late))
        + uHot * (fillEdge * 0.8 + rim * late * pulse * 0.3 + uFlash * (inside * 0.7 + rim * 0.8));
  } else if (uMode < 2.5) {
    float ring = band(r, 0.8, 0.035, 0.03);
    float ta = fract((a + uTime * 1.4) / 6.2831853 * 4.0 + 0.5) - 0.5;
    float tick = (1.0 - smoothstep(0.02, 0.05, abs(ta))) * smoothstep(0.42, 0.5, r) * (1.0 - smoothstep(0.92, 0.98, r));
    float dotc = 1.0 - smoothstep(0.08, 0.13, r);
    float cr = 1.0 - fract(uTime * mix(0.8, 2.4, prog));
    float contract = band(r, 0.25 + 0.7 * cr, 0.02, 0.03) * 0.5;
    col = uColor * (ring + tick * 0.8 + dotc * 0.6 + contract) + uHot * (uFlash + late * 0.4) * (ring + dotc);
  } else if (uMode < 3.5) {
    float ring = band(r, 0.95, 0.035, 0.05);
    float trail = smoothstep(0.45, 0.95, r) * (1.0 - smoothstep(0.95, 0.99, r)) * 0.35;
    col = uColor * (ring + trail) + uHot * ring * 0.5;
  } else {
    float n = sin(a * 7.0 + sin(r * 11.0 + a * 3.0) * 0.6);
    float crack = pow(1.0 - abs(n), 28.0) * (1.0 - smoothstep(0.3, 1.0, r)) * step(0.08, r);
    float core = (1.0 - smoothstep(0.0, 0.35, r)) * 0.45;
    col = uColor * (crack + core) + uHot * crack * 0.35;
  }
  gl_FragColor = vec4(col, uOpacity);
}
`;

// Тёмная подложка под зоной (обычное смешивание) — повышает контраст на светлом камне.
const FS_UNDER = `
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * 1.12;
  float r = length(p);
  float inside = 1.0 - smoothstep(0.86, 1.0, r);
  gl_FragColor = vec4(0.012, 0.014, 0.02, inside * uOpacity);
}
`;

// Дорожка полёта orb: шевроны к цели, заполнение вдоль пути по прогрессу подготовки.
const FS_LANE = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uOpacity;
uniform float uProgress;
uniform float uTime;
uniform float uLength;
uniform float uWidth;
uniform float uFlash;
varying vec2 vUv;
${GLSL_BAND}
void main() {
  float x = vUv.x * 2.0 - 1.0;
  float d = vUv.y * uLength;
  float s = 0.08 / max(uWidth, 0.3);
  float ax = abs(x);
  float edge = band(ax, 0.9, 0.05, s);
  float inner = 1.0 - smoothstep(0.84, 0.9, ax);
  float ph = fract((d + ax * uWidth * 0.35) * 0.9 - uTime * (1.2 + 3.0 * uProgress));
  float chev = (smoothstep(0.0, 0.08, ph) - smoothstep(0.22, 0.3, ph)) * inner;
  float startFade = smoothstep(0.3, 1.6, d);
  float endFade = 1.0 - smoothstep(uLength - 2.6, uLength, d);
  float charged = 1.0 - smoothstep(uProgress * uLength - 0.4, uProgress * uLength, d);
  vec3 col = uColor * (edge * 0.9 + chev * 0.5 + inner * 0.06 + charged * inner * 0.1)
           + uHot * (edge * charged * 0.5 + uFlash * inner * 0.6);
  gl_FragColor = vec4(col, uOpacity * startFade * endFade);
}
`;

// Вертикальная кромка (nova, волна burst, фаза). Затухает кверху.
const FS_WALL = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
void main() {
  float h = vUv.y;
  float fade = (1.0 - h) * (1.0 - h);
  float scan = 0.7 + 0.3 * sin(h * 18.0 - uTime * 5.0);
  float bottom = 1.0 - smoothstep(0.0, 0.1, h);
  gl_FragColor = vec4(uColor * (fade * scan + bottom * 0.8), uOpacity);
}
`;

const VS_FRESNEL = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FS_FRESNEL = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPower;
uniform float uBase;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), uPower);
  gl_FragColor = vec4(uColor * (f + uBase), uOpacity);
}
`;

// Знак щита: кольцо рун, треугольный сигил, почти прозрачный центр, рябь от блока.
const FS_DISK = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uOpacity;
uniform float uTime;
uniform float uFlash;
uniform vec3 uRipple;
varying vec2 vUv;
${GLSL_BAND}
float h1(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x + 1e-5);
  float s = 0.018;
  float outer = band(r, 0.93, 0.02, s) + band(r, 0.985, 0.006, s) * 0.5;
  float inner = band(r, 0.70, 0.008, s);
  float seg = (a + uTime * 0.35) / 6.2831853 * 14.0;
  float k = mod(floor(seg), 14.0);
  float u = fract(seg);
  float v = (r - 0.74) / 0.15;
  float glyph = 0.0;
  if (v > 0.0 && v < 1.0 && u > 0.2 && u < 0.8) {
    float gu = (u - 0.2) / 0.6;
    float hA = h1(k);
    float hB = h1(k + 17.0);
    float hC = h1(k + 31.0);
    float stem = band(gu, 0.5, 0.07, 0.05) * step(0.3, hA);
    float bar = band(v, mix(0.25, 0.75, step(0.5, hB)), 0.07, 0.05) * step(0.25, hB);
    float dir = hC > 0.5 ? 1.0 : -1.0;
    float diag = band(gu - 0.5, (v - 0.5) * dir, 0.07, 0.05) * step(0.45, hC);
    glyph = clamp(stem + bar + diag, 0.0, 1.0);
  }
  float chords = 0.0;
  for (int i = 0; i < 3; i++) {
    float ang = float(i) * 2.0943951 - uTime * 0.15;
    vec2 nrm = vec2(cos(ang), sin(ang));
    chords += band(dot(p, nrm), 0.35, 0.006, 0.012);
  }
  chords *= 1.0 - smoothstep(0.66, 0.70, r);
  float fillv = 0.035 + 0.12 * smoothstep(0.2, 0.7, r);
  float ripple = 0.0;
  if (uRipple.z < 1.0) {
    float d = length(p - uRipple.xy);
    ripple = band(d, uRipple.z * 1.4, 0.04, 0.05) * (1.0 - uRipple.z);
  }
  vec3 col = uColor * (outer * 1.1 + inner * 0.55 + glyph * 0.7 + chords * 0.35 + fillv)
           + uHot * (ripple * 1.2 + uFlash * (outer * 0.8 + glyph * 0.6 + 0.1));
  gl_FragColor = vec4(col, uOpacity);
}
`;

// Частицы: размер в мировых единицах с перспективой, цвет+альфа на вершину.
const VS_PARTICLE = `
attribute float aSize;
attribute vec4 aColor;
uniform float uViewportH;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.05);
  gl_PointSize = (aColor.a <= 0.002) ? 0.0 : clamp(px, 1.0, 72.0);
}
`;

const FS_PARTICLE_GLOW = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = 1.0 - d;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a * a);
}
`;

const FS_PARTICLE_DUST = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(0.35, 1.0, d)));
}
`;



// ------------------------------------------------------------------ utils

function makeDataTexture(THREE, size, fn) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(fn(u, v)) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function makeLaneGeometry(THREE) {
  // Локально: x поперёк (-0.5..0.5), z вдоль (0..1), uv.y = доля длины.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeBoundingSphere();
  return g;
}

function makePool(max, factory, hide) {
  const items = [];
  return {
    items,
    acquire() {
      for (let i = 0; i < items.length; i++) if (!items[i].active) { items[i].active = true; return items[i]; }
      if (items.length < max) { const it = factory(); items.push(it); it.active = true; return it; }
      // Пул полон: забираем самый «старый» по доле прожитого времени.
      let best = items[0], bestAge = -1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const age = it.dur > 0 ? it.t / it.dur : 1;
        if (age > bestAge) { bestAge = age; best = it; }
      }
      hide(best);
      best.active = true;
      return best;
    },
    each(fn) { for (let i = 0; i < items.length; i++) if (items[i].active) fn(items[i]); },
    activeCount() { let n = 0; for (let i = 0; i < items.length; i++) if (items[i].active) n++; return n; },
    releaseAll() { for (let i = 0; i < items.length; i++) { items[i].active = false; hide(items[i]); } },
  };
}

// ================================================================== createEffects

export function createEffects({ THREE, scene, camera, renderer, config } = {}) {
  if (!THREE || typeof THREE.Group !== 'function') throw new Error('[effects] THREE обязателен (передайте модуль three)');
  if (!scene || typeof scene.add !== 'function') throw new Error('[effects] scene обязателен');

  const cfg = config && typeof config === 'object' ? config : {};
  const eff0 = cfg.effects && typeof cfg.effects === 'object' ? cfg.effects : {};

  const GROUND_Y = num(eff0.groundY, 0);
  const CHEST_H = num(eff0.heroChestHeight, 1.2);
  const HAND_H = num(eff0.heroHandHeight, 1.45);
  const HERO_H = num(eff0.heroHeight, 1.8);
  const BOSS_CORE_H = num(eff0.bossCoreHeight, 2.6);
  const SHIELD_FWD = num(eff0.shieldForward, 0.85);
  const SHIELD_R = num(eff0.shieldRadius, 0.95);
  const ORB_CHARGE_FWD = num(eff0.orbChargeForward, 0.9); // заряд orb выносится из тела босса к цели
  const IMPULSE_SCALE = clamp(num(eff0.cameraImpulseScale, 1), 0, 2);
  const DEBUG = !!eff0.debug;

  const V3 = THREE.Vector3;
  const Z_AXIS = new V3(0, 0, 1);
  // Скретч-векторы разделены по уровням, чтобы вложенные вызовы не портили друг другу данные.
  const _h1 = new V3(), _h2 = new V3();                      // внутри примитивов (sparks, flash)
  const _p = new V3(), _q = new V3(), _r = new V3(), _dir = new V3(); // обработчики событий
  const _s1 = new V3(), _s2 = new V3();                      // sync-функции
  const _t1 = new V3(), _t2 = new V3(), _t3 = new V3();      // шлейфы
  const _cam = new V3(), _pan = new V3();

  let disposed = false;
  let qualityName = 'medium';
  let Q = QUALITY_PRESETS.medium;
  let reducedMotionOverride = null;
  let clock = 0;
  let lastDt = 1 / 60;
  let snap = null;
  const warned = new Set();
  const stats = { events: 0, duplicates: 0, errors: 0 };

  function warnOnce(key, ...args) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn('[effects]', ...args);
  }
  function liveSetting(key) {
    const e = cfg.effects;
    if (e && typeof e === 'object' && e[key] !== undefined) return e[key];
    const s = cfg.settings;
    if (s && typeof s === 'object' && s[key] !== undefined) return s[key];
    return cfg[key];
  }
  function reducedMotion() {
    if (reducedMotionOverride !== null) return reducedMotionOverride;
    return !!liveSetting('reducedMotion');
  }
  function impulseAllowed() {
    const e = cfg.effects;
    if (e && typeof e === 'object' && e.cameraImpulse === false) return false;
    return !reducedMotion();
  }

  // ---------------------------------------------------------------- root, общие ресурсы
  const root = new THREE.Group();
  root.name = 'ashen-effects-root';
  scene.add(root);

  const geo = {
    flat: new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
    disk: new THREE.PlaneGeometry(2, 2),
    sphere: new THREE.SphereGeometry(1, 16, 12),
    ico: new THREE.IcosahedronGeometry(1, 1),
    wall: new THREE.CylinderGeometry(1, 1, 1, 56, 1, true).translate(0, 0.5, 0),
    lane: makeLaneGeometry(THREE),
    ghostBody: new THREE.ConeGeometry(0.42, 1.45, 14, 1, true).translate(0, 0.725, 0),
    ghostHead: new THREE.SphereGeometry(0.21, 12, 10).translate(0, 1.56, 0.04),
  };

  const TEX = {
    glow: makeDataTexture(THREE, 64, (u, v) => Math.pow(Math.max(0, 1 - Math.hypot(u, v)), 2.2)),
    flare: makeDataTexture(THREE, 128, (u, v) => {
      const d = Math.hypot(u, v);
      const core = Math.pow(Math.max(0, 1 - d), 3);
      const rays = (Math.exp(-Math.abs(u) * 18) * (1 - Math.abs(v)) + Math.exp(-Math.abs(v) * 18) * (1 - Math.abs(u)))
        * 0.55 * Math.max(0, 1 - d * 0.9);
      return core + rays;
    }),
  };

  const colorU = () => ({ value: new THREE.Color(1, 1, 1) });
  const tpl = {
    zone: new THREE.ShaderMaterial({
      uniforms: {
        uColor: colorU(), uHot: colorU(), uOpacity: { value: 1 }, uProgress: { value: 0 }, uTime: { value: 0 },
        uMode: { value: 0 }, uBlockable: { value: 1 }, uFlash: { value: 0 }, uRadius: { value: 1 },
      },
      vertexShader: VS_UV, fragmentShader: FS_ZONE,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    under: new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.4 } },
      vertexShader: VS_UV, fragmentShader: FS_UNDER,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    lane: new THREE.ShaderMaterial({
      uniforms: {
        uColor: colorU(), uHot: colorU(), uOpacity: { value: 1 }, uProgress: { value: 0 }, uTime: { value: 0 },
        uLength: { value: 6 }, uWidth: { value: 1 }, uFlash: { value: 0 },
      },
      vertexShader: VS_UV, fragmentShader: FS_LANE,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    wall: new THREE.ShaderMaterial({
      uniforms: { uColor: colorU(), uOpacity: { value: 0.3 }, uTime: { value: 0 } },
      vertexShader: VS_UV, fragmentShader: FS_WALL,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
    fresnel: new THREE.ShaderMaterial({
      uniforms: { uColor: colorU(), uOpacity: { value: 0.4 }, uPower: { value: 2.0 }, uBase: { value: 0.03 } },
      vertexShader: VS_FRESNEL, fragmentShader: FS_FRESNEL,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide, blending: THREE.AdditiveBlending,
    }),
    disk: new THREE.ShaderMaterial({
      uniforms: {
        uColor: colorU(), uHot: colorU(), uOpacity: { value: 0 }, uTime: { value: 0 }, uFlash: { value: 0 },
        uRipple: { value: new THREE.Vector3(0, 0, 1) },
      },
      vertexShader: VS_UV, fragmentShader: FS_DISK,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  };
  const setRaw = (color, raw) => color.setRGB(raw[0], raw[1], raw[2]);

  function basicMat(hex, opacity, extra) {
    return new THREE.MeshBasicMaterial(Object.assign({
      color: hex, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false,
    }, extra || {}));
  }
  function spriteMat(tex, hex, opacity) {
    return new THREE.SpriteMaterial({
      map: tex, color: hex, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false,
    });
  }

  // Линейные цвета для vertexColors (MeshBasicMaterial сам переводит результат в sRGB).
  const LIN = { bolt: new THREE.Color(PAL.heroAmber), orb: new THREE.Color(PAL.guardCold) };

  const projMat = {
    boltCore: basicMat(PAL.heroCore, 0.95),
    orbCore: basicMat(PAL.guardCold, 0.75),
    orbShell: basicMat(PAL.guardCold, 0.42, { wireframe: true }),
    boltHalo: spriteMat(TEX.glow, PAL.heroAmber, 0.85),
    orbHalo: spriteMat(TEX.glow, PAL.guardDeep, 0.6),
    ribbon: new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false, fog: false,
    }),
  };

  // ---------------------------------------------------------------- свет сильного события
  // r155+: физически корректные источники по умолчанию. Свойство renderer.useLegacyLights там НЕ читаем:
  // в r155–r164 это устаревший геттер с предупреждением. Если сборщик включил legacy-режим — config.effects.legacyLights.
  const rev = parseInt(THREE.REVISION, 10) || 0;
  let legacyLights;
  if (typeof eff0.legacyLights === 'boolean') legacyLights = eff0.legacyLights;
  else if (rev >= 155 || rev === 0) legacyLights = false;
  else if (rev >= 150) legacyLights = !(renderer && renderer.useLegacyLights === false);
  else legacyLights = !(renderer && renderer.physicallyCorrectLights === true);
  const LIGHT_UNIT = num(eff0.lightIntensityScale, legacyLights ? 1.8 : 30);

  const flashLight = new THREE.PointLight(PAL.heroAmber, 0, 14, 2);
  flashLight.castShadow = false;
  flashLight.name = 'ashen-effects-flash-light';
  root.add(flashLight);
  const L = { t: 1, dur: 1, peak: 0 };

  function lightFlash(pos, hex, strength, dur) {
    if (!Q.light) return;
    const peak = strength * LIGHT_UNIT;
    if (L.t < L.dur && flashLight.intensity > peak * 0.8) return; // не перебиваем более сильную вспышку
    flashLight.position.set(pos.x, pos.y + 0.4, pos.z);
    flashLight.color.setHex(hex);
    L.t = 0; L.dur = Math.max(0.05, dur); L.peak = peak;
  }
  function updateLight(dt) {
    if (L.t >= L.dur) { flashLight.intensity = 0; return; }
    L.t += dt;
    const k = clamp01(L.t / L.dur);
    flashLight.intensity = L.peak * (k < 0.06 ? k / 0.06 : Math.pow(1 - (k - 0.06) / 0.94, 2));
  }

  // ---------------------------------------------------------------- камера (только чтение)
  function cameraPos(out) {
    if (camera && camera.matrixWorld) {
      const e = camera.matrixWorld.elements;
      return out.set(e[12], e[13], e[14]);
    }
    return out.set(0, 3, 10);
  }
  function cameraRight(out) {
    if (camera && camera.matrixWorld) {
      const e = camera.matrixWorld.elements;
      out.set(e[0], e[1], e[2]);
      if (out.lengthSq() > 1e-8) return out.normalize();
    }
    return out.set(1, 0, 0);
  }
  function viewportAspect() {
    const el = renderer && renderer.domElement;
    if (el && el.width > 0 && el.height > 0) return el.width / el.height;
    return 16 / 9;
  }
  function panFor(pos) {
    if (!pos || !camera || !camera.matrixWorldInverse) return 0;
    _pan.set(pos.x, pos.y, pos.z).applyMatrix4(camera.matrixWorldInverse);
    const z = Math.max(1, -_pan.z);
    return clamp((_pan.x / z) * 0.9, -0.75, 0.75);
  }
  function distGain(pos) {
    if (!pos) return 1;
    cameraPos(_cam);
    const d = Math.hypot(pos.x - _cam.x, pos.y - _cam.y, pos.z - _cam.z);
    return clamp(1.25 - d / 22, 0.55, 1);
  }

  // ---------------------------------------------------------------- снимок: опорные точки
  const fi = {
    has: false, status: 'none',
    player: new V3(0, 0, 6), boss: new V3(0, 0, 0),
    fwd: new V3(0, 0, -1), right: new V3(1, 0, 0),
  };
  function updateFrameInfo(s) {
    if (!s) { fi.has = false; fi.status = 'none'; return; }
    fi.has = true;
    fi.status = typeof s.status === 'string' ? s.status : 'playing';
    const pl = s.player, bo = s.boss;
    if (pl && hasVec(pl.position)) fi.player.set(pl.position.x, pl.position.y, pl.position.z);
    if (bo && hasVec(bo.position)) fi.boss.set(bo.position.x, bo.position.y, bo.position.z);
    let fx = fi.boss.x - fi.player.x, fz = fi.boss.z - fi.player.z;
    const len = Math.hypot(fx, fz);
    if (len > 1e-3) {
      fx /= len; fz /= len;
      fi.fwd.set(fx, 0, fz);
      fi.right.set(-fz, 0, fx); // правая сторона экрана при камере за спиной героя
    }
  }
  const chestOf = (out) => out.set(fi.player.x, fi.player.y + CHEST_H, fi.player.z);
  const handOf = (out, side) => out.set(
    fi.player.x + fi.right.x * 0.36 * side + fi.fwd.x * 0.42,
    fi.player.y + HAND_H,
    fi.player.z + fi.right.z * 0.36 * side + fi.fwd.z * 0.42,
  );
  const bossCoreOf = (out) => out.set(fi.boss.x, fi.boss.y + BOSS_CORE_H, fi.boss.z);
  const playerGround = (out) => out.set(fi.player.x, GROUND_Y, fi.player.z);
  function evPos(ev, out, fallback) {
    if (ev && hasVec(ev.position)) return out.set(ev.position.x, ev.position.y, ev.position.z);
    return fallback(out);
  }
  function toCamDir(p, out) {
    cameraPos(_cam);
    out.set(_cam.x - p.x, _cam.y - p.y, _cam.z - p.z);
    if (out.lengthSq() < 1e-8) return out.set(0, 1, 0);
    return out.normalize();
  }

  // ---------------------------------------------------------------- частицы
  function createParticlePool(max, additive, renderOrder) {
    const pos = new Float32Array(max * 3), col = new Float32Array(max * 4), siz = new Float32Array(max);
    const vel = new Float32Array(max * 3), life = new Float32Array(max), maxLife = new Float32Array(max);
    const s0 = new Float32Array(max), s1 = new Float32Array(max), rgb = new Float32Array(max * 3);
    const a0 = new Float32Array(max), drag = new Float32Array(max), grav = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    const pA = new THREE.BufferAttribute(pos, 3), cA = new THREE.BufferAttribute(col, 4), sA = new THREE.BufferAttribute(siz, 1);
    pA.setUsage(THREE.DynamicDrawUsage); cA.setUsage(THREE.DynamicDrawUsage); sA.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pA); g.setAttribute('aColor', cA); g.setAttribute('aSize', sA);
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 720 } },
      vertexShader: VS_PARTICLE,
      fragmentShader: additive ? FS_PARTICLE_GLOW : FS_PARTICLE_DUST,
      transparent: true, depthWrite: false, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(g, mat);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    points.name = additive ? 'ashen-fx-glow' : 'ashen-fx-dust';
    root.add(points);
    let count = 0, cap = max, cursor = 0, dirty = true;

    function copy(from, to) {
      const f3 = from * 3, t3 = to * 3, f4 = from * 4, t4 = to * 4;
      pos[t3] = pos[f3]; pos[t3 + 1] = pos[f3 + 1]; pos[t3 + 2] = pos[f3 + 2];
      vel[t3] = vel[f3]; vel[t3 + 1] = vel[f3 + 1]; vel[t3 + 2] = vel[f3 + 2];
      rgb[t3] = rgb[f3]; rgb[t3 + 1] = rgb[f3 + 1]; rgb[t3 + 2] = rgb[f3 + 2];
      col[t4] = col[f4]; col[t4 + 1] = col[f4 + 1]; col[t4 + 2] = col[f4 + 2]; col[t4 + 3] = col[f4 + 3];
      life[to] = life[from]; maxLife[to] = maxLife[from]; s0[to] = s0[from]; s1[to] = s1[from];
      a0[to] = a0[from]; drag[to] = drag[from]; grav[to] = grav[from]; siz[to] = siz[from];
    }
    return {
      points, mat, geometry: g,
      get count() { return count; },
      setCap(c) { cap = clamp(Math.floor(c), 0, max); },
      // essential=true: частица попадания/опасности, при заполненном пуле перезаписывает другую.
      spawn(px, py, pz, vx, vy, vz, lf, sa, sb, c, alpha, dr, gr, essential) {
        let i;
        if (count < cap) i = count++;
        else if (essential && count > 0) { i = cursor % count; cursor++; }
        else return false;
        const i3 = i * 3;
        pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;
        vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
        rgb[i3] = c[0]; rgb[i3 + 1] = c[1]; rgb[i3 + 2] = c[2];
        life[i] = Math.max(0.02, lf); maxLife[i] = life[i];
        s0[i] = sa; s1[i] = sb; a0[i] = alpha; drag[i] = dr; grav[i] = gr;
        col[i * 4 + 3] = 0; siz[i] = sa;
        dirty = true;
        return true;
      },
      update(dt) {
        if (count === 0 && !dirty) return;
        let i = 0;
        while (i < count) {
          life[i] -= dt;
          if (life[i] <= 0) { count--; if (i !== count) copy(count, i); continue; }
          const k = i * 3;
          if (dt > 0) {
            const damp = drag[i] > 0 ? Math.exp(-drag[i] * dt) : 1;
            vel[k] *= damp; vel[k + 1] = vel[k + 1] * damp - grav[i] * dt; vel[k + 2] *= damp;
            pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt; pos[k + 2] += vel[k + 2] * dt;
            if (grav[i] > 0 && pos[k + 1] < GROUND_Y + 0.02) {
              pos[k + 1] = GROUND_Y + 0.02;
              if (vel[k + 1] < 0) vel[k + 1] *= -0.28;
              vel[k] *= 0.6; vel[k + 2] *= 0.6;
            }
          }
          const t = 1 - life[i] / maxLife[i];
          const fin = t < 0.08 ? t / 0.08 : 1;
          const a = a0[i] * fin * Math.pow(1 - t, 1.3);
          const c4 = i * 4;
          col[c4] = rgb[k]; col[c4 + 1] = rgb[k + 1]; col[c4 + 2] = rgb[k + 2]; col[c4 + 3] = a;
          siz[i] = s0[i] + (s1[i] - s0[i]) * t;
          i++;
        }
        g.setDrawRange(0, count);
        pA.needsUpdate = true; cA.needsUpdate = true; sA.needsUpdate = true;
        dirty = count > 0;
      },
      clear() { count = 0; cursor = 0; g.setDrawRange(0, 0); dirty = false; },
    };
  }
  const glow = createParticlePool(MAX_GLOW, true, 24);
  const dust = createParticlePool(MAX_DUST, false, 18);

  function randomDir(out) {
    const u = Math.random() * 2 - 1, th = Math.random() * TAU, s = Math.sqrt(1 - u * u);
    return out.set(s * Math.cos(th), u, s * Math.sin(th));
  }

  /**
   * Выброс частиц. o: {pool, dir, count, spread, speed:[a,b], rgb, life, size, sizeEnd,
   *   essential, gravity, drag, alpha, jitter, flat}
   * Декоративное количество умножается на Q.decor; essential — нет.
   */
  function sparks(pos, o) {
    const pool = o.pool || glow;
    const n = o.essential ? Math.round(o.count) : Math.round(o.count * Q.decor);
    const sp = o.speed || [1, 3];
    const spread = o.spread ?? 0.6;
    const size = o.size ?? 0.06;
    const life = o.life ?? 0.5;
    const jitter = o.jitter ?? 0;
    for (let i = 0; i < n; i++) {
      randomDir(_h1);
      if (o.flat) { _h1.y *= 0.15; }
      if (o.dir) {
        _h1.multiplyScalar(spread).add(o.dir);
        if (_h1.lengthSq() < 1e-6) _h1.copy(o.dir);
      }
      _h1.normalize();
      const v = lerp(sp[0], sp[1], Math.random());
      const lf = life * (0.7 + Math.random() * 0.6);
      const sz = size * (0.7 + Math.random() * 0.6);
      const jx = jitter ? (Math.random() * 2 - 1) * jitter : 0;
      const jy = jitter ? (Math.random() * 2 - 1) * jitter : 0;
      const jz = jitter ? (Math.random() * 2 - 1) * jitter : 0;
      pool.spawn(pos.x + jx, pos.y + jy, pos.z + jz, _h1.x * v, _h1.y * v, _h1.z * v, lf, sz,
        o.sizeEnd ?? sz * 0.3, o.rgb || RAW.heroAmber, o.alpha ?? 1, o.drag ?? 2, o.gravity ?? 0, !!o.essential);
    }
  }
  // Частица, которая за время life прилетает в центр (сбор энергии).
  function gatherMote(center, rgb, rMin, rMax, life, size, essential) {
    randomDir(_h2);
    const rr = lerp(rMin, rMax, Math.random());
    const px = center.x + _h2.x * rr, py = center.y + _h2.y * rr * 0.7, pz = center.z + _h2.z * rr;
    const lf = life * (0.7 + Math.random() * 0.3);
    glow.spawn(px, py, pz, (center.x - px) / lf, (center.y - py) / lf, (center.z - pz) / lf,
      lf, size, size * 0.35, rgb, 0.9, 0, 0, essential);
  }

  // ---------------------------------------------------------------- пулы краткоживущих эффектов
  const hideObj = (it) => { it.obj.visible = false; };

  const flashPool = makePool(18, () => {
    const mat = new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, fog: false,
    });
    const obj = new THREE.Sprite(mat);
    obj.visible = false; obj.renderOrder = 25; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 1, s0: 0, s1: 1, sx: 1, op: 1 };
  }, hideObj);

  // o: {flare, opacity, rotation, stretch, pull}
  function fxFlash(pos, hex, s0, s1, dur, o) {
    const it = flashPool.acquire();
    it.t = 0; it.dur = Math.max(0.02, dur); it.s0 = s0; it.s1 = s1;
    it.sx = (o && o.stretch) || 1; it.op = (o && o.opacity) ?? 1;
    it.mat.map = o && o.flare ? TEX.flare : TEX.glow;
    it.mat.color.setHex(hex);
    it.mat.rotation = o && isNum(o.rotation) ? o.rotation : Math.random() * TAU;
    it.mat.opacity = 0;
    const pull = (o && o.pull) ?? 0.25; // чуть к камере, чтобы вспышку не съела геометрия
    toCamDir(pos, _h2);
    it.obj.position.set(pos.x + _h2.x * pull, pos.y + _h2.y * pull, pos.z + _h2.z * pull);
    it.obj.scale.set(s0 * it.sx, s0, 1);
    it.obj.visible = true;
    return it;
  }
  // Угол направления dir в экранной плоскости (для вытянутой направленной вспышки).
  function screenAngle(pos, dir) {
    if (!camera || !camera.projectionMatrix) return null;
    _h1.set(pos.x, pos.y, pos.z).project(camera);
    _h2.set(pos.x + dir.x, pos.y + dir.y, pos.z + dir.z).project(camera);
    const dx = (_h2.x - _h1.x) * viewportAspect(), dy = _h2.y - _h1.y;
    if (!isNum(dx) || !isNum(dy) || dx * dx + dy * dy < 1e-6) return null;
    return Math.atan2(dy, dx);
  }

  const groundPool = makePool(12, () => {
    const mat = tpl.zone.clone();
    const obj = new THREE.Mesh(geo.flat, mat);
    obj.visible = false; obj.renderOrder = 3; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 1, r0: 0, r1: 1, op: 1 };
  }, hideObj);
  function fxRing(pos, r0, r1, dur, colRaw, hotRaw, opacity, mode) {
    const it = groundPool.acquire();
    it.t = 0; it.dur = Math.max(0.05, dur); it.r0 = r0; it.r1 = r1; it.op = opacity;
    const u = it.mat.uniforms;
    setRaw(u.uColor.value, colRaw); setRaw(u.uHot.value, hotRaw);
    u.uMode.value = mode ?? 3; u.uOpacity.value = opacity; u.uProgress.value = 1; u.uFlash.value = 0;
    u.uRadius.value = Math.max(r1, 0.5); u.uBlockable.value = 1;
    it.obj.position.set(pos.x, GROUND_Y + 0.045, pos.z);
    it.obj.scale.set(r0 * 1.12, 1, r0 * 1.12);
    it.obj.visible = true;
    return it;
  }

  const wallPool = makePool(5, () => {
    const mat = tpl.wall.clone();
    const obj = new THREE.Mesh(geo.wall, mat);
    obj.visible = false; obj.renderOrder = 4; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 1, r0: 0, r1: 1, h: 1, op: 1 };
  }, hideObj);
  function fxWall(pos, r0, r1, h, dur, colRaw, opacity) {
    const it = wallPool.acquire();
    it.t = 0; it.dur = Math.max(0.05, dur); it.r0 = Math.max(0.05, r0); it.r1 = r1; it.h = h; it.op = opacity;
    setRaw(it.mat.uniforms.uColor.value, colRaw);
    it.mat.uniforms.uOpacity.value = opacity;
    it.obj.position.set(pos.x, GROUND_Y, pos.z);
    it.obj.scale.set(it.r0, h, it.r0);
    it.obj.visible = true;
    return it;
  }

  const shellPool = makePool(3, () => {
    const mat = tpl.fresnel.clone();
    const obj = new THREE.Mesh(geo.sphere, mat);
    obj.visible = false; obj.renderOrder = 6; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 1, s0: 0, s1: 1, op: 1 };
  }, hideObj);
  function fxShell(pos, s0, s1, dur, colRaw, opacity) {
    const it = shellPool.acquire();
    it.t = 0; it.dur = Math.max(0.05, dur); it.s0 = s0; it.s1 = s1; it.op = opacity;
    setRaw(it.mat.uniforms.uColor.value, colRaw);
    it.mat.uniforms.uPower.value = 2.2; it.mat.uniforms.uBase.value = 0.02; it.mat.uniforms.uOpacity.value = opacity;
    it.obj.position.set(pos.x, pos.y, pos.z);
    it.obj.scale.setScalar(Math.max(1e-3, s0));
    it.obj.visible = true;
    return it;
  }

  // Послеобраз рывка: стилизованный силуэт в капюшоне (конус плаща + голова), френель-свечение.
  const ghostPool = makePool(6, () => {
    const mat = tpl.fresnel.clone();
    mat.uniforms.uPower.value = 1.6; mat.uniforms.uBase.value = 0.08;
    setRaw(mat.uniforms.uColor.value, RAW.heroGold);
    const obj = new THREE.Group();
    const body = new THREE.Mesh(geo.ghostBody, mat);
    const head = new THREE.Mesh(geo.ghostHead, mat);
    body.renderOrder = 5; head.renderOrder = 5;
    obj.add(body, head);
    obj.visible = false; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 0.34, op: 0.55 };
  }, hideObj);
  function fxGhost(pos, yaw) {
    const it = ghostPool.acquire();
    it.t = 0; it.dur = 0.34; it.op = 0.55;
    it.obj.position.set(pos.x, pos.y, pos.z);
    it.obj.rotation.set(0, yaw, 0);
    const s = HERO_H / 1.8;
    it.obj.scale.set(s, s, s);
    it.mat.uniforms.uOpacity.value = it.op;
    it.obj.visible = true;
  }

  function updateTransients(dt) {
    flashPool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; return; }
      const s = lerp(it.s0, it.s1, easeOutCubic(k));
      it.obj.scale.set(s * it.sx, s, 1);
      it.mat.opacity = it.op * (k < 0.1 ? k / 0.1 : Math.pow(1 - (k - 0.1) / 0.9, 1.6));
    });
    groundPool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; return; }
      const r = Math.max(1e-3, lerp(it.r0, it.r1, easeOutCubic(k)));
      it.obj.scale.set(r * 1.12, 1, r * 1.12);
      const u = it.mat.uniforms;
      u.uOpacity.value = it.op * Math.pow(1 - k, 1.4);
      u.uTime.value = clock;
      u.uRadius.value = Math.max(r, 0.5);
    });
    wallPool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; return; }
      const r = Math.max(0.05, lerp(it.r0, it.r1, easeOutCubic(k)));
      it.obj.scale.set(r, it.h * (1 - 0.35 * k), r);
      it.mat.uniforms.uOpacity.value = it.op * Math.pow(1 - k, 1.5);
      it.mat.uniforms.uTime.value = clock;
    });
    shellPool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; return; }
      it.obj.scale.setScalar(Math.max(1e-3, lerp(it.s0, it.s1, easeOutCubic(k))));
      it.mat.uniforms.uOpacity.value = it.op * Math.pow(1 - k, 1.5);
    });
    ghostPool.each((it) => {
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; return; }
      it.mat.uniforms.uOpacity.value = it.op * Math.pow(1 - k, 1.6);
      const s = (HERO_H / 1.8) * (1 + 0.04 * k);
      it.obj.scale.set(s, s, s);
    });
  }

  // ---------------------------------------------------------------- импульс камеры
  const imp = { trauma: 0, kick: new V3(), kvel: new V3(), out: new V3(), seed: Math.random() * 100 };
  const OMEGA = 13.4;
  function addTrauma(v) { if (impulseAllowed()) imp.trauma = Math.min(1, imp.trauma + v); }
  function addKick(dir, disp) { if (impulseAllowed()) imp.kvel.addScaledVector(dir, disp * OMEGA); }
  function updateImpulse(dt) {
    if (!impulseAllowed()) {
      imp.trauma = 0; imp.kick.set(0, 0, 0); imp.kvel.set(0, 0, 0); imp.out.set(0, 0, 0);
      return;
    }
    if (dt > 0) {
      imp.trauma = Math.max(0, imp.trauma - dt * 1.7);
      const k = OMEGA * OMEGA, c = 2 * OMEGA * 0.85;
      imp.kvel.x += (-k * imp.kick.x - c * imp.kvel.x) * dt;
      imp.kvel.y += (-k * imp.kick.y - c * imp.kvel.y) * dt;
      imp.kvel.z += (-k * imp.kick.z - c * imp.kvel.z) * dt;
      imp.kick.addScaledVector(imp.kvel, dt);
    }
    const tt = clock + imp.seed;
    const amp = 0.085 * imp.trauma * imp.trauma;
    const nx = Math.sin(tt * 31.7) * 0.5 + Math.sin(tt * 17.3 + 1.3) * 0.3 + Math.sin(tt * 53.1 + 2.1) * 0.2;
    const ny = Math.sin(tt * 27.1 + 0.7) * 0.5 + Math.sin(tt * 19.9 + 2.9) * 0.3 + Math.sin(tt * 47.3 + 4.1) * 0.2;
    const nz = Math.sin(tt * 23.3 + 3.3) * 0.6 + Math.sin(tt * 41.7 + 1.1) * 0.4;
    imp.out.set(imp.kick.x + nx * amp, imp.kick.y + ny * amp * 0.8, imp.kick.z + nz * amp * 0.5)
      .multiplyScalar(IMPULSE_SCALE);
    const len = imp.out.length();
    if (len > IMPULSE_MAX) imp.out.multiplyScalar(IMPULSE_MAX / len);
    if (!isNum(imp.out.x) || !isNum(imp.out.y) || !isNum(imp.out.z)) imp.out.set(0, 0, 0);
  }

  // ---------------------------------------------------------------- звук
  const initialVolume = clamp01(num(liveSetting('volume'), 0.8));
  const audio = createAudioEngine({
    panFor, distGain,
    volume: initialVolume,
    maxVoices: clamp(Math.floor(num(eff0.maxVoices, 20)), 6, 48),
    warnOnce,
  });

  // ---------------------------------------------------------------- щит
  const diskMat = tpl.disk.clone();
  setRaw(diskMat.uniforms.uColor.value, RAW.heroAmber);
  setRaw(diskMat.uniforms.uHot.value, RAW.heroCore);
  const diskMesh = new THREE.Mesh(geo.disk, diskMat);
  diskMesh.visible = false; diskMesh.renderOrder = 7; root.add(diskMesh);
  const shellMat = tpl.fresnel.clone();
  setRaw(shellMat.uniforms.uColor.value, RAW.heroGold);
  shellMat.uniforms.uPower.value = 2.6; shellMat.uniforms.uBase.value = 0.015;
  const shellMesh = new THREE.Mesh(geo.sphere, shellMat);
  shellMesh.visible = false; shellMesh.renderOrder = 6; root.add(shellMesh);
  const shield = { open: 0, on: false, flash: 0, rippleT: 1, rx: 0, ry: 0 };

  function shieldCenter(out) {
    return out.set(fi.player.x + fi.fwd.x * SHIELD_FWD, fi.player.y + CHEST_H + 0.05, fi.player.z + fi.fwd.z * SHIELD_FWD);
  }
  function syncShield(dt) {
    const pl = snap && snap.player;
    const want = !!(pl && pl.shielding === true && fi.status === 'playing' && pl.action !== 'dead');
    if (want !== shield.on) {
      shield.on = want;
      audio.play(want ? 'shieldUp' : 'shieldDown', chestOf(_s1));
    }
    const target = want ? 1 : 0;
    if (dt > 0) {
      const rate = want ? dt / 0.14 : dt / 0.2;
      shield.open = target > shield.open ? Math.min(target, shield.open + rate) : Math.max(target, shield.open - rate);
      shield.flash = Math.max(0, shield.flash - dt * 4);
      if (shield.rippleT < 1) shield.rippleT = Math.min(1, shield.rippleT + dt / 0.35);
    }
    if (want) audio.loop('shield-hum', 'shieldHum', chestOf(_s1));
    else audio.loopStop('shield-hum');
    const vis = shield.open > 0.001 || shield.flash > 0.01;
    diskMesh.visible = vis;
    shellMesh.visible = vis && Q.shell;
    if (!vis) return;
    const e = easeOutCubic(shield.open);
    shieldCenter(_s2);
    diskMesh.position.copy(_s2);
    diskMesh.rotation.set(0, Math.atan2(fi.fwd.x, fi.fwd.z), 0);
    const s = SHIELD_R * (0.55 + 0.45 * Math.max(e, shield.flash * 0.8));
    diskMesh.scale.set(s, s, 1);
    const du = diskMat.uniforms;
    du.uOpacity.value = Math.max(shield.open, shield.flash * 0.8);
    du.uTime.value = clock;
    du.uFlash.value = shield.flash;
    du.uRipple.value.set(shield.rx, shield.ry, shield.rippleT);
    if (shellMesh.visible) {
      shellMesh.position.set(fi.player.x, fi.player.y + 1.0, fi.player.z);
      shellMesh.scale.setScalar(1.25 * (0.8 + 0.2 * e));
      shellMat.uniforms.uOpacity.value = 0.32 * shield.open + shield.flash * 0.3;
    }
  }

  // ---------------------------------------------------------------- снаряды
  const projMap = new Map();
  const projItems = [];
  let projTag = 0;

  function makeProjVisual() {
    const core = new THREE.Mesh(geo.sphere, projMat.boltCore); core.renderOrder = 22;
    const shell = new THREE.Mesh(geo.ico, projMat.orbShell); shell.renderOrder = 22;
    const halo = new THREE.Sprite(projMat.boltHalo); halo.renderOrder = 23;
    const rPos = new Float32Array(TRAIL_MAX * 2 * 3), rCol = new Float32Array(TRAIL_MAX * 2 * 3);
    const idx = [];
    for (let i = 0; i < TRAIL_MAX - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const rGeo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(rPos, 3), ca = new THREE.BufferAttribute(rCol, 3);
    pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage);
    rGeo.setAttribute('position', pa); rGeo.setAttribute('color', ca);
    rGeo.setIndex(idx); rGeo.setDrawRange(0, 0);
    const ribbon = new THREE.Mesh(rGeo, projMat.ribbon);
    ribbon.frustumCulled = false; ribbon.renderOrder = 21;
    for (const o of [core, shell, halo, ribbon]) { o.visible = false; root.add(o); }
    return {
      core, shell, halo, ribbon, rGeo, rPos, rCol,
      hist: new Float32Array(TRAIL_MAX * 4), histN: 0,
      active: false, id: null, owner: 'player', kind: 'bolt', radius: 0.2,
      pos: new V3(), vel: new V3(), lastT: -Infinity, sparkAcc: 0, tag: 0, spin: Math.random() * TAU,
    };
  }
  function acquireProj() {
    for (let i = 0; i < projItems.length; i++) if (!projItems[i].active) return projItems[i];
    if (projItems.length < PROJ_CAP) { const v = makeProjVisual(); projItems.push(v); return v; }
    return null;
  }
  function pushHist(v, x, y, z, t) {
    const h = v.hist;
    const n = Math.min(v.histN, TRAIL_MAX - 1);
    for (let i = n; i > 0; i--) {
      const a = i * 4, b = a - 4;
      h[a] = h[b]; h[a + 1] = h[b + 1]; h[a + 2] = h[b + 2]; h[a + 3] = h[b + 3];
    }
    h[0] = x; h[1] = y; h[2] = z; h[3] = t;
    v.histN = n + 1;
  }
  function initProj(v, key, pr, sTime) {
    v.active = true; v.id = key; v.tag = 0; v.sparkAcc = 0; v.histN = 0; v.lastT = -Infinity;
    v.owner = pr.owner === 'boss' ? 'boss' : 'player';
    v.kind = pr.kind === 'orb' || pr.kind === 'bolt' ? pr.kind : (v.owner === 'boss' ? 'orb' : 'bolt');
    const orb = v.kind === 'orb';
    v.core.material = orb ? projMat.orbCore : projMat.boltCore;
    v.halo.material = orb ? projMat.orbHalo : projMat.boltHalo;
    v.core.quaternion.identity();
    v.shell.visible = orb;
    v.core.visible = true; v.halo.visible = true;
    v.pos.set(pr.position.x, pr.position.y, pr.position.z);
    if (hasVec(pr.velocity)) v.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else v.vel.set(0, 0, 0);
    // Короткий «засеянный» хвост, чтобы шлейф был виден с первого кадра.
    const back = orb ? 0.06 : 0.04;
    pushHist(v, v.pos.x - v.vel.x * back, v.pos.y - v.vel.y * back, v.pos.z - v.vel.z * back, sTime - back);
  }
  function releaseProj(v, allowFizzle) {
    if (allowFizzle && fi.status === 'playing' && !impactNear(v.pos, v.id)) {
      // Снаряд исчез без события попадания (истёк/вылетел) — маленькое угасание, не «удар».
      const rgb = v.owner === 'boss' ? RAW.guardCold : RAW.heroAmber;
      sparks(v.pos, { count: 6, speed: [0.3, 1.2], rgb, life: 0.35, size: 0.05, drag: 3 });
      fxFlash(v.pos, v.owner === 'boss' ? PAL.guardCold : PAL.heroAmber, v.radius * 2, v.radius * 3.5, 0.18, { opacity: 0.5 });
    }
    if (v.kind === 'orb') audio.loopStop('orb:' + v.id);
    v.active = false; v.id = null;
    v.core.visible = false; v.shell.visible = false; v.halo.visible = false; v.ribbon.visible = false;
    v.rGeo.setDrawRange(0, 0);
  }
  function buildRibbon(v, sTime, trailTime, width, lc) {
    const h = v.hist;
    const maxPts = Math.min(v.histN, Q.trailPts, TRAIL_MAX);
    let n = 0;
    for (let i = 0; i < maxPts; i++) {
      if (i > 1 && sTime - h[i * 4 + 3] > trailTime) break;
      n++;
    }
    if (n < 2) { v.ribbon.visible = false; return; }
    const P = v.rPos, C = v.rCol;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1) * 4, i1 = Math.min(n - 1, i + 1) * 4, ic = i * 4;
      _t1.set(h[i0] - h[i1], h[i0 + 1] - h[i1 + 1], h[i0 + 2] - h[i1 + 2]);
      _t2.set(_cam.x - h[ic], _cam.y - h[ic + 1], _cam.z - h[ic + 2]);
      _t3.crossVectors(_t1, _t2);
      if (_t3.lengthSq() < 1e-10) _t3.set(0, 1, 0);
      const u = i / (n - 1);
      _t3.normalize().multiplyScalar(width * (1 - 0.85 * u));
      const k = i * 6;
      P[k] = h[ic] + _t3.x; P[k + 1] = h[ic + 1] + _t3.y; P[k + 2] = h[ic + 2] + _t3.z;
      P[k + 3] = h[ic] - _t3.x; P[k + 4] = h[ic + 1] - _t3.y; P[k + 5] = h[ic + 2] - _t3.z;
      const f = (1 - u) * (1 - u) * 0.9;
      C[k] = lc.r * f; C[k + 1] = lc.g * f; C[k + 2] = lc.b * f;
      C[k + 3] = C[k]; C[k + 4] = C[k + 1]; C[k + 5] = C[k + 2];
    }
    v.rGeo.setDrawRange(0, (n - 1) * 6);
    v.rGeo.attributes.position.needsUpdate = true;
    v.rGeo.attributes.color.needsUpdate = true;
    v.ribbon.visible = true;
  }
  function updateProj(v, pr, sTime, dt) {
    v.pos.set(pr.position.x, pr.position.y, pr.position.z);
    if (hasVec(pr.velocity)) v.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z);
    const orb = v.kind === 'orb';
    v.radius = clamp(num(pr.radius, orb ? 0.45 : 0.2), 0.05, 2);
    if (sTime > v.lastT + 1e-6) { pushHist(v, v.pos.x, v.pos.y, v.pos.z, sTime); v.lastT = sTime; }
    else { v.hist[0] = v.pos.x; v.hist[1] = v.pos.y; v.hist[2] = v.pos.z; }
    const speed = v.vel.length();
    const r = v.radius;
    const flick = 0.92 + 0.08 * Math.sin(clock * 37 + v.spin);
    v.core.position.copy(v.pos); v.halo.position.copy(v.pos);
    if (orb) {
      v.core.scale.setScalar(r * 0.75);
      v.shell.position.copy(v.pos);
      v.shell.scale.setScalar(r * 1.25);
      v.shell.rotation.x += dt * 1.1; v.shell.rotation.y += dt * 1.7;
      v.halo.scale.setScalar(r * 4.6 * flick);
    } else {
      if (speed > 1e-3) { _t1.copy(v.vel).multiplyScalar(1 / speed); v.core.quaternion.setFromUnitVectors(Z_AXIS, _t1); }
      const elong = 1 + Math.min(1.6, speed * 0.06);
      v.core.scale.set(r * 0.7, r * 0.7, r * 0.7 * elong);
      v.halo.scale.setScalar(r * 4.2 * flick);
    }
    const trailTime = Math.min(orb ? 0.2 : 0.11, 3.2 / Math.max(speed, 0.1));
    buildRibbon(v, sTime, trailTime, orb ? r * 1.35 : r * 1.1, orb ? LIN.orb : LIN.bolt);
    if (Q.projSparks > 0 && dt > 0) {
      v.sparkAcc += dt * (orb ? 20 : 26) * Q.projSparks;
      const rgb = orb ? RAW.guardCold : RAW.heroGold;
      while (v.sparkAcc >= 1) {
        v.sparkAcc -= 1;
        randomDir(_t2);
        glow.spawn(v.pos.x + _t2.x * r * 0.5, v.pos.y + _t2.y * r * 0.5, v.pos.z + _t2.z * r * 0.5,
          -v.vel.x * 0.06 + _t2.x * 0.5, -v.vel.y * 0.06 + _t2.y * 0.5 + 0.2, -v.vel.z * 0.06 + _t2.z * 0.5,
          rnd(0.2, 0.4), orb ? 0.05 : 0.035, 0.01, rgb, 0.8, 2.5, 0, false);
      }
    }
    if (orb && v.owner === 'boss') audio.loop('orb:' + v.id, 'orbLoop', v.pos);
  }
  function syncProjectiles(dt) {
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : EMPTY_ARR;
    const sTime = snap && isNum(snap.time) ? snap.time : clock;
    const tag = ++projTag;
    cameraPos(_cam);
    const n = Math.min(list.length, PROJ_CAP * 2);
    for (let i = 0; i < n; i++) {
      const pr = list[i];
      if (!pr || pr.id === undefined || pr.id === null || !hasVec(pr.position)) continue;
      const key = String(pr.id);
      let v = projMap.get(key);
      if (!v) {
        v = acquireProj();
        if (!v) { warnOnce('proj-cap', `больше ${PROJ_CAP} снарядов одновременно — лишние не рисуются`); continue; }
        initProj(v, key, pr, sTime);
        projMap.set(key, v);
      }
      v.tag = tag;
      updateProj(v, pr, sTime, dt);
    }
    for (const [key, v] of projMap) {
      if (v.tag !== tag) { projMap.delete(key); releaseProj(v, true); }
    }
  }

  // Попадания текущего кадра — чтобы исчезнувший снаряд не давал второй «пшик».
  const frameImpacts = [];
  for (let i = 0; i < 16; i++) frameImpacts.push(new V3());
  let frameImpactN = 0;
  const frameImpactIds = new Set();
  function registerImpact(p, pid) {
    if (frameImpactN < frameImpacts.length) frameImpacts[frameImpactN++].set(p.x, p.y, p.z);
    if (pid !== undefined && pid !== null) frameImpactIds.add(String(pid));
  }
  function impactNear(p, id) {
    if (id !== null && frameImpactIds.has(id)) return true;
    for (let i = 0; i < frameImpactN; i++) if (frameImpacts[i].distanceToSquared(p) < 4) return true;
    return false;
  }

  // ---------------------------------------------------------------- телеграфы
  const teleMap = new Map();
  const teleItems = [];
  let teleTag = 0;
  const recent = [];      // недавно завершённые телеграфы (для радиуса/точки boss_impact)
  const RECENT_MAX = 8;

  function makeTeleVisual() {
    const under = new THREE.Mesh(geo.flat, tpl.under.clone()); under.renderOrder = 2;
    const zone = new THREE.Mesh(geo.flat, tpl.zone.clone()); zone.renderOrder = 3;
    const wall = new THREE.Mesh(geo.wall, tpl.wall.clone()); wall.renderOrder = 4;
    const lane = new THREE.Mesh(geo.lane, tpl.lane.clone()); lane.renderOrder = 3;
    const reticle = new THREE.Mesh(geo.flat, tpl.zone.clone()); reticle.renderOrder = 3;
    reticle.material.uniforms.uMode.value = 2;
    const core = new THREE.Mesh(geo.sphere, basicMat(PAL.guardCold, 0.7)); core.renderOrder = 22;
    const halo = new THREE.Sprite(spriteMat(TEX.glow, PAL.guardDeep, 0.55)); halo.renderOrder = 23;
    const parts = [under, zone, wall, lane, reticle, core, halo];
    for (const o of parts) { o.visible = false; root.add(o); }
    return {
      parts, under, zone, wall, lane, reticle, core, halo,
      state: 'free', id: null, kind: 'slam', tag: 0, resolveT: 0, resolveFlash: false, gatherAcc: 0, moteAcc: 0,
      info: { origin: new V3(), target: new V3(), radius: 1, remaining: 0, duration: 1, blockable: false, progress: 0 },
    };
  }
  function hideTele(v) { for (const o of v.parts) o.visible = false; }
  function freeTele(v) { hideTele(v); v.state = 'free'; v.id = null; }
  function acquireTele() {
    for (const v of teleItems) if (v.state === 'free') return v;
    if (teleItems.length < TELE_CAP) { const v = makeTeleVisual(); teleItems.push(v); return v; }
    let best = null;
    for (const v of teleItems) if (v.state === 'resolving' && (!best || v.resolveT > best.resolveT)) best = v;
    if (best) { freeTele(best); return best; }
    return null; // все живые — лимит TELE_CAP, лишние не рисуем (с предупреждением)
  }
  function rememberResolved(v) {
    let r;
    if (recent.length < RECENT_MAX) {
      r = { kind: 'slam', clock: 0, info: { origin: new V3(), target: new V3(), radius: 1, duration: 1, remaining: 0, blockable: false } };
      recent.push(r);
    } else {
      r = recent.shift(); recent.push(r);
    }
    r.kind = v.kind; r.clock = clock; r.id = v.id;
    r.info.origin.copy(v.info.origin); r.info.target.copy(v.info.target);
    r.info.radius = v.info.radius; r.info.duration = v.info.duration; r.info.blockable = v.info.blockable;
  }
  function beginResolve(v, flash) {
    rememberResolved(v);
    v.state = 'resolving'; v.resolveT = 0; v.resolveFlash = flash;
    if (flash) {
      // Зона «закрылась» и удар сработал: короткое кольцо по кромке, даже без boss_impact.
      const I = v.info;
      if (v.kind === 'slam') fxRing(I.target, I.radius * 0.95, I.radius * 1.12, 0.3, I.blockable ? RAW.guardCold : RAW.dangerRim, RAW.dangerHot, 0.9, 3);
      else if (v.kind === 'nova') fxRing(I.origin, I.radius * 0.95, I.radius * 1.1, 0.3, I.blockable ? RAW.guardCold : RAW.dangerRim, RAW.guardCore, 0.9, 3);
    }
  }
  function applyTele(v, fade, flashAmt, rk, dt) {
    const I = v.info, R = I.radius, kind = v.kind, live = v.state === 'live';
    const colRaw = I.blockable ? RAW.guardCold : RAW.dangerRim;
    const hotRaw = I.blockable ? RAW.guardCore : RAW.dangerHot;
    const isOrb = kind === 'orb';
    v.under.visible = !isOrb; v.zone.visible = !isOrb; v.wall.visible = kind === 'nova';
    v.lane.visible = isOrb; v.reticle.visible = isOrb;
    v.core.visible = isOrb && (live || rk < 0.35); v.halo.visible = v.core.visible;
    if (!isOrb) {
      const cx = kind === 'nova' ? I.origin.x : I.target.x;
      const cz = kind === 'nova' ? I.origin.z : I.target.z;
      const grow = v.resolveFlash && !live ? 1 + 0.06 * easeOutCubic(rk) : 1;
      const s = R * 1.12 * grow;
      v.under.position.set(cx, GROUND_Y + 0.02, cz); v.under.scale.set(s, 1, s);
      v.under.material.uniforms.uOpacity.value = 0.42 * fade * (0.75 + 0.25 * I.progress);
      v.zone.position.set(cx, GROUND_Y + 0.03, cz); v.zone.scale.set(s, 1, s);
      const zu = v.zone.material.uniforms;
      setRaw(zu.uColor.value, colRaw); setRaw(zu.uHot.value, hotRaw);
      zu.uOpacity.value = fade; zu.uProgress.value = I.progress; zu.uTime.value = clock;
      zu.uMode.value = kind === 'nova' ? 1 : 0; zu.uBlockable.value = I.blockable ? 1 : 0;
      zu.uFlash.value = flashAmt; zu.uRadius.value = R;
      if (kind === 'nova') {
        v.wall.position.set(cx, GROUND_Y, cz);
        v.wall.scale.set(R, 0.7 + 0.9 * I.progress, R);
        const wu = v.wall.material.uniforms;
        setRaw(wu.uColor.value, colRaw);
        wu.uOpacity.value = (0.14 + 0.36 * I.progress + flashAmt * 0.5) * fade;
        wu.uTime.value = clock;
        if (live && dt > 0 && Q.decor > 0) {
          v.moteAcc += dt * 18 * Q.decor;
          while (v.moteAcc >= 1) {
            v.moteAcc -= 1;
            const a = Math.random() * TAU;
            glow.spawn(cx + Math.cos(a) * R, GROUND_Y + 0.1, cz + Math.sin(a) * R, 0, rnd(0.6, 1.4), 0,
              rnd(0.5, 0.9), 0.05, 0.015, colRaw, 0.7, 0.5, 0, false);
          }
        }
      }
      return;
    }
    // orb: дорожка к сохранённой цели, прицел, заряд у точки выпуска.
    const ox = I.origin.x, oz = I.origin.z;
    let dx = I.target.x - ox, dz = I.target.z - oz;
    let dist = Math.hypot(dx, dz);
    if (dist < 0.05) { dx = -fi.fwd.x; dz = -fi.fwd.z; dist = 0.05; } else { dx /= dist; dz /= dist; }
    const len = dist + 3.0, width = Math.max(R * 2.2, 0.8);
    v.lane.position.set(ox, GROUND_Y + 0.032, oz);
    v.lane.rotation.set(0, Math.atan2(dx, dz), 0);
    v.lane.scale.set(width, 1, len);
    const lu = v.lane.material.uniforms;
    setRaw(lu.uColor.value, colRaw); setRaw(lu.uHot.value, hotRaw);
    lu.uOpacity.value = 0.9 * fade; lu.uProgress.value = I.progress; lu.uTime.value = clock;
    lu.uLength.value = len; lu.uWidth.value = width; lu.uFlash.value = flashAmt;
    const rs = Math.max(R * 1.4, 0.75) * 1.12;
    v.reticle.position.set(I.target.x, GROUND_Y + 0.036, I.target.z);
    v.reticle.scale.set(rs, 1, rs);
    const ru = v.reticle.material.uniforms;
    setRaw(ru.uColor.value, colRaw); setRaw(ru.uHot.value, hotRaw);
    ru.uOpacity.value = fade; ru.uProgress.value = I.progress; ru.uTime.value = clock;
    ru.uFlash.value = flashAmt; ru.uRadius.value = rs; ru.uBlockable.value = I.blockable ? 1 : 0;
    if (v.core.visible) {
      const collapse = live ? 1 : Math.max(0, 1 - rk / 0.35);
      const cs = Math.max(1e-3, (0.25 + 0.75 * I.progress) * Math.max(R, 0.3) * 0.85 * collapse * (0.95 + 0.05 * Math.sin(clock * 29)));
      // Точка заряда чуть вынесена из тела босса к цели, чтобы её не скрывала геометрия стража.
      v.core.position.set(ox + dx * ORB_CHARGE_FWD, I.origin.y, oz + dz * ORB_CHARGE_FWD);
      v.core.scale.setScalar(cs);
      v.core.material.color.setHex(I.blockable ? PAL.guardCold : PAL.dangerRim);
      v.halo.position.copy(v.core.position); v.halo.scale.setScalar(cs * 4.2);
      v.halo.material.color.setHex(I.blockable ? PAL.guardDeep : PAL.heroEmber);
      if (live && dt > 0) {
        v.gatherAcc += dt * 34 * Q.decor;
        while (v.gatherAcc >= 1) { v.gatherAcc -= 1; gatherMote(v.core.position, colRaw, 0.9, 1.9, 0.45, 0.05, false); }
      }
    }
  }
  function syncTelegraphs(dt) {
    const list = snap && Array.isArray(snap.telegraphs) ? snap.telegraphs : EMPTY_ARR;
    const playing = fi.status === 'playing';
    const tag = ++teleTag;
    const n = Math.min(list.length, TELE_CAP * 2);
    for (let i = 0; i < n; i++) {
      const t = list[i];
      if (!t || t.id === undefined || t.id === null) continue;
      const key = String(t.id);
      let v = teleMap.get(key);
      if (!v) {
        v = acquireTele();
        if (!v) { warnOnce('tele-cap', `больше ${TELE_CAP} телеграфов одновременно — лишние не рисуются`); continue; }
        v.state = 'live'; v.id = key; v.resolveT = 0; v.resolveFlash = false; v.gatherAcc = 0; v.moteAcc = 0;
        teleMap.set(key, v);
      }
      v.tag = tag;
      v.kind = t.kind === 'orb' || t.kind === 'nova' ? t.kind : 'slam';
      const I = v.info;
      if (hasVec(t.origin)) I.origin.set(t.origin.x, t.origin.y, t.origin.z);
      else bossCoreOf(I.origin);
      if (hasVec(t.target)) I.target.set(t.target.x, t.target.y, t.target.z);
      else I.target.copy(I.origin);
      I.radius = clamp(num(t.radius, 1.5), 0.1, 30);
      I.duration = Math.max(1e-3, num(t.duration, 1));
      I.remaining = clamp(num(t.remaining, 0), 0, I.duration);
      I.blockable = t.blockable === true;
      I.progress = 1 - I.remaining / I.duration; // тот же remaining/duration, что у combat
      applyTele(v, 1, 0, 0, dt);
    }
    const eps = Math.max(0.15, lastDt * 2.5);
    for (const [key, v] of teleMap) {
      if (v.tag !== tag) {
        teleMap.delete(key);
        // Исчезла у конца подготовки во время боя → удар сработал (вспышка).
        // Исчезла рано или бой окончен → тихо гаснет, без ложного «удара».
        beginResolve(v, playing && v.info.remaining <= eps);
      }
    }
    for (const v of teleItems) {
      if (v.state !== 'resolving') continue;
      v.resolveT += dt;
      const dur = v.resolveFlash ? 0.45 : 0.3;
      const k = v.resolveT / dur;
      if (k >= 1) { freeTele(v); continue; }
      if (v.resolveFlash) v.info.progress = 1;
      const fade = v.resolveFlash ? Math.pow(1 - k, 1.4) : (1 - k) * 0.8;
      const fl = v.resolveFlash ? Math.max(0, 1 - k * 3.5) : 0;
      applyTele(v, fade, fl, k, dt);
    }
  }
  function findTele(d, kind, pos) {
    const ids = [d.attackId, d.telegraphId, d.id];
    for (const id of ids) {
      if (id === undefined || id === null) continue;
      const v = teleMap.get(String(id));
      if (v) return v;
    }
    let best = null, bestScore = Infinity;
    for (const v of teleMap.values()) {
      if (kind && v.kind !== kind) continue;
      let score = v.info.remaining;
      if (pos) {
        const c = v.kind === 'slam' ? v.info.target : v.info.origin;
        score = Math.hypot(pos.x - c.x, pos.z - c.z);
      }
      if (score < bestScore) { bestScore = score; best = v; }
    }
    if (best) return best;
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      if (clock - r.clock < 0.6 && (!kind || r.kind === kind)) return r;
    }
    return null;
  }

  // ---------------------------------------------------------------- рывок
  const dashFx = { active: false, t: 0, ghostsLeft: 0, next: 0, sign: 1, acc: 0 };
  function syncDash(dt) {
    if (!dashFx.active) return;
    dashFx.t += dt;
    if (dashFx.ghostsLeft > 0 && dashFx.t >= dashFx.next && fi.has && !reducedMotion()) {
      fxGhost(fi.player, Math.atan2(fi.fwd.x, fi.fwd.z));
      dashFx.ghostsLeft--;
      dashFx.next += 0.06;
    }
    if (dt > 0) {
      dashFx.acc += dt * 60 * Q.decor;
      while (dashFx.acc >= 1) {
        dashFx.acc -= 1;
        glow.spawn(fi.player.x + rnd(-0.25, 0.25), fi.player.y + rnd(0.3, 1.6), fi.player.z + rnd(-0.25, 0.25),
          -fi.right.x * dashFx.sign * rnd(0.8, 2), rnd(-0.1, 0.3), -fi.right.z * dashFx.sign * rnd(0.8, 2),
          rnd(0.2, 0.35), 0.04, 0.01, RAW.heroGold, 0.8, 3, 0, false);
      }
    }
    if (dashFx.t > 0.4) dashFx.active = false;
  }

  // ---------------------------------------------------------------- непрерывные мелочи
  let moteAcc = 0, chargeAcc = 0;
  function syncAmbientFx(dt) {
    if (!snap || fi.status !== 'playing' || dt <= 0) { moteAcc = 0; chargeAcc = 0; return; }
    const bo = snap.boss;
    if (bo && bo.stage === 2 && Q.motes > 0) {
      // Вторая фаза: холодные частицы поднимаются из трещин стража (декоративно).
      moteAcc += dt * 14 * Q.motes;
      while (moteAcc >= 1) {
        moteAcc -= 1;
        const a = Math.random() * TAU, rr = rnd(0.6, 1.8);
        const c = Math.cos(a), s = Math.sin(a);
        glow.spawn(fi.boss.x + c * rr, fi.boss.y + rnd(0.4, 3.6), fi.boss.z + s * rr, c * 0.15, rnd(0.4, 0.9), s * 0.15,
          rnd(1.6, 2.6), 0.05, 0.015, RAW.guardCold, 0.7, 0.3, 0, false);
      }
    }
    // Необязательное расширение snapshot.player.burstCharge (0..1): свечение набора силы у рук.
    const ch = snap.player && snap.player.burstCharge;
    if (isNum(ch) && ch > 0.02) {
      chargeAcc += dt * 40 * clamp01(ch);
      while (chargeAcc >= 1) {
        chargeAcc -= 1;
        handOf(_s1, Math.random() < 0.5 ? -1 : 1);
        gatherMote(_s1, RAW.heroAmber, 0.3, 0.7, 0.3, 0.04, false);
      }
    }
  }

  // ---------------------------------------------------------------- обработчики событий
  let outcomeDone = false, phaseDone = false, prevStage = null, lastSnapTime = null;

  function onPlayerCast(ev, d) {
    if (d.ability === 'burst' || d.kind === 'burst') return; // у burst своё событие
    const p = hasVec(ev.position) && ev.position.y > GROUND_Y + 0.4 ? _p.set(ev.position.x, ev.position.y, ev.position.z) : handOf(_p, 1);
    fxFlash(p, PAL.heroAmber, 0.25, 0.6, 0.14, { opacity: 0.9 });
    fxFlash(p, PAL.heroCore, 0.12, 0.3, 0.09);
    sparks(p, { dir: fi.fwd, count: 4, spread: 0.6, speed: [1.2, 2.6], rgb: RAW.heroAmber, life: 0.28, size: 0.05, essential: true, drag: 3 });
    sparks(p, { count: 10, spread: 1, speed: [0.4, 1.4], rgb: RAW.heroGold, life: 0.45, size: 0.04, gravity: -0.3, drag: 2 });
    audio.play('cast', p);
  }

  function onProjectileImpact(ev, d) {
    const pid = d.projectileId ?? d.projectile ?? null;
    const pv = pid !== null ? projMap.get(String(pid)) : null;
    const p = hasVec(ev.position) ? _p.set(ev.position.x, ev.position.y, ev.position.z) : (pv ? _p.copy(pv.pos) : bossCoreOf(_p));
    let owner = d.owner || (pv && pv.owner);
    if (owner !== 'player' && owner !== 'boss') {
      owner = p.distanceToSquared(fi.boss) < p.distanceToSquared(fi.player) ? 'player' : 'boss';
    }
    // Направление полёта: data.direction → последняя скорость снаряда → от камеры.
    if (hasVec(d.direction)) _dir.set(d.direction.x, d.direction.y, d.direction.z);
    else if (hasVec(d.velocity)) _dir.set(d.velocity.x, d.velocity.y, d.velocity.z);
    else if (pv && pv.vel.lengthSq() > 1e-6) _dir.copy(pv.vel);
    else toCamDir(p, _dir).negate();
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, -1);
    _dir.normalize();
    registerImpact(p, pid);
    _q.copy(_dir).negate(); // брызги обратно к источнику
    const ang = screenAngle(p, _q);
    if (owner === 'player') {
      fxFlash(p, PAL.heroAmber, 0.35, 1.3, 0.16, { stretch: ang !== null ? 2.2 : 1, rotation: ang ?? undefined, opacity: 0.95 });
      fxFlash(p, PAL.heroCore, 0.2, 0.55, 0.1, { flare: true });
      sparks(p, { dir: _q, count: 8, spread: 0.8, speed: [2, 5], rgb: RAW.heroAmber, life: 0.3, size: 0.05, essential: true, gravity: 3, drag: 2.5 });
      sparks(p, { dir: _q, count: 14, spread: 1.2, speed: [0.6, 2.4], rgb: RAW.heroGold, life: 0.5, size: 0.04, gravity: 1, drag: 2 });
      if (p.distanceTo(fi.boss) < 4.5) {
        sparks(p, { pool: dust, count: 6, spread: 1, speed: [0.5, 1.8], rgb: RAW.dustLight, life: 0.8, size: 0.06, gravity: 6, drag: 1 });
      }
      audio.play('boltImpact', p);
    } else {
      fxFlash(p, PAL.guardCold, 0.5, 1.8, 0.22, { stretch: ang !== null ? 1.8 : 1, rotation: ang ?? undefined });
      fxFlash(p, PAL.guardCore, 0.3, 0.8, 0.12, { flare: true });
      sparks(p, { dir: _q, count: 10, spread: 1, speed: [2, 5], rgb: RAW.guardCold, life: 0.4, size: 0.06, essential: true, gravity: 2, drag: 2 });
      sparks(p, { count: 16, speed: [0.5, 2], rgb: RAW.guardCore, life: 0.6, size: 0.04, drag: 2 });
      if (p.y < GROUND_Y + 1.2) fxRing(p, 0.2, 1.6, 0.35, RAW.guardCold, RAW.guardCore, 0.8, 3);
      lightFlash(p, PAL.guardCold, 0.5, 0.3);
      audio.play('orbImpact', p);
    }
  }

  function onBlock(ev, d) {
    const c = shieldCenter(_r);
    let ix = 0, iy = 0;
    if (hasVec(ev.position)) {
      const ox = ev.position.x - c.x, oy = ev.position.y - c.y, oz = ev.position.z - c.z;
      ix = (ox * fi.fwd.z - oz * fi.fwd.x) / SHIELD_R;
      iy = oy / SHIELD_R;
      const l = Math.hypot(ix, iy);
      if (l > 0.85) { ix *= 0.85 / l; iy *= 0.85 / l; }
    }
    shield.flash = 1; shield.rippleT = 0; shield.rx = ix; shield.ry = iy;
    if (shield.open < 0.5) shield.open = 0.5;
    // Точка удара на плоскости знака.
    const p = _p.set(c.x + fi.fwd.z * ix * SHIELD_R, c.y + iy * SHIELD_R, c.z - fi.fwd.x * ix * SHIELD_R);
    registerImpact(p, d.projectileId ?? null);
    fxFlash(p, PAL.heroCore, 0.3, 1.1, 0.22, { flare: true, pull: 0.1 });
    sparks(p, { dir: fi.fwd, count: 10, spread: 1.3, speed: [2, 5], rgb: RAW.heroAmber, life: 0.35, size: 0.05, essential: true, gravity: 3, drag: 2 });
    sparks(p, { dir: fi.fwd, count: 12, spread: 1.5, speed: [1, 3], rgb: RAW.guardCold, life: 0.4, size: 0.04, gravity: 2, drag: 2 });
    lightFlash(p, PAL.heroAmber, 0.6, 0.35);
    _q.copy(fi.fwd).negate();
    addKick(_q, 0.03); addTrauma(0.08);
    audio.play('block', p);
  }

  function onPlayerHit(ev, d) {
    const p = evPos(ev, _p, chestOf);
    if (p.y < GROUND_Y + 0.3) p.y = fi.player.y + CHEST_H;
    registerImpact(p, d.projectileId ?? null);
    if (hasVec(d.direction)) _dir.set(d.direction.x, d.direction.y, d.direction.z).normalize();
    else _dir.copy(fi.fwd).negate();
    fxFlash(p, PAL.hitEmber, 0.4, 1.2, 0.2, { opacity: 0.8 });
    sparks(p, { dir: _dir, count: 10, spread: 1, speed: [1.5, 4], rgb: RAW.hitEmber, life: 0.45, size: 0.05, essential: true, gravity: 3, drag: 2 });
    sparks(p, { pool: dust, count: 8, speed: [0.5, 1.5], rgb: RAW.dust, life: 0.7, size: 0.07, gravity: 2, drag: 1.5 });
    addTrauma(0.32); addKick(_dir, 0.04);
    audio.play('playerHit', p);
  }

  function onBossHit(ev, d) {
    const p = evPos(ev, _p, bossCoreOf);
    const amount = num(d.amount, 10);
    const big = clamp(amount / 40, 0.4, 1.6);
    registerImpact(p, d.projectileId ?? null);
    toCamDir(p, _dir);
    sparks(p, { dir: _dir, count: 6, spread: 1.1, speed: [1.5, 4], rgb: RAW.guardCold, life: 0.35, size: 0.06, essential: true, gravity: 2, drag: 2.5 });
    sparks(p, { pool: dust, count: Math.round(6 * big), speed: [1, 3.2], rgb: RAW.dustLight, life: 0.7, size: 0.07, essential: true, gravity: 9, drag: 0.8 });
    sparks(p, { pool: dust, count: Math.round(12 * big), speed: [0.4, 1.6], rgb: RAW.dust, life: 1.0, size: 0.09, gravity: 3, drag: 1.5 });
    fxFlash(p, PAL.guardCold, 0.3, 0.9 * big, 0.16, { pull: 0.5 });
    if (amount >= 25) { addTrauma(0.1); lightFlash(p, PAL.guardCold, 0.5, 0.3); }
    audio.play('bossHit', p, amount);
  }

  function onBossWindup(ev, d) {
    const kind = d.attackKind || d.kind || 'slam';
    const c = bossCoreOf(_p);
    const tv = findTele(d, kind, null);
    const dur = clamp(num(d.windup, num(d.duration, tv ? tv.info.duration : 0.9)), 0.3, 2.5);
    const n = Math.round((kind === 'orb' ? 22 : 16) * Q.decor);
    for (let i = 0; i < n; i++) gatherMote(c, RAW.guardCold, 1.4, 2.6, Math.min(dur, 0.9), 0.07, false);
    audio.play('windup', c, { kind, dur });
  }

  function onBossImpact(ev, d) {
    let kind = d.attackKind || d.kind;
    const tv = findTele(d, kind || null, hasVec(ev.position) ? ev.position : null);
    if (!kind) kind = tv ? tv.kind : 'slam';
    const R = num(d.radius, tv ? tv.info.radius : (kind === 'nova' ? 5 : 2.2));
    if (kind === 'orb') {
      const o = hasVec(ev.position) ? _p.set(ev.position.x, ev.position.y, ev.position.z) : (tv ? _p.copy(tv.info.origin) : bossCoreOf(_p));
      if (o.distanceTo(fi.boss) > 3.5) {
        // Событие пришло в точке разрыва сферы, а не выпуска.
        fxFlash(o, PAL.guardCold, 0.6, 2.2, 0.25, { flare: true });
        sparks(o, { count: 12, speed: [1, 4], rgb: RAW.guardCold, life: 0.45, size: 0.06, essential: true, drag: 2 });
        audio.play('orbImpact', o);
        return;
      }
      if (tv) _dir.set(tv.info.target.x - o.x, 0, tv.info.target.z - o.z); else _dir.copy(fi.fwd).negate();
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
      _dir.normalize();
      fxFlash(o, PAL.guardCore, 0.5, 1.8, 0.2, { flare: true });
      sparks(o, { dir: _dir, count: 8, spread: 0.5, speed: [3, 6], rgb: RAW.guardCold, life: 0.3, size: 0.05, essential: true, drag: 3 });
      audio.play('orbLaunch', o);
      return;
    }
    if (kind === 'nova') {
      const c = hasVec(ev.position) ? _p.set(ev.position.x, ev.position.y, ev.position.z) : (tv ? _p.copy(tv.info.origin) : _p.copy(fi.boss));
      _q.set(c.x, GROUND_Y, c.z);
      fxRing(_q, 0.5, R * 1.05, 0.38, RAW.guardCold, RAW.guardCore, 1.1, 3);
      fxWall(_q, 0.5, R, 1.8, 0.42, RAW.guardCold, 0.7);
      bossCoreOf(_r);
      fxFlash(_r, PAL.guardCold, 0.8, 3, 0.35, { flare: true, opacity: 0.8 });
      sparks(_q, { count: 30, flat: true, speed: [R * 1.2, R * 2.4], rgb: RAW.guardCold, life: 0.45, size: 0.06, drag: 2.5, jitter: 0.3 });
      sparks(_q, { count: 12, flat: true, speed: [R * 1.5, R * 2.5], rgb: RAW.guardCore, life: 0.35, size: 0.06, essential: true, drag: 3 });
      lightFlash(_r, PAL.guardCold, 1.1, 0.5);
      const dPl = Math.hypot(c.x - fi.player.x, c.z - fi.player.z);
      addTrauma(0.3 * (dPl < R + 1 ? 1 : 0.5));
      audio.play('nova', c);
      return;
    }
    // slam
    const c = hasVec(ev.position) ? _p.set(ev.position.x, ev.position.y, ev.position.z) : (tv ? _p.copy(tv.info.target) : _p.copy(fi.player));
    _q.set(c.x, GROUND_Y, c.z);
    fxRing(_q, R * 0.4, R * 1.05, 0.9, RAW.guardCold, RAW.guardCore, 1.0, 4);           // светящиеся трещины
    fxRing(_q, R * 0.3, R * 1.45, 0.42, RAW.guardCold, RAW.guardCore, 0.9, 3);          // ударная волна
    _r.set(c.x, GROUND_Y + 0.35, c.z);
    fxFlash(_r, PAL.guardCold, 0.8, R * 1.6, 0.3, { flare: true, opacity: 0.8 });
    _dir.set(0, 1, 0);
    sparks(_r, { pool: dust, dir: _dir, count: 14, spread: 1.6, speed: [2, 5.5], rgb: RAW.dustLight, life: 1.0, size: 0.09, essential: true, gravity: 9, drag: 0.6, jitter: R * 0.4 });
    sparks(_r, { pool: dust, count: 36, flat: true, speed: [R * 0.8, R * 2], rgb: RAW.dust, life: 1.2, size: 0.16, sizeEnd: 0.28, gravity: 0.4, drag: 2.2, alpha: 0.7, jitter: R * 0.3 });
    sparks(_r, { dir: _dir, count: 10, spread: 1.2, speed: [1.5, 4], rgb: RAW.guardCold, life: 0.5, size: 0.05, gravity: 4, drag: 1.5, jitter: R * 0.5 });
    lightFlash(_r, PAL.guardCold, 1.2, 0.45);
    const dPl = Math.hypot(c.x - fi.player.x, c.z - fi.player.z);
    addTrauma(0.45 * clamp(1.2 - dPl / 8, 0.25, 1));
    _dir.set(0, -1, 0); addKick(_dir, 0.05 * clamp(1.2 - dPl / 8, 0.25, 1));
    audio.play('slam', c);
  }

  function onBossPhase(ev, d) {
    phaseDone = true;
    const c = bossCoreOf(_p);
    _q.set(fi.boss.x, GROUND_Y, fi.boss.z);
    fxRing(_q, 0.8, 9, 1.0, RAW.guardCold, RAW.guardCore, 0.9, 3);
    fxWall(_q, 0.8, 8, 2.6, 1.0, RAW.guardDeep, 0.5);
    fxFlash(c, PAL.guardCold, 1.5, 4.5, 0.8, { flare: true, opacity: 0.8, pull: 0.8 });
    _dir.set(0, 1, 0);
    sparks(c, { dir: _dir, count: 10, spread: 1.4, speed: [1, 3], rgb: RAW.guardCore, life: 1.2, size: 0.07, essential: true, gravity: -0.4, drag: 1, jitter: 1.2 });
    sparks(c, { dir: _dir, count: 50, spread: 1.6, speed: [0.5, 2.5], rgb: RAW.guardCold, life: 1.6, size: 0.05, gravity: -0.3, drag: 1, jitter: 1.5 });
    lightFlash(c, PAL.guardCold, 1.4, 1.2);
    addTrauma(0.25);
    audio.play('phase', c);
  }

  function onBurst(ev, d) {
    const c = evPos(ev, _p, chestOf);
    if (c.y < GROUND_Y + 0.3) c.y = fi.player.y + CHEST_H;
    const maxR = num(d.radius, 7);
    _q.set(c.x, GROUND_Y, c.z);
    // «Подготовка» — первые ~80 мс вспышки ядра; на время урона не влияет.
    fxFlash(c, PAL.heroCore, 0.4, 2.4, 0.32, { flare: true, opacity: 1, pull: 0.4 });
    fxFlash(c, PAL.heroAmber, 1.0, 3.4, 0.5, { opacity: 0.7, pull: 0.4 });
    fxRing(_q, 0.4, maxR, 0.62, RAW.heroAmber, RAW.heroCore, 0.85, 3);
    fxRing(_q, 0.2, maxR * 0.55, 0.45, RAW.heroGold, RAW.heroCore, 0.5, 3);
    fxWall(_q, 0.4, maxR, 1.2, 0.62, RAW.heroAmber, 0.35);
    // Оболочка ограничена ~1.5 м: камера за спиной героя не должна оказаться внутри неё.
    if (Q.shell) fxShell(c, 0.3, 1.5, 0.3, RAW.heroAmber, 0.5);
    sparks(c, { count: 14, flat: true, speed: [maxR * 1.2, maxR * 2], rgb: RAW.heroAmber, life: 0.45, size: 0.06, essential: true, drag: 3 });
    sparks(c, { count: 40, flat: true, speed: [maxR * 0.6, maxR * 1.6], rgb: RAW.heroGold, life: 0.7, size: 0.05, drag: 2.5, gravity: -0.2 });
    lightFlash(c, PAL.heroAmber, 1.0, 0.7);
    addTrauma(0.18); _dir.set(0, 1, 0); addKick(_dir, 0.02);
    audio.play('burst', c);
  }

  function onPlayerDash(ev, d) {
    let sign = 1;
    const dd = d.direction ?? d.dir;
    if (isNum(dd)) sign = dd >= 0 ? 1 : -1;
    else if (hasVec(dd)) sign = dd.x * fi.right.x + dd.z * fi.right.z >= 0 ? 1 : -1;
    dashFx.active = true; dashFx.t = 0; dashFx.next = 0; dashFx.acc = 0; dashFx.sign = sign;
    dashFx.ghostsLeft = reducedMotion() ? 0 : Q.ghosts;
    const feet = evPos(ev, _p, playerGround);
    feet.y = GROUND_Y + 0.05;
    _dir.set(-fi.right.x * sign, 0.25, -fi.right.z * sign);
    sparks(feet, { pool: dust, dir: _dir, count: 12, spread: 0.8, speed: [1, 3], rgb: RAW.dust, life: 0.7, size: 0.1, sizeEnd: 0.2, gravity: 1, drag: 2.5, alpha: 0.6 });
    sparks(chestOf(_q), { dir: _dir, count: 6, spread: 0.5, speed: [2, 4], rgb: RAW.heroGold, life: 0.3, size: 0.05, essential: true, drag: 3 });
    cameraRight(_r).multiplyScalar(sign);
    addKick(_r, 0.045);
    audio.play('dash', chestOf(_q), sign);
  }

  function onOutcome(kind) {
    if (outcomeDone) return;
    outcomeDone = true;
    audio.stopLoops();
    if (kind === 'victory') {
      const c = bossCoreOf(_p);
      fxFlash(c, PAL.guardCold, 1.0, 5.0, 1.4, { flare: true, opacity: 0.8, pull: 0.8 });
      _q.set(fi.boss.x, GROUND_Y, fi.boss.z);
      fxRing(_q, 0.6, 7.5, 1.8, RAW.guardCold, RAW.guardCore, 0.55, 3);
      _dir.set(0, 1, 0);
      sparks(c, { dir: _dir, count: 16, spread: 1.2, speed: [0.6, 1.6], rgb: RAW.guardCore, life: 2.4, size: 0.07, essential: true, gravity: -0.2, drag: 0.6, jitter: 1.2 });
      sparks(c, { dir: _dir, count: 60, spread: 1.5, speed: [0.3, 1.4], rgb: RAW.guardCold, life: 2.8, size: 0.05, gravity: -0.15, drag: 0.5, jitter: 1.8 });
      sparks(chestOf(_r), { dir: _dir, count: 20, spread: 1.2, speed: [0.3, 1], rgb: RAW.heroGold, life: 2, size: 0.04, gravity: -0.1, drag: 0.8, jitter: 0.5 });
      lightFlash(c, PAL.guardCold, 1.1, 1.8);
      audio.play('victory', c);
      audio.duck(0.55, 3);
    } else {
      const c = chestOf(_p);
      sparks(c, { count: 10, speed: [0.3, 1.2], rgb: RAW.heroEmber, life: 1.4, size: 0.05, essential: true, gravity: 1.2, drag: 1 });
      sparks(c, { count: 26, speed: [0.2, 0.8], rgb: RAW.hitEmber, life: 1.8, size: 0.04, gravity: 0.8, drag: 1, jitter: 0.4 });
      fxRing(playerGround(_q), 0.3, 2.2, 1.2, RAW.heroEmber, RAW.heroAmber, 0.45, 3);
      audio.play('defeat', c);
      audio.duck(0.5, 3);
    }
  }

  function handleEvent(type, ev, d) {
    switch (type) {
      case 'player_cast': onPlayerCast(ev, d); break;
      case 'projectile_impact': onProjectileImpact(ev, d); break;
      case 'block': onBlock(ev, d); break;
      case 'player_hit': onPlayerHit(ev, d); break;
      case 'boss_hit': onBossHit(ev, d); break;
      case 'boss_windup': onBossWindup(ev, d); break;
      case 'boss_impact': onBossImpact(ev, d); break;
      case 'boss_phase': onBossPhase(ev, d); break;
      case 'burst': onBurst(ev, d); break;
      case 'player_dash': onPlayerDash(ev, d); break;
      case 'victory': onOutcome('victory'); break;
      case 'defeat': onOutcome('defeat'); break;
      case 'shield_start':
      case 'shield_end':
        break; // щит ведётся по snapshot.player.shielding (звук и знак по переходу состояния)
      default:
        if (DEBUG) warnOnce('type:' + type, 'неизвестный тип события', type);
    }
  }

  // Ограниченный кэш обработанных id (FIFO).
  const seenIds = new Set();
  const seenRing = new Array(EVENT_CACHE_SIZE).fill(null);
  let seenIdx = 0;
  function markSeen(key) {
    const old = seenRing[seenIdx];
    if (old !== null) seenIds.delete(old);
    seenRing[seenIdx] = key;
    seenIds.add(key);
    seenIdx = (seenIdx + 1) % EVENT_CACHE_SIZE;
  }
  function processEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const n = Math.min(events.length, MAX_EVENTS_PER_FRAME);
    if (events.length > MAX_EVENTS_PER_FRAME) warnOnce('ev-many', 'слишком много событий за кадр, обработаны первые', MAX_EVENTS_PER_FRAME);
    for (let i = 0; i < n; i++) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
      if (ev.id !== undefined && ev.id !== null) {
        const key = String(ev.id);
        if (seenIds.has(key)) { stats.duplicates++; continue; }
        markSeen(key);
      } else {
        warnOnce('ev-noid', 'событие без id — обработано, но дедупликация невозможна:', ev.type);
      }
      const d = ev.data && typeof ev.data === 'object' ? ev.data : EMPTY_OBJ;
      try { handleEvent(ev.type, ev, d); stats.events++; } catch (err) {
        stats.errors++;
        warnOnce('ev-err:' + ev.type, 'ошибка обработки события', ev.type, err);
      }
    }
  }

  function checkRewind() {
    if (!snap || !isNum(snap.time)) return;
    if (lastSnapTime !== null && snap.time + 0.25 < lastSnapTime) {
      // Время боя пошло назад без reset(): combat перезапущен — чистим презентацию и кэш id.
      clearAll();
    }
    lastSnapTime = snap.time;
  }
  function checkFallbacks() {
    if (!snap) return;
    const st = snap.boss && snap.boss.stage === 2 ? 2 : 1;
    if (prevStage !== null && st === 2 && prevStage !== 2 && !phaseDone) onBossPhase(null, EMPTY_OBJ);
    prevStage = st;
    if ((snap.status === 'victory' || snap.status === 'defeat') && !outcomeDone) onOutcome(snap.status);
  }

  function clearAll() {
    for (const v of projItems) if (v.active) releaseProj(v, false);
    projMap.clear();
    for (const v of teleItems) freeTele(v);
    teleMap.clear();
    recent.length = 0;
    flashPool.releaseAll(); groundPool.releaseAll(); wallPool.releaseAll(); shellPool.releaseAll(); ghostPool.releaseAll();
    glow.clear(); dust.clear();
    shield.open = 0; shield.on = false; shield.flash = 0; shield.rippleT = 1;
    diskMesh.visible = false; shellMesh.visible = false;
    dashFx.active = false;
    L.t = L.dur; flashLight.intensity = 0;
    imp.trauma = 0; imp.kick.set(0, 0, 0); imp.kvel.set(0, 0, 0); imp.out.set(0, 0, 0);
    seenIds.clear(); seenRing.fill(null); seenIdx = 0;
    outcomeDone = false; phaseDone = false; prevStage = null; lastSnapTime = null;
    moteAcc = 0; chargeAcc = 0;
    frameImpactN = 0; frameImpactIds.clear();
    audio.stopAll();
    audio.duck(1, 0.6);
  }

  // ---------------------------------------------------------------- публичный API
  function update(dt, snapshot, events) {
    if (disposed) return;
    dt = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    if (dt > 0) lastDt = dt;
    clock += dt;
    snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
    updateFrameInfo(snap);
    checkRewind();
    frameImpactN = 0; frameImpactIds.clear();
    processEvents(events);
    syncShield(dt);
    syncProjectiles(dt);
    syncTelegraphs(dt);
    syncDash(dt);
    syncAmbientFx(dt);
    checkFallbacks();
    updateTransients(dt);
    const vh = renderer && renderer.domElement && renderer.domElement.height > 0 ? renderer.domElement.height : 720;
    glow.mat.uniforms.uViewportH.value = vh;
    dust.mat.uniforms.uViewportH.value = vh;
    glow.update(dt);
    dust.update(dt);
    updateLight(dt);
    updateImpulse(dt);
    audio.update();
  }

  function setQuality(level) {
    if (disposed) return;
    const name = level === 'low' || level === 'high' ? level : 'medium';
    qualityName = name;
    Q = QUALITY_PRESETS[name];
    glow.setCap(Q.glowCap);
    dust.setCap(Q.dustCap);
    // Low выключает точечный свет (однократная перекомпиляция материалов сцены при смене настройки).
    flashLight.visible = Q.light;
    if (!Q.light) { flashLight.intensity = 0; L.t = L.dur; }
    shellMesh.visible = shellMesh.visible && Q.shell;
  }

  function getCameraImpulse() {
    if (disposed || !impulseAllowed()) return { x: 0, y: 0, z: 0 };
    return { x: imp.out.x, y: imp.out.y, z: imp.out.z };
  }

  function reset() {
    if (disposed) return;
    clearAll();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { audio.dispose(); } catch (e) { /* ignore */ }
    if (root.parent) root.parent.remove(root);
    const geos = new Set(), mats = new Set();
    root.traverse((o) => {
      if (o.geometry && !o.isSprite) geos.add(o.geometry); // геометрию Sprite three делит глобально — не трогаем
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m)); else mats.add(o.material);
      }
    });
    for (const g of Object.values(geo)) geos.add(g);
    for (const m of Object.values(tpl)) mats.add(m);
    for (const m of Object.values(projMat)) mats.add(m);
    for (const g of geos) { try { g.dispose(); } catch (e) { /* ignore */ } }
    for (const m of mats) { try { m.dispose(); } catch (e) { /* ignore */ } }
    for (const t of Object.values(TEX)) { try { t.dispose(); } catch (e) { /* ignore */ } }
    if (typeof flashLight.dispose === 'function') flashLight.dispose();
    projMap.clear(); teleMap.clear(); projItems.length = 0; teleItems.length = 0;
    seenIds.clear();
    snap = null;
  }

  // Расширения (не входят в базовый контракт, перечислены в handoff).
  function setReducedMotion(value) {
    reducedMotionOverride = value === null || value === undefined ? null : !!value;
    if (reducedMotion()) { imp.trauma = 0; imp.kick.set(0, 0, 0); imp.kvel.set(0, 0, 0); imp.out.set(0, 0, 0); dashFx.ghostsLeft = 0; }
  }
  function getDebugInfo() {
    return {
      apiVersion: API_VERSION,
      quality: qualityName,
      reducedMotion: reducedMotion(),
      particles: { glow: glow.count, dust: dust.count, glowCap: Q.glowCap, dustCap: Q.dustCap },
      projectiles: { drawn: projMap.size, pooled: projItems.length },
      telegraphs: { live: teleMap.size, pooled: teleItems.length, resolving: teleItems.filter((v) => v.state === 'resolving').length },
      transients: {
        flashes: flashPool.activeCount(), rings: groundPool.activeCount(), walls: wallPool.activeCount(),
        shells: shellPool.activeCount(), ghosts: ghostPool.activeCount(),
      },
      shield: { open: shield.open, flash: shield.flash },
      light: { visible: flashLight.visible, intensity: flashLight.intensity, legacyLights, unit: LIGHT_UNIT },
      impulse: { x: imp.out.x, y: imp.out.y, z: imp.out.z, trauma: imp.trauma },
      events: { processed: stats.events, duplicatesSkipped: stats.duplicates, errors: stats.errors, cacheSize: seenIds.size },
      audio: audio.state(),
    };
  }

  setQuality(liveSetting('quality'));

  return {
    update,
    unlockAudio: () => (disposed ? Promise.resolve(false) : audio.unlock()),
    setVolume: (value) => { if (!disposed) audio.setVolume(value); },
    setQuality,
    getCameraImpulse,
    reset,
    dispose,
    // расширения
    setReducedMotion,
    getDebugInfo,
  };
}

// ================================================================== звук (Web Audio)
// Весь звук синтезируется: шумовые буферы, фильтры, огибающие, сгенерированная реверберация.
// AudioContext создаётся только в unlock() (вызывать из обработчика пользовательского действия).

function createAudioEngine({ panFor, distGain, volume: initialVolume, maxVoices, warnOnce }) {
  const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
    || (typeof globalThis !== 'undefined' && globalThis.AudioContext) || null;

  let ctx = null, comp = null, master = null, sfxBus = null, ambBus = null, revIn = null, revOut = null, conv = null;
  let noise = null;
  let volume = clamp01(initialVolume);
  let disposed = false;
  let ambientStarted = false;
  let suspendTimer = null;
  let unlockPromise = null;
  const ambientNodes = [];
  const ambientSources = [];
  const voices = [];
  const loops = new Map();
  const AMB_LEVEL = 0.2;
  const LIMITS = {
    cast: 3, impact: 4, launch: 2, block: 2, dash: 2, windup: 2, heavy: 2, hit: 3,
    phase: 1, burst: 1, outcome: 1, shield: 2, orbLoop: 2, shieldHum: 1,
  };

  const gainFor = (v) => v * v; // квадратичная кривая: слайдер 0..1 ощущается ровнее; 0 → ровно 0
  const T = () => ctx.currentTime + 0.005;

  function makeNoise(kind) {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, peak = 1e-6;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      let s;
      if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        s = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02; s = last;
      } else s = w;
      d[i] = s;
      const a = Math.abs(s); if (a > peak) peak = a;
    }
    const k = 0.9 / peak;
    for (let i = 0; i < len; i++) d[i] *= k;
    return buf;
  }
  function makeIR() {
    // Небольшая каменная «зала»: 2.2 с, предзадержка 12 мс, хвост темнеет со временем.
    const sr = ctx.sampleRate, len = Math.floor(sr * 2.2), pre = Math.floor(sr * 0.012);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        const t = (i - pre) / (len - pre);
        const coef = lerp(0.85, 0.18, t);
        y += ((Math.random() * 2 - 1) - y) * coef;
        d[i] = y * Math.pow(1 - t, 3.2);
      }
    }
    return buf;
  }
  function build() {
    ctx = new AC({ latencyHint: 'interactive' });
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 5;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = gainFor(volume);
    comp.connect(master); master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(comp);
    ambBus = ctx.createGain(); ambBus.gain.value = 0; ambBus.connect(comp);
    conv = ctx.createConvolver(); conv.buffer = makeIR();
    revIn = ctx.createGain(); revIn.gain.value = 1;
    revOut = ctx.createGain(); revOut.gain.value = 0.5;
    revIn.connect(conv); conv.connect(revOut); revOut.connect(comp);
    noise = { white: makeNoise('white'), pink: makeNoise('pink'), brown: makeNoise('brown') };
  }

  function startAmbient() {
    if (ambientStarted || !ctx) return;
    ambientStarted = true;
    const t = ctx.currentTime;
    const add = (...n) => { ambientNodes.push(...n); };
    const src = (node) => { ambientSources.push(node); ambientNodes.push(node); return node; };
    // Ветер: розовый шум через полосовой фильтр с медленно плывущей частотой и громкостью.
    const w = src(ctx.createBufferSource()); w.buffer = noise.pink; w.loop = true;
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 420; wf.Q.value = 0.55;
    const wg = ctx.createGain(); wg.gain.value = 0.3;
    const l1 = src(ctx.createOscillator()); l1.frequency.value = 0.047;
    const l1g = ctx.createGain(); l1g.gain.value = 220;
    const l2 = src(ctx.createOscillator()); l2.frequency.value = 0.11;
    const l2g = ctx.createGain(); l2g.gain.value = 0.12;
    l1.connect(l1g); l1g.connect(wf.frequency); l2.connect(l2g); l2g.connect(wg.gain);
    w.connect(wf); wf.connect(wg); wg.connect(ambBus);
    add(wf, wg, l1g, l2g);
    // Высокий «воздух» с редкими порывами.
    const hs = src(ctx.createBufferSource()); hs.buffer = noise.white; hs.loop = true;
    const hf = ctx.createBiquadFilter(); hf.type = 'highpass'; hf.frequency.value = 3200; hf.Q.value = 0.5;
    const hg = ctx.createGain(); hg.gain.value = 0.022;
    const l3 = src(ctx.createOscillator()); l3.frequency.value = 0.031;
    const l3g = ctx.createGain(); l3g.gain.value = 0.018;
    l3.connect(l3g); l3g.connect(hg.gain);
    hs.connect(hf); hf.connect(hg); hg.connect(ambBus);
    add(hf, hg, l3g);
    // Низкий гул святилища.
    const df = ctx.createBiquadFilter(); df.type = 'lowpass'; df.frequency.value = 190; df.Q.value = 0.7;
    const dg = ctx.createGain(); dg.gain.value = 0.2;
    const l4 = src(ctx.createOscillator()); l4.frequency.value = 0.063;
    const l4g = ctx.createGain(); l4g.gain.value = 0.07;
    l4.connect(l4g); l4g.connect(dg.gain);
    const partials = [[55, 'sine', 0.6, 0], [82.4, 'triangle', 0.25, 4], [110.2, 'sine', 0.12, -3]];
    for (const [f, type, g, det] of partials) {
      const o = src(ctx.createOscillator()); o.type = type; o.frequency.value = f; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og); og.connect(df); add(og);
    }
    df.connect(dg); dg.connect(ambBus);
    const ds = ctx.createGain(); ds.gain.value = 0.15; dg.connect(ds); ds.connect(revIn);
    add(df, dg, l4g, ds);
    w.start(t, Math.random() * 1.5); hs.start(t, Math.random() * 1.5);
    for (const s of ambientSources) if (s !== w && s !== hs) s.start(t);
    ambBus.gain.setValueAtTime(0, t);
    ambBus.gain.linearRampToValueAtTime(AMB_LEVEL, t + 2.5);
  }

  function scheduleSuspend() {
    cancelSuspend();
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (ctx && !disposed && volume <= 0 && ctx.state === 'running') ctx.suspend().catch(() => {});
    }, 120);
  }
  function cancelSuspend() { if (suspendTimer !== null) { clearTimeout(suspendTimer); suspendTimer = null; } }

  async function unlock() {
    if (disposed || !AC) { if (!AC) warnOnce('no-audio', 'Web Audio недоступен — звук отключён'); return false; }
    if (unlockPromise) return unlockPromise;
    unlockPromise = (async () => {
      try {
        if (!ctx) build();
        if (ctx.state === 'suspended') await ctx.resume();
        startAmbient();
        if (volume <= 0) scheduleSuspend();
        return ctx.state === 'running' || volume <= 0;
      } catch (err) {
        warnOnce('audio-unlock', 'не удалось запустить звук', err);
        return false;
      } finally {
        unlockPromise = null;
      }
    })();
    return unlockPromise;
  }

  function setVolume(v) {
    volume = clamp01(isNum(Number(v)) ? Number(v) : 0);
    if (!ctx || ctx.state === 'closed') return;
    const t = ctx.currentTime, g = master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(gainFor(volume), t + 0.05);
    if (volume <= 0) {
      for (const vc of voices.slice()) if (!vc.loop) stopVoice(vc, 0.03);
      scheduleSuspend();
    } else {
      cancelSuspend();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  }

  // ---- голоса
  function finishVoice(v) {
    if (v.done) return;
    v.done = true;
    for (const s of v.sources) s.onended = null;
    for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* уже отключён */ } }
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
  }
  function stopVoice(v, fade) {
    if (v.stopping || v.done || !ctx) return;
    v.stopping = true;
    const t = ctx.currentTime, f = Math.max(0.01, fade ?? 0.05);
    try {
      v.out.gain.cancelScheduledValues(t);
      v.out.gain.setValueAtTime(v.out.gain.value, t);
      v.out.gain.linearRampToValueAtTime(0, t + f);
    } catch (e) { /* ignore */ }
    for (const s of v.sources) { try { s.stop(t + f + 0.01); } catch (e) { /* ignore */ } }
    v.end = Math.min(v.end, t + f + 0.02);
  }
  function voice(cat, pos, gain, reverb, dur, loop) {
    if (!ctx || disposed || volume <= 0 || ctx.state !== 'running') return null;
    if (voices.length >= maxVoices * 2) return null; // жёсткий потолок вместе с затухающими голосами
    const lim = LIMITS[cat] || 3;
    const now = ctx.currentTime;
    let same = 0, oldestSame = null, live = 0, oldestAny = null, burst = 0;
    for (const v of voices) {
      if (v.stopping || v.done) continue;
      live++;
      if (v.cat === cat && now - v.t0 < 0.03) burst++;
      if (!v.loop && (!oldestAny || v.t0 < oldestAny.t0)) oldestAny = v;
      if (v.cat === cat) { same++; if (!oldestSame || v.t0 < oldestSame.t0) oldestSame = v; }
    }
    if (!loop && burst >= 2) return null; // не больше двух одинаковых звуков за 30 мс: без «флэма» и лишних узлов
    if (same >= lim) {
      if (loop || !oldestSame || oldestSame.loop) return null; // петли не воруем — иначе дребезг каждый кадр
      stopVoice(oldestSame, 0.04); live--;
    }
    if (live >= maxVoices) {
      if (loop || !oldestAny) return null;
      stopVoice(oldestAny, 0.04);
    }
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = gain * distGain(pos);
    const nodes = [out];
    let tail = out, panner = null;
    if (typeof ctx.createStereoPanner === 'function') {
      panner = ctx.createStereoPanner();
      panner.pan.value = panFor(pos);
      out.connect(panner); tail = panner; nodes.push(panner);
    }
    tail.connect(sfxBus);
    if (reverb > 0) {
      const s = ctx.createGain(); s.gain.value = reverb;
      tail.connect(s); s.connect(revIn); nodes.push(s);
    }
    const v = { cat, t0: t, end: t + dur, loop: !!loop, out, panner, nodes, sources: [], ended: 0, stopping: false, done: false };
    voices.push(v);
    return v;
  }
  function addSource(v, src) {
    v.sources.push(src); v.nodes.push(src);
    src.onended = () => { v.ended++; if (v.ended >= v.sources.length) finishVoice(v); };
  }
  function env(param, t0, attack, peak, dur) {
    const a = Math.max(0.001, attack), p = Math.max(1e-4, peak), end = t0 + Math.max(a + 0.02, dur);
    param.value = 0;
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(p, t0 + a);
    param.exponentialRampToValueAtTime(1e-4, end);
    param.setValueAtTime(0, end + 0.005);
    return end;
  }
  // Слой шума через фильтр. o: {type, filter, f, f2, fT, q, attack, peak, rate}
  function noiseL(v, t0, dur, o) {
    const src = ctx.createBufferSource();
    src.buffer = noise[o.type || 'white']; src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    const f = ctx.createBiquadFilter();
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.f, t0);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t0 + Math.max(0.01, o.fT || dur));
    f.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    const end = env(g.gain, t0, o.attack ?? 0.005, o.peak ?? 0.5, dur);
    src.connect(f); f.connect(g); g.connect(v.out);
    v.nodes.push(f, g); addSource(v, src);
    src.start(t0, Math.random() * 1.8);
    src.stop(end + 0.02);
    return { src, f, g };
  }
  // Тональный слой. o: {type, f, f2, fT, attack, peak, lp, detune, vib:[rate, depth]}
  function toneL(v, t0, dur, o) {
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t0 + Math.max(0.01, o.fT || dur));
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const end = env(g.gain, t0, o.attack ?? 0.005, o.peak ?? 0.2, dur);
    let tail = osc;
    if (o.lp) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; f.Q.value = 0.5;
      osc.connect(f); tail = f; v.nodes.push(f);
    }
    tail.connect(g); g.connect(v.out); v.nodes.push(g);
    addSource(v, osc);
    if (o.vib) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = o.vib[0];
      const lg = ctx.createGain(); lg.gain.value = o.vib[1];
      lfo.connect(lg); lg.connect(osc.frequency); v.nodes.push(lg); addSource(v, lfo);
      lfo.start(t0); lfo.stop(end + 0.02);
    }
    osc.start(t0); osc.stop(end + 0.02);
    return { osc, g };
  }

  // ---- рецепты (у каждого случайная вариация высоты/фильтра, чтобы не звучало одинаково)
  const S = {
    cast(pos) {
      const v = voice('cast', pos, 0.5, 0.22, 0.45); if (!v) return;
      const t = T(), r = rnd(0.94, 1.06);
      noiseL(v, t, 0.2, { type: 'white', filter: 'bandpass', f: 1300 * r, f2: 3800 * r, fT: 0.12, q: 1.3, peak: 0.5 });
      noiseL(v, t, 0.32, { type: 'pink', filter: 'lowpass', f: 900 * r, q: 0.7, attack: 0.012, peak: 0.2 });
      toneL(v, t, 0.24, { type: 'triangle', f: 540 * r, f2: 820 * r, fT: 0.07, peak: 0.06, lp: 2400 });
      toneL(v, t, 0.14, { type: 'sine', f: 190 * r, f2: 85, fT: 0.1, peak: 0.2 });
    },
    boltImpact(pos) {
      const v = voice('impact', pos, 0.55, 0.28, 0.45); if (!v) return;
      const t = T(), r = rnd(0.92, 1.08);
      noiseL(v, t, 0.09, { type: 'white', filter: 'highpass', f: 1800 * r, q: 0.7, peak: 0.55 });
      noiseL(v, t, 0.24, { type: 'pink', filter: 'bandpass', f: 620 * r, q: 0.8, attack: 0.004, peak: 0.45 });
      toneL(v, t, 0.2, { type: 'sine', f: 150 * r, f2: 55, fT: 0.16, peak: 0.4 });
      for (let i = 0; i < 3; i++) {
        noiseL(v, t + 0.02 + i * rnd(0.025, 0.04), 0.035, { type: 'white', filter: 'bandpass', f: rnd(3800, 5600), q: 3, peak: 0.18 });
      }
    },
    orbImpact(pos) {
      const v = voice('impact', pos, 0.6, 0.45, 0.7); if (!v) return;
      const t = T(), r = rnd(0.94, 1.06);
      toneL(v, t, 0.45, { type: 'sine', f: 95 * r, f2: 38, fT: 0.4, peak: 0.55 });
      noiseL(v, t, 0.5, { type: 'brown', filter: 'lowpass', f: 520 * r, q: 0.7, attack: 0.004, peak: 0.8 });
      noiseL(v, t, 0.32, { type: 'white', filter: 'bandpass', f: 3200 * r, q: 6, peak: 0.3 });
      noiseL(v, t, 0.5, { type: 'white', filter: 'bandpass', f: 4700 * r, q: 8, peak: 0.18 });
    },
    orbLaunch(pos) {
      const v = voice('launch', pos, 0.5, 0.3, 0.5); if (!v) return;
      const t = T(), r = rnd(0.94, 1.06);
      noiseL(v, t, 0.38, { type: 'pink', filter: 'bandpass', f: 300 * r, f2: 1500 * r, fT: 0.25, q: 1.1, attack: 0.03, peak: 0.5 });
      toneL(v, t, 0.34, { type: 'sine', f: 70 * r, f2: 150 * r, fT: 0.3, attack: 0.02, peak: 0.28 });
    },
    shieldUp(pos) {
      const v = voice('shield', pos, 0.45, 0.35, 0.9); if (!v) return;
      const t = T(), r = rnd(0.97, 1.03);
      noiseL(v, t, 0.34, { type: 'pink', filter: 'bandpass', f: 380 * r, f2: 1700 * r, fT: 0.22, q: 1.4, attack: 0.02, peak: 0.45 });
      toneL(v, t, 0.8, { type: 'sine', f: 330 * r, attack: 0.03, peak: 0.07, lp: 1600 });
      toneL(v, t, 0.7, { type: 'sine', f: 495 * r, attack: 0.04, peak: 0.05, lp: 1600 });
    },
    shieldDown(pos) {
      const v = voice('shield', pos, 0.4, 0.25, 0.4); if (!v) return;
      const t = T();
      noiseL(v, t, 0.26, { type: 'pink', filter: 'bandpass', f: 1500, f2: 340, fT: 0.2, q: 1.2, peak: 0.3 });
      toneL(v, t, 0.26, { type: 'sine', f: 330, f2: 240, peak: 0.05 });
    },
    block(pos) {
      const v = voice('block', pos, 0.6, 0.4, 0.9); if (!v) return;
      const t = T(), r = rnd(0.96, 1.04);
      noiseL(v, t, 0.06, { type: 'white', filter: 'highpass', f: 1200, q: 0.7, attack: 0.001, peak: 0.55 });
      toneL(v, t, 0.16, { type: 'sine', f: 110 * r, f2: 58, fT: 0.14, peak: 0.38 });
      const parts = [[610, 0.62, 0.1], [1024, 0.48, 0.07], [1597, 0.34, 0.05], [2289, 0.22, 0.03]];
      for (const [f, d, p] of parts) toneL(v, t, d, { type: 'sine', f: f * r, attack: 0.002, peak: p });
    },
    dash(pos, sign) {
      const v = voice('dash', pos, 0.55, 0.15, 0.5); if (!v) return;
      const t = T(), s = sign >= 0 ? 1 : -1;
      const src = ctx.createBufferSource(); src.buffer = noise.pink; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.9;
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(2200, t + 0.12);
      f.frequency.exponentialRampToValueAtTime(520, t + 0.36);
      const g = ctx.createGain();
      const end = env(g.gain, t, 0.06, 0.6, 0.4);
      src.connect(f); f.connect(g); g.connect(v.out);
      v.nodes.push(f, g); addSource(v, src);
      src.start(t, Math.random()); src.stop(end + 0.02);
      if (v.panner) {
        v.panner.pan.setValueAtTime(clamp(-s * 0.35, -1, 1), t);
        v.panner.pan.linearRampToValueAtTime(clamp(s * 0.55, -1, 1), t + 0.35);
      }
      noiseL(v, t, 0.22, { type: 'white', filter: 'highpass', f: 3000, q: 0.6, attack: 0.02, peak: 0.08 });
    },
    windup(pos, p) {
      const kind = (p && p.kind) || 'slam';
      const D = clamp(num(p && p.dur, 0.9), 0.3, 2.5);
      const v = voice('windup', pos, 0.5, 0.35, D + 0.3); if (!v) return;
      const t = T(), r = rnd(0.95, 1.05);
      if (kind === 'orb') {
        toneL(v, t, D + 0.1, { type: 'sine', f: 110 * r, f2: 260 * r, fT: D, attack: D * 0.6, peak: 0.09, vib: [7, 6] });
        noiseL(v, t, D + 0.05, { type: 'white', filter: 'bandpass', f: 1800, f2: 4200, fT: D, q: 2, attack: D * 0.8, peak: 0.07 });
        noiseL(v, t, D + 0.1, { type: 'brown', filter: 'lowpass', f: 300, q: 0.7, attack: D * 0.7, peak: 0.22 });
      } else if (kind === 'nova') {
        for (const f of [220, 330, 440]) toneL(v, t, D + 0.1, { type: 'sine', f: f * r, f2: f * r * 1.25, fT: D, attack: D * 0.85, peak: 0.04 });
        noiseL(v, t, D + 0.1, { type: 'brown', filter: 'lowpass', f: 380, f2: 700, fT: D, q: 0.7, attack: D * 0.8, peak: 0.28 });
      } else {
        noiseL(v, t, D + 0.08, { type: 'brown', filter: 'lowpass', f: 110, f2: 620, fT: D, q: 0.8, attack: D * 0.9, peak: 0.55 });
        noiseL(v, t, D, { type: 'pink', filter: 'bandpass', f: 900 * r, q: 4, attack: D * 0.5, peak: 0.1, rate: 0.8 });
        toneL(v, t, D + 0.1, { type: 'sine', f: 42 * r, f2: 62 * r, fT: D, attack: D * 0.8, peak: 0.3 });
      }
    },
    slam(pos) {
      const v = voice('heavy', pos, 0.8, 0.5, 1.2); if (!v) return;
      const t = T(), r = rnd(0.95, 1.05);
      toneL(v, t, 0.95, { type: 'sine', f: 58 * r, f2: 31, fT: 0.8, attack: 0.004, peak: 0.8 });
      noiseL(v, t, 0.75, { type: 'brown', filter: 'lowpass', f: 760, f2: 180, fT: 0.6, q: 0.7, attack: 0.003, peak: 0.9 });
      for (let i = 0; i < 5; i++) {
        noiseL(v, t + rnd(0.05, 0.5), rnd(0.04, 0.09), { type: 'pink', filter: 'bandpass', f: rnd(1800, 3200), q: 1.2, peak: rnd(0.1, 0.2) });
      }
    },
    nova(pos) {
      const v = voice('heavy', pos, 0.7, 0.6, 1.0); if (!v) return;
      const t = T(), r = rnd(0.95, 1.05);
      noiseL(v, t, 0.45, { type: 'pink', filter: 'bandpass', f: 600, f2: 3200, fT: 0.2, q: 1, attack: 0.01, peak: 0.55 });
      toneL(v, t, 0.6, { type: 'sine', f: 72 * r, f2: 40, fT: 0.5, peak: 0.55 });
      toneL(v, t, 0.6, { type: 'sine', f: 1320 * r, peak: 0.025 });
      toneL(v, t, 0.5, { type: 'sine', f: 1980 * r, peak: 0.018 });
    },
    bossHit(pos, amount) {
      const g = 0.45 * clamp(0.7 + num(amount, 10) / 60, 0.7, 1.25);
      const v = voice('hit', pos, g, 0.3, 0.35); if (!v) return;
      const t = T(), r = rnd(0.92, 1.08);
      noiseL(v, t, 0.08, { type: 'pink', filter: 'highpass', f: 1500 * r, q: 0.7, peak: 0.45 });
      toneL(v, t, 0.13, { type: 'sine', f: 210 * r, f2: 120, fT: 0.1, peak: 0.3 });
      noiseL(v, t, 0.15, { type: 'white', filter: 'bandpass', f: 700 * r, q: 2, attack: 0.002, peak: 0.28 });
    },
    playerHit(pos) {
      const v = voice('hit', pos, 0.6, 0.25, 0.45); if (!v) return;
      const t = T(), r = rnd(0.94, 1.06);
      noiseL(v, t, 0.26, { type: 'brown', filter: 'lowpass', f: 420 * r, q: 0.7, attack: 0.003, peak: 0.8 });
      toneL(v, t, 0.26, { type: 'sine', f: 96 * r, f2: 48, fT: 0.22, peak: 0.55 });
      noiseL(v, t, 0.06, { type: 'white', filter: 'bandpass', f: 1200, q: 1, peak: 0.18 });
    },
    phase(pos) {
      const v = voice('phase', pos, 0.7, 0.7, 2.8); if (!v) return;
      const t = T();
      toneL(v, t, 2.3, { type: 'sine', f: 41.2, attack: 0.45, peak: 0.32 });
      toneL(v, t, 2.2, { type: 'sine', f: 61.7, attack: 0.5, peak: 0.22 });
      noiseL(v, t, 2.0, { type: 'brown', filter: 'lowpass', f: 300, q: 0.7, attack: 0.5, peak: 0.45 });
      for (const f of [246.9, 370.0, 523.3]) toneL(v, t, 2.0, { type: 'sine', f: f * rnd(0.99, 1.01), attack: 0.02, peak: 0.035 });
    },
    burst(pos) {
      const v = voice('burst', pos, 0.75, 0.6, 1.9); if (!v) return;
      const t = T(), r = rnd(0.97, 1.03);
      noiseL(v, t, 0.16, { type: 'pink', filter: 'bandpass', f: 300, f2: 2600, fT: 0.12, q: 1, attack: 0.09, peak: 0.38 });
      toneL(v, t + 0.07, 0.85, { type: 'sine', f: 76 * r, f2: 34, fT: 0.7, attack: 0.004, peak: 0.75 });
      noiseL(v, t + 0.07, 0.6, { type: 'brown', filter: 'lowpass', f: 900, q: 0.7, attack: 0.004, peak: 0.55 });
      const sh = [[440, 1.5, 0.04], [660, 1.3, 0.03], [990, 1.1, 0.022], [1320, 0.9, 0.015]];
      for (const [f, d, p] of sh) toneL(v, t + 0.07, d, { type: 'sine', f: f * r, attack: 0.02, peak: p });
    },
    victory(pos) {
      const v = voice('outcome', pos, 0.6, 0.8, 5.2); if (!v) return;
      const t = T();
      const chord = [146.83, 220.0, 293.66, 369.99];
      chord.forEach((f, i) => toneL(v, t + i * 0.12, 4.6, { type: 'triangle', f, attack: 0.8, peak: 0.06, lp: 1200 }));
      noiseL(v, t, 4.0, { type: 'pink', filter: 'bandpass', f: 800, q: 0.6, attack: 1.2, peak: 0.06 });
    },
    defeat(pos) {
      const v = voice('outcome', pos, 0.6, 0.7, 4.0); if (!v) return;
      const t = T();
      toneL(v, t, 3.4, { type: 'sine', f: 110, f2: 98, fT: 3, attack: 0.3, peak: 0.09, lp: 500 });
      toneL(v, t, 3.4, { type: 'sine', f: 116.5, f2: 103, fT: 3, attack: 0.35, peak: 0.07, lp: 500 });
      noiseL(v, t, 3.0, { type: 'brown', filter: 'lowpass', f: 250, q: 0.7, attack: 0.4, peak: 0.32 });
    },
  };

  const LOOPS = {
    orbLoop(v) {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noise.brown; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = rnd(320, 380); f.Q.value = 1.1;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.12);
      const trem = ctx.createOscillator(); trem.frequency.value = rnd(5, 7);
      const tg = ctx.createGain(); tg.gain.value = 0.12;
      const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = rnd(68, 76);
      const hg = ctx.createGain(); hg.gain.setValueAtTime(0, t); hg.gain.linearRampToValueAtTime(0.12, t + 0.12);
      trem.connect(tg); tg.connect(g.gain);
      src.connect(f); f.connect(g); g.connect(v.out);
      hum.connect(hg); hg.connect(v.out);
      v.nodes.push(f, g, tg, hg);
      addSource(v, src); addSource(v, trem); addSource(v, hum);
      src.start(t, Math.random() * 1.5); trem.start(t); hum.start(t);
    },
    shieldHum(v) {
      const t = ctx.currentTime;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.5;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.15);
      lp.connect(g); g.connect(v.out);
      v.nodes.push(lp, g);
      for (const [f, a] of [[196, 0.05], [198.6, 0.05]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = a;
        o.connect(og); og.connect(lp); v.nodes.push(og); addSource(v, o); o.start(t);
      }
      const n = ctx.createBufferSource(); n.buffer = noise.pink; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 2;
      const ng = ctx.createGain(); ng.gain.value = 0.025;
      n.connect(nf); nf.connect(ng); ng.connect(g);
      v.nodes.push(nf, ng); addSource(v, n); n.start(t, Math.random());
    },
  };
  const LOOP_CFG = { orbLoop: ['orbLoop', 0.5, 0.2], shieldHum: ['shieldHum', 0.5, 0.15] };

  function play(name, pos, param) {
    if (!ctx || disposed || volume <= 0 || ctx.state !== 'running') return;
    const fn = S[name];
    if (!fn) return;
    try { fn(pos, param); } catch (err) { warnOnce('sfx:' + name, 'ошибка синтеза звука', name, err); }
  }
  // Петля живёт, пока её подтверждают каждый кадр; вызов идемпотентен.
  function loop(key, kind, pos) {
    if (!ctx || disposed) return;
    const ex = loops.get(key);
    if (ex) {
      if (ex.done || ex.stopping) { loops.delete(key); }
      else {
        if (ex.panner) ex.panner.pan.setTargetAtTime(panFor(pos), ctx.currentTime, 0.05);
        return;
      }
    }
    const c = LOOP_CFG[kind];
    if (!c) return;
    const v = voice(c[0], pos, c[1], c[2], 1e6, true);
    if (!v) return;
    try { LOOPS[kind](v); loops.set(key, v); } catch (err) { finishVoice(v); warnOnce('loop:' + kind, 'ошибка петли', kind, err); }
  }
  function loopStop(key, fade) {
    const v = loops.get(key);
    if (!v) return;
    loops.delete(key);
    stopVoice(v, fade ?? 0.15);
  }
  function stopLoops() { for (const key of Array.from(loops.keys())) loopStop(key, 0.2); }
  function stopAll() {
    stopLoops();
    for (const v of voices.slice()) stopVoice(v, 0.05);
  }
  function duck(level, time) {
    if (!ctx || !ambBus || !ambientStarted) return;
    const t = ctx.currentTime;
    ambBus.gain.cancelScheduledValues(t);
    ambBus.gain.setValueAtTime(ambBus.gain.value, t);
    ambBus.gain.setTargetAtTime(AMB_LEVEL * clamp01(level), t, Math.max(0.05, time / 3));
  }
  function update() {
    if (!ctx || voices.length === 0) return;
    const now = ctx.currentTime;
    // Страховка: если onended не пришёл, узлы всё равно отключаются.
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (!v.loop || v.stopping) { if (now > v.end + 1.0) finishVoice(v); }
    }
  }
  function state() {
    return {
      available: !!AC, created: !!ctx, state: ctx ? ctx.state : 'none',
      volume, voices: voices.length, activeVoices: voices.filter((v) => !v.stopping && !v.done).length,
      maxVoices, loops: loops.size, ambient: ambientStarted,
      categories: voices.reduce((m, v) => { m[v.cat] = (m[v.cat] || 0) + 1; return m; }, {}),
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelSuspend();
    for (const v of voices.slice()) {
      for (const s of v.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
      finishVoice(v);
    }
    loops.clear();
    for (const s of ambientSources) { try { s.stop(); } catch (e) { /* ignore */ } }
    for (const n of ambientNodes) { try { n.disconnect(); } catch (e) { /* ignore */ } }
    ambientSources.length = 0; ambientNodes.length = 0;
    for (const n of [sfxBus, ambBus, revIn, conv, revOut, comp, master]) { if (n) { try { n.disconnect(); } catch (e) { /* ignore */ } } }
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
    ctx = null; noise = null;
  }

  return { unlock, setVolume, play, loop, loopStop, stopLoops, stopAll, duck, update, state, dispose };
}
