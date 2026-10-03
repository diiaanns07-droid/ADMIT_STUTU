// ASHEN OATH — dev/hair_shots.mjs. [W4-ВОЛОСЫ] Снимки причёсок героинь на стенде героев (dev/hero_stand.html):
// крупно спереди, сбоку, сзади, три четверти сзади, в полный рост сзади, на бегу; витрина-поворот в видео.
// Время — виртуальное (1/30 с на кадр rAF): в headless без видеокарты кадр рисуется ~1 с, а пружины волос
// должны видеть ровный шаг.
//   node dev/hair_shots.mjs --out DIR [--q low|medium|high] [--heroes elf,dark,ranger,archmage] [--size 900x900]
//                           [--views front,side,back,back34,full,run] [--video 10] [--fps 30] [--nohood]
//   node dev/hair_shots.mjs --game --out DIR [--qs low,high] [--heroes elf,dark,ranger] — бюджет в игре:
//     window.__ASHEN__.renderInfo() на витрине меню и в бою (вызовы, треугольники, текстуры, программы) → game.json
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const OUT = resolve(arg('--out', '/tmp/hair_shots'));
const [W, H] = arg('--size', '900x900').split('x').map(Number);
const Q = arg('--q', 'high');
const HEROES = arg('--heroes', 'elf,dark,ranger').split(',');
const VIEWS = arg('--views', 'front,side,back,back34,full,run').split(',').filter(Boolean);
const VIDEO = +arg('--video', '0');
const FPS = +arg('--fps', '30');
const VENDOR = join(ROOT, 'vendor', 'npm');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary', '.bin': 'application/octet-stream', '.webp': 'image/webp' };
function serve() {
  return new Promise((res) => {
    const srv = createServer(async (req, rsp) => {
      try {
        const u = new URL(req.url, 'http://x');
        let p = join(ROOT, decodeURIComponent(u.pathname));
        const s = await stat(p).catch(() => null);
        if (s && s.isDirectory()) p = join(p, 'index.html');
        const data = await readFile(p);
        rsp.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' }); rsp.end(data);
      } catch (e) { rsp.writeHead(404); rsp.end(); }
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}
// RoomEnvironment нет в vendor/ (игре не нужен): стенду — простая комната с панелями света
const ROOM_ENV = `import { Scene, BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, BackSide, PointLight } from 'three';
export class RoomEnvironment extends Scene {
  constructor() {
    super();
    const box = new BoxGeometry();
    const room = new Mesh(box, new MeshStandardMaterial({ side: BackSide, color: 0x808080, roughness: 1 }));
    room.position.set(-0.757, 13.219, 0.717); room.scale.set(31.713, 28.305, 28.591); this.add(room);
    const pl = new PointLight(0xffffff, 900, 28, 2); pl.position.set(0.418, 16.199, 0.3); this.add(pl);
    const panel = (k, p, s) => { const m = new MeshBasicMaterial(); m.color.setScalar(k); const o = new Mesh(box, m); o.position.set(...p); o.scale.set(...s); this.add(o); };
    panel(50, [-16.116, 14.37, 8.208], [0.1, 2.428, 2.739]);
    panel(50, [-16.109, 18.021, -8.207], [0.1, 2.425, 2.751]);
    panel(17, [14.904, 12.198, -1.832], [0.15, 4.265, 6.331]);
    panel(43, [-0.462, 8.89, 14.52], [4.38, 5.441, 0.088]);
    panel(20, [3.235, 11.486, -12.541], [2.5, 2.0, 0.1]);
    panel(100, [0.0, 20.0, 0.0], [1.0, 0.1, 1.0]);
  }
}`;
function cdnToLocal(url) {
  const m = url.match(/cdn\.jsdelivr\.net\/npm\/three@[^/]+\/(.*)$/);
  if (m) { const p = join(VENDOR, 'three@0.185.1', m[1]); return existsSync(p) ? p : p.replace(/\.js$/, '.min.js'); }
  const v = url.match(/cdn\.jsdelivr\.net\/npm\/@pixiv\/three-vrm@[^/]+\/(.*)$/);
  if (v) return join(VENDOR, '@pixiv', 'three-vrm@3.5.5', v[1]);
  return null;
}
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/node22/lib/node_modules/playwright'); }
const srv = await serve();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await pw.chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const log = (...a) => console.error('[hair]', ...a);
const report = { quality: Q, heroes: {} };

// виды камеры: смещение от головы (в осях героя: x — влево героя, y — вверх, z — вперёд) и точка взгляда
const CAMS = {
  front: { off: [0.06, 0.02, 0.78], look: [0, -0.06, 0] },
  side: { off: [0.8, 0.0, 0.05], look: [0, -0.1, 0] },
  back: { off: [0.0, 0.05, -0.85], look: [0, -0.12, 0] },
  back34: { off: [-0.6, 0.12, -0.62], look: [0, -0.12, 0] },
  full: { off: [0.0, -0.35, -2.6], look: [0, -0.62, 0] },
  run: { off: [0.75, 0.0, -0.55], look: [0, -0.15, 0] },
};

async function openHero(hero) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + (e && e.message)));
  await page.route(/cdn\.jsdelivr\.net|fonts\.googleapis|fonts\.gstatic|storage\.googleapis/, async (route) => {
    if (/RoomEnvironment\.js$/.test(route.request().url())) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: ROOM_ENV });
    const local = cdnToLocal(route.request().url());
    if (local && existsSync(local)) route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(local) });
    else route.fulfill({ status: 404, body: '' });
  });
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const pn = performance.now.bind(performance);
    let t = pn();
    performance.now = () => t;
    window.__frames = 0;
    // __hold — цикл стенда стоит (снимки рисуются вручную): не грузит SwiftShader лишними кадрами
    window.requestAnimationFrame = (cb) => (window.__hold ? 0 : raf(() => { t += 1000 / 30; window.__frames++; cb(t); }));
  });
  const clip = arg('--clip', '');
  await page.goto(`${base}/dev/hero_stand.html?a=${hero}&b=archmage&solo=1&yaw=0&q=${Q}${clip ? '&clip=' + clip : ''}`, { waitUntil: 'load', timeout: 180000 });
  await page.addStyleTag({ content: '#info{display:none!important}' });
  await page.waitForFunction(() => window.__HS_API__ && window.__HS_API__.a.ready, null, { timeout: 240000 });
  // ручной шаг: сцена стоит, пока мы не шагнём (кадр rAF только рисует)
  await page.evaluate(() => { window.__HS_MANUAL__ = true; window.__hold = true; });
  // --eval 'js': QA — код в странице после загрузки героя (A = __HS_API__; волосы: mesh.userData.hair — юниформы)
  if (arg('--eval', '')) await page.evaluate(async (code) => { const A = window.__HS_API__; let hairU = null; A.a.root.traverse((o) => { if (o.userData && o.userData.hair && !hairU) hairU = o.userData.hair; }); const AF = Object.getPrototypeOf(async function () {}).constructor; await new AF('A', 'hairU', code)(A, hairU); }, arg('--eval', ''));
  // --showcase: свет витрины меню (HERO_LIGHT, как heroShowcase: ключ тёплый спереди-сбоку, контровой сзади-слева)
  if (argv.includes('--showcase')) await page.evaluate(async () => {
    const m = await import('/modules/heroShading.js'), L = m.HERO_LIGHT;
    if (!L.heroKeyColor.value) return;
    L.heroKeyColor.value.setRGB(1.0, 0.82, 0.66).multiplyScalar(1.45 * 1.3); L.heroRimColor.value.setRGB(0.62, 0.78, 1.0).multiplyScalar(1.4); L.heroFillColor.value.setRGB(0.36, 0.4, 0.52).multiplyScalar(0.3);
    L.heroKeyDir.value.set(0.55, 0.45, 0.7).normalize(); L.heroRimDir.value.set(-0.55, 0.35, -0.75).normalize();
    // источники стенда — приглушить (в меню основной свет героя — эти юниформы)
    window.__HS_API__.scene.traverse((o) => { if (o.isLight) o.intensity *= 0.35; });
  });
  // --nohood: QA — капюшон скрыт (что под ним)
  if (argv.includes('--nohood')) await page.evaluate(() => { window.__HS_API__.a.root.traverse((o) => { if (o.isMesh && /Hood/i.test(o.name)) o.visible = false; }); });
  return { ctx, page, errors };
}

