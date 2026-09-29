// ASHEN OATH — modules/fx/runesSky.js. Владелец: №7 [VFX].
// ★ СТЕЛЛА — звездопад и ⧗ КЛЕПСИДРА — остановленное время вокруг цели.
//
// СТЕЛЛА: круг-глиф со звездой под героем, знак у ладони, вспышка-сигнал в небо → в небе над целью
//   раскрывается РАЗЛОМ (фиолетово-золотой гекс-круг лицом к цели, светящаяся «трещина», водоворот искр,
//   фиолетовые разряды) и живёт ~1.4 с. Из пяти вершин звезды разлома по диагонали падают 5 метеоров:
//   раскалённое ядро + обломки, длинный хвост (GPU-частицы летят сами, по кадрам — только шлейф),
//   удар: кратер со светящимися краями, вспышка, искры, камни, пыль, волна, лёгкая тряска и хит-стоп.
//   Разлом ставится по камере (выше и дальше цели), чтобы он был В КАДРЕ у камеры за спиной героя;
//   ровно «над головой» цели на 12–15 м он оказался бы выше верхней кромки кадра.
//   combat.js шлёт rune_hit {index} в момент удара (0.25 + i·0.18 с): полёты запускаются при rune_cast и
//   приземляются чуть раньше; удар рисуется ОДИН раз — при посадке или по rune_hit (кто первый).
// КЛЕПСИДРА: знак-песочные часы у ладони, «капля времени» летит в цель → вокруг ядра цели
//   раскрывается пузырь времени: вертикальный циферблат (лицом к камере) со стрелками, бегущими НАЗАД,
//   циферблат на земле, вспышка-оболочка, песок сыплется медленно, пылинки замирают в воздухе,
//   холодный свет на цели. Пока snap.boss.slowed (в PvP — snap.opponent.slowed, иначе по таймеру
//   d.duration) — часы тикают, пылинки висят, оболочка мягко пульсирует; по окончании — часы гаснут,
//   пылинки «отмирают» и осыпаются. Старое кольцо замедления ('slow') подавлено.

