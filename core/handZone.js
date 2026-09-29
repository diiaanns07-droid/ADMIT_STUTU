// ASHEN OATH — [HAND] связка лука и магии рукой с вводом игры. Владелец: №6 [HAND].
// Кормит core/bowGesture.js и core/handMagic.js теми же наблюдениями кистей, что получает
// core/handGestures.js (modules/vision.js → setHandTap), и каждый кадр дописывает в InputFrame:
//   input.bow = { active, phase, draw, aimX, aimY, charged, release, element, rain, rapid, rune }   (контракт C2)
//   input.handSpell = { phase, element, power, dir, size, twoHand, how, formed, cancel, cancelReason, center }
// Конфликты жестов (C2): пока лук активен (и 0,45 с после) левая рука не рулит и не делает рывок,
// щит, парирование, «OK»-огонь, искра, выброс, взмах и руны молчат. Пока сгусток в ладони — молчат
// жесты правой руки (левая рулит как обычно). Руна при поднятом луке заряжает стрелу (не кастуется).
// Сгусток + сфера двумя руками → бросок сферы становится усиленным броском стихии.
// DEBUG (клавиатура, без камеры): B — стойка лука (Shift+B — прежняя печать «Кор»), удерживать N — натяжение,
// отпустить — выстрел (A/D — прицел, W — вверх: с полным натяжением «Дождь стрел»; цифры в стойке — стихия);
// удерживать M — сгусток огня (Shift+M — следующая стихия), отпустить — бросок.
// Поза героя: createHeroBowPose() — лук и ладонь с огнём на процедурном герое (пока у heroModel нет setPose, C5).

import { createBowGesture, buildHandFrame, RUNE_ELEMENT } from './bowGesture.js';
import { createHandMagic } from './handMagic.js';

export const HAND_ZONE_VERSION = 'HAND-zone-1';
const ELEMENTS = ['fire', 'storm', 'frost', 'earth'];
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const BOW_QUIET_MS = 450;     // после выхода из стойки жесты левой ещё молчат (раскрытый кулак ≠ парирование)
const SPELL_QUIET_MS = 400;   // после броска/отмены сгустка молчат жесты правой

