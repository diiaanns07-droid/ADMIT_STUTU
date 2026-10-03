// ASHEN OATH — modules/fx/runesWild.js. Владелец: №7 [VFX].
// @ СПИРА — смерч вокруг героя (ветер, пепел, листья, обломки), ^ АКУС — волна ледяных кристаллов
// из земли до цели + ледяные иглы-снаряды, V МЕССИС — призрачный серп-полумесяц и фиолетовые души.
// Ритм как у runesFire.js: накопление → выпуск → полёт → удар → послесвечение, символ в круге под героем.
// [W4-ЗАКЛИНАНИЯ] руна в воздухе (fx.shared.runeAir от handMagic) «становится» заклинанием: СПИРА — знак втягивается
//   в героя, изумрудный порыв — в момент выпуска; АКУС — знак уходит в землю перед героем, оттуда волна кристаллов,
//   финальный взрыв — по факту удара игл (projectile_impact caret:*); иглы — снаряды: белое ядро + морозный ореол +
//   лента с головой, свет у средней иглы; МЕССИС — из знака к серпу летит тёмная комета (чёрное ядро, фиолетовый
//   ободок), у лезвия и душ — чёрная сердцевина, шаги лезвия — по длине дуги (на 120 Гц частиц не вдвое больше).
//   Без руны в воздухе — прежний ритм от ладони. Знак и сбор искр у ладони убраны (их заменил предвестник castFx).
//   Фон из fx.every (смерч) при толчее эффектов редеет по kit.scopeShare(null); иглы — в сцене своего каста.

