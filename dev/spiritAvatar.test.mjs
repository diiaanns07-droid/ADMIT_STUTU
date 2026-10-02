// [W3-SPIRIT] node-тест духа игрока (modules/spiritAvatar.js): создание, поза и кисти → плечи, локти и 2×21 точка
// пальцев, зеркало как на превью, сглаживание (без дрожи, без запаздывания), угасание при потере трекинга, реакции
// (жест, «ОШИБКА», щит, заряд, ось и каст магии ладонями, «Небесный суд», облёт камеры, «Уменьшенное движение»),
// синтетика «Отладки с клавиатуры», настройка «Дух игрока», low без
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
  sp.root.traverse((o) => { const a = o.geometry && o.geometry.attributes.position; if (a && !Array.from(a.array).every(Number.isFinite)) ok = false; });
  return ok;
};

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

// [W3-MAGIC] щель света: первые 5 отрезков геометрии молний (spirit-arcs) — лучи по оси растяжения ладоней
function slitDir() {
  let arcs = null;
  sp.root.traverse((o) => { if (o.material && o.material.name === 'spirit-arcs') arcs = o; });
  if (!arcs || !arcs.visible) return null;
  const a = arcs.geometry.attributes.position.array, i = 2 * 2 * 3;   // средний (самый яркий) луч
  return { dx: Math.abs(a[i + 3] - a[i]), dy: Math.abs(a[i + 4] - a[i + 1]) };
}

test('магия ладонями (PR №13): sigilAxis h/v — щель света по оси; sigil_cast — вспышка во весь размах', () => {
  const together = () => ctxOf({ x: -0.12, y: 0.2 }, { x: 0.12, y: 0.2 });
  run(sp, 0.6, () => ({ ...together(), snapshot: { player: { sigilCharge: 0.8, sigilAxis: 'h' } } }));
  let inf = sp.info(), d = slitDir();
  assert.ok(inf.charge > 0.6 && inf.axis === 'h', `заряд ${inf.charge}, ось ${inf.axis}`);
  assert.ok(d && d.dx > 4 * d.dy && d.dx > 0.3, `щель по горизонтали ${JSON.stringify(d)}`);
  run(sp, 0.6, () => ({ ...together(), snapshot: { player: { sigilCharge: 0.8, sigilAxis: 'v' } } }));
  inf = sp.info(); d = slitDir();
  assert.ok(inf.axis === 'v' && d && d.dy > 4 * d.dx, `щель по вертикали ${inf.axis} ${JSON.stringify(d)}`);
  // каст «Столп небес»: вспышка обеих рук, кольцо, щель во весь размах — и гаснет
  const rings0 = inf.rings;
  sp.frame(DT, (T += 16), { ...together(), snapshot: { player: { sigilCharge: 0, sigilAxis: null } }, events: [{ id: 's1', type: 'sigil_cast', position: { x: 0, y: 1, z: 0 }, data: { sigil: 'pillar', power: 0.9 } }] });
  inf = sp.info(); d = slitDir();
  assert.ok(inf.slit > 0.9 && inf.slitH === 0 && inf.flash[0] > 0.8 && inf.flash[1] > 0.8 && inf.rings > rings0, `каст ${JSON.stringify({ slit: inf.slit, slitH: inf.slitH, flash: inf.flash, rings: inf.rings })}`);
  assert.ok(d && d.dy > 2.5, `щель во весь размах ${JSON.stringify(d)}`);
  // тот же каст импульсом ввода в соседнем кадре — одна вспышка, не две
  sp.frame(DT, (T += 16), { ...together(), input: { valid: true, sigil: 'pillar' } });
  assert.ok(sp.info().slit <= inf.slit + 1e-6, 'без повторной вспышки');
  run(sp, 1.2, () => ({ ...together(), snapshot: { player: { sigilCharge: 0, sigilAxis: null } } }));
  assert.ok(sp.info().slit < 0.01 && sp.info().axis === null && slitDir() === null, `погасло ${sp.info().slit}`);
  // «Врата бури» импульсом ввода (обучение, тренажёр — без событий боя): щель по горизонтали
  sp.frame(DT, (T += 16), { ...together(), input: { valid: true, sigil: 'gate' } });
  inf = sp.info(); d = slitDir();
  assert.ok(inf.slit > 0.9 && inf.slitH === 1 && d && d.dx > 4 * d.dy, `врата ${inf.slitH} ${JSON.stringify(d)}`);
  run(sp, 1.2, () => together());
});