export function createHandZone({ target = typeof window !== 'undefined' ? window : null, bow: bowCfg, magic: magicCfg } = {}) {
  const bow = createBowGesture(bowCfg);
  const magic = createHandMagic(magicCfg);
  let enabled = true;
  let lastFrame = null, lastObsT = null;
  const st = { bowActive: false, bowQuietUntil: -1e9, spellQuietUntil: -1e9, conj: false, lastBow: null, lastSpell: null, counters: { obs: 0, releases: 0, throws: 0, runes: 0, suppressed: 0, twoHand: 0 } };

  // ───────── DEBUG-клавиши ─────────
  const dbg = {
    on: false, stance: false, drawing: false, t0: 0, release: null, element: null, runeTaken: null,
    orb: false, orbEl: 0, keys: new Set(), wasActive: false,
  };
  function isTyping(e) { const el = e.target; return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable); }
  function onKeyDown(e) {
    if (!dbg.on || !enabled || isTyping(e)) return;
    const c = e.code;
    if (c === 'KeyB' && !e.shiftKey) {
      // B занята печатью «Кор» у core/debugInput.js — в бою B отдаём луку (Shift+B — «Кор»)
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      dbg.stance = !dbg.stance;
      if (!dbg.stance) { dbg.drawing = false; dbg.element = null; }
      return;
    }
    if (c === 'KeyN' || c === 'KeyM') e.preventDefault();
    if (e.repeat) return;
    dbg.keys.add(c);
    const now = performance.now();
    if (c === 'KeyN') { if (!dbg.stance) dbg.stance = true; if (!dbg.drawing) { dbg.drawing = true; dbg.t0 = now; } }
    if (c === 'KeyM') {
      if (e.shiftKey) { dbg.orbEl = (dbg.orbEl + 1) % ELEMENTS.length; return; }
      if (!dbg.orb) { dbg.orb = true; magic.forceForm(now, ELEMENTS[dbg.orbEl]); }
    }
  }
  function onKeyUp(e) {
    const c = e.code;
    dbg.keys.delete(c);
    if (!dbg.on) return;
    const now = performance.now();
    if (c === 'KeyN' && dbg.drawing) {
      const d = dbgDraw(now);
      dbg.release = { draw: d.draw, charged: d.charged, aimX: dbgAimX(), aimY: dbgAimY(), t: now };
      dbg.drawing = false;
    }
    if (c === 'KeyM' && dbg.orb) { dbg.orb = false; magic.forceThrow(now, { x: dbgAimX(), y: dbg.keys.has('KeyW') ? 0.4 : 0 }); }
  }
  function onBlur() { dbg.keys.clear(); dbg.drawing = false; if (dbg.orb) { dbg.orb = false; magic.reset(); } }
  if (target && target.addEventListener) {
    target.addEventListener('keydown', onKeyDown, true);   // capture: раньше core/debugInput.js
    target.addEventListener('keyup', onKeyUp, true);
    target.addEventListener('blur', onBlur);
  }
  const dbgAimX = () => ((dbg.keys.has('KeyD') ? 1 : 0) - (dbg.keys.has('KeyA') ? 1 : 0)) * 0.6;
  const dbgAimY = () => (dbg.keys.has('KeyW') ? 0.9 : dbg.keys.has('KeyS') ? -0.4 : 0);
  function dbgDraw(now) {
    const held = now - dbg.t0;
    const draw = clamp(held / 700, 0, 1);
    return { draw, charged: held >= 700 + 350 };
  }
  function debugBow(now, input) {
    let out;
    if (dbg.release) {
      const r = dbg.release; dbg.release = null;
      const element = dbg.element; dbg.element = null;
      out = { active: true, phase: 'ready', draw: r.draw, aimX: r.aimX, aimY: r.aimY, charged: r.charged, release: r.draw >= 0.12, element, rain: r.aimY >= 0.62 && (r.charged || r.draw >= 0.88), rapid: false };
    } else if (dbg.drawing) {
      const d = dbgDraw(now);
      out = { active: true, phase: d.draw >= 0.12 ? 'drawing' : 'nocked', draw: d.draw, aimX: dbgAimX(), aimY: dbgAimY(), charged: d.charged, release: false, element: dbg.element, rain: false, rapid: false };
    } else if (dbg.stance) out = { active: false, phase: 'ready', draw: 0, aimX: 0, aimY: 0, charged: false, release: false, element: dbg.element, rain: false, rapid: false };
    else out = { active: false, phase: 'idle', draw: 0, aimX: 0, aimY: 0, charged: false, release: false, element: null, rain: false, rapid: false };
    // руна в стойке → стихия следующей стрелы
    if (dbg.stance && input && typeof input.rune === 'string' && RUNE_ELEMENT[input.rune]) {
      dbg.element = RUNE_ELEMENT[input.rune]; out.element = dbg.element; out.rune = input.rune;
      input.rune = null; input.runeScore = 0;
    }
    return out;
  }

  // ───────── наблюдения камеры ─────────
  function pushObs(obs) {
    if (!enabled || !obs || !fin(obs.tMs) || obs.tMs === lastObsT) return;
    lastObsT = obs.tMs;
    let fr = null;
    try { fr = buildHandFrame(obs, obs.pose); } catch (e) { fr = null; }
    if (!fr) return;
    fr.busy = st.bowActive || st.conj;       // сгусток не рождается в стойке лука и во время сферы
    lastFrame = fr;
    st.counters.obs++;
    bow.push(fr);
    magic.push(fr);
  }

  // ───────── кадр ввода ─────────
  const HG_RIGHT_HINTS = /^(ok_|spark_|burst_|slash_|rune_)/;
  const HG_LEFT_HINTS = /^(shield_|parry_|steer_)/;
  function apply(input, now, ctx = {}) {
    if (!input || typeof input !== 'object') return input;
    dbg.on = !!(ctx.debug && ctx.playing);
    if (!enabled || ctx.enabled === false) { input.bow = null; input.handSpell = null; return input; }
    const t = fin(now) ? now : performance.now();
    let bv, runeTaken = null;
    if (ctx.debug) {
      bv = debugBow(t, input);
      runeTaken = bv.rune || null;
      if (dbg.orb) magic.forceTick(t, dbg.keys.has('ShiftLeft') || dbg.keys.has('ShiftRight') ? 1 : 0);
    } else {
      bv = bow.read(t);
      if (typeof input.rune === 'string' && bow.offerRune(input.rune, t)) {
        runeTaken = input.rune; input.rune = null; input.runeScore = 0; st.counters.runes++;
        bv = { ...bv, element: bow.peek(t).element };
      }
    }
    // двумя руками: сфера/призма рядом со сгустком
    const pre = magic.peek(t);
    const conj = !!(input.conjure && typeof input.conjure === 'object');
    st.conj = conj;
    if (pre.phase === 'form' || pre.phase === 'hold') {
      if (conj && !pre.twoHand) { magic.setTwoHand(true, t); st.counters.twoHand++; }
      if (input.throw && (pre.twoHand || conj)) {
        magic.setTwoHand(true, t);
        magic.throwTwoHand(t, input.throw);
        input.throw = null;             // вместо обычной сферы — усиленный бросок стихии
      }
    }
    const mv = magic.read(t);

    // стойка лука: переходы и тишина после неё
    if (bv.active) st.bowActive = true;
    else if (st.bowActive) { st.bowActive = false; st.bowQuietUntil = t + BOW_QUIET_MS; }
    if (bv.release) st.bowQuietUntil = Math.max(st.bowQuietUntil, t + BOW_QUIET_MS);
    const spellOn = mv.phase === 'form' || mv.phase === 'hold';
    if (mv.phase === 'throw' || mv.cancel) st.spellQuietUntil = t + SPELL_QUIET_MS;
    const bowBusy = bv.active || t < st.bowQuietUntil;
    const spellBusy = spellOn || mv.phase === 'throw' || t < st.spellQuietUntil;

    input.bow = {
      active: !!bv.active, phase: bv.phase || 'idle', draw: bv.draw || 0, aimX: bv.aimX || 0, aimY: bv.aimY || 0,
      charged: !!bv.charged, release: !!bv.release, element: bv.element || null, rain: !!bv.rain, rapid: !!bv.rapid, rune: runeTaken,
      nocked: !!bv.nocked,
    };
    input.handSpell = {
      phase: mv.phase, element: mv.element, power: mv.power || 0, dir: mv.dir || { x: 0, y: 0 }, size: mv.size || 0,
      twoHand: !!mv.twoHand, how: mv.how || null, formed: !!mv.formed, cancel: !!mv.cancel, cancelReason: mv.cancelReason || null,
      center: mv.center || null, sculpt: mv.sculpt || 0,
    };
    if (bv.release) st.counters.releases++;
    if (mv.phase === 'throw') st.counters.throws++;

    // гашение конфликтов
    if (bowBusy) {
      input.moveX = 0; input.moveZ = 0; input.dash = 0; input.dashDir = null;
      if (input.stick && typeof input.stick === 'object') input.stick = { ...input.stick, engaged: false, x: 0, z: 0, moveX: 0, moveZ: 0, turn: 0, fwd: 0, hold: 'bow' };
      input.shield = false; input.parry = false; input.attack = false; input.charge = 0;
      input.burst = false; input.burstPower = 0; input.burstHand = null;
      input.spark = false; input.slash = null; input.sigil = null;
      if (!runeTaken) { input.rune = null; input.runeScore = 0; }
      if (input.hint && (HG_RIGHT_HINTS.test(input.hint.code) || HG_LEFT_HINTS.test(input.hint.code))) input.hint = null;
      st.counters.suppressed++;
    } else if (bv.phase === 'ready') {
      // лук поднят: щепоть у кулака — не «OK»-огонь и не искра
      input.attack = false; input.spark = false;
    }
    if (spellBusy) {
      input.attack = false; input.spark = false; input.slash = null;
      input.burst = false; input.burstPower = 0; input.burstHand = null; input.charge = 0;
      input.rune = null; input.runeScore = 0;
      if (input.hint && HG_RIGHT_HINTS.test(input.hint.code)) input.hint = null;
    }
    const own = bv.hint || mv.hint;
    if (own && !input.hint) input.hint = { ...own };
    st.lastBow = input.bow; st.lastSpell = input.handSpell;
    return input;
  }

  // Данные для core/handFxOverlay.js: кисти в координатах показа (0..1) + состояние лука и сгустка.
  function handOut(H, aspect) {
    if (!H) return null;
    return {
      lm: H.D.map((p) => ({ x: p.x / aspect, y: p.y })), center: { x: H.center.x / aspect, y: H.center.y },
      pinch: { x: H.pinchPt.x / aspect, y: H.pinchPt.y }, scale: H.scale, shape: H.shape, normal: H.normal,
    };
  }
  function overlay(now) {
    const fr = lastFrame;
    const fresh = fr && fin(now) && now - fr.tMs < 350;
    return {
      hands: fresh ? { left: handOut(fr.left, fr.aspect), right: handOut(fr.right, fr.aspect) } : { left: null, right: null },
      bow: st.lastBow, spell: st.lastSpell,
    };
  }

  return {
    version: HAND_ZONE_VERSION,
    pushObs, apply, overlay,
    setEnabled(v) { enabled = v !== false; if (!enabled) reset(); },
    get enabled() { return enabled; },
    reset,
    getDebug() { return { version: HAND_ZONE_VERSION, bow: bow.getDebug(), magic: magic.getDebug(), counters: { ...st.counters }, debugKeys: { on: dbg.on, stance: dbg.stance, drawing: dbg.drawing, orb: dbg.orb, element: ELEMENTS[dbg.orbEl] } }; },
    dispose() {
      if (target && target.removeEventListener) {
        target.removeEventListener('keydown', onKeyDown, true);
        target.removeEventListener('keyup', onKeyUp, true);
        target.removeEventListener('blur', onBlur);
      }
    },
  };
  function reset() {
    bow.reset(); magic.reset(); lastFrame = null; lastObsT = null;
    st.bowActive = false; st.bowQuietUntil = -1e9; st.spellQuietUntil = -1e9; st.conj = false; st.lastBow = null; st.lastSpell = null;
    dbg.stance = false; dbg.drawing = false; dbg.release = null; dbg.element = null; dbg.orb = false;
  }
}

