// ASHEN OATH — [HERO] аура класса вокруг героя: частицы стихии, вся анимация — в вершинном шейдере
// (один вызов отрисовки, ноль работы CPU на частицу). Стили:
//   'ember' — угли поднимаются от земли вдоль тела и гаснут наверху (Пепельный страж);
//   'frost' — ледяные кристаллы кружат по двум наклонным орбитам (Тёмная чародейка);
//   'wind'  — светлячки/искры ветра дрейфуют вокруг по спирали (лучницы);
//   'storm' — короткие вспышки-искры вокруг рук и плеч (Архимаг).
// Точки — в осях модели героя (child модели), размер — с перспективой. quality: low — 40% частиц.
//
// [W4-АУРА] «Герой выделяется из фона и ощущается сильным»:
//   • контровой свет стихии — кромка силуэта в шейдере материалов героя (не источник света: 0 вызовов,
//     0 проходов); свои юниформы на каждого героя, патч переживает смену качества и режима шейдинга;
//   • руна-круг у ног (1 вызов, узор процедурный — без текстур): кольцо «Ярости клятвы» заполняется
//     от snapshot.player.fury, при заполнении — вспышка, волна по земле и импульс postfx;
//   • заряд в руках (сомкнутые ладони sigilCharge, кулак burstCharge, сфера/лук/заклинание рукой):
//     кисти светятся изнутри (тот же шейдер), часть искр ауры стягивается спиралью к ладоням;
//   • состояние: оберег/бастион/щит — золотой ободок, мало HP — красный пульс сердцебиения;
//   • medium/high: тонкие волны вокруг тела при накоплении ярости, светящиеся следы шагов на бегу,
//     пыль и искры рывка (modules/heroTrail.js); остаточным образам — свой уровень качества.
//   Бюджет: low — rim в шейдере + руна (упрощённый узор), ≤ 2 вызова вместе с частицами;
//   medium/high — + волны (1, только при ярости/заряде), + следы (1, пока живы), + пыль (1, пока жива).
//
// createHeroAura(THREE, parent, fx, { quality, height }) →
//   { object, update(t), tick(dt, snap, events, cur, anchors, remote), setLod(l), setIntensity(k), setQuality(q),
//     state(), dispose() }
//   parent — модель героя (heroModel: c.model — масштаб и наклон корпуса), её родитель — корень героя;
//   tick — раз в кадр из heroModel.update (снимок боя и события), update(t) — после позы (vrmTick).

import { createFootprints, createDashBurst } from './heroTrail.js';

const VERT = /* glsl */`
uniform float uTime;
uniform float uTF;          // «время ярости»: ∫(1 + 0.65·ярость) dt — скорость растёт без скачка фазы
uniform float uSize;
uniform float uH;
uniform float uStyle;
uniform float uK;
uniform float uFury;
uniform float uFlash;
uniform vec2 uHandW;
uniform vec3 uHandL;
uniform vec3 uHandR;
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
    float life = fract(aSeed.y + uTF * (0.16 + 0.12 * aSeed.z));
    float ang = aSeed.x * TAU + t * 0.5 + life * 2.4;
    float r = 0.28 + 0.26 * aSeed.z + 0.08 * sin(t * 1.3 + aSeed.w * 9.0);
    p = vec3(cos(ang) * r, life * uH * 1.05, sin(ang) * r);
    a = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.65, 1.0, life));
    a *= 0.6 + 0.4 * sin(t * 9.0 + aSeed.w * 30.0);
  } else if (uStyle < 1.5) {               // frost: кристаллы на двух наклонных орбитах
    float orbit = step(0.5, aSeed.w);
    float ang = aSeed.x * TAU + uTF * (0.55 + 0.25 * aSeed.z) * (orbit > 0.5 ? -1.0 : 1.0);
    float r = 0.5 + 0.12 * aSeed.z;
    vec3 q = vec3(cos(ang) * r, 0.0, sin(ang) * r);
    float tilt = orbit > 0.5 ? 0.45 : -0.35;
    q.y = q.x * tilt;
    p = q + vec3(0.0, uH * (0.55 + 0.1 * orbit) + 0.05 * sin(t * 1.7 + aSeed.y * 6.0), 0.0);
    a = 0.65 + 0.35 * sin(t * 4.0 + aSeed.y * 20.0);
  } else if (uStyle < 2.5) {               // wind: дрейф по спирали, мерцание светлячков
    float ang = aSeed.x * TAU + uTF * (0.35 + 0.3 * aSeed.z);
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
    a = (1.0 - smoothstep(0.0, 0.18, ph)) * step(0.35 - 0.3 * uFury, h2);   // с яростью вспышек больше
  }
  // [W4-АУРА] ярость — искры шире и выше, вспышка заполнения толкает их наружу
  p.xz *= 1.0 + 0.16 * uFury + 0.9 * uFlash * (0.4 + aSeed.z);
  p.y *= 1.0 + 0.1 * uFury;
  // [W4-АУРА] заряд в руках: часть искр стягивается спиралью к ладоням (руки — в осях модели)
  float side = step(0.5, fract(aSeed.x * 7.31));
  float gw = mix(uHandW.x, uHandW.y, side) * step(aSeed.w, 0.62);
  if (gw > 0.001) {
    vec3 hc = mix(uHandL, uHandR, side);
    float ph = fract(aSeed.y * 3.7 + t * (0.8 + 0.9 * aSeed.z));
    float rr = 0.34 * (1.0 - ph) * (1.0 - ph) + 0.015;
    float an = aSeed.x * 40.0 + ph * 8.0;
    vec3 q = hc + vec3(cos(an) * rr, (aSeed.z - 0.5) * rr, sin(an) * rr);
    float g = smoothstep(0.0, 0.45, gw);
    p = mix(p, q, g);
    a = mix(a, smoothstep(0.0, 0.2, ph) * (0.45 + 0.8 * ph), g);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // у самой камеры (приближенная витрина) искры гаснут и не раздуваются в пелену на весь кадр
  vA = a * uK * smoothstep(0.45, 1.1, -mv.z);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(56.0, uSize * (1.0 + 0.3 * uFury) * (0.6 + 0.8 * aSeed.z) * (300.0 / max(0.5, -mv.z)) * (0.5 + 0.5 * a));
}`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uColor2;
uniform vec3 uLowC;
uniform float uLow;
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
  vec3 col = mix(mix(uColor, uColor2, vMix), uLowC, uLow) * (1.0 + 2.5 * pow(core, 8.0));
  float alpha = glow * vA;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- [W4-АУРА] руна-круг у ног
