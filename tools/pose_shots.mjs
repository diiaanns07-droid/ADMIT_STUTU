// ASHEN OATH — [W4-ПОЗЫ] снимки и видео поз героев (Playwright + Chromium, виртуальное время 1/30 с на кадр).
//   node tools/pose_shots.mjs --stand [--heroes elf,dark] [--poses idle,shield,…] [--q high] [--cam full] [--out dir]
//        стенд dev/pose-stand.html: герой перед камерой, каст-позы по сценарию — PNG на каждый (герой, поза, миг)
//   node tools/pose_shots.mjs --menu [--heroes …] [--q high] [--frames 120]   витрина меню игры: PNG на героя
//   node tools/pose_shots.mjs --battle [--q high]                                бой в «Отладке с клавиатуры»: PNG на позу
//   node tools/pose_shots.mjs --video docs/video/poses.mp4 [--q high]            витрина всех героев + каст-позы в бою
//   node tools/pose_shots.mjs --perf [--heroes …] [--q low,high]                 CPU update героя (мс, настоящие часы) и renderInfo
// Math.random на странице — с фиксированным зерном: снимки ДО и ПОСЛЕ — в одинаковых ракурсах и мигах.
import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, 'dev/shots/poses')));
const HEROES = argOf('--heroes', 'ashen,elf,dark,ranger,archmage').split(',');
const QS = argOf('--q', 'high').split(',');
const TAG = argOf('--tag', '');
const FPS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (e) { /* ignore */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* дальше */ } }
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
// виртуальные часы (как tools/kino_video.mjs) + зерно Math.random + настоящие часы для замеров
const CLOCK = () => {
  const oRAF = window.requestAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  window.__realNow = oNow;
  let seed = 1234567;
  Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let virt = false, vt = 0, q = [];
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { q.push(cb); return q.length; } return oRAF(cb); };
  window.__kinoVirtual = (on) => {
    if (on && !virt) { vt = oNow(); virt = true; } else if (!on && virt) { virt = false; const qq = q; q = []; for (const cb of qq) oRAF(cb); }
  };
  window.__kinoStep = (ms) => { vt += ms; const qq = q; q = []; for (const cb of qq) { try { cb(vt); } catch (e) { console.error(e); } } return qq.length; };
  window.__kinoPending = () => q.length;
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
const base = `http://127.0.0.1:${PORT}`;
const report = {};
const log = (...a) => console.log('[poses]', ...a);

