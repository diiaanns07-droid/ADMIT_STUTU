// Визуальные снимки боя для арт-проверки (Visual Bible, разд. 25).
// node tools/qa_shots.mjs [--out DIR] [--browser PATH] [--size 1600x900] [--quality medium] [--gpu] [--phase2] [--forest]
// [FOREST] --forest: после боя — ракурсы Сияющего леса и Поляны дуэлей (dev/world_tour.html), замер кадра на поляне.
// Запускает serve_game.py, входит в бой в режиме DEBUG (без камеры) и снимает несколько ракурсов.
// Кроме PNG пишет stats.json: яркость (sRGB) по зонам кадра — проверка «ни один пиксель игровой зоны
// не темнее 18–20». Это снимки headless-браузера (часто программный рендер SwiftShader), не замер FPS.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(argOf('--out', join(tmpdir(), 'ashen_shots')));
const [W, H] = argOf('--size', '1600x900').split('x').map(Number);
const QUALITY = argOf('--quality', 'medium');
const BROWSER = [argOf('--browser'), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find((p) => existsSync(p));
const PORT = 8798;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const py = spawn('python', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error('server timeout: ' + out)), 8000);
    const on = (d) => { out += d; if (out.includes('ASHEN OATH is running')) { clearTimeout(to); res(py); } };
    py.stdout.on('data', on); py.stderr.on('data', on);
    py.on('exit', (c) => rej(new Error('server exit ' + c + ' ' + out)));
  });
}

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.log = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const p = new Page(ws);
    ws.onmessage = (m) => p.on(JSON.parse(m.data));
    await p.send('Runtime.enable'); await p.send('Page.enable'); await p.send('Log.enable');
    return p;
  }
  on(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      this.log.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails; this.log.push('EXC: ' + ((d.exception && d.exception.description) || d.text));
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = await this.eval(expr); if (v) return v; } catch (e) { /* ждём */ } await sleep(200); }
    return null;
  }
  click(label) {
    return this.eval(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
  }
  async key(code, type) {
    const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code;
    await this.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  }
  async hold(code, ms) { await this.key(code, 'keyDown'); await sleep(ms); await this.key(code, 'keyUp'); }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(OUT, name + '.png'), buf);
    return buf;
  }
}

