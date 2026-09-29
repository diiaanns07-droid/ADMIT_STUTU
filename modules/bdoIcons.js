// ASHEN OATH — modules/bdoIcons.js. Владелец: №8 [BDO].
// SVG-иконки умений, 10 рун, 5 печатей, лука/магии руки и значков UI в едином стиле BDO:
// тёмный живописный фон-медальон (радиальный градиент угля со свечением стихии), крупный
// светлый силуэт с золотым градиентом (свет сверху-слева) и тёмной обводкой — читается на 30–48 px.
// Руны — огненная гравировка глифа на каменном диске; печати — силуэт в восьмигранной рамке.
// Все строки — самостоятельные <svg viewBox="0 0 64 64"> без внешних ресурсов; id градиентов
// с префиксом «ao-i-<id>-» (одна иконка может повторяться на странице — определения одинаковы).
// API: BDO_ICONS {id: svg}, ICON_IDS, iconSvg(id[, {plain}]), iconDataUri(id[, {plain}]),
//      iconImage(id[, {plain}]) — кэшированный Image для canvas. plain — только силуэт без фона.
// Строки собираются один раз при загрузке модуля; в кадре ничего не создаётся.

const OUT = '#120904'; // обводка силуэта (тёмная, для читаемости на 32 px)
const n2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- стихии: [свечение, середина, глубина, блик]
const T = {
  fire: ['#ff7a2a', '#7a220c', '#1e0805', '#ffd89a'],
  blood: ['#e0484a', '#681015', '#1c0506', '#ffb4a4'],
  storm: ['#6d8dff', '#2d2c86', '#0a0a22', '#dae6ff'],
  arcane: ['#b07cff', '#3e1f74', '#100820', '#ecdfff'],
  ward: ['#4fd6c0', '#0e5048', '#041513', '#d4fff6'],
  life: ['#72e08c', '#145228', '#05150b', '#ddffe2'],
  time: ['#f0b850', '#62421a', '#191006', '#fff0c8'],
  frost: ['#8fdcff', '#1f5372', '#06121c', '#effaff'],
  earth: ['#c8b45a', '#43381a', '#120f09', '#f6eec4'],
  wind: ['#7fd8ee', '#15485a', '#05131a', '#e8fbff'],
  dusk: ['#e070c8', '#4a1446', '#130617', '#ffe2f6'],
  mana: ['#4f8cff', '#15357a', '#050c20', '#dde9ff'],
  gold: ['#f3c860', '#5c3c12', '#171006', '#fff4d2'],
  stamina: ['#f0d060', '#5e4a10', '#161106', '#fff8d2'],
  shadow: ['#9a5cff', '#2c1250', '#0a0512', '#e9daff'],
  night: ['#ffd070', '#2e1e5e', '#0b0818', '#fff4d2'],
  steel: ['#b8c8d8', '#343c48', '#0c0e12', '#f4f8ff'],
};

// ---------------------------------------------------------------- геометрия
const circ = (cx, cy, r) => `M${n2(cx - r)} ${cy}a${r} ${r} 0 1 0 ${n2(2 * r)} 0a${r} ${r} 0 1 0 ${n2(-2 * r)} 0Z`;
function starPath(cx, cy, n, ro, ri, rot = -90) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? (Array.isArray(ri) ? ri[(i >> 1) % ri.length] : ri) : Array.isArray(ro) ? ro[(i >> 1) % ro.length] : ro;
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    d += (i ? 'L' : 'M') + n2(cx + r * Math.cos(a)) + ' ' + n2(cy + r * Math.sin(a));
  }
  return d + 'Z';
}
function snowPath(cx, cy, R) {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 - Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    d += `M${cx} ${cy}L${n2(cx + ux * R)} ${n2(cy + uy * R)}`;
    const bx = cx + ux * R * 0.5, by = cy + uy * R * 0.5, tx = bx + ux * R * 0.3, ty = by + uy * R * 0.3, s = R * 0.27;
    d += `M${n2(tx + px * s)} ${n2(ty + py * s)}L${n2(bx)} ${n2(by)}L${n2(tx - px * s)} ${n2(ty - py * s)}`;
  }
  return d;
}

// ---------------------------------------------------------------- элементы силуэта
// F — заливка (золото по умолчанию), L — линия толщины w. Опции: eo (evenodd), p (своя краска),
// glow:false / out:false — без ореола / без обводки.
const F = (d, x) => ({ d, w: 0, ...x });
const L = (d, w, x) => ({ d, w, ...x });
// Деталь поверх силуэта (тонкая линия).
const D = (d, w, c, op = 1) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}"${op < 1 ? ` stroke-opacity="${op}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`;
const P = (d, fill, op = 1) => `<path d="${d}" fill="${fill}"${op < 1 ? ` fill-opacity="${op}"` : ''}/>`;
// Светящаяся сфера энергии (радиальный градиент стихии) с белым ядром.
const ORB = (p, cx, cy, r, core = 0, op = 1) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${p}e)"${op < 1 ? ` opacity="${op}"` : ''}/>` + (core ? `<circle cx="${cx}" cy="${cy}" r="${core}" fill="#fff"/>` : '');
const SPARKLE = (x, y, r, c, op = 1) => P(starPath(x, y, 4, r, r * 0.26), c, op);

// Три прохода силуэта: ореол стихии → тёмная обводка → заливка. Все части сливаются в один силуэт.
function glyph(p, t, items) {
  let g1 = '', g2 = '', o = '', f = '';
  for (const it of items) {
    const w = it.w;
    if (it.glow !== false) { g1 += `<path d="${it.d}" stroke-width="${w + 10}"/>`; g2 += `<path d="${it.d}" stroke-width="${w + 5.5}"/>`; }
    if (it.out !== false) o += `<path d="${it.d}" stroke-width="${w + 3}"/>`;
    const paint = it.p || `url(#${p}m)`;
    f += w
      ? `<path d="${it.d}" fill="none" stroke="${paint}" stroke-width="${w}"${it.op ? ` stroke-opacity="${it.op}"` : ''}/>`
      : `<path d="${it.d}" fill="${paint}"${it.eo ? ' fill-rule="evenodd"' : ''}${it.op ? ` fill-opacity="${it.op}"` : ''}/>`;
  }
  return `<g fill="none" stroke="${t[0]}" stroke-linecap="round" stroke-linejoin="round"><g stroke-opacity=".13">${g1}</g><g stroke-opacity=".3">${g2}</g></g>`
    + `<g fill="none" stroke="${OUT}" stroke-linecap="round" stroke-linejoin="round">${o}</g>`
    + `<g stroke-linecap="round" stroke-linejoin="round">${f}</g>`;
}

