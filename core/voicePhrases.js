// ASHEN OATH — что говорит голос тренера (modules/voiceCoach.js). Чистые данные и функции: без DOM и без речи.
// Жюри сидит в 3–5 м от проектора и мелкий текст не прочитает, поэтому каждая подсказка «ОШИБКА» звучит вслух
// короткой командой на 2–4 слова: «Сомкни кольцо!», «Ладонь к камере!», «Колени наружу!».
// Тексты карточек (core/gestureCoach.js COACH_HINTS, core/squatCounter.js SQUAT_HINTS, core/pushupCounter.js
// PUSHUP_FAULTS) здесь не меняются — у голоса своя, более короткая формулировка того же исправления.
//
// hintPhrase(hint) — фраза для подсказки боя и обучения. Порядок поиска: своя фраза кода → короткое
// исправление fix из записи подсказки (новые коды других модулей) → фраза по группе жеста (или по префиксу
// кода: «pillar_…» — печать) → общая «Ещё раз, чётче!». Ничего не молчит и не падает.
// trainPhrase(exercise, code) — ошибка повтора на тренировке; countWord(n) — «раз», «два», «три»…;
// setSummary(good, total) — итог подхода: «Восемь из десяти!».
// ANNOUNCER — реплики диктора на ключевые моменты; SIGIL_PHRASES — печати, ULT_PHRASES — ультимейт.

// ───────── подсказки боя и обучения: код → фраза ─────────
export const HINT_PHRASES = Object.freeze({
  // кадр и трекинг
  hand_edge: 'Руки к центру!',
  hand_far: 'Сядь ближе к камере!',
  hand_far_stand: 'Подойди ближе!',
  hands_missing: 'Руки в кадр!',
  // движение: «Руль»
  steer_low: 'Левую руку выше!',
  steer_lean: 'Поворот рукой вбок!',
  // правая рука
  ok_ring_open: 'Сомкни кольцо!',
  ok_fingers: 'Три пальца вверх!',
  spark_one: 'Только указательный!',
  slash_slow: 'Взмах резче!',
  burst_short: 'Держи кулак дольше!',
  burst_slow: 'Раскрой кулак резко!',
  // левая рука
  shield_palm: 'Ладонь к камере!',
  shield_push: 'Толкни ладонь вперёд!',
  parry_palm: 'Раскрой ладонь к камере!',
  parry_slow: 'Раскрой быстрее!',
  // руны
  rune_small: 'Рисуй крупнее!',
  rune_fast: 'Рисуй медленнее!',
  rune_long: 'В конце замри!',
  rune_line: 'Рисуй фигуру!',
  rune_open: 'Замкни фигуру!',
  rune_corners: 'Три чётких угла!',
  rune_zigzag: 'Резкие изломы!',
  rune_round: 'Плавно, без углов!',
  rune_near: 'Почти! Чётче!',
  rune_unclear: 'Одним движением!',
  // двумя руками
  orb_facing: 'Ладони друг к другу!',
  orb_dy: 'Руки на одну высоту!',
  orb_far: 'Сведи руки!',
  prism_tips: 'Соедини кончики пальцев!',
  throw_weak: 'Толкай резче!',
  throw_hold: 'Бросай чары!',
  gate_slow: 'Разводи резче!',
  gate_horiz: 'Разводи в стороны!',
  frame_diag: 'Руки по диагонали!',
  // лук и магия рукой
  bow_fist: 'Левую руку в кулак!',
  bow_pinch: 'Щепоть у кулака!',
  bow_draw: 'Тяни к уху!',
  bow_release: 'Отпускай стрелу!',
  bow_low: 'Кулак до груди!',
  bow_forward: 'Кулак к камере!',
  spell_throw_weak: 'Бросай резче!',
  spell_hold: 'Бросай сгусток!',
  spell_palm: 'Ладонь вверх!',
  // [W3-MAGIC] «ладони вместе → растянуть»
  stretch_slow: 'Растягивай резче!',
  stretch_open: 'Сомкни ладони!',
  stretch_diag: 'Тяни ровно!',
  // [W3-ULT] «Небесный суд»
  ult_one_hand: 'Подними обе руки!',
  ult_early: 'Держи руки вверху!',
});

