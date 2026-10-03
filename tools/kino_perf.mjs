// [W3-КИНО] Замер кадра и draw calls Регента в фазе 1 и фазе 2 (гроза, дымка) + кадры и видео сцен перехода и гибели.
// node tools/kino_perf.mjs [--root DIR] [--quality low,medium,high] [--sec 20] [--size 1280x720]
//                          [--shots DIR] [--label NAME]
// «Отладка с клавиатуры» → бой без камеры → W до арены. Чтобы быстро дойти до сцен, ответ config.js подменяется:
// HP Регента на «Лёгкой» 0,7 → 0,12 (120 HP). Выброс L (80) → фаза 2, руна 1 (огненное копьё, 70) → гибель.
// --root — папка игры (по умолчанию эта), так тем же скриптом меряется чистый main: git worktree add … origin/main.
// Качество фиксируется (qualityAuto: false): иначе perfTuner на SwiftShader сам ставит low и разрешение 0,6.
// В облаке рендер программный (SwiftShader): абсолютные мс велики, сравнивать — «до/после» на одной машине.
// Видео сцен — tools/kino_video.mjs (пошаговая запись кадров).

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const QUALITIES = argOf('--quality', 'low,medium,high').split(',');
const SEC = +argOf('--sec', '20');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const SHOTS = argOf('--shots', '');
const LABEL = argOf('--label', '');
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

const { chromium } = loadPlaywright();
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } }
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

// rAF-интервалы и draw calls за N секунд (calls — сумма проходов кадра: postfx копит renderer.info за кадр)
const measure = (page, sec) => page.evaluate((s) => new Promise((res) => {
  const ts = [], calls = [], tris = [];
  const t0 = performance.now();
  function tick(t) {
    ts.push(t);
    const r = window.__ASHEN__.renderInfo();
    calls.push(r.calls); tris.push(r.triangles);
    if (t - t0 < s * 1000) requestAnimationFrame(tick); else res({ ts, calls, tris });
  }
  requestAnimationFrame(tick);
}), sec);
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)] || 0; };
function summarize(r) {
  const dts = r.ts.slice(1).map((t, i) => t - r.ts[i]);
  const mean = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
  const p95 = dts.slice().sort((a, b) => a - b)[Math.floor(dts.length * 0.95)] || 0;
  return { frames: dts.length, meanMs: +mean.toFixed(1), medianMs: +med(dts).toFixed(1), p95Ms: +p95.toFixed(1), calls: med(r.calls), callsMax: Math.max(...r.calls), tris: med(r.tris) };
}
const snap = (page) => page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return s ? { status: s.status, hp: s.boss.hp, stage: s.boss.stage, energy: s.player.energy, enc: s.player.encounter, time: s.time } : null; });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${LABEL ? LABEL + '_' : ''}${name}.png`) }); };

const out = [];
try {
  for (const q of QUALITIES) {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true,
    });
    await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0 });
    await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
      const r = await route.fetch();
      const body = (await r.text())
        .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5')
        .replace(/easy:\s*\{\s*bossHp:\s*[\d.]+/, 'easy: { bossHp: 0.12');
      return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    const btn = (text) => page.locator('button:visible', { hasText: text }).first();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 120000 });
    await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 120000 }).catch(() => {});
    await sleep(1500);
    // на программном рендере меню high первые ~минуту подвисает на компиляции шейдеров — клики ждут дольше
    const CLICK = { timeout: 180000 };
    await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click(CLICK);
    await btn('Играть').click(CLICK); await sleep(300);
    await btn('Продолжить без камеры').click(CLICK); await sleep(500);
    await btn('В бой').click(CLICK);
    await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 180000 }).catch(() => {});
    await page.keyboard.up('KeyW');
    await sleep(2500);
    const row = { quality: q, root: ROOT === HERE ? 'branch' : ROOT };
    row.p1 = summarize(await measure(page, SEC));
    await shot(page, `${q}_phase1`);
    // выброс → фаза 2 (Регент переходит, когда освободится от атаки)
    for (let i = 0; i < 4; i++) {
      const s = await snap(page);
      if (!s || s.stage === 2 || s.hp <= 60) break;
      await page.keyboard.press('KeyL'); await sleep(1200);
    }
    await page.waitForFunction(() => window.__ASHEN__.snapshot().boss.stage === 2, null, { timeout: 30000 }).catch(() => {});
    await sleep(700); await shot(page, `${q}_phase2_roar`);
    await sleep(2600);   // сцена перехода 1,5 с + гроза набирает вес
    row.p2 = summarize(await measure(page, SEC));
    await shot(page, `${q}_phase2_storm`);
    row.kino = await page.evaluate(() => (window.__ASHEN__.kino ? window.__ASHEN__.kino() : null));
    // добить: руна 1 (огненное копьё), при откате — ещё выброс
    for (let i = 0; i < 6; i++) {
      const s = await snap(page);
      if (!s || s.status !== 'playing') break;
      await page.keyboard.press(i % 2 === 0 ? 'Digit1' : 'KeyL'); await sleep(900);
    }
    await page.waitForFunction(() => window.__ASHEN__.snapshot().status === 'victory', null, { timeout: 30000 }).catch(() => {});
    await sleep(350); await shot(page, `${q}_death_heat`);
    await sleep(700); await shot(page, `${q}_death_shards`);
    await sleep(1400); await shot(page, `${q}_death_orbit`);
    row.final = await snap(page);
    row.errors = errors.slice(0, 5);
    row.perf = await page.evaluate(() => { const p = window.__ASHEN__.perf(); const r = window.__ASHEN__.renderInfo(); return { auto: p ? p.auto : null, tier: p ? p.tier : null, pixelRatio: r.pixelRatio, shadowLights: r.shadowLights, programs: r.programs }; });
    out.push(row);
    console.error(`[kino_perf] ${q}: p1 ${row.p1.meanMs} мс / ${row.p1.calls} calls, p2 ${row.p2.meanMs} мс / ${row.p2.calls} calls, итог ${JSON.stringify(row.final)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify({ size: `${W}x${H}`, sec: SEC, results: out }, null, 1));