// Огненная гравировка руны: ореол → тёмная борозда → расплав → раскалённая сердцевина.
function engrave(p, t, items) {
  let g1 = '', g2 = '', o = '', f = '', c = '';
  for (const it of items) {
    const w = it.w || 0;
    g1 += `<path d="${it.d}" stroke-width="${w + 9}"/>`;
    g2 += `<path d="${it.d}" stroke-width="${w + 5}"/>`;
    o += `<path d="${it.d}" stroke-width="${w + 2.2}"/>`;
    if (w) { f += `<path d="${it.d}" fill="none" stroke="url(#${p}f)" stroke-width="${w}"/>`; if (it.core !== false) c += `<path d="${it.d}" stroke-width="${n2(Math.max(0.7, w * 0.34))}"/>`; }
    else f += `<path d="${it.d}" fill="url(#${p}f)"/>`;
  }
  return `<g fill="none" stroke="${t[0]}" stroke-linecap="round" stroke-linejoin="round"><g stroke-opacity=".2">${g1}</g><g stroke-opacity=".42">${g2}</g></g>`
    + `<g fill="none" stroke="#140502" stroke-linecap="round" stroke-linejoin="round">${o}</g>`
    + `<g stroke-linecap="round" stroke-linejoin="round">${f}</g>`
    + (c ? `<g fill="none" stroke="#fffbe8" stroke-opacity=".85" stroke-linecap="round" stroke-linejoin="round">${c}</g>` : '');
}

// ---------------------------------------------------------------- фон
function defs(p, t, kind) {
  let s = `<radialGradient id="${p}b" cx="26" cy="22" r="50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t[1]}"/><stop offset=".55" stop-color="${t[2]}"/><stop offset="1" stop-color="#040303"/></radialGradient>`
    + `<radialGradient id="${p}g" cx="32" cy="32" r="28" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t[0]}" stop-opacity=".62"/><stop offset=".45" stop-color="${t[0]}" stop-opacity=".2"/><stop offset="1" stop-color="${t[0]}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${p}v" cx="30" cy="28" r="46" gradientUnits="userSpaceOnUse"><stop offset=".56" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".72"/></radialGradient>`
    + `<linearGradient id="${p}m" x1="18" y1="9" x2="44" y2="57" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fffbea"/><stop offset=".3" stop-color="#f6e2aa"/><stop offset=".5" stop-color="#dcb86e"/><stop offset=".53" stop-color="#b98c46"/><stop offset="1" stop-color="#6a4618"/></linearGradient>`
    + `<radialGradient id="${p}e"><stop offset="0" stop-color="#fff"/><stop offset=".28" stop-color="${t[3]}"/><stop offset=".6" stop-color="${t[0]}" stop-opacity=".78"/><stop offset="1" stop-color="${t[0]}" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="${p}k" x1="0" y1="8" x2="0" y2="56" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t[3]}"/><stop offset=".45" stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/></linearGradient>`;
  if (kind === 'rune') {
    s += `<radialGradient id="${p}s" cx="25" cy="22" r="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3b3229"/><stop offset=".6" stop-color="#1a1511"/><stop offset="1" stop-color="#0a0807"/></radialGradient>`
      + `<linearGradient id="${p}f" x1="20" y1="12" x2="44" y2="54" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff8dc"/><stop offset=".35" stop-color="${t[3]}"/><stop offset=".75" stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/></linearGradient>`;
  }
  return s;
}

function backdrop(p, t, kind, seed) {
  let s = `<rect width="64" height="64" fill="url(#${p}b)"/>`;
  // живописные мазки: светлый сверху-слева, тёмный снизу-справа
  s += `<ellipse cx="20" cy="17" rx="20" ry="7" transform="rotate(-32 20 17)" fill="${t[0]}" fill-opacity=".1"/>`
    + `<ellipse cx="45" cy="50" rx="19" ry="6" transform="rotate(-32 45 50)" fill="#000" fill-opacity=".32"/>`
    + `<ellipse cx="14" cy="44" rx="14" ry="4" transform="rotate(24 14 44)" fill="${t[1]}" fill-opacity=".35"/>`
    + `<ellipse cx="50" cy="14" rx="13" ry="3.4" transform="rotate(-58 50 14)" fill="${t[3]}" fill-opacity=".05"/>`;
  if (kind === 'rune') {
    s += `<circle cx="32" cy="32" r="27" fill="#050303" fill-opacity=".7"/>`
      + `<circle cx="32" cy="32" r="25" fill="url(#${p}s)"/>`
      + `<circle cx="32" cy="32" r="25" fill="url(#${p}g)" opacity=".75"/>`
      + `<circle cx="32" cy="32" r="21" fill="none" stroke="${t[0]}" stroke-opacity=".32" stroke-width=".7" stroke-dasharray="1.2 2.3"/>`
      + `<circle cx="32" cy="32" r="26.3" fill="none" stroke="${OUT}" stroke-width="1.2"/>`
      + `<circle cx="32" cy="32" r="25" fill="none" stroke="url(#${p}m)" stroke-width="1.8"/>`
      + `<circle cx="32" cy="32" r="23.6" fill="none" stroke="#000" stroke-opacity=".6" stroke-width=".9"/>`;
    for (const [x, y] of [[32, 7], [57, 32], [32, 57], [7, 32]]) s += `<path d="M${x} ${y - 2.6}l2.6 2.6-2.6 2.6-2.6-2.6Z" fill="url(#${p}m)" stroke="${OUT}" stroke-width=".7"/>`;
  } else {
    s += `<circle cx="32" cy="32" r="30" fill="url(#${p}g)"/>`;
    if (kind === 'sigil') {
      const oct = 'M18.5 4.5H45.5L59.5 18.5V45.5L45.5 59.5H18.5L4.5 45.5V18.5Z';
      s += `<path d="${oct}" fill="none" stroke="${OUT}" stroke-width="2.8"/>`
        + `<path d="${oct}" fill="none" stroke="url(#${p}m)" stroke-width="1.3" stroke-opacity=".9"/>`
        + `<path d="M20 8H44L56 20V44L44 56H20L8 44V20Z" fill="none" stroke="${t[0]}" stroke-opacity=".3" stroke-width=".7"/>`;
      for (const [x, y] of [[32, 4.5], [59.5, 32], [32, 59.5], [4.5, 32]]) s += `<path d="M${x} ${y - 2.2}l2.2 2.2-2.2 2.2-2.2-2.2Z" fill="url(#${p}m)" stroke="${OUT}" stroke-width=".6"/>`;
    } else {
      s += `<circle cx="32" cy="32" r="27.5" fill="none" stroke="${t[0]}" stroke-opacity=".14" stroke-width="1"/>`;
    }
  }
  s += `<rect width="64" height="64" fill="url(#${p}v)"/>`;
  // искры: детерминированные по id, по кольцу вокруг силуэта
  let h = seed;
  const rnd = () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
  for (let i = 0; i < 14; i++) s += `<circle cx="${n2(3 + rnd() * 58)}" cy="${n2(3 + rnd() * 58)}" r="${n2(0.3 + rnd() * 0.5)}" fill="${i & 1 ? t[3] : '#000'}" fill-opacity="${n2(0.06 + rnd() * 0.1)}"/>`;
  for (let i = 0; i < 5; i++) {
    const a = rnd() * Math.PI * 2, r = 20 + rnd() * 8, x = n2(32 + Math.cos(a) * r), y = n2(32 + Math.sin(a) * r);
    if (x < 3 || x > 61 || y < 3 || y > 61) continue;
    s += i === 0 ? SPARKLE(x, y, 2.4, t[3], 0.8) : `<circle cx="${x}" cy="${y}" r="${n2(0.45 + rnd() * 0.7)}" fill="${t[3]}" fill-opacity="${n2(0.45 + rnd() * 0.45)}"/>`;
  }
  return s;
}
// Фаска: свет сверху-слева, тень снизу-справа (поверх всего — чёткий край ячейки).
const BEVEL = '<path d="M.5 63.5V.5h63" fill="none" stroke="#fff1cc" stroke-opacity=".16"/><path d="M63.5 .5v63H.5" fill="none" stroke="#000" stroke-opacity=".55"/>';

