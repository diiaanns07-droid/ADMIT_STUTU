/*
 * ASHEN OATH — atmosphere.js
 * Небо с затмением, высотный туман со свечением к затмению (в шейдерах материалов),
 * море тумана, световые столбы, rim-свет персонажей и IBL из неба.
 * Источник параметров — AAA Visual Bible, разделы 4, 5, 10 и 16.
 *
 * Модуль вызывается из world.js: не рендерит кадр, не двигает камеру, не создаёт rAF.
 * Глобальные правки (ShaderChunk тумана, uniform-ы в ShaderLib, scene.environment)
 * возвращаются в исходное состояние в dispose().
 *
 * [W3-КИНО] Цвет по фазам, молнии, низовая дымка:
 *   фаза 1 — холодная глубокая синь и золото короны; фаза 2 (Регент в ярости) — багровое небо,
 *   облака подсвечены снизу, частые далёкие молнии с видимым ломаным разрядом (не на low и не в reducedMotion).
 *   createAtmosphere({ …, haze: { x, y, z, radius } }) — дымка над полом арены (по умолчанию 0, 0, 0, 13 м),
 *     один draw call, слоёв: low 1, medium 2, high 3; в зоне леса (настроение зоны) гаснет.
 *   atmosphere.look — ОДИН и тот же объект (без аллокаций), актуален после update():
 *     { red, dawn, dark, zone, zoneGrade, flash }
 *       red   0..1 — фаза 2 с учётом setPhaseBoost (max), dawn — рассвет победы, dark — поражение;
 *       zone  0..1 — вес настроения зоны (лес), zoneGrade — ZONE_MOOD_STATE.grade;
 *       flash 0..1 — яркость молнии/вспышки неба в этом кадре.
 *   atmosphere.setPhaseBoost(k, hold = 2.5) — временный толчок к багровому (0..1) для сцены перехода в фазу 2:
 *     небо краснеет сразу, фаза догоняет быстрее; через hold с без нового вызова толчок сам отпускается.
 *   atmosphere.flash(amount = 1, bolt = false) — вспышка неба у горизонта (+ ключ/небесный свет через skyFlash);
 *     bolt = true — с видимым разрядом молнии.
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);
const deg = (d) => (d * Math.PI) / 180;
function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Азимут считается как в world.js: polar(a) = (sin a, 0, cos a); a = 180° — за боссом от стартовой камеры.
export const ECLIPSE = {
  azimuth: 186,      // чуть левее оси «камера → босс»: на стартовом ракурсе диск в кольце нимба
  elevation: 18.5,   // над маской, внутри нимба; ниже верхнего края кадра при fov 58°
  discRadius: 3.6,   // угловой радиус диска, градусы
  keyElevation: 40,  // ключ из того же азимута, но выше: блик на мокром полу уходит под нижний край кадра
  follow: 0.5,       // доля поворота камеры вокруг босса, на которую затмение смещается следом
};

export const FOG = {
  density: 0.02,     // d
  falloff: 0.12,     // k
  baseY: 0,          // y0 — пол арены
  max: 0.97,
  glow: 1.0,
};

// [BDO] Настроение зоны (контракт с №5 [FOREST]): atmosphere.setZoneMood({ weight, sky, fog, sun, exposure }).
// weight 0..1 — насколько герой внутри зоны; смена плавная (атмосфера сама сглаживает ~1 с).
// Поля необязательны: чего нет — берётся из пресета ZONE_MOODS.brightForest.
//   sky:  { top, horizon, corona, coronaIntensity, sunDisc 0..1 (0 — чёрный диск затмения, 1 — светлое солнце) }
//   fog:  { color, glow, density (абсолютная, по умолчанию 0.02 у затмения) }
//   sun:  { color, intensity (множитель ключа), env (множитель IBL) }
//   exposure: множитель экспозиции (1 — как везде)
//   grade: { shadow:[r,g,b], high:[r,g,b], sat, contrast } — цветокоррекция postfx (тёплые света, бирюзовые тени)
// Цвета — число 0xRRGGBB, строка '#rrggbb' или THREE.Color.
export const ZONE_MOODS = {
  brightForest: {
    sky: { top: 0x3f86b8, horizon: 0xcfe3d2, corona: 0xfff1cf, coronaIntensity: 0.55, sunDisc: 1 },
    fog: { color: 0x9fbfae, glow: 0xffe7b8, density: 0.0065 },
    sun: { color: 0xffe2b0, intensity: 1.55, env: 3.2 },
    exposure: 1.22,
    grade: { shadow: [-0.012, 0.018, 0.022], high: [0.03, 0.018, -0.012], sat: 1.12, contrast: 0.22 },
  },
};
// Общее состояние настроения (читает core/postfx.js для грейда); пишет только atmosphere.update.
export const ZONE_MOOD_STATE = { w: 0, grade: { shadow: [0, 0, 0], high: [0, 0, 0], sat: 1, contrast: 0 } };

const NOISE_GLSL = /* glsl */`
float ashH12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float ashVN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( ashH12( i ), ashH12( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( ashH12( i + vec2( 0.0, 1.0 ) ), ashH12( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float ashFbm( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 5; i ++ ) { s += a * ashVN( p ); p = p * 2.03 + vec2( 17.1, 9.2 ); a *= 0.5; }
  return s / 0.96875;
}
`;

/* ------------------------------ Высотный туман ------------------------------ */
// Интеграл плотности вдоль луча (Библия, разд. 10):
//   F = 1 - exp(-d · L · e^{-k(y_c - y0)} · (1 - e^{-kΔy}) / (kΔy)),  F ≤ max
// Цвет: от fogColor к ashFogGlow по pow(dot(взгляд, затмение), 8).
// ashFogA.w == 0 (например, у ShaderMaterial без этих uniform-ов) — обычный линейный туман three.
const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldOff;
#endif`;
const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldOff = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif`;
const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldOff;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec4 ashFogA;
  uniform vec4 ashFogB;
  uniform vec3 ashFogGlow;
  uniform vec4 ashFogLow;
#endif`;
const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 ashFogCol = fogColor;
  if ( ashFogA.w > 0.0 ) {
    float ashL = length( vFogWorldOff );
    vec3 ashV = vFogWorldOff / max( ashL, 1e-4 );
    float ashK = ashFogB.x;
    float ashKdy = ashK * vFogWorldOff.y;
    float ashRatio = abs( ashKdy ) > 1e-3 ? ( 1.0 - exp( - ashKdy ) ) / ashKdy : 1.0 - 0.5 * ashKdy;
    float ashOd = ashFogA.w * ashL * exp( - ashK * ( cameraPosition.y - ashFogB.y ) ) * ashRatio;
    fogFactor = min( 1.0 - exp( - ashOd ), ashFogB.z );
    float ashSun = pow( max( dot( ashV, ashFogA.xyz ), 0.0 ), 8.0 );
    ashFogCol = mix( fogColor, ashFogGlow, ashSun * ashFogB.w );
    float ashLowY = cameraPosition.y + vFogWorldOff.y;
    ashFogCol = mix( ashFogCol, ashFogLow.rgb, ashFogLow.w * ( 1.0 - smoothstep( -4.0, 3.0, ashLowY ) ) );
  }
  gl_FragColor.rgb = mix( gl_FragColor.rgb, ashFogCol, fogFactor );
#endif`;

