// ASHEN OATH — [HERO] Световой шлейф взмаха посоха (как у оружия в BDO): лента между навершием и точкой
// древка ниже, в мировых координатах — дуга остаётся в воздухе и гаснет за ~0.25 с.
// Яркость — от скорости навершия ОТНОСИТЕЛЬНО ТЕЛА героя (бег и поворот витрины шлейф не рисуют,
// взмах и каст — рисуют). Сглаживание Catmull-Rom между замерами: дуга гладкая и при 30 кадрах/с.
// Аддитивный шейдер, HDR-цвет (ловит bloom), без записи глубины и теней.
//
// export: createTrail(THREE, { color, n, sub, life, hot }) →
//   { mesh, push(a, b, speed, glow, dt), reset(), setVisible(on), dispose() }
//   a — точка навершия, b — точка древка (мир), speed — скорость навершия относительно тела (м/с).

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
  float core = exp( - pow( ( a - 0.9 ) * 12.0, 2.0 ) );
  float streak = 0.72 + 0.28 * sin( a * 38.0 + age * 9.0 );
  vec3 col = uColor * ( body * 0.55 * streak + core * uHot );
  // к старому краю — холоднее и прозрачнее
  col = mix( col, col * vec3( 0.7, 0.8, 1.2 ), age );
  gl_FragColor = vec4( col, clamp( fade, 0.0, 1.0 ) );
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
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
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
  let lit = false;
  function reset() { for (let i = 0; i < n; i++) age[i] = 1e9; count = 0; lit = false; mesh.visible = false; }
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
    if (!mesh.visible) return;
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
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