// ---------------------------------------------------------------- сюжеты
// Каждый: [стихия, вид фона (skill|rune|sigil|ui), (p,t) => { d?: доп. defs, u?: под силуэтом, g?: силуэт, r?: гравировка, o?: поверх }]
const HAND_CUP = [
  F('M11 39C13 50 22 55 32 55C42 55 51 50 53 39C47 44 40 46.5 32 46.5C24 46.5 17 44 11 39Z'),
  L('M11.8 39.6L8.8 33.6', 3.8), L('M52.2 39.6L55.2 33.6', 3.8),
];
const HAND_CUP_D = D('M19.5 47.8Q21.6 51.8 26 53.4M44.5 47.8Q42.4 51.8 38 53.4', 0.8, OUT, 0.55);
const FLAME = 'M32 7C38 15 46.5 20.5 45 32C44 39 38.5 43 32 43C25 43 19.5 38.5 19.5 32C19.5 26 23 22.5 26 19C26.5 24.5 28.5 27 31 27.5C29.5 20 29.5 13 32 7Z';
const FLAME_CORE = 'M33 22C36 27 39 31 37.5 35.5C36.5 38.5 34.5 40 32 40C29 40 27 38 27 35C27 32 29 30.5 30.5 28.5C31 31 32 32 33 32C32 29 32 25 33 22Z';
const HEART = 'M32 51C18 41 11.5 33 11.5 24.5C11.5 17.5 16.5 12.5 23 12.5C27 12.5 30 14.8 32 18.5C34 14.8 37 12.5 41 12.5C47.5 12.5 52.5 17.5 52.5 24.5C52.5 33 46 41 32 51Z';

