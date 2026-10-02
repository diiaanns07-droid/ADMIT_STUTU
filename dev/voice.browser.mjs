// Голос тренера в настоящей игре (headless Chromium): node dev/voice.browser.mjs [--out DIR] [--port N]
// В контейнере нет системных голосов, поэтому speechSynthesis подменяется записывающей заглушкой (голоса
// приходят с задержкой — через voiceschanged, как в Chrome) и проверяется, ЧТО и КОГДА игра произносит:
//  - меню: голос найден, «Голос · V» рядом с «Без звука», строка громкости не выросла, V и M;
//  - обучение (отладка): показанная подсказка звучит фразой, «Распознано!» на пройденном шаге;
//  - бой (отладка): подсказка H → фраза «ОШИБКА», SFX тише во время речи, «Голос · V» в паузе;
//  - сохранённые «Новичок» и «Мастер» загружаются без ошибок;
//  - без русского голоса — «Голоса нет» и строка «русского голоса в системе нет»; без speechSynthesis — без ошибок.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { HINT_PHRASES } from '../core/voicePhrases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('--out', join(tmpdir(), 'ashen_voice'));
mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) { try { return req(p); } catch (e) { /* дальше */ } }
  throw new Error('playwright не найден');
}
const { chromium } = loadPlaywright();
const EXE = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p));

let failures = 0;
let menuHeadH = null;   // высота строки громкости в меню с найденным голосом
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

const browser = await chromium.launch({
  executablePath: EXE, headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// Заглушка speechSynthesis: mode 'ru' — русский и английский голоса, 'en' — только английский, 'none' — API нет.
// Фраза «звучит» 700 мс; window.__voiceLog — что сказано, с громкостью, языком и голосом.
function fakeSpeech(cfg) {
  if (cfg.mode === 'real') return;
  if (cfg.mode === 'none') {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true, writable: true });
    return;
  }
  const all = [{ name: 'Fake Irina', lang: 'ru-RU', localService: true, voiceURI: 'fake-irina', default: false },
    { name: 'Fake Alex', lang: 'en-US', localService: true, voiceURI: 'fake-alex', default: true }];
  const voices = cfg.mode === 'ru' ? all : all.slice(1);
  let list = [], cur = null, timer = 0;
  const ls = [];
  const log = (window.__voiceLog = []);
  window.__voiceCancels = 0;
  const synth = {
    getVoices: () => list.slice(),
    addEventListener: (t, f) => { if (t === 'voiceschanged') ls.push(f); },
    removeEventListener() {},
    get speaking() { return !!cur; }, get pending() { return false; }, get paused() { return false; },
    speak(u) {
      log.push({ text: u.text, t: Math.round(performance.now()), volume: u.volume, rate: u.rate, lang: u.lang, voice: u.voice ? u.voice.name : null, screen: window.__ASHEN__ ? window.__ASHEN__.screen : null });
      cur = u; clearTimeout(timer);
      timer = setTimeout(() => { if (cur === u) { cur = null; if (u.onend) u.onend({}); } }, 700);
    },
    cancel() { const c = cur; cur = null; clearTimeout(timer); window.__voiceCancels++; if (c && c.onerror) c.onerror({ error: 'interrupted' }); },
    pause() {}, resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  class FakeUtterance { constructor(t) { this.text = t; } }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true, writable: true });
  setTimeout(() => { list = voices; for (const f of ls) f(); }, 400);
}

async function open(mode, settings, viewport = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // программный рендер даёт единицы кадров: крупный шаг времени, чтобы облёт и бой не тянулись минутами
  await ctx.route(/\/config\.js(\?|$)/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript',
    body: readFileSync(join(ROOT, 'config.js'), 'utf8').replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.25').replace(/stallSec:\s*0\.25/, 'stallSec: 3') }));
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: 'low', qualityAuto: false, reducedMotion: true, ...settings });
  await ctx.addInitScript(fakeSpeech, { mode });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /VOICE/.test(m.text()))) errors.push(m.text()); });
  await page.goto(BASE + 'index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ASHEN__ && window.__ASHEN__.screen === 'menu', null, { timeout: 120000 });
  await sleep(800);
  return { ctx, page, errors };
}
const said = (page) => page.evaluate(() => (window.__voiceLog || []).map((x) => x.text));
const voiceState = (page) => page.evaluate(() => window.__ASHEN__.voice());
const pill = (page, panel) => page.evaluate((p) => {
  const b = document.querySelector(`.ao-panel--${p} .ao-voice`);
  const n = b && b.closest('.ao-field') && b.closest('.ao-field').querySelector('.ao-voice__note');
  return b && { text: b.textContent, pressed: b.getAttribute('aria-pressed'), disabled: b.getAttribute('aria-disabled'), visible: b.offsetParent !== null, note: n ? !n.hidden : null, headH: b.parentElement.getBoundingClientRect().height };
}, panel);
const clickText = (page, labels) => page.evaluate((ls) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && ls.includes(x.textContent.trim()));
  if (!b) return false; b.click(); return true;
}, labels);
const key = async (page, code, ms = 80) => { await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code); };

