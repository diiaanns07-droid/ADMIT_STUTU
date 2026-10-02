// ASHEN OATH — dev/spellFx.test.mjs. [W4-ЗАКЛИНАНИЯ] Читаемость заклинаний — проверки без браузера:
//  1) бюджет частиц: пик живых частиц V6 в прогоне всех событий боя (сценарий dev/fx.test.mjs, замер каждый кадр)
//     не выше пика main более чем на 15% — на medium, low и high;
//  2) «без каши»: при 3+ одновременных эффектах доли частиц по свежести (новое важнее), фон урезается;
//  3) цвет героя: стихия героя (settings.hero) окрашивает его «общие» заклинания, соперник — фиолетовый;
//  4) предвестник, руна в воздухе и комета: без исключений, акторы и ленты завершаются, кометы чистятся.
// Нужен three.js как модуль: `three` из node_modules или ASHEN_THREE (иначе — из vendor/).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const cands = [process.env.ASHEN_THREE, fileURLToPath(new URL('../vendor/npm/three@0.185.1/build/three.module.min.js', import.meta.url))].filter(Boolean);
  for (const c of cands) { if (existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); break; } catch (e2) { /* skip */ } } }
}
if (!THREE) { console.error('spellFx: three.js не найден (vendor/npm/three@0.185.1)'); process.exit(1); }

const ROOT = process.env.SPELLFX_ROOT ? pathToFileURL(process.env.SPELLFX_ROOT + '/').href : new URL('../', import.meta.url).href;
const { createEffects } = await import(ROOT + 'modules/effects.js');
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL', msg); } };
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