// Плоскость 2×2 в осях корня героя (x — вправо, z — вперёд), масштаб — радиус. Узор в мировых углах
// (uYaw): знаки не крутятся вслед за поворотом героя. RUNE_HQ (medium/high) — пояс знаков (на low — засечки).
const RUNE_VERT = /* glsl */`
varying vec2 vP;
void main() {
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const RUNE_FRAG = /* glsl */`
uniform float uTime;
uniform float uSpin;        // фаза вращения (копится на CPU: скорость от ярости без скачков)
uniform float uK;
uniform float uFury;
uniform float uReady;
uniform float uFlash;
uniform float uCharge;
uniform float uYaw;
uniform float uStateK;
uniform float uLow;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uStateC;
uniform vec3 uLowC;
varying vec2 vP;
#define TAU 6.2831853
#define PI 3.1415927
float band( float x, float c, float w, float aa ) { return 1.0 - smoothstep( w, w + aa, abs( x - c ) ); }
float tri( vec2 p, float r ) { return max( max( p.y, dot( p, vec2( 0.8660254, -0.5 ) ) ), dot( p, vec2( -0.8660254, -0.5 ) ) ) - r; }
#ifdef RUNE_HQ
float hash1( float n ) { return fract( sin( n * 127.1 + 3.7 ) * 43758.5453 ); }
float seg( vec2 p, vec2 a, vec2 b ) { vec2 pa = p - a, ba = b - a; float h = clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ); return length( pa - ba * h ); }
#endif
void main() {
  vec2 p = vP;
  float r = length( p );
  if ( r > 1.0 ) discard;
  float aa = fwidth( r ) * 1.5 + 1e-4;              // пиксель в единицах радиуса (сглаживание линий)
  float aw = aa / max( r, 0.05 );                     // и в радианах — без шва atan
  float a = atan( p.y, p.x + 1e-5 ) - uYaw;           // мировой угол (+ε: atan(0, 0) в центре не определён)
  float t = uTime;
  float spin = uSpin;
  float I = 0.0, H = 0.0;
  // тонкие кольца: внешний ободок, внутренний к поясу знаков, круг гексаграммы и малое
  I += band( r, 0.97, 0.005, aa ) * 0.5 + band( r, 0.895, 0.0035, aa ) * 0.32;
  I += band( r, 0.62, 0.005, aa ) * 0.42 + band( r, 0.22, 0.004, aa ) * 0.3;
  // гексаграмма: два треугольника, крутятся навстречу поясу; заряд разжигает её
  {
    float sa = - spin * 1.6 - uYaw, ca = cos( sa ), sn = sin( sa );
    vec2 pr = vec2( ca * p.x - sn * p.y, sn * p.x + ca * p.y );
    float hx = ( 1.0 - smoothstep( 0.0035, 0.0035 + aa, min( abs( tri( pr, 0.28 ) ), abs( tri( - pr, 0.28 ) ) ) ) ) * step( r, 0.6 );
    I += hx * 0.3; H += hx * uCharge * 0.55;
  }
#ifdef RUNE_HQ
  // пояс знаков: 16 ячеек, «рукописный» знак из 2–4 штрихов по хэшу ячейки; разгораются с яростью
  {
    float ga = ( a + spin ) / TAU * 16.0;
    float ci = mod( floor( ga ), 16.0 ), cu = fract( ga ) - 0.5;   // по модулю: на шве atan — тот же знак
    vec2 q = vec2( cu * ( TAU * 0.76 / 16.0 ), r - 0.76 ) / 0.085;
    float h1 = hash1( ci + 1.0 ), h2 = hash1( ci + 17.0 ), h3 = hash1( ci + 31.0 );
    float d = seg( q, vec2( 0.0, -0.72 ), vec2( 0.0, 0.72 ) );
    if ( h1 > 0.3 ) d = min( d, seg( q, vec2( -0.42, 0.72 - h2 * 0.5 ), vec2( 0.42, 0.1 - h2 * 0.6 ) ) );
    if ( h3 > 0.45 ) d = min( d, seg( q, vec2( -0.38, -0.25 + h1 * 0.4 ), vec2( 0.38, -0.25 + h1 * 0.4 ) ) );
    if ( h2 > 0.62 ) d = min( d, abs( length( q - vec2( 0.0, 0.42 - h3 * 0.7 ) ) - 0.2 ) );
    float g = 1.0 - smoothstep( 0.045, 0.045 + aa / 0.085 * 1.5, d );
    g *= step( r, 0.86 ) * step( 0.66, r );
    float lit = 0.3 + 0.7 * smoothstep( h1 * 0.85, h1 * 0.85 + 0.12, uFury );
    I += g * lit * 0.5; H += g * lit * ( 0.08 + 0.35 * uReady );
  }
#else
  // low: вместо знаков — засечки по поясу, медленно идут по кругу
  {
    float tk = ( a + spin * 0.5 ) / TAU * 48.0;
    float tick = 1.0 - smoothstep( 0.06, 0.06 + aw / TAU * 48.0 * 1.5, abs( fract( tk ) - 0.5 ) );
    I += tick * band( r, 0.8, 0.045, aa ) * ( 0.22 + 0.25 * uFury );
  }
#endif
  // кольцо ярости между ободками: заполняется от лица героя назад, к камере, обеими сторонами;
  // горячая «голова» на краю, когда полно — всё кольцо горит светлым цветом
  float af = abs( atan( p.x, p.y + 1e-5 ) );
  float fa = uFury * PI;
  float fill = 1.0 - smoothstep( fa - 0.012, fa + 0.012, af );
  float fr = band( r, 0.933, 0.013, aa );
  I += fr * fill * 0.4;
  H += fr * fill * ( 0.1 + 0.45 * uReady ) + fr * exp( - ( af - fa ) * ( af - fa ) * 81.0 ) * step( 0.01, uFury ) * ( 1.0 - uReady ) * 0.9;
  // мягкий свет кольцом по земле (не диск), рябь при накоплении, сердцевина заряда
  I += smoothstep( 0.15, 0.7, r ) * ( 1.0 - smoothstep( 0.7, 1.0, r ) ) * ( 0.025 + 0.04 * uFury );
  float w = fract( r * 1.6 - t * 0.45 );
  I += smoothstep( 0.0, 0.04, w ) * ( 1.0 - smoothstep( 0.04, 0.16, w ) ) * 0.12 * smoothstep( 0.25, 0.9, uFury ) * ( 1.0 - r );
  H += exp( - r * r * 14.0 ) * uCharge * 0.5;
  // вспышка: волна от центра к ободу, весь круг на миг ярче
  float rfl = 0.22 + ( 1.0 - uFlash ) * 0.78;
  H += band( r, rfl, 0.02, aa * 2.0 ) * uFlash * 1.5;
  I *= 1.0 + 0.9 * uFlash + 0.3 * uReady * ( 0.5 + 0.5 * sin( t * 5.0 ) );
  // золотой ободок оберега/щита — двойное кольцо у круга гексаграммы
  float S = ( band( r, 0.65, 0.006, aa ) + band( r, 0.59, 0.004, aa ) * 0.7 ) * uStateK;
  vec3 c1 = mix( uC1, uLowC, uLow * 0.75 );
  vec3 col = c1 * I + uC2 * H + uStateC * S * 1.2;
  gl_FragColor = vec4( col * uK, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- [W4-АУРА] волны вокруг тела (medium/high)
// Открытый конус вокруг героя: тонкие кольца бегут вверх, вдоль силуэта — струйки; середина прозрачна
// (яркость по краю силуэта), заднюю половину закрывает сам герой (тест глубины).
const WAVE_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying vec2 vXZ;
void main() {
  vY = position.y;
  vXZ = position.xz;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vN = normalMatrix * normal;
  vV = - mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const WAVE_FRAG = /* glsl */`
uniform float uTime;
uniform float uK;
uniform vec3 uC1;
uniform vec3 uC2;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying vec2 vXZ;
void main() {
  float vAng = atan( vXZ.y, vXZ.x );
  float F = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) );
  // у самого силуэта конуса гасим: иначе края читаются стеклянной трубой
  float side = smoothstep( 0.15, 0.55, F ) * ( 1.0 - smoothstep( 0.8, 0.99, F ) );
  float y = vY;
  float ph = fract( y * 1.8 - uTime * 0.5 );
  float ring = smoothstep( 0.0, 0.03, ph ) * ( 1.0 - smoothstep( 0.03, 0.11, ph ) );
  // струйки: короткие светлые штрихи разбросаны по углу и бегут вверх, у каждой своя фаза
  float ga = vAng / 6.2831853 * 22.0;                     // 22 дорожек по кругу, без шва ±π
  float hsh = fract( sin( mod( floor( ga ), 22.0 ) * 91.7 + 1.3 ) * 4375.85 );
  float lane = 1.0 - smoothstep( 0.0, 0.09, abs( fract( ga ) - 0.5 - ( hsh - 0.5 ) * 0.6 ) );
  float run = fract( y * 1.3 - uTime * ( 0.7 + 0.5 * hsh ) + hsh );
  float wisp = lane * smoothstep( 0.0, 0.25, run ) * ( 1.0 - smoothstep( 0.3, 0.42, run ) );
  float env = smoothstep( 0.0, 0.1, y ) * ( 1.0 - smoothstep( 0.45, 1.0, y ) );
  float I = ( ring * ( 0.3 + 0.7 * side ) * 0.85 + wisp * side * 0.45 ) * env * uK;
  if ( I < 0.003 ) discard;
  vec3 col = mix( uC1, uC2, ring * 0.6 ) * ( 1.0 + ring );
  gl_FragColor = vec4( col, clamp( I, 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- [W4-АУРА] контровой rim в материалах героя
const RIM_VDECL = '\nvarying vec3 vHeroAuraW;';
const RIM_VERT = `
  #ifdef USE_INSTANCING
    vHeroAuraW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #else
    vHeroAuraW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif`;
const RIM_FDECL = `
uniform vec3 heroAuraRimC;
uniform float heroAuraRimK;
uniform vec3 heroAuraStateC;
uniform float heroAuraStateK;
uniform vec3 heroAuraHandL;
uniform vec3 heroAuraHandR;
uniform vec2 heroAuraHandK;
uniform vec3 heroAuraHandC;
uniform float heroAuraGround;
uniform float heroAuraUnderK;
varying vec3 vHeroAuraW;`;
const RIM_FRAG = `
  {
    // [W4-АУРА] контровой свет стихии: кромка силуэта, сзади-сверху в осях камеры — ярче плечи, голова, руки
    float hzF = 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) );
    float hzB = saturate( dot( normal, vec3( 0.0, 0.55, -0.83 ) ) * 0.5 + 0.62 );
    totalEmissiveRadiance += heroAuraRimC * ( heroAuraRimK * hzF * hzF * hzF * hzB );
    // состояние: золотой ободок оберега/щита, красный пульс ранения — тоньше и резче
    if ( heroAuraStateK > 0.001 ) { float hzS = hzF * hzF; totalEmissiveRadiance += heroAuraStateC * ( heroAuraStateK * hzS * hzS * hzF ); }
    // заряд в руках: кисти светятся изнутри (мировое расстояние до ладони)
    if ( heroAuraHandK.x + heroAuraHandK.y > 0.001 ) {
      vec3 hzL = vHeroAuraW - heroAuraHandL, hzR = vHeroAuraW - heroAuraHandR;
      float hzH = heroAuraHandK.x * exp( - dot( hzL, hzL ) * 70.0 ) + heroAuraHandK.y * exp( - dot( hzR, hzR ) * 70.0 );
      totalEmissiveRadiance += heroAuraHandC * ( hzH * ( 0.6 + 1.2 * hzF ) );
    }
    // отсвет руны снизу: сапоги и подол ловят свет круга
    if ( heroAuraUnderK > 0.001 ) {
      float hzU = exp( - max( vHeroAuraW.y - heroAuraGround, 0.0 ) * 3.5 );
      totalEmissiveRadiance += heroAuraRimC * diffuseColor.rgb * ( heroAuraUnderK * hzU * ( 0.45 + 0.55 * saturate( 0.5 - 0.5 * normal.y ) ) );
    }
  }`;

const STYLE = { ember: 0, frost: 1, wind: 2, storm: 3 };
const COUNT = { ember: 64, frost: 22, wind: 36, storm: 30 };
// доли частиц: база и максимум при полной ярости; что рисуется на каждом уровне
const QUAL = {
  low: { pts: 0.4, ptsMax: 0.6, hq: false, waves: false, prints: 0, burst: 0 },
  medium: { pts: 1, ptsMax: 1.5, hq: true, waves: true, prints: 12, burst: 72 },   // рывок: старт + след + торможение ≈ 70 частиц
  high: { pts: 1.3, ptsMax: 2, hq: true, waves: true, prints: 18, burst: 96 },
};
const tierOf = (q) => (q === 'low' || q === 'high' ? q : 'medium');
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (fin(v) ? v : d);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// экспоненциальное приближение с разной скоростью вверх и вниз (dt — реальное время кадра)
const approach = (cur, tg, up, dn, dt) => cur + (tg - cur) * (1 - Math.exp(-(tg > cur ? up : dn) * dt));
// сердцебиение: двойной удар раз в ~0.9 с (мало HP)
const heartbeat = (t) => { const ph = (t * 1.15) % 1; return Math.exp(-((ph - 0.08) ** 2) / 0.0016) + 0.6 * Math.exp(-((ph - 0.3) ** 2) / 0.0025); };
const NO_EV = Object.freeze([]);
const GOLD = 0xffc35a, RED = 0xff2a18;
let pulseP = null;   // core/postfx.js (лениво, только в браузере): импульс экрана при заполнении ярости

export function createHeroAura(THREE, parent, fx, { quality = 'medium', height = 1.8 } = {}) {
  if (!fx || !parent) return null;
  const style = STYLE[fx.style] ?? 0;
  let tier = tierOf(quality), Q = QUAL[tier];
  const base = COUNT[fx.style] || 40;
  const nMax = Math.max(6, Math.round(base * 2));
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(nMax * 4);
  let s = 1234 + style * 97;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < nMax * 4; i++) seeds[i] = rnd();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nMax * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), height);
  const nOf = (k) => Math.max(6, Math.round(base * k));
  g.setDrawRange(0, nOf(Q.pts));
  const c1 = new THREE.Color(fx.color || 0xffffff), c2 = new THREE.Color(fx.color2 || fx.color || 0xffffff);
  const lowC = new THREE.Color(RED), goldC = new THREE.Color(GOLD);
  const U = {
    uTime: { value: 0 }, uTF: { value: 0 }, uSize: { value: style === 1 ? 0.2 : style === 3 ? 0.15 : style === 0 ? 0.13 : 0.12 }, uH: { value: height },
    uStyle: { value: style }, uK: { value: 1 }, uFury: { value: 0 }, uFlash: { value: 0 },
    uHandW: { value: new THREE.Vector2() }, uHandL: { value: new THREE.Vector3() }, uHandR: { value: new THREE.Vector3() },
    uColor: { value: c1.clone() }, uColor2: { value: c2.clone() }, uLowC: { value: lowC }, uLow: { value: 0 },
  };
  const m = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const pts = new THREE.Points(g, m);
  pts.name = `hero-aura-${fx.style}`;
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  parent.add(pts);

  // ---------------------------------------------------------------- rim: юниформы этого героя
  const RU = {
    heroAuraRimC: { value: c1.clone() }, heroAuraRimK: { value: 0.75 },
    heroAuraStateC: { value: goldC.clone() }, heroAuraStateK: { value: 0 },
    heroAuraHandL: { value: new THREE.Vector3(0, -100, 0) }, heroAuraHandR: { value: new THREE.Vector3(0, -100, 0) },
    heroAuraHandK: { value: new THREE.Vector2() }, heroAuraHandC: { value: c1.clone().lerp(c2, 0.45).multiplyScalar(1.2) },
    heroAuraGround: { value: 0 }, heroAuraUnderK: { value: 0 },
  };
  const patched = new WeakSet();
  function patchMat(mt) {
    if (!mt || patched.has(mt) || mt.userData.heroAuraRim) return;
    patched.add(mt);
    if (!mt.isMeshStandardMaterial || mt.blending !== THREE.NormalBlending) return;
    if (mt.userData.heroKind === 'iris' || /eye|tear|lash/i.test(mt.name || '')) return;
    mt.userData.heroAuraRim = true;
    const prev = mt.onBeforeCompile, pk = mt.customProgramCacheKey;
    mt.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(mt, sh, r);
      Object.assign(sh.uniforms, RU);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + RIM_VDECL)
        .replace('#include <project_vertex>', '#include <project_vertex>' + RIM_VERT);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + RIM_FDECL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + RIM_FRAG);
    };
    mt.customProgramCacheKey = () => 'heroAuraRim:' + (pk ? pk.call(mt) : '');
    mt.needsUpdate = true;
  }
  // меши модели и снаряжения: материалы меняются (heroShading пересобирает их при смене качества и режима) —
  // сравниваем ссылки каждый кадр (десятки сравнений, без выделений) и патчим новые
  const meshes = [], seen = [];
  parent.traverse((o) => { if (o.isMesh) { meshes.push(o); seen.push(null); } });
  function syncMaterials() {
    for (let i = 0; i < meshes.length; i++) {
      const o = meshes[i], mt = o.material;
      if (mt === seen[i]) continue;
      seen[i] = mt;
      if (Array.isArray(mt)) { for (let j = 0; j < mt.length; j++) patchMat(mt[j]); } else patchMat(mt);
    }
  }
  syncMaterials();

  // ---------------------------------------------------------------- руна (корень героя: без наклона корпуса)
  const holder = parent.parent || parent;
  const hM = height * (parent.scale ? parent.scale.x : 1);   // рост в метрах (корень не масштабирован)
  const runeGeo = new THREE.PlaneGeometry(2, 2); runeGeo.rotateX(-Math.PI / 2);
  const RNU = {
    uTime: { value: 0 }, uSpin: { value: 0 }, uK: { value: 0 }, uFury: { value: 0 }, uReady: { value: 0 }, uFlash: { value: 0 }, uCharge: { value: 0 },
    uYaw: { value: 0 }, uStateK: { value: 0 }, uLow: { value: 0 },
    uC1: { value: c1.clone() }, uC2: { value: c2.clone() }, uStateC: { value: goldC.clone() }, uLowC: { value: lowC },
  };
  const runeMat = (hq) => new THREE.ShaderMaterial({
    name: 'hero-rune', uniforms: RNU, vertexShader: RUNE_VERT, fragmentShader: RUNE_FRAG, defines: hq ? { RUNE_HQ: '' } : {},
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const rune = new THREE.Mesh(runeGeo, runeMat(Q.hq));
  rune.name = 'hero-rune'; rune.position.y = 0.025; rune.renderOrder = 2; rune.frustumCulled = false;
  rune.castShadow = false; rune.receiveShadow = false; rune.userData.noShadow = true; rune.userData.noGhost = true; rune.visible = false;
  holder.add(rune);

  // волны вокруг тела — только medium/high
  let waves = null;
  const WU = { uTime: { value: 0 }, uK: { value: 0 }, uC1: { value: c1.clone() }, uC2: { value: c2.clone() } };
  function makeWaves() {
    const wg = new THREE.CylinderGeometry(0.62, 0.36, 1, 32, 1, true); wg.translate(0, 0.5, 0);
    const wm = new THREE.ShaderMaterial({ name: 'hero-aura-waves', uniforms: WU, vertexShader: WAVE_VERT, fragmentShader: WAVE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });   // аддитив: порядок граней не важен — один проход вместо двух
    const w = new THREE.Mesh(wg, wm);
    w.name = 'hero-aura-waves'; w.scale.set(1, hM * 1.05, 1); w.renderOrder = 3; w.frustumCulled = false;
    w.castShadow = false; w.receiveShadow = false; w.userData.noShadow = true; w.visible = false;
    holder.add(w);
    return w;
  }
  // следы шагов и пыль рывка — в мире (сцена), только medium/high
  let prints = null, burst = null;
  const sceneOf = (o) => { let r = o; while (r && r.parent) r = r.parent; return r && r.isScene ? r : null; };
  function makeTrails() {
    if (Q.prints && !prints) prints = createFootprints(THREE, { color: c1, color2: c2, count: Q.prints, size: 1.25, life: 2.2 });
    if (Q.burst && !burst) burst = createDashBurst(THREE, { color: c1, color2: c2, count: Q.burst });
    attachTrails();
  }
  function attachTrails() {
    const sc = sceneOf(holder);
    if (!sc) return;
    if (prints && prints.mesh.parent !== sc) sc.add(prints.mesh);
    if (burst && burst.points.parent !== sc) sc.add(burst.points);
  }
  function dropTrails() { if (prints) { prints.dispose(); prints = null; } if (burst) { burst.dispose(); burst = null; } }
  function applyTier() {
    g.setDrawRange(0, nOf(Q.pts));
    const old = rune.material; rune.material = runeMat(Q.hq); old.dispose();
    if (Q.waves && !waves) waves = makeWaves();
    if (!Q.waves && waves) { holder.remove(waves); waves.geometry.dispose(); waves.material.dispose(); waves = null; }
    dropTrails();
    if (Q.prints || Q.burst) makeTrails();
  }
  if (Q.waves) waves = makeWaves();
  if (Q.prints || Q.burst) makeTrails();

  // ---------------------------------------------------------------- состояние
  const st = {
    menu: true, dead: false, victory: false, engaged: false, battle: false,
    fury: 0, ready: false, chL: 0, chR: 0, guard: 0, hpR: 1, speed: 0, dashing: false,
    // сглаженное (реальное время)
    vis: 0, fz: 0, rdy: 0, sL: 0, sR: 0, gd: 0, lw: 0, flash: 0, pop: 0, dead01: 0,
    dashQ: false, dashX: 0, dashZ: 1, stopQ: false, wasDash: false, lastDash: -1, trailT: -1,
  };
  let kExt = 1, lod = 0, lastT = null, ticked = false, disposed = false, ghostQ = null, remoteHero = false;
  let anchorsRef = null, feet = null, rootYaw = 0;
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _r = new THREE.Vector3(), _hL = new THREE.Vector3(), _hR = new THREE.Vector3();
  const _cl = new THREE.Color(), _cs = new THREE.Color();

  // кости стоп героя (сырые: их двигает скелет кожи) — один раз
  function findFeet(cur) {
    const H = cur && cur.vrm && cur.vrm.humanoid;
    if (!H || !H.getRawBoneNode) return [];
    const mk = (foot, toe, side) => {
      const f = H.getRawBoneNode(foot) || (H.getNormalizedBoneNode && H.getNormalizedBoneNode(foot));
      if (!f) return null;
      const tt = H.getRawBoneNode(toe) || null;
      return { f, t: tt, side, planted: true, px: 0, pz: 0, has: false, lastT: -1 };
    };
    return [mk('leftFoot', 'leftToes', -1), mk('rightFoot', 'rightToes', 1)].filter(Boolean);
  }

  // заряд рук из снимка: сомкнутые ладони — обе, кулак — правая (левая слабее), сфера — обе, лук, заклинание рукой
  function readCharge(P) {
    let l = 0, r = 0;
    const sc = clamp01(num(P.sigilCharge));
    if (sc > 0) { l = Math.max(l, sc); r = Math.max(r, sc); }
    const bc = clamp01(num(P.burstCharge));
    if (bc > 0) { r = Math.max(r, bc); l = Math.max(l, bc * 0.45); }
    const cj = P.conjure && fin(P.conjure.charge) ? clamp01(P.conjure.charge) * 0.85 : 0;
    if (cj > 0) { l = Math.max(l, cj); r = Math.max(r, cj); }
    const bw = P.bow && P.bow.active ? clamp01(num(P.bow.draw)) * (P.bow.charged ? 0.9 : 0.6) : 0;
    if (bw > 0) { l = Math.max(l, bw * 0.8); r = Math.max(r, bw); }
    const hs = P.handSpell && (P.handSpell.phase === 'form' || P.handSpell.phase === 'hold') ? clamp01(num(P.handSpell.power, 0.5)) * 0.8 : 0;
    if (hs > 0) { r = Math.max(r, hs); if (P.handSpell.twoHand) l = Math.max(l, hs); }
    st.chL = l; st.chR = r;
  }

  function firePulse() {
    if (remoteHero || typeof window === 'undefined') return;
    holder.getWorldPosition(_w); _w.y += hM * 0.55;
    const x = _w.x, y = _w.y, z = _w.z;
    if (!pulseP) pulseP = import('../core/postfx.js').then((mod) => mod.pulse).catch(() => null);
    pulseP.then((pf) => { if (pf && !disposed) { try { pf('shockwave', 0.55, { x, y, z }); } catch (e) { /* без импульса */ } } });
  }

  // ---------------------------------------------------------------- кадр: снимок и события (heroModel.update)
  function tick(dt, snap, events, cur, anchors, remote = false) {
    if (disposed) return;
    ticked = true; remoteHero = !!remote;
    if (anchors) anchorsRef = anchors;
    if (cur && !feet) feet = findFeet(cur);
    if (cur && cur.ghost && cur.ghost.setQuality && ghostQ !== tier) { ghostQ = tier; try { cur.ghost.setQuality(tier); } catch (e) { /* ignore */ } }
    const P = snap && snap.player;
    st.menu = !P;
    if (!P) { st.battle = false; st.dead = false; st.victory = false; st.dashing = false; st.wasDash = false; st.chL = st.chR = 0; st.guard = 0; return; }
    const status = snap.status || 'playing';
    st.dead = status === 'defeat' || P.action === 'dead' || !!P.dead;
    st.victory = status === 'victory';
    st.battle = !st.dead;
    st.engaged = P.encounter === 'engaged' || snap.mode === 'pvp';
    st.fury = fin(P.fury) && num(P.furyMax, 100) > 0 ? clamp01(P.fury / num(P.furyMax, 100)) : 0;
    st.ready = !!P.furyReady;
    readCharge(P);
    st.hpR = P.maxHp ? clamp01(num(P.hp, P.maxHp) / P.maxHp) : 1;
    st.guard = P.warded || P.bastion ? 1 : P.shielding ? 0.7 : 0;
    st.speed = fin(P.speed) ? P.speed : Math.hypot(num(P.velocity && P.velocity.x), num(P.velocity && P.velocity.z));
    const dashing = !!P.dashing || P.action === 'dash';
    if (st.wasDash && !dashing) st.stopQ = true;   // рывок закончился — пыль торможения
    st.wasDash = dashing; st.dashing = dashing;
    const ev = Array.isArray(events) ? events : NO_EV;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (!e) continue;
      const d = e.data || NO_EV;
      if (!!d.remote !== !!remote) continue;
      switch (e.type) {
        case 'player_dash': {
          const wd = d.worldDirection || P.dashDir;
          if (wd && (fin(wd.x) || fin(wd.z))) { st.dashX = num(wd.x); st.dashZ = num(wd.z); }
          st.dashQ = true; st.flash = Math.max(st.flash, 0.18);
          break;
        }
        case 'ultimate_ready': st.flash = 1; firePulse(); break;
        case 'ultimate_start': st.flash = 1; break;
        case 'perfect_dodge': st.flash = Math.max(st.flash, 0.55); break;
        case 'ward_start': case 'bastion_start': case 'shield_start': st.pop = 1; break;
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- кадр: визуал (после позы, vrmTick)
  function update(t) {
    if (disposed) return;
    const dt = lastT === null ? 0 : Math.min(0.1, Math.max(0, t - lastT));
    lastT = t;
    syncMaterials();
    U.uTime.value = t; RNU.uTime.value = t; WU.uTime.value = t;
    const battle = ticked && st.battle && !st.menu;
    // сглаживание по реальному времени (стоп-кадр удара не замораживает ауру)
    st.vis = approach(st.vis, battle ? (st.engaged ? 1 : 0.7) : 0, 3, 2.5, dt);
    st.fz = approach(st.fz, battle ? st.fury : 0, 2.5, 4, dt);
    st.rdy = approach(st.rdy, battle && st.ready ? 1 : 0, 3, 5, dt);
    st.sL = approach(st.sL, battle ? st.chL : 0, 9, 3.5, dt);
    st.sR = approach(st.sR, battle ? st.chR : 0, 9, 3.5, dt);
    st.gd = approach(st.gd, battle ? st.guard : 0, 8, 3, dt);
    const lowT = battle && st.hpR < 0.35 ? 0.45 + 0.55 * (1 - st.hpR / 0.35) : 0;
    st.lw = approach(st.lw, lowT, 2, 2, dt);
    st.dead01 = approach(st.dead01, ticked && st.dead ? 1 : 0, 2, 4, dt);
    st.flash = Math.max(0, st.flash - dt / 0.9);
    st.pop = Math.max(0, st.pop - dt * 2.5);
    const fl = st.flash * st.flash, ch = Math.max(st.sL, st.sR);
    const almost = smooth(0.72, 0.95, ch);   // жест «почти готов»: руки пульсируют
    const hb = heartbeat(t) * st.lw;
    const alive = 1 - st.dead01;

    // руки (якоря heroModel; мир) → rim; в осях модели → искры
    let haveHands = false;
    if (anchorsRef && anchorsRef.handL && anchorsRef.handR && ch > 0.002) {
      anchorsRef.handL.getWorldPosition(_hL); anchorsRef.handR.getWorldPosition(_hR);
      RU.heroAuraHandL.value.copy(_hL); RU.heroAuraHandR.value.copy(_hR);
      U.uHandL.value.copy(_hL); parent.worldToLocal(U.uHandL.value);
      U.uHandR.value.copy(_hR); parent.worldToLocal(U.uHandR.value);
      haveHands = true;
    }
    const handPulse = 2.2 * (1 + 0.45 * almost * (0.5 + 0.5 * Math.sin(t * 14)));
    RU.heroAuraHandK.value.set(haveHands ? smooth(0.02, 1, st.sL) * handPulse : 0, haveHands ? smooth(0.02, 1, st.sR) * handPulse : 0);
    U.uHandW.value.set(haveHands ? st.sL : 0, haveHands ? st.sR : 0);

    // контровой rim: стихия; ярость и вспышка — ярче и горячее; смерть — гаснет
    const rimBase = !ticked || st.menu ? 0.5 : 0.7;
    RU.heroAuraRimK.value = (rimBase + 0.65 * st.fz + 0.4 * st.rdy * (0.5 + 0.5 * Math.sin(t * 5)) + 2.2 * fl + 0.35 * ch) * alive;
    RU.heroAuraRimC.value.copy(c1).lerp(c2, Math.min(0.6, 0.2 * st.fz + 0.4 * st.flash));
    // состояние: оберег/щит — золото (с «хлопком» при включении), мало HP — красное сердцебиение
    // золото и красное смешиваются по силе (гаснущий оберег не прячет сердцебиение)
    const gk = st.gd * (1.15 + 0.9 * st.pop), rk2 = hb * 1.7;
    RU.heroAuraStateC.value.copy(lowC).lerp(goldC, gk + rk2 > 1e-4 ? gk / (gk + rk2) : 1);
    RU.heroAuraStateK.value = Math.max(gk, rk2) * alive;
    holder.getWorldPosition(_r);
    rootYaw = holder.rotation ? holder.rotation.y : 0;
    RU.heroAuraGround.value = _r.y;
    RU.heroAuraUnderK.value = st.vis * (0.22 + 0.55 * st.fz + 0.9 * fl + 0.4 * ch) * alive;

    // частицы ауры
    U.uTF.value += dt * (1 + 0.65 * st.fz);
    U.uFury.value = st.fz; U.uFlash.value = st.flash; U.uLow.value = Math.min(0.8, hb * 0.9);
    U.uK.value = kExt * (1 + 0.8 * st.fz + 1.6 * fl + 0.3 * st.rdy) * alive;
    g.setDrawRange(0, nOf(Q.pts + (Q.ptsMax - Q.pts) * st.fz));
    pts.visible = lod < 2 && U.uK.value > 0.01;

    // руна: в бою (в меню — пьедестал витрины), растёт с яростью, «хлопок» при вспышке
    const rk = st.vis * (0.75 + 0.5 * st.fz + 0.25 * ch) * alive;
    rune.visible = lod < 2 && rk > 0.01;
    if (rune.visible) {
      RNU.uSpin.value = (RNU.uSpin.value + dt * (0.1 + 0.3 * st.fz + 0.25 * st.rdy)) % (Math.PI * 10);   // период 5·2π: знаки, засечки и гексаграмма без шва
      RNU.uK.value = rk; RNU.uFury.value = st.fz; RNU.uReady.value = st.rdy; RNU.uFlash.value = st.flash; RNU.uCharge.value = ch;
      RNU.uYaw.value = rootYaw; RNU.uLow.value = Math.min(1, hb * 1.2);
      RNU.uStateK.value = st.gd * (1 + 0.8 * st.pop);
      rune.scale.setScalar(0.85 * (1 + 0.25 * st.fz) * (1 + 0.12 * st.flash * (1 - st.flash) * 4));
    }
    // волны вокруг тела: при накоплении ярости, заряде и вспышке
    if (waves) {
      const wk = st.vis * (smooth(0.15, 1, st.fz) * 0.85 + 0.45 * ch + 1.3 * fl + 0.3 * st.rdy) * alive;
      waves.visible = lod < 1 && wk > 0.01;
      WU.uK.value = wk;
    }

    // следы шагов и пыль рывка (мир)
    if (prints || burst) {
      if ((prints && !prints.mesh.parent) || (burst && !burst.points.parent)) attachTrails();
      if (prints) prints.update(t);
      if (burst) burst.update(t);
      if (battle && dt > 0 && lod < 1) stepFeet(t, dt);
      if (burst && (st.dashQ || st.stopQ) && lod < 2) {
        const k = 0.8 + 0.4 * st.fz;
        if (st.dashQ) { burst.emit('dash', _r.x, _r.y, _r.z, st.dashX, st.dashZ, t, k); st.trailT = t; }
        else burst.emit('stop', _r.x, _r.y, _r.z, st.dashX, st.dashZ, t, k);
      } else if (burst && st.dashing && lod < 1 && t - st.trailT > 0.055) {
        st.trailT = t;   // по ходу рывка — искры и пыль вдоль пути
        burst.emit('trail', _r.x, _r.y, _r.z, st.dashX, st.dashZ, t, 0.8 + 0.4 * st.fz);
      }
    }
    st.dashQ = false; st.stopQ = false;
  }

  // шаг: стопа опустилась и замерла в мире (скорость стопы ≪ скорости героя) — отпечаток и щепоть пыли
  function stepFeet(t, dt) {
    if (!feet || !feet.length) return;
    const run = st.speed > 3.1 && !st.dashing;
    for (let i = 0; i < feet.length; i++) {
      const F = feet[i];
      F.f.getWorldPosition(_v);
      if (F.t) F.t.getWorldPosition(_w); else _w.copy(_v);
      const h = Math.min(_v.y, _w.y) - _r.y;
      const sp = F.has ? Math.hypot(_v.x - F.px, _v.z - F.pz) / dt : 0;
      F.px = _v.x; F.pz = _v.z; F.has = true;
      const planted = F.planted ? h < 0.13 && sp < Math.max(1.6, 0.45 * st.speed) : h < 0.085 && sp < Math.max(1.2, 0.3 * st.speed);
      if (planted && !F.planted && run && t - F.lastT > 0.2 && prints) {
        F.lastT = t;
        const dx = _w.x - _v.x, dz = _w.z - _v.z;
        const yaw = dx * dx + dz * dz > 0.0009 ? Math.atan2(dx, dz) : rootYaw;
        const cx = (_v.x + _w.x) * 0.5, cz = (_v.z + _w.z) * 0.5;
        prints.stamp(cx, _r.y + 0.012, cz, yaw, F.side, 0.6 + 0.4 * smooth(3, 7, st.speed) + 0.4 * st.fz, t);
        if (burst && tier === 'high') burst.emit('step', cx, _r.y, cz, Math.sin(yaw), Math.cos(yaw), t, 1);
      }
      F.planted = planted;
    }
  }

  function setQuality(q) {
    const nt = tierOf(q);
    if (nt === tier || disposed) return;
    tier = nt; Q = QUAL[tier];
    applyTier();
    syncMaterials();   // heroShading только что пересобрал материалы — патч сразу, до предкомпиляции шейдеров
  }

  return {
    object: pts,
    rune,
    update, tick, setQuality,
    setIntensity(v) { kExt = Math.max(0, v); U.uK.value = kExt; pts.visible = kExt > 0.01 && lod < 2; },
    setLod(l) { lod = l; pts.visible = l < 2 && kExt > 0.01; if (l >= 2) { rune.visible = false; if (waves) waves.visible = false; } },
    // QA: что сейчас рисуется и с какой силой
    state: () => ({
      tier, lod, menu: st.menu, battle: !!(ticked && st.battle), fury: +st.fz.toFixed(3), ready: +st.rdy.toFixed(3), flash: +st.flash.toFixed(3),
      charge: [+st.sL.toFixed(3), +st.sR.toFixed(3)], guard: +st.gd.toFixed(3), low: +st.lw.toFixed(3),
      rimK: +RU.heroAuraRimK.value.toFixed(3), stateK: +RU.heroAuraStateK.value.toFixed(3),
      handK: [+RU.heroAuraHandK.value.x.toFixed(3), +RU.heroAuraHandK.value.y.toFixed(3)],
      rune: rune.visible, waves: !!(waves && waves.visible), prints: !!(prints && prints.alive), burst: !!(burst && burst.alive),
      points: g.drawRange.count, feet: feet ? feet.length : 0, patched: meshes.filter((o) => [].concat(o.material).some((x) => x && x.userData.heroAuraRim)).length,
    }),
    dispose() {
      disposed = true;
      if (pts.parent) pts.parent.remove(pts);
      g.dispose(); m.dispose();
      if (rune.parent) rune.parent.remove(rune);
      runeGeo.dispose(); rune.material.dispose();
      if (waves) { if (waves.parent) waves.parent.remove(waves); waves.geometry.dispose(); waves.material.dispose(); waves = null; }
      dropTrails();
      // материалы героя освобождает heroShading/heroGear; кромку гасим на случай, если какие-то переживут героя
      RU.heroAuraRimK.value = 0; RU.heroAuraStateK.value = 0; RU.heroAuraHandK.value.set(0, 0); RU.heroAuraUnderK.value = 0;
      meshes.length = 0; seen.length = 0; anchorsRef = null; feet = null;
    },
  };
}