import { caster, runeCircle, handGlyph, gather, muzzle, rampOf, clamp, TAU, isNum, hasVec } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const UP = { x: 0, y: 1, z: 0 }, DOWN = { x: 0, y: -1, z: 0 };
  const glyphOk = (h, gen) => !!h && h.alive === true && h.gen === gen;
  const spawnGlyph = (o) => { if (!fx.glyph) return null; try { return fx.glyph.spawn(o); } catch (e) { return null; } };
  const audio = (n, p) => { try { if (fx.legacy && typeof fx.legacy.audio === 'function') fx.legacy.audio(n, p); } catch (e) { /* ignore */ } };
  const isPlayerTarget = (remote) => {
    if (remote) return true;
    const s = fx.snap;
    return !!(s && (s.mode === 'pvp' || (s.lockTarget && s.lockTarget.kind === 'player')));
  };

  fx.suppress('slow');

  // ------------------------------------------------------------ камера
  const _cp = new V3(), _cf = new V3(), _cu = new V3(), _cr = new V3();
  function camBasis() {
    const cam = kit.camera;
    if (!cam || !cam.matrixWorld) return false;
    kit.cameraPos(_cp);
    const e = cam.matrixWorld.elements;
    _cf.set(-e[8], -e[9], -e[10]); _cu.set(e[4], e[5], e[6]); _cr.set(e[0], e[1], e[2]);
    if (_cf.lengthSq() < 1e-6 || _cu.lengthSq() < 1e-6) return false;
    _cf.normalize(); _cu.normalize(); _cr.normalize();
    return true;
  }

  // ============================================================ ★ СТЕЛЛА
  const N_MET = 5;
  // точки падения вокруг цели в осях «заклинатель → цель»: [вправо, вперёд]; вперёд < 0 — к заклинателю (видно)
  const LAND = [[-1.3, -0.9], [1.45, -0.55], [-0.25, -1.75], [1.95, 0.55], [-1.95, 0.35]];
  const landAt = (i) => 0.23 + i * 0.18;          // чуть раньше rune_hit (0.25 + i·0.18)
  const flightDur = (i) => 0.2 + i * 0.05;

  // переиспользуемые опции выбросов (мутируются перед каждым вызовом)
  const eHead = { at: null, vel: null, count: 1, speed: 0, life: 0.3, size: [0.9, 0.9], sizeVar: 0, color: 0xffe0a0, ramp: 'whiteHold', intensity: 3, sprite: 'glow', spin: 0, fadeIn: 0.02, essential: true, rival: false };
  const SPIN_ROCK = [-10, 10];
  const eTail = { at: null, vel: null, count: 1, speed: 0, life: 0.3, size: [0.3, 0.3], sizeVar: 0, color: 0xffe0a0, intensity: 3, sprite: 'streak', stretch: 0.05, fadeIn: 0.05, essential: true, rival: false };
  const ePuff = { at: null, shape: 'line', to: null, count: 1, speed: [0, 0.35], life: [0.28, 0.5], size: [0.55, 1.25], color: 0xffb070, intensity: 1.7, sprite: 'glow', fadeIn: 0.04, drag: 1.5, essential: true, rival: false };
  const eShed = { at: null, count: 1, speed: [1, 4], life: [0.3, 0.6], size: [0.07, 0.015], ramp: 'star', intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 6, drag: 1, rival: false };
  const eSmoke = { at: null, count: 1, speed: [0.1, 0.5], life: [0.6, 1.05], size: [0.55, 1.6], ramp: 'smoke', intensity: 1, alpha: 0.55, sprite: 'smoke', blend: 'alpha', drag: 1, turb: 0.3, spin: [-0.8, 0.8], rival: false };
  const eChunk = { at: null, count: 1, speed: [2, 5], life: [0.4, 0.8], size: [0.13, 0.08], color: 0xffb070, intensity: 2.6, sprite: 'debris', gravity: 9, drag: 0.6, spin: [-9, 9], rival: false };
  const _mp = new V3(), _mprev = new V3(), _v = new V3(), _n = new V3(), _t1 = new V3(), _t2 = new V3(), _q = new V3(), _q2 = new V3();

  const sess = { local: null, remote: null };

  /** Позиция разлома: выше и дальше цели вдоль взгляда камеры, в верхней трети кадра. */
  function riftPos(out, c) {
    const tg = c.targetGround;
    if (camBasis()) {
      _v.copy(_cf).addScaledVector(_cu, 0.35).normalize();       // ≈19° выше центра кадра
      const h = Math.hypot(_v.x, _v.z);
      const dT = (tg.x - _cp.x) * (_cf.x) + (tg.z - _cp.z) * (_cf.z);
      const D = Math.max(16, (isNum(dT) ? dT : 10) + 11);
      if (h > 0.25) {
        out.copy(_cp).addScaledVector(_v, D / h).addScaledVector(_cr, 1.3);
        out.y = clamp(out.y, tg.y + 7, tg.y + 14);
        return out;
      }
    }
    const sgn = c.remote ? -1 : 1;
    out.set(tg.x + c.fwd.x * 10 * sgn + c.right.x * 1.3, tg.y + 8.5, tg.z + c.fwd.z * 10 * sgn + c.right.z * 1.3);
    return out;
  }

  /** Удар метеора в точку земли g. s — масштаб (1 — Регент, меньше — у героя/соперника). */
  function impact(g, P, R, s, i) {
    const rival = R ? 1 : 0, ramp = rampOf('star', R);
    const gy = g.y;
    _q.set(g.x, gy + 0.45 * s, g.z);
    const fs = R ? 0.55 : 1;                       // у нашего героя (удар соперника) — вспышки меньше
    kit.flash(_q, { color: P.core, size: [0.4 * s * fs, 2.9 * s * fs], dur: 0.17, intensity: 4.5, sprite: 'star', pull: 0.6, rival: R });
    kit.flash(_q, { color: P.hot, size: [0.8 * s * fs, 3.4 * s * fs], dur: 0.36, intensity: 2.2, sprite: 'glow', pull: 0.6, rival: R });
    kit.flash(_q, { color: P.deep, size: [0.6 * s * fs, 4.4 * s * fs], dur: 0.3, intensity: 1.7, sprite: 'ring', pull: 0.4, rival: R });
    // искры и раскалённые обломки
    kit.emit({ at: _q, dir: UP, cone: 1.15, count: 24, speed: [3, 10], life: [0.3, 0.7], size: [0.075, 0.015], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.035, gravity: 9, drag: 1, ground: gy + 0.03, rival: R, essential: true });
    kit.emit({ at: _q, dir: UP, cone: 0.95, count: 7, speed: [3, 7], life: [0.6, 1.0], size: [0.17 * s, 0.13 * s], ramp: 'stone', intensity: 1, sprite: 'debris', blend: 'alpha', gravity: 13, drag: 0.4, spin: [-8, 8], ground: gy + 0.05, rival: R });
    kit.emit({ at: _q, dir: UP, cone: 1.0, count: 7, speed: [2.5, 6], life: [0.45, 0.85], size: [0.13, 0.06], color: P.mid, intensity: 2.8, sprite: 'debris', gravity: 11, drag: 0.5, spin: [-9, 9], ground: gy + 0.04, rival: R });
    // пыль кольцом по земле
    _q2.set(g.x, gy + 0.25, g.z);
    kit.emit({ at: _q2, shape: 'ring', radius: 0.45 * s, count: 6, radial: 2.4, speed: [0.1, 0.4], dir: UP, cone: 0.4, life: [1.0, 1.8], size: [0.9 * s, 2.3 * s], ramp: 'dust', intensity: 1, alpha: 0.8, sprite: 'smoke', blend: 'alpha', drag: 2, gravity: -0.35, spin: [-0.7, 0.7], rival: R });
    // ударная волна по земле
    _q2.set(g.x, gy + 0.06, g.z);
    if (fx.shock) {
      try { fx.shock.ring({ pos: _q2, normal: UP, r0: 0.2, r1: 3.2 * s, dur: 0.38, color: P.mid, hot: P.core, intensity: 1.8, thickness: 0.35, distort: 0.5, rival }); } catch (e) { /* ignore */ }
    }
    kit.emit({ at: _q2, shape: 'ring', radius: 0.3 * s, count: 14, radial: 7 * s, speed: [0, 0.3], dir: UP, cone: 0.15, life: [0.2, 0.4], size: [0.36 * s, 0.08], ramp, intensity: 2.6, sprite: 'ember', drag: 4.5, rival: R, essential: true });
    // кратер: раскалённые края
    let decal = null;
    if (fx.decals) {
      try { decal = fx.decals.spawn({ pos: { x: g.x, y: gy, z: g.z }, radius: 1.05 * s, kind: 'crater', life: 7, rot: Math.random() * TAU, color: P.mid, hot: P.hot, intensity: 1.8, rival }); } catch (e) { decal = null; }
    }
    if (!decal) {
      _q2.set(g.x, gy + 0.08, g.z);
      kit.emit({ at: _q2, shape: 'ring', radius: 0.62 * s, count: 11, speed: [0, 0.06], life: [1.2, 2.2], size: [0.16, 0.06], color: P.hot, intensity: 2.3, sprite: 'ember', ground: gy + 0.04, fadeIn: 0.02, rival: R });
    }
    kit.light(_q, { color: P.hot, intensity: 1.3, range: 10, dur: 0.35, attack: 0.03 });
    kit.shake(Math.min(0.18, 0.12 + 0.015 * i) * (R ? 0.8 : 1));
    kit.hitstop(25);
    if (i === N_MET - 1) audio('burst', _q);
  }

  function launchMeteor(S, i) {
    if (!S || S.dead) return;
    const P = S.P, R = S.R;
    const st = S.start[i], en = S.land[i], dur = S.fdur[i];
    const v = S.vel[i].subVectors(en, st).multiplyScalar(1 / dur);
    const sp = v.length() || 1;
    _n.copy(v).multiplyScalar(1 / sp);
    const life = dur / 0.7, sc = S.scale;
    // голова и хвосты: частицы летят сами (скорость на GPU), по кадрам — только шлейф
    eHead.rival = R; eHead.vel = v; eHead.life = life; eHead.at = st;
    eHead.sprite = 'glow'; eHead.size[0] = eHead.size[1] = 1.05 * sc; eHead.color = P.hot; eHead.intensity = 3; eHead.spin = 0;
    kit.emit(eHead);
    eHead.sprite = 'debris'; eHead.size[0] = eHead.size[1] = 0.46 * sc; eHead.color = P.mid; eHead.intensity = 3.4; eHead.spin = SPIN_ROCK;
    kit.emit(eHead);
    eHead.sprite = 'glow'; eHead.size[0] = eHead.size[1] = 0.36 * sc; eHead.color = undefined; eHead.ramp = 'whiteHold'; eHead.intensity = 5.5; eHead.spin = 0;
    kit.emit(eHead);
    eTail.rival = R; eTail.vel = v; eTail.life = life;
    eTail.stretch = 0.05; eTail.size[0] = eTail.size[1] = 0.3 * sc; eTail.color = P.hot; eTail.intensity = 3.4;
    eTail.at = _q.copy(st).addScaledVector(_n, -sp * eTail.stretch * 0.5);
    kit.emit(eTail);
    eTail.stretch = 0.105; eTail.size[0] = eTail.size[1] = 0.85 * sc; eTail.color = P.deep; eTail.intensity = 1.9;
    eTail.at = _q.copy(st).addScaledVector(_n, -sp * eTail.stretch * 0.5);
    kit.emit(eTail);
    // выход из разлома
    kit.flash(st, { color: P.hot, size: [0.5, 2.4], dur: 0.2, intensity: 3.2, sprite: 'star', pull: 0, rival: R });
    let tr = null;
    if (fx.trails) {
      try { tr = fx.trails.create({ width: 0.42 * sc, life: 0.36, color: P.mid, hot: P.core, intensity: 1.8, style: 'fire', maxPoints: 26, minDist: 0.25, rival: R ? 1 : 0 }); } catch (e) { tr = null; }
      if (tr && tr.push) { try { tr.push(st); } catch (e) { tr = null; } }
    }
    const prev = new V3().copy(st);
    let frame = 0;
    S.fly[i] = kit.actor({
      dur,
      update(t) {
        const k = Math.min(1, t / dur);
        _mp.lerpVectors(st, en, k);
        frame++;
        ePuff.rival = R; ePuff.color = P.mid; ePuff.at = prev; ePuff.to = _mp; ePuff.count = tr ? 1 : 2;
        kit.emit(ePuff);
        if (tr) { try { tr.push(_mp); } catch (e) { tr = null; } }
        if (frame % 2 === 0) { eShed.rival = R; eShed.ramp = rampOf('star', R); eShed.at = _mp; kit.emit(eShed); }
        if (frame % 3 === 1) { eSmoke.rival = R; eSmoke.at = prev; kit.emit(eSmoke); }
        if (frame % 4 === 2) { eChunk.rival = R; eChunk.color = P.mid; eChunk.at = _mp; kit.emit(eChunk); }
        prev.copy(_mp);
      },
      end() {
        S.fly[i] = null;
        if (tr) { try { tr.stop(); } catch (e) { /* ignore */ } }
        if (!S.done[i]) { S.done[i] = 1; impact(en, P, R, S.scale, i); }
      },
    });
    if (!S.fly[i]) { S.done[i] = 1; impact(en, P, R, S.scale, i); } // пул акторов полон — сразу удар
  }

  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, rival = c.rival;
    const P = fx.pal('star', d);
    const ramp = rampOf('star', R);
    // --- накопление у героя
    runeCircle(fx, c, 'stella', 'star', { radius: 1.8, dur: 1.9, spin: 0.7, motes: 20 });
    handGlyph(fx, c, 'stella', 'star', { radius: 0.42, dur: 0.5, spin: 3 });
    gather(fx, c.hand, 'star', R, { time: 0.12, radius: 0.8, count: 24, glow: 0.7, essential: true });
    kit.light(c.hand, { color: P.hot, intensity: 0.6, range: 5, dur: 0.3, attack: 0.5 });
    // сигнал в небо: золотой росчерк вверх из ладони
    kit.after(0.08, () => {
      kit.flash(c.hand, { color: P.core, size: [0.2, 1.0], dur: 0.16, intensity: 3.5, sprite: 'star', pull: 0.6, rival: R });
      kit.emit({ at: c.hand, dir: UP, cone: 0.04, count: 1, speed: [34, 40], life: [0.16, 0.2], size: [0.1, 0.05], ramp: ramp, intensity: 2.2, sprite: 'streak', stretch: 0.012, essential: true, rival: R }); // у камеры — тонкий росчерк, не столб
      kit.emit({ at: c.hand, dir: UP, cone: 0.55, count: 12, speed: [3, 8], life: [0.2, 0.45], size: [0.06, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, drag: 3, essential: true, rival: R });
    });

    // --- разлом в небе
    const rift = riftPos(new V3(), c);
    const n = new V3().subVectors(c.target, rift);
    if (n.lengthSq() < 1e-6) n.set(0, -1, 0);
    n.normalize();
    const t1 = new V3().crossVectors(n, _v.set(0, 1, 0));
    if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
    t1.normalize();
    const t2 = new V3().crossVectors(t1, n).normalize();
    const RR = 2.7;
    spawnGlyph({ pos: rift, normal: n, radius: RR, symbol: 'stella', symbolScale: 0.42, style: 'hex', color: P.deep, hot: P.hot, intensity: 2.3, dur: 1.5, unfold: 0.22, fade: 0.4, spin: 0.9, rings: 3, rival });
    const g2 = spawnGlyph({ pos: rift, normal: n, radius: RR * 0.58, style: 'rune', color: P.mid, hot: P.core, intensity: 1.9, dur: 1.35, unfold: 0.18, fade: 0.35, spin: -2.4, rings: 2, ticks: 20, rival });
    if (g2 && g2.flare) kit.after(0.05, () => g2.flare(1));
    kit.flash(rift, { color: P.deep, size: [3, 9.5], dur: 0.7, intensity: 1.7, sprite: 'glow', pull: 0, rival: R });
    kit.flash(rift, { color: P.hot, size: [1.0, 3.6], dur: 0.26, intensity: 3.0, sprite: 'star', pull: 0, rival: R });
    kit.flash(rift, { color: P.deep, size: [6.2, 7.4], dur: 1.45, intensity: 1.0, sprite: 'glow', pull: 0, fadeIn: 0.12, rival: R });
    kit.flash(rift, { color: P.hot, size: [2.0, 2.6], dur: 1.35, intensity: 2.0, sprite: 'glow', pull: 0, fadeIn: 0.1, rival: R });
    // светящаяся «трещина» поперёк разлома
    const ta = new V3().copy(rift).addScaledVector(t1, -RR * 0.78).addScaledVector(t2, 0.45);
    const tb = new V3().copy(rift).addScaledVector(t1, RR * 0.78).addScaledVector(t2, -0.45);
    kit.emit({ at: ta, shape: 'line', to: tb, count: 20, speed: [0, 0.12], life: [1.05, 1.35], size: [0.32, 0.18], ramp: 'whiteHold', intensity: 2.0, sprite: 'glow', fadeIn: 0.12, essential: true, rival: R });
    ta.lerp(rift, 0.5); tb.lerp(rift, 0.5);
    kit.emit({ at: ta, shape: 'line', to: tb, count: 8, speed: [0, 0.1], life: [1.0, 1.3], size: [1.3, 0.9], color: P.deep, intensity: 2.2, sprite: 'glow', fadeIn: 0.15, essential: true, rival: R });
    // водоворот искр, втягивающийся в разлом
    kit.emit({ at: rift, shape: 'ring', normal: n, radius: RR * 1.05, count: 34, radial: -2.4, tangent: 3.2, speed: [0, 0.2], life: [0.7, 1.1], size: [0.12, 0.03], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.05, delay: 0.95, rival: R });
    kit.emit({ at: rift, shape: 'disk', normal: n, radius: RR * 0.85, count: 16, radial: -0.6, tangent: 1.6, speed: [0, 0.1], life: [0.8, 1.3], size: [0.28, 0.05], ramp: R ? 'rival' : 'void', intensity: 2, sprite: 'dot', delay: 0.9, rival: R });
    if (fx.bolts) {
      for (let k = 0; k < 2; k++) {
        kit.after(0.05 + k * 0.45, () => {
          const a = Math.random() * TAU, b = a + 2 + Math.random() * 1.6;
          _q.copy(rift).addScaledVector(t1, Math.cos(a) * RR * 0.8).addScaledVector(t2, Math.sin(a) * RR * 0.8);
          _q2.copy(rift).addScaledVector(t1, Math.cos(b) * RR * 0.8).addScaledVector(t2, Math.sin(b) * RR * 0.8);
          try { fx.bolts.arc({ from: _q, to: _q2, color: P.deep, core: P.hot, dur: 0.22, rate: 26, intensity: 2.4, width: 0.05, rival }); } catch (e) { /* ignore */ }
        });
      }
    }
    // разлом схлопывается
    kit.after(1.3, () => {
      kit.emit({ at: rift, shape: 'shell', radius: RR * 0.9, count: 14, radial: -7, speed: [0, 0.2], life: [0.2, 0.32], size: [0.1, 0.03], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, rival: R });
      kit.flash(rift, { color: P.core, size: [2.2, 0.4], dur: 0.25, intensity: 3, sprite: 'star', pull: 0, rival: R });
    });

    // --- метеоры: вершины звезды разлома → точки вокруг цели
    const key = R ? 'remote' : 'local';
    if (sess[key]) sess[key].dead = true;
    const scale = isPlayerTarget(R) ? 0.72 : 1;
    const S = { t0: kit.clock, dead: false, R, P, scale, done: [0, 0, 0, 0, 0], fly: [null, null, null, null, null], start: [], land: [], vel: [], fdur: [] };
    sess[key] = S;
    for (let i = 0; i < N_MET; i++) {
      const a = -Math.PI / 2 + i * (TAU * 2 / 5);
      S.start.push(new V3().copy(rift).addScaledVector(t1, Math.cos(a) * RR * 0.55).addScaledVector(t2, -Math.sin(a) * RR * 0.55));
      const off = LAND[i];
      const lx = c.targetGround.x + (c.right.x * off[0] + c.fwd.x * off[1]) * scale;
      const lz = c.targetGround.z + (c.right.z * off[0] + c.fwd.z * off[1]) * scale;
      S.land.push(new V3(lx, fx.groundY(lx, lz, c.targetGround.y), lz));
      S.vel.push(new V3());
      const fd = flightDur(i);
      S.fdur.push(fd);
      kit.after(Math.max(0, landAt(i) - fd), () => launchMeteor(S, i));
    }
    audio('cast', c.hand);
    return true;
  }, (d) => !!d && d.rune === 'stella');

  // удар метеора: только если полёт этого индекса ещё не приземлился (дубли отсекаются)
  fx.on('rune_hit', (ev, d) => {
    const R = fx.isRemote(d);
    const idx = isNum(d.index) ? Math.max(0, Math.floor(d.index)) % N_MET : 0;
    const S = sess[R ? 'remote' : 'local'];
    if (S && !S.dead && kit.clock - S.t0 < 3.5) {
      if (S.done[idx]) return true;
      const a = S.fly[idx];
      if (a && a.alive && a.dur - a.t < 0.15) return true;   // вот-вот приземлится — удар нарисует посадка
      S.done[idx] = 1;   // полёт (если ещё идёт) долетит без повторного удара
      impact(S.land[idx], S.P, R, S.scale, idx);
      return true;
    }
    // каста не видели (сетевой пропуск): короткий росчерк с неба и удар
    const c = caster(fx, ev, d);
    const P = fx.pal('star', d);
    const g = new V3();
    const off = LAND[idx], sc = isPlayerTarget(R) ? 0.72 : 1;
    g.set(c.targetGround.x + (c.right.x * off[0] + c.fwd.x * off[1]) * sc, 0, c.targetGround.z + (c.right.z * off[0] + c.fwd.z * off[1]) * sc);
    g.y = fx.groundY(g.x, g.z, c.targetGround.y);
    _q.set(g.x + 1.5, g.y + 6, g.z - 2);
    kit.emit({ at: _q, vel: _v.set(-15, -60, 20), count: 1, speed: 0, life: 0.1, size: [0.4, 0.4], sizeVar: 0, color: P.hot, intensity: 3.4, sprite: 'streak', stretch: 0.05, essential: true, rival: R });
    impact(g, P, R, sc, idx);
    return true;
  }, (d) => !!d && d.rune === 'stella');

  // ============================================================ ⧗ КЛЕПСИДРА
  function makeBubble(remote) {
    return {
      remote, on: false, kind: 'boss', t: 0, dur: 5, seen: false, R: 2.4, center: new V3(), ground: new V3(),
      clock: null, clockGen: 0, gclock: null, gclockGen: 0, hands: 0, handV: 0, sandAcc: 0, moteAcc: 0,
      pulseT: 0, lightT: 0, respawnT: 0, pendingUntil: -1, P: fx.pal('time', null), ramp: 'time', sandRamp: 'reset',
      follow: null, followG: null,
    };
  }
  const bubL = makeBubble(false), bubR = makeBubble(true);
  bubL.follow = () => bubL.center; bubL.followG = () => bubL.ground;
  bubR.follow = () => bubR.center; bubR.followG = () => bubR.ground;

  /** Центр пузыря по снимку: ядро Регента / грудь соперника / грудь нашего героя. false — цели нет. */
  function bubTarget(b, snap) {
    if (b.kind === 'hero') {
      fx.anchor('chest', b.center, false);
      const pl = snap && snap.player;
      b.ground.set(b.center.x, fx.groundY(b.center.x, b.center.z, pl && hasVec(pl.position) ? pl.position.y : b.center.y - 1.25), b.center.z);
      return true;
    }
    const o = snap ? (b.kind === 'boss' ? snap.boss : snap.opponent) : null;
    if (!o || !hasVec(o.position)) return !snap;          // без снимка — оставляем последнюю точку
    const h = b.kind === 'boss' ? 2.6 : 1.25;
    b.center.set(o.position.x, o.position.y + h, o.position.z);
    b.ground.set(o.position.x, fx.groundY(o.position.x, o.position.z, o.position.y), o.position.z);
    return true;
  }
  function spawnClocks(b, unfold) {
    const P = b.P, rival = b.remote ? 1 : 0, hero = b.kind === 'hero';
    if (!glyphOk(b.clock, b.clockGen)) {
      b.clock = spawnGlyph({
        pos: b.center, normal: UP, billboard: true, radius: b.R, style: 'clock', color: P.mid, hot: P.core,
        intensity: hero ? 1.4 : 2.3, dur: 9999, unfold, fade: 0.6, spin: -0.7, rings: 3, hands: b.hands, rival, follow: b.follow,
      });
      b.clockGen = b.clock ? b.clock.gen : 0;
    }
    if (!glyphOk(b.gclock, b.gclockGen) && fx.Q.glyphDetail > 0) {
      b.gclock = spawnGlyph({
        pos: b.ground, normal: UP, radius: b.R * (hero ? 1.1 : 1.3), style: 'clock', color: P.deep, hot: P.hot,
        intensity: hero ? 1.1 : 1.5, dur: 9999, unfold: unfold * 1.3, fade: 0.8, spin: 0.35, rings: 2, hands: -b.hands * 0.5, rival, follow: b.followG,
      });
      b.gclockGen = b.gclock ? b.gclock.gen : 0;
    }
  }
  function startBubble(b, kind, dur, burst) {
    const fresh = !b.on || b.kind !== kind;
    if (b.on && b.kind !== kind) stopBubble(b, false);
    b.kind = kind; b.on = true; b.t = 0; b.dur = clamp(isNum(dur) ? dur : 5, 0.5, 30); b.seen = false;
    b.P = fx.pal('time', { remote: b.remote }); b.ramp = rampOf('time', b.remote); b.sandRamp = b.remote ? 'rival' : 'reset';
    b.R = kind === 'boss' ? 2.4 : (kind === 'opp' ? 1.5 : 1.2);
    b.handV = burst ? (fx.reduced() ? 6 : 16) : 4;
    b.pulseT = 0.5; b.lightT = burst ? 1.4 : 0; b.respawnT = 0;
    if (!bubTarget(b, fx.snap)) { b.on = false; return; }
    if (fresh) spawnClocks(b, burst ? 0.4 : 0.25);
    else {
      if (glyphOk(b.clock, b.clockGen) && b.clock.flare) b.clock.flare(1);
      if (glyphOk(b.gclock, b.gclockGen) && b.gclock.flare) b.gclock.flare(0.7);
    }
    if (burst) bubbleBurst(b);
  }
  function stopBubble(b, release) {
    if (!b.on) return;
    b.on = false;
    if (glyphOk(b.clock, b.clockGen) && b.clock.fadeOut) b.clock.fadeOut(0.7);
    if (glyphOk(b.gclock, b.gclockGen) && b.gclock.fadeOut) b.gclock.fadeOut(0.9);
    b.clock = null; b.gclock = null;
    if (!release) return;
    // время пошло: пылинки «отмирают» и осыпаются, оболочка лопается
    const P = b.P, R = b.remote, hero = b.kind === 'hero';
    kit.emit({ at: b.center, radius: b.R * 0.85, count: 18, speed: [0.4, 1.4], life: [0.5, 1.0], size: [0.07, 0.02], ramp: b.ramp, intensity: 2.4, sprite: 'dot', gravity: 2.8, drag: 0.5, ground: b.ground.y + 0.03, rival: R });
    if (!hero) kit.flash(b.center, { color: P.hot, size: [b.R * 2.5, b.R * 3.1], dur: 0.4, intensity: 1.3, sprite: 'ring', pull: 0, rival: R });
    kit.flash(b.center, { color: P.core, size: [0.3, hero ? 0.9 : 1.6], dur: 0.2, intensity: 2.4, sprite: 'star', pull: hero ? 0.7 : 0.4, rival: R });
  }
  /** Раскрытие пузыря (удар «капли времени»). */
  function bubbleBurst(b) {
    const P = b.P, R = b.remote, rival = R ? 1 : 0, hero = b.kind === 'hero', rr = b.R, cc = b.center;
    const fs = hero ? 0.45 : 1;
    kit.flash(cc, { color: P.core, size: [0.6 * fs, 3.4 * fs], dur: 0.24, intensity: 3.4, sprite: 'star', pull: hero ? 0.7 : 0.6, rival: R });
    kit.flash(cc, { color: P.hot, size: [1.5 * fs, 5.2 * fs], dur: 0.5, intensity: 1.5, sprite: 'glow', pull: hero ? 0.7 : 0.6, rival: R });
    if (!hero) kit.flash(cc, { color: P.mid, size: [0.8, rr * 2.56], dur: 0.45, intensity: 2.2, sprite: 'ring', pull: 0, rival: R });
    if (fx.shock) {
      try { fx.shock.sphere({ pos: cc, r0: 0.3, r1: rr, dur: 0.45, color: P.mid, hot: P.core, intensity: 1.3, distort: 0.6, rival }); } catch (e) { /* ignore */ }
      try { fx.shock.ring({ pos: { x: b.ground.x, y: b.ground.y + 0.05, z: b.ground.z }, normal: UP, r0: 0.4, r1: rr * 2.2, dur: 0.6, color: P.mid, hot: P.core, intensity: 1.6, rival }); } catch (e) { /* ignore */ }
    }
    // «время замерло»: пылинки разлетаются и повисают (очень сильное сопротивление)
    kit.emit({ at: cc, shape: 'sphere', radius: rr * 0.9, count: hero ? 26 : 46, radial: 2.2, speed: [0.2, 1.2], drag: 7, life: [2.2, 3.4], size: [0.075, 0.055], ramp: b.ramp, intensity: 2.3, sprite: 'dot', fadeIn: 0.04, rival: R, essential: true });
    kit.emit({ at: cc, shape: 'shell', radius: rr * 0.97, count: hero ? 12 : 24, speed: [0.3, 0.9], drag: 9, life: [1.6, 2.6], size: [0.13, 0.08], ramp: b.ramp, intensity: 2.6, sprite: 'star', spin: [-0.4, 0.4], fadeIn: 0.05, rival: R });
    // песок сыплется сверху
    _q.set(cc.x, cc.y + rr * 0.72, cc.z);
    kit.emit({ at: _q, shape: 'disk', normal: UP, radius: rr * 0.7, count: hero ? 14 : 26, dir: DOWN, cone: 0.15, speed: [0.2, 0.6], gravity: 0.8, drag: 0.3, life: [1.8, 2.6], size: [0.05, 0.035], ramp: b.sandRamp, intensity: 2, sprite: 'dot', delay: 1.1, rival: R });
    // кольцо «ряби времени» по земле
    _q.set(b.ground.x, b.ground.y + 0.08, b.ground.z);
    kit.emit({ at: _q, shape: 'ring', radius: rr * 0.5, count: hero ? 12 : 22, radial: rr * 2.4, speed: [0, 0.2], dir: UP, cone: 0.2, life: [0.35, 0.6], size: [0.26, 0.05], ramp: b.ramp, intensity: 2.4, sprite: 'spark', stretch: 0.025, drag: 3.5, rival: R, essential: true });
    kit.light(cc, { color: P.hot, intensity: 1.4, range: 9, dur: 1.5, attack: 0.12 });
    kit.shake(hero ? 0.06 : 0.1);
    audio('nova', cc);
  }

  // «капля времени»: из ладони в цель
  const eDrop = { at: null, vel: null, count: 1, speed: 0, life: 0.3, size: [0.3, 0.3], sizeVar: 0, color: undefined, ramp: 'whiteHold', intensity: 4, sprite: 'glow', essential: true, rival: false };
  const eDropTrail = { at: null, shape: 'line', to: null, count: 2, speed: [0.05, 0.3], life: [0.35, 0.6], size: [0.09, 0.03], ramp: 'time', intensity: 2.4, sprite: 'dot', drag: 2, gravity: 0.6, essential: true, rival: false };
  const _dp = new V3();
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('time', d);
    const ramp = rampOf('time', R);
    const b = R ? bubR : bubL;
    const kind = R ? 'hero' : (isPlayerTarget(false) ? 'opp' : 'boss');
    const dur = isNum(d.duration) ? d.duration : 5;
    runeCircle(fx, c, 'clepsydra', 'time', { radius: 1.8, dur: 2.0, spin: -0.6, motes: 20 });
    handGlyph(fx, c, 'clepsydra', 'time', { radius: 0.42, dur: 0.55, spin: -2.6, style: 'clock' });
    gather(fx, c.hand, 'time', R, { time: 0.14, radius: 0.8, count: 26, glow: 0.65, essential: true });
    kit.light(c.hand, { color: P.hot, intensity: 0.6, range: 5, dur: 0.35, attack: 0.5 });
    b.pendingUntil = kit.clock + 0.5;
    const tgt = new V3().copy(c.target);
    if (!b.on) { b.center.copy(tgt); b.ground.copy(c.targetGround); }
    kit.after(0.14, () => {
      muzzle(fx, c.hand, c.dir, 'time', R, { size: 0.8, count: 14 });
      const fd = Math.min(0.26, 0.1 + c.dist / 40);
      const v = new V3().subVectors(tgt, c.hand).multiplyScalar(1 / fd);
      const from = new V3().copy(c.hand), prev = new V3().copy(c.hand);
      eDrop.at = from; eDrop.vel = v; eDrop.life = fd / 0.7; eDrop.rival = R;
      eDrop.size[0] = eDrop.size[1] = 0.3; eDrop.color = undefined; eDrop.intensity = 4.2;
      kit.emit(eDrop);
      eDrop.size[0] = eDrop.size[1] = 0.75; eDrop.color = P.mid; eDrop.intensity = 2.2;
      kit.emit(eDrop);
      kit.actor({
        dur: fd,
        update(t) {
          _dp.lerpVectors(from, tgt, Math.min(1, t / fd));
          eDropTrail.at = prev; eDropTrail.to = _dp; eDropTrail.ramp = ramp; eDropTrail.rival = R;
          kit.emit(eDropTrail);
          prev.copy(_dp);
        },
        end() {
          b.pendingUntil = -1;
          startBubble(b, kind, Math.max(0.5, dur - 0.14 - fd), true);
        },
      });
    });
    audio('cast', c.hand);
    return true;
  }, (d) => !!d && d.rune === 'clepsydra');

  // пузырь по снимку: пока цель замедлена — часы тикают назад, песок сыплется, пылинки висят
  const eSand = { at: null, shape: 'disk', normal: UP, radius: 1, count: 1, dir: DOWN, cone: 0.15, speed: [0.15, 0.5], gravity: 0.8, drag: 0.3, life: [1.8, 2.6], size: [0.05, 0.035], ramp: 'reset', intensity: 2, sprite: 'dot', essential: true, rival: false };
  const eMote = { at: null, shape: 'sphere', radius: 1, count: 1, radial: 0.8, speed: [0.1, 0.6], drag: 7, life: [1.6, 2.6], size: [0.07, 0.05], ramp: 'time', intensity: 2.3, sprite: 'dot', fadeIn: 0.2, essential: true, rival: false };
  const eTwinkle = { at: null, shape: 'sphere', radius: 1, count: 1, speed: [0, 0.1], drag: 5, life: [0.7, 1.1], size: [0.16, 0.05], ramp: 'time', intensity: 2.8, sprite: 'star', fadeIn: 0.3, spin: [-0.3, 0.3], essential: true, rival: false };
  const _set = { hands: 0 }, _setG = { hands: 0 };
  const _top = new V3();
  function tickBubble(b, dt, snap) {
    if (!b.on) return;
    b.t += dt;
    let flag = false;
    if (snap) {
      if (b.kind === 'boss') { flag = !!(snap.boss && snap.boss.slowed) && snap.mode !== 'pvp'; if (snap.mode === 'pvp') { stopBubble(b, false); return; } }
      else if (b.kind === 'opp') flag = !!(snap.opponent && snap.opponent.slowed);
    }
    if (flag) b.seen = true;
    const over = b.seen ? (!flag && b.t > 0.25) : b.t >= b.dur;
    if (over || b.t > 60) { stopBubble(b, true); return; }
    if (!bubTarget(b, snap)) { stopBubble(b, false); return; }
    // часы потеряны (пул глифов переполнен/очищен) — вернуть без развёртки, не чаще раза в 0.5 с
    b.respawnT -= dt;
    if ((!glyphOk(b.clock, b.clockGen) || (fx.Q.glyphDetail > 0 && !glyphOk(b.gclock, b.gclockGen))) && b.respawnT <= 0) { b.respawnT = 0.5; spawnClocks(b, 0.05); }
    // стрелки бегут назад: быстро после каста, затем ровный обратный ход
    const cruise = fx.reduced() ? 1.2 : 2.4;
    b.handV += (cruise - b.handV) * (1 - Math.exp(-dt * 1.4));
    b.hands -= b.handV * dt;
    if (b.hands < -1e4) b.hands %= TAU * 12;
    if (glyphOk(b.clock, b.clockGen)) { _set.hands = b.hands; b.clock.set(_set); }
    if (glyphOk(b.gclock, b.gclockGen)) { _setG.hands = -b.hands * 0.5; b.gclock.set(_setG); }
    const R = b.remote, rr = b.R, hero = b.kind === 'hero';
    // песок (~8/с) и замершие пылинки (~5/с), изредка — звёздочка-блик
    b.sandAcc += dt * (hero ? 5 : 8);
    if (b.sandAcc >= 1) {
      const n = Math.min(3, Math.floor(b.sandAcc)); b.sandAcc -= n;
      _top.set(b.center.x, b.center.y + rr * 0.72, b.center.z);
      eSand.at = _top; eSand.radius = rr * 0.7; eSand.count = n; eSand.ramp = b.sandRamp; eSand.rival = R;
      kit.emit(eSand);
    }
    b.moteAcc += dt * (hero ? 3 : 5);
    if (b.moteAcc >= 1) {
      const n = Math.min(3, Math.floor(b.moteAcc)); b.moteAcc -= n;
      eMote.at = b.center; eMote.radius = rr * 0.92; eMote.count = n; eMote.ramp = b.ramp; eMote.rival = R;
      kit.emit(eMote);
      if (Math.random() < 0.35) { eTwinkle.at = b.center; eTwinkle.radius = rr * 0.95; eTwinkle.ramp = b.ramp; eTwinkle.rival = R; kit.emit(eTwinkle); }
    }
    // оболочка пузыря мягко «дышит» (у нашего героя — без большого кольца у камеры)
    b.pulseT -= dt;
    if (b.pulseT <= 0 && !hero) {
      b.pulseT = 1.3;
      kit.flash(b.center, { color: b.P.mid, size: [rr * 2.5, rr * 2.62], dur: 1.25, intensity: fx.reduced() ? 0.7 : 1.0, sprite: 'ring', pull: 0, fadeIn: 0.4, curve: 1, rival: R });
    }
    // холодный свет на цели
    b.lightT -= dt;
    if (b.lightT <= 0) {
      b.lightT = 1.7;
      kit.light(b.center, { color: b.P.hot, intensity: hero ? 0.5 : 0.85, range: 8, dur: 1.8, attack: 0.45, follow: b.follow });
    }
  }
  fx.every((dt, snap) => {
    if (!(dt > 0)) return;
    // замедление без нашего каста (например, пропущено событие) — пузырь по снимку, без вспышки
    if (!bubL.on && snap && kit.clock > bubL.pendingUntil) {
      if (snap.mode !== 'pvp' && snap.boss && snap.boss.slowed) startBubble(bubL, 'boss', snap.boss.slowRemaining, false);
      else if (snap.mode === 'pvp' && snap.opponent && snap.opponent.slowed) startBubble(bubL, 'opp', 5, false);
      if (bubL.on) bubL.seen = true;
    }
    tickBubble(bubL, dt, snap);
    tickBubble(bubR, dt, snap);
  });
}
