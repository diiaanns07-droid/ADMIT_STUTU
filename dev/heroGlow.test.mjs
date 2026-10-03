// [W5-СВЕТ] node-тест «меньше неона на героях»: свечение на самом герое — цветной акцент по краю силуэта
// и на руках при заряде, а не белая заливка; герой целиком не попадает в bloom (порог postfx — яркость 1,0).
// Для каждого героя меню (HEROES, modules/heroModel.js):
//   • аура (modules/heroAura.js): цвет кромки и свет рук — не белые и приведены к одной яркости; кромка в меню,
//     в бою и в пике ярости ниже порога; вспышка «Ярость полна» — короткий всплеск не выше 1,2;
//     свет ладони при заряде ниже порога; волны вокруг тела — только у края силуэта;
//   • сцена витрины (modules/menuStage.js): цвета стихии не ярче пределов, сердцевина портала за головой ниже порога,
//     тёмные стихии (страж, чародейка) — без изменений;
//   • свет витрины (modules/heroShowcase.js → heroShading.HERO_LIGHT): контровой цветной и ниже порога,
//     ключ на светлых волосах эльфийки ниже порога; появление героя — без всплеска ключа.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroGlow: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createHeroAura, glowTint } = await import('../modules/heroAura.js');
const { createMenuStage, glowCap, STAGE_COL_L } = await import('../modules/menuStage.js');
const { HEROES } = await import('../modules/heroModel.js');

const L = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const sat = (c) => { const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx > 0 ? (mx - mn) / mx : 0; };
const BLOOM = 1.0;    // core/postfx.js: BLOOM.threshold (яркость Rec. 709 линейного HDR)
const HZB = 1.118;    // максимум множителя «сзади-сверху» кромки ауры (RIM_FRAG)
const ids = Object.keys(HEROES).filter((id) => HEROES[id].fx);
assert.ok(ids.length >= 5, `герои меню с fx: ${ids}`);

// ---------------------------------------------------------------- помощники цвета
{
  const c = glowTint(new THREE.Color(0x9ff4ff), 0.38);
  assert.ok(Math.abs(L(c) - 0.38) < 1e-3, `glowTint держит яркость: ${L(c)}`);
  assert.ok(sat(c) > sat(new THREE.Color(0x9ff4ff)), 'glowTint насыщает (не белый)');
  const a = new THREE.Color(0xff7a2a), a0 = a.clone();
  glowCap(a, 0.42);
  assert.ok(a.equals(a0), 'glowCap не трогает тёмный цвет');
  const e = glowCap(new THREE.Color(0xfff3c0), 0.5);
  assert.ok(Math.abs(L(e) - 0.5) < 1e-3, `glowCap режет яркость: ${L(e)}`);
}

