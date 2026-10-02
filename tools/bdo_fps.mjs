// [BDO] Замер кадра боя (DEBUG, без камеры) для сравнения «до/после» стиля BDO.
// node tools/bdo_fps.mjs [--size 800x450] [--quality medium] [--sec 20] [--cdn DIR] [--bdo 0|1] [--runs 2]
// Входит в бой, доходит до арены (W), затем N секунд меряет интервалы requestAnimationFrame.
// В облаке это программный рендер (SwiftShader): абсолютные fps малы, но относительная разница
// «до/после» на одной машине и одном размере показывает цену постобработки и HUD.

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const [W, H] = argOf('--size', '800x450').split('x').map(Number);
const QUALITY = argOf('--quality', 'medium');
const SEC = +argOf('--sec', '20');
const RUNS = +argOf('--runs', '2');
const CDN = argOf('--cdn', process.env.ASHEN_CDN_MIRROR || '');
const BDO = argOf('--bdo', '1') !== '0';
let PORT = 20000 + Math.floor(Math.random() * 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
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

const { chromium } = loadPlaywright();
const exe = existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } }
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
try {
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: QUALITY, bdoUi: BDO, reducedMotion: false });
    await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
    if (CDN) {
      await ctx.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
        const u = new URL(route.request().url());
        const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.*)$/);
        if (!m) return route.continue();
        const file = join(CDN, `${m[1].replace('@', '').replace('/', '-')}-${m[2]}`, 'package', m[3]);
        if (!existsSync(file)) return route.fulfill({ status: 404 });
        return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': 'text/javascript' } });
      });
    }
    const page = await ctx.newPage();
    const btn = (text) => page.locator('button:visible', { hasText: text }).first();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 90000 });
    await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 90000 }).catch(() => {});
    await sleep(1500);
    await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
    await btn('Играть').click(); await sleep(300);
    await btn('Продолжить без камеры').click(); await sleep(500);
    await btn('В бой').click();
    await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 180000 });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 120000 }).catch(() => {});
    await page.keyboard.up('KeyW');
    await sleep(2000);
    const r = await page.evaluate((sec) => new Promise((res) => {
      const ts = [];
      const t0 = performance.now();
      function tick(t) { ts.push(t); if (t - t0 < sec * 1000) requestAnimationFrame(tick); else res(ts); }
      requestAnimationFrame(tick);
    }), SEC);
    const dts = r.slice(1).map((t, i) => t - r[i]).sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
    const med = dts[Math.floor(dts.length / 2)] || 0;
    const info = await page.evaluate(() => ({ postfx: window.__ASHEN__.postfx, render: window.__ASHEN__.renderInfo() }));
    results.push({ run, frames: dts.length, meanMs: +mean.toFixed(1), medianMs: +med.toFixed(1), fps: +(1000 / mean).toFixed(2), ...info });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify({ size: `${W}x${H}`, quality: QUALITY, bdo: BDO, results }, null, 1));
