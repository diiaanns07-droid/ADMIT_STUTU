// Замер веса и времени загрузки в headless Chromium (Playwright).
// node tools/load_budget.mjs [--cdn DIR] [--mbit 8] [--rtt 40] [--out DIR] [--tag before] [--only menu,fight,track]
//   --cdn DIR   локальное зеркало cdn.jsdelivr.net/npm: DIR/node_modules/<пакет>/… (или DIR/<пакет>-<версия>/package/…)
//   --mbit N    ширина канала, Мбит/с (0 — без ограничения); --rtt — задержка ответа, мс
//   --shots     кадры витрины меню каждые 2 с первых 40 с (диафильм «что видит жюри»)
//   --gzip      текстовые ответы (js, css, html, json) идут по каналу сжатыми, как на GitHub Pages;
//               в отчёте тогда два числа: байты по сети (wire) и распакованные
// Сценарии (каждый — в новом профиле, без кэша):
//   menu  — до появления меню (boot.done), до героя на витрине (hero.ready) и сколько докачивается в меню;
//   fight — меню → «Отладка с клавиатуры» → «Играть» → «Продолжить без камеры» → бой: байты до старта боя и за первые 15 с боя;
//   track — меню → «Играть» (сразу просит камеру; фейковая камера): байты до работающего трекинга и первого ответа
//           распознавания, ступень лестницы отката и причина, если она понадобилась. [W5-КАМЕРА]
// Байты — тела ответов (без сжатия на лету), включая CDN и модели MediaPipe.
// Канал моделируется одной общей «трубой» FIFO: ответ занимает её на размер/ширину, плюс задержка.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CDN = argOf('--cdn', null);
const MBIT = +argOf('--mbit', '8');
const RTT = +argOf('--rtt', '40');
const TAG = argOf('--tag', 'run');
const OUT = resolve(argOf('--out', join(ROOT, 'dev', 'scratch', 'load_budget')));
const ONLY = (argOf('--only', 'menu,fight,track') || '').split(',').filter(Boolean);
const SHOTS = argv.includes('--shots');
const GZIP = argv.includes('--gzip');
const TEXT = /javascript|css|html|json|text\//;
mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* ignore */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* дальше */ } }
  throw new Error('playwright не найден');
}

// ---------------------------------------------------------------- статический сервер проекта
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
};
function startServer() {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function cdnFile(u) {
  const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.*)$/);
  if (!m || !CDN) return null;
  const a = join(CDN, 'node_modules', m[1], m[3]);
  if (existsSync(a)) return a;
  const b = join(CDN, `${m[1].replace('@', '').replace('/', '-')}-${m[2]}`, 'package', m[3]);
  return existsSync(b) ? b : null;
}

