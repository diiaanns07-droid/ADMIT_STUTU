// ASHEN OATH — режим «ОШИБКА» (твист хакатона): тексты подсказок, пиктограммы и статистика точности жестов.
// Чистая логика: без DOM. Коды подсказок выдаёт core/handGestures.js в тот момент, когда жест почти
// получился, но что-то конкретное не так (кольцо не замкнуто, ладонь боком, руна не замкнута, взмах
// медленный…). Здесь коду сопоставляется жест и конкретное исправление, а также:
//  - hand / landmarks / links / mark — какая рука и какие точки кисти MediaPipe (0..20) подсветить на
//    превью камеры, какие соединить линией и короткая метка у них («СОМКНИ»);
//  - fix — короткое исправление для заголовка карточки, pictogram — id пиктограммы «как сейчас → как надо»
//    (core/coachPictograms.js), group — к какому жесту относится ошибка (точность по жестам на экране итогов).
//
// getActiveHint() — подсказка, которая сейчас на экране: { code, hand, landmarks, links, mark, text, fix,
// gesture, pictogram (SVG-строка), pictogramId, side, tMs, ageMs, life }. Её читают слой подсветки точек на
// превью камеры и карточка в бою; main.js сообщает новые подсказки через noteHint().
//
// createCoachStats() копит удачные жесты и ошибки за бой → summary() для экрана итогов: общая точность,
// точность по каждому жесту, три самые частые ошибки с советами. createCoachHistory(storage) хранит итоги
// прошлых боёв (localStorage) для сравнения «было → стало».

import { pictogramSvg } from './coachPictograms.js';

// Жесты, по которым считается точность. success — импульсы распознавателя, засчитанные как удача
// (attack и shield — начало удержания «OK» и щита). Кадр и движение — не «жесты-заклинания»: их ошибки
// попадают в топ ошибок, но столбиков точности у них нет (bars: false).
export const COACH_GROUPS = Object.freeze({
  ok:     Object.freeze({ id: 'ok', title: '«OK» · снаряд', short: '«OK»', success: Object.freeze(['attack']), bars: true }),
  shield: Object.freeze({ id: 'shield', title: 'Щит', short: 'Щит', success: Object.freeze(['shield']), bars: true }),
  spark:  Object.freeze({ id: 'spark', title: 'Искра', short: 'Искра', success: Object.freeze(['spark']), bars: true }),
  burst:  Object.freeze({ id: 'burst', title: 'Выброс', short: 'Выброс', success: Object.freeze(['burst']), bars: true }),
  slash:  Object.freeze({ id: 'slash', title: 'Рассечение', short: 'Взмах', success: Object.freeze(['slash']), bars: true }),
  parry:  Object.freeze({ id: 'parry', title: 'Парирование', short: 'Парир.', success: Object.freeze(['parry']), bars: true }),
  rune:   Object.freeze({ id: 'rune', title: 'Руны', short: 'Руны', success: Object.freeze(['rune']), bars: true }),
  orb:    Object.freeze({ id: 'orb', title: 'Сфера и призма', short: 'Сфера', success: Object.freeze(['throw']), bars: true }),
  sigil:  Object.freeze({ id: 'sigil', title: 'Печати', short: 'Печати', success: Object.freeze(['sigil']), bars: true }),
  bow:    Object.freeze({ id: 'bow', title: 'Лук', short: 'Лук', success: Object.freeze(['bow']), bars: true }),
  spell:  Object.freeze({ id: 'spell', title: 'Магия рукой', short: 'Магия', success: Object.freeze(['hand_spell']), bars: true }),
  move:   Object.freeze({ id: 'move', title: 'Движение («Руль»)', short: 'Руль', success: Object.freeze([]), bars: false }),
  frame:  Object.freeze({ id: 'frame', title: 'Кадр', short: 'Кадр', success: Object.freeze([]), bars: false }),
});

