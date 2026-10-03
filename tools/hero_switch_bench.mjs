// [W5-СМЕНА] Замер смены героя в меню: клик по карточке → герой готов, самый длинный кадр (задача главного
// потока), сколько программ шейдеров, текстур и холстов создаётся за смену, рост памяти за круги.
//   node tools/hero_switch_bench.mjs                              — medium, 6 кругов по 5 героям, JSON в /tmp
//   node tools/hero_switch_bench.mjs --quality low,medium --rounds 2 --out docs/hero-switch.json
//   node tools/hero_switch_bench.mjs --root ../main-wt --label before   — другая папка игры (замер «до»)
// Флаги: --size 480x270 (вьюпорт: программный рендер быстрее), --order ashen,elf,…, --settle 1500 (мс после
//        готовности героя, пока ловим хвост: первая отрисовка, сборка шейдеров сцены), --no-trace (без профиля Chrome),
//        --no-prebuild-wait (не ждать предсборку соседей перед кликом), --pingpong 6 (смен «туда-обратно» между
//        первым и третьим героем списка после кругов: возврат к недавнему герою), --query '?…&prebuild=0' (без предсборки).
// Перед каждым кликом стенд ждёт, пока витрина соберёт соседей в простое (heroModel.state().cache.jobs пусто, до 120 с
// реального времени, после 2,5 с на витрине) — как игрок, который пару секунд разглядывает героиню.
//
// Время — настоящее (часы страницы не подменяются: смена героя асинхронна, её куски идут по таймерам и сети).
// Главный поток — профиль Chrome (CDP Tracing, задачи RunTask потока CrRendererMain): самая длинная задача
// в окне смены и сумма работы сверх простоя меню (простой — та же длина окна до клика). На программном рендере
// (облако, SwiftShader) в задачи кадра входит и подача команд WebGL: смотреть на разницу «до/после», а не на абсолют.
// Счётчики (init-скрипт до кода игры): холсты (createElement('canvas'), OffscreenCanvas), getContext('2d'),
// linkProgram / compileShader (сборка программ), texImage2D / texStorage2D (загрузка текстур) и их время.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { HERE, args, sleep, loadPlaywright, chromiumPath, startServer, configPatcher, HERO_IDS } from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const QS = A.of('--quality', 'medium').split(',').filter(Boolean);
const ROUNDS = Math.max(1, +A.of('--rounds', '6'));
const SIZE = A.of('--size', '480x270').split('x').map(Number);
const ORDER = A.of('--order', HERO_IDS.join(',')).split(',').filter(Boolean);
const SETTLE = +A.of('--settle', '1500');
const TRACE = !A.has('--no-trace');
const LABEL = A.of('--label', 'run');
const OUT = resolve(A.of('--out', join(tmpdir(), `hero-switch-${LABEL}.json`)));
const QUERY = A.of('--query', '?uncapped=1&cursor=0');
const PREBUILD_WAIT = !A.has('--no-prebuild-wait');
const PINGPONG = +A.of('--pingpong', '6');
const T0 = Date.now();
const log = (m) => console.error(`[hero_switch ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);

// ------------------------------------------------------------------ счётчики страницы (до кода игры)
function COUNTERS() {
  const C = window.__sw = { canvas: 0, offscreen: 0, ctx2d: 0, link: 0, compile: 0, texImage: 0, texStorage: 0, texMs: 0, createTex: 0, delTex: 0, delProg: 0, mip: 0, mipMs: 0 };
  const now = () => performance.now();
  const oCE = Document.prototype.createElement;
  Document.prototype.createElement = function (t, o) { if (String(t).toLowerCase() === 'canvas') C.canvas++; return oCE.call(this, t, o); };
  if (typeof OffscreenCanvas === 'function') {
    const O = OffscreenCanvas;
    window.OffscreenCanvas = class extends O { constructor(w, h) { super(w, h); C.canvas++; C.offscreen++; } };
  }
  const oGC = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (k, o) { if (k === '2d') C.ctx2d++; return oGC.call(this, k, o); };
  if (typeof OffscreenCanvas === 'function') {
    const oGO = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (k, o) { if (k === '2d') C.ctx2d++; return oGO.call(this, k, o); };
  }
  const wrap = (P, name, key, msKey) => {
    const f = P[name];
    if (typeof f !== 'function') return;
    P[name] = function (...a) {
      C[key]++;
      if (!msKey) return f.apply(this, a);
      const t = now(); try { return f.apply(this, a); } finally { C[msKey] += now() - t; }
    };
  };
  for (const P of [window.WebGL2RenderingContext && WebGL2RenderingContext.prototype, window.WebGLRenderingContext && WebGLRenderingContext.prototype].filter(Boolean)) {
    wrap(P, 'linkProgram', 'link'); wrap(P, 'compileShader', 'compile');
    wrap(P, 'texImage2D', 'texImage', 'texMs'); wrap(P, 'texStorage2D', 'texStorage', 'texMs'); wrap(P, 'texSubImage2D', 'texImage', 'texMs');
    wrap(P, 'createTexture', 'createTex'); wrap(P, 'deleteTexture', 'delTex'); wrap(P, 'deleteProgram', 'delProg');
    wrap(P, 'generateMipmap', 'mip', 'mipMs');
  }
  // первый кадр с готовым героем после клика: метка по rAF (кадр уже нарисован предыдущим колбэком)
  const oRAF = window.requestAnimationFrame.bind(window);
  window.__swWatch = { want: null, t0: 0, readyAt: null, frameAt: null, frames: 0, maxGap: 0, last: 0 };
  const tick = (t) => {
    const W = window.__swWatch;
    if (W.want) {
      const n = now();
      if (W.last) W.maxGap = Math.max(W.maxGap, n - W.last);
      W.last = n; W.frames++;
      try {
        const h = window.__ASHEN__ && window.__ASHEN__.hero();
        if (h && h.hero === W.want && h.ready) { if (W.readyAt === null) W.readyAt = n; else if (W.frameAt === null) W.frameAt = n; }
      } catch (e) { /* игра ещё не готова */ }
    }
    oRAF(tick);
  };
  oRAF(tick);
}

// ------------------------------------------------------------------ профиль Chrome: задачи главного потока
async function traceStart(cdp) {
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,toplevel,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
}
async function traceEnd(cdp) {
  const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  let text = '';
  for (;;) {
    const r = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
    text += r.base64Encoded ? Buffer.from(r.data, 'base64').toString('utf8') : r.data;
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const j = JSON.parse(text);
  const ev = Array.isArray(j) ? j : j.traceEvents || [];
  // главный поток страницы: CrRendererMain с наибольшей суммой задач
  const names = new Map();
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') names.set(`${e.pid}:${e.tid}`, true);
  // задача верхнего уровня — RunTask (микрозадачи, промисы) или ThreadControllerImpl::RunTask (таймеры, кадры);
  // они бывают вложены друг в друга — оставляем только внешние интервалы
  const byT = new Map();
  for (const e of ev) {
    if (e.ph !== 'X' || (e.name !== 'RunTask' && e.name !== 'ThreadControllerImpl::RunTask') || !names.has(`${e.pid}:${e.tid}`)) continue;
    const k = `${e.pid}:${e.tid}`;
    if (!byT.has(k)) byT.set(k, []);
    byT.get(k).push({ ts: e.ts / 1000, dur: (e.dur || 0) / 1000 });
  }
  const top = (arr) => {
    arr.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const out = [];
    let end = -Infinity;
    for (const t of arr) { if (t.ts + t.dur <= end + 1e-3) continue; out.push(t); end = Math.max(end, t.ts + t.dur); }
    return out;
  };
  let best = [], bestSum = -1;
  for (const arr0 of byT.values()) { const arr = top(arr0); const s = arr.reduce((a, t) => a + t.dur, 0); if (s > bestSum) { bestSum = s; best = arr; } }
  return best;
}
const taskStats = (tasks) => {
  const d = tasks.map((t) => t.dur);
  return { n: d.length, maxMs: d.length ? +Math.max(...d).toFixed(1) : 0, sumMs: +d.reduce((a, b) => a + b, 0).toFixed(1), over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length };
};

// ------------------------------------------------------------------ один уровень качества
async function run(browser, server, q) {
  const ctx = await browser.newContext({ viewport: { width: SIZE[0], height: SIZE[1] }, deviceScaleFactor: 1 });
  const s = { qualityAuto: false, quality: q, reducedMotion: false, volume: 0, muted: true, voice: false, hero: ORDER[0] };
  await ctx.addInitScript((st) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(st)); localStorage.setItem('ashen-oath.showcase-hint', '1'); } catch (e) { /* ignore */ } }, s);
  await ctx.addInitScript(COUNTERS);
  await ctx.route(/\/config\.js(\?.*)?$/, configPatcher({}));
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(server.url + QUERY, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => log('ассеты мира не догрузились'));
  await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return h && h.ready; }, null, { timeout: 180000 });
  const ext = await page.evaluate(() => { const c = document.querySelector('canvas#ao-canvas'); const gl = c && (c.getContext('webgl2') || c.getContext('webgl')); return gl ? { parallel: !!gl.getExtension('KHR_parallel_shader_compile'), renderer: gl.getParameter(gl.RENDERER) } : null; });
  log(`${q}: страница готова, KHR_parallel_shader_compile ${ext && ext.parallel}, ${ext && ext.renderer}`);
  // меню отстоялось (сборка шейдеров сцены, предзагрузка соседей витриной)
  await sleep(6000);
  const cdp = TRACE ? await ctx.newCDPSession(page) : null;
  const state = () => page.evaluate(() => {
    const ri = window.__ASHEN__.renderInfo();
    let heap = null;
    try { if (typeof gc === 'function') gc(); heap = performance.memory ? performance.memory.usedJSHeapSize : null; } catch (e) { /* ignore */ }
    return { ...ri, heap, c: { ...window.__sw } };
  });
  const diff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, typeof b[k] === 'number' ? +(b[k] - (a[k] || 0)).toFixed(1) : b[k]]));
  // простой меню: та же длина окна — сколько главный поток занят без смены
  let idle = null;
  if (cdp) {
    await traceStart(cdp); await sleep(3000);
    const t = await traceEnd(cdp);
    const st = taskStats(t);
    idle = { ...st, perSec: +(st.sumMs / 3).toFixed(1) };
    log(`${q}: простой меню — задач ${st.n}, самая длинная ${st.maxMs} мс, занято ${idle.perSec} мс/с`);
  }
  const switches = [];
  const rounds = [];
  let cur = ORDER[0];
  // предсборка соседей (витрина, в простое): ждём, пока закончится — иначе клик меряет «спешную» сборку
  const waitPrebuild = async () => {
    if (!PREBUILD_WAIT) return 0;
    const t0 = Date.now();
    await sleep(2800);   // витрина начинает предсборку через 2,5 с простоя
    await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return !h || !h.cache || !h.cache.jobs.length; }, null, { timeout: 120000, polling: 250 }).catch(() => log('предсборка не закончилась за 2 мин'));
    return Date.now() - t0;
  };
  async function switchTo(id, r, phase) {
    const waited = await waitPrebuild();
    const before = await state();
    if (cdp) await traceStart(cdp);
    const tClick = await page.evaluate((v) => {
      const W = window.__swWatch; Object.assign(W, { want: v, readyAt: null, frameAt: null, frames: 0, maxGap: 0, last: 0 });
      const inp = document.querySelector(`.ao-herocard__input[value="${v}"]`);
      W.t0 = performance.now();
      if (inp) inp.click();
      return { t0: W.t0, ok: !!inp, clickMs: +(performance.now() - W.t0).toFixed(1) };
    }, id);
    const tWall0 = Date.now();
    await page.waitForFunction((v) => { const W = window.__swWatch; return W.want === v && W.frameAt !== null; }, id, { timeout: 240000, polling: 50 }).catch(() => log(`${q}: ${id} не появился за 4 мин`));
    await sleep(SETTLE);
    const w = await page.evaluate(() => { const W = window.__swWatch; const h = window.__ASHEN__.hero(); const r = { ...W, timing: h && h.timing, hero: h && h.hero }; W.want = null; return r; });
    const tasks = cdp ? await traceEnd(cdp) : [];
    const after = await state();
    const winMs = Date.now() - tWall0;
    const ts = taskStats(tasks);
    const extra = idle ? +(ts.sumMs - idle.perSec * (winMs / 1000)).toFixed(1) : null;
    const rec = {
      phase, round: r + 1, from: cur, hero: id, clickMs: tClick.clickMs, prebuildWaitMs: waited, cached: !!(w.timing && w.timing.cached),
      readyMs: w.readyAt !== null ? +(w.readyAt - tClick.t0).toFixed(1) : null,
      firstFrameMs: w.frameAt !== null ? +(w.frameAt - tClick.t0).toFixed(1) : null,
      maxFrameGapMs: +w.maxGap.toFixed(1), frames: w.frames, timing: w.timing,
      tasks: ts, extraBusyMs: extra, windowMs: winMs,
      counts: diff(before.c, after.c),
      programs: after.programs, programsNew: after.programs - before.programs, textures: after.textures, texturesNew: after.textures - before.textures,
      geometries: after.geometries, heap: after.heap,
    };
    switches.push(rec);
    log(`${q} ${phase} ${r + 1}: ${cur} → ${id}${rec.cached ? ' (готовый)' : ''}: готов ${rec.readyMs} мс, кадр ${rec.firstFrameMs} мс, длиннейшая задача ${ts.maxMs} мс (>50: ${ts.over50}), сверх простоя ${extra} мс; ` +
      `программ +${rec.counts.link} (живых ${rec.programs}), текстур загружено ${rec.counts.texImage + rec.counts.texStorage} за ${rec.counts.texMs} мс, холстов +${rec.counts.canvas}, 2d +${rec.counts.ctx2d}; heap ${(rec.heap / 1048576).toFixed(1)} МБ`);
    cur = id;
  }
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < ORDER.length; i++) {
      const id = ORDER[(i + 1) % ORDER.length];
      if (id === cur) continue;
      await switchTo(id, r, 'круг');
    }
    const st = await state();
    rounds.push({ round: r + 1, heapMB: st.heap ? +(st.heap / 1048576).toFixed(1) : null, textures: st.textures, geometries: st.geometries, programs: st.programs, canvases: st.c.canvas });
    log(`${q}: круг ${r + 1} — heap ${rounds[rounds.length - 1].heapMB} МБ, текстур ${st.textures}, геометрий ${st.geometries}, программ ${st.programs}`);
  }
  // туда-обратно между первым и третьим героем (не соседи по карточкам): возврат к недавнему герою
  for (let i = 0; i < PINGPONG; i++) await switchTo(cur === ORDER[2 % ORDER.length] ? ORDER[0] : ORDER[2 % ORDER.length], i, 'туда-обратно');
  await ctx.close();
  // сводка: первая смена на героя (холодная) и повторные (тёплые)
  const seen = new Set(), cold = [], warm = [];
  for (const s of switches) { (seen.has(s.hero) ? warm : cold).push(s); seen.add(s.hero); }
  const agg = (arr) => {
    const m = (k) => { const a = arr.map(k).filter((v) => Number.isFinite(v)).sort((x, y) => x - y); return a.length ? { med: a[a.length >> 1], max: a[a.length - 1] } : null; };
    return { n: arr.length, readyMs: m((s) => s.readyMs), firstFrameMs: m((s) => s.firstFrameMs), maxTaskMs: m((s) => s.tasks.maxMs), extraBusyMs: m((s) => s.extraBusyMs), programsLinked: m((s) => s.counts.link), texUploads: m((s) => s.counts.texImage + s.counts.texStorage), canvases: m((s) => s.counts.canvas) };
  };
  // повторные: из кэша (собранный герой — подмена в кадр) и пересобранные (вытеснен из кэша: данные — из кэшей модулей)
  return { quality: q, ext, idle, switches, rounds, cold: agg(cold), warm: agg(warm), warmReady: agg(warm.filter((x) => x.cached)), warmRebuilt: agg(warm.filter((x) => !x.cached)), errors };
}

const { chromium } = loadPlaywright();
const exe = chromiumPath();
const server = await startServer(ROOT);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc', '--enable-precise-memory-info'],
});
const out = { tool: 'tools/hero_switch_bench.mjs', label: LABEL, root: ROOT === HERE ? '.' : ROOT, size: SIZE, rounds: ROUNDS, order: ORDER, results: {} };
try {
  for (const q of QS) out.results[q] = await run(browser, server, q);
} finally {
  await browser.close();
  server.kill();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const q of QS) {
  const R = out.results[q];
  console.log(`\n${q}: холодная смена ${JSON.stringify(R.cold)}\n${q}: повторная ${JSON.stringify(R.warm)}\n${q}: повторная из кэша ${JSON.stringify(R.warmReady)}\n${q}: повторная с пересборкой ${JSON.stringify(R.warmRebuilt)}\n${q}: круги ${JSON.stringify(R.rounds)}`);
  if (R.errors.length) console.log(`${q}: ошибки страницы (${R.errors.length}):\n  ` + R.errors.slice(0, 12).join('\n  '));
}
log(`→ ${OUT}`);
