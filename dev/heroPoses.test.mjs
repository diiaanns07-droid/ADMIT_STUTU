// [W4-ПОЗЫ] node-тест слоя поз героя (modules/heroPoses.js) на синтетическом скелете (покой — единичные
// повороты, как у нормализованных костей VRM): визитки, переходы без рывков, стопы на месте при смене
// опорной ноги, IK рук достаёт цель, каст-позы жестов, победа/поражение, события соперника, без NaN,
// бюджет CPU; кости лица rigFace — в покое ничего не сдвигают, улыбка поднимает уголки рта.
// three.js: `three` из node_modules, ASHEN_THREE или vendor/ (без SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let THREE = null;
for (const c of [process.env.ASHEN_THREE, join(HERE, '../vendor/npm/three@0.185.1/build/three.module.min.js')]) {
  if (THREE || !c || !existsSync(c)) continue;
  try { THREE = await import(pathToFileURL(c).href); } catch (e) { /* дальше */ }
}
if (!THREE) { try { THREE = await import('three'); } catch (e) { /* нет */ } }
assert.ok(THREE, 'three.js не найден (vendor/npm/three@0.185.1 или ASHEN_THREE)');
const P = await import('../modules/heroPoses.js');
const { HERO_ORDER } = await import('../modules/heroModel.js');

// ---------------------------------------------------------------- визитки и раскладка
for (const id of HERO_ORDER) {
  const s = P.signaturePose(id);
  assert.ok(s && s.id === id && s.title && s.stance && s.text, `визитка ${id}`);
}
assert.equal(P.signaturePose('nope'), null);
assert.equal(P.SIGNATURES.elf.bow, 'rest', 'эльфийка: лук у плеча');
assert.equal(P.SIGNATURES.ranger.bow, 'draw', 'лучница натягивает лук');
assert.equal(P.SIGNATURES.dark.orb.hand, 'L', 'чародейка: сфера на левой ладони');
assert.equal(P.SIGNATURES.archmage.orb.kind, 'storm', 'архимаг: буря в ладони');
assert.ok(P.POSE_LAYOUT.N > 60 && P.POSE_LAYOUT.ARM.length === 14);

// ---------------------------------------------------------------- синтетический герой (1,75 м)
function makeHero() {
  const root = new THREE.Group();
  const B = {};
  const bone = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); (parent || root).add(b); B[name] = b; return b; };
  bone('hips', null, 0, 0.95, 0);
  bone('spine', B.hips, 0, 0.1, 0); bone('chest', B.spine, 0, 0.12, 0); bone('upperChest', B.chest, 0, 0.12, 0);
  bone('neck', B.upperChest, 0, 0.13, 0); bone('head', B.neck, 0, 0.1, 0);
  for (const [s, k] of [['left', 1], ['right', -1]]) {
    bone(`${s}Shoulder`, B.upperChest, 0.04 * k, 0.08, 0); bone(`${s}UpperArm`, B[`${s}Shoulder`], 0.12 * k, 0, 0);
    bone(`${s}LowerArm`, B[`${s}UpperArm`], 0.25 * k, 0, 0); bone(`${s}Hand`, B[`${s}LowerArm`], 0.24 * k, 0, 0);
    bone(`${s}UpperLeg`, B.hips, 0.09 * k, -0.05, 0); bone(`${s}LowerLeg`, B[`${s}UpperLeg`], 0, -0.43, 0.01); bone(`${s}Foot`, B[`${s}LowerLeg`], 0, -0.44, -0.03);
  }
  const rest = Object.fromEntries(Object.entries(B).map(([n, b]) => [n, { q: b.quaternion.clone(), p: b.position.clone() }]));
  // «клип»: руки опущены (A-поза), колени чуть согнуты
  const clip = () => {
    for (const [n, r] of Object.entries(rest)) { B[n].quaternion.copy(r.q); B[n].position.copy(r.p); }
    B.leftUpperArm.rotateZ(-1.25); B.rightUpperArm.rotateZ(1.25);
    B.leftLowerArm.rotateY(-0.2); B.rightLowerArm.rotateY(0.2);
    B.leftUpperLeg.rotateX(-0.08); B.leftLowerLeg.rotateX(0.16); B.rightUpperLeg.rotateX(-0.08); B.rightLowerLeg.rotateX(0.16);
    root.updateMatrixWorld(true);
  };
  return { root, B, clip, rig: { bones: B, hands: null, vrm: { scene: root }, model: root, height: 1.75, orientHand: null } };
}
const wp = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
const ctx = (patch = {}) => ({ P: { action: 'idle', hp: 100, maxHp: 100 }, snap: { status: 'playing', ultimate: null }, status: 'playing', menu: false, idleW: 1, standW: 1, bowW: 0, spellW: 0, mirrorW: 0, gaze: 0, lookTarget: null, staffR: false, bowHero: false, bowHeld: false, ...patch });
function frame(H, poses, dt, c, events = []) {
  H.clip();
  poses.events(events, false);
  poses.body(dt, c);
  poses.arms(dt, c);
  const want = poses.fingers({ left: { relax: 1 }, right: { relax: 1 } }, c);
  const E = poses.expression(dt, c);
  return { want, E };
}
const finite = (H) => Object.values(H.B).every((b) => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w, b.position.x, b.position.y, b.position.z].every(Number.isFinite));

