// ASHEN OATH — [HAND] «Магия рукой»: заклинание, которое лепят в ладони правой руки. Владелец: №6 [HAND].
// Чистая логика: без DOM; время — только из аргументов. Вход — кадры core/bowGesture.js buildHandFrame().
//
// Рождение (phase 'form', в бою — hand_spell_form): правая кисть поднята перед собой (от груди до лица),
// почти неподвижна и держит форму стихии ~0,3 с:
//   ладонь раскрыта ВВЕРХ — огонь (fire) · «когти» (растопыренные полусогнутые пальцы) — молния (storm) ·
//   ладонь раскрыта ВНИЗ — лёд (frost) · кулак ладонью вверх (держит камень) — земля (earth).
// Удержание и «лепка» (phase 'hold'): power растёт до 1 за 1,5 с; сжимать/раскрывать пальцы и вращать
// кисть — быстрее; сгусток крупнеет (size). Стихия фиксируется при рождении.
// Бросок (phase 'throw' на один read(), в бою — hand_spell_throw): резкое движение кисти в сторону/вверх
// (скорость относительно корпуса) или толчок к камере (кисть быстро выросла в кадре). dir {x,y} — из
// вектора движения (x вправо, y вверх в координатах показа). Почти отвесно вниз — не бросок.
// Двумя руками: пока сгусток в ладони, а руки слепили СФЕРУ/ПРИЗМУ (input.conjure core/handGestures.js),
// сгусток «входит» в неё (twoHand); бросок сферы становится усиленным броском стихии (core/handZone.js).
// Отмена (hand_spell_cancel): опустить руку ниже груди, потерять кисть или медленно сжать кулак (кроме земли).

import { mergeConfig, RUNE_ELEMENT } from './bowGesture.js';

export const HAND_MAGIC_VERSION = 'HAND-magic-1';

export const DEFAULT_MAGIC_CONFIG = Object.freeze({
  staleMs: 350,
  pulseTtlMs: 400,
  lostCancelMs: 450,       // кисть не видна дольше — сгусток гаснет
  // зона каста (правая кисть) относительно центра плеч, в ширинах плеч: x — к правой руке игрока, y — вниз
  zoneX: [-0.9, 2.0], zoneY: [-1.4, 0.95],
  lowCancelY: 1.25,        // ниже — «рука опущена»
  lowCancelMs: 260,
  // рождение
  formMs: 300,             // форма стихии держится столько…
  formStillSpeed: 1.1,     //   …и кисть почти стоит (ширин плеч в секунду)
  palmUp: -0.55,           // нормаль ладони (оси показа, y вниз): y меньше — ладонь вверх
  palmDown: 0.55,          //   y больше — ладонь вниз
  clawFacingMax: 0.35,     // «когти» не ладонью от камеры (нормаль z меньше)
  bornMs: 260,             // фаза 'form' (сгусток рождается) → потом 'hold'
  // рост и лепка
  powerMs: 1500,
  sculptBoost: 0.9,        // «лепка» ускоряет рост до (1 + boost) раз
  sculptCurlRate: 1.6,     // изменение средней согнутости пальцев (доли) в секунду — полная «лепка»
  sculptTurnRate: 2.5,     // поворот нормали ладони (рад/с) — полная «лепка»
  sizeMin: 0.3,
  // бросок
  throwMinHoldMs: 180,
  throwWindowMs: 150,
  throwSpeed: 2.3,         // ширин плеч в секунду (относительно центра плеч)
  throwTravel: 0.32,       // ширин плеч за окно
  throwDownCos: 0.82,      // почти вниз (y) — не бросок, а «опустил руку»
  pushWindowMs: 260,
  pushRatio: 1.24,         // кисть выросла (относительно плеч) — толчок к камере
  pushTrend: 1.05,         // и прошлый кадр уже рос (одиночный скачок — не толчок)
  throwRefractoryMs: 650,
  glitchSpeed: 14,         // быстрее — сбой трекинга, история сбрасывается
  // отмена медленным кулаком (огонь, молния, лёд)
  fistCancelMs: 750,
  // подсказки «ОШИБКА»
  hintCooldownMs: 6000, hintGapMs: 2200,
  hintWeakFactor: 0.4,     // движение было, но медленнее порога (не медленнее этой его доли) — «бросай резче»
  hintWeakWindowMs: 420,
  hintWeakTravel: 0.45,    // …и рука прошла столько ширин плеч за окно
  hintHoldMs: 6000,        // сгусток держат дольше — «брось его»
  hintPalmMs: 1600,        // раскрытая правая ладонь к камере в зоне, неподвижно — «разверни ладонь вверх»
  hintPalmCooldownMs: 25000,
});

