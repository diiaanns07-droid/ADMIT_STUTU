// ASHEN OATH — core/bdoHud.js. Владелец: №8 [BDO].
// DOM-слой боевого HUD в стиле Black Desert поверх 3D-сцены и canvas-HUD (под экранами ui.js):
// панель умений с иконками и круговыми откатами, полосы HP/MP/выносливости, руны и печати,
// рамка цели (многослойная HP босса / соперник PvP), мини-карта, титр зоны, уведомления справа.
// Вызывается из core/battleHud.js каждый кадр с тем же объектом f (см. battleHud.js).
// При settings.bdoUi === false слой скрыт, а старый HUD ui.js работает как раньше.
//
// Правила кадра: DOM строится один раз в createBdoHud; в frame() — только запись стилей/текста
// при изменении (квантованного) значения, без new и без замыканий. Иконки (modules/bdoIcons.js),
// мини-карта (core/bdoMinimap.js) и стоимости умений (modules/combat.js) подгружаются динамически:
// ошибка в чужом модуле не ломает ни слой, ни игру. Любое исключение в кадре → слой выключается,
// класс html.bdoh-on снимается, и возвращается прежний HUD ui.js.

import { isBdo, ensureStyle } from './bdoTheme.js';

const isObj = (v) => v !== null && typeof v === 'object';
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const EMPTY = Object.freeze({});

// Панель умений: [id, подпись-жест]. Середина между крыльями — медальон движения (canvas battleHud).
const LEFT = [['bolt', 'OK'], ['spark', 'щелчок'], ['slash', 'ребро'], ['throw', 'две ладони']];
const RIGHT = [['shield', 'ладонь'], ['parry', 'кулак→ладонь'], ['burst', 'кулак'], ['dash', 'дёрг']];
const SKILL_NAME = { bolt: 'Снаряд', spark: 'Искра', slash: 'Рассечение', throw: 'Сфера', shield: 'Щит', parry: 'Отвод', burst: 'Выброс', dash: 'Рывок' };
const RUNES = [['ignis', '▲'], ['fulgur', 'ϟ'], ['orbis', '○'], ['stella', '★'], ['spira', '@'], ['lemnis', '∞'], ['caret', '^'], ['vee', 'V'], ['clepsydra', '⧗'], ['alpha', 'ℓ']];
const SIGILS = [['clap', '≋'], ['gate', '⊓'], ['frame', '▢'], ['delta', 'Δ'], ['cor', '♥']];
// Стоимость энергии: значения по умолчанию из modules/combat.js (DEFAULT_COMBAT_CONFIG);
// после динамической загрузки combat.js переписываются из его конфига.
const COST = { bolt: 0, spark: 5, slash: 12, throw: 8, shield: 12, parry: 0, burst: 40, dash: 20 };
const RUNE_COST = { ignis: 25, fulgur: 30, orbis: 20, stella: 40, spira: 25, lemnis: 30, caret: 18, vee: 25, clepsydra: 35, alpha: 0 };
const SIGIL_COST = { clap: 25, gate: 30, frame: 20, delta: 50, cor: 40 };

const BOSS_NAME = 'Регент Нимба';
// Цвета слоёв HP босса (как у боссов BDO): слой 1 — последний, кровавый.
const LAYER_COLORS = ['#a3161c', '#b8452a', '#b86e24', '#a58c2a', '#6e8c2e', '#2e8a6c', '#2a6c9c', '#4a4fae', '#7a3ea0', '#a02e72'];
const HERO_LABEL = { ashen: 'Пепельный страж', elf: 'Эльфийка', dark: 'Тёмная чародейка', warrior: 'Эльфийка' };
const ZONE_SUB = {
  arena: 'Круг, где держат в плену солнце',
  shrine: 'Здесь давали клятву первые стражи',
  city: 'Пепел на мостовых ещё тёплый',
  forest: 'Деревья помнят огонь',
  lake: 'Вода отражает то, чего нет',
  graves: 'Великаны спят под камнем',
  hill: 'Отсюда видно всё плато',
  gate: 'Последний рубеж старой стены',
  elves: 'Огни среди корней',
  'bright-forest': 'Земли, куда не дотянулось затмение',
};
const OPEN_LAND = 'Плато Нимба';
const NOTE_MAX = 4;
const NOTE_LIFE = 3.5;
const ZONE_IN = 0.8, ZONE_HOLD = 2.6, ZONE_OUT = 1.2;
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  e._s = {};
  return e;
}
// Запись только при изменении
function txt(e, v) { if (e._t !== v) { e._t = v; e.textContent = v; } }
function sty(e, prop, v) { if (e._s[prop] !== v) { e._s[prop] = v; e.style.setProperty(prop, v); } }
function cls(e, c, on) { if (e.classList.contains(c) !== on) e.classList.toggle(c, on); }
function hide(e, on) { if (e._h !== on) { e._h = on; e.hidden = on; } }
function attr(e, a, v) { if (e.getAttribute(a) !== v) e.setAttribute(a, v); }
function scaleX(e, frac) {
  const q = Math.round(clamp(frac, 0, 1) * 1000);
  if (e._q !== q) { e._q = q; e.style.transform = `scaleX(${q / 1000})`; }
}
function fmtSec(rem) { return rem < 1 ? rem.toFixed(1) : String(Math.ceil(rem)); }
function secKey(rem) { return rem < 1 ? Math.round(rem * 10) : 100 + Math.ceil(rem); }