const DEFS = {
  // ---------------------------------------------------------------- умения
  bolt: ['arcane', 'skill', (p, t) => ({
    // рука «OK»: большой и указательный сомкнуты в кольцо, из кольца вылетает снаряд
    d: `<linearGradient id="${p}t" x1="24" y1="39" x2="14" y2="16" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${t[0]}" stop-opacity="0"/><stop offset=".5" stop-color="${t[0]}" stop-opacity=".8"/><stop offset="1" stop-color="${t[3]}"/></linearGradient>`,
    g: [
      F('M24.5 39.5L19.8 14.6Q14.5 11.5 10.4 18.4Z', { p: `url(#${p}t)`, out: false }),
      F('M30.5 37H48.5V50Q48.5 58.5 39.5 58.5Q30.5 58.5 30.5 50Z'),
      L('M34.4 38V15.8', 4.6), L('M39.8 38V17.4', 4.6), L('M45 39L47.4 22.6', 4.3),
      F(circ(24.5, 40.5, 9) + circ(24.5, 40.5, 4.4), { eo: 1 }),
    ],
    o: ORB(p, 15, 17, 9.5, 3.2) + SPARKLE(15, 17, 7, '#fff', 0.9) + D('M17.6 35.2A6.6 6.6 0 0 1 27 33.4', 1, '#fff', 0.6)
      + D('M32.4 20V35', 0.9, '#fff', 0.5)
      + `<circle cx="24.5" cy="40.5" r="3.2" fill="${t[3]}" fill-opacity=".85"/>`
      + `<circle cx="21.6" cy="29.5" r="1.3" fill="${t[3]}"/><circle cx="19" cy="25.2" r="1" fill="#fff"/><circle cx="25" cy="27" r=".8" fill="${t[3]}" fill-opacity=".8"/>`,
  })],
  spark: ['storm', 'skill', (p, t) => ({
    u: P(starPath(30, 33, 4, 13, 2.6, -45), t[3], 0.55),
    g: [F(starPath(30, 33, 4, 22.5, 4.4)), F(starPath(47, 15.5, 4, 7, 1.6))],
    o: ORB(p, 30, 33, 8, 2.6) + D('M13 22Q15.5 16.5 21 14.5M10.5 17.5Q12.5 12.5 17 10.5', 1.4, t[3], 0.8)
      + D('M30 14V27M30 39V51', 0.8, '#fff', 0.55),
  })],
  slash: ['blood', 'skill', (p, t) => ({
    u: D('M10 39C24 35 36 27 44 13M13 31C23 27 31 21 36 13', 1.3, t[3], 0.35),
    g: [F('M9 48C30 49 48.5 35 55 9C43 30 29 40 9 48Z')],
    o: D('M14.5 48C32 47 47 34 53 13.5', 1, '#fff', 0.8) + SPARKLE(52, 12, 3.2, '#fff', 0.9)
      + `<circle cx="47" cy="44" r="1.3" fill="${t[0]}"/><circle cx="51" cy="40" r=".8" fill="${t[0]}"/><circle cx="42" cy="50" r=".9" fill="${t[0]}"/>`,
  })],
  shield: ['ward', 'skill', (p, t) => ({
    u: `<circle cx="32" cy="32" r="22.5" fill="none" stroke="${t[0]}" stroke-width="3" stroke-opacity=".55"/><circle cx="32" cy="32" r="22.5" fill="none" stroke="${t[3]}" stroke-width=".9" stroke-opacity=".85"/>`
      + P(starPath(32, 32, 6, 22.5, 19.5, -90), t[0], 0.12),
    g: [
      F('M20.8 31H42.2V43Q42.2 52.5 31.5 52.5Q20.8 52.5 20.8 43Z'),
      L('M23.2 34V19.5', 4.5), L('M28.4 34V14.8', 4.5), L('M33.6 34V13.2', 4.5), L('M38.8 34V16.8', 4.5),
      L('M40.6 43.5L47.6 34.5', 5),
    ],
    o: ORB(p, 31.5, 41, 8, 2.2, 0.95) + D('M22 21.5V30', 0.9, '#fff', 0.5),
  })],
  parry: ['storm', 'skill', (p, t) => ({
    // Громовой отвод: круглый щит-баклер отбивает сферу, по кромке — молнии
    u: D('M39 29.5L43.5 21.8M41.6 31.2L47.6 24.4M37.2 27.2L39.6 20.6', 1.2, t[3], 0.55),
    g: [F(circ(25, 39.5, 15.5))],
    o: D(circ(25, 39.5, 11.2), 0.9, OUT, 0.7) + `<circle cx="25" cy="39.5" r="4.6" fill="url(#${p}m)" stroke="${OUT}" stroke-width="1"/>`
      + `<circle cx="23.6" cy="38.1" r="1.4" fill="#fff" fill-opacity=".8"/>`
      + D('M14.2 30.4A13 13 0 0 1 26.5 26.6', 1.1, '#fff', 0.6)
      + D('M30 25.8L33.5 29L31 31.2L35 34.2M40 35L37 38.5L40.5 40L37.5 44.5', 3, t[0], 0.4)
      + D('M30 25.8L33.5 29L31 31.2L35 34.2M40 35L37 38.5L40.5 40L37.5 44.5', 1.2, '#fff', 0.95)
      + ORB(p, 46.5, 16, 9.5, 3.2) + SPARKLE(46.5, 16, 6.5, '#fff', 0.85) + SPARKLE(38.5, 30, 4.5, '#fff', 0.95),
  })],
  burst: ['fire', 'skill', (p, t) => ({
    d: `<radialGradient id="${p}x" cx="32" cy="27" r="23" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="${t[3]}"/><stop offset=".68" stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/></radialGradient>`,
    g: [
      F(starPath(32, 27, 12, [22, 16, 20, 14.5, 23, 16.5], 8.5, -90), { p: `url(#${p}x)`, out: false }),
      F('M20 39.5H45V47Q45 53.5 38.8 53.5H26.2Q20 53.5 20 47Z'),
      F(circ(23.6, 39.5, 3.6)), F(circ(29.6, 38.6, 3.6)), F(circ(35.6, 38.6, 3.6)), F(circ(41.4, 39.5, 3.6)),
      L('M21.5 46.2H34.5', 4.4),
    ],
    o: D('M26.6 38.5V43.6M32.6 37.8V43.6M38.5 38.5V43.6', 0.9, OUT, 0.75) + D('M22.5 37.2Q23.6 35.4 25.2 36', 0.9, '#fff', 0.6)
      + `<circle cx="12" cy="17" r="1.2" fill="${t[3]}"/><circle cx="53" cy="15" r="1" fill="${t[3]}"/><circle cx="50" cy="34" r=".9" fill="${t[3]}"/>`,
  })],
  dash: ['wind', 'skill', (p, t) => ({
    u: D('M5 26.5H16M3 32H13M6 37.5H16', 1.3, t[3], 0.55) + D('M8 20Q22 13 34 14M8 44Q22 51 34 50', 1.2, t[3], 0.35),
    g: [
      F('M31 12.5L51.5 32L31 51.5H22.5L40 32L22.5 12.5Z'),
      F('M16.5 18.5L30 32L16.5 45.5H10.5L22.5 32L10.5 18.5Z', { op: 0.82 }),
    ],
    o: D('M24.5 14.3L41.7 32', 0.9, '#fff', 0.7) + D('M12.4 20.3L24 32', 0.8, '#fff', 0.45),
  })],
  throw: ['mana', 'skill', (p, t) => ({
    g: [
      F('M20 11.5Q5 32 20 52.5L24.5 50Q12.5 32 24.5 14Z'), F('M44 11.5Q59 32 44 52.5L39.5 50Q51.5 32 39.5 14Z'),
      L('M21 12.5L24 8', 3), L('M43 12.5L40 8', 3), L('M21.5 51.5L25 55', 3), L('M42.5 51.5L39 55', 3),
    ],
    o: ORB(p, 32, 32, 13.5, 4.4) + D('M20.5 26Q26 29 27.5 32M43.5 38Q38 35 36.5 32', 1, t[3], 0.85)
      + D('M13.8 22Q11.5 32 14.5 42', 0.9, '#fff', 0.6) + SPARKLE(32, 32, 9, '#fff', 0.8),
  })],
  prism: ['arcane', 'skill', (p, t) => ({
    d: `<linearGradient id="${p}c" x1="16" y1="10" x2="46" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".35" stop-color="${t[3]}"/><stop offset=".75" stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/></linearGradient>`,
    u: D('M0 41.5L20.2 32.5', 2, '#fff', 0.85)
      + D('M45.8 35.5L63 29.5', 1.6, '#ff6a5a', 0.9) + D('M46.2 36.6L63 36', 1.6, '#ffd060', 0.9)
      + D('M46.6 37.8L63 42.5', 1.6, '#5fe0a0', 0.9) + D('M47 39L63 49', 1.6, '#6aa0ff', 0.9),
    g: [F('M32 8.5L53.5 49.5H10.5Z', { p: `url(#${p}c)` })],
    o: P('M32 8.5L36 49.5H53.5Z', '#1a0a30', 0.38) + P('M32 8.5L10.5 49.5H18Z', '#fff', 0.3)
      + D('M32 8.5L36 49.5', 0.9, '#fff', 0.7) + D('M13.5 47H33', 0.8, '#fff', 0.4) + SPARKLE(32, 10, 4, '#fff', 0.95),
  })],

  // ---------------------------------------------------------------- руны (огненная гравировка)
  ignis: ['fire', 'rune', () => ({
    r: [L('M32 15L46.5 41.5H17.5Z', 3), L('M32 41.5V50', 3), F('M32 24.5C35 29.5 37.2 32.5 35.6 36.4C34.8 38.4 33.4 39.4 32 39.4C30.4 39.4 29 38.4 28.4 36.6C27.2 32.8 29.4 29.4 32 24.5Z')],
  })],
  fulgur: ['storm', 'rune', () => ({ r: [L('M37 12.5L24.5 33H36L27.5 51.5', 3.2)] })],
  orbis: ['ward', 'rune', () => ({ r: [L(circ(32, 32, 11.5), 3), L('M32 26.5V37.5M26.5 32H37.5', 2.2)] })],
  stella: ['night', 'rune', (p, t) => ({
    r: [L(starPath(32, 33, 5, 15, 6.3), 2.8)],
    o: `<circle cx="17" cy="17" r="1.1" fill="${t[3]}"/><circle cx="47" cy="15" r=".9" fill="${t[3]}"/>` + D('M19 18.8L22.6 22.4', 1, t[3], 0.6),
  })],
  spira: ['wind', 'rune', () => ({ r: [L('M31 32A3 3 0 0 1 37 32A6 6 0 0 1 25 32A9 9 0 0 1 43 32A12 12 0 0 1 19 32A15 15 0 0 1 49 32', 2.8)] })],
  lemnis: ['life', 'rune', () => ({ r: [L('M32 32C38.5 20.5 48.5 21 48.5 32C48.5 43 38.5 43.5 32 32C25.5 20.5 15.5 21 15.5 32C15.5 43 25.5 43.5 32 32Z', 3)] })],
  caret: ['steel', 'rune', () => ({ r: [L('M17.5 45L32 24L46.5 45', 3.2), L('M24.6 17V26.2M32 11V19M39.4 17V26.2', 2)] })],
  vee: ['blood', 'rune', () => ({ r: [L('M20.5 23L32 46.5L44.5 19', 3.2), F('M45 18.2C40.5 11.6 32.5 10 24.4 13.6C31.5 13.2 38.2 15.2 44.6 21Z')] })],
  clepsydra: ['time', 'rune', () => ({ r: [L('M20 15H44L32 32L44 49H20L32 32Z', 2.8), L('M32 33.5V41', 1.2, { core: false }), F('M25.2 47.2L32 41L38.8 47.2Z')] })],
  alpha: ['arcane', 'rune', () => ({ r: [L('M20.5 45C30 40 41 30 41 20C41 14 35 12.5 32.5 17.5C29 25 28 36 30.5 43C32 48 38 49 43 45', 2.8), L('M37.6 45.4L43 45L41.6 50', 2.4)] })],

  // ---------------------------------------------------------------- печати
  clap: ['gold', 'sigil', (p, t) => {
    // две ладони сходятся в хлопке; по сторонам — волна
    const hand = (m) => {
      const X = (x) => n2(32 + m * (x - 32));
      return `<g transform="rotate(${m * -9} ${X(24)} 51)">${glyph(p, t, [
        F(`M${X(16.5)} 33H${X(30)}V45.5Q${X(30)} 51.5 ${X(23.25)} 51.5Q${X(16.5)} 51.5 ${X(16.5)} 45.5Z`),
        L(`M${X(18.2)} 35V22.5`, 3), L(`M${X(21.6)} 35V18`, 3), L(`M${X(25)} 35V16.5`, 3), L(`M${X(28.4)} 35V19`, 3),
        L(`M${X(28.6)} 46L${X(30.6)} 38.5`, 3.4),
      ])}${D(`M${X(20)} 38V46`, 0.8, '#fff', 0.45)}</g>`;
    };
    return {
      u: D('M13.5 21.5Q8.5 32 13.5 42.5M9.2 17.5Q3.8 32 9.2 46.5M50.5 21.5Q55.5 32 50.5 42.5M54.8 17.5Q60.2 32 54.8 46.5', 1.7, t[3], 0.8)
        + D('M13.5 21.5Q8.5 32 13.5 42.5M50.5 21.5Q55.5 32 50.5 42.5', 4.5, t[0], 0.28),
      g: hand(1) + hand(-1),
      o: SPARKLE(32, 23, 7.5, '#fff', 0.95) + `<circle cx="32" cy="23" r="3" fill="url(#${p}e)"/>`,
    };
  }],
  gate: ['earth', 'sigil', (p) => ({
    g: [
      F('M15.5 25H48.5V52H15.5ZM26 52V40A6 6 0 0 1 38 40V52Z', { eo: 1 }),
      F('M14.5 17.5h6v8.5h-6Z'), F('M22.3 17.5h5.6v8.5h-5.6Z'), F('M29.2 17.5h5.6v8.5h-5.6Z'), F('M36.1 17.5h5.6v8.5h-5.6Z'), F('M43.5 17.5h6v8.5h-6Z'),
    ],
    o: `<path d="M27 52V40.3A5 5 0 0 1 37 40.3V52Z" fill="url(#${p}e)"/>` + D('M29.5 38.6V52M32 36V52M34.5 38.6V52M27 45H37', 0.7, OUT, 0.8)
      + D('M16 32.5H25.5M38.5 32.5H48M16 40H24M40 40H48M20.5 25.5V32M43.5 25.5V32', 0.6, OUT, 0.45) + D('M16 25.6H26', 0.7, '#fff', 0.45),
  })],
  frame: ['blood', 'sigil', (p) => ({
    g: [
      L('M13.5 24V13.5H24', 3.2), L('M40 13.5H50.5V24', 3.2), L('M50.5 40V50.5H40', 3.2), L('M24 50.5H13.5V40', 3.2),
      F('M32 20.5L43.5 32L32 43.5L20.5 32ZM32 26.8L37.2 32L32 37.2L26.8 32Z', { eo: 1 }),
    ],
    o: ORB(p, 32, 32, 5, 1.4) + D('M32 14V18M32 46V50M14 32H18M46 32H50', 1, OUT, 0.7) + D('M21.8 31L31 21.8', 0.8, '#fff', 0.55),
  })],
  delta: ['mana', 'sigil', (p, t) => ({
    d: `<linearGradient id="${p}y" x1="0" y1="24" x2="0" y2="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="${t[3]}" stop-opacity=".85"/><stop offset="1" stop-color="${t[0]}" stop-opacity="0"/></linearGradient>`,
    u: `<path d="M27 5H37L33.4 22H30.6Z" fill="${t[0]}" fill-opacity=".35"/><path d="M29.8 5H34.2L32.8 22H31.2Z" fill="url(#${p}y)"/>`,
    g: [F('M32 20L51 51.5H13ZM32 30.4L42 46.8H22Z', { eo: 1 })],
    o: ORB(p, 32, 20, 6.5, 2) + ORB(p, 32, 40.5, 4.2, 1.2) + D('M30.6 22.6L15.4 49.6', 0.9, '#fff', 0.6),
  })],
  cor: ['ward', 'sigil', (p, t) => ({
    g: [F(HEART), F('M29 23.5h6v5.5h5.5v6H35v5.5h-6V35h-5.5v-6H29Z', { p: `url(#${p}k)` })],
    o: D('M16 22.5C16.5 18.5 19.5 16 23.5 16.2', 1.1, '#fff', 0.7) + D('M29.8 24.5V28.5', 0.8, '#fff', 0.8),
  })],

  // ---------------------------------------------------------------- лук и магия руки (№6)
  bow: ['dusk', 'skill', (p, t) => ({
    g: `<g transform="rotate(-42 32 32)">${glyph(p, t, [
      F('M23.5 7C34 14 38.5 23 38.5 32C38.5 41 34 50 23.5 57C31 48.5 34.8 40.5 34.8 32C34.8 23.5 31 15.5 23.5 7Z'),
      L('M23.8 7.4Q21.6 5.2 23.4 3.2', 1.8), L('M23.8 56.6Q21.6 58.8 23.4 60.8', 1.8),
      F('M33.8 27.8h5.6v8.4h-5.6Z'),
      L('M17 32H52', 1.8), F('M51 27.8L60 32L51 36.2Z', { p: `url(#${p}k)` }),
      F('M17.5 32L13 28H17L21.5 32L17 36H13Z', { p: t[0] }),
    ])}${D('M23.8 7.6L17.2 32L23.8 56.4', 0.9, t[3], 0.9)}${D('M26 9.5C33.5 15.5 37 23 37.4 30', 0.8, '#fff', 0.6)}</g>`,
    o: SPARKLE(52.5, 11.5, 5, '#fff', 0.9) + `<circle cx="47" cy="10" r=".9" fill="${t[3]}"/><circle cx="55" cy="18" r=".8" fill="${t[3]}"/>`,
  })],
  spell_fire: ['fire', 'skill', (p, t) => ({
    d: `<linearGradient id="${p}h" x1="0" y1="44" x2="0" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff6d2"/><stop offset=".35" stop-color="${t[3]}"/><stop offset=".72" stop-color="${t[0]}"/><stop offset="1" stop-color="#b8260e"/></linearGradient>`,
    g: [F(FLAME, { p: `url(#${p}h)` }), ...HAND_CUP],
    o: `<path d="${FLAME_CORE}" fill="#fff8e2" fill-opacity=".85"/>` + HAND_CUP_D + `<circle cx="17" cy="14" r="1" fill="${t[3]}"/><circle cx="48" cy="11" r="1.2" fill="${t[3]}"/>`,
  })],
  spell_storm: ['storm', 'skill', (p, t) => ({
    u: D('M17 18Q12 28 18 36M47 16Q53 25 47 34', 1.3, t[3], 0.6),
    g: [F('M37.5 5L20.5 29H30.5L25 45.5L43.5 20H33.5Z', { p: `url(#${p}k)` }), ...HAND_CUP],
    o: D('M35.8 8L23.6 27.3', 0.9, '#fff', 0.85) + HAND_CUP_D + SPARKLE(25, 45, 4, '#fff', 0.9),
  })],
  spell_frost: ['frost', 'skill', (p, t) => ({
    g: [L(snowPath(32, 25.5, 15), 2.4, { p: `url(#${p}k)` }), F(starPath(32, 25.5, 6, 5, 3.2, -90), { p: '#fff' }), ...HAND_CUP],
    o: HAND_CUP_D + `<circle cx="14" cy="16" r="1" fill="${t[3]}"/><circle cx="51" cy="13" r="1.1" fill="${t[3]}"/>`,
  })],
  spell_earth: ['earth', 'skill', (p, t) => ({
    d: `<linearGradient id="${p}r" x1="20" y1="12" x2="42" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f4e6b8"/><stop offset=".45" stop-color="#b0904a"/><stop offset="1" stop-color="#4a3418"/></linearGradient>`,
    g: [
      F('M21 21L33 12.5L44.5 19.5L45.5 33.5L34.5 41.5L20.5 35.5Z', { p: `url(#${p}r)` }),
      F('M11 15.5L15.5 12L18.5 16L15 19.5Z', { p: `url(#${p}r)` }), F('M49 10L53.5 11.5L52.5 16L48 15Z', { p: `url(#${p}r)` }),
      ...HAND_CUP,
    ],
    o: P('M33 12.5L32.5 26L45.5 33.5L44.5 19.5Z', '#000', 0.28) + P('M21 21L33 12.5L32.5 26Z', '#fff', 0.22)
      + D('M26 31L30 27.5L34.5 31L38.5 28', 1.6, t[0], 0.5) + D('M26 31L30 27.5L34.5 31L38.5 28', 0.8, t[3], 0.95) + HAND_CUP_D,
  })],

  // ---------------------------------------------------------------- UI
  hp: ['blood', 'ui', (p) => ({
    g: [F('M32 9.5C36.5 20 46.5 28 46.5 38.5C46.5 46.5 40 52.5 32 52.5C24 52.5 17.5 46.5 17.5 38.5C17.5 28 27.5 20 32 9.5Z', { p: `url(#${p}k)` })],
    o: D('M23.5 38C23.5 31 27 26 30.5 20', 1.8, '#fff', 0.6) + `<ellipse cx="37.5" cy="44" rx="3.6" ry="2.2" transform="rotate(-35 37.5 44)" fill="#fff" fill-opacity=".18"/>`,
  })],
  mp: ['mana', 'ui', (p) => ({
    g: [F('M32 8L45.5 29.5L32 56L18.5 29.5Z', { p: `url(#${p}k)` })],
    o: P('M32 8L45.5 29.5L32 56Z', '#050c26', 0.32) + P('M32 8L18.5 29.5H32Z', '#fff', 0.3)
      + D('M18.5 29.5H45.5M32 8V56', 0.7, '#fff', 0.45) + SPARKLE(32, 9.5, 4.5, '#fff', 0.95),
  })],
  stamina: ['stamina', 'ui', (p, t) => {
    // крыло: заострённые маховые перья слоями (каждое со своей обводкой) + кроющий слой по кости
    const fe = (rx, ry, ang, len, w) => {
      const a = (ang * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), tx = rx + ux * len, ty = ry + uy * len;
      const mx = rx + ux * len * 0.55, my = ry + uy * len * 0.55, px = -uy * w, py = ux * w;
      return F(`M${n2(rx + px * 0.5)} ${n2(ry + py * 0.5)}Q${n2(mx + px)} ${n2(my + py)} ${n2(tx)} ${n2(ty)}Q${n2(mx - px)} ${n2(my - py)} ${n2(rx - px * 0.5)} ${n2(ry - py * 0.5)}Z`);
    };
    const FE = [[22, 16, 196, 15, 3.4], [26, 20, 186, 18, 3.8], [30.5, 24.5, 172, 20, 4], [35, 29, 158, 20, 4], [39, 33.5, 144, 18.5, 4], [43, 38, 130, 16, 3.8], [46.5, 42, 116, 12.5, 3.4]];
    let wing = '';
    for (const f of FE) wing += glyph(p, t, [fe(...f)]);
    return {
      u: D('M4 52Q16 57 30 52', 1.2, t[3], 0.45) + D('M2 45Q10 48 18 46', 1, t[3], 0.35),
      g: '<g transform="translate(2.5 4.5)">' + wing + glyph(p, t, [F('M50.5 45.5C49 31 39 17 17.5 9.5C22.5 14.5 25.5 19 28.5 23.5L31.5 24.5L33 28.5L36 29.5L37 33.5L40 34.5L41 38.5L44 40L44.5 44Z')]) + D('M47.5 42C45.5 30 37 19 22.5 12.5', 0.9, '#fff', 0.7) + D('M9 21.5L20 19.5M9.5 29.5L24 25M13.5 38L28 30.5', 0.6, '#fff', 0.35) + '</g>',
    };
  }],
  ember: ['fire', 'ui', (p, t) => ({
    d: `<radialGradient id="${p}c" cx="34" cy="44" r="16" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8a3410"/><stop offset=".55" stop-color="#3a1a0c"/><stop offset="1" stop-color="#140a06"/></radialGradient>`,
    g: [
      F('M17.5 44.5L21.5 34.5L30 30.5L40.5 31.5L47.5 38.5L46.5 48L36.5 52.5L24 51.5Z', { p: `url(#${p}c)` }),
      F('M33 11C36.5 17.5 41.5 21 39.5 27C38.5 30 35.8 31.5 33 31.5C29.5 31.5 27 29 27.8 25.5C28.3 23.5 29.8 22 31 20C31.2 23 32.2 24 33.3 24.2C32.5 20 32.3 15.5 33 11Z', { p: `url(#${p}k)` }),
    ],
    o: D('M22.5 44.5L29.5 38.5L36 41.5L42.5 36.5M29.5 38.5L29 33M36 41.5L37 48.5', 2.4, t[0], 0.5)
      + D('M22.5 44.5L29.5 38.5L36 41.5L42.5 36.5M29.5 38.5L29 33M36 41.5L37 48.5', 1, t[3], 1)
      + D('M21.8 34.8L30 30.8L40.4 31.8L47 38.4', 1.1, t[0], 0.9) + `<path d="M33.3 21C35 24.5 36 26.5 35 28.5C34.2 30 31.5 30 31 28.2C30.6 26.5 32.2 24.5 33.3 21Z" fill="#fff6d8"/>`,
  })],
  skull: ['blood', 'ui', (p, t) => ({
    d: `<linearGradient id="${p}n" x1="20" y1="12" x2="42" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fffaf0"/><stop offset=".5" stop-color="#e6d8b8"/><stop offset="1" stop-color="#8a7a5a"/></linearGradient>`,
    g: [F('M32 11.5C21 11.5 14.5 19.5 14.5 29C14.5 35 17.5 39 21.5 41V47C21.5 49.5 23.5 51.5 26 51.5H38C40.5 51.5 42.5 49.5 42.5 47V41C46.5 39 49.5 35 49.5 29C49.5 19.5 43 11.5 32 11.5Z'
      + 'M20.5 30.5C20.5 27 23 25 26 25C29 25 31 27.2 30.6 30.2C30.2 33.2 28 35 25.2 35C22.4 35 20.5 33.2 20.5 30.5Z'
      + 'M43.5 30.5C43.5 27 41 25 38 25C35 25 33 27.2 33.4 30.2C33.8 33.2 36 35 38.8 35C41.6 35 43.5 33.2 43.5 30.5Z'
      + 'M32 36.5L34.4 41.2H29.6Z', { eo: 1, p: `url(#${p}n)` })],
    o: `<circle cx="25.8" cy="30.2" r="3.2" fill="${t[0]}" fill-opacity=".55"/><circle cx="38.2" cy="30.2" r="3.2" fill="${t[0]}" fill-opacity=".55"/><circle cx="25.8" cy="30.2" r="1.3" fill="${t[3]}"/><circle cx="38.2" cy="30.2" r="1.3" fill="${t[3]}"/>`
      + D('M27 44.5V51M32 44.5V51.5M37 44.5V51M22.5 44.5H41.5', 0.9, OUT, 0.8) + D('M19.5 21.5C21.5 17 25.5 14.5 30 14', 1.1, '#fff', 0.75),
  })],
  boss: ['shadow', 'ui', (p, t) => ({
    g: [
      F('M14.5 30L17 13.5L24.5 22.5L32 9.5L39.5 22.5L47 13.5L49.5 30Z'),
      F('M17.5 29H46.5V38C46.5 47.5 39 54.5 32 54.5C25 54.5 17.5 47.5 17.5 38ZM21.5 35.5L30 38.2L29.2 41L22.4 39.2ZM42.5 35.5L34 38.2L34.8 41L41.6 39.2Z', { eo: 1 }),
    ],
    o: `<path d="M22 36.2L29.4 38.6L29 40.2L22.6 38.6Z" fill="${t[3]}"/><path d="M42 36.2L34.6 38.6L35 40.2L41.4 38.6Z" fill="${t[3]}"/>`
      + D('M22 37.5L29.5 39.5M42 37.5L34.5 39.5', 3, t[0], 0.45)
      + ORB(p, 32, 10.5, 3.6, 1) + ORB(p, 17, 14, 2.6, 0.8) + ORB(p, 47, 14, 2.6, 0.8)
      + D('M16 29.2H48', 1, OUT, 0.8) + D('M32 43V50', 0.8, OUT, 0.6) + D('M19.5 31V38', 0.9, '#fff', 0.55),
  })],
  map_pin: ['gold', 'ui', (p, t) => ({
    u: `<ellipse cx="32" cy="55" rx="8.5" ry="2.4" fill="#000" fill-opacity=".55"/>`,
    g: [F('M32 54C26 44 17.5 36.5 17.5 27C17.5 18.5 24 11.5 32 11.5C40 11.5 46.5 18.5 46.5 27C46.5 36.5 38 44 32 54Z' + circ(32, 26.5, 5.8), { eo: 1 })],
    o: `<circle cx="32" cy="26.5" r="5.8" fill="#1a0c04"/>` + ORB(p, 32, 26.5, 5.2, 1.6) + D('M21.5 25C22 19.5 25.5 16 30 15.2', 1.1, '#fff', 0.75),
  })],
  pvp: ['blood', 'ui', (p, t) => {
    const sw = (a) => `<g transform="rotate(${a} 32 32)">${glyph(p, t, [
      F('M32 6.5L35.2 12V39.5H28.8V12Z', { p: `url(#${p}s)` }),
      L('M23.5 41.4H40.5', 3.4), L('M32 44V50.5', 3.2), F(circ(32, 53.4, 2.5)),
    ])}${D('M32 10V38', 0.7, '#fff', 0.7)}</g>`;
    return {
      d: `<linearGradient id="${p}s" x1="28" y1="8" x2="36" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#d2dbe6"/><stop offset=".55" stop-color="#8a98a8"/><stop offset="1" stop-color="#3c4552"/></linearGradient>`,
      g: sw(-42) + sw(42),
      o: SPARKLE(32, 26.5, 5, '#fff', 0.9),
    };
  }],
  zone: ['time', 'ui', (p, t) => ({
    d: `<linearGradient id="${p}q" x1="24" y1="13" x2="46" y2="30" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff8a70"/><stop offset=".5" stop-color="#b8282a"/><stop offset="1" stop-color="#5a1012"/></linearGradient>`,
    u: `<ellipse cx="27" cy="54" rx="11" ry="2.2" fill="#000" fill-opacity=".5"/>`,
    g: [
      L('M22 11V51', 2.8), F(circ(22, 9, 2.6)),
      F('M23.5 13.5H47L41 22L47 30.5H23.5Z', { p: `url(#${p}q)` }),
      F('M15.5 50H28.5L27 54.5H17Z'),
    ],
    o: `<path d="M32.5 17.5L35.5 22L32.5 26.5L29.5 22Z" fill="url(#${p}m)" stroke="${OUT}" stroke-width=".6"/>` + D('M24.5 14.5H45', 0.9, '#fff', 0.5)
      + D('M20.9 13V49', 0.7, '#fff', 0.55),
  })],
};
// ---------------------------------------------------------------- сборка
const NEUTRAL_DEF = ['time', 'rune', () => ({ g: [F('M32 17L45 32L32 47L19 32ZM32 24L38.5 32L32 40L25.5 32Z', { eo: 1 })] })];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h & 0x7fffffff; }