import { caster, runeCircle, muzzle, fly, afterglow, decal, trail, rampOf, clamp, TAU, isNum, hasVec, createComet } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const UP = { x: 0, y: 1, z: 0 };
  const D_LOCAL = { remote: false }, D_REMOTE = { remote: true };
  const au = (n, p) => { if (fx.legacy && typeof fx.legacy.audio === 'function') { try { fx.legacy.audio(n, p); } catch (e) { /* ignore */ } } };

  // [W4-ЗАКЛИНАНИЯ] руна в воздухе этого же каста (контракт handMagic → модули рун) или null — прежний ритм от ладони
  function takeAir(rune, R) {
    const a = fx.shared ? fx.shared.runeAir : null;
    return a && a.rune === rune && a.t0 === kit.clock && a.remote === R && typeof a.plan === 'function' && hasVec(a.pos) ? a : null;
  }
  const launchIn = (air, max) => clamp(isNum(air.launchAt) ? air.launchAt - kit.clock : 0.22, 0, max);

  // ============================================================ @ СПИРА
  fx.suppress('vortex');
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('wind', d), ramp = rampOf('wind', R);
    const rad = clamp(typeof d.radius === 'number' ? d.radius : 7, 2, 12);
    runeCircle(fx, c, 'spira', 'wind', { radius: 1.9, dur: 2.2, spin: 2.6, rings: 3 });
    // [W4-ЗАКЛИНАНИЯ] знак в воздухе втягивается в героя, порыв — в момент выпуска (без руны в воздухе — через 0.16 с)
    const air = takeAir('spira', R);
    let tL = 0.16;
    if (air) { air.plan('absorb', c.chest); tL = launchIn(air, 0.28); }
    const g = { x: c.feet.x, y: c.feet.y + 0.08, z: c.feet.z };
    kit.after(tL, () => {
      // выпуск: закрученный порыв по кругу наружу
      kit.emit({ at: g, shape: 'ring', radius: 0.6, count: 60, radial: rad * 0.9, tangent: 7, speed: [0, 0.3], dir: UP, cone: 0.3, life: [0.35, 0.6], size: [0.12, 0.03], ramp, intensity: 2.2, sprite: 'streak', stretch: 0.05, drag: 2.4, rival: R, essential: true });
      kit.emit({ at: g, shape: 'ring', radius: 0.8, count: 30, radial: rad * 0.7, tangent: 4, speed: [0.5, 1.5], dir: UP, cone: 0.5, life: [0.7, 1.2], size: [0.5, 1.4], ramp: 'dust', alpha: 0.6, sprite: 'smoke', blend: 'alpha', drag: 2.2, gravity: -0.3, turb: 0.5, spin: [-1.5, 1.5], rival: R });
      // изумрудные листья спиралью вверх — «ветер» читается и без смерча
      kit.emit({ at: g, shape: 'ring', radius: 0.7, count: 10, radial: rad * 0.45, tangent: 5, speed: [1, 2.4], dir: UP, cone: 0.35, life: [0.6, 1.0], size: [0.17, 0.13], ramp, intensity: 2.2, sprite: 'leaf', spin: [-8, 8], drag: 2, gravity: -0.6, rival: R });
      if (fx.shock) { try { fx.shock.ring({ pos: g, r0: 0.5, r1: rad * 0.8, dur: 0.5, color: P.mid, hot: P.core, intensity: 1.5, thickness: 0.14, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ } }
      kit.light(c.chest, { color: P.hot, intensity: 0.9, range: 8, dur: 0.5, attack: 0.1 });
      kit.shake(0.14); kit.kick(UP, 0.012);
    });
    au('nova', c.feet);
    return true;
  }, (d) => d.rune === 'spira');

  // смерч, пока действует вихрь (снимок: player.vortex / vortexRemaining)
  const tw = { acc: 0, ash: 0, leaf: 0, deb: 0, t: 0, on: 0 };
  const _f = new V3();
  const oWind = { at: new V3(), count: 1, speed: [0.6, 1.3], dir: UP, cone: 0.15, life: [0.5, 0.8], size: [0.12, 0.06], ramp: 'wind', intensity: 2.3, sprite: 'streak', stretch: 0.06, orbit: 6.5, center: new V3(), rgrow: 0.08, essential: true, rival: false };
  const oAsh = { at: new V3(), count: 1, speed: [0.8, 1.6], dir: UP, cone: 0.4, life: [0.8, 1.3], size: [0.25, 0.6], ramp: 'ash', alpha: 0.7, sprite: 'smoke', blend: 'alpha', orbit: 4.2, center: new V3(), rgrow: 0.2, turb: 0.3, spin: [-2, 2], essential: true, rival: false };
  const oLeaf = { at: new V3(), count: 1, speed: [1, 2.2], dir: UP, cone: 0.5, life: [0.9, 1.4], size: [0.13, 0.11], ramp: 'leaf', sprite: 'leaf', blend: 'alpha', orbit: 4.8, center: new V3(), rgrow: 0.22, spin: [-7, 7], turb: 0.4, essential: true, rival: false };
  const oDeb = { at: new V3(), count: 1, speed: [1.5, 2.8], dir: UP, cone: 0.3, life: [0.7, 1.1], size: [0.1, 0.08], ramp: 'stone', sprite: 'debris', blend: 'alpha', orbit: 5.2, center: new V3(), rgrow: 0.18, spin: [-8, 8], essential: true, rival: false };
  function funnelPoint(o, h, r0) {
    const a = Math.random() * TAU, r = r0 + 0.3 * h + 0.06 * h * h;
    o.at.set(_f.x + Math.cos(a) * r, _f.y + 0.05 + h, _f.z + Math.sin(a) * r);
    o.center.copy(_f);
  }
  if (typeof fx.onClear === 'function') fx.onClear(() => { tw.on = 0; tw.acc = tw.ash = tw.leaf = tw.deb = 0; });
  fx.every((dt, snap) => {
    const pl = snap && snap.player;
    const on = !!(pl && pl.vortex && snap.status !== 'defeat');
    tw.on += ((on ? 1 : 0) - tw.on) * (1 - Math.exp(-dt * (on ? 8 : 4)));
    if (tw.on < 0.03 || dt <= 0) { tw.acc = tw.ash = tw.leaf = tw.deb = 0; return; }
    fx.anchor('feet', _f, false);
    // [W4-ЗАКЛИНАНИЯ] фон: при толчее эффектов (3+ сцены) смерч редеет — свежие заклинания читаются
    const k = tw.on * (fx.Q.name === 'low' ? 0.5 : 1) * kit.scopeShare(null);
    tw.acc += dt * 130 * k; tw.ash += dt * 12 * k; tw.leaf += dt * 10 * k; tw.deb += dt * 5 * k;
    while (tw.acc >= 1) { tw.acc -= 1; funnelPoint(oWind, Math.pow(Math.random(), 0.8) * 3.0, 0.3); kit.emit(oWind); }
    while (tw.ash >= 1) { tw.ash -= 1; funnelPoint(oAsh, Math.random() * 2.2, 0.55); kit.emit(oAsh); }
    while (tw.leaf >= 1) { tw.leaf -= 1; funnelPoint(oLeaf, Math.random() * 2.6, 0.6); kit.emit(oLeaf); }
    while (tw.deb >= 1) { tw.deb -= 1; funnelPoint(oDeb, Math.random() * 1.2, 0.5); kit.emit(oDeb); }
  });

  // ============================================================ ^ АКУС
  fx.suppress('proj:caret');
  const _p = new V3(), _q = new V3(), _s = new V3();
  // [W4-ЗАКЛИНАНИЯ] последний каст по сторонам: волна бежит к цели и ждёт удар игл, иглы берут его сцену
  const CAR = { L: null, R: null };
  const eShard = { at: _s, count: 1, dir: UP, cone: 0.1, speed: [0.3, 0.8], drag: 6, life: [0.55, 0.85], size: [0.9, 0.75], ramp: 'frost', intensity: 2.6, sprite: 'shard', rot: 0, fadeIn: 0.02, curve: 3, rival: false, essential: true };
  const eWSpark = { at: _p, count: 7, dir: UP, cone: 0.6, speed: [1.2, 3.2], life: [0.3, 0.6], size: [0.05, 0.01], ramp: 'frost', intensity: 2.8, sprite: 'spark', stretch: 0.02, gravity: 3, drag: 1.5, rival: false };
  const eWSmoke = { at: _p, count: 3, radius: 0.3, speed: [0.2, 0.6], life: [0.8, 1.3], size: [0.4, 0.9], ramp: 'frostsmoke', alpha: 0.6, sprite: 'smoke', blend: 'alpha', drag: 1.5, gravity: -0.2, rival: false };
  const DECAL6 = { life: 6 };
  /** Шаг волны i из N: кристаллы пробивают землю на отрезке a → b. */
  function waveStep(W, i) {
    const u = i / W.N, big = 0.5 + 0.7 * u;
    const side = (Math.random() - 0.5) * 0.5;
    _p.set(W.a.x + (W.b.x - W.a.x) * u + W.rx * side, 0, W.a.z + (W.b.z - W.a.z) * u + W.rz * side);
    _p.y = fx.groundY(_p.x, _p.z, W.a.y + (W.b.y - W.a.y) * u) + 0.02;
    eShard.ramp = W.ramp; eShard.rival = W.R; eShard.size[0] = 0.9 * big; eShard.size[1] = 0.75 * big;
    for (let s = 0; s < 3; s++) {
      _s.set(_p.x + (Math.random() - 0.5) * 0.35, _p.y + 0.15 * big, _p.z + (Math.random() - 0.5) * 0.35);
      eShard.rot = (Math.random() - 0.5) * 0.7;
      kit.emit(eShard);
    }
    eWSpark.ramp = W.ramp; eWSpark.rival = W.R; kit.emit(eWSpark);
    eWSmoke.rival = W.R; kit.emit(eWSmoke);
    if (i % 4 === 2) decal(fx, _p, 'frost', 0.9 + 0.5 * u, 'frost', W.R, DECAL6);
  }
  /** Финальный ледяной взрыв у цели (один раз на каст). */
  function caretBurst(W) {
    if (W.burst) return;
    W.burst = true;
    const P = W.P, R = W.R, ramp = W.ramp, b = W.b, tg = W.tgt;
    kit.flash(tg, { color: P.core, size: [0.4, 2.4], dur: 0.2, intensity: 4.5, sprite: 'star', pull: 0.7, rival: R });
    kit.flash(tg, { color: P.mid, size: [0.8, 3], dur: 0.4, intensity: 1.8, sprite: 'glow', pull: 0.7, rival: R });
    kit.emit({ at: { x: b.x, y: b.y + 0.3, z: b.z }, count: 14, dir: UP, cone: 0.9, speed: [1, 2.5], drag: 5, life: [0.6, 0.9], size: [0.9, 0.7], ramp, intensity: 2.2, sprite: 'shard', rot: 0, rival: R, essential: true });
    kit.emit({ at: tg, count: 40, speed: [3, 9], life: [0.4, 0.9], size: [0.07, 0.015], ramp, intensity: 3, sprite: 'flake', spin: [-6, 6], gravity: 4, drag: 1.2, ground: b.y + 0.03, rival: R, essential: true });
    decal(fx, b, 'frost', 2.2, 'frost', R, { life: 7 });
    if (fx.shock) { try { fx.shock.ring({ pos: { x: b.x, y: b.y + 0.05, z: b.z }, r0: 0.3, r1: 3.6, dur: 0.45, color: P.mid, hot: P.core, intensity: 1.8, thickness: 0.14, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ } }
    kit.light(tg, { color: P.hot, intensity: 1.6, range: 12, dur: 0.5, attack: 0.03 });
    kit.shake(0.22); kit.hitstop(35);
    au('orbImpact', tg);
  }
  /** Кадр волны: фронт бежит к цели; удар игл ускоряет его (≤ 0.07 с до цели); взрыв — по удару (или через 0.2 с). */
  function waveTick(W, dt) {
    if (W.hitT >= 0 && !W.boost) { W.boost = true; W.rate = Math.max(W.rate, (1 - W.u) / 0.07); }
    W.u += dt * W.rate;
    while (W.i <= W.N && W.i <= W.u * W.N + 1e-6) { waveStep(W, W.i); W.i++; }
    if (W.i <= W.N) return true;
    W.wait += dt;
    if (W.hitT >= 0 || W.wait >= 0.2) { caretBurst(W); return false; }
    return true;
  }
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('frost', d), ramp = rampOf('frost', R);
    runeCircle(fx, c, 'caret', 'frost', { radius: 1.8, dur: 1.7, spin: -0.8 });
    // [W4-ЗАКЛИНАНИЯ] знак в воздухе уходит в землю перед героем — оттуда в момент выпуска бежит волна кристаллов
    const air = takeAir('caret', R);
    const a = new V3(c.feet.x + c.fwd.x * 0.9, c.feet.y, c.feet.z + c.fwd.z * 0.9);
    let tW = 0.1;
    if (air) {
      a.set(air.pos.x + c.fwd.x * 0.3, 0, air.pos.z + c.fwd.z * 0.3);
      a.y = fx.groundY(a.x, a.z, c.feet.y);
      air.plan('through', a);
      tW = launchIn(air, 0.22);           // сдвиг от прежних 0.1 с — не больше 0.12 с
    } else kit.after(0.12, () => muzzle(fx, c.hand, c.dir, 'frost', R, { size: 0.9, count: 18 }));
    const b = new V3().copy(c.targetGround);
    const L = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
    const N = clamp(Math.round(L / 0.55), 6, 16);
    // удар игл ожидается через dist / 37 с (combat: 38 м/с из груди) — фронт волны приходит к нему
    const tH = Math.hypot(c.target.x - c.chest.x, c.target.y - c.chest.y, c.target.z - c.chest.z) / 37;
    const wd = clamp(tH - tW, 0.14, 0.42);
    const W = { t0: kit.clock, R, P, ramp, a, b, tgt: new V3().copy(c.target), rx: c.right.x, rz: c.right.z, N, u: 0, i: 0, rate: 1 / wd, hitT: -1, boost: false, wait: 0, burst: false, scope: kit.currentScope };
    CAR[R ? 'R' : 'L'] = W;
    kit.after(tW, () => {
      const act = kit.actor({ dur: 1.5, update(t, k, dt) { return waveTick(W, dt); }, end() { caretBurst(W); } });
      if (!act) { while (W.i <= W.N) { waveStep(W, W.i); W.i++; } caretBurst(W); }   // пул акторов полон — сразу
    });
    au('cast', c.hand);
    return true;
  }, (d) => d.rune === 'caret');

  // ледяные иглы в полёте (снаряды 'caret:*' из snap.projectiles)
  // [W4-ЗАКЛИНАНИЯ] игла — снаряд: белое ядро + морозный ореол (летят вместе с иглой, скорость на GPU), росчерк,
  // снежинки, лента с головой; короткий свет у средней иглы залпа. Выбросы по времени (не по кадрам), в сцене каста.
  // Записи — из пула, обход массива без итераторов Map: в кадре ничего не создаётся.
  const needles = new Map(); // id → rec
  const nLive = [], nPool = [], fresh = [null, null, null, null, null, null, null, null];
  let tag = 0, nFresh = 0, lastLight = -9;
  const oHalo = { at: null, vel: null, count: 1, speed: 0, life: 0.065, size: [0.36, 0.26], sizeVar: 0.08, color: 0x7fd8ff, intensity: 1.9, sprite: 'glow', fadeIn: 0.02, essential: true, rival: false };
  const oCore = { at: null, vel: null, count: 1, speed: 0, life: 0.05, size: [0.17, 0.12], sizeVar: 0, ramp: 'whiteHold', intensity: 3, sprite: 'glow', fadeIn: 0.01, essential: true, rival: false };
  const oNeedle = { at: null, vel: null, count: 1, speed: 0, life: [0.04, 0.06], size: [0.17, 0.12], ramp: 'frost', intensity: 3, sprite: 'streak', stretch: 0.03, essential: true, rival: false };
  const oFlake = { at: null, count: 1, radius: 0.1, speed: [0.2, 0.8], life: [0.3, 0.55], size: [0.075, 0.025], ramp: 'frost', intensity: 2.6, sprite: 'flake', spin: [-5, 5], gravity: 1, drag: 2, rival: false };
  const kNeedle = { color: 0xc8f4ff, intensity: 0.6, range: 7, dur: 0.4, attack: 0.1, follow: null };
  const TR_NEEDLE = { style: 'energy', width: 0.14, life: 0.2, intensity: 2.6, maxPoints: 18, head: 1.2 };
  function needleRec() {
    const n = nPool.pop() || { id: '', tr: null, seen: 0, R: false, hc: 0, pos: new V3(), vel: new V3(), acc: 0, accS: 0, accF: 0, scope: null, follow: null, ls: null };
    if (!n.follow) n.follow = () => n.pos;
    return n;
  }
  function needleFx(n, dt) {
    const prev = kit.enterScope(n.scope);
    if (n.scope) kit.touchScope(n.scope, 0.2);
    const R = n.R, ramp = R ? 'rival' : 'frost';
    const lo = !!(kit.Q && kit.Q.name === 'low');   // low: голова вдвое реже и без отдельного белого ядра
    n.acc += dt * (lo ? 30 : 60);
    if (n.acc >= 1) {
      n.acc = Math.min(1, n.acc - 1);
      oHalo.at = n.pos; oHalo.vel = n.vel; oHalo.color = n.hc; oHalo.rival = R; kit.emit(oHalo);
      if (!lo) { oCore.at = n.pos; oCore.vel = n.vel; oCore.rival = R; kit.emit(oCore); }
    }
    n.accS += dt * 30;
    if (n.accS >= 1) { n.accS = Math.min(1, n.accS - 1); oNeedle.at = n.pos; oNeedle.vel = n.vel; oNeedle.ramp = ramp; oNeedle.rival = R; kit.emit(oNeedle); }
    n.accF += dt * 24;
    if (n.accF >= 1) { n.accF = Math.min(1, n.accF - 1); oFlake.at = n.pos; oFlake.ramp = ramp; oFlake.rival = R; kit.emit(oFlake); }
    oHalo.at = oCore.at = oNeedle.at = oFlake.at = null; oHalo.vel = oCore.vel = oNeedle.vel = null;
    kit.enterScope(prev);
  }
  if (typeof fx.onClear === 'function') fx.onClear(() => {
    for (let i = 0; i < nLive.length; i++) { const n = nLive[i]; if (n.ls && n.ls.follow === n.follow) n.ls.follow = null; n.tr = null; n.scope = null; n.ls = null; if (nPool.length < 16) nPool.push(n); }
    nLive.length = 0; needles.clear(); CAR.L = CAR.R = null;
  });
  fx.every((dt, snap) => {
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : null;
    tag++; nFresh = 0;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const pr = list[i];
        if (!pr || pr.id === undefined || pr.id === null || !pr.position) continue;
        const id = String(pr.id);
        if (!id.startsWith('caret:')) continue;
        const R = !!pr.remote;
        let n = needles.get(id);
        if (!n) {
          n = needleRec(); n.id = id; n.R = R; n.hc = fx.pal('frost', R ? D_REMOTE : D_LOCAL).mid; n.acc = 1; n.accS = 1; n.accF = 0;
          n.tr = trail(fx, 'frost', R, TR_NEEDLE);
          const W = CAR[R ? 'R' : 'L'];
          n.scope = W && kit.clock - W.t0 < 1.2 ? W.scope : null;
          needles.set(id, n); nLive.push(n);
          if (nFresh < fresh.length) fresh[nFresh++] = n;
        }
        n.seen = tag;
        const p = pr.position, v = pr.velocity;
        n.pos.set(p.x, p.y, p.z);
        if (v && isNum(v.x)) n.vel.set(v.x, v.y, v.z); else n.vel.set(0, 0, -30);
        if (n.tr) { try { n.tr.push(p); } catch (e) { /* ignore */ } }
        if (dt > 0) needleFx(n, dt);
      }
    }
    // средняя игла залпа несёт короткий свет (пул kit; на low — нет)
    if (nFresh > 0 && kit.clock - lastLight > 0.5) {
      const n = fresh[nFresh >> 1];
      lastLight = kit.clock;
      kNeedle.color = fx.pal('frost', n.R ? D_REMOTE : D_LOCAL).hot; kNeedle.follow = n.follow;
      n.ls = kit.light(n.pos, kNeedle);
      kNeedle.follow = null;
    }
    for (let i = 0; i < nFresh; i++) fresh[i] = null;
    // ушедшие иглы: лента гаснет, запись — в пул
    for (let i = nLive.length - 1; i >= 0; i--) {
      const n = nLive[i];
      if (n.seen === tag) continue;
      if (n.tr) { try { n.tr.stop(); } catch (e) { /* ignore */ } }
      // свет пула ещё догорает — отцепляем от записи (она вернётся в пул и полетит с другой иглой)
      if (n.ls && n.ls.follow === n.follow) n.ls.follow = null;
      n.tr = null; n.scope = null; n.ls = null;
      needles.delete(n.id);
      nLive[i] = nLive[nLive.length - 1]; nLive.pop();
      if (nPool.length < 16) nPool.push(n);
    }
  });
  fx.on('projectile_impact', (ev, d) => {
    const R = fx.isRemote(d), P = fx.pal('frost', d), ramp = rampOf('frost', R);
    // [W4-ЗАКЛИНАНИЯ] удар иглы — сигнал волне: финальный взрыв у цели по факту попадания, а не по таймеру
    const W = CAR[R ? 'R' : 'L'];
    if (W && !W.burst && W.hitT < 0 && kit.clock - W.t0 < 1.5) W.hitT = kit.clock;
    const p = fx.evPos(ev, _q);
    if (!p) return true;
    kit.flash(p, { color: P.core, size: [0.25, 1.4], dur: 0.14, intensity: 4, sprite: 'star', pull: 0.5, rival: R });
    kit.emit({ at: p, count: 10, speed: [2, 5], life: [0.3, 0.6], size: [0.34, 0.2], ramp, intensity: 2.4, sprite: 'shard', spin: [-8, 8], gravity: 6, drag: 1.2, rival: R, essential: true });
    kit.emit({ at: p, count: 16, speed: [1, 4], life: [0.3, 0.7], size: [0.07, 0.02], ramp, intensity: 2.8, sprite: 'flake', spin: [-5, 5], gravity: 2, drag: 1.5, rival: R });
    kit.hitstop(12);
    return true;
  }, (d) => d && d.projectileId !== undefined && d.projectileId !== null && String(d.projectileId).startsWith('caret:'));

  // ============================================================ V МЕССИС
  // Призрачный серп-полумесяц рассекает воздух у цели, из цели к заклинателю летят фиолетовые души.
  // [W4-ЗАКЛИНАНИЯ] тьма — фиолетовая с чёрным ядром: тёмная комета из знака к началу лезвия, лента лезвия 'dark',
  // чёрная сердцевина (darkcore, alpha — после фиолетового) у лезвия, во всплеске и в каждой душе.
  const veeComet = createComet(fx);
  const kVee = { size: 0.3, remote: false, dur: 0.08, look: 'void', trailWidth: 0.45, trailLife: 0.22, lightK: 1 };
  const BLADE_STEP = 0.2;               // м дуги на шаг лезвия
  const _vp = new V3();
  const easeS = (x) => x * x * (3 - 2 * x);
  // души: голова (фиолетовый ореол → чёрная сердцевина → светлый ободок) летит с душой (скорость на GPU), тело-перо,
  // росчерк по направлению, искры; выбросы по времени — частиц столько же на 30/60/120 Гц
  const sHalo = { at: null, vel: null, count: 1, speed: 0, life: 0.085, size: [0.55, 0.42], sizeVar: 0.05, color: 0x8c3cf4, intensity: 2.2, sprite: 'glow', fadeIn: 0.02, essential: true, rival: false };
  const sDark = { at: null, vel: null, count: 1, speed: 0, life: 0.085, size: [0.22, 0.17], sizeVar: 0.05, ramp: 'darkcore', intensity: 1, sprite: 'dot', blend: 'alpha', fadeIn: 0.02, essential: true, rival: false };
  const sRim = { at: null, vel: null, count: 1, speed: 0, life: 0.085, size: [0.3, 0.24], sizeVar: 0.05, ramp: 'void', intensity: 2.6, sprite: 'ring', fadeIn: 0.02, essential: true, rival: false };
  const sWisp = { at: null, count: 1, speed: [0.1, 0.4], life: [0.28, 0.42], size: [0.42, 0.13], ramp: 'void', intensity: 2.4, sprite: 'wisp', rot: 0, drag: 2, rival: false, essential: true };
  const sStreak = { at: null, vel: null, count: 1, speed: 0, life: [0.08, 0.12], size: [0.22, 0.12], ramp: 'void', intensity: 2.6, sprite: 'streak', stretch: 0.03, essential: true, rival: false };
  const sSpark = { at: null, count: 1, radius: 0.1, speed: [0.2, 0.7], life: [0.3, 0.6], size: [0.06, 0.012], ramp: 'void', intensity: 2.8, sprite: 'spark', drag: 1.5, rival: false };
  const TR_SOUL = { style: 'ghost', width: 0.3, life: 0.3, intensity: 2, maxPoints: 20, minDist: 0.08 };
  function soulStep(S, pos, dt) {
    if (!(dt > 0)) return;
    if (S.first) { S.first = false; S.prev.copy(pos); }
    S.vel.subVectors(pos, S.prev).multiplyScalar(1 / dt);
    S.prev.copy(pos);
    if (S.tr) S.tr.push(pos);
    const R = S.R, ramp = R ? 'rival' : 'void';
    S.aH += dt * 26;
    if (S.aH >= 1) {
      S.aH = Math.min(1, S.aH - 1);
      sHalo.at = pos; sHalo.vel = S.vel; sHalo.color = S.hc; sHalo.rival = R; kit.emit(sHalo);
      if (!R) { sDark.at = pos; sDark.vel = S.vel; kit.emit(sDark); }
      sRim.at = pos; sRim.vel = S.vel; sRim.ramp = ramp; sRim.rival = R; kit.emit(sRim);
    }
    S.aW += dt * 22 * S.q;
    if (S.aW >= 1) { S.aW = Math.min(1, S.aW - 1); sWisp.at = pos; sWisp.ramp = ramp; sWisp.rival = R; kit.emit(sWisp); }
    S.aS += dt * 12 * S.q;
    if (S.aS >= 1) { S.aS = Math.min(1, S.aS - 1); sStreak.at = pos; sStreak.vel = S.vel; sStreak.ramp = ramp; sStreak.rival = R; kit.emit(sStreak); }
    S.aP += dt * 7;
    if (S.aP >= 1) { S.aP = Math.min(1, S.aP - 1); sSpark.at = pos; sSpark.ramp = ramp; sSpark.rival = R; kit.emit(sSpark); }
    sHalo.at = sDark.at = sRim.at = sWisp.at = sStreak.at = sSpark.at = null; sHalo.vel = sDark.vel = sRim.vel = sStreak.vel = null;
  }
  if (typeof fx.onClear === 'function') fx.onClear(() => veeComet.clear());
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('void', d), ramp = rampOf('void', R);
    const dark = !R;    // у соперника — его фиолетовая палитра без чёрного ядра (как у кометы)
    // в данных «жатвы» from = цель, to = заклинатель: цель берём из from
    const tgt = new V3();
    if (d.from && typeof d.from.x === 'number' && Math.hypot(d.from.x - c.chest.x, d.from.z - c.chest.z) > 0.8) tgt.set(d.from.x, d.from.y, d.from.z);
    else tgt.copy(c.target);
    const tg = new V3(tgt.x, fx.groundY(tgt.x, tgt.z, tgt.y - (R ? 1.25 : 2.6)), tgt.z);
    runeCircle(fx, c, 'vee', 'void', { radius: 1.8, dur: 1.9, spin: -1.2, motes: 18 });
    // плоскость серпа: поперёк линии заклинатель → цель
    const rx = c.right.x, rz = c.right.z;
    const Rb = R ? 1.4 : 2.1;
    const ctr = new V3(tgt.x - c.fwd.x * 0.6, tgt.y + 0.15, tgt.z - c.fwd.z * 0.6);
    const tip = new V3(), tan = new V3();
    const blade = { at: tip, dir: tan, cone: 0.05, count: 2, speed: [9, 12], life: [0.14, 0.24], size: [0.29, 0.1], ramp, intensity: 3, sprite: 'streak', stretch: 0.035, drag: 5, rival: R, essential: true };
    const bladeDark = { at: tip, dir: tan, cone: 0.05, count: 1, speed: [8, 11], life: [0.16, 0.26], size: [0.34, 0.2], ramp: 'darkcore', intensity: 1, sprite: 'glow', blend: 'alpha', drag: 5, rival: R, essential: true };
    const bladeCore = { at: tip, dir: tan, cone: 0.02, count: 1, speed: [10, 12], life: [0.08, 0.12], size: [0.16, 0.06], ramp, intensity: 3, sprite: 'streak', stretch: 0.03, drag: 5, rival: R, essential: true };
    const mist = { at: tip, count: 1, radius: 0.15, speed: [0.2, 0.6], life: [0.5, 0.9], size: [0.4, 0.9], ramp: 'voidsmoke', alpha: 0.7, sprite: 'smoke', blend: 'alpha', drag: 1.5, turb: 0.4, rival: R };
    const tr = trail(fx, 'void', R, { style: dark ? 'dark' : 'ghost', width: 0.7, life: 0.35, intensity: 2.2, maxPoints: 28, minDist: 0.04, head: 0.6 });
    const A0 = 2.55, A1 = -0.75; // сверху-слева вниз-вправо
    const pt = (out, a, rr) => out.set(ctr.x + rx * Math.cos(a) * rr, ctr.y + Math.sin(a) * rr * 0.85, ctr.z + rz * Math.cos(a) * rr);
    // [W4-ЗАКЛИНАНИЯ] откуда: тёмная комета из знака в воздухе (без руны в воздухе — из ладони) к началу лезвия,
    // лезвие стартует там, где она погасла. Без руны в воздухе взмах — в прежние 0.14 с.
    const tip0 = pt(new V3(), A0, Rb);
    const air = takeAir('vee', R);
    const from = new V3().copy(c.hand);
    let tLa = 0;
    if (air) { air.plan('through', ctr); from.copy(air.pos); tLa = launchIn(air, 0.26); }
    const tf = clamp(from.distanceTo(tip0) / 140, 0.04, 0.08);
    if (!air) tLa = Math.max(0, 0.14 - tf);
    else tLa = Math.min(tLa, 0.26 - tf);   // взмах не позже прежнего +0.12 с при любой дальности
    kit.after(tLa, () => {
      kVee.remote = R; kVee.dur = tf;
      const cm = veeComet.start(from, 'void', kVee);
      if (!cm) return;
      const act = kit.actor({ dur: tf, update(t, k, dt) { _vp.lerpVectors(from, tip0, Math.min(1, t / tf)); cm.step(_vp, null, dt); }, end() { cm.end(tip0); } });
      if (!act) cm.end(tip0);
    });
    let prevA = A0;
    kit.after(tLa + tf, () => {
      kit.flash(ctr, { color: P.hot, size: [0.5, 2.4], dur: 0.3, intensity: 1.6, sprite: 'glow', pull: 0.5, rival: R });
      kit.actor({
        dur: air ? 0.15 : 0.17,           // с руной в воздухе взмах чуть короче — удар не запаздывает
        update(t, k) {
          const a = A0 + (A1 - A0) * (1 - Math.pow(1 - k, 2));
          // заполняем дугу между прошлым и текущим углом — лезвие не рвётся на низком fps;
          // [W4-ЗАКЛИНАНИЯ] шагов — по длине дуги за кадр (1..6): на 120 Гц частиц не вдвое больше
          const steps = clamp(Math.ceil(Math.abs(a - prevA) * Rb / BLADE_STEP), 1, 6);
          for (let s = 1; s <= steps; s++) {
            const aa = prevA + (a - prevA) * (s / steps);
            tan.set(rx * Math.sin(aa), -Math.cos(aa) * 0.85, rz * Math.sin(aa));
            // полумесяц: фиолетовое лезвие снаружи → чёрная сердцевина (после фиолетового) → светлая кромка внутри
            pt(tip, aa, Rb); kit.emit(blade);
            if (dark) { pt(tip, aa, Rb * 0.93); kit.emit(bladeDark); }
            pt(tip, aa, Rb * 0.85); kit.emit(bladeCore);
          }
          pt(tip, a, Rb * 0.93);
          if (tr) tr.push(tip);
          if (Math.random() < 0.5) kit.emit(mist);
          prevA = a;
        },
        end() {
          if (tr) tr.stop();
          // рассечённый воздух: всплеск тьмы у цели — фиолетовый ореол, чёрное ядро, светлый ободок, искра удара
          kit.flash(tgt, { color: P.mid, size: [0.8, 3.0], dur: 0.45, intensity: 1.8, sprite: 'glow', pull: 0.7, rival: R });
          if (dark) kit.emit({ at: tgt, count: 2, speed: [0, 0.1], life: [0.3, 0.4], size: [1.15, 0.5], sizeVar: 0.1, ramp: 'darkcore', intensity: 1, sprite: 'glow', blend: 'alpha', fadeIn: 0.05, rival: R, essential: true });
          kit.flash(tgt, { color: P.hot, size: [0.5, 2.0], dur: 0.3, intensity: 2.4, sprite: 'ring', pull: 0.7, rival: R });
          kit.flash(tgt, { color: P.core, size: [0.3, 1.6], dur: 0.14, intensity: 3.6, sprite: 'star', pull: 0.7, rival: R });
          kit.emit({ at: tgt, count: 34, speed: [2.5, 8], life: [0.35, 0.8], size: [0.07, 0.015], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 3, drag: 1.6, rival: R, essential: true });
          kit.emit({ at: tgt, radius: 0.5, count: 12, speed: [0.5, 1.8], life: [1, 1.7], size: [0.7, 1.8], ramp: 'voidsmoke', alpha: 0.75, sprite: 'smoke', blend: 'alpha', drag: 1.2, gravity: -0.4, turb: 0.5, spin: [-1, 1], rival: R });
          decal(fx, tg, 'void', 2.4, 'void', R, { life: 7 });
          kit.light(tgt, { color: P.mid, intensity: 1.5, range: 12, dur: 0.5, attack: 0.03 });
          kit.shake(0.26); kit.hitstop(45);
          if (kit.distort) kit.distort(tgt, 0.5);
          au('burst', tgt);
          // души: из цели к груди заклинателя по изогнутым путям (крупнее на 30%, чёрная сердцевина, росчерк)
          const q = kit.Q.name === 'low' ? 0.6 : 1;
          for (let i = 0; i < 5; i++) {
            const side = (i - 2) * 0.7 + (Math.random() - 0.5) * 0.3;
            const S = { R, q, hc: P.mid, first: true, prev: new V3(), vel: new V3(), aH: 1, aW: 0, aS: 0, aP: 0, tr: null };
            kit.after(0.05 + i * 0.07, () => {
              fx.anchor('chest', c.chest, R);
              S.tr = kit.Q.name !== 'low' ? trail(fx, 'void', R, TR_SOUL) : null;
              fly(fx, tgt, c.chest, 0.52 + Math.random() * 0.14, {
                lift: 1.0 + Math.random() * 0.6, side,
                ease: easeS,
                onStep(pos, dir, k, dt) { soulStep(S, pos, dt); },
                onHit(p) {
                  if (S.tr) { S.tr.push(p); S.tr.stop(); S.tr = null; }
                  kit.flash(p, { color: P.hot, size: [0.2, 0.9], dur: 0.25, intensity: 2.4, sprite: 'glow', pull: 0.7, rival: R });
                  kit.emit({ at: p, count: 6, speed: [0.5, 1.6], life: [0.3, 0.6], size: [0.05, 0.01], ramp: R ? 'rival' : 'heal', intensity: 2.4, sprite: 'spark', drag: 2, gravity: -0.5, rival: R });
                },
              });
            });
          }
          afterglow(fx, tgt, 'void', R, { radius: 1.0, count: 14, dur: 1.6, sprite: 'wisp' });
        },
      });
    });
    au('cast', c.hand);
    return true;
  }, (d) => d.rune === 'vee');
}
