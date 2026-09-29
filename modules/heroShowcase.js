// ASHEN OATH — [HERO] витрина героя в меню (экран выбора в духе BDO).
// Крупный герой в кинематографичном свете: тёплый ключевой (спереди-справа-сверху), холодный контровой
// (сзади-слева, отрисовывает силуэт), мягкий заполняющий и световое пятно на земле. Свет — шейдерный,
// только на материалах героев (heroShading.HERO_LIGHT): источники сцены не добавляются, поэтому при
// выходе из меню ничего не перекомпилируется и мир в бою не платит за лишние источники. Медленный облёт камеры
// по дуге перед героем, герой в стойке класса (HEROES[id].menuStance через heroModel.setStance).
// DOF и виньетку делает postfx №8 на 'high' (режим меню) — здесь только фокус на дистанцию до героя.
// Разметку карточки (имя, класс, стихия, описание) рисует ui.js №8 из HERO_OPTIONS.
//
// createHeroShowcase({ THREE, scene, heroRoot, heroModel, getPostfx, settings })
//   → { update(dt, active, camera) → true, если камера выставлена витриной; get weight; dispose() }
// Свет включается только в меню (active) и плавно гаснет при выходе в бой; тени витрина не бросает.

export function createHeroShowcase({ THREE, scene, heroRoot, heroModel = null, getPostfx = null, settings = {} } = {}) {
  const group = new THREE.Group();
  group.name = 'hero-showcase';
  scene.add(group);
  let HL = null;
  import('./heroShading.js').then((m) => { HL = m.HERO_LIGHT; }).catch(() => {});
  const key = { position: new THREE.Vector3() }, rim = { position: new THREE.Vector3() }, rim2 = { position: new THREE.Vector3() }, fill = { position: new THREE.Vector3() };
  // световое пятно на земле под героем (аддитивный круг)
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.35, 40),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uK: { value: 0 }, uColor: { value: new THREE.Color(0xffc890) }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // рунный круг пьедестала: мягкое пятно, три кольца, глифы по кольцу (вращаются), лучи между кольцами
      fragmentShader: `uniform float uK; uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
        const float TAU = 6.2831853;
        void main(){
          vec2 p = (vUv - 0.5) * 2.0; float r = length(p); float a = atan(p.y, p.x);
          float pool = pow(max(0.0, 1.0 - r), 2.2) * 0.55;
          float ring = smoothstep(0.014, 0.0, abs(r - 0.84)) + smoothstep(0.008, 0.0, abs(r - 0.75)) * 0.8 + smoothstep(0.007, 0.0, abs(r - 0.47)) * 0.7;
          float ar = a + uTime * 0.12;
          float sec = floor(ar / TAU * 28.0); float f = fract(ar / TAU * 28.0);
          float h = fract(sin(sec * 12.9898) * 43758.5453);
          float band = step(0.76, r) * step(r, 0.83);
          float glyph = band * step(0.2, f) * step(f, 0.8) * step(0.25, h) * smoothstep(0.02, 0.0, abs(r - (0.775 + 0.04 * h)) - 0.008 * (1.0 + h));
          glyph += band * smoothstep(0.03, 0.0, abs(f - 0.5) - 0.05) * step(0.6, h);
          float sp = step(0.48, r) * step(r, 0.74) * smoothstep(0.018, 0.0, abs(sin((a - uTime * 0.07) * 4.0))) * (0.4 + 0.6 * smoothstep(0.74, 0.5, r));
          float pulse = 0.85 + 0.15 * sin(uTime * 1.7);
          float c = (pool + (ring + glyph * 0.9 + sp * 0.5) * pulse) * smoothstep(1.0, 0.92, r);
          gl_FragColor = vec4(uColor * c * uK, c * uK);
        }`,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = 2;
  group.add(pool);

  const S = { w: 0, t: 0, angle: 0, stance: null };
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _tgt = new THREE.Vector3();
  const heroes = () => (heroModel && heroModel.heroes) || null;

  function place() {
    const hp = heroRoot.position, yaw = heroRoot.rotation.y;
    _f.set(Math.sin(yaw), 0, Math.cos(yaw));        // вперёд героя
    _r.set(-Math.cos(yaw), 0, Math.sin(yaw));        // вправо героя
    const at = (l, fwd, right, up) => l.position.copy(hp).addScaledVector(_f, fwd).addScaledVector(_r, right).setY(hp.y + up);
    at(key, 2.2, 1.5, 2.7);
    at(rim, -2.3, -1.2, 2.5);
    at(rim2, -2.0, 1.6, 1.4);
    at(fill, 1.6, -1.8, 1.2);
    pool.position.set(hp.x, hp.y + 0.02, hp.z);
  }

  function update(dt, active, camera) {
    S.t += dt;
    const want = active ? 1 : 0;
    if (S.t === dt && active) S.w = 1;               // первый кадр в меню — сразу полный свет
    S.w += (want - S.w) * (1 - Math.exp(-(active ? 3 : 6) * dt));
    const w = S.w;
    group.visible = w > 0.01;
    if (heroModel && heroModel.setStance) {
      const id = heroModel.hero;
      const st = active ? (heroModel.menuStance ? heroModel.menuStance(id) : null) : null;
      if (st !== S.stance) { S.stance = st; heroModel.setStance(st); }
      // выбран другой герой — короткий «выход» (жест силы), затем стойка
      if (active && heroModel.ready && id !== S.lastHero) {
        if (S.lastHero && heroModel.flourish) heroModel.flourish('CastRaise');
        S.lastHero = id;
      }
      // поза класса (лучницы: лук в руке, опущен наготове); вне меню позу задаёт ввод (main.js)
      const mp = active && heroModel.menuPose ? heroModel.menuPose(id) : null;
      if (mp) { heroModel.setPose(mp); S.posed = true; }
      else if (S.posed) { heroModel.setPose({ bowActive: false, bowDraw: 0, handSpell: 0 }); S.posed = false; }
    }
    if (!group.visible) {
      if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.setRGB(0, 0, 0); HL.heroRimColor.value.setRGB(0, 0, 0); HL.heroFillColor.value.setRGB(0, 0, 0); }
      return false;
    }
    place();
    pool.material.uniforms.uK.value = 0.9 * w;
    pool.material.uniforms.uTime.value = S.t;
    // цвет круга — стихия выбранного героя
    const fxc = heroModel && heroModel.heroFx ? heroModel.heroFx(heroModel.hero) : null;
    if (fxc && fxc.color !== S.poolHex) { S.poolHex = fxc.color; pool.material.uniforms.uColor.value.set(fxc.color); }
    if (!active || !camera) {
      if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.multiplyScalar(0.9); HL.heroRimColor.value.multiplyScalar(0.9); HL.heroFillColor.value.multiplyScalar(0.9); }
      return false;
    }
    // облёт: дуга ±32° перед героем, дистанция «по пояс», герой справа от панели меню
    const reduced = !!settings.reducedMotion;
    S.angle += dt * (reduced ? 0.03 : 0.11);
    const hp = heroRoot.position, yaw = heroRoot.rotation.y + 0.18 + 0.56 * Math.sin(S.angle);
    const dist = 2.8 + 0.18 * Math.sin(S.angle * 0.7);
    camera.position.set(hp.x + Math.sin(yaw) * dist, hp.y + 1.38 + 0.08 * Math.sin(S.angle * 0.5), hp.z + Math.cos(yaw) * dist);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    _tgt.set(hp.x - rx * 0.85, hp.y + 1.12, hp.z - rz * 0.85);
    camera.lookAt(_tgt);
    // шейдерный свет героев: направления на источники — в осях камеры
    if (HL && HL.heroKeyColor.value) {
      camera.updateMatrixWorld();
      const c = _p.copy(hp).setY(hp.y + 1.2);
      const q = settings.quality === 'low' ? 0.8 : 1;
      HL.heroKeyDir.value.copy(key.position).sub(c).normalize().transformDirection(camera.matrixWorldInverse);
      HL.heroRimDir.value.copy(rim.position).sub(c).normalize().transformDirection(camera.matrixWorldInverse);
      HL.heroKeyColor.value.setRGB(1.0, 0.82, 0.66).multiplyScalar(1.45 * w * q);
      HL.heroRimColor.value.setRGB(0.62, 0.78, 1.0).multiplyScalar(1.4 * w);
      HL.heroFillColor.value.setRGB(0.36, 0.4, 0.52).multiplyScalar(0.3 * w);
    }
    const pf = getPostfx && getPostfx();
    if (pf && typeof pf.setFocus === 'function') { try { _p.copy(hp).setY(hp.y + 1.2); pf.setFocus(camera.position.distanceTo(_p)); } catch (e) { /* ignore */ } }
    void heroes;
    return true;
  }

  function dispose() {
    scene.remove(group);
    pool.geometry.dispose(); pool.material.dispose();
    if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.setRGB(0, 0, 0); HL.heroRimColor.value.setRGB(0, 0, 0); HL.heroFillColor.value.setRGB(0, 0, 0); }
  }
  return { update, dispose, get weight() { return S.w; }, group };
}
