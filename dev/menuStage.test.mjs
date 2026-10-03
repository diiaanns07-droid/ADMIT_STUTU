// [W4-ВИТРИНА] node-тест сцены витрины (modules/menuStage.js) и витрины героя (modules/heroShowcase.js):
// сцена строится только в меню, источников света не добавляет, цена по уровню (частицы, обломки, дымка),
// волна и столп призыва показываются и гаснут, через 2 с вне меню всё освобождается (dispose) — в бою ни
// геометрии, ни материалов; витрина: поза-«визитка», импульсы postfx не на low, фокус DOF — на лице.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP menuStage: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createMenuStage, REFLECT_LAYER } = await import('../modules/menuStage.js');

const lights = (sc) => { let n = 0; sc.traverse((o) => { if (o.isLight) n++; }); return n; };
const meshes = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh || o.isPoints) n++; }); return n; };
const finite = (arr) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false; return true; };

// ---------------------------------------------------------------- сцена витрины
{
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  camera.position.set(0.5, 1.4, 2.8); camera.lookAt(0, 1.1, 0); camera.updateMatrixWorld();
  const st = createMenuStage({ THREE, scene, quality: 'low' });
  assert.equal(st.group.parent, scene, 'группа сцены в сцене');
  assert.equal(st.group.visible, false, 'до меню сцена скрыта');
  assert.equal(st.info().built, false, 'до меню ничего не построено (без prebuild)');
  const heroPos = new THREE.Vector3(3, 0, -4), key = new THREE.Vector3(4, 2.7, -2);
  const fx = { style: 'ember', color: 0xff7a2a, color2: 0xffd08a };
  const view = { w: 1, active: true, heroPos, heroYaw: 0.4, camera, fx, element: 'Пепел и пламя', key, appear: 0, loading: 0 };
  const disposed = [];
  assert.equal(st.update(1 / 30, view), true, 'в меню сцена работает');
  const I = st.info();
  assert.equal(I.built, true, 'сцена построена при входе в меню');
  assert.equal(st.group.visible, true, 'сцена видна');
  assert.equal(lights(scene), 1, 'сцена не добавляет источников света');
  assert.equal(I.lights, 0);
  assert.equal(I.mirror, null, 'на low отражения нет (без прохода)');
  // постоянные вызовы отрисовки: камень, пол, дымка, частицы, вихрь, ореол = 6; волна/столп скрыты
  let visible = 0;
  st.group.traverseVisible((o) => { if (o.isMesh || o.isPoints) visible++; });
  assert.equal(visible, 6, `6 вызовов отрисовки в покое, а не ${visible}`);
  for (const o of [...st.group.children, ...st.group.children.flatMap((c) => c.children)]) {
    if (o.geometry) o.geometry.addEventListener('dispose', () => disposed.push(o.name + ':g'));
    if (o.material) o.material.addEventListener('dispose', () => disposed.push(o.name + ':m'));
    if (o.geometry && o.geometry.attributes.position) assert.ok(finite(o.geometry.attributes.position.array), `${o.name}: вершины конечны`);
  }
  // треугольники камня (портал, колонны, обломки) в разумных пределах
  const stone = st.group.getObjectByName('menu-stage-stone');
  assert.ok(stone.geometry.attributes.position.count / 3 < 12000, 'камень — меньше 12 тыс. треугольников');
  assert.ok(stone.layers.test(Object.assign(new THREE.Layers(), { mask: 1 << REFLECT_LAYER })), 'портал в слое отражения');
  // цена по уровню
  const parts = st.group.getObjectByName('menu-stage-particles');
  assert.equal(parts.geometry.drawRange.count, 90, 'low: 90 частиц');
  st.setQuality('high');
  assert.equal(parts.geometry.drawRange.count, 420, 'high: 420 частиц');
  assert.equal(st.info().rocks, 22);
  st.setQuality('medium');
  assert.equal(parts.geometry.drawRange.count, 220, 'medium: 220 частиц');
  // стихия: пепел и угли → при смене героя частицы гаснут и сменяются льдом
  const pu = parts.material.uniforms;
  assert.deepEqual([pu.uKindA.value, pu.uKindB.value], [0, 1], 'пепел и пламя: угли и пепел');
  view.fx = { style: 'frost', color: 0xb58cff, color2: 0x9fe0ff }; view.element = 'Тьма и лёд';
  for (let i = 0; i < 30; i++) st.update(1 / 30, view);
  assert.deepEqual([pu.uKindA.value, pu.uKindB.value], [4, 5], 'тьма и лёд: кристаллы и огоньки');
  assert.ok(pu.uK.value < 1 && pu.uK.value >= 0, 'новые частицы проявляются плавно');
  assert.equal(st.group.getObjectByName('menu-stage-floor').material.uniforms.uK.value, 1, 'у частиц своя прозрачность, у сцены — своя');
  // руническая волна: кольцо видно, через 1,4 с гаснет
  st.wave();
  st.update(1 / 30, view);
  const waveFx = st.group.getObjectByName('menu-stage-wave');
  assert.equal(waveFx.visible, true, 'волна видна');
  assert.ok(st.group.getObjectByName('menu-stage-floor').material.uniforms.uWave.value > 0, 'волна бежит по полу');
  for (let i = 0; i < 50; i++) st.update(1 / 30, view);
  assert.equal(waveFx.visible, false, 'волна погасла');
  // призыв: столп и спираль частиц, пока грузится модель
  view.loading = 0.5;
  for (let i = 0; i < 30; i++) st.update(1 / 30, view);
  const column = st.group.getObjectByName('menu-stage-summon');
  assert.equal(column.visible, true, 'столп призыва виден');
  assert.ok(pu.uSummon.value > 0.5, 'частицы стянуты в спираль');
  view.loading = 0;
  for (let i = 0; i < 60; i++) st.update(1 / 30, view);
  assert.equal(column.visible, false, 'модель загрузилась — столп погас');
  // портал позади героя (в осях героя: −Z — за спиной)
  const pw = st.portalWorld(new THREE.Vector3());
  const local = st.group.worldToLocal(pw.clone());
  assert.ok(local.z < -5 && local.y > 2, 'портал за спиной героя и выше пола');
  // отражение героя: меши героя — в слой отражения
  const hero = new THREE.Group(); const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.8, 0.3), new THREE.MeshStandardMaterial());
  hero.add(body); st.setReflect(hero);
  assert.ok((body.layers.mask & (1 << REFLECT_LAYER)) !== 0, 'герой в слое отражения');
  assert.ok((body.layers.mask & 1) !== 0, 'и по-прежнему виден камере мира');
  // вне меню: скрыта сразу, через 2 с — освобождена
  view.w = 0; view.active = false;
  st.update(1 / 30, view);
  assert.equal(st.group.visible, false, 'вне меню скрыта');
  assert.equal(st.info().built, true, 'короткий выход — ещё не освобождена');
  for (let i = 0; i < 70; i++) st.update(1 / 30, view);
  assert.equal(st.info().built, false, 'через 2 с вне меню освобождена');
  assert.ok(disposed.length >= 14, `геометрии и материалы освобождены (${disposed.length})`);
  assert.equal(meshes(st.group), 0, 'в бою у сцены нет ни одного меша');
  // снова в меню — строится заново
  view.w = 1; view.active = true;
  st.update(1 / 30, view);
  assert.equal(st.info().built, true, 'возврат в меню — сцена снова есть');
  st.dispose();
  assert.equal(st.group.parent, null, 'dispose убирает сцену');
  assert.equal(lights(scene), 1, 'источники света сцены не тронуты');
  sun.dispose();
}

