// ASHEN OATH — боевой трекинг-HUD поверх 3D-сцены (2D canvas). Владелец: №1.
// «Tracking edit»: захват цели на страже, метки атак с таймером, комбо, выноски урона,
// руна, нарисованная пальцем, прямо на экране, замедление времени, интро.
// Ничего не импортирует, свой rAF не запускает: main.js вызывает frame() каждый кадр.
//
// frame(f): f = { dtReal, timeScale, screen, snapshot, events, input, project(p)->{x,y,behind},
//   viewport:{w,h}, intro:{active,t,duration}, settings:{reducedMotion}, resumeLeftMs,
//   pois:[{id,x,y,z}] — [ASHEN_V2] незажжённые угли клятвы (метка над алтарём или стрелка у края),
//   coach:{hint:{code,gesture,text,side}|null, accuracy, good, mistakes} — [ТВИСТ «ОШИБКА»] подсказка к
//   почти-правильному жесту (карточка внизу по центру) и точность жестов за бой }

const MONO = '"Consolas","Cascadia Mono",monospace';
const SERIF = '"Palatino Linotype","Book Antiqua",Georgia,serif';
const GOLD = '#c9a45c', GOLD_HI = '#e3c792', STEEL = '#dfe8f5', BLUE = '#9fc4ff', EMBER = '#ff6a3c', DIM = '#8d97a6';
const PLATE = 'rgba(5,7,11,0.62)';
const GLYPHS = '0123456789ABCDEFXZ#%+=/<>';
const RUNE_NAME = { ignis: 'ИГНИС', fulgur: 'ФУЛЬГУР', orbis: 'ОРБИС', stella: 'СТЕЛЛА', spira: 'СПИРА', lemnis: 'ЛЕМНИСКА', caret: 'АКУС', vee: 'МЕССИС', clepsydra: 'КЛЕПСИДРА', alpha: 'АЛЬФА' };
const RUNE_SUB = { ignis: 'огненное копьё', fulgur: 'страж оглушён', orbis: 'лечение и оберег', stella: 'звездопад', spira: 'вихрь гасит сферы', lemnis: 'вечность: лечение', caret: 'залп игл', vee: 'жатва', clepsydra: 'время Регента замедлено', alpha: 'откаты сброшены' };
const KIND = { slam: 'SLAM', orb: 'ORB', nova: 'NOVA' };
// [ASHEN_V3] двуручные печати
const SIGIL_NAME = { clap: 'ГРОМОВОЙ ХЛОПОК', gate: 'ВРАТА · БАСТИОН', frame: 'МЕТКА ЦЕЛИ', delta: 'ДЕЛЬТА · ЛУЧ', cor: 'КОР · СЕРДЦЕ' };

import { createBdoHud } from './bdoHud.js'; // [BDO] DOM-слой HUD в стиле Black Desert
import { BDO, isBdo, font as bdoFont, panel as bdoPanel, chamferPath, preloadFonts } from './bdoTheme.js'; // [BDO] палитра, шрифты, панели

