// ASHEN OATH — [HERO] Световой шлейф взмаха посоха (как у оружия в BDO): лента между навершием и точкой
// древка ниже, в мировых координатах — дуга остаётся в воздухе и гаснет за ~0.25 с.
// Яркость — от скорости навершия ОТНОСИТЕЛЬНО ТЕЛА героя (бег и поворот витрины шлейф не рисуют,
// взмах и каст — рисуют). Сглаживание Catmull-Rom между замерами: дуга гладкая и при 30 кадрах/с.
// Обычное смешивание (яркость → прозрачность: видно и на светлом фоне), HDR-цвет (ловит bloom),
// без записи глубины и теней.
//
// export: createTrail(THREE, { color, n, sub, life, hot }) →
//   { mesh, push(a, b, speed, glow, dt), reset(), setVisible(on), dispose() }
//   a — точка навершия, b — точка древка (мир), speed — скорость навершия относительно тела (м/с).
//
// [W4-АУРА] «Следы» героя — тоже здесь (их создаёт и ведёт modules/heroAura.js, только medium/high):
// export: createFootprints(THREE, { color, color2, count, life }) — светящиеся отпечатки шагов на бегу:
//   ОДИН InstancedMesh (1 вызов отрисовки, пока жив хоть один след), возраст считает шейдер по uTime —
//   в кадре на CPU ничего, запись только в момент шага. → { mesh, stamp(x,y,z,yaw,side,k,t), update(t), setColor, dispose }
// export: createDashBurst(THREE, { color, color2, count }) — пыль из-под ног и искры стихии на рывке:
//   ОДНИ Points из кольцевого пула (1 вызов, пока есть живые частицы), баллистика — в вершинном шейдере.
//   → { points, emit(kind, x,y,z, dx,dz, t, k), update(t), setColor, dispose }   kind: 'dash' | 'stop' | 'step'
//
// [W5-СМЕНА] Материалы — ShaderMaterial: в ключе программы three — номера исходников шейдеров (WebGLShaderCache), и
// когда освобождён последний материал с этим исходником, следующий получает НОВЫЙ номер — программа собиралась
// заново на каждую загрузку героя (смена героя в меню). dispose() отдаёт материал в heroCache.retire: первый
// собранный материал каждого исходника остаётся «хранителем» (вне сцены, без текстур) — номер и программа живут.
import { retire } from './heroCache.js';

