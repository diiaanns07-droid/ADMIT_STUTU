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
 *   [ТВИСТ «ОШИБКА»] onTechnique({from})  onTechniqueGesture(id)  onTechniqueDemo(on); viewModel.technique — вид тренажёра
 *     (modules/techniqueTrainer.js), viewModel.coach — итог боя { accuracy, groups[], top3[], compare }
 *   viewModel.progress = { points, earned, pushups, squats, embers[], emberTotal, upgrades[{id,name,level,max,cost,canBuy,now,next}] }
 *   viewModel.training = { exercise, reps, total, state, message, depth, lastOk, sinceRepMs,
 *     приседания: attempts, knee, view, lastHint{code,text,tMs}, sinceHintMs, faults{}, formScore, topFault{code,text,count}, debugSim }
 */

import { createTutorialTrainer, TRAINER_STEPS } from '../core/tutorialTrainer.js';
import { COACH_GROUPS, hintPictogram } from '../core/gestureCoach.js'; // [ТВИСТ «ОШИБКА»] итоги: жесты и пиктограммы
import { createTechniqueScreen } from './techniqueTrainer.js';            // [ТВИСТ «ОШИБКА»] «Тренажёр техники»

export const API_VERSION = 'ASHEN_V1';

const SCREENS = ['menu', 'camera', 'calibration', 'tutorial', 'playing', 'paused', 'victory', 'defeat', 'error', 'oath', 'training', 'technique'];
const TRACK_STATES = ['idle', 'loading', 'permission', 'calibrating', 'ready', 'lost', 'error'];
const CAMERA_RUNNING = ['ready', 'lost', 'calibrating'];
const CAMERA_STARTING = ['permission', 'loading'];
const BOSS_NAME = 'Регент Нимба';
// [PERF] 'auto' — уровень и разрешение подбирает автоподстройка под железо (core/perfTuner.js)
const QUALITY_OPTIONS = [['auto', 'Авто'], ['low', 'Низкое'], ['medium', 'Среднее'], ['high', 'Высокое']];
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
  technique: 'Тренажёр техники',
};

const DEBUG_KEYS_TEXT =
  'Клавиши отладки: W — вперёд, A и D — поворот (в «Джойстике» — шаг вбок), S — стоп (в «Джойстике» — назад), ' +
  'пробел — рывок по ходу, Q и E — рывок вбок, J — огонь, U — искра, I — рассечение, ' +
  'K — щит, F — парирование, L — выброс, O или P — сфера или призма, ' +
  'X или G (держать и отпустить) — «Врата бури» или «Столп небес»; Esc — пауза. Это клавиатура, а не трекинг.';   // [W3-MAGIC] X/G

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
  // [ONBOARD] руки вниз — для экрана камеры
  armsdown:
    `<svg ${SVG24}><circle cx="12" cy="5.6" r="2.4"/><path d="M7.5 20.5v-6.8c0-2 2-3.3 4.5-3.3s4.5 1.3 4.5 3.3v6.8"/>` +
    '<path d="M3.5 11v7M2 16.6l1.5 1.5L5 16.6M20.5 11v7M19 16.6l1.5 1.5 1.5-1.5"/></svg>',
  book: `<svg ${SVG24}><path d="M4 5.5C6.8 4.6 9.4 4.9 12 6.6c2.6-1.7 5.2-2 8-1.1v13c-2.8-.9-5.4-.6-8 1.1-2.6-1.7-5.2-2-8-1.1z"/><path d="M12 6.6v13"/></svg>`,
};

// [ONBOARD] рамка-силуэт поверх превью камеры (4:3): голова — кольцо прогресса калибровки, плечи, кисти
const ONB_FRAME_SVG =
  '<svg class="ao-onb__svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
  '<path class="ao-onb__body" d="M58 300 C62 236 92 204 150 196 C170 193 181 186 184 168 L216 168 C219 186 230 193 250 196 C308 204 338 236 342 300"/>' +
  '<circle class="ao-onb__face" cx="200" cy="112" r="46"/>' +
  '<circle class="ao-onb__ring" cx="200" cy="112" r="56" pathLength="100" transform="rotate(-90 200 112)"/>' +
  '<path class="ao-onb__tick" d="M181 113l13 13 26-28"/>' +
  '<circle class="ao-onb__hand" data-hand="left" cx="110" cy="268" r="17"/>' +
  '<circle class="ao-onb__hand" data-hand="right" cx="290" cy="268" r="17"/>' +
  '</svg>';

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
    effect: 'Руку на колени — стоп. У Регента рука вбок — обход по кругу. Со щитом стоим: ладонь назад — идём.',
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

/* [НОВИЧОК] В «Новичке» карточки обучения — только про базовые жесты; лук и магия рукой скрыты.
   Поле novice — тексты для «Новичка», novice.auto — для «Новичка» с «Автоходом» (герой идёт сам). */
{
  const T = Object.fromEntries(TUTORIAL.map((it) => [it.key, it]));
  T.strafe.novice = { auto: {
    title: 'Герой идёт сам',
    gesture: '«Автоход» ведёт героя к Регенту и вокруг него. Вам — только сражаться.',
    effect: 'Левая рука свободна для щита и рывка. Вести героя рукой — выключите «Автоход» в меню.',
  } };
  T.hands.novice = {
    title: 'Огонь и щит',
    gesture: 'Правая: «OK» — кольцо из большого и указательного — снаряды. Левая: толкните раскрытую ладонь к камере — щит.',
    effect: 'Щит держится, пока ладонь впереди. Уберите ладонь назад — щит опущен.',
  };
  T.both.novice = {
    title: 'Кулак — выброс',
    gesture: 'Сожмите правый кулак, подержите секунду и резко раскройте.',
    effect: 'Взрыв энергии по Регенту. Чем дольше держали кулак, тем сильнее.',
  };
  T.conjure.novice = {
    title: 'Сфера двумя руками',
    gesture: 'Ладони друг к другу, будто держите мяч. Потом толкните обе ладони к камере.',
    effect: 'Сфера летит в Регента. Чем дольше лепили, тем сильнее.',
  };
  T.bow.masterOnly = true;
  T.handMagic.masterOnly = true;
}
/* ------------------------------------------------- [ТРЕНАЖЁР] пиктограммы
 * «Научись за 60 секунд» (логика — core/tutorialTrainer.js). Кисть нарисована так, как игрок видит
 * себя в зеркальном превью: ладонь к камере, у ЛЕВОЙ руки большой палец справа. Правая — отражение.
 * Силуэт в два прохода: сначала все контуры (широкая тёмная линия), затем «кожа» поверх — без швов. */

const HAND_FINGERS = [
  ['M80 106 L70 62', 13], ['M94 101 L90 48', 14], ['M108 100 L110 44', 14], ['M122 102 L130 54', 14],
];
const HAND_THUMB = ['M126 146 L146 126 L158 104', 15];
const HAND_PALM = 'M70 106 Q70 96 80 96 H124 Q134 96 134 106 L135 140 Q135 164 110 165 H92 Q68 164 68 140 Z';
const HAND_SLEEVE = '<path class="hd-sleeve" d="M80 214 L84 160 H120 L124 214 Z"/><path class="hd-cuff" d="M83 170 H121"/>';
function handPass(strokes, palm, cls) {
  let s = strokes.map(([d, w]) => `<path class="${cls}" d="${d}" stroke-width="${cls === 'hd-o' ? w + 6 : w}"/>`).join('');
  if (palm) s += `<path class="${cls} hd-palm" d="${palm}"/>`;
  return s;
}
function handShape(strokes, palm, extra = '') {
  return HAND_SLEEVE + handPass(strokes, palm, 'hd-o') + handPass(strokes, palm, 'hd-s') + extra;
}
const HAND_OPEN = handShape([...HAND_FINGERS, HAND_THUMB], HAND_PALM,
  '<path class="hd-crease" d="M84 136 Q100 144 122 132"/>');
// «OK»: большой и указательный сомкнуты в кольцо, три пальца вверх
const HAND_OK = handShape(
  [HAND_FINGERS[0], HAND_FINGERS[1], HAND_FINGERS[2], ['M122 102 L134 90', 14], ['M126 146 L144 120', 15]],
  HAND_PALM,
  '<circle class="hd-o" cx="146" cy="104" r="14" stroke-width="17" fill="none"/>' +
    '<circle class="hd-s" cx="146" cy="104" r="14" stroke-width="11" fill="none"/>' +
    '<circle class="hd-ring" cx="146" cy="104" r="7.5"/>',
);
// кулак: костяшки сверху, большой палец поперёк
const HAND_FIST =
  HAND_SLEEVE +
  '<path class="hd-o hd-palm" d="M70 112 Q70 92 88 92 H118 Q136 92 136 112 L136 142 Q136 164 112 165 H92 Q70 164 70 142 Z"/>' +
  '<path class="hd-s hd-palm" d="M70 112 Q70 92 88 92 H118 Q136 92 136 112 L136 142 Q136 164 112 165 H92 Q70 164 70 142 Z"/>' +
  '<path class="hd-crease" d="M86 94 V112 M102 92 V112 M118 94 V112 M76 116 H132"/>' +
  '<path class="hd-o" d="M136 142 L100 130" stroke-width="20"/><path class="hd-s" d="M136 142 L100 130" stroke-width="14"/>';
const handG = (inner, side, cls = '') =>
  `<g class="hd ${cls}"${side === 'right' ? ' transform="translate(208 0) scale(-1 1)"' : ''}>${inner}</g>`;
const picWrap = (id, inner) =>
  `<svg class="ao-pic ao-pic--${id}" viewBox="0 0 208 220" fill="none" stroke-linecap="round" stroke-linejoin="round" ` +
  `aria-hidden="true" focusable="false">${inner}</svg>`;

// Крупная анимированная пиктограмма шага (CSS-анимации .pic-* в ui.css; при «меньше движения» — ключевая поза).
const TRAINER_PICS = {
  // 1. левая ладонь поднимается к линии груди и держится
  walk: picWrap('walk',
    '<g class="pic-body"><circle cx="104" cy="34" r="19"/><path d="M28 132 Q34 74 104 70 Q174 74 180 132"/></g>' +
    '<path class="pic-line" d="M8 104 H200"/><text class="pic-lab" x="200" y="96" text-anchor="end">грудь</text>' +
    '<g class="pic-rise"><g transform="translate(-4 10) scale(0.72)">' + handG(HAND_OPEN, 'left') + '</g></g>' +
    '<path class="pic-arrow pic-arrow--up" d="M158 196 V146 M147 158 L158 146 L169 158"/>'),
  // 2. левая ладонь резко толкается к камере (растёт), волны толчка
  shield: picWrap('shield',
    '<g class="pic-waves"><path d="M40 52 Q20 104 40 156"/><path d="M168 52 Q188 104 168 156"/>' +
    '<path d="M24 36 Q-2 104 24 172"/><path d="M184 36 Q210 104 184 172"/></g>' +
    '<g class="pic-push"><g transform="translate(-3 -2) scale(0.95)">' + handG(HAND_OPEN, 'left') + '</g></g>' +
    '<text class="pic-lab" x="104" y="214" text-anchor="middle">толчок к камере</text>'),
  // 3. правая: ладонь → «OK» (кольцо), из кольца летит снаряд
  shot: picWrap('shot',
    '<g transform="translate(14 0) scale(0.95)"><g class="pic-a">' + handG(HAND_OPEN, 'right') + '</g>' +
    '<g class="pic-b">' + handG(HAND_OK, 'right') + '</g></g>' +
    '<g class="pic-bolt"><circle cx="72" cy="98" r="9"/><path d="M80 92 L102 78 M81 101 L106 94"/></g>'),
  // 4. правый кулак: кольцо заряда заполняется → резко раскрыть, лучи выброса
  burst: picWrap('burst',
    '<circle class="pic-charge-bg" cx="104" cy="124" r="84"/><circle class="pic-charge" cx="104" cy="124" r="84" pathLength="100"/>' +
    '<g transform="translate(8 6) scale(0.92)"><g class="pic-a">' + handG(HAND_FIST, 'right') + '</g>' +
    '<g class="pic-b">' + handG(HAND_OPEN, 'right') + '</g></g>' +
    '<g class="pic-rays"><path d="M100 28 V8 M158 46 L172 30 M42 46 L28 30 M178 104 H200 M22 104 H2"/></g>'),
};
// [W3-MAGIC] «Книга заклинаний»: магия двух ладоней — «ладони вместе → растянуть» (и в «Новичке»)
const PALMS_TOGETHER = '<g transform="translate(10 40) scale(.6)">' + handG(HAND_OPEN, 'left') + '</g>' +
  '<g transform="translate(198 40) scale(-.6 .6)">' + handG(HAND_OPEN, 'left') + '</g>';
const STRETCH_CARDS = [
  { id: 'gate', title: 'Врата бури', effect: 'волна огня и молний по земле к Регенту и щит на 3,5 с',
    tip: 'Сомкни ладони, подержи (чем дольше, тем сильнее) и резко разведи в стороны.', keyText: 'X — держать и отпустить',
    pic: picWrap('mini', PALMS_TOGETHER + '<g class="pic-arrows"><path d="M44 120 H8 M20 108 L8 120 L20 132 M164 120 H200 M188 108 L200 120 L188 132"/></g>') },
  { id: 'pillar', title: 'Столп небес', effect: 'столп света сверху: оглушает Регента на 1,2 с',
    tip: 'Сомкни ладони, подержи и резко растяни: одну руку вверх, другую вниз.', keyText: 'G — держать и отпустить',
    pic: picWrap('mini', PALMS_TOGETHER + '<g class="pic-arrows"><path d="M104 36 V6 M92 18 L104 6 L116 18 M104 178 V214 M92 202 L104 214 L116 202"/></g>') },
];
// Маленькие (статичные) — для полосы шагов, итога и «Книги заклинаний».
const TRAINER_MINI = {
  walk: picWrap('mini', '<path class="pic-line" d="M8 104 H200"/><g transform="translate(14 22) scale(0.82)">' + handG(HAND_OPEN, 'left') + '</g>'),
  shield: picWrap('mini', '<g class="pic-waves pic-waves--on"><path d="M40 52 Q20 104 40 156"/><path d="M168 52 Q188 104 168 156"/></g><g transform="translate(14 0) scale(0.86)">' + handG(HAND_OPEN, 'left') + '</g>'),
  shot: picWrap('mini', '<g transform="translate(14 0) scale(0.86)">' + handG(HAND_OK, 'right') + '</g>'),
  burst: picWrap('mini', '<g transform="translate(14 0) scale(0.86)">' + handG(HAND_FIST, 'right') + '</g>'),
};

