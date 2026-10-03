// [W5-ПОЛ] Снимки стоп героев крупным планом: меню-витрина (каждый герой) и бой (покой у Регента, бег, после рывка),
// неподвижная камера у пола сбоку — видно, стоит ли подошва на полу или ушла в него. Для сравнения «до/после»:
// --root — папка игры (git worktree другой ветки), --tag — подпись файлов. Часы страницы — как tools/visual_common.mjs.
//   node tools/hero_feet_shots.mjs --out DIR --tag after [--root DIR] [--quality medium] [--heroes ashen,elf]
//                                  [--size 960x540] [--video] (ролик боя: бег, рывок, остановка — DIR/<tag>_battle.mp4)

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HERE, args, HERO_IDS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame } from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'screenshots', 'w5-ground')));
const TAG = A.of('--tag', 'shot');
const Q = A.of('--quality', 'medium');
const HEROES = (A.of('--heroes', HERO_IDS.join(',')) || '').split(',').filter((h) => HERO_IDS.includes(h));
const SIZE = A.of('--size', '960x540').split('x').map(Number);
const VIDEO = A.has('--video');
const T0 = Date.now();
const log = (m) => console.error(`[hero_feet_shots ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
mkdirSync(OUT, { recursive: true });

// камера у пола сбоку от героя: смотрит на стопы (fov узкий — крупный план)
async function feetCam(g, { side = 1, dist = 1.35, h = 0.3, fov = 30 } = {}) {
  const p = await g.heroPose();
  if (!p) return null;
  const [x, y, z] = p.pos, yaw = p.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
  const cx = x + (fx * 0.55 + rx * side) * dist, cz = z + (fz * 0.55 + rz * side) * dist;
  await g.setCam({ pos: [cx, y + h, cz], at: [x + fx * 0.05, y + 0.14, z + fz * 0.05], fov });
  return p;
}
// пока герой устраивается (секунды игрового времени), кадр не рисуем — программный рендер медленный; перед снимком — снова
const render = (page, on) => page.evaluate((v) => {
  const r = window.__vb.probe && window.__vb.probe.renderer;
  if (!r) return false;
  if (!r.__fsRender) r.__fsRender = r.render;
  r.render = v ? r.__fsRender : function () {};
  return true;
}, on);
const shot = async (page, name) => { await page.screenshot({ path: join(OUT, name), type: 'jpeg', quality: 88 }); log(`снимок ${name}`); };
const gapOf = (page) => page.evaluate(() => { const f = window.__ASHEN__.heroFeet ? window.__ASHEN__.heroFeet() : null; return f ? { gap: f.gap, sole: f.sole, floorL: f.floorL, floorR: f.floorR, hero: f.hero } : null; });

const { chromium } = loadPlaywright();
const server = await startServer(ROOT);
const browser = await launchBrowser(chromium, chromiumPath());
const report = { tag: TAG, quality: Q, root: ROOT, menu: {}, battle: {} };
try {
  // ---------------------------------------------------------------- меню: каждый герой
  {
    const g = await openGame(browser, server, { size: SIZE, settings: { quality: Q, hero: HEROES[0] }, log: (m) => log(`меню: ${m}`) });
    const { page } = g;
    await g.hideUi(true);
    for (const h of HEROES) {
      await g.virtual(false);
      await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click({ timeout: 240000 });
      await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { timeout: 240000, polling: 200 });
      await g.virtual(true);
      await render(page, false);
      await g.step(150);   // 5 с: «наезд» витрины прошёл, герой в стойке-визитке
      await render(page, true);
      await feetCam(g, { side: 1 });
      await g.step(2);
      report.menu[h] = await gapOf(page);
      await shot(page, `${TAG}_menu_${h}.jpg`);
    }
    await g.ctx.close();
  }
  // ---------------------------------------------------------------- бой: покой у Регента, бег, рывок
  for (const h of HEROES) {
    const g = await openGame(browser, server, { size: SIZE, settings: { quality: Q, hero: h }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`бой ${h}: ${m}`) });
    const { page } = g;
    await g.hideUi(true);
    await g.toBattle();
    await render(page, false);
    await g.walkToBoss();
    await g.step(45);   // остановился, покой
    await render(page, true);
    await feetCam(g, { side: -1 });
    await g.step(2);
    report.battle[h] = await gapOf(page);
    await shot(page, `${TAG}_battle_${h}.jpg`);
    if (VIDEO && h === HEROES[0]) {
      // ролик: бег вперёд, рывок, остановка — камера едет рядом с героем у пола
      const dir = join(OUT, `${TAG}_frames`);
      rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
      let n = 0;
      const frame = async () => { await feetCam(g, { side: -1, dist: 1.8, h: 0.35, fov: 34 }); await g.step(1); await page.screenshot({ path: join(dir, `${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 }); };
      for (let i = 0; i < 20; i++) await frame();
      await page.keyboard.down('KeyD'); for (let i = 0; i < 25; i++) await frame(); await page.keyboard.up('KeyD');
      await page.keyboard.down('KeyW'); for (let i = 0; i < 45; i++) await frame(); await page.keyboard.up('KeyW');
      await page.keyboard.press('Space'); for (let i = 0; i < 25; i++) await frame();
      await page.keyboard.press('KeyL'); for (let i = 0; i < 35; i++) await frame();
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(dir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', join(OUT, `${TAG}_battle.mp4`)]);
      rmSync(dir, { recursive: true, force: true });
      log(`ролик ${TAG}_battle.mp4 (${n} кадров)`);
    }
    await g.ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
writeFileSync(join(OUT, `${TAG}_feet.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
