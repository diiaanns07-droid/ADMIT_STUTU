// [W3-MAGIC] «Ладони вместе → растянуть»: в стороны — «Врата бури» (sigil 'gate'), вверх-вниз — «Столп небес»
// ('pillar'). node dev/stretch.test.mjs
// • core/handGestures.js на синтетике двух кистей (dev/handSynth.mjs): оба направления распознаются в
//   «Новичке» и «Мастере» при 8–30 Гц; сила растёт от удержания; заряд и ось — для HUD;
//   медленно / не сомкнув / по диагонали — печати нет, есть подсказка «ОШИБКА»;
//   хлопок, сфера (и её рост), призма с ними не путаются; потеря сомкнутых ладоней не срывает жест.
// • modules/combat.js: волна «Врат бури» долетает до Регента (урон по силе) + бастион, «Столп небес» оглушает;
//   «Новичок» пропускает обе печати; снимок player.sigilCharge / sigilAxis.
// Синтетика, не реальная камера.

import { createHandGestures } from '../core/handGestures.js';
import { createCombat } from '../modules/combat.js';
import { createDebugInput } from '../core/debugInput.js';
import { makeScene, handAt, makeHand, obsOf, reseed, SHAPES } from './handSynth.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const lerp = (a, b, u) => a + (b - a) * u;

const S = makeScene({ cx: 0.5, cy: 0.4, sw: 0.3 });
// ладони ребром друг к другу (молитвенно); x, y — центр ладони в ширинах плеч (координаты показа)
const palm = (side, x, y, extra = {}) => handAt(S, side, x, y, 'open', { yaw: side === 'left' ? 1.2 : -1.2, noise: 0.004, ...extra });
// позиции двух ладоней: середина (0, 0.15), смещение каждой от середины (ox, oy)
const pair = (ox, oy, extra) => ({ left: palm('left', -ox, 0.15 - oy, extra), right: palm('right', ox, 0.15 + oy, extra) });
const TOG = 0.06;   // ладони сомкнуты

// seq: [{ ms, pose: (u) => {left, right} | null }]; hz — частота кадров камеры
function run(g, seq, hz = 30, t0 = 1000) {
  const dt = 1000 / hz;
  const ev = { sigils: [], hints: [], charge: [], axis: new Set(), dash: 0, slash: 0, burst: 0, conjure: 0, throw: 0 };
  let t = t0;
  for (const P of seq) {
    const n = Math.max(1, Math.round(P.ms / dt));
    for (let k = 0; k < n; k++, t += dt) {
      const pose = P.pose(n > 1 ? k / (n - 1) : 1);
      g.push(obsOf(S, Math.round(t), pose || { left: null, right: null }));
      const f = g.read(Math.round(t));
      if (f.sigil) ev.sigils.push({ kind: f.sigil, power: f.sigilPower });
      if (f.hint) ev.hints.push(f.hint.code);
      ev.charge.push(f.sigilCharge);
      if (f.sigilAxis) ev.axis.add(f.sigilAxis);
      if (f.dashDir) ev.dash++;
      if (f.slash) ev.slash++;
      if (f.burst) ev.burst++;
      if (f.conjure) ev.conjure++;
      if (f.throw) ev.throw++;
    }
  }
  return ev;
}
// сомкнуть на holdMs, затем растянуть за ms до (ox, oy)
const stretch = (ox, oy, { holdMs = 600, ms = 220, after = 300 } = {}) => [
  { ms: 400, pose: () => pair(0.35, 0) },                                  // руки поднялись
  { ms: 150, pose: (u) => pair(lerp(0.35, TOG, u), 0) },                   // сошлись
  { ms: holdMs, pose: () => pair(TOG, 0) },                                // сомкнуты
  { ms, pose: (u) => pair(lerp(TOG, ox, u), lerp(0, oy, u)) },             // растянули
  { ms: after, pose: () => pair(ox, oy) },
];
const kinds = (ev) => ev.sigils.map((s) => s.kind).join(',');
// только «Врата бури» / «Столп небес» (в «Мастере» быстро сведённые ладони — ещё и «Хлопок» перед ними)
const magic = (ev) => ev.sigils.filter((s) => s.kind === 'gate' || s.kind === 'pillar').map((s) => s.kind).join(',');
const H = [0.55, 0];       // в стороны
const V = [0.07, 0.42];    // вверх-вниз

