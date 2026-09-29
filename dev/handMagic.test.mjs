// [HAND] Тесты core/handMagic.js — «Магия рукой» (сгусток в правой ладони). node dev/handMagic.test.mjs [--verbose]
// Синтетика (dev/handSynth.mjs) и настоящие кисти HaGRID (ладони, повёрнутые вверх/вниз — те же landmarks).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandMagic, elementOf, MAGIC_HINTS, SPELL_ELEMENTS } from '../core/handMagic.js';
import { buildHandFrame, handFeatures } from '../core/bowGesture.js';
import { makeScene, handAt, obsOf, rnd, reseed, lerp, SHAPES } from './handSynth.mjs';

const verbose = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

// ориентации правой кисти (makeHand): ладонь вверх — ладонью от камеры и наклон к камере; вниз — ладонью к камере
const ORIENT = {
  up: { palm: 'away', pitch: -1.45 },
  down: { palm: 'camera', pitch: -1.45 },
  camera: { palm: 'camera', pitch: 0 },
};
const FORMS = {
  fire: { shape: SHAPES.open, orient: ORIENT.up },
  storm: { shape: SHAPES.claw, orient: ORIENT.camera },
  frost: { shape: SHAPES.open, orient: ORIENT.down },
  earth: { shape: SHAPES.fist, orient: ORIENT.up },
};
const R = (S, x, y, shape, extra = {}) => handAt(S, 'right', x, y, shape, { size: 0.085, ...extra });

// Прогон: fn(t, k) → {left?, right?} или массив; шаг dt
function run(frames, magic = createHandMagic()) {
  const res = { forms: [], throws: [], cancels: [], hints: [], phases: [], last: null, powerAt: {} };
  for (const { S, t, hands, busy } of frames) {
    const fr = buildHandFrame(obsOf(S, t, hands), S.pose());
    if (busy) fr.busy = true;
    magic.push(fr);
    const r = magic.read(t);
    res.phases.push(r.phase);
    if (r.formed) res.forms.push({ t, element: r.element });
    if (r.phase === 'throw') res.throws.push({ t, ...r });
    if (r.cancel) res.cancels.push({ t, reason: r.cancelReason });
    if (r.hint) res.hints.push(r.hint.code);
    res.last = r;
    res.magic = magic;
  }
  return res;
}
function* seq(S, ms, fn, dt = 33, t0 = 1000) { for (let t = t0; t < t0 + ms; t += dt) yield { S, t, hands: fn(t, (t - t0) / ms) }; }
function* chain(...gens) { for (const g of gens) yield* g; }

// ───────── 1. рождение каждой стихии ─────────
test('каждая стихия рождается своей формой кисти: огонь/молния/лёд/земля', () => {
  const S = makeScene();
  for (const [el, f] of Object.entries(FORMS)) {
    const r = run(seq(S, 900, () => ({ right: R(S, 0.45, 0.15, f.shape, f.orient) })));
    ok(r.forms.length === 1, `${el}: рождений ${r.forms.length}`);
    ok(r.forms[0].element === el, `${el}: родилось ${r.forms[0].element}`);
    ok(r.forms[0].t - 1000 >= 250 && r.forms[0].t - 1000 <= 500, `${el}: время рождения ${r.forms[0].t - 1000}`);
    ok(r.last.phase === 'hold', `${el}: фаза ${r.last.phase}`);
    ok(r.throws.length === 0 && r.cancels.length === 0, `${el}: лишние импульсы`);
  }
});
test('power растёт до 1 за ~1,5 с; «лепка» ускоряет рост', () => {
  const S = makeScene();
  const plain = run(seq(S, 1300, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })));
  const p1 = plain.last.power;
  ok(p1 > 0.45 && p1 < 0.85, `без лепки за ~1 с после рождения power ${p1.toFixed(2)}`);
  const full = run(seq(S, 2200, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })));
  ok(full.last.power >= 0.99, `за 1,9 с power ${full.last.power.toFixed(2)}`);
  // лепка: сжимаем/раскрываем пальцы (полусогнуто ↔ раскрыто) 3 раза в секунду
  const sc = run(seq(S, 1300, (t) => {
    const k = (Math.sin((t - 1000) / 1000 * Math.PI * 2 * 3) + 1) / 2;
    const c = t < 1400 ? 0 : 0.4 * k;
    return { right: R(S, 0.45, 0.15, { curls: [c, c, c, c], thumb: 'out' }, ORIENT.up) };
  }));
  ok(sc.forms.length === 1, `лепка: рождений ${sc.forms.length}`);
  ok(sc.last.power > p1 + 0.12, `лепка не ускорила: ${sc.last.power.toFixed(2)} против ${p1.toFixed(2)}`);
  ok(sc.last.size > 0.3 && sc.last.size <= 1, 'size');
});

