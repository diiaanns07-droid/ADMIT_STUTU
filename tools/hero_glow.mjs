// [W5-СВЕТ] Засветка героев: кадры витрины меню и боя каждого героя и замер по рамке героя.
//   node tools/hero_glow.mjs --label before              — medium и high, 5 героев → docs/hero-glow/before/
//   node tools/hero_glow.mjs --label after --compare docs/hero-glow/before/metrics.json   — «было → стало» в .md
//   node tools/hero_glow.mjs --label t --quality high --heroes elf --no-battle             — часть замера
//   node tools/hero_glow.mjs --haze --heroes elf,ashen   — дымка витрины: метрики через 0,5…12 с после выбора героя
// Флаги: --size 1366x768 (по умолчанию) --jobs 2 (уровни параллельно) --out DIR --seed N
//
// Рамка героя — проекция на экран рамки его сеток (скелетные и непрозрачные; ауры, искры, кольца — нет).
// Лицо — прямоугольник у якоря головы (heroModel: кость head + 0,1 м), смещённый к лицу; лицо видно с камеры
// витрины, в бою камера за спиной — поэтому в бою ещё ракурс спереди (подмена камеры зондом, свет и блум — боевые).
// Метрики (по кадру после постобработки, яркость — Rec. 709 по sRGB 0…1):
//   over   — доля пикселей рамки героя с яркостью > 0,95 (пересвет; цель ≤ 3 %)
//   face   — средняя яркость лица, faceSd — её разброс (черты лица: у «белого пятна» разброс мал), faceOver — пересвет лица
//   bg     — средняя яркость фона вокруг рамки (полоса шириной 25 % рамки), contrast — face / bg
//   heroMean — средняя яркость рамки героя
// Время — виртуальное (1/30 с на кадр, tools/visual_common.mjs), Math.random — с зерном: кадры повторяемы.

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HERE, args, HERO_IDS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame } from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const LABEL = A.of('--label', 'after');
const QS = A.of('--quality', 'medium,high').split(',').filter(Boolean);
const HEROES = A.of('--heroes', HERO_IDS.join(',')).split(',').filter(Boolean);
const SIZE = A.of('--size', '1366x768').split('x').map(Number);
const [W, H] = SIZE;
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'hero-glow', A.has('--haze') ? `${LABEL}-haze` : LABEL)));
const SEED = +A.of('--seed', '20261002');
const JOBS = Math.max(1, +A.of('--jobs', '2'));
const PART = A.of('--part', '');
const COMPARE = A.of('--compare', '');
const NO_BATTLE = A.has('--no-battle');
const NO_MENU = A.has('--no-menu');
const HAZE = A.has('--haze');
const T0 = Date.now();
const log = (m) => console.error(`[hero_glow ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
const NAMES = { ashen: 'Пепельный страж', elf: 'Эльфийка', dark: 'Тёмная чародейка', ranger: 'Лучница', archmage: 'Архимаг' };

// ------------------------------------------------------------------ в странице: рамка героя и лицо на экране
export function HERO_RECTS() {
  const P = window.__vb.probe, scene = P && P.scene, cam = P && P.camera;
  const root = scene && scene.getObjectByName('hero');
  if (!root || !cam) return null;
  scene.updateMatrixWorld(true);
  cam.updateMatrixWorld(true);
  const V = root.position.constructor;
  const box = { min: new V(Infinity, Infinity, Infinity), max: new V(-Infinity, -Infinity, -Infinity) };
  const corners = [];
  const tmpMin = new V(), tmpMax = new V();
  const solid = (m) => m && !m.transparent && m.blending === 1 && m.depthWrite !== false && m.visible !== false && (m.opacity == null || m.opacity >= 0.9);
  let n = 0;
  root.traverseVisible((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (!o.isSkinnedMesh && !mats.every(solid)) return;
    if (o.isSkinnedMesh) { o.computeBoundingBox(); } else if (o.geometry) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); }
    const bb = o.isSkinnedMesh ? o.boundingBox : o.geometry.boundingBox;
    if (!bb || !isFinite(bb.min.x)) return;
    tmpMin.copy(bb.min); tmpMax.copy(bb.max);
    for (let i = 0; i < 8; i++) {
      const c = new V(i & 1 ? tmpMax.x : tmpMin.x, i & 2 ? tmpMax.y : tmpMin.y, i & 4 ? tmpMax.z : tmpMin.z).applyMatrix4(o.matrixWorld);
      corners.push(c);
    }
    n++;
  });
  if (!corners.length) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const toScr = (v) => { const p = v.clone().project(cam); return { x: (p.x * 0.5 + 0.5) * vw, y: (-p.y * 0.5 + 0.5) * vh, z: p.z }; };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of corners) { const s = toScr(c); if (s.z > 1) continue; x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y); }
  const clip = (r) => ({ x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(vw, Math.ceil(r.x1)), y1: Math.min(vh, Math.ceil(r.y1)) });
  const hero = clip({ x0, y0, x1, y1 });
  // лицо: якорь головы (кость head + 0,1 м вверх, 0,02 м вперёд) → чуть вниз и вперёд, ширина ±0,055 м
  let face = null;
  const a = window.__ASHEN__.heroAnchors ? window.__ASHEN__.heroAnchors() : null;
  if (a && a.head) {
    const yaw = root.getWorldQuaternion(new root.quaternion.constructor());
    const fwd = new V(0, 0, 1).applyQuaternion(yaw); fwd.y = 0; fwd.normalize();
    const camRight = new V(1, 0, 0).applyQuaternion(cam.quaternion); camRight.y = 0; camRight.normalize();
    const c = new V(a.head.x, a.head.y, a.head.z).addScaledVector(fwd, 0.07);
    const pts = [];
    for (const dx of [-0.055, 0.055]) for (const dy of [-0.09, 0.03]) pts.push(toScr(c.clone().addScaledVector(camRight, dx).add(new V(0, dy, 0))));
    const facing = fwd.dot(new V().subVectors(cam.position, c).setY(0).normalize());
    face = clip({ x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) });
    face.facing = +facing.toFixed(2);   // > 0,3 — лицо к камере
  }
  return { hero, face, meshes: n, vw, vh };
}

// метрики по PNG кадра (декодирование — в странице, без npm-пакетов)
export async function METRICS({ b64, rects }) {
  const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
  const bmp = await createImageBitmap(blob);
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const W = bmp.width, Hh = bmp.height;
  const d = g.getImageData(0, 0, W, Hh).data;
  const lum = (i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const stat = (r, skip) => {
    let n = 0, s = 0, s2 = 0, over = 0;
    if (!r || r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    for (let y = Math.max(0, r.y0); y < Math.min(Hh, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(W, r.x1); x++) {
      if (skip && x >= skip.x0 && x < skip.x1 && y >= skip.y0 && y < skip.y1) continue;
      const l = lum((y * W + x) * 4);
      n++; s += l; s2 += l * l; if (l > 0.95) over++;
    }
    if (!n) return null;
    const m = s / n;
    return { n, mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), over: over / n };
  };
  const h = rects.hero, f = rects.face;
  const hs = stat(h);
  const pad = h ? Math.round(Math.max(h.x1 - h.x0, (h.y1 - h.y0) * 0.4) * 0.25) : 0;
  const bs = h ? stat({ x0: h.x0 - pad, y0: h.y0 - pad, x1: h.x1 + pad, y1: h.y1 + pad }, h) : null;
  const fs = f && f.facing > 0.3 ? stat(f) : null;
  const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    over: hs ? r3(hs.over) : null, heroMean: hs ? r3(hs.mean) : null,
    face: fs ? r3(fs.mean) : null, faceSd: fs ? r3(fs.sd) : null, faceOver: fs ? r3(fs.over) : null, facePx: fs ? fs.n : 0,
    bg: bs ? r3(bs.mean) : null, contrast: fs && bs ? r3(fs.mean / Math.max(0.01, bs.mean)) : null,
    rect: h, faceRect: f,
  };
}

// Программный рендер: кадр 1366×768 — ~5 с, поэтому длинные отрезки идут в маленьком окне (480×270), а перед
// снимком окно возвращается к SIZE и проходят 4 кадра (постобработка и витрина успевают под новый размер)
const SMALL = [480, 270];
async function view(g, big) { await g.page.setViewportSize(big ? { width: W, height: H } : { width: SMALL[0], height: SMALL[1] }); }

async function measure(g, file, kind) {
  const { page } = g;
  await view(g, true);
  await g.step(4);
  const rects = await page.evaluate(HERO_RECTS);
  const png = await page.screenshot({ type: 'png', timeout: 240000 });
  const m = rects ? await page.evaluate(METRICS, { b64: png.toString('base64'), rects }) : { error: 'нет героя' };
  // кадр в JPEG (для PR и листа)
  const jpg = file.replace(/\.png$/, '.jpg');
  await page.screenshot({ path: jpg, type: 'jpeg', quality: 84, timeout: 240000 });
  await view(g, false);
  log(`${kind}: пересвет ${pct(m.over)}, лицо ${m.face ?? '—'} (σ ${m.faceSd ?? '—'}), фон ${m.bg ?? '—'}, контраст ${m.contrast ?? '—'}`);
  return { ...m, file: relative(OUT, jpg) };
}
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)} %`);