// Минимальный декодер PNG (8 бит, RGB/RGBA, без interlace) — только для статистики яркости.
function decodePNG(buf) {
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
function zoneStats(img) {
  const { w, h, bpp, px } = img;
  const zones = { top: [0, 0.33], middle: [0.33, 0.66], bottom: [0.66, 1] };
  const out = {};
  for (const [name, [y0, y1]] of Object.entries(zones)) {
    const L = [];
    // игровая зона: без полос интерфейса по краям (8% слева/справа)
    for (let y = Math.floor(h * y0); y < Math.floor(h * y1); y += 2) for (let x = Math.floor(w * 0.08); x < Math.floor(w * 0.92); x += 2) {
      const i = (y * w + x) * bpp;
      L.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    }
    L.sort((a, b) => a - b);
    const q = (t) => Math.round(L[Math.min(L.length - 1, Math.floor(t * L.length))]);
    out[name] = { p1: q(0.01), p5: q(0.05), median: q(0.5), p95: q(0.95), p99: q(0.99), mean: Math.round(L.reduce((a, b) => a + b, 0) / L.length) };
  }
  return out;
}

const server = await startServer();
const profile = join(tmpdir(), `ashen_shots_${Date.now()}`);
const dbg = 9800 + Math.floor(Math.random() * 150);
const flags = ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--window-size=${W},${H}`, '--hide-scrollbars'];
if (argv.includes('--gpu')) flags.push('--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu');
else flags.push('--enable-unsafe-swiftshader');
const proc = spawn(BROWSER, [...flags, 'about:blank'], { stdio: 'ignore' });
let list = null;
for (let i = 0; i < 60 && !list; i++) { await sleep(200); try { list = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json(); } catch (e) { /* ждём */ } }
const page = await Page.connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
const stats = {};
try {
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  if (!(await page.waitFor('!!window.__ASHEN__', 30000))) throw new Error('игра не загрузилась');
  if (QUALITY !== 'medium') await page.click({ low: 'Низкое', high: 'Высокое' }[QUALITY] || 'Среднее');
  await page.waitFor('(() => { const a = __ASHEN__.worldAssets(); return a && a.pending === 0; })()', 30000);
  await sleep(1500);
  stats.menu = zoneStats(decodePNG(await page.shot('00_menu')));
  await page.click('Отладка с клавиатуры'); await sleep(150);
  await page.click('Играть'); await sleep(200);
  await page.click('Продолжить без камеры (демо)'); await sleep(400);
  await page.shot('00b_tutorial');
  await page.click('В бой'); await sleep(700);   // интро 1,8 с
  await page.shot('01_intro');
  await page.waitFor(`__ASHEN__.screen === 'playing'`, 12000);
  await sleep(1400);
  stats.start = zoneStats(decodePNG(await page.shot('02_start')));
  stats.startState = await page.eval('({ enc: __ASHEN__.snapshot().player.encounter, pos: __ASHEN__.snapshot().player.position })');
  // [ASHEN_V2] старт снаружи арены: идём вперёд (W) до входа в бой
  await page.key('KeyW', 'keyDown');
  await page.waitFor(`__ASHEN__.snapshot().player.encounter === 'engaged'`, 9000);
  await sleep(400);
  await page.key('KeyW', 'keyUp');
  await sleep(900);
  stats.engaged = zoneStats(decodePNG(await page.shot('02b_engaged')));
  stats.engagedState = await page.eval('({ enc: __ASHEN__.snapshot().player.encounter, pos: __ASHEN__.snapshot().player.position })');
  await page.hold('KeyD', 2600); await sleep(500);
  stats.orbitRight = zoneStats(decodePNG(await page.shot('03_orbit_right')));
  await page.hold('KeyA', 5200); await sleep(500);
  stats.orbitLeft = zoneStats(decodePNG(await page.shot('04_orbit_left')));
  await page.key('KeyJ', 'keyDown'); await sleep(900);
  stats.fire = zoneStats(decodePNG(await page.shot('05_fire')));
  await page.key('KeyJ', 'keyUp');
  await sleep(1500);
  // чары: удержать O (сфера) / P (призма), отпустить — бросок
  await page.key('KeyO', 'keyDown'); await sleep(1100);
  stats.conjureOrb = await page.eval('(__ASHEN__.snapshot().player.conjure || null)');
  await page.shot('06_conjure_orb');
  await page.key('KeyO', 'keyUp'); await sleep(170);
  stats.thrownOrb = await page.eval(`__ASHEN__.snapshot().projectiles.filter((p) => p.kind === 'sphere' || p.kind === 'prism').map((p) => p.kind)`);
  await page.shot('07_throw_orb');
  await sleep(1400);
  await page.key('KeyP', 'keyDown'); await sleep(1000);
  await page.shot('08_conjure_prism');
  await page.key('KeyP', 'keyUp'); await sleep(150);
  stats.thrownPrism = await page.eval(`__ASHEN__.snapshot().projectiles.filter((p) => p.kind === 'sphere' || p.kind === 'prism').map((p) => p.kind)`);
  await page.shot('09_throw_prism');
  // [V3] печати двумя руками: Z — хлопок, X — врата, C — рамка (ждём энергию)
  const waitEnergy = async (n) => { for (let i = 0; i < 60; i++) { const e = await page.eval('__ASHEN__.snapshot().player.energy'); if (e >= n) return; await sleep(250); } };
  await waitEnergy(40);
  await page.hold('KeyZ', 60); await sleep(110);
  await page.shot('11_sigil_clap');
  await sleep(1200); await waitEnergy(45);
  await page.hold('KeyX', 60); await sleep(420);
  stats.bastion = await page.eval('__ASHEN__.snapshot().player.bastion');
  await page.shot('12_sigil_gate');
  await sleep(600); await waitEnergy(35);
  await page.hold('KeyC', 60); await sleep(500);
  stats.marked = await page.eval('__ASHEN__.snapshot().boss.marked');
  await page.shot('13_sigil_frame');
  // [V3] новые руны и рисованные печати: 4 — звездопад, 9 — клепсидра, V — дельта, B — кор
  await sleep(600); await waitEnergy(45);
  await page.hold('Digit4', 60); await sleep(650);
  await page.shot('14_rune_stella');
  await sleep(900); await waitEnergy(35);
  await page.hold('Digit9', 60); await sleep(500);
  stats.slowed = await page.eval('__ASHEN__.snapshot().boss.slowed');
  await page.shot('15_rune_clepsydra');
  await sleep(700); await waitEnergy(50);
  await page.hold('KeyV', 60); await sleep(420);
  await page.shot('16_sigil_delta');
  await sleep(1500); await waitEnergy(40);
  await page.hold('KeyB', 60); await sleep(600);
  await page.shot('17_sigil_cor');
  if (argv.includes('--phase2')) {
    // добить Регента до второй фазы (≤50% HP): огонь J + брошенные сферы O
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const st = await page.eval('(() => { const s = __ASHEN__.snapshot(); return s ? { stage: s.boss.stage, scr: __ASHEN__.screen, en: s.player.energy } : null; })()');
      if (!st || st.scr !== 'playing' || st.stage >= 2) break;
      if (st.en >= 30) { await page.key('KeyO', 'keyDown'); await sleep(900); await page.key('KeyO', 'keyUp'); await sleep(300); }
      else await page.hold('KeyJ', 1200);
    }
    await sleep(4500);
    stats.phase2 = zoneStats(decodePNG(await page.shot('10_phase2')));
    stats.phase2state = await page.eval('({ scr: __ASHEN__.screen, stage: __ASHEN__.snapshot().boss.stage, hp: __ASHEN__.snapshot().boss.hp })');
  }
  stats.render = await page.eval('({ ...__ASHEN__.renderInfo(), fps: __ASHEN__.fps, postfx: __ASHEN__.postfx, assets: __ASHEN__.worldAssets() })');
  // [FOREST] --forest: ракурсы Сияющего леса и Поляны дуэлей — стенд dev/world_tour.html (настоящий world.js + postfx)
  if (argv.includes('--forest')) {
    await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/dev/world_tour.html?q=${QUALITY}` });
    if (!(await page.waitFor('!!window.__TOUR__ && !!__TOUR__.world.forest', 60000))) throw new Error('стенд карты не загрузился или нет леса');
    await page.eval('(() => { const h = document.getElementById("hud"), b = document.getElementById("bar"); if (h) h.style.display = "none"; if (b) b.style.display = "none"; })()');
    const FOREST_SHOTS = [
      ['20_forest_gate', 'place', [14, -97, 180]],                    // у врат: вход в лес, Древо с корнем-аркой
      ['21_forest_arch', 'place', [15, -124, 180]],                   // под корнем-аркой, вид на поляну
      ['22_duel_glade', 'place', [6, -168, 90]],                      // точка дуэли A → центр
      ['23_duel_glade_b', 'place', [30, -168, -90]],                  // точка дуэли B → центр
      ['24_duel_top', 'fly', [18, 26, -128, 18, -2, -170]],           // Поляна дуэлей сверху: кольцо рун, укрытия
      ['25_forest_lake', 'place', [-4, -184, 200]],                   // берег озера, водопад
      ['26_forest_shrine', 'place', [46, -171, 100]],                 // святилище-руина
      ['27_forest_overview', 'fly', [60, 60, -90, 10, 0, -185]],      // общий вид
    ];
    stats.forest = {};
    for (const [name, kind, v] of FOREST_SHOTS) {
      if (kind === 'place') await page.eval(`(__TOUR__.fly(null), __TOUR__.place(${v.join(',')}), true)`);
      else await page.eval(`(__TOUR__.fly([${v.join(',')}]), true)`);
      await sleep(1500);
      stats.forest[name] = zoneStats(decodePNG(await page.shot(name)));
    }
    await page.eval('(__TOUR__.fly(null), __TOUR__.place(6, -168, 90), true)');
    stats.forest.bench = await page.eval('__TOUR__.bench(60, 1280, 720)');
    stats.forest.zone = await page.eval('__TOUR__.world.forest.stats()');
  }
} catch (e) {
  console.error('ОШИБКА:', e.message);
  process.exitCode = 1;
} finally {
  stats.console = page.log.slice(0, 40);
  writeFileSync(join(OUT, 'stats.json'), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats, null, 1));
  console.log('Снимки:', OUT);
  try { page.ws.close(); } catch (e) { /* ignore */ }
  proc.kill(); server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* занят */ }
}