// [BDO] Стиль Black Desert для canvas-слоя (settings.bdoUi !== false): золотые уголки захвата,
// цифры урона Cinzel с обводкой, титры рун/печатей Forum с гаснущими линиями, медальон движения
// левой руки по центру нижней полосы HUD. Без bdoUi — прежний «tracking edit» без изменений.
const TAU = Math.PI * 2;
const ITALIC = "'Cormorant Garamond', 'Palatino Linotype', 'Book Antiqua', Georgia, serif";
const RUNE_SUB_B = { ignis: 'огненное копьё', fulgur: 'страж оглушён', orbis: 'лечение и оберег', stella: 'звездопад', spira: 'вихрь гасит сферы', lemnis: 'вечность · лечение', caret: 'залп игл', vee: 'жатва', clepsydra: 'время Регента замедлено', alpha: 'откаты сброшены' };
const KIND_B = { slam: 'УДАР', orb: 'СФЕРА', nova: 'НОВА' };
const TELE_B = { slam: ['УДАР · ЩИТ / РЫВОК', 'УДАР · УЙДИТЕ'], orb: ['СФЕРА · ЩИТ', 'СФЕРА · УЙДИТЕ'], nova: ['НОВА · ЩИТ / РЫВОК', 'НОВА · УЙДИТЕ'] };
const LOCK_BOSS = [[0, 0, 0], [0, 5.6, 0], [1.7, 2.7, 0], [-1.7, 2.7, 0], [0, 2.7, 1.7], [0, 2.7, -1.7]];
const LOCK_HERO = [[0, 0, 0], [0, 1.95, 0], [0.55, 1, 0], [-0.55, 1, 0], [0, 1, 0.55], [0, 1, -0.55]];

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
  const COACH_DUR = 4.2;
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
    callouts.push({ text, x, y, vy: opts.vy ?? -26, t: 0, dur: opts.dur ?? 0.9, color, size, serif: !!opts.serif, scramble: !!opts.scramble });
  }
  function vignette(color, a, inner = 0.55) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * inner * 0.5, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, color + '0)');
    g.addColorStop(1, color + a + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ---------------------------------------------------------------- [BDO] помощники стиля Black Desert
  let B = false;                 // [BDO] стиль включён в этом кадре (isBdo(f.settings))
  let bdoOk = true;              // [BDO] false после ошибки в BDO-ветке → прежний вид
  let lowQ = false;              // [BDO] settings.quality === 'low' → без размытых теней
  let band = 108;                // [BDO] высота нижней полосы HUD: clamp(92, 0.14H, 128)
  let uiK = 1;                   // [BDO] масштаб от эталона 1366×768
  let rmNow = false;             // [BDO] settings.reducedMotion текущего кадра
  const mPoi = { v: NaN, s: '' }, mPoiE = { v: NaN, s: '' };
  const hasLS = 'letterSpacing' in ctx;
  try {
    preloadFonts();
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
      for (const s of ["700 16px 'Cinzel'", "italic 500 16px 'Cormorant Garamond'", "500 16px 'Alegreya Sans'"]) document.fonts.load(s).catch(() => {});
    }
  } catch (e) { /* без веб-шрифтов — системная антиква */ }
  const FC = {};
  // кэш строк шрифта по числовому ключу — в кадре новых строк не создаёт
  function F(kind, px, w = 400) {
    px = px < 6 ? 6 : Math.round(px);
    const k = (kind === 'num' ? 1 : kind === 'body' ? 2 : kind === 'italic' ? 3 : 0) * 1e7 + px * 1000 + w;
    return FC[k] || (FC[k] = kind === 'italic' ? `italic ${w} ${px}px ${ITALIC}` : bdoFont(kind, px, w));
  }
  // градиенты кэшируются и сбрасываются при смене размера экрана
  const GC = { W: 0, H: 0, rule: null, ruleBlood: null, txt: {}, disc: null, discR: 0, vig: [] };
  function gcCheck() { if (GC.W !== W || GC.H !== H) { GC.W = W; GC.H = H; GC.txt = {}; GC.disc = null; GC.vig.length = 0; TW.clear(); } }
  // вертикальный градиент текста высотой s, центр в 0 (рисовать после translate к центру строки)
  const TXT_STOPS = {
    gold: ['#fff1c4', BDO.goldHi, BDO.gold, BDO.goldDeep],
    ivory: ['#fffaf0', '#f4ead2', BDO.ivory, '#cdb487'],
    ember: ['#fff0b8', '#ffd27a', '#ffa94a', '#e8651e'],
    blood: ['#ffc2b4', '#ff7a6e', BDO.bloodHi, '#9a1a1e'],
    mana: ['#eef6ff', '#bcd8ff', BDO.manaHi, BDO.mana],
  };
  const TONE_I = { gold: 0, ivory: 1, ember: 2, blood: 3, mana: 4 };
  function tgrad(tone, s) {
    s = Math.round(s);
    const k = (TONE_I[tone] || 0) * 10000 + s;   // числовой ключ — без строк в кадре
    let g = GC.txt[k];
    if (!g) {
      const st = TXT_STOPS[tone] || TXT_STOPS.gold;
      g = ctx.createLinearGradient(0, -s * 0.42, 0, s * 0.42);
      g.addColorStop(0, st[0]); g.addColorStop(0.35, st[1]); g.addColorStop(0.62, st[2]); g.addColorStop(1, st[3]);
      GC.txt[k] = g;
    }
    return g;
  }
  // тонкая линия, гаснущая к краям (как fadeRule из bdoTheme, но без нового градиента в кадре)
  function rule(cx, y, w, a, blood) {
    if (w < 2 || a <= 0.01) return;
    let g = blood ? GC.ruleBlood : GC.rule;
    if (!g) {
      g = ctx.createLinearGradient(-0.5, 0, 0.5, 0);
      const c0 = blood ? 'rgba(224,72,74,0)' : 'rgba(216,179,106,0)', c1 = blood ? 'rgba(224,72,74,1)' : 'rgba(216,179,106,1)';
      g.addColorStop(0, c0); g.addColorStop(0.5, c1); g.addColorStop(1, c0);
      if (blood) GC.ruleBlood = g; else GC.rule = g;
    }
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(cx, Math.round(y)); ctx.scale(w, 1);
    ctx.fillStyle = g; ctx.fillRect(-0.5, 0, 1, 1); ctx.restore();
  }
  function diamond(x, y, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
  }
  // текст с тёмной обводкой (дешевле размытой тени); baseline задаёт вызывающий
  function txt(s, x, y, color, fnt, align, a, outline) {
    if (!s) return;
    const ga = ctx.globalAlpha;
    if (a !== undefined) ctx.globalAlpha = ga * a;
    ctx.font = fnt; ctx.textAlign = align || 'center';
    const ow = outline === undefined ? 3 : outline;
    if (ow > 0) { ctx.lineJoin = 'round'; ctx.lineWidth = ow; ctx.strokeStyle = 'rgba(6,4,3,0.85)'; ctx.strokeText(s, x, y); }
    ctx.fillStyle = color; ctx.fillText(s, x, y);
    ctx.globalAlpha = ga;
  }
  // ширина строки (кэш по тексту; сброс при смене размера экрана — шрифты зависят от uiK)
  const TW = new Map();
  function tw(s, fnt) {
    let w = TW.get(s);
    if (w === undefined) { ctx.font = fnt; w = ctx.measureText(s).width; TW.set(s, w); }
    return w;
  }
  // строка с числом: пересобирается только при смене значения
  function memo(m, v, pre, suf, dig) {
    if (m.v !== v) { m.v = v; m.s = pre + (dig ? v.toFixed(dig) : String(v)) + suf; }
    return m.s;
  }
  const _pp = { x: 0, y: 0, z: 0 };   // переиспользуемая точка для project()
  function P3(proj, x, y, z) { _pp.x = x; _pp.y = y; _pp.z = z; return proj(_pp); }
  // виньетка из кэша: цвет-префикс 'rgba(r,g,b,' как у vignette(), сила — через globalAlpha
  function vignetteB(color, a, inner) {
    let g = null;
    for (let i = 0; i < GC.vig.length; i++) { const v = GC.vig[i]; if (v.c === color && v.inner === inner) { g = v.g; break; } }
    if (!g) {
      g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * inner * 0.5, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, color + '0)'); g.addColorStop(1, color + '1)');
      GC.vig.push({ c: color, inner, g });
    }
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * clamp(a, 0, 1); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = ga;
  }
  // [BDO] центральный титр: руна, печать, выброс, идеальный уклон (новый заменяет старый, если важнее)
  const banner = { t: 9, dur: 1.8, title: '', sub: '', pri: 0, tone: 'gold', small: false };
  function setBanner(title, sub, pri, dur, tone, small) {
    if (banner.t < 0.7 && banner.pri > pri) return;
    banner.title = title; banner.sub = sub || ''; banner.pri = pri; banner.dur = dur || 1.8; banner.tone = tone || 'gold'; banner.small = !!small; banner.t = 0;
  }
  // [BDO] выноски урона: 1 — обычный, 2 — сильный (руна/выброс/крит), 3 — входящий, 4 — слово (БЛОК, УКЛОН…)
  function addCalloutB(text, x, y, kind, color) {
    if (callouts.length >= MAX_CALLOUTS) callouts.shift();
    const size = Math.round((kind === 2 ? 36 : kind === 3 ? 27 : kind === 4 ? 22 : 24) * uiK);
    // стопка без наложений: поднимаем новую выноску над свежими соседями
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      for (let i = 0; i < callouts.length; i++) {
        const c = callouts[i];
        if (!c.kind || c.t > 0.55) continue;
        const cy = c.y0 - c.rise * ease(c.t / c.dur);
        if (Math.abs(c.x0 - x) < 80 * uiK && Math.abs(cy - y) < (c.size + size) * 0.5) { y = cy - (c.size + size) * 0.52; moved = true; }
      }
      if (!moved) break;
    }
    const big = kind === 2;
    callouts.push({
      text, x, y, vy: 0, t: 0, color: color || BDO.ivory, size, serif: false, scramble: false,
      kind, x0: x, y0: y, rise: (kind === 4 ? 34 : big ? 58 : 46) * uiK, dx: big ? (Math.random() < 0.5 ? -1 : 1) * (14 + Math.random() * 20) * uiK : (Math.random() - 0.5) * 12 * uiK,
      dur: kind === 4 ? 1.0 : big ? 1.25 : 1.05,
    });
  }
  function ease(k) { k = k < 0 ? 0 : k > 1 ? 1 : k; return 1 - (1 - k) * (1 - k); }

  function handleEvents(events, proj, snap, rm) {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      if (!isObj(e)) continue;
      const d = isObj(e.data) ? e.data : {};
      const at = isObj(e.position) ? proj(e.position) : null;
      switch (e.type) {
        case 'boss_hit': {
          lock.hitFlash = 1;
          const big = d.source === 'burst' || d.source === 'rune';
          const p = at && !at.behind ? at : { x: W / 2, y: H * 0.35 };
          if (B) addCalloutB(String(Math.round(num(d.amount, 0))), p.x + (Math.random() - 0.5) * 30, p.y - 10, d.remote ? 3 : big || d.crit ? 2 : 1); // [BDO]
          else addCallout(`-${Math.round(num(d.amount, 0))}`, p.x + (Math.random() - 0.5) * 30, p.y - 10, big ? GOLD_HI : GOLD, big ? 22 : 13);
          if (num(d.combo, 0) > combo.n) { combo.n = d.combo; combo.pop = 1; }
          break;
        }
        case 'combo_break': combo.lost = 1; combo.lostN = num(d.combo, combo.n); combo.n = 0; break;
        case 'player_hit': {
          hurt.t = 0;
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          if (B) addCalloutB(`−${Math.round(num(d.amount, 0))}`, p.x, p.y - 20, 3); // [BDO]
          else addCallout(`-${Math.round(num(d.amount, 0))}`, p.x, p.y - 20, EMBER, 16);
          break;
        }
        case 'block': {
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          if (B) addCalloutB(d.ward ? 'ОБЕРЕГ' : 'БЛОК', p.x, p.y - 30, 4, d.ward ? BDO.goldHi : BDO.manaHi); // [BDO]
          else addCallout(d.ward ? 'ОБЕРЕГ' : 'BLOCK', p.x, p.y - 30, d.ward ? GOLD_HI : BLUE, 14, { scramble: true });
          break;
        }
        case 'dodge': if (!d.perfect) { const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.62 }; if (B) addCalloutB('УКЛОН', p.x, p.y - 30, 4, BDO.ivory); else addCallout('DODGE', p.x, p.y - 30, STEEL, 13, { scramble: true }); } break;
        case 'perfect_dodge': if (B) setBanner('ИДЕАЛЬНЫЙ УКЛОН', '', 2, 1.3, 'ivory', true); else addCallout('PERFECT DODGE', W / 2, H * 0.3, STEEL, 30, { vy: 0, dur: 1.2, serif: false, scramble: true }); break;
        case 'arrow_hit': case 'hand_spell_hit': {   // [BDO] урон по сопернику / от соперника (PvP)
          if (!B) break;
          const dmg = Math.round(num(d.damage, num(d.amount, 0)));
          if (!(dmg > 0) || !at || at.behind) break;
          if (!d.remote) lock.hitFlash = 1;
          addCalloutB(d.remote ? `−${dmg}` : String(dmg), at.x + (Math.random() - 0.5) * 24, at.y - 10, d.remote ? 3 : d.crit ? 2 : 1);
          break;
        }
        case 'player_dash': dashFx = { t: 0, dir: num(d.direction, 1) >= 0 ? 1 : -1 }; break;
        case 'sigil_cast': {   // [ASHEN_V3] печать двумя руками
          const k = d.sigil;
          flash = { t: 0, dur: 0.3, color: k === 'clap' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: k === 'clap' ? 0.3 : 0.2 };
          let sub = '';
          if (k === 'clap') sub = d.stunned ? 'РЕГЕНТ ОГЛУШЁН' : d.cleared ? `ОРБОВ ПОГАШЕНО: ${d.cleared}` : 'ВОЛНА';
          else if (k === 'gate') sub = `−${Math.round(num(d.reduction, 0.6) * 100)}% УРОНА · ${num(d.duration, 5)} с`;
          else if (k === 'frame') sub = `+${Math.round(num(d.bonus, 0.3) * 100)}% УРОНА · ${num(d.duration, 8)} с`;
          else if (k === 'delta') sub = `${num(d.ticks, 4)} УДАРА ЛУЧА${d.cleared ? ` · ОРБОВ ПОГАШЕНО: ${d.cleared}` : ''}`;
          else if (k === 'cor') sub = `+${num(d.heal, 45)} HP · ОБЕРЕГ`;
          if (B) { setBanner(SIGIL_NAME[k] || String(k || ''), sub ? sub.charAt(0) + sub.slice(1).toLowerCase().replace(/ hp/g, ' HP') : '', 3, 1.9, k === 'clap' ? 'mana' : 'gold'); break; } // [BDO]
          addCallout(SIGIL_NAME[k] || String(k || ''), W / 2, H * 0.36, k === 'clap' ? BLUE : GOLD_HI, 24, { vy: -8, dur: 1.4, serif: true });
          if (sub) addCallout(sub, W / 2, H * 0.36 + 32, k === 'clap' ? BLUE : GOLD, 13, { vy: -8, dur: 1.4, scramble: true });
          break;
        }
        case 'encounter_start':   // [ASHEN_V2] вход в арену или удар издали
          flash = { t: 0, dur: 0.35, color: 'rgba(255,106,60,', a: 0.22 };
          if (B) { if (d.reason === 'aggro') setBanner('РЕГЕНТ ПРОБУДИЛСЯ', '', 1, 1.3, 'ember', true); break; } // [BDO] «бой» — мета, её показывает DOM-HUD
          addCallout(d.reason === 'aggro' ? 'РЕГЕНТ ПРОБУДИЛСЯ' : 'БОЙ', W / 2, H * 0.34, EMBER, 22, { vy: 0, dur: 1.4, scramble: true });
          break;
        case 'encounter_end':
          if (B) break;   // [BDO] мета-уведомление — его показывает DOM-HUD справа
          addCallout('РЕГЕНТ ЗАБЫЛ ВАС', W / 2, H * 0.34, DIM, 16, { vy: 0, dur: 1.6, scramble: true });
          break;
        case 'cruise_start': if (B) addCalloutB('АВТОБЕГ', W / 2, H - band - 48 * uiK, 4, BDO.ember); else addCallout('АВТОБЕГ', W / 2, H * 0.72, EMBER, 14, { vy: -6, dur: 1.2, scramble: true }); break;
        case 'ember_lit':   // [ASHEN_V2] уголь клятвы зажжён
          flash = { t: 0, dur: 0.45, color: 'rgba(255,170,90,', a: 0.3 };
          if (B) break;   // [BDO] уголь — мета-уведомление, его показывает DOM-HUD справа; здесь только тёплая вспышка
          addCallout(`УГОЛЬ КЛЯТВЫ  +${num(d.points, 3)}`, W / 2, H * 0.3, GOLD_HI, 26, { vy: -8, dur: 2.4, serif: true, scramble: false });
          if (num(d.total, 0) > 0) addCallout(`${num(d.lit, 0)} / ${num(d.total, 0)}`, W / 2, H * 0.3 + 34, EMBER, 13, { vy: -8, dur: 2.4, scramble: true });
          break;
        case 'burst': flash = { t: 0, dur: 0.28, color: 'rgba(227,199,146,', a: 0.32 }; if (B) { setBanner(`ВЫБРОС ×${(0.5 + num(d.power, 0.5)).toFixed(1)}`, '', 2, 1.1, 'ember', true); break; } addCallout(`ВЫБРОС ×${(0.5 + num(d.power, 0.5)).toFixed(1)}`, W / 2, H * 0.42, GOLD_HI, 20, { vy: -10, dur: 1, scramble: true }); break;
        case 'rune_cast':
          rune = { name: RUNE_NAME[d.rune] || String(d.rune || ''), sub: RUNE_SUB[d.rune] || '', t: 0, trail: rune.trail };
          flash = { t: 0, dur: 0.3, color: d.rune === 'fulgur' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: 0.28 };
          if (B) setBanner(rune.name, RUNE_SUB_B[d.rune] || '', 3, 1.9, d.rune === 'fulgur' || d.rune === 'clepsydra' ? 'mana' : 'gold'); // [BDO]
          break;
        case 'boss_stunned': lock.hitFlash = 1.5; break;
        case 'ability_denied': {
          const txt = d.reason === 'energy' ? 'НЕТ ЭНЕРГИИ' : d.reason === 'cooldown' ? (d.ability === 'rune' ? 'РУНА ПЕРЕЗАРЯЖАЕТСЯ' : 'ПЕРЕЗАРЯДКА') : '';
          if (txt && d.ability !== 'shield') { if (B) addCalloutB(txt, W / 2, H - band - 64 * uiK, 4, BDO.ivoryDim); else addCallout(txt, W / 2, H * 0.68, DIM, 12, { vy: -8, dur: 0.8 }); }
          break;
        }
        default: break;
      }
    }
  }

  // [BDO] захват цели: тонкие золотые уголки с ромбами, ромб на ядре, вспышка при попадании.
  // Имя и HP цели — в рамке цели сверху (DOM-HUD), здесь не дублируются. Цель — snap.lockTarget или босс.
  function drawLockB(snap, proj, rm, dtR, intro) {
    const b = isObj(snap.boss) ? snap.boss : null;
    const lt = isObj(snap.lockTarget) && isObj(snap.lockTarget.position) ? snap.lockTarget : null;
    const pvpT = !!(lt && lt.kind === 'player');
    const pos = pvpT ? lt.position : b && isObj(b.position) ? b.position : null;
    lock.hitFlash = Math.max(0, lock.hitFlash - dtR * 5);
    if (!pos) { lock.ok = false; return; }
    const P = snap.player;
    const engaged = !P || !P.encounter || P.encounter === 'engaged';
    const pts = pvpT ? LOCK_HERO : LOCK_BOSS;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const p = P3(proj, pos.x + q[0], num(pos.y, 0) + q[1], pos.z + q[2]);
      if (!p || p.behind) { lock.ok = false; return; }
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    const k = lock.ok && !rm ? 1 - Math.exp(-dtR * 14) : 1;
    lock.x0 += (x0 - lock.x0) * k; lock.x1 += (x1 - lock.x1) * k; lock.y0 += (y0 - lock.y0) * k; lock.y1 += (y1 - lock.y1) * k;
    lock.ok = true;
    const cp = P3(proj, pos.x, num(pos.y, 0) + (pvpT ? 1.15 : 3.1), pos.z);
    const base = ctx.globalAlpha;
    if (!engaged && !intro) {
      // вне боя: только маленький ромб-маркер над целью
      const tx = (lock.x0 + lock.x1) / 2, ty = lock.y0 - 14;
      ctx.globalAlpha = base * 0.55;
      diamond(tx, ty, 5, 'rgba(12,10,8,0.6)', BDO.gold, 1.2);
      diamond(tx, ty, 1.8, BDO.goldHi, null);
      ctx.globalAlpha = base;
      return;
    }
    const op = pvpT && isObj(snap.opponent) ? snap.opponent : null;
    const tel = snap.telegraphs && snap.telegraphs[0];
    let col = BDO.gold, state = '', sCol = BDO.ivory;
    const act = pvpT ? (op ? op.action : '') : b ? b.action : '';
    if (pvpT) {
      if (op && op.stunned) col = BDO.tealHi;
      else if (op && op.shielding) col = BDO.manaHi;
    } else if (b.stunned) { col = BDO.tealHi; }   // статусы (оглушён, метка) — значками в рамке цели DOM-HUD
    else if (act === 'windup' && tel) { col = tel.blockable ? BDO.manaHi : BDO.bloodHi; }
    else if (act === 'recover') { col = BDO.goldHi; state = 'ОТКРЫТ — БЕЙТЕ'; sCol = BDO.goldHi; }
    else if (act === 'dead') { col = BDO.ivoryFaint; state = 'ПОВЕРЖЕН'; sCol = BDO.ivoryDim; }
    const hf = lock.hitFlash;
    const pad = 12 + (act === 'windup' && !rm ? Math.sin(t * 16) * 2 : 0) + (rm ? 0 : hf * 5);
    const X0 = lock.x0 - pad, X1 = lock.x1 + pad, Y0 = lock.y0 - pad, Y1 = lock.y1 + pad;
    const s = clamp((X1 - X0) * 0.16, 10, 22);
    const ec = hf > 0.35 ? '#fff4dc' : col;
    ctx.globalAlpha = base * (intro ? 0.9 : 0.85);
    ctx.lineCap = 'butt';
    // тёмная подводка под золотом — читается на светлом небе
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.moveTo(X0, Y0 + s); ctx.lineTo(X0, Y0); ctx.lineTo(X0 + s, Y0);
      ctx.moveTo(X1 - s, Y0); ctx.lineTo(X1, Y0); ctx.lineTo(X1, Y0 + s);
      ctx.moveTo(X1, Y1 - s); ctx.lineTo(X1, Y1); ctx.lineTo(X1 - s, Y1);
      ctx.moveTo(X0 + s, Y1); ctx.lineTo(X0, Y1); ctx.lineTo(X0, Y1 - s);
      if (pass === 0) { ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3; } else { ctx.strokeStyle = ec; ctx.lineWidth = 1.25; }
      ctx.stroke();
    }
    // внутренний кант уголков
    const o = 4, s2 = s * 0.55;
    ctx.globalAlpha = base * (intro ? 0.6 : 0.55);
    ctx.beginPath();
    ctx.moveTo(X0 + o, Y0 + o + s2); ctx.lineTo(X0 + o, Y0 + o); ctx.lineTo(X0 + o + s2, Y0 + o);
    ctx.moveTo(X1 - o - s2, Y0 + o); ctx.lineTo(X1 - o, Y0 + o); ctx.lineTo(X1 - o, Y0 + o + s2);
    ctx.moveTo(X1 - o, Y1 - o - s2); ctx.lineTo(X1 - o, Y1 - o); ctx.lineTo(X1 - o - s2, Y1 - o);
    ctx.moveTo(X0 + o + s2, Y1 - o); ctx.lineTo(X0 + o, Y1 - o); ctx.lineTo(X0 + o, Y1 - o - s2);
    ctx.strokeStyle = ec; ctx.lineWidth = 1; ctx.stroke();
    ctx.globalAlpha = base * (intro ? 0.95 : 0.9);
    const dc = col === BDO.gold ? BDO.goldHi : col;
    diamond(X0, Y0, 2.6, dc, null); diamond(X1, Y0, 2.6, dc, null); diamond(X1, Y1, 2.6, dc, null); diamond(X0, Y1, 2.6, dc, null);
    // ромб на ядре цели + расходящийся ромб при попадании
    if (cp && !cp.behind) {
      const cx = cp.x, cy = cp.y;
      const r = 7 + (act === 'windup' && !rm ? Math.abs(Math.sin(t * 8)) * 2 : 0);
      diamond(cx, cy, r + 1, null, 'rgba(0,0,0,0.45)', 3);
      diamond(cx, cy, r, null, ec, 1.2);
      diamond(cx, cy, 2.2, dc, null);
      if (hf > 0.02) {
        ctx.globalAlpha = base * clamp(hf, 0, 1) * 0.9;
        diamond(cx, cy, r + (rm ? 6 : (1 - clamp(hf, 0, 1)) * 22 + 4), null, '#fff4dc', 1.5);
        if (!rm) { ctx.globalAlpha = base * clamp(hf, 0, 1) * 0.35; diamond(cx, cy, r * 0.8, 'rgba(255,238,200,1)', null); }
      }
    }
    ctx.globalAlpha = base;
    if (intro) return;
    // «окно» после удара босса — короткая подсказка мелко справа сверху от рамки
    if (state) { ctx.textBaseline = 'top'; txt(state, Math.min(X1 + 10, W - 230), Math.max(136, Y0 + 6), sCol, F('display', 15 * uiK), 'left', 0.95); }
  }

  function drawLock(snap, proj, rm, dtR, intro) {
    if (B) { drawLockB(snap, proj, rm, dtR, intro); return; } // [BDO]
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
    if (b.stunned) { col = BLUE; state = `ОГЛУШЁН ${num(b.stunRemaining, 0).toFixed(1)}s`; }
    else if (b.action === 'windup' && tel) { col = tel.blockable ? BLUE : EMBER; state = `${KIND[tel.kind] || tel.kind} ▸ ${num(tel.remaining, 0).toFixed(1)}s`; }
    else if (b.action === 'recover') { col = GOLD_HI; state = 'OPEN ▸ STRIKE'; }
    else if (b.action === 'dead') { col = DIM; state = 'TARGET DOWN'; }
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
    tag(engaged ? 'REGENT // LOCK' : 'REGENT // ВПЕРЕДИ', lx, ly, engaged ? col : DIM, `600 11px ${MONO}`);
    tag(`d:${dist.toFixed(1)}m  HP ${Math.round((b.hp / b.maxHp) * 100)}%`, lx, ly + 18, DIM);
    if (state) tag(state, lx, ly + 36, col, `600 12px ${MONO}`);
    if (b.marked) tag(`◈ МЕТКА +30% · ${num(b.markRemaining, 0).toFixed(1)}s`, lx, ly + (state ? 54 : 36), GOLD_HI, `600 11px ${MONO}`);
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
      if (s && !s.behind && s.x > 40 && s.x < W - 40 && s.y > 90 && s.y < (B ? H - band - 14 : H - 70)) {
        const r = 6 + 2 * Math.sin(t * 3 + q.x);
        if (B) {   // [BDO] ромб-уголь: тлеющая сердцевина в бронзово-огненной кайме
          const rr = rmNow ? 7 : r + 1;
          diamond(s.x, s.y, rr + 1.5, 'rgba(12,8,5,0.55)', 'rgba(0,0,0,0.5)', 2);
          diamond(s.x, s.y, rr, 'rgba(255,138,60,0.22)', BDO.ember, 1.3);
          diamond(s.x, s.y, 2.4, BDO.emberHi, null);
          if (q === nearest) { ctx.textBaseline = 'top'; txt(memo(mPoi, Math.round(d), 'УГОЛЬ · ', ' м', 0), s.x, s.y + rr + 6, BDO.emberHi, F('display', 15 * uiK), 'center'); }
          continue;
        }
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
        if (B) {   // [BDO] стрелка-наконечник у края и «24 м» Forum
          ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
          ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-7, -8); ctx.lineTo(-2, 0); ctx.lineTo(-7, 8); ctx.closePath();
          ctx.fillStyle = BDO.ember; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill();
          ctx.strokeStyle = BDO.emberHi; ctx.lineWidth = 0.8; ctx.stroke();
          ctx.restore();
          ctx.textBaseline = 'middle';
          txt(memo(mPoiE, Math.round(d), 'УГОЛЬ · ', ' м', 0), ex - Math.cos(ang) * 42, ey - Math.sin(ang) * 26, BDO.emberHi, F('display', 14 * uiK), 'center');
          ctx.textBaseline = 'top';
          continue;
        }
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
  // [BDO] палитра индикатора: прежняя «tracking edit» или BDO (слоновая кость / золото / угли)
  let cST = STEEL, cBL = BLUE, cGO = GOLD, cGH = GOLD_HI, cEM = EMBER, cDI = DIM;
  function setPal() {
    if (B) { cST = BDO.ivory; cBL = BDO.ivory; cGO = BDO.gold; cGH = BDO.goldHi; cEM = BDO.ember; cDI = BDO.ivoryFaint; }
    else { cST = STEEL; cBL = BLUE; cGO = GOLD; cGH = GOLD_HI; cEM = EMBER; cDI = DIM; }
  }
  // [BDO] медальон: тёмный диск, бронзовое кольцо с делениями, золотой кант и ромбы по сторонам света
  function medallion(cx, cy, r, A, base) {
    if (!GC.disc || GC.discR !== r) {
      const g = ctx.createRadialGradient(0, -r * 0.25, r * 0.1, 0, 0, r);
      g.addColorStop(0, 'rgba(34,27,19,0.86)'); g.addColorStop(0.7, 'rgba(14,11,8,0.88)'); g.addColorStop(1, 'rgba(6,5,4,0.92)');
      GC.disc = g; GC.discR = r;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalAlpha = base * A;
    ctx.fillStyle = GC.disc;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = BDO.bronze; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(216,179,106,0.30)';
    ctx.beginPath(); ctx.arc(0, 0, r - 4, 0, TAU); ctx.stroke();
    // деления по нижней дуге (верх занят рулём)
    ctx.strokeStyle = BDO.bronzeDim; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 12; i++) {
      const a = (i / 12) * Math.PI, c = Math.cos(a), s = Math.sin(a), l = i === 6 ? 5 : i % 3 === 0 ? 4 : 2.5;
      ctx.moveTo(c * (r - 4), s * (r - 4)); ctx.lineTo(c * (r - 4 - l), s * (r - 4 - l));
    }
    ctx.stroke();
    diamond(0, -r, 3.2, BDO.gold, 'rgba(0,0,0,0.6)', 1); diamond(r, 0, 2.6, BDO.bronzeHi, null);
    diamond(-r, 0, 2.6, BDO.bronzeHi, null); diamond(0, r, 2.6, BDO.bronzeHi, null);
    ctx.restore();
  }
  // [BDO] подписи состояния над медальоном: строка 1 — что делает герой, строка 2 — что сделать
  function medLabels(l1, c1, l2, c2, cx, yTop, rm, pulse) {
    const ga = ctx.globalAlpha;
    ctx.save();
    ctx.textBaseline = 'bottom';
    if (hasLS) ctx.letterSpacing = '1px';
    const y1 = yTop - 5;
    txt(l1, cx, y1, c1 === BDO.ivory ? BDO.ivoryDim : c1, F('display', 14 * uiK), 'center', 1, 3);
    // вторая строка — выше; прячется, пока показана карточка «ОШИБКА» (она важнее и стоит там же)
    if (l2 && !(coach.hint && coach.t < COACH_DUR)) {
      ctx.globalAlpha = ga * (rm ? 0.95 : 0.7 + 0.3 * pulse);
      txt(l2, cx, y1 - 17 * uiK, c2 === BDO.gold ? BDO.goldHi : c2, F('display', 14 * uiK), 'center', 1, 3);
    }
    ctx.restore();
  }
  function drawStickHud(input, snap, dtR, rm) {
    const st = input && isObj(input.stick) ? input.stick : null;
    const want = input ? 1 : 0;
    stickFx.alpha += (want - stickFx.alpha) * (1 - Math.exp(-dtR * 8));
    if (stickFx.alpha < 0.02) return;
    const dd = input && isObj(input.dashDir) ? input.dashDir : null;
    if (dd && (num(dd.x, 0) || num(dd.z, 0))) { stickFx.dashT = 0; stickFx.dashX = num(dd.x, 0); stickFx.dashY = -num(dd.z, 0); }
    stickFx.dashT += dtR;
    setPal();   // [BDO] палитра индикатора (прежняя или BDO)
    if (st && st.mode === 'steer') { drawSteerHud(st, snap, rm); return; }
    const RM = band * 0.42;   // [BDO] радиус медальона по центру нижней полосы
    const R = B ? RM - 8 : clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = B ? H - band / 2 - 4 : H - R - 26;
    const A = stickFx.alpha;
    const base = ctx.globalAlpha;
    const engaged = !!(st && st.engaged);
    const running = engaged && st.gait === 'run', walking = engaged && st.gait === 'walk';
    const sprint = snap && snap.player && num(snap.player.sprint, 0) > 0.5;
    // подложка
    if (B) medallion(cx, cy, RM, A, base, snap);
    else {
      ctx.globalAlpha = base * A * 0.55;
      ctx.fillStyle = PLATE;
      ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, Math.PI * 2); ctx.fill();
    }
    // зоны: шаг (внутри кольца бега) и бег (снаружи)
    const rRun = R * 0.72;
    const S = st && num(st.deadzone, 0) > 0 ? st.deadzone / 0.4 : 0;
    const dzPx = st && S > 0 && num(st.runOn, 0) > 0 ? rRun * (st.deadzone / st.runOn) : R * 0.24;
    ctx.globalAlpha = base * A * (running ? 0.9 : 0.45);
    ctx.strokeStyle = sprint ? cEM : cGO; ctx.lineWidth = running ? 2 : 1.2;
    ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.arc(cx, cy, rRun, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = cST; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = base * A * 0.5; ctx.fillStyle = 'rgba(201,164,92,0.18)';
    ctx.beginPath(); ctx.arc(cx, cy, dzPx, 0, Math.PI * 2); ctx.fill();
    // рука относительно центра
    let label = '', col = cDI;
    if (!st || !st.hand) { label = 'ЛЕВАЯ РУКА НЕ ВИДНА'; col = cDI; }
    else if (!engaged) {
      if (st.rest) { label = 'РУКА ОПУЩЕНА · ПОДНИМИТЕ И ЗАМРИТЕ'; col = cDI; }
      else if (st.grabbing) {
        label = 'ЗАМРИТЕ…'; col = cGH;
        const k = clamp(num(st.grabProgress, 0.5), 0, 1);
        ctx.globalAlpha = base * A; ctx.strokeStyle = cGH; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
      } else { label = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ И ЗАМРИТЕ'; col = cGO; }
    } else {
      const aspect = num(st.aspect, 4 / 3);
      if (st.anchor && S > 0) {
        const ox = (st.hand.x - st.anchor.x) * aspect / S, oy = (st.hand.y - st.anchor.y) / S;
        const k = rRun / Math.max(1e-3, st.runOn / S);
        let px = ox * k, py = oy * k;
        const l = Math.hypot(px, py); if (l > R) { px *= R / l; py *= R / l; }
        ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = cST; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + px, cy + py); ctx.stroke();
        ctx.globalAlpha = base * A; ctx.fillStyle = running ? cGH : walking ? cBL : cST;
        ctx.beginPath(); ctx.arc(cx + px, cy + py, 5.5, 0, Math.PI * 2); ctx.fill();
      }
      const mx = num(st.x, 0), mz = num(st.z, 0), m = Math.min(1, Math.hypot(mx, mz));
      if (m > 0.01) {
        // шаг (0.2…0.6) заполняет пространство до кольца бега, бег — до края
        const ux = mx / m, uy = -mz / m, L = running ? R : dzPx + (rRun - dzPx) * clamp(m / 0.6, 0.35, 1);
        ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = running ? (sprint ? cEM : cGH) : cBL; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx + ux * dzPx * 0.6, cy + uy * dzPx * 0.6); ctx.lineTo(cx + ux * L, cy + uy * L); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        const ex = cx + ux * L, ey = cy + uy * L;
        ctx.beginPath(); ctx.moveTo(ex + ux * 8, ey + uy * 8); ctx.lineTo(ex - uy * 6, ey + ux * 6); ctx.lineTo(ex + uy * 6, ey - ux * 6); ctx.closePath(); ctx.fill();
      }
      label = sprint ? 'СПРИНТ' : running ? 'БЕГ' : walking ? 'ШАГ' : 'СТОИТ';
      col = sprint ? cEM : running ? cGH : walking ? cBL : cST;
      if (st.source === 'wrist') label += ' · ПО ЗАПЯСТЬЮ';
    }
    if (snap && snap.player && snap.player.cruise) { label = 'АВТОБЕГ · ПОДНИМИТЕ РУКУ — СТОП'; col = cEM; }
    // вспышка рывка
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, l = Math.hypot(stickFx.dashX, stickFx.dashY) || 1;
      const ux = stickFx.dashX / l, uy = stickFx.dashY / l, a0 = Math.atan2(uy, ux);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = cEM; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 6 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      label = 'РЫВОК'; col = cEM;
    }
    ctx.globalAlpha = base * A;
    if (B) medLabels(label, col, '', '', cx, cy - RM, rm, 1); // [BDO] подпись над медальоном
    else tag(label, cx, cy + R + 10, col, `600 11px ${MONO}`, 'center');
    ctx.globalAlpha = base;
  }

  // [V5] Схема «Руль» (core/steerStick.js): дуга-руль сверху — сколько герой поворачивает (серая
  // полоса в середине — мёртвая зона, точка — где сейчас рука), столбик в центре — высота левой руки
  // и ступени «ШАГ» / «БЕГ»; ниже — что делает герой и что сделать, чтобы пойти. Занимает то же место,
  // что индикатор джойстика: низ экрана по центру, ниже карточки «ОШИБКА».
  function drawSteerHud(st, snap, rm) {
    const base = ctx.globalAlpha, A = stickFx.alpha;
    const RM = band * 0.42;   // [BDO] медальон по центру нижней полосы HUD; дуга-руль — внутри кольца
    const R = B ? RM - 11 : clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = B ? H - band / 2 - 4 : H - 58 - R * 0.3;
    const aw = B ? 5 : 6;
    const engaged = !!st.engaged;
    const turn = engaged ? clamp(num(st.turn, num(st.x, 0)), -1, 1) : 0;
    const fwd = engaged ? clamp(num(st.fwd, num(st.z, 0)), 0, 1) : 0;
    const P = snap && snap.player;
    const sprint = engaged && P && num(P.sprint, 0) > 0.5;
    const arena = !!(P && P.encounter === 'engaged');
    const running = engaged && st.gait === 'run';
    const col = sprint ? cEM : running ? cGH : cBL;
    const lv = isObj(st.levels) ? st.levels : { walkOn: -0.55, walkOff: -0.72, runOn: 0.05, runOff: -0.12 };
    const tz = isObj(st.turnZone) ? st.turnZone : { dzOn: 0.2, dzOff: 0.13, full: 0.62 };
    const SPAN = 1.15, TOP = -Math.PI / 2;           // полный поворот — ±66° по дуге
    const pulse = rm ? 0.75 : 0.55 + 0.45 * Math.abs(Math.sin(t * 3.2));
    // подложка: полукруг над столбиком
    if (B) medallion(cx, cy, RM, A, base, snap);
    else {
      ctx.globalAlpha = base * A * 0.55; ctx.fillStyle = PLATE;
      ctx.beginPath(); ctx.arc(cx, cy, R + 12, Math.PI, 0); ctx.lineTo(cx + R + 12, cy + R * 0.3 + 4); ctx.lineTo(cx - R - 12, cy + R * 0.3 + 4); ctx.closePath(); ctx.fill();
    }
    // дуга-руль: дорожка, мёртвая зона, заливка поворота, ручка
    ctx.lineCap = 'round';
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = cST; ctx.lineWidth = aw;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - SPAN, TOP + SPAN); ctx.stroke();
    const dzA = SPAN * clamp(num(tz.dzOn, 0.2) / Math.max(0.05, num(tz.full, 0.62)), 0, 0.8);
    ctx.globalAlpha = base * A * 0.55; ctx.strokeStyle = 'rgba(201,164,92,0.55)'; ctx.lineWidth = aw;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - dzA, TOP + dzA); ctx.stroke();
    if (Math.abs(turn) > 0.01) {
      ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = col; ctx.lineWidth = aw;
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.min(TOP, TOP + turn * SPAN), Math.max(TOP, TOP + turn * SPAN)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    const ka = TOP + turn * SPAN;
    ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? col : cDI;
    if (B) diamond(cx + Math.cos(ka) * R, cy + Math.sin(ka) * R, engaged ? 6 : 4.5, engaged ? col : cDI, 'rgba(0,0,0,0.6)', 1); // [BDO] ручка-ромб
    else { ctx.beginPath(); ctx.arc(cx + Math.cos(ka) * R, cy + Math.sin(ka) * R, engaged ? 6.5 : 5, 0, Math.PI * 2); ctx.fill(); }
    if (Number.isFinite(st.lateral) && st.hand) {
      // где сейчас рука по горизонтали (сырая, до мёртвой зоны и сглаживания)
      const ha = TOP + clamp(st.lateral / Math.max(0.05, num(tz.full, 0.62)), -1.25, 1.25) * SPAN;
      ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = cST;
      ctx.beginPath(); ctx.arc(cx + Math.cos(ha) * (R - 11), cy + Math.sin(ha) * (R - 11), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = cDI; ctx.font = B ? F('body', 11 * uiK, 700) : `600 12px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ea = SPAN + 0.2;
    ctx.fillText('←', cx + Math.cos(TOP - ea) * (R + 2), cy + Math.sin(TOP - ea) * (R + 2));
    ctx.fillText('→', cx + Math.cos(TOP + ea) * (R + 2), cy + Math.sin(TOP + ea) * (R + 2));
    // столбик высоты руки: ниже «ШАГ» — стоп, выше «БЕГ» — бег
    const bw = B ? 8 : 10, x0 = cx - bw / 2, yb = B ? cy + RM * 0.56 : cy + R * 0.3 - 4, yt = B ? cy - RM * 0.4 : cy - R * 0.66;
    const vMin = num(lv.walkOff, -0.72) - 0.6, vMax = num(lv.runOn, 0.05) + 0.45;
    const yOf = (v) => yb - (clamp(v, vMin, vMax) - vMin) / (vMax - vMin) * (yb - yt);
    const yWalk = yOf(num(lv.walkOn, -0.55)), yRun = yOf(num(lv.runOn, 0.05));
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = B ? 'rgba(6,5,4,0.9)' : 'rgba(5,7,11,0.85)'; ctx.fillRect(x0, yt, bw, yb - yt);
    ctx.globalAlpha = base * A * 0.3; ctx.fillStyle = cBL; ctx.fillRect(x0, yRun, bw, yWalk - yRun);
    ctx.fillStyle = cGO; ctx.fillRect(x0, yt, bw, yRun - yt);
    const level = Number.isFinite(st.level) ? st.level : null;
    if (engaged) {
      const yl = level !== null ? yOf(level) : running ? yOf(num(lv.runOn, 0.05) + 0.2) : yOf(num(lv.walkOn, -0.55) + (num(lv.runOn, 0.05) - num(lv.walkOn, -0.55)) * clamp((fwd - 0.3) / 0.3, 0, 1));
      ctx.globalAlpha = base * A * 0.9; ctx.fillStyle = fwd > 0 ? col : cST;
      ctx.fillRect(x0 + 2, yl, bw - 4, yb - yl);
    }
    ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = cST; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, yt + 0.5, bw - 1, yb - yt - 1);
    // пороги: «ШАГ» пульсирует, пока рука ниже него
    const wantUp = !engaged && !!st.hand && !st.busy;
    ctx.globalAlpha = base * A * (wantUp ? pulse : 0.8); ctx.strokeStyle = wantUp ? cGH : cST; ctx.lineWidth = wantUp ? 2 : 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yWalk); ctx.lineTo(x0 + bw + 5, yWalk); ctx.stroke();
    ctx.globalAlpha = base * A * 0.8; ctx.strokeStyle = cGO; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yRun); ctx.lineTo(x0 + bw + 5, yRun); ctx.stroke();
    ctx.font = B ? F('display', 11 * uiK) : `600 9px ${MONO}`; ctx.textAlign = 'left';
    ctx.globalAlpha = base * A * 0.85; ctx.fillStyle = wantUp ? cGH : cST; ctx.fillText('ШАГ', x0 + bw + 8, yWalk);
    ctx.fillStyle = cGO; ctx.fillText('БЕГ', x0 + bw + 8, yRun);
    // метка руки на столбике (треугольник слева)
    if (level !== null && st.hand) {
      const yh = yOf(level);
      ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? cST : cGH;
      ctx.beginPath(); ctx.moveTo(x0 - 2, yh); ctx.lineTo(x0 - 10, yh - 5); ctx.lineTo(x0 - 10, yh + 5); ctx.closePath(); ctx.fill();
      if (wantUp && yh > yWalk + 8) {
        // стрелка «выше» от метки руки к порогу «ШАГ»
        const ya = rm ? 0 : (t * 14) % 6;
        ctx.globalAlpha = base * A * pulse; ctx.strokeStyle = cGH; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x0 - 14, yh - 8 - ya + 4); ctx.lineTo(x0 - 10, yh - 12 - ya); ctx.lineTo(x0 - 6, yh - 8 - ya + 4); ctx.stroke();
      }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    // подписи: что делает герой / что сделать
    let l1 = '', c1 = cST, l2 = '', c2 = cGO;
    const pace = sprint ? 'СПРИНТ' : running ? 'БЕГ' : 'ШАГ';
    if (!st.hand) { l1 = 'СТОП'; c1 = cDI; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.busy || st.hold === 'cast') { l1 = 'ЧАРЫ · ГЕРОЙ СТОИТ'; c1 = cST; }
    else if (!engaged) { l1 = 'СТОП — РУКА ОПУЩЕНА'; c1 = cST; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.hold === 'shield') { l1 = Math.abs(turn) > 0.05 ? `ЩИТ · ПОВОРОТ ${turn < 0 ? '←' : '→'}` : 'ЩИТ · ГЕРОЙ СТОИТ'; c1 = cBL; }
    else if (Math.abs(turn) > 0.05) { l1 = `${arena ? 'ОБХОД' : 'ПОВОРОТ'} ${turn < 0 ? '←' : '→'} · ${pace}`; c1 = col; }
    else { l1 = `${arena ? 'К РЕГЕНТУ' : 'ВПЕРЁД'} · ${pace}`; c1 = col; }
    if (engaged && st.source === 'wrist') l1 += ' · ПО ЗАПЯСТЬЮ';
    // вспышка рывка — дуга в сторону дёрга
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, a0 = Math.atan2(stickFx.dashY, stickFx.dashX);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = cEM; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 8 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      l1 = 'РЫВОК'; c1 = cEM;
    }
    const ly = cy + R * 0.3 + 10;
    ctx.globalAlpha = base * A;
    if (B) { medLabels(l1, c1, l2, c2, cx, cy - RM, rm, pulse); ctx.globalAlpha = base; return; } // [BDO] подписи над медальоном
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
      if (B) {   // [BDO] кольцо-таймер с ромбом/треугольником и подпись Forum (без моноширинных плашек)
        const x = clamp(p.x, 80, W - 240), y = clamp(p.y + 16 + yNudge, 150, H - band - 66 * uiK);   // выше подписей медальона
        const col = tl.blockable ? BDO.manaHi : BDO.bloodHi;
        const frac = clamp(num(tl.remaining, 0) / Math.max(0.05, num(tl.duration, 1.5)), 0, 1);
        const lbl = (TELE_B[tl.kind] || TELE_B.slam)[tl.blockable ? 0 : 1];
        const f = F('display', 15 * uiK), w = tw(lbl, f), r = 9 * uiK;
        const rx = x - w / 2 - r - 4;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath(); ctx.arc(rx, y, r, 0, TAU); ctx.stroke();
        ctx.lineWidth = 1.5; ctx.strokeStyle = BDO.bronzeDim; ctx.stroke();
        ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(rx, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * frac); ctx.stroke();
        if (tl.blockable) diamond(rx, y, r * 0.42, col, null);
        else { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(rx, y - r * 0.5); ctx.lineTo(rx + r * 0.46, y + r * 0.35); ctx.lineTo(rx - r * 0.46, y + r * 0.35); ctx.closePath(); ctx.fill(); }
        ctx.textBaseline = 'middle';
        txt(lbl, rx + r + 6, y + 1, col, f, 'left');
        ctx.textBaseline = 'top';
        yNudge += 24 * uiK;
        continue;
      }
      const hint = tl.blockable ? (tl.kind === 'orb' ? 'ЩИТ' : 'ЩИТ / РЫВОК') : 'УЙДИ';
      const col = tl.blockable ? BLUE : EMBER;
      const x = clamp(p.x, 60, W - 200), y = clamp(p.y + 14 + yNudge, 110, H - 40);
      tag(`${tl.blockable ? '◇' : '▲'} ${KIND[tl.kind] || tl.kind} ${num(tl.remaining, 0).toFixed(1)}s · ${hint}`, x, y, col, `600 12px ${MONO}`, 'center');
      yNudge += 18;
    }
  }

  // [BDO] подсказки у героя: «Бастион» над головой, заряд кулака — золотая дуга вокруг корпуса
  const mBast = { v: NaN, s: '' }, mCharge = { v: NaN, s: '' };
  function drawHeroB(snap, input, cx, yTop, yBot, h) {
    const base = ctx.globalAlpha;
    ctx.textBaseline = 'bottom';
    let yl = Math.max(150, yTop - 10);
    if (snap.player.bastion) {
      txt(memo(mBast, Math.ceil(num(snap.player.bastionRemaining, 0)), 'БАСТИОН · ', ' с', 0), cx, yl, BDO.goldHi, F('display', 15 * uiK), 'center');
      yl -= 18 * uiK;
    }
    const ch = input ? num(input.charge, 0) : 0;
    if (ch > 0.02) {
      const r = h * 0.55, cy = (yTop + yBot) / 2;
      const hot = ch >= 0.3;
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(138,106,62,0.55)'; ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = hot ? BDO.ember : BDO.gold;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(ch, 0, 1)); ctx.stroke();
      const a1 = -Math.PI / 2 + TAU * clamp(ch, 0, 1);
      diamond(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, 3.5, hot ? BDO.emberHi : BDO.goldHi, null);
      txt(memo(mCharge, Math.round(ch * 20) * 5, 'ЗАРЯД ', '%', 0), cx, yl, hot ? BDO.emberHi : BDO.gold, F('display', 15 * uiK), 'center');
      if (hot) txt('РАСКРОЙТЕ ЛАДОНЬ', cx, yl - 17 * uiK, BDO.emberHi, F('display', 13 * uiK), 'center', 0.9);
    }
    ctx.globalAlpha = base; ctx.textBaseline = 'top';
  }

  function drawHero(snap, proj, input) {
    const p = snap.player.position;
    const top = proj({ x: p.x, y: 1.95, z: p.z }), bot = proj({ x: p.x, y: 0, z: p.z });
    if (!top || !bot || top.behind || bot.behind) return;
    const h = Math.abs(bot.y - top.y), w = h * 0.42, cx = (top.x + bot.x) / 2;
    if (B) { drawHeroB(snap, input, cx, top.y, bot.y, h); return; } // [BDO] без рамок и координат «YOU x: z:»
    ctx.strokeStyle = STEEL; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    brackets(cx - w / 2, top.y, cx + w / 2, bot.y, 10);
    ctx.globalAlpha = 1;
    tag(`YOU  x:${p.x.toFixed(1)} z:${p.z.toFixed(1)}`, cx - w / 2, top.y - 18, DIM, `10px ${MONO}`);
    if (snap.player.bastion) tag(`▣ БАСТИОН ${num(snap.player.bastionRemaining, 0).toFixed(1)}s`, cx - w / 2, top.y - 36, GOLD_HI, `600 11px ${MONO}`);
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
    if (B && tr && tr.length > 1) {   // [BDO] светящийся золотой след без аллокаций на точку
      const a = drawing ? 1 : Math.max(0, 1 - rune.t / 0.8), base = ctx.globalAlpha, kx = S * 1.333;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let pass = 0; pass < 4; pass++) {
        if (pass === 0 && lowQ) continue;
        ctx.lineWidth = pass === 0 ? 16 : pass === 1 ? 8 : pass === 2 ? 3.5 : 1.4;
        ctx.strokeStyle = pass === 0 ? BDO.ember : pass === 1 ? BDO.gold : pass === 2 ? BDO.goldHi : '#fff8e6';
        ctx.globalAlpha = base * a * (pass === 0 ? 0.08 : pass === 1 ? 0.18 : pass === 2 ? 0.6 : 0.95);
        ctx.beginPath();
        ctx.moveTo(ox + num(tr[0].x, 0) * kx, oy + num(tr[0].y, 0) * S);
        for (let i = 1; i < tr.length; i++) ctx.lineTo(ox + num(tr[i].x, 0) * kx, oy + num(tr[i].y, 0) * S);
        ctx.stroke();
      }
      ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      if (drawing) {
        const q = tr[tr.length - 1], ex = ox + num(q.x, 0) * kx, ey = oy + num(q.y, 0) * S;
        ctx.globalAlpha = base * a;
        diamond(ex, ey, 4, '#fff8e6', BDO.gold, 1);
        ctx.textBaseline = 'middle';
        txt('РУНА', ex + 14, ey - 10, BDO.goldHi, F('display', 15 * uiK), 'left');
        ctx.textBaseline = 'top';
      }
      ctx.globalAlpha = base;
    } else if (tr && tr.length > 1) {
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
    if (rune.t < 1.6 && rune.name && !B) {   // [BDO] в стиле BDO имя руны — центральный титр (drawBanner)
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
    if (fizzleT < 0.9 && !(coach.hint && coach.t < 1)) {
      if (B) { ctx.textBaseline = 'middle'; txt('Руна не распознана', W / 2, H * 0.43, BDO.ivoryDim, F('italic', 20 * uiK, 500), 'center', clamp((0.9 - fizzleT) / 0.3, 0, 1)); ctx.textBaseline = 'top'; } // [BDO]
      else tag('РУНА НЕ РАСПОЗНАНА', W / 2, H * 0.3, DIM, `600 12px ${MONO}`, 'center');
      fizzleT += dtR;
    }
  }

  // [ТВИСТ «ОШИБКА»] карточка: что за жест, что не так и как исправить. Держится ~4 с, новая заменяет старую.
  function wrapLines(text, maxW) {
    const words = String(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }
  // [BDO] «Точность жестов» — мелко Forum слева сверху (под «Паузой»), значение цифрами Cinzel
  const mAcc = { v: NaN, s: '' };
  function drawAccB(acc) {
    const x = 20, y = 130 * clamp(H / 768, 0.85, 1.2);
    const f1 = F('display', 13 * uiK), f2 = F('num', 13 * uiK, 700);
    const lbl = 'ТОЧНОСТЬ ЖЕСТОВ';
    ctx.save();
    ctx.textBaseline = 'middle';
    if (hasLS) ctx.letterSpacing = '1px';
    const w = tw(lbl, f1);
    txt(lbl, x, y, BDO.ivoryDim, f1, 'left', 0.95);
    if (hasLS) ctx.letterSpacing = '0px';
    txt(memo(mAcc, acc, '', '%', 0), x + w + 8, y + 1, acc >= 75 ? BDO.goldHi : acc >= 50 ? BDO.gold : BDO.bloodHi, f2, 'left', 0.95);
    rule(x + (w + 44) / 2, y + 11 * uiK, w + 44, 0.5);
    ctx.restore();
  }
  // [BDO] карточка «ОШИБКА»: панель BDO с кровавой каймой и уголками, по центру над нижней полосой HUD
  const coachB = { hint: null, W: 0, lines: null, title: '' };
  function drawCoachB(h, k, a, rm) {
    const cw = Math.min(600, W - 32);
    const fBody = F('body', 19 * clamp(uiK, 0.95, 1.25), 500);
    const lh = Math.round(24 * clamp(uiK, 0.95, 1.25));
    if (coachB.hint !== h || coachB.W !== W) {   // перенос строк и заголовок — один раз на подсказку
      ctx.font = fBody;
      coachB.hint = h; coachB.W = W; coachB.lines = wrapLines(h.text, cw - 84);
      const side = h.side === 'left' ? ' · ЛЕВАЯ РУКА' : h.side === 'right' ? ' · ПРАВАЯ РУКА' : '';
      coachB.title = `ОШИБКА${h.gesture ? ' · ' + String(h.gesture).toUpperCase() : ''}${side}`;
    }
    const lines = coachB.lines;
    const ch = 50 + lines.length * lh;
    const x = Math.round(W / 2 - cw / 2);
    const rise = rm ? 0 : (1 - clamp(k / 0.25, 0, 1)) * 14;
    const y = Math.round(H - band - 10 - ch + rise);
    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * a;
    bdoPanel(ctx, x, y, cw, ch, { fill: 'rgba(24,7,7,0.92)', edge: BDO.blood, corner: BDO.bloodHi, c: 7 });
    // пульсирующая кровавая кайма и полоса слева
    const pulse = rm ? 0.8 : 0.6 + 0.4 * Math.abs(Math.sin(k * 5));
    chamferPath(ctx, x - 0.5, y - 0.5, cw + 1, ch + 1, 7);
    ctx.globalAlpha = base * a * pulse; ctx.strokeStyle = BDO.bloodHi; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.globalAlpha = base * a;
    ctx.fillStyle = BDO.blood; ctx.fillRect(x + 4, y + 9, 3, ch - 18);
    // знак «!» в кровавом ромбе
    const ix = x + 36, iy = y + ch / 2;
    diamond(ix, iy, 15, 'rgba(176,38,42,0.28)', BDO.bloodHi, 1.5);
    diamond(ix, iy, 11, null, 'rgba(224,72,74,0.45)', 1);
    ctx.textBaseline = 'middle';
    txt('!', ix, iy + 1, BDO.ivory, F('num', 17, 700), 'center', 1, 0);
    // заголовок Forum кровью и текст исправления Alegreya Sans слоновой костью
    const tx = x + 64;
    ctx.textBaseline = 'top';
    if (hasLS) ctx.letterSpacing = '1.5px';
    txt(coachB.title, tx, y + 13, '#ff6a62', F('display', 16 * clamp(uiK, 0.95, 1.2)), 'left', 1, 3);
    if (hasLS) ctx.letterSpacing = '0px';
    rule(tx + 120, y + 34, 240, 0.7, true);
    for (let i = 0; i < lines.length; i++) txt(lines[i], tx, y + 40 + i * lh, BDO.ivory, fBody, 'left', 1, 0);
    // полоска времени жизни
    ctx.fillStyle = 'rgba(224,72,74,0.6)';
    ctx.fillRect(x + 8, y + ch - 4, (cw - 16) * (1 - k / COACH_DUR), 2);
    ctx.restore();
  }

  function drawCoach(cv, dtR, rm) {
    if (!isObj(cv)) return;
    if (isObj(cv.hint) && cv.hint.text && (!coach.hint || cv.hint.tMs !== coach.hint.tMs || cv.hint.code !== coach.hint.code)) {
      coach = { hint: cv.hint, t: 0 };
    }
    // точность жестов за бой — у правого края под кнопкой паузы
    if (Number.isFinite(cv.accuracy) && num(cv.good, 0) + num(cv.mistakes, 0) >= 3) {
      const acc = cv.accuracy;
      if (B) drawAccB(acc); // [BDO] слева сверху под кнопкой паузы
      else tag(`ТОЧНОСТЬ ЖЕСТОВ ${acc}%`, W - 24, 70, acc >= 75 ? GOLD_HI : acc >= 50 ? GOLD : EMBER, `600 11px ${MONO}`, 'right');
    }
    if (!coach.hint || coach.t >= COACH_DUR) { coach.t += dtR; return; }
    const k = coach.t;
    const a = clamp(k / 0.18, 0, 1) * clamp((COACH_DUR - k) / 0.5, 0, 1);
    const h = coach.hint;
    if (B) { drawCoachB(h, k, a, rm); coach.t += dtR; return; } // [BDO]
    const cw = Math.min(560, W - 40);
    ctx.font = `500 17px ${SERIF}`;
    const lines = wrapLines(h.text, cw - 58);
    const ch = 46 + lines.length * 22;
    const x = W / 2 - cw / 2;
    const rise = rm ? 0 : (1 - clamp(k / 0.25, 0, 1)) * 14;
    const y = Math.min(H * 0.6, H - 260 - ch) + rise; // выше панели способностей и превью камеры
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,6,6,0.82)';
    ctx.fillRect(x, y, cw, ch);
    // пульсирующая рамка и красная полоса слева
    const pulse = rm ? 0.8 : 0.6 + 0.4 * Math.abs(Math.sin(k * 5));
    ctx.strokeStyle = `rgba(255,106,60,${(0.55 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    ctx.fillStyle = EMBER;
    ctx.fillRect(x, y, 4, ch);
    // значок «!»
    ctx.beginPath(); ctx.arc(x + 27, y + 24, 11, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,106,60,0.18)'; ctx.fill();
    ctx.strokeStyle = EMBER; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = EMBER; ctx.font = `700 14px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText('!', x + 27, y + 16);
    ctx.textAlign = 'left';
    const side = h.side === 'left' ? ' · ЛЕВАЯ РУКА' : h.side === 'right' ? ' · ПРАВАЯ РУКА' : '';
    ctx.font = `600 11px ${MONO}`; ctx.fillStyle = EMBER;
    ctx.fillText(scramble(`ОШИБКА · ${String(h.gesture || '').toUpperCase()}${side}`, k, rm, 0.3), x + 48, y + 11);
    ctx.font = `500 17px ${SERIF}`; ctx.fillStyle = STEEL;
    lines.forEach((ln, i) => ctx.fillText(ln, x + 48, y + 30 + i * 22));
    // полоска времени жизни
    ctx.fillStyle = 'rgba(255,106,60,0.5)';
    ctx.fillRect(x + 4, y + ch - 2, (cw - 4) * (1 - k / COACH_DUR), 2);
    ctx.globalAlpha = 1;
    coach.t += dtR;
  }

  // [BDO] комбо справа ниже середины (над превью камеры): крупная цифра Cinzel с золотым градиентом,
  // «КОМБО» Forum и множитель слева от неё, бронзовая полоска таймера комбо снизу
  const mCombo = { v: NaN, s: '' }, mMul = { v: NaN, s: '' }, mLost = { v: NaN, s: '' };
  let comboNW = 0, comboNWn = -1, comboNWs = 0;
  function drawComboB(P, n, rm) {
    const x = W - 40, y = H * 0.6;
    const base = ctx.globalAlpha;
    const size = Math.round(clamp(H * 0.075, 44, 84));
    ctx.save();
    if (n >= 2) {
      const s = 1 + (rm ? 0 : combo.pop * 0.28);
      const ns = memo(mCombo, n, '', '', 0);
      const fN = F('num', size, 700);
      if (comboNWn !== n || comboNWs !== size) { ctx.font = fN; comboNW = ctx.measureText(ns).width; comboNWn = n; comboNWs = size; }
      // цифра: обводка + золотой градиент, «удар» при росте комбо
      ctx.translate(x, y); ctx.scale(s, s);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = fN; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(3, size * 0.09); ctx.strokeStyle = 'rgba(8,5,3,0.9)'; ctx.strokeText(ns, 0, 0);
      if (!lowQ) { ctx.shadowColor = 'rgba(255,170,70,0.35)'; ctx.shadowBlur = 14; }
      ctx.fillStyle = tgrad('gold', size); ctx.fillText(ns, 0, 0);
      ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // «КОМБО» и множитель слева от цифры
      const lx = x - comboNW - 12;
      ctx.textBaseline = 'alphabetic';
      if (hasLS) ctx.letterSpacing = '2px';
      txt('КОМБО', lx, y - 2, BDO.ivoryDim, F('display', 15 * uiK), 'right');
      if (hasLS) ctx.letterSpacing = '0px';
      ctx.textBaseline = 'top';
      txt(memo(mMul, Math.round(num(P.comboMultiplier, 1) * 100) / 100, '×', '', 2), lx, y + 3, BDO.gold, F('num', 14 * uiK, 600), 'right');
      // таймер комбо: бронзовый жёлоб, золотая заливка справа налево, ромб на конце
      const frac = clamp(num(P.comboTimer, 0) / 3, 0, 1);
      const bw = 150 * uiK, by = Math.round(y + size * 0.5 + 8);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x - bw - 1, by - 1, bw + 2, 4);
      ctx.fillStyle = 'rgba(138,106,62,0.45)'; ctx.fillRect(x - bw, by, bw, 2);
      ctx.fillStyle = frac < 0.3 ? BDO.bloodHi : BDO.gold; ctx.fillRect(x - bw * frac, by, bw * frac, 2);
      diamond(x - bw * frac, by + 1, 3, frac < 0.3 ? BDO.bloodHi : BDO.goldHi, null);
      diamond(x + 5, by + 1, 2.4, BDO.bronzeHi, null);
    }
    if (combo.lost > 0.02 && combo.lostN >= 5) {
      ctx.globalAlpha = base * clamp(combo.lost, 0, 1);
      ctx.textBaseline = 'top';
      txt(memo(mLost, combo.lostN, 'КОМБО ПРЕРВАНО · ', '', 0), x, y + size * 0.5 + 20, BDO.bloodHi, F('display', 15 * uiK), 'right');
    }
    ctx.restore();
    ctx.globalAlpha = base;
  }

  function drawCombo(snap, dtR, rm) {
    const P = snap.player;
    const n = num(P.combo, 0);
    if (n < combo.n) combo.n = n;
    const x = W - 34, y = H * 0.46;
    if (B) drawComboB(P, n, rm); // [BDO]
    else if (n >= 2) {
      const s = 1 + (rm ? 0 : combo.pop * 0.25);
      ctx.textAlign = 'right';
      ctx.font = `600 ${Math.round(34 * s)}px ${MONO}`;
      ctx.fillStyle = GOLD_HI;
      ctx.fillText(`x${n}`, x, y);
      ctx.font = `600 11px ${MONO}`;
      ctx.fillStyle = STEEL;
      ctx.fillText(`COMBO  ×${num(P.comboMultiplier, 1).toFixed(2)}`, x, y + 40 * s);
      const frac = clamp(num(P.comboTimer, 0) / 3, 0, 1);
      ctx.fillStyle = 'rgba(223,232,245,0.18)'; ctx.fillRect(x - 110, y + 58 * s, 110, 2);
      ctx.fillStyle = GOLD; ctx.fillRect(x - 110 * frac, y + 58 * s, 110 * frac, 2);
      ctx.textAlign = 'left';
    }
    if (combo.lost > 0.02 && combo.lostN >= 5 && !B) {
      ctx.globalAlpha = combo.lost; ctx.textAlign = 'right';
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = EMBER;
      ctx.fillText(`COMBO LOST · x${combo.lostN}`, x, y + 80);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    combo.pop = Math.max(0, combo.pop - dtR * 6);
    combo.lost = Math.max(0, combo.lost - dtR * 0.9);
  }

  // [BDO] выноска урона: Cinzel с тёмной обводкой, градиент по типу, «ударное» увеличение 1.3→1.0,
  // всплытие вверх с замедлением и затухание; слова (БЛОК, УКЛОН…) — Forum
  function drawCalloutB(c, rm) {
    const p = c.t / c.dur;
    const x = c.x0 + c.dx * ease(p), y = c.y0 - c.rise * ease(p);
    const a = (c.t < 0.06 ? c.t / 0.06 : 1) * (p < 0.62 ? 1 : 1 - (p - 0.62) / 0.38);
    let sc = 1;
    if (!rm) {
      if (c.kind === 2) sc = c.t < 0.16 ? 1.3 - 0.3 * (c.t / 0.16) : 1;
      else if (c.kind === 1 || c.kind === 3) sc = c.t < 0.1 ? 1.15 - 0.15 * (c.t / 0.1) : 1;
    }
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * clamp(a, 0, 1);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, dpr * x, dpr * y);
    const word = c.kind === 4;
    ctx.font = word ? F('display', c.size) : F('num', c.size, 700);
    if (word && hasLS) ctx.letterSpacing = '1px';
    ctx.lineWidth = word ? 3.5 : Math.max(3, c.size * 0.15); ctx.strokeStyle = 'rgba(10,5,3,0.92)';
    ctx.strokeText(c.text, 0, 0);
    if (c.kind === 2 && !lowQ) { ctx.shadowColor = 'rgba(255,120,40,0.55)'; ctx.shadowBlur = 12; }
    ctx.fillStyle = word ? c.color : tgrad(c.kind === 2 ? 'ember' : c.kind === 3 ? 'blood' : 'ivory', c.size);
    ctx.fillText(c.text, 0, 0);
    if (c.kind === 2 && !lowQ) { ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)'; }
    if (word && hasLS) ctx.letterSpacing = '0px';
    ctx.globalAlpha = base;
  }

  function drawCallouts(dtR, rm) {
    if (B) {   // [BDO]
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      for (let i = callouts.length - 1; i >= 0; i--) {
        const c = callouts[i];
        c.t += dtR;
        if (c.t >= c.dur) { callouts.splice(i, 1); continue; }
        if (c.kind) drawCalloutB(c, rm);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      return;
    }
    for (let i = callouts.length - 1; i >= 0; i--) {
      const c = callouts[i];
      c.t += dtR;
      if (c.t >= c.dur) { callouts.splice(i, 1); continue; }
      c.y += c.vy * dtR;
      const a = c.t < c.dur * 0.7 ? 1 : 1 - (c.t - c.dur * 0.7) / (c.dur * 0.3);
      ctx.globalAlpha = a;
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

  // [BDO] экранные эффекты: те же вспышки и замедление, но виньетки из кэша, без техно-полос рывка и плашки SLOW
  function drawScreenFxB(ts, dtR, rm) {
    if (flash.t < flash.dur) { vignetteB(flash.color, (1 - flash.t / flash.dur) * flash.a, rm ? 0.8 : 0.2); flash.t += dtR; }
    if (hurt.t < hurt.dur) { vignetteB('rgba(150,20,24,', (1 - hurt.t / hurt.dur) * 0.42, 0.7); hurt.t += dtR; }
    if (ts < 0.99 && ts > 0.05) vignetteB('rgba(70,90,130,', 0.34 * (1 - ts), 0.6);
    dashFx.t += dtR;
  }

  function drawScreenFx(ts, dtR, rm) {
    if (B) { drawScreenFxB(ts, dtR, rm); return; } // [BDO]
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

  // [BDO] титр в духе BDO: кинорамки, «РЕГЕНТ НИМБА» крупно Forum с золотым градиентом и линиями, подзаголовок курсивом
  const introB = { name: '', src: '' };
  function titleBlock(title, sub, over, cy, size, a, grow, tone) {
    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * a;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const f = F('display', size);
    if (hasLS) ctx.letterSpacing = size > 56 ? '6px' : size > 40 ? '4px' : '3px';
    const w = tw(title, f);
    const rw = Math.min(W - 60, (w + size * 3.2)) * grow;
    rule(W / 2, cy - size * 0.78, rw, 0.9);
    rule(W / 2, cy + size * 0.66, rw, 0.9);
    diamond(W / 2, cy - size * 0.78 + 0.5, 3.2, BDO.goldHi, 'rgba(0,0,0,0.5)', 1);
    diamond(W / 2, cy + size * 0.66 + 0.5, 3.2, BDO.goldHi, 'rgba(0,0,0,0.5)', 1);
    if (grow > 0.6) {
      const ex = w / 2 + size * 0.55;
      diamond(W / 2 - ex, cy, 4, null, BDO.gold, 1.2); diamond(W / 2 + ex, cy, 4, null, BDO.gold, 1.2);
    }
    ctx.font = f;
    ctx.translate(W / 2, cy);
    ctx.lineWidth = Math.max(3, size * 0.08); ctx.strokeStyle = 'rgba(8,5,3,0.8)';
    if (!lowQ) { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 16; }
    ctx.strokeText(title, 0, 0);
    ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.fillStyle = tgrad(tone || 'gold', size); ctx.fillText(title, 0, 0);
    ctx.translate(-W / 2, -cy);
    if (hasLS) ctx.letterSpacing = '3px';
    if (over) txt(over, W / 2, cy - size * 0.78 - 16 * uiK, BDO.ivoryDim, F('display', 14 * uiK), 'center', 0.9);
    if (hasLS) ctx.letterSpacing = '0px';
    if (sub) txt(sub, W / 2, cy + size * 0.66 + 22 * uiK, BDO.ivory, F('italic', Math.max(17, size * 0.36), 500), 'center', 0.95);
    ctx.restore();
  }
  function drawIntroB(intro, snap, rm) {
    const T = num(intro.t, 0), D = Math.max(1, num(intro.duration, 5));
    const barIn = clamp(T / 0.6, 0, 1), barOut = clamp((D - T) / 0.5, 0, 1);
    const bh = H * 0.11 * Math.min(barIn, barOut);
    const base = ctx.globalAlpha;
    ctx.fillStyle = '#050403';
    ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
    ctx.fillStyle = 'rgba(138,106,62,0.5)';
    if (bh > 2) { ctx.fillRect(0, Math.round(bh), W, 1); ctx.fillRect(0, Math.round(H - bh) - 1, W, 1); }
    // имя цели: босс или соперник в PvP
    const op = snap && (snap.mode === 'pvp' || (isObj(snap.lockTarget) && snap.lockTarget.kind === 'player')) && isObj(snap.opponent) ? snap.opponent : null;
    const src = op ? String(op.name || 'Соперник') : '';
    if (introB.src !== src || !introB.name) { introB.src = src; introB.name = op ? src.toUpperCase() : 'РЕГЕНТ НИМБА'; }
    if (T > 1.0 && T < D - 0.6) {
      const a = clamp((T - 1.0) / 0.6, 0, 1) * clamp((D - 0.6 - T) / 0.4, 0, 1);
      const grow = rm ? 1 : ease((T - 1.0) / 0.9);
      titleBlock(introB.name, op ? 'Поединок' : 'Украденное солнце', op ? 'СОПЕРНИК' : 'ЦЕЛЬ ОБНАРУЖЕНА', H * 0.69, Math.round(clamp(H * 0.085, 40, 96)), a, grow, 'gold');
    }
    if (T > D - 0.9) {
      const k = (T - (D - 0.9)) / 0.9;
      titleBlock('К БОЮ', '', '', H * 0.5, Math.round(clamp(H * 0.08, 38, 90)), 1 - k, 1, 'ivory');
    }
    ctx.globalAlpha = base;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  }

  function drawIntro(intro, rm) {
    const T = num(intro.t, 0), D = Math.max(1, num(intro.duration, 5));
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

  // [BDO] отсчёт после паузы: цифра Cinzel в бронзовом кольце, подпись курсивом
  function drawResumeB(ms) {
    const n = clamp(Math.ceil(ms / 334), 1, 3);
    const size = Math.round(clamp(H * 0.12, 60, 130)), cy = H * 0.46, r = size * 0.78;
    const base = ctx.globalAlpha;
    ctx.save();
    ctx.globalAlpha = base * 0.95;
    ctx.fillStyle = 'rgba(10,8,6,0.55)'; ctx.beginPath(); ctx.arc(W / 2, cy, r, 0, TAU); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = BDO.bronze; ctx.stroke();
    ctx.lineWidth = 2.5; ctx.strokeStyle = BDO.gold;
    ctx.beginPath(); ctx.arc(W / 2, cy, r + 5, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(ms / 1002, 0, 1)); ctx.stroke();
    diamond(W / 2, cy - r - 5, 3.5, BDO.goldHi, null);
    ctx.translate(W / 2, cy + size * 0.04);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = F('num', size, 700);
    ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(8,5,3,0.9)';
    const ds = n === 1 ? '1' : n === 2 ? '2' : '3';
    ctx.strokeText(ds, 0, 0);
    ctx.fillStyle = tgrad('gold', size); ctx.fillText(ds, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    txt('Опустите руки · бой продолжится', W / 2, cy + r + 30 * uiK, BDO.ivory, F('italic', 20 * uiK, 500), 'center', 0.95);
    ctx.restore();
  }
  // [BDO] центральный титр: руна, печать, выброс, идеальный уклон
  function drawBanner(dtR, rm) {
    if (banner.t >= banner.dur || !banner.title) { banner.t += dtR; return; }
    const k = banner.t, D = banner.dur;
    const a = clamp(k / 0.2, 0, 1) * clamp((D - k) / 0.45, 0, 1);
    const size = Math.round(clamp(H * (banner.small ? 0.048 : 0.066), banner.small ? 26 : 34, banner.small ? 52 : 70));
    const grow = rm ? 1 : ease(k / 0.4);
    titleBlock(banner.title, banner.sub, '', H * 0.35 + (rm ? 0 : (1 - ease(k / 0.3)) * 8), size, a, grow, banner.tone);
    banner.t += dtR;
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
      // [BDO] стиль кадра; при ошибке в BDO-ветке — откат к прежнему виду до перезагрузки
      B = bdoOk && isBdo(f.settings);
      rmNow = rm; lowQ = !!(f.settings && f.settings.quality === 'low');
      band = clamp(H * 0.14, 92, 128); uiK = clamp(H / 768, 0.9, 1.3);
      if (B) gcCheck();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      drawn = true;
      const proj = (p) => { try { return f.project(p); } catch (e) { return null; } };
      const snap = f.snapshot;
      if (!paused) handleEvents(f.events, proj, snap, rm);
      if (screen === 'intro') {
        drawLock(snap, proj, rm, dtR, true);
        if (B) drawIntroB(isObj(f.intro) ? f.intro : { t: 0, duration: 5 }, snap, rm); // [BDO]
        else drawIntro(isObj(f.intro) ? f.intro : { t: 0, duration: 5 }, rm);
        return;
      }
      if (paused) ctx.globalAlpha = 0.6;
      drawLock(snap, proj, rm, dtR, false);
      drawPois(snap, proj, f.pois);
      drawTelegraphs(snap, proj);
      drawHero(snap, proj, f.input);
      if (!paused) drawStickHud(f.input, snap, dtR, rm);
      drawCombo(snap, dtR, rm);
      drawRune(f.input, rm, dtR);
      drawCoach(f.coach, dtR, rm);
      if (B) drawBanner(dtR, rm); // [BDO] титр руны/печати по центру
      drawCallouts(dtR, rm);
      drawScreenFx(num(f.timeScale, 1), dtR, rm);
      if (num(f.resumeLeftMs, 0) > 0) { if (B) drawResumeB(f.resumeLeftMs); else drawResume(f.resumeLeftMs); }
      if (!B && t - playingSince < 1.2 && playingSince >= 0) {   // [BDO] в стиле BDO титр зоны делает DOM-HUD
        ctx.globalAlpha = 1 - (t - playingSince) / 1.2;
        const explore = snap.player && snap.player.encounter === 'explore';
        tag(explore ? 'ПЛАТО · ИДИТЕ К РЕГЕНТУ' : 'БОЙ', W / 2, H * 0.36, GOLD_HI, `600 14px ${MONO}`, 'center');
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
    } catch (e) {
      if (B) { bdoOk = false; console.warn('[battleHud] BDO-слой отключён, прежний вид', e); } // [BDO]
      try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; } catch (e2) { /* ignore */ }
    }
  }

  function reset() {
    callouts.length = 0;
    combo = { n: 0, shown: 0, pop: 0, lost: 0, lostN: 0 };
    rune = { name: '', sub: '', t: 9, trail: null };
    flash.t = 1; hurt.t = 1; dashFx.t = 1; fizzleT = 9; coach = { hint: null, t: 9 }; lock.ok = false; lock.hitFlash = 0;
    banner.t = 9; banner.title = ''; coachB.hint = null; // [BDO]
    if (bdo) { try { bdo.reset(); } catch (e) { /* ignore */ } } // [BDO]
  }
  function dispose() { disposed = true; clearAll(); if (bdo) { try { bdo.dispose(); } catch (e) { /* ignore */ } } }
  return { frame, reset, dispose };
}
