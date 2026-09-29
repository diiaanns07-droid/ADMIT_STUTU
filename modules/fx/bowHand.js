// ASHEN OATH — modules/fx/bowHand.js. Владелец: №7 [VFX].
// Лук «Сумерки» и магия ладони (контракт C3, механики агента №6). Всё рисует V6:
//  ЛУК: пока input.bow.active — светящийся лук у bowSocket (два изогнутых плеча из световых линий bolts,
//       тетива к точке натяжения, наложенная стрела; энергия стягивается в наконечник по мере draw;
//       при charged — вспышка, круг стихии и аура). bow_release — щелчок тетивы, выброс, отдача, тетива дрожит.
//       Стрелы в полёте (snap.projectiles kind 'arrow') — яркое древко + след + «линька» стихии;
//       дождь стрел (rain) — тонкие частые трассы. arrow_hit — удар по стихии, декаль, маленький хит-стоп.
//  ЛАДОНЬ: пока input.handSpell.phase 'form'|'hold' — сфера стихии в правой ладони растёт с power
//       (огонь — вихрь пламени, буря — шар молний, лёд — кристаллы и холодный туман, земля — камни на орбите
//       с магмой). hand_spell_form — вспышка зажигания и круг, throw — выброс и толчок, снаряд 'hand_orb',
//       hand_spell_hit — удар стихии по урону, hand_spell_cancel — «пшик» у ладони.
//  PvP: data.remote / снаряд соперника → те же эффекты в цвете соперника (от него к нам).
// Старые янтарные болты для 'arrow'/'hand_orb' подавлены (fx.suppress), их projectile_impact — тоже.

import { muzzle, explosion, afterglow, decal, trail, clamp, TAU, isNum, hasVec } from './common.js';

const EL = { fire: 1, storm: 1, frost: 1, earth: 1 };
const elOf = (e) => (typeof e === 'string' && EL[e] === 1 ? e : null);
const num = (v, d) => (isNum(v) ? v : d);
const RAMP_EL = { fire: 'fire', storm: 'storm', frost: 'frost', earth: 'ember' };
const rampEl = (el, R) => (R ? 'rival' : RAMP_EL[el] || 'gold');
const rnd = (a, b) => a + Math.random() * (b - a);

// Лук: доли высоты плеча и прогиб назад (доля D); кончики чуть загнуты вперёд (рекурв).
const LS = [0, 0.37, 0.72, 1];
const LBK = [0, 0.12, 0.5, 0.74];
const CANT = 0.2;          // наклон лука (верх наружу), чтобы силуэт читался из-за спины
const BOW_H = 0.62;        // половина высоты (итого ~1.24 м)
const PULL = 0.56;         // ход тетивы при draw = 1
const ARROW_L = 0.9;
const REL_T = 0.3, FADE_T = 0.26;
const LIFT = 0.35;         // подтяжка линий к камере (не прятать в руке)