{
  const H = makeHero();
  const poses = P.createHeroPoses(THREE, { quality: 'medium', heroId: 'dark', female: true });
  poses.bind(H.rig); poses.setHero('dark', { female: true, stance: 'none' });
  H.clip();
  const rest = { L: wp(H.B.leftFoot), R: wp(H.B.rightFoot), hips: wp(H.B.hips), handL: wp(H.B.leftHand), shL: wp(H.B.leftUpperArm) };
  const armLen = 0.25 + 0.24;

  // покой: смена опорной ноги — таз смещается к опорной, опорная стопа на месте, свободная — шаг вперёд
  const c0 = ctx();
  const seen = new Set();
  let checked = 0;
  for (let i = 0; i < 60 * 16; i++) {
    frame(H, poses, 1 / 60, c0);
    const st = poses.state();
    if (Math.abs(st.ws) > 0.99) {
      seen.add(Math.sign(st.ws));
      const weight = st.ws > 0 ? 'L' : 'R', free = weight === 'L' ? 'R' : 'L';
      const fw = wp(H.B[weight === 'L' ? 'leftFoot' : 'rightFoot']), ff = wp(H.B[free === 'L' ? 'leftFoot' : 'rightFoot']);
      assert.ok(fw.distanceTo(rest[weight]) < 0.004, `опорная стопа на месте (${fw.distanceTo(rest[weight]).toFixed(4)} м)`);
      assert.ok(ff.z - rest[free].z > 0.04, 'свободная нога — шаг вперёд');
      const hx = wp(H.B.hips).x - rest.hips.x;
      assert.ok(Math.sign(hx) === Math.sign(st.ws) && Math.abs(hx) > 0.02, 'таз — к опорной ноге');
      checked++;
    }
  }
  assert.deepEqual([...seen].sort(), [-1, 1], 'за 16 с опорная нога сменилась');
  assert.ok(checked > 100);
  assert.ok(finite(H));

  // переходы без рывков (перекрёст ≥ 0,12 с): щит → выброс → «Врата бури» → покой; на кадре смены действия
  // кисть проходит лишь малую долю пути
  const track = [];
  let maxJump = 0, maxSwitch = 0, prevAct = '';
  const run = (sec, c, evAt = null) => {
    for (let i = 0; i < Math.round(sec * 60); i++) {
      const ev = evAt && i === 0 ? evAt : [];
      const pL = wp(H.B.leftHand), pR = wp(H.B.rightHand);
      frame(H, poses, 1 / 60, c, ev);
      const dL = wp(H.B.leftHand).distanceTo(pL), dR = wp(H.B.rightHand).distanceTo(pR);
      const d = Math.max(dL, dR);
      maxJump = Math.max(maxJump, d);
      const a = poses.active;
      if (a !== prevAct) { maxSwitch = Math.max(maxSwitch, d); track.push(a); prevAct = a; }
    }
  };
  const cs = ctx({ P: { action: 'shield', shielding: true } });
  run(0.6, cs);
  assert.equal(poses.active, 'shield');
  {
    const h = wp(H.B.leftHand), s = wp(H.B.leftUpperArm);
    assert.ok(h.z - s.z > 0.82 * armLen, `щит: ладонь вперёд на вытянутой руке (${((h.z - s.z) / armLen).toFixed(2)})`);
    assert.ok(Math.abs(h.y - s.y) < 0.12, 'щит: ладонь на высоте плеча');
  }
  run(1.2, ctx(), [{ type: 'burst', data: { power: 0.8, both: true } }]);
  run(0.3, ctx({ P: { action: 'idle', sigilCharge: 0.6, sigilAxis: 'h' } }));
  assert.equal(poses.active, 'pray', 'заряд печати: ладони сомкнуты');
  {
    const d = wp(H.B.leftHand).distanceTo(wp(H.B.rightHand));
    assert.ok(d < 0.16, `ладони сомкнуты (${d.toFixed(3)} м)`);
  }
  run(0.45, ctx(), [{ type: 'sigil_cast', data: { sigil: 'gate', power: 0.9 } }]);
  {
    const d = Math.abs(wp(H.B.leftHand).x - wp(H.B.rightHand).x);
    assert.ok(d > 1.15, `«Врата бури»: руки в стороны (${d.toFixed(2)} м)`);
  }
  run(1.6, ctx());
  assert.equal(poses.active, '', 'после печати — покой');
  assert.ok(track.includes('burst') && track.includes('gate'));
  assert.ok(maxSwitch < 0.05, `смена действия без рывка (${maxSwitch.toFixed(3)} м за кадр)`);
  assert.ok(maxJump < 0.16, `нет скачков кисти (${maxJump.toFixed(3)} м за кадр)`);

  // «Столп небес» (после заряда): правая — над головой, левая — к земле
  run(0.6, ctx({ P: { action: 'idle', sigilCharge: 0.5, sigilAxis: 'v' } }));
  run(0.45, ctx(), [{ type: 'sigil_cast', data: { sigil: 'pillar', power: 0.9 } }]);
  assert.ok(wp(H.B.rightHand).y > wp(H.B.head).y + 0.1, 'столп: правая в небо');
  assert.ok(wp(H.B.leftHand).y < wp(H.B.hips).y + 0.12, 'столп: левая к земле');
  run(1.2, ctx());
  // «OK»-снаряд: правая выброшена вперёд; повтор залпа — без нового замаха
  run(0.18, ctx({ P: { action: 'cast' } }), [{ type: 'player_cast', data: { ability: 'bolt' } }]);
  assert.equal(poses.active, 'ok');
  assert.ok(wp(H.B.rightHand).z - wp(H.B.rightUpperArm).z > 0.75 * armLen, '«OK»: кисть вперёд');
  // «Небесный суд»: руки к небу (время — по сцене боя)
  const ult = { active: true, t: 0, duration: 3.6, strikeAt: 2.3, struck: false };
  const cu = ctx({ P: { action: 'cast' }, snap: { status: 'playing', ultimate: ult } });
  for (let i = 0; i < 72; i++) { ult.t += 1 / 60; run(1 / 60, cu); }
  assert.equal(poses.active, 'ultimate');
  assert.ok(wp(H.B.leftHand).y > wp(H.B.head).y && wp(H.B.rightHand).y > wp(H.B.head).y, '«Небесный суд»: руки к небу');
  while (ult.t < 2.6) { ult.t += 1 / 60; run(1 / 60, cu); }
  ult.struck = true;
  assert.ok(wp(H.B.rightHand).y < wp(H.B.head).y, 'приговор: ладони вниз-вперёд');
  run(0.8, ctx());
  assert.ok(maxJump < 0.16, `столп, «OK», «Небесный суд» — без скачков кисти (${maxJump.toFixed(3)} м за кадр)`);
  // ранение: вздрагивание и боль на лице
  let painMax = 0;
  for (let i = 0; i < 30; i++) { const { E } = frame(H, poses, 1 / 60, ctx(), i === 0 ? [{ type: 'player_hit', data: { amount: 20, direction: { x: 1, z: -1 } } }] : []); painMax = Math.max(painMax, E.pain); }
  assert.ok(painMax > 0.5, 'ранение: боль на лице');
  // «Распознано»: успешный жест — улыбка
  let smileMax = 0;
  for (let i = 0; i < 40; i++) { const { E } = frame(H, poses, 1 / 60, ctx(), i === 0 ? [{ type: 'shield_start', data: {} }] : []); smileMax = Math.max(smileMax, E.smile); }
  assert.ok(smileMax > 0.5, '«Распознано»: улыбка');
  // события соперника (data.remote) своему герою не достаются
  run(0.2, ctx(), [{ type: 'burst', data: { remote: true } }]);
  assert.equal(poses.active, '', 'событие соперника не играет позу');
  assert.ok(poses.claims({ type: 'burst', data: {} }) && poses.claims({ type: 'sigil_cast', data: { sigil: 'gate' } }) && poses.claims({ type: 'player_cast', data: { ability: 'bolt' } }));
  assert.ok(!poses.claims({ type: 'player_slash', data: {} }) && !poses.claims({ type: 'sigil_cast', data: { sigil: 'clap' } }));
  assert.ok(poses.claimsHold('shield') && poses.claimsHold('conjure') && !poses.claimsHold('stun'));

  // магия ладони: сгусток в правой (лёд — ладонь вниз), бросок — толчок вперёд
  run(0.5, ctx({ P: { action: 'idle', handSpell: { phase: 'hold', element: 'frost', power: 0.6 } } }));
  assert.equal(poses.active, 'orb', 'сгусток в ладони');
  assert.ok(wp(H.B.rightHand).z - wp(H.B.rightUpperArm).z > 0.4 * armLen, 'сгусток — перед грудью');
  run(0.3, ctx(), [{ type: 'hand_spell_throw', data: { element: 'frost', dir: { x: 0.5, y: 0.2 } } }]);
  assert.equal(poses.active, 'orbThrow');
  assert.ok(poses.claims({ type: 'hand_spell_throw', data: {} }));
  run(0.8, ctx());
  // взгляд на Регента: цель слева-впереди — голова довёрнута к ней
  {
    const look = ctx({ lookTarget: new THREE.Vector3(6, 0, 6) });
    for (let i = 0; i < 90; i++) frame(H, poses, 1 / 60, look);
    H.B.head.updateWorldMatrix(true, false);
    const f = new THREE.Vector3().setFromMatrixColumn(H.B.head.matrixWorld, 2).normalize();
    assert.ok(f.x > 0.25, `голова к Регенту (${f.x.toFixed(2)})`);
  }
  // поражение: на колено (таз ниже на ~0,4 м), стопы не проваливаются под пол
  const hip0 = wp(H.B.hips).y;
  for (let i = 0; i < 90; i++) frame(H, poses, 1 / 60, ctx({ status: 'defeat', P: { action: 'dead' } }));
  assert.equal(poses.active, 'defeat');
  assert.ok(hip0 - wp(H.B.hips).y > 0.25, `поражение: на колено (${(hip0 - wp(H.B.hips).y).toFixed(2)} м)`);
  assert.ok(wp(H.B.leftFoot).y > -0.02 && wp(H.B.rightFoot).y > -0.02, 'стопы над полом');
  // победа: рука с оружием к небу, затем гордая стойка
  for (let i = 0; i < 50; i++) frame(H, poses, 1 / 60, ctx({ status: 'victory' }));
  assert.equal(poses.active, 'victory');
  assert.ok(wp(H.B.rightHand).y > wp(H.B.head).y, 'победа: посох к небу');
  let triumph = 0;
  for (let i = 0; i < 200; i++) { const { E } = frame(H, poses, 1 / 60, ctx({ status: 'victory' })); triumph = Math.max(triumph, E.smile); }
  assert.ok(triumph > 0.7, 'победа: торжество на лице');

  // витрина: визитка, жест (flourish), портрет при приближении
  for (const id of HERO_ORDER) {
    poses.setSignature(id);
    for (let i = 0; i < 40; i++) frame(H, poses, 1 / 60, ctx({ menu: true, P: null, snap: null, status: 'menu' }));
    assert.equal(poses.active, 'signature', `визитка ${id}`);
    assert.equal(poses.signature, id);
  }
  poses.setSignature('dark');
  assert.ok(poses.flourish(), 'жест визитки');
  poses.setSignature(null);
  assert.ok(!poses.flourish());

  // без NaN после бури случайных событий; низкое качество — без IK ног
  const types = ['burst', 'sigil_cast', 'player_cast', 'player_hit', 'block', 'shield_start', 'ultimate_start', 'parry'];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1500; i++) {
    const ev = rnd() < 0.08 ? [{ type: types[Math.floor(rnd() * types.length)], data: { sigil: rnd() < 0.5 ? 'gate' : 'pillar', ability: rnd() < 0.5 ? 'bolt' : 'throw', success: true } }] : [];
    const c = ctx({ P: { action: rnd() < 0.2 ? 'shield' : rnd() < 0.2 ? 'conjure' : 'idle', conjure: rnd() < 0.3 ? { charge: rnd() } : null, sigilCharge: rnd() < 0.1 ? rnd() : 0 }, idleW: rnd(), standW: rnd() });
    frame(H, poses, rnd() * 0.05, c, ev);
  }
  assert.ok(finite(H), 'кости без NaN');
  poses.setQuality('low');
  H.clip(); const fl = wp(H.B.leftFoot), hp = wp(H.B.hips);
  for (let i = 0; i < 30; i++) frame(H, poses, 1 / 60, ctx());
  assert.ok(wp(H.B.leftFoot).distanceTo(fl) < 1e-6 && wp(H.B.hips).distanceTo(hp) < 1e-6, 'low: таз и ноги не трогаем');

  // бюджет CPU: тело + руки + пальцы + мимика за кадр (средне) — заметно меньше 0,3 мс
  poses.setQuality('high');
  const c1 = ctx({ P: { action: 'shield', shielding: true } });
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) frame(H, poses, 1 / 60, c1, i % 120 === 0 ? [{ type: 'burst', data: {} }] : []);
  const ms = (performance.now() - t0) / 2000;
  assert.ok(ms < 0.3, `CPU слоя поз ${ms.toFixed(3)} мс/кадр`);
  console.log(`heroPoses: CPU ${ms.toFixed(3)} мс/кадр (синтетика, с «клипом»)`);
  poses.dispose();
}

