// ASHEN OATH — тренажёр «Научись за 60 секунд»: логика шагов обучения.
// Чистая логика: без DOM; время — только из аргументов (nowMs). Экран рисует modules/ui.js.
//
// Четыре базовых жеста (тот же набор, что в режиме «Новичок»):
//   1) левая ладонь у груди — герой идёт;      2) толчок левой ладонью к камере — щит;
//   3) правая «OK» — выстрел;                  4) правый кулак подержать → раскрыть — выброс.
// Вход — InputFrame игры (камера или «Отладка с клавиатуры»: W, K, J, L — те же клавиши, что в бою).
// Удержания (ход, щит, «OK») копятся по времени и прощают короткие провалы распознавания;
// выброс — импульс, а пока кулак сжат, шкала показывает его заряд.
// Подсказки режима «ОШИБКА» (коды core/handGestures.js → тексты core/gestureCoach.js) показываются
// только те, что относятся к текущему шагу, плюс общие про кадр. Где распознаватель молчит (в «Руле»
// он не подсказывает про стоящую ладонь), тренажёр подсказывает сам: кисть в кадре, а жеста всё нет.
// В отладке клавиша H показывает пример подсказки текущего шага.
//
//   const tr = createTutorialTrainer();
//   const view = tr.update(inputFrame, performance.now(), { moveMode: 'steer' });
//   tr.skip(now); tr.skipAll(now); tr.restart(now);

import { hintInfo } from './gestureCoach.js';

export const TRAINER_VERSION = 'ASHEN_TRAINER_1';

// Общие подсказки про кадр — на любом шаге.
export const TRAINER_FRAME_HINTS = Object.freeze(['hands_missing', 'hand_edge', 'hand_far']);

export const TRAINER_STEPS = Object.freeze([
  Object.freeze({
    id: 'walk', side: 'left', hand: 'Левая рука',
    title: 'Ладонь у груди', effect: 'Герой идёт',
    tip: 'Подними левую ладонь до груди и держи. Выше, к плечу, — бег.',
    // схема «Джойстик» (Настройки → Управление движением)
    stick: Object.freeze({ title: 'Ладонь вверх', tip: 'Подними левую руку, замри на миг и сдвинь её вверх — герой пойдёт вперёд.' }),
    key: 'W', keyText: 'держи W', holdMs: 700,
    hints: Object.freeze(['steer_low', 'steer_lean']),
    // левая кисть видна, а герой не идёт 3 с — «подними до груди» (в «Джойстике» не подходит)
    nudge: Object.freeze({ code: 'steer_low', ms: 3000, modes: Object.freeze(['steer']) }),
  }),
  Object.freeze({
    id: 'shield', side: 'left', hand: 'Левая рука',
    title: 'Толчок ладонью к камере', effect: 'Щит',
    // в «Руле» толчок, начатый вместе с подъёмом руки, не считается — сначала ладонь у груди, пауза
    tip: 'Ладонь у груди, замри на миг — и резко толкни её к камере сантиметров на 20.',
    stick: Object.freeze({ tip: 'Верни левую руку в центр (герой встанет), замри — и резко толкни ладонь к камере.' }),
    key: 'K', keyText: 'держи K', holdMs: 300,
    hints: Object.freeze(['shield_push', 'shield_palm']),
    // раскрытая левая ладонь в кадре 2 с, а щита нет — «замри и толкни» (свой текст: про паузу перед толчком)
    nudge: Object.freeze({ code: 'shield_push', ms: 2000, shape: 'open', text: 'Ладонь стоит, а щита нет: замри у груди на миг и резко толкни ладонь к камере сантиметров на 20' }),
  }),
  Object.freeze({
    id: 'shot', side: 'right', hand: 'Правая рука',
    title: 'Знак «OK»', effect: 'Выстрел',
    tip: 'Сомкни большой и указательный в кольцо, остальные три пальца — вверх.',
    key: 'J', keyText: 'держи J', holdMs: 350,
    hints: Object.freeze(['ok_ring_open', 'ok_fingers']),
  }),
  Object.freeze({
    id: 'burst', side: 'right', hand: 'Правая рука',
    title: 'Кулак → раскрыть', effect: 'Выброс',
    tip: 'Сожми кулак, подержи полсекунды и резко раскрой все пальцы разом.',
    key: 'L', keyText: 'нажми L', holdMs: 0,
    hints: Object.freeze(['burst_short', 'burst_slow']),
  }),
]);

