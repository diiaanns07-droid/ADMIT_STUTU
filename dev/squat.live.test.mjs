// [W3-SQUAT] Приседания «как у живой камеры»: core/squatCounter.js на реалистичной синтетике dev/squatSim.mjs —
// дрожь точек ±2–3 % кадра, распознавание 12–15 Гц, лодыжки за кадром (ноутбук на столе), неглубокие приседы,
// помехи (переминается, отходит, машет руками). «Новичок» такие повторы считает, «Мастер» — строг как раньше.
// node dev/squat.live.test.mjs. Синтетика, не реальная камера.
import { createSquatCounter, synthSquatPose, SQUAT_HINTS, SQUAT_FRAME_TIPS } from '../core/squatCounter.js';
import { simulateSquatSession, makeRng } from './squatSim.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

// ноутбук на столе (камера 1 м, крышка чуть вверх) — стопы за кадром; низко (0,6 м) и дальше — человек целиком
const TABLE = { cameraHeightM: 1.0, cameraPitchDeg: 8, distanceM: 2.7 };
const LOW = { cameraHeightM: 0.6, cameraPitchDeg: 0, distanceM: 3.0 };
const SEEDS = [1, 2, 3, 4];

// Прогон сессий по сидам: { truth, reps, attempts, clean, points, faults, last }
function session(mode, o, seeds = SEEDS, n = 5) {
  const out = { truth: 0, reps: 0, attempts: 0, clean: 0, points: 0, events: [], faults: {}, reads: [] };
  for (const seed of seeds) {
    const S = simulateSquatSession({ seed, n, ...o });
    const c = createSquatCounter({ mode });
    for (const f of S.frames) { c.push(f); out.events.push(...c.drain()); }
    const r = c.read();
    out.truth += S.truth.reps.length; out.reps += r.reps; out.attempts += r.attempts; out.clean += r.clean; out.points += r.points;
    for (const [k, v] of Object.entries(r.faults)) out.faults[k] = (out.faults[k] || 0) + v;
    out.reads.push(r);
  }
  return out;
}
const fmt = (s) => `засчитано ${s.reps}/${s.truth}, попыток ${s.attempts}, чистых ${s.clean}, очков ${s.points}, ошибки ${JSON.stringify(Object.fromEntries(Object.entries(s.faults).filter(([, v]) => v)))}`;

// ───────── «Новичок» у ноутбука на столе ─────────
for (const [jitter, hz] of [[0.02, 15], [0.03, 12], [0.025, 13]]) {
  test(`Новичок, ноутбук на столе (стопы за кадром), дрожь ±${Math.round(jitter * 100)}% кадра, ${hz} Гц: глубокие приседы засчитаны`, () => {
    const s = session('novice', { ...TABLE, jitter, hz, reps: 'clean' });
    assert(s.reps === s.truth && s.attempts === s.truth, fmt(s));
    assert(s.reads.every((r) => r.feet === false && r.mode === 'novice'), 'режим без стоп');
  });
}

test('Новичок: неглубокие приседы 110–120° (дрожь ±3%, 12 Гц) засчитаны', () => {
  const s = session('novice', { ...TABLE, jitter: 0.03, hz: 12, reps: 'shallow115' });
  assert(s.reps >= s.truth - 1, fmt(s));
  const low = session('novice', { ...LOW, jitter: 0.03, hz: 12, reps: 'shallow115' });
  assert(low.reps === low.truth, 'низкая камера: ' + fmt(low));
});

test('Новичок: «как новичок» (бёдра на 55–75°, быстро, корпус вперёд) — засчитано ≥ 80%, ошибки — карточкой, +1', () => {
  const s = session('novice', { ...TABLE, jitter: 0.025, hz: 13, reps: 'novice' });
  assert(s.reps >= Math.ceil(s.truth * 0.8), fmt(s));
  assert(s.events.every((e) => (e.clean ? e.points === 2 : e.points === 1 && e.faults.length > 0)), 'очки: чистый +2, с ошибкой +1 ' + JSON.stringify(s.events.slice(0, 3)));
  assert(s.points === s.events.reduce((a, e) => a + e.points, 0), 'сумма очков');
});

