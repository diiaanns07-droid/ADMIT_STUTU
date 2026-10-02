// [W4-ВОЛОСЫ] node-тест причёсок героинь (modules/heroHair.js) на синтетической голове: геометрия без NaN,
// детали (выбившиеся волоски) срезаются на low, проходы и тени по качеству, смена качества не течёт
// (старые материалы освобождаются), пружина конечна, ограничена и затухает, «уменьшенное движение» —
// слабее, шейдерные вставки находят свои места в чанках three, dispose убирает всё и возвращает капюшон.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroHair: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { buildHair, hairHood } = await import('../modules/heroHair.js');
const { config } = await import('../config.js');

// ---------------------------------------------------------------- синтетический герой: кости, кожа головы, тело, капюшон
function makeHero() {
  const root = new THREE.Group(); root.name = 'holder';
  const bone = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); if (parent) parent.add(b); return b; };
  const hips = bone('hips', null, 0, 1.0, 0), spine = bone('spine', hips, 0, 0.12, 0), chest = bone('chest', spine, 0, 0.14, 0);
  const upperChest = bone('upperChest', chest, 0, 0.12, 0), neck = bone('neck', upperChest, 0, 0.12, 0), head = bone('head', neck, 0, 0.1, 0);
  const lUA = bone('leftUpperArm', upperChest, 0.18, 0.06, 0), rUA = bone('rightUpperArm', upperChest, -0.18, 0.06, 0);
  const lLA = bone('leftLowerArm', lUA, 0.04, -0.27, 0), rLA = bone('rightLowerArm', rUA, -0.04, -0.27, 0);
  const bones = [hips, spine, chest, upperChest, neck, head, lUA, rUA, lLA, rLA];
  const scene = new THREE.Group(); scene.add(hips); root.add(scene);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const skinned = (geo, bi, name) => {
    const n = geo.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const m = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial()); m.name = name;
    scene.add(m); m.bind(skeleton); return m;
  };
  const hw = head.getWorldPosition(new THREE.Vector3());
  // голова: эллипсоид вокруг кости головы (центр чуть выше), лицо — +z
  const hg = new THREE.SphereGeometry(1, 24, 16); hg.scale(0.075, 0.11, 0.095); hg.translate(hw.x, hw.y + 0.09, hw.z + 0.005);
  skinned(hg, 5, 'Female_Regular.001');
  // тело: цилиндр от таза до шеи на кости груди
  const cw = chest.getWorldPosition(new THREE.Vector3());
  const bg = new THREE.CylinderGeometry(0.13, 0.15, 0.62, 20, 6); bg.translate(cw.x, cw.y + 0.02, cw.z);
  skinned(bg, 2, 'Female_Ranger_Body');
  // капюшон: оболочка шире головы
  const hd = new THREE.SphereGeometry(1, 16, 12); hd.scale(0.1, 0.14, 0.12); hd.translate(hw.x, hw.y + 0.1, hw.z - 0.01);
  const hood = skinned(hd, 5, 'Female_Ranger_Head_Hood');
  root.updateMatrixWorld(true);
  const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
  const raw = (n) => byName[n] || null;
  const bp = {}; for (const b of bones) bp[b.name] = b.getWorldPosition(new THREE.Vector3());
  const bodyCaps = [
    { a: hips, b: upperChest, r: 0.17, name: 'hips' }, { a: upperChest, b: neck, r: 0.12, name: 'upperChest' },
    { a: lUA, b: lLA, r: 0.06, name: 'leftUpperArm' }, { a: rUA, b: rLA, r: 0.06, name: 'rightUpperArm' },
  ];
  return { root, vrm: { scene }, raw, bp, bodyCaps, head, hood };
}
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const finite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
function build(style, quality, extra = {}) {
  const H = makeHero();
  const hair = buildHair(THREE, {
    vrm: H.vrm, raw: H.raw, bp: H.bp, chestB: 'upperChest', torsoR: 0.15, bodyCaps: H.bodyCaps, LEFT: X, UP: Y, FWD: Z,
    holder: H.root, quality, atmosphere: null, hair: { color: 0x5e3420, len: 0.9, fringe: 'swept', style, ...extra },
  });
  return { H, hair };
}
const uOf = (hair) => hair.meshes[0].userData.hair.motion;