// ------------------------------------------------------------------ один уровень качества
async function runQuality(browser, server, q) {
  const res = {};
  const errors = [];
  if (HAZE) {
    // дымка витрины: каждый герой — выбор карточки, затем кадры через 0,5…12 с (виртуальных) после «готов»
    const g = await openGame(browser, server, { size: SMALL, seed: SEED, settings: { quality: q, hero: HEROES[0] === 'ashen' ? 'dark' : 'ashen' }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`${q} haze: ${m}`) });
    const { page } = g;
    await g.hideUi(true);
    for (const h of HEROES) {
      await g.virtual(false);
      await g.hideUi(false);
      await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click({ timeout: 240000 });
      await g.hideUi(true);
      await page.mouse.move(SMALL[0] - 4, 4);
      await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { timeout: 240000, polling: 50 }).catch(() => errors.push(`${h}: не загрузился`));
      await g.virtual(true);
      let t = 0;
      const series = [];
      for (const at of [0.5, 1, 2, 4, 8, 12]) {
        await g.step(Math.max(0, Math.round((at - t) * 30) - 4)); t = at;   // ещё 4 кадра — в measure
        const m = await measure(g, join(OUT, `${q}_${h}_haze_${String(at).replace('.', '_')}s.png`), `${q} ${h} ${at} с`);
        const sc = await page.evaluate(() => window.__ASHEN__.heroShowcase());
        series.push({ t: at, ...m, showcase: sc });
      }
      res[h] = { haze: series };
    }
    errors.push(...g.errors.slice(0, 10));
    await g.ctx.close();
    return { res, errors };
  }
  for (const h of HEROES) {
    const r = (res[h] = {});
    const g = await openGame(browser, server, { size: SMALL, seed: SEED, settings: { quality: q, hero: h }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`${q} ${h}: ${m}`) });
    const { page } = g;
    try {
      if (!NO_MENU) {
        // витрина: «выход» героя отыгран (2,5 с), как видит игрок; интерфейс скрыт — в кадре только 3D
        await g.virtual(true);
        await page.mouse.move(SMALL[0] - 4, 4);
        await g.step(75);
        await g.hideUi(true);
        await g.step(2);
        r.menu = await measure(g, join(OUT, `${q}_${h}_menu.png`), `${q} ${h} меню`);
        await g.hideUi(false);
      }
      if (!NO_BATTLE) {
        await g.virtual(false);
        await g.toBattle();
        await g.walkToBoss();
        await page.keyboard.press('Tab');   // шпаргалка жестов скрыта
        await g.step(45);
        await g.hideUi(true);
        await g.step(1);
        r.battle = await measure(g, join(OUT, `${q}_${h}_battle.png`), `${q} ${h} бой`);
        // спереди: камера на лицо героя (свет, туман и блум — боевые)
        const pose = await g.heroPose();
        if (pose) {
          const f = [Math.sin(pose.yaw), 0, Math.cos(pose.yaw)];
          const hd = pose.head;
          await g.setCam({ pos: [hd[0] + f[0] * 2.6, hd[1] - 0.05, hd[2] + f[2] * 2.6], at: [hd[0], hd[1] - 0.5, hd[2]], fov: 34 });
          r.battleFront = await measure(g, join(OUT, `${q}_${h}_battle_front.png`), `${q} ${h} бой спереди`);
          // заряд заклинания (J — огонь, удержание 0,6 с): свечение рук
          await page.keyboard.down('KeyJ');
          await g.step(14);
          r.battleCharge = await measure(g, join(OUT, `${q}_${h}_battle_charge.png`), `${q} ${h} заряд спереди`);
          await page.keyboard.up('KeyJ');
          await g.setCam(null);
          await g.step(2);
        }
        await g.hideUi(false);
      }
    } catch (e) { errors.push(`${h}: ${e.message}`); log(`${q} ${h}: ошибка ${e.message}`); }
    errors.push(...g.errors.slice(0, 5).map((x) => `${h}: ${x}`));
    await g.ctx.close();
  }
  return { res, errors };
}