// ---------------------------------------------------------------- аура: кромка, руки, волны
function auraOf(fx) {
  const scene = new THREE.Scene();
  const root = new THREE.Group(); scene.add(root);
  const model = new THREE.Group(); root.add(model);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.3), new THREE.MeshPhysicalMaterial({ name: 'MI_Body#real' }));
  body.position.y = 0.85; model.add(body);
  const handL = new THREE.Object3D(), handR = new THREE.Object3D();
  handL.position.set(-0.3, 1.0, 0.1); handR.position.set(0.3, 1.0, 0.1); model.add(handL, handR);
  const aura = createHeroAura(THREE, model, fx, { quality: 'high', height: 1.8 });
  const lib = THREE.ShaderLib.physical;
  const sh = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  body.material.onBeforeCompile(sh, null);
  let t = 5;
  const step = (snap, events = [], n = 1) => { for (let i = 0; i < n; i++) { t += 1 / 30; aura.tick(1 / 30, snap, events, null, { handL, handR }, false); aura.update(t); } };
  return { aura, sh, step, scene };
}
const rimLum = (A) => A.aura.state().rimK * L(A.sh.uniforms.heroAuraRimC.value) * HZB;
for (const id of ids) {
  const A = auraOf(HEROES[id].fx);
  assert.ok(A.sh.fragmentShader.includes('heroAuraRimK * hzF * hzF * hzF * hzF'), `${id}: кромка узкая (hzF⁴)`);
  A.step(null, [], 30);
  const rimC = A.sh.uniforms.heroAuraRimC.value, handC = A.sh.uniforms.heroAuraHandC.value;
  assert.ok(sat(rimC) >= 0.5, `${id}: кромка цветная, не белая (насыщенность ${sat(rimC).toFixed(2)})`);
  assert.ok(L(rimC) <= 0.4 && L(handC) <= 0.35, `${id}: цвета кромки и рук приглушены (${L(rimC).toFixed(2)}, ${L(handC).toFixed(2)})`);
  assert.ok(rimLum(A) < 0.3, `${id}: кромка в меню — акцент (${rimLum(A).toFixed(2)})`);
  // бой: ярость полна, готовность — кромка ниже порога и в пике пульса
  const P = { hp: 100, maxHp: 100, fury: 100, furyMax: 100, furyReady: true, encounter: 'engaged', speed: 0, velocity: { x: 0, z: 0 } };
  const snap = { status: 'playing', player: P };
  A.step(snap, [], 90);
  let peak = 0;
  for (let i = 0; i < 60; i++) { A.step(snap); peak = Math.max(peak, rimLum(A)); }
  assert.ok(peak < 0.75 * BLOOM, `${id}: кромка в пике ярости ниже порога bloom (${peak.toFixed(2)})`);
  // вспышка «Ярость полна» — короткий всплеск
  A.step(snap, [{ type: 'ultimate_ready', data: {} }], 1);
  const fl = rimLum(A);
  assert.ok(fl <= 1.2 && fl > peak, `${id}: вспышка заметна, но не белая (${fl.toFixed(2)})`);
  // заряд рук: свет ладони (центр кисти, к камере: hzF ≈ 0) ниже порога, на кромке кисти — акцент
  A.step(snap, [], 60);
  P.sigilCharge = 1; A.step(snap, [], 30);
  let hp = 0;
  for (let i = 0; i < 30; i++) { A.step(snap); const k = A.aura.state().handK; hp = Math.max(hp, Math.max(k[0], k[1]) * L(handC)); }
  assert.ok(hp > 0.3, `${id}: руки при заряде светятся (${hp.toFixed(2)})`);
  assert.ok(hp * 0.55 < 0.6 * BLOOM && hp * 1.45 < 1.6, `${id}: ладонь не белая: центр ${(hp * 0.55).toFixed(2)}, кромка ${(hp * 1.45).toFixed(2)}`);
  // волны вокруг тела — только у края силуэта
  let wave = null;
  A.scene.traverse((o) => { if (o.name === 'hero-aura-waves') wave = o; });
  assert.ok(wave && wave.material.fragmentShader.includes('ring * side * 0.85'), `${id}: волны — по краю силуэта, середина прозрачна`);
  assert.ok(L(wave.material.uniforms.uC1.value) <= 0.5 + 1e-3 && L(wave.material.uniforms.uC2.value) <= 0.6 + 1e-3, `${id}: цвета волн приглушены`);
  A.aura.dispose();
}

// ---------------------------------------------------------------- сцена витрины: цвета стихии и портал
{
  const scene = new THREE.Scene();
  const st = createMenuStage({ THREE, scene, quality: 'high' });
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 500); camera.position.set(0, 1.4, 3);
  const uCol = () => { let u = null; st.group.traverse((o) => { if (!u && o.material && o.material.uniforms && o.material.uniforms.uCol) u = o.material.uniforms; }); return u; };
  for (const id of ids) {
    const fx = HEROES[id].fx;
    const view = { w: 1, active: true, fx, element: id, heroPos: new THREE.Vector3(), heroYaw: 0, camera, key: new THREE.Vector3(2, 2.7, 2), appear: 0, loading: 0 };
    for (let i = 0; i < 120; i++) st.update(1 / 30, view);
    const u = uCol();
    assert.ok(u, 'юниформы сцены витрины');
    const c = u.uCol.value, c2 = u.uCol2.value;
    assert.ok(L(c) <= STAGE_COL_L[0] + 2e-3 && L(c2) <= STAGE_COL_L[1] + 2e-3, `${id}: цвета стихии на сцене не ярче пределов (${L(c).toFixed(2)}, ${L(c2).toFixed(2)})`);
    // сердцевина вихря портала за головой (menuStage VORTEX_FRAG: mix(c, c2, 0,7)·1,25 + полосы c·0,75·1,3)
    const core = L(c.clone().lerp(c2, 0.7)) * 1.25 + L(c) * 0.75 * 1.3 * 0.35;
    assert.ok(core < 1.05 * BLOOM, `${id}: сердцевина портала за головой не выжигает фон (${core.toFixed(2)})`);
    const raw = new THREE.Color(fx.color);
    if (L(raw) <= STAGE_COL_L[0]) assert.ok(Math.abs(L(c) - L(raw)) < 0.02, `${id}: тёмная стихия без изменений`);
  }
  st.dispose();
}

