// Звук в настоящей игре (headless Chromium): разблокировка первым кликом, загрузка сэмплов, «Без звука» (M),
// пауза, звук на каждое действие отладочного боя, лимит голосов, отсутствие утечек узлов, уровни на выходе.
// node dev/sfx.browser.mjs [--cdn DIR] [--out DIR] [--port N]
//   --cdn DIR — локальное зеркало npm-пакетов (DIR/node_modules/three, @mediapipe/tasks-vision, @pixiv/three-vrm),
//               если cdn.jsdelivr.net недоступен. Без флага игра грузит библиотеки из сети.
//   --out DIR — куда сложить скриншоты меню/паузы и отчёт sfx-report.json.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sfxFiles } from '../modules/sfx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CDN = arg('--cdn', null);
const OUT = arg('--out', join(tmpdir(), 'ashen_sfx'));
mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) { try { return req(p); } catch (e) { /* дальше */ } }
  throw new Error('playwright не найден');
}
const { chromium } = loadPlaywright();
const EXE = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

let failures = 0;
const report = { checks: [], levels: {}, timeline: [] };
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  console.log(line); report.checks.push(line);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- статический сервер
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = normalize(join(ROOT, decodeURIComponent(u.pathname)));
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(+arg('--port', 0), '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------------------------------------------------------------- браузер
const browser = await chromium.launch({
  executablePath: EXE, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
if (CDN) {
  await ctx.route(/cdn\.jsdelivr\.net\/npm\//, (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/(.*)$/);
    const f = m && join(CDN, 'node_modules', m[1], m[2]);
    if (f && existsSync(f)) return route.fulfill({ status: 200, contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(f) });
    return route.fulfill({ status: 404, body: 'nf' });
  });
}
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
// Программный рендер даёт единицы кадров в секунду, а бой идёт по игровому времени (dt ≤ maxDt за кадр):
// для теста разрешаем крупный шаг, иначе интро и бой тянутся минутами. Звук от этого не зависит.
await ctx.route(/\/config\.js(\?|$)/, async (route) => {
  const body = readFileSync(join(ROOT, 'config.js'), 'utf8').replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.25').replace(/stallSec:\s*0\.25/, 'stallSec: 3');
  route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
await ctx.addInitScript(() => {
  try { if (!localStorage.getItem('ashen-oath.settings.v1')) localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', qualityAuto: false, reducedMotion: true })); } catch (e) { /* ignore */ }
});

// Прослушка Web Audio до загрузки игры: счётчики созданных узлов и анализатор на выходе (после лимитера).
await ctx.addInitScript(() => {
  const C = (window.__sfxProbe = { created: {}, starts: 0, peakDb: -120, rmsDb: -120, tap: null, contexts: 0 });
  const proto = (window.BaseAudioContext || window.AudioContext).prototype;
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (!/^create[A-Z]/.test(k) || typeof proto[k] !== 'function') continue;
    const orig = proto[k];
    proto[k] = function (...a) { C.created[k] = (C.created[k] || 0) + 1; return orig.apply(this, a); };
  }
  const st = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { C.starts++; return st.apply(this, a); };
  const AC = window.AudioContext;
  window.AudioContext = function (...a) { const c = new AC(...a); C.contexts++; return c; };
  window.AudioContext.prototype = AC.prototype;
  const conn = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dst, ...rest) {
    if (dst && dst === this.context.destination && !C.tap) {
      const an = this.context.createAnalyser(); C.created.createAnalyser--; // наш анализатор не считаем
      an.fftSize = 2048; conn.call(this, an); C.tap = an;
      const buf = new Float32Array(an.fftSize);
      const tick = () => {
        an.getFloatTimeDomainData(buf);
        let pk = 0, s = 0; for (const v of buf) { const x = Math.abs(v); if (x > pk) pk = x; s += v * v; }
        C.peakDb = Math.max(C.peakDb, 20 * Math.log10(pk + 1e-9));
        C.rmsWin = 10 * Math.log10(s / buf.length + 1e-12);
        C.rmsMax = Math.max(C.rmsMax ?? -120, C.rmsWin);
        C.rmsSum = (C.rmsSum || 0) + s / buf.length; C.rmsN = (C.rmsN || 0) + 1;
      };
      setInterval(tick, 40);
    }
    return conn.call(this, dst, ...rest);
  };
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(BASE + 'index.html', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ASHEN__ && window.__ASHEN__.screen === 'menu', null, { timeout: 120000 });
await sleep(1500);

const audio = () => page.evaluate(() => window.__ASHEN__.fx().audio);
const probe = () => page.evaluate(() => { const p = window.__sfxProbe; return { created: { ...p.created }, starts: p.starts, peakDb: p.peakDb, rmsMax: p.rmsMax ?? -120, contexts: p.contexts }; });
const resetLevels = () => page.evaluate(() => { const p = window.__sfxProbe; p.peakDb = -120; p.rmsMax = -120; p.rmsSum = 0; p.rmsN = 0; });
const levels = () => page.evaluate(() => { const p = window.__sfxProbe; return { peakDb: +p.peakDb.toFixed(1), rmsMaxDb: +(p.rmsMax ?? -120).toFixed(1), rmsAvgDb: +(10 * Math.log10((p.rmsSum || 0) / Math.max(1, p.rmsN || 0) + 1e-12)).toFixed(1) }; });
const N_FILES = sfxFiles().length;
const totalCreated = (c) => Object.values(c.created).reduce((a, b) => a + b, 0);
const clickText = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === l); if (!b) return false; b.click(); return true; }, label);
const key = async (code, ms = 80) => { await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code); };

// ---------------------------------------------------------------- 1. меню: до первого клика звука нет
{
  const a0 = await audio();
  check('до первого жеста AudioContext не создан', a0.created === false, JSON.stringify({ created: a0.created, state: a0.state }));
  const ui = await page.evaluate(() => {
    const r = document.querySelector('.ao-panel--menu input[type=range]');
    const m = document.querySelector('.ao-panel--menu .ao-mute');
    const out = document.querySelector('.ao-panel--menu output');
    return { range: !!r, mute: m ? m.textContent : null, value: out ? out.textContent : null };
  });
  check('в меню есть ползунок громкости и «Без звука»', ui.range && !!ui.mute, JSON.stringify(ui));
  check('громкость по умолчанию 50%', ui.value === '50%', ui.value);
  await page.mouse.click(20, 740); // пустое место внизу слева: любой клик разблокирует звук
  await page.waitForFunction((n) => { const a = window.__ASHEN__.fx().audio; return a.created && a.samples && a.samples.loaded + a.samples.failed >= n; }, N_FILES, { timeout: 30000 }).catch(() => {});
  await sleep(600);
  const a1 = await audio();
  check('первый клик разблокировал звук', a1.created && a1.state === 'running', a1.state);
  check('все сэмплы загрузились', a1.samples && a1.samples.loaded === N_FILES && a1.samples.failed === 0, JSON.stringify(a1.samples));
  check('эмбиент арены играет из сэмпла', a1.ambient && a1.ambientSample, JSON.stringify({ ambient: a1.ambient, sample: a1.ambientSample }));
  await resetLevels(); await sleep(3000);
  report.levels.menuAmbient = await levels();
  check('эмбиент тихий (≤ −30 дБ RMS) и не молчит', report.levels.menuAmbient.rmsAvgDb < -30 && report.levels.menuAmbient.rmsAvgDb > -75, JSON.stringify(report.levels.menuAmbient));
  // M — без звука и обратно
  await page.keyboard.press('KeyM'); await sleep(250);
  const am = await audio();
  const btn = await page.evaluate(() => { const m = document.querySelector('.ao-panel--menu .ao-mute'); return m && { t: m.textContent, p: m.getAttribute('aria-pressed') }; });
  check('M выключает звук (громкость движка 0, кнопка нажата)', am.volume === 0 && btn && btn.p === 'true', JSON.stringify({ v: am.volume, btn }));
  await page.screenshot({ path: join(OUT, 'menu-muted.png') });
  await page.keyboard.press('KeyM'); await sleep(250);
  const au = await audio();
  check('второй M возвращает звук', au.volume === 0.5, `${au.volume}`);
  await page.screenshot({ path: join(OUT, 'menu.png') });
  // проба громкости: ползунок → «дзинь» на интерфейсной шине
  const before = (await probe()).starts;
  await page.evaluate(() => { const r = document.querySelector('.ao-panel--menu input[type=range]'); r.value = '60'; r.dispatchEvent(new Event('input', { bubbles: true })); r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  check('ползунок звучит пробой громкости', (await probe()).starts > before);
}

// ---------------------------------------------------------------- 2. бой (отладка с клавиатуры)
// бою хватает маленького окна: программный рендер быстрее, звуку размер окна не важен
await page.setViewportSize({ width: 800, height: 450 });
await clickText('Отладка с клавиатуры'); await sleep(200);
await clickText('Начать'); await sleep(400);
await clickText('Продолжить без камеры (DEBUG)'); await sleep(600);
// обучение: «ОШИБКА» по клавише H (демо-подсказка) и «Распознано» по переходу карточки
{
  const scr = await page.evaluate(() => window.__ASHEN__.screen);
  if (scr === 'tutorial') {
    let s0 = (await probe()).starts;
    await key('KeyH', 150); await sleep(1500);
    const s1 = (await probe()).starts;
    check('обучение: подсказка «ОШИБКА» звучит мягким «тук»', s1 > s0, `запусков ${s1 - s0}`);
    s0 = s1;
    await page.evaluate(() => {
      const chip = document.querySelector('.ao-tut-card .ao-chip') || (() => {
        const card = document.createElement('article'); card.className = 'ao-tut-card'; card.dataset.key = 'probe';
        const c = document.createElement('span'); c.className = 'ao-chip'; c.setAttribute('data-state', 'try'); card.append(c);
        document.querySelector('.ao-ui').append(card); return c;
      })();
      chip.setAttribute('data-state', 'seen');
    });
    await sleep(800);
    check('обучение: «✓ Распознано» звучит «дзинь»', (await probe()).starts > s0);
  } else check('экран обучения в отладке', false, scr);
}
await clickText('В бой'); await sleep(500);
// облёт-интро идёт по игровому времени: на программном рендере (мало кадров) это может занять минуту-две
await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 300000 });
report.fps = await page.evaluate(() => window.__ASHEN__.fps);
await sleep(800);

// простой: ни одного нового узла за 3 с (звук не создаётся в каждом кадре)
{
  await sleep(1500);
  const p0 = await probe(); await sleep(3000); const p1 = await probe();
  const d = totalCreated(p1) - totalCreated(p0);
  check('стоим на месте: звук не создаёт узлов в кадре', d === 0, `+${d} узлов за 3 с`);
}

// действия: каждое должно запустить хотя бы один звук
const ACTIONS = [
  ['ходьба (шаги)', 'KeyW', 2200],
  ['выстрел (J)', 'KeyJ', 900],
  ['искра (U)', 'KeyU', 80],
  ['рассечение (I)', 'KeyI', 80],
  ['щит (K)', 'KeyK', 1200],
  ['парирование (F)', 'KeyF', 80],
  ['рывок (пробел)', 'Space', 80],
  ['рывок вбок (E)', 'KeyE', 80],
  ['руна огня (1)', 'Digit1', 80],
  ['руна молнии (2)', 'Digit2', 80],
  ['руна света (3)', 'Digit3', 80],
  ['выброс (L)', 'KeyL', 80],
];
let peakVoices = 0;
const watch = setInterval(async () => {
  try { const a = await audio(); peakVoices = Math.max(peakVoices, a.voices); report.timeline.push([Date.now(), a.voices, a.activeVoices, a.loops]); } catch (e) { /* страница занята */ }
}, 100);
await resetLevels();
const perAction = [];
for (const [label, code, hold] of ACTIONS) {
  const s0 = (await probe()).starts;
  const c0 = totalCreated(await probe());
  if (code === 'KeyL') await resetLevels();
  await key(code, hold);
  await sleep(code === 'KeyL' ? 1400 : 650);
  const p = await probe();
  const st = p.starts - s0;
  perAction.push({ label, starts: st, nodes: totalCreated(p) - c0 });
  if (code === 'KeyL') report.levels.burst = await levels();
  check(`звук: ${label}`, st > 0, `запусков ${st}, узлов +${totalCreated(p) - c0}`);
  await sleep(250);
}
report.perAction = perAction;
check('выброс — «бабах»: громко, но без клиппинга', report.levels.burst && report.levels.burst.peakDb > -12 && report.levels.burst.peakDb <= 0.1, JSON.stringify(report.levels.burst));

// натиск: 6 с всего подряд — голоса упираются в потолок, а не растут
{
  const t0 = Date.now();
  const seq = ['KeyJ', 'KeyU', 'KeyI', 'KeyF', 'KeyE', 'KeyQ', 'Space', 'KeyJ', 'KeyU'];
  let i = 0;
  await resetLevels();
  while (Date.now() - t0 < 6000) { await key(seq[i++ % seq.length], 40); await sleep(30); }
  await sleep(300);
  report.levels.spam = await levels();
  const a = await audio();
  check('натиск: голосов не больше потолка ×2', peakVoices <= a.maxVoices * 2, `пик ${peakVoices}, потолок ${a.maxVoices}`);
  check('натиск: выход не клиппует', report.levels.spam.peakDb <= 0.1, JSON.stringify(report.levels.spam));
}
clearInterval(watch);
// после боя голоса освобождаются (узлы отключены, утечек нет)
{
  await sleep(4500);
  const a = await audio();
  check('через 4,5 с тишины голоса освобождены', a.voices <= a.loops + 1, JSON.stringify({ voices: a.voices, loops: a.loops, cats: a.categories }));
}
// пауза: петли и бой молчат, проба громкости слышна
{
  await page.keyboard.down('KeyK'); await sleep(500);
  await page.keyboard.press('Escape'); await sleep(400);
  await page.keyboard.up('KeyK');
  const a = await audio();
  check('пауза: экран паузы, движок в паузе, петли погашены', (await page.evaluate(() => window.__ASHEN__.screen)) === 'paused' && a.paused && a.loops === 0, JSON.stringify({ paused: a.paused, loops: a.loops }));
  const ui = await page.evaluate(() => ({ range: !!document.querySelector('.ao-panel--pause input[type=range]'), mute: !!document.querySelector('.ao-panel--pause .ao-mute') }));
  check('в паузе есть ползунок и «Без звука»', ui.range && ui.mute, JSON.stringify(ui));
  const s0 = (await probe()).starts;
  await page.evaluate(() => { const r = document.querySelector('.ao-panel--pause input[type=range]'); r.value = '55'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  check('пауза: проба громкости слышна', (await probe()).starts > s0);
  await page.setViewportSize({ width: 1366, height: 768 }); await sleep(800);
  await page.screenshot({ path: join(OUT, 'pause.png') });
  await page.evaluate(() => { const r = document.querySelector('.ao-panel--pause input[type=range]'); r.value = '50'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(200);
}

const pr = await probe();
report.created = pr.created;
report.contexts = pr.contexts;
check('один AudioContext на всю игру', pr.contexts === 1, `${pr.contexts}`);
check('без ошибок в консоли', errors.filter((e) => !/favicon|storage\.googleapis|mediapipe|404/i.test(e)).length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(OUT, 'sfx-report.json'), JSON.stringify(report, null, 1));
console.log(`\nуровни: ${JSON.stringify(report.levels)}\nскриншоты и отчёт: ${OUT}`);
console.log(failures ? `ПРОВАЛЕНО: ${failures}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
