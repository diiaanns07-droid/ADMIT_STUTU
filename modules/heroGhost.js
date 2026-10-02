// ASHEN OATH — [HERO] Остаточные образы рывка (как уклонения в BDO): силуэт героя в позе момента
// рывка остаётся в воздухе светящейся кромкой цвета стихии и гаснет за ~0.4 с.
// Без копий геометрии и без CPU-скиннинга: призрак — SkinnedMesh на той же геометрии со «замороженным»
// скелетом (копия матриц костей на момент снимка), в мировых координатах. Пул из нескольких наборов —
// без выделений в бою. Материал — кромка по френелю (обычное смешивание: видно и на светлом фоне), глубину
// не пишет, теней нет.
// [W4-АУРА] чище и красивее: призрак не тает ровной дымкой, а рассыпается — шум в мировых координатах,
// порог растёт к концу жизни, край растворения горит светлым оттенком стихии; кромка к старости холоднее.
// На low — один образ на рывок (снимки чаще 0.3 с пропускаются): каждый образ — N вызовов скиннинга.
//
// export: createAfterimages(THREE, { color, sets, life }) →
//   { snap(root, warmOnly), update(dt), setColor(hex), setQuality(q), active(), dispose() }
//   warmOnly — невидимый снимок на 0.1 с при загрузке: шейдер призрака собирается сразу, а не на первом рывке.
//   root — модель героя (берутся видимые SkinnedMesh), scene — первый предок-сцена (ищется сам).

const GH_NOISE = /* glsl */`
float ghHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float ghNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( ghHash( i ), ghHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( ghHash( i + vec3( 0.0, 1.0, 0.0 ) ), ghHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
              mix( mix( ghHash( i + vec3( 0.0, 0.0, 1.0 ) ), ghHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( ghHash( i + vec3( 0.0, 1.0, 1.0 ) ), ghHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
}`;

