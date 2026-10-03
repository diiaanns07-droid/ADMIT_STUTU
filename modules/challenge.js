// ASHEN OATH — [W3-CHALLENGE] «Испытание · 60 с»: одинаковая короткая попытка для каждого, очки, ранг и
// «Зал славы дня» на этом ноутбуке. Члены жюри по очереди проходят одну и ту же минуту и видят себя в таблице.
//
// Что здесь:
//  - CHALLENGE — правила попытки: 60 с боя, фиксированный seed Регента (одинаковый порядок атак у всех),
//    своя сложность (прежняя «Лёгкая», combat 'challenge'), отсчёт 3-2-1 перед стартом, пауза «ВРЕМЯ ВЫШЛО» перед итогами;
//  - scoreChallenge(tally) — очки: урон + лучшая серия + бонус за точность жестов + бонус за магию
//    (события 'sigil_cast', 'rune_cast') и ультимейт (любое событие с «ultimate» в имени) + победа и
//    оставшееся время; rankOf(score) — ранг S / A / B / C / D;
//  - createTally() — подсчёт по событиям боя (combat.drainEvents) и снимку; ведётся в каждом бою,
//    поэтому постер и очки есть и после обычного боя;
//  - createHall(storage) — зал славы дня в localStorage: топ-10 на экране, хранится до 50 попыток за день,
//    битое или недоступное хранилище не роняет игру (тогда — память вкладки);
//  - createChallengeBrain(createBossBrain, config) — мозг Регента для боя: обычный (случайный seed страницы)
//    или фиксированный испытания; combat не знает о подмене;
//  - createChallengeSession() — фазы попытки: armed → countdown → running → timeup → done;
//  - createChallengeHud() — крупный таймер, очки, отсчёт и «ВРЕМЯ ВЫШЛО» поверх боя (DOM, без своего rAF);
//  - createChallengeScreen(helpers) — экран итогов: ранг, очки, место в зале, имя из 3 букв крупными
//    кнопками, таблица дня, постер. DOM строят помощники modules/ui.js (как у «Тренажёра техники»).
// Модуль не открывает камеру и не хранит видео: в итог попадают только числа и точки скелета.

export const CHALLENGE = Object.freeze({
  seconds: 60,
  seed: 20261002,          // одинаковый для всех порядок атак Регента
  difficulty: 'challenge', // [W5-СЛОЖНОСТЬ] своя сложность — прежняя «Лёгкая» (Регент −30%): попытка честная с первого раза, рекорды сравнимы
  countdownMs: 3000,       // 3-2-1 перед стартом (бой стоит)
  goMs: 700,               // «ВПЕРЁД!» держится после отсчёта
  timeUpMs: 1800,          // «ВРЕМЯ ВЫШЛО» поверх застывшего боя, потом — итоги
});

// Очки. Неуверенная первая попытка — 2–4 тыс. (C), уверенная — 4–7 тыс. (B), почти победа — от 7 тыс. (A),
// победа над Регентом с запасом времени — от 12 тыс. (S). Пороги сверены прогоном настоящего боя (dev/challenge.test.mjs).
export const SCORE = Object.freeze({
  damage: 10,              // за единицу урона по Регенту
  combo: 30,               // за каждое попадание лучшей серии
  accuracy: 12,            // за процент точности жестов…
  accuracyFullAt: 8,       // …полный бонус — от стольких распознанных жестов (один удачный жест не даёт 1200)
  magic: 300,              // каждая печать или руна
  magicNew: 200,           // первая печать/руна каждого вида
  ultimate: 1000,          // ультимейт
  victory: 2500,           // Регент повержен
  perSecondLeft: 60,       // за каждую оставшуюся секунду при победе
});

// [W5-СЛОЖНОСТЬ] Обычный бой (не испытание): урон в очках — как у прежней «Лёгкой» (700 HP: Регент целиком = 7000) на
// любом уровне; победа быстрее нормы уровня — FIGHT_PER_SECOND очков за каждую секунду (затянуть бой ради чар невыгодно);
// затем множитель сложности (config.js combat.difficulty.*.scoreMul). Нормы — с запасом: в 1,5–2 раза дольше медианы
// «среднего» бота (tools/balance_bot.mjs).
export const FIGHT_DAMAGE_BASE = 700;
export const FIGHT_PAR = Object.freeze({ easy: 240, normal: 330, hard: 420, nightmare: 480 });
export const FIGHT_PER_SECOND = 30;

