/*
 * ASHEN OATH — ui.js
 * Роль №7: интерфейс, обучение и состояния приложения.
 * API_VERSION = ASHEN_V1
 *
 * export function createUI({ root, callbacks, options? })
 *   -> { update(viewModel), dispose(), cameraSlot, apiVersion }
 *
 * Модуль не открывает камеру, не импортирует Three.js, не меняет симуляцию и
 * не запускает собственный requestAnimationFrame. Весь DOM создаётся один раз
 * в createUI; update() меняет только текст, атрибуты, классы и transform —
 * и только когда значение действительно изменилось.
 *
 * Аргументы callbacks (расширение контракта, лишние аргументы безопасны):
 *   onStart({from:'menu'|'camera'|'calibration'|'tutorial', debug?:true})
 *   onEnableCamera()            onCalibrate()          onPause({reason:'user', via?:'keyboard'})
 *   onResume()                  onRestart()            onExit()
 *   onSettings(patch)           patch — часть settings, например {volume:0.4}
 *   onDebug(nextEnabled:boolean)
 *   [ASHEN_V2] onOath({from})  onTraining({from})  onBuyUpgrade(id)  onBack()  onExercise('pushups'|'squats')
 *   viewModel.progress = { points, earned, pushups, squats, embers[], emberTotal, upgrades[{id,name,level,max,cost,canBuy,now,next}] }
 *   viewModel.training = { exercise, reps, total, state, message, depth, lastOk, sinceRepMs,
 *     приседания: attempts, knee, view, lastHint{code,text,tMs}, sinceHintMs, faults{}, formScore, topFault{code,text,count}, debugSim }
 */

export const API_VERSION = 'ASHEN_V1';

const SCREENS = ['menu', 'camera', 'calibration', 'tutorial', 'playing', 'paused', 'victory', 'defeat', 'error', 'oath', 'training'];
const TRACK_STATES = ['idle', 'loading', 'permission', 'calibrating', 'ready', 'lost', 'error'];
const CAMERA_RUNNING = ['ready', 'lost', 'calibrating'];
const CAMERA_STARTING = ['permission', 'loading'];
const BOSS_NAME = 'Регент Нимба';
const QUALITY_OPTIONS = [['low', 'Низкое'], ['medium', 'Среднее'], ['high', 'Высокое']];
const QUALITY_VALUES = QUALITY_OPTIONS.map((q) => q[0]);
const DEFAULT_SETTINGS = Object.freeze({ quality: 'medium', volume: 0.8, reducedMotion: false, sensitivity: 1, hero: 'ashen' });
// [ASHEN_V3] выбор героя (модели — modules/heroModel.js)
// [HERO] [value, имя, «класс · стихия», { cls, element, desc: [3 строки] }] — данные из HEROES (modules/heroModel.js)
const HERO_OPTIONS = [
  ['ashen', 'Пепельный страж', 'Воин-маг · Пепел и пламя', { cls: 'Воин-маг', element: 'Пепел и пламя', desc: ['Клятвенный страж павшего святилища.', 'Латы из закалённой стали, посох с углём клятвы.', 'Держит удар и отвечает огнём.'] }],
  ['elf', 'Эльфийка', 'Лучница-заклинательница · Гроза', { cls: 'Лучница-заклинательница', element: 'Гроза', desc: ['Следопыт Сияющего леса.', 'Лук из белого ясеня и перстни-руны на пальцах.', 'Бьёт издалека и уходит рывком.'] }],
  ['dark', 'Тёмная чародейка', 'Чародейка · Тьма и лёд', { cls: 'Чародейка', element: 'Тьма и лёд', desc: ['Изгнанница из башни Затмения.', 'Посох с кристаллом ночи, плащ с живыми рунами.', 'Сковывает льдом и рвёт тьмой.'] }],
  ['ranger', 'Лучница', 'Лучница · Ветер', { cls: 'Лучница', element: 'Ветер', desc: ['Разведчица пограничных застав.', 'Капюшон следопыта, длинный лук и колчан за спиной.', 'Натягивает тетиву рукой — стрела летит в цель.'] }],
  ['archmage', 'Архимаг', 'Архимаг · Буря', { cls: 'Архимаг', element: 'Буря', desc: ['Последний магистр Грозовой коллегии.', 'Посох-громоотвод и плащ, прошитый рунами.', 'Лепит сферы молний двумя руками.'] }],
];
const PENDING_MS = 4000;
const IMPULSE_LATCH_MS = 900;
const STRAFE_SEEN = 0.35;
const BANNER_MS = 2600;

const SCREEN_ANNOUNCE = {
  menu: 'Главное меню',
  camera: 'Подключение камеры',
  calibration: 'Калибровка',
  tutorial: 'Обучение',
  playing: 'Бой',
  paused: 'Пауза',
  victory: 'Победа',
  defeat: 'Поражение',
  error: 'Ошибка',
  oath: 'Клятва героя: улучшения',
  training: 'Тренировка клятвы',
};

const DEBUG_KEYS_TEXT =
  'Клавиши отладки: W — вперёд, A и D — поворот (в «Джойстике» — шаг вбок), S — стоп (в «Джойстике» — назад), ' +
  'пробел — рывок по ходу, Q и E — рывок вбок, J — огонь, U — искра, I — рассечение, ' +
  'K — щит, F — парирование, L — выброс, O или P — сфера или призма; Esc — пауза. Это клавиатура, а не трекинг.';

const PART_NAMES = {
  head: 'голова',
  leftShoulder: 'левое плечо',
  rightShoulder: 'правое плечо',
  leftElbow: 'левый локоть',
  rightElbow: 'правый локоть',
  leftWrist: 'левая кисть',
  rightWrist: 'правая кисть',
};
const PART_ALIASES = {
  head: ['head', 'nose', 'face'],
  leftShoulder: ['leftShoulder', 'left_shoulder', 'shoulderL'],
  rightShoulder: ['rightShoulder', 'right_shoulder', 'shoulderR'],
  leftElbow: ['leftElbow', 'left_elbow', 'elbowL'],
  rightElbow: ['rightElbow', 'right_elbow', 'elbowR'],
  leftWrist: ['leftWrist', 'left_wrist', 'wristL', 'leftHand'],
  rightWrist: ['rightWrist', 'right_wrist', 'wristR', 'rightHand'],
};

let instanceSeq = 0;

/* ------------------------------------------------------------------ utils */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, fallback = 0) => (isNum(v) ? v : fallback);
const round2 = (v) => Math.round(v * 100) / 100;
// Русские склонения: 1 очко, 2 очка, 5 очков.
const plural = (n, one, few, many) => { const a = Math.abs(Math.trunc(n)) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; };
const pct = (v) => `${Math.round(clamp(v, 0, 1) * 100)}%`;

