// [W4-BOSS] Видео Регента в настоящей игре: замахи с телеграфами (тело накаляется за 0,6–1 с до удара), попадания
// по Регенту, переход во вторую фазу. Плюс замер window.__ASHEN__.renderInfo() в бою (--budget: без видео).
// node tools/boss_video.mjs [--quality high] [--size 1280x720] [--fps 30] [--sec 14] [--out docs/video/boss.mp4]
//                           [--shots DIR] [--root DIR] [--budget out.json]
// Как tools/kino_video.mjs: программный рендер в облаке даёт < 1 кадра в секунду, поэтому часы страницы
// (performance.now и requestAnimationFrame) подменяются, игра шагает ровно на 1/fps с, каждый кадр снимается.
// «Отладка с клавиатуры», лёгкая сложность, HP Регента 0,7 → 0,25 (подмена config.js), чтобы фаза 2 наступила в кадре.

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
const SEC = +argOf('--sec', '14');
const OUT = resolve(argOf('--out', join(HERE, 'docs/video/boss.mp4')));
const SHOTS = argOf('--shots', null);
const BUDGET = argOf('--budget', null);
const FRAMES = join(argOf('--tmp', tmpdir()), `boss_frames_${process.pid}`);
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
  const py = spawn('python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
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
if (!BUDGET) { rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true }); mkdirSync(dirname(OUT), { recursive: true }); }
if (SHOTS) mkdirSync(resolve(SHOTS), { recursive: true });

let n = 0;
const marks = [];
let budget = null;
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: Q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0 });
  await ctx.addInitScript(CLOCK);
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text())
      .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5')
      .replace(/easy:\s*\{\s*bossHp:\s*0\.7/, 'easy: { bossHp: 0.25');
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
  // на программном рендере меню high первые ~минуту подвисает на компиляции шейдеров — клики ждут дольше
  const CLICK = { timeout: 300000 };
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click(CLICK);
  await btn('Играть').click(CLICK); await sleep(300);
  await btn('Продолжить без камеры').click(CLICK); await sleep(500);
  await btn('В бой').click(CLICK);
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
  const step = async (save = true) => {
    await page.evaluate((ms) => window.__kinoStep(ms), 1000 / FPS);
    if (save && !BUDGET) { n++; await page.screenshot({ path: join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 }); }
  };
  const state = () => page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { st: s.status, stage: s.boss.stage, hp: Math.round(s.boss.hp), act: s.boss.action, tel: s.telegraphs.map((t) => t.kind + ':' + t.remaining.toFixed(2)).join(','), enc: s.player.encounter, php: Math.round(s.player.hp) }; });
  const shot = async (name) => { if (!SHOTS) return; const p = join(resolve(SHOTS), `${name}.jpg`); await page.screenshot({ path: p, type: 'jpeg', quality: 90 }); marks.push({ name, frame: n }); };
  // к Регенту — в реальном времени, съёмка — уже в арене, по виртуальным часам
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 240000 }).catch(() => {});
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Tab');   // список жестов слева скрыт — в кадре сцена
  await page.evaluate(() => window.__kinoVirtual(true));
  for (let i = 0; i < 45; i++) await step(false);   // герой остановился, камера легла

  if (BUDGET) {
    // замер: 60 кадров боя, медиана по каждому полю renderInfo()
    const rows = [];
    for (let i = 0; i < 60; i++) { await step(false); if (i % 3 === 0) rows.push(await page.evaluate(() => window.__ASHEN__.renderInfo())); }
    const med = (k) => { const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
    budget = { quality: Q, frames: rows.length, calls: med('calls'), triangles: med('triangles'), textures: med('textures'), geometries: med('geometries'), programs: med('programs'), shadowLights: med('shadowLights'), state: await state() };
  } else {
    // ~SEC с: фаза 1 — огонь по Регенту (J), его замахи с телеграфами; на ~45 % — выброс (L) → фаза 2
    const total = Math.round(SEC * FPS);
    let s = await state(), lastTel = '', burst = false, p2Shot = false, hitShot = false;
    for (let i = 0; i < total; i++) {
      const t = i / FPS;
      if (t > 0.6 && t < 2.2 && !page.__j) { await page.keyboard.down('KeyJ'); page.__j = true; }
      if (t >= 2.2 && page.__j) { await page.keyboard.up('KeyJ'); page.__j = false; }
      if (!burst && t > SEC * 0.45 && s.stage === 1) { burst = true; await page.keyboard.press('KeyL'); }
      await step();
      if (i % 2 === 0) s = await state();
      if (s.tel && s.tel !== lastTel) {
        const [kind, rem] = s.tel.split(',')[0].split(':');
        if (+rem < 0.5 && !marks.some((m) => m.name === 'windup_' + kind + '_' + s.stage)) await shot('windup_' + kind + '_' + s.stage);
      }
      lastTel = s.tel;
      if (!hitShot && page.__j && t > 1.2) { hitShot = true; await shot('hit'); }
      if (!p2Shot && s.stage === 2 && burst) { p2Shot = true; for (let k = 0; k < Math.round(1.2 * FPS); k++) { await step(); i++; } await shot('phase2'); }
    }
    console.error('[boss_video] итог', JSON.stringify(await state()));
  }
  if (errors.length) console.error('[boss_video] ошибки', JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
if (BUDGET) {
  writeFileSync(resolve(BUDGET), JSON.stringify(budget, null, 1));
  console.log(JSON.stringify(budget));
} else {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT]);
  console.log(JSON.stringify({ out: OUT, frames: n, sec: +(n / FPS).toFixed(1), shots: marks }, null, 1));
  rmSync(FRAMES, { recursive: true, force: true });
}
