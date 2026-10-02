// ASHEN OATH — [W3-CURSOR] курсор-кисть: указательный палец правой руки вместо мыши.
// «Камера вместо джойстика» — и вместо мыши: на экранах с кнопками (меню, пауза, итоги, тренажёр,
// «Книга заклинаний») кончик указательного пальца ведёт светящееся кольцо. Клик — задержать кольцо
// на кнопке 0,8 с (кольцо заполняется) или щепоть (большой палец к указательному). Кнопка под кольцом
// подсвечивается; зона попадания шире самой кнопки, кольцо «прилипает» к ближайшей.
//
// Вход — те же точки кистей, что у игры: vision.getHands() (координаты ПОКАЗА 0..1, x уже зеркален,
// right — правая рука самого игрока) и vision.getPose() (плечи — рамка досягаемости руки).
// Палец ходит в рамке у правого плеча (≈1,6 × 1,1 ширины плеч), рамка растягивается на весь экран:
// маленькое движение кисти — курсор через весь экран. Рука ниже рамки (опущена, лежит на столе) —
// курсора нет, случайных кликов нет.
//
// Ядро (createCursorCore) — чистая логика без DOM: отображение пальца на экран, сглаживание One-Euro,
// выбор цели с гистерезисом, таймер удержания, щепоть. createHandCursor — DOM-слой: кольцо, подсветка
// кнопок, поиск целей на странице, нажатие. Тесты ядра — dev/handCursor.test.mjs.

export const HAND_CURSOR_VERSION = 'W3-cursor-1';

export const CURSOR_DEFAULTS = Object.freeze({
  dwellMs: 800,            // удержание на кнопке до клика
  snapPx: 34,              // зона попадания: столько px вокруг кнопки ещё считается «на кнопке»
  stickPx: 58,             // текущая цель отпускается, только когда кольцо ушло дальше этого
  lostMs: 260,             // кисть пропала дольше — кольцо гаснет
  cooldownMs: 450,         // после клика — пауза
  pinchOn: 0.3,            // |большой − указательный| / длина ладони: меньше — щепоть
  pinchOff: 0.5,           // больше — пальцы разжаты (гистерезис)
  pinchHoverMs: 150,       // щепоть кликает цель, на которой кольцо простояло хотя бы столько
  pinchFreshMs: 1500,      // и только если пальцы были разжаты в прошлом кадре или недавно (не «OK», поднесённый к кнопке)
  pinchLookbackMs: 120,    // цель — та, что была под кольцом чуть раньше (палец сдвигается при щепоти)
  pinchFreezeMs: 250,      // столько после щепоти кольцо стоит на месте (кончик пальца уезжает), потом снова следует
  // рамка досягаемости в ширинах плеч (ось x — от правого плеча наружу, y — от линии плеч вверх)
  // наружу — не дальше ~1 ширины плеч: у края кадра MediaPipe теряет кисть
  boxLeft: 0.65, boxRight: 0.95, boxUp: 0.9, boxDown: 0.2,
  outX: 0.12, outUp: 0.15, outDown: 0.1,   // палец чуть за рамкой — курсор у края; дальше — курсора нет
  boxTauMs: 600,           // сглаживание рамки (плечи дрожат меньше кисти, но дрожат)
  // без позы — рамка в долях кадра
  fallback: Object.freeze({ x0: 0.4, x1: 0.95, y0: 0.12, y1: 0.62 }),
  // One-Euro для курсора, px
  minCutoffHz: 1.1, beta: 0.012, dCutoffHz: 1.0,
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const alphaOf = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / Math.max(1e-4, dt)); };

