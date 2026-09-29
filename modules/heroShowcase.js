// ASHEN OATH — [HERO] витрина героя в меню (экран выбора в духе BDO).
// Крупный герой в кинематографичном свете: тёплый ключевой (спереди-справа-сверху), холодный контровой
// (сзади-слева, отрисовывает силуэт), мягкий заполняющий и световое пятно на земле. Свет — шейдерный,
// только на материалах героев (heroShading.HERO_LIGHT): источники сцены не добавляются, поэтому при
// выходе из меню ничего не перекомпилируется и мир в бою не платит за лишние источники. Медленный облёт камеры
// по дуге перед героем, герой в стойке класса (HEROES[id].menuStance через heroModel.setStance).
// DOF и виньетку делает postfx №8 на 'high' (режим меню) — здесь только фокус на дистанцию до героя.
// Разметку карточки (имя, класс, стихия, описание) рисует ui.js №8 из HERO_OPTIONS.
//
// Как на экране выбора BDO: колесо мыши (щипок на тач-экране, двойной клик) приближает камеру к лицу героя,
// перетаскивание поворачивает героя с инерцией; через 8 с без касания облёт плавно возвращается.
// События — только с холста (dom): над панелью меню их получает сама панель.
//
// createHeroShowcase({ THREE, scene, heroRoot, heroModel, getPostfx, settings, dom })
//   → { update(dt, active, camera) → true, если камера выставлена витриной; get weight; dispose() }
// Свет включается только в меню (active) и плавно гаснет при выходе в бой; тени витрина не бросает.

