// [HAND] Тесты core/bowGesture.js — «Сумеречный Лук». node dev/bow.test.mjs [--verbose]
// Синтетика (параметрическая кисть dev/handSynth.mjs) и настоящие кисти HaGRID (dev/fixtures/hands).
// Цель: ≥ 95% верных натяжений и выстрелов; НИ ОДНОГО ложного лука при обычном рулении и старых жестах.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBowGesture, buildHandFrame, handFeatures, RUNE_ELEMENT, BOW_HINTS, DEFAULT_BOW_CONFIG } from '../core/bowGesture.js';
import { makeScene, handAt, obsOf, rnd, reseed, lerp, SHAPES } from './handSynth.mjs';

const verbose = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

// ───────── сценарий выстрела ─────────
// Все позиции — координаты показа в ширинах плеч от центра плеч (x к правой руке игрока, y вниз).
// size — высота ладони в долях кадра; при sw 0.3 кисть у тела ≈ 0.075, вытянутая к камере ≈ 0.1.
function shotScript(o = {}) {
  const P = {
    fist: { x: -0.42, y: 0.3 }, fistSize: 0.1, fistExtra: {},
    nock: { x: -0.27, y: 0.3 }, pinchSize: 0.1, pinch: SHAPES.pinch, pinchExtra: {},
    full: { x: 0.28, y: -0.45 }, fullSize: 0.075,    // щепоть у правого уха
    rest: { x: 0.7, y: 1.5 },
    f: 1, pullMs: 500, holdMs: 500, dt: 33, jitter: 0, noise: 0, release: SHAPES.pinchOpen,
    ...o,
  };
  return P;
}
function* shotFrames(S, P, t0 = 1000) {
  let t = t0;
  const step = () => { const d = P.dt + (P.jitter ? (rnd() - 0.5) * 2 * P.jitter : 0); t += d; return t; };
  const L = (x = P.fist.x, y = P.fist.y) => handAt(S, 'left', x, y, 'fist', { size: P.fistSize, noise: P.noise, ...P.fistExtra });
  const R = (x, y, shape, size, extra = {}) => handAt(S, 'right', x, y, shape, { size, noise: P.noise, ...extra });
  // 1) кулак поднят, правая внизу
  while (t < t0 + 300) yield { t: step(), hands: { left: L(), right: R(P.rest.x, P.rest.y, 'open', 0.075) } };
  // 2) правая идёт к кулаку (раскрыта), в конце — щепоть
  const t1 = t;
  while (t < t1 + 350) { const k = Math.min(1, (t - t1) / 300); yield { t: step(), hands: { left: L(), right: R(lerp(P.rest.x, P.nock.x, k), lerp(P.rest.y, P.nock.y, k), k < 0.8 ? 'open' : P.pinch, lerp(0.075, P.pinchSize, k), P.pinchExtra) } }; }
  // 3) держим у кулака (стрела наложена)
  const t2 = t;
  while (t < t2 + 200) yield { t: step(), hands: { left: L(), right: R(P.nock.x, P.nock.y, P.pinch, P.pinchSize, P.pinchExtra) } };
  // 4) натяжение до доли f пути к уху
  const t3 = t;
  const tx = lerp(P.nock.x, P.full.x, P.f), ty = lerp(P.nock.y, P.full.y, P.f), ts = lerp(P.pinchSize, P.fullSize, P.f);
  while (t < t3 + P.pullMs) { const k = Math.min(1, (t - t3) / P.pullMs); yield { t: step(), hands: { left: L(), right: R(lerp(P.nock.x, tx, k), lerp(P.nock.y, ty, k), P.pinch, lerp(P.pinchSize, ts, k), P.pinchExtra) } }; }
  // 5) удержание
  const t4 = t;
  while (t < t4 + P.holdMs) yield { t: step(), hands: { left: L(), right: R(tx, ty, P.pinch, ts, P.pinchExtra) }, phase: 'hold' };
  // 6) выпуск: щепоть разжата, рука чуть уходит назад
  const t5 = t;
  while (t < t5 + 300) yield { t: step(), hands: { left: L(), right: R(tx + 0.05, ty - 0.03, P.release, ts) }, phase: 'release' };
}
function runShot(o = {}, sceneOpts = {}, bowCfg = {}) {
  const S = makeScene(sceneOpts);
  const P = shotScript(o);
  const bow = createBowGesture(bowCfg);
  const res = { releases: [], activeMax: false, drawMax: 0, chargedSeen: false, nockAt: null, releaseAt: null, hints: [], activeAtHold: false, activeFrames: 0, frames: 0 };
  for (const f of shotFrames(S, P)) {
    const frame = buildHandFrame(obsOf(S, f.t, f.hands), S.pose());
    bow.push(frame);
    const r = bow.read(f.t);
    res.frames++;
    if (r.active) { res.activeFrames++; res.activeMax = true; if (res.nockAt === null) res.nockAt = f.t; }
    if (f.phase === 'hold' && r.active) res.activeAtHold = true;
    res.drawMax = Math.max(res.drawMax, r.draw);
    if (r.charged) res.chargedSeen = true;
    if (r.release) { res.releases.push(r); res.releaseAt = f.t; }
    if (r.hint) res.hints.push(r.hint.code);
  }
  res.debug = bow.getDebug();
  return res;
}

