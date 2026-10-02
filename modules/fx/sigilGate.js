// ASHEN OATH — modules/fx/sigilGate.js. Владелец: №7 [VFX]. [W3-МАГИЯ]
// «Врата бури» (sigil_cast gate): разрыв пространства, стена огня и молний к Регенту, горящий след, купол бастиона.
//  - разрыв: в точке сгустка (fx.shared.sigil.pos, иначе грудь) — горизонтальная щель-вспышка поперёк направления
//    на цель, рваные края из искр бури и белого света, вертикальная волна, короткая вспышка экрана, свет, тряска;
//  - стена: актор катит фронт по земле от героя к цели со скоростью d.speed (16 м/с), шириной d.width (3.5 м):
//    языки пламени, угли, дым, треск дуг fx.bolts вдоль фронта; позади — цепочка декалей scorch/crack с догорающим огнём;
//  - приход (d.reach !== false) через d.eta — удар: волна по земле, огненный всплеск, разряды, кратер, свет;
//    промах (дальше 26 м) — стена рассеивается дымом и углями на 26 м;
//  - купол бастиона: hex-купол ведёт sigils.js по снимку (второй hex не создаём — пул 4); здесь только слои вокруг:
//    вспышка раскрытия, искры бегут вверх по сфере, медленное золотое кольцо у земли (всё по fx.every, без аллокаций).
// Соперник (data.remote): палитра rival, цель — грудь нашего героя, удар/рассеяние по своим таймерам.
// fx.shared.gateCastAt — момент своего каста: domeTick в sigils.js откладывает раскрытие купола на +0.4 с.
// [W4-ЗАКЛИНАНИЯ] цвет — стихия героя (fx.heroEl, таблица LOOKS): волна — пламя стихии, молнии — белое ядро + тон молний;
// огонь — огненная волна и бело-золотые молнии, тьма — фиолетовая волна с чёрной кромкой; купол — тоже в цвете героя.

import { caster, clamp, TAU, isNum } from './common.js';

