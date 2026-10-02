// node dev/visualBudget.test.mjs — [W4-БЮДЖЕТ] таблица бюджета кадра против пределов config.visualBudget.
// Таблицу docs/visual-budget.json пишет tools/visual_budget.mjs (headless-прогон всех сцен на low/medium/high).
// Тест падает, если сцена превысила бюджет своего уровня, если таблица неполная (сцена не снялась — её цена
// неизвестна) или если пределы уровней противоречат друг другу (low дороже high, low со светом сверх нормы).
// После правок визуала: node tools/visual_budget.mjs → этот тест. Новые цифры выше бюджета — сначала
// удешевить на low/medium; поднимать предел — только осознанно, в том же PR и с объяснением.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { SCENARIOS, QUALITIES, checkBudget } from '../tools/visual_common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(v, msg) { if (!v) throw new Error(msg || 'ожидалось истинное значение'); }

const KEYS = ['calls', 'triangles', 'lights', 'shadowLights', 'textures', 'programs', 'particles', 'jsMs'];
const B = config.visualBudget;
const file = join(ROOT, 'docs', 'visual-budget.json');
const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

test('config.visualBudget: пределы для low, medium, high', () => {
  ok(B && typeof B === 'object', 'нет раздела visualBudget в config.js');
  for (const q of QUALITIES) {
    ok(B[q], `нет уровня ${q}`);
    for (const k of KEYS) ok(Number.isFinite(B[q][k]) && B[q][k] >= 0, `${q}.${k} — не число`);
    if (B[q].menu) for (const k of Object.keys(B[q].menu)) ok(Number.isFinite(B[q].menu[k]), `${q}.menu.${k} — не число`);
  }
});

test('пределы уровней согласованы: low ≤ medium ≤ high', () => {
  for (const k of ['calls', 'triangles', 'lights', 'shadowLights', 'particles']) {
    ok(B.low[k] <= B.medium[k] && B.medium[k] <= B.high[k], `${k}: low ${B.low[k]}, medium ${B.medium[k]}, high ${B.high[k]}`);
  }
  // low — «почти бесплатно»: без теней и без новых источников света сверх нынешних
  ok(B.low.shadowLights === 0, `low: тени должны быть выключены (shadowLights ${B.low.shadowLights})`);
});

test('таблица docs/visual-budget.json есть и снята инструментом', () => {
  ok(data, 'нет docs/visual-budget.json — запустите node tools/visual_budget.mjs');
  ok(data.tool === 'tools/visual_budget.mjs' && data.results, 'файл не от tools/visual_budget.mjs');
  ok(!data.only || !data.only.length, `таблица снята частично (--only ${data.only}) — для репозитория нужен полный прогон`);
});

test('таблица полная: каждая сцена на каждом уровне', () => {
  const miss = [];
  for (const q of QUALITIES) {
    const R = data.results[q];
    if (!R) { miss.push(`${q}: весь уровень`); continue; }
    for (const s of SCENARIOS) {
      const r = R[s.id];
      if (!r || !(r.frames > 0) || !Number.isFinite(r.calls) || !Number.isFinite(r.triangles)) miss.push(`${q}/${s.id}`);
    }
  }
  ok(!miss.length, 'нет замера: ' + miss.join(', '));
});

test('сцены в пределах бюджета своего уровня', () => {
  const over = checkBudget(data.results, B);
  ok(!over.length, over.map((o) => `${o.quality} · ${o.scene} · ${o.key}: ${o.value} > ${o.limit}`).join('; '));
});

test('прогон без ошибок страницы и без пропущенных этапов', () => {
  const bad = [];
  for (const q of QUALITIES) {
    const R = data.results[q] || {};
    for (const n of R.__notes || []) bad.push(`${q}: ${n}`);
    for (const e of [...(R.__errorsA || []), ...(R.__errorsB || [])]) bad.push(`${q}: ${e}`);
  }
  ok(!bad.length, bad.slice(0, 6).join('; '));
});

test('сценарии действительно сыграли: заклинания сработали, «Небесный суд» начался', () => {
  for (const q of QUALITIES) {
    const R = data.results[q];
    const casts = SCENARIOS.filter((s) => s.group === 'battle' && s.id !== 'battle_phase1');
    // сработало: герой был в «cast», энергия провалилась или Регент получил урон («начало» энергию возвращает)
    const idle = casts.filter((s) => R[s.id] && !R[s.id].cast && !(R[s.id].energyUsed > 0) && !(R[s.id].damage > 0)).map((s) => s.id);
    ok(idle.length <= 1, `${q}: заклинание не сработало: ${idle.join(', ')}`);
    ok(R.ult && R.ult.cine === true, `${q}: сцена «Небесного суда» не началась`);
  }
});

let passed = 0, failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`PASS ${t.name}`); }
  catch (e) { failed++; console.log(`FAIL ${t.name}\n     ${String((e && e.message) || e)}`); }
}
console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено.`);
process.exitCode = failed ? 1 : 0;