// ───────── 1. базовые сценарии ─────────
test('полное натяжение: наложение, заряд, один выстрел с draw ≥ 0.9 и charged', () => {
  const r = runShot({ f: 1 });
  ok(r.activeMax, 'лук не включился');
  ok(r.releases.length === 1, `выстрелов ${r.releases.length}`);
  const x = r.releases[0];
  ok(x.draw >= 0.9, `draw ${x.draw.toFixed(2)}`);
  ok(x.charged, 'нет заряда');
  ok(!x.rain, 'случайный дождь стрел');
  ok(r.hints.length === 0, `подсказки на чистом выстреле: ${r.hints}`);
});
test('половина натяжения: draw 0.3–0.85, без заряда; треть — меньше половины', () => {
  const r = runShot({ f: 0.5 });
  ok(r.releases.length === 1, `выстрелов ${r.releases.length}`);
  const x = r.releases[0];
  ok(x.draw >= 0.3 && x.draw <= 0.85, `draw ${x.draw.toFixed(2)}`);
  const w = runShot({ f: 0.3 });
  ok(w.releases.length === 1 && w.releases[0].draw < x.draw - 0.1, `треть ${w.releases[0] && w.releases[0].draw}`);
  ok(!x.charged, 'заряд на половине');
});
test('полное натяжение без удержания (≤ 0,35 с) — без заряда', () => {
  const r = runShot({ f: 1, pullMs: 300, holdMs: 100 });
  ok(r.releases.length === 1);
  ok(r.releases[0].draw >= 0.85, `draw ${r.releases[0].draw}`);
  ok(!r.releases[0].charged, 'заряд без удержания');
});
test('наложил и отпустил без натяжения — «опустил тетиву», выстрела нет', () => {
  const r = runShot({ f: 0.02 });
  ok(r.activeMax, 'лук не включился');
  ok(r.releases.length === 0, `выстрелов ${r.releases.length}`);
  ok(r.debug.counters.letdowns === 1, 'letdown не засчитан');
});
test('прицел: кулак выше — aimY > 0.5; левее — aimX < −0.4; правее — aimX > 0.3', () => {
  const up = runShot({ f: 1, fist: { x: -0.42, y: -0.35 }, nock: { x: -0.27, y: -0.35 }, full: { x: 0.28, y: -0.9 } });
  ok(up.releases.length === 1 && up.releases[0].aimY > 0.5, `aimY ${up.releases[0] && up.releases[0].aimY}`);
  const left = runShot({ f: 1, fist: { x: -1.3, y: 0.3 }, nock: { x: -1.15, y: 0.3 }, full: { x: -0.5, y: -0.4 } });
  ok(left.releases.length === 1 && left.releases[0].aimX < -0.4, `aimX ${left.releases[0] && left.releases[0].aimX}`);
  const right = runShot({ f: 1, fist: { x: 0.1, y: 0.3 }, nock: { x: 0.25, y: 0.3 }, full: { x: 0.95, y: -0.3 } });
  ok(right.releases.length === 1 && right.releases[0].aimX > 0.3, `aimX ${right.releases[0] && right.releases[0].aimX}`);
});
test('«Дождь стрел»: прицел высоко вверх + полное натяжение', () => {
  const r = runShot({ f: 1, fist: { x: -0.35, y: -0.7 }, nock: { x: -0.2, y: -0.7 }, full: { x: 0.35, y: -1.0 } });
  ok(r.releases.length === 1, `выстрелов ${r.releases.length}`);
  ok(r.releases[0].rain, `нет дождя, aimY ${r.releases[0].aimY.toFixed(2)} draw ${r.releases[0].draw.toFixed(2)}`);
  const half = runShot({ f: 0.45, fist: { x: -0.35, y: -0.7 }, nock: { x: -0.2, y: -0.7 }, full: { x: 0.35, y: -1.0 } });
  ok(half.releases.length === 1 && !half.releases[0].rain, 'дождь без полного натяжения');
});
test('руна при поднятом луке → стихия следующей стрелы; без лука руна не забирается', () => {
  const S = makeScene();
  const bow = createBowGesture();
  ok(!bow.offerRune('ignis', 900), 'руна забрана без лука');
  let took = false;
  let rel = null;
  for (const f of shotFrames(S, shotScript({ f: 1 }))) {
    bow.push(buildHandFrame(obsOf(S, f.t, f.hands), S.pose()));
    if (!took && f.t > 1250) took = bow.offerRune('ignis', f.t);
    const r = bow.read(f.t);
    if (r.release) rel = r;
  }
  ok(took, 'руна не забрана при поднятом луке');
  ok(rel && rel.element === 'fire', `стихия ${rel && rel.element}`);
  ok(RUNE_ELEMENT.fulgur === 'storm' && RUNE_ELEMENT.caret === 'frost' && RUNE_ELEMENT.ignis === 'fire', 'таблица рун');
});
test('серия быстрых недонатянутых выстрелов помечается rapid (слабые стрелы)', () => {
  const S = makeScene();
  const bow = createBowGesture();
  const rel = [];
  let t = 1000;
  for (let shot = 0; shot < 3; shot++) {
    const P = shotScript({ f: 0.35, pullMs: 150, holdMs: 40 });
    for (const f of shotFrames(S, P, t)) {
      bow.push(buildHandFrame(obsOf(S, f.t, f.hands), S.pose()));
      const r = bow.read(f.t);
      if (r.release) rel.push(r);
      t = f.t;
    }
    t -= 900; // следующий выстрел сразу: сдвигаем начало к моменту выпуска (кулак остаётся)
  }
  ok(rel.length >= 2, `выстрелов ${rel.length}`);
  ok(rel.slice(1).some((r) => r.rapid), 'нет пометки rapid');
  ok(!rel[0].rapid, 'первый выстрел помечен rapid');
});
test('шум трекинга: один «раскрытый» кадр при полном натяжении — не выстрел; кисть у лица пропала на 250 мс — стрела на месте', () => {
  const S = makeScene();
  const bow = createBowGesture();
  let rel = 0, glitchT = null, lostT = null;
  for (const f of shotFrames(S, shotScript({ f: 1, holdMs: 1200 }))) {
    let hands = f.hands;
    if (f.phase === 'hold') {
      if (glitchT === null) glitchT = f.t;
      if (f.t - glitchT > 150 && f.t - glitchT < 190) hands = { left: f.hands.left, right: handAt(S, 'right', 0.28, -0.45, SHAPES.pinchOpen, { size: 0.075 }) };
      if (f.t - glitchT > 500 && f.t - glitchT < 750) hands = { left: f.hands.left };
    }
    bow.push(buildHandFrame(obsOf(S, f.t, hands), S.pose()));
    const r = bow.read(f.t);
    if (r.release) { rel++; if (f.phase === 'hold') lostT = f.t; }
  }
  ok(lostT === null, 'выстрел от шума во время удержания');
  ok(rel === 1, `выстрелов ${rel}`);
});
test('гистерезис выхода: левый кулак пропал на 120 мс — стойка держится; на 400 мс — выход', () => {
  const S = makeScene();
  for (const [gap, expectActive] of [[120, true], [400, false]]) {
    const bow = createBowGesture();
    let lostStart = null, activeAfter = null;
    for (const f of shotFrames(S, shotScript({ f: 1, holdMs: 900 }))) {
      let hands = f.hands;
      if (f.phase === 'hold') {
        if (lostStart === null) lostStart = f.t;
        if (f.t - lostStart < gap) hands = { right: f.hands.right };
      }
      bow.push(buildHandFrame(obsOf(S, f.t, hands), S.pose()));
      const r = bow.read(f.t);
      if (lostStart !== null && f.t - lostStart >= gap && f.t - lostStart < gap + 40) activeAfter = r.active;
    }
    ok(activeAfter === expectActive, `gap ${gap}: active ${activeAfter}`);
  }
});