export const MAGIC_HINTS = Object.freeze({
  spell_throw_weak: 'Бросай резче — толкни ладонь к камере или махни в сторону',
  spell_hold: 'Сгусток готов — брось его резким движением ладони',
  spell_palm: 'Разверни ладонь вверх — в ней родится огненный сгусток',
});

export const SPELL_ELEMENTS = Object.freeze({
  fire: { id: 'fire', title: 'Огонь', form: 'ладонь вверх' },
  storm: { id: 'storm', title: 'Молния', form: '«когти» — растопыренные полусогнутые пальцы' },
  frost: { id: 'frost', title: 'Лёд', form: 'ладонь вниз' },
  earth: { id: 'earth', title: 'Земля', form: 'кулак ладонью вверх' },
});
export { RUNE_ELEMENT };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const isObj = (v) => v !== null && typeof v === 'object';

/** Стихия формы кисти (или null). R — признаки кисти из buildHandFrame. */
export function elementOf(R, cfg = DEFAULT_MAGIC_CONFIG) {
  if (!R || !R.normal) return null;
  const n = R.normal;
  if (R.shape === 'open' && n.y <= cfg.palmUp) return 'fire';
  if (R.shape === 'open' && n.y >= cfg.palmDown) return 'frost';
  if (R.shape === 'fist' && n.y <= cfg.palmUp) return 'earth';
  if (R.shape === 'claw' && n.z <= cfg.clawFacingMax) return 'storm';
  return null;
}

