// [W5-КАМЕРА] Экран камеры в браузере: «Играть» → камера → калибровка → бой, дешёвый кадр на время запуска,
// «Диагностика» и «Скопировать отчёт», тексты при отказе в доступе, занятой камере и без камеры.
//
//   node dev/camera.browser.mjs [--sizes 1366x768,1366x650] [--only flow,errors] [--out DIR] [--browser PATH] [--cpu]
//
//   --cpu    MediaPipe в воркере сразу на CPU (быстрее в облаке без видеокарты). По умолчанию — как у игрока:
//            лестница отката начинает с воркера на GPU (здесь это программный SwiftShader).
// Поддельная камера Chromium показывает узор без человека: распознавание запускается и обрабатывает кадры,
// но тела не находит. Чтобы пройти калибровку и войти в бой, после запуска распознавания ответы воркера
// подменяются неподвижной позой «сидит в кадре, руки внизу» (window.__fakePose) — проверяется логика
// экранов, а не качество распознавания. Ошибки камеры — подменой getUserMedia (page.addInitScript).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_camera')));
const SIZES = argOf('--sizes', '1366x768,1366x650').split(',').map((s) => s.split('x').map(Number));
const ONLY = argOf('--only', 'flow,errors').split(',');
const CPU = argv.includes('--cpu');
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
  return { url: `http://127.0.0.1:${port}/`, kill: () => { try { py.kill(); } catch (e) { /* уже */ } } };
}

// Неподвижная поза «сидит в кадре, руки внизу» вместо ответа воркера (формат COMPACT_INDICES из vision.js)
function fakePoseScript() {
  const IDX = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  const P = { 0: [0.5, 0.3], 7: [0.45, 0.31], 8: [0.55, 0.31], 11: [0.63, 0.5], 12: [0.37, 0.5], 13: [0.67, 0.68], 14: [0.33, 0.68],
    15: [0.68, 0.86], 16: [0.32, 0.86], 23: [0.58, 0.98], 24: [0.42, 0.98], 25: [0.58, 1.3], 26: [0.42, 1.3], 27: [0.58, 1.6], 28: [0.42, 1.6] };
  const pose = () => { const a = new Float32Array(IDX.length * 4); IDX.forEach((i, k) => { const [x, y] = P[i]; a.set([x, y, 0, y > 1.1 ? 0.05 : 0.99], k * 4); }); return a; };
  const wraps = new WeakMap();
  const add = Worker.prototype.addEventListener;
  const rem = Worker.prototype.removeEventListener;
  Worker.prototype.addEventListener = function (type, fn, opt) {
    if (type !== 'message' || typeof fn !== 'function') return add.call(this, type, fn, opt);
    const w = (ev) => (window.__fakePose && ev.data && ev.data.type === 'result' ? fn.call(this, { data: { ...ev.data, landmarks: pose() } }) : fn.call(this, ev));
    wraps.set(fn, w);
    return add.call(this, type, w, opt);
  };
  Worker.prototype.removeEventListener = function (type, fn, opt) { return rem.call(this, type, (fn && wraps.get(fn)) || fn, opt); };
}

const server = await startServer();
const browser = await pw.chromium.launch({
  executablePath: exe, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});

async function newPage(w, h, init = []) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['camera', 'clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(fakePoseScript);
  if (CPU) {
    await ctx.addInitScript(() => {
      const pm = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { if (m && m.type === 'init' && m.delegate) m = { ...m, delegate: 'CPU' }; return pm.call(this, m, ...rest); };
    });
  }
  for (const f of init) await ctx.addInitScript(f.fn, f.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(server.url);
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 90000, polling: 100 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.offsetParent && b.textContent.trim() === 'Играть'), null, { timeout: 30000 });
  return { ctx, page, errors };
}