// ------------------------------------------------------------------ отчёт
function report(all, cmp) {
  const L = [];
  const f3 = (v) => (v == null ? '—' : v.toFixed(2));
  const was = (q, h, k, key) => { const v = cmp && cmp.results && cmp.results[q] && cmp.results[q][h] && cmp.results[q][h][k]; return v ? v[key] : undefined; };
  const cell = (v, w, fmt) => (w === undefined ? fmt(v) : `${fmt(w)} → ${fmt(v)}`);
  L.push(`# Засветка героев — «${LABEL}»`);
  L.push('');
  L.push(`Ветка \`${all.branch || '?'}\`, коммит \`${all.commit || '?'}\`, ${SIZE.join('×')}, ${all.generatedAt}. Инструмент: \`node tools/hero_glow.mjs\`.`);
  L.push('');
  L.push('Пересвет — доля пикселей рамки героя с яркостью > 0,95 (цель ≤ 3 %). Лицо — средняя яркость (σ — разброс: черты лица), контраст — лицо / фон вокруг рамки. «Бой» — камера игры (за спиной, лица нет), «спереди» — та же сцена боя с камерой на лицо, «заряд» — спереди, J удерживается 0,6 с.');
  L.push('');
  for (const q of Object.keys(all.results)) {
    L.push(`## ${q}`);
    L.push('');
    L.push('| Герой | Кадр | Пересвет | Средняя рамки | Лицо | σ лица | Пересвет лица | Фон | Контраст |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const h of Object.keys(all.results[q])) {
      const r = all.results[q][h];
      for (const [k, name] of [['menu', 'меню'], ['battle', 'бой'], ['battleFront', 'бой спереди'], ['battleCharge', 'заряд спереди']]) {
        const m = r[k];
        if (!m) continue;
        L.push(`| ${NAMES[h] || h} | ${name} | ${cell(m.over, was(q, h, k, 'over'), pct)} | ${cell(m.heroMean, was(q, h, k, 'heroMean'), f3)} | ${cell(m.face, was(q, h, k, 'face'), f3)} | ${cell(m.faceSd, was(q, h, k, 'faceSd'), f3)} | ${cell(m.faceOver, was(q, h, k, 'faceOver'), pct)} | ${cell(m.bg, was(q, h, k, 'bg'), f3)} | ${cell(m.contrast, was(q, h, k, 'contrast'), f3)} |`);
      }
      if (r.haze) {
        for (const m of r.haze) L.push(`| ${NAMES[h] || h} | ${m.t} с | ${pct(m.over)} | ${f3(m.heroMean)} | ${f3(m.face)} | ${f3(m.faceSd)} | ${pct(m.faceOver)} | ${f3(m.bg)} | ${f3(m.contrast)} |`);
      }
    }
    L.push('');
  }
  if (all.errors && all.errors.length) { L.push('Ошибки страницы:'); L.push(''); for (const e of all.errors.slice(0, 20)) L.push(`- ${e}`); L.push(''); }
  return L.join('\n') + '\n';
}