export function register(fx) {
  const THREE = fx.THREE, V3 = THREE.Vector3, kit = fx.kit, E = fx.E;
  const pal = (el, R) => (R ? E.rival : (el ? E[el] : E.gold));
  // цвет ореола линий: у земли «mid» слишком бурый — берём раскалённый
  const haloOf = (el, R) => (R ? E.rival.mid : el === 'earth' ? E.earth.hot : el ? E[el].mid : E.gold.hot);
  const clock = () => kit.clock;
  const UP = new V3(0, 1, 0);
  const _tg = new V3(), _h = new V3(), _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3();

  fx.suppress('proj:arrow');
  fx.suppress('proj:hand_orb');

  // ============================================================ световые линии (bolts.strike без излома)
  // Ручки bolts живут в кольце и переиспользуются, поэтому сверяем слот/поколение, прежде чем двигать.
  const _setO = { from: null, to: null, intensity: 1, color: 0, core: 0, rival: 0 };
  const mkLine = () => ({ h: null, s: null, g: -1, w: 0, retry: 0 });
  const lineAlive = (L) => { const h = L.h; return !!h && h._s === L.s && h._g === L.g && h.alive; };
  function lineSet(L, from, to, inten, col, core, rival, width, lift) {
    const B = fx.bolts;
    if (!B) return false;
    if (!lineAlive(L) || L.w !== width) {
      if (clock() < L.retry) return false;
      if (lineAlive(L)) { try { L.h.kill(); } catch (e) { /* ignore */ } }
      L.h = null;
      try {
        L.h = B.strike({ from, to, width, jitter: 0, branches: 0, segments: 2, flicker: false, star: false, origin: false, dur: 40, intensity: inten, color: col, core, rival, lift });
      } catch (e) { L.h = null; }
      if (!L.h || !L.h.alive) { L.h = null; L.retry = clock() + 0.3; return false; }
      L.s = L.h._s; L.g = L.h._g; L.w = width;
      return true;
    }
    _setO.from = from; _setO.to = to; _setO.intensity = inten; _setO.color = col; _setO.core = core; _setO.rival = rival;
    try { L.h.set(_setO); } catch (e) { /* ignore */ }
    return true;
  }
  function lineKill(L) { if (lineAlive(L)) { try { L.h.kill(); } catch (e) { /* ignore */ } } L.h = null; L.s = null; }
  // короткий треск (дуга) — выстрелил и забыл
  function zap(from, to, col, core, R, dur, width, inten) {
    if (!fx.bolts) return;
    try { fx.bolts.arc({ from, to, color: col, core, dur: dur || 0.09, rate: 30, width: width || 0.014, jitter: 0.3, intensity: inten || 2.4, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ }
  }
  function ring(pos, normal, r1, dur, col, core, R, inten) {
    if (!fx.shock) return false;
    try { fx.shock.ring({ pos, normal, r0: 0.1, r1, dur, color: col, hot: core, intensity: inten || 1.8, rival: R ? 1 : 0 }); return true; } catch (e) { return false; }
  }
  function distort(pos, s) { if (typeof kit.distort === 'function') { try { kit.distort(pos, s); } catch (e) { /* ignore */ } } }
  const audio = (n, p) => { if (fx.legacy && typeof fx.legacy.audio === 'function') { try { fx.legacy.audio(n, p); } catch (e) { /* ignore */ } } };

  // ============================================================ переиспользуемые шаблоны выбросов
  // «Живое» свечение: частица со скоростью носителя (едет вместе с луком/стрелой), 1–3 кадра жизни.
  const oGlow = { at: null, vel: null, count: 1, speed: [0, 0], life: [0.05, 0.05], size: [0.2, 0.18], sizeVar: 0, color: 0xffffff, intensity: 2.5, sprite: 'glow', fadeIn: 0, curve: 1, essential: true, rival: false };
  function glowAt(at, vel, size, life, color, inten, R, sprite) {
    oGlow.at = at; oGlow.vel = vel; oGlow.size[0] = size; oGlow.size[1] = size * 0.9; oGlow.life[0] = life; oGlow.life[1] = life;
    oGlow.color = color; oGlow.intensity = inten; oGlow.rival = !!R; oGlow.sprite = sprite || 'glow';
    kit.emit(oGlow);
  }
  // Общий «универсальный» шаблон: заполняется полностью перед каждым вызовом (fill).
  const oP = {};
  const P_DEF = {
    at: null, count: 1, shape: 'point', radius: 0, normal: null, to: null, dir: null, cone: Math.PI, speed: null, radial: 0, tangent: 0, vel: null,
    life: null, size: null, sizeVar: 0.3, ramp: 'gold', color: undefined, intensity: 1.5, alpha: 1, sprite: 'dot', blend: 'add', gravity: 0, drag: 0, turb: 0,
    stretch: 0, spin: 0, rot: undefined, orbit: 0, center: null, rgrow: 0, ground: -1e4, fadeIn: 0.08, curve: 1, delay: 0, rival: false, essential: false,
  };
  const SPD = [0, 0], LIF = [0, 0], SIZ = [0, 0], SPN = [0, 0];
  function P(at, count) {
    for (const k in P_DEF) oP[k] = P_DEF[k];
    oP.at = at; oP.count = count; oP.speed = SPD; oP.life = LIF; oP.size = SIZ; oP.spin = 0;
    SPD[0] = 0; SPD[1] = 0; LIF[0] = 0.4; LIF[1] = 0.8; SIZ[0] = 0.1; SIZ[1] = 0.03;
    return oP;
  }
  const sp = (a, b) => { SPD[0] = a; SPD[1] = b; };
  const lf = (a, b) => { LIF[0] = a; LIF[1] = b; };
  const sz = (a, b) => { SIZ[0] = a; SIZ[1] = b; };
  const spin = (a, b) => { SPN[0] = a; SPN[1] = b; oP.spin = SPN; };
  const go = () => kit.emit(oP);
  // накопитель частоты: сколько частиц выпустить за dt при rate/с
  function take(acc, key, rate, dt) {
    const v = acc[key] + rate * dt;
    const n = Math.floor(v);
    acc[key] = v - n;
    return n;
  }
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 1);

  // «Линька» стихии с движущейся точки (стрела/сфера): n частиц, скорость носителя vel·k.
  const _vk = new V3();
  function shed(el, R, at, vel, k, n, s) {
    if (n <= 0) return;
    _vk.copy(vel).multiplyScalar(k);
    const ramp = rampEl(el, R);
    s = s || 1;
    if (el === 'fire') {
      P(at, n); oP.radius = 0.06 * s; oP.vel = _vk; sp(0.2, 0.9); lf(0.16, 0.32); sz(0.22 * s, 0.05); oP.ramp = ramp; oP.intensity = 2.4;
      oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -2.2; oP.drag = 3; oP.turb = 0.7; oP.rival = R; go();
      if (Math.random() < 0.5) { P(at, 1); oP.vel = _vk; sp(0.5, 2); lf(0.3, 0.6); sz(0.05, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.stretch = 0.02; oP.gravity = 3; oP.drag = 1.5; oP.rival = R; go(); }
    } else if (el === 'storm') {
      P(at, n); oP.radius = 0.05 * s; oP.vel = _vk; sp(1, 4); lf(0.08, 0.2); sz(0.06 * s, 0.01); oP.ramp = ramp; oP.intensity = 3.4;
      oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 3; oP.turb = 1.4; oP.rival = R; go();
    } else if (el === 'frost') {
      P(at, n); oP.radius = 0.08 * s; oP.vel = _vk; sp(0.1, 0.6); lf(0.35, 0.7); sz(0.09 * s, 0.03); oP.ramp = ramp; oP.intensity = 2.2;
      oP.sprite = 'flake'; spin(-4, 4); oP.gravity = 0.8; oP.drag = 2; oP.turb = 0.4; oP.rival = R; go();
      if (Math.random() < 0.35) { P(at, 1); oP.radius = 0.05; oP.vel = _vk; sp(0.1, 0.3); lf(0.4, 0.7); sz(0.16 * s, 0.4 * s); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 2; oP.rival = R; spin(-1, 1); go(); }
    } else if (el === 'earth') {
      P(at, n); oP.radius = 0.06 * s; oP.vel = _vk; sp(0.2, 0.8); lf(0.35, 0.7); sz(0.15 * s, 0.35 * s); oP.ramp = 'dust'; oP.intensity = 1; oP.alpha = 0.8;
      oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 2; oP.gravity = -0.2; spin(-1, 1); oP.rival = R; go();
      if (Math.random() < 0.55) { P(at, 1); oP.vel = _vk; sp(0.5, 1.5); lf(0.4, 0.8); sz(0.05 * s, 0.04 * s); oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; oP.gravity = 9; spin(-8, 8); oP.rival = R; go(); }
      if (Math.random() < 0.4) { P(at, 1); oP.vel = _vk; sp(0.3, 1.2); lf(0.25, 0.5); sz(0.04, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.gravity = 4; oP.rival = R; go(); }
    } else {
      P(at, n); oP.radius = 0.05 * s; oP.vel = _vk; sp(0.2, 0.8); lf(0.2, 0.45); sz(0.07 * s, 0.01); oP.ramp = ramp; oP.intensity = 2.8;
      oP.sprite = Math.random() < 0.4 ? 'star' : 'spark'; spin(-2, 2); oP.drag = 2; oP.turb = 0.3; oP.rival = R; go();
    }
  }
  // Светящийся «след» без подсистемы trails: штрихи вдоль отрезка prev→pos, медленно гаснут.
  function streakTrail(prev, pos, dir, n, w, life, ramp, inten, R) {
    if (n <= 0) return;
    P(prev, n); oP.shape = 'line'; oP.to = pos; oP.dir = dir; oP.cone = 0; sp(0.6, 0.9); oP.drag = 4; lf(life * 0.7, life);
    sz(w, w * 0.2); oP.ramp = ramp; oP.intensity = inten; oP.sprite = 'streak'; oP.stretch = 0.35; oP.rival = R; oP.essential = true; go();
  }

  // ============================================================ ЛУК
  function makeBow(remote) {
    const top = [], bot = [], lines = [];
    for (let i = 0; i < 4; i++) { top.push(new V3()); bot.push(new V3()); }
    for (let i = 0; i < 10; i++) lines.push(mkLine());
    return {
      remote, phase: 0, t: 0, pt: 0, draw: 0, evDraw: 0, drawEv: -9, charged: false, wasCharged: false, element: null,
      lastEv: -9, lastStart: -9, lastRel: -9, offSince: -1, vis: 0,
      grip: new V3(), aim: new V3(), side: new V3(), up: new V3(), nock: new V3(), rest: new V3(), head: new V3(),
      vel: new V3(), prevGrip: new V3(), hasPrev: false, top, bot, lines,
      acc: { mote: 0, gem: 0, gath: 0, head: 0, aura: 0, arc: 0, fb: 0 }, glyph: null,
    };
  }
  const LB = makeBow(false), RB = makeBow(true);
  const bowOf = (d) => (fx.isRemote(d) ? RB : LB);

  function bowGeom(B, dt) {
    const R = B.remote;
    fx.anchor('bowSocket', B.grip, R);
    fx.target(_tg, R);
    B.aim.subVectors(_tg, B.grip);
    if (B.aim.lengthSq() < 1e-6) fx.facing(B.aim, R);
    B.aim.normalize();
    B.side.set(-B.aim.z, 0, B.aim.x);
    if (B.side.lengthSq() < 1e-6) B.side.set(1, 0, 0);
    B.side.normalize();
    // лук чуть впереди и снаружи от кисти: не тонет в руке
    B.grip.addScaledVector(B.aim, 0.1).addScaledVector(B.side, -0.05);
    // скорость носителя (для «живых» свечений); телепорт — без скорости
    if (B.hasPrev && dt > 1e-4) {
      B.vel.subVectors(B.grip, B.prevGrip).multiplyScalar(1 / dt);
      if (B.vel.lengthSq() > 144) B.vel.set(0, 0, 0);
    } else B.vel.set(0, 0, 0);
    B.prevGrip.copy(B.grip); B.hasPrev = true;
    B.up.copy(UP).multiplyScalar(Math.cos(CANT)).addScaledVector(B.side, -Math.sin(CANT));
    B.up.addScaledVector(B.aim, -B.up.dot(B.aim)).normalize();
    const dr = B.phase === 1 ? B.draw : 0;
    const H = BOW_H * (1 - 0.06 * dr), D = 0.14 + 0.14 * dr;
    for (let k = 0; k < 4; k++) {
      const h = H * LS[k], b = D * LBK[k];
      B.top[k].copy(B.grip).addScaledVector(B.up, h).addScaledVector(B.aim, -b);
      B.bot[k].copy(B.grip).addScaledVector(B.up, -h).addScaledVector(B.aim, -b);
    }
    B.rest.addVectors(B.top[3], B.bot[3]).multiplyScalar(0.5);
    B.nock.copy(B.rest).addScaledVector(B.aim, -PULL * dr);
    if (B.phase === 2) { // тетива щёлкнула: пролетает вперёд и дрожит
      const t = B.pt;
      B.nock.addScaledVector(B.aim, 0.09 * Math.exp(-t * 15) * Math.cos(t * 62));
    } else if (dr > 0.1) { // рука рядом с точкой натяжения — тетива в руку
      fx.anchor('handR', _h, R);
      const dd = _h.distanceTo(B.nock);
      if (dd < 0.35) B.nock.lerp(_h, 0.55 * dr * (1 - dd / 0.35));
    }
    B.head.copy(B.nock).addScaledVector(B.aim, ARROW_L);
  }
  // случайная точка на плечах лука → out
  function limbPoint(B, out) {
    const arr = Math.random() < 0.5 ? B.top : B.bot;
    const k = Math.floor(Math.random() * 3), t = Math.random();
    return out.lerpVectors(arr[k], arr[k + 1], t);
  }

  function bowStart(B, el) {
    const now = clock();
    B.lastStart = now; B.lastEv = now; B.offSince = -1;
    B.element = el;
    if (B.phase === 1) return;
    const fresh = B.phase === 0;
    B.phase = 1; B.t = 0; B.pt = 0; B.draw = 0; B.evDraw = 0; B.drawEv = -9; B.charged = false; B.wasCharged = false;
    if (fresh) { B.vis = 0; B.hasPrev = false; }
    bowGeom(B, 0);
    materialize(B);
  }
  function materialize(B) {
    const R = B.remote, el = B.element, Pl = pal(el, R), ramp = rampEl(el, R), col = haloOf(el, R);
    // свет «сгущается» в плечи лука
    for (let s = 0; s < 2; s++) {
      P(B.grip, 14); oP.shape = 'line'; oP.to = s ? B.top[3] : B.bot[3]; oP.radius = 0.1; sp(0.2, 0.9); lf(0.25, 0.5); sz(0.06, 0.012);
      oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'spark'; oP.drag = 3; oP.turb = 0.6; oP.fadeIn = 0.3; oP.rival = R; oP.essential = true; go();
    }
    P(B.grip, 22); oP.shape = 'shell'; oP.radius = 0.75; oP.radial = -0.75 / 0.16; lf(0.14, 0.17); sz(0.03, 0.08); oP.ramp = ramp; oP.intensity = 2.6;
    oP.sprite = 'spark'; oP.stretch = 0.03; oP.fadeIn = 0.3; oP.rival = R; go();
    kit.flash(B.grip, { color: Pl.core, size: [0.1, 0.55], dur: 0.16, intensity: 3.2, sprite: 'star', pull: 0.5, rival: R });
    kit.flash(B.top[3], { color: col, size: [0.05, 0.3], dur: 0.2, intensity: 2.6, sprite: 'star', pull: 0.3, rival: R, delay: 0.04 });
    kit.flash(B.bot[3], { color: col, size: [0.05, 0.3], dur: 0.2, intensity: 2.6, sprite: 'star', pull: 0.3, rival: R, delay: 0.04 });
    if (fx.glyph) {
      try {
        _a.copy(B.grip).addScaledVector(B.aim, 0.28);
        B.glyph = fx.glyph.spawn({ pos: _a, normal: B.aim, radius: 0.42, symbol: 'bow', color: col, hot: Pl.core, intensity: 1.7, dur: 0.75, unfold: 0.14, fade: 0.3, spin: 1.6, rings: 2, ticks: 18, style: 'rune', rival: R ? 1 : 0 });
      } catch (e) { B.glyph = null; }
    }
  }
  function chargedFlare(B) {
    const R = B.remote, el = B.element, Pl = pal(el, R), col = haloOf(el, R), ramp = rampEl(el, R);
    kit.flash(B.head, { color: Pl.core, size: [0.25, 1.2], dur: 0.2, intensity: 4.2, sprite: 'star', pull: 0.4, rival: R });
    kit.flash(B.head, { color: col, size: [0.3, 1.5], dur: 0.3, intensity: 2, sprite: 'glow', pull: 0.4, rival: R });
    kit.flash(B.head, { color: col, size: [0.2, 0.9], dur: 0.2, intensity: 2.2, sprite: 'ring', pull: 0.3, rival: R }); // [VFX] без кольца во весь экран
    P(B.head, 26); oP.shape = 'ring'; oP.normal = B.aim; oP.radius = 0.08; oP.radial = 3.2; oP.tangent = 1.5; sp(0, 0.4); oP.vel = B.vel; lf(0.2, 0.4); sz(0.07, 0.01);
    oP.ramp = ramp; oP.intensity = 3.2; oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 4; oP.rival = R; oP.essential = true; go();
    if (fx.glyph) {
      try {
        _a.copy(B.head).addScaledVector(B.aim, 0.06);
        fx.glyph.spawn({ pos: _a, normal: B.aim, radius: 0.36, symbol: el || 'bow', color: col, hot: Pl.core, intensity: 2.2, dur: 1.4, unfold: 0.1, fade: 0.25, spin: -2.4, rings: 2, ticks: 14, style: 'rune', rival: R ? 1 : 0, follow: B.remote ? followRHead : followLHead });
      } catch (e) { /* ignore */ }
    }
    kit.light(B.head, { color: col, intensity: 1.1, range: 6, dur: 0.45, attack: 0.08 });
    if (el === 'storm' && fx.bolts) for (let i = 0; i < 2; i++) zap(B.head, limbPoint(B, _b), col, Pl.core, R, 0.12, 0.012, 2.6);
  }
  const _fh = new V3(), _fh2 = new V3();
  const followLHead = () => (LB.phase === 1 ? _fh.copy(LB.head).addScaledVector(LB.aim, 0.06) : _fh);
  const followRHead = () => (RB.phase === 1 ? _fh2.copy(RB.head).addScaledVector(RB.aim, 0.06) : _fh2);

  function bowRelease(B, charged, el) {
    const now = clock();
    if (now - B.lastRel < 0.22) return;
    B.lastRel = now; B.lastEv = now;
    if (el !== undefined) B.element = el;
    if (B.phase === 0) { B.phase = 1; B.draw = 1; B.hasPrev = false; bowGeom(B, 0); B.vis = 1; }
    else bowGeom(B, 0);
    const R = B.remote, E0 = B.element, Pl = pal(E0, R), col = haloOf(E0, R);
    // щелчок тетивы
    kit.flash(B.nock, { color: Pl.core, size: [0.12, 0.6], dur: 0.1, intensity: 3.4, sprite: 'star', pull: 0.5, rival: R });
    P(B.nock, 10); oP.shape = 'line'; oP.to = B.top[3]; sp(0.3, 1.2); lf(0.1, 0.22); sz(0.04, 0.01); oP.ramp = rampEl(E0, R); oP.intensity = 3; oP.sprite = 'spark'; oP.drag = 3; oP.rival = R; go();
    P(B.nock, 10); oP.shape = 'line'; oP.to = B.bot[3]; sp(0.3, 1.2); lf(0.1, 0.22); sz(0.04, 0.01); oP.ramp = rampEl(E0, R); oP.intensity = 3; oP.sprite = 'spark'; oP.drag = 3; oP.rival = R; go();
    // выброс у лука
    muzzle(fx, B.head, B.aim, E0 || 'gold', R, { size: charged ? 1.25 : 0.8, count: charged ? 24 : 14 });
    kit.flash(B.head, { color: col, size: [0.2, charged ? 1.1 : 0.7], dur: 0.2, intensity: 2, sprite: 'ring', pull: 0.3, rival: R }); // [VFX] без кольца во весь экран
    if (charged) {
      kit.flash(B.grip, { color: col, size: [0.4, 1.4], dur: 0.25, intensity: 1.8, sprite: 'glow', pull: 0.6, rival: R });
      shed(E0, R, B.head, B.aim, 3, 6, 1.4);
    }
    kit.light(B.head, { color: col, intensity: charged ? 1.3 : 0.7, range: 7, dur: 0.25, attack: 0.05 });
    kit.kick(B.aim, charged ? 0.022 : 0.012);
    if (charged) kit.shake(0.08);
    B.phase = 2; B.pt = 0; B.draw = 0; B.charged = false; B.wasCharged = false;
    lineKill(B.lines[9]);
    audio('cast', B.head);
  }
  function bowFade(B) {
    if (B.phase !== 1) return;
    B.phase = 3; B.pt = 0;
    lineKill(B.lines[9]);
  }
  function bowOff(B) {
    B.phase = 0; B.vis = 0; B.draw = 0; B.charged = false; B.wasCharged = false; B.offSince = -1;
    for (let i = 0; i < B.lines.length; i++) lineKill(B.lines[i]);
  }
  function bowDissolve(B) {
    const R = B.remote, ramp = rampEl(B.element, R);
    for (let s = 0; s < 2; s++) {
      P(B.grip, 10); oP.shape = 'line'; oP.to = s ? B.top[3] : B.bot[3]; sp(0.2, 0.8); oP.dir = UP; oP.cone = 1.2; lf(0.3, 0.6); sz(0.05, 0.01);
      oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'spark'; oP.turb = 0.8; oP.drag = 1.5; oP.gravity = -0.6; oP.rival = R; go();
    }
  }

  function bowDraw(B, dt) {
    const R = B.remote, el = B.element, Pl = pal(el, R), col = haloOf(el, R), rv = R ? 1 : 0, ramp = rampEl(el, R);
    const drawing = B.phase === 1;
    const dr = drawing ? B.draw : 0, v = B.vis;
    const chg = drawing && B.charged;
    const I = (1.4 + 1.2 * dr + (chg ? 0.8 : 0)) * v;
    const L = B.lines;
    let ok = !!fx.bolts;
    if (ok) {
      // плечи: 3 отрезка на плечо (у соперника 2 — экономия слотов bolts)
      if (R) {
        ok = lineSet(L[0], B.top[0], B.top[2], I, col, Pl.core, rv, 0.02, LIFT) && ok;
        ok = lineSet(L[1], B.top[2], B.top[3], I, col, Pl.core, rv, 0.02, LIFT) && ok;
        ok = lineSet(L[2], B.bot[0], B.bot[2], I, col, Pl.core, rv, 0.02, LIFT) && ok;
        ok = lineSet(L[3], B.bot[2], B.bot[3], I, col, Pl.core, rv, 0.02, LIFT) && ok;
      } else {
        for (let k = 0; k < 3; k++) {
          ok = lineSet(L[k], B.top[k], B.top[k + 1], I, col, Pl.core, rv, 0.022, LIFT) && ok;
          ok = lineSet(L[3 + k], B.bot[k], B.bot[k + 1], I, col, Pl.core, rv, 0.022, LIFT) && ok;
        }
      }
      // тетива
      ok = lineSet(L[6], B.top[3], B.nock, I * 0.7, Pl.hot, Pl.core, rv, 0.005, LIFT) && ok;
      ok = lineSet(L[7], B.bot[3], B.nock, I * 0.7, Pl.hot, Pl.core, rv, 0.005, LIFT) && ok;
      // наложенная стрела (проявляется с натяжением)
      if (drawing && B.t > 0.06) {
        const av = clamp((B.t - 0.06) / 0.14, 0, 1) * v;
        ok = lineSet(L[9], B.nock, B.head, (1.6 + 1.8 * dr) * av, col, Pl.core, rv, 0.011, LIFT) && ok;
      } else lineKill(L[9]);
    }
    if (!ok) { // запасной вариант: плечи и тетива из частиц
      const n = take(B.acc, 'fb', 260 * v, dt);
      for (let i = 0; i < n; i++) {
        const q = Math.random();
        if (q < 0.7) limbPoint(B, _a);
        else _a.lerpVectors(Math.random() < 0.5 ? B.top[3] : B.bot[3], B.nock, Math.random());
        glowAt(_a, B.vel, q < 0.7 ? 0.07 : 0.035, 0.06, col, 2.6, R, 'glow');
      }
      if (drawing && B.t > 0.06) {
        const m = take(B.acc, 'arc', 140, dt);
        for (let i = 0; i < m; i++) { _a.lerpVectors(B.nock, B.head, Math.random()); glowAt(_a, B.vel, 0.04, 0.06, Pl.hot, 3, R, 'glow'); }
      }
    }
    // камень-сердце у рукояти
    if (take(B.acc, 'gem', 22, dt) > 0) glowAt(B.grip, B.vel, (0.16 + 0.1 * dr) * v, 0.08, col, 2.4 * v, R, 'glow');
    // пылинки, слетающие с плеч
    let n = take(B.acc, 'mote', (18 + 14 * dr) * v, dt);
    for (let i = 0; i < n; i++) {
      limbPoint(B, _a);
      P(_a, 1); oP.vel = B.vel; oP.dir = UP; oP.cone = 1.4; sp(0.1, 0.6); lf(0.3, 0.6); sz(0.045, 0.008); oP.ramp = ramp; oP.intensity = 2.6;
      oP.sprite = Math.random() < 0.3 ? 'star' : 'spark'; oP.turb = 0.6; oP.drag = 1; oP.gravity = -0.4; oP.rival = R; go();
    }
    if (!drawing) return;
    // энергия стягивается в наконечник
    n = take(B.acc, 'gath', (10 + 60 * dr) * v, dt);
    if (n > 0) {
      const Rr = 0.28 + 0.3 * (1 - dr);
      P(B.head, n); oP.shape = 'shell'; oP.radius = Rr; oP.radial = -Rr / 0.15; oP.vel = B.vel; lf(0.13, 0.16); sz(0.02, 0.07); oP.ramp = ramp; oP.intensity = 2.8;
      oP.sprite = 'spark'; oP.stretch = 0.025; oP.fadeIn = 0.35; oP.rival = R; oP.essential = true; go();
    }
    if (take(B.acc, 'head', 30, dt) > 0) {
      glowAt(B.head, B.vel, (0.1 + 0.34 * dr + (chg ? 0.12 : 0)) * v, 0.06, col, (1.6 + 1.6 * dr) * v, R, 'glow');
      glowAt(B.head, B.vel, (0.05 + 0.1 * dr) * v, 0.06, Pl.core, 3.2 * v, R, chg ? 'star' : 'glow');
    }
    // заряжено: аура стихии
    if (chg && !B.wasCharged) chargedFlare(B);
    B.wasCharged = chg;
    if (!chg) return;
    n = take(B.acc, 'aura', 34, dt);
    for (let i = 0; i < n; i++) {
      const onArrow = Math.random() < 0.35;
      if (onArrow) _a.lerpVectors(B.nock, B.head, 0.3 + Math.random() * 0.7); else limbPoint(B, _a);
      if (el === 'fire') {
        P(_a, 1); oP.radius = 0.03; oP.vel = B.vel; sp(0.1, 0.5); lf(0.22, 0.38); sz(0.14, 0.04); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -2; oP.drag = 2; oP.turb = 0.6; oP.rival = R; go();
      } else if (el === 'storm') {
        P(_a, 1); oP.vel = B.vel; sp(0.6, 2.4); lf(0.08, 0.18); sz(0.05, 0.01); oP.ramp = ramp; oP.intensity = 3.4; oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 3; oP.turb = 1.4; oP.rival = R; go();
      } else if (el === 'frost') {
        P(_a, 1); oP.radius = 0.04; oP.vel = B.vel; sp(0.05, 0.3); lf(0.4, 0.7); sz(0.07, 0.03); oP.ramp = ramp; oP.intensity = 2.3; oP.sprite = 'flake'; spin(-3, 3); oP.gravity = 0.4; oP.drag = 1; oP.rival = R; go();
        if (Math.random() < 0.25) { P(_a, 1); oP.vel = B.vel; sp(0.05, 0.2); lf(0.5, 0.8); sz(0.12, 0.3); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.gravity = 0.3; spin(-1, 1); oP.rival = R; go(); }
      } else if (el === 'earth') {
        P(_a, 1); oP.vel = B.vel; sp(0.2, 0.6); lf(0.3, 0.6); sz(0.05, 0.01); oP.ramp = ramp; oP.intensity = 2.8; oP.sprite = Math.random() < 0.5 ? 'ember' : 'spark'; oP.gravity = 1.5; oP.rival = R; go();
      } else {
        P(_a, 1); oP.vel = B.vel; sp(0.05, 0.3); lf(0.25, 0.5); sz(0.08, 0.01); oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'star'; spin(-2, 2); oP.rival = R; go();
      }
    }
    if (el === 'storm' && take(B.acc, 'arc', 7, dt) > 0) {
      limbPoint(B, _b);
      _c.lerpVectors(B.nock, B.head, 0.4 + Math.random() * 0.6);
      zap(_b, _c, col, Pl.core, R, 0.1, 0.01, 2.2);
    }
  }

  function bowStep(B, dt) {
    if (B.phase === 0) return;
    if (fx.external && fx.external.bow && !B.remote) { B.phase = 0; B.vis = 0; for (const L of B.lines) lineKill(L); return; } // [VFX] 3D-лук рисует handVisuals (№6)
    B.t += dt; B.pt += dt;
    if (B.phase === 1) B.vis = Math.min(1, B.vis + dt / 0.12);
    else {
      const k = B.pt / (B.phase === 2 ? REL_T : FADE_T);
      if (k >= 1) { bowGeom(B, dt); bowDissolve(B); bowOff(B); return; }
      B.vis = Math.pow(1 - k, 1.4) * (B.phase === 2 ? 1 : B.vis > 0 ? 1 : 0);
    }
    bowGeom(B, dt);
    bowDraw(B, dt);
  }
  // натяжение по событиям (соперник или нет ввода): последнее bow_draw или предсказание 0.8 с
  function bowPredict(B, dt) {
    if (B.phase !== 1) return;
    const now = clock();
    if (now - B.drawEv < 0.4) B.draw = Math.max(B.draw, B.evDraw);
    else B.draw = Math.min(1, B.draw + dt / 0.8);
    B.charged = B.draw >= 0.999;
    if (now - B.lastEv > 3) bowFade(B);
  }

  fx.on('bow_draw_start', (ev, d) => { bowStart(bowOf(d), elOf(d.element)); return true; });
  fx.on('bow_draw', (ev, d) => {
    const B = bowOf(d);
    if (B.phase !== 1 && clock() - B.lastRel > 0.25) bowStart(B, d.element !== undefined ? elOf(d.element) : B.element);
    B.lastEv = clock(); B.drawEv = clock();
    if (isNum(d.draw)) B.evDraw = clamp(d.draw, 0, 1);
    if (d.element !== undefined) B.element = elOf(d.element);
    return true;
  });
  fx.on('bow_release', (ev, d) => {
    const B = bowOf(d);
    bowRelease(B, !!d.charged, d.element !== undefined ? elOf(d.element) : undefined);
    return true;
  });

  // ============================================================ МАГИЯ ЛАДОНИ — сфера в руке
  function makeOrb(remote) {
    const ends = [];
    for (let i = 0; i < 3; i++) ends.push({ from: new V3(), to: new V3() });
    const O = {
      remote, on: false, t: 0, el: 'fire', power: 0, evPower: 0, lastEv: -9, lastStart: -9, offSince: -1,
      pos: new V3(), prev: new V3(), vel: new V3(), dir: new V3(), hasPrev: false, r: 0.1,
      arcs: [mkLine(), mkLine(), mkLine()], ends, arcH: [null, null, null], arcS: [null, null, null], arcG: [-1, -1, -1],
      acc: { core: 0, a: 0, b: 0, c: 0, light: 0, zap: 0 },
    };
    O.follow = [0, 1, 2].map((i) => () => O.ends[i]);
    return O;
  }
  const LO = makeOrb(false), RO = makeOrb(true);
  const orbOf = (d) => (fx.isRemote(d) ? RO : LO);

  function orbGeom(O, dt) {
    const R = O.remote;
    fx.anchor('handR', _h, R);
    fx.target(_tg, R);
    O.dir.subVectors(_tg, _h);
    if (O.dir.lengthSq() < 1e-6) fx.facing(O.dir, R);
    O.dir.normalize();
    O.pos.copy(_h).addScaledVector(O.dir, 0.14);
    O.pos.y += 0.04;
    if (O.hasPrev && dt > 1e-4) {
      O.vel.subVectors(O.pos, O.prev).multiplyScalar(1 / dt);
      if (O.vel.lengthSq() > 144) O.vel.set(0, 0, 0);
    } else O.vel.set(0, 0, 0);
    O.prev.copy(O.pos); O.hasPrev = true;
    O.r = 0.07 + 0.2 * clamp(O.power, 0, 1);
  }
  function arcAlive(O, i) { const h = O.arcH[i]; return !!h && h._s === O.arcS[i] && h._g === O.arcG[i] && h.alive; }
  function orbKillArcs(O) {
    for (let i = 0; i < 3; i++) { if (arcAlive(O, i)) { try { O.arcH[i].kill(); } catch (e) { /* ignore */ } } O.arcH[i] = null; }
  }
  function orbStart(O, el) {
    const now = clock();
    O.lastStart = now; O.lastEv = now; O.offSince = -1;
    if (O.on && O.el === el) return;
    if (O.on) orbKillArcs(O);
    O.on = true; O.t = 0; O.el = el || 'fire'; O.power = 0; O.evPower = 0; O.hasPrev = false;
    orbGeom(O, 0);
    ignite(O);
  }
  function orbOff(O) { O.on = false; O.offSince = -1; orbKillArcs(O); }

  function ignite(O) {
    const R = O.remote, el = O.el, Pl = pal(el, R), ramp = rampEl(el, R);
    kit.flash(O.pos, { color: Pl.core, size: [0.1, 0.8], dur: 0.14, intensity: 3.8, sprite: 'star', pull: 0.5, rival: R });
    kit.flash(O.pos, { color: Pl.hot, size: [0.2, 1.1], dur: 0.24, intensity: 2, sprite: 'glow', pull: 0.5, rival: R });
    P(O.pos, 22); oP.shape = 'ring'; oP.normal = O.dir; oP.radius = 0.05; oP.radial = 2.8; oP.tangent = 2; sp(0, 0.3); lf(0.18, 0.35); sz(0.06, 0.01);
    oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'spark'; oP.stretch = 0.025; oP.drag = 4; oP.rival = R; oP.essential = true; go();
    if (el === 'fire') { P(O.pos, 8); oP.radius = 0.05; sp(0.3, 1.2); lf(0.2, 0.35); sz(0.22, 0.05); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -2; oP.drag = 3; oP.rival = R; go(); }
    else if (el === 'storm') { for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU; _a.set(O.pos.x + Math.cos(a) * 0.3, O.pos.y + 0.2 * Math.sin(a * 2), O.pos.z + Math.sin(a) * 0.3); zap(O.pos, _a, Pl.mid, Pl.core, R, 0.14, 0.012, 2.4); } }
    else if (el === 'frost') { P(O.pos, 10); oP.radius = 0.05; sp(0.8, 2); lf(0.25, 0.45); sz(0.1, 0.03); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'shard'; spin(-6, 6); oP.drag = 3; oP.rival = R; go(); }
    else if (el === 'earth') { P(O.pos, 8); oP.radius = 0.05; sp(0.6, 1.6); lf(0.35, 0.6); sz(0.05, 0.04); oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; oP.gravity = 6; spin(-6, 6); oP.rival = R; go(); }
    if (fx.glyph) {
      try {
        _a.copy(O.pos).addScaledVector(O.dir, 0.12);
        fx.glyph.spawn({ pos: _a, normal: O.dir, radius: 0.34, symbol: el, color: haloOf(el, R), hot: Pl.core, intensity: 1.9, dur: 1.1, unfold: 0.14, fade: 0.3, spin: 2, rings: 2, ticks: 16, style: 'rune', rival: R ? 1 : 0, follow: R ? followRPalm : followLPalm });
      } catch (e) { /* ignore */ }
    }
    kit.light(O.pos, { color: Pl.hot, intensity: 0.8, range: 5, dur: 0.3, attack: 0.1 });
    if (el === 'fire' && fx.shock) { try { fx.shock.haze({ pos: O.pos, radius: 0.3, height: 0.8, dur: 1.2, strength: 0.6, follow: R ? followROrb : followLOrb }); } catch (e) { /* ignore */ } }
    audio('conjureStart', O.pos);
  }
  const _fp = new V3(), _fp2 = new V3();
  const followLPalm = () => (LO.on ? _fp.copy(LO.pos).addScaledVector(LO.dir, 0.12) : _fp);
  const followRPalm = () => (RO.on ? _fp2.copy(RO.pos).addScaledVector(RO.dir, 0.12) : _fp2);
  const followLOrb = () => LO.pos, followROrb = () => RO.pos;

  // сфера стихии в ладони (каждый кадр)
  function orbDraw(O, dt) {
    const R = O.remote, el = O.el, Pl = pal(el, R), ramp = rampEl(el, R), r = O.r, pw = clamp(O.power, 0, 1);
    const hold = O.t > 1.4 ? 0.55 : 1; // долгое удержание — реже частицы
    const grow = clamp(O.t / 0.12, 0, 1);
    if (take(O.acc, 'core', 30, dt) > 0) {
      glowAt(O.pos, O.vel, r * 3.2 * grow, 0.06, el === 'earth' && !R ? E.earth.hot : Pl.hot, 1.3 + 0.8 * pw, R, 'glow');
      glowAt(O.pos, O.vel, r * (el === 'earth' ? 0.9 : 1.3) * grow, 0.06, Pl.core, 2.6 + 1.2 * pw, R, 'glow');
    }
    if (take(O.acc, 'light', 2.2, dt) > 0) kit.light(O.pos, { color: el === 'earth' ? E.earth.hot : Pl.hot, intensity: 0.35 + 0.6 * pw, range: 4 + 2 * pw, dur: 0.5, attack: 0.4, follow: R ? followROrb : followLOrb });
    let n;
    if (el === 'fire') {
      // вихрь пламени: языки на орбите вокруг ладони поднимаются
      n = take(O.acc, 'a', (26 + 26 * pw) * hold, dt);
      if (n > 0) {
        P(O.pos, n); oP.shape = 'shell'; oP.radius = r * 0.75; oP.tangent = 0; sp(0.1, 0.4); oP.vel = O.vel; lf(0.2, 0.34); sz(r * 1.5, r * 0.35); oP.ramp = ramp; oP.intensity = 2.5;
        oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -1.4; oP.drag = 2; oP.orbit = 7; oP.center = O.pos; oP.turb = 0.4; oP.rival = R; oP.essential = true; go();
      }
      n = take(O.acc, 'b', 12 * hold, dt);
      if (n > 0) { P(O.pos, n); oP.radius = r * 0.8; oP.dir = UP; oP.cone = 0.6; sp(0.5, 1.6); oP.vel = O.vel; lf(0.4, 0.8); sz(0.045, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.stretch = 0.02; oP.turb = 0.6; oP.gravity = -0.5; oP.rival = R; go(); }
    } else if (el === 'storm') {
      // шар молний: три «живые» дуги по поверхности + искры
      const tt = O.t;
      for (let i = 0; i < 3; i++) {
        const a = tt * (3.1 + i * 1.3) + i * 2.1, b = tt * (2.3 - i * 0.9) + i * 1.3;
        const e = O.ends[i];
        e.from.set(O.pos.x + Math.cos(a) * r * 0.25, O.pos.y + Math.sin(b) * r * 0.25, O.pos.z + Math.sin(a) * r * 0.25);
        e.to.set(O.pos.x + Math.cos(a + 2.4) * Math.cos(b) * r * 1.05, O.pos.y + Math.sin(b + 1.1) * r * 1.05, O.pos.z + Math.sin(a + 2.4) * Math.cos(b) * r * 1.05);
        if (fx.bolts && !arcAlive(O, i) && O.t > i * 0.05) {
          try {
            const h = fx.bolts.arc({ follow: O.follow[i], color: Pl.mid, core: Pl.core, dur: 30, rate: 26, width: 0.012, jitter: 0.4, intensity: 2.4 + pw, rival: R ? 1 : 0, lift: 0.1 });
            if (h && h.alive) { O.arcH[i] = h; O.arcS[i] = h._s; O.arcG[i] = h._g; }
          } catch (e2) { /* ignore */ }
        }
      }
      n = take(O.acc, 'a', (18 + 16 * pw) * hold, dt);
      if (n > 0) { P(O.pos, n); oP.shape = 'shell'; oP.radius = r * 0.9; sp(0.5, 2.5); oP.vel = O.vel; lf(0.06, 0.16); sz(0.05, 0.01); oP.ramp = ramp; oP.intensity = 3.4; oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 3; oP.turb = 1.5; oP.rival = R; oP.essential = true; go(); }
      if (pw > 0.5 && take(O.acc, 'zap', 3 * pw, dt) > 0) { // разряд «в воздух» — шар перегружен
        _a.set(O.pos.x + rnd(-0.6, 0.6), O.pos.y + rnd(-0.4, 0.5), O.pos.z + rnd(-0.6, 0.6));
        zap(O.pos, _a, Pl.mid, Pl.core, R, 0.08, 0.01, 2);
      }
    } else if (el === 'frost') {
      // кристаллы на орбите + холодный туман стекает вниз
      n = take(O.acc, 'a', (24 + 22 * pw) * hold, dt);
      if (n > 0) {
        P(O.pos, n); oP.shape = 'shell'; oP.radius = r * 0.7; sp(0, 0.1); oP.vel = O.vel; lf(0.26, 0.4); sz(r * 0.9, r * 0.6); oP.ramp = ramp; oP.intensity = 2.3;
        oP.sprite = 'shard'; spin(-3, 3); oP.orbit = 5; oP.center = O.pos; oP.fadeIn = 0.25; oP.rival = R; oP.essential = true; go();
      }
      n = take(O.acc, 'b', 9 * hold, dt);
      if (n > 0) { P(O.pos, n); oP.radius = r * 0.6; sp(0.05, 0.25); oP.vel = O.vel; lf(0.7, 1.1); sz(r * 1.2, r * 3); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.alpha = 0.8; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.gravity = 0.45; oP.drag = 1.5; spin(-0.8, 0.8); oP.rival = R; go(); }
      n = take(O.acc, 'c', 8 * hold, dt);
      if (n > 0) { P(O.pos, n); oP.shape = 'shell'; oP.radius = r * 1.3; sp(0.05, 0.3); oP.vel = O.vel; lf(0.5, 0.9); sz(0.05, 0.02); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flake'; spin(-3, 3); oP.gravity = 0.3; oP.rival = R; go(); }
    } else { // earth
      // камни на орбите, в каждом — светящаяся трещина магмы (частицы с одинаковой траекторией)
      n = take(O.acc, 'a', (10 + 10 * pw) * hold, dt);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, rr = r * rnd(1.0, 1.35);
        _a.set(O.pos.x + Math.cos(a) * rr, O.pos.y + rnd(-0.6, 0.6) * r, O.pos.z + Math.sin(a) * rr);
        const s0 = r * rnd(0.45, 0.7);
        P(_a, 1); sp(0, 0); lf(0.42, 0.42); sz(s0, s0); oP.sizeVar = 0; oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; spin(-2, 2);
        oP.orbit = 3.2; oP.center = O.pos; oP.fadeIn = 0.2; oP.rival = R; oP.essential = true; go();
        P(_a, 1); sp(0, 0); lf(0.42, 0.42); sz(s0 * 0.55, s0 * 0.45); oP.sizeVar = 0; oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.6; oP.sprite = 'ember';
        oP.orbit = 3.2; oP.center = O.pos; oP.fadeIn = 0.2; oP.rival = R; oP.essential = true; go();
      }
      n = take(O.acc, 'b', 7 * hold, dt);
      if (n > 0) { P(O.pos, n); oP.radius = r * 0.9; sp(0.1, 0.4); oP.vel = O.vel; lf(0.6, 1); sz(r * 1, r * 2.4); oP.ramp = 'dust'; oP.intensity = 1; oP.alpha = 0.7; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.gravity = 0.25; spin(-0.8, 0.8); oP.rival = R; go(); }
      n = take(O.acc, 'c', 6 * hold, dt);
      if (n > 0) { P(O.pos, n); oP.radius = r * 0.7; oP.dir = UP; oP.cone = 0.7; sp(0.3, 1); oP.vel = O.vel; lf(0.4, 0.7); sz(0.04, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.gravity = -0.4; oP.rival = R; go(); }
    }
  }
  function orbStep(O, dt) {
    if (!O.on) return;
    O.t += dt;
    orbGeom(O, dt);
    orbDraw(O, dt);
  }

  fx.on('hand_spell_form', (ev, d) => {
    const O = orbOf(d);
    const el = elOf(d.element) || O.el || 'fire';
    orbStart(O, el);
    if (isNum(d.power)) O.evPower = clamp(d.power, 0, 1);
    return true;
  });
  fx.on('hand_spell_throw', (ev, d) => {
    const O = orbOf(d), R = O.remote;
    const el = elOf(d.element) || O.el || 'fire';
    const pw = clamp(num(d.power, O.power || 1), 0, 1);
    if (!O.on) { O.hasPrev = false; orbGeom(O, 0); }
    const at = O.pos, dir = O.dir, Pl = pal(el, R), col = haloOf(el, R);
    muzzle(fx, at, dir, el, R, { size: 0.9 + 0.5 * pw, count: 16 + Math.round(10 * pw) });
    kit.flash(at, { color: col, size: [0.2, 0.8 + 0.3 * pw], dur: 0.2, intensity: 2, sprite: 'ring', pull: 0.4, rival: R }); // [VFX] без кольца во весь экран
    shed(el, R, at, dir, 2.5, 5, 1.6);
    kit.light(at, { color: Pl.hot, intensity: 1, range: 7, dur: 0.3, attack: 0.05 });
    kit.kick(dir, 0.018 + 0.014 * pw);
    orbOff(O);
    O.lastEv = clock();
    audio('throw', at);
    return true;
  });
  fx.on('hand_spell_cancel', (ev, d) => {
    const O = orbOf(d), R = O.remote;
    if (!O.on) { O.hasPrev = false; orbGeom(O, 0); }
    const el = elOf(d.element) || O.el, at = O.pos;
    kit.flash(at, { color: pal(el, R).hot, size: [0.3, 0.15], dur: 0.2, intensity: 1.4, sprite: 'glow', pull: 0.5, rival: R });
    P(at, 7); oP.radius = 0.08; sp(0.2, 0.7); lf(0.6, 1); sz(0.12, 0.4); oP.ramp = el === 'frost' ? 'frostsmoke' : el === 'earth' ? 'dust' : 'smoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha';
    oP.gravity = -0.5; oP.drag = 1.5; spin(-1, 1); oP.rival = R; oP.essential = true; go();
    P(at, 10); oP.radius = 0.06; sp(0.4, 1.4); lf(0.3, 0.6); sz(0.04, 0.01); oP.ramp = rampEl(el, R); oP.intensity = 2.2; oP.sprite = 'spark'; oP.gravity = 5; oP.drag = 1; oP.rival = R; oP.essential = true; go();
    orbOff(O);
    O.lastEv = clock();
    audio('fizzle', at);
    return true;
  });

  // ============================================================ СНАРЯДЫ: стрелы и сферы
  const recs = new Map();
  const recPool = [];
  let tag = 0;
  function recGet(pr) {
    const r = recPool.pop() || { id: '', kind: '', el: null, R: false, rain: false, charged: false, pos: new V3(), prev: new V3(), vel: new V3(), dir: new V3(), age: 0, tag: 0, line: mkLine(), tr: null, tr2: null, acc: { a: 0, b: 0, c: 0, d: 0 }, spin: 0, r: 0.3 };
    r.id = String(pr.id); r.kind = pr.kind; r.el = elOf(pr.element);
    r.R = !!(pr.remote || pr.owner === 'opponent' || pr.owner === 'rival');
    r.rain = !!pr.rain; r.charged = !!pr.charged; r.age = 0; r.tag = tag; r.spin = Math.random() * TAU;
    r.r = clamp(num(pr.radius, 0.3), 0.12, 0.6);
    r.pos.set(pr.position.x, pr.position.y, pr.position.z); r.prev.copy(r.pos);
    if (hasVec(pr.velocity)) r.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else r.vel.set(0, 0, 0);
    r.acc.a = r.acc.b = r.acc.c = r.acc.d = 0;
    r.tr = null; r.tr2 = null;
    const Pl = pal(r.el, r.R);
    if (r.kind === 'arrow') {
      r.tr = trail(fx, r.el || 'gold', r.R, { style: 'energy', width: r.rain ? 0.05 : r.charged ? 0.14 : 0.09, life: r.rain ? 0.14 : 0.22, intensity: r.rain ? 1.8 : 2.6, maxPoints: r.rain ? 12 : 20, taper: 1 });
      // материализация стрелы дождя в небе
      if (r.rain) kit.flash(r.pos, { color: Pl.hot, size: [0.2, 0.9], dur: 0.2, intensity: 2.4, sprite: 'star', pull: 0, rival: r.R });
    } else {
      const st = r.el === 'fire' ? 'fire' : r.el === 'earth' ? 'smoke' : 'energy';
      r.tr = trail(fx, r.el || 'fire', r.R, { style: st, width: r.r * 1.6, life: 0.3, intensity: 2.4, maxPoints: 24, taper: 1 });
    }
    return r;
  }
  function recEnd(r) {
    if (r.tr) { try { r.tr.stop(); } catch (e) { /* ignore */ } r.tr = null; }
    if (r.tr2) { try { r.tr2.stop(); } catch (e) { /* ignore */ } r.tr2 = null; }
    lineKill(r.line);
    if (recPool.length < 32) recPool.push(r);
  }

  function arrowDraw(r, dt) {
    const R = r.R, el = r.el, Pl = pal(el, R), col = haloOf(el, R), ramp = rampEl(el, R);
    const d = r.dir;
    if (!r.rain) {
      _a.copy(r.pos).addScaledVector(d, -0.85); _b.copy(r.pos).addScaledVector(d, 0.06);
      const ok = lineSet(r.line, _a, _b, r.charged ? 4 : 3, col, Pl.core, R ? 1 : 0, r.charged ? 0.026 : 0.017, 0);
      if (!ok) { P(r.pos, 1); oP.vel = r.vel; sp(0, 0); lf(0.035, 0.035); sz(0.09, 0.08); oP.sizeVar = 0; oP.ramp = 'whiteHold'; oP.intensity = 3.5; oP.sprite = 'streak'; oP.stretch = 0.02; oP.rival = R; oP.essential = true; go(); }
      glowAt(r.pos, r.vel, r.charged ? 0.6 : 0.36, 0.035, col, 2.2, R, 'glow');
      if (r.tr) { try { r.tr.push(r.pos); } catch (e) { r.tr = null; } }
      streakTrail(r.prev, r.pos, d, r.tr ? 2 : 4, r.charged ? 0.09 : 0.06, 0.2, ramp, 2.8, R);
      shed(el, R, r.pos, r.vel, 0.08, take(r.acc, 'a', r.charged ? 90 : 55, dt), r.charged ? 1.4 : 1);
      if (el === 'storm' && fx.bolts && take(r.acc, 'b', r.charged ? 26 : 16, dt) > 0) {
        _c.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(0.35).addScaledVector(d, -rnd(0.3, 0.9)).add(r.pos);
        zap(r.pos, _c, col, Pl.core, R, 0.07, 0.01, 2.4);
      }
      if (r.charged) { // спираль стихии вокруг древка
        r.spin += dt * 28;
        if (Math.abs(d.y) < 0.95) _d.set(0, 1, 0); else _d.set(1, 0, 0);
        _e.crossVectors(d, _d).normalize(); _d.crossVectors(_e, d);
        for (let s = 0; s < 2; s++) {
          const a = r.spin + s * Math.PI, rr = 0.1;
          _c.copy(r.pos).addScaledVector(_d, Math.cos(a) * rr).addScaledVector(_e, Math.sin(a) * rr);
          P(_c, 1); sp(0, 0.2); lf(0.14, 0.24); sz(0.1, 0.02); oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'glow'; oP.rival = R; oP.essential = true; go();
        }
      }
    } else {
      // дождь: тонкая трасса, реже «линька»
      P(r.pos, 1); oP.vel = r.vel; sp(0, 0); lf(0.04, 0.04); sz(0.06, 0.05); oP.sizeVar = 0; oP.color = col; oP.intensity = 3.4; oP.sprite = 'streak'; oP.stretch = 0.016; oP.rival = R; oP.essential = true; go();
      if (r.tr) { try { r.tr.push(r.pos); } catch (e) { r.tr = null; } }
      else streakTrail(r.prev, r.pos, d, 1, 0.035, 0.14, ramp, 2.6, R);
      shed(el, R, r.pos, r.vel, 0.1, take(r.acc, 'a', 14, dt), 0.7);
    }
  }

  const ROCKS = [[0.5, 0.3, 0.1], [-0.45, 0.2, 0.35], [0.1, -0.5, -0.3], [-0.2, 0.45, -0.45], [0.35, -0.25, 0.5]];
  function orbFlyDraw(r, dt) {
    const R = r.R, el = r.el || 'fire', Pl = pal(el, R), col = haloOf(el, R), ramp = rampEl(el, R), rr = r.r;
    const hot = el === 'earth' && !R ? E.earth.hot : Pl.hot;
    // ореол сгустка скромнее: первые метры полёта — у самой камеры
    glowAt(r.pos, r.vel, rr * 2.2, 0.035, hot, 1.2, R, 'glow');
    glowAt(r.pos, r.vel, rr * (el === 'earth' ? 0.9 : 1.2), 0.035, Pl.core, 2.4, R, 'glow');
    if (r.tr) { try { r.tr.push(r.pos); } catch (e) { r.tr = null; } }
    else streakTrail(r.prev, r.pos, r.dir, 3, rr * 0.7, 0.22, ramp, 2.2, R);
    let n;
    if (el === 'fire') {
      n = take(r.acc, 'a', 140, dt);
      if (n > 0) { P(r.pos, n); oP.radius = rr * 0.5; _vk.copy(r.vel).multiplyScalar(0.25); oP.vel = _vk; sp(0.3, 1.2); lf(0.14, 0.28); sz(rr * 2, rr * 0.5); oP.ramp = ramp; oP.intensity = 2.5; oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -2.5; oP.drag = 3; oP.turb = 0.8; oP.rival = R; oP.essential = true; go(); }
      n = take(r.acc, 'b', 20, dt);
      if (n > 0) { P(r.pos, n); oP.radius = rr * 0.4; sp(0.2, 0.6); lf(0.5, 0.9); sz(rr * 1.4, rr * 3.4); oP.ramp = R ? 'voidsmoke' : 'firesmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.5; oP.gravity = -0.6; spin(-1, 1); oP.rival = R; go(); }
      shed('fire', R, r.pos, r.vel, 0.1, take(r.acc, 'c', 30, dt), 1.2);
    } else if (el === 'storm') {
      if (fx.bolts && take(r.acc, 'b', 30, dt) > 0) {
        _c.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize().multiplyScalar(rr * rnd(1.4, 2.6)).add(r.pos);
        zap(r.pos, _c, Pl.mid, Pl.core, R, 0.07, 0.014, 2.8);
      }
      n = take(r.acc, 'a', 80, dt);
      if (n > 0) { P(r.pos, n); oP.shape = 'shell'; oP.radius = rr * 0.9; _vk.copy(r.vel).multiplyScalar(0.3); oP.vel = _vk; sp(1, 4); lf(0.08, 0.2); sz(0.06, 0.01); oP.ramp = ramp; oP.intensity = 3.4; oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 3; oP.turb = 1.6; oP.rival = R; oP.essential = true; go(); }
      glowAt(r.pos, r.vel, rr * 2.2, 0.035, Pl.mid, 1.6, R, 'glow');
    } else if (el === 'frost') {
      n = take(r.acc, 'a', 110, dt);
      if (n > 0) { P(r.pos, n); oP.shape = 'shell'; oP.radius = rr * 0.75; _vk.copy(r.vel).multiplyScalar(0.85); oP.vel = _vk; sp(0, 0.5); lf(0.06, 0.14); sz(rr * 1, rr * 0.5); oP.ramp = ramp; oP.intensity = 2.5; oP.sprite = 'shard'; spin(-7, 7); oP.rival = R; oP.essential = true; go(); }
      n = take(r.acc, 'b', 30, dt);
      if (n > 0) { P(r.pos, n); oP.radius = rr * 0.5; sp(0.1, 0.4); lf(0.4, 0.7); sz(rr * 1.2, rr * 3); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.5; oP.gravity = 0.4; spin(-1, 1); oP.rival = R; go(); }
      shed('frost', R, r.pos, r.vel, 0.1, take(r.acc, 'c', 30, dt), 1.2);
    } else { // earth: вращающаяся глыба из обломков с магмой внутри
      r.spin += dt * 7;
      const ca = Math.cos(r.spin), sa = Math.sin(r.spin);
      for (let i = 0; i < ROCKS.length; i++) {
        const o = ROCKS[i];
        _c.set(r.pos.x + (o[0] * ca - o[2] * sa) * rr, r.pos.y + o[1] * rr, r.pos.z + (o[0] * sa + o[2] * ca) * rr);
        P(_c, 1); oP.vel = r.vel; sp(0, 0); lf(0.04, 0.04); sz(rr * 1.05, rr * 1.0); oP.sizeVar = 0.15; oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; oP.rot = i * 1.3 + r.spin; oP.fadeIn = 0; oP.rival = R; oP.essential = true; go();
      }
      glowAt(r.pos, r.vel, rr * 1.2, 0.035, R ? E.rival.hot : 0xff7a2a, 2.6, R, 'ember');
      n = take(r.acc, 'a', 40, dt);
      if (n > 0) { P(r.pos, n); oP.radius = rr * 0.6; sp(0.2, 0.7); lf(0.5, 0.9); sz(rr * 1.2, rr * 2.8); oP.ramp = 'dust'; oP.intensity = 1; oP.alpha = 0.75; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.5; spin(-1, 1); oP.rival = R; go(); }
      shed('earth', R, r.pos, r.vel, 0.1, take(r.acc, 'c', 20, dt), 1.3);
    }
  }

  // ============================================================ ПОПАДАНИЯ
  const hits = [];
  for (let i = 0; i < 12; i++) hits.push({ p: new V3(), t: -9 });
  let hitHead = 0;
  function noteHit(p) { const h = hits[hitHead]; hitHead = (hitHead + 1) % hits.length; h.p.copy(p); h.t = clock(); }
  function recentHit(p, win) { const now = clock(); for (let i = 0; i < hits.length; i++) { const h = hits[i]; if (now - h.t < win && h.p.distanceToSquared(p) < 6.25) return true; } return false; }
  const _hp = new V3(), _hg = new V3(), _hd = new V3();
  function hitCommon(ev, d, anchorName) {
    const R = fx.isRemote(d);
    if (!fx.evPos(ev, _hp)) fx.target(_hp, R);
    _hg.set(_hp.x, fx.groundY(_hp.x, _hp.z, 0), _hp.z);
    fx.anchor(anchorName, _hd, R);
    _hd.subVectors(_hp, _hd);
    if (_hd.lengthSq() < 1e-6) _hd.set(0, 0, -1);
    _hd.normalize();
    noteHit(_hp);
    return R;
  }

  function arrowImpact(p, g, dir, el, R, dmg, rain) {
    const Pl = pal(el, R), col = haloOf(el, R), ramp = rampEl(el, R);
    const s = rain ? 0.55 : clamp(0.7 + dmg / 60, 0.8, 1.5);
    _vk.copy(dir).negate();
    kit.flash(p, { color: Pl.core, size: [0.2 * s, 1.1 * s], dur: 0.12, intensity: 4, sprite: 'star', pull: 0.5, rival: R });
    kit.flash(p, { color: col, size: [0.3 * s, 1.6 * s], dur: 0.22, intensity: 2.1, sprite: 'glow', pull: 0.5, rival: R });
    P(p, Math.round(16 * s)); oP.dir = _vk; oP.cone = 0.9; sp(3, 9); lf(0.2, 0.45); sz(0.06, 0.01); oP.ramp = ramp; oP.intensity = 3.2; oP.sprite = 'spark'; oP.stretch = 0.03;
    oP.gravity = 7; oP.drag = 1.6; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
    const low = p.y - g.y < 1.2;
    const dg = low ? 1 : 0.7;
    if (el === 'fire') {
      P(p, Math.round(10 * s)); oP.radius = 0.12 * s; sp(1, 3); lf(0.25, 0.5); sz(0.35 * s, 0.9 * s); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flame'; oP.rot = 0; oP.gravity = -1.5; oP.drag = 3.5; oP.turb = 0.7; oP.rival = R; oP.essential = true; go();
      P(p, Math.round(12 * s)); sp(1.5, 5); lf(0.4, 0.9); sz(0.05, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.stretch = 0.02; oP.gravity = 6; oP.drag = 1; oP.ground = g.y + 0.03; oP.rival = R; go();
      P(p, 4); oP.radius = 0.2 * s; sp(0.3, 0.8); lf(0.8, 1.4); sz(0.4 * s, 1.1 * s); oP.ramp = R ? 'voidsmoke' : 'firesmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.gravity = -0.7; oP.delay = 0.05; spin(-1, 1); oP.rival = R; go();
      decal(fx, g, 'scorch', 1.1 * s * dg, 'fire', R, { life: rain ? 4 : 7 });
    } else if (el === 'storm') {
      P(p, Math.round(20 * s)); sp(4, 12); lf(0.12, 0.3); sz(0.05, 0.01); oP.ramp = ramp; oP.intensity = 3.6; oP.sprite = 'spark'; oP.stretch = 0.04; oP.drag = 2; oP.gravity = 3; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
      if (fx.bolts) {
        const m = rain ? 1 : 3;
        for (let i = 0; i < m; i++) { _c.set(rnd(-1, 1), rnd(-0.6, 1), rnd(-1, 1)).normalize().multiplyScalar(rnd(0.6, 1.2) * s).add(p); zap(p, _c, Pl.mid, Pl.core, R, 0.14, 0.014, 2.8); }
        if (low || !rain) { try { fx.bolts.groundArcs({ center: g, radius: 1.6 * s, count: rain ? 2 : 4, dur: 0.4, color: Pl.mid, core: Pl.core, intensity: 2.2, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ } }
      }
      decal(fx, g, 'crack', 1.1 * s * dg, 'storm', R, { life: rain ? 4 : 6 });
    } else if (el === 'frost') {
      P(p, Math.round(16 * s)); sp(2, 6); lf(0.4, 0.8); sz(0.14 * s, 0.05); oP.ramp = ramp; oP.intensity = 2.5; oP.sprite = 'shard'; spin(-9, 9); oP.gravity = 7; oP.drag = 1.2; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
      P(p, 5); oP.radius = 0.15 * s; sp(0.3, 1); lf(0.6, 1.1); sz(0.35 * s, 1 * s); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.5; oP.gravity = 0.3; spin(-1, 1); oP.rival = R; go();
      P(p, 8); oP.radius = 0.3 * s; sp(0.2, 1); lf(0.6, 1.1); sz(0.07, 0.03); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flake'; spin(-3, 3); oP.gravity = 1; oP.rival = R; go();
      decal(fx, g, 'frost', 1.2 * s * dg, 'frost', R, { life: rain ? 4 : 8 });
    } else if (el === 'earth') {
      P(p, Math.round(14 * s)); oP.dir = _vk; oP.cone = 1.1; sp(2, 6); lf(0.5, 0.9); sz(0.1 * s, 0.08 * s); oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; spin(-9, 9); oP.gravity = 11; oP.ground = g.y + 0.04; oP.rival = R; oP.essential = true; go();
      P(p, 6); oP.radius = 0.2 * s; sp(0.4, 1.2); lf(0.8, 1.4); sz(0.4 * s, 1.2 * s); oP.ramp = 'dust'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.4; oP.gravity = -0.2; spin(-1, 1); oP.rival = R; go();
      P(p, 8); sp(1, 4); lf(0.3, 0.6); sz(0.05, 0.01); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 2.8; oP.sprite = 'spark'; oP.gravity = 6; oP.ground = g.y + 0.03; oP.rival = R; go();
      decal(fx, g, 'crack', 1.1 * s * dg, 'earth', R, { life: rain ? 4 : 7 });
    } else {
      P(p, Math.round(8 * s)); oP.radius = 0.1; sp(0.5, 2); lf(0.3, 0.6); sz(0.1, 0.01); oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'star'; spin(-3, 3); oP.drag = 2; oP.rival = R; go();
      if (!rain) kit.flash(p, { color: col, size: [0.2, 1.3 * s], dur: 0.22, intensity: 1.8, sprite: 'ring', pull: 0.4, rival: R });
    }
    if (!rain) {
      if (low) ring({ x: g.x, y: g.y + 0.05, z: g.z }, UP, 1.8 * s, 0.35, col, Pl.core, R, 1.6);
      kit.light(p, { color: col, intensity: 0.6 + 0.4 * s, range: 8, dur: 0.3, attack: 0.04 });
      kit.hitstop(clamp(10 + dmg * 0.5, 15, 30));
      if (dmg >= 30) kit.shake(0.12);
    }
  }

  fx.on('arrow_hit', (ev, d) => {
    const R = hitCommon(ev, d, 'bowSocket');
    const el = elOf(d.element), rain = !!d.rain, dmg = num(d.damage, 18);
    if (rain) _hd.set(-0.15, -1, -0.2).normalize();
    arrowImpact(_hp, _hg, _hd, el, R, dmg, rain);
    if (!rain || Math.random() < 0.3) audio('boltImpact', _hp);
    return true;
  });

  function orbImpact(p, g, dir, el, R, dmg) {
    const Pl = pal(el, R), col = haloOf(el, R), ramp = rampEl(el, R);
    const s = clamp(dmg / 35, 0.6, 1.5);
    const gp = { x: g.x, y: g.y + 0.05, z: g.z };
    distort(p, 0.45 * s);
    if (el === 'fire') {
      explosion(fx, p, g, 'fire', R, { scale: 0.95 * s, shake: 0.3 * s, hitstop: 46 * s });
      decal(fx, g, 'scorch', 2.4 * s, 'fire', R, { life: 9 });
      afterglow(fx, p, 'fire', R, { radius: 0.9, count: 24, dur: 1.6, ramp: R ? 'rival' : 'ember' });
      audio('burst', p);
      return;
    }
    kit.flash(p, { color: Pl.core, size: [0.5 * s, 2.8 * s], dur: 0.2, intensity: 5, sprite: 'star', pull: 0.6, rival: R });
    kit.flash(p, { color: col, size: [0.8 * s, 3.6 * s], dur: 0.4, intensity: 2.4, sprite: 'glow', pull: 0.6, rival: R });
    kit.light(p, { color: Pl.hot, intensity: 1.6 * s, range: 14, dur: 0.5, attack: 0.03 });
    if (el === 'storm') {
      if (fx.bolts) {
        try {
          _a.set(p.x + 0.6, p.y + 10, p.z - 0.5);
          fx.bolts.strike({ from: _a, to: p, color: Pl.mid, core: Pl.core, width: 0.1, branches: 5, jitter: 0.13, segments: 20, dur: 0.45, intensity: 3.2, rival: R ? 1 : 0 });
          for (let i = 0; i < 2; i++) {
            const a = Math.random() * TAU;
            _b.set(g.x + Math.cos(a) * 1.6 * s, g.y + 0.05, g.z + Math.sin(a) * 1.6 * s);
            fx.bolts.strike({ from: p, to: _b, color: Pl.mid, core: Pl.core, width: 0.05, branches: 2, jitter: 0.18, segments: 10, dur: 0.3, intensity: 2.6, rival: R ? 1 : 0 });
          }
          fx.bolts.groundArcs({ center: g, radius: 3.2 * s, count: 7, dur: 0.6, color: Pl.mid, core: Pl.core, intensity: 2.4, rival: R ? 1 : 0 });
        } catch (e) { /* ignore */ }
      }
      P(p, Math.round(60 * s)); sp(4, 12); lf(0.25, 0.7); sz(0.06, 0.012); oP.ramp = ramp; oP.intensity = 3.6; oP.sprite = 'spark'; oP.stretch = 0.04; oP.gravity = 6; oP.drag = 1.5; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
      P(gp, Math.round(30 * s)); oP.shape = 'ring'; oP.radius = 0.4; oP.radial = 7; oP.dir = UP; oP.cone = 0.3; sp(0, 1); lf(0.2, 0.4); sz(0.25, 0.04); oP.ramp = ramp; oP.intensity = 3; oP.sprite = 'spark'; oP.stretch = 0.03; oP.drag = 4; oP.rival = R; oP.essential = true; go();
      ring(gp, UP, 4.5 * s, 0.4, Pl.mid, Pl.core, R, 2);
      decal(fx, g, 'crack', 2.6 * s, 'storm', R, { life: 7 });
      kit.screenFlash(R ? 0xb49cff : 0xdff2ff, 0.18, 0.08);
      kit.shake(0.34 * s); kit.hitstop(52 * s);
      audio('nova', p);
    } else if (el === 'frost') {
      // ледяные шипы: корона из кристаллов, вырастающих из земли
      const n = Math.round(12 * s);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + rnd(-0.2, 0.2), rr = rnd(0.5, 1.7) * s, h = rnd(0.7, 1.4) * s;
        _c.set(g.x + Math.cos(a) * rr, g.y + h * 0.42, g.z + Math.sin(a) * rr);
        P(_c, 1); sp(0, 0); lf(0.9, 1.3); sz(h * 0.3, h); oP.sizeVar = 0.1; oP.curve = 0.18; oP.ramp = ramp; oP.intensity = 2; oP.sprite = 'shard'; oP.rot = rnd(-0.35, 0.35); oP.delay = 0.08; oP.fadeIn = 0.02; oP.rival = R; oP.essential = true; go();
      }
      for (let i = 0; i < 3; i++) { // центральные высокие
        const h = rnd(1.4, 2) * s;
        _c.set(g.x + rnd(-0.3, 0.3), g.y + h * 0.42, g.z + rnd(-0.3, 0.3));
        P(_c, 1); sp(0, 0); lf(1.1, 1.4); sz(h * 0.3, h); oP.sizeVar = 0.1; oP.curve = 0.18; oP.ramp = ramp; oP.intensity = 2.3; oP.sprite = 'shard'; oP.rot = rnd(-0.2, 0.2); oP.fadeIn = 0.02; oP.rival = R; oP.essential = true; go();
      }
      P(p, Math.round(26 * s)); sp(3, 8); lf(0.5, 1); sz(0.18 * s, 0.05); oP.ramp = ramp; oP.intensity = 2.6; oP.sprite = 'shard'; spin(-9, 9); oP.gravity = 8; oP.drag = 1; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
      P(gp, Math.round(14 * s)); oP.shape = 'ring'; oP.radius = 0.6; oP.radial = 2.5; sp(0, 0.4); lf(1, 1.8); sz(0.7 * s, 1.8 * s); oP.ramp = R ? 'voidsmoke' : 'frostsmoke'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.4; spin(-0.6, 0.6); oP.rival = R; go();
      P(p, Math.round(20 * s)); oP.radius = 1 * s; sp(0.2, 0.8); lf(0.8, 1.6); sz(0.08, 0.03); oP.ramp = ramp; oP.intensity = 2.4; oP.sprite = 'flake'; spin(-3, 3); oP.gravity = 0.8; oP.delay = 0.2; oP.rival = R; go();
      ring(gp, UP, 3.6 * s, 0.45, Pl.mid, Pl.core, R, 1.8);
      decal(fx, g, 'frost', 3 * s, 'frost', R, { life: 9 });
      kit.shake(0.26 * s); kit.hitstop(44 * s);
      audio('burst', p);
    } else { // earth: глыба раскалывается
      P(p, Math.round(22 * s)); oP.radius = 0.2 * s; sp(3, 8); lf(0.8, 1.3); sz(0.3 * s, 0.26 * s); oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; spin(-7, 7); oP.gravity = 12; oP.drag = 0.4; oP.ground = g.y + 0.06; oP.rival = R; oP.essential = true; go();
      P(p, Math.round(26 * s)); oP.radius = 0.15; sp(4, 10); lf(0.5, 0.9); sz(0.09, 0.07); oP.ramp = 'stone'; oP.intensity = 1; oP.sprite = 'debris'; oP.blend = 'alpha'; spin(-10, 10); oP.gravity = 12; oP.ground = g.y + 0.04; oP.rival = R; go();
      P(p, Math.round(30 * s)); sp(3, 9); lf(0.4, 0.9); sz(0.07, 0.012); oP.ramp = R ? 'rival' : 'ember'; oP.intensity = 3; oP.sprite = 'spark'; oP.stretch = 0.03; oP.gravity = 8; oP.drag = 1; oP.ground = g.y + 0.03; oP.rival = R; oP.essential = true; go();
      P(p, Math.round(12 * s)); oP.radius = 0.5 * s; sp(0.5, 2); lf(1.2, 2.2); sz(0.9 * s, 2.4 * s); oP.ramp = 'dust'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 1.3; oP.gravity = -0.3; spin(-0.6, 0.6); oP.delay = 0.05; oP.rival = R; go();
      P(gp, Math.round(26 * s)); oP.shape = 'ring'; oP.radius = 0.5; oP.radial = 6; oP.dir = UP; oP.cone = 0.4; sp(0, 1); lf(0.5, 0.9); sz(0.5 * s, 1.2 * s); oP.ramp = 'dust'; oP.intensity = 1; oP.sprite = 'smoke'; oP.blend = 'alpha'; oP.drag = 3; spin(-1, 1); oP.rival = R; go();
      ring(gp, UP, 4.2 * s, 0.45, E.earth.hot, E.earth.core, R, 1.8);
      decal(fx, g, 'crater', 1.8 * s, 'earth', R, { life: 9 });
      decal(fx, g, 'crack', 3 * s, 'earth', R, { life: 8 });
      kit.shake(0.42 * s); kit.hitstop(56 * s);
      audio('burst', p);
    }
  }

  fx.on('hand_spell_hit', (ev, d) => {
    const R = hitCommon(ev, d, 'handR');
    const el = elOf(d.element) || 'fire';
    orbImpact(_hp, _hg, _hd, el, R, num(d.damage, 35));
    return true;
  });

  // Попадание снаряда без своего события: старый янтарный «пшик» не рисуем; если arrow_hit/hand_spell_hit
  // не пришёл — маленький удар по стихии сами.
  fx.on('projectile_impact', (ev, d) => {
    if (!hasVec(ev && ev.position)) return true;
    const p = new V3(ev.position.x, ev.position.y, ev.position.z);
    const R = fx.isRemote(d), el = elOf(d.element), kind = d.kind;
    kit.after(0.06, () => {
      if (recentHit(p, 0.2)) return;
      const g = new V3(p.x, fx.groundY(p.x, p.z, 0), p.z);
      const dir = hasVec(d.direction) ? new V3(d.direction.x, d.direction.y, d.direction.z) : new V3(0, 0, -1);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      if (kind === 'hand_orb') orbImpact(p, g, dir, el || 'fire', R, 20);
      else arrowImpact(p, g, dir, el, R, 12, false);
    });
    return true;
  }, (d) => d.kind === 'arrow' || d.kind === 'hand_orb');

  // ============================================================ каждый кадр
  const EMPTY = [];
  function endStale(r, key) { if (r.tag !== tag) { recs.delete(key); recEnd(r); } }
  fx.every((dt, snap) => {
    const now = clock();
    // ---- лук: ввод C2 (input.bow) для своего героя, события — для соперника и без ввода
    const inp = fx.input;
    const hasBow = !!inp && typeof inp === 'object' && 'bow' in inp;
    if (hasBow) {
      const bi = inp.bow;
      if (bi && typeof bi === 'object' && bi.active && !bi.release && (LB.phase === 1 || now - LB.lastRel > 0.25)) {
        if (LB.phase !== 1) bowStart(LB, bi.element !== undefined ? elOf(bi.element) : LB.element);
        LB.draw = clamp(num(bi.draw, LB.draw), 0, 1);
        LB.charged = !!bi.charged;
        if (bi.element !== undefined) LB.element = elOf(bi.element);
        LB.lastEv = now; LB.offSince = -1;
      } else if (bi && typeof bi === 'object' && bi.release) {
        if (LB.phase === 1) bowRelease(LB, !!bi.charged, bi.element !== undefined ? elOf(bi.element) : undefined);
      } else if (LB.phase === 1) {
        if (LB.offSince < 0) LB.offSince = now;
        else if (now - LB.offSince > 0.12 && now - LB.lastStart > 0.25) bowFade(LB);
      }
    } else bowPredict(LB, dt);
    bowPredict(RB, dt);
    if (dt > 0) { bowStep(LB, dt); bowStep(RB, dt); }

    // ---- ладонь
    const hsKey = !!inp && typeof inp === 'object' && 'handSpell' in inp;
    if (hsKey) {
      const hs = inp.handSpell;
      const ph = hs && typeof hs === 'object' ? hs.phase : 'idle';
      if (ph === 'form' || ph === 'hold') {
        const el = elOf(hs.element) || 'fire';
        if (!LO.on || LO.el !== el) { if (now - LO.lastEv > 0.2 || LO.on) orbStart(LO, el); }
        if (LO.on) { LO.power = clamp(num(hs.power, LO.power), 0, 1); LO.lastEv = now; LO.offSince = -1; }
      } else if (LO.on) {
        if (LO.offSince < 0) LO.offSince = now;
        else if (now - LO.offSince > 0.15 && now - LO.lastStart > 0.25) orbOff(LO); // тихо гаснет (без throw/cancel)
      }
    } else if (LO.on) {
      LO.power = Math.max(LO.evPower, Math.min(1, LO.t / 1.0));
      if (now - LO.lastEv > 4) orbOff(LO);
    }
    if (RO.on) {
      RO.power = Math.max(RO.evPower, Math.min(1, RO.t / 1.0));
      if (now - RO.lastEv > 4) orbOff(RO);
    }
    if (dt > 0) { orbStep(LO, dt); orbStep(RO, dt); }

    // ---- снаряды
    tag++;
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : EMPTY;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (!pr || (pr.kind !== 'arrow' && pr.kind !== 'hand_orb') || pr.id === undefined || pr.id === null || !hasVec(pr.position)) continue;
      const key = String(pr.id);
      let r = recs.get(key);
      if (!r) { r = recGet(pr); recs.set(key, r); }
      r.tag = tag;
      r.prev.copy(r.pos);
      r.pos.set(pr.position.x, pr.position.y, pr.position.z);
      if (hasVec(pr.velocity)) r.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z);
      else if (dt > 1e-4) r.vel.subVectors(r.pos, r.prev).multiplyScalar(1 / dt);
      r.dir.copy(r.vel);
      if (r.dir.lengthSq() < 1e-8) r.dir.subVectors(r.pos, r.prev);
      if (r.dir.lengthSq() < 1e-8) r.dir.set(0, 0, -1);
      r.dir.normalize();
      if (r.age === 0) r.prev.copy(r.pos).addScaledVector(r.dir, -0.3);
      r.age += dt;
      if (dt <= 0) continue;
      if (r.kind === 'arrow') arrowDraw(r, dt); else orbFlyDraw(r, dt);
    }
    recs.forEach(endStale);
  });
}