// снимок состояния: экран, статус распознавания, дешёвый кадр, плотность пикселей холста
const probe = (page) => page.evaluate(() => {
  const A = window.__ASHEN__;
  const t = A.tracking || {};
  const d = t.debug || {};
  const cl = A.camLoad();
  const cv = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  return {
    t: Math.round(performance.now()), screen: A.screen, status: t.status, message: t.message, mode: t.mode, delegate: t.delegate, calibrated: t.calibrated,
    step: d.engineStep, results: d.results, hz: d.inferenceHz, ladder: (d.ladderHistory || []).map((x) => x.step),
    warm: cl.warm, fightCap: cl.fightCap, guard: cl.guard.level, hidden: cl.hidden.length, fps: A.fps,
    pr: cv && cv.clientWidth ? Math.round((cv.width / cv.clientWidth) * 100) / 100 : null,
  };
});

// всё видимое на экране камеры помещается в окно: кнопки, «Диагностика», строка статуса
const layout = (page) => page.evaluate(() => {
  const vis = (e) => e.offsetParent !== null && e.getClientRects().length > 0;
  const out = [];
  for (const e of document.querySelectorAll('.ao-panel--camera button, .ao-panel--camera summary, .ao-camstat')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ what: (e.textContent || e.className).trim().slice(0, 28), bottom: Math.round(r.bottom), right: Math.round(r.right) });
  }
  return { h: innerHeight, w: innerWidth, items: out, over: out.filter((x) => x.bottom > innerHeight + 1 || x.right > innerWidth + 1), scroll: document.documentElement.scrollHeight > innerHeight + 1 };
});

async function diagAndReport(page, tag) {
  const sum = page.locator('details.ao-camdiag:visible > summary').first();
  if (!(await sum.count())) return { error: 'нет «Диагностики»' };
  await sum.click();
  await sleep(500);
  const rows = await page.locator('details.ao-camdiag[open] dt').allInnerTexts();
  const vals = await page.locator('details.ao-camdiag[open] dd').allInnerTexts();
  await page.getByRole('button', { name: 'Скопировать отчёт' }).first().click();
  await sleep(500);
  const note = await page.locator('details.ao-camdiag[open] .ao-camdiag__note').first().innerText().catch(() => '');
  const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  await page.screenshot({ path: join(OUT, `${tag}_diag.png`) });
  const lay = await layout(page);
  await sum.click();   // свернуть
  return { rows, vals, note, text, lay };
}

