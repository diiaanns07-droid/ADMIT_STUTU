// [W4-БЮДЖЕТ] Общая часть tools/visual_budget.mjs и tools/visual_gallery.mjs: сервер игры, Chromium,
// виртуальные часы страницы и «зонд» рендера. Игровой код не меняется — всё снаружи, из Playwright.
//
// Часы. До vb.virtual(true) страница живёт как обычно (а ответ config.js подменён: maxDt 0,5 и stallSec 5 —
// на программном рендере ~1 кадр/с и игра всё равно движется рывками, так быстрее дойти до арены).
// После — время идёт только по vb.step(): performance.now и requestAnimationFrame подменены, каждый шаг —
// ровно 1/30 с игрового времени, кадр снимается целиком. Так делали PR №14 и №22 (tools/kino_video.mjs).
//
// Зонд. THREE.Scene.prototype.onBeforeRender вызывается в начале каждого renderer.render(scene, …) — через
// него видны renderer игры (холст #ao-canvas), сцена и камера. Из них — renderer.info (вызовы, треугольники,
// текстуры, программы), источники света и частицы в кадре; для галереи — подмена камеры на фиксированный
// ракурс (одинаковый у всех веток, «до/после» сравнимы кадр в кадр).

import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const QUALITIES = ['low', 'medium', 'high'];
// герои меню в порядке карточек (modules/heroModel.js, HERO_ORDER)
export const HERO_IDS = ['ashen', 'elf', 'dark', 'ranger', 'archmage'];

export function args(argv = process.argv.slice(2)) {
  const of = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  return { of, has: (k) => argv.includes(k), argv };
}

export function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  try { tries.push(join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 'playwright')); } catch (e) { /* нет npm */ }
  for (const t of tries) { try { return req(t); } catch (e) { /* следующий */ } }
  throw new Error('playwright не найден (npm i -g playwright или PLAYWRIGHT путь)');
}

