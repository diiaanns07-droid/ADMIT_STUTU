// ASHEN OATH — dev/fx_shots.mjs. Владелец: №7 [VFX].
// Снимки стендов эффектов в headless Chromium (Playwright). CDN three.js подменяется локальной копией
// (в облаке CDN закрыт), поэтому страницы стендов работают без сети.
//
//   node dev/fx_shots.mjs --page "dev/effects_testbench.html?shot=1" --script "ignis" --times 0.1,0.4,0.9 --out /tmp/shots
//   node dev/fx_shots.mjs --page "dev/fx_stand.html?demo=../dev/scratch/glyph_demo.js" --times 0.5,1.5
//
// Протокол страницы: window.__stand = { ready:Promise, run(sec), shot?(name), info?() }.
//   run(sec) — детерминированно продвигает сцену на sec секунд (шаг 1/60) и рендерит кадр;
//   --script NAME вызывает window.__stand.play(NAME) перед снимками (стенд эффектов — действие по имени).
// Флаги: --size 960x540, --vendor DIR (распакованные three и three-vrm из npm), --browser PATH,
//        --quality low|medium|high, --rm (reducedMotion), --fps (замер: 3 с реального rAF → info()).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (k) => argv.includes(k);

const PAGE = arg('--page', 'dev/effects_testbench.html?shot=1');
const SCRIPTS = (arg('--script', '') || '').split(',').filter(Boolean);
const TIMES = (arg('--times', '0.5') || '0.5').split(',').map(Number).filter((x) => Number.isFinite(x));
const OUT = resolve(arg('--out', '/tmp/fx_shots'));
const [W, H] = (arg('--size', '960x540')).split('x').map(Number);
const QUALITY = arg('--quality', '');
const VENDOR = resolve(arg('--vendor', process.env.FX_VENDOR || join(ROOT, 'vendor', 'npm')));
const BROWSER = [arg('--browser'), '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p));
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary', '.bin': 'application/octet-stream', '.hdr': 'application/octet-stream', '.webp': 'image/webp', '.ktx2': 'application/octet-stream' };

// Локальный статический сервер (корень репозитория).
function serve() {
  return new Promise((res) => {
    const srv = createServer(async (req, rsp) => {
      try {
        const u = new URL(req.url, 'http://x');
        let p = join(ROOT, decodeURIComponent(u.pathname));
        if (!p.startsWith(ROOT)) { rsp.writeHead(403); rsp.end(); return; }
        const s = await stat(p).catch(() => null);
        if (s && s.isDirectory()) p = join(p, 'index.html');
        const data = await readFile(p);
        rsp.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
        rsp.end(data);
      } catch (e) { rsp.writeHead(404); rsp.end('not found'); }
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

// CDN → локальные файлы npm-пакетов.
function cdnToLocal(url) {
  const m = url.match(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/);
  if (m) return join(VENDOR, 'three@0.185.1', m[1]);
  const v = url.match(/cdn\.jsdelivr\.net\/npm\/@pixiv\/three-vrm@[^/]+\/(.*)$/);
  if (v) return join(VENDOR, '@pixiv', 'three-vrm@3.5.5', v[1]);
  return null;
}

async function main() {
  const require = createRequire(import.meta.url);
  let pw;
  try { pw = require('playwright'); } catch (e) { pw = require('/opt/node22/lib/node_modules/playwright'); }
  const srv = await serve();
  const port = srv.address().port;
  const browser = await pw.chromium.launch({
    executablePath: BROWSER, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + (e && e.message)));
  await page.route(/cdn\.jsdelivr\.net|fonts\.googleapis|fonts\.gstatic|storage\.googleapis/, async (route) => {
    const local = cdnToLocal(route.request().url());
    if (local && existsSync(local)) {
      route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(local) });
    } else route.fulfill({ status: 404, body: '' });
  });
  const q = [];
  if (QUALITY) q.push('quality=' + QUALITY);
  if (flag('--rm')) q.push('rm=1');
  const url = `http://127.0.0.1:${port}/${PAGE}${q.length ? (PAGE.includes('?') ? '&' : '?') + q.join('&') : ''}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__stand && window.__stand.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__stand.ready);
  const results = [];
  const list = SCRIPTS.length ? SCRIPTS : [''];
  for (const s of list) {
    if (s) await page.evaluate((n) => window.__stand.play(n), s);
    let tPrev = 0;
    for (const t of TIMES) {
      const dt = Math.max(0, t - tPrev); tPrev = t;
      const t0 = Date.now();
      await page.evaluate((sec) => window.__stand.run(sec), dt);
      const file = join(OUT, `${s || 'stand'}_${String(t.toFixed(2)).replace('.', '_')}.png`);
      await page.screenshot({ path: file });
      results.push({ file, ms: Date.now() - t0 });
    }
    if (s && typeof (await page.evaluate(() => typeof window.__stand.reset)) === 'string') await page.evaluate(() => window.__stand.reset && window.__stand.reset());
  }
  let info = null;
  if (flag('--fps')) {
    info = await page.evaluate(() => (window.__stand.measure ? window.__stand.measure(3) : null));
  } else {
    info = await page.evaluate(() => (window.__stand.info ? window.__stand.info() : null));
  }
  console.log(JSON.stringify({ url, results, info, errors: errors.slice(0, 40) }, null, 1));
  await browser.close();
  srv.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