// ───────── 2. точность на случайных выстрелах (синтетика с шумом) ─────────
test('≥ 95% верных натяжений и выстрелов на 300 случайных выстрелах с шумом', () => {
  reseed(777);
  let good = 0;
  const bad = [];
  const N = 300;
  const tally = [[0, 0], [0, 0], [0, 0]];
  for (let i = 0; i < N; i++) {
    const sw = lerp(0.22, 0.38, rnd());
    const scene = { cx: lerp(0.4, 0.6, rnd()), cy: lerp(0.33, 0.5, rnd()), sw };
    const fx = lerp(-0.55, -0.2, rnd()), fy = lerp(-0.15, 0.45, rnd());
    const fwd = lerp(0.36, 0.5, rnd());               // размер кулака / ширина плеч (рука вытянута к камере)
    const kind = i % 3;                               // 0 — слабо, 1 — половина, 2 — полностью (к уху или плечу)
    const f = [0.35, 0.55, 1.0][kind];
    const target = rnd() < 0.5 ? { x: 0.18, y: -0.55 } : { x: 0.5, y: 0 };
    const other = [lerp(0.25, 0.6, rnd()), lerp(0, 0.95, rnd()), lerp(0, 0.95, rnd()), lerp(0, 0.95, rnd())];
    const o = {
      fist: { x: fx, y: fy }, fistSize: fwd * sw,
      nock: { x: fx + lerp(0.08, 0.2, rnd()), y: fy + lerp(-0.08, 0.08, rnd()) },
      pinchSize: fwd * sw * lerp(0.9, 1.0, rnd()),
      full: { x: target.x + lerp(-0.08, 0.08, rnd()), y: target.y + lerp(-0.08, 0.08, rnd()) }, fullSize: lerp(0.24, 0.28, rnd()) * sw,
      pinch: { curls: other, thumb: 'pinch' },
      fistExtra: { roll: lerp(-0.5, 0.5, rnd()), yaw: lerp(-1.2, 1.2, rnd()) },
      pinchExtra: { roll: lerp(-0.6, 0.6, rnd()), yaw: lerp(-0.8, 0.8, rnd()) },
      f, pullMs: lerp(300, 800, rnd()), holdMs: kind === 2 ? lerp(450, 800, rnd()) : lerp(100, 300, rnd()),
      dt: lerp(28, 40, rnd()), jitter: 6, noise: lerp(0.005, 0.02, rnd()),
      release: rnd() < 0.5 ? SHAPES.pinchOpen : SHAPES.open,
    };
    // эталон — тот же выстрел без шума и дрожания кадров: шум, повороты и темп не должны менять натяжение
    const clean = runShot({ ...o, noise: 0, jitter: 0 }, scene).releases[0];
    const r = runShot(o, scene);
    const rel = r.releases[0];
    let good1 = r.releases.length === 1 && !!clean;
    if (good1) {
      good1 = Math.abs(rel.draw - clean.draw) <= 0.15;
      if (kind === 2) good1 = good1 && rel.draw >= 0.85 && rel.charged;
      else good1 = good1 && !rel.charged;
    }
    tally[kind][0]++; if (good1) tally[kind][1]++;
    if (good1) good++; else bad.push({ i, kind, n: r.releases.length, draw: rel && +rel.draw.toFixed(2), clean: clean && +clean.draw.toFixed(2), charged: rel && rel.charged, nock: r.nockAt !== null, dbg: r.debug.counters });
  }
  const acc = good / N;
  if (verbose || acc < 0.95) for (const b of bad.slice(0, 12)) console.log('  MISS', JSON.stringify(b));
  console.log(`  случайные выстрелы: ${(acc * 100).toFixed(1)}% верно (${good}/${N}); слабо ${tally[0][1]}/${tally[0][0]}, половина ${tally[1][1]}/${tally[1][0]}, полностью ${tally[2][1]}/${tally[2][0]}`);
  ok(acc >= 0.95, `точность ${(acc * 100).toFixed(1)}%`);
});

