/*
 * ASHEN OATH — core/cinemaFeed.js. [W3-КИНО]
 * События боя → экранные импульсы postfx (core/postfx.js: pulse). Без DOM и без three — проверяется в node
 * (dev/kino.test.mjs).
 *
 * export function createCinemaFeed({ pulse, now? }) -> { feed(events, snap), reset(), debug() }
 *   pulse(kind, strength, pos, opts) — postfx.pulse (или модульный pulse из core/postfx.js).
 *   feed — раз в кадр: события этого кадра и снимок боя. Мировые точки уходят в pulse как есть
 *   (postfx сам проецирует их камерой этого кадра).
 *   now() — запасные часы, с (когда в снимке нет time); по умолчанию performance.now.
 *
 * Отложенные импульсы идут по времени боя (snap.time): пауза и замедление их задерживают, новый бой
 * (время пошло назад) — сбрасывает очередь. Очередь — заранее созданные ячейки, в кадре ничего не создаётся.
 *
 *   player_hit            → 'hurt' по урону
 *   player_dash           → 'dash' от героя; perfect_dodge → сильный 'dash'
 *   boss_impact slam/nova → 'shockwave' в точке удара; burst → 'shockwave' по заряду
 *   sigil_cast 'gate'     («Врата бури»: волна по земле от героя к Регенту за data.eta с) → тёплая вспышка
 *                           и волна у ног, волны по пути, у цели — волна и тёплая вспышка (если data.reach);
 *                           sigil_miss 'gate' (волна не долетела) снимает остаток пути
 *   sigil_cast 'pillar'   («Столп небес»: удар сверху через data.delay с) → в момент удара бело-голубая
 *                           'flash' и 'shockwave' у Регента; если удар пришёл раньше таймера
 *                           (boss_hit / sigil_miss с data.sigil 'pillar') — сразу, один раз
 *   boss_hit (урон ≥ 45)  → 'punch' в точке попадания (кроме удара ультимейта — у него своё)
 *   ultimate_strike       → 'ultimate' (засветка + волна + рывок). ultimate_start / ultimate_end не трогаем:
 *                           чёрные полосы сцены «Небесного суда» рисует его HUD (core/battleHud.js), вторая
 *                           кинорамка была бы лишней. Его собственные pulse('flash'|'shockwave', {x, y}) в тот же
 *                           кадр сливаются с нашим: волны рядом объединяются, засветка не удваивается.
 */

export const CINE = {
  hurt: { base: 0.45, perDmg: 1 / 40, max: 0.55 },
  dash: { k: 0.6, lift: 1.2 }, perfectDodge: 1,
  impact: { slam: 0.75, nova: 1 },
  burst: { base: 0.5, perPower: 0.5 },
  bigHit: { min: 45, full: 120, k0: 0.35, k1: 0.75 },
  gate: {
    castFlash: 0.2, castColor: 0xff9a3a, castDur: 0.25, castWave: 0.4,
    path: [0.33, 0.66], pathWave: 0.42,
    hitWave: 0.6, hitWaveP: 0.4, hitFlash: 0.24, hitFlashP: 0.2, hitColor: 0xffb04a, hitDur: 0.3,
    groundLift: 0.25,
  },
  pillar: { delay: 0.45, flash: 0.55, flashP: 0.35, color: 0xd8ecff, dur: 0.32, wave: 0.9 },
  ultimate: 1,
  slots: 16,
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const unit = (v, d) => Math.min(1, Math.max(0, num(v, d)));
const isPt = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.z);

