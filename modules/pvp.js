// =============================================================================
// pvp.js — ASHEN OATH · [PVP] №3 · дуэль игрок против игрока
// -----------------------------------------------------------------------------
// Вся логика дуэли. combat.js содержит только хуки [PVP] (attachPvp/setMode/setOpponent/
// applyRemoteHit) и вызывает объект из buildHooks(K) — K это внутренности боя.
//
// Разделы:
//   PVP_DEFAULTS / mergePvpConfig   — баланс PvP (config.pvp переопределяет)
//   buildHooks                      — хуки для combat.js: цель, попадания, приём hit, статусы fx
//   createRemoteBuffer              — интерполяция соперника по сообщениям st (20 Гц)
//   createMemoryNetPair / createLocalNet — заглушки сети C6 (тесты / две вкладки BroadcastChannel)
//   createPvpSession                — раунды (ведёт хост, сообщения duel), статистика, обрыв сети
//   createPvpView / createPvpController — DOM-панель, заглушка модели соперника, клей для main.js
//
// Честность при лаге (см. BUILD_STATUS «V6 · PVP»): попадание засчитывает АТАКУЮЩИЙ по
// интерполированной позиции соперника, вынесенной вперёд на ~½ RTT; ЖЕРТВА может отменить его
// только защитой (рывок, щит, парирование, оберег, бастион, неуязвимость появления), активной в
// окне [t удара − 150 мс, сейчас], где t удара = получение − ½ RTT.
// Без DOM на верхнем уровне: модуль импортируется и в Node (dev/pvp.test.mjs).
// =============================================================================

export const PVP_API_VERSION = 'ASHEN_PVP_1';

export const PVP_DEFAULTS = Object.freeze({
  hp: 400,
  maxHitShare: 0.18,          // одно попадание снимает не больше 18% HP — ваншотов нет
  engageRange: 35,            // встреча engaged, когда соперник ближе
  hitbox: { radius: 0.45, height: 1.8, aimHeight: 1.15 },
  bodyDistance: 0.95,         // ближе к сопернику не подойти (капсулы не проходят друг сквозь друга)
  aimLead: 0.6,               // упреждение прицела по скорости соперника (доля)
  aimLeadSpeed: 32,           // м/с — для оценки времени полёта в упреждении
  maxLead: 0.35,              // с
  lagComp: 0.5,               // доля RTT, на которую хитбокс выносится вперёд (≈ половина RTT)
  lagCompMax: 0.15,           // с
  defenseBuffer: 0.15,        // с — защита жертвы, активная в пределах этого окна до удара, считается
  maxLagSec: 0.25,            // с — дольше ½ RTT не откатываем
  spawnInvuln: 1.5,           // неуязвимость после появления (с начала боя раунда)
  staggerAt: 36,              // урон, от которого жертва вздрагивает (hitReact)
  staggerTime: 0.22,
  stunMax: 0.8, slowMax: 2.5, slowFactor: 0.45, stunImmune: 1.2,
  markBonus: 0.2, markMax: 6,
  knockTime: 0.2, knockMax: 3.5,
  dotTime: 3,
  reflectMul: 0.8,            // парирование возвращает снаряд с этим уроном
  parrySuccessCd: 1.4,        // после удачного парирования — откат (в бою с Регентом его нет)
  parryEnergy: 5,
  reflectSpeed: 30,
  counterStagger: 0.6,        // парированный удар вблизи (рассечение/хлопок) сбивает атакующего
  igniteDist: 4,              // «Искра разгорается в полёте»: урон искры/огня растёт с 50% до 100% на первых метрах
  heal: 0.85,                 // лечение в PvP × (при HP 400 то же лечение вчетверо слабее, чем у героя со 100 HP)
  alpha: { cooldownMul: 0.5, energy: 20 }, // ℓ «Альфа»: откаты не сбрасываются, а сокращаются вдвое
  shield: { blockBase: 4, blockPerDmg: 0.25, brokenMul: 0.5 },
  // множители урона по способностям (урон боя с боссом × множитель, затем кап maxHitShare)
  dmg: {
    bolt: 0.7, spark: 0.75, slash: 0.5, burst: 0.45, sphere: 0.5, prism: 0.5, ignis: 0.5, fulgur: 1.0,
    stella: 0.5, caret: 0.9, vee: 0.9, clepsydra: 1, frame: 1, clap: 0.8, delta: 0.35, arrow: 0.6, hand_orb: 0.6,
    reflect: 1, default: 0.6,
  },
  // снаряды, которыми в PvP становятся мгновенные удары по Регенту
  shots: {
    ignis: { speed: 30, radius: 0.34, visual: 'sphere', element: 'fire', dot: 10 },
    fulgur: { speed: 44, radius: 0.26, visual: 'bolt', element: 'storm' },
    vee: { speed: 27, radius: 0.3, visual: 'bolt', element: 'earth' },
    clepsydra: { speed: 25, radius: 0.34, visual: 'sphere', element: 'frost', damage: 6 },
    frame: { speed: 30, radius: 0.28, visual: 'bolt', element: 'earth' },
    burst: { speed: 28, radius: 0.55, visual: 'sphere', element: 'fire', knock: 2.6 },
    caret: { speed: 36, radius: 0.18, visual: 'bolt' },
  },
  stella: { radius: 1.15, lead: 0.3, spread: 1.1 },
  clap: { radius: 5.5, stun: 0.6, knock: 2.2 },
  delta: { width: 0.8, range: 30 },
  unblockable: ['stella', 'clap'],
  melee: ['slash', 'clap'],                    // парирование вблизи: без урона + сбивает атакующего
  noParry: ['stella', 'delta'],                // лучи и метеоры парированием не отбить
  // откаты и прочие поля боя, заменяемые на время PvP (путь в конфиге боя → значение)
  override: {
    'dash.cost': 24, 'bolt.interval': 0.5, 'bolt.energyCost': 3, 'spark.cooldown': 0.8, 'spark.cost': 8, 'slash.cooldown': 1.3, 'slash.radius': 3.6,
    'burst.cooldown': 11, 'throw.cooldown': 1.6,
    'runes.ignis.cooldown': 11, 'runes.fulgur.cooldown': 14, 'runes.orbis.cooldown': 24, 'runes.stella.cooldown': 20,
    'runes.spira.cooldown': 16, 'runes.lemnis.cooldown': 32, 'runes.caret.cooldown': 7, 'runes.vee.cooldown': 14,
    'runes.clepsydra.cooldown': 18, 'runes.alpha.cooldown': 40,
    'sigils.clap.cooldown': 14, 'sigils.gate.cooldown': 24, 'sigils.frame.cooldown': 18, 'sigils.delta.cooldown': 26,
    'sigils.cor.cooldown': 38,
  },
  rounds: { toWin: 2, maxRounds: 5, countdown: 3, fightBanner: 0.9, roundEnd: 2.8, slowmo: 0.5, slowScale: 0.3, roundTime: 100, disconnectWait: 20 },
  net: { stHz: 20, interpDelayMs: 100, silentAfterMs: 8000, helloEveryMs: 800, deadResendMs: 500 },   // обрыв: net.state 'lost' или тишина дольше silentAfterMs
  spawnOffset: 12,
  // события соперника, которые подмешиваются в локальный поток с data.remote=true (у остальных типов
  // потребители сейчас рисуют СВОЕГО героя — их шлём, но показываем, только если тип в этом списке)
  remoteEventTypes: ['projectile_impact', 'rune_hit', 'sigil_hit', 'pvp_opponent_cast'],
  forwardEventTypes: ['player_cast', 'rune_cast', 'rune_hit', 'sigil_cast', 'sigil_hit', 'burst', 'player_slash',
    'player_dash', 'shield_start', 'shield_end', 'parry', 'block', 'dodge', 'projectile_impact', 'ward_start', 'bastion_start'],
});

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function deepMerge(base, patch) {
  if (!isObj(base)) return patch === undefined ? base : patch;
  const out = {};
  for (const k of Object.keys(base)) out[k] = isObj(base[k]) ? deepMerge(base[k], isObj(patch) ? patch[k] : undefined)
    : (isObj(patch) && patch[k] !== undefined && typeof patch[k] === typeof base[k] ? patch[k] : base[k]);
  if (isObj(patch)) for (const k of Object.keys(patch)) if (!(k in base)) out[k] = patch[k];
  return out;
}
export function mergePvpConfig(patch) {
  const src = isObj(patch) && isObj(patch.pvp) ? patch.pvp : patch;
  return deepMerge(PVP_DEFAULTS, isObj(src) ? src : {});
}

// Русские названия способностей (итог матча — «любимое заклинание»)
export const ABILITY_NAMES = Object.freeze({
  spark: 'Искра', slash: 'Рассечение', bolt: 'Огонь', sphere: 'Сфера', prism: 'Призма', burst: 'Выброс',
  ignis: 'Руна ▲ Игнис', fulgur: 'Руна ϟ Фульгур', orbis: 'Руна ○ Орбис', stella: 'Руна ★ Стелла', spira: 'Руна @ Спира',
  lemnis: 'Руна ∞ Лемнис', caret: 'Руна ^ Акус', vee: 'Руна V Жатва', clepsydra: 'Руна ⧗ Клепсидра', alpha: 'Руна ℓ Альфа',
  clap: 'Печать «Хлопок»', gate: 'Печать «Врата»', frame: 'Печать «Рамка»', delta: 'Печать ▲ «Дельта»', cor: 'Печать ♥ «Кор»',
  arrow: 'Лук', hand_orb: 'Заклинание рукой', parry: 'Парирование',
});

function getPath(o, path) { return path.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, path, v) {
  const ks = path.split('.'); const last = ks.pop();
  const t = ks.reduce((a, k) => (a == null ? a : a[k]), o);
  if (t && typeof t === 'object' && last in t) t[last] = v;
}

