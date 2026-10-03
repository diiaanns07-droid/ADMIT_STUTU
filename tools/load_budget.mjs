// Замер веса и времени загрузки в headless Chromium (Playwright).
// node tools/load_budget.mjs [--cdn DIR] [--mbit 8] [--rtt 40] [--out DIR] [--tag before] [--only menu,fight,track] [--runs 3]
//   --cdn DIR   локальное зеркало cdn.jsdelivr.net/npm: DIR/node_modules/<пакет>/… (или DIR/<пакет>-<версия>/package/…)
//   --mbit N    ширина канала, Мбит/с (0 — без ограничения); --rtt — задержка ответа, мс
//   --shots     кадры витрины меню каждые 2 с первых 40 с (диафильм «что видит жюри»)
//   --gzip      текстовые ответы (js, css, html, json) идут по каналу сжатыми, как на GitHub Pages;
//               в отчёте тогда два числа: байты по сети (wire) и распакованные
//   --par       [W5-СТАРТ] KHR_parallel_shader_compile и в SwiftShader (флаг ANGLE): шейдеры собираются в потоках драйвера,
//               как на настоящей видеокарте с Chrome (bootCompile, compileAsync); без флага — путь программного рендера
//   --prod      [W5-СТАРТ] сайт «как на GitHub Pages»: адрес ashen.test (не 127.0.0.1) — service worker кэширует код и ассеты,
//               offline.js качает MediaPipe в меню (на 127.0.0.1 оба отключены: сервер рядом)
//   --warm      [W5-СТАРТ] повторный запуск с офлайн-кэшем: первый заход (не в отчёт) ставит service worker и докачку,
//               замер — второй заход в том же профиле (включает --prod)
//   --runs N    [W5-СТАРТ] N прогонов каждого сценария, в отчёте — медиана вех (облачная машина шумит на ±2 с)
//   --menu-wait S  [W5-СТАРТ] fight: сколько секунд игрок смотрит на героиню в меню перед «Играть» (по умолчанию 0)
// Сценарии (каждый — в новом профиле, без кэша):
//   menu  — до меню на экране (заставка снята и показан первый кадр), до героя на витрине (hero.ready) и сколько
//           докачивается в меню; вехи ao:* из main.js (performance.mark) — в отчёте отдельно;
//   fight — меню → «Отладка с клавиатуры» → «Играть» → «Продолжить без камеры» → «В бой»: время и байты от «Играть»
//           до первого кадра боя на экране (play→fight), длинные кадры (> 250 мс) за следующие 15 с боя;
//   track — меню → «Начать» → «Разрешить камеру» (фейковая камера): байты до работающего трекинга.
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
const PAR = argv.includes('--par');                       // [W5-СТАРТ]
const WARM = argv.includes('--warm');
const PROD = WARM || argv.includes('--prod');
const RUNS = Math.max(1, +argOf('--runs', '1') || 1);
const MENU_WAIT = Math.max(0, +argOf('--menu-wait', '0') || 0) * 1000;
const HOST = 'ashen.test';
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
// [W5-СТАРТ] меню на экране: заставка снята (boot.done) и после этого показан кадр — одинаково для старого и нового кода
// (с параллельной сборкой window.__ASHEN__ появляется раньше, чем заставка снимается). Время — по часам страницы.
const MENU_PROBE = () => {
  // boot.done в index.html пишет window.__aoBootMs сразу после requestAnimationFrame(frame) — наш колбэк кадра
  // идёт следом за первым кадром игры, setTimeout — после его работы
  let v;
  Object.defineProperty(window, '__aoBootMs', { configurable: true, get: () => v, set: (x) => {
    v = x;
    if (!window.__aoMenuAt) requestAnimationFrame(() => setTimeout(() => { if (!window.__aoMenuAt) window.__aoMenuAt = performance.now(); }, 0));
  } });
};
async function runScenario(browser, base, name, steps) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
  await ctx.addInitScript(MENU_PROBE);
  if (WARM) {
    // первый заход: service worker, код и ассеты в кэше, докачка offline.js — не в отчёт
    const p0 = await ctx.newPage();
    await p0.goto(base + '?uncapped=1', { waitUntil: 'commit' });
    await p0.waitForFunction(() => window.__aoOffline && window.__aoOffline.state().ready, null, { timeout: 600000, polling: 500 }).catch(() => {});
    await p0.close();
  }
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
  const mark = (k, at) => { const t = Number.isFinite(at) ? at : now(); marks[k] = { t, bytes: bytesAt(t), wire: bytesAt(t, 'wire') }; return marks[k]; };
  // [W5-СТАРТ] веха по часам страницы (performance.now от начала навигации) → в часы сценария
  const pageMark = async (k, fn) => { const pt = await page.evaluate(fn).catch(() => null); return Number.isFinite(pt) ? mark(k, Math.round(navT0 + pt)) : mark(k); };
  t0.v = Date.now();
  let navT0 = 0;
  await page.goto(base + '?uncapped=1', { waitUntil: 'commit' });
  navT0 = (await page.evaluate(() => performance.timeOrigin).catch(() => t0.v)) - t0.v;   // часы страницы → часы сценария
  const shots = [];
  try { await steps({ page, mark, now, sleep, log, shots, marks, pageMark }); } catch (e) { errors.push('сценарий: ' + (e && e.message)); }
  mark('end');
  // [W5-СТАРТ] вехи main.js (performance.mark ao:*) — по часам страницы
  const ao = await page.evaluate(() => performance.getEntriesByType('mark').filter((m) => m.name.startsWith('ao:')).map((m) => [m.name.slice(3), Math.round(m.startTime)])).catch(() => []);
  const files = {};
  for (const r of log) { const k = r.url.replace(/\?.*$/, ''); files[k] = (files[k] || 0) + r.bytes; }
  await ctx.close();
  return { name, marks, ao, files, requests: log.length, errors: errors.slice(0, 20), shots, log };
}

