// [HERO] node-тест: карточки героев (C5/меню №8), классы материалов реалистичного шейдинга, таблицы переноса.
import assert from 'node:assert/strict';
import { HEROES, configureHeroes } from '../modules/heroModel.js';
import { classifyMaterial } from '../modules/heroShading.js';
import { RIGS } from '../modules/vrmKit.js';

// карточки: имя, класс, стихия, 3 строки описания
for (const [id, h] of Object.entries(HEROES)) {
  assert.equal(h.id, id);
  assert.ok(h.name && h.cls && h.element, `карточка ${id}`);
  assert.equal(Array.isArray(h.desc) && h.desc.length, 3, `3 строки описания у ${id}`);
  if (h.vrm) assert.match(h.vrm, /\.vrm$/);
}
assert.ok(HEROES.ashen && HEROES.elf && HEROES.dark, 'прежние герои на месте');
// [HERO] V7: у героинь — причёска (цвет, длина, чёлка), у чародейки спрятаны наплечники Ranger
for (const id of ['elf', 'dark', 'ranger']) {
  const h = HEROES[id].hair;
  assert.ok(h && Number.isFinite(h.color) && h.len > 0.3 && /^(straight|swept)$/.test(h.fringe), `волосы у ${id}`);
}
assert.ok(Array.isArray(HEROES.dark.hide) && HEROES.dark.hide.length, 'чародейка прячет наплечники Ranger');
assert.ok(HEROES.ashen.recolor && HEROES.ashen.fx.armorMode === 'seams', 'страж: воронёная сталь и свет по швам');
// ресницы у героинь; перекраска ткани не задевает металл (иначе «камуфляж» на наплечниках атласа 512²)
for (const id of ['elf', 'dark', 'ranger']) assert.ok(Number.isFinite(HEROES[id].lashes), `ресницы у ${id}`);
for (const id of ['elf', 'dark']) {
  const R = HEROES[id].recolor.MI_Ranger;
  assert.ok(R.some((r) => r.metal === 'only'), `${id}: своё правило для металла`);
  assert.ok(R.filter((r) => r.metal !== 'only').every((r) => r.metal === false), `${id}: ткань и кожа — без металла`);
}

// классы материалов VRoid
const C = classifyMaterial;
assert.equal(C('F00_000_00_Face_00_SKIN'), 'skin');
assert.equal(C('F00_002_02_Body_00_SKIN'), 'skin');
assert.equal(C('F00_000_Hair_00_HAIR_01'), 'hair');
assert.equal(C('F00_000_HairBack_00_HAIR'), 'hair');
assert.equal(C('F00_002_01_Onepice_01_CLOTH'), 'cloth');
assert.equal(C('F00_002_01_Shoes_01_CLOTH'), 'cloth');
assert.equal(C('F00_000_00_EyeIris_00_EYE'), 'iris');
assert.equal(C('F00_000_00_EyeHighlight_00_EYE'), 'eyeHi');
assert.equal(C('F00_000_00_EyeWhite_00_EYE'), 'eyeWhite');
assert.equal(C('F00_000_00_FaceEyelash_00_FACE'), 'lash');
assert.equal(C('F00_000_00_FaceBrow_00_FACE'), 'lash');
assert.equal(C('F00_000_00_FaceMouth_00_FACE'), 'mouth');
assert.equal(C('whatever'), 'other');

// таблицы переноса: KayKit покрывает корпус, руки и ноги; дочерние кости заданы
for (const [name, rig] of Object.entries(RIGS)) {
  const vr = new Set(rig.map((r) => r[0]));
  for (const b of ['hips', 'spine', 'chest', 'head', 'leftUpperArm', 'rightLowerArm', 'leftHand', 'rightUpperLeg', 'leftFoot']) assert.ok(vr.has(b), `${name}: ${b}`);
  for (const r of rig) if (r[2] !== 'delta') assert.ok(r[3] && r[4], `${name}: ${r[0]} без дочерней кости`);
}
configureHeroes({ shading: 'anime' }); configureHeroes({ shading: 'realistic' });
console.log('heroModel.test: ok');