// -----------------------------------------------------------------------------
// Хуки для combat.js. K — внутренности боя (см. combat.js, блок [PVP] у attachPvp).
// -----------------------------------------------------------------------------
export function buildHooks(K, PC, opts = {}) {
  const clock = typeof opts.clock === 'function' ? opts.clock : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const C = K.C, BOSS = K.BOSS;
  const { vec, vcopy, clamp, distXZ } = K;
  let on = false;
  let saved = null;
  let tag = opts.tag || 'p';
  let ping = 0;                 // RTT, мс
  let acceptHits = true;        // фаза «бой»: вне её входящие удары отклоняются
  let frozen = false;           // отсчёт/конец раунда: герой стоит
  const outbox = [];            // сообщения в сеть: {t:'hit', ...}
  const pending = new Map();    // id удара → { kind, heal, t }
  const seen = new Set(), seenQ = [];
  const opp = {
    has: false, id: null, name: 'Соперник', hero: null,
    render: { x: 0, y: 0, z: 0 }, vel: { x: 0, z: 0 }, yaw: 0,
    hp: PC.hp, maxHp: PC.hp, energy: 100, maxEnergy: 100, action: 'idle', locomotion: 'idle',
    shielding: false, invulnerable: false, stunned: false, slowed: false, marked: false, dashing: false, dead: false,
  };
  const me = { stunT: 0, stunImmune: 0, slowT: 0, markT: 0, dotT: 0, dotDps: 0, knockT: 0, kx: 0, kz: 0, spawnT: 0, lastKind: null };
  const timed = [];             // метеоры «Стеллы» и тики «Дельты» атакующего
  const HN = 96;                // история защиты: кольцо на ~0.8 с при 120 Гц
  const hist = Array.from({ length: HN }, () => ({ t: -1e9, iframe: 0, parry: false, shield: false, ward: false, bastion: false, spawn: false, dashE: 0 }));
  let hi = 0;
  let ghosts = [];              // снаряды соперника для снимка (owner 'opponent')
  let lastStepAt = -1e9;        // когда бой последний раз шагал (пауза/заморозка — текущие флаги защиты не в счёт)
  let view = null;              // состояние раунда для snap.pvp (ставит сессия)
  const stats = { dealt: 0, taken: 0, sent: 0, landed: 0, dodged: 0, blocked: 0, parried: 0, maxTaken: 0, oppTaken: 0, casts: Object.create(null), takenBy: Object.create(null) };

  const P = () => K.st.p;
  const maxHit = () => C.player.maxHp * PC.maxHitShare;
  const mulOf = (kind) => num(PC.dmg[kind], num(PC.dmg.default, 0.6));

  function enable() {
    if (on) return;
    saved = {};
    const set = (path, v) => { saved[path] = getPath(C, path); setPath(C, path, v); };
    set('player.maxHp', PC.hp);
    set('player.minBossDistance', PC.bodyDistance);
    set('boss.hitRadius', PC.hitbox.radius);
    set('boss.height', PC.hitbox.height);
    set('boss.aimHeight', PC.hitbox.aimHeight);
    set('encounter.enabled', true);
    for (const [path, v] of Object.entries(PC.override || {})) if (typeof getPath(C, path) === 'number' && Number.isFinite(v)) set(path, v);
    for (const path of ['runes.orbis.heal', 'runes.lemnis.heal', 'sigils.cor.heal']) set(path, getPath(C, path) * PC.heal);
    on = true;
    resetState();
  }
  function disable() {
    if (!on) return;
    for (const [path, v] of Object.entries(saved || {})) setPath(C, path, v);
    saved = null;
    on = false;
    BOSS.x = K.BASE_BOSS.x; BOSS.y = K.BASE_BOSS.y; BOSS.z = K.BASE_BOSS.z;
    resetState();
  }
  function resetState() {
    Object.assign(me, { stunT: 0, stunImmune: 0, slowT: 0, markT: 0, dotT: 0, dotDps: 0, knockT: 0, kx: 0, kz: 0, spawnT: 0 });
    timed.length = 0; pending.clear(); outbox.length = 0; ghosts = [];
    for (const h of hist) h.t = -1e9;
  }

  // ---------------------------------------------------------------- соперник и цель
  function setOpponent(s) {
    if (!isObj(s) || !isObj(s.position)) { opp.has = false; return; }
    const p = s.position;
    if (![p.x, p.z].every(Number.isFinite)) { opp.has = false; return; }
    opp.has = true;
    opp.render.x = p.x; opp.render.y = num(p.y, 0); opp.render.z = p.z;
    const v = isObj(s.velocity) ? s.velocity : null;
    opp.vel.x = v ? num(v.x, 0) : 0; opp.vel.z = v ? num(v.z, 0) : 0;
    opp.yaw = num(s.yaw, opp.yaw);
    for (const k of ['id', 'name', 'hero', 'action', 'locomotion']) if (s[k] != null) opp[k] = s[k];
    for (const k of ['hp', 'maxHp', 'energy', 'maxEnergy']) opp[k] = num(s[k], opp[k]);
    for (const k of ['shielding', 'invulnerable', 'stunned', 'slowed', 'marked', 'dashing', 'dead']) opp[k] = !!s[k];
    // хитбокс: интерполированная позиция + скорость × ½ RTT (компенсация лага, не дальше lagCompMax)
    const comp = opp.dashing ? 0 : clamp((ping / 1000) * PC.lagComp, 0, PC.lagCompMax);
    BOSS.x = opp.render.x + opp.vel.x * comp;
    BOSS.y = opp.render.y;
    BOSS.z = opp.render.z + opp.vel.z * comp;
  }
  // грудь соперника с упреждением по его скорости (автоприцел lock-on)
  function aim() {
    const pp = K.playerPos();
    const d = Math.hypot(BOSS.x - pp.x, BOSS.z - pp.z);
    const lead = clamp(d / Math.max(1, PC.aimLeadSpeed), 0, PC.maxLead) * PC.aimLead;
    // во время рывка не упреждаем (рывок короче полёта снаряда); скорость упреждения — не больше спринта
    const vl = Math.hypot(opp.vel.x, opp.vel.z), k = opp.dashing ? 0 : vl > 8.5 ? 8.5 / vl : 1;
    return vec(BOSS.x + opp.vel.x * lead * k, BOSS.y + C.boss.aimHeight, BOSS.z + opp.vel.z * lead * k);
  }
  function encounter() {
    const st = K.st;
    const d = opp.has ? distXZ(st.p, BOSS) : Infinity;
    if (!st.engaged && d <= PC.engageRange) {
      st.engaged = true;
      K.emit('encounter_start', K.playerPos(), { reason: 'opponent', pvp: true });
    } else if (st.engaged && d > PC.engageRange + 4) {
      st.engaged = false;
      K.emit('encounter_end', K.playerPos(), { reason: 'far', pvp: true });
    }
  }

  // ---------------------------------------------------------------- атакующий: удары
  function sendHit(kind, rawDmg, fx, point, dir, extra) {
    const dmg = Math.round(Math.min(maxHit(), Math.max(0, rawDmg)) * 10) / 10;
    const id = `${tag}:${kind}:${K.newId('h')}`;
    const pp = K.playerPos();
    let dx = dir ? dir.x : BOSS.x - pp.x, dz = dir ? dir.z : BOSS.z - pp.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const hit = { id, dmg, kind, fx: cleanFx(fx), from: vcopy(pp), dir: { x: dx, z: dz } };
    if (extra && extra.melee) hit.melee = true;
    outbox.push({ t: 'hit', ...hit });
    pending.set(id, { kind, heal: extra && extra.heal ? extra.heal : 0, point: point ? vcopy(point) : aimPoint(), t: clock() });
    if (pending.size > 128) pending.delete(pending.keys().next().value);
    stats.sent++;
    return hit;
  }
  function aimPoint() { return vec(BOSS.x, BOSS.y + C.boss.aimHeight, BOSS.z); }
  function cleanFx(fx) {
    const o = {};
    if (!isObj(fx)) return o;
    if (fx.stun > 0) o.stun = Math.min(PC.stunMax, fx.stun);
    if (fx.slow > 0) o.slow = Math.min(PC.slowMax, fx.slow);
    if (fx.knock > 0) o.knock = Math.min(PC.knockMax, fx.knock);
    if (fx.dot > 0) o.dot = fx.dot;
    if (fx.mark > 0) o.mark = Math.min(PC.markMax, fx.mark);
    return o;
  }
  // мгновенные источники урона combat.js (рассечение, чужие модули — лук, магия рукой)
  function damage(amount, source, point, extra) {
    if (!(amount > 0) || K.st.status !== 'playing' || !opp.has || opp.dead) return;
    const kind = extra && typeof extra.kind === 'string' ? extra.kind : String(source || 'hit');
    sendHit(kind, amount * mulOf(kind), null, point, null, { melee: PC.melee.includes(kind) });
  }
  function projectileHit(pr, point) {
    const kind = pr.pvpKind || (pr.reflected ? 'reflect' : pr.kind) || 'bolt';
    let raw = pr.pvpFinal ? pr.damage : (pr.damage || 0) * mulOf(kind);
    if ((kind === 'spark' || kind === 'bolt') && PC.igniteDist > 0) {
      const v = pr.velocity || { x: 0, y: 0, z: 0 };
      const flown = (pr.age || 0) * Math.hypot(v.x, v.y || 0, v.z);
      raw *= clamp(0.5 + 0.5 * flown / PC.igniteDist, 0.5, 1);
    }
    const v = pr.velocity || { x: 0, z: 0 };
    sendHit(kind, raw, pr.fx, point, { x: v.x, z: v.z }, { heal: pr.heal });
    K.emit('projectile_impact', point, { owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'opponent', pvp: true, size: pr.size, power: pr.power, radius: pr.radius });
  }
  function shoot(kind, dmgRaw, fx, extra) {
    const S = PC.shots[kind] || PC.shots.caret;
    const chest = K.playerChest();
    const to = extra && extra.to ? extra.to : aim();
    let vx = to.x - chest.x, vy = to.y - chest.y, vz = to.z - chest.z;
    if (extra && extra.yawOff) {
      const c = Math.cos(extra.yawOff), s = Math.sin(extra.yawOff);
      [vx, vz] = [vx * c - vz * s, vx * s + vz * c];
    }
    const vl = Math.hypot(vx, vy, vz) || 1;
    const id = K.newId(kind);
    K.addProjectile({
      id, owner: 'player', kind: S.visual || 'bolt', pvpKind: kind, element: S.element || null,
      position: vcopy(chest), velocity: vec(vx / vl * S.speed, vy / vl * S.speed, vz / vl * S.speed), radius: S.radius,
      age: 0, lifetime: Math.min(2.5, (PC.engageRange + 5) / S.speed), damage: dmgRaw * mulOf(kind), pvpFinal: true,
      fx: fx || null, heal: extra && extra.heal ? extra.heal : 0, attackId: null, passed: false,
      size: S.visual === 'sphere' ? 0.5 : undefined, power: S.visual === 'sphere' ? 0.6 : undefined,
    });
    return id;
  }
  function burst(dmg, power, both, cleared, chest, to) {
    const S = PC.shots.burst;
    shoot('burst', dmg, { knock: S.knock * (0.7 + 0.6 * power) });
    K.emit('burst', chest, { amount: dmg, power, both, cleared: 0, from: vcopy(chest), to: vcopy(to), radius: 2.5 * (0.7 + 0.6 * power), pvp: true });
    return true;
  }
  function rune(r, R, chest, to) {
    const Pp = P();
    if (r === 'ignis') {
      shoot('ignis', R.damage, { dot: PC.shots.ignis.dot });
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vcopy(to), amount: R.damage, pvp: true });
    } else if (r === 'fulgur') {
      shoot('fulgur', R.damage, { stun: Math.min(PC.stunMax, R.stun) });
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vcopy(to), stun: Math.min(PC.stunMax, R.stun), pvp: true });
    } else if (r === 'vee') {
      shoot('vee', R.damage, null, { heal: R.heal * PC.heal });
      K.emit('rune_cast', chest, { rune: r, from: vcopy(to), to: vcopy(chest), amount: R.damage, heal: 0, pvp: true });
    } else if (r === 'clepsydra') {
      shoot('clepsydra', PC.shots.clepsydra.damage, { slow: Math.min(PC.slowMax, R.duration) });
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vcopy(to), duration: Math.min(PC.slowMax, R.duration), slow: PC.slowFactor, pvp: true });
    } else if (r === 'caret') {
      for (let i = 0; i < R.count; i++) shoot('caret', R.damage, null, { yawOff: (i - (R.count - 1) / 2) * R.spreadDeg * Math.PI / 180 });
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vcopy(to), count: R.count, pvp: true });
    } else if (r === 'stella') {
      const S = PC.stella;
      const cx = BOSS.x + opp.vel.x * S.lead, cz = BOSS.z + opp.vel.z * S.lead;
      for (let i = 0; i < R.count; i++) {
        const a = i * 2.39996, rr = i === 0 ? 0 : S.spread * Math.sqrt(i / R.count);   // спираль вокруг цели
        timed.push({ kind: 'stella', i, t: 0.25 + i * R.interval, x: cx + Math.sin(a) * rr, z: cz + Math.cos(a) * rr, dmg: R.damage });
      }
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vec(cx, BOSS.y + 1, cz), count: R.count, amount: R.damage * R.count, pvp: true });
    } else if (r === 'alpha') {
      const m = PC.alpha.cooldownMul;
      Pp.dashCd *= m; Pp.sparkCd *= m; Pp.slashCd *= m; Pp.throwCd *= m; Pp.parryCd *= m;
      Pp.energy = Math.min(C.player.maxEnergy, Pp.energy + PC.alpha.energy);
      K.emit('rune_cast', chest, { rune: r, from: vcopy(chest), to: vcopy(chest), energy: PC.alpha.energy, pvp: true });
    } else return false;                   // orbis, spira, lemnis — на себя, как в бою с боссом
    return true;
  }
  function sigil(sg, S, chest, to) {
    const pp = K.playerPos();
    if (sg === 'clap') {
      const Q = PC.clap;
      const near = opp.has && !opp.dead && distXZ(pp, BOSS) <= Q.radius + PC.hitbox.radius;
      K.emit('sigil_cast', chest, { sigil: 'clap', radius: Q.radius, cleared: 0, stunned: false, from: vcopy(chest), to: vcopy(to), pvp: true });
      if (near) sendHit('clap', S.damage * mulOf('clap'), { stun: Q.stun, knock: Q.knock }, aimPoint(), null, { melee: true });
      return true;
    }
    if (sg === 'frame') {
      shoot('frame', 0.001, { mark: Math.min(PC.markMax, S.duration) });
      K.emit('sigil_cast', chest, { sigil: 'frame', duration: Math.min(PC.markMax, S.duration), bonus: PC.markBonus, from: vcopy(chest), to: vcopy(to), pvp: true });
      return true;
    }
    if (sg === 'delta') {
      let dx = to.x - chest.x, dz = to.z - chest.z;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      for (let i = 0; i < S.ticks; i++) timed.push({ kind: 'delta', i, t: 0.15 + i * S.interval, ox: chest.x, oy: chest.y, oz: chest.z, dx, dz, dmg: S.damage });
      K.emit('sigil_cast', chest, { sigil: 'delta', ticks: S.ticks, amount: S.ticks * S.damage * mulOf('delta'), cleared: 0, from: vcopy(chest), to: vcopy(to), pvp: true });
      return true;
    }
    return false;                          // gate, cor — на себя
  }
  function count(k) { if (k) stats.casts[k] = (stats.casts[k] || 0) + 1; }
  function runTimed(h) {
    if (!timed.length) return;
    for (let i = 0; i < timed.length; i++) {
      const m = timed[i];
      m.t -= h;
      if (m.t > 0) continue;
      timed.splice(i--, 1);
      if (m.kind === 'stella') {
        const at = vec(m.x, K.LAY.groundY(m.x, m.z) + 0.2, m.z);
        K.emit('rune_hit', at, { rune: 'stella', index: m.i, amount: m.dmg, pvp: true });
        if (opp.has && !opp.dead && Math.hypot(BOSS.x - m.x, BOSS.z - m.z) <= PC.stella.radius + PC.hitbox.radius) sendHit('stella', m.dmg * mulOf('stella'), null, at);
      } else if (m.kind === 'delta') {
        const L = PC.delta.range;
        const ex = m.ox + m.dx * L, ez = m.oz + m.dz * L;
        const u = clamp((BOSS.x - m.ox) * m.dx + (BOSS.z - m.oz) * m.dz, 0, L);
        const dist = Math.hypot(BOSS.x - (m.ox + m.dx * u), BOSS.z - (m.oz + m.dz * u));
        const hitIt = opp.has && !opp.dead && dist <= PC.delta.width + PC.hitbox.radius;
        const to = hitIt ? aimPoint() : vec(ex, m.oy, ez);
        K.emit('sigil_hit', to, { sigil: 'delta', index: m.i, amount: m.dmg * mulOf('delta'), from: vec(m.ox, m.oy, m.oz), pvp: true });
        if (hitIt) sendHit('delta', m.dmg * mulOf('delta'), null, to, { x: m.dx, z: m.dz });
      }
    }
  }

  // ---------------------------------------------------------------- атакующий: ответ жертвы
  function onAck(a) {
    if (!isObj(a) || typeof a.id !== 'string') return;
    const p = pending.get(a.id);
    if (!p) return;
    pending.delete(a.id);
    const Pp = P();
    const point = p.point;
    if (a.applied) {
      const amount = num(a.amount, 0);
      stats.dealt += amount; stats.landed++;
      K.st.stats.damageDealt += amount;
      Pp.combo++; Pp.comboTimer = C.combo.decay;
      opp.hp = num(a.hpAfter, opp.hp);
      opp.ackHp = opp.hp; opp.ackAt = clock();
      K.emit('boss_hit', point, { amount, source: p.kind, hpAfter: opp.hp, combo: Pp.combo, multiplier: 1, marked: false, pvp: true, target: 'opponent' });
      if (p.heal > 0 && Pp.hp > 0) {
        const before = Pp.hp;
        Pp.hp = Math.min(C.player.maxHp, Pp.hp + p.heal);
        K.emit('pvp_heal', K.playerChest(), { amount: Pp.hp - before, source: p.kind });
      }
    } else {
      K.emit('pvp_hit_denied', point, { reason: a.reason || 'miss', kind: p.kind, counter: !!a.counter });
      if (a.reason === 'parry' && a.counter && !Pp.dead) {
        Pp.hitReact = Math.max(Pp.hitReact, PC.counterStagger);
        K.emit('pvp_countered', K.playerChest(), { by: 'parry', duration: PC.counterStagger });
      }
    }
  }

  // ---------------------------------------------------------------- жертва: входящий удар
  function remember(id) {
    seen.add(id); seenQ.push(id);
    if (seenQ.length > 512) seen.delete(seenQ.shift());
  }
  function record() {
    const Pp = P();
    const h = hist[hi];
    hi = (hi + 1) % HN;
    h.t = clock(); h.iframe = Pp.iframe; h.parry = Pp.parryWin > 0; h.shield = Pp.shielding; h.ward = Pp.ward > 0;
    h.bastion = Pp.bastion > 0; h.spawn = Pp.grace > 0 && me.spawnT > 0; h.dashE = Pp.dashing ? Pp.dashElapsed : 1;
  }
  // защита в окне [t0, now]: что было активно хоть в одной записи + текущее состояние
  function defenseSince(t0) {
    const Pp = P();
    // бой стоит (пауза, потеря трекинга): i-кадры и щит «заморожены» — живым флагам не верим, только истории окна
    const live = clock() - lastStepAt <= 100;
    const d = live ? { iframe: Pp.iframe > 0, perfect: Pp.dashing && Pp.dashElapsed <= C.perfectDodge.window, parry: Pp.parryWin > 0, shield: Pp.shielding,
      ward: Pp.ward > 0, bastion: Pp.bastion > 0, spawn: Pp.grace > 0 && me.spawnT > 0 }
      : { iframe: false, perfect: false, parry: false, shield: false, ward: Pp.ward > 0, bastion: false, spawn: Pp.grace > 0 && me.spawnT > 0 };
    for (const h of hist) {
      if (h.t < t0) continue;
      if (h.iframe > 0) { d.iframe = true; if (h.dashE <= C.perfectDodge.window) d.perfect = true; }
      if (h.parry) d.parry = true;
      if (h.shield) d.shield = true;
      if (h.ward) d.ward = true;
      if (h.bastion) d.bastion = true;
      if (h.spawn) d.spawn = true;
    }
    return d;
  }
  function applyRemoteHit(hit) {
    if (!isObj(hit) || typeof hit.id !== 'string' || hit.id.length > 160) return { applied: false, reason: 'bad' };
    if (seen.has(hit.id)) return { applied: false, reason: 'duplicate', duplicate: true };
    remember(hit.id);
    const st = K.st, Pp = st.p;
    if (!on) return { applied: false, reason: 'mode' };
    if (!acceptHits || st.status !== 'playing') return { applied: false, reason: 'phase' };
    if (Pp.dead || Pp.hp <= 0) return { applied: false, reason: 'dead' };
    const kind = typeof hit.kind === 'string' ? hit.kind.slice(0, 24) : 'hit';
    let dmg = clampN(num(hit.dmg, 0), 0, maxHit());
    const fx = cleanFx(hit.fx);
    const now = clock();
    const lagMs = Math.min(PC.maxLagSec * 1000, ping / 2);
    const d = defenseSince(now - lagMs - PC.defenseBuffer * 1000);
    const chest = K.playerChest();
    const dir = isObj(hit.dir) ? { x: num(hit.dir.x, 0), z: num(hit.dir.z, 0) } : { x: 0, z: 0 };
    const att = { id: hit.id, kind, damage: dmg };
    const melee = PC.melee.includes(kind) || hit.melee === true;
    if (d.spawn) return deny('invulnerable');
    if (d.iframe) {
      st.stats.dodges++; stats.dodged++;
      K.emit('dodge', K.playerPos(), { attackId: att.id, attackKind: kind, method: 'dash', perfect: d.perfect, pvp: true });
      if (d.perfect) {
        Pp.energy = Math.min(C.player.maxEnergy, Pp.energy + C.perfectDodge.energy);
        K.emit('perfect_dodge', K.playerPos(), { attackId: att.id, attackKind: kind, energy: C.perfectDodge.energy, pvp: true });
      }
      return deny('dodge');
    }
    if (d.parry && !PC.noParry.includes(kind)) {
      Pp.parryHit = true;
      Pp.parryCd = Math.max(Pp.parryCd, PC.parrySuccessCd);
      Pp.energy = Math.min(C.player.maxEnergy, Pp.energy + PC.parryEnergy);
      stats.parried++;
      if (!melee) {
        // снаряд летит назад: теперь это снаряд жертвы, и его попадание уйдёт атакующему как hit
        const to = aimPoint();
        let vx = to.x - chest.x, vy = to.y - chest.y, vz = to.z - chest.z;
        const vl = Math.hypot(vx, vy, vz) || 1, sp = PC.reflectSpeed;
        const id = K.newId('reflect');
        K.addProjectile({
          id, owner: 'player', kind: 'bolt', pvpKind: 'reflect', reflected: true,
          position: vcopy(chest), velocity: vec(vx / vl * sp, vy / vl * sp, vz / vl * sp), radius: 0.3,
          age: 0, lifetime: 2, damage: dmg * PC.reflectMul, pvpFinal: true, fx: null, attackId: null, passed: false,
        });
        K.emit('parry', chest, { success: true, projectileId: id, attackId: att.id, pvp: true });
        K.emit('projectile_reflected', chest, { projectileId: id, owner: 'player', pvp: true });
      } else {
        K.emit('parry', chest, { success: true, attackId: att.id, counter: true, pvp: true });
      }
      return deny('parry', { counter: melee });
    }
    if (d.ward) {
      st.stats.blocks++; stats.blocked++;
      if (Pp.ward > 0) { Pp.ward = 0; K.emit('ward_end', K.playerPos(), { reason: 'absorbed' }); }
      for (const h of hist) h.ward = false;      // оберег одноразовый: буфер его больше не помнит
      K.emit('block', chest, { attackId: att.id, attackKind: kind, prevented: dmg, ward: true, energyAfter: Pp.energy, pvp: true });
      return deny('ward');
    }
    const orbLike = kind === 'sphere' || kind === 'prism' || kind === 'hand_orb' || kind === 'burst';
    if (d.bastion && orbLike) {
      st.stats.blocks++; stats.blocked++;
      K.emit('block', chest, { attackId: att.id, attackKind: kind, prevented: dmg, bastion: true, energyAfter: Pp.energy, pvp: true });
      return deny('bastion');
    }
    let broken = false;
    if (d.shield && !PC.unblockable.includes(kind)) {
      const cost = PC.shield.blockBase + PC.shield.blockPerDmg * dmg;
      if (Pp.energy >= cost) {
        st.stats.blocks++; stats.blocked++;
        Pp.energy = Math.max(0, Pp.energy - cost);
        Pp.regenDelay = C.player.energyRegenDelay;
        K.emit('block', chest, { attackId: att.id, attackKind: kind, prevented: dmg, energyAfter: Pp.energy, pvp: true });
        if (Pp.energy <= 0.5 && Pp.shielding) K.endShield('depleted');
        return deny('block');
      }
      broken = true;                           // энергии не хватило: щит ломается, половина урона проходит
      Pp.energy = 0;
      if (Pp.shielding) K.endShield('depleted');
      K.emit('shield_break', chest, { attackId: att.id, pvp: true });
    }
    // попадание
    if (me.markT > 0) dmg *= 1 + PC.markBonus;
    if (d.bastion) dmg *= 1 - C.sigils.gate.reduction;
    if (broken) dmg *= PC.shield.brokenMul;
    const amount = Math.min(Pp.hp, maxHit(), dmg);
    Pp.hp -= amount;
    if (Pp.hp < 1e-6) Pp.hp = 0;
    st.stats.damageTaken += amount; stats.taken += amount; stats.maxTaken = Math.max(stats.maxTaken, amount);
    stats.takenBy[kind] = (stats.takenBy[kind] || 0) + amount;
    K.breakCombo('hit');
    if (amount >= PC.staggerAt) Pp.hitReact = Math.max(Pp.hitReact, PC.staggerTime);
    applyFx(fx, dir);
    K.emit('player_hit', chest, { amount, attackId: att.id, attackKind: kind, direction: vec(dir.x, 0, dir.z), shieldPierced: broken, hpAfter: Pp.hp, pvp: true, fx });
    if (Pp.hp <= 0) die(kind);
    return { applied: true, reason: 'hit', amount: Math.round(amount * 10) / 10, hpAfter: Math.round(Pp.hp * 10) / 10 };
  }
  function deny(reason, extra) { return { applied: false, reason, ...(extra || {}) }; }
  function applyFx(fx, dir) {
    const Pp = P();
    if (fx.stun > 0 && me.stunImmune <= 0) {
      me.stunT = Math.max(me.stunT, fx.stun);
      Pp.hitReact = Math.max(Pp.hitReact, me.stunT);
      if (Pp.shielding) K.endShield('stun');
      K.emit('pvp_status', K.playerPos(), { status: 'stun', duration: me.stunT });
    }
    if (fx.slow > 0) { me.slowT = Math.max(me.slowT, fx.slow); K.emit('pvp_status', K.playerPos(), { status: 'slow', duration: me.slowT, factor: PC.slowFactor }); }
    if (fx.mark > 0) { me.markT = Math.max(me.markT, fx.mark); K.emit('pvp_status', K.playerPos(), { status: 'mark', duration: me.markT, bonus: PC.markBonus }); }
    if (fx.dot > 0) { me.dotDps = fx.dot / PC.dotTime; me.dotT = PC.dotTime; }
    if (fx.knock > 0) {
      const l = Math.hypot(dir.x, dir.z);
      if (l > 1e-6) { const v = fx.knock / PC.knockTime; me.kx = dir.x / l * v; me.kz = dir.z / l * v; me.knockT = PC.knockTime; }
    }
  }
  function die(kind) {
    const Pp = P();
    if (Pp.dead) return;
    Pp.dead = true; Pp.hp = 0;
    if (Pp.shielding) K.endShield('dead');
    Pp.dashing = false; Pp.vx = 0; Pp.vz = 0;
    me.stunT = 0; me.slowT = 0; me.dotT = 0; me.knockT = 0;
    K.emit('pvp_down', K.playerPos(), { by: kind });
  }

  // ---------------------------------------------------------------- шаг (до движения героя)
  function preStep(h) {
    const st = K.st, Pp = st.p;
    if (me.spawnT > 0) me.spawnT = Math.max(0, me.spawnT - h);
    if (me.stunImmune > 0) me.stunImmune = Math.max(0, me.stunImmune - h);
    const hold = frozen || Pp.dead || me.stunT > 0;
    if (me.stunT > 0) {
      me.stunT = Math.max(0, me.stunT - h);
      Pp.hitReact = Math.max(Pp.hitReact, me.stunT);
      if (me.stunT <= 0) me.stunImmune = PC.stunImmune;
    }
    if (hold) {
      const I = st.input;
      I.moveX = 0; I.moveZ = 0; I.attack = false; I.shield = false; I.conjure = null;
      st.pendingDash = 0; st.pendingDashCam = null; st.dashBuffer = null; st.pendingSpark = false; st.pendingSlash = null;
      st.pendingParry = false; st.pendingBurst = false; st.pendingRune = null; st.pendingSigil = null; st.pendingThrow = null;
      if (Pp.shielding) K.endShield(frozen ? 'released' : 'stun');
      if (frozen || Pp.dead) { Pp.vx *= 0.5; Pp.vz *= 0.5; }
    }
    if (me.slowT > 0) me.slowT = Math.max(0, me.slowT - h);
    if (me.markT > 0) me.markT = Math.max(0, me.markT - h);
    if (me.dotT > 0 && !Pp.dead) {
      const dtd = Math.min(h, me.dotT);
      me.dotT = Math.max(0, me.dotT - h);
      if (acceptHits && !(me.spawnT > 0)) {
        const a = Math.min(Pp.hp, me.dotDps * dtd);
        Pp.hp -= a; st.stats.damageTaken += a; stats.taken += a; stats.takenBy.dot = (stats.takenBy.dot || 0) + a;
        if (Pp.hp <= 1e-6) { Pp.hp = 0; die('dot'); }
      }
    }
    if (me.knockT > 0 && !Pp.dead) {
      const k = Math.min(h, me.knockT);
      me.knockT = Math.max(0, me.knockT - h);
      const to = K.resolveMove(Pp.x, Pp.z, Pp.x + me.kx * k, Pp.z + me.kz * k);
      Pp.x = to.x; Pp.z = to.z; Pp.y = K.LAY.groundY(Pp.x, Pp.z);
    }
    if (!Pp.dead) runTimed(h);
    lastStepAt = clock();
    record();
  }

  // ---------------------------------------------------------------- снимок
  function decorate(snap) {
    const pos = { x: opp.render.x, y: opp.render.y, z: opp.render.z };
    snap.opponent = opp.has ? {
      id: opp.id, name: opp.name, hero: opp.hero, position: pos, yaw: opp.yaw,
      hp: opp.hp, maxHp: opp.maxHp, energy: opp.energy, maxEnergy: opp.maxEnergy, action: opp.action,
      shielding: opp.shielding, invulnerable: opp.invulnerable, stunned: opp.stunned, slowed: opp.slowed,
      marked: opp.marked, dashing: opp.dashing, dead: opp.dead, locomotion: opp.locomotion, velocity: { x: opp.vel.x, z: opp.vel.z },
    } : null;
    snap.lockTarget = { position: opp.has ? pos : vcopy(BOSS), kind: 'player' };
    // snap.boss — зеркало соперника для старых потребителей (камера lock-on, HUD). Босс не падает:
    // world.js в режиме pvp не анимирует Регента (хук [PVP]), HP > 0 держим для старых проверок смерти.
    const b = snap.boss;
    b.position = { ...pos }; b.home = { ...pos }; b.yaw = opp.yaw;
    b.hp = Math.max(opp.dead ? 0 : 1, opp.hp); b.maxHp = opp.maxHp; b.stage = 1; b.action = opp.dead ? 'idle' : 'idle';
    b.stunned = opp.stunned; b.stunRemaining = 0; b.marked = opp.marked; b.markRemaining = 0; b.slowed = opp.slowed; b.slowRemaining = 0;
    b.name = opp.name; b.pvp = true; b.hidden = true;
    const Pp = P();
    snap.player.stunned = me.stunT > 0; snap.player.stunRemaining = me.stunT;
    snap.player.slowed = me.slowT > 0; snap.player.slowRemaining = me.slowT;
    snap.player.marked = me.markT > 0; snap.player.markRemaining = me.markT;
    snap.player.burning = me.dotT > 0;
    snap.player.dead = !!Pp.dead;
    if (me.spawnT > 0 && Pp.grace > 0) snap.player.invulnerableSource = 'spawn';
    // мои PvP-снаряды: вид заклинания и стихия (для эффектов №7)
    for (const o of snap.projectiles) {
      const pr = K.st.projectiles.find((q) => q.id === o.id);
      if (pr && pr.pvpKind) { o.spell = pr.pvpKind; if (pr.element) o.element = pr.element; }
    }
    for (const g of ghosts) snap.projectiles.push(g);
    snap.pvp = view ? { ...view } : { phase: 'lobby' };
  }

  // состояние для сообщения st (20 Гц)
  function myState() {
    const st = K.st, Pp = st.p;
    const stale = clock() - lastStepAt > 150;             // бой стоит (пауза): не «летим» дальше у соперника
    const pr = [];
    for (const q of st.projectiles) {
      if (q.owner !== 'player' || pr.length >= 16) continue;
      pr.push({ id: q.id, kind: q.kind, spell: q.pvpKind || null, el: q.element || null,
        p: [r2(q.position.x), r2(q.position.y), r2(q.position.z)], v: [r2(q.velocity.x), r2(q.velocity.y), r2(q.velocity.z)], r: r2(q.radius) });
    }
    return {
      t: Math.round(clock()),
      position: { x: r2(Pp.x), y: r2(Pp.y), z: r2(Pp.z) }, yaw: r2(Pp.yaw), velocity: stale ? { x: 0, z: 0 } : { x: r2(Pp.vx), z: r2(Pp.vz) },
      hp: r2(Pp.hp), maxHp: C.player.maxHp, energy: r2(Pp.energy), maxEnergy: C.player.maxEnergy,
      shielding: Pp.shielding, invulnerable: Pp.iframe > 0 || Pp.grace > 0, stunned: me.stunT > 0, slowed: me.slowT > 0, marked: me.markT > 0,
      dashing: !stale && Pp.dashing, dead: !!Pp.dead, pr, taken: Math.round(stats.taken * 10) / 10,   // taken — для «нанесённого урона» соперника
    };
  }
  function r2(v) { return Math.round(v * 100) / 100; }

  // ---------------------------------------------------------------- раунды (вызывает сессия)
  function respawn(sp) {
    const st = K.st, Pp = st.p;
    const x = num(sp && sp.x, 0), z = num(sp && sp.z, 0);
    Pp.x = x; Pp.z = z; Pp.y = K.LAY.groundY(x, z);
    Pp.yaw = num(sp && sp.yaw, Pp.yaw);
    Pp.vx = 0; Pp.vz = 0; Pp.dashing = false; Pp.dashElapsed = 0; Pp.dashCd = 0;
    Pp.hp = C.player.maxHp; Pp.energy = C.player.maxEnergy; Pp.dead = false;
    Pp.sparkCd = 0; Pp.slashCd = 0; Pp.parryCd = 0; Pp.parryWin = 0; Pp.parryT = 0; Pp.slashT = 0; Pp.sparkT = 0; Pp.throwCd = 0; Pp.burstCd = 0;
    Pp.iframe = 0; Pp.grace = 0; Pp.hitReact = 0; Pp.regenDelay = 0; Pp.castTimer = 0; Pp.fireTimer = 0;
    if (Pp.shielding) K.endShield('released');
    Pp.shieldLock = false;
    for (const k of Object.keys(Pp.runeCd)) Pp.runeCd[k] = 0;
    for (const k of Object.keys(Pp.sigilCd)) Pp.sigilCd[k] = 0;
    Pp.ward = 0; Pp.bastion = 0; Pp.vortex = 0; Pp.regen = 0; Pp.regenRate = 0; Pp.beam = []; Pp.meteors = []; Pp.combo = 0; Pp.comboTimer = 0;
    st.projectiles = [];
    st.pendingDash = 0; st.pendingDashCam = null; st.dashBuffer = null; st.pendingSpark = false; st.pendingSlash = null; st.pendingParry = false;
    st.pendingBurst = false; st.pendingRune = null; st.pendingSigil = null; st.pendingThrow = null;
    if (st.move) { st.move.cruise = null; st.move.sprint = 0; st.move.sprintT = 0; }
    resetState();
    K.emit('pvp_respawn', K.playerPos(), { x, z });
  }
  function grantSpawnInvuln(sec) { const Pp = P(); me.spawnT = sec; Pp.grace = Math.max(Pp.grace, sec); }

  return {
    get on() { return on; },
    get floorY() { return Math.min(K.st.p.y, opp.has ? BOSS.y : K.st.p.y); },   // уровень земли дуэли (для «снаряд ушёл в пол»)
    enable, disable, aim, encounter, damage, projectileHit, burst, rune, sigil, preStep, decorate, setOpponent, applyRemoteHit,
    // для сессии
    onAck, myState, respawn, grantSpawnInvuln, count,
    onReset() { resetState(); },
    drainOutbox() { return outbox.splice(0, outbox.length); },
    setPing(ms) { ping = Math.max(0, num(ms, 0)); },
    setTag(t) { tag = String(t || 'p'); },
    setAcceptHits(v) { acceptHits = !!v; },
    setFrozen(v) { frozen = !!v; },
    setGhosts(list) { ghosts = Array.isArray(list) ? list : []; },
    setView(v) { view = v; },
    isDead() { return !!P().dead; },
    hpFrac() { const Pp = P(); return Pp.hp / Math.max(1, C.player.maxHp); },
    status() { return { stunT: me.stunT, slowT: me.slowT, markT: me.markT, dotT: me.dotT, knockT: me.knockT, spawnT: me.spawnT }; },
    opponent: opp, stats, config: PC,
  };
}