test('Новичок: лодыжки не видны совсем (видимость 0,05–0,45) — считаем по тазу и бедру', () => {
  const s = session('novice', { ...LOW, jitter: 0.025, hz: 15, reps: 'shallow115', anklesHidden: true });
  assert(s.reps === s.truth, fmt(s));
  assert(s.reads.every((r) => r.framing.status === 'okNoFeet'), 'подготовка: «вижу до колен» ' + s.reads.map((r) => r.framing.status).join(','));
});

test('Новичок: быстро (0,3–0,4 с) — засчитано +1 с ошибкой «Слишком быстро», не чисто', () => {
  const s = session('novice', { ...LOW, jitter: 0.02, hz: 15, reps: 'fast' });
  assert(s.reps === s.truth && s.clean === 0 && s.points === s.reps && s.faults.fast >= s.truth, fmt(s));
  assert(s.reads.every((r) => r.lastRep.ok === true && r.lastRep.faults.includes('fast') && r.lastHint.code === 'fast'), 'последний повтор — засчитан с ошибкой');
});

test('Новичок: совсем мелко (бёдра 25–40°) — не повтор; переминается, отходит, машет руками — ни одного лишнего', () => {
  const s = session('novice', { ...LOW, jitter: 0.03, hz: 15, reps: 'tooShallow' });
  assert(s.reps === 0, fmt(s));
  for (const extra of [{ fidget: [-1, -1, -1] }, { walk: [-1, 0, 1] }, { arms: [-1, 0] }]) {
    const z = session('novice', { ...TABLE, jitter: 0.025, hz: 15, reps: 'clean', n: 3, ...extra }, SEEDS, 3);
    assert(z.reps <= z.truth, `${JSON.stringify(extra)}: ${fmt(z)}`);
  }
  const idle = session('novice', { ...TABLE, jitter: 0.03, hz: 15, reps: [], fidget: [-1, -1, -1], standS: 8 });
  assert(idle.reps === 0 && idle.attempts === 0, 'переминается без приседаний: ' + fmt(idle));
});

test('Новичок: наклонили крышку ноутбука туда и обратно (кадр съехал на 6–20%), человек стоит — не повтор', () => {
  for (const shift of [0.06, 0.12, 0.2]) for (const seed of [1, 2]) {
    const S = simulateSquatSession({ seed, n: 0, reps: [], standS: 12, tailS: 0, ...TABLE, jitter: 0.02, hz: 15 });
    const c = createSquatCounter({ mode: 'novice' });
    const t0 = S.frames[0].tMs;
    const u = (t) => Math.min(1, Math.max(0, (t - 4000) / 600)) - Math.min(1, Math.max(0, (t - 7000) / 600));
    let deep = false;
    for (const f of S.frames) {
      const k = u(f.tMs - t0);
      c.push({ ...f, landmarks: f.landmarks.map((p) => (p ? { ...p, y: p.y + shift * k } : null)) });
      if (c.read().phase === 'bottom') deep = true;
    }
    const r = c.read();
    assert(r.reps === 0 && !deep, `сдвиг ${shift}, seed ${seed}: ${JSON.stringify({ reps: r.reps, attempts: r.attempts, deep })}`);
  }
});

// ───────── «Мастер»: строгость как раньше ─────────
test('Мастер: ноутбук на столе (стопы за кадром) — не считаем, просим «до стоп»', () => {
  const s = session('master', { ...TABLE, jitter: 0.02, hz: 15, reps: 'clean' });
  assert(s.reps === 0, fmt(s));
  assert(s.reads.every((r) => r.phase === 'noPose' && r.message === SQUAT_HINTS.frame), 'сообщение ' + s.reads[0].message);
});

