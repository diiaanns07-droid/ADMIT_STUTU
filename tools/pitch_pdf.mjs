// Презентация в PDF: 13 страниц 1920×1080, все шаги раскрыты, вместо видео — постеры.
//   node tools/pitch_pdf.mjs [--out pitch/ASHEN_OATH_pitch.pdf] [--allow-stubs]
// Свой маленький статический сервер (как GitHub Pages: корень репозитория, страница /pitch/), Playwright
// с Chromium из /opt/pw-browsers (или из установки playwright). Ждём шрифты и все картинки (window.DECK.ready()),
// затем печать в режиме print — та же раскладка, что и при Ctrl+P. Слайды-заглушки «в сборке» — ошибка,
// пока не передан --allow-stubs: PDF для жюри не должен содержать недоделанных частей.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(HERE, argOf('--out', 'pitch/ASHEN_OATH_pitch.pdf'));
const ALLOW_STUBS = argv.includes('--allow-stubs');
const MAX_MB = 8;

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* нет npm */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* следующий */ } }
  throw new Error('playwright не найден');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf'
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(HERE, p));
    if (!file.startsWith(HERE)) { res.writeHead(403).end(); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404).end(); return; }
    // видео в печати не нужны (вместо них постеры), но браузер может спросить — отдаём пустой ответ
    if (extname(file) === '.mp4' || extname(file) === '.webm') { res.writeHead(204).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const { chromium } = loadPlaywright();
const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p) && statSync(p).isFile());
const browser = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader'] });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.route('**/*', (r) => (r.request().url().startsWith(`http://127.0.0.1:${PORT}/`) || r.request().url().startsWith('data:') ? r.continue() : r.abort()));
  await page.goto(`http://127.0.0.1:${PORT}/pitch/#1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DECK && window.DECK.total > 0, null, { timeout: 30000 });
  const total = await page.evaluate(() => window.DECK.ready());
  const stubs = await page.evaluate(() => [...document.querySelectorAll('.slide--stub')].map((s) => s.getAttribute('data-slide')));
  if (stubs.length) {
    const msg = `слайды в сборке (заглушки): ${stubs.join(', ')}`;
    if (!ALLOW_STUBS) throw new Error(msg + ' — слейте все части или запустите с --allow-stubs');
    console.warn('Внимание: ' + msg);
  }
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(300);
  await page.pdf({ path: OUT, width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
  const bytes = statSync(OUT).size;
  const pdf = await readFile(OUT, 'latin1');
  const pages = Math.max(0, ...[...pdf.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => +m[1]));
  console.log(`PDF: ${OUT}`);
  console.log(`  слайдов: ${total}, страниц: ${pages || 'не удалось прочитать'}, размер: ${(bytes / 1048576).toFixed(2)} МБ`);
  if (errors.length) console.warn('  ошибки страницы:', errors.join(' | '));
  if (pages && pages !== total) { console.error(`  страниц ${pages}, а слайдов ${total}`); code = 1; }
  if (bytes > MAX_MB * 1048576) { console.error(`  больше ${MAX_MB} МБ`); code = 1; }
} catch (e) {
  console.error('Ошибка: ' + (e && e.message || e));
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