// -----------------------------------------------------------------------------
// Интерполяция соперника по st. Время отправителя переводится в своё по минимальной задержке.
// -----------------------------------------------------------------------------
export function createRemoteBuffer({ delayMs = 100, maxExtrapMs = 250 } = {}) {
  const buf = [];
  let offset = null;               // локальное − время отправителя (минимум ≈ задержка сети)
  let last = null;
  const out = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, z: 0 } };
  function push(s, recvT) {
    if (!isObj(s) || !isObj(s.position)) return;
    const st = num(s.t, recvT);
    const off = recvT - st;
    // минимальная задержка; медленный дрейф вверх — на случай ухода часов
    offset = offset === null || off < offset ? off : offset + (off - offset) * 0.002;
    const e = { t: st, s };
    if (buf.length && st <= buf[buf.length - 1].t) { if (st === buf[buf.length - 1].t) buf[buf.length - 1] = e; return; }
    buf.push(e);
    if (buf.length > 30) buf.shift();
    last = s;
  }
  function sample(now) {
    if (!buf.length || offset === null) return null;
    const t = now - offset - delayMs;
    let a = buf[0], b = null;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].t <= t) a = buf[i];
      else { b = buf[i]; break; }
    }
    const newest = buf[buf.length - 1].s;
    let px, py, pz, yaw;
    if (b && b !== a && a.t <= t) {
      const u = clampN((t - a.t) / Math.max(1, b.t - a.t), 0, 1);
      const A = a.s.position, B = b.s.position;
      px = A.x + (B.x - A.x) * u; py = num(A.y, 0) + (num(B.y, 0) - num(A.y, 0)) * u; pz = A.z + (B.z - A.z) * u;
      let dy = num(b.s.yaw, 0) - num(a.s.yaw, 0);
      dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      yaw = num(a.s.yaw, 0) + dy * u;
    } else {
      const s = (b && a.t > t) ? a.s : buf[buf.length - 1].s;     // старее буфера — первый; новее — экстраполяция
      const dtE = b && a.t > t ? 0 : clampN(t - buf[buf.length - 1].t, 0, maxExtrapMs) / 1000;
      const v = isObj(s.velocity) ? s.velocity : { x: 0, z: 0 };
      px = s.position.x + num(v.x, 0) * dtE; py = num(s.position.y, 0); pz = s.position.z + num(v.z, 0) * dtE;
      yaw = num(s.yaw, 0);
    }
    const vs = isObj(newest.velocity) ? newest.velocity : { x: 0, z: 0 };
    const o = { ...newest };
    o.position = { x: px, y: py, z: pz };
    o.velocity = { x: num(vs.x, 0), z: num(vs.z, 0) };
    o.yaw = yaw;
    return o;
  }
  // снаряды соперника на «сейчас»: из последнего st, вынесенные вперёд по скорости
  function ghosts(now) {
    if (!last || offset === null || !Array.isArray(last.pr)) return [];
    const dt = clampN((now - offset - num(last.t, now)) / 1000, 0, 0.3);
    return last.pr.filter((q) => q && Array.isArray(q.p) && Array.isArray(q.v)).map((q) => ({
      id: `opp:${q.id}`, owner: 'opponent', kind: q.kind || 'bolt', spell: q.spell || null, element: q.el || null, remote: true,
      position: { x: q.p[0] + q.v[0] * dt, y: q.p[1] + q.v[1] * dt, z: q.p[2] + q.v[2] * dt },
      velocity: { x: q.v[0], y: q.v[1], z: q.v[2] }, radius: num(q.r, 0.2),
    }));
  }
  return { push, sample, ghosts, get latest() { return last; }, get offset() { return offset; }, clear() { buf.length = 0; offset = null; last = null; } };
}