// Точки кисти MediaPipe: 0 запястье, 4 кончик большого, 8 указательного, 12 среднего, 16 безымянного, 20 мизинца.
const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 17];
const PALM_LINKS = [[0, 5], [5, 17], [17, 0]];
// h(group, hand, gesture, text, fix, mark, landmarks, links) — запись подсказки; pictogram — сам код.
function h(group, hand, gesture, text, fix, mark, landmarks = [], links = []) {
  return { group, hand, gesture, text, fix, mark, landmarks: Object.freeze(landmarks.slice()), links: Object.freeze(links.map((l) => Object.freeze(l.slice()))) };
}

const RAW_HINTS = {
  // кадр и трекинг
  hand_edge:     h('frame', null, 'Кадр', 'Кисть у края кадра — держи руки ближе к центру, иначе камера теряет пальцы', 'Руки ближе к центру', 'К ЦЕНТРУ', [0, 9]),
  hand_far:      h('frame', null, 'Кадр', 'Кисти слишком мелкие — сядь ближе к камере, примерно на метр', 'Сядь ближе к камере', 'БЛИЖЕ', PALM, PALM_LINKS),
  hand_far_stand: h('frame', null, 'Кадр', 'Кисти слишком мелкие — подойди ближе к камере, стоя примерно на два шага', 'Подойди ближе', 'БЛИЖЕ', PALM, PALM_LINKS), // [СТОЯ]
  hands_missing: h('frame', 'both', 'Кадр', 'Камера не видит кистей — подними руки на уровень плеч, ладонями в кадр', 'Руки — в кадр', 'РУКИ В КАДР'),
  // движение: схема «Руль» (левая рука; core/steerStick.js)
  steer_low:     h('move', 'left', 'Руль · ход', 'Рука слишком низко — подними левую руку до груди, чтобы идти', 'Левую руку — до груди', 'ВЫШЕ', [0, 9]),
  steer_lean:    h('move', 'left', 'Руль · поворот', 'Поворачивай, отводя левую руку в сторону, а не наклоняя корпус', 'Поворот — рукой вбок', 'РУКОЙ ВБОК', [0, 9]),
  // правая рука
  ok_ring_open:  h('ok', 'right', '«OK» · снаряд', 'Сомкни кончики большого и указательного в кольцо', 'Сомкни кольцо', 'СОМКНИ', [4, 8], [[4, 8]]),
  ok_fingers:    h('ok', 'right', '«OK» · снаряд', 'Выпрями средний, безымянный и мизинец — у «OK» они торчат вверх', 'Три пальца — вверх', 'ВЫПРЯМИ', [12, 16, 20], [[10, 12], [14, 16], [18, 20]]),
  spark_one:     h('spark', 'right', 'Искра', 'Из кулака выпрямляй только указательный — средний держи согнутым', 'Только указательный', 'СОГНИ', [12, 8], [[10, 12]]),
  slash_slow:    h('slash', 'right', 'Рассечение', 'Взмахни ребром ладони резче — медленный взмах не рубит', 'Взмах резче', 'РЕЗЧЕ', [5, 17], [[5, 17]]),
  burst_short:   h('burst', 'right', 'Выброс', 'Подержи кулак дольше (≈0,5 с), пока кольцо заряда не станет красным', 'Держи кулак дольше', 'ДЕРЖИ', TIPS),
  burst_slow:    h('burst', 'right', 'Выброс', 'Раскрывай кулак резко — все пальцы разом, а не по одному', 'Раскрой резко', 'РЕЗЧЕ', TIPS),
  // левая рука
  shield_palm:   h('shield', 'left', 'Щит', 'Разверни левую ладонь к камере — щит держится только ладонью вперёд', 'Ладонь — к камере', 'РАЗВЕРНИ', PALM, PALM_LINKS),
  shield_push:   h('shield', 'left', 'Щит', 'Резко толкни левую ладонь к камере сантиметров на 20 — просто поднятая ладонь щит не ставит', 'Толкни ладонь к камере', 'ТОЛКНИ', [0, 9], [[0, 9]]),
  parry_palm:    h('parry', 'left', 'Парирование', 'Раскрывай левый кулак ладонью к камере, а не вбок', 'Ладонь — к камере', 'РАЗВЕРНИ', PALM, PALM_LINKS),
  parry_slow:    h('parry', 'left', 'Парирование', 'Раскрывай левый кулак быстрее — окно парирования всего 0,2 с', 'Раскрой быстрее', 'БЫСТРЕЕ', TIPS),
  // руны
  rune_small:    h('rune', 'right', 'Руна', 'Руна слишком маленькая — рисуй крупнее, размером с голову', 'Рисуй крупнее', 'КРУПНЕЕ', [8]),
  rune_fast:     h('rune', 'right', 'Руна', 'Рисуй медленнее — камера не успевает увидеть форму', 'Рисуй медленнее', 'МЕДЛЕННЕЕ', [8]),
  rune_long:     h('rune', 'right', 'Руна', 'Штрих затянулся — закончив фигуру, замри пальцем на полсекунды', 'В конце — замри', 'ЗАМРИ', [8]),
  rune_line:     h('rune', 'right', 'Руна', 'Это прямая линия — рисуй фигуру: ▲ треугольник, ϟ зигзаг или ○ круг', 'Рисуй фигуру', 'ФИГУРУ', [8]),
  rune_open:     h('rune', 'right', 'Руна', 'Фигура не замкнута — верни палец в точку, откуда начал', 'Замкни фигуру', 'ЗАМКНИ', [8]),
  rune_corners:  h('rune', 'right', 'Руна ▲', 'Похоже на треугольник, но углы скруглены — делай три чётких угла', 'Три чётких угла', 'УГЛЫ', [8]),
  rune_zigzag:   h('rune', 'right', 'Руна ϟ', 'Похоже на молнию — сделай 2–3 резких излома и не замыкай', 'Резкие изломы', 'ИЗЛОМЫ', [8]),
  rune_round:    h('rune', 'right', 'Руна ○', 'Похоже на круг — веди палец плавно, без углов', 'Плавно, без углов', 'ПЛАВНО', [8]),
  rune_near:     h('rune', 'right', 'Руна', 'Почти получилось — повтори фигуру чётче и крупнее, одним движением, и замри в конце', 'Чётче и крупнее', 'ЧЁТЧЕ', [8]),
  rune_unclear:  h('rune', 'right', 'Руна', 'Форма не читается — рисуй одним движением, крупно, и замри в конце', 'Одним движением', 'ЧЁТЧЕ', [8]),
  // двумя руками
  orb_facing:    h('orb', 'both', 'Сфера', 'Поверни ладони друг к другу, будто держишь мяч', 'Ладони — друг к другу', 'ДРУГ К ДРУГУ', PALM, PALM_LINKS),
  orb_dy:        h('orb', 'both', 'Сфера', 'Выровняй руки по высоте — сейчас одна заметно выше другой', 'Руки на одну высоту', 'ВЫРОВНЯЙ', [0, 9], [[0, 9]]),
  orb_far:       h('orb', 'both', 'Сфера', 'Руки слишком широко — сведи их примерно на ширину плеч', 'Сведи руки', 'БЛИЖЕ', [0, 9], [[0, 9]]),
  prism_tips:    h('orb', 'both', 'Призма', 'Соедини кончики больших и кончики указательных — получится треугольник', 'Соедини кончики', 'СОЕДИНИ', [4, 8], [[4, 8]]),
  throw_weak:    h('orb', 'both', 'Бросок чар', 'Толкни ладони к камере резче и дальше', 'Толчок резче', 'РЕЗЧЕ', [9]),
  throw_hold:    h('orb', 'both', 'Бросок чар', 'Чары заряжены — толкни ладони к камере или резко махни в сторону', 'Бросай!', 'БРОСАЙ', [9]),
  gate_slow:     h('sigil', 'both', 'Врата', 'Разводи ладони резче — «Врата» открываются рывком в стороны', 'Разводи резче', 'РЕЗЧЕ', [9]),
  gate_horiz:    h('sigil', 'both', 'Врата', 'Разводи ладони в стороны по горизонтали, а не вверх-вниз', 'В стороны, не вверх', 'В СТОРОНЫ', [9]),
  frame_diag:    h('sigil', 'both', 'Рамка', 'Поставь «Г»-рамку по диагонали: одна рука выше, другая ниже', 'Руки по диагонали', 'ДИАГОНАЛЬ', [4, 8], [[4, 8]]),
  // [HAND] лук (core/bowGesture.js) и магия рукой (core/handMagic.js)
  bow_fist:      h('bow', 'left', 'Лук', 'Сожми левую руку в кулак, как будто держишь лук', 'Левая — в кулак', 'КУЛАК', [8, 12, 16, 20]),
  bow_pinch:     h('bow', 'right', 'Лук', 'Сведи большой и указательный в щепоть у левого кулака', 'Щепоть у кулака', 'ЩЕПОТЬ', [4, 8], [[4, 8]]),
  bow_draw:      h('bow', 'right', 'Лук', 'Тяни правую руку назад к уху', 'Тяни к уху', 'ТЯНИ', [0, 9]),
  bow_release:   h('bow', 'right', 'Лук', 'Отпусти стрелу — разожми пальцы', 'Разожми пальцы', 'ОТПУСТИ', [4, 8], [[4, 8]]),
  bow_low:       h('bow', 'left', 'Лук', 'Подними левый кулак до груди или плеча', 'Кулак — до груди', 'ВЫШЕ', [0, 9]),
  bow_forward:   h('bow', 'left', 'Лук', 'Вытяни левый кулак вперёд, к камере — как будто держишь лук', 'Кулак — к камере', 'ВПЕРЁД', [0, 9]),
  spell_throw_weak: h('spell', 'right', 'Магия рукой', 'Бросай резче — толкни ладонь к камере или махни в сторону', 'Бросай резче', 'РЕЗЧЕ', [0, 9]),
  spell_hold:    h('spell', 'right', 'Магия рукой', 'Сгусток готов — брось его резким движением ладони', 'Бросай!', 'БРОСАЙ', [0, 9]),
  spell_palm:    h('spell', 'right', 'Магия рукой', 'Разверни ладонь вверх — в ней родится огненный сгусток', 'Ладонь — вверх', 'ЛАДОНЬ ВВЕРХ', PALM, PALM_LINKS),
  // [W3-MAGIC] «ладони вместе → растянуть»: в стороны — «Врата бури», вверх-вниз — «Столп небес»
  stretch_slow:  h('sigil', 'both', 'Врата · Столп', 'Растягивай ладони резче — рывком, за полсекунды', 'Растяни резче', 'РЕЗЧЕ', [9]),
  stretch_open:  h('sigil', 'both', 'Врата · Столп', 'Сначала сомкни ладони вплотную и подержи полсекунды, потом растягивай', 'Сомкни ладони', 'СОМКНИ', [9]),
  stretch_diag:  h('sigil', 'both', 'Врата · Столп', 'Тяни ровно: в стороны — «Врата бури», вверх-вниз — «Столп небес», не по диагонали', 'В стороны или вверх-вниз', 'РОВНО', [9]),
};
export const COACH_HINTS = Object.freeze(Object.fromEntries(
  Object.entries(RAW_HINTS).map(([code, e]) => [code, Object.freeze({ ...e, pictogram: code })]),
));