// ---------------------------------------------------------------- витрина героя
{
  const { createHeroShowcase } = await import('../modules/heroShowcase.js');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  const heroRoot = new THREE.Group(); heroRoot.position.set(1, 0, 2); heroRoot.rotation.y = 0.3; scene.add(heroRoot);
  const head = new THREE.Object3D(); head.position.set(0, 1.62, 0); heroRoot.add(head); heroRoot.updateMatrixWorld(true);
  const calls = { sig: [], flourish: [], pulse: [], focus: [] };
  const hm = {
    hero: 'ashen', ready: true,
    heroFx: (id) => ({ ashen: { style: 'ember', color: 0xff7a2a, color2: 0xffd08a }, dark: { style: 'frost', color: 0xb58cff, color2: 0x9fe0ff } })[id] || null,
    getAnchors: () => ({ head }), menuStance: () => null, menuPose: () => null, setStance() {}, setPose() {}, setGaze() {},
    flourish: (n) => calls.flourish.push(n), signaturePose: (id) => { calls.sig.push(id); return id === 'dark' ? 'Cast2' : 1.5; },
  };
  const pf = { setFocus: (m) => calls.focus.push(m), setBloomK() {}, pulse: (k) => { calls.pulse.push(k); return true; } };
  const settings = { quality: 'medium', reducedMotion: false };
  const sc = createHeroShowcase({ THREE, scene, heroRoot, heroModel: hm, getPostfx: () => pf, settings, dom: null });
  const step = (n, active = true) => { for (let i = 0; i < n; i++) sc.update(1 / 30, active, camera); };
  assert.ok(sc.stage && sc.stage.built, 'сцена витрины собрана сразу (шейдеры — общей сборкой мира)');
  step(6);
  assert.ok(sc.stage && sc.stage.built, 'витрина подключила сцену');
  assert.deepEqual(calls.sig, ['ashen'], 'первый герой — поза-«визитка»');
  assert.equal(calls.pulse.length, 0, 'первый показ — без импульсов экрана');
  assert.equal(calls.flourish.length, 0, 'визитка-число — без flourish');
  // фокус DOF — на лице
  const f = calls.focus[calls.focus.length - 1];
  const faceD = camera.position.distanceTo(head.getWorldPosition(new THREE.Vector3()).setY(1.57));
  assert.ok(Math.abs(f - faceD) < 0.15, `фокус на лице: ${f.toFixed(2)} ≈ ${faceD.toFixed(2)}`);
  step(120);
  const far = camera.position.distanceTo(heroRoot.position);
  // смена героя: загрузка (столп), появление — волна, импульсы, наезд к лицу
  hm.hero = 'dark'; hm.ready = false;
  step(30);
  assert.ok(sc.stage.summon > 0.3, 'пока грузится — призыв');
  hm.ready = true;
  step(1);
  assert.deepEqual(calls.sig, ['ashen', 'dark'], 'новый герой — его визитка');
  assert.deepEqual(calls.flourish, ['Cast2'], 'визитка-строка — клип через flourish');
  assert.deepEqual(calls.pulse.sort(), ['flash', 'shockwave'], 'medium: волна и засветка экрана');
  step(40);   // ~1,3 с: камера у лица
  const near = camera.position.distanceTo(heroRoot.position);
  assert.ok(near < far - 0.6, `наезд к лицу: ${near.toFixed(2)} < ${far.toFixed(2)}`);
  step(120);
  assert.equal(sc.stage.push, -1, 'наезд закончился');
  // low: без импульсов экрана
  settings.quality = 'low'; calls.pulse.length = 0;
  hm.hero = 'ashen'; step(2);
  assert.equal(calls.pulse.length, 0, 'low: без полноэкранных импульсов');
  // уход из меню: свет витрины гаснет, сцена освобождается
  step(120, false);
  assert.equal(sc.stage.built, false, 'в бою сцены витрины нет');
  const { HERO_LIGHT } = await import('../modules/heroShading.js');
  if (HERO_LIGHT.heroKeyColor.value) assert.ok(HERO_LIGHT.heroKeyColor.value.r + HERO_LIGHT.heroRimColor.value.r < 1e-3, 'свет витрины в бою = 0');
  sc.dispose();
}
console.log('menuStage: OK');