// Рамка досягаемости правой руки в координатах показа (x — в долях ширины кадра, y — высоты).
// pose — vision.getPose(): landmarks НЕзеркального кадра, mirror, frameW/frameH.
export function reachBox(pose, cfg = CURSOR_DEFAULTS) {
  const lm = pose && Array.isArray(pose.landmarks) ? pose.landmarks : null;
  const L = lm && lm[11], R = lm && lm[12];
  const ok = (q) => q && fin(q.x) && fin(q.y) && !(fin(q.visibility) && q.visibility < 0.5);
  if (!ok(L) || !ok(R)) return null;
  const A = fin(pose.frameW) && fin(pose.frameH) && pose.frameH > 0 ? pose.frameW / pose.frameH : 4 / 3;
  const mir = pose.mirror !== false;
  const rx = (mir ? 1 - R.x : R.x) * A, lx = (mir ? 1 - L.x : L.x) * A;
  const sw = Math.hypot(rx - lx, R.y - L.y);
  if (!(sw > 0.05 * A)) return null;                     // плечи слились — поза ненадёжна
  const out = Math.sign(rx - lx) || 1;                   // «наружу» от правого плеча на показе
  const shY = (R.y + L.y) / 2;
  const xa = rx - out * cfg.boxLeft * sw, xb = rx + out * cfg.boxRight * sw;
  return { x0: Math.min(xa, xb) / A, x1: Math.max(xa, xb) / A, y0: shY - cfg.boxUp * sw, y1: shY + cfg.boxDown * sw };
}

// Кончик пальца → доли экрана (u, v) по рамке. visible=false — палец далеко за рамкой.
export function mapTip(tip, box, cfg = CURSOR_DEFAULTS) {
  const b = box || cfg.fallback;
  const u = (tip.x - b.x0) / Math.max(1e-6, b.x1 - b.x0);
  const v = (tip.y - b.y0) / Math.max(1e-6, b.y1 - b.y0);
  const visible = u >= -cfg.outX && u <= 1 + cfg.outX && v >= -cfg.outUp && v <= 1 + cfg.outDown;
  return { u: clamp(u, 0, 1), v: clamp(v, 0, 1), visible };
}

// Расстояние от точки до прямоугольника (0 — внутри).
export function rectDist(r, x, y) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

// Выбор цели: текущая держится до stickPx, новая — ближайшая в пределах snapPx (вложенные — меньшая).
export function pickTarget(targets, x, y, currentId, cfg = CURSOR_DEFAULTS) {
  if (!Array.isArray(targets) || !targets.length) return null;
  if (currentId != null) {
    const cur = targets.find((t) => t.id === currentId);
    const dc = cur ? rectDist(cur, x, y) : Infinity;
    if (cur && dc <= cfg.stickPx) {
      // кольцо уже внутри другой кнопки (или вложенной меньшей) — переходим на неё
      const area = (t) => (t.x1 - t.x0) * (t.y1 - t.y0);
      const inner = targets.find((t) => t.id !== currentId && rectDist(t, x, y) === 0 && (dc > 0 || area(t) < area(cur)));
      return inner || cur;
    }
  }
  let best = null, bd = Infinity, ba = Infinity;
  for (const t of targets) {
    const d = rectDist(t, x, y);
    if (d > cfg.snapPx) continue;
    const a = (t.x1 - t.x0) * (t.y1 - t.y0);
    if (d < bd - 0.5 || (Math.abs(d - bd) <= 0.5 && a < ba)) { best = t; bd = d; ba = a; }
  }
  return best;
}

// Длина «щепоти»: |кончик большого − кончик указательного| / |запястье − основание среднего|.
export function pinchRatio(hand, aspect = 4 / 3) {
  const P = hand && Array.isArray(hand.landmarks) ? hand.landmarks : null;
  if (!P || P.length < 21) return null;
  const d = (a, b) => (a && b && fin(a.x) && fin(b.x) ? Math.hypot((a.x - b.x) * aspect, a.y - b.y) : NaN);
  const palm = d(P[0], P[9]), gap = d(P[4], P[8]);
  return palm > 1e-4 && gap === gap ? gap / palm : null;
}

