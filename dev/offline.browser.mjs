// [OFFLINE] Игра без интернета: первый запуск онлайн → context.setOffline(true) → перезагрузка.
// Проверяет, что повторный запуск стартует целиком из кэша service worker (sw.js) и что модель
// распознавания (MediaPipe: модуль, WASM, модели позы и кистей) инициализируется без сети.
// Печатает цифры: время до меню, время «Играть» → распознавание работает, байты по сети.
//
//   node dev/offline.browser.mjs [--mbps 25] [--menu-wait 8000] [--out DIR] [--browser PATH] [--no-before] [--draw] [--gpu] [--report]
//
//   --mbps N      сеть площадки: все запросы идут через прокси с общей полосой N Мбит/с (0 — без ограничения)
//   --menu-wait   сколько «человек смотрит меню» перед «Играть» (сразу просит камеру), мс
//   --no-before   без прогона «до» (?sw=0&preload=0: MediaPipe качается только после нажатия, как раньше)
//   --draw        рисовать WebGL всегда (по умолчанию выключено между скриншотами: в headless рендер
//                 программный и съедает CPU — worker MediaPipe тогда не успевает за 30 с)
//   --gpu         MediaPipe на GPU-делегате (по умолчанию CPU: GPU в SwiftShader прогревается десятки секунд)
//   --report      не падать на проверках (замер старой сборки)
//   --loopback    открыть как http://127.0.0.1 (START_GAME.cmd), а не как удалённый сайт http://ashen.test
// Сервер поднимается сам (serve_game.py на свободном порту). Фейковая камера Chromium показывает узор
// без человека: «работает» = распознавание запущено и обрабатывает кадры, а не найдено тело.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_offline')));
const REPORT = argv.includes('--report');
const DRAW = argv.includes('--draw');
const GPU = argv.includes('--gpu');
const BEFORE = !argv.includes('--no-before');
const MBPS = +argOf('--mbps', 25);
const MENU_WAIT = +argOf('--menu-wait', 8000);
// По умолчанию игра открывается как удалённый сайт (http://ashen.test → 127.0.0.1, как GitHub Pages):
// на 127.0.0.1 sw.js нарочно берёт код и ассеты сначала с локального сервера. --loopback — проверить и это.
const LOOPBACK = argv.includes('--loopback');
let pw;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(p); break; } catch (e) { /* дальше */ } }
if (!pw) { console.error('playwright не найден'); process.exit(2); }
const exe = argOf('--browser', ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => +(n / 1048576).toFixed(2);

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line); console.log(line);
  if (!ok) failures++;
}

// ── сервер игры ──
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
  return { port, kill: () => { try { py.kill(); } catch (e) { /* уже */ } } };
}

// ── «Wi-Fi площадки»: прокси с общей полосой MBPS и задержкой 30 мс на запрос ──
// Счётчик байт — всё, что реально прошло по «сети» (без service worker и HTTP-кэша браузера).
const wire = { bytes: 0, log: [], down: false };
async function startThrottle(target) {
  const rate = MBPS > 0 ? (MBPS * 1e6) / 8 / 1000 : 0;   // байт в мс
  let nextFree = 0;
  // одна общая «труба»: кусок ждёт своей очереди, как в настоящем канале
  const slot = (n) => { const now = Date.now(); nextFree = Math.max(now, nextFree) + n / rate; return new Promise((r) => setTimeout(r, Math.ceil(nextFree - now))); };
  const agent = new http.Agent({ keepAlive: false, maxSockets: 6 });   // как браузер: 6 соединений на хост
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    if (wire.down) { req.socket.destroy(); return; }   // сети нет: соединение рвётся сразу
    wire.log.push(req.url);
    let closed = false;
    res.on('close', () => { closed = true; });
    const up = http.request({ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers, agent }, (r) => {
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', async () => {
        const body = Buffer.concat(parts);
        if (closed) return;
        if (MBPS > 0) await new Promise((t) => setTimeout(t, 30));   // задержка запроса
        res.writeHead(r.statusCode, { ...r.headers, 'content-length': String(body.length) });
        for (let i = 0; i < body.length; i += 32768) {
          const piece = body.subarray(i, i + 32768);
          if (rate) await slot(piece.length);
          if (closed) return;   // страница закрыта или запрос отменён — дальше не качать
          wire.bytes += piece.length;
          res.write(piece);
        }
        res.end();
      });
    });
    up.on('error', () => { if (closed) return; try { res.writeHead(502); res.end(); } catch (e) { /* ignore */ } });
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, url: `http://${LOOPBACK ? '127.0.0.1' : 'ashen.test'}:${port}/`, close: () => srv.close() };
}

