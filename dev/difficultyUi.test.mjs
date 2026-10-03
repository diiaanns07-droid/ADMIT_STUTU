// [W5-СЛОЖНОСТЬ] Сложность вне боя: «!» по cue атаки и подписи приёмов в HUD (core/battleHud.js), очки с множителем
// сложности и зал славы (modules/challenge.js), совет следующей сложности и рекорд по уровню (голос), постер.
// node dev/difficultyUi.test.mjs
import { createBattleHud } from '../core/battleHud.js';
import { buildResult, scoreChallenge, createTally, createHall, CHALLENGE } from '../modules/challenge.js';
import { DIFFICULTY_ORDER, DIFFICULTY_NAMES, NEXT_DIFFICULTY_PHRASES, nextDifficulty, prevDifficulty, nextDifficultyText } from '../core/voicePhrases.js';
import { createVoiceCoach, createVoiceDirector, createVoiceRecords } from '../modules/voiceCoach.js';
import { drawPoster } from '../modules/posterCard.js';
import { DIFFICULTY_LEVELS } from '../modules/combat.js';
import { config as gameConfig } from '../config.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

// ---- фальшивый 2D-контекст (как в dev/battleHudFeel.test.mjs): что нарисовано текстом
function fakeCanvas() {
  const texts = [];
  const state = { font: '10px sans-serif', shadowBlur: 0, globalAlpha: 1, lineDash: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'fillText' || k === 'strokeText') return (s) => { texts.push(String(s)); };
      if (k === 'measureText') return (s) => { const m = /(\d+(?:\.\d+)?)px/.exec(t.font); const px = m ? +m[1] : 10; return { width: String(s).length * px * 0.55 }; };
      if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => grad;
      if (k === 'setLineDash') return (a) => { t.lineDash = a; };
      if (k === 'getLineDash') return () => t.lineDash;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { canvas: { width: 0, height: 0, clientWidth: 1366, clientHeight: 768, getContext: () => ctx }, ctx, texts };
}
function project(p) {
  const cz = 11 - p.z, cy = p.y - 3;
  if (cz < 0.1) return { x: 0, y: 0, behind: true };
  const f = 1 / Math.tan((58 * Math.PI / 180) / 2);
  return { x: 683 + (p.x / cz) * f * 384, y: 384 - (cy / cz) * f * 384, behind: false };
}
function snap(telegraphs) {
  return {
    status: 'playing', time: 30, difficulty: 'hard',
    player: { position: { x: 0.5, y: 0, z: 6 }, yaw: Math.PI, hp: 80, maxHp: 100, energy: 60, maxEnergy: 100, action: 'idle', combo: 0, comboMultiplier: 1, comboTimer: 0, encounter: 'engaged' },
    boss: { position: { x: 0, y: 0, z: 0 }, hp: 5000, maxHp: 12000, action: 'windup', stage: 1 },
    telegraphs, projectiles: [], cooldowns: {}, stats: {},
  };
}
function drawn(s, frames = 2) {
  const fc = fakeCanvas();
  const hud = createBattleHud({ canvas: fc.canvas });
  for (let i = 0; i < frames; i++) hud.frame({ dtReal: 1 / 60, timeScale: 1, screen: 'playing', snapshot: s, events: [], input: null, project, viewport: { w: 1366, h: 768 }, intro: { active: false, t: 0, duration: 5 }, settings: {}, resumeLeftMs: 0, pois: [], coach: null, layout: null });
  return fc.texts;
}
const has = (texts, re) => texts.some((t) => re.test(t));
const slam = (id, remaining, target, extra = {}) => ({ id, kind: 'slam', origin: { x: 0, y: 0, z: 0 }, target, center: target, radius: 2, remaining, duration: 1.1, blockable: false, damage: 6, ...extra });

test('HUD: «!» — по cue атаки (короче замах — позже «!»), без cue — как раньше (0,9 с)', () => {
  const at = { x: 0.5, y: 0, z: 6 };
  assert(!has(drawn(snap([slam('a', 0.65, at, { cue: 0.58 })])), /^!$/), 'cue 0,58: за 0,65 с «!» ещё нет');
  assert(has(drawn(snap([slam('a', 0.5, at, { cue: 0.58 })])), /^!$/), 'cue 0,58: за 0,5 с «!» есть');
  assert(has(drawn(snap([slam('a', 0.8, at)])), /^!$/), 'без cue: за 0,8 с «!» есть (0,9 с)');
});

