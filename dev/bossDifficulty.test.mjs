// [W5-СЛОЖНОСТЬ] Поведение Регента по сложности (modules/boss.js, BOSS_DIFFICULTY): честность замахов для камеры,
// приёмы «Сложной» и «Кошмара», упреждение, связки, финт, ранняя вторая стадия; «Лёгкая»/«Обычная» — прежний мозг.
// node dev/bossDifficulty.test.mjs
import { createBossBrain, BOSS_DIFFICULTY, FAIR_MIN_WINDUP, DEFAULT_BOSS_CONFIG, telegraphCounter, difficultyOfSnapshot } from '../modules/boss.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
const DT = 1 / 60;

// Простой «игрок»: обходит Регента по кругу r = 6.5 со скоростью 2.3 м/с, раз в 9 с меняет сторону; энергия скачет.
function snapAt(t, o) {
  const dir = Math.floor(t / 9) % 2 ? -1 : 1;
  const w = dir * 2.3 / 6.5;
  const a = w * (t % 9) + (dir < 0 ? 0 : 0);
  const x = 6.5 * Math.sin(a), z = 6.5 * Math.cos(a);
  return {
    status: 'playing', time: t, difficulty: o.level,
    player: { position: { x, y: 0, z }, velocity: { x: w * 6.5 * Math.cos(a), z: -w * 6.5 * Math.sin(a) }, hp: 100, energy: o.energy ? o.energy(t) : 80, maxEnergy: 100 },
    boss: { position: { x: 0, y: 0, z: 0 }, hp: o.hp ? o.hp(t) : 1000, maxHp: 1000 },
    cooldowns: { dashRemaining: 0 },
  };
}
// прогон мозга: все выпущенные AttackSpec, отмены, переходы стадии
function run(level, { seed = 7, sec = 240, hp, energy } = {}) {
  const b = createBossBrain({ seed });
  const out = { specs: [], cancels: [], stage2At: null, decisions: 0, brain: b };
  for (let i = 0; i < sec / DT; i++) {
    const t = i * DT;
    const d = b.update(DT, snapAt(t, { level, hp, energy }));
    out.decisions++;
    for (const s of d.attacks) out.specs.push({ t, ...s });
    if (d.cancelIds) out.cancels.push({ t, ids: d.cancelIds.slice(), next: d.attacks.map((s) => s.id) });
    if (d.stageChanged && out.stage2At === null) out.stage2At = t;
  }
  return out;
}
const hpLine = (perSec) => (t) => Math.max(1, 1000 - t * perSec);

test('уровни: easy/normal — без профиля (прежний мозг), hard/nightmare — свои', () => {
  assert(BOSS_DIFFICULTY.easy === null && BOSS_DIFFICULTY.normal === null, 'easy/normal');
  assert(BOSS_DIFFICULTY.hard && BOSS_DIFFICULTY.nightmare, 'hard/nightmare');
  assert(difficultyOfSnapshot({ difficulty: 'hard' }) === 'hard' && difficultyOfSnapshot({ difficulty: { level: 'nightmare' } }) === 'nightmare', 'уровень из снимка');
  assert(difficultyOfSnapshot({}) === null && difficultyOfSnapshot(null) === null, 'без уровня');
});

test('«Лёгкая», «Обычная», «Испытание» и снимок без уровня — одна и та же последовательность атак', () => {
  for (const seed of [1, 2, 3, 11]) {
    const ref = run(undefined, { seed, sec: 150, hp: hpLine(5) }).specs.map((s) => JSON.stringify(s));
    for (const lv of ['easy', 'normal', 'challenge', 'base']) {
      const got = run(lv, { seed, sec: 150, hp: hpLine(5) }).specs.map((s) => JSON.stringify(s));
      assert(got.join('|') === ref.join('|'), `${lv}, seed ${seed}: порядок или параметры атак изменились`);
    }
  }
});

