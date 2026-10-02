// [W3-SPIRIT] node-тест духа игрока (modules/spiritAvatar.js): создание, поза и кисти → плечи, локти и 2×21 точка
// пальцев, зеркало как на превью, сглаживание (без дрожи, без запаздывания), угасание при потере трекинга, реакции
// (жест, «ОШИБКА», щит, заряд, ультимейт), синтетика «Отладки с клавиатуры», настройка «Дух игрока», low без
// шейдеров, отсутствие аллокаций буферов в кадре и dispose без утечек.
// three.js — ASHEN_THREE=…/vendor/npm/three@0.185.1/build/three.module.min.js; без него — FAIL (не SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { makeScene, handAt, reseed, gauss } from './handSynth.mjs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) THREE = await import(pathToFileURL(c).href);
}
if (!THREE) { console.error('FAIL spiritAvatar: three.js не найден (ASHEN_THREE=…/three.module.min.js)'); process.exit(1); }
const { createSpiritAvatar, buildHand, J } = await import('../modules/spiritAvatar.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e && e.stack || e).split('\n').slice(0, 3).join('\n     ')}`); }
}

// ---- синтетика в форматах vision: поза — незеркальный кадр, кисти — кадр показа (как vision.getHands())
const S = makeScene({ cx: 0.5, cy: 0.42, sw: 0.3 });
let T = 1000;
const DT = 1 / 60;
function pose(lw, rw, opts = {}) {
  const P = S.pose({ lw, rw });
  const put = (i, q) => { const a = S.at(q.x, q.y); P[i] = { x: a.cx, y: a.cy, z: q.z || 0, visibility: 0.95 }; };
  put(13, opts.le || { x: -0.85, y: 0.9 }); put(14, opts.re || { x: 0.85, y: 0.9 });
  if (opts.noise) for (const i of [11, 12, 13, 14, 15, 16]) { P[i].x += gauss() * opts.noise; P[i].y += gauss() * opts.noise; }
  return { tMs: T, frameW: S.frameW, frameH: S.frameH, mirror: true, landmarks: P };
}
function hand(side, w, shape = 'open') {
  if (!w) return null;
  const h = handAt(S, side, w.x, w.y - 0.25, shape);
  return { side, shape, palmFacing: 'camera', ready: true, landmarks: h.landmarks.map((p) => ({ x: 1 - p.x, y: p.y })) };
}
function hands(lw, rw, shL, shR) { const l = hand('left', lw, shL), r = hand('right', rw, shR); return { available: !!(l || r), left: l, right: r }; }
const ctxOf = (lw, rw, extra = {}) => ({ screen: 'playing', status: { status: 'ready' }, pose: pose(lw, rw, extra), hands: hands(lw, rw, extra.shL, extra.shR), ...extra.ctx });
// кадры камеры ~30 Гц, рендер 60 Гц: новая поза каждый второй кадр
function run(sp, seconds, mk) {
  let data = null;
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    T += DT * 1000;
    if (!data || i % 2 === 0) data = mk(i);
    sp.frame(DT, T, data);
  }
}
const finite = (sp) => {
  let ok = true;
  sp.root.traverse((o) => {
    const a = o.geometry && o.geometry.attributes.position; if (a && !Array.from(a.array).every(Number.isFinite)) ok = false;
    if (o.isInstancedMesh && !Array.from(o.instanceMatrix.array).every(Number.isFinite)) ok = false;
  });
  return ok;
};

// ---- помощники стыков с соседями: ладони рядом, размах щели (info) и нарисованная щель (high / low)
const close = () => ctxOf({ x: -0.12, y: 0.2 }, { x: 0.12, y: 0.2 });
const span = (inf) => { const [a, b] = inf.slitEnds; return { x: Math.abs(b[0] - a[0]), y: Math.abs(b[1] - a[1]) }; };
// нарисованная щель: последний инстанс отрисовки костей (high) — длина, направление, яркость
function drawnSlit(sp) {
  let mesh = null;
  sp.root.traverse((o) => { if (o.isInstancedMesh && o.material && o.material.name === 'spirit-bone' && o.parent && o.parent.visible) mesh = o; });
  if (!mesh) return null;
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  mesh.getMatrixAt(mesh.count - 1, m); m.decompose(p, q, sc);
  const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const c = mesh.geometry.attributes.aColor.array, k = (mesh.count - 1) * 3;
  return { len: sc.y, dx: Math.abs(dir.x), dy: Math.abs(dir.y), lum: c[k] + c[k + 1] + c[k + 2] };
}
// low: щель — последний отрезок линий
function drawnSlitLow(sp) {
  let lines = null;
  sp.root.traverse((o) => { if (o.isLineSegments && o.material && o.material.name === 'spirit-lines') lines = o; });
  const a = lines.geometry.attributes.position.array, c = lines.geometry.attributes.color.array, n = a.length;
  return { dx: Math.abs(a[n - 3] - a[n - 6]), dy: Math.abs(a[n - 2] - a[n - 5]), lum: c[n - 3] + c[n - 2] + c[n - 1] };
}

const HEROES = { ashen: { fx: { color: 0xff7a2a, color2: 0xffd08a } }, elf: { fx: { color: 0x9ff4ff, color2: 0xfff3c0 } } };
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
scene.add(camera);
const settings = { quality: 'high', spiritAvatar: true, reducedMotion: false };
const sp = createSpiritAvatar({ THREE, scene, camera, heroes: HEROES, settings });

