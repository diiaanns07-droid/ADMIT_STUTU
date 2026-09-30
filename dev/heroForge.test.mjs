// [HERO] node-тест кузницы (modules/heroForge.js): лук гнётся при натяжении — кончики тетивы идут к лучнику
// (+z) и внутрь, при bend(0) возвращаются, перехлёст (k < 0) уводит их вперёд; посох и стрела собираются.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroForge: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { buildBow, buildStaff, buildArrow } = await import('../modules/heroForge.js');

const m = new THREE.MeshStandardMaterial();
const M = { wood: m, metal: m, trim: m, leather: m, glow: m, crystal: m, inlay: m, fletch: m };
const bow = buildBow(THREE, M, { len: 1.3 });
assert.equal(typeof bow.bend, 'function', 'у лука есть bend');
const limbs = [];
bow.group.traverse((o) => { if (o.name === 'bow-limb') limbs.push(o); });
assert.equal(limbs.length, 2, 'два плеча на шарнирах');
const t0 = bow.tipT.clone(), b0 = bow.tipB.clone();
// шарнир у корня: плечо в покое совпадает с исходной формой
bow.group.updateMatrixWorld(true);
const anyLimbMesh = limbs[0].children[0].children[0];
assert.ok(anyLimbMesh && anyLimbMesh.isMesh, 'меш плеча под шарниром');

bow.bend(1);
assert.ok(bow.tipT.z > t0.z + 0.03 && bow.tipB.z > b0.z + 0.03, `кончики к лучнику (+z): ${bow.tipT.z.toFixed(3)} > ${t0.z.toFixed(3)}`);
assert.ok(bow.tipT.y < t0.y && bow.tipB.y > b0.y, 'кончики сходятся к рукояти');
assert.ok(Math.abs(bow.tipT.y + bow.tipB.y) < 1e-6 && Math.abs(bow.tipT.z - bow.tipB.z) < 1e-6, 'изгиб симметричен');
// длина плеча (от шарнира до кончика) сохраняется — поворот, а не растяжение
const pivT = limbs.find((l) => l.position.y > 0).position;
assert.ok(Math.abs(bow.tipT.distanceTo(pivT) - t0.distanceTo(pivT)) < 1e-6, 'плечо не растягивается');

bow.bend(0);
assert.ok(bow.tipT.distanceTo(t0) < 1e-9 && bow.tipB.distanceTo(b0) < 1e-9, 'bend(0) — исходная форма');
bow.bend(-0.3);
assert.ok(bow.tipT.z < t0.z && bow.tipB.z < b0.z, 'перехлёст после выстрела — вперёд (−z)');
bow.bend(5); const tMax = bow.tipT.clone(); bow.bend(1);
assert.ok(tMax.distanceTo(bow.tipT) < 1e-9, 'натяжение ограничено 1');

const staff = buildStaff(THREE, M, { style: 'crescent' });
assert.ok(staff.tip && staff.tip.isObject3D && staff.top > 0.5, 'посох: навершие и якорь');
const arrow = buildArrow(THREE, M, { len: 0.78 });
let n = 0; arrow.traverse((o) => { if (o.isMesh) n++; });
assert.ok(n >= 6, 'стрела: древко, наконечник, оперение');
console.log('heroForge.test: ok');