test('ультимейт (PR №14): ultimate_ready — нимб зовёт, ultimate_start/strike — руки вверх, ultimate_end — выдох', () => {
  run(sp, 2.5, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
  const r0 = sp.info().rings;
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 100, furyReady: true } }, events: [{ id: 'r', type: 'ultimate_ready', position: { x: 0, y: 0, z: 0 }, data: { fury: 100 } }] });
  assert.ok(sp.info().ready > 0.9 && sp.info().rings > r0, `ready ${sp.info().ready}`);
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 }, ultimate: { active: true, t: 0 } }, events: [{ id: 'us', type: 'ultimate_start', position: { x: 0, y: 1, z: 0 }, data: { duration: 3.6, strikeAt: 2.3 } }] });
  assert.ok(sp.info().ult > 0.9, `старт ${sp.info().ult}`);
  run(sp, 2.2, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 }, ultimate: { active: true, t: 1 } } }));
  let inf = sp.info();
  assert.ok(inf.ult >= 0.7 && inf.cine > 0.9, `сцена: руки вверх ${inf.ult}, приглушён ${inf.cine}`);
  assert.ok(inf.joints.leftWrist.y > inf.joints.head.y - 0.2 && inf.joints.rightWrist.y > inf.joints.head.y - 0.2, 'руки духа подняты');
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 }, ultimate: { active: true, t: 2.3 } }, events: [{ id: 'st', type: 'ultimate_strike', position: { x: 0, y: 3, z: -20 }, data: { amount: 250 } }] });
  assert.ok(sp.info().ult > 0.95, 'удар');
  sp.frame(DT, (T += 16), { ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 } }, events: [{ id: 'ue', type: 'ultimate_end', position: { x: 0, y: 0, z: 0 }, data: { struck: true } }] });
  assert.ok(sp.info().ult <= 0.5, `выдох ${sp.info().ult}`);
  run(sp, 2, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: { player: { fury: 0 } } }));
  inf = sp.info();
  assert.ok(inf.ult < 0.05 && inf.cine < 0.05, `сцена кончилась ${inf.ult} ${inf.cine}`);
});

test('облёт камеры: дух в небе всегда дальше и героя, и Регента (между камерой и героем не встаёт)', () => {
  const cam0 = camera.position.clone();
  try {
    // камера перед Регентом смотрит на героя за 26 м: дух должен быть дальше героя
    camera.position.set(0, 3, -16);
    camera.updateMatrixWorld(true);
    const snap = { player: { position: { x: 0, y: 0, z: 10 } }, boss: { position: { x: 0, y: 0, z: -20 } }, ultimate: { active: true, t: 1 } };
    run(sp, 0.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: snap }));
    const dHero = Math.hypot(0, 1.2 - 3, 10 + 16);
    assert.ok(sp.info().skyDepth > dHero + 5, `глубина ${sp.info().skyDepth} при герое в ${dHero.toFixed(1)} м`);
    // обычный бой: камера за героем — дух за Регентом
    camera.position.set(0, 3, 16); camera.updateMatrixWorld(true);
    const snap2 = { player: { position: { x: 0, y: 0, z: 10 } }, boss: { position: { x: 0, y: 0, z: 0 } } };
    run(sp, 0.5, () => ({ ...ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }), snapshot: snap2 }));
    assert.ok(sp.info().skyDepth > Math.hypot(16, 0) + 5, `за Регентом ${sp.info().skyDepth}`);
  } finally { camera.position.copy(cam0); camera.updateMatrixWorld(true); }
  run(sp, 1, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
});

test('«Уменьшенное движение»: без шлейфа, молнии заряда не мерцают', () => {
  settings.reducedMotion = true;
  try {
    run(sp, 0.6, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), snapshot: { player: { sigilCharge: 0.9 } } }));
    const s0 = sp.info().arcSeed;
    run(sp, 0.5, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), snapshot: { player: { sigilCharge: 0.9 } } }));
    assert.equal(sp.info().arcSeed, s0, 'молнии не перерисовываются');
    assert.equal(sp.info().trail, 0, 'шлейфа нет');
  } finally { settings.reducedMotion = false; }
  const s1 = sp.info().arcSeed;
  run(sp, 0.3, () => ({ ...ctxOf({ x: -0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), snapshot: { player: { sigilCharge: 0.9 } } }));
  assert.notEqual(sp.info().arcSeed, s1, 'без «Уменьшенного движения» молнии живые');
  run(sp, 1, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
});

test('«Дух игрока» выключен — гаснет и не рисуется; включён — возвращается', () => {
  settings.spiritAvatar = false;
  try {
    run(sp, 2, () => ctxOf({ x: -0.9, y: -0.4 }, { x: 0.9, y: 0.5 }));
    assert.ok(sp.info().alpha < 0.01 && !sp.info().skyVisible, `alpha ${sp.info().alpha}`);
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
  settings.quality = 'high';
  run(sp, 0.2, () => ctxOf({ x: -0.9, y: 0 }, { x: 0.9, y: 0 }));
  assert.equal(sp.info().tier, 'high');
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
