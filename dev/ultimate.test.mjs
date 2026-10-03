// =============================================================================
// ultimate.test.mjs — [W3-ULT] «Ярость клятвы» и «Небесный суд». Node 22+: node dev/ultimate.test.mjs
// 1) детектор позы core/ultimate.js: обе руки / одна / «руки вверх» локтями вниз / запястья за кадром /
//    плечи не видны; автомат удержания 0,8 с: поднял, одна рука, рано опустил, шум точек и провалы
//    трекинга, обычные боевые позы не срабатывают, подсказки не чаще раза в 4 с;
// 2) бой modules/combat.js: шкала копится от урона, серий, идеального уклонения и парирования; сцена
//    игнорирует ввод, Регент не бьёт, урон 25–30 % HP на обеих сложностях без множителей; добивание
//    мечом; «Новичок»; вне арены — отказ; в дуэли ультимейта нет; бот побеждает и с ультимейтом;
// 3) камера core/cameraRig.js: облёт начинается без прыжка, уходит от обычной камеры и возвращается к ней;
// 4) отладка: U — импульс ultimate (и «Искра», если шкала не полна).
// =============================================================================
import { armsRaised, createUltimateGesture, ultTimeScale, ultCameraKeys, ULT_GESTURE_DEFAULTS } from '../core/ultimate.js';
import { createCombat, DEFAULT_COMBAT_CONFIG } from '../modules/combat.js';
import { createCameraRig } from '../core/cameraRig.js';
import { createDebugInput } from '../core/debugInput.js';
import { createPvpSession, createMemoryNetPair } from '../modules/pvp.js';
import { config as gameConfig } from '../config.js';
import { COACH_HINTS } from '../core/gestureCoach.js';