// ───────── 3. ни одного ложного лука ─────────
function runNoBow(frames) {
  const bow = createBowGesture();
  let active = 0, releases = 0;
  for (const { S, t, hands } of frames) {
    bow.push(buildHandFrame(obsOf(S, t, hands), S.pose()));
    const r = bow.read(t);
    if (r.active) active++;
    if (r.release) releases++;
  }
  return { active, releases, dbg: bow.getDebug() };
}
function* seq(S, ms, fn, dt = 33, t0 = 1000) { for (let t = t0; t < t0 + ms; t += dt) yield { S, t, hands: fn(t, (t - t0) / ms) }; }
test('обычное руление левой ладонью (200 прогонов, правая — OK/кулак/указание/отдых): лук не включается', () => {
  reseed(4242);
  let bad = 0;
  const rShapes = ['ok', 'fist', 'point', 'open', 'pinch', 'victory'];
  for (let i = 0; i < 200; i++) {
    const S = makeScene({ cx: lerp(0.42, 0.58, rnd()), cy: lerp(0.35, 0.48, rnd()), sw: lerp(0.24, 0.36, rnd()) });
    const rs = rShapes[i % rShapes.length];
    const rx = lerp(0.3, 0.9, rnd()), ry = lerp(-0.2, 1.4, rnd());
    const ax = lerp(-1.2, -0.3, rnd()), ay = lerp(-0.3, 0.8, rnd());
    const r = runNoBow(seq(S, 2500, (t, k) => ({
      left: handAt(S, 'left', ax + 0.4 * Math.sin(k * 6.3 + i), ay + 0.3 * Math.sin(k * 4 + i * 0.3), 'open', { size: lerp(0.07, 0.11, rnd()), noise: 0.01 }),
      right: handAt(S, 'right', rx, ry, rs, { size: 0.08, noise: 0.01 }),
    })));
    if (r.active || r.releases) bad++;
  }
  ok(bad === 0, `ложных луков: ${bad}`);
});
test('старые жесты: парирование, выброс, сфера, призма, хлопок, руна, OK у ладони — лук не включается', () => {
  const S = makeScene();
  const cases = {
    // парирование: левый кулак → ладонь к камере, правая внизу
    parry: seq(S, 1500, (t, k) => ({ left: handAt(S, 'left', -0.5, 0.3, k < 0.5 ? 'fist' : 'open', { size: 0.1 }), right: handAt(S, 'right', 0.7, 1.4, 'open', { size: 0.075 }) })),
    // выброс: правый кулак → ладонь, левая рулит ладонью
    burst: seq(S, 1500, (t, k) => ({ left: handAt(S, 'left', -0.6, 0.3, 'open', { size: 0.09 }), right: handAt(S, 'right', 0.4, 0.2, k < 0.6 ? 'fist' : 'open', { size: 0.09 }) })),
    // сфера: ладони друг к другу на уровне груди
    orb: seq(S, 1500, (t, k) => ({ left: handAt(S, 'left', -0.35, 0.4, 'open', { size: 0.09, yaw: -1.4 }), right: handAt(S, 'right', 0.35, 0.4, 'open', { size: 0.09, yaw: 1.4 }) })),
    // призма: большие и указательные двух рук вместе (своя щепоть у каждой кисти не замкнута)
    prism: seq(S, 1500, () => ({ left: handAt(S, 'left', -0.22, 0.35, { curls: [0, 0.8, 0.9, 0.9], thumb: 'L' }, { size: 0.09, roll: 0.5 }), right: handAt(S, 'right', 0.22, 0.35, { curls: [0, 0.8, 0.9, 0.9], thumb: 'L' }, { size: 0.09, roll: -0.5 }) })),
    // хлопок: ладони сходятся
    clap: seq(S, 1200, (t, k) => ({ left: handAt(S, 'left', lerp(-0.9, -0.1, Math.min(1, k * 2)), 0.3, 'open', { size: 0.09, yaw: -1.4 }), right: handAt(S, 'right', lerp(0.9, 0.1, Math.min(1, k * 2)), 0.3, 'open', { size: 0.09, yaw: 1.4 }) })),
    // руна указательным правой, левая рулит
    rune: seq(S, 2000, (t, k) => ({ left: handAt(S, 'left', -0.7, 0.35, 'open', { size: 0.09 }), right: handAt(S, 'right', 0.2 + 0.4 * Math.cos(k * 6.28), 0 + 0.4 * Math.sin(k * 6.28), 'point', { size: 0.08 }) })),
    // OK (огонь) правой прямо у раскрытой левой ладони
    okNearPalm: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'open', { size: 0.1 }), right: handAt(S, 'right', -0.3, 0.3, 'ok', { size: 0.1 }) })),
    // левый кулак в зоне, правая щепоть далеко справа
    pinchFar: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'fist', { size: 0.1 }), right: handAt(S, 'right', 0.9, 0.3, 'pinch', { size: 0.09 }) })),
    // кулак и щепоть вместе, но низко (на коленях/животе)
    lowRest: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.2, 1.6, 'fist', { size: 0.08 }), right: handAt(S, 'right', -0.05, 1.6, 'pinch', { size: 0.08 }) })),
    // руки сцеплены у груди у самого тела (кулак не вытянут вперёд)
    atChest: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.15, 0.7, 'fist', { size: 0.072 }), right: handAt(S, 'right', 0, 0.7, 'pinch', { size: 0.072 }) })),
    // левый кулак, правая раскрыта рядом (без щепоти)
    openNear: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'fist', { size: 0.1 }), right: handAt(S, 'right', -0.3, 0.3, 'open', { size: 0.1 }) })),
    // кулак правой у левого кулака (удар кулаком о кулак)
    fistFist: seq(S, 2000, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'fist', { size: 0.1 }), right: handAt(S, 'right', -0.3, 0.3, 'fist', { size: 0.1 }) })),
  };
  const bad = [];
  for (const [name, frames] of Object.entries(cases)) {
    const r = runNoBow(frames);
    if (r.active || r.releases) bad.push(`${name}(active ${r.active}, rel ${r.releases})`);
  }
  ok(bad.length === 0, bad.join(', '));
});

