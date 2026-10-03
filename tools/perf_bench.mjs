// [PERF] Замер игры на настоящем железе ноутбука: появление героя, распознавание (MediaPipe) и кадр боя,
// на встроенной и дискретной видеокарте. Только node + Chromium по CDP (как tools/qa_shots.mjs), без Playwright.
//
// node tools/perf_bench.mjs [--gpu amd|nvidia|both] [--browser PATH] [--root DIR] [--label NAME] [--out DIR]
//                           [--sec 20] [--size 1280x720] [--port 8793] [--phases load,warm,switch,vision,fight,fightcam,vbench]
//                           [--vbench GPU,CPU] [--vbwidth 640,480] [--vbextra "poseEvery=2"] [--query cursor=0] [--video cam.y4m]
//
// Браузер: по умолчанию Microsoft Edge (тот же Chromium): без флагов headless Edge на гибридном ноутбуке
// рендерит на встроенной видеокарте, с --force_high_performance_gpu — на дискретной. (Для Chrome на этой
// машине задано системное «Высокая производительность», поэтому A/B на нём невоспроизводим.)
// Камера — поддельная (--use-fake-device-for-media-stream): в кадре нет человека, модель кистей каждый
// кадр ищет ладони заново (детектор) — худший случай по времени. Настоящая камера НЕ открывается.
//
// Фазы:
//   load     — холодный запуск (новый профиль): время до героя (модель), этапы загрузки, кадры с процедурным героем
//   warm     — второй запуск (service worker уже установлен)
//   switch   — смена героя в меню: archmage → elf → ashen
//   vision   — ?benchcam=1: камера с меню, распознавание + сцена меню
//   fight    — бой в «Отладке с клавиатуры» без камеры: к/с, мс GPU, draw calls
//   fightcam — тот же бой с камерой (?benchcam=1): бой и MediaPipe на одной видеокарте
//   vbench   — dev/vision-bench.html: только распознавание, матрица делегат × ширина кадра
// Результат — JSON в --out и таблица в консоли. --root — другая папка игры (например, git archive старой версии).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const LABEL = argOf('--label', 'run');
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_perf_bench', LABEL)));
const SEC = +argOf('--sec', '20');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const PORT = +argOf('--port', '8793');
const GPUS = { amd: ['amd'], nvidia: ['nvidia'], both: ['amd', 'nvidia'] }[argOf('--gpu', 'both')] || ['amd', 'nvidia'];
const PHASES = argOf('--phases', 'load,warm,switch,vision,fight,fightcam,vbench').split(',');
const VB_DELEGATES = argOf('--vbench', 'GPU,CPU').split(',').filter(Boolean);
const VB_WIDTHS = argOf('--vbwidth', '640').split(',').map(Number);
const VB_EXTRA = argOf('--vbextra', '');
// добавка к адресу игры во всех фазах, например cursor=0: в меню камера для курсора-кисти не включается
// (с поддельным разрешением камеры она стартует сама и грузит MediaPipe во время появления героя)
const QUERY = argOf('--query', 'cursor=0');
// --video FILE.y4m — поток поддельной камеры из файла (640×480, 30 к/с — как настоящая веб-камера; без него встроенная
// поддельная камера Chromium даёт 20 к/с, а на встроенной AMD в Edge — кадры 2×2). Файл делает make_y4m.py (см. README замера).
const VIDEO = argOf('--video', '');
const BROWSER = [argOf('--browser'), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/opt/pw-browsers/chromium'].filter(Boolean).find((p) => existsSync(p)); // [W5-КАМЕРА] + Chromium Playwright (Linux)
if (!BROWSER) { console.error('браузер не найден'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const b = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y); return b.length ? +b[b.length >> 1].toFixed(1) : null; };
const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(1) : null);

function startServer() {
  const py = spawn('python', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 10000);
    const on = (d) => { out += d; if (/running/i.test(out)) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('server exit ' + c + ' ' + out)));
  });
}

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.log = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const p = new Page(ws);
    ws.onmessage = (m) => p.on(JSON.parse(m.data));
    await p.send('Runtime.enable'); await p.send('Page.enable'); await p.send('Log.enable');
    return p;
  }
  on(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      this.log.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails; this.log.push('EXC: ' + ((d.exception && d.exception.description) || d.text).slice(0, 300));
    }
  }
  send(method, params = {}, timeout = 90000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeout); });
  }
  async eval(expr, timeout) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 20000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = await this.eval(expr); if (v) return v; } catch (e) { /* ждём */ } await sleep(step); }
    return null;
  }
  click(label) {
    return this.eval(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
  }
  async key(code, type) {
    const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code;
    await this.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  }
  async hold(code, ms) { await this.key(code, 'keyDown'); await sleep(ms); await this.key(code, 'keyUp'); }
  async shot(name) {
    try { const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); } catch (e) { /* ignore */ }
  }
  errors() { return this.log.filter((l) => /^(error|EXC)/.test(l)); }
}

