// [W4-ЛИЦО] Видео лиц героинь на витрине меню: приближение к лицу, моргание, поворот мышью, смена героини.
// node tools/face_video.mjs [--quality high] [--size 1280x720] [--fps 30] [--heroes elf,dark,ranger] [--sec 4.2]
//                           [--out docs/video/faces.mp4] [--shots DIR] [--root DIR] [--wheel 6]
// Как tools/kino_video.mjs: программный рендер в облаке даёт ~1 кадр/с, поэтому часы страницы (performance.now
// и requestAnimationFrame) подменяются, игра шагает ровно на 1/fps, каждый кадр снимается скриншотом и
// склеивается ffmpeg. Math.random страницы — с зерном: моргания в ролике одни и те же от запуска к запуску.

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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
const SEC = +argOf('--sec', '4.2');
const WHEEL = +argOf('--wheel', '6');
const HEROES = argOf('--heroes', 'elf,dark,ranger').split(',');
const OUT = resolve(argOf('--out', join(HERE, 'docs/video/faces.mp4')));
const SHOTS = argOf('--shots', '') ? resolve(argOf('--shots')) : '';
const FRAMES = join(argOf('--tmp', tmpdir()), `face_frames_${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = { elf: 'Эльфийка', dark: 'Тёмная чародейка', ranger: 'Лучница', ashen: 'Пепельный страж', archmage: 'Архимаг' };

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
    const to = setTimeout(() => { py.kill(); rej(new Error('server timeout: ' + out)); }, 15000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
  });
}

// Виртуальные часы (как в kino_video.mjs) и случайность с зерном
const CLOCK = () => {
  let sd = 20261002;
  Math.random = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__faceVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__faceStep = (ms) => {
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
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

let n = 0;
const marks = [];
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { hero: HEROES[0], quality: Q, qualityAuto: false, volume: 0 });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${PORT}/?uncapped=1`);
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => {});
  const ready = (id) => page.waitForFunction((h) => { const s = window.__ASHEN__.hero(); return s && s.ready && s.hero === h; }, id, { timeout: 600000, polling: 500 });
  await ready(HEROES[0]);
  await page.evaluate(() => window.__faceVirtual(true));
  const step = async (save = true) => {
    await page.evaluate((ms) => window.__faceStep(ms), 1000 / FPS);
    if (save) { n++; await page.screenshot({ path: join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 }); }
  };
  const shot = async (name) => { if (!SHOTS) return; await page.screenshot({ path: join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 90 }); marks.push({ name, frame: n }); };
  // приближение к лицу (колесо над героем, как на экране выбора BDO), камера ложится без записи
  const zoomIn = async () => {
    await page.mouse.move(W * 0.72, H * 0.42);
    for (let i = 0; i < WHEEL; i++) { await page.mouse.wheel(0, -300); await step(false); await step(false); }
    for (let i = 0; i < 45; i++) await step(false);
  };
  for (let h = 0; h < HEROES.length; h++) {
    const id = HEROES[h];
    if (h > 0) {
      // смена героини кнопкой меню: модель грузится в реальном времени, часы стоят. Клик — из страницы:
      // проверка «элемент неподвижен» у Playwright ждёт кадров rAF, а при виртуальных часах их нет
      await page.evaluate(() => window.__faceVirtual(false));
      const ok = await page.evaluate((label) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === label); if (b) b.click(); return !!b; }, NAMES[id] || id);
      if (!ok) throw new Error('нет кнопки героя: ' + (NAMES[id] || id));
      await ready(id);
      await page.evaluate(() => window.__faceVirtual(true));
      for (let i = 0; i < 20; i++) await step(false);   // поза Idle, шейдеры собраны
    }
    await zoomIn();
    const total = Math.round(SEC * FPS);
    for (let i = 0; i < total; i++) {
      // на середине — поворот перетаскиванием (3/4), потом витрина сама возвращается
      if (i === Math.round(total * 0.45)) await page.mouse.down();
      if (i > Math.round(total * 0.45) && i <= Math.round(total * 0.45) + 8) await page.mouse.move(W * 0.72 + (i - Math.round(total * 0.45)) * W * 0.012, H * 0.42);
      if (i === Math.round(total * 0.45) + 9) await page.mouse.up();
      await step();
      if (i === 8) await shot(`${id}_face`);
      if (i === Math.round(total * 0.8)) await shot(`${id}_turn`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'slow', '-movflags', '+faststart', OUT]);
rmSync(FRAMES, { recursive: true, force: true });
console.log(JSON.stringify({ out: OUT, frames: n, sec: +(n / FPS).toFixed(1), shots: marks }, null, 1));
