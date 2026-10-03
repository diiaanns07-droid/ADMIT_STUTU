// [W4-ВИТРИНА] Снимки меню-витрины для каждого героя, замер цены (renderInfo) и видео смены героев.
// node tools/menu_shots.mjs --out DIR [--quality low|medium|high] [--heroes ashen,elf,dark,ranger,archmage]
//                           [--size 1280x720] [--video FILE.mp4] [--video-sec 15] [--fps 30] [--tag before]
//                           [--battle] (ещё снимок и замер в бою — проверка, что витрина в бою ничего не добавляет)
//                           [--zone edge|arena|forest] — место старта (по умолчанию edge, как у игрока впервые)
// Программный рендер в облаке даёт ~1 кадр/с, поэтому часы страницы (performance.now и requestAnimationFrame)
// подменяются: игра шагает ровно на 1/fps с, кадр снимается скриншотом Playwright (как tools/kino_video.mjs).
// Итог: DIR/<tag>_<quality>_<NN>_<hero>.jpg, DIR/<tag>_<quality>_budget.json (renderInfo по героям и в бою).

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, 'dev', 'shots', 'menu')));
const Q = argOf('--quality', 'high');
const TAG = argOf('--tag', 'shot');
const HEROES = argOf('--heroes', 'ashen,elf,dark,ranger,archmage').split(',');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const FPS = +argOf('--fps', '30');
const VIDEO = argOf('--video', '') ? resolve(argOf('--video')) : '';
const VIDEO_SEC = +argOf('--video-sec', '15');
const BATTLE = argv.includes('--battle');
const ZONE = argOf('--zone', 'edge');
const SETTLE = +argOf('--settle', '5');   // секунд виртуального времени после смены героя до снимка (наезд камеры — 4,4 с)
const SETTLE_FPS = +argOf('--settle-fps', '10');   // без записи шагаем крупнее: SwiftShader рисует кадр секундами
const FRAMES = join(argOf('--tmp', tmpdir()), `menu_frames_${process.pid}`);
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

// Виртуальные часы: до __mVirtual(true) страница живёт как обычно, потом время идёт только по __mStep(ms).
const CLOCK = () => {
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__mVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__mStep = (ms) => {
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
mkdirSync(OUT, { recursive: true });
if (VIDEO) { rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true }); mkdirSync(dirname(VIDEO), { recursive: true }); }

const report = { quality: Q, zone: ZONE, size: [W, H], heroes: {}, battle: null, errors: [] };
let n = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); localStorage.setItem('ashen-oath.showcase-hint', '1'); } catch (e) { /* ignore */ } },
    { quality: Q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0, hero: HEROES[0], startZone: ZONE, startZoneV: 2 });
  await ctx.addInitScript(CLOCK);
  // dt кадра без обрезки (виртуальные 1/30 с и так ровные), без «зависаний» по таймеру
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text()).replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
    return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => report.errors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${PORT}/?uncapped=1`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 120000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return h && h.ready; }, null, { timeout: 180000 }).catch(() => {});
  await sleep(1500);
  await page.evaluate(() => window.__mVirtual(true));
  const step = async (save, fps = FPS) => {
    await page.evaluate((ms) => window.__mStep(ms), 1000 / fps);
    if (save && VIDEO) { n++; await page.screenshot({ path: join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90, timeout: 300000 }); }
  };
  const steps = async (sec, save) => { const f = save ? FPS : SETTLE_FPS; for (let i = 0; i < Math.round(sec * f); i++) await step(save, f); };
  // выбор героя — как игрок: клик по карточке
  const pick = (id) => page.evaluate((v) => { const i = document.querySelector(`.ao-herocard__input[value="${v}"]`); if (i && !i.checked) i.click(); return !!i; }, id);
  // модель грузится в реальном времени (сеть, разбор, оболочка): без записи — ждём, изредка шагая кадром
  // (кадр SwiftShader отнимает процессор у загрузки); с записью — каждый шаг идёт в ролик (видно призыв)
  const waitHero = async (id, save) => {
    for (let i = 0; i < 2400; i++) {
      const ok = await page.evaluate((v) => { const h = window.__ASHEN__.hero(); return !!(h && h.ready && h.hero === v); }, id);
      if (ok) return true;
      if (save) await step(true);
      else { await sleep(300); if (i % 8 === 7) await step(false, SETTLE_FPS); }
    }
    return false;
  };
  const info = () => page.evaluate(() => ({ r: window.__ASHEN__.renderInfo(), sc: window.__ASHEN__.heroShowcase(), stage: window.__ASHEN__.heroShowcase() && window.__ASHEN__.heroShowcase().stage, fps: window.__ASHEN__.fps }));
  await steps(1.0, false);
  for (let k = 0; k < HEROES.length; k++) {
    const id = HEROES[k];
    await pick(id);
    const ok = await waitHero(id, false);
    await steps(SETTLE, false);
    const p = join(OUT, `${TAG}_${Q}_${String(k + 1).padStart(2, '0')}_${id}.jpg`);
    await page.screenshot({ path: p, type: 'jpeg', quality: 90, timeout: 300000 });
    report.heroes[id] = { ready: ok, ...(await info()) };
    console.error('[menu_shots]', Q, id, JSON.stringify(report.heroes[id].r));
  }
  if (VIDEO) {
    // ролик: герой за героем, по ~3 с на каждого (смена — вспышка, волна, наезд камеры)
    const per = VIDEO_SEC / HEROES.length;
    await pick(HEROES[HEROES.length - 1] === HEROES[0] ? HEROES[1] : HEROES[0]);
    for (let k = 0; k < HEROES.length; k++) {
      const id = HEROES[(k + 1) % HEROES.length];
      await pick(id);
      await waitHero(id, true);
      await steps(per, true);
    }
  }
  if (BATTLE) {
    // в бой без камеры: витрина гаснет, её свет и сцена не должны добавить ни одного вызова
    const btn = (text) => page.locator('button:visible', { hasText: text }).first();
    await page.evaluate(() => window.__mVirtual(false));
    await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click().catch(() => {});
    await btn('Играть').click().catch(() => {}); await sleep(300);
    await btn('Продолжить без камеры').click().catch(() => {}); await sleep(500);
    await btn('В бой').click().catch(() => {});
    await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 }).catch(() => {});
    await page.evaluate(() => window.__mVirtual(true));
    await steps(4.0, false);   // витрина гаснет и через 2 с вне меню освобождает сцену
    await page.screenshot({ path: join(OUT, `${TAG}_${Q}_battle.jpg`), type: 'jpeg', quality: 88, timeout: 300000 });
    report.battle = await info();
    console.error('[menu_shots] бой', JSON.stringify(report.battle.r));
  }
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(join(OUT, `${TAG}_${Q}_budget.json`), JSON.stringify(report, null, 1));
if (VIDEO && n) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO]);
  rmSync(FRAMES, { recursive: true, force: true });
}
console.log(JSON.stringify({ out: OUT, video: VIDEO || null, frames: n, errors: report.errors.slice(0, 8) }, null, 1));
