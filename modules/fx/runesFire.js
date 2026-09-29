// ASHEN OATH — modules/fx/runesFire.js. Владелец: №7 [VFX].
// ▲ ИГНИС — огненное копьё и ϟ ФУЛЬГУР — молния. Эталон ритма V6 для остальных рун:
// накопление (0–0.2 с) → выпуск → полёт → удар → послесвечение; символ руны горит в круге под героем.
// combat.js наносит урон в момент rune_cast, поэтому полёт короткий (≤ 0.3 с).

import { caster, runeCircle, handGlyph, gather, muzzle, fly, explosion, afterglow, decal, trail, rampOf, TAU } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  // player_cast {ability:'rune'} (main.js дублирует rune_cast) — у рун V6 своё накопление у ладони
  fx.on('player_cast', () => true, (d) => d.ability === 'rune');

  // ------------------------------------------------------------ ▲ ИГНИС
  // Раскалённое ядро копья, спиральный огненный хвост, марево, взрыв с огненным кольцом и тлеющими углями.
  const emitHead = { at: null, count: 3, speed: [0.2, 0.8], life: [0.1, 0.18], size: [0.34, 0.08], ramp: 'fire', intensity: 3.4, sprite: 'glow', essential: true, rival: false };
  const emitCore = { at: null, dir: null, cone: 0.02, count: 2, speed: [20, 24], life: [0.05, 0.08], size: [0.22, 0.14], ramp: 'whiteHold', intensity: 5, sprite: 'streak', stretch: 0.04, essential: true, rival: false };
  const emitSpiral = { at: null, count: 1, speed: [0.3, 0.9], life: [0.22, 0.38], size: [0.28, 0.5], ramp: 'fire', intensity: 2.6, sprite: 'flame', drag: 3, turb: 0.9, rot: 0, gravity: -1.2, essential: true, rival: false };
  const emitEmber = { at: null, count: 2, radius: 0.12, speed: [0.5, 2.2], life: [0.35, 0.8], size: [0.05, 0.01], ramp: 'ember', intensity: 2.8, sprite: 'spark', stretch: 0.02, gravity: 3.5, drag: 1.2, rival: false };
  const _sp = new V3(), _ax = new V3(), _bx = new V3();
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('fire', d);
    // накопление
    runeCircle(fx, c, 'ignis', 'fire', { radius: 1.8, dur: 1.9 });
    handGlyph(fx, c, 'ignis', 'fire', { radius: 0.42, dur: 0.5 });
    gather(fx, c.hand, 'fire', R, { time: 0.18, radius: 0.9, count: 40, glow: 0.8, essential: true });
    kit.light(c.hand, { color: P.hot, intensity: 0.7, range: 6, dur: 0.35, attack: 0.5 });
    if (fx.shock) { try { fx.shock.haze({ pos: c.hand, radius: 0.35, height: 1.2, dur: 0.6, strength: 0.8 }); } catch (e) { /* ignore */ } }
    const ramp = rampOf('fire', R);
    for (const e of [emitHead, emitSpiral]) { e.ramp = ramp; e.rival = R; }
    emitEmber.ramp = R ? 'rival' : 'ember'; emitEmber.rival = R;
    emitCore.rival = R;
    const tr = trail(fx, 'fire', R, { style: 'fire', width: 0.34, life: 0.3, intensity: 2.6, spiral: 0.16, spiralRate: 22, maxPoints: 28 });
    const tr2 = trail(fx, 'fire', R, { style: 'fire', width: 0.2, life: 0.22, intensity: 2.2, spiral: 0.16, spiralRate: -22, maxPoints: 24 });
    let haze = null;
    kit.after(0.18, () => {
      muzzle(fx, c.hand, c.dir, 'fire', R, { size: 1.2, count: 26 });
      kit.kick(c.dir, 0.018);
      if (fx.shock) { try { haze = fx.shock.haze({ pos: c.hand, radius: 0.5, height: 0.8, dur: 0.5, strength: 1, follow: () => _sp }); } catch (e) { haze = null; } }
      // полёт копья
      const dur = Math.min(0.3, 0.1 + c.dist / 26);
      const vSpear = c.dist / dur;
      emitCore.speed[0] = vSpear * 0.85; emitCore.speed[1] = vSpear;
      let spin = 0;
      fly(fx, c.hand, c.target, dur, {
        lift: 0.25,
        onStep(pos, dir, k, dt) {
          _sp.copy(pos);
          emitHead.at = pos; kit.emit(emitHead);
          emitCore.at = pos; emitCore.dir = dir; kit.emit(emitCore);
          // спиральный хвост: два языка пламени вокруг оси полёта
          spin += dt * 26;
          if (Math.abs(dir.y) < 0.95) _ax.set(0, 1, 0); else _ax.set(1, 0, 0);
          _bx.crossVectors(dir, _ax).normalize(); _ax.crossVectors(_bx, dir);
          for (let s = 0; s < 2; s++) {
            const a = spin + s * Math.PI, r = 0.13;
            emitSpiral.at = _sp.set(pos.x + (_ax.x * Math.cos(a) + _bx.x * Math.sin(a)) * r, pos.y + (_ax.y * Math.cos(a) + _bx.y * Math.sin(a)) * r, pos.z + (_ax.z * Math.cos(a) + _bx.z * Math.sin(a)) * r);
            kit.emit(emitSpiral);
          }
          _sp.copy(pos);
          emitEmber.at = pos; kit.emit(emitEmber);
          if (tr) tr.push(pos);
          if (tr2) tr2.push(pos);
        },
        onHit(p) {
          if (tr) tr.stop(); if (tr2) tr2.stop();
          if (haze && haze.kill) haze.kill();
          explosion(fx, p, c.targetGround, 'fire', R, { scale: 1.35, shake: 0.38, hitstop: 65 });
          // огненное кольцо: языки пламени бегут по земле наружу
          kit.emit({ at: { x: c.targetGround.x, y: c.targetGround.y + 0.1, z: c.targetGround.z }, shape: 'ring', radius: 0.6, count: 46, radial: 6.5, speed: [0, 0.3], dir: { x: 0, y: 1, z: 0 }, cone: 0.1, life: [0.35, 0.6], size: [0.7, 0.25], ramp, intensity: 2.4, sprite: 'flame', rot: 0, drag: 3.2, gravity: -0.6, rival: R, essential: true });
          decal(fx, c.targetGround, 'scorch', 2.6, 'fire', R, { life: 9 });
          decal(fx, c.targetGround, 'crater', 1.5, 'fire', R, { life: 6 });
          afterglow(fx, p, 'fire', R, { radius: 1.1, count: 40, dur: 2.2, ramp: R ? 'rival' : 'ember' });
          kit.screenFlash(R ? 0x9a6bff : 0xff8a3a, 0.045, 0.12);
          fx.legacy.audio && fx.legacy.audio('burst', p);
        },
      });
    });
    fx.legacy.audio && fx.legacy.audio('cast', c.hand);
    return true;
  }, (d) => d.rune === 'ignis');

  // ------------------------------------------------------------ ϟ ФУЛЬГУР
  // Ветвящиеся ломаные разряды с неба и из руки, вспышка экрана на кадр, дуги по земле, оглушённый враг в искрах.
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('storm', d);
    const rival = R ? 1 : 0;
    runeCircle(fx, c, 'fulgur', 'storm', { radius: 1.8, dur: 1.6, spin: 1.2 });
    handGlyph(fx, c, 'fulgur', 'storm', { radius: 0.4, dur: 0.45, spin: 4 });
    gather(fx, c.hand, 'storm', R, { time: 0.12, radius: 0.7, count: 30, glow: 0.6, essential: true });
    // разряды у ладони во время накопления
    if (fx.bolts) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        try { fx.bolts.arc({ from: c.hand, to: { x: c.hand.x + Math.cos(a) * 0.35, y: c.hand.y + 0.25 * Math.sin(a * 2), z: c.hand.z + Math.sin(a) * 0.35 }, color: P.mid, core: P.core, dur: 0.16, rate: 30, intensity: 2.4, rival }); } catch (e) { /* ignore */ }
      }
    }
    const tgt = c.target, sky = new V3(tgt.x + 0.8, tgt.y + 13, tgt.z - 0.6);
    // разрыв неба: вспышка облака над целью
    kit.flash(sky, { color: P.hot, size: [2, 7], dur: 0.35, intensity: 2.5, sprite: 'glow', pull: 0 });
    kit.after(0.1, () => {
      if (fx.bolts) {
        try {
          fx.bolts.strike({ from: sky, to: tgt, color: P.mid, core: P.core, width: 0.13, branches: 6, jitter: 0.13, segments: 22, dur: 0.5, intensity: 3.4, rival, seed: (Math.random() * 1e6) | 0 });
          fx.bolts.strike({ from: c.hand, to: tgt, color: P.mid, core: P.core, width: 0.06, branches: 3, jitter: 0.16, segments: 14, dur: 0.32, intensity: 3, rival, seed: (Math.random() * 1e6) | 0 });
          fx.bolts.groundArcs({ center: c.targetGround, radius: 4.2, count: 7, dur: 0.7, color: P.mid, core: P.core, intensity: 2.4, rival });
        } catch (e) { /* ignore */ }
      } else {
        kit.emit({ at: sky, shape: 'line', to: tgt, count: 60, speed: [0, 0.3], life: [0.1, 0.25], size: [0.2, 0.05], ramp: 'storm', intensity: 4, sprite: 'glow', essential: true, rival: R });
      }
      muzzle(fx, c.hand, c.dir, 'storm', R, { size: 0.9, count: 18 });
      kit.screenFlash(R ? 0xb49cff : 0xdff2ff, 0.3, 0.08);
      kit.flash(tgt, { color: P.core, size: [1.2, 5.5], dur: 0.3, intensity: 5, sprite: 'star', pull: 0.8 });
      kit.flash(tgt, { color: P.mid, size: [1.5, 6], dur: 0.5, intensity: 2.2, sprite: 'glow', pull: 0.8 });
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

  // оглушённый Регент (и соперник): треск разрядов и искры по телу, пока действует оглушение
  let stunAcc = 0;
  const _c = new V3(), _a = new V3(), _b = new V3();
  fx.every((dt, snap) => {
    if (!snap || dt <= 0) { stunAcc = 0; return; }
    const bo = snap.boss, op = snap.opponent;
    let pos = null, remote = false, h = 2.6;
    if (op && op.stunned && op.position) { pos = op.position; h = 1.2; }
    else if (bo && bo.stunned && bo.position && snap.mode !== 'pvp') { pos = bo.position; }
    if (!pos) { stunAcc = 0; return; }
    stunAcc += dt;
    if (stunAcc < 0.14) return;
    stunAcc = 0;
    _c.set(pos.x, pos.y + h, pos.z);
    const P = fx.pal('storm', null);
    if (fx.bolts) {
      const a1 = Math.random() * TAU, a2 = a1 + 1.2 + Math.random() * 2;
      _a.set(_c.x + Math.cos(a1) * 0.9, _c.y + (Math.random() - 0.5) * 1.6, _c.z + Math.sin(a1) * 0.9);
      _b.set(_c.x + Math.cos(a2) * 0.9, _c.y + (Math.random() - 0.5) * 1.6, _c.z + Math.sin(a2) * 0.9);
      try { fx.bolts.arc({ from: _a, to: _b, color: P.mid, core: P.core, dur: 0.18, rate: 25, intensity: 2.2, width: 0.025 }); } catch (e) { /* ignore */ }
    }
    kit.emit({ at: _c, radius: 1.0, count: 5, speed: [0.5, 2.5], life: [0.2, 0.45], size: [0.05, 0.01], ramp: 'storm', intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 3 });
    // «звёздочки» оглушения над головой
    const t = fx.clock * 4;
    for (let i = 0; i < 2; i++) {
      const a = t + i * Math.PI;
      kit.flash({ x: pos.x + Math.cos(a) * 0.55, y: pos.y + h + (snap.mode === 'pvp' ? 0.75 : 1.6), z: pos.z + Math.sin(a) * 0.55 }, { color: P.core, size: [0.12, 0.28], dur: 0.16, intensity: 2.6, sprite: 'star', pull: 0.1 });
    }
  });
}
