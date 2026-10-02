// ASHEN OATH — [W3-CHALLENGE] постер победы 1200×630 (размер превью соцсетей): арт героя (кадр боя в момент
// последнего удара), ранг, очки, лучший жест, точность, силуэт-скелет игрока в момент последнего удара и
// QR-код на игру. Рисуется на обычном 2D-canvas; кнопка «Сохранить картинку» сохраняет PNG.
//
// Приватность: на постер попадают только линии скелета (координаты точек позы и кистей), видео камеры —
// никогда. Кадр боя берётся с игрового WebGL-канваса, на котором видео нет.
//
// API:
//   POSTER_W, POSTER_H, GAME_URL
//   qrMatrix(text, ecl = 'M', forceMask?) → boolean[][] (true — тёмный модуль), без внешних библиотек и сервисов
//   drawPoster(ctx, data) — рисует постер; ошибки отдельных частей не роняют рисунок целиком
//   createPosterCanvas(doc, data) → canvas 1200×630
//   posterBlob(canvas) → Promise<Blob PNG>;  downloadPoster(doc, blob, fileName)
//   posterFileName(data) → 'ashen-oath-…png'
// data = { kind: 'challenge'|'fight', outcome, score, rank, rankTitle, name, place, total, isRecord, bestGesture{title,good},
//          accuracy, damage, maxCombo, elapsed, heroName, heroCls, art (CanvasImageSource|null),
//          skeleton { pose: [{x,y}|null]×33 (координаты показа 0…1, уже зеркальные), hands: [[{x,y}]×21…], aspect } | null,
//          date (Date|ms), url }

export const POSTER_W = 1200;
export const POSTER_H = 630;
export const GAME_URL = 'https://diiaanns07-droid.github.io/ADMIT_STUTU/';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ───────── QR-код (ISO/IEC 18004: байтовый режим, версии 1–10, маска с наименьшим штрафом) ─────────
const ECL = { L: { bits: 1, i: 0 }, M: { bits: 0, i: 1 }, Q: { bits: 3, i: 2 }, H: { bits: 2, i: 3 } };
// [уровень][версия]: кодовых слов коррекции на блок и число блоков (версии 1–10)
const ECC_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const ECC_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];
const MAX_VER = 10;

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const dataCodewords = (ver, e) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * ECC_BLOCKS[e][ver];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}
function utf8(text) {
  if (typeof TextEncoder === 'function') return Array.from(new TextEncoder().encode(String(text)));
  return Array.from(unescape(encodeURIComponent(String(text))), (c) => c.charCodeAt(0));
}

export function qrMatrix(text, ecl = 'M', forceMask = -1) {
  const E = ECL[ecl] || ECL.M;
  const bytes = utf8(text);
  let ver = 0;
  for (let v = 1; v <= MAX_VER; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(v, E.i) * 8) { ver = v; break; }
  }
  if (!ver) throw new RangeError('qrMatrix: текст слишком длинный');
  // поток битов: режим «байты», длина, данные, терминатор, добивка до байта и 0xEC/0x11
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4); push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const cap = dataCodewords(ver, E.i) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
  // блоки, коррекция Рида — Соломона, чередование
  const nBlocks = ECC_BLOCKS[E.i][ver], eccLen = ECC_PER_BLOCK[E.i][ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nBlocks - (raw % nBlocks), shortLen = Math.floor(raw / nBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const words = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) words.push(b[i]); });

  const size = ver * 4 + 17;
  const M = Array.from({ length: size }, () => new Array(size).fill(false));
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { M[y][x] = dark; F[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const formatBits = (mask) => {
    const d = (E.bits << 3) | mask;
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const bit = (i) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  formatBits(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, dark); set(c, a, dark);
    }
  }
  // данные змейкой снизу вверх, парами столбцов
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!F[y][x] && bi < words.length * 8) { M[y][x] = ((words[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
    }
  }
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!F[y][x] && MASKS[m](x, y)) M[y][x] = !M[y][x]; };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    if (forceMask >= 0 && forceMask <= 7 && m !== forceMask) continue;
    applyMask(m); formatBits(m);
    const s = penalty(M, size);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best); formatBits(best);
  return M;
}

