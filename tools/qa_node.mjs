// QA симуляции без браузера: node tools/qa_node.mjs
// Проверяет контракт снимка/событий, направление moveX на экране (combat + cameraRig),
// одноразовость импульсов, победу/поражение/reset, 10 минут боя и ограниченность массивов.
// Модули берутся из modules/: это настоящие combat №4 и boss №5 после интеграции.

import { config } from '../config.js';
import { createBossBrain } from '../modules/boss.js';
import { createCombat } from '../modules/combat.js';
import { createCameraRig } from '../core/cameraRig.js';

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const DT = 1 / 60;
const inp = (p = {}) => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, dash: 0, attack: false, shield: false, burst: false, ...p });
const INVALID = { source: 'cv', valid: false, calibrated: true, tMs: 0, moveX: 1, dash: 1, attack: true, shield: true, burst: true };
config.settings = { ...config.defaultSettings };
let seedN = 1;
const make = (seed) => { config.boss.seed = seed ?? seedN++; const brain = createBossBrain(config); return createCombat({ config, bossBrain: brain }); };
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isVec = (p) => p && isNum(p.x) && isNum(p.y) && isNum(p.z);

function validateSnapshot(s) {
  const errs = [];
  if (!['playing', 'victory', 'defeat'].includes(s.status)) errs.push('status');
  if (!isNum(s.time)) errs.push('time');
  const p = s.player, b = s.boss;
  if (!isVec(p.position) || !isNum(p.yaw) || !isNum(p.hp) || !isNum(p.maxHp) || !isNum(p.energy) || !isNum(p.maxEnergy)) errs.push('player nums');
  if (!['idle', 'move', 'dash', 'cast', 'shield', 'hit', 'dead'].includes(p.action)) errs.push('player.action=' + p.action);
  if (typeof p.invulnerable !== 'boolean' || typeof p.shielding !== 'boolean') errs.push('player bools');
  if (!isVec(b.position) || !isNum(b.yaw) || !isNum(b.hp) || !isNum(b.maxHp) || ![1, 2].includes(b.stage)) errs.push('boss nums');
  if (!['idle', 'windup', 'attack', 'recover', 'hit', 'dead'].includes(b.action)) errs.push('boss.action=' + b.action);
  const c = s.cooldowns;
  if (![c.dashRemaining, c.dashTotal, c.burstRemaining, c.burstTotal].every(isNum)) errs.push('cooldowns');
  if (!Array.isArray(s.projectiles) || !Array.isArray(s.telegraphs)) errs.push('arrays');
  for (const pr of s.projectiles) if (!pr.id || !['player', 'boss'].includes(pr.owner) || !['bolt', 'orb'].includes(pr.kind) || !isVec(pr.position) || !isVec(pr.velocity) || !isNum(pr.radius)) errs.push('projectile');
  for (const t of s.telegraphs) if (!t.id || !['slam', 'orb', 'nova'].includes(t.kind) || !isVec(t.origin) || !isVec(t.target) || !isNum(t.radius) || !isNum(t.remaining) || !isNum(t.duration) || typeof t.blockable !== 'boolean') errs.push('telegraph');
  const st = s.stats;
  if (![st.damageDealt, st.damageTaken, st.dodges, st.blocks].every(isNum)) errs.push('stats');
  return errs;
}

// 1. Контракт начального снимка
{
  const c = make();
  const s = c.getSnapshot();
  const errs = validateSnapshot(s);
  check('начальный снимок соответствует ASHEN_V1', errs.length === 0, errs.join(','));
  check('старт: босс (0,0,0), герой (0,0,6)', s.boss.position.x === 0 && s.boss.position.z === 0 && Math.abs(s.player.position.z - 6) < 1e-6);
  s.player.hp = -999; s.projectiles.push({});
  const s2 = c.getSnapshot();
  check('снимок read-only (мутация копии не влияет на бой)', s2.player.hp === s2.player.maxHp && s2.projectiles.length === 0);
}