// ─────────────────────────────────────────────────────────── ядро
// step(f) каждый кадр. f: { t (мс), viewport {w,h}, hands (vision.getHands()), pose, targets [{id,x0,y0,x1,y1,disabled}],
//   active (экран разрешает курсор), pinch (разрешена щепоть), dwellMs (удержание на этом экране, иначе — из настроек) }.
// Возвращает { visible, x, y, targetId, progress 0..1, disabled, pinched, click: id|null, how: 'dwell'|'pinch'|null }.
export function createCursorCore(opts = {}) {
  const cfg = { ...CURSOR_DEFAULTS, ...opts };
  const st = {
    lastT: null, seenAt: -1e9, visible: false, x: 0, y: 0, fx: null, dx: 0, dy: 0,
    box: null, targetId: null, hoverSince: 0, dwell: 0, dwellMs: 0, lockedId: null, cooldownUntil: -1e9,
    pinched: false, pinchAt: -1e9, openAt: -1e9, prevOpen: false, hist: [], clicks: 0, lastHow: null,
  };
  const out = { visible: false, x: 0, y: 0, targetId: null, progress: 0, disabled: false, pinched: false, click: null, how: null };

  function reset() {
    st.visible = false; st.fx = null; st.targetId = null; st.dwell = 0; st.lockedId = null; st.pinched = false; st.prevOpen = false; st.hist.length = 0; st.box = null;
  }

  function filter(x, y, dt) {
    if (st.fx === null || dt <= 0 || dt > 0.5) { st.fx = { x, y }; st.dx = 0; st.dy = 0; return st.fx; }
    const ad = alphaOf(cfg.dCutoffHz, dt);
    st.dx += ((x - st.fx.x) / dt - st.dx) * ad;
    st.dy += ((y - st.fx.y) / dt - st.dy) * ad;
    const a = alphaOf(cfg.minCutoffHz + cfg.beta * Math.hypot(st.dx, st.dy), dt);
    st.fx = { x: st.fx.x + (x - st.fx.x) * a, y: st.fx.y + (y - st.fx.y) * a };
    return st.fx;
  }

  function smoothBox(box, dt) {
    if (!box) return st.box;
    if (!st.box || dt <= 0 || dt > 0.5) { st.box = { ...box }; return st.box; }
    const k = 1 - Math.exp(-dt * 1000 / cfg.boxTauMs);
    for (const key of ['x0', 'x1', 'y0', 'y1']) st.box[key] += (box[key] - st.box[key]) * k;
    return st.box;
  }

  function step(f) {
    const t = fin(f && f.t) ? f.t : 0;
    const dt = st.lastT === null ? 0 : Math.max(0, (t - st.lastT) / 1000);
    st.lastT = t;
    out.click = null; out.how = null;
    const W = f && f.viewport && f.viewport.w > 0 ? f.viewport.w : 1, H = f && f.viewport && f.viewport.h > 0 ? f.viewport.h : 1;
    if (!f || !f.active) { reset(); return fill(); }

    const hands = f.hands;
    const R = hands && hands.available !== false && hands.right && hands.right.tip && fin(hands.right.tip.x) ? hands.right : null;
    let seen = false;
    if (R) {
      const box = smoothBox(reachBox(f.pose, cfg), dt);
      const m = mapTip(R.tip, box, cfg);
      if (m.visible) {
        seen = true;
        st.seenAt = t;
        const A = f.pose && fin(f.pose.frameW) && fin(f.pose.frameH) && f.pose.frameH > 0 ? f.pose.frameW / f.pose.frameH : 4 / 3;
        const pr = pinchRatio(R, A);
        // щепоть: закрылась — замораживаем кольцо (кончик указательного при щепоти уезжает)
        if (pr !== null) {
          if (!st.pinched && pr < cfg.pinchOn) { st.pinched = true; st.pinchAt = t; onPinch(t, f); }
          else if (st.pinched && pr > cfg.pinchOff) { st.pinched = false; st.openAt = t; }
          else if (!st.pinched && pr > cfg.pinchOff) st.openAt = t;
          st.prevOpen = pr > cfg.pinchOff;   // для следующего кадра: щепоть из разжатых пальцев — даже при редких кадрах камеры
        }
        const frozen = f.pinch !== false && st.pinched && t - st.pinchAt < cfg.pinchFreezeMs;
        if (!frozen || !st.visible) {
          const p = filter(m.u * W, m.v * H, dt);
          st.x = p.x; st.y = p.y;
        }
        st.visible = true;
      }
    }
    if (!seen && t - st.seenAt > cfg.lostMs) { st.visible = false; st.fx = null; st.pinched = false; }
    if (!st.visible) { st.targetId = null; st.dwell = 0; st.lockedId = null; return fill(); }

    // цель под кольцом
    const targets = Array.isArray(f.targets) ? f.targets : [];
    const tg = pickTarget(targets, st.x, st.y, st.targetId, cfg);
    const id = tg ? tg.id : null;
    if (id !== st.targetId) { st.targetId = id; st.hoverSince = t; st.dwell = 0; if (st.lockedId !== null && id !== st.lockedId) st.lockedId = null; }
    st.hist.push({ t, id });
    while (st.hist.length && t - st.hist[0].t > 600) st.hist.shift();

    // удержание: только на живой цели, не сразу после клика и не на кнопке, которую уже нажали (уведите кольцо)
    const live = tg && !tg.disabled && st.lockedId !== id && t >= st.cooldownUntil;
    st.dwellMs = fin(f.dwellMs) && f.dwellMs > 0 ? f.dwellMs : cfg.dwellMs;
    if (live && seen) st.dwell += dt * 1000;
    else if (!live) st.dwell = 0;
    if (live && st.dwell >= st.dwellMs) fire(id, t, 'dwell');
    return fill(tg);
  }

  function onPinch(t, f) {
    if (f.pinch === false || t < st.cooldownUntil || (!st.prevOpen && t - st.openAt > cfg.pinchFreshMs)) return;
    // цель — та, что была под кольцом pinchLookbackMs назад и простояла там pinchHoverMs
    let id = st.targetId;
    for (let i = st.hist.length - 1; i >= 0; i--) if (t - st.hist[i].t >= cfg.pinchLookbackMs) { id = st.hist[i].id; break; }
    if (id === null || id === st.lockedId) return;
    let since = t;
    for (let i = st.hist.length - 1; i >= 0 && st.hist[i].id === id; i--) since = st.hist[i].t;
    if (t - since < cfg.pinchHoverMs) return;
    const tg = Array.isArray(f.targets) ? f.targets.find((x) => x.id === id) : null;
    if (!tg || tg.disabled) return;
    fire(id, t, 'pinch');
  }

  function fire(id, t, how) {
    out.click = id; out.how = how;
    st.lockedId = id; st.dwell = 0; st.cooldownUntil = t + cfg.cooldownMs; st.clicks++; st.lastHow = how;
  }

  function fill(tg) {
    out.visible = st.visible; out.x = st.x; out.y = st.y;
    out.targetId = st.visible ? st.targetId : null;
    out.disabled = !!(tg && tg.disabled);
    out.progress = st.visible && st.targetId !== null ? clamp(st.dwell / (st.dwellMs || cfg.dwellMs), 0, 1) : 0;
    out.pinched = st.pinched;
    out.locked = st.lockedId !== null && st.lockedId === st.targetId;
    return out;
  }

  return { step, reset, config: cfg, get clicks() { return st.clicks; }, get lastHow() { return st.lastHow; } };
}

