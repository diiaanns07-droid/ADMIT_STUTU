// [W3-CHALLENGE] «Испытание · 60 с», зал славы дня и постер. node dev/challenge.test.mjs
// • очки и ранги: каждая часть счёта, пороги S/A/B/C/D, «до следующего ранга»;
// • подсчёт по событиям боя: серия, печати/руны, ультимейт по имени события, повторы и события соперника;
// • зал славы: сортировка, топ-10, место и рекорд, имя из 3 букв, прошлые дни, битое и недоступное хранилище;
// • мозг Регента: в испытании порядок атак одинаков при любом seed страницы; фазы попытки 3-2-1 → 60 с → итоги;
// • постер рисуется без ошибок (canvas — заглушка, записывающая вызовы); QR — самопроверка Рида — Соломона,
//   данные совпадают с независимым QR из pitch/index.html.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { createBossBrain } from '../modules/boss.js';
import { createCombat } from '../modules/combat.js';
import {
  CHALLENGE, SCORE, RANKS, rankOf, nextRank, scoreChallenge, createTally, isUltimateEvent, createHall, sanitizeName, sortHall,
  dayKey, createChallengeBrain, createChallengeSession, buildResult, bestGestureOf, HALL_KEY,
} from '../modules/challenge.js';
import { drawPoster, qrMatrix, skeletonFromVision, demoSkeleton, posterFileName, POSTER_W, POSTER_H, GAME_URL } from '../modules/posterCard.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// ───────── очки и ранги ─────────
test('пустая попытка: 0 очков, ранг D', () => {
  const s = scoreChallenge({});
  eq(s.total, 0); eq(s.rank, 'D');
  ok(s.parts.every((p) => p.points === 0), 'все части по нулям');
  ok(!s.parts.some((p) => p.id === 'victory'), 'без победы нет строки победы');
});
test('урон, серия, точность, магия и ультимейт складываются', () => {
  const s = scoreChallenge({ damage: 300, maxCombo: 20, accuracy: 80, gestures: 16, magic: 2, magicKinds: 1, ultimates: 1 });
  const by = Object.fromEntries(s.parts.map((p) => [p.id, p.points]));
  eq(by.damage, 300 * SCORE.damage, 'урон');
  eq(by.combo, 20 * SCORE.combo, 'серия');
  eq(by.accuracy, 80 * SCORE.accuracy, 'точность — полный бонус');
  eq(by.magic, 2 * SCORE.magic + SCORE.magicNew + SCORE.ultimate, 'магия');
  eq(s.total, Object.values(by).reduce((a, b) => a + b, 0), 'сумма частей');
});
test('бонус точности растёт с числом жестов (один удачный жест не даёт полный бонус)', () => {
  const one = scoreChallenge({ accuracy: 100, gestures: 1 }).parts.find((p) => p.id === 'accuracy').points;
  const many = scoreChallenge({ accuracy: 100, gestures: 40 }).parts.find((p) => p.id === 'accuracy').points;
  eq(many, 100 * SCORE.accuracy);
  ok(one > 0 && one < many / 4, `один жест ${one} ≪ ${many}`);
  eq(scoreChallenge({ accuracy: null, gestures: 10 }).parts.find((p) => p.id === 'accuracy').points, 0, 'без жестов — 0');
});
test('победа: бонус и секунды в запасе', () => {
  const s = scoreChallenge({ damage: 700, victory: true, timeLeft: 17.6 });
  const v = s.parts.find((p) => p.id === 'victory');
  ok(v, 'строка победы');
  eq(v.points, SCORE.victory + 17 * SCORE.perSecondLeft);
  ok(s.total >= RANKS[0].min, `победа над Регентом за минуту — ранг S (${s.total})`);
  eq(s.rank, 'S');
});
test('пороги рангов S/A/B/C/D и мусор на входе', () => {
  for (const r of RANKS) { eq(rankOf(r.min), r.id, `ровно ${r.min}`); if (r.min > 0) ok(rankOf(r.min - 1) !== r.id, `${r.min - 1} ниже ${r.id}`); }
  eq(rankOf(NaN), 'D'); eq(rankOf(-50), 'D'); eq(rankOf(undefined), 'D'); eq(rankOf(1e9), 'S');
  const s = scoreChallenge({ damage: -40, maxCombo: NaN, accuracy: 250, gestures: 99, magic: -3, magicKinds: 7 });
  ok(s.total >= 0 && Number.isFinite(s.total), 'неотрицательный конечный счёт');
  ok(s.parts.find((p) => p.id === 'accuracy').points <= 100 * SCORE.accuracy, 'точность ≤ 100%');
});
test('до следующего ранга', () => {
  const n = nextRank(RANKS[1].min - 120);
  eq(n.id, 'A'); eq(n.need, 120);
  eq(nextRank(RANKS[0].min), null, 'у S следующего нет');
  eq(nextRank(0).id, 'C');
});
test('типичные попытки ложатся в разные ранги', () => {
  const first = scoreChallenge({ damage: 180, maxCombo: 8, accuracy: 70, gestures: 10 }).rank;
  const fair = scoreChallenge({ damage: 330, maxCombo: 16, accuracy: 82, gestures: 18 }).rank;
  const good = scoreChallenge({ damage: 560, maxCombo: 26, accuracy: 88, gestures: 26, magic: 1, magicKinds: 1 }).rank;
  ok(['D', 'C'].includes(first), `первая неуверенная — ${first}`);
  eq(fair, 'B', 'уверенная — B');
  eq(good, 'A', 'сильная без победы — A');
});

