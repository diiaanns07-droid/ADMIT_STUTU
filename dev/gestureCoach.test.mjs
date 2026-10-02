// Тесты core/gestureCoach.js: метаданные подсказок, getActiveHint, точность по жестам, топ-3, история боёв.
// node dev/gestureCoach.test.mjs
import {
  COACH_HINTS, COACH_GROUPS, hintInfo, hintPictogram, createHintTracker, noteHint, getActiveHint, clearActiveHint,
  createCoachStats, createCoachHistory, compactSummary, compareCoach, HINT_SHOW_MS,
} from '../core/gestureCoach.js';
import { readFileSync } from 'node:fs';
import { createDebugInput } from '../core/debugInput.js';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); } catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

test('44 подсказки, у каждой — жест, текст, исправление, рука, точки, пиктограмма', () => {
  const codes = Object.keys(COACH_HINTS);
  eq(codes.length, 44, 'число подсказок'); // + hand_far_stand («Новичок»: игра стоя)
  for (const code of codes) {
    const e = COACH_HINTS[code];
    ok(e.gesture && e.text && e.fix && e.mark, `${code}: тексты`);
    ok(e.fix.length <= 28, `${code}: fix длинный (${e.fix.length})`);
    ok(e.mark.length <= 14, `${code}: метка длинная`);
    ok(COACH_GROUPS[e.group], `${code}: группа ${e.group}`);
    ok(e.hand === null || ['left', 'right', 'both'].includes(e.hand), `${code}: рука ${e.hand}`);
    ok(Array.isArray(e.landmarks) && e.landmarks.every((i) => Number.isInteger(i) && i >= 0 && i <= 20), `${code}: точки`);
    ok(e.links.every((l) => l.length === 2 && l.every((i) => i >= 0 && i <= 20)), `${code}: связи`);
    ok(code === 'hands_missing' || e.landmarks.length > 0, `${code}: без точек`);
    eq(e.pictogram, code, `${code}: id пиктограммы`);
    const svg = hintPictogram(code);
    ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), `${code}: SVG`);
    eq(hintInfo(code), e, 'hintInfo');
  }
  ok(Object.isFrozen(COACH_HINTS) && Object.isFrozen(COACH_HINTS.ok_ring_open) && Object.isFrozen(COACH_HINTS.ok_ring_open.landmarks), 'заморожено');
  eq(hintInfo('нет такого'), null, 'неизвестный код');
});

