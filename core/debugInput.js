// DEBUG-адаптер ввода (InputFrame ASHEN_V2). Владелец: №1 / роль №21. НЕ является проверкой CV-трекинга.
// Включается только явно.
//   WASD — джойстик (как левая рука: 8 направлений, вектор нормирован), пробел — рывок по направлению
//   джойстика (из нейтрали — вперёд), Q/E — рывок влево/вправо;
//   [V5] в схеме «Руль» (setMoveMode('steer'), по умолчанию): W — вперёд (бег; ~1 с ровно — спринт),
//   A/D — поворот героя влево/вправо (в арене — обход Регента), S — стоп (перекрывает W);
//   J — огонь (удержание), U — «Искра», I — «Рассечение» (направление по зажатой A/D, иначе вправо),
//   [W3-ULT] U при полной шкале «Ярость клятвы» — «Небесный суд» (импульс ultimate; бой выбирает сам: шкала
//   не полна или идёт дуэль — остаётся «Искра»),
//   K — щит (удержание), F — парирование, L — выброс (обе руки),
//   O / P (удерживать) — слепить сферу / призму, отпустить — бросить;
//   [V3] Z — печать «Хлопок», C — «Рамка», V — «Дельта», B — «Кор»; 1…9, 0 — десять рун правой руки (RUNE_KEYS);
//   [W3-MAGIC] X / G (удерживать, отпустить) — «Врата бури» / «Столп небес»: пока зажата — ладони сомкнуты
//   (sigilCharge растёт за 1,5 с), отпустил — растянул; сила — от времени удержания;
//   H — следующая подсказка режима «ОШИБКА» (показ твиста без камеры; по кругу все коды core/gestureCoach.js).
// Импульсы создаются только на первое нажатие (event.repeat игнорируется) и потребляются read().
// В режиме CV main.js этот адаптер не опрашивает.

import { COACH_HINTS } from './gestureCoach.js';

const SIGIL_KEYS = { KeyZ: 'clap', KeyC: 'frame', KeyV: 'delta', KeyB: 'cor' };
// [W3-MAGIC] «ладони вместе → растянуть»: удержание — заряд, отпускание — печать; ось как у жеста
const STRETCH_KEYS = { KeyX: { sigil: 'gate', axis: 'h' }, KeyG: { sigil: 'pillar', axis: 'v' } };
const STRETCH_FULL_MS = 1500;
const DEMO_HINTS = ['ok_ring_open', 'steer_low', 'shield_palm', 'burst_short', 'rune_open', 'orb_facing', 'slash_slow', 'parry_slow', 'steer_lean', 'hand_far'];
// H листает все подсказки: сначала самые показательные (DEMO_HINTS), затем остальные коды core/gestureCoach.js
const ALL_HINTS = [...DEMO_HINTS, ...Object.keys(COACH_HINTS).filter((c) => !DEMO_HINTS.includes(c))];
// руны правой руки по цифрам (порядок совпадает с RUNE_IDS боя; лишние цифры ничего не делают)
export const RUNE_KEYS = ['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha'];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyQ', 'KeyE', 'Space', 'KeyJ', 'KeyU', 'KeyI', 'KeyK', 'KeyF', 'KeyL', 'KeyO', 'KeyP', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyH', 'KeyG', ...DIGITS];

export function createDebugInput(target = window) {
  const held = new Set();
  let pendingDashDir = null;
  let pendingBurst = false;
  let pendingSpark = false;
  let pendingSlash = null;
  let pendingParry = false;
  let pendingSigil = null;
  let pendingSigilPower = 0;
  let stretch = null;       // [W3-MAGIC] { key, sigil, axis, t0 } — зажата X или G
  let pendingRune = null;
  let pendingHint = null;
  let pendingUlt = false;   // [W3-ULT]
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
    if (code === 'KeyP' && e.shiftKey) return;   // [ПРОЕКТОР] Shift+P — режим презентации (modules/ui.js), не «призма»
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
    if (code === 'KeyU') { pendingSpark = true; pendingUlt = true; }   // [W3-ULT] + «Небесный суд»
    if (code === 'KeyF') pendingParry = true;
    if (code === 'KeyH') { pendingHint = { code: ALL_HINTS[hintIdx % ALL_HINTS.length], side: null, guess: null, tMs: performance.now() }; hintIdx++; }
    if (SIGIL_KEYS[code]) { pendingSigil = SIGIL_KEYS[code]; pendingSigilPower = 0.8; }
    if (STRETCH_KEYS[code] && !stretch) stretch = { key: code, ...STRETCH_KEYS[code], t0: performance.now() };
    { const i = DIGITS.indexOf(code); if (i >= 0 && RUNE_KEYS[i]) pendingRune = RUNE_KEYS[i]; }
    if (code === 'KeyI') {
      const d = (held.has('KeyA') ? -1 : 0) + (held.has('KeyD') ? 1 : 0);
      pendingSlash = { dir: d < 0 ? -1 : 1, power: 0.7 };
    }
    if (CONJ_KEYS[code] && !conj) conj = { kind: CONJ_KEYS[code], key: code, t0: performance.now() };
  }

  function onKeyUp(e) {
    held.delete(e.code);
    if (stretch && e.code === stretch.key) {
      const h = performance.now() - stretch.t0;
      pendingSigil = stretch.sigil;
      pendingSigilPower = Math.round(Math.min(1, Math.max(0.4, 0.4 + 0.6 * (h - 150) / (STRETCH_FULL_MS - 150))) * 1000) / 1000;
      stretch = null;
    }
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
    pendingSigilPower = 0;
    stretch = null;
    pendingRune = null;
    pendingHint = null;
    pendingUlt = false;   // [W3-ULT]
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
      frame.sigilPower = pendingSigil ? pendingSigilPower : 0;
      frame.sigilCharge = stretch ? Math.round(Math.min(1, (frame.tMs - stretch.t0) / STRETCH_FULL_MS) * 1000) / 1000 : 0;
      frame.sigilAxis = stretch ? stretch.axis : null;
      frame.rune = pendingRune;
      frame.runeScore = pendingRune ? 1 : 0;
      frame.hint = pendingHint;
      frame.ultimate = pendingUlt;   // [W3-ULT]
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
    pendingUlt = false;   // [W3-ULT]
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
    shield: false, parry: false, sigil: null, sigilPower: 0, sigilCharge: 0, sigilAxis: null,
    burst: false, burstPower: 0, burstHand: null, charge: 0,
    conjure: null, throw: null, hint: null,
  };
}
