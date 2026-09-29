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
 * [v2] Сотворение и бросок (контракт 6):
 *  - snapshot.player.conjure {kind:'orb'|'prism', size, charge} — заклинание между руками героя:
 *    ОРБ — слоистая сфера (горячее ядро, френель-оболочка с текущими прожилками, армиллярные
 *    кольца рун, закрученные искры, треск разрядов, растущий с зарядом); ПРИЗМА — вращающийся
 *    гранёный кристалл (светящиеся рёбра, внутренний кристалл, осколки на орбите, блики, лучи).
 *    Под ногами — круг сотворения. Звук — петля, высота и фильтр которой идут за зарядом.
 *  - снаряды игрока kind 'sphere' / 'prism' — то же тело в полёте, шлейф, вращение, треск/блики;
 *    попадание — вспышка, ударная волна, кольцо на земле, осколки, свет, тряска по размеру.
 *  - player_cast {ability:'throw'} — вспышка выпуска, волна вперёд, свист с высотой по размеру.
 *
 * Экспорт: createEffects({THREE, scene, camera, renderer, config}) и API_VERSION.
 */

export const API_VERSION = 'ASHEN_V1';

// [VFX] V6 «больше магии»: новые эффекты — в modules/fx/*.js, поверх этого модуля (откат — настройка fxMagic:false).
import { createFxV6 } from './fx/index.js';

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
const SPELL_CAP = 5;               // тел заклинаний (1 сотворённое + брошенные в полёте)
const ARC_MAX = 14;                // разрядов/лучей одновременно (одна сетка на всё)
const ARC_PTS = 9;                 // точек в одном разряде
const GLINT_CAP = 12;              // бликов призмы (спрайты)
const SHOCK_CAP = 8;               // колец ударной волны
const CONJ_R_MIN = 0.15, CONJ_R_MAX = 0.45; // радиус сотворённого по size 0..1, м (при пороге bloom 1.0 крупнее — засвечивает героя)

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
  // [v2] призма: бледное золото и белый свет (тот же тёплый тон героя, но «стекло»)
  prismCore: 0xfff8ea,
  prismEdge: 0xf4e0ae,
  prismFace: 0xd8c08a,
  prismGlint: 0xfffdf6,
});
// Сырые sRGB-значения для ShaderMaterial (у шейдеров нет цветового преобразования на выходе).
const RAW = {};
for (const k of Object.keys(PAL)) RAW[k] = hexToRaw(PAL[k]);
Object.freeze(RAW);

// Уровни качества меняют реальные параметры. Телеграфы и «существенные» частицы попаданий
// не зависят от decor и присутствуют на всех уровнях.
// [v2] arcs — разрядов вокруг орба, shards — осколков на орбите призмы, rings — армиллярных колец,
// spell — множитель частиц заклинания, glints — частота бликов призмы.
const QUALITY_PRESETS = Object.freeze({
  low: Object.freeze({ glowCap: 280, dustCap: 140, decor: 0.3, trailPts: 6, ghosts: 2, light: false, shell: false, projSparks: 0, motes: 0, arcs: 2, shards: 0, rings: 1, spell: 0.35, glints: 0.4 }),
  medium: Object.freeze({ glowCap: 650, dustCap: 300, decor: 0.7, trailPts: 10, ghosts: 3, light: true, shell: true, projSparks: 0.6, motes: 0.6, arcs: 4, shards: 4, rings: 2, spell: 0.7, glints: 0.75 }),
  high: Object.freeze({ glowCap: MAX_GLOW, dustCap: MAX_DUST, decor: 1.0, trailPts: 14, ghosts: 4, light: true, shell: true, projSparks: 1.0, motes: 1.0, arcs: 6, shards: 6, rings: 2, spell: 1.0, glints: 1.0 }),
});

// ------------------------------------------------------------------ GLSL
// Код пишется в стиле GLSL ES 1.0 (gl_FragColor/varying); three.js сам переводит его для WebGL2.
// fwidth/derivatives не используются, чтобы шейдеры компилировались и в WebGL1-режиме старых three.

const GLSL_BAND = `
float band(float x, float c, float w, float s) {
  return 1.0 - smoothstep(w, w + s, abs(x - c));
}
`;

// [v2] Выход шейдера, не зависящий от конвейера. Шейдеры по-прежнему считают «экранные» (sRGB)
// значения. Перед выходом значение переводится в линейное, а стандартный colorspace_fragment
// three.js возвращает его в пространство вывода. Рендер прямо в canvas (sRGB): результат прежний
// с точностью до округления (OETF∘EOTF = id). Рендер в линейную цель постобработки (core/postfx.js,
// EffectComposer + OutputPass): цвета не проходят гамму дважды и не «выцветают».
const GLSL_OUT = `
  gl_FragColor.rgb = sRGBTransferEOTF(vec4(max(gl_FragColor.rgb, vec3(0.0)), 1.0)).rgb;
  #include <colorspace_fragment>
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
${GLSL_OUT}
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
${GLSL_OUT}
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
${GLSL_OUT}
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
${GLSL_OUT}
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
${GLSL_OUT}
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
${GLSL_OUT}
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
${GLSL_OUT}
}
`;