// -----------------------------------------------------------------------------
// Сеть: заглушки с API C6. createMemoryNetPair — для node-тестов (задержка, джиттер, ручной pump);
// createLocalNet — BroadcastChannel, две вкладки одного браузера (transport 'local').
// -----------------------------------------------------------------------------
function makeEmitter() {
  const map = new Map();
  return {
    on(t, fn) { if (!map.has(t)) map.set(t, new Set()); map.get(t).add(fn); },
    off(t, fn) { const s = map.get(t); if (s) s.delete(fn); },
    fire(t, m) { const s = map.get(t); if (s) for (const fn of [...s]) { try { fn(m); } catch (e) { if (typeof console !== 'undefined') console.error('[pvp] net handler', t, e); } } },
  };
}

export function createMemoryNetPair({ latencyMs = 40, jitterMs = 0, seed = 1, clock } = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const queue = [];
  const now = typeof clock === 'function' ? clock : () => 0;
  function make(isHost) {
    const em = makeEmitter();
    const n = {
      isHost, state: 'connected', ping: latencyMs * 2, peer: null, sent: 0, dropped: false,
      host() { return Promise.resolve('MEM'); }, join() { return Promise.resolve(); },
      send(t, payload) {
        if (n.state !== 'connected' || n.dropped) return false;
        n.sent++;
        const msg = JSON.parse(JSON.stringify({ ...(payload || {}), t }));
        const lastAt = queue.reduce((m, q) => (q.to === n.peer ? Math.max(m, q.at) : m), 0);
        queue.push({ to: n.peer, at: Math.max(lastAt, now() + latencyMs + rnd() * jitterMs), msg });
        return true;
      },
      on: em.on, off: em.off, _fire: em.fire,
      close() { n.state = 'idle'; },
    };
    return n;
  }
  const a = make(true), b = make(false);
  a.peer = b; b.peer = a;
  function pump() {
    const t = now();
    queue.sort((x, y) => x.at - y.at);
    while (queue.length && queue[0].at <= t) {
      const q = queue.shift();
      if (q.to.state === 'connected' && !q.to.dropped) q.to._fire(q.msg.t, q.msg);
    }
  }
  return { a, b, pump, queue };
}

