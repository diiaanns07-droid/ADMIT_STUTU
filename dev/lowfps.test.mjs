// Жесты на низкой частоте распознавания. node dev/lowfps.test.mjs [--report] [--trials N] [--profile novice|master]
// Одни и те же непрерывные движения (кисть из dev/handSynth.mjs: шум точек, пропуски кадров)
// снимаются «камерой» на 30, 15 и 8 Гц со случайной фазой кадров — как на слабом ноутбуке, где
// MediaPipe (поза + кисти) успевает 6–10 раз в секунду. Считаем, с какой доли попыток жест срабатывает
// и сколько ложных срабатываний даёт обычное ведение героя. Синтетика, не реальная камера.

import { createHandGestures } from '../core/handGestures.js';
import { makeScene, handAt, obsOf, reseed, rnd, gauss } from './handSynth.mjs';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TRIALS = +argOf('--trials', 24);
const REPORT = argv.includes('--report');
const PROFILE = argOf('--profile', 'novice');
const RATES = [30, 15, 8];

const lerp = (a, b, u) => a + (b - a) * u;
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const NX = -0.55, CHEST = 0.28, LAP = 1.45;

// Сценарий: фазы { ms, L(u), R(u) } → кисть или null; want(f, tRel) — признак успеха в кадре.
// tag фазы 'act' — окно, в котором ждём жест (и чуть после).
function seqDash(dir) {
  // левая поднята у груди, затем резкий дёрг (≈0,1 с наружу, возврат ≈0,15 с) — «щелчок»
  const D = { out: [-0.6, 0], in: [0.55, 0], up: [0, -0.5] }[dir];
  const open = (x, y) => ({ side: 'left', x, y, shape: 'open' });
  return {
    phases: [
      { ms: 300, L: () => open(NX, LAP) },
      { ms: 400, L: (u) => open(NX, lerp(LAP, CHEST, ease(u))) },
      { ms: 1300, L: () => open(NX, CHEST) },
      { ms: 100, tag: 'act', L: (u) => open(NX + D[0] * ease(u), CHEST + D[1] * ease(u)) },
      { ms: 60, tag: 'act', L: () => open(NX + D[0], CHEST + D[1]) },
      { ms: 160, tag: 'act', L: (u) => open(NX + D[0] * (1 - ease(u)), CHEST + D[1] * (1 - ease(u))) },
      { ms: 700, tag: 'after', L: () => open(NX, CHEST) },
    ],
    hit: (f) => !!f.dashDir && (dir === 'up' ? f.dashDir.z > 0.5 : dir === 'out' ? f.dashDir.x < -0.5 : f.dashDir.x > 0.5),
  };
}
function seqSlash() {
  // правая раскрытая ладонь ребром: взмах поперёк груди ≈1,4 ширины плеч за 0,2 с
  const open = (x, y) => ({ side: 'right', x, y, shape: 'open', yaw: 0.9 });
  return {
    phases: [
      { ms: 900, R: () => open(0.75, 0.15) },
      { ms: 200, tag: 'act', R: (u) => open(lerp(0.75, -0.65, ease(u)), 0.15) },
      { ms: 600, tag: 'after', R: () => open(-0.65, 0.15) },
    ],
    hit: (f) => !!f.slash,
  };
}
function seqShield() {
  // левая у груди (руль), затем толчок ладонью к камере: кисть +35 % за 0,22 с, держит 1 с
  const open = (size) => ({ side: 'left', x: NX, y: CHEST, shape: 'open', size: 0.075 * size });
  return {
    phases: [
      { ms: 300, L: () => open(0.9) },
      { ms: 400, L: (u) => ({ ...open(lerp(0.9, 1, u)), y: lerp(LAP, CHEST, ease(u)) }) },
      { ms: 1800, L: () => open(1) },
      { ms: 220, tag: 'act', L: (u) => open(lerp(1, 1.35, ease(u))) },
      { ms: 1000, tag: 'act', L: () => open(1.35) },
      { ms: 300, tag: 'after', L: (u) => open(lerp(1.35, 1, ease(u))) },
      { ms: 700, tag: 'after', L: () => open(1) },
    ],
    hit: (f) => !!f.shield,
  };
}
function seqOk() {
  const h = (shape) => ({ side: 'right', x: 0.45, y: 0.2, shape });
  return { phases: [{ ms: 600, R: () => h('open') }, { ms: 900, tag: 'act', R: () => h('ok') }, { ms: 300, tag: 'after', R: () => h('open') }], hit: (f) => !!f.attack };
}
function seqBurst() {
  const h = (shape) => ({ side: 'right', x: 0.5, y: 0.25, shape });
  return { phases: [{ ms: 500, R: () => h('open') }, { ms: 900, R: () => h('fist') }, { ms: 500, tag: 'act', R: () => h('open') }], hit: (f) => !!f.burst };
}
function seqOrb() {
  const orb = (x, side, size = 1) => ({ side, x, y: 0.15, shape: 'open', yaw: side === 'left' ? 1.2 : -1.2, size: 0.075 * size });
  return {
    phases: [
      { ms: 1000, L: () => orb(-0.35, 'left'), R: () => orb(0.35, 'right') },
      { ms: 220, tag: 'act', L: (u) => orb(-0.35, 'left', 1 + 0.5 * ease(u)), R: (u) => orb(0.35, 'right', 1 + 0.5 * ease(u)) },
      { ms: 500, tag: 'act', L: () => orb(-0.35, 'left', 1.5), R: () => orb(0.35, 'right', 1.5) },
    ],
    hit: (f) => !!f.throw,
  };
}
function seqRune() {
  // ▲ указательным правой, ≈1,2 с, в конце — замереть
  const V = [[0.15, -0.35], [0.55, 0.3], [-0.25, 0.3], [0.15, -0.35]];
  const pt = (x, y) => ({ side: 'right', x, y, shape: 'point' });
  return {
    phases: [
      { ms: 600, R: () => pt(V[0][0], V[0][1]) },
      { ms: 1200, tag: 'act', R: (u) => { const a = u * 3, k = Math.min(2, Math.floor(a)), q = a - k; return pt(lerp(V[k][0], V[k + 1][0], q), lerp(V[k][1], V[k + 1][1], q)); } },
      { ms: 900, tag: 'act', R: () => pt(V[0][0], V[0][1]) },
    ],
    hit: (f) => f.rune === 'ignis',
  };
}

