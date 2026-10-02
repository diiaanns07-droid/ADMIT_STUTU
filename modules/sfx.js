// ASHEN OATH — звук на сэмплах: таблица звуков, банк буферов, «режиссёр» событий боя, шаги.
// Сэмплы собственные, их запекает tools/sfx_bake.mjs в assets/sfx/*.ogg (≈0.8 МБ).
// Воспроизведение, микс и лимиты голосов — createAudioEngine в modules/effects.js; этот модуль без DOM
// и без Web Audio в верхнем уровне, поэтому таблицы и режиссёр проверяются в node (dev/sfx.test.mjs).

export const SFX_DIR = 'assets/sfx/';

// v — вариантов файла (name_1 … name_v, при v=1 — name.ogg); gain — громкость (до поправки на расстояние),
// подобрана по громкости в полосе динамиков ноутбука (выше 250 Гц, самые громкие 400 мс): выброс — громче всех,
// частые звуки (выстрел, искра, попадания, шаги) — тише;
// cat — категория лимита голосов; lim — сколько голосов категории одновременно; pitch — случайный разброс
// высоты, ± полутоны; vol — разброс громкости, ± дБ; rev — посыл в ревербацию; gap — не чаще раза в gap с;
// ui — интерфейсный звук: без панорамы и расстояния; loop — петля (щит, эмбиент), len — её точная длина, с:
// в файле после неё ещё 0,1 с (декодер Vorbis в Chromium дописывает паддинг — по loopEnd он не слышен).
export const SFX = {
  step:        { v: 4, gain: 0.43, cat: 'step', lim: 2, pitch: 1.5, vol: 2, rev: 0.02, gap: 0.12 },
  dash:        { v: 2, gain: 0.47, cat: 'dash', lim: 2, pitch: 1, vol: 1, rev: 0.1 },
  slash:       { v: 3, gain: 0.54, cat: 'slash', lim: 2, pitch: 1, vol: 1, rev: 0.1 },
  shot:        { v: 3, gain: 0.61, cat: 'shot', lim: 3, pitch: 0.8, vol: 1.5, rev: 0.1, gap: 0.04 },
  spark:       { v: 3, gain: 0.79, cat: 'spark', lim: 3, pitch: 1.5, vol: 1.5, rev: 0.06, gap: 0.03 },
  burst:       { v: 1, gain: 0.93, cat: 'burst', lim: 1, pitch: 0.4, rev: 0.25 },
  shield_up:   { v: 1, gain: 0.34, cat: 'shield', lim: 1, pitch: 0.3, rev: 0.2 },
  shield_down: { v: 1, gain: 0.25, cat: 'shield', lim: 1, pitch: 0.3, rev: 0.12 },
  shield_loop: { v: 1, gain: 0.07, cat: 'shieldHum', lim: 1, loop: true, len: 4.0, rev: 0.1 },
  block:       { v: 2, gain: 0.74, cat: 'block', lim: 2, pitch: 0.8, vol: 1, rev: 0.15 },
  parry:       { v: 2, gain: 0.67, cat: 'block', lim: 2, pitch: 0.6, vol: 1, rev: 0.2, gap: 0.08 },
  perfect:     { v: 1, gain: 0.38, cat: 'cue', lim: 1, pitch: 0.3, rev: 0.25 },
  boss_hit:    { v: 3, gain: 0.46, cat: 'hit', lim: 3, pitch: 1.2, vol: 1.5, rev: 0.12, gap: 0.05 },
  player_hit:  { v: 2, gain: 0.48, cat: 'hurt', lim: 2, pitch: 0.8, vol: 1, rev: 0.1 },
  rune_fire:   { v: 1, gain: 0.54, cat: 'rune', lim: 2, pitch: 0.3, rev: 0.25 },
  rune_storm:  { v: 1, gain: 0.93, cat: 'rune', lim: 2, pitch: 0.3, rev: 0.25 },
  rune_light:  { v: 1, gain: 0.3, cat: 'rune', lim: 2, pitch: 0.2, rev: 0.3 },
  rune_star:   { v: 1, gain: 0.34, cat: 'rune', lim: 2, pitch: 0.3, rev: 0.3 },
  rune_wind:   { v: 1, gain: 0.32, cat: 'rune', lim: 2, pitch: 0.3, rev: 0.25 },
  rune_shadow: { v: 1, gain: 0.57, cat: 'rune', lim: 2, pitch: 0.3, rev: 0.25 },
  ui_ok:       { v: 1, gain: 0.23, cat: 'ui', lim: 2, ui: true, gap: 0.12 },
  ui_error:    { v: 1, gain: 0.6, cat: 'ui', lim: 2, ui: true, gap: 0.25 },
  victory:     { v: 1, gain: 0.56, cat: 'outcome', lim: 1, ui: true },
  defeat:      { v: 1, gain: 0.46, cat: 'outcome', lim: 1, ui: true },
  ambient:     { v: 1, gain: 0.5, loop: true, len: 24.0 },
  // Регент: замах — нарастание с «моментом удара» на hit секунд (стартует со сдвигом под длительность замаха)
  windup_slam: { v: 1, gain: 0.38, cat: 'windup', lim: 2, pitch: 0.4, rev: 0.15, hit: 2.0 },
  windup_orb:  { v: 1, gain: 0.5, cat: 'windup', lim: 2, pitch: 0.4, rev: 0.15, hit: 2.0 },
  windup_nova: { v: 1, gain: 0.49, cat: 'windup', lim: 2, pitch: 0.3, rev: 0.2, hit: 2.0 },
  boss_slam:   { v: 2, gain: 0.9, cat: 'heavy', lim: 2, pitch: 0.8, vol: 1, rev: 0.25 },
  boss_nova:   { v: 1, gain: 0.79, cat: 'heavy', lim: 2, pitch: 0.5, rev: 0.25 },
  orb_launch:  { v: 2, gain: 0.43, cat: 'launch', lim: 2, pitch: 1, vol: 1, rev: 0.15 },
  orb_hit:     { v: 2, gain: 0.64, cat: 'impact', lim: 3, pitch: 1, vol: 1, rev: 0.15, gap: 0.05 },
  boss_phase:  { v: 1, gain: 1.05, cat: 'phase', lim: 1, pitch: 0.2, rev: 0.3 },
};