export function createLocalNet({ channel = 'ashen-net-local', name = '', clock } = {}) {
  const now = typeof clock === 'function' ? clock : () => performance.now();
  const id = Math.random().toString(36).slice(2, 10);
  const em = makeEmitter();
  let bc = null;
  try { bc = new BroadcastChannel(channel); } catch (e) { bc = null; }
  let room = null, peer = null, timer = null, joinTimer = null, lastRecv = 0, pingSent = 0;
  const net = {
    transport: 'local', id, state: 'idle', ping: 0, isHost: false, name,
    host(code) {
      room = String(code || Math.floor(1000 + Math.random() * 9000));
      net.isHost = true; net.state = 'connecting';
      post({ _sys: 'announce' });
      start();
      return Promise.resolve(room);
    },
    join(code, opts = {}) {
      room = String(code); net.isHost = false; net.state = 'connecting';
      start();
      return new Promise((resolve, reject) => {
        const t0 = now();
        const tick = () => {
          if (peer) { clearInterval(joinTimer); joinTimer = null; resolve(room); return; }
          if (now() - t0 > (opts.timeoutMs || 8000)) { clearInterval(joinTimer); joinTimer = null; net.state = 'idle'; reject(new Error('Комната не найдена')); return; }
          post({ _sys: 'join' });
        };
        joinTimer = setInterval(tick, 250); tick();
      });
    },
    send(t, payload) {
      if (!peer || !bc) return false;
      post({ ...(payload || {}), t, _to: peer });
      return true;
    },
    on: em.on, off: em.off,
    close() {
      if (peer) post({ _sys: 'bye', _to: peer });
      if (timer) clearInterval(timer); if (joinTimer) clearInterval(joinTimer);
      timer = null; joinTimer = null; peer = null; net.state = 'idle';
      try { bc && bc.close(); } catch (e) { /* ignore */ }
    },
  };
  function post(m) { if (bc) { try { bc.postMessage({ ...m, _from: id, _room: room }); } catch (e) { /* ignore */ } } }
  function setState(s) { if (net.state !== s) { net.state = s; em.fire('state', { t: 'state', state: s }); } }
  function start() {
    if (timer || !bc) return;
    timer = setInterval(() => {
      if (!peer) { if (net.isHost) post({ _sys: 'announce' }); return; }
      pingSent = now(); net.send('ping', { ts: pingSent });
      if (now() - lastRecv > 3000) setState('lost'); else if (net.state === 'lost') setState('connected');
    }, 500);
  }
  if (bc) bc.onmessage = (ev) => {
    const m = ev.data;
    if (!isObj(m) || m._from === id || m._room !== room || room === null) return;
    if (m._to && m._to !== id) return;
    if (m._sys === 'join' && net.isHost && (!peer || peer === m._from)) {
      peer = m._from; lastRecv = now(); post({ _sys: 'welcome', _to: peer }); setState('connected'); em.fire('open', { t: 'open' }); return;
    }
    if (m._sys === 'welcome' && !net.isHost) { peer = m._from; lastRecv = now(); setState('connected'); em.fire('open', { t: 'open' }); return; }
    if (m._sys === 'announce' && net.isHost && !peer && m._from < id) {
      // два хоста одной комнаты: младший id остаётся хостом, этот становится гостем
      net.isHost = false; post({ _sys: 'join' }); return;
    }
    if (m._sys === 'announce' && !net.isHost && !peer) { post({ _sys: 'join' }); return; }
    if (m._sys === 'bye' && m._from === peer) { setState('lost'); em.fire('bye', { t: 'bye' }); return; }
    if (m._sys) return;
    if (peer && m._from !== peer) return;
    lastRecv = now();
    if (net.state === 'lost') setState('connected');
    if (m.t === 'ping') { net.send('pong', { ts: m.ts }); return; }
    if (m.t === 'pong') { const r = now() - num(m.ts, now()); net.ping = net.ping ? net.ping * 0.8 + r * 0.2 : r; return; }
    em.fire(m.t, m);
  };
  // две вкладки: «кто первый — хост». Сначала пробуем войти, не вышло — открываем комнату.
  net.autoPair = async (code = 'LOCAL') => {
    try { await net.join(code, { timeoutMs: 1200 }); return 'guest'; } catch (e) { /* никого нет */ }
    await net.host(code);
    return 'host';
  };
  return net;
}

