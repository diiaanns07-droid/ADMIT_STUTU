// ASHEN OATH — modules/menuStage.js. [W4-ВИТРИНА] Сцена витрины героя в меню: «обложка игры».
// За спиной героя — каменный портал в руинах (вихрь цвета стихии, ореол с лучами, парящие обломки),
// по бокам — разбитые колонны; под ногами — тёмный полированный пол храма с отражением, у ног — дымка;
// в воздухе — медленные частицы стихии (пепел и угли, искры грозы, лёд, листья ветра). Появление героя —
// руническая волна по полу и кольцо света; пока модель грузится — столп призыва и спираль частиц.
//
// Свет — только в шейдерах (источники сцены не добавляются ни на одном уровне): камень, пол и дымка
// считают свет портала, тёплого ключа витрины и холодного неба сами. Число источников сцены не меняется —
// материалы мира не перекомпилируются, бой не платит ни за что. Текстур нет (шум — в шейдерах), кроме
// отражения пола на medium/high (≤ 640 px по ширине, low — без прохода: отражение портала аналитическое).
//
// Вызовы отрисовки (меню): камень (портал, колонны, помост, обломки — одна геометрия), вихрь, ореол,
// пол, дымка, частицы — 6; кольцо волны и столп призыва — +1 каждое, только пока видны.
// medium/high: + отражение — герой и портал (слой REFLECT_LAYER) в малую цель, один раз за кадр.
// Сцена строится сразу при создании (prebuild: шейдеры соберёт общая сборка мира main.js — compileAsync — до первого
// кадра меню) и освобождается (dispose), когда меню закрыто дольше 2 с: в бою — ни геометрии, ни программ,
// ни текстур витрины. Возврат в меню: сцена строится заново и прячется, пока renderer.compileAsync не соберёт её
// программы (без рывка первого кадра; не дольше 3 с).
//
// createMenuStage({ THREE, scene, quality, reducedMotion, prebuild })
//   → { group, update(dt, view) → bool, setQuality(q), setReducedMotion(b), wave(), setReflect(root), portalWorld(out),
//       info(), dispose() }
// view = { w (0..1 видимость), active, heroPos: Vector3, heroYaw, camera, fx: { style, color, color2 },
//          element (текст стихии), key: Vector3 (мировая позиция ключевого света), appear (0..1), loading (с),
//          orbit (рад: портал с помостом доворачивается за облётом камеры — не уходит под панель меню) }

export const REFLECT_LAYER = 7;   // слой отражения: герой и портал (камера мира его не включает)

const TAU = Math.PI * 2;
// частицы: что летит у какой стихии (kindA, kindB, доля B) — 0 угли, 1 пепел, 2 искры, 3 листья, 4 лёд, 5 огоньки
const PARTS = {
  'Пепел и пламя': [0, 1, 0.42], 'Гроза': [2, 3, 0.45], 'Тьма и лёд': [4, 5, 0.38], 'Ветер': [3, 5, 0.3], 'Буря': [2, 5, 0.42],
};
const PARTS_BY_STYLE = { ember: [0, 1, 0.42], wind: [3, 5, 0.3], frost: [4, 5, 0.38], storm: [2, 5, 0.42] };
// цена по уровню: частицы, обломки, слои дымки, октавы шума, отражение (ширина цели, 0 — нет), отводы размытия
const TIER = {
  low: { parts: 90, rocks: 8, mist: 2, oct: 2, mirror: 0, taps: 1 },
  medium: { parts: 220, rocks: 14, mist: 3, oct: 3, mirror: 384, taps: 1 },
  high: { parts: 420, rocks: 22, mist: 4, oct: 4, mirror: 640, taps: 5 },
};
const MAX_PARTS = 420, MAX_ROCKS = 22, MAX_MIST = 4;
// портал: центр (местные оси сцены: +Z — вперёд героя, к камере; +X — правее на экране), радиусы.
// ≈9,5 м за героем: у края арены (место старта по умолчанию) это свободная полоса между колоннами мира,
// алтарём и обломками; ближе 8 м — кольцо колонн. Колонны мира стоят перед порталом силуэтами на его свете.
// Центр кольца — на высоте ≈2,8 м: с камеры витрины он ложится за голову героя (вихрь — ореол за силуэтом).
const PORTAL = { x: -1.2, z: -9.3, rMid: 2.45, thick: 0.5, depth: 0.78, lift: 0.36 };
const FLOOR_R = 9.5;

// ---------------------------------------------------------------- GLSL: общий шум и туман
const NOISE = /* glsl */`
float h11(float n){ return fract(sin(n) * 43758.5453123); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p, float oct){ float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 5; i++) { if (float(i) >= oct) break; s += a * vn(p); n += a; p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s / max(n, 1e-3); }
`;
const OUT = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// ---------------------------------------------------------------- камень: портал, колонны, ступени, обломки
const STONE_VERT = /* glsl */`
attribute vec3 aK;            // x: 0 — камень, 1 — блок кольца портала (руны), 2 — парящий обломок; y — случайное; z — скорость
uniform float uTime;
uniform mat4 uPortalM, uPortalInv;   // оси портала → оси сцены и обратно
varying vec3 vP; varying vec3 vN; varying vec2 vK;
void main(){
  vec3 p = position; vec3 n = normal;
  if (aK.x > 1.5) {
    // обломок кружит вокруг оси портала и покачивается
    vec3 q = (uPortalInv * vec4(p, 1.0)).xyz;
    vec3 nq = mat3(uPortalInv) * n;
    float ang = uTime * (0.035 + 0.05 * aK.z) * (aK.y > 0.5 ? 1.0 : -1.0);
    float c = cos(ang), s = sin(ang);
    mat2 R = mat2(c, s, -s, c);
    q.xy = R * q.xy; nq.xy = R * nq.xy;
    q.z += sin(uTime * 0.5 + aK.y * 6.2831) * 0.14;
    q.xy += normalize(q.xy + 1e-4) * sin(uTime * 0.7 + aK.y * 12.0) * 0.06;
    p = (uPortalM * vec4(q, 1.0)).xyz; n = mat3(uPortalM) * nq;
  }
  vP = p; vN = n; vK = aK.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const STONE_FRAG = /* glsl */`
