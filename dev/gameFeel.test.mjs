// Тесты «отклика» (core/gameFeel.js) и тряски камеры (core/cameraRig.js → shake). node dev/gameFeel.test.mjs
import { feelOf, feelOfEvents, FEEL_TIME } from '../core/gameFeel.js';
import { createCameraRig } from '../core/cameraRig.js';
import { config } from '../config.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
const ev = (type, data = {}) => ({ id: `${type}-${Math.random()}`, type, position: { x: 0, y: 0, z: 0 }, data });

test('сильный удар по Регенту: остановка кадра 60–90 мс; слабый — без остановки, но с лёгкой тряской', () => {
  const weak = feelOf(ev('boss_hit', { amount: 7, source: 'bolt' }));
  assert(weak.stopMs === 0 && weak.shake > 0 && weak.shake < 0.1, JSON.stringify(weak));
  const s30 = feelOf(ev('boss_hit', { amount: 30, source: 'slash' }));
  const s200 = feelOf(ev('boss_hit', { amount: 200, source: 'burst' }));
  assert(s30.stopMs >= 60 && s30.stopMs <= 90, `30 урона: ${s30.stopMs}`);
  assert(s200.stopMs === 90, `200 урона: ${s200.stopMs}`);
  assert(s200.shake > s30.shake && s30.shake > weak.shake, 'тряска растёт с уроном');
  const crit = feelOf(ev('boss_hit', { amount: 20, source: 'slash', recoverBonus: true }));
  assert(crit.stopMs >= 60 && crit.stopMs <= 90, `крит: ${crit.stopMs}`);
  assert(feelOf(ev('boss_hit', { amount: 40, source: 'burn', dot: true })).stopMs === 0, 'горение без отклика');
});

test('парирование: замедление 0,3 с; промах — ничего; идеальный рывок — как раньше (0,65 с ×0,3)', () => {
  const p = feelOf(ev('parry', { success: true }));
  assert(p.slowMs === 300 && p.slowScale < 0.5 && p.slowScale > 0, JSON.stringify(p));
  const miss = feelOf(ev('parry', { success: false }));
  assert(miss.slowMs === 0 && miss.stopMs === 0 && miss.shake === 0, 'промах');
  const d = feelOf(ev('perfect_dodge', {}));
  assert(d.slowMs === 650 && d.slowScale === 0.3, JSON.stringify(d));
});

test('прежние стоп-кадры сохранены: руна/выброс/печать/фаза — 80 мс, попадание по герою ≥20 — 60 мс', () => {
  for (const t of ['rune_cast', 'burst', 'sigil_cast', 'boss_phase']) assert(feelOf(ev(t, { power: 0.5 })).stopMs === 80, t);
  assert(feelOf(ev('player_hit', { amount: 22 })).stopMs === 60, 'player_hit 22');
  assert(feelOf(ev('player_hit', { amount: 12 })).stopMs === 0, 'player_hit 12');
  assert(feelOf(ev('player_hit', { amount: 13 })).stopMs === 50, 'player_hit 13 («Лёгкая»: удар ладонью)');
  assert(feelOf(ev('player_hit', { amount: 12 })).shake >= 0.3, 'попадание по герою трясёт');
});

test('«Уменьшенное движение»: тряски нет, остановка кадра ≤ 40 мс, замедление остаётся', () => {
  const rm = { reducedMotion: true };
  const s = feelOf(ev('boss_hit', { amount: 200, source: 'burst' }), rm);
  assert(s.shake === 0 && s.stopMs > 0 && s.stopMs <= FEEL_TIME.reducedStopMaxMs, JSON.stringify(s));
  const p = feelOf(ev('parry', { success: true }), rm);
  assert(p.shake === 0 && p.slowMs === 300, JSON.stringify(p));
  const all = feelOfEvents([ev('player_hit', { amount: 30 }), ev('burst', { power: 1 }), ev('boss_hit', { amount: 120 })], rm);
  assert(all.shake === 0 && all.stopMs <= 40, JSON.stringify(all));
});