// -----------------------------------------------------------------------------
// Сессия дуэли: раунды (ведёт хост), приём/отправка сообщений, статистика.
// -----------------------------------------------------------------------------
// remote — соперник от сети №2 (modules/remotePlayer.js: getState() уже интерполирован; st/ev/pr шлёт их сессия).
// Без remote сессия сама шлёт st (20 Гц) и события и интерполирует соперника (заглушка, node-тесты).
export function createPvpSession({ combat, net, cfg, clock, me = {}, spawns = null, arena = null, coach = null, remote = null } = {}) {
  const PC = mergePvpConfig(cfg);
  const now = typeof clock === 'function' ? clock : () => performance.now();
  const role = net && net.isHost ? 'host' : 'guest';
  let H = null;
  if (!combat || typeof combat.attachPvp !== 'function') throw new TypeError('createPvpSession: combat без attachPvp');
  combat.attachPvp((K) => (H = buildHooks(K, PC, { clock: now, tag: role === 'host' ? 'H' : 'G' })));
  const buf = createRemoteBuffer({ delayMs: PC.net.interpDelayMs });
  const R = PC.rounds;
  const S = {
    active: false, phase: 'lobby', round: 0, score: { host: 0, guest: 0 }, phaseAt: 0, winner: null, reason: null,
    rematch: { me: false, opp: false }, oppHello: null, lastRecv: 0, pausedFrom: null, pausedAt: 0,
    stSent: 0, helloSent: 0, deadSent: 0, events: [], remote: [], fightBannerUntil: 0, slowUntil: 0, remoteSeq: 0,
    matchStart: 0, roundStart: 0, roundTimes: [],
    meReady: true, oppReady: false, readySent: 0, statsSent: 0,
  };
  const EXT = !!(remote && typeof remote.getState === 'function');
  const sp = resolveSpawns(spawns, arena, PC.spawnOffset);
  const handlers = {};

  function mySpawn() { return role === 'host' ? sp[0] : sp[1]; }
  function scoreMe() { return role === 'host' ? [S.score.host, S.score.guest] : [S.score.guest, S.score.host]; }
  function winnerRel(w) { return w === null || w === undefined ? null : w === role ? 'me' : 'opponent'; }
  function send(t, p) { try { return net.send(t, p); } catch (e) { return false; } }
  function roundEvent(phase, extra) {
    S.events.push({ id: `pvp-${phase}-${S.round}-${Math.round(now())}`, type: 'pvp_round', position: combat.getSnapshot().player.position,
      data: { phase, round: S.round, score: scoreMe(), winner: winnerRel(S.winner), ...(extra || {}) } });
  }

  // ---------------------------------------------------------------- фазы
  function setPhase(phase, at) {
    S.phase = phase; S.phaseAt = at === undefined ? now() : at;
    H.setAcceptHits(phase === 'fight');
    H.setFrozen(phase !== 'fight');
  }
  function beginCountdown() {        // только хост
    S.winner = null;
    setPhase('countdown');
    H.respawn(mySpawn());
    send('duel', { phase: 'countdown', round: S.round, score: [S.score.host, S.score.guest], at: Math.round(now()), dur: R.countdown });
    roundEvent('countdown');
  }
  function beginFight() {
    setPhase('fight');
    H.grantSpawnInvuln(PC.spawnInvuln);
    S.fightBannerUntil = now() + R.fightBanner * 1000;
    S.roundStart = now();
    if (role === 'host') send('duel', { phase: 'fight', round: S.round, score: [S.score.host, S.score.guest], at: Math.round(now()) });
    roundEvent('fight');
  }
  function endRound(w, reason) {     // только хост
    if (S.phase !== 'fight') return;
    S.winner = w; S.reason = reason || 'ko';
    if (w) S.score[w]++;
    S.roundTimes.push((now() - S.roundStart) / 1000);
    setPhase('round_end');
    S.slowUntil = now() + R.slowmo * 1000;
    send('duel', { phase: 'round_end', round: S.round, score: [S.score.host, S.score.guest], winner: w, reason: S.reason, at: Math.round(now()) });
    roundEvent('round_end', { reason: S.reason });
  }
  function matchEnd(w, reason, local) {
    S.winner = w; S.reason = reason || 'score';
    S.claim = reason === 'disconnect' && w === role;     // своя техническая победа: повторяем сопернику, пока не узнает
    setPhase('match_end');
    if (!local) send('duel', { phase: 'match_end', round: S.round, score: [S.score.host, S.score.guest], winner: w, reason: S.reason, at: Math.round(now()) });
    roundEvent('match_end', { reason: S.reason });
  }
  function startMatch() {            // только хост
    S.score = { host: 0, guest: 0 }; S.round = 1; S.rematch = { me: false, opp: false }; S.roundTimes = []; S.claim = false;
    S.matchStart = now();
    resetStats();
    beginCountdown();
  }
  function resetStats() {
    const st = H.stats;
    st.dealt = 0; st.taken = 0; st.sent = 0; st.landed = 0; st.dodged = 0; st.blocked = 0; st.parried = 0; st.maxTaken = 0; st.oppTaken = 0;
    for (const k of Object.keys(st.casts)) delete st.casts[k];
    for (const k of Object.keys(st.takenBy)) delete st.takenBy[k];
    S.oppTakenBase = null;
  }

  // ---------------------------------------------------------------- сообщения
  function payload(m) { return isObj(m) && isObj(m.payload) ? { ...m.payload, t: m.t } : m; }
  handlers.hello = (m) => {
    m = payload(m);
    const first = !S.oppHello;
    S.oppHello = { name: String(m.name || 'Соперник').slice(0, 24), hero: m.hero || null, v: m.v };
    H.opponent.name = S.oppHello.name; H.opponent.hero = S.oppHello.hero;
    S.lastRecv = now();
    if (first) sendHello(true);
  };
  handlers.st = (m) => {
    m = payload(m);
    S.lastRecv = now();
    buf.push(m, now());
    // в дуэли 1×1 весь урон соперника — от меня (включая горение): «нанесено» = его «получено»
    if (Number.isFinite(Number(m.taken))) H.stats.oppTaken = Math.max(0, Number(m.taken));
  };
  handlers.ev = (m) => {
    m = payload(m);
    S.lastRecv = now();
    const e = m && m.e;
    if (!isObj(e) || typeof e.type !== 'string') return;
    const out = { id: `r${++S.remoteSeq}-${String(e.id || '').slice(0, 24)}`, type: e.type, position: isObj(e.position) ? e.position : null, data: { ...(isObj(e.data) ? e.data : {}), remote: true } };
    if (PC.remoteEventTypes.includes(e.type)) S.remote.push(out);
    if (['player_cast', 'rune_cast', 'sigil_cast', 'burst', 'player_slash'].includes(e.type)) {
      S.remote.push({ id: `${out.id}-oc`, type: 'pvp_opponent_cast', position: out.position, data: { ...out.data, sourceType: e.type } });
    }
    if (S.remote.length > 64) S.remote.splice(0, S.remote.length - 64);
  };
  handlers.hit = (m) => {
    m = payload(m);
    S.lastRecv = now();
    let res;
    try { res = combat.applyRemoteHit(m); } catch (e) { res = { applied: false, reason: 'error' }; }
    if (res && res.duplicate) return;           // повтор: ответ уже отправлен
    if (res && res.applied && res.hpAfter <= 0) checkDeath();
    send('hitAck', { id: m.id, applied: !!(res && res.applied), reason: res ? res.reason : 'error', amount: res && res.amount, hpAfter: res && res.hpAfter, counter: !!(res && res.counter) });
  };
  handlers.hitAck = (m) => { m = payload(m); S.lastRecv = now(); H.onAck(m); };
  // фазы по порядку: гость принимает только более позднюю фазу (повторы и опоздавшие сообщения безвредны)
  const RANK = { lobby: 0, countdown: 1, fight: 2, round_end: 3, match_end: 4 };
  const phaseKey = (ph, round) => (ph === 'match_end' ? 1e6 : num(round, 0) * 10 + (RANK[ph] || 0));
  function hostPhaseMsg() {
    const ph = S.phase === 'paused' ? (S.pausedFrom || 'lobby') : S.phase;
    return { phase: ph, round: S.round, score: [S.score.host, S.score.guest], winner: S.winner, reason: S.reason, dur: R.countdown, at: Math.round(now()), sync: true };
  }
  function guestApply(m) {
    const ph = m.phase;
    if (!(ph in RANK) || ph === 'lobby') return;
    const round = num(m.round, S.round);
    const cur = S.phase === 'paused' ? (S.pausedFrom || 'lobby') : S.phase;
    const newMatch = ph === 'countdown' && round === 1 && (cur === 'match_end' || cur === 'lobby');
    if (!newMatch && phaseKey(ph, round) <= phaseKey(cur, S.round)) return;
    if (Array.isArray(m.score)) S.score = { host: num(m.score[0], 0), guest: num(m.score[1], 0) };
    if (S.phase === 'paused') S.phase = cur;                       // сообщение хоста дошло — связь есть
    if (newMatch) { resetStats(); S.matchStart = now(); S.rematch = { me: false, opp: false }; S.roundTimes = []; S.claim = false; }
    // новый раунд (в том числе пропущенный отсчёт): сначала респаун
    if ((ph === 'countdown' || ph === 'fight') && !(cur === 'countdown' && S.round === round)) {
      S.winner = null; S.deadSent = 0; S.round = round;
      H.respawn(mySpawn());
    }
    S.round = round;
    if (ph === 'countdown') { setPhase('countdown', now() - Math.max(0, num(net.ping, 0) / 2)); roundEvent('countdown'); }
    else if (ph === 'fight') beginFight();
    else if (ph === 'round_end') {
      S.winner = m.winner || null; S.reason = m.reason || 'ko';
      if (cur === 'fight') S.roundTimes.push((now() - S.roundStart) / 1000);
      setPhase('round_end'); S.slowUntil = now() + R.slowmo * 1000;
      roundEvent('round_end', { reason: S.reason });
    } else if (ph === 'match_end') {
      S.winner = m.winner || null; S.reason = m.reason || 'score';
      setPhase('match_end'); roundEvent('match_end', { reason: S.reason });
    }
  }
  // соперник заявил техническую победу (у него пропала связь со мной на 20 с)
  function onClaim(m) {
    const peer = role === 'host' ? 'guest' : 'host';
    if (S.phase === 'match_end' && S.claim) {                      // оба заявили — ничья
      if (S.winner !== null) { S.winner = null; roundEvent('match_end', { reason: 'disconnect' }); }
      return;
    }
    if (S.phase === 'match_end' && S.winner === peer) return;      // уже знаем
    S.score[peer] = Math.max(S.score[peer], R.toWin);
    S.winner = peer; S.reason = 'disconnect'; S.claim = false;
    setPhase('match_end'); roundEvent('match_end', { reason: 'disconnect' });
  }
  handlers.duel = (m) => {
    m = payload(m);
    S.lastRecv = now();
    const ph = m.phase;
    if (ph === 'rematch') { S.rematch.opp = true; if (role === 'host' && S.rematch.me && S.phase === 'match_end') startMatch(); return; }
    if (ph === 'ready') { S.oppReady = true; return; }
    if (ph === 'stats') { if (Number.isFinite(Number(m.taken))) H.stats.oppTaken = Math.max(0, Number(m.taken)); return; }
    if (ph === 'dead') {
      if (role === 'host' && S.phase === 'fight' && num(m.round, S.round) === S.round) endRound('host', 'ko');
      return;
    }
    if (ph === 'leave') { handlers.left(); return; }
    if (ph === 'match_end' && m.reason === 'disconnect' && m.claim) { onClaim(m); return; }
    if (role === 'host') return;              // остальными фазами управляет хост
    guestApply(m);
  };
  handlers.bye = () => { S.lastRecv = -1e9; };
  // соперник сам вышел (сеть №2: событие 'left'; заглушка: 'bye') — техническая победа сразу
  handlers.left = () => {
    if (S.phase === 'lobby' || S.phase === 'match_end') { S.oppReady = false; return; }
    S.score[role] = Math.max(S.score[role], R.toWin);
    matchEnd(role, 'left', true);
  };
  function sendHello(force) {
    if (EXT) return;                          // hello сети №2 шлёт её net.js
    if (!force && now() - S.helloSent < PC.net.helloEveryMs) return;
    S.helloSent = now();
    send('hello', { v: 'ASHEN_NET_1', name: me.name || 'Игрок', hero: me.hero || null, pvp: PVP_API_VERSION });
  }

  // ---------------------------------------------------------------- жизненный цикл
  function start() {
    if (S.active) return;
    S.active = true;
    combat.setMode('pvp');
    for (const [t, fn] of Object.entries(handlers)) {
      if (EXT && (t === 'st' || t === 'ev' || t === 'hello')) continue;   // эти каналы ведёт сеть №2
      net.on(t, fn);
    }
    if (!EXT) net.on('bye', handlers.left);
    // лук и магия рукой №6: их «Регент» в дуэли — капсула соперника (BOSS), попадание → api.pvp.projectileHit с fx стихии
    if (EXT && net.remote && net.remote.name) { H.opponent.name = String(net.remote.name).slice(0, 24); H.opponent.hero = net.remote.hero || null; S.oppHello = { ...net.remote }; }
    S.lastRecv = now();
    setPhase('lobby');
    H.respawn(mySpawn());
    sendHello(true);
  }
  function stop() {
    if (!S.active) return;
    S.active = false;
    for (const [t, fn] of Object.entries(handlers)) { try { net.off(t, fn); } catch (e) { /* ignore */ } }
    try { net.off('bye', handlers.left); } catch (e) { /* ignore */ }
    combat.setMode('boss');
  }
  function leave() {
    send('duel', { phase: 'leave' });
    stop();
  }
  function requestRematch() {
    if (S.phase !== 'match_end') return;
    S.rematch.me = true;
    send('duel', { phase: 'rematch' });
    if (role === 'host' && S.rematch.opp) startMatch();
  }

  // ---------------------------------------------------------------- кадр
  const NEUTRAL = Object.freeze({ valid: true, source: 'pvp', moveX: 0, moveZ: 0 });
  function beforeUpdate(input) {
    if (!S.active) return input;
    H.setPing(num(net.ping, 0));
    if (EXT) {
      let st = null;
      try { st = remote.getState(); } catch (e) { st = null; }
      if (st) combat.setOpponent({ ...st, name: st.name || H.opponent.name, hero: st.hero || H.opponent.hero });
    } else {
      const st = buf.sample(now());
      if (st) combat.setOpponent({ ...st, name: H.opponent.name, hero: H.opponent.hero });
      H.setGhosts(buf.ghosts(now()));
    }
    if (S.phase !== 'fight' || H.isDead()) {
      return { ...NEUTRAL, viewYaw: input && input.viewYaw, moveMode: input && input.moveMode, tMs: input && input.tMs };
    }
    const f = H.status();
    if (f.stunT > 0) return { ...NEUTRAL, viewYaw: input && input.viewYaw, moveMode: input && input.moveMode };
    if (f.slowT > 0 && input && input.valid) {
      const k = 1 - PC.slowFactor;
      return { ...input, moveX: num(input.moveX, 0) * (input.moveMode === 'steer' ? 1 : k), moveZ: num(input.moveZ, 0) * k };
    }
    return input;
  }
  function afterUpdate(events) {
    if (!S.active) return events;
    let out = Array.isArray(events) ? events.slice() : [];
    for (const m of H.drainOutbox()) { const { t, ...p } = m; send(t, p); }
    // «любимое заклинание»: свои касты (player_cast 'rune' — дубль rune_cast от main.js adaptEvents)
    if (S.phase === 'fight') for (const e of out) {
      const d = e.data || {};
      if (d.remote) continue;
      if (e.type === 'player_cast' && d.ability !== 'rune') H.count(d.ability === 'throw' ? (d.kind === 'prism' ? 'prism' : 'sphere') : d.ability);
      else if (e.type === 'rune_cast') H.count(d.rune);
      else if (e.type === 'sigil_cast') H.count(d.sigil);
      else if (e.type === 'burst') H.count('burst');
      else if (e.type === 'bow_release') H.count('arrow');
      else if (e.type === 'hand_spell_throw') H.count('hand_orb');
    }
    // свои события сопернику (для его эффектов); с сетью №2 их пересылает её сессия
    if (!EXT) for (const e of out) {
      if (PC.forwardEventTypes.includes(e.type)) send('ev', { e: { id: e.id, type: e.type, position: e.position, data: e.data } });
    }
    checkDeath();
    if (S.remote.length) { out = out.concat(S.remote); S.remote.length = 0; }
    if (S.events.length) { out = out.concat(S.events); S.events.length = 0; }
    return out;
  }
  // смерть в бою (на любом экране: удары приходят и на паузе)
  function checkDeath() {
    if (S.phase !== 'fight' || !H.isDead()) return;
    if (role === 'host') endRound('guest', 'ko');
    else if (now() - S.deadSent > PC.net.deadResendMs) { S.deadSent = now(); send('duel', { phase: 'dead', round: S.round }); }
  }
  function frame() {
    if (!S.active) return;
    const t = now();
    checkDeath();
    // хост раз в 0,5 с повторяет текущую фазу (потерянные round_end/match_end доходят); своя техпобеда — тоже
    if (role === 'host' && S.phase !== 'lobby' && t - (S.syncSent || 0) >= 500) { S.syncSent = t; send('duel', hostPhaseMsg()); }
    if (S.phase === 'match_end' && S.claim && t - (S.claimSent || 0) >= 1000) {
      S.claimSent = t;
      send('duel', { phase: 'match_end', winner: role, reason: 'disconnect', claim: true, round: S.round, score: [S.score.host, S.score.guest] });
    }
    for (const m of H.drainOutbox()) { const { t: tt, ...p } = m; send(tt, p); }
    if (!S.oppHello) sendHello(false);
    if (!EXT && t - S.stSent >= 1000 / PC.net.stHz) {
      S.stSent = t;
      send('st', { ...H.myState(), name: me.name || 'Игрок', hero: me.hero || null });
    }
    // готовность (экран боя открыт) и счёт урона для итогов
    if (S.phase === 'lobby' && S.meReady && t - S.readySent >= 700) { S.readySent = t; send('duel', { phase: 'ready' }); }
    if (S.phase !== 'lobby' && t - S.statsSent >= 500) { S.statsSent = t; send('duel', { phase: 'stats', taken: Math.round(H.stats.taken * 10) / 10 }); }
    const el = (t - S.phaseAt) / 1000;
    // обрыв: пауза «Соперник отключился…», через disconnectWait — техническая победа
    const live = S.phase === 'countdown' || S.phase === 'fight' || S.phase === 'round_end';
    const lost = net.state === 'lost' || (!EXT && t - S.lastRecv > PC.net.silentAfterMs);
    if (live && lost) {
      S.pausedFrom = S.phase; S.pausedAt = t;
      setPhase('paused', S.phaseAt);
      S.pausedAt = t;
      S.events.push({ id: `pvp-pause-${Math.round(t)}`, type: 'pvp_pause', position: combat.getSnapshot().player.position, data: { wait: R.disconnectWait } });
      return;
    }
    if (S.phase === 'paused') {
      if (!lost) {
        const back = S.pausedFrom || 'countdown';
        S.phase = back; H.setAcceptHits(back === 'fight'); H.setFrozen(back !== 'fight');
        S.phaseAt += t - S.pausedAt;
        if (role === 'host') { S.syncSent = t; send('duel', hostPhaseMsg()); }
      } else if ((t - S.pausedAt) / 1000 >= R.disconnectWait) {
        S.score[role] = Math.max(S.score[role], R.toWin);
        matchEnd(role, 'disconnect');
      }
      return;
    }
    if (role !== 'host') return;
    if (S.phase === 'lobby' && S.meReady && S.oppReady) startMatch();
    else if (S.phase === 'countdown' && el >= R.countdown) beginFight();
    else if (S.phase === 'fight' && el >= R.roundTime) {
      const o = H.opponent;
      const oppHp = Number.isFinite(o.ackHp) && t - num(o.ackAt, -1e9) < 1500 ? Math.min(num(o.hp, 0), o.ackHp) : num(o.hp, 0);
      const mine = H.hpFrac(), theirs = oppHp / Math.max(1, num(o.maxHp, 1));
      endRound(Math.abs(mine - theirs) < 0.005 ? null : mine > theirs ? 'host' : 'guest', 'time');
    } else if (S.phase === 'round_end' && el >= R.roundEnd) {
      const w = S.winner;
      const done = (w && S.score[w] >= R.toWin) || S.round >= R.maxRounds;
      if (done) {
        const fw = S.score.host === S.score.guest ? null : S.score.host > S.score.guest ? 'host' : 'guest';
        matchEnd(fw, 'score');
      } else { S.round++; beginCountdown(); }
    }
  }
  function timeScale() {
    const t = now();
    if (S.phase === 'round_end' && t < S.slowUntil) return R.slowScale;
    return 1;
  }
  function favorite() {
    let best = null, n = 0;
    const list = Object.entries(H.stats.casts);
    const pool = list.some(([k]) => k !== 'bolt') ? list.filter(([k]) => k !== 'bolt') : list;   // огонь из зажатой руки — только если больше ничего
    for (const [k, c] of pool) if (c > n) { best = k; n = c; }
    return best ? { id: best, name: ABILITY_NAMES[best] || best, count: n } : null;
  }
  function getView() {
    const t = now();
    const el = (t - S.phaseAt) / 1000;
    const v = {
      active: S.active, role, phase: S.phase, round: S.round, score: scoreMe(), toWin: R.toWin,
      myName: me.name || 'Вы', oppName: H.opponent.name, oppConnected: !!S.oppHello || EXT, oppReady: S.oppReady,
      countdown: S.phase === 'countdown' ? Math.max(0, R.countdown - el) : 0,
      fightBanner: S.phase === 'fight' && t < S.fightBannerUntil,
      roundTime: S.phase === 'fight' ? el : 0,
      winner: winnerRel(S.winner), reason: S.reason,
      disconnectLeft: S.phase === 'paused' ? Math.max(0, R.disconnectWait - (t - S.pausedAt) / 1000) : 0,
      rematch: { ...S.rematch }, ping: Math.round(num(net.ping, 0)),
    };
    if (S.phase === 'match_end') {
      const c = coach && typeof coach === 'function' ? coach() : null;
      v.result = {
        won: v.winner === 'me', draw: v.winner === null, score: scoreMe(), reason: S.reason,
        dealt: Math.round(Math.max(H.stats.dealt, H.stats.oppTaken)), taken: Math.round(H.stats.taken), hitsSent: H.stats.sent, hitsLanded: H.stats.landed,
        dodged: H.stats.dodged, blocked: H.stats.blocked, parried: H.stats.parried,
        accuracy: c && Number.isFinite(c.accuracy) ? c.accuracy : null, favorite: favorite(),
        time: Math.round((t - S.matchStart) / 1000),
      };
    }
    H.setView({ phase: v.phase, round: v.round, score: v.score, winner: v.winner, countdown: v.countdown, disconnectLeft: v.disconnectLeft });
    return v;
  }
  return {
    start, stop, leave, requestRematch, beforeUpdate, afterUpdate, frame, timeScale, getView,
    setReady(v) { S.meReady = !!v; }, get external() { return EXT; },
    get active() { return S.active; }, get phase() { return S.phase; }, get role() { return role; },
    get hooks() { return H; }, get state() { return S; }, buffer: buf, spawns: sp, config: PC,
  };
}