// ───────── 4. подсказки «ОШИБКА» ─────────
function hintsOf(frames) {
  const bow = createBowGesture();
  const h = [];
  for (const { S, t, hands } of frames) { bow.push(buildHandFrame(obsOf(S, t, hands), S.pose())); const r = bow.read(t); if (r.hint) h.push(r.hint.code); }
  return h;
}
test('ОШИБКА: щепоть у раскрытой левой → bow_fist', () => {
  const S = makeScene();
  const h = hintsOf(seq(S, 1500, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'open', { size: 0.1 }), right: handAt(S, 'right', -0.3, 0.3, 'pinch', { size: 0.1 }) })));
  ok(h.includes('bow_fist'), h.join(','));
});
test('ОШИБКА: лук поднят, правая у кулака раскрыта → bow_pinch', () => {
  const S = makeScene();
  const h = hintsOf(seq(S, 1800, () => ({ left: handAt(S, 'left', -0.45, 0.3, 'fist', { size: 0.1 }), right: handAt(S, 'right', -0.25, 0.3, 'open', { size: 0.1 }) })));
  ok(h.includes('bow_pinch'), h.join(','));
});
test('ОШИБКА: наложил и не тянет → bow_draw; держит натянутым → bow_release', () => {
  const r = runShot({ f: 0.03, holdMs: 1800 });
  ok(r.hints.includes('bow_draw'), r.hints.join(','));
  const r2 = runShot({ f: 1, holdMs: 3300 });
  ok(r2.hints.includes('bow_release'), r2.hints.join(','));
});
test('ОШИБКА: кулак и щепоть низко → bow_low; у тела → bow_forward', () => {
  const S = makeScene();
  const h = hintsOf(seq(S, 1500, () => ({ left: handAt(S, 'left', -0.3, 1.25, 'fist', { size: 0.1 }), right: handAt(S, 'right', -0.15, 1.25, 'pinch', { size: 0.1 }) })));
  ok(h.includes('bow_low'), h.join(','));
  const h2 = hintsOf(seq(S, 1500, () => ({ left: handAt(S, 'left', -0.4, 0.3, 'fist', { size: 0.07 }), right: handAt(S, 'right', -0.25, 0.3, 'pinch', { size: 0.07 }) })));
  ok(h2.includes('bow_forward'), h2.join(','));
});
test('коды подсказок лука описаны', () => {
  for (const c of ['bow_fist', 'bow_pinch', 'bow_draw', 'bow_release', 'bow_low', 'bow_forward']) ok(BOW_HINTS[c], c);
});