// Прежние имена звуков (вызовы из effects.js по снимку) → сэмплы. Чего здесь нет — синтез старого движка.
export const SFX_ALIAS = {
  shieldUp: 'shield_up', shieldDown: 'shield_down', shieldHum: 'shield_loop',
  cast: 'shot', boltImpact: 'spark', block: 'block', bossHit: 'boss_hit', playerHit: 'player_hit',
  dash: 'dash', burst: 'burst', victory: 'victory', defeat: 'defeat',
  slam: 'boss_slam', nova: 'boss_nova', orbLaunch: 'orb_launch', orbImpact: 'orb_hit', phase: 'boss_phase',
};
// Замах Регента по виду атаки (синтез 'windup' — запасной)
export const WINDUP_SFX = { slam: 'windup_slam', orb: 'windup_orb', nova: 'windup_nova' };
// Синтез на случай, если сэмпл не загрузился (старый браузер без Ogg Vorbis, файл недоступен).
export const SFX_SYNTH_FALLBACK = {
  shot: 'cast', spark: 'boltImpact', slash: 'cast', burst: 'burst', shield_up: 'shieldUp', shield_down: 'shieldDown',
  block: 'block', parry: 'block', perfect: 'conjureReady', boss_hit: 'bossHit', player_hit: 'playerHit', dash: 'dash',
  rune_fire: 'burst', rune_storm: 'nova', rune_light: 'conjureReady', rune_star: 'conjureReady', rune_wind: 'orbLaunch',
  rune_shadow: 'nova', ui_ok: 'conjureReady', ui_error: 'fizzle', victory: 'victory', defeat: 'defeat',
  windup_slam: 'windup', windup_orb: 'windup', windup_nova: 'windup', boss_slam: 'slam', boss_nova: 'nova',
  orb_launch: 'orbLaunch', orb_hit: 'orbImpact', boss_phase: 'phase',
};

// Список файлов банка: [{ name, url }]
export function sfxFiles(dir = SFX_DIR) {
  const out = [];
  for (const [name, s] of Object.entries(SFX)) {
    const n = Math.max(1, s.v | 0);
    for (let i = 1; i <= n; i++) out.push({ name, url: `${dir}${n > 1 ? `${name}_${i}` : name}.ogg` });
  }
  return out;
}

// ---------------------------------------------------------------- режиссёр событий боя
// Стихии рун и печатей → аккорды (assets/sfx/rune_*.ogg).
export const RUNE_SFX = {
  ignis: 'rune_fire', fulgur: 'rune_storm', orbis: 'rune_light', lemnis: 'rune_light', stella: 'rune_star',
  alpha: 'rune_star', caret: 'rune_star', spira: 'rune_wind', clepsydra: 'rune_wind', vee: 'rune_shadow',
};
export const SIGIL_SFX = { clap: 'rune_storm', gate: 'shield_up', frame: 'rune_star', delta: 'rune_fire', cor: 'rune_light' };

