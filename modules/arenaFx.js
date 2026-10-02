/*
 * ASHEN OATH — arenaFx.js  [W4-ARENA]
 * Огни и воздух арены Регента, отражения на мокром полу.
 *
 * export function createArenaFx({ THREE, parent, G, M, renderer, fires, ruins, groundY, materials, LI, quality, reducedMotion, seed })
 *   -> { update(dt, time, ctx), setQuality(level, lights?), configure(patch), patchLit(mat, kind), dispose(), stats(), fires }
 *
 *   Жаровни и факелы-столпы — инстансы: подножие (камень), железо (чаша с когтями), угли — 3 вызова отрисовки на все огни.
 *   Живой огонь — процедурный шейдер: пламя, ореол и дым (high) — один вызов на все огни.
 *   Воздух — искры огней, плавающие угли и мотыльки света у руин: одни GPU-точки (физика в вершинном шейдере),
 *     число по уровню качества — drawRange по ярусам, без перестройки буферов.
 *   Свет — общий пул PointLight (low 0, medium 2, high 4: столько же, сколько было у жаровен), едет к ближайшим
 *     к герою огням с плавной передачей; число видимых источников меняется только со сменой качества.
 *   Пол — patchLit(mat): блики огней штрихами (как на мокрой мостовой), лужицы тепла там, где нет настоящего
 *     источника, отсвет кольца рун, отражение короны затмения в лужах. Всё в шейдере пола — новых проходов нет.
 * Модуль ничего не рендерит, камеру не трогает, в кадре не аллоцирует. Материалы и геометрии — через G/M владельца.
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const normQ = (l) => (l === 'low' || l === 'high' ? l : 'medium');
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIRE_MAX = 12;   // столько огней видит шейдер пола (uniform-массивы фиксированной длины)
// Уровни качества: ярусы частиц (0 — всегда, 1 — medium+, 2 — high), свет пула, штрихи-отражения, дым.
export const ARENA_FX_QUALITY = Object.freeze({
  low: Object.freeze({ tier: 0, lights: 0, refl: 0, smoke: false }),
  medium: Object.freeze({ tier: 1, lights: 2, refl: 1, smoke: false }),
  high: Object.freeze({ tier: 2, lights: 4, refl: 1, smoke: true }),
});
// Частицы по ярусам: [ярус 0, +ярус 1, +ярус 2]
const SPARKS = [3, 4, 5];     // на огонь
const EMBERS = [40, 80, 120]; // на арену
const MOTHS = [14, 18, 24];   // у руин

// Мерцание огня — одна формула для шейдера пламени и для света пула (свет «дышит» вместе с языками)
const flicker = (t, s) => 0.84 + 0.09 * Math.sin(t * 11.3 + s * 6.0) + 0.07 * Math.sin(t * 23.7 + s * 12.6);
const FLICKER_GLSL = 'float aFlick( float t, float s ) { return 0.84 + 0.09 * sin( t * 11.3 + s * 6.0 ) + 0.07 * sin( t * 23.7 + s * 12.6 ); }';

const NOISE_GLSL = /* glsl */`
float aH( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float aVN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( aH( i ), aH( i + vec2( 1.0, 0.0 ) ), u.x ), mix( aH( i + vec2( 0.0, 1.0 ) ), aH( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}`;