// ───────── 2. бросок ─────────
function formThenMove(S, el, move, opts = {}) {
  const f = FORMS[el];
  const x0 = 0.45, y0 = 0.15;
  const hold = opts.holdMs || 900;
  return run(chain(
    seq(S, hold, () => ({ right: R(S, x0, y0, f.shape, f.orient) })),
    seq(S, move.ms, (t, k) => ({ right: R(S, lerp(x0, x0 + move.dx, k), lerp(y0, y0 + move.dy, k), f.shape, { ...f.orient, size: lerp(0.085, 0.085 * (move.grow || 1), k) }) }), 33, 1000 + hold),
    seq(S, 300, () => ({ right: R(S, x0 + move.dx, y0 + move.dy, f.shape, { ...f.orient, size: 0.085 * (move.grow || 1) }) }), 33, 1000 + hold + move.ms),
  ));
}
test('резкий мах в сторону → бросок с направлением движения', () => {
  const S = makeScene();
  const r = formThenMove(S, 'fire', { dx: 1.0, dy: 0, ms: 160 });
  ok(r.throws.length === 1, `бросков ${r.throws.length}`);
  ok(r.throws[0].dir.x > 0.8 && Math.abs(r.throws[0].dir.y) < 0.4, `dir ${JSON.stringify(r.throws[0].dir)}`);
  ok(r.throws[0].element === 'fire' && r.throws[0].power > 0.3, 'стихия/сила');
  const l = formThenMove(S, 'storm', { dx: -1.0, dy: -0.4, ms: 160 });
  ok(l.throws.length === 1 && l.throws[0].dir.x < -0.7 && l.throws[0].dir.y > 0.2, `влево-вверх: ${JSON.stringify(l.throws[0] && l.throws[0].dir)}`);
});
test('толчок к камере (кисть быстро выросла) → бросок push, направление почти прямо', () => {
  const S = makeScene();
  const r = formThenMove(S, 'frost', { dx: 0.05, dy: 0, ms: 200, grow: 1.45 });
  ok(r.throws.length === 1, `бросков ${r.throws.length}`);
  ok(r.throws[0].how === 'push', `how ${r.throws[0].how}`);
  ok(Math.hypot(r.throws[0].dir.x, r.throws[0].dir.y) <= 0.5, `dir ${JSON.stringify(r.throws[0].dir)}`);
});
test('медленное движение — не бросок, а подсказка «бросай резче»', () => {
  const S = makeScene();
  const r = formThenMove(S, 'fire', { dx: 0.7, dy: 0, ms: 480 });
  ok(r.throws.length === 0, `бросков ${r.throws.length}`);
  ok(r.hints.includes('spell_throw_weak'), `подсказки ${r.hints}`);
});
test('резко вниз — не бросок (рука опускается → отмена)', () => {
  const S = makeScene();
  const r = formThenMove(S, 'fire', { dx: 0, dy: 1.6, ms: 150 });
  ok(r.throws.length === 0, `бросков ${r.throws.length}`);
  ok(r.cancels.length === 1 && r.cancels[0].reason === 'lowered', `отмены ${JSON.stringify(r.cancels)}`);
});