// ---------------------------------------------------------------- 1. меню, V и M, бой в отладке
{
  const { ctx, page, errors } = await open('ru', { gestureMode: 'novice' });
  const st = await voiceState(page);
  check('меню: русский голос найден после voiceschanged', st && st.state === 'ready' && st.voice === 'Fake Irina', JSON.stringify(st && { state: st.state, voice: st.voice }));
  const p0 = await pill(page, 'menu');
  check('меню: «Голос · V» рядом с «Без звука», включён', p0 && p0.visible && p0.text === 'Голос · V' && p0.pressed === 'true', JSON.stringify(p0));
  // строка громкости не выросла: та же высота, что у строки без кнопки голоса
  const grow = await page.evaluate(() => {
    const b = document.querySelector('.ao-panel--menu .ao-voice'); const head = b.parentElement;
    const h1 = head.getBoundingClientRect().height; b.style.display = 'none';
    const h0 = head.getBoundingClientRect().height; b.style.display = ''; return h1 - h0;
  });
  check('меню: строка громкости с кнопкой голоса не выше прежней', grow <= 0.5, `${grow.toFixed(1)} px`);
  menuHeadH = p0.headH;
  await page.screenshot({ path: join(OUT, 'voice-menu.png') });

  await page.mouse.click(5, 5); await sleep(200);   // действие пользователя: Chrome разрешает речь
  await page.keyboard.press('KeyV'); await sleep(300);
  const off = await pill(page, 'menu');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ashen-oath.settings.v1') || '{}').voice);
  check('V выключает голос (кнопка «Голос выкл · V», настройка сохранена)', off.text === 'Голос выкл · V' && off.pressed === 'false' && saved === false && (await voiceState(page)).enabled === false, JSON.stringify({ off, saved }));
  await page.keyboard.press('KeyV'); await sleep(600);
  check('второй V включает и подтверждает голосом', (await said(page)).includes('Голос тренера включён'), (await said(page)).join(' | '));
  await page.keyboard.press('KeyM'); await sleep(300);
  check('M («Без звука») глушит и голос', (await voiceState(page)).muted === true);
  await page.keyboard.press('KeyM'); await sleep(300);
  const v0 = (await page.evaluate(() => window.__voiceLog[0])) || {};
  check('фраза: ru-RU, выбранный голос, громкость по ползунку', v0.lang === 'ru-RU' && v0.voice === 'Fake Irina' && v0.volume > 0.5 && v0.volume <= 1, JSON.stringify(v0));

  // обучение в отладке: H — подсказка шага, W — пройти шаг «Ход». Маленькое окно: программный рендер быстрее
  await page.setViewportSize({ width: 480, height: 270 });
  await clickText(page, ['Отладка с клавиатуры']); await sleep(200);
  await clickText(page, ['Играть', 'Начать']); await sleep(500);
  await clickText(page, ['Продолжить без камеры (DEBUG)']); await sleep(800);
  const scr = await page.evaluate(() => window.__ASHEN__.screen);
  if (scr === 'tutorial') {
    const n0 = (await said(page)).length;
    await key(page, 'KeyH', 300); await sleep(1200);
    const after = (await said(page)).slice(n0);
    const shown = await page.evaluate(() => { const c = document.querySelector('[data-voice-hint]'); return c && c.getAttribute('data-voice-hint'); });
    const phrase = shown ? HINT_PHRASES[shown.split('|')[0]] : null;
    check('обучение: показанная подсказка звучит своей фразой', !!phrase && after.includes(phrase), `${shown} → ${after.join(' | ')}`);
    await sleep(2600);
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => document.querySelector('.ao-trn-pill[data-state="ok"]'), null, { timeout: 20000 }).catch(() => {});
    await page.keyboard.up('KeyW');
    await page.waitForFunction(() => window.__voiceLog.some((x) => x.text === 'Распознано!'), null, { timeout: 6000 }).catch(() => {});
    check('обучение: пройденный шаг — «Распознано!»', (await said(page)).includes('Распознано!'), (await said(page)).slice(n0).join(' | '));
  } else check('экран обучения в отладке', false, scr);

  await clickText(page, ['Пропустить обучение']); await sleep(600);
  await clickText(page, ['В бой']); await sleep(500);
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 300000 }).catch(() => {});
  if ((await page.evaluate(() => window.__ASHEN__.screen)) === 'playing') {
    await sleep(3000);
    const n0 = (await said(page)).length;
    await key(page, 'KeyH', 200);
    await page.waitForFunction((n) => window.__voiceLog.length > n, n0, { timeout: 8000 }).catch(() => {});
    const duck = await page.evaluate(() => window.__ASHEN__.fx().audio.volume);
    const fresh = (await said(page)).slice(n0);
    const ok = fresh.some((t) => Object.values(HINT_PHRASES).includes(t) || t === 'Ещё раз, чётче!');
    check('бой: подсказка «ОШИБКА» звучит фразой', ok, fresh.join(' | '));
    check('бой: пока звучит голос — SFX тише (0,5 → 0,3)', Math.abs(duck - 0.3) < 0.02, `${duck}`);
    const back = await page.waitForFunction(() => Math.abs(window.__ASHEN__.fx().audio.volume - 0.5) < 0.02, null, { timeout: 8000 }).then(() => true, () => false);
    check('бой: после речи громкость SFX вернулась', back, `${await page.evaluate(() => window.__ASHEN__.fx().audio.volume)}`);
    // 10 подсказок подряд за ~3 с — не больше 2–3 фраз
    const n1 = (await said(page)).length;
    for (let i = 0; i < 10; i++) { await key(page, 'KeyH', 60); await sleep(240); }
    await sleep(1500);
    const burst = (await said(page)).slice(n1);
    check('бой: 10 подсказок подряд → не больше 3 фраз', burst.length >= 1 && burst.length <= 3, `${burst.length}: ${burst.join(' | ')}`);
    await page.keyboard.press('Escape'); await sleep(500);
    await page.setViewportSize({ width: 1366, height: 768 }); await sleep(1500);
    const pp = await pill(page, 'pause');
    check('пауза: «Голос · V» на месте', pp && pp.visible && pp.text === 'Голос · V', JSON.stringify(pp));
    await page.screenshot({ path: join(OUT, 'voice-pause.png') });
  } else check('бой в отладке начался', false, await page.evaluate(() => window.__ASHEN__.screen));
  check('без ошибок в консоли (меню, обучение, бой)', errors.length === 0, errors.slice(0, 3).join(' | '));
  const log = await page.evaluate(() => window.__voiceLog);
  console.log('      сказано:', log.map((x) => `${(x.t / 1000).toFixed(1)}s ${x.screen}: ${x.text}`).join('\n              '));
  await ctx.close();
}

