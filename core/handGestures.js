// ASHEN OATH — «Перстни»: интерпретатор жестов пальцев. Владелец: №1 (роль №21 в ASHEN_V2).
// V2: левая рука — джойстик (core/leftStick.js) и рывок дёргом, щит, парирование «кулак → ладонь»;
// правая — огонь «OK», «Искра» (щелчок указательным из кулака), «Рассечение» (взмах ладонью), руны;
// выброс — правой или двумя руками.
// Чистая логика: без DOM, без импортов; время — только из аргументов (tMs).
// Вход — landmarks MediaPipe HandLandmarker (21 точка на кисть, image- и world-координаты),
// выход — HandIntent: удержания (щипок = огонь, открытая ладонь = щит), заряд кулака,
// импульсы (выброс «кулак → ладонь», руна, нарисованная указательным пальцем, взмах = рывок),
// двуручные чары: удержание conjure (СФЕРА — ладони друг к другу, ПРИЗМА — треугольник из
// больших и указательных пальцев) и импульс throw (толчок к камере или бросок рывком).
//
// Системы координат:
//  - obs.hands[i].landmarks — нормализованные координаты НЕзеркального кадра (0..1);
//  - obs.hands[i].world — метры относительно центра кисти (MediaPipe worldLandmarks), если есть;
//    оси world совпадают с осями кадра (x вправо, y вниз, z от камеры) — проверено на фикстурах;
//  - всё, что отдаётся наружу (trail, center, tip, landmarks, conjure.center), — в координатах
//    ПОКАЗА: x зеркалится при obs.mirror, чтобы совпадать с зеркальным превью и экраном.
//  - «левая/правая» — стороны самого игрока (по ближайшему запястью позы).
//  - Метка handedness MediaPipe на незеркальном кадре СОВПАДАЕТ со стороной по запястьям позы
//    (реальные кадры HaGRID: 64 из 69 в v1, 945 из 985 в v2). Раньше метка инвертировалась, а
//    знак «ладонь к камере» был подогнан под эту инверсию — при сторонах по позе (путь игры)
//    ладонь к камере читалась как «от камеры». Исправлено: ладонь правой к камере ⇔ cross < 0.
//  - Необязательные поля obs: bodyCenter {x,y} (центр плеч, незеркальный кадр) — взмах и бросок
//    считаются относительно корпуса; shoulderWidth (>0, любые единицы) — толчок к камере
//    считается относительно роста плеч (наклон вперёд всем корпусом не бросает чары).

import { createLeftStick } from './leftStick.js';
import { createSteerStick } from './steerStick.js';

export const HAND_GESTURES_VERSION = 'ASHEN_V3-hands-6';

// [НОВИЧОК] Профили жестов. «Мастер» — все детекторы (как раньше). «Новичок» — только базовые:
// ход и поворот левой рукой, щит (толчок ладонью), рывок (дёрг левой), «OK» — снаряды,
// кулак → выброс, сфера двумя руками и её бросок. Остальные детекторы не работают вовсе, поэтому
// не перехватывают позы базовых жестов (щепоть «Искры» у кулака, перо руны у «OK», «кулак → ладонь»
// левой как парирование, хлопок/врата у сферы) и не сыплют подсказками о жестах, которых нет.
// [W3-MAGIC] 'stretch' — «ладони вместе → растянуть» («Врата бури» / «Столп небес») есть в обоих профилях.
export const GESTURE_PROFILES = Object.freeze({
  novice: Object.freeze(['steer', 'shield', 'dash', 'attack', 'burst', 'orb', 'throw', 'stretch']),
  master: Object.freeze(['steer', 'shield', 'dash', 'attack', 'burst', 'orb', 'throw', 'rune', 'spark', 'slash', 'parry', 'prism', 'sigil', 'twin', 'stretch']),
});
// Подсказки «ОШИБКА» о выключенных в «Новичке» жестах
const NOVICE_MUTED_HINTS = /^(rune_|spark_|slash_|parry_|prism_|gate_|frame_)/;

export const DEFAULT_HAND_CONFIG = Object.freeze({
  // надёжность
  staleMs: 350,            // наблюдение старше — удержания отпускаются
  lostGraceMs: 300,        // кисть не видна дольше — её состояние сбрасывается
  lostGraceFrames: 8,      // [V6] но не меньше стольких кадров камеры (при 15 к/с 8 кадров ≈ 0,5 с)
  reacquireMs: 350,        // после появления кисти жесты этой кисти заблокированы
  pulseTtlMs: 350,         // непрочитанный импульс сгорает
  minHandScore: 0.5,
  // пальцы. Пороги подобраны по настоящим landmarks MediaPipe (dev/fixtures/hands, HaGRID):
  // у живой выпрямленной руки сумма сгибов PIP+DIP 20–70°, «вылет» кончика 1.25–1.5;
  // у согнутого пальца вылет 0.7–1.0.
  reachExtended: 1.15,     // |кончик−запястье| / |PIP−запястье| больше — палец выпрямлен
  reachCurled: 1.04,       // меньше — согнут
  bendExtended: 88,        // и сумма сгибов меньше этого (иначе выпрямленным не считается)
  bendCurled: 110,         // больше — согнут независимо от вылета
  thumbOut: 0.72,          // |кончик большого − MCP указательного| / ширина ладони: больше — отставлен
  thumbIn: 0.5,
  // «Щипок» = мудра OK: кольцо из большого и указательного, остальные три пальца выпрямлены.
  // Так он не путается с расслабленной рукой, у которой большой палец тоже лежит у указательного.
  pinchOn: 0.66,           // |кончик большого − кончик указательного| / размер ладони (реальный OK: 0.15–0.77)
  pinchOff: 0.76,
  okOthersReach: 1.27,     // вылет среднего (безымянный −0.04, мизинец −0.1)
  okIndexDrop: 0.12,       // указательный короче среднего хотя бы на столько (загнут в кольцо)
  // удержание формы до признания, мс
  hold: Object.freeze({ pinch: 70, point: 110, fist: 120, open: 90, victory: 120, unknown: 220 }),
  palmSideRatio: 0.18,     // |векторное произведение| / ладонь² меньше — ладонь «ребром»
  palmSideHyst: 0.03,      // [ЩИТ НЕ МИГАЕТ] гистерезис стороны ладони: к камере → ребро ниже (порог − столько), ребро → к камере выше (порог + столько)
  // [ЩИТ НЕ МИГАЕТ] One-Euro для точек кисти, по которым распознаётся ФОРМА (пальцы, сторона ладони). Позиции и
  // скорости (руль, рывок, взмах, толчок) считаются по сырым точкам — без задержки. Кисть стоит — сглаживание
  // сильное (шум точек не «мигает» формой); пальцы движутся — частота среза растёт, задержки почти нет.
  shapeFilter: 1,          // 0 — выключить
  shapeMinCutoffHz: 2,
  shapeBeta: 0.5,          // Гц на (ладонь/с)
  shapeDCutoffHz: 1,
  shapeAlphaMax: 0.6,      // [НИЗКАЯ ЧАСТОТА] у неподвижной кисти новый кадр весит не больше этого (на 8 Гц срез ниже: кадров мало, шум тот же)
  shapeFilterResetMs: 250, // кисть пропадала дольше — фильтр начинается заново
  // заряд и выброс
  chargeMs: 1100,
  minCharge: 0.3,
  releaseWindowMs: 450,    // кулак → ладонь не дольше этого
  pairWindowMs: 160,       // вторая кисть успела раскрыться — бонус
  bothHandsBonus: 0.25,
  burstRefractoryMs: 650,
  // руны
  runeMinStrokeMs: 250,
  runeMaxStrokeMs: 4000,
  runeMinSize: 0.12,       // диагональ рамки штриха, в высотах кадра
  runeEndStillMs: 300,     // кончик неподвижен — штрих окончен
  runeStillSpeed: 0.12,    // высот кадра в секунду (старое правило; V3 — окно ниже)
  runeStillWindowMs: 100,  // [V3] кончик «движется», если за это окно ушёл дальше runeStillDist…
  runeStillDist: 0.012,    //    …высот кадра (при живом дрожании трекинга старое правило конец почти не ловило)
  runeClosedGap: 0.36,     // [V3] замкнутость: зазор начало–конец / диагональ меньше
  runeSnapFrom: 0.8,       // [V3] доводка замыкания: после этой доли длины ищем ближайший возврат к началу
  runeSnapDist: 0.2,       //    …ближе этой доли диагонали — пробуем штрих, обрезанный там
  runeScore: 0.78,
  runeMargin: 0.04,        // отрыв от второго кандидата
  runeCooldownMs: 700,     // между двумя распознаваниями
  trailKeepMs: 700,
  tipTauMs: 35,
  // [ASHEN_V3] щит (левая): поднимается только осознанно — толчок раскрытой ладонью к камере
  // (жест «стоп»); держится, пока ладонь смотрит в камеру. Ведение героя открытой ладонью и
  // хватка джойстика щит больше не включают. shieldHoldMs > 0 — старый путь «ладонь стоит».
  shieldPushRatio: 1.15,   // кисть выросла в кадре (относительно плеч) за shieldPushMs — толчок
  shieldPushMs: 320,
  shieldPushMsSteer: 240,  // [V6] в «Руле» окно короче: толчок быстрый, а в длинном окне медленный дрейф руки набегал до порога
  shieldPushKeepMs: 450,   // толчок годится столько, пока форма «ладонь» признаётся
  shieldHoldMs: 0,
  shieldStickMax: 0.2,     // |выход джойстика| меньше — ладонь «стоит»
  shieldDropMs: 160,       // ладонь отвернулась/сжалась дольше — щит опускается
  shieldLostMs: 300,       // [V6] кисть пропала из трекинга (смаз, 3–8 кадров) — щит держится дольше: это не «опустил»
  shieldPushShift: 0.5,    // [V3.1] за время толчка центр ладони сдвинулся в плоскости кадра меньше (S): это толчок, а не ведение
  shieldStickStart: 0.25,  // [V3.1] щит поднимается, только если джойстик почти в центре (|выход| меньше)
  // [V6] щит без ложных срабатываний: шум размера кисти и лёгкий наклон руки вперёд при ходьбе в «Руле»
  // щит больше не поднимают, а поднятый случайно — опускается, стоит убрать ладонь назад.
  shieldPushFrames: 2,     // толчок признаётся, только если держится столько кадров подряд (не один выброс шума)
  shieldPushRatioSteer: 1.24, // в «Руле» ладонь и так поднята к камере — толчок нужен заметнее
  shieldPushScaleCheck: 1.1,  // и размер по world-точкам тоже вырос хотя бы во столько (кисть приблизилась, а не развернулась)
  shieldPushFastShare: 0.5, // и был быстрый участок: размах вырос на эту долю порога толчка (в «Руле» +12 %)…
  shieldPushFastMs: 100,   //   …примерно за столько мс (толчок, а не медленный дрейф руки к камере)
  shieldPushPinMargin: 0.06, // толчок, прерванный пропуском кадров, досчитывается с таким запасом к порогу
  shieldPushTurnMax: 0.15, // за время толчка ладонь почти не повернулась (|z| нормали изменился меньше): разворот ладони к камере — не толчок
  shieldConfirmMs: 90,     // ладонь к камере раскрыта хотя бы столько (не мигание формы)
  shieldStillShare: 0.6,   // в момент подъёма щита ладонь всё ещё впереди: не меньше этой доли толчка над размером до него
  shieldAfterRaiseMs: 400, // в «Руле»: столько после подъёма руки щит не поднимается (подъём — не толчок)
  shieldMaxLevelSpeed: 1.2, //   и пока рука заметно идёт вверх/вниз (sw/с): к плечу на бег — не толчок
  shieldRetract: 0.07,     // ладонь вернулась назад: размер < (размер до толчка)·(1 + столько)…
  shieldRetractShare: 0.5, //   …или ушла назад больше чем на эту долю толчка (от пика) — что больше…
  shieldRetractMs: 200,    //   …в сумме столько (шум кадров копилку не обнуляет) — щит опускается
  shieldScaleTauMs: 50,    // сглаживание размера кисти (оценка по точкам шумит на ~3–5 % от кадра к кадру)
  shieldJitRef: 0.035,     // [СТОЯ] обычное дрожание размера кисти сидя (|ln| соседних кадров)
  shieldJitTauMs: 1500,
  shieldJitDead: 1.25,     //   до стольких «обычных шумов» пороги и сглаживание не меняются
  shieldNoiseMax: 2.5,     //   шум выше обычного во столько раз (не больше) — размер сглаживается во столько раз дольше
  // [НИЗКАЯ ЧАСТОТА] На 6–10 Гц толчок ладонью (≈0,2 с) — это 1–2 кадра. Окна щита считаются по реальному
  // интервалу кадров: в окне толчка должно оставаться хотя бы столько кадров (иначе «размер до толчка»
  // выпадает из окна раньше, чем набран подтверждающий второй кадр)
  shieldPushWindowFrames: 3,
  shieldDriftPerSec: 0.4, // за удлинённое окно толчка ладонь успевает «подъехать» к камере (≈±10 % с периодом 2–3 с): порог выше на столько в секунду удлинения
  shieldGapPushMs: 600,    // кисть пропала из трекинга на весь толчок (смаз) и вернулась не позже — сравниваем с последним кадром до пропуска
  // [ЩИТ НЕ МИГАЕТ] удержание: «ладонь убрана» судится по сглаженному размеру и по пику, который медленно
  // спадает (один шумный кадр-максимум не поднимает планку навсегда); опускание — по времени, но не меньше кадров
  shieldHoldTauMs: 60,     // сглаживание размера кисти при поднятом щите
  shieldPeakTauMs: 2000,   // пик размера спадает к текущему с такой постоянной времени
  shieldRetractFrames: 2.5, // «убрал ладонь» — не меньше стольких интервалов кадров подряд
  shieldDropFrames: 1.6,   // ладонь отвернулась/сжалась — не меньше стольких интервалов кадров
  // парирование (левая): стабильный кулак → раскрытая ладонь к камере
  parryWindowMs: 150,      // от выхода из кулака до ладони к камере (V3.1: 220 → 150)
  parryFistMs: 250,        // [V3.1] кулак держался хотя бы столько (не «перехват» руки при ведении)
  parryStickMax: 0.25,     // [V3.1] и джойстик почти в центре в момент раскрытия
  parryRefractoryMs: 450,
  // «Искра» (правая, spec G01): кулак/«заряд» → резко выпрямить только указательный
  sparkTouch: 0.62,        // большой у кончиков указательного/среднего (/ ладонь)
  sparkCurl: 1.1,          // вылет пальца меньше — согнут
  sparkLoadMs: 90,         // «заряд» держится столько
  sparkFlickMs: 180,       // выпрямление не дольше
  sparkExtend: 1.18,       // указательный выпрямлен
  sparkOpen: 0.85,         // большой отошёл от указательного (/ ладонь)
  sparkRefractoryMs: 260,
  sparkStrokeBlockMs: 450, // после щелчка указательный не начинает руну
  // взмах правой открытой ладонью → «Рассечение» (spec G02); в V1 это был рывок
  swipeSpeed: 1.6,         // высот кадра в секунду (относительно корпуса)
  swipeMinTravel: 0.12,
  swipeWindowMs: 140,
  swipeRearmSpeed: 0.45,
  swipeRefractoryMs: 700,
  // ── двуручные чары. Масштаб S — «размер ладони» в высотах кадра, устойчивый к ракурсу:
  //    max(|2D-отрезок| / |3D-отрезок|) по жёстким отрезкам ладони × длина ладони в world.
  conjureOnMs: 200,        // поза держится столько — чары вызваны
  conjureDropMs: 350,      // поза сломалась дольше — чары гаснут (без броска)
  conjureChargeMs: 1200,   // заряд 0 → 1 за столько удержания позы
  conjureSizeTauMs: 80,    // сглаживание size
  // СФЕРА: обе кисти раскрыты, ладони друг к другу, рядом по горизонтали
  orbFacingOn: 0.5,        // проекция нормали ладони (world) на направление к другой кисти
  orbFacingOff: 0.3,
  orbSideOn: 0.18,         // или ладонь «ребром» в 2D (|cross|) при нормали хотя бы не наружу
  orbSideOff: 0.28,
  orbSideMinFacing: 0.3,   // V3.1: 0.1 → 0.3 (ребро ладони при ведении — не сфера)
  orbGapMin: 0.55,         // расстояние между центрами ладоней / S
  orbGapMax: 3.4,          // V3.1: 4.0 → 3.4
  orbGapSlack: 0.15,       // расширение диапазона при удержании
  orbDyOn: 0.55,           // |dy| / расстояние: кисти рядом по горизонтали
  conjureStickMax: 0.25,   // [V3.1] чары не начинаются, пока левой рукой ведут героя (|выход джойстика| больше)
  orbDyOff: 0.75,
  orbTipsApart: 0.35,      // кончики пальцев двух кистей не касаются (иначе «домик»/молитва)
  orbTipsApartOff: 0.2,
  orbFingersDown: 0.6,     // пальцы смотрят вниз сильнее — руки опущены, не сфера
  orbSizeMin: 0.7,         // gap/S → size 0..1
  orbSizeMax: 3.2,
  // ПРИЗМА: кончики больших пальцев вместе, кончики указательных вместе, между ними окно
  prismTipOn: 0.5,         // |кончик − кончик| / S
  prismTipOff: 0.75,
  prismWindowOn: 0.45,     // |середина указательных − середина больших| / S
  prismWindowOff: 0.35,
  prismGapMin: 0.9,        // центры ладоней разнесены (молитвенные ладони вплотную — не призма)
  prismGapMinOff: 0.8,
  prismFacingVeto: 0.8,    // обе ладони строго друг к другу — это «домик»/молитва, не призма
  prismSizeMin: 0.45,      // высота окна / S → size 0..1
  prismSizeMax: 1.5,
  // бросок
  throwMinHeldMs: 150,     // после вызова чар
  throwMinPower: 0.15,
  throwRefractoryMs: 800,  // после броска: нет новых чар, взмаха, выброса
  throwQuietMs: 300,       // после броска удержания (щит/огонь) молчат
  pushWindowMs: 250,       // толчок к камере: обе кисти выросли в 2D
  pushRatio: 1.22,
  pushTrend: 1.06,         // и предыдущий кадр уже рос (одиночный скачок — не толчок)
  flingWindowMs: 160,      // бросок рывком: центр между кистями быстро сдвинулся
  flingSpeed: 1.6,         // высот кадра в секунду (относительно корпуса)
  flingMinTravel: 0.12,
  flingDownCos: 0.8,       // почти вертикально вниз — это руки опускаются, не бросок
  glitchSpeed: 9,          // скачок быстрее — сбой трекинга, история движения сбрасывается
  // ── [ASHEN_V3] двуручные фигуры-печати (импульс sigil). Расстояния — в ладонях S.
  // ХЛОПОК: раскрытые ладони быстро сходятся (как хлопок в ладоши).
  clapFrom: 2.1,           // было не ближе стольких S
  clapTo: 0.95,            // сошлись ближе
  clapWindowMs: 320,       // за столько
  clapSpeed: 4.0,          // S/с — средняя скорость сближения
  clapDy: 0.7,             // |dy| / расстояние в начале: руки на одной высоте
  // [W3-MAGIC] ЛАДОНИ ВМЕСТЕ → РАСТЯНУТЬ: в стороны — «Врата бури» (sigil 'gate'), вверх-вниз — «Столп небес» ('pillar').
  // Сомкнуты — центры ладоней ближе stretchTogether и это не сфера/призма (у сферы между ладонями «мяч»).
  stretchTogether: 1.15,   // ближе стольких S — ладони сомкнуты
  stretchHoldMs: 300,      // сомкнуты не меньше — жест взведён (меньше — подсказка «сомкни и подержи»)
  stretchFullMs: 1500,     // держал столько — полный заряд (сила растёт от stretchHoldMs до stretchFullMs)
  stretchShowMs: 120,      // заряд показывается после стольких мс (руки, просто прошедшие рядом, не мигают)
  stretchPrimeMs: 900,     // после размыкания столько ждём растяжения
  stretchLostMs: 700,      // сомкнутые ладони MediaPipe теряет: «вместе» держится столько без кадров кистей
  stretchApart: 2.4,       // растянули дальше стольких S — жест закончен
  stretchSpeed: 3.0,       // S/с — средняя скорость растяжения не меньше
  stretchAxisCos: 0.79,    // |dx|/gap не меньше — в стороны, |dy|/gap — вверх-вниз (≈38°); между — диагональ
  stretchNear: 1.9,        // [ОШИБКА] ладони были ближе стольких S, но не сомкнуты — «сомкни ладони»
  stretchOpenWindowMs: 500,
  // РАМКА: обе кисти буквой «Г» (указательный и большой выпрямлены, остальные согнуты), по диагонали
  frameHoldMs: 300,
  frameThumb: 0.6,         // большой отставлен (|кончик − MCP указательного| / ширина ладони); поджатый ≈ 0.45
  frameAngleDeg: 70,       // и угол «большой — указательный» не меньше (настоящая «Г» ≈ 80–100°)
  clapLostMs: 100,         // хлопок: одна кисть пропала сразу после быстрого сближения (MediaPipe теряет сомкнутые ладони)
  clapLostGap: 1.4,
  frameDx: 1.4,            // |dx| между центрами ладоней, S
  frameDy: 0.7,            // |dy|, S — по диагонали, не рядом
  sigilRefractoryMs: 900,
  // ── [ASHEN_V3] двуручное рисование: оба указательных вместе → зеркально рисуют фигуру (ДЕЛЬТА ▲, КОР ♥)
  twinTipsTogether: 0.7,   // кончики указательных ближе (S) — старт
  twinThumbsApart: 0.8,    // большие пальцы дальше (S) — это не ПРИЗМА
  twinArmMs: 120,          // кончики замерли столько — рисование началось
  twinStill: 0.012,        // «замер»: сдвиг за окно меньше (высоты кадра)
  twinMinTravel: 2.5,      // каждый кончик прошёл не меньше (S)
  twinMeet: 0.8,           // кончики снова сошлись (S) — фигура закрыта
  twinSeparate: 1.2,       // до этого расходились хотя бы на столько (S)
  twinEndStillMs: 300,     // или оба замерли столько
  twinMaxMs: 3000,
  twinDrift: 1.0,          // середина кончиков ушла вбок больше (S) — половины не зеркальны, отмена
  twinShapeLossMs: 150,    // кисть вышла из «указания» дольше — отмена
  twinScore: 0.78,
  // ── [ТВИСТ «ОШИБКА»] подсказки к почти-правильным жестам (импульс hint { code }).
  //    Тексты — core/gestureCoach.js. Подсказка выдаётся, только когда жест явно начат,
  //    но одно конкретное условие не выполнено; частые повторы гасятся кулдаунами.
  hintCooldownMs: 6000,    // одна и та же подсказка не чаще
  hintOrbFacing: 0.3,      // [V6] подсказки про сферу — только если ладони уже (хоть одна) повёрнуты друг к другу…
  hintOrbCloseGap: 2.6,    //   …или руки сведены так близко (в размерах кисти), как для сферы
  hintGapMs: 2200,         // любые две подсказки не чаще
  hintEdge: 0.015,         // точка кисти ближе к краю кадра (доля) — «у края»
  hintEdgeMs: 700,
  hintFarScale: 0.05,      // размер ладони в высотах кадра меньше — «слишком далеко»
  hintFarStandK: 0.7,      // [СТОЯ] игрок стоит дальше от камеры нарочно: «далеко» — только если кисть ещё мельче (×столько)
  // [СТОЯ] Пороги в долях кадра (скорость и длина взмаха, броска рывком, размер руны) рассчитаны на сидящего
  // в ~1 м (ширина плеч ≈ 0.3 высоты кадра). Игрок дальше (стоит) — те же движения в кадре мельче: пороги
  // умножаются на (ширина плеч / swRef), но не меньше unitKMin; ближе обычного — без изменений.
  swRef: 0.3,
  unitKMin: 0.45,
  hintFarMs: 1500,
  hintMissingMs: 2500,     // запястья позы видны, а кистей нет столько — «кистей не видно»
  hintRingSlack: 1.6,      // «кольцо почти замкнуто»: pinchOn ≤ pinch < pinchOn × slack
  hintNearMs: 450,         // почти-поза держится столько — подсказка
  hintSlowSwipe: 0.6,      // взмах быстрее swipeSpeed × это, но медленнее порога — «резче»
  hintTwoHandMs: 900,      // почти-сфера/призма держится столько
  hintThrowHoldMs: 3500,   // чары держатся без броска столько — напомнить, как бросить
  hintWeakPush: 1.1,       // кисти выросли хотя бы так, но не до pushRatio — «резче»
  // [V5] «Руль» (движение левой рукой): подсказки реже обычных — движение не должно спамить
  hintSteerMs: 900,        // руку подняли, но она держится ниже груди столько — «подними до груди»
  hintSteerLowBand: 0.65,  //   «ниже груди» — не глубже стольких sw под порогом шага (ниже — рука просто лежит)
  hintSteerCooldownMs: 20000,
  hintLeanSw: 0.3,         // корпус ушёл вбок на столько sw, а рука не рулит…
  hintLeanMs: 700,         //   …столько — «поворачивай рукой, а не корпусом»
});