export const RANKS = Object.freeze([
  Object.freeze({ id: 'S', min: 12000, title: 'Легенда арены' }),
  Object.freeze({ id: 'A', min: 7000, title: 'Мастер клятвы' }),
  Object.freeze({ id: 'B', min: 4000, title: 'Страж' }),
  Object.freeze({ id: 'C', min: 2000, title: 'Ученик' }),
  Object.freeze({ id: 'D', min: 0, title: 'Новобранец' }),
]);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (fin(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isObj = (v) => v !== null && typeof v === 'object';

export function rankOf(score) {
  const s = num(score);
  for (const r of RANKS) if (s >= r.min) return r.id;
  return 'D';
}
export function rankInfo(id) { return RANKS.find((r) => r.id === id) || RANKS[RANKS.length - 1]; }
// Сколько не хватило до следующего ранга: { id, need } или null для S
export function nextRank(score) {
  const s = num(score);
  let next = null;
  for (const r of RANKS) if (r.min > s) next = r;
  return next ? { id: next.id, need: Math.ceil(next.min - s) } : null;
}

// ───────── подсчёт по событиям боя ─────────
// Ультимейт (ветка «Небесный суд»: ultimate_ready → ultimate_start → ultimate_strike → ultimate_end): подходит
// любое событие с «ultimate» (или «ult») в имени, кроме служебных (готовность, удар, конец), и player_cast с
// ability 'ultimate' — подсчёт не зависит от точного имени. Урон удара считается как обычный урон (снимок).
const ULT_TYPE = /(^|_)ult(imate)?(_|$)|ultimate/i;
const ULT_SKIP = /hit|strike|end|ready|charge|denied|tick|fail|cancel|progress|stop|expire|miss/i;
export function isUltimateEvent(e) {
  if (!isObj(e) || typeof e.type !== 'string') return false;
  if (e.type === 'player_cast') return !!(e.data && typeof e.data.ability === 'string' && ULT_TYPE.test(e.data.ability));
  return ULT_TYPE.test(e.type) && !ULT_SKIP.test(e.type);
}
// Новая магия: печати (в т. ч. новые печати «Новичка») и руны «Мастера»
export function magicKindOf(e) {
  if (!isObj(e)) return null;
  if (e.type === 'sigil_cast') return `sigil:${(e.data && (e.data.sigil || e.data.kind)) || '?'}`;
  if (e.type === 'rune_cast') return `rune:${(e.data && e.data.rune) || '?'}`;
  return null;
}
const ULT_GAP_SEC = 4;   // события одной сцены ультимейта (≈3,6 с) — один ультимейт

export function createTally() {
  const t = { hits: 0, maxCombo: 0, magic: 0, kinds: new Set(), ultimates: 0, lastUlt: -1e9, seen: new Set(), startDamage: 0, startTime: 0, lastHitAt: null };
  function reset(snap) {
    t.hits = 0; t.maxCombo = 0; t.magic = 0; t.kinds.clear(); t.ultimates = 0; t.lastUlt = -1e9; t.seen.clear(); t.lastHitAt = null;
    t.startDamage = num(snap && snap.stats && snap.stats.damageDealt);
    t.startTime = num(snap && snap.time);
  }
  // events — массив событий кадра; atSec — время боя (snap.time). Возвращает true, если было попадание по Регенту.
  function add(events, atSec) {
    let hit = false;
    if (!Array.isArray(events)) return hit;
    for (const e of events) {
      if (!isObj(e) || (e.data && e.data.remote)) continue;   // [NET] события соперника не считаются
      if (e.id && t.seen.has(e.id)) continue;
      if (e.id) { t.seen.add(e.id); if (t.seen.size > 4000) t.seen.clear(); }
      if (e.type === 'boss_hit') {
        t.hits++; hit = true; t.lastHitAt = num(atSec, t.lastHitAt);
        t.maxCombo = Math.max(t.maxCombo, Math.round(num(e.data && e.data.combo)));
        continue;
      }
      const mk = magicKindOf(e);
      if (mk) { t.magic++; t.kinds.add(mk); continue; }
      if (isUltimateEvent(e)) {
        const at = num(atSec);
        if (at - t.lastUlt >= ULT_GAP_SEC) { t.ultimates++; t.lastUlt = at; }
      }
    }
    return hit;
  }
  // Итог для scoreChallenge: урон — по снимку (с поправкой на урон до начала попытки)
  function read(snap, coach) {
    const dmg = Math.max(0, num(snap && snap.stats && snap.stats.damageDealt) - t.startDamage);
    const c = isObj(coach) ? coach : {};
    return {
      damage: dmg, maxCombo: t.maxCombo, hits: t.hits,
      accuracy: fin(c.accuracy) ? c.accuracy : null, gestures: num(c.good) + num(c.mistakes),
      magic: t.magic, magicKinds: t.kinds.size, ultimates: t.ultimates,
      elapsed: Math.max(0, num(snap && snap.time) - t.startTime),
    };
  }
  return { reset, add, read, get lastHitAt() { return t.lastHitAt; } };
}

// tally = { damage, maxCombo, accuracy (0–100 | null), gestures, magic, magicKinds, ultimates, victory, timeLeft }
// [W5-СЛОЖНОСТЬ] + damageScale (обычный бой: урон в очках — на 1000 HP Регента), scoreMul и difficultyName —
// множитель сложности отдельной строкой («Сложная» ×1,5, «Кошмар» ×2); без них — как раньше.
export function scoreChallenge(tally) {
  const T = isObj(tally) ? tally : {};
  const parts = [];
  const dmg = Math.max(0, Math.round(num(T.damage)));
  const dScale = fin(T.damageScale) && T.damageScale > 0 ? T.damageScale : 1;
  parts.push({ id: 'damage', label: 'Урон', detail: `${dmg}`, points: dmg * SCORE.damage * dScale });
  const combo = Math.max(0, Math.round(num(T.maxCombo)));
  parts.push({ id: 'combo', label: 'Лучшая серия', detail: combo ? `×${combo}` : '—', points: combo * SCORE.combo });
  const acc = fin(T.accuracy) ? clamp(Math.round(T.accuracy), 0, 100) : null;
  const gest = Math.max(0, Math.round(num(T.gestures)));
  const accPts = acc === null ? 0 : Math.round(acc * SCORE.accuracy * Math.min(1, gest / SCORE.accuracyFullAt));
  parts.push({ id: 'accuracy', label: 'Точность жестов', detail: acc === null ? '—' : `${acc}%`, points: accPts });
  const magic = Math.max(0, Math.round(num(T.magic))), kinds = clamp(Math.round(num(T.magicKinds)), 0, magic);
  const ult = Math.max(0, Math.round(num(T.ultimates)));
  const magicPts = magic * SCORE.magic + kinds * SCORE.magicNew + ult * SCORE.ultimate;
  const magicDetail = [magic ? `${magic} ${plural(magic, 'чара', 'чары', 'чар')}` : '', ult ? `ультимейт ×${ult}` : ''].filter(Boolean).join(' · ') || '—';
  parts.push({ id: 'magic', label: 'Магия и ультимейт', detail: magicDetail, points: magicPts });
  if (T.victory) {
    const left = Math.max(0, Math.floor(num(T.timeLeft)));
    const rate = fin(T.perSecondLeft) && T.perSecondLeft >= 0 ? T.perSecondLeft : SCORE.perSecondLeft;   // [W5-СЛОЖНОСТЬ] обычный бой — своя цена секунды
    const detail = left ? (T.fight ? `быстрее нормы на ${left} с` : `+${left} с в запасе`) : '';
    parts.push({ id: 'victory', label: 'Регент повержен', detail, points: SCORE.victory + left * rate });
  }
  for (const p of parts) p.points = Math.max(0, Math.round(p.points));
  const mul = fin(T.scoreMul) && T.scoreMul > 0 ? T.scoreMul : 1;
  if (mul !== 1) {   // [W5-СЛОЖНОСТЬ]
    const base = parts.reduce((s, p) => s + p.points, 0);
    const nm = typeof T.difficultyName === 'string' && T.difficultyName ? `«${T.difficultyName}» ` : '';
    parts.push({ id: 'difficulty', label: 'Сложность', detail: `${nm}×${String(mul).replace('.', ',')}`, points: Math.max(0, Math.round(base * (mul - 1))) });
  }
  const total = parts.reduce((s, p) => s + p.points, 0);
  return { total, rank: rankOf(total), parts };
}

export function plural(n, one, few, many) {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}
export function fmtScore(n) { return String(Math.max(0, Math.round(num(n)))).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
export function placeText(place) { return `${place}-е место`; }

// Лучший жест боя — по числу удачных распознаваний (core/gestureCoach.js summary().groups)
export function bestGestureOf(coach) {
  const g = isObj(coach) && Array.isArray(coach.groups) ? coach.groups.filter((x) => isObj(x) && x.good > 0) : [];
  if (!g.length) return null;
  g.sort((a, b) => b.good - a.good || b.accuracy - a.accuracy);
  return { id: g[0].id, title: g[0].title, good: g[0].good, accuracy: g[0].accuracy };
}

// ───────── зал славы дня ─────────
export const HALL_KEY = 'ashen-oath.hall.v1';
const HALL_KEEP = 50;     // попыток за день в хранилище (на экране — топ-10 и своё место)
export const HALL_SHOW = 10;

export function dayKey(ms) {
  const d = new Date(fin(ms) ? ms : Date.now());
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// Имя — до 3 букв или цифр (любой алфавит), заглавными
export function sanitizeName(s) {
  const out = [];
  for (const ch of String(s == null ? '' : s).toUpperCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) out.push(ch);
    if (out.length >= 3) break;
  }
  return out.join('');
}
function cleanEntry(e) {
  if (!isObj(e) || !fin(e.score) || typeof e.id !== 'string' || !e.id) return null;
  return {
    id: e.id.slice(0, 40),
    name: sanitizeName(e.name),
    score: Math.max(0, Math.round(e.score)),
    rank: RANKS.some((r) => r.id === e.rank) ? e.rank : rankOf(e.score),
    t: fin(e.t) ? e.t : 0,
    day: typeof e.day === 'string' ? e.day.slice(0, 10) : '',
    acc: fin(e.acc) ? clamp(Math.round(e.acc), 0, 100) : null,
    dmg: fin(e.dmg) ? Math.max(0, Math.round(e.dmg)) : 0,
    combo: fin(e.combo) ? Math.max(0, Math.round(e.combo)) : 0,
    mode: e.mode === 'master' || e.mode === 'debug' ? e.mode : 'novice',
    hero: typeof e.hero === 'string' ? e.hero.slice(0, 24) : '',
    won: e.won === true,
    diff: typeof e.diff === 'string' ? e.diff.slice(0, 16) : '',    // [W5-СЛОЖНОСТЬ] уровень сложности боя
    sec: fin(e.sec) && e.sec > 0 ? Math.round(e.sec * 10) / 10 : null, // [W5-СЛОЖНОСТЬ] время боя, с
  };
}
export function sortHall(list) {
  return list.slice().sort((a, b) => b.score - a.score || a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// storage — localStorage или объект с getItem/setItem/removeItem; любые его ошибки не бросаются наружу.
export function createHall(storage, { key = HALL_KEY, keep = HALL_KEEP, show = HALL_SHOW, now = () => Date.now() } = {}) {
  let mem = null;          // запасная копия, если хранилище не пишет (приватный режим, квота)
  let memOnly = false;     // запись не удалась — дальше верна только копия в памяти
  let seq = 0;
  function read() {
    let raw = null;
    if (!memOnly) { try { raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null; } catch (e) { raw = null; memOnly = true; } }
    let list = null;
    if (!memOnly && typeof raw === 'string' && raw) {
      try { const v = JSON.parse(raw); list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.entries) ? v.entries : null; } catch (e) { list = null; }
    }
    if (!list) list = mem || [];
    const out = [];
    const ids = new Set();
    for (const x of list) { const c = cleanEntry(x); if (c && !ids.has(c.id)) { ids.add(c.id); out.push(c); } }
    return out;
  }
  function write(list) {
    mem = list;
    try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, JSON.stringify({ v: 1, entries: list })); else memOnly = true; } catch (e) { memOnly = true; /* остаётся копия в памяти */ }
  }
  const today = () => dayKey(now());
  function todays() { const d = today(); return sortHall(read().filter((e) => e.day === d)); }
  return {
    // топ дня (по умолчанию 10)
    list(n = show) { return todays().slice(0, n); },
    all: todays,
    best() { return todays()[0] || null; },
    // result: { score, rank, accuracy, damage, maxCombo, mode, hero, won } → { entry, place, total, isRecord, prevBest }
    add(result) {
      const r = isObj(result) ? result : {};
      const t = now();
      const entry = cleanEntry({
        id: `${t.toString(36)}-${(++seq).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        name: r.name || '', score: num(r.score), rank: r.rank, t, day: dayKey(t),
        acc: r.accuracy, dmg: r.damage, combo: r.maxCombo, mode: r.mode, hero: r.hero, won: !!r.won,
        diff: r.difficulty, sec: r.elapsed,   // [W5-СЛОЖНОСТЬ]
      });
      const before = todays();
      const prevBest = before[0] || null;
      // за день — не больше keep попыток (лишние — самые слабые), прошлые дни не хранятся
      const list = sortHall([...before, entry]).slice(0, keep);
      write(list);
      const idx = list.findIndex((e) => e.id === entry.id);
      const place = idx >= 0 ? idx + 1 : list.length + 1;
      return { entry, place, total: before.length + 1, isRecord: place === 1, prevBest };
    },
    rename(id, name) {
      const list = read();
      const e = list.find((x) => x.id === id);
      if (!e) return false;
      e.name = sanitizeName(name);
      write(list);
      return true;
    },
    placeOf(id) { const i = todays().findIndex((e) => e.id === id); return i >= 0 ? i + 1 : null; },
    clear() {
      mem = [];
      try { if (storage && typeof storage.removeItem === 'function') storage.removeItem(key); else if (storage && typeof storage.setItem === 'function') storage.setItem(key, '[]'); } catch (e) { /* ignore */ }
    },
  };
}

// ───────── мозг Регента: обычный или испытания ─────────
// Обычный бой — seed страницы (main.js, случайный при загрузке); испытание — CHALLENGE.seed, одинаковый у всех.
export function createChallengeBrain(createBossBrain, config, seed = CHALLENGE.seed) {
  const normal = createBossBrain(config);
  let fixed = null, on = false;
  const cur = () => (on ? fixed : normal);
  return {
    reset() { return cur().reset(); },
    update(dt, snap) { return cur().update(dt, snap); },
    getDebug() { const b = cur(); return typeof b.getDebug === 'function' ? b.getDebug() : null; },
    getConfig() { const b = cur(); return typeof b.getConfig === 'function' ? b.getConfig() : null; },
    // true — следующий combat.reset() начнёт бой с фиксированным порядком атак
    useChallenge(v) {
      on = !!v;
      if (on && !fixed) fixed = createBossBrain({ ...config, boss: { ...(config && config.boss), seed } });
    },
    get challenge() { return on; },
  };
}

// ───────── фазы попытки ─────────
// armed — кнопку нажали, ждём боя (камера, калибровка); countdown — 3-2-1, бой стоит; running — идёт минута;
// timeup — «ВРЕМЯ ВЫШЛО», бой застыл; done — экран итогов. Время попытки — время боя (snap.time): пауза
// и потеря трекинга его не тратят.
export function createChallengeSession(rules = CHALLENGE) {
  const R = { ...CHALLENGE, ...(isObj(rules) ? rules : {}) };
  const st = { phase: 'off', until: 0, goUntil: 0, startTime: 0, left: R.seconds, lastTick: 0, timeUpAt: 0, outcome: null, force: false };
  return {
    rules: R,
    get phase() { return st.phase; },
    get active() { return st.phase !== 'off'; },
    get outcome() { return st.outcome; },
    arm() { st.phase = 'armed'; st.outcome = null; st.left = R.seconds; st.force = false; },
    disarm() { st.phase = 'off'; st.outcome = null; },
    // бой сброшен и показан: отсчёт 3-2-1
    begin(nowMs, snap) {
      st.phase = 'countdown'; st.until = nowMs + R.countdownMs; st.goUntil = 0;
      st.startTime = num(snap && snap.time); st.left = R.seconds; st.lastTick = Math.ceil(R.countdownMs / 1000) + 1; st.outcome = null; st.force = false;
    },
    // бой стоит: отсчёт или «ВРЕМЯ ВЫШЛО»
    frozen(nowMs) { return (st.phase === 'countdown' && nowMs < st.until) || st.phase === 'timeup'; },
    // кадр боя. Сигналы: 'tick' (3, 2, 1), 'go', 'timeup', 'show' (пора на экран итогов) или null
    frame(nowMs, snap) {
      if (st.phase === 'countdown') {
        if (nowMs >= st.until || st.force) { st.phase = 'running'; st.goUntil = nowMs + R.goMs; st.startTime = num(snap && snap.time, st.startTime); return 'go'; }
        const n = Math.ceil((st.until - nowMs) / 1000);
        if (n !== st.lastTick) { st.lastTick = n; return 'tick'; }
        return null;
      }
      if (st.phase === 'running') {
        st.left = st.force ? 0 : Math.max(0, R.seconds - (num(snap && snap.time) - st.startTime));
        if (st.left <= 0) { st.phase = 'timeup'; st.timeUpAt = nowMs; st.outcome = 'timeup'; return 'timeup'; }
        return null;
      }
      if (st.phase === 'timeup' && nowMs - st.timeUpAt >= R.timeUpMs) { st.phase = 'done'; return 'show'; }
      return null;
    },
    // Регент повержен или герой пал раньше конца минуты
    end(outcome, snap) {
      if (st.phase !== 'running' && st.phase !== 'countdown') return false;
      st.left = Math.max(0, R.seconds - (num(snap && snap.time) - st.startTime));
      st.phase = 'done'; st.outcome = outcome === 'victory' ? 'victory' : 'defeat';
      return true;
    },
    // QA: конец минуты на следующем кадре (тем же путём, что и настоящий: сигнал 'timeup')
    finishNow() { if (st.phase === 'running' || st.phase === 'countdown') st.force = true; return st.phase; },
    timeLeft() { return st.left; },
    elapsed() { return R.seconds - st.left; },
    // для HUD: { phase, left, count (3/2/1 | 0 — «ВПЕРЁД»), go }
    view(nowMs) {
      return {
        phase: st.phase, left: st.left, seconds: R.seconds,
        count: st.phase === 'countdown' ? Math.max(1, Math.ceil((st.until - nowMs) / 1000)) : 0,
        go: st.phase === 'running' && nowMs < st.goUntil,
      };
    },
  };
}

// Итог попытки (или обычного боя) для экрана, зала славы и постера.
// [W5-СЛОЖНОСТЬ] difficulty = { level, name, scoreMul } (combat.getDifficulty + название): в обычном бою урон в очках —
// как у прежней «Лёгкой» (FIGHT_DAMAGE_BASE), победа быстрее нормы — бонус за секунды, затем множитель сложности.
// «Испытание» — без изменений.
export function buildResult({ tally, snap, coach, session, kind = 'challenge', mode = 'novice', hero = '', heroName = '', difficulty = null } = {}) {
  const T = tally && typeof tally.read === 'function' ? tally.read(snap, coach) : {};
  const won = !!(snap && snap.status === 'victory');
  const timeLeft = session ? session.timeLeft() : 0;
  const D = isObj(difficulty) ? difficulty : {};
  const maxHp = num(snap && snap.boss && snap.boss.maxHp);
  const fight = kind === 'fight';
  const scoreMul = fight && fin(D.scoreMul) && D.scoreMul > 0 ? D.scoreMul : 1;
  const par = fight && typeof D.level === 'string' && FIGHT_PAR[D.level] ? FIGHT_PAR[D.level] : 0;
  const fightLeft = par && won ? Math.max(0, par - num(snap && snap.time)) : 0;
  const sc = scoreChallenge({
    ...T, victory: won, timeLeft: kind === 'challenge' ? timeLeft : fightLeft,
    damageScale: fight && maxHp > 0 ? FIGHT_DAMAGE_BASE / maxHp : 1, scoreMul, difficultyName: typeof D.name === 'string' ? D.name : '',
    fight, perSecondLeft: fight ? FIGHT_PER_SECOND : undefined,
  });
  return {
    difficulty: typeof D.level === 'string' ? D.level : '', difficultyName: typeof D.name === 'string' ? D.name : '', scoreMul,   // [W5-СЛОЖНОСТЬ]
    kind, score: sc.total, rank: sc.rank, rankTitle: rankInfo(sc.rank).title, parts: sc.parts, next: nextRank(sc.total),
    outcome: kind === 'challenge' ? (session && session.outcome) || (won ? 'victory' : 'timeup') : won ? 'victory' : 'defeat',
    won, timeLeft, elapsed: kind === 'challenge' && session ? session.elapsed() : num(snap && snap.time),
    damage: Math.round(num(T.damage)), maxCombo: num(T.maxCombo), accuracy: fin(T.accuracy) ? T.accuracy : null, gestures: num(T.gestures),
    magic: num(T.magic), ultimates: num(T.ultimates), bestGesture: bestGestureOf(coach), mode, hero, heroName,
  };
}

// ───────── оформление (DOM) ─────────
const CSS_ID = 'ao-challenge-css';
function ensureCss(doc) {
  if (!doc || doc.getElementById(CSS_ID)) return;
  try {
    const l = doc.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet';
    l.href = new URL('./challenge.css', import.meta.url).href;
    (doc.head || doc.documentElement).appendChild(l);
  } catch (e) { console.warn('[challenge] challenge.css', e); }
}
// запись в DOM только при изменении значения
function put(node, prop, v) { if (node[prop] !== v) node[prop] = v; }
function attr(node, name, v) { if (v === null || v === undefined) { if (node.hasAttribute(name)) node.removeAttribute(name); } else if (node.getAttribute(name) !== String(v)) node.setAttribute(name, String(v)); }

// Крупный таймер и очки над боем, отсчёт 3-2-1, «ВРЕМЯ ВЫШЛО», вспышка рекорда. root — #ao-ui-root.
export function createChallengeHud({ root } = {}) {
  const doc = root && root.ownerDocument;
  if (!doc) return { update() {}, celebrate() {}, dispose() {} };
  ensureCss(doc);
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const node = mk('div', 'ao-chalhud'); node.hidden = true; attr(node, 'aria-hidden', 'true');
  const pill = mk('div', 'ao-chalhud__pill');
  const clock = mk('div', 'ao-chalhud__clock');
  const secs = mk('span', 'ao-chalhud__secs', '60');
  const unit = mk('span', 'ao-chalhud__unit', 'с');
  clock.append(secs, unit);
  const side = mk('div', 'ao-chalhud__side');
  const score = mk('strong', 'ao-chalhud__score', '0');
  const label = mk('span', 'ao-chalhud__label', 'очков');
  const rank = mk('span', 'ao-chalhud__rank', 'D');
  side.append(score, label);
  pill.append(clock, side, rank);
  const bar = mk('div', 'ao-chalhud__bar'); const fill = mk('div', 'ao-chalhud__fill'); bar.append(fill);
  pill.append(bar);
  const big = mk('div', 'ao-chalhud__big'); big.hidden = true;
  const bigNum = mk('div', 'ao-chalhud__bignum');
  const bigSub = mk('div', 'ao-chalhud__bigsub');
  const bigHint = mk('div', 'ao-chalhud__bighint');
  big.append(bigNum, bigSub, bigHint);
  node.append(pill, big);
  root.appendChild(node);
  // вспышка нового рекорда — поверх всего интерфейса (на экране итогов)
  const flash = mk('div', 'ao-chalflash'); flash.hidden = true; attr(flash, 'aria-hidden', 'true');
  doc.body.appendChild(flash);
  let flashTimer = 0;
  return {
    // v = { show, phase, left, seconds, count, go, outcome, score, rank, hint (главные жесты — на отсчёте) }
    update(v) {
      const show = !!(v && v.show);
      put(node, 'hidden', !show);
      if (!show) return;
      const left = Math.max(0, num(v.left));
      const whole = Math.ceil(left - 1e-6);
      put(secs, 'textContent', String(whole));
      attr(node, 'data-phase', v.phase);
      attr(node, 'data-hurry', v.phase === 'running' && left <= 10 ? (left <= 5 ? 'hot' : 'on') : null);
      const frac = clamp(left / Math.max(1, num(v.seconds, 60)), 0, 1);
      const w = `${Math.round(frac * 1000) / 10}%`;
      if (fill.style.width !== w) fill.style.width = w;
      put(score, 'textContent', fmtScore(v.score));
      put(rank, 'textContent', v.rank || 'D');
      attr(rank, 'data-rank', v.rank || 'D');
      let bn = '', bs = '', bh = '';
      if (v.phase === 'countdown') { bn = String(v.count); bs = `Испытание · ${num(v.seconds, 60)} секунд — бей Регента!`; bh = v.hint || ''; }
      else if (v.go) { bn = 'ВПЕРЁД!'; bs = 'Очки: урон, серии, точность жестов, магия'; }
      else if (v.phase === 'timeup' || v.phase === 'done') { bn = v.outcome === 'victory' ? 'РЕГЕНТ ПОВЕРЖЕН!' : v.outcome === 'defeat' ? 'ГЕРОЙ ПАЛ' : 'ВРЕМЯ ВЫШЛО!'; bs = `${fmtScore(v.score)} очков`; }
      else if (v.phase === 'running' && left <= 3.05 && left > 0) { bn = String(whole); bs = ''; }
      put(big, 'hidden', !bn);
      if (bn) {
        if (bigNum.textContent !== bn) { bigNum.textContent = bn; bigNum.classList.remove('is-pop'); void bigNum.offsetWidth; bigNum.classList.add('is-pop'); }
        put(bigSub, 'textContent', bs);
        put(bigHint, 'textContent', bh);
        put(bigHint, 'hidden', !bh);
        attr(big, 'data-kind', v.phase === 'countdown' ? 'count' : v.go ? 'go' : v.phase === 'running' ? 'last' : 'end');
      }
    },
    // новый рекорд дня: золотая вспышка и искры (CSS-анимация, без своего rAF)
    celebrate({ reducedMotion = false } = {}) {
      clearTimeout(flashTimer);
      flash.replaceChildren();
      flash.hidden = false;
      attr(flash, 'data-rm', reducedMotion ? '1' : null);
      flash.classList.remove('is-on'); void flash.offsetWidth; flash.classList.add('is-on');
      if (!reducedMotion) {
        for (let i = 0; i < 46; i++) {
          const s = mk('i', 'ao-chalflash__spark');
          const a = (i / 46) * Math.PI * 2 + Math.random() * 0.3, d = 28 + Math.random() * 34;
          s.style.setProperty('--dx', `${Math.cos(a) * d}vmin`);
          s.style.setProperty('--dy', `${Math.sin(a) * d - 8}vmin`);
          s.style.setProperty('--dl', `${Math.round(Math.random() * 220)}ms`);
          s.style.setProperty('--hue', `${36 + Math.round(Math.random() * 18)}`);
          flash.append(s);
        }
      }
      flashTimer = setTimeout(() => { flash.hidden = true; flash.classList.remove('is-on'); flash.replaceChildren(); }, 2600);
    },
    dispose() { clearTimeout(flashTimer); node.remove(); flash.remove(); },
  };
}

// Строки зала: топ-10 и своё место за десяткой; пока вводится имя (место на экране уже занято клавишами) —
// компактно: тройка лидеров и соседи сверху и снизу. list — все попытки дня по убыванию очков.
export function hallRows(list, meId, compact = false) {
  const L = Array.isArray(list) ? list.filter((e) => e && typeof e === 'object') : [];
  const idx = meId ? L.findIndex((e) => e.id === meId) : -1;
  const at = (i) => ({ e: L[i], place: i + 1 });
  if (compact && idx >= 5) return [at(0), at(1), at(2), 'gap', ...[idx - 1, idx, idx + 1].filter((i) => i < L.length).map(at)];
  const n = compact ? 6 : HALL_SHOW;
  const out = L.slice(0, n).map((e, i) => at(i));
  if (idx >= n) out.push('gap', at(idx));
  return out;
}

// Буквы для имени — крупными кнопками (мышь, касание); с клавиатуры можно печатать любые буквы
const LETTERS = {
  ru: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЫЭЮЯ'.split(''),
  en: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'.split(''),
};
const OUTCOME_TITLE = { timeup: 'Время вышло!', victory: 'Регент повержен!', defeat: 'Герой пал' };
const MODE_MARK = { novice: '', master: 'М', debug: '⌨' };

// Экран итогов испытания. h — помощники modules/ui.js: { uid, el, btn, setBtn, listen, heading, screenSection,
// setText, setHidden, setAttr, setClass, invoke, announce, doc }.
// viewModel.challenge.result: итог buildResult + { place, total, isRecord, entryId, name, named }, hall: [строки дня], posterUrl
export function createChallengeScreen(h) {
  const { el, btn, setBtn, listen, setText, setHidden, setAttr, setClass, invoke } = h;
  ensureCss(h.doc);
  const hid = `${h.uid}-chal-h`;
  const kicker = el('p', { class: 'ao-chal__kicker', text: 'Испытание · 60 с' });
  const title = h.heading('h2', hid, 'Время вышло!', 'ao-chal__title');
  const rank = el('div', { class: 'ao-chal__rank', 'data-rank': 'D' }, el('span', { class: 'ao-chal__rankl', text: 'D' }));
  const rankL = rank.firstChild;
  const rankT = el('p', { class: 'ao-chal__ranktitle' });
  const score = el('strong', { class: 'ao-chal__score', text: '0' });
  const place = el('p', { class: 'ao-chal__place' });
  const parts = el('ul', { class: 'ao-chal__parts' });
  const next = el('p', { class: 'ao-chal__next' });
  // набранное, но не подтверждённое имя записывается и при уходе с экрана
  const again = btn('Ещё раз', () => { flushName(); invoke('onChallenge', { from: 'challenge' }); }, { variant: 'primary', size: 'xl' });
  again.node.classList.add('ao-chal__again');
  const save = btn('Сохранить картинку', () => invoke('onPosterSave', { from: 'challenge' }), { variant: 'secondary' });
  const exit = btn('В меню', () => { flushName(); invoke('onExit'); }, { variant: 'quiet' });
  const posterImg = el('img', { class: 'ao-chal__posterimg', alt: 'Постер победы: ранг, очки, лучший жест и скелет в момент последнего удара' });
  const poster = el('button', { type: 'button', class: 'ao-chal__poster', 'aria-label': 'Сохранить постер картинкой (PNG)', title: 'Сохранить картинку' }, posterImg);
  listen(poster, 'click', () => invoke('onPosterSave', { from: 'challenge' }));
  setHidden(poster, true);

  // имя из 3 букв: поле ввода (печать с клавиатуры) + крупные кнопки букв
  const nameIn = el('input', { class: 'ao-chal__namein', type: 'text', maxlength: '6', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Имя — три буквы', placeholder: '···' });
  let abc = 'ru';
  const grid = el('div', { class: 'ao-chal__keys', role: 'group', 'aria-label': 'Буквы' });
  function fillGrid() {
    grid.replaceChildren(...LETTERS[abc].map((ch) => {
      const k = el('button', { type: 'button', class: 'ao-chal__key', text: ch, 'aria-label': `Буква ${ch}`, 'data-ui-local': '' });   // меняет только поле имени
      listen(k, 'click', () => setName(nameIn.value + ch));
      return k;
    }));
  }
  const abcBtn = btn('ABC', () => { abc = abc === 'ru' ? 'en' : 'ru'; setText(abcBtn.labelNode, abc === 'ru' ? 'ABC' : 'АБВ'); fillGrid(); }, { variant: 'secondary' });
  const delBtn = btn('⌫', () => setName(nameIn.value.slice(0, -1)), { variant: 'secondary' });
  setAttr(delBtn.node, 'aria-label', 'Стереть букву');
  for (const b of [abcBtn, delBtn]) setAttr(b.node, 'data-ui-local', '');   // в игру ничего не передают
  const okBtn = btn('Готово', () => submitName(), { variant: 'primary', size: 'lg' });
  const nameBox = el('div', { class: 'ao-chal__name' },
    el('h3', { class: 'ao-chal__h' }, 'Впишите себя в зал славы', el('span', { class: 'ao-chal__namehint', text: '3 буквы — кнопками или с клавиатуры' })),
    el('div', { class: 'ao-chal__nameline' }, nameIn, el('div', { class: 'ao-chal__namebtns' }, abcBtn.node, delBtn.node, okBtn.node)),
    grid);
  const hallHead = el('h3', { class: 'ao-chal__h', text: 'Зал славы дня' });
  const hall = el('ol', { class: 'ao-hall', 'aria-label': 'Зал славы дня' });
  const hallEmpty = el('p', { class: 'ao-note', text: 'Сегодня здесь пока пусто.' });

  let cur = { id: null, named: true };
  let meName = null;   // имя в своей строке таблицы — меняется вместе с набором
  function setName(v) {
    const s = sanitizeName(v);
    if (nameIn.value !== s) nameIn.value = s;
    setBtn(okBtn, { disabled: !s });
    if (meName && cur.id && !cur.named) meName.textContent = s || '???';
  }
  function submitName() {
    const s = sanitizeName(nameIn.value);
    if (!s || !cur.id) return;
    invoke('onChallengeName', { id: cur.id, name: s });
    h.announce(`Записано: ${s}`);
  }
  function flushName() { if (cur.id && !cur.named && sanitizeName(nameIn.value)) submitName(); }
  listen(nameIn, 'input', () => setName(nameIn.value));
  listen(nameIn, 'keydown', (e) => {
    e.stopPropagation();   // буквы имени — не горячие клавиши игры (P, M, Tab)
    if (e.key === 'Enter') { e.preventDefault(); submitName(); }
  });
  fillGrid();
  setName('');

  const panel = el('div', { class: 'ao-panel ao-frame ao-chal' },
    el('div', { class: 'ao-chal__main' },
      kicker, title,
      el('div', { class: 'ao-chal__hero' }, rank, el('div', { class: 'ao-chal__scorebox' }, score, el('span', { class: 'ao-chal__pts', text: 'очков' }), rankT, place)),
      parts, next,
      el('div', { class: 'ao-chal__foot' },
        el('div', { class: 'ao-chal__actions' }, again.node, el('div', { class: 'ao-chal__sub' }, save.node, exit.node)),
        poster)),
    el('div', { class: 'ao-chal__side' }, nameBox, hallHead, hall, hallEmpty));

  let key = '', posterKey = '';
  function row(e, i, me) {
    return el('li', { class: `ao-hall__row${me ? ' is-me' : ''}`, 'data-place': String(i) },
      el('span', { class: 'ao-hall__place', text: String(i) }),
      el('span', { class: 'ao-hall__name', text: e.name || '???' }),
      el('span', { class: 'ao-hall__mode', text: MODE_MARK[e.mode] || '', title: e.mode === 'debug' ? 'клавиатура' : e.mode === 'master' ? 'режим «Мастер»' : '' }),
      el('span', { class: 'ao-hall__rank', 'data-rank': e.rank, text: e.rank }),
      el('span', { class: 'ao-hall__score', text: fmtScore(e.score) }),
      el('span', { class: 'ao-hall__acc', text: e.acc === null ? '' : `${e.acc}%` }));
  }
  return {
    section: h.screenSection('challenge', panel, hid),
    heading: title,
    focus: () => (cur.id && !cur.named ? nameIn : again.node),
    update(ctx) {
      const c = ctx.vm.challenge;
      const r = c && c.result;
      if (!r) return;
      const k = JSON.stringify([r.score, r.rank, r.place, r.total, r.entryId, r.named, r.name, c.hall && c.hall.map((e) => [e.id, e.name, e.score])]);
      if (k !== key) {
        key = k;
        setText(title, r.outcome === 'victory' && r.elapsed > 0 ? `Регент повержен за ${Math.max(1, Math.round(r.elapsed))} с!` : OUTCOME_TITLE[r.outcome] || 'Время вышло!');
        setText(rankL, r.rank);
        setAttr(rank, 'data-rank', r.rank);
        setText(rankT, `Ранг ${r.rank} · ${r.rankTitle}`);
        setText(score, fmtScore(r.score));
        setClass(place, 'is-record', !!r.isRecord);
        setText(place, r.place ? (r.isRecord ? (r.total > 1 ? `Новый рекорд дня! 1-е место из ${r.total}` : 'Первый рекорд дня!') : `${placeText(r.place)} из ${r.total} сегодня`) : '');
        parts.replaceChildren(...r.parts.map((p) => el('li', { class: 'ao-chal__part', 'data-part': p.id },
          el('span', { class: 'ao-chal__plabel', text: p.label }),
          el('span', { class: 'ao-chal__pdetail', text: p.detail || '' }),
          el('span', { class: 'ao-chal__ppts', text: `+${fmtScore(p.points)}` }))));
        setText(next, r.next ? `До ранга ${r.next.id} не хватило ${fmtScore(r.next.need)} очков — попробуйте ещё раз!` : 'Высший ранг. Легенда арены!');
        const fresh = cur.id !== r.entryId;
        cur = { id: r.entryId || null, named: !!r.named };
        setHidden(nameBox, !cur.id || cur.named);
        if (fresh && cur.id && !cur.named) { setName(''); }
        const list = Array.isArray(c.hall) ? c.hall : [];
        const rows = hallRows(list, r.entryId, !cur.named).map((x) => (x === 'gap'
          ? el('li', { class: 'ao-hall__gap', 'aria-hidden': 'true', text: '⋯' })
          : row(x.e, x.place, x.e.id === r.entryId)));
        hall.replaceChildren(...rows);
        meName = hall.querySelector('.ao-hall__row.is-me .ao-hall__name');
        if (meName && !cur.named && nameIn.value) meName.textContent = nameIn.value;
        setHidden(hallEmpty, rows.length > 0);
      }
      const pu = c.posterUrl || '';
      if (pu !== posterKey) { posterKey = pu; if (pu) posterImg.src = pu; setHidden(poster, !pu); }
    },
  };
}

// Кнопка меню «Испытание · 60 с» с рекордом дня. h — помощники modules/ui.js: { el, listen, invoke, setText, setHidden }.
export function createChallengeMenuButton(h) {
  const { el, listen, invoke } = h;
  const best = el('span', { class: 'ao-menu__chal-best' });
  const node = el('button', { type: 'button', class: 'ao-menu__chal', 'aria-describedby': null },
    el('span', { class: 'ao-menu__chal-main' }, el('span', { class: 'ao-menu__chal-badge', 'aria-hidden': 'true', text: '60' }), el('span', { text: 'Испытание · 60 с' })),
    best);
  listen(node, 'click', () => invoke('onChallenge', { from: 'menu' }));
  let key = null;
  return {
    node,
    update(ctx) {
      const b = ctx && ctx.vm && ctx.vm.challenge ? ctx.vm.challenge.best : null;
      const k = b ? `${b.score}|${b.name}` : '';
      if (k === key) return;
      key = k;
      if (b) best.replaceChildren('Рекорд дня: ', el('strong', { text: fmtScore(b.score) }), b.name ? ` · ${b.name}` : '');
      else best.replaceChildren('Кто наберёт больше очков?');
    },
  };
}
