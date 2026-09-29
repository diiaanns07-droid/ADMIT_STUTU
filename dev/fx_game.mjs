// ASHEN OATH — dev/fx_game.mjs. Владелец: №7 [VFX].
// Проверка эффектов В ИГРЕ (без камеры): меню → «Отладка с клавиатуры» → бой → вход в арену → руны 1–0,
// печати Z/X/C/V/B, выброс L, рассечение I, искра U. Снимки + ошибки консоли + fps/частицы.
//   node dev/fx_game.mjs --out DIR [--quality low|medium|high] [--size 1280x720] [--nov6] [--keys 1,2,3]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OUT = resolve(arg('--out', '/tmp/fx_game'));
const [W, H] = arg('--size', '1280x720').split('x').map(Number);
const QUALITY = arg('--quality', 'medium');
const VENDOR = resolve(arg('--vendor', process.env.FX_VENDOR || '/tmp/claude-0/-home-user-ADMIT-STUTU/9bbb049c-276b-5b57-99ba-3d679f5528c8/scratchpad/vendor'));
const KEYS = arg('--keys', 'Digit1,Digit2,Digit3,Digit4,Digit5,Digit6,Digit7,Digit8,Digit9,Digit0,KeyZ,KeyX,KeyC,KeyV,KeyB,KeyL,KeyI,KeyU').split(',');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary', '.bin': 'application/octet-stream', '.webp': 'image/webp' };
function serve() {
  return new Promise((res) => {
    const srv = createServer(async (req, rsp) => {
      try {
        const u = new URL(req.url, 'http://x');
        let p = join(ROOT, decodeURIComponent(u.pathname));
        const s = await stat(p).catch(() => null);
        if (s && s.isDirectory()) p = join(p, 'index.html');
        const data = await readFile(p);
        rsp.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); rsp.end(data);
      } catch (e) { rsp.writeHead(404); rsp.end(); }
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}
function cdnToLocal(url) {
  const m = url.match(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/);
  if (m) return join(VENDOR, 'three-0.185.1', 'package', m[1]);
  const v = url.match(/cdn\.jsdelivr\.net\/npm\/@pixiv\/three-vrm@[^/]+\/(.*)$/);
  if (v) return join(VENDOR, 'pixiv-three-vrm-3.5.5', 'package', v[1]);
  return null;
}
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/node22/lib/node_modules/playwright'); }
const srv = await serve();
const browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + (e && e.message)));
await page.route(/cdn\.jsdelivr\.net|fonts\.googleapis|fonts\.gstatic|storage\.googleapis/, async (route) => {
  const local = cdnToLocal(route.request().url());
  if (local && existsSync(local)) route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(local) });
  else route.fulfill({ status: 404, body: '' });
});
// Время игры = фиксированный шаг 1/30 с на кадр rAF (SwiftShader рисует медленно, а main.js считает кадр > 0,25 с разрывом).
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const pn = performance.now.bind(performance);
  let t = pn();
  performance.now = () => t;
  window.requestAnimationFrame = (cb) => raf(() => { t += 1000 / 30; cb(t); });
});
await page.addInitScript(([q, nov6]) => { try { const k = 'ashen-oath.settings.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.quality = q; s.fxMagic = !nov6; localStorage.setItem(k, JSON.stringify(s)); } catch (e) {} }, [QUALITY, argv.includes('--nov6')]);
const click = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === l); if (!b) return 'missing'; b.click(); return 'ok'; }, label);
const shot = (n) => page.screenshot({ path: join(OUT, n + '.png') });
const out = { steps: [] };
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 40000 });
  await sleep(2500);
  await shot('00_menu');
  out.steps.push(['debug', await click('Отладка с клавиатуры')]); await sleep(200);
  out.steps.push(['start', await click('Начать')]); await sleep(300);
  out.steps.push(['nocam', await click('Продолжить без камеры (DEBUG)')]); await sleep(500);
  out.steps.push(['fight', await click('В бой')]); await sleep(1500);
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 150000 });
  await sleep(800);
  await shot('01_start');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 90000 }).catch(() => out.steps.push(['engage', 'timeout']));
  await sleep(500);
  await page.keyboard.up('KeyW');
  await sleep(700);
  await shot('02_engaged');
  const waitEnergy = async (n) => { for (let i = 0; i < 80; i++) { const e = await page.evaluate(() => window.__ASHEN__.snapshot().player.energy); if (e >= n) return; await sleep(200); } };
  for (const k of KEYS) {
    await waitEnergy(50);
    await page.keyboard.down(k); await sleep(70); await page.keyboard.up(k);
    await sleep(260); await shot('k_' + k + '_a');
    await sleep(350); await shot('k_' + k + '_b');
    const fxi = await page.evaluate(() => window.__ASHEN__.fx());
    out.steps.push([k, fxi && fxi.v6 ? fxi.v6.kit.particles : null, fxi && fxi.particles]);
    await sleep(900);
  }
  out.render = await page.evaluate(() => ({ ...window.__ASHEN__.renderInfo(), fps: window.__ASHEN__.fps, screen: window.__ASHEN__.screen }));
  const fxi = await page.evaluate(() => window.__ASHEN__.fx());
  out.v6 = fxi && fxi.v6 ? { enabled: fxi.v6.enabled, loaded: fxi.v6.loaded, kit: fxi.v6.kit } : null;
  out.events = fxi && fxi.events;
} catch (e) { out.error = String(e && e.stack || e); await shot('zz_error').catch(() => {}); }
out.errors = errors.filter((e) => !/storage\.googleapis|Failed to load resource/.test(e)).slice(0, 40);
out.allErrors = errors.length;
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