export function hintInfo(code) {
  return COACH_HINTS[code] || null;
}

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clock = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// SVG пиктограммы по коду: строится один раз (getActiveHint читается каждый кадр).
const svgCache = new Map();
export function hintPictogram(code, opts) {
  const e = COACH_HINTS[code];
  if (!e) return '';
  const key = opts ? `${code}|${opts.width}|${opts.height}|${opts.labels}|${opts.only}` : code;
  let s = svgCache.get(key);
  if (s === undefined) {
    try { s = pictogramSvg(e.pictogram, opts) || ''; } catch (err) { s = ''; }
    if (svgCache.size > 400) svgCache.clear();
    svgCache.set(key, s);
  }
  return s;
}

// ───────── подсказка «сейчас на экране» ─────────
export const HINT_SHOW_MS = 4200;   // столько живёт карточка в бою (core/battleHud.js COACH_DUR)

// Какая рука: сторона из распознавателя (side) точнее записи (у кадра — любая из двух).
function describe(hint, ageMs, showMs) {
  const e = COACH_HINTS[hint.code];
  const side = hint.side === 'left' || hint.side === 'right' ? hint.side : null;
  return {
    code: hint.code,
    hand: side || e.hand || 'both',
    landmarks: e.landmarks, links: e.links, mark: e.mark,
    text: e.text, fix: e.fix, gesture: e.gesture, group: e.group,
    pictogram: hintPictogram(hint.code), pictogramId: e.pictogram,
    side, guess: hint.guess || null,
    tMs: fin(hint.tMs) ? hint.tMs : null,
    ageMs: Math.max(0, ageMs),
    life: Math.max(0, Math.min(1, 1 - ageMs / showMs)),
  };
}