// шаг стенда: n кадров по 1/30 с; fn(i) — подготовка кадра (поза, рысканье)
async function stepN(page, n, kind = 'idle', t0 = 0) {
  await page.evaluate(([n, kind, t0]) => {
    const A = window.__HS_API__;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / 30;
      const s = A.snapA.player;
      if (kind === 'run') { s.velocity = { x: Math.sin(s.yaw) * 4.5, z: Math.cos(s.yaw) * 4.5 }; }
      else if (kind === 'turn') {
        // витрина: разворот с разгоном и остановками — пряди должны качнуться и успокоиться
        const T = 10, ph = (t % T) / T;
        const e = (x) => x * x * (3 - 2 * x);
        s.yaw = ph < 0.45 ? Math.PI * 2 * 0.5 * e(ph / 0.45) : ph < 0.55 ? Math.PI : Math.PI + Math.PI * e((ph - 0.55) / 0.45);
        s.velocity = { x: 0, z: 0 };
      } else s.velocity = { x: 0, z: 0 };
      A.step(1 / 30);
    }
  }, [n, kind, t0]);
}

async function aim(page, view, yaw = 0) {
  return page.evaluate(([c, yaw]) => {
    const A = window.__HS_API__, THREE = A.THREE;
    A.scene.updateMatrixWorld(true);
    const h = new THREE.Vector3(); A.a.getAnchors().head.getWorldPosition(h);
    const L = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), F = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), U = new THREE.Vector3(0, 1, 0);
    const at = (o) => h.clone().addScaledVector(L, o[0]).addScaledVector(U, o[1]).addScaledVector(F, o[2]);
    A.camera.position.copy(at(c.off)); A.camera.lookAt(at(c.look));
    A.camera.fov = c.off[2] < -2 ? 30 : 32; A.camera.updateProjectionMatrix();
    return { head: h.toArray().map((x) => +x.toFixed(3)) };
  }, [CAMS[view], yaw]);
}