function build(id, def, plain) {
  const [tk, kind, fn] = def;
  const t = T[tk] || T.time;
  const p = `ao-i-${id}${plain ? '-p' : ''}-`;
  const b = fn(p, t) || {};
  let body = '';
  if (!plain) body += backdrop(p, t, kind, hash(id));
  else if (kind === 'rune' && b.r) body += `<circle cx="32" cy="32" r="17" fill="url(#${p}g)" opacity=".8"/>`;
  body += b.u || '';
  if (b.g) body += typeof b.g === 'string' ? b.g : glyph(p, t, b.g);
  if (b.r) body += engrave(p, t, b.r);
  body += b.o || '';
  if (!plain) body += BEVEL;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs>${defs(p, t, kind === 'rune' || b.r ? 'rune' : kind)}${b.d || ''}</defs>${body}</svg>`;
}

const FALLBACK = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="8" y="8" width="48" height="48" fill="none" stroke="#d8b36a" stroke-width="2"/><path d="M32 16 L46 32 L32 48 L18 32 Z" fill="none" stroke="#f3dca0" stroke-width="2"/></svg>';

export const BDO_ICONS = {};
export const BDO_ICONS_PLAIN = {};
let NEUTRAL = FALLBACK, NEUTRAL_PLAIN = FALLBACK;
try {
  for (const id of Object.keys(DEFS)) {
    try { BDO_ICONS[id] = build(id, DEFS[id], false); BDO_ICONS_PLAIN[id] = build(id, DEFS[id], true); } catch (e) { /* одна сломанная иконка не ломает остальные */ }
  }
  NEUTRAL = build('none', NEUTRAL_DEF, false); NEUTRAL_PLAIN = build('none', NEUTRAL_DEF, true);
} catch (e) { /* откат к заглушке */ }

export const ICON_IDS = Object.keys(BDO_ICONS);
/** Метаданные: вид (skill|rune|sigil|ui), стихия и её цвета — для подписей и вспышек в canvas. */
export const ICON_META = {};
for (const id of ICON_IDS) { const [tk, kind] = DEFS[id]; const t = T[tk] || T.time; ICON_META[id] = Object.freeze({ kind, theme: tk, glow: t[0], hi: t[3] }); }

/** SVG-строка иконки; для неизвестного id — нейтральная (ромб на каменном диске). opts.plain — без фона. */
export function iconSvg(id, opts) {
  const plain = !!(opts && opts.plain);
  return (plain ? BDO_ICONS_PLAIN[id] : BDO_ICONS[id]) || (plain ? NEUTRAL_PLAIN : NEUTRAL);
}

const URI_CACHE = new Map();
/** data:image/svg+xml;utf8,… — для CSS background-image: url("…") и canvas Image. Размер 64×64. */
export function iconDataUri(id, opts) {
  const key = (opts && opts.plain ? 'p:' : '') + id;
  let u = URI_CACHE.get(key);
  if (!u) {
    const svg = iconSvg(id, opts).replace('<svg ', '<svg width="64" height="64" ');
    u = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    URI_CACHE.set(key, u);
  }
  return u;
}

const IMG_CACHE = new Map();
/** Кэшированный Image для canvas (drawImage после img.complete). Без DOM — null. */
export function iconImage(id, opts) {
  try {
    if (typeof Image === 'undefined') return null;
    const key = (opts && opts.plain ? 'p:' : '') + id;
    let img = IMG_CACHE.get(key);
    if (!img) { img = new Image(); img.decoding = 'async'; img.src = iconDataUri(id, opts); IMG_CACHE.set(key, img); }
    return img;
  } catch (e) { return null; }
}