// ─────────────────────────────────────────────────────────── DOM-слой
const CLICKABLE = 'button, [role="button"], a[href], summary, label, [data-hand-click]';
const STYLE_ID = 'ao-hc-style';
const CSS = `
.ao-hc{position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden}
.ao-hc__ring{position:absolute;left:0;top:0;width:80px;height:80px;margin:-40px 0 0 -40px;opacity:0;transition:opacity .16s ease-out;will-change:transform,opacity}
.ao-hc.is-on .ao-hc__ring{opacity:1}
.ao-hc__ring svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;transform:rotate(-90deg)}
.ao-hc__track{fill:none;stroke:rgba(8,6,4,.62);stroke-width:11}
.ao-hc__glow{fill:rgba(255,190,96,.12);stroke:#ffe3a8;stroke-width:2.5;filter:drop-shadow(0 0 1.5px rgba(0,0,0,.95)) drop-shadow(0 0 7px rgba(255,170,60,.9)) drop-shadow(0 0 18px rgba(255,140,40,.5));transition:stroke .15s}
.ao-hc__fill{fill:none;stroke:#ffd27a;stroke-width:7;stroke-linecap:round;filter:drop-shadow(0 0 5px rgba(255,190,80,.95))}
.ao-hc__dot{position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#fff3d6;border:1.5px solid rgba(20,12,4,.8);box-shadow:0 0 8px 2px rgba(255,190,90,.95)}
.ao-hc.is-target .ao-hc__glow{stroke:#fff1c9;fill:rgba(255,200,110,.18)}
.ao-hc.is-disabled .ao-hc__glow{stroke:rgba(170,176,188,.85);fill:rgba(120,126,138,.12);filter:none}
.ao-hc.is-pinched .ao-hc__dot{transform:scale(1.8)}
.ao-hc__burst{position:absolute;left:0;top:0;width:80px;height:80px;margin:-40px 0 0 -40px;border-radius:50%;border:3px solid #ffd27a;opacity:0;box-shadow:0 0 18px rgba(255,180,70,.9)}
.ao-hc__burst.is-go{animation:ao-hc-burst .42s ease-out}
@keyframes ao-hc-burst{0%{opacity:.95;transform:var(--ao-hc-at) scale(.6)}100%{opacity:0;transform:var(--ao-hc-at) scale(2.1)}}
.ao-hc__tip{position:absolute;left:0;top:0;margin:48px 0 0 -170px;width:340px;text-align:center;font:600 15px/1.3 "Segoe UI",system-ui,sans-serif;color:#fff3dc;text-shadow:0 1px 3px #000,0 0 10px rgba(0,0,0,.8);opacity:0;transition:opacity .3s}
.ao-hc__tip b{display:block;font-weight:700}.ao-hc__tip span{display:block;font-weight:500;font-size:13px;color:#e8d9bb}
.ao-hc.is-on.is-tip .ao-hc__tip{opacity:1}
.ao-hc-hover{outline:3px solid rgba(255,214,140,.98)!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(255,180,80,.22),0 0 26px 4px rgba(255,170,60,.55)!important;transition:outline-color .12s,box-shadow .12s}
.ao-hc-press{animation:ao-hc-press .32s ease-out}
@keyframes ao-hc-press{0%{filter:brightness(1.9)}100%{filter:none}}
@media (prefers-reduced-motion: reduce){.ao-hc__burst.is-go{animation:none}.ao-hc-press{animation:none}}
`;

