// Браузерный QA через headless Chrome/Edge + Chrome DevTools Protocol.
// node tools/qa_browser.mjs [--out DIR] [--browser PATH]
// Запускает serve_game.py, открывает игру в отдельном временном профиле и проверяет сценарии.
// Фейковая камера Chrome (--use-fake-device-for-media-stream) показывает тестовый узор без
// человека: она проверяет загрузку MediaPipe (модуль/WASM/модель) и реакцию на «нет тела»,
// но НЕ является проверкой реального трекинга.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_qa')));
const BROWSERS = [argOf('--browser'), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const BROWSER = BROWSERS.find((p) => existsSync(p));
const PORT = 8797;
const URL = `http://127.0.0.1:${PORT}/`;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
  console.log(results[results.length - 1]);
}

// ---------------------------------------------------------------- сервер
function startServer() {
  const py = spawn('python', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('server exit ' + c + ' ' + out)));
  });
}

// ---------------------------------------------------------------- CDP
class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; this.exceptions = []; this.failedRequests = []; this.requests = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const p = new Page(ws);
    ws.onmessage = (m) => p.onMessage(JSON.parse(m.data));
    await p.send('Runtime.enable');
    await p.send('Page.enable');
    await p.send('Network.enable');
    await p.send('Log.enable');
    // Dedicated worker (MediaPipe в vision-worker.js): его сеть видна только в отдельной сессии.
    await p.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return p;
  }
  onMessage(msg) {
    if (msg.method === 'Target.attachedToTarget') {
      const sid = msg.params.sessionId;
      this.workers = (this.workers || 0) + 1;
      this.send('Network.enable', {}, sid).catch(() => {});
      if (this.blocked) this.send('Network.setBlockedURLs', { urls: this.blocked }, sid).catch(() => {});   // [OFFLINE] и в worker
      this.send('Runtime.enable', {}, sid).catch(() => {});
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      this.console.push({ type: msg.params.type, text });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.exceptions.push((d.exception && d.exception.description) || d.text);
    } else if (msg.method === 'Log.entryAdded') {
      this.console.push({ type: msg.params.entry.level, text: msg.params.entry.text + ' ' + (msg.params.entry.url || '') });
    } else if (msg.method === 'Network.requestWillBeSent') {
      if (this.requests.length < 2000) this.requests.push(msg.params.request.url);
    } else if (msg.method === 'Network.loadingFailed') {
      this.failedRequests.push(msg.params.errorText + ' ' + (msg.params.requestId || ''));
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
  async waitFor(expr, timeout = 20000, step = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await this.eval(expr); if (v) return v; } catch (e) { /* not ready */ }
      await sleep(step);
    }
    return null;
  }
  async click(label) {
    return this.eval(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'missing'; if (b.getAttribute('aria-disabled') === 'true') return 'disabled'; b.click(); return 'ok'; })()`);
  }
  async key(code, type) {
    const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
    await this.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: code === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0) });
  }
  async tap(code, ms = 60) { await this.key(code, 'keyDown'); await sleep(ms); await this.key(code, 'keyUp'); }
  async hold(code, ms) { await this.key(code, 'keyDown'); await sleep(ms); await this.key(code, 'keyUp'); }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const f = join(OUT, name + '.png');
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function launch(name, extraFlags = [], url = URL) {
  const profile = join(tmpdir(), `ashen_qa_profile_${name}_${Date.now()}`);
  const dbgPort = 9400 + Math.floor(Math.random() * 400);
  const flags = [
    '--headless=new', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--enable-unsafe-swiftshader', '--window-size=1366,768', '--autoplay-policy=no-user-gesture-required',
    ...extraFlags, 'about:blank',
  ];
  const proc = spawn(BROWSER, flags, { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 50 && !ver; i++) {
    await sleep(200);
    try { ver = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json(); } catch (e) { /* wait */ }
  }
  const target = ver && ver.find((t) => t.type === 'page');
  if (!target) throw new Error('browser did not start');
  const page = await Page.connect(target.webSocketDebuggerUrl);
  await page.send('Page.navigate', { url });
  const kill = async () => { page.close(); proc.kill(); await sleep(400); try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked */ } };
  return { page, kill };
}


// ---------------------------------------------------------------- сценарии
// Предупреждения компилятора шейдеров D3D (X4122, точность констант) — не ошибки.
const isNoise = (t) => /X4122|WebGLProgram: Program Info Log/.test(t);
const errorsOf = (page) => [
  ...page.exceptions,
  ...page.console.filter((c) => c.type === 'error' && !isNoise(c.text)).map((c) => c.text),
];
const screen = (page) => page.eval('__ASHEN__.screen');

async function scenarioBootAndDebug() {
  const { page, kill } = await launch('debug');
  try {
    const booted = await page.waitFor('!!window.__ASHEN__', 60000);
    check('страница загружается по localhost, все модули импортированы', !!booted);
    if (!booted) return;
    const info = await page.eval(`({rev: __ASHEN__.threeRevision, screen: __ASHEN__.screen, canvases: document.querySelectorAll('canvas').length, main: __ASHEN__.canvasCount(), boot: document.getElementById('ao-boot').hidden, slot: !!document.querySelector('#ui-camera-slot > #ao-video')})`);
    const glCount = await page.eval(`[...document.querySelectorAll('canvas')].filter((c) => c.id !== 'ao-hud-canvas' && c.id !== 'ao-overlay').length`);
    check('Three.js r185, один WebGL-canvas (+ 2D боевой HUD и overlay CV), video в слоте UI', info.rev === '185' && info.main === 1 && info.canvases === 3 && glCount === 1 && info.slot, JSON.stringify({ ...info, webglCanvases: glCount }));
    check('стартовый экран menu, загрузчик скрыт', info.screen === 'menu' && info.boot === true);
    await sleep(2000);
    await page.shot('01_menu');
    const ri = await page.eval('__ASHEN__.renderInfo()');
    check('сцена world №3 рисуется, один теневой источник', ri.calls > 50 && ri.shadowLights === 1, JSON.stringify(ri));

    check('меню: переключатель «Отладка с клавиатуры»', (await page.click('Отладка с клавиатуры')) === 'ok');
    await sleep(150);
    const badge = await page.eval(`[...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.offsetParent !== null && /DEBUG\\s*\\/\\s*НЕ CV/.test(e.textContent))`);
    check('DEBUG включается явно, видна надпись DEBUG / НЕ CV', badge && (await page.eval('__ASHEN__.debug')) === true);
    await page.click('Играть');
    await sleep(150);
    check('Играть → экран камеры', (await screen(page)) === 'camera');
    await page.click('Продолжить без камеры (DEBUG)');
    await sleep(150);
    check('DEBUG: без камеры → обучение', (await screen(page)) === 'tutorial');
    await page.shot('02_tutorial_debug');
    await page.click('В бой');
    await sleep(600);   // [ONBOARD] интро 1,8 с
    const introScr = await screen(page);
    await page.shot('02b_intro');
    check('В бой → кинематографичное интро (screen=intro)', introScr === 'intro', introScr);
    const played = await page.waitFor(`__ASHEN__.screen === 'playing'`, 9000, 200);
    check('после интро → screen=playing', !!played);

    const p0 = await page.eval('__ASHEN__.snapshot().player.position');
    await page.hold('KeyD', 700);
    const p1 = await page.eval('__ASHEN__.snapshot().player.position');
    check('D (moveX>0) из стартовой позиции двигает героя в +X (вправо на экране)', p1.x > p0.x + 0.5, `x ${p0.x.toFixed(2)} → ${p1.x.toFixed(2)}`);
    await page.hold('KeyA', 700);
    const p2 = await page.eval('__ASHEN__.snapshot().player.position');
    check('A возвращает влево', p2.x < p1.x - 0.5, `x ${p1.x.toFixed(2)} → ${p2.x.toFixed(2)}`);

    const e0 = await page.eval('__ASHEN__.snapshot().player.energy');
    await page.key('KeyE', 'keyDown');
    for (let i = 0; i < 10; i++) { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyE', key: 'e', autoRepeat: true, windowsVirtualKeyCode: 69 }); await sleep(30); }
    await page.key('KeyE', 'keyUp');
    await sleep(80);
    const sd = await page.eval('__ASHEN__.snapshot()');
    check('E с автоповтором клавиши: ровно один рывок (энергия −20 один раз)', sd.cooldowns.dashRemaining > 0 && Math.abs((e0 - sd.player.energy) - 20) < 3, `dashRemaining=${sd.cooldowns.dashRemaining.toFixed(2)} энергия ${e0.toFixed(0)}→${sd.player.energy.toFixed(0)}`);

    const hp0 = await page.eval('__ASHEN__.snapshot().boss.hp');
    await page.hold('KeyJ', 2000);
    const hp1 = await page.eval('__ASHEN__.snapshot().boss.hp');
    check('J: снаряды наносят урон боссу', hp1 < hp0, `${hp0} → ${hp1}`);
    await page.shot('03_playing_fire');
    await page.key('KeyK', 'keyDown');
    await sleep(350);
    const sh = await page.eval('__ASHEN__.snapshot().player.shielding');
    await page.shot('04_playing_shield');
    await page.key('KeyK', 'keyUp');
    check('K: щит удерживается', sh === true);

    await page.tap('Escape');
    await sleep(200);
    const t0 = await page.eval('__ASHEN__.snapshot().time');
    await sleep(800);
    const t1 = await page.eval('__ASHEN__.snapshot().time');
    check('Escape: пауза (pauseReason=user), время боя стоит', (await screen(page)) === 'paused' && t1 === t0 && (await page.eval('__ASHEN__.pauseReason')) === 'user');
    await page.shot('05_paused');
    await page.tap('Escape');
    await sleep(200);
    check('Escape в паузе не снимает паузу (продолжение только кнопкой)', (await screen(page)) === 'paused');
    await page.click('Продолжить бой');
    await sleep(300);
    check('«Продолжить бой» → playing', (await screen(page)) === 'playing');

    await page.eval(`Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange')); true`);
    await sleep(100);
    check('visibilitychange(hidden) ставит паузу [симуляция события]', (await screen(page)) === 'paused');
    await page.eval(`Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); true`);

    const lowRes = await page.eval(`(() => { const r = [...document.querySelectorAll('input[type=radio]')].find((i) => i.value === 'low' && i.closest('[hidden]') === null && i.offsetParent !== null) || [...document.querySelectorAll('input[type=radio]')].find((i) => i.value === 'low'); if (!r) return 'missing'; r.click(); return 'ok'; })()`);
    await sleep(400);
    const low = await page.eval(`({ ...__ASHEN__.renderInfo(), q: JSON.parse(localStorage.getItem('ashen-oath.settings.v1') || '{}').quality })`);
    check('Low: сохранено, теней нет (castShadow выкл.), pixel ratio ≤ 1', lowRes === 'ok' && low.q === 'low' && low.shadowLights === 0 && low.pixelRatio <= 1, JSON.stringify(low));
    await page.shot('06_paused_low');

    await page.click('Продолжить бой');
    await page.key('KeyJ', 'keyDown');
    const end = await page.waitFor(`['victory','defeat'].includes(__ASHEN__.screen) && __ASHEN__.screen`, 150000, 500);
    await page.key('KeyJ', 'keyUp');
    check('бой доходит до исхода (victory/defeat)', !!end, String(end));
    if (end) {
      await sleep(1500);
      await page.shot('07_' + end);
      const a = await page.eval('__ASHEN__.snapshot().time');
      await sleep(600);
      const b = await page.eval('__ASHEN__.snapshot().time');
      check('после исхода симуляция остановлена', a === b);
      await page.click(end === 'defeat' ? 'Ещё раз' : 'Сразиться снова');   // [FEEL] на поражении — «Ещё раз»
      await sleep(300);
      const r = await page.eval('({s: __ASHEN__.screen, hp: __ASHEN__.snapshot().boss.hp, max: __ASHEN__.snapshot().boss.maxHp, t: __ASHEN__.snapshot().time})');
      check('повтор: новый бой с полным HP', r.s === 'playing' && r.hp === r.max && r.t < 1, JSON.stringify(r));
      await page.tap('Escape');
      await sleep(200);
      await page.click('Выйти в меню');
      await sleep(300);
      check('выход в меню', (await screen(page)) === 'menu');
    }
    const errs = errorsOf(page);
    check('нет ошибок/исключений в консоли (debug-сценарий)', errs.length === 0, errs.slice(0, 5).join(' | '));
  } finally { await kill(); }
}

