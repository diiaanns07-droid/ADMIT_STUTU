// [W5-СВЕТ] Дымка витрины после выбора героя: почему эльфийка долго «в белом», а другие герои уже чёткие.
//   node tools/hero_haze.mjs [--quality medium] [--heroes elf,dark,ranger,archmage,ashen] [--root DIR] [--out FILE.json]
// Каждый герой: щелчок по карточке (настоящее время, как у игрока), «готов» → кадры по одному на виртуальных
// часах (1/30 с). На каждый кадр: настоящее время JS кадра (генерация текстур, сборка шейдеров — всё, что
// в игре на слабой видеокарте даёт кадр длиннее config.loop.stallSec = 0,25 с, а такой кадр игра считает
// разрывом и время витрины не двигает: dt = 0), число программ рендера, огибающие появления витрины.
// Итог: сколько «тяжёлых» кадров у каждого героя после «готов» и сколько секунд они идут.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERE, args, HERO_IDS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame } from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const Q = A.of('--quality', 'medium');
const HEROES = A.of('--heroes', 'elf,dark,ranger,archmage,ashen').split(',').filter(Boolean);
const FRAMES = +A.of('--frames', '240');
const OUT = A.of('--out', '');
const SIZE = A.of('--size', '480x270').split('x').map(Number);
const T0 = Date.now();
const log = (m) => console.error(`[hero_haze ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);

const { chromium } = loadPlaywright();
const server = await startServer(ROOT);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
const out = { quality: Q, size: SIZE.join('x'), heroes: {} };
try {
  // первый герой страницы — не из списка (страж; если он в списке — чародейка): каждый из списка грузится щелчком
  const g = await openGame(browser, server, { size: SIZE, settings: { quality: Q, hero: 'ashen' }, log });
  const { page } = g;
  for (const h of HEROES) {
    await g.virtual(false);
    const t0 = Date.now();
    await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click({ timeout: 240000 });
    await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { timeout: 240000, polling: 20 });
    const loadMs = Date.now() - t0;
    await g.virtual(true);
    const frames = await page.evaluate(async (n) => {
      const r = [];
      const P = window.__vb.probe;
      for (let i = 0; i < n; i++) {
        const js = await window.__vb.step(1000 / 30);
        const sc = window.__ASHEN__.heroShowcase();
        r.push({ js: Math.round(js), programs: P && P.renderer ? P.renderer.info.programs.length : null, w: sc ? +sc.weight.toFixed(2) : null });
      }
      return r;
    }, FRAMES);
    const heavy = frames.map((f, i) => ({ i, js: f.js })).filter((f) => f.js > 250);
    const lastHeavy = heavy.length ? heavy[heavy.length - 1].i : -1;
    const sumHeavy = heavy.reduce((s, f) => s + f.js, 0);
    out.heroes[h] = { loadMs, heavy: heavy.length, heavyMs: sumHeavy, lastHeavyFrame: lastHeavy, programs: [frames[0].programs, frames[frames.length - 1].programs], js: frames.map((f) => f.js) };
    log(`${h}: загрузка ${loadMs} мс; кадров > 250 мс JS после «готов»: ${heavy.length} (${sumHeavy} мс), последний — кадр ${lastHeavy}; программ ${frames[0].programs} → ${frames[frames.length - 1].programs}; первые кадры JS: ${frames.slice(0, 12).map((f) => f.js).join(' ')}`);
  }
  out.errors = g.errors.slice(0, 10);
  await g.ctx.close();
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