function makeFx(settings) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 400);
  camera.position.set(1.2, 2.75, 10.9); camera.lookAt(0.35, 1.9, 2.2); camera.updateMatrixWorld();
  scene.add(camera);
  const config = { settings, effects: {} };
  const fx = createEffects({ THREE, scene, camera, renderer: null, config });
  return { fx, scene, camera, config };
}
const v3 = (x, y, z) => ({ x, y, z });
function snap(o = {}) {
  return {
    status: 'playing', time: o.time || 1, mode: o.pvp ? 'pvp' : 'boss',
    player: { position: v3(0, 0, 6), yaw: Math.PI, hp: 80, maxHp: 100, energy: 60, maxEnergy: 100, action: o.dead ? 'dead' : 'idle', shielding: !!o.shield, conjure: null,
      warded: true, bastion: !!o.bastion, bastionRemaining: 3, sigilCharge: o.charge || 0, sigilAxis: o.axis || null, vortex: !!o.vortex, vortexRemaining: 2, regen: true, regenRemaining: 3, burstCharge: 0.5 },
    boss: { position: v3(0, 0, 0), stage: 1, action: 'idle', stunned: !!o.stun, slowed: !!o.slow, slowRemaining: 3, marked: !!o.mark },
    projectiles: o.projectiles || [], telegraphs: [], cooldowns: {},
    opponent: o.pvp ? { id: 'opp', position: v3(0, 0, 0), yaw: 0, hp: 100, maxHp: 100, action: 'idle', shielding: !!o.shield, stunned: !!o.stun, slowed: !!o.slow } : null,
    lockTarget: o.pvp ? { position: v3(0, 0, 0), kind: 'player' } : { position: v3(0, 0, 0), kind: 'boss' },
  };
}
let eid = 0;
const ev = (type, position, data) => ({ id: 't' + (++eid), type, position, data: data || {} });
const chest = v3(0, 1.25, 5.9), core = v3(0, 2.6, 0);
const RUNES = ['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha'];
function eventsFor(remote) {
  const r = remote ? { remote: true } : {};
  const from = remote ? core : chest, to = remote ? chest : core;
  const list = [];
  for (const rune of RUNES) {
    list.push([ev('rune_cast', from, { rune, from: rune === 'vee' ? to : from, to: ['orbis', 'spira', 'lemnis', 'alpha'].includes(rune) ? from : (rune === 'vee' ? from : to), amount: 30, heal: 10, duration: 3, radius: 7, count: 5, ...r }), ev('player_cast', from, { ability: 'rune', rune, ...r })]);
  }
  for (let i = 0; i < 5; i++) list.push([ev('rune_hit', to, { rune: 'stella', index: i, amount: 18, ...r })]);
  for (const sigil of ['clap', 'gate', 'frame', 'delta', 'cor']) list.push([ev('sigil_cast', from, { sigil, radius: 7, stunned: true, duration: 4, from, to, ...r })]);
  for (let i = 0; i < 3; i++) list.push([ev('sigil_hit', to, { sigil: 'delta', index: i, from, ...r })]);
  // [W3-МАГИЯ] «Врата бури» и «Столп небес» по полному контракту №2 (modules/combat.js [W3-MAGIC]), промахи, отказ
  const gateD = { sigil: 'gate', power: 1, damage: 60, duration: 3.5, reduction: 0.6, speed: 16, width: 3.5, eta: 0.375, reach: true, from, to, ...r };
  list.push([ev('sigil_cast', from, gateD), ev('bastion_start', v3(from.x, 0, from.z), { duration: 3.5, ...r })]);
  list.push([ev('boss_hit', to, { sigil: 'gate', power: 1, amount: 60, source: 'sigil', hpAfter: 900, combo: 0, multiplier: 1, marked: false })]);
  list.push([ev('sigil_cast', from, { ...gateD, power: 0.4, damage: 42, eta: 2.1, reach: false })]);
  list.push([ev('sigil_miss', to, { sigil: 'gate', power: 0.4, ...r })]);
  list.push([ev('bastion_end', v3(from.x, 0, from.z), { reason: 'expired', ...r })]);
  const pilD = { sigil: 'pillar', power: 0.8, damage: 90, stun: 1.2, delay: 0.45, reach: true, from, to, ...r };
  list.push([ev('sigil_cast', from, pilD)]);
  list.push([ev('boss_stunned', to, { duration: 1.2, source: 'pillar' }), ev('boss_hit', to, { sigil: 'pillar', power: 0.8, amount: 90, source: 'sigil', hpAfter: 800, combo: 1, multiplier: 1.1, marked: false })]);
  list.push([ev('sigil_cast', from, { ...pilD, reach: false }), ev('sigil_miss', to, { sigil: 'pillar', power: 0.8, ...r })]);
  list.push([ev('sigil_cast', from, { sigil: 'pillar', from, to, ...r })]);   // поля могут отсутствовать (старый стенд, сеть)
  list.push([ev('ability_denied', v3(from.x, 0, from.z), { ability: 'sigil', sigil: 'gate', reason: 'cooldown', ...r })]);
  if (!remote) list.push([ev('boss_hit', to, { amount: 50, source: 'sigil', hpAfter: 50, combo: 0, multiplier: 1, marked: false, pvp: true, target: 'opponent' })]);
  list.push([ev('player_cast', from, { ability: 'spark', projectileId: 'p1', velocity: v3(0, 0, -38), ...r })]);
  list.push([ev('projectile_impact', to, { owner: 'player', kind: 'spark', projectileId: 'p1', result: 'boss', direction: v3(0, 0, -1), ...r })]);
  list.push([ev('projectile_impact', to, { owner: 'player', kind: 'spark', projectileId: 'caret:9', result: 'boss', ...r })]);
  list.push([ev('player_slash', from, { dir: 'right', power: 0.8, hit: true, arc: { yaw: Math.PI, angleDeg: 110, radius: 4.5 }, ...r })]);
  list.push([ev('burst', from, { amount: 40, power: 0.9, radius: 7, from, to, ...r })]);
  list.push([ev('projectile_impact', to, { owner: 'player', kind: 'sphere', projectileId: 'sp1', result: 'boss', ...r })]);
  list.push([ev('bow_draw_start', from, { element: 'fire', ...r }), ev('bow_draw', from, { draw: 0.5, ...r })]);
  list.push([ev('bow_release', from, { draw: 1, charged: true, element: 'storm', ...r })]);
  for (const el of ['fire', 'storm', 'frost', 'earth', null]) list.push([ev('arrow_hit', to, { damage: 30, element: el, ...r })]);
  for (const el of ['fire', 'storm', 'frost', 'earth']) {
    list.push([ev('hand_spell_form', from, { element: el, power: 0.2, ...r })]);
    list.push([ev('hand_spell_throw', from, { element: el, power: 1, dir: { x: 0, y: 0 }, ...r })]);
    list.push([ev('hand_spell_hit', to, { element: el, damage: 35, ...r })]);
  }
  list.push([ev('hand_spell_cancel', from, { ...r })]);
  list.push([ev('boss_hit', core, { amount: 45, source: 'spark' })]);
  list.push([ev('player_hit', chest, { amount: 25, direction: v3(0, 0, 1), ...r })]);
  list.push([ev('block', v3(0.2, 1.4, 5.1), { attackKind: 'orb', ...r })]);
  list.push([ev('parry', v3(-0.3, 1.45, 4.8), { success: true, ...r })]);
  list.push([ev('perfect_dodge', from, { ...r })]);
  list.push([ev('hero_spawn', from, { ...r })]);
  list.push([ev('hero_death', from, { ...r })]);
  list.push([ev('pvp_round', null, { phase: 'fight', round: 1, score: [0, 0] })]);
  if (remote) for (const rune of ['ignis', 'fulgur', 'vee']) list.push([ev('pvp_opponent_cast', from, { sourceType: 'rune_cast', rune, from, to, remote: true })]);
  if (remote) for (const t of ['player_dash', 'ward_start', 'ward_end', 'bastion_start', 'bastion_end', 'shield_start']) list.push([ev(t, from, { remote: true, direction: 1 })]);
  list.push([ev('boss_impact', v3(0, 0, 6), { attackKind: 'slam', radius: 2.2 })]);
  list.push([ev('boss_phase', core, { stage: 2 })]);
  return list;
}


