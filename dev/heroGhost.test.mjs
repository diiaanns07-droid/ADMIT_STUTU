// [HERO] node-тест остаточных образов рывка (modules/heroGhost.js): снимок кладёт в сцену призраков
// с копией матриц костей (поза момента снимка, а не текущая), гаснут за life, пул не растёт, dispose чистит.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroGhost: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createAfterimages } = await import('../modules/heroGhost.js');

// «герой»: две кости, два меша кожи на одном скелете
const scene = new THREE.Scene();
const model = new THREE.Group(); scene.add(model);
const b0 = new THREE.Bone(), b1 = new THREE.Bone(); b1.position.y = 1; b0.add(b1); model.add(b0);
const mkMesh = () => {
  const g = new THREE.BoxGeometry(0.2, 1, 0.2, 1, 2, 1);
  const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = g.attributes.position.getY(i) > 0 ? 1 : 0; sw[i * 4] = 1; }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
};
const skel = new THREE.Skeleton([b0, b1]);
const m1 = mkMesh(), m2 = mkMesh();
model.add(m1, m2); m1.bind(skel); m2.bind(skel);
scene.updateMatrixWorld(true);

const gh = createAfterimages(THREE, { color: 0xff7a2a, sets: 3, life: 0.4 });
// снимок в позе A
b1.rotation.z = 0.5; model.position.x = 0;
assert.equal(gh.snap(model), true, 'снимок сделан');
const ghosts = () => scene.children.filter((o) => o.name === 'hero-afterimage');
assert.equal(ghosts().length, 2, 'по призраку на меш кожи');
const g0 = ghosts()[0];
assert.notEqual(g0.skeleton, skel, 'свой (замороженный) скелет');
assert.equal(ghosts()[0].skeleton, ghosts()[1].skeleton, 'один замороженный скелет на общий исходный');
const frozen = Array.from(g0.skeleton.boneMatrices.slice(16, 32));
// герой ушёл и сменил позу — призрак остался в позе A
b1.rotation.z = -0.8; model.position.x = 3; scene.updateMatrixWorld(true); skel.update();
g0.skeleton.update();   // рендер зовёт update — у призрака он ничего не меняет
assert.deepEqual(Array.from(g0.skeleton.boneMatrices.slice(16, 32)), frozen, 'поза призрака заморожена');
assert.ok(Math.abs(frozen[12]) < 1e-6, 'кость снята на старом месте (x = 0)');
assert.equal(gh.active(), 1);
// гаснет
gh.update(0.2); assert.ok(g0.material.opacity > 0 && g0.material.opacity < 0.55, 'гаснет');
gh.update(0.25); assert.equal(g0.visible, false, 'погас за life'); assert.equal(gh.active(), 0);
// пул: много рывков — призраков не больше sets × мешей
for (let i = 0; i < 10; i++) { model.position.x = i; gh.snap(model); }
assert.equal(ghosts().length, 3 * 2, 'пул не растёт');
// прогрев: невидимый снимок не считается активным
gh.snap(model, true); assert.ok(gh.active() <= 3);
gh.dispose();
assert.equal(ghosts().length, 0, 'dispose убирает призраков из сцены');
console.log('heroGhost.test: ok');
