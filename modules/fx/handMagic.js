// ASHEN OATH — modules/fx/handMagic.js. Владелец: №7 [VFX].
// МАГИЯ В РУКАХ ГЕРОЯ (V6):
//  1) ладони светятся, пока идёт магия: рисование руны, сотворение сферы, заряд выброса, лук, магия ладони;
//  2) руна в воздухе: след кончика указательного пальца (input.hands.trail, координаты показа 0..1, y вниз,
//     уже зеркальные, как превью) ложится на вертикальную плоскость ~0.7 м перед грудью героя лицом к камере —
//     золотая энергетическая линия, искры и светлая точка на кончике, тонкая нить света от ладони;
//  3) распознавание (rune_cast): нарисованный символ вспыхивает цветом стихии (импульс бежит по контуру),
//     затем копия символа сжимается и слетает вниз в круг под ногами — вспышка «впечатывания».
//     Нет следа (клавиатура) — символ из glyph.js runeStroke(rune) быстро пишется в воздухе (0.15 с).
//     Соперник (data.remote) — тот же быстрый символ у него, в цвете соперника.
// rune_cast НЕ поглощается (return ничего): само заклинание рисуют модули рун, здесь — только отпечаток.

import { rampOf, trail, clamp, isNum } from './common.js';
import { runeStroke } from './glyph.js';

// руна → стихия (палитра ELEMENTS / строка градиента)
const RUNE_EL = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const HAND_EL = { fire: 'fire', storm: 'storm', frost: 'frost', earth: 'earth', heal: 'heal', void: 'void', wind: 'wind' };

