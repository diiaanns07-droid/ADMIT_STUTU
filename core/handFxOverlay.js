// ASHEN OATH — [HAND] Эффекты «вау» поверх превью камеры, на РЕАЛЬНЫХ руках игрока. Владелец: №6 [HAND].
// Магия стихий в правой ладони (огонь / молния / лёд / земля, мост двумя руками, бросок), светящийся лук
// в левом кулаке, тетива до щепоти правой, стрела с наконечником, линия прицела, выстрел и «дождь стрел».
//
// API: createHandFxOverlay({ canvas }) → { draw(nowMs, data), clear(), dispose() }
//   canvas — тот же overlay (#ao-overlay), на котором core/trackingHud.js УЖЕ нарисовал кадр: HUD сам очищает
//   и ресайзит backing store; мы только дорисовываем сверху (save/restore, свой transform, 'lighter').
//   draw(nowMs, data), data = {
//     hands: { left: H|null, right: H|null },
//       H = { lm[21] {x,y}, center{x,y}, pinch{x,y}, scale, shape, normal{x,y,z}|null } — координаты ПОКАЗА
//       0..1 (уже зеркальные), scale — размер кисти в высотах кадра (≈ запястье → MCP среднего);
//     bow: { active, phase 'idle'|'ready'|'nocked'|'drawing', draw 0..1, aimX, aimY, charged, element, release, rain },
//     spell: { phase 'idle'|'form'|'hold'|'throw', element, power 0..1, size 0..1, twoHand, dir{x,y} (x вправо, y вверх) },
//     settings: { quality 'low'|'medium'|'high', reducedMotion }, mode 'mini'|'full', pose?: { frameW, frameH } }
//   clear() — сбросить переходные анимации (частицы, вспышки, шлейфы); canvas не трогает (его чистит HUD).
//   dispose() — освободить спрайты; дальше draw() ничего не делает.
// Геометрия — как в trackingHud: прямоугольник видео «contain» (rx, ry, rw, rh) по кадру frameW×frameH (липкий,
// по умолчанию 640×480), точка p → (rx + p.x·rw, ry + p.y·rh), длина в высотах кадра L → L·rh px.
// Правила: без импортов и своего rAF, никогда не бросает. Свечение — спрайты, отрисованные один раз при первом
// кадре (drawImage + 'lighter'), а не градиенты в кадре; частицы — фиксированный пул Float32Array; изломы молний
// — смещения в типизированных массивах (точки считаются от текущих кончиков пальцев). quality 'low' — без частиц
// (только спрайты и линии), 'high' — больше частиц; reducedMotion — без мерцания, дрожания и полёта (статичное
// свечение, вспышки гаснут на месте); mode 'mini' — тоньше линии и вдвое меньше частиц.

const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});
const NO_DASH = [];
const NOOP_FX = Object.freeze({ draw() {}, clear() {}, dispose() {} });

// ---- палитра стихий: 0 — без стихии (золото), 1 огонь, 2 молния, 3 лёд, 4 земля
const COL = ['#f3e2b0', '#ff7a2a', '#8fd0ff', '#9fe8ff', '#d49a4a'];
const CORE = ['#fff6da', '#ffd27a', '#eef8ff', '#e8fbff', '#ffcf7a'];
const ACC = ['#e0a850', '#ff3c12', '#c9a0ff', '#5fb4ff', '#b0561e'];
const RGB_COL = [[243, 226, 176], [255, 122, 42], [143, 208, 255], [159, 232, 255], [212, 154, 74]];
const RGB_CORE = [[255, 246, 218], [255, 210, 122], [238, 248, 255], [232, 251, 255], [255, 207, 122]];
const RGB_ACC = [[224, 168, 80], [255, 60, 18], [201, 160, 255], [95, 180, 255], [176, 86, 30]];

const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];

// ---- частицы: x, y, vx, vy (высоты кадра от угла видео, в секунду), age, life, size, kind, el, seed
const PF = 10, PMAX = 120;
const K_FLAME = 0, K_EMBER = 1, K_SPARKLE = 2, K_DUST = 3, K_SPARK = 4, K_MOTE = 5;

// ---- молнии: до ARC_MAX изломов по ARC_PTS точек; концы: -1 ядро, 0..4 кончики пальцев, 5 левая ладонь,
//      6 точка в воздухе (угол arcAng, длина arcLen·r), -2 дуга по поверхности ядра
const ARC_MAX = 10, ARC_PTS = 17, FORK_PTS = 5;

// ---- лук: MB сэмплов на плечо
const MB = 10;

function isObj(v) { return v !== null && typeof v === 'object'; }
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function okPt(p) { return isObj(p) && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y); }
function elIndex(e) { return e === 'fire' ? 1 : e === 'storm' ? 2 : e === 'frost' ? 3 : e === 'earth' ? 4 : 0; }
function easeOut(t) { return 1 - (1 - t) * (1 - t); }
function easeOutBack(t) { const x = t - 1; return 1 + 2.4 * x * x * x + 1.4 * x * x; }
function rnd() { return Math.random(); }
function makeRng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

// ---------------------------------------------------------------- спрайты (один раз)
function makeCanvas(w, h) {
  try {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  } catch (e) { /* ignore */ }
  return null;
}
function ctx2d(c) { try { return c ? c.getContext('2d') : null; } catch (e) { return null; } }
function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

// stops: [t, rgb, alpha]
function gradSprite(size, stops) {
  const c = makeCanvas(size, size), g = ctx2d(c);
  if (!g) return null;
  const h = size / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
  for (let i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], rgba(stops[i][1], stops[i][2]));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}

const WHITE = [255, 255, 255];
function haloStops(c) { return [[0, c, 0.85], [0.1, c, 0.62], [0.24, c, 0.34], [0.42, c, 0.15], [0.64, c, 0.05], [0.84, c, 0.012], [1, c, 0]]; }
function coreStops(k, c) { return [[0, WHITE, 1], [0.13, k, 0.95], [0.3, c, 0.6], [0.52, c, 0.2], [0.78, c, 0.04], [1, c, 0]]; }
function sparkStops(k, c) { return [[0, WHITE, 1], [0.1, k, 0.9], [0.26, c, 0.38], [0.5, c, 0.09], [1, c, 0]]; }
function ringStops(k, c) { return [[0, c, 0], [0.5, c, 0], [0.68, c, 0.16], [0.8, c, 0.5], [0.85, k, 0.95], [0.9, c, 0.4], [0.96, c, 0.08], [1, c, 0]]; }
function accStops(a) { return [[0, a, 0.6], [0.25, a, 0.3], [0.55, a, 0.08], [0.8, a, 0.015], [1, a, 0]]; }

// Кристалл льда: длинная ось — x, острие справа (+x), основание слева (к сгустку).
function shardSprite(w, h, sharp) {
  const c = makeCanvas(w, h), g = ctx2d(c);
  if (!g) return null;
  const m = h / 2, p = 3;
  g.shadowColor = 'rgba(159,232,255,0.9)'; g.shadowBlur = 4;
  g.beginPath();
  g.moveTo(p, m); g.lineTo(w * 0.2, p + 1); g.lineTo(w * (sharp ? 0.72 : 0.8), p); g.lineTo(w - p, m);
  g.lineTo(w * (sharp ? 0.72 : 0.8), h - p); g.lineTo(w * 0.2, h - p - 1); g.closePath();
  const lg = g.createLinearGradient(0, 0, 0, h);
  lg.addColorStop(0, 'rgba(200,244,255,0.6)'); lg.addColorStop(0.42, 'rgba(90,190,255,0.22)');
  lg.addColorStop(0.58, 'rgba(130,215,255,0.36)'); lg.addColorStop(1, 'rgba(170,232,255,0.55)');
  g.fillStyle = lg; g.fill();
  g.shadowBlur = 3;
  g.strokeStyle = 'rgba(232,251,255,0.95)'; g.lineWidth = 1.2; g.stroke();
  g.shadowBlur = 0;
  g.beginPath(); g.moveTo(p + 2, m); g.lineTo(w - p - 2, m);
  g.moveTo(w * 0.2, p + 2); g.lineTo(w * 0.62, m);
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 0.9; g.stroke();
  return c;
}

// Ледяная печать: шестиугольники, гексаграмма, насечки (рисуется сплюснутой — диск под сгустком).
function sigilSprite(size) {
  const c = makeCanvas(size, size), g = ctx2d(c);
  if (!g) return null;
  const h = size / 2;
  g.translate(h, h);
  g.shadowColor = 'rgba(159,232,255,1)'; g.shadowBlur = 5;
  g.strokeStyle = 'rgba(200,244,255,0.9)';
  g.lineWidth = 1.6;
  g.beginPath(); g.arc(0, 0, h * 0.9, 0, TAU); g.stroke();
  g.lineWidth = 1;
  g.beginPath(); g.arc(0, 0, h * 0.8, 0, TAU); g.stroke();
  const tri = (r, a0) => { g.beginPath(); for (let i = 0; i <= 3; i++) { const a = a0 + i * TAU / 3; if (i) g.lineTo(Math.cos(a) * r, Math.sin(a) * r); else g.moveTo(Math.cos(a) * r, Math.sin(a) * r); } g.stroke(); };
  g.lineWidth = 1.3; tri(h * 0.78, -Math.PI / 2); tri(h * 0.78, Math.PI / 2);
  g.lineWidth = 1;
  g.beginPath(); for (let i = 0; i <= 6; i++) { const a = i * TAU / 6; if (i) g.lineTo(Math.cos(a) * h * 0.42, Math.sin(a) * h * 0.42); else g.moveTo(h * 0.42, 0); } g.stroke();
  for (let i = 0; i < 48; i++) {
    const a = i * TAU / 48, l = i % 4 === 0 ? 0.075 : 0.035;
    g.beginPath(); g.moveTo(Math.cos(a) * h * 0.8, Math.sin(a) * h * 0.8); g.lineTo(Math.cos(a) * h * (0.8 + l), Math.sin(a) * h * (0.8 + l)); g.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6 + Math.PI / 6;
    g.beginPath(); g.arc(Math.cos(a) * h * 0.9, Math.sin(a) * h * 0.9, h * 0.035, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(Math.cos(a) * h * 0.42, Math.sin(a) * h * 0.42); g.lineTo(Math.cos(a) * h * 0.66, Math.sin(a) * h * 0.66); g.stroke();
  }
  return c;
}

// Каменный шар: неровный силуэт, тёмный градиент, мелкая «зернистость», тёплый подсвеченный низ.
function rockSprite(size, seed) {
  const c = makeCanvas(size, size), g = ctx2d(c);
  if (!g) return null;
  const r = makeRng(seed), h = size / 2, R = size * 0.46;
  g.beginPath();
  for (let i = 0; i < 18; i++) { const a = i * TAU / 18, rr = R * (0.92 + 0.08 * r()); if (i) g.lineTo(h + Math.cos(a) * rr, h + Math.sin(a) * rr); else g.moveTo(h + rr, h); }
  g.closePath();
  const gr = g.createRadialGradient(h - R * 0.3, h - R * 0.38, R * 0.05, h, h, R);
  gr.addColorStop(0, '#5a4130'); gr.addColorStop(0.45, '#2e2016'); gr.addColorStop(0.85, '#170f09'); gr.addColorStop(1, '#0e0905');
  g.fillStyle = gr; g.fill();
  g.save(); g.clip();
  for (let i = 0; i < 260; i++) {
    const x = r() * size, y = r() * size, s = 0.6 + r() * 1.6;
    g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.22)' : 'rgba(150,110,70,0.08)'; g.fillRect(x, y, s, s);
  }
  const rim = g.createRadialGradient(h, h + R * 0.25, R * 0.55, h, h, R * 1.02);
  rim.addColorStop(0, 'rgba(255,140,50,0)'); rim.addColorStop(1, 'rgba(255,140,50,0.4)');
  g.fillStyle = rim; g.fillRect(0, 0, size, size);
  g.restore();
  return c;
}

