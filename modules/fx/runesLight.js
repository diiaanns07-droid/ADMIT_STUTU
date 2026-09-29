// ASHEN OATH — modules/fx/runesLight.js. Владелец: №7 [VFX].
// Светлые руны V6 (хореографии поверх effects.js; ритм и приёмы — как в runesFire.js):
//   ○ ОРБИС  — лечение + оберег: золотисто-зелёные винтовые потоки искр поднимаются от кольца у ног
//              и сходятся над головой, лепестки, круг с символом на земле, тёплый свет на лице,
//              короткий импульс защитной оболочки. Пока действует оберег (snap.player.warded) —
//              редкие золотые искры кружат у груди.
//   ∞ ЛЕМНИС — вечность: две светящиеся ленты чертят «восьмёрку» вокруг тела на высоте груди,
//              отложенные вспышки на 0.4 / 0.8 / 1.2 с. Пока идёт лечение (snap.player.regen) —
//              медленная лента-восьмёрка и мягкий импульс раз в секунду (старый 'regen' подавлен).
//   ℓ АЛЬФА  — сброс откатов: осколки слетаются к груди (время идёт вспять), «часовой» глиф-нимб
//              заполняется развёрткой, затем кольца перезарядки (вертикальное и по земле) и столб света.
// Силуэты: винт вверх (орбис) ≠ горизонтальная восьмёрка (лемнис) ≠ схлопывание + кольца + столб (альфа).

