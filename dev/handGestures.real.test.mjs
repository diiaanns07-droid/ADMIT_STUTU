// Точность core/handGestures.js на НАСТОЯЩИХ landmarks MediaPipe (фикстуры HaGRID, см.
// dev/fixtures/hands/SOURCES.md). node dev/handGestures.real.test.mjs [--verbose]
// Каждое изображение подаётся как неподвижный кадр ~500 мс (чтобы прошли удержания формы).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandGestures } from '../core/handGestures.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'fixtures/hands/hagrid_images.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');

const LABELS = ['open', 'fist', 'point', 'pinch', 'victory', 'thumb', 'neutral'];
const SHAPES = ['open', 'fist', 'point', 'pinch', 'victory', 'unknown', 'none'];
const matrix = Object.fromEntries(LABELS.map((l) => [l, Object.fromEntries(SHAPES.map((s) => [s, 0]))]));
const misses = [];
const palm = { camera: 0, away: 0, side: 0, unknown: 0 };

// Главная кисть кадра — самая большая (жест показывают ей).
function mainHand(fx) {
  let best = null, size = -1;
  for (const h of fx.hands) {
    const w = h.landmarks[0], m = h.landmarks[9];
    const s = Math.hypot((w.x - m.x) * fx.frameW / fx.frameH, w.y - m.y);
    if (s > size) { size = s; best = h; }
  }
  return best;
}

for (const fx of data.fixtures) {
  const h = mainHand(fx);
  const g = createHandGestures();
  let t = 1000;
  // только главная кисть: вторая рука в кадре HaGRID обычно опущена и к жесту не относится
  const obs = () => ({ tMs: t, frameW: fx.frameW, frameH: fx.frameH, mirror: false, hands: [h], poseWrists: null, bodyCenter: fx.bodyCenter });
  for (; t < 1520; t += 33) g.push(obs());
  const f = g.peek(t);
  const st = f.right || f.left;
  const shape = st ? st.shape : 'none';
  matrix[fx.label][shape]++;
  if ((fx.label === 'open') && st) palm[st.palmFacing]++;
  const expected = { open: ['open'], fist: ['fist'], point: ['point'], pinch: ['pinch'], victory: ['victory'], thumb: ['fist', 'unknown'], neutral: null }[fx.label];
  if (expected && !expected.includes(shape)) misses.push({ id: fx.id, label: fx.label, got: shape, dbg: g.getDebug()[f.right ? 'right' : 'left'] });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('Матрица ошибок (строки — метка HaGRID, столбцы — форма интерпретатора):');
console.log(pad('', 9) + SHAPES.map((s) => pad(s, 8)).join(''));
for (const l of LABELS) console.log(pad(l, 9) + SHAPES.map((s) => pad(matrix[l][s], 8)).join(''));
const acc = (l, okShapes) => {
  const row = matrix[l];
  const n = Object.values(row).reduce((a, b) => a + b, 0);
  return { n, acc: n ? okShapes.reduce((a, s) => a + row[s], 0) / n : 0 };
};
const rep = {
  open: acc('open', ['open']), fist: acc('fist', ['fist']), point: acc('point', ['point']),
  pinch: acc('pinch', ['pinch']), victory: acc('victory', ['victory']),
};
console.log('\nТочность:', Object.entries(rep).map(([k, v]) => `${k} ${(v.acc * 100).toFixed(0)}% (n=${v.n})`).join(', '));
const neutral = matrix.neutral;
console.log(`neutral (расслабленные руки): pinch ${neutral.pinch}, fist ${neutral.fist}, point ${neutral.point} из ${Object.values(neutral).reduce((a, b) => a + b, 0)} — формы, которые могли бы дать огонь/заряд/руну`);
console.log(`ладонь (open): к камере ${palm.camera}, от камеры ${palm.away}, ребром ${palm.side}`);
if (verbose) for (const m of misses) console.log('MISS', m.id, m.label, '→', m.got, JSON.stringify(m.dbg));

const targets = { open: 0.9, fist: 0.9, point: 0.85, pinch: 0.85, victory: 0.8 };
let failed = 0;
for (const [k, min] of Object.entries(targets)) {
  const ok = rep[k].acc >= min;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${k} ≥ ${min * 100}%`);
}
const neutralBad = (neutral.pinch + neutral.point) / Math.max(1, Object.values(neutral).reduce((a, b) => a + b, 0));
const nOk = neutralBad <= 0.25;
if (!nOk) failed++;
console.log(`${nOk ? 'PASS' : 'FAIL'} расслабленная рука редко выглядит как щипок/указание (${(neutralBad * 100).toFixed(0)}% ≤ 25%)`);
process.exit(failed ? 1 : 0);
