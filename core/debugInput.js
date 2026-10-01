// DEBUG-адаптер ввода (InputFrame ASHEN_V2). Владелец: №1 / роль №21. НЕ является проверкой CV-трекинга.
// Включается только явно.
//   WASD — джойстик (как левая рука: 8 направлений, вектор нормирован), пробел — рывок по направлению
//   джойстика (из нейтрали — вперёд), Q/E — рывок влево/вправо;
//   [V5] в схеме «Руль» (setMoveMode('steer'), по умолчанию): W — вперёд (бег; ~1 с ровно — спринт),
//   A/D — поворот героя влево/вправо (в арене — обход Регента), S — стоп (перекрывает W);
//   J — огонь (удержание), U — «Искра», I — «Рассечение» (направление по зажатой A/D, иначе вправо),
//   K — щит (удержание), F — парирование, L — выброс (обе руки),
//   O / P (удерживать) — слепить сферу / призму, отпустить — бросить;
//   [V3] Z — печать «Хлопок», X — «Врата», C — «Рамка», V — «Дельта», B — «Кор»; 1…9, 0 — десять рун правой руки (RUNE_KEYS);
//   H — следующая подсказка режима «ОШИБКА» (показ твиста без камеры; по кругу все коды core/gestureCoach.js).
// Импульсы создаются только на первое нажатие (event.repeat игнорируется) и потребляются read().
// В режиме CV main.js этот адаптер не опрашивает.

import { COACH_HINTS } from './gestureCoach.js';

const SIGIL_KEYS = { KeyZ: 'clap', KeyX: 'gate', KeyC: 'frame', KeyV: 'delta', KeyB: 'cor' };
const DEMO_HINTS = ['ok_ring_open', 'steer_low', 'shield_palm', 'burst_short', 'rune_open', 'orb_facing', 'slash_slow', 'parry_slow', 'steer_lean', 'hand_far'];
// H листает все подсказки: сначала самые показательные (DEMO_HINTS), затем остальные коды core/gestureCoach.js
const ALL_HINTS = [...DEMO_HINTS, ...Object.keys(COACH_HINTS).filter((c) => !DEMO_HINTS.includes(c))];
// руны правой руки по цифрам (порядок совпадает с RUNE_IDS боя; лишние цифры ничего не делают)
export const RUNE_KEYS = ['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha'];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'Space', 'KeyJ', 'KeyU', 'KeyI', 'KeyK', 'KeyF', 'KeyL', 'KeyO', 'KeyP', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyH', ...DIGITS];