test('создание: дух висит на камере игры, без трекинга не виден', () => {
  assert.equal(sp.root.parent, camera);
  sp.frame(DT, (T += 16), { screen: 'playing', pose: null, hands: null, status: { status: 'ready' } });
  assert.ok(sp.info().alpha < 0.01, `alpha ${sp.info().alpha}`);
});

test('поза + кисти → видны плечи, локти, кисти и 2×21 точка пальцев; все вершины конечны', () => {
  run(sp, 1.2, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  const inf = sp.info();
  assert.equal(inf.source, 'camera');
  assert.ok(inf.presence > 0.95 && inf.alpha > 0.8, `presence ${inf.presence}, alpha ${inf.alpha}`);
  assert.equal(inf.fingers.left, 21); assert.equal(inf.fingers.right, 21);
  assert.ok(inf.skyVisible);
  assert.ok(finite(sp), 'NaN/Infinity в буферах');
});

test('зеркало как на превью: поднятая ЛЕВАЯ рука игрока — слева на экране и выше правой', () => {
  const j = sp.info().joints;      // координаты тела: x — вправо по экрану, y — вверх
  assert.ok(j.leftShoulder.x < 0 && j.rightShoulder.x > 0, 'плечи');
  assert.ok(j.leftWrist.x < 0 && j.rightWrist.x > 0, `запястья ${j.leftWrist.x} ${j.rightWrist.x}`);
  assert.ok(j.leftWrist.y > j.rightWrist.y + 0.5, `левая выше: ${j.leftWrist.y} > ${j.rightWrist.y}`);
  assert.ok(Math.abs(j.leftShoulder.x - j.rightShoulder.x + 1) < 0.15, 'ширина плеч = 1');
  // кончик указательного левой кисти — у левого запястья, над ним (ладонь вверх)
  assert.ok(j.leftIndexTip.x < 0 && j.leftIndexTip.y > j.leftWrist.y, 'пальцы левой кисти');
});

test('пальцы: кулак и раскрытая ладонь различимы (кончик указательного у ладони / далеко)', () => {
  run(sp, 0.8, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }, { shR: 'fist' }));
  const j1 = sp.info().joints, dFist = Math.hypot(j1.rightIndexTip.x - j1.rightWrist.x, j1.rightIndexTip.y - j1.rightWrist.y);
  run(sp, 0.8, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }, { shR: 'open' }));
  const j2 = sp.info().joints, dOpen = Math.hypot(j2.rightIndexTip.x - j2.rightWrist.x, j2.rightIndexTip.y - j2.rightWrist.y);
  assert.ok(dOpen > dFist * 1.4, `открытая ${dOpen.toFixed(3)} vs кулак ${dFist.toFixed(3)}`);
});

test('сглаживание: дрожь позы в покое гасится ≥3×, рывок руки догоняется за ≤0,3 с', () => {
  reseed(7);
  const xs = [], raw = [];
  run(sp, 0.6, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  let i = 0;
  run(sp, 2, () => { const c = ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }, { noise: 0.004 }); raw.push(c.pose.landmarks[11].x); return c; });
  // дисперсия показа против дисперсии сырых данных (плечо 11 → координаты тела: 1 ширина плеч = 0,3·высоты/аспект)
  const std = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  run(sp, 1, () => { const c = ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }, { noise: 0.004 }); xs.push(sp.info().joints.leftShoulder.x); i++; return c; });
  const rawStdB = std(raw) * (4 / 3) / 0.3;      // сырой шум в ширинах плеч
  assert.ok(std(xs) * 3 < rawStdB, `показ ${std(xs).toFixed(4)} vs сырой ${rawStdB.toFixed(4)}`);
  // рывок: правое запястье из (0.9, 0.5) в (0.9, -1.2) — за 0,3 с проходит ≥90 % пути
  run(sp, 0.5, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  const y0 = sp.info().joints.rightWrist.y;
  run(sp, 0.3, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: -1.2 }));
  const y1 = sp.info().joints.rightWrist.y;
  run(sp, 1, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: -1.2 }));
  const y2 = sp.info().joints.rightWrist.y;
  assert.ok((y1 - y0) / (y2 - y0) > 0.9, `за 0,3 с ${(((y1 - y0) / (y2 - y0)) * 100).toFixed(0)} %`);
});

test('потеря одной кисти: пальцы гаснут и едут за запястьем, дух остаётся', () => {
  run(sp, 0.6, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  run(sp, 0.8, () => { const c = ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }); c.hands.left = null; return c; });
  const inf = sp.info();
  assert.ok(inf.presence > 0.95, 'дух виден');
  assert.ok(inf.fingers.left === 0 && inf.fingers.right === 21, `пальцы ${inf.fingers.left}/${inf.fingers.right}`);
  const j = inf.joints;
  assert.ok(Math.hypot(j.leftIndexTip.x - j.leftWrist.x, j.leftIndexTip.y - j.leftWrist.y) < 0.6, 'кисть у запястья');
});

