// Голос тренера: фразы, очередь, ограничители, выбор голоса. node dev/voiceCoach.test.mjs
// Без браузера: поддельный speechSynthesis (getVoices, voiceschanged, speak/cancel) и ручные часы.
// Проверяет, что у каждого кода подсказки есть фраза, запасная фраза для неизвестного кода, «не чаще раза
// в 2,5 с» и «та же фраза — раз в 10 с», что «ОШИБКА» прерывает менее важное, что без русского голоса ничего
// не падает и что 10 ошибок подряд дают не больше 2–3 фраз.

import { COACH_HINTS, COACH_GROUPS } from '../core/gestureCoach.js';
import { SQUAT_HINTS } from '../core/squatCounter.js';
import { PUSHUP_FAULTS } from '../core/pushupCounter.js';
import {
  HINT_PHRASES, GROUP_PHRASES, GENERIC_PHRASE, TRAIN_PHRASES, ANNOUNCER, SIGIL_PHRASES, ULT_PHRASES,
  hintPhrase, trainPhrase, countWord, setSummary, numberWord, numberGenitive, groupOfCode,
} from '../core/voicePhrases.js';
import { createVoiceCoach, createVoiceDirector, createVoiceRecords, rankRussianVoices, PRIORITY } from '../modules/voiceCoach.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const words = (s) => s.trim().split(/\s+/).length;

// ───────── поддельный синтезатор ─────────
const V = {
  irina: { name: 'Microsoft Irina', lang: 'ru-RU', localService: true, voiceURI: 'irina' },
  google: { name: 'Google русский', lang: 'ru-RU', localService: false, voiceURI: 'google-ru' },
  milena: { name: 'Milena', lang: 'ru_RU', localService: true, voiceURI: 'milena' },
  uk: { name: 'Lesya', lang: 'uk-UA', localService: true, voiceURI: 'lesya' },
  en: { name: 'Alex', lang: 'en-US', localService: true, voiceURI: 'alex', default: true },
};
function fakeSynth(voices = [V.en, V.irina]) {
  let list = voices.slice();
  const listeners = [];
  const s = {
    log: [], cancels: 0, current: null,
    getVoices: () => list.slice(),
    addEventListener(type, fn) { if (type === 'voiceschanged') listeners.push(fn); },
    speak(u) { if (s.current) s.pending = u; else s.current = u; s.log.push(u); },
    cancel() {
      s.cancels++;
      const c = s.current; s.current = null; s.pending = null;
      if (c && c.onerror) c.onerror({ error: 'interrupted' });
    },
    // фраза договорена (или упала с ошибкой error)
    finish(error) {
      const c = s.current; s.current = s.pending || null; s.pending = null;
      if (!c) return;
      if (error && c.onerror) c.onerror({ error }); else if (c.onend) c.onend({});
    },
    setVoices(v) { list = v.slice(); for (const f of listeners) f(); },
    get speaking() { return !!s.current; },
    texts: () => s.log.map((u) => u.text),
  };
  return s;
}
class FakeUtterance { constructor(text) { this.text = text; } }
function rig(opts = {}) {
  const synth = opts.synth === undefined ? fakeSynth(opts.voices) : opts.synth;
  const clk = { t: 0 };
  const ducks = [];
  const coach = createVoiceCoach({ synth, Utterance: FakeUtterance, clock: () => clk.t, onDuck: (v) => ducks.push(v), ...opts.coach });
  return { synth, clk, coach, ducks, director: createVoiceDirector(coach) };
}