const server = await startServer();
const proxy = await startThrottle(server.port);
const browser = await pw.chromium.launch({
  executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // «удалённый сайт»: имя ashen.test ведёт на прокси, а http считается безопасным (камера и service worker)
    ...(LOOPBACK ? [] : ['--host-resolver-rules=MAP ashen.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${proxy.url.replace(/\/$/, '')}`])],
});

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'], ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('ashen-oath.settings.v1')) localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', qualityAuto: false, reducedMotion: true })); } catch (e) { /* ignore */ } });
  // точное время появления window.__ASHEN__ (main.js выполнился — меню на экране)
  await ctx.addInitScript(() => {
    let v;
    Object.defineProperty(window, '__ASHEN__', { configurable: true, get: () => v, set: (x) => { v = x; if (!window.__aoT) window.__aoT = { menu: performance.now() }; } });
  });
  if (!DRAW) {
    await ctx.addInitScript(() => {
      window.__aoNoDraw = true;
      for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!C) continue;
        for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
          const f = C.prototype[k];
          if (typeof f === 'function') C.prototype[k] = function (...a) { if (window.__aoNoDraw) return undefined; return f.apply(this, a); };
        }
      }
    });
  }
  if (!GPU) {
    // MediaPipe в worker на CPU-делегате (только для теста: GPU в SwiftShader прогревается десятки секунд)
    await ctx.addInitScript(() => {
      const pm = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { if (m && m.type === 'init' && m.delegate) m = { ...m, delegate: 'CPU' }; return pm.call(this, m, ...rest); };
    });
  }
  const errors = [];
  ctx.on('page', (p) => {
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  });
  return { ctx, errors };
}

async function shot(p, name) {
  try {
    await p.evaluate(() => { window.__aoNoDraw = false; });
    await sleep(DRAW ? 300 : 1500);
    await p.screenshot({ path: join(OUT, name) });
    await p.evaluate(() => { window.__aoNoDraw = true; });
  } catch (e) { /* ignore */ }
}