// Манекен: герой слева, соломенное чучело справа. Реакции — классы .is-live / .is-ok и data-step (ui.css).
const TRAINER_DUMMY_SVG =
  '<svg class="ao-mq" viewBox="-110 0 740 112" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path class="mq-ground" d="M-110 98 H630"/>' +
  '<path class="mq-ticks" d="M-122 106 h18 M-58 106 h18 M6 106 h18 M70 106 h18 M134 106 h18 M198 106 h18 M262 106 h18 M326 106 h18 M390 106 h18 M454 106 h18 M518 106 h18 M582 106 h18 M646 106 h18"/>' +
  // чучело
  '<g class="mq-dummy"><path class="mq-post" d="M420 98 V40"/><path class="mq-post" d="M394 56 H446"/>' +
  '<ellipse class="mq-straw" cx="420" cy="62" rx="15" ry="22"/><circle class="mq-straw" cx="420" cy="30" r="11"/>' +
  '<circle class="mq-target" cx="420" cy="62" r="7"/><circle class="mq-target" cx="420" cy="62" r="2.2"/></g>' +
  '<text class="mq-dmg" x="462" y="30" text-anchor="middle">−12</text>' +
  '<text class="mq-dmg mq-dmg--big" x="466" y="30" text-anchor="middle">−40</text>' +
  // камешек от чучела — в щит
  '<circle class="mq-pebble" cx="400" cy="58" r="5"/>' +
  // герой
  '<g class="mq-hero">' +
  '<path class="mq-leg mq-leg--a" d="M114 98 L120 74"/><path class="mq-leg mq-leg--b" d="M128 98 L122 74"/>' +
  '<path class="mq-body" d="M106 76 L136 76 L131 44 L111 44 Z"/><circle class="mq-head" cx="121" cy="32" r="9.5"/>' +
  '<path class="mq-arm" d="M130 50 L150 60"/><circle class="mq-palm" cx="152" cy="60" r="4"/>' +
  '<circle class="mq-charge" cx="152" cy="60" r="16"/>' +
  '<path class="mq-shield" d="M162 26 Q186 60 162 94"/>' +
  '<text class="mq-block" x="178" y="20" text-anchor="middle">Блок!</text>' +
  '</g>' +
  '<circle class="mq-bolt" cx="156" cy="60" r="7"/>' +
  '<circle class="mq-wave" cx="152" cy="60" r="18"/>' +
  '</svg>';

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
    startZone: o.startZone === 'forest' || o.startZone === 'edge' ? o.startZone : 'arena', // [FOREST] место старта; [ONBOARD] 'edge' — у края арены
    gestureMode: o.gestureMode === 'master' ? 'master' : 'novice', // [НОВИЧОК] набор жестов
    autoWalk: o.autoWalk !== false,                                 // [НОВИЧОК] автоход
    difficulty: o.difficulty === 'normal' ? 'normal' : 'easy', // [FEEL] сложность боя с Регентом
    hero: HERO_OPTIONS.some(([v]) => v === o.hero) ? o.hero : DEFAULT_SETTINGS.hero,
    muted: o.muted === true, // [SFX] «Без звука» (клавиша M)
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

/* ------------------------------------------------- [ПРОЕКТОР] распознанные жесты
 * Для подписей под превью камеры, шпаргалки и режима презентации: что именно распознала игра
 * у каждой руки. Поля берутся из сырого InputFrame (vision.read + handZone.apply в main.js);
 * normInput выше их не пропускает, и его потребители (обучение, пауза) не меняются. */

const RUNE_RU = { ignis: 'ИГНИС ▲', fulgur: 'ФУЛЬГУР ϟ', orbis: 'ОРБИС ○', stella: 'СТЕЛЛА ★', spira: 'СПИРА @', lemnis: 'ЛЕМНИСКА ∞', caret: 'АКУС ^', vee: 'МЕССИС V', clepsydra: 'КЛЕПСИДРА ⧗', alpha: 'АЛЬФА ℓ' };
const SIGIL_RU = { clap: 'ХЛОПОК', gate: 'ВРАТА БУРИ', frame: 'РАМКА', delta: 'ДЕЛЬТА', cor: 'СЕРДЦЕ', pillar: 'СТОЛП НЕБЕС' };   // [W3-MAGIC] +столп
const SHAPE_RU = { pinch: 'ЩЕПОТЬ', point: 'УКАЗАТЕЛЬНЫЙ', fist: 'КУЛАК', open: 'ЛАДОНЬ', victory: 'V', unknown: 'В КАДРЕ' };
const READ_ERR_MS = 4200;      // «ОШИБКА» держится столько же, сколько карточка подсказки battleHud
const CHEAT_KEY = 'ashen-oath.cheat.v1';

function normGestures(v) {
  if (!v || typeof v !== 'object') return null;
  const debug = v.source === 'debug';
  if (v.valid !== true) return debug ? { source: 'debug', empty: true } : null;
  const H = v.hands && typeof v.hands === 'object' ? v.hands : null;
  const hand = (h) => (h && typeof h === 'object' && typeof h.shape === 'string'
    ? { shape: SHAPE_RU[h.shape] ? h.shape : 'unknown', palm: typeof h.palmFacing === 'string' ? h.palmFacing : '', charge: clamp(num(h.charge), 0, 1) }
    : null);
  const st = v.stick && typeof v.stick === 'object' ? v.stick : null;
  const bow = v.bow && typeof v.bow === 'object' ? v.bow : null;
  const hs = v.handSpell && typeof v.handSpell === 'object' ? v.handSpell : null;
  const dd = v.dashDir && typeof v.dashDir === 'object' && (num(v.dashDir.x) || num(v.dashDir.z)) ? { x: num(v.dashDir.x), z: num(v.dashDir.z) }
    : num(v.dash) !== 0 ? { x: Math.sign(num(v.dash)), z: 0 } : null;
  const hint = v.hint && typeof v.hint === 'object' && typeof v.hint.text === 'string' && v.hint.text
    ? { code: String(v.hint.code || ''), gesture: String(v.hint.gesture || ''), text: v.hint.text.slice(0, 220), side: v.hint.side === 'left' || v.hint.side === 'right' ? v.hint.side : null, tMs: num(v.hint.tMs, 0) }
    : null;
  return {
    source: debug ? 'debug' : 'cv',
    available: !!(H && H.available),
    left: hand(H && H.left),
    right: hand(H && H.right),
    drawing: !!(H && H.drawing),
    attack: v.attack === true,
    shield: v.shield === true,
    burst: v.burst === true,
    burstBoth: v.burstHand === 'both',
    spark: v.spark === true,
    slash: !!v.slash,
    parry: v.parry === true,
    sigil: typeof v.sigil === 'string' && v.sigil ? v.sigil : null,
    sigilCharge: clamp(num(v.sigilCharge), 0, 1),   // [W3-MAGIC] ладони сомкнуты — заряд
    sigilAxis: v.sigilAxis === 'h' || v.sigilAxis === 'v' ? v.sigilAxis : null,
    rune: typeof v.rune === 'string' && v.rune ? v.rune : null,
    dashDir: dd,
    conjure: v.conjure && typeof v.conjure === 'object' ? (v.conjure.kind === 'prism' ? 'prism' : 'orb') : null,
    thrown: !!(v.throw && typeof v.throw === 'object'),
    stick: st ? {
      mode: st.mode === 'steer' ? 'steer' : 'stick', engaged: st.engaged === true,
      gait: st.gait === 'run' || st.gait === 'walk' ? st.gait : 'idle',
      turn: clamp(num(st.turn, num(st.x)), -1, 1), x: clamp(num(st.x), -1, 1), z: clamp(num(st.z), -1, 1),
    } : null,
    moveX: clamp(num(v.moveX), -1, 1),
    moveZ: clamp(num(v.moveZ), -1, 1),
    charge: clamp(num(v.charge), 0, 1),
    bowActive: !!(bow && bow.active),
    bowDraw: bow ? clamp(num(bow.draw), 0, 1) : 0,
    bowRelease: !!(bow && bow.release),
    spell: !!(hs && (hs.phase === 'form' || hs.phase === 'hold')),
    spellThrow: !!(hs && hs.phase === 'throw'),
    hint,
  };
}

/* Пиктограммы базовых жестов (36×36, контур currentColor). Рука — «прихватка»: ладонь + пальцы толстыми штрихами. */
const SVG36 = 'viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const PALM = (dx = 0, dy = 0) =>
  `<g transform="translate(${dx} ${dy})"><rect x="11" y="17" width="13" height="12" rx="4.2" fill="currentColor" fill-opacity=".2"/>` +
  '<path d="M13 17.5V9.5M16.3 17V7.5M19.6 17V8.3M22.6 18V11.5" stroke-width="2.8"/><path d="M11.3 22.5 8.2 18.8" stroke-width="2.8"/></g>';
const FIST = (dx = 0, dy = 0) =>
  `<g transform="translate(${dx} ${dy})"><rect x="10.5" y="13" width="15" height="14" rx="4.8" fill="currentColor" fill-opacity=".2"/>` +
  '<path d="M14.3 13.4v4M18 13.4v4M21.7 13.4v4" stroke-width="1.4"/><path d="M10.8 21h6.4" stroke-width="2.4"/></g>';
const GESTURE_ICONS = {
  // ход «рулём»: ладонь у груди, дуга-руль над ней
  move: `<svg ${SVG36}>${PALM(0, 4)}<path d="M8 8.5q10-6.5 20 0" /><path d="M8 8.5l.4-3.4M8 8.5l3.3.6M28 8.5l-.4-3.4M28 8.5l-3.3.6"/></svg>`,
  // щит: ладонь толкается к камере — волны впереди
  shield: `<svg ${SVG36}>${PALM(-3, 1)}<path d="M26.5 12c2.2 3.6 2.2 8.4 0 12M30 9c3.4 5.4 3.4 12.6 0 18"/></svg>`,
  // рывок: ладонь и линии скорости
  dash: `<svg ${SVG36}>${PALM(4, 1)}<path d="M3 15h6M2 20h7M3.5 25h5"/></svg>`,
  // «OK»: кольцо большого и указательного, три пальца вверх
  bolt: `<svg ${SVG36}><circle cx="13" cy="16" r="4.4" stroke-width="2.4"/><path d="M18.5 18V8M21.8 18.5V9M25 19.5V11.5" stroke-width="2.8"/>` +
    '<path d="M9.5 19.5c.4 5.6 3.8 9 8.6 9 4.6 0 7.6-3.2 7.6-7.6v-1.4" fill="currentColor" fill-opacity=".2"/><path d="M30 7l3-2M30.5 11.5h3.2" /></svg>',
  // выброс: кулак → ладонь, лучи
  burst: `<svg ${SVG36}>${PALM(0, 3)}<path d="M18 2.5v3.6M7 6.5l2.4 2.4M29 6.5l-2.4 2.4M3.5 15.5h3.4M29 15.5h3.4"/></svg>`,
  // искра: из кулака выпрямлен указательный, у кончика — вспышка
  spark: `<svg ${SVG36}>${FIST(0, 6)}<path d="M14.3 19.5V8.5" stroke-width="2.8"/><path d="M14.3 2.2v2.4M9.8 4.2l1.6 1.6M18.8 4.2l-1.6 1.6M8.6 8.4h2.2M17.8 8.4H20"/></svg>`,
  // [W3-MAGIC] ладони вместе → растянуть: две сомкнутые ладони, стрелки в стороны и вверх-вниз
  stretch: `<svg ${SVG36}><rect x="12.6" y="11" width="5" height="14" rx="2.5" fill="currentColor" fill-opacity=".2" stroke-width="2.2"/>` +
    '<rect x="18.4" y="11" width="5" height="14" rx="2.5" fill="currentColor" fill-opacity=".2" stroke-width="2.2"/>' +
    '<path d="M9 18H2.8M5.3 15.5 2.8 18l2.5 2.5M27 18h6.2M30.7 15.5l2.5 2.5-2.5 2.5M18 8V2.6M15.6 5 18 2.6 20.4 5M18 28v5.4M15.6 31l2.4 2.4 2.4-2.4"/></svg>',
};
const CHEAT_ITEMS = [
  { key: 'move', side: 'left', name: 'Ход', how: 'левая ладонь у груди', howStick: 'левая рука — джойстик' },
  { key: 'shield', side: 'left', name: 'Щит', how: 'толкни ладонь к камере' },
  { key: 'dash', side: 'left', name: 'Рывок', how: 'резкий дёрг левой' },
  { key: 'bolt', side: 'right', name: 'Снаряд', how: '«OK» правой' },
  { key: 'burst', side: 'right', name: 'Выброс', how: 'кулак → резко ладонь' },
  { key: 'spark', side: 'right', name: 'Искра', how: 'щелчок указательным' },
  { key: 'stretch', side: 'right', name: 'Врата · Столп', how: 'ладони вместе → растянуть' },   // [W3-MAGIC]
];

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