const VERT = /* glsl */`
attribute vec3 aT;          // x — возраст (0 новый … 1 погас), y — поперёк (0 древко … 1 навершие), z — яркость замера
varying vec3 vT;
void main() {
  vT = aT;
  gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
}`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uHot;
varying vec3 vT;
void main() {
  float age = clamp( vT.x, 0.0, 1.0 ), a = clamp( vT.y, 0.0, 1.0 );
  float fade = vT.z * pow( 1.0 - age, 1.6 );
  // тело ленты: ярче к навершию, мягко гаснет к древку; горячая нить у кромки навершия
  float body = smoothstep( 0.15, 0.9, a ) * ( 1.0 - smoothstep( 0.97, 1.0, a ) );
  float core = exp( - ( a - 0.9 ) * ( a - 0.9 ) * 144.0 );   // pow() с отрицательным основанием в GLSL не определён
  float streak = 0.72 + 0.28 * sin( a * 38.0 + age * 9.0 );
  // [W4-АУРА] старый край ленты рвётся на волокна (а не тает ровной полосой) и редкие блёстки в теле
  float fib = 0.5 + 0.5 * sin( a * 61.0 + sin( a * 17.0 ) * 3.0 );
  body *= 1.0 - smoothstep( 0.35, 1.0, age ) * ( 0.65 + 0.35 * fib );
  vec2 gc = floor( vec2( a * 22.0, age * 26.0 ) );
  float glint = step( 0.955, fract( sin( dot( gc, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) ) * ( 1.0 - age ) * body;
  // обычное смешивание (видно и на светлом небе/лесе): яркость — в прозрачность, цвет — HDR, нить ярче
  float I = body * 0.85 * streak + core * uHot * 0.8 + glint * 0.9;
  vec3 col = uColor * ( 0.6 + 1.0 * core );   // тело ниже 1 — цвет стихии не выгорает тонмаппингом в жёлтый/белый
  col = mix( col, uColor * 0.6 + vec3( 0.55 ), core * 0.3 + glint * 0.6 );   // нить и блёстки — к белому
  // к старому краю — холоднее и прозрачнее
  col = mix( col, col * vec3( 0.7, 0.8, 1.2 ), age );
  gl_FragColor = vec4( col, clamp( fade * I, 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createTrail(THREE, { color = 0x9d7bff, n = 18, sub = 3, life = 0.22, hot = 1.5 } = {}) {
  const A = [], B = [], age = new Float32Array(n), K = new Float32Array(n);
  for (let i = 0; i < n; i++) { A.push(new THREE.Vector3()); B.push(new THREE.Vector3()); age[i] = 1e9; }
  let head = 0, count = 0;
  const S = (n - 1) * sub + 1;                     // точек вдоль после сглаживания
  const pos = new Float32Array(S * 2 * 3), at = new Float32Array(S * 2 * 3);
  const idx = [];
  for (let s = 0; s < S - 1; s++) { const p = s * 2; idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aT', new THREE.BufferAttribute(at, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    name: 'hero-trail', vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(1.7) }, uHot: { value: hot } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'staff-trail'; mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.visible = false; mesh.userData.noShadow = true;
  const _c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const cr = (p0, p1, p2, p3, t, out) => {
    const t2 = t * t, t3 = t2 * t;
    return out.set(0, 0, 0)
      .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
      .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
      .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
      .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
  };
  // i-й замер от нового к старому
  const at_ = (i) => (head - 1 - i + n * 4) % n;
  let lit = false, warm = 2;   // первые кадры меш «виден» вырожденным (нулевая площадь): шейдер собирается при загрузке
  function reset() { for (let i = 0; i < n; i++) age[i] = 1e9; count = 0; lit = false; if (warm > 0) warm--; mesh.visible = warm > 0; }
  function push(a, b, speed, glow = 1, dt = 1 / 60) {
    // скачок (телепорт, смена героя) — лента не тянется через полкарты
    if (count && A[at_(0)].distanceToSquared(a) > 1.5 * 1.5) reset();
    for (let i = 0; i < n; i++) age[i] += dt;
    const k = Math.min(1, Math.max(0, (speed - 1.6) / 3.2)) * (0.65 + 0.35 * Math.min(2, glow));
    A[head].copy(a); B[head].copy(b); age[head] = 0; K[head] = k * k * (3 - 2 * k);
    head = (head + 1) % n; count = Math.min(n, count + 1);
    // есть что рисовать: хоть один живой яркий замер
    lit = false;
    for (let i = 0; i < count; i++) { const j = at_(i); if (age[j] < life && K[j] > 0.01) { lit = true; break; } }
    mesh.visible = lit && count >= 3;
    if (!mesh.visible) { if (warm > 0) { warm--; mesh.visible = true; } return; }
    warm = 0;
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
      const i0 = Math.min(count - 1, Math.max(0, i - 1)), i1 = Math.min(count - 1, i), i2 = Math.min(count - 1, i + 1), i3 = Math.min(count - 1, i + 2);
      const j0 = at_(i0), j1 = at_(i1), j2 = at_(i2), j3 = at_(i3);
      for (let s = 0; s < sub; s++) {
        const t = s / sub;
        cr(A[j0], A[j1], A[j2], A[j3], t, _c[0]); cr(B[j0], B[j1], B[j2], B[j3], t, _c[1]);
        const ag = Math.min(1, (age[j1] * (1 - t) + age[j2] * t) / life), kk = K[j1] * (1 - t) + K[j2] * t;
        _c[0].toArray(pos, w * 6); _c[1].toArray(pos, w * 6 + 3);
        at[w * 6] = ag; at[w * 6 + 1] = 1; at[w * 6 + 2] = kk;
        at[w * 6 + 3] = ag; at[w * 6 + 4] = 0; at[w * 6 + 5] = kk;
        w++;
      }
    }
    const jl = at_(count - 1);
    A[jl].toArray(pos, w * 6); B[jl].toArray(pos, w * 6 + 3);
    at[w * 6] = 1; at[w * 6 + 1] = 1; at[w * 6 + 2] = 0; at[w * 6 + 3] = 1; at[w * 6 + 4] = 0; at[w * 6 + 5] = 0;
    geo.attributes.position.needsUpdate = true; geo.attributes.aT.needsUpdate = true;
  }
  return {
    mesh, push, reset,
    setVisible(on) { if (!on) reset(); },
    get lit() { return lit; },
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); retire(mat); },   // [W5-СМЕНА] хранитель программы
  };
}

// ---------------------------------------------------------------- [W4-АУРА] отпечатки шагов
// Подошва — две слитые эллипсы (пятка и носок), светится кромкой цвета стихии и тлеет внутри; в момент шага —
// короткая вспышка цвета color2. Левая/правая — зеркало в шейдере (масштаб −1 перевернул бы грани).
const PRINT_VERT = /* glsl */`
attribute vec3 aPr;          // x — время шага (с, часы heroTimeU), y — сторона (−1 левая, +1 правая), z — сила
uniform float uTime;
uniform float uLife;
varying vec2 vUv;
varying float vAge;
varying float vSec;
varying float vK;
void main() {
  vAge = ( uTime - aPr.x ) / uLife;
  vSec = uTime - aPr.x;
  vK = aPr.z;
  // носок — к +v (развёртка плоскости повёрнута к −Z, поэтому v перевёрнута), сторона — зеркало по u
  vUv = vec2( ( uv.x * 2.0 - 1.0 ) * aPr.y, 1.0 - uv.y * 2.0 );
  if ( vAge < 0.0 || vAge > 1.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }   // погасший — вне кадра
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
}`;
const PRINT_FRAG = /* glsl */`
uniform vec3 uC1;
uniform vec3 uC2;
varying vec2 vUv;
varying float vAge;
varying float vSec;
varying float vK;
float ell( vec2 p, vec2 c, vec2 r ) { return length( ( p - c ) / r ) - 1.0; }
void main() {
  vec2 p = vUv;
  float dh = ell( p, vec2( 0.0, -0.56 ), vec2( 0.5, 0.36 ) );
  float db = ell( p, vec2( 0.08, 0.24 ), vec2( 0.62, 0.6 ) );
  float h = clamp( 0.5 + 0.5 * ( db - dh ) / 0.35, 0.0, 1.0 );
  float d = mix( db, dh, h ) - 0.35 * h * ( 1.0 - h );   // плавное слияние пятки и носка
  if ( d > 0.45 ) discard;
  float edge = exp( - abs( d ) * 9.0 );
  float fill = ( 1.0 - smoothstep( -0.5, 0.05, d ) ) * 0.32;
  float life = 1.0 - vAge;
  float flash = exp( - vSec * 9.0 );
  float halo = exp( - max( d, 0.0 ) * 5.0 ) * 0.22;      // мягкий ореол вокруг подошвы — след виден и издалека
  float quad = ( 1.0 - smoothstep( 0.78, 1.0, abs( p.x ) ) ) * ( 1.0 - smoothstep( 0.86, 1.0, abs( p.y ) ) );   // без среза ореола краем квада
  float I = ( edge * 1.3 + fill + halo ) * life * life * vK * quad;
  vec3 col = mix( uC1, uC2, flash * 0.8 + edge * 0.15 ) * ( 1.0 + 2.2 * flash );
  gl_FragColor = vec4( col, clamp( I * ( 1.0 + flash ), 0.0, 1.0 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createFootprints(THREE, { color = 0x9ff4ff, color2 = 0xffffff, count = 14, life = 1.8, size = 1 } = {}) {
  const n = Math.max(2, count | 0);
  const geo = new THREE.PlaneGeometry(0.15 * size, 0.3 * size);
  geo.rotateX(-Math.PI / 2);
  const pr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) pr[i * 3] = -1e4;            // все пустые: «давно погасли»
  geo.setAttribute('aPr', new THREE.InstancedBufferAttribute(pr, 3).setUsage(THREE.DynamicDrawUsage));
  const U = { uTime: { value: 0 }, uLife: { value: life }, uC1: { value: new THREE.Color(color) }, uC2: { value: new THREE.Color(color2) } };
  const mat = new THREE.ShaderMaterial({
    name: 'hero-footprint', uniforms: U, vertexShader: PRINT_VERT, fragmentShader: PRINT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.name = 'hero-footprints'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false; mesh.userData.noShadow = true; mesh.renderOrder = 2;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _y = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _m.identity());
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  let next = 0, lastT = -1e4;
  mesh.visible = false;
  // героя перестали обновлять (скрыт, ушёл со сцены) — следы не застывают на земле
  mesh.onBeforeRender = () => { if (typeof performance !== 'undefined' && performance.now() / 1000 - U.uTime.value > 0.5) mesh.visible = false; };
  return {
    mesh,
    // t — часы шейдера (те же, что идут в update); k — сила отпечатка 0…1
    stamp(x, y, z, yaw, side, k = 1, t = U.uTime.value) {
      _q.setFromAxisAngle(_y, yaw); _p.set(x, y, z);
      mesh.setMatrixAt(next, _m.compose(_p, _q, _s));
      pr[next * 3] = t; pr[next * 3 + 1] = side < 0 ? -1 : 1; pr[next * 3 + 2] = Math.max(0, Math.min(1.5, k));
      next = (next + 1) % n;
      mesh.instanceMatrix.needsUpdate = true; geo.attributes.aPr.needsUpdate = true;
      lastT = t; mesh.visible = true;
    },
    update(t) { U.uTime.value = t; if (mesh.visible && t - lastT > life) mesh.visible = false; },
    setColor(c1, c2) { U.uC1.value.set(c1); if (c2 !== undefined) U.uC2.value.set(c2); },
    get alive() { return mesh.visible; },
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); retire(mat); if (mesh.dispose) mesh.dispose(); },   // [W5-СМЕНА]
  };
}

// ---------------------------------------------------------------- [W4-АУРА] пыль и искры рывка
// Пыль — мягкие облачка (премультиплицированная альфа: чуть закрывает фон, не светится), искры — яркие точки
// стихии (та же формула с альфой 0 — складываются, как аддитив). Один материал, один вызов.
const BURST_VERT = /* glsl */`
attribute vec3 aV;           // начальная скорость, м/с (мир)
attribute vec4 aB;           // x — рождение (с), y — жизнь (с), z — вид (0 пыль, 1 искра), w — случайное 0…1
uniform float uTime;
uniform float uPx;           // пикселей на метр на расстоянии 1 м (высота вьюпорта / 2·tan(fov/2))
varying float vU;
varying float vKind;
varying float vSeed;
void main() {
  float age = uTime - aB.x;
  float u = age / max( aB.y, 1e-3 );
  vU = u; vKind = aB.z; vSeed = aB.w;
  if ( u < 0.0 || u > 1.0 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); gl_PointSize = 0.0; return; }
  float spark = step( 0.5, aB.z );
  float dr = mix( 4.2, 2.6, spark );                       // сопротивление воздуха: пыль вязнет быстрее
  float tau = ( 1.0 - exp( - dr * age ) ) / dr;
  vec3 p = position + aV * tau;
  p.y += mix( 0.32 * age, - 3.4 * age * age, spark );      // пыль всплывает, искры падают
  p.y = max( p.y, position.y - 0.02 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  float sz = mix( 0.16 + 0.5 * sqrt( u ), 0.08 * ( 1.0 - 0.5 * u ), spark ) * ( 0.75 + 0.5 * aB.w );
  gl_PointSize = clamp( sz * uPx / max( 0.3, - mv.z ), 1.0, 90.0 );
}`;
const BURST_FRAG = /* glsl */`
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uDust;
varying float vU;
varying float vKind;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c );
  if ( d > 0.5 ) discard;
  float a;
  vec3 col;
  if ( vKind > 0.5 ) {
    float core = 1.0 - smoothstep( 0.0, 0.5, d );
    core *= core;
    col = mix( uC2, uC1, vU ) * ( 1.6 + 2.8 * core * core );
    a = core * ( 1.0 - vU );
  } else {
    // клуб пыли: мягкий край, «рыхлость» по углу, подсвечен стихией у героя
    float ang = atan( c.y, c.x + 1e-5 );                 // +ε: atan(0, 0) в центре точки не определён
    float lump = 0.82 + 0.18 * sin( ang * 5.0 + vSeed * 30.0 );
    float soft = 1.0 - smoothstep( 0.06, 0.5 * lump, d );
    a = soft * 0.4 * ( 1.0 - vU ) * ( 1.0 - vU ) * smoothstep( 0.0, 0.06, vU );
    col = mix( uDust, uC1 * 0.5, 0.18 + 0.22 * vSeed * ( 1.0 - vU ) );
  }
  gl_FragColor = vec4( col, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4( gl_FragColor.rgb * a, vKind > 0.5 ? 0.0 : a );   // премультипликация после цвета экрана
}`;

export function createDashBurst(THREE, { color = 0x9ff4ff, color2 = 0xffffff, count = 48, dust = 0x6e655c } = {}) {
  const n = Math.max(8, count | 0);
  const geo = new THREE.BufferGeometry();
  const P0 = new Float32Array(n * 3), V = new Float32Array(n * 3), B = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { B[i * 4] = -1e4; B[i * 4 + 1] = 1; }
  geo.setAttribute('position', new THREE.BufferAttribute(P0, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aV', new THREE.BufferAttribute(V, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aB', new THREE.BufferAttribute(B, 4).setUsage(THREE.DynamicDrawUsage));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const U = {
    uTime: { value: 0 }, uPx: { value: 600 },
    uC1: { value: new THREE.Color(color) }, uC2: { value: new THREE.Color(color2) }, uDust: { value: new THREE.Color(dust) },
  };
  const mat = new THREE.ShaderMaterial({
    name: 'hero-dash-burst', uniforms: U, vertexShader: BURST_VERT, fragmentShader: BURST_FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'hero-dash-burst'; pts.frustumCulled = false; pts.matrixAutoUpdate = false; pts.renderOrder = 4; pts.visible = false;
  // размер точки в пикселях — по вьюпорту и углу обзора камеры этого кадра (без выделений)
  const _vp = new THREE.Vector4();
  pts.onBeforeRender = (renderer, scene, camera) => {
    renderer.getCurrentViewport(_vp);
    const fov = camera && camera.isPerspectiveCamera ? camera.fov : 50;
    U.uPx.value = _vp.w / (2 * Math.tan((fov * Math.PI) / 360));
  };
  let next = 0, until = -1e4, seed = 7331;
  const onRender = pts.onBeforeRender;
  // героя перестали обновлять — облака пыли не висят в воздухе
  pts.onBeforeRender = (r, sc, cam) => { if (typeof performance !== 'undefined' && performance.now() / 1000 - U.uTime.value > 0.5) { pts.visible = false; return; } onRender(r, sc, cam); };
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  function put(x, y, z, vx, vy, vz, t, life, kind) {
    const i = next; next = (next + 1) % n;
    P0[i * 3] = x; P0[i * 3 + 1] = y; P0[i * 3 + 2] = z;
    V[i * 3] = vx; V[i * 3 + 1] = vy; V[i * 3 + 2] = vz;
    B[i * 4] = t; B[i * 4 + 1] = life; B[i * 4 + 2] = kind; B[i * 4 + 3] = rnd();
    if (t + life > until) until = t + life;
  }
  // kind: 'dash' — старт рывка (пыль назад и в стороны, искры назад), 'trail' — по ходу рывка, 'stop' — торможение
  // (пыль вперёд), 'step' — шаг
  function emit(kind, x, y, z, dx, dz, t = U.uTime.value, k = 1) {
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const nd = kind === 'dash' ? Math.round(16 * k) : kind === 'stop' ? Math.round(9 * k) : 2;
    const ns = kind === 'dash' ? Math.round(14 * k) : kind === 'stop' ? Math.round(4 * k) : kind === 'trail' ? Math.round(4 * k) : 0;
    const back = kind === 'stop' ? -1 : 1;   // пыль на старте летит назад, на торможении — по ходу
    for (let i = 0; i < nd; i++) {
      const a = rnd() * Math.PI * 2, r = 0.05 + 0.2 * rnd(), ox = Math.cos(a), oz = Math.sin(a);
      const soft = kind === 'step' || kind === 'trail';
      const sp = soft ? 0.35 + 0.5 * rnd() : 1.0 + 1.9 * rnd(), rad = soft ? 0.5 : 0.6 + 1.1 * rnd();
      put(x + ox * r, y + 0.04, z + oz * r,
        -dx * sp * back + ox * rad, 0.15 + 0.45 * rnd(), -dz * sp * back + oz * rad,
        t + (kind === 'dash' ? 0.03 * rnd() : 0), soft ? 0.45 + 0.25 * rnd() : 0.7 + 0.45 * rnd(), 0);
    }
    for (let i = 0; i < ns; i++) {
      const h = 0.12 + 1.0 * rnd(), lat = (rnd() - 0.5) * 2;
      const sp = 2.4 + 3.4 * rnd();
      put(x + (rnd() - 0.5) * 0.3, y + h, z + (rnd() - 0.5) * 0.3,
        -dx * sp * back - dz * lat * 1.4, 0.4 + 2.2 * rnd(), -dz * sp * back + dx * lat * 1.4,
        t + 0.05 * rnd(), 0.32 + 0.3 * rnd(), 1);
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.aV.needsUpdate = true; geo.attributes.aB.needsUpdate = true;
    pts.visible = true;
  }
  return {
    points: pts, emit,
    update(t) { U.uTime.value = t; if (pts.visible && t > until + 0.05) pts.visible = false; },
    setColor(c1, c2) { U.uC1.value.set(c1); if (c2 !== undefined) U.uC2.value.set(c2); },
    get alive() { return pts.visible; },
    dispose() { if (pts.parent) pts.parent.remove(pts); geo.dispose(); retire(mat); },   // [W5-СМЕНА]
  };
}