// Пик main (603760a, тот же сценарий, 8 прогонов): живых частиц V6 за кадр — medium ≈1337 (1328–1350),
// low ≈783 (773–788), high ≈1422 (1405–1441). Порог — +15% к среднему.
const BASE = { medium: 1337, low: 783, high: 1422 };
const inputs = [null, { valid: true, hands: { drawing: true, trail: [{ x: 0.6, y: 0.3 }, { x: 0.7, y: 0.5 }, { x: 0.55, y: 0.5 }], right: { shape: 'point' } },
  bow: { active: true, draw: 0.7, aimX: 0, aimY: 0, charged: false, release: false, element: 'frost' }, handSpell: { phase: 'hold', element: 'storm', power: 0.6, dir: { x: 0, y: 0 } } }];
async function sweep(quality, hero) {
  const settings = { quality, volume: 0, reducedMotion: false, hero };
  const { fx } = makeFx(settings);
  await fx.v6.ready;
  let peak = 0;
  for (const pvp of [false, true]) {
    for (const remote of pvp ? [false, true] : [false]) {
      for (const group of eventsFor(remote)) {
        const s = snap({ pvp, vortex: true, bastion: true, stun: true, slow: true, mark: true, shield: true,
          projectiles: [{ id: 'caret:1', owner: 'player', kind: 'spark', position: v3(0, 2, 3), velocity: v3(0, 0, -30), radius: 0.2 },
            { id: 'a1', owner: 'player', kind: 'arrow', element: 'fire', position: v3(0, 1.8, 3), velocity: v3(0, 0, -40), radius: 0.08 },
            { id: 'h1', owner: 'player', kind: 'hand_orb', element: 'earth', position: v3(0, 1.8, 2), velocity: v3(0, 0, -20), radius: 0.3 }] });
        fx.setInput(inputs[eid % 2]);
        fx.update(1 / 60, s, group);
        peak = Math.max(peak, fx.v6.stats().kit.particles);
        for (let i = 0; i < 40; i++) { fx.update(1 / 60, s, []); peak = Math.max(peak, fx.v6.stats().kit.particles); }
      }
    }
  }
  for (let i = 0; i < 300; i++) fx.update(1 / 30, snap({}), []);
  const st = fx.v6.stats();
  const dbg = fx.getDebugInfo();
  fx.dispose();
  return { peak, actors: st.kit.actors, errors: dbg.events.errors, cap: st.kit.cap };
}

// ---------------------------------------------------------------- 1. бюджет частиц
const peaks = {};
for (const q of ['medium', 'low', 'high']) {
  const r = await sweep(q, 'ashen');
  peaks[q] = r.peak;
  if (process.env.SPELLFX_BASE) continue;
  ok(r.peak <= Math.round(BASE[q] * 1.15), `${q}: пик частиц ${r.peak} ≤ main ${BASE[q]} +15% (${Math.round(BASE[q] * 1.15)})`);
  ok(r.errors === 0, `${q}: ошибок обработки событий 0, а их ${r.errors}`);
  ok(r.actors === 0, `${q}: все акторы завершились (${r.actors})`);
}
if (process.env.SPELLFX_BASE) { console.log(JSON.stringify(peaks)); process.exit(0); }

