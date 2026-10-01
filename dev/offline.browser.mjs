// [OFFLINE] Игра без интернета: первый запуск онлайн → context.setOffline(true) → перезагрузка.
// Проверяет, что второй запуск стартует целиком из кэша service worker (sw.js) и что модель
// распознавания (MediaPipe: модуль, WASM, модели позы и кистей) инициализируется офлайн.
// Печатает цифры: время до меню, время «Разрешить камеру» → распознавание готово, байты по сети.
//
//   node dev/offline.browser.mjs [--out DIR] [--browser PATH] [--menu-wait 6000] [--npm DIR] [--report]
//
//   --npm DIR    node_modules с three@0.185.1, @pixiv/three-vrm@3.5.5, @mediapipe/tasks-vision@0.10.35:
//                ими подменяются запросы к cdn.jsdelivr.net (если CDN закрыт). Нужен только для старых
//                сборок без vendor/; текущая игра на CDN не ходит.
//   --report     не падать на проверках (замер «до» на старой сборке без sw.js).
//   --block-cdn  все внешние хосты недоступны уже при первом запуске (сеть площадки без CDN).
// Сервер поднимается сам (serve_game.py на свободном порту). Фейковая камера Chromium показывает
// узор без человека: «готово» = распознавание запущено и обрабатывает кадры, а не найдено тело.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_offline')));
const NPM = argOf('--npm', null);
const REPORT = argv.includes('--report');
const BLOCK_CDN = argv.includes('--block-cdn');
const MENU_WAIT = +argOf('--menu-wait', 6000);   // «человек смотрит меню» перед «Разрешить камеру»
let pw;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(p); break; } catch (e) { /* дальше */ } }
if (!pw) { console.error('playwright не найден'); process.exit(2); }
const exe = argOf('--browser', ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line); console.log(line);
  if (!ok) failures++;
}

// ── сервер ──
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function startServer() {
  const port = await freePort();
  const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('сервер не ответил: ' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('сервер завершился ' + c + ' ' + out)));
  });
  return { port, url: `http://127.0.0.1:${port}/`, kill: () => { try { py.kill(); } catch (e) { /* уже */ } } };
}

