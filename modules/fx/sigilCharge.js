// ASHEN OATH — modules/fx/sigilCharge.js. Владелец: №7 [VFX]. [W3-МАГИЯ]
// Заряд печати: сгусток света между ладонями, пока они сомкнуты (snap.player.sigilCharge / sigilAxis).
//  - ядро (белое, растёт с зарядом) + ореол (золото) + искры, стягивающиеся к ядру по спирали;
//  - щель света по оси растяжения: 'h' — поперёк (бурный голубой, «Врата бури»), 'v' — вертикаль (золото, «Столп небес»);
//  - импульсы света из пула kit.light (на low света нет), гул заряда — петля conjureOrb, тон по заряду;
//  - выпуск (sigil_cast gate/pillar): ядро «схлопывается» вспышкой — дальше рисуют sigilGate / sigilPillar;
//    заряд пропал без каста (медленно, по диагонали, потеря кистей) — сгусток гаснет дымком и падающими искрами.
// Ведёт общее состояние fx.shared.sigil (точка и сила сгустка — в кадре каста снимок уже с нулевым зарядом).
// fx.qa.charge = { charge, axis } — подмена снимка для стенда и видео.
// [W4-ЗАКЛИНАНИЯ] цвет сгустка — стихия героя (LOOKS): ось 'h' — тон молний врат, 'v'/без оси — тон стихии (столп);
// у тьмы — чёрное ядро (darkcore, blend alpha) в приглушённом фиолетовом свечении. Ядро белее, ореол ярче.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const L = fx.legacy || {};
  const HUM = 'sigil-charge';

  const S = fx.shared.sigil = { active: false, charge: 0, peak: 0, axis: null, pos: new V3(0, 1.2, 0), t: -1e9, release: null };

  const UP = { x: 0, y: 1, z: 0 };
  const _l = new V3(), _r = new V3(), _ch = new V3(), _fw = new V3(), _rt = new V3();
  const _a = new V3(), _b = new V3(), _lp = new V3();
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const lights = () => (kit.Q && isNum(kit.Q.lights) ? kit.Q.lights : 0);
  const soft = () => (fx.reduced() ? 0.6 : 1);

  // предвыделенные опции (мутируются в кадре)
  const emCore = { at: new V3(), count: 1, speed: 0, life: [0.09, 0.14], size: [0.3, 0.26], sizeVar: 0.15, ramp: 'whiteHold', intensity: 2.6, sprite: 'glow', fadeIn: 0.2, essential: true, rival: false };
  const emHalo = { at: new V3(), count: 1, speed: [0, 0.05], life: [0.16, 0.24], size: [0.8, 0.7], sizeVar: 0.2, ramp: 'gold', intensity: 1.1, alpha: 0.55, sprite: 'glow', fadeIn: 0.3, essential: true, rival: false };
  const emSpark = { at: new V3(), shape: 'shell', radius: 0.5, count: 1, radial: -1.6, speed: [0, 0.1], tangent: 0, life: [0.26, 0.34], size: [0.08, 0.02], ramp: 'gold', intensity: 2.6, sprite: 'spark', stretch: 0.035, fadeIn: 0.25, essential: true, rival: false };
  const emMote = { at: new V3(), shape: 'sphere', radius: 0.18, count: 1, speed: [0.05, 0.25], life: [0.3, 0.5], size: [0.035, 0.01], ramp: 'storm', intensity: 2.2, sprite: 'dot', turb: 0.6, essential: true, rival: false };
  const emSlit = { at: new V3(), shape: 'line', to: new V3(), radius: 0.01, count: 1, speed: [0, 0.03], life: [0.07, 0.12], size: [0.12, 0.08], ramp: 'storm', intensity: 3, sprite: 'glow', fadeIn: 0.1, essential: true, rival: false };
  // ядро и ореол — вспышки со сдвигом к камере: камера за спиной, ладони у груди закрыты телом героя
  const flCore = { ramp: 'whiteHold', size: [0.5, 0.45], curve: 0.5, dur: 0.11, intensity: 3, sprite: 'glow', pull: 0.75, fadeIn: 0.3, rival: false };
  const flHalo = { ramp: 'gold', size: [1.2, 1.1], curve: 0.5, dur: 0.16, intensity: 1.4, alpha: 0.7, sprite: 'glow', pull: 0.7, fadeIn: 0.35, rival: false };
  const flStar = { ramp: 'gold', size: [0.9, 0.8], curve: 0.5, dur: 0.12, intensity: 2.2, sprite: 'star', pull: 0.8, fadeIn: 0.3, spin: 0, rot: 0, rival: false };
  // аура вокруг героя и кольцо света у ног — видны и со спины
  const emAura = { at: new V3(), shape: 'ring', normal: UP, radius: 0.55, count: 1, dir: UP, cone: 0.15, speed: [0.6, 1.4], life: [0.6, 0.9], size: [0.07, 0.02], ramp: 'gold', intensity: 2.4, sprite: 'spark', stretch: 0.03, drag: 0.4, orbit: 2.2, center: new V3(), essential: true, rival: false };
  const emFloor = { at: new V3(), shape: 'ring', normal: UP, radius: 0.9, count: 1, dir: UP, cone: 0.05, speed: [0, 0.05], radial: -0.4, life: [0.35, 0.5], size: [0.16, 0.1], ramp: 'gold', intensity: 1.6, sprite: 'glow', alpha: 0.8, essential: true, rival: false };
  const _ft = new V3();
  let accFlash = 0, accAura = 0, accFloor = 0, starRot = 0;
  const lightOpt = { color: 0xffe2a8, intensity: 0.5, range: 5, dur: 0.42, attack: 0.45, follow: null };
  const followCore = () => S.pos;
  lightOpt.follow = followCore;

  // [W4-ЗАКЛИНАНИЯ] вид сгустка по стихии героя; берётся один раз в начале заряда (и при выпуске), не в кадре
  const E = fx.E;
  const look = (v, h, litV, litH, dark) => Object.freeze({ v, h, litV, litH,
    core: dark ? 'darkcore' : 'whiteHold', blend: dark ? 'alpha' : 'add', glow: dark ? v : 'whiteHold', glowK: dark ? 0.45 : 1 });
  const LOOKS = {
    fire: look('fire', 'gold', E.fire.hot, 0xffe2a8, false),        // 'h' — бело-золотые молнии, 'v' — пламя
    storm: look('storm', 'storm', 0xb8dcff, 0xb8dcff, false),
    void: look('void', 'void', E.void.hot, E.void.hot, true),
    wind: look('wind', 'wind', E.wind.hot, E.wind.hot, false),
    tempest: look('tempest', 'tempest', E.tempest.hot, E.tempest.hot, false),
  };
  let LK = LOOKS.fire;
  function pickLook() {
    LK = LOOKS[fx.heroEl(null)] || LOOKS.fire;
    emCore.ramp = LK.core; emCore.blend = LK.blend; flCore.ramp = LK.glow; emMote.ramp = LK.h;
  }

  let accCore = 0, accHalo = 0, accSpark = 0, accMote = 0, accSlit = 0;
  let hum = false, ctlT = 0, lightT = 0, lastCharge = 0, castT = -1e9;

  // центр сгустка: между ладонями; если кисти героя не сходятся (отладка с клавиатуры, нет модели) —
  // перед грудью по направлению на цель
  function corePos(out) {
    fx.anchor('handL', _l, false); fx.anchor('handR', _r, false);
    fx.anchor('chest', _ch, false);
    fx.facing(_fw, false);
    const gap = _l.distanceTo(_r);
    if (gap <= 0.5) out.set((_l.x + _r.x) * 0.5, (_l.y + _r.y) * 0.5, (_l.z + _r.z) * 0.5);
    else out.set(_ch.x + _fw.x * 0.42, _ch.y + 0.08, _ch.z + _fw.z * 0.42);
    return out;
  }

  fx.every((dt, snap) => {
    const qa = fx.qa && fx.qa.charge;
    const pl = snap && snap.player;
    let ch = 0, axis = null;
    if (qa && isNum(qa.charge)) { ch = clamp(qa.charge, 0, 1); axis = qa.axis === 'h' || qa.axis === 'v' ? qa.axis : null; }
    else if (pl && snap.status !== 'ended') { ch = isNum(pl.sigilCharge) ? clamp(pl.sigilCharge, 0, 1) : 0; axis = pl.sigilAxis === 'h' || pl.sigilAxis === 'v' ? pl.sigilAxis : null; }
    const was = S.active;
    S.active = ch > 0.02;
    if (S.active) {
      corePos(S.pos);
      if (!was) { S.peak = 0; pickLook(); }
      S.charge = ch; S.peak = Math.max(S.peak, ch); S.axis = axis; S.t = kit.clock;
    } else {
      S.charge = 0;
      // заряд пропал без каста — сгусток гаснет
      if (was && kit.clock - castT > 0.25 && S.peak > 0.15) fizzle();
      if (kit.clock - S.t > 1.5) { S.peak = 0; S.axis = null; }
    }
    // гул: тон растёт с зарядом; петлю подтверждаем каждый кадр (движок глушит петли на паузе и сбросе)
    if (S.active) {
      if (typeof L.loop === 'function') { L.loop(HUM, 'conjureOrb', S.pos); hum = true; }
      if (hum && typeof L.loopCtl === 'function' && kit.clock >= ctlT) { ctlT = kit.clock + 0.05; L.loopCtl(HUM, ch); }
    } else if (hum) { hum = false; if (typeof L.loopStop === 'function') L.loopStop(HUM, 0.12); }
    lastCharge = ch;
    if (!S.active || !(dt > 0)) { accCore = accHalo = accSpark = accMote = accSlit = accFlash = accAura = accFloor = 0; return; }

    const dec = decor(), sf = soft();
    const ar = axis === 'h' ? LK.h : LK.v;                 // [W4-ЗАКЛИНАНИЯ] градиент стихии героя по оси
    const pulse = 0.85 + 0.15 * Math.sin(kit.clock * (9 + 10 * ch));
    // ядро/ореол/звезда — каждые ~1/18 с (вспышки не масштабируются качеством: по одной на слой)
    accFlash += dt * 18;
    if (accFlash >= 1) {
      accFlash -= Math.floor(accFlash);
      const s = (0.35 + 0.85 * ch) * pulse;
      flCore.size[0] = s; flCore.size[1] = s * 0.92; flCore.intensity = (2.8 + 1.6 * ch) * sf * LK.glowK;   // [W4-ЗАКЛИНАНИЯ] белее
      kit.flash(S.pos, flCore);
      const hs = 1 + 1.9 * ch;
      flHalo.size[0] = hs; flHalo.size[1] = hs * 0.95; flHalo.ramp = ar; flHalo.intensity = (1.1 + 1.0 * ch) * sf;
      kit.flash(S.pos, flHalo);
      if (ch > 0.25) {
        starRot += 0.35; const ss = 0.6 + 1.6 * ch;
        flStar.size[0] = ss; flStar.size[1] = ss * 0.9; flStar.rot = starRot; flStar.ramp = ar;
        flStar.intensity = (1.2 + 1.6 * ch) * sf;
        kit.flash(S.pos, flStar);
      }
    }
    // аура: искры поднимаются по спирали вокруг героя
    fx.anchor('feet', _ft, false);
    accAura += dt * (10 + 40 * ch) * dec;
    let na = Math.floor(accAura);
    if (na > 0) {
      accAura -= na;
      emAura.at.set(_ft.x, _ft.y + 0.15, _ft.z); emAura.center.copy(emAura.at); emAura.count = na;
      emAura.radius = 0.5 + 0.25 * ch; emAura.ramp = ar;
      kit.emit(emAura);
    }
    // кольцо света у ног — сжимается к герою
    accFloor += dt * (20 + 50 * ch) * dec;
    na = Math.floor(accFloor);
    if (na > 0) {
      accFloor -= na;
      emFloor.at.set(_ft.x, _ft.y + 0.04, _ft.z); emFloor.count = na; emFloor.radius = 0.7 + 0.6 * ch;
      emFloor.ramp = ar; emFloor.intensity = (1 + 1.2 * ch) * sf;
      kit.emit(emFloor);
    }
    // ядро: неподвижные тающие точки — сплошной шар, растёт и разгорается с зарядом
    accCore += dt * 70;
    let n = Math.floor(accCore);
    if (n > 0) {
      accCore -= n;
      const s = (0.12 + 0.38 * ch) * pulse;
      emCore.at.copy(S.pos); emCore.count = n; emCore.size[0] = s; emCore.size[1] = s * 0.85;
      emCore.intensity = (1.6 + 1.6 * ch) * sf;
      kit.emit(emCore);
    }
    // ореол
    accHalo += dt * 22;
    n = Math.floor(accHalo);
    if (n > 0) {
      accHalo -= n;
      const s = 0.45 + 0.9 * ch;
      emHalo.at.copy(S.pos); emHalo.count = n; emHalo.size[0] = s; emHalo.size[1] = s * 0.9;
      emHalo.ramp = ar;
      emHalo.intensity = (0.8 + 0.9 * ch) * sf;
      kit.emit(emHalo);
    }
    // искры стягиваются к ядру по спирали (частота по заряду и качеству)
    accSpark += dt * (14 + 46 * ch) * dec;
    n = Math.floor(accSpark);
    if (n > 0) {
      accSpark -= n;
      const r = 0.6 + 0.8 * ch;
      emSpark.at.copy(S.pos); emSpark.count = n; emSpark.radius = r;
      emSpark.radial = -r / 0.3; emSpark.ramp = ar;
      kit.emit(emSpark);
    }
    // искорки-«пылинки» у ядра — электричество при сильном заряде
    if (ch > 0.35) {
      accMote += dt * 30 * (ch - 0.3) * dec;
      n = Math.floor(accMote);
      if (n > 0) { accMote -= n; emMote.at.copy(S.pos); emMote.count = n; emMote.radius = 0.12 + 0.2 * ch; kit.emit(emMote); }
    }
    // щель света по оси: 'h' — поперёк направления на цель, 'v' — вертикаль
    if (axis) {
      accSlit += dt * 90;
      n = Math.floor(accSlit);
      if (n > 0) {
        accSlit -= n;
        const half = 0.35 + 1.25 * ch;
        if (axis === 'h') { fx.right(_rt, false); _a.copy(_rt).multiplyScalar(half); }
        else _a.set(0, half, 0);
        emSlit.at.copy(S.pos).sub(_a); emSlit.to.copy(S.pos).add(_a);
        emSlit.count = n * 3; emSlit.ramp = ar;
        emSlit.intensity = (2.4 + 0.6 * ch) * sf;
        kit.emit(emSlit);
      }
    } else accSlit = 0;
    // свет: короткие импульсы, следящие за ядром (на low пул пуст)
    if (lights() > 0 && kit.clock >= lightT && ch > 0.1) {
      lightT = kit.clock + 0.36;
      lightOpt.intensity = 0.25 + 0.5 * ch; lightOpt.color = axis === 'h' ? LK.litH : LK.litV;
      kit.light(S.pos, lightOpt);
    }
  });

  function fizzle() {
    _lp.copy(S.pos);
    kit.emit({ at: _lp, count: 8, shape: 'sphere', radius: 0.15, speed: [0.1, 0.4], life: [0.5, 0.9], size: [0.25, 0.5], sprite: 'smoke', blend: 'alpha', ramp: 'smoke', intensity: 1, alpha: 0.5, gravity: -0.4, drag: 1.5 });
    kit.emit({ at: _lp, count: 14, speed: [0.4, 1.4], life: [0.35, 0.6], size: [0.04, 0.01], ramp: S.axis === 'h' ? LK.h : LK.v, intensity: 2, sprite: 'spark', stretch: 0.02, gravity: 5, drag: 1 });
  }

  // выпуск: сгусток схлопывается в точку и вспыхивает — дальше рисуют врата/столп (обработчик-добавка)
  fx.on('sigil_cast', (ev, d) => {
    if (d && d.remote) return undefined;
    castT = kit.clock;
    S.release = d.sigil;
    const pw = isNum(d.power) ? clamp(d.power, 0, 1) : 0.6;
    // свежий заряд — его точка; иначе (стенд/тест без заряда) — перед грудью
    if (kit.clock - S.t > 0.5) corePos(S.pos);
    const P = S.pos, sf = soft(), gate = d.sigil === 'gate';
    pickLook();                                            // [W4-ЗАКЛИНАНИЯ] стихия героя; белое ядро и звезда ярче
    const ar = gate ? LK.h : LK.v;
    kit.flash(P, { ramp: 'whiteHold', size: [1.1 + 0.9 * pw, 0.2], curve: 0.6, dur: 0.16, intensity: 4.5 * sf, sprite: 'glow', pull: 0.3 });
    kit.flash(P, { ramp: ar, size: [0.5, 2.6 + 1.6 * pw], dur: 0.24, intensity: 3.6 * sf, sprite: 'star', pull: 0.35 });
    kit.emit({ at: P, shape: 'shell', radius: 0.08, count: Math.round(26 + 34 * pw), radial: 5 + 4 * pw, speed: [0, 0.4], life: [0.18, 0.32], size: [0.06, 0.01], ramp: ar, intensity: 3, sprite: 'spark', stretch: 0.05, drag: 2.5 });
    if (hum && typeof L.loopStop === 'function') { hum = false; L.loopStop(HUM, 0.05); }
    S.active = false; S.charge = 0;
    return undefined;
  }, (d) => d && (d.sigil === 'gate' || d.sigil === 'pillar'));

  fx.onClear(() => {
    S.active = false; S.charge = 0; S.peak = 0; S.axis = null; S.release = null; S.t = -1e9;
    accCore = accHalo = accSpark = accMote = accSlit = 0; lastCharge = 0;
    if (typeof L.loopStop === 'function') L.loopStop(HUM, 0.05);
    hum = false;
  });
  fx.onDispose(() => { if (typeof L.loopStop === 'function') L.loopStop(HUM, 0); hum = false; });
  void lastCharge;
}