const n01 = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d);

// Какие звуки дать событию боя: [[имя, параметр?], ...] или null.
// Одно действие — один звук. Где бой шлёт несколько событий на одно действие, звучит одно:
//  - рассечение: player_cast{slash} + player_slash → только player_slash;
//  - стрела и сгусток: player_cast{arrow|hand_orb} + bow_release / hand_spell_throw → только вторые;
//  - попадание по Регенту всегда приходит отдельным boss_hit → у projectile_impact{result:'boss'} и arrow_hit
//    своего удара нет; орб в щит/оберег/по герою — звучат block / player_hit, а не projectile_impact;
//  - оберег: block{ward} + ward_end{absorbed} → только block. Горение (boss_hit{dot}) не звучит вовсе.
const SILENT_IMPACT = new Set(['boss', 'block', 'ward', 'bastion', 'hit', 'player']);
export function sfxForEvent(type, d) {
  d = d && typeof d === 'object' ? d : {};
  switch (type) {
    case 'player_cast':
      if (d.ability === 'bolt') return [['shot']];
      if (d.ability === 'spark') return [['spark', { rate: 1.12 }]];
      if (d.ability === 'throw') return [['throw', { size: n01(d.size, 0.5), power: n01(d.power, 0.5), prism: d.kind === 'prism' }]];
      return null; // slash, burst, dash, rune, sigil, shield, arrow, hand_orb — у каждого своё событие
    case 'player_slash': return [['slash', { gain: 0.85 + 0.3 * n01(d.power, 0.6) }]];
    case 'burst': {
      // «бабах» по заряду: громче и ниже при полном заряде
      const p = n01(d.power, 0.6);
      return [['burst', { gain: 0.6 + 0.4 * p, rate: 1.08 - 0.16 * p }]];
    }
    case 'projectile_impact':
      if (SILENT_IMPACT.has(d.result)) return null;
      if (d.owner === 'boss') return d.result === 'dispelled' ? [['spark', { gain: 0.45, rate: 0.8 }]] : [['orbImpact']];
      if (d.kind === 'sphere' || d.kind === 'prism') return [[d.kind === 'prism' ? 'prismImpact' : 'sphereImpact', n01(d.size, 0.5)]];
      if (d.kind === 'arrow' || d.kind === 'hand_orb') return d.result === 'floor' ? [['spark', { gain: 0.4, rate: 0.75 }]] : null;
      return [['spark', { gain: 0.5, rate: d.kind === 'spark' ? 1.25 : 0.82 }]]; // в пол, в стену, рассечён
    case 'boss_hit': {
      if (d.dot === true || d.source === 'burn') return null;
      const a = typeof d.amount === 'number' && Number.isFinite(d.amount) ? d.amount : 15;
      const g = Math.min(1.3, 0.65 + a / 60);
      if (d.target === 'opponent') return [['player_hit', { gain: 0.8 * g }]]; // дуэль: по живому сопернику — не камень
      if (d.source === 'chain') return [['spark', { gain: 0.6 }]];
      return [['boss_hit', { gain: g }]];
    }
    case 'player_hit': return [['player_hit']];
    case 'block': return [['block']];
    case 'shield_end': return d.reason === 'depleted' ? [['block', { rate: 0.75, gain: 0.7 }]] : null; // щит сломан
    case 'shield_break': return [['block', { rate: 0.8 }]];
    case 'parry': return d.success ? [['parry']] : null;
    case 'player_dash': return [['dash']];
    case 'perfect_dodge': return [['perfect']];
    case 'rune_cast': return [[RUNE_SFX[d.rune] || 'rune_star']];
    case 'sigil_cast': return [[SIGIL_SFX[d.sigil] || 'rune_star']];
    case 'ember_lit': return [['rune_fire', { gain: 0.8 }]]; // «бабах» выброса — только у выброса
    case 'bow_release': return d.rain ? [['rune_star', { gain: 0.8 }]] : [['shot', { rate: d.charged ? 1.15 : 1.35, gain: d.charged ? 0.85 : 0.65 }]];
    case 'hand_spell_form': return [['conjureStart']];
    case 'hand_spell_cancel': return [['fizzle']];
    case 'hand_spell_throw': return [['throw', { size: d.twoHand ? 0.8 : 0.45, power: n01(d.power, 0.5), prism: false }]];
    case 'hand_spell_hit': return [['orb_hit', { gain: 0.6 + 0.4 * n01(d.power, 0.5), rate: 1.15 }]]; // удар даёт boss_hit, это — хлопок сгустка
    case 'boss_windup': return [['windup', { kind: d.attackKind || d.kind || 'slam', dur: typeof d.windup === 'number' ? d.windup : d.duration }]];
    case 'boss_impact': {
      const k = d.attackKind || d.kind || 'slam';
      if (k === 'nova') return [['nova']];
      if (k === 'orb') return [['orbLaunch']];
      return [['slam']];
    }
    case 'boss_phase': return [['phase']];
    case 'victory': return [['victory']];
    case 'defeat': return [['defeat']];
    case 'pvp_round': // в дуэли нет victory/defeat; ничья (winner null) — без фанфар
      if (d.phase !== 'match_end' || (d.winner !== 'me' && d.winner !== 'opponent')) return null;
      return [[d.winner === 'me' ? 'victory' : 'defeat']];
    default: return null;
  }
}