const DEFAULTS = Object.freeze({
  advanceMs: 800,     // «✓ Распознано!» висит столько, потом — следующий шаг
  hintMs: 4500,       // подсказка «ОШИБКА» на экране
  decay: 1.5,         // накопленное удержание тает во столько раз быстрее, чем копится (провалы трекинга)
  maxDtMs: 250,       // шаг времени не больше: после ухода вкладки не «докапываем», а слабый ноутбук (от 4 к/с) идёт в реальном времени
  stuckMs: 15000,     // столько без успеха — предложить «Пропустить»
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Сейчас ли выполняется жест шага (по одному кадру ввода). level — значение для живой шкалы, 0..1.
export function stepSignal(step, input, { moveMode = 'steer' } = {}) {
  const off = { active: false, impulse: false, level: 0 };
  if (!step || !input || typeof input !== 'object' || input.valid !== true) return off;
  switch (step.id) {
    case 'walk': {
      const z = fin(input.moveZ) ? input.moveZ : 0;
      const x = fin(input.moveX) ? input.moveX : 0;
      const st = input.stick && typeof input.stick === 'object' ? input.stick : null;
      let active;
      if (moveMode === 'stick') active = z >= 0.25 || Math.abs(x) >= 0.35;
      else active = z >= 0.2 || !!(st && st.mode === 'steer' && st.engaged === true && (st.gait === 'walk' || st.gait === 'run'));
      return { active, impulse: false, level: active ? 1 : clamp01(Math.max(z, 0)) };
    }
    case 'shield':
      return { active: input.shield === true, impulse: false, level: input.shield === true ? 1 : 0 };
    case 'shot':
      return { active: input.attack === true, impulse: false, level: input.attack === true ? 1 : 0 };
    case 'burst': {
      const charge = fin(input.charge) ? clamp01(input.charge) : 0;
      return { active: charge > 0.05, impulse: input.burst === true, level: input.burst === true ? 1 : charge };
    }
    default:
      return off;
  }
}

export function createTutorialTrainer(options = {}) {
  const cfg = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) };
  const steps = Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : TRAINER_STEPS;
  const total = steps.length;

  let s = null;
  let seq = 0;   // растёт при каждой смене шага/фазы (и при перезапуске) — по нему экран запускает анимации
  function fresh(now) {
    s = {
      index: 0,
      phase: total ? 'try' : 'done',   // 'try' — ждём жест, 'ok' — распознано (пауза перед переходом), 'done' — все шаги
      acc: 0,                          // накопленное удержание, мс
      level: 0,
      live: false,
      nearMs: 0,                       // кисть в кадре, а жеста нет (для подсказки тренажёра)
      okAt: null,
      stepAt: fin(now) ? now : null,
      lastT: null,
      hint: null,
      demoHint: 0,
      results: new Array(total).fill(null),   // 'ok' | 'skip'
      source: 'none', valid: false,
    };
  }
  fresh(null);

  function goNext(now) {
    s.index++;
    s.acc = 0; s.level = 0; s.live = false; s.okAt = null; s.hint = null; s.nearMs = 0;
    s.stepAt = now;
    s.phase = s.index >= total ? 'done' : 'try';
    seq++;
  }

  function pickHint(input, step, now) {
    const h = input && input.hint && typeof input.hint === 'object' ? input.hint : null;
    if (!h || !step) return;
    let code = typeof h.code === 'string' ? h.code : '';
    // отладка: H — пример подсказки именно этого шага (показ режима «ОШИБКА» без камеры)
    if (input.source === 'debug') { code = step.hints[s.demoHint % step.hints.length]; s.demoHint++; }
    else if (!step.hints.includes(code) && !TRAINER_FRAME_HINTS.includes(code)) return;
    setHint(code, h.side, now);
  }
  function setHint(code, side, now, text) {
    const info = hintInfo(code);
    if (!info) return;
    s.hint = { code, gesture: info.gesture, text: text || info.text, side: side === 'left' || side === 'right' ? side : null, at: now };
  }
  // подсказка самого тренажёра: нужная кисть видна (и нужной формы), а жест не выходит
  function nudge(step, input, sig, dt, now, moveMode) {
    const n = step.nudge;
    if (!n || input.source !== 'cv' || (n.modes && !n.modes.includes(moveMode))) { s.nearMs = 0; return; }
    const hands = input.hands && typeof input.hands === 'object' ? input.hands : null;
    const h = hands ? hands[step.side] : null;
    const near = !!h && typeof h === 'object' && (!n.shape || h.shape === n.shape) && !sig.active && !sig.impulse;
    // пока подсказка на экране, время «не выходит» не копится: следующая — не раньше чем через n.ms после неё
    s.nearMs = !near ? 0 : s.hint ? s.nearMs : s.nearMs + dt;
    if (s.nearMs >= n.ms && !s.hint) { setHint(n.code, step.side, now, n.text); s.nearMs = 0; }
  }

  function update(input, nowMs, opts = {}) {
    const now = fin(nowMs) ? nowMs : (s.lastT ?? 0);
    if (s.stepAt === null) s.stepAt = now;
    const dt = s.lastT === null ? 0 : Math.max(0, Math.min(cfg.maxDtMs, now - s.lastT));
    s.lastT = now;
    s.source = input && (input.source === 'cv' || input.source === 'debug') ? input.source : 'none';
    s.valid = !!(input && input.valid === true);

    if (s.phase === 'ok' && now - s.okAt >= cfg.advanceMs) goNext(now);
    const step = s.phase === 'try' ? steps[s.index] : null;
    if (step) {
      const sig = stepSignal(step, input, opts);
      s.live = sig.active || sig.impulse;
      s.level = sig.level;
      if (step.holdMs > 0) {
        if (sig.active) s.acc += dt;
        else s.acc = Math.max(0, s.acc - dt * cfg.decay);
      }
      const done = step.holdMs > 0 ? s.acc >= step.holdMs : sig.impulse;
      if (done) {
        s.acc = step.holdMs;
        s.phase = 'ok';
        s.okAt = now;
        s.hint = null;
        s.results[s.index] = 'ok';
        seq++;
      } else {
        pickHint(input, step, now);
        if (input && input.valid === true) nudge(step, input, sig, dt, now, opts && opts.moveMode === 'stick' ? 'stick' : 'steer');
      }
    }
    if (s.hint && now - s.hint.at >= cfg.hintMs) s.hint = null;
    return view(now);
  }

  function skip(nowMs) {
    if (s.phase !== 'try') return false;
    const now = fin(nowMs) ? nowMs : (s.lastT ?? 0);
    s.results[s.index] = 'skip';
    goNext(now);
    return true;
  }

  // «Пропустить обучение»: все оставшиеся шаги — skip, сразу итог (уже распознанный шаг остаётся ok)
  function skipAll(nowMs) {
    if (s.phase === 'done') return false;
    const now = fin(nowMs) ? nowMs : (s.lastT ?? 0);
    for (let i = 0; i < total; i++) if (s.results[i] === null) s.results[i] = 'skip';
    s.index = total - 1;
    goNext(now);
    return true;
  }

  function restart(nowMs) {
    fresh(fin(nowMs) ? nowMs : null);
    seq++;
  }

  function view(nowMs) {
    const now = fin(nowMs) ? nowMs : (s.lastT ?? 0);
    const step = s.index < total ? steps[s.index] : null;
    const ok = s.results.filter((r) => r === 'ok').length;
    const skipped = s.results.filter((r) => r === 'skip').length;
    const progress = !step ? 1 : s.phase === 'ok' ? 1 : step.holdMs > 0 ? clamp01(s.acc / step.holdMs) : clamp01(s.level);
    return {
      version: TRAINER_VERSION,
      index: Math.min(s.index, total),
      total,
      number: Math.min(s.index + 1, total),       // «2 / 4»
      step,
      phase: s.phase,
      done: s.phase === 'done',
      progress,
      live: s.phase === 'try' && s.live,
      level: s.level,
      okLeftMs: s.phase === 'ok' ? Math.max(0, cfg.advanceMs - (now - s.okAt)) : 0,
      stepMs: s.stepAt === null ? 0 : Math.max(0, now - s.stepAt),
      stuck: s.phase === 'try' && s.stepAt !== null && now - s.stepAt >= cfg.stuckMs,
      hint: s.hint ? { ...s.hint } : null,
      results: s.results.slice(),
      recognized: ok,
      skipped,
      seq,
      source: s.source,
      valid: s.valid,
    };
  }

  return {
    update,
    skip,
    skipAll,
    restart,
    reset: () => { fresh(null); seq++; },
    view,
    get index() { return s.index; },
    get done() { return s.phase === 'done'; },
    get steps() { return steps; },
  };
}