import { caster, runeCircle, gather, rampOf, trail, clamp, TAU, isNum } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const UP = { x: 0, y: 1, z: 0 };
  const reduced = () => { try { return !!fx.reduced(); } catch (e) { return false; } };
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const audio = (k, p) => { try { if (fx.legacy && fx.legacy.audio) fx.legacy.audio(k, p); } catch (e) { /* ignore */ } };
  const shock = (kind, o) => {
    if (!fx.shock || typeof fx.shock[kind] !== 'function') return null;
    try { return fx.shock[kind](o); } catch (e) { return null; }
  };
  const glyph = (o) => { if (!fx.glyph) return null; try { return fx.glyph.spawn(o); } catch (e) { return null; } };
  const flare = (h, a) => { if (h && h.flare) { try { h.flare(a); } catch (e) { /* ignore */ } } };
  const stopTrail = (tr) => { if (tr && tr.stop) { try { tr.stop(); } catch (e) { /* ignore */ } } };

  // Лемниската Бернулли в плоскости «вправо–вверх» (к камере за спиной — читаемый знак ∞),
  // с обхватом тела по глубине: на одном проходе перекрестья лента идёт перед грудью, на другом — за спиной.
  function lemPoint(out, t, C, rt, fw, a, b, dz) {
    const s = Math.sin(t), co = Math.cos(t), den = 1 + s * s;
    const x = a * co / den, y = b * s * co / den, z = -dz * s;
    return out.set(C.x + rt.x * x + fw.x * z, C.y + y, C.z + rt.z * x + fw.z * z);
  }

  // ============================================================ ○ ОРБИС
  // Винтовые потоки: частицы рождаются в неподвижных точках кольца у ног, поднимаются и закручиваются
  // вокруг вертикальной оси (orbit) со сжатием радиуса (rgrow) — непрерывный выпуск даёт спираль-«винт».
  const emHelix = {
    at: new V3(), center: new V3(), count: 1, speed: [0, 0.1], vel: { x: 0, y: 2.2, z: 0 }, orbit: 3.3, rgrow: -0.26,
    life: [0.85, 1.0], size: [0.085, 0.025], sizeVar: 0.2, ramp: 'heal', intensity: 3.2, sprite: 'spark', stretch: 0.022,
    fadeIn: 0.04, essential: true, rival: false,
  };
  const emHelixGlow = {
    at: new V3(), center: new V3(), count: 1, speed: [0, 0.08], vel: { x: 0, y: 2.2, z: 0 }, orbit: 3.3, rgrow: -0.26,
    life: [0.55, 0.75], size: [0.34, 0.1], ramp: 'heal', intensity: 1.25, sprite: 'glow', fadeIn: 0.1, essential: true, rival: false,
  };
  const _hd = new V3(), _oc = new V3();
  function helix(c, R, ramp) {
    const N = kit.Q && kit.Q.name === 'high' ? 4 : 3;
    const rate = 60 * decor(), gRate = 11 * decor();
    const acc = [0, 0, 0, 0], gacc = [0.5, 0.2, 0.8, 0.4];
    const a0 = Math.random() * TAU, feet = c.feet;
    kit.actor({
      dur: 0.95,
      update(t, k, dt) {
        if (!(dt > 0)) return;
        fx.anchor('feet', feet, R);
        emHelix.ramp = emHelixGlow.ramp = ramp; emHelix.rival = emHelixGlow.rival = R;
        emHelix.center.copy(feet); emHelixGlow.center.copy(feet);
        const m = k < 0.72 ? 1 : Math.max(0, (1 - k) / 0.28);
        const r0 = 0.92;
        for (let s = 0; s < N; s++) {
          const a = a0 + s * TAU / N + t * 0.9;
          emHelix.at.set(feet.x + Math.cos(a) * r0, feet.y + 0.06, feet.z + Math.sin(a) * r0);
          acc[s] += dt * rate * m;
          const n = Math.floor(acc[s]);
          if (n > 0) { acc[s] -= n; emHelix.count = n; kit.emit(emHelix); }
          gacc[s] += dt * gRate * m;
          if (gacc[s] >= 1) { gacc[s] -= 1; emHelixGlow.at.copy(emHelix.at); kit.emit(emHelixGlow); }
        }
      },
    });
  }
  function orbisShell(c, R, P, ramp) {
    fx.anchor('chest', c.chest, R);
    const at = { x: c.chest.x, y: c.chest.y - 0.2, z: c.chest.z };
    const soft = reduced() ? 0.6 : 1;
    kit.emit({ at, shape: 'shell', radius: 0.95, count: 70, radial: 1.1, speed: [0, 0.05], drag: 2.4, life: [0.35, 0.55], size: [0.11, 0.04], ramp, intensity: 2.1, sprite: 'glow', fadeIn: 0.25, rival: R });
    kit.flash(at, { color: P.mid, size: [1.1, 1.8], dur: 0.42, intensity: 1.5 * soft, sprite: 'ring', pull: 0.2, rival: R, curve: 0.6 });
    kit.flash(at, { color: P.hot, size: [0.6, 1.5], dur: 0.35, intensity: 0.7 * soft, sprite: 'glow', pull: 0.6, rival: R });
    shock('sphere', { pos: at, r0: 0.7, r1: 1.45, dur: 0.5, color: P.mid, hot: P.core, intensity: 1.1, distort: 0.25, rival: R ? 1 : 0 });
  }
  function orbisPetals(c, R) {
    fx.anchor('head', c.head, R);
    kit.emit({
      at: { x: c.head.x, y: c.head.y + 0.4, z: c.head.z }, radius: 0.8, count: 22, dir: UP, cone: 1.3, speed: [0.3, 1.0],
      gravity: 0.45, drag: 1.5, turb: 0.7, life: [1.4, 2.3], size: [0.14, 0.1], sizeVar: 0.35, ramp: R ? 'rival' : 'heal',
      intensity: 1.7, sprite: 'petal', spin: [-2.5, 2.5], fadeIn: 0.15, rival: R,
    });
  }
  function orbisBloom(c, R, P, ramp) {
    fx.anchor('chest', c.chest, R);
    const soft = reduced() ? 0.6 : 1;
    kit.flash(c.chest, { color: P.core, size: [0.2, 1.0], dur: 0.28, intensity: 2.6 * soft, sprite: 'star', pull: 0.7, rival: R });
    kit.flash(c.chest, { color: P.hot, size: [0.4, 1.4], dur: 0.6, intensity: 1.2 * soft, sprite: 'glow', pull: 0.7, rival: R });
    kit.emit({ at: c.chest, radius: 0.45, count: 22, dir: UP, cone: 0.9, speed: [0.4, 1.3], gravity: -0.4, drag: 1, turb: 0.4, life: [0.7, 1.2], size: [0.13, 0.03], ramp, intensity: 2.4, sprite: 'star', spin: [-1, 1], rival: R });
  }
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('heal', d), ramp = rampOf('heal', R), rv = R ? 1 : 0, soft = reduced() ? 0.6 : 1;
    runeCircle(fx, c, 'orbis', 'heal', { radius: 1.9, dur: 2.3, spin: 0.45, rings: 3, intensity: 1.9, unfold: 0.35, motes: 30 });
    // волна света по земле от ног
    const g = { x: c.feet.x, y: c.feet.y + 0.06, z: c.feet.z };
    kit.emit({ at: g, shape: 'ring', radius: 0.4, count: 40, radial: 4.2, drag: 3, speed: [0, 0.2], dir: UP, cone: 0.2, life: [0.4, 0.65], size: [0.34, 0.12], ramp, intensity: 1.8, sprite: 'glow', rival: R });
    shock('ring', { pos: g, r0: 0.3, r1: 2.4, dur: 0.6, color: P.mid, hot: P.core, intensity: 1.4, thickness: 0.18, rival: rv });
    helix(c, R, ramp);
    // тёплый свет на лице и груди
    kit.light(c.head, { color: P.hot, intensity: 1.1 * soft, range: 5, dur: 1.0, attack: 0.35, follow: () => fx.anchor('head', _hd, R) });
    kit.flash(c.chest, { color: P.hot, size: [0.3, 1.2], dur: 0.5, intensity: 1.3 * soft, sprite: 'glow', pull: 0.7, rival: R, fadeIn: 0.3 });
    kit.after(0.3, () => orbisShell(c, R, P, ramp));
    kit.after(0.4, () => orbisPetals(c, R));
    kit.after(0.55, () => orbisBloom(c, R, P, ramp));
    audio('cast', c.chest);
    return true;
  }, (d) => d.rune === 'orbis');

  // оберег: золотые искры медленно кружат у груди (≤ 16/с)
  const emWard = {
    at: new V3(), center: new V3(), shape: 'ring', radius: 0.58, normal: UP, count: 1, dir: UP, cone: 0.7, speed: [0.02, 0.14],
    orbit: 2.3, life: [0.9, 1.3], size: [0.07, 0.02], ramp: 'gold', intensity: 2.0, sprite: 'spark', fadeIn: 0.35, essential: true, rival: false,
  };
  let wardAcc = 0;

  // ============================================================ ∞ ЛЕМНИС
  const _lc = new V3(), _lr = new V3(), _lf = new V3(), _lp = new V3();
  const emRib = {
    at: new V3(), to: new V3(), shape: 'line', count: 1, speed: [0, 0.06], life: [0.36, 0.48], size: [0.17, 0.03], sizeVar: 0.15,
    ramp: 'eternal', intensity: 2.6, sprite: 'glow', fadeIn: 0.03, essential: true, rival: false,
  };
  const emRibCore = {
    at: new V3(), to: new V3(), shape: 'line', count: 1, speed: [0, 0.04], life: [0.16, 0.24], size: [0.07, 0.03], sizeVar: 0.1,
    ramp: 'whiteHold', intensity: 3.2, sprite: 'dot', fadeIn: 0.02, essential: true, rival: false,
  };
  const emDust = {
    at: null, count: 1, speed: [0.1, 0.5], gravity: -0.35, drag: 1.2, turb: 0.5, life: [0.6, 1.1], size: [0.06, 0.015],
    ramp: 'eternal', intensity: 2.4, sprite: 'spark', essential: true, rival: false,
  };
  // Две ленты восьмёркой: сначала раскрываются из груди, затем бегут по знаку ∞, гаснут к 1.6 с.
  function lemRibbons(c, R, ramp) {
    const trs = [
      trail(fx, 'eternal', R, { style: 'energy', width: 0.12, life: 0.42, intensity: 2.4, taper: 1, maxPoints: 40, minDist: 0.03 }),
      trail(fx, 'eternal', R, { style: 'energy', width: 0.12, life: 0.42, intensity: 2.4, taper: 1, maxPoints: 40, minDist: 0.03 }),
    ];
    const cur = [new V3(), new V3()], prev = [new V3(), new V3()];
    const dacc = [0, 0.5];
    let started = false;
    const spacing = 0.07 / Math.max(0.45, decor());
    kit.actor({
      dur: 1.6,
      update(t, k, dt) {
        if (!(dt > 0)) return;
        fx.anchor('chest', _lc, R); fx.facing(_lf, R); _lr.set(-_lf.z, 0, _lf.x);
        const g = Math.min(1, t / 0.32), e = 1 - Math.pow(1 - g, 3), sc = 0.3 + 0.7 * e;
        const fade = k > 0.78 ? Math.max(0, (1 - k) / 0.22) : 1;
        const ph = Math.PI / 2 + t * TAU / 1.25;
        emRib.ramp = emDust.ramp = ramp; emRib.rival = emRibCore.rival = emDust.rival = R;
        emRib.intensity = 2.6 * fade; emRibCore.intensity = 3.2 * fade;
        for (let i = 0; i < 2; i++) {
          lemPoint(cur[i], ph + i * Math.PI, _lc, _lr, _lf, 1.12 * sc, 1.0 * sc, 0.38 * sc);
          const tr = trs[i];
          if (tr && tr.alive !== false) {
            try { tr.push(cur[i]); if (tr.setIntensity) tr.setIntensity(2.4 * fade); } catch (err) { trs[i] = null; }
          }
          if (started) {
            const L = cur[i].distanceTo(prev[i]);
            if (!trs[i]) {
              // запасной вариант без лент: густая нить из свечений + белая сердцевина
              emRib.at.copy(prev[i]); emRib.to.copy(cur[i]); emRib.count = Math.min(4, Math.max(1, Math.round(L / spacing)));
              kit.emit(emRib);
              emRibCore.at.copy(prev[i]); emRibCore.to.copy(cur[i]); emRibCore.count = Math.min(3, Math.max(1, Math.round(L / (spacing * 1.4))));
              kit.emit(emRibCore);
            }
            // звёздная пыль с лент
            dacc[i] += dt * 20 * decor() * fade;
            if (dacc[i] >= 1) { dacc[i] -= 1; emDust.at = cur[i]; kit.emit(emDust); }
          }
          prev[i].copy(cur[i]);
        }
        started = true;
      },
      end() { stopTrail(trs[0]); stopTrail(trs[1]); },
    });
  }
  // Отложенная вспышка на восьмёрке (ph — параметр точки); big — финальная, у груди.
  function lemBurst(c, R, P, ramp, ph, big) {
    fx.anchor('chest', _lc, R); fx.facing(_lf, R); _lr.set(-_lf.z, 0, _lf.x);
    const p = lemPoint(new V3(), ph, _lc, _lr, _lf, 1.12, 1.0, 0.38);
    const soft = reduced() ? 0.55 : 1, s = big ? 1.35 : 1;
    kit.flash(p, { color: P.core, size: [0.12, 0.75 * s], dur: 0.22, intensity: 3.4 * soft, sprite: 'star', pull: 0.4, rival: R });
    kit.flash(p, { color: P.mid, size: [0.3, 1.0 * s], dur: 0.42, intensity: 1.5 * soft, sprite: 'glow', pull: 0.4, rival: R });
    kit.flash(p, { color: P.hot, size: [0.15, 1.0 * s], dur: 0.36, intensity: 1.8 * soft, sprite: 'ring', pull: 0.4, rival: R });
    kit.emit({ at: p, count: big ? 26 : 16, speed: [1.2, 3.2], drag: 3, life: [0.3, 0.6], size: [0.075, 0.015], ramp, intensity: 3, sprite: 'spark', stretch: 0.025, essential: true, rival: R });
    if (big) {
      kit.light(p, { color: P.hot, intensity: 0.9 * soft, range: 6, dur: 0.6, attack: 0.08 });
      kit.emit({ at: _lc, radius: 0.5, count: 18, dir: UP, cone: 0.8, speed: [0.4, 1.2], gravity: -0.3, drag: 1, turb: 0.4, life: [0.7, 1.2], size: [0.12, 0.03], ramp, intensity: 2.3, sprite: 'star', spin: [-1, 1], rival: R });
    }
  }

  // Лечение во времени: медленная лента-восьмёрка и мягкий импульс раз в секунду.
  // [0] — наш герой (по снимку snap.player.regen), [1] — соперник (по таймеру из rune_cast: в снимке нет его regen).
  function mkRegen(remote) {
    return { remote, k: 0, phase: Math.PI / 2, acc: 0, pulse: 0.35, tr: null, has: false, prev: new V3(), cur: new V3(), until: 0, showUntil: 0 };
  }
  const regen = [mkRegen(false), mkRegen(true)];
  const _rc = new V3(), _rr = new V3(), _rf = new V3();
  const emRegen = {
    at: new V3(), to: new V3(), shape: 'line', count: 1, speed: [0, 0.05], life: [0.55, 0.75], size: [0.12, 0.02], sizeVar: 0.15,
    ramp: 'eternal', intensity: 1.9, sprite: 'glow', fadeIn: 0.05, essential: true, rival: false,
  };
  const emRegenMote = {
    at: new V3(), radius: 0.5, count: 5, dir: UP, cone: 0.7, speed: [0.3, 0.9], gravity: -0.3, drag: 1, turb: 0.35, life: [0.7, 1.1],
    size: [0.1, 0.02], ramp: 'eternal', intensity: 2.0, sprite: 'star', spin: [-1, 1], essential: false, rival: false,
  };
  const pulseFlash = { color: 0xffe9a8, size: [0.3, 1.1], dur: 0.6, intensity: 1.1, sprite: 'glow', pull: 0.7, rival: false, fadeIn: 0.35 };
  const pulseStar = { color: 0xfffdf2, size: [0.1, 0.5], dur: 0.3, intensity: 2.2, sprite: 'star', pull: 0.3, rival: false };
  function regenStep(st, dt, snap) {
    let want;
    if (st.remote) want = !!(snap.opponent && snap.opponent.position && snap.opponent.action !== 'dead' && kit.clock < st.until);
    else want = !!(snap.player && snap.player.regen && snap.player.action !== 'dead');
    const gate = want && kit.clock >= st.showUntil;
    st.k += ((gate ? 1 : 0) - st.k) * Math.min(1, dt * (gate ? 2.5 : 4));
    if (!gate && st.k < 0.03) {
      st.k = 0; st.has = false;
      if (st.tr) { stopTrail(st.tr); st.tr = null; }
      return;
    }
    const R = st.remote, P = fx.pal('eternal', { remote: R });
    st.phase += dt * TAU / 2.8;
    if (st.phase > 1e4) st.phase %= TAU;
    fx.anchor('chest', _rc, R); fx.facing(_rf, R); _rr.set(-_rf.z, 0, _rf.x);
    lemPoint(st.cur, st.phase, _rc, _rr, _rf, 0.95, 0.9, 0.36);
    if (st.tr && st.tr.alive === false) st.tr = null;
    if (!st.tr && gate && fx.trails) st.tr = trail(fx, 'eternal', R, { style: 'energy', width: 0.07, life: 0.8, intensity: 1.5, taper: 1, maxPoints: 48, minDist: 0.04 });
    if (st.tr) {
      try { st.tr.push(st.cur); if (st.tr.setIntensity) st.tr.setIntensity(1.5 * st.k); } catch (e) { st.tr = null; }
    } else if (st.has) {
      st.acc += dt * 32 * decor();
      const n = Math.floor(st.acc);
      if (n > 0) {
        st.acc -= n;
        emRegen.at.copy(st.prev); emRegen.to.copy(st.cur); emRegen.count = Math.min(3, n);
        emRegen.intensity = 1.9 * st.k; emRegen.ramp = rampOf('eternal', R); emRegen.rival = R;
        kit.emit(emRegen);
      }
    }
    st.pulse -= dt;
    if (st.pulse <= 0 && gate) {
      st.pulse = 1.0;
      const soft = reduced() ? 0.6 : 1;
      pulseFlash.color = P.hot; pulseFlash.intensity = 1.1 * st.k * soft; pulseFlash.rival = R;
      kit.flash(_rc, pulseFlash);
      pulseStar.color = P.core; pulseStar.intensity = 2.2 * st.k * soft; pulseStar.rival = R;
      kit.flash(st.cur, pulseStar);
      emRegenMote.at.copy(_rc); emRegenMote.at.y -= 0.3; emRegenMote.ramp = rampOf('eternal', R); emRegenMote.rival = R;
      kit.emit(emRegenMote);
    }
    st.prev.copy(st.cur); st.has = true;
  }

  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('eternal', d), ramp = rampOf('eternal', R), soft = reduced() ? 0.6 : 1;
    runeCircle(fx, c, 'lemnis', 'eternal', { radius: 1.8, dur: 2.5, spin: 0.3, rings: 3, intensity: 1.8, unfold: 0.4 });
    gather(fx, c.chest, 'eternal', R, { time: 0.2, radius: 0.9, count: 26, glow: 0.7 });
    lemRibbons(c, R, ramp);
    kit.after(0.4, () => lemBurst(c, R, P, ramp, 0, false));            // правая петля
    kit.after(0.8, () => lemBurst(c, R, P, ramp, Math.PI, false));      // левая петля
    kit.after(1.2, () => lemBurst(c, R, P, ramp, Math.PI / 2, true));   // перекрестье перед грудью
    kit.light(c.chest, { color: P.hot, intensity: 0.8 * soft, range: 5, dur: 1.4, attack: 0.3, follow: () => fx.anchor('chest', _oc, R) });
    // дальше — лечение во времени (см. regenStep); лента вечности начинается после каста
    const st = regen[R ? 1 : 0];
    st.showUntil = kit.clock + 1.5;
    if (R) st.until = kit.clock + clamp(isNum(d.duration) ? d.duration : 6, 1, 12);
    audio('cast', c.chest);
    return true;
  }, (d) => d.rune === 'lemnis');

  // ============================================================ ℓ АЛЬФА
  const emShard = {
    at: new V3(), dir: new V3(), cone: 0, count: 1, speed: [1, 1], life: [0.3, 0.3], at0: 0, size: [0.28, 0.1], sizeVar: 0.35,
    ramp: 'whiteHold', intensity: 2.2, sprite: 'shard', rot: 0, fadeIn: 0.45, curve: 1, essential: true, rival: false,
  };
  const _cr = new V3(), _cu = new V3(), _u = new V3();
  function camAxes() {
    const cam = kit.camera;
    if (cam && cam.matrixWorld) { const e = cam.matrixWorld.elements; _cr.set(e[0], e[1], e[2]); _cu.set(e[4], e[5], e[6]); }
    else { _cr.set(1, 0, 0); _cu.set(0, 1, 0); }
  }
  function alphaImplode(c, R, P, ramp, edge, T) {
    camAxes();
    const n = Math.round(26 * Math.max(0.6, decor()));
    emShard.rival = R;
    for (let i = 0; i < n; i++) {
      // направления — сплюснуты по вертикали (кольцо-облако вокруг героя)
      const uu = Math.random() * 2 - 1, th = Math.random() * TAU, sq = Math.sqrt(1 - uu * uu);
      _u.set(sq * Math.cos(th), uu * 0.55 + 0.1, sq * Math.sin(th)).normalize();
      const r = 1.7 + Math.random() * 0.5, t0 = Math.random() * 0.1, life = T - t0;
      emShard.at.set(c.chest.x + _u.x * r, c.chest.y + _u.y * r, c.chest.z + _u.z * r);
      emShard.dir.set(-_u.x, -_u.y, -_u.z);
      emShard.speed[0] = emShard.speed[1] = r / life;
      emShard.life[0] = emShard.life[1] = life;
      emShard.at0 = t0;
      // остриё осколка — по экранному направлению полёта (к груди)
      const sx = -(_u.x * _cr.x + _u.y * _cr.y + _u.z * _cr.z), sy = -(_u.x * _cu.x + _u.y * _cu.y + _u.z * _cu.z);
      emShard.rot = Math.atan2(-sx, sy);
      kit.emit(emShard);
    }
    // холодные штрихи слетаются синхронно (обращённый взрыв)
    kit.emit({ at: c.chest, shape: 'shell', radius: 1.5, count: 30, radial: -1.5 / T * 0.97, speed: [0, 0], life: [T * 0.95, T], size: [0.08, 0.03], ramp, intensity: 2.8, sprite: 'streak', stretch: 0.03, fadeIn: 0.4, essential: true, rival: R });
    kit.emit({ at: { x: c.feet.x, y: c.feet.y + 0.08, z: c.feet.z }, shape: 'ring', radius: 2.1, count: 26, radial: -2.0 / T, speed: [0, 0.05], dir: UP, cone: 0.1, life: [T * 0.9, T], size: [0.1, 0.05], ramp, intensity: 2.2, sprite: 'spark', stretch: 0.02, fadeIn: 0.35, rival: R });
    // кольцо схлопывается к груди, в центре копится свет
    kit.flash(c.chest, { color: edge, size: [2.0, 0.2], dur: T, intensity: 1.7, sprite: 'ring', pull: 0.5, curve: 1.8, fadeIn: 0.3, rival: R });
    kit.flash(c.chest, { color: P.hot, size: [0.1, 0.8], dur: T + 0.05, intensity: 2.1, sprite: 'glow', pull: 0.7, fadeIn: 0.9, curve: 1, rival: R });
  }
  function alphaRelease(c, R, P, ramp, edge, glyphs) {
    fx.anchor('chest', c.chest, R); fx.anchor('feet', c.feet, R);
    const rv = R ? 1 : 0, soft = reduced() ? 0.55 : 1;
    const nb = { x: -c.fwd.x, y: 0, z: -c.fwd.z };
    kit.flash(c.chest, { color: P.core, size: [0.3, 1.5], dur: 0.2, intensity: 4.5 * soft, sprite: 'star', pull: 0.7, rival: R });
    kit.flash(c.chest, { color: P.hot, size: [0.5, 1.2], dur: 0.35, intensity: 1.4 * soft, sprite: 'glow', pull: 0.7, rival: R });
    // вертикальное кольцо перезарядки (к камере) + искры по нему
    kit.flash(c.chest, { color: edge, size: [0.4, 2.6], dur: 0.45, intensity: 2.2 * soft, sprite: 'ring', pull: 0.5, curve: 0.5, rival: R });
    kit.flash(c.chest, { color: P.core, size: [0.3, 2.0], dur: 0.3, intensity: 1.6 * soft, sprite: 'ring', pull: 0.5, curve: 0.5, rival: R });
    kit.emit({ at: c.chest, shape: 'ring', normal: nb, radius: 0.35, count: 40, radial: 6, drag: 3.2, speed: [0, 0.1], life: [0.35, 0.5], size: [0.09, 0.02], ramp, intensity: 3, sprite: 'spark', stretch: 0.02, essential: true, rival: R });
    // кольцо по земле
    const g = { x: c.feet.x, y: c.feet.y + 0.07, z: c.feet.z };
    kit.emit({ at: g, shape: 'ring', radius: 0.4, count: 44, radial: 7.5, drag: 3.2, speed: [0, 0.2], dir: UP, cone: 0.2, life: [0.3, 0.5], size: [0.12, 0.03], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.02, essential: true, rival: R });
    kit.emit({ at: g, shape: 'ring', radius: 0.4, count: 22, radial: 5.5, drag: 3, speed: [0, 0.1], dir: UP, cone: 0.2, life: [0.35, 0.55], size: [0.4, 0.15], color: edge, intensity: 1.4, sprite: 'glow', rival: R });
    shock('ring', { pos: g, r0: 0.3, r1: 3.4, dur: 0.5, color: edge, hot: P.core, intensity: 1.8, rival: rv });
    kit.light(c.chest, { color: R ? 0xc8b0ff : 0xe4ecff, intensity: 1.7, range: 9, dur: 0.6, attack: 0.05 });
    kit.screenFlash(R ? 0xb49cff : 0xf4f2ff, 0.06, 0.12);
    kit.shake(0.1);
    for (const h of glyphs) flare(h, 1);
    // руки «перезаряжены»
    for (const name of ['handR', 'handL']) {
      const p = fx.anchor(name, new V3(), R);
      kit.flash(p, { color: P.core, size: [0.08, 0.5], dur: 0.28, intensity: 3 * soft, sprite: 'star', pull: 0.35, delay: 0.05, rival: R });
      kit.emit({ at: p, count: 8, speed: [0.8, 2], drag: 3, life: [0.25, 0.45], size: [0.05, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.02, delay: 0.05, rival: R });
    }
  }
  function alphaPillar(c, R, P, ramp, edge) {
    fx.anchor('feet', c.feet, R);
    const f = c.feet, soft = reduced() ? 0.5 : 1;
    kit.emit({ at: { x: f.x, y: f.y + 0.1, z: f.z }, shape: 'disk', normal: UP, radius: 0.32, count: 30, dir: UP, cone: 0.05, speed: [7, 13], life: [0.35, 0.6], size: [0.09, 0.02], ramp, intensity: 2.2, sprite: 'streak', stretch: 0.05, drag: 0.6, delay: 0.25, essential: true, rival: R });
    // кольца бегут вверх по столбу и сужаются
    for (let j = 0; j < 3; j++) {
      kit.emit({ at: { x: f.x, y: f.y + 0.15, z: f.z }, shape: 'ring', normal: UP, radius: 0.6, count: 26, vel: { x: 0, y: 5.5 + j * 1.6, z: 0 }, speed: [0, 0.05], at0: j * 0.08, life: [0.5, 0.62], size: [0.09, 0.03], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.012, rgrow: -0.7, essential: true, rival: R });
    }
    // сам столб: вертикальные штрихи-вспышки
    const top = { x: f.x, y: f.y + 2.5, z: f.z };
    kit.flash(top, { color: P.hot, size: [2.2, 3.8], dur: 0.5, intensity: 0.8 * soft, sprite: 'streak', rot: Math.PI / 2, pull: 0.3, curve: 0.5, rival: R });
    kit.flash(top, { color: edge, size: [2.8, 4.4], dur: 0.7, intensity: 0.5 * soft, sprite: 'streak', rot: Math.PI / 2, pull: 0.25, curve: 0.5, rival: R });
    // послесвечение: холодные звёздочки вокруг
    kit.emit({ at: c.chest, radius: 1.0, count: 24, dir: UP, cone: 0.6, speed: [0.2, 0.8], life: [0.8, 1.5], size: [0.09, 0.02], ramp, intensity: 2.2, sprite: 'star', spin: [-1, 1], turb: 0.3, gravity: -0.2, drag: 0.8, delay: 0.5, rival: R });
  }
  fx.on('rune_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, P = fx.pal('reset', d), ramp = rampOf('reset', R), rv = R ? 1 : 0;
    const edge = R ? 0x9a6bff : 0x78a8ff;   // белое золото с синей кромкой
    const T = 0.34;                          // момент «перезарядки»
    // круг на земле (синие линии, бело-золотое ядро) и «часовой» нимб за головой — развёртка заполняется к T
    const gGround = glyph({
      pos: { x: c.feet.x, y: c.feet.y + 0.04, z: c.feet.z }, radius: 1.9, symbol: 'alpha', color: edge, hot: P.hot, intensity: 1.9,
      dur: 1.9, unfold: 0.5, spin: -0.9, rings: 3, ticks: 36, style: 'rune', rival: rv,
    });
    const gHalo = glyph({
      pos: { x: c.head.x + c.fwd.x * 0.35, y: c.head.y + 0.1, z: c.head.z + c.fwd.z * 0.35 }, normal: { x: -c.fwd.x, y: 0, z: -c.fwd.z },
      radius: 0.95, symbol: 'alpha', symbolScale: 0.5, color: edge, hot: P.core, intensity: 1.8, dur: 1.25, unfold: 0.5, spin: -1.6,
      rings: 2, ticks: 24, style: 'sigil', rival: rv,
    });
    kit.emit({ at: c.feet, shape: 'ring', radius: 1.8, count: 20, dir: UP, cone: 0.15, speed: [0.4, 1.2], life: [0.5, 1.0], size: [0.07, 0.01], ramp, intensity: 2.2, sprite: 'spark', rival: R });
    alphaImplode(c, R, P, ramp, edge, T);
    kit.after(T, () => alphaRelease(c, R, P, ramp, edge, [gGround, gHalo]));
    kit.after(T + 0.04, () => alphaPillar(c, R, P, ramp, edge));
    audio('cast', c.chest);
    kit.after(T, () => audio('nova', c.chest));
    return true;
  }, (d) => d.rune === 'alpha');

  // ============================================================ постоянные состояния
  fx.suppress('regen');
  fx.every((dt, snap) => {
    if (!snap || !(dt > 0)) return;
    const pl = snap.player;
    // оберег орбиса
    if (pl && pl.warded && pl.action !== 'dead') {
      wardAcc += dt * 16 * decor();
      if (wardAcc >= 1) {
        const n = Math.floor(wardAcc);
        wardAcc -= n;
        fx.anchor('chest', emWard.at, false);
        emWard.at.y -= 0.12;
        emWard.center.copy(emWard.at);
        emWard.count = Math.min(3, n);
        kit.emit(emWard);
      }
    } else wardAcc = 0;
    // лечение лемниса
    regenStep(regen[0], dt, snap);
    regenStep(regen[1], dt, snap);
  });
}