const FS_PARTICLE_DUST = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(0.35, 1.0, d)));
${GLSL_OUT}
}
`;

// ---------------------------------------------------------------- [v2] шейдеры заклинаний

// Вершинные шейдеры тел заклинаний: нормаль/взгляд в пространстве камеры, позиция в
// пространстве объекта; у кристалла ещё барицентрика (рёбра).
const VS_SPELL = `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const VS_CRYSTAL = `
attribute vec3 aBary;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying vec3 vB;
void main() {
  vP = position;
  vB = aBary;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

// Оболочка орба: френель-кромка + текущие по поверхности прожилки (3D value noise, закрутка
// по широте), «просвечивающее» ядро в центре диска. Аддитивно.
const FS_ORB = `
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uDeep;
uniform float uTime;
uniform float uCharge;
uniform float uOpacity;
uniform float uSeed;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(h3(i), h3(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(h3(i + vec3(0.0, 1.0, 0.0)), h3(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(h3(i + vec3(0.0, 0.0, 1.0)), h3(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(h3(i + vec3(0.0, 1.0, 1.0)), h3(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
void main() {
  float ndv = clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.4);
  vec3 p = normalize(vP);
  float sw = uTime * (0.7 + 1.8 * uCharge) + p.y * 2.6;
  float s = sin(sw), c = cos(sw);
  vec3 q = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  float n = vnoise(q * 3.1 + vec3(0.0, uTime * 0.8, uSeed)) * 0.62 + vnoise(q * 7.3 - vec3(uTime * 1.4, 0.0, uSeed)) * 0.38;
  float veins = pow(1.0 - abs(n * 2.0 - 1.0), 7.0);
  float center = pow(ndv, 2.5);
  float pulse = 0.85 + 0.15 * sin(uTime * (5.0 + 7.0 * uCharge));
  vec3 col = uRim * fres * (1.0 + 0.7 * uCharge) * pulse
           + uCore * veins * (0.3 + 0.7 * uCharge) * (0.35 + 0.65 * ndv)
           + uDeep * center * 0.32
           + uCore * center * center * (0.15 + 0.45 * uCharge);
  gl_FragColor = vec4(col, uOpacity);
${GLSL_OUT}
}
`;

// Кристалл: светящиеся рёбра по барицентрике (без производных), грани с внутренними полосами
// «преломлённого» света, блик бегущего виртуального источника, френель. Аддитивно, обе стороны:
// задние рёбра просвечивают — кристалл читается прозрачным.
const FS_CRYSTAL = `
uniform vec3 uEdge;
uniform vec3 uFace;
uniform vec3 uCore;
uniform float uTime;
uniform float uCharge;
uniform float uOpacity;
uniform float uEdgeW;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying vec3 vB;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(vV);
  float ndv = abs(dot(n, v));
  float e = min(min(vB.x, vB.y), vB.z);
  float edge = 1.0 - smoothstep(uEdgeW * 0.35, uEdgeW, e);
  float edgeGlow = 1.0 - smoothstep(0.0, uEdgeW * 4.5, e);
  vec3 L = normalize(vec3(sin(uTime * 1.7), 0.55, cos(uTime * 1.7)));
  vec3 H = normalize(L + v);
  float spec = pow(max(dot(n, H), 0.0), 28.0);
  float fres = pow(1.0 - ndv, 1.7);
  float bands = 0.5 + 0.5 * sin(vP.y * 11.0 - uTime * 3.2 + vP.x * 6.0 + vP.z * 4.0);
  float front = gl_FrontFacing ? 1.0 : 0.45;
  vec3 col = uFace * (0.08 + 0.34 * fres + 0.14 * bands * (0.4 + uCharge)) * front
           + uEdge * (edge * 1.15 + edgeGlow * 0.3) * (0.65 + 0.55 * uCharge) * (0.55 + 0.45 * front)
           + uCore * spec * (0.7 + 0.9 * uCharge) * front;
  gl_FragColor = vec4(col, uOpacity);
${GLSL_OUT}
}
`;

// Армиллярное кольцо рун / круг сотворения: две окружности, насечки-глифы, дуга заряда.
const FS_SPELLRING = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uOpacity;
uniform float uTime;
uniform float uCharge;
uniform float uSeg;
uniform float uInner;
varying vec2 vUv;
${GLSL_BAND}
float h1(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x + 1e-5);
  float s = 0.02;
  float outer = band(r, 0.93, 0.014, s);
  float inner = band(r, 0.72, 0.008, s) * uInner;
  float seg = (a + uTime) / 6.2831853 * uSeg;
  float k = floor(seg);
  float u = fract(seg);
  float v = (r - 0.76) / 0.13;
  float glyph = 0.0;
  if (v > 0.0 && v < 1.0 && u > 0.18 && u < 0.82) {
    float gu = (u - 0.18) / 0.64;
    float hA = h1(k), hB = h1(k + 17.0);
    glyph = band(gu, 0.5, 0.08, 0.06) * step(0.35, hA) + band(v, mix(0.3, 0.7, step(0.5, hB)), 0.08, 0.06) * step(0.3, hB);
    glyph = clamp(glyph, 0.0, 1.0) * uInner;
  }
  float ang01 = fract(-a / 6.2831853 + 0.25);
  float fill = step(ang01, uCharge) * band(r, 0.93, 0.03, s);
  vec3 col = uColor * (outer * 0.95 + inner * 0.7 + glyph * 0.6) + uHot * fill * 1.1;
  gl_FragColor = vec4(col, uOpacity);
${GLSL_OUT}
}
`;

// Ударная волна: кольцо, которое тоньше к концу; неровная кромка; мягкое «стекло» внутри.
const FS_SHOCK = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uOpacity;
uniform float uProg;
uniform float uSeed;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x + 1e-5);
  float w = mix(0.2, 0.03, uProg);
  float n = 0.72 + 0.28 * sin(a * 9.0 + uSeed) * sin(a * 23.0 - uSeed * 2.0);
  float ring = smoothstep(0.93 - w, 0.93, r) * (1.0 - smoothstep(0.93, 0.985, r));
  float haze = smoothstep(0.25, 0.93, r) * (1.0 - smoothstep(0.9, 0.96, r)) * 0.22;
  vec3 col = uColor * (ring * n + haze) + uHot * ring * n * (1.0 - uProg) * 0.9;
  gl_FragColor = vec4(col, uOpacity);
${GLSL_OUT}
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

// [v2] Гранёный кристалл: неиндексированная геометрия (нормали граней = плоское освещение)
// и барицентрика aBary для рёбер в шейдере. 'octa' вытянут по Y (остриё кристалла).
function makeCrystalGeometry(THREE, kind) {
  let g = kind === 'tetra' ? new THREE.TetrahedronGeometry(1, 0) : new THREE.OctahedronGeometry(1, 0);
  if (g.index) { const ng = g.toNonIndexed(); g.dispose(); g = ng; }
  if (kind !== 'tetra') g.scale(0.7, 1.28, 0.7);
  const n = g.attributes.position.count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
  g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Лента из count полос по pts точек (2 вершины на точку), индексы — заранее.
function makeStripGeometry(THREE, count, pts) {
  const g = new THREE.BufferGeometry();
  const P = new Float32Array(count * pts * 2 * 3), C = new Float32Array(count * pts * 2 * 3);
  const pa = new THREE.BufferAttribute(P, 3), ca = new THREE.BufferAttribute(C, 3);
  pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pa); g.setAttribute('color', ca);
  const idx = [];
  for (let s = 0; s < count; s++) {
    const o = s * pts * 2;
    for (let i = 0; i < pts - 1; i++) {
      const a = o + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
  }
  g.setIndex(idx);
  g.setDrawRange(0, 0);
  return { g, P, C, pa, ca };
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
    // [v2] тела заклинаний
    sphereHi: new THREE.SphereGeometry(1, 40, 28),
    crystal: makeCrystalGeometry(THREE, 'octa'),
    crystalInner: makeCrystalGeometry(THREE, 'tetra'),
    sigil: new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2),
  };
  const Y_AXIS = new V3(0, 1, 0);
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  const _e1 = new THREE.Euler();
  const _w1 = new V3(), _w2 = new V3(), _w3 = new V3(), _w4 = new V3(); // [v2] заклинания (не пересекаются с _s*/_t*)
  const _ps = new V3();  // только внутри poseSpell (осколки)
  const _sp = new V3();  // только внутри updateSpellProj (точка показа тела)

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
    // [v2] заклинания
    orb: new THREE.ShaderMaterial({
      uniforms: {
        uCore: colorU(), uRim: colorU(), uDeep: colorU(), uTime: { value: 0 }, uCharge: { value: 0 },
        uOpacity: { value: 1 }, uSeed: { value: 0 },
      },
      vertexShader: VS_SPELL, fragmentShader: FS_ORB,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide, blending: THREE.AdditiveBlending,
    }),
    crystal: new THREE.ShaderMaterial({
      uniforms: {
        uEdge: colorU(), uFace: colorU(), uCore: colorU(), uTime: { value: 0 }, uCharge: { value: 0 },
        uOpacity: { value: 1 }, uEdgeW: { value: 0.045 },
      },
      vertexShader: VS_CRYSTAL, fragmentShader: FS_CRYSTAL,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
    ring: new THREE.ShaderMaterial({
      uniforms: {
        uColor: colorU(), uHot: colorU(), uOpacity: { value: 1 }, uTime: { value: 0 }, uCharge: { value: 0 },
        uSeg: { value: 12 }, uInner: { value: 1 },
      },
      vertexShader: VS_UV, fragmentShader: FS_SPELLRING,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
    shock: new THREE.ShaderMaterial({
      uniforms: { uColor: colorU(), uHot: colorU(), uOpacity: { value: 1 }, uProg: { value: 0 }, uSeed: { value: 0 } },
      vertexShader: VS_UV, fragmentShader: FS_SHOCK,
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
  const LIN = {
    bolt: new THREE.Color(PAL.heroAmber), orb: new THREE.Color(PAL.guardCold),
    sphere: new THREE.Color(PAL.heroAmber), prism: new THREE.Color(PAL.prismEdge),
    arc: new THREE.Color(PAL.heroCore), arcHot: new THREE.Color(PAL.prismGlint), ray: new THREE.Color(PAL.prismCore),
  };

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
    if (v6 && v6.enabled) { v6.kit.light(pos, { color: hex, intensity: strength, dur, range: 14 }); return; } // [VFX] пул света V6
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
  const playerGround = (out) => out.set(fi.player.x, fi.player.y, fi.player.z); // земля под героем (большая карта — рельеф)
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

  const flashPool = makePool(28, () => {
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

  // ---------------------------------------------------------------- [VFX] слой V6 (modules/fx)
  // Якоря героя: C5 heroModel.getAnchors() (Object3D) → world.getAnchors() (точки) → расчёт по снимку.
  let anchorSrc = null, anchorFrame = -1, anchorNow = null, frameNo = 0, groundFn = null, lastInput = null;
  let remoteAnchorSrc = null, remoteFrame = -1, remoteNow = null;
  function remoteAnchorsNow() {
    if (remoteFrame === frameNo) return remoteNow;
    remoteFrame = frameNo; remoteNow = null;
    if (typeof remoteAnchorSrc === 'function') { try { remoteNow = remoteAnchorSrc() || null; } catch (e) { remoteNow = null; } }
    return remoteNow;
  }
  const C5_NAMES = { handR: 'handR', handL: 'handL', chest: 'chest', head: 'head', staffTip: 'staffTip', bowSocket: 'bowSocket' };
  const WORLD_NAMES = { handR: 'heroHandR', handL: 'heroHandL', chest: 'heroChest', head: 'heroHead', feet: 'heroFeet', staffTip: 'heroHandR', bowSocket: 'heroHandL' };
  const _an = new V3(), _af = new V3();
  function anchorsNow() {
    if (anchorFrame === frameNo) return anchorNow;
    anchorFrame = frameNo; anchorNow = null;
    if (typeof anchorSrc === 'function') { try { anchorNow = anchorSrc() || null; } catch (e) { anchorNow = null; } }
    return anchorNow;
  }
  function resolveAnchor(name, out, remote) {
    const opp = snap && snap.opponent;
    if (remote) {
      if (!opp || !hasVec(opp.position)) return null;
      const o = opp.position;
      // модель соперника (C5-якоря remotePlayer): настоящие руки, если модель прикреплена к сцене
      const ra = name !== 'feet' ? remoteAnchorsNow() : null;
      const ro = ra && C5_NAMES[name] && ra[C5_NAMES[name]];
      if (ro && ro.parent && typeof ro.getWorldPosition === 'function') {
        ro.getWorldPosition(out);
        if (isNum(out.x) && Math.hypot(out.x - o.x, out.z - o.z) < 2.5) return out;
      }
      _af.set(fi.player.x - o.x, 0, fi.player.z - o.z);
      if (_af.lengthSq() < 1e-6) _af.set(0, 0, 1);
      _af.normalize();
      const rx = -_af.z, rz = _af.x;
      if (name === 'feet') return out.set(o.x, o.y, o.z);
      if (name === 'chest') return out.set(o.x + _af.x * 0.1, o.y + CHEST_H, o.z + _af.z * 0.1);
      if (name === 'head') return out.set(o.x, o.y + HERO_H - 0.1, o.z);
      const side = name === 'handL' || name === 'bowSocket' ? -1 : 1;
      return out.set(o.x + rx * 0.36 * side + _af.x * 0.42, o.y + HAND_H, o.z + rz * 0.36 * side + _af.z * 0.42);
    }
    if (name === 'feet') return out.set(fi.player.x, fi.player.y, fi.player.z);
    const a = anchorsNow();
    if (a) {
      const c5 = C5_NAMES[name] && a[C5_NAMES[name]];
      if (c5 && typeof c5.getWorldPosition === 'function') { c5.getWorldPosition(out); if (isNum(out.x)) return out; }
      const w = WORLD_NAMES[name] && a[WORLD_NAMES[name]];
      if (hasVec(w)) return out.set(w.x, w.y, w.z);
    }
    if (name === 'chest') return chestOf(out);
    if (name === 'head') return out.set(fi.player.x, fi.player.y + HERO_H - 0.1, fi.player.z);
    return handOf(out, name === 'handL' || name === 'bowSocket' ? -1 : 1);
  }
  let v6 = null;
  if (liveSetting('fxMagic') !== false) {
    try {
      v6 = createFxV6({
        THREE, root, camera, renderer, quality: liveSetting('quality') || 'medium', lightUnit: LIGHT_UNIT,
        reducedMotion: () => reducedMotion(),
        onShake: (v) => addTrauma(v), onKick: (dir, disp) => addKick(_an.copy(dir), disp),
        anchor: resolveAnchor,
        groundY: (x, z, fb) => (typeof groundFn === 'function' ? groundFn(x, z) : fb),
        legacy: { flash: (...a) => fxFlash(...a), ring: (...a) => fxRing(...a), wall: (...a) => fxWall(...a), sparks: (...a) => sparks(...a), audio: (n, p, x) => audio.play(n, p, x), RAW, PAL },
      });
      flashLight.visible = false; // свет вспышек — пул V6
    } catch (e) { v6 = null; warnOnce('v6', 'слой V6 не создан, старые эффекты:', e); }
  }
  const v6on = (key) => !!(v6 && v6.enabled && v6.suppressed(key));

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

  // [ASHEN_V3] купол бастиона (печать «Врата») и рамка метки цели (печать «Рамка») — живут по снимку
  const domeMat = tpl.fresnel.clone();
  setRaw(domeMat.uniforms.uColor.value, RAW.heroGold);
  domeMat.uniforms.uPower.value = 1.8; domeMat.uniforms.uBase.value = 0.04; domeMat.uniforms.uOpacity.value = 0;
  const domeMesh = new THREE.Mesh(geo.sphere, domeMat);
  domeMesh.visible = false; domeMesh.renderOrder = 6; root.add(domeMesh);
  const markMat = new THREE.LineBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  markMat.color.multiplyScalar(2.4);
  const markGeo = (() => {
    const g = new THREE.BufferGeometry(), v = [], L = 0.32;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { v.push(sx, sy, 0, sx - sx * L, sy, 0, sx, sy, 0, sx, sy - sy * L, 0); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    return g;
  })();
  const markMesh = new THREE.LineSegments(markGeo, markMat);
  markMesh.visible = false; markMesh.renderOrder = 26; root.add(markMesh);
  const sig = { dome: 0, domePulse: 0, mark: 0, vortexPulse: 0, auraT: 0 };
  function syncSigils(dt) {
    const pl = snap && snap.player, bo = snap && snap.boss;
    const playing = fi.status === 'playing';
    const wantDome = !!(pl && pl.bastion && playing);
    const wantMark = !!(bo && bo.marked && playing && bo.action !== 'dead');
    if (dt > 0) {
      sig.dome += ((wantDome ? 1 : 0) - sig.dome) * (1 - Math.exp(-dt * (wantDome ? 10 : 5)));
      sig.mark += ((wantMark ? 1 : 0) - sig.mark) * (1 - Math.exp(-dt * (wantMark ? 10 : 5)));
      sig.domePulse = Math.max(0, sig.domePulse - dt * 3);
    }
    domeMesh.visible = sig.dome > 0.01 && !v6on('dome');
    if (domeMesh.visible) {
      const left = pl && isNum(pl.bastionRemaining) ? pl.bastionRemaining : 0;
      const blink = left > 0 && left < 1.2 ? 0.6 + 0.4 * Math.sin(clock * 18) : 1;
      domeMesh.position.set(fi.player.x, fi.player.y + 0.9, fi.player.z);
      domeMesh.scale.set(1.35, 1.25, 1.35);
      domeMat.uniforms.uOpacity.value = (0.3 + 0.35 * sig.domePulse) * sig.dome * blink * (reducedMotion() ? 0.8 : 1);
    }
    // [V3] вихрь / лечение / замедление Регента — редкие короткие вспышки, пока действуют
    sig.auraT -= dt;
    if (playing && sig.auraT <= 0 && dt > 0) {
      sig.auraT = 0.28;
      if (pl && pl.vortex && !v6on('vortex')) {
        const a = clock * 9;
        for (let i = 0; i < 3; i++) {
          const aa = a + i * TAU / 3, r = 1.2 + 0.4 * Math.sin(clock * 3 + i);
          _s2.set(fi.player.x + Math.sin(aa) * r, GROUND_Y + 0.5 + 0.3 * i, fi.player.z + Math.cos(aa) * r);
          fxFlash(_s2, PAL.guardCold, 0.15, 0.5, 0.3, { opacity: 0.7, pull: 0.1 });
        }
      }
      if (pl && pl.regen && !v6on('regen')) {
        _s2.set(fi.player.x, GROUND_Y + 0.2, fi.player.z);
        _dir.set(0, 1, 0);
        sparks(_s2, { dir: _dir, count: 4, spread: 0.8, speed: [0.5, 1.4], rgb: RAW.heroGold, life: 1.0, size: 0.04, gravity: -0.3, drag: 0.8 });
      }
      if (bo && bo.slowed && !v6on('slow')) {
        _s2.set(fi.boss.x, GROUND_Y + 0.05, fi.boss.z);
        fxRing(_s2, 2.0, 2.6, 0.5, RAW.guardCold, RAW.guardCore, 0.35, 3);
      }
    }
    markMesh.visible = sig.mark > 0.01 && !!camera && !v6on('mark');
    if (markMesh.visible) {
      const c = bossCoreOf(_s1);
      markMesh.position.copy(c);
      if (camera) markMesh.quaternion.copy(camera.quaternion);
      const sp = reducedMotion() ? 0 : Math.sin(clock * 4) * 0.08;
      markMesh.scale.setScalar(2.1 * (1.15 - 0.15 * sig.mark) + sp);
      markMat.opacity = 0.9 * sig.mark;
    }
  }

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
    diskMesh.visible = vis && !v6on('shield');
    shellMesh.visible = vis && Q.shell && !v6on('shield');
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

  // ================================================================ [v2] заклинания
  // ---------------------------------------------------------------- тело: орб или призма
  // Одно и то же тело показывает сотворённое заклинание между рук и брошенный снаряд.
  const spellItems = [];
  function makeSpellBody() {
    const g = new THREE.Group();
    g.name = 'ashen-fx-spell';
    g.visible = false;
    const shell = new THREE.Mesh(geo.sphereHi, tpl.orb.clone());
    const su = shell.material.uniforms;
    setRaw(su.uCore.value, RAW.heroCore); setRaw(su.uRim.value, RAW.heroAmber); setRaw(su.uDeep.value, RAW.heroEmber);
    su.uSeed.value = Math.random() * 50;
    const core = new THREE.Mesh(geo.sphere, basicMat(PAL.heroCore, 1));
    const coreGlow = new THREE.Sprite(spriteMat(TEX.glow, PAL.heroCore, 0.9));
    const halo = new THREE.Sprite(spriteMat(TEX.glow, PAL.heroAmber, 0.4));
    // «Свет сквозь тело»: слабый ореол без теста глубины — сотворённое у груди героя видно, даже
    // когда камера за спиной перекрывает его плечом (только у сотворённого, не у снаряда).
    const bleed = new THREE.Sprite(spriteMat(TEX.glow, PAL.heroAmber, 0.2));
    bleed.material.depthTest = false;
    const rings = [new THREE.Mesh(geo.disk, tpl.ring.clone()), new THREE.Mesh(geo.disk, tpl.ring.clone())];
    for (const rmesh of rings) { const u = rmesh.material.uniforms; setRaw(u.uColor.value, RAW.heroGold); setRaw(u.uHot.value, RAW.heroCore); }
    rings[1].material.uniforms.uSeg.value = 9; rings[1].material.uniforms.uInner.value = 0.55;
    const crystal = new THREE.Mesh(geo.crystal, tpl.crystal.clone());
    const cu = crystal.material.uniforms;
    setRaw(cu.uEdge.value, RAW.prismEdge); setRaw(cu.uFace.value, RAW.prismFace); setRaw(cu.uCore.value, RAW.prismGlint);
    const inner = new THREE.Mesh(geo.crystalInner, tpl.crystal.clone());
    const iu = inner.material.uniforms;
    setRaw(iu.uEdge.value, RAW.prismCore); setRaw(iu.uFace.value, RAW.heroAmber); setRaw(iu.uCore.value, RAW.prismGlint);
    iu.uEdgeW.value = 0.07;
    const shardMat = tpl.crystal.clone();
    setRaw(shardMat.uniforms.uEdge.value, RAW.prismEdge); setRaw(shardMat.uniforms.uFace.value, RAW.prismFace); setRaw(shardMat.uniforms.uCore.value, RAW.prismGlint);
    shardMat.uniforms.uEdgeW.value = 0.09;
    const shards = [];
    for (let k = 0; k < 6; k++) shards.push(new THREE.Mesh(geo.crystalInner, shardMat));
    const star = new THREE.Sprite(spriteMat(TEX.flare, PAL.prismCore, 0.7));
    const order = [[shell, 22], [core, 21], [coreGlow, 23], [halo, 23], [bleed, 27], [rings[0], 22], [rings[1], 22], [crystal, 22], [inner, 21], [star, 23]];
    for (const [o, ro] of order) { o.renderOrder = ro; g.add(o); }
    for (const s of shards) { s.renderOrder = 22; g.add(s); }
    root.add(g);
    return {
      g, shell, core, coreGlow, halo, bleed, rings, crystal, inner, shards, shardMat, star,
      active: false, kind: 'orb', ringA: rnd(0, TAU), ringB: rnd(0, TAU), spinA: rnd(0, TAU), spinB: 0, shardA: rnd(0, TAU), seed: rnd(0, TAU),
    };
  }
  function setSpellKind(b, kind) {
    b.kind = kind === 'prism' ? 'prism' : 'orb';
    const orb = b.kind === 'orb';
    b.shell.visible = orb; b.core.visible = orb; b.coreGlow.visible = orb;
    b.rings[0].visible = orb; b.rings[1].visible = orb && Q.rings > 1;
    b.crystal.visible = !orb; b.inner.visible = !orb; b.star.visible = !orb;
    for (let k = 0; k < b.shards.length; k++) b.shards[k].visible = !orb && k < Q.shards;
    b.halo.material.color.setHex(orb ? PAL.heroAmber : PAL.prismEdge);
    b.bleed.material.color.setHex(orb ? PAL.heroAmber : PAL.prismCore);
  }
  function acquireSpell(kind) {
    let b = null;
    for (let i = 0; i < spellItems.length; i++) if (!spellItems[i].active) { b = spellItems[i]; break; }
    if (!b) {
      if (spellItems.length >= SPELL_CAP) return null;
      b = makeSpellBody();
      spellItems.push(b);
    }
    b.active = true;
    setSpellKind(b, kind);
    b.g.visible = true;
    return b;
  }
  function releaseSpell(b) { if (b) { b.active = false; b.g.visible = false; } }

  /**
   * Поза тела на кадр. r — радиус (м), charge 0..1, vis 0..1 — общая видимость,
   * flight — в полёте (быстрее вращение, заряд «полный»), dir — единичное направление полёта.
   */
  function poseSpell(b, pos, r, charge, vis, dt, flight, dir, bleed) {
    const rm = reducedMotion();
    const t = clock;
    const spd = rm ? 0.35 : 1;
    const ch = flight ? 1 : charge;
    const pulse = 1 + (rm ? 0.012 : 0.03 + 0.06 * ch) * Math.sin(t * (6 + 8 * ch) + b.seed);
    const flick = rm ? 1 : 0.9 + 0.1 * Math.sin(t * 41 + b.seed * 3) * Math.sin(t * 17.3 + b.seed);
    b.g.position.copy(pos);
    b.halo.scale.setScalar(r * (2.3 + 1.3 * ch) * flick);
    b.halo.material.opacity = vis * (0.14 + 0.2 * ch);
    b.bleed.visible = !!bleed && vis > 0.01;
    if (b.bleed.visible) {
      b.bleed.scale.setScalar(r * 2.3 * flick);
      b.bleed.material.opacity = vis * (0.1 + 0.1 * ch);
    }
    if (b.kind === 'orb') {
      b.shell.scale.setScalar(r * pulse);
      const su = b.shell.material.uniforms;
      su.uTime.value = t * spd + b.seed; su.uCharge.value = ch; su.uOpacity.value = vis * 0.95;
      b.core.scale.setScalar(r * (0.28 + 0.14 * ch) * flick);
      b.core.material.opacity = vis;
      b.coreGlow.scale.setScalar(r * (1.5 + 0.9 * ch) * flick);
      b.coreGlow.material.opacity = vis * (0.65 + 0.35 * ch);
      // армиллярные кольца: наклонены по-разному, вращаются быстрее с зарядом и в полёте
      const w = (flight ? 6 : 0.7 + 2.4 * ch) * spd;
      b.ringA += dt * w; b.ringB -= dt * w * 1.37;
      const R0 = b.rings[0], R1 = b.rings[1];
      R0.rotation.set(1.15 + 0.25 * Math.sin(b.ringA * 0.31), b.ringA, 0.35);
      R1.rotation.set(-0.5, b.ringB * 0.6, 1.2 + 0.2 * Math.sin(b.ringB * 0.4));
      R0.scale.setScalar(r * 1.62 * pulse);
      R1.scale.setScalar(r * 1.95 * pulse);
      for (let i = 0; i < 2; i++) {
        const u = b.rings[i].material.uniforms;
        u.uTime.value = t * (i ? -0.45 : 0.6) * spd; u.uCharge.value = ch;
        u.uOpacity.value = vis * (i ? 0.5 : 0.75) * (0.45 + 0.55 * ch);
      }
      return;
    }
    // призма
    b.spinA += dt * (flight ? 11 : 0.9 + 2.6 * ch) * spd;
    b.spinB -= dt * (flight ? 7 : 1.5 + 2.2 * ch) * spd;
    b.shardA += dt * (flight ? 8 : 1.1 + 1.9 * ch) * spd;
    if (flight && dir) {
      _qa.setFromUnitVectors(Y_AXIS, dir);
      _qb.setFromAxisAngle(Y_AXIS, b.spinA);
      b.crystal.quaternion.multiplyQuaternions(_qa, _qb);
    } else {
      _e1.set(0.14 * Math.sin(t * 0.9 * spd + b.seed), b.spinA, 0.1 * Math.cos(t * 0.7 * spd + b.seed));
      b.crystal.quaternion.setFromEuler(_e1);
      _qa.identity();
    }
    b.crystal.scale.setScalar(r * pulse);
    _e1.set(b.spinB * 0.7, b.spinB, 0.4);
    b.inner.quaternion.setFromEuler(_e1);
    b.inner.scale.setScalar(r * (0.4 + 0.12 * ch));
    const cu = b.crystal.material.uniforms, iu = b.inner.material.uniforms, hu = b.shardMat.uniforms;
    cu.uTime.value = t * spd + b.seed; cu.uCharge.value = ch; cu.uOpacity.value = vis;
    iu.uTime.value = t * spd * 1.3; iu.uCharge.value = ch; iu.uOpacity.value = vis * 0.9;
    hu.uTime.value = t * spd; hu.uCharge.value = ch; hu.uOpacity.value = vis * 0.85;
    b.star.scale.setScalar(r * (2.2 + 2.4 * ch) * flick);
    b.star.material.rotation = b.spinA * 0.25;
    b.star.material.opacity = vis * (0.4 + 0.45 * ch);
    const n = Math.min(Q.shards, b.shards.length);
    for (let k = 0; k < n; k++) {
      const sh = b.shards[k];
      const ang = b.shardA + (k * TAU) / n;
      const rr = r * (1.55 + 0.18 * Math.sin(t * 1.3 * spd + k * 1.7));
      _ps.set(Math.cos(ang) * rr, r * 0.4 * Math.sin(ang * 2 + k), Math.sin(ang) * rr);
      if (flight) _ps.applyQuaternion(_qa);
      sh.position.copy(_ps);
      sh.rotation.set(ang * 2 + k, ang * 3, k);
      sh.scale.setScalar(r * (0.11 + 0.035 * (k % 3)));
    }
  }

  // ---------------------------------------------------------------- разряды и лучи (одна лента на всё)
  const arcStrip = makeStripGeometry(THREE, ARC_MAX, ARC_PTS);
  const arcMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false, fog: false,
  });
  const arcMesh = new THREE.Mesh(arcStrip.g, arcMat);
  arcMesh.frustumCulled = false; arcMesh.renderOrder = 24; arcMesh.visible = false; arcMesh.name = 'ashen-fx-arcs';
  root.add(arcMesh);
  const arcJit = new Float32Array(ARC_MAX * ARC_PTS * 3);
  const arcNext = new Float32Array(ARC_MAX);
  const arcTmp = new Float32Array(ARC_PTS * 3);
  const crackDir = new Float32Array(16 * 6);   // пары направлений (начало/конец) для треска
  const crackNext = new Float32Array(16);
  let arcN = 0, arcPrevN = 0;
  function arcReset() { arcN = 0; }
  // A→B. amp — поперечный излом (м), width — полуширина ленты (м), lc — линейный цвет, k — яркость,
  // ray — луч (яркое начало, гаснет к концу, без излома).
  function arcAdd(ax, ay, az, bx, by, bz, amp, width, lc, k, ray) {
    if (arcN >= ARC_MAX || k <= 0.002) return;
    const s = arcN++;
    const J = s * ARC_PTS * 3;
    if (!ray && clock >= arcNext[s]) {
      for (let i = 0; i < ARC_PTS * 3; i++) arcJit[J + i] = Math.random() * 2 - 1;
      arcNext[s] = clock + (reducedMotion() ? 0.16 : rnd(0.04, 0.085));
    }
    const n1 = ARC_PTS - 1;
    for (let i = 0; i < ARC_PTS; i++) {
      const u = i / n1;
      const env = ray ? 0 : Math.sin(Math.PI * u) * amp;
      const j = J + i * 3, q = i * 3;
      arcTmp[q] = ax + (bx - ax) * u + arcJit[j] * env;
      arcTmp[q + 1] = ay + (by - ay) * u + arcJit[j + 1] * env;
      arcTmp[q + 2] = az + (bz - az) * u + arcJit[j + 2] * env;
    }
    const P = arcStrip.P, C = arcStrip.C, o = s * ARC_PTS * 6;
    for (let i = 0; i < ARC_PTS; i++) {
      const q = i * 3, q0 = Math.max(0, i - 1) * 3, q1 = Math.min(n1, i + 1) * 3;
      _w1.set(arcTmp[q1] - arcTmp[q0], arcTmp[q1 + 1] - arcTmp[q0 + 1], arcTmp[q1 + 2] - arcTmp[q0 + 2]);
      _w2.set(_cam.x - arcTmp[q], _cam.y - arcTmp[q + 1], _cam.z - arcTmp[q + 2]);
      _w3.crossVectors(_w1, _w2);
      if (_w3.lengthSq() < 1e-12) _w3.set(0, 1, 0);
      const u = i / n1;
      const taper = ray ? 1 - 0.7 * u : 0.35 + 0.65 * Math.sin(Math.PI * u);
      _w3.normalize().multiplyScalar(width * taper);
      const v = o + i * 6;
      P[v] = arcTmp[q] + _w3.x; P[v + 1] = arcTmp[q + 1] + _w3.y; P[v + 2] = arcTmp[q + 2] + _w3.z;
      P[v + 3] = arcTmp[q] - _w3.x; P[v + 4] = arcTmp[q + 1] - _w3.y; P[v + 5] = arcTmp[q + 2] - _w3.z;
      const f = k * (ray ? (1 - u) * (1 - u) : 0.45 + 0.55 * Math.sin(Math.PI * u));
      C[v] = lc.r * f; C[v + 1] = lc.g * f; C[v + 2] = lc.b * f;
      C[v + 3] = C[v]; C[v + 4] = C[v + 1]; C[v + 5] = C[v + 2];
    }
  }
  function arcCommit() {
    if (arcN > 0 || arcPrevN > 0) {
      arcStrip.g.setDrawRange(0, arcN * (ARC_PTS - 1) * 6);
      arcStrip.pa.needsUpdate = true; arcStrip.ca.needsUpdate = true;
    }
    arcMesh.visible = arcN > 0;
    arcPrevN = arcN;
  }
  // Направления i-го треска: пара единичных векторов, обновляется каждые 70–150 мс.
  function crackle(i, out0, out1) {
    const o = i * 6;
    if (clock >= crackNext[i]) {
      randomDir(_w1); randomDir(_w2);
      _w2.addScaledVector(_w1, 1.3).normalize();
      crackDir[o] = _w1.x; crackDir[o + 1] = _w1.y; crackDir[o + 2] = _w1.z;
      crackDir[o + 3] = _w2.x; crackDir[o + 4] = _w2.y; crackDir[o + 5] = _w2.z;
      crackNext[i] = clock + (reducedMotion() ? 0.3 : rnd(0.07, 0.15));
    }
    out0.set(crackDir[o], crackDir[o + 1], crackDir[o + 2]);
    out1.set(crackDir[o + 3], crackDir[o + 4], crackDir[o + 5]);
  }

  // ---------------------------------------------------------------- блики призмы и ударные волны
  const glintPool = makePool(GLINT_CAP, () => {
    const mat = spriteMat(TEX.flare, PAL.prismGlint, 0);
    const obj = new THREE.Sprite(mat);
    obj.visible = false; obj.renderOrder = 25; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 0.2, s: 0.2 };
  }, hideObj);
  function fxGlint(x, y, z, size, dur, hex) {
    const it = glintPool.acquire();
    it.t = 0; it.dur = Math.max(0.05, dur); it.s = size;
    it.mat.color.setHex(hex || PAL.prismGlint);
    it.mat.rotation = Math.random() * TAU;
    it.mat.opacity = 0;
    it.obj.position.set(x, y, z);
    it.obj.scale.setScalar(1e-3);
    it.obj.visible = true;
  }
  const shockPool = makePool(SHOCK_CAP, () => {
    const mat = tpl.shock.clone();
    const obj = new THREE.Mesh(geo.disk, mat);
    obj.visible = false; obj.renderOrder = 24; root.add(obj);
    return { obj, mat, active: false, t: 0, dur: 0.4, s0: 0.1, s1: 1, op: 1, bill: true };
  }, hideObj);
  // dir === null — кольцо всегда смотрит в камеру; иначе плоскость кольца перпендикулярна dir.
  function fxShock(pos, dir, s0, s1, dur, colRaw, hotRaw, opacity, delay) {
    const it = shockPool.acquire();
    it.t = -(delay || 0); it.dur = Math.max(0.05, dur); it.s0 = s0; it.s1 = s1; it.op = opacity;
    it.bill = !dir;
    const u = it.mat.uniforms;
    setRaw(u.uColor.value, colRaw); setRaw(u.uHot.value, hotRaw);
    u.uSeed.value = Math.random() * 20; u.uProg.value = 0; u.uOpacity.value = 0;
    it.obj.position.set(pos.x, pos.y, pos.z);
    if (dir) it.obj.quaternion.setFromUnitVectors(Z_AXIS, dir);
    else if (camera) it.obj.quaternion.copy(camera.quaternion);
    it.obj.scale.setScalar(Math.max(1e-3, s0));
    it.obj.visible = false;
    return it;
  }
  function updateSpellTransients(dt) {
    const gi = glintPool.items;
    for (let i = 0; i < gi.length; i++) {
      const it = gi[i];
      if (!it.active) continue;
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; continue; }
      const e = Math.sin(Math.PI * k);
      it.obj.scale.setScalar(Math.max(1e-3, it.s * e));
      it.mat.opacity = e;
    }
    const si = shockPool.items;
    for (let i = 0; i < si.length; i++) {
      const it = si[i];
      if (!it.active) continue;
      it.t += dt;
      if (it.t < 0) continue;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.obj.visible = false; continue; }
      it.obj.visible = true;
      if (it.bill && camera) it.obj.quaternion.copy(camera.quaternion);
      it.obj.scale.setScalar(Math.max(1e-3, lerp(it.s0, it.s1, easeOutCubic(k))));
      const u = it.mat.uniforms;
      u.uProg.value = k;
      u.uOpacity.value = it.op * (k < 0.08 ? k / 0.08 : Math.pow(1 - k, 1.3));
    }
  }

  // ---------------------------------------------------------------- круг сотворения под ногами
  const sigilMat = tpl.ring.clone();
  setRaw(sigilMat.uniforms.uColor.value, RAW.heroGold); setRaw(sigilMat.uniforms.uHot.value, RAW.heroCore);
  sigilMat.uniforms.uSeg.value = 16;
  sigilMat.polygonOffset = true; sigilMat.polygonOffsetFactor = -2; sigilMat.polygonOffsetUnits = -2;
  const sigilMesh = new THREE.Mesh(geo.sigil, sigilMat);
  sigilMesh.visible = false; sigilMesh.renderOrder = 3; sigilMesh.name = 'ashen-fx-sigil';
  root.add(sigilMesh);

  // ---------------------------------------------------------------- сотворённое: состояние
  const conj = {
    want: false, kind: 'orb', size: 0, charge: 0, vis: 0, r: CONJ_R_MIN, rv: 0, rDisp: CONJ_R_MIN,
    pos: new V3(), body: null, full: false, fizzle: false, heldT: 0, sigil: 0, sigilA: 0,
    moteAcc: 0, emberAcc: 0, glintAcc: 0, gatherAcc: 0, ctlT: 0, loopKey: null,
    // точка и радиус в момент броска: брошенный снаряд начинает с них (без скачка)
    last: { pos: new V3(), r: 0.3, kind: 'orb', clock: -1e9, id: null },
  };
  // Центр сотворённого: перед грудью героя, дальше вперёд для большого (чтобы не входить в тело).
  function conjCenter(out, r) {
    const f = 0.46 + r * 0.75;
    return out.set(
      fi.player.x + fi.fwd.x * f + fi.right.x * 0.04,
      fi.player.y + CHEST_H + 0.2 + r * 0.1,
      fi.player.z + fi.fwd.z * f + fi.right.z * 0.04,
    );
  }
  function stopConjureSound(fade) {
    if (conj.loopKey) { audio.loopStop(conj.loopKey, fade ?? 0.15); conj.loopKey = null; }
  }
  function onConjureStart() {
    const r = Math.max(0.12, conj.r);
    conjCenter(_p, lerp(CONJ_R_MIN, CONJ_R_MAX, conj.size));
    const prism = conj.kind === 'prism';
    fxFlash(_p, prism ? PAL.prismCore : PAL.heroCore, 0.1, r * 3.2, 0.22, { flare: true, opacity: 0.9, pull: 0.2 });
    const n = Math.round(14 * Q.spell) + 4;
    for (let i = 0; i < n; i++) gatherMote(_p, prism ? RAW.prismEdge : RAW.heroGold, 0.6, 1.2, 0.32, 0.04, false);
    fxRing(playerGround(_q), 0.25, 1.3, 0.5, prism ? RAW.prismEdge : RAW.heroGold, RAW.heroCore, 0.55, 3);
    audio.play('conjureStart', _p, prism ? 1 : 0);
  }
  function onConjureMorph() {
    const prism = conj.kind === 'prism';
    fxFlash(conj.pos, prism ? PAL.prismCore : PAL.heroCore, conj.rDisp, conj.rDisp * 3.6, 0.2, { flare: true, opacity: 0.8, pull: 0.2 });
    fxShock(conj.pos, null, conj.rDisp * 0.9, conj.rDisp * 2.6, 0.3, prism ? RAW.prismEdge : RAW.heroAmber, RAW.heroCore, 0.7, 0);
    audio.play('conjureStart', conj.pos, prism ? 1 : 0);
  }
  function onConjureReady() {
    const prism = conj.kind === 'prism';
    fxFlash(conj.pos, prism ? PAL.prismGlint : PAL.heroCore, conj.rDisp * 1.2, conj.rDisp * 4.2, 0.26, { flare: true, opacity: 0.9, pull: 0.25 });
    fxShock(conj.pos, null, conj.rDisp * 1.1, conj.rDisp * 3.4, 0.36, prism ? RAW.prismEdge : RAW.heroAmber, prism ? RAW.prismGlint : RAW.heroCore, 0.8, 0);
    sparks(conj.pos, { count: 12, speed: [1.2, 3], rgb: prism ? RAW.prismGlint : RAW.heroCore, life: 0.35, size: 0.04, essential: true, drag: 3 });
    audio.play('conjureReady', conj.pos, prism ? 1 : 0);
  }
  function onConjureFizzle() {
    const prism = conj.kind === 'prism';
    _dir.set(0, -1, 0);
    sparks(conj.pos, { dir: _dir, count: 14, spread: 1.2, speed: [0.5, 2], rgb: prism ? RAW.prismEdge : RAW.heroEmber, life: 0.6, size: 0.04, gravity: 2, drag: 1.5, jitter: conj.rDisp * 0.6 });
    fxFlash(conj.pos, prism ? PAL.prismEdge : PAL.heroAmber, conj.rDisp * 1.5, conj.rDisp * 2.4, 0.18, { opacity: 0.5 });
    audio.play('fizzle', conj.pos);
  }

  function syncConjure(dt) {
    const pl = snap && snap.player;
    const c = pl && pl.conjure && typeof pl.conjure === 'object' ? pl.conjure : null;
    const live = !!c && fi.status === 'playing' && pl.action !== 'dead';
    if (live) {
      const kind = c.kind === 'prism' ? 'prism' : 'orb';
      conj.size = clamp01(num(c.size, 0.3));
      conj.charge = clamp01(num(c.charge, 0));
      if (!conj.want) {
        conj.want = true; conj.fizzle = false; conj.full = conj.charge >= 0.995; conj.heldT = 0;
        const fresh = conj.vis < 0.05;
        conj.kind = kind;
        if (conj.body) setSpellKind(conj.body, kind);
        if (fresh) { conj.r = lerp(CONJ_R_MIN, CONJ_R_MAX, conj.size) * 0.35; conj.rv = 0; onConjureStart(); }
      } else if (kind !== conj.kind) {
        conj.kind = kind;
        if (conj.body) setSpellKind(conj.body, kind);
        onConjureMorph();
      }
      if (dt > 0) conj.heldT += dt;
    } else if (conj.want) {
      conj.want = false;
      conj.fizzle = true; // отменится, если в ближайшие кадры придёт бросок
    }
    if (dt > 0) conj.vis = conj.want ? Math.min(1, conj.vis + dt / 0.12) : Math.max(0, conj.vis - dt / 0.2);

    if (conj.vis <= 0.001) {
      if (conj.body) {
        if (conj.fizzle && fi.status === 'playing') onConjureFizzle();
        releaseSpell(conj.body); conj.body = null;
      }
      conj.fizzle = false;
      stopConjureSound(0.12);
      conj.sigil = Math.max(0, conj.sigil - dt / 0.25);
      syncSigil(dt);
      return;
    }
    // радиус: пружина к цели по size (reducedMotion — без перелёта)
    const rt = lerp(CONJ_R_MIN, CONJ_R_MAX, conj.size);
    if (dt > 0) {
      const rm = reducedMotion();
      const om = rm ? 16 : 13, z = rm ? 1 : 0.55;
      conj.rv += (om * om * (rt - conj.r) - 2 * z * om * conj.rv) * dt;
      conj.r = Math.max(0.05, conj.r + conj.rv * dt);
    }
    const r = conj.r * (0.45 + 0.55 * easeOutCubic(conj.vis));
    conj.rDisp = r;
    conjCenter(conj.pos, conj.r);
    if (!conj.body) conj.body = acquireSpell(conj.kind);
    if (conj.body) poseSpell(conj.body, conj.pos, r, conj.charge, conj.vis, dt, false, null, true);
    cameraPos(_cam);
    const prism = conj.kind === 'prism';
    const ch = conj.charge, vis = conj.vis;
    // разряды: контакт с ладонями (всегда), треск по поверхности растёт с зарядом (орб),
    // лучи преломлённого света (призма)
    const P = conj.pos;
    if (vis > 0.3) {
      for (let side = -1; side <= 1; side += 2) {
        const hx = P.x + fi.right.x * side * (r * 1.08 + 0.05) - fi.fwd.x * 0.03;
        const hz = P.z + fi.right.z * side * (r * 1.08 + 0.05) - fi.fwd.z * 0.03;
        const hy = P.y - r * 0.12;
        const sx = P.x + fi.right.x * side * r * 0.85, sz = P.z + fi.right.z * side * r * 0.85;
        arcAdd(hx, hy, hz, sx, P.y, sz, 0.035 + r * 0.06, 0.007 + 0.004 * ch, prism ? LIN.ray : LIN.arc, vis * (0.45 + 0.55 * ch), false);
      }
    }
    if (!prism) {
      const nArc = Math.round(Q.arcs * clamp01((ch - 0.12) / 0.8));
      for (let i = 0; i < nArc; i++) {
        crackle(i, _w1, _w2);
        const r0 = r * 0.92, r1 = r * (1.45 + 0.7 * ch);
        arcAdd(P.x + _w1.x * r0, P.y + _w1.y * r0, P.z + _w1.z * r0, P.x + _w2.x * r1, P.y + _w2.y * r1, P.z + _w2.z * r1,
          r * 0.22, 0.006 + 0.006 * ch, ch > 0.9 ? LIN.arcHot : LIN.arc, vis * (0.5 + 0.7 * ch), false);
      }
    } else if (conj.body) {
      const nRay = Q.arcs >= 4 ? 4 : 2;
      const len = r * (2.0 + 1.8 * ch);
      for (let i = 0; i < nRay; i++) {
        const a = conj.body.spinA * 0.55 + (i * TAU) / nRay;
        const dy = 0.35 * Math.sin(clock * 0.8 + i * 2.1);
        const dx = Math.cos(a), dz = Math.sin(a);
        arcAdd(P.x, P.y, P.z, P.x + dx * len, P.y + dy * len, P.z + dz * len, 0, r * (0.03 + 0.02 * ch), LIN.ray, vis * (0.22 + 0.3 * ch), true);
      }
    }
    // частицы
    if (dt > 0 && vis > 0.2 && fi.status === 'playing') {
      if (!prism) {
        conj.moteAcc += dt * (14 + 44 * ch) * Q.spell;
        while (conj.moteAcc >= 1) {
          conj.moteAcc -= 1;
          randomDir(_w2);
          const rr = r * rnd(1.6, 2.6);
          const px = P.x + _w2.x * rr, py = P.y + _w2.y * rr * 0.75, pz = P.z + _w2.z * rr;
          const lf = rnd(0.28, 0.5);
          const vin = (rr * 0.7) / lf;
          glow.spawn(px, py, pz, -_w2.x * vin - _w2.z * vin * 0.9, -_w2.y * vin * 0.75, -_w2.z * vin + _w2.x * vin * 0.9,
            lf, 0.04, 0.01, Math.random() < 0.55 ? RAW.heroGold : RAW.heroAmber, 0.9, 0.6, 0, false);
        }
        conj.gatherAcc += dt * (6 + 16 * ch) * Q.spell;
        while (conj.gatherAcc >= 1) { conj.gatherAcc -= 1; gatherMote(P, RAW.heroCore, r * 2.2, r * 3.4, 0.4, 0.035, false); }
        conj.emberAcc += dt * (2 + 9 * ch) * Q.spell;
        while (conj.emberAcc >= 1) {
          conj.emberAcc -= 1;
          glow.spawn(P.x + rnd(-r, r) * 0.6, P.y - r * 0.8, P.z + rnd(-r, r) * 0.6, rnd(-0.2, 0.2), rnd(-0.1, 0.3), rnd(-0.2, 0.2),
            rnd(0.5, 0.9), 0.03, 0.008, RAW.heroEmber, 0.85, 0.8, 1.4, false);
        }
      } else {
        conj.glintAcc += dt * (4 + 12 * ch) * Q.glints;
        while (conj.glintAcc >= 1) {
          conj.glintAcc -= 1;
          prismVertex(conj.body, r, _w3);
          fxGlint(P.x + _w3.x, P.y + _w3.y, P.z + _w3.z, r * rnd(0.55, 1.05), rnd(0.14, 0.26), Math.random() < 0.8 ? PAL.prismGlint : PAL.prismEdge);
        }
        conj.moteAcc += dt * (8 + 22 * ch) * Q.spell;
        while (conj.moteAcc >= 1) {
          conj.moteAcc -= 1;
          const a = Math.random() * TAU, rr = r * rnd(1.1, 1.9);
          glow.spawn(P.x + Math.cos(a) * rr, P.y + rnd(-0.6, 0.3) * r, P.z + Math.sin(a) * rr, Math.cos(a) * 0.05, rnd(0.25, 0.6), Math.sin(a) * 0.05,
            rnd(0.7, 1.2), 0.028, 0.008, RAW.prismEdge, 0.8, 0.4, -0.15, false);
        }
      }
    }
    // заряд до конца — короткий сигнал «готово»
    if (conj.want) {
      if (!conj.full && ch >= 0.995) { conj.full = true; onConjureReady(); }
      else if (conj.full && ch < 0.9) conj.full = false;
    }
    // звук: петля своего вида; высота/фильтр за зарядом (~20 Гц обновлений)
    const key = prism ? 'conjure:prism' : 'conjure:orb';
    if (conj.want) {
      if (conj.loopKey && conj.loopKey !== key) stopConjureSound(0.1);
      audio.loop(key, prism ? 'conjurePrism' : 'conjureOrb', P);
      conj.loopKey = key;
      if (clock >= conj.ctlT) { conj.ctlT = clock + 0.05; audio.loopCtl(key, ch); }
    } else stopConjureSound(0.12);
    conj.sigil = conj.want ? Math.min(1, conj.sigil + dt / 0.3) : Math.max(0, conj.sigil - dt / 0.25);
    syncSigil(dt);
  }
  // Случайная вершина октаэдра призмы в мировой ориентации тела (для бликов).
  function prismVertex(b, r, out) {
    const k = (Math.random() * 6) | 0;
    const ax = k >> 1, sg = k & 1 ? -1 : 1;
    out.set(ax === 0 ? 0.7 * sg : 0, ax === 1 ? 1.28 * sg : 0, ax === 2 ? 0.7 * sg : 0).multiplyScalar(r);
    if (b) out.applyQuaternion(b.crystal.quaternion);
    return out;
  }
  function syncSigil(dt) {
    const a = conj.sigil;
    sigilMesh.visible = a > 0.01 && fi.has;
    if (!sigilMesh.visible) return;
    const prism = conj.kind === 'prism';
    const ch = conj.charge;
    if (dt > 0) conj.sigilA += dt * (0.35 + 1.1 * ch) * (reducedMotion() ? 0.4 : 1);
    sigilMesh.position.set(fi.player.x, fi.player.y + 0.05, fi.player.z);
    sigilMesh.rotation.set(0, conj.sigilA, 0);
    sigilMesh.scale.setScalar(0.8 + 0.45 * ch + 0.15 * (1 - a));
    const u = sigilMat.uniforms;
    setRaw(u.uColor.value, prism ? RAW.prismEdge : RAW.heroGold);
    u.uTime.value = -conj.sigilA * 0.5; u.uCharge.value = ch;
    u.uOpacity.value = a * (0.35 + 0.4 * ch);
  }

  // ---------------------------------------------------------------- бросок (player_cast ability 'throw')
  function onThrow(ev, d) {
    const prism = d.kind === 'prism' || (d.kind !== 'sphere' && conj.kind === 'prism');
    const size = clamp01(num(d.size, conj.size));
    const power = clamp01(num(d.power, 0.6));
    const had = conj.vis > 0.05 && conj.body;
    const r = had ? Math.max(0.1, conj.rDisp) : lerp(CONJ_R_MIN, CONJ_R_MAX, size);
    let p;
    if (had) p = _p.copy(conj.pos);
    else if (hasVec(ev.position) && ev.position.y > GROUND_Y + 0.4) p = _p.set(ev.position.x, ev.position.y, ev.position.z);
    else p = conjCenter(_p, r);
    const L = conj.last;
    L.pos.copy(p); L.r = r; L.kind = prism ? 'prism' : 'orb'; L.clock = clock;
    L.id = d.projectileId !== undefined && d.projectileId !== null ? String(d.projectileId) : null;
    // сотворённое исчезает сразу — дальше его несёт снаряд
    if (conj.body) { releaseSpell(conj.body); conj.body = null; }
    conj.vis = 0; conj.want = false; conj.fizzle = false;
    stopConjureSound(0.05);
    if (hasVec(d.velocity)) _dir.set(d.velocity.x, d.velocity.y, d.velocity.z); else _dir.copy(fi.fwd);
    if (_dir.lengthSq() < 1e-8) _dir.copy(fi.fwd);
    _dir.normalize();
    const cHex = prism ? PAL.prismCore : PAL.heroCore, aHex = prism ? PAL.prismEdge : PAL.heroAmber;
    const aRaw = prism ? RAW.prismEdge : RAW.heroAmber, cRaw = prism ? RAW.prismGlint : RAW.heroCore;
    // Выпуск летит от камеры: плоская волна перпендикулярна взгляду, поэтому её радиус держим
    // скромным (до ~2 м), иначе кольцо закрывает пол-экрана.
    fxFlash(p, cHex, r * 1.1, r * 2.6 + power * 0.6, 0.18, { flare: true, opacity: 0.9, pull: 0.3 });
    fxFlash(p, aHex, r * 1.5, r * 3.6 + power * 0.9, 0.28, { opacity: 0.4, pull: 0.3 });
    fxShock(p, _dir, r * 1.0, r * 2.8 + 0.6 * power, 0.3, aRaw, cRaw, 0.85, 0);
    fxShock(p, _dir, r * 0.7, r * 2.0 + 0.4 * power, 0.24, aRaw, cRaw, 0.55, 0.07);
    sparks(p, { dir: _dir, count: 10 + 12 * power, spread: 0.35, speed: [4, 9 + 5 * power], rgb: cRaw, life: 0.3, size: 0.05, essential: true, drag: 3 });
    sparks(p, { dir: _dir, count: 22 + 18 * power, spread: 0.7, speed: [2, 6], rgb: prism ? RAW.prismEdge : RAW.heroGold, life: 0.45, size: 0.04, drag: 2.5 });
    _q.copy(_dir).negate();
    sparks(p, { dir: _q, count: 10, spread: 0.9, speed: [0.8, 2.2], rgb: prism ? RAW.prismFace : RAW.heroEmber, life: 0.5, size: 0.04, drag: 2, gravity: 0.4 });
    const feet = playerGround(_r);
    fxRing(feet, 0.3, 1.0 + 0.9 * size, 0.4, prism ? RAW.prismEdge : RAW.heroGold, RAW.heroCore, 0.6, 3);
    _w4.set(0, 0.2, 0);
    sparks(feet, { pool: dust, dir: _w4, count: 8, flat: true, speed: [0.8, 2.2], rgb: RAW.dust, life: 0.7, size: 0.1, sizeEnd: 0.2, gravity: 0.6, drag: 2.5, alpha: 0.55 });
    lightFlash(p, aHex, 0.6 + 0.6 * power, 0.3);
    addKick(_q, 0.02 + 0.03 * size); addTrauma(0.05 + 0.1 * power);
    audio.play('throw', p, { size, power, prism });
  }

  // ---------------------------------------------------------------- снаряд-заклинание в полёте
  function updateSpellProj(v, dt, sTime) {
    const b = v.body;
    const r = v.visR;
    const speed = v.vel.length();
    if (speed > 1e-3) _w3.copy(v.vel).multiplyScalar(1 / speed); else _w3.copy(fi.fwd);
    // передача от сотворённого: первые ~0.14 с тело «доезжает» от точки между ладоней
    const ho = easeOutCubic(v.handoff);
    _sp.copy(v.pos).addScaledVector(v.hoff, ho);
    if (b) poseSpell(b, _sp, r, 1, 1, dt, true, _w3, false);
    const prism = v.kind === 'prism';
    const trailTime = Math.min(prism ? 0.2 : 0.3, 4.5 / Math.max(speed, 0.1));
    buildRibbon(v, sTime, trailTime, prism ? r * 0.7 : r * 1.25, prism ? LIN.prism : LIN.sphere);
    if (dt <= 0) return;
    // базис, перпендикулярный полёту (спираль искр)
    _t1.crossVectors(_w3, Y_AXIS);
    if (_t1.lengthSq() < 1e-6) _t1.set(1, 0, 0);
    _t1.normalize();
    _t2.crossVectors(_w3, _t1);
    if (!prism) {
      v.moteAcc += dt * 70 * Q.spell;
      while (v.moteAcc >= 1) {
        v.moteAcc -= 1;
        const a = clock * 16 + Math.random() * 0.8 + (v.moteAcc > 0.5 ? Math.PI : 0);
        const ca = Math.cos(a), sa = Math.sin(a), rr = r * 1.05;
        const ox = (_t1.x * ca + _t2.x * sa) * rr, oy = (_t1.y * ca + _t2.y * sa) * rr, oz = (_t1.z * ca + _t2.z * sa) * rr;
        glow.spawn(_sp.x + ox, _sp.y + oy, _sp.z + oz, -v.vel.x * 0.07 + ox * 1.6, -v.vel.y * 0.07 + oy * 1.6, -v.vel.z * 0.07 + oz * 1.6,
          rnd(0.25, 0.45), 0.045, 0.01, Math.random() < 0.6 ? RAW.heroGold : RAW.heroAmber, 0.9, 2.2, 0, false);
      }
      v.sparkAcc += dt * 14 * Q.spell;
      while (v.sparkAcc >= 1) {
        v.sparkAcc -= 1;
        glow.spawn(_sp.x, _sp.y - r * 0.4, _sp.z, rnd(-0.4, 0.4), rnd(-0.2, 0.4), rnd(-0.4, 0.4), rnd(0.5, 0.8), 0.03, 0.008, RAW.heroEmber, 0.85, 1, 1.6, false);
      }
      const nArc = Math.min(2, Q.arcs);
      for (let i = 0; i < nArc; i++) {
        crackle(8 + ((v.tag + i) & 7), _w1, _w2);
        arcAdd(_sp.x + _w1.x * r * 0.9, _sp.y + _w1.y * r * 0.9, _sp.z + _w1.z * r * 0.9,
          _sp.x + _w2.x * r * 1.7, _sp.y + _w2.y * r * 1.7, _sp.z + _w2.z * r * 1.7, r * 0.25, 0.01, LIN.arc, 0.9, false);
      }
    } else {
      v.moteAcc += dt * 26 * Q.glints;
      while (v.moteAcc >= 1) {
        v.moteAcc -= 1;
        fxGlint(_sp.x + rnd(-1, 1) * r, _sp.y + rnd(-1, 1) * r, _sp.z + rnd(-1, 1) * r, r * rnd(0.5, 0.9), rnd(0.18, 0.32), PAL.prismGlint);
      }
      v.sparkAcc += dt * 40 * Q.spell;
      while (v.sparkAcc >= 1) {
        v.sparkAcc -= 1;
        randomDir(_w1);
        glow.spawn(_sp.x + _w1.x * r * 0.6, _sp.y + _w1.y * r * 0.6, _sp.z + _w1.z * r * 0.6,
          -v.vel.x * 0.05 + _w1.x * 0.4, -v.vel.y * 0.05 + _w1.y * 0.4, -v.vel.z * 0.05 + _w1.z * 0.4,
          rnd(0.3, 0.55), 0.03, 0.008, Math.random() < 0.5 ? RAW.prismEdge : RAW.prismGlint, 0.85, 2.5, 0, false);
      }
    }
    v.handoff = Math.max(0, v.handoff - dt / 0.14);
  }

  // ---------------------------------------------------------------- попадание заклинания
  function onSpellImpact(p, kind, r, result, dir) {
    const prism = kind === 'prism';
    const s = clamp01((r - CONJ_R_MIN) / (CONJ_R_MAX - CONJ_R_MIN));
    const floor = result === 'floor';
    if (floor && p.y < GROUND_Y + 0.12) p.y = GROUND_Y + 0.12;
    const cHex = prism ? PAL.prismGlint : PAL.heroCore, aHex = prism ? PAL.prismEdge : PAL.heroAmber;
    const aRaw = prism ? RAW.prismEdge : RAW.heroAmber, cRaw = prism ? RAW.prismGlint : RAW.heroCore;
    const R = r * (1 + s);
    // Размеры под камеру в ~11 м от стража: волна не шире самого Регента.
    fxFlash(p, cHex, R * 1.3, 0.9 + R * 3.4, 0.28, { flare: true, opacity: 1, pull: 0.6 });
    fxFlash(p, aHex, R * 2, 1.3 + R * 4.5, 0.45, { opacity: 0.6, pull: 0.6 });
    fxShock(p, null, R * 0.8, 1.0 + R * 2.6, 0.42, aRaw, cRaw, 0.9, 0);
    fxShock(p, null, R * 0.5, 0.7 + R * 1.8, 0.5, aRaw, cRaw, 0.5, 0.08);
    if (Q.shell) fxShell(p, R * 0.5, Math.min(1.8, 0.8 + R * 2.2), 0.32, aRaw, 0.55);
    _q.set(p.x, GROUND_Y, p.z);
    const nearFloor = p.y < GROUND_Y + 4;
    if (nearFloor || floor) fxRing(_q, 0.3, 1.8 + 2.4 * s, 0.6, aRaw, cRaw, 0.9, 3);
    if (floor) fxRing(_q, 0.5, 1.4 + 2.2 * s, 1.0, aRaw, cRaw, 0.9, 4);
    _q.copy(dir).negate();
    if (prism) {
      // осколки кристалла + звезда лучей
      sparks(p, { dir: _q, count: 18 + 14 * s, spread: 1.3, speed: [3, 9], rgb: RAW.prismGlint, life: 0.55, size: 0.055, essential: true, gravity: 5, drag: 1.6 });
      sparks(p, { count: 30 + 20 * s, speed: [1.5, 6], rgb: RAW.prismEdge, life: 0.9, size: 0.04, gravity: 3, drag: 1.4 });
      sparks(p, { pool: dust, count: 10, speed: [2, 5], rgb: RAW.prismFace, life: 0.9, size: 0.06, gravity: 8, drag: 0.8, alpha: 0.9 });
      const rot0 = Math.random() * TAU;
      for (let i = 0; i < 4; i++) fxFlash(p, PAL.prismGlint, R * 0.5, 1.2 + R * 5, 0.24, { flare: true, stretch: 4, rotation: rot0 + (i * Math.PI) / 4, opacity: 0.8, pull: 0.6 });
      for (let i = 0; i < 6; i++) fxGlint(p.x + rnd(-1, 1) * R * 2, p.y + rnd(-1, 1) * R * 2, p.z + rnd(-1, 1) * R * 2, R * rnd(0.8, 1.5), rnd(0.2, 0.4), PAL.prismGlint);
    } else {
      sparks(p, { dir: _q, count: 16 + 16 * s, spread: 1.1, speed: [3, 8 + 4 * s], rgb: RAW.heroCore, life: 0.45, size: 0.06, essential: true, gravity: 3, drag: 2 });
      sparks(p, { count: 34 + 30 * s, speed: [1.5, 6], rgb: RAW.heroGold, life: 0.7, size: 0.05, gravity: 1.2, drag: 1.8 });
      sparks(p, { count: 18 + 12 * s, speed: [0.5, 2.5], rgb: RAW.heroEmber, life: 1.3, size: 0.04, gravity: 1.6, drag: 1, jitter: R * 0.8 });
    }
    // каменная крошка и пыль, если попали в стража или в пол
    if (floor || p.distanceTo(fi.boss) < 5) {
      _w4.set(0, 1, 0);
      sparks(p, { pool: dust, dir: _w4, count: 10 + 10 * s, spread: 1.4, speed: [2, 5.5], rgb: RAW.dustLight, life: 1.0, size: 0.08, essential: true, gravity: 9, drag: 0.7, jitter: R * 0.6 });
      sparks(p, { pool: dust, count: 14 + 14 * s, speed: [0.6, 2], rgb: RAW.dust, life: 1.2, size: 0.14, sizeEnd: 0.3, gravity: 0.6, drag: 1.8, alpha: 0.6, jitter: R });
    }
    lightFlash(p, aHex, 1.0 + 1.2 * s, 0.5 + 0.3 * s);
    addTrauma(0.18 + 0.32 * s); addKick(dir, 0.03 + 0.04 * s);
    audio.play(prism ? 'prismImpact' : 'sphereImpact', p, s);
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
      // [v2] брошенное заклинание: тело, передача от сотворённого, радиус показа
      spell: false, body: null, handoff: 0, hoff: new V3(), r0: 0.3, visR: 0.3, moteAcc: 0,
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
    const k = pr.kind;
    v.kind = k === 'orb' || k === 'bolt' || k === 'sphere' || k === 'prism' ? k : (v.owner === 'boss' ? 'orb' : 'bolt');
    v.spell = v.kind === 'sphere' || v.kind === 'prism';
    v.pos.set(pr.position.x, pr.position.y, pr.position.z);
    if (hasVec(pr.velocity)) v.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else v.vel.set(0, 0, 0);
    v.body = null; v.handoff = 0; v.hoff.set(0, 0, 0); v.moteAcc = 0;
    if (v.spell) {
      const L = conj.last;
      v.r0 = clamp(num(pr.radius, L.r), 0.08, 1.2);
      // бросок только что был: тело стартует из точки между ладоней, с радиусом сотворённого
      if (clock - L.clock < 0.35 && (L.id === null || L.id === key)) {
        v.hoff.set(L.pos.x - v.pos.x, L.pos.y - v.pos.y, L.pos.z - v.pos.z);
        if (v.hoff.lengthSq() < 4) { v.handoff = 1; v.r0 = L.r; } else v.hoff.set(0, 0, 0);
        L.clock = -1e9;
      }
      v.visR = v.r0;
      v.body = acquireSpell(v.kind === 'prism' ? 'prism' : 'orb');
    }
    const orb = v.kind === 'orb' || (v.spell && !v.body); // без свободного тела — хотя бы как сфера
    v.core.material = orb ? (v.spell ? projMat.boltCore : projMat.orbCore) : projMat.boltCore;
    v.halo.material = orb && !v.spell ? projMat.orbHalo : projMat.boltHalo;
    v.core.quaternion.identity();
    v.shell.visible = v.kind === 'orb';
    v.core.visible = !v.body; v.halo.visible = !v.body;
    // Короткий «засеянный» хвост, чтобы шлейф был виден с первого кадра.
    const back = orb ? 0.06 : 0.04;
    pushHist(v, v.pos.x - v.vel.x * back, v.pos.y - v.vel.y * back, v.pos.z - v.vel.z * back, sTime - back);
  }
  function releaseProj(v, allowFizzle) {
    if (allowFizzle && fi.status === 'playing' && !impactNear(v.pos, v.id)) {
      // Снаряд исчез без события попадания (истёк/вылетел) — маленькое угасание, не «удар».
      const rgb = v.owner === 'boss' ? RAW.guardCold : v.kind === 'prism' ? RAW.prismEdge : RAW.heroAmber;
      const rr = v.spell ? v.visR : v.radius;
      sparks(v.pos, { count: v.spell ? 14 : 6, speed: [0.3, 1.2 + (v.spell ? 1 : 0)], rgb, life: 0.35, size: 0.05, drag: 3 });
      fxFlash(v.pos, v.owner === 'boss' ? PAL.guardCold : PAL.heroAmber, rr * 2, rr * 3.5, 0.18, { opacity: 0.5 });
    }
    if (v.kind === 'orb') audio.loopStop('orb:' + v.id);
    if (v.spell) audio.loopStop('spell:' + v.id, 0.1);
    if (v.body) { releaseSpell(v.body); v.body = null; }
    v.spell = false;
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
    if (v.spell) {
      // [v2] брошенное заклинание: радиус показа плавно переходит от сотворённого к снаряду
      const want = clamp(num(pr.radius, v.r0), 0.08, 1.2);
      v.visR = v.handoff > 0 ? lerp(want, v.r0, easeOutCubic(v.handoff)) : want;
      if (v.body) {
        updateSpellProj(v, dt, sTime);
      } else {
        // пул тел исчерпан: простая яркая сфера со шлейфом (не пропадает совсем)
        v.core.position.copy(v.pos); v.halo.position.copy(v.pos);
        v.core.scale.setScalar(v.visR * 0.8);
        v.halo.scale.setScalar(v.visR * 5 * flick);
        buildRibbon(v, sTime, 0.25, v.visR * 1.2, v.kind === 'prism' ? LIN.prism : LIN.sphere);
        v.handoff = 0;
      }
      audio.loop('spell:' + v.id, v.kind === 'prism' ? 'prismFlight' : 'sphereFlight', v.pos);
      return;
    }
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
      // [VFX] снаряды, которые рисует V6 (fx.suppress('proj:<kind>') / 'proj:caret' для игл «Акуса»)
      if (v6 && (v6on('proj:' + pr.kind) || (key.startsWith('caret:') && v6on('proj:caret')) || (pr.remote && v6on('proj:remote')))) continue;
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
    if (d.ability === 'throw') { onThrow(ev, d); return; }   // [v2] бросок сотворённого
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
    // [v2] брошенное заклинание: своё попадание (волна, осколки, свет, тряска по размеру)
    const kind = d.kind || (pv && pv.kind);
    if (owner === 'player' && (kind === 'sphere' || kind === 'prism')) {
      const rr = pv && pv.spell ? pv.visR : clamp(num(d.radius, conj.last.r), 0.08, 1.2);
      onSpellImpact(p, kind, rr, d.result, _dir);
      return;
    }
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

  // [ASHEN_V2] «Рассечение»: веер вытянутых бликов по дуге перед героем в сторону взмаха;
  // хвост дуги гаснет первым — читается направление. Попадание — вспышка на Регенте.
  const _sl = new V3(), _tn = new V3();
  function onPlayerSlash(ev, d) {
    const A = d && typeof d.arc === 'object' && d.arc ? d.arc : null;
    const o = evPos(ev, _q, chestOf);
    if (o.y < GROUND_Y + 0.4) o.y = fi.player.y + CHEST_H;
    const yaw = A && isNum(A.yaw) ? A.yaw : Math.atan2(fi.fwd.x, fi.fwd.z);
    const half = clamp((A && isNum(A.angleDeg) ? A.angleDeg : 110) * Math.PI / 360, 0.3, 1.5);
    const R = clamp(A && isNum(A.radius) ? A.radius * 0.42 : 1.8, 1, 2.4);
    const sgn = d.dir === 'left' || (isNum(d.dir) && d.dir < 0) ? -1 : 1;
    const pw = clamp(num(d.power, 0.6), 0, 1);
    const N = 9;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      // слева направо по экрану: от yaw+half к yaw−half (правая сторона героя — yaw−π/2)
      const a = yaw + sgn * (half - 2 * half * u);
      _sl.set(o.x + Math.sin(a) * R, o.y - 0.15 + 0.3 * u, o.z + Math.cos(a) * R);
      _tn.set(-Math.cos(a) * sgn, 0.12, Math.sin(a) * sgn);
      const rot = screenAngle(_sl, _tn);
      fxFlash(_sl, i === N - 1 ? PAL.heroCore : PAL.heroAmber, 0.18 + 0.2 * pw, 0.5 + 0.35 * pw, 0.1 + 0.16 * u,
        { flare: true, stretch: 3.2, opacity: 0.3 + 0.6 * u, rotation: rot === null ? 0 : rot, pull: 0.2 });
      if (i % 2 === 0) sparks(_sl, { dir: _tn, count: 2 + Math.round(pw * 2), spread: 0.35, speed: [2, 4.5], rgb: RAW.heroGold, life: 0.3, size: 0.045, essential: i === N - 1, drag: 3 });
    }
    if (d.hit) {
      const c = bossCoreOf(_p);
      fxFlash(c, PAL.heroCore, 0.4, 1.6, 0.2, { flare: true, pull: 0.5 });
      sparks(c, { dir: _tn, count: 14, spread: 1, speed: [2, 6], rgb: RAW.heroAmber, life: 0.4, size: 0.05, essential: true, gravity: 2, drag: 2 });
      lightFlash(c, PAL.heroAmber, 0.7, 0.3);
      addTrauma(0.1);
    }
    _dir.copy(fi.right).multiplyScalar(sgn);
    addKick(_dir, 0.025);
    audio.play('cast', o);
  }

  // [ASHEN_V2] парирование: удача — холодно-золотой хлопок в точке отражения; промах — тусклая вспышка у левой руки.
  function onParry(ev, d) {
    if (d && d.success) {
      const p = evPos(ev, _p, (out) => handOf(out, -1));
      registerImpact(p, d.projectileId ?? null);
      fxFlash(p, PAL.heroCore, 0.4, 1.8, 0.24, { flare: true, pull: 0.2 });
      fxFlash(p, PAL.guardCold, 0.6, 2.2, 0.32, { opacity: 0.6, pull: 0.2 });
      if (Q.shell) fxShell(p, 0.2, 0.9, 0.22, RAW.heroAmber, 0.45);
      sparks(p, { dir: fi.fwd, count: 16, spread: 1.4, speed: [2.5, 6], rgb: RAW.heroAmber, life: 0.4, size: 0.05, essential: true, gravity: 2, drag: 2 });
      sparks(p, { dir: fi.fwd, count: 12, spread: 1.6, speed: [1, 3.5], rgb: RAW.guardCold, life: 0.45, size: 0.04, gravity: 1, drag: 2 });
      lightFlash(p, PAL.heroAmber, 0.9, 0.35);
      addTrauma(0.12);
      audio.play('block', p);
    } else {
      const p = handOf(_p, -1);
      fxFlash(p, PAL.heroGold, 0.15, 0.55, 0.16, { opacity: 0.45 });
    }
  }

  // [ASHEN_V2] уголь клятвы зажжён: столб искр вверх, кольцо по земле, короткий тёплый свет.
  function onEmberLit(ev) {
    const c = evPos(ev, _p, chestOf);
    fxFlash(c, PAL.heroCore, 0.5, 2.6, 0.4, { flare: true, opacity: 1, pull: 0.3 });
    fxFlash(c, PAL.heroAmber, 1.2, 3.6, 0.7, { opacity: 0.55, pull: 0.3 });
    _q.set(c.x, c.y - 0.9, c.z);
    fxRing(_q, 0.3, 3.2, 0.8, RAW.heroAmber, RAW.heroCore, 0.7, 3);
    _dir.set(0, 1, 0);
    sparks(c, { dir: _dir, count: 26, spread: 0.35, speed: [3, 8], rgb: RAW.heroAmber, life: 0.9, size: 0.06, essential: true, gravity: -0.4, drag: 1.2 });
    sparks(c, { dir: _dir, count: 40, spread: 1.2, speed: [0.6, 2.4], rgb: RAW.heroGold, life: 1.6, size: 0.045, gravity: -0.3, drag: 0.8, jitter: 0.8 });
    lightFlash(c, PAL.heroAmber, 1.1, 0.9);
    addTrauma(0.06);
    audio.play('burst', c);
  }

  // [ASHEN_V3] печати двумя руками
  function onSigilCast(ev, d) {
    const k = d && d.sigil;
    const c = evPos(ev, _p, chestOf);
    if (k === 'clap') {
      // хлопок: вспышка между ладонями, ударная волна по земле, искры веером
      // вспышка у героя — умеренная: камера за спиной, крупный блик засвечивал пол-экрана
      fxFlash(c, PAL.heroCore, 0.25, 1.2, 0.2, { flare: true, opacity: 0.8, pull: 0.1 });
      fxFlash(c, PAL.guardCold, 0.4, 1.5, 0.3, { opacity: 0.35, pull: 0.1 });
      _q.set(fi.player.x, fi.player.y, fi.player.z);
      const R = num(d.radius, 7);
      fxRing(_q, 0.4, R, 0.55, RAW.guardCold, RAW.heroCore, 0.85, 3);
      fxRing(_q, 0.2, R * 0.6, 0.4, RAW.heroAmber, RAW.heroCore, 0.6, 3);
      fxWall(_q, 0.4, R, 1.0, 0.5, RAW.guardCold, 0.3);
      sparks(c, { count: 18, flat: true, speed: [R * 1.2, R * 2], rgb: RAW.guardCore, life: 0.4, size: 0.06, essential: true, drag: 3 });
      sparks(c, { count: 30, flat: true, speed: [R * 0.5, R * 1.4], rgb: RAW.heroGold, life: 0.6, size: 0.045, drag: 2.5 });
      lightFlash(c, PAL.guardCold, 0.8, 0.35);
      addTrauma(0.22); _dir.set(0, 1, 0); addKick(_dir, 0.02);
      if (d.stunned) {
        const b = bossCoreOf(_r);
        fxFlash(b, PAL.guardCore, 0.8, 3.6, 0.4, { flare: true, opacity: 1, pull: 0.6 });
        sparks(b, { count: 20, speed: [2, 6], rgb: RAW.guardCore, life: 0.6, size: 0.06, essential: true, drag: 2 });
      }
      audio.play('nova', c);
    } else if (k === 'gate') {
      // врата: золотые створки расходятся от героя, купол поднимается
      sig.domePulse = 1;
      _q.set(fi.player.x, fi.player.y, fi.player.z);
      fxRing(_q, 0.3, 2.4, 0.7, RAW.heroGold, RAW.heroCore, 0.9, 3);
      fxWall(_q, 0.3, 1.4, 2.2, 0.6, RAW.heroGold, 0.45);
      fxFlash(c, PAL.heroCore, 0.4, 2.4, 0.4, { flare: true, opacity: 0.9 });
      _dir.set(0, 1, 0);
      sparks(_q, { dir: _dir, count: 36, spread: 0.6, speed: [1.5, 4], rgb: RAW.heroGold, life: 1.0, size: 0.05, essential: true, gravity: -0.3, drag: 1.2 });
      lightFlash(c, PAL.heroAmber, 0.9, 0.6);
      addTrauma(0.08);
      audio.play('shieldUp', c);
    } else if (k === 'delta') {
      // дельта: треугольник вспыхивает у рук, луч начнётся с sigil_hit
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / 3;
        _ln.x = c.x + fi.right.x * Math.cos(a) * 0.5; _ln.y = c.y + 0.35 - Math.sin(a) * 0.5; _ln.z = c.z + fi.right.z * Math.cos(a) * 0.5;
        fxFlash(_ln, PAL.heroCore, 0.2, 0.9, 0.5, { flare: true, opacity: 0.9, pull: 0.2 });
      }
      lightFlash(c, PAL.heroAmber, 1.0, 0.8);
      audio.play('cast', c);
    } else if (k === 'cor') {
      // кор: сердце из вспышек над героем, золотое кольцо, оберег
      const cc = chestOf(_r);
      for (let i = 0; i < 24; i++) {
        const q = (i / 24) * TAU, x = 16 * Math.pow(Math.sin(q), 3) / 16, y = (13 * Math.cos(q) - 5 * Math.cos(2 * q) - 2 * Math.cos(3 * q) - Math.cos(4 * q)) / 16;
        _ln.x = cc.x + fi.right.x * x * 0.5; _ln.y = cc.y + 0.9 + y * 0.5; _ln.z = cc.z + fi.right.z * x * 0.5;
        fxFlash(_ln, i % 2 ? PAL.heroGold : PAL.heroCore, 0.12, 0.45, 0.7 + i * 0.015, { opacity: 0.85, pull: 0.1 });
      }
      fxRing(playerGround(_q), 0.3, 2.4, 1.0, RAW.heroGold, RAW.heroCore, 0.7, 3);
      if (Q.shell) fxShell(cc, 0.4, 1.35, 0.7, RAW.heroGold, 0.5);
      lightFlash(cc, PAL.heroGold, 0.9, 0.8);
      audio.play('cast', cc);
    } else if (k === 'frame') {
      // рамка: золотой прицел на ядре Регента, линия от героя к цели
      const to = hasVec(d.to) ? d.to : bossCoreOf(_r);
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        _ln.x = c.x + (to.x - c.x) * u; _ln.y = c.y + (to.y - c.y) * u; _ln.z = c.z + (to.z - c.z) * u;
        fxFlash(_ln, PAL.heroAmber, 0.18, 0.5, 0.2 + u * 0.25, { opacity: 0.7, pull: 0.2 });
      }
      fxFlash(to, PAL.heroCore, 0.6, 3.2, 0.45, { flare: true, opacity: 0.9, pull: 0.6 });
      lightFlash(to, PAL.heroAmber, 0.8, 0.4);
      addTrauma(0.05);
      audio.play('cast', c);
    }
  }

  function onPlayerDash(ev, d) {
    let sign = 1;
    const dd = d.direction ?? d.dir;
    if (isNum(dd)) sign = dd >= 0 ? 1 : -1;
    else if (hasVec(dd)) sign = dd.x * fi.right.x + dd.z * fi.right.z >= 0 ? 1 : -1;
    dashFx.active = true; dashFx.t = 0; dashFx.next = 0; dashFx.acc = 0; dashFx.sign = sign;
    dashFx.ghostsLeft = reducedMotion() ? 0 : Q.ghosts;
    const feet = evPos(ev, _p, playerGround);
    feet.y = fi.player.y + 0.05;
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

  // ---------------------------------------------------------------- [№1, «Перстни»] руны и новые события
  const _ln = { x: 0, y: 0, z: 0 };
  function onRuneCast(ev, d) {
    const rune = d.rune;
    const from = hasVec(d.from) ? d.from : chestOf(_p);
    const to = hasVec(d.to) ? d.to : bossCoreOf(_q);
    if (rune === 'ignis') {
      // огненное копьё: цепочка вспышек рука → ядро стража, затем взрыв
      for (let i = 0; i <= 9; i++) {
        const u = i / 9;
        _ln.x = from.x + (to.x - from.x) * u; _ln.y = from.y + (to.y - from.y) * u + Math.sin(u * Math.PI) * 0.6; _ln.z = from.z + (to.z - from.z) * u;
        fxFlash(_ln, i % 2 ? PAL.heroAmber : PAL.heroCore, 0.3, 1.0 + u * 1.2, 0.18 + u * 0.22, { opacity: 0.9, pull: 0.2 });
      }
      fxFlash(to, PAL.heroCore, 0.8, 4.2, 0.55, { flare: true, opacity: 1, pull: 0.6 });
      sparks(to, { count: 30, speed: [3, 8], rgb: RAW.heroAmber, life: 0.7, size: 0.07, essential: true, drag: 2, gravity: 2 });
      sparks(to, { count: 50, speed: [1, 5], rgb: RAW.heroEmber, life: 1.1, size: 0.05, drag: 1.5, gravity: 1.5 });
      lightFlash(to, PAL.heroAmber, 1.2, 0.6);
      addTrauma(0.25);
      audio.play('burst', to);
    } else if (rune === 'fulgur') {
      // молния: зигзаг холодных вспышек сверху на стража + кольцо на земле
      const top = { x: to.x + 0.4, y: to.y + 7, z: to.z - 0.3 };
      let px = top.x, py = top.y, pz = top.z;
      for (let i = 1; i <= 8; i++) {
        const u = i / 8;
        const nx = top.x + (to.x - top.x) * u + (i < 8 ? (Math.random() - 0.5) * 1.4 : 0);
        const ny = top.y + (to.y - top.y) * u;
        const nz = top.z + (to.z - top.z) * u + (i < 8 ? (Math.random() - 0.5) * 1.4 : 0);
        for (let k = 0; k < 3; k++) {
          _ln.x = px + (nx - px) * (k / 3); _ln.y = py + (ny - py) * (k / 3); _ln.z = pz + (nz - pz) * (k / 3);
          fxFlash(_ln, k % 2 ? PAL.guardCore : PAL.guardCold, 0.25, 0.9, 0.22, { opacity: 1, pull: 0.3 });
        }
        px = nx; py = ny; pz = nz;
      }
      fxFlash(to, PAL.guardCore, 1.0, 5.0, 0.45, { flare: true, opacity: 1, pull: 0.6 });
      _q.set(to.x, GROUND_Y, to.z);
      fxRing(_q, 0.5, 5.5, 0.7, RAW.guardCold, RAW.guardCore, 0.8, 3);
      sparks(to, { count: 24, speed: [2, 6], rgb: RAW.guardCore, life: 0.6, size: 0.06, essential: true, drag: 2 });
      sparks(to, { count: 40, speed: [0.5, 2.5], rgb: RAW.guardCold, life: 2.5, size: 0.04, drag: 0.6, jitter: 1.2 });
      lightFlash(to, PAL.guardCold, 1.4, 0.5);
      addTrauma(0.3);
      audio.play('nova', to);
    } else if (rune === 'orbis') {
      // лечение и оберег: золотое кольцо у ног, оболочка, восходящие искры
      const feet = playerGround(_q);
      fxRing(feet, 0.3, 2.6, 0.9, RAW.heroGold, RAW.heroCore, 0.9, 3);
      fxRing(feet, 0.2, 1.4, 0.6, RAW.heroCore, RAW.heroCore, 0.6, 3);
      const c = chestOf(_p);
      if (Q.shell) fxShell(c, 0.4, 1.35, 0.6, RAW.heroGold, 0.55);
      fxFlash(c, PAL.heroCore, 0.4, 2.2, 0.5, { flare: true, opacity: 0.8 });
      _dir.set(0, 1, 0);
      sparks(feet, { dir: _dir, count: 30, spread: 0.9, speed: [0.8, 2.2], rgb: RAW.heroGold, life: 1.4, size: 0.05, essential: true, gravity: -0.4, drag: 0.8, jitter: 0.6 });
      lightFlash(c, PAL.heroGold, 0.8, 0.8);
      audio.play('cast', c);
    } else if (rune === 'stella') {
      // звездопад: звезда вспыхивает высоко над Регентом, метеоры — по событиям rune_hit
      _ln.x = to.x; _ln.y = to.y + 9; _ln.z = to.z;
      fxFlash(_ln, PAL.heroCore, 0.6, 3.4, 0.9, { flare: true, opacity: 0.9, pull: 0.2 });
      sparks(_ln, { count: 24, speed: [1, 4], rgb: RAW.heroGold, life: 1.2, size: 0.06, essential: true, drag: 1 });
      fxFlash(from, PAL.heroAmber, 0.3, 1.2, 0.3, { opacity: 0.8 });
      audio.play('cast', from);
    } else if (rune === 'spira') {
      // вихрь: спираль искр у ног, кольца; дальше вихрь держится по снимку (syncSigils)
      sig.vortexPulse = 1;
      const feet = playerGround(_q);
      fxRing(feet, 0.3, num(d.radius, 7), 0.7, RAW.guardCold, RAW.heroCore, 0.7, 3);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU * 2, r = 0.4 + i * 0.12;
        _ln.x = feet.x + Math.sin(a) * r; _ln.y = GROUND_Y + 0.3 + i * 0.06; _ln.z = feet.z + Math.cos(a) * r;
        fxFlash(_ln, i % 2 ? PAL.guardCold : PAL.heroCore, 0.12, 0.5, 0.25 + i * 0.02, { opacity: 0.8, pull: 0.1 });
      }
      audio.play('nova', feet);
    } else if (rune === 'lemnis') {
      // вечность: знак ∞ из вспышек над героем, лечение идёт по снимку
      const c = chestOf(_p);
      for (let i = 0; i < 20; i++) {
        const tt = (i / 20) * TAU, den = 1 + Math.sin(tt) * Math.sin(tt);
        const lx = 0.7 * Math.cos(tt) / den, ly = 0.7 * Math.sin(tt) * Math.cos(tt) / den;
        _ln.x = c.x + fi.right.x * lx; _ln.y = c.y + 0.9 + ly; _ln.z = c.z + fi.right.z * lx;
        fxFlash(_ln, PAL.heroGold, 0.12, 0.4, 0.6 + i * 0.02, { opacity: 0.8, pull: 0.1 });
      }
      fxRing(playerGround(_q), 0.3, 2.2, 1.0, RAW.heroGold, RAW.heroCore, 0.6, 3);
      audio.play('cast', c);
    } else if (rune === 'caret') {
      fxFlash(from, PAL.heroCore, 0.3, 1.4, 0.25, { flare: true, opacity: 0.9, pull: 0.2 });
      sparks(from, { dir: fi.fwd, count: 12, spread: 0.5, speed: [3, 7], rgb: RAW.heroAmber, life: 0.35, size: 0.05, essential: true, drag: 3 });
      audio.play('cast', from);
    } else if (rune === 'vee') {
      // жатва: тёмно-красный луч от Регента к герою, вспышка лечения
      const b = hasVec(d.from) ? d.from : bossCoreOf(_q), c = chestOf(_p);
      for (let i = 0; i <= 10; i++) {
        const u = i / 10;
        _ln.x = b.x + (c.x - b.x) * u; _ln.y = b.y + (c.y - b.y) * u + Math.sin(u * Math.PI) * 0.8; _ln.z = b.z + (c.z - b.z) * u;
        fxFlash(_ln, i % 2 ? PAL.hitEmber : PAL.heroAmber, 0.2, 0.8, 0.2 + u * 0.3, { opacity: 0.85, pull: 0.2 });
      }
      fxFlash(b, PAL.hitEmber, 0.6, 2.6, 0.4, { flare: true, opacity: 0.9, pull: 0.6 });
      fxFlash(c, PAL.heroGold, 0.3, 1.6, 0.5, { opacity: 0.7 });
      lightFlash(b, PAL.hitEmber, 0.9, 0.4);
      addTrauma(0.12);
      audio.play('burst', b);
    } else if (rune === 'clepsydra') {
      // время: холодные кольца вокруг Регента, песок-искры падают; замедление держится по снимку
      _q.set(to.x, GROUND_Y, to.z);
      fxRing(_q, 1.0, 6.0, 1.2, RAW.guardCold, RAW.guardCore, 0.6, 3);
      _ln.x = to.x; _ln.y = to.y + 3; _ln.z = to.z;
      fxFlash(_ln, PAL.guardCore, 0.8, 4.0, 0.8, { flare: true, opacity: 0.7, pull: 0.6 });
      _dir.set(0, -1, 0);
      sparks(_ln, { dir: _dir, count: 40, spread: 0.6, speed: [0.5, 2], rgb: RAW.guardCold, life: 1.8, size: 0.05, essential: true, gravity: 0.6, drag: 0.5 });
      audio.play('nova', to);
    } else if (rune === 'alpha') {
      // начало: белая вспышка, откаты сброшены — кольцо и восходящий столб
      const c = chestOf(_p);
      fxFlash(c, PAL.heroCore, 0.5, 2.8, 0.45, { flare: true, opacity: 1, pull: 0.2 });
      fxRing(playerGround(_q), 0.2, 3.0, 0.6, RAW.heroCore, RAW.heroCore, 0.8, 3);
      _dir.set(0, 1, 0);
      sparks(c, { dir: _dir, count: 30, spread: 0.3, speed: [2, 6], rgb: RAW.heroCore, life: 0.8, size: 0.05, essential: true, gravity: -0.5, drag: 1.2 });
      lightFlash(c, PAL.heroCore, 1.0, 0.5);
      audio.play('cast', c);
    }
  }
  // [ASHEN_V3] удар луча «Дельты»: полоса от героя к Регенту
  function onSigilHit(ev, d) {
    if (d.sigil !== 'delta') return;
    const to = evPos(ev, _p, bossCoreOf), from = hasVec(d.from) ? d.from : chestOf(_q);
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      _ln.x = from.x + (to.x - from.x) * u; _ln.y = from.y + (to.y - from.y) * u; _ln.z = from.z + (to.z - from.z) * u;
      fxFlash(_ln, i % 3 ? PAL.heroAmber : PAL.heroCore, 0.25, 0.6, 0.16, { flare: true, opacity: 0.9, pull: 0.2 });
    }
    fxFlash(to, PAL.heroCore, 0.8, 2.8, 0.25, { flare: true, opacity: 1, pull: 0.6 });
    sparks(to, { count: 16, speed: [2, 7], rgb: RAW.heroAmber, life: 0.45, size: 0.06, essential: true, drag: 2, gravity: 2 });
    lightFlash(to, PAL.heroAmber, 1.0, 0.25);
    addTrauma(0.1);
  }

  // [ASHEN_V3] метеор «Стеллы»: полоса с неба в Регента и удар
  function onRuneHit(ev, d) {
    if (d.rune !== 'stella') return;
    const to = evPos(ev, _p, bossCoreOf);
    const k = (num(d.index, 0) % 5) - 2;
    const top = { x: to.x + k * 1.2 + 2, y: to.y + 11, z: to.z - 3 };
    for (let i = 0; i <= 7; i++) {
      const u = i / 7;
      _ln.x = top.x + (to.x - top.x) * u; _ln.y = top.y + (to.y - top.y) * u; _ln.z = top.z + (to.z - top.z) * u;
      fxFlash(_ln, i % 2 ? PAL.heroAmber : PAL.heroCore, 0.2, 0.7, 0.12 + u * 0.18, { opacity: 0.9, pull: 0.3 });
    }
    fxFlash(to, PAL.heroCore, 0.6, 2.4, 0.3, { flare: true, opacity: 0.9, pull: 0.6 });
    sparks(to, { count: 14, speed: [2, 6], rgb: RAW.heroAmber, life: 0.5, size: 0.06, essential: true, drag: 2, gravity: 2 });
    addTrauma(0.06);
  }
  function onPerfectDodge() {
    const c = chestOf(_p);
    fxFlash(c, PAL.guardCore, 0.5, 3.0, 0.4, { flare: true, opacity: 0.9 });
    fxRing(playerGround(_q), 0.4, 3.2, 0.5, RAW.guardCore, RAW.guardCore, 0.7, 3);
    sparks(c, { count: 18, speed: [2, 5], rgb: RAW.guardCore, life: 0.5, size: 0.05, essential: true, drag: 2.5 });
  }
  function onWardEnd(d) {
    if (d.reason !== 'absorbed') return;
    const c = chestOf(_p);
    fxFlash(c, PAL.heroGold, 0.6, 2.6, 0.35, { flare: true, opacity: 0.9 });
    sparks(c, { count: 20, speed: [2, 4], rgb: RAW.heroGold, life: 0.5, size: 0.05, essential: true, drag: 2 });
  }

  // [VFX] старые обработчики рисуют почти всё у СВОЕГО героя — событие соперника (data.remote) им отдаём, только если
  // оно целиком задано позицией события
  const REMOTE_LEGACY_OK = new Set(['projectile_impact', 'player_hit', 'boss_hit', 'rune_hit', 'sigil_hit']);
  function handleEvent(type, ev, d) {
    if (v6 && v6.handle(type, ev, d)) return; // [VFX] V6 нарисовал событие целиком
    if (d && d.remote === true && !REMOTE_LEGACY_OK.has(type)) return;
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
      case 'player_slash': onPlayerSlash(ev, d); break;
      case 'parry': onParry(ev, d); break;
      case 'ember_lit': onEmberLit(ev); break;
      case 'sigil_cast': onSigilCast(ev, d); break;
      case 'rune_hit': onRuneHit(ev, d); break;
      case 'sigil_hit': onSigilHit(ev, d); break;
      case 'slow_start': case 'slow_end': case 'vortex_end': case 'regen_end': break; // по снимку
      case 'cruise_start': case 'cruise_end': break; // [V4] автобег — только HUD
      case 'bastion_start': case 'bastion_end': case 'mark_start': case 'mark_end': break; // по снимку
      case 'rune_cast': onRuneCast(ev, d); break;
      case 'perfect_dodge': onPerfectDodge(); break;
      case 'ward_end': onWardEnd(d); break;
      case 'ward_start': case 'boss_stunned': case 'telegraph_cancel': case 'combo_break': case 'boss_projectile': case 'ability_denied': break;
      case 'pvp_opponent_cast': case 'pvp_round': break; // [VFX] PvP: касты соперника рисует V6 (fx/index.js), раунды — HUD
      case 'projectile_reflected': case 'encounter_start': case 'encounter_end': case 'conjure_start': case 'conjure_end': break; // [ASHEN_V2] без своего эффекта
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
    glintPool.releaseAll(); shockPool.releaseAll();
    for (const b of spellItems) releaseSpell(b);
    conj.body = null; conj.want = false; conj.vis = 0; conj.fizzle = false; conj.full = false; conj.sigil = 0;
    conj.r = CONJ_R_MIN; conj.rv = 0; conj.last.clock = -1e9; conj.loopKey = null;
    sigilMesh.visible = false;
    arcN = 0; arcCommit();
    glow.clear(); dust.clear();
    shield.open = 0; shield.on = false; shield.flash = 0; shield.rippleT = 1;
    sig.dome = 0; sig.mark = 0; sig.domePulse = 0; domeMesh.visible = false; markMesh.visible = false;
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
    if (v6) { try { v6.clear(); } catch (e) { /* ignore */ } }
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
    frameNo++;
    if (v6) {
      const want = liveSetting('fxMagic') !== false;
      if (want !== v6.enabled) { v6.setEnabled(want); flashLight.visible = !want && Q.light; }
      v6.setSnapshot(snap);
    }
    frameImpactN = 0; frameImpactIds.clear();
    processEvents(events);
    if (v6 && v6.enabled) { try { v6.update(dt, snap); } catch (e) { warnOnce('v6-upd', 'V6 update', e); } }
    arcReset();
    syncShield(dt);
    syncSigils(dt);
    syncConjure(dt);
    syncProjectiles(dt);
    syncTelegraphs(dt);
    syncDash(dt);
    syncAmbientFx(dt);
    checkFallbacks();
    arcCommit();
    updateTransients(dt);
    updateSpellTransients(dt);
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
    flashLight.visible = Q.light && !(v6 && v6.enabled);
    if (!Q.light) { flashLight.intensity = 0; L.t = L.dur; }
    if (v6) { try { v6.setQuality(name); } catch (e) { /* ignore */ } }
    shellMesh.visible = shellMesh.visible && Q.shell;
    for (const b of spellItems) if (b.active) setSpellKind(b, b.kind); // число колец/осколков по уровню
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
    if (v6) { try { v6.dispose(); } catch (e) { /* ignore */ } v6 = null; }
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
    if (v6) { try { v6.setReducedMotion(reducedMotion()); } catch (e) { /* ignore */ } }
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
      conjure: {
        visible: conj.vis > 0.001, kind: conj.kind, vis: conj.vis, radius: conj.rDisp, charge: conj.charge,
        sigil: conj.sigil, sound: conj.loopKey,
      },
      spells: { active: spellItems.filter((b) => b.active).length, pooled: spellItems.length, cap: SPELL_CAP },
      arcs: arcN, glints: glintPool.activeCount(), shocks: shockPool.activeCount(),
      light: { visible: flashLight.visible, intensity: flashLight.intensity, legacyLights, unit: LIGHT_UNIT },
      impulse: { x: imp.out.x, y: imp.out.y, z: imp.out.z, trauma: imp.trauma },
      events: { processed: stats.events, duplicatesSkipped: stats.duplicates, errors: stats.errors, cacheSize: seenIds.size },
      audio: audio.state(),
      v6: v6 ? { enabled: v6.enabled, ...v6.stats() } : null,
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
    // [VFX] V6: якоря героя (C5/world), ввод (след руны), земля, хит-стоп для main.js
    setAnchors: (fn) => { anchorSrc = typeof fn === 'function' ? fn : null; anchorFrame = -1; },
    setRemoteAnchors: (fn) => { remoteAnchorSrc = typeof fn === 'function' ? fn : null; remoteFrame = -1; },
    // [VFX] для net/session.js (№2): события соперника с data.remote рисуются от соперника в его цвете
    get supportsRemote() { return !!(v6 && v6.enabled); },
    setGround: (fn) => { groundFn = typeof fn === 'function' ? fn : null; },
    setInput: (input) => { lastInput = input || null; if (v6) v6.setInput(lastInput); },
    takeHitStop: () => (v6 && v6.enabled ? v6.takeHitStop() : 0),
    // [VFX] делёж с modules/handVisuals.js (№6): V6 рисует стрелы, сгустки и попадания, лук и метку «Дождя стрел» — №6
    linkHandVisuals: (hv) => {
      if (!hv || typeof hv.setDelegated !== 'function') return;
      const on = !!(v6 && v6.enabled);
      if (hv.__fxDelegated === on) return;
      try {
        hv.setDelegated(on ? { arrows: true, orbs: true, palm: true, bow: false, rain: false } : { arrows: false, orbs: false, palm: false, bow: false, rain: false });
        hv.__fxDelegated = on;
        if (v6) v6.fx.external.bow = on;
      } catch (e) { warnOnce('hv', 'handVisuals.setDelegated', e); }
    },
    get v6() { return v6; },
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
    conjure: 1, spellLoop: 2, throw: 2, spellHit: 2, cue: 2,
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
    // ---- [v2] сотворение и бросок
    conjureStart(pos, prism) {
      const v = voice('cue', pos, 0.4, 0.35, 0.7); if (!v) return;
      const t = T(), r = rnd(0.96, 1.04);
      // «вдох»: шум с медленной атакой и фильтром вверх
      noiseL(v, t, 0.42, { type: 'pink', filter: 'bandpass', f: 280 * r, f2: 1500 * r, fT: 0.36, q: 1.2, attack: 0.22, peak: 0.34 });
      if (prism) {
        for (const [f, p] of [[1318.5, 0.028], [1975.5, 0.02]]) toneL(v, t + 0.12, 0.5, { type: 'sine', f: f * r, attack: 0.18, peak: p });
      } else {
        toneL(v, t, 0.5, { type: 'triangle', f: 196 * r, f2: 294 * r, fT: 0.4, attack: 0.2, peak: 0.05, lp: 1400 });
      }
    },
    conjureReady(pos, prism) {
      const v = voice('cue', pos, 0.45, 0.45, 1.0); if (!v) return;
      const t = T();
      const notes = prism ? [[1567.98, 0.05], [2349.3, 0.035], [3135.9, 0.018]] : [[523.25, 0.06], [783.99, 0.045], [1046.5, 0.02]];
      notes.forEach(([f, p], i) => toneL(v, t + i * 0.035, 0.8 - i * 0.15, { type: prism ? 'sine' : 'triangle', f, attack: 0.004, peak: p, lp: prism ? 0 : 3000 }));
      noiseL(v, t, 0.12, { type: 'white', filter: 'highpass', f: 5000, q: 0.7, attack: 0.002, peak: 0.08 });
    },
    fizzle(pos) {
      const v = voice('cue', pos, 0.35, 0.2, 0.4); if (!v) return;
      const t = T();
      noiseL(v, t, 0.28, { type: 'white', filter: 'bandpass', f: 2200, f2: 500, fT: 0.25, q: 1.5, peak: 0.22 });
      toneL(v, t, 0.22, { type: 'sine', f: 330, f2: 120, fT: 0.2, peak: 0.05 });
    },
    // p: {size 0..1, power 0..1, prism}. Высота свиста — по размеру: большой снаряд ниже.
    throw(pos, p) {
      const size = clamp01(num(p && p.size, 0.5)), power = clamp01(num(p && p.power, 0.5)), prism = !!(p && p.prism);
      const v = voice('throw', pos, 0.55 + 0.25 * power, 0.35, 1.3); if (!v) return;
      const t = T(), r = lerp(1.4, 0.72, size) * rnd(0.96, 1.04);
      const src = ctx.createBufferSource(); src.buffer = noise.pink; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
      f.frequency.setValueAtTime(380 * r, t);
      f.frequency.exponentialRampToValueAtTime(2800 * r, t + 0.1);
      f.frequency.exponentialRampToValueAtTime(520 * r, t + 0.5);
      const g = ctx.createGain();
      const end = env(g.gain, t, 0.025, 0.7, 0.55);
      src.connect(f); f.connect(g); g.connect(v.out);
      v.nodes.push(f, g); addSource(v, src);
      src.start(t, Math.random()); src.stop(end + 0.02);
      noiseL(v, t, 0.18, { type: 'white', filter: 'highpass', f: 3200 * r, q: 0.6, attack: 0.01, peak: 0.12 });
      toneL(v, t, 0.3, { type: 'sine', f: 190 * r, f2: 55 * r, fT: 0.26, peak: 0.32 + 0.2 * power });
      if (prism) {
        // хрустальный звон: негармонические партиалы колокольчика
        const base = 1046.5 * lerp(1.25, 0.8, size);
        for (const [m, d, pk] of [[1, 1.2, 0.05], [2.76, 0.8, 0.03], [5.4, 0.5, 0.02], [8.93, 0.3, 0.012]]) {
          toneL(v, t + 0.01, d, { type: 'sine', f: base * m, attack: 0.002, peak: pk });
        }
      } else {
        noiseL(v, t, 0.5, { type: 'brown', filter: 'lowpass', f: 1100 * r, f2: 280, fT: 0.45, q: 0.7, attack: 0.02, peak: 0.45 });
      }
    },
    // s: размер 0..1 — глубже и длиннее для большого
    sphereImpact(pos, s) {
      const k = clamp01(num(s, 0.5));
      const v = voice('spellHit', pos, 0.7 + 0.25 * k, 0.55, 1.8); if (!v) return;
      const t = T(), r = rnd(0.95, 1.05) * lerp(1.15, 0.8, k);
      toneL(v, t, 0.9 + 0.4 * k, { type: 'sine', f: 78 * r, f2: 28, fT: 0.8, attack: 0.003, peak: 0.8 });
      noiseL(v, t, 0.7, { type: 'brown', filter: 'lowpass', f: 1500 * r, f2: 180, fT: 0.6, q: 0.7, attack: 0.002, peak: 0.95 });
      noiseL(v, t, 0.12, { type: 'pink', filter: 'bandpass', f: 2600 * r, q: 1, attack: 0.001, peak: 0.45 });
      toneL(v, t + 0.02, 1.2 + 0.5 * k, { type: 'sine', f: 41 * r, attack: 0.01, peak: 0.28 });
      for (let i = 0; i < 6; i++) {
        noiseL(v, t + rnd(0.05, 0.6), rnd(0.03, 0.08), { type: 'pink', filter: 'bandpass', f: rnd(1600, 3400), q: 1.4, peak: rnd(0.08, 0.18) });
      }
    },
    prismImpact(pos, s) {
      const k = clamp01(num(s, 0.5));
      const v = voice('spellHit', pos, 0.62 + 0.2 * k, 0.6, 2.0); if (!v) return;
      const t = T(), r = rnd(0.96, 1.04);
      // стекло: россыпь коротких высоких щелчков
      for (let i = 0; i < 12; i++) {
        noiseL(v, t + rnd(0, 0.35) * (i / 12), rnd(0.015, 0.05), { type: 'white', filter: 'bandpass', f: rnd(3200, 9000), q: rnd(3, 8), peak: rnd(0.08, 0.2) });
      }
      const base = 698.5 * r * lerp(1.2, 0.85, k);
      for (const [m, d, pk] of [[1, 1.7, 0.05], [2.32, 1.2, 0.035], [4.25, 0.8, 0.022], [6.63, 0.5, 0.014], [9.38, 0.3, 0.01]]) {
        toneL(v, t, d, { type: 'sine', f: base * m, attack: 0.002, peak: pk });
      }
      toneL(v, t, 0.5, { type: 'sine', f: 96 * r, f2: 40, fT: 0.4, attack: 0.003, peak: 0.45 + 0.2 * k });
      noiseL(v, t, 0.4, { type: 'brown', filter: 'lowpass', f: 900, f2: 200, fT: 0.35, q: 0.7, attack: 0.002, peak: 0.5 });
      noiseL(v, t, 0.9, { type: 'white', filter: 'highpass', f: 5200, q: 0.6, attack: 0.01, peak: 0.05 });
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
    // [v2] сотворение орба: рокот + гул; заряд поднимает фильтр, высоту и частоту тремоло
    conjureOrb(v) {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noise.brown; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 1.3;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.2);
      const trem = ctx.createOscillator(); trem.frequency.value = 6;
      const tg = ctx.createGain(); tg.gain.value = 0.1;
      const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 55;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
      const hg = ctx.createGain(); hg.gain.setValueAtTime(0, t); hg.gain.linearRampToValueAtTime(0.05, t + 0.2);
      const sine = ctx.createOscillator(); sine.type = 'sine'; sine.frequency.value = 110;
      const sg = ctx.createGain(); sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(0.07, t + 0.25);
      trem.connect(tg); tg.connect(g.gain);
      src.connect(bp); bp.connect(g); g.connect(v.out);
      hum.connect(lp); lp.connect(hg); hg.connect(v.out);
      sine.connect(sg); sg.connect(v.out);
      v.nodes.push(bp, g, tg, lp, hg, sg);
      addSource(v, src); addSource(v, trem); addSource(v, hum); addSource(v, sine);
      src.start(t, Math.random() * 1.5); trem.start(t); hum.start(t); sine.start(t);
      v.ctl = (k, now) => {
        bp.frequency.setTargetAtTime(320 + 1600 * k, now, 0.08);
        lp.frequency.setTargetAtTime(320 + 1100 * k, now, 0.08);
        sine.frequency.setTargetAtTime(110 + 120 * k, now, 0.1);
        hum.frequency.setTargetAtTime(55 + 28 * k, now, 0.1);
        trem.frequency.setTargetAtTime(6 + 11 * k, now, 0.1);
      };
    },
    // [v2] сотворение призмы: мерцающий хрустальный аккорд + тонкий «воздух»
    conjurePrism(v) {
      const t = ctx.currentTime;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.25);
      g.connect(v.out); v.nodes.push(g);
      const oscs = [];
      for (const [f, a] of [[1318.5, 0.022], [1760, 0.016], [2637, 0.01], [659.25, 0.03]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = a;
        o.connect(og); og.connect(g); v.nodes.push(og); addSource(v, o); o.start(t);
        oscs.push(o);
      }
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5;
      const lg = ctx.createGain(); lg.gain.value = 6; // ±6 Гц дрожание высоты — «мерцание»
      lfo.connect(lg); for (const o of oscs) lg.connect(o.frequency);
      v.nodes.push(lg); addSource(v, lfo); lfo.start(t);
      const n = ctx.createBufferSource(); n.buffer = noise.white; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 5000; nf.Q.value = 0.6;
      const ng = ctx.createGain(); ng.gain.value = 0.018;
      n.connect(nf); nf.connect(ng); ng.connect(g);
      v.nodes.push(nf, ng); addSource(v, n); n.start(t, Math.random());
      v.ctl = (k, now) => {
        g.gain.setTargetAtTime(0.6 + 0.8 * k, now, 0.1);
        lfo.frequency.setTargetAtTime(4 + 9 * k, now, 0.1);
        ng.gain.setTargetAtTime(0.012 + 0.03 * k, now, 0.1);
      };
    },
    // [v2] полёт брошенной сферы: тёплый рокот пламени
    sphereFlight(v) {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noise.brown; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = rnd(480, 560); f.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.06);
      const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = rnd(86, 96);
      const hg = ctx.createGain(); hg.gain.setValueAtTime(0, t); hg.gain.linearRampToValueAtTime(0.12, t + 0.06);
      src.connect(f); f.connect(g); g.connect(v.out); hum.connect(hg); hg.connect(v.out);
      v.nodes.push(f, g, hg); addSource(v, src); addSource(v, hum);
      src.start(t, Math.random()); hum.start(t);
    },
    // [v2] полёт призмы: высокий свист с быстрым тремоло
    prismFlight(v) {
      const t = ctx.currentTime;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.05);
      const trem = ctx.createOscillator(); trem.frequency.value = 13;
      const tg = ctx.createGain(); tg.gain.value = 0.4;
      trem.connect(tg); tg.connect(g.gain);
      g.connect(v.out); v.nodes.push(g, tg); addSource(v, trem); trem.start(t);
      for (const [f, a] of [[1760, 0.03], [2217.5, 0.02]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * rnd(0.99, 1.01);
        const og = ctx.createGain(); og.gain.value = a;
        o.connect(og); og.connect(g); v.nodes.push(og); addSource(v, o); o.start(t);
      }
      const n = ctx.createBufferSource(); n.buffer = noise.white; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 4200; nf.Q.value = 2;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      n.connect(nf); nf.connect(ng); ng.connect(g);
      v.nodes.push(nf, ng); addSource(v, n); n.start(t, Math.random());
    },
  };
  const LOOP_CFG = {
    orbLoop: ['orbLoop', 0.5, 0.2], shieldHum: ['shieldHum', 0.5, 0.15],
    conjureOrb: ['conjure', 0.5, 0.25], conjurePrism: ['conjure', 0.5, 0.35],
    sphereFlight: ['spellLoop', 0.45, 0.2], prismFlight: ['spellLoop', 0.45, 0.3],
  };

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
  // [v2] Параметр живой петли (0..1), если у петли есть управление (v.ctl). Вызывать не чаще ~20 Гц.
  function loopCtl(key, x) {
    const v = loops.get(key);
    if (!v || v.done || v.stopping || typeof v.ctl !== 'function' || !ctx) return;
    try { v.ctl(clamp01(num(x, 0)), ctx.currentTime); } catch (err) { warnOnce('loopctl', 'ошибка управления петлёй', err); }
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

  return { unlock, setVolume, play, loop, loopStop, loopCtl, stopLoops, stopAll, duck, update, state, dispose };
}