export const RUNES = Object.freeze({
  ignis: Object.freeze({ id: 'ignis', title: 'ИГНИС', glyph: '▲', shape: 'треугольник', closed: true, effect: 'огненное копьё' }),
  fulgur: Object.freeze({ id: 'fulgur', title: 'ФУЛЬГУР', glyph: 'ϟ', shape: 'молния (зигзаг)', closed: false, effect: 'оглушение стража' }),
  orbis: Object.freeze({ id: 'orbis', title: 'ОРБИС', glyph: '○', shape: 'круг', closed: true, effect: 'лечение и оберег' }),
  // [ASHEN_V3] новые фигуры — набор и пороги подобраны симуляцией (98.5% верно, 0% «не та руна»)
  stella: Object.freeze({ id: 'stella', title: 'СТЕЛЛА', glyph: '★', shape: 'звезда одним штрихом', closed: true, effect: 'звездопад' }),
  spira: Object.freeze({ id: 'spira', title: 'СПИРА', glyph: '@', shape: 'спираль из центра наружу', closed: false, effect: 'вихрь' }),
  lemnis: Object.freeze({ id: 'lemnis', title: 'ЛЕМНИСКА', glyph: '∞', shape: 'лежачая восьмёрка', closed: true, effect: 'вечность: лечение' }),
  caret: Object.freeze({ id: 'caret', title: 'АКУС', glyph: '^', shape: 'шеврон вершиной вверх', closed: false, effect: 'залп игл' }),
  vee: Object.freeze({ id: 'vee', title: 'МЕССИС', glyph: 'V', shape: 'галка вершиной вниз', closed: false, effect: 'жатва' }),
  clepsydra: Object.freeze({ id: 'clepsydra', title: 'КЛЕПСИДРА', glyph: '⧗', shape: 'песочные часы', closed: true, effect: 'время Регента медленнее' }),
  alpha: Object.freeze({ id: 'alpha', title: 'АЛЬФА', glyph: 'ℓ', shape: 'петля над шевроном', closed: false, effect: 'откаты сброшены' }),
});
// Ворота распознавателя: замкнутость и число углов (x0.6 при несовпадении замкнутости, x0.85 — углов).
// Для трёх старых рун таблица даёт ровно прежнее поведение.
export const RUNE_GATES = Object.freeze({
  ignis: { closure: 'closed', cMin: 2, cMax: 4 },
  fulgur: { closure: 'open', cMin: 2, cMax: Infinity },
  orbis: { closure: 'closed', cMin: 0, cMax: 1 },
  stella: { closure: 'closed', cMin: 3, cMax: 7 },
  spira: { closure: 'any', cMin: 0, cMax: 4 },
  lemnis: { closure: 'closed', cMin: 2, cMax: 6 },
  caret: { closure: 'open', cMin: 1, cMax: 3 },
  vee: { closure: 'open', cMin: 1, cMax: 3 },
  clepsydra: { closure: 'closed', cMin: 3, cMax: 5 },
  alpha: { closure: 'open', cMin: 0, cMax: 3 },
});
// свои пороги у сложных фигур (остальные — runeScore)
export const RUNE_MIN_SCORE = Object.freeze({ stella: 0.7, clepsydra: 0.7, spira: 0.72, lemnis: 0.72 });
// [ТВИСТ «ОШИБКА»] тренажёр техники: жесты, для которых checks() отдаёт прогресс каждого условия
export const CHECK_GESTURES = Object.freeze(['ok', 'shield', 'spark', 'burst', 'parry', 'orb']);
export const CHECK_WINDOW_MS = 1500;   // условия-движения (толчок, заряд, резкое раскрытие): лучшее за столько мс

// ───────────────────────────── утилиты ─────────────────────────────
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num0 = (v) => (fin(v) ? v : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isObj = (v) => v !== null && typeof v === 'object';
const DEG = 180 / Math.PI;

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function len(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }
function dist(a, b) { return len(sub(a, b)); }
function angleBetween(u, v) {
  const lu = len(u), lv = len(v);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const c = clamp((u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv), -1, 1);
  return Math.acos(c) * DEG;
}
function mergeConfig(base, patch) {
  const out = { ...base, hold: { ...base.hold } };
  if (!isObj(patch)) return out;
  for (const k of Object.keys(base)) {
    if (k === 'hold') {
      if (isObj(patch.hold)) for (const h of Object.keys(base.hold)) if (fin(patch.hold[h])) out.hold[h] = patch.hold[h];
    } else if (fin(patch[k])) out[k] = patch[k];
  }
  return out;
}

function validPoints(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = arr[i];
    if (!isObj(p) || !fin(p.x) || !fin(p.y)) return null;
    out[i] = { x: p.x, y: p.y, z: fin(p.z) ? p.z : 0 };
  }
  return out;
}

// ───────────────────────── распознаватель штриха ($1 / Protractor-подобный) ─────────────────────────
const N_RESAMPLE = 64;

function pathLength(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return d; }

function resample(pts, n) {
  const L = pathLength(pts);
  if (pts.length < 2 || L < 1e-9) return null;
  const I = L / (n - 1);
  const src = pts.map((p) => ({ x: p.x, y: p.y }));
  const out = [{ ...src[0] }];
  let D = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (D + d >= I && d > 0) {
      const t = (I - D) / d;
      const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      out.push(q);
      src.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...src[src.length - 1] });
  return out.slice(0, n);
}

function normalizeStroke(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const s = Math.max(maxX - minX, maxY - minY) || 1;
  let cx = 0, cy = 0;
  const q = pts.map((p) => ({ x: (p.x - minX) / s, y: (p.y - minY) / s }));
  for (const p of q) { cx += p.x; cy += p.y; }
  cx /= q.length; cy /= q.length;
  return q.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

function rotate(pts, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return pts.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}
function pathDistance(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y); return d / a.length; }

// Поиск по углу в пределах ±range (золотое сечение), как в $1.
function distanceAtBestAngle(pts, tpl, range) {
  const phi = 0.5 * (-1 + Math.sqrt(5));
  let a = -range, b = range;
  let x1 = phi * a + (1 - phi) * b, x2 = (1 - phi) * a + phi * b;
  let f1 = pathDistance(rotate(pts, x1), tpl), f2 = pathDistance(rotate(pts, x2), tpl);
  for (let i = 0; i < 12; i++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = phi * a + (1 - phi) * b; f1 = pathDistance(rotate(pts, x1), tpl); }
    else { a = x1; x1 = x2; f1 = f2; x2 = (1 - phi) * a + phi * b; f2 = pathDistance(rotate(pts, x2), tpl); }
  }
  return Math.min(f1, f2, pathDistance(pts, tpl));
}

function polyline(points, closed) {
  const pts = points.map(([x, y]) => ({ x, y }));
  if (closed) pts.push({ ...pts[0] });
  return pts;
}
function circlePts(start, dir) {
  const out = [];
  for (let i = 0; i <= 48; i++) {
    const a = start + dir * (i / 48) * Math.PI * 2;
    out.push({ x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) });
  }
  return out;
}
function rotations(poly) { // все стартовые вершины и оба направления замкнутого многоугольника
  const out = [];
  const n = poly.length;
  for (let s = 0; s < n; s++) {
    const fwd = [], back = [];
    for (let k = 0; k < n; k++) { fwd.push(poly[(s + k) % n]); back.push(poly[(s - k + n * 2) % n]); }
    out.push(polyline(fwd, true), polyline(back, true));
  }
  return out;
}

const TEMPLATE_SOURCES = (() => {
  const t = [];
  // ИГНИС — треугольник (вершиной вверх и вниз), все старты и направления
  for (const pts of rotations([[0.5, 0], [1, 0.87], [0, 0.87]])) t.push({ rune: 'ignis', pts });
  for (const pts of rotations([[0, 0.13], [1, 0.13], [0.5, 1]])) t.push({ rune: 'ignis', pts });
  // ОРБИС — круг: 8 стартов × 2 направления
  for (let k = 0; k < 8; k++) for (const d of [1, -1]) t.push({ rune: 'orbis', pts: circlePts((k / 8) * Math.PI * 2, d) });
  // ФУЛЬГУР — молния/зигзаг: Z, N, «⚡», оба направления
  const zig = [
    [[0, 0], [1, 0], [0, 1], [1, 1]],                       // Z
    [[0, 1], [0.35, 0], [0.65, 1], [1, 0]],                 // N/«W»-зигзаг
    [[0.65, 0], [0.15, 0.55], [0.85, 0.45], [0.35, 1]],     // ⚡
    [[0, 0.1], [0.5, 0.45], [0.3, 0.55], [1, 0.95]],        // пологая молния
    [[0, 0], [0.4, 0.35], [0.25, 0.5], [0.75, 0.75], [0.6, 1]],
  ];
  for (const z of zig) {
    t.push({ rune: 'fulgur', pts: polyline(z, false) });
    t.push({ rune: 'fulgur', pts: polyline([...z].reverse(), false) });
    t.push({ rune: 'fulgur', pts: polyline(z.map(([x, y]) => [1 - x, y]), false) });
    t.push({ rune: 'fulgur', pts: polyline(z.map(([x, y]) => [1 - x, y]).reverse(), false) });
  }
  // ── [V3] новые фигуры
  const curve = (fn, n = 128) => { const out = []; for (let i = 0; i <= n; i++) { const [x, y] = fn(i / n); out.push({ x, y }); } return out; };
  const rev = (p) => [...p].reverse();
  const mirX = (p) => p.map((q) => ({ x: 1 - q.x, y: q.y }));
  // СТЕЛЛА — пентаграмма одним штрихом (вершины через одну), все старты и направления
  const star = []; for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / 5; star.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]); }
  for (const pts of rotations([star[0], star[2], star[4], star[1], star[3]])) t.push({ rune: 'stella', pts });
  // СПИРА — 2 витка из центра наружу (и обратно), 8 стартовых углов × 2 направления
  for (let k = 0; k < 8; k++) for (const d of [1, -1]) {
    const p = curve((u) => { const r = 0.03 + 0.47 * u, a = k * Math.PI / 4 + d * u * 4 * Math.PI; return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]; });
    t.push({ rune: 'spira', pts: p }, { rune: 'spira', pts: rev(p) });
  }
  // ЛЕМНИСКА — лежачая восьмёрка (лемниската Жероно), 8 стартов × 2 направления
  for (let k = 0; k < 8; k++) for (const d of [1, -1]) t.push({ rune: 'lemnis', pts: curve((u) => { const q = k * Math.PI / 4 + d * u * 2 * Math.PI; return [0.5 + 0.5 * Math.cos(q), 0.5 + 0.25 * Math.sin(2 * q)]; }) });
  // АКУС — шеврон вершиной вверх; МЕССИС — галка вершиной вниз (рисовать прямо: поиск ±25°)
  { const p = polyline([[0, 1], [0.5, 0], [1, 1]], false); t.push({ rune: 'caret', pts: p }, { rune: 'caret', pts: rev(p) }); }
  { const p = polyline([[0, 0], [0.5, 1], [1, 0]], false); t.push({ rune: 'vee', pts: p }, { rune: 'vee', pts: rev(p) }); }
  // КЛЕПСИДРА — песочные часы (Z, замкнутая второй диагональю)
  for (const pts of rotations([[0, 0], [1, 0], [0, 1], [1, 1]])) t.push({ rune: 'clepsydra', pts });
  // АЛЬФА — петля над шевроном: подход снизу-слева, петля против часовой, уход вниз-вправо (+ зеркала)
  {
    const p = [], R = 0.25, cx = 0.5, cy = 0.55 - R, bot = { x: cx, y: cy + R };
    for (let i = 0; i <= 12; i++) { const u = i / 12; p.push({ x: bot.x * u, y: 1 + (bot.y - 1) * u }); }
    for (let i = 1; i <= 48; i++) { const a = Math.PI / 2 - (i / 48) * 2 * Math.PI; p.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }); }
    for (let i = 1; i <= 12; i++) { const u = i / 12; p.push({ x: bot.x + (1 - bot.x) * u, y: bot.y + (1 - bot.y) * u }); }
    t.push({ rune: 'alpha', pts: p }, { rune: 'alpha', pts: rev(p) }, { rune: 'alpha', pts: mirX(p) }, { rune: 'alpha', pts: rev(mirX(p)) });
  }
  return t;
})();
// [V3] двуручные рисованные фигуры (оба указательных зеркально): правая половина; левая — её зеркало,
// склейка: reverse(левая) ++ правая.
const TWIN_SOURCES = (() => {
  const t = [];
  const half = (right) => { const left = right.map((q) => ({ x: 1 - q.x, y: q.y })); return [...left].reverse().concat(right.slice(1)); };
  // ДЕЛЬТА — треугольник: от вершины вниз-наружу и по основанию к центру
  t.push({ rune: 'delta', pts: half(polyline([[0.5, 0], [1, 1], [0.5, 1]], false)) });
  // КОР — сердце: от верхней выемки по доле наружу и вниз к острию
  {
    const raw = (q) => { const x = 16 * Math.pow(Math.sin(q), 3), y = 13 * Math.cos(q) - 5 * Math.cos(2 * q) - 2 * Math.cos(3 * q) - Math.cos(4 * q); return { x: (x + 16) / 32, y: (12 - y) / 29 }; };
    const right = []; for (let i = 0; i <= 64; i++) right.push(raw((i / 64) * Math.PI));
    t.push({ rune: 'cor', pts: half(right) });
  }
  return t;
})();
export const TWIN_GATES = Object.freeze({ delta: { closure: 'closed', cMin: 1, cMax: 5 }, cor: { closure: 'closed', cMin: 1, cMax: 5 } });
let TWIN_TEMPLATES = null;
function twinTemplates() {
  if (!TWIN_TEMPLATES) TWIN_TEMPLATES = TWIN_SOURCES.map((s) => ({ rune: s.rune, pts: normalizeStroke(resample(s.pts, N_RESAMPLE)) }));
  return TWIN_TEMPLATES;
}
let TEMPLATES = null;
function templates() {
  if (!TEMPLATES) TEMPLATES = TEMPLATE_SOURCES.map((s) => ({ rune: s.rune, pts: normalizeStroke(resample(s.pts, N_RESAMPLE)) }));
  return TEMPLATES;
}

function countCorners(pts) { // резкие повороты на ресемплированном штрихе
  let corners = 0, cooldown = 0;
  for (let i = 4; i < pts.length - 4; i++) {
    if (cooldown > 0) { cooldown--; continue; }
    const a = pts[i - 4], b = pts[i], c = pts[i + 4];
    const u = { x: b.x - a.x, y: b.y - a.y, z: 0 }, v = { x: c.x - b.x, y: c.y - b.y, z: 0 };
    if (angleBetween(u, v) > 58) { corners++; cooldown = 6; }
  }
  return corners;
}

// Оценка одного варианта штриха против набора шаблонов с воротами. null — вырожденный/линия.
function scoreVariant(part, tpls, gates, closedGap) {
  if (part.length < 8) return null;
  const rs = resample(part, N_RESAMPLE);
  if (!rs) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rs) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const w = maxX - minX, h = maxY - minY, diag = Math.hypot(w, h) || 1;
  if (Math.min(w, h) < 0.18 * Math.max(w, h)) return { line: true };
  const gap = Math.hypot(rs[0].x - rs[rs.length - 1].x, rs[0].y - rs[rs.length - 1].y) / diag;
  const closed = gap < closedGap, open = gap > 0.45;
  const corners = countCorners(rs);
  const pts = normalizeStroke(rs);
  const best = {};
  for (const k of Object.keys(gates)) best[k] = Infinity;
  const range = (25 * Math.PI) / 180;
  for (const t of tpls) {
    if (!(t.rune in best)) continue;
    const d = distanceAtBestAngle(pts, t.pts, range);
    if (d < best[t.rune]) best[t.rune] = d;
  }
  const half = 0.5 * Math.sqrt(2);
  const scores = {};
  for (const k of Object.keys(best)) {
    const g = gates[k];
    let sc = clamp(1 - best[k] / half, 0, 1);
    if (g.closure === 'closed' && !closed) sc *= 0.6;
    if (g.closure === 'open' && !open) sc *= 0.6;
    if (corners < g.cMin || corners > g.cMax) sc *= 0.85;
    scores[k] = sc;
  }
  return { scores, corners, gap };
}

