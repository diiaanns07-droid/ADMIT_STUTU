// Игра стоя. node dev/stand.test.mjs
// • modules/vision.js createStandingDetector: «стоит» — бёдра и колени видны, бедро вертикально; сидя
//   (колени почти на уровне бёдер или за столом) — нет; гистерезис по времени.
// • core/handGestures.js: игрок стоит в ~2 м — пороги в долях кадра нормируются по ширине плеч
//   (взмах-рассечение срабатывает, обычное ведение — нет), подсказка «подойди ближе», а не «сядь ближе».
// Синтетика, не реальная камера.

import { createStandingDetector } from '../modules/vision.js';
import { createHandGestures } from '../core/handGestures.js';
import { hintInfo } from '../core/gestureCoach.js';
import { makeScene, handAt, obsOf, reseed, gauss } from './handSynth.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const lerp = (a, b, u) => a + (b - a) * u;
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

// 33 точки позы: плечи на shY, ширина плеч sw (высоты кадра), бёдра на torso·sw ниже, колени на kneeDrop·sw ниже бёдер
function pose({ shY = 0.3, sw = 0.16, torso = 1.5, kneeDrop = 1.3, hipVis = 0.9, kneeVis = 0.9, aspect = 4 / 3 } = {}) {
  const P = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
  const put = (i, x, y, v) => { P[i] = { x: 0.5 + x * sw / aspect, y, z: 0, visibility: v }; };
  put(11, 0.5, shY, 0.95); put(12, -0.5, shY, 0.95);
  const hipY = shY + torso * sw;
  put(23, 0.3, hipY, hipVis); put(24, -0.3, hipY, hipVis);
  put(25, 0.3, hipY + kneeDrop * sw, kneeVis); put(26, -0.3, hipY + kneeDrop * sw, kneeVis);
  return P;
}
function feed(det, P, t0, ms, dt = 33) { let on = false; for (let t = t0; t < t0 + ms; t += dt) on = det.update(P, t); return on; }

test('стоит (бедро вертикально) → standing через ~0,7 с', () => {
  const d = createStandingDetector();
  ok(!feed(d, pose(), 0, 500), 'ещё рано');
  ok(feed(d, pose(), 500, 400), 'стоит');
});

test('сидит: колени почти на уровне бёдер — не стоит', () => {
  const d = createStandingDetector();
  ok(!feed(d, pose({ shY: 0.4, sw: 0.3, kneeDrop: 0.6 }), 0, 3000), 'сидя на стуле');
});

test('сидит за столом: бёдер и коленей не видно — не стоит', () => {
  const d = createStandingDetector();
  ok(!feed(d, pose({ shY: 0.4, sw: 0.3, hipVis: 0.2, kneeVis: 0.1 }), 0, 3000), 'за столом');
});

test('сел обратно — standing гаснет через ~1,2 с, а не от одного кадра', () => {
  const d = createStandingDetector();
  ok(feed(d, pose(), 0, 1500), 'стоит');
  ok(feed(d, pose({ kneeVis: 0.1 }), 1500, 600), 'кадры без коленей — ещё стоит');
  ok(!feed(d, pose({ kneeVis: 0.1 }), 2100, 1000), 'долго без признаков — сидит');
});

// ───────── handGestures стоя ─────────
const STAND = { cx: 0.5, cy: 0.3, sw: 0.16 };
const SIT = { cx: 0.5, cy: 0.4, sw: 0.3 };
function runRight(scene, seq, standing, opts = {}) {
  reseed(17);
  const S = makeScene(scene), k = scene.sw / 0.3;
  const g = createHandGestures({ moveMode: 'steer', profile: 'master', ...opts });
  const ev = { slash: 0, hints: [] };
  let t = 1000, T0 = 1000;
  for (const P of seq) {
    for (; t < T0 + P.ms; t += 33) {
      const q = P.R((t - T0) / P.ms);
      const h = q ? handAt(S, 'right', q.x + 0.01 * gauss(), q.y + 0.01 * gauss(), q.shape, { noise: 0.03 / Math.sqrt(k), size: 0.075 * k * (q.size || 1), yaw: q.yaw || 0 }) : null;
      const o = obsOf(S, t, { right: h });
      o.standing = standing;
      g.push(o);
      const f = g.read(t);
      if (f.slash) ev.slash++;
      if (f.hint) ev.hints.push(f.hint.code);
    }
    T0 += P.ms;
  }
  return { ev, g };
}
const swipe = (x0, x1, ms) => [
  { ms: 800, R: () => ({ x: x0, y: 0.15, shape: 'open', yaw: 0.9 }) },
  { ms, R: (u) => ({ x: lerp(x0, x1, ease(u)), y: 0.15, shape: 'open', yaw: 0.9 }) },
  { ms: 600, R: () => ({ x: x1, y: 0.15, shape: 'open', yaw: 0.9 }) },
];

test('стоя: взмах ребром ладони (≈1,4 ширины плеч за 0,2 с) — рассечение', () => {
  const { ev, g } = runRight(STAND, swipe(0.75, -0.65, 200), true);
  ok(ev.slash === 1, `slash=${ev.slash}`);
  ok(g.getDebug().standing === true && g.getDebug().unitK < 0.6, JSON.stringify({ s: g.getDebug().standing, k: g.getDebug().unitK }));
});

test('стоя: медленное ведение рукой (то же расстояние за 1 с) — не рассечение', () => {
  const { ev } = runRight(STAND, swipe(0.75, -0.65, 1000), true);
  ok(ev.slash === 0, `slash=${ev.slash}`);
});

test('сидя: тот же взмах — рассечение, медленный — нет (как раньше)', () => {
  ok(runRight(SIT, swipe(0.75, -0.65, 200), false).ev.slash === 1, 'быстрый');
  ok(runRight(SIT, swipe(0.75, -0.65, 1000), false).ev.slash === 0, 'медленный');
});

test('стоя, кисть мелкая: подсказка «подойди ближе», а не «сядь ближе»', () => {
  const hold = [{ ms: 4000, R: () => ({ x: 0.45, y: 0.2, shape: 'open', size: 0.55 }) }];
  const st = runRight(STAND, hold, true).ev.hints;
  ok(st.includes('hand_far_stand') && !st.includes('hand_far'), st.join(','));
  ok(hintInfo('hand_far_stand') && /подойди/.test(hintInfo('hand_far_stand').text), 'текст подсказки');
});

test('стоя, обычная для 2 м кисть — подсказки «далеко» нет', () => {
  const hold = [{ ms: 4000, R: () => ({ x: 0.45, y: 0.2, shape: 'open' }) }];
  const st = runRight(STAND, hold, true).ev.hints;
  ok(!st.some((c) => /^hand_far/.test(c)), st.join(','));
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
