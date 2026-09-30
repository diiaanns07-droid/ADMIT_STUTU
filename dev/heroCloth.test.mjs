// [HERO] node-тест ткани (modules/heroCloth.js): полы мантии спереди (plane 'front'), прилегание (cling),
// кант (hem) — без NaN при рывках и остановках, полотнище не уходит назад между ног, кант следует за тканью.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroCloth: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createCloth } = await import('../modules/heroCloth.js');

// «тело»: таз на высоте 1 м, ноги — капсулы; герой смотрит в +z
const scene = new THREE.Scene();
const root = new THREE.Group(); scene.add(root);
const hips = new THREE.Object3D(); hips.position.set(0, 1, 0); root.add(hips);
const mk = (x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); root.add(o); return o; };
const kneeL = mk(0.09, 0.55, 0.02), kneeR = mk(-0.09, 0.55, 0.02), hipL = mk(0.09, 0.95, 0), hipR = mk(-0.09, 0.95, 0), footL = mk(0.09, 0.1, 0), footR = mk(-0.09, 0.1, 0);
const colliders = [{ a: hipL, b: kneeL, r: 0.09 }, { a: hipR, b: kneeR, r: 0.09 }, { a: kneeL, b: footL, r: 0.07 }, { a: kneeR, b: footR, r: 0.07 }];
root.updateMatrixWorld(true);

// переднее полотнище: 7×12, верх — дуга у пояса перед тазом
const cols = 7, rows = 12, rest = new Float32Array(cols * rows * 3);
for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
  const t = j / (rows - 1), ph = 0.5 - (i / (cols - 1));
  const r = 0.15 + 0.02 * t;
  rest.set([Math.sin(ph) * r, 1.05 - t * 0.8, Math.cos(ph) * r], (j * cols + i) * 3);
}
const mat = new THREE.MeshBasicMaterial(), hemMat = new THREE.MeshBasicMaterial();
const cl = createCloth(THREE, {
  cols, rows, rest, anchor: hips, parent: root, colliders, material: mat, name: 'tabard',
  plane: 'front', cling: 3, hem: { r: 0.005, material: hemMat }, hips, back: { lim: 0.03, h: 0.3 },
  fwd: (out) => out.set(0, 0, 1).applyQuaternion(root.quaternion), floor: () => 0,
});
assert.equal(cl.mesh.name, 'tabard');
assert.ok(cl.hem && cl.hem.isMesh, 'кант создан');

// сценарий: стоим, бежим вперёд, резко стоп, рывок назад, разворот
const finite = (arr) => { for (let k = 0; k < arr.length; k++) if (!Number.isFinite(arr[k])) return false; return true; };
let minAhead = 1e9;
for (let f = 0; f < 600; f++) {
  const dt = 1 / 60;
  if (f > 60 && f < 240) root.position.z += 4 * dt;          // бег вперёд 4 м/с
  if (f >= 300 && f < 320) root.position.z -= 16 * dt;       // рывок назад 16 м/с
  if (f >= 400 && f < 460) root.rotation.y += 3 * dt;        // разворот
  kneeL.position.z = 0.02 + 0.12 * Math.sin(f * 0.3);        // шаг: колени вперёд-назад
  kneeR.position.z = 0.02 - 0.12 * Math.sin(f * 0.3);
  root.updateMatrixWorld(true);
  cl.update(dt, 0);
  const P = cl.particles;
  assert.ok(finite(P), `частицы конечны (кадр ${f})`);
  // полотнище спереди: частицы не уходят за ось таза назад (между ног)
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion), hp = hips.getWorldPosition(new THREE.Vector3());
  for (let k = cols; k < P.length / 3; k++) {
    const ahead = (P[k * 3] - hp.x) * fwd.x + (P[k * 3 + 2] - hp.z) * fwd.z;
    minAhead = Math.min(minAhead, ahead);
  }
}
assert.ok(minAhead > 0.0, `полотнище не заходит за ось таза (минимум ${minAhead.toFixed(3)} м)`);
assert.ok(finite(cl.mesh.geometry.attributes.position.array), 'сетка отрисовки конечна');
assert.ok(finite(cl.hem.geometry.attributes.position.array), 'кант конечен');
// кант лежит у края ткани: его вершины не дальше 2 см от сетки
{
  const hp = cl.hem.geometry.attributes.position.array, gp = cl.mesh.geometry.attributes.position.array;
  let worst = 0;
  for (let k = 0; k < hp.length; k += 15) {
    let best = 1e9;
    for (let q = 0; q < gp.length; q += 3) best = Math.min(best, Math.hypot(hp[k] - gp[q], hp[k + 1] - gp[q + 1], hp[k + 2] - gp[q + 2]));
    worst = Math.max(worst, best);
  }
  assert.ok(worst < 0.02, `кант у края ткани (${worst.toFixed(4)} м)`);
}
cl.dispose();
assert.equal(cl.mesh.parent, null); assert.equal(cl.hem.parent, null);
console.log('heroCloth.test: ok');
