// ASHEN OATH — [HERO] Остаточные образы рывка (как уклонения в BDO): силуэт героя в позе момента
// рывка остаётся в воздухе светящейся кромкой цвета стихии и гаснет за ~0.4 с.
// Без копий геометрии и без CPU-скиннинга: призрак — SkinnedMesh на той же геометрии со «замороженным»
// скелетом (копия матриц костей на момент снимка), в мировых координатах. Пул из нескольких наборов —
// без выделений в бою. Материал — аддитивная кромка (френель), глубину не пишет, теней нет.
//
// export: createAfterimages(THREE, { color, sets, life }) →
//   { snap(root, warmOnly), update(dt), setColor(hex), active(), dispose() }
//   warmOnly — невидимый снимок на 0.1 с при загрузке: шейдер призрака собирается сразу, а не на первом рывке.
//   root — модель героя (берутся видимые SkinnedMesh), scene — первый предок-сцена (ищется сам).

export function createAfterimages(THREE, { color = 0x9ff4ff, sets = 4, life = 0.42 } = {}) {
  const col = new THREE.Color(color);
  const pool = [];      // { meshes: [{ g, sk }], mat, age, on }
  let next = 0, disposed = false;
  function makeMat() {
    const m = new THREE.MeshBasicMaterial({ name: 'hero-afterimage', color: col.clone().multiplyScalar(1.6), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    m.onBeforeCompile = (sh) => {
      // у SkinnedMesh basic-шейдер считает нормали (USE_SKINNING) — кромка по силуэту
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vGhF;')
        .replace('#include <project_vertex>', `#include <project_vertex>
  #ifdef USE_SKINNING
    vGhF = 1.0 - abs( dot( normalize( transformedNormal ), normalize( - mvPosition.xyz ) ) );
  #else
    vGhF = 1.0;
  #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGhF;')
        .replace('#include <opaque_fragment>', `float ghK = 0.12 + 0.88 * pow( clamp( vGhF, 0.0, 1.0 ), 2.2 );
  outgoingLight *= ghK * 1.6;
  diffuseColor.a *= ghK;
  #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'heroAfterimage';
    return m;
  }
  function sceneOf(o) { let r = o; while (r && r.parent) r = r.parent; return r && r.isScene ? r : null; }
  // снимок: для каждой видимой кожи героя — призрак с копией матриц костей
  function snap(root, warmOnly = false) {
    if (disposed || !root) return false;
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
    set.mat.opacity = warmOnly ? 0 : 0.55;
    return true;
  }
  function update(dt) {
    for (const set of pool) {
      if (!set || !set.on) continue;
      set.age += dt;
      const k = 1 - set.age / (set.warm ? 0.1 : life);
      if (k <= 0) { set.on = false; set.warm = false; for (const m of set.meshes) m.g.visible = false; continue; }
      set.mat.opacity = set.warm ? 0 : 0.55 * k * k;
    }
  }
  return {
    snap, update,
    setColor(hex) { col.set(hex); for (const s of pool) if (s) s.mat.color.copy(col).multiplyScalar(1.6); },
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