// Скрипт до загрузки документа: с первого кадра rAF следим за героем (готов / виден процедурный)
const BENCH_INIT = `
window.__bench = { firstAshen: null, heroReadyAt: null, heroReadyId: null, heroTiming: null, procFrames: 0, procFirst: null, procLast: null, menuFrames: 0,
  switchWant: null, switchReadyAt: null, switchTiming: null, longMs: 0, longMax: 0, longN: 0 };
// долгие задачи главного потока (блокировки > 50 мс): сумма и максимум
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { const B = window.__bench; B.longMs += e.duration; B.longN++; if (e.duration > B.longMax) B.longMax = e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
(function tick() {
  const A = window.__ASHEN__, B = window.__bench;
  if (A) {
    const now = performance.now();
    if (B.firstAshen === null) B.firstAshen = now;
    try {
      const h = A.hero();
      if (h) {
        if (h.procedural === true) { B.procFrames++; if (B.procFirst === null) B.procFirst = now; B.procLast = now; }
        if (h.ready && B.heroReadyAt === null) { B.heroReadyAt = now; B.heroReadyId = h.hero; B.heroTiming = h.timing || null; B.postGapMax = 0; B.prevT = now; }
        // первые 2 с после появления героя: самый длинный разрыв между кадрами (компиляция шейдеров героя)
        if (B.heroReadyAt !== null && now - B.heroReadyAt < 2000) { const g = now - B.prevT; if (g > B.postGapMax) B.postGapMax = g; B.prevT = now; }
        if (h.ready && B.switchWant !== null && h.hero === B.switchWant && B.switchReadyAt === null) { B.switchReadyAt = now; B.switchTiming = h.timing || null; }
      }
    } catch (e) {}
    if (A.screen === 'menu') B.menuFrames++;
  }
  requestAnimationFrame(tick);
})();
// сетевые тайминги файлов героя и MediaPipe: когда запрошены и когда пришли (мс от старта страницы)
window.__benchRes = () => performance.getEntriesByType('resource').filter((e) => /assets\\/heroes\\/|assets\\/quaternius\\/|vision_wasm|\\.task$|heroShading|heroGear|vision_bundle/.test(e.name))
  .map((e) => ({ f: e.name.split('/').pop(), start: Math.round(e.startTime), end: Math.round(e.responseEnd), ms: Math.round(e.duration), kb: Math.round((e.transferSize || e.decodedBodySize || 0) / 1024) }));
// замер N с: интервалы rAF + раз в 500 мс состояние (кадры, GPU, распознавание)
window.__benchRun = (sec) => new Promise((res) => {
  const A = window.__ASHEN__; const ts = []; const samp = []; const t0 = performance.now(); let lastS = -1e9;
  function tick(t) {
    ts.push(t);
    if (t - lastS >= 500) {
      lastS = t;
      let tr = null, d = {}, p = {}, ri = {};
      try { tr = A.tracking; d = (tr && tr.debug) || {}; } catch (e) {}
      try { p = A.perf() || {}; } catch (e) {}
      try { ri = A.renderInfo() || {}; } catch (e) {}
      samp.push({ t: Math.round(t - t0), fps: p.fps, gpuMs: p.gpuMs, cpuMs: p.cpuMs, scale: p.scale, tier: p.tier, capFps: p.capFps, lowMode: p.lowMode,
        hz: d.inferenceHz, inferMs: d.inferMs, handsMs: d.handsMs, latencyMs: d.latencyMs, camFps: d.cameraFps, skippedBusy: d.skippedBusy, results: d.results,
        poseEvery: d.poseEvery, poseHz: d.poseHz,
        status: tr && tr.status, mode: tr && tr.mode, delegate: tr && tr.delegate, poseModel: d.poseModel, cap: d.captureMaxWidth, video: d.video,
        calls: ri.calls, tris: ri.triangles, pr: ri.pixelRatio, screen: A.screen });
    }
    if (t - t0 < sec * 1000) requestAnimationFrame(tick); else res({ ts, samp });
  }
  requestAnimationFrame(tick);
});
`;