// ---------------------------------------------------------------- стенд поз
// поза → мгновения снимков (с начала сценария), с
const STAND_POSES = {
  idle: [4.0], shield: [0.5, 1.75], bolt: [0.2, 0.52], burst: [0.24, 0.5], conjure: [1.2, 2.2], gate: [1.0, 1.9], pillar: [1.0, 1.95],
  ultimate: [1.2, 2.55], hit: [0.4, 1.9], victory: [0.9, 3.5], defeat: [1.2, 3.0], menu: [2.5, 6.0], menuG: [1.0], walk: [1.0], orb: [1.0, 1.75], smile: [0.6],
};
async function standPage(hero, q, cam = 'full', size = { width: 960, height: 540 }) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  await ctx.addInitScript(CLOCK);
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => log('pageerror', hero, e && e.message));
  await page.goto(`${base}/dev/pose-stand.html?hero=${hero}&q=${q}&cam=${cam}${argOf('--query', '')}`);
  await page.waitForFunction(() => window.__PS__ && window.__PS__.ready, null, { timeout: 180000 });
  return { ctx, page };
}
async function runStand() {
  const poses = argOf('--poses', Object.keys(STAND_POSES).join(',')).split(',');
  const cam = argOf('--cam', 'full');
  for (const q of QS) for (const hero of HEROES) {
    const { ctx, page } = await standPage(hero, q, cam);
    for (const pose of poses) {
      const times = STAND_POSES[pose] || [1];
      await page.evaluate((p) => { if (p === 'menu' || p === 'menuG') window.__PS__.menu(); else window.__PS__.play(p); }, pose);
      if (pose === 'menuG') await page.evaluate(() => { window.__PS__.step(1 / 30, 45); window.__PS__.flourish(); });   // жест визитки
      let t = 0;
      for (const at of times) {
        const n = Math.max(0, Math.round((at - t) * FPS));
        await page.evaluate((n) => window.__PS__.step(1 / 30, n), n);
        t += n / FPS;
        await page.evaluate((s) => window.__PS__.label(s), `${hero} · ${pose} · ${at.toFixed(2)} с`);
        await page.evaluate(() => window.__PS__.render());
        const f = join(OUT, `${TAG}stand_${hero}_${pose}_${String(Math.round(at * 100)).padStart(3, '0')}.png`);
        await page.screenshot({ path: f });
      }
      log('stand', q, hero, pose);
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------- игра: меню и бой
async function gamePage(q, extra = {}, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); localStorage.setItem('ashen-oath.showcase-hint', '1'); } catch (e) { /* ignore */ } }, { quality: q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0, ...extra });
  await ctx.addInitScript(CLOCK);
  await ctx.route(/\/config\.js(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const body = (await r.text()).replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
    return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => log('pageerror', e && e.message));
  await page.goto(`${base}/?uncapped=1${query}${argOf('--query', '')}`);
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => {});
  return { ctx, page };
}
// шаг — только когда кадр игры ждёт в очереди: сразу после включения виртуальных часов кадр ещё «в полёте»
// по настоящему rAF (на программном рендере — секунды), и шаги вхолостую сдвинули бы время без кадра
async function vstep(page, n = 1) {
  for (let i = 0; i < n;) {
    const done = await page.evaluate((n) => { let k = 0; while (k < n && window.__kinoPending() > 0) { window.__kinoStep(1000 / 30); k++; } return k; }, n - i);
    i += done;
    if (i < n) await page.waitForFunction(() => window.__kinoPending() > 0, null, { timeout: 240000, polling: 50 });
  }
}
async function pickHero(page, id) {
  await page.evaluate((id) => { const el = document.querySelector(`input.ao-herocard__input[value="${id}"]`); if (el && !el.checked) el.click(); }, id);
  await page.waitForFunction((id) => { const h = window.__ASHEN__.hero(); return h && h.ready && h.hero === id; }, id, { timeout: 180000 });
  // шейдеры нового героя компилируются параллельно (на программном рендере — десятки секунд): пока число
  // программ не устоится, кадр может выйти чёрным — ждём по настоящим часам, понемногу рисуя кадры
  let last = -1, same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    await page.evaluate(() => { if (window.__kinoStep) window.__kinoStep(1000 / 30); });
    await sleep(1500);
    const n = await page.evaluate(() => window.__ASHEN__.programs().length);
    same = n === last ? same + 1 : 0; last = n;
  }
}
async function runMenu() {
  const frames = Number(argOf('--frames', '150'));
  for (const q of QS) {
    const { ctx, page } = await gamePage(q, { hero: HEROES[0] });
    for (const hero of HEROES) {
      await page.evaluate(() => window.__kinoVirtual(false));
      await pickHero(page, hero);
      await page.evaluate(() => window.__kinoVirtual(true));
      await vstep(page, frames);
      await page.screenshot({ path: join(OUT, `${TAG}menu_${hero}.png`) });
      log('menu', q, hero, has('--dump') ? JSON.stringify(await page.evaluate(() => { const h = window.__ASHEN__.hero(); return { act: h.act, hold: h.hold, lod: h.lod, pose: h.pose, poses: h.poses, face: h.face, sc: window.__ASHEN__.heroShowcase() }; })) : '');
    }
    await ctx.close();
  }
}
async function toBattle(page) {
  const btn = (text) => page.locator('button:visible', { hasText: text }).first();
  await sleep(1200);
  await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click();
  await btn('Играть').click(); await sleep(300);
  await btn('Продолжить без камеры').click(); await sleep(500);
  await btn('В бой').click();
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing' || window.__ASHEN__.screen === 'intro', null, { timeout: 240000 });
  await sleep(800);
  if (await page.evaluate(() => window.__ASHEN__.screen === 'intro')) await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 240000 });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__ASHEN__.snapshot().player.encounter === 'engaged', null, { timeout: 240000 }).catch(() => {});
  await page.keyboard.up('KeyW');
  await page.keyboard.press('Tab');
  await page.evaluate(() => window.__kinoVirtual(true));
}
// сценарий боя: [клавиша, действие 'down'|'up'|'tap', кадров после] и снимки [имя]
const BATTLE = [
  ['wait', 40], ['shot', 'b_idle'],
  ['down', 'KeyK', 14], ['shot', 'b_shield'], ['up', 'KeyK', 20],
  ['down', 'KeyJ', 10], ['shot', 'b_bolt'], ['up', 'KeyJ', 24],
  ['tap', 'KeyL', 7], ['shot', 'b_burst'], ['wait', 30],
  ['down', 'KeyO', 40], ['shot', 'b_conjure'], ['up', 'KeyO', 30],
  ['down', 'KeyX', 40], ['shot', 'b_gate_charge'], ['up', 'KeyX', 10], ['shot', 'b_gate'], ['wait', 40],
  ['down', 'KeyG', 40], ['up', 'KeyG', 10], ['shot', 'b_pillar'], ['wait', 40],
  ['tap', 'KeyU', 30], ['shot', 'b_ultimate'], ['wait', 100],
];
// видео: короче (≈ 9 с) — печати первыми (энергия), «Небесный суд» в конце (облёт камеры спереди)
const VIDEO_BATTLE = [
  ['down', 'KeyX', 30], ['up', 'KeyX', 26],
  ['down', 'KeyG', 30], ['up', 'KeyG', 26],
  ['down', 'KeyK', 24], ['up', 'KeyK', 6],
  ['down', 'KeyJ', 20], ['up', 'KeyJ', 8],
  ['tap', 'KeyL', 26],
  ['down', 'KeyO', 30], ['up', 'KeyO', 16],
  ['tap', 'KeyU', 70],
];
async function runBattle(page, onFrame = null, shots = true, list = BATTLE) {
  for (const s of list) {
    if (s[0] === 'shot') { if (shots) await page.screenshot({ path: join(OUT, `${TAG}${s[1]}.png`) }); continue; }
    if (s[0] === 'down') await page.keyboard.down(s[1]);
    else if (s[0] === 'up') await page.keyboard.up(s[1]);
    else if (s[0] === 'tap') { await page.keyboard.down(s[1]); await vstep(page, 1); if (onFrame) await onFrame(); await page.keyboard.up(s[1]); }
    const n = s[0] === 'wait' ? s[1] : s[2];
    for (let i = 0; i < n; i++) { await vstep(page, 1); if (onFrame) await onFrame(); }
  }
}