// ───────── 3. отмена ─────────
test('отмена: медленно сжать кулак (огонь); у земли кулак — форма, не отмена', () => {
  const S = makeScene();
  const fire = run(chain(
    seq(S, 800, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })),
    seq(S, 400, (t, k) => ({ right: R(S, 0.45, 0.15, { curls: [k, k, k, k], thumb: k > 0.6 ? 'in' : 'out' }, ORIENT.up) }), 33, 1800),
    seq(S, 1000, () => ({ right: R(S, 0.45, 0.15, SHAPES.fist, ORIENT.up) }), 33, 2200),
  ));
  ok(fire.cancels.length === 1 && fire.cancels[0].reason === 'fist', `огонь: ${JSON.stringify(fire.cancels)}`);
  const earth = run(seq(S, 2500, () => ({ right: R(S, 0.45, 0.15, SHAPES.fist, ORIENT.up) })));
  ok(earth.forms.length === 1 && earth.cancels.length === 0 && earth.last.phase === 'hold', `земля: ${earth.cancels.length} отмен`);
});
test('отмена: кисть потеряна дольше 0,45 с; короткая потеря — нет', () => {
  const S = makeScene();
  const short = run(chain(
    seq(S, 800, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })),
    seq(S, 250, () => ({}), 33, 1800),
    seq(S, 300, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) }), 33, 2050),
  ));
  ok(short.cancels.length === 0 && short.last.phase === 'hold', 'короткая потеря погасила сгусток');
  const long = run(chain(
    seq(S, 800, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })),
    seq(S, 700, () => ({}), 33, 1800),
  ));
  ok(long.cancels.length === 1 && long.cancels[0].reason === 'lost', `потеря: ${JSON.stringify(long.cancels)}`);
});

// ───────── 4. двумя руками ─────────
test('двумя руками: сфера рядом со сгустком → twoHand; бросок сферы → усиленный бросок стихии', () => {
  const S = makeScene();
  const m = createHandMagic();
  const r = run(seq(S, 900, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })), m);
  ok(r.last.phase === 'hold');
  ok(m.setTwoHand(true, 1900) === true, 'twoHand не включился');
  // пока сфера: ладонь развёрнута к другой руке — сгусток не гаснет и сам не бросается
  const r2 = run(seq(S, 500, (t, k) => ({ right: R(S, lerp(0.45, 0.8, k), 0.15, SHAPES.open, { yaw: 1.4 }) }), 33, 1900), m);
  ok(r2.cancels.length === 0 && r2.throws.length === 0, `twoHand: отмены ${r2.cancels.length}, броски ${r2.throws.length}`);
  const p = m.throwTwoHand(2450, { power: 0.9, aimX: 0.3, how: 'push' });
  ok(p && p.twoHand && p.element === 'fire' && p.power >= 0.9, `бросок: ${JSON.stringify(p)}`);
  const v = m.read(2460);
  ok(v.phase === 'throw' && v.twoHand, 'импульс броска');
  ok(m.read(2470).phase === 'idle', 'импульс не сгорел');
});

// ───────── 5. точность на случайных сериях (шум, ракурсы, темп) ─────────
test('≥ 95%: 240 случайных «родить — бросить» (все стихии, шум, ракурсы)', () => {
  reseed(2024);
  const els = Object.keys(FORMS);
  let good = 0;
  const bad = [];
  const N = 240;
  for (let i = 0; i < N; i++) {
    const el = els[i % 4];
    const S = makeScene({ cx: lerp(0.42, 0.58, rnd()), cy: lerp(0.35, 0.48, rnd()), sw: lerp(0.24, 0.36, rnd()) });
    const f = FORMS[el];
    const tilt = { roll: lerp(-0.35, 0.35, rnd()), yaw: lerp(-0.35, 0.35, rnd()), pitch: f.orient.pitch + lerp(-0.25, 0.25, rnd()) };
    const x0 = lerp(0.1, 0.9, rnd()), y0 = lerp(-0.6, 0.6, rnd());
    const size = lerp(0.07, 0.11, rnd());
    const noise = lerp(0.004, 0.015, rnd());
    const th0 = lerp(-2.4, 2.4, rnd());   // от «вверх» ±140° — все направления, кроме конуса «вниз» (это опускание руки)
    const push = rnd() < 0.3;
    const dx = push ? 0 : Math.sin(th0) * 1.0, dy = push ? 0 : -Math.cos(th0) * 1.0;
    const hold = lerp(600, 1400, rnd()), mvMs = lerp(110, 170, rnd());
    const dt = lerp(28, 40, rnd());
    const shapeX = el === 'storm' ? { ...f.shape, curls: f.shape.curls.map((c) => c + lerp(-0.08, 0.08, rnd())) } : f.shape;
    const r = run(chain(
      seq(S, hold, () => ({ right: R(S, x0, y0, shapeX, { ...f.orient, ...tilt, size, noise }) }), dt),
      seq(S, mvMs, (t, k) => ({ right: R(S, x0 + dx * k, y0 + dy * k, shapeX, { ...f.orient, ...tilt, size: size * (push ? lerp(1, 1.5, k) : 1), noise }) }), dt, 1000 + hold),
      seq(S, 250, () => ({ right: R(S, x0 + dx, y0 + dy, shapeX, { ...f.orient, ...tilt, size: size * (push ? 1.5 : 1), noise }) }), dt, 1000 + hold + mvMs),
    ));
    const th = r.throws[0];
    let g = r.forms.length === 1 && r.forms[0].element === el && r.throws.length === 1 && th.element === el;
    if (g && !push) g = th.dir.x * dx + th.dir.y * (-dy) > 0.6;   // dir: y вверх
    if (g) good++; else bad.push({ i, el, push, forms: r.forms.map((x) => x.element), throws: r.throws.length, dir: th && th.dir, want: { x: +dx.toFixed(2), y: +(-dy).toFixed(2) }, dbg: r.magic.getDebug().counters });
  }
  const acc = good / N;
  if (verbose || acc < 0.95) for (const b of bad.slice(0, 12)) console.log('  MISS', JSON.stringify(b));
  console.log(`  случайные сгустки: ${(acc * 100).toFixed(1)}% верно (${good}/${N})`);
  ok(acc >= 0.95, `${(acc * 100).toFixed(1)}%`);
});