function penalty(M, size) {
  let score = 0;
  const addHist = (len, h) => { if (h[0] === 0) len += size; h.pop(); h.unshift(len); };
  const count = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const term = (color, len, h) => { if (color) { addHist(len, h); len = 0; } len += size; addHist(len, h); return count(h); };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let color = false, run = 0;
      const h = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const c = pass === 0 ? M[a][b] : M[b][a];
        if (c === color) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else { addHist(run, h); if (!color) score += count(h) * 40; color = c; run = 1; }
      }
      score += term(color, run, h) * 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (M[y][x]) dark++;
    if (y < size - 1 && x < size - 1) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) score += 3; }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// ───────── постер ─────────
const GOLD = '#c4a265', GOLD_HI = '#e3c792', PARCH = '#eadfc5', INK = '#0d0e11', MUTED = '#b9b1a1';
const LEFT = '#5aaeff', RIGHT = '#ff9a3c';
const SERIF = '"Cormorant Garamond", "Cormorant", "Palatino Linotype", Georgia, serif';
const NUM = 'Cinzel, Forum, "Palatino Linotype", Georgia, serif';      // цифры и латиница (у Cormorant цифры «старого стиля»)
const CAPS = 'Forum, Cinzel, "Cormorant Garamond", Georgia, serif';    // кириллические капители
const SANS = '"Segoe UI", system-ui, "Noto Sans", "Liberation Sans", Arial, sans-serif';
const RANK_COLOR = { S: '#ffd36b', A: '#e6e2d6', B: '#d49a5c', C: '#9fb8c9', D: '#a29d92' };
const OUTCOME = { timeup: 'ВРЕМЯ ВЫШЛО', victory: 'РЕГЕНТ ПОВЕРЖЕН', defeat: 'ГЕРОЙ ПАЛ' };
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// связи точек позы MediaPipe (33 точки) и кисти (21 точка)
const POSE_LINKS = [
  [11, 12], [11, 23], [12, 24], [23, 24],                 // корпус
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19], // рука (точка 11 — левое плечо в кадре)
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [23, 25], [25, 27], [24, 26], [26, 28],                 // ноги, если видны
];
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