// ---------------------------------------------------------------- свет витрины на героях
{
  const { createHeroShowcase } = await import('../modules/heroShowcase.js');
  const { HERO_LIGHT, patchHeroLight } = await import('../modules/heroShading.js');
  patchHeroLight(THREE, new THREE.MeshStandardMaterial());   // юниформы света витрины создаются первым материалом героя
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  const heroRoot = new THREE.Group(); scene.add(heroRoot);
  const head = new THREE.Object3D(); head.position.set(0, 1.62, 0); heroRoot.add(head); heroRoot.updateMatrixWorld(true);
  const hm = {
    hero: ids[0], ready: true, heroFx: (id) => (HEROES[id] ? HEROES[id].fx : null),
    getAnchors: () => ({ head }), menuStance: () => null, menuPose: () => null, setStance() {}, setPose() {}, setGaze() {},
  };
  const pf = { setFocus() {}, setBloomK() {}, pulse: () => true };
  const sc = createHeroShowcase({ THREE, scene, heroRoot, heroModel: hm, getPostfx: () => pf, settings: { quality: 'high', reducedMotion: false }, dom: null });
  const step = (n) => { for (let i = 0; i < n; i++) sc.update(1 / 30, true, camera); };
  await new Promise((r) => setTimeout(r, 50));   // HERO_LIGHT — динамическим импортом heroShading
  step(90);
  const rimSteady = {};
  for (const id of ids) {
    hm.hero = id; hm.ready = false; step(3); hm.ready = true;
    // появление: всплеск ключа не больше 10 %, контровой ниже порога и в пике
    let keyPeak = 0, rimPeak = 0;
    for (let i = 0; i < 45; i++) { step(1); keyPeak = Math.max(keyPeak, L(HERO_LIGHT.heroKeyColor.value)); rimPeak = Math.max(rimPeak, L(HERO_LIGHT.heroRimColor.value)); }
    step(150);
    const key = HERO_LIGHT.heroKeyColor.value.clone(), rim = HERO_LIGHT.heroRimColor.value.clone();
    rimSteady[id] = L(rim);
    assert.ok(L(rim) < 0.8 * BLOOM, `${id}: контровой витрины мягкий (${L(rim).toFixed(2)})`);
    assert.ok(sat(rim) >= 0.3, `${id}: контровой цветной (насыщенность ${sat(rim).toFixed(2)})`);
    assert.ok(rimPeak < 1.2 * BLOOM, `${id}: контровой при появлении (${rimPeak.toFixed(2)})`);
    assert.ok(keyPeak <= L(key) * 1.1 + 1e-3, `${id}: появление без всплеска ключа (${keyPeak.toFixed(2)} при ${L(key).toFixed(2)})`);
    // светлые волосы (эльфийка) под ключом ниже порога: волос × ключ (рассеянный, N·L = 1)
    const hair = HEROES[id].hair && HEROES[id].hair.color != null ? new THREE.Color(HEROES[id].hair.color) : null;
    if (hair) { const hk = L(hair.multiply(key)); assert.ok(hk < 0.9 * BLOOM, `${id}: волосы под ключом витрины ниже порога (${hk.toFixed(2)})`); }
  }
  // тёмные стихии (страж, чародейка): контровой почти прежний (×1,9 цвета стихии)
  for (const id of ['ashen', 'dark']) if (rimSteady[id] != null) assert.ok(rimSteady[id] > 0.6, `${id}: контровой стража/чародейки не погашен (${rimSteady[id].toFixed(2)})`);
  sc.dispose();
}
console.log('heroGlow: ok');
