// [W3-КИНО] Видео и кадры сцен Регента: переход в фазу 2 (рёв, гроза, молния) и гибель (перегрев, осколки, облёт).
// node tools/kino_video.mjs [--quality high] [--size 1280x720] [--fps 30] [--out docs/video/kino.mp4]
//                           [--shots docs/screenshots/kino] [--root DIR]
// Программный рендер в облаке даёт < 1 кадра в секунду, поэтому запись пошаговая: часы страницы (performance.now
// и requestAnimationFrame) подменяются, игра шагает ровно на 1/fps с, каждый кадр снимается скриншотом
// Playwright и склеивается ffmpeg. Игровое время в ролике — настоящее.
// Как в tools/kino_perf.mjs: «Отладка с клавиатуры», HP Регента 0,7 → 0,12 (подмена ответа config.js),
// выброс L → фаза 2, руна 1 (огненное копьё) → гибель.

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const Q = argOf('--quality', 'high');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const FPS = +argOf('--fps', '30');
const OUT = resolve(argOf('--out', join(HERE, 'docs/video/kino.mp4')));
const SHOTS = resolve(argOf('--shots', join(HERE, 'docs/screenshots/kino')));
const FRAMES = join(argOf('--tmp', tmpdir()), `kino_frames_${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* ignore */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* next */ } }
  throw new Error('playwright не найден');
}
let PORT = 20000 + Math.floor(Math.random() * 20000);
function startServer() {
  const py = spawn('python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('server exit ' + c + ' ' + out)));
  });
}

// Виртуальные часы: до __kinoVirtual(true) страница живёт как обычно, потом время идёт только по __kinoStep(ms).
const CLOCK = () => {
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__kinoVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__kinoStep = (ms) => {
    vt += ms;
    const qq = q; q = [];
    for (const cb of qq) { try { cb(vt); } catch (e) { console.error(e); } }
    return qq.length;
  };
};

const { chromium } = loadPlaywright();
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } }
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

let n = 0;
const marks = [];
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: Q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0 });
  await ctx.addInitScript(CLOCK);
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text())
      .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5')
      .replace(/easy:\s*\{\s*bossHp:\s*0\.7/, 'easy: { bossHp: 0.12');
    return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  const btn = (text) => page.locator('button:visible', { hasText: text }).first();
  await page.goto(`http://127.0.0.1:${PORT}/?uncapped=1`);
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 120000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 120000 }).catch(() => {});
  await sleep(1500);
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
  await btn('Играть').click(); await sleep(300);
  await btn('Продолжить без камеры').click(); await sleep(500);
  await btn('В бой').click();
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
  const step = async (save = true) => {
    await page.evaluate((ms) => window.__kinoStep(ms), 1000 / FPS);
    if (save) { n++; await page.screenshot({ path: join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 }); }
  };
  const state = () => page.evaluate(() => { const s = window.__ASHEN__.snapshot(); const k = window.__ASHEN__.kino(); return { st: s.status, stage: s.boss.stage, hp: s.boss.hp, enc: s.player.encounter, bolts: k && k.storm ? k.storm.bolts : 0, storm: k && k.storm ? k.storm.w : 0 }; });
  const shot = async (name) => { const p = join(SHOTS, `${name}.jpg`); await page.screenshot({ path: p, type: 'jpeg', quality: 88 }); marks.push({ name, frame: n }); };
  // к Регенту — в реальном времени (быстрее), запись — уже в арене, по виртуальным часам
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 240000 }).catch(() => {});
  await page.keyboard.up('KeyW');
  await page.evaluate(() => window.__kinoVirtual(true));
  for (let i = 0; i < 45; i++) await step(false);   // герой остановился, камера легла
  await shot('1_phase1');

  // 1. выброс → фаза 2
  for (let i = 0; i < Math.round(0.6 * FPS); i++) await step();
  await page.keyboard.press('KeyL');
  let s = await state();
  for (let i = 0; i < 8 * FPS && s.stage !== 2; i++) { await step(); if (i % 3 === 0) s = await state(); }
  let roarShot = false, boltShot = false, bolts0 = s.bolts;
  // 2. сцена перехода и гроза: до первой молнии (но не меньше 4,5 с)
  for (let i = 0; i < 8 * FPS; i++) {
    await step();
    if (!roarShot && i === Math.round(0.75 * FPS)) { roarShot = true; await shot('2_phase2_roar'); }
    s = await state();
    if (!boltShot && s.bolts > bolts0) { boltShot = true; await step(); await shot('3_phase2_bolt'); }
    if (i >= 4.5 * FPS && boltShot && i % FPS === 0) break;
  }
  await shot('4_phase2_storm');
  // 3. добить: руна 1, если не хватило — выброс
  await page.keyboard.press('Digit1');
  for (let i = 0; i < 4 * FPS && s.st === 'playing'; i++) {
    await step(); s = await state();
    if (i === Math.round(1.6 * FPS) && s.st === 'playing') await page.keyboard.press('KeyL');
  }
  // 4. гибель: перегрев, осколки, облёт камеры
  for (let i = 0; i < Math.round(3.2 * FPS); i++) {
    await step();
    if (i === Math.round(0.3 * FPS)) await shot('5_death_heat');
    if (i === Math.round(1.0 * FPS)) await shot('6_death_shards');
    if (i === Math.round(2.5 * FPS)) await shot('7_death_orbit');
  }
  console.error('[kino_video] итог', JSON.stringify(await state()), 'ошибки', JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT]);
console.log(JSON.stringify({ out: OUT, frames: n, sec: +(n / FPS).toFixed(1), shots: marks }, null, 1));
rmSync(FRAMES, { recursive: true, force: true });
