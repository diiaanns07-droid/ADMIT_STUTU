// [BDO] Снимок любой страницы проекта (стенды dev/*.html, ui-preview, игра) в нескольких размерах.
// node tools/bdo_page_shot.mjs --url "dev/bdo-hud-stand.html?s=engaged" --out DIR [--name tag]
//        [--sizes 1366x768,1920x1080,1366x650] [--wait 3000] [--cdn DIR] [--fast] [--eval "js"]
// Поднимает serve_game.py на свободном порту; --cdn — локальное зеркало cdn.jsdelivr.net/npm
// (распакованные npm pack: DIR/three-0.185.1/package/…); --fast — время боя по реальным часам.
// Печатает ошибки консоли страницы (их быть не должно).

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URLP = argOf('--url', 'dev/bdo-hud-stand.html');
const OUT = resolve(argOf('--out', join(ROOT, 'qa_bdo')));
const NAME = argOf('--name', URLP.replace(/[^a-z0-9]+/gi, '_').slice(0, 60));
const SIZES = argOf('--sizes', '1366x768').split(',').map((s) => s.split('x').map(Number));
const WAIT = +argOf('--wait', '2500');
const CDN = argOf('--cdn', process.env.ASHEN_CDN_MIRROR || '');
const EVAL = argOf('--eval', '');
const PORT = 8900 + Math.floor(Math.random() * 90);
mkdirSync(OUT, { recursive: true });
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
async function mirror(ctx) {
  if (argv.includes('--fast')) {
    await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
  }
  if (!CDN) return;
  await ctx.route('https://cdn.jsdelivr.net/npm/**', async (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.*)$/);
    if (!m) return route.continue();
    const file = join(CDN, `${m[1].replace('@', '').replace('/', '-')}-${m[2]}`, 'package', m[3]);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'mirror: no ' + file });
    return route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': file.endsWith('.json') ? 'application/json' : 'text/javascript', 'access-control-allow-origin': '*' } });
  });
}

const { chromium } = loadPlaywright();
const exe = argOf('--browser', existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const server = await startServer();
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  for (const [W, H] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    await mirror(ctx);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${W}x${H} ${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${W}x${H} EXC: ${e.message}`));
    await page.goto(`http://127.0.0.1:${PORT}/${URLP}`);
    await sleep(WAIT);
    if (EVAL) { try { console.log('eval:', JSON.stringify(await page.evaluate(EVAL))); } catch (e) { errors.push('eval: ' + e.message); } await sleep(400); }
    const file = join(OUT, `${NAME}_${W}x${H}.png`);
    await page.screenshot({ path: file });
    console.log('shot', file);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