export function createAfterimages(THREE, { color = 0x9ff4ff, sets = 4, life = 0.42 } = {}) {
  // цвет призрака: насыщеннее и темнее цвета стихии — обычное смешивание (не сложение), чтобы силуэт читался
  // и на светлом фоне (Сияющий лес, небо); кромка поднимается в HDR и на тёмном фоне светится как раньше
  const ghostCol = (hex) => { const c = new THREE.Color(hex), h = {}; c.getHSL(h); return c.setHSL(h.h, Math.max(h.s, 0.8), Math.min(h.l, 0.5)); };
  const col = ghostCol(color);
  const pool = [];      // { meshes: [{ g, sk }], mat, age, on }
  let next = 0, disposed = false, clock = 0, lastSnap = -1e9, minGap = 0;
  // светлый оттенок стихии для края растворения и сердцевины кромки
  const hotCol = (c) => { const h = {}; c.getHSL(h); return new THREE.Color().setHSL(h.h, Math.min(1, h.s * 0.8), 0.72); };
  const col2 = hotCol(col);
  function makeMat() {
    const m = new THREE.MeshBasicMaterial({ name: 'hero-afterimage', color: col.clone(), transparent: true, opacity: 0, depthWrite: false });
    const gu = { ghK: { value: 1 }, ghC2: { value: col2.clone() } };   // свои юниформы у набора: доля жизни и светлый цвет
    m.userData.ghU = gu;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, gu);
      // у SkinnedMesh basic-шейдер считает нормали (USE_SKINNING) — кромка по силуэту
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vGhF;\nvarying vec3 vGhW;')
        .replace('#include <project_vertex>', `#include <project_vertex>
  vGhW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #ifdef USE_SKINNING
    vGhF = 1.0 - abs( dot( normalize( transformedNormal ), normalize( - mvPosition.xyz ) ) );
  #else
    vGhF = 1.0;
  #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGhF;\nvarying vec3 vGhW;\nuniform float ghK;\nuniform vec3 ghC2;' + GH_NOISE)
        .replace('#include <opaque_fragment>', `float ghE = pow( clamp( vGhF, 0.0, 1.0 ), 2.2 );
  // [W4-АУРА] растворение: крупный и мелкий шум по миру, порог растёт к концу жизни, край — светлый
  float ghN = ghNoise( vGhW * 6.5 ) * 0.7 + ghNoise( vGhW * 21.0 ) * 0.3;
  float ghT = pow( 1.0 - ghK, 1.4 ) * 1.02 - 0.04;
  if ( ghN < ghT ) discard;
  float ghEdge = ( 1.0 - smoothstep( 0.0, 0.08, ghN - ghT ) ) * step( 0.0, ghT );
  outgoingLight = mix( outgoingLight, ghC2, 0.3 * ghE * ghK + 0.65 * ghEdge );
  outgoingLight *= 0.7 + 2.2 * ghE + 1.8 * ghEdge;   // кромка ярче (HDR — ловит bloom на тёмном фоне)
  diffuseColor.a *= 0.14 + 0.86 * max( ghE, ghEdge );   // тело — лёгкая дымка, силуэт и край растворения — плотные
  #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'heroAfterimage2';
    return m;
  }
  function sceneOf(o) { let r = o; while (r && r.parent) r = r.parent; return r && r.isScene ? r : null; }
  // снимок: для каждой видимой кожи героя — призрак с копией матриц костей
  function snap(root, warmOnly = false) {
    if (disposed || !root) return false;
    if (!warmOnly && clock - lastSnap < minGap) return false;   // low: один образ на рывок
    const scene = sceneOf(root);
    if (!scene) return false;
    const srcs = [];
    root.traverseVisible((o) => { if (o.isSkinnedMesh && o.skeleton && o.geometry && !o.userData.noGhost) srcs.push(o); });
    if (!srcs.length) return false;
    root.updateWorldMatrix(true, true);   // кости — на позу этого кадра (мир пересчитался бы только при рендере)
    let set = pool[next];
    if (!set) { set = { meshes: [], mat: makeMat(), age: 0, on: false, src: null }; pool[next] = set; }
    next = (next + 1) % sets;
    // набор привязан к своим исходным мешам: при другом составе — пересобрать
    const same = set.meshes.length === srcs.length && set.meshes.every((m, i) => m.src === srcs[i]);
    if (!same) {
      const sks = new Set(set.meshes.map((m) => m.sk));
      for (const m of set.meshes) if (m.g.parent) m.g.parent.remove(m.g);
      for (const sk of sks) if (sk.boneTexture) sk.boneTexture.dispose();
      // один замороженный скелет на исходный скелет (у кожи героя он обычно общий)
      const skOf = new Map();
      set.meshes = srcs.map((src) => {
        let sk = skOf.get(src.skeleton);
        if (!sk) {
          sk = new THREE.Skeleton(src.skeleton.bones, src.skeleton.boneInverses);
          sk.update = () => {};               // замороженный: рендер не пересчитывает матрицы
          skOf.set(src.skeleton, sk);
        }
        const g = new THREE.SkinnedMesh(src.geometry, set.mat);
        g.name = 'hero-afterimage'; g.userData.src = src.name; g.frustumCulled = false; g.castShadow = false; g.receiveShadow = false;
        g.matrixAutoUpdate = false; g.matrixWorldAutoUpdate = false;
        // режим 'attached' (по умолчанию): bindMatrixInverse = (matrixWorld = I)⁻¹ = I — и при пересчёте мира
        g.skeleton = sk; g.bindMatrix.copy(src.bindMatrix); g.bindMatrixInverse.identity();
        g.renderOrder = 2;
        return { g, sk, src };
      });
    }
    // матрицы костей на сейчас; призрак в мире: model = I, bindMatrixInverse = I → вершины уже в мире
    const done = new Set();
    for (const m of set.meshes) {
      if (!done.has(m.sk)) {
        done.add(m.sk);
        m.src.skeleton.update();
        // массивы могут быть разной длины (текстура костей дополняет до квадрата) — копируем только кости
        m.sk.boneMatrices.set(m.src.skeleton.boneMatrices.subarray(0, m.sk.bones.length * 16));
        if (m.sk.boneTexture) m.sk.boneTexture.needsUpdate = true;
      }
      if (m.g.parent !== scene) scene.add(m.g);
      m.g.matrixWorld.identity();
      m.g.visible = true;
    }
    set.age = 0; set.on = true; set.warm = warmOnly;
    set.mat.opacity = warmOnly ? 0 : 0.75;
    set.mat.userData.ghU.ghK.value = 1;
    if (!warmOnly) lastSnap = clock;
    return true;
  }
  function update(dt) {
    clock += dt;
    for (const set of pool) {
      if (!set || !set.on) continue;
      set.age += dt;
      const k = 1 - set.age / (set.warm ? 0.1 : life);
      if (k <= 0) { set.on = false; set.warm = false; for (const m of set.meshes) m.g.visible = false; continue; }
      // прозрачность гаснет мягче прежнего: остаток «съедает» растворение
      set.mat.opacity = set.warm ? 0 : 0.75 * Math.pow(k, 1.3);
      set.mat.userData.ghU.ghK.value = k;
    }
  }
  return {
    snap, update,
    setColor(hex) { col.copy(ghostCol(hex)); col2.copy(hotCol(col)); for (const s of pool) if (s) { s.mat.color.copy(col); s.mat.userData.ghU.ghC2.value.copy(col2); } },
    setQuality(q) { minGap = q === 'low' ? 0.3 : 0; },
    active() { return pool.filter((s) => s && s.on && !s.warm).length; },
    dispose() {
      disposed = true;
      for (const s of pool) {
        if (!s) continue;
        for (const m of s.meshes) { if (m.g.parent) m.g.parent.remove(m.g); }
        for (const sk of new Set(s.meshes.map((m) => m.sk))) if (sk.boneTexture) sk.boneTexture.dispose();
        s.mat.dispose();
      }
      pool.length = 0;
    },
  };
}