async function flow(w, h) {
  const tag = `flow_${w}x${h}`;
  const { ctx, page, errors } = await newPage(w, h);
  const tl = [];
  const keep = (s) => { const p = tl[tl.length - 1]; if (!p || p.screen !== s.screen || p.status !== s.status || p.warm !== s.warm || p.step !== s.step || p.fightCap !== s.fightCap) tl.push(s); };
  try {
    await sleep(3000);
    const menu = await probe(page);
    keep(menu);
    check(`${tag}: меню — обычный кадр`, menu.warm === false && menu.screen === 'menu', JSON.stringify(menu));
    await page.screenshot({ path: join(OUT, `${tag}_1_menu.png`) });
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Играть', exact: true }).first().click();
    // запуск: дешёвый кадр включается, пока камера и распознавание запускаются
    let warmOn = null, loadShot = false, running = null;
    for (let i = 0; i < 1200 && !running; i++) {
      const s = await probe(page);
      keep(s);
      if (s.warm && !warmOn) warmOn = s;
      if (s.warm && s.status === 'loading' && !loadShot && Date.now() - t0 > 2500) {
        loadShot = true;
        await page.screenshot({ path: join(OUT, `${tag}_2_loading.png`) });
        const lay = await layout(page);
        check(`${tag}: экран камеры во время запуска помещается в окно`, lay.over.length === 0 && !lay.scroll, JSON.stringify(lay.over.length ? lay.over : lay.items.slice(-4)));
      }
      if (['ready', 'lost', 'calibrating'].includes(s.status) && s.results > 0) running = { ...s, ms: Date.now() - t0 };
      if (s.status === 'error') { running = { ...s, ms: Date.now() - t0 }; break; }
      await sleep(250);
    }
    check(`${tag}: «Играть» → экран камеры, распознавание запустилось`, !!running && running.status !== 'error', running ? `${running.status} «${running.message}» за ${running.ms} мс; ступень ${running.step}; откаты ${running.ladder.join(' → ') || 'нет'}` : 'таймаут 5 мин');
    check(`${tag}: дешёвый кадр включается на время запуска`, !!warmOn && warmOn.pr < menu.pr && warmOn.hidden > 0, warmOn ? `плотность ${menu.pr} → ${warmOn.pr}, спрятано объектов витрины ${warmOn.hidden}, статус ${warmOn.status}` : 'не включился');
    const run = await probe(page);
    check(`${tag}: без калибровки (нет тела) дешёвый кадр держится`, run.warm === true && run.screen === 'camera', JSON.stringify(run));
    await page.screenshot({ path: join(OUT, `${tag}_3_camera.png`) });
    const dg = await diagAndReport(page, tag);
    check(`${tag}: «Диагностика» — камера, распознавания, где считается, ступень`, !dg.error && ['Камера', 'Распознаваний', 'Где считается', 'Ступень отката', 'Игра'].every((k) => dg.rows.includes(k)), dg.error || dg.rows.map((k, i) => `${k}: ${dg.vals[i]}`).join(' | '));
    check(`${tag}: «Скопировать отчёт» → в буфере отчёт`, /^ASHEN OATH — отчёт камеры/.test(dg.text || '') && /Где считается: /.test(dg.text) && /скопирован/.test(dg.note), `${dg.note}; ${(dg.text || '').split('\n').length} строк`);
    check(`${tag}: с раскрытой «Диагностикой» экран помещается в окно`, dg.lay && dg.lay.over.length === 0 && !dg.lay.scroll, JSON.stringify(dg.lay && (dg.lay.over.length ? dg.lay.over : dg.lay.items.slice(-4))));
    writeFileSync(join(OUT, `${tag}_report.txt`), dg.text || '');

    // калибровка: игрок сел в кадр (подменная поза) → калибровка → обучение
    await page.evaluate(() => { window.__fakePose = true; });
    let calib = null, left = null;
    for (let i = 0; i < 480 && !left; i++) {
      const s = await probe(page);
      keep(s);
      if (s.status === 'calibrating' && !calib) { calib = s; await page.screenshot({ path: join(OUT, `${tag}_4_calibrating.png`) }); }
      if (s.screen !== 'camera') left = s;
      await sleep(250);
    }
    check(`${tag}: поза в кадре → калибровка (дешёвый кадр держится)`, !!calib && calib.warm === true, calib ? JSON.stringify(calib) : 'калибровка не началась');
    check(`${tag}: откалиброван → дальше, дешёвый кадр выключен, плотность как в меню`, !!left && left.warm === false && left.calibrated === true && left.pr >= menu.pr - 0.01 && left.hidden === 0, left ? JSON.stringify(left) : 'остались на экране камеры');
    await sleep(800);
    await page.screenshot({ path: join(OUT, `${tag}_5_${left ? left.screen : 'camera'}.png`) });
    // бой
    if (left && left.screen === 'tutorial') {
      await page.getByRole('button', { name: 'В бой' }).first().click();
      await page.waitForFunction(() => ['intro', 'playing'].includes(window.__ASHEN__.screen), null, { timeout: 60000 }).catch(() => {});
    }
    await sleep(6000);
    const fight = await probe(page);
    keep(fight);
    check(`${tag}: бой — обычный кадр (дешёвый выключен)`, ['intro', 'playing'].includes(fight.screen) && fight.warm === false && fight.hidden === 0, JSON.stringify(fight));
    await page.screenshot({ path: join(OUT, `${tag}_6_fight.png`) });
    await sleep(6000);
    const fight2 = await probe(page);
    keep(fight2);
    console.log(`  ${tag}: бой через 12 с — распознаваний ${fight2.hz}/с, страж ${fight2.guard}${fight2.fightCap ? ' (30 к/с)' : ''}, кадров ${fight2.fps}/с`);
    const errs = errors.filter((e) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:|favicon|Failed to load resource/.test(e));
    check(`${tag}: нет ошибок страницы`, errs.length === 0, errs.slice(0, 3).join(' | '));
    return { tag, menu, warmOn, running, calib, left, fight, fight2, timeline: tl.map((s) => ({ ...s, dt: s.t - tl[0].t })) };
  } finally { await ctx.close(); }
}

