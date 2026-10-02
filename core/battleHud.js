// ASHEN OATH — боевой трекинг-HUD поверх 3D-сцены (2D canvas). Владелец: №1.
// «Tracking edit»: захват цели на страже, метки атак с таймером, комбо, выноски урона,
// руна, нарисованная пальцем, прямо на экране, замедление времени, интро.
// Ничего не импортирует, свой rAF не запускает: main.js вызывает frame() каждый кадр.
//
// frame(f): f = { dtReal, timeScale, screen, snapshot, events, input, project(p)->{x,y,behind},
//   viewport:{w,h}, intro:{active,t,duration}, settings:{reducedMotion}, resumeLeftMs,
//   pois:[{id,x,y,z}] — [ASHEN_V2] незажжённые угли клятвы (метка над алтарём или стрелка у края),
//   coach:{hint:{code,gesture,text,fix,side,hand}|null, accuracy, good, mistakes} — [ТВИСТ «ОШИБКА»] подсказка к
//   почти-правильному жесту (карточка слева над панелью героя, с пиктограммой) и точность жестов за бой,
//   ult:{fury, furyMax, ready, gesture:{phase, progress, count}|null, debug, flash, cine:{t, dur, strikeAt, struck,
//   amount, pct}|null} — [W3-ULT] шкала «Ярость клятвы», зов «ПОДНИМИ ОБЕ РУКИ!», кольцо удержания, сцена «Небесный суд» }

const MONO = '"Consolas","Cascadia Mono",monospace';
const SERIF = '"Palatino Linotype","Book Antiqua",Georgia,serif';
const GOLD = '#c9a45c', GOLD_HI = '#e3c792', STEEL = '#dfe8f5', BLUE = '#9fc4ff', EMBER = '#ff6a3c', DIM = '#8d97a6';
const PLATE = 'rgba(5,7,11,0.62)';
const GLYPHS = '0123456789АБВГДЕЖЗКМ#%+=/<>';
const RUNE_NAME = { ignis: 'ИГНИС', fulgur: 'ФУЛЬГУР', orbis: 'ОРБИС', stella: 'СТЕЛЛА', spira: 'СПИРА', lemnis: 'ЛЕМНИСКА', caret: 'АКУС', vee: 'МЕССИС', clepsydra: 'КЛЕПСИДРА', alpha: 'АЛЬФА' };
const RUNE_SUB = { ignis: 'огненное копьё', fulgur: 'страж оглушён', orbis: 'лечение и оберег', stella: 'звездопад', spira: 'вихрь гасит сферы', lemnis: 'вечность: лечение', caret: 'залп игл', vee: 'жатва', clepsydra: 'время Регента замедлено', alpha: 'откаты сброшены' };
const KIND = { slam: 'УДАР', orb: 'СФЕРА', nova: 'НОВА' };
// [ASHEN_V3] двуручные печати
const SIGIL_NAME = { clap: 'ГРОМОВОЙ ХЛОПОК', gate: 'ВРАТА · БАСТИОН', frame: 'МЕТКА ЦЕЛИ', delta: 'ДЕЛЬТА · ЛУЧ', cor: 'КОР · СЕРДЦЕ' };

import { createBdoHud } from './bdoHud.js'; // [BDO] DOM-слой HUD в стиле Black Desert
import { COACH_HINTS, hintPictogram } from './gestureCoach.js'; // [ТВИСТ «ОШИБКА»] пиктограммы карточки
import { BOSS_CUE_SEC, telegraphCounter } from '../modules/boss.js'; // [FEEL] «!» над Регентом и подписи телеграфа

// [FEEL] «Отклик»: каждое распознанное движение — крупная надпись с иконкой у героя (0,6 с), крупные цифры
// урона (криты — золотые), большое комбо, красные зоны атак на земле и «!» над Регентом, финал боя.
// Прежние мелкие подписи не удалены — выключены здесь (legacy*: true вернёт их).
const FEEL = {
  moves: true,             // крупные надписи жестов у героя
  bigNumbers: true,        // крупные цифры урона, золотые криты
  bigCombo: true,          // «×5 КОМБО» крупно
  groundZones: true,       // красная зона атаки на земле + подпись «ЩИТ или РЫВОК»
  bossCue: true,           // «!» над Регентом за BOSS_CUE_SEC до удара
  outro: true,             // «ПОБЕДА» / «РЕГЕНТ УСТОЯЛ» поверх замедленного финала
  legacyTeleTags: false,   // прежние мелкие метки «▲ УДАР 1.2 с · УЙДИ» у зоны
  legacyMoveTags: false,   // прежние мелкие БЛОК / УКЛОН / ИДЕАЛЬНЫЙ РЫВОК
};
const SANS = '"Segoe UI","Trebuchet MS",system-ui,sans-serif';
const CRIT = '#ffcf4a', RED = '#ff3b2a', OK_GREEN = '#9be39b';
const MOVE_DUR = 0.6;      // сколько живёт надпись жеста