// 2. moveX > 0 ⇒ движение вправо НА ЭКРАНЕ (для разных позиций на окружности)
{
  const rig = createCameraRig(config.camera);
  let allOk = true;
  const detail = [];
  for (const startMoves of [0, 40, 110, 200]) {
    const c = make();
    // сместиться по кругу в новую стартовую точку
    for (let i = 0; i < startMoves; i++) c.update(DT, inp({ moveX: 1 }));
    const s0 = c.getSnapshot();
    rig.reset(s0.player.position, s0.boss.position);
    const cam = rig.update(DT, s0.player.position, s0.boss.position, null);
    for (const dir of [1, -1]) {
      const c2 = make();
      for (let i = 0; i < startMoves; i++) c2.update(DT, inp({ moveX: 1 }));
      const a = c2.getSnapshot().player.position;
      for (let i = 0; i < 20; i++) c2.update(DT, inp({ moveX: dir }));
      const b = c2.getSnapshot().player.position;
      // экранная X-проекция через матрицу вида камеры: right = normalize(forward × up)
      const f = { x: cam.target.x - cam.position.x, y: cam.target.y - cam.position.y, z: cam.target.z - cam.position.z };
      const right = { x: -f.z, y: 0, z: f.x }; // f × (0,1,0)
      const dx = (b.x - a.x) * right.x + (b.z - a.z) * right.z;
      const ok = Math.sign(dx) === dir;
      if (!ok) allOk = false;
      detail.push(`pos#${startMoves} moveX=${dir}: screenΔ=${dx.toFixed(3)}`);
    }
  }
  check('moveX совпадает с экранным направлением (4 позиции × 2 стороны)', allOk, allOk ? '' : detail.join('; '));
}

// 3. Импульс рывка одноразовый; невалидный ввод ничего не делает
{
  const c = make();
  c.update(DT, inp({ dash: 1 }));
  let dashes = c.drainEvents().filter((e) => e.type === 'player_dash').length;
  for (let i = 0; i < 120; i++) { c.update(DT, inp()); dashes += c.drainEvents().filter((e) => e.type === 'player_dash').length; }
  check('один dash-импульс → ровно один рывок', dashes === 1, `рывков: ${dashes}`);

  const c2 = make();
  const p0 = c2.getSnapshot().player.position;
  for (let i = 0; i < 60; i++) c2.update(DT, INVALID);
  const s = c2.getSnapshot();
  const moved = Math.hypot(s.player.position.x - p0.x, s.player.position.z - p0.z);
  const evs = c2.drainEvents().filter((e) => e.type.startsWith('player_') || e.type.startsWith('shield'));
  check('невалидный ввод обнуляет управление', moved < 1e-6 && evs.length === 0 && !s.player.shielding, `сдвиг ${moved.toFixed(4)}, событий игрока ${evs.length}`);
}

// 4. Одновременные руки: только одна способность за раз
{
  const c = make();
  c.update(DT, inp({ attack: true, shield: true }));
  const s = c.getSnapshot();
  const casts = c.drainEvents().filter((e) => e.type === 'player_cast').length;
  check('attack+shield одновременно: щит, без выстрела', s.player.shielding && casts === 0, `shield=${s.player.shielding} casts=${casts}`);
}