// ───────── 5. настоящие кисти (HaGRID) ─────────
const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'fixtures/hands/hagrid_images.json'), 'utf8'));
function mainHand(fx) {
  let best = null, size = -1;
  for (const h of fx.hands) { const s = Math.hypot((h.landmarks[0].x - h.landmarks[9].x) * fx.frameW / fx.frameH, h.landmarks[0].y - h.landmarks[9].y); if (s > size) { size = s; best = h; } }
  return best;
}
const byLabel = {};
for (const fx of data.fixtures) (byLabel[fx.hagrid] = byLabel[fx.hagrid] || []).push({ fx, h: mainHand(fx) });
const featOf = ({ fx, h }) => handFeatures(h.landmarks, h.world, fx.frameW / fx.frameH, false, h.handedness === 'Left' ? 'left' : 'right');
const rate = (arr, pred) => arr.filter((x) => pred(featOf(x))).length / arr.length;
test('HaGRID: кулак → лук-кулак ≥ 95%; «ok» → щепоть ≥ 85%; ладони и указание — никогда не щепоть и не кулак', () => {
  const fist = rate(byLabel.fist, (f) => f.shape === 'fist');
  const okp = rate(byLabel.ok, (f) => f.pinchLike);
  const palmBad = rate([...byLabel.palm, ...byLabel.stop], (f) => f.pinchLike || f.shape === 'fist');
  const oneBad = rate(byLabel.one, (f) => f.pinchLike || f.shape === 'fist');
  const fistPinch = rate(byLabel.fist, (f) => f.pinchLike);
  console.log(`  HaGRID: кулак ${(fist * 100).toFixed(0)}%, ok→щепоть ${(okp * 100).toFixed(0)}%, ладонь→щепоть/кулак ${(palmBad * 100).toFixed(0)}%, указание→щепоть/кулак ${(oneBad * 100).toFixed(0)}%, кулак→щепоть ${(fistPinch * 100).toFixed(0)}%`);
  ok(fist >= 0.95 && okp >= 0.85 && palmBad === 0 && oneBad === 0 && fistPinch === 0);
});
test('HaGRID: раскрытые ладони разжимают щепоть (выстрел) ≥ 95%', () => {
  const r = rate([...byLabel.palm, ...byLabel.stop], (f) => f.pinchOpen);
  console.log(`  HaGRID: ладонь → «щепоть разжата» ${(r * 100).toFixed(0)}%`);
  ok(r >= 0.95, `${(r * 100).toFixed(0)}%`);
});