const isObj = (v) => v !== null && typeof v === 'object';
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createBattleHud({ canvas } = {}) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { frame() {}, reset() {}, dispose() {} };
  // [BDO] DOM-слой (панель умений, полосы, цель, мини-карта, титр зоны); ошибки не ломают canvas-HUD
  let bdo = null;
  try { bdo = createBdoHud({ root: canvas.parentNode, canvas }); } catch (e) { console.warn('[battleHud] bdoHud', e); bdo = null; }
  let W = 0, H = 0, dpr = 1, disposed = false, drawn = false;
  let t = 0;
  const lock = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false, hitFlash: 0 };
  const callouts = [];       // {text, x, y, vy, t, dur, color, size, font, scramble}
  const MAX_CALLOUTS = 18;
  let flash = { t: 1, dur: 0.25, color: 'rgba(227,199,146,', a: 0.3 };
  let hurt = { t: 1, dur: 0.35 };
  let dashFx = { t: 1, dir: 1 };
  let combo = { n: 0, shown: 0, pop: 0, lost: 0, lostN: 0 };
  let rune = { name: '', sub: '', t: 9, trail: null };
  let fizzleT = 9;
  let coach = { hint: null, t: 9 };   // [ТВИСТ «ОШИБКА»] текущая карточка подсказки
  // [FEEL] надписи жестов, крит отражённой сферы, финал, троттлинг частых жестов
  const moves = [];                   // {key, text, sub, color, icon, t, dur, big, n}
  const parried = new Map();          // projectileId → t (отражённая сфера — крит)
  let critNext = false;               // projectile_impact отражённой сферы → следующий boss_hit — крит
  let lastBurstMove = null, lastBoltT = -9;
  const deniedAt = {};                // ability → t последней надписи «нет энергии»
  let hero = null;                    // экранная рамка героя за кадр: {cx, top, bot, h}
  let outro = { kind: '', t: 0, time: 0, bossPct: 0 };
  let comboMilestone = 0;
  const COACH_DUR = 4.2;
  const PIC_W = 150, PIC_H = 64;   // пиктограмма в карточке (SVG 168×72 → 150×64)
  let lastScreen = '';
  let playingSince = -1;

  function resize(vw, vh) {
    const d = clamp(num(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1), 1, 2);
    const bw = Math.round(vw * d), bh = Math.round(vh * d);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    W = vw; H = vh; dpr = d;
  }
  function clearAll() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  }
  function scramble(text, age, rm, speed = 0.45) {
    if (rm || age >= speed) return text;
    const k = age / speed;
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      out += (i / text.length < k || ch === ' ') ? ch : GLYPHS[(Math.floor(age * 60) + i * 7) % GLYPHS.length];
    }
    return out;
  }
  function brackets(x0, y0, x1, y1, len) {
    const lx = Math.min(len, (x1 - x0) * 0.4), ly = Math.min(len, (y1 - y0) * 0.4);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + ly); ctx.lineTo(x0, y0); ctx.lineTo(x0 + lx, y0);
    ctx.moveTo(x1 - lx, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + ly);
    ctx.moveTo(x1, y1 - ly); ctx.lineTo(x1, y1); ctx.lineTo(x1 - lx, y1);
    ctx.moveTo(x0 + lx, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - ly);
    ctx.stroke();
  }
  function tag(text, x, y, color, font = `11px ${MONO}`, align = 'left') {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const px = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = PLATE;
    ctx.fillRect(px - 4, y - 2, w + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, px, y);
    return w;
  }
  function addCallout(text, x, y, color, size = 13, opts = {}) {
    if (callouts.length >= MAX_CALLOUTS) callouts.shift();
    callouts.push({ text, x, y, vy: opts.vy ?? -26, t: 0, dur: opts.dur ?? 0.9, color, size, serif: !!opts.serif, scramble: !!opts.scramble,
      sans: !!opts.sans, pop: !!opts.pop, label: opts.label || '' }); // [FEEL] крупные цифры: жирный шрифт с обводкой, «щелчок», подпись «КРИТ!»
  }
  function vignette(color, a, inner = 0.55) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * inner * 0.5, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, color + '0)');
    g.addColorStop(1, color + a + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ------------------------------------------------------------------ [FEEL] надписи жестов
  // Каждое распознанное движение — крупная надпись с иконкой над героем: появляется «щелчком» (0,1 с),
  // держится и гаснет за MOVE_DUR. Тот же приём подряд не дублируется, а «перещёлкивается».
  // Не больше трёх надписей: новая снизу, старые уходят вверх и гаснут быстрее.
  function showMove(key, text, color, icon, opts = {}) {
    if (!FEEL.moves) return null;
    const last = moves[moves.length - 1];
    if (last && last.key === key && last.t < 0.4) {
      last.t = Math.min(last.t, 0.05); last.text = text; last.n++;
      if (opts.sub !== undefined) last.sub = opts.sub;
      return last;
    }
    if (moves.length >= 3) moves.shift();
    const m = { key, text, sub: opts.sub || '', color, icon, t: 0, dur: opts.dur || MOVE_DUR, big: !!opts.big, small: !!opts.small, n: 1, slot: 0 };
    moves.push(m);
    return m;
  }
  // Векторные иконки приёмов (без шрифтов-эмодзи: на ноутбуке жюри их может не быть).
  function drawIcon(kind, x, y, r, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(5,7,11,0.78)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    const k = r * 0.55;
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.fillStyle = color;
    ctx.beginPath();
    switch (kind) {
      case 'shield':
        ctx.moveTo(0, -k); ctx.lineTo(k * 0.85, -k * 0.6); ctx.lineTo(k * 0.7, k * 0.35); ctx.lineTo(0, k); ctx.lineTo(-k * 0.7, k * 0.35); ctx.lineTo(-k * 0.85, -k * 0.6); ctx.closePath(); ctx.stroke();
        break;
      case 'parry':
        ctx.arc(0, 0, k * 0.85, -Math.PI * 0.85, Math.PI * 0.15); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-k, k); ctx.lineTo(k * 0.15, -k * 0.15); ctx.moveTo(k * 0.15, -k * 0.15); ctx.lineTo(k * 0.15, k * 0.45); ctx.moveTo(k * 0.15, -k * 0.15); ctx.lineTo(-k * 0.45, -k * 0.15); ctx.stroke();
        break;
      case 'spark':
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; ctx.moveTo(Math.cos(a) * k * 1.05, Math.sin(a) * k * 1.05); ctx.lineTo(Math.cos(a + Math.PI / 4) * k * 0.3, Math.sin(a + Math.PI / 4) * k * 0.3); ctx.lineTo(Math.cos(a + Math.PI / 2) * k * 1.05, Math.sin(a + Math.PI / 2) * k * 1.05); }
        ctx.closePath(); ctx.fill();
        break;
      case 'slash':
        ctx.arc(-k * 0.6, k * 0.6, k * 1.5, -Math.PI * 0.5, 0); ctx.stroke();
        ctx.beginPath(); ctx.arc(-k * 0.9, k * 0.9, k * 1.1, -Math.PI * 0.45, -Math.PI * 0.05); ctx.stroke();
        break;
      case 'arrow':
        ctx.moveTo(-k, k); ctx.lineTo(k, -k); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(k, -k); ctx.lineTo(k * 0.1, -k * 0.85); ctx.lineTo(k * 0.85, -k * 0.1); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-k, k); ctx.lineTo(-k * 0.95, k * 0.45); ctx.moveTo(-k, k); ctx.lineTo(-k * 0.45, k * 0.95); ctx.stroke();
        break;
      case 'bolt':
        ctx.arc(k * 0.35, -k * 0.35, k * 0.45, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-k, k); ctx.lineTo(-k * 0.05, k * 0.05); ctx.moveTo(-k * 0.95, k * 0.35); ctx.lineTo(-k * 0.4, -k * 0.2); ctx.moveTo(-k * 0.35, k * 0.95); ctx.lineTo(k * 0.2, k * 0.4); ctx.stroke();
        break;
      case 'burst':
        ctx.arc(0, 0, k * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath();
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.moveTo(Math.cos(a) * k * 0.62, Math.sin(a) * k * 0.62); ctx.lineTo(Math.cos(a) * k * 1.1, Math.sin(a) * k * 1.1); }
        ctx.stroke();
        break;
      case 'dash':
        ctx.moveTo(-k, -k * 0.75); ctx.lineTo(-k * 0.1, 0); ctx.lineTo(-k, k * 0.75); ctx.moveTo(k * 0.05, -k * 0.75); ctx.lineTo(k * 0.95, 0); ctx.lineTo(k * 0.05, k * 0.75); ctx.stroke();
        break;
      case 'orb':
        ctx.arc(0, 0, k * 0.8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(-k * 0.25, -k * 0.25, k * 0.28, 0, Math.PI * 2); ctx.fill();
        break;
      case 'deny':
        ctx.moveTo(-k * 0.7, -k * 0.7); ctx.lineTo(k * 0.7, k * 0.7); ctx.moveTo(k * 0.7, -k * 0.7); ctx.lineTo(-k * 0.7, k * 0.7); ctx.stroke();
        break;
      default:
        ctx.moveTo(0, -k); ctx.lineTo(k, 0); ctx.lineTo(0, k); ctx.lineTo(-k, 0); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
  }
  function moveSize(m) { const base = clamp(H * 0.058, 28, 52); return m.big ? base * 1.25 : m.small ? base * 0.62 : base; }
  // Якорь надписей: над головой героя; если там рамка Регента — левее неё (при нехватке места надписи
  // ужимаются до 72%), иначе под рамкой. Вправо не уходим: там счётчик комбо.
  function moveAnchor(wMax, hTot) {
    let x = hero ? hero.cx : W * 0.36, y = hero ? hero.top - 16 : H * 0.52, k = 1;
    y = clamp(y, Math.min(H * 0.7, H * 0.16 + hTot), H * 0.7);
    x = clamp(x, wMax / 2 + 16, W - wMax / 2 - 16);
    if (lock.ok) {
      const bx0 = lock.x0 - 28, bx1 = lock.x1 + 28, by0 = lock.y0 - 28, by1 = lock.y1 + 18;
      const overlaps = x + wMax / 2 > bx0 && x - wMax / 2 < bx1 && y > by0 && y - hTot < by1;
      if (overlaps) {
        const room = bx0 - 14;                              // ширина слева от Регента
        if (room >= wMax) x = bx0 - wMax / 2;
        else if (room >= wMax * 0.72) { k = room / wMax; x = 14 + room / 2; }
        else y = Math.min(H * 0.78, by1 + hTot + 8);         // под ним
      }
    }
    return { x, y, k };
  }
  function drawMoves(dtR, rm) {
    if (!moves.length) return;
    for (let i = moves.length - 1; i >= 0; i--) { moves[i].t += dtR; if (moves[i].t >= moves[i].dur) moves.splice(i, 1); }
    if (!moves.length) return;
    // общий якорь: ширина по самой широкой надписи
    let wMax = 0, hTot = 0;
    for (const m of moves) {
      const sz = moveSize(m);
      ctx.font = `800 ${Math.round(sz)}px ${SANS}`;
      m.w = ctx.measureText(m.text).width + sz * 1.3;
      if (m.sub) { ctx.font = `700 ${Math.round(sz * 0.4)}px ${SANS}`; m.w = Math.max(m.w, ctx.measureText(m.sub).width + sz * 1.3); }
      m.h = sz * (m.sub ? 1.55 : 1.15);
      wMax = Math.max(wMax, m.w); hTot += m.h;
    }
    const A = moveAnchor(wMax, hTot);   // вся стопка надписей, не только нижняя
    let yCursor = A.y;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';   // без «шипов» у обводки
    for (let i = moves.length - 1; i >= 0; i--) {
      const m = moves[i], sz = moveSize(m) * A.k, older = moves.length - 1 - i;
      m.w *= A.k; m.h *= A.k;
      const life = m.dur * (older ? 0.75 : 1);
      const kIn = clamp(m.t / 0.1, 0, 1);
      const out = clamp((life - m.t) / 0.2, 0, 1);
      const a = Math.min(rm ? clamp(m.t / 0.08, 0, 1) : kIn, out) * (older ? 0.75 : 1);
      if (a <= 0.01) { yCursor -= m.h; continue; }
      const pop = rm ? 1 : 1 + 0.45 * (1 - kIn) * (1 - kIn);
      const rise = rm ? 0 : 10 * (m.t / m.dur);
      const cx = A.x, base = yCursor - rise;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(cx, base - sz * 0.35);
      ctx.scale(pop, pop);
      ctx.translate(-cx, -(base - sz * 0.35));
      const ir = sz * 0.5, tx = cx - m.w / 2 + ir * 2 + sz * 0.18;
      drawIcon(m.icon, cx - m.w / 2 + ir, base - sz * 0.36, ir, m.color);
      ctx.font = `800 ${Math.round(sz)}px ${SANS}`;
      ctx.lineWidth = Math.max(3, sz * 0.13); ctx.strokeStyle = 'rgba(0,0,0,0.82)';
      ctx.strokeText(m.text, tx, base);
      if (!rm) { ctx.shadowColor = m.color; ctx.shadowBlur = sz * 0.45 * (1 - kIn * 0.5); }
      ctx.fillStyle = m.color;
      ctx.fillText(m.text, tx, base);
      ctx.shadowBlur = 0;
      if (m.sub) {
        ctx.font = `700 ${Math.round(sz * 0.4)}px ${SANS}`;
        ctx.lineWidth = Math.max(2, sz * 0.08);
        ctx.strokeText(m.sub, tx + 2, base + sz * 0.5);
        ctx.fillStyle = STEEL; ctx.fillText(m.sub, tx + 2, base + sz * 0.5);
      }
      ctx.restore();
      yCursor -= m.h;
    }
    ctx.textBaseline = 'top'; ctx.globalAlpha = 1; ctx.lineJoin = 'miter';
  }
  // Крит: удар по открытому Регенту (×1.5 рассечения), заряженный выстрел, отражённая сфера, большой урон.
  function isCrit(d, amount) {
    return !!(d.recoverBonus || d.charged || critNext || amount >= 45);
  }

  function handleEvents(events, proj, snap, rm) {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      if (!isObj(e)) continue;
      const d = isObj(e.data) ? e.data : {};
      const at = isObj(e.position) ? proj(e.position) : null;
      switch (e.type) {
        case 'boss_hit': {
          lock.hitFlash = 1;
          const amount = num(d.amount, 0);
          const big = d.source === 'burst' || d.source === 'rune';
          const p = at && !at.behind ? at : { x: W / 2, y: H * 0.35 };
          const jx = (Math.random() - 0.5) * 30;
          if (FEEL.bigNumbers) {
            // [FEEL] крупные цифры: обычные — светлые 20–34 px, криты — золотые 34–56 px с «КРИТ!»
            const crit = isCrit(d, amount);
            const size = crit ? clamp(32 + amount * 0.22, 34, 56) : clamp(18 + amount * 0.3, 20, 34);
            addCallout(`${Math.round(amount)}`, p.x + jx, p.y - 14, crit ? CRIT : big ? GOLD_HI : '#f4ecdc', size,
              { sans: true, pop: true, label: crit ? 'КРИТ!' : '', vy: crit ? -34 : -30, dur: crit ? 1.0 : 0.8 });
            critNext = false;
            if (d.source === 'burst' && lastBurstMove && lastBurstMove.t < 0.3) {
              // множитель выброса с учётом комбо и метки: «ВЫБРОС ×2.1»
              lastBurstMove.mul *= num(d.multiplier, 1);
              lastBurstMove.text = `ВЫБРОС ×${lastBurstMove.mul.toFixed(1)}`;
            }
          } else addCallout(`-${Math.round(amount)}`, p.x + jx, p.y - 10, big ? GOLD_HI : GOLD, big ? 22 : 13);
          if (num(d.combo, 0) > combo.n) { combo.n = d.combo; combo.pop = 1; }
          break;
        }
        case 'combo_break': combo.lost = 1; combo.lostN = num(d.combo, combo.n); combo.n = 0; comboMilestone = 0; break;
        case 'player_hit': {
          hurt.t = 0;
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          if (FEEL.bigNumbers) addCallout(`−${Math.round(num(d.amount, 0))}`, p.x, p.y - 24, EMBER, clamp(24 + num(d.amount, 0) * 0.3, 26, 40), { sans: true, pop: true, vy: -22 });
          else addCallout(`-${Math.round(num(d.amount, 0))}`, p.x, p.y - 20, EMBER, 16);
          break;
        }
        case 'block': {
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          if (FEEL.legacyMoveTags) addCallout(d.ward ? 'ОБЕРЕГ' : 'БЛОК', p.x, p.y - 30, d.ward ? GOLD_HI : BLUE, 14, { scramble: true });
          if (d.ward) showMove('block', 'ОБЕРЕГ!', GOLD_HI, 'shield', { sub: 'удар поглощён' });
          else if (d.bastion) showMove('block', 'БАСТИОН!', GOLD_HI, 'shield', { sub: 'урон срезан' });
          else showMove('block', 'БЛОК!', BLUE, 'shield', { sub: d.prevented ? 'удар отражён щитом' : '' });
          break;
        }
        case 'dodge':
          if (!d.perfect) {
            const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.62 };
            if (FEEL.legacyMoveTags) addCallout('УКЛОН', p.x, p.y - 30, STEEL, 13, { scramble: true });
            showMove('dodge', 'УКЛОНЕНИЕ!', STEEL, 'dash');
          }
          break;
        case 'perfect_dodge':
          if (FEEL.legacyMoveTags || !FEEL.moves) addCallout('ИДЕАЛЬНЫЙ РЫВОК', W / 2, H * 0.3, STEEL, 30, { vy: 0, dur: 1.2, serif: false, scramble: true });
          showMove('dodge', 'ИДЕАЛЬНЫЙ РЫВОК!', CRIT, 'dash', { big: true, sub: `+${Math.round(num(d.energy, 20))} энергии` });
          break;
        case 'player_dash': dashFx = { t: 0, dir: num(d.direction, 1) >= 0 ? 1 : -1 }; showMove('dash', 'РЫВОК!', STEEL, 'dash'); break;
        // [FEEL] остальные приёмы: каждое распознанное движение — своя надпись
        case 'player_cast': {
          const ab = d.ability;
          if (ab === 'spark') showMove('spark', 'ИСКРА!', GOLD_HI, 'spark');
          else if (ab === 'bolt') { if (t - lastBoltT > 0.7) showMove('bolt', 'СНАРЯД', STEEL, 'bolt', { sub: 'держите «OK» — огонь очередью' }); lastBoltT = t; }
          else if (ab === 'throw') showMove('throw', d.kind === 'prism' ? 'ПРИЗМА!' : 'СФЕРА!', BLUE, 'orb');
          break;
        }
        case 'player_slash':
          showMove('slash', 'РАССЕЧЕНИЕ!', GOLD_HI, 'slash', { sub: d.hit ? '' : d.cut ? `сфер рассечено: ${num(d.cut, 1)}` : `мимо — подойдите ближе к ${snap && snap.mode === 'pvp' ? 'сопернику' : 'Регенту'}` });
          break;
        case 'shield_start': showMove('shield', 'ЩИТ!', BLUE, 'shield'); break;
        case 'parry':
          if (d.success) {
            if (d.projectileId) parried.set(d.projectileId, t);
            showMove('parry', 'ПАРИРОВАНО!', CRIT, 'parry', { big: true, sub: `сфера летит ${snap && snap.mode === 'pvp' ? 'в соперника' : 'в Регента'} · ×1.5` });
            flash = { t: 0, dur: 0.3, color: 'rgba(255,207,74,', a: 0.28 };
          } else showMove('parry', 'ПАРИРОВАНИЕ', DIM, 'parry', { small: true, sub: 'рано — ждите летящую сферу' });
          break;
        case 'projectile_impact':
          if (d.result === 'boss' && d.projectileId && parried.has(d.projectileId)) { critNext = true; parried.delete(d.projectileId); }
          break;
        case 'bow_release':
          if (d.rain) showMove('arrow', 'ДОЖДЬ СТРЕЛ!', GOLD_HI, 'arrow', { big: true });
          else showMove('arrow', d.charged ? 'ЗАРЯЖЕННЫЙ ВЫСТРЕЛ!' : 'ВЫСТРЕЛ!', d.charged ? CRIT : GOLD_HI, 'arrow');
          break;
        case 'hand_spell_throw': {
          const EL = { fire: 'ОГОНЬ', storm: 'ГРОЗА', frost: 'ЛЁД', earth: 'КАМЕНЬ' };
          showMove('spell', `${EL[d.element] || 'СГУСТОК'}!`, d.element === 'frost' || d.element === 'storm' ? BLUE : GOLD_HI, 'orb', { sub: d.twoHand ? 'двумя руками' : '' });
          break;
        }
        case 'sigil_cast': {   // [ASHEN_V3] печать двумя руками
          const k = d.sigil;
          flash = { t: 0, dur: 0.3, color: k === 'clap' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: k === 'clap' ? 0.3 : 0.2 };
          let sub = '';
          if (k === 'clap') sub = d.stunned ? 'РЕГЕНТ ОГЛУШЁН' : d.cleared ? `ОРБОВ ПОГАШЕНО: ${d.cleared}` : 'ВОЛНА';
          else if (k === 'gate') sub = `−${Math.round(num(d.reduction, 0.6) * 100)}% УРОНА · ${num(d.duration, 5)} с`;
          else if (k === 'frame') sub = `+${Math.round(num(d.bonus, 0.3) * 100)}% УРОНА · ${num(d.duration, 8)} с`;
          else if (k === 'delta') sub = `${num(d.ticks, 4)} УДАРА ЛУЧА${d.cleared ? ` · ОРБОВ ПОГАШЕНО: ${d.cleared}` : ''}`;
          else if (k === 'cor') sub = `+${num(d.heal, 45)} HP · ОБЕРЕГ`;
          addCallout(SIGIL_NAME[k] || String(k || ''), W / 2, H * 0.36, k === 'clap' ? BLUE : GOLD_HI, 24, { vy: -8, dur: 1.4, serif: true });
          if (sub) addCallout(sub, W / 2, H * 0.36 + 32, k === 'clap' ? BLUE : GOLD, 13, { vy: -8, dur: 1.4, scramble: true });
          break;
        }
        case 'encounter_start':   // [ASHEN_V2] вход в арену или удар издали
          flash = { t: 0, dur: 0.35, color: 'rgba(255,106,60,', a: 0.22 };
          addCallout(d.reason === 'aggro' ? 'РЕГЕНТ ПРОБУДИЛСЯ' : 'БОЙ', W / 2, H * 0.34, EMBER, 22, { vy: 0, dur: 1.4, scramble: true });
          break;
        case 'encounter_end':
          addCallout('РЕГЕНТ ЗАБЫЛ ВАС', W / 2, H * 0.34, DIM, 16, { vy: 0, dur: 1.6, scramble: true });
          break;
        case 'cruise_start': addCallout('АВТОБЕГ', W / 2, H * 0.72, EMBER, 14, { vy: -6, dur: 1.2, scramble: true }); break;
        case 'ember_lit':   // [ASHEN_V2] уголь клятвы зажжён
          flash = { t: 0, dur: 0.45, color: 'rgba(255,170,90,', a: 0.3 };
          addCallout(`УГОЛЬ КЛЯТВЫ  +${num(d.points, 3)}`, W / 2, H * 0.3, GOLD_HI, 26, { vy: -8, dur: 2.4, serif: true, scramble: false });
          if (num(d.total, 0) > 0) addCallout(`${num(d.lit, 0)} / ${num(d.total, 0)}`, W / 2, H * 0.3 + 34, EMBER, 13, { vy: -8, dur: 2.4, scramble: true });
          break;
        case 'burst': {
          flash = { t: 0, dur: 0.28, color: 'rgba(227,199,146,', a: 0.32 };
          const mul = (0.5 + num(d.power, 0.5)) * (d.both ? 1.25 : 1);
          if (FEEL.moves) {
            lastBurstMove = showMove('burst', `ВЫБРОС ×${mul.toFixed(1)}`, CRIT, 'burst', { big: true, sub: d.both ? 'двумя руками' : d.cleared ? `сфер рассеяно: ${d.cleared}` : '' });
            if (lastBurstMove) lastBurstMove.mul = mul;
          } else addCallout(`ВЫБРОС ×${(0.5 + num(d.power, 0.5)).toFixed(1)}`, W / 2, H * 0.42, GOLD_HI, 20, { vy: -10, dur: 1, scramble: true });
          break;
        }
        case 'rune_cast':
          rune = { name: RUNE_NAME[d.rune] || String(d.rune || ''), sub: RUNE_SUB[d.rune] || '', t: 0, trail: rune.trail };
          flash = { t: 0, dur: 0.3, color: d.rune === 'fulgur' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: 0.28 };
          break;
        case 'boss_stunned': lock.hitFlash = 1.5; break;
        case 'ability_denied': {
          const txt = d.reason === 'energy' ? 'НЕТ ЭНЕРГИИ' : d.reason === 'cooldown' ? (d.ability === 'rune' ? 'РУНА ПЕРЕЗАРЯЖАЕТСЯ' : 'ПЕРЕЗАРЯДКА') : '';
          if (!txt) break;
          if (FEEL.moves) {
            // [FEEL] жест понят, но приём не готов — честно и тоже крупно (не чаще раза в секунду на приём)
            const AB = { shield: 'ЩИТ', burst: 'ВЫБРОС', dash: 'РЫВОК', spark: 'ИСКРА', slash: 'РАССЕЧЕНИЕ', parry: 'ПАРИРОВАНИЕ', rune: 'РУНА', sigil: 'ПЕЧАТЬ', throw: 'БРОСОК', arrow: 'ВЫСТРЕЛ', arrow_rain: 'ДОЖДЬ СТРЕЛ', hand_orb: 'МАГИЯ' };
            const k = String(d.ability || '');
            const why = d.reason === 'energy' ? 'НЕТ ЭНЕРГИИ' : 'ПЕРЕЗАРЯДКА';   // имя приёма уже в начале надписи
            if (t - num(deniedAt[k], -9) > 1.0) { deniedAt[k] = t; showMove('deny-' + k, `${AB[k] || 'ПРИЁМ'}: ${why}`, DIM, 'deny', { small: true }); }
          } else if (d.ability !== 'shield') addCallout(txt, W / 2, H * 0.68, DIM, 12, { vy: -8, dur: 0.8 });
          break;
        }
        case 'victory': case 'defeat':
          if (FEEL.outro && !(snap && snap.mode === 'pvp')) {   // в дуэли исход раунда показывает modules/pvp.js
            const B = snap && snap.boss;
            outro = { kind: e.type, t: 0, time: num(d.time, num(snap && snap.time, 0)), bossPct: B ? Math.round(100 * num(B.hp, 0) / Math.max(1, num(B.maxHp, 1))) : 0 };
            if (e.type === 'victory') flash = { t: 0, dur: 0.6, color: 'rgba(255,207,74,', a: 0.45 };
          }
          break;
        default: break;
      }
    }
  }

  function drawLock(snap, proj, rm, dtR, intro) {
    const b = snap.boss;
    const pts = [[0, 0, 0], [0, 5.6, 0], [1.7, 2.7, 0], [-1.7, 2.7, 0], [0, 2.7, 1.7], [0, 2.7, -1.7]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true;
    for (const [dx, dy, dz] of pts) {
      const p = proj({ x: b.position.x + dx, y: b.position.y + dy, z: b.position.z + dz });
      if (!p || p.behind) { ok = false; break; }
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (!ok) { lock.ok = false; return; }
    const k = lock.ok && !rm ? 1 - Math.exp(-dtR * 14) : 1;
    lock.x0 += (x0 - lock.x0) * k; lock.x1 += (x1 - lock.x1) * k; lock.y0 += (y0 - lock.y0) * k; lock.y1 += (y1 - lock.y1) * k;
    lock.ok = true;
    const tel = snap.telegraphs && snap.telegraphs[0];
    let col = STEEL, state = '';
    if (b.stunned) { col = BLUE; state = `ОГЛУШЁН ${num(b.stunRemaining, 0).toFixed(1)} с`; }
    else if (b.action === 'windup' && tel) { col = tel.blockable ? BLUE : EMBER; state = `${KIND[tel.kind] || 'АТАКА'} ▸ ${num(tel.remaining, 0).toFixed(1)} с`; }
    else if (b.action === 'recover') { col = GOLD_HI; state = 'ОТКРЫТ ▸ БЕЙ'; }
    else if (b.action === 'dead') { col = DIM; state = 'ПОВЕРЖЕН'; }
    const pad = 10 + (b.action === 'windup' && !rm ? Math.sin(t * 18) * 2 : 0);
    const hf = lock.hitFlash;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hf > 0.05 ? '#ffffff' : col;
    ctx.globalAlpha = intro ? 0.9 : 0.8;
    brackets(lock.x0 - pad, lock.y0 - pad, lock.x1 + pad, lock.y1 + pad, 18);
    // прицел на ядре
    const core = proj({ x: b.position.x, y: b.position.y + 3.1, z: b.position.z });
    if (core && !core.behind) {
      ctx.beginPath();
      ctx.moveTo(core.x - 9, core.y); ctx.lineTo(core.x - 4, core.y); ctx.moveTo(core.x + 4, core.y); ctx.lineTo(core.x + 9, core.y);
      ctx.moveTo(core.x, core.y - 9); ctx.lineTo(core.x, core.y - 4); ctx.moveTo(core.x, core.y + 4); ctx.lineTo(core.x, core.y + 9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (intro) return;
    const p = snap.player.position;
    const dist = Math.hypot(p.x - b.position.x, p.z - b.position.z);
    const lx = lock.x1 + pad + 8, ly = Math.max(96, lock.y0 - pad);
    const engaged = !snap.player.encounter || snap.player.encounter === 'engaged';
    tag(engaged ? 'РЕГЕНТ · ЦЕЛЬ' : 'РЕГЕНТ · ВПЕРЕДИ', lx, ly, engaged ? col : DIM, `600 11px ${MONO}`);
    tag(`${dist.toFixed(1)} м · ${Math.round((b.hp / b.maxHp) * 100)}%`, lx, ly + 18, DIM);
    if (state) tag(state, lx, ly + 36, col, `600 12px ${MONO}`);
    if (b.marked) tag(`◈ МЕТКА +30% · ${num(b.markRemaining, 0).toFixed(1)} с`, lx, ly + (state ? 54 : 36), GOLD_HI, `600 11px ${MONO}`);
    lock.hitFlash = Math.max(0, lock.hitFlash - dtR * 5);
  }

  // [ASHEN_V2] угли клятвы: ромб и расстояние над алтарём; вне кадра — стрелка у края экрана.
  function drawPois(snap, proj, pois) {
    if (!Array.isArray(pois) || !pois.length) return;
    const p = snap.player.position;
    const explore = snap.player.encounter === 'explore';
    const base = ctx.globalAlpha;
    let nearest = null, nd = Infinity;
    for (const q of pois) if (isObj(q) && Number.isFinite(q.x)) { const dd = Math.hypot(q.x - p.x, q.z - p.z); if (dd < nd) { nd = dd; nearest = q; } }
    // ближайшие 8 (углей на большой карте 10): ближний всегда с меткой
    const near8 = pois.filter((q) => isObj(q) && Number.isFinite(q.x) && Number.isFinite(q.z))
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).slice(0, 8);
    for (const q of near8) {
      if (!isObj(q) || !Number.isFinite(q.x) || !Number.isFinite(q.z)) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const qy = num(q.y, 0);
      const s = proj({ x: q.x, y: qy + 2.3, z: q.z });
      ctx.globalAlpha = base * (explore ? 0.95 : 0.45);
      if (s && !s.behind && s.x > 40 && s.x < W - 40 && s.y > 90 && s.y < H - 70) {
        const r = 6 + 2 * Math.sin(t * 3 + q.x);
        ctx.strokeStyle = EMBER; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath(); ctx.stroke();
        if (q === nearest) tag(`УГОЛЬ · ${Math.round(d)} м`, s.x, s.y + 12, EMBER, `600 11px ${MONO}`, 'center');
      } else if (explore && q === nearest) {
        const c = proj({ x: q.x, y: qy + 1, z: q.z });
        if (!c) continue;
        let dx = c.x - W / 2, dy = c.y - H / 2;
        if (c.behind) { dx = -dx; dy = -dy; }
        if (Math.abs(dx) + Math.abs(dy) < 1e-3) continue;
        const ang = Math.atan2(dy, dx), mx = W / 2 - 46, my = H / 2 - 100;
        const k = Math.min(mx / Math.max(1e-6, Math.abs(Math.cos(ang))), my / Math.max(1e-6, Math.abs(Math.sin(ang))));
        const ex = W / 2 + Math.cos(ang) * k, ey = H / 2 + Math.sin(ang) * k;
        ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
        ctx.fillStyle = EMBER; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-2, 0); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
        ctx.restore();
        tag(`${Math.round(d)} м`, ex - Math.cos(ang) * 26, ey - Math.sin(ang) * 22 - 7, EMBER, `600 10px ${MONO}`, 'center');
      }
    }
    ctx.globalAlpha = base;
  }

  // [ASHEN_V4] Крупный индикатор левого джойстика внизу по центру: игрок смотрит на героя, а не на
  // крошечное превью камеры. Кольца: мёртвая зона, граница бега; точка — где рука относительно центра;
  // стрелка — куда идёт герой. Без хватки — подсказка «поднимите и замрите» с прогрессом.
  const stickFx = { dashT: 9, dashX: 0, dashY: 0, alpha: 0 };
  function drawStickHud(input, snap, dtR, rm) {
    const st = input && isObj(input.stick) ? input.stick : null;
    const want = input ? 1 : 0;
    stickFx.alpha += (want - stickFx.alpha) * (1 - Math.exp(-dtR * 8));
    if (stickFx.alpha < 0.02) return;
    const dd = input && isObj(input.dashDir) ? input.dashDir : null;
    if (dd && (num(dd.x, 0) || num(dd.z, 0))) { stickFx.dashT = 0; stickFx.dashX = num(dd.x, 0); stickFx.dashY = -num(dd.z, 0); }
    stickFx.dashT += dtR;
    if (st && st.mode === 'steer') { drawSteerHud(st, snap, rm); return; }
    const R = clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = H - R - 26;
    const A = stickFx.alpha;
    const base = ctx.globalAlpha;
    const engaged = !!(st && st.engaged);
    const running = engaged && st.gait === 'run', walking = engaged && st.gait === 'walk';
    const sprint = snap && snap.player && num(snap.player.sprint, 0) > 0.5;
    // подложка
    ctx.globalAlpha = base * A * 0.55;
    ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, Math.PI * 2); ctx.fill();
    // зоны: шаг (внутри кольца бега) и бег (снаружи)
    const rRun = R * 0.72;
    const S = st && num(st.deadzone, 0) > 0 ? st.deadzone / 0.4 : 0;
    const dzPx = st && S > 0 && num(st.runOn, 0) > 0 ? rRun * (st.deadzone / st.runOn) : R * 0.24;
    ctx.globalAlpha = base * A * (running ? 0.9 : 0.45);
    ctx.strokeStyle = sprint ? EMBER : GOLD; ctx.lineWidth = running ? 2 : 1.2;
    ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.arc(cx, cy, rRun, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = base * A * 0.5; ctx.fillStyle = 'rgba(201,164,92,0.18)';
    ctx.beginPath(); ctx.arc(cx, cy, dzPx, 0, Math.PI * 2); ctx.fill();
    // рука относительно центра
    let label = '', col = DIM;
    if (!st || !st.hand) { label = 'ЛЕВАЯ РУКА НЕ ВИДНА'; col = DIM; }
    else if (!engaged) {
      if (st.rest) { label = 'РУКА ОПУЩЕНА · ПОДНИМИТЕ И ЗАМРИТЕ'; col = DIM; }
      else if (st.grabbing) {
        label = 'ЗАМРИТЕ…'; col = GOLD_HI;
        const k = clamp(num(st.grabProgress, 0.5), 0, 1);
        ctx.globalAlpha = base * A; ctx.strokeStyle = GOLD_HI; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
      } else { label = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ И ЗАМРИТЕ'; col = GOLD; }
    } else {
      const aspect = num(st.aspect, 4 / 3);
      if (st.anchor && S > 0) {
        const ox = (st.hand.x - st.anchor.x) * aspect / S, oy = (st.hand.y - st.anchor.y) / S;
        const k = rRun / Math.max(1e-3, st.runOn / S);
        let px = ox * k, py = oy * k;
        const l = Math.hypot(px, py); if (l > R) { px *= R / l; py *= R / l; }
        ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + px, cy + py); ctx.stroke();
        ctx.globalAlpha = base * A; ctx.fillStyle = running ? GOLD_HI : walking ? BLUE : STEEL;
        ctx.beginPath(); ctx.arc(cx + px, cy + py, 5.5, 0, Math.PI * 2); ctx.fill();
      }
      const mx = num(st.x, 0), mz = num(st.z, 0), m = Math.min(1, Math.hypot(mx, mz));
      if (m > 0.01) {
        // шаг (0.2…0.6) заполняет пространство до кольца бега, бег — до края
        const ux = mx / m, uy = -mz / m, L = running ? R : dzPx + (rRun - dzPx) * clamp(m / 0.6, 0.35, 1);
        ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = running ? (sprint ? EMBER : GOLD_HI) : BLUE; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx + ux * dzPx * 0.6, cy + uy * dzPx * 0.6); ctx.lineTo(cx + ux * L, cy + uy * L); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        const ex = cx + ux * L, ey = cy + uy * L;
        ctx.beginPath(); ctx.moveTo(ex + ux * 8, ey + uy * 8); ctx.lineTo(ex - uy * 6, ey + ux * 6); ctx.lineTo(ex + uy * 6, ey - ux * 6); ctx.closePath(); ctx.fill();
      }
      label = sprint ? 'СПРИНТ' : running ? 'БЕГ' : walking ? 'ШАГ' : 'СТОИТ';
      col = sprint ? EMBER : running ? GOLD_HI : walking ? BLUE : STEEL;
      if (st.source === 'wrist') label += ' · ПО ЗАПЯСТЬЮ';
    }
    if (snap && snap.player && snap.player.cruise) { label = 'АВТОБЕГ · ПОДНИМИТЕ РУКУ — СТОП'; col = EMBER; }
    // вспышка рывка
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, l = Math.hypot(stickFx.dashX, stickFx.dashY) || 1;
      const ux = stickFx.dashX / l, uy = stickFx.dashY / l, a0 = Math.atan2(uy, ux);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = EMBER; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 6 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      label = 'РЫВОК'; col = EMBER;
    }
    ctx.globalAlpha = base * A;
    tag(label, cx, cy + R + 10, col, `600 11px ${MONO}`, 'center');
    ctx.globalAlpha = base;
  }

  // [V5] Схема «Руль» (core/steerStick.js): дуга-руль сверху — сколько герой поворачивает (серая
  // полоса в середине — мёртвая зона, точка — где сейчас рука), столбик в центре — высота левой руки
  // и ступени «ШАГ» / «БЕГ»; ниже — что делает герой и что сделать, чтобы пойти. Занимает то же место,
  // что индикатор джойстика: низ экрана по центру, ниже карточки «ОШИБКА».
  function drawSteerHud(st, snap, rm) {
    const base = ctx.globalAlpha, A = stickFx.alpha;
    const R = clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = H - 58 - R * 0.3;
    const engaged = !!st.engaged;
    const turn = engaged ? clamp(num(st.turn, num(st.x, 0)), -1, 1) : 0;
    const fwd = engaged ? clamp(num(st.fwd, num(st.z, 0)), 0, 1) : 0;
    const P = snap && snap.player;
    const sprint = engaged && P && num(P.sprint, 0) > 0.5;
    const arena = !!(P && P.encounter === 'engaged');
    const running = engaged && st.gait === 'run';
    const col = sprint ? EMBER : running ? GOLD_HI : BLUE;
    const lv = isObj(st.levels) ? st.levels : { walkOn: -0.55, walkOff: -0.72, runOn: 0.05, runOff: -0.12 };
    const tz = isObj(st.turnZone) ? st.turnZone : { dzOn: 0.2, dzOff: 0.13, full: 0.62 };
    const SPAN = 1.15, TOP = -Math.PI / 2;           // полный поворот — ±66° по дуге
    const pulse = rm ? 0.75 : 0.55 + 0.45 * Math.abs(Math.sin(t * 3.2));
    // подложка: полукруг над столбиком
    ctx.globalAlpha = base * A * 0.55; ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.arc(cx, cy, R + 12, Math.PI, 0); ctx.lineTo(cx + R + 12, cy + R * 0.3 + 4); ctx.lineTo(cx - R - 12, cy + R * 0.3 + 4); ctx.closePath(); ctx.fill();
    // дуга-руль: дорожка, мёртвая зона, заливка поворота, ручка
    ctx.lineCap = 'round';
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = STEEL; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - SPAN, TOP + SPAN); ctx.stroke();
    const dzA = SPAN * clamp(num(tz.dzOn, 0.2) / Math.max(0.05, num(tz.full, 0.62)), 0, 0.8);
    ctx.globalAlpha = base * A * 0.55; ctx.strokeStyle = 'rgba(201,164,92,0.55)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - dzA, TOP + dzA); ctx.stroke();
    if (Math.abs(turn) > 0.01) {
      ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = col; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.min(TOP, TOP + turn * SPAN), Math.max(TOP, TOP + turn * SPAN)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    const ka = TOP + turn * SPAN;
    ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? col : DIM;
    ctx.beginPath(); ctx.arc(cx + Math.cos(ka) * R, cy + Math.sin(ka) * R, engaged ? 6.5 : 5, 0, Math.PI * 2); ctx.fill();
    if (Number.isFinite(st.lateral) && st.hand) {
      // где сейчас рука по горизонтали (сырая, до мёртвой зоны и сглаживания)
      const ha = TOP + clamp(st.lateral / Math.max(0.05, num(tz.full, 0.62)), -1.25, 1.25) * SPAN;
      ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = STEEL;
      ctx.beginPath(); ctx.arc(cx + Math.cos(ha) * (R - 11), cy + Math.sin(ha) * (R - 11), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = DIM; ctx.font = `600 12px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ea = SPAN + 0.2;
    ctx.fillText('←', cx + Math.cos(TOP - ea) * (R + 2), cy + Math.sin(TOP - ea) * (R + 2));
    ctx.fillText('→', cx + Math.cos(TOP + ea) * (R + 2), cy + Math.sin(TOP + ea) * (R + 2));
    // столбик высоты руки: ниже «ШАГ» — стоп, выше «БЕГ» — бег
    const bw = 10, x0 = cx - bw / 2, yb = cy + R * 0.3 - 4, yt = cy - R * 0.66;
    const vMin = num(lv.walkOff, -0.72) - 0.6, vMax = num(lv.runOn, 0.05) + 0.45;
    const yOf = (v) => yb - (clamp(v, vMin, vMax) - vMin) / (vMax - vMin) * (yb - yt);
    const yWalk = yOf(num(lv.walkOn, -0.55)), yRun = yOf(num(lv.runOn, 0.05));
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = 'rgba(5,7,11,0.85)'; ctx.fillRect(x0, yt, bw, yb - yt);
    ctx.globalAlpha = base * A * 0.3; ctx.fillStyle = BLUE; ctx.fillRect(x0, yRun, bw, yWalk - yRun);
    ctx.fillStyle = GOLD; ctx.fillRect(x0, yt, bw, yRun - yt);
    const level = Number.isFinite(st.level) ? st.level : null;
    if (engaged) {
      const yl = level !== null ? yOf(level) : running ? yOf(num(lv.runOn, 0.05) + 0.2) : yOf(num(lv.walkOn, -0.55) + (num(lv.runOn, 0.05) - num(lv.walkOn, -0.55)) * clamp((fwd - 0.3) / 0.3, 0, 1));
      ctx.globalAlpha = base * A * 0.9; ctx.fillStyle = fwd > 0 ? col : STEEL;
      ctx.fillRect(x0 + 2, yl, bw - 4, yb - yl);
    }
    ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = STEEL; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, yt + 0.5, bw - 1, yb - yt - 1);
    // пороги: «ШАГ» пульсирует, пока рука ниже него
    const wantUp = !engaged && !!st.hand && !st.busy;
    ctx.globalAlpha = base * A * (wantUp ? pulse : 0.8); ctx.strokeStyle = wantUp ? GOLD_HI : STEEL; ctx.lineWidth = wantUp ? 2 : 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yWalk); ctx.lineTo(x0 + bw + 5, yWalk); ctx.stroke();
    ctx.globalAlpha = base * A * 0.8; ctx.strokeStyle = GOLD; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yRun); ctx.lineTo(x0 + bw + 5, yRun); ctx.stroke();
    ctx.font = `600 9px ${MONO}`; ctx.textAlign = 'left';
    ctx.globalAlpha = base * A * 0.85; ctx.fillStyle = wantUp ? GOLD_HI : STEEL; ctx.fillText('ШАГ', x0 + bw + 8, yWalk);
    ctx.fillStyle = GOLD; ctx.fillText('БЕГ', x0 + bw + 8, yRun);
    // метка руки на столбике (треугольник слева)
    if (level !== null && st.hand) {
      const yh = yOf(level);
      ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? STEEL : GOLD_HI;
      ctx.beginPath(); ctx.moveTo(x0 - 2, yh); ctx.lineTo(x0 - 10, yh - 5); ctx.lineTo(x0 - 10, yh + 5); ctx.closePath(); ctx.fill();
      if (wantUp && yh > yWalk + 8) {
        // стрелка «выше» от метки руки к порогу «ШАГ»
        const ya = rm ? 0 : (t * 14) % 6;
        ctx.globalAlpha = base * A * pulse; ctx.strokeStyle = GOLD_HI; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x0 - 14, yh - 8 - ya + 4); ctx.lineTo(x0 - 10, yh - 12 - ya); ctx.lineTo(x0 - 6, yh - 8 - ya + 4); ctx.stroke();
      }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    // подписи: что делает герой / что сделать
    let l1 = '', c1 = STEEL, l2 = '', c2 = GOLD;
    const pace = sprint ? 'СПРИНТ' : running ? 'БЕГ' : 'ШАГ';
    if (!st.hand) { l1 = 'СТОП'; c1 = DIM; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.busy || st.hold === 'cast') { l1 = 'ЧАРЫ · ГЕРОЙ СТОИТ'; c1 = STEEL; }
    else if (!engaged) { l1 = 'СТОП — РУКА ОПУЩЕНА'; c1 = STEEL; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.hold === 'shield') { l1 = Math.abs(turn) > 0.05 ? `ЩИТ · ПОВОРОТ ${turn < 0 ? '←' : '→'}` : 'ЩИТ · ГЕРОЙ СТОИТ'; c1 = BLUE; l2 = 'УБЕРИТЕ ЛАДОНЬ НАЗАД, ЧТОБЫ ИДТИ'; }
    else if (Math.abs(turn) > 0.05) { l1 = `${arena ? 'ОБХОД' : 'ПОВОРОТ'} ${turn < 0 ? '←' : '→'} · ${pace}`; c1 = col; }
    else { l1 = `${arena ? 'К РЕГЕНТУ' : 'ВПЕРЁД'} · ${pace}`; c1 = col; }
    if (engaged && st.source === 'wrist') l1 += ' · ПО ЗАПЯСТЬЮ';
    // вспышка рывка — дуга в сторону дёрга
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, a0 = Math.atan2(stickFx.dashY, stickFx.dashX);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = EMBER; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 8 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      l1 = 'РЫВОК'; c1 = EMBER;
    }
    const ly = cy + R * 0.3 + 10;
    ctx.globalAlpha = base * A;
    tag(l1, cx, ly, c1, `600 12px ${MONO}`, 'center');
    if (l2) { ctx.globalAlpha = base * A * (rm ? 0.9 : 0.65 + 0.35 * pulse); tag(l2, cx, ly + 19, c2, `600 11px ${MONO}`, 'center'); }
    ctx.globalAlpha = base;
  }

  function drawTelegraphs(snap, proj) {
    const list = Array.isArray(snap.telegraphs) ? snap.telegraphs : [];
    let yNudge = 0;
    for (const tl of list.slice(0, 4)) {
      const c = isObj(tl.center) ? tl.center : tl.kind === 'nova' ? tl.origin : tl.target;
      if (!isObj(c)) continue;
      const p = proj({ x: c.x, y: tl.kind === 'nova' ? 0.2 : 0.1, z: c.z });
      if (!p || p.behind) continue;
      const hint = tl.blockable ? (tl.kind === 'orb' ? 'ЩИТ' : 'ЩИТ / РЫВОК') : 'УЙДИ';
      const col = tl.blockable ? BLUE : EMBER;
      const x = clamp(p.x, 60, W - 200), y = clamp(p.y + 14 + yNudge, 110, H - 40);
      tag(`${tl.blockable ? '◇' : '▲'} ${KIND[tl.kind] || 'АТАКА'} ${num(tl.remaining, 0).toFixed(1)} с · ${hint}`, x, y, col, `600 12px ${MONO}`, 'center');
      yNudge += 18;
    }
  }

  // ------------------------------------------------------------------ [FEEL] телеграфы: зона и «!»
  function groundAt(layout, x, z) {
    if (!layout || typeof layout.groundY !== 'function') return 0;
    try { const g = Number(layout.groundY(x, z)); return Number.isFinite(g) ? g : 0; } catch (e) { return 0; }
  }
  // Контур на земле → путь canvas. Точки за камерой (большая НОВА накрывает и камеру) отрезаются,
  // а разрыв замыкается по нижнему краю экрана — там, ближе к камере, зона и продолжается.
  function groundPath(pts) {
    const n = pts.length;
    let start = -1;
    for (let i = 0; i < n; i++) if (pts[i] && !pts[i].behind && (!pts[(i + n - 1) % n] || pts[(i + n - 1) % n].behind)) { start = i; break; }
    ctx.beginPath();
    if (start < 0) {
      if (pts.some((q) => !q || q.behind)) return false;
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      return true;
    }
    let first = null, last = null;
    for (let j = 0; j < n; j++) {
      const q = pts[(start + j) % n];
      if (!q || q.behind) break;
      if (!first) { first = q; ctx.moveTo(q.x, q.y); } else ctx.lineTo(q.x, q.y);
      last = q;
    }
    if (!first) return false;
    const yb = H + 60;
    ctx.lineTo(clamp(last.x, -W, 2 * W), yb); ctx.lineTo(clamp(first.x, -W, 2 * W), yb);
    ctx.closePath();
    return true;
  }
  function ringPts(proj, layout, cx, cz, R, n = 44) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      out.push(proj({ x, y: groundAt(layout, x, z) + 0.04, z }));
    }
    return out;
  }
  function lanePts(proj, layout, o, e, w) {
    const dx = e.x - o.x, dz = e.z - o.z, L = Math.hypot(dx, dz) || 1, nx = -dz / L * w, nz = dx / L * w;
    const out = [];
    const N = 8;
    for (let i = 0; i <= N; i++) { const u = i / N, x = o.x + dx * u + nx, z = o.z + dz * u + nz; out.push(proj({ x, y: groundAt(layout, x, z) + 0.04, z })); }
    for (let i = N; i >= 0; i--) { const u = i / N, x = o.x + dx * u - nx, z = o.z + dz * u - nz; out.push(proj({ x, y: groundAt(layout, x, z) + 0.04, z })); }
    return out;
  }
  function telK(tl) {
    const dur = Math.max(0.05, num(tl.duration, 1)), rem = Math.max(0, num(tl.remaining, 0));
    return { dur, rem, k: clamp(1 - rem / dur, 0, 1), cue: rem <= Math.min(BOSS_CUE_SEC, dur) };
  }
  function drawGroundZones(snap, proj, layout, rm) {
    const list = Array.isArray(snap.telegraphs) ? snap.telegraphs.slice(0, 4) : [];
    // замах кончился, а сфера Регента ещё летит — подсказка держится до попадания
    const orbFlying = Array.isArray(snap.projectiles) && snap.projectiles.some((q) => isObj(q) && q.owner === 'boss');
    if (!list.length && !orbFlying) return;
    const P = snap.player && snap.player.position;
    const baseA = ctx.globalAlpha;    // на паузе HUD приглушён
    let lead = null;
    for (const tl of list) {
      if (!isObj(tl)) continue;
      const { rem, k, cue } = telK(tl);
      const pulse = rm ? 0.6 : 0.5 + 0.5 * Math.sin(t * (cue ? 20 : 9));
      const nova = tl.kind === 'nova', orb = tl.kind === 'orb';
      const c = isObj(tl.center) ? tl.center : nova ? tl.origin : tl.target;
      if (!isObj(c)) continue;
      const R = Math.max(0.3, num(tl.radius, 1));
      const shapes = [];
      if (orb) {
        const o = isObj(tl.origin) ? tl.origin : c, e = isObj(tl.pathEnd) ? tl.pathEnd : isObj(tl.target) ? tl.target : c;
        shapes.push({ pts: lanePts(proj, layout, o, e, R + 0.45), fill: 0.1 + 0.18 * k });
        const tg = isObj(tl.target) ? tl.target : e;
        shapes.push({ pts: ringPts(proj, layout, tg.x, tg.z, Math.max(0.9, R + 0.5), 28), fill: 0.14 + 0.2 * k, closing: Math.max(0.9, R + 0.5), at: tg });
      } else shapes.push({ pts: ringPts(proj, layout, c.x, c.z, R, nova ? 64 : 44), fill: (nova ? 0.05 : 0.12) + (nova ? 0.12 : 0.22) * k, closing: nova ? 0 : R, at: c });
      for (const sh of shapes) {
        if (!groundPath(sh.pts)) continue;
        ctx.globalAlpha = baseA;
        ctx.fillStyle = `rgba(255,46,30,${(sh.fill * (cue ? 1.25 + 0.35 * pulse : 1)).toFixed(3)})`;
        ctx.fill();
        ctx.lineWidth = 2.5 + 2 * k + (cue ? 1.5 * pulse : 0);
        ctx.strokeStyle = cue ? `rgba(255,${Math.round(90 + 120 * pulse)},80,1)` : 'rgba(255,59,42,0.9)';
        if (!rm) { ctx.setLineDash([14, 8]); ctx.lineDashOffset = -t * 40; }
        ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
        // сходящееся кольцо: встретит край зоны в момент удара
        if (sh.closing > 0 && k < 1) {
          const rr = sh.closing * (1 + 0.8 * (1 - k));
          if (groundPath(ringPts(proj, layout, sh.at.x, sh.at.z, rr, 36))) {
            ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(255,200,180,${(0.15 + 0.45 * k).toFixed(3)})`; ctx.stroke();
          }
        }
      }
      if (!lead || rem < telK(lead).rem) lead = tl;
    }
    // подпись у ног героя: что летит и чем ответить
    const { rem, cue } = lead ? telK(lead) : { rem: 0, cue: true };
    const { name, counter } = lead ? telegraphCounter(lead.kind, !!lead.blockable) : { name: 'СФЕРА ЛЕТИТ', counter: 'ЩИТ или ПАРИРОВАНИЕ' };
    let line = counter, col = '#ffe2d6';
    // герой уже вне круга удара / радиуса новы — честно сказать, что он в безопасности
    if (lead && lead.kind !== 'orb' && P && isObj(lead.center) && Math.hypot(P.x - lead.center.x, P.z - lead.center.z) > num(lead.radius, 2) + 0.5) { line = lead.kind === 'nova' ? 'вы вне зоны — хорошо' : 'вы вне круга — хорошо'; col = OK_GREEN; }
    const fs = Math.round(clamp(H * 0.034, 18, 30));
    ctx.font = `800 ${fs}px ${SANS}`;
    const wLine = ctx.measureText(line).width;
    ctx.font = `800 ${Math.round(fs * 0.58)}px ${SANS}`;
    const head = lead ? `${name} · ${rem.toFixed(1)} с` : name;
    const wHead = ctx.measureText(head).width;
    const bw = Math.max(wLine, wHead) + 34, bh = fs * 1.95 + 12;
    let x = hero ? hero.cx : W * 0.4, y = hero ? hero.bot + 14 : H * 0.72;
    y = clamp(y, H * 0.45, H - bh - 150);                 // выше «руля» внизу по центру
    const panelR = clamp(W * 0.27, 320, 400) + clamp(Math.min(W * 0.024, H * 0.04), 12, 40) + 14; // правый край панели героя
    x = clamp(x, Math.max(bw / 2 + 12, y + bh > H - 230 ? panelR + bw / 2 : 0), W - bw / 2 - 12);
    const sc = rm || !cue ? 1 : 1 + 0.06 * pulseAt(20);
    ctx.save();
    ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.fillStyle = 'rgba(30,4,2,0.8)';
    ctx.fillRect(-bw / 2, 0, bw, bh);
    ctx.strokeStyle = cue ? RED : 'rgba(255,59,42,0.7)'; ctx.lineWidth = cue ? 3 : 2;
    ctx.strokeRect(-bw / 2 + 0.5, 0.5, bw - 1, bh - 1);
    if (lead) { ctx.fillStyle = RED; ctx.fillRect(-bw / 2, bh - 4, bw * clamp(rem / Math.max(0.05, num(lead.duration, 1)), 0, 1), 4); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = `800 ${Math.round(fs * 0.58)}px ${SANS}`; ctx.fillStyle = '#ff8a73';
    ctx.fillText(head, 0, 6);
    ctx.font = `800 ${fs}px ${SANS}`; ctx.fillStyle = col;
    ctx.fillText(line, 0, 6 + fs * 0.72);
    ctx.restore();
    ctx.textAlign = 'left';
  }
  function pulseAt(f) { return 0.5 + 0.5 * Math.sin(t * f); }
  // «!» над Регентом за BOSS_CUE_SEC до удара: красный знак с кольцом-отсчётом.
  function drawBossCue(snap, proj, rm) {
    const list = Array.isArray(snap.telegraphs) ? snap.telegraphs : [];
    let tl = null;
    for (const q of list) if (isObj(q) && telK(q).cue && (!tl || q.remaining < tl.remaining)) tl = q;
    if (!tl || !snap.boss || snap.boss.action === 'dead') return;
    const b = snap.boss.position;
    let p = proj({ x: b.x, y: num(b.y, 0) + 6.4, z: b.z });
    if (!p || p.behind) { if (!lock.ok) return; p = { x: (lock.x0 + lock.x1) / 2, y: lock.y0 - 40 }; }
    const { rem, dur } = telK(tl);
    const cueLen = Math.min(BOSS_CUE_SEC, dur);
    const r = clamp(H * 0.042, 22, 40) * (rm ? 1 : 1 + 0.12 * pulseAt(22));
    const x = clamp(p.x, r + 8, W - r - 8), y = clamp(p.y, H * 0.13 + r, H * 0.6);
    ctx.save();
    ctx.fillStyle = 'rgba(255,59,42,0.22)';   // ореол без shadowBlur
    ctx.beginPath(); ctx.arc(x, y, r * 1.45, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = RED;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff3ea';
    ctx.beginPath(); ctx.arc(x, y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(rem / cueLen, 0, 1)); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(r * 1.5)}px ${SANS}`;
    ctx.fillText('!', x, y + r * 0.06);
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  }
  // [FEEL] финал боя поверх замедленного последнего удара (main.js держит экран боя ~1,5 с)
  function fmtClock(sec) { const v = Math.max(0, Math.round(num(sec, 0))); return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`; }
  function drawOutro(dtR, rm) {
    if (!outro.kind) return;
    outro.t += dtR;
    const T = outro.t, win = outro.kind === 'victory';
    const kIn = clamp(T / 0.35, 0, 1);
    ctx.globalAlpha = clamp(T / 0.3, 0, 1) * 0.55;
    vignette(win ? 'rgba(10,8,2,' : 'rgba(6,8,14,', '0.85', 0.25);
    ctx.globalAlpha = kIn;
    const sz = Math.round(clamp(H * (win ? 0.14 : 0.1), 48, 128) * (rm ? 1 : 1 + 0.35 * (1 - kIn) * (1 - kIn)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    ctx.font = `700 ${sz}px ${SERIF}`;
    const title = win ? 'ПОБЕДА' : 'РЕГЕНТ УСТОЯЛ';
    ctx.lineWidth = Math.max(4, sz * 0.08); ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(title, W / 2, H * 0.42);
    if (!rm && win) { ctx.shadowColor = CRIT; ctx.shadowBlur = sz * 0.4; }
    ctx.fillStyle = win ? CRIT : STEEL; ctx.fillText(title, W / 2, H * 0.42);
    ctx.shadowBlur = 0;
    const ss = Math.round(clamp(H * 0.036, 18, 32));
    ctx.font = `800 ${ss}px ${SANS}`;
    const sub = win ? `Регент повержен · время боя ${fmtClock(outro.time)}`
      : outro.bossPct <= 50 ? `у Регента осталось ${outro.bossPct}% — ещё попытка, и он падёт`
        : `у Регента осталось ${outro.bossPct}% — ещё попытка: щит и рывок спасают от ударов`;
    ctx.globalAlpha = clamp((T - 0.25) / 0.3, 0, 1);
    ctx.lineWidth = 4; ctx.strokeText(sub, W / 2, H * 0.42 + ss * 1.8);
    ctx.fillStyle = win ? GOLD_HI : STEEL; ctx.fillText(sub, W / 2, H * 0.42 + ss * 1.8);
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'miter';
  }

  function drawHero(snap, proj, input) {
    const p = snap.player.position;
    const py = num(p.y, 0);   // [FEEL] от высоты героя (рельеф большой карты, лес ниже нуля)
    const top = proj({ x: p.x, y: py + 1.95, z: p.z }), bot = proj({ x: p.x, y: py, z: p.z });
    if (!top || !bot || top.behind || bot.behind) { hero = null; return; }
    const h = Math.abs(bot.y - top.y), w = h * 0.42, cx = (top.x + bot.x) / 2;
    hero = { cx, top: Math.min(top.y, bot.y), bot: Math.max(top.y, bot.y), h }; // [FEEL] якорь надписей жестов и подписи зоны
    ctx.strokeStyle = STEEL; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    brackets(cx - w / 2, top.y, cx + w / 2, bot.y, 10);
    ctx.globalAlpha = 1;
    tag('ВЫ', cx - w / 2, top.y - 18, DIM, `10px ${MONO}`);
    if (snap.player.bastion) tag(`▣ БАСТИОН ${num(snap.player.bastionRemaining, 0).toFixed(1)} с`, cx - w / 2, top.y - 36, GOLD_HI, `600 11px ${MONO}`);
    // заряд кулака — кольцо у героя
    const ch = input ? num(input.charge, 0) : 0;
    if (ch > 0.02) {
      const r = h * 0.55;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(223,232,245,0.25)';
      ctx.beginPath(); ctx.arc(cx, (top.y + bot.y) / 2, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = ch >= 0.3 ? EMBER : GOLD;
      ctx.beginPath(); ctx.arc(cx, (top.y + bot.y) / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ch); ctx.stroke();
      tag(`ЗАРЯД ${Math.round(ch * 100)}%${ch >= 0.3 ? ' · РАСКРОЙ' : ''}`, cx, bot.y + 8, ch >= 0.3 ? EMBER : GOLD, `600 11px ${MONO}`, 'center');
    }
  }

  function drawRune(input, rm, dtR) {
    const hands = input && isObj(input.hands) ? input.hands : null;
    const trail = hands && Array.isArray(hands.trail) && hands.trail.length > 1 ? hands.trail : null;
    if (trail) rune.trail = trail;
    if (input && input.runeFizzle) fizzleT = 0;
    // область рисования: квадрат по центру экрана, 62% высоты (координаты кадра камеры 0..1)
    const S = H * 0.62, ox = W / 2 - S * 0.667, oy = H * 0.19;
    const map = (q) => [ox + q.x * S * 1.333, oy + q.y * S];
    const drawing = hands && hands.drawing;
    const tr = drawing ? trail : rune.t < 0.8 ? rune.trail : null;
    if (tr && tr.length > 1) {
      const a = drawing ? 1 : Math.max(0, 1 - rune.t / 0.8);
      for (const [w, al, c] of [[10, 0.12, GOLD], [4, 0.35, GOLD_HI], [1.6, 0.95, '#fff4dc']]) {
        ctx.lineWidth = w; ctx.strokeStyle = c; ctx.globalAlpha = al * a; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        let [x, y] = map(tr[0]); ctx.moveTo(x, y);
        for (let i = 1; i < tr.length; i++) { [x, y] = map(tr[i]); ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      if (drawing) {
        const [ex, ey] = map(tr[tr.length - 1]);
        tag('✎ РУНА', ex + 12, ey - 8, GOLD_HI, `600 12px ${MONO}`);
      }
    }
    if (rune.t < 1.6 && rune.name) {
      const k = rune.t / 1.6;
      const shown = scramble(rune.name, rune.t, rm, 0.35);
      ctx.globalAlpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
      ctx.font = `600 ${Math.round(H * 0.07)}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = GOLD_HI;
      ctx.fillText(shown, W / 2, H * 0.24);
      ctx.font = `13px ${MONO}`;
      ctx.fillStyle = STEEL;
      ctx.fillText(`РУНА · ${rune.sub}`, W / 2, H * 0.24 + H * 0.075);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    rune.t += dtR;
    if (fizzleT < 0.9 && !(coach.hint && coach.t < 1)) { tag('РУНА НЕ РАСПОЗНАНА', W / 2, H * 0.3, DIM, `600 12px ${MONO}`, 'center'); fizzleT += dtR; }
  }

  // [ТВИСТ «ОШИБКА»] карточка: что за жест, что не так и как исправить. Держится ~4 с, новая заменяет старую.
  // Стоит слева над панелью героя (центр экрана — герой и Регент — свободен): крупный заголовок ошибки,
  // пиктограмма «как сейчас → как надо» (core/coachPictograms.js) и текст исправления.
  function wrapLines(text, maxW, max = 3) {
    const words = String(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    if (lines.length > max) { lines.length = max; lines[max - 1] = lines[max - 1].replace(/[\s,.;:—-]*$/, '') + '…'; }
    return lines;
  }
  // SVG пиктограммы → Image (data: URL), вдвое крупнее для чётности на HiDPI; грузятся заранее, без вспышки.
  const picImgs = new Map();
  function picImage(code) {
    let im = picImgs.get(code);
    if (im === undefined) {
      im = null;
      try {
        const svg = typeof Image !== 'undefined' ? hintPictogram(code, { width: PIC_W * 2, height: PIC_H * 2, labels: true }) : '';
        if (svg) { im = new Image(); im.decoding = 'async'; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
      } catch (e) { im = null; }
      picImgs.set(code, im);
    }
    return im && im.complete && im.naturalWidth > 0 ? im : null;
  }
  try { for (const code of Object.keys(COACH_HINTS)) picImage(code); } catch (e) { /* без пиктограмм — только текст */ }
  // Где панель героя (DOM ui.js): карточка встаёт над ней; меряется раз в полсекунды.
  const anchor = { at: -9, x: 24, bottom: 0, w: 0 };
  function cardAnchor() {
    if (t - anchor.at < 0.5 && anchor.bottom > 0) return anchor;
    anchor.at = t;
    anchor.x = 24; anchor.bottom = H - 236; anchor.w = 0;
    try {
      const el = typeof document !== 'undefined' ? document.querySelector('.ao-hud:not([hidden]) .ao-hero') : null;
      const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (r && r.width > 40 && r.height > 20 && r.top > H * 0.35) { anchor.x = Math.max(8, r.left); anchor.bottom = r.top - 14; anchor.w = r.width; }
    } catch (e) { /* по умолчанию — над нижним левым углом */ }
    return anchor;
  }
  const HAND_NAME = { left: 'ЛЕВАЯ РУКА', right: 'ПРАВАЯ РУКА', both: 'ОБЕ РУКИ' };
  function drawCoach(cv, dtR, rm) {
    if (!isObj(cv)) return;
    if (isObj(cv.hint) && cv.hint.text && (!coach.hint || cv.hint.tMs !== coach.hint.tMs || cv.hint.code !== coach.hint.code)) {
      coach = { hint: cv.hint, t: 0 };
    }
    // точность жестов за бой — у правого края под кнопкой паузы, с полоской
    if (Number.isFinite(cv.accuracy) && num(cv.good, 0) + num(cv.mistakes, 0) >= 3) {
      const acc = cv.accuracy;
      const col = acc >= 75 ? GOLD_HI : acc >= 50 ? GOLD : EMBER;
      const bw = 150, bx = W - 24 - bw, by = 68;
      ctx.fillStyle = PLATE; ctx.fillRect(bx - 8, by - 4, bw + 16, 30);
      ctx.font = `600 13px ${MONO}`; ctx.textAlign = 'right'; ctx.fillStyle = col;
      ctx.fillText(`ТОЧНОСТЬ ЖЕСТОВ ${acc}%`, W - 24, by);
      ctx.fillStyle = 'rgba(223,232,245,0.16)'; ctx.fillRect(bx, by + 18, bw, 4);
      ctx.fillStyle = col; ctx.fillRect(bx, by + 18, bw * clamp(acc / 100, 0, 1), 4);
      ctx.textAlign = 'left';
    }
    if (!coach.hint || coach.t >= COACH_DUR) { coach.t += dtR; return; }
    const k = coach.t;
    const a = clamp(k / 0.18, 0, 1) * clamp((COACH_DUR - k) / 0.5, 0, 1);
    const h = coach.hint;
    const an = cardAnchor();
    const narrow = W < 760;
    const cw = narrow ? W - 32 : clamp(Math.max(an.w + 60, W * 0.33), 400, 500);
    const x0 = narrow ? 16 : an.x;
    const pic = picImage(h.code);
    const picW = pic ? PIC_W : 0;
    const tx = 20 + (pic ? picW + 16 : 0);       // отступ текста от левого края карточки
    ctx.font = `600 21px ${SERIF}`;
    const fix = h.fix ? String(h.fix) : '';
    const fixLines = fix ? wrapLines(fix, cw - tx - 14, 2) : [];
    ctx.font = `500 16px ${SERIF}`;
    const lines = wrapLines(h.text, cw - tx - 14, 3);
    const headH = 34;
    const bodyH = Math.max(pic ? PIC_H + 8 : 0, fixLines.length * 25 + lines.length * 20 + 6);
    const ch = headH + bodyH + 14;
    const bottom = Math.max(ch + 90, an.bottom);
    const slide = rm ? 0 : (1 - clamp(k / 0.22, 0, 1)) * -26;
    const x = x0 + slide;
    const y = Math.min(bottom - ch, H - ch - 16);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(14,6,6,0.88)';
    ctx.fillRect(x, y, cw, ch);
    // заголовок-полоса: красная подложка, пульсирующая рамка, широкая полоса слева
    ctx.fillStyle = 'rgba(255,90,74,0.16)';
    ctx.fillRect(x, y, cw, headH);
    const pulse = rm ? 0.85 : 0.6 + 0.4 * Math.abs(Math.sin(k * 5));
    ctx.strokeStyle = `rgba(255,106,60,${(0.75 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, cw - 1.5, ch - 1.5);
    ctx.fillStyle = EMBER;
    ctx.fillRect(x, y, 6, ch);
    // значок «!»
    ctx.beginPath(); ctx.arc(x + 26, y + headH / 2, 11, 0, Math.PI * 2); ctx.fillStyle = EMBER; ctx.fill();
    ctx.fillStyle = '#1a0806'; ctx.font = `800 15px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText('!', x + 26, y + headH / 2 - 8);
    ctx.textAlign = 'left';
    ctx.font = `700 15px ${MONO}`; ctx.fillStyle = '#ff8a6a';
    const head = scramble(`ОШИБКА · ${String(h.gesture || '').toUpperCase()}`, k, rm, 0.3);
    ctx.fillText(head, x + 44, y + 9);
    const hand = HAND_NAME[h.side] || HAND_NAME[h.hand] || '';
    if (hand) {
      const hw = ctx.measureText(head).width;
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = STEEL;
      const sw = ctx.measureText(hand).width;
      if (44 + hw + 18 + sw < cw - 10) { ctx.textAlign = 'right'; ctx.fillText(hand, x + cw - 12, y + 11); ctx.textAlign = 'left'; }
    }
    // тело: пиктограмма слева, справа — что исправить (крупно) и как (текст подсказки)
    const by = y + headH + 8;
    if (pic) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x + 14, by - 2, picW + 4, PIC_H + 4);
      ctx.drawImage(pic, x + 16, by, picW, PIC_H);
    }
    let ty = by + 2;
    ctx.font = `600 21px ${SERIF}`; ctx.fillStyle = GOLD_HI;
    for (const ln of fixLines) { ctx.fillText(ln, x + tx, ty); ty += 25; }
    ctx.font = `500 16px ${SERIF}`; ctx.fillStyle = STEEL;
    for (const ln of lines) { ctx.fillText(ln, x + tx, ty); ty += 20; }
    // полоска времени жизни
    ctx.fillStyle = 'rgba(255,106,60,0.55)';
    ctx.fillRect(x + 6, y + ch - 3, (cw - 6) * (1 - k / COACH_DUR), 3);
    ctx.globalAlpha = 1;
    coach.t += dtR;
  }

  function drawCombo(snap, dtR, rm) {
    const P = snap.player;
    const n = num(P.combo, 0);
    if (n < combo.n) combo.n = n;
    const x = W - 34, y = H * 0.46;
    if (FEEL.bigCombo) { if (!outro.kind) drawBigCombo(P, n, dtR, rm); return; }   // в финале — только «ПОБЕДА»
    if (n >= 2) {
      const s = 1 + (rm ? 0 : combo.pop * 0.25);
      ctx.textAlign = 'right';
      ctx.font = `600 ${Math.round(34 * s)}px ${MONO}`;
      ctx.fillStyle = GOLD_HI;
      ctx.fillText(`×${n}`, x, y);
      ctx.font = `600 11px ${MONO}`;
      ctx.fillStyle = STEEL;
      ctx.fillText(`КОМБО  ×${num(P.comboMultiplier, 1).toFixed(2)}`, x, y + 40 * s);
      const frac = clamp(num(P.comboTimer, 0) / 3, 0, 1);
      ctx.fillStyle = 'rgba(223,232,245,0.18)'; ctx.fillRect(x - 110, y + 58 * s, 110, 2);
      ctx.fillStyle = GOLD; ctx.fillRect(x - 110 * frac, y + 58 * s, 110 * frac, 2);
      ctx.textAlign = 'left';
    }
    if (combo.lost > 0.02 && combo.lostN >= 5) {
      ctx.globalAlpha = combo.lost; ctx.textAlign = 'right';
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = EMBER;
      ctx.fillText(`КОМБО СОРВАНО · ×${combo.lostN}`, x, y + 80);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    combo.pop = Math.max(0, combo.pop - dtR * 6);
    combo.lost = Math.max(0, combo.lost - dtR * 0.9);
  }

  // [FEEL] «×5 КОМБО» крупно справа по центру: число растёт с серией, на ×5/×10/×15… — вспышка и «щелчок».
  function drawBigCombo(P, n, dtR, rm) {
    const x = W - 30, y = H * 0.36;
    if (n < comboMilestone) comboMilestone = 0;   // серия обнулилась без combo_break (новый раунд дуэли)
    if (n >= 5 && n % 5 === 0 && n !== comboMilestone) { comboMilestone = n; combo.pop = 1.6; }
    if (n >= 2) {
      const tier = n >= 20 ? 3 : n >= 10 ? 2 : n >= 5 ? 1 : 0;
      const col = tier >= 3 ? EMBER : tier === 2 ? CRIT : tier === 1 ? GOLD_HI : STEEL;
      const base = clamp(H * (0.07 + 0.012 * tier), 36, 78);
      const s = rm ? 1 : 1 + Math.min(1.6, combo.pop) * 0.22;
      const sz = Math.round(base * s);
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      ctx.font = `800 ${sz}px ${SANS}`;
      ctx.lineWidth = Math.max(3, sz * 0.12); ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const num_ = `×${n}`;
      ctx.strokeText(num_, x, y + sz * 0.8);
      if (tier) {   // подсветка без shadowBlur: комбо рисуется каждый кадр, размытие тени дорогое на слабой графике
        ctx.globalAlpha *= 0.35; ctx.lineWidth = Math.max(6, sz * 0.22); ctx.strokeStyle = col;
        ctx.strokeText(num_, x, y + sz * 0.8);
        ctx.globalAlpha /= 0.35; ctx.lineWidth = Math.max(3, sz * 0.12); ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(num_, x, y + sz * 0.8);
      }
      ctx.fillStyle = col; ctx.fillText(num_, x, y + sz * 0.8);
      const ls = Math.round(clamp(base * 0.36, 15, 26));
      ctx.font = `800 ${ls}px ${SANS}`;
      ctx.lineWidth = Math.max(2, ls * 0.18);
      ctx.strokeText('КОМБО', x, y + sz * 0.8 + ls + 4);
      ctx.fillStyle = col; ctx.fillText('КОМБО', x, y + sz * 0.8 + ls + 4);
      ctx.font = `700 ${Math.round(ls * 0.62)}px ${SANS}`;
      ctx.fillStyle = STEEL;
      const yl = y + sz * 0.8 + ls * 1.75 + 6;
      ctx.lineWidth = 3; ctx.strokeText(`урон ×${num(P.comboMultiplier, 1).toFixed(2)}`, x, yl);
      ctx.fillText(`урон ×${num(P.comboMultiplier, 1).toFixed(2)}`, x, yl);
      const frac = clamp(num(P.comboTimer, 0) / 3, 0, 1), bw = 130;
      ctx.fillStyle = 'rgba(223,232,245,0.22)'; ctx.fillRect(x - bw, yl + 6, bw, 4);
      ctx.fillStyle = col; ctx.fillRect(x - bw * frac, yl + 6, bw * frac, 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'miter';
    }
    if (combo.lost > 0.02 && combo.lostN >= 5) {
      ctx.globalAlpha = combo.lost; ctx.textAlign = 'right';
      ctx.font = `800 16px ${SANS}`; ctx.fillStyle = EMBER;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(`КОМБО ПОТЕРЯНО · ×${combo.lostN}`, x, y + H * 0.17);
      ctx.fillText(`КОМБО ПОТЕРЯНО · ×${combo.lostN}`, x, y + H * 0.17);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    combo.pop = Math.max(0, combo.pop - dtR * 6);
    combo.lost = Math.max(0, combo.lost - dtR * 0.9);
  }

  function drawCallouts(dtR, rm) {
    for (let i = callouts.length - 1; i >= 0; i--) {
      const c = callouts[i];
      c.t += dtR;
      if (c.t >= c.dur) { callouts.splice(i, 1); continue; }
      c.y += c.vy * dtR;
      const a = c.t < c.dur * 0.7 ? 1 : 1 - (c.t - c.dur * 0.7) / (c.dur * 0.3);
      ctx.globalAlpha = a;
      if (c.sans) {
        // [FEEL] цифра урона: «щелчок» (крупнее → норма за 0,12 с), чёрная обводка, у крита — свечение и «КРИТ!»
        const k = clamp(c.t / 0.12, 0, 1);
        const sz = Math.round(c.size * (rm || !c.pop ? 1 : 1 + 0.5 * (1 - k) * (1 - k)));
        ctx.font = `800 ${sz}px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, sz * 0.14); ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(c.text, c.x, c.y);
        if (c.label && !rm) { ctx.shadowColor = c.color; ctx.shadowBlur = sz * 0.5; }
        ctx.fillStyle = c.color; ctx.fillText(c.text, c.x, c.y);
        ctx.shadowBlur = 0;
        if (c.label) {
          const ls = Math.round(Math.max(13, sz * 0.36));
          ctx.font = `800 ${ls}px ${SANS}`;
          ctx.lineWidth = Math.max(2, ls * 0.2); ctx.strokeText(c.label, c.x, c.y - ls - 2);
          ctx.fillStyle = c.color; ctx.fillText(c.label, c.x, c.y - ls - 2);
        }
        ctx.lineJoin = 'miter';
        continue;
      }
      ctx.font = `600 ${c.size}px ${c.serif ? SERIF : MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const txt = c.scramble ? scramble(c.text, c.t, rm, 0.3) : c.text;
      ctx.fillText(txt, c.x + 1, c.y + 1);
      ctx.fillStyle = c.color;
      ctx.fillText(txt, c.x, c.y);
    }
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  function drawScreenFx(ts, dtR, rm) {
    if (flash.t < flash.dur) { const a = (1 - flash.t / flash.dur) * flash.a; vignette(flash.color, a.toFixed(3), rm ? 0.8 : 0.2); flash.t += dtR; }
    if (hurt.t < hurt.dur) { const a = (1 - hurt.t / hurt.dur) * 0.35; vignette('rgba(255,106,60,', a.toFixed(3), 0.7); hurt.t += dtR; }
    if (ts < 0.99 && ts > 0.05) {
      vignette('rgba(120,150,200,', (0.3 * (1 - ts)).toFixed(3), 0.6);
      tag(`SLOW ×${ts.toFixed(2)}`, W / 2, 88, BLUE, `600 11px ${MONO}`, 'center');
    }
    if (dashFx.t < 0.25 && !rm) {
      const a = 1 - dashFx.t / 0.25;
      ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const y = (H * (i + 0.5)) / 14 + Math.sin(i * 7.3) * 12;
        const edge = dashFx.dir > 0 ? 0 : W;
        const len = W * (0.08 + 0.06 * ((i * 37) % 5) / 5);
        ctx.globalAlpha = a * 0.35;
        ctx.beginPath(); ctx.moveTo(edge, y); ctx.lineTo(edge + dashFx.dir * len, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    dashFx.t += dtR;
  }

  function drawIntro(intro, rm) {
    // [ONBOARD] титры размечены под интро 5 с; короткое (1,8 с) растягивается на ту же разметку
    const D0 = Math.max(1, num(intro.duration, 5)), S = D0 < 5 ? 5 / D0 : 1;
    const T = num(intro.t, 0) * S, D = D0 * S;
    const barIn = clamp(T / 0.6, 0, 1), barOut = clamp((D - T) / 0.5, 0, 1);
    const bh = H * 0.11 * Math.min(barIn, barOut);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
    if (T > 0.8 && T < D - 0.9) {
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
      ctx.fillText(scramble('ЦЕЛЬ ОБНАРУЖЕНА', T - 0.8, rm), W / 2, bh + 26);
    }
    if (T > 1.6 && T < D - 0.6) {
      const a = clamp((T - 1.6) / 0.4, 0, 1) * clamp((D - 0.6 - T) / 0.4, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = `600 ${Math.round(H * 0.06)}px ${SERIF}`; ctx.fillStyle = GOLD_HI; ctx.textAlign = 'center';
      ctx.fillText(scramble('РЕГЕНТ НИМБА', T - 1.6, rm, 0.8), W / 2, H - bh - H * 0.2);
      ctx.font = `12px ${MONO}`; ctx.fillStyle = DIM;
      ctx.fillText('x:0.0 z:0.0 · h 7.4m · УКРАДЕННОЕ СОЛНЦЕ', W / 2, H - bh - H * 0.2 + Math.round(H * 0.06) + 12);
      ctx.globalAlpha = 1;
    }
    if (T > D - 0.9) {
      const k = (T - (D - 0.9)) / 0.9;
      ctx.globalAlpha = 1 - k;
      ctx.font = `600 ${Math.round(H * 0.08)}px ${SERIF}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
      ctx.fillText('К БОЮ', W / 2, H * 0.52);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }

  function drawResume(ms) {
    const n = Math.ceil(ms / 334);
    ctx.font = `600 ${Math.round(H * 0.09)}px ${SERIF}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
    ctx.globalAlpha = 0.9;
    ctx.fillText(String(clamp(n, 1, 3)), W / 2, H * 0.5);
    ctx.font = `12px ${MONO}`; ctx.fillStyle = DIM;
    ctx.fillText('опустите руки · бой продолжится', W / 2, H * 0.5 + 30);
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  // ------------------------------------------------------------------ [W3-ULT] «Ярость клятвы» и «Небесный суд»
  // Шкала внизу по центру (между панелью героя и превью камеры). Полная — пульсирует, крупный зов
  // «ПОДНИМИ ОБЕ РУКИ!» с фигуркой и кольцом удержания. Сцена: чёрные полосы, вспышка, титр.
  const ult = { shown: 0, gainT: 9, readyT: -1, wasReady: false, denyT: 9, cineT: -1 };
  function ultEvents(events) {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      if (!e) continue;
      if (e.type === 'ultimate_ready') { ult.readyT = 0; flash = { t: 0, dur: 0.5, color: 'rgba(255,207,74,', a: 0.35 }; }
      else if (e.type === 'boss_hit' && !(e.data && e.data.source === 'ultimate')) ult.gainT = 0;
      else if (e.type === 'perfect_dodge' || (e.type === 'parry' && e.data && e.data.success)) ult.gainT = 0;
      else if (e.type === 'ability_denied' && e.data && e.data.ability === 'ultimate') ult.denyT = 0;
    }
  }
  function furyBox() {
    const w = clamp(W * 0.3, 200, 430), h = clamp(H * 0.016, 9, 14);
    return { x: W / 2 - w / 2, y: H - clamp(H * 0.06, 30, 54), w, h };
  }
  function drawFury(snap, U, dtR, rm) {
    const P = snap.player;
    if (!P || !Number.isFinite(P.fury) || snap.mode === 'pvp') return;
    const max = Math.max(1, num(P.furyMax, 100)), v = clamp(P.fury / max, 0, 1), ready = !!P.furyReady;
    ult.shown += (v - ult.shown) * (1 - Math.exp(-(v < ult.shown ? 14 : 6) * dtR));
    if (Math.abs(v - ult.shown) < 0.002) ult.shown = v;
    ult.gainT += dtR;
    if (ult.readyT >= 0) ult.readyT += dtR;
    const B = furyBox(), pulse = ready ? (rm ? 0.6 : 0.5 + 0.5 * Math.sin(t * 6.5)) : 0;
    // подложка
    ctx.fillStyle = 'rgba(5,7,11,0.72)';
    ctx.fillRect(B.x - 6, B.y - 20, B.w + 12, B.h + 26);
    ctx.strokeStyle = ready ? `rgba(255,207,74,${0.55 + 0.45 * pulse})` : 'rgba(201,164,92,0.55)';
    ctx.lineWidth = ready ? 2 : 1;
    ctx.strokeRect(B.x - 6 + 0.5, B.y - 20 + 0.5, B.w + 12, B.h + 26);
    // подписи
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${Math.round(clamp(H * 0.017, 11, 14))}px ${SANS}`;
    ctx.fillStyle = ready ? CRIT : GOLD_HI; ctx.textAlign = 'left';
    ctx.fillText(ready ? 'НЕБЕСНЫЙ СУД ГОТОВ' : 'ЯРОСТЬ КЛЯТВЫ', B.x, B.y - 6);
    ctx.textAlign = 'right'; ctx.fillStyle = ready ? CRIT : STEEL;
    ctx.fillText(`${Math.floor(v * 100)}%`, B.x + B.w, B.y - 6);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    // полоса
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(B.x, B.y, B.w, B.h);
    const fw = B.w * ult.shown;
    if (fw > 0.5) {
      const g = ctx.createLinearGradient(B.x, 0, B.x + B.w, 0);
      g.addColorStop(0, '#a3241a'); g.addColorStop(0.55, EMBER); g.addColorStop(1, CRIT);
      ctx.fillStyle = g;
      if (ready && !rm) { ctx.shadowColor = CRIT; ctx.shadowBlur = 10 + 14 * pulse; }
      ctx.fillRect(B.x, B.y, fw, B.h);
      ctx.shadowBlur = 0;
      // блик прироста и пульс полной шкалы
      const gl = ready ? 0.25 + 0.35 * pulse : clamp(1 - ult.gainT / 0.35, 0, 1) * 0.45;
      if (gl > 0.01) { ctx.fillStyle = `rgba(255,246,224,${gl.toFixed(3)})`; ctx.fillRect(B.x, B.y, fw, B.h); }
    }
    ctx.fillStyle = 'rgba(5,7,11,0.6)';
    for (let i = 1; i < 4; i++) ctx.fillRect(Math.round(B.x + B.w * i / 4), B.y, 1, B.h);
    if (ult.denyT < 1.2) {
      ult.denyT += dtR;
      ctx.globalAlpha = clamp(1.2 - ult.denyT, 0, 1);
      tag('ПОДОЙДИ К РЕГЕНТУ — СУД БЬЁТ В АРЕНЕ', W / 2, B.y - 44, STEEL, `600 12px ${MONO}`, 'center');
      ctx.globalAlpha = 1;
    }
  }
  // фигурка «обе руки вверх»: k — 0..1 насколько подняты руки (анимация подсказки)
  function drawRaiseGlyph(cx, cy, sz, k, color) {
    const sw = sz * 0.36, shY = cy - sz * 0.05, hy = shY - sz * 0.2;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, sz * 0.09);
    ctx.beginPath(); ctx.arc(cx, hy, sz * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - sw / 2, shY); ctx.lineTo(cx + sw / 2, shY); ctx.lineTo(cx + sw * 0.32, shY + sz * 0.42); ctx.lineTo(cx - sw * 0.32, shY + sz * 0.42); ctx.closePath(); ctx.fill();
    for (const sg of [-1, 1]) {
      const a = (Math.PI / 2) * (1 - k) + 0.12;          // от «руки вниз» к «руки вверх»
      const ex = cx + sg * (sw / 2 + Math.sin(a) * sz * 0.2), ey = shY - Math.cos(a) * sz * 0.22 + sz * 0.02;
      const wx = cx + sg * (sw / 2 + Math.sin(a) * sz * 0.27 - k * sz * 0.06), wy = shY - Math.cos(a) * sz * 0.5;
      ctx.beginPath(); ctx.moveTo(cx + sg * sw / 2, shY + 1); ctx.lineTo(ex, ey); ctx.lineTo(wx, wy); ctx.stroke();
    }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  }
  function drawUltCall(snap, U, dtR, rm) {
    const P = snap.player;
    if (!P || !P.furyReady || snap.mode === 'pvp') { ult.wasReady = false; return; }
    if (!ult.wasReady) { ult.wasReady = true; if (ult.readyT < 0) ult.readyT = 0; }
    const age = Math.max(0, ult.readyT), g = isObj(U.gesture) ? U.gesture : null;
    const holding = g && g.phase === 'hold', one = g && g.phase === 'one';
    const kIn = rm ? 1 : clamp(age / 0.3, 0, 1);
    const big = age < 5 || holding || one;
    const base = clamp(H * (big ? 0.068 : 0.048), 24, big ? 66 : 46);
    const sc = rm ? 1 : (1 + 0.45 * (1 - kIn) * (1 - kIn)) * (holding ? 1 : 1 + 0.035 * Math.sin(t * 6.5));
    let sz = Math.round(base * sc);
    const cy = H * (big ? 0.31 : 0.24);
    const title = U.debug ? 'НАЖМИ U — НЕБЕСНЫЙ СУД' : holding ? 'ДЕРЖИ!' : 'ПОДНИМИ ОБЕ РУКИ!';
    ctx.globalAlpha = kIn;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    ctx.font = `800 ${sz}px ${SANS}`;
    // не шире 56 % кадра: по краям — панели жестов и камеры (узкие окна, режим презентации)
    const tw = ctx.measureText(title).width, maxW = W * 0.56;
    if (tw > maxW) { sz = Math.max(16, Math.floor(sz * maxW / tw)); ctx.font = `800 ${sz}px ${SANS}`; }
    // фигурка над надписью (по центру — не заходит на панели по краям); при удержании — кольцо прогресса вокруг неё
    const gs = base * 1.35, gx = W / 2, gy = cy - sz * 0.95 - gs * 0.62;
    if (!U.debug) {
      const k = holding ? 1 : rm ? 1 : 0.5 + 0.5 * Math.sin(t * 3.2);
      drawRaiseGlyph(gx, gy, gs, k, holding ? CRIT : GOLD_HI);
      const pr = holding ? clamp(num(g.progress, 0), 0, 1) : 0;
      ctx.lineWidth = Math.max(3, gs * 0.07);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.arc(gx, gy, gs * 0.62, 0, Math.PI * 2); ctx.stroke();
      if (pr > 0) {
        ctx.strokeStyle = CRIT;
        if (!rm) { ctx.shadowColor = CRIT; ctx.shadowBlur = 14; }
        ctx.beginPath(); ctx.arc(gx, gy, gs * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr); ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    ctx.lineWidth = Math.max(4, sz * 0.1); ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(title, W / 2, cy);
    if (!rm) { ctx.shadowColor = CRIT; ctx.shadowBlur = sz * (0.35 + 0.25 * Math.sin(t * 6.5)); }
    ctx.fillStyle = holding ? '#fff3cf' : CRIT; ctx.fillText(title, W / 2, cy);
    ctx.shadowBlur = 0;
    const ss = Math.round(clamp(sz * 0.36, 13, 24));
    ctx.font = `700 ${ss}px ${SANS}`;
    const sub = U.debug ? 'или обе руки над головой перед камерой'
      : holding ? 'не опускай — меч уже падает с неба'
        : one ? 'ещё одну руку — вверх, локти выше плеч'
          : 'и держи секунду — с неба упадёт меч из света';
    ctx.lineWidth = Math.max(3, ss * 0.22); ctx.strokeText(sub, W / 2, cy + ss * 1.45);
    ctx.fillStyle = GOLD_HI; ctx.fillText(sub, W / 2, cy + ss * 1.45);
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'miter';
  }
  function drawUltCine(U, dtR, rm) {
    const c = U.cine;
    const T = num(c.t, 0), D = Math.max(0.5, num(c.dur, 3.6)), S = num(c.strikeAt, 2.3);
    // чёрные полосы сверху и снизу
    const k = Math.min(clamp(T / 0.35, 0, 1), clamp((D - T) / 0.5, 0, 1));
    const e = k * k * (3 - 2 * k), bh = H * 0.12 * e;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    // до удара: подпись в верхней полосе
    if (T < S && bh > 12) {
      ctx.globalAlpha = clamp((T - 0.3) / 0.3, 0, 1) * e;
      ctx.font = `600 ${Math.round(clamp(H * 0.02, 11, 16))}px ${MONO}`; ctx.fillStyle = GOLD_HI;
      ctx.fillText(scramble('КЛЯТВА ВЗЫВАЕТ К НЕБУ', T - 0.3, rm, 0.6), W / 2, bh * 0.66);
    }
    // вспышка удара (если её не дала постобработка)
    const u = T - S;
    if (u >= 0 && u < 0.28 && !U.flash) {
      ctx.globalAlpha = (1 - u / 0.28) * (rm ? 0.2 : 0.45);
      ctx.fillStyle = '#fff6e0'; ctx.fillRect(0, 0, W, H);
    }
    // титр «НЕБЕСНЫЙ СУД»
    if (u >= 0.05) {
      const kIn = clamp((u - 0.05) / 0.25, 0, 1), kOut = clamp((D - T) / 0.4, 0, 1);
      ctx.globalAlpha = kIn * kOut;
      const sz = Math.round(clamp(H * 0.11, 44, 124) * (rm ? 1 : 1 + 0.5 * (1 - kIn) * (1 - kIn)));
      ctx.font = `700 ${sz}px ${SERIF}`;
      const y = bh + sz * 1.05;   // сверху, под полосой: цифра урона всплывает над Регентом в центре
      ctx.lineWidth = Math.max(4, sz * 0.08); ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText('НЕБЕСНЫЙ СУД', W / 2, y);
      if (!rm) { ctx.shadowColor = CRIT; ctx.shadowBlur = sz * 0.45; }
      ctx.fillStyle = CRIT; ctx.fillText('НЕБЕСНЫЙ СУД', W / 2, y);
      ctx.shadowBlur = 0;
      if (num(c.amount, 0) > 0) {
        const ss = Math.round(clamp(H * 0.03, 15, 28));
        ctx.font = `800 ${ss}px ${SANS}`;
        const sub = `урон ${Math.round(c.amount)} · ${Math.round(num(c.pct, 0))}% здоровья Регента`;
        ctx.lineWidth = 4; ctx.strokeText(sub, W / 2, y + ss * 1.5);
        ctx.fillStyle = GOLD_HI; ctx.fillText(sub, W / 2, y + ss * 1.5);
      }
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'miter';
  }

  function frame(f) {
    if (disposed) return;
    if (bdo) { try { bdo.frame(f); } catch (e) { console.warn('[battleHud] bdoHud.frame', e); bdo = null; } } // [BDO]
    try {
      const vp = isObj(f.viewport) ? f.viewport : { w: canvas.clientWidth, h: canvas.clientHeight };
      resize(vp.w, vp.h);
      const screen = f.screen;
      const active = screen === 'playing' || screen === 'paused' || screen === 'intro';
      if (!active || !isObj(f.snapshot) || typeof f.project !== 'function') { if (drawn) clearAll(); lastScreen = screen; return; }
      if (screen === 'playing' && lastScreen !== 'playing') playingSince = t;
      lastScreen = screen;
      const rm = !!(f.settings && f.settings.reducedMotion);
      const paused = screen === 'paused';
      const dtR = paused ? 0 : clamp(num(f.dtReal, 0), 0, 0.25);
      t += dtR;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      drawn = true;
      const proj = (p) => { try { return f.project(p); } catch (e) { return null; } };
      const snap = f.snapshot;
      if (!paused) handleEvents(f.events, proj, snap, rm);
      if (!paused) ultEvents(f.events);   // [W3-ULT]
      const U = isObj(f.ult) ? f.ult : null, cine = !!(U && isObj(U.cine));   // [W3-ULT] сцена: кадр без прицелов и подсказок
      if (screen === 'intro') {
        drawLock(snap, proj, rm, dtR, true);
        drawIntro(isObj(f.intro) ? f.intro : { t: 0, duration: 5 }, rm);
        return;
      }
      if (paused) ctx.globalAlpha = 0.6;
      const over = snap.status === 'victory' || snap.status === 'defeat'; // [FEEL] финал: только удар, цифры и надпись
      if (FEEL.groundZones && !over && !cine) drawGroundZones(snap, proj, f.layout, rm);
      if (paused) ctx.globalAlpha = 0.6;
      if (!cine) drawLock(snap, proj, rm, dtR, false);
      if (!cine) drawPois(snap, proj, f.pois);
      if (FEEL.legacyTeleTags || !FEEL.groundZones) drawTelegraphs(snap, proj);
      if (!cine) drawHero(snap, proj, f.input);
      if (FEEL.bossCue && !over && !cine) drawBossCue(snap, proj, rm);
      if (!paused && !over && !cine) drawStickHud(f.input, snap, dtR, rm);
      drawCombo(snap, dtR, rm);
      drawRune(f.input, rm, dtR);
      if (!over && !cine) drawCoach(f.coach, dtR, rm);
      if (U && !over && !cine) { drawFury(snap, U, dtR, rm); if (!paused) drawUltCall(snap, U, dtR, rm); }   // [W3-ULT]
      drawCallouts(dtR, rm);
      if (!cine) drawMoves(dtR, rm);
      if (cine) drawUltCine(U, dtR, rm);   // [W3-ULT] полосы, вспышка, титр
      drawScreenFx(over || cine ? 1 : num(f.timeScale, 1), dtR, rm);   // [W3-ULT] в сцене без «SLOW ×»
      if (FEEL.outro) drawOutro(dtR, rm);
      if (num(f.resumeLeftMs, 0) > 0) drawResume(f.resumeLeftMs);
      if (t - playingSince < 1.2 && playingSince >= 0) {
        ctx.globalAlpha = 1 - (t - playingSince) / 1.2;
        const explore = snap.player && snap.player.encounter === 'explore';
        tag(explore ? 'ПЛАТО · ИДИТЕ К РЕГЕНТУ' : 'БОЙ', W / 2, H * 0.36, GOLD_HI, `600 14px ${MONO}`, 'center');
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
    } catch (e) {
      try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; } catch (e2) { /* ignore */ }
    }
  }

  function reset() {
    callouts.length = 0;
    combo = { n: 0, shown: 0, pop: 0, lost: 0, lostN: 0 };
    rune = { name: '', sub: '', t: 9, trail: null };
    flash.t = 1; hurt.t = 1; dashFx.t = 1; fizzleT = 9; coach = { hint: null, t: 9 }; lock.ok = false; lock.hitFlash = 0;
    moves.length = 0; parried.clear(); critNext = false; lastBurstMove = null; lastBoltT = -9; hero = null; comboMilestone = 0; // [FEEL]
    outro = { kind: '', t: 0, time: 0, bossPct: 0 };
    ult.shown = 0; ult.gainT = 9; ult.readyT = -1; ult.wasReady = false; ult.denyT = 9;   // [W3-ULT]
    for (const k of Object.keys(deniedAt)) delete deniedAt[k];
    if (bdo) { try { bdo.reset(); } catch (e) { /* ignore */ } } // [BDO]
  }
  function dispose() { disposed = true; clearAll(); if (bdo) { try { bdo.dispose(); } catch (e) { /* ignore */ } } }
  return { frame, reset, dispose };
}