test('честность для камеры: каждый замах ≥ 0,45 с, ≥ реакции и ≥ cue + lead; «!» (cue) у каждой атаки', () => {
  for (const lv of ['hard', 'nightmare']) {
    const b = createBossBrain({ seed: 1 });
    b.setDifficulty(lv);
    const cfg = b.getConfig();
    const floor = Math.max(FAIR_MIN_WINDUP, cfg.reaction.cvLatency + cfg.reaction.human + cfg.reaction.margin, cfg.telegraph.cue + cfg.telegraph.lead);
    assert(Math.abs(cfg.windupFloor - floor) < 1e-9 && floor >= FAIR_MIN_WINDUP, `${lv}: пол ${cfg.windupFloor}`);
    for (let seed = 1; seed <= 6; seed++) {
      const r = run(lv, { seed, sec: 200, hp: hpLine(4) });
      assert(r.specs.length > 30, `${lv}: мало атак ${r.specs.length}`);
      for (const s of r.specs) {
        assert(s.windup >= floor - 1e-9, `${lv}: замах ${s.windup} < ${floor} (${s.id})`);
        assert(s.cue > 0 && s.cue + cfg.telegraph.lead <= s.windup + 1e-9, `${lv}: «!» не успевает: cue ${s.cue}, замах ${s.windup}`);
      }
    }
  }
  // начальный баланс: пол прежний (1,1 с)
  assert(createBossBrain({}).getConfig().windupFloor >= 1.1 - 1e-9, 'начальный пол');
});

test('«Сложная»: замахи короче начального баланса; «Кошмар» — ещё короче', () => {
  const avg = (lv, kind) => { const r = run(lv, { seed: 3, sec: 300, hp: hpLine(2) }).specs.filter((s) => s.kind === kind && !s.move); return r.reduce((a, s) => a + s.windup, 0) / Math.max(1, r.length); };
  for (const k of ['slam', 'orb', 'nova']) {
    const n = avg('normal', k), h = avg('hard', k), m = avg('nightmare', k);
    assert(h < n && m < h, `${k}: normal ${n.toFixed(2)} hard ${h.toFixed(2)} nightmare ${m.toFixed(2)}`);
  }
});

test('вторая стадия раньше: «Сложная» — 60% здоровья, «Кошмар» — 70%', () => {
  const at = (lv) => run(lv, { seed: 2, sec: 200, hp: hpLine(5) }).stage2At;   // −5 HP/с
  const n = at('normal'), h = at('hard'), m = at('nightmare');
  assert(n !== null && h !== null && m !== null, `стадии ${n} ${h} ${m}`);
  assert(m < h && h < n, `normal ${n.toFixed(1)} hard ${h.toFixed(1)} nightmare ${m.toFixed(1)}`);
  assert(h >= 80 - 6 && h <= 80 + 6 && m >= 60 - 6 && m <= 60 + 6, `пороги: hard ${h.toFixed(1)} c (≈80), nightmare ${m.toFixed(1)} c (≈60)`);
});

test('приёмы: «Сложная» — двойной удар, залп сфер, финт, связки; «Кошмар» — ещё и «Каменный капкан»', () => {
  for (const lv of ['hard', 'nightmare']) {
    const all = { moves: new Set(), cancels: 0, chains: 0, feints: 0 };
    for (let seed = 1; seed <= 4; seed++) {
      const r = run(lv, { seed, sec: 240, hp: hpLine(3) });
      for (const s of r.specs) if (s.move) all.moves.add(s.move);
      all.cancels += r.cancels.length;
      const d = r.brain.getDebug();
      all.chains += d.chains; all.feints += d.feints;
      assert(d.level === lv, `уровень в мозге ${d.level}`);
    }
    for (const m of ['double', 'volley']) assert(all.moves.has(m), `${lv}: нет приёма ${m}`);
    assert(lv !== 'nightmare' || all.moves.has('trap'), 'Кошмар: нет капкана');
    assert(lv !== 'hard' || !all.moves.has('trap'), 'Сложная: капкана нет');
    assert(all.cancels > 0 && all.cancels === all.feints, `${lv}: финты ${all.feints}, отмены ${all.cancels}`);
    assert(all.chains > 0, `${lv}: нет связок`);
  }
});

test('финт: отмена объявленного замаха и в том же решении — настоящая атака с полным честным замахом', () => {
  let checked = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const r = run('nightmare', { seed, sec: 200, hp: hpLine(3) });
    const floor = r.brain.getConfig().windupFloor;
    for (const c of r.cancels) {
      const first = r.specs.find((s) => s.id === c.ids[0]);
      assert(first && c.t - first.t < first.windup - 0.15, `финт обрывает до удара (за ${first && (first.windup - (c.t - first.t)).toFixed(2)} с)`);
      assert(c.next.length >= 1, 'после финта — новая атака');
      for (const id of c.next) { const s = r.specs.find((x) => x.id === id); assert(s && s.windup >= floor - 1e-9, `замах после финта ${s && s.windup}`); }
      checked++;
    }
  }
  assert(checked >= 3, `финтов ${checked}`);
});

