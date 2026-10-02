// [W4-ARENA] Тесты огней и воздуха арены (modules/arenaFx.js) и лунной дымки у пола (atmosphere.setGroundHaze).
// node dev/arenaFx.test.mjs
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE
// (…/three/build/three.module.js). Если three не найден, тест пропускается (код выхода 0).

import { pathToFileURL } from 'node:url';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  if (process.env.ASHEN_THREE) { try { THREE = await import(pathToFileURL(process.env.ASHEN_THREE).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP arenaFx: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const { createArenaFx, ARENA_FX_QUALITY, FIRE_MAX } = await import('../modules/arenaFx.js');
const { createAtmosphere, STORM } = await import('../modules/atmosphere.js');

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.stack}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const warn = console.warn; console.warn = () => {};

// 6 жаровен на ступени и 6 столпов у колонн — как в world.js
const FIRES = [];
for (const a of [150, 210, 330, 30, 90, 270]) { const r = (a * Math.PI) / 180; FIRES.push({ x: Math.sin(r) * 11.25, y: -0.3, z: Math.cos(r) * 11.25, kind: 'brazier' }); }
for (const a of [148, 163, 212, 252, 330, 30]) { const r = (a * Math.PI) / 180; FIRES.push({ x: Math.sin(r) * 16.3, y: -1, z: Math.cos(r) * 16.3, kind: 'torch' }); }
const RUINS = [148, 163, 197, 212, 108, 88, 50, 30].map((a) => { const r = (a * Math.PI) / 180; return { x: Math.sin(r) * 18, z: Math.cos(r) * 18, r: 0.9 }; });
function make(q = 'medium') {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  camera.position.set(0, 3, 13); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
  const owned = { g: new Set(), m: new Set() };
  const fx = createArenaFx({
    THREE, parent: scene, G: (g) => { owned.g.add(g); return g; }, M: (m) => { owned.m.add(m); return m; },
    fires: FIRES, ruins: RUINS, groundY: () => 0, quality: q, seed: 7331,
    materials: { stone: new THREE.MeshStandardMaterial(), iron: new THREE.MeshStandardMaterial(), coals: new THREE.MeshStandardMaterial() },
  });
  return { scene, camera, fx, owned };
}
const run = (fx, sec, t0, ctx) => { let t = t0; for (let i = 0; i < Math.round(sec * 60); i++) { t += 1 / 60; fx.update(1 / 60, t, ctx); } return t; };
const visLights = (scene) => { let n = 0; scene.traverse((o) => { if (o.isPointLight && o.visible) n++; }); return n; };

await test('сцена огней: 12 огней, 3 инстанса + пламя + воздух, свет пула по уровню', async () => {
  const { scene, fx } = make('medium');
  ok(fx.fires.length === 12, 'огней ' + fx.fires.length);
  const g = scene.getObjectByName('arena-fx');
  const inst = g.children.filter((o) => o.isInstancedMesh), pts = g.children.filter((o) => o.isPoints), mesh = g.children.filter((o) => o.isMesh && !o.isInstancedMesh);
  ok(inst.length === 3 && inst.every((m) => m.count === 12), 'инстансы ' + inst.map((m) => m.name + ':' + m.count).join(','));
  ok(pts.length === 1 && mesh.length === 1, 'одно пламя и одни точки на все огни');
  for (const q of ['low', 'medium', 'high']) {
    fx.setQuality(q);
    ok(visLights(scene) === ARENA_FX_QUALITY[q].lights, `${q}: видимых источников ${visLights(scene)}`);
  }
  fx.dispose();
  ok(!scene.getObjectByName('arena-fx'), 'dispose убрал группу');
});

await test('уровни качества: частиц и квадов пламени low < medium < high, дым только на high', async () => {
  const { fx } = make('low');
  const s = {};
  for (const q of ['low', 'medium', 'high']) { fx.setQuality(q); s[q] = fx.stats(); }
  ok(s.low.air > 0 && s.low.air < s.medium.air && s.medium.air < s.high.air, 'частицы ' + JSON.stringify([s.low.air, s.medium.air, s.high.air]));
  ok(s.low.air <= 120, 'на low воздух почти бесплатен: ' + s.low.air);
  ok(!s.low.smoke && !s.medium.smoke && s.high.smoke, 'дым');
  ok(s.low.refl === 0 && s.medium.refl === 1, 'штрихи-отражения выключены на low');
  const flames = fx.group.getObjectByName('arena-fire-flames');
  fx.setQuality('low'); const lowIdx = flames.geometry.drawRange.count;
  fx.setQuality('high'); const highIdx = flames.geometry.drawRange.count;
  ok(lowIdx === 12 * 2 * 6 && highIdx === 12 * 3 * 6, `квадов пламени: ${lowIdx / 6} / ${highIdx / 6}`);
  fx.dispose();
});

await test('пул света: едет к ближайшим к герою огням плавно, число видимых источников не меняется', async () => {
  const { scene, fx } = make('high');
  const near = { x: FIRES[0].x * 0.8, z: FIRES[0].z * 0.8 };
  let t = run(fx, 3, 0, { focus: near });
  let st = fx.stats();
  ok(st.lit.some(([i, w]) => i === 0 && w > 0.95), 'ближайшая жаровня освещена ' + JSON.stringify(st.lit));
  ok(fx.uniforms.uAFireA.value[0] < 0.06, 'у освещённого огня «нарисованный» свет пола убран: ' + fx.uniforms.uAFireA.value[0]);
  ok(fx.uniforms.uAFireA.value[3] === 1 || st.lit.some(([i]) => i === 3), 'у остальных — нарисованный свет');
  // герой перешёл на другую сторону: свет переезжает без скачков яркости
  const far = { x: FIRES[2].x * 0.8, z: FIRES[2].z * 0.8 };
  const lights = []; scene.traverse((o) => { if (o.isPointLight) lights.push(o); });
  let prev = lights.map((l) => l.intensity), maxJump = 0;
  const vis0 = visLights(scene);
  for (let i = 0; i < 240; i++) {
    t += 1 / 60; fx.update(1 / 60, t, { focus: far });
    lights.forEach((l, k) => { if (l.visible) maxJump = Math.max(maxJump, Math.abs(l.intensity - prev[k]) / 14); prev[k] = l.intensity; });
    ok(visLights(scene) === vis0, 'видимых источников всегда ' + vis0);
  }
  st = fx.stats();
  ok(st.lit.some(([i, w]) => i === 2 && w > 0.9), 'свет у новой ближайшей ' + JSON.stringify(st.lit));
  ok(maxJump < 0.2, 'без рывков: ' + maxJump.toFixed(3));
  fx.dispose();
});

await test('камера далеко от арены (прогулка) — пламя и воздух не рисуются, свет и блики в ноль', async () => {
  const { camera, fx } = make('high');
  let t = run(fx, 1, 0, { focus: { x: 0, z: 8 }, cam: camera });
  const flames = fx.group.getObjectByName('arena-fire-flames'), air = fx.group.getObjectByName('arena-air');
  ok(flames.visible && air.visible, 'у арены видно');
  camera.position.set(140, 5, 20);
  t = run(fx, 0.5, t, { focus: { x: 140, z: 20 }, cam: camera });
  ok(!flames.visible && !air.visible && fx.stats().far, 'далеко — скрыто');
  ok(fx.uniforms.uAFire.value.slice(0, 12).every((v) => v.w === 0), 'блики на полу погашены');
  camera.position.set(0, 3, 13);
  run(fx, 0.2, t, { focus: { x: 0, z: 8 }, cam: camera });
  ok(flames.visible && air.visible, 'вернулись — видно');
  fx.dispose();
});

await test('patchLit: цепляется за прежний onBeforeCompile, ключ программы с префиксом, uniform-ы огней на месте', async () => {
  const { fx } = make('medium');
  const mat = new THREE.MeshStandardMaterial();
  let prevCalled = false;
  mat.onBeforeCompile = (sh) => { prevCalled = true; sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\nfloat ashPud = 0.0;'); };
  mat.customProgramCacheKey = () => 'ashWet';
  fx.patchLit(mat, 'floor');
  fx.patchLit(mat, 'floor');   // повторно — без двойной вставки
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  mat.onBeforeCompile(sh, null);
  ok(prevCalled, 'прежний патч вызван');
  ok(sh.fragmentShader.includes('uniform vec4 uAFire[ ' + FIRE_MAX + ' ]') && sh.fragmentShader.split('uniform vec4 uAFire[').length === 2, 'объявления — один раз');
  ok(sh.fragmentShader.indexOf('#include <lights_fragment_end>') < sh.fragmentShader.indexOf('aSpec +='), 'свет огней — после lights_fragment_end');
  ok(sh.fragmentShader.includes('#define ARENA_TIER 1'), 'ярус medium');
  ok(sh.uniforms.uAFire && sh.uniforms.uRuneW && sh.uniforms.uASun && sh.uniforms.uAFireA.value.length === FIRE_MAX, 'uniform-ы');
  ok(mat.customProgramCacheKey() === 'arenaLit:floor1:ashWet', 'ключ ' + mat.customProgramCacheKey());
  const v0 = mat.version;
  fx.setQuality('low');
  ok(mat.customProgramCacheKey() === 'arenaLit:floor0:ashWet' && mat.version > v0, 'low — свой ключ программы, материал помечен');
  fx.dispose();
});

await test('лунная дымка у пола: по умолчанию нет, setGroundHaze(1) — видна на medium/high (серо-синяя), на low — нет', async () => {
  const mk = (q) => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
    camera.position.set(0, 3, 10); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
    return { scene, atmo: createAtmosphere({ THREE, scene, renderer: { toneMappingExposure: 1 }, camera, parent: scene, quality: q }) };
  };
  const runA = (atmo, sec, info) => { for (let t = 0; t < sec; t += 1 / 60) atmo.update(1 / 60, info); };
  const P1 = { stageW: 0, status: 'playing' }, P2 = { stageW: 1, status: 'playing' };
  const A = mk('medium');
  runA(A.atmo, 2, P1);
  const haze = A.scene.getObjectByName('storm-haze');
  ok(!haze.visible && A.atmo.storm.haze === 0, 'без вызова — скрыта (как раньше)');
  A.atmo.setGroundHaze(1);
  runA(A.atmo, 0.5, P1);
  ok(haze.visible && A.atmo.storm.haze === STORM.haze.medium, 'видна ' + JSON.stringify(A.atmo.storm));
  const c = haze.material.uniforms.uHazeCol.value;
  ok(c.b > c.r, 'в спокойной фазе — холодная ' + c.toArray().map((v) => v.toFixed(3)));
  ok(Math.abs(haze.material.uniforms.uHaze.value - STORM.haze.calm) < 1e-6, 'лёгкая: ' + haze.material.uniforms.uHaze.value);
  runA(A.atmo, 12, P2);
  ok(haze.material.uniforms.uHazeCol.value.r > haze.material.uniforms.uHazeCol.value.b, 'гроза — багровая');
  ok(A.atmo.skyU && A.atmo.skyU.uSun.value.isVector3 && A.atmo.skyU.uCorona.value.isColor, 'skyU для отражений');
  A.atmo.dispose();
  const L = mk('low');
  L.atmo.setGroundHaze(1);
  runA(L.atmo, 1, P1);
  ok(!L.scene.getObjectByName('storm-haze').visible, 'на low дымки нет (0 вызовов)');
  L.atmo.dispose();
});

console.warn = warn;
console.log(results.join('\n'));
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