export function createHandMagic(configPatch = {}) {
  let cfg = mergeConfig(DEFAULT_MAGIC_CONFIG, configPatch);
  let st;
  function reset() {
    st = {
      phase: 'idle', element: null, power: 0, size: 0, since: 0, bornAt: 0, lastT: null,
      cand: null, candSince: null,
      hist: [],               // {t, x, y, s, sw} — центр ладони относительно плеч (ширины плеч), масштаб
      prevCurl: null, prevN: null, sculpt: 0,
      lostAt: null, lowSince: null, fistSince: null,
      twoHand: false, blockedUntil: -Infinity,
      pulse: null,            // { kind: 'throw'|'cancel'|'form', ... }
      formed: null, cancel: null, thrown: null,
      center: null, dir: { x: 0, y: 0 },
      hint: null, hints: { until: {}, gapUntil: -Infinity, since: {} },
      weakAt: -Infinity,
      counters: { frames: 0, forms: 0, throws: 0, cancels: 0, hints: 0, twoHand: 0 },
      lastEvent: null,
    };
  }
  reset();

  function hint(code, t, cd) {
    const H = st.hints;
    if (t < H.gapUntil || t < (H.until[code] || -Infinity)) return;
    H.until[code] = t + (cd || cfg.hintCooldownMs);
    H.gapUntil = t + cfg.hintGapMs;
    st.hint = { code, side: 'right', guess: 'hand_spell', tMs: t };
    st.counters.hints++;
  }
  function since(key, cond, t) {
    const S = st.hints.since;
    if (!cond) { S[key] = null; return 0; }
    if (S[key] === null || S[key] === undefined) S[key] = t;
    return t - S[key];
  }

  function rel(R, body) {
    const sw = body && body.sw ? body.sw : Math.max(1e-6, R.scale) * 3.6;
    const cx = body ? body.cx : R.center.x, cy = body ? body.cy : R.center.y;
    return { x: (R.center.x - cx) / sw, y: (R.center.y - cy) / sw, sw };
  }
  function inZone(p, keep) {
    const zx = cfg.zoneX, zy = cfg.zoneY;
    const pad = keep ? 0.25 : 0;
    return p.x >= zx[0] - pad && p.x <= zx[1] + pad && p.y >= zy[0] - pad && p.y <= zy[1] + pad;
  }
  function speedOver(t, ms) {
    // скорость центра ладони (ширин плеч в секунду) и путь за окно
    let first = null;
    for (const h of st.hist) if (t - h.t <= ms) { first = h; break; }
    const last = st.hist[st.hist.length - 1];
    if (!first || !last || last === first) return { v: 0, dx: 0, dy: 0, d: 0, ms: 0 };
    const dx = last.x - first.x, dy = last.y - first.y, d = Math.hypot(dx, dy), dt = Math.max(1, last.t - first.t);
    return { v: d / (dt / 1000), dx, dy, d, ms: dt };
  }

  function cancel(t, reason) {
    if (st.phase === 'idle') return;
    st.pulse = { kind: 'cancel', t, element: st.element, power: st.power, reason };
    st.counters.cancels++;
    st.lastEvent = { type: 'cancel', t, reason };
    toIdle();
  }
  function toIdle() {
    st.phase = 'idle'; st.element = null; st.power = 0; st.size = 0; st.twoHand = false;
    st.cand = null; st.candSince = null; st.lowSince = null; st.fistSince = null; st.lostAt = null; st.sculpt = 0;
  }
  function doThrow(t, dir, how, strength) {
    const power = clamp01(st.power);
    st.pulse = { kind: 'throw', t, element: st.element, power, size: st.size, dir, how, strength: clamp01(strength), twoHand: st.twoHand, center: st.center };
    st.counters.throws++;
    st.lastEvent = { type: 'throw', t, how };
    st.blockedUntil = t + cfg.throwRefractoryMs;
    st.hist.length = 0;
    toIdle();
  }

  function push(frame) {
    if (!isObj(frame) || !fin(frame.tMs)) return;
    const t = frame.tMs;
    if (st.lastT !== null && t < st.lastT - 1000) reset();
    const dt = st.lastT === null ? 0 : clamp(t - st.lastT, 0, 250);
    st.lastT = t;
    st.counters.frames++;
    const R = frame.right, body = frame.body;
    if (!R) {
      st.hist.length = 0;
      if (st.phase !== 'idle') {
        if (st.lostAt === null) st.lostAt = t;
        if (t - st.lostAt > cfg.lostCancelMs) cancel(t, 'lost');
      }
      st.cand = null; st.candSince = null;
      return;
    }
    st.lostAt = null;
    const p = rel(R, body);
    st.center = { x: R.center.x / frame.aspect, y: R.center.y };
    // история движения (сбой трекинга — скачок — сбрасывает её)
    const prev = st.hist[st.hist.length - 1];
    if (prev && dt > 0 && Math.hypot(p.x - prev.x, p.y - prev.y) / (dt / 1000) > cfg.glitchSpeed) st.hist.length = 0;
    st.hist.push({ t, x: p.x, y: p.y, s: R.scale, sw: p.sw });
    const keep = Math.max(cfg.throwWindowMs, cfg.pushWindowMs, cfg.hintWeakWindowMs) + 150;
    while (st.hist.length > 2 && t - st.hist[0].t > keep) st.hist.shift();

    const el = elementOf(R, cfg);
    const mv = speedOver(t, cfg.throwWindowMs);

    if (st.phase === 'idle') {
      // рождение: форма стихии держится, кисть в зоне и почти стоит
      const ok = el && inZone(p, false) && mv.v < cfg.formStillSpeed && t >= st.blockedUntil && !frame.busy;
      if (ok && el === st.cand) {
        if (t - st.candSince >= cfg.formMs) {
          st.phase = 'form'; st.element = el; st.power = 0; st.size = cfg.sizeMin; st.since = t; st.bornAt = t;
          st.twoHand = false; st.prevCurl = null; st.prevN = null; st.fistSince = null; st.lowSince = null;
          st.pulse = { kind: 'form', t, element: el, power: 0 };
          st.counters.forms++;
          st.lastEvent = { type: 'form', t, element: el };
        }
      } else if (ok) { st.cand = el; st.candSince = t; }
      else { st.cand = null; st.candSince = null; }
    } else {
      if (st.phase === 'form' && t - st.bornAt >= cfg.bornMs) st.phase = 'hold';
      // лепка: изменение согнутости пальцев и поворот ладони
      const curl = R.reach.reduce((a, b) => a + b, 0) / 4;
      let act = 0;
      if (st.prevCurl !== null && dt > 0) act = Math.max(act, Math.abs(curl - st.prevCurl) / (dt / 1000) / cfg.sculptCurlRate);
      if (st.prevN && R.normal && dt > 0) {
        const c = clamp(st.prevN.x * R.normal.x + st.prevN.y * R.normal.y + st.prevN.z * R.normal.z, -1, 1);
        act = Math.max(act, Math.acos(c) / (dt / 1000) / cfg.sculptTurnRate);
      }
      st.prevCurl = curl; st.prevN = R.normal ? { ...R.normal } : st.prevN;
      st.sculpt += (clamp01(act) - st.sculpt) * (dt > 0 ? 1 - Math.exp(-dt / 180) : 1);
      st.power = clamp01(st.power + (dt / cfg.powerMs) * (1 + cfg.sculptBoost * st.sculpt));
      st.size = cfg.sizeMin + (1 - cfg.sizeMin) * st.power;
      // отмена: рука опущена
      if (p.y > cfg.lowCancelY) { if (st.lowSince === null) st.lowSince = t; if (t - st.lowSince >= cfg.lowCancelMs) { cancel(t, 'lowered'); return; } }
      else st.lowSince = null;
      // отмена: медленно сжатый кулак (кроме земли; для земли кулак — сама форма)
      if (st.element !== 'earth' && R.shape === 'fist' && !st.twoHand) {
        if (st.fistSince === null) st.fistSince = t;
        if (t - st.fistSince >= cfg.fistCancelMs) { cancel(t, 'fist'); return; }
      } else st.fistSince = null;
      // бросок одной рукой (двуручный бросок — через core/handZone.js)
      if (!st.twoHand && t - st.since >= cfg.throwMinHoldMs) {
        const downward = mv.d > 1e-6 && mv.dy / mv.d > cfg.throwDownCos;
        if (mv.v >= cfg.throwSpeed && mv.d >= cfg.throwTravel && !downward) {
          const l = Math.max(1e-6, mv.d);
          doThrow(t, { x: clamp(mv.dx / l, -1, 1), y: clamp(-mv.dy / l, -1, 1) }, 'fling', mv.v / (cfg.throwSpeed * 2));
          return;
        }
        // толчок к камере: кисть выросла относительно плеч
        let base = null;
        for (const h of st.hist) if (t - h.t <= cfg.pushWindowMs) { base = h; break; }
        const n = st.hist.length;
        if (base && n >= 3) {
          const cur = st.hist[n - 1], pr = st.hist[n - 2];
          const r = (cur.s / base.s) / (cur.sw / base.sw), rp = (cur.s / pr.s) / (cur.sw / pr.sw);
          if (r >= cfg.pushRatio && rp >= cfg.pushTrend) {
            doThrow(t, { x: clamp(mv.dx * 1.5, -1, 1) * 0.5, y: clamp(-mv.dy * 1.5, -1, 1) * 0.5 }, 'push', (r - 1) / (cfg.pushRatio - 1) / 2);
            return;
          }
        }
        // почти бросок: рука заметно прошла, но медленно
        const mw = speedOver(t, cfg.hintWeakWindowMs);
        const downW = mw.d > 1e-6 && mw.dy / mw.d > cfg.throwDownCos;
        if (!downW && mw.d >= cfg.hintWeakTravel && mw.v >= cfg.throwSpeed * cfg.hintWeakFactor && mv.v < cfg.throwSpeed) st.weakAt = t;
      }
    }

    // ── подсказки «ОШИБКА»
    if (st.weakAt > 0 && t - st.weakAt > 120 && t - st.weakAt < 600 && st.phase !== 'idle') { hint('spell_throw_weak', t); st.weakAt = -Infinity; }
    if (since('hold', st.phase === 'hold' && !st.twoHand, t) >= cfg.hintHoldMs) hint('spell_hold', t);
    const palmCam = st.phase === 'idle' && R.shape === 'open' && R.normal && R.normal.z < -0.6 && inZone(p, false) && mv.v < 0.4 && !frame.busy;
    if (since('palm', palmCam, t) >= cfg.hintPalmMs) hint('spell_palm', t, cfg.hintPalmCooldownMs);
  }

  function view(now, consume) {
    const t = fin(now) ? now : st.lastT;
    const stale = st.lastT === null || (fin(t) && t - st.lastT > cfg.staleMs + cfg.lostCancelMs);
    const out = { phase: 'idle', element: 'fire', power: 0, dir: { x: 0, y: 0 }, size: 0, twoHand: false, center: null, formed: false, cancel: false };
    if (!stale && st.phase !== 'idle') {
      out.phase = st.phase; out.element = st.element; out.power = st.power; out.size = st.size; out.twoHand = st.twoHand; out.center = st.center;
      out.sculpt = st.sculpt;
    }
    const p = st.pulse;
    if (p && (!fin(t) || t - p.t <= cfg.pulseTtlMs)) {
      if (p.kind === 'throw') {
        out.phase = 'throw'; out.element = p.element; out.power = p.power; out.size = p.size; out.dir = p.dir; out.how = p.how;
        out.strength = p.strength; out.twoHand = p.twoHand; out.center = p.center;
      } else if (p.kind === 'cancel') { out.cancel = true; out.cancelReason = p.reason; if (out.phase === 'idle') out.element = p.element || out.element; }
      else if (p.kind === 'form') out.formed = true;
      if (consume) st.pulse = null;
    } else if (p && consume) st.pulse = null;
    if (st.hint) { out.hint = st.hint; if (consume) st.hint = null; }
    return out;
  }

  /** Двуручная сфера/призма рядом со сгустком (от core/handZone.js). */
  function setTwoHand(on, now) {
    if (st.phase === 'idle') return false;
    if (on && !st.twoHand) { st.twoHand = true; st.counters.twoHand++; st.lastEvent = { type: 'twoHand', t: now }; }
    else if (!on) st.twoHand = false;
    return st.twoHand;
  }
  /** Двуручный бросок сферы, пока сгусток «внутри» — становится броском стихии. */
  function throwTwoHand(now, thr) {
    if (st.phase === 'idle' || !st.twoHand) return null;
    const t = fin(now) ? now : st.lastT || 0;
    const aimX = thr && fin(thr.aimX) ? thr.aimX : 0;
    st.power = Math.max(st.power, thr && fin(thr.power) ? thr.power : 0);
    doThrow(t, { x: clamp(aimX, -1, 1), y: 0 }, thr && thr.how === 'fling' ? 'fling' : 'push', 1);
    st.pulse.twoHand = true;
    return st.pulse;
  }
  /** Сгусток внешним способом (DEBUG-клавиша M): сразу рождается в ладони. */
  function forceForm(now, element = 'fire') {
    if (st.phase !== 'idle') return;
    const t = fin(now) ? now : st.lastT || 0;
    st.lastT = t;
    st.phase = 'form'; st.element = element; st.power = 0; st.size = cfg.sizeMin; st.since = t; st.bornAt = t;
    st.pulse = { kind: 'form', t, element, power: 0 };
    st.counters.forms++;
  }
  function forceTick(now, sculpt = 0) {
    if (st.phase === 'idle' || !fin(now)) return;
    const dt = st.lastT === null ? 0 : clamp(now - st.lastT, 0, 250);
    st.lastT = now;
    if (st.phase === 'form' && now - st.bornAt >= cfg.bornMs) st.phase = 'hold';
    st.sculpt = sculpt;
    st.power = clamp01(st.power + (dt / cfg.powerMs) * (1 + cfg.sculptBoost * sculpt));
    st.size = cfg.sizeMin + (1 - cfg.sizeMin) * st.power;
  }
  function forceThrow(now, dir = { x: 0, y: 0 }) {
    if (st.phase === 'idle') return;
    doThrow(fin(now) ? now : st.lastT || 0, dir, 'push', 1);
  }

  return {
    push,
    read: (now) => view(now, true),
    peek: (now) => view(now, false),
    reset,
    setTwoHand, throwTwoHand, forceForm, forceTick, forceThrow,
    configure(patch) { cfg = mergeConfig(cfg, patch); },
    get config() { return cfg; },
    getDebug() { return { version: HAND_MAGIC_VERSION, phase: st.phase, element: st.element, power: st.power, size: st.size, twoHand: st.twoHand, cand: st.cand, sculpt: st.sculpt, counters: { ...st.counters }, lastEvent: st.lastEvent }; },
  };
}