for (const profile of ['novice', 'master']) {
  for (const hz of [30, 15, 10, 8]) {
    test(`${profile} ${hz} Гц: в стороны — «Врата бури», вверх-вниз — «Столп небес»`, () => {
      reseed(11);
      let ev = run(createHandGestures({ moveMode: 'steer', profile }), stretch(...H), hz);
      ok(magic(ev) === 'gate', `в стороны: [${kinds(ev)}] hints=${ev.hints}`);
      ok(ev.dash === 0 && ev.slash === 0 && ev.burst === 0, `рывок/взмах/выброс: ${ev.dash}/${ev.slash}/${ev.burst}`);
      reseed(12);
      ev = run(createHandGestures({ moveMode: 'steer', profile }), stretch(...V), hz);
      ok(magic(ev) === 'pillar', `вверх-вниз: [${kinds(ev)}] hints=${ev.hints}`);
      ok(ev.dash === 0 && ev.slash === 0 && ev.burst === 0, `рывок/взмах/выброс: ${ev.dash}/${ev.slash}/${ev.burst}`);
    });
  }
}

test('«Мастер»: ладони сведены спокойно — только «Врата»; сведены рывком — «Хлопок», затем «Врата»', () => {
  reseed(25);
  const calm = stretch(...H);
  calm[1] = { ms: 1000, pose: (u) => pair(lerp(0.35, TOG, u), 0) };
  let ev = run(createHandGestures({ moveMode: 'steer', profile: 'master' }), calm);
  ok(kinds(ev) === 'gate', `спокойно: [${kinds(ev)}]`);
  reseed(26);
  ev = run(createHandGestures({ moveMode: 'steer', profile: 'master' }), stretch(...V));
  ok(kinds(ev) === 'clap,pillar', `рывком: [${kinds(ev)}]`);
});

test('сила: чем дольше держал ладони сомкнутыми, тем мощнее (0,3 → 1,5 с)', () => {
  const p = [350, 900, 1600].map((holdMs) => {
    reseed(13);
    const ev = run(createHandGestures({ profile: 'novice' }), stretch(...H, { holdMs }));
    ok(ev.sigils.length === 1, `hold ${holdMs}: [${kinds(ev)}]`);
    return ev.sigils[0].power;
  });
  ok(p[0] < p[1] && p[1] < p[2], 'не растёт: ' + p.join(' → '));
  ok(p[0] >= 0.3 && p[2] <= 1 && p[2] >= 0.75, 'диапазон: ' + p.join(' → '));
});

test('заряд: пока ладони сомкнуты, sigilCharge растёт 0 → 1; при растяжении есть ось h / v', () => {
  reseed(14);
  const g = createHandGestures({ profile: 'novice' });
  const ev = run(g, stretch(...H, { holdMs: 1700, ms: 400 }));
  const peak = Math.max(...ev.charge);
  ok(peak >= 0.99, 'пик заряда ' + peak);
  ok(ev.charge.some((c) => c > 0.2 && c < 0.6), 'промежуточный заряд');
  ok(ev.axis.has('h') && !ev.axis.has('v'), 'ось ' + [...ev.axis]);
  ok(ev.charge[ev.charge.length - 1] === 0, 'после печати заряд гаснет');
  reseed(15);
  const ev2 = run(createHandGestures({ profile: 'novice' }), stretch(...V, { ms: 400 }));
  ok(ev2.axis.has('v') && !ev2.axis.has('h'), 'ось ' + [...ev2.axis]);
});

