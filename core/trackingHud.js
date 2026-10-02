// ASHEN OATH — HUD трекинга в стиле «tracking edit» поверх превью камеры.
//
// Рисует на overlay-canvas (#ao-overlay) каждый кадр, когда main.js вызывает draw():
//  - скобки-рамки HEAD / L.HAND / R.HAND / TORSO с живыми координатами кадра;
//  - «созвездие» суставов (плечи, локти, запястья) и линию голова — торс;
//  - нейтраль калибровки (пунктир, мёртвая зона, линейка наклона, «LEAN +0.42»);
//  - состояния жестов: FIRE / SHIELD / BURST (кольцо заряда) / DASH (шлейф);
//  - колонку данных CV (full), «NO TARGET» при потере, полосу калибровки.
//
// Правила модуля: без импортов, без собственного rAF, никогда не бросает исключений.
// Горячий путь без аллокаций: цвета — константы (прозрачность через globalAlpha),
// ширины текста кешируются, строки координат пересобираются не чаще 15 Гц.
// Landmarks приходят в нормализованных НЕзеркальных координатах (0..1); при
// pose.mirror !== false рисуем x' = 1 - x (превью <video> зеркалится CSS).
// Правая рука игрока — огонь, левая — щит.
// [ПРОЕКТОР] Цвет кисти — по стороне: левая синяя («движение»), правая оранжевая («магия»).
// Рисунок масштабируется под размер канваса (zoom): в крупном доке боя и в режиме презентации
// подписи не мельче ~14 px, линии толще. Атрибут data-hud-mode="full|mini" у родителя канваса
// (слот камеры ui.js) переопределяет режим, переданный main.js (main.js читает его и для handFxOverlay).

const MONO = '"Consolas","Cascadia Mono",monospace';

const GOLD = '#c9a45c';
const GOLD_HI = '#e3c792';
const STEEL = '#dfe8f5';
const BLUE = '#9fc4ff';
const EMBER = '#ff6a3c';
const PLATE = 'rgba(5,7,11,0.66)';
const DIM = '#8d97a6';
const LEFT_C = '#5aaeff';      // левая кисть — движение
const RIGHT_C = '#ff9a3c';     // правая кисть — магия

const F_TAG = '10px ' + MONO;
const F_CHIP = '600 11px ' + MONO;
const F_DATA = '10px ' + MONO;
const F_MINI = '8px ' + MONO;
const F_MINI_CHIP = '600 8px ' + MONO;

const FADE_IN_MS = 120;
const FADE_OUT_MS = 300;
const DASH_MS = 450;
const BURST_MS = 500;
const MINI_BASE_W = 160;       // [ПРОЕКТОР] логическая ширина мини-рисунка: шире канвас — крупнее всё
const FULL_BASE_W = 360;       // то же для полного рисунка
const STALE_MS = 800;          // pose.tMs не меняется дольше — считаем цель потерянной
const COORD_EVERY_MS = 66;     // «живые» цифры ~15 Гц
const DATA_EVERY_MS = 250;     // колонка данных 4 Гц

const GLYPHS = '0123456789ABCDEFXZ#%+=/<>';
// MediaPipe Pose: 0 нос, 11/12 плечи, 13/14 локти, 15/16 запястья (левое/правое самого человека).
const NODE_IDX = [0, 11, 12, 13, 14, 15, 16];
const S_NOSE = 0, S_LS = 1, S_RS = 2, S_LE = 3, S_RE = 4, S_LW = 5, S_RW = 6;

const DASH_LINE = [3, 4];
const DASH_FINE = [2, 3];
const NO_DASH = [];
const EMPTY = Object.freeze({});

function isObj(v) { return v !== null && typeof v === 'object'; }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function approach(v, target, step) {
  if (v < target) return v + step > target ? target : v + step;
  if (v > target) return v - step < target ? target : v - step;
  return v;
}
function pad3(n) {
  n = n < 0 ? 0 : n > 9999 ? 9999 : n | 0;
  return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n;
}
function pad6(n) {
  n = n < 0 ? 0 : n % 1000000 | 0;
  const s = '' + n;
  return '000000'.slice(s.length) + s;
}
function fixed(v, d) { return num(v, NaN) === v ? v.toFixed(d) : '--'; }
function signed2(v) {
  const r = Math.round(v * 100) / 100;
  return (r < 0 ? '-' : '+') + Math.abs(r).toFixed(2);
}

function makeLabel() { return { text: '', since: -1e9, w: 0, font: '' }; }

function makeBox(name, short) {
  return {
    name, short,
    x: 0.5, y: 0.5, w: 0.1, h: 0.1, vx: 0, vy: 0, vw: 0, vh: 0,   // текущее (доли видео-прямоугольника)
    tx: 0.5, ty: 0.5, tw: 0.1, th: 0.1,                              // цель
    valid: false, alpha: 0, acquiredAt: -1e9,
    fx: -1, fy: -1, coord: '', coordAt: -1e9,
    glitchAt: 0, glitchUntil: -1e9,
    state: makeLabel(),
  };
}

const NOOP_HUD = Object.freeze({ draw() {}, clear() {}, dispose() {} });

/**
 * @param {{canvas: HTMLCanvasElement}} opts
 * @returns {{draw(nowMs:number, frame:object):void, clear():void, dispose():void}}
 */