test('Мастер: человек целиком, дрожь ±3%, 12 Гц — глубокие чистые засчитаны; неглубокие 110–120° — нет', () => {
  const s = session('master', { ...LOW, jitter: 0.03, hz: 12, reps: 'clean' });
  assert(s.reps >= Math.ceil(s.truth * 0.85), fmt(s));
  assert(s.points === s.reps && s.clean === s.reps, 'в «Мастере» очко за чистый, без бонуса');
  const sh = session('master', { ...LOW, jitter: 0.03, hz: 12, reps: 'shallow115' });
  assert(sh.reps === 0 && sh.faults.shallow >= sh.truth - 1, 'неглубокие: ' + fmt(sh));
});

test('Мастер: ошибка техники — повтор не засчитан (быстро)', () => {
  const s = session('master', { ...LOW, jitter: 0.02, hz: 15, reps: 'fast' });
  assert(s.reps === 0 && s.faults.fast >= Math.ceil(s.truth * 0.7), fmt(s));
});

// ───────── регрессия: дрожь точек на простой синтетике ─────────
// Раньше при дрожи ±1 % кадра стоящий человек читался как «колено 154°» < 160° и подготовка не кончалась (0 попыток).
for (const mode of ['master', 'novice']) {
  test(`${mode}: дрожь ±2–3% кадра на 12–15 Гц — стоя не застреваем в подготовке, глубокие повторы засчитаны`, () => {
    for (const [J, fps] of [[0.02, 15], [0.03, 12]]) for (const view of ['front', 'side']) {
      const rng = makeRng(`${mode}${J}${fps}${view}`);
      const c = createSquatCounter({ mode });
      let t = 1000;
      const frame = (k) => {
        const L = synthSquatPose(k, view).map((p, i) => (p && i < 29 ? { ...p, x: p.x + J * (2 * rng() - 1), y: p.y + J * (2 * rng() - 1) } : null));
        c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: L }); t += (1000 / fps) * (0.8 + 0.4 * rng());
      };
      for (let i = 0; i < fps * 1.5; i++) frame(0);
      for (let r = 0; r < 6; r++) {
        for (let i = 0; i < fps; i++) frame(0.5 - 0.5 * Math.cos(Math.PI * i / fps));
        for (let i = 0; i < fps * 0.9; i++) frame(0.5 + 0.5 * Math.cos(Math.PI * i / (fps * 0.9)));
        for (let i = 0; i < fps * 0.6; i++) frame(0);
      }
      for (let i = 0; i < fps; i++) frame(0);
      const r = c.read();
      assert(r.reps >= 5 && r.attempts <= 7, `${view} ±${J} ${fps} Гц: ${JSON.stringify({ reps: r.reps, attempts: r.attempts, faults: r.faults, phase: r.phase })}`);
    }
  });
}

test('лодыжки то видны, то нет (провалы) — «Новичок» считает дальше, «Мастер» просит стопы', () => {
  for (const mode of ['novice', 'master']) {
    const c = createSquatCounter({ mode });
    const rng = makeRng('drop' + mode);
    let t = 1000;
    const frame = (k) => {
      const L = synthSquatPose(k, 'front');
      if (rng() < 0.5) for (const j of [27, 28]) L[j] = { ...L[j], visibility: 0.1 + 0.3 * rng() };
      for (const j of [29, 30, 31, 32]) L[j] = null;
      c.push({ tMs: t, frameW: 640, frameH: 480, landmarks: L }); t += 70;
    };
    for (let i = 0; i < 25; i++) frame(0);
    for (let r = 0; r < 5; r++) { for (let i = 0; i < 15; i++) frame(0.5 - 0.5 * Math.cos(Math.PI * i / 15)); for (let i = 0; i < 14; i++) frame(0.5 + 0.5 * Math.cos(Math.PI * i / 14)); for (let i = 0; i < 9; i++) frame(0); }
    const r = c.read();
    if (mode === 'novice') assert(r.reps === 5, 'novice ' + JSON.stringify({ reps: r.reps, att: r.attempts, faults: r.faults }));
    else assert(r.reps < 5, 'master ' + JSON.stringify({ reps: r.reps, att: r.attempts, faults: r.faults }));
  }
});

