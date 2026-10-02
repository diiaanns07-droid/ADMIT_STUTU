// [HERO] Снимки героев для сравнения «до/после» и замер цены героя.
// node tools/hero_shots.mjs --out DIR [--browser PATH] [--vendor DIR] [--size 1600x900] [--heroes ashen,elf,dark]
//   [--shading realistic|anime] [--no-battle] [--vt] (виртуальное время: бой идёт и в SwiftShader) [--init 'js']
//   [--clip x,y,w,h] — кадрирование снимка меню (доли кадра); [--zoom] — ещё снимки витрины: колесо (лицо) и поворот мышью
// node tools/hero_shots.mjs --stand 'dev/hero_stand.html?a=elf&b=dark' [--stand '…'] --out DIR
//   — стенд героев: снимок и результаты проверок C5 (window.__HS__) в stand.json
// Playwright (глобальный пакет) + serve_game.py. Если CDN (cdn.jsdelivr.net) недоступен, --vendor DIR
// отдаёт библиотеки локально: DIR/three-0.185.1/package/… и DIR/pixiv-three-vrm-3.5.5/package/…
// (npm pack three@0.185.1 @pixiv/three-vrm@3.5.5 и распаковать в DIR).
// Снимки: NN_<hero>_menu.png — меню выбора героя; NN_<hero>_battle*.png — бой в DEBUG (старт, бег, стрейф,
// каст, рывок Q — остаточные образы, «Рассечение» I — шлейф посоха).
// stats.json: fps (SwiftShader, только для сравнения), мс на heroModel.update, ошибки консоли.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, 'dev', 'shots')));
const [W, H] = argOf('--size', '1600x900').split('x').map(Number);
const HEROES = argOf('--heroes', 'ashen,elf,dark').split(',');
const SHADING = argOf('--shading', '');
const VENDOR = argOf('--vendor', process.env.ASHEN_VENDOR || '');
const BROWSER = [argOf('--browser'), '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p));
const PORT = 8000 + Math.floor(Math.random() * 700);
const VT = argv.includes('--vt');
const INIT = argOf('--init', '');   // код в страницу до загрузки (флаги QA, напр. 'globalThis.__NOGHOST__ = true')
// ждать n кадров виртуального времени (или просто паузу без --vt)
async function frames(page, n, msIfReal) {
  if (!VT) return sleep(msIfReal);
  const t0 = await page.evaluate(() => performance.now());
  await page.waitForFunction((t) => performance.now() >= t, t0 + (n * 1000) / 30, { timeout: 600000, polling: 200 });
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

function startServer() {
  const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 10000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
  });
}

const MIME = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', wasm: 'application/wasm' };
async function routeVendor(ctx) {
  if (!VENDOR) return;
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/, (route) => {
    const m = route.request().url().match(/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/);
    const dir = m[1] === 'three' ? `three-${m[2]}` : `pixiv-three-vrm-${m[2]}`;
    const file = join(VENDOR, dir, 'package', m[3].split('?')[0]);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
  });
}