export function createHintTracker({ showMs = HINT_SHOW_MS } = {}) {
  let cur = null;   // { key, hint, at }
  return {
    // Новая подсказка (повтор того же импульса — та же метка tMs — не продлевает показ).
    note(hint, nowMs = clock()) {
      if (!hint || typeof hint !== 'object' || !COACH_HINTS[hint.code]) return false;
      const key = `${hint.code}|${fin(hint.tMs) ? hint.tMs : ''}`;
      if (cur && cur.key === key) return false;
      cur = { key, hint: { code: hint.code, side: hint.side || null, guess: hint.guess || null, tMs: hint.tMs }, at: fin(nowMs) ? nowMs : clock() };
      return true;
    },
    active(nowMs = clock()) {
      if (!cur) return null;
      const age = (fin(nowMs) ? nowMs : clock()) - cur.at;
      if (age < 0 || age > showMs) return null;
      return describe(cur.hint, age, showMs);
    },
    clear() { cur = null; },
  };
}

// Общий трекер игры: main.js зовёт noteHint() на каждую подсказку распознавателя,
// слой подсветки на превью камеры и карточка в бою читают getActiveHint().
const sharedTracker = createHintTracker();
export function noteHint(hint, nowMs) { return sharedTracker.note(hint, nowMs); }
export function getActiveHint(nowMs) { return sharedTracker.active(nowMs); }
export function clearActiveHint() { sharedTracker.clear(); }