function summarizeRun(r, skipFrac = 0.25) {
  const dts = r.ts.slice(1).map((t, i) => t - r.ts[i]);
  const s = r.samp.slice(Math.floor(r.samp.length * skipFrac));
  const last = s[s.length - 1] || {};
  const p95 = dts.slice().sort((a, b) => a - b)[Math.floor(dts.length * 0.95)] || 0;
  return {
    rafFps: r1((dts.length * 1000) / Math.max(1, r.ts[r.ts.length - 1] - r.ts[0])), rafP95Ms: r1(p95),
    fps: med(s.map((x) => x.fps)), gpuMs: med(s.map((x) => x.gpuMs)), cpuMs: med(s.map((x) => x.cpuMs)),
    scale: last.scale, tier: last.tier, capFps: last.capFps, lowMode: last.lowMode, calls: med(s.map((x) => x.calls)), tris: med(s.map((x) => x.tris)), pixelRatio: last.pr,
    hz: med(s.map((x) => x.hz)), inferMs: med(s.map((x) => x.inferMs)), handsMs: med(s.map((x) => x.handsMs)), latencyMs: med(s.map((x) => x.latencyMs)), camFps: med(s.map((x) => x.camFps)),
    poseEvery: last.poseEvery, poseHz: med(s.map((x) => x.poseHz)), poseEveryFirst: r.samp.length ? r.samp[0].poseEvery : null,
    results: s.length ? (last.results || 0) - (s[0].results || 0) : null, status: last.status, mode: last.mode, delegate: last.delegate, poseModel: last.poseModel, cap: last.cap, video: last.video, screen: last.screen,
    samples: r.samp.map((x) => ({ t: x.t, fps: x.fps, gpuMs: x.gpuMs, hz: x.hz, poseHz: x.poseHz, poseEvery: x.poseEvery, inferMs: x.inferMs, handsMs: x.handsMs, latencyMs: x.latencyMs })),
  };
}

async function launch(gpu) {
  const profile = join(tmpdir(), `ashen_bench_${gpu}_${Date.now()}`);
  const dbg = 9700 + Math.floor(Math.random() * 90);
  const flags = ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--window-size=${W},${H}`, '--hide-scrollbars', '--ignore-gpu-blocklist', '--enable-gpu',
    // [W5-КАМЕРА] Windows — Direct3D 11; Linux без видеокарты (облако, CI) — программный SwiftShader, root — без песочницы
    ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [])]),
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
  if (gpu === 'nvidia') flags.push('--force_high_performance_gpu');
  if (VIDEO) flags.push(`--use-file-for-fake-video-capture=${resolve(VIDEO)}`);
  const proc = spawn(BROWSER, [...flags, 'about:blank'], { stdio: 'ignore' });
  let list = null;
  for (let i = 0; i < 80 && !list; i++) { await sleep(200); try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); } catch (e) { /* ждём */ } }
  if (!list) { proc.kill(); throw new Error('браузер не поднял CDP'); }
  const page = await Page.connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: BENCH_INIT });
  return { proc, page, profile };
}

async function openGame(page, query = '') {
  page.log.length = 0;
  const q = [QUERY, query.replace(/^\?/, '')].filter(Boolean).join('&');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${q ? '?' + q : ''}` });
  if (!(await page.waitFor('!!window.__ASHEN__', 40000))) throw new Error('игра не загрузилась');
}

