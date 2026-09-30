// ASHEN OATH — [HERO] аура класса вокруг героя: частицы стихии, вся анимация — в вершинном шейдере
// (один вызов отрисовки, ноль работы CPU на частицу). Стили:
//   'ember' — угли поднимаются от земли вдоль тела и гаснут наверху (Пепельный страж);
//   'frost' — ледяные кристаллы кружат по двум наклонным орбитам (Тёмная чародейка);
//   'wind'  — светлячки/искры ветра дрейфуют вокруг по спирали (лучницы);
//   'storm' — короткие вспышки-искры вокруг рук и плеч (Архимаг).
// Точки — в осях модели героя (child модели), размер — с перспективой. quality: low — 40% частиц.
//
// createHeroAura(THREE, parent, fx, { quality, height }) → { update(t), setLod(l), setIntensity(k), dispose() }

const VERT = /* glsl */`
uniform float uTime;
uniform float uSize;
uniform float uH;
uniform float uStyle;
uniform float uK;
attribute vec4 aSeed;
varying float vA;
varying float vMix;
const float TAU = 6.2831853;
void main() {
  float t = uTime;
  vec3 p;
  float a = 1.0;
  vMix = aSeed.w;
  if (uStyle < 0.5) {                      // ember: подъём от земли, закрутка, угасание наверху
    float life = fract(aSeed.y + t * (0.16 + 0.12 * aSeed.z));
    float ang = aSeed.x * TAU + t * 0.5 + life * 2.4;
    float r = 0.28 + 0.26 * aSeed.z + 0.08 * sin(t * 1.3 + aSeed.w * 9.0);
    p = vec3(cos(ang) * r, life * uH * 1.05, sin(ang) * r);
    a = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.65, 1.0, life));
    a *= 0.6 + 0.4 * sin(t * 9.0 + aSeed.w * 30.0);
  } else if (uStyle < 1.5) {               // frost: кристаллы на двух наклонных орбитах
    float orbit = step(0.5, aSeed.w);
    float ang = aSeed.x * TAU + t * (0.55 + 0.25 * aSeed.z) * (orbit > 0.5 ? -1.0 : 1.0);
    float r = 0.5 + 0.12 * aSeed.z;
    vec3 q = vec3(cos(ang) * r, 0.0, sin(ang) * r);
    float tilt = orbit > 0.5 ? 0.45 : -0.35;
    q.y = q.x * tilt;
    p = q + vec3(0.0, uH * (0.55 + 0.1 * orbit) + 0.05 * sin(t * 1.7 + aSeed.y * 6.0), 0.0);
    a = 0.65 + 0.35 * sin(t * 4.0 + aSeed.y * 20.0);
  } else if (uStyle < 2.5) {               // wind: дрейф по спирали, мерцание светлячков
    float ang = aSeed.x * TAU + t * (0.35 + 0.3 * aSeed.z);
    float h = fract(aSeed.y + t * 0.05 * (aSeed.z - 0.4));
    float r = 0.45 + 0.35 * aSeed.w + 0.1 * sin(t * 0.8 + aSeed.y * 7.0);
    p = vec3(cos(ang) * r, 0.15 + h * uH * 1.0, sin(ang) * r);
    a = pow(0.5 + 0.5 * sin(t * (2.0 + 3.0 * aSeed.z) + aSeed.w * 20.0), 3.0);
  } else {                                 // storm: короткие вспышки у плеч и рук
    float cyc = floor(t * (1.3 + aSeed.z) + aSeed.y * 10.0);
    float ph = fract(t * (1.3 + aSeed.z) + aSeed.y * 10.0);
    float h1 = fract(sin(cyc * 12.9898 + aSeed.x * 78.233) * 43758.5453);
    float h2 = fract(sin(cyc * 39.346 + aSeed.w * 11.135) * 24634.6345);
    float ang = h1 * TAU;
    float r = 0.25 + 0.35 * h2;
    p = vec3(cos(ang) * r, uH * (0.45 + 0.4 * fract(h1 * 7.0)), sin(ang) * r);
    p += vec3(sin(t * 30.0 + aSeed.x * 50.0), cos(t * 27.0 + aSeed.y * 40.0), sin(t * 33.0)) * 0.015;
    a = (1.0 - smoothstep(0.0, 0.18, ph)) * step(0.35, h2);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // у самой камеры (приближенная витрина) искры гаснут и не раздуваются в пелену на весь кадр
  vA = a * uK * smoothstep(0.45, 1.1, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(56.0, uSize * (0.6 + 0.8 * aSeed.z) * (300.0 / max(0.5, -mv.z)) * (0.5 + 0.5 * a));
}`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uStyle;
varying float vA;
varying float vMix;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float core = smoothstep(0.5, 0.0, d);
  float glow = pow(core, 2.2);
  if (uStyle > 0.5 && uStyle < 1.5) {       // кристалл: ромб
    float dia = abs(c.x) * 1.6 + abs(c.y);
    glow = smoothstep(0.5, 0.05, dia) * 0.9 + pow(core, 6.0) * 0.8;
  }
  vec3 col = mix(uColor, uColor2, vMix) * (1.0 + 2.5 * pow(core, 8.0));
  float alpha = glow * vA;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const STYLE = { ember: 0, frost: 1, wind: 2, storm: 3 };
const COUNT = { ember: 64, frost: 22, wind: 36, storm: 30 };

export function createHeroAura(THREE, parent, fx, { quality = 'medium', height = 1.8 } = {}) {
  if (!fx || !parent) return null;
  const style = STYLE[fx.style] ?? 0;
  const n = Math.max(6, Math.round((COUNT[fx.style] || 40) * (quality === 'low' ? 0.4 : quality === 'high' ? 1.3 : 1)));
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(n * 4);
  let s = 1234 + style * 97;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), height);
  const U = {
    uTime: { value: 0 }, uSize: { value: style === 1 ? 0.2 : style === 3 ? 0.15 : style === 0 ? 0.13 : 0.12 }, uH: { value: height },
    uStyle: { value: style }, uK: { value: 1 },
    uColor: { value: new THREE.Color(fx.color || 0xffffff) }, uColor2: { value: new THREE.Color(fx.color2 || fx.color || 0xffffff) },
  };
  const m = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const pts = new THREE.Points(g, m);
  pts.name = `hero-aura-${fx.style}`;
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  parent.add(pts);
  let k = 1;
  return {
    object: pts,
    update(t) { U.uTime.value = t; },
    setIntensity(v) { k = Math.max(0, v); U.uK.value = k; pts.visible = k > 0.01; },
    setLod(l) { pts.visible = l < 2 && k > 0.01; },
    dispose() { if (pts.parent) pts.parent.remove(pts); g.dispose(); m.dispose(); },
  };
}