// ---------------------------------------------------------------- один сценарий
async function runScenario(browser, base, name, steps) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
  const t0 = { v: 0 };
  const log = [];          // { t, url, bytes, kind }
  let linkFree = 0;
  const BW = MBIT > 0 ? (MBIT * 1e6) / 8 : 0; // байт/с
  const now = () => Date.now() - t0.v;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    let body, status = 200, headers = {};
    try {
      if (u.hostname === 'cdn.jsdelivr.net') {
        const f = cdnFile(u);
        if (!f) return route.fulfill({ status: 404, body: 'mirror: нет ' + u.pathname });
        body = readFileSync(f);
        headers = { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' };
      } else {
        const r = await route.fetch();
        body = await r.body(); status = r.status(); headers = r.headers();
        if (u.hostname !== '127.0.0.1') headers['access-control-allow-origin'] = '*';
      }
    } catch (e) { return route.abort(); }
    const t = now();
    const ct = String(headers['content-type'] || '');
    const wire = GZIP && TEXT.test(ct) ? gzipSync(body, { level: 6 }).length : body.length;
    let ready = t;
    if (BW > 0) { const start = Math.max(t, linkFree); linkFree = start + (wire / BW) * 1000; ready = linkFree + RTT; }
    if (ready > t) await sleep(ready - t);
    log.push({ t: now(), url: u.origin === base.slice(0, -1) ? u.pathname : u.href, bytes: body.length, wire });
    try { await route.fulfill({ status, body, headers }); } catch (e) { /* страница закрыта */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  const bytesAt = (t, k = 'bytes') => log.filter((r) => r.t <= t).reduce((s, r) => s + r[k], 0);
  const marks = {};
  const mark = (k) => { const t = now(); marks[k] = { t, bytes: bytesAt(t), wire: bytesAt(t, 'wire') }; return marks[k]; };
  t0.v = Date.now();
  await page.goto(base + '?uncapped=1', { waitUntil: 'commit' });
  const shots = [];
  try { await steps({ page, mark, now, sleep, log, shots, marks }); } catch (e) { errors.push('сценарий: ' + (e && e.message)); }
  mark('end');
  const files = {};
  for (const r of log) { const k = r.url.replace(/\?.*$/, ''); files[k] = (files[k] || 0) + r.bytes; }
  await ctx.close();
  return { name, marks, files, requests: log.length, errors: errors.slice(0, 20), shots, log };
}

const waitFor = async (page, fn, timeout, arg) => { await page.waitForFunction(fn, arg, { timeout, polling: 100 }); };

async function main() {
  const { chromium } = loadPlaywright();
  const exe = existsSync('/opt/pw-browsers/chromium') && statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium'
    : existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const results = [];
  const TO = MBIT > 0 ? 240000 : 120000;

  if (ONLY.includes('menu')) results.push(await runScenario(browser, base, 'menu', async ({ page, mark, sleep, log, shots, now }) => {
    let shooting = SHOTS;
    const shoot = async () => {
      for (let i = 0; shooting && i < 21; i++) {
        // кадр снимается, когда страница отдаст его (главный поток бывает занят) — подпись по времени снятия
        let buf = null;
        try { buf = await page.screenshot({ type: 'jpeg', quality: 70 }); } catch (e) { /* ещё нет кадра */ }
        const t = now();
        if (buf) { const file = join(OUT, `${TAG}_menu_${String(Math.round(t / 1000)).padStart(2, '0')}s.jpg`); writeFileSync(file, buf); shots.push({ t, file }); }
        const left = 2000 * (i + 1) - now(); if (left > 0) await sleep(left);
      }
    };
    const shotP = shoot();
    await waitFor(page, () => !!window.__ASHEN__, TO); mark('menu');
    await waitFor(page, () => { const h = window.__ASHEN__.hero(); return h && h.ready; }, TO).then(() => mark('heroReady')).catch(() => {});
    // жители деревни: если стартуют в меню — видно по stats()
    let last = log.length, quiet = 0;
    for (let i = 0; i < 120 && quiet < 8; i++) { await sleep(1000); if (log.length === last) quiet++; else { quiet = 0; last = log.length; } }
    mark('menuIdle');
    const v = await page.evaluate(() => { const w = window.__ASHEN__.worldAssets && window.__ASHEN__.worldAssets(); return { hero: window.__ASHEN__.hero(), screen: window.__ASHEN__.screen }; }).catch(() => null);
    if (v) mark('_info').info = v;
    shooting = false; await shotP;
  }));

  if (ONLY.includes('fight')) results.push(await runScenario(browser, base, 'fight', async ({ page, mark, sleep }) => {
    await waitFor(page, () => !!window.__ASHEN__, TO); mark('menu');
    await page.getByText('Отладка с клавиатуры').click();
    await page.getByRole('button', { name: 'Играть', exact: true }).first().click();   // [W5-КАМЕРА] было «Начать» (до быстрого входа)
    await page.getByRole('button', { name: /Продолжить без камеры/ }).click();
    await page.getByRole('button', { name: 'В бой' }).click();
    await waitFor(page, () => ['intro', 'playing'].includes(window.__ASHEN__.screen), TO); mark('fight');
    await sleep(15000); mark('fight15s');
  }));

  // [W5-КАМЕРА] «Играть» сразу просит камеру (быстрый вход): кнопок «Начать» и «Разрешить камеру» в меню больше нет
  if (ONLY.includes('track')) results.push(await runScenario(browser, base, 'track', async ({ page, mark }) => {
    await waitFor(page, () => !!window.__ASHEN__, TO); mark('menu');
    await waitFor(page, () => [...document.querySelectorAll('button')].some((b) => b.offsetParent && b.textContent.trim() === 'Играть'), TO);
    await page.getByRole('button', { name: 'Играть', exact: true }).first().click();
    mark('cameraClick');
    await waitFor(page, () => { const s = window.__ASHEN__.tracking; return s && ['ready', 'lost', 'calibrating'].includes(s.status); }, TO * 2); mark('tracking');
    await waitFor(page, () => { const s = window.__ASHEN__.tracking; return s && s.debug && s.debug.results > 0; }, TO * 2).then(() => mark('firstResult')).catch(() => {});
    const t = await page.evaluate(() => { const s = window.__ASHEN__.tracking || {}; const d = s.debug || {}; return { status: s.status, message: s.message, step: d.engineStep, ladder: d.ladderHistory, hz: d.inferenceHz, firstResultMs: d.firstResultMs }; }).catch(() => null);
    if (t) mark('_track').info = t;
  }));

  srv.close();
  await browser.close();
  const MB = (b) => (b / 1048576).toFixed(2);
  const s = (ms) => (ms / 1000).toFixed(1);
  const lines = [`# load_budget ${TAG}: канал ${MBIT > 0 ? MBIT + ' Мбит/с, ' + RTT + ' мс' : 'без ограничения'}${GZIP ? ', текст сжат gzip' : ''}`, ''];
  for (const r of results) {
    lines.push(`## ${r.name} (${r.requests} запросов)`);
    for (const [k, m] of Object.entries(r.marks)) if (!k.startsWith('_')) lines.push(`- ${k}: ${s(m.t)} с, ${MB(m.bytes)} МБ${GZIP ? ` (по сети ${MB(m.wire)} МБ)` : ''}`);
    if (r.marks._track && r.marks._track.info) lines.push(`- распознавание: ${JSON.stringify(r.marks._track.info)}`); // [W5-КАМЕРА]
    const top = Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, 25);
    lines.push('', '| файл | МБ |', '|---|---|', ...top.map(([f, b]) => `| ${f} | ${MB(b)} |`), '');
    if (r.errors.length) lines.push('ошибки:', ...r.errors.map((e) => '  ' + e), '');
  }
  const txt = lines.join('\n');
  console.log(txt);
  writeFileSync(join(OUT, `${TAG}.md`), txt);
  writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify({ mbit: MBIT, rtt: RTT, gzip: GZIP, results }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