// ── фазы ──
async function phaseLoad(page, name) {
  const t0 = Date.now();
  await openGame(page);
  await sleep(700);
  await page.shot(`${name}_0.7s`);
  const ready = await page.waitFor('__bench.heroReadyAt !== null', 30000, 50);
  await sleep(300);
  await page.shot(`${name}_ready`);
  const r = await page.eval(`({ bootMs: window.__aoBootMs, firstAshen: __bench.firstAshen, heroReadyAt: __bench.heroReadyAt, heroId: __bench.heroReadyId, timing: __bench.heroTiming,
    procFrames: __bench.procFrames, procFirst: __bench.procFirst, procLast: __bench.procLast, hero: __ASHEN__.hero(), perf: __ASHEN__.perf(), render: __ASHEN__.renderInfo(),
    long: { ms: Math.round(__bench.longMs), max: Math.round(__bench.longMax), n: __bench.longN }, res: __benchRes(), postGapMax: __bench.postGapMax,
    tracking: (() => { try { const t = __ASHEN__.tracking; return t ? t.status + (t.mode ? '/' + t.mode : '') : null; } catch (e) { return null; } })(),
    assets: __ASHEN__.worldAssets() && { pending: __ASHEN__.worldAssets().pending } })`);
  return {
    phase: name, ok: !!ready, wallMs: Date.now() - t0, bootMs: r.bootMs, firstAshenMs: r1(r.firstAshen), heroReadyMs: r1(r.heroReadyAt), heroId: r.heroId,
    heroAfterBootMs: r1(r.heroReadyAt !== null && r.firstAshen !== null ? r.heroReadyAt - r.firstAshen : null),
    timing: r.timing, procFrames: r.procFrames, procVisibleMs: r1(r.procFirst !== null ? r.procLast - r.procFirst : null),
    gpu: r.perf && r.perf.gpu, gpuClass: r.perf && r.perf.gpuClass, tier: r.perf && r.perf.tier, scale: r.perf && r.perf.scale, capFps: r.perf && r.perf.capFps, poseModel: r.perf && r.perf.poseModel,
    programs: r.render && r.render.programs, longTasks: r.long, resources: r.res, postReadyGapMs: r1(r.postGapMax), tracking: r.tracking, errors: page.errors(),
  };
}

async function phaseSwitch(page) {
  const out = [];
  for (const id of ['archmage', 'elf', 'ashen']) {
    await page.eval(`(() => { __bench.switchWant = null; __bench.switchReadyAt = null; __bench.switchTiming = null; __bench.procFrames = 0; __bench.procFirst = null; __bench.procLast = null; __bench.longMs = 0; __bench.longMax = 0; __bench.longN = 0;
      const i = document.querySelector('.ao-herocard__input[value=${JSON.stringify(id)}]'); if (!i) return 'missing'; i.click(); __bench.switchWant = ${JSON.stringify(id)}; return 'ok'; })()`);
    const t0 = Date.now();
    const ok = await page.waitFor('__bench.switchReadyAt !== null', 30000, 50);
    const r = await page.eval('({ t: __bench.switchTiming, pf: __bench.procFrames, pFirst: __bench.procFirst, pLast: __bench.procLast, h: __ASHEN__.hero(), long: { ms: Math.round(__bench.longMs), max: Math.round(__bench.longMax), n: __bench.longN } })');
    out.push({ hero: id, ok: !!ok, wallMs: Date.now() - t0, readyMs: r.t && r1(r.t.ready), timing: r.t, procFrames: r.pf, procVisibleMs: r1(r.pFirst !== null ? r.pLast - r.pFirst : null), got: r.h && r.h.hero, longTasks: r.long });
    await sleep(500);
  }
  return out;
}

async function waitVision(page, timeout = 90000) {
  return page.waitFor(`(() => { const t = __ASHEN__.tracking; return t && (t.status === 'ready' || t.status === 'calibrating' || t.status === 'lost') && t.debug && t.debug.results > 5; })()`, timeout, 250);
}

async function phaseVision(page) {
  await openGame(page, '?benchcam=1');
  const t0 = Date.now();
  const ok = await waitVision(page);
  const visionStartMs = Date.now() - t0;
  await sleep(3000); // прогрев
  const r = await page.eval(`__benchRun(${SEC})`, SEC * 1000 + 30000);
  const s = summarizeRun(r);
  await page.shot('vision_menu');
  const tr = await page.eval('(() => { const t = __ASHEN__.tracking; return t ? { status: t.status, message: t.message, error: t.error, fallback: t.debug && t.debug.workerFallbackReason } : null; })()');
  return { phase: 'vision', ok: !!ok, visionStartMs, ...s, tracking: tr, errors: page.errors() };
}

async function enterFight(page) {
  const clicks = [];
  clicks.push(await page.click('Отладка с клавиатуры')); await sleep(150);
  clicks.push(await page.click('Играть')); await sleep(250);
  clicks.push(await page.click('Продолжить без камеры (демо)')); await sleep(400);
  clicks.push(await page.click('В бой')); await sleep(300);
  if (!(await page.waitFor(`__ASHEN__.screen === 'playing'`, 45000))) {   // [W5-КАМЕРА] было 15 с: облёт на программном рендере длиннее
    const scr = await page.eval('({ screen: __ASHEN__.screen, buttons: [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()).slice(0, 12) })');
    throw new Error(`бой не начался: клики ${clicks.join(',')}; экран ${scr.screen}; кнопки: ${scr.buttons.join(' | ')}`);
  }
  await sleep(800);
  await page.key('KeyW', 'keyDown');
  await page.waitFor(`__ASHEN__.snapshot() && __ASHEN__.snapshot().player.encounter === 'engaged'`, 12000);
  await sleep(300);
  await page.key('KeyW', 'keyUp');
}