// ───────── подсчёт по событиям ─────────
test('ультимейт узнаётся по имени события, служебные события — нет', () => {
  for (const t of ['ultimate', 'ultimate_cast', 'player_ultimate', 'ult_cast', 'hero_ultimate_start']) ok(isUltimateEvent({ type: t }), t);
  for (const t of ['ultimate_hit', 'ultimate_ready', 'ultimate_end', 'ultimate_charge', 'boss_hit', 'result', 'multi_cast', 'adult']) ok(!isUltimateEvent({ type: t }), `не ${t}`);
  ok(isUltimateEvent({ type: 'player_cast', data: { ability: 'ultimate' } }), 'player_cast ultimate');
  ok(!isUltimateEvent({ type: 'player_cast', data: { ability: 'bolt' } }), 'player_cast bolt');
  ok(!isUltimateEvent(null) && !isUltimateEvent({}), 'мусор');
});
test('серия, печати, руны, ультимейт; повторы по id и события соперника не считаются', () => {
  const t = createTally();
  t.reset({ time: 2, stats: { damageDealt: 40 } });
  const ev = [
    { id: 'h1', type: 'boss_hit', data: { amount: 6, combo: 1 } },
    { id: 'h2', type: 'boss_hit', data: { amount: 6, combo: 2 } },
    { id: 's1', type: 'sigil_cast', data: { sigil: 'clap' } },
    { id: 'u1', type: 'ultimate_cast', data: {} },
    { id: 'u2', type: 'ultimate_flash', data: {} },               // тот же ультимейт (меньше секунды)
    { id: 'r1', type: 'boss_hit', data: { amount: 9, combo: 7, remote: true } },
  ];
  ok(t.add(ev, 5), 'было попадание');
  t.add([ev[1], { id: 'h3', type: 'boss_hit', data: { combo: 3 } }, { id: 's2', type: 'sigil_cast', data: { sigil: 'clap' } }, { id: 'r2', type: 'rune_cast', data: { rune: 'ignis' } }], 5.5);
  t.add([{ id: 'u3', type: 'player_ultimate', data: {} }], 9);
  const r = t.read({ time: 30, stats: { damageDealt: 540 } }, { accuracy: 75, good: 9, mistakes: 3 });
  eq(r.hits, 3, 'попадания (повтор h2 и соперник — мимо)');
  eq(r.maxCombo, 3, 'лучшая серия');
  eq(r.magic, 3, 'печати и руна');
  eq(r.magicKinds, 2, 'видов магии: хлопок и игнис');
  eq(r.ultimates, 2, 'два ультимейта');
  eq(r.damage, 500, 'урон с начала попытки');
  eq(r.elapsed, 28);
  eq(r.gestures, 12); eq(r.accuracy, 75);
  eq(t.lastHitAt, 5.5);
});
test('лучший жест — по числу удачных', () => {
  const b = bestGestureOf({ groups: [{ id: 'ok', title: '«OK» · снаряд', good: 14, accuracy: 80 }, { id: 'shield', title: 'Щит', good: 3, accuracy: 100 }, { id: 'burst', title: 'Выброс', good: 0, accuracy: 0 }] });
  eq(b.id, 'ok');
  eq(bestGestureOf({ groups: [] }), null);
  eq(bestGestureOf(null), null);
});