export function chromiumPath(explicit) {
  return [explicit, process.env.ASHEN_CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    .filter(Boolean).find((p) => existsSync(p));
}

// serve_game.py на свободном порту (несколько попыток: порт мог занять соседний прогон)
export async function startServer(root) {
  for (let i = 0; i < 8; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [join(root, 'serve_game.py'), '--no-browser', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = await new Promise((res) => {
      let out = '';
      const to = setTimeout(() => res(false), 10000);
      const on = (d) => { out += d; if (out.includes('running')) { clearTimeout(to); res(true); } };
      py.stdout.on('data', on); py.stderr.on('data', on);
      py.on('exit', () => { clearTimeout(to); res(false); });
    });
    if (ok) return { port, url: `http://127.0.0.1:${port}/`, kill: () => py.kill() };
    try { py.kill(); } catch (e) { /* уже вышел */ }
  }
  throw new Error('serve_game.py не запустился');
}

export async function launchBrowser(chromium, exe) {
  return chromium.launch({
    executablePath: exe,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
}

// Часы страницы (init-скрипт: до кода игры). Math.random — с зерном: один и тот же порядок атак Регента
// и разброс частиц в каждом прогоне, «до» и «после» сравнимы.
function CLOCK(seed) {
  let a = (seed >>> 0) || 1;
  Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const oRAF = window.requestAnimationFrame.bind(window);
  const oCAF = window.cancelAnimationFrame.bind(window);
  const oNow = performance.now.bind(performance);
  let virt = false, vt = 0, seq = 1;
  let q = new Map();   // id → колбэк (виртуальный режим)
  performance.now = () => (virt ? vt : oNow());
  window.requestAnimationFrame = (cb) => { if (virt) { const id = seq++; q.set(id, cb); return id; } return oRAF(cb); };
  window.cancelAnimationFrame = (id) => { if (!q.delete(id)) oCAF(id); };
  const vb = {
    realNow: oNow,
    get virtual() { return virt; },
    setVirtual(on) {
      if (on && !virt) { vt = oNow(); virt = true; }
      else if (!on && virt) { virt = false; const qq = [...q.values()]; q = new Map(); for (const cb of qq) oRAF(cb); }
      return virt;
    },
    // Шаг виртуального времени: колбэки rAF одного кадра; время JS кадра — по настоящим часам.
    // Затем ждём настоящий кадр браузера: команды WebGL доходят до программного GPU, следующий шаг
    // не упирается в очередь команд (иначе в «время JS» попадало бы время растеризации).
    step(ms, waitPresent = true) {
      vt += ms;
      const qq = [...q.values()]; q = new Map();
      const t0 = oNow();
      for (const cb of qq) { try { cb(vt); } catch (e) { console.error(e); } }
      const js = oNow() - t0;
      vb.lastJs = js;
      if (!waitPresent) return js;
      return new Promise((res) => oRAF(() => res(js)));
    },
    lastJs: 0,
  };
  window.__vb = vb;
}

// Зонд рендера: ставится после загрузки игры (import('three') — тот же модуль, что у игры, по importmap)
async function PROBE() {
  const vb = window.__vb;
  if (vb.probe) return true;
  const THREE = await import('three');
  const proto = THREE.Scene.prototype;
  const prev = proto.onBeforeRender;
  const P = { renderer: null, scene: null, camera: null, cam: null, frameScenes: new Set(), lightsMax: 0 };
  proto.onBeforeRender = function (renderer, scene, camera, target) {
    try {
      const main = renderer && renderer.domElement && renderer.domElement.id === 'ao-canvas';
      if (main) P.renderer = renderer;
      // главная сцена — самая большая из нарисованных перспективной камерой (у полноэкранных проходов — орто)
      if (main && camera && camera.isPerspectiveCamera && (!P.scene || P.scene === scene || scene.children.length > P.scene.children.length)) { P.scene = scene; P.camera = camera; }
      if (main) P.frameScenes.add(scene);
      // фиксированный ракурс (галерея): камера меняется до расчёта матриц кадра
      if (main && scene === P.scene && camera && camera.isPerspectiveCamera) {
        const c = P.cam;
        if (c) {
          if (P.fov0 == null) P.fov0 = camera.fov;
          camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
          camera.up.set(0, 1, 0);
          camera.lookAt(c.at[0], c.at[1], c.at[2]);
          const fov = c.fov || P.fov0;
          if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
          camera.updateMatrixWorld(true);
        } else if (P.fov0 != null) {
          if (camera.fov !== P.fov0) { camera.fov = P.fov0; camera.updateProjectionMatrix(); }
          P.fov0 = null;
        }
      }
    } catch (e) { /* зонд не должен ломать кадр */ }
    if (prev) return prev.call(this, renderer, scene, camera, target);
  };
  vb.probe = P;
  return true;
}

// Сводка кадра: renderer.info + свет и частицы в главной сцене (только видимые объекты)
function FRAME_STATS() {
  const P = window.__vb && window.__vb.probe;
  if (!P || !P.renderer) return null;
  const r = P.renderer, info = r.info;
  const out = {
    calls: info.render.calls, triangles: info.render.triangles, points: info.render.points, lines: info.render.lines,
    geometries: info.memory.geometries, textures: info.memory.textures,
    programs: info.programs ? info.programs.length : null,
    lights: 0, shadowLights: 0, lightTypes: {}, particles: 0, pointVerts: 0, instances: 0, sprites: 0,
    meshes: 0, scenes: P.frameScenes.size, pixelRatio: r.getPixelRatio(),
  };
  P.frameScenes.clear();
  const sc = P.scene;
  if (sc) {
    sc.traverseVisible((o) => {
      if (o.isLight) {
        if (o.isAmbientLight || o.isHemisphereLight || o.intensity > 0) {
          out.lights++;
          const t = o.type; out.lightTypes[t] = (out.lightTypes[t] || 0) + 1;
          if (o.castShadow && r.shadowMap.enabled) out.shadowLights++;
        }
        return;
      }
      if (o.isPoints) {
        const g = o.geometry, pos = g && g.attributes && g.attributes.position;
        let n = pos ? pos.count : 0;
        if (g && g.drawRange && Number.isFinite(g.drawRange.count)) n = Math.min(n, g.drawRange.count);
        if (g && g.isInstancedBufferGeometry && Number.isFinite(g.instanceCount)) n *= g.instanceCount;
        out.pointVerts += n;
      } else if (o.isInstancedMesh) out.instances += o.count;
      else if (o.isSprite) out.sprites++;
      else if (o.isMesh) {
        out.meshes++;
        const g = o.geometry;
        if (g && g.isInstancedBufferGeometry && Number.isFinite(g.instanceCount)) out.instances += g.instanceCount;
      }
    });
  }
  // частицы эффектов (effects.getDebugInfo): пулы свечения/пыли и активные элементы слоя V6
  try {
    const fx = window.__ASHEN__ && window.__ASHEN__.fx ? window.__ASHEN__.fx() : null;
    if (fx && fx.particles) out.fxParticles = (fx.particles.glow || 0) + (fx.particles.dust || 0);
    if (fx && fx.v6 && fx.v6.sub) {
      let a = 0;
      for (const k of Object.keys(fx.v6.sub)) { const s = fx.v6.sub[k]; if (s && Number.isFinite(s.active)) a += s.active; }
      out.fxActive = a;
    }
  } catch (e) { /* нет эффектов */ }
  out.particles = out.pointVerts + out.sprites + (out.fxActive || 0);
  // состояние боя в кадре: сыграло ли заклинание (действие героя, энергия, HP Регента)
  try {
    const s = window.__ASHEN__.snapshot();
    if (s) { out.energy = s.player.energy; out.bossHp = s.boss.hp; out.pAction = s.player.action; }
  } catch (e) { /* меню */ }
  return out;
}

export const pageFns = { CLOCK, PROBE, FRAME_STATS };

// Подмена ответа config.js: быстрые кадры до арены и управляемый Регент (HP, урон)
export function configPatcher({ bossHp, bossDamage, normalHp, normalDamage } = {}) {
  return async (route) => {
    const r = await route.fetch();
    let body = (await r.text())
      .replace(/maxDt:\s*1 \/ 20/, 'maxDt: 0.5').replace(/stallSec:\s*0\.25/, 'stallSec: 5');
    if (bossHp != null || bossDamage != null) {
      body = body.replace(/easy:\s*\{\s*bossHp:\s*[\d.]+,\s*bossDamage:\s*[\d.]+\s*\}/,
        `easy: { bossHp: ${bossHp ?? 0.7}, bossDamage: ${bossDamage ?? 0.7} }`);
    }
    if (normalHp != null || normalDamage != null) {
      body = body.replace(/normal:\s*\{\s*bossHp:\s*[\d.]+,\s*bossDamage:\s*[\d.]+\s*\}/,
        `normal: { bossHp: ${normalHp ?? 1}, bossDamage: ${normalDamage ?? 1} }`);
    }
    return route.fulfill({ response: r, body, headers: { ...r.headers(), 'content-type': 'text/javascript' } });
  };
}

// Новый контекст с игрой: настройки игрока, часы, подмена config.js; ждёт меню и загрузку ассетов
export async function openGame(browser, server, { size = [1280, 720], settings = {}, patch = {}, query = '?uncapped=1', seed = 20261002, log = () => {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const s = { qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0, muted: true, voice: false, ...settings };
  await ctx.addInitScript((st) => {
    try {
      localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(st));
      localStorage.setItem('ashen-oath.showcase-hint', '1');   // подсказка витрины не попадает в кадр
    } catch (e) { /* без хранилища */ }
  }, s);
  await ctx.addInitScript(CLOCK, seed);
  await ctx.route(/\/config\.js(\?.*)?$/, configPatcher(patch));
  const page = await ctx.newPage();
  page.setDefaultTimeout(240000);   // программный рендер под нагрузкой (параллельные уровни) отвечает медленно
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  const t0 = Date.now();
  await page.goto(server.url + query, { timeout: 240000, waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
  await page.waitForFunction(() => { const a = window.__ASHEN__.worldAssets(); return !a || a.pending === 0; }, null, { timeout: 180000 }).catch(() => log('ассеты мира не догрузились за 3 мин'));
  await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return !h || h.ready; }, null, { timeout: 180000 }).catch(() => log('герой не готов за 3 мин'));
  await page.evaluate(PROBE);
  await page.evaluate(`window.__vbStats = ${FRAME_STATS.toString()}`);
  log(`страница готова за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  const g = makeDriver(page, errors, log);
  return { ctx, page, errors, ...g };
}

function makeDriver(page, errors, log) {
  const FPS = 30;
  const virtual = (on) => page.evaluate((v) => window.__vb.setVirtual(v), on);
  const step = (n = 1) => page.evaluate(async ({ n, ms }) => { let js = 0; for (let i = 0; i < n; i++) js += await window.__vb.step(ms); return js; }, { n, ms: 1000 / FPS });
  // n кадров с замером каждого: { js, wall, stats }
  const sample = (n = 1) => page.evaluate(async ({ n, ms }) => {
    const FRAME = window.__vbStats;
    const out = [];
    for (let i = 0; i < n; i++) {
      const w0 = window.__vb.realNow();
      const js = await window.__vb.step(ms);
      out.push({ js, wall: window.__vb.realNow() - w0, ...(FRAME() || {}) });
    }
    return out;
  }, { n, ms: 1000 / FPS });
  const snap = () => page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return s ? { status: s.status, hp: s.boss.hp, maxHp: s.boss.maxHp, stage: s.boss.stage, bossAction: s.boss.action, energy: s.player.energy, enc: s.player.encounter, php: s.player.hp, time: s.time, fury: s.player.fury } : null; });
  const screen = () => page.evaluate(() => window.__ASHEN__.screen);
  const setCam = (cam) => page.evaluate((c) => { window.__vb.probe.cam = c; }, cam);
  const btn = (text) => page.locator('button:visible', { hasText: text }).first();
  // интерфейс поверх холста скрыт (для фиксированных ракурсов меню): видно только 3D
  const hideUi = (on) => page.evaluate((v) => {
    let st = document.getElementById('vb-noui-style');
    if (!st) { st = document.createElement('style'); st.id = 'vb-noui-style'; st.textContent = 'body.vb-noui *:not(:has(#ao-canvas)):not(#ao-canvas){visibility:hidden!important}'; document.head.appendChild(st); }
    document.body.classList.toggle('vb-noui', v);
  }, on);
  // герой в сцене: позиция корня, поворот, голова (для ракурсов анфас / 3/4 / лицо)
  const heroPose = () => page.evaluate(() => {
    const P = window.__vb.probe, root = P && P.scene ? P.scene.getObjectByName('hero') : null;
    const a = window.__ASHEN__.heroAnchors ? window.__ASHEN__.heroAnchors() : null;
    if (!root) return null;
    const v = root.getWorldPosition(new root.position.constructor());
    return { pos: [v.x, v.y, v.z], yaw: root.rotation.y, head: a && a.head ? [a.head.x, a.head.y, a.head.z] : [v.x, v.y + 1.6, v.z], chest: a && a.chest ? [a.chest.x, a.chest.y, a.chest.z] : null };
  });
  // в бой без камеры: «Отладка с клавиатуры» → «Играть» → «Продолжить без камеры» → «В бой» → облёт → бой
  // freeze: виртуальное время включается в тот же миг, когда начался бой (облёт — в «быстром» времени),
  // поэтому бой с первого кадра идёт кадр в кадр и одинаково от прогона к прогону
  async function toBattle({ freeze = true } = {}) {
    const CLICK = { timeout: 240000 };
    await page.locator('.ao-toggle', { hasText: 'Отладка с клавиатуры' }).click(CLICK);
    await btn('Играть').click(CLICK); await sleep(300);
    await btn('Продолжить без камеры').click(CLICK); await sleep(500);
    if (freeze) await page.evaluate(() => { const id = setInterval(() => { if (window.__ASHEN__.screen === 'playing') { window.__vb.setVirtual(true); clearInterval(id); } }, 3); });
    await btn('В бой').click(CLICK);
    await page.waitForFunction(() => window.__ASHEN__.screen === 'playing', null, { timeout: 300000 });
  }
  // к Регенту: W в настоящем времени (кадры по 0,5 с), до «engaged»
  async function walkToBoss() {
    const near = await page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return !!(s && s.player.encounter === 'engaged'); });
    if (near) return;   // старт у края арены: Регент уже рядом
    await virtual(false);
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => { const s = window.__ASHEN__.snapshot(); return s && s.player.encounter === 'engaged'; }, null, { timeout: 300000, polling: 250 }).catch(() => log('не дошли до Регента'));
    await page.keyboard.up('KeyW');
  }
  return { virtual, step, sample, snap, screen, setCam, btn, hideUi, heroPose, toBattle, walkToBoss, FPS };
}

// [W4-БЮДЖЕТ] Сценарии замера (tools/visual_budget.mjs) — общие с тестом dev/visualBudget.test.mjs
// Заклинания «Отладки с клавиатуры» (core/debugInput.js): hold — кадров удержания, after — кадров после
export const SPELLS = [
  { id: 'fire', key: 'KeyJ', hold: 30, after: 12, label: 'J — огонь (удержание)' },
  { id: 'burst', key: 'KeyL', after: 36, label: 'L — выброс' },
  { id: 'orb', key: 'KeyO', hold: 36, after: 30, label: 'O — сфера: слепить и бросить' },
  { id: 'gate', key: 'KeyX', hold: 45, after: 36, label: 'X — «Врата бури»' },
  { id: 'pillar', key: 'KeyG', hold: 45, after: 36, label: 'G — «Столп небес»' },
  { id: 'spark', key: 'KeyU', after: 30, label: 'U — «Искра»' },
  ...[['ignis', 'огненное копьё'], ['fulgur', 'молния'], ['orbis', 'оберег'], ['stella', 'звездопад'], ['spira', 'вихрь'],
    ['lemnis', 'вечность'], ['caret', 'залп игл'], ['vee', 'жатва'], ['clepsydra', 'время'], ['alpha', 'начало']]
    .map(([id, name], i) => ({ id: `rune_${id}`, key: i < 9 ? `Digit${i + 1}` : 'Digit0', after: 36, label: `${i < 9 ? i + 1 : 0} — руна «${name}»` })),
];
export const SCENARIOS = [
  ...HERO_IDS.map((h) => ({ id: `menu_${h}`, group: 'menu', label: `Меню: ${h}` })),
  { id: 'battle_phase1', group: 'battle', label: 'Бой, фаза 1: общий план' },
  ...SPELLS.map((s) => ({ id: s.id, group: 'battle', label: s.label })),
  { id: 'phase2_shift', group: 'boss', label: 'Регент: переход в фазу 2 (рёв)' },
  { id: 'phase2', group: 'boss', label: 'Регент, фаза 2: гроза' },
  { id: 'boss_strike', group: 'boss', label: 'Удар Регента (фаза 2)' },
  { id: 'ult', group: 'boss', label: 'U — «Небесный суд»' },
  { id: 'boss_death', group: 'boss', label: 'Гибель Регента' },
];

// Сверка результатов с бюджетом: [{ quality, scene, key, value, limit }]
export function checkBudget(results, budget) {
  const over = [];
  if (!budget) return over;
  for (const q of Object.keys(results)) {
    const B = budget[q];
    if (!B) continue;
    for (const [id, r] of Object.entries(results[q])) {
      if (id.startsWith('__')) continue;
      const group = SCENARIOS.find((s) => s.id === id)?.group;
      const lim = { ...B, ...(group && B[group] ? B[group] : {}) };
      for (const key of ['calls', 'triangles', 'lights', 'shadowLights', 'textures', 'programs', 'particles', 'jsMs']) {
        if (!Number.isFinite(lim[key]) || !Number.isFinite(r[key])) continue;
        if (r[key] > lim[key]) over.push({ quality: q, scene: id, key, value: r[key], limit: lim[key] });
      }
    }
  }
  return over;
}

// Сводка окна кадров одного сценария
export function summarize(frames) {
  const pick = (k) => frames.map((f) => f[k]).filter((v) => Number.isFinite(v));
  const max = (k) => { const a = pick(k); return a.length ? Math.max(...a) : null; };
  const med = (k) => { const a = pick(k).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const pct = (k, p) => { const a = pick(k).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
  const last = frames[frames.length - 1] || {};
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const types = {};
  for (const f of frames) for (const [t, n] of Object.entries(f.lightTypes || {})) types[t] = Math.max(types[t] || 0, n);
  return {
    frames: frames.length,
    calls: max('calls'), callsMed: med('calls'),
    triangles: max('triangles'), trianglesMed: med('triangles'),
    textures: max('textures'), geometries: max('geometries'), programs: last.programs ?? max('programs'),
    lights: max('lights'), shadowLights: max('shadowLights'), lightTypes: types,
    particles: max('particles'), pointVerts: max('pointVerts'), instances: max('instances'),
    jsMs: r1(med('js')), jsP95: r1(pct('js', 0.95)), wallMs: r1(med('wall')),
    pixelRatio: last.pixelRatio ?? null,
  };
}