function sheet(all) {
  // лист «пять героев рядом»: строки — кадры (меню, бой спереди) по уровням качества
  const rows = [];
  for (const q of Object.keys(all.results)) for (const k of ['menu', 'battleFront', 'battle']) {
    const items = HEROES.map((h) => all.results[q][h] && all.results[q][h][k]).filter(Boolean);
    if (items.length) rows.push({ q, k, items: HEROES.map((h) => ({ h, m: all.results[q][h] && all.results[q][h][k] })) });
  }
  if (!rows.length) return;
  const tdir = join(tmpdir(), `hg_thumbs_${process.pid}`);
  mkdirSync(tdir, { recursive: true });
  const KN = { menu: 'меню', battleFront: 'бой спереди', battle: 'бой' };
  for (const row of rows) {
    const it = [];
    for (const { h, m } of row.items) {
      if (!m || !m.file) continue;
      const src = join(OUT, m.file);
      // кадр героя: рамка героя с полями, в высоту 420
      const r = m.rect;
      const png = join(tdir, `${row.q}_${row.k}_${h}.png`);
      let vf = 'scale=-2:420';
      if (r) {
        const hh = Math.round((r.y1 - r.y0) * 1.15), ww = Math.round(hh * 0.62);
        const cx = Math.round((r.x0 + r.x1) / 2), cy = Math.round((r.y0 + r.y1) / 2);
        const x = Math.max(0, Math.min(W - ww, cx - ww / 2)), y = Math.max(0, Math.min(H - hh, cy - hh / 2));
        vf = `crop=${Math.min(ww, W)}:${Math.min(hh, H)}:${Math.round(x)}:${Math.round(y)},scale=260:420`;
      }
      try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', vf, png]); it.push(`${png}:${NAMES[h]} · ${KN[row.k]} · ${row.q} · пересвет ${pct(m.over)}${m.face != null ? ` · лицо ${m.face.toFixed(2)}` : ''}`); } catch (e) { log('кадр листа: ' + e.message); }
    }
    if (!it.length) continue;
    try {
      execFileSync(process.execPath, [join(HERE, 'tools', 'sheet.mjs'), '--out', join(OUT, `sheet_${row.q}_${row.k}.jpg`), '--cols', String(it.length), '--title', `ASHEN OATH · засветка героев «${LABEL}» · ${KN[row.k]} · ${row.q}`, ...it], { stdio: 'inherit' });
    } catch (e) { log('лист не собран: ' + e.message); }
  }
}