// Запасная фраза по группе жеста (COACH_GROUPS) — для кодов, которых в таблице нет.
export const GROUP_PHRASES = Object.freeze({
  ok: 'Сомкни кольцо чётче!',
  shield: 'Ладонь к камере!',
  spark: 'Только указательный!',
  burst: 'Сожми кулак и раскрой!',
  slash: 'Взмах резче!',
  parry: 'Раскрой ладонь быстрее!',
  rune: 'Рисуй крупно и чётко!',
  orb: 'Ладони друг к другу!',
  sigil: 'Обе руки резче!',
  bow: 'Тяни тетиву к уху!',
  spell: 'Ладонь вверх и бросай!',
  move: 'Левую руку до груди!',
  frame: 'Руки в кадр!',
  ult: 'Подними обе руки!',
});
export const GENERIC_PHRASE = 'Ещё раз, чётче!';

// Группа по префиксу кода — если подсказка пришла без записи (код новой фишки, о которой тренер не знает).
const PREFIX_GROUP = Object.freeze({
  ok: 'ok', shield: 'shield', spark: 'spark', burst: 'burst', fist: 'burst', slash: 'slash', parry: 'parry',
  rune: 'rune', orb: 'orb', prism: 'orb', throw: 'orb', sphere: 'orb',
  gate: 'sigil', frame: 'sigil', sigil: 'sigil', pillar: 'sigil', clap: 'sigil', delta: 'sigil', cor: 'sigil',
  bow: 'bow', arrow: 'bow', spell: 'spell', palm: 'spell', steer: 'move', move: 'move', walk: 'move',
  hand: 'frame', hands: 'frame', cam: 'frame', camera: 'frame',
  ult: 'ult', ultimate: 'ult', sky: 'ult', heaven: 'ult', judgement: 'ult', judgment: 'ult',
});

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
// Короткое исправление из записи подсказки годится как фраза, если оно действительно короткое.
function shortFix(fix) {
  if (typeof fix !== 'string') return null;
  const s = fix.replace(/[«»"]/g, '').replace(/\s*[—–-]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || words(s) > 4 || s.length > 32) return null;
  return /[!?.…]$/.test(s) ? s : `${s}!`;
}

export function groupOfCode(code) {
  if (typeof code !== 'string' || !code) return null;
  const head = code.toLowerCase().split(/[_\-.:]/)[0];
  return PREFIX_GROUP[head] || null;
}

// hint — { code, group?, fix? } (input.hint после обогащения записью COACH_HINTS) или строка-код.
export function hintPhrase(hint) {
  const h = typeof hint === 'string' ? { code: hint } : (hint && typeof hint === 'object' ? hint : {});
  const code = typeof h.code === 'string' ? h.code : '';
  if (code && Object.prototype.hasOwnProperty.call(HINT_PHRASES, code)) return HINT_PHRASES[code];
  const fix = shortFix(h.fix);
  if (fix) return fix;
  const g = (typeof h.group === 'string' && GROUP_PHRASES[h.group] ? h.group : null) || groupOfCode(code);
  if (g && GROUP_PHRASES[g]) return GROUP_PHRASES[g];
  return GENERIC_PHRASE;
}

// ───────── тренировка: ошибки повтора ─────────
export const TRAIN_PHRASES = Object.freeze({
  squats: Object.freeze({
    shallow: 'Ниже! До параллели!',
    valgus: 'Колени наружу!',
    knees_forward: 'Таз назад!',
    lean: 'Грудь выше!',
    fast: 'Медленнее вниз!',
    heels: 'Пятки в пол!',
    lockout: 'Выпрямись полностью!',
    frame: 'Отойди от камеры!',
  }),
  pushups: Object.freeze({
    shallow: 'Ниже!',
    fast: 'Медленнее, до конца!',
    slow: 'Не застревай внизу!',
    hands: 'Кисти на пол!',
    sag: 'Напряги пресс!',
    pike: 'Опусти таз!',
  }),
});
const TRAIN_GENERIC = 'Следи за техникой!';

export function trainPhrase(exercise, code) {
  const t = TRAIN_PHRASES[exercise === 'squats' ? 'squats' : 'pushups'];
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(t, code)) return t[code];
  const other = TRAIN_PHRASES[exercise === 'squats' ? 'pushups' : 'squats'];
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(other, code)) return other[code];
  return TRAIN_GENERIC;
}

