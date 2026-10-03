// [W5-СВЕТ] Дымка витрины: что держит героя в белой пелене — опыт «выключить и сравнить» на одном кадре.
//   node tools/hero_haze_ab.mjs [--quality high] [--heroes elf,dark] [--root DIR] [--out DIR]
// Витрина меню, герой отыграл появление (2,5 с виртуального времени), затем один и тот же кадр с выключенным:
//   base      — как в игре;
//   noDof     — без глубины резкости меню (BokehPass: прозрачное — мягкая кромка волос, накидки — проход
//               глубины пропускает, такие пиксели размываются по глубине фона за ними);
//   noSoft    — без мягкой кромки волос (hair-soft) при DOF;
//   noBloom   — без bloom (setBloomK(0) — порог высоко, сила 0);
//   noStage   — без сцены витрины (портал, частицы, пол).
// Подмена в браузере (только этот опыт): main.js отдаёт объект postfx в window.__pf, postfx.js слушает window.__noDof.
// Метрики — tools/hero_glow.mjs (рамка героя, лицо, фон).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HERE, args, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame } from './visual_common.mjs';
import { HERO_RECTS, METRICS } from './hero_glow.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const Q = A.of('--quality', 'high');
const HEROES = A.of('--heroes', 'elf,dark').split(',').filter(Boolean);
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'hero-glow', 'haze-ab')));
const [W, H] = A.of('--size', '1366x768').split('x').map(Number);
const T0 = Date.now();
const log = (m) => console.error(`[hero_haze_ab ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
mkdirSync(OUT, { recursive: true });

const { chromium } = loadPlaywright();
const server = await startServer(ROOT);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
const res = {};

// маршруты подмены ставятся до загрузки страницы
async function openPatched(h) {
  const routes = async (ctx) => {
    await ctx.route(/\/main\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace('postfx = m.createPostFX(', 'postfx = window.__pf = m.createPostFX(');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
    await ctx.route(/\/core\/postfx\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      const body = (await r.text())
        .replace("pass.enabled = S.mode === 'menu';", "pass.enabled = S.mode === 'menu' && !window.__noDof;")
        .replace('if (P.dof) P.dof.enabled = want;', 'if (P.dof) P.dof.enabled = want && !window.__noDof;');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
  };
  return openGame(browser, server, { size: [480, 270], settings: { quality: Q, hero: h }, log: (m) => log(`${h}: ${m}`), beforeGoto: routes });
}

async function measure(g, name, h) {
  const { page } = g;
  await page.setViewportSize({ width: W, height: H });
  await g.step(4);
  const rects = await page.evaluate(HERO_RECTS);
  const png = await page.screenshot({ type: 'png' });
  const m = await page.evaluate(METRICS, { b64: png.toString('base64'), rects });
  await page.screenshot({ path: join(OUT, `${Q}_${h}_${name}.jpg`), type: 'jpeg', quality: 84 });
  await page.setViewportSize({ width: 480, height: 270 });
  log(`${h} ${name}: пересвет ${(m.over * 100).toFixed(1)} %, средняя ${m.heroMean}, лицо ${m.face} (σ ${m.faceSd}), фон ${m.bg}`);
  return m;
}

try {
  for (const h of HEROES) {
    const g = await openPatched(h);
    const { page } = g;
    await g.virtual(true);
    await page.mouse.move(470, 4);
    await g.step(75);
    await g.hideUi(true);
    const r = (res[h] = {});
    r.base = await measure(g, 'base', h);
    await page.evaluate(() => { window.__noDof = true; });
    r.noDof = await measure(g, 'noDof', h);
    await page.evaluate(() => { window.__noDof = false; });
    await page.evaluate(() => { const sc = window.__vb.probe.scene; sc.traverse((o) => { if (o.material && o.material.name === 'hair-soft') { o.userData.vbVis = o.visible; o.visible = false; } }); });
    r.noSoft = await measure(g, 'noSoft', h);
    await page.evaluate(() => { const sc = window.__vb.probe.scene; sc.traverse((o) => { if (o.material && o.material.name === 'hair-soft' && o.userData.vbVis != null) o.visible = o.userData.vbVis; }); });
    await page.evaluate(() => { const p = window.__pf; if (p) { p.__bk = 1; p.setBloomK(0); } });
    r.noBloom = await measure(g, 'noBloom', h);
    await page.evaluate(() => { const p = window.__pf; if (p) p.setBloomK(1); });
    // сцена витрины каждый кадр включает свой корень — гасим материалы
    await page.evaluate(() => { const st = window.__vb.probe.scene.getObjectByName('menu-stage'); if (st) st.traverse((o) => { if (o.material && o.material.visible) { o.material.visible = false; o.userData.vbOff = true; } }); });
    r.noStage = await measure(g, 'noStage', h);
    await page.evaluate(() => { const st = window.__vb.probe.scene.getObjectByName('menu-stage'); if (st) st.traverse((o) => { if (o.userData.vbOff) { o.material.visible = true; delete o.userData.vbOff; } }); });
    r.errors = g.errors.slice(0, 5);
    await g.ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
writeFileSync(join(OUT, `${Q}.json`), JSON.stringify(res, null, 1));