// ---------------------------------------------------------------- 2. «без каши»: доли частиц по свежести
{
  const { fx } = makeFx({ quality: 'medium', volume: 0, reducedMotion: false });
  await fx.v6.ready;
  const kit = fx.v6.kit;
  fx.update(1 / 60, snap({}), []);
  const a = kit.scope('t:a'); kit.enterScope(null);
  ok(kit.scopeShare(a) === 1, 'одна сцена — все частицы');
  const b = kit.scope('t:b'); kit.enterScope(null);
  ok(kit.scopeShare(a) === 1 && kit.scopeShare(b) === 1, 'две сцены — без урезания');
  fx.update(1 / 60, snap({}), []);
  const c = kit.scope('t:c'); kit.enterScope(null);
  const d = kit.scope('t:d'); kit.enterScope(null);
  ok(kit.scopeShare(d) === 1, '4 сцены: новейшая — 100%');
  ok(kit.scopeShare(c) < 1 && kit.scopeShare(b) < kit.scopeShare(c) && kit.scopeShare(a) <= kit.scopeShare(b), '4 сцены: старые урезаны по свежести');
  ok(kit.scopeShare(null) < 1, 'толчея: фон без сцены урезан');
  // число частиц: одна и та же вспышка искр в старой сцене меньше, чем в новой
  const count = (s, essential) => { const prev = kit.enterScope(s); let n = 0; for (let i = 0; i < 40; i++) n += kit.emit({ at: v3(0, 1, 0), count: 10, essential, life: 0.05 }); kit.enterScope(prev); return n; };
  const nNew = count(d, false), nOld = count(a, false), nOldE = count(a, true);
  ok(nOld < nNew * 0.6, `старая сцена получает меньше частиц (${nOld} против ${nNew})`);
  ok(nOldE >= nNew * 0.5, `essential в старой сцене не ниже ~60% (${nOldE})`);
  // повтор ключа: одна сцена «молодеет», а не плодит новые; очередь (renew:false) — свежесть от начала
  const before = kit.stats().scopes;
  kit.scope('t:b', undefined, false); kit.enterScope(null);
  ok(kit.stats().scopes === before && kit.scopeShare(b) < 1, 'очередь: тот же ключ — та же сцена, не молодеет');
  kit.scope('t:a'); kit.enterScope(null);
  ok(kit.stats().scopes === before && kit.scopeShare(a) === 1, 'тот же ключ — та же сцена, снова новейшая');
  // акторы наследуют сцену создателя
  let seen = null;
  kit.enterScope(c); kit.after(0.05, () => { seen = kit.currentScope; }); kit.enterScope(null);
  for (let i = 0; i < 10; i++) fx.update(1 / 60, snap({}), []);
  ok(seen === c, 'after() выполняется в сцене создателя');
  // сцены отмирают
  for (let i = 0; i < 90; i++) fx.update(1 / 60, snap({}), []);
  ok(kit.stats().scopes === 0 && kit.scopeShare(null) === 1, 'сцены отмирают, фон снова 100%');
  // событие каста открывает сцену с ключом заклинания
  fx.update(1 / 60, snap({}), [ev('rune_cast', chest, { rune: 'ignis', from: chest, to: core })]);
  ok(kit.stats().scopes >= 1, 'rune_cast открывает сцену');
  ok(kit.currentScope === null, 'после события текущая сцена сброшена');
  fx.dispose();
}