// ───────── 6. ни одного ложного сгустка при обычной игре ─────────
test('обычная игра правой (ладонь к камере, OK, указание, кулак-выброс, руна, взмах, отдых): сгусток не рождается', () => {
  reseed(31337);
  const S = makeScene();
  const cases = {
    palmCamera: seq(S, 3000, () => ({ right: R(S, 0.5, 0.1, SHAPES.open, ORIENT.camera) })),
    ok: seq(S, 3000, () => ({ right: R(S, 0.5, 0.1, SHAPES.ok, ORIENT.camera) })),
    point: seq(S, 3000, () => ({ right: R(S, 0.5, 0.1, SHAPES.point, ORIENT.camera) })),
    burst: seq(S, 3000, (t, k) => ({ right: R(S, 0.5, 0.1, (k * 4) % 1 < 0.6 ? SHAPES.fist : SHAPES.open, ORIENT.camera) })),
    rune: seq(S, 3000, (t, k) => ({ right: R(S, 0.4 + 0.4 * Math.cos(k * 12), 0.4 * Math.sin(k * 12), SHAPES.point, ORIENT.camera) })),
    slash: seq(S, 3000, (t, k) => ({ right: R(S, 0.2 + 1.2 * ((k * 3) % 1), 0.1, SHAPES.open, { yaw: 1.4 }) })),
    restLowUp: seq(S, 3000, () => ({ right: R(S, 0.5, 1.6, SHAPES.open, ORIENT.up) })),
    restLowDown: seq(S, 3000, () => ({ right: R(S, 0.5, 1.7, SHAPES.open, ORIENT.down) })),
    pinchBow: seq(S, 3000, (t, k) => ({ right: R(S, lerp(-0.2, 0.4, k), lerp(0.3, -0.4, k), SHAPES.pinch, ORIENT.camera) })),
    steerLeftOnly: seq(S, 3000, (t, k) => ({ left: handAt(S, 'left', -0.6 + 0.3 * Math.sin(k * 9), 0.3, 'open', { size: 0.09 }) })),
    // тряска раскрытой ладонью к камере в произвольных ракурсах ±35°
    wobble: seq(S, 3000, (t) => ({ right: R(S, 0.5, 0.1, SHAPES.open, { palm: 'camera', pitch: 0.6 * Math.sin(t / 170), yaw: 0.6 * Math.sin(t / 230), roll: 0.5 * Math.sin(t / 310) }) })),
  };
  const bad = [];
  for (const [name, frames] of Object.entries(cases)) { const r = run(frames); if (r.forms.length) bad.push(`${name}(${r.forms.map((f) => f.element)})`); }
  ok(bad.length === 0, bad.join(', '));
});
test('занятые руки (лук/сфера: frame.busy) — сгусток не рождается', () => {
  const S = makeScene();
  const frames = [...seq(S, 1500, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) }))].map((f) => ({ ...f, busy: true }));
  const r = run(frames);
  ok(r.forms.length === 0, `рождений ${r.forms.length}`);
});