test('потеря трекинга: дух гаснет плавно (не за кадр), потом скрыт', () => {
  run(sp, 0.6, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  const a0 = sp.info().alpha;
  run(sp, 0.25, () => ({ screen: 'playing', status: { status: 'lost' }, pose: null, hands: { available: false, left: null, right: null } }));
  const a1 = sp.info().alpha;
  assert.ok(a1 > 0.2 && a1 < a0, `через 0,25 с ${a1} (было ${a0})`);
  run(sp, 3, () => ({ screen: 'playing', status: { status: 'lost' }, pose: null, hands: null }));
  assert.ok(sp.info().alpha < 0.01 && !sp.info().skyVisible, `alpha ${sp.info().alpha}`);
  // поза «зависла» (тот же tMs) — тоже потеря
  const stale = ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 });
  run(sp, 0.6, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  stale.pose.tMs = T;
  run(sp, 3, () => stale);
  assert.ok(sp.info().alpha < 0.02, `зависшая поза: alpha ${sp.info().alpha}`);
});

test('экраны: меню и интро — скрыт; бой — над ареной; калибровка/обучение — в кадре (не в небе)', () => {
  run(sp, 1, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  assert.ok(sp.info().alpha > 0.8);
  run(sp, 2, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), screen: 'menu' }));
  assert.ok(sp.info().alpha < 0.01 && !sp.info().skyVisible, 'меню');
  run(sp, 1.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), screen: 'intro' }));
  assert.ok(!sp.info().skyVisible, 'интро');
  run(sp, 1.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), screen: 'tutorial' }));
  assert.ok(sp.info().frameAlpha > 0.8 && sp.info().alpha < 0.01, `обучение: кадр ${sp.info().frameAlpha}, небо ${sp.info().alpha}`);
});

test('реакции: жест правой — вспышка цветом стихии героя, «ОШИБКА» — красная, щит, заряд, ультимейт', () => {
  run(sp, 1, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }, { ctx: { hero: 'elf' } }));
  // выброс правой
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), hero: 'elf', input: { valid: true, burst: true, burstHand: 'right' } });
  let inf = sp.info();
  assert.ok(inf.flash[1] > 0.8 && inf.flash[0] < 0.2, `вспышка ${inf.flash}`);
  assert.ok(inf.rings >= 1, 'кольцо на ладони');
  const elf = new THREE.Color(0x9ff4ff);
  assert.ok(Math.abs(inf.flashColor[1][0] - elf.r) < 0.01 && Math.abs(inf.flashColor[1][2] - elf.b) < 0.01, `цвет стихии ${inf.flashColor[1]}`);
  // подсказка «ОШИБКА» к левой — красная вспышка слева (один раз на подсказку)
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), hero: 'elf', input: { valid: true, hint: { code: 'shield_slow', side: 'left' } } });
  inf = sp.info();
  assert.ok(inf.flash[0] > 0.8 && inf.flashColor[0][0] > 0.8 && inf.flashColor[0][1] < 0.2, `ошибка ${inf.flash} ${inf.flashColor[0]}`);
  // щит: купол в ладони
  run(sp, 0.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), input: { valid: true, shield: true } }));
  assert.ok(sp.info().shield > 0.9, `щит ${sp.info().shield}`);
  run(sp, 0.8, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), input: { valid: true } }));
  assert.ok(sp.info().shield < 0.05, 'щит убран');
  // заряд ладонями: player.sigilCharge (новые магии) и сфера двумя руками
  run(sp, 0.6, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), snapshot: { player: { sigilCharge: 0.8 } } }));
  assert.ok(sp.info().charge > 0.7, `sigilCharge ${sp.info().charge}`);
  run(sp, 0.8, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), input: { valid: true } }));
  assert.ok(sp.info().charge < 0.1, 'заряд погас');
  run(sp, 0.6, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), input: { valid: true, conjure: { kind: 'orb', charge: 0.6 } } }));
  assert.ok(sp.info().charge > 0.5, `сфера ${sp.info().charge}`);
  // ультимейт «Небесный суд»: шкала полна — нимб пульсирует; ultimate_start — вспышка (руки духа вверх)
  run(sp, 1.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 100, furyReady: true } } }));
  assert.ok(sp.info().ready > 0.9 && sp.info().ult < 0.05, `готов ${sp.info().ready}`);
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 } }, events: [{ id: 'u1', type: 'ultimate_start', position: { x: 0, y: 0, z: 0 } }] });
  assert.ok(sp.info().ult > 0.9, `ульт ${sp.info().ult}`);
  run(sp, 2.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 }, ultimate: { active: true, t: 1 } } }));
  assert.ok(sp.info().ult >= 0.7, `сцена ультимейта: руки подняты ${sp.info().ult}`);
});

test('руки вверх ~0,5 с: дух поднимает руки и вспыхивает (без шкалы ультимейта); со шкалой — только светится', () => {
  run(sp, 2.5, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  assert.ok(sp.info().ult < 0.05);
  run(sp, 0.9, () => ctxOf({ x: -0.6, y: -2.4 }, { x: 0.6, y: -2.4 }, { le: { x: -0.8, y: -1.2 }, re: { x: 0.8, y: -1.2 } }));
  const inf = sp.info();
  assert.ok(inf.up > 0.9, `руки вверх ${inf.up}`);
  assert.ok(inf.ult > 0.3, `вспышка ${inf.ult}`);
  assert.ok(inf.joints.leftWrist.y > inf.joints.head.y && inf.joints.rightWrist.y > inf.joints.head.y, 'кисти выше головы');
  // со шкалой ультимейта (агент №6) вспышку даёт только ultimate_start — отказ боя не выглядит успехом
  run(sp, 2.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 10 } } }));
  run(sp, 0.9, () => ({ ...ctxOf({ x: -0.6, y: -2.4 }, { x: 0.6, y: -2.4 }, { le: { x: -0.8, y: -1.2 }, re: { x: 0.8, y: -1.2 } }), snapshot: { player: { fury: 10 } } }));
  assert.ok(sp.info().up > 0.9 && sp.info().ult < 0.05, `со шкалой: up ${sp.info().up}, ult ${sp.info().ult}`);
});