// ───────── статистика боя ─────────
// Какому жесту засчитывать удачу по импульсу распознавателя.
const SUCCESS_KINDS = ['burst', 'rune', 'spark', 'slash', 'parry', 'throw', 'sigil', 'shield', 'attack', 'bow', 'hand_spell']; // [HAND] +bow, hand_spell
const KIND_GROUP = {};
for (const g of Object.values(COACH_GROUPS)) for (const k of g.success) KIND_GROUP[k] = g.id;

export function createCoachStats() {
  let good = 0, bad = 0;
  const byCode = {};
  const byGood = {};
  return {
    success(kind) {
      if (!SUCCESS_KINDS.includes(kind)) return;
      good++;
      byGood[kind] = (byGood[kind] || 0) + 1;
    },
    mistake(code) {
      if (!COACH_HINTS[code]) return;
      bad++;
      byCode[code] = (byCode[code] || 0) + 1;
    },
    reset() { good = 0; bad = 0; for (const k of Object.keys(byCode)) delete byCode[k]; for (const k of Object.keys(byGood)) delete byGood[k]; },
    summary() {
      const total = good + bad;
      // ошибки по частоте; при равенстве — та, что относится к жесту-заклинанию, выше кадра и движения
      const ranked = Object.entries(byCode)
        .map(([code, n]) => ({ code, count: n, ...COACH_HINTS[code] }))
        .sort((a, b) => b.count - a.count || (COACH_GROUPS[b.group].bars ? 1 : 0) - (COACH_GROUPS[a.group].bars ? 1 : 0));
      // точность по жестам: удачи жеста / (удачи + его ошибки); только жесты, которые пробовали
      const groups = [];
      for (const g of Object.values(COACH_GROUPS)) {
        if (!g.bars) continue;
        let gGood = 0, gBad = 0;
        for (const k of g.success) gGood += byGood[k] || 0;
        for (const [code, n] of Object.entries(byCode)) if (COACH_HINTS[code].group === g.id) gBad += n;
        if (gGood + gBad === 0) continue;
        groups.push({ id: g.id, title: g.title, short: g.short, good: gGood, mistakes: gBad, accuracy: Math.round((gGood / (gGood + gBad)) * 100) });
      }
      groups.sort((a, b) => (b.good + b.mistakes) - (a.good + a.mistakes) || a.accuracy - b.accuracy);
      return {
        good, mistakes: bad,
        accuracy: total ? Math.round((good / total) * 100) : null,
        top: ranked[0] || null,
        top3: ranked.slice(0, 3),
        groups,
        byCode: { ...byCode }, byGood: { ...byGood },
      };
    },
  };
}

