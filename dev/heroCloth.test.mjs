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

// [W4-НАРЯДЫ] лепестки: разрезы снимают связи через промежуток — края соседних лепестков расходятся,
// а внутри лепестка ткань держит ширину; выпуклость (cup) и сплайн без перехода через разрез — без NaN
{
  root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
  const pc = 12, pr = 10, prest = new Float32Array(pc * pr * 3);
  for (let j = 0; j < pr; j++) for (let i = 0; i < pc; i++) {
    const t = j / (pr - 1), ph = 1.6 - (i / (pc - 1)) * 1.4;   // бок таза: азимут 1.6 → 0.2
    const r = 0.17 + 0.03 * t;
    prest.set([Math.sin(ph) * r, 1.05 - t * 0.45, Math.cos(ph) * r], (j * pc + i) * 3);
  }
  const pet = createCloth(THREE, {
    cols: pc, rows: pr, rest: prest, anchor: hips, parent: root, colliders, material: mat, name: 'petals',
    plane: 'none', cling: 3, pleats: 0, pleatDepth: 0, cup: 0.012, slits: { gaps: [3, 7], from: 3 }, hips, back: { lim: 0.03, h: 0.3 },
    fwd: (out) => out.set(0, 0, 1).applyQuaternion(root.quaternion), floor: () => 0,
  });
  let maxGap = 0, maxIn = 0;
  const d = (P, a, b) => Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
  const r0 = (a, b) => Math.hypot(prest[a * 3] - prest[b * 3], prest[a * 3 + 1] - prest[b * 3 + 1], prest[a * 3 + 2] - prest[b * 3 + 2]);
  for (let f = 0; f < 420; f++) {
    const dt = 1 / 60;
    if (f > 30 && f < 200) root.position.z += 5 * dt;            // бег
    if (f >= 200 && f < 260) root.rotation.y += 4 * dt;          // разворот: лепестки разлетаются
    kneeL.position.z = 0.02 + 0.14 * Math.sin(f * 0.3); kneeR.position.z = 0.02 - 0.14 * Math.sin(f * 0.3);
    root.updateMatrixWorld(true);
    pet.update(dt, 0);
    const P = pet.particles;
    assert.ok(finite(P), `лепестки: частицы конечны (кадр ${f})`);
    const j = pr - 1;
    // край лепестка у разреза 3|4 и внутри лепестка 1|2 (нижний ряд)
    maxGap = Math.max(maxGap, d(P, j * pc + 3, j * pc + 4) / r0(j * pc + 3, j * pc + 4));
    maxIn = Math.max(maxIn, d(P, j * pc + 1, j * pc + 2) / r0(j * pc + 1, j * pc + 2));
  }
  assert.ok(finite(pet.mesh.geometry.attributes.position.array), 'лепестки: сетка отрисовки конечна');
  assert.ok(maxIn < 1.25, `внутри лепестка ткань держит ширину (растяжение ×${maxIn.toFixed(2)})`);
  assert.ok(maxGap > maxIn + 0.15, `через разрез лепестки расходятся (×${maxGap.toFixed(2)} против ×${maxIn.toFixed(2)})`);
  pet.dispose();
}

// [W4-НАРЯДЫ] кувырок: таз делает полный оборот вперёд за 0,3 с — полы с «памятью формы» (home) через 1,5 с
// снова на своих местах (не застряли за бёдрами), без памяти — как раньше (проверяем только конечность)
{
  const roll = (home) => {
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); hips.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
    const pc = 12, pr = 10, prest = new Float32Array(pc * pr * 3);
    for (let j = 0; j < pr; j++) for (let i = 0; i < pc; i++) { const t = j / (pr - 1), ph = 1.6 - (i / (pc - 1)) * 1.4, r = 0.17 + 0.03 * t; prest.set([Math.sin(ph) * r, 1.05 - t * 0.45, Math.cos(ph) * r], (j * pc + i) * 3); }
    const pet = createCloth(THREE, { cols: pc, rows: pr, rest: prest, anchor: hips, parent: root, colliders, material: mat, plane: 'none', cling: 3, pleats: 0, pleatDepth: 0, slits: { gaps: [3, 7], from: 2 }, react: true, home, hips, fwd: (out) => out.set(0, 0, 1), floor: () => 0 });
    for (let f = 0; f < 120; f++) {
      if (f >= 10 && f < 28) hips.rotation.x += (Math.PI * 2) / 18;   // кувырок вперёд
      root.updateMatrixWorld(true);
      pet.update(1 / 60, 0);
    }
    hips.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
    for (let f = 0; f < 90; f++) pet.update(1 / 60, 0);
    const P = pet.particles;
    assert.ok(finite(P), 'кувырок: частицы конечны');
    let err = 0; for (let k = pc; k < pc * pr; k++) err += Math.hypot(P[k * 3] - prest[k * 3], P[k * 3 + 1] - prest[k * 3 + 1], P[k * 3 + 2] - prest[k * 3 + 2]);
    pet.dispose();
    return err / (pc * pr - pc);
  };
  const withHome = roll(3);
  assert.ok(withHome < 0.03, `после кувырка полы на местах (среднее отклонение ${withHome.toFixed(3)} м)`);
  roll(0);
}