// 5. Бот-победа, пассивное поражение, reset
function runBot(c, seconds, policy) {
  const all = [];
  let maxProj = 0, maxTel = 0, maxEv = 0, nan = false;
  for (let i = 0; i < seconds * 60; i++) {
    const s = c.getSnapshot();
    if (s.status !== 'playing') break;
    c.update(DT, policy(s, i));
    const ev = c.drainEvents();
    maxEv = Math.max(maxEv, ev.length);
    for (const e of ev) all.push(e);
    if (all.length > 20000) all.splice(0, all.length - 20000);
    const s2 = c.getSnapshot();
    maxProj = Math.max(maxProj, s2.projectiles.length);
    maxTel = Math.max(maxTel, s2.telegraphs.length);
    if (validateSnapshot(s2).length) nan = true;
  }
  return { snap: c.getSnapshot(), events: all, maxProj, maxTel, maxEv, nan };
}
const smartBot = (s) => {
  const t = s.telegraphs[0];
  const p = s.player.position;
  // Реакция бота с упреждением; позиция героя в момент решения — как у живого игрока.
  if (t && t.kind === 'slam' && Math.hypot(p.x - t.target.x, p.z - t.target.z) < t.radius + 1.2) return inp({ moveX: 1 });
  if (t && (t.kind === 'nova' || t.kind === 'orb') && t.remaining < 0.6) return inp({ shield: true });
  if (s.projectiles.some((pr) => pr.owner === 'boss')) return inp({ shield: true });
  if (s.player.energy >= 70 && s.cooldowns.burstRemaining <= 0 && s.boss.action !== 'windup') return inp({ burst: true });
  return inp({ attack: true });
};
{
  const c = make();
  const r = runBot(c, 300, smartBot);
  check('бот с контригрой побеждает (настоящие combat №4 + boss №5)', r.snap.status === 'victory', `status=${r.snap.status} t=${r.snap.time.toFixed(1)}с hpИгрока=${r.snap.player.hp.toFixed(0)} hpБосса=${r.snap.boss.hp}`);
  const types = new Set(r.events.map((e) => e.type));
  const needed = ['player_cast', 'boss_hit', 'boss_windup', 'boss_impact', 'boss_phase', 'boss_projectile', 'shield_start', 'shield_end', 'block', 'burst', 'victory'];
  const missing = needed.filter((x) => !types.has(x));
  check('в победном бою возникают основные события', missing.length === 0, missing.length ? 'нет: ' + missing.join(',') : '');
  const ids = new Set(r.events.map((e) => e.id));
  check('id событий уникальны, data — объект', ids.size === r.events.length && r.events.every((e) => e.data && typeof e.data === 'object' && isVec(e.position)));
  check('вторая фаза наступила', r.events.some((e) => e.type === 'boss_phase' && e.data.stage === 2));
  // После исхода бой остановлен
  const before = JSON.stringify(c.getSnapshot());
  for (let i = 0; i < 60; i++) c.update(DT, inp({ attack: true, dash: 1 }));
  check('после победы update ничего не меняет', JSON.stringify(c.getSnapshot()) === before && c.drainEvents().length === 0);
  c.reset();
  const s = c.getSnapshot();
  check('reset восстанавливает бой', s.status === 'playing' && s.boss.hp === s.boss.maxHp && s.player.hp === s.player.maxHp && s.boss.stage === 1 && s.time === 0 && s.projectiles.length === 0 && s.telegraphs.length === 0);
}
{
  const c = make();
  const r = runBot(c, 300, () => inp());
  check('пассивный игрок проигрывает', r.snap.status === 'defeat', `status=${r.snap.status} t=${r.snap.time.toFixed(1)}с`);
  check('событие defeat отправлено один раз', r.events.filter((e) => e.type === 'defeat').length === 1);
}

// 5b. Бот с задержкой реакции (как CV + человек): решение по снимку 0.35 с назад, 10 seed
{
  const LAG = Math.round(0.35 * 60);
  const outcomes = [];
  for (let seed = 101; seed <= 110; seed++) {
    const c = make(seed);
    const hist = [];
    const r = runBot(c, 300, (s) => { hist.push(s); if (hist.length > LAG + 1) hist.shift(); return smartBot(hist[0]); });
    outcomes.push({ seed, status: r.snap.status, t: +r.snap.time.toFixed(1), hp: Math.round(r.snap.player.hp) });
  }
  const wins = outcomes.filter((o) => o.status === 'victory');
  const avgT = wins.length ? (wins.reduce((a, o) => a + o.t, 0) / wins.length).toFixed(1) : '-';
  const minHp = wins.length ? Math.min(...wins.map((o) => o.hp)) : '-';
  check('бот с задержкой 0.35 с: бой выигрываем на всех 10 seed', wins.length === 10,
    `побед ${wins.length}/10, среднее время ${avgT} с, мин. остаток HP ${minHp}; ` + outcomes.filter((o) => o.status !== 'victory').map((o) => `seed ${o.seed}: ${o.status}`).join(', '));
}