// 1. у каждого кода подсказки — своя короткая фраза
{
  const codes = Object.keys(COACH_HINTS);
  const missing = codes.filter((c) => !HINT_PHRASES[c]);
  check(`у каждого кода COACH_HINTS (${codes.length}) своя фраза`, missing.length === 0, missing.join(', '));
  const stale = Object.keys(HINT_PHRASES).filter((c) => !COACH_HINTS[c]);
  check('в таблице фраз нет кодов, которых нет в COACH_HINTS', stale.length === 0, stale.join(', '));
  const long = Object.entries(HINT_PHRASES).filter(([, p]) => words(p) < 2 || words(p) > 4 || p.length > 32);
  check('фразы боя — 2–4 слова, до 32 символов', long.length === 0, long.map(([c, p]) => `${c}: ${p}`).join('; '));
  check('пример: ok_ring_open → «Сомкни кольцо!»', hintPhrase({ code: 'ok_ring_open' }) === 'Сомкни кольцо!');
  check('пример: shield_palm → «Ладонь к камере!»', hintPhrase('shield_palm') === 'Ладонь к камере!');
  check('пример: burst_short → «Держи кулак дольше!»', hintPhrase({ code: 'burst_short', group: 'burst' }) === 'Держи кулак дольше!');
  const sq = Object.keys(SQUAT_HINTS).filter((c) => !TRAIN_PHRASES.squats[c]);
  check(`у каждой ошибки приседа (${Object.keys(SQUAT_HINTS).length}) своя фраза`, sq.length === 0, sq.join(', '));
  const pu = Object.keys(PUSHUP_FAULTS).filter((c) => !TRAIN_PHRASES.pushups[c]);
  check(`у каждой ошибки отжимания (${Object.keys(PUSHUP_FAULTS).length}) своя фраза`, pu.length === 0, pu.join(', '));
  const tl = [...Object.values(TRAIN_PHRASES.squats), ...Object.values(TRAIN_PHRASES.pushups)].filter((p) => words(p) > 4 || p.length > 32);
  check('фразы тренировки — до 4 слов', tl.length === 0, tl.join('; '));
  check('присед: valgus → «Колени наружу!», отжимание: shallow → «Ниже!»', trainPhrase('squats', 'valgus') === 'Колени наружу!' && trainPhrase('pushups', 'shallow') === 'Ниже!');
  const groups = Object.keys(COACH_GROUPS).filter((g) => !GROUP_PHRASES[g]);
  check('у каждой группы жестов есть запасная фраза', groups.length === 0, groups.join(', '));
}

// 2. неизвестный код: запасная фраза, ничего не молчит и не падает
{
  check('новый код с коротким fix → сам fix', hintPhrase({ code: 'pillar_low', fix: 'Руки выше головы', group: 'sigil' }) === 'Руки выше головы!');
  check('новый код с длинным fix → фраза группы', hintPhrase({ code: 'pillar_low', fix: 'Подними обе ладони высоко над головой и держи', group: 'sigil' }) === GROUP_PHRASES.sigil);
  check('новый код без записи → группа по префиксу (pillar_ → печать)', hintPhrase({ code: 'pillar_slow' }) === GROUP_PHRASES.sigil && groupOfCode('pillar_slow') === 'sigil');
  check('ультимейт: ult_arms → «Подними обе руки!»', hintPhrase({ code: 'ult_arms' }) === GROUP_PHRASES.ult && GROUP_PHRASES.ult === ULT_PHRASES.ready);
  check('совсем неизвестный код → общая фраза', hintPhrase({ code: 'zzz_qqq' }) === GENERIC_PHRASE);
  let threw = false;
  try { for (const x of [null, undefined, 5, '', {}, { code: 7 }, { code: 'x', fix: 9, group: {} }]) if (!hintPhrase(x)) threw = true; } catch (e) { threw = true; }
  check('мусор на входе hintPhrase → фраза, без исключений', !threw);
  check('тренировка: неизвестный код → общая фраза', trainPhrase('squats', 'qqq').length > 0 && trainPhrase(undefined, undefined).length > 0);
}

// 3. числа и итог подхода
{
  check('счёт: раз, два, три', countWord(1) === 'Раз' && countWord(2) === 'Два' && countWord(3) === 'Три');
  check('счёт: двадцать один, сто пять', countWord(21) === 'Двадцать один' && numberWord(105) === 'сто пять');
  check('родительный: десяти, двадцати одного, сорока', numberGenitive(10) === 'десяти' && numberGenitive(21) === 'двадцати одного' && numberGenitive(40) === 'сорока');
  check('итог: «Восемь из десяти!»', setSummary(8, 10) === 'Восемь из десяти!', setSummary(8, 10));
  check('итог без ошибок: «Пять из пяти! Чисто!»', setSummary(5, 5) === 'Пять из пяти! Чисто!', setSummary(5, 5));
  check('итог: пусто при нуле попыток', setSummary(0, 0) === '' && countWord(0) === '');
}