const server = await startServer();
const browser = await pw.chromium.launch({
  executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'], ignoreHTTPSErrors: !!process.env.AO_IGNORE_HTTPS });
// низкое качество: рендер в headless программный (SwiftShader)
await ctx.addInitScript(() => { try { if (!localStorage.getItem('ashen-oath.settings.v1')) localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', qualityAuto: false, reducedMotion: true })); } catch (e) { /* ignore */ } });
// точное время появления window.__ASHEN__ (main.js выполнился, меню на экране)
await ctx.addInitScript(() => {
  let v;
  Object.defineProperty(window, '__ASHEN__', { configurable: true, get: () => v, set: (x) => { v = x; if (!window.__aoT) window.__aoT = { menu: performance.now() }; } });
});

const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ''; } };
const net0 = { reqs: [], bytes: 0, hosts: new Set(), failed: [] };
function resetNet() { net0.reqs = []; net0.bytes = 0; net0.hosts = new Set(); net0.failed = []; }
ctx.on('requestfinished', async (r) => {
  const u = r.url();
  if (!/^https?:/.test(u)) return;
  net0.hosts.add(hostOf(u));
  let size = 0;
  try { const s = await r.sizes(); size = s.responseBodySize + s.responseHeadersSize; } catch (e) { /* ignore */ }
  const resp = await r.response().catch(() => null);
  const fromSW = resp ? resp.fromServiceWorker() : false;
  net0.reqs.push({ u, size, fromSW });
  if (!fromSW) net0.bytes += Math.max(0, size);
});
ctx.on('requestfailed', (r) => { if (/^https?:/.test(r.url())) net0.failed.push(r.url() + ' ' + ((r.failure() && r.failure().errorText) || '')); });

if (NPM) {
  await ctx.route(/cdn\.jsdelivr\.net\/npm\//, (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/(.*)$/);
    const f = m && join(NPM, m[1], m[2]);
    if (f && existsSync(f)) return route.fulfill({ status: 200, contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(f), headers: { 'access-control-allow-origin': '*' } });
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
if (BLOCK_CDN) await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (route) => route.abort('internetdisconnected'));

const errors = [];
let page = null;
async function openPage() {
  if (page) await page.close().catch(() => {});
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return page;
}

// Один запуск: меню → пауза «человек читает меню» → «Начать» → «Разрешить камеру» → распознавание.
async function run(label) {
  resetNet();
  const p = await openPage();
  const t0 = Date.now();
  const nav = await p.goto(server.url, { waitUntil: 'commit' }).then(() => null, (e) => String(e.message || e).split('\n')[0]);
  const booted = !nav && await p.waitForFunction(() => !!(window.__ASHEN__ && window.__aoT), null, { timeout: 60000, polling: 100 }).then(() => true, () => false);
  const bootErr = booted ? null : nav ? nav : await p.evaluate(() => { const b = document.getElementById('ao-boot'); return b ? b.innerText.replace(/\s+/g, ' ').slice(0, 220) : 'нет #ao-boot'; }).catch(() => 'страница не открылась');
  const tMenu = booted ? Math.round(await p.evaluate(() => window.__aoT.menu)) : null;
  const out = { label, booted, bootErr, tMenu, wallMenu: Date.now() - t0 };
  await p.screenshot({ path: join(OUT, `${label}_1_menu.png`) }).catch(() => {});
  if (!booted) { out.net = summary(); return out; }
  await p.waitForFunction(() => { const a = window.__ASHEN__.worldAssets && window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 90000, polling: 250 }).catch(() => {});
  out.tAssets = Math.round(await p.evaluate(() => performance.now()));
  await sleep(MENU_WAIT);
  out.preload = await p.evaluate(() => (window.__aoOffline ? window.__aoOffline.state() : null)).catch(() => null);
  const btn = (text) => p.locator('button:visible', { hasText: text }).first();
  await btn('Начать').click();
  await p.waitForFunction(() => window.__ASHEN__.screen === 'camera', null, { timeout: 10000, polling: 50 }).catch(() => {});
  const tClick = await p.evaluate(() => performance.now());
  await btn('Разрешить камеру').click();
  const st = await p.waitForFunction(() => { const t = window.__ASHEN__.tracking; return t && ['ready', 'lost', 'calibrating', 'error'].includes(t.status) && t.status; }, null, { timeout: 120000, polling: 50 })
    .then((h) => h.jsonValue(), () => 'timeout');
  const tReady = await p.evaluate(() => performance.now());
  out.camera = { status: st, ms: Math.round(tReady - tClick) };
  out.tracking = await p.evaluate(() => { const t = window.__ASHEN__.tracking; return { status: t.status, message: t.message, mode: t.mode, delegate: t.delegate, handsReady: !!(t.hands && t.hands.ready), model: t.debug && t.debug.poseModel }; }).catch(() => null);
  // распознавание реально обрабатывает кадры
  await sleep(2500);
  out.inference = await p.evaluate(() => { const t = window.__ASHEN__.tracking; const d = t.debug || {}; return { hz: d.inferenceHz, results: d.results, mode: t.mode, handsReady: !!(t.hands && t.hands.ready) }; }).catch(() => null);
  await p.screenshot({ path: join(OUT, `${label}_2_camera.png`) }).catch(() => {});
  out.net = summary();
  return out;
}
function summary() {
  const swHits = net0.reqs.filter((r) => r.fromSW).length;
  return { requests: net0.reqs.length, fromSW: swHits, networkMB: +(net0.bytes / 1048576).toFixed(2), hosts: [...net0.hosts], failed: net0.failed.slice(0, 8) };
}

const report = { url: server.url, menuWaitMs: MENU_WAIT, runs: [] };
try {
  // 1. первый запуск: сеть есть
  const first = await run('first');
  report.runs.push(first);
  console.log('первый запуск:', JSON.stringify(first));
  // дождаться, пока service worker заберёт в кэш всё нужное для офлайна
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const r = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((res) => setTimeout(() => res(false), 15000))]);
    const t0 = performance.now();
    if (window.__aoOffline && window.__aoOffline.whenReady) await Promise.race([window.__aoOffline.whenReady(), new Promise((res) => setTimeout(res, 90000))]);
    return { supported: true, ready: r, controlled: !!navigator.serviceWorker.controller, waitMs: Math.round(performance.now() - t0), state: window.__aoOffline ? window.__aoOffline.state() : null };
  }).catch((e) => ({ error: String(e) }));
  report.sw = sw;
  console.log('service worker:', JSON.stringify(sw));

  // 2. второй запуск: сеть есть, всё из кэша
  const second = await run('second');
  report.runs.push(second);
  console.log('второй запуск:', JSON.stringify(second));

  // 3. третий запуск: сети нет совсем
  await ctx.setOffline(true);
  const offline = await run('offline');
  report.runs.push(offline);
  console.log('офлайн:', JSON.stringify(offline));
  await ctx.setOffline(false);

  check('первый запуск: игра стартовала', first.booted, first.bootErr || `меню за ${first.tMenu} мс`);
  check('первый запуск: распознавание запустилось', first.camera && first.camera.status !== 'error' && first.camera.status !== 'timeout', first.camera && `${first.camera.status} за ${first.camera.ms} мс`);
  check('service worker управляет страницей', !!(sw && sw.controlled), JSON.stringify(sw).slice(0, 200));
  check('второй запуск: игра стартовала', second.booted, second.bootErr || `меню за ${second.tMenu} мс`);
  check('второй запуск: по сети почти ничего (код и библиотеки из кэша)', second.net && second.net.networkMB < 1.5, second.net && `${second.net.networkMB} МБ по сети, из SW ${second.net.fromSW}/${second.net.requests}`);
  check('офлайн: игра стартовала', offline.booted, offline.bootErr || `меню за ${offline.tMenu} мс`);
  check('офлайн: модель распознавания инициализировалась', !!(offline.camera && ['ready', 'lost', 'calibrating'].includes(offline.camera.status)), offline.camera && `${offline.camera.status} за ${offline.camera.ms} мс; ${JSON.stringify(offline.tracking)}`);
  check('офлайн: кадры обрабатываются', !!(offline.inference && offline.inference.hz > 0), JSON.stringify(offline.inference));
  check('офлайн: внешних хостов нет', offline.net && offline.net.hosts.every((h) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h)), offline.net && offline.net.hosts.join(', '));
  const errs = errors.filter((e) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:|favicon|ERR_INTERNET_DISCONNECTED|net::ERR_/.test(e));
  check('нет ошибок страницы', errs.length === 0, errs.slice(0, 4).join(' | '));
} finally {
  report.results = results;
  writeFileSync(join(OUT, 'offline_report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  server.kill();
}
console.log(`\n${results.length - failures}/${results.length} PASS · отчёт и скриншоты: ${OUT}`);
process.exit(failures && !REPORT ? 1 : 0);
