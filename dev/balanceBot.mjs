// [W5-СЛОЖНОСТЬ] Бот баланса: скриптовый игрок перед камерой для замера сложности боя с Регентом.
// Не тест сам по себе — его зовут dev/difficulty.test.mjs и tools/balance_bot.mjs (таблица для PR).
//
// Модель человека (режим «Новичок» с автоходом — так играет большинство на площадке):
//  • видит игру с задержкой: камера и распознавание 100–200 мс (latency) — решения по старому снимку;
//  • ввод обновляется с частотой распознавания (hz), между отсчётами держится прежний;
//  • на атаку отвечает не сразу: реакция человека (reaction) + исполнение жеста (exec);
//  • отвечает не на каждую атаку: accuracy — внимание, доля атак, которые он замечает и на которые выбирает верный
//    ответ (новичок 60%, средний 80%, опытный 92%); жест иногда не распознаётся (execFail: 20 / 10 / 6% — по
//    dev/controls.soak.mjs осознанный толчок щита распознаётся в 75–100% случаев);
//  • ответы честные, как в подсказке телеграфа: удар ладонью — рывок из круга (щитом не держится),
//    сфера и нова — щит (нет энергии — рывок в момент удара, тайминг с разбросом);
//  • нападает урывками: «OK» держит отрезками okOn / отдыхает okOff, жест мигает (flicker);
//    выброс — когда заметил, что готов (burstDelay); сфера двумя руками — раз в throwEvery с
//    (лепит 0,9–1,8 с, автоход стоит); «Врата»/«Столп» — раз в sigilEvery с; ультимейт — через ultDelay
//    после готовности, обе руки вверх 0,8 с.
// Это НЕ проверка реального трекинга — ориентир баланса между уровнями сложности.
import { createCombat } from '../modules/combat.js';
import { createBossBrain } from '../modules/boss.js';

export const DT = 1 / 60;

// Уровни мастерства. medium — «бот средней точности», по нему — цели времени из задачи волны.
export const SKILLS = Object.freeze({
  novice: Object.freeze({
    hz: 12, latency: [0.15, 0.2], reaction: [0.45, 0.8], exec: 0.2, accuracy: 0.6, execFail: 0.2,
    okOn: [1.0, 2.5], okOff: [1.0, 2.5], flicker: 0.25,
    burstDelay: [3, 8], burstPower: [0.3, 0.7], throwEvery: null, conjure: [1.2, 2.0], sigilEvery: null,
    ultDelay: [2, 5], dashTiming: 0.2, shieldEnergy: 14,
  }),
  medium: Object.freeze({
    hz: 15, latency: [0.1, 0.2], reaction: [0.35, 0.6], exec: 0.15, accuracy: 0.8, execFail: 0.1,
    okOn: [1.5, 3.5], okOff: [0.8, 1.8], flicker: 0.15,
    burstDelay: [1.5, 5], burstPower: [0.4, 0.8], throwEvery: [10, 18], conjure: [0.9, 1.8], sigilEvery: [22, 40],
    ultDelay: [1, 3], dashTiming: 0.14, shieldEnergy: 14,
  }),
  expert: Object.freeze({
    hz: 20, latency: [0.1, 0.15], reaction: [0.28, 0.45], exec: 0.12, accuracy: 0.92, execFail: 0.06,
    okOn: [2.0, 4.0], okOff: [0.4, 1.0], flicker: 0.08,
    burstDelay: [0.5, 2], burstPower: [0.6, 0.95], throwEvery: [6, 10], conjure: [0.8, 1.3], sigilEvery: [13, 20],
    ultDelay: [0.5, 1.5], dashTiming: 0.08, shieldEnergy: 14,
  }),
});

const DASH = { distance: 3.6, iframe: 0.28, cost: 20 };