const server = await startServer();
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const STANDS = argv.flatMap((a, i) => (a === '--stand' ? [argv[i + 1]] : []));
if (STANDS.length) {
  const out = {};
  let k = 0;
  for (const u of STANDS) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    await routeVendor(ctx);
    const page = await ctx.newPage();
    const log = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => log.push('EXC: ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}/${u}`);
    const res = await page.waitForFunction(() => window.__HS__, null, { timeout: 180000 }).then((h) => h.jsonValue()).catch((e) => ({ error: String(e) }));
    await sleep(Number(argOf('--wait', '1500')));
    if (argv.includes('--drift')) res.drift = await page.evaluate(() => window.__HS_DRIFT__ && window.__HS_DRIFT__());
    const name = `stand_${String(k++).padStart(2, '0')}`;
    await page.screenshot({ path: join(OUT, name + '.png'), timeout: 120000 });
    out[name] = { url: u, res, log: log.slice(0, 30) };
    await ctx.close();
  }
  writeFileSync(join(OUT, 'stand.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close(); server.kill(); process.exit(0);
}
const stats = {};
let n = 0;
const nn = () => String(n++).padStart(2, '0');
try {
  for (const hero of HEROES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    await routeVendor(ctx);
    const settings = { hero, quality: argOf('--quality', 'medium') };
    if (argOf('--zone')) { settings.startZone = argOf('--zone'); settings.startZoneV = 2; }   // startZoneV: без него main.js переводит старое «arena» в «edge»
    if (SHADING) settings.heroShading = SHADING;
    await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, settings);
    if (INIT) await ctx.addInitScript({ content: INIT });
    // --vt: виртуальное время — каждый кадр rAF продвигает часы ровно на 1/30 с (SwiftShader рисует ~1 кадр/с,
    // а игра считает кадры длиннее 0,25 с разрывом и не двигает бой)
    if (VT) await ctx.addInitScript(() => {
      let t = 0; const raf = window.requestAnimationFrame.bind(window);
      performance.now = () => t;
      window.requestAnimationFrame = (cb) => raf(() => { t += 1000 / 30; cb(t); });
    });
    const page = await ctx.newPage();
    const log = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => log.push('EXC: ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 60000 });
    await page.waitForFunction(() => { const a = __ASHEN__.worldAssets(); return a && a.pending === 0; }, null, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => { const h = __ASHEN__.hero(); return h && h.ready; }, null, { timeout: 90000 }).catch(() => log.push('hero not ready'));
    await sleep(Number(argOf('--menu-wait', '2500')));
    // SwiftShader даёт ~1 кадр/с: кадры > 0,25 с игра считает разрывом и время не идёт — прокручиваем героя вручную
    const steps = Number(argOf('--menu-step', '0'));
    if (steps) { await page.evaluate((n) => { for (let i = 0; i < n; i++) __ASHEN__.heroStep(1 / 30, null, []); }, steps); await sleep(1500); }
    const st = { hero: await page.evaluate(() => __ASHEN__.hero()), showcase: await page.evaluate(() => (__ASHEN__.heroShowcase ? __ASHEN__.heroShowcase() : null)) };
    // --clip x,y,w,h (доли кадра 0..1) — крупный план витрины
    const clipArg = argOf('--clip');
    const clip = clipArg ? (([x, y, w, h]) => ({ x: x * W, y: y * H, width: w * W, height: h * H }))(clipArg.split(',').map(Number)) : undefined;
    console.error('fps', await page.evaluate(() => __ASHEN__.fps));
    const shot = await page.screenshot({ path: join(OUT, `${nn()}_${hero}_menu.png`), timeout: 120000, clip });
    // проверка кадра: NaN/Inf в шейдере героя bloom разносит на весь экран — кадр почти чёрный или белый
    const frame = await page.evaluate(async (b64) => {
      const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b64; });
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = Math.max(1, Math.round((160 * im.height) / im.width));
      const g = cv.getContext('2d'); g.drawImage(im, 0, 0, cv.width, cv.height);
      const px = g.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0, white = 0, n = 0, sum = 0;
      for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; sum += l; n++; if (l < 4) dark++; if (l > 215) white++; }
      return { mean: +(sum / n).toFixed(1), dark: +(dark / n).toFixed(3), white: +(white / n).toFixed(3) };
    }, shot.toString('base64'));
    if (frame.dark > 0.6 || frame.white > 0.35) { log.push(`WARN кадр меню подозрительный (NaN в шейдере?): ${JSON.stringify(frame)}`); console.error('WARN frame', hero, frame); }
    st.frame = frame;
    // --zoom: колесо мыши над героем (приближение витрины к лицу) и перетаскивание (поворот) — настоящими событиями
    if (argv.includes('--zoom')) {
      await page.mouse.move(W * 0.72, H * 0.45);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -300); await frames(page, 2, 200); }
      await frames(page, 50, 2500);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_menu_zoom.png`), timeout: 120000 });
      st.zoom = await page.evaluate(() => (__ASHEN__.heroShowcase ? __ASHEN__.heroShowcase() : null));
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) { await page.mouse.move(W * 0.72 + i * W * 0.03, H * 0.45); await frames(page, 1, 100); }
      await page.mouse.up();
      await frames(page, 30, 1500);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_menu_turn.png`), timeout: 120000 });
    }
    // цена героя: среднее время heroModel.update (без рендера)
    st.updateMs = await page.evaluate(() => {
      if (!__ASHEN__.heroStep) return null;
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) __ASHEN__.heroStep(1 / 60, null, []);
      return +((performance.now() - t0) / 60).toFixed(3);
    });
    if (!argv.includes('--no-battle')) {
      const click = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === l); if (b) b.click(); return !!b; }, label);
      await click('Отладка с клавиатуры'); await sleep(150);
      await click('Играть'); await sleep(250);
      await click('Продолжить без камеры (демо)'); await sleep(400);
      await click('В бой');
      await page.waitForFunction(() => __ASHEN__.screen === 'playing', null, { timeout: 20000 }).catch(() => {});
      await frames(page, Number(argOf('--intro-frames', '150')), 1500);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_start.png`), timeout: 120000 });
      await page.keyboard.down('KeyW'); await frames(page, 30, 1200);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_run.png`), timeout: 120000 });
      await page.keyboard.up('KeyW'); await frames(page, 12, 600);
      await page.keyboard.down('KeyD'); await frames(page, 18, 700);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_strafe.png`), timeout: 120000 });
      await page.keyboard.up('KeyD'); await frames(page, 12, 500);
      await page.keyboard.press('KeyU'); await frames(page, 8, 250);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_cast.png`), timeout: 120000 });
      // V7.2: рывок влево (остаточные образы) и «Рассечение» (шлейф посоха)
      await frames(page, 20, 600);
      await page.keyboard.press('KeyQ'); await frames(page, 5, 180);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_dash.png`), timeout: 120000 });
      await frames(page, 30, 900);
      await page.keyboard.press('KeyI'); await frames(page, 6, 200);
      await page.screenshot({ path: join(OUT, `${nn()}_${hero}_battle_slash.png`), timeout: 120000 });
      await sleep(800);
      const t0 = Date.now(); const f0 = await page.evaluate(() => performance.now());
      await sleep(3000);
      st.fps = await page.evaluate(() => __ASHEN__.fps);
      st.render = await page.evaluate(() => __ASHEN__.renderInfo());
      st.heroState = await page.evaluate(() => __ASHEN__.hero());
      void t0; void f0;
    }
    st.log = log.slice(0, 40);
    stats[hero] = st;
    await ctx.close();
  }
} finally {
  writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 2));
  await browser.close();
  server.kill();
}
console.log(JSON.stringify(stats, null, 2));
