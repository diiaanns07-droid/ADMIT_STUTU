// [W4-BOSS] Кадры Регента со стенда dev/boss-stand.html: одинаковые ракурсы и сцены (время стенда — своё,
// шаг 1/60 с), поэтому снимки «до» и «после» совпадают кадр в кадр. Плюс замер Регента и всей сцены.
// node tools/boss_shots.mjs [--root DIR] [--out docs/screenshots/boss] [--prefix after] [--quality high]
//                           [--size 1280x720] [--set angles|states|all] [--json out.json]
// --root — корень игры (например, копия main для кадров «до»), стенд берётся из него же.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const OUT = resolve(argOf('--out', join(HERE, 'docs/screenshots/boss')));
const PREFIX = argOf('--prefix', 'after');
const QS = argOf('--quality', 'high').split(',');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const SET = argOf('--set', 'all');
const JSON_OUT = argOf('--json', null);
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

// ракурсы — в покое; сцены — в камере боя (и крупно — замах и вторая фаза)
const ANGLES = [['game', 'idle'], ['front', 'idle'], ['side', 'idle'], ['low', 'idle']];
const STATES = [['game', 'slam'], ['game', 'orb'], ['game', 'nova'], ['front', 'slam'], ['front', 'hit'], ['game', 'stage2'], ['front', 'stage2'], ['low', 'stage2slam']];
const LIST = SET === 'angles' ? ANGLES : SET === 'states' ? STATES : [...ANGLES, ...STATES];

const { chromium } = loadPlaywright();
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find((p) => existsSync(p));
let server = null;
for (let i = 0; i < 6 && !server; i++) { try { server = await startServer(); } catch (e) { if (i === 5) throw e; PORT = 20000 + Math.floor(Math.random() * 20000); } }
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
mkdirSync(OUT, { recursive: true });
const report = {};
try {
  for (const q of QS) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/dev/boss-stand.html?shot=1&q=${q}`);
    await page.waitForFunction(() => document.title === 'READY' || !!document.getElementById('err').textContent, null, { timeout: 600000 });
    const err = await page.evaluate(() => document.getElementById('err').textContent);
    if (err) throw new Error('стенд: ' + err);
    report[q] = {};
    for (const [cam, scn] of LIST) {
      const info = await page.evaluate(([c, s]) => { window.__boss.cam(c); return window.__boss.play(s); }, [cam, scn]);
      await sleep(50);
      const name = `${PREFIX}_${q}_${cam}_${scn}`;
      await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 90 });
      report[q][`${cam}/${scn}`] = info;
      console.error('[boss_shots]', name, JSON.stringify(info));
    }
    if (errors.length) console.error('[boss_shots] ошибки страницы', JSON.stringify(errors.slice(0, 5)));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (JSON_OUT) writeFileSync(resolve(JSON_OUT), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