function rngOf(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const baseInput = () => ({
  source: 'cv', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0,
  attack: false, shield: false, burst: false, autoWalk: true, gestureMode: 'novice',
});

// Где будет герой через t секунд при обходе Регента автоходом (круговое движение по текущей скорости).
function predictOrbit(pos, vel, boss, t) {
  const rx = pos.x - boss.x, rz = pos.z - boss.z;
  const r = Math.hypot(rx, rz) || 1e-6;
  const th = Math.atan2(rx, rz);
  const tx = Math.cos(th), tz = -Math.sin(th);
  const vt = vel.x * tx + vel.z * tz;
  const th2 = th + (vt / r) * t;
  return { x: boss.x + r * Math.sin(th2), z: boss.z + r * Math.cos(th2) };
}

/**
 * Один бой бота. Возвращает итог и счётчики.
 * opts: level, seed, skill ('novice'|'medium'|'expert' или объект), maxSec, config (бой), brainConfig (Регент).
 */
export function runBotFight(opts = {}) {
  const level = opts.level || 'normal';
  const seed = opts.seed || 1;
  const S = typeof opts.skill === 'object' && opts.skill ? opts.skill : SKILLS[opts.skill || 'medium'];
  const maxSec = opts.maxSec || 600;
  const c = createCombat({ config: opts.config || {}, bossBrain: createBossBrain({ ...(opts.brainConfig || {}), seed }) });
  c.setDifficulty(level);
  c.reset();
  const rnd = rngOf(seed * 7919 + 101);
  const U = (a) => a[0] + rnd() * (a[1] - a[0]);
  const LAG = Math.max(0, Math.round(U(S.latency) / DT));
  const PERIOD = Math.max(1, Math.round(1 / S.hz / DT));
  const hist = [];
  const threats = new Map();   // id → { kind, respond, reactAt, impactAt, plan }
  const out = {
    level, seed, skill: opts.skill || 'medium', status: 'timeout', t: 0, hp: 0, bossHp: 0, bossMaxHp: 0,
    taken: 0, attacks: { slam: 0, orb: 0, nova: 0 }, hits: { slam: 0, orb: 0, nova: 0 },
    blocks: 0, dodges: 0, ults: 0, stage2At: null, maxTelegraphs: 0,
  };
  let cur = baseInput();
  let okOn = false, okUntil = U([0.5, 1.5]);
  let shieldUntil = -1, shieldFrom = Infinity;
  let pendingDash = null;      // { at, dir: {x,z} } — рывок в осях камеры
  let busy = null;             // { kind: 'conjure'|'sigil'|'ult', until, ... }
  let nextThrow = S.throwEvery ? U(S.throwEvery) : Infinity;
  let nextSigil = S.sigilEvery ? U(S.sigilEvery) : Infinity;
  let burstAt = null, ultAt = null;

  for (let i = 0; i < maxSec / DT; i++) {
    const now = c.getSnapshot();
    if (now.status !== 'playing') break;
    hist.push(now);
    if (hist.length > LAG + 1) hist.shift();
    const t = now.time;
    out.maxTelegraphs = Math.max(out.maxTelegraphs, now.telegraphs.length);

    if (i % PERIOD === 0) {
      const v = hist[0];   // что игрок видит сейчас (с задержкой камеры)
      const lagT = t - v.time;
      const p = v.player;
      const boss = v.boss.position;
      const inp = baseInput();

      // — оборона: новые атаки на экране —
      for (const tg of v.telegraphs) {
        if (threats.has(tg.id)) continue;
        const respond = rnd() < S.accuracy && rnd() >= S.execFail;
        if (opts.trace) opts.trace({ t, id: tg.id, kind: tg.kind, seen: true, respond, remaining: tg.remaining, lagT });
        const th = { kind: tg.kind, respond, reactAt: t + U(S.reaction), impactAt: t - lagT + tg.remaining, tg, planned: false };
        threats.set(tg.id, th);
      }
      for (const [id, th] of threats) {
        if (th.impactAt < t - 3) { threats.delete(id); continue; }
        if (!th.respond || th.planned || t < th.reactAt) continue;
        th.planned = true;
        const tg = th.tg;
        const left = th.impactAt - t;   // до удара по часам игры
        if (tg.kind === 'slam') {
          // рывок из круга: выбрать сторону, где после рывка и дальнейшего автохода героя в круге не будет
          const f = { x: boss.x - p.position.x, z: boss.z - p.position.z };
          const fl = Math.hypot(f.x, f.z) || 1; f.x /= fl; f.z /= fl;
          const right = { x: -f.z, z: f.x };
          const opts2 = [{ cx: 1, cz: 0 }, { cx: -1, cz: 0 }, { cx: 0, cz: -1 }, { cx: 0, cz: 1 }];
          let best = null, bestGap = -Infinity;
          const stay = predictOrbit(p.position, p.velocity, boss, Math.max(0, left + lagT));
          const stayGap = Math.hypot(stay.x - tg.center.x, stay.z - tg.center.z) - tg.radius;
          for (const o of opts2) {
            const w = { x: o.cx * right.x + o.cz * f.x, z: o.cx * right.z + o.cz * f.z };
            const after = { x: p.position.x + w.x * DASH.distance, z: p.position.z + w.z * DASH.distance };
            const end = predictOrbit(after, p.velocity, boss, Math.max(0, left + lagT - 0.25));
            const gap = Math.hypot(end.x - tg.center.x, end.z - tg.center.z) - tg.radius;
            if (gap > bestGap) { bestGap = gap; best = o; }
          }
          if (stayGap < 0.3 && best) pendingDash = { at: t + S.exec, dir: { x: best.cx, z: best.cz }, id };
          if (opts.trace) opts.trace({ t, id, kind: 'slam', left, stayGap, bestGap, dash: !!(stayGap < 0.3 && best) });
        } else {
          // сфера / нова: щит до удара (и пролёта сферы); нет энергии — рывок в момент удара
          const flight = tg.kind === 'orb' && tg.projectileSpeed > 0
            ? Math.hypot(tg.origin.x - p.position.x, tg.origin.z - p.position.z) / tg.projectileSpeed : 0;
          const end = th.impactAt + flight + 0.15;
          if (p.energy >= S.shieldEnergy) {
            shieldFrom = Math.min(shieldFrom, t + S.exec);
            shieldUntil = Math.max(shieldUntil, end);
          } else {
            const jitter = (rnd() * 2 - 1) * S.dashTiming;
            pendingDash = { at: th.impactAt + flight - 0.14 + jitter, dir: { x: rnd() < 0.5 ? 1 : -1, z: 0 }, id };
          }
        }
      }
      const shielding = t >= shieldFrom && t <= shieldUntil;
      if (t > shieldUntil) shieldFrom = Infinity;
      const threatened = shielding || (pendingDash && pendingDash.at - t < 0.8);
      if (shielding) inp.shield = true;
      if (pendingDash && t >= pendingDash.at) {
        inp.dashDir = pendingDash.dir;
        inp.dash = pendingDash.dir.x >= 0 ? 1 : -1;
        pendingDash = null;
      }

      // — занятые руки: сфера / печать / ультимейт (опасность — бросает) —
      if (busy && threatened && busy.kind !== 'sigil') busy = null;
      if (busy && t >= busy.until) {
        if (busy.kind === 'conjure') inp.throw = { kind: 'orb', size: busy.size, power: U([0.4, 0.9]), aimX: 0 };
        else if (busy.kind === 'sigil') { inp.sigil = busy.sigil; inp.sigilPower = U([0.4, 0.9]); }
        else if (busy.kind === 'ult') { inp.ultimate = true; out.ults++; }
        busy = null;
      } else if (busy) {
        if (busy.kind === 'conjure') inp.conjure = { kind: 'orb', size: busy.size, charge: Math.min(1, (t - busy.from) / 1.2) };
      }
      if (!busy && !threatened) {
        if (p.furyReady) { if (ultAt === null) ultAt = t + U(S.ultDelay); } else ultAt = null;
        if (ultAt !== null && t >= ultAt) { busy = { kind: 'ult', until: t + 0.8 }; ultAt = null; }
        else if (t >= nextSigil && p.energy >= 40) {
          busy = { kind: 'sigil', until: t + 1.0, sigil: rnd() < 0.5 ? 'pillar' : 'gate' };
          nextSigil = t + U(S.sigilEvery);
        } else if (t >= nextThrow && p.energy >= 30 && v.cooldowns.throwRemaining <= 0) {
          busy = { kind: 'conjure', from: t, until: t + U(S.conjure), size: U([0.4, 0.9]) };
          nextThrow = t + U(S.throwEvery);
        }
      }
      // — выброс (кулак → ладонь): когда заметил готовность —
      if (v.cooldowns.burstRemaining <= 0 && p.energy >= 60) { if (burstAt === null) burstAt = t + U(S.burstDelay); }
      else burstAt = null;
      if (burstAt !== null && t >= burstAt && !busy && !shielding) {
        inp.burst = true; inp.burstPower = U(S.burstPower); burstAt = null;
      }
      // — «OK»: огонь урывками —
      if (t >= okUntil) { okOn = !okOn; okUntil = t + U(okOn ? S.okOn : S.okOff); }
      inp.attack = okOn && !busy && !shielding && rnd() >= S.flicker;
      cur = inp;
    } else {
      // между отсчётами распознавания: удержания те же, импульсы не повторяются
      cur = { ...cur, dash: 0, dashDir: undefined, burst: false, throw: undefined, sigil: undefined, ultimate: false };
    }
    c.update(DT, cur);
    for (const e of c.drainEvents()) {
      if (opts.onEvent) opts.onEvent(e);
      if (e.type === 'boss_windup' && out.attacks[e.data.attackKind] !== undefined) out.attacks[e.data.attackKind]++;
      else if (e.type === 'player_hit' && out.hits[e.data.attackKind] !== undefined) { out.hits[e.data.attackKind]++; out.taken += e.data.amount; }
      else if (e.type === 'block') out.blocks++;
      else if (e.type === 'dodge') out.dodges++;
      else if (e.type === 'boss_phase' && out.stage2At === null) out.stage2At = e.data && e.data.stage === 2 ? c.getSnapshot().time : null;
    }
  }
  const s = c.getSnapshot();
  out.status = s.status === 'playing' ? 'timeout' : s.status;
  out.t = s.time;
  out.hp = s.player.hp;
  out.bossHp = s.boss.hp;
  out.bossMaxHp = s.boss.maxHp;
  return out;
}

/** Сводка серии боёв: побед, поражений, медиана/квартили времени победы (с). */
export function summarize(results) {
  const wins = results.filter((r) => r.status === 'victory');
  const losses = results.filter((r) => r.status === 'defeat');
  const ts = wins.map((r) => r.t).sort((a, b) => a - b);
  const q = (k) => (ts.length ? ts[Math.min(ts.length - 1, Math.floor(k * ts.length))] : null);
  const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const lossT = losses.map((r) => r.t).sort((a, b) => a - b);
  return {
    n: results.length, wins: wins.length, losses: losses.length,
    timeouts: results.length - wins.length - losses.length,
    winRate: results.length ? wins.length / results.length : 0,
    median: r1(q(0.5)), p25: r1(q(0.25)), p75: r1(q(0.75)),
    lossMedian: lossT.length ? r1(lossT[lossT.length >> 1]) : null,
    hpLeft: wins.length ? Math.round(wins.reduce((a, r) => a + r.hp, 0) / wins.length) : null,
    bossLeftOnLoss: losses.length ? Math.round(100 * losses.reduce((a, r) => a + r.bossHp / r.bossMaxHp, 0) / losses.length) : null,
  };
}

export function runSeries({ level, skill = 'medium', seeds = 20, seed0 = 1, maxSec = 600, config, brainConfig } = {}) {
  const rs = [];
  for (let k = 0; k < seeds; k++) rs.push(runBotFight({ level, skill, seed: seed0 + k, maxSec, config, brainConfig }));
  return { results: rs, summary: summarize(rs) };
}