// 4. выбор голоса
{
  check('ранжирование: локальный ru-RU первым', rankRussianVoices([V.en, V.google, V.irina])[0] === V.irina);
  check('ранжирование: ru_RU (Safari) — тоже русский', rankRussianVoices([V.en, V.milena])[0] === V.milena);
  check('ранжирование: украинский и английский — не русский', rankRussianVoices([V.en, V.uk]).length === 0);
  const r = rig({ voices: [V.en, V.google, V.irina] });
  check('голос найден: локальный Irina', r.coach.status().state === 'ready' && r.coach.status().voice === 'Microsoft Irina' && r.coach.status().local === true);
  r.coach.event('Победа!');
  const u = r.synth.log[0];
  check('фраза: ru-RU, выбранный голос, громкость ползунка', u && u.lang === 'ru-RU' && u.voice === V.irina && Math.abs(u.volume - 0.7) < 1e-9);
  const only = rig({ voices: [V.en, V.google] });
  check('без локального — сетевой ru', only.coach.status().state === 'ready' && only.coach.status().local === false);
  // сетевой голос без сети: ошибка → голос помечен плохим, русских больше нет → тихо выключиться
  only.coach.event('Победа!');
  only.synth.finish('network');
  check('сетевой голос упал без сети → «нет русского голоса», без исключений', only.coach.status().state === 'no-ru' && only.coach.say('Добей его!') === 'off');
  const two = rig({ voices: [V.google, V.irina, V.milena] });
  two.coach.event('Победа!'); two.synth.finish('synthesis-failed');
  check('сломанный голос → следующий русский', two.coach.status().state === 'ready' && two.coach.status().voice === 'Milena');
}

// 5. getVoices() пуст до voiceschanged; нет русского — тихо выключиться
{
  const r = rig({ voices: [] });
  check('до voiceschanged — «ждём голоса»', r.coach.status().state === 'pending' && r.coach.say('Победа!') === 'off');
  r.clk.t = 400; r.synth.setVoices([V.en, V.irina]);
  check('voiceschanged с русским → голос готов', r.coach.status().state === 'ready');
  check('после этого фраза звучит', r.coach.event('Победа!') === 'queued' && r.synth.log.length === 1);
  const late = rig({ voices: [] });
  late.clk.t = 3200; late.coach.pump(3200);
  check('голосов так и нет 3 с → «нет русского голоса»', late.coach.status().state === 'no-ru' && !late.coach.available);
  late.synth.setVoices([V.milena]);
  check('голос появился позже → включился сам', late.coach.status().state === 'ready');
  const en = rig({ voices: [V.en, V.uk] });
  let ok = en.coach.status().state === 'no-ru' && en.coach.error('Сомкни кольцо!') === 'off' && en.synth.log.length === 0;
  try {
    for (let i = 0; i < 50; i++) { en.clk.t += 100; en.director.frame(en.clk.t, { screen: 'playing', hint: { code: 'ok_ring_open', tMs: i }, events: [{ type: 'victory' }, { type: 'sigil_cast', data: { sigil: 'gate' } }], boss: { hp: 5, maxHp: 100 } }); }
    en.director.frame(en.clk.t, { screen: 'training', training: { exercise: 'squats', reps: 3, attempts: 4, hint: { code: 'valgus', tMs: 1 } } });
  } catch (e) { ok = false; }
  check('без русского голоса ничего не падает и не звучит', ok && en.synth.log.length === 0);
  const none = rig({ synth: null });
  let ok2 = none.coach.status().state === 'no-api' && none.coach.say('Победа!') === 'off';
  try { none.director.frame(1, { screen: 'playing', hint: { code: 'x', tMs: 1 }, events: [{ type: 'victory' }] }); none.coach.setVolume(1); none.coach.setMuted(true); none.coach.dispose(); } catch (e) { ok2 = false; }
  check('браузер без speechSynthesis — ничего не падает', ok2);
}

