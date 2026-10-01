// Длительный прогон в браузере: node tools/qa_soak.mjs [--minutes 10] [--out DIR]
// DEBUG-ввод (клавиатура через CDP) — это проверка стабильности сборки, НЕ проверка CV.
// Каждые 30 с снимается: JS heap после принудительного GC, renderer.info (геометрии/текстуры/программы), размеры
// массивов снимка, FPS. Бой перезапускается при каждом исходе.
// FPS в headless Chrome (часто программный WebGL) не характеризует реальное железо.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MINUTES = Number(argOf('--minutes', 10));
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_soak')));
mkdirSync(OUT, { recursive: true });
const BROWSER = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
const PORT = 8796, DBG = 9661;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('python', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: 'ignore' });
await sleep(1200);
const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${join(tmpdir(), 'ashen_soak_prof_' + Date.now())}`,
  '--enable-unsafe-swiftshader', '--window-size=1366,768', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* wait */ } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(label)}); if (b && b.getAttribute('aria-disabled') !== 'true') { b.click(); return true; } return false; })()`);
const key = (code, type) => send('Input.dispatchKeyEvent', { type, code, key: code.slice(3).toLowerCase(), windowsVirtualKeyCode: code.slice(3).charCodeAt(0) });

await send('Runtime.enable'); await send('Performance.enable'); await send('HeapProfiler.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 100 && !(await ev('!!window.__ASHEN__')); i++) await sleep(200);
await click('Отладка с клавиатуры'); await sleep(100);
await click('Играть'); await sleep(100);
await click('Продолжить без камеры (DEBUG)'); await sleep(100);
await click('В бой'); await sleep(300);

const samples = [];
const t0 = Date.now();
let outcomes = { victory: 0, defeat: 0 };
let nextSample = 0;
let held = new Set();
const setHeld = async (want) => {
  for (const k of held) if (!want.has(k)) await key(k, 'keyUp');
  for (const k of want) if (!held.has(k)) await key(k, 'keyDown');
  held = want;
};
while (Date.now() - t0 < MINUTES * 60000) {
  const el = (Date.now() - t0) / 1000;
  const scr = await ev('__ASHEN__.screen');
  if (scr === 'victory' || scr === 'defeat') {
    outcomes[scr]++;
    await setHeld(new Set());
    await sleep(800);
    await click('Сразиться снова');
    await sleep(200);
    continue;
  }
  // простая «игра»: по телеграфу — щит/уход, иначе огонь; изредка рывок и выброс
  const s = await ev('(() => { const s = __ASHEN__.snapshot(); return s && { t: s.telegraphs[0] || null, e: s.player.energy, p: s.player.position }; })()');
  const want = new Set();
  if (s && s.t && s.t.kind === 'slam') want.add(Math.sin(el / 7) > 0 ? 'KeyD' : 'KeyA');
  else if (s && s.t && s.t.remaining < 0.7) want.add('KeyK');
  else want.add('KeyJ');
  await setHeld(want);
  if (Math.random() < 0.03) { await key(Math.random() < 0.5 ? 'KeyQ' : 'KeyE', 'keyDown'); await key(Math.random() < 0.5 ? 'KeyQ' : 'KeyE', 'keyUp'); await key('KeyQ', 'keyUp'); await key('KeyE', 'keyUp'); }
  if (Math.random() < 0.01) { await key('KeyL', 'keyDown'); await key('KeyL', 'keyUp'); }
  if (el >= nextSample) {
    nextSample += 30;
    await send('HeapProfiler.collectGarbage'); // удерживаемая память, а не «пила» сборщика
    const m = await send('Performance.getMetrics');
    const heap = m.result.metrics.find((x) => x.name === 'JSHeapUsedSize').value;
    const info = await ev('({ r: __ASHEN__.renderInfo(), fps: __ASHEN__.fps, s: (() => { const s = __ASHEN__.snapshot(); return s ? { proj: s.projectiles.length, tel: s.telegraphs.length, time: +s.time.toFixed(1) } : null; })() })');
    samples.push({ tSec: Math.round(el), heapMB: +(heap / 1048576).toFixed(1), ...info.r, fps: info.fps, ...info.s });
    console.log(JSON.stringify(samples[samples.length - 1]));
  }
  await sleep(120);
}
await setHeld(new Set());
ws.close(); br.kill(); srv.kill();

const first = samples[Math.min(2, samples.length - 1)], lastS = samples[samples.length - 1];
const report = {
  minutes: MINUTES, outcomes, errors: errors.slice(0, 10), errorCount: errors.length,
  heapMB: { afterWarmup: first.heapMB, end: lastS.heapMB, max: Math.max(...samples.map((x) => x.heapMB)) },
  geometries: { afterWarmup: first.geometries, end: lastS.geometries, max: Math.max(...samples.map((x) => x.geometries)) },
  textures: { afterWarmup: first.textures, end: lastS.textures, max: Math.max(...samples.map((x) => x.textures)) },
  programs: { afterWarmup: first.programs, end: lastS.programs },
  maxProjectiles: Math.max(...samples.map((x) => x.proj || 0)), maxTelegraphs: Math.max(...samples.map((x) => x.tel || 0)),
  fpsHeadless: { min: Math.min(...samples.map((x) => x.fps)), max: Math.max(...samples.map((x) => x.fps)) },
  samples,
};
writeFileSync(join(OUT, 'soak_report.json'), JSON.stringify(report, null, 1));
console.log('REPORT', JSON.stringify({ ...report, samples: undefined }));
process.exit(0);