/** Распознать штрих (точки в координатах с одинаковым масштабом по x и y).
 *  opts: minScore, margin, runes (список id; по умолчанию все руны), minScoreBy, closedGap, snap (доводка замыкания). */
export function recognizeStroke(rawPts, opts = {}) {
  const minScore = fin(opts.minScore) ? opts.minScore : DEFAULT_HAND_CONFIG.runeScore;
  const margin = fin(opts.margin) ? opts.margin : DEFAULT_HAND_CONFIG.runeMargin;
  const minBy = isObj(opts.minScoreBy) ? opts.minScoreBy : RUNE_MIN_SCORE;
  const closedGap = fin(opts.closedGap) ? opts.closedGap : DEFAULT_HAND_CONFIG.runeClosedGap;
  const twin = opts.twin === true;
  const gatesAll = twin ? TWIN_GATES : RUNE_GATES;
  const ids = Array.isArray(opts.runes) ? opts.runes.filter((k) => k in gatesAll) : Object.keys(gatesAll);
  const gates = {}; for (const k of ids) gates[k] = gatesAll[k];
  if (ids.length < 2) return { rune: null, score: 0, reason: 'config' };
  const tpls = twin ? twinTemplates() : templates();
  if (!Array.isArray(rawPts) || rawPts.length < 8) return { rune: null, score: 0, reason: 'short' };
  const clean = rawPts.filter((p) => isObj(p) && fin(p.x) && fin(p.y));
  const variants = [clean];
  // доводка замыкания: промах мимо начала — главная причина провалов замкнутых фигур
  if (opts.snap !== false && clean.length >= 12) {
    const S = [0];
    for (let i = 1; i < clean.length; i++) S.push(S[i - 1] + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y));
    const L = S[S.length - 1];
    let bx = Infinity, by = Infinity, cx = -Infinity, cy = -Infinity;
    for (const p of clean) { bx = Math.min(bx, p.x); cx = Math.max(cx, p.x); by = Math.min(by, p.y); cy = Math.max(cy, p.y); }
    const dg = Math.hypot(cx - bx, cy - by) || 1;
    let bj = -1, bd = Infinity;
    for (let i = 0; i < clean.length; i++) {
      if (S[i] < DEFAULT_HAND_CONFIG.runeSnapFrom * L) continue;
      const d = Math.hypot(clean[i].x - clean[0].x, clean[i].y - clean[0].y);
      if (d < bd) { bd = d; bj = i; }
    }
    if (bj > 0 && bj < clean.length - 2 && bd < DEFAULT_HAND_CONFIG.runeSnapDist * dg) variants.push(clean.slice(0, bj + 1));
  }
  let best = null, sawLine = false;
  for (const part of variants) {
    const r = scoreVariant(part, tpls, gates, closedGap);
    if (!r) continue;
    if (r.line) { sawLine = true; continue; }
    const ranked = Object.entries(r.scores).sort((a, b) => b[1] - a[1]);
    const res = { rune: ranked[0][0], score: ranked[0][1], second: ranked[1][1], scores: r.scores, corners: r.corners, gap: Math.round(r.gap * 100) / 100 };
    if (!best || res.score > best.score) best = res;
  }
  if (!best) return { rune: null, score: 0, reason: sawLine ? 'line' : 'degenerate' };
  const info = { scores: best.scores, corners: best.corners, gap: best.gap };
  const need = fin(minBy[best.rune]) ? minBy[best.rune] : minScore;
  if (best.score < need) return { rune: null, score: best.score, reason: 'low-score', best: best.rune, ...info };
  if (best.score - best.second < margin) return { rune: null, score: best.score, reason: 'ambiguous', best: best.rune, ...info };
  return { rune: best.rune, score: best.score, reason: 'ok', ...info };
}

// ───────────────────────────── признаки кисти ─────────────────────────────
const FINGERS = [ // [mcp, pip, dip, tip]
  [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
];

function handFeatures(img, world, aspect, cfg) {
  // Геометрия формы — по world (метры, не зависит от ракурса и расстояния), иначе по image
  // с поправкой на соотношение сторон кадра.
  const P = world || img.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z * aspect }));
  const palm = Math.max(1e-6, dist(P[0], P[9]));
  const width = Math.max(1e-6, dist(P[5], P[17]));
  const bends = FINGERS.map(([m, p, d, t]) => angleBetween(sub(P[p], P[m]), sub(P[d], P[p])) + angleBetween(sub(P[d], P[p]), sub(P[t], P[d])));
  // Палец к камере укорачивается в 2D, но в world длина сохраняется; дополнительно — кончик дальше PIP от запястья.
  const reach = FINGERS.map(([m, p, , t]) => dist(P[t], P[0]) / Math.max(1e-6, dist(P[p], P[0])));
  const thumbSpread = dist(P[4], P[5]) / width;
  const pinch = dist(P[4], P[8]) / palm;
  const thumbMid = dist(P[4], P[12]) / palm;
  // Сторона ладони — по 2D-векторному произведению в НЕзеркальных координатах кадра (y вниз).
  const I = img.map((p) => ({ x: p.x * aspect, y: p.y }));
  const v1 = { x: I[5].x - I[0].x, y: I[5].y - I[0].y }, v2 = { x: I[17].x - I[0].x, y: I[17].y - I[0].y };
  const palm2d = Math.max(1e-6, Math.hypot(I[9].x - I[0].x, I[9].y - I[0].y));
  const cross = (v1.x * v2.y - v1.y * v2.x) / (palm2d * palm2d);
  // (w5 − w0) × (w17 − w0) в осях кадра: для правой кисти сонаправлен нормали ладони
  // (из ладони наружу), для левой — противоположен. Сторона учитывается в updateHand.
  let n3 = null;
  if (world) {
    const a = sub(world[5], world[0]), b = sub(world[17], world[0]);
    const n = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
    const l = len(n);
    if (l > 1e-9) n3 = { x: n.x / l, y: n.y / l, z: n.z / l };
  }
  return { bends, reach, thumbSpread, pinch, thumbMid, cross, palm2d, palm, width, I, scale: handScale(I, world), n3 };
}

// Размер кисти в высотах кадра, устойчивый к ракурсу: 2D-проекция только укорачивает отрезок,
// поэтому max(|2D| / |3D|) по жёстким отрезкам ладони ≈ масштаб кадра на метр.
const SCALE_SEGS = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 17]];
const SCALE_SEGS_2D = [[0, 9, 1], [0, 5, 1], [0, 17, 1.12], [5, 17, 1.45]]; // без world: к длине ладони
const SPAN_IDS = [0, 1, 5, 9, 13, 17]; // [V6] точки ладони для размаха (размер кисти в кадре для щита)
function handScale(I, world) {
  const d2 = (a, b) => Math.hypot(I[a].x - I[b].x, I[a].y - I[b].y);
  if (world) {
    let ppm = 0;
    for (const [a, b] of SCALE_SEGS) {
      const l3 = dist(world[a], world[b]);
      if (l3 > 1e-4) ppm = Math.max(ppm, d2(a, b) / l3);
    }
    const s = ppm * dist(world[0], world[9]);
    if (s > 1e-6) return s;
  }
  let s = 0;
  for (const [a, b, k] of SCALE_SEGS_2D) s = Math.max(s, k * d2(a, b));
  return Math.max(1e-6, s);
}

// [ЩИТ НЕ МИГАЕТ] One-Euro по точкам (каждая точка — своя скорость в ладонях в секунду). F — состояние,
// pts — точки, unit — размер ладони в тех же единицах. Возвращает сглаженную копию.
function euroPoints(F, pts, t, unit, cfg) {
  const fresh = !F.p || F.p.length !== pts.length || !(t > F.t) || t - F.t > cfg.shapeFilterResetMs;
  if (fresh) {
    F.p = pts.map((q) => ({ x: q.x, y: q.y, z: q.z })); F.v = new Array(pts.length).fill(0); F.t = t;
    return F.p.map((q) => ({ ...q }));
  }
  const dt = (t - F.t) / 1000, u = Math.max(1e-6, unit);
  const ad = 1 - Math.exp(-2 * Math.PI * cfg.shapeDCutoffHz * dt);
  const fcMin = Math.min(cfg.shapeMinCutoffHz, -Math.log(1 - cfg.shapeAlphaMax) / (2 * Math.PI * dt));
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i], p = F.p[i];
    const sp = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) / dt / u;
    F.v[i] += (sp - F.v[i]) * ad;
    const a = 1 - Math.exp(-2 * Math.PI * (fcMin + cfg.shapeBeta * F.v[i]) * dt);
    p.x += (q.x - p.x) * a; p.y += (q.y - p.y) * a; p.z += (q.z - p.z) * a;
  }
  F.t = t;
  return F.p.map((q) => ({ ...q }));
}

function classify(f, prev, cfg) {
  // Выпрямленность с гистерезисом относительно прошлого кадра.
  const ext = f.bends.map((b, i) => {
    const wasExt = prev ? prev.extended[i + 1] : false;
    const reachLim = wasExt ? cfg.reachExtended - 0.06 : cfg.reachExtended;
    const bendLim = wasExt ? cfg.bendExtended + 10 : cfg.bendExtended;
    return f.reach[i] > reachLim && b < bendLim;
  });
  const curled = f.bends.map((b, i) => b > cfg.bendCurled || f.reach[i] < cfg.reachCurled);
  const wasThumb = prev ? prev.extended[0] : false;
  const thumb = f.thumbSpread > (wasThumb ? cfg.thumbIn + 0.08 : cfg.thumbOut);
  const extended = [thumb, ...ext];
  const wasPinch = prev && prev.rawShape === 'pinch';
  const oth = cfg.okOthersReach - (wasPinch ? 0.05 : 0);
  const pinch = f.pinch < (wasPinch ? cfg.pinchOff : cfg.pinchOn)
    && f.reach[1] >= oth && f.reach[2] >= oth - 0.04 && f.reach[3] >= oth - 0.1
    && f.reach[0] <= f.reach[1] - cfg.okIndexDrop + (wasPinch ? 0.04 : 0);
  const [iE, mE, rE, pE] = ext;
  const [iC, mC, rC, pC] = curled;
  let shape = 'unknown';
  if (pinch && !(iC && mC && rC && pC)) shape = 'pinch';
  else if (iE && mC && rC && pC) shape = 'point';
  else if (iE && mE && rC && pC) shape = 'victory';
  else if (iC && mC && rC && pC) shape = 'fist';
  else if (iE && mE && rE && (pE || !pC)) shape = 'open';
  const conf = shape === 'unknown' ? 0.3 : 0.6 + 0.4 * clamp(Math.abs(f.bends.reduce((a, b) => a + b, 0) / 4 - 80) / 80, 0, 1);
  return { shape, extended, pinchLevel: clamp(1 - (f.pinch - cfg.pinchOn) / Math.max(1e-6, cfg.pinchOff * 2 - cfg.pinchOn), 0, 1), conf };
}

// ───────────── [ТВИСТ «ОШИБКА»] прогресс условий жестов: общие куски (только показ) ─────────────
// Прогресс 0..1 к порогу: 1 — порог взят (дальше не растёт), 0 — далеко от него.
const upTo = (x, lim, lo) => clamp((num0(x) - lo) / Math.max(1e-9, lim - lo), 0, 1);     // больше — лучше: lo → 0, lim → 1
const downTo = (x, lim, hi) => clamp((hi - num0(x)) / Math.max(1e-9, hi - lim), 0, 1);   // меньше — лучше: hi → 0, lim → 1
// «Лучшее за окно» без истории кадров: максимум и лучший после него (максимум устарел — его место занимает второй).
function newPeak() { return { v: -Infinity, t: -Infinity, v2: -Infinity, t2: -Infinity }; }
function peakNote(p, v, t) {
  if (!fin(v)) return;
  if (t - p.t > CHECK_WINDOW_MS) { p.v = p.v2; p.t = p.t2; p.v2 = -Infinity; p.t2 = -Infinity; }
  if (t - p.t > CHECK_WINDOW_MS || v >= p.v) { p.v = v; p.t = t; p.v2 = -Infinity; p.t2 = -Infinity; }
  else if (v >= p.v2) { p.v2 = v; p.t2 = t; }
}
function peakGet(p, t) { return t - p.t <= CHECK_WINDOW_MS && fin(p.v) ? p.v : 0; }
// Условия по жестам: [key, код подсказки COACH_HINTS, точки кисти, transient]. Порядок — порядок исправления.
const LMK = (a) => Object.freeze(a);
const LM_WRIST = LMK([0, 9]), LM_PALM = LMK([0, 5, 17]), LM_TIPS = LMK([8, 12, 16, 20]), LM_TIPS5 = LMK([4, 8, 12, 16, 20]);
const FRAME_ITEMS = [['frame', 'hand_edge', LM_WRIST], ['near', 'hand_far', LM_WRIST]];
const CHECK_SPEC = Object.freeze({
  ok: { hand: 'right', items: [['ring', 'ok_ring_open', LMK([4, 8])], ['others', 'ok_fingers', LMK([12, 16, 20])], ['index', 'ok_ring_open', LMK([6, 8])], ...FRAME_ITEMS] },
  shield: { hand: 'left', items: [['open', null, LM_TIPS], ['facing', 'shield_palm', LM_PALM], ['push', 'shield_push', LM_WRIST, true], ...FRAME_ITEMS] },
  spark: { hand: 'right', items: [['load', null, LMK([4, 8, 12]), true], ['index', 'spark_one', LMK([6, 8])], ['middle', 'spark_one', LMK([12])], ['rest', 'spark_one', LMK([16, 20])], ...FRAME_ITEMS] },
  burst: { hand: 'right', items: [['fist', null, LM_TIPS, true], ['charge', 'burst_short', LM_TIPS5, true], ['snap', 'burst_slow', LM_TIPS5, true], ...FRAME_ITEMS] },
  parry: { hand: 'left', items: [['fist', null, LM_TIPS, true], ['facing', 'parry_palm', LM_PALM], ['snap', 'parry_slow', LM_TIPS5, true], FRAME_ITEMS[0]] },
  orb: { hand: 'both', items: [['both', 'hands_missing', LM_WRIST], ['open', null, LM_TIPS], ['facing', 'orb_facing', LM_PALM], ['level', 'orb_dy', LM_WRIST], ['gap', 'orb_far', LM_WRIST]] },
});
const CHECK_SEEN_MS = 150;   // кисть пропала на кадр-два — условия показываются по последнему кадру, без мигания
// Записи для показа (решения их не читают): лучшие значения условий-движений и время последних импульсов.
function newChk() {
  const side = () => ({ wasFist: false, fistAt: -Infinity, charge: newPeak(), held: newPeak(), curl: newPeak(), relAt: null, snap: null });
  return {
    push: newPeak(), pushDbg: null, load: newPeak(), loadOkAt: -Infinity, loadLeft: null, flickMissAt: -Infinity,
    sparkAt: -Infinity, burstAt: -Infinity, parryAt: -Infinity, left: side(), right: side(),
  };
}

