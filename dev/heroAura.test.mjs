// [W4-АУРА] node-тест ауры героя (modules/heroAura.js): контровой rim вшивается в материалы героя (и в новые —
// после пересборки при смене качества), руна под ногами только в бою, ярость растит руну и искры, заполнение —
// вспышка, заряд рук светит кисти, оберег — золото, мало HP — красный пульс; бюджет по уровням качества
// (low: без волн, следов и пыли); dispose убирает всё.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroAura: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createHeroAura } = await import('../modules/heroAura.js');

// «герой»: корень в сцене, модель (масштаб), кожа на костях стоп, снаряжение, руки-якоря
const scene = new THREE.Scene();
const root = new THREE.Group(); scene.add(root);
const model = new THREE.Group(); model.scale.setScalar(0.97); root.add(model);
const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.3), new THREE.MeshPhysicalMaterial({ name: 'MI_Body#real' }));
body.position.y = 0.85; model.add(body);
const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02), new THREE.MeshStandardMaterial({ name: 'MI_Eyes#real' }));
eye.material.userData.heroKind = 'iris'; model.add(eye);
const glow = new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshBasicMaterial({ name: 'gear-core', blending: THREE.AdditiveBlending }));
model.add(glow);
const footL = new THREE.Object3D(), footR = new THREE.Object3D(), toeL = new THREE.Object3D(), toeR = new THREE.Object3D();
footL.position.set(-0.1, 0.08, 0); footR.position.set(0.1, 0.08, 0); toeL.position.set(0, -0.06, 0.12); toeR.position.set(0, -0.06, 0.12);
footL.add(toeL); footR.add(toeR); model.add(footL, footR);
const bones = { leftFoot: footL, rightFoot: footR, leftToes: toeL, rightToes: toeR };
const cur = { vrm: { humanoid: { getRawBoneNode: (n) => bones[n] || null } }, ghost: { q: null, setQuality(q) { this.q = q; } } };
const handL = new THREE.Object3D(), handR = new THREE.Object3D();
handL.position.set(-0.3, 1.0, 0.1); handR.position.set(0.3, 1.0, 0.1); model.add(handL, handR);
const anchors = { handL, handR };
const fx = { style: 'ember', color: 0xff7a2a, color2: 0xffd08a };

const aura = createHeroAura(THREE, model, fx, { quality: 'medium', height: 1.84 / 0.97 });
assert.ok(aura, 'аура создана');
const byName = (n) => { let r = null; scene.traverse((o) => { if (o.name === n) r = o; }); return r; };
assert.equal(aura.rune.parent, root, 'руна — на корне героя (не наклоняется с корпусом)');
assert.ok(byName('hero-aura-waves'), 'medium: волны вокруг тела есть');
assert.ok(byName('hero-footprints') && byName('hero-dash-burst'), 'medium: следы и пыль в сцене');

// rim: патч в материале тела, глаз и аддитивные — без патча
assert.equal(body.material.userData.heroAuraRim, true, 'тело получило rim');
assert.ok(body.material.customProgramCacheKey().startsWith('heroAuraRim:'), 'ключ программы с rim');
assert.ok(!eye.material.userData.heroAuraRim, 'радужка без rim');
assert.ok(!glow.material.userData.heroAuraRim, 'светящиеся аддитивные детали без rim');
// шейдер: вставки на месте на настоящем шаблоне three (physical)
const lib = THREE.ShaderLib.physical;
const sh = { uniforms: THREE.UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
body.material.onBeforeCompile(sh, null);
assert.ok(sh.vertexShader.includes('vHeroAuraW = ( modelMatrix'), 'вершинный: мировая точка для заряда рук');
assert.ok(sh.fragmentShader.includes('heroAuraRimK * hzF'), 'фрагментный: кромка стихии');
assert.ok(sh.fragmentShader.indexOf('uniform float heroAuraRimK') < sh.fragmentShader.indexOf('heroAuraRimK * hzF'), 'юниформы объявлены до кода');
assert.ok(sh.uniforms.heroAuraRimC && sh.uniforms.heroAuraHandL, 'юниформы героя подключены');

// меню: снимка нет — руны нет (на витрине свой пьедестал)
let t = 10;
const step = (snap, events = [], n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) { t += dt; aura.tick(dt, snap, events, cur, anchors, false); aura.update(t); } };
step(null, [], 20);
assert.equal(aura.state().rune, false, 'в меню руны нет');
assert.equal(cur.ghost.q, 'medium', 'качество передано остаточным образам');

// бой: руна появляется, ярость растит её и число искр
const P = { position: { x: 0, y: 0, z: 0 }, hp: 100, maxHp: 100, fury: 0, furyMax: 100, furyReady: false, encounter: 'engaged', speed: 0, velocity: { x: 0, z: 0 } };
const snap = { status: 'playing', player: P };
step(snap, [], 45);
const s0 = aura.state();
assert.equal(s0.rune, true, 'в бою руна под ногами');
P.fury = 80; step(snap, [], 60);
const s1 = aura.state();
assert.ok(s1.fury > 0.7, `ярость сглажена к 0.8: ${s1.fury}`);
assert.ok(s1.points > s0.points, `искр больше с яростью: ${s0.points} → ${s1.points}`);
assert.ok(s1.rimK > s0.rimK, 'кромка ярче с яростью');
assert.ok(aura.rune.scale.x > 0.85 * 1.15, 'руна выросла');
assert.equal(s1.waves, true, 'волны вокруг тела при накоплении ярости');
// заполнение: вспышка
P.fury = 100; P.furyReady = true;
step(snap, [{ type: 'ultimate_ready', data: { fury: 100 } }], 1);
assert.ok(aura.state().flash > 0.9, 'ultimate_ready — вспышка');
step(snap, [], 45);
assert.ok(aura.state().ready > 0.8, 'готовность держится');