// бой: удерживаем огонь, крутимся, бросаем сферу — нагрузка на эффекты как в настоящей схватке
async function fightScript(page, sec) {
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < sec * 1000) {
    await page.hold('KeyJ', 900);
    await page.hold(i % 2 ? 'KeyA' : 'KeyD', 1200);
    if (i % 3 === 2) { await page.key('KeyO', 'keyDown'); await sleep(800); await page.key('KeyO', 'keyUp'); }
    await sleep(300);
    i++;
  }
}

async function phaseFight(page, name, query) {
  await openGame(page, query);
  await enterFight(page);
  let vs = null;
  if (query) { vs = !!(await waitVision(page)); await sleep(3000); }   // ?benchcam=fight: камера включается в бою — ждём MediaPipe и прогрев
  await sleep(1500);
  const runP = page.eval(`__benchRun(${SEC})`, SEC * 1000 + 30000);
  await fightScript(page, SEC);
  const r = await runP;
  await page.shot(name);
  const s = summarizeRun(r);
  const snap = await page.eval('(() => { const s = __ASHEN__.snapshot(); return s ? { enc: s.player.encounter, hp: s.boss.hp, stage: s.boss.stage } : null; })()');
  return { phase: name, visionOk: vs, ...s, snap, errors: page.errors() };
}

