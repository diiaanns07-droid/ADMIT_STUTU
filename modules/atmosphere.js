/*
 * ASHEN OATH — atmosphere.js
 * Небо с затмением, высотный туман со свечением к затмению (в шейдерах материалов),
 * море тумана, световые столбы, rim-свет персонажей и IBL из неба.
 * Источник параметров — AAA Visual Bible, разделы 4, 5, 10 и 16.
 *
 * Модуль вызывается из world.js: не рендерит кадр, не двигает камеру, не создаёт rAF.
 * Глобальные правки (ShaderChunk тумана, uniform-ы в ShaderLib, scene.environment)
 * возвращаются в исходное состояние в dispose().
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
varying vec3 vDir;
${NOISE_GLSL}
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
  col = mix( col, cloudCol, cm * 0.9 );
  float edge = clamp( cm * ( 1.0 - cm ) * 4.0, 0.0, 1.0 );
  col += uCorona * uCoronaI * edge * lit * 0.32;

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
  col += uCorona * uCoronaI * ( corona * outside * ( 1.0 - cm * 0.7 ) + halo );

  // Диск и раскалённая кромка; «бусина» — точка, где из-за диска выглядывает свет.
  float disc = 1.0 - smoothstep( uDiscR - 0.0016, uDiscR, ang );
  col = mix( col, mix( vec3( 0.0035, 0.0045, 0.0065 ), uCorona * uCoronaI * 6.0 + vec3( 2.2, 2.0, 1.7 ), uSunDisc ), disc );
  col += uCorona * uCoronaI * exp( - abs( rimD ) / 0.0024 ) * 3.2;
  float beadA = pa - 2.35;
  beadA = atan( sin( beadA ), cos( beadA ) );
  col += vec3( 1.0, 0.97, 0.92 ) * uBead * exp( - beadA * beadA / 0.018 ) * exp( - abs( rimD ) / 0.006 ) * 9.0;

  // Далёкая молния: облако вспыхивает изнутри.
  float fl = uFlash * exp( - ( 1.0 - dot( d, uFlashDir ) ) * 14.0 );
  col += ( cm * 1.6 + 0.2 ) * fl * vec3( 0.55, 0.62, 0.8 );

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
  top += vec3( 0.55, 0.62, 0.8 ) * uFlash * bill * 0.3;
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

/* ============================== createAtmosphere ============================== */
export function createAtmosphere({ THREE, scene, renderer, camera, parent, G, M, T, seed = 7331, reducedMotion = false, quality = 'medium' }) {
  const own = (x, f) => (f ? f(x) : x);
  const Gx = (g) => own(g, G), Mx = (m) => own(m, M);
  const rnd = mulberry32(seed + 901);
  const col = (hex) => new THREE.Color(hex);
  const P = {
    fogBase: col(0x1c2530), fogGlow: col(0x8fa3c0), fogLow: col(0x2a1418), fogDawn: col(0x6b5a4a),
    domeLow: col(0x1a2230), domeHigh: col(0x0b0f16), domeCorona: col(0x3b4a5a), ground: col(0x120e0c),
    corona: col(0xb9c9e6), coronaRed: col(0xff6a4a), coronaDawn: col(0xffe2b8),
    key: col(0xb9c9e6), keyDawn: col(0xffd9a0),
    fogClear: col(0x3e5249),   // [ASHEN_V3] воздух эльфийской деревни: теплее и светлее (setLocalClear)
  };
  const state = {
    disposed: false, reduced: !!reducedMotion, quality,
    orbit: 0, orbitPrev: null, follow: 0, followTarget: 0,
    red: 0, dawn: 0, dark: 0, flash: 0, flashT: 0, nextFlash: 14 + rnd() * 16, strike: 0, time: 0,
    clear: 0,          // [ASHEN_V3] 0..1 — местное прояснение (эльфийская деревня): туман реже и теплее
  };
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
    uFogLow: skyUniforms.uFogLow, uTime: skyUniforms.uTime, uFlash: skyUniforms.uFlash,
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

  /* --------------------------- Rim и заполняющий свет --------------------------- */
  const keyView = { x: 0, y: 0, z: 1 };
  const rimGroups = {
    hero: {
      rim: col(0xc8d8f0), fill: col(0x9db0c8), under: col(0x000000),
      p: { x: 3.0, y: 0.5, z: 0.45, w: 0 }, underH: { value: 1 },
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
  function flash(amount = 1) { state.strike = Math.max(state.strike, clamp(amount, 0, 1)); }

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
    state.red += (redT - state.red) * dampK(0.5, dt);
    state.dawn += (dawnT - state.dawn) * dampK(0.35, dt);
    state.dark += (darkT - state.dark) * dampK(0.6, dt);
    const cor = skyUniforms.uCorona.value.copy(P.corona).lerp(P.coronaRed, state.red * 0.85).lerp(P.coronaDawn, state.dawn);
    skyUniforms.uCoronaI.value = (1 + state.dawn * 1.6) * (1 - state.dark * 0.45);
    skyUniforms.uBead.value = state.dawn;
    skyUniforms.uDiscR.value = deg(ECLIPSE.discRadius) * (1 - state.dawn * 0.12);
    const fb = skyUniforms.uFogBase.value.copy(P.fogBase).lerp(P.fogDawn, state.dawn * 0.6);
    fb.multiplyScalar(1 - state.dark * 0.35);
    if (state.clear > 0) fb.lerp(P.fogClear, state.clear * 0.5);
    fog.color.copy(fb);
    scene.background && scene.background.isColor && scene.background.copy(fb);
    fogA.w = FOG.density * (1 - state.dawn * 0.5) * (1 - 0.45 * state.clear);
    fogLow.w = state.red * 0.8 * (1 - state.dawn);
    skyUniforms.uFogLow.value.w = fogLow.w;
    rayUniforms.uColor.value.copy(cor).multiplyScalar(0.8).lerp(P.key, 0.4);
    rayUniforms.uIntensity.value = 0.085 * (1 + state.dawn * 1.5) * (1 - state.dark * 0.5);
    rimGroups.boss.p.w = lerp(0.08, 0.35, state.red);

    // [BDO] настроение зоны поверх фаз: небо, туман, ключ, IBL и экспозиция
    mood.w += (mood.target - mood.w) * dampK(state.reduced ? 2.4 : 1.35, dt);
    if (Math.abs(mood.w - mood.target) < 1e-3) mood.w = mood.target;
    const mw = mood.w;
    skyUniforms.uDomeLow.value.copy(P.domeLow).lerp(mood.horizon, mw);
    skyUniforms.uDomeHigh.value.copy(P.domeHigh).lerp(mood.top, mw);
    skyUniforms.uDomeCorona.value.copy(P.domeCorona).lerp(mood.corona, mw * 0.6);
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
    const fg = skyUniforms.uFogGlow.value.copy(P.fogGlow).lerp(mood.fogGlow, mw);
    fogGlow.x = fg.r; fogGlow.y = fg.g; fogGlow.z = fg.b;
    if (envTexture && 'environmentIntensity' in scene && scene.environment === envTexture) scene.environmentIntensity = 0.25 * lerp(1, mood.env, mw);
    if (renderer) renderer.toneMappingExposure = baseExposure * lerp(1, mood.exposure, mw);
    const MG = ZONE_MOOD_STATE.grade, gg = mood.grade;
    ZONE_MOOD_STATE.w = mw;
    for (let i = 0; i < 3; i++) { MG.shadow[i] = gg.shadow[i] * mw; MG.high[i] = gg.high[i] * mw; }
    MG.sat = lerp(1, gg.sat, mw); MG.contrast = gg.contrast * mw;

    // Молния раз в 20–40 с (не в reducedMotion: вспышки — риск для светочувствительных).
    if (!state.reduced) {
      state.nextFlash -= dt;
      if (state.nextFlash <= 0) {
        state.nextFlash = 20 + rnd() * 20;
        state.flashT = 0.0001;
        const a = deg(ECLIPSE.azimuth - 70 + rnd() * 140) + yaw;
        skyUniforms.uFlashDir.value.set(Math.sin(a), 0.08 + rnd() * 0.18, Math.cos(a)).normalize();
      }
    }
    let fl = 0;
    if (state.flashT > 0) {
      state.flashT += dt;
      const ft = state.flashT;
      fl = Math.exp(-Math.pow((ft - 0.04) / 0.03, 2)) + 0.7 * Math.exp(-Math.pow((ft - 0.13) / 0.035, 2));
      if (ft > 0.3) state.flashT = 0;
    }
    skyUniforms.uFlash.value = fl * 1.4;
    state.strike *= Math.exp(-dt / 0.06);
    const keyCol = _keyCol.copy(P.key).lerp(P.coronaRed, state.red * 0.3).lerp(P.keyDawn, state.dawn).lerp(mood.sunColor, mw);
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
    for (const o of [sky, sea, rays]) if (o.parent) o.parent.remove(o);
    if (!G) { sky.geometry.dispose(); sea.geometry.dispose(); rayMeshes.forEach((m) => m.geometry.dispose()); }
    if (!M) { skyMat.dispose(); seaMat.dispose(); rayMat.dispose(); }
  }

  setQuality(quality);
  return {
    sunDir, keyDir, sunBase, keyBase, skyRadius, get envTexture() { return envTexture; },
    fogColor: fog.color, useEnv, releaseEnv, patchLit, patchUnlit, flash, update, setQuality, configure, dispose, setLocalClear,
    setZoneMood, get zoneMood() { return mood.w; },  // [BDO]
    get yaw() { return state.follow; },
  };
}