// 6. ограничители частоты
{
  const r = rig();
  r.coach.event('Барьер разбит!');
  r.synth.finish();
  r.clk.t = 1000; r.coach.event('Регент в ярости!');
  check('вторая фраза через 1 с не звучит (ждёт 2,5 с)', r.synth.log.length === 1);
  r.clk.t = 2000; r.coach.pump(2000);
  check('…и через 2 с ещё ждёт', r.synth.log.length === 1);
  r.clk.t = 2500; r.coach.pump(2500);
  check('…через 2,5 с — звучит', r.synth.log.length === 2 && r.synth.log[1].text === 'Регент в ярости!');
  r.synth.finish();
  r.clk.t = 6000;
  check('та же фраза через 6 с — повтор отклонён', r.coach.event('Барьер разбит!') === 'repeat' && r.synth.log.length === 2);
  r.clk.t = 10100;
  check('та же фраза через 10 с — снова звучит', r.coach.event('Барьер разбит!') === 'queued' && r.synth.log.length === 3);
  r.synth.finish();
  // устаревшая фраза: подсказка ждёт не дольше своего ttl
  r.clk.t = 10600; r.coach.error('Сомкни кольцо!'); r.synth.finish();
  r.clk.t = 11000; r.coach.error('Ладонь к камере!');
  r.clk.t = 13000; r.coach.pump(13000);
  check('подсказка, прождавшая 2 с, выброшена (уже неактуальна)', r.synth.log.length === 4 && r.coach.status().queued === 0, r.synth.texts().join(' | '));
}

// 7. приоритет: «ОШИБКА» прерывает менее важное, менее важное — не прерывает
{
  const r = rig();
  r.coach.info('Распознано!');
  r.clk.t = 600; r.coach.error('Сомкни кольцо!');
  check('«ОШИБКА» прерывает «Распознано!» (cancel и сразу новая фраза)', r.synth.cancels === 1 && r.synth.current && r.synth.current.text === 'Сомкни кольцо!');
  r.clk.t = 3400; r.coach.event('Добей его!');
  check('реплика боя не прерывает звучащую «ОШИБКУ»', r.synth.cancels === 1 && r.synth.current.text === 'Сомкни кольцо!' && r.coach.status().queued === 1);
  r.synth.finish(); r.coach.pump(3420);
  check('…и звучит сразу после неё', r.synth.current && r.synth.current.text === 'Добей его!');
  r.synth.finish();
  // счёт повторов: свой поток (без 2,5 с), новая цифра заменяет старую, «ОШИБКА» врезается сразу
  r.clk.t = 7000; r.coach.count('Раз'); r.synth.finish();
  r.clk.t = 7800; r.coach.count('Два');
  check('счёт не ждёт 2,5 с', r.synth.current && r.synth.current.text === 'Два');
  r.clk.t = 7900; r.coach.count('Три'); r.coach.count('Четыре');
  check('пока звучит цифра, ждёт только последняя', r.coach.status().queued === 1);
  r.clk.t = 8000; r.coach.error('Колени наружу!');
  check('«ОШИБКА» врезается в счёт', r.synth.current && r.synth.current.text === 'Колени наружу!' && r.synth.cancels === 2);
  const p = PRIORITY;
  check('порядок приоритетов: счёт < инфо < бой < ошибка < финал', p.count < p.info && p.info < p.event && p.event < p.error && p.error < p.final);
}

// 8. 10 ошибок подряд — не больше 2–3 фраз
{
  const r = rig();
  const codes = ['ok_ring_open', 'shield_palm', 'burst_short', 'spark_one', 'slash_slow', 'parry_slow', 'orb_facing', 'rune_small', 'throw_weak', 'hand_edge'];
  for (let i = 0; i < 10; i++) {
    r.clk.t = i * 450;
    if (r.synth.current && r.clk.t - (r.synth.current.at || 0) > 0) r.synth.finish();   // фраза ≈ 0,45 с
    r.director.frame(r.clk.t, { screen: 'playing', hint: { code: codes[i], tMs: i * 450 } });
  }
  for (let t = 4500; t <= 8000; t += 100) { r.clk.t = t; r.synth.finish(); r.director.frame(t, { screen: 'playing', hint: null }); }
  const n = r.synth.log.length;
  check('10 разных ошибок за 4,5 с → 2–3 фразы', n >= 2 && n <= 3, `${n}: ${r.synth.texts().join(' | ')}`);
  const same = rig();
  for (let i = 0; i < 10; i++) { same.clk.t = i * 600; same.synth.finish(); same.director.frame(same.clk.t, { screen: 'playing', hint: { code: 'ok_ring_open', tMs: i * 600 } }); }
  check('10 одинаковых ошибок за 6 с → одна фраза', same.synth.log.length === 1, same.synth.texts().join(' | '));
  const rep = rig();
  for (let i = 0; i < 30; i++) { rep.clk.t = i * 16; rep.director.frame(rep.clk.t, { screen: 'playing', hint: { code: 'shield_palm', tMs: 5 } }); }
  check('тот же импульс подсказки в 30 кадрах — одна фраза', rep.synth.log.length === 1);
  const pz = rig();
  pz.director.frame(0, { screen: 'playing', hint: { code: 'ok_ring_open', tMs: 1 } });
  pz.clk.t = 500; pz.director.frame(500, { screen: 'playing', hint: { code: 'shield_palm', tMs: 2 } });
  pz.synth.finish(); pz.clk.t = 900; pz.director.frame(900, { screen: 'paused' });
  pz.clk.t = 2600; pz.director.frame(2600, { screen: 'paused' });
  check('ушёл на паузу — ждущая подсказка боя не звучит', pz.synth.log.length === 1, pz.synth.texts().join(' | '));
  const menu = rig();
  menu.director.frame(0, { screen: 'menu', hint: { code: 'shield_palm', tMs: 5 } });
  check('в меню подсказки не звучат', menu.synth.log.length === 0);
}

