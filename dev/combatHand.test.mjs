// [HAND] Тесты modules/combatHand.js через modules/combat.js (хуки [HAND]). node dev/combatHand.test.mjs
// Стрелы и сгустки: события C3, урон по натяжению, стихии (горение, цепь, замедление, отбрасывание),
// «Дождь стрел», энергия и откаты, снаряды в snapshot.projectiles, цели PvP через registerTarget.

import { createCombat } from '../modules/combat.js';

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
  ok(F.ev('bow_draw').length >= 3, `bow_draw ${F.ev('bow_draw').length}`);
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

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