test('HUD: подписи приёмов — «ДВОЙНОЙ УДАР», «ЗАЛП СФЕР», «КАМЕННЫЙ КАПКАН»', () => {
  const at = { x: 0.5, y: 0, z: 6 };
  assert(has(drawn(snap([slam('d', 0.6, at, { move: 'double' })])), /ДВОЙНОЙ УДАР/), 'двойной');
  const orb = { id: 'v', kind: 'orb', move: 'volley', origin: { x: 0, y: 1.2, z: 1.4 }, target: { x: 0.5, y: 1, z: 6 }, center: { x: 0, y: 1.2, z: 1.4 }, pathEnd: { x: 0.6, y: 1, z: 11 }, radius: 0.55, remaining: 0.5, duration: 0.85, blockable: true, damage: 4 };
  const t = drawn(snap([orb]));
  assert(has(t, /ЗАЛП СФЕР/) && has(t, /ЩИТ/), 'залп: название и щит');
  assert(has(drawn(snap([slam('t1', 0.6, at, { move: 'trap' })])), /КАМЕННЫЙ КАПКАН/), 'капкан');
});

test('HUD: несколько кругов («Каменный капкан») — «вы вне круга», только если герой вне всех', () => {
  const P = { x: 0.5, y: 0, z: 6 };
  const near = drawn(snap([slam('t1', 0.6, { x: 4, y: 0, z: 4 }, { move: 'trap' }), slam('t2', 0.6, P, { move: 'trap' })]));
  assert(!has(near, /вы вне круга/), 'герой в одном из кругов');
  const away = drawn(snap([slam('t1', 0.6, { x: 5, y: 0, z: 3 }, { move: 'trap' }), slam('t2', 0.6, { x: -5, y: 0, z: 3 }, { move: 'trap' })]));
  assert(has(away, /вы вне круга/), 'герой вне всех кругов');
});

test('HUD: финал боя — «Регент повержен · время боя · «Сложная»»', () => {
  const fc = fakeCanvas();
  const hud = createBattleHud({ canvas: fc.canvas });
  const s = { ...snap([]), status: 'victory', boss: { position: { x: 0, y: 0, z: 0 }, hp: 0, maxHp: 12000, action: 'dead', stage: 2 } };
  const f = (events) => hud.frame({ dtReal: 1 / 60, timeScale: 1, screen: 'playing', snapshot: s, events, input: null, project, viewport: { w: 1366, h: 768 }, intro: { active: false, t: 0, duration: 5 }, settings: {}, resumeLeftMs: 0, pois: [], coach: null, layout: null });
  f([{ id: 'v1', type: 'victory', position: { x: 0, y: 3, z: 0 }, data: { time: 272 } }]);
  for (let i = 0; i < 20; i++) f([]);
  assert(has(fc.texts, /Регент повержен · время боя 4:32 · «Сложная»/), fc.texts.filter((t) => /Регент/.test(t)).join(' | '));
});