const RANGE = 26;          // дальность волны (combat.js: range 26 м; в data её нет)
const DOME_R = 1.55;       // радиус купола (sigils.js domeState.radius)

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const UP = { x: 0, y: 1, z: 0 };
  const DOWN = { x: 0, y: -1, z: 0 };
  const num = (v, f) => (isNum(v) ? v : f);
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const lights = () => (kit.Q && isNum(kit.Q.lights) ? kit.Q.lights : 0);
  const qName = () => (kit.Q && kit.Q.name) || 'medium';
  const soft = () => (fx.reduced() ? 0.6 : 1);
  if (!isNum(fx.shared.gateCastAt)) fx.shared.gateCastAt = -1e9;

  // ---------------------------------------------------------------- предвыделенные опции фронта (мутируются в кадре)
  const emFire = { at: new V3(), shape: 'line', to: new V3(), radius: 0.15, count: 1, dir: UP, cone: 0.3, speed: [2.6, 5.6], vel: new V3(),
    life: [0.28, 0.5], size: [0.95, 0.35], sizeVar: 0.35, curve: 0.8, ramp: 'fire', intensity: 2.4, sprite: 'flame', rot: 0,
    drag: 2.2, gravity: -1.2, turb: 0.5, essential: true, rival: false };
  const emFlame = { at: new V3(), shape: 'line', to: new V3(), radius: 0.1, count: 1, dir: UP, cone: 0.2, speed: [4.5, 8], vel: new V3(),
    life: [0.22, 0.36], size: [0.6, 0.18], sizeVar: 0.3, ramp: 'flame', intensity: 2.8, sprite: 'flame', rot: 0,
    drag: 2.6, gravity: -0.6, essential: true, rival: false };
  const emBase = { at: new V3(), shape: 'line', to: new V3(), radius: 0.05, count: 1, speed: [0, 0.3], life: [0.08, 0.14],
    size: [0.7, 0.45], sizeVar: 0.2, ramp: 'whiteHold', intensity: 2.2, sprite: 'glow', fadeIn: 0.15, essential: true, rival: false };
  const emEmber = { at: new V3(), shape: 'line', to: new V3(), radius: 0.2, count: 1, dir: UP, cone: 0.6, speed: [3, 8], vel: new V3(),
    life: [0.4, 0.9], size: [0.06, 0.012], ramp: 'ember', intensity: 2.8, sprite: 'spark', stretch: 0.03, gravity: 4, drag: 1,
    essential: true, rival: false };
  const emSmoke = { at: new V3(), shape: 'line', to: new V3(), radius: 0.3, count: 1, dir: UP, cone: 0.4, speed: [0.8, 1.8],
    life: [0.9, 1.5], size: [0.9, 2.2], sizeVar: 0.3, sprite: 'smoke', blend: 'alpha', ramp: 'firesmoke', intensity: 1, alpha: 0.5,
    drag: 1.2, gravity: -0.6, turb: 0.5, spin: [-0.6, 0.6], fadeIn: 0.2, essential: true, rival: false };
  const emStorm = { at: new V3(), shape: 'line', to: new V3(), radius: 0.6, count: 1, speed: [1, 4], life: [0.1, 0.22],
    size: [0.05, 0.01], ramp: 'storm', intensity: 3, sprite: 'spark', stretch: 0.04, drag: 3, essential: true, rival: false };
  // догорающий след: огоньки над декалью с разбросом старта (одна партия на звено — кадр не нагружает)
  const emBurn = { at: new V3(), shape: 'disk', radius: 1, normal: UP, count: 6, dir: UP, cone: 0.25, speed: [0.6, 1.6],
    life: [0.4, 0.8], size: [0.55, 0.15], ramp: 'flame', intensity: 1.8, sprite: 'flame', rot: 0, delay: 1.4, drag: 1,
    gravity: -0.8, rival: false };
  const arcO = { from: new V3(), to: new V3(), color: E.storm.mid, core: E.storm.core, width: 0.035, jitter: 0.32, segments: 10,
    dur: 0.16, rate: 30, intensity: 2.6, lift: 0.2, rival: 0 };
  const decO = { pos: new V3(), radius: 1.4, kind: 'scorch', life: 6, rot: 0, color: E.fire.mid, hot: E.fire.core, intensity: 1.2, rival: 0 };
  const _a = new V3(), _b = new V3();

  // [W4-ЗАКЛИНАНИЯ] вид врат по стихии героя: P — волна (декали, кольца, свет), Z — молнии (дуги, искры, трещины);
  // строки градиентов волны/языков/углей/молний/дыма/кромки и тон экранной вспышки (разрыв, удар).
  // Огонь: огненная волна + бело-золотые молнии; гроза/ветер/буря — своя стихия в обоих слоях; тьма — кромка
  // darkcore (blend alpha) поверх фиолетового пламени — чёрное ядро волны. Соперник — палитра rival, как раньше.
  const ZAP_FIRE = Object.freeze({ core: 0xffffff, hot: 0xfff3d6, mid: 0xffd28a, deep: 0xe8a14a, smoke: 0x2a2018 });
  const look = (P, Z, wave, flame, ember, zap, smoke, base, scrRip, scrHit) =>
    Object.freeze({ P, Z, wave, flame, ember, zap, smoke, base, baseBlend: base === 'darkcore' ? 'alpha' : 'add', scrRip, scrHit });
  const LOOKS = {
    fire:    look(E.fire, ZAP_FIRE, 'fire', 'flame', 'ember', 'gold', 'firesmoke', 'whiteHold', 0xfff0d8, 0xff8a3a),
    storm:   look(E.storm, E.storm, 'storm', 'storm', 'storm', 'storm', 'frostsmoke', 'whiteHold', 0xcfe8ff, 0x8ec8ff),
    void:    look(E.void, E.void, 'void', 'void', 'void', 'void', 'voidsmoke', 'darkcore', 0xd8c0ff, 0x9a5cff),
    wind:    look(E.wind, E.wind, 'wind', 'wind', 'wind', 'wind', 'dust', 'whiteHold', 0xd0ffe8, 0x3ee0a0),
    tempest: look(E.tempest, E.tempest, 'tempest', 'tempest', 'tempest', 'tempest', 'smoke', 'whiteHold', 0xc8dcff, 0x4a8cff),
    rival:   look(E.rival, E.rival, 'rival', 'rival', 'rival', 'rival', 'voidsmoke', 'rival', 0x9a6bff, 0x9a6bff),
  };
  const lookOf = (d) => LOOKS[fx.heroEl(d)] || LOOKS.fire;

  // ---------------------------------------------------------------- ⛩ ВРАТА: разрыв, стена, удар
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, r01 = R ? 1 : 0;
    const power = clamp(num(d.power, 0.6), 0, 1);
    const s = 0.45 + 0.55 * power;          // множитель силы для количеств и размеров
    const sf = soft(), q = qName(), low = q === 'low';
    const LK = lookOf(d);                                   // [W4-ЗАКЛИНАНИЯ] стихия героя (соперник — rival)
    const PF = LK.P, PS = LK.Z;
    const rFire = LK.wave, rFlame = LK.flame, rEmber = LK.ember;
    const rStorm = LK.zap, rSmoke = LK.smoke;
    if (!R) fx.shared.gateCastAt = kit.clock;

    // цель: свой — d.to/Регент (caster), соперник — грудь нашего героя
    if (R) {
      fx.target(c.target, true);
      c.fwd.set(c.target.x - c.feet.x, 0, c.target.z - c.feet.z);
      if (c.fwd.lengthSq() < 1e-6) c.fwd.set(0, 0, -1);
      c.fwd.normalize();
      c.right.set(-c.fwd.z, 0, c.fwd.x);
    }
    const tgt = c.target;
    const tgtG = new V3(tgt.x, fx.groundY(tgt.x, tgt.z, c.feet.y), tgt.z);

    // точка разрыва: свежий сгусток (sigilCharge.js) или грудь + чуть вперёд
    const S = fx.shared.sigil;
    const rp = new V3();
    if (!R && S && S.pos && isNum(S.t) && kit.clock - S.t < 0.6 && S.pos.distanceTo(c.chest) < 1.2) rp.copy(S.pos);
    else rp.copy(c.chest).addScaledVector(c.fwd, 0.4);

    // ---------------- 1. разрыв пространства
    const half = 0.9 + 0.9 * s;
    const ra = new V3().copy(rp).addScaledVector(c.right, -half), rb = new V3().copy(rp).addScaledVector(c.right, half);
    if (fx.bolts) {
      fx.bolts.strike({ from: ra, to: rb, color: PS.mid, core: PS.core, width: 0.12 + 0.1 * s, jitter: 0.03, branches: 0, segments: 12,
        flicker: false, star: false, origin: false, dur: 0.32, intensity: 4 * sf, lift: 0.3, rival: r01, seed: (Math.random() * 1e6) | 0 });
      if (!low) fx.bolts.strike({ from: rb, to: ra, color: PS.mid, core: PS.core, width: 0.04, jitter: 0.2, branches: 3, segments: 14,
        dur: 0.28, intensity: 3 * sf, lift: 0.32, origin: false, rival: r01, seed: (Math.random() * 1e6) | 0 });
    }
    // щель — вытянутая вспышка, повёрнутая по проекции «вправо» на экран
    let rot = 0;
    const cam = kit.camera;
    if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;
      rot = Math.atan2(c.right.x * e[4] + c.right.y * e[5] + c.right.z * e[6], c.right.x * e[0] + c.right.y * e[1] + c.right.z * e[2]);
    }
    // [W4-ЗАКЛИНАНИЯ] ярче для проектора: белое ядро щели, звезда молний, ореол волны
    kit.flash(rp, { ramp: 'whiteHold', size: [half * 1.6, half * 2.6], curve: 0.4, dur: 0.24, intensity: 4.5 * sf, sprite: 'streak', rot, pull: 0.4, rival: R });
    kit.flash(rp, { ramp: rStorm, size: [0.6, 2.2 + 1.2 * s], dur: 0.22, intensity: 3.6 * sf, sprite: 'star', pull: 0.45, rival: R });
    kit.flash(rp, { ramp: rFire, size: [1.0, 2.6 * s], dur: 0.35, intensity: 2 * sf, sprite: 'glow', pull: 0.3, rival: R });
    // рваные края: искры бури и белые штрихи разлетаются от щели, створки «разъезжаются» вверх и вниз
    kit.emit({ at: ra, shape: 'line', to: rb, radius: 0.04, count: Math.round(70 * s), speed: [1.5, 5], life: [0.12, 0.3], size: [0.06, 0.012],
      ramp: rStorm, intensity: 3, sprite: 'spark', stretch: 0.04, drag: 3, rival: R });
    _a.copy(ra).addScaledVector(UP, 0.05); _b.copy(rb).addScaledVector(UP, 0.05);
    kit.emit({ at: _a, shape: 'line', to: _b, count: Math.round(30 * s), dir: UP, cone: 0.25, speed: [1.5, 3.5], life: [0.1, 0.2], size: [0.08, 0.02],
      ramp: 'white', intensity: 3, sprite: 'spark', stretch: 0.03, drag: 4, rival: R });
    _a.copy(ra).addScaledVector(UP, -0.05); _b.copy(rb).addScaledVector(UP, -0.05);
    kit.emit({ at: _a, shape: 'line', to: _b, count: Math.round(30 * s), dir: DOWN, cone: 0.25, speed: [1.5, 3.5], life: [0.1, 0.2], size: [0.08, 0.02],
      ramp: 'white', intensity: 3, sprite: 'spark', stretch: 0.03, drag: 4, rival: R });
    kit.emit({ at: ra, shape: 'line', to: rb, radius: 0.08, count: Math.round(22 * s), dir: UP, cone: 0.5, speed: [0.6, 2], life: [0.22, 0.4],
      size: [0.45, 0.12], ramp: rFire, intensity: 2.4, sprite: 'flame', rot: 0, drag: 2, gravity: -1, rival: R });
    if (fx.shock && !low) {
      fx.shock.ring({ pos: rp, normal: c.fwd, r0: 0.2, r1: 1.6 + 1.2 * s, dur: 0.35, wall: 0, dustAmount: 0, thickness: 0.25, distort: 0.6,
        color: PS.mid, hot: PS.core, intensity: 1.8, rival: r01 });
    }
    kit.screenFlash(LK.scrRip, 0.12 * (0.6 + 0.4 * power) * sf, 0.1);   // [W4-ЗАКЛИНАНИЯ] тон молний героя
    if (lights() > 0) kit.light(rp, { color: PS.hot, intensity: 1.2, range: 10, dur: 0.45, attack: 0.08 });
    kit.shake(R ? 0.05 : 0.06 + 0.14 * power);
    if (!R) kit.kick(c.fwd, 0.015);

    // ---------------- 2. стена огня и молний
    const speed = Math.max(1, num(d.speed, 16));
    const width = clamp(num(d.width, 3.5), 0.5, 8);
    const reach = d.reach !== false;
    const start = new V3().copy(c.feet).addScaledVector(c.fwd, 0.7);
    start.y = fx.groundY(start.x, start.z, c.feet.y);
    const distG = Math.hypot(tgtG.x - start.x, tgtG.z - start.z);
    let L, T;
    if (reach) {
      L = Math.max(0.5, distG - 0.6);
      T = isNum(d.eta) && d.eta > 0 ? d.eta : distG / speed;
    } else {
      L = Math.max(0.5, RANGE - 0.7);
      T = RANGE / speed;
    }
    T = clamp(T, 0.08, 2.6);
    const tail = reach ? 0.05 : 0.35;
    const nDecMax = q === 'high' ? 14 : q === 'medium' ? 8 : 4;
    const W = {
      R, r01, s, sf, low, q, L, T, reach, half: width * 0.5, vf: L / T,
      start, fwd: c.fwd.clone(), right: c.right.clone(), tgtG, front: new V3().copy(start),
      stepD: Math.max(1.2, L / nDecMax), nextD: 0.6, nDec: 0, nDecMax,
      accFire: 0, accFlame: 0, accBase: 0, accEmber: 0, accSmoke: 0, accStorm: 0, arcT: kit.clock + 0.03,
      rFire, rFlame, rEmber, rStorm, rSmoke, PF, PS, LK,
    };
    W.nextD = Math.min(W.stepD * 0.5, 1.2);
    kit.actor({ dur: Math.min(3, T + tail), update: (t, k, dt) => stepWall(W, t, dt) });
    // свет, бегущий с фронтом (только на high: на medium единственный слот нужен разрыву и удару)
    if (lights() >= 2) {
      kit.after(0.1, () => { kit.light(W.front, { color: PF.hot, intensity: 0.9, range: 9, dur: Math.max(0.2, T - 0.1), attack: 0.2, follow: () => W.front }); });
    }
    kit.after(T, () => (reach ? impact(W, tgt, power) : dissipate(W)));
    return true;
  }, (d) => d && d.sigil === 'gate');

  // фронт стены: точка на земле в момент t; эмиссия по аккумуляторам (dt может быть ≈0)
  function stepWall(W, t, dt) {
    const kt = Math.min(1, t / W.T);
    const dd = W.L * kt;
    const x = W.start.x + W.fwd.x * dd, z = W.start.z + W.fwd.z * dd;
    W.front.set(x, fx.groundY(x, z, W.start.y + (W.tgtG.y - W.start.y) * kt), z);
    // декали — цепочкой позади фронта
    while (dd >= W.nextD && W.nDec < W.nDecMax) { burnMark(W, W.nextD); W.nextD += W.stepD; }
    if (!(dt > 0)) return true;
    let g = 1;                                         // стена вырастает за 0.12 с, на промахе гаснет в хвосте
    if (t < 0.12) g = 0.35 + 0.65 * (t / 0.12);
    if (t > W.T) { if (W.reach) return true; g = Math.max(0, 1 - (t - W.T) / 0.35); }
    if (g <= 0) return true;
    const dec = decor(), m = W.s * g;
    const hx = W.right.x * W.half, hz = W.right.z * W.half;
    const fy = W.front.y + 0.05;
    const fw = W.vf * 0.55;                            // огонь «несётся» вперёд вместе с фронтом
    // языки пламени
    W.accFire += dt * 240 * dec * m;
    let n = Math.floor(W.accFire);
    if (n > 0) {
      W.accFire -= n;
      emFire.at.set(x - hx, fy, z - hz); emFire.to.set(x + hx, fy, z + hz);
      emFire.vel.set(W.fwd.x * fw, 0, W.fwd.z * fw);
      emFire.count = n; emFire.ramp = W.rFire; emFire.rival = W.R; emFire.intensity = 2.4 * W.sf;
      emFire.speed[0] = 2.2 + 1.2 * W.s; emFire.speed[1] = 4.2 + 2.2 * W.s;
      kit.emit(emFire);
    }
    // яркие острые языки по центру стены
    W.accFlame += dt * 110 * dec * m;
    n = Math.floor(W.accFlame);
    if (n > 0) {
      W.accFlame -= n;
      emFlame.at.set(x - hx * 0.7, fy, z - hz * 0.7); emFlame.to.set(x + hx * 0.7, fy, z + hz * 0.7);
      emFlame.vel.set(W.fwd.x * fw, 0, W.fwd.z * fw);
      emFlame.count = n; emFlame.ramp = W.rFlame; emFlame.rival = W.R; emFlame.intensity = 2.8 * W.sf;
      kit.emit(emFlame);
    }
    // раскалённая кромка у земли
    W.accBase += dt * 70 * g;
    n = Math.floor(W.accBase);
    if (n > 0) {
      W.accBase -= n;
      emBase.at.set(x - hx, fy + 0.1, z - hz); emBase.to.set(x + hx, fy + 0.1, z + hz);
      // [W4-ЗАКЛИНАНИЯ] кромка: белая (ярче), у тьмы — чёрная darkcore (blend alpha), у соперника — rival
      emBase.count = n; emBase.ramp = W.LK.base; emBase.blend = W.LK.baseBlend; emBase.rival = W.R; emBase.intensity = 2.6 * W.sf;
      kit.emit(emBase);
    }
    // угли вверх
    W.accEmber += dt * 80 * dec * m;
    n = Math.floor(W.accEmber);
    if (n > 0) {
      W.accEmber -= n;
      emEmber.at.set(x - hx, fy + 0.3, z - hz); emEmber.to.set(x + hx, fy + 0.3, z + hz);
      emEmber.vel.set(W.fwd.x * fw * 0.6, 0, W.fwd.z * fw * 0.6);
      emEmber.count = n; emEmber.ramp = W.rEmber; emEmber.rival = W.R;
      kit.emit(emEmber);
    }
    // дым (на low реже)
    W.accSmoke += dt * (W.low ? 7 : 16) * dec * m;
    n = Math.floor(W.accSmoke);
    if (n > 0) {
      W.accSmoke -= n;
      emSmoke.at.set(x - hx, fy + 0.6, z - hz); emSmoke.to.set(x + hx, fy + 0.6, z + hz);
      emSmoke.count = n; emSmoke.ramp = W.rSmoke; emSmoke.rival = W.R;
      kit.emit(emSmoke);
    }
    // искры бури по фронту
    W.accStorm += dt * 60 * dec * m;
    n = Math.floor(W.accStorm);
    if (n > 0) {
      W.accStorm -= n;
      emStorm.at.set(x - hx, fy + 1.1, z - hz); emStorm.to.set(x + hx, fy + 1.1, z + hz);
      emStorm.count = n; emStorm.ramp = W.rStorm; emStorm.rival = W.R;
      kit.emit(emStorm);
    }
    // дуги молний вдоль фронта (чуть впереди — фронт уходит за время жизни дуги)
    if (fx.bolts && kit.clock >= W.arcT && t <= W.T) {
      W.arcT = kit.clock + (W.q === 'high' ? 0.07 : W.q === 'medium' ? 0.1 : 0.18) / (0.6 + 0.4 * W.s);
      const lead = W.vf * 0.07;
      const u = Math.random() * 2 - 1, h0 = 0.3 + Math.random() * 1.9;
      arcO.from.set(x + hx * u + W.fwd.x * lead, W.front.y + h0, z + hz * u + W.fwd.z * lead);
      if (Math.random() < 0.35) {
        // разряд с гребня стены в землю
        arcO.to.set(arcO.from.x + W.fwd.x * 0.4, W.front.y + 0.05, arcO.from.z + W.fwd.z * 0.4);
      } else {
        const sgn = u > 0 ? -1 : 1, span = (0.8 + Math.random() * 1.2) * sgn;
        arcO.to.set(arcO.from.x + W.right.x * span, W.front.y + clamp(h0 + (Math.random() - 0.5) * 1.2, 0.1, 2.6), arcO.from.z + W.right.z * span);
      }
      arcO.color = W.PS.mid; arcO.core = W.PS.core; arcO.rival = W.r01;
      arcO.width = 0.025 + 0.025 * W.s; arcO.intensity = (2.6 + 0.9 * W.s) * W.sf;   // [W4-ЗАКЛИНАНИЯ] ярче
      fx.bolts.arc(arcO);
    }
    return true;
  }

  // звено горящего следа на расстоянии dd от старта: декаль + догорающие языки
  function burnMark(W, dd) {
    const x = W.start.x + W.fwd.x * dd, z = W.start.z + W.fwd.z * dd;
    const y = fx.groundY(x, z, W.start.y + (W.tgtG.y - W.start.y) * (dd / W.L));
    const rad = Math.max(W.half * 0.7, W.stepD * 0.6) * (0.8 + 0.2 * W.s);
    W.nDec++;
    if (fx.decals) {
      decO.pos.set(x, y, z);
      decO.radius = rad;
      decO.kind = !W.low && W.nDec % 3 === 0 ? 'crack' : 'scorch';
      const P = decO.kind === 'crack' ? W.PS : W.PF;
      decO.color = P.mid; decO.hot = P.core; decO.rival = W.r01;
      decO.life = W.low ? 4 : 6; decO.rot = Math.random() * TAU; decO.intensity = 1.1 + 0.3 * W.s;
      fx.decals.spawn(decO);
    }
    emBurn.at.set(x, y + 0.05, z);
    emBurn.radius = rad * 0.7;
    emBurn.count = Math.round(7 * W.s);
    emBurn.ramp = W.rFlame; emBurn.rival = W.R;
    kit.emit(emBurn);
  }

  // приход стены: удар у цели (по таймеру и для своих, и для соперника)
  function impact(W, tgt, power) {
    const R = W.R, r01 = W.r01, sf = W.sf;
    const s = W.s * (R ? 0.7 : 1);                    // по нашему герою (у камеры) — мельче
    const g = W.tgtG, PF = W.PF, PS = W.PS;
    const gp = { x: g.x, y: g.y + 0.05, z: g.z };
    if (fx.shock) {
      fx.shock.ring({ pos: gp, r0: 0.4, r1: 3.5 + 3 * s, dur: 0.55, color: PF.mid, hot: PF.core, intensity: 2.2, thickness: 0.3, rival: r01 });
      fx.shock.ring({ pos: gp, r0: 0.3, r1: 2.2 + 1.6 * s, dur: 0.38, color: PS.mid, hot: PS.core, intensity: 1.8, distort: 0.5, rival: r01 });
      if (!W.low && !R) fx.shock.sphere({ pos: tgt, r0: 0.3, r1: 1.6 + 1.2 * s, dur: 0.35, color: PF.hot, hot: PF.core, intensity: 1.1, distort: 0.6, rival: r01 });
    }
    kit.flash(tgt, { ramp: R ? 'rival' : 'whiteHold', size: [1.0, 3.6 + 2 * s], dur: 0.28, intensity: 4.5 * sf, sprite: 'star', pull: 0.8, rival: R });
    kit.flash(tgt, { ramp: W.rFire, size: [1.4, 4 * s], dur: 0.45, intensity: 2.6 * sf, sprite: 'glow', pull: 0.6, rival: R });   // [W4-ЗАКЛИНАНИЯ] ореол ярче
    // огненный всплеск: столб пламени, кольцо языков по земле, искры и угли
    kit.emit({ at: gp, shape: 'disk', radius: 1.1, normal: UP, count: Math.round(50 * s), dir: UP, cone: 0.35, speed: [4, 9], life: [0.3, 0.6],
      size: [1.1, 0.35], ramp: W.rFire, intensity: 2.6, sprite: 'flame', rot: 0, drag: 2.2, gravity: -1, turb: 0.5, rival: R, essential: true });
    kit.emit({ at: gp, shape: 'ring', radius: 0.6, normal: UP, count: Math.round(44 * s), radial: 7, speed: [0, 0.3], dir: UP, cone: 0.1,
      life: [0.35, 0.6], size: [0.75, 0.25], ramp: W.rFlame, intensity: 2.4, sprite: 'flame', rot: 0, drag: 3.2, gravity: -0.6, rival: R, essential: true });
    kit.emit({ at: tgt, count: Math.round(70 * s), speed: [4, 12], life: [0.3, 0.8], size: [0.06, 0.012], ramp: W.rEmber, intensity: 3, sprite: 'spark',
      stretch: 0.04, gravity: 6, drag: 1.5, ground: g.y + 0.03, rival: R });
    kit.emit({ at: tgt, shape: 'sphere', radius: 0.6, count: Math.round(36 * s), speed: [2, 6], life: [0.12, 0.26], size: [0.06, 0.01], ramp: W.rStorm,
      intensity: 3, sprite: 'spark', stretch: 0.05, drag: 3, rival: R });
    kit.emit({ at: gp, shape: 'disk', radius: 1.6, normal: UP, count: Math.round(14 * s), dir: UP, cone: 0.5, speed: [0.6, 1.6], life: [1.2, 2],
      size: [1.2, 2.8], sprite: 'smoke', blend: 'alpha', ramp: W.rSmoke, intensity: 1, alpha: 0.5, drag: 1.2, gravity: -0.6, turb: 0.5,
      spin: [-0.6, 0.6], delay: 0.15, rival: R });
    if (fx.bolts) {
      fx.bolts.groundArcs({ center: g, radius: 2.4 + 2 * s, count: W.low ? 4 : 8, dur: 0.6, color: PS.mid, core: PS.core, intensity: 2.8 * sf, rival: r01 });   // [W4-ЗАКЛИНАНИЯ] ярче
      const na = W.low ? 1 : 3;
      for (let i = 0; i < na; i++) {
        const a = Math.random() * TAU, b = a + 2 + Math.random() * 2;
        const rr = R ? 0.7 : 1.3;
        fx.bolts.arc({ from: { x: tgt.x + Math.cos(a) * rr, y: tgt.y + (Math.random() - 0.3) * 1.6, z: tgt.z + Math.sin(a) * rr },
          to: { x: tgt.x + Math.cos(b) * rr, y: tgt.y + (Math.random() - 0.5) * 1.6, z: tgt.z + Math.sin(b) * rr },
          color: PS.mid, core: PS.core, width: 0.035, dur: 0.3, rate: 28, intensity: 3 * sf, rival: r01 });
      }
    }
    if (fx.decals) {
      fx.decals.spawn({ pos: g, radius: 2.4 * s, kind: 'scorch', life: 8, rot: Math.random() * TAU, color: PF.mid, hot: PF.core, intensity: 1.3, rival: r01 });
      if (!W.low) fx.decals.spawn({ pos: g, radius: 1.3 * s, kind: 'crater', life: 6, rot: Math.random() * TAU, color: PF.mid, hot: PF.hot, intensity: 1, rival: r01 });
    }
    if (lights() > 0) kit.light(tgt, { color: PF.hot, intensity: 1.3, range: 12, dur: 0.6, attack: 0.06 });
    kit.screenFlash(W.LK.scrHit, (R ? 0.08 : 0.06) * (0.6 + 0.4 * power) * sf, 0.12);   // [W4-ЗАКЛИНАНИЯ] тон волны героя
    kit.shake(R ? 0.22 : 0.1 + 0.18 * power);
    if (kit.distort && !W.low) kit.distort(tgt, 0.5);
  }

  // промах: стена выдыхается на 26 м — дым, гаснущие угли, последний треск
  function dissipate(W) {
    const R = W.R, f = W.front, s = W.s;
    const hx = W.right.x * W.half, hz = W.right.z * W.half;
    const a = { x: f.x - hx, y: f.y + 0.3, z: f.z - hz }, b = { x: f.x + hx, y: f.y + 0.3, z: f.z + hz };
    kit.emit({ at: a, shape: 'line', to: b, radius: 0.4, count: Math.round(16 * s), dir: UP, cone: 0.5, speed: [0.5, 1.4], life: [1.2, 2],
      size: [1.1, 2.6], sprite: 'smoke', blend: 'alpha', ramp: W.rSmoke, intensity: 1, alpha: 0.5, drag: 1.2, gravity: -0.5, turb: 0.6,
      spin: [-0.5, 0.5], rival: R });
    kit.emit({ at: a, shape: 'line', to: b, radius: 0.3, count: Math.round(30 * s), dir: UP, cone: 0.8, speed: [1, 3], life: [0.5, 1.1],
      size: [0.05, 0.01], ramp: W.rEmber, intensity: 2.4, sprite: 'spark', stretch: 0.02, gravity: 3, drag: 1, rival: R });
    kit.emit({ at: a, shape: 'line', to: b, radius: 0.5, count: Math.round(20 * s), speed: [0.5, 2], life: [0.1, 0.25], size: [0.05, 0.01],
      ramp: W.rStorm, intensity: 2.6, sprite: 'spark', stretch: 0.03, drag: 3, rival: R });
    kit.flash(f, { ramp: W.rFire, size: [1.2, 2.6], dur: 0.3, intensity: 1.4 * W.sf, sprite: 'glow', pull: 0.3, rival: R });
  }

  // ---------------------------------------------------------------- купол бастиона: слои вокруг hex-купола sigils.js
  // [W4-ЗАКЛИНАНИЯ] ramp/P — цвет слоёв купола (свой — стихия героя, берётся при раскрытии; соперник — rival)
  const domes = [
    { on: false, flashed: false, startAt: 0, open: 0, acc: 0, ringT: 0, c: new V3(), remote: false, ramp: 'fire', P: E.fire },
    { on: false, flashed: false, startAt: 0, open: 0, acc: 0, ringT: 0, c: new V3(), remote: true, ramp: 'rival', P: E.rival },
  ];
  // искры бегут вверх по сфере: кольцо на широте θ, скорость по касательной к меридиану (радиально внутрь + вверх)
  const emRise = { at: new V3(), shape: 'ring', radius: DOME_R, normal: UP, count: 1, speed: 0, radial: 0, vel: new V3(), center: new V3(),
    orbit: 0.5, life: [0.3, 0.5], size: [0.05, 0.012], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.025, fadeIn: 0.15,
    essential: true, rival: false };
  // медленное золотое кольцо у земли: огоньки, вращающиеся вокруг героя
  const emRing = { at: new V3(), shape: 'ring', radius: DOME_R * 1.04, normal: UP, count: 4, speed: 0, center: new V3(), orbit: 0.45,
    life: [1.0, 1.3], size: [0.16, 0.12], sizeVar: 0.2, ramp: 'gold', intensity: 1.8, sprite: 'glow', fadeIn: 0.3, essential: true, rival: false };
  // раскрытие: оболочка искр наружу, звезда у груди, волна у ног
  const emOpen = { at: new V3(), shape: 'shell', radius: 0.4, count: 40, radial: 3.2, speed: [0, 0.3], life: [0.3, 0.5], size: [0.07, 0.012],
    ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.03, drag: 2.5, essential: true, rival: false };
  const emClose = { at: new V3(), shape: 'shell', radius: DOME_R, count: 24, radial: 1.2, speed: [0, 0.2], life: [0.35, 0.6], size: [0.05, 0.01],
    ramp: 'gold', intensity: 2.4, sprite: 'spark', stretch: 0.02, drag: 2, gravity: 1.5, rival: false };
  const flStar = { ramp: 'gold', size: [0.5, 2.4], dur: 0.24, intensity: 4.2, sprite: 'star', pull: 0.4, rival: false };
  const flGlow = { ramp: 'gold', size: [1.2, 3.4], dur: 0.45, intensity: 1.6, sprite: 'glow', pull: 0.3, rival: false };
  const ringO = { pos: new V3(), r0: 0.3, r1: 2.6, dur: 0.55, color: E.gold.mid, hot: E.gold.core, intensity: 2, thickness: 0.25, rival: 0 };
  const lightO = { color: E.gold.hot, intensity: 1.1, range: 9, dur: 0.6, attack: 0.1 };
  const _fp = new V3();

  function domeLayers(D, dt, want, left) {
    if (want && !D.on) {
      D.on = true; D.flashed = false; D.open = 0; D.acc = 0; D.ringT = 0;
      const gc = fx.shared.gateCastAt, ago = kit.clock - (isNum(gc) ? gc : -1e9);
      D.startAt = !D.remote && ago >= 0 && ago < 0.5 ? gc + 0.4 : kit.clock;   // как domeTick в sigils.js
      if (!D.remote) { const LK = lookOf(null); D.ramp = LK.wave; D.P = LK.P; }   // [W4-ЗАКЛИНАНИЯ] цвет героя
    }
    if (!want) {
      if (D.on && D.flashed) {
        // купол закрылся: искры осыпаются с оболочки
        emClose.at.copy(D.c); emClose.at.y += 0.3; emClose.ramp = D.ramp; emClose.rival = D.remote;
        kit.emit(emClose);
      }
      D.on = false; D.open = 0; return;
    }
    if (kit.clock < D.startAt) return;
    fx.anchor('feet', D.c, D.remote);
    const ramp = D.ramp;                                  // [W4-ЗАКЛИНАНИЯ] стихия героя / rival
    if (!D.flashed) {
      D.flashed = true;
      const sf = soft();
      _fp.copy(D.c); _fp.y += 1.0;
      // [W4-ЗАКЛИНАНИЯ] ядро раскрытия белее, ореол ярче
      flStar.ramp = D.remote ? 'rival' : 'whiteHold'; flStar.rival = D.remote; flStar.intensity = 4.2 * sf;
      flGlow.ramp = ramp; flGlow.rival = D.remote; flGlow.intensity = 2 * sf;
      kit.flash(_fp, flStar); kit.flash(_fp, flGlow);
      emOpen.at.copy(_fp); emOpen.ramp = ramp; emOpen.rival = D.remote; emOpen.count = qName() === 'low' ? 20 : 40;
      kit.emit(emOpen);
      if (fx.shock) {
        const P = D.P;
        ringO.pos.set(D.c.x, D.c.y + 0.05, D.c.z); ringO.color = P.mid; ringO.hot = P.core; ringO.rival = D.remote ? 1 : 0;
        fx.shock.ring(ringO);
      }
      if (lights() > 0 && !D.remote) { lightO.color = D.P.hot; kit.light(_fp, lightO); }
    }
    if (!(dt > 0)) return;
    D.open += (1 - D.open) * (1 - Math.exp(-dt * 9));
    let blink = 1;
    if (isNum(left) && left > 0 && left < 1.2) blink = fx.reduced() ? 0.75 + 0.25 * Math.cos(left * 5) : 0.55 + 0.45 * Math.cos(kit.clock * 17);
    const dec = decor(), low = qName() === 'low';
    // бегущие вверх искры по поверхности сферы
    D.acc += dt * (low ? 22 : 48) * dec * D.open;
    const n = Math.floor(D.acc);
    if (n > 0) {
      D.acc -= n;
      const th = Math.random() * 1.2, v = 1.6 + Math.random() * 0.8;
      const sn = Math.sin(th), cs = Math.cos(th);
      emRise.at.set(D.c.x, D.c.y + DOME_R * sn + 0.02, D.c.z);
      emRise.center.copy(D.c);
      emRise.radius = DOME_R * cs;
      emRise.radial = -v * sn;
      emRise.vel.set(0, v * cs, 0);
      emRise.count = n; emRise.ramp = ramp; emRise.rival = D.remote; emRise.intensity = 2.8 * blink;
      kit.emit(emRise);
    }
    // медленное кольцо у земли
    if (kit.clock >= D.ringT) {
      D.ringT = kit.clock + (low ? 0.22 : 0.1);
      emRing.at.set(D.c.x, D.c.y + 0.06, D.c.z);
      emRing.center.copy(D.c);
      emRing.count = low ? 3 : 5; emRing.ramp = ramp; emRing.rival = D.remote; emRing.intensity = 1.8 * blink * D.open;
      kit.emit(emRing);
    }
  }

  fx.every((dt, snap) => {
    if (!snap) return;
    const pl = snap.player;
    domeLayers(domes[0], dt, !!(pl && pl.bastion && pl.action !== 'dead'), pl ? pl.bastionRemaining : 0);
    const op = snap.opponent;
    domeLayers(domes[1], dt, !!(op && op.bastion && op.action !== 'dead'), op ? op.bastionRemaining : 0);
  });

  fx.onClear(() => {
    for (const D of domes) { D.on = false; D.flashed = false; D.open = 0; D.acc = 0; D.ringT = 0; }
    fx.shared.gateCastAt = -1e9;
  });
  // своих мешей нет (только kit/подсистемы) — освобождать нечего, гасим состояние
  fx.onDispose(() => { for (const D of domes) { D.on = false; D.flashed = false; } });
}