export function createHeroShowcase({ THREE, scene, heroRoot, heroModel = null, getPostfx = null, settings = {}, dom = null } = {}) {
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

  const S = { w: 0, t: 0, angle: 0, stance: null, active: false };
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _tgt = new THREE.Vector3();
  const _face = new THREE.Vector3(), _ft = new THREE.Vector3();

  // ---- приближение и поворот (ввод с холста)
  const U = { zoom: 0, zoomT: 0, yaw: 0, yawV: 0, idle: 99, faceOk: false, used: false };
  const ptrs = new Map();
  let pinch0 = 0;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const touched = () => { U.idle = 0; if (!U.used) { U.used = true; try { localStorage.setItem('ashen-oath.showcase-hint', '1'); } catch (e) { /* ignore */ } } };
  const onWheel = (e) => {
    if (!S.active) return;
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    U.zoomT = clamp01(U.zoomT - d * 0.0014); touched();
  };
  const onDown = (e) => {
    if (!S.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
    U.yawV = 0; touched();
  };
  const onMove = (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || !S.active) return;
    const dx = e.clientX - p.x;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      const k = 5.5 / Math.max(320, (dom && dom.clientWidth) || 1280);   // ширина холста ≈ 5.5 рад
      U.yaw += dx * k; U.yawV = U.yawV * 0.6 + dx * k * 60 * 0.4;
    } else if (ptrs.size === 2 && pinch0 > 0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      U.zoomT = clamp01(U.zoomT + (d - pinch0) * 0.004); pinch0 = d;
    }
    touched();
  };
  const onUp = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = 0; };
  const onDbl = () => { if (!S.active) return; U.zoomT = U.zoomT > 0.5 ? 0 : 1; touched(); };
  if (dom && dom.addEventListener) {
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('dblclick', onDbl);
    try { U.used = localStorage.getItem('ashen-oath.showcase-hint') === '1'; } catch (e) { /* ignore */ }
  }
  // подсказка в углу (пока игрок ни разу не приблизил/не повернул героя)
  let hint = null;
  if (dom && typeof document !== 'undefined' && dom.parentElement) {
    hint = document.createElement('div');
    hint.className = 'ao-showcase-hint';
    hint.textContent = 'Колесо — приблизить героя · перетащить — повернуть';
    hint.setAttribute('aria-hidden', 'true');
    Object.assign(hint.style, { position: 'absolute', right: '18px', bottom: '14px', fontSize: '13px', lineHeight: '1.3', fontFamily: 'inherit', letterSpacing: '0.04em', color: 'rgba(232,220,192,0.72)', textShadow: '0 1px 3px rgba(0,0,0,0.8)', pointerEvents: 'none', opacity: '0', transition: 'opacity 0.6s ease', zIndex: '1' });
    dom.parentElement.appendChild(hint);
  }
  const heroes = () => (heroModel && heroModel.heroes) || null;

  function place() {
    const hp = heroRoot.position, yaw = heroRoot.rotation.y;
    _f.set(Math.sin(yaw), 0, Math.cos(yaw));        // вперёд героя
    _r.set(-Math.cos(yaw), 0, Math.sin(yaw));        // вправо героя
    const at = (l, fwd, right, up) => l.position.copy(hp).addScaledVector(_f, fwd).addScaledVector(_r, right).setY(hp.y + up);
    // при приближении ключ уходит вбок и ниже — портретный свет (лицо лепится светотенью, а не заливается)
    const zk = U.zoom * U.zoom * (3 - 2 * U.zoom);
    at(key, 2.2 - 1.0 * zk, 1.5 + 0.9 * zk, 2.7 - 0.6 * zk);
    at(rim, -2.3, -1.2, 2.5);
    at(rim2, -2.0, 1.6, 1.4);
    at(fill, 1.6, -1.8, 1.2);
    pool.position.set(hp.x, hp.y + 0.02, hp.z);
  }

  function update(dt, active, camera) {
    S.t += dt;
    if (S.active && !active) { U.zoomT = 0; U.yaw = 0; U.yawV = 0; ptrs.clear(); if (heroModel && heroModel.setGaze) heroModel.setGaze(0); }
    S.active = !!active;
    // щипок на тач-экране: в меню жесты холста наши (не масштаб страницы), в бою — как было
    if (dom && dom.style && S.touchA !== S.active) { S.touchA = S.active; dom.style.touchAction = S.active ? 'none' : ''; }
    if (hint) { const show = active && !U.used && S.t > 3 ? '1' : '0'; if (hint.style.opacity !== show) hint.style.opacity = show; }
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
        S.lastHero = id; S.idleT = 0; S.nextGesture = 7 + Math.random() * 4;
      }
      // поза класса (лучницы: лук в руке, опущен наготове); вне меню позу задаёт ввод (main.js)
      const mp = active && heroModel.menuPose ? heroModel.menuPose(id) : null;
      // [HERO] жест на витрине раз в 10–16 с: маги вздымают посох, лучницы вскидывают лук и натягивают тетиву
      if (active && heroModel.ready && !settings.reducedMotion) {
        S.idleT = (S.idleT || 0) + dt;
        if (S.idleT > (S.nextGesture || 9) && U.zoom < 0.3) {
          S.idleT = 0; S.nextGesture = 10 + Math.random() * 6;
          if (mp) S.drawT = 2.2; else if (heroModel.flourish) heroModel.flourish('CastRaise');
        }
      }
      if (mp && U.zoom > 0.5) {
        // крупный план: лук убран за спину, руки свободны — лицо открыто
        if (S.posed !== 'zoom') { heroModel.setPose({ bowActive: false, bowDraw: 0, handSpell: 0 }); S.posed = 'zoom'; }
      } else if (mp) {
        let p = mp;
        if (S.drawT > 0) {
          S.drawT = Math.max(0, S.drawT - dt);
          const k = Math.sin(Math.PI * (1 - S.drawT / 2.2)) ** 0.8;
          p = { bowActive: true, bowDraw: mp.bowDraw + (0.9 - mp.bowDraw) * k, aim: { x: mp.aim.x + (0.15 - mp.aim.x) * k, y: mp.aim.y + (0.05 - mp.aim.y) * k } };
        }
        heroModel.setPose(p); S.posed = true;
      }
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
      if ((S.bloomK ?? 1) !== 1) { const pf0 = getPostfx && getPostfx(); if (pf0 && pf0.setBloomK) { try { pf0.setBloomK(1); } catch (e) { /* ignore */ } } S.bloomK = 1; }
      if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.multiplyScalar(0.9); HL.heroRimColor.value.multiplyScalar(0.9); HL.heroFillColor.value.multiplyScalar(0.9); }
      return false;
    }
    // облёт: дуга ±32° перед героем, дистанция «по пояс», герой справа от панели меню
    const reduced = !!settings.reducedMotion;
    S.angle += dt * (reduced ? 0.03 : 0.11);
    // приближение/поворот: инерция поворота, через 8 с без касания — обратно к облёту
    U.idle += dt;
    if (!ptrs.size) { U.yaw += U.yawV * dt; U.yawV *= Math.exp(-3.5 * dt); }
    if (U.idle > 8 && !ptrs.size) {
      U.yaw = Math.atan2(Math.sin(U.yaw), Math.cos(U.yaw));
      U.yaw *= Math.exp(-0.6 * dt);
    }
    U.zoom += (U.zoomT - U.zoom) * (1 - Math.exp(-5 * dt));
    const z = U.zoom * U.zoom * (3 - 2 * U.zoom);
    if (heroModel && heroModel.setGaze) heroModel.setGaze(z);
    const hp = heroRoot.position;
    // лицо героя (якорь головы), сглаженное — камера не трясётся вместе с дыханием
    const anc = heroModel && heroModel.getAnchors ? heroModel.getAnchors() : null;
    if (anc && anc.head && anc.head.parent) {
      anc.head.getWorldPosition(_ft); _ft.y -= 0.05;
      if (!U.faceOk || _face.distanceToSquared(_ft) > 1) { _face.copy(_ft); U.faceOk = true; }
      else _face.lerp(_ft, 1 - Math.exp(-4 * dt));
    } else _face.set(hp.x, hp.y + 1.58, hp.z);
    const yaw = heroRoot.rotation.y + (0.18 + 0.56 * Math.sin(S.angle)) * (1 - 0.6 * z) + U.yaw;
    const dist = (2.8 + 0.18 * Math.sin(S.angle * 0.7)) * (1 - z) + 0.64 * z;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // цель: «по пояс» (герой справа от панели меню) → лицо, сдвиг держит тот же угол от центра кадра
    const side = 0.85 * dist / 2.8;
    const cx = hp.x * (1 - z) + _face.x * z, cz = hp.z * (1 - z) + _face.z * z;
    const tgY = (hp.y + 1.12) * (1 - z) + (_face.y - 0.05) * z;
    const camY = (hp.y + 1.38 + 0.08 * Math.sin(S.angle * 0.5)) * (1 - z) + (_face.y + 0.01) * z;
    camera.position.set(cx + Math.sin(yaw) * dist, camY, cz + Math.cos(yaw) * dist);
    _tgt.set(cx - rx * side, tgY, cz - rz * side);
    camera.lookAt(_tgt);
    // шейдерный свет героев: направления на источники — в осях камеры
    if (HL && HL.heroKeyColor.value) {
      camera.updateMatrixWorld();
      const c = _p.copy(hp).setY(hp.y + 1.2);
      const q = settings.quality === 'low' ? 0.8 : 1;
      HL.heroKeyDir.value.copy(key.position).sub(c).normalize().transformDirection(camera.matrixWorldInverse);
      HL.heroRimDir.value.copy(rim.position).sub(c).normalize().transformDirection(camera.matrixWorldInverse);
      HL.heroKeyColor.value.setRGB(1.0, 0.82, 0.66).multiplyScalar(1.45 * w * q * (1 + 0.3 * U.zoom));   // портретный ключ сбоку — чуть ярче
      HL.heroRimColor.value.setRGB(0.62, 0.78, 1.0).multiplyScalar(1.4 * w);
      HL.heroFillColor.value.setRGB(0.36, 0.4, 0.52).multiplyScalar(0.3 * w);
    }
    const pf = getPostfx && getPostfx();
    if (pf && typeof pf.setBloomK === 'function') { const bk = 1 - 0.6 * z; if (Math.abs(bk - (S.bloomK ?? 1)) > 0.01) { S.bloomK = bk; try { pf.setBloomK(bk); } catch (e) { /* ignore */ } } }
    if (pf && typeof pf.setFocus === 'function') { try { _p.copy(hp).setY(hp.y + 1.2).lerp(_face, z); pf.setFocus(camera.position.distanceTo(_p)); } catch (e) { /* ignore */ } }
    void heroes;
    return true;
  }

  function dispose() {
    scene.remove(group);
    if (dom && dom.removeEventListener) {
      dom.removeEventListener('wheel', onWheel); dom.removeEventListener('pointerdown', onDown); dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp); dom.removeEventListener('pointercancel', onUp); dom.removeEventListener('dblclick', onDbl);
    }
    if (hint && hint.parentElement) hint.parentElement.removeChild(hint);
    pool.geometry.dispose(); pool.material.dispose();
    if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.setRGB(0, 0, 0); HL.heroRimColor.value.setRGB(0, 0, 0); HL.heroFillColor.value.setRGB(0, 0, 0); }
  }
  return { update, dispose, get weight() { return S.w; }, get zoom() { return U.zoom; }, setZoom(v) { U.zoomT = clamp01(v); }, setYaw(v) { U.yaw = v; U.yawV = 0; U.idle = 0; }, group };
}
