// ASHEN OATH — dev/fx.test.mjs. Владелец: №7 [VFX].
// Эффекты V6 без браузера: modules/effects.js + modules/fx/* грузятся, каждое событие боя (10 рун, печати,
// приёмы, лук и магия ладони по C3, PvP с data.remote, появление/смерть) обрабатывается без исключений,
// лимиты частиц и хит-стопа соблюдаются, reducedMotion гасит тряску, fxMagic:false — откат к старым эффектам.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const cands = [process.env.ASHEN_THREE, '/tmp/claude-0/-home-user-ADMIT-STUTU/9bbb049c-276b-5b57-99ba-3d679f5528c8/scratchpad/vendor/three-0.185.1/package/build/three.module.js'].filter(Boolean);
  for (const c of cands) { if (existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); break; } catch (e2) { /* skip */ } } }
}
if (!THREE) { console.log('SKIP fx: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const { createEffects } = await import('../modules/effects.js');
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
      warded: true, bastion: !!o.bastion, bastionRemaining: 3, vortex: !!o.vortex, vortexRemaining: 2, regen: true, regenRemaining: 3, burstCharge: 0.5 },
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

// ---------------------------------------------------------------- 1. загрузка V6
const settings = { quality: 'medium', volume: 0, reducedMotion: false };
const { fx } = makeFx(settings);
ok(fx.v6, 'слой V6 создан');
await fx.v6.ready;
const loaded = fx.v6.stats().loaded;
ok(loaded.failed.length === 0, 'все модули V6 загружены, сбой: ' + loaded.failed.join(','));
ok(loaded.subsystems.length === 6, 'подсистем 6: ' + loaded.subsystems.join(','));
ok(loaded.choreo.length === 13, 'хореографий 13: ' + loaded.choreo.length);

// ---------------------------------------------------------------- 2. все события: свои и соперника
const inputs = [null, { valid: true, hands: { drawing: true, trail: [{ x: 0.6, y: 0.3 }, { x: 0.7, y: 0.5 }, { x: 0.55, y: 0.5 }], right: { shape: 'point' } },
  bow: { active: true, draw: 0.7, aimX: 0, aimY: 0, charged: false, release: false, element: 'frost' }, handSpell: { phase: 'hold', element: 'storm', power: 0.6, dir: { x: 0, y: 0 } } }];
let maxParticles = 0, maxHit = 0;
for (const pvp of [false, true]) {
  for (const remote of pvp ? [false, true] : [false]) {
    for (const group of eventsFor(remote)) {
      const s = snap({ pvp, vortex: true, bastion: true, stun: true, slow: true, mark: true, shield: true,
        projectiles: [{ id: 'caret:1', owner: 'player', kind: 'spark', position: v3(0, 2, 3), velocity: v3(0, 0, -30), radius: 0.2 },
          { id: 'a1', owner: 'player', kind: 'arrow', element: 'fire', position: v3(0, 1.8, 3), velocity: v3(0, 0, -40), radius: 0.08 },
          { id: 'h1', owner: 'player', kind: 'hand_orb', element: 'earth', position: v3(0, 1.8, 2), velocity: v3(0, 0, -20), radius: 0.3 }] });
      fx.setInput(inputs[eid % 2]);
      fx.update(1 / 60, s, group);
      for (let i = 0; i < 40; i++) fx.update(1 / 60, s, []);
      const k = fx.v6.stats().kit;
      maxParticles = Math.max(maxParticles, k.particles);
      maxHit = Math.max(maxHit, fx.takeHitStop());
    }
  }
}
// PvP: касты соперника (modules/pvp.js шлёт pvp_opponent_cast) рисует V6
ok(fx.v6.handle('pvp_opponent_cast', ev('pvp_opponent_cast', core, {}), { sourceType: 'rune_cast', rune: 'ignis', from: core, to: chest, remote: true }) === true, 'pvp_opponent_cast → руна соперника');
fx.update(1 / 60, snap({ pvp: true, projectiles: [{ id: 'opp:p1', owner: 'opponent', kind: 'bolt', remote: true, position: v3(0, 1.5, 2), velocity: v3(0, 0, 30), radius: 0.2 }] }), []);
ok(fx.supportsRemote === true, 'effects.supportsRemote для net/session.js');
// дожить все отложенные акторы
const s0 = snap({});
for (let i = 0; i < 240; i++) fx.update(1 / 30, s0, []);
const dbg = fx.getDebugInfo();
ok(dbg.events.errors === 0, 'ошибок обработки событий 0, а их ' + dbg.events.errors);
const handlerWarns = warns.filter((w) => /\[fx\/v6\] (h:|every:|upd:)|\[fx\/kit\]/.test(w));
ok(handlerWarns.length === 0, 'обработчики V6 без исключений: ' + handlerWarns.slice(0, 5).join(' | '));
ok(maxParticles <= dbg.v6.kit.cap, `частиц не больше ёмкости (${maxParticles}/${dbg.v6.kit.cap})`);
ok(dbg.v6.kit.cap + dbg.particles.glowCap + dbg.particles.dustCap <= 6000, 'medium: частиц ≤ 6000 вместе со старыми пулами');
ok(maxHit <= 160, 'хит-стоп ≤ 160 мс: ' + maxHit);
ok(dbg.v6.kit.actors === 0, 'все акторы завершились: ' + dbg.v6.kit.actors);

// ---------------------------------------------------------------- 3. reducedMotion: без тряски камеры
settings.reducedMotion = true;
fx.update(1 / 60, snap({}), [ev('player_hit', chest, { amount: 40 }), ev('rune_cast', chest, { rune: 'fulgur', from: chest, to: core })]);
for (let i = 0; i < 10; i++) fx.update(1 / 60, snap({}), []);
const imp = fx.getCameraImpulse();
ok(Math.hypot(imp.x, imp.y, imp.z) === 0, 'reducedMotion: импульс камеры 0');
settings.reducedMotion = false;

// ---------------------------------------------------------------- 4. качество: пулы меняются, low без света
for (const q of ['low', 'high', 'medium']) {
  fx.setQuality(q);
  fx.update(1 / 60, snap({}), [ev('rune_cast', chest, { rune: 'ignis', from: chest, to: core })]);
  for (let i = 0; i < 30; i++) fx.update(1 / 60, snap({}), []);
  const st = fx.v6.stats().kit;
  ok(st.particles <= st.cap, `${q}: частицы в пределах ёмкости`);
}

// ---------------------------------------------------------------- 5. откат: fxMagic:false — V6 выключен, старые эффекты живы
const s2 = { quality: 'medium', volume: 0, reducedMotion: false, fxMagic: false };
const { fx: fx2 } = makeFx(s2);
ok(!fx2.v6, 'fxMagic:false — слой V6 не создаётся');
fx2.update(1 / 60, snap({}), [ev('rune_cast', chest, { rune: 'ignis', from: chest, to: core })]);
for (let i = 0; i < 10; i++) fx2.update(1 / 60, snap({}), []);
ok(fx2.getDebugInfo().particles.glow > 0, 'старый эффект руны рисуется');
// живое выключение
settings.fxMagic = false;
fx.update(1 / 60, snap({}), [ev('rune_cast', chest, { rune: 'orbis', from: chest, to: chest })]);
ok(fx.v6.enabled === false, 'fxMagic:false на лету выключает V6');
settings.fxMagic = true;
fx.update(1 / 60, snap({}), []);
ok(fx.v6.enabled === true, 'fxMagic:true на лету включает V6');

fx.dispose(); fx2.dispose();
console.warn = origWarn;
if (fails) { console.error(`fx: ${fails} FAIL`); process.exit(1); }
console.log(`fx: OK (частиц на пике ${maxParticles}, хит-стоп до ${maxHit} мс, событий ${dbg.events.processed})`);
