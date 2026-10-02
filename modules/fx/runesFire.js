// ASHEN OATH — modules/fx/runesFire.js. Владелец: №7 [VFX].
// ▲ ИГНИС — огненное копьё и ϟ ФУЛЬГУР — молния. Эталон ритма V6 для остальных рун:
// накопление (0–0.2 с) → выпуск → полёт → удар → послесвечение; символ руны горит в круге под героем.
// combat.js наносит урон в момент rune_cast, поэтому полёт короткий (≤ 0.3 с).
// [W4-ЗАКЛИНАНИЯ] Руна в воздухе (fx.shared.runeAir из handMagic.js): копьё игниса вылетает ИЗ нарисованного
// символа кометой (белое ядро + огненный ореол + языки пламени + лента, свет в полёте), символ фульгура уходит
// в небо, а с неба и из самого символа бьют разряды в цель. Без руны в воздухе — прежний выпуск от ладони.
// Глиф и сбор искр у ладони убраны: предвестник у руки рисует castFx.js. Опции эмиттеров — на каст (без гонок в PvP).

import { caster, runeCircle, muzzle, fly, explosion, afterglow, decal, trail, rampOf, createComet, clamp, TAU } from './common.js';

// [W4-ЗАКЛИНАНИЯ] знак в воздухе летит к цели/в небо столько секунд после выпуска (airRune travel)
const AIR_TRAVEL = 0.14;
const D_RIVAL = Object.freeze({ remote: true });

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const low = () => !!(kit.Q && kit.Q.name === 'low');
  // player_cast {ability:'rune'} (main.js дублирует rune_cast) — у рун V6 своё накопление у ладони
  fx.on('player_cast', () => true, (d) => d.ability === 'rune');

  /** [W4-ЗАКЛИНАНИЯ] руна в воздухе этого каста (контракт handMagic.js) или null — тогда выпуск от ладони. */
  function airOf(rune, c) {
    const air = fx.shared && fx.shared.runeAir;
    return air && air.rune === rune && air.t0 === kit.clock && air.remote === c.remote && air.pos ? air : null;
  }

  // ------------------------------------------------------------ ▲ ИГНИС
  // Комета-копьё (общий облик снарядов), спиральный огненный хвост, марево, взрыв с огненным кольцом и тлеющими углями.
  const comet = createComet(fx);
  // [W4-ЗАКЛИНАНИЯ] ramp/rival задаются в onStep из замыкания каста — общий объект не перекрашивает чужое копьё
  const emSpiral = { at: null, count: 1, speed: [0.3, 0.9], life: [0.22, 0.38], size: [0.36, 0.62], ramp: 'fire', intensity: 2.6, sprite: 'flame', drag: 3, turb: 0.9, rot: 0, gravity: -1.2, essential: true, rival: false };
  // белый «наконечник» копья: штрихи летят со скоростью копья (вытянутый силуэт поверх круглой головы кометы)
  const emCore = { at: null, dir: null, cone: 0.02, count: 2, speed: [20, 24], life: [0.05, 0.08], size: [0.29, 0.18], ramp: 'whiteHold', intensity: 5, sprite: 'streak', stretch: 0.04, essential: true, rival: false };
  const cometO = { size: 0.46, remote: false, light: true, lightK: 1.6, dur: 0.3, trailWidth: 0.44, trailLife: 0.3, look: 'fire' };
  const _spp = new V3(), _ax = new V3(), _bx = new V3();
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('fire', d);
    const ramp = rampOf('fire', R);
    const air = airOf('ignis', c);
    runeCircle(fx, c, 'ignis', 'fire', { radius: 1.8, dur: 1.9 });
    // откуда летит копьё: из символа в воздухе (выпуск в air.launchAt) или от ладони через 0.18 с
    const from = new V3().copy(air ? air.pos : c.hand);
    let at = 0.18;
    if (air) {
      air.plan('through', new V3().lerpVectors(air.pos, c.target, 0.3));
      at = clamp(air.launchAt - kit.clock, 0, 0.3);
    } else {
      kit.light(c.hand, { color: P.hot, intensity: 0.7, range: 6, dur: 0.35, attack: 0.5 });
    }
    if (fx.shock) { try { fx.shock.haze({ pos: from, radius: air ? 0.55 : 0.35, height: 1.2, dur: 0.6, strength: 0.8 }); } catch (e) { /* ignore */ } }
    const sp = new V3().copy(from);   // [W4-ЗАКЛИНАНИЯ] точка копья этого каста — за ней идёт марево
    let haze = null;
    kit.after(at, () => {
      const dir = new V3().subVectors(c.target, from);
      const dist = Math.max(0.5, dir.length());
      dir.multiplyScalar(1 / dist);
      muzzle(fx, from, dir, 'fire', R, { size: 1.2, count: 26 });
      kit.kick(dir, 0.018);
      if (fx.shock) { try { haze = fx.shock.haze({ pos: from, radius: 0.5, height: 0.8, dur: 0.5, strength: 1, follow: () => sp }); } catch (e) { haze = null; } }
      // полёт копья: комета (ядро, ореол, искры, пламя, лента, свет) + спиральная лента и языки пламени вокруг оси
      const dur = Math.min(0.3, 0.1 + dist / 26);
      cometO.remote = R; cometO.size = R ? 0.4 : 0.46; cometO.trailWidth = R ? 0.38 : 0.44; cometO.dur = dur;
      const cm = comet.start(from, 'fire', cometO);
      const tr2 = low() ? null : trail(fx, 'fire', R, { style: 'fire', width: 0.26, life: 0.22, intensity: 2.2, spiral: 0.2, spiralRate: -22, maxPoints: 24 });
      const nSp = low() ? 1 : 2, vSpear = dist / dur;
      let spin = 0;
      fly(fx, from, c.target, dur, {
        lift: 0.2,
        onStep(pos, sdir, k, dt) {
          sp.copy(pos);
          if (cm) cm.step(pos, sdir, dt);
          if (tr2) tr2.push(pos);
          if (!(dt > 0)) return;
          emCore.at = pos; emCore.dir = sdir; emCore.count = nSp; emCore.rival = R;
          emCore.speed[0] = vSpear * 0.85; emCore.speed[1] = vSpear;
          kit.emit(emCore);
          emCore.at = null; emCore.dir = null;
          // спиральный хвост: языки пламени вокруг оси полёта
          spin += dt * 26;
          if (Math.abs(sdir.y) < 0.95) _ax.set(0, 1, 0); else _ax.set(1, 0, 0);
          _bx.crossVectors(sdir, _ax).normalize(); _ax.crossVectors(_bx, sdir);
          emSpiral.ramp = ramp; emSpiral.rival = R; emSpiral.at = _spp;
          for (let s = 0; s < nSp; s++) {
            const a = spin + s * Math.PI, r = 0.17, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
            _spp.set(pos.x + _ax.x * ca + _bx.x * sa, pos.y + _ax.y * ca + _bx.y * sa, pos.z + _ax.z * ca + _bx.z * sa);
            kit.emit(emSpiral);
          }
          emSpiral.at = null;
        },
        onHit(p) {
          if (cm) cm.end(p);
          if (tr2) tr2.stop();
          if (haze && haze.kill) haze.kill();
          explosion(fx, p, c.targetGround, 'fire', R, { scale: R ? 0.7 : 1.35, shake: 0.38, hitstop: 65 }); // по нашему герою (у камеры) — мельче
          // огненное кольцо: языки пламени бегут по земле наружу
          kit.emit({ at: { x: c.targetGround.x, y: c.targetGround.y + 0.1, z: c.targetGround.z }, shape: 'ring', radius: 0.6, count: 46, radial: 6.5, speed: [0, 0.3], dir: { x: 0, y: 1, z: 0 }, cone: 0.1, life: [0.35, 0.6], size: [0.7, 0.25], ramp, intensity: 2.4, sprite: 'flame', rot: 0, drag: 3.2, gravity: -0.6, rival: R, essential: true });
          decal(fx, c.targetGround, 'scorch', 2.6, 'fire', R, { life: 9 });
          decal(fx, c.targetGround, 'crater', 1.5, 'fire', R, { life: 6 });
          afterglow(fx, p, 'fire', R, { radius: 1.1, count: 32, dur: 2.2, ramp: R ? 'rival' : 'ember' });
          kit.screenFlash(P.mid, 0.045, 0.12);
          fx.legacy.audio && fx.legacy.audio('burst', p);
        },
      });
    });
    fx.legacy.audio && fx.legacy.audio('cast', c.hand);
    return true;
  }, (d) => d.rune === 'ignis');

  // ------------------------------------------------------------ ϟ ФУЛЬГУР
  // Ветвящиеся ломаные разряды с неба и из символа (или руки), вспышка экрана на кадр, дуги по земле, оглушённый враг в искрах.
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('storm', d);
    const rival = R ? 1 : 0;
    const air = airOf('fulgur', c);
    const tgt = c.target, sky = new V3(tgt.x + 0.8, tgt.y + 13, tgt.z - 0.6);
    runeCircle(fx, c, 'fulgur', 'storm', { radius: 1.8, dur: 1.6, spin: 1.2 });
    // [W4-ЗАКЛИНАНИЯ] источник разряда — символ в воздухе (он уходит в небо в момент удара) или ладонь
    const src = new V3().copy(air ? air.pos : c.hand);
    const sdir = air ? new V3().subVectors(tgt, src).normalize() : c.dir;
    let at = 0.1;
    if (air) {
      air.plan('up', new V3(src.x + (tgt.x - src.x) * 0.3, src.y + 3.0, src.z + (tgt.z - src.z) * 0.3));
      at = clamp(air.launchAt - kit.clock, 0, 0.22);
    }
    // разряды вокруг источника во время накопления (символ «трещит» до выпуска)
    if (fx.bolts) {
      const rr = air ? 0.55 : 0.35;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        try { fx.bolts.arc({ from: src, to: { x: src.x + Math.cos(a) * rr, y: src.y + 0.25 * Math.sin(a * 2), z: src.z + Math.sin(a) * rr }, color: P.mid, core: P.core, dur: air ? Math.max(0.16, at + 0.04) : 0.16, rate: 30, intensity: 2.4, rival }); } catch (e) { /* ignore */ }
      }
    }
    // разрыв неба: вспышка облака над целью (у верхнего края кадра) за 0.1 с до удара
    kit.flash({ x: sky.x, y: tgt.y + 9, z: sky.z }, { color: P.hot, size: [2, 7], dur: 0.35, intensity: 2.5, sprite: 'glow', pull: 0, delay: Math.max(0, at - 0.1), rival: R });
    kit.after(at, () => {
      if (fx.bolts) {
        try {
          fx.bolts.strike({ from: sky, to: tgt, color: P.mid, core: P.core, width: 0.13, branches: 6, jitter: 0.13, segments: 22, dur: 0.5, intensity: 3.4, rival, seed: (Math.random() * 1e6) | 0 });
          if (air) {
            // [W4-ЗАКЛИНАНИЯ] «откуда»: заметный разряд из символа в цель (символ далеко от камеры — можно толще)
            fx.bolts.strike({ from: src, to: tgt, color: P.mid, core: P.core, width: R ? 0.03 : 0.045, branches: 2, jitter: 0.12, segments: 16, dur: 0.24, intensity: 2.6, rival, seed: (Math.random() * 1e6) | 0, origin: true });
          } else {
            // разряд из ладони — тонкий и короткий: он начинается у камеры, толстый ореол + bloom дают белый столб
            fx.bolts.strike({ from: src, to: tgt, color: P.mid, core: P.core, width: 0.022, branches: 1, jitter: 0.12, segments: 14, dur: 0.18, intensity: 1.8, rival, seed: (Math.random() * 1e6) | 0, origin: false });
          }
          fx.bolts.groundArcs({ center: c.targetGround, radius: R ? 2.4 : 4.2, count: 7, dur: 0.7, color: P.mid, core: P.core, intensity: 2.4, rival });
        } catch (e) { /* ignore */ }
      } else {
        kit.emit({ at: sky, shape: 'line', to: tgt, count: 60, speed: [0, 0.3], life: [0.1, 0.25], size: [0.2, 0.05], ramp: 'storm', intensity: 4, sprite: 'glow', essential: true, rival: R });
      }
      if (air) kit.emit({ at: src, to: tgt, shape: 'line', count: 14, speed: [0.2, 1.2], life: [0.12, 0.26], size: [0.07, 0.015], ramp: rampOf('storm', R), intensity: 3.2, sprite: 'spark', drag: 3, essential: true, rival: R });
      muzzle(fx, src, sdir, 'storm', R, { size: 0.9, count: 18 });
      kit.screenFlash(P.hot, R ? 0.18 : 0.3, 0.08);
      kit.flash(tgt, { color: P.core, size: [1.2, 5.5], dur: 0.3, intensity: 5, sprite: 'star', pull: 0.8, rival: R });
      kit.flash(tgt, { color: P.mid, size: [1.5, 6], dur: 0.5, intensity: 2.2, sprite: 'glow', pull: 0.8, rival: R });
      kit.emit({ at: tgt, count: 90, speed: [4, 13], life: [0.3, 0.8], size: [0.06, 0.012], ramp: rampOf('storm', R), intensity: 3.6, sprite: 'spark', stretch: 0.04, gravity: 6, drag: 1.5, ground: c.targetGround.y + 0.03, essential: true, rival: R });
      kit.emit({ at: c.targetGround, shape: 'ring', radius: 0.5, count: 40, radial: 8, dir: { x: 0, y: 1, z: 0 }, cone: 0.3, speed: [0, 1], life: [0.2, 0.45], size: [0.3, 0.05], ramp: rampOf('storm', R), intensity: 3, sprite: 'spark', stretch: 0.03, drag: 4, essential: true, rival: R });
      if (fx.shock) { try { fx.shock.ring({ pos: { x: c.targetGround.x, y: c.targetGround.y + 0.05, z: c.targetGround.z }, r0: 0.4, r1: 6, dur: 0.45, color: P.mid, hot: P.core, intensity: 2.2, rival }); } catch (e) { /* ignore */ } }
      decal(fx, c.targetGround, 'crack', 3.2, 'storm', R, { life: 6 });
      kit.light(tgt, { color: P.hot, intensity: 2.2, range: 18, dur: 0.45, attack: 0.02 });
      kit.shake(0.42); kit.hitstop(70);
      // остаточное электричество
      kit.emit({ at: tgt, radius: 1.2, count: 36, speed: [0.2, 1], life: [0.6, 1.6], size: [0.05, 0.01], ramp: rampOf('storm', R), intensity: 2.6, sprite: 'spark', turb: 1.2, drag: 1, delay: 0.8, rival: R });
      fx.legacy.audio && fx.legacy.audio('nova', tgt);
    });
    fx.legacy.audio && fx.legacy.audio('cast', c.hand);
    return true;
  }, (d) => d.rune === 'fulgur');

  // оглушённый Регент / соперник (наш фульгур) и наш герой в PvP (фульгур соперника — в его цвете):
  // треск разрядов и искры по телу, «звёздочки» над головой, пока действует оглушение.
  // [W4-ЗАКЛИНАНИЯ] опции предвыделены (без аллокаций на тик); при 3+ эффектах дуги и искры редеют (scopeShare фона).
  let stunAcc = 0;
  const _c = new V3(), _a = new V3(), _b = new V3(), _st = new V3();
  const PS = fx.pal('storm', null), PR = fx.pal('storm', D_RIVAL);
  const stArc = { from: _a, to: _b, color: PS.mid, core: PS.core, dur: 0.18, rate: 25, intensity: 2.2, width: 0.025, rival: 0 };
  const stEm = { at: _c, radius: 1.0, count: 5, speed: [0.5, 2.5], life: [0.2, 0.45], size: [0.05, 0.01], ramp: 'storm', intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 3, rival: false };
  const stStar = { color: PS.core, size: [0.12, 0.28], dur: 0.16, intensity: 2.6, sprite: 'star', pull: 0.1, rival: false };
  function stunFx(pos, h, top, remote, sh, rad) {
    const P = remote ? PR : PS;
    _c.set(pos.x, pos.y + h, pos.z);
    if (fx.bolts && Math.random() < sh) {
      const a1 = Math.random() * TAU, a2 = a1 + 1.2 + Math.random() * 2;
      _a.set(_c.x + Math.cos(a1) * rad, _c.y + (Math.random() - 0.5) * 1.6 * rad / 0.9, _c.z + Math.sin(a1) * rad);
      _b.set(_c.x + Math.cos(a2) * rad, _c.y + (Math.random() - 0.5) * 1.6 * rad / 0.9, _c.z + Math.sin(a2) * rad);
      stArc.color = P.mid; stArc.core = P.core; stArc.rival = remote ? 1 : 0;
      try { fx.bolts.arc(stArc); } catch (e) { /* ignore */ }
    }
    stEm.radius = rad * 1.1; stEm.count = (remote ? 3 : 5) * sh; stEm.ramp = rampOf('storm', remote); stEm.rival = remote;
    kit.emit(stEm);
    // «звёздочки» оглушения над головой — признак состояния, не редеют
    const t = fx.clock * 4;
    stStar.color = P.core; stStar.rival = remote;
    for (let i = 0; i < 2; i++) {
      const a = t + i * Math.PI;
      _st.set(pos.x + Math.cos(a) * 0.55, pos.y + h + top, pos.z + Math.sin(a) * 0.55);
      kit.flash(_st, stStar);
    }
  }
  fx.every((dt, snap) => {
    if (!snap || dt <= 0) { stunAcc = 0; return; }
    const pvp = snap.mode === 'pvp';
    const bo = snap.boss, op = snap.opponent, pl = snap.player;
    const tOp = op && op.stunned && op.position ? op.position : null;
    const tBo = !tOp && !pvp && bo && bo.stunned && bo.position ? bo.position : null;
    const tPl = pvp && pl && pl.stunned && pl.position && pl.action !== 'dead' ? pl.position : null;
    if (!tOp && !tBo && !tPl) { stunAcc = 0; return; }
    stunAcc += dt;
    if (stunAcc < 0.14) return;
    stunAcc = 0;
    const sh = kit.scopeShare(null);
    if (tOp) stunFx(tOp, 1.2, 0.75, false, sh, 0.9);
    else if (tBo) stunFx(tBo, 2.6, 1.6, false, sh, 0.9);
    if (tPl) stunFx(tPl, 1.2, 0.75, true, sh, 0.6);   // наш герой у камеры — дуги ближе к телу
  });

  // [W4-ЗАКЛИНАНИЯ] сброс боя: кометы в полёте и счётчик оглушения
  fx.onClear(() => { stunAcc = 0; comet.clear(); });
  fx.onDispose(() => { comet.clear(); });
}