// Совет после поражения. Управление — как в подсказках core/gestureCoach.js (shield_push/shield_palm,
// ok_ring_open/ok_fingers) и на плитках HUD: щит — толчок левой ладонью к камере, снаряд — «OK» правой.
function defeatTip(stats, snap) {
  if (num(stats.blocks) === 0) return 'Щит: резко толкните раскрытую левую ладонь к камере, ладонью вперёд, и держите её так. Он гасит атаки, которые можно блокировать. Просто поднятая рука щит не ставит.';
  if (num(stats.dodges) === 0) return 'Рывок: резко дёрните левой рукой в сторону и верните её — так можно уйти из зоны удара.';
  if (snap && snap.boss && snap.boss.stage === 2) {
    return 'После половины здоровья страж усиливается. Следите за замахом и не стойте в зоне удара.';
  }
  return 'Снаряды летят, пока правая рука держит «OK»: кончики большого и указательного сомкнуты в кольцо, остальные три пальца выпрямлены. Стреляйте между атаками Регента.';
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
    quickStart: options.quickStart === true,  // [ONBOARD] «Играть»; экран камеры с рамкой-силуэтом и автокалибровкой (ведёт main.js)
    // [ТРЕНАЖЁР] прежний экран обучения из карточек вместо «Научись за 60 секунд»
    tutorialCards: options.tutorialCards === true || /[?&]tutorial=cards\b/.test((win.location && win.location.search) || ''),
  };

  // [ONBOARD] стили быстрого входа — отдельным файлом рядом с ui.css (как netLobby.css)
  if (cfg.quickStart && !doc.getElementById('ao-onboard-css')) {
    try {
      const l = doc.createElement('link');
      l.id = 'ao-onboard-css'; l.rel = 'stylesheet';
      l.href = new URL('./ui-onboard.css', import.meta.url).href;
      (doc.head || doc.documentElement).appendChild(l);
    } catch (e) { console.warn('[ui] ui-onboard.css', e); }
  }

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
    // [ПРОЕКТОР] подписи жестов: защёлка импульсов по рукам, активная «ОШИБКА», когда сработал жест шпаргалки
    read: { left: null, right: null, err: null, errKey: '', fired: {}, view: null },
    cheatHidden: false,
    present: false,
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
    const field = el('div', { class: 'ao-field' }, el('div', { class: 'ao-field__head' }, el('label', { for: id, text: o.label }), value, o.head || null), input, hint);
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

  // [НОВИЧОК] «Жесты»: Новичок (только базовые) / Мастер (все) + «Автоход» — на виду, рядом с «Начать»
  const GESTURE_OPTIONS = [['novice', 'Новичок'], ['master', 'Мастер']];
  function buildGestureMode(prefix) {
    const name = `${uid}-${prefix}-gesturemode`;
    const seg = el('div', { class: 'ao-seg' });
    const hintId = `${name}-hint`;
    const hint = el('div', { class: 'ao-field__hint', id: hintId });
    const TIPS = {
      novice: 'Только базовые жесты: щит, рывок, «OK», кулак → выброс, сфера',
      master: 'Все жесты: ещё руны, «Искра», рассечение, парирование, печати, лук, магия рукой',
    };
    const autoId = `${name}-auto`;
    const auto = el('input', { type: 'checkbox', id: autoId, class: 'ao-check__input' });
    const autoLabel = el('label', { class: 'ao-check', for: autoId, title: 'Герой сам идёт к Регенту и обходит его по кругу — вы только сражаетесь, левая рука свободна для щита и рывка' }, auto, el('span', { text: 'Автоход' }));
    const fs = el('fieldset', { class: 'ao-field ao-fieldset', 'aria-describedby': hintId },
      el('legend', { class: 'ao-field__legend', text: 'Жесты' }),
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center' }, seg, autoLabel), hint);
    const inputs = [];
    for (const [value, label] of GESTURE_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      seg.append(el('label', { class: 'ao-seg__opt', title: TIPS[value] }, input, el('span', { class: 'ao-seg__label', text: label })));
      listen(input, 'change', () => { if (input.checked) invoke('onSettings', { gestureMode: value }); });
    }
    listen(auto, 'change', () => invoke('onSettings', { autoWalk: auto.checked }));
    const ctl = {
      sync(settings, force) {
        const m = settings.gestureMode === 'master' ? 'master' : 'novice';
        setText(hint, `${TIPS[m]}${settings.autoWalk !== false ? '. Автоход ведёт героя к Регенту и вокруг него.' : '.'}`);
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) { const on = i.value === m; if (i.checked !== on) i.checked = on; }
        if (auto.checked !== (settings.autoWalk !== false)) auto.checked = settings.autoWalk !== false;
      },
    };
    listen(fs, 'focusout', (e) => { if (!fs.contains(e.relatedTarget) && state.settings) ctl.sync(state.settings, true); });
    controls.push(ctl);
    return fs;
  }

  // [FOREST] «Место старта»: Пепельное плато (у арены) / Сияющий лес (у врат леса)
  // [ONBOARD] 'edge' — сразу у края арены (бой через секунды), 'arena' — прежняя прогулка от плато
  const ZONE_OPTIONS = [['edge', 'У арены'], ['arena', 'Пепельное плато'], ['forest', 'Сияющий лес']];
  function buildStartZone(prefix) {
    const name = `${uid}-${prefix}-startzone`;
    const seg = el('div', { class: 'ao-seg' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset' }, el('legend', { class: 'ao-field__legend', text: 'Место старта' }), seg);
    const inputs = [];
    const TIPS = { edge: 'Сразу на краю арены Регента — бой через пару секунд', arena: 'На пепельном плато: дойти до арены Регента пешком', forest: 'У эльфийских врат Сияющего леса, к северу от арены' };
    for (const [value, label] of ZONE_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      const short = prefix === 'menu' ? ({ arena: 'Плато', forest: 'Лес' }[value] || label) : label;   // в меню — коротко, чтобы встать в ряд
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

  // [FEEL] «Сложность»: Лёгкая (Регент на 30% слабее, по умолчанию) / Обычная. Действует со следующего боя.
  const DIFFICULTY_OPTIONS = [['easy', 'Лёгкая'], ['normal', 'Обычная']];
  function buildDifficulty(prefix) {
    const name = `${uid}-${prefix}-difficulty`;
    const seg = el('div', { class: 'ao-seg' });
    const fs = el('fieldset', { class: 'ao-field ao-fieldset' }, el('legend', { class: 'ao-field__legend', text: 'Сложность' }), seg);
    const inputs = [];
    const TIPS = { easy: 'Для первого боя: у Регента на 30% меньше здоровья и урона', normal: 'Полная сила Регента' };
    for (const [value, label] of DIFFICULTY_OPTIONS) {
      const input = el('input', { type: 'radio', name, value, class: 'ao-seg__input' });
      inputs.push(input);
      seg.append(el('label', { class: 'ao-seg__opt', title: `${label}: ${TIPS[value]}` }, input, el('span', { class: 'ao-seg__label', text: label })));
      listen(input, 'change', () => { if (input.checked) invoke('onSettings', { difficulty: value }); });
    }
    const ctl = {
      sync(settings, force) {
        if (!force && fs.contains(doc.activeElement)) return;
        for (const i of inputs) { const on = i.value === settings.difficulty; if (i.checked !== on) i.checked = on; }
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
      else if (key === 'gestureMode') wrap.append(buildGestureMode(prefix));   // [НОВИЧОК]
      else if (key === 'startZone') { // [FOREST] в одном ряду с «Управлением движением» (меню 1366×650 не растёт)
        const zs = buildStartZone(prefix), prev = wrap.lastElementChild;
        if (prev && keys[keys.indexOf(key) - 1] === 'moveMode') { const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 16px;align-items:flex-end' }); wrap.replaceChild(row, prev); row.append(prev, zs); }
        else wrap.append(zs);
      }
      else if (key === 'volume' && !cfg.showVolume) continue;
      else if (key === 'volume') {
        // [SFX] «Без звука» — в строке громкости, чтобы меню 1366×650 не выросло; то же делает клавиша M
        const mute = el('button', { type: 'button', class: 'ao-mute', 'aria-pressed': 'false', title: 'Выключить звук — клавиша M', text: 'Без звука · M' });
        listen(mute, 'click', () => invoke('onSettings', { muted: !(state.settings && state.settings.muted) }));
        controls.push({
          sync(st) {
            const m = !!(st && st.muted);
            setAttr(mute, 'aria-pressed', m ? 'true' : 'false');
            setText(mute, m ? 'Звук выключен · M' : 'Без звука · M');
          },
        });
        wrap.append(
          buildRange({
            key: 'volume', prefix, label: 'Громкость', min: 0, max: 100, step: 5, head: mute,
            toRaw: (v) => Math.round(v * 100), fromRaw: (r) => r / 100, format: (v) => `${Math.round(v * 100)}%`,
          }),
        );
      } else if (key === 'sensitivity') {
        wrap.append(
          buildRange({
            key: 'sensitivity', prefix, label: 'Чувствительность движений', min: 50, max: 200, step: 5,
            hint: 'Выше — меньше отводить руку для поворота и легче толчок щита (но чаще случайный); ниже — наоборот.',
            toRaw: (v) => Math.round(v * 100), fromRaw: (r) => r / 100, format: (v) => `${v.toFixed(2).replace('.', ',')}×`,
          }),
        );
      } else if (key === 'difficulty') wrap.append(buildDifficulty(prefix)); // [FEEL]
      else if (key === 'reducedMotion') {
        const mo = buildMotion(prefix), prev = wrap.lastElementChild;
        // [FEEL] в одном ряду со «Сложностью» (меню не растёт по высоте)
        if (prev && keys[keys.indexOf(key) - 1] === 'difficulty') { const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 22px;align-items:flex-end' }); wrap.replaceChild(row, prev); row.append(prev, mo); }
        else wrap.append(mo);
      }
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
    // [ONBOARD] одна большая кнопка «Играть»: камера, калибровка и обучение дальше идут сами
    const start = btn(cfg.quickStart ? 'Играть' : 'Начать', () => invoke('onStart', { from: 'menu' }), { variant: 'primary', size: cfg.quickStart ? 'xl' : 'lg' });
    const oathBtn = btn('Клятва героя', () => invoke('onOath', { from: 'menu' }), { variant: 'secondary' });
    const netBtn = btn('Онлайн-дуэль', () => invoke('onNet', { from: 'menu' }), { variant: 'secondary' }); // [NET] экран лобби — modules/netLobby.js
    const bookM = localBtn('Книга заклинаний', (e) => openBook(e && e.currentTarget), { iconName: 'book' }); // [ТРЕНАЖЁР] все жесты
    // [ТВИСТ «ОШИБКА»] тренажёр: чек-лист условий жеста вживую — твист за 20 секунд
    const techBtn = btn('Тренажёр техники', () => invoke('onTechnique', { from: 'menu' }), { variant: 'secondary' });
    techBtn.node.classList.add('ao-menu__tech');
    const oathPts = el('span', { class: 'ao-oathpts', hidden: true });
    const dbg = el('button', { type: 'button', class: 'ao-toggle', 'aria-pressed': 'false' }, el('span', { class: 'ao-toggle__track', 'aria-hidden': 'true' }), el('span', { class: 'ao-toggle__label', text: 'Отладка с клавиатуры' }));
    listen(dbg, 'click', () => invoke('onDebug', !state.debug));
    // [ПРОЕКТОР] режим презентации для питча через проектор (то же, что клавиша P)
    const presentBtn = el('button', { type: 'button', class: 'ao-toggle ao-toggle--present', 'aria-pressed': 'false', 'aria-keyshortcuts': 'P', 'data-ui-local': '' }, el('span', { class: 'ao-toggle__track', 'aria-hidden': 'true' }), el('span', { class: 'ao-toggle__label', text: 'Режим презентации · P' }));
    listen(presentBtn, 'click', () => setPresent(!state.present));
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
      el('div', { class: 'ao-menu__cta' }, el('div', { class: 'ao-menu__row' }, start.node, techBtn.node, oathBtn.node, oathPts, netBtn.node /* [NET] */, bookM.node), el('p', { class: 'ao-note', text: 'Сидя на устойчивом стуле или стоя в паре шагов от камеры. Нужны веб-камера, Chrome или Edge.' }), buildSettings(['gestureMode'], 'menu')), // [НОВИЧОК] режим жестов — на виду
      buildHeroPick('menu'),
      el('div', { class: 'ao-menu__settings' }, el('h2', { class: 'ao-h3', text: 'Настройки' }), buildSettings(['moveMode', 'startZone', 'quality', 'volume', 'difficulty', 'reducedMotion'], 'menu')),
      el('div', { class: 'ao-menu__foot' }, el('div', { class: 'ao-menu__toggles' }, dbg, presentBtn), dbgKeys),
    );
    return {
      section: screenSection('menu', panel, hid),
      heading: title,
      focus: () => start.node,
      update(ctx) {
        setAttr(dbg, 'aria-pressed', ctx.debug ? 'true' : 'false');
        setAttr(presentBtn, 'aria-pressed', state.present ? 'true' : 'false');
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
    // [ONBOARD] быстрый экран: живое превью с рамкой-силуэтом (зелёная — плечи и кисти в кадре), кольцо
    // калибровки вокруг головы, три подсказки-иконки. Камеру, калибровку и переход дальше ведёт main.js.
    const quick = cfg.quickStart ? (() => {
      const frame = el('div', { class: 'ao-onb__frame', 'data-fit': 'off', html: ONB_FRAME_SVG });
      const ring = frame.querySelector('.ao-onb__ring');
      const hands = {};
      frame.querySelectorAll('[data-hand]').forEach((n) => { hands[n.getAttribute('data-hand')] = n; });
      const sub = el('p', { class: 'ao-onb__sub' });
      const stage = el('div', { class: 'ao-onb__stage' }, host, frame);
      const tip = (iconName, text) => el('li', { class: 'ao-onb__tip' }, icon(iconName, 'ao-onb__tipicon'), el('span', { text }));
      const tips = el('ul', { class: 'ao-onb__tips' },
        tip('frame', 'Плечи и кисти — в рамке'),
        tip('armsdown', 'Руки вниз, замрите на 1,5 с'),
        tip('lock', 'Видео остаётся на компьютере'));
      setAttr(h, 'aria-live', 'polite');
      const node = el('div', { class: 'ao-panel ao-panel--camera ao-panel--onb ao-frame' },
        el('div', { class: 'ao-onb__head' }, h, sub), stage, tips, err.node,
        el('div', { class: 'ao-actions ao-actions--onb' }, enable.node, next.node, skip.node, el('span', { class: 'ao-spacer' }), back.node));
      return { node, frame, ring, hands, sub };
    })() : null;
    let running = false;
    // [ONBOARD] состояние рамки и подписи: off → none (никого) → partial (плечи без кистей) → ok; кольцо — калибровка
    function updateQuick(ctx, st, pend) {
      const q = quick, tr = ctx.tr, parts = tr.parts || {};
      const shoulders = running && st !== 'lost' && parts.leftShoulder === true && parts.rightShoulder === true;
      const wristL = shoulders && parts.leftWrist === true, wristR = shoulders && parts.rightWrist === true;
      const calibrating = st === 'calibrating';
      const done = running && !calibrating && ctx.calibrated === true;
      const fit = !running ? 'off' : !shoulders ? 'none' : wristL && wristR ? 'ok' : 'partial';
      setAttr(q.frame, 'data-fit', fit);
      setAttr(q.node, 'data-state', st === 'error' ? 'error' : null);   // ошибка: превью меньше, подсказки скрыты — «Повторить» в кадре
      setAttr(q.hands.left, 'data-on', wristL ? 'true' : 'false');
      setAttr(q.hands.right, 'data-on', wristR ? 'true' : 'false');
      const prog = calibrating ? clamp(num(tr.progress), 0, 1) : done && shoulders ? 1 : 0;
      setStyle(q.ring, 'stroke-dashoffset', String(Math.round((1 - prog) * 1000) / 10));
      setAttr(q.frame, 'data-ring', calibrating ? 'run' : done && shoulders ? 'done' : 'off');
      const hint = String(tr.message || '');
      const rel = ctx.vm.tracking && ctx.vm.tracking.debug && ctx.vm.tracking.debug.reliability;
      const scale = running && rel ? rel.scaleWarning : null;   // 'far' | 'near' — масштаб не совпал с сохранённой калибровкой
      let title, sub = '';
      if (ctx.debug) { title = 'Отладка с клавиатуры'; sub = 'Камера не нужна: «Продолжить без камеры».'; }
      else if (st === 'error') title = 'Камера не включилась';
      else if (st === 'permission') { title = 'Разрешите камеру'; sub = 'Запрос — у адресной строки браузера.'; }
      else if (st === 'loading') { title = 'Загружаем распознавание…'; sub = tr.progress !== null && tr.progress > 0 && tr.progress < 1 ? pct(tr.progress) : ''; }
      else if (!running) { title = pend ? 'Включаем камеру…' : 'Камера выключена'; sub = pend ? '' : 'Нажмите «Включить камеру».'; }
      else if (scale === 'far') { title = 'Сядьте ближе'; sub = 'Или замрите на 1,5 с — игра подстроится.'; }
      else if (scale === 'near') { title = 'Отодвиньтесь'; sub = 'Или замрите на 1,5 с — игра подстроится.'; }
      else if (!shoulders) { title = 'Сядьте в рамку'; sub = 'Чтобы плечи и кисти попали в кадр.'; }
      else if (calibrating && /опустите/i.test(hint)) { title = 'Опустите руки'; sub = 'И замрите на полторы секунды.'; }
      else if (calibrating) { title = prog > 0.02 ? 'Замрите…' : 'Сядьте ровно'; sub = prog > 0.02 ? pct(prog) : 'Руки вниз.'; }
      else if (done) { title = 'Готово!'; sub = wristL && wristR ? 'Начинаем…' : 'Начинаем… Держите кисти в кадре.'; }
      else if (fit === 'partial') { title = 'Покажите кисти'; sub = 'Опустите руки так, чтобы кисти были в кадре.'; }
      else { title = 'Сядьте ровно'; sub = 'Руки вниз.'; }
      setText(h, title);
      setText(q.sub, sub);
      setHidden(q.sub, !sub);
      // кнопки: «Включить камеру» — только если камера выключена или упала; «Далее» — если калибровка уже есть
      setBtn(enable, { hidden: running || ctx.debug || pend || CAMERA_STARTING.includes(st) });
      setBtn(next, { hidden: !(done && shoulders) || ctx.debug, label: 'Далее' });
    }
    return {
      section: screenSection('camera', quick ? quick.node : panel, hid),
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
        if (quick) updateQuick(ctx, st, pend || !!(ctx.vm.onboard && ctx.vm.onboard.starting));
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

  // Карточки «Как управлять» (7 штук, ~35 вводов): теперь живут в «Книге заклинаний» (раздел
  // «Продвинутые») и в прежнем экране обучения — он выключен по умолчанию (?tutorial=cards).
  function buildTutCards() {
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
    return { grid, cards };
  }
  // [V5] тексты карточки движения — под выбранную схему («Руль» / «Джойстик»)
  // [НОВИЧОК] opts.novice — тексты базовых жестов, карточки masterOnly скрыты; без opts — все жесты («Книга заклинаний»)
  function syncTutCards(cards, ctx, opts = {}) {
    const moveMode = ctx.settings && ctx.settings.moveMode === 'stick' ? 'stick' : 'steer';
    const novice = !!opts.novice, autoWalk = !!opts.autoWalk;
    const mkey = `${moveMode}|${novice}|${autoWalk}`;
    for (const c of Object.values(cards)) {
      if (c.mode === mkey) continue;
      c.mode = mkey;
      setHidden(c.card, novice && !!c.item.masterOnly);
      let v = moveMode === 'stick' && c.item.stick ? { ...c.item, ...c.item.stick } : c.item;
      if (novice && c.item.novice) v = { ...v, ...c.item.novice, ...(autoWalk && c.item.novice.auto ? c.item.novice.auto : {}) };
      setText(c.titleEl, v.title); setText(c.gestEl, v.gesture); setText(c.effEl, v.effect);
      c.figEl.innerHTML = v.svg; // только статические строки этого модуля
    }
  }

  // Прежний экран обучения «Как управлять» (стена карточек с живыми отметками). Выключен по умолчанию.
  const buildCardsTutorial = () => {
    const hid = `${uid}-tut-h`;
    const h = heading('h2', hid, 'Как управлять', 'ao-h2');
    const { grid, cards } = buildTutCards();
    const host = el('div', { class: 'ao-slothost' });
    const status = statusLine();
    const ready = el('p', { class: 'ao-msg' });
    // [НОВИЧОК] подзаголовок — под режим жестов и автоход
    const LEADS = {
      master: 'Левая рука ведёт героя, обе руки колдуют — всё сидя и без большой амплитуды.',
      novice: 'Левая рука ведёт героя, руки сражаются — пять базовых жестов, сидя или стоя.',
      auto: 'Герой идёт сам — вы только сражаетесь: щит, рывок, снаряды, выброс и сфера.',
    };
    const lead = el('p', { class: 'ao-lead', text: LEADS.master });
    // [ТВИСТ «ОШИБКА»] почти-правильный жест на обучении: что не так и как исправить
    const coachHead = el('span', { class: 'ao-tut-coach__head' });
    const coachText = el('span', { class: 'ao-tut-coach__text' });
    const coachPic = el('span', { class: 'ao-tut-coach__pic', 'aria-hidden': 'true' });   // «как сейчас → как надо»
    const coach = el('div', { class: 'ao-tut-coach', role: 'status', 'aria-live': 'polite', hidden: true }, coachPic, el('span', { class: 'ao-tut-coach__body' }, coachHead, coachText));
    let coachPicCode = '';
    const start = btn('В бой', () => invoke('onStart', { from: 'tutorial' }), { variant: 'primary', size: 'lg' });
    const recal = btn('Перекалибровать', pressCalibrate);
    const back = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--tutorial ao-frame' },
      el('div', { class: 'ao-head' }, h, lead),
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
        ),
        // [ПРОЕКТОР] кнопки — отдельной колонкой справа, чтобы «В бой» не уходила под край на 1366×768
        el('div', { class: 'ao-actions ao-actions--inline ao-tut-actions' }, start.node, recal.node, el('span', { class: 'ao-spacer' }), back.node),
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
        // [ONBOARD] доступность «В бой» — те же условия, что у main.js (gate); причина — прямо на кнопке
        const gate = ctx.vm.gate && typeof ctx.vm.gate === 'object' ? ctx.vm.gate : null;
        const canStart = ctx.debug || (gate ? gate.ok === true : st === 'ready' && ctx.calibrated !== false);
        setBtn(start, { disabled: !canStart, label: canStart || !gate || !gate.reason ? 'В бой' : gate.reason });
        setBtn(recal, { hidden: ctx.debug });
        paintStatus(status, ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg), ctx.debug ? '' : ctx.tr.message);
        let text;
        if (ctx.debug) text = 'Бой начнётся с управлением с клавиатуры. Это режим отладки, камера в нём не управляет героем.';
        else if (canStart) text = 'Трекинг готов. Начинайте, когда удобно сели.';
        else if (ctx.calibrated === false) text = 'Нужна калибровка. Нажмите «Перекалибровать».';
        else if (st === 'lost') text = 'Камера не видит позу. Кнопка «В бой» станет доступна, когда трекинг восстановится.';
        else if (st === 'calibrating') text = 'Идёт калибровка.';
        else if (gate && gate.reason) text = `${gate.reason}.`;   // [ONBOARD]
        else text = 'Камера ещё не готова.';
        setText(ready, text);
        // [V5] тексты карточек — под схему движения; [НОВИЧОК] и под режим жестов: лук и магия рукой скрыты
        const novice = !(ctx.settings && ctx.settings.gestureMode === 'master');
        const autoWalk = !(ctx.settings && ctx.settings.autoWalk === false);
        syncTutCards(cards, ctx, { novice, autoWalk });
        setText(lead, !novice ? LEADS.master : autoWalk ? LEADS.auto : LEADS.novice);

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
          if (t.hint.code !== coachPicCode) { coachPicCode = t.hint.code || ''; coachPic.innerHTML = hintPictogram(coachPicCode, { width: 126, height: 54, labels: true }); }
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
  };

  /* ------------------------------------------------ [ТРЕНАЖЁР] «Научись за 60 секунд» */
  // Экран обучения по умолчанию: 4 базовых жеста по одному (логика шагов — core/tutorialTrainer.js).
  // Крупная анимированная кисть рядом с живым превью камеры (скелет кисти рисует trackingHud на overlay),
  // «✓ Распознано!» и реакция манекена, подсказка «ОШИБКА» прямо под кистью, «Пропустить», прогресс «2 / 4».
  // В «Отладке с клавиатуры» шаги проходятся клавишами боя: W, K, J, L (H — пример подсказки «ОШИБКА»).
  // Кнопки, которые меняют только сам экран, помечены data-ui-local (в игру ничего не передают).

  const STEP_SHORT = { walk: 'Ход', shield: 'Щит', shot: 'Выстрел', burst: 'Выброс' };
  const LIVE_TEXT = {
    walk: ['Ладонь — на уровень груди', 'Герой идёт — держи ещё…'],
    shield: ['Толкни ладонь к камере', 'Щит поднят — держи…'],
    shot: ['Сомкни пальцы в кольцо «OK»', '«OK» есть — держи…'],
    burst: ['Сожми кулак — копится заряд', 'Держи кулак — заряд копится…', 'Заряд есть — теперь резко раскрой!'],
  };
  const BURST_READY = 0.35; // заряд, после которого раскрытие кулака даёт выброс (minCharge распознавателя — 0,3)
  function lowerFirst(t) { return t ? t[0].toLowerCase() + t.slice(1) : ''; }
  function localBtn(label, onPress, opts) {
    const b = btn(label, onPress, opts);
    b.node.setAttribute('data-ui-local', '');
    return b;
  }

  const trainer = (() => {
    const tr = createTutorialTrainer();
    const hid = `${uid}-tut-h`;
    const h = heading('h2', hid, 'Научись за 60 секунд', 'ao-h2');
    const pills = TRAINER_STEPS.map((st, i) =>
      el('li', { class: 'ao-trn-pill', 'data-state': 'todo' },
        el('span', { class: 'ao-trn-pill__n', 'aria-hidden': 'true', text: String(i + 1) }),
        el('span', { class: 'ao-trn-pill__t', text: STEP_SHORT[st.id] || st.title })));
    const steps = el('ol', { class: 'ao-trn-steps', 'aria-label': 'Шаги обучения' }, pills);
    const count = el('span', { class: 'ao-trn-count' });
    const skipAll = localBtn('Пропустить обучение', () => { tr.skipAll(win.performance.now()); }, { variant: 'quiet' });

    // левая колонка: какая рука, что сделать, крупная кисть, подсказка/«ОШИБКА»
    const handEl = el('p', { class: 'ao-trn-hand' });
    const titleEl = el('h3', { class: 'ao-trn-title' });
    const effectEl = el('p', { class: 'ao-trn-effect' });
    const keyEl = el('p', { class: 'ao-trn-key', hidden: true });
    const picEl = el('div', { class: 'ao-trn-pic' });
    const tipEl = el('p', { class: 'ao-trn-tip' });
    const coachHead = el('span', { class: 'ao-tut-coach__head' });
    const coachText = el('span', { class: 'ao-tut-coach__text' });
    const coach = el('div', { class: 'ao-tut-coach ao-trn-coach', role: 'status', 'aria-live': 'polite', hidden: true }, coachHead, coachText);
    // подсказка «ОШИБКА» — прямо под кистью (место под неё зарезервировано: экран не прыгает)
    const gesture = el('div', { class: 'ao-trn-gesture' },
      el('div', { class: 'ao-trn-what' }, handEl, titleEl, effectEl, keyEl, tipEl),
      el('div', { class: 'ao-trn-picol' }, picEl, el('div', { class: 'ao-trn-say' }, coach)));

    // правая колонка: живое превью камеры, шкала удержания/заряда, статус трекинга
    const host = el('div', { class: 'ao-slothost' });
    const capKey = el('kbd', { class: 'ao-trn-keycap__key' });
    const capText = el('span', { class: 'ao-trn-keycap__text' });
    const keycap = el('div', { class: 'ao-trn-keycap', hidden: true, 'aria-hidden': 'true' },
      el('span', { class: 'ao-trn-keycap__lab', text: 'Отладка с клавиатуры' }), capKey, capText,
      el('span', { class: 'ao-trn-keycap__lab', text: 'H — пример подсказки «ОШИБКА»' }));
    const meterLab = el('span', { class: 'ao-trn-meter__lab' });
    const meterM = meter('Прогресс жеста', 'ao-trn-meter__bar');
    const status = statusLine();
    const meterBox = el('div', { class: 'ao-trn-meter' }, meterLab, meterM.node);
    const camCol = el('div', { class: 'ao-trn-cam' }, el('div', { class: 'ao-trn-camwrap' }, host, keycap), meterBox, status.node);

    const okSub = el('span', { class: 'ao-trn-ok__sub' });
    const okBadge = el('div', { class: 'ao-trn-ok', hidden: true, role: 'status' },
      el('span', { class: 'ao-trn-ok__badge' }, el('span', { class: 'ao-trn-ok__mark', 'aria-hidden': 'true', text: '✓' }), el('span', { text: 'Распознано!' })), okSub);
    const stage = el('div', { class: 'ao-trn-stage' }, gesture, camCol, okBadge);
    const mainCol = (node) => stage.insertBefore(node, camCol); // итог встаёт на место карточки жеста
    const mq = el('div', { class: 'ao-trn-mq', 'data-step': 'walk', html: TRAINER_DUMMY_SVG });

    // итог после 4 шагов
    const doneLead = el('p', { class: 'ao-lead' });
    const sums = TRAINER_STEPS.map((st) => {
      const state = el('span', { class: 'ao-trn-sum__state' });
      const g = el('span', { class: 'ao-trn-sum__g' });
      const node = el('li', { class: 'ao-trn-sum', 'data-state': 'ok' },
        el('div', { class: 'ao-trn-sum__pic', html: TRAINER_MINI[st.id] }),
        el('strong', { class: 'ao-trn-sum__t', text: `${st.effect}` }), g, state);
      return { node, state, g, st };
    });
    const doneView = el('div', { class: 'ao-trn-done', hidden: true },
      el('h3', { class: 'ao-trn-done__h', text: 'Готово! Четыре жеста — и ты в бою' }), doneLead,
      el('ol', { class: 'ao-trn-sums' }, sums.map((x) => x.node)),
      el('p', { class: 'ao-note', text: 'Рывок, руны, печати, лук и стихии — в «Книге заклинаний» (меню и пауза). Пауза в бою — кнопка в углу или Esc.' }));
    mainCol(doneView);

    const ready = el('p', { class: 'ao-msg ao-trn-ready' });
    const start = btn('В бой', () => invoke('onStart', { from: 'tutorial' }), { variant: 'primary', size: 'lg' });
    const skip = localBtn('Пропустить', () => { tr.skip(win.performance.now()); });
    const again = localBtn('Пройти ещё раз', () => { tr.restart(win.performance.now()); h.focus({ preventScroll: true }); });
    const recal = btn('Перекалибровать', pressCalibrate);
    const bookBtn = localBtn('Книга заклинаний', (e) => openBook(e && e.currentTarget));
    const back = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--tutorial ao-panel--trainer ao-frame' },
      el('div', { class: 'ao-trn-head' }, h, steps, count, el('span', { class: 'ao-spacer' }), skipAll.node),
      stage,
      mq,
      el('div', { class: 'ao-trn-foot' }, ready,
        el('div', { class: 'ao-actions ao-actions--inline' }, start.node, skip.node, again.node, recal.node, bookBtn.node, el('span', { class: 'ao-spacer' }), back.node)),
    );

    let shownSeq = -1;
    let shownMode = '';
    let wasDone = false;
    // тренажёр пройден (или пропущен) в этой сессии: при новом входе (дуэль, «Начать» из меню,
    // перекалибровка) — сразу итог с «В бой»; «Пройти ещё раз» — снова с шага 1.
    // Только в том же режиме ввода: пройденное клавишами не засчитывается камере.
    let passedDebug = null;
    function paintStep(step, moveMode) {
      const v = step.stick && moveMode === 'stick' ? { ...step, ...step.stick } : step;
      setAttr(gesture, 'data-side', step.side);
      setText(handEl, step.hand);
      setText(titleEl, v.title);
      setText(effectEl, `→ ${step.effect}`);
      setText(tipEl, v.tip);
      setText(keyEl, `Клавиатура: ${step.keyText}`);
      setText(capKey, step.key);
      setText(capText, step.keyText);
      setAttr(mq, 'data-step', step.id);
      picEl.innerHTML = TRAINER_PICS[step.id] || ''; // только статические строки этого модуля; новая разметка — анимация с начала
    }
    return {
      section: screenSection('tutorial', panel, hid),
      heading: h,
      host,
      // фокус — на заголовок: пробел/Enter в отладке не должны случайно нажать «Пропустить»
      focus: () => (tr.done ? start.node : h),
      reset() {
        if (!(tr.done && passedDebug === state.debug)) tr.restart(win.performance.now());
        shownSeq = -1;
        wasDone = tr.done;
        state.tut.hint = null;
      },
      update(ctx) {
        const moveMode = ctx.settings && ctx.settings.moveMode === 'stick' ? 'stick' : 'steer';
        const raw = ctx.vm && ctx.vm.input && typeof ctx.vm.input === 'object' ? ctx.vm.input : null;
        // в отладке — только клавиатура, иначе — только камера
        const input = raw && (ctx.debug ? raw.source === 'debug' : raw.source === 'cv') ? raw : null;
        const v = tr.update(input, ctx.now, { moveMode });
        const step = v.step;
        if (v.done && !wasDone) passedDebug = ctx.debug;

        // шапка: шаги и «2 / 4»
        setText(count, `${v.number} / ${v.total}`);
        setAttr(steps, 'aria-label', v.done ? 'Обучение пройдено' : `Шаг ${v.number} из ${v.total}`);
        pills.forEach((p, i) => {
          const r = v.results[i];
          setAttr(p, 'data-state', r === 'ok' ? 'ok' : r === 'skip' ? 'skip' : !v.done && i === v.index ? 'now' : 'todo');
        });
        setHidden(skipAll.node, v.done);

        if (v.seq !== shownSeq || moveMode !== shownMode) {
          const stepChanged = v.seq !== shownSeq;
          shownSeq = v.seq;
          shownMode = moveMode;
          if (step && (v.phase === 'try' || !picEl.firstChild)) paintStep(step, moveMode);
          if (stepChanged && v.phase === 'ok') announce(`Распознано: ${step.effect}.`);
          else if (stepChanged && v.phase === 'try') announce(`Шаг ${v.number} из ${v.total}: ${step.hand.toLowerCase()}, ${step.title}.`);
          else if (stepChanged && v.done) announce('Обучение пройдено. Кнопка «В бой».');
        }
        setText(okSub, step ? `${step.effect}!` : '');
        setHidden(okBadge, v.phase !== 'ok');
        setClass(stage, 'is-ok', v.phase === 'ok');
        setClass(gesture, 'is-live', v.live);
        setClass(mq, 'is-live', v.live);
        setClass(mq, 'is-ok', v.phase === 'ok');
        setStyle(mq, '--lv', (Math.round(v.level * 20) / 20).toFixed(2));

        // шкала: удержание (ход, щит, «OK») или заряд кулака (выброс)
        if (step) {
          const lt = LIVE_TEXT[step.id] || ['', ''];
          const li = !v.live ? 0 : step.id === 'burst' && v.level >= BURST_READY ? 2 : 1;
          setText(meterLab, v.phase === 'ok' ? `${step.effect} — готово` : lt[li] || lt[1]);
          paintMeter(meterM, v.progress);
          setAttr(meterM.node, 'aria-label', step.holdMs > 0 ? 'Удержание жеста' : 'Заряд кулака');
        }

        // «ОШИБКА»: что не так и как исправить — на месте совета под кистью
        const hint = v.hint;
        setHidden(coach, !hint);
        if (hint) {
          const side = hint.side === 'left' ? ' · левая рука' : hint.side === 'right' ? ' · правая рука' : '';
          setText(coachHead, `Ошибка · ${hint.gesture}${side}`);
          setText(coachText, hint.text);
        }

        // отладка: какой клавишей проходится шаг
        setHidden(keyEl, !ctx.debug || !step);
        setHidden(keycap, !ctx.debug || !step);
        const info = ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg);
        paintStatus(status, info, ctx.debug ? '' : ctx.tr.message);
        setAttr(host, 'data-tone', v.phase === 'ok' ? 'good' : info.tone);
        setClass(skip.node, 'is-stuck', v.stuck);

        // итог: вместо карточки жеста; превью камеры остаётся
        setHidden(gesture, v.done);
        setHidden(mq, v.done);
        setHidden(meterBox, v.done);
        setHidden(doneView, !v.done);
        setClass(stage, 'is-done', v.done);
        if (v.done) {
          sums.forEach((x, i) => {
            const r = v.results[i];
            const sv = x.st.stick && moveMode === 'stick' ? { ...x.st, ...x.st.stick } : x.st;
            setText(x.g, `${x.st.hand}: ${lowerFirst(sv.title)}`);
            setAttr(x.node, 'data-state', r === 'ok' ? 'ok' : 'skip');
            setText(x.state, r === 'ok' ? '✓ получилось' : 'пропущено');
          });
          setText(doneLead, v.skipped
            ? `Получилось ${v.recognized} из ${v.total}. Пропущенное можно потренировать в бою или пройти ещё раз.`
            : 'Все четыре жеста распознаны. Ходи левой ладонью, щит — толчком, «OK» стреляет, кулак → ладонь — выброс.');
        }

        const st = ctx.tr.status;
        const canStart = ctx.debug || (st === 'ready' && ctx.calibrated !== false);
        setBtn(start, { hidden: !v.done && !ctx.debug, disabled: !canStart });
        setClass(start.node, 'ao-btn--primary', v.done);
        setClass(start.node, 'ao-btn--secondary', !v.done);
        setBtn(skip, { hidden: v.done });
        setBtn(again, { hidden: !v.done });
        setBtn(recal, { hidden: ctx.debug || !v.done });
        setBtn(bookBtn, { hidden: !v.done });
        let text = '';
        if (v.done) {
          if (ctx.debug) text = 'Бой начнётся с управлением с клавиатуры. Это режим отладки, камера в нём не управляет героем.';
          else if (canStart) text = 'Трекинг готов. Начинайте, когда удобно сели.';
          else if (ctx.calibrated === false) text = 'Нужна калибровка. Нажмите «Перекалибровать».';
          else if (st === 'lost') text = 'Камера не видит позу. Кнопка «В бой» станет доступна, когда трекинг восстановится.';
          else if (st === 'calibrating') text = 'Идёт калибровка.';
          else text = 'Камера ещё не готова.';
        } else if (ctx.debug) text = `Отладка: ${step ? step.keyText : ''} — шаг засчитается. Это клавиатура, а не трекинг.`;
        else if (st === 'lost') text = 'Камера не видит позу — вернитесь в кадр, чтобы были видны плечи и кисти.';
        else if (st !== 'ready' && st !== 'calibrating') text = 'Камера ещё не готова.';
        else if (input && input.valid && input.hands && input.hands.available === false) text = 'Камера не видит кистей — поднимите руки ладонями в кадр.';
        else if (v.stuck) text = 'Не выходит? Нажмите «Пропустить» — жест можно повторить позже, в бою.';
        setText(ready, text);
        setHidden(ready, !text);

        // все шаги пройдены — фокус на «В бой» (если фокус был в панели и кнопка исчезла)
        if (v.done && !wasDone) {
          const a = doc.activeElement;
          if (!a || a === doc.body || panel.contains(a)) later(() => { if (state.screen === 'tutorial' && !start.node.hidden) start.node.focus({ preventScroll: true }); }, 0);
        }
        wasDone = v.done;
      },
    };
  })();

  /* ------------------------------------------------ [ТРЕНАЖЁР] «Книга заклинаний» */
  // Поверх меню, паузы или обучения: базовые жесты тренажёра и прежние карточки «Как управлять»
  // (раздел «Продвинутые: руны, печати, лук, магия»). Esc или «Закрыть» — назад, фокус возвращается.
  const book = (() => {
    const hid = `${uid}-book-h`;
    const h = heading('h2', hid, 'Книга заклинаний', 'ao-h2');
    const close = localBtn('Закрыть', () => closeBook());
    const TABS = [['basic', 'Базовые: 4 жеста'], ['adv', 'Продвинутые: руны, печати, лук, магия']];
    const tabs = {};
    const tabList = el('div', { class: 'ao-book-tabs', role: 'tablist', 'aria-label': 'Разделы книги' });
    const basicCards = TRAINER_STEPS.map((st) => {
      const t = el('h3', { class: 'ao-h3' });
      const tip = el('p', { class: 'ao-tut-gesture' });
      const key = el('p', { class: 'ao-book-card__key', hidden: true, text: `Отладка: ${st.keyText}` });
      const node = el('article', { class: 'ao-book-card', 'data-side': st.side },
        el('div', { class: 'ao-book-card__pic', html: TRAINER_MINI[st.id] }), el('p', { class: 'ao-trn-hand', text: st.hand }), t, tip, key);
      return { st, t, tip, key, node };
    });
    // [W3-MAGIC] две карточки «ладони вместе → растянуть»
    const magicCards = STRETCH_CARDS.map((st) => {
      const key = el('p', { class: 'ao-book-card__key', hidden: true, text: `Отладка: ${st.keyText}` });
      const node = el('article', { class: 'ao-book-card', 'data-side': 'both', 'data-magic': st.id },
        el('div', { class: 'ao-book-card__pic', html: st.pic }), el('p', { class: 'ao-trn-hand', text: 'Обе руки' }),
        el('h3', { class: 'ao-h3', text: `${st.title} → ${st.effect}` }), el('p', { class: 'ao-tut-gesture', text: st.tip }), key);
      return { key, node };
    });
    const paintBasic = (moveMode, debug) => {
      for (const c of basicCards) {
        const v = c.st.stick && moveMode === 'stick' ? { ...c.st, ...c.st.stick } : c.st;
        setText(c.t, `${v.title} → ${lowerFirst(v.effect)}`);
        setText(c.tip, v.tip);
        setHidden(c.key, !debug);
      }
      for (const c of magicCards) setHidden(c.key, !debug);
    };
    paintBasic('steer', false);
    const basic = el('div', { class: 'ao-book-basic' }, basicCards.map((c) => c.node));
    const magic = el('div', { class: 'ao-book-basic ao-book-magic' }, magicCards.map((c) => c.node));
    const { grid, cards } = buildTutCards();
    const panes = {
      basic: el('div', { class: 'ao-book-pane', role: 'tabpanel', id: `${uid}-book-basic`, 'aria-labelledby': `${uid}-book-tab-basic` },
        el('p', { class: 'ao-lead', text: 'Эти жесты учит тренажёр «Научись за 60 секунд» перед боем. Их хватает, чтобы победить.' }), basic,
        el('p', { class: 'ao-lead ao-book-magic__lead', text: 'Мощная магия двух ладоней: сомкни ладони → растяни. Работает в обоих режимах.' }), magic),
      adv: el('div', { class: 'ao-book-pane', role: 'tabpanel', id: `${uid}-book-adv`, 'aria-labelledby': `${uid}-book-tab-adv`, hidden: true },
        el('p', { class: 'ao-lead', text: 'Рывок, искра, рассечение, парирование, руны ▲ ϟ ○ ★ @ ∞ ^ V ⧗ ℓ, печати двумя руками, лук и стихии.' }), grid),
    };
    for (const [key, label] of TABS) {
      const t = el('button', { type: 'button', class: 'ao-book-tab', role: 'tab', id: `${uid}-book-tab-${key}`, 'aria-controls': `${uid}-book-${key}`, 'aria-selected': key === 'basic' ? 'true' : 'false', 'data-ui-local': '', text: label });
      listen(t, 'click', () => selectTab(key));
      tabs[key] = t;
      tabList.append(t);
    }
    function selectTab(key) {
      for (const k of Object.keys(tabs)) {
        tabs[k].setAttribute('aria-selected', k === key ? 'true' : 'false');
        panes[k].hidden = k !== key;
      }
    }
    const dbgKeys = el('p', { class: 'ao-debugkeys', hidden: true, text: DEBUG_KEYS_TEXT });
    const panel = el('div', { class: 'ao-panel ao-panel--book ao-frame', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': hid },
      el('div', { class: 'ao-book-head' }, h, el('span', { class: 'ao-spacer' }), close.node),
      tabList, panes.basic, panes.adv, dbgKeys);
    const section = el('section', { class: 'ao-screen ao-screen--book', 'data-screen': 'book', hidden: true }, panel);
    let opener = null;
    let inerted = [];
    // aria-modal: Tab не уходит за книгу — остальной интерфейс (кроме объявлений и метки DEBUG) inert
    const setInert = (on) => {
      if (on) {
        inerted = Array.from(section.parentNode ? section.parentNode.children : []).filter((n) => n !== section && !n.inert && !n.classList.contains('ao-sr') && !n.classList.contains('ao-debug'));
        for (const n of inerted) n.inert = true;
      } else {
        for (const n of inerted) n.inert = false;
        inerted = [];
      }
    };
    return {
      section,
      get open() { return !section.hidden; },
      show(from) {
        if (!section.hidden) return; // уже открыта: не теряем список inert и кнопку возврата фокуса
        opener = from || doc.activeElement;
        paintBasic(state.settings && state.settings.moveMode === 'stick' ? 'stick' : 'steer', state.debug);
        selectTab('basic');
        section.hidden = false;
        setInert(true);
        announce('Книга заклинаний');
        close.node.focus({ preventScroll: true });
      },
      hide(restoreFocus = true) {
        if (section.hidden) return;
        section.hidden = true;
        setInert(false);
        const o = opener;
        opener = null;
        if (restoreFocus && o && typeof o.focus === 'function' && o.isConnected && o.getClientRects().length) o.focus({ preventScroll: true });
      },
      update(ctx) {
        if (section.hidden) return;
        setHidden(dbgKeys, !ctx.debug);
        paintBasic(ctx.settings && ctx.settings.moveMode === 'stick' ? 'stick' : 'steer', ctx.debug);
        syncTutCards(cards, ctx);
      },
    };
  })();
  function openBook(from) { book.show(from); }
  function closeBook(restoreFocus = true) { book.hide(restoreFocus); }
  listen(win, 'keydown', (e) => {
    if (disposed || e.key !== 'Escape' || !book.open) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeBook();
  }, true);

  // По умолчанию обучение — тренажёр; прежний экран карточек: ?tutorial=cards или options.tutorialCards.
  const tutorial = cfg.tutorialCards ? buildCardsTutorial() : trainer;

  /* -------------------------------------------------------------- PAUSED */

  const paused = (() => {
    const hid = `${uid}-pause-h`;
    const h = heading('h2', hid, 'Пауза', 'ao-h2');
    const lead = el('p', { class: 'ao-lead' });
    const host = el('div', { class: 'ao-slothost' });
    const status = statusLine();
    const hint = el('p', { class: 'ao-note', hidden: true });
    const resume = btn('Продолжить бой', () => invoke('onResume'), { variant: 'primary', size: 'lg' });
    // [ONBOARD] автопродолжение после потери трекинга: крупный отсчёт 3-2-1
    const countNum = el('span', { class: 'ao-countdown__num' });
    const countdown = el('div', { class: 'ao-countdown', hidden: true, 'aria-hidden': 'true' }, countNum);
    host.append(countdown);   // поверх превью: слот камеры встаёт рядом (moveSlot), отсчёт — выше по z-index
    const recal = btn('Перекалибровать', pressCalibrate);
    const restart = btn('Начать бой заново', () => invoke('onRestart'));
    const oathP = btn('Клятва героя', () => invoke('onOath', { from: 'paused' }));
    const bookP = localBtn('Книга заклинаний', (e) => openBook(e && e.currentTarget), { iconName: 'book' }); // [ТРЕНАЖЁР]
    const bookWrap = el('div', { class: 'ao-pause-book' }, bookP.node); // при потере трекинга прячется: сначала — вернуться в кадр
    const exit = btn('Выйти в меню', () => invoke('onExit'), { variant: 'quiet' });
    const dbgKeys = el('p', { class: 'ao-debugkeys', hidden: true, text: DEBUG_KEYS_TEXT });
    const panel = el(
      'div',
      { class: 'ao-panel ao-panel--pause ao-frame' },
      el('div', { class: 'ao-head' }, h, lead),
      el(
        'div',
        { class: 'ao-cols' },
        el('div', { class: 'ao-col ao-col--media' }, host, status.node, hint, bookWrap),
        el('div', { class: 'ao-col' }, el('h3', { class: 'ao-h3', text: 'Настройки' }), buildSettings(['gestureMode', 'moveMode', 'volume', 'sensitivity', 'quality', 'reducedMotion'], 'pause')),
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
    // [ONBOARD] быстрый поток: пауза из-за потери трекинга снимается сама (пауза игрока — по-прежнему кнопкой)
    const COPY_AUTO = {
      ...COPY,
      lost: ['Трекинг потерян', 'Вернитесь в кадр: плечи и кисти. Бой продолжится сам — мышь не нужна.'],
      restored: ['Трекинг восстановлен', 'Сидите ровно, руки вниз — бой продолжится сам.'],
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
        setHidden(bookWrap, variant === 'lost');
        const T = cfg.quickStart && ctx.vm.pauseReason === 'tracking' ? COPY_AUTO : COPY;
        setText(h, T[variant][0]);
        // [ONBOARD] отсчёт автопродолжения (main.js: тело снова в кадре → 3-2-1 → бой)
        const leftMs = isNum(ctx.vm.autoResumeMs) ? ctx.vm.autoResumeMs : null;
        const counting = leftMs !== null && !ctx.debug;
        const countN = counting ? Math.max(1, Math.ceil(leftMs / 1000)) : 0;
        setHidden(countdown, !counting);
        if (counting) setText(countNum, String(countN));
        setText(lead, counting ? `Вы снова в кадре — бой продолжится через ${countN}…` : T[variant][1]);
        paintStatus(status, ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg), ctx.debug ? '' : ctx.tr.message);
        // [ONBOARD] доступность «Продолжить бой» — те же условия, что у main.js; причина — на кнопке
        const gate = ctx.vm.gate && typeof ctx.vm.gate === 'object' ? ctx.vm.gate : null;
        const canResume = ctx.debug || (gate ? gate.ok === true : st === 'ready' && ctx.calibrated !== false);
        setBtn(resume, { disabled: !canResume, label: canResume || !gate || !gate.reason ? 'Продолжить бой' : gate.reason });
        let hintText = '';
        if (!canResume && !gate) {
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

  // [ТВИСТ «ОШИБКА»] блок «Техника жестов»: общая точность и сравнение с прошлым боем, столбики точности
  // по каждому жесту, три самые частые ошибки с пиктограммой «как сейчас → как надо» и советом.
  const LEGACY_RESULT_COACH = false;   // прежние строка «Точность жестов» и строка частой ошибки (выключены)
  function deltaText(d) {
    if (!isNum(d) || d === 0) return { text: d === 0 ? '= как в прошлом бою' : '', tone: 'same' };
    return { text: `${d > 0 ? '▲ +' : '▼ −'}${Math.abs(Math.round(d))}`, tone: d > 0 ? 'up' : 'down' };
  }
  function techBlock() {
    const accNum = el('strong', { class: 'ao-tech__accv', text: '—' });
    const accDelta = el('span', { class: 'ao-tech__delta' });
    const accNote = el('span', { class: 'ao-tech__note' });
    const bars = el('div', { class: 'ao-tech__bars', role: 'list' });
    const errs = el('ol', { class: 'ao-tech__errs' });
    const empty = el('p', { class: 'ao-note ao-tech__empty', hidden: true, text: 'В этом бою жесты не распознавались. Отработайте их в «Тренажёре техники» — он показывает, какое условие жеста не выполнено.' });
    const errsHead = el('h3', { class: 'ao-tech__h', text: 'Что исправить' });
    const node = el('section', { class: 'ao-tech', 'aria-label': 'Техника жестов' },
      el('div', { class: 'ao-tech__col' },
        el('h3', { class: 'ao-tech__h', text: 'Точность жестов' }),
        el('div', { class: 'ao-tech__acc' }, accNum, el('span', { class: 'ao-tech__accside' }, accDelta, accNote)),
        bars, empty),
      el('div', { class: 'ao-tech__col ao-tech__col--errs' }, errsHead, errs));
    let key = '';
    return {
      node,
      paint(c) {
        const k = c ? JSON.stringify([c.accuracy, c.good, c.mistakes, c.groups, c.top3 && c.top3.map((e) => [e.code, e.count]), c.compare]) : '';
        if (k === key) return;
        key = k;
        const has = !!c && isNum(c.accuracy);
        setText(accNum, has ? `${c.accuracy}%` : '—');
        setClass(accNum, 'is-good', has && c.accuracy >= 75);
        setClass(accNum, 'is-bad', has && c.accuracy < 50);
        const cmp = c && c.compare;
        const d = cmp ? deltaText(cmp.accuracyDelta) : { text: '', tone: 'same' };
        setText(accDelta, d.text);
        setAttr(accDelta, 'data-tone', d.tone);
        setHidden(accDelta, !d.text);
        setText(accNote, has
          ? `${c.good} из ${c.good + c.mistakes} жестов без ошибки${cmp ? ` · прошлый бой ${cmp.prevAccuracy}%` : ' · первый бой: сравнение появится в следующем'}`
          : '');
        const groups = c && Array.isArray(c.groups) ? c.groups : [];
        bars.replaceChildren(...groups.slice(0, 7).map((g) => {
          const gd = cmp && cmp.groups ? deltaText(cmp.groups[g.id]) : { text: '', tone: 'same' };
          const tone = g.accuracy >= 75 ? 'good' : g.accuracy >= 50 ? 'warn' : 'bad';
          return el('div', { class: 'ao-gbar', role: 'listitem', 'data-tone': tone, 'aria-label': `${g.title}: ${g.accuracy}%, ${g.good} из ${g.good + g.mistakes}` },
            el('span', { class: 'ao-gbar__name', text: g.title }),
            el('span', { class: 'ao-gbar__track', 'aria-hidden': 'true' }, el('span', { class: 'ao-gbar__fill', style: `width:${clamp(g.accuracy, 0, 100)}%` })),
            el('span', { class: 'ao-gbar__v', text: `${g.accuracy}%` }),
            el('span', { class: 'ao-gbar__n', text: `${g.good}/${g.good + g.mistakes}` }),
            el('span', { class: 'ao-gbar__d', 'data-tone': gd.tone, text: gd.tone === 'same' ? '' : gd.text }));
        }));
        setHidden(empty, groups.length > 0);
        const top = c && Array.isArray(c.top3) ? c.top3 : [];
        setHidden(errsHead, !top.length);
        errs.replaceChildren(...top.map((e) => {
          const g = COACH_GROUPS[e.group];
          return el('li', { class: 'ao-err' },
            el('div', { class: 'ao-err__pic', 'aria-hidden': 'true', html: hintPictogram(e.code, { width: 150, height: 64, labels: true }) }),
            el('div', { class: 'ao-err__body' },
              el('div', { class: 'ao-err__head' },
                el('strong', { class: 'ao-err__gest', text: e.gesture || (g && g.title) || '' }),
                el('span', { class: 'ao-err__count', text: `×${e.count}` })),
              el('p', { class: 'ao-err__fix', text: e.fix || '' }),
              el('p', { class: 'ao-err__text', text: e.text || '' })));
        }));
        if (!top.length && has) errs.replaceChildren(el('li', { class: 'ao-err ao-err--clean' }, el('p', { class: 'ao-err__fix', text: 'Ошибок не было — чистая техника!' })));
        setHidden(errs, !top.length && !has);
      },
    };
  }

  function resultScreen(kind) {
    const win_ = kind === 'victory';
    const hid = `${uid}-${kind}-h`;
    const h = heading('h2', hid, win_ ? 'Регент повержен' : 'Хорошая попытка!', 'ao-h1');
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
      const row = el('div', { class: 'ao-stat' }, el('dt', { class: 'ao-stat__k', text: label }), dd);
      if (key === 'accuracy' && !LEGACY_RESULT_COACH) row.hidden = true;   // точность — в блоке «Техника жестов»
      stats.append(row);
      rows[key] = dd;
    }
    const tip = el('p', { class: 'ao-tip', hidden: true });
    // [ТВИСТ «ОШИБКА»] прежняя строка «самая частая ошибка» (LEGACY_RESULT_COACH) и новый блок техники
    const coachTip = el('p', { class: 'ao-tip ao-tip--coach', hidden: true });
    const tech = techBlock();
    // [FEEL] поражение — дружелюбно: «Ещё раз» сразу, без упрёков
    const again = btn(win_ ? 'Сразиться снова' : 'Ещё раз', () => invoke('onRestart'), { variant: 'primary', size: 'lg' });
    const techR = btn('Тренажёр техники', () => invoke('onTechnique', { from: kind }));
    const oathR = btn('Клятва героя', () => invoke('onOath', { from: kind }));
    const exit = btn('В меню', () => invoke('onExit'), { variant: 'quiet' });
    const panel = el(
      'div',
      { class: `ao-panel ao-panel--result ao-panel--${kind} ao-frame ao-has-tech` },
      el('div', { class: 'ao-result__mark', html: ICONS.sigil, 'aria-hidden': 'true' }),
      h,
      summary,
      stats,
      tech.node,
      coachTip,
      tip,
      el('div', { class: 'ao-actions ao-actions--center' }, again.node, techR.node, oathR.node, exit.node),
    );
    return {
      section: screenSection(kind, panel, hid),
      heading: h,
      focus: () => again.node,
      update(ctx) {
        const s = ctx.snap;
        tech.paint(ctx.coach);
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
        if (LEGACY_RESULT_COACH && c && c.top) {
          setText(coachTip, `Чаще всего не получалось: ${c.top.gesture} (×${c.top.count}). ${c.top.text}.`);
          setHidden(coachTip, false);
        } else setHidden(coachTip, true);
        if (win_) {
          const maxHp = Math.max(1, num(p.maxHp, 1));
          setText(rows.remain, `${Math.ceil(clamp(num(p.hp), 0, maxHp))} из ${Math.round(maxHp)}`);
          setText(summary, `Победа за ${fmtClock(s.time)}. ${num(st.damageTaken) === 0 ? 'Бой без единого пропущенного удара.' : 'Обет исполнен: страж больше не поднимется.'}`);
          setHidden(tip, true);
        } else {
          const maxHp = Math.max(1e-6, num(b.maxHp, 1));
          const left = clamp(num(b.hp) / maxHp, 0, 1);
          setText(rows.remain, pct(left));
          // [FEEL] дружелюбный итог: заголовок по прогрессу, совет про «Лёгкую» сложность
          setText(h, left <= 0.5 ? 'Почти получилось!' : 'Хорошая попытка!');
          let text = `Регент устоял: у него осталось ${pct(left)} здоровья.`;
          if (b.stage === 2) text += ' Вы довели бой до второй стадии.';
          text += ctx.settings.difficulty === 'normal' ? ' На «Лёгкой» сложности (меню → Настройки) Регент на 30% слабее.' : ' Новый бой — с полным здоровьем.';
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

  /* ------------------------------------------- [ПРОЕКТОР] что распознала игра */

  // Импульсы (рывок, выброс, искра…) живут один кадр — подпись держится IMPULSE_LATCH_MS.
  function latchSide(side, text, now) { state.read[side] = { text, tone: 'fire', until: now + IMPULSE_LATCH_MS }; }
  function liveLeft(g) {
    if (!g || g.empty) return g && g.source === 'debug' ? { text: 'КЛАВИАТУРА', tone: 'off' } : { text: 'НЕ ВИДНА', tone: 'off' };
    if (g.conjure) return { text: g.conjure === 'prism' ? 'ПРИЗМА' : 'СФЕРА', tone: 'go' };
    if (g.sigilCharge > 0) return stretchRead(g);   // [W3-MAGIC]
    if (g.bowActive) return { text: 'ЛУК', tone: 'go' };
    if (g.shield) return { text: 'ЩИТ', tone: 'go' };
    const st = g.stick;
    if (st && st.engaged) {
      const turn = st.mode === 'steer' ? st.turn : st.x;
      const arrow = turn > 0.25 ? ' →' : turn < -0.25 ? ' ←' : '';
      if (st.mode === 'stick') return { text: Math.hypot(st.x, st.z) > 0.15 ? `ХОД${arrow}` : 'ДЖОЙСТИК', tone: 'go' };
      if (st.gait === 'run') return { text: `БЕГ${arrow}`, tone: 'go' };
      if (st.gait === 'walk') return { text: `ХОД${arrow}`, tone: 'go' };
      return { text: arrow ? `ПОВОРОТ${arrow}` : 'РУЛЬ', tone: 'go' };
    }
    if (g.source === 'debug' && (Math.abs(g.moveZ) > 0.15 || Math.abs(g.moveX) > 0.15)) return { text: Math.abs(g.moveX) > Math.abs(g.moveZ) ? (g.moveX > 0 ? 'ПОВОРОТ →' : 'ПОВОРОТ ←') : 'ХОД', tone: 'go' };
    const h = g.left;
    if (!h) return g.source === 'debug' ? { text: 'КЛАВИАТУРА', tone: 'off' } : { text: 'НЕ ВИДНА', tone: 'off' };
    return { text: SHAPE_RU[h.shape] || 'В КАДРЕ', tone: 'idle' };
  }
  // [W3-MAGIC] ладони сомкнуты — заряд «Врат бури» / «Столпа небес»; тянут — куда
  function stretchRead(g) {
    if (g.sigilAxis === 'h') return { text: 'ВРАТА БУРИ ←→', tone: 'go' };
    if (g.sigilAxis === 'v') return { text: 'СТОЛП НЕБЕС ↕', tone: 'go' };
    return { text: `ЛАДОНИ ВМЕСТЕ · ${Math.round(g.sigilCharge * 100)}% → РАСТЯНИ`, tone: 'go' };
  }
  function liveRight(g) {
    if (!g || g.empty) return g && g.source === 'debug' ? { text: 'КЛАВИАТУРА', tone: 'off' } : { text: 'НЕ ВИДНА', tone: 'off' };
    if (g.conjure) return { text: g.conjure === 'prism' ? 'ПРИЗМА' : 'СФЕРА', tone: 'go' };
    if (g.sigilCharge > 0) return stretchRead(g);   // [W3-MAGIC]
    if (g.spell) return { text: 'МАГИЯ: СГУСТОК', tone: 'go' };
    if (g.bowActive) return { text: g.bowDraw > 0.05 ? `ТЕТИВА ${Math.round(g.bowDraw * 100)}%` : 'ЛУК: ЩЕПОТЬ', tone: 'go' };
    if (g.attack) return { text: 'OK → ВЫСТРЕЛ', tone: 'go' };
    const h = g.right;
    if (!h) return g.source === 'debug' ? { text: 'КЛАВИАТУРА', tone: 'off' } : { text: 'НЕ ВИДНА', tone: 'off' };
    if (h.shape === 'fist') {
      const c = Math.max(h.charge, g.charge);
      return c > 0.05 ? { text: `КУЛАК · ЗАРЯД ${Math.round(c * 100)}%`, tone: c >= 0.3 ? 'go' : 'idle' } : { text: 'КУЛАК', tone: 'idle' };
    }
    if (g.drawing) return { text: 'РИСУЕТ РУНУ', tone: 'go' };
    if (h.shape === 'pinch') return { text: 'OK', tone: 'idle' };
    return { text: SHAPE_RU[h.shape] || 'В КАДРЕ', tone: 'idle' };
  }
  function computeReadout(ctx) {
    const R = state.read;
    const now = ctx.now;
    const g = normGestures(ctx.vm && ctx.vm.input);
    const fired = R.fired;
    // подписи защёлкиваются на любом экране с превью (обучение — там жюри пробует жесты), шпаргалка — только в бою
    const live = g && !g.empty && ctx.screen !== 'menu' && ctx.screen !== 'error';
    const fight = live && ctx.screen === 'playing';
    if (live) {
      if (g.parry) { latchSide('left', 'ПАРИРОВАНИЕ', now); if (fight) fired.parry = now; }
      if (g.dashDir) { latchSide('left', g.dashDir.x > 0.3 ? 'РЫВОК →' : g.dashDir.x < -0.3 ? 'РЫВОК ←' : 'РЫВОК', now); if (fight) fired.dash = now; }
      if (g.burst) { latchSide('right', 'ВЫБРОС!', now); if (g.burstBoth) latchSide('left', 'ВЫБРОС!', now); if (fight) fired.burst = now; }
      if (g.rune) latchSide('right', `РУНА ${RUNE_RU[g.rune] || g.rune.toUpperCase()}`, now);
      if (g.spark) { latchSide('right', 'ИСКРА', now); if (fight) fired.spark = now; }
      if (g.slash) latchSide('right', 'РАССЕЧЕНИЕ', now);
      if (g.sigil) { const t = `ПЕЧАТЬ ${SIGIL_RU[g.sigil] || g.sigil.toUpperCase()}`; latchSide('left', t, now); latchSide('right', t, now); if (fight && (g.sigil === 'gate' || g.sigil === 'pillar')) fired.stretch = now; }
      if (g.thrown) { latchSide('left', 'БРОСОК ЧАР', now); latchSide('right', 'БРОСОК ЧАР', now); }
      if (g.bowRelease) latchSide('right', 'ВЫСТРЕЛ ИЗ ЛУКА', now);
      if (g.spellThrow) latchSide('right', 'МАГИЯ: БРОСОК', now);
    }
    if (fight) {
      if (g.attack) fired.bolt = now;
      if (g.shield) fired.shield = now;
      if ((g.stick && g.stick.engaged && (g.stick.gait !== 'idle' || Math.abs(g.stick.turn) > 0.25 || (g.stick.mode === 'stick' && Math.hypot(g.stick.x, g.stick.z) > 0.15)))
        || (g.source === 'debug' && (Math.abs(g.moveZ) > 0.15 || Math.abs(g.moveX) > 0.15))) fired.move = now;
    }
    if (g && g.hint) {
      const key = `${g.hint.code}|${g.hint.tMs}|${g.hint.text}`;
      if (key !== R.errKey) { R.errKey = key; R.err = { ...g.hint, until: now + READ_ERR_MS }; }
    }
    if (['menu', 'error', 'victory', 'defeat', 'oath'].includes(ctx.screen)) R.err = null;
    const pick = (side, liveText) => (R[side] && now < R[side].until ? R[side] : liveText(g));
    const err = R.err && now < R.err.until ? R.err : null;
    R.view = { left: pick('left', liveLeft), right: pick('right', liveRight), err, debug: ctx.debug };
    return R.view;
  }

  // Подписи «ЛЕВАЯ: ЩИТ» / «ПРАВАЯ: OK → ВЫСТРЕЛ» и строка «ОШИБКА» — под превью в доке и в режиме презентации.
  function readoutView(extraCls = '') {
    const row = (side, label) => {
      const v = el('span', { class: 'ao-gread__v' });
      const node = el('p', { class: 'ao-gread__row', 'data-side': side, 'data-tone': 'off' }, el('span', { class: 'ao-gread__k', text: `${label}:` }), ' ', v);
      return { node, v };
    };
    const L = row('left', 'ЛЕВАЯ');
    const Rr = row('right', 'ПРАВАЯ');
    const errHead = el('span', { class: 'ao-gread__errhead' });
    const errText = el('span', { class: 'ao-gread__errtext' });
    const err = el('p', { class: 'ao-gread__err', hidden: true }, errHead, ' ', errText);
    const node = el('div', { class: `ao-gread ${extraCls}`.trim(), 'aria-hidden': 'true' }, L.node, Rr.node, err);
    return {
      node,
      paint(r) {
        if (!r) return;
        setText(L.v, r.left.text);
        setAttr(L.node, 'data-tone', r.err && r.err.side === 'left' ? 'err' : r.left.tone);
        setText(Rr.v, r.right.text);
        setAttr(Rr.node, 'data-tone', r.err && r.err.side === 'right' ? 'err' : r.right.tone);
        setHidden(err, !r.err);
        if (r.err) {
          const side = r.err.side === 'left' ? ' · левая' : r.err.side === 'right' ? ' · правая' : '';
          setText(errHead, `ОШИБКА · ${r.err.gesture || 'жест'}${side}`);
          setText(errText, r.err.text);
        }
      },
    };
  }

  // Шпаргалка боя: базовые жесты. Сработавший подсвечивается, на перезарядке и без энергии — тускнеет. Tab — скрыть.
  function cheatSheet() {
    const items = {};
    const list = el('ul', { class: 'ao-cheat__list' });
    for (const it of CHEAT_ITEMS) {
      const how = el('span', { class: 'ao-cheat__how', text: it.how });
      const time = el('span', { class: 'ao-cheat__time' });
      const fill = el('span', { class: 'ao-cheat__cd', 'aria-hidden': 'true' });
      const node = el(
        'li',
        { class: 'ao-cheat__item', 'data-key': it.key, 'data-side': it.side, 'data-state': 'ready' },
        el('span', { class: 'ao-cheat__icon', 'aria-hidden': 'true', html: GESTURE_ICONS[it.key] }),
        el('span', { class: 'ao-cheat__text' }, el('span', { class: 'ao-cheat__name', text: it.name }), how),
        time,
        fill,
      );
      items[it.key] = { node, how, time, fill, it, mode: 'steer' };
      list.append(node);
    }
    const node = el(
      'aside',
      { class: 'ao-cheat', 'aria-label': 'Шпаргалка жестов' },
      el('p', { class: 'ao-cheat__head' },
        el('span', { class: 'ao-cheat__lg' }, el('span', { class: 'ao-cheat__sw', 'data-side': 'left' }), 'левая — движение'),
        el('span', { class: 'ao-cheat__lg' }, el('span', { class: 'ao-cheat__sw', 'data-side': 'right' }), 'правая — магия')),
      list,
      el('p', { class: 'ao-cheat__foot', text: 'Tab — скрыть' }),
    );
    const pill = el('p', { class: 'ao-cheat-pill', hidden: true, text: 'Tab — шпаргалка жестов' });
    const FIRE_MS = { move: 250, shield: 250, bolt: 250, dash: IMPULSE_LATCH_MS, burst: IMPULSE_LATCH_MS, spark: IMPULSE_LATCH_MS, stretch: IMPULSE_LATCH_MS };
    const CD = { dash: 'dash', burst: 'burst', spark: 'spark' };
    return {
      node,
      pill,
      paint(ctx, energy, alive) {
        const hidden = state.cheatHidden;
        setHidden(node, hidden);
        setHidden(pill, !hidden);
        if (hidden) return;
        const fired = state.read.fired;
        const cd = (ctx.snap && ctx.snap.cooldowns) || {};
        const costs = cfg.abilityCosts;
        const moveMode = ctx.settings && ctx.settings.moveMode === 'stick' ? 'stick' : 'steer';
        for (const c of Object.values(items)) {
          const k = c.it.key;
          if (k === 'move' && c.mode !== moveMode) { c.mode = moveMode; setText(c.how, moveMode === 'stick' ? c.it.howStick : c.it.how); }
          let st = 'ready', frac = 0, tt = '';
          let rem = CD[k] ? Math.max(0, num(cd[`${CD[k]}Remaining`])) : 0;
          let tot = CD[k] ? num(cd[`${CD[k]}Total`]) : 0;
          if (k === 'stretch' && cd.sigils && cd.sigils.gate && cd.sigils.pillar) {
            // [W3-MAGIC] перезарядка — пока не готова ни одна из двух печатей
            const a = cd.sigils.gate, b = cd.sigils.pillar, first = num(a.remaining) <= num(b.remaining) ? a : b;
            rem = Math.max(0, num(first.remaining)); tot = num(first.total);
          }
          if (!alive) st = 'off';
          else if (ctx.now - num(fired[k], -1e9) < FIRE_MS[k]) st = 'active';
          else if (rem > 0.05) { st = 'cooldown'; frac = tot > 0 ? clamp(rem / tot, 0, 1) : 0; tt = rem >= 1 ? `${Math.ceil(rem)} с` : ''; }
          else if (isNum(costs[k]) && energy < costs[k]) { st = 'low'; tt = 'мало энергии'; }
          setAttr(c.node, 'data-state', st);
          setStyle(c.fill, 'transform', `scaleX(${(Math.round(frac * 100) / 100).toFixed(2)})`);
          setText(c.time, tt);
        }
      },
    };
  }

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
    // [FEEL] вспышка плитки при срабатывании (переход в «активно» или из готовности в перезарядку)
    // и короткий отблеск, когда перезарядка закончилась. CSS-анимация: «Уменьшенное движение» её гасит.
    const flashTile = (t, cls) => {
      for (const c of ['is-flash', 'is-ready']) { t.node.classList.remove(c); cancel(t[c]); t[c] = 0; } // одна вспышка за раз
      void t.node.offsetWidth; // перезапуск анимации
      t.node.classList.add(cls);
      cancel(t[cls]);
      t[cls] = later(() => t.node.classList.remove(cls), 520);
    };
    const paintTile = (t, st, cdFrac, timeText) => {
      const prev = t.state;
      if (prev && prev !== st) {
        if ((st === 'active' && prev !== 'active') || (st === 'cooldown' && (prev === 'ready' || prev === 'low'))) flashTile(t, 'is-flash');
        else if (prev === 'cooldown' && st === 'ready') flashTile(t, 'is-ready');
      }
      t.state = st;
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
    const dockRead = readoutView();   // [ПРОЕКТОР] «ЛЕВАЯ: ЩИТ» / «ПРАВАЯ: OK → ВЫСТРЕЛ» под превью
    const dock = el('div', { class: 'ao-cvdock' }, dockHost, dockRead.node, dockStatus.node);
    const cheat = cheatSheet();       // [ПРОЕКТОР] шпаргалка жестов, Tab
    const pauseBtn = btn('Пауза', () => invoke('onPause', { reason: 'user' }), { variant: 'secondary', iconName: 'pause' });
    pauseBtn.node.classList.add('ao-pausebtn');
    pauseBtn.node.setAttribute('aria-keyshortcuts', 'Escape');
    const node = el('div', { class: 'ao-hud', hidden: true }, boss, hero, cheat.node, cheat.pill, dock, pauseBtn.node);

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
          // [ПРОЕКТОР] подписи жестов и красная рамка «ОШИБКИ»
          const r = state.read.view;
          dockRead.paint(r);
          setAttr(dock, 'data-err', r && r.err ? 'on' : null);
        }
        cheat.paint(ctx, energy, alive);
        setClass(node, 'is-cheat', !state.cheatHidden);
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

  /* -------------------------------------------- [ПРОЕКТОР] режим презентации
   * Клавиша P или ?present в адресе: экран делится 40/60 — слева большая зеркальная камера со скелетом
   * и крупными подписями жестов, справа игра (html.ao-present сдвигает #ao-app и .ao-ui вправо; main.js
   * берёт размер рендера с канваса и получает событие resize). Для живого питча через проектор. */

  // в меню и на экране ошибки камера выключена — там слот паркуется, панель показывает подсказку
  const PRESENT_SCREENS = ['camera', 'calibration', 'tutorial', 'playing', 'paused', 'training', 'victory', 'defeat', 'oath'];
  const present = (() => {
    const host = el('div', { class: 'ao-slothost ao-pres__cam' });
    const read = readoutView('ao-gread--big');
    const status = statusLine();
    const idle = el('p', { class: 'ao-pres__idle' });
    const keyHint = el('span', { class: 'ao-pres__key', text: 'P — выйти' });
    const node = el(
      'aside',
      { class: 'ao-pres', 'aria-label': 'Режим презентации: камера и распознанные жесты', hidden: true },
      el('div', { class: 'ao-pres__head' }, el('span', { class: 'ao-pres__title', text: 'Что видит камера' }), keyHint),
      host,
      idle,
      read.node,
      el('p', { class: 'ao-pres__legend' },
        el('span', { class: 'ao-cheat__lg' }, el('span', { class: 'ao-cheat__sw', 'data-side': 'left' }), 'левая кисть — движение'),
        el('span', { class: 'ao-cheat__lg' }, el('span', { class: 'ao-cheat__sw', 'data-side': 'right' }), 'правая — магия')),
      status.node,
    );
    return {
      node,
      host,
      update(ctx) {
        const info = ctx.debug ? DEBUG_INFO : describeTracking(ctx.tr, cfg);
        paintStatus(status, info, ctx.debug ? '' : ctx.tr.message);
        setAttr(host, 'data-tone', info.tone);
        const shown = slot.parentNode === host;
        setHidden(idle, shown);
        if (!shown) setText(idle, CAMERA_RUNNING.includes(ctx.tr.status) ? 'Камера на паузе — превью вернётся в бою.' : 'Камера включится после «Начать» — здесь будет видно, что распознаёт игра.');
        // в бою и обучении с отладкой P — «призма» (core/debugInput.js), режим переключает Shift+P
        setText(keyHint, ctx.debug && (ctx.screen === 'playing' || ctx.screen === 'tutorial') ? 'Shift+P — выйти' : 'P — выйти');
        read.paint(state.read.view);
        setAttr(node, 'data-err', state.read.view && state.read.view.err ? 'on' : null);
      },
    };
  })();

  /* ----------------------------------------------------------- assembly */

  // [ТВИСТ «ОШИБКА»] «Тренажёр техники» (modules/techniqueTrainer.js): DOM строится помощниками этого модуля
  const technique = createTechniqueScreen({
    uid, el, btn, setBtn, listen, heading, screenSection, statusLine, paintStatus, setText, setHidden, setAttr, setClass, setStyle,
    invoke, announce, pressEnable, describe: (tr) => describeTracking(tr, cfg), cameraStarting: CAMERA_STARTING, debugInfo: DEBUG_INFO,
  });
  const screens = { menu, camera, calibration: calib, tutorial, paused, victory, defeat, error: errorScr, oath, training, technique };
  const slotHosts = { camera: camera.host, calibration: calib.host, tutorial: tutorial.host, paused: paused.host, playing: hud.dockHost, training: training.host, technique: technique.host };

  ui.append(backdrop, hud.node, banner);
  for (const scr of Object.values(screens)) ui.append(scr.section);
  ui.append(book.section); // [ТРЕНАЖЁР] «Книга заклинаний» — поверх меню, паузы и обучения
  ui.append(present.node, debugBadge, park, live, liveAlert);
  root.appendChild(ui);

  function moveSlot(screen) {
    const inPresent = state.present && PRESENT_SCREENS.includes(screen);
    const host = inPresent ? present.host : slotHosts[screen] || park;
    if (slot.parentNode !== host) host.appendChild(slot);
    // trackingHud читает режим рисунка у слота: в большой панели презентации — полный «tracking edit»
    setAttr(slot, 'data-hud-mode', inPresent ? 'full' : null);
  }

  function setPresent(on) {
    const next = !!on;
    if (state.present === next) return;
    state.present = next;
    setClass(doc.documentElement, 'ao-present', next);
    setHidden(present.node, !next);
    if (state.screen) moveSlot(state.screen);
    try { win.dispatchEvent(new win.Event('resize')); } catch (err) { /* без resize рендер подстроится на следующем изменении окна */ }
    announce(next ? 'Режим презентации включён' : 'Режим презентации выключен');
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
    if (book.open) closeBook(false);
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
    const key = `${s.quality}|${s.volume}|${s.sensitivity}|${s.reducedMotion}|${s.moveMode}|${s.hero}|${s.startZone}|${s.gestureMode}|${s.autoWalk}|${s.difficulty}|${s.muted}`; // [FOREST] + startZone, [НОВИЧОК] + жесты, [FEEL] + difficulty, [SFX] + muted
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
    technique: (ctx) => technique.update(ctx),
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
    computeReadout(ctx);   // [ПРОЕКТОР] до экранов: подписи нужны HUD и панели презентации
    UPDATERS[screen](ctx);
    book.update(ctx);
    if (state.present) present.update(ctx);
    if (state.focusPending) {
      state.focusPending = false;
      focusScreen(screen);
    }
  }

  /* ------------------------------------------------------------ keyboard */

  // [ПРОЕКТОР] Tab в бою — скрыть/показать шпаргалку; P — режим презентации (в бою с отладкой P — «призма»,
  // там режим переключает Shift+P). В полях ввода (лобби дуэли) клавиши не перехватываются.
  const typingTarget = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
  // Tab остаётся навигацией, если фокус на чужой кнопке (итоги дуэли modules/pvp.js и т. п.) или открыто окно дуэли
  const tabFree = () => {
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== doc.documentElement && !hud.node.contains(a)) return false;
    const m = doc.querySelector('.pvp-modal');
    return !(m && m.getClientRects().length);
  };
  listen(win, 'keydown', (e) => {
    if (disposed || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target)) return;
    if (e.key === 'Tab' && state.screen === 'playing' && tabFree()) {
      e.preventDefault();
      state.cheatHidden = !state.cheatHidden;
      try { win.localStorage.setItem(CHEAT_KEY, state.cheatHidden ? 'hidden' : 'shown'); } catch (err) { /* хранилище недоступно */ }
      return;
    }
    if (e.code === 'KeyP') {
      if (state.debug && !e.shiftKey && (state.screen === 'playing' || state.screen === 'tutorial')) return;
      setPresent(!state.present);
    }
  });
  try { state.cheatHidden = win.localStorage.getItem(CHEAT_KEY) === 'hidden'; } catch (err) { state.cheatHidden = false; }
  try {
    const q = new win.URLSearchParams(win.location.search);
    if (q.has('present') && !/^(0|false|off)$/i.test(q.get('present') || '')) setPresent(true);
  } catch (err) { /* без адреса — обычный режим */ }

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
    if (state.present) {
      setClass(doc.documentElement, 'ao-present', false);   // через кеш setClass: следующий экземпляр UI включит режим снова
      try { win.dispatchEvent(new win.Event('resize')); } catch (err) { /* ignore */ }
    }
    ui.remove();
  }

  return { update, dispose, cameraSlot: slot, apiVersion: API_VERSION };
}