test('медленно — печати нет, подсказка stretch_slow', () => {
  for (const [ox, oy] of [H, V]) {
    reseed(16);
    const ev = run(createHandGestures({ profile: 'novice' }), stretch(ox, oy, { ms: 1400 }));
    ok(ev.sigils.length === 0, `[${kinds(ev)}]`);
    ok(ev.hints.includes('stretch_slow'), 'подсказки: ' + ev.hints);
  }
});

test('по диагонали — печати нет, подсказка stretch_diag', () => {
  reseed(17);
  const ev = run(createHandGestures({ profile: 'novice' }), stretch(0.32, 0.32));
  ok(ev.sigils.length === 0, `[${kinds(ev)}]`);
  ok(ev.hints.includes('stretch_diag'), 'подсказки: ' + ev.hints);
});

test('ладони не сомкнуты (рядом, но с промежутком, ладонями к камере) — печати нет, подсказка stretch_open', () => {
  reseed(18);
  const flat = (ox) => ({ left: handAt(S, 'left', -ox, 0.15, 'open'), right: handAt(S, 'right', ox, 0.15, 'open') });
  const ev = run(createHandGestures({ profile: 'novice' }), [
    { ms: 600, pose: () => flat(0.2) },
    { ms: 200, pose: (u) => flat(lerp(0.2, 0.6, u)) },
    { ms: 300, pose: () => flat(0.6) },
  ]);
  ok(ev.sigils.length === 0, `[${kinds(ev)}]`);
  ok(ev.hints.includes('stretch_open'), 'подсказки: ' + ev.hints);
});

test('сомкнул на миг (< 0,3 с) и растянул — печати нет', () => {
  reseed(19);
  const ev = run(createHandGestures({ profile: 'novice' }), stretch(...H, { holdMs: 120 }));
  ok(ev.sigils.length === 0, `[${kinds(ev)}]`);
});

test('MediaPipe теряет сомкнутые ладони: кисти пропали на 0,3 с и вернулись растянутыми — печать есть', () => {
  for (const [ox, oy, want] of [[...H, 'gate'], [...V, 'pillar']]) {
    for (const hz of [30, 10]) {
      reseed(20);
      const ev = run(createHandGestures({ profile: 'novice' }), [
        { ms: 400, pose: () => pair(0.35, 0) },
        { ms: 150, pose: (u) => pair(lerp(0.35, TOG, u), 0) },
        { ms: 500, pose: () => pair(TOG, 0) },
        { ms: 300, pose: () => null },
        { ms: 300, pose: () => pair(ox, oy) },
      ], hz);
      ok(kinds(ev) === want, `${want} ${hz} Гц: [${kinds(ev)}]`);
    }
  }
});

test('сфера: «мяч» между ладонями, рост сферы и бросок толчком — ни врат, ни столпа', () => {
  for (const profile of ['novice', 'master']) {
    reseed(21);
    const orb = (ox, size = 0.075) => ({ left: handAt(S, 'left', -ox, 0.15, 'open', { yaw: 1.2, size }), right: handAt(S, 'right', ox, 0.15, 'open', { yaw: -1.2, size }) });
    const ev = run(createHandGestures({ moveMode: 'steer', profile }), [
      { ms: 800, pose: () => orb(0.2) },
      { ms: 220, pose: (u) => orb(lerp(0.2, 0.5, u)) },        // сфера растёт резко — это не «Врата»
      { ms: 500, pose: () => orb(0.5) },
      { ms: 200, pose: (u) => orb(0.5, 0.075 * (1 + 0.5 * u)) },
      { ms: 300, pose: () => orb(0.5, 0.11) },
    ]);
    ok(ev.conjure > 10, `${profile}: сфера conjure=${ev.conjure}`);
    ok(ev.throw >= 1, `${profile}: бросок ${ev.throw}`);
    ok(!ev.sigils.some((s) => s.kind === 'gate' || s.kind === 'pillar'), `${profile}: [${kinds(ev)}]`);
    ok(!ev.hints.some((h) => /^stretch_/.test(h)), `${profile}: подсказки ${ev.hints}`);
  }
});