test('кадр с несколькими событиями: самая длинная остановка, тряска складывается, но ≤ 1; мусор не ломает', () => {
  const f = feelOfEvents([ev('boss_hit', { amount: 7 }), ev('boss_hit', { amount: 60 }), ev('player_hit', { amount: 25 }), ev('parry', { success: true })]);
  assert(f.stopMs === feelOf(ev('boss_hit', { amount: 60 })).stopMs, `stop ${f.stopMs}`);
  assert(f.slowMs === 300 && f.shake <= 1 && f.shake > 0.5, JSON.stringify(f));
  const z = feelOfEvents([null, {}, { type: 'boss_hit' }, ev('nope')]);
  assert(z.stopMs === 0 && z.slowMs === 0 && Number.isFinite(z.shake), JSON.stringify(z));
  assert(feelOfEvents(null).shake === 0, 'null');
});

test('камера: shake поворачивает только точку взгляда, гаснет; позиция, yaw и inputYaw не меняются', () => {
  const mk = () => { const r = createCameraRig(config.camera); r.reset({ x: 0, y: 0, z: 6 }, { x: 0, y: 0, z: 0 }); return r; };
  const st = { player: { x: 0, y: 0, z: 6 }, boss: { x: 0, y: 0, z: 0 }, engaged: true, impulse: { x: 0, y: 0, z: 0 } };
  const a = mk(), b = mk();
  for (let i = 0; i < 30; i++) { a.update(1 / 60, st); b.update(1 / 60, st); }
  b.shake(0.8);
  let maxDev = 0, maxPos = 0, maxYaw = 0;
  for (let i = 0; i < 12; i++) {
    const ca = a.update(1 / 60, st), cb = b.update(1 / 60, st);
    maxDev = Math.max(maxDev, Math.hypot(ca.target.x - cb.target.x, ca.target.y - cb.target.y, ca.target.z - cb.target.z));
    maxPos = Math.max(maxPos, Math.hypot(ca.position.x - cb.position.x, ca.position.y - cb.position.y, ca.position.z - cb.position.z));
    maxYaw = Math.max(maxYaw, Math.abs(ca.yaw - cb.yaw), Math.abs(a.inputYaw - b.inputYaw));
  }
  assert(maxDev > 0.02, `точка взгляда дрожит: ${maxDev}`);
  assert(maxPos < 1e-9 && maxYaw < 1e-9, `позиция/курс не трогаются: ${maxPos} ${maxYaw}`);
  for (let i = 0; i < 120; i++) b.update(1 / 60, st);
  assert(b.trauma === 0, `тряска погасла: ${b.trauma}`);
  // угол тряски не больше maxDeg
  const c = mk(); c.shake(1);
  const c0 = mk();
  let maxAng = 0;
  for (let i = 0; i < 40; i++) {
    const r1 = c.update(1 / 60, st), r0 = c0.update(1 / 60, st);
    const v0 = { x: r0.target.x - r0.position.x, y: r0.target.y - r0.position.y, z: r0.target.z - r0.position.z };
    const v1 = { x: r1.target.x - r1.position.x, y: r1.target.y - r1.position.y, z: r1.target.z - r1.position.z };
    const cos = (v0.x * v1.x + v0.y * v1.y + v0.z * v1.z) / (Math.hypot(v0.x, v0.y, v0.z) * Math.hypot(v1.x, v1.y, v1.z));
    maxAng = Math.max(maxAng, Math.acos(Math.min(1, cos)) * 180 / Math.PI);
  }
  assert(maxAng > 0.3 && maxAng <= 2.6, `угол тряски ${maxAng.toFixed(2)}°`);
});

test('камера: «Уменьшенное движение» — shake не действует', () => {
  const r = createCameraRig(config.camera), r0 = createCameraRig(config.camera);
  const st = { player: { x: 0, y: 0, z: 6 }, boss: { x: 0, y: 0, z: 0 }, engaged: true, reducedMotion: true };
  r.reset(st); r0.reset(st);
  r.shake(1);
  for (let i = 0; i < 10; i++) {
    const a = r.update(1 / 60, st), b = r0.update(1 / 60, st);
    assert(Math.hypot(a.target.x - b.target.x, a.target.y - b.target.y, a.target.z - b.target.z) < 1e-9, 'без тряски');
  }
  assert(r.trauma === 0, 'травма сброшена');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed && typeof process !== 'undefined') process.exitCode = 1;