test('залп сфер: 3–4 сферы веером, разные цели, одна за другой; капкан — круги в ряд с одним замахом', () => {
  let vol = 0, trap = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const r = run('nightmare', { seed, sec: 200, hp: hpLine(2) });
    const byT = new Map();
    for (const s of r.specs) if (s.move === 'volley' || s.move === 'trap') { const k = `${s.move}@${s.t.toFixed(4)}`; if (!byT.has(k)) byT.set(k, []); byT.get(k).push(s); }
    for (const [k, g] of byT) {
      if (k.startsWith('volley')) {
        vol++;
        assert(g.length >= 3 && g.length <= 4 && g.every((s) => s.kind === 'orb' && s.blockable), `залп ${g.length}`);
        const w = g.map((s) => s.windup);
        assert(w.every((x, i) => i === 0 || x > w[i - 1]), 'сферы одна за другой');
        assert(new Set(g.map((s) => `${s.target.x.toFixed(2)},${s.target.z.toFixed(2)}`)).size === g.length, 'цели разные');
      } else {
        trap++;
        assert(g.length === 3 && g.every((s) => s.kind === 'slam' && s.windup === g[0].windup), `капкан ${g.length}`);
        const d01 = Math.hypot(g[0].target.x - g[1].target.x, g[0].target.z - g[1].target.z);
        assert(d01 > 2 && d01 < 4, `шаг кругов ${d01.toFixed(2)}`);
      }
    }
  }
  assert(vol >= 2 && trap >= 2, `залпов ${vol}, капканов ${trap}`);
});

test('упреждение: на «Сложной» удар ладонью — впереди идущего героя, на «Обычной» — где он сейчас', () => {
  const lead = (lv) => {
    const r = run(lv, { seed: 4, sec: 120 });
    const ds = [];
    for (const s of r.specs.filter((x) => x.kind === 'slam' && !x.move)) {
      const p = snapAt(s.t, {}).player;
      const ahead = (s.target.x - p.position.x) * p.velocity.x + (s.target.z - p.position.z) * p.velocity.z;
      ds.push(ahead / Math.hypot(p.velocity.x, p.velocity.z));
    }
    return ds.reduce((a, v) => a + v, 0) / Math.max(1, ds.length);
  };
  const n = lead('normal'), h = lead('hard'), m = lead('nightmare');
  assert(Math.abs(n) < 0.05, `normal: ${n.toFixed(2)} м`);
  assert(h > 0.8 && m > h, `hard ${h.toFixed(2)} м, nightmare ${m.toFixed(2)} м`);
});

test('детерминизм: тот же seed и уровень — та же последовательность; Math.random не используется', () => {
  const saved = Math.random;
  Math.random = () => { throw new Error('Math.random'); };
  try {
    const a = run('nightmare', { seed: 9, sec: 120, hp: hpLine(4) }).specs.map((s) => s.id + s.windup).join();
    const b = run('nightmare', { seed: 9, sec: 120, hp: hpLine(4) }).specs.map((s) => s.id + s.windup).join();
    assert(a === b && a.length > 0, 'разные прогоны');
  } finally { Math.random = saved; }
});

test('подписи телеграфа: составные приёмы — свои названия и честный ответ', () => {
  assert(telegraphCounter('orb', true, 'volley').name === 'ЗАЛП СФЕР' && /ЩИТ/.test(telegraphCounter('orb', true, 'volley').counter), 'залп');
  assert(telegraphCounter('slam', false, 'trap').name === 'КАМЕННЫЙ КАПКАН' && /РЫВОК/.test(telegraphCounter('slam', false, 'trap').counter), 'капкан');
  assert(telegraphCounter('slam', false, 'double').name === 'ДВОЙНОЙ УДАР', 'двойной');
  assert(telegraphCounter('slam', false).name === 'УДАР ЛАДОНЬЮ' && telegraphCounter('slam', false).counter === 'РЫВОК — уйди из круга', 'прежние подписи');
  void DEFAULT_BOSS_CONFIG;
});

let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  const s = Date.now();
  try { t.fn(); console.log(`PASS  ${t.name}  (${Date.now() - s} ms)`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed, ${Date.now() - t0} ms`);
if (failed && typeof process !== 'undefined') process.exitCode = 1;