test('«Дух игрока» выключен — гаснет и не рисуется; включён — возвращается', () => {
  // выключили посреди «Небесного суда» — включили в новом бою: ни облёта, ни старой вспышки
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), events: [{ id: 'x1', type: 'ultimate_start', data: { duration: 3.6 } }] });
  settings.spiritAvatar = false;
  try {
    run(sp, 2, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
    assert.ok(sp.info().alpha < 0.01 && !sp.info().skyVisible, `alpha ${sp.info().alpha}`);
    assert.ok(!sp.info().cine && sp.info().ult === 0, `сброшено: облёт ${sp.info().cine}, ult ${sp.info().ult}`);
  } finally { settings.spiritAvatar = true; }
  run(sp, 1.5, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  assert.ok(sp.info().alpha > 0.8);
});

test('отладка с клавиатуры: синтетические руки без камеры, клавиша щита толкает левую ладонь вперёд', () => {
  run(sp, 1.5, () => ({ screen: 'playing', debug: true, input: { valid: true, source: 'debug' } }));
  let inf = sp.info();
  assert.equal(inf.source, 'synth');
  assert.ok(inf.alpha > 0.8 && inf.fingers.left === 21 && inf.fingers.right === 21, `синтетика ${inf.alpha} ${inf.fingers.left}/${inf.fingers.right}`);
  run(sp, 0.6, () => ({ screen: 'playing', debug: true, input: { valid: true, source: 'debug', shield: true } }));
  inf = sp.info();
  assert.ok(inf.joints.leftWrist.z < -0.6, `левая вперёд: z ${inf.joints.leftWrist.z}`);
  assert.ok(inf.shield > 0.9, 'купол щита');
  assert.ok(finite(sp));
});

test('модель кисти: 21 точка, кулак короче ладони, правая — зеркально левой', () => {
  const a = new Float32Array(63), b = new Float32Array(63), c = new Float32Array(63);
  buildHand(a, 0, 'left', { x: 0, y: 0, z: 0, ang: 0, curls: [0, 0, 0, 0], thumbIn: 0 });
  buildHand(b, 0, 'left', { x: 0, y: 0, z: 0, ang: 0, curls: [1, 1, 1, 1], thumbIn: 1 });
  buildHand(c, 0, 'right', { x: 0, y: 0, z: 0, ang: 0, curls: [0, 0, 0, 0], thumbIn: 0 });
  assert.ok(Array.from(a).every(Number.isFinite));
  assert.ok(a[8 * 3 + 1] > b[8 * 3 + 1] + 0.15, 'кулак');
  for (let i = 0; i < 21; i++) assert.ok(Math.abs(a[i * 3] + c[i * 3]) < 1e-6 && Math.abs(a[i * 3 + 1] - c[i * 3 + 1]) < 1e-6, `зеркало ${i}`);
  // большой палец левой кисти ладонью к камере — к середине тела (вправо на экране)
  assert.ok(a[4 * 3] > 0, 'большой палец к середине');
});

test('без аллокаций: 600 кадров — те же буферы, кольца и шлейф ограничены', () => {
  const before = sp.resources();
  const arrs = before.filter((r) => r.isBufferGeometry).map((g) => Object.values(g.attributes).map((a) => a.array));
  run(sp, 10, (i) => ({ ...ctxOf({ x: -0.9 + 0.3 * Math.sin(i / 20), y: -0.4 }, { x: 0.9, y: 0.5 + 0.4 * Math.cos(i / 15) }), input: { valid: true, burst: i % 40 === 0, burstHand: 'right', shield: i % 120 < 60 } }));
  const after = sp.resources();
  assert.equal(after.length, before.length, 'число ресурсов');
  const arrs2 = after.filter((r) => r.isBufferGeometry).map((g) => Object.values(g.attributes).map((a) => a.array));
  assert.equal(arrs2.length, arrs.length);
  for (let i = 0; i < arrs.length; i++) for (let k = 0; k < arrs[i].length; k++) assert.equal(arrs2[i][k], arrs[i][k], 'массив атрибута заменён');
  assert.ok(sp.info().rings <= 8 && sp.info().trail <= 20);
});

test('low: линии и точки стандартных материалов, без ShaderMaterial; обратно на high', () => {
  settings.quality = 'low';
  run(sp, 0.3, () => ctxOf({ x: -0.9, y: 0 }, { x: 0.9, y: 0 }));
  assert.equal(sp.info().tier, 'low');
  let shader = 0, lines = 0;
  sp.root.traverse((o) => {
    let vis = o.visible; for (let p = o.parent; p && vis; p = p.parent) vis = p.visible;
    if (!vis || !o.material) return;
    if (o.material.isShaderMaterial) shader++;
    if (o.isLineSegments) lines++;
  });
  assert.equal(shader, 0, 'ShaderMaterial в low');
  assert.ok(lines >= 1, 'кости — линии');
  assert.equal(sp.info().trail, 0, 'без шлейфа');
  assert.ok(finite(sp));
  run(sp, 0.6, () => ({ ...close(), snapshot: { player: { sigilCharge: 0.8, sigilAxis: 'v' } } }));
  const gl = drawnSlitLow(sp);
  assert.ok(gl.dy > 0.3 && gl.dx < 0.02 && gl.lum > 0.3, `low: щель отрезком вдоль y ${JSON.stringify(gl)}`);
  run(sp, 0.8, () => close());
  assert.ok(drawnSlitLow(sp).lum < 0.01, 'low: щель погасла');
  settings.quality = 'high';
  run(sp, 0.2, () => ctxOf({ x: -0.9, y: 0 }, { x: 0.9, y: 0 }));
  assert.equal(sp.info().tier, 'high');
});

