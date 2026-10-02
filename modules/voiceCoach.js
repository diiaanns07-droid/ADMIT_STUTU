// ASHEN OATH — голос тренера на window.speechSynthesis: подсказки «ОШИБКА», счёт на тренировке и реплики
// диктора звучат вслух, чтобы твист кейса слышал весь зал, а не только тот, кто стоит у экрана.
// Фразы — core/voicePhrases.js. Модуль без DOM: синтезатор, класс фразы и часы передаются в createVoiceCoach,
// поэтому очередь, ограничители и выбор голоса проверяются в node (dev/voiceCoach.test.mjs) поддельным synth.
//
// Голос: локальный ru-RU (работает без интернета) → другой локальный ru → любой ru (сетевой) → тихо
// выключиться (status().state === 'no-ru', в настройках — «русского голоса в системе нет»). getVoices() до
// события voiceschanged бывает пустым: пока ждём (до voicesWaitMs) — состояние 'pending'. Голос, который не может
// говорить (сетевой без сети, голос недоступен) или сорвался badAfter раз подряд, откладывается на badMs и берётся
// следующий; разовая ошибка синтеза (переключили выход звука на проектор) голос не выключает.
//
// Очередь с приоритетами (PRIORITY): счёт < инфо < бой < «ОШИБКА» < финал. Правила:
//  - любая фраза — не чаще раза в minGapMs (2,5 с) от начала прошлой; исключения: счёт повторов (у него свой
//    поток, новая цифра заменяет старую) и врезка — более важная фраза прерывает менее важную;
//  - одна и та же фраза — не чаще раза в repeatGapMs (10 с);
//  - фраза ждёт своей очереди не дольше ttl (подсказка про ошибку через 3 с уже бесполезна).
// Громкость — общий ползунок игры, «Без звука» (M) глушит и голос. Пока звучит речь, onDuck(true) — main.js
// чуть приглушает SFX через публичный effects.setVolume.
//
// createVoiceDirector(coach) — что говорить в игре: подсказки input.hint (новые по code|tMs), события боя,
// здоровье Регента («Добей его!»), тренировка (счёт, ошибка повтора, итог подхода), «Распознано!» в обучении.

import { hintPhrase, trainPhrase, countWord, setSummary, ANNOUNCER, SIGIL_PHRASES, ULT_PHRASES } from '../core/voicePhrases.js';