// ───────── прошлые бои (для сравнения на экране итогов) ─────────
export const COACH_HISTORY_KEY = 'ashen-oath.coach.v1';
const HISTORY_MAX = 12;

// Компактный итог боя для хранения: общая точность, точность по жестам, частая ошибка.
export function compactSummary(s, tMs) {
  if (!s || typeof s !== 'object') return null;
  const groups = {};
  for (const g of Array.isArray(s.groups) ? s.groups : []) if (g && COACH_GROUPS[g.id] && fin(g.accuracy)) groups[g.id] = g.accuracy;
  return {
    t: fin(tMs) ? Math.round(tMs) : null,
    accuracy: fin(s.accuracy) ? s.accuracy : null,
    good: fin(s.good) ? s.good : 0,
    mistakes: fin(s.mistakes) ? s.mistakes : 0,
    groups,
    top: s.top && COACH_HINTS[s.top.code] ? s.top.code : null,
  };
}

// storage — localStorage или любой объект с getItem/setItem; ошибки хранилища (приватный режим) не бросаются.
export function createCoachHistory(storage, { key = COACH_HISTORY_KEY, max = HISTORY_MAX } = {}) {
  function list() {
    try {
      const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
    } catch (e) { return []; }
  }
  return {
    list,
    last() { const l = list(); return l.length ? l[l.length - 1] : null; },
    // Сохраняет итог боя; возвращает предыдущий бой (для сравнения) или null. Пустой бой (ни одного жеста) не пишется.
    push(summary, tMs) {
      const l = list();
      const prev = l.length ? l[l.length - 1] : null;
      const c = compactSummary(summary, tMs);
      if (!c || c.good + c.mistakes === 0) return prev;
      l.push(c);
      while (l.length > max) l.shift();
      try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, JSON.stringify(l)); } catch (e) { /* хранилище недоступно */ }
      return prev;
    },
    clear() { try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key); } catch (e) { /* ignore */ } },
  };
}

// Сравнение с прошлым боем: изменение общей точности и точности каждого жеста (в процентных пунктах).
export function compareCoach(cur, prev) {
  if (!cur || !prev || !fin(cur.accuracy) || !fin(prev.accuracy)) return null;
  const groups = {};
  const pg = prev.groups && typeof prev.groups === 'object' ? prev.groups : {};
  for (const g of Array.isArray(cur.groups) ? cur.groups : []) if (g && fin(g.accuracy) && fin(pg[g.id])) groups[g.id] = g.accuracy - pg[g.id];
  return { accuracyDelta: cur.accuracy - prev.accuracy, prevAccuracy: prev.accuracy, groups, prevTop: prev.top || null };
}
