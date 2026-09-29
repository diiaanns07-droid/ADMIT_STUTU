// ASHEN OATH — modules/fx/runesWild.js. Владелец: №7 [VFX].
// @ СПИРА — смерч вокруг героя (ветер, пепел, листья, обломки), ^ АКУС — волна ледяных кристаллов
// из земли до цели + ледяные иглы-снаряды, V МЕССИС — призрачный серп-полумесяц и фиолетовые души.
// Ритм как у runesFire.js: накопление → выпуск → полёт → удар → послесвечение, символ в круге под героем.

import { caster, runeCircle, handGlyph, gather, muzzle, fly, afterglow, decal, trail, rampOf, clamp, TAU } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const UP = { x: 0, y: 1, z: 0 };
  const au = (n, p) => { if (fx.legacy && typeof fx.legacy.audio === 'function') { try { fx.legacy.audio(n, p); } catch (e) { /* ignore */ } } };

  // ============================================================ @ СПИРА
  fx.suppress('vortex');
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('wind', d), ramp = rampOf('wind', R);
    const rad = clamp(typeof d.radius === 'number' ? d.radius : 7, 2, 12);
    runeCircle(fx, c, 'spira', 'wind', { radius: 1.9, dur: 2.2, spin: 2.6, rings: 3 });
    handGlyph(fx, c, 'spira', 'wind', { radius: 0.4, dur: 0.45, spin: 5 });
    gather(fx, c.hand, 'wind', R, { time: 0.16, radius: 0.9, count: 30, glow: 0.6, essential: true });
    const g = { x: c.feet.x, y: c.feet.y + 0.08, z: c.feet.z };
    kit.after(0.16, () => {
      // выпуск: закрученный порыв по кругу наружу
      kit.emit({ at: g, shape: 'ring', radius: 0.6, count: 60, radial: rad * 0.9, tangent: 7, speed: [0, 0.3], dir: UP, cone: 0.3, life: [0.35, 0.6], size: [0.12, 0.03], ramp, intensity: 2.2, sprite: 'streak', stretch: 0.05, drag: 2.4, rival: R, essential: true });
      kit.emit({ at: g, shape: 'ring', radius: 0.8, count: 30, radial: rad * 0.7, tangent: 4, speed: [0.5, 1.5], dir: UP, cone: 0.5, life: [0.7, 1.2], size: [0.5, 1.4], ramp: 'dust', alpha: 0.6, sprite: 'smoke', blend: 'alpha', drag: 2.2, gravity: -0.3, turb: 0.5, spin: [-1.5, 1.5] });
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
  fx.every((dt, snap) => {
    const pl = snap && snap.player;
    const on = !!(pl && pl.vortex && snap.status !== 'defeat');
    tw.on += ((on ? 1 : 0) - tw.on) * (1 - Math.exp(-dt * (on ? 8 : 4)));
    if (tw.on < 0.03 || dt <= 0) { tw.acc = tw.ash = tw.leaf = tw.deb = 0; return; }
    fx.anchor('feet', _f, false);
    const k = tw.on * (fx.Q.name === 'low' ? 0.5 : 1);
    tw.acc += dt * 130 * k; tw.ash += dt * 12 * k; tw.leaf += dt * 10 * k; tw.deb += dt * 5 * k;
    while (tw.acc >= 1) { tw.acc -= 1; funnelPoint(oWind, Math.pow(Math.random(), 0.8) * 3.0, 0.3); kit.emit(oWind); }
    while (tw.ash >= 1) { tw.ash -= 1; funnelPoint(oAsh, Math.random() * 2.2, 0.55); kit.emit(oAsh); }
    while (tw.leaf >= 1) { tw.leaf -= 1; funnelPoint(oLeaf, Math.random() * 2.6, 0.6); kit.emit(oLeaf); }
    while (tw.deb >= 1) { tw.deb -= 1; funnelPoint(oDeb, Math.random() * 1.2, 0.5); kit.emit(oDeb); }
  });

  // ============================================================ ^ АКУС
  fx.suppress('proj:caret');
  const _p = new V3(), _q = new V3();
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('frost', d), ramp = rampOf('frost', R);
    runeCircle(fx, c, 'caret', 'frost', { radius: 1.8, dur: 1.7, spin: -0.8 });
    handGlyph(fx, c, 'caret', 'frost', { radius: 0.42, dur: 0.5 });
    gather(fx, c.hand, 'frost', R, { time: 0.14, radius: 0.8, count: 30, glow: 0.6, essential: true });
    kit.after(0.12, () => muzzle(fx, c.hand, c.dir, 'frost', R, { size: 0.9, count: 18 }));
    // волна кристаллов пробивает землю от героя до цели
    const a = new V3(c.feet.x + c.fwd.x * 0.9, c.feet.y, c.feet.z + c.fwd.z * 0.9);
    const b = new V3().copy(c.targetGround);
    const L = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));
    const N = clamp(Math.round(L / 0.55), 6, 16);
    for (let i = 0; i <= N; i++) {
      const u = i / N, big = 0.5 + 0.7 * u;
      kit.after(0.1 + i * 0.03, () => {
        const side = (Math.random() - 0.5) * 0.5;
        _p.set(a.x + (b.x - a.x) * u + c.right.x * side, 0, a.z + (b.z - a.z) * u + c.right.z * side);
        _p.y = fx.groundY(_p.x, _p.z, a.y + (b.y - a.y) * u) + 0.02;
        for (let s = 0; s < 3; s++) {
          kit.emit({ at: { x: _p.x + (Math.random() - 0.5) * 0.35, y: _p.y + 0.15 * big, z: _p.z + (Math.random() - 0.5) * 0.35 }, count: 1, dir: UP, cone: 0.1, speed: [0.3, 0.8], drag: 6, life: [0.55, 0.85], size: [0.9 * big, 0.75 * big], ramp, intensity: 2.6, sprite: 'shard', rot: (Math.random() - 0.5) * 0.7, fadeIn: 0.02, curve: 3, rival: R, essential: true });
        }
        kit.emit({ at: _p, count: 8, dir: UP, cone: 0.6, speed: [1.2, 3.2], life: [0.3, 0.6], size: [0.05, 0.01], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.02, gravity: 3, drag: 1.5, rival: R });
        kit.emit({ at: _p, count: 3, radius: 0.3, speed: [0.2, 0.6], life: [0.8, 1.3], size: [0.4, 0.9], ramp: 'frostsmoke', alpha: 0.6, sprite: 'smoke', blend: 'alpha', drag: 1.5, gravity: -0.2, rival: R });
        if (i % 4 === 2) decal(fx, _p, 'frost', 0.9 + 0.5 * u, 'frost', R, { life: 6 });
        if (i === N) {
          // финальный ледяной взрыв у цели
          kit.flash(c.target, { color: P.core, size: [0.4, 2.4], dur: 0.2, intensity: 4.5, sprite: 'star', pull: 0.7, rival: R });
          kit.flash(c.target, { color: P.mid, size: [0.8, 3], dur: 0.4, intensity: 1.8, sprite: 'glow', pull: 0.7, rival: R });
          kit.emit({ at: { x: b.x, y: b.y + 0.3, z: b.z }, count: 14, dir: UP, cone: 0.9, speed: [1, 2.5], drag: 5, life: [0.6, 0.9], size: [0.9, 0.7], ramp, intensity: 2.2, sprite: 'shard', rot: 0, rival: R, essential: true });
          kit.emit({ at: c.target, count: 40, speed: [3, 9], life: [0.4, 0.9], size: [0.07, 0.015], ramp, intensity: 3, sprite: 'flake', spin: [-6, 6], gravity: 4, drag: 1.2, ground: b.y + 0.03, rival: R, essential: true });
          decal(fx, b, 'frost', 2.2, 'frost', R, { life: 7 });
          if (fx.shock) { try { fx.shock.ring({ pos: { x: b.x, y: b.y + 0.05, z: b.z }, r0: 0.3, r1: 3.6, dur: 0.45, color: P.mid, hot: P.core, intensity: 1.8, thickness: 0.14, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ } }
          kit.light(c.target, { color: P.hot, intensity: 1.6, range: 12, dur: 0.5, attack: 0.03 });
          kit.shake(0.22); kit.hitstop(35);
          au('orbImpact', c.target);
        }
      });
    }
    au('cast', c.hand);
    return true;
  }, (d) => d.rune === 'caret');

  // ледяные иглы в полёте (снаряды 'caret:*' из snap.projectiles): сияющий стержень + морозный след
  const needles = new Map(); // id → { tr, seen }
  let tag = 0;
  const oNeedle = { at: new V3(), dir: new V3(), cone: 0.01, count: 1, speed: [30, 34], life: [0.03, 0.05], size: [0.13, 0.09], ramp: 'frost', intensity: 4, sprite: 'streak', stretch: 0.03, essential: true, rival: false };
  const oFlake = { at: new V3(), count: 1, radius: 0.08, speed: [0.2, 0.8], life: [0.3, 0.55], size: [0.06, 0.02], ramp: 'frost', intensity: 2.6, sprite: 'flake', spin: [-5, 5], gravity: 1, drag: 2, rival: false };
  fx.every((dt, snap) => {
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : null;
    tag++;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const pr = list[i];
        if (!pr || pr.id === undefined || pr.id === null || !pr.position) continue;
        const id = String(pr.id);
        if (!id.startsWith('caret:')) continue;
        const R = !!pr.remote;
        let n = needles.get(id);
        if (!n) { n = { tr: trail(fx, 'frost', R, { style: 'energy', width: 0.09, life: 0.16, intensity: 2.4, maxPoints: 16 }), seen: 0 }; needles.set(id, n); }
        n.seen = tag;
        const p = pr.position, v = pr.velocity;
        oNeedle.at.set(p.x, p.y, p.z);
        if (v) oNeedle.dir.set(v.x, v.y, v.z); else oNeedle.dir.set(0, 0, -1);
        oNeedle.rival = R; oNeedle.ramp = R ? 'rival' : 'frost';
        if (dt > 0) kit.emit(oNeedle);
        if (dt > 0 && Math.random() < 0.6) { oFlake.at.set(p.x, p.y, p.z); oFlake.rival = R; oFlake.ramp = oNeedle.ramp; kit.emit(oFlake); }
        if (n.tr) { try { n.tr.push(p); } catch (e) { /* ignore */ } }
      }
    }
    for (const [id, n] of needles) {
      if (n.seen !== tag) { if (n.tr) { try { n.tr.stop(); } catch (e) { /* ignore */ } } needles.delete(id); }
    }
  });
  fx.on('projectile_impact', (ev, d) => {
    const R = fx.isRemote(d), P = fx.pal('frost', d), ramp = rampOf('frost', R);
    const p = fx.evPos(ev, _q);
    if (!p) return true;
    kit.flash(p, { color: P.core, size: [0.2, 1.1], dur: 0.14, intensity: 4, sprite: 'star', pull: 0.5, rival: R });
    kit.emit({ at: p, count: 10, speed: [2, 5], life: [0.3, 0.6], size: [0.28, 0.16], ramp, intensity: 2.4, sprite: 'shard', spin: [-8, 8], gravity: 6, drag: 1.2, rival: R, essential: true });
    kit.emit({ at: p, count: 16, speed: [1, 4], life: [0.3, 0.7], size: [0.06, 0.02], ramp, intensity: 2.8, sprite: 'flake', spin: [-5, 5], gravity: 2, drag: 1.5, rival: R });
    kit.hitstop(12);
    return true;
  }, (d) => d && d.projectileId !== undefined && d.projectileId !== null && String(d.projectileId).startsWith('caret:'));

  // ============================================================ V МЕССИС
  // Призрачный серп-полумесяц рассекает воздух у цели, из цели к заклинателю летят фиолетовые души.
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('void', d), ramp = rampOf('void', R);
    // в данных «жатвы» from = цель, to = заклинатель: цель берём из from
    const tgt = new V3();
    if (d.from && typeof d.from.x === 'number' && Math.hypot(d.from.x - c.chest.x, d.from.z - c.chest.z) > 0.8) tgt.set(d.from.x, d.from.y, d.from.z);
    else tgt.copy(c.target);
    const tg = new V3(tgt.x, fx.groundY(tgt.x, tgt.z, tgt.y - (R ? 1.25 : 2.6)), tgt.z);
    runeCircle(fx, c, 'vee', 'void', { radius: 1.8, dur: 1.9, spin: -1.2 });
    handGlyph(fx, c, 'vee', 'void', { radius: 0.42, dur: 0.5 });
    gather(fx, c.hand, 'void', R, { time: 0.14, radius: 0.8, count: 28, glow: 0.6, essential: true });
    // плоскость серпа: поперёк линии заклинатель → цель
    const rx = c.right.x, rz = c.right.z;
    const Rb = R ? 1.4 : 2.1;
    const ctr = new V3(tgt.x - c.fwd.x * 0.6, tgt.y + 0.15, tgt.z - c.fwd.z * 0.6);
    const tip = new V3(), tan = new V3();
    const blade = { at: tip, dir: tan, cone: 0.05, count: 3, speed: [9, 12], life: [0.14, 0.24], size: [0.22, 0.08], ramp, intensity: 3.4, sprite: 'streak', stretch: 0.035, drag: 5, rival: R, essential: true };
    const bladeCore = { at: tip, dir: tan, cone: 0.02, count: 2, speed: [10, 12], life: [0.08, 0.12], size: [0.12, 0.05], ramp: 'whiteHold', intensity: 4, sprite: 'streak', stretch: 0.03, drag: 5, rival: R, essential: true };
    const mist = { at: tip, count: 1, radius: 0.15, speed: [0.2, 0.6], life: [0.5, 0.9], size: [0.4, 0.9], ramp: 'voidsmoke', alpha: 0.7, sprite: 'smoke', blend: 'alpha', drag: 1.5, turb: 0.4, rival: R };
    const tr = trail(fx, 'void', R, { style: 'ghost', width: 0.55, life: 0.35, intensity: 2.2, maxPoints: 28, minDist: 0.04 });
    const A0 = 2.55, A1 = -0.75; // сверху-слева вниз-вправо
    const pt = (out, a, rr) => out.set(ctr.x + rx * Math.cos(a) * rr, ctr.y + Math.sin(a) * rr * 0.85, ctr.z + rz * Math.cos(a) * rr);
    let prevA = A0;
    kit.after(0.14, () => {
      kit.flash(ctr, { color: P.hot, size: [0.5, 2.4], dur: 0.3, intensity: 1.6, sprite: 'glow', pull: 0.5, rival: R });
      kit.actor({
        dur: 0.17,
        update(t, k) {
          const a = A0 + (A1 - A0) * (1 - Math.pow(1 - k, 2));
          // заполняем дугу между прошлым и текущим углом — лезвие не рвётся на низком fps
          const steps = 4;
          for (let s = 1; s <= steps; s++) {
            const aa = prevA + (a - prevA) * (s / steps);
            pt(tip, aa, Rb);
            tan.set(rx * -Math.sin(aa) * -1, Math.cos(aa) * 0.85 * -1, rz * -Math.sin(aa) * -1);
            // полумесяц: толщина — от внутреннего края к внешнему
            kit.emit(blade);
            pt(tip, aa, Rb * 0.86); kit.emit(bladeCore);
          }
          pt(tip, a, Rb);
          if (tr) tr.push(tip);
          if (Math.random() < 0.5) kit.emit(mist);
          prevA = a;
        },
        end() {
          if (tr) tr.stop();
          // рассечённый воздух: всплеск тьмы у цели
          kit.flash(tgt, { color: P.core, size: [0.4, 2.2], dur: 0.18, intensity: 4, sprite: 'star', pull: 0.7, rival: R });
          kit.flash(tgt, { color: P.mid, size: [0.8, 3.0], dur: 0.45, intensity: 1.8, sprite: 'glow', pull: 0.7, rival: R });
          kit.emit({ at: tgt, count: 44, speed: [2.5, 8], life: [0.35, 0.8], size: [0.07, 0.015], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 3, drag: 1.6, rival: R, essential: true });
          kit.emit({ at: tgt, radius: 0.5, count: 18, speed: [0.5, 1.8], life: [1, 1.7], size: [0.7, 1.8], ramp: 'voidsmoke', alpha: 0.75, sprite: 'smoke', blend: 'alpha', drag: 1.2, gravity: -0.4, turb: 0.5, spin: [-1, 1], rival: R });
          decal(fx, tg, 'void', 2.4, 'void', R, { life: 7 });
          kit.light(tgt, { color: P.mid, intensity: 1.5, range: 12, dur: 0.5, attack: 0.03 });
          kit.shake(0.26); kit.hitstop(45);
          if (kit.distort) kit.distort(tgt, 0.5);
          au('burst', tgt);
          // души: из цели к груди заклинателя по изогнутым путям
          for (let i = 0; i < 5; i++) {
            const side = (i - 2) * 0.7 + (Math.random() - 0.5) * 0.3;
            const soul = { at: null, count: 1, speed: [0.1, 0.4], life: [0.25, 0.4], size: [0.32, 0.1], ramp, intensity: 2.6, sprite: 'wisp', rot: 0, drag: 2, rival: R, essential: true };
            const spark = { at: null, count: 1, radius: 0.08, speed: [0.2, 0.7], life: [0.3, 0.6], size: [0.05, 0.01], ramp, intensity: 2.8, sprite: 'spark', drag: 1.5, rival: R };
            kit.after(0.05 + i * 0.07, () => {
              fx.anchor('chest', c.chest, R);
              fly(fx, tgt, c.chest, 0.55 + Math.random() * 0.15, {
                lift: 1.0 + Math.random() * 0.6, side,
                ease: (x) => x * x * (3 - 2 * x),
                onStep(pos) { soul.at = pos; kit.emit(soul); spark.at = pos; if (Math.random() < 0.6) kit.emit(spark); },
                onHit(p) {
                  kit.flash(p, { color: P.hot, size: [0.15, 0.7], dur: 0.25, intensity: 2.4, sprite: 'glow', pull: 0.7, rival: R });
                  kit.emit({ at: p, count: 6, speed: [0.5, 1.6], life: [0.3, 0.6], size: [0.05, 0.01], ramp: R ? 'rival' : 'heal', intensity: 2.4, sprite: 'spark', drag: 2, gravity: -0.5, rival: R });
                },
              });
            });
          }
          afterglow(fx, tgt, 'void', R, { radius: 1.0, count: 20, dur: 1.6, sprite: 'wisp' });
        },
      });
    });
    au('cast', c.hand);
    return true;
  }, (d) => d.rune === 'vee');
}
