// [W4-УДАР] Видео, кадры и замер бюджета попаданий: серия ударов по Регенту, удар Регента в щит, следы на земле.
// node tools/hit_video.mjs [--quality high] [--size 1280x720] [--fps 30] [--sec 15] [--out docs/video/hits.mp4]
//                          [--shots docs/screenshots/hits] [--label after] [--root DIR] [--no-video]
// node tools/hit_video.mjs --budget [--quality low,high] [--root DIR]   — таблица renderInfo (до/после)
// Как tools/kino_video.mjs: программный рендер в облаке даёт < 1 кадра/с, поэтому часы страницы (performance.now
// и requestAnimationFrame) подменяются, игра шагает ровно на 1/fps с, каждый кадр снимается скриншотом и
// склеивается ffmpeg. «Отладка с клавиатуры» → бой без камеры → W до арены; дальше сценарий клавишами:
// J — очередь болтов (слабые), K — щит, пока энергии много (блок или удар сквозь щит), I — рассечение,
// 1 — огненное копьё, L — выброс (сильные), в конце — добивающий удар (HP Регента на «Лёгкой» подменяется
// в ответе config.js). Math.random страницы — с зерном: «до» и «после» идут одинаково.
// --root — папка игры (по умолчанию эта): тем же скриптом снимается чистый main (git worktree add … origin/main).

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const ROOT = resolve(argOf('--root', HERE));
const BUDGET = has('--budget');
const QUALITIES = argOf('--quality', BUDGET ? 'low,high' : 'high').split(',');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const FPS = +argOf('--fps', '30');
const SEC = +argOf('--sec', '15');
const LABEL = argOf('--label', 'after');
const OUT = resolve(argOf('--out', join(HERE, `docs/video/hits_${LABEL}.mp4`)));
const SHOTS = resolve(argOf('--shots', join(HERE, 'docs/screenshots/hits')));
const NO_VIDEO = has('--no-video') || BUDGET;
const BOSS_HP = argOf('--boss-hp', '0.34');
const FRAMES = join(argOf('--tmp', tmpdir()), `hit_frames_${process.pid}`);
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