async function vbenchOne(page, d, w) {
  if (!existsSync(join(ROOT, 'dev', 'vision-bench.html'))) return { note: 'нет dev/vision-bench.html в этой версии' };
  page.log.length = 0;
  const q = `?delegate=${d}&width=${w}&sec=12${VB_EXTRA ? '&' + VB_EXTRA : ''}`;
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/dev/vision-bench.html${q}` });
  const ok = await page.waitFor('window.__VB__ && __VB__.done', 120000, 500);
  const r = await page.eval('({ s: __VB__.summary, e: __VB__.error })');
  return { delegate: d, width: w, extra: VB_EXTRA || null, ok: !!ok && !r.e, error: r.e, ...(r.s || {}), errors: page.errors() };
}

// ── главное ──
const server = await startServer();
const results = { label: LABEL, root: ROOT, browser: BROWSER, size: `${W}x${H}`, sec: SEC, at: new Date().toISOString(), gpus: {} };
try {
  for (const gpu of GPUS) {
    const R = { renderer: null };
    results.gpus[gpu] = R;
    // Фазы с камерой — каждая в своём запуске браузера: поддельная камера headless после ухода со страницы,
    // где она была открыта, следующему getUserMedia отвечает «нет устройства».
    const groups = [];
    const dry = PHASES.filter((p) => ['load', 'warm', 'switch', 'fight'].includes(p));
    if (dry.length) groups.push(dry);
    for (const p of PHASES) if (p === 'vision' || p === 'fightcam') groups.push([p]);
    if (PHASES.includes('vbench')) for (const d of VB_DELEGATES) for (const w of VB_WIDTHS) groups.push([`vbench:${d}:${w}`]);
    for (const group of groups) {
      const { proc, page, profile } = await launch(gpu);
      let gameOpen = false;
      try {
        for (const ph of group) {
          if (ph === 'load') { R.load = await phaseLoad(page, 'load'); gameOpen = true; }
          else if (ph === 'warm') { R.warm = await phaseLoad(page, 'warm'); gameOpen = true; }
          else if (ph === 'switch') { if (!gameOpen) { await openGame(page); await page.waitFor('__bench.heroReadyAt !== null', 30000, 50); gameOpen = true; } R.switch = await phaseSwitch(page); }
          else if (ph === 'fight') { R.fight = await phaseFight(page, 'fight', ''); gameOpen = true; }
          else if (ph === 'vision') { R.vision = await phaseVision(page); gameOpen = true; }
          else if (ph === 'fightcam') { R.fightcam = await phaseFight(page, 'fightcam', '?benchcam=fight'); gameOpen = true; }
          else if (ph.startsWith('vbench:')) { const [, d, w] = ph.split(':'); (R.vbench ||= []).push(await vbenchOne(page, d, +w)); gameOpen = false; }
          if (!R.renderer && gameOpen) { try { R.renderer = await page.eval('__ASHEN__.perf() && __ASHEN__.perf().gpu'); } catch (e) { /* ignore */ } }
          if (!R.renderer && R.vbench && R.vbench[0] && R.vbench[0].gpu) R.renderer = R.vbench[0].gpu;
        }
      } catch (e) {
        R.error = String(e && e.message || e);
        console.error(`[${gpu}] ОШИБКА (${group.join(',')}):`, R.error);
        await page.shot(`${gpu}_error_${group[0].replace(/[^a-z0-9]/gi, '_')}`);
      } finally {
        try { page.ws.close(); } catch (e) { /* ignore */ }
        proc.kill();
        await sleep(800);
        try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* занят */ }
      }
    }
    console.log(`\n=== ${gpu}: ${R.renderer} ===`);
    const line = (k, v) => console.log(`${k.padEnd(10)} ${v}`);
    for (const ph of ['load', 'warm']) {
      const L = R[ph]; if (!L) continue;
      const tm = L.timing || {};
      line(ph, `герой «${L.heroId}» готов через ${L.heroReadyMs} мс от старта страницы (boot ${L.bootMs} мс, после __ASHEN__ ${L.heroAfterBootMs} мс); процедурный виден ${L.procFrames} кадров / ${L.procVisibleMs} мс; ` +
        `этапы: fetch ${r1(tm.fetch)} · parse ${r1(tm.parse)} · prep ${r1(tm.prep)} · clips ${r1(tm.clips)} · setup ${r1(tm.setup)} · dress ${r1(tm.dress)} · ready ${r1(tm.ready)}; tier ${L.tier} scale ${L.scale} pose ${L.poseModel}; ` +
        `долгие задачи ${L.longTasks ? L.longTasks.ms + ' мс (макс ' + L.longTasks.max + ', n=' + L.longTasks.n + ')' : '—'}; разрыв кадров после появления ${L.postReadyGapMs} мс; камера ${L.tracking}; ошибок ${L.errors.length}`);
      if (L.resources) line('  сеть', L.resources.filter((x) => /glb|task$|wasm$/.test(x.f)).map((x) => `${x.f} ${x.start}→${x.end} (${x.ms} мс, ${x.kb} КБ)`).join(' · '));
    }
    if (R.switch) for (const s of R.switch) line('switch', `${s.hero}: ${s.readyMs ?? s.wallMs} мс (fetch ${r1(s.timing && s.timing.fetch)} · parse ${r1(s.timing && s.timing.parse)} · clips ${r1(s.timing && s.timing.clips)} · dress ${r1(s.timing && s.timing.dress)}), процедурный ${s.procFrames} кадров`);
    for (const ph of ['vision', 'fight', 'fightcam']) {
      const F = R[ph]; if (!F) continue;
      line(ph, `fps ${F.fps} (rAF ${F.rafFps}) · GPU ${F.gpuMs} мс · JS ${F.cpuMs} мс · tier ${F.tier} scale ${F.scale} cap ${F.capFps} · calls ${F.calls} · ` +
        `vision ${F.hz} Гц, поза ${F.inferMs} мс, кисти ${F.handsMs} мс, задержка ${F.latencyMs} мс, камера ${F.camFps} к/с ${F.video ? F.video.w + 'x' + F.video.h : ''} cap ${F.cap} ${F.mode}/${F.delegate} ${F.poseModel}` +
        `${F.poseEvery > 1 ? ` · поза на каждом ${F.poseEvery}-м (${F.poseHz} Гц)` : ''} · ошибок ${F.errors.length}`);
    }
    if (R.vbench) for (const v of R.vbench) line('vbench', v.note || `${v.delegate} w${v.width}${v.extra ? ' ' + v.extra : ''}: ${v.hz} Гц · поза ${v.inferMs} мс · кисти ${v.handsMs} мс · задержка ${v.latencyMs} мс · старт ${v.startMs} мс · ${v.mode}/${v.delegate}${v.handsDelegate ? '+' + v.handsDelegate : ''} ${v.poseModel}${v.error ? ' ОШИБКА ' + v.error : ''}`);
  }
} finally {
  server.kill();
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  console.log('\nJSON и снимки:', OUT);
}
process.exit(0); // [W5-КАМЕРА] открытые сокеты CDP и дочерние процессы браузера не держат замер после итогов
