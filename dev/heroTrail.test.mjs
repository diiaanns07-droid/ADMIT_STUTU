// [HERO] node-тест шлейфа посоха (modules/heroTrail.js): медленно — не рисуется, взмах — лента видна,
// гаснет за life, телепорт сбрасывает ленту, вершины конечны.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroTrail: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createTrail } = await import('../modules/heroTrail.js');

const tr = createTrail(THREE, { color: 0x9d7bff, n: 12, sub: 3, life: 0.25 });
const a = new THREE.Vector3(), b = new THREE.Vector3(), dt = 1 / 60;
const finite = (arr) => arr.every(Number.isFinite);
const posOf = () => Array.from(tr.mesh.geometry.attributes.position.array);

// стоим: навершие неподвижно — ленты нет
for (let f = 0; f < 30; f++) { a.set(0, 1.8, 0); b.set(0, 1.5, 0); tr.push(a, b, 0, 1, dt); }
assert.equal(tr.mesh.visible, false, 'без взмаха шлейфа нет');

// взмах: дуга 6 м/с
for (let f = 0; f < 12; f++) {
  const ang = f * 0.12;
  a.set(Math.sin(ang) * 0.9, 1.2 + Math.cos(ang) * 0.9, 0); b.copy(a).multiplyScalar(0.7);
  tr.push(a, b, 6, 1, dt);
}
assert.equal(tr.mesh.visible, true, 'взмах рисует шлейф');
assert.ok(finite(posOf()), 'вершины конечны');
const aT = tr.mesh.geometry.attributes.aT.array;
assert.ok(aT[2] > 0.5, 'новый край яркий');
assert.ok(finite(Array.from(aT)), 'атрибуты конечны');

// остановились: за life лента гаснет
for (let f = 0; f < 20; f++) tr.push(a, b, 0, 1, dt);
assert.equal(tr.mesh.visible, false, 'шлейф гаснет после взмаха');

// телепорт: сброс, а не лента через карту
for (let f = 0; f < 5; f++) { a.x += 0.1; b.x += 0.1; tr.push(a, b, 6, 1, dt); }
a.set(50, 1.8, 50); b.set(50, 1.5, 50);
tr.push(a, b, 6, 1, dt);
assert.equal(tr.mesh.visible, false, 'после скачка лента начинается заново');
assert.ok(finite(posOf()));

const scene = new THREE.Scene(); scene.add(tr.mesh);
tr.dispose();
assert.equal(tr.mesh.parent, null, 'dispose убирает меш из сцены');
console.log('heroTrail.test: ok');