// ---------------------------------------------------------------- мимика: кости лица
{
  const root = new THREE.Group();
  const hb = new THREE.Bone(); hb.name = 'Head'; hb.position.set(0, 1.55, 0); root.add(hb);
  const top = new THREE.Bone(); top.position.set(0, 0.2, 0); hb.add(top);
  root.updateMatrixWorld(true);
  const sk = new THREE.Skeleton([hb, top]);   // boneInverses — из текущей позы (поза привязки)
  // брови: по 12 вершин слева и справа (x ±0.012…0.06, y 1.67)
  const bp = [];
  for (const s of [1, -1]) for (let i = 0; i < 12; i++) bp.push(s * (0.012 + i * 0.004), 1.67 + 0.002 * Math.sin(i), 0.08);
  const mk = (pos, uv, name, matName) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const n = pos.length / 3;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv || new Array(n * 2).fill(0.9), 2));
    g.setAttribute('skinIndex', new THREE.Uint8BufferAttribute(new Uint8Array(n * 4), 4));
    const w = new Float32Array(n * 4); for (let i = 0; i < n; i++) w[i * 4] = 1;
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
    const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ name: matName }));
    m.name = name; root.add(m); m.bind(sk, new THREE.Matrix4());
    return m;
  };
  const brows = mk(bp, null, 'Eyebrows', 'MI_Hair_2');
  // лицо: губы — эллипс на атласе (как у Quaternius), уголки рта на x ±0.022; щёки и лоб — без губ
  const fp = [], fuv = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; fp.push(0.022 * Math.cos(a), 1.59 + 0.004 * Math.sin(a), 0.088); fuv.push(0.1797 + 0.025 * Math.cos(a), 0.2598 + 0.01 * Math.sin(a)); }
  for (let i = 0; i < 20; i++) { fp.push(-0.08 + i * 0.008, 1.7, 0.07); fuv.push(0.6, 0.6); }
  const face = mk(fp, fuv, 'Female_Regular001', 'MI_Regular_Female');
  const vrm = { scene: root, humanoid: { getRawBoneNode: (n) => (n === 'head' ? hb : null) } };
  const at = (m, i) => m.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(m.matrixWorld);
  root.updateMatrixWorld(true);
  const before = [...Array(face.geometry.attributes.position.count).keys()].map((i) => at(face, i));
  const bBefore = [...Array(brows.geometry.attributes.position.count).keys()].map((i) => at(brows, i));
  const F = P.rigFace(THREE, vrm, { mouth: true });
  assert.ok(F && F.bones === 6, `кости лица: 4 брови + 2 уголка рта (${F && F.bones})`);
  assert.equal(sk.bones.length, 8); assert.equal(sk.boneInverses.length, 8);
  assert.equal(sk.boneMatrices.length, 16 * 8, 'матрицы костей — под новый размер');
  root.updateMatrixWorld(true); sk.update();
  // веса нормированы
  for (const m of [brows, face]) {
    const w = m.geometry.attributes.skinWeight;
    for (let i = 0; i < w.count; i++) { let s = 0; for (let j = 0; j < 4; j++) s += w.getComponent(i, j); assert.ok(Math.abs(s - 1) < 1e-4, 'сумма весов = 1'); }
  }
  // в покое — ничего не сдвинулось
  F.update({ smile: 0, frown: 0, brow: 0, squint: 0, pain: 0 });
  root.updateMatrixWorld(true); sk.update();
  for (let i = 0; i < before.length; i++) assert.ok(at(face, i).distanceTo(before[i]) < 1e-5, 'лицо в покое не сдвинуто');
  for (let i = 0; i < bBefore.length; i++) assert.ok(at(brows, i).distanceTo(bBefore[i]) < 1e-5, 'брови в покое не сдвинуты');
  // улыбка: уголки рта вверх; лоб (вдали) — на месте
  F.update({ smile: 1, frown: 0, brow: 0, squint: 0, pain: 0 });
  root.updateMatrixWorld(true); sk.update();
  const cornerUp = at(face, 0).y - before[0].y, cornerUp2 = at(face, 8).y - before[8].y;
  assert.ok(cornerUp > 0.0015 && cornerUp2 > 0.0015, `улыбка: уголки рта вверх (${(cornerUp * 1000).toFixed(2)} мм)`);
  assert.ok(Math.abs(at(face, 20).y - before[20].y) < 1e-5, 'лоб не двигается');
  // брови вверх (торжество), хмурость — внутренние края вниз
  F.update({ smile: 0, frown: 0, brow: 1, squint: 0, pain: 0 });
  root.updateMatrixWorld(true); sk.update();
  assert.ok(at(brows, 0).y - bBefore[0].y > 0.0015, 'брови вверх');
  F.update({ smile: 0, frown: 1, brow: 0, squint: 0, pain: 0 });
  root.updateMatrixWorld(true); sk.update();
  assert.ok(at(brows, 0).y - bBefore[0].y < -0.001, 'хмурость: внутренний край брови вниз');
  F.dispose();
  assert.equal(hb.children.filter((c) => /^face-/.test(c.name)).length, 0, 'dispose снимает кости лица');
  // модели без бровей и губ (шлем стража) — без костей лица
  assert.equal(P.rigFace(THREE, { scene: new THREE.Group(), humanoid: { getRawBoneNode: () => hb } }), null);
}
console.log('heroPoses.test: ok');