test('очки: обычный бой — урон как у прежней «Лёгкой», бонус за скорость, множитель «Сложная» ×1,5 и «Кошмар» ×2', () => {
  const mk = (lv, maxHp, mul, time = 270, extra = {}) => {
    const tally = createTally();
    tally.reset({ time: 0, stats: { damageDealt: 0 } });
    for (let k = 0; k < (extra.casts || 0); k++) tally.add([{ id: `m${k}`, type: 'sigil_cast', data: { sigil: 'gate' } }], 1);
    const snapEnd = { status: 'victory', time, stats: { damageDealt: maxHp }, boss: { maxHp } };
    return buildResult({ tally, snap: snapEnd, coach: { accuracy: 80, good: 16, mistakes: 4 }, kind: 'fight', difficulty: { level: lv, name: DIFFICULTY_NAMES[lv].name, scoreMul: mul } });
  };
  const n = mk('normal', 10000, 1), h = mk('hard', 12000, 1.5), k = mk('nightmare', 12500, 2);
  assert(n.difficulty === 'normal' && h.scoreMul === 1.5 && k.scoreMul === 2, 'уровень и множитель в итоге');
  const pts = (r, id) => (r.parts.find((p) => p.id === id) || {}).points;
  assert(pts(n, 'damage') === 7000 && pts(h, 'damage') === 7000 && pts(k, 'damage') === 7000, `урон: ${pts(n, 'damage')} ${pts(h, 'damage')} ${pts(k, 'damage')}`);
  assert(!n.parts.some((p) => p.id === 'difficulty'), 'Обычная: без строки множителя');
  const base = h.parts.filter((p) => p.id !== 'difficulty').reduce((a, p) => a + p.points, 0);
  const part = h.parts.find((p) => p.id === 'difficulty');
  assert(part && /×1,5/.test(part.detail) && /Сложная/.test(part.detail) && h.score === base + Math.round(base * 0.5), `Сложная: ${h.score} vs ${base}`);
  const baseK = k.parts.filter((p) => p.id !== 'difficulty').reduce((a, p) => a + p.points, 0);
  assert(k.score === baseK * 2, `Кошмар ×2: ${k.score} vs ${baseK}`);
  // быстрее нормы — бонус; затянуть бой ради лишних чар невыгодно
  const fast = mk('easy', 4600, 1, 116, { casts: 4 }), slow = mk('easy', 4600, 1, 240, { casts: 8 });
  assert(/быстрее нормы на 124 с/.test(fast.parts.find((p) => p.id === 'victory').detail), fast.parts.find((p) => p.id === 'victory').detail);
  assert(fast.score > slow.score, `быстрая победа ${fast.score} не выше медленной ${slow.score}`);
  // без чар и скорости победа — не S (ранг зависит от игры)
  const plain = buildResult({ tally: (() => { const t = createTally(); t.reset({ time: 0, stats: { damageDealt: 0 } }); return t; })(), snap: { status: 'victory', time: 300, stats: { damageDealt: 4600 }, boss: { maxHp: 4600 } }, coach: null, kind: 'fight', difficulty: { level: 'easy', name: 'Лёгкая', scoreMul: 1 } });
  assert(plain.rank !== 'S' && plain.score === 9500, `победа без всего: ${plain.score} ${plain.rank}`);
  // «Испытание» — как раньше: урон 1:1, секунды в запасе по 60, без множителя
  const sc = scoreChallenge({ damage: 12000, maxCombo: 20, accuracy: 80, gestures: 20, magic: 2, magicKinds: 1, ultimates: 2, victory: true, timeLeft: 10 });
  assert(sc.parts.find((p) => p.id === 'damage').points === 120000 && sc.parts.find((p) => p.id === 'victory').points === 2500 + 600 && !sc.parts.some((p) => p.id === 'difficulty'), 'испытание без изменений');
  assert(CHALLENGE.difficulty === 'challenge', 'у испытания своя сложность');
});

test('зал славы: запись хранит сложность и время боя (свой ключ для боёв)', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const hall = createHall(storage, { key: 'ashen-oath.hall-fight.v1', now: () => 1_800_000_000_000 });
  const r = hall.add({ score: 31000, rank: 'S', difficulty: 'nightmare', elapsed: 241.37, mode: 'novice', hero: 'ashen', won: true });
  const e = hall.all().find((x) => x.id === r.entry.id);
  assert(e && e.diff === 'nightmare' && e.sec === 241.4, JSON.stringify(e));
  assert(mem.has('ashen-oath.hall-fight.v1') && !mem.has('ashen-oath.hall.v1'), 'отдельный ключ');
});

