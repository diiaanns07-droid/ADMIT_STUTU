// [W4-НАРЯДЫ] Цена нарядов героинь: вызовы отрисовки, треугольники, текстуры, программы — на low и high.
// node tools/attire_budget.mjs [--root DIR] [--vendor DIR] [--heroes elf,dark,ranger] [--q low,high] [--game] [--frames 8]
//   стенд (по умолчанию): dev/hero_stand.html?a=<герой>&b=ashen&solo=1 — только героиня в кадре, кадр рендерится
//     вручную (window.__HS_API__), renderer.info после одного кадра; материалы — уникальные у видимых мешей героини;
//   --game: игра в меню выбора (витрина героя), медиана window.__ASHEN__.renderInfo() за N кадров.
// --root — корень другой копии игры (например, git worktree с main) — замер «до»; --vendor — как у tools/hero_look.mjs
// (локальные three/three-vrm, если CDN недоступен). Итог — JSON в stdout.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = resolve(argOf('--root', HERE));
const VENDOR = argOf('--vendor', process.env.ASHEN_VENDOR || '');
const HEROES = argOf('--heroes', 'elf,dark,ranger').split(',');
const QS = argOf('--q', 'low,high').split(',');
const GAME = argv.includes('--game');
const FRAMES = Number(argOf('--frames', '8'));
const BROWSER = [argOf('--browser'), '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p));
const PORT = 8000 + Math.floor(Math.random() * 700);
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

function startServer() {
  const py = spawn('python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 10000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
  });
}
async function routeVendor(ctx) {
  if (!VENDOR) return;
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/, (route) => {
    const m = route.request().url().match(/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/);
    const file = join(VENDOR, m[1] === 'three' ? `three-${m[2]}` : `pixiv-three-vrm-${m[2]}`, 'package', m[3].split('?')[0]);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } });
  });
}

const server = await startServer();
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const out = [];
try {
  for (const hero of HEROES) for (const q of QS) {
    const ctx = await browser.newContext({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    await routeVendor(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    let row;
    if (!GAME) {
      await page.goto(`http://127.0.0.1:${PORT}/dev/hero_stand.html?a=${hero}&b=ashen&solo=1&yaw=0&q=${q}`);
      await page.waitForFunction(() => window.__HS__, null, { timeout: 240000 });
      row = await page.evaluate(() => {
        const A = window.__HS_API__;
        window.__HS_MANUAL__ = true;
        for (let i = 0; i < 20; i++) A.step(1 / 30);
        const { renderer, scene, camera } = A;
        renderer.info.autoReset = true;
        renderer.render(scene, camera);
        const mats = new Set(), byPart = {};
        let meshes = 0, tris = 0;
        // деталь — ближайший именованный предок (снаряжение героя, меш костюма)
        const part = (o) => { for (let p = o; p; p = p.parent) if (p.name && !/merged$/.test(p.name) && p.name !== 'staff-holder') return p.name.replace(/-(l|r|left|right)(-grp)?$/, ''); return '?'; };
        A.a.root.traverse((o) => {
          if (!(o.isMesh || o.isPoints)) return;
          let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
          if (!vis) return;
          meshes++; [].concat(o.material).forEach((m) => mats.add(m.uuid));
          const g = o.geometry, n = o.isPoints ? 0 : g.index ? g.index.count / 3 : g.attributes.position.count / 3;
          tris += n; const k = part(o); byPart[k] = (byPart[k] || 0) + n;
        });
        const st = A.a.state();
        return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries, programs: renderer.info.programs.length, heroMeshes: meshes, heroMaterials: mats.size, heroTris: Math.round(tris), gear: st.gear.length, byPart };
      });
    } else {
      await ctx.addInitScript((s) => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify(s)); } catch (e) { /* ignore */ } }, { quality: q, qualityAuto: false, reducedMotion: false, difficulty: 'easy', volume: 0, hero });
      await page.goto(`http://127.0.0.1:${PORT}/`);
      await page.waitForFunction(() => !!window.__ASHEN__, null, { timeout: 180000 });
      await page.waitForFunction(() => { const h = window.__ASHEN__.hero(); return h && h.ready && h.gear.length > 0; }, null, { timeout: 300000 });
      await page.waitForTimeout(4000);
      row = await page.evaluate((n) => new Promise((res) => {
        const rs = [];
        const tick = () => { rs.push(window.__ASHEN__.renderInfo()); if (rs.length < n) requestAnimationFrame(tick); else res(rs); };
        requestAnimationFrame(tick);
      }), FRAMES).then((rs) => {
        const med = (k) => { const a = rs.map((r) => r[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
        return { calls: med('calls'), triangles: med('triangles'), textures: med('textures'), geometries: med('geometries'), programs: med('programs'), shadowLights: rs[0].shadowLights };
      });
    }
    out.push({ hero, q, root: ROOT === HERE ? 'branch' : ROOT, ...row, errors: errors.filter((e) => !/favicon|ERR_TUNNEL|net::/.test(e)).slice(0, 3) });
    console.error(`[budget] ${hero} ${q}: ${JSON.stringify(row)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify(out, null, 1));