// Один запуск: меню → «человек смотрит меню» → «Играть» (сразу просит камеру) → распознавание.
async function run(ctx, label, query = '', opts = {}) {
  const p = await ctx.newPage();
  const w0 = wire.bytes;
  const l0 = wire.log.length;
  const t0 = Date.now();
  const nav = await p.goto(proxy.url + query, { waitUntil: 'commit' }).then(() => null, (e) => String(e.message || e).split('\n')[0]);
  if (opts.bootShot && !nav) {
    // заставка с полосой прогресса посреди загрузки
    await p.waitForFunction(() => { const b = window.__aoBoot && window.__aoBoot.progress && window.__aoBoot.progress(); return b && b.pct >= 25; }, null, { timeout: 20000, polling: 30 }).catch(() => {});
    await p.screenshot({ path: join(OUT, `${label}_0_boot.png`) }).catch(() => {});
  }
  const booted = !nav && await p.waitForFunction(() => !!(window.__ASHEN__ && window.__aoT), null, { timeout: 90000, polling: 100 }).then(() => true, () => false);
  const bootErr = booted ? null : nav || await p.evaluate(() => { const b = document.getElementById('ao-boot'); return b ? b.innerText.replace(/\s+/g, ' ').slice(0, 220) : 'нет #ao-boot'; }).catch(() => 'страница не открылась');
  const out = { label, query, booted, bootErr, menuMs: booted ? Math.round(await p.evaluate(() => window.__aoT.menu)) : null };
  if (!booted) { await p.screenshot({ path: join(OUT, `${label}_1_menu.png`) }).catch(() => {}); out.wireMB = MB(wire.bytes - w0); return { out, page: p }; }
  await sleep(MENU_WAIT);
  out.offline = await p.evaluate(() => (window.__aoOffline ? window.__aoOffline.state() : null)).catch(() => null);
  await shot(p, `${label}_1_menu.png`);
  // [W5-КАМЕРА] быстрый вход: «Играть» сразу просит камеру — кнопок «Начать» и «Разрешить камеру» больше нет
  const btn = (text) => p.getByRole('button', { name: text, exact: true }).first();
  const tClick = await p.evaluate(() => performance.now());
  await btn('Играть').click();
  await p.waitForFunction(() => window.__ASHEN__.screen === 'camera', null, { timeout: 10000, polling: 50 }).catch(() => {});
  // распознавание запущено: статус ready/lost/calibrating и пришёл хотя бы один результат
  const st = await p.waitForFunction(() => { const t = window.__ASHEN__.tracking; const ok = t && ['ready', 'lost', 'calibrating'].includes(t.status) && t.debug && t.debug.results > 0; return ok ? t.status : (t && t.status === 'error' ? 'error' : false); }, null, { timeout: 120000, polling: 50 })
    .then((h) => h.jsonValue(), () => 'timeout');
  out.cameraMs = Math.round((await p.evaluate(() => performance.now())) - tClick);
  out.cameraStatus = st;
  await sleep(2500);
  out.tracking = await p.evaluate(() => { const t = window.__ASHEN__.tracking; const d = t.debug || {}; return { status: t.status, message: t.message, mode: t.mode, delegate: t.delegate, hands: !!(t.hands && t.hands.ready), model: d.poseModel, hz: d.inferenceHz, results: d.results, fallback: d.workerFallbackReason }; }).catch(() => null);
  await shot(p, `${label}_2_camera.png`);
  out.wireMB = MB(wire.bytes - w0);
  out.wireReq = wire.log.length - l0;
  out.wireSample = wire.log.slice(l0).filter((u) => !/\.(js|css|html)(\?|$)|^\/(\?|$)/.test(u)).slice(0, 12);
  out.wallMs = Date.now() - t0;
  return { out, page: p };
}

