// [HERO] Лист снимков: PNG → одна JPEG-картинка (сетка с подписями) через Chromium, без npm-пакетов.
// node tools/sheet.mjs --out dev/shots/hero_v7.jpg --cols 5 --title 'Заголовок' a.png:Подпись b.png:Подпись …
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = argOf('--out', 'sheet.jpg');
const COLS = Number(argOf('--cols', '4'));
const TITLE = argOf('--title', '');
const Q = Number(argOf('--quality', '0.86'));
const skip = new Set(['--out', '--cols', '--title', '--quality', '--browser']);
const items = [];
for (let i = 0; i < argv.length; i++) { if (skip.has(argv[i])) { i++; continue; } const [f, ...cap] = argv[i].split(':'); items.push({ f, cap: cap.join(':') }); }
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const BROWSER = [argOf('--browser'), '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: BROWSER });
const page = await browser.newPage();
const data = items.map(({ f, cap }) => ({ src: 'data:image/png;base64,' + readFileSync(f).toString('base64'), cap }));
const jpg = await page.evaluate(async ({ data, cols, title, q }) => {
  const imgs = await Promise.all(data.map((d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = d.src; })));
  const w = Math.max(...imgs.map((i) => i.width)), h = Math.max(...imgs.map((i) => i.height));
  const rows = Math.ceil(imgs.length / cols), top = title ? 34 : 0;
  const cv = document.createElement('canvas'); cv.width = w * cols; cv.height = h * rows + top;
  const g = cv.getContext('2d');
  g.fillStyle = '#0c0e13'; g.fillRect(0, 0, cv.width, cv.height);
  if (title) { g.fillStyle = '#e8dcc0'; g.font = '18px sans-serif'; g.fillText(title, 10, 23); }
  imgs.forEach((im, i) => {
    const x = (i % cols) * w, y = top + Math.floor(i / cols) * h;
    g.drawImage(im, x, y);
    if (data[i].cap) { g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y + h - 28, w, 28); g.fillStyle = '#fff'; g.font = '15px sans-serif'; g.fillText(data[i].cap, x + 8, y + h - 9); }
  });
  return cv.toDataURL('image/jpeg', q);
}, { data, cols: COLS, title: TITLE, q: Q });
writeFileSync(OUT, Buffer.from(jpg.split(',')[1], 'base64'));
await browser.close();
console.log('ok', OUT);