// ───────── поза героя (C5): процедурный Пепельный страж ─────────
// setPose({bowDraw, aim, handSpell}) у modules/heroModel.js зовёт main.js ([HERO]); по просьбе (setPose: true) — и здесь. Для процедурного
// героя (world.hero.root, суставы shL/elL/shR/elR/wrL/wrR) доворачиваем руки после world.update:
// левая вытянута вперёд с луком (по прицелу), правая тянет тетиву к уху; с огнём — правая ладонь вперёд-вверх.
export function createHeroBowPose() {
  let w = 0, ws = 0, joints = null, rootRef = null;
  const S = { draw: 0, aimX: 0, aimY: 0, spell: 0 };
  const lerp = (a, b, k) => a + (b - a) * k;
  function find(root) {
    if (root === rootRef && joints) return joints;
    rootRef = root; joints = null;
    if (!root || typeof root.getObjectByName !== 'function') return null;
    const g = (n) => root.getObjectByName(n);
    const j = { shL: g('shL'), elL: g('elL'), shR: g('shR'), elR: g('elR'), wrL: g('wrL'), wrR: g('wrR') };
    joints = j.shL && j.elL && j.shR && j.elR ? j : null;
    return joints;
  }
  function blendRot(o, x, y, z, k) {
    if (!o || k <= 0) return;
    o.rotation.x = lerp(o.rotation.x, x, k); o.rotation.y = lerp(o.rotation.y, y, k); o.rotation.z = lerp(o.rotation.z, z, k);
  }
  return {
    update(dt, { root, heroModel, snap, procedural = true, setPose = false } = {}) {
      const P = snap && snap.player;
      const bowS = P && P.bow ? P.bow : null, sp = P && P.handSpell ? P.handSpell : null;
      const bowOn = !!(bowS && (bowS.active || bowS.phase === 'ready')) && P.action !== 'dead';
      const spellOn = !!(sp && (sp.phase === 'form' || sp.phase === 'hold')) && P.action !== 'dead';
      const k = 1 - Math.exp(-Math.max(0, dt || 0) * 12);
      w += ((bowOn ? 1 : 0) - w) * k;
      ws += ((spellOn && !bowOn ? 1 : 0) - ws) * k;
      if (bowS) { S.draw += ((bowS.active ? bowS.draw : 0) - S.draw) * k; S.aimX += (bowS.aimX - S.aimX) * k; S.aimY += (bowS.aimY - S.aimY) * k; }
      if (sp) S.spell += ((spellOn ? sp.power : 0) - S.spell) * k;
      // setPose у VRM-героев зовёт main.js ([HERO] heroPoseFromInput) — здесь только по просьбе (setPose: true)
      if (setPose && heroModel && typeof heroModel.setPose === 'function') {
        try { heroModel.setPose({ bowDraw: w > 0.02 ? S.draw * w : 0, aim: { x: S.aimX, y: S.aimY }, handSpell: ws > 0.02 ? Math.max(0.2, S.spell) * ws : 0, bow: w }); } catch (e) { /* поза — не критично */ }
      }
      if (!procedural || (w < 0.01 && ws < 0.01)) return;
      const j = find(root);
      if (!j) return;
      if (w >= 0.01) {
        // левая (лук): вперёд на уровне плеча, выше/ниже по прицелу; правая: от кулака к уху по натяжению
        const d = S.draw;
        blendRot(j.shL, -1.5 - S.aimY * 0.35, 0.12 - S.aimX * 0.25, 0.06, w);
        blendRot(j.elL, -0.08, 0, 0, w);
        blendRot(j.shR, lerp(-1.45, -0.35, d) - S.aimY * 0.3, lerp(-0.45, 0.1, d), lerp(-0.3, -1.35, d), w);
        blendRot(j.elR, lerp(-0.35, -2.3, d), 0, 0, w);
        if (j.wrL) blendRot(j.wrL, 0, 0, -0.2, w);
      }
      if (ws >= 0.01) {
        // ладонь с огнём: правая вперёд, предплечье вверх, кисть ладонью вверх
        blendRot(j.shR, -0.95, -0.25, -0.15, ws);
        blendRot(j.elR, -1.25, 0, 0, ws);
        if (j.wrR) blendRot(j.wrR, 0.35, 0, 0, ws);
      }
    },
  };
}