// C7: точки дуэли. Лес №5 (BRIGHT_FOREST.duel.spawns) или две точки ±offset от центра арены.
export function resolveSpawns(spawns, arena, offset = 12) {
  if (Array.isArray(spawns) && spawns.length >= 2 && spawns.every((s) => s && Number.isFinite(s.x) && Number.isFinite(s.z))) {
    return spawns.slice(0, 2).map((s, i, a) => {
      const o = a[1 - i];
      return { x: s.x, z: s.z, yaw: Number.isFinite(s.yaw) ? s.yaw : Math.atan2(o.x - s.x, o.z - s.z) };
    });
  }
  const cx = arena && Number.isFinite(arena.x) ? arena.x : 0, cz = arena && Number.isFinite(arena.z) ? arena.z : 0;
  return [{ x: cx, z: cz + offset, yaw: Math.PI }, { x: cx, z: cz - offset, yaw: 0 }];
}

// -----------------------------------------------------------------------------
// Панель дуэли (DOM) и заглушка модели соперника (пока нет modules/remotePlayer.js №2).
// -----------------------------------------------------------------------------
const PVP_CSS = `
.pvp-root{position:absolute;inset:0;pointer-events:none;z-index:30;font-family:'Cinzel','Trajan Pro','Palatino Linotype',Georgia,serif;color:#f3e6c8;text-shadow:0 2px 6px rgba(0,0,0,.8)}
.pvp-root[hidden]{display:none}
.pvp-top{position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;padding:6px 18px;background:linear-gradient(180deg,rgba(18,14,10,.82),rgba(10,8,6,.6));border:1px solid rgba(201,164,92,.55);border-radius:3px;font-size:15px;letter-spacing:.08em;white-space:nowrap}
.pvp-top b{color:#ffd98a;font-size:18px}.pvp-top .pvp-opp{color:#e7a0ff}.pvp-top .pvp-rd{font-size:12px;opacity:.8;letter-spacing:.2em}
.pvp-pips{display:inline-flex;gap:4px}.pvp-pips i{width:9px;height:9px;border-radius:50%;border:1px solid #c9a45c;display:inline-block}.pvp-pips i.on{background:#ffd98a;box-shadow:0 0 6px #ffd98a}
.pvp-opp .pvp-pips i.on{background:#e7a0ff;box-shadow:0 0 6px #e7a0ff;border-color:#b77bd6}
.pvp-center{position:absolute;top:34%;left:0;right:0;text-align:center;font-size:84px;font-weight:700;letter-spacing:.12em;opacity:0;transition:opacity .15s}
.pvp-center.on{opacity:1}.pvp-center small{display:block;font-size:20px;letter-spacing:.3em;opacity:.85;margin-top:6px}
.pvp-center.win{color:#ffd98a}.pvp-center.lose{color:#ff8a7a}.pvp-center.fight{color:#fff2c0}
.pvp-modal{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:360px;max-width:min(560px,92vw);padding:22px 26px;background:linear-gradient(180deg,rgba(22,17,12,.95),rgba(12,9,7,.92));border:1px solid rgba(201,164,92,.7);box-shadow:0 10px 40px rgba(0,0,0,.6);pointer-events:auto;text-align:center}
.pvp-modal h2{margin:0 0 6px;font-size:30px;letter-spacing:.14em;color:#ffd98a}.pvp-modal h2.lose{color:#ff8a7a}
.pvp-modal .pvp-sc{font-size:22px;margin-bottom:12px}
.pvp-modal table{width:100%;border-collapse:collapse;font-family:Georgia,serif;font-size:14px;margin:8px 0 16px}
.pvp-modal td{padding:4px 6px;border-bottom:1px solid rgba(201,164,92,.18);text-align:left}.pvp-modal td+td{text-align:right;color:#ffe7b0}
.pvp-btns{display:flex;gap:12px;justify-content:center}
.pvp-btns button{font:inherit;font-size:15px;letter-spacing:.1em;padding:9px 18px;background:rgba(40,30,18,.9);color:#f3e6c8;border:1px solid #c9a45c;cursor:pointer}
.pvp-btns button:hover{background:rgba(70,52,28,.95)}.pvp-btns button[disabled]{opacity:.55;cursor:default}
.pvp-note{font-family:Georgia,serif;font-size:13px;opacity:.8;margin-top:10px}
.pvp-tag{position:absolute;transform:translate(-50%,-100%);font-family:Georgia,serif;font-size:13px;color:#f1d6ff;text-align:center;white-space:nowrap}
.pvp-tag .bar{width:84px;height:5px;margin:3px auto 0;background:rgba(0,0,0,.6);border:1px solid rgba(231,160,255,.6)}.pvp-tag .bar i{display:block;height:100%;background:linear-gradient(90deg,#b35cff,#e7a0ff)}
.pvp-lobby{position:absolute;bottom:18%;left:0;right:0;text-align:center;font-size:18px;letter-spacing:.12em}
`;