uniform float uTime, uOct, uPortalI, uKeyI, uRune, uFogD, uK;
uniform vec3 uCam, uPortal, uPortalN, uKey, uKeyC, uAmbC, uCol, uCol2, uFogC;
uniform mat4 uPortalInv;
varying vec3 vP; varying vec3 vN; varying vec2 vK;
${NOISE}
void main(){
  vec3 N = normalize(vN);
  vec3 V = uCam - vP; float dist = length(V); V /= dist;
  // камень: крупные пятна, мелкое зерно, тёмные трещины; низ — темнее (сырость)
  vec2 sp = vec2(vP.x * 0.9 + vP.z * 0.7, vP.y * 1.1) + vK.y * 17.0;
  float n1 = fbm(sp * 1.4, uOct);
  float n2 = vn(sp * 9.0 + N.xz * 3.0);
  float crack = 1.0 - smoothstep(0.0, 0.035, abs(vn(sp * 2.6 + 4.0) - 0.5));
  vec3 alb = mix(vec3(0.07, 0.066, 0.064), vec3(0.17, 0.158, 0.145), n1) * (0.82 + 0.32 * n2);
  alb *= 1.0 - 0.55 * crack;
  alb *= 0.72 + 0.28 * smoothstep(0.0, 1.4, vP.y);
  // свет портала (мягкий, спад по расстоянию), тёплый ключ витрины, холодное небо сверху
  vec3 toP = uPortal - vP; float dP = length(toP); vec3 Lp = toP / max(dP, 1e-3);
  float pl = (max(dot(N, Lp), 0.0) * 0.85 + 0.15) * uPortalI * 2.6 / (1.0 + dP * dP * 0.11);
  vec3 toK = uKey - vP; float dK = length(toK);
  float kl = max(dot(N, toK / max(dK, 1e-3)), 0.0) * uKeyI / (1.0 + dK * dK * 0.05);
  float sky = 0.5 + 0.5 * N.y;
  vec3 col = alb * (uAmbC * sky * 1.7 + uCol * pl + uKeyC * kl);
  // контровой: края камня на фоне портала светятся его цветом
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float back = max(dot(-V, Lp), 0.0);
  col += uCol * fres * back * back * uPortalI * 0.6 / (1.0 + dP * 0.3);
  if (vK.x > 0.5 && vK.x < 1.5) {
    // руны по лицевой грани кольца: ячейки по окружности, в каждой — 2–3 черты; бегущий пульс
    vec3 q = (uPortalInv * vec4(vP, 1.0)).xyz; vec3 qn = mat3(uPortalInv) * N;
    float face = smoothstep(0.55, 0.9, qn.z);
    float r = length(q.xy), a = atan(q.y, q.x);
    float cells = 44.0;
    float ca = a / 6.2831853 * cells; float ci = floor(ca); float fx = fract(ca);
    float fy = (r - (${(PORTAL.rMid - PORTAL.thick * 0.5).toFixed(3)} + 0.1)) / ${(PORTAL.thick - 0.2).toFixed(3)};
    float hsh = h21(vec2(ci, 3.0));
    float g = 0.0;
    float w = 0.07;
    g += step(0.3, hsh) * smoothstep(w, 0.0, abs(fx - 0.5)) * step(0.08, fy) * step(fy, 0.92);
    g += step(0.55, fract(hsh * 7.1)) * smoothstep(w, 0.0, abs(fy - 0.3 - 0.4 * fract(hsh * 3.3))) * step(0.2, fx) * step(fx, 0.8);
    g += step(0.6, fract(hsh * 13.7)) * smoothstep(w * 1.2, 0.0, abs((fx - 0.5) - (fy - 0.5) * (fract(hsh * 5.9) > 0.5 ? 1.0 : -1.0))) * step(0.1, fy) * step(fy, 0.9);
    g *= step(0.0, fy) * step(fy, 1.0) * step(0.12, fx) * step(fx, 0.88);
    float pulse = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * 1.1 - a * 2.0), 3.0);
    col += mix(uCol, uCol2, 0.35) * g * face * pulse * uRune * 3.0;
    // внутренняя кромка кольца — отсвет вихря
    float lip = smoothstep(0.35, -0.2, dot(qn.xy, q.xy) / max(r, 1e-3)) * smoothstep(${(PORTAL.rMid - PORTAL.thick * 0.5 + 0.25).toFixed(3)}, ${(PORTAL.rMid - PORTAL.thick * 0.5).toFixed(3)}, r);
    col += uCol * lip * uPortalI * 0.45;
  }
  col = mix(col, uFogC, 1.0 - exp(-uFogD * dist));
  gl_FragColor = vec4(col * uK, 1.0);
  ${OUT}
}`;

// ---------------------------------------------------------------- вихрь портала (диск внутри кольца)
const VORTEX_VERT = /* glsl */`
varying vec2 vXY;
uniform float uR;
void main(){ vXY = position.xy / uR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const VORTEX_FRAG = /* glsl */`
uniform float uTime, uOct, uK;
uniform vec3 uCol, uCol2;
varying vec2 vXY;
${NOISE}
void main(){
  vec2 p = vXY; float r = length(p); float a = atan(p.y, p.x);
  // закрутка к центру и «тоннель» вглубь: полосы бегут к сердцевине
  float tw = a + 1.25 / (r + 0.2) + uTime * 0.22;
  float s1 = fbm(vec2(cos(tw), sin(tw)) * (1.4 + 2.2 * r) + vec2(0.0, uTime * 0.08), uOct);
  float s2 = fbm(vec2(tw / 6.2831853 * 5.0, 0.55 / (r + 0.06) - uTime * 0.32), uOct);
  float streak = smoothstep(0.32, 0.86, s2 * 0.62 + s1 * 0.5);
  float core = exp(-r * r * 6.5);
  vec3 c = mix(uCol * 0.035, uCol * 0.75, streak) * (0.25 + 1.05 * streak);
  c += mix(uCol, uCol2, 0.7) * core * 1.25;
  c += uCol * smoothstep(0.84, 0.985, r) * smoothstep(1.0, 0.965, r) * 1.1;
  // искры в глубине
  vec2 sg = vec2(tw * 6.0, 0.4 / (r + 0.05) - uTime * 0.5) * 3.0;
  float spk = step(0.985, h21(floor(sg))) * smoothstep(0.5, 0.0, length(fract(sg) - 0.5));
  c += uCol2 * spk * 1.6 * (1.0 - core);
  float alpha = smoothstep(1.0, 0.93, r) * 0.9;
  gl_FragColor = vec4(c * uK * alpha, alpha * uK);
  ${OUT}
}`;

// ---------------------------------------------------------------- ореол и лучи за кольцом
const HALO_FRAG = /* glsl */`
uniform float uTime, uK;
uniform vec3 uCol, uCol2;
varying vec2 vXY;
${NOISE}
void main(){
  vec2 p = vXY; float r = length(p); float a = atan(p.y, p.x);
  float glow = exp(-pow(max(r - 1.0, 0.0) * 2.6, 2.0)) * smoothstep(0.82, 1.0, r);
  float wide = 0.3 / (1.0 + pow(r * 0.85, 4.0));
  float rays = pow(vn(vec2(a * 7.0, uTime * 0.12)) * vn(vec2(a * 19.0 + 3.0, uTime * 0.17 + 5.0)), 1.5) * 2.4;
  rays *= smoothstep(0.98, 1.25, r) * exp(-(r - 1.0) * 1.15);
  vec3 c = uCol * (glow * 0.5 + wide * 0.4 + rays * 0.45) + uCol2 * glow * 0.12;
  c *= smoothstep(2.05, 1.5, r) * uK;
  gl_FragColor = vec4(c, 0.0);
  ${OUT}
}`;

// ---------------------------------------------------------------- пол храма: плиты, влажный блеск, отражение, волна
const FLOOR_VERT = /* glsl */`
uniform mat4 uTexM;
varying vec4 vRefl; varying vec3 vP;
void main(){
  vP = position;
  vRefl = uTexM * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FLOOR_FRAG = /* glsl */`
uniform sampler2D uMirror;
uniform float uMirrorK, uTaps, uOct, uTime, uWave, uWaveR, uR, uFogD, uPortalR, uPortalI, uKeyI, uK, uSummon;
uniform vec2 uTexel;
uniform vec3 uCam, uPortal, uPortalN, uKey, uKeyC, uAmbC, uCol, uCol2, uFogC;
varying vec4 vRefl; varying vec3 vP;
${NOISE}
void main(){
  vec2 xz = vP.xz; float rh = length(xz);
  // плиты: концентрические кольца вокруг героя, каждое разбито на камни; швы темнее и матовее
  float ringW = 0.95;
  float rb = rh / ringW; float ri = floor(rb); float rf = fract(rb);
  float ang = atan(xz.y, xz.x);
  float segN = max(5.0, floor(6.2831853 * (ri + 0.5) * ringW / 1.15));
  float sa = ang / 6.2831853 * segN + h11(ri * 7.13) * 3.0; float si = floor(sa); float sf = fract(sa);
  float seamR = min(rf, 1.0 - rf) * ringW;
  float seamA = min(sf, 1.0 - sf) * 6.2831853 * max(rh, 0.3) / segN;
  float seam = smoothstep(0.008, 0.028, min(seamR, ri < 0.5 ? 1.0 : seamA));
  float tile = h21(vec2(ri, si));
  float n1 = fbm(xz * 1.25 + tile * 9.0, uOct);
  vec3 alb = mix(vec3(0.045, 0.045, 0.05), vec3(0.115, 0.108, 0.1), n1 * 0.65 + tile * 0.35);
  alb *= mix(0.4, 1.0, seam);
  // влага: лужицы блестят зеркально, сухой камень — тускло
  float wet = smoothstep(0.38, 0.62, fbm(xz * 0.42 + 3.1, uOct));
  float gloss = mix(0.32, 1.0, wet) * mix(0.15, 1.0, seam);
  vec3 V = uCam - vP; float dist = length(V); V /= dist;
  float fres = mix(0.22, 1.0, pow(1.0 - max(V.y, 0.0), 4.0));
  // свет: ключ витрины (тёплое пятно у ног), портал, холодное небо
  vec3 toK = uKey - vP; float dK = length(toK);
  float kl = max(toK.y / dK, 0.0) * uKeyI / (1.0 + dK * dK * 0.06);
  vec3 toP = uPortal - vP; float dP = length(toP);
  float pl = (0.5 + 0.5 * max(toP.y / dP, 0.0)) * uPortalI / (1.0 + dP * dP * 0.05);
  vec3 col = alb * (uAmbC * 0.55 + uKeyC * kl + uCol * pl);
  // контактная тень у ног и тень от ключа (падает от него назад)
  vec2 sd = normalize(-uKey.xz + 1e-4);
  vec2 so = xz - sd * 0.45;
  float sa1 = dot(so, sd) / 0.75, sa2 = dot(so, vec2(-sd.y, sd.x)) / 0.32;
  float sh = exp(-dot(xz, xz) * 4.0) * 0.6 + exp(-(sa1 * sa1 + sa2 * sa2)) * 0.4;
  col *= 1.0 - sh;
  // отражение: зеркальная цель (герой и портал) или — на low — портал, найденный лучом
  vec3 refl = vec3(0.0);
  vec2 rip = (vec2(vn(xz * 3.1 + uTime * 0.04), vn(xz * 3.1 + 7.0 - uTime * 0.03)) - 0.5) * mix(0.05, 0.012, wet);
  if (uMirrorK > 0.0) {
    vec4 rc = vRefl; rc.xy += rip * rc.w;
    refl = texture2DProj(uMirror, rc).rgb;
    if (uTaps > 1.5) {
      vec2 o = uTexel * rc.w * mix(3.5, 1.5, wet);
      refl = refl * 0.36 + 0.16 * (texture2DProj(uMirror, rc + vec4(o.x, o.y, 0.0, 0.0)).rgb + texture2DProj(uMirror, rc + vec4(-o.x, o.y, 0.0, 0.0)).rgb
        + texture2DProj(uMirror, rc + vec4(o.x, -o.y, 0.0, 0.0)).rgb + texture2DProj(uMirror, rc + vec4(-o.x, -o.y, 0.0, 0.0)).rgb);
    }
    refl *= uMirrorK;
  } else {
    vec3 R = vec3(-V.x, V.y, -V.z); R.xz += rip * 4.0;
    float den = dot(R, uPortalN);
    if (abs(den) > 1e-3) {
      float t = dot(uPortal - vP, uPortalN) / den;
      if (t > 0.0) {
        vec3 H = vP + R * t; float r = length(H - uPortal) / uPortalR;
        float rr = (r - 1.2) * 3.0;
        refl = uCol * smoothstep(1.02, 0.45, r) * 0.9 + mix(uCol, uCol2, 0.7) * exp(-r * r * 5.0) * 1.3 + uCol * exp(-rr * rr) * 0.3;
        refl *= uPortalI * 0.22;
      }
    }
  }
  col += refl * gloss * fres * 0.5;
  // руническая волна: кольцо бежит от героя к краю пола, по кольцу — знаки
  if (uWave >= 0.0) {
    float wr = uWave * uWaveR;
    float d = rh - wr;
    float band = exp(-d * d * 30.0) * (1.0 - uWave);
    float cell = fract(ang / 6.2831853 * 72.0);
    float gl = step(0.35, h11(floor(ang / 6.2831853 * 72.0) + 3.0)) * smoothstep(0.0, 0.25, cell) * smoothstep(1.0, 0.75, cell);
    float dg = d + 0.18;
    float glyph = gl * exp(-dg * dg * 90.0) * (1.0 - uWave);
    float trail = smoothstep(0.0, -1.2, d) * step(d, 0.0) * (1.0 - uWave) * 0.25;
    col += uCol * (band * 2.4 + glyph * 2.0 + trail) + uCol2 * band * band * 1.2;
  }
  // призыв: пол под кругом теплеет и дышит
  col += uCol * uSummon * exp(-rh * rh * 0.7) * (0.35 + 0.15 * sin(uTime * 3.0));
  float alpha = smoothstep(uR, uR * 0.6, rh);
  col = mix(col, uFogC, 1.0 - exp(-uFogD * dist));
  gl_FragColor = vec4(col * alpha * uK, alpha * uK);
  ${OUT}
}`;

// ---------------------------------------------------------------- дымка у ног: слои шума над полом
const MIST_VERT = /* glsl */`
attribute float aL;
varying vec3 vP; varying float vL;
void main(){ vP = position; vL = aL; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MIST_FRAG = /* glsl */`
uniform float uTime, uOct, uK;
uniform vec3 uCam, uPortal, uKeyC, uAmbC, uCol;
varying vec3 vP; varying float vL;
${NOISE}
void main(){
  vec2 xz = vP.xz;
  vec2 wind = vec2(uTime * (0.07 + 0.025 * vL), uTime * 0.018);
  float n = fbm(xz * (0.32 + 0.09 * vL) + wind + vL * 7.3, uOct);
  float d = smoothstep(0.42, 0.86, n);
  float rad = length((xz - vec2(-0.8, -3.6)) / vec2(7.2, 7.2));
  float k = d * smoothstep(1.0, 0.5, rad) * (1.0 - vL * 0.2);
  vec2 pp = xz - uPortal.xz;
  vec3 c = uAmbC * 0.55 + uKeyC * 0.5 * exp(-dot(xz, xz) * 0.09) + uCol * 0.85 * exp(-dot(pp, pp) * 0.035);
  float dist = length(uCam - vP);
  k *= smoothstep(0.5, 2.2, dist);
  gl_FragColor = vec4(c * k * 0.16 * uK, 0.0);
  ${OUT}
}`;

// ---------------------------------------------------------------- частицы стихии
const PART_VERT = /* glsl */`
attribute vec4 aS;
uniform float uTime, uPx, uKindA, uKindB, uMixB, uSummon;
uniform vec3 uBox, uBoxC, uSummonC;
varying float vKind; varying float vA; varying float vRot; varying float vSeed;
void main(){
  float kind = aS.w < uMixB ? uKindB : uKindA;
  float sv = 0.6 + 0.8 * fract(aS.w * 13.7);
  vec3 vel = vec3(0.0); float size = 0.04; float fl = 1.0;
  float t = uTime;
  vec3 sway = vec3(sin(t * 0.7 + aS.x * 40.0), 0.0, cos(t * 0.55 + aS.z * 37.0)) * 0.25;
  if (kind < 0.5) { vel = vec3(0.04, 0.32, 0.02); size = 0.038; fl = 0.6 + 0.4 * sin(t * 9.0 + aS.y * 60.0); }
  else if (kind < 1.5) { vel = vec3(0.12, -0.09, 0.03); size = 0.055; sway *= 1.6; }
  else if (kind < 2.5) { vel = vec3(0.0, 0.62, 0.0); size = 0.026; sway *= 0.5; fl = step(0.35, fract(sin(floor(t * 14.0 + aS.y * 50.0)) * 43758.5)); }
  else if (kind < 3.5) { vel = vec3(0.42, -0.12, 0.08); size = 0.085; sway *= 2.2; }
  else if (kind < 4.5) { vel = vec3(0.05, -0.2, 0.0); size = 0.045; sway *= 0.8; }
  else { vel = vec3(0.03, 0.05, 0.02); size = 0.03; sway *= 1.4; fl = 0.55 + 0.45 * sin(t * 2.3 + aS.x * 30.0); }
  vec3 p = (aS.xyz - 0.5) * 2.0 * uBox + vel * t * sv + sway;
  p = mod(p + uBox, 2.0 * uBox) - uBox;
  vec3 e = abs(p) / uBox;
  float edge = 1.0 - smoothstep(0.8, 1.0, max(max(e.x, e.y), e.z));
  p += uBoxC;
  // призыв: часть частиц стягивается в спираль вокруг круга
  float sk = uSummon * step(fract(aS.w * 7.31), 0.62);
  if (sk > 0.0) {
    float hh = fract(aS.z + t * (0.16 + 0.12 * aS.y));
    float ang = aS.x * 6.2831853 + t * (1.4 + aS.y) + hh * 5.0;
    float rad = mix(1.25, 0.32, hh);
    vec3 sp = uSummonC + vec3(cos(ang) * rad, hh * 3.4, sin(ang) * rad);
    p = mix(p, sp, sk);
    edge = mix(edge, smoothstep(1.0, 0.75, hh) * smoothstep(0.0, 0.08, hh), sk);
    fl = mix(fl, 1.0, sk);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.05);
  gl_PointSize = clamp(size * (0.7 + 0.6 * fract(aS.y * 9.1)) * uPx / z, 1.0, 46.0);
  vA = edge * smoothstep(0.35, 1.2, z) * fl;
  vKind = sk > 0.5 ? 5.0 : kind;
  vRot = aS.y * 6.2831853 + t * (0.6 + aS.x) * (kind > 2.5 && kind < 3.5 ? 1.6 : 0.3);
  vSeed = aS.w;
}`;
const PART_FRAG = /* glsl */`
uniform float uK;
uniform vec3 uCol, uCol2, uAmbC;
varying float vKind; varying float vA; varying float vRot; varying float vSeed;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float c = cos(vRot), s = sin(vRot);
  vec2 qr = mat2(c, s, -s, c) * q;
  float d = length(q);
  vec4 o = vec4(0.0);
  vec3 tint = mix(uCol, uCol2, fract(vSeed * 3.7));
  if (vKind < 0.5 || (vKind > 1.5 && vKind < 2.5) || vKind > 4.5) {
    // свечение: угли, искры, огоньки (аддитивно, альфа 0)
    float g = exp(-d * d * 7.0) + 0.6 * exp(-d * d * 40.0);
    vec3 cc = vKind < 0.5 ? mix(uCol, vec3(1.0, 0.85, 0.55), 0.35) : tint;
    o = vec4(cc * g * 1.6, 0.0);
  } else if (vKind < 1.5) {
    // пепел: рваная тёмная чешуйка с тлеющим краем
    float m = smoothstep(1.0, 0.6, length(qr * vec2(1.0, 1.7)) + 0.25 * sin(qr.x * 9.0 + vSeed * 30.0));
    vec3 ash = vec3(0.16, 0.15, 0.14) + uCol * 0.12 * smoothstep(0.4, 0.9, d);
    o = vec4(ash * m * 0.85, m * 0.85);
  } else if (vKind < 3.5) {
    // лист: овал с прожилкой, освещён небом и порталом
    vec2 l = qr * vec2(1.0, 0.55);
    float m = smoothstep(0.05, -0.05, abs(l.x) - 0.5 * (1.0 - l.y * l.y * 3.2));
    m *= step(abs(l.y), 0.55);
    float vein = smoothstep(0.06, 0.0, abs(l.x));
    vec3 leaf = mix(mix(vec3(0.35, 0.5, 0.18), vec3(0.75, 0.62, 0.25), fract(vSeed * 5.3)), tint, 0.35) * (0.55 + 0.45 * uAmbC.b);
    leaf = leaf * (1.0 - 0.3 * vein) + tint * 0.25;
    o = vec4(leaf * m, m * 0.95);
  } else {
    // лёд: шестилучевая снежинка-кристалл
    float a = atan(qr.y, qr.x);
    float arm = pow(abs(cos(a * 3.0)), 18.0) * smoothstep(1.0, 0.1, d);
    float g = arm * 0.9 + exp(-d * d * 18.0) * 0.8;
    o = vec4(mix(vec3(0.85, 0.95, 1.0), tint, 0.4) * g * 1.3, 0.0);
  }
  o *= vA * uK;
  if (o.a + dot(o.rgb, vec3(1.0)) < 0.002) discard;
  gl_FragColor = o;
  ${OUT}
}`;

// ---------------------------------------------------------------- кольцо волны и столп призыва (цилиндр)
const FX_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FX_FRAG = /* glsl */`
uniform float uMode, uK, uTime;
uniform vec3 uCol, uCol2;
varying vec2 vUv;
${NOISE}
void main(){
  float u = vUv.x, v = vUv.y;
  vec3 c;
  if (uMode < 0.5) {
    // кольцо волны: яркий низ, к верху гаснет; по кругу — рунные засечки
    float band = pow(1.0 - v, 3.0);
    float ci = floor(u * 64.0); float cf = fract(u * 64.0);
    float cells = step(0.4, h11(ci + 1.0)) * smoothstep(0.0, 0.2, cf) * smoothstep(1.0, 0.8, cf) * smoothstep(0.75, 0.2, v);
    c = uCol * band * (0.55 + 0.9 * cells) + uCol2 * pow(1.0 - v, 14.0) * 1.4;
  } else {
    // столп призыва: спиральные ленты и бегущие вверх руны, у основания — яркое кольцо
    float top = pow(1.0 - v, 1.5);
    float base = pow(1.0 - v, 9.0);
    float spiral = pow(0.5 + 0.5 * sin(u * 6.2831853 * 3.0 + v * 9.0 - uTime * 2.6), 6.0);
    vec2 g = vec2(u * 30.0, v * 10.0 - uTime * 0.9); vec2 gi = floor(g), gf = fract(g);
    float hs = h21(gi);
    float glyph = step(0.62, hs) * smoothstep(0.16, 0.06, abs(gf.x - 0.5 - 0.2 * (fract(hs * 7.0) - 0.5) * (gf.y - 0.5))) * step(0.15, gf.y) * step(gf.y, 0.85);
    glyph += step(0.8, hs) * smoothstep(0.1, 0.03, abs(gf.y - 0.5)) * step(0.25, gf.x) * step(gf.x, 0.75);
    c = uCol * (top * 0.28 + spiral * top * 0.6 + glyph * top * 0.9) + mix(uCol, uCol2, 0.6) * base * 1.6;
  }
  gl_FragColor = vec4(c * uK, 0.0);
  ${OUT}
}`;

export function createMenuStage({ THREE, scene, quality = 'medium', reducedMotion = false, prebuild = false } = {}) {
  const root = new THREE.Group();
  root.name = 'menu-stage';
  root.visible = false;
  scene.add(root);
  const S = {
    q: TIER[quality] ? quality : 'medium', reduced: !!reducedMotion, built: false, hiddenFor: 0, t: 0, frame: 0,
    wave: -1, elem: '', fade: 1, swap: 0, pend: null, summon: 0,
    col: new THREE.Color(0xff7a2a), col2: new THREE.Color(0xffd08a), colT: new THREE.Color(0xff7a2a), col2T: new THREE.Color(0xffd08a),
  };
  // общие юниформы (одни объекты на все материалы — значения ставит update)
  const U = {
    uTime: { value: 0 }, uOct: { value: TIER[S.q].oct }, uK: { value: 1 },
    uCol: { value: S.col }, uCol2: { value: S.col2 },
    uCam: { value: new THREE.Vector3() }, uKey: { value: new THREE.Vector3(2, 2.7, 2) },
    uKeyC: { value: new THREE.Color(1.0, 0.8, 0.62) }, uAmbC: { value: new THREE.Color(0.26, 0.32, 0.44) },
    uFogC: { value: new THREE.Color(0.05, 0.06, 0.08) }, uFogD: { value: 0.012 },
    uPortal: { value: new THREE.Vector3() }, uPortalN: { value: new THREE.Vector3(0, 0, 1) },
    uPortalI: { value: 2.2 }, uKeyI: { value: 2.0 }, uPortalR: { value: PORTAL.rMid },
    uPortalM: { value: new THREE.Matrix4() }, uPortalInv: { value: new THREE.Matrix4() },
  };
  // задник (камень и портал) доворачивается вокруг героя за облётом камеры; пол, дымка и частицы — на месте
  const back = new THREE.Group();
  back.name = 'menu-stage-back';
  root.add(back);
  const portalG = new THREE.Group();
  portalG.name = 'menu-stage-portal';
  back.add(portalG);
  // юниформы камня — в осях задника (U.uPortal/uPortalN — в осях сцены, для пола и дымки)
  const SU = { uCam: { value: new THREE.Vector3() }, uKey: { value: new THREE.Vector3() }, uPortal: { value: new THREE.Vector3() }, uPortalN: { value: new THREE.Vector3(0, 0, 1) } };
  let stone = null, vortex = null, halo = null, floor = null, mist = null, parts = null, waveFx = null, column = null;
  const owned = [];   // { geometry, material } — освобождаются вместе
  const own = (o) => { owned.push(o); return o; };

  // ---------------------------------------------------------------- геометрия (один раз за вход в меню)
  function jitterGeo(g, amp, seed) {
    // неровный, «колотый» камень: вершины с одинаковой позицией смещаются одинаково (без щелей), грани плоские
    const ng = g.index ? g.toNonIndexed() : g;
    if (ng !== g) g.dispose();
    const p = ng.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const h = (k) => { const s = Math.sin(Math.round(x * 97) * 12.9898 + Math.round(y * 97) * 78.233 + Math.round(z * 97) * 37.719 + seed * 4.13 + k * 19.19) * 43758.5453; return s - Math.floor(s) - 0.5; };
      p.setXYZ(i, x + h(1) * amp, y + h(2) * amp, z + h(3) * amp);
    }
    ng.computeVertexNormals();
    return ng;
  }
  function buildStone(rand) {
    const P = [], N = [], K = [];
    const m4 = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3(), n = new THREE.Vector3();
    const put = (g, m, kind, sd, sp) => {
      const pos = g.attributes.position, nor = g.attributes.normal;
      nm.getNormalMatrix(m);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m); P.push(v.x, v.y, v.z);
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); N.push(n.x, n.y, n.z);
        K.push(kind, sd, sp);
      }
      g.dispose();
    };
    const pm = portalMatrix(new THREE.Matrix4());
    // кольцо портала: клинья-блоки (воссуары), замковый камень сверху; два блока справа сверху выпали
    const NB = 22, dA = TAU / NB;
    for (let i = 0; i < NB; i++) {
      const a0 = Math.PI / 2 + i * dA;
      if (i === 19 || i === 20) continue;
      const key = i === 0;
      const th = PORTAL.thick * (key ? 1.35 : 1) * (0.94 + rand() * 0.12), dp = PORTAL.depth * (key ? 1.15 : 1);
      const g = new THREE.BoxGeometry(1, 1, 1, 3, 1, 1);
      const p = g.attributes.position;
      const gap = 0.035;
      const rOff = (rand() - 0.5) * 0.05 + (key ? 0.05 : 0);
      for (let j = 0; j < p.count; j++) {
        const ta = p.getX(j), tr = p.getY(j), tz = p.getZ(j);
        const ang = a0 + ta * (dA - gap / PORTAL.rMid);
        const rr = PORTAL.rMid + rOff + tr * th;
        p.setXYZ(j, Math.cos(ang) * rr, Math.sin(ang) * rr, tz * dp + (rand() - 0.5) * 0.0);
      }
      const jg = jitterGeo(g, 0.028, i);
      m4.makeRotationZ((rand() - 0.5) * 0.02).premultiply(pm);
      put(jg, m4, 1, rand(), 0);
    }
    // опоры кольца и ступени-помост
    for (const sx of [-1, 1]) {
      const g = jitterGeo(new THREE.BoxGeometry(1.05, 1.9, 1.25, 2, 2, 2), 0.05, 7 + sx);
      m4.makeTranslation(sx * 2.45, -PORTAL.rMid + 0.9, 0).premultiply(pm);   // стоят на помосте, держат низ кольца
      put(g, m4, 0, rand(), 0);
    }
    // помост: две ступени-полукруга к герою (+Z оси портала); нижняя уходит на 2,6 м вниз — у края арены и в лесу
    // земля за героем ниже его ног, помост «вырастает» из неё, а не висит
    for (let k = 0; k < 2; k++) {
      const r = 3.7 - k * 0.55, top = 0.19 * (k + 1), h = k ? 0.19 : 2.8;
      const g = jitterGeo(new THREE.CylinderGeometry(r, r + (k ? 0.04 : 0.3), h, 40, k ? 1 : 3, false, -Math.PI * 0.6, Math.PI * 1.2), 0.03, 11 + k);
      m4.makeTranslation(PORTAL.x, top - h / 2, PORTAL.z).multiply(new THREE.Matrix4().makeRotationY(portalYaw()));
      put(g, m4, 0, rand(), 0);
    }
    // две разбитые колонны по бокам помоста (руины своими силами — у края арены их дополняют колонны мира)
    const cols = [[-3.75, 0.55, 2.5, 0.04], [3.85, 0.35, 1.45, -0.05]];
    for (let c = 0; c < cols.length; c++) {
      const [lx, lz, h, lean] = cols[c];
      const g = new THREE.CylinderGeometry(0.38, 0.45, h, 12, Math.max(2, Math.round(h * 1.4)), false);
      const p = g.attributes.position;
      for (let j = 0; j < p.count; j++) {
        const px = p.getX(j), py = p.getY(j), pz = p.getZ(j);
        const a = Math.atan2(pz, px);
        const flute = 1 - 0.06 * Math.max(0, Math.cos(a * 12));
        let yy = py;
        if (py > h / 2 - 1e-3) yy += (Math.sin(a * 3 + c * 2.1) * 0.5 + 0.5) * 0.5 - 0.22;   // сломанный верх
        p.setXYZ(j, px * flute, yy, pz * flute);
      }
      const jg = jitterGeo(g, 0.03, 20 + c);
      // в осях портала: x — вдоль кольца, z — к герою; низ — на верхней ступени
      m4.makeTranslation(lx, -PORTAL.rMid + h / 2, lz).premultiply(pm).multiply(new THREE.Matrix4().makeRotationZ(lean)).multiply(new THREE.Matrix4().makeRotationY(rand() * TAU));
      put(jg, m4, 0, rand(), 0);
      const b = jitterGeo(new THREE.BoxGeometry(1.1, 0.3, 1.1), 0.03, 40 + c);
      m4.makeTranslation(lx, -PORTAL.rMid + 0.15, lz).premultiply(pm).multiply(new THREE.Matrix4().makeRotationY(rand()));
      put(b, m4, 0, rand(), 0);
    }
    // выпавшие блоки кольца лежат на ступенях справа
    for (let r = 0; r < 2; r++) {
      const g = jitterGeo(new THREE.BoxGeometry(0.85, 0.5, 0.75), 0.04, 50 + r);
      m4.makeTranslation(1.9 + r * 0.9, -PORTAL.rMid + 0.24 - r * 0.19, 1.2 + r * 0.7).premultiply(pm).multiply(new THREE.Matrix4().makeRotationY(0.5 + r)).multiply(new THREE.Matrix4().makeRotationZ(0.2 - r * 0.35));
      put(g, m4, 0, rand(), 0);
    }
    // обломки у подножия помоста (перед ним, к герою)
    for (let r = 0; r < 6; r++) {
      const s = 0.14 + rand() * 0.24;
      const g = jitterGeo(new THREE.BoxGeometry(s * 1.6, s, s * 1.2), s * 0.18, 70 + r);
      const ang = (rand() - 0.5) * 2.4, rad = 3.9 + rand() * 0.9;
      m4.makeTranslation(Math.sin(ang) * rad, -PORTAL.rMid - PORTAL.lift + s * 0.35, Math.cos(ang) * rad).premultiply(pm).multiply(new THREE.Matrix4().makeRotationY(rand() * TAU));
      put(g, m4, 0, rand(), 0);
    }
    const base = P.length / 3;
    // парящие обломки вокруг кольца (в конце: обрезка по уровню — drawRange)
    let rockVerts = 0;
    for (let r = 0; r < MAX_ROCKS; r++) {
      const s = 0.09 + rand() * 0.24;
      const g = jitterGeo(new THREE.IcosahedronGeometry(s, 0), s * 0.22, 90 + r);
      const ang = (r / MAX_ROCKS) * TAU + rand() * 0.25, rad = PORTAL.rMid + 0.7 + rand() * 1.2;
      m4.makeTranslation(Math.cos(ang) * rad, Math.sin(ang) * rad, (rand() - 0.5) * 1.2).premultiply(pm);
      rockVerts = g.attributes.position.count;
      put(g, m4, 2, rand(), rand());
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('aK', new THREE.Float32BufferAttribute(K, 3));
    geo.userData.base = base; geo.userData.rockVerts = rockVerts;
    return geo;
  }
  function portalYaw() { return Math.atan2(0.5 - PORTAL.x, 2.75 - PORTAL.z); }   // лицом к средней точке облёта камеры
  function portalMatrix(m) {
    return m.makeRotationY(portalYaw()).setPosition(PORTAL.x, PORTAL.lift + PORTAL.rMid, PORTAL.z);
  }

  function mat(vert, frag, extra = {}, opts = {}) {
    const m = new THREE.ShaderMaterial({ uniforms: { ...U, ...extra }, vertexShader: vert, fragmentShader: frag, fog: false, ...opts });
    return m;
  }
  const premul = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation };
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

  // ---------------------------------------------------------------- отражение пола (medium/high)
  const M = { rt: null, w: 0, h: 0, frame: -1, cam: null, on: false, dummy: null, lightsAt: -1e9, renderer: null };
  const mv = {
    texM: new THREE.Matrix4(), bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1),
    rp: new THREE.Vector3(), cp: new THREE.Vector3(), nrm: new THREE.Vector3(), rot: new THREE.Matrix4(), view: new THREE.Vector3(),
    look: new THREE.Vector3(), tgt: new THREE.Vector3(), plane: new THREE.Plane(), clip: new THREE.Vector4(), q: new THREE.Vector4(),
    clear: new THREE.Color(), size: new THREE.Vector2(),
  };
  function syncLights() {
    // камера отражения видит только слой REFLECT_LAYER — источники сцены включаем в него, иначе материалы героя
    // в отражении собрались бы с другим числом источников (лишняя перекомпиляция)
    scene.traverse(lightToLayer);
  }
  function lightToLayer(o) { if (o.isLight) o.layers.enable(REFLECT_LAYER); }
  function ensureMirror(renderer) {
    const want = TIER[S.q].mirror;
    if (!want) { freeMirror(); return false; }
    renderer.getDrawingBufferSize(mv.size);
    const w = want, h = Math.max(64, Math.round(want * mv.size.y / Math.max(1, mv.size.x)));
    if (M.rt && (M.w !== w || Math.abs(M.h - h) > 8)) freeMirror();
    if (!M.rt) {
      const half = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');
      M.rt = new THREE.WebGLRenderTarget(w, h, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, samples: 0 });
      M.rt.texture.generateMipmaps = false;
      M.w = w; M.h = h;
      if (!M.cam) { M.cam = new THREE.PerspectiveCamera(); M.cam.layers.set(REFLECT_LAYER); }
      floor.material.uniforms.uMirror.value = M.rt.texture;
      floor.material.uniforms.uTexel.value.set(1 / w, 1 / h);
      syncLights(); M.lightsAt = S.t;
    }
    return true;
  }
  function freeMirror() {
    if (M.rt) { M.rt.dispose(); M.rt = null; }
    if (floor) { floor.material.uniforms.uMirror.value = M.dummy; floor.material.uniforms.uMirrorK.value = 0; }
  }
  function renderMirror(renderer, sc, camera) {
    // как three/addons Reflector: камера зеркально под полом, косая ближняя плоскость срезает всё ниже пола
    if (!M.on || M.frame === S.frame || sc.overrideMaterial || !camera.isPerspectiveCamera) return;
    if (!ensureMirror(renderer)) return;
    M.frame = S.frame;
    if (S.t - M.lightsAt > 2) { syncLights(); M.lightsAt = S.t; }
    const cam = M.cam;
    mv.rp.setFromMatrixPosition(floor.matrixWorld);
    mv.cp.setFromMatrixPosition(camera.matrixWorld);
    mv.rot.extractRotation(floor.matrixWorld);
    mv.nrm.set(0, 1, 0).applyMatrix4(mv.rot);
    mv.view.subVectors(mv.rp, mv.cp);
    if (mv.view.dot(mv.nrm) > 0) return;
    mv.view.reflect(mv.nrm).negate().add(mv.rp);
    mv.rot.extractRotation(camera.matrixWorld);
    mv.look.set(0, 0, -1).applyMatrix4(mv.rot).add(mv.cp);
    mv.tgt.subVectors(mv.rp, mv.look).reflect(mv.nrm).negate().add(mv.rp);
    cam.position.copy(mv.view);
    cam.up.set(0, 1, 0).applyMatrix4(mv.rot).reflect(mv.nrm);
    cam.lookAt(mv.tgt);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    mv.texM.copy(mv.bias).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse).multiply(floor.matrixWorld);
    floor.material.uniforms.uTexM.value.copy(mv.texM);
    mv.plane.setFromNormalAndCoplanarPoint(mv.nrm, mv.rp).applyMatrix4(cam.matrixWorldInverse);
    mv.clip.set(mv.plane.normal.x, mv.plane.normal.y, mv.plane.normal.z, mv.plane.constant);
    const e = cam.projectionMatrix.elements;
    mv.q.set((Math.sign(mv.clip.x) + e[8]) / e[0], (Math.sign(mv.clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    mv.clip.multiplyScalar(2 / mv.clip.dot(mv.q));
    e[2] = mv.clip.x; e[6] = mv.clip.y; e[10] = mv.clip.z + 1 - 0.003; e[14] = mv.clip.w;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    const prevRT = renderer.getRenderTarget(), prevXr = renderer.xr.enabled, prevSh = renderer.shadowMap.autoUpdate;
    const prevBg = sc.background, prevA = renderer.getClearAlpha();
    renderer.getClearColor(mv.clear);
    floor.visible = false;
    try {
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      sc.background = null;
      renderer.setRenderTarget(M.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear(true, true, false);
      renderer.render(sc, cam);
    } finally {
      sc.background = prevBg;
      renderer.setClearColor(mv.clear, prevA);
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevSh;
      renderer.setRenderTarget(prevRT);
      floor.visible = true;
    }
    floor.material.uniforms.uMirrorK.value = 1;
  }

  // ---------------------------------------------------------------- сборка
  function build() {
    if (S.built) return;
    S.built = true;
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    portalMatrix(U.uPortalM.value);
    U.uPortalInv.value.copy(U.uPortalM.value).invert();
    SU.uPortal.value.setFromMatrixPosition(U.uPortalM.value);
    SU.uPortalN.value.set(0, 0, 1).transformDirection(U.uPortalM.value);
    U.uPortal.value.copy(SU.uPortal.value); U.uPortalN.value.copy(SU.uPortalN.value);
    // камень
    const sg = buildStone(rand);
    stone = new THREE.Mesh(sg, mat(STONE_VERT, STONE_FRAG, { uRune: { value: 1 }, ...SU }));
    stone.name = 'menu-stage-stone';
    stone.frustumCulled = false;
    own(stone);
    // вихрь и ореол — в осях портала
    const rIn = PORTAL.rMid - PORTAL.thick * 0.5 + 0.04;
    vortex = new THREE.Mesh(new THREE.CircleGeometry(rIn, 72), mat(VORTEX_VERT, VORTEX_FRAG, { uR: { value: rIn } }, premul));
    vortex.name = 'menu-stage-vortex';
    vortex.position.z = -0.05;
    vortex.renderOrder = -2;
    own(vortex);
    const rOut = PORTAL.rMid + PORTAL.thick * 0.5;
    halo = new THREE.Mesh(new THREE.PlaneGeometry(rOut * 4.2, rOut * 4.2), mat(VORTEX_VERT, HALO_FRAG, { uR: { value: rOut } }, additive));
    halo.name = 'menu-stage-halo';
    halo.position.z = -0.6;
    halo.renderOrder = -3;
    own(halo);
    portalMatrix(portalG.matrix);
    portalG.matrix.decompose(portalG.position, portalG.quaternion, portalG.scale);
    portalG.add(vortex, halo);
    // пол
    const fg = new THREE.CircleGeometry(FLOOR_R, 96);
    fg.rotateX(-Math.PI / 2);
    M.dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    M.dummy.needsUpdate = true;
    floor = new THREE.Mesh(fg, mat(FLOOR_VERT, FLOOR_FRAG, {
      uMirror: { value: M.dummy }, uMirrorK: { value: 0 }, uTaps: { value: TIER[S.q].taps }, uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uTexM: { value: new THREE.Matrix4() }, uWave: { value: -1 }, uWaveR: { value: 7.5 }, uR: { value: FLOOR_R }, uSummon: { value: 0 },
    }, { ...premul, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    floor.name = 'menu-stage-floor';
    floor.position.y = 0.012;
    floor.renderOrder = -1;
    floor.onBeforeRender = (renderer, sc, camera) => { M.renderer = renderer; try { renderMirror(renderer, sc, camera); } catch (e) { M.on = false; freeMirror(); console.warn('[W4-ВИТРИНА] отражение отключено', e && e.message); } };
    own(floor);
    // дымка: слои над полом (обрезка по уровню — drawRange)
    {
      const P = [], L = [];
      for (let l = 0; l < MAX_MIST; l++) {
        const g = new THREE.PlaneGeometry(15, 15, 1, 1).toNonIndexed();
        g.rotateX(-Math.PI / 2);
        g.translate(-0.8, 0.06 + l * 0.2, -3.6);
        const p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); L.push(l); }
        g.dispose();
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      mg.setAttribute('aL', new THREE.Float32BufferAttribute(L, 1));
      mist = new THREE.Mesh(mg, mat(MIST_VERT, MIST_FRAG, {}, additive));
      mist.name = 'menu-stage-mist';
      mist.renderOrder = 1;
      mist.frustumCulled = false;
      own(mist);
    }
    // частицы
    {
      const A = new Float32Array(MAX_PARTS * 4);
      for (let i = 0; i < A.length; i++) A[i] = rand();
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAX_PARTS * 3), 3));
      pg.setAttribute('aS', new THREE.Float32BufferAttribute(A, 4));
      parts = new THREE.Points(pg, mat(PART_VERT, PART_FRAG, {
        uK: { value: 1 }, uPx: { value: 600 }, uKindA: { value: 0 }, uKindB: { value: 1 }, uMixB: { value: 0.4 }, uSummon: { value: 0 },
        uBox: { value: new THREE.Vector3(7.5, 3.3, 6.8) }, uBoxC: { value: new THREE.Vector3(-1.0, 3.2, -3.6) }, uSummonC: { value: new THREE.Vector3(0, 0.05, 0) },
      }, premul));
      parts.name = 'menu-stage-particles';
      parts.renderOrder = 4;
      parts.frustumCulled = false;
      parts.onBeforeRender = (renderer, sc, camera) => {
        // размер точки в пикселях: высота буфера / (2·tg(fov/2))
        renderer.getDrawingBufferSize(mv.size);
        const f = camera.isPerspectiveCamera ? Math.tan((camera.fov * Math.PI) / 360) : 1;
        parts.material.uniforms.uPx.value = mv.size.y / (2 * f);
      };
      own(parts);
    }
    // кольцо волны и столп призыва
    const cg = new THREE.CylinderGeometry(1, 1, 1, 72, 1, true);
    cg.translate(0, 0.5, 0);
    waveFx = new THREE.Mesh(cg, mat(FX_VERT, FX_FRAG, { uMode: { value: 0 }, uK: { value: 0 } }, { ...additive, side: THREE.DoubleSide }));
    waveFx.name = 'menu-stage-wave';
    waveFx.renderOrder = 2;
    waveFx.visible = false;
    own(waveFx);
    column = new THREE.Mesh(cg, mat(FX_VERT, FX_FRAG, { uMode: { value: 1 }, uK: { value: 0 } }, { ...additive, side: THREE.DoubleSide }));
    column.name = 'menu-stage-summon';
    column.renderOrder = 2;
    column.visible = false;
    column.scale.set(0.95, 4.2, 0.95);
    own(column);
    back.add(stone);
    root.add(floor, mist, parts, waveFx, column);
    // отражаются герой и портал (камень, вихрь, ореол)
    for (const o of [stone, vortex, halo]) o.layers.enable(REFLECT_LAYER);
    applyTier();
    if (S.reflectRoot) setReflect(S.reflectRoot);
  }

  function release() {
    if (!S.built) return;
    S.built = false;
    freeMirror();
    for (const o of owned) {
      if (o.parent) o.parent.remove(o);
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    // общая геометрия цилиндра у волны и столпа: dispose повторно безопасен
    owned.length = 0;
    if (M.dummy) { M.dummy.dispose(); M.dummy = null; }
    stone = vortex = halo = floor = mist = parts = waveFx = column = null;
  }

  function applyTier() {
    const T = TIER[S.q];
    U.uOct.value = T.oct;
    if (!S.built) return;
    parts.geometry.setDrawRange(0, T.parts);
    mist.geometry.setDrawRange(0, T.mist * 6);
    const g = stone.geometry;
    g.setDrawRange(0, g.userData.base + T.rocks * g.userData.rockVerts);
    floor.material.uniforms.uTaps.value = T.taps;
    M.on = T.mirror > 0;
    if (!M.on) freeMirror();
  }
  function setQuality(q) {
    const n = TIER[q] ? q : 'medium';
    if (n === S.q) return;
    S.q = n;
    applyTier();
  }
  function setReducedMotion(b) { S.reduced = !!b; }

  // отражение: включить слой у героя (после загрузки модели — снова: меши новые)
  function setReflect(heroRoot) {
    S.reflectRoot = heroRoot || null;
    if (!heroRoot) return;
    heroRoot.traverse(heroToLayer);
  }
  function heroToLayer(o) { if (o.isMesh || o.isPoints || o.isSkinnedMesh) o.layers.enable(REFLECT_LAYER); }

  function wave() { S.wave = 0; }

  function setElement(fx, element) {
    const key = element || (fx && fx.style) || '';
    if (fx) { S.colT.set(fx.color); S.col2T.set(fx.color2 || fx.color); }
    if (key === S.elem && S.pend === null) return;
    if (key === S.pend) return;
    if (key === S.elem) { S.pend = null; S.swap = 0; return; }   // вернулись к прежней стихии до конца смены
    if (!S.elem) { S.elem = key; applyParts(key); S.col.copy(S.colT); S.col2.copy(S.col2T); return; }
    S.pend = key; S.swap = 1;   // старые частицы гаснут, затем — новые
  }
  function applyParts(key) {
    if (!parts) return;
    const p = PARTS[key] || PARTS_BY_STYLE[key] || PARTS_BY_STYLE.ember;
    const u = parts.material.uniforms;
    u.uKindA.value = p[0]; u.uKindB.value = p[1]; u.uMixB.value = p[2];
  }

  const _cam = new THREE.Vector3(), _key = new THREE.Vector3();
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function update(dt, view) {
    const w = view && view.w > 0 ? view.w : 0;
    if (w <= 0.01) {
      if (root.visible) root.visible = false;
      if (S.built) { S.hiddenFor += dt; if (S.hiddenFor > 2) release(); }
      return false;
    }
    S.hiddenFor = 0;
    if (!S.built) {
      build();
      // программы сцены — в потоках драйвера, пока сцена скрыта (KHR_parallel_shader_compile); без рывка кадра
      const r = M.renderer;
      if (r && typeof r.compileAsync === 'function' && view.camera) {
        S.compiling = nowMs();
        r.compileAsync(root, view.camera, scene).then(() => { S.compiling = 0; }, () => { S.compiling = 0; });
      }
    }
    if (S.compiling && nowMs() - S.compiling < 3000) { root.visible = false; return false; }
    S.compiling = 0;
    root.visible = true;
    S.frame++;
    S.t += dt * (S.reduced ? 0.35 : 1);
    U.uTime.value = S.t;
    // в осях героя: вперёд героя — +Z сцены
    if (view.heroPos) root.position.copy(view.heroPos);
    root.rotation.y = view.heroYaw || 0;
    root.updateMatrixWorld();
    if (view.fx || view.element) setElement(view.fx, view.element);
    // смена стихии: гаснут → новые частицы, цвет портала плавно
    if (S.swap > 0) {
      S.swap = Math.max(0, S.swap - dt / 0.45);
      S.fade = S.swap;
      if (S.swap === 0 && S.pend !== null) { S.elem = S.pend; applyParts(S.pend); S.pend = null; S.fade = 0; }
    } else S.fade = Math.min(1, S.fade + dt / 0.8);
    const kc = 1 - Math.exp(-2.4 * dt);
    S.col.lerp(S.colT, kc); S.col2.lerp(S.col2T, kc);
    U.uK.value = w;
    parts.material.uniforms.uK.value = w * S.fade;
    // камера и ключ — в оси сцены
    // задник за облётом: портал в осях сцены — для пола (отражение) и дымки
    back.rotation.y = Number.isFinite(view.orbit) ? view.orbit : 0;
    back.updateMatrixWorld();
    U.uPortal.value.copy(SU.uPortal.value).applyMatrix4(back.matrix);
    U.uPortalN.value.copy(SU.uPortalN.value).transformDirection(back.matrix);
    if (view.camera) {
      _cam.copy(view.camera.position); root.worldToLocal(_cam); U.uCam.value.copy(_cam);
      _cam.copy(view.camera.position); back.worldToLocal(_cam); SU.uCam.value.copy(_cam);
    }
    if (view.key) {
      _key.copy(view.key); root.worldToLocal(_key); U.uKey.value.copy(_key);
      _key.copy(view.key); back.worldToLocal(_key); SU.uKey.value.copy(_key);
    }
    const ap = view.appear || 0;
    U.uPortalI.value = (1.15 + 0.12 * Math.sin(S.t * 0.9)) * (1 + 0.6 * ap * ap);
    U.uKeyI.value = 1.8;
    if (view.fogColor) U.uFogC.value.copy(view.fogColor);
    // руническая волна (1,4 с) и кольцо света
    if (S.wave >= 0) {
      S.wave += dt / 1.4;
      if (S.wave >= 1) S.wave = -1;
    }
    floor.material.uniforms.uWave.value = S.wave;
    if (S.wave >= 0) {
      const e = 1 - Math.pow(1 - S.wave, 2.2);
      waveFx.visible = true;
      waveFx.scale.set(0.35 + e * 6.8, 0.25 + 0.55 * (1 - S.wave), 0.35 + e * 6.8);
      waveFx.material.uniforms.uK.value = (1 - S.wave) * (1 - S.wave) * 1.6 * w;
    } else if (waveFx.visible) waveFx.visible = false;
    // призыв, пока грузится модель: столп и спираль частиц
    const want = view.loading > 0 ? 1 : 0;
    S.summon += (want - S.summon) * (1 - Math.exp(-(want ? 3 : 5) * dt));
    if (S.summon < 0.003) S.summon = 0;
    column.visible = S.summon > 0.01;
    column.material.uniforms.uK.value = S.summon * w * (0.85 + 0.15 * Math.sin(S.t * 5));
    parts.material.uniforms.uSummon.value = S.summon;
    floor.material.uniforms.uSummon.value = S.summon;
    if (!M.on) floor.material.uniforms.uMirrorK.value = 0;
    return true;
  }

  function info() {
    const T = TIER[S.q];
    return {
      built: S.built, visible: root.visible, quality: S.q, element: S.elem, wave: +S.wave.toFixed(2), summon: +S.summon.toFixed(2),
      particles: T.parts, rocks: T.rocks, mist: T.mist, mirror: M.rt ? [M.w, M.h] : null, lights: 0,
      meshes: S.built ? owned.filter((o) => o.visible !== false && !!o.parent).length : 0,
    };
  }

  // центр портала в мировых осях (контровой свет героя — с его стороны)
  function portalWorld(out) {
    out.set(PORTAL.x, PORTAL.lift + PORTAL.rMid, PORTAL.z);
    return back.localToWorld(out);
  }

  if (prebuild) { try { build(); } catch (e) { console.warn('[W4-ВИТРИНА] сцена витрины не собралась', e); release(); } }

  function dispose() {
    release();
    if (M.cam) M.cam = null;
    M.renderer = null;
    if (root.parent) root.parent.remove(root);
  }

  return { group: root, update, setQuality, setReducedMotion, setReflect, wave, portalWorld, info, dispose, get quality() { return S.q; } };
}