// ---------------------------------------------------------------- 3. цвет героя
{
  const { ELEMENTS, heroElement } = await import(ROOT + 'modules/fx/glsl.js');
  const want = { ashen: 'fire', elf: 'storm', dark: 'void', ranger: 'wind', archmage: 'tempest' };
  for (const [id, el] of Object.entries(want)) ok(heroElement(id) === el, `герой ${id} → стихия ${el}`);
  ok(ELEMENTS.tempest && ELEMENTS.void.black !== undefined, 'палитры бури и чёрного ядра тьмы есть');
  const hx = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const [fr, fg, fb] = hx(ELEMENTS.fire.mid); ok(fr > fg && fg > fb && fr > 200, 'огонь — оранжевый');
  const [wr, wg, wb] = hx(ELEMENTS.wind.mid); ok(wg > wr + 60 && wg > wb, 'ветер — изумрудный');
  const [tr, tg, tb] = hx(ELEMENTS.tempest.mid); ok(tb > 200 && tb > tg && tg > tr, 'буря — электрик');
  const [vr, vg, vb] = hx(ELEMENTS.void.mid); ok(vb > vg && vr > vg, 'тьма — фиолетовая');
  const [sr, sg, sb] = hx(ELEMENTS.storm.mid); ok(sb > 200 && sr > 100, 'гроза — бело-голубая');
  const settings = { quality: 'medium', volume: 0, reducedMotion: false, hero: 'archmage' };
  const { fx } = makeFx(settings);
  await fx.v6.ready;
  const F = fx.v6.fx;
  ok(F.heroEl(null) === 'tempest' && F.heroPal(null) === ELEMENTS.tempest, 'Архимаг: буря');
  ok(F.heroEl({ remote: true }) === 'rival', 'соперник — фиолетовый');
  settings.hero = 'dark';
  ok(F.heroEl(null) === 'void', 'смена героя на лету: тьма');
  fx.dispose();
}

// ---------------------------------------------------------------- 4. предвестник, руна в воздухе, комета
{
  const common = await import(ROOT + 'modules/fx/common.js');
  for (const q of ['low', 'medium', 'high']) {
    const { fx } = makeFx({ quality: q, volume: 0, reducedMotion: false, hero: 'dark' });
    await fx.v6.ready;
    const F = fx.v6.fx, kit = fx.v6.kit;
    const calm = snap({}); calm.player.regen = false; calm.player.warded = false;   // без постоянных лент регена
    fx.update(1 / 60, calm, []);
    const c = common.caster(F, null, {});
    common.herald(F, c.hand, 'void', false, { symbol: 'vee', dir: c.dir });
    const air = common.airRune(F, c, 'vee', 'void', {});
    ok(air && air.pos && air.launchAt > kit.clock && typeof air.plan === 'function', `${q}: руна в воздухе — контракт air`);
    air.plan('absorb', c.chest);
    const comets = common.createComet(F);
    const k = comets.start(c.hand, 'void', { size: 0.4, look: 'void' });
    ok(!!k, `${q}: комета создаётся`);
    const p = new THREE.Vector3().copy(c.hand), dir = new THREE.Vector3().subVectors(c.target, c.hand).normalize();
    for (let i = 0; i < 20; i++) { p.addScaledVector(dir, 0.6); k.step(p, dir, 1 / 30); fx.update(1 / 30, calm, []); }
    ok(!fx.v6.stats().sub.trails || fx.v6.stats().sub.trails.active >= 1, `${q}: у кометы есть лента`);
    k.end(p);
    ok(comets.active() === 0, `${q}: комета вернулась в пул`);
    for (let i = 0; i < 120; i++) fx.update(1 / 30, calm, []);
    const st = fx.v6.stats();
    ok(st.kit.actors === 0, `${q}: акторы руны в воздухе завершились (${st.kit.actors})`);
    ok(!st.sub.trails || st.sub.trails.active === 0, `${q}: ленты комет погасли`);
    ok(st.kit.particles <= st.kit.cap, `${q}: частицы в пределах ёмкости`);
    if (q === 'low') ok(st.kit.lights === 0, 'low: без света');
    fx.dispose();
  }
}

const handlerWarns = warns.filter((w) => /\[fx\/v6\] (h:|every:|upd:)|\[fx\/kit\]/.test(w));
ok(handlerWarns.length === 0, 'обработчики V6 без исключений: ' + handlerWarns.slice(0, 5).join(' | '));
console.warn = origWarn;
if (fails) { console.error(`spellFx: ${fails} FAIL`); process.exit(1); }
console.log(`spellFx: OK (пик частиц medium ${peaks.medium}/${Math.round(BASE.medium * 1.15)}, low ${peaks.low}/${Math.round(BASE.low * 1.15)}, high ${peaks.high}/${Math.round(BASE.high * 1.15)})`);
