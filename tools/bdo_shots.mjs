// [BDO] Снимки всех экранов и боевого HUD в нескольких размерах (стиль Black Desert, TEST_REPORT).
// node tools/bdo_shots.mjs --out DIR [--sizes 1366x768,1920x1080,1366x650] [--browser PATH]
//        [--cdn DIR] [--only menu,playing] [--quality medium] [--fps]
// Playwright (глобальный или локальный). Если CDN недоступен (облако без jsdelivr), --cdn DIR
// подменяет https://cdn.jsdelivr.net/npm/<pkg>@<ver>/… файлами из DIR/<pkg>-<ver>/package/…
// (распакованные `npm pack three@0.185.1 @pixiv/three-vrm@3.5.5`).
// Экраны игры снимаются в DEBUG-режиме (без камеры); итоги/ошибка/калибровка — со стенда
// dev/ui-preview.html?f=<фикстура>&dev=0 поверх фальшивой сцены.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, 'qa_bdo')));
const SIZES = argOf('--sizes', '1366x768,1920x1080,1366x650').split(',').map((s) => s.split('x').map(Number));
const CDN = argOf('--cdn', process.env.ASHEN_CDN_MIRROR || '');
const ONLY = (argOf('--only', '') || '').split(',').filter(Boolean);
const QUALITY = argOf('--quality', 'medium');
const FPS = argv.includes('--fps');
let PORT = 20000 + Math.floor(Math.random() * 20000);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright', '/usr/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* ignore */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* next */ } }
  throw new Error('playwright не найден');
}

function startServer() {
  const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('server exit ' + c + ' ' + out)));
  });
}

const MIME = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', wasm: 'application/wasm' };
async function mirrorCdn(ctx) {
  // --fast: в медленном headless (SwiftShader ~1 кадр/с) время боя идёт по реальным часам,
  // а не по 1/20 с за кадр — иначе интро длится минуты. Меняется только копия config.js в браузере.
  if (argv.includes('--fast')) {
    await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      let body = await r.text();
      body = body.replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
  }
  if (!CDN) return;
  await ctx.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.*)$/);
    if (!m) return route.continue();
    const dir = `${m[1].replace('@', '').replace('/', '-')}-${m[2]}`;
    const file = join(CDN, dir, 'package', m[3]);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'mirror: no ' + file });
    const ext = file.split('.').pop();
    return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
  });
}

const want = (name) => !ONLY.length || ONLY.some((o) => name.includes(o));

async function gameShots(browser, W, H, tag, log) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await mirrorCdn(ctx);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`${tag} ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => log.push(`${tag} EXC: ${e.message}`));
  const shot = async (name) => { if (want(name)) await page.screenshot({ path: join(OUT, `${tag}_${name}.png`) }); };
  const btn = (text) => page.locator('button:visible', { hasText: text }).first();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 60000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 60000 }).catch(() => {});
  if (QUALITY !== 'medium') { await btn({ low: 'Низкое', high: 'Высокое' }[QUALITY]).click().catch(() => {}); }
  await sleep(2500);
  await shot('01_menu');
  // меню внизу: видна ли последняя кнопка без прокрутки
  const fit = await page.evaluate(() => {
    const p = document.querySelector('[data-screen="menu"] .ao-panel--menu') || document.querySelector('.ao-panel--menu');
    return p ? { h: Math.round(p.getBoundingClientRect().height), sh: p.scrollHeight, ch: p.clientHeight, vh: innerHeight } : null;
  });
  log.push(`${tag} menu-fit ${JSON.stringify(fit)}`);
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
  await sleep(200);
  await btn('Клятва героя').click(); await sleep(500); await shot('09_oath');
  await btn('Назад').click().catch(() => {}); await sleep(300);
  await btn('Начать').click(); await sleep(400);
  await shot('02_camera');
  await btn('Продолжить без камеры').click(); await sleep(600);
  await shot('04_tutorial');
  await btn('В бой').click(); await sleep(1600);
  await shot('05_intro');
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 90000 });
  await sleep(1500);
  await shot('06_playing_start');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 60000 }).catch(() => log.push(`${tag} не вошли в арену`));
  await sleep(300);
  await page.keyboard.up('KeyW');
  await sleep(700);
  await page.keyboard.press('KeyU'); await sleep(250);
  await page.keyboard.press('KeyI'); await sleep(350);
  await shot('07_playing_engaged');
  if (FPS) {
    const f = [];
    for (let i = 0; i < 6; i++) { await sleep(1000); f.push(await page.evaluate(() => window.__ASHEN__.fps)); }
    log.push(`${tag} fps ${JSON.stringify(f)}`);
  }
  await page.keyboard.press('Escape'); await sleep(500);
  await shot('08_paused');
  await btn('Тренировка').click().catch(() => {}); await sleep(500);
  await shot('10_training');
  await ctx.close();
}

async function previewShots(browser, W, H, tag, log) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await mirrorCdn(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log.push(`${tag} preview EXC: ${e.message}`));
  for (const f of ['calibration-ready', 'victory', 'defeat', 'error-webgl', 'paused-lost', 'camera-ready']) {
    const name = `20_pv_${f}`;
    if (!want(name)) continue;
    await page.goto(`http://127.0.0.1:${PORT}/dev/ui-preview.html?f=${f}&dev=0`);
    await sleep(700);
    await page.screenshot({ path: join(OUT, `${tag}_${name}.png`) });
  }
  await ctx.close();
}

const { chromium } = loadPlaywright();
const exe = argOf('--browser', existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } } // порт мог быть занят параллельным запуском
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const log = [];
try {
  for (const [W, H] of SIZES) {
    const tag = `${W}x${H}`;
    try { await gameShots(browser, W, H, tag, log); } catch (e) { log.push(`${tag} game FAIL: ${e.message}`); }
    try { await previewShots(browser, W, H, tag, log); } catch (e) { log.push(`${tag} preview FAIL: ${e.message}`); }
  }
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(join(OUT, 'log.txt'), log.join('\n') + '\n');
console.log(log.join('\n'));
console.log('shots →', OUT);