// 9. громкость, «Без звука», выключатель, приглушение SFX
{
  const r = rig();
  r.coach.setVolume(0.35);
  r.coach.event('Победа!');
  check('громкость — общий ползунок', Math.abs(r.synth.log[0].volume - 0.35) < 1e-9);
  check('пока звучит речь — SFX приглушены (onDuck(true))', r.ducks[r.ducks.length - 1] === true);
  r.synth.finish(); r.clk.t = 200; r.coach.pump(200);
  check('…сразу после фразы ещё приглушены (без «качелей» между фразами)', r.ducks[r.ducks.length - 1] === true);
  r.clk.t = 600; r.coach.pump(600);
  check('…через 0,25 с тишины — громкость SFX вернулась', r.ducks[r.ducks.length - 1] === false);
  r.clk.t = 3500; r.coach.event('Добей его!');
  r.coach.setMuted(true);
  check('«Без звука» (M) обрывает речь и глушит голос', r.synth.cancels >= 1 && !r.synth.current && r.coach.say('Новый рекорд!') === 'off' && r.ducks[r.ducks.length - 1] === false);
  r.coach.setMuted(false); r.coach.setEnabled(false);
  check('«Голос тренера» выключен — фразы не звучат', r.coach.say('Новый рекорд!') === 'off' && r.coach.status().enabled === false);
  r.coach.setEnabled(true); r.coach.setVolume(0);
  check('громкость 0 — голос молчит', r.coach.say('Новый рекорд!') === 'off');
  const act = { on: false };
  const g = rig({ coach: { activation: () => act.on } });
  g.coach.final('Победа!');
  check('до первого действия пользователя (Chrome) — ждёт, не тратит фразу', g.synth.log.length === 0 && g.coach.status().queued === 1);
  act.on = true; g.clk.t = 100; g.coach.pump(100);
  check('…после клика — звучит', g.synth.log.length === 1);
  const w = rig();
  w.coach.event('Победа!'); w.clk.t = 9000; w.coach.pump(9000);
  check('страховка: onend не пришёл — фраза снята по времени', !w.coach.status().speaking);
}