// 5c. «Перстни»: руны, сила выброса, комбо, идеальный рывок
{
  const step = (c, n, p = {}) => { const ev = []; for (let i = 0; i < n; i++) { c.update(DT, inp(p)); ev.push(...c.drainEvents()); } return ev; };
  // ИГНИС: урон, откат, отказ на откате
  let c = make(900);
  step(c, 30);
  const hp0 = c.getSnapshot().boss.hp;
  let ev = step(c, 1, { rune: 'ignis' });
  ev.push(...step(c, 5));
  const cast = ev.find((e) => e.type === 'rune_cast' && e.data.rune === 'ignis');
  const hp1 = c.getSnapshot().boss.hp;
  check('руна ИГНИС: rune_cast и урон ≈70', !!cast && hp0 - hp1 >= 69, `урон ${(hp0 - hp1).toFixed(1)}`);
  ev = step(c, 1, { rune: 'ignis' });
  check('руна на откате → ability_denied', ev.some((e) => e.type === 'ability_denied' && e.data.rune === 'ignis' && e.data.reason === 'cooldown'));
  check('снимок: cooldowns.runes.ignis', c.getSnapshot().cooldowns.runes.ignis.remaining > 9);
  // ФУЛЬГУР: срыв телеграфа, оглушение, мозг стоит
  c = make(901);
  let tel = null;
  for (let i = 0; i < 60 * 8 && !tel; i++) { c.update(DT, inp()); c.drainEvents(); tel = c.getSnapshot().telegraphs[0] || null; }
  ev = step(c, 1, { rune: 'fulgur' });
  const s1 = c.getSnapshot();
  check('руна ФУЛЬГУР: телеграф снят, страж оглушён', !!tel && s1.telegraphs.length === 0 && s1.boss.stunned && ev.some((e) => e.type === 'telegraph_cancel') && ev.some((e) => e.type === 'boss_stunned'), `tel=${!!tel} left=${s1.telegraphs.length} stunned=${s1.boss.stunned}`);
  ev = step(c, Math.round(2.3 * 60));
  check('во время оглушения нет новых атак', !ev.some((e) => e.type === 'boss_windup' || e.type === 'boss_impact'));
  // ОРБИС: лечение и оберег гасит удар
  c = make(902);
  let hit = false;
  for (let i = 0; i < 60 * 30 && !hit; i++) { c.update(DT, inp()); hit = c.drainEvents().some((e) => e.type === 'player_hit'); }
  const hpA = c.getSnapshot().player.hp;
  ev = step(c, 1, { rune: 'orbis' });
  const sO = c.getSnapshot();
  check('руна ОРБИС: +HP и оберег', sO.player.hp > hpA && sO.player.warded, `hp ${hpA}→${sO.player.hp}`);
  let absorbed = false, took = false;
  for (let i = 0; i < 60 * 6 && !absorbed && !took; i++) { c.update(DT, inp()); const e2 = c.drainEvents(); absorbed = e2.some((e) => e.type === 'block' && e.data.ward); took = e2.some((e) => e.type === 'player_hit'); }
  check('оберег поглощает следующий удар', absorbed && !took, `absorbed=${absorbed} took=${took}`);
  // сила выброса
  const burstDmg = (power) => { const cc = make(903); step(cc, 10); const e3 = step(cc, 1, { burst: true, burstPower: power }); step(cc, 40); return e3.concat(cc.drainEvents()).filter((e) => e.type === 'boss_hit' && e.data.source === 'burst').reduce((a, e) => a + e.data.amount, 0); };
  const weak = burstDmg(0.3), strong = burstDmg(1);
  check('сила выброса зависит от заряда кулака', strong > weak * 1.4, `0.3→${weak.toFixed(0)}, 1.0→${strong.toFixed(0)}`);
  // комбо растёт от попаданий и рвётся при уроне
  c = make(904);
  let maxCombo = 0, broke = false;
  for (let i = 0; i < 60 * 25; i++) { c.update(DT, inp({ attack: true })); const e4 = c.drainEvents(); if (e4.some((e) => e.type === 'combo_break')) broke = true; maxCombo = Math.max(maxCombo, c.getSnapshot().player.combo); }
  check('комбо растёт и рвётся при полученном уроне', maxCombo >= 10 && broke, `макс. серия ${maxCombo}, разрыв=${broke}`);
  // идеальный рывок: рывок прямо перед ударом novа
  c = make(905);
  let perfect = false;
  for (let i = 0; i < 60 * 40 && !perfect; i++) {
    const s = c.getSnapshot();
    const t = s.telegraphs.find((x) => x.kind === 'nova' || x.kind === 'slam');
    const dash = t && t.remaining < 0.1 && t.remaining > 0.05 && s.cooldowns.dashRemaining <= 0 ? 1 : 0;
    c.update(DT, inp({ dash }));
    perfect = c.drainEvents().some((e) => e.type === 'perfect_dodge');
  }
  check('идеальный рывок: событие perfect_dodge', perfect);
}

