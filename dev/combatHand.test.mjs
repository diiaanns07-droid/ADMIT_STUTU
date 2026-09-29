// [HAND] Тесты modules/combatHand.js через modules/combat.js (хуки [HAND]). node dev/combatHand.test.mjs
// Стрелы и сгустки: события C3, урон по натяжению, стихии (горение, цепь, замедление, отбрасывание),
// «Дождь стрел», энергия и откаты, снаряды в snapshot.projectiles, цели PvP через registerTarget.

import { createCombat } from '../modules/combat.js';
import { createPvpSession, createMemoryNetPair } from '../modules/pvp.js';
import { config as gameConfig } from '../config.js';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

const brain = () => ({ reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } });
const I = (o = {}) => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false, ...o });
const bowIn = (o = {}) => ({ active: true, phase: 'drawing', draw: 0, aimX: 0, aimY: 0, charged: false, release: false, element: null, ...o });
const spellIn = (o = {}) => ({ phase: 'hold', element: 'fire', power: 0.8, size: 0.7, dir: { x: 0, y: 0 }, twoHand: false, ...o });

function fight() {
  const c = createCombat({ config: {}, bossBrain: brain() });
  const events = [];
  const tick = (input, frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i++) { c.update(dt, I(input)); events.push(...c.drainEvents()); }
  };
  return { c, events, tick, ev: (type) => events.filter((e) => e.type === type) };
}
// натянуть и выстрелить
function shoot(F, o = {}) {
  F.tick({ bow: bowIn({ draw: 0 }) }, 2);
  for (let k = 1; k <= 10; k++) F.tick({ bow: bowIn({ draw: (o.draw ?? 1) * k / 10, charged: !!o.charged && k === 10, element: o.element || null }) });
  F.tick({ bow: bowIn({ draw: o.draw ?? 1, charged: !!o.charged, release: true, element: o.element || null, aimX: o.aimX || 0, aimY: o.aimY || 0, rain: !!o.rain, rapid: !!o.rapid }) });
  F.tick({ bow: bowIn({ phase: 'ready', draw: 0 }) }, o.after ?? 150);
}