// ошибки getUserMedia: отказ, камера занята, камеры нет
const ERRORS = [
  { name: 'NotAllowedError', key: 'denied', title: /Доступ к камере запрещён/, steps: /Разрешить/ },
  { name: 'NotReadableError', key: 'busy', title: /Камера занята/, steps: /Zoom|Teams|OBS/ },
  { name: 'NotFoundError', key: 'nocamera', title: /Камера не найдена/, steps: /Подключите камеру/ },
];
async function camError(w, h, e) {
  const tag = `error_${e.key}_${w}x${h}`;
  const reject = (name) => {
    const md = navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = () => Promise.reject(new DOMException('имитация отказа камеры', name));
  };
  const { ctx, page, errors } = await newPage(w, h, [{ fn: reject, arg: e.name }]);
  try {
    await page.getByRole('button', { name: 'Играть', exact: true }).first().click();
    const st = await page.waitForFunction(() => { const t = window.__ASHEN__.tracking; return t && t.status === 'error' ? { code: t.error, message: t.message } : null; }, null, { timeout: 20000, polling: 100 }).then((x) => x.jsonValue(), () => null);
    await sleep(600);
    const box = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.ao-errbox')].find((x) => x.offsetParent !== null);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { title: b.querySelector('.ao-errbox__title').textContent, reason: b.querySelector('.ao-errbox__reason').textContent, steps: [...b.querySelectorAll('.ao-errbox__steps li')].map((li) => li.textContent), bottom: Math.round(r.bottom) };
    });
    const btns = await page.evaluate(() => [...document.querySelectorAll('.ao-panel--camera button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()));
    const lay = await layout(page);
    await page.screenshot({ path: join(OUT, `${tag}.png`) });
    check(`${tag}: код ${st && st.code}, текст «${box && box.title}»`, !!st && !!box && e.title.test(box.title) && box.steps.some((s) => e.steps.test(s)), box ? `${box.reason} · ${box.steps.join(' · ')}` : `нет плашки ошибки; статус ${JSON.stringify(st)}`);
    check(`${tag}: есть «Повторить», экран помещается в окно`, btns.some((b) => /Повторить|Включить камеру|Разрешить камеру/.test(b)) && lay.over.length === 0 && !lay.scroll, `${btns.join(' | ')}; за краем: ${JSON.stringify(lay.over)}`);
    const cl = await page.evaluate(() => window.__ASHEN__.camLoad());
    check(`${tag}: после ошибки дешёвый кадр выключен`, cl.warm === false, JSON.stringify(cl.log.slice(-2)));
    const errs = errors.filter((x) => !/GPU|WebGL|gpu|delegate|OpenGL|INFO:|favicon|Failed to load resource/.test(x));
    check(`${tag}: нет ошибок страницы`, errs.length === 0, errs.slice(0, 3).join(' | '));
    return { tag, status: st, box };
  } finally { await ctx.close(); }
}

const report = { sizes: SIZES, cpu: CPU, flows: [], errors: [] };
try {
  if (ONLY.includes('flow')) for (const [w, h] of SIZES) report.flows.push(await flow(w, h));
  if (ONLY.includes('errors')) for (const [w, h] of SIZES) for (const e of ERRORS) report.errors.push(await camError(w, h, e));
} finally {
  report.results = results;
  writeFileSync(join(OUT, 'camera_report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch(() => {});
  server.kill();
}
for (const f of report.flows) {
  console.log(`\n${f.tag}: ход запуска (мс от «Играть»; экран · статус · дешёвый кадр · ступень)`);
  const t0 = (f.timeline.find((s) => s.screen === 'camera') || f.timeline[0]).t;
  for (const s of f.timeline) console.log(`  ${String(s.t - t0).padStart(7)}  ${s.screen.padEnd(9)} ${String(s.status).padEnd(11)} ${s.warm ? 'дешёвый' : 'обычный'} ×${s.pr}  ${s.step || '—'}  ${s.message || ''}`);
}
console.log(`\n${results.length - failures}/${results.length} PASS · отчёт и скриншоты: ${OUT}`);
process.exit(failures ? 1 : 0);