export function createDebugInput(target = window) {
  const held = new Set();
  let pendingDashDir = null;
  let pendingBurst = false;
  let pendingSpark = false;
  let pendingSlash = null;
  let pendingParry = false;
  let pendingSigil = null;
  let pendingRune = null;
  let pendingHint = null;
  let hintIdx = 0;
  let enabled = false;
  let moveMode = 'steer';   // [V5] 'steer' — «Руль», 'stick' — джойстик
  let conj = null;          // { kind, t0 } — удерживается O (сфера) или P (призма)
  let pendingThrow = null;
  const CONJ_KEYS = { KeyO: 'orb', KeyP: 'prism' };
  const conjState = (now) => {
    const h = Math.max(0, now - conj.t0);
    return { kind: conj.kind, size: Math.min(1, 0.3 + h / 1400), charge: Math.min(1, h / 1200), heldMs: h };
  };

  function stickVec() {
    if (moveMode === 'steer') {
      // «Руль»: x — поворот (A/D), z — ход вперёд (W; S — стоп). Не нормируется: поворот и ход независимы.
      const turn = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
      return { x: turn, z: held.has('KeyW') && !held.has('KeyS') ? 1 : 0 };
    }
    let x = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
    let z = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    return { x, z };
  }

  function isTyping(e) {
    const el = e.target;
    return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  function onKeyDown(e) {
    if (!enabled || isTyping(e)) return;
    const code = e.code;
    if (!KEYS.includes(code)) return;
    if (code === 'Space' && e.target && e.target.tagName === 'BUTTON') return; // пробел на кнопке — это нажатие кнопки
    e.preventDefault();
    if (e.repeat) return;              // подавление автоповтора
    held.add(code);
    if (code === 'KeyQ') pendingDashDir = { x: -1, z: 0 };
    if (code === 'KeyE') pendingDashDir = { x: 1, z: 0 };
    if (code === 'Space') {
      const v = stickVec();
      const l = Math.hypot(v.x, v.z);
      pendingDashDir = l > 0.01 ? { x: v.x / l, z: v.z / l } : { x: 0, z: 1 };
    }
    if (code === 'KeyL') pendingBurst = true;
    if (code === 'KeyU') pendingSpark = true;
    if (code === 'KeyF') pendingParry = true;
    if (code === 'KeyH') { pendingHint = { code: ALL_HINTS[hintIdx % ALL_HINTS.length], side: null, guess: null, tMs: performance.now() }; hintIdx++; }
    if (SIGIL_KEYS[code]) pendingSigil = SIGIL_KEYS[code];
    { const i = DIGITS.indexOf(code); if (i >= 0 && RUNE_KEYS[i]) pendingRune = RUNE_KEYS[i]; }
    if (code === 'KeyI') {
      const d = (held.has('KeyA') ? -1 : 0) + (held.has('KeyD') ? 1 : 0);
      pendingSlash = { dir: d < 0 ? -1 : 1, power: 0.7 };
    }
    if (CONJ_KEYS[code] && !conj) conj = { kind: CONJ_KEYS[code], key: code, t0: performance.now() };
  }

  function onKeyUp(e) {
    held.delete(e.code);
    if (conj && e.code === conj.key) {
      const c = conjState(performance.now());
      const aimX = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
      pendingThrow = { kind: c.kind, size: c.size, power: Math.max(0.3, c.charge), aimX: aimX * 0.6, how: 'push' };
      conj = null;
    }
  }
  function onBlur() { clear(); }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  function clear() {
    held.clear();
    pendingDashDir = null;
    pendingBurst = false;
    pendingSpark = false;
    pendingSlash = null;
    pendingParry = false;
    pendingSigil = null;
    pendingRune = null;
    pendingHint = null;
    conj = null;
    pendingThrow = null;
  }

  function read() {
    const frame = emptyInput('debug');
    frame.valid = enabled;
    frame.calibrated = enabled;
    if (enabled) {
      const v = stickVec();
      frame.moveX = v.x;
      frame.moveZ = v.z;
      frame.moveMode = moveMode;
      frame.stick = moveMode === 'steer'
        ? { mode: 'steer', engaged: v.z > 0 || v.x !== 0, x: v.x, z: v.z, turn: v.x, fwd: v.z, rest: !(v.z > 0 || v.x !== 0), gait: v.z > 0 ? 'run' : 'idle', hand: null, anchor: null, deadzone: 0, full: 0 }
        : { engaged: true, x: v.x, z: v.z, hand: null, anchor: null, deadzone: 0, full: 0 };
      if (pendingDashDir) {
        frame.dashDir = pendingDashDir;
        frame.dash = Math.abs(pendingDashDir.x) >= 0.25 ? Math.sign(pendingDashDir.x) : 0;
      }
      frame.attack = held.has('KeyJ');
      frame.shield = held.has('KeyK');
      frame.burst = pendingBurst;
      frame.burstPower = pendingBurst ? 0.8 : 0;
      frame.burstHand = pendingBurst ? 'both' : null;
      frame.spark = pendingSpark;
      frame.slash = pendingSlash;
      frame.parry = pendingParry;
      frame.sigil = pendingSigil;
      frame.rune = pendingRune;
      frame.runeScore = pendingRune ? 1 : 0;
      frame.hint = pendingHint;
      if (conj) {
        frame.conjure = conjState(frame.tMs);
        frame.attack = false; frame.shield = false; frame.spark = false; frame.slash = null; frame.parry = false;
        frame.moveX = 0; frame.moveZ = 0; frame.dash = 0; frame.dashDir = null;
        frame.stick = { ...frame.stick, engaged: false, x: 0, z: 0 };
      }
      frame.throw = pendingThrow;
    }
    pendingDashDir = null;
    pendingBurst = false;
    pendingSpark = false;
    pendingSlash = null;
    pendingParry = false;
    pendingThrow = null;
    pendingSigil = null;
    pendingRune = null;
    pendingHint = null;
    return frame;
  }

  function getStatus() {
    return {
      status: enabled ? 'ready' : 'idle',
      message: enabled ? 'DEBUG: клавиатура (не CV)' : '',
      progress: enabled ? 1 : 0,
      confidence: enabled ? 1 : 0,
      calibrated: enabled,
      source: 'debug',
    };
  }

  return {
    read,
    clear,
    getStatus,
    setEnabled(v) { enabled = !!v; clear(); },
    setMoveMode(m) { moveMode = m === 'stick' ? 'stick' : 'steer'; },
    get enabled() { return enabled; },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}

export function emptyInput(source = 'none') {
  return {
    source, valid: false, calibrated: false, tMs: performance.now(),
    moveX: 0, moveZ: 0, stick: null, dash: 0, dashDir: null,
    attack: false, spark: false, slash: null, rune: null, runeScore: 0, runeFizzle: false,
    shield: false, parry: false, sigil: null,
    burst: false, burstPower: 0, burstHand: null, charge: 0,
    conjure: null, throw: null, hint: null,
  };
}
