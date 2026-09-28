/*
 * ASHEN OATH — boss.test.js (роль №5). Исполнимые тесты boss.js.
 * Node 22.12+:  node boss.test.js      (ESM-синтаксис в .js определяется автоматически)
 * Браузер:      открыть boss.test.html через localhost (результат на странице и в консоли).
 *
 * Внутри — минимальный эталонный combat, который исполняет контракт ASHEN_V1 буквально:
 * brain.update(dt, снимок) -> телеграфы из attacks (remaining = windup) -> remaining -= dt
 * в том же кадре -> удар при remaining <= BOSS_TIME_EPSILON. Это модель для проверки
 * согласованности, а не настоящий combat.js №4.
 */
import {
  createBossBrain, describeBossBalance, DEFAULT_BOSS_CONFIG,
  BOSS_API_VERSION, BOSS_TIME_EPSILON,
} from './boss.js';

const EPS = BOSS_TIME_EPSILON;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const DT = {
  '30fps': () => () => 1 / 30,
  '60fps': () => () => 1 / 60,
  '144fps': () => () => 1 / 144,
  '1000Hz': () => () => 1 / 1000,
  'jitter 4..100ms': () => { const r = lcg(99); return () => 0.004 + r() * 0.096; },
  'spiky 5/90ms': () => { let i = 0; return () => (i++ % 2 ? 0.09 : 0.005); },
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

function playerAt(t) {
  const a = 0.9 * Math.sin(0.37 * t);
  return { x: 6 * Math.sin(a), y: 0, z: 6 * Math.cos(a) };
}

function makeSnapshot(t, o, state) {
  return {
    status: o.statusAt ? o.statusAt(t) : 'playing',
    time: t,
    player: {
      position: playerAt(t), yaw: 0,
      hp: o.playerHpAt ? o.playerHpAt(t) : 100, maxHp: 100,
      energy: o.energyAt ? o.energyAt(t) : 100, maxEnergy: 100,
      action: 'move', invulnerable: false, shielding: false,
    },
    boss: {
      position: { x: 0, y: 0, z: 0 }, yaw: 0,
      hp: o.hpAt ? o.hpAt(t) : 1000, maxHp: 1000,
      stage: state.stage, action: state.action,
    },
    cooldowns: { dashRemaining: o.dashAt ? o.dashAt(t) : 0, dashTotal: 1.2, burstRemaining: 0, burstTotal: 8 },
    projectiles: [],
    telegraphs: state.tele.map((tg) => ({
      id: tg.id, kind: tg.kind, origin: tg.spec.origin, target: tg.spec.target,
      radius: tg.spec.radius, remaining: tg.remaining, duration: tg.duration, blockable: tg.spec.blockable,
    })),
    stats: { damageDealt: 0, damageTaken: 0, dodges: 0, blocks: 0 },
  };
}

function simulate(o) {
  const brain = o.brain || createBossBrain(Object.assign({ seed: o.seed ?? 7 }, o.config || {}));
  const dtFn = (o.dt || DT['60fps'])();
  const duration = o.duration ?? 120;
  const tele = [];
  const state = { stage: 1, action: 'idle', tele };
  const log = { specs: [], impacts: [], frames: [], mismatches: [], stageChanges: 0, maxActive: 0, mutated: false, brain };
  let t = 0;
  let frame = 0;
  while (t < duration - 1e-9) {
    const dt = dtFn(frame);
    const snap = makeSnapshot(t, o, state);
    const before = o.checkMutation ? JSON.stringify(snap) : null;
    if (o.freeze) deepFreeze(snap);
    const d = brain.update(dt, snap);
    if (before !== null && JSON.stringify(snap) !== before) log.mutated = true;
    if (d.stageChanged) log.stageChanges += 1;
    if (d.action === 'dead') tele.length = 0; // combat обязан снять телеграфы мёртвого босса
    for (const a of d.attacks) {
      log.specs.push({ t, frame, spec: clone(a), ref: a, player: clone(snap.player.position), stage: d.stage });
      tele.push({ id: a.id, kind: a.kind, remaining: a.windup, duration: a.windup, emittedFrame: frame, spec: a });
    }
    log.maxActive = Math.max(log.maxActive, tele.length);
    const tEnd = t + dt;
    const resolvedNow = [];
    for (let i = tele.length - 1; i >= 0; i--) {
      const tg = tele[i];
      tg.remaining -= dt;
      if (tg.remaining <= EPS) {
        const emitted = log.specs.find((s) => s.spec.id === tg.id);
        log.impacts.push({
          id: tg.id, kind: tg.kind, t: tEnd, frame, action: d.action,
          flagged: d.impactIds.includes(tg.id),
          specIntact: JSON.stringify(tg.spec) === JSON.stringify(emitted.spec),
          stage: d.stage,
        });
        resolvedNow.push(tg.id);
        tele.splice(i, 1);
        if (d.action !== 'attack') log.mismatches.push({ frame, id: tg.id, why: 'combat impact, brain action=' + d.action });
      } else if (d.action !== 'windup') {
        log.mismatches.push({ frame, id: tg.id, why: 'telegraph active, brain action=' + d.action });
      }
    }
    for (const id of d.impactIds) {
      if (!resolvedNow.includes(id)) log.mismatches.push({ frame, id, why: 'brain impact without combat impact' });
    }
    log.frames.push({ frame, t, dt, action: d.action, pose: d.pose, stage: d.stage, n: d.attacks.length, kind: d.kind, aim: d.aim, impactIds: d.impactIds.slice() });
    state.stage = d.stage;
    state.action = d.action;
    t = tEnd;
    frame += 1;
  }
  return log;
}

const kindsOf = (log) => log.specs.map((s) => s.spec.kind);
const idsOf = (log) => log.specs.map((s) => s.spec.id);

// ----------------------------------------------------------------------------

export function runBossTests() {
  const results = [];
  const lines = [];
  const say = (s) => lines.push(s);
  function test(name, fn) {
    try {
      const note = fn();
      results.push({ name, ok: true, note: note || '' });
    } catch (e) {
      results.push({ name, ok: false, note: e && e.message ? e.message : String(e) });
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg); }

  const hpHalfAt = (tc) => (t) => (t < tc ? 1000 : 400);

  test('API: форма createBossBrain / BossDecision / AttackSpec', () => {
    assert(BOSS_API_VERSION === 'ASHEN_V1', 'version');
    const b = createBossBrain({ seed: 1 });
    assert(typeof b.reset === 'function' && typeof b.update === 'function', 'reset/update');
    const log = simulate({ brain: b, duration: 30 });
    const d = b.update(1 / 60, makeSnapshot(0, {}, { stage: 1, action: 'idle', tele: [] }));
    assert([1, 2].includes(d.stage), 'stage');
    assert(['idle', 'windup', 'attack', 'recover', 'dead'].includes(d.action), 'action enum');
    assert(Array.isArray(d.attacks), 'attacks array');
    const s = log.specs[0].spec;
    for (const k of ['id', 'kind', 'origin', 'target', 'windup', 'radius', 'damage', 'blockable', 'projectileSpeed']) {
      assert(k in s, 'AttackSpec.' + k);
    }
    for (const v of [s.origin, s.target]) assert(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), 'vec');
    for (const e of log.specs) {
      const sp = e.spec;
      assert(sp.kind === 'orb' ? sp.projectileSpeed > 0 : sp.projectileSpeed === 0, 'projectileSpeed only for orb');
    }
  });

  test('Знакомство: первые атаки slam → orb → nova, по одной', () => {
    const log = simulate({ duration: 40 });
    const k = kindsOf(log).slice(0, 3).join(',');
    assert(k === 'slam,orb,nova', 'got ' + k);
    assert(log.maxActive <= 1, 'одновременно активно телеграфов: ' + log.maxActive);
    return 'первая атака на t=' + log.specs[0].t.toFixed(3) + ' с';
  });

  test('Детерминизм: одинаковый seed → одинаковая последовательность', () => {
    const o = { seed: 42, duration: 180, hpAt: hpHalfAt(60) };
    const a = simulate(o);
    const b = simulate(o);
    assert(JSON.stringify(a.specs.map((s) => s.spec)) === JSON.stringify(b.specs.map((s) => s.spec)), 'specs differ');
    const base = kindsOf(simulate({ seed: 1, duration: 180, hpAt: hpHalfAt(60) })).join();
    let differs = 0;
    for (const seed of [2, 3, 4, 5, 6]) if (kindsOf(simulate({ seed, duration: 180, hpAt: hpHalfAt(60) })).join() !== base) differs++;
    assert(differs >= 3, 'другие seed почти не меняют порядок: ' + differs + '/5');
    const strA = kindsOf(createBrainRun({ seed: 'ashen' })).join();
    const strB = kindsOf(createBrainRun({ seed: 'ashen' })).join();
    assert(strA === strB, 'string seed');
    return a.specs.length + ' атак; другой seed меняет порядок в ' + differs + '/5';
  });

  function createBrainRun(config) {
    return simulate({ config, seed: undefined, duration: 120, hpAt: hpHalfAt(50) });
  }

  test('Один AttackSpec на атаку, уникальные id, выдача только на входе в windup', () => {
    for (const [name, dt] of Object.entries(DT)) {
      const log = simulate({ dt, duration: 200, hpAt: hpHalfAt(70) });
      const ids = idsOf(log);
      assert(new Set(ids).size === ids.length, name + ': duplicate ids');
      let windupEntries = 0;
      let prev = 'idle';
      for (const f of log.frames) {
        assert(f.n <= 1, name + ': >1 spec in a frame');
        if (f.action === 'windup' && prev !== 'windup') windupEntries++;
        if (f.n === 1) assert(f.action === 'windup' && prev !== 'windup', name + ': spec not on windup entry, frame ' + f.frame);
        if (f.action === 'windup' && prev !== 'windup') assert(f.n === 1, name + ': windup without spec, frame ' + f.frame);
        prev = f.action;
      }
      assert(windupEntries === ids.length, name + ': windups ' + windupEntries + ' vs specs ' + ids.length);
      assert(log.maxActive <= 1, name + ': overlapping telegraphs');
    }
  });

  test('Согласованность windup/attack с эталонным combat при разных dt', () => {
    const notes = [];
    for (const [name, dt] of Object.entries(DT)) {
      const log = simulate({ dt, duration: 200, hpAt: hpHalfAt(70) });
      assert(log.mismatches.length === 0, name + ': ' + JSON.stringify(log.mismatches.slice(0, 3)));
      for (const im of log.impacts) {
        assert(im.action === 'attack' && im.flagged, name + ': impact ' + im.id + ' action=' + im.action + ' flagged=' + im.flagged);
      }
      assert(log.impacts.length >= log.specs.length - 1, name + ': unresolved attacks');
      notes.push(name + ':' + log.impacts.length);
    }
    return 'ударов: ' + notes.join(', ');
  });

  test('Стабильность при разных dt: тот же порядок, ошибка времени ограничена и не копится', () => {
    const ref = simulate({ dt: DT['1000Hz'], duration: 200, hpAt: hpHalfAt(50) });
    const refKinds = kindsOf(ref);
    const refT = ref.impacts.map((i) => i.t);
    const notes = [];
    for (const name of ['30fps', '60fps', '144fps', 'jitter 4..100ms', 'spiky 5/90ms']) {
      const log = simulate({ dt: DT[name], duration: 200, hpAt: hpHalfAt(50) });
      const n = Math.min(refKinds.length, log.specs.length) - 1;
      assert(n > 30, 'too few attacks');
      assert(kindsOf(log).slice(0, n).join() === refKinds.slice(0, n).join(), name + ': порядок атак отличается');
      const maxDt = Math.max(...log.frames.map((f) => f.dt));
      let worst = 0;
      let worstLast = 0;
      const m = Math.min(refT.length, log.impacts.length) - 1;
      for (let i = 0; i < m; i++) {
        const e = Math.abs(log.impacts[i].t - refT[i]);
        worst = Math.max(worst, e);
        if (i >= m - 10) worstLast = Math.max(worstLast, e);
      }
      assert(worst <= 3 * maxDt + 0.005, name + ': drift ' + worst.toFixed(4) + ' > ' + (3 * maxDt).toFixed(4));
      notes.push(name + ': макс. ' + (worst * 1000).toFixed(0) + ' мс, на последних 10 из ' + m + ' — ' + (worstLast * 1000).toFixed(0) + ' мс');
    }
    return notes.join('; ');
  });

  test('Ровно один переход в стадию 2, в т.ч. при колебаниях HP', () => {
    const hp = (t) => (t < 30 ? 1000 : t < 40 ? 499 : t < 50 ? 1000 : t < 60 ? 300 : 900);
    const log = simulate({ duration: 150, hpAt: hp });
    assert(log.stageChanges === 1, 'stageChanged count ' + log.stageChanges);
    const shiftEntries = log.frames.filter((f, i) => f.pose === 'shift' && (i === 0 || log.frames[i - 1].pose !== 'shift')).length;
    assert(shiftEntries === 1, 'shift entries ' + shiftEntries);
    const first2 = log.frames.findIndex((f) => f.stage === 2);
    assert(first2 > 0 && log.frames.slice(first2).every((f) => f.stage === 2), 'stage regressed');
    const tShift = log.frames[first2].t;
    assert(tShift >= 30 && tShift < 30 + 3, 'shift late: ' + tShift);
    const firstStage2Spec = log.specs.find((s) => s.stage === 2);
    assert(firstStage2Spec && firstStage2Spec.spec.kind === 'slam', 'stage2 opener');
    assert(log.brain.getDebug().shifts === 1, 'debug shifts');
    return 'смена стойки на t=' + tShift.toFixed(3);
  });

  test('HP падает во время windup: объявленная атака не отменяется, затем смена стойки', () => {
    const probe = simulate({ duration: 40 });
    const s = probe.specs[1]; // orb
    const tc = s.t + 0.4;
    const log = simulate({ duration: 40, hpAt: hpHalfAt(tc) });
    const im = log.impacts.find((i) => i.id === s.spec.id);
    assert(im && im.action === 'attack', 'атака во время перехода не исполнена');
    const after = log.frames.filter((f) => f.t >= im.t - 1e-9).map((f) => f.pose);
    const seq = after.filter((p, i) => i === 0 || p !== after[i - 1]).slice(0, 3).join('>');
    assert(seq === 'attack>shift>idle', 'sequence ' + seq);
    assert(log.stageChanges === 1, 'stage changes');
    return seq;
  });

  test('Смерть: action dead, пустые attacks навсегда (даже если HP вернулось)', () => {
    for (const tDeath of [11.3, 13.9, 17.2]) {
      const hp = (t) => (t < tDeath ? 800 : t < tDeath + 5 ? 0 : 1000);
      const log = simulate({ duration: 60, hpAt: hp });
      const after = log.frames.filter((f) => f.t >= tDeath);
      assert(after.length > 0 && after.every((f) => f.action === 'dead' && f.n === 0 && f.impactIds.length === 0), 'dead violated at ' + tDeath);
      assert(log.specs.every((s) => s.t < tDeath), 'spec after death');
    }
    const v = simulate({ duration: 30, statusAt: (t) => (t < 12 ? 'playing' : 'victory') });
    assert(v.frames.filter((f) => f.t >= 12).every((f) => f.action === 'dead' && f.n === 0), 'victory status');
  });

  test('Поражение игрока: новые атаки не выдаются', () => {
    const log = simulate({ duration: 60, playerHpAt: (t) => (t < 20 ? 100 : 0) });
    assert(log.specs.every((s) => s.t < 20), 'spec after defeat');
    const log2 = simulate({ duration: 60, statusAt: (t) => (t < 20 ? 'playing' : 'defeat') });
    assert(log2.specs.every((s) => s.t < 20), 'spec after defeat status');
  });

  test('reset: сброс id, фазы, стадии, выбора атак и времени', () => {
    const b = createBossBrain({ seed: 9 });
    const fresh = simulate({ brain: createBossBrain({ seed: 9 }), duration: 120, hpAt: hpHalfAt(40) });
    simulate({ brain: b, duration: 90, hpAt: hpHalfAt(20) });
    assert(b.getDebug().stage === 2 && b.getDebug().idCounter > 5, 'precondition');
    b.reset();
    const dbg = b.getDebug();
    assert(dbg.phase === 'idle' && dbg.stage === 1 && dbg.clock === 0 && dbg.idCounter === 0 && dbg.currentAttackId === null && dbg.history.length === 0, 'state after reset ' + JSON.stringify(dbg));
    const again = simulate({ brain: b, duration: 120, hpAt: hpHalfAt(40) });
    assert(JSON.stringify(again.specs.map((s) => s.spec)) === JSON.stringify(fresh.specs.map((s) => s.spec)), 'sequence after reset differs');
    assert(again.specs[0].spec.id === 'boss-1-slam', 'first id ' + again.specs[0].spec.id);
    // reset посреди windup
    const c = createBossBrain({ seed: 9 });
    const mid = simulate({ brain: c, duration: 3.0 });
    assert(mid.frames[mid.frames.length - 1].action === 'windup', 'precondition windup');
    c.reset();
    const d = c.update(1 / 60, makeSnapshot(0, {}, { stage: 1, action: 'idle', tele: [] }));
    assert(d.action === 'idle' && d.attacks.length === 0 && d.impactIds.length === 0, 'reset mid-windup');
  });

  test('NOVA не выдаётся, когда у игрока нет ни энергии, ни рывка', () => {
    const noCounter = { energyAt: () => 0, dashAt: () => 5 };
    const log = simulate(Object.assign({ duration: 200, hpAt: hpHalfAt(80) }, noCounter));
    assert(!kindsOf(log).includes('nova'), 'nova issued without counterplay');
    const k = kindsOf(log).slice(0, 4).join(',');
    const restored = simulate({ duration: 60, energyAt: (t) => (t < 20 ? 0 : 100), dashAt: (t) => (t < 20 ? 5 : 0) });
    const firstNova = restored.specs.find((s) => s.spec.kind === 'nova');
    assert(firstNova && firstNova.t >= 20 && firstNova.t < 20 + 8, 'nova did not return after recovery');
    const dashOnly = simulate({ duration: 40, energyAt: () => 0, dashAt: () => 0 });
    assert(kindsOf(dashOnly).includes('nova'), 'dash-only counter should allow nova');
    return 'без контригры порядок начинается ' + k + '; nova вернулась на t=' + firstNova.t.toFixed(2);
  });

  test('После каждого удара есть recover; нет бесконечного давления', () => {
    const b = createBossBrain({ seed: 7 });
    const cfg = b.getConfig();
    const log = simulate({ brain: b, duration: 200, hpAt: hpHalfAt(70) });
    let minGap = Infinity;
    for (let i = 0; i < log.impacts.length; i++) {
      const im = log.impacts[i];
      const next = log.specs.find((s) => s.frame > im.frame);
      if (!next) continue;
      const between = log.frames.filter((f) => f.frame > im.frame && f.frame < next.frame);
      assert(between.some((f) => f.action === 'recover'), 'no recover after ' + im.id);
      const a = cfg.attacks[im.kind];
      const need = a.attack + a.recover[im.stage - 1];
      const gap = next.t - im.t;
      minGap = Math.min(minGap, gap);
      assert(gap >= need - 1e-6, im.id + ': gap ' + gap.toFixed(3) + ' < ' + need);
    }
    return 'мин. пауза между ударом и следующим замахом ' + minGap.toFixed(2) + ' с';
  });

  test('Порядок: нет nova подряд, нет трёх одинаковых атак подряд (20 seed)', () => {
    let total = 0;
    const counts = { slam: 0, orb: 0, nova: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const k = kindsOf(simulate({ seed, duration: 300, hpAt: hpHalfAt(60) }));
      for (let i = 0; i < k.length; i++) {
        counts[k[i]]++;
        if (i >= 1) assert(!(k[i] === 'nova' && k[i - 1] === 'nova'), 'nova twice, seed ' + seed);
        if (i >= 2) assert(!(k[i] === k[i - 1] && k[i] === k[i - 2]), 'triple ' + k[i] + ', seed ' + seed);
      }
      total += k.length;
    }
    return total + ' атак: slam ' + counts.slam + ', orb ' + counts.orb + ', nova ' + counts.nova;
  });

  test('Цель фиксируется при объявлении и не меняется до удара', () => {
    const log = simulate({ duration: 200, hpAt: hpHalfAt(70) });
    for (const s of log.specs) {
      const p = s.player;
      if (s.spec.kind === 'slam') {
        assert(Math.abs(s.spec.target.x - p.x) < 1e-9 && Math.abs(s.spec.target.z - p.z) < 1e-9 && s.spec.target.y === 0, 'slam target');
      }
      if (s.spec.kind === 'orb') {
        assert(Math.abs(s.spec.target.x - p.x) < 1e-9 && Math.abs(s.spec.target.z - p.z) < 1e-9, 'orb target');
        assert(s.spec.origin.y > 0.5, 'orb origin height');
      }
      if (s.spec.kind === 'nova') {
        assert(s.spec.target.x === s.spec.origin.x && s.spec.target.z === s.spec.origin.z, 'nova centered');
      }
    }
    assert(log.impacts.every((i) => i.specIntact), 'brain mutated an issued spec');
    // aim неизменен на протяжении windup
    for (const s of log.specs) {
      const im = log.impacts.find((i) => i.id === s.spec.id);
      if (!im) continue;
      const frames = log.frames.filter((f) => f.frame >= s.frame && f.frame <= im.frame);
      const a0 = JSON.stringify(frames[0].aim);
      assert(a0 !== 'null', 'no aim during windup ' + s.spec.id);
      assert(frames.every((f) => JSON.stringify(f.aim) === a0), 'aim moved during windup ' + s.spec.id);
    }
  });

  test('Нижняя граница windup (запас на CV + реакцию) не обходится конфигом', () => {
    const fast = { attacks: { slam: { windup: 0.2 }, orb: { windup: [0.1, 0.1] }, nova: { windup: 0.3 } } };
    const b = createBossBrain(fast);
    const floor = b.getConfig().windupFloor;
    assert(floor >= 0.99, 'floor ' + floor);
    const log = simulate({ brain: b, duration: 120, hpAt: hpHalfAt(40) });
    assert(log.specs.every((s) => s.spec.windup >= floor - 1e-12), 'windup below floor');
    const def = simulate({ duration: 200, hpAt: hpHalfAt(60) });
    assert(def.specs.every((s) => s.spec.windup >= 1.0), 'default windup below 1.0');
    return 'floor = ' + floor.toFixed(2) + ' с';
  });

  test('Снимок не изменяется (deep-freeze + сравнение JSON)', () => {
    const log = simulate({ duration: 90, hpAt: hpHalfAt(30), freeze: true });
    const log2 = simulate({ duration: 60, hpAt: hpHalfAt(30), checkMutation: true });
    assert(!log2.mutated, 'snapshot mutated');
    assert(log.specs.length > 5, 'run too short');
    // возвращаемые объекты не делят ссылки со снимком
    const snap = makeSnapshot(3, {}, { stage: 1, action: 'idle', tele: [] });
    const b = createBossBrain({ openingDelay: 0 });
    const d = b.update(1 / 60, snap);
    assert(d.attacks[0].target !== snap.player.position && d.attacks[0].origin !== snap.boss.position, 'shared references');
  });

  test('Нет Math.random / Date.now / performance.now внутри логики', () => {
    const saved = { r: Math.random, d: Date.now };
    const perf = typeof performance !== 'undefined' ? performance : null;
    const savedNow = perf ? perf.now : null;
    const boom = () => { throw new Error('forbidden clock/random call'); };
    Math.random = boom; Date.now = boom;
    if (perf) { try { perf.now = boom; } catch (e) { /* read-only в некоторых средах */ } }
    try {
      simulate({ duration: 120, hpAt: hpHalfAt(40), dt: DT['jitter 4..100ms'] });
    } finally {
      Math.random = saved.r; Date.now = saved.d;
      if (perf) { try { perf.now = savedNow; } catch (e) { /* ignore */ } }
    }
  });

  test('Пауза: без вызовов update ничего не происходит; большой dt ограничен', () => {
    const b = createBossBrain({ seed: 3 });
    simulate({ brain: b, duration: 3.0 });
    const d0 = b.getDebug();
    // «пауза»: вызовов нет — состояние неизменно
    const d1 = b.getDebug();
    assert(JSON.stringify(d0) === JSON.stringify(d1), 'state changed without update');
    const snap = makeSnapshot(3, {}, { stage: 1, action: 'windup', tele: [] });
    b.update(30, snap); // пропущенная вкладка: сборщик должен сам ограничить dt, мозг — страховка
    const d2 = b.getDebug();
    assert(Math.abs(d2.clock - d0.clock - b.getConfig().maxDt) < 1e-9, 'dt not clamped');
  });

  test('Устойчивость к мусору: NaN/отрицательный dt, пустой снимок', () => {
    const b = createBossBrain();
    for (const dt of [NaN, -1, Infinity, undefined, 0]) {
      const d = b.update(dt, makeSnapshot(0, {}, { stage: 1, action: 'idle', tele: [] }));
      assert(d.attacks.length === 0 && d.action === 'idle', 'bad dt ' + dt);
    }
    assert(b.getDebug().clock === 0, 'garbage dt advanced time');
    for (const s of [null, undefined, 5, {}]) {
      const d = b.update(1 / 60, s);
      assert(d && Array.isArray(d.attacks), 'bad snapshot ' + s);
    }
    const nullSnap = createBossBrain({ openingDelay: 0 });
    assert(nullSnap.update(1, null).attacks.length === 0, 'attack from null snapshot');
    const weird = createBossBrain({ attacks: 'x', bag: { stage1: { slam: 0, orb: 0, nova: 0 } }, seed: -5, intro: ['nope'] });
    const log = simulate({ brain: weird, duration: 60 });
    assert(log.specs.length > 3, 'bad config broke brain');
    const nested = createBossBrain({ seed: 11, boss: { openingDelay: 0.5 } });
    assert(nested.getConfig().openingDelay === 0.5 && nested.getConfig().seed === 11, 'nested config.boss');
  });

  // ---- отчёт ----
  const bal = describeBossBalance(DEFAULT_BOSS_CONFIG);
  say('ASHEN_V1 boss.js — таблица начального баланса (предложение, не доказанная настройка)');
  say('Допущение: реакция CV+человек = ' + bal.reactionAssumed + ' с; нижняя граница windup = ' + bal.windupFloor.toFixed(2) + ' с');
  say(pad('ст', 3) + pad('атака', 6) + pad('windup', 7) + pad('attack', 7) + pad('recover', 8) + pad('idle', 5) + pad('окно', 6) + pad('урон', 5) + pad('радиус', 7) + pad('блок', 5) + 'контригра / заметка');
  for (const r of bal.rows) {
    say(pad(r.stage, 3) + pad(r.kind, 6) + pad(f2(r.windup), 7) + pad(f2(r.attack), 7) + pad(f2(r.recover), 8) + pad(f2(r.idle), 5) + pad(f2(r.punishWindow), 6) + pad(r.damage, 5) + pad(f2(r.radius), 7) + pad(r.blockable ? 'да' : 'нет', 5) + r.counter + '; ' + r.note);
  }
  say('');
  let passed = 0;
  for (const r of results) {
    if (r.ok) passed++;
    say((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.note ? '  — ' + r.note : ''));
  }
  say('');
  say('Итого: ' + passed + '/' + results.length + ' пройдено');
  const text = lines.join('\n');
  return { passed, total: results.length, results, text };
}

function f2(v) {
  return Number(v).toFixed(2);
}

function pad(v, n) {
  const s = String(v);
  return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

if (typeof window === 'undefined') {
  const r = runBossTests();
  console.log(r.text);
  if (typeof process !== 'undefined' && r.passed !== r.total) process.exitCode = 1;
}