// Виртуальные часы: до __hitVirtual(true) страница живёт как обычно, потом время идёт только по __hitStep(ms).
// Math.random — с зерном: «до» и «после» снимаются с одинаковым поведением Регента.
const CLOCK = () => {
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__hitVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__hitStep = (ms) => {
    vt += ms;
    const qq = q; q = [];
    for (const cb of qq) { try { cb(vt); } catch (e) { console.error(e); } }
    return qq.length;
  };
  window.__hitSeed = (seed) => {
    let a = seed >>> 0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
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

const report = [];
async function run(quality) {
  const frames = join(FRAMES, quality);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  let n = 0;
  const marks = [];
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0 });
  await ctx.addInitScript(CLOCK);
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text())
      .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5')
      .replace(/easy:\s*\{\s*bossHp:\s*0\.7/, 'easy: { bossHp: ' + BOSS_HP);
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
  // на программном рендере меню high долго компилирует шейдеры — клики ждут до 4 минут
  const T = { timeout: 240000 };
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click(T);
  await btn('Играть').click(T); await sleep(300);
  await btn('Продолжить без камеры').click(T); await sleep(500);
  await btn('В бой').click(T);
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
  // к Регенту — в реальном времени, дальше — по виртуальным часам
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 240000 }).catch(() => {});
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Tab');   // список жестов слева скрыт — в кадре сцена
  await page.evaluate(() => {
    window.__hitSeed(20261002); window.__hitVirtual(true);
    // счётчик событий слоя эффектов (блок, пролом, попадания) — для сценария и отчёта
    window.__hitEv = {};
    const L = window.__ASHEN__.fxLayer();
    if (L && typeof L.handle === 'function') { const o = L.handle; L.handle = (t, e, d) => { window.__hitEv[t] = (window.__hitEv[t] || 0) + 1; return o(t, e, d); }; }
  });
  const evCount = (t) => page.evaluate((k) => (window.__hitEv && window.__hitEv[k]) || 0, t);

  const info = () => page.evaluate(() => window.__ASHEN__.renderInfo());
  const peak = { calls: 0, triangles: 0, textures: 0, programs: 0, geometries: 0 };
  let idle = null;
  const step = async (save = !NO_VIDEO) => {
    await page.evaluate((ms) => window.__hitStep(ms), 1000 / FPS);
    if (BUDGET) {
      const r = await info();
      for (const k of Object.keys(peak)) if (r[k] > peak[k]) peak[k] = r[k];
    }
    if (save) { n++; await page.screenshot({ path: join(frames, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92, timeout: 240000 }); }
  };
  const steps = async (sec) => { for (let i = 0, m = Math.round(sec * FPS); i < m; i++) await step(); };
  const state = () => page.evaluate(() => {
    const s = window.__ASHEN__.snapshot();
    return { st: s.status, hp: s.boss.hp, maxHp: s.boss.maxHp, act: s.boss.action, php: s.player.hp, shielding: !!s.player.shielding };
  });
  const shot = async (name) => {
    const p = join(SHOTS, `${name}_${LABEL}_${quality}.jpg`);
    await page.screenshot({ path: p, type: 'jpeg', quality: 88, timeout: 240000 });
    marks.push({ name, frame: n });
  };
  const fxStats = () => page.evaluate(() => { try { const l = window.__ASHEN__.fxLayer(); return l ? l.stats() : null; } catch (e) { return null; } });

  for (let i = 0; i < 40; i++) await step(false);   // герой остановился, камера легла
  if (BUDGET) { idle = await info(); for (const k of Object.keys(peak)) peak[k] = 0; }
  await shot('0_idle');
  // 1. очередь болтов — слабые попадания
  await page.keyboard.down('KeyJ');
  for (let i = 0; i < Math.round(1.2 * FPS); i++) { await step(); if (i === Math.round(0.9 * FPS)) await shot('1_bolts'); }
  await page.keyboard.up('KeyJ');
  // 2. щит, пока энергии много: держим K, пока Регент не ударит (блок или удар сквозь щит), не дольше 4 с
  await page.keyboard.down('KeyK');
  let blockShot = false;
  const hit0 = (await evCount('block')) + (await evCount('player_hit'));
  for (let i = 0; i < Math.round(4 * FPS); i++) {
    await step();
    if (i % 2 === 0 && !blockShot && (await evCount('block')) + (await evCount('player_hit')) > hit0) {
      blockShot = true; await step(); await shot('2_block');
      for (let j = 0; j < 8; j++) await step();
      await shot('2_block_after');
      break;
    }
  }
  await page.keyboard.up('KeyK');
  await steps(0.4);
  // 3. рассечение
  await page.keyboard.press('KeyI');
  for (let i = 0; i < Math.round(0.9 * FPS); i++) { await step(); if (i === 7) await shot('3_slash'); }
  // 4. огненное копьё — сильный удар
  await page.keyboard.press('Digit1');
  for (let i = 0; i < Math.round(1.4 * FPS); i++) { await step(); if (i === 16) await shot('4_rune'); }
  await steps(0.5);   // энергия на выброс
  // 5. выброс обеими руками — сильный удар, волна по земле
  await page.keyboard.press('KeyL');
  for (let i = 0; i < Math.round(1.3 * FPS); i++) { await step(); if (i === 6) await shot('5_burst'); }
  await shot('6_trail');
  // 6. добивающий: огонь, копьё, выброс — пока Регент не падёт (не дольше 4 с)
  let s = await state();
  await page.keyboard.down('KeyJ');
  await page.keyboard.press('Digit1');
  let finShot = false;
  for (let i = 0; i < Math.round(4 * FPS) && s.st === 'playing'; i++) {
    await step(); if (i % 3 === 0) s = await state();
    if (i === Math.round(1.2 * FPS) && s.st === 'playing') await page.keyboard.press('KeyL');
    if (i === Math.round(2.4 * FPS) && s.st === 'playing') await page.keyboard.press('Digit1');
  }
  await page.keyboard.up('KeyJ');
  for (let i = 0; i < Math.round(1.4 * FPS); i++) { await step(); if (i === 3) { await shot('7_finisher'); finShot = true; } if (i === 14) await shot('7_finisher_b'); }
  void finShot;
  const fin = await state();
  const fx = await fxStats();
  const evs = await page.evaluate(() => window.__hitEv || {});
  console.error(`[hit_video] ${quality}: события`, JSON.stringify(evs));
  if (BUDGET) report.push({ quality, idle, peak, fx: fx && fx.sub ? fx.sub : null, kit: fx ? fx.kit : null, events: evs, errors: errors.slice(0, 5) });
  console.error(`[hit_video] ${quality}: итог`, JSON.stringify(fin), 'кадров', n, 'ошибки', JSON.stringify(errors.slice(0, 5)));
  await ctx.close();
  if (!NO_VIDEO && n > 0) {
    mkdirSync(dirname(OUT), { recursive: true });
    const out = QUALITIES.length > 1 ? OUT.replace(/\.mp4$/, `_${quality}.mp4`) : OUT;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.jpg'),
      '-t', String(SEC), '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
    console.log(JSON.stringify({ out, frames: n, sec: +(n / FPS).toFixed(1), shots: marks }));
  }
  rmSync(frames, { recursive: true, force: true });
}

try {
  for (const q of QUALITIES) await run(q);
} finally {
  await browser.close();
  server.kill();
  rmSync(FRAMES, { recursive: true, force: true });
}
if (BUDGET) {
  const outJson = argOf('--json', '');
  if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
}
