// [W4-БЮДЖЕТ] Галерея кадров в фиксированных ракурсах — база «до/после» для всех агентов волны визуала.
//   node tools/visual_gallery.mjs --label before        — снять на этой ветке → docs/gallery/before/*.jpg + sheet.jpg
//   node tools/visual_gallery.mjs --label after         — то же после своих правок; сравнивать с before кадр в кадр
//   node tools/visual_gallery.mjs --label after --only menu_elf,spell_gate   — часть кадров (префиксы имён)
// Флаги: --quality high (по умолчанию) --size 1280x720 --heroes ashen,elf --root DIR (другая папка игры)
//        --out DIR (вместо docs/gallery/<label>) --no-sheet --video [файл.mp4] (12 с боя: заклинания кадр в кадр)
//
// Кадры. Меню, каждый герой: game — как видит игрок (витрина, интерфейс); front / three_quarter / face —
// фиксированная камера от позиции и поворота героя (анфас, 3/4, крупно лицо), интерфейс скрыт.
// Бой («Отладка с клавиатуры», Регент без урона): общий план (камера игры) и обзор арены (фиксированная камера),
// каждое заклинание J, L, O, X, G, U, руны 1–0 (камера игры, кадр — на пике эффекта), удар Регента в фазе 1.
// Регент на 400 HP: переход в фазу 2 (рёв), гроза, удар в фазе 2, «Небесный суд», гибель.
// Время — виртуальное (1/30 с на кадр), Math.random — с зерном: от прогона к прогону кадры почти совпадают.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HERE, args, sleep, HERO_IDS, SPELLS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame,
} from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const LABEL = A.of('--label', 'after');
const Q = A.of('--quality', 'high');
const SIZE = A.of('--size', '1280x720').split('x').map(Number);
const HEROES = A.of('--heroes', HERO_IDS.join(',')).split(',').filter(Boolean);
const ONLY = (A.of('--only', '') || '').split(',').filter(Boolean);
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'gallery', LABEL)));
const SEED = +A.of('--seed', '20261002');
const VIDEO = A.has('--video') ? resolve(A.of('--video', '') && !A.of('--video', '').startsWith('--') ? A.of('--video') : join(OUT, 'battle.mp4')) : '';
const JPEG = +A.of('--jpeg', '82');
const T0 = Date.now();
const log = (m) => console.error(`[visual_gallery ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
const want = (id) => !ONLY.length || ONLY.some((o) => id === o || id.startsWith(o));

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

// Фиксированные ракурсы витрины от героя: forward = (sin yaw, 0, cos yaw), как в modules/heroShowcase.js
function heroCams(h) {
  const [x, y, z] = h.pos, yaw = h.yaw;
  const dir = (a) => [Math.sin(yaw + a), Math.cos(yaw + a)];
  const at = [x, y + 0.98, z];
  const [fx, fz] = dir(0), [tx, tz] = dir(0.72);
  const [hx, hy, hz] = h.head;
  const [px, pz] = dir(0.3);
  return {
    front: { pos: [x + fx * 3.7, y + 1.15, z + fz * 3.7], at, fov: 36 },
    three_quarter: { pos: [x + tx * 3.3, y + 1.4, z + tz * 3.3], at, fov: 36 },
    face: { pos: [hx + px * 1.05, hy + 0.02, hz + pz * 1.05], at: [hx, hy - 0.07, hz], fov: 30 },
  };
}

const { chromium } = loadPlaywright();
const server = await startServer(ROOT);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
const errors = [];
try {
  // ---------------------------------------------------------------- страница A: меню и бой
  const needMenu = HEROES.some((h) => want(`menu_${h}`));
  const needBattle = ['battle', 'spell', 'boss_strike_p1'].some(want) || !!VIDEO;
  if (needMenu || needBattle) {
    const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: HEROES[0] || 'ashen' }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`A: ${m}`) });
    const { page } = g;
    for (const h of HEROES) {
      if (!want(`menu_${h}`)) continue;
      await g.virtual(false);
      await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click();
      await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { polling: 200 }).catch(() => log(`герой ${h} не загрузился`));
      await page.mouse.move(2, 2);   // курсор не над карточкой (подсветка наведения)
      await g.virtual(true);
      await g.step(75);              // «выход» героя (жест силы) отыгран, витрина успокоилась
      await shot(page, `menu_${h}_game`, `${h} · меню`);
      const pose = await g.heroPose();
      if (!pose) { log(`нет героя в сцене (${h})`); continue; }
      const cams = heroCams(pose);
      await g.hideUi(true);
      for (const [k, cam] of Object.entries(cams)) {
        await g.setCam(cam);
        await g.step(2);
        await shot(page, `menu_${h}_${k}`, `${h} · ${{ front: 'анфас', three_quarter: '3/4', face: 'лицо' }[k]}`);
      }
      await g.setCam(null);
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
      await g.virtual(true);
      await page.keyboard.press('Tab');   // список жестов слева скрыт — в кадре сцена
      await g.step(45);
      await shot(page, 'battle_wide', 'бой · общий план');
      await g.setCam({ pos: [13.5, 7.5, 15.5], at: [0, 2.2, 0], fov: 50 });
      await g.step(2);
      await shot(page, 'battle_overview', 'бой · обзор арены');
      await g.setCam(null);
      await g.step(4);
      // видео: каждый шаг — кадр (заклинания подряд, без ожидания энергии)
      const vstep = async (n) => {
        if (!FRAMES) return g.step(n);
        for (let i = 0; i < n; i++) { await g.step(1); vframe++; await page.screenshot({ path: join(FRAMES, `${String(vframe).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 }); }
      };
      // кадр на пике: peak — кадров после нажатия/отпускания
      const PEAK = { fire: 18, burst: 8, orb: 10, gate: 12, pillar: 12, spark: 7, rune_ignis: 12, rune_fulgur: 8, rune_orbis: 14, rune_stella: 22, rune_spira: 16, rune_lemnis: 14, rune_caret: 10, rune_vee: 12, rune_clepsydra: 14, rune_alpha: 12 };
      for (const s of SPELLS) {
        const id = `spell_${s.id}`;
        if (!want(id) && !FRAMES) continue;
        if (!FRAMES) {
          // энергия — в «быстром» настоящем времени
          await g.virtual(false);
          await page.waitForFunction(() => { const s = window.__ASHEN__.snapshot(); return s && s.player.energy >= 75 && s.player.action !== 'cast'; }, null, { polling: 200, timeout: 120000 }).catch(() => log(`${id}: не дождались энергии`));
          await g.virtual(true);
          await g.step(3);
        }
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
        let st = await g.snap();
        for (let i = 0; i < 300 && st.bossAction !== 'attack'; i += 2) { await g.step(2); st = await g.snap(); }
        await g.step(3);
        await shot(page, 'boss_strike_p1', 'удар Регента · фаза 1');
      }
    }
    errors.push(...g.errors.slice(0, 10));
    await g.ctx.close();
  }

  // ---------------------------------------------------------------- страница B: фазы Регента
  if (['phase2_roar', 'phase2_storm', 'boss_strike_p2', 'ult_call', 'ult_strike', 'boss_death'].some(want)) {
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
    await g.virtual(false);
    let s = await stateOf();
    for (let i = 0; i < 40 && s.st === 'playing' && s.stage === 1 && s.hp > s.maxHp * 0.5; i++) { await page.keyboard.press(HITS[i % HITS.length]); await sleep(1500); s = await stateOf(); }
    await g.virtual(true);
    for (let i = 0; i < 300 && s.stage !== 2 && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
    await g.step(22);
    await shot(page, 'phase2_roar', 'Регент · переход в фазу 2');
    await g.step(70);
    await shot(page, 'phase2_storm', 'фаза 2 · гроза');
    s = await stateOf();
    for (let i = 0; i < 360 && s.act !== 'attack' && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
    await g.step(3);
    await shot(page, 'boss_strike_p2', 'удар Регента · фаза 2');
    // «Небесный суд»
    for (let i = 0; i < 20 && s.fury < 100 && s.st === 'playing'; i++) { await g.virtual(false); await page.keyboard.press(HITS[(i + 1) % HITS.length]); await sleep(1500); await g.virtual(true); s = await stateOf(); }
    for (let i = 0; i < 300 && s.act !== 'idle' && s.act !== 'recover' && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
    await page.keyboard.press('KeyU');
    await g.step(30);
    await shot(page, 'ult_call', '«Небесный суд» · зов');
    await g.step(39);   // удар меча — 2,3 с от начала сцены
    await shot(page, 'ult_strike', '«Небесный суд» · удар');
    await g.step(45);
    s = await stateOf();
    for (let i = 0; i < 16 && s.st === 'playing'; i++) { await page.keyboard.press(HITS[i % HITS.length]); await g.step(12); s = await stateOf(); }
    await g.step(30);
    await shot(page, 'boss_death', 'гибель Регента');
    await g.step(45);
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
    execFileSync(process.execPath, [join(HERE, 'tools', 'sheet.mjs'), '--out', join(OUT, 'sheet.jpg'), '--cols', '5', '--title', `ASHEN OATH · галерея «${LABEL}» · ${Q} · ${SIZE.join('×')}`, ...items], { stdio: 'inherit' });
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