// ───────────────────────────── фабрика ─────────────────────────────
export function createHandGestures(configPatch = {}) {
  let cfg = mergeConfig(DEFAULT_HAND_CONFIG, configPatch);
  const stick = createLeftStick(configPatch && configPatch.stick);
  // [V5] схема движения левой рукой: 'stick' — джойстик (хватка «замри»), 'steer' — «Руль»
  // (высота ладони — шаг/бег/стоп, смещение вбок — поворот; core/steerStick.js). Игра по умолчанию
  // включает «Руль» через vision (config.defaultSettings.moveMode); сам модуль по умолчанию — джойстик.
  const steer = createSteerStick(configPatch && configPatch.steer);
  let moveMode = configPatch && configPatch.moveMode === 'steer' ? 'steer' : 'stick';
  const mover = () => (moveMode === 'steer' ? steer : stick);
  // [НОВИЧОК] профиль жестов: 'master' (по умолчанию модуля — всё как раньше) или 'novice'
  let profile = configPatch && configPatch.profile === 'novice' ? 'novice' : 'master';
  let enabled = new Set(GESTURE_PROFILES[profile]);
  const on = (g) => enabled.has(g);
  // «насколько левая рука сейчас рулит» — для гейтов щита, парирования, чар: у джойстика — длина
  // выхода; у руля — только поворот (подъём руки для шага сам по себе щит и чары не запрещает)
  const steering = (so) => (!so || !so.engaged ? 0 : so.mode === 'steer' ? Math.abs(so.turn || 0) : Math.hypot(so.x, so.z));

  function newHand(side) {
    return {
      side, present: false, firstSeen: null, lastSeen: null,
      rawShape: 'unknown', candidate: 'unknown', candidateSince: 0, shape: 'unknown', shapeSince: 0,
      extended: [false, false, false, false, false], pinchLevel: 0, conf: 0, palmFacing: 'unknown', cross: 0,
      center: null, tip: null, palmSize: 0, landmarks: null,
      fistStableAt: null, charge: 0, releasedAt: null, releaseCharge: 0,
      loadSince: null, loadLeft: null, // «Искра»: заряд и момент выхода из него
      scaleHist: [], pushAt: -Infinity, // [V3] толчок ладонью к камере (щит)
      pushRun: 0, pushBase: null, pushBaseRun: null, scaleN: null, // [V6] кадров толчка подряд, размер до толчка, сглаженный размер/sw
      rel: [], // история {t, x} относительно корпуса (для взмаха)
      feat: null,
    };
  }

  // [W3-MAGIC] состояние «ладони вместе → растянуть»
  function newStretch() {
    return { since: null, togEnd: null, togSeen: null, togGap: 0, lost: false, prime: null, axis: null, hist: [] };
  }

  let st;
  function reset() {
    st = {
      hands: { left: newHand('left'), right: newHand('right') },
      lastObsT: null, frameDt: 33, mirror: true, aspect: 4 / 3, standing: false, unitK: 1,
      pulses: { burst: null, rune: null, runeFizzle: null, dash: null, throw: null, dashDir: null, parry: null, spark: null, slash: null, sigil: null, hint: null },
      coach: { until: {}, gapUntil: -Infinity, near: {}, counts: {}, noHandsSince: null },
      sig: { hist: [], frameSince: null, frameFired: false, blockedUntil: -Infinity },
      str: newStretch(),   // [W3-MAGIC] «ладони вместе → растянуть»
      twin: null,   // [V3] двуручное рисование: { phase: 'arming'|'drawing', ... }
      burstBlockedUntil: -Infinity, pendingBurst: null,
      parryBlockedUntil: -Infinity, sparkBlockedUntil: -Infinity, strokeBlockedUntil: -Infinity,
      stickState: null,
      shield: { on: false, openSince: null, badSince: null, base: null, peak: null, baseRaw: null, peakRaw: null, back: 0, lastT: null, vertT: null },
      stroke: null, trail: [], trailUntil: -Infinity, lastRune: null, runeBlockedUntil: -Infinity, lastRecognition: null,
      tipF: null,
      swipe: { armed: true, until: -Infinity },
      counters: { obs: 0, bursts: 0, runes: 0, fizzles: 0, dashes: 0, badObs: 0, conjures: 0, throws: 0, parries: 0, sparks: 0, slashes: 0, sigils: 0, hints: 0 },
      conj: newConj(),
      chk: newChk(),   // [ОШИБКА] прогресс условий для тренажёра техники (только показ)
    };
    stick.reset();
    steer.reset();
  }
  reset();

  const disp = (p) => ({ x: st.mirror ? 1 - p.x : p.x, y: p.y });

  function assign(hands, poseWrists) {
    // Возвращает { left: hand|null, right: hand|null } по сторонам игрока.
    const out = { left: null, right: null };
    const pw = isObj(poseWrists) ? poseWrists : {};
    const ok = (w) => isObj(w) && fin(w.x) && fin(w.y) && (!fin(w.visibility) || w.visibility >= 0.3);
    const L = ok(pw.left) ? pw.left : null, R = ok(pw.right) ? pw.right : null;
    const d = (h, w) => Math.hypot((h.img[0].x - w.x) * st.aspect, h.img[0].y - w.y);
    if (hands.length === 2 && L && R) {
      const a = d(hands[0], L) + d(hands[1], R), b = d(hands[0], R) + d(hands[1], L);
      if (a <= b) { out.left = hands[0]; out.right = hands[1]; } else { out.left = hands[1]; out.right = hands[0]; }
      return out;
    }
    for (const h of hands) {
      let side = null;
      if (L && R) {
        side = d(h, L) <= d(h, R) ? 'left' : 'right';
      } else if (L || R) {
        // видно одно запястье: кисть его, только если рядом с ним; иначе — другая рука
        const w = L || R, near = d(h, w) <= 0.15;
        side = (L ? near : !near) ? 'left' : 'right';
      } else if (h.handedness === 'Left' || h.handedness === 'Right') {
        // На реальных кадрах метка совпадает со стороной по запястьям позы (см. шапку файла).
        side = h.handedness === 'Left' ? 'left' : 'right';
      } else {
        // крайний случай: по положению в незеркальном кадре (правая рука игрока — слева в кадре)
        side = h.img[0].x < 0.5 ? 'right' : 'left';
      }
      if (out[side]) {
        const other = side === 'left' ? 'right' : 'left';
        if (!out[other]) out[other] = h;
      } else out[side] = h;
    }
    return out;
  }

  function updateHand(H, data, t, bodyCenter) {
    if (!data) {
      if (H.present && H.lastSeen !== null && t - H.lastSeen > lostGrace()) {
        const side = H.side;
        Object.assign(H, newHand(side));
      }
      // [НИЗКАЯ ЧАСТОТА] короткий пропуск (кадр-другой посреди взмаха — смаз) историю взмаха не стирает:
      // скорость всё равно считается по реальному времени между кадрами
      if (H.present && H.rel.length && t - H.rel[H.rel.length - 1].t > Math.max(cfg.swipeWindowMs, 2.5 * st.frameDt)) { H.rel.length = 0; }
      return;
    }
    if (!H.present) { H.present = true; H.firstSeen = t; }
    H.lastSeen = t;
    const f = handFeatures(data.img, data.world, st.aspect, cfg);
    // [ЩИТ НЕ МИГАЕТ] форма — по сглаженным точкам (One-Euro), позиции и размер — по сырым (f)
    let fs = f;
    if (cfg.shapeFilter > 0) {
      const E = H.euro || (H.euro = { img: {}, world: {} });
      const I = data.img, palmImg = Math.hypot((I[9].x - I[0].x) * st.aspect, I[9].y - I[0].y);
      const img = euroPoints(E.img, data.img, t, palmImg, cfg);
      const world = data.world ? euroPoints(E.world, data.world, t, dist(data.world[0], data.world[9]), cfg) : null;
      fs = handFeatures(img, world, st.aspect, cfg);
      fs.I = f.I; fs.scale = f.scale; fs.n3 = f.n3; fs.palm2d = f.palm2d;
    }
    H.feat = fs;
    const c = classify(fs, H, cfg);
    H.rawShape = c.shape;
    H.extended = c.extended;
    H.pinchLevel = c.pinchLevel;
    H.conf = c.conf * clamp(fin(data.score) ? data.score : 1, 0, 1);
    // палец/ладонь. Правая кисть ладонью к камере: указательный правее мизинца в незеркальном
    // кадре → cross < 0 (y вниз). Левая — наоборот.
    const s = H.side === 'right' ? 1 : -1;
    H.cross = fs.cross;
    // [ЩИТ НЕ МИГАЕТ] гистерезис: ладонь у границы «ребро / к камере» не переключается от шума точек
    const sideLim = cfg.palmSideRatio + (H.palmFacing === 'side' ? cfg.palmSideHyst : H.palmFacing === 'unknown' ? 0 : -cfg.palmSideHyst);
    H.palmFacing = Math.abs(fs.cross) < sideLim ? 'side' : (fs.cross * s < 0 ? 'camera' : 'away');
    // для двуручных чар: точки кадра с поправкой на соотношение сторон, масштаб, нормаль ладони
    H.pts = f.I;
    H.scale = f.scale;
    H.normal = f.n3 ? { x: s * f.n3.x, y: s * f.n3.y, z: s * f.n3.z } : null;
    // стабилизация формы
    if (c.shape !== H.candidate) { H.candidate = c.shape; H.candidateSince = t; }
    const need = cfg.hold[H.candidate] ?? 120;
    if (H.candidate !== H.shape && t - H.candidateSince >= need) { H.shape = H.candidate; H.shapeSince = t; }
    // положения для показа
    H.landmarks = data.img.map(disp);
    let cx = 0, cy = 0;
    for (const i of [0, 5, 9, 13, 17]) { cx += data.img[i].x; cy += data.img[i].y; }
    H.center = disp({ x: cx / 5, y: cy / 5 });
    H.tip = disp(data.img[8]);
    H.palmSize = f.palm2d;
    // история для взмаха: x центра в высотах кадра относительно корпуса, в координатах показа
    const bc = isObj(bodyCenter) && fin(bodyCenter.x) ? disp(bodyCenter) : null;
    const relX = (H.center.x - (bc ? bc.x : 0)) * st.aspect;
    H.rel.push({ t, x: relX });
    while (H.rel.length > 24 || (H.rel.length && t - H.rel[0].t > Math.max(cfg.swipeWindowMs * 2, 3 * st.frameDt))) H.rel.shift();
    // толчок к камере: кисть растёт в кадре быстрее плеч (наклон всем корпусом не считается),
    // центр ладони почти не сдвигается в плоскости кадра (иначе это ведение джойстика/подъём руки).
    // Пока кисть не «готова» (только что появилась, часто обрезана краем) — история не копится.
    const sw = fin(st.obsSw) && st.obsSw > 0 ? st.obsSw : null;
    // [V6] Размер кисти для толчка — два признака, оба сглажены (один шумный кадр толчком не станет):
    //  • span — средний 2D-размах точек ладони (0, 1, 5, 9, 13, 17): шумит почти вдвое меньше
    //    f.scale (≈3 % против ≈5 % на кадр), главный признак; он же (÷ ширину плеч) — для «убрал назад»;
    //  • f.scale — по world-точкам, не зависит от поворота кисти: подтверждает, что кисть правда
    //    приблизилась, а не развернулась ладонью к камере.
    {
      const ids = SPAN_IDS, I = ids.map((i) => ({ x: data.img[i].x * st.aspect, y: data.img[i].y }));
      let span = 0;
      for (let i = 0; i < I.length; i++) for (let j = i + 1; j < I.length; j++) span += Math.hypot(I[i].x - I[j].x, I[i].y - I[j].y);
      span /= (I.length * (I.length - 1)) / 2;
      const gap = H.lastScaleT === undefined ? Infinity : t - H.lastScaleT;
      // после пропуска кадров — обычный шаг фильтра на один кадр (пропуск не несёт данных; иначе первый
      // же шумный кадр после провала целиком попадал в «размер»); кисть потеряна насовсем — с нуля
      // [СТОЯ] шумная (мелкая) кисть — размер сглаживается дольше
      const noiseK = clamp((H.jit ?? cfg.shieldJitRef) / (cfg.shieldJitRef * cfg.shieldJitDead), 1, cfg.shieldNoiseMax);
      H.noiseK = noiseK;
      const a = gap > lostGrace() ? 1 : 1 - Math.exp(-Math.min(gap, Math.max(50, 1.5 * st.frameDt)) / (cfg.shieldScaleTauMs * noiseK));
      H.scaleF = H.scaleF === undefined || a === 1 ? f.scale : H.scaleF + (f.scale - H.scaleF) * a;
      H.spanF = H.spanF === undefined || a === 1 ? span : H.spanF + (span - H.spanF) * a;
      // насколько ладонь смотрит в камеру (|z| нормали по world-точкам): поворот ладони к камере тоже
      // «растит» кисть в 2D — это не толчок
      const nz = f.n3 ? Math.abs(f.n3.z) : null;
      H.nzF = nz === null ? null : H.nzF == null || a === 1 ? nz : H.nzF + (nz - H.nzF) * a;
      H.scaleN = sw && H.spanF > 1e-6 ? H.spanF / sw : null;
      // без сглаживания (после пропуска кадров фильтр ещё «помнит» старое), но медиана трёх последних
      // кадров — один выброс трекинга (кисть на кадр «выросла»/«сжалась») её не сдвигает
      if (a === 1 || !H.spanRaw) H.spanRaw = [];
      // [СТОЯ] дрожание размера кисти от кадра к кадру (|ln| отношения соседних кадров, сглажено ~1,5 с): у мелкой
      // кисти (игрок стоит дальше от камеры) шум точек MediaPipe в пикселях тот же — относительный больше
      const prevRaw = H.spanRaw.length ? H.spanRaw[H.spanRaw.length - 1] : null;
      // медиана за shieldJitTauMs: кадры самого толчка (резкий рост) оценку шума не сдвигают
      if (prevRaw && gap <= Math.max(60, 1.6 * st.frameDt)) {
        const B = H.jitBuf || (H.jitBuf = []);
        B.push({ t, j: Math.abs(Math.log(span / prevRaw)) });
        while (B.length > 60 || (B.length && t - B[0].t > cfg.shieldJitTauMs)) B.shift();
        if (B.length >= 8) { const q = B.map((e) => e.j).sort((x, y) => x - y); H.jit = q[q.length >> 1]; }
      }
      H.spanRaw.push(span); if (H.spanRaw.length > 3) H.spanRaw.shift();
      const med = H.spanRaw.length < 3 ? span : [...H.spanRaw].sort((p, q) => p - q)[1];
      H.spanNow = med; H.spanNowN = sw ? med / sw : null;
      H.lastScaleT = t;
    }
    if (!ready(H, t)) { H.scaleHist.length = 0; H.pushRun = 0; }
    else {
      const pcx = (data.img[0].x + data.img[9].x) / 2 * st.aspect, pcy = (data.img[0].y + data.img[9].y) / 2;
      // [НИЗКАЯ ЧАСТОТА] последний кадр перед пропуском кисти (толчок мог целиком прийтись на пропуск)
      const last = H.scaleHist[H.scaleHist.length - 1];
      const preGap = last && t - last.t > Math.max(90, 1.6 * st.frameDt) && t - last.t <= cfg.shieldGapPushMs ? { ...last } : null;
      H.scaleHist.push({ t, s: H.scaleF, p: H.spanF, nz: H.nzF, sw, x: pcx, y: pcy });
      // [НИЗКАЯ ЧАСТОТА] окно толчка — не меньше shieldPushWindowFrames интервалов кадров
      const pm0 = moveMode === 'steer' ? cfg.shieldPushMsSteer : cfg.shieldPushMs;
      const pm = Math.max(pm0, cfg.shieldPushWindowFrames * st.frameDt);
      while (H.scaleHist.length > 30 || (H.scaleHist.length && t - H.scaleHist[0].t > pm + 60)) H.scaleHist.shift();
      const hs = H.scaleHist, n = hs.length, b = hs[0];
      let pushing = false, base = 0, baseNz = null, baseT0 = t;
      // [НИЗКАЯ ЧАСТОТА] окно длиннее обычного — порог выше на возможный медленный дрейф ладони за добавочное время
      const ratio = (moveMode === 'steer' ? cfg.shieldPushRatioSteer : cfg.shieldPushRatio) + cfg.shieldDriftPerSec * (pm - pm0) / 1000;
      if (n >= 3 && t - b.t >= pm * 0.5 && b.s > 1e-6 && b.p > 1e-6) {
        // размер образца в масштабе текущих плеч (наклон всем корпусом не считается);
        // база — минимум в окне (откуда толчок начался): рука перед толчком могла чуть отъехать назад
        const k = (q) => (sw && q.sw ? sw / q.sw : 1);
        let minP = Infinity, minS = Infinity, minI = 0;
        for (let i = 0; i < n - 1; i++) {
          const pi = hs[i].p * k(hs[i]);
          if (pi < minP) { minP = pi; minI = i; }
          minS = Math.min(minS, hs[i].s * k(hs[i]));
        }
        base = minP;
        baseNz = hs[minI].nz; baseT0 = hs[minI].t;
        const turned = H.nzF !== null && baseNz !== null ? Math.abs(H.nzF - baseNz) : 0;
        // среднее с прошлым кадром гасит одиночный шумный кадр; на низкой частоте прошлый кадр — уже середина
        // толчка (кадр 100–170 мс), и шум гасит требование двух кадров подряд (shieldPushFrames)
        const lowRate = st.frameDt >= 55;
        const cur = lowRate ? H.spanF : (H.spanF + hs[n - 2].p * k(hs[n - 2])) / 2;
        const scaleUp = (lowRate ? H.scaleF : (H.scaleF + hs[n - 2].s * k(hs[n - 2])) / 2) / minS;
        const shift = Math.hypot(pcx - b.x, pcy - b.y) / Math.max(1e-4, f.scale);
        // толчок — быстрый: где-то в окне размах вырос на долю shieldPushFastShare порога за ~shieldPushFastMs.
        // Медленный дрейф руки к камере (≈3 % за такое время) так не может, сколько бы ни набежало за окно
        let fast = 0;
        for (let j = 1, i = 0; j < n; j++) {
          while (i + 1 < j && hs[j].t - hs[i + 1].t >= cfg.shieldPushFastMs) i++;
          if (hs[j].t - hs[i].t >= cfg.shieldPushFastMs * 0.6) fast = Math.max(fast, (hs[j].p * k(hs[j])) / Math.max(1e-6, hs[i].p * k(hs[i])));
        }
        pushing = base > 1e-6 && cur / base >= ratio && fast >= 1 + (ratio - 1) * cfg.shieldPushFastShare && scaleUp >= cfg.shieldPushScaleCheck
          && shift < cfg.shieldPushShift && turned < cfg.shieldPushTurnMax;
        H.pushDbg = { span: cur / Math.max(1e-6, base), fast, scale: scaleUp, shift, turned };
      }
      // [НИЗКАЯ ЧАСТОТА] кисть вернулась после пропуска уже у камеры — на том же месте, не развёрнутой, заметно
      // крупнее последнего кадра до пропуска (с запасом к порогу, без проверки скорости — кадров в пропуске нет).
      // Это начало толчка; второй кадр подтвердит его через закреплённую точку (ниже), как обычно
      if (!pushing && preGap && H.pushRun === 0 && preGap.p > 1e-6 && preGap.s > 1e-6) {
        const k = sw && preGap.sw ? sw / preGap.sw : 1;
        const spanNowRaw = H.spanRaw[H.spanRaw.length - 1];
        const grown = spanNowRaw / (preGap.p * k);   // сглаженный размер после пропуска ещё «помнит» старое — берём кадр
        const scaleUp = H.scaleF / (preGap.s * k);
        const shift = Math.hypot(pcx - preGap.x, pcy - preGap.y) / Math.max(1e-4, f.scale);
        const turned = H.nzF !== null && preGap.nz !== null ? Math.abs(H.nzF - preGap.nz) : 0;
        if (grown >= ratio + cfg.shieldPushPinMargin && scaleUp >= cfg.shieldPushScaleCheck && shift < cfg.shieldPushShift && turned < cfg.shieldPushTurnMax) {
          pushing = true; base = preGap.p * k; baseNz = preGap.nz; baseT0 = preGap.t;
        }
      }
      // толчок уже начался (кадр подтверждения ещё не набран), а кисть на миг пропала из трекинга:
      // за пропуск окно «уезжает» внутрь толчка — досчитываем его от закреплённой точки старта
      const P0 = H.pushPin;
      if (!pushing && H.pushRun > 0 && P0 && t - P0.t <= cfg.shieldPushKeepMs) {
        const k0 = sw && P0.sw;
        const cur = k0 ? H.spanF / sw : H.spanF, now = k0 ? H.spanNowN : H.spanNow, ref = k0 ? P0.pn : P0.p;
        const turned = H.nzF !== null && P0.nz !== null ? Math.abs(H.nzF - P0.nz) : 0;
        // без проверки скорости (кадров в пропуске нет) — с запасом: медленный дрейф через пропуск не толчок
        pushing = Math.min(cur, now) / Math.max(1e-6, ref) >= ratio + cfg.shieldPushPinMargin && turned < cfg.shieldPushTurnMax;
      }
      if (pushing) {
        H.pushRun++;
        if (H.pushRun === 1) {
          H.pushBaseRun = sw ? base / sw : null;   // размах ладони до толчка (в ширинах плеч)
          H.pushBaseRunRaw = base;                 //   и в кадре (плеч не видно — сравниваем так)
          H.pushPin = { t, p: base, pn: sw ? base / sw : null, sw: !!sw, nz: baseNz };
          H.pushT0 = baseT0;   // когда толчок начался (самая маленькая кисть в окне)
        }
        if (H.pushRun >= cfg.shieldPushFrames) { H.pushAt = t; H.pushBase = H.pushBaseRun; H.pushBaseRaw = H.pushBaseRunRaw; }
      } else { H.pushRun = 0; H.pushPin = null; }
    }
  }

  const lostGrace = () => Math.max(cfg.lostGraceMs, cfg.lostGraceFrames * st.frameDt);
  function ready(H, t) { return H.present && H.firstSeen !== null && t - H.firstSeen >= cfg.reacquireMs; }

  function updateCharge(H, t) {
    if (H.shape === 'fist' && H.present) {
      if (H.fistStableAt === null) H.fistStableAt = t;
      H.charge = clamp((t - H.fistStableAt) / cfg.chargeMs, 0, 1);
      H.releasedAt = null;
    } else if (H.fistStableAt !== null) {
      // вышли из кулака: окно на раскрытие
      H.releasedAt = t;
      H.releaseCharge = H.charge;
      H.releaseHeldMs = t - H.fistStableAt;
      H.fistStableAt = null;
      H.charge = 0;
    }
    if (!H.present) { H.fistStableAt = null; H.charge = 0; H.releasedAt = null; }
    if (H.releasedAt !== null && t - H.releasedAt > cfg.releaseWindowMs) {
      // [ОШИБКА] заряженный правый кулак раскрывался слишком медленно (или не до конца)
      // Сглаживание формы (One-Euro) запаздывает: кисть уже раскрывается (raw 'open'), а устойчивая форма ещё
      // не 'open' — это тоже медленное раскрытие, иначе игрок не получит ни выброса, ни подсказки.
      const slowOpen = H.rawShape === 'unknown' || (H.rawShape === 'open' && H.shape !== 'open');
      if (H.side === 'right' && H.present && H.releaseCharge >= cfg.minCharge && slowOpen && !st.stroke) hint('burst_slow', t, { side: 'right' });
      H.releasedAt = null;
    }
  }

  // Выброс «кулак → ладонь»: правой или двумя руками. Левая одна делает парирование (ладонь к камере).
  function tryBurst(t) {
    const L = st.hands.left, R = st.hands.right;
    const opened = (H) => H.releasedAt !== null && H.rawShape === 'open' && ready(H, t);
    const charged = (H) => H.releaseCharge >= cfg.minCharge;
    const stillCharging = (H) => H.present && H.shape === 'fist' && H.charge >= cfg.minCharge;
    const oL = opened(L), oR = opened(R) && charged(R);
    if (oL && oR && charged(L)) {
      if (t >= st.burstBlockedUntil) firePulse('burst', t, { power: clamp(Math.max(L.releaseCharge, R.releaseCharge) + cfg.bothHandsBonus, 0, 1), both: true, hand: 'both' });
      L.releasedAt = null; R.releasedAt = null;
      return;
    }
    if (opened(R) && !charged(R)) {
      // [ОШИБКА] кулак раскрыт, но заряд не набран (кулак стоял меньше ~0,3 с)
      if (R.releaseCharge > 0.05 && !st.conj.on) hint('burst_short', t, { side: 'right' });
      R.releasedAt = null;
    }
    if (oR) {
      const lSteering = steering(mover().read(t)) > 0.2;
      if (stillCharging(L) && !lSteering && t - R.releasedAt < cfg.pairWindowMs) return; // ждём левую — выброс двумя
      if (t >= st.burstBlockedUntil) firePulse('burst', t, { power: R.releaseCharge, both: false, hand: 'right' });
      R.releasedAt = null;
    }
    if (oL) {
      if (charged(L) && stillCharging(R) && t - L.releasedAt < cfg.pairWindowMs) return; // ждём правую
      if (!on('parry')) { L.releasedAt = null; return; }   // [НОВИЧОК] левая одна «кулак → ладонь» не парирует
      // подсказки парирования — только если левая явно толкнула к камере (а не просто расслабила кулак)
      const meant = t - L.pushAt <= 500;
      if (L.palmFacing === 'camera') {
        const calm = steering(mover().read(t)) < cfg.parryStickMax;
        if (t - L.releasedAt <= cfg.parryWindowMs && t >= st.parryBlockedUntil && !st.conj.on && (L.releaseHeldMs || 0) >= cfg.parryFistMs && calm) {
          firePulse('parry', t, { fromCharge: L.releaseCharge });
          st.parryBlockedUntil = t + cfg.parryRefractoryMs;
        } else if (t - L.releasedAt > cfg.parryWindowMs && meant) hint('parry_slow', t, { side: 'left' });
        L.releasedAt = null;
      } else if (t - L.releasedAt > cfg.parryWindowMs) {
        if (meant && L.palmFacing !== 'camera') hint('parry_palm', t, { side: 'left' });
        L.releasedAt = null;
      }
    }
  }

  // «Искра»: «заряд» (кулак или большой у кончиков указательного/среднего, безымянный и мизинец согнуты)
  // → за ≤ sparkFlickMs выпрямился ТОЛЬКО указательный. Выброс раскрывает всю кисть — это не искра.
  function updateSpark(t) {
    const R = st.hands.right, f = R.feat;
    if (!R.present || R.lastSeen !== t || !f || !ready(R, t) || st.conj.on || st.conj.pending) { R.loadSince = null; R.loadLeft = null; return; }
    const curled = (i, extra = 0) => f.reach[i] < cfg.sparkCurl + extra;
    const loaded = Math.min(f.pinch, f.thumbMid) < cfg.sparkTouch && curled(0) && curled(1, 0.04) && curled(2, 0.04) && curled(3, 0.08);
    if (loaded) {
      if (R.loadSince === null) R.loadSince = t;
      R.loadLeft = null;
      return;
    }
    if (R.loadSince !== null && t - R.loadSince >= cfg.sparkLoadMs) R.loadLeft = t;
    R.loadSince = null;
    if (R.loadLeft === null) return;
    if (t - R.loadLeft > cfg.sparkFlickMs) { R.loadLeft = null; return; }
    const flicked = f.reach[0] > cfg.sparkExtend && f.pinch > cfg.sparkOpen && curled(2, 0.06) && curled(3, 0.1);
    // [ОШИБКА] вместе с указательным выпрямился и средний («V»), безымянный и мизинец согнуты
    if (!flicked && f.reach[0] > cfg.sparkExtend && f.reach[1] > cfg.sparkExtend && curled(2, 0.06) && curled(3, 0.1)) hint('spark_one', t, { side: 'right' });
    if (flicked && t >= st.sparkBlockedUntil) {
      firePulse('spark', t, {});
      st.sparkBlockedUntil = t + cfg.sparkRefractoryMs;
      st.strokeBlockedUntil = t + cfg.sparkStrokeBlockMs;
      R.loadLeft = null;
      R.releasedAt = null; // выход из кулака — щелчок, не выброс
    }
  }

  // [V3] щит с гистерезисом: подъём — осознанный (толчок или ладонь стоит), удержание — пока ладонь к камере
  function updateShield(t) {
    const L = st.hands.left, S = st.shield;
    const busy = st.conj.on || !!st.conj.pending || t < st.conj.quietUntil;
    const facing = L.present && L.lastSeen === t && ready(L, t) && L.rawShape === 'open' && L.palmFacing === 'camera' && L.fistStableAt === null;
    if (!facing || busy) {
      // [ОШИБКА] толчок раскрытой левой был, но ладонь смотрит вбок или тыльной стороной
      if (!busy && L.present && L.lastSeen === t && L.rawShape === 'open' && L.palmFacing !== 'camera' && t - L.pushAt <= 250) hint('shield_palm', t, { side: 'left' });
      S.openSince = null;
      if (S.on) {
        if (S.badSince === null) S.badSince = t;
        // кисть видна, но не ладонь к камере — опускаем быстро; кисть просто пропала из трекинга — ждём дольше
        const seenWrong = L.present && L.lastSeen === t;
        if (busy || t - S.badSince >= (seenWrong ? Math.max(cfg.shieldDropMs, cfg.shieldDropFrames * st.frameDt) : Math.max(cfg.shieldLostMs, lostGrace()))) { S.on = false; S.badSince = null; S.base = null; S.baseRaw = null; S.back = 0; S.lvl = null; }
      }
      return;
    }
    S.badSince = null;
    if (S.openSince === null) S.openSince = t;
    if (S.on) {
      // [V6] ладонь убрали назад (к размеру до толчка) — щит опускается, даже если она к камере:
      // иначе в «Руле» случайный щит держался бы, пока рука ведёт героя (ладонь и так к камере)
      // размер — в ширинах плеч; плеч не видно (ладонь закрыла плечо) — в кадре
      const norm = S.base !== null && L.scaleN !== null;
      const raw = norm ? L.scaleN : S.baseRaw !== null && fin(L.spanF) ? L.spanF : null;
      if (raw !== null) {
        const base = norm ? S.base : S.baseRaw;
        // [ЩИТ НЕ МИГАЕТ] сглаженный размер (по реальному времени) и пик, который медленно спадает к нему
        const dtR = S.lastT === null ? 0 : Math.max(0, t - S.lastT);
        if (S.lvl == null || S.lvlNorm !== norm) { S.lvl = raw; S.lvlNorm = norm; }
        else S.lvl += (raw - S.lvl) * (1 - Math.exp(-dtR / cfg.shieldHoldTauMs));
        const cur = S.lvl;
        const decay = 1 - Math.exp(-dtR / cfg.shieldPeakTauMs);
        if (norm) S.peak = Math.max(cur, (S.peak || cur) + (cur - (S.peak || cur)) * decay);
        else S.peakRaw = Math.max(cur, (S.peakRaw || cur) + (cur - (S.peakRaw || cur)) * decay);
        const peak = norm ? S.peak : S.peakRaw;
        const thr = Math.max(base * (1 + cfg.shieldRetract), peak - (peak - base) * cfg.shieldRetractShare);
        // копилка «ладонь убрана» — в реальном времени (кадр на 8 Гц весит 125 мс), но не меньше shieldRetractFrames кадров
        const dt = Math.min(Math.max(100, 1.5 * st.frameDt), dtR);
        S.back = cur < thr ? S.back + dt : Math.max(0, S.back - dt);
        if (S.back >= Math.max(cfg.shieldRetractMs, cfg.shieldRetractFrames * st.frameDt)) { S.on = false; S.back = 0; S.base = null; S.baseRaw = null; S.lvl = null; L.pushAt = -Infinity; }
      }
      S.lastT = t;
      return;
    }
    const so = mover().read(t);
    const mag = steering(so);
    const still = mag < cfg.shieldStickMax;
    const confirmed = t - S.openSince >= cfg.shieldConfirmMs;
    // [V6] «Руль»: подъём руки к груди (кисть растёт в кадре) — не толчок
    // рука идёт к плечу / вниз — это руль; толчок должен начаться, когда она уже не едет
    if (so && so.mode === 'steer' && fin(so.levelSpeed) && so.levelSpeed > cfg.shieldMaxLevelSpeed) S.vertT = t;
    const justRaised = so && so.mode === 'steer' && ((fin(so.raisedAt) && t - so.raisedAt < cfg.shieldAfterRaiseMs)
      || t - (S.vertT ?? -Infinity) < 40 || (fin(L.pushT0) && L.pushT0 <= (S.vertT ?? -Infinity)));
    // и ладонь всё ещё впереди: толчок, после которого кисть пропала и вернулась уже назад, щит не ставит
    const ratio = moveMode === 'steer' ? cfg.shieldPushRatioSteer : cfg.shieldPushRatio;
    const needK = 1 + (ratio - 1) * cfg.shieldStillShare;
    const stillForward = L.pushBase !== null && L.spanNowN !== null && L.scaleN !== null
      ? Math.min(L.spanNowN, L.scaleN) >= L.pushBase * needK
      : !fin(L.pushBaseRaw) || !fin(L.spanNow) || Math.min(L.spanNow, L.spanF) >= L.pushBaseRaw * needK;
    const fresh = t - L.pushAt <= cfg.shieldPushKeepMs;
    // толчок во время руления (рука идёт к плечу, вбок) или после которого ладонь уже не впереди —
    // аннулируется, а не ждёт конца движения (иначе щит вставал в конце подъёма руки на бег)
    if (fresh && (justRaised || mag >= cfg.shieldStickStart || !stillForward)) L.pushAt = -Infinity;
    const pushed = fresh && mag < cfg.shieldStickStart && confirmed && !justRaised && stillForward;
    if (pushed || (cfg.shieldHoldMs > 0 && still && t - S.openSince >= cfg.shieldHoldMs)) {
      S.on = true; S.back = 0; S.lastT = t; S.lvl = null;
      S.base = pushed ? L.pushBase : null; S.peak = L.scaleN;
      S.baseRaw = pushed && fin(L.pushBaseRaw) ? L.pushBaseRaw : null; S.peakRaw = fin(L.spanF) ? L.spanF : null;
    }
  }

  function firePulse(kind, t, data) {
    st.pulses[kind] = { tMs: t, ...data };
    if (kind === 'burst') { st.burstBlockedUntil = t + cfg.burstRefractoryMs; st.counters.bursts++; }
    if (kind === 'rune') st.counters.runes++;
    if (kind === 'runeFizzle') st.counters.fizzles++;
    if (kind === 'dash' || kind === 'dashDir') st.counters.dashes++;
    if (kind === 'throw') st.counters.throws++;
    if (kind === 'parry') st.counters.parries++;
    if (kind === 'spark') st.counters.sparks++;
    if (kind === 'slash') st.counters.slashes++;
    if (kind === 'sigil') st.counters.sigils++;
  }

  // ───────── [ТВИСТ «ОШИБКА»] подсказки ─────────
  function hint(code, t, data, cooldownMs) {
    if (profile === 'novice' && NOVICE_MUTED_HINTS.test(code)) return;   // [НОВИЧОК] о выключенных жестах молчим
    const C = st.coach;
    if (t < C.gapUntil || t < (C.until[code] ?? -Infinity)) return;
    C.until[code] = t + (fin(cooldownMs) ? cooldownMs : cfg.hintCooldownMs);
    C.gapUntil = t + cfg.hintGapMs;
    C.counts[code] = (C.counts[code] || 0) + 1;
    st.counters.hints++;
    st.pulses.hint = { tMs: t, code, ...data };
  }
  // Условие держится ms подряд (почти-поза, а не случайный кадр).
  function sustained(key, cond, t, ms) {
    const N = st.coach.near;
    if (!cond) { N[key] = null; return false; }
    if (N[key] == null) N[key] = t;
    return t - N[key] >= ms;
  }

  // Почти-позы, которые не видны изнутри отдельных детекторов: кадр, «OK», щит, сфера, призма.
  function updateCoach(t, obs) {
    const L = st.hands.left, R = st.hands.right, C = st.conj;
    // кадр: кистей нет, хотя запястья позы видны
    const pw = isObj(obs.poseWrists) ? obs.poseWrists : {};
    const wristSeen = [pw.left, pw.right].some((w) => isObj(w) && fin(w.y) && w.y < 0.9 && (!fin(w.visibility) || w.visibility >= 0.6));
    if (sustained('missing', wristSeen && !L.present && !R.present, t, cfg.hintMissingMs)) hint('hands_missing', t);
    for (const H of [L, R]) {
      const seen = H.present && H.lastSeen === t && H.landmarks;
      const e = cfg.hintEdge;
      const edge = seen && H.landmarks.some((p) => p.x < e || p.x > 1 - e || p.y < e || p.y > 1 - e);
      if (sustained(`edge_${H.side}`, edge, t, cfg.hintEdgeMs)) hint('hand_edge', t, { side: H.side });
      const farLim = cfg.hintFarScale * (st.standing ? cfg.hintFarStandK : 1);
      if (sustained(`far_${H.side}`, seen && H.scale > 0 && H.scale < farLim, t, cfg.hintFarMs)) hint(st.standing ? 'hand_far_stand' : 'hand_far', t, { side: H.side });
    }
    const busy = C.on || !!C.pending || !!st.stroke;
    // «OK» правой: кольцо почти замкнуто при выпрямленных остальных — или замкнуто, но остальные согнуты
    const f = R.feat;
    const rOk = R.present && R.lastSeen === t && f && ready(R, t) && !busy && R.rawShape !== 'pinch';
    const oth = cfg.okOthersReach;
    const othersStraight = f && f.reach[1] >= oth && f.reach[2] >= oth - 0.04 && f.reach[3] >= oth - 0.1;
    const indexBent = f && f.reach[0] <= f.reach[1] - cfg.okIndexDrop + 0.03;
    const ringAlmost = rOk && othersStraight && indexBent && f.pinch >= cfg.pinchOn && f.pinch < cfg.pinchOn * cfg.hintRingSlack;
    if (sustained('ok_ring', ringAlmost, t, cfg.hintNearMs)) hint('ok_ring_open', t, { side: 'right' });
    const partly = f ? [1, 2, 3].filter((i) => f.reach[i] >= 1.12).length : 0;
    const ringBent = rOk && f.pinch < cfg.pinchOn && !othersStraight && partly >= 1 && partly < 3 && R.rawShape !== 'fist';
    if (sustained('ok_fingers', ringBent, t, cfg.hintNearMs + 150)) hint('ok_fingers', t, { side: 'right' });
    // щит левой: открытая ладонь стоит к камере, но толчка не было
    const lSeen = L.present && L.lastSeen === t && ready(L, t) && !busy;
    const stk = mover().read(t);
    // в «Руле» поднятая ладонь — это ход вперёд, а не почти-щит: подсказку про толчок не даём
    const calmPalm = moveMode !== 'steer' && lSeen && L.rawShape === 'open' && L.palmFacing === 'camera' && !st.shield.on && !(stk && stk.engaged && steering(stk) > cfg.shieldStickMax);
    if (sustained('shield_push', calmPalm, t, 1600)) hint('shield_push', t, { side: 'left' });
    // [V5] «Руль»: руку подняли, но не до груди — «подними выше»; поворот наклоном корпуса — «рукой вбок»
    if (moveMode === 'steer') {
      const lv = stk && stk.levels, lvl = stk && fin(stk.level) ? stk.level : null;
      const low = !busy && lSeen && lv && lvl !== null && !stk.engaged && lvl < lv.walkOn && lvl > lv.walkOn - cfg.hintSteerLowBand && !!stk.rising;
      if (sustained('steer_low', low, t, cfg.hintSteerMs)) hint('steer_low', t, { side: 'left' }, cfg.hintSteerCooldownMs);
      const leanTurn = !busy && stk && stk.engaged && Math.abs(stk.lean || 0) > cfg.hintLeanSw && Math.abs(stk.turn || 0) < 0.15;
      if (sustained('steer_lean', leanTurn, t, cfg.hintLeanMs)) hint('steer_lean', t, { side: 'left' }, cfg.hintSteerCooldownMs);
    }
    // двумя руками: почти-сфера / почти-призма / чары держатся без броска
    const ev = C.lastEval;
    if (!C.on && ev) {
      const why = ev.kind ? null : ev.why;
      // подсказка — только при попытке: «сведи руки» — ладони уже друг к другу; «поверни ладони» —
      // хотя бы одна уже повёрнута ([V6]: иначе в «Руле» они сыпались при любой раскрытой правой)
      const fL = fin(ev.faceL) ? ev.faceL : null, fR = fin(ev.faceR) ? ev.faceR : null;
      const both = fL !== null && fR !== null && Math.min(fL, fR) >= cfg.hintOrbFacing;
      const one = fL !== null && fR !== null && Math.max(fL, fR) >= cfg.hintOrbFacing;
      const close = fin(ev.gap) && ev.gap <= cfg.hintOrbCloseGap;   // руки сведены, как для сферы
      // в «Руле», пока левая ведёт героя, раскрытые ладони — это руль, а не попытка сферы
      const skL = mover().read(t);
      const walking = moveMode === 'steer' && skL && skL.engaged && skL.z > 0 && !one;
      const orbCode = walking ? null : why === 'facing' ? (one || close ? 'orb_facing' : null) : why === 'dy' ? (both ? 'orb_dy' : null) : why === 'gap' && ev.gap > cfg.orbGapMax && both ? 'orb_far' : null;
      if (sustained('orb', !!orbCode, t, cfg.hintTwoHandMs)) hint(orbCode, t);
      if (sustained('prism', !ev.kind && !!ev.prismNear, t, cfg.hintTwoHandMs)) hint('prism_tips', t);
    } else { sustained('orb', false, t, 0); sustained('prism', false, t, 0); }
    if (!C.on) C.weakPushAt = null;
    else if (C.weakPushAt != null && t - C.weakPushAt > 400) { C.weakPushAt = null; hint('throw_weak', t); }
    if (C.on && t - C.onAt >= cfg.hintThrowHoldMs) hint('throw_hold', t);
  }

  function updateStroke(t) {
    const R = st.hands.right;
    const drawingNow = R.present && R.shape === 'point' && ready(R, t) && t >= st.strokeBlockedUntil;
    if (drawingNow) {
      const raw = { x: R.tip.x * st.aspect, y: R.tip.y }; // одинаковый масштаб по осям
      const a = st.tipF ? 1 - Math.exp(-Math.max(0, t - st.tipF.t) / cfg.tipTauMs) : 1;
      st.tipF = st.tipF ? { x: st.tipF.x + (raw.x - st.tipF.x) * a, y: st.tipF.y + (raw.y - st.tipF.y) * a, t } : { ...raw, t };
      const p = { x: st.tipF.x, y: st.tipF.y, t };
      if (!st.stroke) st.stroke = { t0: t, pts: [p], lastMove: t, len: 0 };
      const s = st.stroke;
      const last = s.pts[s.pts.length - 1];
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      const dtS = Math.max(1e-3, (t - last.t) / 1000);
      if (d > 0.004 * st.unitK) {
        s.pts.push(p); s.len += d;
        if (s.pts.length > 256) s.pts.splice(1, 1);
      }
      // [V3] «движется», если за последние runeStillWindowMs кончик ушёл дальше runeStillDist
      // (при живом дрожании трекинга мгновенная скорость почти всегда выше порога)
      let moved = false;
      for (let i = s.pts.length - 1; i >= 0; i--) {
        const q = s.pts[i];
        if (t - q.t > cfg.runeStillWindowMs) break;
        if (Math.hypot(p.x - q.x, p.y - q.y) > cfg.runeStillDist * st.unitK) { moved = true; break; }
      }
      if (d > 0.004 * st.unitK && d / dtS > cfg.runeStillSpeed * 4 * st.unitK) moved = true;   // быстрый рывок кончика — тоже движение
      if (moved) s.lastMove = t;
      st.trail = s.pts.slice(-96).map((q) => ({ x: q.x / st.aspect, y: q.y }));
      st.trailUntil = t + cfg.trailKeepMs;
      const bbox = strokeSize(s.pts) / st.unitK;   // [СТОЯ] в «сидячих» долях кадра
      // [ОШИБКА] мелкий, но явно нарисованный штрих тоже завершается на остановке — чтобы подсказать «крупнее»
      const smallDone = bbox >= cfg.runeMinSize * 0.45 && s.len / st.unitK >= cfg.runeMinSize && t - s.t0 >= 600;
      if (s.len > 0 && (bbox >= cfg.runeMinSize || smallDone) && t - s.lastMove >= cfg.runeEndStillMs) finishStroke(t, 'still');
      else if (t - s.t0 > cfg.runeMaxStrokeMs) finishStroke(t, 'too-long');
    } else {
      st.tipF = null;
      if (st.stroke) finishStroke(t, 'released');
    }
  }

  function strokeSize(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    return Math.hypot(maxX - minX, maxY - minY);
  }

  function finishStroke(t, why) {
    const s = st.stroke;
    st.stroke = null;
    if (!s) return;
    const dur = t - s.t0;
    const size = strokeSize(s.pts) / st.unitK;   // [СТОЯ] в «сидячих» долях кадра
    if (dur < cfg.runeMinStrokeMs || size < cfg.runeMinSize || s.pts.length < 10) {
      st.lastRecognition = { rune: null, reason: 'too-small', why, size };
      // [ОШИБКА] штрих явно начат (не просто мелькнул указательный): мелко или слишком быстро
      if (size >= cfg.runeMinSize * 0.45 && size < cfg.runeMinSize && dur >= 350 && s.len / st.unitK > cfg.runeMinSize * 0.8) hint('rune_small', t, { side: 'right' });
      else if (size >= cfg.runeMinSize && dur < cfg.runeMinStrokeMs) hint('rune_fast', t, { side: 'right' });
      return;
    }
    if (why === 'too-long') { firePulse('runeFizzle', t, { reason: 'too-long' }); st.lastRecognition = { rune: null, reason: 'too-long' }; hint('rune_long', t, { side: 'right' }); return; }
    if (t < st.runeBlockedUntil) return;
    // обрезаем неподвижный «хвост» в конце штриха
    const pts = s.pts.filter((p) => p.t <= s.lastMove + 40);
    const r = recognizeStroke(pts, { minScore: cfg.runeScore, margin: cfg.runeMargin });
    st.lastRecognition = { ...r, why, size: Math.round(size * 100) / 100, points: pts.length, durMs: Math.round(dur) };
    st.runeBlockedUntil = t + cfg.runeCooldownMs;
    if (r.rune) {
      firePulse('rune', t, { rune: r.rune, score: r.score });
      st.lastRune = { rune: r.rune, score: r.score, tMs: t };
    } else {
      firePulse('runeFizzle', t, { reason: r.reason, score: r.score });
      hint(runeHint(r), t, { side: 'right', guess: r.scores ? bestRune(r.scores) : null });
    }
  }

  // [ОШИБКА] что именно не так с нераспознанной руной: по ближайшему шаблону, замкнутости и углам.
  function bestRune(scores) { let b = null; for (const k of Object.keys(scores)) if (!b || scores[k] > scores[b]) b = k; return b; }
  function runeHint(r) {
    if (r.reason === 'line') return 'rune_line';
    if (!r.scores) return 'rune_unclear';
    const g = bestRune(r.scores);
    if (RUNES[g] && RUNES[g].closed && fin(r.gap) && r.gap >= 0.3) return 'rune_open';
    if (g === 'ignis') return 'rune_corners';
    if (g === 'fulgur') return 'rune_zigzag';
    if (g === 'orbis') return 'rune_round';
    if (RUNES[g] && r.scores[g] >= 0.6) return 'rune_near'; // похоже на одну из новых рун, но нечётко
    return 'rune_unclear';
  }

  function updateSwipe(t) {
    const R = st.hands.right;
    // [НИЗКАЯ ЧАСТОТА] окно взмаха — не короче ~1,2 интервала кадров; на 6–10 Гц хватает двух кадров истории
    const lowRate = st.frameDt >= 55;
    const win = Math.max(cfg.swipeWindowMs, 1.2 * st.frameDt);
    if (!R.present || !ready(R, t) || st.stroke || st.conj.on || st.conj.pending || R.rawShape !== 'open' || R.rel.length < (lowRate ? 2 : 3)) { if (!R.present) st.swipe.armed = true; return; }
    const last = R.rel[R.rel.length - 1];
    if (last.t !== t) return;   // кисть в этом кадре не видна — взмах по старым точкам не судим
    let first = R.rel[0];
    for (const e of R.rel) { if (last.t - e.t <= win) { first = e; break; } }
    const span = (last.t - first.t) / 1000;
    if (span < 0.05) return;
    // [СТОЯ] скорость и длина — в «сидячих» долях кадра (делим на масштаб плеч)
    const travel = (last.x - first.x) / st.unitK;
    const speed = travel / span;
    if (!st.swipe.armed) {
      if (Math.abs(speed) < cfg.swipeRearmSpeed && t >= st.swipe.until) st.swipe.armed = true;
      return;
    }
    if (t < st.swipe.until) return;
    if (Math.abs(speed) >= cfg.swipeSpeed && Math.abs(travel) >= cfg.swipeMinTravel) {
      firePulse('slash', t, { dir: Math.sign(travel), power: clamp((Math.abs(speed) - cfg.swipeSpeed) / (cfg.swipeSpeed * 1.5) + 0.35, 0, 1) });
      st.swipe.armed = false;
      st.swipe.until = t + cfg.swipeRefractoryMs;
      st.swipe.slowAt = null;
    } else if (Math.abs(speed) >= cfg.swipeSpeed * cfg.hintSlowSwipe && Math.abs(travel) >= cfg.swipeMinTravel * 1.3) {
      if (st.swipe.slowAt == null) st.swipe.slowAt = t; // [ОШИБКА] широкий, но медленный взмах — ждём, не разгонится ли
    }
  }
  function checkSlowSwipe(t) {
    const s = st.swipe;
    if (st.conj.on || st.conj.pending) s.slowAt = null;
    if (s.slowAt != null && t - s.slowAt > 320) { s.slowAt = null; if (t >= s.until) hint('slash_slow', t, { side: 'right' }); }
  }

  // ───────── двуручные чары: СФЕРА / ПРИЗМА (удержание) и бросок (импульс) ─────────
  // Все расстояния — в «ладонях» S (масштаб кисти в высотах кадра), точки — с поправкой на аспект.
  const PALM_IDX = [0, 5, 9, 13, 17];
  function palmCenter(H) {
    let x = 0, y = 0;
    for (const i of PALM_IDX) { x += H.pts[i].x; y += H.pts[i].y; }
    return { x: x / 5, y: y / 5 };
  }
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const lerpN = (a, b, k) => a + (b - a) * k;

  function newConj() {
    return {
      on: false, kind: null, onAt: 0, lastGood: 0, pending: null, size: 0, charge: 0, center: null, centerRaw: null,
      hist: [], throwBlockedUntil: -Infinity, quietUntil: -Infinity, lastEval: null,
    };
  }

  // Оценка позы: { kind, size, center } или null. cur — текущий вид чар (гистерезис).
  function evalConjure(L, R, cur) {
    if (!L.pts || !R.pts || !L.scale || !R.scale) return null;
    const S = (L.scale + R.scale) / 2;
    const cL = palmCenter(L), cR = palmCenter(R);
    const gapPx = d2(cL, cR);
    const gap = gapPx / S;
    const info = { gap: Math.round(gap * 100) / 100 };
    // ПРИЗМА: кончики больших вместе, кончики указательных вместе, между ними окно
    if (enabled.has('prism')) {   // [НОВИЧОК] в «Новичке» призмы нет — только сфера
      const on = cur === 'prism';
      const thumbs = d2(L.pts[4], R.pts[4]) / S, index = d2(L.pts[8], R.pts[8]) / S;
      const win = d2(mid(L.pts[8], R.pts[8]), mid(L.pts[4], R.pts[4])) / S;
      const tipLim = on ? cfg.prismTipOff : cfg.prismTipOn;
      const winLim = on ? cfg.prismWindowOff : cfg.prismWindowOn;
      const gapMin = on ? cfg.prismGapMinOff : cfg.prismGapMin;
      const facing = palmsFacing(L, R, cL, cR);
      const prayer = facing && facing.l > cfg.prismFacingVeto && facing.r > cfg.prismFacingVeto;
      Object.assign(info, { thumbs: Math.round(thumbs * 100) / 100, index: Math.round(index * 100) / 100, win: Math.round(win * 100) / 100 });
      if (thumbs <= tipLim && index <= tipLim && win >= winLim && gap >= gapMin && !prayer) {
        const size = clamp((win - cfg.prismSizeMin) / Math.max(1e-6, cfg.prismSizeMax - cfg.prismSizeMin), 0, 1);
        return { kind: 'prism', size, center: mid(mid(L.pts[8], R.pts[8]), mid(L.pts[4], R.pts[4])), info };
      }
      // [ОШИБКА] почти-призма: окно есть, но кончики не сомкнуты
      info.prismNear = !prayer && gap >= gapMin && win >= winLim * 0.7 && Math.max(thumbs, index) <= tipLim * 1.9 && (thumbs > tipLim || index > tipLim);
    }
    // СФЕРА: обе кисти раскрыты, ладони друг к другу, рядом по горизонтали, пальцы не касаются
    {
      const on = cur === 'orb';
      const openish = (H) => H.rawShape === 'open' || H.extended.slice(1).filter(Boolean).length >= 3;
      const no = (why) => ({ kind: null, info: { ...info, why } });
      if (!openish(L) || !openish(R)) return no('shape');
      // [V6] повёрнуты ли ладони друг к другу — и для подсказок: две ладони к камере (поза «Руля»
      // и раскрытая правая после выброса) — не попытка сферы, подсказки про сферу не нужны
      const facing0 = palmsFacing(L, R, cL, cR);
      if (facing0) { info.faceL = Math.round(facing0.l * 100) / 100; info.faceR = Math.round(facing0.r * 100) / 100; }
      const slack = on ? cfg.orbGapSlack : 0;
      if (gap < cfg.orbGapMin * (1 - slack) || gap > cfg.orbGapMax * (1 + slack)) return no('gap');
      const dy = Math.abs(cL.y - cR.y) / Math.max(1e-6, gapPx);
      if (dy > (on ? cfg.orbDyOff : cfg.orbDyOn)) return no('dy');
      const tipsApart = Math.min(d2(L.pts[8], R.pts[8]), d2(L.pts[12], R.pts[12])) / S;
      if (tipsApart < (on ? cfg.orbTipsApartOff : cfg.orbTipsApart)) return no('tips');
      // руки опущены (пальцы вниз) — это не сфера
      const down = (H) => { const v = { x: H.pts[9].x - H.pts[0].x, y: H.pts[9].y - H.pts[0].y }; return v.y / Math.max(1e-6, Math.hypot(v.x, v.y)); };
      if (down(L) > cfg.orbFingersDown && down(R) > cfg.orbFingersDown) return no('down');
      const facing = facing0;
      const fOn = on ? cfg.orbFacingOff : cfg.orbFacingOn;
      const sideOn = on ? cfg.orbSideOff : cfg.orbSideOn;
      const handOk = (H, f) => (f !== null && f >= fOn) || (Math.abs(H.cross) < sideOn && (f === null || f >= cfg.orbSideMinFacing));
      if (!handOk(L, facing ? facing.l : null) || !handOk(R, facing ? facing.r : null)) return no('facing');
      const size = clamp((gap - cfg.orbSizeMin) / Math.max(1e-6, cfg.orbSizeMax - cfg.orbSizeMin), 0, 1);
      return { kind: 'orb', size, center: mid(cL, cR), info };
    }
  }
  // Проекция нормалей ладоней (world) на направление к другой кисти в плоскости кадра.
  function palmsFacing(L, R, cL, cR) {
    if (!L.normal || !R.normal) return null;
    const dx = cR.x - cL.x, dy = cR.y - cL.y, l = Math.max(1e-6, Math.hypot(dx, dy));
    const ux = dx / l, uy = dy / l;
    return { l: L.normal.x * ux + L.normal.y * uy, r: -(R.normal.x * ux + R.normal.y * uy) };
  }

  function updateConjure(t, obs) {
    const C = st.conj;
    const L = st.hands.left, R = st.hands.right;
    const both = L.present && R.present && L.lastSeen === t && R.lastSeen === t && ready(L, t) && ready(R, t);
    const ev = both && t >= C.throwBlockedUntil ? evalConjure(L, R, C.on ? C.kind : C.pending ? C.pending.kind : null) : null;
    C.lastEval = ev ? { kind: ev.kind, ...ev.info } : null;
    const e = ev && ev.kind ? ev : null;
    // история для броска: масштаб кистей и центр между ними (относительно корпуса)
    if (both) {
      const bc = isObj(obs.bodyCenter) && fin(obs.bodyCenter.x) && fin(obs.bodyCenter.y) ? { x: obs.bodyCenter.x * st.aspect, y: obs.bodyCenter.y } : null;
      const c = mid(palmCenter(L), palmCenter(R));
      const rel = bc ? { x: c.x - bc.x, y: c.y - bc.y } : c;
      const sw = fin(obs.shoulderWidth) && obs.shoulderWidth > 0 ? obs.shoulderWidth : null;
      const prev = C.hist[C.hist.length - 1];
      if (prev) {
        const sp = d2(rel, prev.rel) / Math.max(1e-3, (t - prev.t) / 1000);
        if (sp > cfg.glitchSpeed) C.hist.length = 0; // сбой трекинга — история не годится
      }
      C.hist.push({ t, sL: L.scale, sR: R.scale, rel, sw });
      while (C.hist.length > 40 || (C.hist.length && t - C.hist[0].t > 600)) C.hist.shift();
    } else if (!C.on) C.hist.length = 0;

    if (C.on) {
      if (e && e.kind === C.kind) {
        C.lastGood = t;
        const k = 1 - Math.exp(-Math.max(0, t - (C.lastT ?? t)) / Math.max(1, cfg.conjureSizeTauMs));
        C.size = lerpN(C.size, e.size, k);
        C.centerRaw = e.center;
      }
      C.lastT = t;
      C.charge = clamp((t - C.onAt) / cfg.conjureChargeMs, 0, 1);
      const thr = t - C.onAt >= cfg.throwMinHeldMs ? detectThrow(t) : null;
      if (thr) {
        const bcx = isObj(obs.bodyCenter) && fin(obs.bodyCenter.x) ? obs.bodyCenter.x * st.aspect : 0.5 * st.aspect;
        const S = (L.scale + R.scale) / 2 || 0.1;
        // aimX в координатах показа: при зеркале ось x перевёрнута
        let aim = ((C.centerRaw ? C.centerRaw.x : bcx) - bcx) / (3 * S) + thr.dirX * 0.6;
        if (st.mirror) aim = -aim;
        firePulse('throw', t, {
          kind: C.kind, size: C.size,
          power: clamp(0.35 * C.charge + 0.65 * thr.strength, cfg.throwMinPower, 1),
          aimX: clamp(aim, -1, 1), how: thr.how,
        });
        Object.assign(C, { on: false, kind: null, pending: null, hist: [], throwBlockedUntil: t + cfg.throwRefractoryMs, quietUntil: t + cfg.throwQuietMs });
        st.swipe.armed = false; st.swipe.until = Math.max(st.swipe.until, t + cfg.throwRefractoryMs);
        st.burstBlockedUntil = Math.max(st.burstBlockedUntil, t + cfg.throwRefractoryMs);
        return;
      }
      if (t - C.lastGood > cfg.conjureDropMs) Object.assign(C, { on: false, kind: null, pending: null, size: 0, charge: 0 });
      if (C.on && C.centerRaw) C.center = disp({ x: C.centerRaw.x / st.aspect, y: C.centerRaw.y });
      return;
    }
    if (!e) { C.pending = null; return; }
    // [W3-MAGIC] ладони сомкнуты или их растягивают после удержания — это «Врата»/«Столп», не сфера
    if (st.str.since !== null || st.str.prime) { C.pending = null; return; }
    if (!C.pending && steering(mover().read(t)) > cfg.conjureStickMax) return;
    if (!C.pending || C.pending.kind !== e.kind) { C.pending = { kind: e.kind, since: t }; return; }
    if (t - C.pending.since >= cfg.conjureOnMs) {
      Object.assign(C, { on: true, kind: e.kind, onAt: t, lastGood: t, lastT: t, size: e.size, charge: 0, centerRaw: e.center, pending: null });
      C.center = disp({ x: e.center.x / st.aspect, y: e.center.y });
      st.counters.conjures++;
    }
  }

  // ───────── [V3] двуручные фигуры-печати: ХЛОПОК, РАМКА (ВРАТА — в updateStretch, [W3-MAGIC]) ─────────
  // «Г»: указательный выпрямлен, большой отставлен ПОД УГЛОМ ≥ frameAngleDeg к указательному.
  // Обычное указание (перо рун) — 28–65° (реальные кадры HaGRID: без угла 20 из 23 проходили как «Г»).
  function lShape(H) {
    if (H.rawShape !== 'point' || !H.feat || H.feat.thumbSpread < cfg.frameThumb || !H.pts) return false;
    const I = H.pts, tx = I[4].x - I[2].x, ty = I[4].y - I[2].y, ix = I[8].x - I[5].x, iy = I[8].y - I[5].y;
    const l = Math.hypot(tx, ty) * Math.hypot(ix, iy);
    if (l < 1e-9) return false;
    return Math.acos(clamp((tx * ix + ty * iy) / l, -1, 1)) * 180 / Math.PI >= cfg.frameAngleDeg;
  }
  function updateSigils(t) {
    const G = st.sig, C = st.conj;
    const L = st.hands.left, R = st.hands.right;
    const both = L.present && R.present && L.lastSeen === t && R.lastSeen === t && ready(L, t) && ready(R, t) && L.pts && R.pts && L.scale && R.scale;
    if (!both) {
      // сомкнутые ладони MediaPipe часто теряет: если кисть пропала сразу после быстрого сближения — это хлопок
      const h = G.hist, e1 = h[h.length - 1];
      if (e1 && t - e1.t <= cfg.clapLostMs && e1.gap <= cfg.clapLostGap && t >= G.blockedUntil) {
        for (let i = h.length - 2; i >= 0; i--) {
          const e = h[i], span = e1.t - e.t;
          if (span > cfg.clapWindowMs) break;
          if (e.gap >= cfg.clapFrom && e.open && e.dy / Math.max(1e-3, e.gap) <= cfg.clapDy && (e.gap - e1.gap) / Math.max(1e-3, span / 1000) >= cfg.clapSpeed && !e1.down) {
            firePulse('sigil', t, { kind: 'clap', power: 0.6, lost: true });
            G.blockedUntil = t + cfg.sigilRefractoryMs;
            Object.assign(st.conj, { on: false, kind: null, pending: null, size: 0, charge: 0, hist: [], throwBlockedUntil: Math.max(st.conj.throwBlockedUntil, t + 500) });
            break;
          }
        }
      }
      G.hist.length = 0; G.frameSince = null; G.frameFired = false; return;
    }
    const S = (L.scale + R.scale) / 2;
    const cL = palmCenter(L), cR = palmCenter(R);
    const gap = d2(cL, cR) / S, dx = Math.abs(cL.x - cR.x) / S, dy = Math.abs(cL.y - cR.y) / S;
    const openish = (H) => H.rawShape === 'open' || H.extended.slice(1).filter(Boolean).length >= 3;
    const prev = G.hist[G.hist.length - 1];
    if (prev && Math.abs(gap - prev.gap) / Math.max(1e-3, (t - prev.t) / 1000) > 40) G.hist.length = 0; // сбой трекинга
    const cy = (cL.y + cR.y) / 2;
    const down = prev && prev.cy !== undefined ? (cy - prev.cy) / Math.max(1e-3, (t - prev.t) / 1000) / S > 3 : false;
    G.hist.push({ t, gap, dx, dy, cy, down, open: openish(L) && openish(R) });
    while (G.hist.length > 40 || (G.hist.length && t - G.hist[0].t > 800)) G.hist.shift();
    const fire = (kind, data) => {
      if (t < G.blockedUntil) return false;
      firePulse('sigil', t, { kind, ...data });
      G.blockedUntil = t + cfg.sigilRefractoryMs;
      // печать важнее чар: начатые сфера/призма гаснут без броска
      Object.assign(C, { on: false, kind: null, pending: null, size: 0, charge: 0, hist: [], throwBlockedUntil: Math.max(C.throwBlockedUntil, t + 500) });
      st.burstBlockedUntil = Math.max(st.burstBlockedUntil, t + 400);
      st.swipe.armed = false; st.swipe.until = Math.max(st.swipe.until, t + 500);
      return true;
    };
    // ХЛОПОК
    if (gap <= cfg.clapTo && G.hist.length >= 3) {
      for (let i = G.hist.length - 2; i >= 0; i--) {
        const e = G.hist[i], span = t - e.t;
        if (span > cfg.clapWindowMs) break;
        if (e.gap >= cfg.clapFrom && e.open && e.dy / Math.max(1e-3, e.gap) <= cfg.clapDy && (e.gap - gap) / Math.max(1e-3, span / 1000) >= cfg.clapSpeed) {
          if (fire('clap', { power: clamp((e.gap - gap) / Math.max(1e-3, span / 1000) / (cfg.clapSpeed * 2.5), 0.3, 1) })) G.hist.length = 0;
          return;
        }
      }
    }
    // РАМКА: две «Г» по диагонали держатся frameHoldMs
    const frame = lShape(L) && lShape(R) && dx >= cfg.frameDx && dy >= cfg.frameDy;
    if (frame) {
      st.strokeBlockedUntil = Math.max(st.strokeBlockedUntil, t + 200); // правая «Г» — не перо руны
      if (G.frameSince === null) G.frameSince = t;
      if (!G.frameFired && t - G.frameSince >= cfg.frameHoldMs && fire('frame', {})) G.frameFired = true;
    } else { G.frameSince = null; G.frameFired = false; }
    // [ОШИБКА] обе «Г» есть, но руки рядом по высоте — рамка не по диагонали
    if (sustained('frame', !frame && lShape(L) && lShape(R) && dy < cfg.frameDy, t, 600)) hint('frame_diag', t);
  }

  // ───────── [W3-MAGIC] «ладони вместе → растянуть»: «Врата бури» (в стороны) и «Столп небес» (вверх-вниз) ─────────
  // Ладони сомкнуты (почти касаются) ≥ stretchHoldMs → жест взведён; затем за stretchPrimeMs их растягивают
  // дальше stretchApart со скоростью ≥ stretchSpeed. Ось — по направлению «ладонь → ладонь» в конце.
  // Сила 0..1 — от времени удержания (0,3–1,5 с), скорости и размаха. MediaPipe часто теряет сомкнутые
  // ладони: пропавшие кадры до stretchLostMs считаются «вместе», а растяжение после пропажи — резким.
  // Сфера (ладони «как мяч», conj.pending/on) и призма сомкнутыми ладонями не считаются.
  function updateStretch(t) {
    const T = st.str, C = st.conj, G = st.sig;
    const L = st.hands.left, R = st.hands.right;
    const seen = (H) => H.present && H.lastSeen === t && H.pts && H.scale;
    if (!seen(L) || !seen(R)) {
      if (T.since !== null && t - T.togSeen <= cfg.stretchLostMs) { T.togEnd = t; T.lost = true; }
      else if (T.since !== null) { T.since = null; T.lost = false; }
      if (T.prime && t - T.prime.t0 > cfg.stretchPrimeMs) T.prime = null;
      T.hist.length = 0; T.axis = null;
      return;
    }
    const S = (L.scale + R.scale) / 2;
    const cL = palmCenter(L), cR = palmCenter(R);
    const gap = d2(cL, cR) / S, dx = Math.abs(cL.x - cR.x) / S, dy = Math.abs(cL.y - cR.y) / S;
    const conj = C.on || !!C.pending || t < C.throwBlockedUntil || !!(st.twin && st.twin.phase === 'drawing');   // сфера, призма, бросок, рисование
    T.hist.push({ t, gap });
    while (T.hist.length > 30 || (T.hist.length && t - T.hist[0].t > cfg.stretchOpenWindowMs)) T.hist.shift();
    if (gap <= cfg.stretchTogether && !conj) {
      if (T.since === null) { T.since = t; T.lost = false; }
      T.togEnd = t; T.togSeen = t; T.togGap = gap; T.prime = null; T.axis = null;
      busyHands(t);
      return;
    }
    if (T.since !== null) {
      // ладони разомкнулись: удержали достаточно — жест взведён
      const held = T.togEnd - T.since;
      if (held >= cfg.stretchHoldMs && !conj) T.prime = { t0: T.togEnd, held, gap0: T.togGap, lost: T.lost, maxGap: gap };
      T.since = null; T.lost = false;
    }
    const P = T.prime;
    if (P) {
      busyHands(t);
      P.maxGap = Math.max(P.maxGap, gap);
      T.axis = gap >= cfg.stretchTogether * 1.3 ? axisOf(dx, dy, gap) : null;
      if (gap >= cfg.stretchApart) {
        const sp = (gap - P.gap0) / Math.max(1e-3, (t - P.t0) / 1000);
        const axis = axisOf(dx, dy, gap);
        T.prime = null; T.axis = null;
        if (!axis) { if (t >= G.blockedUntil) hint('stretch_diag', t); return; }            // [ОШИБКА] по диагонали
        if (sp < cfg.stretchSpeed && !P.lost) { if (t >= G.blockedUntil) hint('stretch_slow', t); return; } // [ОШИБКА] медленно
        const holdK = clamp((P.held - cfg.stretchHoldMs) / Math.max(1, cfg.stretchFullMs - cfg.stretchHoldMs), 0, 1);
        const speedK = P.lost ? 0.5 : clamp((sp - cfg.stretchSpeed) / (cfg.stretchSpeed * 2), 0, 1);
        const spanK = clamp((gap - cfg.stretchApart) / 1.5, 0, 1);
        const power = clamp(0.3 + 0.4 * holdK + 0.2 * speedK + 0.1 * spanK, 0.3, 1);
        fireStretch(t, axis === 'h' ? 'gate' : 'pillar', { power: Math.round(power * 1000) / 1000, axis, heldMs: Math.round(P.held) });
        return;
      }
      if (t - P.t0 > cfg.stretchPrimeMs) {
        // [ОШИБКА] растягивал, но не успел за окно — медленно
        if (P.maxGap >= (cfg.stretchTogether + cfg.stretchApart) / 2 && t >= G.blockedUntil) hint('stretch_slow', t);
        T.prime = null; T.axis = null;
      }
      return;
    }
    T.axis = null;
    // [ОШИБКА] ладони были рядом, но не сомкнуты (или сомкнуты на миг) — и резко растянуты
    if (gap >= cfg.stretchApart && !conj && t >= G.blockedUntil) {
      for (let i = T.hist.length - 2; i >= 0; i--) {
        const e = T.hist[i];
        if (e.gap <= cfg.stretchNear && (gap - e.gap) / Math.max(1e-3, (t - e.t) / 1000) >= cfg.stretchSpeed) { hint('stretch_open', t); T.hist.length = 0; break; }
      }
    }
  }
  function axisOf(dx, dy, gap) {
    const g = Math.max(1e-3, gap);
    return dx / g >= cfg.stretchAxisCos ? 'h' : dy / g >= cfg.stretchAxisCos ? 'v' : null;
  }
  // пока ладони сомкнуты и растягиваются — взмах, выброс и рывок левой молчат (руки летят в стороны)
  function busyHands(t) {
    st.swipe.armed = false; st.swipe.until = Math.max(st.swipe.until, t + 300);
    st.burstBlockedUntil = Math.max(st.burstBlockedUntil, t + 300);
  }
  function fireStretch(t, kind, data) {
    const G = st.sig, C = st.conj;
    if (t < G.blockedUntil) return false;
    firePulse('sigil', t, { kind, ...data });
    G.blockedUntil = t + cfg.sigilRefractoryMs;
    // разведённые ладони «друг к другу» — поза сферы: она не вспыхивает сразу после печати
    Object.assign(C, { on: false, kind: null, pending: null, size: 0, charge: 0, hist: [], throwBlockedUntil: Math.max(C.throwBlockedUntil, t + 900) });
    st.swipe.armed = false; st.swipe.until = Math.max(st.swipe.until, t + 500);
    return true;
  }
  // Заряд для HUD и эффектов: 0..1, пока ладони сомкнуты (и пока их растягивают после удержания)
  function stretchCharge() {
    const T = st.str;
    if (T.since !== null) { const h = T.togEnd - T.since; return h >= cfg.stretchShowMs ? clamp(h / cfg.stretchFullMs, 0, 1) : 0; }
    return T.prime ? clamp(T.prime.held / cfg.stretchFullMs, 0, 1) : 0;
  }

  // ───────── [V3] двуручное рисование: ДЕЛЬТА (треугольник) и КОР (сердце) ─────────
  // Оба указательных сходятся кончиками и замирают → каждый рисует свою половину зеркально →
  // кончики снова сходятся (или замирают). Склейка reverse(левая) ++ правая распознаётся по
  // двуручным шаблонам. Пока идёт рисование, джойстик и перо правой руки молчат.
  function updateTwin(t) {
    const L = st.hands.left, R = st.hands.right, C = st.conj, G = st.sig;
    const both = L.present && R.present && L.lastSeen === t && R.lastSeen === t && ready(L, t) && ready(R, t) && L.pts && R.pts && L.scale && R.scale && L.tip && R.tip;
    if (!both || C.on || C.pending) { st.twin = null; return; }
    const S = (L.scale + R.scale) / 2;
    const a = st.aspect;
    const tipL = { x: L.tip.x * a, y: L.tip.y }, tipR = { x: R.tip.x * a, y: R.tip.y };
    let T = st.twin;
    if (!T) {
      const pointing = L.rawShape === 'point' && R.rawShape === 'point';
      const tips = d2(tipL, tipR) / S, thumbs = d2(L.pts[4], R.pts[4]) / S;
      if (!pointing || tips > cfg.twinTipsTogether || thumbs < cfg.twinThumbsApart || t < G.blockedUntil) return;
      T = st.twin = { phase: 'arming', since: t, hist: [], L: [], R: [], fL: { ...tipL }, fR: { ...tipR }, badSince: null, lenL: 0, lenR: 0, maxGap: 0, mid0: null };
    }
    st.strokeBlockedUntil = Math.max(st.strokeBlockedUntil, t + 200);   // перо правой руки молчит
    // сглаживание кончиков (как у пера)
    const k = 1 - Math.exp(-Math.max(0, t - (T.lastT ?? t)) / cfg.tipTauMs);
    T.lastT = t;
    T.fL.x += (tipL.x - T.fL.x) * k; T.fL.y += (tipL.y - T.fL.y) * k;
    T.fR.x += (tipR.x - T.fR.x) * k; T.fR.y += (tipR.y - T.fR.y) * k;
    T.hist.push({ t, lx: T.fL.x, ly: T.fL.y, rx: T.fR.x, ry: T.fR.y });
    while (T.hist.length > 40 || (T.hist.length && t - T.hist[0].t > 500)) T.hist.shift();
    const stillFor = (ms) => {
      const now = T.hist[T.hist.length - 1];
      if (!now || t - T.hist[0].t < ms) return false;
      for (let i = T.hist.length - 1; i >= 0; i--) {
        const q = T.hist[i];
        if (t - q.t > ms) break;
        if (Math.hypot(now.lx - q.lx, now.ly - q.ly) > cfg.twinStill || Math.hypot(now.rx - q.rx, now.ry - q.ry) > cfg.twinStill) return false;
      }
      return true;
    };
    const pointing = L.rawShape === 'point' && R.rawShape === 'point';
    if (T.phase === 'arming') {
      if (!pointing || d2(tipL, tipR) / S > cfg.twinTipsTogether * 1.3) { st.twin = null; return; }
      if (stillFor(cfg.twinArmMs)) {
        T.phase = 'drawing'; T.t0 = t;
        T.L = [{ x: T.fL.x, y: T.fL.y }]; T.R = [{ x: T.fR.x, y: T.fR.y }];
        T.mid0 = (T.fL.x + T.fR.x) / 2;
        if (st.stroke) { st.stroke = null; st.trail = []; }        // своя руна правой руки — отменена молча
      }
      return;
    }
    // рисование
    if (!pointing) { if (T.badSince === null) T.badSince = t; if (t - T.badSince > cfg.twinShapeLossMs) { st.twin = null; return; } }
    else T.badSince = null;
    if (t - T.t0 > cfg.twinMaxMs || Math.abs((T.fL.x + T.fR.x) / 2 - T.mid0) / S > cfg.twinDrift) { st.twin = null; return; }
    const add = (arr, f, key) => {
      const last = arr[arr.length - 1], dd = Math.hypot(f.x - last.x, f.y - last.y);
      if (dd > 0.004) { arr.push({ x: f.x, y: f.y }); T[key] += dd / S; }
    };
    add(T.L, T.fL, 'lenL'); add(T.R, T.fR, 'lenR');
    const gap = d2(T.fL, T.fR) / S;
    T.maxGap = Math.max(T.maxGap, gap);
    const traveled = T.lenL >= cfg.twinMinTravel && T.lenR >= cfg.twinMinTravel;
    const met = traveled && T.maxGap >= cfg.twinSeparate && gap <= cfg.twinMeet;
    if (!(met || (traveled && stillFor(cfg.twinEndStillMs)))) return;
    // склейка и распознавание
    const combined = [...T.L].reverse().concat(T.R.slice(1));
    st.twin = null;
    const r = recognizeStroke(combined, { twin: true, minScore: cfg.twinScore, margin: cfg.runeMargin });
    st.lastRecognition = { ...r, twin: true };
    if (!r.rune || t < G.blockedUntil) { firePulse('runeFizzle', t, { reason: r.reason || 'twin', twin: true }); return; }
    firePulse('sigil', t, { kind: r.rune, power: 1, score: r.score });
    G.blockedUntil = t + cfg.sigilRefractoryMs;
    st.swipe.armed = false; st.swipe.until = Math.max(st.swipe.until, t + 500);
  }

  // Толчок к камере (обе кисти выросли) или бросок рывком (центр между кистями быстро сдвинулся).
  function detectThrow(t) {
    const h = st.conj.hist;
    if (h.length < 3) return null;
    const now = h[h.length - 1], prev = h[h.length - 2];
    const olderThan = (ms) => { for (let i = h.length - 1; i >= 0; i--) if (now.t - h[i].t >= ms) return h[i]; return null; };
    const base = olderThan(cfg.pushWindowMs) || h[0];
    if (now.t - base.t >= cfg.pushWindowMs * 0.6) {
      const body = now.sw && base.sw ? now.sw / base.sw : 1; // наклон всем корпусом к камере не бросает
      const rL = now.sL / base.sL / body, rR = now.sR / base.sR / body;
      const pL = prev.sL / base.sL / body, pR = prev.sR / base.sR / body;
      if (rL >= cfg.pushRatio && rR >= cfg.pushRatio && pL >= cfg.pushTrend && pR >= cfg.pushTrend) {
        const k = (Math.min(rL, rR) - 1) / Math.max(1e-6, (cfg.pushRatio - 1) * 2.2);
        return { how: 'push', strength: clamp(0.4 + k, 0, 1), dirX: 0 };
      }
      // [ОШИБКА] обе кисти заметно подались к камере, но не дотянули до броска
      if (Math.min(rL, rR) >= cfg.hintWeakPush && Math.max(rL, rR) < cfg.pushRatio && pL >= cfg.pushTrend && pR >= cfg.pushTrend) st.conj.weakPushAt = now.t;
    }
    const fb = olderThan(cfg.flingWindowMs) || h[0];
    const span = (now.t - fb.t) / 1000;
    if (span >= 0.05) {
      const dx = (now.rel.x - fb.rel.x) / st.unitK, dy = (now.rel.y - fb.rel.y) / st.unitK;   // [СТОЯ] в «сидячих» долях кадра
      const travel = Math.hypot(dx, dy);
      const speed = travel / span;
      if (travel >= cfg.flingMinTravel && speed >= cfg.flingSpeed && dy / Math.max(1e-6, travel) < cfg.flingDownCos) {
        return { how: 'fling', strength: clamp(speed / (cfg.flingSpeed * 2.2), 0, 1), dirX: clamp(dx / travel, -1, 1) };
      }
    }
    return null;
  }

  function push(obs) {
    try {
      if (!isObj(obs) || !fin(obs.tMs)) { st.counters.badObs++; return; }
      const t = obs.tMs;
      if (st.lastObsT !== null && t <= st.lastObsT) return; // старые/повторные метки не обрабатываются
      if (st.lastObsT !== null) st.frameDt += (clamp(t - st.lastObsT, 15, 200) - st.frameDt) * 0.1; // [V6] интервал кадров камеры ([НИЗКАЯ ЧАСТОТА] до 5 Гц)
      st.lastObsT = t;
      st.counters.obs++;
      st.mirror = obs.mirror !== false;
      if (fin(obs.frameW) && fin(obs.frameH) && obs.frameH > 0) st.aspect = obs.frameW / obs.frameH;
      st.obsSw = fin(obs.shoulderWidth) && obs.shoulderWidth > 0 ? obs.shoulderWidth : null;
      // [СТОЯ] поза «стоит» (modules/vision.js: бёдра видны, колени ниже бёдер) и масштаб порогов в долях кадра
      st.standing = obs.standing === true;
      if (st.obsSw) st.unitK = clamp(st.obsSw / cfg.swRef, cfg.unitKMin, 1);
      const list = [];
      for (const h of Array.isArray(obs.hands) ? obs.hands.slice(0, 2) : []) {
        if (!isObj(h)) continue;
        if (fin(h.score) && h.score < cfg.minHandScore) continue;
        const img = validPoints(h.landmarks, 21);
        if (!img) continue;
        const world = validPoints(h.world, 21);
        list.push({ img, world, handedness: h.handedness === 'Left' || h.handedness === 'Right' ? h.handedness : null, score: h.score });
      }
      const a = assign(list, obs.poseWrists);
      updateHand(st.hands.left, a.left, t, obs.bodyCenter);
      updateHand(st.hands.right, a.right, t, obs.bodyCenter);
      updateCharge(st.hands.left, t);
      updateCharge(st.hands.right, t);
      tryBurst(t);
      // [НОВИЧОК] выключенные детекторы не считаются вовсе (и не держат «занятость» рук)
      if (on('rune')) updateStroke(t); else if (st.stroke) { st.stroke = null; st.tipF = null; }
      if (on('slash')) updateSwipe(t);
      updateConjure(t, obs);
      if (on('sigil')) updateSigils(t); else { st.sig.hist.length = 0; st.sig.frameSince = null; }
      if (on('stretch')) updateStretch(t); else st.str = newStretch();   // [W3-MAGIC]
      if (on('twin')) updateTwin(t); else st.twin = null;
      if (on('spark')) updateSpark(t);
      // левая рука — джойстик: центр ладони в кадре (с аспектом) относительно середины плеч
      const L = st.hands.left;
      const seen = L.present && L.lastSeen === t && L.pts && L.scale;
      const bc = isObj(obs.bodyCenter) && fin(obs.bodyCenter.x) && fin(obs.bodyCenter.y)
        ? { x: obs.bodyCenter.x * st.aspect, y: obs.bodyCenter.y, sw: fin(obs.shoulderWidth) && obs.shoulderWidth > 0 ? obs.shoulderWidth : null } : null;
      const pc = seen ? palmCenter(L) : null;
      // [V3] запасной источник — левое запястье позы (кисть теряется в кулаке и при смазе)
      const pw = isObj(obs.poseWrists) && isObj(obs.poseWrists.left) ? obs.poseWrists.left : null;
      const inFrame = pw && fin(pw.x) && fin(pw.y) && pw.x > 0.03 && pw.x < 0.97 && pw.y > 0.03 && pw.y < 0.95; // поза «додумывает» точки за краем
      const wrist = inFrame && (!fin(pw.visibility) || pw.visibility >= 0.5) ? { x: pw.x * st.aspect, y: pw.y } : null;
      mover().push({ t, hand: pc ? { x: pc.x, y: pc.y, scale: L.scale } : null, wrist, body: bc, mirror: st.mirror, aspect: st.aspect, busy: st.conj.on || !!st.conj.pending || t < st.conj.quietUntil || !!(st.twin && st.twin.phase === 'drawing') || st.str.since !== null || !!st.str.prime });
      const dsh = mover().takeDash();
      if (dsh) firePulse('dashDir', t, { x: dsh.x, z: dsh.z, speed: dsh.speed });
      updateShield(t);
      if (on('slash')) checkSlowSwipe(t);
      updateCoach(t, obs);
      noteChecks(t);
    } catch (e) {
      st.counters.badObs++;
    }
  }

  // ───────── [ТВИСТ «ОШИБКА»] прогресс условий жестов (тренажёр техники) ─────────
  // Только чтение: те же формулы и пороги, что в classify / updateShield / updateSpark / updateCharge /
  // tryBurst / evalConjure / updateCoach. Решения эти записи не читают. Условия-движения (толчок, заряд,
  // резкое раскрытие) длятся кадр-два, поэтому noteChecks в конце каждого кадра запоминает их лучшее за окно.
  function noteChecks(t) {
    try {
      const K = st.chk, L = st.hands.left, R = st.hands.right, p = st.pulses;
      // импульсы этого кадра (read() их сотрёт)
      if (p.spark && p.spark.tMs === t) K.sparkAt = t;
      if (p.burst && p.burst.tMs === t && p.burst.hand !== 'left') K.burstAt = t;
      if (p.parry && p.parry.tMs === t) K.parryAt = t;
      // щит: размах толчка (H.pushDbg пересчитывается, только когда история ладони набрана)
      if (L.pushDbg && L.pushDbg !== K.pushDbg) { K.pushDbg = L.pushDbg; peakNote(K.push, L.pushDbg.span, t); }
      // «Искра»: насколько кисть в «заряде» и продержался ли он sparkLoadMs (как в updateSpark)
      if (R.present && R.lastSeen === t && R.feat) peakNote(K.load, sparkLoadValue(R.feat), t);
      if ((R.loadSince !== null && t - R.loadSince >= cfg.sparkLoadMs) || R.loadLeft !== null) K.loadOkAt = t;
      // «заряд» сброшен без щелчка (указательный выпрямился медленнее sparkFlickMs) — условие не выполнено
      if (K.loadLeft !== null && R.loadLeft === null && K.sparkAt !== t && R.loadSince === null && R.present) K.flickMissAt = t;
      K.loadLeft = R.loadLeft;
      noteRelease(L, K.left, t, cfg.parryWindowMs);
      noteRelease(R, K.right, t, cfg.releaseWindowMs);
    } catch (e) { /* показ не должен мешать распознаванию */ }
  }
  // «Заряд» искры: большой у кончиков указательного/среднего, пальцы согнуты (пороги updateSpark).
  function sparkLoadValue(f) {
    const c = (i, extra) => downTo(f.reach[i], cfg.sparkCurl + extra, 1.45);
    return Math.min(downTo(Math.min(f.pinch, f.thumbMid), cfg.sparkTouch, cfg.sparkTouch * 2), c(0, 0), c(1, 0.04), c(2, 0.04), c(3, 0.08));
  }
  // Доля согнутых пальцев (curled из classify).
  function curledShare(f) {
    let n = 0;
    for (let i = 0; i < 4; i++) if (f.bends[i] > cfg.bendCurled || f.reach[i] < cfg.reachCurled) n++;
    return n / 4;
  }
  // Кулак → ладонь: заряд и удержание кулака (updateCharge), время от выхода из кулака до раскрытия —
  // правая до 'open' (как в tryBurst), левая до 'open' ладонью к камере (как у парирования).
  function noteRelease(H, K, t, winMs) {
    const seen = H.present && H.lastSeen === t && H.feat;
    if (seen) peakNote(K.curl, curledShare(H.feat), t);
    const inFist = H.fistStableAt !== null;
    if (inFist) { K.fistAt = t; peakNote(K.charge, H.charge, t); peakNote(K.held, t - H.fistStableAt, t); }
    else if (K.wasFist && H.present) {
      // вышли из кулака в этом кадре: updateCharge только что записал заряд и время удержания
      peakNote(K.charge, H.releaseCharge, t); peakNote(K.held, H.releaseHeldMs, t);
      K.relAt = t; K.snap = null;
    }
    K.wasFist = inFist;
    if (K.relAt === null) return;
    const opened = seen && H.rawShape === 'open' && ready(H, t) && (H.side === 'right' || H.palmFacing === 'camera');
    if (opened) { K.snap = { ms: t - K.relAt, t }; K.relAt = null; }
    else if (t - K.relAt > winMs * 3 || !H.present) { K.snap = { ms: Infinity, t }; K.relAt = null; }
  }

  // Метрики СФЕРЫ без раннего выхода (evalConjure обрывается на первой неудаче): те же формулы и пороги.
  function orbMetrics(L, R, on) {
    const S = (L.scale + R.scale) / 2;
    const cL = palmCenter(L), cR = palmCenter(R), gapPx = d2(cL, cR);
    const nExt = (H) => H.extended.slice(1).filter(Boolean).length;
    const openish = (H) => H.rawShape === 'open' || nExt(H) >= 3;
    const fc = palmsFacing(L, R, cL, cR);
    const fL = fc ? fc.l : null, fR = fc ? fc.r : null;
    const fOn = on ? cfg.orbFacingOff : cfg.orbFacingOn, sideOn = on ? cfg.orbSideOff : cfg.orbSideOn;
    const handOk = (H, f) => (f !== null && f >= fOn) || (Math.abs(H.cross) < sideOn && (f === null || f >= cfg.orbSideMinFacing));
    const handV = (H, f) => (f !== null ? upTo(f, fOn, 0) : downTo(Math.abs(H.cross), sideOn, 1));
    const slack = on ? cfg.orbGapSlack : 0;
    return {
      openL: openish(L), openR: openish(R), openVL: openish(L) ? 1 : nExt(L) / 3, openVR: openish(R) ? 1 : nExt(R) / 3,
      okL: handOk(L, fL), okR: handOk(R, fR), valL: handV(L, fL), valR: handV(R, fR),
      gap: gapPx / S, gMin: cfg.orbGapMin * (1 - slack), gMax: cfg.orbGapMax * (1 + slack),
      // кончики пальцев двух кистей не касаются (иначе «домик»): входит в условие «расстояние»
      tips: Math.min(d2(L.pts[8], R.pts[8]), d2(L.pts[12], R.pts[12])) / S, tipsLim: on ? cfg.orbTipsApartOff : cfg.orbTipsApart,
      dy: Math.abs(cL.y - cR.y) / Math.max(1e-6, gapPx), dyLim: on ? cfg.orbDyOff : cfg.orbDyOn,
    };
  }

  // checks(nowMs) → { t, ok, shield, spark, burst, parry, orb }: по каждому жесту { id, hand, present, recognized,
  // items: [{ key, value 0..1, ok, hint, landmarks, hand, transient }] }. value = 1 ⇔ ok; ok:null — не оценить.
  function checks(nowMs) {
    const t = fin(nowMs) ? nowMs : (st.lastObsT ?? 0);
    const fresh = st.lastObsT !== null && t - st.lastObsT <= cfg.staleMs;
    const vis = (H) => !!(fresh && H.present && H.feat && H.landmarks && H.lastSeen !== null && st.lastObsT - H.lastSeen <= CHECK_SEEN_MS);
    const W = CHECK_WINDOW_MS, K = st.chk, C = st.conj;
    const L = st.hands.left, R = st.hands.right;
    const item = (key, hand, ok, value, hint, landmarks, transient) => ({
      key, value: ok === true ? 1 : ok === null ? 0 : Math.round(Math.min(0.99, clamp(num0(value), 0, 1)) * 100) / 100,
      ok, hint, landmarks, hand, transient: !!transient,
    });
    // vals[key] = { ok, value, hint?, hand? }; нет записи — не оценить (кисти нет: кадр — ✗ «кистей не видно»)
    const block = (id, present, recognized, vals) => {
      const sp = CHECK_SPEC[id];
      return {
        id, hand: sp.hand, present, recognized: !!recognized,
        items: sp.items.map(([key, hint, lm, tr]) => {
          const v = vals && vals[key];
          if (v) return item(key, v.hand || sp.hand, v.ok, v.value, v.hint !== undefined ? v.hint : hint, lm, tr);
          if (!present && (key === 'frame' || key === 'both')) return item(key, sp.hand, false, 0, 'hands_missing', lm, tr);
          return item(key, sp.hand, null, 0, hint, lm, tr);
        }),
      };
    };
    const who = (okL, okR) => (okL === okR ? 'both' : okL ? 'right' : 'left');
    // кадр и размер — как в updateCoach (hand_edge, hand_far)
    const frameV = (H) => {
      let m = Infinity;
      for (const p of H.landmarks) m = Math.min(m, p.x, 1 - p.x, p.y, 1 - p.y);
      return { ok: !(m < cfg.hintEdge), value: upTo(m, cfg.hintEdge, 0) };
    };
    const nearV = (H) => ({ ok: !(H.scale > 0 && H.scale < cfg.hintFarScale), value: upTo(H.scale, cfg.hintFarScale, 0) });
    // ладонь к камере — как palmFacing в updateHand
    const facingV = (H) => ({ ok: H.palmFacing === 'camera', value: upTo(-H.cross * (H.side === 'right' ? 1 : -1), cfg.palmSideRatio, 0) });
    const snapV = (S, win) => {
      const s = S.snap && t - S.snap.t <= W ? S.snap : null;
      if (!s) return { ok: false, value: 0 };
      return { ok: s.ms <= win, value: s.ms <= win ? 1 : fin(s.ms) ? 1 - (s.ms - win) / (2 * win) : 0 };
    };
    const fns = {
      // «OK»: classify (с тем же гистерезисом — пока «OK» держится, пороги удержания)
      ok() {
        if (!vis(R)) return block('ok', false, false, null);
        const f = R.feat, was = R.rawShape === 'pinch';
        const lim = was ? cfg.pinchOff : cfg.pinchOn;
        const oth = cfg.okOthersReach - (was ? 0.05 : 0), lo = [oth, oth - 0.04, oth - 0.1];
        const drop = cfg.okIndexDrop - (was ? 0.04 : 0);
        return block('ok', true, ready(R, t) && R.shape === 'pinch', {
          ring: { ok: f.pinch < lim, value: downTo(f.pinch, lim, lim * 2.2) },
          others: { ok: f.reach[1] >= lo[0] && f.reach[2] >= lo[1] && f.reach[3] >= lo[2], value: Math.min(upTo(f.reach[1], lo[0], 1), upTo(f.reach[2], lo[1], 1), upTo(f.reach[3], lo[2], 1)) },
          index: { ok: f.reach[0] <= f.reach[1] - drop, value: upTo(f.reach[1] - f.reach[0], drop, 0) },
          frame: frameV(R), near: nearV(R),
        });
      },
      // щит: updateShield (раскрытая ладонь к камере + толчок, принятый распознавателем)
      shield() {
        if (!vis(L)) return block('shield', false, false, null);
        const f = L.feat, e = L.extended;
        const busy = C.on || !!C.pending || t < C.quietUntil;
        const ratio = moveMode === 'steer' ? cfg.shieldPushRatioSteer : cfg.shieldPushRatio;
        const pC = f.bends[3] > cfg.bendCurled || f.reach[3] < cfg.reachCurled;
        return block('shield', true, st.shield.on && !busy && ready(L, t), {
          open: { ok: L.rawShape === 'open', value: ((e[1] ? 1 : 0) + (e[2] ? 1 : 0) + (e[3] ? 1 : 0) + (e[4] || !pC ? 1 : 0)) / 4 },
          facing: facingV(L),
          push: { ok: st.shield.on || (fin(L.pushAt) && t - L.pushAt <= W), value: upTo(peakGet(K.push, t), ratio, 1) },
          frame: frameV(L), near: nearV(L),
        });
      },
      // «Искра»: updateSpark («заряд» → выпрямлен только указательный)
      spark() {
        if (!vis(R)) return block('spark', false, false, null);
        const f = R.feat, lim = (extra) => cfg.sparkCurl + extra;
        return block('spark', true, t - K.sparkAt <= W, {
          load: t - K.loadOkAt <= W && K.flickMissAt > K.loadOkAt
            ? { ok: false, value: 0.5 }   // заряд был, но щелчок не успел за sparkFlickMs
            : { ok: t - K.loadOkAt <= W, value: peakGet(K.load, t) },
          index: { ok: f.reach[0] > cfg.sparkExtend, value: upTo(f.reach[0], cfg.sparkExtend, 0.9) },
          middle: { ok: !(f.reach[1] > cfg.sparkExtend), value: downTo(f.reach[1], cfg.sparkExtend, 1.45) },
          rest: { ok: f.reach[2] < lim(0.06) && f.reach[3] < lim(0.1), value: Math.min(downTo(f.reach[2], lim(0.06), 1.45), downTo(f.reach[3], lim(0.1), 1.45)) },
          frame: frameV(R), near: nearV(R),
        });
      },
      // выброс: updateCharge + tryBurst (кулак, заряд ≥ minCharge, раскрыть за releaseWindowMs)
      burst() {
        if (!vis(R)) return block('burst', false, false, null);
        const S = K.right, ch = peakGet(S.charge, t);
        return block('burst', true, t - K.burstAt <= W, {
          fist: { ok: R.fistStableAt !== null || t - S.fistAt <= W, value: peakGet(S.curl, t) },
          charge: { ok: ch >= cfg.minCharge, value: upTo(ch, cfg.minCharge, 0) },
          snap: snapV(S, cfg.releaseWindowMs),
          frame: frameV(R), near: nearV(R),
        });
      },
      // парирование: tryBurst (кулак ≥ parryFistMs → ладонь к камере за parryWindowMs)
      parry() {
        if (!vis(L)) return block('parry', false, false, null);
        const S = K.left, held = peakGet(S.held, t);
        return block('parry', true, t - K.parryAt <= W, {
          fist: { ok: held >= cfg.parryFistMs, value: upTo(held, cfg.parryFistMs, 0) },
          facing: facingV(L),
          snap: snapV(S, cfg.parryWindowMs),
          frame: frameV(L),
        });
      },
      // СФЕРА: evalConjure (без раннего выхода) — обе раскрыты, ладони друг к другу, одна высота, расстояние
      orb() {
        const vl = vis(L), vr = vis(R);
        const recognized = fresh && C.on && C.kind === 'orb';
        if (!vl || !vr || !L.pts || !R.pts || !L.scale || !R.scale) {
          return block('orb', false, recognized, { both: { ok: false, value: (vl ? 0.5 : 0) + (vr ? 0.5 : 0), hand: vl === vr ? 'both' : vl ? 'right' : 'left' } });
        }
        const cur = C.on ? C.kind : C.pending ? C.pending.kind : null;
        const m = orbMetrics(L, R, cur === 'orb');
        return block('orb', true, recognized, {
          both: { ok: true, value: 1 },
          open: { ok: m.openL && m.openR, value: Math.min(m.openVL, m.openVR), hand: who(m.openL, m.openR) },
          facing: { ok: m.okL && m.okR, value: Math.min(m.valL, m.valR), hand: who(m.okL, m.okR) },
          level: { ok: m.dy <= m.dyLim, value: downTo(m.dy, m.dyLim, 1) },
          // слишком близко (или кончики пальцев касаются) — подсказки-кода нет; слишком широко — orb_far
          gap: m.gap < m.gMin || m.tips < m.tipsLim
            ? { ok: false, value: Math.min(upTo(m.gap, m.gMin, 0), upTo(m.tips, m.tipsLim, 0)), hint: null }
            : { ok: m.gap <= m.gMax, value: downTo(m.gap, m.gMax, m.gMax * 2) },
        });
      },
    };
    const out = { t: st.lastObsT };
    for (const id of CHECK_GESTURES) {
      try { out[id] = fns[id](); } catch (e) { out[id] = block(id, false, false, null); }
    }
    return out;
  }

  function handState(H, t) {
    if (!H.present || H.lastSeen === null || t - H.lastSeen > lostGrace()) return null;
    return {
      side: H.side, shape: H.shape, stableMs: Math.max(0, t - H.shapeSince), confidence: Math.round(H.conf * 100) / 100,
      palmFacing: H.palmFacing, extended: H.extended.slice(), pinch: Math.round(H.pinchLevel * 100) / 100,
      center: H.center, tip: H.tip, palmSize: H.palmSize, landmarks: H.landmarks,
      charge: Math.round(H.charge * 1000) / 1000, ready: ready(H, t),
    };
  }

  function live(kind, t) {
    const p = st.pulses[kind];
    return p && t - p.tMs <= cfg.pulseTtlMs ? p : null;
  }

  function peek(nowMs) {
    const t = fin(nowMs) ? nowMs : (st.lastObsT ?? 0);
    const fresh = st.lastObsT !== null && t - st.lastObsT <= cfg.staleMs;
    const L = st.hands.left, R = st.hands.right;
    const hold = (H) => fresh && H.present && H.lastSeen === st.lastObsT && ready(H, t);
    const drawing = !!st.stroke;
    const burstP = live('burst', t);
    const runeP = live('rune', t);
    const C = st.conj;
    // Руки заняты чарами (или только что бросили их): одиночные удержания молчат.
    const busy = C.on || !!C.pending || t < C.quietUntil;
    const thr = live('throw', t);
    const dd = live('dashDir', t), sp = live('slash', t), sg = live('sigil', t), hintP = live('hint', t);
    const stk = mover().read(t);
    let stickOut = busy ? { ...stk, engaged: false, x: 0, z: 0, moveX: 0, moveZ: 0, turn: 0, fwd: 0, hold: 'cast' } : stk;
    // [V5] «Руль»: поднят щит — герой стоит и держит блок (поворот остаётся)
    // [V6] щит не мигает от пропуска одного кадра кисти: опускает его только updateShield (через shieldDropMs)
    const shieldUp = fresh && L.present && ready(L, t) && st.shield.on && !busy;
    if (stickOut.mode === 'steer' && stickOut.engaged && shieldUp) stickOut = { ...stickOut, z: 0, moveZ: 0, fwd: 0, hold: 'shield' };
    return {
      available: fresh && (L.present || R.present),
      left: handState(L, t), right: handState(R, t),
      attack: hold(R) && R.shape === 'pinch' && !drawing && !burstP && !busy,
      shield: shieldUp,
      charge: fresh ? (R.shape === 'fist' ? Math.max(L.charge, R.charge) : R.charge) : 0,
      burst: !!burstP, burstPower: burstP ? Math.round(burstP.power * 1000) / 1000 : 0,
      rune: runeP ? runeP.rune : null, runeScore: runeP ? Math.round(runeP.score * 1000) / 1000 : 0,
      runeFizzle: !!live('runeFizzle', t),
      // V1-совместимость: знак горизонтали рывка (рывок строго вперёд/назад V1-бой не умеет)
      dash: dd ? (Math.abs(dd.x) >= 0.25 ? Math.sign(dd.x) : 0) : 0,
      dashDir: dd ? { x: Math.round(dd.x * 1000) / 1000, z: Math.round(dd.z * 1000) / 1000 } : null,
      stick: stickOut,
      moveX: fresh ? stickOut.x : 0, moveZ: fresh ? stickOut.z : 0,
      spark: !!live('spark', t),
      slash: sp ? { dir: sp.dir, power: Math.round(sp.power * 1000) / 1000 } : null,
      parry: !!live('parry', t),
      sigil: sg ? sg.kind : null, sigilPower: sg ? Math.round(num0(sg.power) * 1000) / 1000 : 0,
      // [W3-MAGIC] ладони сомкнуты — идёт заряд «Врат бури» / «Столпа небес»; ось растяжения 'h' | 'v' | null
      sigilCharge: fresh ? Math.round(stretchCharge() * 1000) / 1000 : 0,
      sigilAxis: fresh ? st.str.axis : null,
      burstHand: burstP ? (burstP.hand || (burstP.both ? 'both' : 'right')) : null,
      drawing,
      trail: t <= st.trailUntil ? st.trail : [],
      twin: st.twin && st.twin.phase === 'drawing' ? { left: st.twin.L.map((q) => ({ x: q.x / st.aspect, y: q.y })), right: st.twin.R.map((q) => ({ x: q.x / st.aspect, y: q.y })) } : null,
      lastRune: st.lastRune,
      conjure: fresh && C.on ? {
        kind: C.kind, size: Math.round(C.size * 1000) / 1000, charge: Math.round(C.charge * 1000) / 1000,
        center: C.center, heldMs: Math.max(0, t - C.onAt),
      } : null,
      throw: thr ? { kind: thr.kind, size: Math.round(thr.size * 1000) / 1000, power: Math.round(thr.power * 1000) / 1000, aimX: Math.round(thr.aimX * 1000) / 1000, how: thr.how } : null,
      // [ТВИСТ «ОШИБКА»] почти-правильный жест: код подсказки (тексты — core/gestureCoach.js)
      hint: hintP ? { code: hintP.code, side: hintP.side || null, guess: hintP.guess || null, tMs: hintP.tMs } : null,
    };
  }

  function read(nowMs) {
    const f = peek(nowMs);
    st.pulses.burst = null; st.pulses.rune = null; st.pulses.runeFizzle = null; st.pulses.dash = null; st.pulses.throw = null;
    st.pulses.dashDir = null; st.pulses.parry = null; st.pulses.spark = null; st.pulses.slash = null; st.pulses.sigil = null;
    st.pulses.hint = null;
    return f;
  }

  function configure(patch) {
    cfg = mergeConfig(cfg, patch);
    if (patch && patch.stick) stick.configure(patch.stick);
    if (patch && patch.steer) steer.configure(patch.steer);
    if (patch && (patch.moveMode === 'steer' || patch.moveMode === 'stick') && patch.moveMode !== moveMode) {
      moveMode = patch.moveMode;
      mover().reset();   // новая схема начинает с чистого листа (без старой хватки/подъёма)
    }
    if (patch && (patch.profile === 'novice' || patch.profile === 'master') && patch.profile !== profile) {
      profile = patch.profile;
      enabled = new Set(GESTURE_PROFILES[profile]);
      // начатые выключенными детекторами жесты гаснут молча
      st.stroke = null; st.tipF = null; st.trail = []; st.twin = null;
      if (!on('prism') && (st.conj.kind === 'prism' || (st.conj.pending && st.conj.pending.kind === 'prism'))) Object.assign(st.conj, { on: false, kind: null, pending: null, size: 0, charge: 0 });
    }
  }

  function getDebug() {
    const h = (H) => ({
      present: H.present, raw: H.rawShape, candidate: H.candidate, shape: H.shape, palmFacing: H.palmFacing,
      cross: H.feat ? Math.round(H.cross * 100) / 100 : null,
      bends: H.feat ? H.feat.bends.map((b) => Math.round(b)) : null,
      reach: H.feat ? H.feat.reach.map((r) => Math.round(r * 100) / 100) : null,
      thumbSpread: H.feat ? Math.round(H.feat.thumbSpread * 100) / 100 : null,
      pinch: H.feat ? Math.round(H.feat.pinch * 100) / 100 : null,
      charge: Math.round(H.charge * 100) / 100,
      jit: H.jit != null ? Math.round(H.jit * 1000) / 1000 : null,
      push: H.pushDbg ? { span: Math.round(H.pushDbg.span * 100) / 100, fast: Math.round(H.pushDbg.fast * 100) / 100, scale: Math.round(H.pushDbg.scale * 100) / 100, shift: Math.round(H.pushDbg.shift * 100) / 100, turned: Math.round(H.pushDbg.turned * 100) / 100 } : null,
    });
    return {
      version: HAND_GESTURES_VERSION,
      left: h(st.hands.left), right: h(st.hands.right),
      stroke: st.stroke ? { points: st.stroke.pts.length, ms: st.lastObsT - st.stroke.t0 } : null,
      lastRecognition: st.lastRecognition,
      moveMode, profile, standing: st.standing, unitK: Math.round(st.unitK * 100) / 100,
      stick: mover().getDebug(),
      conjure: { on: st.conj.on, kind: st.conj.kind, pending: st.conj.pending ? st.conj.pending.kind : null, size: Math.round(st.conj.size * 100) / 100, charge: Math.round(st.conj.charge * 100) / 100, eval: st.conj.lastEval },
      counters: { ...st.counters },
      hints: { ...st.coach.counts },
      checks: checks(st.lastObsT),   // [ОШИБКА] прогресс условий жестов (тренажёр техники)
    };
  }

  return { push, read, peek, configure, reset: () => reset(), getDebug, checks };
}