async function scenarioFakeCamera() {
  const { page, kill } = await launch('fakecam', ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
  try {
    await page.waitFor('!!window.__ASHEN__', 60000);
    await page.click('Играть');
    await sleep(150);
    // [ONBOARD] «Играть» сразу запрашивает камеру — второго клика нет
    check('«Играть» сразу включает камеру', (await screen(page)) === 'camera' && (await page.eval('__ASHEN__.tracking.status')) !== 'idle');
    const st = await page.waitFor(`(() => { const t = __ASHEN__.tracking; return ['ready','lost','error'].includes(t.status) ? t : null; })()`, 90000, 300);
    check('фейковая камера: MediaPipe 0.10.35 (модуль + WASM + модель) загружен', st && st.status !== 'error', st ? `${st.status}: ${st.message} mode=${st.mode} delegate=${st.delegate} fallback=${st.debug && st.debug.workerFallbackReason}` : 'timeout');
    check('распознавание в module worker (не в главном потоке)', st && st.mode === 'worker', st ? `mode=${st.mode}` : '');
    const hs = await page.waitFor(`__ASHEN__.tracking.hands && __ASHEN__.tracking.hands.ready && __ASHEN__.tracking.hands`, 20000, 300);
    check('«Перстни»: модель кистей HandLandmarker загружена в том же worker', !!hs, JSON.stringify(hs || (await page.eval('__ASHEN__.tracking.hands'))));
    await sleep(3000);
    const t2 = await page.eval('__ASHEN__.tracking');
    check('тестовый узор без человека → не валидный ввод, нет калибровки', t2.valid === false && t2.calibrated === false, `${t2.status}: ${t2.message}; inferenceHz=${t2.debug && t2.debug.inferenceHz}`);
    await page.shot('08_fake_camera');
    const perf = await page.eval(`({ fps: __ASHEN__.fps, hz: __ASHEN__.tracking.debug.inferenceHz, inferMs: __ASHEN__.tracking.debug.inferMs, latencyMs: __ASHEN__.tracking.debug.latencyMs, mode: __ASHEN__.tracking.mode })`);
    writeFileSync(join(OUT, 'perf_cv_scene.json'), JSON.stringify(perf));
    check('замер: сцена + CV одновременно (headless, эта машина; не обещание FPS)', perf.fps > 0 && perf.hz > 0, `рендер ${perf.fps} к/с, распознавание ${perf.hz} Гц, inference ${perf.inferMs} мс, задержка ${perf.latencyMs} мс, ${perf.mode}`);
    // [ONBOARD] калибровка запускается сама, только когда в кадре плечи; узор без человека — ждём на экране камеры
    await sleep(1500);
    const cs = await page.eval('({ t: __ASHEN__.tracking, scr: __ASHEN__.screen })');
    check('без человека калибровка не запускается и экран не уходит дальше', cs.t.calibrated === false && cs.t.status !== 'calibrating' && cs.scr === 'camera', `${cs.scr}; ${cs.t.status}: ${cs.t.message}`);
    await page.shot('09_camera_no_body');
    const errs = errorsOf(page).filter((e) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:/.test(e));
    check('нет ошибок консоли (фейковая камера)', errs.length === 0, errs.slice(0, 5).join(' | '));
    const mp = page.requests.filter((u) => /mediapipe|\.wasm|\.task/.test(u));
    writeFileSync(join(OUT, 'mediapipe_requests.txt'), mp.join('\n'));
    check('CDP подключён к worker распознавания', (page.workers || 0) >= 1, `сессий worker: ${page.workers || 0}`);
    // [PERF] на дискретной видеокарте core/perfTuner.js берёт точную модель позы (full) — тоже закреплённый URL
    check('запросы MediaPipe (и из worker) — только закреплённые URL 0.10.35', mp.length >= 3 && mp.every((u) => u.includes('@0.10.35') || u.includes('pose_landmarker_lite/float16/1/') || u.includes('pose_landmarker_full/float16/1/') || u.includes('hand_landmarker/hand_landmarker/float16/1/')), mp.join(' , '));
    const hosts = [...new Set(page.requests.filter((u) => /^https?:/.test(u)).map((u) => u.split('/')[2]))];
    const allowed = ['127.0.0.1:' + PORT, 'cdn.jsdelivr.net', 'storage.googleapis.com'];
    const env = hosts.filter((h) => /kaspersky|avast|eset|drweb|norton|mcafee/i.test(h));
    const foreign = hosts.filter((h) => !allowed.includes(h) && !env.includes(h));
    check('все запросы игры — только localhost, jsdelivr, модель (без аналитики)', foreign.length === 0,
      hosts.join(', ') + (env.length ? ` [внедрено средой, не игрой: ${env.join(', ')}]` : ''));
    await page.click('В меню');
    await sleep(500);
    const off = await page.eval(`({ s: __ASHEN__.tracking.status, src: !!document.getElementById('ao-video').srcObject })`);
    check('выход в меню выключает камеру', off.s === 'idle' && off.src === false, JSON.stringify(off));
  } finally { await kill(); }
}

// [ASHEN_V2] «Клятва героя» и «Тренировка»: навигация, покупка, сохранение, камера.
async function scenarioOath() {
  const { page, kill } = await launch('oath', ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
  try {
    await page.waitFor('!!window.__ASHEN__', 60000);
    const pv = await page.eval('__ASHEN__.progress()');
    check('новый профиль: 0 очков клятвы, 7 улучшений', pv.points === 0 && pv.upgrades.length === 7, JSON.stringify({ points: pv.points, n: pv.upgrades.length }));
    const embers = await page.eval('__ASHEN__.embers()');
    check('11 углей клятвы на большой карте (ASHEN_V3, №10 — в эльфийской деревне), все вне арены (r > 16 м)', embers.length === 11 && embers.every((e) => Math.hypot(e.x, e.z) > 16 && !e.lit), JSON.stringify(embers.map((e) => Math.round(Math.hypot(e.x, e.z)))));
    check('меню → «Клятва героя»', (await page.click('Клятва героя')) === 'ok' && (await screen(page)) === 'oath');
    const cards = await page.eval(`[...document.querySelectorAll('.ao-upg')].filter((c) => c.offsetParent !== null).map((c) => c.querySelector('button').getAttribute('aria-disabled'))`);
    check('7 карточек, без очков покупать нельзя', cards.length === 7 && cards.every((d) => d === 'true'), JSON.stringify(cards));
    await page.shot('10_oath_empty');
    check('«Тренировка: отжимания и приседания» → экран тренировки', (await page.click('Тренировка: отжимания и приседания')) === 'ok' && (await screen(page)) === 'training');
    check('камера на тренировке не включается сама', (await page.eval('__ASHEN__.tracking.status')) === 'idle');
    await page.click('Разрешить камеру');
    const st = await page.waitFor(`(() => { const t = __ASHEN__.tracking; return ['ready','lost','error'].includes(t.status) ? t.status : null; })()`, 90000, 300);
    await sleep(2500);
    const pu = await page.eval('__ASHEN__.pushups()');
    check('тренировка: камера включилась, узор без человека — 0 отжиманий', st && st !== 'error' && pu.reps === 0, `${st}; ${pu.state}: ${pu.message}`);
    await page.shot('11_training_fakecam');
    check('«Готово» → назад в «Клятву»', (await page.click('Готово')) === 'ok' && (await screen(page)) === 'oath');
    check('«Назад» → меню', (await page.click('Назад')) === 'ok' && (await screen(page)) === 'menu');
    await sleep(400);
    check('в меню камера снова выключена', (await page.eval('__ASHEN__.tracking.status')) === 'idle');
    // сохранение: очки в localStorage переживают перезагрузку; покупка поднимает здоровье героя
    await page.eval(`localStorage.setItem('ashen.oath.v1', JSON.stringify({ v: 1, points: 5, earned: 5, pushups: 5, embers: [], levels: {} }))`);
    await page.send('Page.reload');
    await page.waitFor('!!window.__ASHEN__', 60000);
    const pv2 = await page.eval('__ASHEN__.progress()');
    check('очки клятвы из localStorage после перезагрузки', pv2.points === 5, String(pv2.points));
    await page.click('Клятва героя');
    await sleep(150);
    const buy = await page.eval(`(() => { const c = document.querySelector('.ao-upg[data-id="vitality"] button'); if (!c || c.getAttribute('aria-disabled') === 'true') return 'disabled'; c.click(); return 'ok'; })()`);
    await sleep(150);
    const after = await page.eval('({ p: __ASHEN__.progress(), max: __ASHEN__.heroMax() })');
    const vit = after.p.upgrades.find((u) => u.id === 'vitality');
    check('покупка «Живучести»: −2 очка, уровень 1, здоровье героя 115', buy === 'ok' && after.p.points === 3 && vit.level === 1 && after.max && after.max.hp === 115, JSON.stringify({ buy, points: after.p.points, level: vit.level, max: after.max }));
    const errs = errorsOf(page).filter((e) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:/.test(e));
    check('нет ошибок консоли (клятва и тренировка)', errs.length === 0, errs.slice(0, 5).join(' | '));
  } finally { await kill(); }
}

async function scenarioDenied() {
  const { page, kill } = await launch('denied', ['--deny-permission-prompts']);
  try {
    await page.waitFor('!!window.__ASHEN__', 60000);
    await page.click('Играть');   // [ONBOARD] камера запрашивается сразу
    const st = await page.waitFor(`__ASHEN__.tracking.status === 'error' && __ASHEN__.tracking`, 20000);
    const last = st ? null : await page.eval(`({ scr: __ASHEN__.screen, t: __ASHEN__.tracking })`);
    check('отказ в камере → понятное сообщение, игра не падает', !!st && /запрещ/i.test(st.message), st ? `${st.error}: ${st.message}` : 'timeout; последнее состояние: ' + JSON.stringify(last).slice(0, 300));
    check('после отказа остаётся экран камеры', (await screen(page)) === 'camera');
    await sleep(300);
    await page.shot('10_camera_denied');
  } finally { await kill(); }
}

async function scenarioNoModel() {
  // [OFFLINE] модели лежат в vendor/ — «модель недоступна» теперь значит: нет ни локального .task, ни CDN
  const { page, kill } = await launch('nomodel', ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP storage.googleapis.com ~NOTFOUND'], URL + '?sw=0&preload=0');
  try {
    page.blocked = ['*.task'];
    await page.send('Network.setBlockedURLs', { urls: page.blocked });
    await page.waitFor('!!window.__ASHEN__', 60000);
    await page.click('Играть');   // [ONBOARD] камера запрашивается сразу
    const st = await page.waitFor(`__ASHEN__.tracking.status === 'error' && __ASHEN__.tracking`, 90000);
    check('модель недоступна → сообщение об ошибке загрузки модели', !!st && /модел/i.test(st.message), st ? `${st.error}: ${st.message}` : 'timeout');
    await page.shot('11_model_failed');
  } finally { await kill(); }
}

async function scenarioNoCdn() {
  // [OFFLINE] библиотеки, WASM, модели и шрифты — из vendor/: без CDN и Google игра стартует и камера работает
  const noNet = 'MAP cdn.jsdelivr.net ~NOTFOUND, MAP storage.googleapis.com ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND';
  const { page, kill } = await launch('nocdn', ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--host-resolver-rules=${noNet}`]);
  try {
    const ok = await page.waitFor('!!window.__ASHEN__', 60000);
    check('без CDN и Google Fonts игра стартует (всё из vendor/)', !!ok, ok ? '' : 'timeout');
    await page.click('Начать');
    await page.click('Разрешить камеру');
    const st = await page.waitFor(`(() => { const t = __ASHEN__.tracking; return ['ready','lost','error'].includes(t.status) ? t.status : null; })()`, 180000, 300);
    const ext = [...new Set(page.requests.filter((u) => /^https?:/.test(u) && !u.startsWith(URL)).map((u) => u.split('/')[2]))];
    check('без CDN распознавание запускается на локальных моделях', st && st !== 'error', String(st));
    check('без CDN нет ни одного внешнего запроса', ext.length === 0, ext.join(', '));
  } finally { await kill(); }
}

async function scenarioFile() {
  const fileUrl = 'file:///' + join(ROOT, 'index.html').replace(/\\/g, '/');
  const { page, kill } = await launch('file', [], fileUrl);
  try {
    const msg = await page.waitFor(`(() => { const b = document.getElementById('ao-boot'); return b && b.classList.contains('is-error') && b.querySelector('p').textContent; })()`, 10000);
    check('двойной клик по index.html (file://) → подсказка START_GAME.cmd', !!msg && msg.includes('START_GAME'), msg || 'timeout');
  } finally { await kill(); }
}


async function scenarioDevSuites() {
  // Самопроверка UI №7 на собранных modules/ui.js + ui.css (133 проверки у автора)
  {
    for (const [w, h] of [[1366, 768], [1366, 650], [1920, 1080]]) {
    const { page, kill } = await launch('uiself', [], 'about:blank');
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.navigate', { url: URL + 'dev/ui-preview.html?selftest=1&dev=0' });
      const r = await page.waitFor(`window.__AO_SELFTEST__ && { passed: __AO_SELFTEST__.passed, failed: __AO_SELFTEST__.failed, total: __AO_SELFTEST__.total, fails: (__AO_SELFTEST__.failures || []).slice(0, 5).map((f) => (f.name || '') + ' ' + (f.detail || f.message || '')) }`, 60000, 300);
      check(`самопроверка UI №7 в браузере, окно ${w}×${h}`, !!r && r.failed === 0 && r.total > 0, r ? `${r.passed}/${r.total}${r.failed ? ' — ' + r.fails.join(' | ') : ''}` : 'timeout');
    } finally { await kill(); }
    }
  }
  // Стенды специалистов загружаются без исключений (пути и three@0.185.1 поправлены при интеграции)
  for (const stand of ['vision-webcam-check.html', 'test_world.html?scene=start&shot=1', 'effects_testbench.html', 'ui-preview.html?f=playing']) {
    const { page, kill } = await launch('stand', [], URL + 'dev/' + stand);
    try {
      await sleep(6000);
      const errs = errorsOf(page).filter((e) => !/favicon/.test(e));
      const failed = page.failedRequests.length;
      check(`стенд dev/${stand.split('?')[0]} загружается без ошибок`, errs.length === 0, errs.slice(0, 3).join(' | ') + (failed ? ` [failed requests: ${failed}]` : ''));
    } finally { await kill(); }
  }
  // Тесты босса №5 в браузере
  {
    const { page, kill } = await launch('bosstest', [], URL + 'dev/boss.test.html');
    try {
      const r = await page.waitFor(`(() => { const o = document.getElementById('out'); return o && o.className && { cls: o.className, last: o.textContent.trim().slice(-140) }; })()`, 60000, 300);
      check('тесты босса №5 в браузере', !!r && r.cls === 'ok', r ? r.last : 'timeout');
    } finally { await kill(); }
  }
}

// ---------------------------------------------------------------- run
if (!BROWSER) { console.error('Chrome/Edge не найден'); process.exit(2); }
console.log('Browser:', BROWSER, '\nOut:', OUT);
const server = await startServer();
try {
  // Проверка сервера: отдаёт игру, прячет служебные файлы
  const ok = await fetch(URL);
  const py = await fetch(URL + 'serve_game.py');
  const js = await fetch(URL + 'main.js');
  check('serve_game.py: index 200, .py скрыт (404), JS как text/javascript', ok.status === 200 && py.status === 404 && /javascript/.test(js.headers.get('content-type')), `${ok.status}/${py.status}/${js.headers.get('content-type')}`);
  for (const sc of [scenarioBootAndDebug, scenarioFakeCamera, scenarioOath, scenarioDenied, scenarioNoModel, scenarioNoCdn, scenarioFile, scenarioDevSuites].filter((f) => !argOf('--only') || f.name.includes(argOf('--only')))) {
    try { await sc(); } catch (e) { check(sc.name + ' выполнен', false, e.message); }
  }
} finally {
  server.kill();
}
writeFileSync(join(OUT, 'qa_browser_results.txt'), results.join('\n'));
console.log(failures ? `\n${failures} FAIL` : '\nВСЕ БРАУЗЕРНЫЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