// ---------------------------------------------------------------- 1. геометрия по стилям
for (const style of ['elf', 'hime', 'ponytail']) {
  const { H, hair } = build(style, 'high', style === 'hime' ? {} : { hood: false });
  assert.ok(hair, `${style}: причёска собрана`);
  const info = hair.info();
  assert.equal(info.style, style);
  assert.ok(info.verts > 400, `${style}: вершин ${info.verts}`);
  assert.ok(info.tris < 30000, `${style}: треугольников ${info.tris} — в бюджете`);
  assert.ok(info.trisLow <= info.tris, `${style}: на low не больше, чем на high`);
  const g = hair.meshes[0].geometry;
  for (const k of ['position', 'normal', 'uv', 'color', 'hairW', 'hairT']) assert.ok(finite(g.attributes[k].array), `${style}: атрибут ${k} конечен`);
  // гибкость 0…1+, доля груди 0…1
  const W = g.attributes.hairW.array;
  for (let i = 0; i < W.length; i += 4) { assert.ok(W[i] >= 0 && W[i] <= 1, 'доля груди в 0…1'); assert.ok(W[i + 1] >= 0 && W[i + 1] <= 1.5, 'гибкость в 0…1.5'); }
  // направление волоса — единичное
  const T = g.attributes.hairT.array;
  for (let i = 0; i < T.length; i += 3) { const l = Math.hypot(T[i], T[i + 1], T[i + 2]); assert.ok(Math.abs(l - 1) < 1e-3, 'hairT — единичный вектор'); }
  assert.ok(H.root.children.includes(hair.meshes[0]) && H.root.children.includes(hair.meshes[1]), `${style}: меши в обёртке героя`);
  hair.dispose();
}

// ---------------------------------------------------------------- 2. качество: проходы, тень, срез деталей, освобождение материалов
{
  const { hair } = build('elf', 'low', { hood: false });
  const [core, soft] = hair.meshes;
  const g = core.geometry;
  assert.equal(soft.visible, false, 'low: без мягкой кромки (один вызов)');
  assert.equal(core.castShadow, false, 'low: без тени');
  assert.ok(g.drawRange.count < g.index.count, 'low: выбившиеся волоски срезаны');
  assert.ok(core.material.isMeshStandardMaterial && !core.material.isMeshPhysicalMaterial, 'low: MeshStandardMaterial');
  assert.equal(core.material.alphaToCoverage, true, 'low: alpha-to-coverage (MSAA холста)');
  const disposed = new Set();
  const watch = () => { for (const m of [core.material, core.customDepthMaterial, soft.material]) m.addEventListener('dispose', () => disposed.add(m)); };
  watch();
  const lowCore = core.material;
  hair.setQuality('high');
  assert.ok(disposed.has(lowCore), 'смена качества: старый материал освобождён');
  assert.ok(core.material.isMeshPhysicalMaterial, 'high: MeshPhysicalMaterial');
  assert.equal(soft.visible, true, 'high: мягкая кромка');
  assert.ok(soft.material.transparent && soft.material.depthWrite === false && soft.material.forceSinglePass, 'high: кромка прозрачная, одним проходом');
  assert.equal(core.castShadow, true, 'high: тень');
  assert.ok(!(g.drawRange.count < g.index.count), 'high: все детали');
  assert.ok(core.userData.noAO && soft.userData.noAO, 'карты не идут в проход нормалей GTAO');
  hair.setLod(2);
  assert.equal(soft.visible, false, 'LOD 2: один проход');
  assert.equal(core.castShadow, false, 'LOD 2: без тени');
  hair.setLod(0);
  hair.setQuality('medium'); hair.setQuality('medium');
  assert.equal(hair.info().tier, 'medium');
  hair.dispose();
}

// ---------------------------------------------------------------- 3. шейдерные вставки находят свои места в чанках three
{
  const { hair } = build('ponytail', 'high', { hood: false });
  const check = (mat, lib, need) => {
    const sh = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
    mat.onBeforeCompile(sh, null);
    for (const s of need) assert.ok(sh.vertexShader.includes(s) || sh.fragmentShader.includes(s), `${mat.name}: вставка «${s}»`);
    assert.ok(sh.uniforms.hairHead && sh.uniforms.hairCapA, `${mat.name}: юниформы движения`);
    return sh;
  };
  const core = hair.meshes[0].material, depth = hair.meshes[0].customDepthMaterial, soft = hair.meshes[1].material;
  const sc = check(core, THREE.ShaderLib.physical, ['hairMove( hairBase( position ) )', 'objectNormal = normalize( mix(', 'vHairT = normalize', '#define RE_Direct RE_Direct_Hair', 'hairKKSpec( hN, hV, heroKeyDir )', 'normal *= faceDirection', 'hLod']);
  assert.ok(sc.uniforms.hairSpec1 && sc.uniforms.heroKeyDir, 'юниформы блеска и света витрины');
  check(soft, THREE.ShaderLib.physical, ['discard;', 'RE_Direct_Hair']);
  const sd = check(depth, THREE.ShaderLib.depth, ['hairMove( hairBase( position ) )']);
  assert.ok(!sd.vertexShader.includes('vHairT = normalize') && sd.vertexShader.includes('#define HAIR_DEPTH'), 'тень: без лишних varying');
  assert.notEqual(core.customProgramCacheKey(), soft.customProgramCacheKey(), 'ядро и кромка — разные программы');
  hair.dispose();
}