// плоскость рисования относительно груди героя
const PLANE_FWD = 0.7, PLANE_RIGHT = 0.34, PLANE_UP = 0.22;
const RUNE_H = 1.0;                  // высота нарисованной руны, м
const MAXP = 192;                    // точек следа в мире (кольцевой буфер)
const SHAPE_N = 36;                  // точек контура для вспышки/отпечатка

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const GOLD = E.gold;

  // ------------------------------------------------------------ базис камеры и плоскость
  const _cr = new V3(1, 0, 0), _cu = new V3(0, 1, 0), _fw = new V3(0, 0, -1), _ch = new V3();
  function camBasis(remote) {
    const cam = kit.camera;
    let ok = false;
    if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;
      _cr.set(e[0], e[1], e[2]); _cu.set(e[4], e[5], e[6]);
      const lr = _cr.length(), lu = _cu.length();
      if (lr > 1e-4 && lu > 1e-4 && isNum(lr) && isNum(lu)) { _cr.multiplyScalar(1 / lr); _cu.multiplyScalar(1 / lu); ok = true; }
    }
    if (!ok) { fx.right(_cr, false); _cu.set(0, 1, 0); }
    fx.facing(_fw, !!remote);
  }
  /** Центр плоскости рисования: перед правым плечом героя (или перед грудью соперника). */
  function planeCenter(out, remote) {
    camBasis(remote);
    fx.anchor('chest', _ch, !!remote);
    if (remote) { out.copy(_ch).addScaledVector(_fw, 0.55); out.y += 0.55; return out; }
    out.copy(_ch).addScaledVector(_fw, PLANE_FWD).addScaledVector(_cr, PLANE_RIGHT);
    out.y += PLANE_UP;
    return out;
  }

  // калибровка «экран → метры»: где и какого размера игрок обычно рисует (плавно учится между штрихами)
  const cal = { cx: 0.64, cy: 0.40, S: RUNE_H / 0.34 };
  const _pc = new V3();
  function mapDisp(x, y, C, out) {
    const u = clamp((x - cal.cx) * cal.S, -1.0, 1.0);
    const v = clamp((cal.cy - y) * cal.S, -0.75, 0.85);
    return out.set(C.x + _cr.x * u + _cu.x * v, C.y + _cr.y * u + _cu.y * v, C.z + _cr.z * u + _cu.z * v);
  }

  // ------------------------------------------------------------ состояние штриха
  const ST = {
    active: false, rib: null, lastRib: null, n: 0, head: 0, wx: new Float32Array(MAXP * 3),
    lx: NaN, ly: NaN, tEnd: -1e9, tStart: 0, beadAcc: 0, sparkAcc: 0,
    minx: 1, maxx: 0, miny: 1, maxy: 0, rawN: 0,
  };
  const _w = new V3(), _prev = new V3(), _tip = new V3(), _hand = new V3(), _seg = new V3();
  const TIP_T = { at: _tip, count: 1, speed: [0.25, 1.1], life: [0.22, 0.5], size: [0.045, 0.008], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.02, gravity: 1.6, drag: 1.5, essential: true };
  const BEAD = { at: _w, count: 1, speed: [0, 0.04], life: [0.5, 0.7], size: [0.075, 0.035], ramp: 'gold', intensity: 2.4, sprite: 'glow', fadeIn: 0.02, curve: 1, essential: true };
  const TIP_F = { color: GOLD.hot, size: [0.15, 0.17], dur: 0.05, intensity: 2.8, sprite: 'glow', pull: 0.12, fadeIn: 0.01, curve: 1 };
  const TIP_C = { color: GOLD.core, size: [0.07, 0.09], dur: 0.05, intensity: 4.2, sprite: 'glow', pull: 0.14, fadeIn: 0.01, curve: 1 };
  const TETHER = { at: _hand, shape: 'line', to: _tip, count: 2, speed: [0, 0.03], life: [0.05, 0.08], size: [0.03, 0.02], ramp: 'gold', intensity: 1.5, alpha: 0.55, sprite: 'glow', fadeIn: 0.01, essential: true };

  function storeWorld(p) {
    const i = ST.head * 3;
    ST.wx[i] = p.x; ST.wx[i + 1] = p.y; ST.wx[i + 2] = p.z;
    ST.head = (ST.head + 1) % MAXP;
    if (ST.n < MAXP) ST.n++;
  }
  function lastWorld(out) {
    const j = ((ST.head - 1 + MAXP) % MAXP) * 3;
    return out.set(ST.wx[j], ST.wx[j + 1], ST.wx[j + 2]);
  }
  function beginStroke() {
    endStroke();
    ST.active = true; ST.n = 0; ST.head = 0; ST.lx = NaN; ST.ly = NaN; ST.beadAcc = 0; ST.sparkAcc = 0; ST.rawN = 0;
    ST.minx = 1; ST.maxx = 0; ST.miny = 1; ST.maxy = 0; ST.tStart = kit.clock;
    ST.rib = trail(fx, 'gold', false, { style: 'energy', width: 0.1, life: 0.9, intensity: 3, maxPoints: 64, minDist: 0.012 });
  }
  function endStroke() {
    if (!ST.active) return;
    ST.active = false; ST.tEnd = kit.clock;
    if (ST.rib) { try { ST.rib.stop(); } catch (e) { /* ignore */ } ST.lastRib = ST.rib; ST.rib = null; }
    // калибровка: центр и размер следующей руны ближе к тому, как рисует игрок
    if (ST.rawN >= 8) {
      const bw = ST.maxx - ST.minx, bh = ST.maxy - ST.miny;
      const sz = Math.max(bh, bw * 0.85);
      if (sz > 0.06) {
        const S = clamp(RUNE_H / clamp(sz, 0.14, 0.8), 1.3, 6);
        cal.S += (S - cal.S) * 0.35;
        cal.cx += (clamp((ST.minx + ST.maxx) * 0.5, 0.2, 0.9) - cal.cx) * 0.35;
        cal.cy += (clamp((ST.miny + ST.maxy) * 0.5, 0.15, 0.8) - cal.cy) * 0.35;
      }
    }
  }
  /** Новая точка следа (координаты показа). Бусины света вдоль отрезка — ровный шаг. */
  function addPoint(x, y, C) {
    ST.lx = x; ST.ly = y; ST.rawN++;
    if (x < ST.minx) ST.minx = x; if (x > ST.maxx) ST.maxx = x;
    if (y < ST.miny) ST.miny = y; if (y > ST.maxy) ST.maxy = y;
    mapDisp(x, y, C, _tip);
    const had = ST.n > 0;
    if (had) lastWorld(_prev);
    storeWorld(_tip);
    if (ST.rib) { try { ST.rib.push(_tip); } catch (e) { ST.rib = null; } }
    if (!had) { _w.copy(_tip); kit.emit(BEAD); return; }
    const step = ST.rib ? 0.11 : 0.045;
    _seg.subVectors(_tip, _prev);
    const L = _seg.length();
    if (L < 1e-5) return;
    let d = step - ST.beadAcc, n = 0;
    while (d <= L && n < 8) {
      _w.copy(_prev).addScaledVector(_seg, d / L);
      kit.emit(BEAD);
      d += step; n++;
    }
    ST.beadAcc = (ST.beadAcc + L) % step;
  }
  const validPt = (p) => !!p && isNum(p.x) && isNum(p.y);
  /** Забрать из ввода новые точки следа (след — скользящее окно, поэтому ищем последнюю известную точку). */
  function ingest(tr) {
    const len = tr.length;
    if (!len) return false;
    let start = 0;
    if (ST.rawN > 0) {
      start = -1;
      for (let j = len - 1; j >= Math.max(0, len - 16); j--) {
        const p = tr[j];
        if (validPt(p) && p.x === ST.lx && p.y === ST.ly) { start = j + 1; break; }
      }
      if (start < 0) start = len - 1;
    }
    if (start >= len) return false;
    planeCenter(_pc, false);
    for (let i = start; i < len; i++) { const p = tr[i]; if (validPt(p)) addPoint(clamp(p.x, -0.2, 1.2), clamp(p.y, -0.2, 1.2), _pc); }
    return true;
  }
  /** Синхронизация штриха с вводом (каждый кадр и в момент rune_cast). */
  function syncStroke() {
    const inp = fx.input;
    const hands = inp && inp.hands;
    const tr = hands && Array.isArray(hands.trail) ? hands.trail : null;
    const drawing = !!(hands && hands.drawing);
    if (drawing && tr && tr.length && !ST.active) beginStroke();
    if (ST.active && tr && tr.length) ingest(tr);
    if (!drawing && ST.active) endStroke();
    return drawing && ST.active;
  }

  // ------------------------------------------------------------ свечение ладоней
  const _hp = new V3();
  const PALM = { color: GOLD.hot, size: [0.18, 0.22], dur: 0.16, intensity: 2, sprite: 'glow', pull: 0.42, fadeIn: 0.35, curve: 1, rival: false };
  const PALM_C = { color: GOLD.core, size: [0.08, 0.1], dur: 0.16, intensity: 3, sprite: 'glow', pull: 0.45, fadeIn: 0.35, curve: 1, rival: false };
  const MOTE = { at: _hp, count: 1, radius: 0.08, dir: { x: 0, y: 1, z: 0 }, cone: 0.9, speed: [0.15, 0.6], life: [0.35, 0.7], size: [0.035, 0.006], ramp: 'gold', intensity: 2.6, sprite: 'spark', stretch: 0.015, gravity: -0.6, drag: 1.2, turb: 0.4, essential: true };
  let palmAcc = 0, moteAcc = 0, moteFlip = 0;
  function palmGlow(which, pal, ramp, lvl) {
    fx.anchor(which, _hp, false);
    PALM.color = pal.mid; PALM.intensity = 1.4 + 1.2 * lvl;
    PALM.size[0] = 0.12 + 0.1 * lvl; PALM.size[1] = PALM.size[0] * 1.2;
    PALM.dur = fx.reduced() ? 0.26 : 0.17;
    kit.flash(_hp, PALM);
    if (lvl > 0.45) { PALM_C.color = pal.hot; PALM_C.intensity = 2.2 + 1.6 * lvl; PALM_C.dur = PALM.dur; kit.flash(_hp, PALM_C); }
  }
  function palms(dt, snap, drawingNow) {
    const pl = snap && snap.player;
    if (!pl || pl.action === 'dead' || dt <= 0) { palmAcc = 0; return; }
    const inp = fx.input;
    // что сейчас колдуется: уровень 0..1, стихия, какие руки
    let lvl = 0, el = 'gold', both = true, right = true;
    const conj = pl.conjure;
    const bc = isNum(pl.burstCharge) ? pl.burstCharge : 0;
    const bow = inp && inp.bow;
    const hs = inp && inp.handSpell;
    if (drawingNow) { lvl = 0.85; el = 'gold'; both = false; }
    else if (conj) { lvl = 0.55 + 0.4 * clamp(isNum(conj.charge) ? conj.charge : 0.5, 0, 1); el = conj.kind === 'prism' ? 'reset' : 'gold'; }
    else if (bc > 0.1) { lvl = clamp(0.35 + 0.65 * bc, 0, 1); el = 'gold'; }
    else if (bow && bow.active) { lvl = 0.45 + 0.4 * clamp(isNum(bow.draw) ? bow.draw : 0, 0, 1); el = HAND_EL[bow.element] || 'gold'; }
    else if (hs && hs.phase && hs.phase !== 'idle') { lvl = 0.45 + 0.4 * clamp(isNum(hs.power) ? hs.power : 0, 0, 1); el = HAND_EL[hs.element] || 'gold'; both = false; }
    if (lvl <= 0) { palmAcc = 0; moteAcc = 0; return; }
    const pal = E[el] || GOLD, ramp = rampOf(el, false);
    // ~12 вспышек/с на ладонь (перекрываются → ровное «дыхание»), искорки ~8/с
    palmAcc += dt;
    if (palmAcc >= 0.083) {
      palmAcc = 0;
      if (right) palmGlow('handR', pal, ramp, lvl);
      if (both) palmGlow('handL', pal, ramp, lvl * 0.85);
    }
    moteAcc += dt * (both ? 16 : 8) * (0.5 + 0.5 * lvl);
    if (moteAcc >= 1) {
      moteAcc -= 1; if (moteAcc > 1) moteAcc = 0;
      moteFlip ^= 1;
      fx.anchor(both && moteFlip ? 'handL' : 'handR', _hp, false);
      MOTE.ramp = ramp;
      kit.emit(MOTE);
    }
  }

  // ------------------------------------------------------------ каждый кадр: след руны + ладони
  fx.every((dt, snap) => {
    const drawingNow = syncStroke();
    if (drawingNow && ST.n > 0 && dt > 0) {
      lastWorld(_tip);
      // кончик пальца: светлая точка + белое ядро
      kit.flash(_tip, TIP_F);
      kit.flash(_tip, TIP_C);
      // искры с кончика (~36/с)
      ST.sparkAcc += dt * 36;
      while (ST.sparkAcc >= 1) { ST.sparkAcc -= 1; kit.emit(TIP_T); }
      // тонкая нить света от правой ладони к кончику
      fx.anchor('handR', _hand, false);
      kit.emit(TETHER);
    }
    palms(dt, snap, drawingNow);
  });

  // ------------------------------------------------------------ контур: из следа / из символа
  /** Ровная выборка n точек по длине из кольцевого буфера следа → [V3]. */
  function shapeFromStore(n) {
    const cnt = ST.n;
    if (cnt < 2) return null;
    const first = ST.n < MAXP ? 0 : ST.head;
    const P = [];
    for (let i = 0; i < cnt; i++) { const j = ((first + i) % MAXP) * 3; P.push(new V3(ST.wx[j], ST.wx[j + 1], ST.wx[j + 2])); }
    return resample(P, n);
  }
  function resample(P, n) {
    const L = [0];
    for (let i = 1; i < P.length; i++) L.push(L[i - 1] + P[i].distanceTo(P[i - 1]));
    const tot = L[L.length - 1];
    if (!(tot > 0.05)) return null;
    const out = [];
    let s = 0;
    for (let k = 0; k < n; k++) {
      const d = (k / (n - 1)) * tot;
      while (s < P.length - 2 && L[s + 1] < d) s++;
      const t = clamp((d - L[s]) / Math.max(1e-6, L[s + 1] - L[s]), 0, 1);
      out.push(new V3().lerpVectors(P[s], P[s + 1], t));
    }
    return out;
  }
  /** Символ руны из glyph.js на плоскости (для клавиатуры и соперника). */
  function shapeFromSymbol(rune, remote, size) {
    let s = null;
    try { s = runeStroke(rune, 48); } catch (e) { s = null; }
    if (!s || s.length < 2) return null;
    const C = planeCenter(new V3(), remote);
    const out = [];
    for (const q of s) {
      if (!q || !isNum(q.x) || !isNum(q.y)) continue;
      const u = (q.x - 0.5) * size, v = (0.5 - q.y) * size;
      const p = new V3(C.x + _cr.x * u + _cu.x * v, C.y + _cr.y * u + _cu.y * v, C.z + _cr.z * u + _cu.z * v);
      p.k = q.k | 0;
      out.push(p);
    }
    return out.length >= 2 ? out : null;
  }
  function lastRuneName(hands) {
    const lr = hands && hands.lastRune;
    if (typeof lr === 'string') return lr;
    return lr && typeof lr.rune === 'string' ? lr.rune : null;
  }
  /** Точки нарисованного игроком следа для этой руны (или null — нет свежего следа). */
  function drawnShape(rune) {
    const hands = fx.input && fx.input.hands;
    const lr = lastRuneName(hands);
    if (lr && lr !== rune) return null;
    const fresh = ST.active || kit.clock - ST.tEnd < 1.2;
    if (fresh && ST.rawN >= 6) return shapeFromStore(SHAPE_N);
    // штрих не видели (V6 включили на ходу) — берём след из ввода целиком
    const tr = hands && Array.isArray(hands.trail) ? hands.trail : null;
    if (tr && tr.length >= 6) {
      planeCenter(_pc, false);
      const P = [];
      for (const p of tr) if (validPt(p)) P.push(mapDisp(p.x, p.y, _pc, new V3()));
      return P.length >= 6 ? resample(P, SHAPE_N) : null;
    }
    return null;
  }

  // ------------------------------------------------------------ быстрое письмо символа (0.15 с)
  function writeOn(pts, R, dur, done) {
    const pal = R ? E.rival : GOLD;
    const ramp = R ? 'rival' : 'gold';
    const bead = { at: null, count: 1, speed: [0, 0.05], life: [0.4, 0.55], size: [0.085, 0.04], ramp, intensity: 2.6, sprite: 'glow', fadeIn: 0.02, curve: 1, essential: true, rival: R };
    const tipF = { color: pal.core, size: [0.24, 0.3], dur: 0.05, intensity: 3.6, sprite: 'glow', pull: 0.15, fadeIn: 0.01, curve: 1, rival: R };
    const spk = { at: null, count: 1, speed: [0.3, 1.2], life: [0.2, 0.45], size: [0.045, 0.008], ramp, intensity: 3, sprite: 'spark', stretch: 0.02, gravity: 1.5, drag: 1.5, essential: true, rival: R };
    const rib = trail(fx, 'gold', R, { style: 'energy', width: 0.07, life: 0.5, intensity: 2.8, maxPoints: 64, minDist: 0.01 });
    let rb = rib, done_i = 0, k0 = pts[0].k | 0;
    const N = pts.length;
    kit.actor({
      dur,
      update(t, k) {
        const upto = Math.min(N - 1, Math.floor(clamp(k, 0, 1) * (N - 1)));
        for (let i = done_i; i <= upto; i++) {
          const p = pts[i];
          if ((p.k | 0) !== k0) { k0 = p.k | 0; if (rb) { try { rb.stop(); } catch (e) { /* ignore */ } } rb = trail(fx, 'gold', R, { style: 'energy', width: 0.07, life: 0.5, intensity: 2.8, maxPoints: 64, minDist: 0.01 }); }
          bead.at = p; kit.emit(bead);
          if (rb) { try { rb.push(p); } catch (e) { rb = null; } }
        }
        done_i = upto + 1;
        const tp = pts[upto];
        kit.flash(tp, tipF);
        spk.at = tp; kit.emit(spk);
      },
      end() {
        for (let i = done_i; i < N; i++) { bead.at = pts[i]; kit.emit(bead); if (rb) { try { rb.push(pts[i]); } catch (e) { rb = null; } } }
        if (rb) { try { rb.stop(); } catch (e) { /* ignore */ } }
        done();
      },
    });
  }

  // ------------------------------------------------------------ вспышка контура цветом стихии
  function flashShape(pts, el, R, big) {
    const pal = fx.pal(el, { remote: R });
    const ramp = rampOf(el, R);
    const N = pts.length, sz = big || 1;
    const cen = new V3();
    for (const p of pts) cen.add(p);
    cen.multiplyScalar(1 / N);
    const dot = { color: pal.mid, size: [0.17 * sz, 0.08 * sz], dur: 0.3, intensity: 2.0, sprite: 'glow', pull: 0.15, fadeIn: 0.05, curve: 0.7, rival: R };
    const spk = { at: null, count: 2, speed: [0.6, 2.4], life: [0.25, 0.6], size: [0.05, 0.01], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.03, drag: 2, gravity: 1.2, rival: R };
    for (let i = 0; i < N; i++) {
      kit.flash(pts[i], dot);
      if (i % 2 === 0) { spk.at = pts[i]; kit.emit(spk); }
    }
    // ореол за символом
    kit.flash(cen, { color: pal.mid, size: [0.4 * sz, 1.0 * sz], dur: 0.28, intensity: 0.9, sprite: 'glow', pull: 0.1, fadeIn: 0.15, rival: R });
    kit.light(cen, { color: pal.hot, intensity: 1.1, range: 6, dur: 0.4, attack: 0.03 });
    // импульс бежит по контуру: белая голова + лента цвета стихии
    const rib = trail(fx, el, R, { style: 'energy', width: 0.12, life: 0.32, intensity: 2.2, maxPoints: 64, minDist: 0.01 });
    const head = { color: pal.core, size: [0.34 * sz, 0.2 * sz], dur: 0.07, intensity: 4.5, sprite: 'star', pull: 0.18, fadeIn: 0.01, curve: 1, rival: R };
    const hs = { at: null, count: 1, speed: [0.8, 2.6], life: [0.2, 0.4], size: [0.05, 0.01], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, drag: 2, essential: true, rival: R };
    let di = 0;
    kit.actor({
      dur: fx.reduced() ? 0.2 : 0.14,
      update(t, k) {
        const upto = Math.min(N - 1, Math.floor(clamp(k, 0, 1) * (N - 1)));
        for (let i = di; i <= upto; i++) if (rib) { try { rib.push(pts[i]); } catch (e) { /* ignore */ } }
        di = upto + 1;
        kit.flash(pts[upto], head);
        hs.at = pts[upto]; kit.emit(hs);
      },
      end() { if (rib) { try { for (let i = di; i < N; i++) rib.push(pts[i]); rib.stop(); } catch (e) { /* ignore */ } } },
    });
    return cen;
  }

  // ------------------------------------------------------------ отпечаток: символ слетает в круг под ногами
  function imprint(pts, cen, el, R, T) {
    const pal = fx.pal(el, { remote: R });
    const ramp = rampOf(el, R);
    const feet = fx.anchor('feet', new V3(), R);
    camBasis(R);
    // центр отпечатка чуть впереди ног — иначе из-за спины героя его не видно
    const G = new V3(feet.x + _fw.x * 0.35, 0, feet.z + _fw.z * 0.35);
    G.y = fx.groundY(G.x, G.z, feet.y) + 0.06;
    // «верх» символа на земле — от камеры вперёд (как у круга-глифа под героем)
    const cam = kit.camera;
    const fwd = cam && cam.matrixWorld ? new V3(-cam.matrixWorld.elements[8], 0, -cam.matrixWorld.elements[10]) : new V3();
    if (!(fwd.lengthSq() > 1e-6)) fwd.copy(_fw);
    fwd.normalize();
    const rgt = new V3(_cr.x, 0, _cr.z);
    if (rgt.lengthSq() < 1e-6) rgt.set(-fwd.z, 0, fwd.x);
    rgt.normalize();
    const shrink = 0.6;
    const glow = { at: null, vel: new V3(), count: 1, speed: [0, 0], life: [T * 0.98, T * 1.04], size: [0.2, 0.1], ramp, intensity: 3, sprite: 'glow', fadeIn: 0.05, curve: 1, essential: true, rival: R };
    const streak = { at: null, vel: glow.vel, count: 1, speed: [0, 0], life: [T * 0.95, T], size: [0.07, 0.04], ramp, intensity: 3.6, sprite: 'streak', stretch: 0.02, fadeIn: 0.1, essential: true, rival: R };
    const o = new V3(), tgt = new V3();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      o.subVectors(p, cen);
      const u = o.dot(_cr), v = o.dot(_cu);
      tgt.copy(G).addScaledVector(rgt, u * shrink).addScaledVector(fwd, v * shrink);
      glow.vel.subVectors(tgt, p).multiplyScalar(1 / T);
      glow.at = p; kit.emit(glow);
      if (i % 2 === 0) { streak.at = p; kit.emit(streak); }
    }
    // сердце символа — яркий сгусток, ведущий «копию» вниз
    const core = { at: cen, vel: new V3().subVectors(G, cen).multiplyScalar(1 / T), count: 1, speed: [0, 0], life: [T, T], size: [0.5, 0.26], ramp, intensity: 3.4, sprite: 'glow', fadeIn: 0.05, curve: 1, essential: true, rival: R };
    kit.emit(core);
    kit.after(T, () => {
      // вспышка впечатывания
      kit.flash(G, { color: pal.core, size: [0.3, 1.4], dur: 0.2, intensity: 4.2, sprite: 'star', pull: 0.6, rival: R });
      kit.flash(G, { color: pal.hot, size: [0.6, 1.5], dur: 0.34, intensity: 2.2, sprite: 'glow', pull: 0.6, rival: R });
      kit.emit({ at: G, shape: 'ring', radius: 0.2, count: 30, radial: 5.5, dir: { x: 0, y: 1, z: 0 }, cone: 0.25, speed: [0, 0.5], life: [0.25, 0.45], size: [0.12, 0.02], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.02, drag: 4.5, essential: true, rival: R });
      kit.emit({ at: G, radius: 0.25, count: 16, dir: { x: 0, y: 1, z: 0 }, cone: 0.45, speed: [1.5, 3.8], life: [0.3, 0.6], size: [0.05, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 3.5, drag: 1.2, rival: R });
      if (fx.shock) { try { fx.shock.ring({ pos: G, r0: 0.15, r1: 1.9, dur: 0.32, color: pal.mid, hot: pal.core, intensity: 1.8, thickness: 0.12, rival: R ? 1 : 0 }); } catch (e) { /* ignore */ } }
      kit.light(G, { color: pal.hot, intensity: 1.3, range: 6, dur: 0.35, attack: 0.02 });
    });
  }

  // ------------------------------------------------------------ rune_cast: вспышка + отпечаток (событие не поглощаем)
  fx.on('rune_cast', (ev, d) => {
    try {
      const rune = d && typeof d.rune === 'string' ? d.rune : null;
      if (!rune || !RUNE_EL[rune]) return;
      const el = RUNE_EL[rune];
      const R = fx.isRemote(d);
      if (!R) {
        syncStroke(); // точки этого кадра (события идут раньше every)
        const drawn = drawnShape(rune);
        if (drawn && drawn.length >= 4) {
          ST.tEnd = -1e9; ST.rawN = 0; // след «израсходован»: золотая линия гаснет, её место занимает вспышка стихии
          const lr = ST.lastRib || ST.rib;
          if (lr) { try { lr.kill(); } catch (e) { /* ignore */ } }
          ST.lastRib = null;
          const cen = flashShape(drawn, el, false, 1);
          kit.after(0.06, () => imprint(drawn, cen, el, false, 0.24));
          return;
        }
      }
      const pts = shapeFromSymbol(rune, R, R ? 1.0 : 0.8);
      if (!pts) return;
      writeOn(pts, R, fx.reduced() ? 0.2 : 0.15, () => {
        const cen = flashShape(pts, el, R, R ? 1.15 : 1);
        kit.after(0.04, () => imprint(pts, cen, el, R, 0.22));
      });
    } catch (e) { /* никогда не мешаем самому заклинанию */ }
  }, (d) => !!d && typeof d.rune === 'string');
}