// Сцена из настоящих кистей: кулак (левая) и «ok» (правая) переносятся в кадр, щепоть тянется к уху,
// выпуск — настоящая раскрытая ладонь. landmarks сдвигаются/масштабируются; world (метры) не меняется.
function place(h, fx, S, x, y, size, anchor = 'palm') {
  // size — настоящий масштаб кисти S (как handFeatures().scale), в высотах кадра;
  // anchor 'pinch' — в точку (x, y) ставится середина кончиков большого и указательного, иначе центр ладони
  const asp = fx.frameW / fx.frameH;
  const I = h.landmarks.map((p) => ({ x: p.x * asp, y: p.y, z: p.z }));
  let cx = 0, cy = 0;
  if (anchor === 'pinch') { cx = (I[4].x + I[8].x) / 2; cy = (I[4].y + I[8].y) / 2; }
  else for (const k of [0, 5, 9, 13, 17]) { cx += I[k].x / 5; cy += I[k].y / 5; }
  const f0 = handFeatures(h.landmarks, h.world, asp, false, 'right');
  const k = size / f0.scale;
  const q = S.at(x, y);
  // кадр HaGRID не зеркальный, наш кадр — тоже незеркальный (mirror: true в obs переводит в показ)
  return {
    landmarks: I.map((p) => ({ x: q.cx + ((p.x - cx) * k) / S.aspect, y: q.cy + (p.y - cy) * k, z: p.z * k })),
    world: h.world, handedness: h.handedness, score: 0.95,
  };
}
test('HaGRID-сцена: 120 выстрелов настоящими кистями — ≥ 95% верных', () => {
  reseed(99);
  const fists = byLabel.fist, oks = byLabel.ok.filter((x) => featOf(x).pinchLike), palms = [...byLabel.palm, ...byLabel.stop];
  let good = 0;
  const N = 120;
  const misses = [];
  for (let i = 0; i < N; i++) {
    const sw = lerp(0.24, 0.36, rnd());
    const S = makeScene({ sw });
    const F = fists[i % fists.length], O = oks[(i * 7) % oks.length], Pm = palms[(i * 5) % palms.length];
    const full = i % 2 === 0;
    const f = full ? 1 : 0.5;
    const fwd = lerp(0.36, 0.48, rnd()) * sw, back = 0.26 * sw;
    const fistPos = { x: lerp(-0.5, -0.25, rnd()), y: lerp(0, 0.4, rnd()) };
    const nock = { x: fistPos.x + 0.12, y: fistPos.y - 0.05 };
    const target = i % 4 < 2 ? { x: 0.18, y: -0.55 } : { x: 0.5, y: 0 };
    const bow = createBowGesture();
    let t = 1000, rel = [];
    const fistAt = () => place(F.h, F.fx, S, fistPos.x, fistPos.y, fwd);
    const push = (right) => { t += 33; bow.push(buildHandFrame(obsOf(S, t, { left: fistAt(), right }), S.pose())); const r = bow.read(t); if (r.release) rel.push(r); };
    for (let j = 0; j < 8; j++) push(place(Pm.h, Pm.fx, S, 0.7, 1.4, back));
    for (let j = 0; j < 8; j++) push(place(O.h, O.fx, S, nock.x, nock.y, fwd * 0.95, 'pinch'));
    const tx = lerp(nock.x, target.x, f), ty = lerp(nock.y, target.y, f), ts = lerp(fwd * 0.95, back, f);
    for (let j = 1; j <= 15; j++) { const k = j / 15; push(place(O.h, O.fx, S, lerp(nock.x, tx, k), lerp(nock.y, ty, k), lerp(fwd * 0.95, ts, k), 'pinch')); }
    for (let j = 0; j < (full ? 16 : 5); j++) push(place(O.h, O.fx, S, tx, ty, ts, 'pinch'));
    for (let j = 0; j < 8; j++) push(place(Pm.h, Pm.fx, S, tx + 0.04, ty, ts));
    const r0 = rel[0];
    const g = rel.length === 1 && (full ? r0.draw >= 0.85 && r0.charged : r0.draw >= 0.25 && !r0.charged);
    if (g) good++; else misses.push({ i, fist: F.fx.id, ok: O.fx.id, palm: Pm.fx.id, n: rel.length, draw: r0 && +r0.draw.toFixed(2), charged: r0 && r0.charged, dbg: bow.getDebug().counters });
  }
  const acc = good / N;
  if (verbose || acc < 0.95) for (const m of misses.slice(0, 10)) console.log('  MISS', JSON.stringify(m));
  console.log(`  HaGRID-сцена: ${(acc * 100).toFixed(1)}% верно (${good}/${N})`);
  ok(acc >= 0.95, `${(acc * 100).toFixed(1)}%`);
});
test('HaGRID: расслабленные руки (no_gesture) вместе у груди не дают лука', () => {
  const ng = byLabel.no_gesture;
  let bad = 0;
  for (let i = 0; i < ng.length; i++) {
    const S = makeScene();
    const A = ng[i], B = ng[(i + 5) % ng.length];
    const bow = createBowGesture();
    for (let t = 1000; t < 3000; t += 33) {
      bow.push(buildHandFrame(obsOf(S, t, { left: place(A.h, A.fx, S, -0.15, 0.75, 0.27 * S.sw), right: place(B.h, B.fx, S, 0.02, 0.75, 0.27 * S.sw) }), S.pose()));
      if (bow.read(t).active) { bad++; break; }
    }
  }
  ok(bad === 0, `ложных луков: ${bad} из ${ng.length}`);
});

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