test('хлопок («Мастер»): быстро свёл — clap; ни врат, ни столпа', () => {
  reseed(22);
  const ev = run(createHandGestures({ moveMode: 'steer', profile: 'master' }), [
    { ms: 600, pose: () => pair(0.45, 0) },
    { ms: 130, pose: (u) => pair(lerp(0.45, TOG, u), 0) },
    { ms: 100, pose: () => pair(TOG, 0) },
    { ms: 200, pose: (u) => pair(lerp(TOG, 0.45, u), 0) },
    { ms: 400, pose: () => pair(0.45, 0) },
  ]);
  ok(kinds(ev) === 'clap', `[${kinds(ev)}]`);
});

test('призма («Мастер»): треугольник пальцами и бросок — ни врат, ни столпа', () => {
  reseed(23);
  const prism = (size = 0.14) => {
    const roll = 0.4, cy = 0.55;
    const probe = makeHand({ ...SHAPES.open, side: 'left', cx: 0.5, cy, roll, size });
    const off = probe.landmarks[8].x - 0.5;
    return [makeHand({ ...SHAPES.open, side: 'left', cx: 0.5 - off, cy, roll, size }), makeHand({ ...SHAPES.open, side: 'right', cx: 0.5 + off, cy, roll: -roll, size })];
  };
  const g = createHandGestures({ moveMode: 'steer', profile: 'master' });
  const ev = { sigils: [], conjure: 0, throw: 0 };
  let t = 1000;
  const step = (hands) => { g.push({ ...obsOf(S, t, hands), poseWrists: null }); const f = g.read(t); if (f.sigil) ev.sigils.push(f.sigil); if (f.conjure && f.conjure.kind === 'prism') ev.conjure++; if (f.throw) ev.throw++; t += 33; };
  for (let i = 0; i < 25; i++) step(prism());
  for (let i = 0; i <= 6; i++) step(prism(0.14 * (1 + 0.5 * i / 6)));
  for (let i = 0; i < 10; i++) step(prism(0.21));
  ok(ev.conjure > 5, 'призма ' + ev.conjure);
  ok(!ev.sigils.includes('gate') && !ev.sigils.includes('pillar'), ev.sigils.join(','));
});

test('руки просто опускаются и поднимаются рядом — без печатей', () => {
  reseed(24);
  const ev = run(createHandGestures({ moveMode: 'steer', profile: 'novice' }), [
    { ms: 500, pose: () => pair(0.3, 0) },
    { ms: 600, pose: (u) => ({ left: palm('left', -0.3, lerp(0.15, 1.4, u)), right: palm('right', 0.3, lerp(0.15, 1.4, u)) }) },
    { ms: 400, pose: () => null },
  ]);
  ok(ev.sigils.length === 0, `[${kinds(ev)}]`);
});

// ───────── бой ─────────
const DT = 1 / 60;
const inp = (o = {}) => ({ valid: true, moveX: 0, moveZ: 0, attack: false, shield: false, ...o });
const idle = { update: () => ({ stage: 1, action: 'idle', attacks: [] }), reset() {} };
function fight(input, sec = 2) {
  const c = createCombat({ config: {}, bossBrain: idle });
  const ev = [];
  c.update(DT, inp(input)); ev.push(...c.drainEvents());
  for (let t = 0; t < sec; t += DT) { c.update(DT, inp()); ev.push(...c.drainEvents()); }
  return { c, ev };
}

test('бой: «Врата бури» — волна долетает до Регента, урон растёт с силой; бастион поднят', () => {
  const lo = fight({ gestureMode: 'novice', sigil: 'gate', sigilPower: 0.3 });
  const hi = fight({ gestureMode: 'novice', sigil: 'gate', sigilPower: 1 });
  const cast = hi.ev.find((e) => e.type === 'sigil_cast');
  ok(cast && cast.data.sigil === 'gate' && cast.data.power === 1 && cast.data.eta > 0, 'sigil_cast: ' + JSON.stringify(cast && cast.data));
  ok(hi.ev.some((e) => e.type === 'bastion_start'), 'бастион');
  const hit = (r) => r.ev.find((e) => e.type === 'boss_hit' && e.data.source === 'sigil' && e.data.sigil === 'gate');
  ok(hit(lo) && hit(hi), 'попадание boss_hit source=sigil, data.sigil=gate');
  ok(hit(hi).data.amount > hit(lo).data.amount, `урон ${hit(lo).data.amount} → ${hit(hi).data.amount}`);
  ok(hi.c.getSnapshot().cooldowns.sigils.gate.remaining > 0, 'перезарядка');
});