test('каждый код, который выдают распознаватели, есть в COACH_HINTS', () => {
  const src = ['core/handGestures.js', 'core/bowGesture.js', 'core/handMagic.js', 'core/handZone.js', 'core/debugInput.js']
    .map((f) => { try { return readFileSync(new URL('../' + f, import.meta.url), 'utf8'); } catch (e) { return ''; } }).join('\n');
  const used = new Set();
  for (const m of src.matchAll(/hint\('([a-z_]+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/code:\s*'([a-z_]+)'/g)) if (/^(bow|spell)_/.test(m[1])) used.add(m[1]);
  const dbg = src.match(/DEMO_HINTS = \[([^\]]+)\]/);
  if (dbg) for (const m of dbg[1].matchAll(/'([a-z_]+)'/g)) used.add(m[1]);
  ok(used.size >= 20, 'нашлось мало кодов: ' + [...used].join(','));
  for (const c of used) ok(COACH_HINTS[c], `код ${c} без текста`);
});

test('«OK»: рука правая, точки 4 и 8, связь 4–8, метка «СОМКНИ»', () => {
  const e = COACH_HINTS.ok_ring_open;
  eq(e.hand, 'right'); eq(JSON.stringify(e.landmarks), '[4,8]'); eq(JSON.stringify(e.links), '[[4,8]]'); eq(e.mark, 'СОМКНИ');
  eq(COACH_HINTS.shield_palm.hand, 'left'); eq(COACH_HINTS.orb_facing.hand, 'both');
});

test('трекер: подсказка живёт HINT_SHOW_MS, повтор того же импульса не продлевает, новая заменяет', () => {
  const tr = createHintTracker();
  eq(tr.active(0), null, 'пусто');
  ok(!tr.note({ code: 'нет' }, 0), 'неизвестный код не принят');
  ok(tr.note({ code: 'ok_ring_open', side: 'right', tMs: 100 }, 1000), 'принят');
  const a = tr.active(1500);
  eq(a.code, 'ok_ring_open'); eq(a.hand, 'right'); eq(JSON.stringify(a.landmarks), '[4,8]');
  ok(a.text && a.fix && a.mark && a.gesture, 'тексты');
  ok(a.pictogram.startsWith('<svg') && a.pictogramId === 'ok_ring_open', 'пиктограмма');
  ok(a.life > 0.8 && a.life <= 1 && a.ageMs === 500, 'жизнь');
  ok(!tr.note({ code: 'ok_ring_open', side: 'right', tMs: 100 }, 3000), 'тот же импульс');
  eq(tr.active(1000 + HINT_SHOW_MS + 1), null, 'истекла');
  tr.note({ code: 'shield_palm', side: null, tMs: 200 }, 6000);
  eq(tr.active(6100).hand, 'left', 'рука из записи, если side нет');
  tr.note({ code: 'hand_edge', side: 'right', tMs: 300 }, 7000);
  eq(tr.active(7100).hand, 'right', 'сторона распознавателя важнее');
  tr.clear(); eq(tr.active(7100), null, 'clear');
});

test('общий трекер noteHint / getActiveHint', () => {
  clearActiveHint();
  eq(getActiveHint(10), null);
  noteHint({ code: 'orb_dy', tMs: 5 }, 10);
  eq(getActiveHint(20).code, 'orb_dy');
  eq(getActiveHint(20).hand, 'both');
  clearActiveHint();
});

test('статистика: точность по жестам, «OK» и щит считаются, топ-3 по частоте', () => {
  const s = createCoachStats();
  for (let i = 0; i < 6; i++) s.success('attack');
  for (let i = 0; i < 2; i++) s.mistake('ok_ring_open');
  s.mistake('ok_fingers');
  s.success('shield'); s.mistake('shield_push'); s.mistake('shield_push'); s.mistake('shield_palm');
  s.mistake('hand_edge'); s.mistake('hand_edge'); s.mistake('hand_edge');
  s.success('bogus'); s.mistake('bogus');
  const r = s.summary();
  eq(r.good, 7); eq(r.mistakes, 9); eq(r.accuracy, Math.round(7 / 16 * 100));
  const g = Object.fromEntries(r.groups.map((x) => [x.id, x]));
  eq(g.ok.accuracy, Math.round(6 / 9 * 100), '«OK»'); eq(g.ok.good, 6); eq(g.ok.mistakes, 3);
  eq(g.shield.accuracy, 25, 'щит');
  ok(!g.frame, 'кадр без столбика');
  eq(r.top3.length, 3);
  eq(r.top3[0].code, 'hand_edge'); eq(r.top3[0].count, 3);
  ok(r.top3[0].fix && r.top3[0].text && r.top3[0].gesture, 'совет в топе');
  eq(r.top.code, 'hand_edge');
  s.reset();
  const z = s.summary();
  eq(z.accuracy, null); eq(z.groups.length, 0); eq(z.top3.length, 0); eq(z.top, null);
});

test('при равной частоте ошибка жеста выше ошибки кадра', () => {
  const s = createCoachStats();
  s.mistake('hand_far'); s.mistake('ok_ring_open');
  eq(s.summary().top3[0].code, 'ok_ring_open');
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('история: первый бой без сравнения, второй сравнивается с первым', () => {
  const st = memStorage();
  const h = createCoachHistory(st);
  const a = createCoachStats();
  for (let i = 0; i < 3; i++) a.success('attack');
  for (let i = 0; i < 3; i++) a.mistake('ok_ring_open');
  const s1 = a.summary();
  eq(h.push(s1, 1000), null, 'первый бой');
  eq(compareCoach(s1, null), null);
  const b = createCoachStats();
  for (let i = 0; i < 8; i++) b.success('attack');
  b.mistake('ok_ring_open'); b.mistake('ok_ring_open');
  const s2 = b.summary();
  const prev = h.push(s2, 2000);
  eq(prev.accuracy, 50, 'прошлый бой');
  const c = compareCoach(s2, prev);
  eq(c.accuracyDelta, 30, 'рост точности'); eq(c.prevAccuracy, 50);
  eq(c.groups.ok, 30, 'рост по «OK»');
  eq(c.prevTop, 'ok_ring_open');
  eq(h.list().length, 2); eq(h.last().accuracy, 80);
  // пустой бой не портит историю
  eq(h.push(createCoachStats().summary(), 3000).accuracy, 80);
  eq(h.list().length, 2);
});

test('история: не больше 12 записей; битое и недоступное хранилище не бросают', () => {
  const st = memStorage();
  const h = createCoachHistory(st);
  const s = createCoachStats(); s.success('rune'); s.mistake('rune_open');
  for (let i = 0; i < 20; i++) h.push(s.summary(), i);
  eq(h.list().length, 12);
  st.setItem('ashen-oath.coach.v1', '{не json');
  eq(h.list().length, 0); eq(h.last(), null);
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const hb = createCoachHistory(bad);
  eq(hb.push(s.summary(), 1), null); eq(hb.last(), null);
  const hn = createCoachHistory(null);
  eq(hn.push(s.summary(), 1), null);
  eq(compactSummary(null), null);
  eq(compactSummary(s.summary(), 5).groups.rune, 50);
});

test('отладка: H по кругу листает все 44 подсказки, первая — «OK»', () => {
  const L = {};
  const target = { addEventListener: (t, f) => { (L[t] || (L[t] = [])).push(f); }, removeEventListener() {} };
  const dbg = createDebugInput(target);
  dbg.setEnabled(true);
  const seen = [];
  for (let i = 0; i < 45; i++) {
    for (const f of L.keydown) f({ code: 'KeyH', key: 'h', repeat: false, target: null, preventDefault() {} });
    for (const f of L.keyup || []) f({ code: 'KeyH', key: 'h', target: null, preventDefault() {} });
    const fr = dbg.read();
    ok(fr.hint && COACH_HINTS[fr.hint.code], 'нет подсказки на H #' + i);
    seen.push(fr.hint.code);
  }
  eq(seen[0], 'ok_ring_open', 'первая');
  eq(new Set(seen.slice(0, 44)).size, 44, 'все коды');
  eq(seen[44], seen[0], 'по кругу');
});

for (const line of out) console.log(line);
console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