// 10. режиссёр: бой, печати, ультимейт, тренировка, обучение
{
  const r = rig();
  const step = (dt, view) => { r.clk.t += dt; r.synth.finish(); r.director.frame(r.clk.t, view); return r.synth.log.length ? r.synth.log[r.synth.log.length - 1].text : null; };
  step(0, { screen: 'playing' });
  check('печать «Врата» → «Врата бури!»', step(100, { screen: 'playing', events: [{ type: 'sigil_cast', data: { sigil: 'gate' } }] }) === SIGIL_PHRASES.gate);
  check('печать «Столп» → «Столп небес!»', step(2600, { screen: 'playing', events: [{ type: 'sigil_cast', data: { sigil: 'pillar' } }] }) === SIGIL_PHRASES.pillar);
  check('оглушение Регента → «Барьер разбит!»', step(2600, { screen: 'playing', events: [{ type: 'boss_stunned', data: { duration: 2 } }] }) === ANNOUNCER.barrier);
  check('вторая фаза → «Регент в ярости!»', step(2600, { screen: 'playing', events: [{ type: 'boss_phase', data: { stage: 2, from: 1 } }] }) === ANNOUNCER.enraged);
  const n0 = r.synth.log.length;
  step(2600, { screen: 'playing', events: [{ type: 'boss_phase', data: { stage: 1, awaken: true } }] });
  check('«пробуждение» в облёте — без «ярости»', r.synth.log.length === n0);
  check('здоровье Регента ≤ 20 % → «Добей его!»', step(2600, { screen: 'playing', boss: { hp: 18, maxHp: 100 } }) === ANNOUNCER.finish);
  const n1 = r.synth.log.length;
  step(12000, { screen: 'playing', boss: { hp: 10, maxHp: 100 } });
  check('«Добей его!» — один раз за бой', r.synth.log.length === n1);
  check('ультимейт: подсказка → «Подними обе руки!»', step(2600, { screen: 'playing', events: [{ type: 'ultimate_ready' }] }) === ULT_PHRASES.ready);
  check('ультимейт: удар → «Небесный суд!»', step(2600, { screen: 'playing', events: [{ type: 'ultimate_cast' }] }) === ULT_PHRASES.cast);
  check('победа → «Победа!»', step(2600, { screen: 'playing', events: [{ type: 'victory' }] }) === ANNOUNCER.victory);
  const pv = rig();
  const cd = [];
  for (const [t, n] of [[0, 3], [1000, 2], [2000, 1], [3000, 0]]) {
    pv.clk.t = t; pv.synth.finish();
    pv.director.frame(t, { screen: 'playing', pvp: true, countdown: n, events: n === 0 ? [{ type: 'pvp_round', data: { phase: 'fight', round: 1 } }] : [] });
    if (pv.synth.current) cd.push(pv.synth.current.text);
  }
  check('дуэль: отсчёт по тикам «Три… Два… Один» и «В бой!» — без ожидания 2,5 с', cd.join(',') === 'Три,Два,Один,В бой!', cd.join(','));
  pv.synth.finish(); pv.clk.t = 6000;
  pv.director.frame(6000, { screen: 'playing', pvp: true, boss: { hp: 5, maxHp: 100 }, events: [{ type: 'victory' }] });
  check('дуэль: без «Добей его!» и без «Победа!» за Регента', pv.synth.log.length === 4);
  pv.clk.t = 9000;
  pv.director.frame(9000, { screen: 'playing', pvp: true, events: [{ type: 'pvp_round', data: { phase: 'match_end', winner: 'me' } }] });
  check('дуэль: победа в матче → «Победа!»', pv.synth.current && pv.synth.current.text === ANNOUNCER.victory);
  const ar = rig();
  ar.director.frame(0, { screen: 'paused', countdown: 3 });
  ar.clk.t = 300; ar.coach.error('Сомкни кольцо!');
  check('отсчёт не прерывается подсказкой', ar.synth.current && ar.synth.current.text === 'Три');
  // обучение: «Распознано!» — раз на карточку
  const tu = rig();
  tu.director.frame(0, { screen: 'tutorial', recognized: 'ok' });
  tu.synth.finish(); tu.clk.t = 3000; tu.director.frame(3000, { screen: 'tutorial', recognized: 'ok' });
  check('обучение: «Распознано!» один раз на карточку', tu.synth.log.length === 1 && tu.synth.log[0].text === ANNOUNCER.recognized);
  // тренировка: счёт, ошибка, итог подхода
  const tr = rig();
  const T = (dt, training) => { tr.clk.t += dt; tr.synth.finish(); tr.director.frame(tr.clk.t, { screen: 'training', training }); };
  T(0, { exercise: 'squats', reps: 0, attempts: 0, hint: null });
  T(2000, { exercise: 'squats', reps: 1, attempts: 1, hint: null });
  T(2000, { exercise: 'squats', reps: 2, attempts: 2, hint: null });
  const valgus = { code: 'valgus', text: SQUAT_HINTS.valgus, tMs: 6000 };
  T(2000, { exercise: 'squats', reps: 2, attempts: 3, hint: valgus });
  T(2000, { exercise: 'squats', reps: 3, attempts: 4, hint: valgus });
  check('тренировка: счёт «Раз… Два… Три» и ошибка «Колени наружу!»', tr.synth.texts().join(',') === 'Раз,Два,Колени наружу!,Три', tr.synth.texts().join(','));
  for (let i = 0; i < 80; i++) T(100, { exercise: 'squats', reps: 3, attempts: 4, hint: valgus });
  check('тренировка: пауза 7 с → итог подхода «Три из четырёх!»', tr.synth.texts().includes('Три из четырёх!'), tr.synth.texts().join(','));
  const pu = rig();
  const P = (dt, training) => { pu.clk.t += dt; pu.synth.finish(); pu.director.frame(pu.clk.t, { screen: 'training', training }); };
  P(0, { exercise: 'pushups', reps: 0, attempts: 0, hint: null });
  for (let i = 1; i <= 8; i++) P(1500, { exercise: 'pushups', reps: i, attempts: i, hint: null });
  P(1500, { exercise: 'pushups', reps: 8, attempts: 9, hint: { code: 'shallow', tMs: 1 } });
  P(1500, { exercise: 'pushups', reps: 8, attempts: 10, hint: { code: 'sag', tMs: 2 } });
  pu.clk.t += 500; pu.synth.finish(); pu.director.frame(pu.clk.t, { screen: 'menu' });
  for (let t = 0; t < 3000; t += 100) { pu.clk.t += 100; pu.synth.finish(); pu.director.frame(pu.clk.t, { screen: 'menu' }); }
  check('отжимания: ушёл с экрана → итог «Восемь из десяти!»', pu.synth.texts().includes('Восемь из десяти!'), pu.synth.texts().join(','));
}