// ---- стыки с соседями: две магии ладонями (sigilCharge / sigilAxis / sigil_cast) и «Небесный суд» (ultimate_*)
test('две магии ладонями: заряд с осью — щель света вдоль оси, без оси (сфера) — щели нет', () => {
  run(sp, 1.2, () => ({ ...close(), input: { valid: true } }));
  assert.ok(sp.info().slit < 0.01 && sp.info().slitAxis === null, `покой: щель ${sp.info().slit}`);
  // 'h' — «Врата бури»: горизонтальная щель
  run(sp, 0.6, () => ({ ...close(), snapshot: { player: { sigilCharge: 0.7, sigilAxis: 'h' } } }));
  let inf = sp.info(), d = span(inf);
  assert.ok(inf.slit > 0.5 && inf.slitAxis === 'h' && inf.charge > 0.5, `щель ${inf.slit} ${inf.slitAxis}, заряд ${inf.charge}`);
  assert.ok(d.x > 0.3 && d.y < 0.02, `горизонтальная: ${d.x}×${d.y}`);
  let g = drawnSlit(sp);
  assert.ok(g && g.len > 0.3 && g.dx > 0.99 && g.lum > 0.5, `нарисована вдоль x: ${JSON.stringify(g)}`);
  // 'v' — «Столп небес»: щель поворачивается вертикально (ось из ввода тоже годится)
  run(sp, 0.5, () => ({ ...close(), input: { valid: true, sigilCharge: 0.9, sigilAxis: 'v' } }));
  inf = sp.info(); d = span(inf);
  assert.ok(inf.slitAxis === 'v' && d.y > 0.3 && d.x < 0.02, `вертикальная: ${d.x}×${d.y}`);
  g = drawnSlit(sp);
  assert.ok(g.len > 0.3 && g.dy > 0.99 && g.lum > 0.5, `нарисована вдоль y: ${JSON.stringify(g)}`);
  // растянул ладони вдоль оси — щель тянется от ладони до ладони
  run(sp, 0.5, () => ({ ...ctxOf({ x: -0.15, y: -0.4 }, { x: 0.15, y: 0.9 }), input: { valid: true, sigilCharge: 0.9, sigilAxis: 'v' } }));
  d = span(sp.info());
  const pl = sp.info().joints.leftWrist.y, pr = sp.info().joints.rightWrist.y;
  assert.ok(d.y > Math.abs(pr - pl) * 0.8, `от ладони до ладони: щель ${d.y}, ладони ${Math.abs(pr - pl)}`);
  // заряд без оси (сфера двумя руками) — только сфера
  run(sp, 0.8, () => ({ ...close(), input: { valid: true, conjure: { kind: 'orb', charge: 0.6 } } }));
  assert.ok(sp.info().slit < 0.02 && sp.info().charge > 0.5, `сфера: щель ${sp.info().slit}, заряд ${sp.info().charge}`);
  run(sp, 1, () => ({ ...close(), input: { valid: true } }));
  assert.ok(sp.info().slit < 0.01 && sp.info().charge < 0.05, 'погасло');
  assert.ok(drawnSlit(sp).len === 0 || drawnSlit(sp).lum < 0.01, 'нарисованная щель погасла');
  // пауза: снимок застыл с зарядом — щель, сфера и щит из снимка не держатся
  run(sp, 0.6, () => ({ ...close(), snapshot: { player: { sigilCharge: 0.7, sigilAxis: 'h', shielding: true } } }));
  assert.ok(sp.info().slit > 0.5 && sp.info().shield > 0.5);
  run(sp, 1, () => ({ ...ctxOf({ x: -0.9, y: 0.2 }, { x: 0.9, y: 0.2 }), screen: 'paused', snapshot: { player: { sigilCharge: 0.7, sigilAxis: 'h', shielding: true } } }));
  assert.ok(sp.info().slit < 0.01 && sp.info().charge < 0.05 && sp.info().shield < 0.05, `пауза: щель ${sp.info().slit}, заряд ${sp.info().charge}, щит ${sp.info().shield}`);
});