export const PRIORITY = Object.freeze({ count: 1, info: 2, event: 3, error: 4, final: 5 });
const TTL = Object.freeze({ count: 900, info: 2500, event: 2500, error: 1400, final: 4000 });
const RATE = Object.freeze({ count: 1.15, info: 1.05, event: 1.05, error: 1.1, final: 0.95 });
// ошибки, после которых этот голос сейчас говорить не может (остальные — сбой одной фразы)
const VOICE_ERRORS = new Set(['network', 'synthesis-unavailable', 'language-unavailable', 'voice-unavailable']);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (fin(v) ? Math.min(1, Math.max(0, v)) : 0);
const norm = (s) => String(s).toLowerCase().replace(/[^0-9a-zа-яё]+/gi, ' ').trim();
const defaultClock = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// Русские голоса по убыванию пригодности: локальный ru-RU, локальный ru-*, сетевой ru-RU, сетевой ru-*.
export function rankRussianVoices(voices) {
  const list = Array.isArray(voices) ? voices : (voices && typeof voices.length === 'number' ? Array.from(voices) : []);
  const ru = list.filter((v) => v && typeof v.lang === 'string' && /^ru([-_]|$)/i.test(v.lang));
  const score = (v) => (v.localService !== false ? 4 : 0) + (/^ru[-_]ru$/i.test(v.lang) ? 2 : 0) + (v.default ? 1 : 0);
  return ru.map((v, i) => ({ v, i, s: score(v) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.v);
}

export function createVoiceCoach({
  synth = (typeof window !== 'undefined' ? window.speechSynthesis : null),
  Utterance = (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null),
  clock = defaultClock,
  activation = () => {
    // Chrome не даёт говорить до первого действия пользователя на странице (клик, клавиша)
    const ua = typeof navigator !== 'undefined' && navigator ? navigator.userActivation : null;
    return !ua || ua.hasBeenActive !== false;
  },
  minGapMs = 2500, repeatGapMs = 10000, cutInGapMs = 450, voicesWaitMs = 3000, badMs = 60000, badAfter = 3,
  volume = 0.7, enabled = true, muted = false,
  onDuck = null, onChange = null,
} = {}) {
  const api = !!(synth && typeof synth.speak === 'function' && typeof Utterance === 'function');
  const t0 = clock();
  let state = api ? 'pending' : 'no-api';
  let ranked = [], voice = null;
  const bad = new Map();          // голос → до какого времени отложен (не смог заговорить)
  const fails = new Map();        // голос → сбоев подряд
  const vid = (v) => v.voiceURI || v.name;
  let vol = clamp01(volume), on = enabled !== false, mute = muted === true;
  let queue = [];                 // { text, key, kind, priority, at, ttl }
  let cur = null;                 // { u, item, at }
  let lastAt = -Infinity, lastPrio = 0, endedAt = -Infinity, ducked = false, pollAt = -Infinity;
  const lastByText = new Map();
  const stats = { spoken: 0, dropped: 0, cut: 0, errors: 0 };
  const history = [];             // последние фразы — для отладки и тестов
  let disposed = false;

  function emit() { if (typeof onChange === 'function') { try { onChange(status()); } catch (e) { /* ignore */ } } }
  function duck(v) {
    if (ducked === v) return;
    ducked = v;
    if (typeof onDuck === 'function') { try { onDuck(v); } catch (e) { /* ignore */ } }
  }

  function resolveVoices(now) {
    if (!api || disposed) return;
    let list = [];
    try { list = synth.getVoices() || []; } catch (e) { list = []; }
    for (const [id, until] of bad) if (now >= until) bad.delete(id);   // отложенный голос пробуем снова
    ranked = rankRussianVoices(list).filter((v) => !bad.has(vid(v)));
    const prev = state, prevVoice = voice;
    if (ranked.length) { state = 'ready'; voice = ranked[0]; }
    else {
      voice = null;
      // список уже пришёл, а русских нет — сразу «нет»; пустой список ждём до voicesWaitMs
      state = list.length || now - t0 >= voicesWaitMs || bad.size ? 'no-ru' : 'pending';
    }
    if (state !== prev || voice !== prevVoice) { if (state !== 'ready') hush(); emit(); }
  }
  if (api) {
    const onVoices = () => { bad.clear(); fails.clear(); resolveVoices(clock()); };   // новый список — с чистого листа
    try {
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', onVoices);
      else synth.onvoiceschanged = onVoices;
    } catch (e) { /* ignore */ }
    resolveVoices(t0);
  }

  const audible = () => api && state === 'ready' && on && !mute && vol > 0.001 && !disposed;

  function hush() {
    queue = [];
    if (cur) {
      cur = null;
      try { synth.cancel(); } catch (e) { /* ignore */ }
      endedAt = clock();
      duck(false);
    }
  }

  // Фраза в очередь. Возвращает 'queued' | причину отказа: 'off', 'repeat', 'empty', 'busy'.
  function say(text, { kind = 'event', priority, ttl, key } = {}) {
    if (typeof text !== 'string' || !text.trim()) return 'empty';
    if (!audible()) return 'off';
    const now = clock();
    const k = key || norm(text);
    const p = fin(priority) ? priority : (PRIORITY[kind] || PRIORITY.event);
    if (kind !== 'count') {
      const was = lastByText.get(k);
      if (was !== undefined && now - was < repeatGapMs) { stats.dropped++; return 'repeat'; }
      if (cur && cur.item.key === k) return 'busy';
      if (queue.some((q) => q.key === k)) return 'busy';
    } else queue = queue.filter((q) => q.kind !== 'count');   // новая цифра заменяет старую
    queue.push({ text: text.trim(), key: k, kind, priority: p, at: now, ttl: fin(ttl) ? ttl : (TTL[kind] || 2000) });
    queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    if (queue.length > 5) { stats.dropped += queue.length - 5; queue.length = 5; }
    pump(now);
    return 'queued';
  }

  function canStart(item, now) {
    if (item.kind === 'count') return true;
    if (now - lastAt >= minGapMs) return true;
    return item.priority > lastPrio && now - lastAt >= cutInGapMs;   // врезка важного
  }

  function start(item, now) {
    let u;
    try { u = new Utterance(item.text); } catch (e) { stats.errors++; return false; }
    try {
      u.lang = (voice && voice.lang) || 'ru-RU';
      u.volume = vol;
      u.rate = RATE[item.kind] || 1.05;
      u.pitch = 1;
    } catch (e) { /* ignore */ }
    // голос — отдельно: Chrome бросает исключение на объект не того типа, громкость и темп от этого не теряются
    try { if (voice) u.voice = voice; } catch (e) { /* остаётся язык ru-RU — синтезатор подберёт голос сам */ }
    const c = { u, item, at: now };
    const done = (ev) => {
      if (cur !== c) return;
      cur = null; endedAt = clock();
      const err = ev && ev.error;
      const v = voice;
      if (!err) { if (v) fails.delete(vid(v)); return; }
      if (err === 'interrupted' || err === 'canceled') return;
      stats.errors++;
      if (err === 'not-allowed' || !v) return;   // нет действия пользователя — фраза пропала, голос исправен
      // голос не может говорить (сетевой без сети) или срывается раз за разом — откладываем, берём следующий
      const n = (fails.get(vid(v)) || 0) + 1;
      fails.set(vid(v), n);
      if (VOICE_ERRORS.has(err) || n >= badAfter) { bad.set(vid(v), clock() + badMs); fails.delete(vid(v)); resolveVoices(clock()); }
    };
    u.onend = () => done(null);
    u.onerror = (ev) => done(ev || { error: 'unknown' });
    cur = c;
    if (item.kind !== 'count') { lastAt = now; lastPrio = item.priority; lastByText.set(item.key, now); }
    stats.spoken++;
    history.push({ t: Math.round(now), text: item.text, kind: item.kind, priority: item.priority });
    if (history.length > 16) history.shift();
    duck(true);
    try { synth.speak(u); } catch (e) { cur = null; stats.errors++; return false; }
    return true;
  }

  function pump(now = clock()) {
    if (disposed) return;
    if ((state === 'pending' || (state === 'no-ru' && bad.size)) && now - pollAt >= 250) { pollAt = now; resolveVoices(now); }
    if (!audible()) { if (cur || queue.length) hush(); if (!cur) duck(false); return; }
    queue = queue.filter((q) => { const keep = now - q.at <= q.ttl; if (!keep) stats.dropped++; return keep; });
    // страховка: onend не пришёл (бывает в Chrome) — фраза давно должна была кончиться
    if (cur && now - cur.at > 2500 + cur.item.text.length * 110) { cur = null; endedAt = now; try { synth.cancel(); } catch (e) { /* ignore */ } }
    if (!queue.length) { if (!cur && now - endedAt > 250) duck(false); return; }
    if (!activation()) return;
    const i = queue.findIndex((q) => canStart(q, now) && (!cur || q.priority > cur.item.priority));
    if (i < 0) return;
    const item = queue[i];
    if (cur) {   // врезка: более важная фраза прерывает менее важную
      cur = null; stats.cut++;
      try { synth.cancel(); } catch (e) { /* ignore */ }
    }
    queue.splice(i, 1);
    start(item, now);
  }

  function status() {
    return {
      api, state, available: state === 'ready', enabled: on, muted: mute, volume: vol,
      voice: voice ? voice.name : null, lang: voice ? voice.lang : null, local: voice ? voice.localService !== false : null,
      speaking: !!cur, current: cur ? cur.item.text : null, queued: queue.length,
      ...stats, history: history.slice(),
    };
  }

  return {
    say, pump, status,
    // приоритеты для вызывающего кода
    error: (text, o) => say(text, { ...o, kind: 'error' }),
    event: (text, o) => say(text, { ...o, kind: 'event' }),
    info: (text, o) => say(text, { ...o, kind: 'info' }),
    count: (text, o) => say(text, { ...o, kind: 'count' }),
    final: (text, o) => say(text, { ...o, kind: 'final' }),
    setEnabled(v) { const n = v !== false; if (n === on) return; on = n; if (!on) hush(); emit(); },
    setMuted(v) { const n = v === true; if (n === mute) return; mute = n; if (mute) hush(); emit(); },
    setVolume(v) {
      vol = clamp01(+v);
      if (vol <= 0.001) hush();
      else if (cur) { try { cur.u.volume = vol; } catch (e) { /* ignore */ } }
    },
    stop() { hush(); },
    // сбросить ожидающие фразы этого вида (подсказки боя после ухода на паузу уже не нужны)
    drop(kind) { const n = queue.length; queue = queue.filter((q) => q.kind !== kind); stats.dropped += n - queue.length; },
    get available() { return state === 'ready'; },
    get state() { return state; },
    dispose() { hush(); disposed = true; },
  };
}

// ───────── рекорды (localStorage) ─────────
// Лучшая победа (время боя и точность жестов) и лучший подход на тренировке. «Новый рекорд!» звучит, только
// когда есть с чем сравнить: первый бой и первый подход — не рекорд, а точка отсчёта.
export const VOICE_RECORDS_KEY = 'ashen-oath.voice.v1';
export function createVoiceRecords(storage, key = VOICE_RECORDS_KEY) {
  let data = null;
  function load() {
    if (data) return data;
    data = { win: null, acc: null, reps: {} };
    try {
      const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        if (fin(o.win) && o.win > 0) data.win = o.win;
        if (fin(o.acc)) data.acc = o.acc;
        if (o.reps && typeof o.reps === 'object') for (const [k, v] of Object.entries(o.reps)) if (fin(v) && v > 0) data.reps[k] = v;
      }
    } catch (e) { /* хранилище недоступно или испорчено — начинаем с нуля */ }
    return data;
  }
  function save() { try { if (storage && typeof storage.setItem === 'function') storage.setItem(key, JSON.stringify(data)); } catch (e) { /* ignore */ } }
  return {
    // победа за timeSec с точностью accuracy (%, может быть null) → true, если это рекорд
    win(timeSec, accuracy) {
      const d = load();
      const hadWin = d.win !== null;
      const faster = fin(timeSec) && timeSec > 0 && hadWin && timeSec < d.win - 0.5;
      const sharper = fin(accuracy) && d.acc !== null && hadWin && accuracy > d.acc;
      if (fin(timeSec) && timeSec > 0 && (!hadWin || timeSec < d.win)) d.win = timeSec;
      if (fin(accuracy) && (d.acc === null || accuracy > d.acc)) d.acc = accuracy;
      save();
      return faster || sharper;
    },
    best(exercise) { return load().reps[exercise] || 0; },
    reps(exercise, n) {
      const d = load();
      if (fin(n) && n > (d.reps[exercise] || 0)) { d.reps[exercise] = Math.floor(n); save(); }
    },
    get data() { return { ...load(), reps: { ...load().reps } }; },
  };
}

// ───────── режиссёр: что и когда говорить в игре ─────────
// frame(now, view) раз в кадр. view:
//   screen — app.screen; hint — подсказка «ОШИБКА» { code, tMs, group?, fix? } (новая — по code|tMs) или null;
//   events — события боя этого кадра; boss — { hp, maxHp } или null; pvp — идёт ли онлайн-дуэль;
//   fight — { time, accuracy } боя (для рекорда победы); countdown — 3, 2, 1 во время отсчёта, иначе 0;
//   training — { exercise, reps, attempts, hint: { code, tMs } } на экране тренировки;
//   recognized — ключ шага обучения, жест которого только что распознан.
const HINT_SCREENS = new Set(['tutorial', 'playing']);
const SET_IDLE_MS = 7000;      // пауза без повторов — подход окончен, звучит итог
const RECORD_MIN_REPS = 3;     // рекорд подхода — только если прежний лучший был не меньше
const COUNTDOWN = Object.freeze({ 3: 'Три', 2: 'Два', 1: 'Один' });

export function createVoiceDirector(coach, { records = null } = {}) {
  const S = {
    hint: '', screen: '', finish: false, enraged: false, outcome: false, countdown: 0,
    trainKey: '', reps: 0, attempts: 0, set: null, trainHint: null, best: 0, recordSaid: false,
    recognized: new Set(),
  };

  function resetFight() { S.finish = false; S.enraged = false; S.outcome = false; }
  function newSet(ex) { S.set = { exercise: ex, good: 0, total: 0, lastAt: -Infinity }; }
  function closeSet() {
    const s = S.set;
    if (s && s.total >= 2) coach.info(setSummary(s.good, s.total), { ttl: 6000 });   // итог не к спеху: дождётся очереди
    S.set = null;
  }

  function onEvent(e, view) {
    const type = e && e.type, d = (e && e.data) || {};
    switch (type) {
      case 'sigil_cast': if (SIGIL_PHRASES[d.sigil]) coach.event(SIGIL_PHRASES[d.sigil]); break;
      // защита Регента пробита: оглушение «Хлопком» или руной, слом барьера (если модуль боя его выпустит)
      case 'boss_stunned': case 'boss_ward_break': case 'barrier_break': case 'boss_barrier_break': coach.event(ANNOUNCER.barrier); break;
      case 'shield_break': if (d.target === 'boss' || d.owner === 'boss') coach.event(ANNOUNCER.barrier); break;
      case 'boss_phase':
        if (d.awaken) break;   // «пробуждение» в облёте — не ярость
        if (!S.enraged && (d.stage >= 2 || d.phase >= 2 || d.enraged)) { S.enraged = true; coach.event(ANNOUNCER.enraged); }
        break;
      case 'boss_enrage': case 'boss_enraged': if (!S.enraged) { S.enraged = true; coach.event(ANNOUNCER.enraged); } break;
      // ультимейт: подсказка «как вызвать» и сам удар (имена событий — от модуля ультимейта)
      case 'ult_ready': case 'ultimate_ready': case 'sky_judgement_ready': coach.event(ULT_PHRASES.ready); break;
      case 'ult_cast': case 'ultimate_cast': case 'ultimate': case 'sky_judgement': coach.final(ULT_PHRASES.cast); break;
      case 'victory':
        if (S.outcome || view.pvp) break;
        S.outcome = true;
        coach.final(ANNOUNCER.victory);
        if (records) {
          const f = view.fight || {};
          let rec = false;
          try { rec = records.win(f.time, f.accuracy); } catch (err) { rec = false; }
          if (rec) coach.final(ANNOUNCER.record, { ttl: 7000 });
        }
        break;
      case 'defeat': if (!S.outcome && !view.pvp) { S.outcome = true; coach.final(ANNOUNCER.defeat); } break;
      case 'pvp_round':
        if (d.phase === 'fight') coach.final(ANNOUNCER.fight, { ttl: 1500 });
        else if (d.phase === 'round_end' && (d.winner === 'me' || d.winner === 'opponent')) coach.event(d.winner === 'me' ? ANNOUNCER.roundWin : ANNOUNCER.roundLose);
        else if (d.phase === 'match_end' && (d.winner === 'me' || d.winner === 'opponent')) coach.final(d.winner === 'me' ? ANNOUNCER.victory : ANNOUNCER.matchLose);
        break;
      default: break;
    }
  }

  // отсчёт «Три… Два… Один» — по тикам (раунд дуэли, автопродолжение после потери трекинга)
  function countdown(n) {
    n = fin(n) ? Math.max(0, Math.min(3, Math.ceil(n))) : 0;
    if (n === S.countdown) return;
    const prev = S.countdown;
    S.countdown = n;
    if (n > 0 && n < (prev || 4)) coach.say(COUNTDOWN[n], { kind: 'count', priority: PRIORITY.final, ttl: 700 });
  }

  function training(view, now) {
    const T = view.training;
    if (!T) { if (S.set) closeSet(); S.trainKey = ''; return; }
    const ex = T.exercise === 'squats' ? 'squats' : 'pushups';
    const reps = fin(T.reps) ? Math.floor(T.reps) : 0, attempts = fin(T.attempts) ? T.attempts : null;
    if (S.trainKey !== ex || reps < S.reps) {   // новый экран тренировки, смена упражнения или сброс счёта
      if (S.set) closeSet();
      S.trainKey = ex; S.reps = reps; S.attempts = attempts !== null ? attempts : 0; S.trainHint = T.hint || null;
      S.best = records ? records.best(ex) : 0; S.recordSaid = false;
      newSet(ex);
      return;
    }
    if (!S.set) newSet(ex);
    // попытки: чистые повторы + отклонённые; без счётчика попыток — по повторам и подсказкам
    if (reps > S.reps) {
      const add = reps - S.reps;
      S.set.good += add; S.set.lastAt = now;
      if (attempts === null) S.set.total += add;
      if (records && !S.recordSaid && S.best >= RECORD_MIN_REPS && reps > S.best) { S.recordSaid = true; coach.final(ANNOUNCER.record); }
      else coach.count(countWord(reps));   // «раз… два… три» — то же число, что на экране
      if (records) records.reps(ex, reps);
    }
    S.reps = reps;
    if (attempts !== null) {
      if (attempts > S.attempts) { S.set.total += attempts - S.attempts; S.set.lastAt = now; }
      S.attempts = attempts;
    }
    const h = T.hint && T.hint.code ? T.hint : null;
    if (h && (!S.trainHint || h.code !== S.trainHint.code || h.tMs !== S.trainHint.tMs)) {
      if (attempts === null && h.code !== 'frame') S.set.total += 1;
      S.set.lastAt = now;
      coach.error(trainPhrase(ex, h.code));
    }
    S.trainHint = h;
    if (S.set.good > S.set.total) S.set.total = S.set.good;
    if (S.set.total > 0 && now - S.set.lastAt >= SET_IDLE_MS) { closeSet(); newSet(ex); }
  }

  return {
    frame(now, view) {
      view = view || {};
      const screen = view.screen || '';
      if (screen !== S.screen) {
        if (screen === 'playing' && S.screen !== 'paused') resetFight();
        if (screen === 'tutorial') S.recognized.clear();
        if (!HINT_SCREENS.has(screen) && typeof coach.drop === 'function') coach.drop('error');
        S.screen = screen;
      }
      // «ОШИБКА»: новая подсказка распознавателя (тот же импульс — та же метка tMs)
      const h = view.hint;
      if (h && h.code && HINT_SCREENS.has(screen)) {
        const key = `${h.code}|${h.tMs}`;
        if (key !== S.hint) { S.hint = key; coach.error(hintPhrase(h)); }
      }
      if (view.recognized && screen === 'tutorial' && !S.recognized.has(view.recognized)) {
        S.recognized.add(view.recognized);
        coach.info(ANNOUNCER.recognized, { ttl: 1500, key: `recognized|${view.recognized}` });   // на каждый шаг, не «раз в 10 с»
      }
      if (Array.isArray(view.events)) for (const e of view.events) onEvent(e, view);
      // «Добей его!» — у Регента меньше 20 % здоровья (один раз за бой)
      const b = view.boss;
      if (screen === 'playing' && !view.pvp && b && fin(b.hp) && fin(b.maxHp) && b.maxHp > 0) {
        if (!S.finish && b.hp > 0 && b.hp / b.maxHp <= 0.2) { S.finish = true; coach.event(ANNOUNCER.finish); }
        if (b.hp / b.maxHp > 0.5) S.finish = false;
      }
      countdown(view.countdown);
      if (screen === 'training') training(view, now);
      else if (S.trainKey) training({ training: null }, now);
      coach.pump(now);
    },
    // реплика диктора по ключу ANNOUNCER (например, 'voiceOn' — подтверждение включения голоса)
    announce(key, kind = 'info') { return ANNOUNCER[key] ? coach.say(ANNOUNCER[key], { kind }) : 'empty'; },
    reset() { S.hint = ''; resetFight(); S.set = null; S.trainKey = ''; S.countdown = 0; },
  };
}