// [W4-НАРЯДЫ] движение: на бегу плащ отдувает назад сильнее, чем в покое; рывок — всплеск; «Уменьшенное
// движение» — спокойнее (меньше отдув и трепет, без всплеска)
{
  const runCape = (calmK, sprint = false) => {
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
    const cc = 9, cr2 = 12, crest = new Float32Array(cc * cr2 * 3);
    for (let j = 0; j < cr2; j++) for (let i = 0; i < cc; i++) crest.set([(i / (cc - 1) - 0.5) * 0.45, 1.45 - (j / (cr2 - 1)) * 0.9, -0.2 - 0.03 * (j / (cr2 - 1))], (j * cc + i) * 3);
    const cape = createCloth(THREE, { cols: cc, rows: cr2, rest: crest, anchor: hips, parent: root, colliders, material: mat, plane: 'back', react: true, hips, back: { lim: 0.03, h: 0.4 }, fwd: (out) => out.set(0, 0, 1).applyQuaternion(root.quaternion), floor: () => 0 });
    cape.setMotion(calmK);
    const behind = () => { const P = cape.particles, hp = hips.getWorldPosition(new THREE.Vector3()); let s2 = 0; for (let i = 0; i < cc; i++) s2 += hp.z - P[((cr2 - 1) * cc + i) * 3 + 2]; return s2 / cc; };
    let rest0 = 0, run = 0, burstMax = 0, flutVar = 0, prevB = null;
    for (let f = 0; f < 360; f++) {
      const dt = 1 / 60;
      if (f >= 120 && f < 260) root.position.z += (sprint ? 8.2 : 5) * dt;
      if (f >= 262 && f < 275 && !sprint) root.position.z += 16 * dt;          // рывок 16 м/с (3,6 м за 0,22 с)
      root.updateMatrixWorld(true);
      cape.update(dt, 0);
      if (f === 118) rest0 = behind();
      if (f > 200 && f < 258) { const b = behind(); run += b / 57; if (prevB !== null) flutVar += Math.abs(b - prevB); prevB = b; }   // трепет — сумма скачков подола
      burstMax = Math.max(burstMax, cape.motion.burst);
      assert.ok(finite(cape.particles), `плащ: частицы конечны (кадр ${f})`);
    }
    cape.dispose();
    return { rest0, run, burstMax, flutVar };
  };
  const full = runCape(1), calm = runCape(0.4);
  assert.ok(full.run > full.rest0 + 0.05, `на бегу плащ отдувает назад (${full.rest0.toFixed(3)} → ${full.run.toFixed(3)} м)`);
  assert.ok(full.burstMax > 0.5, `рывок даёт всплеск (${full.burstMax.toFixed(2)})`);
  assert.equal(calm.burstMax, 0, '«Уменьшенное движение»: без всплеска');
  assert.equal(runCape(1, true).burstMax, 0, 'спринт 8,2 м/с — не рывок: без всплеска');
  // 165 Гц с ограничением до 55 кадров/с: положение — шагами симуляции 1/120 с (2–3 шага за кадр), спринт
  {
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.updateMatrixWorld(true);
    const cc = 7, cr3 = 8, rs = new Float32Array(cc * cr3 * 3);
    for (let j = 0; j < cr3; j++) for (let i = 0; i < cc; i++) rs.set([(i / (cc - 1) - 0.5) * 0.4, 1.4 - j * 0.1, -0.2], (j * cc + i) * 3);
    const c2 = createCloth(THREE, { cols: cc, rows: cr3, rest: rs, anchor: hips, parent: root, colliders, material: mat, plane: 'back', react: true, hips, back: { lim: 0.03, h: 0.4 }, fwd: (out) => out.set(0, 0, 1), floor: () => 0 });
    let simT = 0, simZ = 0, bMax = 0;
    for (let f = 0; f < 330; f++) {
      const dt = 1 / 55, tEnd = (f + 1) * dt;
      while (simT + 1 / 120 <= tEnd) { simT += 1 / 120; simZ += 8.2 / 120; }
      root.position.z = simZ; root.updateMatrixWorld(true);
      c2.update(dt, 0);
      if (f > 60) bMax = Math.max(bMax, c2.motion.burst);
    }
    c2.dispose();
    assert.ok(bMax < 0.05, `спринт шагами симуляции на 55 кадрах/с — без всплеска (${bMax.toFixed(3)})`);
  }
  assert.ok(calm.run < full.run, `«Уменьшенное движение»: отдув меньше (${calm.run.toFixed(3)} < ${full.run.toFixed(3)} м)`);
  assert.ok(calm.flutVar < full.flutVar, `«Уменьшенное движение»: трепет меньше (${calm.flutVar.toFixed(3)} < ${full.flutVar.toFixed(3)})`);
}
console.log('heroCloth.test: ok');