function fmtSeconds(sec) {
  if (sec >= 10) return `${Math.ceil(sec)} с`;
  return `${(Math.ceil(sec * 10) / 10).toFixed(1).replace('.', ',')} с`;
}
function fmtClock(sec) {
  const s = Math.max(0, Math.round(num(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtInt(v) {
  return Math.round(num(v)).toLocaleString('ru-RU');
}

/* Кэш последних значений: DOM трогаем только при изменении. */
const LAST = new WeakMap();
function memo(node) {
  let m = LAST.get(node);
  if (!m) {
    m = Object.create(null);
    LAST.set(node, m);
  }
  return m;
}
function setText(node, value) {
  const v = value == null ? '' : String(value);
  const m = memo(node);
  if (m.text !== v) {
    m.text = v;
    node.textContent = v;
  }
}
function setAttr(node, name, value) {
  const m = memo(node);
  const k = `a:${name}`;
  if (m[k] === value) return;
  m[k] = value;
  if (value === null || value === undefined || value === false) node.removeAttribute(name);
  else node.setAttribute(name, value === true ? '' : String(value));
}
function setClass(node, name, on) {
  const v = !!on;
  const m = memo(node);
  const k = `c:${name}`;
  if (m[k] === v) return;
  m[k] = v;
  node.classList.toggle(name, v);
}
function setStyle(node, prop, value) {
  const m = memo(node);
  const k = `s:${prop}`;
  if (m[k] === value) return;
  m[k] = value;
  node.style.setProperty(prop, value);
}
function setHidden(node, hidden) {
  const v = !!hidden;
  const m = memo(node);
  if (m.hidden === v) return;
  m.hidden = v;
  node.hidden = v;
}

/* ------------------------------------------------------------------ icons
 * Небольшие авторские символы. Только статические строки этого модуля
 * попадают в innerHTML; любые данные извне выводятся через textContent. */

const SVG24 =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const ICONS = {
  sigil:
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<circle cx="32" cy="32" r="21"/><circle cx="32" cy="32" r="16" stroke-opacity=".45"/>' +
    '<path d="M32 9v46"/><path d="M24.5 39.5 32 45l7.5-5.5"/>' +
    '<path d="M32 19.5c3.2 3 3.6 6.2 0 9.8-3.6-3.6-3.2-6.8 0-9.8z" fill="currentColor" fill-opacity=".28"/>' +
    '<path d="M11 32h6M47 32h6" stroke-opacity=".7"/></svg>',
  camera:
    `<svg ${SVG24}><rect x="3" y="6.5" width="13" height="11" rx="1.5"/>` +
    '<path d="M16 10.5 21 7.5v9l-5-3"/><circle cx="9.5" cy="12" r="2.3"/></svg>',
  chair: `<svg ${SVG24}><path d="M7 3.5v9.5h9.5"/><path d="M7 13v7.5M16.5 13v7.5"/><path d="M7 8.5h4"/></svg>`,
  frame:
    `<svg ${SVG24}><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>` +
    '<circle cx="12" cy="9.5" r="2.3"/><path d="M7.5 17c.7-2.6 2.4-3.9 4.5-3.9s3.8 1.3 4.5 3.9"/></svg>',
  lamp:
    `<svg ${SVG24}><circle cx="12" cy="12" r="3.8"/>` +
    '<path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"/></svg>',
  lock: `<svg ${SVG24}><rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  bolt:
    `<svg ${SVG24}><path d="M15.5 4.5 19.5 8.5 15.5 12.5 11.5 8.5z"/>` +
    '<path d="M12.5 11.5 4.5 19.5M9 11l-3.5 3.5M13 15l-3.5 3.5"/></svg>',
  shield: `<svg ${SVG24}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.6" stroke-dasharray="2.2 2.2"/></svg>`,
  burst:
    `<svg ${SVG24}><circle cx="12" cy="12" r="2.6"/>` +
    '<path d="M12 3v3.4M12 17.6V21M3 12h3.4M17.6 12H21M5.6 5.6l2.4 2.4M16 16l2.4 2.4M18.4 5.6 16 8M8 16l-2.4 2.4"/></svg>',
  dash: `<svg ${SVG24}><path d="M5 7l5 5-5 5M12 7l5 5-5 5"/></svg>`,
  pause: `<svg ${SVG24}><path d="M9 6.5v11M15 6.5v11"/></svg>`,
  check: `<svg ${SVG24}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  warn: `<svg ${SVG24}><path d="M12 4 21 19.5H3z"/><path d="M12 10v4.5M12 17.2v.01"/></svg>`,
};

/* Пиктограмма сидящего игрока. Вид со спины: правая рука фигуры справа. */
function figureGroup({ cx = 60, base = 86, s = 1, lean = 0, left = 'down', right = 'down', hi = {}, live = {} }) {
  const P = (x, y) => `${(cx + x * s).toFixed(1)},${(base + y * s).toFixed(1)}`;
  const nx = lean * 9;
  const shL = [nx - 17, -36 - lean * 3];
  const shR = [nx + 17, -36 + lean * 3];
  const arm = (sh, side, pose) => {
    const d = side === 'L' ? -1 : 1;
    const elbow = pose === 'up' ? [sh[0] + d * 9, sh[1] - 14] : [sh[0] + d * 5, sh[1] + 16];
    const wrist = pose === 'up' ? [sh[0] + d * 6, sh[1] - 29] : [sh[0] + d * 3, sh[1] + 30];
    return `M${P(sh[0], sh[1])} L${P(elbow[0], elbow[1])} L${P(wrist[0], wrist[1])}`;
  };
  const cls = (part) => (hi[part] ? 'f-hi' : 'f-base');
  const hx = cx + lean * 12 * s;
  const hy = base - 52 * s;
  return (
    `<path class="f-seat" d="M${P(-26, 4)} L${P(26, 4)}"/>` +
    `<path class="${cls('torso')} f-torso" d="M${P(0, 0)} L${P(nx, -36)}"/>` +
    `<path class="${cls('torso')}" d="M${P(shL[0], shL[1])} L${P(shR[0], shR[1])}"/>` +
    `<circle class="${cls('torso')} f-head" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="${(8 * s).toFixed(1)}"/>` +
    `<path class="${cls('armL')} f-arm-l ${live.armL || ''}" d="${arm(shL, 'L', left)}"/>` +
    `<path class="${cls('armR')} f-arm-r ${live.armR || ''}" d="${arm(shR, 'R', right)}"/>` +
    `<text class="f-lab" x="${(cx - 30 * s).toFixed(1)}" y="${(base - 4 * s).toFixed(1)}" text-anchor="middle">Л</text>` +
    `<text class="f-lab" x="${(cx + 30 * s).toFixed(1)}" y="${(base - 4 * s).toFixed(1)}" text-anchor="middle">П</text>`
  );
}
function svgWrap(inner) {
  return (
    '<svg class="ao-fig" viewBox="0 0 120 96" fill="none" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true" focusable="false">${inner}</svg>`
  );
}
function leanArrow(dir) {
  const x0 = 60 - dir * 13;
  const x1 = 60 + dir * 15;
  return (
    `<path class="f-arrow" d="M${x0} 16 Q60 7 ${x1} 15"/>` +
    `<path class="f-arrow" d="M${x1 - dir * 6} 10.5 L${x1} 15 L${x1 - dir * 6.5} 18.5"/>`
  );
}
function dashMarks(dir) {
  const x = 60 + dir * 36;
  const back = 60 - dir * 34;
  return (
    `<path class="f-arrow" d="M${x} 44 l${dir * 6} 6 l${-dir * 6} 6 M${x + dir * 7} 44 l${dir * 6} 6 l${-dir * 6} 6"/>` +
    `<path class="f-trail" d="M${back} 42 h${-dir * 9} M${back + dir * 2} 50 h${-dir * 12} M${back} 58 h${-dir * 9}"/>`
  );
}
function stickMark() {
  return '<circle class="f-trail" cx="30" cy="30" r="10"/><circle class="f-arrow" cx="36" cy="25" r="2.4"/>' +
    '<path class="f-arrow" d="M30 30 L35 25.5"/>';
}
function burstRays() {
  return '<path class="f-arrow" d="M60 5v6M47 9l3 4.5M73 9l-3 4.5M40 18l4.5 2M80 18l-4.5 2"/>';
}
/* [V5] «Руль»: пунктир — уровень груди (выше — идём), дуга со стрелками над ладонью — поворот. */
function steerMark() {
  return '<path class="f-trail" d="M12 56 H52" stroke-dasharray="2 3"/>' +
    '<path class="f-arrow" d="M25 15 Q37 5 49 15"/>' +
    '<path class="f-arrow" d="M25 15 l0.5 -5.5 M25 15 l5.2 -1.2 M49 15 l-0.5 -5.5 M49 15 l-5.2 -1.2"/>';
}

const TUTORIAL = [
  {
    // [V5] по умолчанию — «Руль»; поле stick — текст для схемы «Джойстик» (Настройки → Управление движением)
    key: 'strafe',
    title: 'Левая рука — руль',
    gesture: 'Левая рука у груди — герой идёт, у плеча — бежит. Рука в сторону — поворот туда же.',
    effect: 'Руку на колени — стоп. Замирать не нужно. У Регента рука вбок — обход по кругу.',
    svg: svgWrap(steerMark() + figureGroup({ left: 'up', hi: { armL: true } })),
    stick: {
      title: 'Левая рука — джойстик',
      gesture: 'Поднимите левую руку и на миг замрите — это центр. Вверх — вперёд, вниз — назад, вбок — вбок.',
      effect: 'Чуть от центра — шаг, дальше — бег. Руку на колени — герой встанет.',
      svg: svgWrap(stickMark() + figureGroup({ left: 'up', hi: { armL: true } })),
    },
  },
  {
    key: 'dash',
    title: 'Рывок',
    gesture: 'Резко дёрните левой рукой в любую сторону и верните её.',
    effect: 'Рывок туда же, на миг неуязвим — уход из зоны удара. Потом перезарядка.',
    svg: svgWrap(dashMarks(1) + figureGroup({ left: 'up', hi: { armL: true } })),
  },
  {
    key: 'hands',
    title: 'Огонь, щит, парирование',
    gesture: 'Правая: «OK» — снаряды, щелчок из кулака — «Искра», взмах ребром — «Рассечение». Левая: толчок ладонью к камере — щит, кулак → ладонь — парирование.',
    effect: 'Парирование отражает сферу в Регента.',
    svg: svgWrap(
      figureGroup({ cx: 31, base: 80, s: 0.74, right: 'up', hi: { armR: true }, live: { armR: 'f-live-attack' } }) +
        figureGroup({ cx: 89, base: 80, s: 0.74, left: 'up', hi: { armL: true }, live: { armL: 'f-live-shield' } }) +
        '<text class="f-cap" x="31" y="94" text-anchor="middle">снаряд</text>' +
        '<text class="f-cap" x="89" y="94" text-anchor="middle">щит</text>',
    ),
  },
  {
    key: 'both',
    title: 'Кулак и руны',
    gesture: 'Правый кулак подержите и резко раскройте — выброс. Правым указательным рисуйте в воздухе, держа фигуру прямо: ▲ ϟ ○ ★ @ ∞ ^ V ⧗ ℓ, в конце замрите.',
    effect: 'Копьё, оглушение, лечение, звездопад, вихрь, вечность, иглы, жатва, замедление Регента, сброс откатов.',
    svg: svgWrap(
      burstRays() +
        figureGroup({ left: 'up', right: 'up', hi: { armL: true, armR: true }, live: { armL: 'f-live-burst', armR: 'f-live-burst' } }),
    ),
  },
];

/* Чары двумя руками: сфера между ладонями или треугольник-призма из пальцев. */
function conjureMark() {
  return '<circle class="f-arrow" cx="60" cy="27" r="8"/><path class="f-arrow" d="M60 6v5M50 9l2.5 4M70 9l-2.5 4"/>';
}
TUTORIAL.push({
  key: 'conjure',
  title: 'Двумя руками',
  gesture: 'Сфера — ладони друг к другу, призма — треугольник пальцами; толкните к камере — чары летят. Хлопок, врата (ладони вместе → врозь), две «Г» — метка. Два указательных вместе рисуют ▲ или ♥.',
  effect: 'Волна, бастион, метка; ▲ — луч, ♥ — лечение и оберег.',
  svg: svgWrap(conjureMark() + figureGroup({ left: 'up', right: 'up', hi: { armL: true, armR: true }, live: { armL: 'f-live-burst', armR: 'f-live-burst' } })),
});

/* [HAND] Лук (левый кулак + правая щепоть) и магия рукой (сгусток в ладони). Фигура со спины, как у других карточек. */
function handFigureBase() {
  return '<path class="f-seat" d="M34 90 L86 90"/><path class="f-base f-torso" d="M60 86 L60 50"/>' +
    '<path class="f-base" d="M43 50 L77 50"/><circle class="f-base f-head" cx="60" cy="34" r="8"/>' +
    '<text class="f-lab" x="30" y="82" text-anchor="middle">Л</text><text class="f-lab" x="90" y="82" text-anchor="middle">П</text>';
}
function bowFigure() {
  return handFigureBase() +
    '<path class="f-hi f-arm-l f-live-attack" d="M43 50 L29 46 L16 44"/>' +
    '<path class="f-hi f-arm-r f-live-attack" d="M77 50 L89 42 L69 37"/>' +
    '<path class="f-arrow" d="M17 20 Q3 44 17 68"/><path class="f-trail" d="M17 20 L69 37 L17 68"/>' +
    '<path class="f-arrow" d="M69 37 L6 45 M6 45 l6 -4 M6 45 l6.5 3"/>';
}
function palmFlameFigure() {
  return handFigureBase() +
    '<path class="f-base f-arm-l" d="M43 50 L38 66 L40 80"/>' +
    '<path class="f-hi f-arm-r f-live-burst" d="M77 50 L90 45 L86 30"/><path class="f-hi" d="M80 29 L92 29"/>' +
    '<path class="f-arrow" d="M86 25 C80 20 82 13 85 8 C86 13 89 13 88 9 C93 14 93 21 86 25 Z"/>' +
    '<path class="f-trail" d="M97 22 l7 -2 M97 28 l8 1"/>';
}
TUTORIAL.push({
  key: 'bow',
  title: 'Лук',
  gesture: 'Левый кулак вперёд, щепоть правой — от кулака к уху, разжать: выстрел.',
  effect: 'Корпус к камере. Полное натяжение — сильнее; кулак вверх — «Дождь стрел»; руна при поднятом луке — стихия.',
  svg: svgWrap(bowFigure()),
}, {
  key: 'handMagic',
  title: 'Магия рукой',
  gesture: 'Правая ладонь вверх — огонь, «когти» — молния, вниз — лёд, кулак — земля.',
  effect: 'Сжимай и раскрывай пальцы — сгусток растёт. Толкни ладонь к камере или махни — бросок, опусти руку — отмена.',
  svg: svgWrap(palmFlameFigure()),
});

/* Карта видимых точек для калибровки (вид со спины, как в пиктограммах). */
const BODY_MAP_SVG =
  '<svg class="ao-bodymap__svg" viewBox="0 0 100 84" fill="none" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true" focusable="false">' +
  '<path class="b-bone" d="M30 38 L70 38 M30 38 L22 56 L20 72 M70 38 L78 56 L80 72 M50 30 L50 38 M50 38 L50 80"/>' +
  '<circle data-part="head" class="b-pt" cx="50" cy="18" r="9"/>' +
  '<circle data-part="leftShoulder" class="b-pt" cx="30" cy="38" r="4.2"/>' +
  '<circle data-part="rightShoulder" class="b-pt" cx="70" cy="38" r="4.2"/>' +
  '<circle data-part="leftElbow" class="b-pt" cx="22" cy="56" r="4.2"/>' +
  '<circle data-part="rightElbow" class="b-pt" cx="78" cy="56" r="4.2"/>' +
  '<circle data-part="leftWrist" class="b-pt" cx="20" cy="72" r="4.2"/>' +
  '<circle data-part="rightWrist" class="b-pt" cx="80" cy="72" r="4.2"/>' +
  '<text class="f-lab" x="8" y="44" text-anchor="middle">Л</text>' +
  '<text class="f-lab" x="92" y="44" text-anchor="middle">П</text>' +
  '</svg>';

/* ------------------------------------------------------------ normalizers */

function normSettings(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    quality: QUALITY_VALUES.includes(o.quality) ? o.quality : DEFAULT_SETTINGS.quality,
    volume: isNum(o.volume) ? clamp(o.volume, 0, 1) : DEFAULT_SETTINGS.volume,
    reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    sensitivity: isNum(o.sensitivity) ? clamp(o.sensitivity, 0.5, 2) : DEFAULT_SETTINGS.sensitivity,
    moveMode: o.moveMode === 'stick' ? 'stick' : 'steer', // [V5] по умолчанию «Руль»
    startZone: o.startZone === 'forest' ? 'forest' : 'arena', // [FOREST] место старта
    hero: HERO_OPTIONS.some(([v]) => v === o.hero) ? o.hero : DEFAULT_SETTINGS.hero,
  };
}

function normParts(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  let found = 0;
  for (const [part, aliases] of Object.entries(PART_ALIASES)) {
    for (const a of aliases) {
      const v = src[a];
      if (typeof v === 'boolean') {
        out[part] = v;
        found += 1;
        break;
      }
      if (isNum(v)) {
        out[part] = v >= 0.5;
        found += 1;
        break;
      }
    }
  }
  return found ? out : null;
}

function normTracking(t) {
  const o = t && typeof t === 'object' ? t : null;
  let status = 'idle';
  if (o) status = TRACK_STATES.includes(o.status) ? o.status : o.status == null ? 'idle' : 'unknown';
  const dbg = o && o.debug && typeof o.debug === 'object' ? o.debug : null;
  return {
    status,
    message: o && typeof o.message === 'string' ? o.message.trim().slice(0, 200) : '',
    progress: o && isNum(o.progress) ? clamp(o.progress, 0, 1) : null,
    confidence: o && isNum(o.confidence) ? clamp(o.confidence, 0, 1) : null,
    calibrated: o && typeof o.calibrated === 'boolean' ? o.calibrated : null,
    parts: normParts((o && o.parts) || (dbg && (dbg.parts || dbg.visibility))),
  };
}

function normInput(v) {
  if (!v || typeof v !== 'object') return null;
  const source = v.source === 'cv' || v.source === 'debug' ? v.source : 'none';
  const valid = v.valid === true;
  return {
    source,
    valid,
    calibrated: typeof v.calibrated === 'boolean' ? v.calibrated : null,
    moveX: valid ? clamp(num(v.moveX), -1, 1) : 0,
    dash: valid ? Math.sign(num(v.dash)) : 0,
    attack: valid && v.attack === true,
    shield: valid && v.shield === true,
    burst: valid && v.burst === true,
    // V2/V3-поля для карточек обучения (раньше отбрасывались, и «Распознано» у рывка-дёрга, рун, чар не загоралось)
    dashDir: valid && v.dashDir && typeof v.dashDir === 'object' ? v.dashDir : null,
    rune: valid && typeof v.rune === 'string' ? v.rune : null,
    conjure: valid && v.conjure && typeof v.conjure === 'object' ? v.conjure : null,
    throw: valid && v.throw && typeof v.throw === 'object' ? v.throw : null,
    // [ТВИСТ «ОШИБКА»] подсказка к почти-правильному жесту
    hint: valid && v.hint && typeof v.hint === 'object' && typeof v.hint.text === 'string'
      ? { code: String(v.hint.code || ''), gesture: String(v.hint.gesture || ''), text: v.hint.text, side: v.hint.side === 'left' || v.hint.side === 'right' ? v.hint.side : null }
      : null,
  };
}

function normCosts(c) {
  if (!c || typeof c !== 'object') return {};
  const out = {};
  for (const k of ['bolt', 'shield', 'burst']) if (isNum(c[k]) && c[k] > 0) out[k] = c[k];
  return out;
}

/* ------------------------------------------------------------ descriptions */

function describeTracking(tr, cfg) {
  switch (tr.status) {
    case 'idle':
      return { tone: 'neutral', label: 'Камера выключена' };
    case 'permission':
      return { tone: 'busy', label: 'Ждём разрешения браузера' };
    case 'loading':
      return {
        tone: 'busy',
        label:
          tr.progress !== null && tr.progress > 0 && tr.progress < 1
            ? `Загрузка модели распознавания: ${pct(tr.progress)}`
            : 'Загрузка модели распознавания',
      };
    case 'calibrating':
      return { tone: 'busy', label: `Калибровка: ${pct(tr.progress ?? 0)}` };
    case 'ready':
      if (tr.confidence === null) return { tone: 'neutral', label: 'Трекинг активен' };
      if (tr.confidence >= cfg.confidenceGood) return { tone: 'good', label: 'Трекинг устойчивый' };
      if (tr.confidence >= cfg.confidenceFair) return { tone: 'warn', label: 'Трекинг неуверенный' };
      return { tone: 'bad', label: 'Трекинг слабый' };
    case 'lost':
      return { tone: 'bad', label: 'Трекинг потерян' };
    case 'error':
      return { tone: 'bad', label: 'Ошибка камеры или распознавания' };
    default:
      return { tone: 'neutral', label: 'Статус трекинга неизвестен' };
  }
}
const DEBUG_INFO = Object.freeze({ tone: 'debug', label: 'Ввод: клавиатура' });

function explainError(raw) {
  const s = String(raw || '').toLowerCase();
  const has = (...keys) => keys.some((k) => s.includes(k));
  if (has('permissions policy', 'permission policy', 'feature policy', 'iframe', 'not allowed in this document')) {
    return {
      kind: 'iframe',
      retry: 'camera',
      title: 'Камеру блокирует встроенное окно',
      reason: 'Страница открыта внутри другого окна, которое не даёт доступ к камере.',
      steps: ['Откройте игру в отдельной вкладке через localhost или HTTPS.', 'Затем нажмите «Повторить».'],
    };
  }
  if (has('secure context', 'secure origin', 'insecure', 'only secure', 'securityerror')) {
    return {
      kind: 'secure',
      retry: 'camera',
      title: 'Нужен защищённый адрес',
      reason: 'Браузер даёт доступ к камере только на страницах https:// или http://localhost.',
      steps: [
        'Запустите игру через локальный сервер (localhost) или по HTTPS.',
        'Открытие файла двойным кликом для камеры и модулей не подходит.',
      ],
    };
  }
  if (has('notallowed', 'permission denied', 'permission dismissed', 'denied', 'отклон', 'запрещ')) {
    return {
      kind: 'denied',
      retry: 'camera',
      title: 'Доступ к камере запрещён',
      reason: 'Браузер или система не дали игре доступ к веб-камере.',
      steps: [
        'Нажмите значок камеры или замка в адресной строке и разрешите камеру для этого сайта.',
        'В Windows проверьте: Параметры, Конфиденциальность, Камера.',
        'Если игра открыта во встроенном превью, откройте её в отдельной вкладке.',
        'Затем нажмите «Повторить».',
      ],
    };
  }
  if (has('model', 'модел', 'распознав', 'wasm', '.task', 'tflite', 'mediapipe', 'failed to fetch', 'networkerror', 'network error', 'load failed', 'err_', '404')) {
    return {
      kind: 'model',
      retry: 'camera',
      title: 'Не загрузилась модель распознавания',
      reason: 'Библиотека MediaPipe или файл модели не были получены. Они загружаются по сети при запуске.',
      steps: [
        'Проверьте подключение к интернету.',
        'Убедитесь, что игра открыта через localhost или HTTPS.',
        'Нажмите «Повторить».',
      ],
    };
  }
  if (has('notfound', 'devicesnotfound', 'device not found', 'no camera', 'нет камеры', 'не найдена', 'отключил', 'не запустил')) {
    return {
      kind: 'nocamera',
      retry: 'camera',
      title: 'Камера не найдена',
      reason: 'Браузер не видит ни одной веб-камеры.',
      steps: ['Подключите камеру или включите её в системе.', 'Нажмите «Повторить».'],
    };
  }
  if (has('overconstrained', 'constraint')) {
    return {
      kind: 'constraints',
      retry: 'camera',
      title: 'Камера не поддерживает нужный режим',
      reason: 'Камера не смогла выдать запрошенное разрешение видео.',
      steps: ['Попробуйте другую камеру или нажмите «Повторить».'],
    };
  }
  if (has('notreadable', 'trackstart', 'could not start', 'in use', 'занята')) {
    return {
      kind: 'busy',
      retry: 'camera',
      title: 'Камера занята',
      reason: 'Камеру уже использует другое приложение или вкладка.',
      steps: ['Закройте видеозвонки, OBS и другие вкладки с камерой.', 'Нажмите «Повторить».'],
    };
  }
  if (has('webgl', 'gpu', 'context lost')) {
    return {
      kind: 'webgl',
      retry: 'restart',
      title: 'Не запустилась 3D-графика',
      reason: 'Браузер не дал игре доступ к WebGL.',
      steps: [
        'Включите аппаратное ускорение в настройках браузера.',
        'Обновите браузер или драйвер видеокарты.',
        'Попробуйте низкое качество графики.',
      ],
    };
  }
  if (has('getusermedia', 'mediadevices')) {
    return {
      kind: 'unsupported',
      retry: 'camera',
      title: 'Камера недоступна в этом окне',
      reason: 'Браузер не дал доступ к камере. Так бывает на адресе без HTTPS или в устаревшем браузере.',
      steps: ['Откройте игру через localhost или HTTPS в свежем Chrome или Edge.'],
    };
  }
  if (has('timeout', 'timed out', 'тайм')) {
    return {
      kind: 'timeout',
      retry: 'camera',
      title: 'Камера не ответила вовремя',
      reason: 'Запуск камеры или модели занял слишком много времени.',
      steps: ['Проверьте, что камера не занята, и нажмите «Повторить».'],
    };
  }
  return {
    kind: 'generic',
    retry: 'restart',
    title: 'Что-то пошло не так',
    reason: 'Игра остановилась из-за непредвиденной ошибки.',
    steps: ['Нажмите «Повторить».', 'Если ошибка повторяется, перезагрузите страницу.'],
  };
}

function shortRaw(raw) {
  const line =
    String(raw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^at\s/.test(l))[0] || '';
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

function telegraphText(tg) {
  const block = tg.blockable === true;
  switch (tg.kind) {
    case 'slam':
      return block ? 'Регент бьёт ладонью: уйдите из круга или держите щит.' : 'Регент бьёт ладонью: уйдите из круга.';
    case 'orb':
      return block ? 'Регент готовит сферу: уйдите с её пути или держите щит.' : 'Регент готовит сферу: уйдите с её пути.';
    case 'nova':
      return block ? 'Нимб разгорается: держите щит левой рукой.' : 'Нимб разгорается: щит не поможет, уходите рывком.';
    default:
      return 'Регент готовит атаку.';
  }
}

function defeatTip(stats, snap) {
  if (num(stats.blocks) === 0) return 'Поднятая левая рука держит щит: он гасит атаки, которые можно блокировать.';
  if (num(stats.dodges) === 0) return 'Резко дёрните левой рукой в сторону и верните её — рывок: им можно уйти из зоны удара.';
  if (snap && snap.boss && snap.boss.stage === 2) {
    return 'После половины здоровья страж усиливается. Следите за замахом и не стойте в зоне удара.';
  }
  return 'Держите правую руку поднятой между атаками Регента: снаряды летят, пока рука поднята.';
}

/* ================================================================ createUI */

export function createUI({ root, callbacks = {}, options = {} } = {}) {
  if (!root || typeof root.appendChild !== 'function') {
    throw new TypeError('createUI: root должен быть DOM-элементом');
  }
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || window;
  const uid = `ao${++instanceSeq}`;
  const cfg = {
    abilityCosts: normCosts(options.abilityCosts),
    confidenceGood: num(options.confidenceGood, 0.7),
    confidenceFair: num(options.confidenceFair, 0.4),
    keyboardPause: options.keyboardPause !== false,
    showVolume: options.showVolume !== false, // false — звук выключен в сборке, ползунок не показываем
  };

  let disposed = false;
  const cleanups = [];
  const timers = new Set();
  const warned = new Set();
  const controls = [];

  const state = {
    screen: null,
    debug: false,
    status: 'idle',
    settings: null,
    settingsKey: '',
    pending: {},
    calib: { observed: false, latched: false, resolved: false, error: '' },
    tut: { left: false, right: false, dash: false, attack: false, shield: false, burst: false, dashAt: -1e9, burstAt: -1e9, conj: false, thrown: false, throwAt: -1e9 },
    pause: { sawLost: false, variant: null },
    stage: 1,
    bannerTimer: 0,
    focusPending: false,
    errorKey: null,
    errorInfo: explainError(''),
  };

  /* ---------------------------------------------------------- plumbing */

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
  function later(fn, ms) {
    const id = win.setTimeout(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, ms);
    timers.add(id);
    return id;
  }
  function cancel(id) {
    if (!id) return;
    win.clearTimeout(id);
    timers.delete(id);
  }

  function invoke(name, arg) {
    if (disposed) return undefined;
    const fn = callbacks && callbacks[name];
    if (typeof fn !== 'function') {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[ui] callback ${name} не передан — кнопка ничего не сделает`);
      }
      return undefined;
    }
    let result;
    try {
      result = arg === undefined ? fn() : fn(arg);
    } catch (err) {
      console.error(`[ui] ${name} выбросил ошибку`, err);
      return undefined;
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error(`[ui] ${name} завершился ошибкой`, err));
    }
    return result;
  }

  function markPending(key) {
    state.pending[key] = { until: win.performance.now() + PENDING_MS, status: state.status };
  }
  function isPending(key, now) {
    const p = state.pending[key];
    if (!p) return false;
    if (now > p.until || p.status !== state.status) {
      delete state.pending[key];
      return false;
    }
    return true;
  }

  function pressEnable() {
    markPending('enable');
    invoke('onEnableCamera');
  }
  function pressCalibrate() {
    state.calib.latched = false;
    state.calib.resolved = false;
    state.calib.error = '';
    markPending('calibrate');
    const r = invoke('onCalibrate');
    if (r && typeof r.then === 'function') {
      r.then(
        (v) => {
          if (!disposed && v !== false) state.calib.resolved = true;
        },
        (err) => {
          if (!disposed) state.calib.error = err && err.message ? String(err.message) : String(err || 'Калибровка не удалась');
        },
      );
    }
  }

  /* ------------------------------------------------------- DOM helpers */

  function el(tag, props, ...kids) {
    const node = doc.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // только статические строки этого модуля
        else if (k === 'hidden') node.hidden = true;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof win.Node ? kid : doc.createTextNode(String(kid)));
    }
    return node;
  }
  function icon(name, cls = '') {
    return el('span', { class: `ao-icon ${cls}`.trim(), 'aria-hidden': 'true', html: ICONS[name] || '' });
  }
  function btn(label, onPress, { variant = 'secondary', iconName = null, size = '' } = {}) {
    const node = el('button', { type: 'button', class: `ao-btn ao-btn--${variant}${size ? ` ao-btn--${size}` : ''}` });
    if (iconName) node.append(icon(iconName, 'ao-btn__icon'));
    const labelNode = el('span', { class: 'ao-btn__label', text: label });
    node.append(labelNode);
    listen(node, 'click', (event) => {
      if (disposed) return;
      if (node.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        return;
      }
      onPress(event);
    });
    return { node, labelNode };
  }
  function setBtn(b, { label, disabled, hidden } = {}) {
    if (label !== undefined) setText(b.labelNode, label);
    if (disabled !== undefined) {
      setAttr(b.node, 'aria-disabled', disabled ? 'true' : null);
      setClass(b.node, 'is-disabled', disabled);
    }
    if (hidden !== undefined) setHidden(b.node, hidden);
  }
  function statusLine(extraClass = '') {
    const dot = el('span', { class: 'ao-dot', 'aria-hidden': 'true' });
    const label = el('span', { class: 'ao-status__label' });
    const detail = el('span', { class: 'ao-status__detail', hidden: true });
    const node = el('div', { class: `ao-status ${extraClass}`.trim(), 'data-tone': 'neutral' }, dot, el('span', { class: 'ao-status__text' }, label, detail));
    return { node, label, detail };
  }
  function paintStatus(s, info, detailText) {
    setAttr(s.node, 'data-tone', info.tone);
    setText(s.label, info.label);
    const d = detailText && detailText !== info.label ? detailText : '';
    setText(s.detail, d);
    setHidden(s.detail, !d);
  }
  function meter(label, cls = '') {
    const fill = el('span', { class: 'ao-meter__fill' });
    const node = el(
      'div',
      { class: `ao-meter ${cls}`.trim(), role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' },
      fill,
    );
    return { node, fill };
  }
  function paintMeter(m, frac) {
    const q = Math.round(clamp(num(frac), 0, 1) * 1000) / 1000;
    setStyle(m.fill, 'transform', `scaleX(${q})`);
    setAttr(m.node, 'aria-valuenow', String(Math.round(q * 100)));
  }
  function bar(kind, label) {
    const trail = el('span', { class: 'ao-bar__trail' });
    const fill = el('span', { class: 'ao-bar__fill' });
    const node = el(
      'div',
      { class: `ao-bar ao-bar--${kind}`, role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' },
      trail,
      fill,
    );
    if (kind === 'boss') node.append(el('span', { class: 'ao-bar__mark', 'aria-hidden': 'true' }));
    return { node, trail, fill };
  }
  function paintBar(b, frac) {
    const q = Math.round(clamp(num(frac), 0, 1) * 1000) / 1000;
    const v = `scaleX(${q})`;
    setStyle(b.fill, 'transform', v);
    setStyle(b.trail, 'transform', v);
    setAttr(b.node, 'aria-valuenow', String(Math.round(q * 100)));
  }
  function screenSection(name, panel, headingId) {
    return el('section', { class: `ao-screen ao-screen--${name}`, 'data-screen': name, 'aria-labelledby': headingId, hidden: true }, panel);
  }
  function heading(level, id, text, cls) {
    return el(level, { class: cls, id, tabindex: '-1', text });
  }
  function reqItem(iconName, title, text) {
    return el(
      'li',
      { class: 'ao-req' },
      icon(iconName, 'ao-req__icon'),
      el('div', { class: 'ao-req__text' }, el('strong', { text: title }), el('span', { text })),
    );
  }

  function errorBox() {
    const title = el('strong', { class: 'ao-errbox__title' });
    const reason = el('p', { class: 'ao-errbox__reason' });
    const steps = el('ul', { class: 'ao-errbox__steps' });
    const raw = el('code', { class: 'ao-errbox__raw' });
    const details = el('details', { class: 'ao-errbox__details' }, el('summary', { text: 'Техническая подробность' }), raw);
    const node = el('div', { class: 'ao-errbox', role: 'alert', hidden: true }, icon('warn', 'ao-errbox__icon'), el('div', { class: 'ao-errbox__body' }, title, reason, steps, details));
    let lastKey = null;
    return {
      node,
      show(rawText) {
        setHidden(node, false);
        const key = String(rawText || '');
        if (key === lastKey) return;
        lastKey = key;
        const info = explainError(key);
        title.textContent = info.title;
        reason.textContent = info.reason;
        steps.replaceChildren(...info.steps.map((s) => el('li', { text: s })));
        const line = shortRaw(key);
        raw.textContent = line;
        details.hidden = !line;
      },
      hide() {
        setHidden(node, true);
      },
    };
  }

  /* ---------------------------------------------------------- settings */

  function buildRange(o) {
    const id = `${uid}-${o.prefix}-${o.key}`;
    const input = el('input', { type: 'range', id, class: 'ao-range', min: o.min, max: o.max, step: o.step });
    const value = el('output', { class: 'ao-field__value', for: id });
    const hint = o.hint ? el('div', { class: 'ao-field__hint', id: `${id}-hint`, text: o.hint }) : null;
    if (hint) input.setAttribute('aria-describedby', `${id}-hint`);
    const field = el('div', { class: 'ao-field' }, el('div', { class: 'ao-field__head' }, el('label', { for: id, text: o.label }), value), input, hint);
    let lastSent = null;
    const paint = (v) => {
      const text = o.format(v);
      setText(value, text);
      setAttr(input, 'aria-valuetext', text);
      const f = clamp((o.toRaw(v) - o.min) / (o.max - o.min), 0, 1);
      setStyle(input, '--ao-fill', `${(f * 100).toFixed(1)}%`);
    };
    listen(input, 'input', () => {
      const v = round2(o.fromRaw(Number(input.value)));
      paint(v);
      if (v !== lastSent) {
        lastSent = v;
        invoke('onSettings', { [o.key]: v });
      }
    });
    const ctl = {
      sync(settings, force) {
        if (!force && doc.activeElement === input) return; // не перетираем то, что игрок держит сейчас
        const v = settings[o.key];
        const raw = o.toRaw(v);
        if (Number(input.value) !== raw) input.value = String(raw);
        lastSent = v;
        paint(v);
      },
    };
    listen(input, 'blur', () => {
      if (state.settings) ctl.sync(state.settings, true);
    });
    controls.push(ctl);
    return field;
  }

  function buildQuality(prefix) {
    const name = `${uid}-${prefix}-quality`;
    const seg = el('div', { class: 'ao-seg' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset' }, el('legend', { class: 'ao-field__legend', text: 'Качество графики' }), seg);
    const inputs = [];
    for (const [value, label] of QUALITY_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      seg.append(el('label', { class: 'ao-seg__opt' }, input, el('span', { class: 'ao-seg__label', text: label })));
      listen(input, 'change', () => {
        if (input.checked) invoke('onSettings', { quality: value });
      });
    }
    const ctl = {
      sync(settings, force) {
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) {
          const on = i.value === settings.quality;
          if (i.checked !== on) i.checked = on;
        }
      },
    };
    listen(fs, 'focusout', (e) => {
      if (!fs.contains(e.relatedTarget) && state.settings) ctl.sync(state.settings, true);
    });
    controls.push(ctl);
    return fs;
  }

  // [ASHEN_V3] выбор героя: три карточки-радиокнопки; камера меню показывает выбранного
  function buildHeroPick(prefix) {
    const name = `${uid}-${prefix}-hero`;
    const list = el('div', { class: 'ao-heroes' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset ao-heropick' }, el('legend', { class: 'ao-field__legend', text: 'Герой' }), list);
    const inputs = [];
    for (const [value, label, sub] of HERO_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-herocard__input' });
      inputs.push(input);
      list.append(el('label', { class: 'ao-herocard' }, input, el('span', { class: 'ao-herocard__name', text: label }), el('span', { class: 'ao-herocard__sub', text: sub })));
      listen(input, 'change', () => { if (input.checked) invoke('onSettings', { hero: value }); });
    }
    const ctl = {
      sync(settings, force) {
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) { const on = i.value === settings.hero; if (i.checked !== on) i.checked = on; }
      },
    };
    listen(fs, 'focusout', (e) => { if (!fs.contains(e.relatedTarget) && state.settings) ctl.sync(state.settings, true); });
    controls.push(ctl);
    return fs;
  }

  function buildMotion(prefix) {
    const id = `${uid}-${prefix}-motion`;
    const input = el('input', { type: 'checkbox', id, class: 'ao-check__input' });
    const node = el('div', { class: 'ao-field' }, el('label', { class: 'ao-check', for: id }, input, el('span', { text: 'Уменьшенное движение' })));
    listen(input, 'change', () => invoke('onSettings', { reducedMotion: input.checked }));
    const ctl = {
      sync(settings, force) {
        if (!force && doc.activeElement === input) return;
        if (input.checked !== settings.reducedMotion) input.checked = settings.reducedMotion;
      },
    };
    listen(input, 'blur', () => {
      if (state.settings) ctl.sync(state.settings, true);
    });
    controls.push(ctl);
    return node;
  }

  // [V5] «Управление движением»: Руль (по умолчанию) / Джойстик — тот же сегментный переключатель, что у качества
  const MOVE_OPTIONS = [['steer', 'Руль'], ['stick', 'Джойстик']];
  function buildMoveMode(prefix) {
    const name = `${uid}-${prefix}-movemode`;
    const seg = el('div', { class: 'ao-seg' });
    const hintId = `${name}-hint`;
    // в меню места мало (там же выбор героя) — пояснение только в паузе; в меню — подсказка у кнопок
    const hint = el('div', { class: 'ao-field__hint', id: hintId, hidden: prefix === 'menu' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset', 'aria-describedby': hintId }, el('legend', { class: 'ao-field__legend', text: 'Управление движением' }), seg, hint);
    const inputs = [];
    const TIPS = {
      steer: 'Руль: рука у груди — идти, у плеча — бег, вбок — поворот, вниз — стоп',
      stick: 'Джойстик: поднять руку и замереть — центр, дальше вести в нужную сторону',
    };
    for (const [value, label] of MOVE_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      seg.append(el('label', { class: 'ao-seg__opt', title: TIPS[value] }, input, el('span', { class: 'ao-seg__label', text: label })));
      listen(input, 'change', () => { if (input.checked) invoke('onSettings', { moveMode: value }); });
    }
    const paintHint = (m) => setText(hint, `${TIPS[m === 'stick' ? 'stick' : 'steer']}.`);
    const ctl = {
      sync(settings, force) {
        paintHint(settings.moveMode);
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) { const on = i.value === settings.moveMode; if (i.checked !== on) i.checked = on; }
      },
    };
    listen(fs, 'focusout', (e) => { if (!fs.contains(e.relatedTarget) && state.settings) ctl.sync(state.settings, true); });
    controls.push(ctl);
    return fs;
  }

  // [FOREST] «Место старта»: Пепельное плато (у арены) / Сияющий лес (у врат леса)
  const ZONE_OPTIONS = [['arena', 'Пепельное плато'], ['forest', 'Сияющий лес']];
  function buildStartZone(prefix) {
    const name = `${uid}-${prefix}-startzone`;
    const seg = el('div', { class: 'ao-seg' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset' }, el('legend', { class: 'ao-field__legend', text: 'Место старта' }), seg);
    const inputs = [];
    const TIPS = { arena: 'У арены Регента, на пепельном плато', forest: 'У эльфийских врат Сияющего леса, к северу от арены' };
    for (const [value, label] of ZONE_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      const short = prefix === 'menu' && value === 'arena' ? 'Плато' : label;   // в меню — коротко, чтобы встать в ряд
      seg.append(el('label', { class: 'ao-seg__opt', title: `${label}: ${TIPS[value]}` }, input, el('span', { class: 'ao-seg__label', text: short })));
      listen(input, 'change', () => { if (input.checked) invoke('onSettings', { startZone: value }); });
    }
    const ctl = {
      sync(settings, force) {
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) { const on = i.value === settings.startZone; if (i.checked !== on) i.checked = on; }
      },
    };
    listen(fs, 'focusout', (e) => { if (!fs.contains(e.relatedTarget) && state.settings) ctl.sync(state.settings, true); });
    controls.push(ctl);
    return fs;
  }

  function buildSettings(keys, prefix) {
    const wrap = el('div', { class: 'ao-settings' });
    for (const key of keys) {
      if (key === 'quality') wrap.append(buildQuality(prefix));
      else if (key === 'moveMode') wrap.append(buildMoveMode(prefix));
      else if (key === 'startZone') { // [FOREST] в одном ряду с «Управлением движением» (меню 1366×650 не растёт)
        const zs = buildStartZone(prefix), prev = wrap.lastElementChild;
        if (prev && keys[keys.indexOf(key) - 1] === 'moveMode') { const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 16px;align-items:flex-end' }); wrap.replaceChild(row, prev); row.append(prev, zs); }
        else wrap.append(zs);
      }
      else if (key === 'volume' && !cfg.showVolume) continue;
      else if (key === 'volume') {
        wrap.append(
          buildRange({
            key: 'volume', prefix, label: 'Громкость', min: 0, max: 100, step: 5,
            toRaw: (v) => Math.round(v * 100), fromRaw: (r) => r / 100, format: (v) => `${Math.round(v * 100)}%`,
          }),
        );
      } else if (key === 'sensitivity') {
        wrap.append(
          buildRange({
            key: 'sensitivity', prefix, label: 'Чувствительность движений', min: 50, max: 200, step: 5,
            hint: 'Чем выше, тем меньший наклон нужен для движения.',
            toRaw: (v) => Math.round(v * 100), fromRaw: (r) => r / 100, format: (v) => `${v.toFixed(2).replace('.', ',')}×`,
          }),
        );
      } else if (key === 'reducedMotion') wrap.append(buildMotion(prefix));
    }
    return wrap;
  }

  /* -------------------------------------------------------- root layer */

  const ui = el('div', { class: 'ao-ui', 'data-screen': 'none', 'data-api': API_VERSION });
  const backdrop = el('div', { class: 'ao-backdrop', 'aria-hidden': 'true' });
  const live = el('div', { class: 'ao-sr', role: 'status', 'aria-live': 'polite' });
  const liveAlert = el('div', { class: 'ao-sr', role: 'alert', 'aria-live': 'assertive' });
  const debugBadge = el('div', { class: 'ao-debug', hidden: true }, el('span', { class: 'ao-debug__main', text: 'DEBUG / НЕ CV' }), el('span', { class: 'ao-debug__sub', text: 'ввод с клавиатуры' }));
  const banner = el('div', { class: 'ao-banner', hidden: true, 'aria-hidden': 'true' });
  const park = el('div', { class: 'ao-slot-park', 'aria-hidden': 'true' });
  const slot = el('div', { class: 'ao-camera-slot ui-camera-slot', 'data-ui-camera-slot': '' });
  if (!doc.getElementById('ui-camera-slot')) slot.id = 'ui-camera-slot';
  park.append(slot);

  function announce(text, assertive = false) {
    const target = assertive ? liveAlert : live;
    target.textContent = text;
  }

  /* ---------------------------------------------------------------- MENU */

  const menu = (() => {
    const hid = `${uid}-menu-h`;
    const start = btn('Начать', () => invoke('onStart', { from: 'menu' }), { variant: 'primary', size: 'lg' });
    const oathBtn = btn('Клятва героя', () => invoke('onOath', { from: 'menu' }), { variant: 'secondary' });
    const netBtn = btn('Онлайн-дуэль', () => invoke('onNet', { from: 'menu' }), { variant: 'secondary' }); // [NET] экран лобби — modules/netLobby.js
    const oathPts = el('span', { class: 'ao-oathpts', hidden: true });
    const dbg = el('button', { type: 'button', class: 'ao-toggle', 'aria-pressed': 'false' }, el('span', { class: 'ao-toggle__track', 'aria-hidden': 'true' }), el('span', { class: 'ao-toggle__label', text: 'Отладка с клавиатуры' }));
    listen(dbg, 'click', () => invoke('onDebug', !state.debug));
    const dbgKeys = el('p', { class: 'ao-debugkeys', hidden: true, text: DEBUG_KEYS_TEXT });
    const title = el(
      'h1',
      { class: 'ao-title', id: hid, tabindex: '-1', lang: 'en', 'aria-label': 'ASHEN OATH' },
      el('span', { class: 'ao-title__word', text: 'ASHEN' }),
      el('span', { class: 'ao-title__rule', 'aria-hidden': 'true' }, el('span', { class: 'ao-title__sigil', html: ICONS.sigil })),
      el('span', { class: 'ao-title__word', text: 'OATH' }),
    );
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--menu' },
      title,
      el('p', { class: 'ao-subtitle', text: 'Бой с Регентом Нимба' }),
      el('p', { class: 'ao-cvnote' }, icon('camera', 'ao-cvnote__icon'), el('span', { text: 'Управление телом и руками через веб-камеру' })),
      el('div', { class: 'ao-menu__cta' }, el('div', { class: 'ao-menu__row' }, start.node, oathBtn.node, oathPts, netBtn.node /* [NET] */), el('p', { class: 'ao-note', text: 'Играется сидя. Нужны веб-камера, Chrome или Edge и устойчивый стул.' })),
      buildHeroPick('menu'),
      el('div', { class: 'ao-menu__settings' }, el('h2', { class: 'ao-h3', text: 'Настройки' }), buildSettings(['moveMode', 'startZone', 'quality', 'volume', 'reducedMotion'], 'menu')),
      el('div', { class: 'ao-menu__foot' }, dbg, dbgKeys),
    );
    return {
      section: screenSection('menu', panel, hid),
      heading: title,
      focus: () => start.node,
      update(ctx) {
        setAttr(dbg, 'aria-pressed', ctx.debug ? 'true' : 'false');
        setHidden(dbgKeys, !ctx.debug);
        const pts = ctx.vm.progress && isNum(ctx.vm.progress.points) ? ctx.vm.progress.points : 0;
        setText(oathPts, pts > 0 ? `${pts} ${plural(pts, 'очко', 'очка', 'очков')}` : '');
        setHidden(oathPts, !(pts > 0));
      },
    };
  })();

  /* -------------------------------------------------------------- CAMERA */

  const camera = (() => {
    const hid = `${uid}-cam-h`;
    const h = heading('h2', hid, 'Камера', 'ao-h2');
    const enable = btn('Разрешить камеру', pressEnable, { variant: 'primary', iconName: 'camera' });
    const next = btn('Далее: калибровка', () => invoke('onStart', { from: 'camera' }), { variant: 'primary' });
    const skip = btn('Продолжить без камеры (DEBUG)', () => invoke('onStart', { from: 'camera', debug: true }));
    const back = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const status = statusLine();
    const msg = el('p', { class: 'ao-msg' });
    const err = errorBox();
    const host = el('div', { class: 'ao-slothost' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--camera ao-frame' },
      el(
        'div',
        { class: 'ao-cols' },
        el(
          'div',
          { class: 'ao-col' },
          h,
          el('p', { class: 'ao-lead', text: 'Игра следит за плечами, локтями и кистями. Перед запросом разрешения проверьте три вещи.' }),
          el(
            'ul',
            { class: 'ao-reqs' },
            reqItem('chair', 'Сядьте устойчиво', 'Играют сидя. Лучше стул без колёс.'),
            reqItem('frame', 'Верх тела и кисти в кадре', 'Голова, плечи, локти и кисти. Пояс и ноги не нужны.'),
            reqItem('lamp', 'Мягкий свет спереди', 'Без яркого окна или лампы за спиной.'),
          ),
          el(
            'p',
            { class: 'ao-privacy' },
            icon('lock', 'ao-privacy__icon'),
            el('span', {
              text:
                'Кадры обрабатываются локально в браузере, только чтобы распознать позу. Игра не записывает видео и не отправляет его на сервер. ' +
                'Микрофон не нужен. По сети при запуске загружаются только библиотека и модель распознавания.',
            }),
          ),
        ),
        el('div', { class: 'ao-col ao-col--media' }, host, status.node, msg),
      ),
      err.node,
      el('div', { class: 'ao-actions' }, enable.node, next.node, skip.node, el('span', { class: 'ao-spacer' }), back.node),
    );
    let running = false;
    return {
      section: screenSection('camera', panel, hid),
      heading: h,
      host,
      focus: () => (running ? next.node : enable.node),
      update(ctx) {
        const st = ctx.tr.status;
        const pend = isPending('enable', ctx.now);
        running = CAMERA_RUNNING.includes(st);
        paintStatus(status, describeTracking(ctx.tr, cfg), st === 'error' ? '' : ctx.tr.message);
        let text;
        if (st === 'permission') {
          text = 'Браузер показывает запрос доступа к камере, обычно у адресной строки. Выберите «Разрешить». Если запроса не видно, нажмите значок камеры в адресной строке.';
        } else if (st === 'loading') {
          text = 'Загружаем библиотеку и модель распознавания позы. При первом запуске это может занять некоторое время.';
        } else if (st === 'ready' || st === 'calibrating') {
          text = 'Камера работает. Проверьте в превью, что видны голова, плечи, локти и кисти.';
        } else if (st === 'lost') {
          text = 'Камера работает, но поза не распознана. Сядьте так, чтобы в кадре были плечи и кисти.';
        } else if (st === 'error') {
          text = '';
        } else {
          text = pend ? 'Запрашиваем камеру…' : 'Нажмите «Разрешить камеру» и подтвердите запрос браузера.';
        }
        setText(msg, text);
        setHidden(msg, !text);
        if (st === 'error') err.show(ctx.errorText);
        else err.hide();
        let label = 'Разрешить камеру';
        if (st === 'permission') label = 'Ждём разрешения…';
        else if (st === 'loading') label = 'Загрузка модели…';
        else if (pend) label = 'Запрашиваем…';
        else if (st === 'error') label = 'Повторить';
        setBtn(enable, { hidden: running, disabled: pend || CAMERA_STARTING.includes(st), label });
        setBtn(next, { hidden: !running });
        setBtn(skip, { hidden: !ctx.debug || running });
        setAttr(host, 'data-tone', describeTracking(ctx.tr, cfg).tone);
      },
    };
  })();

  /* --------------------------------------------------------- CALIBRATION */

  function bodyIndicator() {
    const fig = el('div', { class: 'ao-bodymap', html: BODY_MAP_SVG });
    const partEls = {};
    fig.querySelectorAll('[data-part]').forEach((n) => {
      partEls[n.getAttribute('data-part')] = n;
    });
    const label = el('strong', { class: 'ao-body__label' });
    const note = el('span', { class: 'ao-body__note' });
    const node = el('div', { class: 'ao-body', 'data-state': 'unknown' }, fig, el('div', { class: 'ao-body__text' }, label, note));
    const paintParts = (fn) => {
      for (const [part, n] of Object.entries(partEls)) setAttr(n, 'data-vis', fn(part));
    };
    return {
      node,
      paint(tr) {
        const running = CAMERA_RUNNING.includes(tr.status);
        if (!running) {
          setAttr(node, 'data-state', 'unknown');
          paintParts(() => 'unknown');
          setText(label, 'Нет данных');
          setText(note, 'Камера ещё не распознаёт позу.');
          return;
        }
        if (tr.parts) {
          const missing = Object.keys(PART_NAMES).filter((p) => tr.parts[p] === false);
          paintParts((p) => (tr.parts[p] === true ? 'on' : tr.parts[p] === false ? 'off' : 'unknown'));
          if (tr.status === 'lost' && !missing.length) {
            setAttr(node, 'data-state', 'off');
            setText(label, 'Поза не распознана');
            setText(note, 'Нужны голова, плечи, локти и кисти.');
          } else if (missing.length) {
            setAttr(node, 'data-state', 'partial');
            setText(label, 'Не всё в кадре');
            setText(note, `Не видно: ${missing.map((p) => PART_NAMES[p]).join(', ')}.`);
          } else {
            setAttr(node, 'data-state', 'on');
            setText(label, 'Верх тела в кадре');
            setText(note, 'Все нужные точки видны.');
          }
          return;
        }
        if (tr.status === 'lost') {
          setAttr(node, 'data-state', 'off');
          paintParts(() => 'off');
          setText(label, 'Поза не распознана');
          setText(note, 'Нужны голова, плечи, локти и кисти.');
          return;
        }
        paintParts(() => 'unknown');
        if (tr.confidence === null) {
          setAttr(node, 'data-state', 'unknown');
          setText(label, 'Поза распознаётся');
          setText(note, 'Подробной карты точек нет, сверьтесь с превью камеры.');
        } else if (tr.confidence >= cfg.confidenceFair) {
          setAttr(node, 'data-state', 'on');
          setText(label, 'Поза распознана');
          setText(note, `Уверенность ${pct(tr.confidence)}. Подробной карты точек нет, сверьтесь с превью.`);
        } else {
          setAttr(node, 'data-state', 'partial');
          setText(label, 'Поза распознана неуверенно');
          setText(note, 'Добавьте света спереди или отодвиньтесь, чтобы в кадр попали кисти.');
        }
      },
    };
  }

  const calib = (() => {
    const hid = `${uid}-cal-h`;
    const h = heading('h2', hid, 'Калибровка', 'ao-h2');
    const host = el('div', { class: 'ao-slothost' });
    const body = bodyIndicator();
    const status = statusLine();
    const progress = meter('Прогресс калибровки', 'ao-meter--progress');
    const progressText = el('span', { class: 'ao-kv__v' });
    const conf = meter('Уверенность распознавания', 'ao-meter--conf');
    const confText = el('span', { class: 'ao-kv__v' });
    const msg = el('p', { class: 'ao-msg' });
    const err = errorBox();
    const enable = btn('Включить камеру', pressEnable, { variant: 'primary', iconName: 'camera' });
    const run = btn('Начать калибровку', pressCalibrate, { variant: 'primary' });
    const next = btn('Далее: обучение', () => invoke('onStart', { from: 'calibration' }), { variant: 'primary' });
    const back = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--calib ao-frame' },
      el(
        'div',
        { class: 'ao-cols' },
        el('div', { class: 'ao-col ao-col--media' }, host, body.node),
        el(
          'div',
          { class: 'ao-col' },
          h,
          el('p', { class: 'ao-lead', text: 'Игра запомнит вашу нейтральную позу. От неё считаются наклоны и подъём рук.' }),
          el(
            'ul',
            { class: 'ao-steps' },
            el('li', { text: 'Сядьте ровно и прислонитесь к спинке стула.' }),
            el('li', { text: 'Опустите руки, плечи расслаблены.' }),
            el('li', { text: 'Смотрите в экран и не двигайтесь, пока заполняется шкала.' }),
          ),
          el(
            'div',
            { class: 'ao-block' },
            status.node,
            el('div', { class: 'ao-kv' }, el('span', { class: 'ao-kv__k', text: 'Калибровка' }), progressText),
            progress.node,
            el('div', { class: 'ao-kv' }, el('span', { class: 'ao-kv__k', text: 'Уверенность распознавания' }), confText),
            conf.node,
          ),
          msg,
          err.node,
          buildSettings(['sensitivity'], 'calib'),
        ),
      ),
      el('div', { class: 'ao-actions' }, enable.node, run.node, next.node, el('span', { class: 'ao-spacer' }), back.node),
    );
    let done = false;
    let canRun = false;
    return {
      section: screenSection('calibration', panel, hid),
      heading: h,
      host,
      focus: () => (done || state.debug ? next.node : canRun ? run.node : enable.node),
      update(ctx) {
        const st = ctx.tr.status;
        const running = CAMERA_RUNNING.includes(st);
        const calibrating = st === 'calibrating';
        const pendRun = isPending('calibrate', ctx.now);
        const pendEnable = isPending('enable', ctx.now);
        done = ctx.calibrated === true && !calibrating && running;
        canRun = running && !calibrating;
        paintStatus(status, describeTracking(ctx.tr, cfg), st === 'error' ? '' : ctx.tr.message);
        const pv = calibrating ? ctx.tr.progress ?? 0 : done ? 1 : 0;
        paintMeter(progress, pv);
        setText(progressText, calibrating ? pct(pv) : done ? 'завершена' : 'не проведена');
        if (ctx.tr.confidence !== null && running) {
          paintMeter(conf, ctx.tr.confidence);
          setText(confText, pct(ctx.tr.confidence));
        } else {
          paintMeter(conf, 0);
          setText(confText, 'нет данных');
        }
        body.paint(ctx.tr);

        let text = '';
        if (ctx.debug) text = 'Режим DEBUG: управление с клавиатуры, калибровка не нужна. Это не проверка трекинга.';
        else if (calibrating) text = 'Держите нейтральную позу, пока заполняется шкала.';
        else if (done && st === 'ready') text = 'Калибровка завершена. Переходите к обучению или повторите калибровку.';
        else if (done && st === 'lost') text = 'Калибровка есть, но сейчас поза не распознана. Вернитесь в кадр.';
        else if (st === 'lost') text = 'Поза не распознана. Сядьте так, чтобы голова, плечи, локти и кисти попали в кадр.';
        else if (st === 'ready') text = 'Сядьте в нейтральную позу и нажмите «Начать калибровку».';
        else if (CAMERA_STARTING.includes(st)) text = 'Камера ещё запускается.';
        else if (st === 'idle' || st === 'unknown') text = 'Камера выключена. Включите её, чтобы откалибровать позу.';
        setText(msg, text);
        setHidden(msg, !text);

        if (st === 'error') err.show(ctx.errorText);
        else if (state.calib.error) err.show(state.calib.error);
        else err.hide();

        const off = !running && !CAMERA_STARTING.includes(st);
        setBtn(enable, { hidden: !off, disabled: pendEnable, label: pendEnable ? 'Запрашиваем…' : st === 'error' ? 'Повторить' : 'Включить камеру' });
        let runLabel = 'Начать калибровку';
        if (calibrating) runLabel = 'Калибровка…';
        else if (CAMERA_STARTING.includes(st)) runLabel = 'Ждём камеру…';
        else if (done) runLabel = 'Повторить калибровку';
        setBtn(run, { hidden: off, disabled: !canRun || pendRun, label: runLabel });
        setClass(run.node, 'ao-btn--primary', !done);
        setClass(run.node, 'ao-btn--secondary', done);
        setBtn(next, { hidden: !(done || ctx.debug), label: ctx.debug && !done ? 'Далее: обучение (DEBUG)' : 'Далее: обучение' });
        setAttr(host, 'data-tone', describeTracking(ctx.tr, cfg).tone);
      },
    };
  })();

  /* ------------------------------------------------------------ TUTORIAL */

  const tutorial = (() => {
    const hid = `${uid}-tut-h`;
    const h = heading('h2', hid, 'Как управлять', 'ao-h2');
    const cards = {};
    const grid = el('div', { class: 'ao-tut-grid' });
    for (const item of TUTORIAL) {
      const chipText = el('span', { class: 'ao-chip__text' });
      const chip = el('span', { class: 'ao-chip', 'data-state': 'try', hidden: true }, icon('check', 'ao-chip__icon'), chipText);
      let lean = null;
      if (item.key === 'strafe') {
        const mark = el('span', { class: 'ao-lean__mark' });
        lean = {
          mark,
          node: el(
            'div',
            { class: 'ao-lean', hidden: true, 'aria-hidden': 'true' },
            el('span', { class: 'ao-lean__lab', text: 'влево' }),
            el('span', { class: 'ao-lean__track' }, el('span', { class: 'ao-lean__mid' }), mark),
            el('span', { class: 'ao-lean__lab', text: 'вправо' }),
          ),
        };
      }
      // [V5] у карточки движения два текста: «Руль» (item) и «Джойстик» (item.stick) — по настройке
      const figEl = el('div', { class: 'ao-tut-fig', html: item.svg });
      const titleEl = el('h3', { class: 'ao-h3', text: item.title });
      const gestEl = el('p', { class: 'ao-tut-gesture', text: item.gesture });
      const effEl = el('p', { class: 'ao-tut-effect', text: item.effect });
      const card = el(
        'article',
        { class: 'ao-tut-card', 'data-key': item.key },
        figEl,
        titleEl,
        gestEl,
        effEl,
        lean && lean.node,
        chip,
      );
      cards[item.key] = { card, chip, chipText, lean, item, figEl, titleEl, gestEl, effEl, mode: 'steer' };
      grid.append(card);
    }
    const host = el('div', { class: 'ao-slothost' });
    const status = statusLine();
    const ready = el('p', { class: 'ao-msg' });
    // [ТВИСТ «ОШИБКА»] почти-правильный жест на обучении: что не так и как исправить
    const coachHead = el('span', { class: 'ao-tut-coach__head' });
    const coachText = el('span', { class: 'ao-tut-coach__text' });
    const coach = el('div', { class: 'ao-tut-coach', role: 'status', 'aria-live': 'polite', hidden: true }, coachHead, coachText);
    const start = btn('В бой', () => invoke('onStart', { from: 'tutorial' }), { variant: 'primary', size: 'lg' });
    const recal = btn('Перекалибровать', pressCalibrate);
    const back = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--tutorial ao-frame' },
      el('div', { class: 'ao-head' }, h, el('p', { class: 'ao-lead', text: 'Левая рука ведёт героя, обе руки колдуют — всё сидя и без большой амплитуды.' })),
      grid,
      el(
        'div',
        { class: 'ao-tut-foot' },
        el('div', { class: 'ao-tut-cam' }, host),
        el(
          'div',
          { class: 'ao-tut-ready' },
          status.node,
          ready,
          coach,
          el('p', { class: 'ao-note', text: 'Остановить бой: кнопка «Пауза» в углу экрана или Esc. Если выйти из кадра, бой встанет на паузу сам.' }),
          el('div', { class: 'ao-actions ao-actions--inline' }, start.node, recal.node, el('span', { class: 'ao-spacer' }), back.node),
        ),
      ),
    );
    const setChip = (c, st, text) => {
      setHidden(c.chip, false);
      setAttr(c.chip, 'data-state', st);
      setText(c.chipText, text);
    };
    return {
      section: screenSection('tutorial', panel, hid),
      heading: h,
      host,
      focus: () => start.node,
      reset() {
        Object.assign(state.tut, { left: false, right: false, dash: false, attack: false, shield: false, burst: false, dashAt: -1e9, burstAt: -1e9, conj: false, thrown: false, throwAt: -1e9, hint: null });
        Object.assign(state.tut, { bowHold: false, bowShot: false, bowAt: -1e9, orb: false, orbThrown: false, orbAt: -1e9 }); // [HAND]
      },
      update(ctx) {
        const st = ctx.tr.status;
        const canStart = ctx.debug || (st === 'ready' && ctx.calibrated !== false);
        setBtn(start, { disabled: !canStart });
        setBtn(recal, { hidden: ctx.debug });
        paintStatus(status, ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg), ctx.debug ? '' : ctx.tr.message);
        let text;
        if (ctx.debug) text = 'Бой начнётся с управлением с клавиатуры. Это режим отладки, камера в нём не управляет героем.';
        else if (canStart) text = 'Трекинг готов. Начинайте, когда удобно сели.';
        else if (ctx.calibrated === false) text = 'Нужна калибровка. Нажмите «Перекалибровать».';
        else if (st === 'lost') text = 'Камера не видит позу. Кнопка «В бой» станет доступна, когда трекинг восстановится.';
        else if (st === 'calibrating') text = 'Идёт калибровка.';
        else text = 'Камера ещё не готова.';
        setText(ready, text);
        // [V5] тексты карточки движения — под выбранную схему («Руль» / «Джойстик»)
        const moveMode = ctx.settings && ctx.settings.moveMode === 'stick' ? 'stick' : 'steer';
        for (const c of Object.values(cards)) {
          if (!c.item.stick || c.mode === moveMode) continue;
          c.mode = moveMode;
          const v = moveMode === 'stick' ? { ...c.item, ...c.item.stick } : c.item;
          setText(c.titleEl, v.title); setText(c.gestEl, v.gesture); setText(c.effEl, v.effect);
          c.figEl.innerHTML = v.svg; // только статические строки этого модуля
        }

        const inp = ctx.input;
        const liveCv = !!inp && inp.source === 'cv' && !ctx.debug;
        const t = state.tut;
        if (inp && inp.hint && inp.hint.text) t.hint = { ...inp.hint, at: ctx.now };
        const showHint = !!t.hint && ctx.now - t.hint.at < 4500;
        setHidden(coach, !showHint);
        if (showHint) {
          const side = t.hint.side === 'left' ? ' · левая рука' : t.hint.side === 'right' ? ' · правая рука' : '';
          setText(coachHead, `Ошибка · ${t.hint.gesture}${side}`);
          setText(coachText, t.hint.text);
        }
        if (liveCv && inp.valid) {
          if (inp.moveX <= -STRAFE_SEEN) t.left = true;
          if (inp.moveX >= STRAFE_SEEN) t.right = true;
          if (inp.dash !== 0 || inp.dashDir) {
            t.dash = true;
            t.dashAt = ctx.now;
          }
          if (inp.attack) t.attack = true;
          if (inp.shield) t.shield = true;
          if (inp.burst || inp.rune) {
            t.burst = true;
            t.burstAt = ctx.now;
          }
          if (inp.conjure) t.conj = true;
          if (inp.throw) {
            t.thrown = true;
            t.throwAt = ctx.now;
          }
          // [HAND] лук и магия рукой: поля есть только в сыром вводе (normInput их не пропускает)
          const hb = ctx.vm && ctx.vm.input && ctx.vm.input.bow, hs = ctx.vm && ctx.vm.input && ctx.vm.input.handSpell;
          if (hb && hb.active) t.bowHold = true;
          if (hb && hb.release) { t.bowShot = true; t.bowAt = ctx.now; }
          if (hs && (hs.phase === 'form' || hs.phase === 'hold')) t.orb = true;
          if (hs && hs.phase === 'throw') { t.orbThrown = true; t.orbAt = ctx.now; }
        }
        for (const c of Object.values(cards)) {
          if (!liveCv) setHidden(c.chip, true);
          if (c.lean) setHidden(c.lean.node, !liveCv);
        }
        if (!liveCv) {
          for (const c of Object.values(cards)) {
            setClass(c.card, 'is-now', false);
            setClass(c.card, 'is-attack', false);
            setClass(c.card, 'is-shield', false);
          }
          return;
        }
        if (!inp.valid) {
          for (const c of Object.values(cards)) setChip(c, 'nodata', 'Нет трекинга');
        } else {
          const s = cards.strafe;
          if (t.left && t.right) setChip(s, 'seen', 'Распознано');
          else if (t.left) setChip(s, 'partial', 'Есть влево, теперь вправо');
          else if (t.right) setChip(s, 'partial', 'Есть вправо, теперь влево');
          else setChip(s, 'try', 'Попробуйте');
          setChip(cards.dash, t.dash ? 'seen' : 'try', t.dash ? 'Распознано' : 'Попробуйте');
          const hnd = cards.hands;
          if (t.attack && t.shield) setChip(hnd, 'seen', 'Распознано');
          else if (t.attack) setChip(hnd, 'partial', 'Есть правая, теперь левая');
          else if (t.shield) setChip(hnd, 'partial', 'Есть левая, теперь правая');
          else setChip(hnd, 'try', 'Попробуйте');
          setChip(cards.both, t.burst ? 'seen' : 'try', t.burst ? 'Распознано' : 'Попробуйте');
          if (cards.conjure) {
            if (t.thrown) setChip(cards.conjure, 'seen', 'Распознано');
            else if (t.conj) setChip(cards.conjure, 'partial', 'Чары есть, теперь толкните ладони к камере');
            else setChip(cards.conjure, 'try', 'Попробуйте');
          }
          // [HAND]
          if (cards.bow) setChip(cards.bow, t.bowShot ? 'seen' : t.bowHold ? 'partial' : 'try', t.bowShot ? 'Распознано' : t.bowHold ? 'Стрела наложена — натяните и разожмите пальцы' : 'Попробуйте');
          if (cards.handMagic) setChip(cards.handMagic, t.orbThrown ? 'seen' : t.orb ? 'partial' : 'try', t.orbThrown ? 'Распознано' : t.orb ? 'Сгусток есть — бросьте его резким движением' : 'Попробуйте');
        }
        const mx = inp.valid ? inp.moveX : 0;
        setStyle(cards.strafe.lean.mark, 'left', `${(50 + mx * 50).toFixed(1)}%`);
        setClass(cards.strafe.card, 'is-now', Math.abs(mx) >= STRAFE_SEEN);
        setClass(cards.dash.card, 'is-now', ctx.now - t.dashAt < IMPULSE_LATCH_MS);
        setClass(cards.hands.card, 'is-attack', inp.attack);
        setClass(cards.hands.card, 'is-shield', inp.shield);
        setClass(cards.both.card, 'is-now', ctx.now - t.burstAt < IMPULSE_LATCH_MS);
        if (cards.conjure) setClass(cards.conjure.card, 'is-now', !!inp.conjure || ctx.now - t.throwAt < IMPULSE_LATCH_MS);
        { // [HAND]
          const hb = ctx.vm && ctx.vm.input && ctx.vm.input.bow, hs = ctx.vm && ctx.vm.input && ctx.vm.input.handSpell;
          if (cards.bow) setClass(cards.bow.card, 'is-now', !!(hb && hb.active) || ctx.now - (t.bowAt || -1e9) < IMPULSE_LATCH_MS);
          if (cards.handMagic) setClass(cards.handMagic.card, 'is-now', !!(hs && hs.phase !== 'idle') || ctx.now - (t.orbAt || -1e9) < IMPULSE_LATCH_MS);
        }
      },
    };
  })();

  /* -------------------------------------------------------------- PAUSED */

  const paused = (() => {
    const hid = `${uid}-pause-h`;
    const h = heading('h2', hid, 'Пауза', 'ao-h2');
    const lead = el('p', { class: 'ao-lead' });
    const host = el('div', { class: 'ao-slothost' });
    const status = statusLine();
    const hint = el('p', { class: 'ao-note', hidden: true });
    const resume = btn('Продолжить бой', () => invoke('onResume'), { variant: 'primary', size: 'lg' });
    const recal = btn('Перекалибровать', pressCalibrate);
    const restart = btn('Начать бой заново', () => invoke('onRestart'));
    const oathP = btn('Клятва героя', () => invoke('onOath', { from: 'paused' }));
    const exit = btn('Выйти в меню', () => invoke('onExit'), { variant: 'quiet' });
    const dbgKeys = el('p', { class: 'ao-debugkeys', hidden: true, text: DEBUG_KEYS_TEXT });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--pause ao-frame' },
      el('div', { class: 'ao-head' }, h, lead),
      el(
        'div',
        { class: 'ao-cols' },
        el('div', { class: 'ao-col ao-col--media' }, host, status.node, hint),
        el('div', { class: 'ao-col' }, el('h3', { class: 'ao-h3', text: 'Настройки' }), buildSettings(['moveMode', 'volume', 'sensitivity', 'quality', 'reducedMotion'], 'pause')),
      ),
      dbgKeys,
      el('div', { class: 'ao-actions' }, resume.node, recal.node, restart.node, oathP.node, el('span', { class: 'ao-spacer' }), exit.node),
    );
    const COPY = {
      user: ['Пауза', 'Бой остановлен и сам не продолжится.'],
      lost: [
        'Трекинг потерян',
        'Камера перестала видеть позу, поэтому бой встал на паузу. Вернитесь в кадр так, чтобы были видны голова, плечи, локти и кисти, и проверьте свет. Если поза сбилась, перекалибруйте.',
      ],
      restored: ['Трекинг восстановлен', 'Сядьте в нейтральную позу и опустите руки. Бой продолжится только после нажатия «Продолжить бой».'],
    };
    return {
      section: screenSection('paused', panel, hid),
      heading: h,
      host,
      focus: () => resume.node,
      update(ctx) {
        const st = ctx.tr.status;
        const bad = st === 'lost' || st === 'error';
        if (!ctx.debug && (bad || ctx.vm.pauseReason === 'tracking')) state.pause.sawLost = true;
        let variant = 'user';
        if (!ctx.debug && state.pause.sawLost) variant = st === 'ready' ? 'restored' : 'lost';
        if (variant !== state.pause.variant) {
          if (state.pause.variant !== null || variant !== 'user') announce(COPY[variant][0], variant === 'lost');
          state.pause.variant = variant;
        }
        setAttr(panel, 'data-variant', variant);
        setText(h, COPY[variant][0]);
        setText(lead, COPY[variant][1]);
        paintStatus(status, ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg), ctx.debug ? '' : ctx.tr.message);
        const canResume = ctx.debug || (st === 'ready' && ctx.calibrated !== false);
        setBtn(resume, { disabled: !canResume });
        let hintText = '';
        if (!canResume) {
          if (ctx.calibrated === false && st === 'ready') hintText = 'Нужна калибровка: нажмите «Перекалибровать».';
          else if (bad) hintText = 'Кнопка «Продолжить бой» станет доступна, когда камера снова увидит плечи и кисти.';
          else hintText = 'Камера ещё не готова.';
        }
        setText(hint, hintText);
        setHidden(hint, !hintText);
        setBtn(recal, { hidden: ctx.debug });
        setHidden(dbgKeys, !ctx.debug);
        setAttr(host, 'data-tone', ctx.debug ? 'debug' : describeTracking(ctx.tr, cfg).tone);
      },
    };
  })();

  /* ------------------------------------------------------------- RESULTS */

  function resultScreen(kind) {
    const win_ = kind === 'victory';
    const hid = `${uid}-${kind}-h`;
    const h = heading('h2', hid, win_ ? 'Регент повержен' : 'Вы пали', 'ao-h1');
    const summary = el('p', { class: 'ao-lead' });
    const rows = {};
    const stats = el('dl', { class: 'ao-stats' });
    const ROWS = [
      ['time', 'Время боя'],
      ['dealt', 'Нанесено урона'],
      ['taken', 'Получено урона'],
      ['dodges', 'Уклонения'],
      ['blocks', 'Блоки щитом'],
      ['remain', win_ ? 'Здоровье героя' : 'Здоровье Регента'],
      ['accuracy', 'Точность жестов'],
    ];
    for (const [key, label] of ROWS) {
      const dd = el('dd', { class: 'ao-stat__v', text: '—' });
      stats.append(el('div', { class: 'ao-stat' }, el('dt', { class: 'ao-stat__k', text: label }), dd));
      rows[key] = dd;
    }
    const tip = el('p', { class: 'ao-tip', hidden: true });
    // [ТВИСТ «ОШИБКА»] самая частая ошибка жеста за бой и как её исправить
    const coachTip = el('p', { class: 'ao-tip ao-tip--coach', hidden: true });
    const again = btn('Сразиться снова', () => invoke('onRestart'), { variant: 'primary', size: 'lg' });
    const oathR = btn('Клятва героя', () => invoke('onOath', { from: kind }));
    const exit = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: `ao-panel ao-panel--result ao-panel--${kind} ao-frame` },
      el('div', { class: 'ao-result__mark', html: ICONS.sigil, 'aria-hidden': 'true' }),
      h,
      summary,
      stats,
      coachTip,
      tip,
      el('div', { class: 'ao-actions ao-actions--center' }, again.node, oathR.node, exit.node),
    );
    return {
      section: screenSection(kind, panel, hid),
      heading: h,
      focus: () => again.node,
      update(ctx) {
        const s = ctx.snap;
        if (!s) {
          for (const dd of Object.values(rows)) setText(dd, '—');
          setText(summary, win_ ? 'Бой окончен победой.' : 'Бой окончен.');
          setHidden(tip, true);
          return;
        }
        const st = s.stats && typeof s.stats === 'object' ? s.stats : {};
        const p = s.player || {};
        const b = s.boss || {};
        setText(rows.time, fmtClock(s.time));
        setText(rows.dealt, fmtInt(st.damageDealt));
        setText(rows.taken, fmtInt(st.damageTaken));
        setText(rows.dodges, fmtInt(st.dodges));
        setText(rows.blocks, fmtInt(st.blocks));
        const c = ctx.coach;
        setText(rows.accuracy, c && Number.isFinite(c.accuracy) ? `${c.accuracy}%  ·  ${c.good} из ${c.good + c.mistakes} жестов без ошибки` : '—');
        if (c && c.top) {
          setText(coachTip, `Чаще всего не получалось: ${c.top.gesture} (×${c.top.count}). ${c.top.text}.`);
          setHidden(coachTip, false);
        } else setHidden(coachTip, true);
        if (win_) {
          const maxHp = Math.max(1, num(p.maxHp, 1));
          setText(rows.remain, `${Math.ceil(clamp(num(p.hp), 0, maxHp))} из ${Math.round(maxHp)}`);
          setText(summary, num(st.damageTaken) === 0 ? 'Бой без единого пропущенного удара.' : 'Обет исполнен: страж больше не поднимется.');
          setHidden(tip, true);
        } else {
          const maxHp = Math.max(1e-6, num(b.maxHp, 1));
          const left = clamp(num(b.hp) / maxHp, 0, 1);
          setText(rows.remain, pct(left));
          let text = `Регент устоял: у него осталось ${pct(left)} здоровья.`;
          if (b.stage === 2) text += ' Вы довели бой до второй стадии.';
          setText(summary, text);
          setText(tip, defeatTip(st, s));
          setHidden(tip, false);
        }
      },
    };
  }
  const victory = resultScreen('victory');
  const defeat = resultScreen('defeat');

  /* ------------------------------------------------- [ASHEN_V2] КЛЯТВА */
  // Очки клятвы и улучшения. Карточки создаются один раз — при первом списке улучшений.

  const oath = (() => {
    const hid = `${uid}-oath-h`;
    const h = heading('h2', hid, 'Клятва героя', 'ao-h2');
    const pts = el('strong', { class: 'ao-oath__pts', text: '0' });
    const ptsLabel = el('span', { class: 'ao-oath__ptslabel', text: 'очков клятвы' });
    const meta = el('p', { class: 'ao-note ao-oath__meta' });
    const grid = el('div', { class: 'ao-upgs', role: 'list' });
    const cards = new Map();
    const train = btn('Тренировка: отжимания и приседания', () => invoke('onTraining', { from: 'oath' }), { variant: 'primary' });
    const back = btn('Назад', () => invoke('onBack'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--oath ao-frame' },
      el('div', { class: 'ao-oath__head' },
        el('div', {}, h, el('p', { class: 'ao-lead', text: 'Отжимание или чистое приседание перед камерой — 1 очко клятвы, уголь, зажжённый на плато, — 3 очка.' })),
        el('div', { class: 'ao-oath__bank' }, pts, ptsLabel)),
      meta,
      grid,
      el('div', { class: 'ao-actions' }, train.node, el('span', { class: 'ao-spacer' }), back.node),
    );
    function card(u) {
      const name = el('strong', { class: 'ao-upg__name', text: u.name });
      const pips = el('span', { class: 'ao-upg__pips', 'aria-hidden': 'true' });
      const now = el('p', { class: 'ao-upg__now' });
      const next = el('p', { class: 'ao-upg__next' });
      const buy = btn('Улучшить', () => invoke('onBuyUpgrade', u.id), { variant: 'secondary', size: 'sm' });
      const node = el('div', { class: 'ao-upg', role: 'listitem', 'data-id': u.id }, el('div', { class: 'ao-upg__top' }, name, pips), now, next, buy.node);
      grid.append(node);
      return { node, pips, now, next, buy, key: '' };
    }
    return {
      section: screenSection('oath', panel, hid),
      heading: h,
      focus: () => train.node,
      update(ctx) {
        const P = ctx.vm.progress && typeof ctx.vm.progress === 'object' ? ctx.vm.progress : null;
        const points = P && isNum(P.points) ? P.points : 0;
        setText(pts, String(points));
        setText(ptsLabel, plural(points, 'очко клятвы', 'очка клятвы', 'очков клятвы'));
        const et = P && isNum(P.emberTotal) ? P.emberTotal : 0;
        setText(meta, P ? `Отжиманий всего: ${num(P.pushups)} · приседаний: ${num(P.squats)} · углей зажжено: ${Array.isArray(P.embers) ? P.embers.length : 0}${et ? ` из ${et}` : ''} · заработано очков: ${num(P.earned)}` : '');
        const list = P && Array.isArray(P.upgrades) ? P.upgrades : [];
        for (const u of list) {
          if (!u || typeof u.id !== 'string') continue;
          let c = cards.get(u.id);
          if (!c) { c = card(u); cards.set(u.id, c); }
          const key = `${u.level}|${u.cost}|${u.canBuy}|${u.now}|${u.next}`;
          if (key === c.key) continue;
          c.key = key;
          c.pips.replaceChildren(...Array.from({ length: Math.max(0, u.max | 0) }, (_, i) => el('span', { class: i < u.level ? 'ao-pip is-on' : 'ao-pip' })));
          setAttr(c.pips.parentNode, 'aria-label', `${u.name}: уровень ${u.level} из ${u.max}`);
          setText(c.now, u.now ? `Сейчас: ${u.now}` : '');
          setHidden(c.now, !u.now);
          setText(c.next, u.cost === null || u.cost === undefined ? 'Предел достигнут' : `${u.level ? 'Дальше' : 'Даст'}: ${u.next}`);
          setClass(c.node, 'is-max', u.cost === null || u.cost === undefined);
          setBtn(c.buy, {
            label: u.cost === null || u.cost === undefined ? 'Максимум' : `Улучшить · ${u.cost} ${plural(u.cost, 'очко', 'очка', 'очков')}`,
            disabled: !u.canBuy,
          });
        }
      },
    };
  })();

  /* ---------------------------------------------- [ASHEN_V2] ТРЕНИРОВКА */

  const training = (() => {
    const hid = `${uid}-train-h`;
    const h = heading('h2', hid, 'Тренировка клятвы', 'ao-h2');
    const host = el('div', { class: 'ao-slothost' });
    const status = statusLine();
    const enable = btn('Разрешить камеру', pressEnable, { variant: 'primary', iconName: 'camera' });
    const lead = el('p', { class: 'ao-lead' });
    // выбор упражнения
    const exName = `${uid}-train-ex`;
    const exSeg = el('div', { class: 'ao-seg' });
    const exInputs = [];
    for (const [value, label] of [['pushups', 'Отжимания'], ['squats', 'Приседания']]) {
      const input = el('input', { type: 'radio', name: exName, value, class: 'ao-seg__input' });
      exInputs.push(input);
      exSeg.append(el('label', { class: 'ao-seg__opt' }, input, el('span', { class: 'ao-seg__label', text: label })));
      listen(input, 'change', () => { if (input.checked) invoke('onExercise', value); });
    }
    const exField = el('fieldset', { class: 'ao-field ao-fieldset ao-train__ex' }, el('legend', { class: 'ao-field__legend', text: 'Упражнение' }), exSeg);
    const count = el('strong', { class: 'ao-train__count', text: '0' });
    const countLabel = el('span', { class: 'ao-train__label', text: 'отжиманий за подход' });
    const good = el('span', { class: 'ao-train__good', 'aria-hidden': 'true', hidden: true, text: 'Чисто! +1' });
    const depth = meter('Глубина отжимания', 'ao-train__depth');
    // карточка ошибки техники (приседания): держится ~3 с после подсказки
    const faultText = el('span', { class: 'ao-train__faulttext' });
    const fault = el('div', { class: 'ao-train__fault', 'data-tone': 'bad', hidden: true },
      el('strong', { class: 'ao-train__faultkey', text: 'Ошибка' }), faultText);
    const msg = el('p', { class: 'ao-train__msg', role: 'status' });
    const stepsPush = el('ol', { class: 'ao-train__steps' },
      el('li', { text: 'Поставьте ноутбук на пол перед головой (или сбоку), камерой на себя.' }),
      el('li', { text: 'Упор лёжа: в кадре должны быть плечи и обе кисти.' }),
      el('li', { text: 'Опускайтесь, пока плечи почти не дойдут до кистей, и выпрямляйте руки. Можно с колен.' }));
    const stepsSquat = el('ol', { class: 'ao-train__steps', hidden: true },
      el('li', { text: 'Поставьте ноутбук в 2–3 м от себя, камерой на себя.' }),
      el('li', { text: 'В кадре — всё тело, от плеч до стоп. Встаньте лицом к камере или под углом 45°.' }),
      el('li', { text: 'Ноги на ширине плеч. Садитесь, пока бёдра не станут параллельны полу, и выпрямляйтесь полностью. Очко дают только чистые повторы.' }));
    const simNote = el('p', {
      class: 'ao-note ao-train__sim', hidden: true,
      text: 'DEBUG, без камеры: S или ↓ (держать) — присесть, Shift — быстро, V — колени внутрь, G — колени за носки, T — наклон, H — пятки, B — не выпрямляться.',
    });
    // итог подхода (приседания)
    const sumLine = el('p', { class: 'ao-train__sumline' });
    const sumTip = el('p', { class: 'ao-train__sumtip' });
    const summary = el('div', { class: 'ao-train__summary', hidden: true }, el('strong', { class: 'ao-train__sumhead', text: 'Итог подхода' }), sumLine, sumTip);
    const total = el('p', { class: 'ao-note' });
    const oathB = btn('Улучшения', () => invoke('onOath', { from: 'training' }));
    const done = btn('Готово', () => invoke('onBack'), { variant: 'primary' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--train ao-frame' },
      el('div', { class: 'ao-head' }, h, lead),
      el(
        'div',
        { class: 'ao-cols' },
        el('div', { class: 'ao-col ao-col--media' }, host, status.node, enable.node),
        el(
          'div',
          { class: 'ao-col' },
          exField,
          el('div', { class: 'ao-train__score' }, count, countLabel, good),
          depth.node,
          fault,
          msg,
          stepsPush,
          stepsSquat,
          simNote,
          summary,
          total,
        ),
      ),
      el('div', { class: 'ao-actions' }, done.node, oathB.node),
    );
    const POSTURE = ['valgus', 'knees_forward', 'lean', 'heels'];
    const VIEW_NAME = { front: 'вид спереди', side: 'вид сбоку', diag: 'вид под углом' };
    let lastKey = '';
    let lastMode = '';
    return {
      section: screenSection('training', panel, hid),
      heading: h,
      host,
      focus: () => done.node,
      update(ctx) {
        const T = ctx.vm.training && typeof ctx.vm.training === 'object' ? ctx.vm.training : {};
        const squat = T.exercise === 'squats';
        const st = ctx.tr.status;
        paintStatus(status, describeTracking(ctx.tr, cfg), '');
        setBtn(enable, { hidden: squat && T.debugSim ? true : !(st === 'idle' || st === 'error'), disabled: CAMERA_STARTING.includes(st) });
        setAttr(host, 'data-tone', describeTracking(ctx.tr, cfg).tone);
        const mode = squat ? 'squats' : 'pushups';
        if (mode !== lastMode) {
          lastMode = mode;
          lastKey = '';
          for (const i of exInputs) { const on = i.value === mode; if (i.checked !== on) i.checked = on; }
          setText(lead, squat
            ? 'Каждое чистое приседание — очко клятвы. Игра следит за техникой и подсказывает, что исправить. Видео обрабатывается только в браузере и не записывается.'
            : 'Каждое настоящее отжимание — очко клятвы. Видео обрабатывается только в браузере и не записывается.');
          setAttr(depth.node, 'aria-label', squat ? 'Глубина приседа' : 'Глубина отжимания');
          setHidden(stepsPush, squat);
          setHidden(stepsSquat, !squat);
        }
        const reps = Math.max(0, num(T.reps) | 0);
        setText(count, String(reps));
        setText(countLabel, squat
          ? `${plural(reps, 'чистое приседание', 'чистых приседания', 'чистых приседаний')} за подход`
          : `${plural(reps, 'отжимание', 'отжимания', 'отжиманий')} за подход`);
        paintMeter(depth, num(T.depth));
        const repAge = isNum(T.sinceRepMs) ? T.sinceRepMs : Infinity;
        setClass(count, 'is-flash', repAge < 600 && T.lastOk !== false);
        const P = ctx.vm.progress;
        if (!squat) {
          setHidden(good, true);
          setHidden(fault, true);
          setHidden(simNote, true);
          setHidden(summary, true);
          const text = typeof T.message === 'string' ? T.message : '';
          if (text !== lastKey) { lastKey = text; setText(msg, /^\d+$/.test(text) ? 'Засчитано!' : text); }
          setText(total, P && isNum(P.points) ? `Очков клятвы: ${P.points} · отжиманий всего: ${num(P.pushups)}` : '');
          return;
        }
        // --- приседания: карточка ошибки ~3 с (про кадр — пока тело не в кадре), «Чисто! +1», итог
        const H = T.lastHint && typeof T.lastHint === 'object' && typeof T.lastHint.text === 'string' ? T.lastHint : null;
        const hintAge = isNum(T.sinceHintMs) ? T.sinceHintMs : Infinity;
        const framing = !!H && H.code === 'frame' && T.state === 'noPose';
        const showFault = !!H && (framing || (hintAge < 3000 && hintAge <= repAge));
        setHidden(fault, !showFault);
        if (showFault) {
          setText(faultText, H.text);
          setAttr(fault, 'data-tone', POSTURE.includes(H.code) ? 'bad' : 'warn');
          setAttr(fault, 'data-code', H.code);
          const key = `${H.code}|${H.tMs}`;
          if (key !== lastKey) { lastKey = key; announce(`Ошибка: ${H.text}`); }
        }
        setHidden(good, !(repAge < 1200 && T.lastOk === true && !showFault));
        const knee = isNum(T.knee) ? `угол колена ${Math.round(T.knee)}°` : '';
        const live = T.state !== 'noPose' && T.state !== 'setup';
        setText(msg, live ? [knee, VIEW_NAME[T.view] || ''].filter(Boolean).join(' · ') : (typeof T.message === 'string' ? T.message : ''));
        setHidden(simNote, !T.debugSim);
        const att = Math.max(0, num(T.attempts) | 0);
        setHidden(summary, att === 0);
        // подход идёт (есть попытки или карточка ошибки) — инструкция по установке уже не нужна, место — карточкам
        setHidden(stepsSquat, att > 0 || showFault);
        if (att > 0) {
          const score = isNum(T.formScore) ? Math.round(T.formScore * 100) : 0;
          setText(sumLine, `Чистых: ${reps} из ${att} · техника ${score}%`);
          const tf = T.topFault && typeof T.topFault.text === 'string' ? T.topFault : null;
          setText(sumTip, tf ? `Чаще всего (${tf.count}×): ${tf.text}` : 'Ошибок нет — так держать!');
          setClass(summary, 'is-clean', !tf);
        }
        setText(total, P && isNum(P.points) ? `Очков клятвы: ${P.points} · приседаний всего: ${num(P.squats)}` : '');
      },
    };
  })();

  /* --------------------------------------------------------------- ERROR */

  const errorScr = (() => {
    const hid = `${uid}-err-h`;
    const h = heading('h2', hid, 'Что-то пошло не так', 'ao-h2');
    const reason = el('p', { class: 'ao-lead' });
    const steps = el('ul', { class: 'ao-steps' });
    const raw = el('code', { class: 'ao-errbox__raw' });
    const details = el('details', { class: 'ao-errbox__details' }, el('summary', { text: 'Техническая подробность' }), raw);
    const retry = btn(
      'Повторить',
      () => {
        if (state.errorInfo.retry === 'camera') pressEnable();
        else invoke('onRestart');
      },
      { variant: 'primary', iconName: null },
    );
    const exit = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--error ao-frame' },
      el('div', { class: 'ao-error__head' }, icon('warn', 'ao-error__icon'), h),
      reason,
      steps,
      details,
      el('div', { class: 'ao-actions' }, retry.node, el('span', { class: 'ao-spacer' }), exit.node),
    );
    return {
      section: screenSection('error', panel, hid),
      heading: h,
      focus: () => retry.node,
      update(ctx) {
        const key = ctx.errorText;
        if (key !== state.errorKey) {
          state.errorKey = key;
          const info = explainError(key);
          state.errorInfo = info;
          setText(h, info.title);
          reason.textContent = info.reason;
          steps.replaceChildren(...info.steps.map((s) => el('li', { text: s })));
          const line = shortRaw(key);
          raw.textContent = line;
          details.hidden = !line;
        }
        setBtn(retry, { disabled: state.errorInfo.retry === 'camera' && isPending('enable', ctx.now) });
      },
    };
  })();

  /* ----------------------------------------------------------------- HUD */

  const hud = (() => {
    const bossBar = bar('boss', 'Здоровье Регента');
    const stage = el('span', { class: 'ao-boss__stage', hidden: true, text: 'вторая стадия' });
    const teleText = el('span', { class: 'ao-tele__text' });
    const teleFill = el('span', { class: 'ao-tele__fill' });
    const tele = el('div', { class: 'ao-tele', hidden: true, role: 'status' }, teleText, el('span', { class: 'ao-tele__time', 'aria-hidden': 'true' }, teleFill));
    const boss = el('div', { class: 'ao-boss' }, el('div', { class: 'ao-boss__head' }, el('span', { class: 'ao-boss__name', text: BOSS_NAME }), stage), bossBar.node, tele);

    const hp = bar('hp', 'Здоровье героя');
    const hpText = el('span', { class: 'ao-row__v' });
    const en = bar('energy', 'Энергия');
    const enText = el('span', { class: 'ao-row__v' });
    const tile = (key, name, hint, iconName) => {
      const cd = el('span', { class: 'ao-ab__cd', 'aria-hidden': 'true' });
      const time = el('span', { class: 'ao-ab__time', 'aria-hidden': 'true' });
      const node = el(
        'div',
        { class: `ao-ab ao-ab--${key}`, 'data-state': 'ready', role: 'img', 'aria-label': `${name}, ${hint}` },
        icon(iconName, 'ao-ab__icon'),
        el('span', { class: 'ao-ab__name', text: name }),
        el('span', { class: 'ao-ab__hint', text: hint }),
        cd,
        time,
      );
      return { node, cd, time, name, hint };
    };
    const STATE_WORD = { ready: 'готово', active: 'активно', cooldown: 'перезарядка', low: 'мало энергии', off: 'недоступно' };
    const paintTile = (t, st, cdFrac, timeText) => {
      setAttr(t.node, 'data-state', st);
      setStyle(t.node, '--ao-cd', cdFrac.toFixed(3));
      setText(t.time, timeText);
      setAttr(t.node, 'aria-label', `${t.name}, ${t.hint}: ${STATE_WORD[st]}`);
    };
    const bolt = tile('bolt', 'Снаряд', '«OK» правой', 'bolt');
    const shield = tile('shield', 'Щит', 'толчок ладонью к камере', 'shield');
    const burst = tile('burst', 'Выброс', 'правый кулак → ладонь', 'burst');
    const dash = tile('dash', 'Рывок', 'дёрг левой рукой', 'dash');
    const row = (label, valueNode, b) =>
      el('div', { class: 'ao-row' }, el('div', { class: 'ao-row__head' }, el('span', { class: 'ao-row__k', text: label }), valueNode), b.node);
    const hero = el(
      'div',
      { class: 'ao-hero' },
      row('Здоровье', hpText, hp),
      row('Энергия', enText, en),
      el('div', { class: 'ao-abilities' }, bolt.node, shield.node, burst.node, dash.node),
    );
    const dockHost = el('div', { class: 'ao-cvdock__slot' });
    const dockStatus = statusLine('ao-status--compact');
    const dock = el('div', { class: 'ao-cvdock' }, dockHost, dockStatus.node);
    const pauseBtn = btn('Пауза', () => invoke('onPause', { reason: 'user' }), { variant: 'secondary', iconName: 'pause' });
    pauseBtn.node.classList.add('ao-pausebtn');
    pauseBtn.node.setAttribute('aria-keyshortcuts', 'Escape');
    const node = el('div', { class: 'ao-hud', hidden: true }, boss, hero, dock, pauseBtn.node);

    return {
      node,
      dockHost,
      update(ctx) {
        const s = ctx.snap;
        const p = s && s.player && typeof s.player === 'object' ? s.player : null;
        const b = s && s.boss && typeof s.boss === 'object' ? s.boss : null;
        const cd = (s && s.cooldowns) || {};
        const playing = ctx.screen === 'playing';
        setClass(node, 'is-dimmed', ctx.screen === 'paused');
        setHidden(pauseBtn.node, !playing);
        setHidden(dock, !playing);

        paintBar(bossBar, b ? num(b.hp) / Math.max(1e-6, num(b.maxHp, 1)) : 1);
        const stage2 = !!b && b.stage === 2;
        setHidden(stage, !stage2);
        setClass(boss, 'is-stage2', stage2);
        setClass(boss, 'is-dead', !!b && b.action === 'dead');
        if (b) {
          const stg = stage2 ? 2 : 1;
          if (stg === 2 && state.stage !== 2 && playing) showBanner('Нимб трескается. Вторая стадия.');
          state.stage = stg;
        }

        let energy = 0;
        if (p) {
          const maxHp = Math.max(1e-6, num(p.maxHp, 1));
          const hpv = clamp(num(p.hp), 0, maxHp);
          paintBar(hp, hpv / maxHp);
          setText(hpText, `${Math.ceil(hpv)} / ${Math.round(maxHp)}`);
          const maxEn = Math.max(1e-6, num(p.maxEnergy, 1));
          energy = clamp(num(p.energy), 0, maxEn);
          paintBar(en, energy / maxEn);
          setText(enText, `${Math.floor(energy)} / ${Math.round(maxEn)}`);
          setClass(hero, 'is-low', hpv / maxHp < 0.25);
        } else {
          paintBar(hp, 0);
          paintBar(en, 0);
          setText(hpText, '—');
          setText(enText, '—');
          setClass(hero, 'is-low', false);
        }

        const alive = !!p && p.action !== 'dead' && (!s.status || s.status === 'playing');
        const inp = ctx.input;
        const inputLive = !!inp && inp.valid;
        const costs = cfg.abilityCosts;
        const low = (k) => isNum(costs[k]) && energy < costs[k];
        paintTile(bolt, !alive ? 'off' : p.action === 'cast' || (inputLive && inp.attack) ? 'active' : low('bolt') ? 'low' : 'ready', 0, '');
        paintTile(shield, !alive ? 'off' : p.shielding === true ? 'active' : low('shield') ? 'low' : 'ready', 0, '');
        const bRem = Math.max(0, num(cd.burstRemaining));
        const bTot = num(cd.burstTotal);
        const bCool = bRem > 0.05;
        paintTile(burst, !alive ? 'off' : bCool ? 'cooldown' : low('burst') ? 'low' : 'ready', bCool && bTot > 0 ? clamp(bRem / bTot, 0, 1) : 0, bCool ? fmtSeconds(bRem) : '');
        const dRem = Math.max(0, num(cd.dashRemaining));
        const dTot = num(cd.dashTotal);
        const dCool = dRem > 0.05;
        paintTile(dash, !alive ? 'off' : p.action === 'dash' ? 'active' : dCool ? 'cooldown' : 'ready', dCool && dTot > 0 ? clamp(dRem / dTot, 0, 1) : 0, dCool ? fmtSeconds(dRem) : '');

        let tg = null;
        if (playing && s && Array.isArray(s.telegraphs)) {
          const n = Math.min(s.telegraphs.length, 16);
          for (let i = 0; i < n; i += 1) {
            const t = s.telegraphs[i];
            if (!t || !(num(t.remaining) > 0)) continue;
            if (!tg || t.remaining < tg.remaining) tg = t;
          }
        }
        setHidden(tele, !tg);
        if (tg) {
          setText(teleText, telegraphText(tg));
          setAttr(tele, 'data-kind', tg.kind);
          const f = num(tg.duration) > 0 ? clamp(tg.remaining / tg.duration, 0, 1) : 0;
          setStyle(teleFill, 'transform', `scaleX(${(Math.round(f * 100) / 100).toFixed(2)})`);
        }

        if (playing) {
          const info = ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg);
          paintStatus(dockStatus, info, '');
          setAttr(dockHost, 'data-tone', info.tone);
        }
      },
    };
  })();

  function showBanner(text) {
    setText(banner, text);
    setHidden(banner, false);
    announce(text);
    cancel(state.bannerTimer);
    state.bannerTimer = later(() => setHidden(banner, true), BANNER_MS);
  }

  /* ----------------------------------------------------------- assembly */

  const screens = { menu, camera, calibration: calib, tutorial, paused, victory, defeat, error: errorScr, oath, training };
  const slotHosts = { camera: camera.host, calibration: calib.host, tutorial: tutorial.host, paused: paused.host, playing: hud.dockHost, training: training.host };

  ui.append(backdrop, hud.node, banner);
  for (const scr of Object.values(screens)) ui.append(scr.section);
  ui.append(debugBadge, park, live, liveAlert);
  root.appendChild(ui);

  function moveSlot(screen) {
    const host = slotHosts[screen] || park;
    if (slot.parentNode !== host) host.appendChild(slot);
  }

  function enterScreen(screen) {
    const prev = state.screen;
    state.screen = screen;
    state.pending = {};
    setAttr(ui, 'data-screen', screen);
    for (const [name, scr] of Object.entries(screens)) setHidden(scr.section, name !== screen);
    setHidden(hud.node, !(screen === 'playing' || screen === 'paused'));
    if (screen !== 'playing') {
      cancel(state.bannerTimer);
      setHidden(banner, true);
    }
    if (screen === 'tutorial' && prev !== 'tutorial') tutorial.reset();
    if (screen === 'paused' && prev !== 'paused') {
      state.pause.sawLost = false;
      state.pause.variant = null;
    }
    if (screen === 'calibration' && prev !== 'calibration') state.calib.error = '';
    moveSlot(screen);
    state.focusPending = screen !== 'playing';
    if (screen !== 'paused') announce(SCREEN_ANNOUNCE[screen] || '');
  }

  function focusScreen(screen) {
    const scr = screens[screen];
    if (!scr) return;
    const active = doc.activeElement;
    const free = !active || active === doc.body || active === doc.documentElement || ui.contains(active);
    if (!free) return;
    const target = scr.focus && scr.focus();
    const ok = target && !target.hidden && target.getAttribute('aria-disabled') !== 'true';
    const node = ok ? target : scr.heading;
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  function syncSettings(s) {
    const key = `${s.quality}|${s.volume}|${s.sensitivity}|${s.reducedMotion}|${s.moveMode}|${s.hero}|${s.startZone}`; // [FOREST] + startZone
    state.settings = s;
    if (key === state.settingsKey) return;
    state.settingsKey = key;
    for (const c of controls) c.sync(s, false);
  }

  function trackCalibration(tr) {
    const c = state.calib;
    if (tr.status === 'calibrating') {
      c.observed = true;
      c.latched = false;
      c.resolved = false;
    } else if (tr.status === 'ready' && c.observed) {
      c.latched = true;
      c.observed = false;
    } else if (tr.status === 'idle' || tr.status === 'error' || CAMERA_STARTING.includes(tr.status)) {
      c.observed = false;
      c.latched = false;
      c.resolved = false;
    }
  }
  function resolveCalibrated(tr, input) {
    if (tr.calibrated !== null) return tr.calibrated;
    if (input && input.source === 'cv' && input.calibrated !== null) return input.calibrated;
    if (state.calib.latched || state.calib.resolved) return true;
    return null; // неизвестно
  }

  const UPDATERS = {
    menu: (ctx) => menu.update(ctx),
    camera: (ctx) => camera.update(ctx),
    calibration: (ctx) => calib.update(ctx),
    tutorial: (ctx) => tutorial.update(ctx),
    playing: (ctx) => hud.update(ctx),
    paused: (ctx) => {
      hud.update(ctx);
      paused.update(ctx);
    },
    victory: (ctx) => victory.update(ctx),
    defeat: (ctx) => defeat.update(ctx),
    error: (ctx) => errorScr.update(ctx),
    oath: (ctx) => oath.update(ctx),
    training: (ctx) => training.update(ctx),
  };

  function update(viewModel) {
    if (disposed) return;
    const vm = viewModel && typeof viewModel === 'object' ? viewModel : {};
    const now = win.performance.now();
    const screen = SCREENS.includes(vm.screen) ? vm.screen : 'menu';
    const input = normInput(vm.input);
    const tr = normTracking(vm.tracking);
    const debug = vm.debug === true || (!!input && input.source === 'debug');
    state.status = tr.status;
    state.debug = debug;
    trackCalibration(tr);
    const ctx = {
      vm,
      now,
      screen,
      debug,
      input,
      tr,
      calibrated: resolveCalibrated(tr, input),
      snap: vm.snapshot && typeof vm.snapshot === 'object' ? vm.snapshot : null,
      coach: vm.coach && typeof vm.coach === 'object' ? vm.coach : null,
      settings: normSettings(vm.settings),
      errorText:
        (typeof vm.error === 'string' && vm.error) ||
        (vm.error && typeof vm.error === 'object' && (vm.error.name || vm.error.message) ? `${vm.error.name || ''}: ${vm.error.message || ''}` : '') ||
        (tr.status === 'error' ? tr.message : ''),
    };
    if (screen !== state.screen) enterScreen(screen);
    setHidden(debugBadge, !debug);
    setClass(ui, 'ao-reduced-motion', ctx.settings.reducedMotion);
    setClass(doc.documentElement, 'ao-bdo', !(vm.settings && vm.settings.bdoUi === false)); // [BDO] стиль Black Desert (настройка bdoUi)
    syncSettings(ctx.settings);
    UPDATERS[screen](ctx);
    if (state.focusPending) {
      state.focusPending = false;
      focusScreen(screen);
    }
  }

  /* ------------------------------------------------------------ keyboard */

  listen(win, 'keydown', (e) => {
    if (disposed || !cfg.keyboardPause) return;
    if (e.key !== 'Escape' || e.repeat) return;
    // В DEBUG Escape обрабатывает адаптер сборщика; UI не дублирует паузу.
    if (state.screen === 'playing' && !state.debug) {
      e.preventDefault();
      invoke('onPause', { reason: 'user', via: 'keyboard' });
    }
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of cleanups.splice(0)) {
      try {
        off();
      } catch (err) {
        console.error('[ui] ошибка при снятии обработчика', err);
      }
    }
    for (const id of timers) win.clearTimeout(id);
    timers.clear();
    ui.remove();
  }

  return { update, dispose, cameraSlot: slot, apiVersion: API_VERSION };
}