function git(root) {
  try { return { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(), branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim() }; } catch (e) { return {}; }
}

// ------------------------------------------------------------------ запуск (импорт модуля — только функции замера)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
async function main() {
mkdirSync(OUT, { recursive: true });
if (PART) {
  // дочерний процесс: один уровень качества
  const { chromium } = loadPlaywright();
  const server = await startServer(ROOT);
  const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
  try {
    const r = await runQuality(browser, server, QS[0]);
    writeFileSync(PART, JSON.stringify(r));
  } finally { await browser.close().catch(() => {}); server.kill(); }
  process.exit(0);
}
const parts = {};
const queue = [...QS];
async function worker() {
  while (queue.length) {
    const q = queue.shift();
    const part = join(tmpdir(), `hero-glow-${process.pid}-${q}.json`);
    const argv = [join(HERE, 'tools', 'hero_glow.mjs'), ...A.argv.filter((x, i, a) => !(x === '--quality' || a[i - 1] === '--quality' || x === '--jobs' || a[i - 1] === '--jobs')), '--quality', q, '--part', part, '--out', OUT];
    await new Promise((res) => { const c = spawn(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] }); c.on('exit', res); });
    try { parts[q] = JSON.parse(readFileSync(part, 'utf8')); } catch (e) { parts[q] = { res: {}, errors: [`${q}: нет результата (${e.message})`] }; }
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, QS.length) }, worker));
const all = { label: LABEL, size: SIZE.join('x'), seed: SEED, ...git(ROOT), generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), results: {}, errors: [] };
for (const q of QS) { if (parts[q]) { all.results[q] = parts[q].res; all.errors.push(...parts[q].errors.map((e) => `${q}: ${e}`)); } }
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(all, null, 1) + '\n');
const cmp = COMPARE && existsSync(COMPARE) ? JSON.parse(readFileSync(COMPARE, 'utf8')) : null;
writeFileSync(join(OUT, 'metrics.md'), report(all, cmp));
if (!HAZE) sheet(all);
log(`готово → ${relative(HERE, OUT)}`);
}