// 6. 10 минут игрового времени со случайным вводом (с бессмертием через reset при исходе)
{
  const c = make();
  let maxProj = 0, maxTel = 0, maxEv = 0, bad = 0, resets = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 600 * 60; i++) {
    if (c.getSnapshot().status !== 'playing') { c.reset(); resets++; }
    c.update(DT, inp({ moveX: rnd() * 2 - 1, dash: rnd() < 0.01 ? (rnd() < 0.5 ? -1 : 1) : 0, attack: rnd() < 0.6, shield: rnd() < 0.3, burst: rnd() < 0.005 }));
    const ev = c.drainEvents();
    maxEv = Math.max(maxEv, ev.length);
    if (i % 30 === 0) {
      const s = c.getSnapshot();
      maxProj = Math.max(maxProj, s.projectiles.length);
      maxTel = Math.max(maxTel, s.telegraphs.length);
      if (validateSnapshot(s).length) bad++;
    }
  }
  check('10 минут боя: снимки валидны', bad === 0, `невалидных: ${bad}`);
  check('10 минут боя: массивы ограничены', maxProj <= 48 && maxTel <= 8 && maxEv <= 256, `max projectiles=${maxProj}, telegraphs=${maxTel}, events/кадр=${maxEv}, reset=${resets}`);
}

// 7. Камера: не выходит за кольцо стен и держит дистанцию
{
  const rig = createCameraRig(config.camera);
  const boss = { x: 0, y: 0, z: 0 };
  let maxR = 0, minD = Infinity, maxD = 0;
  for (let i = 0; i < 2000; i++) {
    const a = i * 0.02 + Math.sin(i * 0.37) * 0.5;
    const p = { x: Math.sin(a) * 6, y: 0, z: Math.cos(a) * 6 };
    const c = rig.update(DT, p, boss, { x: 1, y: 1, z: 1 });
    maxR = Math.max(maxR, Math.hypot(c.position.x, c.position.z));
    const d = Math.hypot(c.position.x - p.x, c.position.z - p.z);
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
  check('камера внутри кольца стен', maxR <= config.camera.maxRadiusFromCenter + config.camera.maxImpulse * 2 + 0.01, `max r=${maxR.toFixed(2)}`);
  check('дистанция камера–герой в разумных пределах', minD > 2.5 && maxD < 8, `${minD.toFixed(2)}..${maxD.toFixed(2)} м`);
}

console.log(results.join('\n'));
console.log(failures ? `\n${failures} FAIL` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