const waitFor = async (page, fn, timeout, arg) => { await page.waitForFunction(fn, arg, { timeout, polling: 100 }); };

async function main() {
  const { chromium } = loadPlaywright();
  const exe = existsSync('/opt/pw-browsers/chromium') && statSync('/opt/pw-browsers/chromium').isFile() ? '/opt/pw-browsers/chromium'
    : existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
  const srv = await startServer();
  const port = srv.address().port;
  const base = PROD ? `http://${HOST}:${port}/` : `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
      ...(PAR ? ['--enable-angle-features=enableParallelCompileAndLink'] : []),   // [W5-СТАРТ] путь настоящей видеокарты
      // [W5-СТАРТ] «удалённый сайт»: ashen.test ведёт на сервер замера, http считается безопасным (service worker, камера)
      ...(PROD ? [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${port}`] : [])],
  });
  const results = [];
  const TO = MBIT > 0 ? 240000 : 120000;

  for (let run = 0; run < RUNS; run++) {   // [W5-СТАРТ] --runs: медиана
  if (ONLY.includes('menu')) results.push(await runScenario(browser, base, 'menu', async ({ page, mark, sleep, log, shots, now, pageMark }) => {
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
    await waitFor(page, () => !!window.__aoMenuAt, TO); await pageMark('menu', () => window.__aoMenuAt);   // [W5-СТАРТ] заставка снята + кадр
    await waitFor(page, () => { const h = window.__ASHEN__.hero(); return h && h.ready; }, TO)
      .then(() => pageMark('heroReady', () => { const t = window.__ASHEN__.hero().timing; return t && t.t0 + t.ready; })).catch(() => {});
    // жители деревни: если стартуют в меню — видно по stats()
    let last = log.length, quiet = 0;
    for (let i = 0; i < 120 && quiet < 8; i++) { await sleep(1000); if (log.length === last) quiet++; else { quiet = 0; last = log.length; } }
    mark('menuIdle');
    const v = await page.evaluate(() => { const w = window.__ASHEN__.worldAssets && window.__ASHEN__.worldAssets(); return { hero: window.__ASHEN__.hero(), screen: window.__ASHEN__.screen }; }).catch(() => null);
    if (v) mark('_info').info = v;
    shooting = false; await shotP;
  }));

  // [W5-СТАРТ] меню (кнопка «Играть») → отладка с клавиатуры → «Продолжить без камеры» → «В бой» (если есть) → бой.
  // «Играть» — когда героиня на витрине, как у игрока. play→fight — время входа в бой; длинные кадры — за первые 15 с боя.
  if (ONLY.includes('fight')) results.push(await runScenario(browser, base, 'fight', async ({ page, mark, sleep, pageMark }) => {
    await waitFor(page, () => !!window.__aoMenuAt, TO); await pageMark('menu', () => window.__aoMenuAt);
    await waitFor(page, () => { const h = window.__ASHEN__.hero(); return h && h.ready; }, TO)
      .then(() => pageMark('heroReady', () => { const t = window.__ASHEN__.hero().timing; return t && t.t0 + t.ready; })).catch(() => {});
    if (MENU_WAIT) { await sleep(MENU_WAIT); mark('menuWait'); }
    await page.evaluate(() => {   // момент входа в бой и длинные кадры после него — по часам страницы
      const fr = []; window.__aoFr = fr; let last = 0;
      const loop = (t) => {
        if (last && t - last > 250) fr.push([Math.round(last), Math.round(t - last)]);
        last = t;
        if (window.__aoFightAt && !window.__aoFightFrameAt && t > window.__aoFightAt) window.__aoFightFrameAt = t;   // первый кадр боя показан
        if (!window.__aoFightAt && ['intro', 'playing'].includes(window.__ASHEN__.screen)) window.__aoFightAt = t;
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    // клик — событием в странице, как у человека: обычный click Playwright ждёт «стабильности» кнопки (2–3 кадра),
    // а в SwiftShader кадр меню идёт секундами — замер мерил бы ожидание теста, а не игру
    await page.getByRole('button', { name: 'Отладка с клавиатуры' }).first().dispatchEvent('click', {}, { timeout: TO });
    await page.getByRole('button', { name: 'Играть' }).first().dispatchEvent('click', {}, { timeout: TO });
    await pageMark('play', () => performance.now());
    await page.getByRole('button', { name: /Продолжить без камеры/ }).first().dispatchEvent('click', {}, { timeout: TO });
    for (let i = 0; i < 1200; i++) {
      if (await page.evaluate(() => !!window.__aoFightAt)) break;
      const b = page.getByRole('button', { name: 'В бой' });
      if (await b.count() && await b.first().isEnabled().catch(() => false)) await b.first().dispatchEvent('click', {}, { timeout: 2000 }).catch(() => {});
      await sleep(200);
    }
    await pageMark('fight', () => window.__aoFightAt);
    await waitFor(page, () => !!window.__aoFightFrameAt, TO).catch(() => {});
    await pageMark('fightFrame', () => window.__aoFightFrameAt);
    await sleep(15000); mark('fight15s');
    const fr = await page.evaluate(() => window.__aoFr.filter((f) => f[0] > window.__aoFightAt && f[0] < window.__aoFightAt + 15000)).catch(() => []);   // после первого кадра боя
    mark('_frames').info = { long: fr.length, sum: fr.reduce((a, f) => a + f[1], 0), max: fr.reduce((a, f) => Math.max(a, f[1]), 0) };
  }));

  }   // [W5-СТАРТ] конец цикла --runs (track — один прогон)

  if (ONLY.includes('track')) results.push(await runScenario(browser, base, 'track', async ({ page, mark }) => {
    await waitFor(page, () => !!window.__ASHEN__, TO); mark('menu');
    await page.getByRole('button', { name: 'Начать' }).first().click();
    await page.getByRole('button', { name: 'Разрешить камеру' }).click();
    mark('cameraClick');
    await waitFor(page, () => { const s = window.__ASHEN__.tracking; return s && ['ready', 'lost', 'calibrating'].includes(s.status); }, TO * 2); mark('tracking');
  }));

  srv.close();
  await browser.close();
  const MB = (b) => (b / 1048576).toFixed(2);
  const s = (ms) => (ms / 1000).toFixed(1);
  const mode = [PAR ? 'параллельная сборка шейдеров (--par)' : 'программный рендер', PROD ? `сайт ${HOST}${WARM ? ', повторный запуск с офлайн-кэшем' : ''}` : '127.0.0.1'].join(', ');
  const lines = [`# load_budget ${TAG}: канал ${MBIT > 0 ? MBIT + ' Мбит/с, ' + RTT + ' мс' : 'без ограничения'}${GZIP ? ', текст сжат gzip' : ''}; ${mode}${RUNS > 1 ? `; прогонов: ${RUNS}` : ''}`, ''];
  const med = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
  for (const r of results) {
    lines.push(`## ${r.name} (${r.requests} запросов)`);
    for (const [k, m] of Object.entries(r.marks)) if (!k.startsWith('_')) lines.push(`- ${k}: ${s(m.t)} с, ${MB(m.bytes)} МБ${GZIP ? ` (по сети ${MB(m.wire)} МБ)` : ''}`);
    if (r.marks.play && r.marks.fightFrame) lines.push(`- play→fight (до первого кадра боя): ${s(r.marks.fightFrame.t - r.marks.play.t)} с`);   // [W5-СТАРТ]
    if (r.marks._frames) lines.push(`- кадры > 250 мс за первые 15 с боя: ${r.marks._frames.info.long} шт., ${s(r.marks._frames.info.sum)} с, худший ${s(r.marks._frames.info.max)} с`);
    if (r.ao && r.ao.length) lines.push(`- вехи main.js (ao:*, часы страницы): ${r.ao.map(([n, t]) => `${n} ${s(t)}`).join(' · ')}`);
    const top = Object.entries(r.files).sort((a, b) => b[1] - a[1]).slice(0, 25);
    lines.push('', '| файл | МБ |', '|---|---|', ...top.map(([f, b]) => `| ${f} | ${MB(b)} |`), '');
    if (r.errors.length) lines.push('ошибки:', ...r.errors.map((e) => '  ' + e), '');
  }
  // [W5-СТАРТ] --runs: медиана вех по сценариям
  if (RUNS > 1) {
    lines.push('## медиана по прогонам', '', '| сценарий | веха | медиана, с | прогоны, с |', '|---|---|---|---|');
    for (const name of [...new Set(results.map((r) => r.name))]) {
      const rs = results.filter((r) => r.name === name);
      const keys = [...new Set(rs.flatMap((r) => Object.keys(r.marks).filter((k) => !k.startsWith('_'))))];
      if (rs.some((r) => r.marks.play && r.marks.fightFrame)) keys.push('play→fight');
      for (const k of keys) {
        const v = rs.map((r) => (k === 'play→fight' ? (r.marks.fightFrame && r.marks.play ? r.marks.fightFrame.t - r.marks.play.t : NaN) : r.marks[k] ? r.marks[k].t : NaN));
        lines.push(`| ${name} | ${k} | ${s(med(v))} | ${v.map((x) => (Number.isFinite(x) ? s(x) : '—')).join(' · ')} |`);
      }
    }
    lines.push('');
  }
  const txt = lines.join('\n');
  console.log(txt);
  writeFileSync(join(OUT, `${TAG}.md`), txt);
  writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify({ mbit: MBIT, rtt: RTT, gzip: GZIP, par: PAR, prod: PROD, warm: WARM, runs: RUNS, results }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