// ───────── зал славы ─────────
function memStore() { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
const NOW = new Date(2026, 9, 2, 15, 30).getTime();
test('сортировка по очкам, при равенстве — кто раньше', () => {
  let t = NOW;
  const hall = createHall(memStore(), { now: () => (t += 1000) });
  hall.add({ score: 3000 }); const b = hall.add({ score: 8000 }); const c = hall.add({ score: 3000 }); hall.add({ score: 5000 });
  const l = hall.list();
  eq(l.map((e) => e.score).join(','), '8000,5000,3000,3000');
  eq(l[0].id, b.entry.id);
  eq(l[3].id, c.entry.id, 'равные очки: позже — ниже');
  eq(sortHall([{ id: 'b', score: 1, t: 5 }, { id: 'a', score: 1, t: 5 }])[0].id, 'a', 'стабильный порядок');
});
test('топ-10 на экране, место и рекорд дня', () => {
  let t = NOW;
  const hall = createHall(memStore(), { now: () => (t += 10) });
  for (let i = 1; i <= 14; i++) hall.add({ score: i * 500, rank: rankOf(i * 500) });
  eq(hall.list().length, 10, 'показываем 10');
  eq(hall.all().length, 14, 'хранятся все');
  const r1 = hall.add({ score: 100 });
  eq(r1.place, 15); eq(r1.total, 15); eq(r1.isRecord, false);
  ok(!hall.list().some((e) => e.id === r1.entry.id), 'вне десятки');
  const r2 = hall.add({ score: 99999 });
  eq(r2.place, 1); ok(r2.isRecord); eq(r2.prevBest.score, 7000);
  eq(hall.best().id, r2.entry.id);
  eq(hall.placeOf(r1.entry.id), 16);
});
test('за день хранится не больше 50 попыток — выпадают слабейшие', () => {
  let t = NOW;
  const hall = createHall(memStore(), { now: () => (t += 1) });
  for (let i = 0; i < 60; i++) hall.add({ score: 1000 + i });
  const all = hall.all();
  eq(all.length, 50);
  eq(all[all.length - 1].score, 1010, 'самые слабые выпали');
});
test('имя: до 3 букв любого алфавита, заглавными; переименование', () => {
  eq(sanitizeName('аня'), 'АНЯ'); eq(sanitizeName('Tim!'), 'TIM'); eq(sanitizeName('  д-а н ии '), 'ДАН');
  eq(sanitizeName('әлі'), 'ӘЛІ'); eq(sanitizeName('<b>'), 'B'); eq(sanitizeName('7z'), '7Z'); eq(sanitizeName(null), ''); eq(sanitizeName('🙂🙂'), '');
  const st = memStore();
  const hall = createHall(st, { now: () => NOW });
  const r = hall.add({ score: 4200 });
  eq(hall.list()[0].name, '', 'до ввода — без имени');
  ok(hall.rename(r.entry.id, 'мир<script>'), 'переименовано');
  eq(hall.list()[0].name, 'МИР');
  ok(!hall.rename('нет-такого', 'ЖЖЖ'), 'чужой id — нет');
  eq(createHall(st, { now: () => NOW }).list()[0].name, 'МИР', 'имя сохранилось в хранилище');
});
test('«зал славы дня»: прошлые дни не показываются', () => {
  let t = NOW;
  const st = memStore();
  const hall = createHall(st, { now: () => t });
  hall.add({ score: 9000 });
  t = NOW + 24 * 3600 * 1000;
  eq(hall.list().length, 0, 'новый день — пустой зал');
  hall.add({ score: 100 });
  eq(hall.list().length, 1);
  eq(JSON.parse(st.getItem(HALL_KEY)).entries.length, 1, 'прошлый день убран из хранилища');
  eq(dayKey(NOW), '2026-10-02');
});
test('битое хранилище: мусорный JSON, не массив, мусорные записи — пустой зал, запись работает', () => {
  for (const raw of ['{не json', '"строка"', '42', 'null', '{"v":1,"entries":"x"}', JSON.stringify([null, 5, 'x', { id: 7 }, { id: 'a' }, { id: 'b', score: 'много' }])]) {
    const st = memStore(); st.setItem(HALL_KEY, raw);
    const hall = createHall(st, { now: () => NOW });
    eq(hall.list().length, 0, `пусто для ${raw.slice(0, 20)}`);
    const r = hall.add({ score: 1234 });
    eq(r.place, 1);
    eq(hall.list()[0].score, 1234);
  }
  // записи с лишними и кривыми полями чистятся
  const st = memStore();
  st.setItem(HALL_KEY, JSON.stringify([{ id: 'x', score: 777.6, name: 'abcdef', rank: 'Z', day: dayKey(NOW), acc: 340, mode: 'hack', evil: '<img>' }, { id: 'x', score: 1, day: dayKey(NOW) }]));
  const e = createHall(st, { now: () => NOW }).list();
  eq(e.length, 1, 'повтор id отброшен');
  eq(e[0].score, 778); eq(e[0].name, 'ABC'); eq(e[0].rank, 'D'); eq(e[0].acc, 100); eq(e[0].mode, 'novice'); ok(!('evil' in e[0]));
});
test('хранилище бросает исключения или его нет — зал живёт в памяти вкладки', () => {
  const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };
  for (const st of [throwing, null, undefined, {}]) {
    const hall = createHall(st, { now: () => NOW });
    eq(hall.list().length, 0);
    hall.add({ score: 500 }); const r = hall.add({ score: 900 });
    eq(r.place, 1); eq(hall.list().length, 2, 'запись видна в этой вкладке');
    ok(hall.rename(r.entry.id, 'ОК'));
    eq(hall.list()[0].name, 'ОК');
    hall.clear();
    eq(hall.list().length, 0, 'очистка');
  }
  // пишет, но чтение сломалось после записи (квота): данные — из памяти, а не из старого хранилища
  const st = memStore(); st.setItem(HALL_KEY, JSON.stringify([{ id: 'old', score: 1, day: dayKey(NOW) }]));
  const half = { getItem: st.getItem, setItem() { throw new Error('QuotaExceeded'); } };
  const hall = createHall(half, { now: () => NOW });
  hall.add({ score: 5000 });
  eq(hall.list().map((e) => e.score).join(','), '5000,1');
});
test('?reset-hall: clear() очищает хранилище', () => {
  const st = memStore();
  const hall = createHall(st, { now: () => NOW });
  hall.add({ score: 10 });
  hall.clear();
  eq(st.getItem(HALL_KEY), null);
  eq(hall.list().length, 0);
});