test('API: combat.hand есть; снимок без лука — idle-поля и откаты', () => {
  const F = fight();
  ok(F.c.hand && typeof F.c.hand.registerTarget === 'function', 'combat.hand');
  F.tick({}, 2);
  const s = F.c.getSnapshot();
  ok(s.player.bow && s.player.bow.active === false && s.player.handSpell.phase === 'idle', 'idle-поля');
  ok(s.cooldowns.arrowTotal > 0 && s.cooldowns.handOrbTotal > 0 && s.cooldowns.rainTotal > 0, 'откаты');
});
test('выстрел: bow_draw_start → bow_draw → bow_release → стрела в snapshot.projectiles → arrow_hit по Регенту', () => {
  const F = fight();
  F.tick({ bow: bowIn({ draw: 0 }) }, 2);
  for (let k = 1; k <= 10; k++) F.tick({ bow: bowIn({ draw: k / 10 }) });
  F.tick({ bow: bowIn({ draw: 1, charged: true, release: true }) });
  F.tick({ bow: bowIn({ phase: 'ready' }) }, 2);
  const snap = F.c.getSnapshot();
  const arrows = snap.projectiles.filter((p) => p.kind === 'arrow');
  ok(arrows.length === 1 && arrows[0].owner === 'player' && 'element' in arrows[0], `стрелы в снимке: ${arrows.length}`);
  const hp0 = snap.boss.hp;
  F.tick({ bow: bowIn({ phase: 'ready' }) }, 120);
  ok(F.ev('bow_draw_start').length === 1, 'bow_draw_start');
  ok(F.ev('bow_draw').length >= 2, `bow_draw ${F.ev('bow_draw').length}`);   // не чаще раза в 90 мс
  const rel = F.ev('bow_release');
  ok(rel.length === 1 && rel[0].data.draw === 1 && rel[0].data.charged === true && 'element' in rel[0].data, 'bow_release');
  const hit = F.ev('arrow_hit');
  ok(hit.length === 1 && hit[0].data.damage > 0 && hit[0].data.target === 'boss', `arrow_hit ${JSON.stringify(hit.map((h) => h.data))}`);
  ok(F.c.getSnapshot().boss.hp < hp0, 'урон по Регенту');
  ok(F.ev('boss_hit').some((e) => e.data.source === 'arrow'), 'boss_hit source arrow');
  ok(F.ev('projectile_impact').some((e) => e.data.kind === 'arrow' && e.data.result === 'boss'), 'projectile_impact для effects');
});
test('урон растёт с натяжением; заряженная сильнее; серия недонатянутых — слабее', () => {
  const dmg = (o) => { const F = fight(); shoot(F, o); const h = F.ev('arrow_hit'); return h.length ? h[0].data.damage : 0; };
  const weak = dmg({ draw: 0.3 }), full = dmg({ draw: 1 }), charged = dmg({ draw: 1, charged: true }), rapid = dmg({ draw: 0.3, rapid: true });
  ok(weak > 0 && full > weak * 2, `weak ${weak} full ${full}`);
  ok(charged > full, `charged ${charged} full ${full}`);
  ok(rapid < weak, `rapid ${rapid} weak ${weak}`);
});
test('аим-ассист: небольшой промах прицела (aimX 0.3 ≈ 8°) всё равно попадает; сильный увод (aimX 1) — мимо', () => {
  const F = fight(); shoot(F, { draw: 1, aimX: 0.3 });
  ok(F.ev('arrow_hit').length === 1, 'в конусе ассиста — попадание');
  const G = fight(); shoot(G, { draw: 1, aimX: 1 });
  ok(G.ev('arrow_hit').length === 0, 'вне конуса — промах');
});
test('стихии стрел: огонь — горение (тики урона), лёд — замедление, земля — отбрасывание, молния — цепь', () => {
  const F = fight(); shoot(F, { element: 'fire', after: 260 });
  ok(F.ev('boss_hit').filter((e) => e.data.source === 'burn').length >= 4, 'горение');
  ok(F.ev('element_apply').some((e) => e.data.element === 'fire'), 'element_apply fire');
  const G = fight(); shoot(G, { element: 'frost', after: 10 });
  ok(G.c.getSnapshot().boss.slowed, 'замедление');
  const H = fight(); shoot(H, { element: 'earth', after: 60 });
  ok(H.ev('element_apply').some((e) => e.data.element === 'earth' && e.data.knockback), 'отбрасывание');
  const J = fight(); shoot(J, { element: 'storm', after: 60 });
  ok(J.ev('hand_chain').length === 1 && J.ev('boss_hit').some((e) => e.data.source === 'chain'), 'цепь');
});
test('горение не раздувает комбо и не продлевает его', () => {
  const F = fight(); shoot(F, { element: 'fire', after: 110 });
  const s = F.c.getSnapshot();
  ok(F.ev('boss_hit').filter((e) => e.data.source === 'burn').length >= 2, 'тики горения');
  ok(s.player.combo === 1, `комбо ${s.player.combo}`);
});
test('«Дождь стрел»: arrow_rain, залп вверх, падающие стрелы бьют Регента несколько раз', () => {
  const F = fight(); shoot(F, { draw: 1, charged: true, aimY: 0.9, rain: true, after: 180 });
  ok(F.ev('arrow_rain').length === 1, 'arrow_rain');
  const hits = F.ev('arrow_hit').filter((e) => e.data.rain);
  ok(hits.length >= 5, `попаданий дождя ${hits.length}`);
  ok(F.c.getSnapshot().cooldowns.rainRemaining > 0, 'откат дождя');
});
test('энергия и откат: без энергии — ability_denied, стрелы нет; частый выпуск упирается в откат', () => {
  const F = fight();
  F.c.getSnapshot();
  // выжечь энергию дождями
  for (let i = 0; i < 12; i++) shoot(F, { draw: 1, rain: true, aimY: 0.9, after: 1 });
  ok(F.ev('ability_denied').length > 0, 'нет отказов');
  const G = fight();
  G.tick({ bow: bowIn({ draw: 0.5 }) }, 2);
  G.tick({ bow: bowIn({ draw: 0.5, release: true }) });
  G.tick({ bow: bowIn({ draw: 0.5, release: true }) });
  G.tick({}, 30);
  ok(G.ev('bow_release').length === 1 && G.ev('ability_denied').some((e) => e.data.ability === 'arrow' && e.data.reason === 'cooldown'), 'откат');
});
test('сгусток: form → throw → hand_orb в снимке → hand_spell_hit; двумя руками сильнее; cancel', () => {
  const F = fight();
  F.tick({ handSpell: spellIn({ phase: 'form', formed: true, power: 0 }) });
  F.tick({ handSpell: spellIn({ power: 0.8 }) }, 30);
  F.tick({ handSpell: spellIn({ phase: 'throw', power: 0.8, dir: { x: 0, y: 0 } }) });
  F.tick({}, 2);
  ok(F.c.getSnapshot().projectiles.some((p) => p.kind === 'hand_orb' && p.element === 'fire'), 'hand_orb в снимке');
  F.tick({}, 90);
  ok(F.ev('hand_spell_form').length === 1 && F.ev('hand_spell_throw').length === 1, 'form/throw');
  const hit = F.ev('hand_spell_hit');
  ok(hit.length === 1 && hit[0].data.damage > 0 && hit[0].data.element === 'fire', `hand_spell_hit ${hit.length}`);
  const one = hit[0].data.damage;
  const G = fight();
  G.tick({ handSpell: spellIn({ phase: 'throw', power: 0.8, twoHand: true }) });
  G.tick({}, 90);
  const two = G.ev('hand_spell_hit')[0];
  ok(two && two.data.twoHand && two.data.damage > one * 1.4, `двумя руками ${two && two.data.damage} против ${one}`);
  const H = fight();
  H.tick({ handSpell: spellIn({ phase: 'idle', cancel: true, cancelReason: 'lowered' }) });
  H.tick({}, 2);
  ok(H.ev('hand_spell_cancel').length === 1, 'cancel');
});
test('сгусток с отклонением: бросок в сторону (dir.x 1) — мимо; чуть в сторону (0.3) — самонаведение попадает', () => {
  const F = fight(); F.tick({ handSpell: spellIn({ phase: 'throw', dir: { x: 1, y: 0 } }) }); F.tick({}, 120);
  ok(F.ev('hand_spell_hit').length === 0, 'мимо');
  const G = fight(); G.tick({ handSpell: spellIn({ phase: 'throw', dir: { x: 0.3, y: 0.1 } }) }); G.tick({}, 120);
  ok(G.ev('hand_spell_hit').length === 1, 'самонаведение');
});
test('PvP: зарегистрированная цель получает onHit с уроном, стихией и направлением', () => {
  const F = fight();
  const got = [];
  F.c.hand.setBossTargetable(false);
  const s0 = F.c.getSnapshot();
  const p = s0.player.position, b = s0.boss.position;
  const tp = { x: p.x + (b.x - p.x) * 0.5, y: 0, z: p.z + (b.z - p.z) * 0.5 };   // соперник между героем и Регентом
  F.c.hand.registerTarget({ id: 'opp', kind: 'player', getPosition: () => tp, radius: 0.45, height: 1.9, onHit: (h) => got.push(h) });
  shoot(F, { draw: 1, element: 'frost', after: 100 });
  ok(got.length === 1 && got[0].damage > 0 && got[0].element === 'frost' && got[0].slowSec > 0 && got[0].dir, `onHit ${JSON.stringify(got)}`);
  ok(F.ev('arrow_hit').some((e) => e.data.target === 'player' && e.data.targetId === 'opp'), 'arrow_hit по сопернику');
  ok(F.c.getSnapshot().boss.hp === s0.boss.hp, 'Регент не задет (setBossTargetable(false))');
});
test('невалидный ввод во время натяжения — bow_cancel, выстрела нет; reset всё чистит', () => {
  const F = fight();
  F.tick({ bow: bowIn({ draw: 0.6 }) }, 3);
  F.c.update(1 / 60, { source: 'none', valid: false });
  F.tick({}, 3);
  ok(F.ev('bow_cancel').length === 1 && F.ev('bow_release').length === 0, 'cancel');
  shoot(F, { draw: 1, after: 2 });
  F.c.reset();
  ok(F.c.getSnapshot().projectiles.length === 0 && F.c.hand.getDebug().live === 0, 'reset');
});
test('снимок: все числа конечны, снарядов не больше maxProjectiles', () => {
  const F = fight();
  for (let i = 0; i < 6; i++) shoot(F, { draw: 1, rain: i % 2 === 0, aimY: 0.9, after: 20 });
  const s = F.c.getSnapshot();
  const bad = [];
  const walk = (o, path) => { if (typeof o === 'number' && !Number.isFinite(o)) bad.push(path); else if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`); };
  walk(s, 'snap');
  ok(bad.length === 0, bad.join(', '));
  ok(s.projectiles.length <= F.c.getConfig().sim.maxProjectiles, `снарядов ${s.projectiles.length}`);
});

// ───────── регрессии ревью ─────────
test('ревью: после выстрела нет ложного bow_cancel; второй выстрел — снова bow_draw_start', () => {
  const F = fight();
  shoot(F, { draw: 1, after: 20 });
  shoot(F, { draw: 1, after: 20 });
  F.tick({ bow: bowIn({ active: false, phase: 'idle' }) }, 5);       // стойка кончилась сама (не отмена)
  ok(F.ev('bow_draw_start').length === 2 && F.ev('bow_release').length === 2, `start ${F.ev('bow_draw_start').length}, rel ${F.ev('bow_release').length}`);
  ok(F.ev('bow_cancel').length === 0, `ложных bow_cancel ${F.ev('bow_cancel').length}`);
});
test('ревью: setBossTargetable(false) переживает reset (реванш в дуэли)', () => {
  const F = fight();
  F.c.hand.setBossTargetable(false);
  F.c.reset();
  shoot(F, { draw: 1, after: 100 });
  ok(F.ev('arrow_hit').length === 0 && F.c.getSnapshot().boss.hp === F.c.getConfig().boss.maxHp, 'после reset стрела снова бьёт Регента');
});
test('ревью: цель позади героя не захватывается (ни дождь, ни баллистика)', () => {
  const F = fight();
  shoot(F, { draw: 1, aimX: 1, aimY: 0.9, rain: true, charged: true, after: 150 });   // aimX 1 ≈ 28° — в конусе 40°: дождь по Регенту
  ok(F.ev('arrow_hit').some((e) => e.data.rain), 'дождь в конусе прицела не попал');
});
test('ревью: смертельная стрела даёт arrow_hit; горение — всегда 6 тиков и не «щёлкает» комбо', () => {
  const F = fight();
  F.c.getSnapshot();
  for (let i = 0; i < 40 && F.c.getSnapshot().status === 'playing'; i++) shoot(F, { draw: 1, charged: true, after: 25 });
  ok(F.c.getSnapshot().status === 'victory', 'нет победы');
  const lastHit = F.ev('arrow_hit').pop(), vic = F.ev('victory')[0];
  ok(lastHit && vic && +lastHit.id.slice(2) < +vic.id.slice(2), 'нет arrow_hit у смертельного выстрела');
  const G = fight(); shoot(G, { element: 'fire', after: 260 });
  const burns = G.ev('boss_hit').filter((e) => e.data.source === 'burn');
  ok(burns.length === 6, `тиков горения ${burns.length}`);
  ok(burns.every((e) => e.data.combo === 1), `combo в тиках: ${burns.map((e) => e.data.combo)}`);
});
test('ревью: reset возвращает генератор дождя — тот же ввод, тот же результат', () => {
  const run = (F) => { shoot(F, { draw: 1, aimY: 0.9, rain: true, charged: true, after: 150 }); return F.c.getSnapshot().boss.hp; };
  const F = fight(); const a = run(F); F.c.reset(); F.events.length = 0; const b = run(F);
  const G = fight(); const c = run(G);
  ok(a === b && b === c, `${a} / ${b} / ${c}`);
});

// ───────── дуэль №3 [PVP]: настоящие сессии и сеть в памяти (как dev/pvp.test.mjs)
function duel() {
  let T = 0;
  const clock = () => T;
  const pair = createMemoryNetPair({ latencyMs: 30, jitterMs: 0, seed: 5, clock });
  const cfg = { ...(gameConfig.pvp || {}) };
  const A = createCombat({ config: {}, bossBrain: brain() }), B = createCombat({ config: {}, bossBrain: brain() });
  const coach = () => ({ accuracy: 0.8 });
  const sA = createPvpSession({ combat: A, net: pair.a, clock, cfg, me: { name: 'A' }, coach });
  const sB = createPvpSession({ combat: B, net: pair.b, clock, cfg, me: { name: 'B' }, coach });
  sA.start(); sB.start();
  const evA = [], evB = [];
  const D = {
    A, B, sA, sB, evA, evB,
    step(inA, dt = 1 / 60) {
      T += dt * 1000; pair.pump();
      for (const [s, c, input, ev] of [[sA, A, inA, evA], [sB, B, null, evB]]) {
        const gi = s.beforeUpdate(I(input || {}));
        c.update(dt, gi);
        for (const e of s.afterUpdate(c.drainEvents())) ev.push(e);
        s.frame();
      }
    },
    run(inA, n) { for (let i = 0; i < n; i++) D.step(inA); },
    fight(maxSec = 12) { for (let i = 0; i < maxSec * 60; i++) { if (sA.phase === 'fight' && sB.phase === 'fight') { D.run(null, 110); return true; } D.step(null); } return false; },   // + неуязвимость появления 1,5 с
    shoot(o = {}) {
      D.run({ bow: bowIn({ draw: 0 }) }, 2);
      for (let k = 1; k <= 10; k++) D.step({ bow: bowIn({ draw: k / 10, element: o.element || null }) });
      D.step({ bow: bowIn({ draw: 1, release: true, element: o.element || null }) });
      D.run({ bow: bowIn({ phase: 'ready' }) }, o.after ?? 90);
    },
  };
  return D;
}
const evOf = (list, t) => list.filter((e) => e.type === t);

test('PvP-дуэль: стрела бьёт соперника по сети (урон × PC.dmg.arrow), Регента нет, горения тиками нет', () => {
  const D = duel();
  ok(D.fight(), 'бой не начался');
  ok(D.A.getMode() === 'pvp', 'режим pvp');
  const hp0 = D.B.getSnapshot().player.hp;
  D.shoot({ element: 'fire' });
  const hitB = evOf(D.evB, 'player_hit');
  ok(hitB.length === 1, `player_hit у соперника: ${hitB.length}`);
  ok(hitB[0].data.attackKind === 'arrow' && hitB[0].data.fx && hitB[0].data.fx.dot > 0, `kind/fx ${JSON.stringify(hitB[0].data)}`);
  const hA = evOf(D.evA, 'arrow_hit');
  ok(hA.length === 1 && hA[0].data.target === 'opponent' && hA[0].data.pvp === true, `arrow_hit ${JSON.stringify(hA.map((e) => e.data))}`);
  const amt = hitB[0].data.amount, dot = hitB[0].data.fx.dot;
  ok(Math.abs(amt - hA[0].data.damage * 0.6) < 0.2, `удар ${amt} при стреле ${hA[0].data.damage} (× 0.6)`);
  const dmg = hp0 - D.B.getSnapshot().player.hp;
  ok(dmg > amt + 0.5 && dmg <= amt + dot + 0.01, `горение идёт у соперника: всего ${dmg}, удар ${amt}, dot ${dot}`);
  ok(D.B.getSnapshot().player.burning === true, 'snap.player.burning у соперника');
  const bh = evOf(D.evA, 'boss_hit');   // подтверждение попадания от №3 (pvp: true); тиков горения отдельными ударами нет
  ok(bh.length === 1 && bh[0].data.pvp === true && bh[0].data.source === 'arrow', `boss_hit ${JSON.stringify(bh.map((e) => e.data))}`);
  ok(evOf(D.evA, 'projectile_impact').some((e) => e.data.kind === 'arrow' && e.data.result === 'opponent'), 'projectile_impact opponent');
  ok(evOf(D.evA, 'projectile_impact').filter((e) => e.data.kind === 'arrow' && e.data.result !== 'floor').length === 1, 'одно projectile_impact на попадание');
});
test('PvP-дуэль: лёд замедляет, земля отбрасывает, молния — цепь вторым ударом', () => {
  {
    const D = duel(); ok(D.fight(), 'бой'); D.shoot({ element: 'frost' });
    ok(D.B.getSnapshot().player.slowed === true, 'лёд: соперник замедлен');
    ok(evOf(D.evB, 'pvp_status').some((e) => e.data.status === 'slow'), 'pvp_status slow');
  }
  {
    const D = duel(); ok(D.fight(), 'бой');
    D.shoot({ element: 'earth', after: 1 });
    const z0 = D.B.getSnapshot().player.position.z;
    D.run({ bow: bowIn({ phase: 'ready' }) }, 40);
    const h = evOf(D.evB, 'player_hit');
    ok(h.length === 1 && h[0].data.fx && h[0].data.fx.knock > 0, `земля: fx ${JSON.stringify(h.map((e) => e.data.fx))}`);
    ok(Math.abs(D.B.getSnapshot().player.position.z - z0) > 0.5 || D.B.getSnapshot().player.position.z < -12.5, `отброс: z ${z0} → ${D.B.getSnapshot().player.position.z}`);
  }
  {
    const D = duel(); ok(D.fight(), 'бой'); D.shoot({ element: 'storm' });
    const h = evOf(D.evB, 'player_hit');
    ok(h.length === 2, `молния: попаданий ${h.length}`);
    ok(evOf(D.evA, 'hand_chain').some((e) => e.data.target === 'opponent'), 'hand_chain → opponent');
  }
});
test('PvP-дуэль: сгусток двумя руками с землёй — оглушение соперника', () => {
  const D = duel(); ok(D.fight(), 'бой');
  D.run({ handSpell: spellIn({ element: 'earth', twoHand: true, power: 1, size: 1 }) }, 30);
  D.step({ handSpell: spellIn({ phase: 'throw', element: 'earth', twoHand: true, power: 1, size: 1 }) });
  D.run({}, 120);
  const h = evOf(D.evB, 'player_hit');
  ok(h.length >= 1 && h[0].data.attackKind === 'hand_orb' && h[0].data.fx.stun > 0, `hit ${JSON.stringify(h.map((e) => e.data))}`);
  ok(evOf(D.evB, 'pvp_status').some((e) => e.data.status === 'stun'), 'оглушение');
});

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