// ---------------------------------------------------------------- шаги
// Каденс по скорости героя: шаг ≈ 1.8 шага/с, бег ≈ 2.9; первый шаг — сразу после старта.
export function createStepper() {
  let phase = 0.7;
  return {
    reset() { phase = 0.7; },
    // Возвращает громкость шага 0..1 (0 — в этом кадре шага нет).
    tick(dt, speed, onGround) {
      if (!(dt > 0) || !onGround || !(speed > 0.7)) { phase = 0.7; return 0; }
      const rate = Math.min(3.1, Math.max(1.6, 1.25 + speed * 0.28));
      phase += Math.min(dt, 0.1) * rate;
      if (phase < 1) return 0;
      phase -= Math.floor(phase);
      return Math.min(1, Math.max(0.4, 0.3 + speed / 9));
    },
  };
}

// ---------------------------------------------------------------- интерфейсные подсказки
// «✓ Распознано» в обучении — один «дзинь» на карточку за заход; «ОШИБКА» — мягкий «тук» на новую подсказку
// тренера (импульс input.hint с кодом и временем), не чаще раза в errorGapMs, чтобы не раздражать.
export function createCueTracker({ errorGapMs = 1500 } = {}) {
  const seen = new Set();
  let lastHint = null, lastErrorAt = -Infinity;
  return {
    reset() { seen.clear(); },
    chip(key) {
      if (!key || seen.has(key)) return null;
      seen.add(key);
      return 'ui_ok';
    },
    hint(h, nowMs) {
      if (!h || typeof h !== 'object' || typeof h.text !== 'string' || !h.code) return null;
      const key = `${h.code}|${h.tMs}`;
      if (key === lastHint) return null;
      lastHint = key;
      if (nowMs - lastErrorAt < errorGapMs) return null;
      lastErrorAt = nowMs;
      return 'ui_error';
    },
  };
}

// ---------------------------------------------------------------- банк буферов
// Загружает файлы один раз после создания AudioContext; get(name) — случайный вариант без повтора подряд.
export function createSampleBank(ctx, { dir = SFX_DIR, fetchFn, onError } = {}) {
  const buffers = new Map(); // name → AudioBuffer[]
  const last = new Map();
  let loading = null, failed = 0, loaded = 0;
  const f = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  function decode(ab) {
    // старый Safari знает только колбэк-форму decodeAudioData
    return new Promise((res, rej) => {
      try { const p = ctx.decodeAudioData(ab, res, rej); if (p && typeof p.then === 'function') p.then(res, rej); } catch (e) { rej(e); }
    });
  }
  function load() {
    if (loading) return loading;
    if (!f) return (loading = Promise.resolve(false));
    const files = sfxFiles(dir);
    loading = Promise.all(files.map(({ name, url }) => f(url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(decode)
      .then((b) => { if (!buffers.has(name)) buffers.set(name, []); buffers.get(name).push(b); loaded++; })
      .catch((e) => { failed++; if (onError) onError(url, e); })))
      .then(() => loaded > 0);
    return loading;
  }
  function get(name) {
    const list = buffers.get(name);
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    let i = Math.floor(Math.random() * list.length);
    if (i === last.get(name)) i = (i + 1) % list.length;
    last.set(name, i);
    return list[i];
  }
  return {
    load, get,
    has: (name) => buffers.has(name),
    stats: () => ({ loaded, failed, names: buffers.size }),
  };
}