// Псевдослучайность для пепла: один и тот же постер рисуется одинаково
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const fmt = (n) => String(Math.max(0, Math.round(fin(n) ? n : 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
function dateText(d) {
  const t = d instanceof Date ? d : new Date(fin(d) ? d : Date.now());
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}`;
}

function safe(fn) { try { fn(); } catch (e) { if (typeof console !== 'undefined') console.warn('[poster]', e && e.message); } }

function frame(ctx, W, H) {
  ctx.strokeStyle = 'rgba(196,162,101,0.85)'; ctx.lineWidth = 1.5;
  ctx.strokeRect(14.5, 14.5, W - 29, H - 29);
  ctx.strokeStyle = 'rgba(87,74,51,0.6)'; ctx.lineWidth = 1;
  ctx.strokeRect(22.5, 22.5, W - 45, H - 45);
  ctx.fillStyle = GOLD_HI;
  for (const [x, y] of [[14, 14], [W - 14, 14], [14, H - 14], [W - 14, H - 14]]) { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-5, -5, 10, 10); ctx.restore(); }
}

// Арт: кадр боя (cover), затем затемнение к правой панели; без кадра — затмение и пепел, как небо арены
function drawArt(ctx, art, AW, H, seed) {
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, AW, H); ctx.clip();
  const ok = art && fin(art.width) && fin(art.height) && art.width > 0 && art.height > 0;
  if (ok) {
    const k = Math.max(AW / art.width, H / art.height);
    const w = art.width * k, h = art.height * k;
    ctx.drawImage(art, (AW - w) / 2, (H - h) / 2, w, h);
    ctx.fillStyle = 'rgba(8,8,12,0.22)'; ctx.fillRect(0, 0, AW, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a2f3d'); g.addColorStop(0.55, '#15161c'); g.addColorStop(1, '#0b0b0e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, AW, H);
    const sx = AW * 0.58, sy = H * 0.3;
    const corona = ctx.createRadialGradient(sx, sy, 40, sx, sy, 260);
    corona.addColorStop(0, 'rgba(255,248,230,0.95)'); corona.addColorStop(0.25, 'rgba(225,215,190,0.45)'); corona.addColorStop(1, 'rgba(120,130,160,0)');
    ctx.fillStyle = corona; ctx.fillRect(0, 0, AW, H);
    ctx.fillStyle = '#050506'; ctx.beginPath(); ctx.arc(sx, sy, 62, 0, Math.PI * 2); ctx.fill();
    // силуэты шпилей у горизонта
    ctx.fillStyle = '#0a0a0d';
    const R = rng(seed ^ 0x51);
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= AW; x += 24) { const tall = R() < 0.18; ctx.lineTo(x, H * (tall ? 0.42 + R() * 0.12 : 0.66 + R() * 0.08)); }
    ctx.lineTo(AW, H); ctx.closePath(); ctx.fill();
  }
  // пепел и угли
  const R = rng(seed);
  for (let i = 0; i < 70; i++) {
    const x = R() * AW, y = R() * H, r = 0.6 + R() * 2.2, ember = R() < 0.35;
    ctx.globalAlpha = 0.25 + R() * 0.55;
    ctx.fillStyle = ember ? '#ff8a3c' : '#d9d2c4';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // переход в правую панель и виньетка
  const fade = ctx.createLinearGradient(AW - 260, 0, AW, 0);
  fade.addColorStop(0, 'rgba(12,13,16,0)'); fade.addColorStop(1, 'rgba(12,13,16,1)');
  ctx.fillStyle = fade; ctx.fillRect(AW - 260, 0, 260, H);
  const vg = ctx.createRadialGradient(AW * 0.45, H * 0.5, H * 0.35, AW * 0.45, H * 0.5, H * 0.95);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, AW, H);
  ctx.restore();
}

// Скелет игрока: только линии по точкам, в рамке «Мой удар». Левая рука — синим, правая — оранжевым (как в игре).
function drawSkeleton(ctx, sk, box) {
  const pose = isObj(sk) && Array.isArray(sk.pose) ? sk.pose : null;
  const hands = isObj(sk) && Array.isArray(sk.hands) ? sk.hands.filter((hd) => Array.isArray(hd) && hd.length >= 21) : [];
  const { x, y, w, h } = box;
  ctx.save();
  ctx.fillStyle = 'rgba(8,9,12,0.62)';
  roundRect(ctx, x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(196,162,101,0.55)'; ctx.lineWidth = 1; roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10); ctx.stroke();
  ctx.fillStyle = GOLD_HI; ctx.font = `700 13px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('МОЙ УДАР', x + 14, y + 12);
  fitFont(ctx, 'скелет в момент последнего удара · без видео', 400, 12, SANS, w - 28);
  ctx.fillStyle = MUTED; ctx.fillText('скелет в момент последнего удара · без видео', x + 14, y + 30);
  // все точки → общий прямоугольник → вписать в рамку
  const pts = [];
  const ok = (p) => isObj(p) && fin(p.x) && fin(p.y);
  if (pose) for (const p of pose) if (ok(p)) pts.push(p);
  for (const hd of hands) for (const p of hd) if (ok(p)) pts.push(p);
  if (pts.length < 4) {
    ctx.fillStyle = MUTED; ctx.font = `italic 15px ${SANS}`; ctx.textAlign = 'center';
    ctx.fillText('скелет появится после удара с камерой', x + w / 2, y + h / 2);
    ctx.restore();
    return;
  }
  const asp = fin(sk.aspect) && sk.aspect > 0 ? sk.aspect : 4 / 3;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x * asp); maxX = Math.max(maxX, p.x * asp); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const ix = x + 18, iy = y + 54, iw = w - 36, ih = h - 70;
  const bw = Math.max(1e-3, maxX - minX), bh = Math.max(1e-3, maxY - minY);
  const k = Math.min(iw / bw, ih / bh);
  const ox = ix + (iw - bw * k) / 2, oy = iy + (ih - bh * k) / 2;
  const P = (p) => [ox + (p.x * asp - minX) * k, oy + (p.y - minY) * k];
  const line = (a, b, color, width) => {
    if (!ok(a) || !ok(b)) return;
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // сторона руки — по положению в кадре (координаты показа уже зеркальные: левая рука игрока — слева)
  const sideColor = (i) => {
    const a = pose && pose[i], c = pose && pose[i === 13 || i === 15 ? 11 : 12];
    const mid = pose && ok(pose[11]) && ok(pose[12]) ? (pose[11].x + pose[12].x) / 2 : 0.5;
    const px = ok(a) ? a.x : ok(c) ? c.x : 0.5;
    return px < mid ? LEFT : RIGHT;
  };
  for (const pass of [0, 1]) {
    ctx.shadowColor = pass === 0 ? 'rgba(255,190,120,0.9)' : 'rgba(0,0,0,0)';
    ctx.shadowBlur = pass === 0 ? 14 : 0;
    if (pose) for (const [a, b] of POSE_LINKS) {
      const arm = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22].includes(b);
      const col = arm ? sideColor(b <= 22 && b % 2 === 1 ? 13 : 14) : PARCH;
      line(pose[a], pose[b], col, pass === 0 ? 7 : 4);
    }
    for (const hd of hands) {
      const col = pose && ok(pose[11]) && ok(pose[12]) && ok(hd[0]) ? (hd[0].x < (pose[11].x + pose[12].x) / 2 ? LEFT : RIGHT) : GOLD_HI;
      for (const [a, b] of HAND_LINKS) line(hd[a], hd[b], col, pass === 0 ? 4 : 2.2);
    }
  }
  // голова — круг у носа, шея — к середине плеч
  if (pose && ok(pose[0]) && ok(pose[11]) && ok(pose[12])) {
    const [nx, ny] = P(pose[0]), [ax, ay] = P(pose[11]), [bx, by] = P(pose[12]);
    const r = Math.max(8, Math.hypot(bx - ax, by - ay) * 0.3);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    for (const pass of [0, 1]) {
      ctx.shadowColor = pass === 0 ? 'rgba(255,190,120,0.9)' : 'rgba(0,0,0,0)'; ctx.shadowBlur = pass === 0 ? 14 : 0;
      ctx.strokeStyle = PARCH; ctx.lineWidth = pass === 0 ? 7 : 4;
      ctx.beginPath(); ctx.arc(nx, ny - r * 0.25, r, 0, Math.PI * 2); ctx.stroke();
      const dx = mx - nx, dy = my - (ny - r * 0.25), l = Math.hypot(dx, dy) || 1;
      ctx.beginPath(); ctx.moveTo(nx + (dx / l) * r, ny - r * 0.25 + (dy / l) * r); ctx.lineTo(mx, my); ctx.stroke();
    }
  }
  ctx.shadowBlur = 0;
  // суставы
  ctx.fillStyle = '#fff6e0';
  if (pose) for (const i of [11, 12, 13, 14, 15, 16, 23, 24]) { const p = pose[i]; if (ok(p)) { const [px, py] = P(p); ctx.beginPath(); ctx.arc(px, py, i === 0 ? 7 : 4, 0, Math.PI * 2); ctx.fill(); } }
  for (const hd of hands) for (const i of [4, 8, 12, 16, 20]) { const p = hd[i]; if (ok(p)) { const [px, py] = P(p); ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill(); } }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawQr(ctx, M, x, y, size) {
  const n = M.length, q = 2, cell = size / (n + q * 2);
  ctx.fillStyle = PARCH; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#15120f';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (M[r][c]) ctx.fillRect(x + (c + q) * cell, y + (r + q) * cell, Math.ceil(cell), Math.ceil(cell));
}

// Подогнать шрифт под ширину
function fitFont(ctx, text, weight, size, family, maxW) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 10 && ctx.measureText(text).width > maxW) { s -= 2; ctx.font = `${weight} ${s}px ${family}`; }
  return s;
}