test('sigil_cast: ладони вспыхивают, щель разлетается вдоль оси (gate — в стороны, pillar — вверх-вниз); жест + событие — одна вспышка', () => {
  run(sp, 1.2, () => ({ ...close(), input: { valid: true } }));
  sp.frame(DT, (T += 16), { ...close(), events: [{ id: 'g1', type: 'sigil_cast', position: { x: 0, y: 1, z: 0 }, data: { sigil: 'gate', power: 0.9 } }] });
  let inf = sp.info();
  assert.ok(inf.flash[0] > 0.8 && inf.flash[1] > 0.8, `ладони ${inf.flash}`);
  assert.ok(inf.slitBurst > 0.9 && inf.slitAxis === 'h' && inf.slit > 1, `вспышка щели ${inf.slitBurst} ${inf.slitAxis} ${inf.slit}`);
  assert.equal(inf.rings, 3, 'кольца: две ладони и центр');
  run(sp, 0.25, () => close());
  let d = span(sp.info());
  assert.ok(d.x > 1.5 && d.y < 0.02, `разлёт в стороны ${d.x}×${d.y}`);
  run(sp, 1.2, () => close());
  assert.ok(sp.info().slit < 0.01 && sp.info().rings === 0, 'вспышка погасла');
  // «Столп небес»: жест на кадре раньше события боя — вспышка одна
  sp.frame(DT, (T += 16), { ...close(), input: { valid: true, sigil: 'pillar', sigilPower: 0.8 } });
  sp.frame(DT, (T += 16), { ...close(), events: [{ id: 'p1', type: 'sigil_cast', position: { x: 0, y: 1, z: 0 }, data: { sigil: 'pillar', power: 0.8 } }] });
  inf = sp.info();
  assert.ok(inf.slitAxis === 'v' && inf.slitBurst > 0.9, `столп ${inf.slitAxis} ${inf.slitBurst}`);
  assert.equal(inf.rings, 3, 'одна вспышка на каст');
  run(sp, 0.25, () => close());
  d = span(sp.info());
  assert.ok(d.y > 1.5 && d.x < 0.02, `разлёт вверх-вниз ${d.x}×${d.y}`);
  // отказ (откат, энергия): жест есть, события боя нет — в бою только вспышка ладоней, щель не разлетается
  run(sp, 1.2, () => close());
  sp.frame(DT, (T += 16), { ...close(), input: { valid: true, sigil: 'gate', sigilPower: 0.8 }, events: [{ id: 'd1', type: 'ability_denied', data: { reason: 'cooldown', sigil: 'gate' } }] });
  inf = sp.info();
  assert.ok(inf.slitBurst === 0 && inf.flash[0] > 0.8 && inf.flash[1] > 0.8, `отказ: щель ${inf.slitBurst}, ладони ${inf.flash}`);
  // обучение: боя и событий нет — каст по жесту
  run(sp, 1.2, () => ({ ...close(), screen: 'tutorial' }));
  sp.frame(DT, (T += 16), { ...close(), screen: 'tutorial', input: { valid: true, sigil: 'gate', sigilPower: 0.8 } });
  assert.ok(sp.info().slitBurst > 0.9 && sp.info().slitAxis === 'h', `обучение: ${sp.info().slitBurst}`);
  // прочие печати и события — без щели
  run(sp, 1.2, () => close());
  sp.frame(DT, (T += 16), { ...close(), events: [{ id: 'c1', type: 'sigil_cast', data: { sigil: 'clap' } }], input: { valid: true, sigil: 'clap' } });
  assert.ok(sp.info().slitBurst === 0 && sp.info().flash[0] > 0.8, 'хлопок: вспышка ладоней без щели');
  assert.ok(finite(sp));
});

