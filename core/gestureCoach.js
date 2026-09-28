// ASHEN OATH — режим «ОШИБКА» (твист хакатона): тексты подсказок и статистика точности жестов.
// Чистая логика: без DOM и импортов. Коды подсказок выдаёт core/handGestures.js в тот момент,
// когда жест почти получился, но что-то конкретное не так (кольцо не замкнуто, ладонь боком,
// руна не замкнута, взмах медленный…). Здесь коду сопоставляется жест и конкретное исправление.
//
// createCoachStats() копит удачные жесты и ошибки за бой → summary() для экрана итогов:
// точность в процентах и самая частая ошибка с советом.

export const COACH_HINTS = Object.freeze({
  // кадр и трекинг
  hand_edge:     { gesture: 'Кадр', text: 'Кисть у края кадра — держи руки ближе к центру, иначе камера теряет пальцы' },
  hand_far:      { gesture: 'Кадр', text: 'Кисти слишком мелкие — сядь ближе к камере, примерно на метр' },
  hands_missing: { gesture: 'Кадр', text: 'Камера не видит кистей — подними руки на уровень плеч, ладонями в кадр' },
  // правая рука
  ok_ring_open:  { gesture: '«OK» · снаряд', text: 'Сомкни кончики большого и указательного в кольцо' },
  ok_fingers:    { gesture: '«OK» · снаряд', text: 'Выпрями средний, безымянный и мизинец — у «OK» они торчат вверх' },
  spark_one:     { gesture: 'Искра', text: 'Из кулака выпрямляй только указательный — средний держи согнутым' },
  slash_slow:    { gesture: 'Рассечение', text: 'Взмахни ребром ладони резче — медленный взмах не рубит' },
  burst_short:   { gesture: 'Выброс', text: 'Подержи кулак дольше (≈0,5 с), пока кольцо заряда не станет красным' },
  burst_slow:    { gesture: 'Выброс', text: 'Раскрывай кулак резко — все пальцы разом, а не по одному' },
  // левая рука
  shield_palm:   { gesture: 'Щит', text: 'Разверни левую ладонь к камере — щит держится только ладонью вперёд' },
  shield_push:   { gesture: 'Щит', text: 'Толкни левую ладонь к камере — просто поднятая ладонь щит не ставит' },
  parry_palm:    { gesture: 'Парирование', text: 'Раскрывай левый кулак ладонью к камере, а не вбок' },
  parry_slow:    { gesture: 'Парирование', text: 'Раскрывай левый кулак быстрее — окно парирования всего 0,2 с' },
  // руны
  rune_small:    { gesture: 'Руна', text: 'Руна слишком маленькая — рисуй крупнее, размером с голову' },
  rune_fast:     { gesture: 'Руна', text: 'Рисуй медленнее — камера не успевает увидеть форму' },
  rune_long:     { gesture: 'Руна', text: 'Штрих затянулся — закончив фигуру, замри пальцем на полсекунды' },
  rune_line:     { gesture: 'Руна', text: 'Это прямая линия — рисуй фигуру: ▲ треугольник, ϟ зигзаг или ○ круг' },
  rune_open:     { gesture: 'Руна', text: 'Фигура не замкнута — верни палец в точку, откуда начал' },
  rune_corners:  { gesture: 'Руна ▲', text: 'Похоже на треугольник, но углы скруглены — делай три чётких угла' },
  rune_zigzag:   { gesture: 'Руна ϟ', text: 'Похоже на молнию — сделай 2–3 резких излома и не замыкай' },
  rune_round:    { gesture: 'Руна ○', text: 'Похоже на круг — веди палец плавно, без углов' },
  rune_near:     { gesture: 'Руна', text: 'Почти получилось — повтори фигуру чётче и крупнее, одним движением, и замри в конце' },
  rune_unclear:  { gesture: 'Руна', text: 'Форма не читается — рисуй одним движением, крупно, и замри в конце' },
  // двумя руками
  orb_facing:    { gesture: 'Сфера', text: 'Поверни ладони друг к другу, будто держишь мяч' },
  orb_dy:        { gesture: 'Сфера', text: 'Выровняй руки по высоте — сейчас одна заметно выше другой' },
  orb_far:       { gesture: 'Сфера', text: 'Руки слишком широко — сведи их примерно на ширину плеч' },
  prism_tips:    { gesture: 'Призма', text: 'Соедини кончики больших и кончики указательных — получится треугольник' },
  throw_weak:    { gesture: 'Бросок чар', text: 'Толкни ладони к камере резче и дальше' },
  throw_hold:    { gesture: 'Бросок чар', text: 'Чары заряжены — толкни ладони к камере или резко махни в сторону' },
  gate_slow:     { gesture: 'Врата', text: 'Разводи ладони резче — «Врата» открываются рывком в стороны' },
  gate_horiz:    { gesture: 'Врата', text: 'Разводи ладони в стороны по горизонтали, а не вверх-вниз' },
  frame_diag:    { gesture: 'Рамка', text: 'Поставь «Г»-рамку по диагонали: одна рука выше, другая ниже' },
});

export function hintInfo(code) {
  return COACH_HINTS[code] || null;
}

// Какому жесту засчитывать удачу по импульсу распознавателя.
const SUCCESS_KINDS = ['burst', 'rune', 'spark', 'slash', 'parry', 'throw', 'sigil', 'shield', 'attack'];

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
      let top = null;
      for (const [code, n] of Object.entries(byCode)) if (!top || n > top.count) top = { code, count: n, ...COACH_HINTS[code] };
      return {
        good, mistakes: bad,
        accuracy: total ? Math.round((good / total) * 100) : null,
        top,
        byCode: { ...byCode }, byGood: { ...byGood },
      };
    },
  };
}