// ───────── 7. подсказки ─────────
test('ОШИБКА: ладонь к камере в зоне → «разверни ладонь вверх»; долгое удержание → «брось»', () => {
  const S = makeScene();
  const r = run(seq(S, 2200, () => ({ right: R(S, 0.45, 0.1, SHAPES.open, ORIENT.camera) })));
  ok(r.hints.includes('spell_palm'), r.hints.join(','));
  const h = run(seq(S, 7500, () => ({ right: R(S, 0.45, 0.15, SHAPES.open, ORIENT.up) })));
  ok(h.hints.includes('spell_hold'), h.hints.join(','));
  for (const c of Object.keys(MAGIC_HINTS)) ok(MAGIC_HINTS[c], c);
  ok(Object.keys(SPELL_ELEMENTS).join(',') === 'fire,storm,frost,earth');
});

// ───────── 8. настоящие кисти (HaGRID) ─────────
const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'fixtures/hands/hagrid_images.json'), 'utf8'));
function mainHand(fx) {
  let best = null, size = -1;
  for (const h of fx.hands) { const s = Math.hypot((h.landmarks[0].x - h.landmarks[9].x) * fx.frameW / fx.frameH, h.landmarks[0].y - h.landmarks[9].y); if (s > size) { size = s; best = h; } }
  return best;
}
const byLabel = {};
for (const fx of data.fixtures) (byLabel[fx.hagrid] = byLabel[fx.hagrid] || []).push({ fx, h: mainHand(fx) });
const sideOf = (h) => (h.handedness === 'Left' ? 'left' : 'right');
// поворот настоящей кисти вокруг горизонтальной оси кадра (x): ладонь к камере → вверх/вниз.
// world и image (x·aspect, y, z·aspect) поворачиваются одинаково вокруг центра ладони.
function pitchHand(h, fx, ang) {
  const asp = fx.frameW / fx.frameH;
  const c = Math.cos(ang), s = Math.sin(ang);
  const rot = (p, cy, cz) => ({ y: cy + (p.y - cy) * c - (p.z - cz) * s, z: cz + (p.y - cy) * s + (p.z - cz) * c });
  const W = h.world.map((p) => { const r = rot(p, 0, 0); return { x: p.x, y: r.y, z: r.z }; });
  const I = h.landmarks.map((p) => ({ x: p.x * asp, y: p.y, z: p.z * asp }));
  const cy = I[9].y, cz = I[9].z;
  const J = I.map((p) => { const r = rot(p, cy, cz); return { x: p.x / asp, y: r.y, z: r.z / asp }; });
  return { landmarks: J, world: W, handedness: h.handedness, score: 0.95 };
}
test('HaGRID: ладони к камере, кулаки, «ok», указание — не стихия (≥ 95%)', () => {
  const all = [...byLabel.palm, ...byLabel.stop, ...byLabel.fist, ...byLabel.ok, ...byLabel.one, ...byLabel.peace];
  const bad = all.filter(({ fx, h }) => elementOf(handFeatures(h.landmarks, h.world, fx.frameW / fx.frameH, false, sideOf(h)))).length;
  console.log(`  HaGRID: ложная стихия ${bad} из ${all.length}`);
  ok(bad / all.length <= 0.05, `${bad}/${all.length}`);
});
test('HaGRID: те же ладони, повёрнутые вверх, — огонь; вниз — лёд; кулаки вверх — земля (≥ 90%)', () => {
  // знак поворота, при котором ладонь смотрит вверх, у левой и правой кисти одинаков (нормаль уже учитывает сторону)
  const rate = (arr, ang, want) => {
    let n = 0;
    for (const { fx, h } of arr) {
      const H = pitchHand(h, fx, ang);
      const f = handFeatures(H.landmarks, H.world, fx.frameW / fx.frameH, false, sideOf(h));
      if (elementOf(f) === want) n++;
    }
    return n / arr.length;
  };
  const palms = [...byLabel.palm, ...byLabel.stop];
  // ладонь к камере: нормаль ≈ (0,0,−1); поворот вокруг x на −90° переводит её в (0,−1,0) — вверх
  const up = Math.max(rate(palms, -Math.PI / 2, 'fire'), 0);
  const down = rate(palms, Math.PI / 2, 'frost');
  const earth = rate(byLabel.fist, -Math.PI / 2, 'earth');
  console.log(`  HaGRID повёрнутые: огонь ${(up * 100).toFixed(0)}%, лёд ${(down * 100).toFixed(0)}%, земля ${(earth * 100).toFixed(0)}%`);
  ok(up >= 0.9 && down >= 0.9 && earth >= 0.9);
});

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