test('«Небесный суд»: ultimate_ready — вспышка и нимб; облёт камеры — дух вспыхивает, уходит в небо и гаснет; после ultimate_end возвращается', () => {
  const pose0 = () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 });
  run(sp, 2.5, () => ({ ...pose0(), snapshot: { player: { fury: 60, furyMax: 100 } } }));
  assert.ok(sp.info().alpha > 0.8 && sp.info().rings === 0);
  sp.frame(DT, (T += 16), { ...pose0(), snapshot: { player: { fury: 100, furyReady: true } }, events: [{ id: 'r1', type: 'ultimate_ready', position: { x: 0, y: 0, z: 0 }, data: { fury: 100 } }] });
  let inf = sp.info();
  assert.ok(inf.flash[0] > 0.8 && inf.flash[1] > 0.8 && inf.rings >= 3, `готов: вспышка ${inf.flash}, кольца ${inf.rings}`);
  run(sp, 1, () => ({ ...pose0(), snapshot: { player: { fury: 100, furyReady: true } } }));
  assert.ok(sp.info().ready > 0.9, 'нимб «руки вверх!»');
  // сцена: бой стоит 3,6 с, удар в 2,3 с
  const scene = (t) => ({ ...pose0(), snapshot: { status: 'playing', player: { fury: 0 }, ultimate: { active: true, t, duration: 3.6, strikeAt: 2.3 } } });
  const y0 = sp.root.position.y, s0 = sp.root.scale.x;
  sp.frame(DT, (T += 16), { ...scene(0), events: [{ id: 'u1', type: 'ultimate_start', position: { x: 0, y: 1, z: 0 }, data: { duration: 3.6, strikeAt: 2.3 } }] });
  inf = sp.info();
  assert.ok(inf.ult > 0.9 && inf.cine, `старт: ult ${inf.ult}, облёт ${inf.cine}`);
  let t = DT;
  run(sp, 0.3, () => scene((t += DT)));
  inf = sp.info();
  assert.ok(inf.rise > 0.3 && inf.skyVisible, `уходит в небо: rise ${inf.rise}`);
  assert.ok(sp.root.position.y > y0 + 0.25 && sp.root.scale.x > s0 * 1.02, `вверх и больше: y ${y0.toFixed(2)} → ${sp.root.position.y.toFixed(2)}, масштаб ${s0.toFixed(2)} → ${sp.root.scale.x.toFixed(2)}`);
  run(sp, 0.8, () => scene((t += DT)));
  inf = sp.info();
  assert.ok(inf.alpha < 0.01 && !inf.skyVisible, `облёт без духа: alpha ${inf.alpha}, виден ${inf.skyVisible}`);
  sp.frame(DT, (T += 16), { ...scene(2.3), events: [{ id: 'u2', type: 'ultimate_strike', position: { x: 0, y: 3, z: 0 }, data: { amount: 280 } }] });
  t = 2.3;
  run(sp, 0.7, () => scene((t += DT)));
  assert.ok(sp.info().cine && !sp.info().skyVisible, 'удар и общий план — дух всё ещё не в кадре');
  sp.frame(DT, (T += 16), { ...pose0(), snapshot: { player: { fury: 0 } }, events: [{ id: 'u3', type: 'ultimate_end', position: { x: 0, y: 0, z: 0 }, data: { struck: true } }] });
  assert.ok(!sp.info().cine, 'сцена кончилась');
  run(sp, 1.5, () => ({ ...pose0(), snapshot: { player: { fury: 0 } } }));
  inf = sp.info();
  assert.ok(inf.alpha > 0.8 && inf.skyVisible && inf.rise === 0, `вернулся: alpha ${inf.alpha}, rise ${inf.rise}`);
  // победа ударом меча: снимка сцены уже нет — дух ждёт конца облёта по своему отсчёту
  sp.frame(DT, (T += 16), { ...pose0(), snapshot: { status: 'victory', player: { fury: 0 } }, events: [{ id: 'u4', type: 'ultimate_start', data: { duration: 3.6 } }] });
  run(sp, 2, () => ({ ...pose0(), snapshot: { status: 'victory', player: { fury: 0 } } }));
  assert.ok(sp.info().cine && !sp.info().skyVisible, 'облёт после победы — без духа');
  run(sp, 2.6, () => ({ ...pose0(), snapshot: { status: 'victory', player: { fury: 0 } } }));
  assert.ok(!sp.info().cine && sp.info().alpha > 0.5, `облёт кончился: alpha ${sp.info().alpha}`);
  // «Заново» посреди сцены: новый бой, сцены в снимке нет (null) — облёта нет, дух сразу на месте
  sp.frame(DT, (T += 16), { ...scene(0.2), events: [{ id: 'u6', type: 'ultimate_start', data: { duration: 3.6 } }] });
  assert.ok(sp.info().cine);
  sp.frame(DT, (T += 16), { ...pose0(), snapshot: { status: 'playing', player: { fury: 0 }, ultimate: null } });
  assert.ok(!sp.info().cine, '«Заново» — без облёта');
  run(sp, 1.5, () => ({ ...pose0(), snapshot: { status: 'playing', player: { fury: 0 }, ultimate: null } }));
  // «Уменьшенное движение»: камера не облетает (main.js) — дух не прячется, не поднимается, вспышка видна
  settings.reducedMotion = true;
  try {
    const yR = sp.root.position.y;
    sp.frame(DT, (T += 16), { ...scene(0), events: [{ id: 'u7', type: 'ultimate_start', data: { duration: 3.6 } }] });
    t = DT;
    run(sp, 1.2, () => scene((t += DT)));
    inf = sp.info();
    assert.ok(!inf.cine && inf.skyVisible && inf.alpha > 0.8 && inf.ult > 0.5, `без облёта: виден ${inf.skyVisible}, alpha ${inf.alpha}, ult ${inf.ult}`);
    // не уходит в небо (руки вверх — дух лишь опускается, чтобы кисти остались в кадре)
    assert.ok(inf.rise === 0 && sp.root.position.y <= yR + 0.01, `без подъёма: rise ${inf.rise}, y ${yR.toFixed(2)} → ${sp.root.position.y.toFixed(2)}`);
    run(sp, 2.6, () => ({ ...pose0(), snapshot: { status: 'playing', player: { fury: 0 }, ultimate: null } }));
  } finally { settings.reducedMotion = false; }
  // ушли с арены во время сцены (итоги) — отсчёт сброшен
  sp.frame(DT, (T += 16), { ...pose0(), events: [{ id: 'u5', type: 'ultimate_start', data: { duration: 3.6 } }] });
  sp.frame(DT, (T += 16), { ...pose0(), screen: 'victory' });
  assert.ok(!sp.info().cine, 'итоги — без облёта');
});

test('режим презентации P: в крупном превью дух ярче и есть в бою; без P в бою превью без духа', () => {
  const at = (screen, present) => () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), screen, present });
  run(sp, 1.5, at('tutorial', false));
  const plain = sp.info().frameBright;
  run(sp, 1.5, at('tutorial', true));
  const big = sp.info().frameBright;
  assert.ok(plain > 0.8 && big > plain * 1.3, `ярче: ${plain} → ${big}`);
  assert.ok(sp.info().present);
  run(sp, 1.5, at('playing', true));
  assert.ok(sp.info().frameBright > 1 && sp.info().alpha > 0.8, `P в бою: превью ${sp.info().frameBright}, небо ${sp.info().alpha}`);
  run(sp, 1.5, at('playing', false));
  assert.ok(sp.info().frameBright < 0.01 && sp.info().alpha > 0.8, 'без P в бою — только небо');
});