// ---------------------------------------------------------------- 2. «Мастер» из сохранения
{
  const { ctx, page, errors } = await open('ru', { gestureMode: 'master', autoWalk: false });
  const st = await voiceState(page);
  check('«Мастер»: голос готов, ошибок нет', st && st.state === 'ready' && errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- 3. нет русского голоса / нет API
{
  const { ctx, page, errors } = await open('en', {});
  await sleep(3500);
  const st = await voiceState(page);
  const p = await pill(page, 'menu');
  check('нет русского: в меню «Нет русского голоса», кнопка неактивна, меню не выросло', st.state === 'no-ru' && p.text === 'Нет русского голоса' && p.disabled === 'true' && p.note === false && p.headH === menuHeadH, JSON.stringify({ state: st.state, p, menuHeadH }));
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ashen-oath.settings.v1') || '{}').voice);
  await page.evaluate(() => document.querySelector('.ao-panel--menu .ao-voice').click()); await sleep(300);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('ashen-oath.settings.v1') || '{}').voice);
  check('нет русского: клик по кнопке ничего не меняет', before === after);
  await page.screenshot({ path: join(OUT, 'voice-menu-no-ru.png') });
  // пауза: строка «русского голоса в системе нет» под громкостью (отладочный бой → Esc)
  await page.setViewportSize({ width: 480, height: 270 });
  await clickText(page, ['Отладка с клавиатуры']); await sleep(200);
  await clickText(page, ['Играть', 'Начать']); await sleep(500);
  await clickText(page, ['Продолжить без камеры (DEBUG)']); await sleep(800);
  await clickText(page, ['Пропустить обучение']); await sleep(600);
  await clickText(page, ['В бой']); await sleep(500);
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 300000 }).catch(() => {});
  await sleep(1500); await page.keyboard.press('Escape'); await sleep(500);
  await page.setViewportSize({ width: 1366, height: 768 }); await sleep(1500);
  const pp = await pill(page, 'pause');
  const noteText = await page.evaluate(() => { const n = document.querySelector('.ao-panel--pause .ao-voice__note'); return n && !n.hidden ? n.textContent : null; });
  check('нет русского: в паузе строка «Русского голоса в системе нет…»', pp && pp.text === 'Нет русского голоса' && /русского голоса в системе нет/i.test(noteText || ''), JSON.stringify({ pp, noteText }));
  await page.screenshot({ path: join(OUT, 'voice-pause-no-ru.png') });
  check('нет русского: ничего не сказано и ошибок нет', (await said(page)).length === 0 && errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}
{
  const { ctx, page, errors } = await open('none', {});
  const st = await voiceState(page);
  await page.keyboard.press('KeyV'); await sleep(300);
  check('без speechSynthesis: «нет API», V и меню без ошибок', st.state === 'no-api' && errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await open('real', {});
  await sleep(3500);
  const st = await voiceState(page);
  console.log(`      настоящий speechSynthesis этого Chromium: ${st.state}${st.voice ? ` (${st.voice})` : ''}`);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failures ? `\nПРОВАЛЕНО: ${failures}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failures ? 1 : 0);
