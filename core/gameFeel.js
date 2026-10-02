// ASHEN OATH — core/gameFeel.js [FEEL]: «отклик» боя на удар — остановка кадра, замедление, тряска камеры.
// Чистая логика без DOM и THREE: main.js передаёт события боя кадра, получает, на сколько остановить и
// замедлить боевое время и насколько встряхнуть камеру (core/cameraRig.js → shake).
//
//   feelOf(event, { reducedMotion }) → { stopMs, slowMs, slowScale, shake }
//     stopMs  — остановка кадра (hit-stop), мс; боевое время почти стоит (×0.04)
//     slowMs  — замедление, мс; slowScale — во сколько раз (0.3 = в три раза медленнее)
//     shake   — «травма» камеры 0..1 (амплитуда ∝ травма², см. cameraRig.shake)
//
// «Уменьшенное движение»: тряски нет, остановка кадра — вдвое короче и не дольше REDUCED_STOP_MAX_MS.
// Замедление остаётся: оно не двигает камеру, а даёт время прочитать момент.
//
// Прежние правила main.js (руна/выброс/печать/фаза — 80 мс, попадание по герою ≥20 — 60 мс, идеальный
// рывок — замедление 0,65 с ×0,3) сохранены как есть; добавлены сильные удары по Регенту, попадание по
// герою от 13 урона (удары «Лёгкой» сложности), парирование (замедление 0,3 с) и тряска по силе урона.

export const FEEL_TIME = Object.freeze({
  stopScale: 0.04,            // во столько раз идёт бой во время остановки кадра
  strongHit: 30,              // урон по Регенту, с которого удар «сильный» (остановка кадра)
  strongStopMs: [60, 90],     // остановка кадра сильного удара: от strongHit до strongHit + 50 урона
  critStopMs: 75,             // крит (по открытому Регенту, заряженный выстрел, отражённая сфера)
  parrySlowMs: 300,           // успешное парирование: замедление 0,3 с
  parrySlowScale: 0.35,
  perfectDodgeSlowMs: 650,    // идеальный рывок (как раньше)
  perfectDodgeSlowScale: 0.3,
  reducedStopMaxMs: 40,
});

const NONE = Object.freeze({ stopMs: 0, slowMs: 0, slowScale: 1, shake: 0 });
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function rawFeel(e) {
  const d = e && e.data && typeof e.data === 'object' ? e.data : {};
  const F = FEEL_TIME;
  switch (e && e.type) {
    case 'boss_hit': {
      if (d.source === 'burn' || d.dot) return NONE;           // тики горения — без отклика
      const a = num(d.amount, 0);
      const crit = !!(d.recoverBonus || d.charged);
      let stopMs = 0;
      if (a >= F.strongHit) stopMs = F.strongStopMs[0] + (F.strongStopMs[1] - F.strongStopMs[0]) * clamp((a - F.strongHit) / 50, 0, 1);
      if (crit) stopMs = Math.max(stopMs, F.critStopMs);
      // тряска по силе урона: очередь снарядов (6–9) — едва, выброс (100+) — ощутимо
      const shake = a < 4 ? 0 : clamp(0.03 + (a - 4) / 160, 0.03, 0.42) * (crit ? 1.3 : 1);
      return { stopMs, slowMs: 0, slowScale: 1, shake };
    }
    case 'player_hit': {
      const a = num(d.amount, 0);
      // прежнее правило — 60 мс от 20 урона; на «Лёгкой» удары слабее (13–18), поэтому от 13 — 50 мс
      return { stopMs: a >= 20 ? 60 : a >= 13 ? 50 : 0, slowMs: 0, slowScale: 1, shake: clamp(0.28 + a / 60, 0.3, 0.75) };
    }
    case 'parry':
      return d.success ? { stopMs: 0, slowMs: F.parrySlowMs, slowScale: F.parrySlowScale, shake: 0.22 } : NONE;
    case 'perfect_dodge':
      return { stopMs: 0, slowMs: F.perfectDodgeSlowMs, slowScale: F.perfectDodgeSlowScale, shake: 0 };
    case 'burst':
      return { stopMs: 80, slowMs: 0, slowScale: 1, shake: 0.22 + 0.2 * clamp(num(d.power, 0.5), 0, 1) };
    case 'rune_cast': return { stopMs: 80, slowMs: 0, slowScale: 1, shake: 0.18 };
    case 'sigil_cast': return { stopMs: 80, slowMs: 0, slowScale: 1, shake: 0.2 };
    case 'boss_phase': return { stopMs: 80, slowMs: 0, slowScale: 1, shake: 0.3 };
    case 'block': return { stopMs: 0, slowMs: 0, slowScale: 1, shake: 0.14 };
    case 'boss_impact': return d.launch ? NONE : { stopMs: 0, slowMs: 0, slowScale: 1, shake: d.attackKind === 'nova' ? 0.3 : 0.24 };
    default: return NONE;
  }
}

/** Отклик одного события с учётом «Уменьшенного движения». */
export function feelOf(e, opts) {
  const r = rawFeel(e);
  if (r === NONE) return NONE;
  if (!(opts && opts.reducedMotion)) return r;
  return { stopMs: Math.min(r.stopMs * 0.5, FEEL_TIME.reducedStopMaxMs), slowMs: r.slowMs, slowScale: r.slowScale, shake: 0 };
}

/** Сумма за кадр: самая длинная остановка, самое длинное замедление, тряска складывается (не больше 1). */
export function feelOfEvents(events, opts) {
  let stopMs = 0, slowMs = 0, slowScale = 1, shake = 0;
  if (!Array.isArray(events)) return { stopMs, slowMs, slowScale, shake };
  for (const e of events) {
    const f = feelOf(e, opts);
    if (f.stopMs > stopMs) stopMs = f.stopMs;
    if (f.slowMs > slowMs) { slowMs = f.slowMs; slowScale = f.slowScale; }
    shake += f.shake;
  }
  return { stopMs, slowMs, slowScale, shake: Math.min(1, shake) };
}