export function createPvpView({ THREE, scene, camera, root, onRematch, onMenu, externalModel = false } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return { update() {}, show() {}, hide() {}, dispose() {} };
  if (!doc.getElementById('pvp-style')) {
    const st = doc.createElement('style'); st.id = 'pvp-style'; st.textContent = PVP_CSS; doc.head.appendChild(st);
  }
  const el = doc.createElement('div');
  el.className = 'pvp-root'; el.hidden = true;
  el.innerHTML = `<div class="pvp-top"><span class="pvp-me"><span class="pvp-pips"></span> <b class="pvp-mys">0</b></span><span class="pvp-rd">РАУНД 1</span><span class="pvp-opp"><b class="pvp-ops">0</b> <span class="pvp-pips"></span> <span class="pvp-on">Соперник</span></span></div>
<div class="pvp-center"></div><div class="pvp-lobby"></div><div class="pvp-tag"><span class="nm"></span><div class="bar"><i></i></div></div><div class="pvp-modal" hidden></div>`;
  (root || doc.body).appendChild(el);
  const $ = (s) => el.querySelector(s);
  const center = $('.pvp-center'), modal = $('.pvp-modal'), lobby = $('.pvp-lobby'), tag = $('.pvp-tag');
  let lastKey = '', lastModal = '', lastTop = '';
  // заглушка модели соперника: капсула с кольцом (если №2 не рисует удалённого героя)
  let stub = null;
  if (THREE && scene && !externalModel) {
    try {
      const g = new THREE.Group(); g.name = 'pvp-opponent-stub';
      const mat = new THREE.MeshStandardMaterial({ color: 0x5b2a7a, emissive: 0x7a2cff, emissiveIntensity: 0.35, roughness: 0.5, metalness: 0.1 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.95, 6, 14), mat); body.position.y = 0.9; body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), mat); head.position.set(0, 1.62, 0.02);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 8), new THREE.MeshBasicMaterial({ color: 0xffd98a }));
      nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.3, 0.45);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 32), new THREE.MeshBasicMaterial({ color: 0xc27bff, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04;
      const shield = new THREE.Mesh(new THREE.SphereGeometry(0.95, 20, 14), new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.22, depthWrite: false }));
      shield.position.y = 1.0; shield.visible = false;
      g.add(body, head, nose, ring, shield); g.visible = false;
      scene.add(g);
      stub = { g, mat, shield };
    } catch (e) { stub = null; }
  }
  const _v = THREE ? new THREE.Vector3() : null;
  function pips(n, toWin) { let s = ''; for (let i = 0; i < toWin; i++) s += `<i class="${i < n ? 'on' : ''}"></i>`; return s; }
  function center1(text, cls, small) {
    const key = `${text}|${cls}|${small || ''}`;
    if (key === lastKey) return;
    lastKey = key;
    center.className = `pvp-center ${text ? 'on' : ''} ${cls || ''}`;
    center.innerHTML = text ? `${text}${small ? `<small>${small}</small>` : ''}` : '';
  }
  function setModal(html) {
    if (html === lastModal) return;
    lastModal = html;
    modal.hidden = !html;
    modal.innerHTML = html || '';
    const r = modal.querySelector('[data-a="rematch"]'), m = modal.querySelector('[data-a="menu"]');
    if (r) r.onclick = () => { if (onRematch) onRematch(); };
    if (m) m.onclick = () => { if (onMenu) onMenu(); };
  }
  function update(v, snap) {
    if (!v || !v.active) { if (!el.hidden) el.hidden = true; if (stub) stub.g.visible = false; lastTop = ''; return; }
    if (el.hidden) el.hidden = false;
    // DOM трогаем только при изменении (панель живёт каждый кадр)
    const rd = v.phase === 'lobby' ? 'ДУЭЛЬ' : `РАУНД ${v.round}${v.phase === 'fight' ? ' · ' + Math.floor(v.roundTime) + ' с' : ''}${v.ping ? ' · ' + v.ping + ' мс' : ''}`;
    const lb = v.phase === 'lobby' ? (v.oppReady ? 'Соперник готов…' : v.oppConnected ? 'Ждём, пока соперник войдёт в бой…' : 'Ожидание соперника…') : '';
    const topKey = `${v.score[0]}|${v.score[1]}|${v.toWin}|${v.oppName}|${rd}|${lb}`;
    if (topKey !== lastTop) {
      lastTop = topKey;
      $('.pvp-me .pvp-pips').innerHTML = pips(v.score[0], v.toWin);
      $('.pvp-opp .pvp-pips').innerHTML = pips(v.score[1], v.toWin);
      $('.pvp-mys').textContent = v.score[0]; $('.pvp-ops').textContent = v.score[1];
      $('.pvp-on').textContent = v.oppName || 'Соперник';
      $('.pvp-rd').textContent = rd;
      lobby.textContent = lb;
    }
    if (v.phase === 'countdown') {
      const n = Math.ceil(v.countdown);
      center1(n > 0 ? String(n) : 'БОЙ!', n > 0 ? '' : 'fight', n > 0 ? `раунд ${v.round}` : '');
    } else if (v.phase === 'fight' && v.fightBanner) center1('БОЙ!', 'fight');
    else if (v.phase === 'round_end') center1(v.winner === 'me' ? 'ПОБЕДА РАУНДА' : v.winner === 'opponent' ? 'ПОРАЖЕНИЕ' : 'НИЧЬЯ', v.winner === 'me' ? 'win' : v.winner === 'opponent' ? 'lose' : '', v.reason === 'time' ? 'время вышло' : `${v.score[0]} : ${v.score[1]}`);
    else center1('', '');
    if (v.phase === 'paused') {
      setModal(`<h2>Соперник отключился…</h2><div class="pvp-sc">${Math.ceil(v.disconnectLeft)} с</div><div class="pvp-note">Если связь не вернётся, победа будет засчитана вам.</div>`);
    } else if (v.phase === 'match_end' && v.result) {
      const r = v.result;
      const title = r.draw ? 'НИЧЬЯ' : r.won ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
      const why = r.reason === 'disconnect' ? 'техническая победа: соперник отключился' : r.reason === 'left' ? 'соперник покинул дуэль' : '';
      const acc = r.accuracy === null ? '—' : `${Math.round(r.accuracy * (r.accuracy <= 1 ? 100 : 1))}%`;
      const hitAcc = r.hitsSent ? `${Math.round(100 * r.hitsLanded / r.hitsSent)}% (${r.hitsLanded}/${r.hitsSent})` : '—';
      setModal(`<h2 class="${r.won || r.draw ? '' : 'lose'}">${title}</h2><div class="pvp-sc">${v.myName} ${r.score[0]} : ${r.score[1]} ${v.oppName}</div>${why ? `<div class="pvp-note">${why}</div>` : ''}
<table><tr><td>Нанесённый урон</td><td>${r.dealt}</td></tr><tr><td>Полученный урон</td><td>${r.taken}</td></tr>
<tr><td>Точность жестов</td><td>${acc}</td></tr><tr><td>Попадания</td><td>${hitAcc}</td></tr>
<tr><td>Уклонения / блоки / парирования</td><td>${r.dodged} / ${r.blocked} / ${r.parried}</td></tr>
<tr><td>Любимое заклинание</td><td>${r.favorite ? `${r.favorite.name} ×${r.favorite.count}` : '—'}</td></tr><tr><td>Время матча</td><td>${r.time} с</td></tr></table>
<div class="pvp-btns"><button data-a="rematch" ${v.rematch.me || r.reason === 'disconnect' || r.reason === 'left' ? 'disabled' : ''}>${v.rematch.me ? 'Ждём соперника…' : 'Реванш'}</button><button data-a="menu">В меню</button></div>
<div class="pvp-note">${v.rematch.opp && !v.rematch.me ? 'Соперник хочет реванш' : v.rematch.me ? 'Реванш начнётся, когда соперник подтвердит' : ''}</div>`);
    } else setModal('');
    // соперник: заглушка модели и табличка над головой
    const o = snap && snap.opponent;
    if (stub) {
      stub.g.visible = !!o;
      if (o) {
        stub.g.position.set(o.position.x, o.position.y, o.position.z);
        stub.g.rotation.y = o.yaw;
        stub.shield.visible = !!o.shielding;
        stub.mat.emissiveIntensity = o.invulnerable ? 0.9 : o.stunned ? 0.1 : 0.35;
        stub.g.rotation.z = o.dead ? Math.PI / 2 : 0;
        stub.g.position.y += o.dead ? 0.4 : 0;
      }
    }
    if (o && camera && _v && !externalModel) {
      _v.set(o.position.x, o.position.y + 2.15, o.position.z).project(camera);
      const vis = _v.z < 1 && Math.abs(_v.x) < 1.2 && Math.abs(_v.y) < 1.2;
      tag.style.display = vis ? '' : 'none';
      if (vis) {
        const W = el.clientWidth || window.innerWidth, Hh = el.clientHeight || window.innerHeight;
        tag.style.left = `${(_v.x + 1) * 0.5 * W}px`; tag.style.top = `${(1 - _v.y) * 0.5 * Hh}px`;
        const nm = o.name || 'Соперник', w = `${Math.round(Math.max(0, Math.min(100, 100 * o.hp / Math.max(1, o.maxHp))))}%`;
        if (tag._nm !== nm) { tag._nm = nm; tag.querySelector('.nm').textContent = nm; }
        if (tag._w !== w) { tag._w = w; tag.querySelector('.bar i').style.width = w; }
      }
    } else tag.style.display = 'none';
  }
  function dispose() {
    el.remove();
    if (tag) tag.remove();
    if (stub) { scene.remove(stub.g); stub.g.traverse((m) => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); }); }
  }
  return { update, dispose, el, external: !!externalModel, get stub() { return stub; } };
}

// -----------------------------------------------------------------------------
// Клей для main.js: сеть, сессия, панель. host — функции main.js (старт боя, выход, DEBUG, итоги тренера).
// -----------------------------------------------------------------------------
export function createPvpController({ THREE, scene, camera, combat, config, settings, arena, host = {} } = {}) {
  const PC = mergePvpConfig(config && config.pvp);
  let session = null, net = null, view = null, spawns = null, starting = false;
  const clock = () => performance.now();
  const uiRoot = typeof document !== 'undefined' ? (document.getElementById('ao-app') || document.body) : null;
  // C7: точки дуэли из Сияющего леса (№5), если модуль есть. Грузится только при старте дуэли.
  let forestP = null;
  const forestReady = () => forestP || (forestP = (host.duelSpawns ? Promise.resolve(host.duelSpawns()) : import('./brightForest.js').then((m) => {
    const d = m && m.BRIGHT_FOREST && m.BRIGHT_FOREST.duel;
    return d && Array.isArray(d.spawns) ? d.spawns : null;
  })).then((sp) => { if (Array.isArray(sp)) spawns = sp; return sp; }).catch(() => null));

  let external = false;           // соперника рисует сеть №2 (remotePlayer): своя капсула и табличка не нужны
  function ensureView() {
    if (view && view.external === external) return view;
    if (view) view.dispose();
    view = createPvpView({ THREE, scene, camera, root: uiRoot, externalModel: external,
      onRematch: () => { if (session) session.requestRematch(); },
      onMenu: () => { stop(); if (host.exitToMenu) host.exitToMenu(); },
    });
    return view;
  }
  async function makeLocalNet() {
    // сеть №2 (net/net.js), когда она есть в main; иначе своя заглушка на BroadcastChannel
    try {
      const m = await import('../net/net.js');
      if (m && typeof m.createNet === 'function') {
        const n = m.createNet({ transport: 'local' });
        if (n && typeof n.autoPair === 'function') return n;
        if (n && typeof n.close === 'function') n.close();
      }
    } catch (e) { /* модуля нет — заглушка */ }
    return createLocalNet({ name: (settings && settings.netName) || '' });
  }
  async function startLocal(code = 'LOCAL') {
    if (session || starting) return;
    starting = true;
    try {
      if (host.setDebug) host.setDebug(true);
      net = await makeLocalNet();
      ensureView();
      await net.autoPair(code);
      await forestReady();
      begin(net, { name: (settings && settings.netName) || (net.isHost ? 'Хост' : 'Гость') });
    } finally { starting = false; }
  }
  // для лобби №2 (app.onNetReady): info = { net, remote, isHost, code, opponent, mode, seed } — соединение уже есть
  function startWithNet(n, opts = {}) {
    if (session) stop(true);
    net = n;
    external = !!(opts.remote && typeof opts.remote.getState === 'function');
    ensureView();
    return forestReady().then(() => begin(n, opts));
  }
  function begin(n, opts) {
    session = createPvpSession({
      combat, net: n, cfg: PC, clock, spawns, arena, remote: external ? opts.remote : null,
      me: { name: opts.name || (settings && settings.netName) || 'Игрок', hero: opts.hero || (settings && settings.hero) || null },
      coach: host.coach,
    });
    session.start();
    // DEBUG — сразу в бой; с камерой — обычный путь (камера → калибровка → «В бой»), матч начнётся,
    // когда оба откроют экран боя (готовность шлёт сессия)
    const dbg = typeof host.isDebug === 'function' ? host.isDebug() : true;
    if (dbg || !host.toCamera) { if (host.startFight) host.startFight(); } else host.toCamera();
    return session;
  }
  function stop(keepNet) {
    if (session) { try { session.leave(); } catch (e) { /* ignore */ } session = null; }
    if (net && !keepNet) {
      if (external && host.leaveNet) { try { host.leaveNet(); } catch (e) { /* ignore */ } }
      else { try { net.close(); } catch (e) { /* ignore */ } }
    }
    if (!keepNet) net = null;
    if (view) view.update(null, null);
  }
  return {
    get active() { return !!(session && session.active); },
    get inMatch() { return !!(session && session.active && session.phase !== 'lobby' && session.phase !== 'match_end'); },
    get session() { return session; },
    startLocal, startWithNet, stop,
    autoStart(search) {
      try {
        const q = new URLSearchParams(search || '');
        if (q.get('pvp') === 'local') startLocal(q.get('room') || 'LOCAL').catch((e) => console.warn('[PVP] local', e));
      } catch (e) { /* ignore */ }
    },
    beforeUpdate(input) { return session ? session.beforeUpdate(input) : input; },
    afterUpdate(events) { return session ? session.afterUpdate(events) : events; },
    timeScale() { return session ? session.timeScale() : 1; },
    frame(snap, screen) {
      if (!session) { if (view) view.update(null, null); return; }
      if (screen) session.setReady(screen === 'playing' || screen === 'paused');
      session.frame();
      ensureView().update(session.getView(), snap);
    },
    debug() { return session ? { view: session.getView(), phase: session.phase, role: session.role, stats: { ...session.hooks.stats } } : null; },
  };
}