/* --------------------------------- Пламя --------------------------------- */
// Квад на огонь: тип 0 — язык пламени (цилиндрический билборд), 1 — ореол (к камере), 2 — дым над огнём (high).
// Смешивание премультиплицированное: пламя и ореол — аддитивно (альфа 0), дым — затемняет (альфа > 0).
const FLAME_VERT = /* glsl */`
attribute vec4 aFire;   // xyz — основание пламени, w — зерно
attribute vec2 aSize;   // ширина, высота языка
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
varying float vType;
varying float vFade;
varying float vFlick;
${FLICKER_GLSL}
void main() {
  float type = position.z;
  vec3 c = aFire.xyz;
  vSeed = aFire.w;
  vType = type;
  vUv = vec2( position.x + 0.5, position.y );
  vFlick = aFlick( uTime, vSeed );
  vec3 toCam = cameraPosition - c;
  float dist = length( toCam );
  // вблизи камеры огонь занимает пол-экрана — HDR-ядро гасим, иначе bloom заливает угол кадра
  vFade = smoothstep( 0.6, 1.6, dist ) * exp( - dist * 0.0045 ) * mix( 0.45, 1.0, smoothstep( 3.0, 14.0, dist ) );
  vec4 mv;
  if ( type > 0.5 && type < 1.5 ) {
    // ореол: круглый билборд к камере на середине языка
    mv = viewMatrix * vec4( c + vec3( 0.0, aSize.y * 0.4, 0.0 ), 1.0 );
    mv.xy += vec2( position.x, position.y - 0.5 ) * aSize.x * 3.4 * ( 0.92 + 0.08 * vFlick );
  } else {
    vec3 side = normalize( vec3( toCam.z, 0.0, - toCam.x ) + vec3( 1e-4, 0.0, 0.0 ) );
    float w = aSize.x, h = aSize.y, y0 = 0.0;
    if ( type > 1.5 ) { w *= 1.7; y0 = h * 0.62; h *= 2.6; }
    else h *= 0.9 + 0.12 * vFlick;
    vec3 wp = c + side * position.x * w + vec3( 0.0, y0 + position.y * h, 0.0 );
    // язык чуть к камере: не тонет в дальнем крае чаши
    wp += normalize( vec3( toCam.x, 0.0, toCam.z ) + vec3( 1e-4, 0.0, 0.0 ) ) * ( type > 1.5 ? 0.0 : 0.06 );
    mv = viewMatrix * vec4( wp, 1.0 );
  }
  gl_Position = projectionMatrix * mv;
}`;
const FLAME_FRAG = /* glsl */`
uniform float uTime;
uniform float uFireK;
varying vec2 vUv;
varying float vSeed;
varying float vType;
varying float vFade;
varying float vFlick;
${NOISE_GLSL}
void main() {
  float s = vSeed * 17.0;
  vec4 outC;
  if ( vType < 0.5 ) {
    vec2 uv = vec2( vUv.x - 0.5, vUv.y );
    vec2 q = vec2( uv.x * 3.0, uv.y * 2.2 - uTime * 2.6 );
    float n = aVN( q * 1.7 + s ) * 0.62 + aVN( q * 3.9 + s * 1.3 + 4.1 ) * 0.38;
    float y = uv.y;
    float x = uv.x + ( n - 0.5 ) * 0.34 * y + sin( uTime * 3.1 + s ) * 0.045 * y;
    float w = 0.36 * pow( max( 1.0 - y, 0.0 ), 0.6 ) * smoothstep( -0.04, 0.14, y );
    float body = smoothstep( w, w * 0.22, abs( x ) );
    float tongue = 1.0 - smoothstep( 0.28, 0.95, y + ( n - 0.5 ) * 0.6 );
    float f = body * tongue;
    float core = smoothstep( w * 0.55, 0.0, abs( x ) ) * ( 1.0 - smoothstep( 0.04, 0.5, y + ( n - 0.5 ) * 0.25 ) );
    vec3 col = mix( vec3( 0.95, 0.16, 0.02 ), vec3( 1.0, 0.5, 0.12 ), smoothstep( 0.0, 0.75, f ) );
    col = mix( col, vec3( 1.0, 0.86, 0.56 ), core );
    float I = ( f * 2.0 + core * 3.6 ) * vFlick * vFade * uFireK;
    outC = vec4( col * I, 0.0 );
  } else if ( vType < 1.5 ) {
    vec2 d = ( vUv - 0.5 ) * 2.0;
    float r2 = dot( d, d );
    float g = exp( - r2 * 4.5 ) * ( 1.0 - smoothstep( 0.55, 1.0, r2 ) );
    outC = vec4( vec3( 1.0, 0.42, 0.13 ) * g * 0.22 * vFlick * vFade * uFireK, 0.0 );
  } else {
    vec2 uv = vec2( vUv.x - 0.5, vUv.y );
    vec2 q = vec2( uv.x * 2.0, uv.y * 1.6 - uTime * 0.32 );
    float n = aVN( q * 2.2 + s ) * 0.6 + aVN( q * 4.7 + s + 9.0 ) * 0.4;
    float x = uv.x + ( n - 0.5 ) * 0.45 * uv.y + sin( uTime * 0.7 + s ) * 0.09 * uv.y;
    float wd = 0.12 + 0.3 * uv.y;
    float a = smoothstep( wd, wd * 0.15, abs( x ) ) * smoothstep( 0.0, 0.22, uv.y ) * ( 1.0 - smoothstep( 0.4, 1.0, uv.y ) ) * smoothstep( 0.32, 0.74, n );
    a *= 0.3 * vFade;
    vec3 sc = vec3( 0.045, 0.04, 0.042 ) + vec3( 0.32, 0.1, 0.03 ) * pow( 1.0 - uv.y, 3.0 ) * vFlick;
    outC = vec4( sc * a, a );
  }
  gl_FragColor = outC;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------------ Воздух (точки) ------------------------------ */
// aA: xyz — якорь, w — зерно; aB: x — вид (0 искра, 1 уголь, 2 мотылёк), y/z/w — параметры вида.
const AIR_VERT = /* glsl */`
attribute vec4 aA;
attribute vec4 aB;
uniform float uTime;
uniform float uMotion;
uniform float uViewH;
uniform float uWind;
varying vec3 vCol;
varying float vA;
varying float vKind;
varying float vFlap;
void main() {
  float kind = aB.x, s = aA.w;
  float t = uTime * uMotion;
  vec3 p;
  float size, a;
  vec3 col;
  vFlap = 1.0;
  if ( kind < 0.5 ) {
    // искра: вверх от пламени по спирали, ветер уносит, гаснет к концу жизни
    float ph = fract( uTime / aB.y + s );
    float ang = s * 40.0 + ph * 3.2;
    p = aA.xyz + vec3( sin( ang ) * 0.22 * ph + uWind * ph * ph * 0.7, ph * aB.z, cos( ang * 1.3 ) * 0.22 * ph );
    size = mix( 0.05, 0.014, ph );
    col = mix( vec3( 1.0, 0.72, 0.34 ) * 6.0, vec3( 1.0, 0.24, 0.05 ) * 2.2, ph );
    a = ( 1.0 - ph ) * smoothstep( 0.0, 0.06, ph ) * ( 0.6 + 0.4 * sin( uTime * 31.0 + s * 90.0 ) );
  } else if ( kind < 1.5 ) {
    // плавающий уголь: медленно всплывает, кружит, тлеет
    float ph = fract( t / aB.y + s );
    p = aA.xyz + vec3( sin( t * 0.31 + s * 7.0 ) * 1.1 + uWind * ph * 2.4, ph * aB.z, cos( t * 0.27 + s * 5.0 ) * 1.1 );
    p.x += sin( t * 1.7 + s * 13.0 ) * 0.1;
    p.z += cos( t * 1.3 + s * 11.0 ) * 0.1;
    size = 0.034 * aB.w;
    float fl = 0.55 + 0.45 * sin( uTime * ( 5.0 + s * 4.0 ) + s * 20.0 );
    col = vec3( 1.0, 0.4, 0.1 ) * ( 2.0 + 2.4 * fl );
    a = smoothstep( 0.0, 0.12, ph ) * ( 1.0 - smoothstep( 0.72, 1.0, ph ) );
  } else {
    // мотылёк света: петли вокруг руины, крылья трепещут, свечение «дышит»
    float tt = t * aB.y;
    p = aA.xyz + vec3( sin( tt * 0.9 + s * 6.0 ) * aB.z, sin( tt * 1.7 + s * 3.0 ) * 0.32 + sin( tt * 0.43 + s ) * 0.24, cos( tt * 0.7 + s * 4.0 ) * aB.z );
    p += vec3( sin( uTime * 9.0 + s * 30.0 ), cos( uTime * 11.0 + s * 20.0 ), sin( uTime * 7.0 + s * 9.0 ) ) * 0.025 * uMotion;
    size = 0.11 * aB.w;
    float blink = smoothstep( -0.3, 0.95, sin( t * 0.8 + s * 17.0 ) );
    col = mix( vec3( 0.5, 0.88, 1.0 ), vec3( 1.0, 0.84, 0.52 ), step( 0.7, fract( s * 7.31 ) ) ) * ( 1.8 + 3.2 * blink );
    a = 0.3 + 0.7 * blink;
    vFlap = sin( uTime * 17.0 * uMotion + s * 40.0 );
  }
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float d = max( - mv.z, 0.1 );
  float px = size * projectionMatrix[ 1 ][ 1 ] * uViewH * 0.5 / d;
  gl_PointSize = clamp( px * 2.2, 1.5, 48.0 );   // ×2,2 — запас под ореол вокруг ядра
  a *= smoothstep( 0.35, 1.2, px ) * exp( - d * 0.008 );
  vCol = col;
  vA = a;
  vKind = kind;
}`;
const AIR_FRAG = /* glsl */`
varying vec3 vCol;
varying float vA;
varying float vKind;
varying float vFlap;
void main() {
  vec2 c = ( gl_PointCoord - 0.5 ) * 2.2;
  float r2 = dot( c, c );
  float g;
  if ( vKind > 1.5 ) {
    float wing = 0.45 + 0.55 * abs( vFlap );
    vec2 q = vec2( ( abs( c.x ) - 0.34 * wing ) / ( 0.3 * wing + 0.06 ), c.y / 0.26 );
    g = exp( - r2 * 16.0 ) + exp( - dot( q, q ) ) * 0.42 + exp( - r2 * 2.6 ) * 0.2;
  } else g = exp( - r2 * 5.5 ) * ( 1.0 - smoothstep( 0.7, 1.0, r2 ) );
  gl_FragColor = vec4( vCol * ( g * vA ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------- Мокрый пол: свет огней и рун ------------------------- */
// Встраивается после <lights_fragment_end> в материалы, где уже есть vAshWorldPos и ashPud (patchWet / земля).
// ARENA_TIER (define, ключ программы): 0 — low: только лужицы тепла ближних огней и отсвет рун; 1 — medium: + блики
// огней штрихами и корона затмения в лужах; 2 — high: + резкое отражение неба в лужах. Смена уровня и так
// перекомпилирует освещённые материалы (меняется число источников пула), лишних компиляций нет.
export const ARENA_LIGHT_PARS = /* glsl */`
uniform vec4 uAFire[ ${FIRE_MAX} ];
uniform float uAFireA[ ${FIRE_MAX} ];
uniform vec3 uAFireCol;
uniform float uAFireN;
uniform vec4 uRuneW[ 4 ];
uniform vec4 uRuneC[ 4 ];
uniform vec3 uRuneBase;
uniform float uARuneR;
uniform vec3 uASun;
uniform vec3 uACorona;
uniform float uACoronaI;
uniform float uADiscR;
uniform float uAWet;`;
const ARENA_LIGHT_BODY = /* glsl */`
  {
    vec3 aP = vAshWorldPos;
    vec3 aN = inverseTransformDirection( normal, viewMatrix );
    vec3 aV = normalize( cameraPosition - aP );
    vec3 aR = reflect( - aV, aN );
    float aNV = saturate( dot( aN, aV ) );
    float aFres = 0.02 + 0.98 * pow( 1.0 - aNV, 5.0 );
    float aWetK = saturate( ashPud );
    vec3 aDiff = vec3( 0.0 );
    vec3 aSpec = vec3( 0.0 );
    float aSh0 = mix( 0.08, 0.014, aWetK );
    for ( int i = 0; i < ${FIRE_MAX}; i ++ ) {
      if ( float( i ) >= uAFireN ) break;
      vec4 f = uAFire[ i ];
      vec3 d = f.xyz - aP;
      float d2 = dot( d, d );
      #if ARENA_TIER == 0
        if ( d2 > 56.0 ) continue;   // low: только лужица тепла, за 7,5 м её нет
      #else
        if ( d2 > 784.0 ) continue;
      #endif
      float dl = sqrt( d2 );
      vec3 dn = d / dl;
      // лужица тепла: рассеянный свет огня (если его не освещает настоящий источник из пула)
      float nl = saturate( dot( aN, dn ) * 0.75 + 0.25 );
      aDiff += f.w * uAFireA[ i ] * nl / ( 1.0 + d2 * 0.6 ) * ( 1.0 - smoothstep( 30.0, 56.0, d2 ) );
      // блик-штрих: зеркальное отражение пламени, по вертикали вытянуто (мокрая мостовая)
      #if ARENA_TIER >= 1
      {
        float c = dot( aR, dn );
        if ( c > 0.0 ) {
          vec3 tH = normalize( vec3( dn.z, 0.0, - dn.x ) + vec3( 1e-5, 0.0, 0.0 ) );
          vec3 tV = cross( tH, dn );
          float h = dot( aR, tH ), v = dot( aR, tV );
          float sh = aSh0 + 0.22 / dl;
          float sv = sh * 3.6 + 0.03;
          aSpec += f.w * exp( - h * h / ( sh * sh ) - v * v / ( sv * sv ) ) * ( 0.18 + 0.82 * aWetK ) * ( 0.04 / ( sh + 0.02 ) );
        }
      }
      #endif
    }
    reflectedLight.indirectDiffuse += material.diffuseColor * uAFireCol * aDiff * 2.4;
    #if ARENA_TIER >= 1
      reflectedLight.indirectSpecular += uAFireCol * aSpec * aFres * 9.0;
    #endif
    // кольцо рун светит на пол: тление и волны заклинаний — те же uniform-ы, что у самого кольца
    float aRr = length( aP.xz ) - uARuneR;
    if ( abs( aRr ) < 1.9 && aP.y > -0.25 ) {
      float sw = exp( - aRr * aRr / 0.42 );
      float u = fract( atan( - aP.z, aP.x ) / 6.2831853 );
      vec3 rc = uRuneBase * 1.3;
      for ( int i = 0; i < 4; i ++ ) {
        vec4 w = uRuneW[ i ];
        if ( w.z <= 0.0 ) continue;
        vec4 c = uRuneC[ i ];
        float dr = abs( fract( u - w.x + 0.5 ) - 0.5 );
        float tr = w.y - dr * w.w;
        float pr = max( tr, 0.0 );
        rc += c.rgb * ( w.z * step( 0.0, tr ) * exp( - pr * c.a ) * ( 1.0 + 1.6 * exp( - pr * 14.0 ) ) * exp( - dr * 1.4 ) );
      }
      reflectedLight.indirectDiffuse += material.diffuseColor * rc * sw * 1.5;
      reflectedLight.indirectSpecular += rc * sw * ( 0.25 + 0.75 * aWetK ) * aFres * 2.2;
    }
    // лужи отражают небо резче и сильнее, чем общий IBL (high), и ловят корону затмения (medium+)
    #if ARENA_TIER >= 1
    if ( aWetK > 0.01 ) {
      #if defined( USE_ENVMAP ) && ARENA_TIER >= 2
        reflectedLight.indirectSpecular += getIBLRadiance( geometryViewDir, geometryNormal, 0.07 ) * aWetK * aFres * uAWet;
      #endif
      float cs = dot( aR, uASun );
      if ( cs > 0.93 ) {
        float ang = acos( clamp( cs, -1.0, 1.0 ) );
        float rim = ang - uADiscR;
        float cor = step( 0.0, rim ) * ( exp( - rim / 0.03 ) * 0.8 + exp( - rim / 0.14 ) * 0.16 ) + exp( - abs( rim ) / 0.0035 ) * 2.2;
        reflectedLight.indirectSpecular += uACorona * uACoronaI * cor * aWetK * aFres * 1.4;
      }
    }
    #endif
  }`;

export function createArenaFx({
  THREE, parent, G, M, renderer = null, fires: fireDefs = [], ruins = [], groundY = () => 0,
  materials = {}, LI = { point: 1 }, quality = 'medium', reducedMotion = false, seed = 7331,
  runeU = null, sky = null, runeR = 3.82, embersR = [2.5, 21],
} = {}) {
  const own = (x, f) => (f ? f(x) : x);
  const Gx = (g) => own(g, G), Mx = (m) => own(m, M);
  const rnd = mulberry32(seed + 4401);
  const state = { quality: normQ(quality), reduced: !!reducedMotion, disposed: false, far: false, lights: null };
  const group = new THREE.Group();
  group.name = 'arena-fx';
  parent.add(group);

  /* --------------------------- Жаровни и факелы-столпы --------------------------- */
  // Подножие — лепной камень; железо — чаша, обод и три когтя, загнутые над огнём; угли — сплюснутый скол.
  const lathe = (prof, seg) => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)), seg);
  const pedGeo = Gx(lathe([[0.46, 0], [0.46, 0.06], [0.37, 0.1], [0.37, 0.15], [0.27, 0.21], [0.2, 0.3], [0.185, 0.7], [0.23, 0.77], [0.3, 0.84], [0.34, 0.92], [0.31, 0.96], [0.0005, 0.96]], 18));
  const ironGeo = (() => {
    const parts = [];
    parts.push(lathe([[0.0005, 0], [0.12, 0.0], [0.3, 0.07], [0.46, 0.22], [0.52, 0.33], [0.49, 0.355], [0.43, 0.28], [0.0005, 0.2]], 20));
    const rim = new THREE.TorusGeometry(0.505, 0.026, 6, 28);
    rim.rotateX(Math.PI / 2); rim.translate(0, 0.345, 0);
    parts.push(rim);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.5, ca = Math.cos(a), sa = Math.sin(a);
      // коготь: от дна чаши наружу, вверх вдоль борта и завиток над ободом к огню
      const P = (r, y) => new THREE.Vector3(ca * r, y, sa * r);
      const curve = new THREE.CatmullRomCurve3([P(0.16, 0.02), P(0.42, 0.12), P(0.6, 0.3), P(0.62, 0.5), P(0.5, 0.64), P(0.4, 0.6)]);
      parts.push(new THREE.TubeGeometry(curve, 14, 0.028, 5, false));
      const tip = new THREE.SphereGeometry(0.04, 6, 4);
      tip.translate(ca * 0.4, 0.6, sa * 0.4);
      parts.push(tip);
    }
    return Gx(mergeParts(THREE, parts));
  })();
  const coalGeo = (() => {
    const g = new THREE.IcosahedronGeometry(0.34, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const h = Math.abs(Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453) % 1;
      const k = 0.78 + h * 0.42;
      p.setXYZ(i, x * k, y * k * 0.45, z * k);
    }
    g.computeVertexNormals();
    return Gx(g);
  })();

  const fires = [];   // { x, y, z, h, w, seed, kind, light } — y: основание языка пламени
  const pedM = [], ironM = [], coalM = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  const mat4 = (x, y, z, yaw, sx, sy, sz) => new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(sx, sy, sz));
  for (const f of fireDefs.slice(0, FIRE_MAX)) {
    const yaw = rnd() * TAU, s0 = 0.5 + rnd();
    if (f.kind === 'torch') {
      // столп-светильник у колонны: тонкое высокое подножие, малая чаша
      const PH = 2.3, IS = 0.58;
      pedM.push(mat4(f.x, f.y, f.z, yaw, 0.6, PH, 0.6));
      ironM.push(mat4(f.x, f.y + 0.95 * PH, f.z, yaw, IS, IS, IS));
      coalM.push(mat4(f.x, f.y + 0.95 * PH + 0.25 * IS, f.z, yaw, IS * 1.05, IS, IS * 1.05));
      fires.push({ x: f.x, y: f.y + 0.95 * PH + 0.2 * IS, z: f.z, h: 1.1, w: 0.62, seed: s0, kind: 'torch', light: 8.5 });
    } else {
      pedM.push(mat4(f.x, f.y, f.z, yaw, 1, 1.08, 1));
      ironM.push(mat4(f.x, f.y + 1.02, f.z, yaw, 1, 1, 1));
      coalM.push(mat4(f.x, f.y + 1.28, f.z, yaw, 1.05, 1, 1.05));
      fires.push({ x: f.x, y: f.y + 1.2, z: f.z, h: 1.75, w: 1.05, seed: s0, kind: 'brazier', light: 14 });
    }
  }
  const NF = fires.length;
  const inst = [];
  function instanced(geo, mat, list, name, cast) {
    if (!mat || !list.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => m.setMatrixAt(i, mm));
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = cast; m.receiveShadow = true;
    m.computeBoundingSphere();
    m.name = name;
    group.add(m);
    inst.push(m);
    return m;
  }
  instanced(pedGeo, materials.stone, pedM, 'arena-fire-pedestals', true);
  instanced(ironGeo, materials.iron, ironM, 'arena-fire-iron', true);
  instanced(coalGeo, materials.coals, coalM, 'arena-fire-coals', false);

  /* ---------------------------------- Пламя ---------------------------------- */
  const timeU = { value: 0 };
  const flameU = { uTime: timeU, uFireK: { value: 1 } };
  const flameMat = Mx(new THREE.ShaderMaterial({
    uniforms: flameU, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }));
  let flames = null, flameIdxLow = 0, flameIdxHigh = 0;
  if (NF) {
    const nQ = NF * 3;
    const pos = new Float32Array(nQ * 12), fa = new Float32Array(nQ * 16), sz = new Float32Array(nQ * 8), idx = [];
    let q = 0;
    for (let type = 0; type < 3; type++) for (const f of fires) {
      const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      corners.forEach(([cx, cy], k) => {
        const v = q * 4 + k;
        pos.set([cx, cy, type], v * 3);
        fa.set([f.x, f.y, f.z, f.seed], v * 4);
        sz.set([f.w, f.h], v * 2);
      });
      const b = q * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      q++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aFire', new THREE.BufferAttribute(fa, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 2));
    g.setIndex(idx);
    flameIdxLow = NF * 2 * 6; flameIdxHigh = NF * 3 * 6;
    flames = new THREE.Mesh(Gx(g), flameMat);
    flames.frustumCulled = false;
    flames.renderOrder = 6;
    flames.name = 'arena-fire-flames';
    group.add(flames);
  }

  /* ---------------------------------- Воздух ---------------------------------- */
  const airU = { uTime: timeU, uMotion: { value: state.reduced ? 0.4 : 1 }, uViewH: { value: 720 }, uWind: { value: 0.3 } };
  const airMat = Mx(new THREE.ShaderMaterial({
    uniforms: airU, vertexShader: AIR_VERT, fragmentShader: AIR_FRAG,
    transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  const tiers = [[], [], []];
  for (let t = 0; t < 3; t++) {
    for (const f of fires) for (let k = 0; k < SPARKS[t]; k++) {
      tiers[t].push([f.x + (rnd() - 0.5) * f.w * 0.4, f.y + f.h * 0.22, f.z + (rnd() - 0.5) * f.w * 0.4, rnd(), 0, 0.8 + rnd() * 0.9, f.h * 1.3 + rnd() * 1.4, 0]);
    }
    for (let k = 0; k < EMBERS[t]; k++) {
      let x, z;
      if (NF && rnd() < 0.3) { const f = fires[(rnd() * NF) | 0]; const a = rnd() * TAU, r = 0.6 + rnd() * 2.6; x = f.x + Math.sin(a) * r; z = f.z + Math.cos(a) * r; }
      else { const a = rnd() * TAU, r = Math.sqrt(lerp(embersR[0] ** 2, embersR[1] ** 2, rnd())); x = Math.sin(a) * r; z = Math.cos(a) * r; }
      tiers[t].push([x, groundY(x, z) + rnd() * 0.8, z, rnd(), 1, 7 + rnd() * 7, 3 + rnd() * 5, 0.7 + rnd() * 0.6]);
    }
    for (let k = 0; k < MOTHS[t] && ruins.length; k++) {
      const r0 = ruins[(rnd() * ruins.length) | 0];
      const a = rnd() * TAU, rr = (r0.r || 1) + 0.6 + rnd() * 1.4;
      const x = r0.x + Math.sin(a) * rr, z = r0.z + Math.cos(a) * rr;
      tiers[t].push([x, groundY(x, z) + 0.7 + rnd() * 2.2, z, rnd(), 2, 0.5 + rnd() * 0.6, 0.5 + rnd() * 1.1, 0.8 + rnd() * 0.5]);
    }
  }
  const airCounts = [0, 1, 2].map((t) => tiers.slice(0, t + 1).reduce((s, l) => s + l.length, 0));
  const all = tiers.flat();
  const aA = new Float32Array(all.length * 4), aB = new Float32Array(all.length * 4), aPos = new Float32Array(all.length * 3);
  all.forEach((v, i) => { aA.set([v[0], v[1], v[2], v[3]], i * 4); aB.set([v[4], v[5], v[6], v[7]], i * 4); aPos.set([v[0], v[1], v[2]], i * 3); });
  const airGeo = new THREE.BufferGeometry();
  airGeo.setAttribute('position', new THREE.BufferAttribute(aPos, 3));
  airGeo.setAttribute('aA', new THREE.BufferAttribute(aA, 4));
  airGeo.setAttribute('aB', new THREE.BufferAttribute(aB, 4));
  const air = new THREE.Points(Gx(airGeo), airMat);
  air.frustumCulled = false;
  air.renderOrder = 7;
  air.name = 'arena-air';
  group.add(air);

  /* --------------------------------- Пул света --------------------------------- */
  const POOL = ARENA_FX_QUALITY.high.lights;
  const slots = [];
  for (let i = 0; i < POOL; i++) {
    const l = new THREE.PointLight(0xff8a3d, 0, 8, 2);
    l.castShadow = false;
    l.visible = false;
    l.name = 'arena-fire-light-' + i;
    group.add(l);
    slots.push({ l, idx: -1, w: 0 });
  }
  const want = new Uint8Array(Math.max(1, NF)), held = new Uint8Array(Math.max(1, NF)), dist2 = new Float32Array(Math.max(1, NF));

  /* ------------------------------ Uniform-ы пола ------------------------------ */
  const fireP = [];
  for (let i = 0; i < FIRE_MAX; i++) fireP.push(new THREE.Vector4(0, -100, 0, 0));
  const fireA = new Float32Array(FIRE_MAX).fill(1);
  const litU = {
    uAFire: { value: fireP }, uAFireA: { value: fireA }, uAFireCol: { value: new THREE.Color(1.0, 0.46, 0.16) },
    uAFireN: { value: NF },
    uRuneW: runeU ? runeU.uRuneW : { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uRuneC: runeU ? runeU.uRuneC : { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uRuneBase: runeU ? runeU.uRuneBase : { value: new THREE.Color(0, 0, 0) },
    uARuneR: { value: runeR },
    uASun: sky && sky.uSun ? sky.uSun : { value: new THREE.Vector3(0, 0.3, -1).normalize() },
    uACorona: sky && sky.uCorona ? sky.uCorona : { value: new THREE.Color(0.7, 0.75, 0.85) },
    uACoronaI: sky && sky.uCoronaI ? sky.uCoronaI : { value: 1 },
    uADiscR: sky && sky.uDiscR ? sky.uDiscR : { value: 0.063 },
    uAWet: { value: 1.3 },
  };
  fires.forEach((f, i) => fireP[i].set(f.x, f.y + f.h * 0.38, f.z, 0));
  // Встроить свет огней и рун в материал пола: после patchWet (нужны vAshWorldPos и ashPud).
  const litMats = [];
  const tierOf = () => ARENA_FX_QUALITY[state.quality].tier;
  function patchLit(mat, kind = 'floor') {
    if (!mat || mat.userData.arenaLit) return;
    mat.userData.arenaLit = kind;
    litMats.push(mat);
    const prev = mat.onBeforeCompile;
    const body = kind === 'terrain'
      ? `\n  if ( dot( vAshWorldPos.xz, vAshWorldPos.xz ) < 1600.0 ) ${ARENA_LIGHT_BODY}`
      : ARENA_LIGHT_BODY;
    mat.onBeforeCompile = (shader, r) => {
      if (prev) prev.call(mat, shader, r);
      Object.assign(shader.uniforms, litU);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n#define ARENA_TIER ${tierOf()}\n` + ARENA_LIGHT_PARS)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>' + body);
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => 'arenaLit:' + kind + tierOf() + ':' + (prevKey ? prevKey.call(mat) : '');
    mat.needsUpdate = true;
  }

  /* ---------------------------------- Кадр ---------------------------------- */
  const _bs = new THREE.Vector2();
  // ctx: { focus: {x, z} — где герой, cam: камера, fade: 0..1 — общий накал огней (смерть/победа не трогаем) }
  function update(dt, time, ctx = {}) {
    if (state.disposed) return;
    const t = time;
    timeU.value = t;
    const cam = ctx.cam || null;
    // далеко от арены (прогулка по карте) — огни и воздух не рисуются, свет пула гаснет (видимость света не меняем)
    const far = cam ? Math.hypot(cam.position.x, cam.position.z) > 120 : false;
    if (far !== state.far) { state.far = far; if (flames) flames.visible = !far; air.visible = !far; }
    if (renderer && renderer.getDrawingBufferSize) airU.uViewH.value = renderer.getDrawingBufferSize(_bs).y || 720;
    airU.uWind.value = (0.28 + 0.12 * Math.sin(t * 0.21)) * (state.reduced ? 0.5 : 1);
    const k = ctx.fade != null ? ctx.fade : 1;
    flameU.uFireK.value = k;
    for (let i = 0; i < NF; i++) {
      const f = fires[i];
      fireP[i].w = flicker(t, f.seed) * (f.kind === 'torch' ? 0.62 : 1) * k * (far ? 0 : 1);
      fireA[i] = 1;
    }
    // пул света: ближайшие к герою огни; передача — затуханием, без рывка
    const nAct = activeLights();
    if (nAct > 0) {
      const fx = ctx.focus ? ctx.focus.x : 0, fz = ctx.focus ? ctx.focus.z : 0;
      for (let i = 0; i < NF; i++) { dist2[i] = (fires[i].x - fx) ** 2 + (fires[i].z - fz) ** 2; want[i] = 0; held[i] = 0; }
      for (let n = 0; n < nAct; n++) {
        let best = -1;
        for (let i = 0; i < NF; i++) if (!want[i] && (best < 0 || dist2[i] < dist2[best])) best = i;
        if (best >= 0) want[best] = 1;
      }
      for (let s = 0; s < nAct; s++) if (slots[s].idx >= 0) held[slots[s].idx] = 1;
      const fade = 1 - Math.exp(-3.5 * dt);
      for (let s = 0; s < nAct; s++) {
        const sl = slots[s];
        if (sl.idx >= 0 && want[sl.idx]) sl.w += (1 - sl.w) * fade;
        else {
          sl.w -= Math.min(sl.w, dt * 2.5);
          if (sl.w <= 0.001) {
            sl.w = 0;
            let pick = -1;
            for (let i = 0; i < NF; i++) if (want[i] && !held[i]) { pick = i; break; }
            if (sl.idx >= 0) held[sl.idx] = 0;
            sl.idx = pick;
            if (pick >= 0) { held[pick] = 1; const f = fires[pick]; sl.l.position.set(f.x, f.y + f.h * 0.45, f.z); sl.l.distance = f.kind === 'torch' ? 7 : 8.5; }
          }
        }
        if (sl.idx >= 0) {
          const f = fires[sl.idx];
          sl.l.intensity = f.light * LI.point * flicker(t, f.seed) * sl.w * k * (far ? 0 : 1);
          fireA[sl.idx] = 1 - sl.w;
        } else sl.l.intensity = 0;
      }
    }
  }

  // число источников пула: из пресета владельца (world: QUALITY_PRESETS.brazierLights), иначе — из ARENA_FX_QUALITY
  const activeLights = () => Math.min(state.lights != null ? state.lights : ARENA_FX_QUALITY[state.quality].lights, POOL, NF);
  function setQuality(level, lights) {
    state.quality = normQ(level);
    state.lights = Number.isFinite(lights) ? Math.max(0, lights | 0) : null;
    const Q = ARENA_FX_QUALITY[state.quality];
    airGeo.setDrawRange(0, airCounts[Q.tier]);
    if (flames) flames.geometry.setDrawRange(0, Q.smoke ? flameIdxHigh : flameIdxLow);
    for (const m of litMats) m.needsUpdate = true;   // ярус шейдера пола — define в ключе программы
    // видимых источников столько, сколько разрешает уровень (одна перекомпиляция — при смене уровня)
    const n = activeLights();
    slots.forEach((s, i) => { s.l.visible = i < n; if (!s.l.visible) { s.l.intensity = 0; s.idx = -1; s.w = 0; } });
  }
  function configure(patch = {}) {
    if ('reducedMotion' in patch) { state.reduced = !!patch.reducedMotion; airU.uMotion.value = state.reduced ? 0.4 : 1; }
  }
  function stats() {
    const Q = ARENA_FX_QUALITY[state.quality];
    return {
      fires: NF, air: airGeo.drawRange.count, lights: slots.filter((s) => s.l.visible).length,
      lit: slots.filter((s) => s.l.visible && s.idx >= 0).map((s) => [s.idx, +s.w.toFixed(2)]),
      smoke: Q.smoke, refl: Q.refl, far: state.far,
    };
  }
  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    if (group.parent) group.parent.remove(group);
    for (const m of inst) m.dispose();
    if (!G) { pedGeo.dispose(); ironGeo.dispose(); coalGeo.dispose(); airGeo.dispose(); if (flames) flames.geometry.dispose(); }
    if (!M) { flameMat.dispose(); airMat.dispose(); }
  }

  setQuality(state.quality);
  return { group, fires, update, setQuality, configure, patchLit, dispose, stats, uniforms: litU };
}

// Слить геометрии (position/normal/uv) в одну: железо жаровни — один инстанс-меш.
function mergeParts(THREE, list) {
  let vN = 0, iN = 0;
  const geos = list;
  for (const g of geos) { vN += g.attributes.position.count; iN += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vN * 3), nor = new Float32Array(vN * 3), uv = new Float32Array(vN * 2), idx = new Uint32Array(iN);
  let vo = 0, io = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i);
      if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
    else for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
    vo += p.count; io += g.index ? g.index.count : p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