// заряд рук: сомкнутые ладони — обе кисти, кулак — сильнее правая
P.sigilCharge = 0.9; step(snap, [], 20);
let hk = aura.state().handK;
assert.ok(hk[0] > 1 && hk[1] > 1, `ладони вместе — светятся обе: ${hk}`);
P.sigilCharge = 0; P.burstCharge = 0.8; step(snap, [], 40);
hk = aura.state().handK;
assert.ok(hk[1] > hk[0] * 1.5, `кулак — правая ярче: ${hk}`);
P.burstCharge = 0; step(snap, [], 40);
assert.ok(aura.state().handK[1] < 0.05, 'заряд снят — руки гаснут');

// оберег — золото; мало HP — красный пульс (в пике сердцебиения)
P.warded = true; step(snap, [{ type: 'ward_start', data: {} }], 20);
assert.ok(aura.state().guard > 0.8 && aura.state().stateK > 1, 'оберег — золотой ободок');
P.warded = false; P.hp = 12; step(snap, [], 60);
let peak = 0;
for (let i = 0; i < 40; i++) { step(snap, [], 1); peak = Math.max(peak, aura.state().stateK); }
assert.ok(aura.state().low > 0.5 && peak > 0.8, `мало HP — красный пульс: low ${aura.state().low}, пик ${peak}`);
P.hp = 100;

// рывок: пыль и искры (одна точка — пул не растёт)
step(snap, [{ type: 'player_dash', data: { worldDirection: { x: 0, y: 0, z: 1 } } }], 1);
assert.equal(aura.state().burst, true, 'рывок — пыль и искры');
step(snap, [], 60);
assert.equal(aura.state().burst, false, 'пыль осела');

// бег: стопа опускается и замирает — отпечаток
P.speed = 5.5; P.velocity = { x: 0, z: 5.5 };
for (let i = 0; i < 40; i++) {
  const ph = (i % 10) / 10;                                   // шаг 3 Гц: левая стоит первую половину цикла
  const up = (k) => Math.max(0, Math.sin(Math.PI * 2 * (ph + k))) * 0.18;
  root.position.z += 5.5 / 30;
  footL.position.set(-0.1, 0.08 + up(0.5), ph < 0.5 ? footL.position.z - 5.5 / 30 : 0.4);
  footR.position.set(0.1, 0.08 + up(0), ph >= 0.5 ? footR.position.z - 5.5 / 30 : 0.4);
  step(snap, [], 1);
}
assert.equal(aura.state().prints, true, 'на бегу — светящиеся следы');

// качество: low — без волн, следов и пыли; rim переживает пересборку материалов
const oldMat = body.material;
body.material = new THREE.MeshStandardMaterial({ name: 'MI_Body#real' });   // heroShading.setQuality('low')
aura.setQuality('low');
assert.equal(body.material.userData.heroAuraRim, true, 'новый материал сразу с rim');
assert.equal(byName('hero-aura-waves'), null, 'low: волн нет');
assert.equal(byName('hero-footprints'), null, 'low: следов нет');
assert.equal(byName('hero-dash-burst'), null, 'low: пыли нет');
step(snap, [], 2);
assert.equal(cur.ghost.q, 'low', 'low передан остаточным образам');
assert.ok(aura.state().points <= Math.round(64 * 0.6), 'low: частиц не больше 60%');
// low: только руна и частицы — ≤ 2 вызова отрисовки
let draws = 0;
scene.traverseVisible((o) => { if ((o.isMesh || o.isPoints) && o.material && !o.material.isMeshStandardMaterial && !o.material.isMeshBasicMaterial && o !== body) draws++; });
assert.ok(draws <= 2, `low: новых вызовов ≤ 2 (${draws})`);
oldMat.dispose();
aura.setQuality('high');
assert.ok(byName('hero-aura-waves') && byName('hero-footprints'), 'high: волны и следы вернулись');

// смерть: всё гаснет
snap.status = 'defeat'; step(snap, [], 60);
assert.equal(aura.state().rune, false, 'смерть — руна погасла');
assert.ok(aura.state().rimK < 0.05, 'смерть — кромка погасла');
// после поражения — снова меню: витрина с кромкой и искрами, не «мёртвая»
step(null, [], 60);
assert.ok(aura.state().rimK > 0.4, `меню после поражения — кромка вернулась: ${aura.state().rimK}`);

aura.dispose();
assert.equal(aura.rune.parent, null, 'dispose: руна снята');
assert.equal(byName('hero-aura-ember'), null, 'dispose: частицы сняты');
assert.equal(byName('hero-footprints'), null, 'dispose: следы сняты');
assert.equal(byName('hero-aura-waves'), null, 'dispose: волны сняты');
console.log('heroAura.test: ok');