export function drawPoster(ctx, data) {
  const d = isObj(data) ? data : {};
  const W = POSTER_W, H = POSTER_H, AW = 720, PX = 760;
  const seed = (Math.round(fin(d.score) ? d.score : 0) * 2654435761) >>> 0;
  ctx.save();
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, W, H);
  safe(() => { const g = ctx.createRadialGradient(W * 0.82, H * 0.35, 20, W * 0.82, H * 0.35, 520); g.addColorStop(0, 'rgba(120,80,36,0.35)'); g.addColorStop(1, 'rgba(12,13,16,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); });
  safe(() => drawArt(ctx, d.art || null, AW, H, seed));
  // итог боя поверх арта
  safe(() => {
    const out = OUTCOME[d.outcome] || (d.kind === 'challenge' ? OUTCOME.timeup : 'БОЙ С РЕГЕНТОМ');
    const sub = d.outcome === 'victory' && fin(d.elapsed) && d.elapsed > 0 ? `за ${Math.round(d.elapsed)} с` : d.kind === 'challenge' ? 'испытание · 60 секунд' : 'бой с Регентом Нимба';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 12;
    ctx.fillStyle = PARCH; ctx.font = `400 42px ${CAPS}`;
    ctx.fillText(out, 46, 82);
    ctx.fillStyle = GOLD_HI; ctx.font = `600 20px ${SANS}`;
    ctx.fillText(sub, 48, 112);
    if (d.heroName) {
      ctx.fillStyle = PARCH; ctx.font = `italic 600 26px ${SERIF}`;
      ctx.fillText(String(d.heroName), 46, H - 70);
      if (d.heroCls) { ctx.fillStyle = MUTED; ctx.font = `15px ${SANS}`; ctx.fillText(String(d.heroCls), 48, H - 46); }
    }
    ctx.shadowBlur = 0;
  });
  safe(() => drawSkeleton(ctx, d.skeleton, { x: 404, y: 150, w: 290, h: 360 }));

  // правая панель
  safe(() => {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = GOLD; ctx.font = `600 44px ${NUM}`;
    ctx.fillText('ASHEN OATH', PX, 92);
    const kick = d.kind === 'challenge' ? 'ИСПЫТАНИЕ · 60 С · КАМЕРА ВМЕСТО ДЖОЙСТИКА' : 'БОЙ С РЕГЕНТОМ · КАМЕРА ВМЕСТО ДЖОЙСТИКА';
    fitFont(ctx, kick, 600, 15, SANS, W - 46 - PX - 2);
    ctx.fillStyle = MUTED; ctx.fillText(kick, PX + 2, 120);
    ctx.strokeStyle = 'rgba(196,162,101,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PX, 138.5); ctx.lineTo(W - 46, 138.5); ctx.stroke();
  });
  // медальон ранга и очки
  safe(() => {
    const rank = typeof d.rank === 'string' ? d.rank : 'D';
    const col = RANK_COLOR[rank] || RANK_COLOR.D;
    const cx = PX + 78, cy = 238, r = 70;
    const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, r * 1.8);
    glow.addColorStop(0, 'rgba(255,210,120,0.35)'); glow.addColorStop(1, 'rgba(255,210,120,0)');
    ctx.fillStyle = glow; ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
    ctx.fillStyle = '#16140f'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(196,162,101,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, r - 12, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col; ctx.font = `700 84px ${NUM}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = col; ctx.shadowBlur = 18;
    ctx.fillText(rank, cx, cy + 6);
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const sx = cx + r + 26;
    fitFont(ctx, fmt(d.score), 700, 62, NUM, W - 46 - sx);
    ctx.fillStyle = PARCH; ctx.fillText(fmt(d.score), sx, cy + 14);
    const sub = `очков · ранг ${rank}${d.rankTitle ? ` · ${d.rankTitle}` : ''}`;
    fitFont(ctx, sub, 600, 16, SANS, W - 46 - sx - 2);
    ctx.fillStyle = MUTED; ctx.fillText(sub, sx + 2, cy + 42);
    let who = '';
    if (d.isRecord) who = 'НОВЫЙ РЕКОРД ДНЯ';
    else if (fin(d.place) && d.place > 0) who = `${d.place}-е место дня${fin(d.total) ? ` из ${d.total}` : ''}`;
    const nm = d.name ? String(d.name) : '';
    const line = [nm, who].filter(Boolean).join(' · ');
    if (line) { fitFont(ctx, line, 700, 19, SANS, W - 46 - sx - 2); ctx.fillStyle = d.isRecord ? '#ffd36b' : GOLD_HI; ctx.fillText(line, sx + 2, cy - 52); }
  });
  // строки статистики
  safe(() => {
    const rows = [];
    const bg = isObj(d.bestGesture) ? d.bestGesture : null;
    rows.push(['Лучший жест', bg ? `${bg.title}${fin(bg.good) ? `  ×${bg.good}` : ''}` : '—']);
    rows.push(['Точность жестов', fin(d.accuracy) ? `${Math.round(d.accuracy)}%` : '—']);
    rows.push(['Урон · серия', `${fmt(d.damage)}${fin(d.maxCombo) && d.maxCombo > 0 ? `  ·  ×${Math.round(d.maxCombo)}` : ''}`]);
    let y = 362;
    for (const [k, v] of rows) {
      ctx.fillStyle = MUTED; ctx.font = `600 15px ${SANS}`; ctx.textAlign = 'left';
      ctx.fillText(k.toUpperCase(), PX, y);
      fitFont(ctx, v, 600, 24, NUM, W - 46 - PX - 190);
      ctx.fillStyle = PARCH; ctx.textAlign = 'right';
      ctx.fillText(v, W - 46, y + 2);
      ctx.strokeStyle = 'rgba(87,74,51,0.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PX, y + 14.5); ctx.lineTo(W - 46, y + 14.5); ctx.stroke();
      y += 44;
    }
    ctx.textAlign = 'left';
  });
  // QR и адрес
  safe(() => {
    const url = typeof d.url === 'string' && d.url ? d.url : GAME_URL;
    const M = qrMatrix(url, 'M');
    const qs = 124, qx = W - 46 - qs, qy = H - 40 - qs;
    drawQr(ctx, M, qx, qy, qs);
    const tw = qx - 18 - PX;   // подпись — слева от QR
    ctx.textAlign = 'left';
    ctx.fillStyle = PARCH; fitFont(ctx, 'Сыграй сам —', 400, 26, CAPS, tw);
    ctx.fillText('Сыграй сам —', PX, qy + 26);
    fitFont(ctx, 'побей мой рекорд', 400, 26, CAPS, tw);
    ctx.fillText('побей мой рекорд', PX, qy + 54);
    // адрес — в две строки: сайт и путь
    const shown = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const cut = shown.indexOf('/');
    const host = cut > 0 ? shown.slice(0, cut) : shown, path = cut > 0 ? shown.slice(cut) : '';
    ctx.fillStyle = GOLD_HI;
    fitFont(ctx, host, 600, 16, SANS, tw); ctx.fillText(host, PX, qy + 80);
    if (path) { fitFont(ctx, path, 600, 16, SANS, tw); ctx.fillText(path, PX, qy + 100); }
    const when = `${dateText(d.date)} · хакатон ADMIT`;
    fitFont(ctx, when, 400, 13, SANS, tw);
    ctx.fillStyle = MUTED; ctx.fillText(when, PX, qy + 122);
  });
  safe(() => frame(ctx, W, H));
  ctx.restore();
}

// Шрифты постера — те же, что у интерфейса (vendor/fonts); ждём их не дольше timeoutMs, иначе — запасные
export function posterFontsReady(doc, timeoutMs = 1500) {
  const fonts = doc && doc.fonts;
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve(false);
  const all = Promise.all(['700 40px Cinzel', '400 40px Forum', 'italic 600 26px "Cormorant Garamond"'].map((f) => fonts.load(f, 'ASHEN 0123 АБВ').catch(() => null)));
  return Promise.race([all.then(() => true), new Promise((r) => setTimeout(() => r(false), timeoutMs))]);
}

export function createPosterCanvas(doc, data) {
  const c = doc.createElement('canvas');
  c.width = POSTER_W; c.height = POSTER_H;
  const ctx = c.getContext('2d');
  if (ctx) drawPoster(ctx, data);
  return c;
}

export function posterBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof canvas.toBlob === 'function') canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG не создан'))), 'image/png');
      else reject(new Error('canvas.toBlob недоступен'));
    } catch (e) { reject(e); }
  });
}

// Имя файла — только латиница: с кириллицей Chrome сохраняет файл как «download» без расширения
const TRANSLIT = { А: 'A', Б: 'B', В: 'V', Г: 'G', Д: 'D', Е: 'E', Ё: 'E', Ж: 'ZH', З: 'Z', И: 'I', Й: 'Y', К: 'K', Л: 'L', М: 'M', Н: 'N', О: 'O', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ф: 'F', Х: 'H', Ц: 'TS', Ч: 'CH', Ш: 'SH', Щ: 'SCH', Ъ: '', Ы: 'Y', Ь: '', Э: 'E', Ю: 'YU', Я: 'YA', Ә: 'A', Ғ: 'G', Қ: 'Q', Ң: 'NG', Ө: 'O', Ұ: 'U', Ү: 'U', Һ: 'H', І: 'I' };
export function asciiName(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s).toUpperCase()) out += /[A-Z0-9]/.test(ch) ? ch : TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : '';
  return out.slice(0, 12);
}
export function posterFileName(data) {
  const d = isObj(data) ? data : {};
  const ascii = asciiName(d.name);
  const name = ascii ? `-${ascii}` : '';
  const t = new Date(fin(d.date) ? d.date : Date.now());
  const p = (v) => String(v).padStart(2, '0');
  return `ashen-oath${name}-${Math.round(fin(d.score) ? d.score : 0)}-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.png`;
}

export function downloadPoster(doc, blob, fileName) {
  const a = doc.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName || 'ashen-oath.png';
  (doc.body || doc.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

// Скелет для постера из vision.getPose() / getHands(): только координаты точек (копия), в системе показа
export function skeletonFromVision(pose, hands) {
  const out = { pose: null, hands: [], aspect: 4 / 3 };
  if (isObj(pose) && Array.isArray(pose.landmarks)) {
    const mir = pose.mirror !== false;
    out.pose = pose.landmarks.slice(0, 33).map((q) => (isObj(q) && fin(q.x) && fin(q.y) && (!fin(q.visibility) || q.visibility >= 0.45) ? { x: clamp(mir ? 1 - q.x : q.x, -0.2, 1.2), y: clamp(q.y, -0.2, 1.2) } : null));
    if (fin(pose.frameW) && fin(pose.frameH) && pose.frameH > 0) out.aspect = pose.frameW / pose.frameH;
  }
  if (isObj(hands)) for (const side of ['left', 'right']) {
    const L = hands[side] && Array.isArray(hands[side].landmarks) ? hands[side].landmarks : null;
    if (L && L.length >= 21) out.hands.push(L.slice(0, 21).map((q) => (isObj(q) && fin(q.x) && fin(q.y) ? { x: q.x, y: q.y } : null)));
  }
  return out.pose || out.hands.length ? out : null;
}

// Поза для постера без камеры (отладка с клавиатуры): герой выбрасывает правую руку вперёд-вверх
export function demoSkeleton() {
  const P = (x, y) => ({ x, y });
  const pose = new Array(33).fill(null);
  pose[0] = P(0.5, 0.24); pose[2] = P(0.48, 0.21); pose[5] = P(0.52, 0.21); pose[9] = P(0.485, 0.29); pose[10] = P(0.515, 0.29);
  pose[11] = P(0.41, 0.42); pose[12] = P(0.59, 0.42);
  pose[13] = P(0.35, 0.58); pose[15] = P(0.39, 0.7); pose[17] = P(0.4, 0.74); pose[19] = P(0.41, 0.73); pose[21] = P(0.4, 0.72);
  pose[14] = P(0.7, 0.33); pose[16] = P(0.8, 0.2); pose[18] = P(0.82, 0.16); pose[20] = P(0.83, 0.17); pose[22] = P(0.8, 0.17);
  pose[23] = P(0.44, 0.8); pose[24] = P(0.56, 0.8); pose[25] = P(0.43, 0.98); pose[26] = P(0.57, 0.98);
  return { pose, hands: [], aspect: 4 / 3, demo: true };
}
