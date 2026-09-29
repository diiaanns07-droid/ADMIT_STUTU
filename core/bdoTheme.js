// ASHEN OATH — core/bdoTheme.js. Владелец: №8 [BDO].
// Общая палитра и шрифты стиля Black Desert для canvas-HUD (battleHud, trackingHud, bdoHud) —
// те же значения, что CSS-переменные --bdo-* в modules/ui.css. Плюс помощники рисования:
// тёмная полупрозрачная панель с бронзовой каймой и орнаментом в углах, полоса с «догоняющим»
// слоем, текст с засечками и тенью. Ничего не создаёт в кадре (без new в горячем цикле).

export const BDO = Object.freeze({
  coal: '#0b0a09', coal2: '#15120f', coal3: '#1f1a14',
  panel: 'rgba(12, 10, 8, 0.78)', panelSoft: 'rgba(12, 10, 8, 0.55)',
  bronze: '#8a6a3e', bronzeDim: '#5a4528', bronzeHi: '#b08a52',
  gold: '#d8b36a', goldHi: '#f3dca0', goldDeep: '#a07a3c',
  ivory: '#ece2cc', ivoryDim: '#b9ae96', ivoryFaint: '#857c6a',
  blood: '#b0262a', bloodHi: '#e0484a', bloodDeep: '#5e1114',
  mana: '#2f6fd0', manaHi: '#5aa0ff', manaDeep: '#12305e',
  stamina: '#c9a34a', staminaHi: '#f0d27a',
  teal: '#4fb3a6', tealHi: '#8fe0d2',
  ember: '#ff8a3c', emberHi: '#ffc27a',
  danger: '#e0484a', warn: '#e8b04a', good: '#8fc98a',
  // Шрифты: Forum (римские капители, есть кириллица) и Cinzel (латиница, цифры) — Google Fonts,
  // подключены в modules/ui.css; без сети — системная антиква.
  fontDisplay: "'Forum', 'Cinzel', 'Cormorant SC', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif",
  fontNum: "'Cinzel', 'Forum', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
  fontBody: "'Alegreya Sans', 'Segoe UI', system-ui, 'Noto Sans', 'Liberation Sans', sans-serif",
});

/** Включён ли стиль BDO (настройка bdoUi, по умолчанию да). */
export function isBdo(settings) { return !(settings && settings.bdoUi === false); }

/** Шрифт canvas: font('display', 20, 600) → "600 20px 'Forum', …". */
export function font(kind, px, weight = 400) {
  const fam = kind === 'num' ? BDO.fontNum : kind === 'body' ? BDO.fontBody : BDO.fontDisplay;
  return `${weight} ${Math.round(px)}px ${fam}`;
}

/** Подключить таблицу стилей один раз (для модулей со своим CSS). */
export function ensureStyle(href, id) {
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;
    const key = id || href;
    if (doc.querySelector(`link[data-bdo-style="${key}"]`)) return;
    const l = doc.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-bdo-style', key);
    doc.head.appendChild(l);
  } catch (e) { /* без стилей — не фатально */ }
}

/** Попросить браузер подгрузить веб-шрифты (для canvas: без этого первый кадр — запасной шрифт). */
export function preloadFonts() {
  try {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
    for (const f of ["16px 'Forum'", "600 16px 'Cinzel'", "16px 'Alegreya Sans'", "700 16px 'Alegreya Sans'"]) document.fonts.load(f).catch(() => {});
  } catch (e) { /* ignore */ }
}

/** Путь скруглённого прямоугольника со срезанными углами (как у панелей BDO). */
export function chamferPath(ctx, x, y, w, h, c = 6) {
  c = Math.min(c, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c); ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c); ctx.closePath();
}

/** Орнамент угла: двойная линия с ромбом. sx/sy = ±1 — куда «смотрит» угол. */
export function cornerOrnament(ctx, x, y, sx, sy, s = 10, color = BDO.gold, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + sx * s * 1.6, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * s * 1.6);
  ctx.moveTo(x + sx * s * 0.9, y + sy * 3); ctx.lineTo(x + sx * 3, y + sy * 3); ctx.lineTo(x + sx * 3, y + sy * s * 0.9);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  const dx = x + sx * 3, dy = y + sy * 3, r = 2.2;
  ctx.moveTo(dx, dy - r); ctx.lineTo(dx + r, dy); ctx.lineTo(dx, dy + r); ctx.lineTo(dx - r, dy); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Панель BDO: тёмная подложка, волосяная бронзовая кайма, внутренний кант и золотые уголки. */
export function panel(ctx, x, y, w, h, { alpha = 1, fill = BDO.panel, edge = BDO.bronze, corner = BDO.gold, ornament = true, c = 5 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  chamferPath(ctx, x, y, w, h, c);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  chamferPath(ctx, x + 3, y + 3, w - 6, h - 6, Math.max(1, c - 2));
  ctx.strokeStyle = 'rgba(216, 179, 106, 0.16)';
  ctx.stroke();
  if (ornament) {
    cornerOrnament(ctx, x + 1, y + 1, 1, 1, 7, corner);
    cornerOrnament(ctx, x + w - 1, y + 1, -1, 1, 7, corner);
    cornerOrnament(ctx, x + 1, y + h - 1, 1, -1, 7, corner);
    cornerOrnament(ctx, x + w - 1, y + h - 1, -1, -1, 7, corner);
  }
  ctx.restore();
}

/** Тонкая золотая линия, гаснущая к краям (разделитель титров). */
export function fadeRule(ctx, x0, x1, y, color = BDO.gold, alpha = 1) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, 'rgba(216,179,106,0)');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'rgba(216,179,106,0)');
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x0, Math.round(y), x1 - x0, 1);
  ctx.restore();
}

/** Текст с мягкой тенью (читается на любом фоне). */
export function shadowText(ctx, text, x, y, { color = BDO.ivory, font: f, align = 'left', baseline = 'alphabetic', alpha = 1, blur = 6, shadow = 'rgba(0,0,0,0.85)' } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (f) ctx.font = f;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.shadowColor = shadow;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Полоса ресурса BDO: тёмный жёлоб, «догоняющий» слой (lag, светлее), основной слой с бликом,
 * деления каждые 10%. frac/lag — 0..1. kind: 'hp' | 'mp' | 'st' | 'boss'.
 */
export function resourceBar(ctx, x, y, w, h, frac, lag, kind = 'hp', { alpha = 1, ticks = true } = {}) {
  const C = kind === 'mp' ? [BDO.manaDeep, BDO.mana, BDO.manaHi] : kind === 'st' ? ['#4a3a14', BDO.stamina, BDO.staminaHi] : [BDO.bloodDeep, BDO.blood, BDO.bloodHi];
  frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  lag = Math.max(frac, lag < 0 ? 0 : lag > 1 ? 1 : lag);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = 'rgba(4,3,2,0.82)';
  ctx.fillRect(x, y, w, h);
  if (lag > frac) { ctx.fillStyle = kind === 'mp' ? 'rgba(160,200,255,0.55)' : 'rgba(255,214,160,0.62)'; ctx.fillRect(x + w * frac, y, w * (lag - frac), h); }
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, C[2]); g.addColorStop(0.45, C[1]); g.addColorStop(1, C[0]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w * frac, h);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, w * frac, Math.max(1, Math.round(h * 0.28)));
  if (ticks && w > 60) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 1; i < 10; i++) ctx.fillRect(Math.round(x + (w * i) / 10), y + 1, 1, h - 2);
  }
  ctx.strokeStyle = BDO.bronzeDim;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  ctx.restore();
}