// ───────── мозг Регента и фазы попытки ─────────
const DT = 1 / 60;
const idle = () => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, moveZ: 0, dash: 0, attack: false, shield: false, burst: false });
function attackOrder(pageSeed, challenge, sec = 40) {
  config.settings = { ...config.defaultSettings };
  const cfg = { ...config, boss: { ...config.boss, seed: pageSeed } };
  const brain = createChallengeBrain(createBossBrain, cfg);
  brain.useChallenge(challenge);
  const combat = createCombat({ config: cfg, bossBrain: brain });
  combat.reset();
  const kinds = [];
  for (let i = 0; i < sec / DT; i++) {
    const inp = idle(); inp.shield = (i % 240) < 120;   // держим щит половину времени: герой живёт дольше
    combat.update(DT, inp);
    for (const e of combat.drainEvents()) if (e.type === 'boss_windup') kinds.push(e.data.attackKind || e.data.kind);
    if (combat.getSnapshot().status !== 'playing') break;
  }
  return kinds.join(',');
}
test('испытание: порядок атак Регента одинаков при любом seed страницы', () => {
  const a = attackOrder(111, true), b = attackOrder(987654321, true);
  ok(a.split(',').length >= 4, `атак достаточно: ${a}`);
  eq(a, b, 'одинаковый порядок');
  eq(attackOrder(5, true), a, 'и при третьем seed');
});
test('обычный бой: порядок атак зависит от seed страницы', () => {
  const seeds = [1, 2, 3, 4, 5, 6].map((s) => attackOrder(s, false));
  ok(new Set(seeds).size > 1, 'разные seed — разный порядок');
});
test('мозг испытания включается и выключается', () => {
  const brain = createChallengeBrain(createBossBrain, config);
  eq(brain.challenge, false);
  brain.useChallenge(true); eq(brain.challenge, true);
  eq(brain.getConfig().seed, CHALLENGE.seed, 'seed испытания');
  brain.useChallenge(false); eq(brain.challenge, false);
  ok(typeof brain.update === 'function' && typeof brain.reset === 'function');
});
test('фазы: 3-2-1 → бой 60 с (по времени боя) → «ВРЕМЯ ВЫШЛО» → итоги', () => {
  const s = createChallengeSession();
  eq(s.phase, 'off'); eq(s.active, false);
  s.arm(); eq(s.phase, 'armed'); ok(s.active);
  let now = 1000;
  s.begin(now, { time: 0 });
  ok(s.frozen(now), 'на отсчёте бой стоит');
  eq(s.view(now).count, 3);
  const sig = [];
  for (; now < 1000 + CHALLENGE.countdownMs + 50; now += 100) { const x = s.frame(now, { time: 0 }); if (x) sig.push(x); }
  eq(sig.join(','), 'tick,tick,tick,go', 'звук на 3, 2, 1 и «ВПЕРЁД»');
  eq(s.phase, 'running'); ok(!s.frozen(now));
  ok(s.view(now).go, '«ВПЕРЁД!» держится');
  eq(s.frame(now, { time: 30 }), null);
  eq(Math.round(s.timeLeft()), 30);
  eq(s.frame(now, { time: 59.9 }), null);
  eq(s.frame(now + 1, { time: 60.01 }), 'timeup');
  eq(s.outcome, 'timeup'); ok(s.frozen(now), '«ВРЕМЯ ВЫШЛО» — бой застыл');
  eq(s.frame(now + 200, { time: 60.01 }), null);
  eq(s.frame(now + 1 + CHALLENGE.timeUpMs, { time: 60.01 }), 'show');
  eq(s.phase, 'done'); eq(s.timeLeft(), 0);
  s.disarm(); eq(s.phase, 'off');
});
test('победа раньше конца минуты: секунды в запасе — в очки', () => {
  const s = createChallengeSession();
  s.arm(); s.begin(0, { time: 0 }); s.frame(CHALLENGE.countdownMs + 1, { time: 0 });
  ok(s.end('victory', { time: 42.4 }));
  eq(s.phase, 'done'); eq(s.outcome, 'victory');
  ok(!s.end('defeat', { time: 50 }), 'итог фиксируется один раз');
  const t = createTally(); t.reset({ time: 0, stats: { damageDealt: 0 } });
  const r = buildResult({ tally: t, snap: { status: 'victory', time: 42.4, stats: { damageDealt: 700 } }, coach: { accuracy: 90, good: 20, mistakes: 2, groups: [] }, session: s, kind: 'challenge' });
  eq(r.outcome, 'victory'); ok(r.won);
  eq(Math.round(r.elapsed), 42);
  eq(r.parts.find((p) => p.id === 'victory').points, SCORE.victory + 17 * SCORE.perSecondLeft);
  eq(r.rank, 'S');
});
test('итог обычного боя (для постера) — без таймера и зала', () => {
  const t = createTally(); t.reset({ time: 0, stats: { damageDealt: 0 } });
  const r = buildResult({ tally: t, snap: { status: 'defeat', time: 95, stats: { damageDealt: 260 } }, coach: null, kind: 'fight' });
  eq(r.kind, 'fight'); eq(r.outcome, 'defeat'); eq(r.elapsed, 95); eq(r.damage, 260);
  ok(!r.parts.some((p) => p.id === 'victory'));
});