test('бой: «Столп небес» — удар сверху, оглушение ~1,2 с, урон больше, перезарядка дольше', () => {
  const r = fight({ gestureMode: 'novice', sigil: 'pillar', sigilPower: 1 }, 0.6);
  const cast = r.ev.find((e) => e.type === 'sigil_cast');
  ok(cast && cast.data.sigil === 'pillar' && cast.data.power === 1, 'sigil_cast');
  const st = r.ev.find((e) => e.type === 'boss_stunned');
  ok(st && st.data.source === 'pillar' && Math.abs(st.data.duration - 1.2) < 1e-6, 'оглушение ' + JSON.stringify(st && st.data));
  ok(r.c.getSnapshot().boss.stunned, 'Регент оглушён');
  const hp = r.ev.find((e) => e.type === 'boss_hit' && e.data.sigil === 'pillar');
  const g = fight({ sigil: 'gate', sigilPower: 1 });
  const hg = g.ev.find((e) => e.type === 'boss_hit' && e.data.sigil === 'gate');
  ok(hp && hg && hp.data.amount > hg.data.amount, 'урон столпа больше врат');
  const cfg = r.c.getConfig().sigils;
  ok(cfg.pillar.cooldown > cfg.gate.cooldown, 'перезарядка столпа дольше');
});

test('бой: «Новичок» пропускает врата и столп, но не остальные печати; снимок — заряд и ось', () => {
  const c = createCombat({ config: {}, bossBrain: idle });
  c.update(DT, inp({ gestureMode: 'novice', sigil: 'clap' }));
  ok(!c.drainEvents().some((e) => e.type === 'sigil_cast'), 'хлопок в «Новичке» отброшен');
  c.update(DT, inp({ gestureMode: 'novice', sigilCharge: 0.42, sigilAxis: 'v' }));
  const p = c.getSnapshot().player;
  ok(p.sigilCharge === 0.42 && p.sigilAxis === 'v', JSON.stringify({ c: p.sigilCharge, a: p.sigilAxis }));
  c.update(DT, inp({ gestureMode: 'novice', sigilCharge: 'x', sigilAxis: 'diag' }));
  ok(c.getSnapshot().player.sigilCharge === 0 && c.getSnapshot().player.sigilAxis === null, 'мусор отброшен');
});

test('отладка: X / G — удержание даёт заряд и ось, отпускание — печать с силой по удержанию', () => {
  const L = {};
  const target = { addEventListener: (t, f) => { (L[t] || (L[t] = [])).push(f); }, removeEventListener() {} };
  const dbg = createDebugInput(target);
  dbg.setEnabled(true);
  const key = (type, code) => { for (const f of L[type]) f({ code, key: code, repeat: false, target: null, preventDefault() {} }); };
  key('keydown', 'KeyG');
  let fr = dbg.read();
  ok(fr.sigil === null && fr.sigilAxis === 'v', 'удержание G: ' + JSON.stringify({ s: fr.sigil, a: fr.sigilAxis }));
  key('keyup', 'KeyG');
  fr = dbg.read();
  ok(fr.sigil === 'pillar' && fr.sigilPower >= 0.4 && fr.sigilCharge === 0, 'G: ' + JSON.stringify({ s: fr.sigil, p: fr.sigilPower }));
  key('keydown', 'KeyX'); key('keyup', 'KeyX');
  fr = dbg.read();
  ok(fr.sigil === 'gate', 'X: ' + fr.sigil);
  ok(dbg.read().sigil === null, 'импульс один раз');
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