// ---------------------------------------------------------------- видео: витрина всех героев + каст-позы в бою
async function runVideo(outFile) {
  const FR = join(argOf('--tmp', tmpdir()), `pose_frames_${process.pid}`);
  rmSync(FR, { recursive: true, force: true }); mkdirSync(FR, { recursive: true });
  let n = 0;
  const q = QS[0];
  const { ctx, page } = await gamePage(q, { hero: HEROES[0] }, '&fury=100');
  const grab = async () => { n++; await page.screenshot({ path: join(FR, `${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 }); };
  const perHero = Number(argOf('--hero-frames', '36'));
  for (const hero of HEROES) {
    await page.evaluate(() => window.__kinoVirtual(false));
    await pickHero(page, hero);
    await page.evaluate(() => window.__kinoVirtual(true));
    await vstep(page, 20);
    for (let i = 0; i < perHero; i++) { await vstep(page, 1); await grab(); }
    log('video menu', hero, n);
  }
  await page.evaluate(() => window.__kinoVirtual(false));
  await pickHero(page, argOf('--battle-hero', 'dark'));
  await toBattle(page);
  for (let i = 0; i < 20; i++) await vstep(page, 1);
  await runBattle(page, grab, false, VIDEO_BATTLE);
  log('video battle', n);
  await ctx.close();
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FR, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile]);
  log('video', outFile, n, 'кадров');
}

// ---------------------------------------------------------------- бюджет
async function runPerf() {
  for (const q of QS) {
    report[q] = {};
    for (const hero of HEROES) {
      const { ctx, page } = await standPage(hero, q);
      const r = await page.evaluate(() => {
        const S = window.__PS__;
        S.step(1 / 30, 30);
        const out = { idle: S.perf(240, 'idle') };
        for (const p of ['shield', 'conjure', 'gate', 'ultimate', 'victory']) out[p] = S.perf(120, p);
        out.menu = (S.menu(), S.perf(240));
        S.render();
        out.render = S.info();
        out.poses = S.state().poses || null;
        return out;
      });
      report[q][hero] = r;
      log('perf', q, hero, JSON.stringify(r));
      await ctx.close();
    }
    if (has('--no-game')) continue;
    // игра: renderInfo в меню и в бою (весь кадр)
    const { ctx, page } = await gamePage(q, { hero: 'dark' });
    await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return h && h.ready; }, null, { timeout: 180000 });
    await page.evaluate(() => window.__kinoVirtual(true));
    await vstep(page, 30);
    report[q].gameMenu = await page.evaluate(() => window.__ASHEN__.renderInfo());
    await page.evaluate(() => window.__kinoVirtual(false));
    await toBattle(page);
    await vstep(page, 30);
    report[q].gameBattle = await page.evaluate(() => window.__ASHEN__.renderInfo());
    log('perf game', q, JSON.stringify(report[q].gameMenu), JSON.stringify(report[q].gameBattle));
    await ctx.close();
  }
  writeFileSync(join(OUT, `${TAG}perf.json`), JSON.stringify(report, null, 1));
}

try {
  if (has('--stand')) await runStand();
  if (has('--menu')) await runMenu();
  if (has('--battle')) {
    const { ctx, page } = await gamePage(QS[0], { hero: argOf('--battle-hero', 'dark') }, '&fury=100');
    await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return h && h.ready; }, null, { timeout: 180000 });
    await toBattle(page);
    await runBattle(page);
    await ctx.close();
  }
  if (has('--video')) await runVideo(resolve(argOf('--video', join(ROOT, 'docs/video/poses.mp4'))));
  if (has('--perf')) await runPerf();
} finally {
  await browser.close();
  server.kill();
}
