// [W4-НАРЯДЫ] Видео нарядов героинь на стенде (dev/hero_stand.html): по ~5 с на героиню — стойка и облёт,
// бег по дуге (ткань отдувает назад), рывок (всплеск полы и плаща, остаточные образы), выброс магии
// (вспышка вышивки и искр), затихание. Время стенда идёт вручную по 1/fps с (SwiftShader даёт ~1 кадр/с),
// кадр — снимок холста рендера, склейка — ffmpeg.
// node tools/attire_video.mjs [--vendor DIR] [--heroes elf,dark,ranger] [--sec 5] [--fps 30] [--size 1280x720]
//   [--q high] [--calm] («Уменьшенное движение») [--out docs/video/attire.mp4]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const VENDOR = argOf('--vendor', process.env.ASHEN_VENDOR || '');
const HEROES = argOf('--heroes', 'elf,dark,ranger').split(',');
const SEC = +argOf('--sec', '5'), FPS = +argOf('--fps', '30'), Q = argOf('--q', 'high');
const [W, H] = argOf('--size', '1280x720').split('x').map(Number);
const CALM = argv.includes('--calm');
const OUT = resolve(argOf('--out', join(ROOT, 'docs/video/attire.mp4')));
const FR = join(tmpdir(), `attire_frames_${process.pid}`);
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
mkdirSync(FR, { recursive: true }); mkdirSync(dirname(OUT), { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ executablePath: BROWSER, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
let n = 0;
try {
  for (const hero of HEROES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    if (VENDOR) await ctx.route(/cdn\.jsdelivr\.net\/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/, (route) => {
      const m = route.request().url().match(/npm\/(three|@pixiv\/three-vrm)@([^/]+)\/(.*)$/);
      const file = join(VENDOR, m[1] === 'three' ? `three-${m[2]}` : `pixiv-three-vrm-${m[2]}`, 'package', m[3].split('?')[0]);
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
      route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('EXC', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/dev/hero_stand.html?a=${hero}&b=ashen&solo=1&yaw=0&q=${Q}`);
    await page.waitForFunction(() => window.__HS__, null, { timeout: 240000 });
    if (CALM) await page.evaluate(() => import('../modules/heroGear.js').then((m) => m.configureGear({ reducedMotion: true })));
    await page.evaluate(() => {
      const A = window.__HS_API__;
      window.__HS_MANUAL__ = true;
      const s = A.snapA, P = s.player;
      P.position = { x: 0, y: 0, z: 0 }; P.yaw = 0.4; P.velocity = { x: 0, z: 0 };
      for (let i = 0; i < 30; i++) A.a.update(1 / 30, s, []);
      window.__AV__ = { t: 0, cam: new A.THREE.Vector3(), look: new A.THREE.Vector3(), init: false };
    });
    const total = Math.round(SEC * FPS);
    for (let f = 0; f < total; f++) {
      const url = await page.evaluate(({ f, total, fps }) => {
        const A = window.__HS_API__, V = window.__AV__, THREE = A.THREE, s = A.snapA, P = s.player, dt = 1 / fps;
        const u = f / total, ev = [];
        // сценарий: 0–0,24 стойка, 0,24–0,6 бег по дуге, 0,6 — рывок, 0,72 — выброс магии, дальше — стойка
        let sp = 0;
        if (u > 0.24 && u < 0.6) sp = 4.6 * Math.min(1, (u - 0.24) / 0.05);
        if (u >= 0.6 && u < 0.66) sp = 10;
        if (u >= 0.66 && u < 0.7) sp = 2;
        if (u > 0.24 && u < 0.66) P.yaw += dt * 0.55;
        if (f === Math.round(total * 0.6)) ev.push({ type: 'player_dash', data: { worldDirection: { x: Math.sin(P.yaw), z: Math.cos(P.yaw) } } });
        if (f === Math.round(total * 0.72)) ev.push({ type: 'burst', data: {} });
        P.velocity = { x: Math.sin(P.yaw) * sp, z: Math.cos(P.yaw) * sp };
        P.position = { x: P.position.x + P.velocity.x * dt, y: 0, z: P.position.z + P.velocity.z * dt };
        P.action = 'idle';
        A.a.update(dt, s, ev);
        // камера: спереди-сбоку героини, плавно догоняет; в стойке — медленный облёт
        const side = 0.75 + 0.45 * Math.sin(u * Math.PI * 2);
        const look = new THREE.Vector3(P.position.x, 1.0, P.position.z);
        if (!V.init) { V.look.copy(look); V.yaw = P.yaw; V.init = true; }
        V.look.lerp(look, 0.3); V.yaw += (P.yaw - V.yaw) * 0.08;
        A.camera.position.set(V.look.x + Math.sin(V.yaw + side) * 3.5, 1.38, V.look.z + Math.cos(V.yaw + side) * 3.5);
        A.camera.lookAt(V.look);
        A.renderer.render(A.scene, A.camera);
        return A.renderer.domElement.toDataURL('image/jpeg', 0.9);
      }, { f, total, fps: FPS });
      writeFileSync(join(FR, `${String(n++).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
      if (f % 30 === 0) console.error(`[attire_video] ${hero} ${f}/${total}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(FR, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', OUT]);
rmSync(FR, { recursive: true, force: true });
console.log(OUT);