const results = [];
const facts = {};
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e && e.message ? e.message : String(e) }); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assert'); }
function near(a, b, eps, msg) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg || 'near'}: ${a} ≠ ${b} ±${eps}`); }

// ------------------------------------------------------------ синтетическая поза (33 точки MediaPipe, кадр 4:3)
// Человек в метре от камеры: плечи на y=0.62, ширина плеч ≈0.24 кадра. arm: 'up' — прямо вверх, 'v' — «V»
// над головой, 'down' — вниз, 'chest' — ладонь у груди (ход), 'front' — «OK» перед собой, 'surrender' — «руки
// вверх» локтями на уровне плеч, 'sphere' — ладони у груди друг к другу.
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function gauss() { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const ARM = {
  up: { e: [0.03, -0.17], w: [0.01, -0.36] },
  v: { e: [0.08, -0.13], w: [0.15, -0.3] },
  down: { e: [0.03, 0.16], w: [0.04, 0.31] },
  chest: { e: [0.05, 0.15], w: [-0.07, 0.07] },
  front: { e: [0.07, 0.12], w: [0.02, -0.02] },
  surrender: { e: [0.15, 0.0], w: [0.16, -0.16] },
  sphere: { e: [0.05, 0.15], w: [-0.05, 0.05] },
};
function pose(left, right, o = {}) {
  const L = [];
  for (let i = 0; i < 33; i++) L.push({ x: 0.5, y: 0.9, visibility: 0.2 });
  const shY = 0.62, cx = 0.5, hw = 0.09;   // плечи: ±0.09 по x (×4/3 → ширина ≈0.24 высоты кадра)
  const put = (i, x, y, v = 0.98) => { L[i] = { x, y, visibility: v }; };
  put(0, cx, shY - 0.14);               // нос
  put(2, cx - 0.02, shY - 0.16); put(5, cx + 0.02, shY - 0.16); put(7, cx - 0.045, shY - 0.15); put(8, cx + 0.045, shY - 0.15);
  // левый у человека — справа на кадре без зеркала
  const sL = [cx + hw, shY], sR = [cx - hw, shY];
  put(11, sL[0], sL[1]); put(12, sR[0], sR[1]);
  const arm = (S, sg, kind, iE, iW) => {
    const a = ARM[kind];
    put(iE, S[0] + sg * a.e[0], S[1] + a.e[1]);
    let wy = S[1] + a.w[1], wv = 0.95;
    if (o.wristOut && (kind === 'up' || kind === 'v')) { wy = S[1] + a.w[1] - 0.2; wv = 0.08; }   // за верхним краем кадра
    put(iW, S[0] + sg * a.w[0], wy, wv);
  };
  arm(sL, 1, left, 13, 15);
  arm(sR, -1, right, 14, 16);
  if (o.noShoulders) { L[11].visibility = 0.1; L[12].visibility = 0.1; }
  if (o.noise) for (const q of L) { q.x += gauss() * o.noise; q.y += gauss() * o.noise; }
  return L;
}
const frameOf = (L, tMs) => ({ tMs, frameW: 640, frameH: 480, landmarks: L });

// ------------------------------------------------------------ 1. детектор
test('детектор: обе руки над головой — да; «V» над головой — да', () => {
  const r = armsRaised(pose('up', 'up'), { aspect: 4 / 3 });
  assert(r.ok && r.both && r.count === 2, JSON.stringify(r));
  assert(armsRaised(pose('v', 'v'), { aspect: 4 / 3 }).both, 'V');
});
test('детектор: одна рука — одна; вниз — ни одной; по сторонам точно', () => {
  const r = armsRaised(pose('up', 'down'), { aspect: 4 / 3 });
  assert(r.count === 1 && r.left.up && !r.right.up, 'левая');
  const r2 = armsRaised(pose('down', 'up'), { aspect: 4 / 3 });
  assert(r2.count === 1 && r2.right.up && !r2.left.up, 'правая');
  assert(armsRaised(pose('down', 'down'), { aspect: 4 / 3 }).count === 0, 'вниз');
});
test('детектор: «руки вверх» с локтями на уровне плеч — не засчитано (нужны локти выше плеч)', () => {
  const r = armsRaised(pose('surrender', 'surrender'), { aspect: 4 / 3 });
  assert(!r.both && !r.left.elbowUp, JSON.stringify(r.left));
});
test('детектор: запястья за верхним краем кадра (видимость 0.08) при высоких локтях — засчитано', () => {
  const r = armsRaised(pose('up', 'up', { wristOut: true }), { aspect: 4 / 3 });
  assert(r.both, JSON.stringify(r.left));
});
test('детектор: и локти за верхним краем кадра (видимость 0.1, высоко над плечами) — засчитано; низко и невидимо — нет', () => {
  const L = pose('up', 'up', { wristOut: true });
  for (const i of [13, 14]) { L[i].y -= 0.1; L[i].visibility = 0.1; }
  assert(armsRaised(L, { aspect: 4 / 3 }).both, 'локти за кадром');
  const D = pose('down', 'down');
  for (const i of [13, 14, 15, 16]) { D[i].visibility = 0.1; }
  assert(armsRaised(D, { aspect: 4 / 3 }).count === 0, 'опущенные невидимые руки');
});
test('детектор: плечи не видны — ok=false, ничего не засчитано', () => {
  const r = armsRaised(pose('up', 'up', { noShoulders: true }), { aspect: 4 / 3 });
  assert(!r.ok && !r.both && r.count === 0, JSON.stringify(r));
  assert(!armsRaised(null).ok && !armsRaised([]).ok, 'пусто');
});
test('детектор: нос закрыт — высота лица по глазам/ушам', () => {
  const L = pose('up', 'up'); L[0].visibility = 0.05;
  assert(armsRaised(L, { aspect: 4 / 3 }).both, 'без носа');
});

// ------------------------------------------------------------ автомат удержания
// Прогон: kinds(t) → [left, right] | null (нет позы); hz — частота камеры; drop — доля пропавших кадров
function run(g, sec, kinds, { hz = 30, noise = 0, drop = 0, armed = true, t0 = 0 } = {}) {
  const out = { fired: [], hints: [], progress: [], phases: [] };
  const n = Math.round(sec * hz);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / hz, ms = t * 1000;
    const k = kinds(t - t0);
    const pz = !k || rnd() < drop ? null : frameOf(pose(k[0], k[1], { noise }), ms);
    const f = g.push(pz, ms, { armed });
    if (f.fired) out.fired.push(t - t0);
    if (f.hint) out.hints.push({ code: f.hint, side: f.side, t: t - t0 });
    out.progress.push(f.progress); out.phases.push(f.phase);
  }
  return out;
}
test('жест: подняли обе руки — срабатывает один раз через 0,8 с, прогресс растёт', () => {
  const g = createUltimateGesture();
  const r = run(g, 2.5, (t) => (t < 0.3 ? ['down', 'down'] : ['up', 'up']));
  assert(r.fired.length === 1, `срабатываний ${r.fired.length}`);
  near(r.fired[0], 0.3 + ULT_GESTURE_DEFAULTS.holdSec, 0.08, 'момент');
  assert(r.hints.length === 0, 'без подсказок');
  const mid = r.progress[Math.round(0.7 * 30)];
  assert(mid > 0.4 && mid < 0.7, `прогресс на 0,4 с удержания ${mid}`);
});
test('жест: одна рука — подсказка «ult_one_hand» про опущенную руку, без срабатывания', () => {
  const g = createUltimateGesture();
  const r = run(g, 2, () => ['up', 'down']);
  assert(r.fired.length === 0, 'не сработал');
  assert(r.hints.length === 1 && r.hints[0].code === 'ult_one_hand', JSON.stringify(r.hints));
  assert(r.hints[0].side === 'right', 'поднять надо правую');
  assert(COACH_HINTS.ult_one_hand && COACH_HINTS.ult_early, 'тексты подсказок');
});
test('жест: опустили рано (0,45 с) — подсказка «ult_early», без срабатывания; потом удержание — срабатывает', () => {
  const g = createUltimateGesture();
  const r = run(g, 1.5, (t) => (t < 0.45 ? ['up', 'up'] : ['down', 'down']));
  assert(r.fired.length === 0 && r.hints.length === 1 && r.hints[0].code === 'ult_early', JSON.stringify(r));
  const r2 = run(g, 1.5, () => ['up', 'up'], { t0: 1.5 });
  assert(r2.fired.length === 1, 'вторая попытка');
});
test('жест: шум точек σ=0,012, 15 % кадров пропало, 15 Гц — срабатывает за 0,8–1,3 с', () => {
  for (let k = 0; k < 20; k++) {
    seed = 777 + k;
    const g = createUltimateGesture();
    const r = run(g, 2.5, () => ['up', 'up'], { hz: 15, noise: 0.012, drop: 0.15 });
    assert(r.fired.length === 1, `прогон ${k}: срабатываний ${r.fired.length}`);
    assert(r.fired[0] >= 0.75 && r.fired[0] <= 1.3, `прогон ${k}: ${r.fired[0]}`);
  }
});
test('жест: провал трекинга 0,1 с посреди удержания не сбрасывает, 0,5 с — сбрасывает', () => {
  const g = createUltimateGesture();
  const r = run(g, 2, (t) => (t > 0.4 && t < 0.5 ? null : ['up', 'up']));
  near(r.fired[0], 0.9, 0.12, 'короткий провал');
  const g2 = createUltimateGesture();
  const r2 = run(g2, 2.2, (t) => (t > 0.4 && t < 0.9 ? null : ['up', 'up']));
  assert(r2.fired.length === 1 && r2.fired[0] > 1.6, `после долгого провала — заново: ${r2.fired}`);
});
test('жест: боевые позы 20 с с шумом (ход, «OK», сфера, щит) — ни срабатываний, ни подсказок', () => {
  seed = 4242;
  const g = createUltimateGesture();
  const seq = [['chest', 'down'], ['chest', 'front'], ['sphere', 'sphere'], ['front', 'front'], ['down', 'front'], ['surrender', 'down']];
  const r = run(g, 20, (t) => seq[Math.floor(t / 1.7) % seq.length], { noise: 0.01, drop: 0.05 });
  assert(r.fired.length === 0 && r.hints.length === 0, JSON.stringify({ f: r.fired, h: r.hints }));
});
test('жест: шкала не полна (armed=false) — руки вверх ничего не делают', () => {
  const g = createUltimateGesture();
  const r = run(g, 3, (t) => (t < 1.5 ? ['up', 'up'] : ['up', 'down']), { armed: false });
  assert(r.fired.length === 0 && r.hints.length === 0 && r.progress.every((p) => p === 0), 'тишина');
});
test('жест: после срабатывания — второй раз только после опускания рук', () => {
  const g = createUltimateGesture();
  const r = run(g, 3, () => ['up', 'up']);
  assert(r.fired.length === 1, 'держим руки — один раз');
  run(g, 0.5, () => ['down', 'down'], { t0: 3 });
  const r2 = run(g, 1.5, () => ['up', 'up'], { t0: 3.5 });
  assert(r2.fired.length === 1, 'снова');
});
test('жест: подсказка «одна рука» — не чаще раза в 4 с', () => {
  const g = createUltimateGesture();
  const r = run(g, 9, (t) => (Math.floor(t / 1.5) % 2 ? ['down', 'down'] : ['down', 'up']));
  assert(r.hints.length >= 2 && r.hints.length <= 3, `подсказок ${r.hints.length}`);
  for (let i = 1; i < r.hints.length; i++) assert(r.hints[i].t - r.hints[i - 1].t >= ULT_GESTURE_DEFAULTS.hintCooldownSec - 1e-6, 'интервал');
});

// ------------------------------------------------------------ 2. бой
const H = 1 / 120;
const I = (o = {}) => ({ valid: true, source: 'test', moveX: 0, moveZ: 0, attack: false, shield: false, ...o });
function idleBrain() { const b = { calls: 0 }; b.reset = () => {}; b.update = () => { b.calls++; return { stage: 1, action: 'idle', attacks: [] }; }; return b; }
function scriptBrain(entries) {
  const b = { calls: 0, t: 0, done: new Set() };
  b.reset = () => { b.t = 0; b.done = new Set(); };
  b.update = (dt, snap) => {
    b.calls++; b.t += dt;
    const attacks = [];
    entries.forEach((e, i) => { if (!b.done.has(i) && b.t + 1e-9 >= e.at) { b.done.add(i); attacks.push({ ...e.spec }); } });
    return { stage: 1, action: attacks.length || snap.telegraphs.length ? 'windup' : 'idle', attacks };
  };
  return b;
}
function runFor(c, sec, inputFn, onStep) {
  const ev = [];
  const n = Math.round(sec / H);
  for (let i = 0; i < n; i++) {
    c.update(H, inputFn ? inputFn(i * H) : I());
    const e = c.drainEvents();
    for (const x of e) ev.push(x);
    if (onStep) onStep(c, e, i * H);
  }
  return ev;
}
const count = (ev, type, f) => ev.filter((e) => e.type === type && (!f || f(e))).length;

test('ярость: копится от урона по Регенту и серии, ultimate_ready — один раз', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  let readyAt = -1, hpAtReady = 0;
  const ev = runFor(c, 40, () => I({ attack: c.getSnapshot().player.furyReady !== true }), (cc, e, t) => { if (readyAt < 0 && e.some((x) => x.type === 'ultimate_ready')) { readyAt = t; hpAtReady = cc.getSnapshot().boss.hp; } });
  const s = c.getSnapshot();
  assert(readyAt > 5 && readyAt < 35, `шкала полна на ${readyAt} с`);
  assert(count(ev, 'ultimate_ready') === 1 && s.player.furyReady && s.player.fury === s.player.furyMax, 'одно событие, шкала полна');
  const dealt = DEFAULT_COMBAT_CONFIG.boss.maxHp - hpAtReady;
  assert(dealt > DEFAULT_COMBAT_CONFIG.boss.maxHp * 0.2, `шкала не полна от пары ударов (урон ${dealt})`);
  assert(dealt < DEFAULT_COMBAT_CONFIG.boss.maxHp * 0.6, `к полной шкале не убили Регента (урон ${dealt})`);
});
test('ярость: идеальное уклонение и парирование дают свою долю', () => {
  const U = DEFAULT_COMBAT_CONFIG.ultimate;
  const slam = { id: 's1', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 0.6, radius: 7, damage: 20, blockable: false, projectileSpeed: 0 };
  const c = createCombat({ config: {}, bossBrain: scriptBrain([{ at: 0, spec: slam }]) });
  // рывок за ~0,1 с до удара — в окне идеального уклонения
  const ev = runFor(c, 1.2, (t) => I({ dash: t >= 0.5 && t < 0.5 + H ? 1 : 0 }));
  assert(count(ev, 'perfect_dodge') === 1, 'идеальное уклонение');
  near(c.getSnapshot().player.fury, U.perfectDodge, 1e-6, 'ярость за уклонение');
  const orb = { id: 'o1', kind: 'orb', origin: { x: 0, y: 2.2, z: 0 }, target: { x: 0, y: 1.2, z: 6 }, windup: 0.4, radius: 0.5, damage: 15, blockable: true, projectileSpeed: 12 };
  const p = createCombat({ config: {}, bossBrain: scriptBrain([{ at: 0, spec: orb }]) });
  let parried = false;
  const ev2 = runFor(p, 2, (t) => {
    const s = p.getSnapshot();
    const near1 = s.projectiles.some((q) => q.owner === 'boss' && Math.hypot(q.position.x - s.player.position.x, q.position.z - s.player.position.z) < 2.2);
    if (near1 && !parried) { parried = true; return I({ parry: true }); }
    return I();
  });
  assert(count(ev2, 'parry', (e) => e.data.success) === 1, 'парирование');
  assert(p.getSnapshot().player.fury >= U.parry - 1e-6, `ярость за парирование ${p.getSnapshot().player.fury}`);
});
test('ультимейт: шкала не полна — импульс игнорируется, «Искра» (U в отладке) летит как обычно', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  c.update(H, I({ ultimate: true, spark: true }));
  const ev = runFor(c, 0.5, () => I());
  assert(count(ev, 'ultimate_start') === 0 && c.getSnapshot().ultimate === null, 'нет сцены');
  assert(ev.some((e) => e.type === 'player_cast' && e.data && e.data.ability === 'spark') || c.getSnapshot().projectiles.some((q) => q.kind === 'spark') || count(ev, 'boss_hit') > 0, 'искра');
});
test('ультимейт: сцена — ввод игнорируется, Регент не думает, его удары рассеяны; урон в strikeAt; конец и неуязвимость', () => {
  const U = DEFAULT_COMBAT_CONFIG.ultimate;
  const orb = { id: 'o2', kind: 'orb', origin: { x: 0, y: 2.2, z: 0 }, target: { x: 0, y: 1.2, z: 6 }, windup: 0.4, radius: 0.5, damage: 15, blockable: true, projectileSpeed: 6 };
  const slam = { id: 's2', kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 6 }, windup: 2.5, radius: 2.5, damage: 20, blockable: false, projectileSpeed: 0 };
  const brain = scriptBrain([{ at: 0, spec: orb }, { at: 0.05, spec: slam }]);
  const c = createCombat({ config: {}, bossBrain: brain });
  runFor(c, 0.6, () => I());
  assert(c.getSnapshot().projectiles.some((q) => q.owner === 'boss') && c.getSnapshot().telegraphs.length >= 1, 'сфера летит, удар готовится');
  c.setFury(100);
  const hp0 = c.getSnapshot().boss.hp, calls0 = brain.calls;
  c.update(H, I({ ultimate: true }));
  let ev = c.drainEvents();
  assert(count(ev, 'ultimate_start') === 1, 'старт');
  assert(count(ev, 'projectile_impact', (e) => e.data.result === 'dispelled') >= 1, 'сфера рассеяна');
  const s1 = c.getSnapshot();
  assert(s1.telegraphs.length === 0 && !s1.projectiles.some((q) => q.owner === 'boss'), 'нет ударов Регента');
  assert(s1.player.fury === 0 && !s1.player.furyReady && s1.ultimate && s1.ultimate.active, 'шкала пуста, сцена идёт');
  // всю сцену: огонь, рывок, щит, выброс — ничего
  const callsStart = brain.calls;
  let callsEnd = -1;
  ev = runFor(c, U.duration + 0.05, (t) => I({ attack: true, shield: true, burst: t < 0.1, dash: t < 0.1 ? 1 : 0, spark: true }),
    (cc, e) => { if (callsEnd < 0 && e.some((x) => x.type === 'ultimate_end')) callsEnd = brain.calls; });
  assert(callsStart - calls0 <= 1 && callsEnd === callsStart, `мозг Регента в сцене не вызывался (${callsEnd - callsStart})`);
  const inScene = ev.slice(0, ev.findIndex((e) => e.type === 'ultimate_end') + 1);
  assert(count(inScene, 'player_dash') === 0 && count(inScene, 'shield_start') === 0 && count(inScene, 'burst') === 0 && count(inScene, 'player_hit') === 0, 'ввод проигнорирован, удара нет');
  assert(!inScene.some((e) => e.type === 'player_cast' || (e.type === 'boss_hit' && e.data.source !== 'ultimate')), 'снарядов героя в сцене нет');
  const strikes = ev.filter((e) => e.type === 'boss_hit' && e.data.source === 'ultimate');
  assert(strikes.length === 1 && count(ev, 'ultimate_strike') === 1 && count(ev, 'ultimate_end') === 1, 'один удар, один конец');
  near(strikes[0].data.amount, Math.round(DEFAULT_COMBAT_CONFIG.boss.maxHp * U.damagePct), 1e-6, 'урон');
  near(c.getSnapshot().boss.hp, hp0 - strikes[0].data.amount, 1e-6, 'HP Регента');
  const s2 = c.getSnapshot();
  assert(s2.ultimate === null && s2.player.invulnerable && s2.player.action !== 'cast', 'конец сцены, неуязвимость');
  // после сцены бой идёт дальше: мозг снова думает
  runFor(c, 0.2, () => I());
  assert(brain.calls > calls0, 'Регент снова думает');
});
test('ультимейт: урон 25–30 % HP на обеих сложностях, без множителей серии и метки', () => {
  for (const lvl of ['easy', 'normal']) {
    const c = createCombat({ config: {}, bossBrain: idleBrain() });
    c.setDifficulty(lvl);
    c.reset();
    runFor(c, 6, () => I({ attack: true }));     // серия попаданий: множитель комбо > 1
    c.update(H, I({ sigil: 'frame' }));          // метка цели +30 %
    runFor(c, 0.4, () => I());
    const s0 = c.getSnapshot();
    assert(s0.player.comboMultiplier > 1.05, 'серия');
    c.setFury(100);
    c.update(H, I({ ultimate: true }));
    const ev = runFor(c, 3.7, () => I());
    const hit = ev.find((e) => e.type === 'boss_hit' && e.data.source === 'ultimate');
    const pct = hit.data.amount / s0.boss.maxHp;
    assert(pct >= 0.25 && pct <= 0.3, `${lvl}: ${(pct * 100).toFixed(1)} %`);
  }
});
test('ультимейт: меч добивает Регента — победа в момент удара, сцена снята, ultimate_end нет', () => {
  const c = createCombat({ config: { boss: { maxHp: 1000 } }, bossBrain: idleBrain() });
  runFor(c, 60, () => I({ attack: c.getSnapshot().boss.hp > 200 }));
  assert(c.getSnapshot().boss.hp <= 200 && c.getSnapshot().status === 'playing', 'Регент ослаб');
  c.setFury(100);
  c.update(H, I({ ultimate: true }));
  const ev = runFor(c, 4, () => I());
  const s = c.getSnapshot();
  assert(s.status === 'victory' && count(ev, 'victory') === 1 && count(ev, 'ultimate_end') === 0, 'победа');
  assert(s.ultimate === null && s.player.action !== 'cast', 'снимок без сцены');
});
test('ультимейт: работает в «Новичке»; вне арены — отказ «far»; в дуэли — нет', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  c.setFury(100);
  c.update(H, I({ ultimate: true, gestureMode: 'novice' }));
  assert(count(c.drainEvents(), 'ultimate_start') === 1, 'Новичок');
  const far = createCombat({ config: {}, bossBrain: idleBrain(), layout: { arena: { x: 0, z: 0, r: 13, leash: 6 }, playerSpawn: { x: 0, z: 30, yaw: Math.PI }, bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 }, colliders: [], isWalkable: () => true, groundY: () => 0 } });
  assert(far.getSnapshot().player.encounter === 'explore', 'вне арены');
  far.setFury(100);
  far.update(H, I({ ultimate: true }));
  const fe = far.drainEvents();
  assert(count(fe, 'ultimate_start') === 0 && count(fe, 'ability_denied', (e) => e.data.ability === 'ultimate' && e.data.reason === 'far') === 1, 'отказ');
  const d = createCombat({ config: {}, bossBrain: idleBrain() });
  const s = createPvpSession({ combat: d, net: createMemoryNetPair().a, clock: () => 0 });
  s.start();
  assert(d.getMode() === 'pvp' && d.setFury(100) === 0 && !d.getSnapshot().player.furyReady, 'дуэль: шкалы нет');
  d.update(H, I({ ultimate: true }));
  assert(count(d.drainEvents(), 'ultimate_start') === 0, 'дуэль: без ультимейта');
  s.stop();
});
// разумный бот (как в combat.test.js) + «Небесный суд», как только шкала полна
function loopBrain() {
  const b = {};
  let time = 0, next = 1.5, seq = 0, i = 0;
  b.reset = () => { time = 0; next = 1.5; seq = 0; i = 0; };
  b.update = (dt, snap) => {
    time += dt;
    const stage = snap.boss.hp <= snap.boss.maxHp * 0.5 ? 2 : 1;
    const attacks = [];
    if (time >= next) {
      const kind = ['slam', 'orb', 'nova', 'orb'][i++ % 4];
      const pp = snap.player.position, id = `l${++seq}`;
      if (kind === 'slam') attacks.push({ id, kind, origin: { x: 0, y: 0, z: 0 }, target: { x: pp.x, y: 0, z: pp.z }, windup: 1.2, radius: 2.5, damage: 25, blockable: false, projectileSpeed: 0 });
      else if (kind === 'orb') attacks.push({ id, kind, origin: { x: 0, y: 2.2, z: 0 }, target: { x: pp.x, y: 1.2, z: pp.z }, windup: 0.8, radius: 0.5, damage: 15, blockable: true, projectileSpeed: 10 });
      else attacks.push({ id, kind, origin: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, windup: 1.4, radius: 9.5, damage: 20, blockable: true, projectileSpeed: 0 });
      next = time + (stage === 2 ? 2.2 : 3);
    }
    return { stage, action: attacks.length || snap.telegraphs.length ? 'windup' : 'idle', attacks };
  };
  return b;
}
function bot(useUlt) {
  const dashed = new Set();
  return (snap) => {
    if (snap.status !== 'playing') return I();
    const p = snap.player, pp = p.position, a = p.orbitAngle;
    const right = { x: Math.cos(a), z: -Math.sin(a) };
    let shield = false, moveX = 0, dash = 0;
    for (const t of snap.telegraphs) {
      if (t.kind === 'slam') {
        const dx = pp.x - t.center.x, dz = pp.z - t.center.z, d = Math.hypot(dx, dz);
        if (d <= t.radius + 0.6) {
          const dir = dx * right.x + dz * right.z >= 0 ? 1 : -1;
          moveX = dir;
          if (!dashed.has(t.id) && t.remaining < (t.radius + 0.3 - d) / 4 + 0.2 && p.energy >= 20 && snap.cooldowns.dashRemaining === 0) { dash = dir; dashed.add(t.id); }
        }
      } else if (t.blockable && t.remaining < 0.3) shield = true;
    }
    for (const pr of snap.projectiles) if (pr.owner === 'boss' && Math.hypot(pr.position.x - pp.x, pr.position.z - pp.z) < 4) shield = true;
    const burst = snap.cooldowns.burstRemaining === 0 && p.energy >= 70;
    return I({ moveX, dash, attack: !shield, shield, burst, ultimate: useUlt && p.furyReady });
  };
}
test('баланс: разумный бот побеждает и без ультимейта, и с ним; с ним — быстрее; ультимейтов 1–3', () => {
  const res = {};
  for (const useUlt of [false, true]) {
    for (const lvl of ['easy', 'normal']) {
      const c = createCombat({ config: {}, bossBrain: loopBrain() });
      c.setDifficulty(lvl); c.reset();
      const B = bot(useUlt);
      let tEnd = -1, ults = 0;
      runFor(c, 600, () => B(c.getSnapshot()),   // [W5-СЛОЖНОСТЬ] бой на минуты: у Регента в разы больше здоровья
        (cc, e, t) => { ults += count(e, 'ultimate_start'); if (tEnd < 0 && cc.getSnapshot().status !== 'playing') tEnd = t; });
      res[`${useUlt ? 'ult' : 'plain'}_${lvl}`] = { status: c.getSnapshot().status, t: +tEnd.toFixed(1), ults, hp: Math.round(c.getSnapshot().player.hp) };
    }
  }
  for (const [k, v] of Object.entries(res)) assert(v.status === 'victory', `${k}: ${JSON.stringify(v)}`);
  for (const lvl of ['easy', 'normal']) {
    assert(res[`ult_${lvl}`].t < res[`plain_${lvl}`].t, `${lvl}: с ультимейтом быстрее ${JSON.stringify(res)}`);
    assert(res[`ult_${lvl}`].ults >= 1 && res[`ult_${lvl}`].ults <= 3, `${lvl}: ультимейтов ${res[`ult_${lvl}`].ults}`);
  }
  facts.balance = res;
});

// ------------------------------------------------------------ 3. камера
test('камера: облёт без прыжка на старте, уходит от обычной камеры, возвращается к ней после сцены', () => {
  const st = { player: { x: 0, y: 0, z: 6.5 }, boss: { x: 0, y: 0, z: 0 }, engaged: true, colliders: null };
  const A = createCameraRig(gameConfig.camera), Bn = createCameraRig(gameConfig.camera);   // B — обычная камера для сравнения
  let a = null, b = null;
  for (let i = 0; i < 90; i++) { a = A.update(1 / 60, st); b = Bn.update(1 / 60, st); }
  const dur = 3.6, strikeAt = 2.3;
  const keys = ultCameraKeys({ p: st.player, b: st.boss, dur, strikeAt, maxR: gameConfig.camera.maxRadiusFromCenter });
  assert(keys.length >= 4 && keys.every((k) => Math.hypot(k.pos.x, k.pos.z) <= gameConfig.camera.maxRadiusFromCenter + 1e-6 && k.pos.y > 0.5), 'ключи в арене и над землёй');
  assert(A.cinematic(keys, { duration: dur, blendOut: 0.6 }) && A.cinematicActive, 'кинорежим');
  let maxJump = 0, maxAway = 0, prev = a.position, t = 0;
  while (t < dur + 0.2) {
    t += 1 / 60;
    a = A.update(1 / 60, { ...st, cineT: t }); b = Bn.update(1 / 60, st);
    maxJump = Math.max(maxJump, Math.hypot(a.position.x - prev.x, a.position.y - prev.y, a.position.z - prev.z));
    maxAway = Math.max(maxAway, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z));
    prev = a.position;
  }
  assert(maxJump < 0.6, `скачок за кадр ${maxJump.toFixed(3)} м`);
  assert(maxAway > 3, `облёт уходит от обычной камеры (${maxAway.toFixed(2)} м)`);
  assert(!A.cinematicActive, 'кинорежим закончился');
  near(a.position.x, b.position.x, 1e-6, 'x'); near(a.position.y, b.position.y, 1e-6, 'y'); near(a.position.z, b.position.z, 1e-6, 'z');
  near(a.target.x, b.target.x, 1e-6, 'взгляд x'); near(a.target.y, b.target.y, 1e-6, 'взгляд y');
  near(A.inputYaw, Bn.inputYaw, 1e-9, 'курс ввода не трогали');
});
test('камера: reset() снимает облёт; время сцены — замедление 1 → ~0,3 → 1', () => {
  const R = createCameraRig(gameConfig.camera);
  R.update(1 / 60, { player: { x: 0, y: 0, z: 6 }, boss: { x: 0, y: 0, z: 0 } });
  R.cinematic([{ t: 1, pos: { x: 1, y: 3, z: 4 }, look: { x: 0, y: 2, z: 0 } }], { duration: 2 });
  R.reset({ player: { x: 0, y: 0, z: 6 }, boss: { x: 0, y: 0, z: 0 } });
  assert(!R.cinematicActive, 'снят');
  assert(ultTimeScale(-1) === 1 && ultTimeScale(3.6, 3.6, 2.3) === 1, 'вне сцены 1');
  near(ultTimeScale(1.2, 3.6, 2.3), 0.3, 1e-6, 'облёт');
  assert(ultTimeScale(2.3, 3.6, 2.3) < 0.2, 'у удара глубже');
  let prev = 1;
  for (let t = 0; t < 3.6; t += 0.01) { const v = ultTimeScale(t, 3.6, 2.3); assert(Math.abs(v - prev) < 0.12, `рывок темпа на ${t.toFixed(2)}`); prev = v; }
  assert(ultTimeScale(1.2, 3.6, 2.3, true) >= 0.5, '«Уменьшенное движение» — мягче');
});

// ------------------------------------------------------------ 4. отладка
test('отладка: U — импульс ultimate и «Искра» в одном кадре, один раз', () => {
  const L = {};
  const target = { addEventListener: (t, f) => { (L[t] || (L[t] = [])).push(f); }, removeEventListener() {} };
  const dbg = createDebugInput(target);
  dbg.setEnabled(true);
  for (const f of L.keydown) f({ code: 'KeyU', key: 'u', repeat: false, target: null, preventDefault() {} });
  const fr = dbg.read();
  assert(fr.ultimate === true && fr.spark === true, 'импульсы');
  const fr2 = dbg.read();
  assert(!fr2.ultimate && !fr2.spark, 'один раз');
});

// ------------------------------------------------------------ отчёт
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
if (Object.keys(facts).length) console.log('facts', JSON.stringify(facts));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