test('голос: «Попробуй Сложную!» после победы на «Обычной»; на «Кошмаре» — похвала; в дуэли — молчит', () => {
  for (const p of Object.values(NEXT_DIFFICULTY_PHRASES)) {
    const w = p.trim().split(/\s+/).length;
    assert(w >= 2 && w <= 4 && p.length <= 32 && !/[A-Za-z]/.test(p), `фраза «${p}»`);
  }
  // поддельный синтезатор (как в dev/voiceCoach.test.mjs): фраза договаривается по synth.finish()
  const said = (view) => {
    const log = [];
    const synth = { current: null, pending: null, getVoices: () => [{ name: 'Irina', lang: 'ru-RU', localService: true, voiceURI: 'irina' }], addEventListener() {},
      speak(u) { if (synth.current) synth.pending = u; else synth.current = u; log.push(u.text); },
      cancel() { const c = synth.current; synth.current = null; synth.pending = null; if (c && c.onerror) c.onerror({ error: 'interrupted' }); },
      finish() { const c = synth.current; synth.current = synth.pending || null; synth.pending = null; if (c && c.onend) c.onend({}); },
      get speaking() { return !!synth.current; } };
    class U { constructor(text) { this.text = text; } }
    const clk = { t: 0 };
    const coach = createVoiceCoach({ synth, Utterance: U, clock: () => clk.t });
    const dir = createVoiceDirector(coach);
    dir.frame(0, { screen: 'playing' });
    dir.frame(10, { screen: 'playing', events: [{ type: 'victory' }], ...view });
    for (let t = 100; t <= 9000; t += 100) { clk.t = t; synth.finish(); dir.frame(t, { screen: t > 1700 ? 'victory' : 'playing', ...view }); }
    return log;
  };
  const n = said({ difficulty: 'normal' });
  assert(n.includes('Победа!') && n.includes(NEXT_DIFFICULTY_PHRASES.normal) && n.indexOf('Победа!') < n.indexOf(NEXT_DIFFICULTY_PHRASES.normal), n.join(','));
  assert(said({ difficulty: 'nightmare' }).includes('Кошмар покорён!'), 'вершина');
  assert(!said({}).some((x) => Object.values(NEXT_DIFFICULTY_PHRASES).includes(x)), 'без уровня (испытание) — без совета');
  assert(!said({ difficulty: 'normal', pvp: true }).some((x) => Object.values(NEXT_DIFFICULTY_PHRASES).includes(x)), 'дуэль — без совета');
});

test('рекорд победы — свой на каждой сложности; без уровня — прежний общий', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const r = createVoiceRecords(storage);
  assert(r.win(120, 70, 'easy') === false, 'первая победа — точка отсчёта');
  assert(r.win(300, 60, 'hard') === false, 'первая на «Сложной» — не рекорд, хоть и дольше «Лёгкой»');
  assert(r.win(280, 60, 'hard') === true, 'быстрее на «Сложной» — рекорд');
  assert(r.win(200, 50, 'easy') === false, 'медленнее на «Лёгкой» — не рекорд');
  assert(r.win(100, 50) === false && r.win(90, 50) === true, 'общий рекорд — как раньше');
  const r2 = createVoiceRecords(storage);
  assert(r2.data.levels.hard.win === 280, 'хранится');
});

test('названия уровней, порядок и совет на экране итогов', () => {
  assert(DIFFICULTY_ORDER.join() === DIFFICULTY_LEVELS.join(), 'порядок как в combat');
  assert(nextDifficulty('normal') === 'hard' && nextDifficulty('nightmare') === null && prevDifficulty('easy') === null && prevDifficulty('hard') === 'normal', 'соседи');
  assert(nextDifficultyText('normal') === 'Победа на «Обычной» — попробуй «Сложную»!', nextDifficultyText('normal'));
  assert(/Кошмаре/.test(nextDifficultyText('nightmare')) && nextDifficultyText('challenge') === '', 'вершина и чужой уровень');
  // множители очков в config.js — те, что показывает интерфейс
  const D = gameConfig.combat.difficulty;
  assert(D.hard.scoreMul === 1.5 && D.nightmare.scoreMul === 2 && D.easy.scoreMul === undefined && D.normal.scoreMul === undefined, 'config.js: ×1,5 и ×2');
});

test('постер: уровень и множитель в строке боя', () => {
  const fc = fakeCanvas();
  drawPoster(fc.ctx, { kind: 'fight', outcome: 'victory', score: 31000, rank: 'S', elapsed: 245, difficulty: 'nightmare', difficultyName: 'Кошмар', scoreMul: 2, heroName: 'Пепельный страж' });
  assert(has(fc.texts, /«КОШМАР» ×2/), 'шапка: «КОШМАР» ×2');
  assert(has(fc.texts, /сложность «Кошмар»/), 'подпись итога');
  const fc2 = fakeCanvas();
  drawPoster(fc2.ctx, { kind: 'challenge', outcome: 'timeup', score: 5000, rank: 'B', difficulty: 'challenge', difficultyName: '' });
  assert(!has(fc2.texts, /сложность/), 'испытание — без уровня');
});

let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  const s = Date.now();
  try { await t.fn(); console.log(`PASS  ${t.name}  (${Date.now() - s} ms)`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed, ${Date.now() - t0} ms`);
if (failed && typeof process !== 'undefined') process.exitCode = 1;
