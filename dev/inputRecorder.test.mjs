// Тесты core/inputRecorder.js: запись кистей (?rec=1 в игре) → разбор dev/replay.mjs.
// node dev/inputRecorder.test.mjs
import { createInputRecorder, packObservation, unpackFrame, RECORDING_VERSION } from '../core/inputRecorder.js';
import { createHandGestures } from '../core/handGestures.js';
import { makeHand, SHAPES, reseed } from './handSynth.mjs';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) { try { fn(); pass++; results.push(`PASS ${name}`); } catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.message}`); } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

reseed(5);
const obsAt = (t, size) => ({
  tMs: t, frameW: 640, frameH: 480, mirror: true,
  hands: [makeHand({ side: 'left', cx: 0.62, cy: 0.45, size, noise: 0.02, ...SHAPES.open }), makeHand({ side: 'right', cx: 0.36, cy: 0.5, size: 0.12, ...SHAPES.ok })],
  poseWrists: { left: { x: 0.63, y: 0.52, visibility: 0.9 }, right: { x: 0.35, y: 0.57, visibility: 0.8 } },
  bodyCenter: { x: 0.5, y: 0.4 }, shoulderWidth: 0.25,
});

test('упаковка → распаковка: точки, запястья, плечи, стороны сохраняются (до 1e-4)', () => {
  const o = obsAt(1234.5, 0.12);
  const u = unpackFrame(JSON.parse(JSON.stringify(packObservation(o))));
  ok(u.tMs === 1234.5 && u.frameW === 640 && u.mirror === true, 'шапка');
  ok(u.hands.length === 2 && u.hands[0].handedness === 'Left' && u.hands[1].handedness === 'Right', 'кисти');
  let maxErr = 0;
  for (let h = 0; h < 2; h++) for (let i = 0; i < 21; i++) {
    maxErr = Math.max(maxErr, Math.abs(u.hands[h].landmarks[i].x - o.hands[h].landmarks[i].x), Math.abs(u.hands[h].world[i].z - o.hands[h].world[i].z));
  }
  ok(maxErr <= 6e-5, 'точность ' + maxErr);
  ok(Math.abs(u.poseWrists.left.x - 0.63) < 1e-9 && u.shoulderWidth === 0.25 && u.bodyCenter.y === 0.4, 'поза');
});

test('мусор не записывается и не ломает запись', () => {
  const r = createInputRecorder();
  r.add(null); r.add({}); r.add({ tMs: NaN }); r.add({ tMs: 5, hands: [{ landmarks: [1, 2] }, null] });
  ok(r.size() === 1 && r.snapshot().frames[0].hs.length === 0, 'один кадр без кисти');
  ok(r.snapshot().version === RECORDING_VERSION && r.snapshot().kind === 'ashen-hands', 'формат');
});

test('разбор записи даёт то же, что игра вживую: щит от толчка, ход руля', () => {
  const live = createHandGestures({ moveMode: 'steer' }), rec = createInputRecorder();
  const seq = [];
  let t = 1000;
  for (; t < 2000; t += 33) seq.push(obsAt(t, 0.12));
  const t0 = t;
  for (; t < t0 + 600; t += 33) seq.push(obsAt(t, 0.12 * (1 + 0.35 * Math.min(1, (t - t0) / 180))));
  const liveOut = seq.map((o) => { live.push(o); rec.add(o); const f = live.peek(o.tMs); return [f.shield, +f.moveZ.toFixed(3), +f.moveX.toFixed(3)]; });
  const again = createHandGestures({ moveMode: 'steer' });
  const recOut = JSON.parse(JSON.stringify(rec.snapshot())).frames.map((fr) => { const o = unpackFrame(fr); again.push(o); const f = again.peek(o.tMs); return [f.shield, +f.moveZ.toFixed(3), +f.moveX.toFixed(3)]; });
  ok(liveOut.some((x) => x[0]), 'вживую толчок поднял щит');
  let diff = 0;
  for (let i = 0; i < liveOut.length; i++) if (liveOut[i][0] !== recOut[i][0] || Math.abs(liveOut[i][1] - recOut[i][1]) > 0.01 || Math.abs(liveOut[i][2] - recOut[i][2]) > 0.01) diff++;
  ok(diff === 0, `расхождений кадров: ${diff} из ${liveOut.length}`);
});

test('ограничение длины: старые кадры уходят, счётчик dropped', () => {
  const r = createInputRecorder({ maxFrames: 10 });
  for (let i = 0; i < 25; i++) r.add({ tMs: i, hands: [] });
  const s = r.snapshot();
  ok(r.size() === 10 && s.dropped === 15 && s.frames[0].t === 15, JSON.stringify({ n: r.size(), d: s.dropped }));
});

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