async function frameShot(page, file) {
  // рисуем вручную и забираем буфер в той же задаче (preserveDrawingBuffer не нужен)
  const url = await page.evaluate(() => { const A = window.__HS_API__; A.renderer.render(A.scene, A.camera); return A.renderer.domElement.toDataURL('image/jpeg', 0.92); });
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}

// ---------------------------------------------------------------- бюджет в игре (меню-витрина и бой)
async function gameBudget() {
  const QS = arg('--qs', 'low,high').split(',');
  const out = {};
  for (const q of QS) for (const hero of HEROES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { hero, quality: q, qualityAuto: false });
    await ctx.addInitScript(() => {
      let t = 0; const raf = window.requestAnimationFrame.bind(window);
      performance.now = () => t;
      window.requestAnimationFrame = (cb) => raf(() => { t += 1000 / 30; cb(t); });
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e && e.message).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    const frames = async (n) => { const t0 = await page.evaluate(() => performance.now()); await page.waitForFunction((t) => performance.now() >= t, t0 + (n * 1000) / 30, { timeout: 600000, polling: 200 }); };
    const rec = { errs };
    try {
      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 180000 });
      await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
      await page.waitForFunction(() => { const a = __ASHEN__.worldAssets(); return a && a.pending === 0; }, null, { timeout: 180000 }).catch(() => {});
      await page.waitForFunction(() => { const h = __ASHEN__.hero(); return h && h.ready; }, null, { timeout: 240000 }).catch(() => errs.push('hero not ready'));
      await frames(60);
      rec.menu = await page.evaluate(() => __ASHEN__.renderInfo());
      rec.menuHero = await page.evaluate(() => { const h = __ASHEN__.hero(); return h ? { gear: h.gear, gearMs: h.gearMs } : null; });
      await page.screenshot({ path: join(OUT, `game_${hero}_${q}_menu.jpg`), type: 'jpeg', quality: 88, timeout: 180000 });
      // витрина крупно: колесо над героем (лицо и причёска), затем перетаскиванием — разворот спиной
      if (!argv.includes('--nozoom')) {
        await page.mouse.move(1280 * 0.66, 720 * 0.45);
        for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -300); await frames(2); }
        await frames(70);
        await page.screenshot({ path: join(OUT, `game_${hero}_${q}_zoom.jpg`), type: 'jpeg', quality: 90, timeout: 180000 });
        await page.mouse.down();
        for (let i = 1; i <= 14; i++) { await page.mouse.move(1280 * 0.66 + i * 1280 * 0.035, 720 * 0.45); await frames(1); }
        await page.mouse.up();
        await frames(40);
        await page.screenshot({ path: join(OUT, `game_${hero}_${q}_zoom_turn.jpg`), type: 'jpeg', quality: 90, timeout: 180000 });
      }
      const click = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === l); if (b) b.click(); return !!b; }, label);
      await click('Отладка с клавиатуры'); await sleep(150);
      await click('Играть'); await sleep(250);
      await click('Продолжить без камеры (демо)'); await sleep(400);
      await click('В бой');
      await page.waitForFunction(() => __ASHEN__.screen === 'playing', null, { timeout: 60000 }).catch(() => errs.push('no battle'));
      await frames(60);
      rec.battle = await page.evaluate(() => __ASHEN__.renderInfo());
      await page.screenshot({ path: join(OUT, `game_${hero}_${q}_battle.jpg`), type: 'jpeg', quality: 88, timeout: 180000 });
    } catch (e) { rec.error = String(e && e.message).slice(0, 300); }
    out[`${hero}:${q}`] = rec;
    log('game', hero, q, JSON.stringify({ menu: rec.menu, battle: rec.battle }));
    await ctx.close();
  }
  writeFileSync(join(OUT, 'game.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (argv.includes('--game')) { await gameBudget(); await browser.close(); srv.close(); process.exit(0); }
// --budget: вклад причёски на стенде — кадр с волосами и без (вызовы, треугольники; тень включена),
// программы и текстуры материалов волос → budget.json (и до, и после: имена мешей волос обеих версий)
if (argv.includes('--budget')) {
  const QS = arg('--qs', 'low,medium,high').split(','), out = {};
  for (const q of QS) for (const hero of HEROES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.route(/cdn\.jsdelivr\.net/, async (route) => {
      if (/RoomEnvironment\.js$/.test(route.request().url())) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: ROOM_ENV });
      const local = cdnToLocal(route.request().url());
      if (local && existsSync(local)) route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: await readFile(local) });
      else route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${base}/dev/hero_stand.html?a=${hero}&b=archmage&solo=1&yaw=0&q=${q}`, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.__HS_API__ && window.__HS_API__.a.ready && window.__HS_API__.b.ready, null, { timeout: 240000 });
    out[`${hero}:${q}`] = await page.evaluate(() => {
      const A = window.__HS_API__, r = A.renderer;
      window.__HS_MANUAL__ = true;
      A.b.root.visible = false;
      for (let i = 0; i < 10; i++) A.step(1 / 30);
      A.camera.position.set(0, 1.5, 2.2); A.camera.lookAt(0, 1.3, 0);
      const HAIR = /^(hair-mesh|hair-sheet|hair-cap-mesh|hair-core|hair-soft)$/;
      const hair = []; A.a.root.traverse((o) => { if (o.isMesh && HAIR.test(o.name)) hair.push(o); });
      const shot = () => { r.render(A.scene, A.camera); return { calls: r.info.render.calls, triangles: r.info.render.triangles }; };
      shot();
      const vis = hair.map((o) => o.visible);
      const on = shot();
      hair.forEach((o) => { o.visible = false; });
      const off = shot();
      hair.forEach((o, i) => { o.visible = vis[i]; });
      const progs = new Set(), texs = new Map(), mats = new Set();
      for (const o of hair) {
        if (!o.visible) continue;
        for (const m of [o.material, o.customDepthMaterial].flat().filter(Boolean)) {
          mats.add(m.name || m.type);
          const pr = r.properties.get(m); if (pr && pr.currentProgram) progs.add(pr.currentProgram.id);
          for (const k of ['map', 'alphaMap', 'bumpMap']) if (m[k] && m[k].image) texs.set(m[k].uuid, `${m[k].image.width}x${m[k].image.height}`);
        }
      }
      return { calls: on.calls - off.calls, triangles: on.triangles - off.triangles, meshes: hair.filter((o) => o.visible).map((o) => o.name + (o.castShadow ? '+тень' : '')), materials: [...mats], programs: progs.size, textures: [...texs.values()], frame: on, cpuMs: (() => { for (let i = 0; i < 120; i++) { A.snapA.player.yaw += 0.03; A.a.update(1 / 60, A.snapA, []); } const g = A.a.state().gearMs; return g ? g.hair : null; })() };
    });
    log('budget', hero, q, JSON.stringify(out[`${hero}:${q}`]));
    await page.close();
  }
  writeFileSync(join(OUT, 'budget.json'), JSON.stringify(out, null, 1));
  await browser.close(); srv.close(); process.exit(0);
}
// --atlas: атлас прядей (RGB на сером и альфа) → atlas.png
if (argv.includes('--atlas')) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  await page.goto(`${base}/dev/hero_stand.html?solo=1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const url = await page.evaluate(async () => {
    const m = await import('/modules/heroHair.js');
    const N = 1024, d = m.hairAtlasData(N);
    const cv = document.createElement('canvas'); cv.width = N * 2; cv.height = N; const g = cv.getContext('2d');
    g.fillStyle = '#556'; g.fillRect(0, 0, N, N);
    const im = new ImageData(new Uint8ClampedArray(d), N, N);
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = N; tmp.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(tmp, 0, 0);
    const a = new Uint8ClampedArray(d.length); for (let i = 0; i < d.length; i += 4) { a[i] = a[i + 1] = a[i + 2] = d[i + 3]; a[i + 3] = 255; }
    tmp.getContext('2d').putImageData(new ImageData(a, N, N), 0, 0); g.drawImage(tmp, N, 0);
    return cv.toDataURL('image/png');
  });
  writeFileSync(join(OUT, 'atlas.png'), Buffer.from(url.split(',')[1], 'base64'));
  await browser.close(); srv.close(); process.exit(0);
}

for (const hero of HEROES) {
  const t0 = Date.now();
  const { ctx, page, errors } = await openHero(hero);
  const rec = { views: [], errors };
  await stepN(page, 45);
  for (const view of VIEWS) {
    if (view === 'run') {
      await stepN(page, 40, 'run');
      await aim(page, 'run', 0);
      await frameShot(page, join(OUT, `${hero}_run_a.jpg`));
      await stepN(page, 7, 'run');
      await aim(page, 'run', 0);
      await frameShot(page, join(OUT, `${hero}_run_b.jpg`));
      await stepN(page, 45, 'idle');
      rec.views.push('run');
      continue;
    }
    await aim(page, view, 0);
    await frameShot(page, join(OUT, `${hero}_${view}.jpg`));
    rec.views.push(view);
  }
  rec.info = await page.evaluate(() => {
    const A = window.__HS_API__, r = A.renderer;
    return { calls: r.info.render.calls, triangles: r.info.render.triangles, textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: r.info.programs.length, state: A.a.state() };
  });
  if (VIDEO > 0) {
    const dir = join(OUT, `${hero}_frames`);
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const n = Math.round(VIDEO * FPS);
    for (let i = 0; i < n; i++) {
      await stepN(page, 30 / FPS, 'turn', i / FPS);
      await aim(page, 'front', 0);
      // камера чуть дальше и выше: голова и плечи с волосами по спине
      await page.evaluate(() => { const A = window.__HS_API__; A.camera.position.multiplyScalar(1); A.camera.translateZ(0.45); A.camera.translateY(-0.08); });
      await frameShot(page, join(dir, String(i).padStart(4, '0') + '.jpg'));
      if (i % 30 === 0) log(hero, 'video frame', i, '/', n);
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'slow', join(OUT, `${hero}_turn.mp4`)]);
    rec.video = `${hero}_turn.mp4`;
  }
  rec.sec = Math.round((Date.now() - t0) / 1000);
  report.heroes[hero] = rec;
  log(hero, 'done', rec.sec, 's', JSON.stringify(rec.info));
  await ctx.close();
}
console.log(JSON.stringify(report, null, 1));
await browser.close(); srv.close();
