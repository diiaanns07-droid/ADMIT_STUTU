// [HAND] Тест modules/handVisuals.js на поддельном 2D-canvas (three.js — из node_modules или ASHEN_THREE=…/three.module.js,
// иначе SKIP): лук виден при натяжении; у героя свой лук (anchors.heroBow) — 3D-лука нет, дуга прицела есть; без ошибок.
// node dev/handVisuals.test.mjs
import { pathToFileURL } from 'node:url';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  if (process.env.ASHEN_THREE) { try { THREE = await import(pathToFileURL(process.env.ASHEN_THREE).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP handVisuals: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const mkCtx = () => new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
    if (k === 'getImageData' || k === 'createImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray((w || 1) * (h || 1) * 4) });
    if (k === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.document = globalThis.document || { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => mkCtx() }) };
const { createHandVisuals } = await import('../modules/handVisuals.js');

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const anc = (heroBow) => ({ heroHandL: { x: -0.25, y: 1.4, z: 0.4 }, heroHandR: { x: 0.2, y: 1.45, z: -0.1 }, heroChest: { x: 0, y: 1.3, z: 0 }, heroHead: { x: 0, y: 1.65, z: 0 }, heroBow });
const snap = (draw) => ({
  status: 'playing', projectiles: [],
  player: { position: { x: 0, y: 0, z: 0 }, yaw: 0, handSpell: { phase: 'idle' },
    bow: { active: true, phase: 'drawing', draw, aimX: 0, aimY: 0, charged: false, element: 'fire', launch: { from: { x: 0, y: 1.5, z: 0.5 }, vel: { x: 0, y: 4, z: 50 }, g: 9, assist: 'boss' } } },
});
function run(heroBow, frames = 40) {
  const hv = createHandVisuals({ THREE, scene: new THREE.Scene(), config: { settings: { quality: 'medium', reducedMotion: false } } });
  for (let i = 0; i < frames; i++) hv.update(1 / 60, snap(Math.min(1, i / 20)), [], anc(heroBow));
  return hv;
}

test('натяжение: 3D-лук виден, тетива и дуга прицела рисуются, ошибок нет', () => {
  const inf = run(false).info();
  ok(inf.bow === true && inf.heroBow === false, `bow ${inf.bow}`);
  ok(inf.ribbonVerts > 0 && inf.billboards > 0, `ribbon ${inf.ribbonVerts} bb ${inf.billboards}`);
  ok(inf.errors === 0, `errors ${inf.errors}`);
});
test('у героя свой лук (anchors.heroBow): 3D-лука нет (не два лука), дуга прицела остаётся', () => {
  const inf = run(true).info();
  ok(inf.bow === false && inf.heroBow === true, `bow ${inf.bow} heroBow ${inf.heroBow}`);
  ok(inf.ribbonVerts > 0, `дуга прицела: ribbon ${inf.ribbonVerts}`);
  ok(inf.billboards === 0, `свечение лука не рисуется: bb ${inf.billboards}`);
  ok(inf.errors === 0, `errors ${inf.errors}`);
});
test('герой сменился на рыцаря (heroBow → false): 3D-лук снова появляется', () => {
  const hv = run(true);
  for (let i = 0; i < 30; i++) hv.update(1 / 60, snap(1), [], anc(false));
  ok(hv.info().bow === true, 'лук вернулся');
});

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