// ───────── диктор ─────────
export const ANNOUNCER = Object.freeze({
  recognized: 'Распознано!',
  barrier: 'Барьер разбит!',
  enraged: 'Регент в ярости!',
  finish: 'Добей его!',
  victory: 'Победа!',
  defeat: 'Регент устоял!',
  record: 'Новый рекорд!',
  countdown: 'Три, два, один!',
  fight: 'В бой!',
  roundWin: 'Раунд твой!',
  roundLose: 'Раунд проигран!',
  matchLose: 'Соперник победил!',   // дуэль: там нет Регента
  voiceOn: 'Голос тренера включён',
});
// Печати двумя руками (событие 'sigil_cast', data.sigil): новые «Врата бури» и «Столп небес».
export const SIGIL_PHRASES = Object.freeze({
  gate: 'Врата бури!',
  pillar: 'Столп небес!',
});
// Ультимейт: подсказка «как вызвать» и сам удар.
export const ULT_PHRASES = Object.freeze({
  ready: 'Подними обе руки!',
  cast: 'Небесный суд!',
});

// ───────── числа по-русски ─────────
const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
// родительный падеж: «восемь из десяти», «из двадцати одного»
const UNITS_GEN = ['ноля', 'одного', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти',
  'десяти', 'одиннадцати', 'двенадцати', 'тринадцати', 'четырнадцати', 'пятнадцати', 'шестнадцати', 'семнадцати', 'восемнадцати', 'девятнадцати'];
const TENS_GEN = ['', '', 'двадцати', 'тридцати', 'сорока', 'пятидесяти', 'шестидесяти', 'семидесяти', 'восьмидесяти', 'девяноста'];
const HUNDREDS_GEN = ['', 'ста', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];

function spell(n, U, T, H) {
  n = Math.max(0, Math.min(999, Math.floor(n)));
  if (n < 20) return U[n];
  const out = [];
  const h = Math.floor(n / 100), rest = n % 100;
  if (h) out.push(H[h]);
  if (rest >= 20) { out.push(T[Math.floor(rest / 10)]); if (rest % 10) out.push(U[rest % 10]); }
  else if (rest > 0) out.push(U[rest]);
  return out.join(' ');
}
const okNum = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function numberWord(n) { return okNum(n) ? spell(n, UNITS, TENS, HUNDREDS) : ''; }
export function numberGenitive(n) { return okNum(n) ? spell(n, UNITS_GEN, TENS_GEN, HUNDREDS_GEN) : ''; }

// Счёт повторов вслух: «раз», «два», «три»… (1 — «раз», как считают на тренировке).
export function countWord(n) {
  if (!okNum(n) || n < 1) return '';
  const s = n === 1 ? 'раз' : numberWord(n);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Итог подхода: «Восемь из десяти!»; все чистые — «Десять из десяти! Чисто!».
export function setSummary(good, total) {
  if (!okNum(good) || !okNum(total) || total < 1) return '';
  const g = Math.min(Math.floor(good), Math.floor(total));
  const s = `${numberWord(g)} из ${numberGenitive(Math.floor(total))}`;
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}!${g === Math.floor(total) && total >= 3 ? ' Чисто!' : ''}`;
}