/* ---------------------------------- Небо ---------------------------------- */
const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = ( modelMatrix * vec4( position, 0.0 ) ).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;
const SKY_FRAG = /* glsl */`
uniform vec3 uSun;
uniform vec3 uFogBase;
uniform vec3 uFogGlow;
uniform float uGlowK;
uniform vec4 uFogLow;
uniform vec3 uDomeLow;
uniform vec3 uDomeHigh;
uniform vec3 uDomeCorona;
uniform vec3 uCorona;
uniform float uCoronaI;
uniform float uDiscR;
uniform float uBead;
uniform float uTime;
uniform float uFlash;
uniform vec3 uFlashDir;
uniform float uBake;
uniform vec3 uGround;
uniform float uSunDisc;
// [W3-КИНО] золото короны, подсветка облаков снизу, цвет вспышки, разряд молнии
uniform vec3 uGold;
uniform float uGoldK;
uniform vec3 uCloudUnder;
uniform vec3 uFlashCol;
uniform float uStrike;
uniform float uBolt;
uniform vec4 uBoltSeed;
uniform vec3 uBoltCore;
uniform vec3 uBoltGlow;
varying vec3 vDir;
${NOISE_GLSL}
// [W3-КИНО] кусочно-линейный шум: изломы канала молнии
float ashBoltN( float x, float s ) {
  float i = floor( x );
  return mix( ashH12( vec2( i, s ) ), ashH12( vec2( i + 1.0, s ) ), fract( x ) ) - 0.5;
}
void main() {
  vec3 d = normalize( vDir );
  float cs = dot( d, uSun );
  float ang = acos( clamp( cs, -1.0, 1.0 ) );
  float el = d.y;
  float glow = pow( max( cs, 0.0 ), 8.0 ) * uGlowK;
  vec3 fogC = mix( uFogBase, uFogGlow, glow );
  fogC = mix( fogC, uFogLow.rgb, uFogLow.w * 0.35 );
  vec3 dome = mix( uDomeLow, uDomeHigh, smoothstep( 0.05, 0.85, el ) );
  dome = mix( dome, uDomeCorona, pow( max( cs, 0.0 ), 7.0 ) );
  vec3 col = mix( fogC, dome, smoothstep( 0.0, 0.3, el ) );

  // Облака: плоский слой над ареной (без шва по азимуту), вытянутые полосы.
  vec2 p = d.xz / ( max( el, 0.0 ) + 0.09 );
  float c1 = ashFbm( p * vec2( 0.55, 1.6 ) + vec2( uTime * 0.004, 0.0 ) );
  float m1 = smoothstep( 0.52, 0.8, c1 ) * smoothstep( 0.0, 0.07, el ) * ( 1.0 - smoothstep( 0.4, 0.8, el ) );
  float c2 = ashFbm( p * vec2( 0.9, 2.6 ) + vec2( - uTime * 0.006, 3.1 ) );
  float m2 = smoothstep( 0.56, 0.82, c2 ) * smoothstep( 0.02, 0.12, el ) * ( 1.0 - smoothstep( 0.25, 0.55, el ) ) * 0.75;
  float cm = max( m1, m2 );
  float lit = pow( max( cs, 0.0 ), 3.0 );
  vec3 cloudCol = mix( col * 0.55, fogC * 0.85, 0.3 );
  // [W3-КИНО] фаза 2: низ облаков у горизонта подсвечен багровым заревом
  cloudCol += uCloudUnder * ( 1.0 - smoothstep( 0.02, 0.32, el ) ) * ( 0.45 + 0.55 * c1 );
  col = mix( col, cloudCol, cm * 0.9 );
  float edge = clamp( cm * ( 1.0 - cm ) * 4.0, 0.0, 1.0 );
  col += mix( uCorona, uGold, uGoldK * pow( max( cs, 0.0 ), 24.0 ) ) * uCoronaI * edge * lit * 0.32;   // [W3-КИНО] золото — только у затмения

  // Корона: лучи по полярному углу вокруг диска (бесшовно через точку на окружности).
  vec3 t1 = normalize( cross( uSun, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 t2 = cross( t1, uSun );
  float pa = atan( dot( d, t2 ), dot( d, t1 ) );
  float rot = uTime * 0.012;
  vec2 cp = vec2( cos( pa + rot ), sin( pa + rot ) );
  float rays = ashFbm( cp * 2.6 + 7.0 );
  float fine = ashVN( cp * 13.0 + 3.0 );
  float rimD = ang - uDiscR;
  float outside = step( 0.0, rimD );
  float fall = exp( - max( rimD, 0.0 ) / ( 0.03 + 0.07 * rays * rays ) );
  float corona = fall * ( 0.3 + rays * rays * 1.8 + fine * 0.35 ) * 0.95;
  corona += exp( - max( rimD, 0.0 ) / 0.2 ) * 0.14;
  float haloX = ( ang - 0.38 ) / 0.014;
  float halo = exp( - haloX * haloX ) * 0.05;
  // [W3-КИНО] золотое кольцо у самого диска, дальше корона уходит в холодный цвет
  vec3 corC = mix( uCorona, uGold, uGoldK * 0.55 * exp( - max( rimD, 0.0 ) / 0.02 ) );
  col += corC * uCoronaI * ( corona * outside * ( 1.0 - cm * 0.7 ) + halo );

  // Диск и раскалённая кромка; «бусина» — точка, где из-за диска выглядывает свет.
  float disc = 1.0 - smoothstep( uDiscR - 0.0016, uDiscR, ang );
  col = mix( col, mix( vec3( 0.0035, 0.0045, 0.0065 ), uCorona * uCoronaI * 6.0 + vec3( 2.2, 2.0, 1.7 ), uSunDisc ), disc );
  col += mix( uCorona, uGold, uGoldK * 0.7 ) * uCoronaI * exp( - abs( rimD ) / 0.0024 ) * 3.2;
  float beadA = pa - 2.35;
  beadA = atan( sin( beadA ), cos( beadA ) );
  col += vec3( 1.0, 0.97, 0.92 ) * uBead * exp( - beadA * beadA / 0.018 ) * exp( - abs( rimD ) / 0.006 ) * 9.0;

  // Далёкая молния: облако вспыхивает изнутри.
  // [W3-КИНО] диск затмения закрывает облака: вспышка за ним не просвечивает
  float fl = uFlash * exp( - ( 1.0 - dot( d, uFlashDir ) ) * 14.0 ) * ( 1.0 - disc );
  col += ( cm * 1.6 + 0.2 ) * fl * uFlashCol;
  // [W3-КИНО] вспышка неба (flash): облака светлеют по всему небу
  col += uFlashCol * uStrike * ( 0.06 + 0.3 * cm ) * ( 1.0 - disc );

  // [W3-КИНО] Разряд: ломаный канал от облаков к горизонту у uFlashDir, с ответвлением.
  // Координаты — тангенсы углов от направления вспышки; считается только в кадрах вспышки.
  if ( uBolt > 0.0 ) {
    float hl = length( d.xz );
    vec2 fh = normalize( uFlashDir.xz );
    float fw = dot( d.xz, fh );
    if ( fw > 0.5 * hl && hl > 1e-3 ) {
      float bx = ( d.x * fh.y - d.z * fh.x ) / fw;
      float by = d.y / hl;
      float yTop = uBoltSeed.z, yBot = -0.015;
      if ( abs( bx ) < 0.2 && by < yTop + 0.02 && by > yBot - 0.02 ) {
        float s = uBoltSeed.x, side = uBoltSeed.w;
        float cw = max( uBoltSeed.y, 0.0006 );   // ширина ядра ~ пиксель (иначе канал рвётся на точки)
        float u = ( yTop - by ) / ( yTop - yBot );
        float xb = ashBoltN( by * 16.0, s ) * 0.05 + ashBoltN( by * 52.0, s + 1.7 ) * 0.016 + ashBoltN( by * 150.0, s + 3.1 ) * 0.005 + u * side * 0.02;
        float dx = abs( bx - xb );
        float vm = smoothstep( 0.0, 0.12, u ) * ( 1.0 - smoothstep( 0.92, 1.05, u ) );
        float core = exp( - dx / cw ) * vm;
        float b = ( exp( - dx / 0.008 ) * 0.22 + exp( - dx / 0.035 ) * 0.06 ) * vm;
        // ответвление выходит из канала и гаснет на конце
        float uf = 0.3 + 0.25 * fract( s * 0.37 );
        float yf = yTop - ( yTop - yBot ) * uf;
        float ub = u - uf;
        float xf = ashBoltN( yf * 16.0, s ) * 0.05 + ashBoltN( yf * 52.0, s + 1.7 ) * 0.016 + ashBoltN( yf * 150.0, s + 3.1 ) * 0.005 + uf * side * 0.02;
        float xb2 = xf - side * ub * 0.18 + ( ashBoltN( by * 60.0, s + 9.0 ) - ashBoltN( yf * 60.0, s + 9.0 ) ) * 0.012;
        float dx2 = abs( bx - xb2 );
        float bm = step( 0.0, ub ) * ( 1.0 - smoothstep( 0.1, 0.38, ub ) );
        core += exp( - dx2 / cw ) * bm * 0.55;
        b += ( exp( - dx2 / 0.007 ) * 0.14 ) * bm;
        col += ( uBoltCore * core * 5.0 + uBoltGlow * b * 2.2 ) * uBolt;
      }
    }
  }

  if ( uBake > 0.5 ) col = mix( col, uGround, smoothstep( 0.0, -0.2, el ) );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------------- Море тумана ------------------------------- */
const SEA_VERT = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const SEA_FRAG = /* glsl */`
uniform vec3 uSun;
uniform vec3 uFogBase;
uniform vec3 uFogGlow;
uniform float uGlowK;
uniform vec4 uFogLow;
uniform float uTime;
uniform float uFlash;
uniform vec3 uFlashCol;
varying vec3 vW;
${NOISE_GLSL}
void main() {
  vec3 v = vW - cameraPosition;
  float L = length( v );
  vec3 d = v / max( L, 1e-3 );
  float cs = dot( d, uSun );
  vec3 fogC = mix( uFogBase, uFogGlow, pow( max( cs, 0.0 ), 8.0 ) * uGlowK );
  fogC = mix( fogC, uFogLow.rgb, uFogLow.w * 0.6 );
  vec2 p = vW.xz * 0.011 + vec2( uTime * 0.004, uTime * 0.0025 );
  float n = ashFbm( p );
  float n2 = ashFbm( p * 3.1 - vec2( uTime * 0.007, 0.0 ) );
  float bill = n * 0.65 + n2 * 0.35;
  vec3 top = fogC * ( 0.72 + 0.55 * bill ) + uFogGlow * pow( max( cs, 0.0 ), 3.0 ) * bill * 0.4;
  top += uFlashCol * uFlash * bill * 0.3;   // [W3-КИНО] цвет вспышки по фазе
  vec3 col = mix( top, fogC, smoothstep( 90.0, 700.0, L ) );
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ----------------------------- Световые столбы ----------------------------- */
const RAY_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vN = normalize( mat3( modelMatrix ) * normal );
  vec4 w = modelMatrix * vec4( position, 1.0 );
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const RAY_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform vec3 uAxis;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec3 V = cameraPosition - vW;
  float dist = length( V );
  float facing = abs( dot( normalize( vN ), V / max( dist, 1e-3 ) ) );
  float soft = pow( facing, 2.5 );
  float t = vUv.y;
  float along = smoothstep( 0.0, 0.18, t ) * ( 1.0 - smoothstep( 0.35, 0.95, t ) );
  float n = ashFbm( vec2( vUv.x * 7.0, t * 2.2 - uTime * 0.035 ) );
  float camFade = smoothstep( 2.0, 10.0, dist );
  float endOn = 1.0 - smoothstep( 0.55, 0.9, abs( dot( V / max( dist, 1e-3 ), uAxis ) ) );
  float a = soft * along * ( 0.35 + 0.65 * n ) * camFade * endOn * uIntensity;
  gl_FragColor = vec4( uColor * a, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* --------------------------- [W3-КИНО] Низовая дымка --------------------------- */
// Плоские слои над полом арены одним draw call: высота и плотность слоя — из uniform-ов по уровню качества.
const HAZE_VERT = /* glsl */`
attribute float aLayer;
uniform vec3 uLayerY;
uniform vec3 uLayerA;
varying vec3 vW;
varying float vLayer;
varying float vA;
void main() {
  float ly = aLayer < 0.5 ? uLayerY.x : ( aLayer < 1.5 ? uLayerY.y : uLayerY.z );
  vA = aLayer < 0.5 ? uLayerA.x : ( aLayer < 1.5 ? uLayerA.y : uLayerA.z );
  vLayer = aLayer;
  vec4 w = modelMatrix * vec4( position.x, position.y + ly, position.z, 1.0 );
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const HAZE_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uOct;
uniform vec3 uHazeA;
uniform vec3 uHazeB;
varying vec3 vW;
varying float vLayer;
varying float vA;
${NOISE_GLSL}
float ashHazeFbm( vec2 p ) {
  float s = 0.0, a = 0.5, n = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    if ( float( i ) >= uOct ) break;
    s += a * ashVN( p ); n += a;
    p = p * 2.07 + vec2( 11.3, 4.7 ); a *= 0.5;
  }
  return s / max( n, 1e-3 );
}
void main() {
  float r = length( vW.xz - uCenter.xz ) / uRadius;
  vec3 V = vW - cameraPosition;
  float L = length( V );
  // край арены, у самой камеры и вдоль слоя (взгляд по касательной) — прозрачно
  float k = vA * ( 1.0 - smoothstep( 0.45, 1.0, r ) ) * smoothstep( 1.6, 4.5, L ) * smoothstep( 0.012, 0.09, abs( V.y ) / max( L, 1e-3 ) );
  if ( k < 0.002 ) discard;
  vec2 p = vW.xz * 0.21 + vec2( uTime * 0.05, uTime * 0.021 ) + vLayer * 5.31;
  float w = ashVN( vW.xz * 0.07 - vec2( uTime * 0.016, - uTime * 0.01 ) + vLayer * 2.7 );
  float n = ashHazeFbm( p + w * 1.4 );
  float m = smoothstep( 0.22, 0.75, n ) * ( 0.5 + 0.5 * w );
  vec2 hv = V.xz / max( length( V.xz ), 1e-3 );
  vec2 sh = uSun.xz / max( length( uSun.xz ), 1e-3 );
  float fwd = pow( max( dot( hv, sh ), 0.0 ), 5.0 );   // к затмению дымка светится (рассеяние вперёд)
  vec3 c = mix( uHazeA, uHazeB, fwd ) * ( 0.8 + 0.4 * n );
  gl_FragColor = vec4( c, clamp( m * k * ( 1.0 + 0.35 * fwd ), 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ============================== createAtmosphere ============================== */
export function createAtmosphere({ THREE, scene, renderer, camera, parent, G, M, T, seed = 7331, reducedMotion = false, quality = 'medium', haze = null }) {
  const own = (x, f) => (f ? f(x) : x);
  const Gx = (g) => own(g, G), Mx = (m) => own(m, M);
  const rnd = mulberry32(seed + 901);
  const col = (hex) => new THREE.Color(hex);
  const P = {
    fogBase: col(0x1c2530), fogGlow: col(0x8fa3c0), fogLow: col(0x2a1418), fogDawn: col(0x6b5a4a),
    // [W3-КИНО] фаза 1 — холодная глубокая синь (было 0x1a2230 / 0x0b0f16 / 0x3b4a5a)
    domeLow: col(0x172640), domeHigh: col(0x060d1d), domeCorona: col(0x34496c), ground: col(0x120e0c),
    corona: col(0xb9c9e6), coronaRed: col(0xff6a4a), coronaDawn: col(0xffe2b8),
    key: col(0xb9c9e6), keyDawn: col(0xffd9a0),
    fogClear: col(0x3e5249),   // [ASHEN_V3] воздух эльфийской деревни: теплее и светлее (setLocalClear)
    // [W3-КИНО] золото короны; фаза 2 — багровое небо, тлеющий горизонт, зарево под облаками
    gold: col(0xffc46a), goldRed: col(0xff7a2e),
    domeLowRed: col(0x701614), domeHighRed: col(0x1d0508), domeCoronaRed: col(0xa82c18),
    fogBaseRed: col(0x34141a), fogGlowRed: col(0xcc4630), cloudUnderRed: col(0xb83418),
    flashCol: col(0xc2cbe8), flashColRed: col(0xffa08a),
    boltCore: col(0xf2f0ff), boltGlow: col(0x9c86ff), boltCoreRed: col(0xffe6dc), boltGlowRed: col(0xff4a2a),
    // [W3-КИНО] низовая дымка: лунная синь / багровые угли / тёплый рассвет; *Glow — в сторону затмения
    hazeCold: col(0x4e5f7c), hazeColdGlow: col(0x9db2d8), hazeEmber: col(0x6a2418), hazeEmberGlow: col(0xff6a34),
    hazeDawn: col(0x8f7c68), hazeDawnGlow: col(0xffd4a0),
  };
  const state = {
    disposed: false, reduced: !!reducedMotion, quality,
    orbit: 0, orbitPrev: null, follow: 0, followTarget: 0,
    red: 0, dawn: 0, dark: 0, flash: 0, flashT: 0, nextFlash: 14 + rnd() * 16, strike: 0, time: 0,
    clear: 0,          // [ASHEN_V3] 0..1 — местное прояснение (эльфийская деревня): туман реже и теплее
    // [W3-КИНО] толчок фазы (setPhaseBoost), сила текущей молнии, видимый разряд
    boost: 0, boostT: 0, boostHold: 0, flashAmp: 1, bolt: false, hazeN: 0,
  };
  // [W3-КИНО] сводка для core/postfx.js (atmosphere.look): один объект на всё время жизни
  const look = { red: 0, dawn: 0, dark: 0, zone: 0, zoneGrade: ZONE_MOOD_STATE.grade, flash: 0 };
  // [BDO] настроение зоны (setZoneMood): target — куда идём, w — сглаженный вес
  const mood = {
    target: 0, w: 0,
    top: col(0x000000), horizon: col(0x000000), corona: col(0x000000), coronaI: 1, sunDisc: 0,
    fogColor: col(0x000000), fogGlow: col(0x000000), fogDensity: FOG.density,
    sunColor: col(0x000000), sunI: 1, env: 1, exposure: 1,
    grade: { shadow: [0, 0, 0], high: [0, 0, 0], sat: 1, contrast: 0 },
  };
  const baseExposure = renderer && Number.isFinite(renderer.toneMappingExposure) ? renderer.toneMappingExposure : 1;

  const dirFrom = (azDeg, elDeg) => new THREE.Vector3(
    Math.sin(deg(azDeg)) * Math.cos(deg(elDeg)), Math.sin(deg(elDeg)), Math.cos(deg(azDeg)) * Math.cos(deg(elDeg))).normalize();
  const sunBase = dirFrom(ECLIPSE.azimuth, ECLIPSE.elevation);
  const keyBase = dirFrom(ECLIPSE.azimuth, ECLIPSE.keyElevation);
  const sunDir = sunBase.clone();
  const keyDir = keyBase.clone();

  /* --------------------------- Глобальные uniform-ы тумана --------------------------- */
  // Обычные объекты {x,y,z,w}: cloneUniforms не копирует их, поэтому все материалы видят одни значения.
  const fogA = { x: sunDir.x, y: sunDir.y, z: sunDir.z, w: FOG.density };
  const fogB = { x: FOG.falloff, y: FOG.baseY, z: FOG.max, w: FOG.glow };
  const fogGlow = { x: P.fogGlow.r, y: P.fogGlow.g, z: P.fogGlow.b };
  const fogLow = { x: P.fogLow.r, y: P.fogLow.g, z: P.fogLow.b, w: 0 };
  const chunkKeys = ['fog_pars_vertex', 'fog_vertex', 'fog_pars_fragment', 'fog_fragment'];
  const prevChunks = {};
  const patchedLibs = [];
  const SC = THREE.ShaderChunk, SL = THREE.ShaderLib;
  if (SC && SL) {
    for (const k of chunkKeys) prevChunks[k] = SC[k];
    SC.fog_pars_vertex = FOG_PARS_VERTEX;
    SC.fog_vertex = FOG_VERTEX;
    SC.fog_pars_fragment = FOG_PARS_FRAGMENT;
    SC.fog_fragment = FOG_FRAGMENT;
    for (const name of Object.keys(SL)) {
      const u = SL[name] && SL[name].uniforms;
      if (!u || !u.fogColor || u.ashFogA) continue;
      u.ashFogA = { value: fogA };
      u.ashFogB = { value: fogB };
      u.ashFogGlow = { value: fogGlow };
      u.ashFogLow = { value: fogLow };
      patchedLibs.push(u);
    }
  }
  const prevFog = scene.fog, prevBg = scene.background;
  const prevEnv = scene.environment;
  const prevEnvI = scene.environmentIntensity;
  const prevEnvRotY = scene.environmentRotation ? scene.environmentRotation.y : 0;
  const fog = new THREE.Fog(P.fogBase.getHex(), 30, 600); // near/far — запасной вариант для чужих ShaderMaterial
  scene.fog = fog;
  scene.background = P.fogBase.clone();

  /* ---------------------------------- Небо ---------------------------------- */
  const camFar = camera && camera.far ? camera.far : 1000;
  const skyRadius = clamp(camFar * 0.82, 160, 900);
  const skyUniforms = {
    uSun: { value: sunDir.clone() },
    uFogBase: { value: P.fogBase.clone() }, uFogGlow: { value: P.fogGlow.clone() }, uGlowK: { value: FOG.glow },
    uFogLow: { value: new THREE.Vector4(P.fogLow.r, P.fogLow.g, P.fogLow.b, 0) },
    uDomeLow: { value: P.domeLow.clone() }, uDomeHigh: { value: P.domeHigh.clone() }, uDomeCorona: { value: P.domeCorona.clone() },
    uCorona: { value: P.corona.clone() }, uCoronaI: { value: 1 }, uDiscR: { value: deg(ECLIPSE.discRadius) }, uBead: { value: 0 },
    uTime: { value: 0 }, uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
    uBake: { value: 0 }, uGround: { value: P.ground.clone() }, uSunDisc: { value: 0 },
    // [W3-КИНО] uBoltSeed: x — сид канала, y — угловой размер пикселя, z — верх разряда (тангенс высоты), w — наклон ±1
    uGold: { value: P.gold.clone() }, uGoldK: { value: 1 }, uCloudUnder: { value: new THREE.Color(0, 0, 0) },
    uFlashCol: { value: P.flashCol.clone() }, uStrike: { value: 0 },
    uBolt: { value: 0 }, uBoltSeed: { value: new THREE.Vector4(0, 0.001, 0.3, 1) },
    uBoltCore: { value: P.boltCore.clone() }, uBoltGlow: { value: P.boltGlow.clone() },
  };
  const skyMat = Mx(new THREE.ShaderMaterial({
    uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, fog: false,
  }));
  const sky = new THREE.Mesh(Gx(new THREE.SphereGeometry(skyRadius, 64, 32)), skyMat);
  sky.name = 'eclipse-sky';
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  parent.add(sky);

  /* ------------------------------ Море тумана ------------------------------ */
  const seaUniforms = {
    uSun: skyUniforms.uSun, uFogBase: skyUniforms.uFogBase, uFogGlow: skyUniforms.uFogGlow, uGlowK: skyUniforms.uGlowK,
    uFogLow: skyUniforms.uFogLow, uTime: skyUniforms.uTime, uFlash: skyUniforms.uFlash, uFlashCol: skyUniforms.uFlashCol,
  };
  const seaMat = Mx(new THREE.ShaderMaterial({ uniforms: seaUniforms, vertexShader: SEA_VERT, fragmentShader: SEA_FRAG, fog: false }));
  const seaGeo = new THREE.CircleGeometry(skyRadius * 0.98, 96);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(Gx(seaGeo), seaMat);
  sea.name = 'fog-sea';
  sea.position.y = -22;
  sea.renderOrder = -8;
  sea.frustumCulled = false;
  parent.add(sea);

  /* --------------------------- IBL: PMREM из неба --------------------------- */
  let envTexture = null, envRT = null;
  if (renderer && THREE.PMREMGenerator) {
    try {
      const pm = new THREE.PMREMGenerator(renderer);
      const es = new THREE.Scene();
      const bakeGeo = new THREE.SphereGeometry(40, 48, 24);
      const bake = new THREE.Mesh(bakeGeo, skyMat);
      es.add(bake);
      skyUniforms.uBake.value = 1;
      skyUniforms.uSun.value.copy(sunBase);
      envRT = pm.fromScene(es, 0.015, 0.1, 100);
      envTexture = envRT.texture;
      skyUniforms.uBake.value = 0;
      pm.dispose();
      bakeGeo.dispose();
    } catch (e) {
      console.warn('[atmosphere] PMREM недоступен, без IBL:', e);
      envTexture = null;
    }
  }
  if (envTexture) {
    scene.environment = envTexture;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.25;
  }
  const envMats = []; // материалы со своим envMap: им вращение окружения ставим сами
  function useEnv(mat, intensity) {
    if (!envTexture || !mat) return;
    mat.envMap = envTexture;
    mat.envMapIntensity = intensity;
    if (!envMats.includes(mat)) envMats.push(mat);
  }
  // [HERO] снять материал с учёта (герой сменился/удалён) — иначе материалы героев копятся в envMats
  function releaseEnv(mat) { const i = envMats.indexOf(mat); if (i >= 0) envMats.splice(i, 1); }

  /* ----------------------------- Световые столбы ----------------------------- */
  const rays = new THREE.Group();
  rays.name = 'god-rays';
  parent.add(rays);
  const rayUniforms = { uColor: { value: P.key.clone() }, uIntensity: { value: 0.085 }, uTime: skyUniforms.uTime, uAxis: { value: keyBase.clone() } };
  const rayMat = Mx(new THREE.ShaderMaterial({
    uniforms: rayUniforms, vertexShader: RAY_VERT, fragmentShader: RAY_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  }));
  // Точки падения в системе «затмение на -Z», метры; поворачиваются вместе с затмением.
  const RAY_SPOTS = [[-5.5, -7.5, 1.8], [4.5, -10.5, 2.4], [9.5, -4.0, 1.6], [-10.5, -2.5, 2.1]];
  const rayMeshes = [];
  const up = new THREE.Vector3(0, 1, 0);
  const keyLocal = dirFrom(180, ECLIPSE.keyElevation);
  for (const [x, z, r] of RAY_SPOTS) {
    const len = 34;
    const g = new THREE.CylinderGeometry(r * 1.9, r, len, 18, 1, true);
    const m = new THREE.Mesh(Gx(g), rayMat);
    m.quaternion.setFromUnitVectors(up, keyLocal);
    m.position.set(x, 0, z).addScaledVector(keyLocal, len / 2);
    m.renderOrder = 4;
    m.frustumCulled = false;
    rays.add(m);
    rayMeshes.push(m);
  }
  const raysBaseYaw = deg(ECLIPSE.azimuth - 180);

  /* --------------------------- [W3-КИНО] Низовая дымка --------------------------- */
  // Три диска (слоя) в одной геометрии, снизу вверх: drawRange по уровню качества отсекает верхние.
  const HZ = {
    x: Number.isFinite(haze && haze.x) ? haze.x : 0, y: Number.isFinite(haze && haze.y) ? haze.y : 0,
    z: Number.isFinite(haze && haze.z) ? haze.z : 0, r: Number.isFinite(haze && haze.radius) && haze.radius > 0 ? haze.radius : 13,
  };
  // слои: высоты над полом, плотность, октавы шума
  const HAZE_TIERS = {
    low: { n: 1, oct: 2, y: [0.3, 0, 0], a: [0.3, 0, 0] },
    medium: { n: 2, oct: 3, y: [0.16, 0.48, 0], a: [0.24, 0.19, 0] },
    high: { n: 3, oct: 4, y: [0.12, 0.35, 0.7], a: [0.2, 0.17, 0.13] },
  };
  const HSEG = 40, HLAY = 3;
  const hazeGeo = new THREE.BufferGeometry();
  {
    const nv = HLAY * (HSEG + 1);
    const pos = new Float32Array(nv * 3), lay = new Float32Array(nv), idx = [];
    for (let l = 0; l < HLAY; l++) {
      const b = l * (HSEG + 1);
      pos[b * 3] = HZ.x; pos[b * 3 + 1] = HZ.y; pos[b * 3 + 2] = HZ.z; lay[b] = l;
      for (let s = 0; s < HSEG; s++) {
        const a = (s / HSEG) * TAU, v = b + 1 + s;
        pos[v * 3] = HZ.x + Math.cos(a) * HZ.r; pos[v * 3 + 1] = HZ.y; pos[v * 3 + 2] = HZ.z + Math.sin(a) * HZ.r;
        lay[v] = l;
        idx.push(b, b + 1 + ((s + 1) % HSEG), v);
      }
    }
    hazeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    hazeGeo.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1));
    hazeGeo.setIndex(idx);
    hazeGeo.computeBoundingSphere();
    if (hazeGeo.boundingSphere) hazeGeo.boundingSphere.radius += 1;
  }
  const hazeIdxPerLayer = HSEG * 3;
  const hazeUniforms = {
    uTime: skyUniforms.uTime, uSun: skyUniforms.uSun,
    uCenter: { value: new THREE.Vector3(HZ.x, HZ.y, HZ.z) }, uRadius: { value: HZ.r }, uOct: { value: 3 },
    uLayerY: { value: new THREE.Vector3() }, uLayerA: { value: new THREE.Vector3() },
    uHazeA: { value: P.hazeCold.clone() }, uHazeB: { value: P.hazeColdGlow.clone() },
  };
  const hazeMat = Mx(new THREE.ShaderMaterial({
    uniforms: hazeUniforms, vertexShader: HAZE_VERT, fragmentShader: HAZE_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  const hazeMesh = new THREE.Mesh(Gx(hazeGeo), hazeMat);
  hazeMesh.name = 'ground-haze';
  hazeMesh.renderOrder = -1;   // раньше прочих прозрачных: заклинания и трещины лавы — поверх дымки
  parent.add(hazeMesh);
  const hazeAlpha = [0, 0, 0];
  const _hc = new THREE.Color();

  /* --------------------------- Rim и заполняющий свет --------------------------- */
  const keyView = { x: 0, y: 0, z: 1 };
  const rimGroups = {
    hero: {
      // [HERO] герой отделяется от тёмной арены: контровая кромка ярче и чуть уже, заполняющий свет сильнее
      rim: col(0xc8d8f0), fill: col(0x9db0c8), under: col(0x000000),
      p: { x: 4.0, y: 0.62, z: 0.55, w: 0 }, underH: { value: 1 },
    },
    boss: {
      rim: col(0xff5a3c), fill: col(0x8e9bb0), under: col(0xff3d2e),
      p: { x: 2.5, y: 0.45, z: 0.18, w: 0.08 }, underH: { value: 4.5 },
    },
    far: {
      rim: col(0xb9c9e6), fill: col(0x000000), under: col(0x000000),
      p: { x: 3.0, y: 0.55, z: 0, w: 0 }, underH: { value: 1 },
    },
  };
  for (const g of Object.values(rimGroups)) {
    g.uniforms = {
      ashRimColor: { value: g.rim }, ashFillColor: { value: g.fill }, ashUnderColor: { value: g.under },
      ashRimP: { value: g.p }, ashUnderH: g.underH, ashKeyView: { value: keyView },
    };
  }
  const RIM_PARS = /* glsl */`
uniform vec3 ashRimColor;
uniform vec3 ashFillColor;
uniform vec3 ashUnderColor;
uniform vec4 ashRimP;
uniform float ashUnderH;
uniform vec3 ashKeyView;
varying vec3 vAshWorldPos;`;
  const WORLDPOS_VERT = /* glsl */`
  {
    vec4 ashWP = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      ashWP = instanceMatrix * ashWP;
    #endif
    vAshWorldPos = ( modelMatrix * ashWP ).xyz;
  }`;
  function patchLit(mat, kind) {
    const grp = rimGroups[kind];
    if (!mat || !grp || mat.userData.ashRim) return;
    mat.userData.ashRim = kind;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      if (prev) prev.call(mat, shader, r);
      Object.assign(shader.uniforms, grp.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAshWorldPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>' + WORLDPOS_VERT);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>' + RIM_PARS)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 ashV = normalize( vViewPosition );
    float ashNV = saturate( dot( normal, ashV ) );
    float ashFres = pow( 1.0 - ashNV, ashRimP.x );
    float ashKey = saturate( dot( normal, ashKeyView ) * 0.5 + 0.5 );
    totalEmissiveRadiance += ashRimColor * ashFres * ashRimP.y * ( 0.2 + 0.8 * ashKey );
    totalEmissiveRadiance += diffuseColor.rgb * ashFillColor * ashRimP.z * ( 0.35 + 0.65 * ashNV );
    vec3 ashWN = inverseTransformDirection( normal, viewMatrix );
    float ashUp = 1.0 - smoothstep( 0.0, ashUnderH, vAshWorldPos.y );
    totalEmissiveRadiance += diffuseColor.rgb * ashUnderColor * ashRimP.w * ashUp * ( 0.35 + 0.65 * saturate( - ashWN.y ) );
  }`);
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => 'ashRim:' + kind + ':' + (prevKey ? prevKey.call(mat) : '');
    mat.needsUpdate = true;
  }
  // Unlit-силуэты (колоссы): кромка со стороны затмения поверх заранее смешанного с туманом цвета.
  function patchUnlit(mat) {
    const grp = rimGroups.far;
    if (!mat || mat.userData.ashRim) return;
    mat.userData.ashRim = 'far';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, grp.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAshN;\nvarying vec3 vAshV;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vAshN = normalize( normalMatrix * normal );\n  vAshV = - mvPosition.xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 ashRimColor;\nuniform vec4 ashRimP;\nuniform vec3 ashKeyView;\nvarying vec3 vAshN;\nvarying vec3 vAshV;')
        .replace('#include <opaque_fragment>', `{
    vec3 ashN = normalize( vAshN );
    float ashNV = saturate( abs( dot( ashN, normalize( vAshV ) ) ) );
    float ashKey = saturate( dot( ashN, ashKeyView ) );
    outgoingLight += ashRimColor * pow( 1.0 - ashNV, ashRimP.x ) * ashRimP.y * ashKey;
  }
  #include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'ashRimFar';
    mat.needsUpdate = true;
  }

  /* ------------------------------ Молнии и вспышки ------------------------------ */
  // [W3-КИНО] flash(amount, bolt): свечение у горизонта рядом с затмением (в кадре) и ключ/небо через skyFlash;
  // bolt = true — ещё и видимый разряд (не в reducedMotion; на low останется только свечение облаков).
  function flash(amount = 1, bolt = false) {
    const a = clamp(Number(amount) || 0, 0, 1);
    state.strike = Math.max(state.strike, a * (state.reduced ? 0.35 : 1));   // reducedMotion — мягко
    if (a <= 0 || state.flashT > 0) return;
    if (bolt && !state.reduced) startFlash(0.7 + 0.5 * a, true, true);
    else aimFlash(true);
  }
  // [W3-КИНО] куда бьёт молния: фаза 1 — широкий сектор вокруг затмения, фаза 2 и flash() — в кадре рядом с боссом.
  // Свечение облака — у верха разряда; ey — тангенс высоты верха.
  function aimFlash(near) {
    const R = look.red;
    const close = near || R > 0.5;
    const side = rnd() < 0.5 ? -1 : 1;
    const off = close ? side * (10 + rnd() * 30) : -70 + rnd() * 140;
    const a = deg(ECLIPSE.azimuth + off) + state.follow;
    const ey = close ? 0.2 + rnd() * 0.14 : 0.14 + rnd() * 0.16;
    skyUniforms.uFlashDir.value.set(Math.sin(a), ey - 0.02, Math.cos(a)).normalize();
    const sd = skyUniforms.uBoltSeed.value;
    sd.x = rnd() * 500; sd.z = ey; sd.w = rnd() < 0.5 ? -1 : 1;
  }
  function startFlash(amp, bolt, near) {
    state.flashT = 0.0001;
    state.flashAmp = amp;
    state.bolt = !!bolt;
    aimFlash(near);
  }

  /* ---------------------------------- update ---------------------------------- */
  const _v = new THREE.Vector3(), _m3 = new THREE.Matrix3();
  function update(dt, info = {}) {
    if (state.disposed) return;
    state.time += dt;
    const t = state.time;
    skyUniforms.uTime.value = state.reduced ? t * 0.3 : t;
    // Затмение частично следует за камерой вокруг босса: главный кадр «камера → герой → босс → затмение».
    if (camera) {
      const bx = info.bossX || 0, bz = info.bossZ || 0;
      const ang = Math.atan2(camera.position.x - bx, camera.position.z - bz);
      if (state.orbitPrev === null) state.orbitPrev = ang;
      state.orbit += wrapAngle(ang - state.orbitPrev);
      state.orbitPrev = ang;
      state.followTarget = state.orbit * ECLIPSE.follow;
      state.follow += (state.followTarget - state.follow) * dampK(info.snap ? 30 : 2.2, dt);
      sky.position.copy(camera.position);
      sea.position.x = camera.position.x; sea.position.z = camera.position.z;
    }
    const yaw = state.follow;
    sunDir.copy(sunBase).applyAxisAngle(up, yaw);
    keyDir.copy(keyBase).applyAxisAngle(up, yaw);
    skyUniforms.uSun.value.copy(sunDir);
    fogA.x = sunDir.x; fogA.y = sunDir.y; fogA.z = sunDir.z;
    rays.rotation.y = yaw + raysBaseYaw;
    rayUniforms.uAxis.value.copy(keyDir);
    if (scene.environmentRotation) scene.environmentRotation.y = yaw;
    for (const m of envMats) if (m.envMapRotation) m.envMapRotation.y = yaw;
    if (camera) {
      _v.copy(keyDir).transformDirection(camera.matrixWorldInverse);
      keyView.x = _v.x; keyView.y = _v.y; keyView.z = _v.z;
    }

    // Фазы боя (Библия, разд. 5): фаза 2 краснит корону и низ тумана, победа — рассвет.
    const status = info.status || 'playing';
    const redT = status === 'victory' ? 0 : clamp(info.stageW || 0, 0, 1);
    const dawnT = status === 'victory' ? 1 : 0;
    const darkT = status === 'defeat' ? 1 : 0;
    // [W3-КИНО] толчок фазы (setPhaseBoost): держится boostHold с, затем отпускается; фаза догоняет быстрее
    if (state.boostHold > 0) { state.boostHold -= dt; if (state.boostHold <= 0) state.boostT = 0; }
    state.boost += (state.boostT - state.boost) * dampK(state.boostT > state.boost ? 9 : 1.4, dt);
    if (state.boostT === 0 && state.boost < 1e-3) state.boost = 0;
    state.red += (redT - state.red) * dampK(0.5 + 5 * state.boost, dt);
    state.dawn += (dawnT - state.dawn) * dampK(0.35, dt);
    state.dark += (darkT - state.dark) * dampK(0.6, dt);
    const R = Math.max(state.red, state.boost);   // [W3-КИНО] действующая «ярость» неба
    const cor = skyUniforms.uCorona.value.copy(P.corona).lerp(P.coronaRed, R * 0.85).lerp(P.coronaDawn, state.dawn);
    skyUniforms.uCoronaI.value = (1 + state.dawn * 1.6) * (1 - state.dark * 0.45);
    skyUniforms.uBead.value = state.dawn;
    skyUniforms.uDiscR.value = deg(ECLIPSE.discRadius) * (1 - state.dawn * 0.12);
    const fb = skyUniforms.uFogBase.value.copy(P.fogBase).lerp(P.fogBaseRed, R * 0.85).lerp(P.fogDawn, state.dawn * 0.6);   // [W3-КИНО] багровый воздух фазы 2
    fb.multiplyScalar(1 - state.dark * 0.35);
    if (state.clear > 0) fb.lerp(P.fogClear, state.clear * 0.5);
    fog.color.copy(fb);
    scene.background && scene.background.isColor && scene.background.copy(fb);
    fogA.w = FOG.density * (1 - state.dawn * 0.5) * (1 - 0.45 * state.clear);
    fogLow.w = R * 0.8 * (1 - state.dawn);
    skyUniforms.uFogLow.value.w = fogLow.w;
    rayUniforms.uColor.value.copy(cor).multiplyScalar(0.8).lerp(P.key, 0.4);
    rayUniforms.uIntensity.value = 0.085 * (1 + state.dawn * 1.5) * (1 - state.dark * 0.5);
    rimGroups.boss.p.w = lerp(0.08, 0.35, R);

    // [BDO] настроение зоны поверх фаз: небо, туман, ключ, IBL и экспозиция
    mood.w += (mood.target - mood.w) * dampK(state.reduced ? 2.4 : 1.35, dt);
    if (Math.abs(mood.w - mood.target) < 1e-3) mood.w = mood.target;
    const mw = mood.w;
    // [W3-КИНО] фаза 2: тёмно-кровавый верх, тлеющий горизонт, раскалённое зарево вокруг затмения
    skyUniforms.uDomeLow.value.copy(P.domeLow).lerp(P.domeLowRed, R).lerp(mood.horizon, mw);
    skyUniforms.uDomeHigh.value.copy(P.domeHigh).lerp(P.domeHighRed, R).lerp(mood.top, mw);
    skyUniforms.uDomeCorona.value.copy(P.domeCorona).lerp(P.domeCoronaRed, R).lerp(mood.corona, mw * 0.6);
    skyUniforms.uSunDisc.value = mood.sunDisc * mw;
    if (mw > 0) {
      fb.lerp(mood.fogColor, mw);
      fog.color.copy(fb);
      scene.background && scene.background.isColor && scene.background.copy(fb);
      fogA.w = lerp(fogA.w, mood.fogDensity, mw);
      cor.lerp(mood.corona, mw);
      skyUniforms.uCoronaI.value = lerp(skyUniforms.uCoronaI.value, mood.coronaI, mw);
      fogLow.w *= 1 - mw;
      skyUniforms.uFogLow.value.w = fogLow.w;
      rayUniforms.uIntensity.value *= 1 + mw * 1.2;
    }
    const fg = skyUniforms.uFogGlow.value.copy(P.fogGlow).lerp(P.fogGlowRed, R * 0.8).lerp(mood.fogGlow, mw);
    // [W3-КИНО] золото короны и кромок облаков (в лесу — как раньше), зарево под облаками в фазе 2
    skyUniforms.uGold.value.copy(P.gold).lerp(P.goldRed, R).lerp(P.coronaDawn, state.dawn);
    skyUniforms.uGoldK.value = (1 - mw) * (1 - state.dark * 0.5);
    skyUniforms.uCloudUnder.value.copy(P.cloudUnderRed).multiplyScalar(0.6 * R * (1 - state.dawn) * (1 - mw));
    const flc = skyUniforms.uFlashCol.value.copy(P.flashCol).lerp(P.flashColRed, R);
    skyUniforms.uBoltCore.value.copy(P.boltCore).lerp(P.boltCoreRed, R);
    skyUniforms.uBoltGlow.value.copy(P.boltGlow).lerp(P.boltGlowRed, R);
    fogGlow.x = fg.r; fogGlow.y = fg.g; fogGlow.z = fg.b;
    if (envTexture && 'environmentIntensity' in scene && scene.environment === envTexture) scene.environmentIntensity = 0.25 * lerp(1, mood.env, mw);
    if (renderer) renderer.toneMappingExposure = baseExposure * lerp(1, mood.exposure, mw);
    const MG = ZONE_MOOD_STATE.grade, gg = mood.grade;
    ZONE_MOOD_STATE.w = mw;
    for (let i = 0; i < 3; i++) { MG.shadow[i] = gg.shadow[i] * mw; MG.high[i] = gg.high[i] * mw; }
    MG.sat = lerp(1, gg.sat, mw); MG.contrast = gg.contrast * mw;

    // Молния раз в 20–40 с (не в reducedMotion: вспышки — риск для светочувствительных).
    // [W3-КИНО] в фазе 2 — каждые 2,5–7 с (по силе R), с видимым разрядом.
    look.red = R;
    if (!state.reduced) {
      state.nextFlash = Math.min(state.nextFlash, lerp(40, 8, R));
      state.nextFlash -= dt;
      if (state.nextFlash <= 0 && state.flashT === 0) {
        state.nextFlash = lerp(20, 2.5, R) + rnd() * lerp(20, 4.5, R);
        startFlash(1 + 0.25 * R, true, false);
      }
    }
    let fl = 0;
    if (state.flashT > 0) {
      state.flashT += dt;
      const ft = state.flashT;
      fl = (Math.exp(-Math.pow((ft - 0.04) / 0.03, 2)) + 0.7 * Math.exp(-Math.pow((ft - 0.13) / 0.035, 2))) * state.flashAmp;
      if (ft > 0.3) { state.flashT = 0; state.bolt = false; }
    }
    const strikeSky = state.strike;
    // [W3-КИНО] разряд: не на low и не в reducedMotion; ширина ядра — угловой размер пикселя.
    // С разрядом свечение облака слабее: иначе белое пятно съедает сам канал.
    const boltOn = state.bolt && state.quality !== 'low' && !state.reduced;
    skyUniforms.uFlash.value = fl * (boltOn ? 0.6 : 1.4 - 0.5 * R) + strikeSky * 0.9;
    skyUniforms.uStrike.value = strikeSky;
    skyUniforms.uBolt.value = boltOn ? fl * (1 - mw) : 0;
    if (boltOn && camera && camera.isPerspectiveCamera) {
      const hpx = renderer && renderer.domElement && renderer.domElement.height > 0 ? renderer.domElement.height : 720;
      skyUniforms.uBoltSeed.value.y = (2 * Math.tan(deg(camera.fov) / 2)) / (hpx * (camera.zoom || 1)) * 0.8;
    }

    // [W3-КИНО] низовая дымка: цвет по фазе, молния подсвечивает, в лесу гаснет (вес настроения)
    hazeMesh.visible = state.hazeN > 0 && mw < 0.98;
    if (hazeMesh.visible) {
      const dk = 1 - state.dark * 0.45;
      const ha = hazeUniforms.uHazeA.value.copy(P.hazeCold).lerp(P.hazeEmber, R).lerp(P.hazeDawn, state.dawn).multiplyScalar(dk);
      const hb = hazeUniforms.uHazeB.value.copy(P.hazeColdGlow).lerp(P.hazeEmberGlow, R).lerp(P.hazeDawnGlow, state.dawn).multiplyScalar(dk);
      const lf = fl * 0.35 + state.strike * 0.25;
      if (lf > 0.001) { _hc.copy(flc).multiplyScalar(lf); ha.add(_hc); hb.add(_hc); }
      const hk = (1 - mw) * (1 + 0.25 * R);
      hazeUniforms.uLayerA.value.set(hazeAlpha[0] * hk, hazeAlpha[1] * hk, hazeAlpha[2] * hk);
    }

    state.strike *= Math.exp(-dt / 0.06);
    look.dawn = state.dawn; look.dark = state.dark; look.zone = mw;
    const lf2 = Math.max(fl, state.strike);
    look.flash = lf2 < 1e-3 ? 0 : clamp(lf2, 0, 1);
    const keyCol = _keyCol.copy(P.key).lerp(P.coronaRed, R * 0.3).lerp(P.keyDawn, state.dawn).lerp(mood.sunColor, mw);
    return {
      keyColor: keyCol,
      keyIntensity: 3.0 * (1 + state.dawn) * (1 - state.dark * 0.4) * lerp(1, mood.sunI, mw),
      skyFlash: fl * 0.25 + state.strike * 0.4,
    };
  }
  const _keyCol = new THREE.Color();

  function setQuality(q) {
    state.quality = q;
    rayMeshes.forEach((m, i) => { m.visible = q === 'low' ? i < 2 : true; });
    // [W3-КИНО] дымка: слоёв и октав шума по уровню (low — один дешёвый слой)
    const ht = HAZE_TIERS[q] || HAZE_TIERS.medium;
    state.hazeN = ht.n;
    hazeGeo.setDrawRange(0, ht.n * hazeIdxPerLayer);
    hazeUniforms.uOct.value = ht.oct;
    hazeUniforms.uLayerY.value.set(ht.y[0], ht.y[1], ht.y[2]);
    for (let i = 0; i < 3; i++) hazeAlpha[i] = ht.a[i];
  }
  // [W3-КИНО] временный толчок к багровому небу (сцена перехода в фазу 2): k 0..1, hold — сколько секунд держать
  function setPhaseBoost(k = 0, hold = 2.5) {
    const v = clamp(Number(k) || 0, 0, 1);
    state.boostT = v;
    state.boostHold = v > 0 ? Math.max(0.05, Number.isFinite(hold) ? hold : 2.5) : 0;
  }
  function configure(patch = {}) {
    if ('reducedMotion' in patch) state.reduced = !!patch.reducedMotion;
  }
  // [ASHEN_V3] местное прояснение воздуха (0 — как везде, 1 — центр эльфийской деревни)
  function setLocalClear(k) { state.clear = clamp(Number(k) || 0, 0, 1); }

  // [BDO] настроение зоны для №5 [FOREST] (см. ZONE_MOODS выше). Можно звать каждый кадр:
  // цвета перечитываются только если объект настроения сменился (или передан новый).
  let moodSrc = null;
  const setCol = (dst, v, fallback) => {
    try {
      if (v && v.isColor) dst.copy(v);
      else if (typeof v === 'number' || typeof v === 'string') dst.set(v);
      else dst.set(fallback);
    } catch (e) { dst.set(fallback); }
  };
  const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const vec3Or = (v, d) => (Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(x)) ? v : d);
  function setZoneMood(m) {
    if (!m || typeof m !== 'object') { mood.target = 0; return; }
    mood.target = clamp(numOr(m.weight, 1), 0, 1);
    if (m === moodSrc && !m.dirty) return;
    moodSrc = m;
    const D = ZONE_MOODS.brightForest;
    const sky = m.sky || {}, fg = m.fog || {}, sun = m.sun || {}, gr = m.grade || {};
    setCol(mood.top, sky.top, D.sky.top);
    setCol(mood.horizon, sky.horizon, D.sky.horizon);
    setCol(mood.corona, sky.corona, D.sky.corona);
    mood.coronaI = numOr(sky.coronaIntensity, D.sky.coronaIntensity);
    mood.sunDisc = clamp(numOr(sky.sunDisc, D.sky.sunDisc), 0, 1);
    setCol(mood.fogColor, fg.color, D.fog.color);
    setCol(mood.fogGlow, fg.glow, D.fog.glow);
    mood.fogDensity = Math.max(0, numOr(fg.density, D.fog.density));
    setCol(mood.sunColor, sun.color, D.sun.color);
    mood.sunI = Math.max(0, numOr(sun.intensity, D.sun.intensity));
    mood.env = Math.max(0, numOr(sun.env, D.sun.env));
    mood.exposure = clamp(numOr(m.exposure, D.exposure), 0.2, 4);
    mood.grade.shadow = vec3Or(gr.shadow, D.grade.shadow).slice(0, 3);
    mood.grade.high = vec3Or(gr.high, D.grade.high).slice(0, 3);
    mood.grade.sat = numOr(gr.sat, D.grade.sat);
    mood.grade.contrast = numOr(gr.contrast, D.grade.contrast);
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    if (SC) for (const k of chunkKeys) if (prevChunks[k] !== undefined) SC[k] = prevChunks[k];
    for (const u of patchedLibs) { delete u.ashFogA; delete u.ashFogB; delete u.ashFogGlow; delete u.ashFogLow; }
    if (scene.fog === fog) { scene.fog = prevFog || null; scene.background = prevBg || null; }
    if (scene.environment === envTexture) {
      scene.environment = prevEnv || null;
      if ('environmentIntensity' in scene && prevEnvI !== undefined) scene.environmentIntensity = prevEnvI;
      if (scene.environmentRotation) scene.environmentRotation.y = prevEnvRotY;
    }
    if (renderer) renderer.toneMappingExposure = baseExposure;
    ZONE_MOOD_STATE.w = 0;
    if (envRT) envRT.dispose();
    for (const o of [sky, sea, rays, hazeMesh]) if (o.parent) o.parent.remove(o);
    if (!G) { sky.geometry.dispose(); sea.geometry.dispose(); rayMeshes.forEach((m) => m.geometry.dispose()); hazeGeo.dispose(); }
    if (!M) { skyMat.dispose(); seaMat.dispose(); rayMat.dispose(); hazeMat.dispose(); }
  }

  setQuality(quality);
  return {
    sunDir, keyDir, sunBase, keyBase, skyRadius, get envTexture() { return envTexture; },
    fogColor: fog.color, useEnv, releaseEnv, patchLit, patchUnlit, flash, update, setQuality, configure, dispose, setLocalClear,
    setZoneMood, get zoneMood() { return mood.w; },  // [BDO]
    get yaw() { return state.follow; },
    get look() { return look; }, setPhaseBoost, haze: hazeMesh,   // [W3-КИНО]
  };
}