export function createBdoHud({ root } = {}) {
  const NOOP = { frame() {}, reset() {}, dispose() {} };
  if (typeof document === 'undefined' || !root || !root.appendChild) return NOOP;
  try { ensureStyle(new URL('./bdoHud.css', import.meta.url).href, 'bdoHud'); } catch (e) { return NOOP; }
  const html = document.documentElement;
  if (!html._s) html._s = {};

  let iconFn = null;          // iconSvg из modules/bdoIcons.js (грузится динамически)
  let minimap = null;         // createMinimap из core/bdoMinimap.js
  let zoneAtFn = null;        // zoneAt(layout, x, z) из bdoMinimap.js, если есть
  let disposed = false, failed = false;
  let t = 0;
  let lastScreen = '';
  let shown = false;

  // ------------------------------------------------------------------------------ DOM (один раз)
  const layer = h('div', 'bdo-hud');
  layer.hidden = true; layer._h = true;
  layer.setAttribute('aria-hidden', 'true');

  const iconSlots = [];     // [{el, id}] — заполняются, когда загрузится bdoIcons.js
  function iconSlot(el, id) { el.classList.add('bdoh-icon'); el._icon = id; iconSlots.push(el); if (iconFn) fillIcon(el); return el; }
  function fillIcon(el) { try { const s = iconFn(el._icon); if (typeof s === 'string' && el._iconHtml !== s) { el._iconHtml = s; el.innerHTML = s; } } catch (e) { /* без иконки */ } }
  function setIcon(el, id) { if (el._icon !== id) { el._icon = id; if (iconFn) fillIcon(el); } }

  function makeCell(parent, id, glyph) {
    const node = h('div', 'bdoh-cell', parent);
    node.setAttribute('data-state', 'ready');
    h('span', 'bdoh-cell__in', node);
    const icon = iconSlot(h('span', 'bdoh-cell__icon', node), id);
    h('span', 'bdoh-cell__tint', node);
    h('span', 'bdoh-cell__shade', node);
    h('span', 'bdoh-cell__flash', node);
    if (glyph) h('span', 'bdoh-cell__glyph', node, glyph);
    const time = h('span', 'bdoh-cell__time', node);
    return { id, node, icon, time, st: 'ready', cdQ: -1, tk: -1, flashF: -1, castF: -1, castT: 0 };
  }

  // Панель умений
  const bar = h('div', 'bdoh-bar', layer);
  const wingL = h('div', 'bdoh-wing bdoh-wing--l', bar);
  const mid = h('div', 'bdoh-mid', bar);
  const wingR = h('div', 'bdoh-wing bdoh-wing--r', bar);
  function makeRes(parent, kind) {
    const node = h('div', `bdoh-res bdoh-res--${kind}`, parent);
    const glow = h('span', 'bdoh-res__glow', node);
    const lagE = h('span', 'bdoh-res__lag', node);
    const fill = h('span', 'bdoh-res__fill', node);
    h('span', 'bdoh-res__gloss', node);
    const numE = h('span', 'bdoh-res__num', node);
    return { node, glow, lagE, fill, numE, frac: 1, lag: 1, hold: 0, key: -1 };
  }
  const hp = makeRes(wingL, 'hp');
  const mp = makeRes(wingR, 'mp');
  const skills = [];
  for (const [list, wing] of [[LEFT, wingL], [RIGHT, wingR]]) {
    const row = h('div', 'bdoh-cells', wing);
    for (const [id, hint] of list) {
      const slot = h('div', 'bdoh-slot', row);
      const c = makeCell(slot, id, null);
      c.node.setAttribute('aria-label', SKILL_NAME[id]);
      h('span', 'bdoh-slot__hint', slot, hint);
      skills.push(c);
    }
  }
  const SK = {};
  for (const c of skills) SK[c.id] = c;

  // Выносливость — дуга под медальоном (геометрия в layout())
  const stam = document.createElementNS(SVG_NS, 'svg');
  stam.setAttribute('class', 'bdoh-stam');
  stam._s = {};
  const stamBg = document.createElementNS(SVG_NS, 'path');
  stamBg.setAttribute('class', 'bdoh-stam__bg');
  const stamFg = document.createElementNS(SVG_NS, 'path');
  stamFg.setAttribute('class', 'bdoh-stam__fg');
  stamFg.setAttribute('pathLength', '100');
  stamBg.setAttribute('pathLength', '100');
  stam.appendChild(stamBg); stam.appendChild(stamFg);
  layer.appendChild(stam);
  const stamS = { q: -1, on: false, sprint: false };

  // Руны и печати
  const runesBox = h('div', 'bdoh-runes', layer);
  const colR = h('div', 'bdoh-col bdoh-col--runes', runesBox);
  const colS = h('div', 'bdoh-col bdoh-col--sigils', runesBox);
  const runes = RUNES.map(([id, g]) => makeCell(colR, id, g));
  const sigils = SIGILS.map(([id, g]) => makeCell(colS, id, g));
  const RU = {}, SI = {};
  for (const c of runes) RU[c.id] = c;
  for (const c of sigils) SI[c.id] = c;

  // Рамка цели
  const tgt = h('div', 'bdoh-target', layer);
  tgt.hidden = true; tgt._h = true;
  const tName = h('div', 'bdoh-target__name', tgt);
  const tNameText = h('span', 'bdoh-target__nm', tName, BOSS_NAME);
  const tSleep = h('span', 'bdoh-target__sleep', tName, '· спит');
  const tRow = h('div', 'bdoh-target__row', tgt);
  const tIcon = iconSlot(h('span', 'bdoh-target__icon', tRow), 'boss');
  const thp = h('div', 'bdoh-thp', tRow);
  const thpUnder = h('span', 'bdoh-thp__under', thp);
  const thpLag = h('span', 'bdoh-thp__lag', thp);
  const thpFill = h('span', 'bdoh-thp__fill', thp);
  h('span', 'bdoh-thp__gloss', thp);
  const tCount = h('span', 'bdoh-target__count', tRow);
  const ten = h('div', 'bdoh-ten', tgt);
  const tenFill = h('span', 'bdoh-ten__fill', ten);
  const tSub = h('div', 'bdoh-target__sub', tgt);
  const tDanger = h('span', 'bdoh-target__danger', tSub);
  const tDangerK = h('span', null, tDanger, 'Опасность ');
  const tDangerV = h('b', null, tDanger, '◆◆◆◆◇');
  const tStage = h('span', 'bdoh-target__stage', tSub, 'Вторая стадия');
  const tHero = h('span', 'bdoh-target__hero', tSub);
  const tChips = h('span', 'bdoh-target__chips', tSub);
  function chip(id, label) {
    const c = h('span', 'bdoh-chip', tChips);
    iconSlot(h('span', 'bdoh-chip__i', c), id);
    h('span', null, c, label);
    c.hidden = true; c._h = true;
    return c;
  }
  const CH = { stun: chip('fulgur', 'оглушён'), mark: chip('frame', 'метка'), slow: chip('clepsydra', 'замедлен'), shield: chip('shield', 'щит'), invul: chip('dash', 'неуязвим') };
  const tPct = h('span', 'bdoh-target__pct', tSub);
  const score = h('div', 'bdoh-score', layer);
  score.hidden = true; score._h = true;
  const scoreRound = h('span', null, score, 'Раунд 1');
  h('span', null, score, ' · ');
  const scoreMe = h('b', null, score, '0');
  h('span', null, score, ' : ');
  const scoreOpp = h('b', null, score, '0');
  const tS = { mode: '', hp: -1, lagHp: -1, hold: 0, layerN: -1, cntKey: -1, pctKey: -1, maxHp: 0 };
  const pvpS = { round: 0, me: 0, opp: 0, seen: false, key: -1 };

  // Мини-карта
  const map = h('div', 'bdoh-map', layer);
  const ring = h('div', 'bdoh-map__ring', map);
  const mapCv = h('canvas', 'bdoh-map__cv', ring);
  h('span', 'bdoh-map__frame', ring);
  h('span', 'bdoh-map__tick bdoh-map__tick--e', ring);
  h('span', 'bdoh-map__tick bdoh-map__tick--s', ring);
  h('span', 'bdoh-map__tick bdoh-map__tick--w', ring);
  h('span', 'bdoh-map__n', ring, 'С');
  const mapZone = h('div', 'bdoh-map__zone', map, OPEN_LAND);
  const mapXY = h('div', 'bdoh-map__xy', map, 'X 0 · Z 0');
  const mapInfo = { size: 160, dpr: 1 };
  const mapS = { acc: 1, zoneAcc: 1, xk: 1e9, zk: 1e9, errs: 0 };
  const zoneOut = {};   // переиспользуемый результат zoneAt (без аллокаций)

  // Уведомления
  const notesBox = h('div', 'bdoh-notes', layer);
  const notes = [];
  for (let i = 0; i < NOTE_MAX; i++) {
    const el = h('div', 'bdoh-note', notesBox);
    const tx = h('div', 'bdoh-note__txt', el);
    const tt = h('div', 'bdoh-note__t', tx);
    const ts = h('div', 'bdoh-note__s', tx);
    const ic = iconSlot(h('span', 'bdoh-note__i', el), 'ember');
    notes.push({ el, tt, ts, ic, live: false, t: 0, seq: 0, idx: -1, pending: false, tfKey: '' });
  }
  let noteSeq = 0;

  // Титр зоны
  const zone = h('div', 'bdoh-zone', layer);
  const zRow = h('div', 'bdoh-zone__row', zone);
  h('span', 'bdoh-zone__line bdoh-zone__line--l', zRow);
  const zName = h('div', 'bdoh-zone__name', zRow);
  h('span', 'bdoh-zone__line bdoh-zone__line--r', zRow);
  const zSub = h('div', 'bdoh-zone__sub', zone);
  zone.hidden = true; zone._h = true;
  const zS = { t: 99, phase: 0, wait: 0, cur: null, curId: '', check: 1, lastEvId: '', lastEvT: -99, lastShowId: '', lastShowT: -99 };

  root.insertBefore(layer, root.querySelector('#ao-ui-root'));

  // ------------------------------------------------------------ динамические зависимости (чужие модули)
  import('../modules/bdoIcons.js').then((m) => {
    if (disposed || !m || typeof m.iconSvg !== 'function') return;
    iconFn = m.iconSvg;
    for (const el of iconSlots) fillIcon(el);
  }).catch((e) => console.warn('[bdoHud] bdoIcons', e));
  import('./bdoMinimap.js').then((m) => {
    if (disposed || !m) return;
    if (typeof m.zoneAt === 'function') zoneAtFn = m.zoneAt;
    if (typeof m.createMinimap === 'function') {
      try { minimap = m.createMinimap({ canvas: mapCv }); } catch (e) { console.warn('[bdoHud] minimap', e); minimap = null; }
    }
  }).catch((e) => console.warn('[bdoHud] bdoMinimap', e));
  import('../modules/combat.js').then((m) => {
    const C = m && m.DEFAULT_COMBAT_CONFIG;
    if (!isObj(C)) return;
    const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    if (C.bolt) COST.bolt = n(C.bolt.energyCost, COST.bolt);
    if (C.spark) COST.spark = n(C.spark.cost, COST.spark);
    if (C.slash) COST.slash = n(C.slash.cost, COST.slash);
    if (C.throw) COST.throw = n(C.throw.energyBase, COST.throw);
    if (C.shield) COST.shield = n(C.shield.minEnergyToStart, COST.shield);
    if (C.burst) COST.burst = n(C.burst.cost, COST.burst);
    if (C.dash) COST.dash = n(C.dash.cost, COST.dash);
    if (isObj(C.runes)) for (const k in RUNE_COST) if (isObj(C.runes[k])) RUNE_COST[k] = n(C.runes[k].energy, RUNE_COST[k]);
    if (isObj(C.sigils)) for (const k in SIGIL_COST) if (isObj(C.sigils[k])) SIGIL_COST[k] = n(C.sigils[k].energy, SIGIL_COST[k]);
  }).catch(() => { /* остаются значения по умолчанию */ });

  // ----------------------------------------------------------------------------------- раскладка
  let vw = 0, vh = 0, K = 1;
  function layout(w, hh) {
    vw = w; vh = hh;
    K = clamp(Math.min(hh / 768, w / 1366), 0.8, 1.25);
    sty(layer, '--k', K.toFixed(3));
    const band = clamp(hh * 0.14, 92, 128);
    // Каст-бар ui.js (.ao-tele) — под рамкой цели: 10k + 76k + 6k
    sty(html, '--bdoh-tele-top', `${Math.round(92 * K)}px`);
    sty(html, '--bdoh-tele-w', `${Math.round(400 * K)}px`);
    sty(html, '--bdoh-tk', K.toFixed(3));
    // Мини-карта ~170 px на 768, ~140 на 650
    const S = Math.round(clamp(170 * K, 120, 200));
    sty(map, '--S', `${S}px`);
    const dpr = clamp(num(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1), 1, 2);
    const inner = S - 6;
    mapInfo.size = inner; mapInfo.dpr = dpr;
    const bw = Math.round(inner * dpr);
    if (mapCv.width !== bw) { mapCv.width = bw; mapCv.height = bw; }
    mapS.acc = 1;
    // Уведомления — под подписью зоны
    sty(notesBox, 'top', `${Math.round(14 * K + S + 52 * K)}px`);
    // Дуга выносливости: медальон canvas — центр (W/2, H − band/2 − 4), радиус band·0.42
    const R = band * 0.42 + 7 * K, cx = w / 2, cy = hh - band / 2 - 4, sw = Math.max(2, 3 * K);
    const pad = sw * 2;
    const box = R * 2 + pad * 2;
    sty(stam, 'left', `${Math.round(cx - box / 2)}px`);
    sty(stam, 'top', `${Math.round(cy - box / 2)}px`);
    stam.setAttribute('width', String(Math.round(box)));
    stam.setAttribute('height', String(Math.round(box)));
    stam.setAttribute('viewBox', `0 0 ${Math.round(box)} ${Math.round(box)}`);
    const c0 = Math.round(box) / 2;
    const a0 = (150 * Math.PI) / 180, a1 = (30 * Math.PI) / 180;   // нижняя дуга слева направо (y вниз)
    const x0 = c0 + R * Math.cos(a0), y0 = c0 + R * Math.sin(a0), x1 = c0 + R * Math.cos(a1), y1 = c0 + R * Math.sin(a1);
    const d = `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R.toFixed(1)} ${R.toFixed(1)} 0 0 0 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    stamBg.setAttribute('d', d); stamFg.setAttribute('d', d);
    stamBg.setAttribute('stroke-width', (sw + 2).toFixed(1));
    stamFg.setAttribute('stroke-width', sw.toFixed(1));
  }

  // ------------------------------------------------------------------------------ видимость слоя
  function setShown(on) {
    if (shown === on) return;
    shown = on;
    hide(layer, !on);
    cls(html, 'bdoh-on', on);
  }

  // ----------------------------------------------------------------------------------- уведомления
  function note(icon, title, sub, tone) {
    let s = null;
    for (const n of notes) if (!n.live && (!s || n.seq < s.seq)) s = n;
    if (!s) { for (const n of notes) if (!s || n.seq < s.seq) s = n; }
    s.live = true; s.t = 0; s.seq = ++noteSeq; s.pending = true;
    txt(s.tt, title);
    txt(s.ts, sub || '');
    hide(s.ts, !sub);
    attr(s.el, 'data-tone', tone || 'gold');
    setIcon(s.ic, icon);
    cls(s.el, 'is-in', false);
    cls(s.el, 'is-reset', true);
    relayoutNotes();
  }
  // Раскладка стопки: новое сверху; ещё не въехавшее (pending) — сдвинуто вправо.
  function relayoutNotes() {
    const step = Math.round(48 * K);
    for (const n of notes) {
      if (!n.live) continue;
      let idx = 0;
      for (const m of notes) if (m.live && m.seq > n.seq) idx++;
      n.idx = idx;
      const x = n.pending ? Math.round(60 * K) : 0;
      const key = `${x},${idx * step}`;
      if (n.tfKey !== key) { n.tfKey = key; n.el.style.transform = `translate(${x}px, ${idx * step}px)`; }
    }
  }
  function updateNotes(dt, rm) {
    let changed = false;
    for (const n of notes) {
      if (!n.live) continue;
      if (n.pending) {
        if (n.t > 0) {   // хотя бы один кадр отрисован в начальной позиции
          n.pending = false;
          cls(n.el, 'is-reset', false);
          cls(n.el, 'is-in', true);
          changed = true;
        }
        n.t += dt > 0 ? dt : 0.016;
        continue;
      }
      n.t += dt;
      if (n.t > NOTE_LIFE) {
        n.live = false;
        cls(n.el, 'is-in', false);
        if (!rm) { const y = n.idx * Math.round(48 * K); const key = `${Math.round(24 * K)},${y}`; n.tfKey = key; n.el.style.transform = `translate(${Math.round(24 * K)}px, ${y}px)`; }
        changed = true;
      }
    }
    if (changed) relayoutNotes();
  }

  // ----------------------------------------------------------------------------------- титр зоны
  function showZone(id, name, sub) {
    if (!name) return;
    zS.lastShowId = id || name; zS.lastShowT = t;
    zName.setAttribute('data-text', name);
    txt(zName, name);
    txt(zSub, sub || '');
    hide(zSub, !sub);
    hide(zone, false);
    cls(zone, 'is-on', false);
    cls(zone, 'is-reset', true);
    zS.t = 0; zS.phase = 1; zS.wait = 1;
  }
  function updateZoneTitle(dt) {
    if (zS.phase === 0) return;
    zS.t += dt > 0 ? dt : 0;
    if (zS.phase === 1) {                 // один кадр в начальной позиции → проявление
      if (zS.wait > 0) { zS.wait--; zS.t = 0; return; }
      cls(zone, 'is-reset', false); cls(zone, 'is-on', true); zS.phase = 2; zS.t = 0;
    } else if (zS.phase === 2 && zS.t > ZONE_IN + ZONE_HOLD) {
      cls(zone, 'is-on', false); zS.phase = 3;
    } else if (zS.phase === 3 && zS.t > ZONE_IN + ZONE_HOLD + ZONE_OUT + 0.1) {
      hide(zone, true); zS.phase = 0;
    }
  }
  // Запасной путь: вход в зону по layout.landmarks (внутри r; выход — за 1.15r)
  function detectZone(layout, px, pz) {
    const L = isObj(layout) && Array.isArray(layout.landmarks) ? layout.landmarks : null;
    if (!L) return;
    const cur = zS.cur;
    if (cur) {
      const d = Math.hypot(px - num(cur.x), pz - num(cur.z));
      if (d <= num(cur.r, 0) * 1.15) {
        // внутри текущей — но, возможно, вошли в меньшую вложенную
        let best = null, bn = 1;
        for (let i = 0; i < L.length; i++) {
          const m = L[i];
          if (!isObj(m) || m === cur || !(num(m.r, 0) > 0) || !(m.r < cur.r)) continue;
          const dn = Math.hypot(px - num(m.x), pz - num(m.z)) / m.r;
          if (dn < 1 && dn < bn) { bn = dn; best = m; }
        }
        if (!best) return;
        zS.cur = best;
        enterZone(best);
        return;
      }
      zS.cur = null;
    }
    let best = null, bn = 1;
    for (let i = 0; i < L.length; i++) {
      const m = L[i];
      if (!isObj(m) || !(num(m.r, 0) > 0)) continue;
      const dn = Math.hypot(px - num(m.x), pz - num(m.z)) / m.r;
      if (dn < 1 && dn < bn) { bn = dn; best = m; }
    }
    if (best) { zS.cur = best; enterZone(best); }
  }
  function enterZone(m) {
    const id = String(m.id || m.name || '');
    if (id && zS.lastEvId === id && t - zS.lastEvT < 5) return;      // zone_enter уже пришёл
    if (id && zS.lastShowId === id && t - zS.lastShowT < 5) return;  // уже показан
    const name = String(m.name || '');
    showZone(id, name, ZONE_SUB[id] || '');
    note('prism', name, '', 'dim');
  }

  // --------------------------------------------------------------------------------------- события
  function handleEvents(events) {
    if (!Array.isArray(events)) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!isObj(e)) continue;
      const d = isObj(e.data) ? e.data : EMPTY;
      const remote = d.remote === true;
      switch (e.type) {
        case 'rune_cast': if (!remote && RU[d.rune]) { RU[d.rune].flashF = 2; RU[d.rune].castF = 2; } break;
        case 'sigil_cast': if (!remote && SI[d.sigil]) { SI[d.sigil].flashF = 2; SI[d.sigil].castF = 2; } break;
        case 'ember_lit': {
          if (remote) break;
          const pts = Math.round(num(d.points, 3));
          const tot = Math.round(num(d.total, 0));
          note('ember', `Уголь клятвы зажжён · +${pts}`, tot > 0 ? `${Math.round(num(d.lit, 0))} / ${tot}` : 'Клятва крепнет', 'ember');
          break;
        }
        case 'encounter_start':
          note('boss', 'Регент пробудился', d.reason === 'aggro' ? 'Удар издали не остался незамеченным' : 'Вы ступили в круг арены', 'blood');
          break;
        case 'encounter_end': note('boss', 'Регент забыл вас', 'Бой прерван — вы покинули арену', 'dim'); break;
        case 'boss_phase':
          if (num(d.stage, 0) === 2 && !d.awaken) note('skull', 'Нимб трескается', 'Вторая стадия · Регент в ярости', 'blood');
          break;
        case 'pvp_round': onPvpRound(d); break;
        case 'zone_enter': {
          const id = String(d.zoneId || d.name || '');
          const name = String(d.name || '');
          if (!name) break;
          const dup = id && zS.lastShowId === id && t - zS.lastShowT < 5;
          zS.lastEvId = id; zS.lastEvT = t;
          if (!dup) { showZone(id, name, typeof d.subtitle === 'string' ? d.subtitle : (ZONE_SUB[id] || '')); note('prism', name, '', 'dim'); }
          break;
        }
        default: break;
      }
    }
  }
  function winnerSide(w) {
    if (w === 'me' || w === 'self' || w === 'local' || w === 0 || w === true) return 1;
    if (w === 'opp' || w === 'opponent' || w === 'remote' || w === 'enemy' || w === 1 || w === false) return -1;
    return 0;
  }
  function onPvpRound(d) {
    if (Array.isArray(d.score)) { pvpS.me = Math.round(num(d.score[0], pvpS.me)); pvpS.opp = Math.round(num(d.score[1], pvpS.opp)); }
    if (num(d.round, 0) > 0) pvpS.round = Math.round(d.round);
    pvpS.seen = true;
    const sc = `Счёт ${pvpS.me} : ${pvpS.opp}`;
    const w = winnerSide(d.winner);
    switch (d.phase) {
      case 'countdown': note('slash', `Раунд ${pvpS.round || 1}`, 'Приготовьтесь', 'gold'); break;
      case 'fight': note('slash', `Раунд ${pvpS.round || 1} · в бой`, sc, 'ember'); break;
      case 'round_end': note('slash', w > 0 ? 'Раунд за вами' : w < 0 ? 'Раунд за соперником' : 'Раунд окончен', sc, w < 0 ? 'blood' : 'gold'); break;
      case 'match_end': note('skull', w > 0 ? 'Победа в дуэли' : w < 0 ? 'Поражение в дуэли' : 'Дуэль окончена', sc, w < 0 ? 'blood' : 'gold'); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------------------ полосы HP / MP
  function paintRes(r, cur, max, dt, lowPulse) {
    const m = max > 0 ? max : 1;
    const v = clamp(cur, 0, m);
    const frac = v / m;
    if (r.key < 0) { r.frac = frac; r.lag = frac; }    // первый кадр боя — без «догоняющего» хвоста
    if (frac < r.frac - 0.0005) r.hold = 0.5;         // новый урон — «догоняющий» слой ждёт ~0.5 с
    r.frac = frac;
    if (r.lag < frac) r.lag = frac;
    else if (r.lag > frac) {
      if (r.hold > 0) r.hold -= dt;
      else r.lag = Math.max(frac, r.lag - Math.max(0.25 * dt, (r.lag - frac) * 3 * dt));
    }
    scaleX(r.fill, frac);
    scaleX(r.lagE, r.lag);
    const key = Math.ceil(v) * 100000 + Math.round(m);
    if (r.key !== key) { r.key = key; txt(r.numE, `${Math.ceil(v)} / ${Math.round(m)}`); }
    if (lowPulse !== undefined) cls(r.node, 'is-low', lowPulse);
  }

  // --------------------------------------------------------------------------------- ячейки
  function paintCell(c, st, rem, tot, dt) {
    if (st !== c.st) {
      if (c.st === 'cooldown' && (st === 'ready' || st === 'active')) c.flashF = 2;   // вспышка готовности
      c.st = st;
      c.node.setAttribute('data-state', st);
    }
    const cooling = st === 'cooldown';
    const q = cooling && tot > 0 ? Math.round(clamp(rem / tot, 0, 1) * 200) : 0;
    if (q !== c.cdQ) { c.cdQ = q; c.node.style.setProperty('--cd', (q / 200).toFixed(3)); }
    const k = cooling ? secKey(rem) : -1;
    if (k !== c.tk) { c.tk = k; txt(c.time, cooling ? fmtSec(rem) : ''); }
    // вспышка: класс держится 2 кадра (считаем кадры, не время — на медленной машине dt велик),
    // затем гаснет через transition
    if (c.flashF > 0) { cls(c.node, 'is-flash', true); c.flashF--; }
    else if (c.flashF === 0) { cls(c.node, 'is-flash', false); c.flashF = -1; }
    // «щелчок» руны/печати: снять класс → со следующего кадра поставить (перезапуск анимации без reflow)
    if (c.castF === 2) { cls(c.node, 'is-cast', false); c.castF = 1; }
    else if (c.castF === 1) { cls(c.node, 'is-cast', true); c.castF = 0; c.castT = 0; }
    else if (c.castF === 0) { c.castT += dt; if (c.castT > 0.7) { cls(c.node, 'is-cast', false); c.castF = -1; } }
  }
  function cdState(alive, rem, lowE, active) {
    if (!alive) return 'off';
    if (active) return 'active';
    if (rem > 0.05) return 'cooldown';
    if (lowE) return 'low';
    return 'ready';
  }

  function updateSkills(snap, input, dt) {
    const P = isObj(snap.player) ? snap.player : null;
    const cd = isObj(snap.cooldowns) ? snap.cooldowns : EMPTY;
    const alive = !!P && P.action !== 'dead' && (!snap.status || snap.status === 'playing');
    const en = P ? num(P.energy, 0) : 0;
    const act = P ? P.action : '';
    const live = isObj(input) && input.valid !== false;
    // левое крыло
    paintCell(SK.bolt, cdState(alive, 0, en < COST.bolt, act === 'cast' || (live && !!input.attack)), 0, 0, dt);
    let r = Math.max(0, num(cd.sparkRemaining)); paintCell(SK.spark, cdState(alive, r, en < COST.spark, false), r, num(cd.sparkTotal), dt);
    r = Math.max(0, num(cd.slashRemaining)); paintCell(SK.slash, cdState(alive, r, en < COST.slash, false), r, num(cd.slashTotal), dt);
    r = Math.max(0, num(cd.throwRemaining)); paintCell(SK.throw, cdState(alive, r, en < COST.throw, !!(P && P.conjure)), r, num(cd.throwTotal), dt);
    // правое крыло
    paintCell(SK.shield, cdState(alive, 0, en < COST.shield, !!(P && P.shielding === true)), 0, 0, dt);
    r = Math.max(0, num(cd.parryRemaining)); paintCell(SK.parry, cdState(alive, r, false, !!(P && num(P.parryWindow, 0) > 0)), r, num(cd.parryTotal), dt);
    r = Math.max(0, num(cd.burstRemaining)); paintCell(SK.burst, cdState(alive, r, en < COST.burst, !!(P && num(P.burstCharge, 0) > 0.05)), r, num(cd.burstTotal), dt);
    r = Math.max(0, num(cd.dashRemaining)); paintCell(SK.dash, cdState(alive, r, en < COST.dash, !!(P && (P.dashing === true || act === 'dash'))), r, num(cd.dashTotal), dt);
    // руны и печати
    const rc = isObj(cd.runes) ? cd.runes : EMPTY;
    for (let i = 0; i < runes.length; i++) {
      const c = runes[i];
      const o = isObj(rc[c.id]) ? rc[c.id] : EMPTY;
      const rem = Math.max(0, num(o.remaining));
      paintCell(c, cdState(alive, rem, en < RUNE_COST[c.id], false), rem, num(o.total), dt);
    }
    const sc = isObj(cd.sigils) ? cd.sigils : EMPTY;
    for (let i = 0; i < sigils.length; i++) {
      const c = sigils[i];
      const o = isObj(sc[c.id]) ? sc[c.id] : EMPTY;
      const rem = Math.max(0, num(o.remaining));
      paintCell(c, cdState(alive, rem, en < SIGIL_COST[c.id], false), rem, num(o.total), dt);
    }
    // полосы
    if (P) {
      const maxHp = Math.max(1e-6, num(P.maxHp, 100));
      const hpv = num(P.hp, 0);
      paintRes(hp, hpv, maxHp, dt, hpv / maxHp < 0.25 && hpv > 0);
      paintRes(mp, en, Math.max(1e-6, num(P.maxEnergy, 100)), dt);
    }
    // выносливость: готовность рывка + спринт
    const dTot = num(cd.dashTotal, 0);
    const dRem = Math.max(0, num(cd.dashRemaining, 0));
    const ready = dTot > 0 ? clamp(1 - dRem / dTot, 0, 1) : 1;
    const sprint = !!P && num(P.sprint, 0) > 0.05;
    const q = Math.round(ready * 100);
    if (q !== stamS.q) { stamS.q = q; stamFg.setAttribute('stroke-dasharray', `${q} 100`); }
    const on = alive && (q < 100 || sprint);
    if (on !== stamS.on) { stamS.on = on; stam.classList.toggle('is-on', on); }
    if (sprint !== stamS.sprint) { stamS.sprint = sprint; stam.classList.toggle('is-sprint', sprint); }
  }

  // --------------------------------------------------------------------------------- рамка цели
  function updateTarget(snap, dt) {
    const P = isObj(snap.player) ? snap.player : null;
    const B = isObj(snap.boss) ? snap.boss : null;
    const lt = isObj(snap.lockTarget) ? snap.lockTarget : null;
    const O = isObj(snap.opponent) ? snap.opponent : null;
    const pvp = snap.mode === 'pvp' || (!!lt && lt.kind === 'player');
    let mode = '';
    if (pvp) mode = O ? 'pvp' : '';
    else if (B && (lt ? lt.kind === 'boss' : !!P && P.encounter === 'engaged')) mode = 'boss';
    else if (B && P && isObj(P.position) && isObj(B.position) && B.action !== 'dead'
      && Math.hypot(num(P.position.x) - num(B.position.x), num(P.position.z) - num(B.position.z)) <= 40) mode = 'sleep';
    hide(tgt, !mode);
    hide(score, !(pvp && pvpS.seen));
    if (pvp && pvpS.seen) {
      const sk = (pvpS.round || 1) * 10000 + pvpS.me * 100 + pvpS.opp;
      if (sk !== pvpS.key) {
        pvpS.key = sk;
        txt(scoreRound, `Раунд ${pvpS.round || 1}`);
        txt(scoreMe, String(pvpS.me));
        txt(scoreOpp, String(pvpS.opp));
      }
    }
    if (!mode) { tS.mode = ''; return; }
    if (mode !== tS.mode) {
      tS.mode = mode;
      tS.hp = -1; tS.lagHp = -1; tS.layerN = -1; tS.cntKey = -1; tS.pctKey = -1;
      cls(tgt, 'is-pvp', mode === 'pvp');
      cls(tgt, 'is-boss', mode === 'boss');
      cls(tgt, 'is-sleep', mode === 'sleep');
      hide(tSleep, mode !== 'sleep');
      hide(ten, mode !== 'pvp');
      hide(tCount, mode === 'pvp');
      hide(tHero, mode !== 'pvp');
      hide(tDanger, mode === 'pvp');
      setIcon(tIcon, mode === 'pvp' ? 'skull' : 'boss');
      if (mode !== 'pvp') { txt(tNameText, BOSS_NAME); }
      if (mode === 'pvp') { thpUnder.style.backgroundColor = 'transparent'; thpFill.style.backgroundColor = LAYER_COLORS[0]; }
    }
    if (mode === 'sleep') return;
    const src = mode === 'pvp' ? O : B;
    const maxHp = Math.max(1, num(src.maxHp, mode === 'pvp' ? 100 : 1000));
    const hpv = clamp(num(src.hp, 0), 0, maxHp);
    const dead = hpv <= 0 || src.action === 'dead';
    cls(tgt, 'is-dead', dead);
    // догоняющий слой (в единицах HP)
    if (tS.lagHp < 0 || hpv >= tS.lagHp) { tS.lagHp = hpv; tS.hold = 0; }
    else {
      if (hpv < tS.hp - 0.01) tS.hold = 0.5;
      if (tS.hold > 0) tS.hold -= dt;
      else tS.lagHp = Math.max(hpv, tS.lagHp - Math.max(maxHp * 0.06 * dt, (tS.lagHp - hpv) * 3 * dt));
    }
    tS.hp = hpv;
    if (mode === 'pvp') {
      txt(tNameText, typeof O.name === 'string' && O.name ? O.name : 'Соперник');
      txt(tHero, HERO_LABEL[O.hero] || '');
      scaleX(thpFill, hpv / maxHp);
      scaleX(thpLag, tS.lagHp / maxHp);
      scaleX(tenFill, num(O.maxEnergy, 0) > 0 ? num(O.energy, 0) / O.maxEnergy : 0);
      const pk = Math.ceil(hpv) * 10000 + Math.round(maxHp);
      if (pk !== tS.pctKey) { tS.pctKey = pk; txt(tPct, `${Math.ceil(hpv)} / ${Math.round(maxHp)}`); }
      hide(CH.stun, !O.stunned); hide(CH.slow, !O.slowed); hide(CH.shield, !O.shielding); hide(CH.invul, !O.invulnerable); hide(CH.mark, true);
      hide(tStage, true);
      return;
    }
    // босс: 10 слоёв по 100 HP (или maxHp/100 слоёв)
    const layers = Math.max(1, Math.round(maxHp / 100));
    const per = maxHp / layers;
    const N = hpv > 0 ? Math.min(layers, Math.ceil(hpv / per - 1e-6)) : 0;
    const base = N > 0 ? (N - 1) * per : 0;
    const frac = N > 0 ? (hpv - base) / per : 0;
    const lagFrac = N > 0 ? clamp((tS.lagHp - base) / per, frac, 1) : clamp(tS.lagHp / per, 0, 1);
    if (N !== tS.layerN) {
      tS.layerN = N;
      thpFill.style.backgroundColor = N > 0 ? LAYER_COLORS[(N - 1) % LAYER_COLORS.length] : 'transparent';
      thpUnder.style.backgroundColor = N > 1 ? LAYER_COLORS[(N - 2) % LAYER_COLORS.length] : 'transparent';
      txt(tCount, N > 0 ? `×${N}` : '');
    }
    scaleX(thpFill, frac);
    scaleX(thpLag, lagFrac);
    const pk = dead ? -2 : Math.ceil((hpv / maxHp) * 100);
    if (pk !== tS.pctKey) { tS.pctKey = pk; txt(tPct, dead ? '' : `${pk}%`); }
    const st2 = num(B.stage, 1) >= 2;
    cls(tgt, 'is-stage2', st2);
    hide(tStage, !st2 || dead);
    txt(tDangerK, dead ? 'Повержен' : 'Опасность ');
    txt(tDangerV, dead ? '' : st2 ? '◆◆◆◆◆' : '◆◆◆◆◇');
    hide(CH.stun, !B.stunned || dead); hide(CH.mark, !B.marked || dead); hide(CH.slow, !B.slowed || dead); hide(CH.shield, true); hide(CH.invul, true);
  }

  // ------------------------------------------------------------------------ мини-карта и зона
  function updateMap(f, snap, dt) {
    const P = isObj(snap.player) ? snap.player : null;
    const pos = P && isObj(P.position) ? P.position : null;
    mapS.acc += dt;
    if (minimap && mapS.acc >= 1 / 30) {
      mapS.acc = 0;
      try { minimap.draw(f, mapInfo); mapS.errs = 0; } catch (e) { if (++mapS.errs > 3) { console.warn('[bdoHud] minimap.draw', e); minimap = null; } }
    }
    if (!pos) return;
    const px = num(pos.x), pz = num(pos.z);
    const xk = Math.round(px), zk = Math.round(pz);
    if (xk !== mapS.xk || zk !== mapS.zk) {
      mapS.xk = xk; mapS.zk = zk;
      txt(mapXY, `X ${xk < 0 ? '−' : ''}${Math.abs(xk)} · Z ${zk < 0 ? '−' : ''}${Math.abs(zk)}`);
    }
    mapS.zoneAcc += dt;
    if (mapS.zoneAcc >= 0.2) {
      mapS.zoneAcc = 0;
      detectZone(f.layout, px, pz);
      let name = '';
      if (zoneAtFn) {
        try { const z = zoneAtFn(f.layout, px, pz, zoneOut); if (isObj(z) && z.inside && z.name) name = z.name; } catch (e) { zoneAtFn = null; }
      } else if (zS.cur && zS.cur.name) name = zS.cur.name;
      txt(mapZone, typeof name === 'string' && name ? name : OPEN_LAND);
    }
  }

  // ------------------------------------------------------------------------------------- кадр
  function step(f) {
    const screen = f.screen;
    const snap = isObj(f.snapshot) ? f.snapshot : null;
    const on = isBdo(f.settings) && (screen === 'playing' || screen === 'paused') && !!snap;
    setShown(on);
    if (!on) { lastScreen = screen; return; }
    const vp = isObj(f.viewport) ? f.viewport : null;
    const w = vp ? num(vp.w, 1366) : (typeof window !== 'undefined' ? window.innerWidth : 1366);
    const hh = vp ? num(vp.h, 768) : (typeof window !== 'undefined' ? window.innerHeight : 768);
    if (w !== vw || hh !== vh) layout(w, hh);
    const S = isObj(f.settings) ? f.settings : EMPTY;
    const rm = !!S.reducedMotion;
    cls(layer, 'is-rm', rm);
    cls(layer, 'is-lowq', S.quality === 'low');
    const paused = screen === 'paused';
    cls(layer, 'is-paused', paused);
    const dt = paused ? 0 : clamp(num(f.dtReal, 0), 0, 0.25);
    t += dt;
    // первый вход в бой (не возврат из паузы) — титр зоны, где стоит герой, тоже показать
    if (screen === 'playing' && lastScreen !== 'playing' && lastScreen !== 'paused') { zS.cur = null; mapS.zoneAcc = 1; }
    lastScreen = screen;
    if (!paused) handleEvents(f.events);
    updateSkills(snap, f.input, dt);
    updateTarget(snap, dt);
    if (!paused) updateMap(f, snap, dt);
    updateNotes(dt, rm);
    updateZoneTitle(dt);
  }

  function frame(f) {
    if (disposed || failed || !isObj(f)) return;
    try { step(f); } catch (e) {
      failed = true;
      console.warn('[bdoHud] кадр, слой выключен', e);
      try { hide(layer, true); html.classList.remove('bdoh-on'); } catch (e2) { /* ignore */ }
    }
  }

  function reset() {
    try {
      for (const n of notes) { n.live = false; n.pending = false; n.t = 0; cls(n.el, 'is-in', false); }
      zS.phase = 0; zS.t = 99; zS.cur = null; zS.lastEvId = ''; zS.lastShowId = ''; zS.lastEvT = -99; zS.lastShowT = -99;
      hide(zone, true); cls(zone, 'is-on', false);
      hp.lag = hp.frac = 1; hp.hold = 0; hp.key = -1; mp.lag = mp.frac = 1; mp.hold = 0; mp.key = -1;
      tS.mode = ''; tS.lagHp = -1; tS.hp = -1;
      pvpS.round = 0; pvpS.me = 0; pvpS.opp = 0; pvpS.seen = false; pvpS.key = -1;
      for (const list of [skills, runes, sigils]) for (const c of list) { c.flashF = 0; c.castF = c.castF >= 0 ? 0 : -1; c.castT = 9; }
      mapS.acc = 1; mapS.zoneAcc = 1;
    } catch (e) { /* ignore */ }
  }

  function dispose() {
    disposed = true;
    try { if (minimap && minimap.dispose) minimap.dispose(); } catch (e) { /* ignore */ }
    try { html.classList.remove('bdoh-on'); if (layer.parentNode) layer.parentNode.removeChild(layer); } catch (e) { /* ignore */ }
  }

  return { frame, reset, dispose };
}
