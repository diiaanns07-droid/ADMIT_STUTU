// [W4-БЮДЖЕТ] Галерея кадров в фиксированных ракурсах — база «до/после» для всех агентов волны визуала.
//   node tools/visual_gallery.mjs --label before        — снять на этой ветке → docs/gallery/before/*.jpg + sheet.jpg
//   node tools/visual_gallery.mjs --label after         — то же после своих правок; сравнивать с before кадр в кадр
//   node tools/visual_gallery.mjs --label after --only menu_elf,spell_gate   — часть кадров (префиксы имён)
// Флаги: --quality high (по умолчанию) --size 1280x720 --heroes ashen,elf --root DIR (другая папка игры)
//        --out DIR (вместо docs/gallery/<label>) --no-sheet --video [файл.mp4] (бой: заклинания кадр в кадр, ~14 с)
//
// Кадры. Меню, каждый герой: game — как видит игрок (витрина и интерфейс); front / three_quarter / face — анфас,
// 3/4 и крупно лицо (интерфейс скрыт). Ракурс задаёт сама витрина (modules/heroShowcase.js): камера игры
// поворачивается перетаскиванием мышью до нужного угла от поворота героя, лицо — двойным щелчком. Поэтому свет
// витрины, фокус и блум — те же, что видит игрок, и одинаковые от прогона к прогону.
// Бой («Отладка с клавиатуры», Регент без урона): общий план (камера игры) и обзор арены (фиксированная камера),
// каждое заклинание J, L, O, X, G, U, руны 1–0 (камера игры, кадр — на пике эффекта), удар Регента в фазе 1.
// Регент на 400 HP: переход в фазу 2 (рёв), гроза, удар в фазе 2, «Небесный суд», гибель.
// Время боя — виртуальное (1/30 с на кадр), Math.random — с зерном: от прогона к прогону кадры совпадают.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HERE, args, HERO_IDS, SPELLS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame,
} from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const LABEL = A.of('--label', 'after');
const Q = A.of('--quality', 'high');
const SIZE = A.of('--size', '1280x720').split('x').map(Number);
const [W, H] = SIZE;
const HEROES = A.of('--heroes', HERO_IDS.join(',')).split(',').filter(Boolean);
const ONLY = (A.of('--only', '') || '').split(',').filter(Boolean);
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'gallery', LABEL)));
const SEED = +A.of('--seed', '20261002');
const vArg = A.of('--video', '');
const VIDEO = A.has('--video') ? resolve(vArg && !vArg.startsWith('--') ? vArg : join(OUT, 'battle.mp4')) : '';
const JPEG = +A.of('--jpeg', '82');
const T0 = Date.now();
const log = (m) => console.error(`[visual_gallery ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
// want — кадр нужен; wantAny — нужен хоть один кадр группы (префиксы в обе стороны: --only spell_gate → группа spell)
const want = (id) => !ONLY.length || ONLY.some((o) => id === o || id.startsWith(o));
const wantAny = (p) => !ONLY.length || ONLY.some((o) => o.startsWith(p) || p.startsWith(o));

mkdirSync(OUT, { recursive: true });
const shots = [];   // { file, id, caption }
const FRAMES = VIDEO ? join(A.of('--tmp', tmpdir()), `vg_frames_${process.pid}`) : '';
if (FRAMES) { rmSync(FRAMES, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true }); }
let vframe = 0;

async function shot(page, id, caption) {
  if (!want(id)) return;
  const file = join(OUT, `${String(shots.length + 1).padStart(2, '0')}_${id}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: JPEG, timeout: 240000 });
  shots.push({ file, id, caption });
  log(`кадр ${relative(HERE, file)}`);
}

// Витрина: азимут камеры игры вокруг героя (или его головы при приближении) относительно поворота героя
async function turnShowcase(g, off, { center = 'root' } = {}) {
  const { page } = g;
  const az = () => page.evaluate((ctr) => {
    const P = window.__vb.probe, root = P.scene && P.scene.getObjectByName('hero');
    if (!root || !P.camera) return null;
    const c = P.camera.position, v = root.getWorldPosition(c.clone());
    if (ctr === 'head') { const a = window.__ASHEN__.heroAnchors(); if (a && a.head) { v.x = a.head.x; v.z = a.head.z; } }
    const d = root.rotation.y + window.__vbOff - Math.atan2(c.x - v.x, c.z - v.z);
    return Math.atan2(Math.sin(d), Math.cos(d));
  }, center);
  await page.evaluate((o) => { window.__vbOff = o; }, off);
  const kpx = 5.5 / Math.max(320, W);   // рад на пиксель перетаскивания (modules/heroShowcase.js)
  let d = null;
  for (let k = 0; k < 6; k++) {
    await g.step(1);
    d = await az();
    if (d == null || Math.abs(d) < 0.015) break;
    const dx = Math.max(-480, Math.min(480, d / kpx));
    const x0 = W / 2 - dx / 2, y0 = H * 0.55;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const n = Math.max(2, Math.ceil(Math.abs(dx) / 30));
    for (let i = 1; i <= n; i++) await page.mouse.move(x0 + (dx * i) / n, y0);
    // гасим инерцию поворота: мелкие движения туда-обратно, скорость ≈ 0
    for (let i = 0; i < 12; i++) await page.mouse.move(x0 + dx + (i % 2 ? 0 : 1), y0);
    await page.mouse.up();
    await g.step(3);
  }
  return d;
}

