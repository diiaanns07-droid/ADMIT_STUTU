// Звук: таблица сэмплов, режиссёр событий боя, шаги, подсказки обучения. node dev/sfx.test.mjs
// Без браузера: проверяет, что у каждого действия есть звук, файлы на месте и укладываются в 1,5 МБ,
// громкость выброса растёт с зарядом, шаги идут каденсом, «ОШИБКА» не звучит чаще раза в 1,5 с.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SFX, SFX_ALIAS, SFX_SYNTH_FALLBACK, RUNE_SFX, SIGIL_SFX, sfxFiles, sfxForEvent, createStepper, createCueTracker } from '../modules/sfx.js';
import { RUNE_IDS } from '../modules/combat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

// Имена старого синтеза (createAudioEngine в effects.js): S и петли. Режиссёр может звать и их.
const effSrc = readFileSync(join(ROOT, 'modules', 'effects.js'), 'utf8');
const synthBlock = effSrc.slice(effSrc.indexOf('  const S = {'), effSrc.indexOf('  const LOOPS = {'));
const SYNTH = new Set([...synthBlock.matchAll(/^ {4}([a-zA-Z]+)\(/gm)].map((m) => m[1]));
const loopBlock = effSrc.slice(effSrc.indexOf('  const LOOPS = {'), effSrc.indexOf('  const LOOP_CFG = {'));
const LOOPS = new Set([...loopBlock.matchAll(/^ {4}([a-zA-Z]+)\(v\)/gm)].map((m) => m[1]));
check('синтез найден в effects.js', SYNTH.size >= 20 && SYNTH.has('windup') && SYNTH.has('slam'), [...SYNTH].join(','));

// 1. файлы
{
  const files = sfxFiles('assets/sfx/');
  const missing = files.filter((f) => !existsSync(join(ROOT, f.url)));
  check('все файлы таблицы SFX на месте', missing.length === 0, missing.map((f) => f.url).join(', '));
  let total = 0;
  for (const f of files) if (existsSync(join(ROOT, f.url))) total += statSync(join(ROOT, f.url)).size;
  check('assets/sfx ≤ 1,5 МБ', total <= 1.5 * 1024 * 1024, `${(total / 1024).toFixed(0)} КБ, файлов ${files.length}`);
  const ogg = files.every((f) => !existsSync(join(ROOT, f.url)) || readFileSync(join(ROOT, f.url)).subarray(0, 4).toString() === 'OggS');
  check('файлы — Ogg', ogg);
  const bad = Object.entries(SFX).filter(([, s]) => !(s.gain > 0 && s.gain <= 1.2) || (s.pitch || 0) > 3 || (s.lim !== undefined && s.lim < 1));
  check('громкость/высота/лимиты в разумных пределах', bad.length === 0, bad.map(([k]) => k).join(','));
}

// 2. каждое имя, которое может прозвучать, существует (сэмпл или синтез)
{
  const known = (n) => !!SFX[n] || SYNTH.has(n);
  const aliasBad = Object.entries(SFX_ALIAS).filter(([k, v]) => !SFX[v] || !(SYNTH.has(k) || (LOOPS.has(k) && SFX[v].loop)));
  check('SFX_ALIAS: прежние имена → существующие сэмплы', aliasBad.length === 0, aliasBad.map(([k]) => k).join(','));
  const fbBad = Object.entries(SFX_SYNTH_FALLBACK).filter(([k, v]) => !SFX[k] || !SYNTH.has(v));
  check('запасной синтез есть у сэмплов', fbBad.length === 0, fbBad.map(([k]) => k).join(','));
  const noFb = Object.keys(SFX).filter((k) => !SFX[k].loop && !SFX_SYNTH_FALLBACK[k] && !SYNTH.has(k) && k !== 'step');
  check('у каждого одиночного сэмпла есть запасной синтез (кроме шагов)', noFb.length === 0, noFb.join(','));
  const runesOk = RUNE_IDS.every((r) => SFX[RUNE_SFX[r]]);
  check('руны: у каждой из 10 стихий свой аккорд', runesOk && RUNE_IDS.length === 10, RUNE_IDS.map((r) => `${r}→${RUNE_SFX[r]}`).join(' '));
  check('печати: все 5 со звуком', ['clap', 'gate', 'frame', 'delta', 'cor'].every((k) => SFX[SIGIL_SFX[k]]));
  const TYPES = ['player_cast', 'player_slash', 'burst', 'projectile_impact', 'boss_hit', 'player_hit', 'block', 'ward_end', 'parry',
    'player_dash', 'perfect_dodge', 'rune_cast', 'sigil_cast', 'ember_lit', 'bow_release', 'arrow_hit', 'arrow_rain', 'hand_spell_form',
    'hand_spell_cancel', 'hand_spell_throw', 'hand_spell_hit', 'boss_windup', 'boss_impact', 'boss_phase', 'victory', 'defeat',
    'shield_break', 'shield_end', 'pvp_round'];
  const DATA = [{}, { ability: 'bolt' }, { ability: 'spark' }, { ability: 'throw', kind: 'prism' }, { owner: 'boss' }, { owner: 'player', kind: 'sphere' },
    { success: true }, { reason: 'absorbed' }, { reason: 'depleted' }, { attackKind: 'nova' }, { attackKind: 'orb' }, { result: 'floor', kind: 'arrow' },
    { source: 'chain' }, { target: 'opponent' }, { rain: true }, { phase: 'match_end', winner: 'me' }, ...RUNE_IDS.map((rune) => ({ rune }))];
  const unknown = [];
  for (const t of TYPES) for (const d of DATA) for (const [n] of sfxForEvent(t, d) || []) if (!known(n)) unknown.push(`${t}:${n}`);
  check('режиссёр зовёт только существующие звуки', unknown.length === 0, [...new Set(unknown)].join(','));
}

// 3. звук на каждое действие из задания
{
  const one = (t, d) => { const l = sfxForEvent(t, d); return l && l.length ? l[0][0] : null; };
  const want = [
    ['выстрел', one('player_cast', { ability: 'bolt' }), 'shot'],
    ['искра', one('player_cast', { ability: 'spark' }), 'spark'],
    ['рассечение', one('player_slash', { dir: -1, power: 0.7 }), 'slash'],
    ['выброс', one('burst', { power: 1 }), 'burst'],
    ['руна огня', one('rune_cast', { rune: 'ignis' }), 'rune_fire'],
    ['руна молнии', one('rune_cast', { rune: 'fulgur' }), 'rune_storm'],
    ['попадание по боссу', one('boss_hit', { amount: 20 }), 'boss_hit'],
    ['удар босса по игроку', one('player_hit', { amount: 20 }), 'player_hit'],
    ['рывок', one('player_dash', { direction: 1 }), 'dash'],
    ['парирование', one('parry', { success: true }), 'parry'],
    ['удар по щиту', one('block', {}), 'block'],
    ['победа', one('victory', {}), 'victory'],
    ['поражение', one('defeat', {}), 'defeat'],
  ];
  for (const [label, got, exp] of want) check(`звук: ${label}`, got === exp, `${got}`);
  check('рассечение звучит один раз (player_cast slash молчит)', sfxForEvent('player_cast', { ability: 'slash' }) === null);
  check('промах парирования без звона', sfxForEvent('parry', { success: false }) === null);
  const g = (p) => sfxForEvent('burst', { power: p })[0][1];
  check('выброс: громче и ниже при полном заряде', g(1).gain > g(0.5).gain && g(0.5).gain > g(0).gain && g(1).rate < g(0).rate, `gain ${g(0).gain.toFixed(2)}→${g(1).gain.toFixed(2)}, rate ${g(0).rate.toFixed(2)}→${g(1).rate.toFixed(2)}`);
  const h = (a) => sfxForEvent('boss_hit', { amount: a })[0][1].gain;
  check('попадание по боссу: сильный удар громче', h(60) > h(10), `${h(10).toFixed(2)} → ${h(60).toFixed(2)}`);
  check('неизвестное событие — тишина', sfxForEvent('cruise_start', {}) === null && sfxForEvent('nope', null) === null);
  // одно действие — один звук
  check('стрела: звучит bow_release, а не player_cast', sfxForEvent('player_cast', { ability: 'arrow' }) === null && one('bow_release', {}) === 'shot');
  check('сгусток: звучит hand_spell_throw, а не player_cast', sfxForEvent('player_cast', { ability: 'hand_orb' }) === null && one('hand_spell_throw', { power: 1 }) === 'throw');
  check('попадание снаряда в Регента — только boss_hit', sfxForEvent('projectile_impact', { owner: 'player', kind: 'bolt', result: 'boss' }) === null);
  check('орб в щит/по герою — только block/player_hit', ['block', 'ward', 'bastion', 'hit'].every((r) => sfxForEvent('projectile_impact', { owner: 'boss', kind: 'orb', result: r }) === null));
  check('оберег: block без второго звука ward_end', sfxForEvent('ward_end', { reason: 'absorbed' }) === null);
  check('горение по Регенту не спамит', sfxForEvent('boss_hit', { amount: 3, source: 'burn', dot: true }) === null);
  check('снаряд в пол — тихий треск', one('projectile_impact', { owner: 'player', kind: 'bolt', result: 'floor' }) === 'spark');
  check('дуэль: исход матча — фанфары', one('pvp_round', { phase: 'match_end', winner: 'me' }) === 'victory' && one('pvp_round', { phase: 'match_end', winner: 'opponent' }) === 'defeat' && sfxForEvent('pvp_round', { phase: 'fight' }) === null);
}

// 4. шаги: каденс по скорости, тишина на месте
{
  const count = (speed, sec, ground = true) => {
    const st = createStepper(); let n = 0;
    for (let t = 0; t < sec; t += 1 / 60) if (st.tick(1 / 60, speed, ground) > 0) n++;
    return n;
  };
  const idle = count(0, 5), walk = count(3, 10), run = count(7, 10), air = count(7, 5, false);
  check('шаги: стоя — тишина', idle === 0, `${idle}`);
  check('шаги: ходьба ≈ 2 шага/с', walk >= 15 && walk <= 24, `${walk} за 10 с`);
  check('шаги: бег чаще ходьбы', run > walk && run <= 32, `${run} за 10 с`);
  check('шаги: в рывке — тишина', air === 0);
  const st = createStepper();
  check('шаги: первый шаг сразу после старта', [...Array(20)].some(() => st.tick(1 / 60, 3, true) > 0));
}

// 5. «Распознано» и «ОШИБКА»
{
  const c = createCueTracker({ errorGapMs: 1500 });
  check('«Распознано»: один раз на карточку', c.chip('dash') === 'ui_ok' && c.chip('dash') === null && c.chip('hands') === 'ui_ok');
  c.reset();
  check('«Распознано»: после нового захода в обучение — снова', c.chip('dash') === 'ui_ok');
  const hint = (code, tMs) => ({ code, tMs, text: 'Разожмите кулак' });
  check('«ОШИБКА»: новая подсказка → «тук»', c.hint(hint('fist_loose', 100), 1000) === 'ui_error');
  check('«ОШИБКА»: та же подсказка — тишина', c.hint(hint('fist_loose', 100), 1100) === null);
  check('«ОШИБКА»: чаще раза в 1,5 с — тишина', c.hint(hint('other', 200), 1900) === null);
  check('«ОШИБКА»: через 1,5 с — снова', c.hint(hint('other2', 300), 2700) === 'ui_error');
  check('«ОШИБКА»: подсказка без текста — тишина', c.hint({ code: 'x', tMs: 5 }, 9000) === null);
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