// Светящиеся трещины (для 'lighter' поверх каменного шара): сужаются к концам, ярче в центре.
function cracksSprite(size, seed) {
  const c = makeCanvas(size, size), g = ctx2d(c);
  if (!g) return null;
  const r = makeRng(seed), h = size / 2, R = size * 0.43, s = size / 128;
  g.save(); g.beginPath(); g.arc(h, h, R, 0, TAU); g.clip();
  g.lineCap = 'round'; g.lineJoin = 'round';
  const seg = (x0, y0, x1, y1, w) => {
    g.shadowColor = 'rgba(255,110,24,1)'; g.shadowBlur = 9 * s;
    g.strokeStyle = 'rgba(255,130,40,0.95)'; g.lineWidth = w * 3.4 * s;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.shadowBlur = 0; g.strokeStyle = 'rgba(255,236,180,1)'; g.lineWidth = w * 1.2 * s; g.stroke();
  };
  for (let k = 0; k < 7; k++) {
    let a = k * TAU / 7 + r() * 0.5, x = h + Math.cos(a) * R * 0.08, y = h + Math.sin(a) * R * 0.08, w = 1.7;
    const n = 4 + ((r() * 3) | 0);
    for (let j = 0; j < n; j++) {
      a += (r() - 0.5) * 1.1; const l = R * (0.13 + r() * 0.12);
      const nx = x + Math.cos(a) * l, ny = y + Math.sin(a) * l;
      seg(x, y, nx, ny, w);
      if (r() < 0.45) { const b = a + (r() > 0.5 ? 1 : -1) * (0.7 + r() * 0.5), l2 = l * (0.5 + r() * 0.4); seg(nx, ny, nx + Math.cos(b) * l2, ny + Math.sin(b) * l2, w * 0.55); }
      x = nx; y = ny; w *= 0.72;
    }
  }
  g.restore();
  // к краю шара трещины гаснут
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(h, h, 0, h, h, R);
  m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.6, 'rgba(0,0,0,0.85)'); m.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = m; g.fillRect(0, 0, size, size);
  return c;
}

// Обломок скалы: освещённый край справа (+x) — при отрисовке поворачиваем его к ядру.
function chunkSprite(size, seed) {
  const c = makeCanvas(size, size), g = ctx2d(c);
  if (!g) return null;
  const r = makeRng(seed), h = size / 2, R = size * 0.42, n = 9 + ((r() * 4) | 0);
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = i * TAU / n + (r() - 0.5) * 0.35, rr = R * (0.55 + r() * 0.45);
    const x = h + Math.cos(a) * rr, y = h + Math.sin(a) * rr * 0.8;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.closePath();
  const lg = g.createLinearGradient(h - R, 0, h + R, 0);
  lg.addColorStop(0, '#0d0805'); lg.addColorStop(0.5, '#23170e'); lg.addColorStop(0.82, '#5a3a20'); lg.addColorStop(1, '#a8652a');
  g.fillStyle = lg; g.fill();
  const sg = g.createLinearGradient(h - R, 0, h + R, 0);
  sg.addColorStop(0, 'rgba(255,170,80,0)'); sg.addColorStop(0.62, 'rgba(255,170,80,0)'); sg.addColorStop(1, 'rgba(255,214,140,1)');
  g.strokeStyle = sg; g.lineWidth = Math.max(1, size / 18); g.lineJoin = 'round'; g.stroke();
  return c;
}

// Язык пламени: капля (круглое основание, острый верх), размытая; «центр» основания — на 0.74 высоты.
const FLAME_BASE = 0.74;
function flameSprite(w, h, stops) {
  const c = makeCanvas(w, h), g = ctx2d(c);
  if (!g) return null;
  try { g.filter = 'blur(' + Math.max(1, Math.round(w * 0.055)) + 'px)'; } catch (e) { /* ignore */ }
  const cx = w / 2, by = h * FLAME_BASE, R = w * 0.28;
  g.beginPath();
  g.moveTo(cx, h * 0.07);
  g.bezierCurveTo(cx + R * 0.3, h * 0.3, cx + R * 1.3, h * 0.5, cx + R, by);
  g.arc(cx, by, R, 0, Math.PI, false);
  g.bezierCurveTo(cx - R * 1.3, h * 0.5, cx - R * 0.3, h * 0.3, cx, h * 0.07);
  g.closePath();
  const gr = g.createRadialGradient(cx, by, 0, cx, by - h * 0.12, h * 0.7);
  for (let i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], rgba(stops[i][1], stops[i][2]));
  g.fillStyle = gr; g.fill();
  return c;
}

function buildSprites() {
  const S = { halo: [], core: [], spark: [], acc: [], ring: [], flameHot: null, flameMid: null, flameDark: null, ember: null, rock: null, rim: null, cracks: null, shard: [], chunk: [], sigil: null };
  for (let i = 0; i < 5; i++) {
    S.halo[i] = gradSprite(128, haloStops(RGB_COL[i]));
    S.core[i] = gradSprite(64, coreStops(RGB_CORE[i], RGB_COL[i]));
    S.spark[i] = gradSprite(32, sparkStops(RGB_CORE[i], RGB_COL[i]));
    S.acc[i] = gradSprite(64, accStops(RGB_ACC[i]));
    S.ring[i] = gradSprite(128, ringStops(RGB_CORE[i], RGB_COL[i]));
  }
  S.flameHot = flameSprite(48, 96, [[0, [255, 252, 238], 1], [0.2, [255, 226, 150], 0.95], [0.45, [255, 170, 70], 0.6], [0.75, [255, 120, 40], 0.18], [1, [255, 100, 30], 0]]);
  S.flameMid = flameSprite(48, 96, [[0, [255, 176, 70], 0.95], [0.3, [255, 122, 42], 0.8], [0.6, [236, 76, 24], 0.4], [0.85, [200, 50, 14], 0.1], [1, [180, 40, 10], 0]]);
  S.flameDark = flameSprite(48, 96, [[0, [210, 60, 18], 0.8], [0.4, [160, 36, 10], 0.45], [0.75, [110, 20, 6], 0.12], [1, [80, 12, 4], 0]]);
  S.ember = gradSprite(64, [[0, [255, 236, 190], 0.9], [0.18, [255, 160, 60], 0.6], [0.45, [230, 80, 24], 0.18], [0.75, [180, 40, 10], 0.04], [1, [150, 30, 8], 0]]);
  S.rock = rockSprite(128, 7);
  S.rim = gradSprite(128, [[0, [255, 150, 60], 0], [0.6, [255, 150, 60], 0], [0.7, [255, 160, 70], 0.18], [0.76, [255, 196, 110], 0.55], [0.8, [255, 150, 60], 0.3], [0.9, [230, 110, 40], 0.08], [1, [200, 90, 30], 0]]);
  S.cracks = cracksSprite(128, 19);
  S.shard[0] = shardSprite(96, 26, true);
  S.shard[1] = shardSprite(72, 24, false);
  S.chunk[0] = chunkSprite(48, 3); S.chunk[1] = chunkSprite(48, 11); S.chunk[2] = chunkSprite(48, 29);
  S.sigil = sigilSprite(256);
  if (!S.halo[0] || !S.core[0] || !S.spark[0]) return null;
  return S;
}

function freeSprites(S) {
  if (!S) return;
  const kill = (c) => { try { if (c) { c.width = 0; c.height = 0; } } catch (e) { /* ignore */ } };
  for (const k in S) { const v = S[k]; if (Array.isArray(v)) v.forEach(kill); else kill(v); }
}

function mkEvent() { return { on: false, t0: -1e9, u: 0, v: 0, du: 0, dv: -1, r: 0, fu: 0, fv: 0, el: 0, charged: false, rain: false }; }
function mkHand() { return { ok: false, lm: null, cx: 0, cy: 0, s: 0, px: 0, py: 0, hasPinch: false, fdx: 0, fdy: -1, hasN: false, ny: 0 }; }

/**
 * @param {{canvas: HTMLCanvasElement}} opts
 * @returns {{draw(nowMs:number, data:object):void, clear():void, dispose():void}}
 */