const report = { url: proxy.url, mbps: MBPS, menuWaitMs: MENU_WAIT, gpu: GPU, draw: DRAW, runs: [] };
const log = (o) => { report.runs.push(o); console.log(`${o.label}:`, JSON.stringify(o)); };
try {
  // 0. «до»: без предзагрузки и service worker — MediaPipe качается после нажатия, как раньше
  let before = null;
  if (BEFORE) {
    const { ctx } = await newContext();
    ({ out: before } = await run(ctx, 'before', '?sw=0&preload=0'));
    log(before);
    await ctx.close();
  }

  // 1. первый запуск: сеть есть
  const { ctx, errors } = await newContext();
  const r1 = await run(ctx, 'first', '', { bootShot: true });
  const first = r1.out;
  log(first);
  // service worker забирает в кэш всё для игры без сети
  const sw = await r1.page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const t0 = performance.now();
    const st = window.__aoOffline ? await Promise.race([window.__aoOffline.whenReady(), new Promise((r) => setTimeout(r, 240000))]) : null;
    return { supported: true, controlled: !!navigator.serviceWorker.controller, waitMs: Math.round(performance.now() - t0), state: st || (window.__aoOffline && window.__aoOffline.state()) };
  }).catch((e) => ({ error: String(e) }));
  report.sw = sw;
  console.log('service worker:', JSON.stringify(sw));
  await r1.page.close();

  // 2. второй запуск: сеть есть, всё из кэша
  const { out: second, page: p2 } = await run(ctx, 'second');
  log(second);
  await p2.close();

  // 3. сети нет совсем: браузер офлайн и «сервер» недоступен (прокси рвёт соединения) —
  // setOffline в Chromium не всегда действует на service worker и worker, поэтому оба способа
  await ctx.setOffline(true);
  wire.down = true;
  const { out: off, page: p3 } = await run(ctx, 'offline');
  log(off);
  await p3.close();
  await ctx.setOffline(false);
  wire.down = false;

  const works = (o) => !!o && ['ready', 'lost', 'calibrating'].includes(o.cameraStatus);
  if (before) check('«до» (без предзагрузки и sw): распознавание запустилось', works(before), `${before.cameraStatus} за ${before.cameraMs} мс`);
  check('первый запуск: игра стартовала', first.booted, first.bootErr || `меню за ${first.menuMs} мс`);
  if (!LOOPBACK) {
    const pre = first.offline && first.offline.preload;
    check('первый запуск: MediaPipe качается заранее, пока открыто меню', !!pre && ['loading', 'done'].includes(pre.status) && pre.loaded > 0,
      pre ? `${pre.status}, ${MB(pre.loaded)} из ${MB(pre.total)} МБ за ${MENU_WAIT / 1000} с меню` : 'нет состояния');
  }
  check('первый запуск: распознавание запустилось', works(first), `${first.cameraStatus} за ${first.cameraMs} мс`);
  if (before && works(before) && works(first)) check('«Играть» → распознавание быстрее, чем без предзагрузки', first.cameraMs < before.cameraMs, `${before.cameraMs} → ${first.cameraMs} мс`);
  check('service worker управляет страницей' + (LOOPBACK ? '' : ' и докачал всё'), !!(sw && sw.controlled && sw.state && sw.state.ready && sw.state.warm.errors === 0 && (LOOPBACK || sw.state.warm.status === 'done')), JSON.stringify(sw).slice(0, 240));
  check('второй запуск: игра стартовала', second.booted, second.bootErr || `меню за ${second.menuMs} мс`);
  if (!LOOPBACK) check('второй запуск: по сети меньше 0,5 МБ (только сверка 304)', second.wireMB < 0.5, `${second.wireMB} МБ, запросов ${second.wireReq}`);
  check('второй запуск: распознавание запустилось', works(second), `${second.cameraStatus} за ${second.cameraMs} мс`);
  check('офлайн: игра стартовала', off.booted, off.bootErr || `меню за ${off.menuMs} мс`);
  check('офлайн: модель распознавания инициализировалась и обрабатывает кадры', works(off) && !!off.tracking && off.tracking.results > 0, `${off.cameraStatus} за ${off.cameraMs} мс; ${JSON.stringify(off.tracking)}`);
  check('офлайн: кисти (HandLandmarker) тоже готовы', !!(off.tracking && off.tracking.hands), JSON.stringify(off.tracking));
  // [W5-КАМЕРА] медленный кадр — ступень ниже в воркере (CPU), а не главный поток: раньше здесь был откат
  // «worker не ответил на кадр за 2500 мс» → главный поток, 0,5 распознавания в секунду и «Нет новых кадров с камеры»
  for (const o of [first, second, off]) if (works(o) && o.tracking) check(`${o.label}: распознавание в воркере, не в главном потоке`, o.tracking.mode === 'worker', JSON.stringify(o.tracking));
  check('офлайн: по сети 0 байт', off.wireMB === 0, `${off.wireMB} МБ`);
  const errs = errors.filter((e) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:|favicon|ERR_INTERNET_DISCONNECTED|net::ERR_|Failed to load resource/.test(e));
  check('нет ошибок страницы', errs.length === 0, errs.slice(0, 4).join(' | '));

  console.log('\nЦифры (сеть ' + (MBPS ? MBPS + ' Мбит/с' : 'без ограничения') + `, меню ${MENU_WAIT / 1000} с перед камерой):`);
  for (const o of report.runs) console.log(`  ${o.label.padEnd(7)} меню ${String(o.menuMs ?? '—').padStart(6)} мс · камера ${String(o.cameraMs ?? '—').padStart(6)} мс (${o.cameraStatus || o.bootErr}) · по сети ${o.wireMB} МБ`);
  await ctx.close();
} finally {
  report.results = results;
  writeFileSync(join(OUT, 'offline_report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  proxy.close();
  server.kill();
}
console.log(`\n${results.length - failures}/${results.length} PASS · отчёт и скриншоты: ${OUT}`);
process.exit(failures && !REPORT ? 1 : 0);