const { chromium } = loadPlaywright();
const server = await startServer(ROOT);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
const errors = [];
try {
  // ---------------------------------------------------------------- страница A: меню и бой
  const needMenu = HEROES.some((h) => wantAny(`menu_${h}`));
  const needBattle = ['battle', 'spell', 'boss_strike_p1'].some(wantAny) || !!VIDEO;
  if (needMenu || needBattle) {
    const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: HEROES[0] || 'ashen' }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`A: ${m}`) });
    const { page } = g;
    for (const h of HEROES) {
      if (!wantAny(`menu_${h}`)) continue;
      await g.virtual(false);
      await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click();
      await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { polling: 200 }).catch(() => log(`герой ${h} не загрузился`));
      await g.virtual(true);
      await g.step(75);              // «выход» героя (жест силы) отыгран, витрина успокоилась
      await g.hideUi(true);
      // как видит игрок: витрина под углом 0,45 рад, интерфейс на месте
      await turnShowcase(g, 0.45);
      await g.hideUi(false);
      await page.mouse.move(W - 4, 4);   // курсор не над карточкой (подсветка наведения)
      await g.step(4);
      await shot(page, `menu_${h}_game`, `${h} · меню`);
      await g.hideUi(true);
      await turnShowcase(g, 0);
      await shot(page, `menu_${h}_front`, `${h} · анфас`);
      await turnShowcase(g, 0.75);
      await shot(page, `menu_${h}_three_quarter`, `${h} · 3/4`);
      await page.mouse.dblclick(W / 2, H * 0.55);   // приближение к лицу
      await g.step(45);
      await turnShowcase(g, 0.35, { center: 'head' });
      await g.step(10);
      await shot(page, `menu_${h}_face`, `${h} · лицо`);
      await page.mouse.dblclick(W / 2, H * 0.55);   // обратно
      await g.step(45);
      await g.hideUi(false);
    }
    if (needBattle) {
      await g.virtual(false);
      if (needMenu) {
        await page.locator('label.ao-herocard', { has: page.locator('input[value="ashen"]') }).click();
        await page.waitForFunction(() => { const s = window.__ASHEN__.hero(); return s && s.hero === 'ashen' && s.ready; }, null, { polling: 200 }).catch(() => {});
      }
      await g.toBattle();
      await g.walkToBoss();
      await page.keyboard.press('Tab');   // список жестов слева скрыт — в кадре сцена
      await g.step(45);
      await shot(page, 'battle_wide', 'бой · общий план');
      await g.setCam({ pos: [13.5, 7.5, 15.5], at: [0, 2.2, 0], fov: 50 });
      await g.step(2);
      await shot(page, 'battle_overview', 'бой · обзор арены');
      await g.setCam(null);
      await g.step(4);
      // видео: каждый шаг заклинания — кадр ролика (ожидание энергии не пишется: склейка)
      const vstep = async (n) => {
        if (!FRAMES) return g.step(n);
        for (let i = 0; i < n; i++) { await g.step(1); vframe++; await page.screenshot({ path: join(FRAMES, `${String(vframe).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 }); }
      };
      // кадр на пике: кадров после нажатия (отпускания)
      const PEAK = { fire: 18, burst: 8, orb: 10, gate: 12, pillar: 12, spark: 7, rune_ignis: 12, rune_fulgur: 8, rune_orbis: 14, rune_stella: 22, rune_spira: 16, rune_lemnis: 14, rune_caret: 10, rune_vee: 12, rune_clepsydra: 14, rune_alpha: 12 };
      for (const s of SPELLS) {
        const id = `spell_${s.id}`;
        if (!wantAny(id) && !FRAMES) continue;
        // энергия и откат — «быстрыми» шагами по 0,1 с
        const w = await g.stepUntil((x) => x && x.player.energy >= 75 && x.player.action !== 'cast', { max: 120, ms: 100 });
        if (!w.ok) log(`${id}: не дождались энергии`);
        await g.step(3);
        const peak = PEAK[s.id] || 10;
        if (s.hold) {
          await page.keyboard.down(s.key);
          if (s.id === 'fire') { await vstep(peak); await shot(page, id, s.label); await page.keyboard.up(s.key); await vstep(8); continue; }
          await vstep(s.hold);
          if (s.id === 'orb') await shot(page, `${id}_charge`, `${s.label} · заряд`);
          await page.keyboard.up(s.key);
        } else await page.keyboard.press(s.key);
        await vstep(peak);
        await shot(page, id, s.label);
        await vstep(FRAMES ? 6 : 10);
      }
      if (want('boss_strike_p1')) {
        await g.stepUntil((x) => x.boss.action === 'attack', { max: 360 });
        await g.step(3);
        await shot(page, 'boss_strike_p1', 'удар Регента · фаза 1');
      }
    }
    errors.push(...g.errors.slice(0, 10));
    await g.ctx.close();
  }

  // ---------------------------------------------------------------- страница B: фазы Регента
  if (['phase2_roar', 'phase2_storm', 'boss_strike_p2', 'ult_call', 'ult_strike', 'boss_death'].some(wantAny)) {
    const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: 'ashen' }, patch: { bossHp: 0.4, bossDamage: 0 }, log: (m) => log(`B: ${m}`) });
    const { page } = g;
    await g.toBattle();
    await g.walkToBoss();
    await page.keyboard.press('Tab');
    const stateOf = () => page.evaluate(() => {
      const s = window.__ASHEN__.snapshot(), u = window.__ASHEN__.ult();
      return { st: s.status, stage: s.boss.stage, hp: s.boss.hp, maxHp: s.boss.maxHp, act: s.boss.action, fury: s.player.fury, cine: !!(u && u.cine) };
    });
    const HITS = ['KeyL', 'Digit1', 'Digit8', 'Digit7', 'Digit2'];
    let s = await stateOf();
    for (let i = 0; i < 12 && s.st === 'playing' && s.stage === 1 && s.hp > s.maxHp * 0.5; i++) { await page.keyboard.press(HITS[i % HITS.length]); await g.step(24); s = await stateOf(); }
    await g.stepUntil((x) => x.boss.stage === 2 || x.status !== 'playing', { max: 300 });
    await g.step(22);
    await shot(page, 'phase2_roar', 'Регент · переход в фазу 2');
    await g.step(70);
    await shot(page, 'phase2_storm', 'фаза 2 · гроза');
    await g.stepUntil((x) => x.boss.action === 'attack' || x.status !== 'playing', { max: 360 });
    await g.step(3);
    await shot(page, 'boss_strike_p2', 'удар Регента · фаза 2');
    // «Небесный суд»
    s = await stateOf();
    for (let i = 0; i < 20 && s.fury < 100 && s.st === 'playing'; i++) { await page.keyboard.press(HITS[(i + 1) % HITS.length]); await g.fast(15); s = await stateOf(); }
    await g.stepUntil((x) => x.boss.action === 'idle' || x.boss.action === 'recover' || x.status !== 'playing', { max: 300 });
    await page.keyboard.press('KeyU');
    await g.step(30);
    await shot(page, 'ult_call', '«Небесный суд» · зов');
    await g.step(39);   // удар меча — 2,3 с от начала сцены
    await shot(page, 'ult_strike', '«Небесный суд» · удар');
    await g.step(45);
    // добить; гибель — от кадра смерти (экран итогов — через 2,6 с)
    s = await stateOf();
    for (let i = 0; i < 16 && s.st === 'playing'; i++) { await page.keyboard.press(HITS[i % HITS.length]); await g.stepUntil((x) => x.status !== 'playing', { max: 12 }); s = await stateOf(); }
    await g.step(28);
    await shot(page, 'boss_death', 'гибель Регента');
    await g.step(40);
    await shot(page, 'boss_death_orbit', 'гибель · облёт');
    errors.push(...g.errors.slice(0, 10));
    await g.ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  server.kill();
}

// сводный лист: миниатюры (ffmpeg, если есть) → tools/sheet.mjs
if (!A.has('--no-sheet') && shots.length) {
  const tdir = join(tmpdir(), `vg_thumbs_${process.pid}`);
  mkdirSync(tdir, { recursive: true });
  const items = [];
  for (const s of shots) {
    const png = join(tdir, s.id + '.png');
    try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', s.file, '-vf', 'scale=480:-2', png]); items.push(`${png}:${s.caption}`); } catch (e) { items.push(`${s.file}:${s.caption}`); }
  }
  try {
    execFileSync(process.execPath, [join(HERE, 'tools', 'sheet.mjs'), '--out', join(OUT, 'sheet.jpg'), '--cols', '4', '--title', `ASHEN OATH · галерея «${LABEL}» · ${Q} · ${SIZE.join('×')}`, ...items], { stdio: 'inherit' });
  } catch (e) { log('лист не собран: ' + e.message); }
  rmSync(tdir, { recursive: true, force: true });
}
if (FRAMES && vframe) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(FRAMES, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO]);
  rmSync(FRAMES, { recursive: true, force: true });
  log(`видео ${relative(HERE, VIDEO)} (${(vframe / 30).toFixed(1)} с)`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify({ label: LABEL, quality: Q, size: SIZE.join('x'), seed: SEED, generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), shots: shots.map((s) => ({ file: relative(OUT, s.file), id: s.id, caption: s.caption })), errors: errors.slice(0, 10) }, null, 1) + '\n');
log(`готово: ${shots.length} кадров → ${relative(HERE, OUT)}${errors.length ? `, ошибки страницы: ${errors.length}` : ''}`);
