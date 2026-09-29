// [BDO] Тесты настроения зоны: modules/atmosphere.js setZoneMood (контракт C7 с №5 [FOREST]).
// node dev/bdo_mood.test.mjs
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE
// (…/three/build/three.module.js). Если three не найден, тест пропускается (код выхода 0).

import { pathToFileURL } from 'node:url';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  if (process.env.ASHEN_THREE) { try { THREE = await import(pathToFileURL(process.env.ASHEN_THREE).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP bdo_mood: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const { createAtmosphere, ZONE_MOODS, ZONE_MOOD_STATE } = await import('../modules/atmosphere.js');

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.stack}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const warn = console.warn; console.warn = () => {};
function make() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  camera.position.set(0, 3, 10);
  const renderer = { toneMappingExposure: 1 };   // PMREM упадёт мягко (нет WebGL) — IBL не нужен тесту
  const atmo = createAtmosphere({ THREE, scene, renderer, camera, parent: scene });
  return { scene, camera, renderer, atmo };
}
const run = (atmo, sec, info = {}) => { let out = null; for (let t = 0; t < sec; t += 1 / 60) out = atmo.update(1 / 60, info); return out; };

test('без настроения: экспозиция и туман как раньше', () => {
  const { atmo, renderer, scene } = make();
  const a = run(atmo, 1);
  ok(renderer.toneMappingExposure === 1, 'exposure ' + renderer.toneMappingExposure);
  ok(atmo.zoneMood === 0, 'mood ' + atmo.zoneMood);
  ok(ZONE_MOOD_STATE.w === 0, 'shared w');
  ok(Math.abs(a.keyIntensity - 3) < 1e-6, 'key ' + a.keyIntensity);
  ok(scene.fog.color.getHex() === 0x1c2530, 'fog ' + scene.fog.color.getHexString());
  atmo.dispose();
});

test('setZoneMood({weight:1}) плавно поднимает экспозицию и светлит туман', () => {
  const { atmo, renderer, scene } = make();
  run(atmo, 0.5);
  const fog0 = scene.fog.color.clone();
  atmo.setZoneMood({ weight: 1 });
  run(atmo, 1 / 60);
  ok(renderer.toneMappingExposure < 1.05, 'не скачком: ' + renderer.toneMappingExposure);
  const a = run(atmo, 6);
  ok(Math.abs(renderer.toneMappingExposure - ZONE_MOODS.brightForest.exposure) < 0.01, 'exposure ' + renderer.toneMappingExposure);
  ok(atmo.zoneMood > 0.99, 'w ' + atmo.zoneMood);
  const l0 = fog0.r + fog0.g + fog0.b, l1 = scene.fog.color.r + scene.fog.color.g + scene.fog.color.b;
  ok(l1 > l0 * 2, `туман светлее: ${l0.toFixed(3)} → ${l1.toFixed(3)}`);
  ok(a.keyIntensity > 3 * 1.4, 'ключ ярче ' + a.keyIntensity);
  ok(ZONE_MOOD_STATE.w > 0.99 && ZONE_MOOD_STATE.grade.sat > 1, 'грейд для postfx');
  atmo.dispose();
  ok(renderer.toneMappingExposure === 1, 'dispose вернул экспозицию');
});

test('weight 0 / null возвращает обратно; свои цвета и числа принимаются', () => {
  const { atmo, renderer, scene } = make();
  atmo.setZoneMood({ weight: 1, fog: { color: '#ff0000', density: 0.001 }, exposure: 2, sky: { top: 0x00ff00 } });
  run(atmo, 6);
  ok(scene.fog.color.r > 0.9 && scene.fog.color.g < 0.1, 'свой цвет тумана ' + scene.fog.color.getHexString());
  ok(Math.abs(renderer.toneMappingExposure - 2) < 0.02, 'своя экспозиция');
  atmo.setZoneMood({ weight: 0.5, fog: { color: '#ff0000' } });
  run(atmo, 6);
  ok(Math.abs(atmo.zoneMood - 0.5) < 0.01, 'w=0.5 ' + atmo.zoneMood);
  atmo.setZoneMood(null);
  run(atmo, 8);
  ok(atmo.zoneMood === 0, 'вернулись ' + atmo.zoneMood);
  ok(Math.abs(renderer.toneMappingExposure - 1) < 1e-6, 'exposure 1');
  ok(scene.fog.color.getHex() === 0x1c2530, 'туман затмения ' + scene.fog.color.getHexString());
  atmo.dispose();
});

test('мусор на входе не ломает', () => {
  const { atmo, renderer } = make();
  atmo.setZoneMood({ weight: NaN, sky: { top: {} }, fog: { density: -5 }, exposure: 'x', grade: { shadow: [1] } });
  run(atmo, 3);
  ok(Number.isFinite(renderer.toneMappingExposure), 'exposure конечна');
  atmo.setZoneMood('bad');
  run(atmo, 8);
  ok(atmo.zoneMood === 0, 'bad → 0');
  atmo.dispose();
});

console.warn = warn;
for (const r of results) console.log(r);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