test('«Уменьшенное движение»: без шлейфа, молний и бегущего света; щель и нимб не пульсируют', () => {
  settings.reducedMotion = true;
  try {
    const ctx = () => ({ ...close(), snapshot: { player: { fury: 100, furyReady: true, sigilCharge: 0.8, sigilAxis: 'h' } } });
    run(sp, 1.2, ctx);
    const inf = sp.info();
    assert.ok(inf.rm && inf.trail === 0 && !inf.arcs, `шлейф ${inf.trail}, молнии ${inf.arcs}`);
    let arcsVisible = false, uTime = null, uTime2 = null;
    sp.root.traverse((o) => { if (o.material && o.material.name === 'spirit-arcs' && o.visible) arcsVisible = true; if (o.material && o.material.name === 'spirit-bone') uTime = o.material.uniforms.uTime.value; });
    assert.ok(!arcsVisible, 'молнии скрыты');
    const s0 = sp.info().slit;
    let dev = 0;
    for (let i = 0; i < 30; i++) { sp.frame(DT, (T += 16), ctx()); dev = Math.max(dev, Math.abs(sp.info().slit - s0)); }
    sp.root.traverse((o) => { if (o.material && o.material.name === 'spirit-bone') uTime2 = o.material.uniforms.uTime.value; });
    assert.ok(dev < 0.005, `щель не мерцает: ${dev}`);
    let halo = null;
    sp.root.traverse((o) => { if (o.isInstancedMesh && o.geometry.type === 'TorusGeometry') halo = o; });
    const hc0 = Array.from(halo.geometry.attributes.aColor.array);
    let hdev = 0;
    for (let i = 0; i < 30; i++) { sp.frame(DT, (T += 16), ctx()); const hc = halo.geometry.attributes.aColor.array; hdev = Math.max(hdev, Math.abs(hc[0] - hc0[0]), Math.abs(hc[1] - hc0[1])); }
    assert.ok(hc0[0] + hc0[1] > 0.1 && hdev < 0.005, `нимб не пульсирует: ${hdev} (цвет ${hc0})`);
    assert.equal(uTime2, uTime, 'время шейдеров стоит — свет не бежит');
  } finally { settings.reducedMotion = false; }
  run(sp, 0.5, () => close());
  assert.ok(sp.info().trail > 0, 'шлейф вернулся');
});

test('отладка: X/G (удержание) — ладони сомкнуты и щель по оси, отпустил — разлёт в стороны / вверх-вниз; U без сцены — руки не вверх', () => {
  const dbg = (input) => () => ({ screen: 'playing', debug: true, input: { valid: true, source: 'debug', ...input } });
  run(sp, 1.2, dbg({ sigilCharge: 0.8, sigilAxis: 'h' }));
  let j = sp.info().joints;
  assert.ok(Math.abs(j.rightWrist.x - j.leftWrist.x) < 0.4 && sp.info().slitAxis === 'h', `ладони сомкнуты: ${j.leftWrist.x}…${j.rightWrist.x}`);
  sp.frame(DT, (T += 16), dbg({ sigil: 'gate', sigilPower: 0.9 })());
  run(sp, 0.45, dbg({}));
  j = sp.info().joints;
  assert.ok(j.rightWrist.x - j.leftWrist.x > 1.5 && Math.abs(j.leftWrist.y + 0.05) < 0.15 && Math.abs(j.rightWrist.y + 0.05) < 0.15, `в стороны у груди: ${j.leftWrist.x}…${j.rightWrist.x}, y ${j.leftWrist.y} / ${j.rightWrist.y}`);
  run(sp, 1.2, dbg({ sigilCharge: 0.8, sigilAxis: 'v' }));
  sp.frame(DT, (T += 16), dbg({ sigil: 'pillar', sigilPower: 0.9 })());
  run(sp, 0.45, dbg({}));
  j = sp.info().joints;
  assert.ok(j.rightWrist.y - j.leftWrist.y > 1.2, `вверх-вниз: ${j.leftWrist.y}…${j.rightWrist.y}`);
  // U при неполной шкале: бой даёт «Искру», а input.ultimate приходит всё равно — руки духа не поднимаются
  run(sp, 1.5, dbg({}));
  sp.frame(DT, (T += 16), dbg({ spark: true, ultimate: true })());
  run(sp, 0.5, dbg({}));
  j = sp.info().joints;
  assert.ok(j.leftWrist.y < j.head.y && sp.info().ult < 0.05, `руки не вверх: ${j.leftWrist.y} < ${j.head.y}`);
  assert.ok(finite(sp));
});

test('dispose: снят с камеры, каждый geometry/material/texture освобождён; кадр после dispose — без ошибок', () => {
  const res = sp.resources();
  assert.ok(res.length > 10, `ресурсов ${res.length}`);
  let freed = 0;
  for (const r of res) r.addEventListener('dispose', () => freed++);
  sp.dispose();
  assert.equal(sp.root.parent, null);
  assert.equal(freed, res.length, `освобождено ${freed} из ${res.length}`);
  sp.frame(DT, (T += 16), ctxOf({ x: -0.9, y: 0 }, { x: 0.9, y: 0 }));
  sp.dispose();
});

test('без камеры (scene): дух в сцене; low с самого начала', () => {
  const sc = new THREE.Scene();
  const sp2 = createSpiritAvatar({ THREE, scene: sc, settings: { quality: 'low' } });
  assert.equal(sp2.root.parent, sc);
  run(sp2, 0.5, () => ({ screen: 'playing', debug: true, input: { valid: true } }));
  assert.ok(finite(sp2));
  sp2.dispose();
  assert.equal(sp2.root.parent, null);
  assert.equal(J.COUNT, 53);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
