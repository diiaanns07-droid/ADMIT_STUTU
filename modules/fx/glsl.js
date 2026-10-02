// ASHEN OATH — modules/fx/glsl.js. Владелец: №7 [VFX].
// Общие куски GLSL для новых эффектов V6. Соглашение о цвете (важно для bloom):
//  - шейдер считает ЛИНЕЙНЫЙ HDR-цвет: цвет палитры (sRGB hex) → linear, умноженный на яркость;
//    яркость > ~1.2 даёт свечение bloom (порог postfx 1.0), 1.0 — «ровный» цвет без ореола;
//  - выход — FX_OUT: стандартный colorspace_fragment three.js (в canvas — sRGB, в цель postfx — без изменений);
//  - смешивание — премультиплицированное (CustomBlending ONE, ONE_MINUS_SRC_ALPHA):
//      аддитивный свет  → gl_FragColor = vec4(col * a, 0.0)
//      дым/пыль/осколки → gl_FragColor = vec4(col * a, a)
//    так аддитив и «обычные» частицы рисуются одним проходом и в любом порядке не «грязнят» друг друга.
//  - PvP: uniform/атрибут rival 0..1 — FX_RIVAL(col, k) переводит тёплые тона героя в холодный фиолетовый соперника.

export const FX_OUT = /* glsl */`
  #include <colorspace_fragment>
`;

// sRGB (0..1) → линейный. Для цветов, пришедших из hex палитры как есть.
export const FX_SRGB = /* glsl */`
vec3 fxLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
`;

// Цвет соперника: тон поворачивается к фиолетовому (~275°), яркость сохраняется; белое ядро остаётся белым.
export const FX_RIVAL = /* glsl */`
vec3 fxRival(vec3 c, float k) {
  if (k <= 0.001) return c;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;
  vec3 violet = vec3(0.56, 0.36, 1.0);
  vec3 v = violet * (l / 0.4378);            // 0.4378 — яркость violet
  vec3 r = mix(vec3(l), v, clamp(sat * 1.15, 0.0, 1.0));
  return mix(c, r, k);
}
`;

// Хэши и шум (value noise 2D/3D, fbm). Без производных — компилируется везде.
export const FX_NOISE = /* glsl */`
float fxH1(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
float fxH2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxH3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float fxNoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxH2(i), fxH2(i + vec2(1.0, 0.0)), f.x), mix(fxH2(i + vec2(0.0, 1.0)), fxH2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fxNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(fxH3(i), fxH3(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(fxH3(i + vec3(0.0, 1.0, 0.0)), fxH3(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(fxH3(i + vec3(0.0, 0.0, 1.0)), fxH3(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(fxH3(i + vec3(0.0, 1.0, 1.0)), fxH3(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
float fxFbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * fxNoise2(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
float fxBand(float x, float c, float w, float s) { return 1.0 - smoothstep(w, w + s, abs(x - c)); }
`;

// Премультиплицированное смешивание для ShaderMaterial (см. соглашение выше).
export function premulBlend(THREE) {
  return {
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
  };
}

// hex 0xRRGGBB → [r,g,b] в ЛИНЕЙНОМ пространстве (для uniform vec3 без преобразования в шейдере).
const srgbLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export function hexLin(hex, out) {
  const o = out || [0, 0, 0];
  // [W4-ЗАКЛИНАНИЯ] без замыкания на вызов (bolts.set зовёт каждый кадр)
  o[0] = srgbLin(((hex >> 16) & 255) / 255); o[1] = srgbLin(((hex >> 8) & 255) / 255); o[2] = srgbLin((hex & 255) / 255);
  return o;
}

// Палитры стихий V6 (sRGB hex). core — белое ядро, hot — раскалённый, mid — основной, deep — тень/край.
// [W4-ЗАКЛИНАНИЯ] единый цветовой язык стихий (читается с проектора): огонь — оранжево-золотой, гроза (storm) —
// бело-голубая, тьма (void) — фиолетовая с чёрным ядром (black), ветер — изумрудный, буря (tempest) — электрик.
export const ELEMENTS = Object.freeze({
  fire:   Object.freeze({ core: 0xfff4d6, hot: 0xffc44a, mid: 0xff7418, deep: 0xa8280a, smoke: 0x2a1c16 }),
  storm:  Object.freeze({ core: 0xfbfdff, hot: 0xd4efff, mid: 0x86c6ff, deep: 0x3050c0, smoke: 0x1c2436 }),
  heal:   Object.freeze({ core: 0xfffbe0, hot: 0xffe38a, mid: 0x9df07a, deep: 0x2f9a58, smoke: 0x21301f }),
  star:   Object.freeze({ core: 0xfffaf0, hot: 0xffe0a0, mid: 0xffb070, deep: 0x8a3cff, smoke: 0x1d1830 }),
  wind:   Object.freeze({ core: 0xf0fff6, hot: 0xa6ffd6, mid: 0x2ee39a, deep: 0x0c7a50, smoke: 0x1c3328 }),
  eternal:Object.freeze({ core: 0xfffdf2, hot: 0xffe9a8, mid: 0xf2b8ff, deep: 0x7a4cc9, smoke: 0x241c30 }),
  frost:  Object.freeze({ core: 0xf6ffff, hot: 0xc8f4ff, mid: 0x7fd8ff, deep: 0x2f6fb8, smoke: 0x1c2a36 }),
  void:   Object.freeze({ core: 0xf2e2ff, hot: 0xc890ff, mid: 0x8c3cf4, deep: 0x2a0856, smoke: 0x0e0618, black: 0x06020c }),
  tempest:Object.freeze({ core: 0xf2f7ff, hot: 0x96c4ff, mid: 0x2f78ff, deep: 0x2a1fc0, smoke: 0x141a3a }),
  time:   Object.freeze({ core: 0xf2fbff, hot: 0xbfe8ff, mid: 0x7ab8e8, deep: 0x2c4c8a, smoke: 0x18202c }),
  reset:  Object.freeze({ core: 0xffffff, hot: 0xfff2c8, mid: 0xffd27a, deep: 0x5a8cff, smoke: 0x202030 }),
  gold:   Object.freeze({ core: 0xfff3d6, hot: 0xffd28a, mid: 0xe8a14a, deep: 0xb4602e, smoke: 0x2a2018 }),
  earth:  Object.freeze({ core: 0xffe9c8, hot: 0xffb46a, mid: 0xa8744a, deep: 0x4a3222, smoke: 0x3a3028 }),
  rival:  Object.freeze({ core: 0xf6eeff, hot: 0xd2b4ff, mid: 0x9a6bff, deep: 0x4b2a9a, smoke: 0x1a1428 }),
});

// [W4-ЗАКЛИНАНИЯ] стихия героя (settings.hero, modules/heroModel.js): ею окрашены его «общие» заклинания —
// снаряд «OK», выброс, сфера, искра, печати; у рун — своя стихия руны, у героя — предвестник и ободок.
export const HERO_ELEMENT = Object.freeze({
  ashen: 'fire', warrior: 'fire',            // Пепельный страж — пепел и пламя
  elf: 'storm', elfVroid: 'storm',           // Эльфийка — гроза
  dark: 'void', darkVroid: 'void',           // Тёмная чародейка — тьма
  ranger: 'wind',                            // Лучница — ветер
  archmage: 'tempest',                       // Архимаг — буря
});
export const heroElement = (id) => HERO_ELEMENT[id] || 'fire';