// opts: { doc, win, onClick(el, how), onHover(el), core: настройки ядра }
export function createHandCursor(opts = {}) {
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  if (!doc || !win) throw new Error('handCursor: нужен DOM');
  const core = createCursorCore(opts.core || {});
  const R_RING = 32, CIRC = 2 * Math.PI * R_RING;

  if (!doc.getElementById(STYLE_ID)) {
    const s = doc.createElement('style');
    s.id = STYLE_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }
  const NS = 'http://www.w3.org/2000/svg';
  const layer = doc.createElement('div');
  layer.className = 'ao-hc';
  layer.setAttribute('aria-hidden', 'true');
  const ring = doc.createElement('div');
  ring.className = 'ao-hc__ring';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  const circle = (cls, r) => { const c = doc.createElementNS(NS, 'circle'); c.setAttribute('class', cls); c.setAttribute('cx', '40'); c.setAttribute('cy', '40'); c.setAttribute('r', String(r)); return c; };
  const track = circle('ao-hc__track', R_RING);              // тёмная подложка — кольцо видно и на золотой кнопке
  const glow = circle('ao-hc__glow', R_RING - 8);
  const fillC = circle('ao-hc__fill', R_RING);
  fillC.setAttribute('stroke-dasharray', CIRC.toFixed(2)); fillC.setAttribute('stroke-dashoffset', CIRC.toFixed(2));
  svg.append(track, glow, fillC);
  const dot = doc.createElement('i');
  dot.className = 'ao-hc__dot';
  ring.append(svg, dot);
  const burst = doc.createElement('div');
  burst.className = 'ao-hc__burst';
  const tip = doc.createElement('div');
  tip.className = 'ao-hc__tip';
  const tipMain = doc.createElement('b'), tipSub = doc.createElement('span');
  tipMain.textContent = 'Задержите палец на кнопке';
  tipSub.textContent = 'или сведите большой и указательный';
  tip.append(tipMain, tipSub);
  layer.append(burst, ring, tip);
  doc.body.appendChild(layer);

  // цели: кнопки на экране, ~6 раз в секунду (прямоугольники кешируются)
  let targets = [], els = new Map(), scanAt = -1e9, nextId = 1;
  const ids = new WeakMap();
  const idOf = (el) => { let i = ids.get(el); if (!i) { i = nextId++; ids.set(el, i); } return i; };
  function usable(el) {
    if (el.closest('.ao-hc, [inert], [hidden], [data-hand-skip]')) return false;
    const tag = el.tagName;
    if (tag === 'LABEL') {
      const inp = el.control || el.querySelector('input');
      if (!inp || !/^(radio|checkbox)$/.test(inp.type) || inp.disabled) return false;
    }
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = win.getComputedStyle(el);
    if (cs.pointerEvents === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }
  function scan() {
    const W = win.innerWidth, H = win.innerHeight;
    const list = [], map = new Map();
    for (const el of doc.querySelectorAll(CLICKABLE)) {
      if (el.disabled === true && el.tagName === 'BUTTON' && !el.getAttribute('aria-disabled')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) continue;
      if (!usable(el)) continue;
      // кнопка не закрыта другим слоем (книга поверх меню, модальные окна)
      const cx = clamp((r.left + r.right) / 2, 1, W - 1), cy = clamp((r.top + r.bottom) / 2, 1, H - 1);
      const hit = doc.elementFromPoint(cx, cy);
      if (!hit || !(hit === el || el.contains(hit))) continue;
      const id = idOf(el);
      const disabled = el.getAttribute('aria-disabled') === 'true' || el.disabled === true;
      list.push({ id, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, disabled });
      map.set(id, el);
    }
    targets = list; els = map;
  }

  let hoverEl = null, tipUntil = 0, tipShown = false, firstAt = 0;
  const debug = { visible: false, x: 0, y: 0, target: '', progress: 0, clicks: 0, how: null, targets: 0 };
  function setHover(el) {
    if (el === hoverEl) return;
    if (hoverEl) hoverEl.classList.remove('ao-hc-hover');
    hoverEl = el;
    if (el) { el.classList.add('ao-hc-hover'); if (typeof opts.onHover === 'function') { try { opts.onHover(el); } catch (e) { /* звук не критичен */ } } }
  }
  function press(el, how) {
    try { el.focus({ preventScroll: true }); } catch (e) { /* не фокусируется */ }
    el.classList.remove('ao-hc-press');
    void el.offsetWidth;                           // перезапуск анимации нажатия
    el.classList.add('ao-hc-press');
    win.setTimeout(() => el.classList.remove('ao-hc-press'), 360);
    burst.classList.remove('is-go'); void burst.offsetWidth; burst.classList.add('is-go');
    el.click();
    if (typeof opts.onClick === 'function') { try { opts.onClick(el, how); } catch (e) { /* звук не критичен */ } }
  }
  function cls(name, on) { if (layer.classList.contains(name) !== on) layer.classList.toggle(name, on); }
  // прокрутка у края: кольцо у нижней (верхней) кромки прокручиваемой панели — панель едет (меню на низком экране)
  const EDGE_PX = 70, SCROLL_PXS = 520;
  let scrollEl = null, scrollAt = -1e9, lastScrollT = 0;
  function scrollable(el) {
    while (el && el !== doc.body && el !== doc.documentElement) {
      if (el.scrollHeight > el.clientHeight + 4 && !el.closest('.ao-hc')) {
        const oy = win.getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
      }
      el = el.parentElement;
    }
    return null;
  }
  // кольцо у края экрана может стоять ниже (выше) самой панели — пробуем точки ближе к середине
  function scrollerAt(x, y) {
    const dir = y > win.innerHeight / 2 ? -1 : 1;
    for (const d of [0, 40, 80, 130]) {
      const el = scrollable(doc.elementFromPoint(x, clamp(y + dir * d, 1, win.innerHeight - 1)));
      if (el) return el;
    }
    const se = doc.scrollingElement;
    return se && se.scrollHeight > se.clientHeight + 4 ? se : null;
  }
  function edgeScroll(now, o) {
    const dt = lastScrollT ? Math.min(0.1, (now - lastScrollT) / 1000) : 0;
    lastScrollT = now;
    if (!o.visible || o.pinched) return;
    if (now - scrollAt > 250) { scrollAt = now; scrollEl = scrollerAt(clamp(o.x, 1, win.innerWidth - 1), clamp(o.y, 1, win.innerHeight - 1)); }
    if (!scrollEl) return;
    const r = scrollEl === doc.scrollingElement ? { top: 0, bottom: win.innerHeight } : scrollEl.getBoundingClientRect();
    const top = Math.max(0, r.top), bottom = Math.min(win.innerHeight, r.bottom);
    let k = 0;
    if (o.y > bottom - EDGE_PX) k = (o.y - (bottom - EDGE_PX)) / EDGE_PX;
    else if (o.y < top + EDGE_PX) k = -((top + EDGE_PX) - o.y) / EDGE_PX;
    if (k) { scrollEl.scrollTop += clamp(k, -1, 1) * SCROLL_PXS * dt; scanAt = -1e9; }
  }

  // f: { hands, pose, active, pinch, dwellMs }
  function update(now, f = {}) {
    const active = !!f.active;
    if (active && now - scanAt > 160) { scanAt = now; scan(); }
    const o = core.step({ t: now, viewport: { w: win.innerWidth, h: win.innerHeight }, hands: f.hands, pose: f.pose, targets: active ? targets : [], active, pinch: f.pinch !== false, dwellMs: f.dwellMs });
    const el = o.visible && o.targetId !== null ? els.get(o.targetId) || null : null;
    setHover(el && !o.disabled ? el : null);
    if (o.click !== null) {
      const ce = els.get(o.click);
      if (ce && ce.isConnected) { press(ce, o.how); debug.clicks++; debug.how = o.how; tipUntil = 0; scanAt = -1e9; }
    }
    edgeScroll(now, o);
    if (o.visible) {
      const at = `translate3d(${o.x.toFixed(1)}px,${o.y.toFixed(1)}px,0)`;
      ring.style.transform = at; tip.style.transform = at;
      burst.style.setProperty('--ao-hc-at', at);
      if (!burst.classList.contains('is-go')) burst.style.transform = at;
      fillC.setAttribute('stroke-dashoffset', (CIRC * (1 - o.progress)).toFixed(2));
      // подсказка — в первые секунды, пока игрок ни разу не нажал
      if (!tipShown) { tipShown = true; firstAt = now; tipUntil = now + 7000; }
    }
    cls('is-on', o.visible);
    cls('is-target', !!el && !o.disabled);
    cls('is-disabled', !!el && o.disabled);
    cls('is-pinched', o.pinched);
    cls('is-tip', o.visible && now < tipUntil);
    debug.visible = o.visible; debug.x = Math.round(o.x); debug.y = Math.round(o.y);
    debug.target = el ? (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40) : '';
    debug.progress = Math.round(o.progress * 100) / 100; debug.targets = targets.length;
    return o;
  }

  function hide() { update(0, { active: false }); }
  function dispose() { setHover(null); layer.remove(); }
  return { update, hide, dispose, getDebug: () => ({ ...debug, firstAt }), core };
}