export function createHandFxOverlay(opts) {
  const canvas = isObj(opts) ? opts.canvas : null;
  let ctx = null;
  try { ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null; } catch (e) { ctx = null; }
  if (!ctx) return NOOP_FX;

  let disposed = false, warnings = 0;
  let S = null, spritesFailed = false;

  // ---- геометрия кадра (CSS px)
  let dpr = 1, rx = 0, ry = 0, rw = 0, rh = 0, fw = 640, fh = 480;
  let K = 1;                        // толщина линий
  let mini = false, qual = 1, rm = false, pCap = 0, emitMul = 1;
  let lastNow = -1, dt = 0, T = 0, NOW = 0;

  // ---- частицы
  const P = new Float32Array(PF * PMAX);
  let pN = 0;
  let accFlame = 0, accEmber = 0, accSpk = 0, accHead = 0, accBridge = 0;

  // ---- руки (кадровые снимки без аллокаций)
  const HL = mkHand(), HR = mkHand();

  // ---- сгусток
  const orb = { on: false, a: 0, el: 1, u: 0, v: 0, r: 0, bornAt: -1e9, phase: 'idle', power: 0, two: false, snap: true };

  // ---- молнии
  const arcOff = new Float32Array(ARC_MAX * ARC_PTS);
  const arcFork = new Float32Array(ARC_MAX * FORK_PTS * 2);
  const arcA = new Int8Array(ARC_MAX), arcB = new Int8Array(ARC_MAX), arcHasFork = new Uint8Array(ARC_MAX);
  const arcAng = new Float32Array(ARC_MAX), arcGain = new Float32Array(ARC_MAX), arcLen = new Float32Array(ARC_MAX);
  let arcN = 0, arcNext = 0, arcAt = -1e9, arcTwo = false;
  const headOff = new Float32Array(3 * ARC_PTS), headAng = new Float32Array(3);
  let headNext = 0;

  // ---- лёд и земля: статичные параметры орбит
  const SH_N = 7, CH_N = 7;
  const shAng = new Float32Array(SH_N), shLen = new Float32Array(SH_N), shTilt = new Float32Array(SH_N);
  const chAng = new Float32Array(CH_N), chSize = new Float32Array(CH_N), chSpd = new Float32Array(CH_N), chSpin = new Float32Array(CH_N);
  {
    const r = makeRng(4242);
    for (let i = 0; i < SH_N; i++) { shAng[i] = i * TAU / SH_N + (r() - 0.5) * 0.4; shLen[i] = 0.75 + r() * 0.5; shTilt[i] = (r() - 0.5) * 0.5; }
    for (let i = 0; i < CH_N; i++) { chAng[i] = i * TAU / CH_N + (r() - 0.5) * 0.6; chSize[i] = 0.7 + r() * 0.6; chSpd[i] = 0.55 + r() * 0.5; chSpin[i] = (r() - 0.5) * 2; }
  }

  // ---- лук
  const bowPts = new Float32Array((MB + 1) * 4);    // центр. линия: нижнее плечо (кончик → рукоять), верхнее (рукоять → кончик)
  const bowW = new Float32Array((MB + 1) * 2);
  const bowC = {
    a: 0, seenAt: -1e9, fu: 0, fv: 0, s: 0.1,     // кулак (высоты кадра)
    dx: -1, dy: 0, sdx: -1, sdy: 0, dirAt: -1e9,   // направление стрелы (px, единичное) и сглаженное
    hu: 0, hv: 0, nockAt: -1e9, draw: 0, el: 0, charged: false,
    relAt: -1e9, relDraw: 0,
  };
  const THROWS = [mkEvent(), mkEvent(), mkEvent()];
  const RELS = [mkEvent(), mkEvent(), mkEvent(), mkEvent()];
  // точки для кончиков плеч лука (px)
  let tUx = 0, tUy = 0, tLx = 0, tLy = 0;
  let eX = 0, eY = 0;               // скретч концов молний

  // ================================================================ примитивы рисования
  function spr(img, x, y, size, a) {
    if (!img || !(a > 0.004) || !(size > 0.4)) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    const h = size * 0.5;
    ctx.drawImage(img, x - h, y - h, size, size);
  }
  function sprWH(img, x, y, w, h, a) {
    if (!img || !(a > 0.004) || !(w > 0.4) || !(h > 0.4)) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(img, x - w * 0.5, y - h * 0.5, w, h);
  }
  // спрайт с поворотом (и сплющиванием по оси y экрана — «диск в перспективе»)
  function sprRot(img, x, y, w, h, ang, a, flat) {
    if (!img || !(a > 0.004) || !(w > 0.4)) return;
    const c = Math.cos(ang), s = Math.sin(ang), k = flat > 0 ? flat : 1;
    ctx.setTransform(dpr * c, dpr * s * k, -dpr * s, dpr * c * k, dpr * x, dpr * y);
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(img, -w * 0.5, -h * 0.5, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function stroke(col, w, a) {
    if (!(a > 0.004)) return;
    ctx.strokeStyle = col; ctx.lineWidth = w > 0.35 ? w : 0.35; ctx.globalAlpha = a > 1 ? 1 : a; ctx.stroke();
  }
  function fill(col, a) {
    if (!(a > 0.004)) return;
    ctx.fillStyle = col; ctx.globalAlpha = a > 1 ? 1 : a; ctx.fill();
  }
  // мягкая ударная волна: пик кольца спрайта — на 0.85 радиуса
  function shock(el, x, y, R, a) { spr(S.ring[el], x, y, R * 2.35, a); }
  function line(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  // анаморфный блик — горизонтальная полоса через яркую точку
  function flare(el, x, y, r, a) { if (!mini) sprWH(S.spark[el], x, y, r * 6.5, Math.max(1.2, r * 0.16), a); }
  // звёздный блик: точка + два сужающихся луча (растянутый спрайт, а не линии)
  function glint(el, x, y, s, a) {
    spr(S.spark[el], x, y, s, a);
    const th = Math.max(0.9, s * 0.16);
    sprWH(S.spark[el], x, y, s * 3.4, th, a * 0.85);
    sprWH(S.spark[el], x, y, th, s * 3.4, a * 0.85);
  }
  // мягкое свечение текущего пути: широкий едва заметный ореол → ядро (ступени складываются в 'lighter')
  function glowPath(el, w, a, outerCol) {
    const oc = outerCol || COL[el];
    if (!mini && qual > 0) stroke(oc, w * 9, a * 0.03);
    stroke(oc, w * 4.6, a * 0.065);
    stroke(COL[el], w * 2.3, a * 0.2);
    stroke(CORE[el], w, a * 0.95);
  }
  // ореол вдоль полилинии (спрайты — сглаженный «bloom» без жёстких краёв)
  function bloomAlong(pts, n, step, img, size, a) {
    for (let i = 0; i < n; i += step) spr(img, pts[i * 2], pts[i * 2 + 1], size, a);
  }
  // язык пламени: (x, y) — центр круглого основания капли
  function flameAt(img, x, y, w, h, a) {
    if (!img || !(a > 0.004) || !(w > 0.4)) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(img, x - w * 0.5, y - h * FLAME_BASE, w, h);
  }
  // молния: фиолетовый ореол, голубое свечение, белое ядро
  function arcGlow(w, a) {
    if (!mini && qual > 0) stroke(ACC[2], w * 8, a * 0.045);
    stroke(ACC[2], w * 4.6, a * 0.08);
    stroke(COL[2], w * 2.6, a * 0.17);
    stroke(COL[2], w * 1.5, a * 0.42);
    stroke(CORE[2], w * 0.8, a);
  }

  // ================================================================ частицы
  function emit(kind, el, x, y, vx, vy, life, size) {
    if (pN >= pCap || !(rh > 0)) return;
    const o = pN++ * PF;
    P[o] = (x - rx) / rh; P[o + 1] = (y - ry) / rh; P[o + 2] = vx / rh; P[o + 3] = vy / rh;
    P[o + 4] = 0; P[o + 5] = life; P[o + 6] = size / rh; P[o + 7] = kind; P[o + 8] = el; P[o + 9] = rnd() * TAU;
  }

  function stepParticles() {
    let i = 0;
    const lw = Math.max(0.6, 0.9 * K);
    while (i < pN) {
      const o = i * PF;
      const life = P[o + 5], age = P[o + 4] + dt;
      if (age >= life) {
        pN--;
        if (i < pN) P.copyWithin(o, pN * PF, pN * PF + PF);
        continue;
      }
      P[o + 4] = age;
      const kind = P[o + 7], el = P[o + 8] | 0, seed = P[o + 9], f = age / life;
      if (kind === K_FLAME) { P[o + 3] -= 0.6 * P[o + 6] * dt * 6; P[o + 2] *= 1 - 2.5 * dt; }
      else if (kind === K_EMBER || kind === K_DUST) { P[o + 2] += Math.sin(seed + age * 5) * 0.08 * dt; }
      else if (kind === K_SPARK) { const k = 1 - 4.5 * dt; P[o + 2] *= k; P[o + 3] *= k; P[o + 3] += 0.25 * dt; }
      P[o] += P[o + 2] * dt; P[o + 1] += P[o + 3] * dt;
      const x = rx + P[o] * rh, y = ry + P[o + 1] * rh, s = P[o + 6] * rh;
      if (kind === K_FLAME) {
        const env = (f < 0.12 ? f / 0.12 : 1) * (1 - f) * (1.15 - 0.3 * f);
        const w = s * (0.85 - 0.45 * f), hh = s * (1.6 + 1.2 * f), wx = x + Math.sin(seed + age * 12) * s * 0.1;
        if (f < 0.42) {
          flameAt(S.flameMid, wx, y, w, hh, env * 0.36);
          flameAt(S.flameHot, wx, y, w * 0.6, hh * 0.68, env * 0.5 * (1 - f / 0.42));
        } else {
          const k = (f - 0.42) / 0.58;
          flameAt(S.flameMid, wx, y, w, hh, env * 0.36 * (1 - k));
          flameAt(S.flameDark, wx, y, w * 1.1, hh * 1.1, env * (0.25 + 0.45 * k));
        }
      } else if (kind === K_EMBER) {
        const tw = 0.6 + 0.4 * Math.sin(seed * 3 + age * 23);
        spr(el === 1 ? S.ember : S.spark[el], x, y, s, Math.sin(Math.PI * f) * tw);
      } else if (kind === K_SPARKLE) {
        const tw = Math.sin(Math.PI * f) * (0.55 + 0.45 * Math.sin(seed * 5 + age * 17));
        if (mini) spr(S.spark[el], x, y, s, tw * 0.9);
        else glint(el, x, y, s, tw * 0.8);
      } else if (kind === K_DUST || kind === K_MOTE) {
        spr(S.spark[el], x, y, s, Math.sin(Math.PI * f) * 0.8);
      } else {
        const a = (1 - f) * (1 - f);
        line(x, y, x - P[o + 2] * rh * 0.03, y - P[o + 3] * rh * 0.03);
        stroke(CORE[el], lw, a);
        spr(S.spark[el], x, y, s, a * 0.9);
      }
      i++;
    }
  }

  // ================================================================ руки
  function readHand(h, o) {
    o.ok = false; o.lm = null; o.hasPinch = false; o.hasN = false;
    if (!isObj(h)) return o;
    const lm = Array.isArray(h.lm) && h.lm.length >= 21 ? h.lm : null;
    let x = NaN, y = NaN;
    if (okPt(h.center)) { x = h.center.x; y = h.center.y; }
    else if (lm) {
      let n = 0; x = 0; y = 0;
      for (let i = 0; i < 5; i++) { const q = lm[PALM[i]]; if (okPt(q)) { x += q.x; y += q.y; n++; } }
      if (n) { x /= n; y /= n; } else x = NaN;
    }
    if (!(x === x) || Math.abs(x) > 4 || Math.abs(y) > 4) return o;
    o.cx = rx + x * rw; o.cy = ry + y * rh;
    o.s = clamp(num(h.scale, 0.1), 0.025, 0.4) * rh;
    if (okPt(h.pinch)) { o.px = rx + h.pinch.x * rw; o.py = ry + h.pinch.y * rh; o.hasPinch = true; }
    else if (lm && okPt(lm[4]) && okPt(lm[8])) { o.px = rx + (lm[4].x + lm[8].x) * 0.5 * rw; o.py = ry + (lm[4].y + lm[8].y) * 0.5 * rh; o.hasPinch = true; }
    o.fdx = 0; o.fdy = -1;
    if (lm && okPt(lm[0]) && okPt(lm[9])) {
      const dx = (lm[9].x - lm[0].x) * rw, dy = (lm[9].y - lm[0].y) * rh, l = Math.hypot(dx, dy);
      if (l > 1e-3) { o.fdx = dx / l; o.fdy = dy / l; }
    }
    if (isObj(h.normal) && typeof h.normal.y === 'number' && Number.isFinite(h.normal.y)) { o.hasN = true; o.ny = h.normal.y; }
    o.lm = lm;
    o.ok = true;
    return o;
  }
  function tipOk(H, j) { return H.lm !== null && okPt(H.lm[TIPS[j]]); }
  function tipX(H, j) { return rx + H.lm[TIPS[j]].x * rw; }
  function tipY(H, j) { return ry + H.lm[TIPS[j]].y * rh; }

  // ================================================================ молнии
  // смещение средней точки: крупный излом + мелкая «дрожь» (ARC_PTS = 2^n + 1), концы — 0
  function fractal(arr, o, amp) {
    arr[o] = 0; arr[o + ARC_PTS - 1] = 0;
    for (let step = ARC_PTS - 1; step > 1; step >>= 1) {
      const h = step >> 1;
      for (let j = h; j < ARC_PTS - 1; j += step) arr[o + j] = (arr[o + j - h] + arr[o + j + h]) * 0.5 + (rnd() * 2 - 1) * amp;
      amp *= 0.52;
    }
  }
  function regenArcs(power, two) {
    const base = qual === 0 ? 3 : qual === 2 ? 4 : 3;
    const nTip = clamp(Math.round(base + (mini ? 0 : 2) * power + rnd() * 0.8), 3, 6);
    arcN = 0;
    for (let i = 0; i < nTip && arcN < ARC_MAX; i++) {
      const k = arcN++;
      const j = (rnd() * 5) | 0;
      if (rnd() < 0.28) { arcA[k] = j; arcB[k] = (j + 1 + ((rnd() * 2) | 0)) % 5; }   // между пальцами
      else { arcA[k] = -1; arcB[k] = j; }
      arcGain[k] = 0.55 + rnd() * 0.45;
      arcHasFork[k] = qual > 0 && rnd() < 0.5 ? 1 : 0;
    }
    if (two && arcN < ARC_MAX) { const k = arcN++; arcA[k] = -1; arcB[k] = 5; arcGain[k] = 1; arcHasFork[k] = qual > 0 ? 1 : 0; }
    if (two && arcN < ARC_MAX) { const k = arcN++; arcA[k] = -1; arcB[k] = 5; arcGain[k] = 0.6; arcHasFork[k] = 0; }
    const nAir = qual === 0 || mini ? 1 : 2;
    for (let i = 0; i < nAir && arcN < ARC_MAX; i++) { const k = arcN++; arcA[k] = -1; arcB[k] = 6; arcAng[k] = rnd() * TAU; arcLen[k] = 1.5 + rnd() * 0.9; arcGain[k] = 0.45 + rnd() * 0.4; arcHasFork[k] = qual > 0 && rnd() < 0.6 ? 1 : 0; }
    for (let i = 0; i < 2 && arcN < ARC_MAX; i++) { const k = arcN++; arcA[k] = -2; arcB[k] = -2; arcAng[k] = rnd() * TAU; arcGain[k] = 0.5 + rnd() * 0.4; arcHasFork[k] = 0; }
    for (let k = 0; k < arcN; k++) {
      const o = k * ARC_PTS;
      if (arcA[k] === -2) {
        for (let j = 0; j < ARC_PTS; j++) { const t = j / (ARC_PTS - 1); arcOff[o + j] = 0.3 * Math.sin(Math.PI * t) * (0.7 + rnd() * 0.6); }
      } else {
        fractal(arcOff, o, 0.16 + rnd() * 0.1);
      }
      const fo = k * FORK_PTS * 2, side = rnd() < 0.5 ? -1 : 1;
      let a = side * (0.5 + rnd() * 0.4), px = 0, py = 0;
      for (let j = 0; j < FORK_PTS; j++) {
        a += (rnd() - 0.5) * 1.1; px += Math.cos(a) * 0.075; py += Math.sin(a) * 0.075;
        arcFork[fo + j * 2] = px; arcFork[fo + j * 2 + 1] = py;
      }
    }
    arcAt = NOW; arcTwo = two;
    arcNext = rm ? Infinity : NOW + 60 + rnd() * 30;
  }

  // путь излома от (ax,ay) к (bx,by) по смещениям k-й дуги
  function arcPath(k, ax, ay, bx, by, withFork) {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1) return false;
    const nx = -dy / len, ny = dx / len, o = k * ARC_PTS;
    ctx.beginPath(); ctx.moveTo(ax, ay);
    let fx = 0, fy = 0;
    for (let j = 1; j < ARC_PTS; j++) {
      const t = j / (ARC_PTS - 1), off = arcOff[o + j] * len;
      const x = ax + dx * t + nx * off, y = ay + dy * t + ny * off;
      ctx.lineTo(x, y);
      if (j === 6) { fx = x; fy = y; }
    }
    if (withFork && arcHasFork[k]) {
      const fo = k * FORK_PTS * 2, ux = dx / len, uy = dy / len;
      ctx.moveTo(fx, fy);
      for (let j = 0; j < FORK_PTS; j++) {
        const a = arcFork[fo + j * 2] * len, b = arcFork[fo + j * 2 + 1] * len;
        ctx.lineTo(fx + ux * a + nx * b, fy + uy * a + ny * b);
      }
    }
    return true;
  }

  // ================================================================ сгусток: стихии
  function orbFire(cx, cy, r, A, p) {
    const fl = rm ? 1 : 0.86 + 0.14 * Math.sin(T * 29) * Math.sin(T * 13.7 + 1.3);
    if (qual > 0) spr(S.acc[1], cx, cy - r * 0.3, r * 7.5, A * 0.14 * fl);   // отсвет на кисть и лицо
    spr(S.halo[1], cx, cy - r * 0.4, r * 4.2, A * (0.34 + 0.2 * p) * fl);
    // тело огненного шара: две большие капли — устойчивый силуэт, частицы дают «языки»
    const k1 = rm ? 1 : 1 + 0.07 * Math.sin(T * 17.3) * Math.sin(T * 5.1), k2 = rm ? 1 : 1 + 0.06 * Math.sin(T * 11.1 + 2);
    flameAt(S.flameMid, cx, cy + r * 0.3, r * 2.1 * k2, r * 3.1 * k1, A * 0.3);
    flameAt(S.flameHot, cx, cy + r * 0.25, r * 1.25, r * 1.8 * k2, A * 0.38);
    spr(S.core[1], cx, cy, r * 2.2, A * 0.5);
    spr(S.spark[1], cx, cy + r * 0.05, r * 0.95, A * 0.85);
    flare(1, cx, cy, r, A * 0.16 * fl);
    if (pCap === 0) {
      // без частиц: три «языка» из спрайтов
      for (let j = 0; j < 3; j++) {
        const ph = rm ? 0 : T * (6.3 + j * 1.7) + j * 2.1, k = rm ? 1 : 0.82 + 0.18 * Math.sin(ph);
        const x = cx + (j - 1) * r * 0.5 + (rm ? 0 : Math.sin(ph * 0.7) * r * 0.06);
        flameAt(S.flameMid, x, cy - r * 0.1, r * (j === 1 ? 1.1 : 0.8), r * (j === 1 ? 2.8 : 2.0) * k, A * 0.45);
        flameAt(S.flameHot, x, cy - r * 0.05, r * 0.55, r * 1.3 * k, A * 0.5);
      }
      return;
    }
    accFlame = Math.min(accFlame + dt * (40 + 40 * p) * emitMul, 6);
    while (accFlame >= 1) {
      accFlame -= 1;
      const a = rnd() * TAU, rr = Math.sqrt(rnd()) * r * 0.7;
      emit(K_FLAME, 1, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.6 - r * 0.05,
        (rnd() - 0.5) * r * 0.5 - Math.cos(a) * rr * 0.4, -r * (1.5 + rnd() * 1.4), 0.28 + rnd() * 0.26, r * (0.5 + rnd() * 0.5));
    }
    accEmber = Math.min(accEmber + dt * (6 + 10 * p) * emitMul, 3);
    while (accEmber >= 1) {
      accEmber -= 1;
      emit(K_EMBER, 1, cx + (rnd() - 0.5) * r * 1.2, cy - r * (0.4 + rnd() * 0.6),
        (rnd() - 0.5) * r * 1.1, -r * (1.2 + rnd() * 1.8), 0.7 + rnd() * 0.8, r * (0.16 + rnd() * 0.14) + 2);
    }
  }

  // конец k-й дуги → eX/eY; false — точки нет
  function arcEnd(id, k, cx, cy, r, R, L, ox, oy) {
    if (id >= 0 && id <= 4) {
      if (tipOk(R, id)) { eX = tipX(R, id); eY = tipY(R, id); return true; }
      id = 6;
    }
    if (id === 5) { if (!L.ok) return false; eX = L.cx; eY = L.cy; return true; }
    if (id === 6) { const a = arcAng[k] + (rm ? 0 : T * 0.8), l = r * (arcLen[k] || 1.8); eX = cx + Math.cos(a) * l; eY = cy + Math.sin(a) * l; return true; }
    if (id === -1) {
      const dx = ox - cx, dy = oy - cy, l = Math.hypot(dx, dy) || 1;
      eX = cx + dx / l * r * 0.35; eY = cy + dy / l * r * 0.35; return true;
    }
    return false;
  }

  function orbStorm(cx, cy, r, A, p, R, L) {
    const two = orb.two && L.ok;
    if (NOW >= arcNext || arcN === 0 || two !== arcTwo) regenArcs(p, two);
    const since = NOW - arcAt;
    const fl = rm ? 1 : 0.82 + 0.5 * Math.exp(-since / 40);
    if (qual > 0) spr(S.acc[2], cx, cy, r * 6.5, A * 0.16 * fl);        // фиолетовый отсвет
    spr(S.halo[2], cx, cy, r * 3.4, A * (0.4 + 0.25 * p) * fl);
    spr(S.acc[2], cx, cy, r * 2.4, A * 0.22);
    spr(S.core[2], cx, cy, r * 1.9, A * 0.75);
    spr(S.spark[2], cx, cy, r * 1.0, A * 0.8 * fl);
    flare(2, cx, cy, r, A * 0.26 * fl);
    const w = Math.max(0.6, (mini ? 0.75 : 1.05) * K);
    for (let k = 0; k < arcN; k++) {
      const g = A * arcGain[k] * (rm ? 0.85 : 0.72 + 0.28 * fl);
      if (arcA[k] === -2) {
        const a0 = arcAng[k] + (rm ? 0 : T * 2), a1 = a0 + 1.7;
        const ok = arcPath(k, cx + Math.cos(a0) * r * 0.6, cy + Math.sin(a0) * r * 0.6, cx + Math.cos(a1) * r * 0.6, cy + Math.sin(a1) * r * 0.6, false);
        if (ok) { stroke(ACC[2], w * 3.5, g * 0.12); stroke(COL[2], w * 1.8, g * 0.35); stroke(CORE[2], w * 0.75, g * 0.9); }
        continue;
      }
      if (!arcEnd(arcB[k], k, cx, cy, r, R, L, cx, cy)) continue;
      const bx = eX, by = eY;
      if (!arcEnd(arcA[k], k, cx, cy, r, R, L, bx, by)) continue;
      const ax = eX, ay = eY;
      if (arcPath(k, ax, ay, bx, by, !mini)) {
        arcGlow(w, g);
        spr(S.acc[2], (ax + bx) * 0.5, (ay + by) * 0.5, Math.hypot(bx - ax, by - ay) * 1.1, g * 0.12);
        spr(S.spark[2], bx, by, r * 0.8, g * 0.85);
      }
    }
    if (pCap > 0 && since < 20 && arcN > 0) {
      accSpk += emitMul * (1 + p);
      while (accSpk >= 1) {
        accSpk -= 1;
        const k = (rnd() * arcN) | 0;
        if (arcA[k] === -2 || !arcEnd(arcB[k], k, cx, cy, r, R, L, cx, cy)) continue;
        const a = rnd() * TAU, v = r * (2 + rnd() * 3);
        emit(K_SPARK, 2, eX, eY, Math.cos(a) * v, Math.sin(a) * v, 0.18 + rnd() * 0.15, r * 0.22 + 1);
      }
    }
  }

  function orbFrost(cx, cy, r, A, p) {
    if (qual > 0) spr(S.acc[3], cx, cy + r * 0.2, r * 6.5, A * 0.13);       // холодная дымка
    spr(S.halo[3], cx, cy, r * 3.4, A * (0.36 + 0.2 * p));
    const rot = rm ? 0.3 : T * 0.4;
    sprRot(S.sigil, cx, cy + r * 0.95, r * 3.3, r * 3.3, rot, A * (0.16 + 0.14 * p), 0.34);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < SH_N; i++) {
        const ph = shAng[i] + (rm ? 0 : T * 0.8);
        const dep = Math.sin(ph);
        if ((pass === 0) === (dep >= 0)) continue;        // сначала задние
        const R0 = r * (1.12 + 0.08 * Math.sin(ph * 2 + i));
        const ex = Math.cos(ph) * R0, ey = dep * R0 * 0.4 - r * 0.08;
        const len = r * 0.78 * shLen[i] * (1 + 0.2 * dep), wd = len * 0.3;
        const ang = Math.atan2(ey - r * 0.25, ex) + shTilt[i];
        const x = cx + ex + Math.cos(ang) * len * 0.12, y = cy + ey + Math.sin(ang) * len * 0.12;
        const a = A * (0.42 + 0.45 * (dep + 1) * 0.5);
        spr(S.halo[3], x, y, len * 1.3, a * 0.16);
        sprRot(S.shard[i & 1], x, y, len, wd, ang, a, 0);
        if (dep > 0.5 && !mini) glint(3, x + Math.cos(ang) * len * 0.46, y + Math.sin(ang) * len * 0.46, r * 0.28, a * 0.55);
      }
      if (pass === 0) {
        spr(S.core[3], cx, cy, r * 2.0, A);
        spr(S.spark[3], cx, cy, r * 1.05, A * 0.95);
        // мягкие лучи ледяной звезды (растянутые спрайты)
        if (!mini) {
          const a0 = rm ? 0 : T * 0.6;
          for (let j = 0; j < 3; j++) sprRot(S.spark[3], cx, cy, r * 2.8, Math.max(1, r * 0.13), a0 + j * Math.PI / 3, A * 0.6, 0);
        }
        flare(3, cx, cy, r, A * 0.2);
      }
    }
    if (pCap === 0) return;
    accSpk = Math.min(accSpk + dt * (9 + 12 * p) * emitMul, 3);
    while (accSpk >= 1) {
      accSpk -= 1;
      const a = rnd() * TAU, rr = r * (0.6 + rnd() * 1.5);
      emit(K_SPARKLE, 3, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75, (rnd() - 0.5) * r * 0.3, r * (0.15 + rnd() * 0.35), 0.5 + rnd() * 0.6, r * (0.14 + rnd() * 0.12) + 1.5);
    }
  }

  function chunks(cx, cy, r, A, front) {
    for (let i = 0; i < CH_N; i++) {
      const ph = chAng[i] + (rm ? 0 : T * chSpd[i]);
      const dep = Math.sin(ph);
      if ((dep >= 0) !== front) continue;
      const R0 = r * (1.25 + 0.12 * Math.sin(T * 1.3 + i));
      const x = cx + Math.cos(ph) * R0, y = cy + dep * R0 * 0.36 - r * 0.1 + (rm ? 0 : Math.sin(T * 2.1 + i * 1.7) * r * 0.05);
      const sz = r * 0.48 * chSize[i] * (1 + 0.22 * dep);
      const toC = Math.atan2(cy - y, cx - x);
      const a = A * (0.72 + 0.28 * (dep + 1) * 0.5);
      // подсветка ядром со стороны центра, затем тёмный силуэт с горячим краем
      spr(S.halo[4], x + Math.cos(toC) * sz * 0.3, y + Math.sin(toC) * sz * 0.3, sz * 2.2, a * 0.35);
      ctx.globalCompositeOperation = 'source-over';
      sprRot(S.chunk[i % 3], x, y, sz, sz, toC + (rm ? 0 : chSpin[i] * Math.sin(T * 0.7 + i) * 0.4), a * 0.95, 0);
      ctx.globalCompositeOperation = 'lighter';
    }
  }

  function orbEarth(cx, cy, r, A, p) {
    const pulse = rm ? 1 : 0.8 + 0.2 * Math.sin(T * 3.1);
    if (qual > 0) spr(S.acc[4], cx, cy, r * 7, A * 0.14);                    // тёплый отсвет
    spr(S.halo[4], cx, cy, r * 3.4, A * (0.42 + 0.22 * p));
    chunks(cx, cy, r, A, false);
    spr(S.core[4], cx, cy, r * 2.3, A * 0.85);
    ctx.globalCompositeOperation = 'source-over';
    const rot = rm ? 0 : T * 0.25;
    sprRot(S.rock, cx, cy, r * 1.4, r * 1.4, rot, A * 0.96, 0);
    ctx.globalCompositeOperation = 'lighter';
    sprRot(S.cracks, cx, cy, r * 1.4, r * 1.4, rot, A * (0.7 + 0.3 * p) * pulse, 0);
    spr(S.rim, cx, cy, r * 1.76, A * (0.6 + 0.25 * p) * pulse);               // раскалённый край шара
    spr(S.core[4], cx, cy, r * 0.9, A * 0.28 * pulse);
    spr(S.spark[4], cx, cy, r * 0.45, A * 0.55 * pulse);
    flare(4, cx, cy, r, A * 0.1);
    chunks(cx, cy, r, A, true);
    if (pCap === 0) return;
    accSpk = Math.min(accSpk + dt * (6 + 8 * p) * emitMul, 3);
    while (accSpk >= 1) {
      accSpk -= 1;
      const a = rnd() * TAU, rr = r * (0.9 + rnd() * 0.8);
      emit(K_DUST, 4, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.5, (rnd() - 0.5) * r * 0.4, -r * (0.3 + rnd() * 0.6), 0.8 + rnd() * 0.8, r * (0.12 + rnd() * 0.12) + 1.2);
    }
  }

  // ---- мост между ладонями (twoHand)
  function bridge(cx, cy, r, A, L, el) {
    const lx = L.cx, ly = L.cy, dx = lx - cx, dy = ly - cy, len = Math.hypot(dx, dy);
    if (len < 4) return;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    spr(S.halo[el], lx, ly, r * 2.6, A * 0.45);
    spr(S.core[el], lx, ly, r * 1.1, A * 0.7);
    if (el !== 2) {        // у молнии мост — дуги из orbStorm
      const nb = mini ? 4 : 7;                        // мягкий «луч» — bloom-спрайты вдоль моста
      for (let j = 1; j < nb; j++) spr(S.halo[el], cx + dx * j / nb, cy + dy * j / nb, r * 1.3, A * 0.12);
      const w = Math.max(0.6, 1.0 * K), n = mini ? 10 : 18, amp = r * 0.42;
      for (let s = 0; s < 3; s++) {
        ctx.beginPath();
        for (let j = 0; j <= n; j++) {
          const t = j / n, env = Math.sin(Math.PI * t);
          const o = Math.sin(t * TAU * 1.3 - (rm ? 0 : T * 7) + s * 2.09) * amp * env;
          const x = cx + dx * t + nx * o, y = cy + dy * t + ny * o;
          if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        stroke(COL[el], w * 2.6, A * 0.3);
        stroke(CORE[el], w, A * 0.7);
      }
    }
    if (pCap > 0) {
      accBridge = Math.min(accBridge + dt * 26 * emitMul, 3);
      while (accBridge >= 1) {
        accBridge -= 1;
        const t = rnd(), o = (rnd() - 0.5) * r * 0.5, v = len * (1.2 + rnd());
        emit(K_MOTE, el, cx + dx * t + nx * o, cy + dy * t + ny * o, -ux * v, -uy * v, 0.25 + rnd() * 0.2, r * 0.2 + 1.2);
      }
    }
  }

  // ================================================================ сгусток: жизненный цикл
  function startThrow(sp, R) {
    let ev = THROWS[0];
    for (let i = 0; i < THROWS.length; i++) { if (!THROWS[i].on) { ev = THROWS[i]; break; } if (THROWS[i].t0 < ev.t0) ev = THROWS[i]; }
    const el = orb.on ? orb.el : elIndex(sp.element) || 1;
    let u, v, r;
    if (orb.on && orb.a > 0.05) { u = orb.u; v = orb.v; r = orb.r; }
    else if (R.ok) { u = (R.cx - rx) / rh; v = (R.cy - ry) / rh; r = R.s / rh * 0.7; }
    else return;
    let dx = 0, dy = -1;
    if (isObj(sp.dir)) { const x = num(sp.dir.x, 0), y = -num(sp.dir.y, 0), l = Math.hypot(x, y); if (l > 1e-3) { dx = x / l; dy = y / l; } }
    ev.on = true; ev.t0 = NOW; ev.u = u; ev.v = v; ev.r = Math.max(r, 0.01); ev.du = dx; ev.dv = dy; ev.el = el;
    if (pCap > 0) {
      const X = rx + u * rh, Y = ry + v * rh, rp = ev.r * rh, n = Math.round((mini ? 6 : 14) * (qual === 2 ? 1.4 : 1));
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(dy, dx) + (rnd() - 0.5) * 2.6, s = rp * (4 + rnd() * 7);
        emit(K_SPARK, el, X, Y, Math.cos(a) * s, Math.sin(a) * s, 0.25 + rnd() * 0.25, rp * 0.28 + 1);
      }
    }
  }

  function drawSpell(sp0, L, R) {
    const sp = isObj(sp0) ? sp0 : EMPTY;
    const phase = typeof sp.phase === 'string' ? sp.phase : 'idle';
    const el = elIndex(sp.element) || 1;
    const power = clamp(num(sp.power, 0), 0, 1), size = clamp(num(sp.size, 0), 0, 1);
    const live = phase === 'form' || phase === 'hold';
    if (phase === 'throw' && orb.phase !== 'throw') { startThrow(sp, R); orb.on = false; orb.a = 0; }
    orb.phase = phase;
    if (live && R.ok) {
      if (!orb.on || orb.el !== el) {
        orb.on = true; orb.el = el; orb.bornAt = phase === 'form' ? NOW : NOW - 400; orb.snap = true; orb.a = 0; arcN = 0;
      }
      // якорь: центр ладони, чуть к пальцам; ладонь вверх — сгусток над ладонью
      let tx = R.cx + R.fdx * R.s * 0.2, ty = R.cy + R.fdy * R.s * 0.2;
      if (R.hasN && R.ny < 0) ty -= 0.6 * R.s * clamp(-R.ny / 0.6, 0, 1);
      const tu = (tx - rx) / rh, tv = (ty - ry) / rh, tr = R.s * (0.35 + 0.75 * size) / rh;
      const jump = Math.hypot(tu - orb.u, tv - orb.v);
      if (orb.snap || jump > (R.s / rh) * 3) { orb.u = tu; orb.v = tv; orb.r = tr; orb.snap = false; }
      else {
        const k = rm ? 1 : 1 - Math.exp(-dt / 0.035), kr = 1 - Math.exp(-dt / 0.09);
        orb.u += (tu - orb.u) * k; orb.v += (tv - orb.v) * k; orb.r += (tr - orb.r) * kr;
      }
      orb.a = Math.min(1, orb.a + dt / 0.1);
      orb.power = power; orb.two = sp.twoHand === true;
    } else if (orb.on) {
      orb.a -= dt / 0.18;
      if (orb.a <= 0) { orb.on = false; orb.a = 0; }
    }
    if (!orb.on || orb.a <= 0.01) return;
    const cx = rx + orb.u * rh, cy = ry + orb.v * rh;
    const age = (NOW - orb.bornAt) / 1000;
    const g = rm ? 1 : age < 0.3 ? Math.max(0.04, easeOutBack(age / 0.3)) : 1;
    const r = Math.max(1.5, orb.r * rh * g);
    const A = orb.a * (0.72 + 0.28 * orb.power);
    const e = orb.el;
    if (orb.two && L.ok) bridge(cx, cy, r, A, L, e);
    if (e === 1) orbFire(cx, cy, r, A, orb.power);
    else if (e === 2) orbStorm(cx, cy, r, A, orb.power, R, L);
    else if (e === 3) orbFrost(cx, cy, r, A, orb.power);
    else orbEarth(cx, cy, r, A, orb.power);
    // рождение: вспышка и кольцо
    if (age < 0.4) {
      const t = age / 0.4, k = (1 - t) * (1 - t), R0 = orb.r * rh;
      spr(S.core[e], cx, cy, R0 * (1.5 + (rm ? 1 : 2.5 * t)), k * 0.9);
      shock(e, cx, cy, R0 * (rm ? 1.3 : 0.6 + 1.5 * easeOut(t)), k * 0.75);
    }
  }

  // ================================================================ лук
  function bez(p0, p1, p2, p3, t) { const s = 1 - t; return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3; }

  // строит центральную линию лука и ширины; кулак (fx,fy), «вверх» (ux,uy), вперёд (dx,dy), длина плеча Ll
  function buildBow(fx, fy, ux, uy, dx, dy, Ll, dv, sL) {
    // локальные (u вдоль «вверх», v вдоль стрелы вперёд), в длинах плеча
    const u0 = 0.1, u1 = 0.45, u2 = 0.82, u3 = 0.98 - 0.1 * dv;
    const v0 = 0.02, v1 = 0.12 + 0.03 * dv, v2 = -0.01 - 0.15 * dv, v3 = -0.15 - 0.3 * dv;
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? -1 : 1;
      for (let i = 0; i <= MB; i++) {
        const t = side === 0 ? 1 - i / MB : i / MB;
        const u = bez(u0, u1, u2, u3, t) * sg * Ll, v = bez(v0, v1, v2, v3, t) * Ll;
        const idx = side * (MB + 1) + i;
        bowPts[idx * 2] = fx + ux * u + dx * v;
        bowPts[idx * 2 + 1] = fy + uy * u + dy * v;
        bowW[idx] = sL * (0.05 + 0.13 * Math.pow(1 - t, 0.9));
      }
    }
    tLx = bowPts[0]; tLy = bowPts[1];
    const last = (2 * (MB + 1) - 1) * 2;
    tUx = bowPts[last]; tUy = bowPts[last + 1];
  }
  function bowPolyline() {
    const n = 2 * (MB + 1);
    ctx.beginPath(); ctx.moveTo(bowPts[0], bowPts[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(bowPts[i * 2], bowPts[i * 2 + 1]);
  }
  function bowStrip() {
    const n = 2 * (MB + 1);
    ctx.beginPath();
    for (let pass = 0; pass < 2; pass++) {
      for (let q = 0; q < n; q++) {
        const i = pass === 0 ? q : n - 1 - q, sg = pass === 0 ? 1 : -1;
        const a = i > 0 ? i - 1 : i, b = i < n - 1 ? i + 1 : i;
        let tx = bowPts[b * 2] - bowPts[a * 2], ty = bowPts[b * 2 + 1] - bowPts[a * 2 + 1];
        const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
        const h = bowW[i] * 0.5 * sg, x = bowPts[i * 2] - ty * h, y = bowPts[i * 2 + 1] + tx * h;
        if (q === 0 && pass === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  }
  // «ушки» рекурва на кончиках
  function bowEars(ux, uy, dx, dy, Ll, dv) {
    ctx.beginPath();
    for (let s = 0; s < 2; s++) {
      const sg = s === 0 ? -1 : 1, x = s === 0 ? tLx : tUx, y = s === 0 ? tLy : tUy;
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + ux * sg * Ll * 0.06 + dx * Ll * 0.0, y + uy * sg * Ll * 0.06 + dy * Ll * 0.0,
        x + ux * sg * Ll * (0.08 - 0.02 * dv) + dx * Ll * 0.09, y + uy * sg * Ll * (0.08 - 0.02 * dv) + dy * Ll * 0.09);
    }
  }

  function startRelease(b, L) {
    let ev = RELS[0];
    for (let i = 0; i < RELS.length; i++) { if (!RELS[i].on) { ev = RELS[i]; break; } if (RELS[i].t0 < ev.t0) ev = RELS[i]; }
    const recent = NOW - bowC.nockAt < 600;
    let fu = bowC.fu, fv = bowC.fv;
    if (L.ok) { fu = (L.cx - rx) / rh; fv = (L.cy - ry) / rh; }
    else if (NOW - bowC.seenAt > 600) return;
    ev.on = true; ev.t0 = NOW; ev.fu = fu; ev.fv = fv;
    ev.u = recent ? bowC.hu : fu; ev.v = recent ? bowC.hv : fv;
    ev.du = bowC.sdx; ev.dv = bowC.sdy; ev.r = bowC.s;
    ev.el = elIndex(b.element) || (recent ? bowC.el : 0);
    ev.charged = b.charged === true || (recent && bowC.charged);
    ev.rain = b.rain === true;
    bowC.relAt = NOW; bowC.relDraw = Math.max(recent ? bowC.draw : 0, clamp(num(b.draw, 0), 0, 1));
    if (pCap > 0) {
      const X = rx + ev.u * rh, Y = ry + ev.v * rh, s = ev.r * rh, n = Math.round((mini ? 5 : 11) * (qual === 2 ? 1.4 : 1) * (ev.charged ? 1.5 : 1));
      const base = ev.rain ? -Math.PI / 2 : Math.atan2(ev.dv, ev.du);
      for (let i = 0; i < n; i++) {
        const a = base + (rnd() - 0.5) * 1.6, v = s * (5 + rnd() * 9);
        emit(K_SPARK, ev.el, X, Y, Math.cos(a) * v, Math.sin(a) * v, 0.18 + rnd() * 0.2, s * 0.22 + 1);
      }
    }
  }

  function aimLine(x0, y0, dx, dy, el, a, sL) {
    let t = Infinity;
    if (dx > 1e-4) t = Math.min(t, (rx + rw - x0) / dx); else if (dx < -1e-4) t = Math.min(t, (rx - x0) / dx);
    if (dy > 1e-4) t = Math.min(t, (ry + rh - y0) / dy); else if (dy < -1e-4) t = Math.min(t, (ry - y0) / dy);
    if (!(t > 4) || t === Infinity) return;
    const dash = Math.max(3, sL * (mini ? 0.3 : 0.26)), gap = dash * 0.8, per = dash + gap;
    const off = rm ? 0 : (NOW * 0.001 * per * 2.2) % per;
    const lw = Math.max(0.6, 1.0 * K);
    for (let pass = 0; pass < 2; pass++) {
      let band = -1;
      for (let s = off - per; s < t; s += per) {
        const s0 = s < 0 ? 0 : s, s1 = Math.min(t, s + dash);
        if (s1 <= s0) continue;
        const f = s0 / t, b = Math.min(5, (f * 6) | 0);
        if (b !== band) {
          if (band >= 0) flushAim(pass, el, lw, a, band);
          band = b; ctx.beginPath();
        }
        ctx.moveTo(x0 + dx * s0, y0 + dy * s0); ctx.lineTo(x0 + dx * s1, y0 + dy * s1);
      }
      if (band >= 0) flushAim(pass, el, lw, a, band);
    }
  }
  function flushAim(pass, el, lw, a, band) {
    const k = Math.pow(1 - (band + 0.5) / 6, 1.6) * a;
    if (pass === 0) stroke(COL[el], lw * 3.2, k * 0.2); else stroke(CORE[el], lw, k * 0.75);
  }

  function drawBow(b0, L, R) {
    const b = isObj(b0) ? b0 : EMPTY;
    const phase = typeof b.phase === 'string' ? b.phase : 'idle';
    const drawV = clamp(num(b.draw, 0), 0, 1);
    const nockPhase = phase === 'nocked' || phase === 'drawing';
    if (b.release === true && NOW - bowC.relAt > 120) startRelease(b, L);
    const wobT = (NOW - bowC.relAt) / 1000;
    let target = nockPhase ? 1 : phase === 'ready' || b.active === true ? 0.55 : 0;
    if (wobT < 0.3 && target < 0.55) target = 0.55;
    bowC.a += (target - bowC.a) * Math.min(1, dt / (target > bowC.a ? 0.08 : 0.22));
    if (target === 0 && bowC.a < 0.02) bowC.a = 0;
    if (bowC.a <= 0.01) return;
    // кулак
    let fx, fy, sL;
    if (L.ok) { fx = L.cx; fy = L.cy; sL = L.s; bowC.fu = (fx - rx) / rh; bowC.fv = (fy - ry) / rh; bowC.s = sL / rh; bowC.seenAt = NOW; }
    else if (NOW - bowC.seenAt < 250) { fx = rx + bowC.fu * rh; fy = ry + bowC.fv * rh; sL = bowC.s * rh; }
    else return;
    // направление стрелы: от щепоти к кулаку
    let hasNock = false, nx = 0, ny = 0;
    if (nockPhase && R.ok && R.hasPinch) {
      const vx = fx - R.px, vy = fy - R.py, l = Math.hypot(vx, vy);
      if (l > sL * 0.25) { hasNock = true; nx = R.px; ny = R.py; bowC.dx = vx / l; bowC.dy = vy / l; bowC.dirAt = NOW; }
    }
    if (!hasNock && NOW - bowC.dirAt > 2500) {
      const ay = clamp(num(b.aimY, 0), -1, 1), l = Math.hypot(1, ay * 0.6);
      bowC.dx = -1 / l; bowC.dy = -ay * 0.6 / l;
    }
    {
      const k = hasNock ? 1 : 1 - Math.exp(-dt / 0.08);
      let sx = bowC.sdx + (bowC.dx - bowC.sdx) * k, sy = bowC.sdy + (bowC.dy - bowC.sdy) * k;
      const l = Math.hypot(sx, sy);
      if (l > 1e-3) { sx /= l; sy /= l; } else { sx = bowC.dx; sy = bowC.dy; }
      bowC.sdx = sx; bowC.sdy = sy;
    }
    const dx = bowC.sdx, dy = bowC.sdy;
    let ux = -dy, uy = dx;
    if (uy > 0 || (uy === 0 && ux > 0)) { ux = -ux; uy = -uy; }
    const el = elIndex(b.element);
    const charged = b.charged === true && hasNock;
    const pulse = charged ? (rm ? 1 : 0.5 + 0.5 * Math.sin(T * TAU * 2.4)) : 0;
    const dv = hasNock ? drawV : 0;
    const I = bowC.a * (0.72 + 0.28 * dv) * (1 + 0.35 * pulse);
    const Ll = 2.6 * sL;
    buildBow(fx, fy, ux, uy, dx, dy, Ll, dv, sL);
    // ---- тело лука: bloom-спрайты вдоль плеч, мягкое свечение хребта, узкое «лезвие», яркое ядро
    const lw = Math.max(0.7, (mini ? 0.8 : 1.05) * K);
    const nB = 2 * (MB + 1);
    spr(S.halo[el], fx, fy, sL * (3.2 + 1.6 * pulse), 0.2 * I);
    bloomAlong(bowPts, nB, mini || qual === 0 ? 3 : 2, S.halo[el], sL * 1.6, 0.1 * I);
    bowPolyline(); glowPath(el, lw * 1.35, 0.8 * I);
    bowStrip(); fill(COL[el], 0.3 * I);
    bowEars(ux, uy, dx, dy, Ll, dv); glowPath(el, lw, 0.85 * I);
    glint(el, tUx, tUy, sL * 0.55, 0.5 * I);
    glint(el, tLx, tLy, sL * 0.55, 0.5 * I);
    // ---- тетива
    const sw = Math.max(0.55, (mini ? 0.65 : 0.85) * K);
    if (hasNock) {
      ctx.beginPath(); ctx.moveTo(tUx, tUy); ctx.lineTo(nx, ny); ctx.lineTo(tLx, tLy);
      glowPath(el, sw, (0.55 + 0.4 * dv + 0.15 * pulse) * I);
    } else {
      const mx = (tUx + tLx) * 0.5, my = (tUy + tLy) * 0.5;
      let off = 0;
      if (!rm && wobT < 0.26) off = sL * (0.25 + 1.1 * bowC.relDraw) * Math.exp(-wobT / 0.07) * Math.cos(wobT * TAU * 21);
      ctx.beginPath(); ctx.moveTo(tUx, tUy); ctx.quadraticCurveTo(mx + dx * off * 2, my + dy * off * 2, tLx, tLy);
      glowPath(el, sw, 0.55 * I);
      if (off !== 0) {  // «размытие» дрожащей струны
        ctx.beginPath(); ctx.moveTo(tUx, tUy); ctx.quadraticCurveTo(mx - dx * off * 2, my - dy * off * 2, tLx, tLy);
        stroke(COL[el], sw * 2.5, 0.12 * I); stroke(CORE[el], sw, 0.35 * I);
      }
    }
    if (!hasNock) return;
    // ---- стрела
    const dist = Math.hypot(fx - nx, fy - ny);
    const ext = Math.max(0.75 * sL, 3.6 * sL - dist);
    const hx = fx + dx * ext, hy = fy + dy * ext;       // основание наконечника
    const tipx = hx + dx * sL * 0.62, tipy = hy + dy * sL * 0.62;
    bowC.hu = (tipx - rx) / rh; bowC.hv = (tipy - ry) / rh; bowC.nockAt = NOW;
    bowC.draw = drawV; bowC.el = el; bowC.charged = b.charged === true;
    const aw = Math.max(0.7, (mini ? 0.8 : 1.15) * K);
    line(nx - dx * sL * 0.1, ny - dy * sL * 0.1, hx, hy);
    glowPath(el, aw, (0.85 + 0.15 * pulse) * I);
    // оперение
    const px = ux, py = uy;
    ctx.beginPath();
    for (let s = -1; s <= 1; s += 2) {
      const b0x = nx + dx * sL * 0.08, b0y = ny + dy * sL * 0.08;
      ctx.moveTo(b0x + dx * sL * 0.75, b0y + dy * sL * 0.75);
      ctx.quadraticCurveTo(b0x + dx * sL * 0.3 + px * s * sL * 0.1, b0y + dy * sL * 0.3 + py * s * sL * 0.1,
        b0x - dx * sL * 0.06 + px * s * sL * 0.16, b0y - dy * sL * 0.06 + py * s * sL * 0.16);
      ctx.lineTo(b0x + dx * sL * 0.1, b0y + dy * sL * 0.1);
      ctx.closePath();
    }
    fill(COL[el], 0.2 * I); stroke(COL[el], aw * 2.2, 0.16 * I); stroke(CORE[el], aw * 0.6, 0.5 * I);
    // наконечник
    ctx.beginPath();
    ctx.moveTo(tipx, tipy);
    ctx.lineTo(hx - dx * sL * 0.04 + px * sL * 0.17, hy - dy * sL * 0.04 + py * sL * 0.17);
    ctx.lineTo(hx + dx * sL * 0.1, hy + dy * sL * 0.1);
    ctx.lineTo(hx - dx * sL * 0.04 - px * sL * 0.17, hy - dy * sL * 0.04 - py * sL * 0.17);
    ctx.closePath();
    stroke(COL[el], aw * 5, 0.08 * I); stroke(COL[el], aw * 2.4, 0.3 * I); fill(CORE[el], 0.9 * I);
    const hg = sL * (1.4 + 1.2 * dv + 1.6 * pulse);
    spr(S.halo[el], tipx - dx * sL * 0.25, tipy - dy * sL * 0.25, hg * 1.4, (0.24 + 0.26 * dv + 0.25 * pulse) * I);
    spr(S.core[el], tipx - dx * sL * 0.1, tipy - dy * sL * 0.1, sL * (0.9 + 0.5 * dv), 0.6 * I);
    glint(el, tipx, tipy, sL * (0.55 + 0.5 * pulse), (0.7 + 0.3 * pulse) * I);
    if (charged) flare(el, tipx, tipy, sL * (0.8 + 0.5 * pulse), 0.3 * I);
    headFx(el, tipx, tipy, dx, dy, sL, I, dv, charged);
    // ---- прицел
    aimLine(tipx + dx * sL * 0.35, tipy + dy * sL * 0.35, dx, dy, el, (0.3 + 0.5 * dv + 0.2 * pulse) * bowC.a, sL);
  }

  // стихия на наконечнике
  function headFx(el, x, y, dx, dy, sL, I, dv, charged) {
    if (el === 2) {
      if (NOW >= headNext) {
        for (let k = 0; k < 3; k++) {
          headAng[k] = Math.atan2(dy, dx) + Math.PI + (rnd() - 0.5) * 2.4;
          fractal(headOff, k * ARC_PTS, 0.22);
        }
        headNext = rm ? Infinity : NOW + 55 + rnd() * 35;
      }
      const w = Math.max(0.5, 0.8 * K), nArc = mini ? 1 : 2 + (charged ? 1 : 0);
      for (let k = 0; k < nArc; k++) {
        const l = sL * (0.8 + 0.8 * dv), a = headAng[k], bx = x + Math.cos(a) * l, by = y + Math.sin(a) * l;
        const ddx = bx - x, ddy = by - y, len = Math.hypot(ddx, ddy) || 1, nx = -ddy / len, ny = ddx / len;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let j = 1; j < ARC_PTS; j++) { const t = j / (ARC_PTS - 1), o = headOff[k * ARC_PTS + j] * len; ctx.lineTo(x + ddx * t + nx * o, y + ddy * t + ny * o); }
        arcGlow(w, 0.8 * I);
      }
    }
    if (pCap === 0) return;
    const rate = (el === 0 ? (charged ? 14 : 0) : 16 + 16 * dv) * emitMul;
    accHead = Math.min(accHead + dt * rate, 3);
    while (accHead >= 1) {
      accHead -= 1;
      const bx = x - dx * sL * rnd() * 0.8, by = y - dy * sL * rnd() * 0.8;
      if (el === 1) emit(K_FLAME, 1, bx, by, -dx * sL * 0.8, -sL * 1.6, 0.22 + rnd() * 0.15, sL * (0.4 + rnd() * 0.3));
      else if (el === 3) emit(K_SPARKLE, 3, bx + (rnd() - 0.5) * sL * 0.5, by + (rnd() - 0.5) * sL * 0.5, -dx * sL * 0.5, sL * 0.3, 0.35 + rnd() * 0.3, sL * 0.28 + 1);
      else if (el === 4) emit(K_DUST, 4, bx, by, -dx * sL * 0.9 + (rnd() - 0.5) * sL, -sL * 0.3, 0.45 + rnd() * 0.3, sL * 0.2 + 1);
      else if (el === 2) emit(K_SPARK, 2, x, y, (rnd() - 0.5) * sL * 8, (rnd() - 0.5) * sL * 8, 0.12 + rnd() * 0.1, sL * 0.16 + 1);
      else emit(K_MOTE, 0, bx + (rnd() - 0.5) * sL * 0.4, by + (rnd() - 0.5) * sL * 0.4, -dx * sL * 1.2, -dy * sL * 1.2, 0.3 + rnd() * 0.2, sL * 0.22 + 1);
    }
  }

  // ================================================================ переходные: выстрел и бросок
  function streak(hx, hy, dx, dy, len, w, el, a) {
    if (!(len > 1) || !(a > 0.01)) return;
    line(hx - dx * len, hy - dy * len, hx, hy);
    stroke(COL[el], w * 5, a * 0.14);
    stroke(COL[el], w * 2.2, a * 0.38);
    stroke(CORE[el], w, a * 0.7);
    line(hx - dx * len * 0.4, hy - dy * len * 0.4, hx, hy);
    stroke(CORE[el], w * 1.3, a);
  }

  function drawEvents() {
    const lw = Math.max(0.7, (mini ? 0.9 : 1.2) * K);
    for (let i = 0; i < RELS.length; i++) {
      const ev = RELS[i];
      if (!ev.on) continue;
      const t = (NOW - ev.t0) / 1000, dur = ev.charged ? 0.24 : 0.18;
      if (t > 0.34 || t < 0) { ev.on = false; continue; }
      const s = ev.r * rh, el = ev.el, fx = rx + ev.fu * rh, fy = ry + ev.fv * rh;
      const big = ev.charged ? 1.45 : 1;
      // вспышка у кулака
      const tf = t / 0.24;
      if (tf < 1) {
        const k = (1 - tf) * (1 - tf);
        spr(S.halo[el], fx, fy, s * (3 + 3 * tf) * big, k * 0.55);
        spr(S.core[el], fx, fy, s * (1.6 + (rm ? 0.5 : 2) * tf) * big, k * 0.95);
        shock(el, fx, fy, s * (rm ? 1.1 : 0.5 + 1.5 * easeOut(tf)) * big, k * 0.7);
        if (ev.charged) flare(el, fx, fy, s * 1.3, k * 0.5);
      }
      const te = t / dur;
      if (te >= 1) continue;
      const k = 1 - te;
      const n = ev.rain ? (mini ? 3 : 6) : 1;
      for (let j = 0; j < n; j++) {
        let ddx = ev.du, ddy = ev.dv, ox = rx + ev.u * rh, oy = ry + ev.v * rh, g = 1, tj = te;
        if (ev.rain) {
          const ang = -Math.PI / 2 + (j === 0 ? 0 : ((j & 1) ? 1 : -1) * Math.ceil(j / 2) * 0.16);
          ddx = Math.cos(ang); ddy = Math.sin(ang); ox = fx + (j === 0 ? 0 : ((j & 1) ? 1 : -1) * Math.ceil(j / 2) * s * 0.12); oy = fy;
          g = j === 0 ? 1 : 0.45; tj = Math.max(0, te - j * 0.08);
        }
        if (rm) { streak(ox + ddx * s * 3, oy + ddy * s * 3, ddx, ddy, s * 3, lw, el, k * g * 0.8); continue; }
        const D = rh * (ev.rain ? 1.1 : 1.5) * easeOut(tj);
        const hx = ox + ddx * D, hy = oy + ddy * D;
        const len = Math.min(D, s * 6 * big) * (1 - 0.35 * tj);
        streak(hx, hy, ddx, ddy, len, lw * big, el, (1 - tj * 0.6) * g);
        spr(S.spark[el], hx, hy, s * 1.3 * big, (1 - tj * 0.5) * g);
        if (j === 0) spr(S.halo[el], hx, hy, s * 2.4 * big, 0.35 * k);
      }
    }
    for (let i = 0; i < THROWS.length; i++) {
      const ev = THROWS[i];
      if (!ev.on) continue;
      const t = (NOW - ev.t0) / 1000;
      if (t > 0.36 || t < 0) { ev.on = false; continue; }
      const el = ev.el, r = ev.r * rh, ox = rx + ev.u * rh, oy = ry + ev.v * rh;
      const tb = t / 0.32;
      if (tb < 1) {
        const k = (1 - tb) * (1 - tb);
        spr(S.halo[el], ox, oy, r * (3.5 + 4 * tb), k * 0.7);
        spr(S.core[el], ox, oy, r * (1.8 + (rm ? 0.6 : 2.4) * tb), k);
        shock(el, ox, oy, r * (rm ? 1.5 : 0.9 + 1.9 * easeOut(tb)), k * 0.8);
      }
      const te = t / 0.22;
      if (te >= 1) continue;
      if (rm) { streak(ox + ev.du * r * 3.5, oy + ev.dv * r * 3.5, ev.du, ev.dv, r * 3, Math.max(0.8, 1.4 * K), el, (1 - te) * 0.8); continue; }
      const D = rh * 1.25 * easeOut(te), hx = ox + ev.du * D, hy = oy + ev.dv * D, hr = r * (1 - 0.35 * te), a = 1 - te * 0.5;
      const len = Math.min(D, r * 7);
      // хвост кометы — растянутые вдоль полёта спрайты (мягко сужаются к концу), голова поверх
      const ang = Math.atan2(ev.dv, ev.du);
      sprRot(S.halo[el], hx - ev.du * len * 0.45, hy - ev.dv * len * 0.45, len * 1.15, hr * 2.6, ang, 0.4 * a, 0);
      sprRot(S.core[el], hx - ev.du * len * 0.32, hy - ev.dv * len * 0.32, len * 0.8, hr * 1.1, ang, 0.75 * a, 0);
      sprRot(S.spark[el], hx - ev.du * len * 0.18, hy - ev.dv * len * 0.18, len * 0.5, Math.max(1.5, hr * 0.45), ang, a, 0);
      spr(S.halo[el], hx, hy, hr * 3.4, 0.7 * a);
      spr(S.core[el], hx, hy, hr * 1.8, a);
      if (el === 2) {   // молния тянется за сгустком
        if (NOW >= headNext) { for (let k = 0; k < 3; k++) fractal(headOff, k * ARC_PTS, 0.14); headNext = NOW + 50; }
        const bx = hx - ev.du * len, by = hy - ev.dv * len, ddx = hx - bx, ddy = hy - by, nx = -ev.dv, ny = ev.du;
        ctx.beginPath(); ctx.moveTo(bx, by);
        for (let j = 1; j < ARC_PTS; j++) { const t = j / (ARC_PTS - 1), o = headOff[j] * len; ctx.lineTo(bx + ddx * t + nx * o, by + ddy * t + ny * o); }
        arcGlow(Math.max(0.6, 1.0 * K), 0.9 * a);
      }
      glint(el, hx, hy, hr * 0.9, 0.6 * a);
      if (pCap > 0 && (el === 1 || el === 3 || el === 4)) {
        const kind = el === 1 ? K_FLAME : el === 3 ? K_SPARKLE : K_DUST;
        emit(kind, el, hx - ev.du * hr, hy - ev.dv * hr, -ev.du * hr * 2, -ev.dv * hr * 2 - (el === 1 ? hr * 2 : 0), 0.2 + rnd() * 0.15, hr * (el === 1 ? 1 : 0.35));
      }
    }
  }

  // ================================================================ кадр
  function frame(nowMs, data) {
    const cw = canvas.clientWidth | 0, ch = canvas.clientHeight | 0;
    if (cw < 8 || ch < 8) return;
    if (!S) {
      if (spritesFailed) return;
      try { S = buildSprites(); } catch (e) { S = null; }
      if (!S) { spritesFailed = true; return; }
    }
    const now = num(nowMs, lastNow >= 0 ? lastNow + 16 : 0);
    dt = lastNow >= 0 ? (now - lastNow) / 1000 : 0;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    lastNow = now; NOW = now; T = now / 1000;
    const D = isObj(data) ? data : EMPTY;
    const st = isObj(D.settings) ? D.settings : EMPTY;
    qual = st.quality === 'low' ? 0 : st.quality === 'high' ? 2 : 1;
    rm = st.reducedMotion === true;
    mini = D.mode === 'mini';
    pCap = rm || qual === 0 ? 0 : (qual === 2 ? PMAX : 64) >> (mini ? 1 : 0);
    emitMul = (qual === 2 ? 1.45 : 1) * (mini ? 0.45 : 1);
    if (pN > pCap) pN = pCap;
    let d = typeof window !== 'undefined' ? num(window.devicePixelRatio, 1) : 1;
    d = clamp(d, 0.5, 2); dpr = d;
    const pose = isObj(D.pose) ? D.pose : null;
    if (pose) { const pw = num(pose.frameW, 0), ph = num(pose.frameH, 0); if (pw > 0 && ph > 0) { fw = pw; fh = ph; } }
    const aspect = fw / fh;
    if (cw / ch > aspect) { rh = ch; rw = ch * aspect; rx = (cw - rw) / 2; ry = 0; }
    else { rw = cw; rh = cw / aspect; rx = 0; ry = (ch - rh) / 2; }
    K = clamp(rh / 420, 0.45, 1.8);
    const hands = isObj(D.hands) ? D.hands : EMPTY;
    readHand(hands.left, HL); readHand(hands.right, HR);
    ctx.save();
    try {
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.setLineDash(NO_DASH);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowBlur = 0;
      drawBow(D.bow, HL, HR);
      drawSpell(D.spell, HL, HR);
      drawEvents();
      if (pN > 0) stepParticles();
    } finally {
      ctx.restore();
    }
  }

  function draw(nowMs, data) {
    if (disposed) return;
    try { frame(nowMs, data); }
    catch (e) {
      if (warnings < 3) { warnings++; try { console.warn('[handFxOverlay] draw:', e); } catch (e2) { /* ignore */ } }
    }
  }

  function clear() {
    if (disposed) return;
    pN = 0; accFlame = accEmber = accSpk = accHead = accBridge = 0;
    orb.on = false; orb.a = 0; orb.phase = 'idle'; orb.snap = true;
    bowC.a = 0; bowC.relAt = -1e9; bowC.nockAt = -1e9; bowC.dirAt = -1e9; bowC.seenAt = -1e9;
    for (let i = 0; i < THROWS.length; i++) THROWS[i].on = false;
    for (let i = 0; i < RELS.length; i++) RELS[i].on = false;
    arcN = 0; arcNext = 0; headNext = 0;
    lastNow = -1;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    freeSprites(S); S = null;
    pN = 0;
  }

  return { draw, clear, dispose };
}