export function createCinemaFeed({ pulse, now } = {}) {
  const send = typeof pulse === 'function' ? pulse : () => false;
  const clockNow = typeof now === 'function' ? now : () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  // ячейка очереди: когда, что, где; group — номер заклинания (промах снимает остаток своего пути)
  const Q = [];
  for (let i = 0; i < CINE.slots; i++) {
    Q.push({ on: false, at: 0, kind: '', k: 0, tag: '', group: 0, final: false, pos: { x: 0, y: 0, z: 0 }, opts: { color: 0xffffff, dur: 0.24 }, hasOpts: false });
  }
  const st = { clock: 0, lastClock: -Infinity, group: 0, fired: 0, dropped: 0 };
  const _p = { x: 0, y: 0, z: 0 };
  const _o = { color: 0xffffff, dur: 0.24 };

  function fire(s) {
    s.on = false;
    st.fired++;
    try { send(s.kind, s.k, s.pos, s.hasOpts ? s.opts : undefined); } catch (e) { /* ignore */ }
  }
  function schedule(at, kind, k, p, tag, group, color, dur, final = false) {
    let s = null;
    for (let i = 0; i < Q.length; i++) if (!Q[i].on) { s = Q[i]; break; }
    if (!s) {   // всё занято: вытесняем самую раннюю (она и так вот-вот сработает)
      st.dropped++;
      s = Q[0];
      for (let i = 1; i < Q.length; i++) if (Q[i].at < s.at) s = Q[i];
      fire(s);
    }
    s.on = true; s.at = at; s.kind = kind; s.k = k; s.tag = tag; s.group = group; s.final = final;
    s.pos.x = p.x; s.pos.y = p.y; s.pos.z = p.z;
    s.hasOpts = color !== undefined;
    if (s.hasOpts) { s.opts.color = color; s.opts.dur = dur; }
  }
  // самая ранняя ещё не сыгранная группа с этим тегом (промах/попадание приходят по порядку заклинаний)
  function oldestGroup(tag) {
    let g = 0, at = Infinity;
    for (const s of Q) if (s.on && s.tag === tag && s.at < at) { at = s.at; g = s.group; }
    return g;
  }
  function cancelGroup(g) { for (const s of Q) if (s.on && s.group === g) s.on = false; }
  function fireGroup(g) { for (const s of Q) if (s.on && s.group === g) fire(s); }

  function pt(x, y, z) { _p.x = x; _p.y = y; _p.z = z; return _p; }
  function flash(k, color, dur, pos) {
    _o.color = color; _o.dur = dur;
    send('flash', k, pos || null, _o);
  }

  function gateCast(e, d, snap) {
    const G = CINE.gate;
    const from = isPt(d.from) ? d.from : e.position;
    const to = isPt(d.to) ? d.to : null;
    if (!isPt(from)) return;
    const pw = unit(d.power, 0.6);
    const gy = snap && snap.player && snap.player.position && Number.isFinite(snap.player.position.y)
      ? snap.player.position.y + G.groundLift : num(from.y, 1.4) - 1.2;
    flash(G.castFlash * (0.7 + 0.6 * pw), G.castColor, G.castDur, null);
    send('shockwave', G.castWave, pt(from.x, gy, from.z));
    if (!to) return;
    const eta = Math.max(0.05, num(d.eta, 0.6));
    const g = ++st.group;
    for (const f of G.path) {
      schedule(st.clock + eta * f, 'shockwave', G.pathWave * (0.8 + 0.4 * pw),
        pt(from.x + (to.x - from.x) * f, gy, from.z + (to.z - from.z) * f), 'gate', g);
    }
    if (d.reach === false) return;   // не долетит: только путь, а его остаток снимет sigil_miss
    const tp = pt(to.x, num(to.y, gy), to.z);
    schedule(st.clock + eta, 'shockwave', G.hitWave + G.hitWaveP * pw, tp, 'gate', g, undefined, undefined, true);
    schedule(st.clock + eta, 'flash', G.hitFlash + G.hitFlashP * pw, tp, 'gate', g, G.hitColor, G.hitDur, true);
  }
  function pillarCast(e, d) {
    const P = CINE.pillar;
    const to = isPt(d.to) ? d.to : e.position;
    if (!isPt(to)) return;
    const pw = unit(d.power, 0.6);
    const at = st.clock + Math.max(0, num(d.delay, P.delay));
    const g = ++st.group;
    const tp = pt(to.x, num(to.y, 2), to.z);
    schedule(at, 'flash', P.flash + P.flashP * pw, tp, 'pillar', g, P.color, P.dur, true);
    schedule(at, 'shockwave', P.wave, tp, 'pillar', g, undefined, undefined, true);
  }

  function onEvent(e, snap) {
    const d = e.data && typeof e.data === 'object' ? e.data : {};
    if (d.remote) return;   // [PVP] события соперника — не наш экран
    switch (e.type) {
      case 'player_hit': {
        const H = CINE.hurt;
        send('hurt', H.base + Math.min(H.max, num(d.amount, 10) * H.perDmg));
        break;
      }
      case 'perfect_dodge': send('dash', CINE.perfectDodge); break;
      case 'player_dash':
        if (isPt(e.position)) send('dash', CINE.dash.k, pt(e.position.x, num(e.position.y, 0) + CINE.dash.lift, e.position.z));
        break;
      case 'boss_impact': {
        const k = d.attackKind;
        if (!d.launch && (k === 'slam' || k === 'nova') && isPt(e.position)) send('shockwave', CINE.impact[k], e.position);
        break;
      }
      case 'burst':
        if (isPt(e.position)) send('shockwave', CINE.burst.base + CINE.burst.perPower * Math.min(1, num(d.power, 0.5)), e.position);
        break;
      case 'sigil_cast':
        if (d.sigil === 'gate') gateCast(e, d, snap);
        else if (d.sigil === 'pillar') pillarCast(e, d);
        break;
      case 'sigil_miss':
        if (d.sigil === 'gate') { const g = oldestGroup('gate'); if (g) cancelGroup(g); }
        else if (d.sigil === 'pillar') { const g = oldestGroup('pillar'); if (g) fireGroup(g); }
        break;
      case 'boss_hit': {
        if (d.sigil === 'pillar' || d.sigil === 'gate') {   // удар пришёл — сыграть его сейчас (раньше таймера)
          const g = oldestGroup(d.sigil);
          if (g) { for (const s of Q) if (s.on && s.group === g && (s.final || d.sigil === 'pillar')) fire(s); cancelGroup(g); }
        }
        const B = CINE.bigHit, a = num(d.amount, 0);
        if (a >= B.min && d.source !== 'ultimate' && !d.ultimate && !d.dot && isPt(e.position)) {
          send('punch', B.k0 + (B.k1 - B.k0) * Math.min(1, (a - B.min) / (B.full - B.min)), e.position);
        }
        break;
      }
      case 'ultimate_strike': send('ultimate', CINE.ultimate, isPt(e.position) ? e.position : null); break;
      default: break;
    }
  }

  function feed(events, snap) {
    const t = snap && Number.isFinite(snap.time) ? snap.time : clockNow();
    if (t < st.lastClock - 0.25) reset();   // новый бой: время пошло заново
    st.clock = t; st.lastClock = t;
    if (Array.isArray(events)) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (!e || typeof e.type !== 'string') continue;
        try { onEvent(e, snap); } catch (err) { /* событие с мусором не роняет кадр */ }
      }
    }
    for (let i = 0; i < Q.length; i++) if (Q[i].on && Q[i].at <= st.clock) fire(Q[i]);
  }
  function reset() {
    for (const s of Q) s.on = false;
    st.lastClock = -Infinity;
  }
  function debug() {
    let pending = 0;
    for (const s of Q) if (s.on) pending++;
    return { pending, fired: st.fired, dropped: st.dropped, clock: st.clock, groups: st.group };
  }
  return { feed, reset, debug };
}
