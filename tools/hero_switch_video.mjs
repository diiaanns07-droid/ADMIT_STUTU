// [W5-СМЕНА] Смена героя на витрине меню — кадр за кадром (виртуальное время, как tools/visual_budget.mjs и
// tools/face_video.mjs): видео, лист кадров вокруг подмены и проверка каждого кадра.
//   node tools/hero_switch_video.mjs                                   — medium, круг по героям и «туда-обратно»
//   node tools/hero_switch_video.mjs --scenario burst                  — быстрые клики по пяти карточкам подряд
//   node tools/hero_switch_video.mjs --scenario play                   — смена и сразу «Играть» → бой
//   node tools/hero_switch_video.mjs --reduced                         — «Уменьшенное движение»
// Флаги: --quality medium --size 960x540 --order elf,dark,… --out docs/video/hero_switch.mp4 --sheet файл.jpg
//        --json файл.json --after 40 (кадров после подмены) --before 12 (кадров до клика) --root DIR (другая папка игры)
//        --no-video (только проверка) --query '?…'
// Каждый кадр (шаг 1/30 с игрового времени) — снимок экрана и сводка героя в сцене:
//   slots  — слотов героя в корне (0 после первого показа = пустой кадр), meshes — видимых мешей героя,
//   hair   — видимых прядей heroHair (у героинь не должно падать до 0), arms — «рука вниз» (плечо → локоть, 1 — вниз,
//   0 — в стороны: обе ≈ 0 — T-поза), ghosts — видимых силуэтов растворения (heroGhost), shown — кто на сцене.
// Нарушения (пустой кадр, T-поза, герой без волос/одежды — мешей меньше, чем у этого героя в покое) печатаются,
// код выхода 1. Время на программном рендере — ~1 кадр/с: круг по пяти героям — несколько минут.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { HERE, args, sleep, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame, HERO_IDS } from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const Q = A.of('--quality', 'medium');
const SIZE = A.of('--size', '960x540').split('x').map(Number);
const SCEN = A.of('--scenario', 'cycle');
const REDUCED = A.has('--reduced');
const AFTER = +A.of('--after', '40');
const BEFORE = +A.of('--before', '12');
const VIDEO = !A.has('--no-video');
const tag = `${SCEN}-${Q}${REDUCED ? '-reduced' : ''}`;
const OUT = resolve(A.of('--out', join(HERE, `docs/video/hero_switch_${tag}.mp4`)));
const SHEET = resolve(A.of('--sheet', join(tmpdir(), `hero_switch_${tag}.jpg`)));
const JSON_OUT = resolve(A.of('--json', join(tmpdir(), `hero_switch_${tag}.json`)));
const QUERY = A.of('--query', '?uncapped=1');
const DEF_ORDER = { cycle: 'elf,dark,ranger,archmage,ashen,archmage,ashen,dark', burst: 'elf,dark,ranger,archmage,elf', play: 'dark' }[SCEN] || 'elf';
const ORDER = A.of('--order', DEF_ORDER).split(',').filter(Boolean);
const FRAMES = join(tmpdir(), `hero_switch_frames_${process.pid}`);
const T0 = Date.now();
const log = (m) => console.error(`[hero_switch_video ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);

// сводка героя в кадре (страница): см. шапку
function HSTATS() {
  const P = window.__vb && window.__vb.probe, sc = P && P.scene;
  const root = sc ? sc.getObjectByName('hero') : null;
  const h = window.__ASHEN__.hero();
  const o = { hero: h && h.hero, shown: h && h.cache ? h.cache.shown : null, ready: !!(h && h.ready), loading: !!(h && h.loading),
    procedural: h ? h.procedural : null, built: h && h.cache ? h.cache.built.join(',') : '', jobs: h && h.cache ? h.cache.jobs.length : 0,
    slots: 0, meshes: 0, hair: 0, arms: null, ghosts: 0, screen: window.__ASHEN__.screen };
  if (!root) return o;
  const V = root.position.constructor;
  const slots = root.children.filter((c) => c.name === 'hero-slot');
  o.slots = slots.length;
  const bone = {};
  for (const s of slots) {
    if (!root.visible) break;
    s.traverseVisible((x) => {
      if (x.isMesh || x.isSkinnedMesh || x.isPoints) { o.meshes++; if (x.userData && x.userData.hair) o.hair++; }
      if (x.name === 'upperarm_l' || x.name === 'lowerarm_l' || x.name === 'upperarm_r' || x.name === 'lowerarm_r') bone[x.name] = x;
    });
  }
  const down = (a, b) => { if (!a || !b) return null; const p = a.getWorldPosition(new V()), q = b.getWorldPosition(new V()); const d = q.sub(p).normalize(); return +(-d.y).toFixed(2); };
  const l = down(bone.upperarm_l, bone.lowerarm_l), r = down(bone.upperarm_r, bone.lowerarm_r);
  if (l !== null || r !== null) o.arms = [l, r];
  sc.traverseVisible((x) => { const m = x.material; if (x.isSkinnedMesh && m && m.name === 'hero-afterimage' && m.opacity > 0.01) o.ghosts++; });
  return o;
}

const { chromium } = loadPlaywright();
const browser = await launchBrowser(chromium, chromiumPath());
const server = await startServer(ROOT);
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const frames = [];
const marks = [];
const problems = [];
let n = 0;
try {
  const settings = { quality: Q, reducedMotion: REDUCED, hero: SCEN === 'play' ? 'ashen' : 'ashen' };
  const g = await openGame(browser, server, { size: SIZE, settings, query: QUERY, log });
  const { page } = g;
  await page.evaluate(`window.__hstats = ${HSTATS.toString()}`);
  // меню отстоялось (шейдеры сцены, предзагрузка моделей) — в настоящем времени
  await sleep(4000);
  await g.virtual(true);
  // покой: сколько мешей у каждого героя (эталон «одет и с волосами») — по первому кадру после отстоя
  const steady = {};
  const stat = () => page.evaluate(() => window.__hstats());
  const step = async (save, label = '') => {
    await g.step(1);
    const s = await stat();
    s.i = n; s.label = label;
    if (save) {
      n++;
      s.file = join(FRAMES, `${String(n).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: s.file, type: 'jpeg', quality: 88, timeout: 300000 });
      s.frame = n;
    }
    frames.push(s);
    return s;
  };
  const idle = async (k) => { for (let i = 0; i < k; i++) await step(false); };
  // предсборка соседей: витрина начинает её через 2,5 с простоя (часы страницы) — ждём шагами без записи
  const waitPrebuild = async (max = 600) => {
    for (let i = 0; i < 90; i++) await step(false);
    for (let i = 0; i < max; i++) { const s = await step(false); if (!s.jobs) return i; await sleep(40); }
    log('предсборка не закончилась');
    return max;
  };
  const click = (id) => page.evaluate((v) => { const inp = document.querySelector(`.ao-herocard__input[value="${v}"]`); if (inp) inp.click(); return !!inp; }, id);
  await idle(30);
  const s0 = await stat();
  steady[s0.shown] = s0.meshes;
  log(`старт: ${s0.shown}, мешей ${s0.meshes}, волос ${s0.hair}`);
  // ждём, пока на сцене герой target, и ещё after кадров (с записью)
  const follow = async (target, label, maxFrames = 900) => {
    let swapAt = -1, prevShown = (frames[frames.length - 1] || {}).shown;
    for (let i = 0; i < maxFrames; i++) {
      const s = await step(true, label);
      if (s.shown !== prevShown) { marks.push({ label, from: prevShown, to: s.shown, frame: s.frame, idx: frames.length - 1 }); prevShown = s.shown; }
      if (s.shown === target && s.ready && swapAt < 0) swapAt = i;
      if (swapAt >= 0 && i - swapAt >= AFTER) break;
      if (swapAt < 0) await sleep(20);   // сборка идёт в настоящем времени между шагами
    }
    if (swapAt < 0) problems.push(`${label}: ${target} так и не показан`);
    const last = frames[frames.length - 1];
    if (last && last.shown === target && steady[target] === undefined) steady[target] = last.meshes;
  };
  if (SCEN === 'cycle') {
    for (const id of ORDER) {
      await waitPrebuild();
      for (let i = 0; i < BEFORE; i++) await step(true, `→ ${id}`);
      await click(id);
      await follow(id, `→ ${id}`);
    }
  } else if (SCEN === 'burst') {
    await waitPrebuild();
    for (let i = 0; i < BEFORE; i++) await step(true, 'клики');
    // пять карточек подряд, между кликами — 2 кадра (≈ 70 мс игрового времени)
    for (const id of ORDER) { await click(id); await step(true, `клик ${id}`); await step(true, `клик ${id}`); }
    await follow(ORDER[ORDER.length - 1], 'после кликов', 1500);
  } else if (SCEN === 'play') {
    await waitPrebuild();
    for (let i = 0; i < BEFORE; i++) await step(true, 'меню');
    await click(ORDER[0]);
    await step(true, `клик ${ORDER[0]}`);
    // «Играть» сразу: отладка с клавиатуры → «Играть» → без камеры → «В бой» (кнопки — в настоящем времени, кадры — шагами)
    const press = async (sel, text) => { const b = page.locator(sel, { hasText: text }).first(); await b.click({ timeout: 60000 }); await step(true, text); await step(true, text); };
    await press('.ao-toggle', 'Отладка с клавиатуры');
    await press('button:visible', 'Играть');
    await press('button:visible', 'Продолжить без камеры');
    await press('button:visible', 'В бой');
    await follow(ORDER[0], 'бой', 1500);
    for (let i = 0; i < 60; i++) await step(true, 'бой');
  }
  // проверка кадров: после первого показа — ни пустого кадра, ни T-позы, ни героя «раздетого»
  const heroine = (id) => ['elf', 'dark', 'ranger'].includes(id);
  for (const s of frames) {
    if (s.slots === 0 && s.shown) problems.push(`кадр ${s.i} (${s.label}): пустой — слота героя нет, показан ${s.shown}`);
    if (s.shown && s.meshes === 0) problems.push(`кадр ${s.i} (${s.label}): герой ${s.shown} невидим`);
    if (s.arms && s.arms[0] !== null && s.arms[1] !== null && s.arms[0] < 0.3 && s.arms[1] < 0.3 && s.screen === 'menu') problems.push(`кадр ${s.i} (${s.label}): T-поза? руки ${s.arms}`);
    if (s.shown && heroine(s.shown) && s.hair === 0 && s.meshes > 0) problems.push(`кадр ${s.i} (${s.label}): ${s.shown} без волос`);
    const st = steady[s.shown];
    if (st && s.meshes > 0 && s.meshes < st * 0.9) problems.push(`кадр ${s.i} (${s.label}): ${s.shown} — мешей ${s.meshes} из ${st} (без одежды?)`);
    if (s.procedural) problems.push(`кадр ${s.i} (${s.label}): виден процедурный герой`);
  }
  if (g.errors.length) problems.push(...g.errors.slice(0, 10).map((e) => `ошибка страницы: ${e}`));
  await g.ctx.close();
} finally {
  await browser.close();
  server.kill();
}
// лист кадров вокруг каждой подмены: −2, −1, 0, +1, +3, +6, +10, +16, +24 кадра
const pick = [-2, -1, 0, 1, 3, 6, 10, 16, 24];
const rows = [];
for (const m of marks) {
  for (const d of pick) {
    const f = frames[m.idx + d];
    if (f && f.file) rows.push(`${f.file}:${m.from || '—'}→${m.to} ${d >= 0 ? '+' : ''}${d} (${(d / 30 * 1000).toFixed(0)} мс)${f.ghosts ? ' · силуэтов ' + f.ghosts : ''}`);
  }
}
if (rows.length) {
  mkdirSync(dirname(SHEET), { recursive: true });
  try {
    execFileSync('node', [join(HERE, 'tools/sheet.mjs'), '--out', SHEET, '--cols', String(pick.length), '--title', `Смена героя, ${Q}${REDUCED ? ', уменьшенное движение' : ''}: кадры вокруг подмены (1/30 с)`, ...rows], { stdio: 'inherit' });
  } catch (e) { log('лист кадров не собран: ' + e.message); }
}
if (VIDEO && n) {
  mkdirSync(dirname(OUT), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(FRAMES, '%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'slow', '-movflags', '+faststart', OUT]);
}
mkdirSync(dirname(JSON_OUT), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify({ tool: 'tools/hero_switch_video.mjs', scenario: SCEN, quality: Q, reduced: REDUCED, marks, problems, frames: frames.map(({ file, ...r }) => r) }, null, 1));
if (existsSync(FRAMES)) rmSync(FRAMES, { recursive: true, force: true });
console.log(JSON.stringify({ video: VIDEO && n ? OUT : null, sheet: rows.length ? SHEET : null, json: JSON_OUT, frames: n, swaps: marks.map((m) => `${m.from}→${m.to} @${m.frame}`), problems: problems.length }, null, 1));
if (problems.length) { console.log('НАРУШЕНИЯ:\n  ' + [...new Set(problems)].slice(0, 40).join('\n  ')); process.exitCode = 1; }