// 11. рекорды: «Новый рекорд!» — только когда есть с чем сравнить
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const recs = createVoiceRecords(storage);
  check('первая победа — не рекорд (точка отсчёта)', recs.win(180, 60) === false);
  check('победа медленнее и хуже — не рекорд', recs.win(200, 55) === false);
  check('победа быстрее — рекорд', recs.win(150, 50) === true);
  check('точность выше — рекорд', recs.win(170, 75) === true);
  check('рекорды пережили перезагрузку (localStorage)', createVoiceRecords(storage).data.win === 150 && createVoiceRecords(storage).data.acc === 75);
  const broken = createVoiceRecords({ getItem: () => '{не json', setItem: () => { throw new Error('quota'); } });
  let ok = true;
  try { broken.win(100, 50); broken.reps('squats', 5); ok = broken.best('squats') === 5; } catch (e) { ok = false; }
  check('испорченное или недоступное хранилище — без исключений', ok && createVoiceRecords(null).win(10, 10) === false);
  // бой: победа быстрее прежней → «Победа!», затем «Новый рекорд!»
  const r = rig();
  const d = createVoiceDirector(r.coach, { records: recs });
  d.frame(0, { screen: 'playing' });
  d.frame(10, { screen: 'playing', fight: { time: 120, accuracy: 40 }, events: [{ type: 'victory' }] });
  for (let t = 100; t <= 4000; t += 100) { r.clk.t = t; r.synth.finish(); d.frame(t, { screen: t > 1700 ? 'victory' : 'playing' }); }
  check('бой: «Победа!», затем «Новый рекорд!»', r.synth.texts().join(',') === 'Победа!,Новый рекорд!', r.synth.texts().join(','));
  // тренировка: прежний лучший подход 5 → на шестом повторе «Новый рекорд!» вместо «Шесть», один раз
  const tr = rig();
  const recs2 = createVoiceRecords(storage);
  recs2.reps('pushups', 5);
  const dt = createVoiceDirector(tr.coach, { records: recs2 });
  const said = [];
  for (let i = 0; i <= 8; i++) {
    tr.clk.t = i * 1500; tr.synth.finish();
    dt.frame(tr.clk.t, { screen: 'training', training: { exercise: 'pushups', reps: i, attempts: i, hint: null } });
    if (tr.synth.current) said.push(tr.synth.current.text);
  }
  check('тренировка: шестой повтор при рекорде 5 → «Новый рекорд!», дальше — счёт', said.join(',') === 'Раз,Два,Три,Четыре,Пять,Новый рекорд!,Семь,Восемь', said.join(','));
  check('тренировка: лучший подход сохранён', recs2.best('pushups') === 8);
}

console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
