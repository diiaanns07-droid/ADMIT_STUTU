// [W4-ARENA] Снимки и замеры арены Регента: три ракурса на стенде dev/arena_stand.html (настоящий world.js + postfx),
// замер renderer.info (вызовы отрисовки, треугольники, текстуры, программы), облёт-видео и замер в самой игре
// через window.__ASHEN__.renderInfo().
//   node tools/arena_shots.mjs [--root DIR] [--quality low,high] [--tag after] [--out docs/screenshots/arena]
//                              [--size 1280x720] [--video docs/video/arena.mp4 --sec 12] [--game] [--frames 45]
// --root — чья копия кода снимается (для «до»: git worktree с main; стенд копируется туда, если его нет).
// Программный рендер в облаке даёт ~1 кадр/с, поэтому время виртуальное: стенд шагает ровно на 1/30 с,
// в игре подменяются performance.now и requestAnimationFrame (как в tools/kino_video.mjs).
import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const QS = argOf('--quality', 'low,high').split(',');
const TAG = argOf('--tag', 'after');
const OUT = resolve(argOf('--out', join(HERE, 'docs/screenshots/arena')));
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const VIDEO = argOf('--video', '');
const VSEC = +argOf('--sec', '12');
const FRAMES = +argOf('--frames', '45');
const GAME = argv.includes('--game');
const STAND_ON = !argv.includes('--no-stand');   // --no-stand — только замер в игре
const VIEWS = argOf('--views', 'hero,top,wet').split(',');
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
// Виртуальные часы для игры: после __kinoVirtual(true) время идёт только по __kinoStep(ms).
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

// стенд — в снимаемую копию, если там его нет (у main до этой ветки стенда не было)
const STAND = join(ROOT, 'dev/arena_stand.html');
let copiedStand = false;
if (!existsSync(STAND)) { copyFileSync(join(HERE, 'dev/arena_stand.html'), STAND); copiedStand = true; }