// ───────── подготовка и диагностика ─────────
test('подготовка: стол — «вижу до колен ✓» и совет про стопы; низко — «вижу тебя целиком ✓»; вплотную — «отойди»', () => {
  const look = (mode, o) => {
    const S = simulateSquatSession({ seed: 5, n: 0, standS: 2, tailS: 0, ...o });
    const c = createSquatCounter({ mode });
    for (const f of S.frames) c.push(f);
    return c.read().framing;
  };
  const tbl = look('novice', { ...TABLE, distanceM: 2.5, jitter: 0.015 });
  assert(tbl.status === 'okNoFeet' && tbl.ready && tbl.statusText === SQUAT_FRAME_TIPS.okNoFeet, 'стол: ' + JSON.stringify(tbl));
  assert(['tiltDown', 'stepBack'].includes(tbl.tip.code) && /стоп|ноги/i.test(tbl.tip.text), 'совет: ' + tbl.tip.text);
  assert(tbl.points[25].ok && !tbl.points[27].ok, 'колени видно, лодыжки — нет: ' + JSON.stringify(tbl.points));
  const tblM = look('master', { ...TABLE, distanceM: 2.5, jitter: 0.015 });
  assert(tblM.status === null && !tblM.full, 'Мастер без стоп — не готово');
  const low = look('novice', { ...LOW, jitter: 0.015, model: 'full' });
  assert(low.status === 'ok' && low.full && low.ready && low.tip.code === 'ok' && /целиком ✓/.test(low.statusText), 'низко: ' + JSON.stringify(low));
  const close = look('novice', { cameraHeightM: 1.0, cameraPitchDeg: 8, distanceM: 1.1, jitter: 0.015 });
  assert(['stepBack', 'tiltUp'].includes(close.tip.code), 'вплотную: ' + JSON.stringify(close.tip));
  const empty = createSquatCounter({ mode: 'novice' });
  empty.push({ tMs: 1000, frameW: 640, frameH: 480, landmarks: new Array(33).fill(null) });
  assert(empty.read().framing.tip.code === 'noPerson', 'пусто: ' + JSON.stringify(empty.read().framing.tip));
});

test('диагностика: видимость точек ног, угол, фаза по-русски, причина отказа последнего повтора', () => {
  const S = simulateSquatSession({ seed: 7, n: 2, reps: 'tooShallow', ...LOW, jitter: 0.02, hz: 15 });
  const S2 = simulateSquatSession({ seed: 8, n: 2, reps: [{ thighDeg: 50, downS: 0.9, upS: 0.8 }, { thighDeg: 48, downS: 0.9, upS: 0.8 }], ...LOW, jitter: 0.02, hz: 15 });
  for (const sess of [S, S2]) {
    const c = createSquatCounter({ mode: 'novice' });
    for (const f of sess.frames) c.push(f);
    const d = c.read().diag;
    for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) assert(typeof d.vis[i] === 'number' && d.vis[i] >= 0 && d.vis[i] <= 1, 'видимость ' + i);
    assert(typeof d.knee === 'number' && typeof d.phaseRu === 'string' && d.mode === 'novice' && d.downDeg === 129, JSON.stringify(d));
    assert(d.hz > 10 && d.hz < 20, 'частота ' + d.hz);
    if (d.last) assert(d.last.ok === false && d.last.faults[0] === 'shallow' && /глубже/.test(d.last.reason), 'причина: ' + JSON.stringify(d.last));
  }
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed (синтетика dev/squatSim.mjs, не реальная камера)`);
if (pass !== tests.length) process.exitCode = 1;
