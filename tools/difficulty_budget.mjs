// [W5-СЛОЖНОСТЬ] Бюджет кадра на самых тяжёлых сценах новых уровней («Кошмар»): залп из 4 сфер и «Каменный капкан»
// (3 круга удара). Замер как в tools/visual_budget.mjs (1366×768, виртуальное время, тот же зонд рендера), сравнение
// с config.visualBudget (предел уровня качества + предел боя). Visual budget меряет сцены на «Лёгкой» — этот замер
// добавляет к нему новые приёмы Регента.
// node tools/difficulty_budget.mjs [--q low,medium,high] [--json путь]
import { writeFileSync } from 'node:fs';
import { HERE, args, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame, summarize } from './visual_common.mjs';
import { config } from '../config.js';

const A = args();
const QS = String(A.of('--q', 'low,medium,high')).split(',');
const JSON_OUT = A.of('--json', null);
const SIZE = [1366, 768];
const log = (m) => console.log(m);
const { chromium } = loadPlaywright();
const server = await startServer(HERE);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--chromium', null)));
const res = {};
const over = [];

try {
  for (const q of QS) {
    const g = await openGame(browser, server, { size: SIZE, settings: { quality: q, hero: 'ashen', difficulty: 'nightmare' }, patch: { levels: { nightmare: { bossHp: 4, bossDamage: 0 } } }, log: (m) => log(`${q}: ${m}`) });
    res[q] = {};
    try {
      await g.toBattle();
      await g.walkToBoss();
      await g.page.keyboard.down('KeyJ');   // огонь: на сцене и снаряды героя
      for (const [id, move] of [['nightmare_volley', 'volley'], ['nightmare_trap', 'trap']]) {
        const w = await g.stepUntil(`(s) => s && s.telegraphs.some((t) => t.move === '${move}')`, { max: 900, ms: 100 });
        if (!w.ok) { log(`${q} ${id}: не дождались приёма`); continue; }
        // окно: от замаха до разлёта сфер / удара кругов (+ эффекты удара)
        const frames = await g.sample(60);
        const r = summarize(frames);
        res[q][id] = r;
        const B = config.visualBudget[q], lim = { ...B, ...(B.battle || {}) };
        for (const k of ['calls', 'triangles', 'lights', 'shadowLights', 'textures', 'programs', 'particles', 'jsMs']) {
          if (Number.isFinite(lim[k]) && Number.isFinite(r[k]) && r[k] > lim[k]) over.push({ q, id, k, value: r[k], limit: lim[k] });
        }
        log(`${q} ${id}: вызовов ${r.calls}/${lim.calls}, треугольников ${r.triangles}/${lim.triangles}, свет ${r.lights}/${lim.lights}, частиц ${r.particles}/${lim.particles}, JS ${r.jsMs}/${lim.jsMs} мс`);
      }
      await g.page.keyboard.up('KeyJ');
      if (g.errors.length) log(`${q}: ошибки страницы: ${g.errors.slice(0, 3).join(' | ')}`);
    } finally { await g.ctx.close(); }
  }
} finally {
  await browser.close();
  server.kill();
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ res, over }, null, 1));
console.log(over.length ? `ПРЕВЫШЕНИЯ: ${JSON.stringify(over)}` : 'превышений бюджета нет');
if (over.length) process.exitCode = 1;