// ───────── постер ─────────
// Заглушка 2D-контекста: записывает вызовы, проверяет числа на конечность
function stubCtx() {
  const calls = {};
  const bad = [];
  const grad = () => ({ addColorStop(o, c) { if (!Number.isFinite(o) || o < 0 || o > 1 || typeof c !== 'string') bad.push(`stop ${o} ${c}`); } });
  const state = { font: '10px sans', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, textAlign: 'left', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '', lineCap: 'butt', lineJoin: 'miter' };
  const base = {
    createLinearGradient: grad, createRadialGradient: (...a) => { if (a.some((v) => !Number.isFinite(v)) || a[2] < 0 || a[5] < 0) bad.push(`radial ${a}`); return grad(); },
    measureText: (t) => ({ width: String(t).length * (parseFloat(/(\d+)px/.exec(state.font)?.[1]) || 10) * 0.55 }),
  };
  return {
    calls, bad,
    ctx: new Proxy(state, {
      get(t, k) {
        if (k in base) { calls[k] = (calls[k] || 0) + 1; return base[k]; }
        if (k in t) return t[k];
        return (...args) => {
          calls[k] = (calls[k] || 0) + 1;
          for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${String(k)}(${args.join(',')})`);
        };
      },
      set(t, k, v) { t[k] = v; return true; },
    }),
  };
}
function withWarnings(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return warns;
}
const FULL = {
  kind: 'challenge', outcome: 'timeup', score: 8450, rank: 'A', rankTitle: 'Мастер клятвы', name: 'АНЯ', place: 2, total: 7, isRecord: false,
  bestGesture: { title: '«OK» · снаряд', good: 14 }, accuracy: 87, damage: 520, maxCombo: 24, elapsed: 60,
  heroName: 'Пепельный страж', heroCls: 'Воин-маг · Пепел и пламя', art: { width: 760, height: 428 }, skeleton: demoSkeleton(), date: NOW,
};
test('постер рисуется без ошибок: полный набор данных', () => {
  const { ctx, calls, bad } = stubCtx();
  const warns = withWarnings(() => drawPoster(ctx, FULL));
  eq(warns.length, 0, `без предупреждений: ${warns.join(' | ')}`);
  eq(bad.length, 0, `числа конечны: ${bad.slice(0, 3).join(' | ')}`);
  eq(calls.drawImage, 1, 'арт героя — кадр боя');
  ok(calls.lineTo > 20, 'линии скелета');
  ok(calls.fillText > 15, 'надписи');
  ok(calls.fillRect > 33 * 4, 'модули QR');
  eq(POSTER_W, 1200); eq(POSTER_H, 630);
});
test('постер рисуется без ошибок: пустые и кривые данные, без арта и скелета', () => {
  for (const d of [{}, null, undefined, { score: NaN, rank: 42, accuracy: 'x', art: { width: 0, height: 0 }, skeleton: { pose: [null, 5, { x: 'a' }], hands: [[1, 2]] } }, { kind: 'fight', outcome: 'victory', elapsed: 151, score: 15000, rank: 'S', isRecord: true, skeleton: { pose: new Array(33).fill({ x: 0.5, y: 0.5 }) } }]) {
    const { ctx, calls, bad } = stubCtx();
    const warns = withWarnings(() => drawPoster(ctx, d));
    eq(warns.length, 0, `без предупреждений: ${warns.join(' | ')}`);
    eq(bad.length, 0, `числа конечны: ${bad.slice(0, 3).join(' | ')}`);
    ok((calls.drawImage || 0) === 0, 'без арта — нарисованное небо');
    ok(calls.fillText > 10);
  }
});
test('скелет из позы и кистей: только координаты, зеркально как превью, невидимые точки отброшены', () => {
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.5, z: -0.3, visibility: i === 5 ? 0.1 : 0.9 }));
  const hands = { left: { landmarks: Array.from({ length: 21 }, () => ({ x: 0.3, y: 0.6, z: 0 })), shape: 'pinch' }, right: null };
  const sk = skeletonFromVision({ landmarks: lm, mirror: true, frameW: 640, frameH: 480, tMs: 1 }, hands);
  eq(sk.pose.length, 33);
  ok(Math.abs(sk.pose[0].x - 0.8) < 1e-9, 'зеркально');
  eq(sk.pose[5], null, 'невидимая точка');
  ok(!('z' in sk.pose[0]) && !('visibility' in sk.pose[0]), 'только x, y');
  eq(sk.hands.length, 1); ok(Math.abs(sk.aspect - 4 / 3) < 1e-9);
  eq(skeletonFromVision(null, null), null);
  const { ctx, bad } = stubCtx();
  eq(withWarnings(() => drawPoster(ctx, { ...FULL, skeleton: sk })).length, 0);
  eq(bad.length, 0);
});
test('имя файла постера', () => {
  const n = posterFileName({ name: 'АНЯ', score: 8450.4, date: NOW });
  eq(n, 'ashen-oath-АНЯ-8450-20261002-1530.png');
  ok(/^ashen-oath-0-\d{8}-\d{4}\.png$/.test(posterFileName({})));
});

// ───────── QR ─────────
const gmul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; };
// Читает матрицу обратно: формат (BCH), маска, кодовые слова змейкой; карта служебных модулей — по стандарту.
function readQr(M) {
  const size = M.length, ver = (size - 17) / 4;
  const F = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) F[y][x] = true; };
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(pos[i] + dx, pos[j] + dy);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); mark(8, size - 1 - i); }
  if (ver >= 7) for (let i = 0; i < 18; i++) { mark(size - 11 + (i % 3), Math.floor(i / 3)); mark(Math.floor(i / 3), size - 11 + (i % 3)); }
  let fmt = 0;
  const fb = [];
  for (let i = 0; i <= 5; i++) fb.push(M[i][8]);
  fb.push(M[7][8], M[8][8], M[8][7]);
  for (let i = 9; i < 15; i++) fb.push(M[8][14 - i]);
  fb.forEach((b, i) => { if (b) fmt |= 1 << i; });
  const d = fmt ^ 0x5412, data5 = d >>> 10;
  let r = data5; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  const bchOk = (r & 0x3ff) === (d & 0x3ff);
  const ecl = data5 >>> 3, mask = data5 & 7;
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (!F[y][x]) bits.push(M[y][x] !== MASKS[mask](x, y));
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ? 1 : 0); words.push(b); }
  return { ver, ecl, mask, bchOk, words };
}
// [ecl][ver] из стандарта (ISO/IEC 18004, табл. 9) для версий 1–10 — независимо от posterCard.js
const STD = { M: { per: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] }, L: { per: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18], blocks: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4] } };
const ECL_BITS = { L: 1, M: 0 };
function checkRoundTrip(text, ecl) {
  const M = qrMatrix(text, ecl);
  const q = readQr(M);
  ok(q.bchOk, 'формат-биты: код БЧХ');
  eq(q.ecl, ECL_BITS[ecl], 'уровень коррекции');
  const per = STD[ecl].per[q.ver], nb = STD[ecl].blocks[q.ver];
  let raw = (16 * q.ver + 128) * q.ver + 64; if (q.ver >= 2) { const n = Math.floor(q.ver / 7) + 2; raw -= (25 * n - 10) * n - 55; if (q.ver >= 7) raw -= 36; }
  const total = Math.floor(raw / 8), nShort = nb - (total % nb), shortLen = Math.floor(total / nb);
  // обратное чередование блоков
  const blocks = Array.from({ length: nb }, (_, j) => ({ len: shortLen + (j < nShort ? 0 : 1), w: [] }));
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) for (let j = 0; j < nb; j++) {
    const b = blocks[j];
    if (i < b.len - per) b.w[i] = q.words[k++];   // сначала байты данных по очереди из каждого блока
  }
  for (let i = 0; i < per; i++) for (let j = 0; j < nb; j++) { const b = blocks[j]; b.w[b.len - per + i] = q.words[k++]; }
  // синдромы Рида — Соломона: кодовое слово делится на порождающий многочлен (корни α^0…α^(n−1))
  for (const b of blocks) {
    for (let s = 0, a = 1; s < per; s++, a = gmul(a, 2)) {
      let acc = 0;
      for (const w of b.w) acc = gmul(acc, a) ^ w;
      eq(acc, 0, `синдром ${s} блока`);
    }
  }
  const data = blocks.flatMap((b) => b.w.slice(0, b.len - per));
  const dec = decodeSegments(data, q.ver);
  eq(dec.modes[0], 4, 'режим «байты»');
  eq(dec.text, text, 'текст');
  return { M, q, data };
}
// Сегменты данных: цифры (1), буквы-цифры (2), байты (4), конец (0)
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function decodeSegments(data, ver) {
  const bits = data.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >>> (7 - i)) & 1));
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (bits.length ? bits.shift() : 0); return v; };
  const bytes = [], modes = [];
  while (bits.length >= 4) {
    const mode = take(4);
    if (mode === 0) break;
    modes.push(mode);
    if (mode === 4) { const n = take(ver <= 9 ? 8 : 16); for (let i = 0; i < n; i++) bytes.push(take(8)); }
    else if (mode === 2) { let n = take(ver <= 9 ? 9 : 11); for (; n >= 2; n -= 2) { const v = take(11); bytes.push(ALNUM.charCodeAt(Math.floor(v / 45)), ALNUM.charCodeAt(v % 45)); } if (n) bytes.push(ALNUM.charCodeAt(take(6))); }
    else if (mode === 1) { let n = take(ver <= 9 ? 10 : 12); for (; n >= 3; n -= 3) bytes.push(...String(take(10)).padStart(3, '0').split('').map((c) => c.charCodeAt(0))); if (n === 2) bytes.push(...String(take(7)).padStart(2, '0').split('').map((c) => c.charCodeAt(0))); if (n === 1) bytes.push(String(take(4)).charCodeAt(0)); }
    else throw new Error(`неизвестный режим ${mode}`);
  }
  return { text: Buffer.from(bytes).toString('utf8'), modes };
}
test('QR: формат, коррекция Рида — Соломона и обратное чтение — версии 1…10', () => {
  const vers = new Set();
  for (const t of ['A', GAME_URL, `${GAME_URL}?challenge`, 'Испытание · 60 с — побей мой рекорд!', 'x'.repeat(150), 'ж'.repeat(105)]) {
    const r = checkRoundTrip(t, 'M');
    vers.add(r.q.ver);
    eq(r.M.length, r.q.ver * 4 + 17);
  }
  checkRoundTrip(GAME_URL, 'L');
  ok(vers.has(1) && vers.has(4) && [...vers].some((v) => v >= 7), `версии: ${[...vers]}`);
  let threw = false; try { qrMatrix('x'.repeat(400)); } catch (e) { threw = true; } ok(threw, 'слишком длинный текст — ошибка');
});
test('QR на игру: раскладка модулей сверена с независимым QR из pitch/index.html', () => {
  const html = readFileSync(new URL('../pitch/index.html', import.meta.url), 'utf8');
  const m = /viewBox="0 0 41 41"[^>]*>.*?<path fill="#15120f" d="([^"]+)"/s.exec(html);
  ok(m, 'QR в презентации');
  const G = Array.from({ length: 41 }, () => new Array(41).fill(false));
  for (const r of m[1].matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) for (let i = 0; i < +r[3]; i++) G[+r[2]][+r[1] + i] = true;
  const ref = readQr(G.slice(4, 37).map((row) => row.slice(4, 37)));
  const mine = checkRoundTrip(GAME_URL, 'M');
  ok(ref.bchOk); eq(ref.ver, mine.q.ver, 'версия'); eq(ref.ecl, mine.q.ecl, 'уровень');
  // чтение независимого QR тем же разбором (служебные модули, змейка, маска) даёт верные блоки Рида — Соломона и адрес:
  // значит, раскладка модулей у posterCard.js совпадает со стандартом. Сегменты у эталона другие («STUTU/» —
  // буквенно-цифровым режимом), поэтому сравнивается текст, а не байты.
  const refData = [], b0 = [], b1 = [];
  for (let i = 0; i < 32; i++) { b0.push(ref.words[2 * i]); b1.push(ref.words[2 * i + 1]); }
  for (let i = 0; i < 18; i++) { b0.push(ref.words[64 + 2 * i]); b1.push(ref.words[64 + 2 * i + 1]); }
  for (const b of [b0, b1]) for (let s = 0, a = 1; s < 18; s++, a = gmul(a, 2)) { let acc = 0; for (const w of b) acc = gmul(acc, a) ^ w; eq(acc, 0, 'синдром эталона'); }
  refData.push(...b0.slice(0, 32), ...b1.slice(0, 32));
  eq(decodeSegments(refData, ref.ver).text, GAME_URL, 'эталон читается тем же разбором');
  eq(decodeSegments(mine.data, mine.q.ver).text, GAME_URL, 'наш QR — тот же адрес');
});

console.log(`\n${fail ? 'ЕСТЬ ОШИБКИ' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'}: ${pass} пройдено, ${fail} с ошибкой`);
if (fail) process.exit(1);
