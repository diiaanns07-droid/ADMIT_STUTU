// ASHEN OATH — [HERO] витрина героя в меню (экран выбора в духе BDO).
// Крупный герой в кинематографичном свете: тёплый ключевой (спереди-справа-сверху), холодный контровой
// (сзади-слева, отрисовывает силуэт), мягкий заполняющий и световое пятно на земле. Медленный облёт камеры
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
  const key = new THREE.SpotLight(0xffd2a8, 0, 9, 0.52, 0.75, 1.6);
  key.name = 'showcase-key';
  const rim = new THREE.SpotLight(0x9cc6ff, 0, 9, 0.6, 0.6, 1.4);
  rim.name = 'showcase-rim';
  const rim2 = new THREE.SpotLight(0xffb070, 0, 8, 0.55, 0.7, 1.6);
  rim2.name = 'showcase-rim-warm';
  const fill = new THREE.PointLight(0x8aa0c8, 0, 7, 1.8);
  fill.name = 'showcase-fill';
  for (const l of [key, rim, rim2, fill]) { l.castShadow = false; group.add(l); }
  for (const l of [key, rim, rim2]) group.add(l.target);
  // световое пятно на земле под героем (аддитивный круг)
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.35, 40),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uK: { value: 0 }, uColor: { value: new THREE.Color(0xffc890) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uK; uniform vec3 uColor; varying vec2 vUv; void main(){ float r = length(vUv - 0.5) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.2) * uK; gl_FragColor = vec4(uColor * a * 0.55, a); }',
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
    for (const l of [key, rim, rim2]) l.target.position.set(hp.x, hp.y + 1.1, hp.z);
    pool.position.set(hp.x, hp.y + 0.02, hp.z);
  }

  function update(dt, active, camera) {
    S.t += dt;
    const want = active ? 1 : 0;
    S.w += (want - S.w) * (1 - Math.exp(-(active ? 3 : 6) * dt));
    const w = S.w;
    group.visible = w > 0.01;
    if (heroModel && heroModel.setStance) {
      const id = heroModel.hero;
      const st = active ? (heroModel.menuStance ? heroModel.menuStance(id) : null) : null;
      if (st !== S.stance) { S.stance = st; heroModel.setStance(st); }
    }
    if (!group.visible) return false;
    place();
    const q = settings.quality === 'low' ? 0.7 : 1;
    key.intensity = 140 * w * q;
    rim.intensity = 220 * w;
    rim2.intensity = 60 * w;
    fill.intensity = 10 * w;
    pool.material.uniforms.uK.value = 0.9 * w;
    if (!active || !camera) return false;
    // облёт: дуга ±32° перед героем, дистанция «по пояс», герой справа от панели меню
    const reduced = !!settings.reducedMotion;
    S.angle += dt * (reduced ? 0.03 : 0.11);
    const hp = heroRoot.position, yaw = heroRoot.rotation.y + 0.18 + 0.56 * Math.sin(S.angle);
    const dist = 3.05 + 0.2 * Math.sin(S.angle * 0.7);
    camera.position.set(hp.x + Math.sin(yaw) * dist, hp.y + 1.38 + 0.08 * Math.sin(S.angle * 0.5), hp.z + Math.cos(yaw) * dist);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    _tgt.set(hp.x - rx * 0.85, hp.y + 1.12, hp.z - rz * 0.85);
    camera.lookAt(_tgt);
    const pf = getPostfx && getPostfx();
    if (pf && typeof pf.setFocus === 'function') { try { _p.copy(hp).setY(hp.y + 1.2); pf.setFocus(camera.position.distanceTo(_p)); } catch (e) { /* ignore */ } }
    void heroes;
    return true;
  }

  function dispose() {
    scene.remove(group);
    pool.geometry.dispose(); pool.material.dispose();
    for (const l of [key, rim, rim2, fill]) l.dispose && l.dispose();
  }
  return { update, dispose, get weight() { return S.w; }, group };
}