// Прогон: камера с частотой hz, фаза кадров случайна; шум точек и редкие пропуски кадров трекера.
function runSeq(seq, hz, seed, profile) {
  reseed(seed);
  const S = makeScene({ cx: 0.5, cy: 0.4, sw: 0.3 });
  const g = createHandGestures({ moveMode: 'steer', profile });
  const dt = 1000 / hz;
  let t = 1000 + rnd() * dt;          // фаза кадров
  let T0 = 1000;                      // начало фазы на «настоящем» времени
  let hit = false, hitT = null, actT0 = null, falseHit = 0;
  for (const P of seq.phases) {
    if (P.tag === 'act' && actT0 === null) actT0 = T0;
    for (; t < T0 + P.ms; t += dt * (1 + 0.08 * gauss())) {
      const u = (t - T0) / P.ms;
      const drop = rnd() < 0.04;      // трекер потерял кисть на кадр
      const mk = (fn) => {
        if (!fn || drop) return null;
        const q = fn(u);
        if (!q) return null;
        return handAt(S, q.side, q.x + 0.012 * gauss(), q.y + 0.012 * gauss(), q.shape, { noise: 0.03, yaw: q.yaw || 0, size: q.size || 0.075 });
      };
      const L = mk(P.L), R = mk(P.R);
      g.push(obsOf(S, t, { left: L, right: R }));
      const f = g.read(t);
      if (seq.hit(f)) {
        if (P.tag === 'act' || P.tag === 'after') { if (!hit) { hit = true; hitT = t - actT0; } }
        else falseHit++;
      }
    }
    T0 += P.ms;
  }
  return { hit, hitT, falseHit };
}

const SEQS = {
  'рывок наружу': () => seqDash('out'),
  'рывок внутрь': () => seqDash('in'),
  'рывок вперёд': () => seqDash('up'),
  'щит толчком': seqShield,
  '«OK» — снаряды': seqOk,
  'кулак → выброс': seqBurst,
  'сфера → бросок': seqOrb,
};
const MASTER_SEQS = { 'рассечение': seqSlash, 'руна ▲': seqRune };

export function measure(profile = PROFILE, trials = TRIALS) {
  const out = {};
  const all = { ...SEQS, ...(profile === 'master' ? MASTER_SEQS : {}) };
  for (const [name, mk] of Object.entries(all)) {
    out[name] = {};
    for (const hz of RATES) {
      let hits = 0, falses = 0; const lat = [];
      for (let k = 0; k < trials; k++) {
        const r = runSeq(mk(), hz, 101 + k * 7919 + hz, profile);
        if (r.hit) { hits++; lat.push(r.hitT); }
        falses += r.falseHit;
      }
      out[name][hz] = { pct: Math.round(100 * hits / trials), falses, ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null };
    }
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const R = { novice: measure('novice'), master: measure('master') };
  if (REPORT) {
    for (const [p, tab] of Object.entries(R)) {
      console.log(`\n${p}: доля срабатываний, % (ложных кадров до жеста) · задержка от начала жеста, мс`);
      for (const [name, row] of Object.entries(tab)) console.log(`  ${name.padEnd(16)} ${RATES.map((hz) => `${hz} Гц: ${String(row[hz].pct).padStart(3)}%${row[hz].falses ? ` (+${row[hz].falses})` : ''} ${row[hz].ms ?? '—'} мс`).join(' · ')}`);
    }
  }
  // пороги: базовые жесты срабатывают с первой попытки на 30, 15 и 8 Гц; ложных — ноль
  let bad = 0;
  const need = { 30: 95, 15: 90, 8: 80 };   // на 8 Гц жест часто целиком умещается в 1–2 кадра
  for (const [p, tab] of Object.entries(R)) for (const [name, row] of Object.entries(tab)) for (const hz of RATES) {
    const r = row[hz];
    const okk = r.pct >= need[hz] && r.falses === 0;
    if (!okk) bad++;
    if (!okk || !REPORT) console.log(`${okk ? 'PASS' : 'FAIL'} ${p} · ${name} · ${hz} Гц: ${r.pct}% (нужно ≥ ${need[hz]}%), ложных ${r.falses}`);
  }
  process.exitCode = bad ? 1 : 0;
}