const { chromium } = loadPlaywright();
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } }
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
mkdirSync(OUT, { recursive: true });
const report = { tag: TAG, root: ROOT, size: `${W}x${H}`, stand: {}, game: {} };
try {
  for (const q of STAND_ON ? QS : []) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.setDefaultTimeout(300000);
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/dev/arena_stand.html?q=${q}&manual=1&clean=1&w=${W}&h=${H}`);
    await page.waitForFunction(() => !!window.__ARENA__, null, { timeout: 180000 });
    await page.waitForFunction(() => window.__ARENA__.ready(), null, { timeout: 120000 }).catch(() => {});
    const rq = { buildMs: await page.evaluate(() => Math.round(window.__ARENA__.buildMs)), views: {} };
    // прогрев: шейдеры всех ракурсов, затем ровно FRAMES кадров по 1/30 с на ракурс
    for (const v of VIEWS) { await page.evaluate((v) => { window.__ARENA__.view(v); return window.__ARENA__.step(2); }, v); }
    for (const v of VIEWS) {
      const r = await page.evaluate(({ v, n }) => { const A = window.__ARENA__; A.view(v); const i = A.step(n); return { ...i, ...A.census() }; }, { v, n: FRAMES });
      await page.screenshot({ path: join(OUT, `${TAG}_${q}_${v}.png`), timeout: 300000 });
      rq.views[v] = r;
      console.error(`[arena] ${TAG} ${q} ${v}`, JSON.stringify(r));
    }
    // руны: вспышка от заклинания — кадр через 0,5 с
    await page.evaluate(() => { const A = window.__ARENA__; A.view('hero'); A.emit('rune_cast', { rune: 'ignis' }, { x: 2, y: 1, z: 7 }); A.emit('sigil_cast', { sigil: 'gate', power: 1 }, { x: -2, y: 1, z: 7 }); return A.step(15); });
    await page.screenshot({ path: join(OUT, `${TAG}_${q}_runes.png`), timeout: 300000 });
    rq.errors = errors.slice(0, 8);
    report.stand[q] = rq;
    if (VIDEO && q === QS[QS.length - 1]) {
      const FR = join(tmpdir(), `arena_frames_${process.pid}`);
      rmSync(FR, { recursive: true, force: true }); mkdirSync(FR, { recursive: true });
      const N = Math.round(VSEC * 30);
      for (let i = 0; i < N; i++) {
        const t = i / 30;
        await page.evaluate(({ t, i, N }) => {
          const A = window.__ARENA__;
          // облёт: от «входа в бой» по дуге вокруг Регента, спуск к мокрому полу и подъём к затмению
          const u = i / Math.max(1, N - 1);
          const a = 0.35 - u * 2.1, r = 13.5 - 4.5 * Math.sin(u * Math.PI), y = 2.4 + 1.6 * Math.cos(u * Math.PI * 2) - 0.9 * Math.sin(u * Math.PI);
          A.view([Math.sin(a) * r, Math.max(0.9, y), Math.cos(a) * r, -Math.sin(a) * 2, 2.6 + 1.2 * u, -Math.cos(a) * 2]);
          if (i === 40) A.emit('rune_cast', { rune: 'ignis' }, { x: Math.sin(a) * 6, y: 1, z: Math.cos(a) * 6 });
          if (i === 150) A.emit('sigil_cast', { sigil: 'gate', power: 1 }, { x: Math.sin(a) * 6, y: 1, z: Math.cos(a) * 6 });
          if (i === 260) A.emit('rune_cast', { rune: 'fulgur' }, { x: Math.sin(a) * 6, y: 1, z: Math.cos(a) * 6 });
          return A.step(1);
        }, { t, i, N });
        await page.screenshot({ path: join(FR, `${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92, timeout: 300000 });
      }
      mkdirSync(dirname(resolve(VIDEO)), { recursive: true });
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(FR, '%05d.jpg'),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(VIDEO)]);
      rmSync(FR, { recursive: true, force: true });
      report.video = { out: resolve(VIDEO), sec: VSEC };
    }
    await ctx.close();
  }
  if (GAME) {
    // замер в игре: «Отладка с клавиатуры», бег к Регенту (реальное время), затем виртуальные кадры у арены
    for (const q of QS) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0 });
      await ctx.addInitScript(CLOCK);
      await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
        const r = await route.fetch();
        const body = (await r.text()).replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
        return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(300000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message)));
      const btn = (text) => page.locator('button:visible', { hasText: text }).first();
      await page.goto(`http://127.0.0.1:${PORT}/?uncapped=1`);
      await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
      await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 120000 }).catch(() => {});
      await sleep(1500);
      const menu = await page.evaluate(() => window.__ASHEN__.renderInfo());
      await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
      await btn('Играть').click(); await sleep(300);
      await btn('Продолжить без камеры').click(); await sleep(500);
      await btn('В бой').click();
      await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
      await page.keyboard.down('KeyW');
      await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 300000 }).catch(() => {});
      await page.keyboard.up('KeyW');
      await page.keyboard.press('Tab');
      await page.evaluate(() => window.__kinoVirtual(true));
      for (let i = 0; i < 60; i++) await page.evaluate(() => window.__kinoStep(1000 / 30));
      const samples = [];
      for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__kinoStep(1000 / 30)); samples.push(await page.evaluate(() => window.__ASHEN__.renderInfo())); }
      await page.screenshot({ path: join(OUT, `${TAG}_${q}_game.png`), timeout: 300000 });
      const med = (k) => { const v = samples.map((s) => s[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
      report.game[q] = { menu, fight: { calls: med('calls'), triangles: med('triangles'), textures: med('textures'), geometries: med('geometries'), programs: samples[samples.length - 1].programs, shadowLights: samples[0].shadowLights }, errors: errors.slice(0, 5) };
      console.error(`[arena] game ${TAG} ${q}`, JSON.stringify(report.game[q]));
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
  if (copiedStand) rmSync(STAND, { force: true });
}
writeFileSync(join(OUT, `${TAG}_${STAND_ON ? 'report' : 'game'}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
