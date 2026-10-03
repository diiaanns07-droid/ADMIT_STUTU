// [W4-ЗАКЛИНАНИЯ] Съёмка базовых заклинаний «Отладки с клавиатуры» для сравнения до/после и видео.
// node tools/spell_shots.mjs [--root DIR] [--quality medium|low|high] [--hero ashen] [--size 1280x720] [--fps 30]
//                            [--shots DIR] [--video FILE.mp4] [--keys J,L,O,X,G,1,2,3,4,5,6,7,8,9,0] [--json FILE]
//                            [--gap SEC] [--marks 0.05,0.15,0.3]
// Программный рендер в облаке даёт ~1 кадр/с, поэтому часы страницы (performance.now и requestAnimationFrame)
// подменяются: игра шагает ровно на 1/fps с, каждый кадр снимается — ролик идёт в настоящем игровом времени.
// Ракурсы и расписание клавиш детерминированы: снимки «до» (--root на копию main) и «после» совпадают по кадрам.
// Энергия и откаты подменены (ответ config.js), Регент не наносит урон — все заклинания успевают в 15 с.
// В JSON: renderInfo() в покое и на каждой отметке (вызовы отрисовки, треугольники, текстуры, программы), частицы V6.

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const Q = argOf('--quality', 'medium');
const HERO = argOf('--hero', 'ashen');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const FPS = +argOf('--fps', '30');
const SHOTS = argOf('--shots', '') ? resolve(argOf('--shots')) : '';
const VIDEO = argOf('--video', '') ? resolve(argOf('--video')) : '';
const JSON_OUT = argOf('--json', '') ? resolve(argOf('--json')) : '';
const KEYS = argOf('--keys', 'J,L,O,X,G,1,2,3,4,5,6,7,8,9,0').split(',').filter(Boolean);
const FRAMES = join(argOf('--tmp', tmpdir()), `spell_frames_${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Расписание: клавиша → [удержание, пауза после отпускания] в секундах и отметки снимков (с от момента каста:
// нажатия для коротких клавиш, отпускания — для удерживаемых). 15 заклинаний ≈ 15 с.
const PLAN = {
  J: { code: 'KeyJ', hold: 0.5, gap: 0.45, castAt: 'down', marks: [0.12, 0.3, 0.55] },
  L: { code: 'KeyL', hold: 0.07, gap: 0.85, castAt: 'down', marks: [0.12, 0.3, 0.6] },
  O: { code: 'KeyO', hold: 1.0, gap: 0.8, castAt: 'up', marks: [-0.3, 0.12, 0.35] },
  X: { code: 'KeyX', hold: 0.8, gap: 0.8, castAt: 'up', marks: [-0.3, 0.12, 0.4] },
  G: { code: 'KeyG', hold: 0.8, gap: 0.9, castAt: 'up', marks: [-0.3, 0.15, 0.55] },
};
for (let i = 1; i <= 10; i++) { const d = String(i % 10); PLAN[d] = { code: 'Digit' + d, hold: 0.07, gap: 0.78, castAt: 'down', marks: [0.1, 0.3, 0.6] }; }
// --gap SEC — пауза после каждого заклинания (разбор по одному), --marks a,b,c — свои отметки снимков (с от каста)
const GAP = argOf('--gap', '') ? +argOf('--gap') : null;
const MARKS = argOf('--marks', '') ? argOf('--marks').split(',').map(Number).filter(Number.isFinite) : null;
for (const k of Object.keys(PLAN)) { if (GAP !== null) PLAN[k].gap = GAP; if (MARKS) PLAN[k].marks = MARKS; }

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

// Виртуальные часы (как tools/kino_video.mjs): до __spVirtual(true) страница живёт как обычно, потом — только __spStep(ms).
const CLOCK = () => {
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__spVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__spStep = (ms) => {
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
if (VIDEO) mkdirSync(dirname(VIDEO), { recursive: true });

let n = 0;
const report = { root: ROOT, quality: Q, hero: HERO, size: `${W}x${H}`, idle: null, marks: [], peak: null, errors: [] };
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } },
    { quality: Q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0, hero: HERO });
  await ctx.addInitScript(CLOCK);
  // энергия и откаты — для съёмки (каждое заклинание без ожидания), Регент без урона и не умирает за ролик
  const RUNES_FAST = ['ignis', 'fulgur', 'orbis', 'stella', 'spira', 'lemnis', 'caret', 'vee', 'clepsydra', 'alpha'].map((r) => `${r}: { cooldown: 0.4, energy: 0 }`).join(', ');
  const COMBAT = `combat: { player: { energyRegen: 500, energyRegenDelay: 0 }, burst: { cooldown: 0.4, cost: 0 }, throw: { cooldown: 0.3 },
    runes: { ${RUNES_FAST} }, sigils: { gate: { cooldown: 0.4, energy: 0 }, pillar: { cooldown: 0.4, energy: 0 }, castTime: 0.3 },`;
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text())
      .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5')
      .replace(/combat:\s*\{/, COMBAT)
      .replace(/easy:\s*\{\s*bossHp:\s*0\.7,\s*bossDamage:\s*0\.7\s*\}/, 'easy: { bossHp: 4, bossDamage: 0 }');
    return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(300000);   // программный рендер под нагрузкой: кадр и снимок могут идти десятки секунд
  page.on('pageerror', (e) => report.errors.push(String(e && e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') report.errors.push(('[console] ' + m.text()).slice(0, 300)); });
  const btn = (text) => page.locator('button:visible', { hasText: text }).first();
  await page.goto(`http://127.0.0.1:${PORT}/?uncapped=1`, { timeout: 240000 });
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => {});
  await sleep(1500);
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
  await btn('Играть').click(); await sleep(300);
  await btn('Продолжить без камеры').click(); await sleep(500);
  await btn('В бой').click();
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 400000 });
  const step = async () => {
    await page.evaluate((ms) => window.__spStep(ms), 1000 / FPS);
    n++;
    if (VIDEO) await page.screenshot({ path: join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
  };
  const info = () => page.evaluate(() => {
    const r = window.__ASHEN__.renderInfo();
    const f = window.__ASHEN__.fx();
    return { calls: r.calls, triangles: r.triangles, textures: r.textures, geometries: r.geometries, programs: r.programs,
      particles: f && f.v6 ? f.v6.kit.particles : null, lights: f && f.v6 ? f.v6.kit.lights : null };
  });
  const shot = async (name) => {
    const rec = { name, frame: n, ...(await info()) };
    if (SHOTS) {
      const p = join(SHOTS, `${name}.jpg`);
      if (VIDEO && existsSync(join(FRAMES, `${String(n).padStart(5, '0')}.jpg`))) copyFileSync(join(FRAMES, `${String(n).padStart(5, '0')}.jpg`), p);
      else await page.screenshot({ path: p, type: 'jpeg', quality: 90 });
    }
    report.marks.push(rec);
  };
  // к Регенту — в реальном времени (быстрее), съёмка — уже в арене, по виртуальным часам
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 300000 }).catch(() => report.errors.push('engage timeout'));
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Tab');   // список жестов слева скрыт — в кадре сцена
  await page.evaluate(() => window.__spVirtual(true));
  // герой остановился, камера легла (без записи кадров)
  for (let i = 0; i < 45; i++) { await page.evaluate((ms) => window.__spStep(ms), 1000 / FPS); }
  for (let i = 0; i < 6; i++) await page.evaluate((ms) => window.__spStep(ms), 1000 / FPS);
  report.idle = await info();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '00_idle.jpg'), type: 'jpeg', quality: 90 });
  for (let i = 0; i < Math.round(0.3 * FPS); i++) await step();
  const F = (sec) => Math.max(0, Math.round(sec * FPS));
  for (const k of KEYS) {
    const p = PLAN[k];
    if (!p) continue;
    const holdF = Math.max(1, F(p.hold)), gapF = F(p.gap);
    const castF = p.castAt === 'up' ? holdF : 0;
    const marks = new Map(p.marks.map((m, i) => [castF + F(m), `${k === '0' ? '9z' : k}_${i + 1}`]));
    const total = holdF + gapF;
    await page.keyboard.down(p.code);
    for (let f = 0; f < total; f++) {
      if (f === holdF) await page.keyboard.up(p.code);
      await step();
      const name = marks.get(f + 1);
      if (name) await shot(name);
    }
  }
  for (let i = 0; i < F(0.4); i++) await step();
  const sn = await page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return s ? { status: s.status, bossHp: s.boss.hp, hp: s.player.hp } : null; });
  report.end = sn;
  report.frames = n;
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
const peak = { calls: 0, triangles: 0, textures: 0, programs: 0, particles: 0 };
for (const m of report.marks) for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], m[k] || 0);
report.peak = peak;
if (VIDEO) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FRAMES, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO]);
  report.video = VIDEO;
}
rmSync(FRAMES, { recursive: true, force: true });
if (JSON_OUT) { mkdirSync(dirname(JSON_OUT), { recursive: true }); writeFileSync(JSON_OUT, JSON.stringify(report, null, 1)); }
console.log(JSON.stringify({ idle: report.idle, peak: report.peak, frames: report.frames, end: report.end, errors: report.errors.slice(0, 8) }, null, 1));