// ---------------------------------------------------------------- 4. пружина: бег, рывок, поворот головы; затухание; уменьшенное движение
function motionPeak(rm) {
  config.settings = { reducedMotion: rm };
  const { H, hair } = build('ponytail', 'medium', { hood: false });
  const U = uOf(hair);
  let peakL = 0, peakA = 0;
  for (let f = 0; f < 420; f++) {
    const dt = 1 / 60;
    if (f > 30 && f < 150) H.root.position.z += 5 * dt;               // бег вперёд
    if (f >= 150 && f < 160) H.root.position.x += 12 * dt;            // рывок вбок
    H.head.rotation.y = f > 200 && f < 260 ? Math.sin((f - 200) / 60 * Math.PI) * 1.1 : 0;   // поворот головы
    H.root.updateMatrixWorld(true);
    hair.update(dt);
    assert.ok(finite(U.hairLin.value.toArray()) && finite(U.hairAng.value.toArray()), `пружина конечна (кадр ${f})`);
    peakL = Math.max(peakL, U.hairLin.value.length()); peakA = Math.max(peakA, U.hairAng.value.length());
    for (const c of U.hairCapA.value) assert.ok(finite(c.toArray()), 'капсулы конечны');
  }
  const settleL = U.hairLin.value.length(), settleA = U.hairAng.value.length();
  // телепорт: прыжок на 50 м — сброс, без выброса
  H.root.position.z += 50; H.root.updateMatrixWorld(true); hair.update(1 / 60);
  const afterJump = U.hairLin.value.length();
  // нулевой шаг (пауза) — ничего не ломает
  hair.update(0);
  hair.dispose();
  return { peakL, peakA, settleL, settleA, afterJump };
}
const full = motionPeak(false), calm = motionPeak(true);
assert.ok(full.peakL > 0.02, `на бегу и в рывке пряди отстают (${full.peakL.toFixed(3)})`);
assert.ok(full.peakL < 0.25, `смещение ограничено (${full.peakL.toFixed(3)})`);
assert.ok(full.peakA > 0.05 && full.peakA < 0.8, `поворот головы раскачивает пряди (${full.peakA.toFixed(3)})`);
assert.ok(full.settleL < 0.01 && full.settleA < 0.02, 'после остановки пружина затухает');
assert.ok(full.afterJump < 1e-6, 'телепорт — сброс пружины');
assert.ok(calm.peakL < full.peakL * 0.6 && calm.peakA < full.peakA * 0.6, `«уменьшенное движение» спокойнее (${calm.peakL.toFixed(3)} < ${full.peakL.toFixed(3)})`);
config.settings = null;

// ---------------------------------------------------------------- 5. капюшон и dispose
{
  const H = makeHero();
  const restore = hairHood(H.vrm, { hood: false });
  assert.equal(H.hood.visible, false, 'hood: false — капюшон скрыт');
  restore();
  assert.equal(H.hood.visible, true, 'restore — капюшон на месте');
  assert.equal(hairHood(H.vrm, { hood: true }), null, 'капюшон оставлен — ничего не трогаем');
  const { H: H2, hair } = build('hime', 'high');
  assert.equal(hair.info().hood, true);
  const geo = hair.meshes[0].geometry, mats = [hair.meshes[0].material, hair.meshes[1].material, hair.meshes[0].customDepthMaterial];
  let geoGone = false; geo.addEventListener('dispose', () => { geoGone = true; });
  const gone = new Set(); for (const m of mats) m.addEventListener('dispose', () => gone.add(m));
  hair.dispose();
  assert.ok(geoGone, 'dispose: геометрия освобождена');
  assert.equal(gone.size, 3, 'dispose: все материалы освобождены');
  assert.ok(!H2.root.children.some((o) => o.userData && o.userData.hair), 'dispose: меши сняты');
}
console.log('heroHair.test: ok');
