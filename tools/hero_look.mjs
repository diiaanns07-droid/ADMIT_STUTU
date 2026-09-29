// [HERO] Быстрый осмотр героя на стенде: один запуск dev/hero_stand.html → лист ракурсов (PNG).
// node tools/hero_look.mjs --vendor DIR --out DIR --url 'dev/hero_stand.html?a=ashen&solo=1&yaw=0' \
//   [--steps 60] [--views front,back,side,left,face,handR,handL,q3] [--size 420x560] [--name sheet]
//   [--run 'js'] — выполнить код в странице перед шагами (доступен window.__HS_API__)
// Время стенда идёт вручную (step(1/30) × steps): SwiftShader даёт ~1 кадр/с, а так поза детерминирована.
// Ракурсы считаются от героя A (позиция и поворот его root). Итог: DIR/<name>.png — ракурсы в ряд.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(ROOT, 'dev', 'scratch')));
const VENDOR = argOf('--vendor', process.env.ASHEN_VENDOR || '');
const BROWSER = [argOf('--browser'), '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p));
const [VW, VH] = argOf('--size', '420x560').split('x').map(Number);
const URLS = argv.flatMap((a, i) => (a === '--url' ? [argv[i + 1]] : []));
const NAMES = argv.flatMap((a, i) => (a === '--name' ? [argv[i + 1]] : []));
const VIEWS = argOf('--views', 'front,back,side,handR').split(',');
const STEPS = Number(argOf('--steps', '60'));
const RUN = argOf('--run', '');
const PORT = 8000 + Math.floor(Math.random() * 700);
mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

function startServer() {
  const py = spawn(process.platform === 'win32' ? 'python' : 'python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 10000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
  });
}
const MIME = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json' };
async function routeVendor(ctx) {
  if (!VENDOR) return;
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/, (route) => {
    const m = route.request().url().match(/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/);
    const dir = m[1] === 'three' ? `three-${m[2]}` : `pixiv-three-vrm-${m[2]}`;
    const file = join(VENDOR, dir, 'package', m[3].split('?')[0]);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
    route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': MIME[file.split('.').pop()] || 'application/octet-stream', 'access-control-allow-origin': '*' } });
  });
}

const server = await startServer();
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (let u = 0; u < URLS.length; u++) {
    const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
    await routeVendor(ctx);
    const page = await ctx.newPage();
    const log = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => log.push('EXC: ' + e.message));
    await page.goto(`http://127.0.0.1:${PORT}/${URLS[u]}`);
    await page.waitForFunction(() => window.__HS__, null, { timeout: 240000 });
    const data = await page.evaluate(async ({ views, steps, run, W, H }) => {
      const A = window.__HS_API__;
      const { THREE, camera, renderer, scene } = A;
      window.__HS_MANUAL__ = true;
      if (run) (0, eval)(run);
      for (let i = 0; i < steps; i++) A.step(1 / 30);
      const hero = A.a.root;
      scene.updateMatrixWorld(true);
      const hp = hero.getWorldPosition(new THREE.Vector3());
      const yaw = hero.rotation.y;
      const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), r = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
      const anc = A.a.getAnchors();
      const at = (o) => o.getWorldPosition(new THREE.Vector3());
      const P = (fw, rt, up) => hp.clone().addScaledVector(f, fw).addScaledVector(r, rt).setY(hp.y + up);
      const V = {
        front: [P(3.3, 0.35, 1.05), P(0, 0, 0.92)],
        back: [P(-3.3, -0.35, 1.2), P(0, 0, 0.95)],
        side: [P(0.5, 3.2, 1.1), P(0, 0, 0.92)],
        left: [P(0.5, -3.2, 1.1), P(0, 0, 0.92)],
        q3: [P(2.0, 1.6, 1.5), P(0, 0, 1.15)],
        q3b: [P(-2.0, 1.8, 1.5), P(0, 0, 1.1)],
        face: [P(0.85, 0.2, 1.62), P(0, 0, 1.55)],
        upper: [P(1.7, 0.3, 1.45), P(0, 0, 1.25)],
        low: [P(1.8, 0.8, 0.35), P(0, 0, 1.0)],
        top: [P(0.9, 0.2, 3.4), P(0, 0, 0.9)],
      };
      const handView = (o, side) => { const p = at(o); return [p.clone().addScaledVector(f, 0.45).addScaledVector(r, side * 0.35).add(new THREE.Vector3(0, 0.12, 0)), p]; };
      V.handR = handView(anc.handR, 1);
      V.handL = handView(anc.handL, -1);
      V.staff = [P(1.6, 1.2, 1.6), anc.staffTip.parent ? at(anc.staffTip).lerp(hp.clone().setY(hp.y + 1.0), 0.5) : P(0, 0, 1.2)];
      const cv = document.createElement('canvas');
      cv.width = W * views.length; cv.height = H;
      const g = cv.getContext('2d');
      const size = renderer.getSize(new THREE.Vector2());
      renderer.setSize(W, H, false);
      const asp = camera.aspect, fov = camera.fov;
      camera.aspect = W / H;
      for (let i = 0; i < views.length; i++) {
        const v = V[views[i]] || V.front;
        camera.fov = /^hand|face/.test(views[i]) ? 28 : 32;
        camera.updateProjectionMatrix();
        camera.position.copy(v[0]); camera.lookAt(v[1]);
        renderer.render(scene, camera);
        g.drawImage(renderer.domElement, i * W, 0, W, H);
        g.fillStyle = '#fff'; g.font = '13px sans-serif'; g.fillText(views[i], i * W + 6, H - 8);
      }
      camera.aspect = asp; camera.fov = fov; camera.updateProjectionMatrix();
      renderer.setSize(size.x, size.y, false);
      return { png: cv.toDataURL('image/png'), state: A.a.state() };
    }, { views: VIEWS, steps: STEPS, run: RUN, W: VW, H: VH });
    const name = NAMES[u] || `look_${u}`;
    writeFileSync(join(OUT, name + '.png'), Buffer.from(data.png.split(',')[1], 'base64'));
    console.log(name, JSON.stringify({ act: data.state.act, loco: data.state.loco, gear: data.state.gear, pose: data.state.pose }), log.slice(0, 12).join('\n'));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
