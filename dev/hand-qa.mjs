// [HAND] Браузерная проверка лука и магии рукой в DEBUG-бою (без камеры): меню → «Отладка с клавиатуры» →
// бой против Регента → B (стойка), удержание N (натяжение), отпускание (выстрел); M — сгусток, отпускание — бросок.
// node dev/hand-qa.mjs [--out DIR] [--port 8796] [--keep]
// Нужен глобальный playwright (npm root -g) и Chromium (/opt/pw-browsers). Скриншоты — в --out.

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, '..', 'hand_qa')));
const PORT = +argOf('--port', 8796);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gRoot = execSync('npm root -g').toString().trim();
const { chromium } = await import(pathToFileURL(join(gRoot, 'playwright', 'index.mjs')).href);
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => existsSync(p));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await sleep(700);
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: +argOf('--w', 800), height: +argOf('--h', 450) } });
  // CDN в песочнице может быть закрыт: подменяем jsdelivr пакетами из npm (--cdn DIR: three-0.185.1/package, pixiv-three-vrm-3.5.5/package)
  const CDN = argOf('--cdn', null);
  if (CDN) {
    const { readFileSync } = await import('node:fs');
    await page.route('https://cdn.jsdelivr.net/npm/**', (route) => {
      const u = new URL(route.request().url());
      let m = u.pathname.match(/^\/npm\/three@[^/]+\/(.*)$/), file = null;
      if (m) file = join(CDN, 'three-0.185.1', 'package', m[1]);
      m = u.pathname.match(/^\/npm\/@pixiv\/three-vrm@[^/]+\/(.*)$/);
      if (m) file = join(CDN, 'pixiv-three-vrm-3.5.5', 'package', m[1]);
      if (!file || !existsSync(file)) return route.abort();
      route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(file) });
    });
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const netErrors = [];
  page.on('console', (m) => { if (m.type() !== 'error') return; const t = m.text(); if (/^Failed to load resource/.test(t)) netErrors.push(t); else errors.push('console: ' + t); });
  const HERO = argOf('--hero', null);   // --hero ranger|elf|… — проверка с героем-лучником (свой лук HERO в руке)
  await page.addInitScript((hero) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', reducedMotion: true, ...(hero ? { hero } : {}) })); } catch (e) { /* ignore */ } }, HERO);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ASHEN__ && window.__ASHEN__.screen === 'menu', null, { timeout: 60000 });
  const click = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === l); if (!b) return 'missing'; b.click(); return 'ok'; }, label);
  const snap = () => page.evaluate(() => window.__ASHEN__.snapshot());
  // крупный план героя (нижняя середина кадра) — посмотреть лук и сгусток в руке
  const vp = page.viewportSize();
  const heroShot = (name) => page.screenshot({ path: join(OUT, name), clip: { x: Math.round(vp.width * 0.28), y: Math.round(vp.height * 0.38), width: Math.round(vp.width * 0.44), height: Math.round(vp.height * 0.62) } });
  // ждать условия по снимку боя (программный рендер медленный: время идёт кадрами, а не секундами)
  const until = async (fn, ms, what) => {
    const t0 = Date.now();
    for (;;) {
      const v = await page.evaluate(fn);
      if (v) return v;
      if (Date.now() - t0 > ms) { console.log('  таймаут:', what); return null; }
      await sleep(250);
    }
  };
  check('меню', true);
  // программный рендер даёт 2–4 кадра/с: каждый кадр длиннее loop.stallSec (0,25 с) считался бы разрывом и время
  // боя стояло бы. Для теста поднимаем порог через тот же модуль config.js (объект общий с main.js).
  await page.evaluate(() => import('./config.js').then((m) => { m.config.loop.stallSec = 30; }));
  console.log('  клики:', await click('Отладка с клавиатуры'), await click('Играть'));
  await sleep(300);
  console.log('  клики:', await click('Продолжить без камеры (демо)'));
  await sleep(500);
  if (argv.includes('--tutorial')) await page.screenshot({ path: join(OUT, 'hand_tutorial.png'), fullPage: true });
  console.log('  клики:', await click('В бой'));
  await until(() => window.__ASHEN__.screen === 'playing', 400000, 'бой');
  check('бой (DEBUG)', (await page.evaluate(() => window.__ASHEN__.screen)) === 'playing', `fps ${await page.evaluate(() => window.__ASHEN__.fps)}`);
  console.log('  ошибки консоли после входа в бой:', errors.length ? errors.slice(0, 3).join(' | ') : 'нет');
  // --walk: подойти к арене (держать W до lock-on); без него — стреляем с места старта (Регент в ~26 м, аим-ассист)
  if (argv.includes('--walk')) {
    await page.keyboard.down('KeyW');
    await until(() => { const s = window.__ASHEN__.snapshot(); return s.player.lockedOn || Math.hypot(s.player.position.x - s.boss.position.x, s.player.position.z - s.boss.position.z) < 12; }, 300000, 'арена');
    await page.keyboard.up('KeyW');
  }
  const s0 = await snap();
  const hp0 = s0.boss.hp;
  console.log('  до Регента:', Math.hypot(s0.player.position.x - s0.boss.position.x, s0.player.position.z - s0.boss.position.z).toFixed(1), 'м, lockedOn', s0.player.lockedOn);
  // лук: B — стойка, удерживать N (натяжение по реальному времени), отпустить
  await page.keyboard.press('KeyB');
  await page.keyboard.down('KeyN');
  const mid = await until(() => { const s = window.__ASHEN__.snapshot(); return s.player.bow && s.player.bow.active && s.player.bow.draw > 0.5 ? s.player.bow : null; }, 60000, 'натяжение');
  check('натяжение: snap.player.bow.active и draw растёт', !!mid, JSON.stringify(mid));
  await until(() => window.__ASHEN__.snapshot().player.bow.charged, 60000, 'заряд');
  await page.screenshot({ path: join(OUT, 'hand_bow_draw.png') });
  await heroShot('hand_bow_draw_hero.png');
  await page.keyboard.up('KeyN');
  const arrow = await until(() => window.__ASHEN__.snapshot().projectiles.filter((p) => p.kind === 'arrow').length, 60000, 'стрела');
  check('выстрел: стрела в snapshot.projectiles', !!arrow, `${arrow}`);
  await page.screenshot({ path: join(OUT, 'hand_bow_release.png') });
  await page.evaluate((h) => { window.__hp0 = h; }, hp0);
  const hit = await until(() => { const h = window.__ASHEN__.snapshot().boss.hp; return h < window.__hp0 ? h : null; }, 120000, 'попадание');
  check('стрела попала в Регента', !!hit, `hp ${hp0} → ${hit}`);
  // руна в стойке: цифра 1 (ИГНИС) → огненная стрела
  await page.keyboard.press('Digit1');
  await page.keyboard.down('KeyN');
  const el = await until(() => { const b = window.__ASHEN__.snapshot().player.bow; return b && b.active && b.element ? b : null; }, 60000, 'стихия');
  check('руна в стойке → стихия стрелы', !!el && el.element === 'fire', JSON.stringify(el));
  await until(() => window.__ASHEN__.snapshot().player.bow.charged, 60000, 'заряд 2');
  await page.keyboard.up('KeyN');
  await until(() => window.__ASHEN__.snapshot().projectiles.some((p) => p.kind === 'arrow' && p.element === 'fire'), 60000, 'огненная стрела');
  await page.screenshot({ path: join(OUT, 'hand_fire_arrow.png') });
  // «Дождь стрел»: W + полное натяжение
  await sleep(500);
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyN');
  await until(() => window.__ASHEN__.snapshot().player.bow.charged, 60000, 'заряд 3');
  await page.keyboard.up('KeyN'); await page.keyboard.up('KeyW');
  const rain = await until(() => window.__ASHEN__.snapshot().projectiles.filter((p) => p.kind === 'arrow').length >= 3, 120000, 'дождь');
  check('«Дождь стрел»', !!rain);
  await page.screenshot({ path: join(OUT, 'hand_rain.png') });
  // выход из стойки
  await page.keyboard.press('KeyB');
  await until(() => !window.__ASHEN__.snapshot().player.bow.active, 30000, 'выход из стойки');
  // сгусток: M удерживать, отпустить
  await page.evaluate(() => { window.__hp2 = window.__ASHEN__.snapshot().boss.hp; });
  await page.keyboard.down('KeyM');
  const sp = await until(() => { const h = window.__ASHEN__.snapshot().player.handSpell; return h && h.phase === 'hold' && h.power > 0.5 ? h : null; }, 60000, 'сгусток');
  check('сгусток в ладони: handSpell hold', !!sp, JSON.stringify(sp));
  await page.screenshot({ path: join(OUT, 'hand_orb_hold.png') });
  await heroShot('hand_orb_hold_hero.png');
  await page.keyboard.up('KeyM');
  const orbs = await until(() => window.__ASHEN__.snapshot().projectiles.filter((p) => p.kind === 'hand_orb').length, 60000, 'бросок');
  check('бросок: hand_orb в snapshot.projectiles', !!orbs, `${orbs}`);
  await page.screenshot({ path: join(OUT, 'hand_orb_throw.png') });
  const hit2 = await until(() => window.__ASHEN__.snapshot().boss.hp < window.__hp2, 120000, 'попадание сгустка');
  check('сгусток попал в Регента', !!hit2);
  const dbg = await page.evaluate(() => window.__ASHEN__.hand());
  console.log('  hand debug:', JSON.stringify(dbg.counters), JSON.stringify(dbg.debugKeys));
  check('консоль без ошибок (JS)', errors.length === 0, errors.slice(0, 5).join(' | '));
  if (netErrors.length) console.log('  сеть (внешние ресурсы песочницы, не JS):', netErrors.length, netErrors[0]);
} catch (e) {
  check('сценарий', false, e.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} FAIL` : '\nвсё PASS');
process.exit(failures ? 1 : 0);