export function createTrackingHud(opts) {
  const canvas = isObj(opts) ? opts.canvas : null;
  let ctx = null;
  try { ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null; } catch (e) { ctx = null; }
  if (!ctx) return NOOP_HUD;

  let disposed = false;
  let warnings = 0;

  // ---- геометрия (CSS px; контекст масштабирован на dpr)
  let dpr = 1;
  let rx = 0, ry = 0, rw = 0, rh = 0;         // прямоугольник видео («contain»)
  let frameW = 640, frameH = 480;
  let mirror = true;
  let lwDev = 1, lw = 1, lwEmDev = 1, lwEm = 1; // линии 1 и ~1.5 CSS px в целых device px
  let curFont = '';
  let lastNow = -1;
  let drawnSomething = false;

  // ---- поза
  let lastPoseT = NaN;
  let poseFrames = 0;
  let poseChangedAt = -1e9;
  const rawU = [0, 0, 0, 0, 0, 0, 0];
  const rawV = [0, 0, 0, 0, 0, 0, 0];
  const rawOk = [false, false, false, false, false, false, false];
  const nodeU = [0, 0, 0, 0, 0, 0, 0];
  const nodeV = [0, 0, 0, 0, 0, 0, 0];
  const nodeA = [0, 0, 0, 0, 0, 0, 0];
  let swN = 0.28;                               // ширина плеч в долях ширины видео (последняя известная)
  let trackAlpha = 0;
  let lostAlpha = 1;

  const torso = makeBox('TORSO', 'T');
  const head = makeBox('HEAD', 'H');
  const lHand = makeBox('L.HAND', 'L');
  const rHand = makeBox('R.HAND', 'R');
  const BOXES = [torso, head, lHand, rHand];

  // ---- жесты и импульсы
  let bothSince = -1;
  let dashAt = -1e9, dashDir = 0;
  let burstAt = -1e9;
  let stickDashAt = -1e9, stickDashX = 0, stickDashZ = 0;
  const burstLabel = makeLabel();
  const dashLabel = makeLabel();
  const headingLabel = makeLabel();
  const trackWord = makeLabel();

  // ---- кеши строк
  let leanText = '';
  let leanVal = NaN;
  let dataAt = -1e9;
  let dConf = '', dHz = '', dMode = '', dFrm = '', dRes = '';
  let calibText = '', calibPct = -1;
  let scanText = '', scanAt = -1e9;
  let msgSrc = null, msgFont = '', msgMaxW = 0, msgL1 = '', msgL2 = '';
  const charW = new Map();
  const textW = new Map();

  // ------------------------------------------------------------ утилиты рисования
  function setFont(f) { if (curFont !== f) { ctx.font = f; curFont = f; } }
  function charWidth(font) {
    let w = charW.get(font);
    if (w === undefined) { setFont(font); w = ctx.measureText('0').width || 6; charW.set(font, w); }
    return w;
  }
  function measure(font, text) {
    const key = font + '\u0001' + text;
    let w = textW.get(key);
    if (w === undefined) {
      if (textW.size > 256) textW.clear();
      setFont(font);
      w = ctx.measureText(text).width;
      textW.set(key, w);
    }
    return w;
  }
  function setLabel(l, text, font, now) {
    if (l.text === text && l.font === font) return;
    if (l.text !== text) l.since = now;
    l.text = text; l.font = font;
    l.w = text ? measure(font, text) : 0;
  }
  // Раскрытие символов слева направо; нераскрытые — случайные глифы.
  function scrambled(text, since, now, rm) {
    if (rm || !text) return text;
    const dur = Math.min(260, 60 + text.length * 18);
    const e = now - since;
    if (e >= dur || e < 0) return text;
    const n = text.length;
    const k = Math.floor((n * e) / dur);
    let s = text.slice(0, k);
    for (let i = k; i < n; i++) {
      const c = text.charCodeAt(i);
      s += c === 32 ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    return s;
  }
  // Привязка к device px: линия толщиной wDev пикселей ложится ровно на сетку.
  function snap(v, wDev) { return (Math.round(v * dpr) + (wDev & 1 ? 0.5 : 0)) / dpr; }
  function snapT(v) { return Math.round(v * dpr) / dpr; }

  function brackets(l, t, r, b, len, wDev) {
    l = snap(l, wDev); r = snap(r, wDev); t = snap(t, wDev); b = snap(b, wDev);
    const lx = Math.min(len, (r - l) * 0.45), ly = Math.min(len, (b - t) * 0.45);
    ctx.moveTo(l, t + ly); ctx.lineTo(l, t); ctx.lineTo(l + lx, t);
    ctx.moveTo(r - lx, t); ctx.lineTo(r, t); ctx.lineTo(r, t + ly);
    ctx.moveTo(r, b - ly); ctx.lineTo(r, b); ctx.lineTo(r - lx, b);
    ctx.moveTo(l + lx, b); ctx.lineTo(l, b); ctx.lineTo(l, b - ly);
  }

  function plate(x, y, w, h, a) {
    ctx.globalAlpha = a;
    ctx.fillStyle = PLATE;
    ctx.fillRect(snapT(x), snapT(y), snapT(w), snapT(h));
  }

  function text(str, x, y, color, a) {
    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    ctx.fillText(str, snapT(x), snapT(y));
  }

  function hline(x0, x1, y, wDev) { const yy = snap(y, wDev); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); }
  function vline(x, y0, y1, wDev) { const xx = snap(x, wDev); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); }

  // ------------------------------------------------------------ данные
  function readPoints(lms) {
    let anyVis = false;
    if (lms) {
      for (let s = 0; s < 7; s++) {
        const p = lms[NODE_IDX[s]];
        if (isObj(p) && num(p.visibility, 0) > 0) { anyVis = true; break; }
      }
    }
    for (let s = 0; s < 7; s++) {
      const p = lms ? lms[NODE_IDX[s]] : null;
      let ok = false;
      if (isObj(p)) {
        const x = p.x, y = p.y;
        if (typeof x === 'number' && typeof y === 'number' && x > -0.15 && x < 1.15 && y > -0.15 && y < 1.2) {
          const vis = p.visibility;
          ok = !anyVis || typeof vis !== 'number' || !(vis === vis) || vis >= 0.5;
          if (ok) { rawU[s] = mirror ? 1 - x : x; rawV[s] = y; }
        }
      }
      rawOk[s] = ok;
    }
  }

  function setTarget(b, cxPx, cyPx, wPx, hPx) {
    b.tx = cxPx / rw; b.ty = cyPx / rh; b.tw = wPx / rw; b.th = hPx / rh;
    b.valid = true;
  }

  function computeTargets(mini) {
    for (let i = 0; i < 4; i++) BOXES[i].valid = false;
    const shOk = rawOk[S_LS] && rawOk[S_RS];
    let swPx = swN * rw;
    if (shOk) {
      const d = Math.hypot((rawU[S_LS] - rawU[S_RS]) * rw, (rawV[S_LS] - rawV[S_RS]) * rh);
      if (d > 4) { swPx = d; swN = d / rw; }
    }
    const minBox = mini ? 7 : 14;
    if (shOk) {
      const uA = Math.min(rawU[S_LS], rawU[S_RS]) * rw, uB = Math.max(rawU[S_LS], rawU[S_RS]) * rw;
      const vA = Math.min(rawV[S_LS], rawV[S_RS]) * rh, vB = Math.max(rawV[S_LS], rawV[S_RS]) * rh;
      const l = uA - 0.16 * swPx, r = uB + 0.16 * swPx, t = vA - 0.14 * swPx, b = vB + 0.62 * swPx;
      setTarget(torso, (l + r) / 2, (t + b) / 2, r - l, b - t);
    }
    if (rawOk[S_NOSE]) {
      const w = Math.max(minBox, 0.5 * swPx), h = Math.max(minBox * 1.2, 0.62 * swPx);
      setTarget(head, rawU[S_NOSE] * rw, rawV[S_NOSE] * rh - 0.08 * swPx, w, h);
    }
    handTarget(lHand, S_LW, S_LE, swPx, minBox);
    handTarget(rHand, S_RW, S_RE, swPx, minBox);
  }

  function handTarget(b, sw, se, swPx, minBox) {
    if (!rawOk[sw]) return;
    let x = rawU[sw] * rw, y = rawV[sw] * rh;
    if (rawOk[se]) {
      // кисть продолжает предплечье: центр рамки чуть дальше запястья
      const dx = x - rawU[se] * rw, dy = y - rawV[se] * rh;
      const d = Math.hypot(dx, dy);
      if (d > 1) { x += (dx / d) * 0.1 * swPx; y += (dy / d) * 0.1 * swPx; }
    }
    const s = Math.max(minBox, 0.32 * swPx);
    setTarget(b, x, y, s, s);
  }

  function springBox(b, dt, rm) {
    if (dt <= 0) return;
    if (dt > 0.1) {
      b.x = b.tx; b.y = b.ty; b.w = b.tw; b.h = b.th; b.vx = b.vy = b.vw = b.vh = 0;
      return;
    }
    // Лёгкий перелёт (ζ≈0.62, ~8%) — рамка «цепляется» за цель; reducedMotion — без перелёта.
    const omega = rm ? 46 : 34;
    const zeta = rm ? 1 : 0.62;
    const k = omega * omega, c = 2 * zeta * omega;
    let n = Math.ceil(dt / 0.008);
    if (n > 13) n = 13;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      b.vx += (k * (b.tx - b.x) - c * b.vx) * h; b.x += b.vx * h;
      b.vy += (k * (b.ty - b.y) - c * b.vy) * h; b.y += b.vy * h;
      b.vw += (k * (b.tw - b.w) - c * b.vw) * h; b.w += b.vw * h;
      b.vh += (k * (b.th - b.h) - c * b.vh) * h; b.h += b.vh * h;
    }
    if (b.w < 0.002) b.w = 0.002;
    if (b.h < 0.002) b.h = 0.002;
  }

  function updateBox(b, dt, now, present, rm) {
    const want = b.valid && present;
    if (want && b.alpha <= 0.01) {
      // захват цели: рамка «защёлкивается» с увеличенного размера
      const z = rm ? 1 : 1.75;
      b.x = b.tx; b.y = b.ty; b.w = b.tw * z; b.h = b.th * z;
      b.vx = b.vy = b.vw = b.vh = 0;
      b.acquiredAt = now;
      b.coordAt = -1e9;
      b.glitchAt = now + 1800 + Math.random() * 3500;
    }
    b.alpha = approach(b.alpha, want ? 1 : 0, (dt * 1000) / (want ? FADE_IN_MS : FADE_OUT_MS));
    if (b.alpha > 0 && want) springBox(b, dt, rm);
  }

  function updateNodes(dt, present) {
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.035) : 0;
    for (let s = 0; s < 7; s++) {
      const want = rawOk[s] && present;
      if (want) {
        if (nodeA[s] <= 0.01 || dt > 0.1) { nodeU[s] = rawU[s]; nodeV[s] = rawV[s]; }
        else { nodeU[s] += (rawU[s] - nodeU[s]) * k; nodeV[s] += (rawV[s] - nodeV[s]) * k; }
      }
      nodeA[s] = approach(nodeA[s], want ? 1 : 0, (dt * 1000) / (want ? FADE_IN_MS : FADE_OUT_MS));
    }
  }

  // ------------------------------------------------------------ слои
  function drawViewfinder(a) {
    const inset = 4, len = 11;
    ctx.globalAlpha = 0.42 * a;
    ctx.strokeStyle = STEEL;
    ctx.lineWidth = lw;
    ctx.beginPath();
    brackets(rx + inset, ry + inset, rx + rw - inset, ry + rh - inset, len, lwDev);
    ctx.stroke();
  }

  function drawNeutral(dbg, input, mini) {
    const bl = dbg && isObj(dbg.baseline) ? dbg.baseline : null;
    if (!bl) return;
    const cxN = num(bl.centerX, NaN);
    if (!(cxN === cxN)) return;
    const th = isObj(dbg.thresholds) ? dbg.thresholds : EMPTY;
    const bfw = num(bl.frameW, 0), bfh = num(bl.frameH, 0);
    const aspect = bfw > 0 && bfh > 0 ? bfw / bfh : frameW / frameH;
    const swNorm = num(bl.shoulderWidth, NaN) > 0 ? bl.shoulderWidth / aspect : swN;
    const swPx = swNorm * rw;
    const x0 = rx + (mirror ? 1 - cxN : cxN) * rw;
    const dz = num(th.deadZone, 0.06) * swPx;
    const full = num(th.moveFull, 0.24) * swPx;
    const dashA = num(th.dashAmplitude, 0.28) * swPx;

    // мёртвая зона — едва заметная полоса
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = GOLD;
    ctx.fillRect(snapT(x0 - dz), ry, snapT(2 * dz), rh);

    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = lw;
    ctx.setLineDash(mini ? DASH_FINE : DASH_LINE);
    ctx.beginPath();
    vline(x0, ry, ry + rh, lwDev);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);

    // линейка наклона внизу кадра
    const yR = ry + rh - (mini ? 6 : 13);
    const span = dashA * 1.25;
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = STEEL;
    ctx.beginPath();
    hline(x0 - span, x0 + span, yR, lwDev);
    const t1 = mini ? 2 : 3, t2 = mini ? 3 : 5;
    vline(x0 - full, yR - t1, yR + t1, lwDev); vline(x0 + full, yR - t1, yR + t1, lwDev);
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = GOLD;
    ctx.beginPath();
    vline(x0 - dz, yR - t1, yR + t1, lwDev); vline(x0 + dz, yR - t1, yR + t1, lwDev);
    ctx.stroke();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = EMBER;
    ctx.beginPath();
    vline(x0 - dashA, yR - t2, yR + t2, lwDev); vline(x0 + dashA, yR - t2, yR + t2, lwDev);
    ctx.stroke();

    // маркер текущего смещения (центр плеч) и LEAN
    if (trackAlpha <= 0.01 || torso.alpha <= 0.01) return;
    const xm = rx + torso.x * rw;
    const off = Math.abs(xm - x0);
    const col = off >= dashA ? EMBER : off > dz ? BLUE : GOLD_HI;
    const xc = clamp(xm, x0 - span, x0 + span);
    const s = mini ? 3 : 4;
    ctx.globalAlpha = trackAlpha;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(xc - s, yR - s - 2); ctx.lineTo(xc + s, yR - s - 2); ctx.lineTo(xc, yR - 1);
    ctx.closePath();
    ctx.fill();
    if (mini) return;
    let mv = input && input.valid !== false ? num(input.moveX, NaN) : NaN;
    if (!(mv === mv)) mv = num(dbg.lateral && dbg.lateral.moveX, 0);
    const r = Math.round(mv * 100);
    if (r !== leanVal) { leanVal = r; leanText = 'LEAN ' + signed2(mv); }
    const cwD = charWidth(F_DATA);
    const tw = leanText.length * cwD;
    let tx = xc + 8;
    if (tx + tw > rx + rw - 4) tx = xc - 8 - tw;
    const ty = yR - 14;
    setFont(F_DATA);
    plate(tx - 3, ty - 1, tw + 6, 12, 0.8 * trackAlpha);
    text(leanText, tx, ty, col, trackAlpha);
  }

  // [ASHEN_V2] Левый джойстик: кольцо полного хода вокруг центра хватки, мёртвая зона,
  // тяга «центр → кисть» и стрелка выхода; до хватки — прогресс «замри» у кисти.
  // Координаты стика — 0..1 кадра, x уже зеркален как превью; радиусы — в долях высоты кадра.
  function drawStick(stick, now, rm, mini) {
    const hand = isObj(stick.hand) ? stick.hand : null;
    const anc = isObj(stick.anchor) ? stick.anchor : null;
    const hxS = hand ? rx + num(hand.x, 0.5) * rw : 0, hyS = hand ? ry + num(hand.y, 0.5) * rh : 0;
    const k = mini ? 0.8 : 1;
    if (stick.mode === 'steer' && anc) {
      // [V5] «Руль»: линия «шаг» на уровне груди — ладонь выше неё ведёт героя (колечко — нейтраль руля)
      const ly = ry + num(anc.y, 0.5) * rh, lx = rx + num(anc.x, 0.5) * rw;
      const half = clamp(num(stick.full, 0.16) * rh * 1.6, 16, rw * 0.3);
      ctx.lineWidth = lw;
      ctx.globalAlpha = stick.engaged ? 0.35 : 0.75;
      ctx.strokeStyle = stick.engaged ? STEEL : GOLD_HI;
      ctx.setLineDash(mini ? DASH_FINE : DASH_LINE);
      ctx.beginPath(); ctx.moveTo(lx - half, ly); ctx.lineTo(lx + half, ly); ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    if (stick.engaged && anc) {
      const cx = rx + num(anc.x, 0.5) * rw, cy = ry + num(anc.y, 0.5) * rh;
      const full = clamp(num(stick.full, 0.16) * rh, 10, rh * 0.45);
      const dz = clamp(num(stick.deadzone, 0.035) * rh, 3, full * 0.6);
      const sx = num(stick.x, 0), sz = num(stick.z, 0);
      const mag = Math.min(1, Math.hypot(sx, sz));
      const run = stick.gait ? stick.gait === 'run' : mag > 0.55;   // [V3.1] ступень хода из джойстика (с гистерезисом)
      const col = mag <= 0.01 ? GOLD : run ? GOLD_HI : BLUE;
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = GOLD;
      ctx.beginPath(); ctx.arc(cx, cy, dz, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = lw;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = STEEL;
      ctx.setLineDash(mini ? DASH_FINE : DASH_LINE);
      ctx.beginPath(); ctx.arc(cx, cy, full, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = GOLD;
      ctx.beginPath(); ctx.arc(cx, cy, dz, 0, Math.PI * 2); ctx.stroke();
      if (hand) {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hxS, hyS); ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(hxS, hyS, 2.4 * k, 0, Math.PI * 2); ctx.fill();
      }
      if (mag > 0.01) {
        // стрелка выхода: x — вправо на превью, z (вперёд) — вверх
        const ux = sx / mag, uy = -sz / mag;
        const L = dz + (full - dz) * mag;
        const ex = cx + ux * L, ey = cy + uy * L;
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = col;
        ctx.lineWidth = lwEm;
        ctx.beginPath(); ctx.moveTo(cx + ux * dz, cy + uy * dz); ctx.lineTo(ex, ey); ctx.stroke();
        const hs = 5 * k;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(ex + ux * hs, ey + uy * hs);
        ctx.lineTo(ex - ux * hs * 0.6 - uy * hs * 0.7, ey - uy * hs * 0.6 + ux * hs * 0.7);
        ctx.lineTo(ex - ux * hs * 0.6 + uy * hs * 0.7, ey - uy * hs * 0.6 - ux * hs * 0.7);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = lw;
      }
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = GOLD_HI;
      ctx.beginPath(); ctx.arc(cx, cy, 1.6 * k, 0, Math.PI * 2); ctx.fill();
      if (!mini) {
        const tag = (mag <= 0.01 ? 'STICK' : run ? 'RUN' : 'WALK') + (stick.source === 'wrist' ? ' · WRIST' : '');
        setFont(F_DATA);
        const tw = measure(F_DATA, tag);
        const tx = clamp(cx - tw / 2, rx + 2, rx + rw - tw - 2), ty = clamp(cy + full + 4, ry + 2, ry + rh - 14);
        plate(tx - 3, ty - 1, tw + 6, 12, 0.75);
        text(tag, tx, ty, col, 0.95);
      }
    } else if (hand) {
      // до хватки: пульс у кисти; «замри» — дуга заполняется, пока рука неподвижна
      const r = (mini ? 7 : 11);
      ctx.lineWidth = lw;
      if (stick.rest || stick.mode === 'steer') {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = DIM;
        ctx.setLineDash(DASH_FINE);
        ctx.beginPath(); ctx.arc(hxS, hyS, r, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash(NO_DASH);
      } else {
        const ph = rm ? 0.6 : 0.5 + 0.5 * Math.sin(now * 0.012);
        ctx.globalAlpha = stick.grabbing ? 0.9 : 0.35 + 0.35 * ph;
        ctx.strokeStyle = stick.grabbing ? GOLD_HI : GOLD;
        ctx.beginPath(); ctx.arc(hxS, hyS, r + (stick.grabbing ? 0 : 2 * ph), 0, Math.PI * 2); ctx.stroke();
        if (!mini) {
          const tag = stick.grabbing ? 'GRAB…' : 'HOLD ◎';
          setFont(F_DATA);
          const tw = measure(F_DATA, tag);
          const tx = clamp(hxS - tw / 2, rx + 2, rx + rw - tw - 2), ty = clamp(hyS + r + 4, ry + 2, ry + rh - 14);
          plate(tx - 3, ty - 1, tw + 6, 12, 0.75);
          text(tag, tx, ty, stick.grabbing ? GOLD_HI : GOLD, 0.9);
        }
      }
    }
    // вспышка рывка: дуга в сторону дёрга
    const dk = now - stickDashAt < DASH_MS && now >= stickDashAt ? 1 - (now - stickDashAt) / DASH_MS : 0;
    if (dk > 0 && (anc || hand)) {
      const cx = anc ? rx + num(anc.x, 0.5) * rw : hxS, cy = anc ? ry + num(anc.y, 0.5) * rh : hyS;
      const a0 = Math.atan2(-stickDashZ, stickDashX);
      const R = (mini ? 14 : 24) + (1 - dk) * (mini ? 10 : 22);
      ctx.globalAlpha = dk;
      ctx.strokeStyle = EMBER;
      ctx.lineWidth = lwEm * 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, R, a0 - 0.6, a0 + 0.6); ctx.stroke();
      ctx.lineWidth = lw;
    }
    ctx.globalAlpha = 1;
  }

  function drawConstellation(rState, lState, mini) {
    if (trackAlpha <= 0.01) return;
    const a = trackAlpha;
    ctx.lineWidth = lw;
    // голова — центр торса
    if (head.alpha > 0.05 && torso.alpha > 0.05) {
      ctx.globalAlpha = 0.42 * a * Math.min(head.alpha, torso.alpha);
      ctx.strokeStyle = STEEL;
      ctx.beginPath();
      ctx.moveTo(rx + head.x * rw, ry + (head.y + head.h * 0.5) * rh);
      ctx.lineTo(rx + torso.x * rw, ry + torso.y * rh);
      ctx.stroke();
    }
    // линия плеч
    ctx.globalAlpha = 0.5 * a;
    ctx.strokeStyle = STEEL;
    ctx.beginPath();
    seg(S_LS, S_RS);
    ctx.stroke();
    armPath(S_LS, S_LE, S_LW, LEFT_C, lState ? 0.9 : 0.6, a);
    armPath(S_RS, S_RE, S_RW, RIGHT_C, rState ? 0.9 : 0.6, a);
    // узлы
    const r = mini ? 1.2 : 1.8;
    ctx.globalAlpha = 0.9 * a;
    ctx.fillStyle = STEEL;
    ctx.beginPath();
    for (let s = 1; s < 7; s++) {
      if (nodeA[s] < 0.3) continue;
      const x = rx + nodeU[s] * rw, y = ry + nodeV[s] * rh;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, 6.2832);
    }
    ctx.fill();
  }

  function seg(s0, s1) {
    if (nodeA[s0] < 0.3 || nodeA[s1] < 0.3) return;
    ctx.moveTo(rx + nodeU[s0] * rw, ry + nodeV[s0] * rh);
    ctx.lineTo(rx + nodeU[s1] * rw, ry + nodeV[s1] * rh);
  }
  function armPath(sS, sE, sW, color, alpha, a) {
    ctx.globalAlpha = alpha * a;
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (nodeA[sE] >= 0.3) { seg(sS, sE); seg(sE, sW); } else seg(sS, sW);
    ctx.stroke();
  }

  function boxRect(b) {
    // вызывающий читает BX/BY/BW/BH
    BX = rx + b.x * rw; BY = ry + b.y * rh; BW = b.w * rw; BH = b.h * rh;
  }
  let BX = 0, BY = 0, BW = 0, BH = 0;

  function drawBox(b, color, emph, pulse, now, rm, mini) {
    if (b.alpha <= 0.01) return;
    boxRect(b);
    const grow = pulse;
    const l = BX - BW / 2 - grow, r = BX + BW / 2 + grow, t = BY - BH / 2 - grow, bt = BY + BH / 2 + grow;
    const len = mini ? clamp(Math.min(BW, BH) * 0.3, 2, 6) : clamp(Math.min(BW, BH) * 0.28, 4, 13);
    ctx.globalAlpha = (emph ? 1 : 0.82) * b.alpha;
    ctx.strokeStyle = color;
    const wd = emph ? lwEmDev : lwDev;
    ctx.lineWidth = emph ? lwEm : lw;
    ctx.beginPath();
    brackets(l, t, r, bt, len, wd);
    ctx.stroke();
  }

  function crosshair(x, y, gap, len, color, a) {
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    hline(x - gap - len, x - gap, y, lwDev); hline(x + gap, x + gap + len, y, lwDev);
    vline(x, y - gap - len, y - gap, lwDev); vline(x, y + gap, y + gap + len, lwDev);
    ctx.stroke();
  }

  // Ярлык рамки: «R.HAND  x:402 y:120» (full) / «R» (mini) и чип состояния над ним.
  function drawTag(b, color, stateColor, now, rm, mini) {
    if (b.alpha <= 0.01) return;
    boxRect(b);
    const a = b.alpha;
    const top = BY - BH / 2, bottom = BY + BH / 2, left = BX - BW / 2;
    const font = mini ? F_MINI : F_TAG;
    const cwT = charWidth(font);
    const lh = mini ? 9 : 12;
    const nameStr = mini ? b.short : b.name;
    // координаты в пикселях отображаемого кадра, ~15 Гц
    if (!mini && now - b.coordAt >= COORD_EVERY_MS) {
      const fx = Math.round(clamp(b.x, 0, 1) * frameW), fy = Math.round(clamp(b.y, 0, 1) * frameH);
      if (fx !== b.fx || fy !== b.fy || !b.coord) { b.fx = fx; b.fy = fy; b.coord = 'x:' + pad3(fx) + ' y:' + pad3(fy); }
      b.coordAt = now;
    }
    const nChars = mini ? nameStr.length : nameStr.length + 2 + b.coord.length;
    const w = nChars * cwT;
    let x = left;
    let y = top - 3 - lh;
    let below = false;
    if (y < ry + 2) { y = bottom + 3; below = true; }
    x = clamp(x, rx + 2, rx + rw - 2 - w - 4);
    y = clamp(y, ry + 2, ry + rh - 2 - lh);
    // редкий «глитч» ярлыка — сдвиг на 1 px и пересборка цифр
    let gx = 0;
    let glitch = false;
    if (!rm && !mini) {
      if (now >= b.glitchAt) { b.glitchUntil = now + 90; b.glitchAt = now + 2200 + Math.random() * 4200; }
      if (now < b.glitchUntil) { glitch = true; gx = (now & 32) ? 1 : -1; }
    }
    setFont(font);
    plate(x - 2, y - 1, w + 4, lh, 0.9 * a);
    const since = b.acquiredAt;
    text(scrambled(nameStr, since, now, rm), x + 1 + gx, y + (mini ? 0 : 0.5), color, a);
    if (!mini) {
      const coordStr = glitch ? scrambled(b.coord, now - 40, now, false) : scrambled(b.coord, since + 60, now, rm);
      text(coordStr, x + 1 + gx + (nameStr.length + 2) * cwT, y + 0.5, DIM, a);
    }
    // чип состояния
    const st = b.state;
    if (!st.text) return;
    const cf = mini ? F_MINI_CHIP : F_CHIP;
    const ch = mini ? 10 : 14;
    let cy = below ? y + lh + 2 : y - ch - 2;
    if (cy < ry + 2) cy = y + lh + 2;
    const cwid = st.w + (mini ? 5 : 10);
    const cx = clamp(x, rx + 2, rx + rw - 2 - cwid);
    setFont(cf);
    plate(cx - 2, cy, cwid, ch, 0.92 * a);
    ctx.globalAlpha = a;
    ctx.fillStyle = stateColor;
    ctx.fillRect(snapT(cx - 2), snapT(cy), mini ? 1 : 2, ch);
    text(scrambled(st.text, st.since, now, rm), cx + (mini ? 1 : 3), cy + (mini ? 1 : 1.5), stateColor, a);
  }

  function drawChip(label, color, x, y, a, now, rm, mini) {
    if (!label.text || a <= 0.01) return;
    const cf = mini ? F_MINI_CHIP : F_CHIP;
    const ch = mini ? 10 : 14;
    const w = label.w + (mini ? 6 : 12);
    const cx = clamp(x - w / 2, rx + 2, rx + rw - 2 - w);
    const cy = clamp(y, ry + 2, ry + rh - 2 - ch);
    setFont(cf);
    plate(cx, cy, w, ch, 0.92 * a);
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    hline(cx, cx + w, cy, lwDev);
    ctx.stroke();
    text(scrambled(label.text, label.since, now, rm), cx + (mini ? 3 : 6), cy + (mini ? 1 : 1.5), color, a);
  }

  function drawBurst(charge, both, flashK, now, rm, mini) {
    const a = Math.min(lHand.alpha, rHand.alpha);
    if (a <= 0.01) return;
    boxRect(lHand); const lx = BX, ly = BY, lr = Math.max(BW, BH) * 0.72 + 3;
    boxRect(rHand); const rxh = BX, ryh = BY, rr = Math.max(BW, BH) * 0.72 + 3;
    const full = charge >= 1;
    if (both || flashK > 0) {
      // связь двух рук
      const dx = rxh - lx, dy = ryh - ly, d = Math.hypot(dx, dy);
      if (d > lr + rr + 4) {
        const ux = dx / d, uy = dy / d;
        ctx.lineWidth = flashK > 0 && !rm ? lwEm : lw;
        ctx.globalAlpha = a * (flashK > 0 && !rm ? 0.5 + 0.5 * flashK : 0.55);
        ctx.strokeStyle = flashK > 0 || full ? EMBER : GOLD_HI;
        ctx.setLineDash(flashK > 0 ? NO_DASH : DASH_FINE);
        ctx.beginPath();
        ctx.moveTo(lx + ux * lr, ly + uy * lr);
        ctx.lineTo(rxh - ux * rr, ryh - uy * rr);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
      }
      // кольца заряда
      const start = -Math.PI / 2;
      ctx.lineWidth = lw;
      ctx.globalAlpha = 0.25 * a;
      ctx.strokeStyle = STEEL;
      ctx.beginPath();
      ctx.moveTo(lx + lr, ly); ctx.arc(lx, ly, lr, 0, 6.2832);
      ctx.moveTo(rxh + rr, ryh); ctx.arc(rxh, ryh, rr, 0, 6.2832);
      ctx.stroke();
      const c = flashK > 0 ? 1 : charge;
      if (c > 0.001) {
        ctx.lineWidth = lwEm;
        ctx.globalAlpha = a;
        ctx.strokeStyle = full || flashK > 0 ? EMBER : GOLD_HI;
        ctx.beginPath();
        ctx.moveTo(lx + Math.cos(start) * lr, ly + Math.sin(start) * lr);
        ctx.arc(lx, ly, lr, start, start + c * 6.2832);
        ctx.moveTo(rxh + Math.cos(start) * rr, ryh + Math.sin(start) * rr);
        ctx.arc(rxh, ryh, rr, start, start + c * 6.2832);
        ctx.stroke();
      }
    }
    // вспышка выброса: расходящееся кольцо (без reducedMotion)
    if (flashK > 0 && !rm) {
      const e = 1 - flashK;
      const grow = (mini ? 10 : 22) * e;
      ctx.lineWidth = lw;
      ctx.globalAlpha = a * flashK * 0.9;
      ctx.strokeStyle = EMBER;
      ctx.beginPath();
      ctx.moveTo(lx + lr + grow, ly); ctx.arc(lx, ly, lr + grow, 0, 6.2832);
      ctx.moveTo(rxh + rr + grow, ryh); ctx.arc(rxh, ryh, rr + grow, 0, 6.2832);
      ctx.stroke();
    }
    // ярлык по центру над руками
    const mx = (lx + rxh) / 2;
    const my = Math.min(ly - lr, ryh - rr) - (mini ? 12 : 20);
    drawChip(burstLabel, flashK > 0 || full ? EMBER : GOLD_HI, mx, my, a, now, rm, mini);
    if (!mini && both && !full && flashK <= 0) {
      // процент заряда под ярлыком
      const pct = Math.round(charge * 100);
      const s = pct < 10 ? '  ' + pct + '%' : pct < 100 ? ' ' + pct + '%' : pct + '%';
      setFont(F_DATA);
      const cwD = charWidth(F_DATA);
      const w = s.length * cwD;
      text(s, clamp(mx - w / 2, rx + 2, rx + rw - 2 - w), clamp(my + 16, ry + 2, ry + rh - 12), GOLD_HI, 0.85 * a);
    }
  }

  function drawDash(k, now, rm, mini) {
    if (torso.alpha <= 0.01) return;
    const a = torso.alpha;
    boxRect(torso);
    const l = BX - BW / 2, r = BX + BW / 2, t = BY - BH / 2, b = BY + BH / 2;
    if (!rm) {
      // шлейф: призрачные скобки позади и линии скорости
      const len = mini ? 4 : clamp(Math.min(BW, BH) * 0.28, 4, 13);
      ctx.lineWidth = lw;
      ctx.strokeStyle = BLUE;
      for (let i = 1; i <= 3; i++) {
        const off = -dashDir * i * (mini ? 4 : 9) * (0.4 + 0.6 * k);
        ctx.globalAlpha = a * k * (0.42 - i * 0.11);
        ctx.beginPath();
        brackets(l + off, t, r + off, b, len, lwDev);
        ctx.stroke();
      }
      ctx.globalAlpha = a * k * 0.6;
      ctx.beginPath();
      const edge = dashDir > 0 ? l : r;
      const n = mini ? 3 : 5;
      for (let i = 0; i < n; i++) {
        const y = t + (BH * (i + 0.5)) / n;
        const L = (mini ? 8 : 18) + ((i * 37) % 23) * (mini ? 0.4 : 1);
        const x0 = edge - dashDir * (2 + (i % 2) * 4);
        hline(Math.min(x0, x0 - dashDir * L * k), Math.max(x0, x0 - dashDir * L * k), y, lwDev);
      }
      ctx.stroke();
    }
    const cy = t - (mini ? 12 : 18);
    const cx = dashDir > 0 ? r - dashLabel.w / 2 : l + dashLabel.w / 2;
    drawChip(dashLabel, BLUE, cx, cy, a * (rm ? 1 : Math.min(1, k * 2.5)), now, rm, mini);
  }

  function drawCalib(status, now, rm, mini) {
    const p = clamp(num(status.progress, 0), 0, 1);
    const pct = Math.round(p * 100);
    if (pct !== calibPct) { calibPct = pct; calibText = (mini ? 'CAL ' : 'CALIBRATING ') + pct + '%'; }
    let x, y, w;
    if (torso.alpha > 0.05) {
      boxRect(torso);
      x = BX - BW / 2; w = BW; y = BY + BH / 2 + (mini ? 3 : 6);
      // сканирующая линия по торсу
      if (!rm) {
        const ph = (now % 1200) / 1200;
        ctx.globalAlpha = 0.45 * torso.alpha;
        ctx.strokeStyle = BLUE;
        ctx.lineWidth = lw;
        ctx.beginPath();
        hline(BX - BW / 2 + 2, BX + BW / 2 - 2, BY - BH / 2 + BH * ph, lwDev);
        ctx.stroke();
      }
    } else {
      w = rw * 0.5; x = rx + rw * 0.25; y = ry + rh * 0.78;
    }
    const minW = mini ? 40 : 110;
    if (w < minW) { x -= (minW - w) / 2; w = minW; }
    const bh = mini ? 3 : 4;
    const lab = mini ? 9 : 13;
    x = clamp(x, rx + 4, rx + rw - 4 - w);
    y = clamp(y, ry + lab + 2, ry + rh - bh - (mini ? 3 : 16));
    // подпись над полосой
    const font = mini ? F_MINI : F_DATA;
    setFont(font);
    const cwD = charWidth(font);
    plate(x - 2, y - lab - 1, calibText.length * cwD + 5, lab, 0.9);
    text(calibText, x + 0.5, y - lab, BLUE, 1);
    // полоса
    plate(x - 1, y - 1, w + 2, bh + 2, 0.8);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = lw;
    ctx.beginPath();
    const l = snap(x, lwDev), r = snap(x + w, lwDev), t = snap(y, lwDev), b = snap(y + bh, lwDev);
    ctx.rect(l, t, r - l, b - t);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = BLUE;
    ctx.fillRect(l, t, (r - l) * p, b - t);
    if (!mini && typeof status.message === 'string' && status.message) {
      wrapMessage(status.message, F_DATA, rw - 16);
      const ty = y + bh + 4;
      if (ty + 11 <= ry + rh) {
        const mw = measure(F_DATA, msgL1);
        const mx = clamp(x, rx + 4, rx + rw - 4 - mw);
        setFont(F_DATA);
        plate(mx - 2, ty - 1, mw + 4, 12, 0.8);
        text(msgL1, mx, ty, STEEL, 0.8);
      }
    }
  }

  // Перенос сообщения статуса на ≤2 строки (пересчёт только при смене текста/ширины).
  function wrapMessage(msg, font, maxW) {
    if (msg === msgSrc && font === msgFont && maxW === msgMaxW) return;
    msgSrc = msg; msgFont = font; msgMaxW = maxW;
    msgL1 = ''; msgL2 = '';
    const words = msg.split(/\s+/);
    let line = 0;
    for (let i = 0; i < words.length; i++) {
      const wd = words[i];
      if (!wd) continue;
      const cur = line === 0 ? msgL1 : msgL2;
      const next = cur ? cur + ' ' + wd : wd;
      if (measure(font, next) <= maxW || !cur) {
        if (line === 0) msgL1 = next; else msgL2 = next;
      } else if (line === 0) {
        line = 1; msgL2 = wd;
      } else {
        msgL2 = cur + '…';
        break;
      }
    }
    // слишком длинное одно слово — обрезать
    while (msgL1.length > 1 && measure(font, msgL1) > maxW) msgL1 = msgL1.slice(0, -2) + '…';
    while (msgL2.length > 1 && measure(font, msgL2) > maxW) msgL2 = msgL2.slice(0, -2) + '…';
  }

  function drawSearch(st, status, a, now, rm, mini) {
    if (a <= 0.01) return;
    const cx = rx + rw / 2, cy = ry + rh * (mini ? 0.46 : 0.44);
    const R = Math.min(rw, rh) * (mini ? 0.2 : 0.16);
    const lost = st === 'lost' || st === 'error';
    const accent = lost ? EMBER : st === 'loading' || st === 'permission' || st === 'calibrating' ? BLUE : STEEL;
    // квадрат-прицел
    const q = R * 1.45;
    ctx.lineWidth = lw;
    ctx.globalAlpha = 0.55 * a;
    ctx.strokeStyle = STEEL;
    ctx.beginPath();
    brackets(cx - q, cy - q, cx + q, cy + q, mini ? 5 : 10, lwDev);
    ctx.stroke();
    // вращающиеся риски
    const rot = rm ? 0 : now * 0.0006;
    const n = mini ? 24 : 36;
    ctx.globalAlpha = 0.6 * a;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const ang = rot + (i * 6.2832) / n;
      const long = i % 3 === 0;
      const r0 = R - (long ? (mini ? 3 : 5) : (mini ? 1.5 : 2.5));
      const c = Math.cos(ang), s = Math.sin(ang);
      ctx.moveTo(cx + c * r0, cy + s * r0);
      ctx.lineTo(cx + c * R, cy + s * R);
    }
    ctx.stroke();
    // дуга поиска
    const sw = rm ? -Math.PI / 2 : -now * 0.0026;
    ctx.globalAlpha = 0.9 * a;
    ctx.strokeStyle = accent;
    ctx.lineWidth = lwEm;
    ctx.beginPath();
    ctx.arc(cx, cy, R + (mini ? 2 : 4), sw, sw + 0.9);
    ctx.stroke();
    crosshair(cx, cy, R * 0.22, R * 0.38, STEEL, 0.6 * a);
    // заголовок
    let head;
    if (st === 'loading') head = 'LOADING ' + Math.round(clamp(num(status && status.progress, 0), 0, 1) * 100) + '%';
    else if (st === 'permission') head = 'AWAIT CAMERA';
    else if (st === 'error') head = 'NO SIGNAL';
    else if (st === 'idle') head = 'CAMERA OFF';
    else head = 'NO TARGET';
    const hf = mini ? F_MINI_CHIP : F_CHIP;
    setLabel(headingLabel, head, hf, now);
    const blink = rm || lost === false ? 1 : ((now % 1000) < 620 ? 1 : 0.45);
    const hy = cy + q + (mini ? 3 : 6);
    const hw = headingLabel.w;
    setFont(hf);
    plate(cx - hw / 2 - 4, hy - 1, hw + 8, mini ? 10 : 14, 0.9 * a);
    text(scrambled(headingLabel.text, headingLabel.since, now, rm), cx - hw / 2, hy + (mini ? 0.5 : 1.5), accent, a * blink);
    if (mini) return;
    // «поисковые» координаты над прицелом
    if (!rm && now - scanAt >= 100) {
      scanAt = now;
      const sx = (Math.random() * frameW) | 0, sy = (Math.random() * frameH) | 0;
      scanText = 'scan x:' + pad3(sx) + ' y:' + pad3(sy);
    } else if (rm) scanText = 'scan x:--- y:---';
    if (scanText) {
      const cwD = charWidth(F_DATA);
      const w = scanText.length * cwD;
      setFont(F_DATA);
      text(scanText, cx - w / 2, cy - q - 14, DIM, 0.85 * a);
    }
    // сообщение vision
    const msg = status && typeof status.message === 'string' ? status.message : '';
    if (msg) {
      wrapMessage(msg, F_DATA, rw - 24);
      setFont(F_DATA);
      let my = hy + 18;
      const w1 = measure(F_DATA, msgL1);
      if (my + 11 <= ry + rh - 2) {
        plate(cx - w1 / 2 - 3, my - 1, w1 + 6, 12, 0.75 * a);
        text(msgL1, cx - w1 / 2, my, STEEL, 0.82 * a);
      }
      if (msgL2) {
        my += 12;
        const w2 = measure(F_DATA, msgL2);
        if (my + 11 <= ry + rh - 2) {
          plate(cx - w2 / 2 - 3, my - 1, w2 + 6, 12, 0.75 * a);
          text(msgL2, cx - w2 / 2, my, STEEL, 0.82 * a);
        }
      }
    }
  }

  function drawData(st, status, dbg, present, now, rm) {
    if (now - dataAt >= DATA_EVERY_MS || !dConf) {
      dataAt = now;
      const conf = status ? num(status.confidence, NaN) : NaN;
      dConf = 'conf ' + fixed(conf, 2);
      const hz = dbg ? num(dbg.inferenceHz, NaN) : NaN;
      const inf = dbg ? num(dbg.inferMs, NaN) : NaN;
      dHz = 'hz ' + fixed(hz, 1) + '  inf ' + (inf === inf ? inf.toFixed(1) + 'ms' : '--');
      const m = status && typeof status.mode === 'string' ? status.mode : '--';
      const dl = status && typeof status.delegate === 'string' ? status.delegate : '--';
      dMode = 'mode ' + m + '/' + dl;
      const lat = dbg ? num(dbg.latencyMs, NaN) : NaN;
      dFrm = 'frm ' + pad6(poseFrames) + (lat === lat ? '  lat ' + Math.round(lat) : '');
      dRes = frameW + 'x' + frameH + (mirror ? ' MIR' : '');
    }
    let word, wcol;
    if (st === 'calibrating') { word = 'CALIB ' + Math.round(clamp(num(status && status.progress, 0), 0, 1) * 100) + '%'; wcol = BLUE; }
    else if (st === 'loading') { word = 'LOAD ' + Math.round(clamp(num(status && status.progress, 0), 0, 1) * 100) + '%'; wcol = BLUE; }
    else if (st === 'error') { word = 'ERROR'; wcol = EMBER; }
    else if (st === 'idle') { word = 'IDLE'; wcol = DIM; }
    else if (st === 'permission') { word = 'WAIT'; wcol = BLUE; }
    else if (!present) { word = 'LOST'; wcol = EMBER; }
    else { word = 'LIVE'; wcol = GOLD_HI; }
    setLabel(trackWord, word, F_DATA, now);

    const cwD = charWidth(F_DATA);
    const lh = 12;
    const x = rx + 9, y = ry + 9;
    const dotW = measure(F_DATA, '●');
    const l1 = 6 * cwD + dotW + cwD + word.length * cwD;
    let maxW = l1;
    if (dConf.length * cwD > maxW) maxW = dConf.length * cwD;
    if (dHz.length * cwD > maxW) maxW = dHz.length * cwD;
    if (dMode.length * cwD > maxW) maxW = dMode.length * cwD;
    if (dFrm.length * cwD > maxW) maxW = dFrm.length * cwD;
    setFont(F_DATA);
    plate(x - 4, y - 3, maxW + 8, lh * 5 + 5, 0.72);
    // тонкая золотая риска слева — «шапка» колонки
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = GOLD;
    ctx.fillRect(snapT(x - 4), snapT(y - 3), lwDev / dpr, lh * 5 + 5);
    text('TRACK', x, y, STEEL, 0.9);
    const blink = rm || word !== 'LIVE' ? 1 : ((now % 1000) < 560 ? 1 : 0.25);
    text('●', x + 6 * cwD, y, wcol, blink);
    text(scrambled(trackWord.text, trackWord.since, now, rm), x + 6 * cwD + dotW + cwD, y, wcol, 1);
    text(dConf, x, y + lh, DIM, 1);
    text(dHz, x, y + lh * 2, DIM, 1);
    text(dMode, x, y + lh * 3, DIM, 1);
    text(dFrm, x, y + lh * 4, DIM, 1);
    // справа сверху — формат кадра
    const rwid = dRes.length * cwD;
    text(dRes, rx + rw - 9 - rwid, y, DIM, 0.8);
  }

  // ------------------------------------------------------------ кадр
  // ───────── [№1, «Перстни»] слой кистей (21 точка), координаты ПОКАЗА (уже зеркальные) ─────────
  const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  const TIPS = [4, 8, 12, 16, 20];
  // [ПРОЕКТОР] подписи по-русски; «ЩИТ» и «ОГОНЬ» — только когда жест действительно сработал (input.shield / input.attack)
  const SHAPE_TXT = { pinch: '◎ OK', point: '✎ РУНА', fist: '▣ КУЛАК', open: '◇ ЛАДОНЬ', victory: 'V', unknown: '· · ·' };
  const SHAPE_MINI = { pinch: 'OK', point: 'РУНА', fist: 'КУЛАК', open: 'ЛАДОНЬ', victory: 'V', unknown: '' };
  const RUNE_TXT = { ignis: 'ИГНИС ▲', fulgur: 'ФУЛЬГУР ϟ', orbis: 'ОРБИС ○', stella: 'СТЕЛЛА ★', spira: 'СПИРА @', lemnis: 'ЛЕМНИСКА ∞', caret: 'АКУС ^', vee: 'МЕССИС V', clepsydra: 'КЛЕПСИДРА ⧗', alpha: 'АЛЬФА ℓ' };
  const handLabels = { left: makeLabel(), right: makeLabel(), rune: makeLabel() };
  let runeFlashT = -1e9, runeFlashName = '', runeFlashAt = null, lastRuneKey = '';
  let curAttack = false, curShield = false, forcedFull = false;

  function hx(p) { return rx + p.x * rw; }
  function hy(p) { return ry + p.y * rh; }

  // [ПРОЕКТОР] цвет по стороне; форма, «рабочая» для этой руки, рисуется ярче и толще (handActive)
  function handColor(H, side) { return side === 'left' ? LEFT_C : RIGHT_C; }
  function handActive(H, side) {
    if (side === 'right') return H.shape === 'pinch' || H.shape === 'fist' || H.shape === 'point';
    return (H.shape === 'open' && H.palmFacing !== 'away') || H.shape === 'fist';
  }

  function drawHand(H, side, now, rm, mini) {
    const L = H.landmarks;
    if (!Array.isArray(L) || L.length < 21) return;
    for (let i = 0; i < 21; i++) if (!L[i] || !(L[i].x === L[i].x)) return;
    const col = handColor(H, side);
    const act = handActive(H, side);
    // кости
    ctx.strokeStyle = col;
    ctx.globalAlpha = act ? 0.95 : 0.78;
    ctx.lineWidth = act ? lwEm : lw;
    ctx.beginPath();
    for (const [a, b] of HAND_BONES) { ctx.moveTo(hx(L[a]), hy(L[a])); ctx.lineTo(hx(L[b]), hy(L[b])); }
    ctx.stroke();
    // суставы
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.95;
    const r = mini ? 1.1 : 1.6;
    for (let i = 0; i < 21; i++) { ctx.fillRect(snapT(hx(L[i]) - r), snapT(hy(L[i]) - r), r * 2, r * 2); }
    // рамка кисти
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 21; i++) { const X = hx(L[i]), Y = hy(L[i]); if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
    const pad = mini ? 3 : 7;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = col;
    ctx.lineWidth = act ? lwEm : lw;
    ctx.beginPath();
    brackets(x0, y0, x1, y1, Math.max(4, Math.min(12, (x1 - x0) * 0.22)), act ? lwEmDev : lwDev);
    ctx.stroke();
    if (!mini) {
      // кончики пальцев: микро-рамки, у большого и указательного — координаты
      ctx.lineWidth = lw;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      for (const t of TIPS) { const X = hx(L[t]), Y = hy(L[t]); brackets(X - 4, Y - 4, X + 4, Y + 4, 2.5, lwDev); }
      ctx.stroke();
      setFont(F_TAG);
      for (const t of [4, 8]) {
        const X = hx(L[t]), Y = hy(L[t]);
        const txt = `${t === 8 ? 'IDX' : 'THB'} x:${pad3(Math.round(L[t].x * frameW))} y:${pad3(Math.round(L[t].y * frameH))}`;
        const tw = measure(F_TAG, txt);
        const tx = side === 'right' ? X + 7 : X - 7 - tw;
        plate(tx - 2, Y - 13, tw + 4, 12, 0.6);
        text(txt, tx, Y - 12, DIM, 0.95);
      }
    }
    // щипок: кольцо между большим и указательным
    if (H.shape === 'pinch') {
      const mx = (hx(L[4]) + hx(L[8])) / 2, my = (hy(L[4]) + hy(L[8])) / 2;
      ctx.strokeStyle = GOLD_HI; ctx.globalAlpha = 0.95; ctx.lineWidth = lwEm;
      ctx.beginPath(); ctx.arc(mx, my, mini ? 3 : 6 + (rm ? 0 : 1.5 * Math.sin(now * 0.02)), 0, Math.PI * 2); ctx.stroke();
    }
    // заряд кулака: дуга вокруг кисти
    const ch = num(H.charge, 0);
    if (H.shape === 'fist' || ch > 0.02) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.max(x1 - x0, y1 - y0) * 0.62;
      ctx.lineWidth = mini ? lw : lwEm;
      ctx.globalAlpha = 0.35; ctx.strokeStyle = STEEL;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.95; ctx.strokeStyle = ch >= 0.3 ? EMBER : GOLD;
      ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ch); ctx.stroke();
    }
    // метка формы над рамкой
    const lab = handLabels[side];
    let txt = mini ? (SHAPE_MINI[H.shape] || '') : (SHAPE_TXT[H.shape] || '');
    if (!mini && side === 'left' && H.shape === 'open' && H.palmFacing === 'away') txt = '◇ ЛАДОНЬ · ТЫЛ';
    if (side === 'left' && curShield) txt = mini ? 'ЩИТ' : '◆ ЩИТ';
    if (side === 'right' && H.shape === 'pinch' && curAttack) txt = mini ? 'OK→ВЫСТРЕЛ' : '◎ OK · ВЫСТРЕЛ';
    if (H.shape === 'fist' && !mini) txt = `▣ ${Math.round(ch * 100)}%${ch >= 0.3 ? ' · РАСКРОЙ' : ''}`;
    setLabel(lab, txt, mini ? F_MINI_CHIP : F_CHIP, now);
    if (txt) {
      // без «глитча» букв: в доке боя, в панели презентации и у процента заряда кулака (текст меняется каждый кадр)
      const shown = scrambled(lab.text, lab.since, now, rm || mini || forcedFull || H.shape === 'fist');
      const f = mini ? F_MINI_CHIP : F_CHIP;
      setFont(f);
      const tw = measure(f, shown);
      const h = mini ? 10 : 15;
      const tx = clamp(x0, rx + 2, rx + rw - tw - 8);
      const ty = Math.max(ry + 2, y0 - h - 3);
      plate(tx, ty, tw + (mini ? 4 : 8), h, 0.72);
      text(shown, tx + (mini ? 2 : 4), ty + (mini ? 1 : 2), col, 1);
    }
    ctx.globalAlpha = 1;
  }

  function drawRuneTrail(HI, now, rm, mini) {
    const tr = Array.isArray(HI.trail) ? HI.trail : null;
    const lr = isObj(HI.lastRune) ? HI.lastRune : null;
    const key = lr ? `${lr.rune}:${lr.tMs}` : '';
    if (key && key !== lastRuneKey) {
      lastRuneKey = key; runeFlashT = now; runeFlashName = RUNE_TXT[lr.rune] || lr.rune;
      runeFlashAt = tr && tr.length ? tr[Math.floor(tr.length / 2)] : null;
      setLabel(handLabels.rune, runeFlashName, F_CHIP, now);
    }
    if (tr && tr.length > 1) {
      const glow = HI.drawing ? 1 : 0.55;
      for (const [w, a, c] of [[mini ? 3 : 6, 0.18, GOLD], [mini ? 1 : 1.6, 0.95, GOLD_HI]]) {
        ctx.strokeStyle = c; ctx.globalAlpha = a * glow; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(hx(tr[0]), hy(tr[0]));
        for (let i = 1; i < tr.length; i++) ctx.lineTo(hx(tr[i]), hy(tr[i]));
        ctx.stroke();
      }
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      if (HI.drawing && !mini) {
        const e = tr[tr.length - 1];
        crosshair(hx(e), hy(e), 3, 6, GOLD_HI, 0.9);
      }
    }
    // [V3] двуручное рисование: обе половины фигуры
    const tw = isObj(HI.twin) ? HI.twin : null;
    if (tw) {
      for (const [path, c] of [[tw.left, LEFT_C], [tw.right, RIGHT_C]]) {
        if (!Array.isArray(path) || path.length < 2) continue;
        for (const [w, a] of [[mini ? 3 : 6, 0.2], [mini ? 1 : 1.8, 0.95]]) {
          ctx.strokeStyle = c; ctx.globalAlpha = a; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(hx(path[0]), hy(path[0]));
          for (let i = 1; i < path.length; i++) ctx.lineTo(hx(path[i]), hy(path[i]));
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.globalAlpha = 1;
    }
    const k = (now - runeFlashT) / 1200;
    if (k >= 0 && k < 1 && runeFlashName) {
      const p = runeFlashAt || { x: 0.5, y: 0.35 };
      const shown = scrambled(handLabels.rune.text, handLabels.rune.since, now, rm);
      const f = mini ? F_MINI_CHIP : F_CHIP;
      setFont(f);
      const tw = measure(f, shown);
      const X = clamp(hx(p) - tw / 2, rx + 2, rx + rw - tw - 8), Y = clamp(hy(p) - 8, ry + 2, ry + rh - 18);
      ctx.globalAlpha = 1 - k;
      plate(X - 4, Y - 2, tw + 8, mini ? 11 : 16, 0.8 * (1 - k));
      text(shown, X, Y, GOLD_HI, 1 - k);
      ctx.globalAlpha = 1;
    }
  }

  function frameInner(now, frame) {
    const f = isObj(frame) ? frame : EMPTY;
    const pose = isObj(f.pose) ? f.pose : null;
    const status = isObj(f.status) ? f.status : null;
    const input = isObj(f.input) ? f.input : null;
    const settings = isObj(f.settings) ? f.settings : EMPTY;
    const rm = settings.reducedMotion === true;
    const dbg = status && isObj(status.debug) ? status.debug : null;

    if (!(typeof now === 'number' && Number.isFinite(now))) now = lastNow >= 0 ? lastNow + 16.7 : 0;
    let dt = lastNow >= 0 ? (now - lastNow) / 1000 : 0;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.5) dt = 0.5;
    lastNow = now;

    // ---- размер backing store = CSS-бокс × dpr (object-fit на него не влияет)
    const cw = canvas.clientWidth | 0, chh = canvas.clientHeight | 0;
    if (cw < 8 || chh < 8) { if (drawnSomething) wipe(); return; }
    let d = typeof window !== 'undefined' ? num(window.devicePixelRatio, 1) : 1;
    d = clamp(d, 0.5, 2);
    const bw = Math.max(1, Math.round(cw * d)), bh = Math.max(1, Math.round(chh * d));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    // ctx.restore() прошлого кадра вернул font к сохранённому — кеш шрифта недействителен.
    curFont = '';
    // [ПРОЕКТОР] режим от слота камеры (ui.js) важнее режима main.js; масштаб — от ширины канваса
    let forced = null;
    try { const host = canvas.parentNode; forced = host && host.getAttribute ? host.getAttribute('data-hud-mode') : null; } catch (e) { forced = null; }
    // маленькое превью (обучение, узкие окна) — мини-рисунок: колонка данных и координаты там нечитаемы
    const mini = forced === 'full' ? false : forced === 'mini' ? true : f.mode === 'mini' || cw < 240;
    forcedFull = forced === 'full';
    const zoom = clamp(cw / (mini ? MINI_BASE_W : FULL_BASE_W), 1, mini ? 2.6 : 2.4);
    const vw = cw / zoom, vh = chh / zoom;   // логический размер рисунка
    dpr = d * zoom;
    lwDev = Math.max(1, Math.round(dpr)); lw = lwDev / dpr;
    lwEmDev = Math.max(1, Math.round(dpr * 1.5 - 0.01)); lwEm = lwEmDev / dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.setLineDash(NO_DASH);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    drawnSomething = true;

    // ---- кадр видео и «contain»
    if (pose) {
      const pw = num(pose.frameW, 0), ph = num(pose.frameH, 0);
      if (pw > 0 && ph > 0) { frameW = Math.round(pw); frameH = Math.round(ph); }
      mirror = pose.mirror !== false;
    }
    const aspect = frameW / frameH;
    if (vw / vh > aspect) { rh = vh; rw = vh * aspect; rx = (vw - rw) / 2; ry = 0; }
    else { rw = vw; rh = vw / aspect; rx = 0; ry = (vh - rh) / 2; }

    // ---- поза
    const lms = pose && Array.isArray(pose.landmarks) ? pose.landmarks : null;
    const pt = pose ? num(pose.tMs, NaN) : NaN;
    if (lms && pt === pt && pt !== lastPoseT) { lastPoseT = pt; poseFrames++; poseChangedAt = now; }
    else if (lms && !(pt === pt)) poseChangedAt = now;  // без tMs — считаем свежей
    readPoints(lms);
    const st = status && typeof status.status === 'string' ? status.status : (pose ? 'ready' : 'idle');
    const fresh = now - poseChangedAt <= STALE_MS;
    const present = !!lms && fresh && rawOk[S_LS] && rawOk[S_RS] && st !== 'lost' && st !== 'error' && st !== 'idle';
    trackAlpha = approach(trackAlpha, present ? 1 : 0, (dt * 1000) / (present ? FADE_IN_MS : FADE_OUT_MS));
    lostAlpha = approach(lostAlpha, present ? 0 : 1, (dt * 1000) / (present ? 150 : FADE_OUT_MS));

    if (lms) computeTargets(mini);
    else for (let i = 0; i < 4; i++) BOXES[i].valid = false;
    updateNodes(dt, present);
    for (let i = 0; i < 4; i++) updateBox(BOXES[i], dt, now, present, rm);

    // ---- жесты
    const arms = dbg && isObj(dbg.arms) ? dbg.arms : null;
    const aR = arms && isObj(arms.right) ? arms.right : null;
    const aL = arms && isObj(arms.left) ? arms.left : null;
    const gest = dbg && isObj(dbg.gesture) ? dbg.gesture : null;
    const attack = !!(input && input.attack);
    const shield = !!(input && input.shield);
    curAttack = attack; curShield = shield;
    const rUp = present && (attack || !!(aR && aR.raised === true));
    const lUp = present && (shield || !!(aL && aL.raised === true));
    const both = rUp && lUp;
    if (both) { if (bothSince < 0) bothSince = now; } else bothSince = -1;
    let charge = 0;
    if (both) {
      const hold = Math.max(50, num(dbg && dbg.thresholds && dbg.thresholds.burstHoldMs, 380));
      charge = clamp((now - bothSince) / hold, 0, 1);
      const gs = gest && gest.state;
      if (gs === 'burst' || gs === 'burst-latched') charge = 1;
    }
    const dv = input ? num(input.dash, 0) : 0;
    if (dv !== 0) { dashAt = now; dashDir = dv > 0 ? 1 : -1; }
    const dd = input && isObj(input.dashDir) ? input.dashDir : null;
    if (dd && (num(dd.x, 0) || num(dd.z, 0))) {
      dashAt = now; stickDashAt = now; stickDashX = num(dd.x, 0); stickDashZ = num(dd.z, 0);
      dashDir = stickDashX >= 0 ? 1 : -1;
    }
    const stickMode = !(dbg && dbg.torsoMove === true);
    const stick = input && isObj(input.stick) ? input.stick : null;
    if (input && input.burst === true) burstAt = now;
    const dashK = now - dashAt < DASH_MS && now >= dashAt ? 1 - (now - dashAt) / DASH_MS : 0;
    const burstK = now - burstAt < BURST_MS && now >= burstAt ? 1 - (now - burstAt) / BURST_MS : 0;
    const blocked = !!(gest && gest.blocked === true);
    // [№1] кисть, которую видно, заменяет жест «поднятой рукой» (как в vision.read)
    const HI = isObj(f.hands) ? f.hands : null;
    const hR = HI && isObj(HI.right) ? HI.right : null;
    const hL = HI && isObj(HI.left) ? HI.left : null;

    const chipF = mini ? F_MINI_CHIP : F_CHIP;
    const handsOn = !!(hR || hL);
    const rTxt = handsOn || both ? '' : rUp ? (blocked && !attack ? (mini ? 'REARM' : '▲ REARM') : (mini ? 'FIRE' : '▲ FIRE')) : '';
    const lTxt = handsOn || both ? '' : lUp ? (blocked && !shield ? (mini ? 'REARM' : '◆ REARM') : (mini ? 'SHIELD' : '◆ SHIELD')) : '';
    setLabel(rHand.state, rTxt, chipF, now);
    setLabel(lHand.state, lTxt, chipF, now);
    setLabel(burstLabel, burstK > 0 ? 'BURST ✦' : both && !handsOn ? 'BURST' : '', chipF, now);
    setLabel(dashLabel, dashK > 0 ? (dashDir > 0 ? '» DASH' : 'DASH «') : '', chipF, now);
    setLabel(head.state, '', chipF, now);
    setLabel(torso.state, '', chipF, now);

    // ---- рисование (всё внутри прямоугольника видео)
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();

      if (!mini) drawViewfinder(1);
      // колонка данных — под скелетом и рамками: при крупном рисунке она не закрывает поднятую руку
      if (!mini) drawData(st, status, dbg, present, now, rm);
      if (!stickMode) drawNeutral(dbg, input, mini);
      if (stick && stickMode) drawStick(stick, now, rm, mini);
      drawConstellation(rUp, lUp, mini);

      const pulseOn = both && !rm;
      const pulse = pulseOn ? (mini ? 0.8 : 1.6) * (0.5 + 0.5 * Math.sin(now * 0.02)) : 0;
      const calib = st === 'calibrating';
      const rCol = rUp && blocked && !attack && !both ? STEEL : RIGHT_C;
      const lCol = lUp && blocked && !shield && !both ? STEEL : LEFT_C;
      const tCol = calib || dashK > 0 ? BLUE : STEEL;
      drawBox(torso, tCol, calib || dashK > 0, 0, now, rm, mini);
      drawBox(head, STEEL, false, 0, now, rm, mini);
      if (!hL) drawBox(lHand, lCol, lUp, lUp && both ? pulse : 0, now, rm, mini);
      if (!hR) drawBox(rHand, rCol, rUp, rUp && both ? pulse : 0, now, rm, mini);

      // прицелы в центре головы и торса
      if (!mini && head.alpha > 0.05) {
        boxRect(head);
        crosshair(BX, BY + BH * 0.08, 2, Math.max(2, BW * 0.12), STEEL, 0.55 * head.alpha);
      }
      if (!mini && torso.alpha > 0.05) {
        boxRect(torso);
        crosshair(BX, BY, 2, 4, STEEL, 0.5 * torso.alpha);
      }

      if ((both && !handsOn) || burstK > 0) drawBurst(charge, both && !handsOn, burstK, now, rm, mini);
      if (HI) {
        if (hL) drawHand(hL, 'left', now, rm, mini);
        if (hR) drawHand(hR, 'right', now, rm, mini);
        drawRuneTrail(HI, now, rm, mini);
      }
      if (dashK > 0) drawDash(dashK, now, rm, mini);

      drawTag(torso, tCol, BLUE, now, rm, mini);
      drawTag(head, STEEL, STEEL, now, rm, mini);
      if (!hL) drawTag(lHand, lCol, lCol, now, rm, mini);
      if (!hR) drawTag(rHand, rCol, rCol, now, rm, mini);

      if (calib && status) drawCalib(status, now, rm, mini);
      if (lostAlpha > 0.01) drawSearch(st, status, lostAlpha, now, rm, mini);
    } finally {
      ctx.restore();
      ctx.globalAlpha = 1;
      curFont = '';
    }
  }

  function wipe() {
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch (e) { /* ignore */ }
    drawnSomething = false;
  }

  function draw(nowMs, frame) {
    if (disposed) return;
    try {
      frameInner(nowMs, frame);
    } catch (e) {
      if (warnings < 3) { warnings++; try { console.warn('[trackingHud] draw:', e); } catch (e2) { /* ignore */ } }
      try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash(NO_DASH); } catch (e3) { /* ignore */ }
    }
  }

  function clear() {
    if (disposed) return;
    wipe();
    // следующий показ — снова «захват» целей
    for (let i = 0; i < 4; i++) { BOXES[i].alpha = 0; BOXES[i].valid = false; }
    for (let s = 0; s < 7; s++) nodeA[s] = 0;
    trackAlpha = 0; lostAlpha = 1;
    bothSince = -1; dashAt = -1e9; burstAt = -1e9; stickDashAt = -1e9;
    lastNow = -1;
  }

  function dispose() {
    if (disposed) return;
    wipe();
    disposed = true;
    charW.clear();
    textW.clear();
  }

  return { draw, clear, dispose };
}
