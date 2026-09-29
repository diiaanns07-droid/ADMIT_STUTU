// =============================================================================
// pvp.test.mjs — [PVP] №3: дуэль игрок против игрока. Node 22+:  node dev/pvp.test.mjs [--duels 200] [--quick]
// 1) юнит-тесты попаданий и защиты (рывок, щит, парирование, оберег, бастион, повторы, кап урона, fx);
// 2) раунды: отсчёт → бой → конец раунда → матч до 2 побед, обрыв сети → техническая победа, реванш;
// 3) баланс: 200 дуэлей ботов разных стилей через настоящие сессии и сеть с задержкой —
//    средняя длительность боя 45–90 с, ни один стиль не выигрывает больше 65%, ни одного удара > 18% HP.
// =============================================================================
import { createCombat, DEFAULT_COMBAT_CONFIG } from '../modules/combat.js';
import { createPvpSession, createMemoryNetPair, mergePvpConfig, buildHooks, createRemoteBuffer, resolveSpawns } from '../modules/pvp.js';
import { config as gameConfig } from '../config.js';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const QUICK = argv.includes('--quick');
const DUELS = Number(argOf('--duels', QUICK ? 40 : 200));
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e && e.message ? e.message : String(e) }); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assert'); }
function near(a, b, eps, msg) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg || 'near'}: ${a} ≠ ${b} ±${eps}`); }
const idleBrain = () => ({ reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } });

// ------------------------------------------------------------ стенд: две сессии, сеть в памяти
function makeDuel(opts = {}) {
  let T = 0;
  const clock = () => T;
  const pair = createMemoryNetPair({ latencyMs: opts.latency ?? 40, jitterMs: opts.jitter ?? 10, seed: opts.seed || 7, clock });
  const cfg = { ...(gameConfig.pvp || {}), ...(opts.cfg || {}) };
  const A = createCombat({ config: {}, bossBrain: idleBrain() });
  const B = createCombat({ config: {}, bossBrain: idleBrain() });
  const coach = () => ({ accuracy: 0.8 });
  const sA = createPvpSession({ combat: A, net: pair.a, clock, cfg, me: { name: 'A' }, coach });
  const sB = createPvpSession({ combat: B, net: pair.b, clock, cfg, me: { name: 'B' }, coach });
  sA.start(); sB.start();
  const evA = [], evB = [];
  const D = {
    A, B, sA, sB, pair, evA, evB, clock, get T() { return T; },
    pausedB: false,        // true — B «на паузе»: бой B не шагает, но кадр сессии (сеть, фазы) идёт, как в main.js
    step(dt, inA, inB) {
      T += dt * 1000;
      pair.pump();
      for (const [s, c, input, ev] of [[sA, A, inA, evA], [sB, B, inB, evB]]) {
        if (s === sB && D.pausedB) { s.frame(); continue; }
        const gi = s.beforeUpdate(input || { valid: true, source: 'test', moveX: 0, moveZ: 0 });
        c.update(dt, gi);
        const out = s.afterUpdate(c.drainEvents());
        s.frame();
        if (opts.keepEvents !== false) for (const e of out) ev.push(e);
      }
    },
    run(sec, fa, fb, dt = 1 / 60) { const n = Math.round(sec / dt); for (let i = 0; i < n; i++) D.step(dt, fa && fa(D), fb && fb(D)); },
    untilPhase(ph, maxSec = 20) { for (let i = 0; i < maxSec * 60; i++) { if (sA.phase === ph && sB.phase === ph) return true; D.step(1 / 60); } return false; },
  };
  return D;
}
const inp = (extra) => ({ valid: true, source: 'test', moveX: 0, moveZ: 0, ...extra });
const type = (ev, t) => ev.filter((e) => e.type === t);

// ------------------------------------------------------------ 1. юнит-тесты
test('режим pvp: снимок mode/opponent/lockTarget, Регент не думает, HP 400', () => {
  const D = makeDuel();
  assert(D.untilPhase('fight', 10), 'бой не начался');
  const s = D.A.getSnapshot();
  assert(s.mode === 'pvp', 'mode');
  assert(s.player.maxHp === 400 && s.player.hp === 400, `HP ${s.player.hp}/${s.player.maxHp}`);
  assert(s.opponent && s.opponent.name === 'B', 'opponent');
  assert(s.lockTarget && s.lockTarget.kind === 'player', 'lockTarget.kind');
  near(s.lockTarget.position.z, -12, 0.3, 'цель — точка соперника');
  near(s.player.position.z, 12, 0.01, 'спаун хоста');
  assert(s.player.lockedOn && s.player.encounter === 'engaged', 'engaged: соперник ближе 35 м');
  assert(s.boss.pvp === true && s.boss.hp > 0, 'зеркало соперника в snap.boss');
  assert(D.A.getDebugInfo().brainCalls === 0, 'мозг Регента не вызывается');
});

test('бой с боссом не изменился: setMode(boss) возвращает конфиг и снимок', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  const s0 = c.getSnapshot();
  assert(s0.mode === 'boss' && s0.opponent === null && s0.lockTarget.kind === 'boss', 'boss snap');
  const s = createPvpSession({ combat: c, net: createMemoryNetPair().a, clock: () => 0 });
  s.start(); assert(c.getMode() === 'pvp' && c.getEffectiveConfig().player.maxHp === 400, 'pvp on');
  s.stop();
  const cfg = c.getEffectiveConfig();
  assert(c.getMode() === 'boss', 'mode boss');
  assert(cfg.player.maxHp === DEFAULT_COMBAT_CONFIG.player.maxHp, `maxHp ${cfg.player.maxHp}`);
  assert(cfg.boss.hitRadius === DEFAULT_COMBAT_CONFIG.boss.hitRadius && cfg.boss.height === DEFAULT_COMBAT_CONFIG.boss.height, 'boss hitbox restored');
  assert(cfg.spark.cooldown === DEFAULT_COMBAT_CONFIG.spark.cooldown && cfg.runes.orbis.heal === DEFAULT_COMBAT_CONFIG.runes.orbis.heal, 'overrides restored');
  const s1 = c.getSnapshot();
  assert(s1.mode === 'boss' && s1.boss.position.x === 0 && s1.boss.position.z === 0 && s1.player.hp === 100, 'boss snapshot back');
});

test('искра попадает: hit → hitAck → boss_hit у атакующего, player_hit у жертвы', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1.6);
  D.step(1 / 60, inp({ spark: true }));
  D.run(1.5);
  const ph = type(D.evB, 'player_hit'), bh = type(D.evA, 'boss_hit');
  assert(ph.length === 1 && bh.length === 1, `hits ${ph.length}/${bh.length}`);
  near(ph[0].data.amount, DEFAULT_COMBAT_CONFIG.spark.damage * mergePvpConfig().dmg.spark, 0.2, 'урон искры');
  assert(bh[0].data.pvp && bh[0].data.target === 'opponent', 'boss_hit pvp');
  near(D.B.getSnapshot().player.hp, 400 - ph[0].data.amount, 0.01, 'HP жертвы');
  near(D.A.getSnapshot().stats.damageDealt, ph[0].data.amount, 0.01, 'damageDealt');
});

test('поляна ниже нуля (лес, y = −2.2): искра и сфера долетают', () => {
  const layout = { arena: { x: 0, z: 0, r: 13 }, colliders: [], groundY: () => -2.2, isWalkable: () => true, playerSpawn: { x: 0, z: 6 } };
  let T = 0; const clock = () => T;
  const pair = createMemoryNetPair({ latencyMs: 30, clock });
  const A = createCombat({ config: {}, bossBrain: idleBrain(), layout }), B = createCombat({ config: {}, bossBrain: idleBrain(), layout });
  const sA = createPvpSession({ combat: A, net: pair.a, clock }), sB = createPvpSession({ combat: B, net: pair.b, clock });
  sA.start(); sB.start();
  const ev = [];
  const step = (ia) => { T += 1000 / 60; pair.pump(); for (const [s, c, i] of [[sA, A, ia], [sB, B, null]]) { c.update(1 / 60, s.beforeUpdate(i || inp())); for (const e of s.afterUpdate(c.drainEvents())) ev.push(e); s.frame(); } };
  for (let i = 0; i < 60 * 6 && sA.phase !== 'fight'; i++) step();
  for (let i = 0; i < 100; i++) step();
  near(A.getSnapshot().player.position.y, -2.2, 1e-9, 'герой на поляне');
  step(inp({ spark: true })); for (let i = 0; i < 90; i++) step();
  step(inp({ throw: { kind: 'orb', size: 0.6, power: 0.8, aimX: 0 } })); for (let i = 0; i < 150; i++) step();
  const hits = ev.filter((e) => e.type === 'player_hit').map((e) => e.data.attackKind);
  assert(hits.includes('spark') && hits.includes('sphere'), `попадания: ${hits}`);
});

test('лук №6 (registerTarget): ледяная стрела бьёт соперника, fx замедления уходит в hit, Регент не цель', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1.7);
  if (!D.A.hand) return;                              // модуль лука не подключён — нечего проверять
  const bowIn = (o = {}) => inp({ bow: { active: true, phase: 'drawing', draw: 0, aimX: 0, aimY: 0, charged: false, release: false, element: null, ...o } });
  D.step(1 / 60, bowIn({ draw: 0 })); D.step(1 / 60, bowIn({ draw: 0 }));
  for (let k = 1; k <= 12; k++) D.step(1 / 60, bowIn({ draw: k / 12, charged: k === 12, element: 'frost' }));
  D.step(1 / 60, bowIn({ draw: 1, charged: true, release: true, element: 'frost' }));
  D.run(2.5, () => bowIn({ phase: 'ready', draw: 0 }));
  const hits = type(D.evB, 'player_hit').filter((e) => e.data.attackKind === 'arrow');
  assert(hits.length >= 1, `стрела не попала: ${JSON.stringify(type(D.evB, 'player_hit').map((e) => e.data.attackKind))}`);
  assert(hits[0].data.fx && hits[0].data.fx.slow > 0, `нет замедления: ${JSON.stringify(hits[0].data.fx)}`);
  assert(D.A.getSnapshot().boss.hp > 0 && !type(D.evA, 'boss_hit').some((e) => !e.data.pvp), 'Регент получил урон в дуэли');
  assert(hits[0].data.amount <= 72, 'кап');
});

test('неуязвимость 1,5 с после появления', () => {
  const D = makeDuel();
  D.untilPhase('fight');
  D.step(1 / 60, inp({ spark: true }));
  D.run(1.2);
  assert(type(D.evB, 'player_hit').length === 0, 'удар прошёл сквозь неуязвимость');
  const den = type(D.evA, 'pvp_hit_denied');
  assert(den.length === 1 && den[0].data.reason === 'invulnerable', `denied ${JSON.stringify(den.map((e) => e.data))}`);
  assert(D.B.getSnapshot().player.invulnerable, 'snapshot invulnerable');
});

// прямые вызовы applyRemoteHit — без сети
function victim(opts = {}) {
  let T = 1000;
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  let H = null;
  const PC = mergePvpConfig({ ...(gameConfig.pvp || {}), ...(opts.cfg || {}) });
  c.attachPvp((K) => (H = buildHooks(K, PC, { clock: () => T })));
  c.setMode('pvp');
  H.setOpponent({ position: { x: 0, y: 0, z: -12 }, velocity: { x: 0, z: 0 }, hp: 400, maxHp: 400 });
  H.respawn({ x: 0, z: 12, yaw: Math.PI });
  H.setFrozen(false); H.setAcceptHits(true);
  const V = {
    c, H, PC, get T() { return T; },
    tick(sec, input) { const n = Math.round(sec * 120); for (let i = 0; i < n; i++) { T += 1000 / 120; c.update(1 / 120, input || inp()); } },
    hit(id, dmg, kind = 'spark', fx) { return c.applyRemoteHit({ id, dmg, kind, fx, from: { x: 0, y: 0, z: -12 }, dir: { x: 0, z: 1 } }); },
    snap() { return c.getSnapshot(); }, ev() { return c.drainEvents(); },
  };
  return V;
}

test('повтор hit с тем же id отсекается', () => {
  const V = victim();
  const r1 = V.hit('x1', 10), r2 = V.hit('x1', 10);
  assert(r1.applied && !r2.applied && r2.reason === 'duplicate', JSON.stringify([r1, r2]));
  near(V.snap().player.hp, 390, 0.01, 'один раз');
});

test('ваншотов нет: удар ≤ 18% HP (72)', () => {
  const V = victim();
  const r = V.hit('big', 500, 'ignis');
  assert(r.applied, 'applied');
  near(r.amount, 72, 0.01, 'кап урона');
});

test('рывок: i-кадры и буфер 150 мс после их конца', () => {
  const V = victim();
  V.tick(0.05, inp({ dashDir: { x: 1, z: 0 } }));
  const r1 = V.hit('d1', 20);
  assert(!r1.applied && r1.reason === 'dodge', `во время рывка: ${JSON.stringify(r1)}`);
  V.tick(0.3);                                   // i-кадры 0.28 с кончились ~0.07 с назад
  const r2 = V.hit('d2', 20);
  assert(!r2.applied && r2.reason === 'dodge', `в буфере: ${JSON.stringify(r2)}`);
  V.tick(0.3);                                   // теперь ~0.37 с после конца
  const r3 = V.hit('d3', 20);
  assert(r3.applied, `после буфера удар проходит: ${JSON.stringify(r3)}`);
  assert(V.ev().some((e) => e.type === 'dodge' && e.data.pvp), 'событие dodge');
});

test('буфер учитывает ½ RTT: защита, снятая ≤ 150 мс + ½ RTT назад, ещё спасает', () => {
  const V = victim();
  V.H.setPing(200);                              // ½ RTT = 100 мс
  V.tick(0.05, inp({ dashDir: { x: 1, z: 0 } }));
  V.tick(0.43);                                  // конец i-кадров ~0.2 с назад: 0.1 + 0.15 = 0.25 окно
  const r = V.hit('lag1', 20);
  assert(!r.applied && r.reason === 'dodge', JSON.stringify(r));
  V.tick(0.2);
  assert(V.hit('lag2', 20).applied, 'дальше окна — попадание');
});

test('щит: блок тратит энергию; нет энергии — щит ломается, половина урона', () => {
  const V = victim();
  V.tick(0.1, inp({ shield: true }));
  const e0 = V.snap().player.energy;
  const r = V.hit('s1', 20, 'spark');
  assert(!r.applied && r.reason === 'block', JSON.stringify(r));
  const cost = V.PC.shield.blockBase + V.PC.shield.blockPerDmg * 20;
  near(V.snap().player.energy, e0 - cost, 0.2, 'расход энергии');
  V.c.getSnapshot();
  V.tick(1.5, inp({ shield: true }));            // щит тянет энергию
  const P = V.snap().player;
  assert(P.shielding || P.energy < cost, 'щит держится или энергия кончилась');
  // выжечь энергию до нуля ударами
  let broke = null;
  for (let i = 0; i < 20 && !broke; i++) { const x = V.hit(`s-${i}`, 30, 'spark'); if (x.applied) broke = x; V.tick(0.02, inp({ shield: true })); }
  assert(broke && near(broke.amount, 15, 0.01, 'половина урона') === undefined, `щит не сломался: ${JSON.stringify(broke)}`);
});

test('щит не держит «Стеллу» и «Хлопок»', () => {
  const V = victim();
  V.tick(0.1, inp({ shield: true }));
  assert(V.hit('u1', 10, 'stella').applied, 'stella');
  assert(V.hit('u2', 10, 'clap').applied, 'clap');
});

test('парирование снаряда: снаряд летит назад (owner player), ответный hit уходит атакующему', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1.6);
  D.step(1 / 60, inp({ spark: true }));
  // парировать, когда искра в ~0.12 с от B (38 м/с, 24 м ≈ 0.63 с полёта)
  D.run(0.5);
  D.step(1 / 60, null, inp({ parry: true }));
  D.run(1.8);
  const par = type(D.evB, 'parry').filter((e) => e.data.success);
  assert(par.length === 1, `parry events ${JSON.stringify(type(D.evB, 'parry').map((e) => e.data))}`);
  assert(type(D.evB, 'player_hit').length === 0, 'B не получил урона');
  const back = type(D.evA, 'player_hit');
  assert(back.length === 1 && back[0].data.attackKind === 'reflect', `ответ A: ${JSON.stringify(back.map((e) => e.data))}`);
  assert(type(D.evA, 'pvp_hit_denied').some((e) => e.data.reason === 'parry'), 'A узнал о парировании');
});

test('парирование рассечения: без урона, атакующего сбивает', () => {
  const V = victim();
  V.tick(0.02, inp({ parry: true }));
  const r = V.hit('m1', 30, 'slash');
  assert(!r.applied && r.reason === 'parry' && r.counter, JSON.stringify(r));
  assert(!V.c.getSnapshot().projectiles.some((p) => p.owner === 'player'), 'рассечение не отражается снарядом');
});

test('оберег поглощает удар, бастион гасит сферу и режет урон на 60%', () => {
  const V = victim();
  V.tick(0.05, inp({ rune: 'orbis' }));
  const r1 = V.hit('w1', 40);
  assert(!r1.applied && r1.reason === 'ward', JSON.stringify(r1));
  assert(V.hit('w2', 40).applied, 'оберег одноразовый');
  V.tick(0.05, inp({ sigil: 'gate' }));
  const r3 = V.hit('g1', 40, 'sphere');
  assert(!r3.applied && r3.reason === 'bastion', JSON.stringify(r3));
  const r4 = V.hit('g2', 40, 'spark');
  near(r4.amount, 40 * 0.4, 0.01, 'бастион −60%');
});

test('fx: оглушение ≤ 0,8 с (глушит ввод), замедление ≤ 2,5 с, отталкивание', () => {
  const V = victim();
  V.hit('f1', 5, 'fulgur', { stun: 5, slow: 9, knock: 2 });
  const st = V.H.status();
  near(st.stunT, 0.8, 1e-6, 'stun cap'); near(st.slowT, 2.5, 1e-6, 'slow cap');
  const z0 = V.snap().player.position.z;
  V.tick(0.4, inp({ moveZ: 1, spark: true }));
  const s = V.snap();
  assert(s.player.stunned && s.player.action === 'hit', 'оглушён');
  assert(!s.projectiles.length, 'оглушённый не стреляет');
  near(s.player.position.z - z0, 2, 0.15, 'отталкивание вдоль dir');
  V.tick(0.5);
  assert(!V.snap().player.stunned, 'оглушение кончилось');
  V.hit('f2', 5, 'fulgur', { stun: 0.8 });
  assert(V.H.status().stunT === 0, 'иммунитет к оглушению после оглушения');
});

test('лечение только на себя; ℓ «Альфа» сокращает откаты вдвое, а не сбрасывает', () => {
  const V = victim();
  V.hit('h1', 70); V.hit('h2', 70);
  V.tick(0.05, inp({ rune: 'orbis' }));
  near(V.snap().player.hp, 400 - 140 + DEFAULT_COMBAT_CONFIG.runes.orbis.heal * V.PC.heal, 0.01, 'орбис ×heal');
  V.tick(0.02, inp({ dashDir: { x: 1, z: 0 } }));
  const cd0 = V.snap().cooldowns.dashRemaining;
  V.tick(0.02, inp({ rune: 'alpha' }));
  const cd1 = V.snap().cooldowns.dashRemaining;
  assert(cd1 > 0.1 && Math.abs(cd1 - (cd0 - 0.02) / 2) < 0.05, `альфа: ${cd0} → ${cd1}`);
});

test('вне фазы боя удары отклоняются', () => {
  const V = victim();
  V.H.setAcceptHits(false);
  const r = V.hit('p1', 10);
  assert(!r.applied && r.reason === 'phase', JSON.stringify(r));
});

test('интерполяция соперника: задержка 100 мс, скорость, экстраполяция ≤ 250 мс', () => {
  const b = createRemoteBuffer({ delayMs: 100 });
  for (let i = 0; i <= 10; i++) b.push({ t: i * 50, position: { x: i * 0.25, y: 0, z: 0 }, velocity: { x: 5, z: 0 }, yaw: 0 }, i * 50 + 40);
  const s = b.sample(500 + 40);                  // 540 локально ↔ 500 у отправителя − 100 мс задержки = 400
  near(s.position.x, 2.0, 1e-6, 'интерполяция');
  const e = b.sample(2000);
  near(e.position.x, 2.5 + 5 * 0.25, 1e-6, 'экстраполяция не дальше 250 мс');
});

test('точки дуэли: C7 или ±12 м от центра арены', () => {
  const d = resolveSpawns(null, { x: 5, z: -3 });
  assert(d[0].x === 5 && d[0].z === 9 && d[1].z === -15, JSON.stringify(d));
  near(d[0].yaw, Math.PI, 1e-9, 'лицом к центру');
  const f = resolveSpawns([{ x: 100, z: 50 }, { x: 110, z: 50 }], null);
  near(f[0].yaw, Math.PI / 2, 1e-9, 'yaw на соперника');
});

// ------------------------------------------------------------ 2. раунды
function killer(D, who) {
  // «who» бьёт искрами и рунами без остановки, соперник стоит
  const keys = [{ spark: true }, { rune: 'ignis' }, { spark: true }, { rune: 'caret' }, { spark: true }, { rune: 'fulgur' }, { burst: true, burstPower: 1 }];
  let i = 0;
  return () => (D.T % 250 < 17 ? inp(keys[i++ % keys.length]) : inp());
}
test('матч до 2 побед: счёт, события pvp_round, итоги', () => {
  const D = makeDuel({ cfg: { rounds: { countdown: 3, roundEnd: 2.8, roundTime: 100 } } });
  const kA = killer(D, 'A');
  D.run(140, kA, null, 1 / 30);
  assert(D.sA.phase === 'match_end' && D.sB.phase === 'match_end', `фазы ${D.sA.phase}/${D.sB.phase}`);
  const vA = D.sA.getView(), vB = D.sB.getView();
  assert(vA.score[0] === 2 && vA.score[1] === 0 && vB.score[0] === 0 && vB.score[1] === 2, `счёт ${vA.score} / ${vB.score}`);
  assert(vA.result.won && !vB.result.won, 'победитель');
  near(vA.result.dealt, vB.result.taken, 1.5, 'нанесённый = полученный');
  assert(vA.result.favorite && vA.result.favorite.count > 0, 'любимое заклинание');
  assert(vA.result.accuracy === 0.8, 'точность жестов из тренера');
  const rounds = type(D.evA, 'pvp_round').map((e) => e.data.phase + e.data.round);
  for (const need of ['countdown1', 'fight1', 'round_end1', 'countdown2', 'fight2', 'round_end2', 'match_end2']) assert(rounds.includes(need), `нет ${need}: ${rounds}`);
  const re = type(D.evB, 'pvp_round').filter((e) => e.data.phase === 'round_end');
  assert(re.length === 2 && re.every((e) => e.data.winner === 'opponent'), 'B: поражение в раундах');
  assert(type(D.evB, 'pvp_respawn').length >= 3, 'респаун каждый раунд');
});

test('конец раунда: замедление 0,5 с только в round_end; в бою timeScale = 1', () => {
  const D = makeDuel();
  D.untilPhase('fight');
  assert(D.sA.timeScale() === 1, 'в бою без стоп-кадров');
  const kA = killer(D, 'A');
  for (let i = 0; i < 60 * 60 && D.sA.phase !== 'round_end'; i++) D.step(1 / 60, kA(D));
  assert(D.sA.phase === 'round_end', 'раунд не кончился');
  near(D.sA.timeScale(), mergePvpConfig().rounds.slowScale, 1e-9, 'slowmo');
  D.run(0.6);
  assert(D.sA.timeScale() === 1, 'после 0.5 с — обычное время');
});

test('обрыв сети: пауза, через 20 с техническая победа', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1);
  D.pair.b.dropped = true; D.pair.a.dropped = true;   // обе стороны перестали слышать друг друга
  D.pair.a.state = 'lost';
  D.run(1);
  assert(D.sA.phase === 'paused', `фаза ${D.sA.phase}`);
  assert(D.sA.getView().disconnectLeft > 18, 'отсчёт 20 с');
  D.run(20);
  assert(D.sA.phase === 'match_end' && D.sA.getView().result.won && D.sA.state.reason === 'disconnect', `итог ${D.sA.phase} ${D.sA.state.reason}`);
});

test('обрыв и возврат связи: бой продолжается', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1);
  D.pair.a.state = 'lost'; D.run(2);
  assert(D.sA.phase === 'paused', 'пауза');
  D.pair.a.state = 'connected'; D.run(0.5);
  assert(D.sA.phase === 'fight', `возврат: ${D.sA.phase}`);
});

test('реванш — только когда подтвердили обе стороны', () => {
  const D = makeDuel({ cfg: { rounds: { countdown: 1, roundEnd: 1 } } });
  const kA = killer(D, 'A');
  D.run(120, kA, null, 1 / 30);
  assert(D.sA.phase === 'match_end', 'матч кончился');
  D.sA.requestRematch(); D.run(1);
  assert(D.sA.phase === 'match_end' && D.sB.getView().rematch.opp, 'одного подтверждения мало');
  D.sB.requestRematch(); D.run(0.5);
  assert(D.sA.phase === 'countdown' && D.sB.phase === 'countdown', `реванш: ${D.sA.phase}/${D.sB.phase}`);
  assert(D.sA.getView().score.join() === '0,0', 'счёт с нуля');
  near(D.B.getSnapshot().player.hp, 400, 1e-9, 'полные HP');
});


// ------------------------------------------------------------ регресс по ревизии
test('улучшения «Клятвы героя» в дуэли не действуют и возвращаются после неё', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  c.setUpgrades({ maxEnergy: 60, runSpeedMul: 1.2, sparkDamageMul: 1.8, dashCooldownMul: 0.7, parryWindowAdd: 0.09 });
  const up = c.getEffectiveConfig();
  const s = createPvpSession({ combat: c, net: createMemoryNetPair().a, clock: () => 0 });
  s.start();
  const pv = c.getEffectiveConfig();
  const B = DEFAULT_COMBAT_CONFIG;
  assert(pv.player.maxEnergy === B.player.maxEnergy && pv.player.runSpeed === B.player.runSpeed && pv.spark.damage === B.spark.damage
    && pv.dash.cooldown === B.dash.cooldown && Math.abs(pv.parry.window - B.parry.window) < 1e-9, `в дуэли остались улучшения: ${JSON.stringify({ e: pv.player.maxEnergy, r: pv.player.runSpeed, s: pv.spark.damage })}`);
  c.setUpgrades({ maxEnergy: 80 });                        // покупка во время дуэли
  assert(c.getEffectiveConfig().player.maxEnergy === B.player.maxEnergy, 'покупка в дуэли не действует');
  s.stop();
  const back = c.getEffectiveConfig();
  assert(back.player.maxEnergy === B.player.maxEnergy + 80 && back.player.runSpeed === B.player.runSpeed, `после дуэли — последняя покупка: ${back.player.maxEnergy}`);
  assert(up.player.maxEnergy === B.player.maxEnergy + 60, 'до дуэли улучшения были');
});

test('пауза посреди рывка не даёт вечной неуязвимости', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1.7);
  D.step(1 / 60, null, inp({ dashDir: { x: 1, z: 0 } }));
  D.pausedB = true;                                        // B встал на паузу в рывке
  D.run(1.0);
  for (let i = 0; i < 3; i++) { D.step(1 / 60, inp({ spark: true })); D.run(0.9); }
  const landed = type(D.evA, 'boss_hit').filter((e) => e.data.pvp);   // события B на паузе не выгружаются (как в main.js)
  assert(landed.length >= 2 && D.B.getSnapshot().player.hp < 400, `удары не проходят по «замороженному» B: ${JSON.stringify(type(D.evA, 'pvp_hit_denied').map((e) => e.data.reason))}`);
});

test('смерть на паузе засчитывается сразу (проверка в кадре, не только в бою)', () => {
  const D = makeDuel({ cfg: { rounds: { roundTime: 100 } } });
  D.untilPhase('fight'); D.run(1.7);
  D.pausedB = true;
  const kA = killer(D, 'A');
  for (let i = 0; i < 60 * 60 && D.sA.phase === 'fight'; i++) D.step(1 / 60, kA(D));
  assert(D.sA.phase === 'round_end' && D.sA.state.reason === 'ko', `раунд: ${D.sA.phase} ${D.sA.state.reason}`);
  assert(D.sA.getView().score[0] === 1, 'очко хосту');
});

test('потерянные round_end/match_end доходят повтором хоста; гость не застревает', () => {
  const D = makeDuel({ cfg: { rounds: { countdown: 1, roundEnd: 1 } } });
  const kA = killer(D, 'A');
  // бить до 1:0 во втором раунде, затем рвать связь в конце второго раунда
  for (let i = 0; i < 60 * 200 && !(D.sA.state.round === 2 && D.sA.phase === 'fight'); i++) D.step(1 / 60, kA(D));
  for (let i = 0; i < 60 * 60 && D.sA.phase === 'fight'; i++) D.step(1 / 60, kA(D));
  D.pair.a.dropped = true;                                 // хост «говорит в пустоту» ~2 с (меньше порога обрыва)
  D.run(2);
  D.pair.a.dropped = false;
  D.run(3);
  assert(D.sA.phase === 'match_end' && D.sB.phase === 'match_end', `фазы ${D.sA.phase}/${D.sB.phase}`);
  assert(D.sB.getView().winner === 'opponent' && D.sB.getView().score.join() === '0,2', `гость: ${D.sB.getView().winner} ${D.sB.getView().score}`);
  D.sA.requestRematch(); D.sB.requestRematch(); D.run(1);
  assert(D.sA.phase === 'countdown' && D.sB.phase === 'countdown', `реванш: ${D.sA.phase}/${D.sB.phase}`);
});

test('односторонняя техпобеда: второй игрок узнаёт о поражении, когда связь вернулась', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1);
  D.pair.a.state = 'lost';                                 // хост потерял гостя, гость ничего не заметил
  D.pair.b.dropped = true;                                 // и пакеты гостя не доходят
  D.run(21);
  assert(D.sA.phase === 'match_end' && D.sA.state.reason === 'disconnect', `хост: ${D.sA.phase}`);
  D.pair.a.state = 'connected'; D.pair.b.dropped = false;
  D.run(2);
  assert(D.sB.phase === 'match_end' && D.sB.getView().winner === 'opponent' && D.sB.state.reason === 'disconnect', `гость: ${D.sB.phase} ${D.sB.getView().winner}`);
});

test('обе стороны заявили техпобеду — ничья', () => {
  const D = makeDuel();
  D.untilPhase('fight'); D.run(1);
  D.pair.a.state = 'lost'; D.pair.b.state = 'lost';
  D.run(21);
  assert(D.sA.state.claim && D.sB.state.claim, 'обе заявили');
  D.pair.a.state = 'connected'; D.pair.b.state = 'connected';
  D.run(2.5);
  assert(D.sA.getView().winner === null && D.sB.getView().winner === null, `итог: ${D.sA.getView().winner}/${D.sB.getView().winner}`);
});

test('выход соперника в лобби не даёт «победу», посреди матча — техпобеда до 2', () => {
  let D = makeDuel();
  D.sB.setReady(false); D.run(0.5);
  D.sB.leave(); D.run(0.5);
  assert(D.sA.phase === 'lobby', `лобби: ${D.sA.phase}`);
  D = makeDuel();
  D.untilPhase('fight'); D.run(1);
  D.sB.leave(); D.run(0.5);
  assert(D.sA.phase === 'match_end' && D.sA.getView().result.won && D.sA.getView().score[0] === 2, `выход: ${D.sA.phase} ${D.sA.getView().score}`);
});

// ------------------------------------------------------------ 3. боты и баланс
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
// мастерство одинаковое у всех стилей (сравниваем стили, а не уровень игрока)
const SKILL = 0.6, REACT = 0.25;
const STYLES = {
  // dist — желаемая дистанция; skill — шанс заметить снаряд; react — задержка реакции (с);
  // def — чем защищаться; plan — приоритет приёмов
  caster:   { reserve: 25, dist: 16, skill: SKILL, react: REACT, def: ['dash', 'shield'], plan: ['ignis', 'caret', 'fulgur', 'throw', 'spark', 'clepsydra', 'frame', 'bolt'] },
  brawler:  { reserve: 20, dist: 3.2, skill: SKILL, react: REACT, def: ['dash', 'parry'], plan: ['clap', 'burst', 'slash', 'fulgur', 'vee', 'spark'] },
  guardian: { reserve: 30, dist: 10, skill: SKILL, react: REACT, def: ['shield', 'parry', 'dash'], plan: ['vee', 'delta', 'stella', 'spark', 'bolt'], heals: true },
  dancer:   { reserve: 40, dist: 12, skill: SKILL, react: REACT, def: ['dash'], plan: ['caret', 'spark', 'ignis', 'alpha', 'throw', 'bolt'] },
  mystic:   { reserve: 25, dist: 14, skill: SKILL, react: REACT, def: ['dash', 'parry', 'shield'], plan: ['stella', 'delta', 'ignis', 'clepsydra', 'vee', 'spark'], heals: true },
};
const RUNES = new Set(['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha']);
const SIGILS = new Set(['clap', 'gate', 'frame', 'delta', 'cor']);
function createBot(style, seed) {
  const S = STYLES[style], rnd = lcg(seed);
  const cfg = DEFAULT_COMBAT_CONFIG;
  const B = { strafe: rnd() < 0.5 ? -1 : 1, strafeT: 1 + rnd() * 2, think: 0, react: new Map(), shieldT: 0, busyT: 0 };
  return function decide(snap, dt) {
    const out = inp({ moveMode: 'stick' });
    const P = snap.player, O = snap.opponent;
    if (!O || P.dead) return out;
    const dx = O.position.x - P.position.x, dz = O.position.z - P.position.z, d = Math.hypot(dx, dz);
    // движение: дистанция и стрейф вокруг соперника (оси lock-on: z — к сопернику)
    B.strafeT -= dt;
    if (B.strafeT <= 0) { B.strafe = rnd() < 0.3 ? 0 : (rnd() < 0.5 ? -1 : 1); B.strafeT = 0.8 + rnd() * 2.2; }
    out.moveZ = Math.max(-1, Math.min(1, (d - S.dist) / 3));
    out.moveX = B.strafe * (0.55 + 0.45 * rnd());
    // защита: снаряды соперника (призраки в снимке), летящие в меня
    let threat = null;
    for (const q of snap.projectiles) {
      if (q.owner !== 'opponent') continue;
      const rx = P.position.x - q.position.x, rz = P.position.z - q.position.z, rd = Math.hypot(rx, rz);
      const v = Math.hypot(q.velocity.x, q.velocity.z) || 1;
      const closing = (q.velocity.x * rx + q.velocity.z * rz) / v;
      if (closing <= 0) continue;
      const tti = rd / v;
      if (!threat || tti < threat.tti) threat = { id: q.id, tti };
    }
    if (B.shieldT > 0) { B.shieldT -= dt; out.shield = true; }
    if (threat) {
      let r = B.react.get(threat.id);
      // parryAt — человек жмёт парирование с разбросом: окно 0.2 с накрывает удар не всегда
      if (!r) { r = { seen: rnd() < S.skill, t: S.react * (0.8 + 0.5 * rnd()), done: false, parryAt: 0.02 + rnd() * 0.3 }; B.react.set(threat.id, r); if (B.react.size > 64) B.react.delete(B.react.keys().next().value); }
      r.t -= dt;
      if (r.seen && !r.done && r.t <= 0) {
        for (const how of S.def) {
          if (how === 'dash' && P.energy >= cfg.dash.cost && snap.cooldowns.dashRemaining <= 0 && threat.tti < 0.35) { out.dashDir = { x: rnd() < 0.5 ? -1 : 1, z: 0 }; r.done = true; break; }
          if (how === 'parry' && snap.cooldowns.parryRemaining <= 0 && threat.tti <= r.parryAt) { out.parry = true; r.done = true; break; }
          if (how === 'shield' && P.energy > 25 && threat.tti < 0.4) { B.shieldT = 0.45; out.shield = true; r.done = true; break; }
        }
      }
    }
    // атака (≈ 8 решений в секунду, человек не жмёт каждый кадр)
    B.think -= dt;
    if (B.think > 0 || out.shield || P.action === 'hit') return out;
    B.think = 0.1 + rnd() * 0.12;
    const cd = snap.cooldowns, en = P.energy - S.reserve;   // запас энергии на рывок/щит
    if (S.heals && P.hp < P.maxHp * 0.55) {
      for (const h of ['lemnis', 'orbis', 'cor']) {
        const c = RUNES.has(h) ? cd.runes[h] : cd.sigils[h], need = RUNES.has(h) ? cfg.runes[h].energy : cfg.sigils[h].energy;
        if (c.remaining <= 0 && en >= need) { if (RUNES.has(h)) out.rune = h; else out.sigil = h; return out; }
      }
    }
    let saving = false;                           // главный приём готов, но энергии мало — копить (не тратить на искры)
    for (const a of S.plan) {
      if (RUNES.has(a)) {
        if (cd.runes[a].remaining > 0) continue;
        if (en >= cfg.runes[a].energy) { out.rune = a; return out; }
        if (!saving && rnd() < 0.7) saving = true;
        continue;
      }
      if (SIGILS.has(a)) {
        if (cd.sigils[a].remaining > 0 || (a === 'clap' && d > 5)) continue;
        if (en >= cfg.sigils[a].energy) { out.sigil = a; return out; }
        if (!saving && rnd() < 0.7) saving = true;
        continue;
      }
      if (saving && (a === 'spark' || a === 'bolt' || a === 'throw')) continue;
      if (a === 'slash') { if (cd.slashRemaining <= 0 && d < 4.4 && en >= cfg.slash.cost) { out.slash = { dir: rnd() < 0.5 ? -1 : 1, power: 0.5 + rnd() * 0.5 }; return out; } continue; }
      if (a === 'burst') { if (cd.burstRemaining <= 0 && en >= cfg.burst.cost && d < 14) { out.burst = true; out.burstPower = 0.5 + rnd() * 0.5; out.burstHand = rnd() < 0.5 ? 'both' : 'right'; return out; } continue; }
      if (a === 'spark') { if (cd.sparkRemaining <= 0 && en >= 10) { out.spark = true; return out; } continue; }
      if (a === 'throw') { if (cd.throwRemaining <= 0 && en >= 30) { out.throw = { kind: rnd() < 0.5 ? 'orb' : 'prism', size: 0.5 + rnd() * 0.5, power: 0.5 + rnd() * 0.5, aimX: (rnd() - 0.5) * 0.6 }; return out; } continue; }
      if (a === 'bolt') { out.attack = en > 20; return out; }
    }
    return out;
  };
}

function simulateDuel(styleA, styleB, seed) {
  const D = makeDuel({ seed, latency: 35 + (seed % 4) * 10, jitter: 12, keepEvents: false,
    cfg: { rounds: { toWin: 1, maxRounds: 1, countdown: 0.5, roundEnd: 0.2, roundTime: 100 } } });
  const botA = createBot(styleA, seed * 7 + 1), botB = createBot(styleB, seed * 13 + 5);
  const dt = 1 / 30;
  let maxHit = 0;
  const hitsBy = { A: 0, B: 0 };
  D.A.drainEvents(); D.B.drainEvents();
  // перехват событий (keepEvents=false: только нужное)
  const origStep = D.step;
  for (let i = 0; i < 115 * 30 && D.sA.phase !== 'match_end'; i++) {
    const sa = D.A.getSnapshot(), sb = D.B.getSnapshot();
    const ia = botA(sa, dt), ib = botB(sb, dt);
    origStep(dt, ia, ib);
    const ha = D.A.getSnapshot().stats.damageTaken, hb = D.B.getSnapshot().stats.damageTaken;
    hitsBy.A = hb; hitsBy.B = ha;
  }
  maxHit = Math.max(D.sA.hooks.stats.maxTaken || 0, D.sB.hooks.stats.maxTaken || 0);
  const vA = D.sA.getView();
  const len = D.sA.state.roundTimes[0] ?? 100;
  const winner = vA.winner === 'me' ? 'A' : vA.winner === 'opponent' ? 'B' : null;
  return { styleA, styleB, winner, len, reason: D.sA.state.reason, dmgA: hitsBy.A, dmgB: hitsBy.B, maxHit, byA: { ...D.sB.hooks.stats.takenBy }, byB: { ...D.sA.hooks.stats.takenBy },
    defA: { dodged: D.sA.hooks.stats.dodged, blocked: D.sA.hooks.stats.blocked, parried: D.sA.hooks.stats.parried }, defB: { dodged: D.sB.hooks.stats.dodged, blocked: D.sB.hooks.stats.blocked, parried: D.sB.hooks.stats.parried } };
}

let balance = null;
test(`баланс: ${DUELS} дуэлей ботов — длительность 45–90 с, ни один стиль > 65% побед`, () => {
  const names = Object.keys(STYLES);
  const per = Object.fromEntries(names.map((n) => [n, { w: 0, g: 0 }]));
  const lens = [];
  let draws = 0, timeouts = 0, maxHit = 0;
  const dmgBy = {};
  const t0 = Date.now();
  for (let i = 0; i < DUELS; i++) {
    const a = names[i % names.length], b = names[(Math.floor(i / names.length) + 1 + i) % names.length];
    const sb = a === b ? names[(names.indexOf(b) + 1) % names.length] : b;
    const r = simulateDuel(a, sb, 1000 + i);
    lens.push(r.len);
    per[a].g++; per[sb].g++;
    if (r.winner === 'A') per[a].w++; else if (r.winner === 'B') per[sb].w++; else draws++;
    if (r.len >= 99.9) timeouts++;
    for (const [st, by, df] of [[a, r.byA, r.defA], [sb, r.byB, r.defB]]) {
      const q = (dmgBy[st] || (dmgBy[st] = { def: { dodged: 0, blocked: 0, parried: 0 } }));
      for (const [k, v] of Object.entries(by)) q[k] = (q[k] || 0) + v;
      for (const k of Object.keys(df)) q.def[k] += df[k];
    }
    maxHit = Math.max(maxHit, r.maxHit);
  }
  const avg = lens.reduce((s, x) => s + x, 0) / lens.length;
  const sorted = lens.slice().sort((x, y) => x - y);
  balance = { duels: DUELS, avg: Math.round(avg * 10) / 10, median: Math.round(sorted[sorted.length >> 1] * 10) / 10, p10: Math.round(sorted[Math.floor(sorted.length * 0.1)]), p90: Math.round(sorted[Math.floor(sorted.length * 0.9)]), draws, timeouts, maxHit: Math.round(maxHit * 10) / 10, sec: Math.round((Date.now() - t0) / 1000),
    styles: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, `${Math.round(100 * v.w / Math.max(1, v.g))}% (${v.w}/${v.g})`])) };
  if (argv.includes('--verbose')) for (const [k, v] of Object.entries(dmgBy)) console.log(k, JSON.stringify(Object.fromEntries(Object.entries(v).map(([a, b]) => [a, typeof b === 'number' ? Math.round(b / Math.max(1, per[k].g)) : b]))));
  assert(avg >= 45 && avg <= 90, `средняя длительность ${avg.toFixed(1)} с`);
  for (const [k, v] of Object.entries(per)) assert(v.w / Math.max(1, v.g) <= 0.65, `стиль ${k}: ${Math.round(100 * v.w / v.g)}% побед`);
  assert(maxHit <= 400 * 0.18 + 1e-6, `удар ${maxHit} > 18% HP`);
});

// ------------------------------------------------------------ итог
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ' — ' + r.err}`);
if (balance) console.log('баланс:', JSON.stringify(balance));
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
