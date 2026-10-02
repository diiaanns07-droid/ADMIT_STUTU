// ASHEN OATH — modules/fx/decals.js. Владелец: №7 [VFX].
// Декали на земле V6: ожоги, кратеры метеоров, иней, трещины, цветы исцеления, пятна пустоты, руны, лепестки,
// [W4-УДАР] «лужи света» (pool) — мягкое растекающееся свечение стихии под ударом, плавно остывает.
//  - ВСЕ декали — ОДИН draw call: InstancedBufferGeometry (плоский квад на декаль), атрибуты экземпляра
//    (позиция+радиус, вид/рождение/жизнь/поворот, цвета, rival, seed) пишутся только при спавне/смерти,
//    возраст считается в шейдере от uNow → в обычном кадре на GPU уходит лишь один uniform;
//  - узор каждого вида процедурный (value noise / fbm ≤ 4 октав, без текстур); тёмное пятно —
//    премультиплицированная альфа (vec4(col*a, a)), свечение — аддитив в том же выходе (альфа 0);
//  - всё угасает на последних 30% жизни; свечение остывает быстрее тёмного пятна;
//  - polygonOffset(-4, -4) против z-fighting с полом, renderOrder 2 (под остальными эффектами);
//  - [W4-УДАР] следы ударов: spawn({ tag, cap, merge }) — не больше cap живых декалей с этим tag (лишняя
//    старая не исчезает, а гаснет за KILL_FADE); merge — рядом уже есть свежая такая же: она ярче, новой нет.
// Координаты — в пространстве root (в игре root без трансформации = мир), декаль лежит на pos.y + 0.03.
import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const POOL = 24;           // размер буферов экземпляров (high)
const HANDLES = 96;
const EXT = 1.12;          // квад шире радиуса — место под неровный край и ореол
const KILL_FADE = 0.45;    // сек угасания при kill(true)
const KINDS = Object.freeze({ scorch: 0, crater: 1, frost: 2, crack: 3, heal: 4, void: 5, rune: 6, petals: 7, pool: 8 });
const KDEF = Object.freeze([
  Object.freeze({ color: ELEMENTS.fire.mid, hot: ELEMENTS.fire.core }),
  Object.freeze({ color: ELEMENTS.fire.mid, hot: ELEMENTS.fire.core }),
  Object.freeze({ color: ELEMENTS.frost.mid, hot: ELEMENTS.frost.core }),
  Object.freeze({ color: ELEMENTS.storm.mid, hot: ELEMENTS.storm.core }),
  Object.freeze({ color: ELEMENTS.heal.mid, hot: ELEMENTS.heal.hot }),
  Object.freeze({ color: ELEMENTS.void.mid, hot: ELEMENTS.void.hot }),
  Object.freeze({ color: ELEMENTS.gold.mid, hot: ELEMENTS.gold.hot }),
  Object.freeze({ color: ELEMENTS.heal.mid, hot: ELEMENTS.heal.hot }),
  Object.freeze({ color: ELEMENTS.gold.mid, hot: ELEMENTS.gold.core }),   // [W4-УДАР] pool
]);
const QUALITY = Object.freeze({
  low: Object.freeze({ cap: 8, hq: 0 }),
  medium: Object.freeze({ cap: 16, hq: 1 }),
  high: Object.freeze({ cap: POOL, hq: 1 }),
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);

// ---------------------------------------------------------------- GLSL
const VS = /* glsl */`
attribute vec4 iA;   // x, y, z, радиус
attribute vec4 iB;   // вид, рождение, жизнь, поворот
attribute vec4 iC;   // линейный цвет свечения, яркость
attribute vec4 iD;   // линейный hot, rival
attribute vec2 iE;   // seed 0..1, начало kill-угасания (<0 — нет)
uniform float uNow;
varying vec2 vP;
varying vec4 vB;     // вид, возраст (с), возраст 0..1, угасание
varying vec4 vC;
varying vec4 vD;
varying vec3 vE;     // seed, cos(rot), sin(rot)
void main() {
  float c = cos(iB.w), s = sin(iB.w);
  vec2 q = position.xy;
  vec2 w = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * (iA.w * ${EXT.toFixed(3)});
  vec3 lp = vec3(iA.x + w.x, iA.y + 0.03, iA.z + w.y);
  vP = q * ${EXT.toFixed(3)};
  float age = max(uNow - iB.y, 0.0);
  float ageN = age / max(iB.z, 1e-3);
  float fade = 1.0 - smoothstep(0.7, 1.0, ageN);
  if (iE.y >= 0.0) fade *= clamp(1.0 - (uNow - iE.y) / ${KILL_FADE.toFixed(3)}, 0.0, 1.0);
  vB = vec4(iB.x, age, ageN, fade);
  vC = iC; vD = iD; vE = vec3(iE.x, c, s);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(lp, 1.0);
}
`;

const FS = /* glsl */`
#define TAU 6.2831853
uniform float uNow;
uniform float uHQ;
uniform vec2 uLight;   // направление К свету в мире (x, z) — рельеф кратера
varying vec2 vP;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
varying vec3 vE;
${FX_NOISE}
${FX_RIVAL}
float FBM(vec2 p) { return uHQ > 0.5 ? fxFbm2(p) : fxNoise2(p) * 0.94; }
// рампа накала: 0 — погасло, 0.33 — тёмно-красный deep, 0.66 — mid, 1 — hot (яркость растёт с накалом)
vec3 heat(float t, vec3 hot, vec3 mid, vec3 deep) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = t < 0.33 ? deep * (t / 0.33) : (t < 0.66 ? mix(deep, mid, (t - 0.33) / 0.33) : mix(mid, hot, (t - 0.66) / 0.34));
  return c * (0.5 + t * 1.5);
}
// радиальные трещины: x — расстояние до ближайшего луча (в радиусах), y — хэш луча
vec2 rays(float r, float ang, float N, float sd, float wig) {
  float q = ang * (N / TAU) + (fxNoise2(vec2(r * 4.0, sd)) - 0.5) * wig + (fxNoise2(vec2(r * 13.0, sd + 5.0)) - 0.5) * wig * 0.3;
  float qi = floor(q + 0.5);
  return vec2(abs(q - qi) * TAU * r / N, fxH1(mod(qi, N) + sd));
}
void main() {
  vec2 p = vP;
  float r = length(p);
  float fade = vB.w;
  if (r > ${EXT.toFixed(3)} || fade <= 0.002) discard;
  float kind = vB.x, age = vB.y;
  float sd = vE.x * 61.7;
  float ang = atan(p.y, p.x);
  vec3 glow = vC.rgb, hot = vD.rgb;
  float I = vC.a;
  vec3 deep = glow * glow * 0.8;
  vec3 sc = vec3(0.0);
  float sa = 0.0;
  vec3 e = vec3(0.0);
  if (kind < 0.5) {
    // ---- scorch: обугленное пятно с рваным краем + тлеющие угольки
    vec2 pp = p / mix(0.6, 1.0, smoothstep(0.0, 0.22, age));
    float rr = length(pp);
    float n = FBM(pp * 2.1 + sd);
    float edge = rr + (n - 0.47) * 0.6;
    float m = 1.0 - smoothstep(0.58, 0.9, edge);
    float n2 = fxNoise2(pp * 6.5 + sd * 1.7);
    sa = m * (0.74 + 0.24 * n2);
    sc = vec3(0.016, 0.011, 0.008) * (0.4 + 1.2 * n2);
    float ash = fxBand(edge, 0.7, 0.05, 0.1) * (0.4 + 0.6 * n2);
    sc = mix(sc, vec3(0.07, 0.06, 0.052), ash * 0.6);
    vec2 g = pp * 7.0 + sd; vec2 ci = floor(g); vec2 f = fract(g);
    float h = fxH2(ci), h2 = fxH2(ci + 17.3);
    vec2 cc = 0.25 + 0.5 * vec2(h2, fxH2(ci + 5.7));
    float spk = step(0.42, h) * (1.0 - smoothstep(0.03, 0.09 + 0.08 * h2, length(f - cc))) * m;
    float cool = exp(-age / (0.8 + 2.8 * h2));
    float fl = 0.75 + 0.25 * sin(uNow * (4.0 + h * 7.0) + h * 40.0);
    e += heat(cool * fl, hot, glow, deep) * (spk * I * 1.25);
    float ring = fxBand(edge, 0.62, 0.02, 0.07) * smoothstep(0.3, 0.75, n2);
    float cR = exp(-age / 1.6);
    e += heat(0.25 + 0.55 * cR, hot, glow, deep) * (ring * I * (0.2 + 0.9 * cR));
    e += hot * (exp(-rr * rr * 5.0) * exp(-age * 3.5) * I * 1.5);
  } else if (kind < 1.5) {
    // ---- crater: тёмная чаша, светлый вал, раскалённая кромка и радиальные трещины (остывают ~3 с)
    float n = FBM(p * 3.2 + sd);
    float rr = r + (n - 0.47) * 0.16;
    vec2 L = vec2(uLight.x * vE.y + uLight.y * vE.z, -uLight.x * vE.z + uLight.y * vE.y); // мир → локаль
    vec2 dir = p / max(r, 1e-4);
    float lit = dot(dir, L);
    float bowl = 1.0 - smoothstep(0.55, 0.7, rr);
    float rim = fxBand(rr, 0.75, 0.045, 0.09);
    float spray = (1.0 - smoothstep(0.78, 1.05, rr + (n - 0.5) * 0.5)) * smoothstep(0.35, 0.6, n);
    float depth = clamp(1.0 - rr / 0.7, 0.0, 1.0);
    vec3 cBowl = vec3(0.012, 0.009, 0.007) * (0.6 + 0.8 * n) * (1.0 + 1.2 * clamp(-lit, 0.0, 1.0) * (1.0 - depth));
    vec3 cRim = vec3(0.1, 0.082, 0.065) * (0.45 + 0.55 * lit) * (0.6 + 0.8 * n);
    vec3 cSpray = vec3(0.03, 0.025, 0.02) * (0.6 + 0.8 * n);
    sa = max(max(bowl * 0.95, rim * 0.88), spray * 0.6);
    sc = mix(cSpray, cRim, rim);
    sc = mix(sc, cBowl, bowl);
    vec2 cr = rays(r, ang, 11.0, sd, 1.1);
    float lenC = 0.6 + 0.45 * cr.y;
    float wC = mix(0.03, 0.008, clamp(r / lenC, 0.0, 1.0));
    float along = smoothstep(0.1, 0.22, r) * (1.0 - smoothstep(lenC * 0.75, lenC, r));
    float crack = (1.0 - smoothstep(wC * 0.35, wC, cr.x)) * along;
    float core = (1.0 - smoothstep(0.0, wC * 0.45, cr.x)) * along;
    sa = max(sa, crack * 0.95);
    sc = mix(sc, vec3(0.004, 0.002, 0.001), crack);
    float tR = exp(-age / 1.0), tC = exp(-age / 1.5);
    e += heat(0.3 + 0.7 * tC * (1.0 - 0.35 * r), hot, glow, deep) * (core * I * (0.6 + 1.6 * tC));
    e += heat(0.3 + 0.6 * tC, hot, glow, deep) * (crack * I * 0.25);
    float rimIn = fxBand(rr, 0.68, 0.015, 0.05) * (0.7 + 0.6 * n);
    e += heat(0.32 + 0.68 * tR, hot, glow, deep) * (rimIn * I * (0.45 + 2.2 * tR));
    e += heat(tR, hot, glow, deep) * (exp(-r * r * 9.0) * I * 2.0 * tR);
  } else if (kind < 2.5) {
    // ---- frost: иней — звезда-папоротник из 6 лучей, светящийся ледяной край, искры
    float grow = mix(0.25, 1.0, smoothstep(0.0, 0.55, age));
    float n = FBM(p * 2.6 + sd);
    float edge = r + (n - 0.47) * 0.45;
    float cov = 1.0 - smoothstep(0.55 * grow, 0.95 * grow, edge);
    float sec = TAU / 6.0;
    float a6 = mod(ang + sec * 0.5, sec) - sec * 0.5;
    float u = cos(a6) * r, v = abs(sin(a6) * r);
    float reach = 0.92 * grow;
    float spoke = (1.0 - smoothstep(0.004, 0.018, v)) * (1.0 - smoothstep(reach * 0.85, reach, u));
    float bd = abs(fract((u - v * 1.1) * 8.0) - 0.5) * 0.084;
    float barbLen = (1.0 - u / max(reach, 0.01)) * 0.34;
    float barb = (1.0 - smoothstep(0.003, 0.012, bd)) * (1.0 - smoothstep(barbLen * 0.75, barbLen, v)) * step(0.06, u) * step(u, reach);
    float a6b = mod(ang, sec) - sec * 0.5;
    float u2 = cos(a6b) * r, v2 = abs(sin(a6b) * r);
    float spoke2 = (1.0 - smoothstep(0.003, 0.012, v2)) * (1.0 - smoothstep(reach * 0.4, reach * 0.55, u2));
    float crystal = max(max(spoke, barb), spoke2 * 0.8);
    vec2 g = p * 16.0 + sd; vec2 ci = floor(g); vec2 f = fract(g) - 0.5;
    float h = fxH2(ci);
    float tw = pow(0.5 + 0.5 * sin(uNow * (5.0 + 6.0 * h) + h * 60.0), 12.0);
    float spk = step(0.6, h) * (1.0 - smoothstep(0.02, 0.12, length(f))) * tw * cov;
    float rim = fxBand(edge, 0.8 * grow, 0.015, 0.05) * (0.4 + 0.8 * n);
    sa = clamp(cov * (0.3 + 0.35 * n) + crystal * 0.3, 0.0, 0.85);
    sc = vec3(0.42, 0.6, 0.75) * (0.55 + 0.55 * n);
    float cool = 0.45 + 0.55 * exp(-age / 2.5);
    e = (hot * crystal * 0.9 + glow * rim * 0.9 + glow * (cov * n * 0.08)) * (I * cool) + hot * (spk * I * 2.2);
  } else if (kind < 3.5) {
    // ---- crack: радиальные тёмные трещины с светящейся жилой внутри
    float n = FBM(p * 2.2 + sd);
    float grow = smoothstep(0.0, 0.18, age);
    vec2 c1 = rays(r, ang, 9.0, sd, 0.9);
    float lenC = (0.62 + 0.38 * c1.y) * mix(0.3, 1.0, grow);
    float wD = mix(0.032, 0.006, clamp(r / lenC, 0.0, 1.0));
    float along = smoothstep(0.05, 0.12, r) * (1.0 - smoothstep(lenC * 0.8, lenC, r));
    float dark = (1.0 - smoothstep(wD * 0.5, wD, c1.x)) * along;
    float line = (1.0 - smoothstep(0.0, wD * 0.4, c1.x)) * along;
    float halo = (1.0 - smoothstep(0.0, wD * 3.0, c1.x)) * along;
    vec2 c2 = rays(r, ang + 0.37, 23.0, sd * 3.1 + 9.0, 1.4);
    float st = 0.25 + 0.35 * c2.y, en = min(st + 0.12 + 0.25 * fract(c2.y * 7.31), lenC);
    float along2 = step(0.4, c2.y) * smoothstep(st, st + 0.03, r) * (1.0 - smoothstep(en - 0.05, en, r));
    float dark2 = (1.0 - smoothstep(0.006, 0.012, c2.x)) * along2;
    float line2 = (1.0 - smoothstep(0.0, 0.005, c2.x)) * along2;
    float ringD = abs(r - 0.42 - (n - 0.47) * 0.1);
    float ringC = (1.0 - smoothstep(0.004, 0.012, ringD)) * step(0.52, fxNoise2(vec2(ang * 2.5, sd + 2.0))) * step(0.44, lenC);
    float dust = (1.0 - smoothstep(0.25, 0.95, r + (n - 0.47) * 0.5)) * 0.3;
    float dk = max(max(dark, dark2 * 0.9), ringC * 0.8);
    sa = max(dk * 0.95, dust);
    sc = mix(vec3(0.03, 0.028, 0.026) * (0.6 + 0.6 * n), vec3(0.003), dk);
    float gT = exp(-age / 1.3) + 0.12 * exp(-age / 5.0);
    float fl = 0.8 + 0.2 * sin(uNow * 37.0 + r * 23.0 + sd);
    float ln = max(max(line, line2 * 0.8), ringC * 0.5);
    e = (mix(glow, hot, 0.55) * (ln * 1.3) + glow * (halo * 0.25) + hot * (ln * exp(-age * 2.0))) * (I * gT * fl);
    e += hot * (exp(-r * r * 40.0) * I * gT * 1.2);
  } else if (kind < 4.5) {
    // ---- heal: мягкое золотисто-зелёное цветение — три кольца лепестков, центр, тонкий круг
    float pulse = 0.85 + 0.15 * sin(uNow * 2.4 + sd);
    float cool = 0.5 + 0.5 * exp(-age / 3.0);
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      float R = 0.3 + 0.28 * fk;
      float N = 6.0 + 4.0 * fk;
      float ap = smoothstep(0.08 * fk, 0.08 * fk + 0.45, age);
      float spin = age * 0.12 * (mod(fk, 2.0) * 2.0 - 1.0) + fk * 0.7 + sd;
      float lat = (fract((ang + spin) * (N / TAU)) - 0.5) * TAU * r / N;
      float dr = (r - R) / max((0.16 - 0.025 * fk) * ap, 1e-3);
      float wz = 0.42 * TAU * R / N * pow(max(1.0 - abs(dr), 0.0), 0.6);
      float pet = (1.0 - smoothstep(wz * 0.65, wz, abs(lat))) * step(abs(dr), 1.0) * ap;
      float vein = 1.0 - smoothstep(0.0, 0.3, abs(lat) / max(wz, 1e-3));
      e += mix(glow, hot, clamp(0.3 + 0.5 * dr, 0.0, 1.0)) * (pet * (0.45 + 0.55 * vein));
      sa += pet * 0.3;
    }
    e += hot * (exp(-r * r * 16.0) * 1.1) + glow * (exp(-r * r * 2.5) * 0.12);
    e += hot * (fxBand(r, 0.97, 0.006, 0.012) * 0.8 * smoothstep(0.3, 0.8, age));
    e *= I * pulse * cool;
    sc = glow * 0.3;
    sa = min(sa, 0.5);
  } else if (kind < 5.5) {
    // ---- void: фиолетово-чёрное пятно, закрученные тёмные жилы, светящийся фиолетовый край
    float n = FBM(p * 2.3 + sd);
    float edge = (r + (n - 0.47) * 0.5) / mix(0.45, 1.0, smoothstep(0.0, 0.35, age));
    float m = 1.0 - smoothstep(0.66, 0.9, edge);
    float tw = r * 4.5 - uNow * 0.7;
    float cs = cos(tw), sn = sin(tw);
    vec2 tp = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs);
    float vn = fxNoise2(tp * 3.5 + sd) * 0.65 + fxNoise2(tp * 7.0 + sd + 3.0) * 0.35;
    float vein = (1.0 - smoothstep(0.0, 0.06, abs(vn - 0.5))) * m;
    sc = mix(vec3(0.014, 0.004, 0.026) * (0.6 + 0.8 * n), vec3(0.0), vein * 0.9);
    sa = m * (0.84 + 0.14 * vein);
    float pulse = 0.75 + 0.25 * sin(uNow * 2.2 + sd);
    float eg = fxBand(edge, 0.74, 0.02, 0.07), ec = fxBand(edge, 0.74, 0.004, 0.015);
    e = (glow * (eg * 0.9) + hot * (ec * 1.3) + glow * (vein * 0.3 * (0.5 + 0.5 * sin(uNow * 3.0 - r * 9.0)))) * (I * pulse);
    e += glow * (exp(-r * r * 12.0) * exp(-age * 2.0) * I);
  } else if (kind < 6.5) {
    // ---- rune: выжженный рунный круг — кольца, риски, знаки в поясе, гексаграмма; прожигается по кругу
    float n = fxNoise2(p * 5.0 + sd);
    float rev = clamp(age * 2.2 - (ang + 3.14159) / TAU, 0.0, 1.0);
    float rings = max(max(fxBand(r, 0.93, 0.012, 0.01), fxBand(r, 0.885, 0.004, 0.006)), max(fxBand(r, 0.72, 0.008, 0.008), fxBand(r, 0.3, 0.006, 0.008)));
    float tq = ang * (48.0 / TAU);
    float isLong = step(mod(floor(tq + 0.5), 4.0), 0.5);
    float tick = (1.0 - smoothstep(0.005, 0.01, abs(fract(tq + 0.5) - 0.5) * TAU * r / 48.0)) * step(0.885 - 0.045 * isLong, r) * step(r, 0.93);
    float cq = ang * (16.0 / TAU) + 0.5 + sd * 0.0;
    float cid = mod(floor(cq), 16.0), cu = fract(cq) - 0.5, cv = (r - 0.79) / 0.045;
    float g1 = fxH1(cid + sd), g2 = fxH1(cid + 3.7 + sd), g3 = fxH1(cid + 9.1 + sd);
    float su = cu * TAU * r / 16.0, sv = cv * 0.045;
    float s1 = 1.0 - smoothstep(0.006, 0.011, abs(su - (g1 - 0.5) * 0.1));
    float s2 = (1.0 - smoothstep(0.006, 0.011, abs(su - sv * (g2 > 0.5 ? 1.2 : -1.2) - (g3 - 0.5) * 0.06))) * step(0.25, g2);
    float s3 = (1.0 - smoothstep(0.005, 0.01, abs(sv - (g3 - 0.5) * 0.05))) * step(abs(su), 0.05) * step(0.55, g3);
    float glyph = max(max(s1, s2), s3) * step(abs(cv), 1.0) * step(abs(cu), 0.36);
    float t1 = abs(r * cos(mod(ang, TAU / 3.0) - TAU / 6.0) - 0.36);
    float t2 = abs(r * cos(mod(ang + TAU / 6.0, TAU / 3.0) - TAU / 6.0) - 0.36);
    float hexg = (1.0 - smoothstep(0.005, 0.01, min(t1, t2))) * step(r, 0.72);
    float L = max(max(rings, tick), max(glyph, hexg)) * rev;
    float gF = 0.35 + 0.65 * exp(-age / 4.0);
    float fl = 0.9 + 0.1 * sin(uNow * 3.0 + r * 12.0);
    sa = 0.35 * (1.0 - smoothstep(0.88, 1.0, r)) * (0.7 + 0.3 * n) * smoothstep(0.0, 0.4, age) + L * 0.6;
    sc = vec3(0.012, 0.009, 0.007);
    e = mix(glow, hot, 0.45 + 0.4 * exp(-age / 1.5)) * (L * I * gF * fl * 1.2);
  } else if (kind < 7.5) {
    // ---- petals: рассыпанные лепестки (исцеление), два слоя ячеек
    float pulse = 0.85 + 0.15 * sin(uNow * 2.0 + sd);
    vec3 pcol = vec3(0.0);
    for (int k = 0; k < 2; k++) {
      float fl = float(k);
      float sz0 = 3.2 + 1.5 * fl;
      vec2 o = vec2(sd + fl * 17.3, sd * 0.7 + fl * 5.1);
      vec2 g = p * sz0 + o;
      vec2 ci = floor(g), f = fract(g) - 0.5;
      float h = fxH2(ci + fl * 31.0);
      vec2 c = (vec2(fxH2(ci + 1.7), fxH2(ci + 9.2)) - 0.5) * 0.3;
      float a = h * 43.0 + age * 0.3 * (h - 0.5);
      float ca = cos(a), sa2 = sin(a);
      vec2 dd = f - c;
      vec2 lq = vec2(dd.x * ca - dd.y * sa2, dd.x * sa2 + dd.y * ca);
      float sz = (0.2 + 0.1 * fxH2(ci + 4.4)) * smoothstep(h * 0.5, h * 0.5 + 0.3, age);
      lq /= max(sz, 1e-3);
      float w = 0.42 * pow(max(1.0 - lq.x * lq.x, 0.0), 0.7) * (1.0 - 0.25 * lq.x);
      float pm = (1.0 - smoothstep(w * 0.75, w, abs(lq.y))) * step(abs(lq.x), 1.0) * step(0.3, h);
      pm *= 1.0 - smoothstep(0.75, 0.95, length((ci + 0.5 + c - o) / sz0));
      vec3 col = mix(glow, hot, fxH2(ci + 2.2 + fl));
      float vein = 1.0 - smoothstep(0.0, 0.3, abs(lq.y) / max(w, 1e-3));
      e += col * (pm * (0.35 + 0.5 * vein));
      pcol = mix(pcol, col * 0.45, pm);
      sa = max(sa, pm * 0.7);
    }
    e = e * (I * 0.8 * pulse) + glow * ((1.0 - smoothstep(0.2, 1.0, r)) * 0.05 * I);
    sc = pcol;
  } else {
    // ---- [W4-УДАР] pool: лужа света — растекается за ~0,25 с, рваный край, бегущая рябь, горячее ядро;
    //      свет остывает по экспоненте всю жизнь (не «держится и гаснет»), тёмного пятна почти нет
    vec2 pp = p / mix(0.45, 1.0, smoothstep(0.0, 0.25, age));
    float rr = length(pp);
    float n = FBM(pp * 1.7 + sd);
    float edge = rr + (n - 0.47) * 0.5;
    float m = 1.0 - smoothstep(0.3, 0.92, edge);
    float cool = exp(-vB.z * 2.6);                                   // за жизнь — до ~7%, дальше общий fade
    float n2 = fxNoise2(pp * 5.0 + vec2(uNow * 0.35, -uNow * 0.25) + sd);
    float rip = pow(0.5 + 0.5 * sin(rr * 19.0 - age * 7.0 + n * 3.0), 6.0) * m * exp(-age * 1.6);
    float rim = fxBand(edge, 0.72, 0.03, 0.12) * (0.5 + 0.5 * n2);
    e = (glow * (m * m * (0.35 + 0.4 * n2)) + mix(glow, hot, 0.6) * (rim * 0.8 + rip * 0.9)) * (I * cool);
    e += hot * (exp(-rr * rr * 7.0) * I * 1.4 * exp(-age * 2.4));
    sa = m * 0.1 * cool;
    sc = glow * 0.04;
  }
  sa = clamp(sa, 0.0, 1.0) * fade;
  vec3 col = sc * sa + e * fade;
  col = fxRival(col, vD.a);
  gl_FragColor = vec4(col, sa);
  ${FX_OUT}
}
`;

/**
 * createDecals({ THREE, root }) → { spawn(opts) → handle, update(dt, clock), setQuality, clear, dispose, stats }
 * opts: { pos:{x,y,z}, radius:1.5, kind:'scorch'|'frost'|'crack'|'crater'|'heal'|'void'|'rune'|'petals'|'pool',
 *         life:8, rot:(случайно), color, hot, intensity:1.6, rival:0,
 *         tag, cap, merge }   // [W4-УДАР] tag — группа следов, cap — не больше живых в группе, merge — доля радиуса
 * handle: { alive, kill(fade=true), setIntensity(v) }
 */
export function createDecals(deps) {
  const d = deps || {};
  const THREE = d.THREE, root = d.root;
  if (!THREE || !root || typeof root.add !== 'function') throw new Error('createDecals: нужны THREE и root');

  let Q = QUALITY.high;
  let disposed = false;
  let tNow = 0;
  let dirty = false, liveN = 0, seedCounter = 7;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 2, 1, 0, 3, 2]);
  const mk = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(POOL * size), size);
    a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a;
  };
  const iA = mk('iA', 4), iB = mk('iB', 4), iC = mk('iC', 4), iD = mk('iD', 4), iE = mk('iE', 2);
  const ATTRS = [iA, iB, iC, iD, iE];
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

  const uniforms = { uNow: { value: 0 }, uHQ: { value: 1 }, uLight: { value: new THREE.Vector2(-0.6, -0.8) } };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VS, fragmentShader: FS,
    ...premulBlend(THREE), depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ashen-fx-decals'; mesh.frustumCulled = false; mesh.renderOrder = 2;
  mesh.castShadow = false; mesh.receiveShadow = false; mesh.visible = false;
  root.add(mesh);

  // ---------------------------------------------------------------- слоты и ручки
  const slots = [];
  for (let i = 0; i < POOL; i++) {
    slots.push({ i, active: false, gen: 0, kind: 0, x: 0, y: 0, z: 0, r: 1.5, birth: 0, life: 8, rot: 0,
      col: [0, 0, 0], hot: [0, 0, 0], I: 1.6, rival: 0, seed: 0, killT: -1, tag: '' });
  }
  const order = new Int16Array(POOL);

  class DecalHandle {
    constructor() { this._s = null; this._g = -1; }
    get alive() { const s = this._s; return !!s && s.active && s.gen === this._g && !disposed; }
    kill(fade) {
      if (!this.alive) return;
      const s = this._s;
      if (fade === false) { freeSlot(s); return; }
      if (s.killT < 0) { s.killT = tNow; dirty = true; }
    }
    setIntensity(v) { if (this.alive && isNum(v)) { this._s.I = clamp(v, 0, 50); dirty = true; } }
  }
  const handles = [];
  for (let i = 0; i < HANDLES; i++) handles.push(new DecalHandle());
  let handleHead = 0;
  const DEAD = new DecalHandle();

  function freeSlot(s) { if (s.active) { s.active = false; s.gen++; dirty = true; } }
  function handleFor(s) {
    let h = null;
    for (let k = 0; k < HANDLES; k++) {
      const c = handles[handleHead]; handleHead = (handleHead + 1) % HANDLES;
      if (!c.alive) { h = c; break; }
    }
    if (!h) return DEAD;
    h._s = s; h._g = s.gen; return h;
  }
  function countActive() { let n = 0; for (let i = 0; i < POOL; i++) if (slots[i].active) n++; return n; }
  function oldest() {
    let best = null;
    for (let i = 0; i < POOL; i++) { const s = slots[i]; if (s.active && (!best || s.birth < best.birth)) best = s; }
    return best;
  }
  function takeSlot() {
    // лимит качества: сверх него перерабатываем самую старую декаль
    while (countActive() >= Q.cap) { const o = oldest(); if (!o) break; freeSlot(o); }
    for (let i = 0; i < POOL; i++) if (!slots[i].active) return slots[i];
    return null;
  }

  // [W4-УДАР] группа следов: свежая такая же рядом (merge) — ярче и без новой; сверх cap — старейшая гаснет
  function tagged(tag, kind, o) {
    const merge = num(o.merge, 0), cap = Math.floor(num(o.cap, 0));
    let n = 0, old = null;
    for (let i = 0; i < POOL; i++) {
      const s = slots[i];
      if (!s.active || s.tag !== tag || s.killT >= 0) continue;
      if (merge > 0 && s.kind === kind && tNow - s.birth < s.life * 0.5) {
        const dx = s.x - o.pos.x, dz = s.z - o.pos.z, rr = merge * Math.max(s.r, num(o.radius, 1.5));
        if (dx * dx + dz * dz < rr * rr && Math.abs(s.y - o.pos.y) < 0.6) {
          s.I = Math.min(2.4, Math.max(s.I, clamp(num(o.intensity, 1.6), 0, 50) * 0.8) * 1.12); dirty = true;
          return handleFor(s);
        }
      }
      n++;
      if (!old || s.birth < old.birth) old = s;
    }
    if (cap > 0 && n >= cap && old) { old.killT = tNow; dirty = true; }
    return null;
  }

  function spawn(opts) {
    if (disposed) return DEAD;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!hasVec(o.pos)) return DEAD;
    const kind = KINDS[o.kind] !== undefined ? KINDS[o.kind] : 0;
    const tag = typeof o.tag === 'string' ? o.tag : '';
    if (tag) { const m = tagged(tag, kind, o); if (m) return m; }
    const s = takeSlot();
    if (!s) return DEAD;
    const df = KDEF[kind];
    seedCounter = (seedCounter * 16807) % 2147483647;
    const rnd = seedCounter / 2147483647;
    s.active = true; s.gen++;
    s.kind = kind;
    s.x = o.pos.x; s.y = o.pos.y; s.z = o.pos.z;
    s.r = clamp(num(o.radius, 1.5), 0.05, 30);
    s.life = clamp(num(o.life, 8), 0.1, 600);
    s.rot = isNum(o.rot) ? o.rot : rnd * Math.PI * 2;
    s.birth = tNow;
    hexLin(isNum(o.color) ? o.color : df.color, s.col);
    hexLin(isNum(o.hot) ? o.hot : df.hot, s.hot);
    s.I = Math.min(2, clamp(num(o.intensity, 1.6), 0, 50) * 0.8); // [VFX] калибровка под bloom игры (мокрый пол)
    s.rival = clamp(num(o.rival, 0), 0, 1);
    s.seed = (rnd * 7919.37) % 1;
    s.killT = -1;
    s.tag = tag;
    dirty = true;
    return handleFor(s);
  }

  // плотная запись экземпляров (старые первыми — новые рисуются поверх)
  function rebuild() {
    let n = 0;
    for (let i = 0; i < POOL; i++) {
      if (!slots[i].active) continue;
      let j = n++;
      while (j > 0 && slots[order[j - 1]].birth > slots[i].birth) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    const A = iA.array, B = iB.array, C = iC.array, D = iD.array, E = iE.array;
    for (let k = 0; k < n; k++) {
      const s = slots[order[k]], o4 = k * 4, o2 = k * 2;
      A[o4] = s.x; A[o4 + 1] = s.y; A[o4 + 2] = s.z; A[o4 + 3] = s.r;
      B[o4] = s.kind; B[o4 + 1] = s.birth; B[o4 + 2] = s.life; B[o4 + 3] = s.rot;
      C[o4] = s.col[0]; C[o4 + 1] = s.col[1]; C[o4 + 2] = s.col[2]; C[o4 + 3] = s.I;
      D[o4] = s.hot[0]; D[o4 + 1] = s.hot[1]; D[o4 + 2] = s.hot[2]; D[o4 + 3] = s.rival;
      E[o2] = s.seed; E[o2 + 1] = s.killT;
    }
    for (let a = 0; a < ATTRS.length; a++) ATTRS[a].needsUpdate = true;
    geo.instanceCount = n;
    liveN = n;
    mesh.visible = n > 0;
    dirty = false;
  }

  function update(dt, clock) {
    if (disposed) return;
    const h = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    tNow += h;
    uniforms.uNow.value = tNow;
    try {
      for (let i = 0; i < POOL; i++) {
        const s = slots[i];
        if (!s.active) continue;
        if (tNow - s.birth >= s.life || (s.killT >= 0 && tNow - s.killT >= KILL_FADE)) freeSlot(s);
      }
      if (dirty) rebuild();
    } catch (e) { /* эффекты не роняют кадр */ }
  }

  function setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    Q = q;
    uniforms.uHQ.value = q.hq;
    while (countActive() > Q.cap) { const o = oldest(); if (!o) break; freeSlot(o); }
    if (dirty) rebuild();
  }
  function clear() {
    for (let i = 0; i < POOL; i++) freeSlot(slots[i]);
    rebuild();
  }
  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose(); mat.dispose();
  }
  function stats() { return { active: liveN, drawCalls: mesh.visible ? 1 : 0, cap: Q.cap }; }

  return { spawn, update, setQuality, clear, dispose, stats, mesh };
}
