// Браузерная проверка онлайн-дуэли (№2 [NET]) — Playwright, две страницы в DEBUG.
//   node tools/qa_net.mjs [--mode local|lan] [--ping 150] [--loss 0.05] [--out DIR] [--browser PATH] [--cdn DIR]
// local: две вкладки одного браузера (BroadcastChannel). lan: два отдельных браузерных контекста
//        и tools/relay.py (запускается сам на свободном порту).
// Хост ходит на W и стреляет «Искрой» (U); гость должен видеть движение без телепортов, анимацию
// и снаряды. Потом «выдёргиваем провод» на 4 с: оба видят «lost», затем связь восстанавливается.
// --cdn DIR — офлайн-кэш npm-пакетов (three-0.185.1/package, pixiv-three-vrm-3.5.5/package,
// peerjs-1.5.5/package): запросы к cdn.jsdelivr.net отдаются оттуда (для машин без доступа к CDN).
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MODE = arg('--mode', 'local');
const PING = +arg('--ping', 150);
const LOSS = +arg('--loss', 0.05);
const OUT = resolve(arg('--out', join(tmpdir(), 'ashen_qa_net')));
const CDN = arg('--cdn', process.env.ASHEN_CDN_DIR || '');
const BROWSER = arg('--browser', ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)));
mkdirSync(OUT, { recursive: true });

let playwright;
try { playwright = await import('playwright'); }
catch (e) {
  const req = createRequire(join(process.execPath, '..', '..', 'lib', 'node_modules', 'x'));
  playwright = req('playwright');
}
const { chromium } = playwright;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`;
  results.push(line); console.log(line);
  if (!ok) failures++;
}

function startProc(cmd, args, readyText) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let out = '';
    const to = setTimeout(() => rej(new Error(`${cmd} timeout: ${out}`)), 8000);
    const on = (d) => { out += d; if (out.includes(readyText)) { clearTimeout(to); res(p); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', (c) => rej(new Error(`${cmd} exit ${c} ${out}`)));
  });
}

const PORT = 8700 + Math.floor(Math.random() * 60);   // случайный: параллельные прогоны не мешают
const RELAY_PORT = 18000 + Math.floor(Math.random() * 900);
const server = await startProc('python3', [join(ROOT, 'serve_game.py'), '--no-browser', '--port', String(PORT)], 'ASHEN OATH is running');
let relay = null;
if (MODE === 'lan') relay = await startProc('python3', [join(ROOT, 'tools', 'relay.py'), '--port', String(RELAY_PORT)], 'ASHEN relay');
// peer: свой PeerServer (npm-пакет peer) — --peer-server путь/к/node_modules/.bin/peerjs; без него — облако 0.peerjs.com
const PEER_BIN = arg('--peer-server', '');
const PEER_PORT = 9017;
if (MODE === 'peer' && PEER_BIN) relay = await startProc(PEER_BIN, ['--port', String(PEER_PORT), '--host', '127.0.0.1', '--path', '/'], 'Started PeerServer');

const CDN_MAP = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.185\.1\/(.*)$/, 'three-0.185.1/package/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@pixiv\/three-vrm@3\.5\.5\/(.*)$/, 'pixiv-three-vrm-3.5.5/package/'],
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/peerjs@1\.5\.5\/(.*)$/, 'peerjs-1.5.5/package/'],
];
async function routeCdn(ctx) {
  if (!CDN) return;
  // всё внешнее: CDN — из офлайн-кэша, прочее — без сети (офлайн-прогон не должен висеть на прокси)
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => {
    const u = route.request().url();
    for (const [re, dir] of CDN_MAP) {
      const m = u.match(re);
      if (m) {
        const f = join(CDN, dir, m[1].split('?')[0]);
        if (existsSync(f)) return route.fulfill({ status: 200, body: readFileSync(f), contentType: f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
      }
    }
    return route.abort();
  });
}

const browser = await chromium.launch({ executablePath: BROWSER, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctxA = await browser.newContext({ viewport: { width: 640, height: 380 } });
const ctxB = MODE !== 'local' ? await browser.newContext({ viewport: { width: 640, height: 380 } }) : ctxA;
await routeCdn(ctxA); if (ctxB !== ctxA) await routeCdn(ctxB);
// софтверный GPU медленный: качество low (одиночная игра игрока этим не затрагивается — отдельный профиль)
for (const c of new Set([ctxA, ctxB])) await c.addInitScript(() => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low' })); } catch (e) { /* ignore */ } });

const errors = { A: [], B: [] };
// --harness: лёгкий стенд dev/net-harness.html — плавность соперника при пинге/потерях на любом GPU
if (argv.includes('--harness')) {
  const pg = await ctxA.newPage();
  await pg.setViewportSize({ width: 1100, height: 380 });
  pg.on('pageerror', (e) => errors.A.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errors.A.push(m.text()); });
  const extra = MODE === 'peer' ? `&net=peer${PEER_BIN ? `&peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0` : ''}` : MODE === 'lan' ? `&net=lan&lanHost=127.0.0.1:${RELAY_PORT}` : '';
  await pg.goto(`http://127.0.0.1:${PORT}/dev/net-two-tabs.html?harness=1&ping=${PING}&loss=${LOSS}${extra}`, { waitUntil: 'domcontentloaded' });
  const G = () => pg.frames().find((f) => /role=guest/.test(f.url()));
  let conn = false;
  for (let i = 0; i < 50 && !conn; i++) { await sleep(500); try { conn = await G().evaluate(() => window.__net && window.__net.state === 'connected'); } catch (e) { /* ещё грузится */ } }
  check(`стенд (${MODE}): гость подключился`, conn, conn ? '' : await G().evaluate(() => document.getElementById('hud').textContent).catch(() => ''));
  await sleep(1500);
  await G().evaluate(() => { window.__track.length = 0; });
  await sleep(8000);
  const tr = await G().evaluate(() => window.__track.slice());
  const fps = tr.length / 8;
  let maxV = 0, bad = 0, maxStep = 0;
  for (let i = 1; i < tr.length; i++) {
    const dt = (tr[i].t - tr[i - 1].t) / 1000;
    const d = Math.hypot(tr[i].x - tr[i - 1].x, tr[i].z - tr[i - 1].z);
    maxStep = Math.max(maxStep, d);
    if (dt > 0) { const v = d / dt; maxV = Math.max(maxV, v); if (v > 31) bad++; }   // телепорт — быстрее двух скоростей рывка
  }
  const ping = await G().evaluate(() => window.__net.ping);
  writeFileSync(join(OUT, 'harness-track.json'), JSON.stringify(tr));
  check(`стенд: плавно при пинге ${PING} мс и ${Math.round(LOSS * 100)}% потерь (бег 6 м/с, рывки 15,6 м/с; телепорт — > 31 м/с)`, tr.length > 30 && bad === 0, `${tr.length} кадров (${fps.toFixed(0)} fps), max ${maxV.toFixed(1)} м/с, max шаг ${maxStep.toFixed(2)} м, пинг ${ping} мс`);
  await pg.screenshot({ path: join(OUT, 'harness.png') });
  const errs = errors.A.filter((e) => !/Failed to load resource|net::ERR/i.test(e));
  check('стенд: нет ошибок в консоли', errs.length === 0, errs.slice(0, 3).join(' | '));
  writeFileSync(join(OUT, 'harness-report.txt'), results.join('\n') + '\n');
  await browser.close(); server.kill(); if (relay) relay.kill();
  process.exit(failures ? 1 : 0);
}
// A, B — окна игры хоста и гостя: { evaluate, keyDown, keyUp, press, shot }
let A, B, page0 = null;
if (MODE === 'local') {
  // две iframe рядом на одной странице: обе видимы (у фоновой вкладки rAF стоит)
  page0 = await ctxA.newPage();
  await page0.setViewportSize({ width: 1100, height: 380 });
  page0.on('pageerror', (e) => errors.A.push(String(e)));
  page0.on('console', (m) => { if (m.type() === 'error') errors.A.push(m.text()); });
  await page0.goto(`http://127.0.0.1:${PORT}/dev/net-two-tabs.html?ping=${PING}&loss=${LOSS}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const fr = (re) => page0.frames().find((f) => re.test(f.url()));
  const mk = (re, sel) => ({
    evaluate: (fn) => fr(re).evaluate(fn),
    focus: () => page0.locator(sel).click({ position: { x: 200, y: 300 } }),
    keyDown: (k) => page0.keyboard.down(k), keyUp: (k) => page0.keyboard.up(k), press: (k) => page0.keyboard.press(k),
    shot: (path) => page0.screenshot({ path }),
  });
  A = mk(/netAuto=host/, '#host'); B = mk(/netAuto=join/, '#guest');
} else {
  const room = 'Q7KM';
  const base = MODE === 'lan'
    ? `http://127.0.0.1:${PORT}/?debug=1&net=lan&room=${room}&netReady&lanHost=127.0.0.1:${RELAY_PORT}`
    : `http://127.0.0.1:${PORT}/?debug=1&net=peer&room=${room}&netReady` + (PEER_BIN ? `&peerHost=127.0.0.1&peerPort=${PEER_PORT}&peerSecure=0` : '');
  const open = async (ctx, tag, extra) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors[tag].push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
    await page.goto(`${base}&${extra}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return {
      evaluate: (fn) => page.evaluate(fn), focus: () => page.bringToFront(),
      keyDown: (k) => page.keyboard.down(k), keyUp: (k) => page.keyboard.up(k), press: (k) => page.keyboard.press(k),
      shot: (path) => page.screenshot({ path }),
    };
  };
  A = await open(ctxA, 'A', 'netAuto=host&netName=Хост&netHero=ashen');
  await sleep(1500);
  B = await open(ctxB, 'B', 'netAuto=join&netName=Гость&netHero=ashen');
}

const net = (p) => p.evaluate(() => (window.__ASHEN__ && window.__ASHEN__.net ? window.__ASHEN__.net() : null));
const screen = (p) => p.evaluate(() => (window.__ASHEN__ ? window.__ASHEN__.screen : null));

// оба в комнате, оба «Готов» → бой
let ok = false;
for (let i = 0; i < 60 && !ok; i++) { await sleep(500); ok = (await screen(A)) === 'playing' && (await screen(B)) === 'playing'; }
const nA = await net(A), nB = await net(B);
check('лобби: оба подключились и стартовали по «Готов»', ok, `A=${await screen(A)} ${nA && nA.status} B=${await screen(B)} ${nB && nB.status}`);
check('hello: имена соперников', nA && nB && nA.opponent && nB.opponent && nA.opponent.name === 'Гость' && nB.opponent.name === 'Хост', JSON.stringify([nA && nA.opponent, nB && nB.opponent]));

// хост идёт вперёд, пока сам не пройдёт ≥ 4 м (на медленном софтверном GPU это дольше 3 с);
// гость всё это время пишет трек соперника
const hostPos = () => A.evaluate(() => { const s = window.__ASHEN__.snapshot(); return s ? s.player.position : null; });
const fpsOf = (p) => p.evaluate(() => window.__ASHEN__.fps);
await A.focus();
const p0 = await hostPos();
await A.keyDown('KeyW');
const track = [];
const t0 = Date.now();
let walking = true;
const sampler = (async () => {
  while (walking) {
    const r = await B.evaluate(() => { const ns = window.__ASHEN__.netSession(); const s = ns && ns.remote.getState(); return s ? { t: performance.now(), x: s.position.x, z: s.position.z, loco: s.locomotion, action: s.action } : null; });
    if (r) track.push(r);
    await sleep(30);
  }
})();
let sawProj = false, fired = false;
while (Date.now() - t0 < 40000) {
  await sleep(250);
  const p = await hostPos();
  const moved = p && p0 ? Math.hypot(p.x - p0.x, p.z - p0.z) : 0;
  if (!fired && moved > 1.5) { fired = true; await A.press('KeyU'); }     // «Искра» — снаряд
  if (fired && !sawProj) { const d = await net(B); sawProj = !!(d && d.remoteProj > 0); }
  if (moved > 4 && (sawProj || Date.now() - t0 > 30000)) break;
}
for (let i = 0; i < 20 && fired && !sawProj; i++) { const d = await net(B); sawProj = !!(d && d.remoteProj > 0); await sleep(100); }
await sleep(700);
await B.shot(join(OUT, `${MODE}-guest-sees-host.png`));
walking = false;
await sampler;
await A.keyUp('KeyW');
console.log(`fps хоста ${await fpsOf(A)}, гостя ${await fpsOf(B)}; ход ${((Date.now() - t0) / 1000).toFixed(1)} с`);
const dist = track.length > 2 ? Math.hypot(track[track.length - 1].x - track[0].x, track[track.length - 1].z - track[0].z) : 0;
let maxSpeed = 0, jumps = 0;
for (let i = 1; i < track.length; i++) {
  const dt = (track[i].t - track[i - 1].t) / 1000;
  if (dt <= 0) continue;
  const v = Math.hypot(track[i].x - track[i - 1].x, track[i].z - track[i - 1].z) / dt;
  maxSpeed = Math.max(maxSpeed, v);
  if (v > 14) jumps++;
}
// при < 8 fps каждый кадр длиннее stallSec (0,25 с) и бой не продвигается — движение здесь не проверить
const hostFps = await fpsOf(A);
const skip = (name, why) => { const line = `SKIP  ${name} — ${why}`; results.push(line); console.log(line); };
if (hostFps < 8) {
  const why = `fps хоста ${hostFps}: кадр > 0,25 с, бой стоит (софтверный GPU). Плавность — node tools/qa_net.mjs --harness`;
  skip('гость видит, как хост идёт', why);
  skip('снаряд хоста виден у гостя', why);
} else {
  check('гость видит, как хост идёт', dist > 3, `прошёл ${dist.toFixed(1)} м, ${track.length} замеров`);
  check('снаряд хоста виден у гостя', sawProj);
}
check('движение без телепортов (скорость на экране ≤ 14 м/с)', jumps === 0, `max ${maxSpeed.toFixed(1)} м/с, рывков ${jumps}`);
check('анимация: locomotion соперника = бег/шаг', track.some((s) => s.loco === 'run' || s.loco === 'walk' || s.loco === 'sprint'), [...new Set(track.map((s) => s.loco))].join(','));

// обрыв и восстановление
const tDrop = Date.now();
await A.evaluate(() => window.__ASHEN__.netSession().net.simulateDrop(4500));
let lostAt = 0, backAt = 0;
while (Date.now() - tDrop < 12000) {
  const d = await net(B);
  if (!lostAt && d && d.status === 'lost') lostAt = Date.now();
  if (lostAt && d && d.status === 'connected') { backAt = Date.now(); break; }
  await sleep(100);
}
if (lostAt) await B.shot(join(OUT, `${MODE}-ghost.png`)).catch(() => {});
check('обрыв замечен за ≤ 3,5 с', lostAt > 0 && lostAt - tDrop <= 3600, lostAt ? `${lostAt - tDrop} мс` : 'нет');
check('связь восстановилась сама', backAt > 0, backAt ? `через ${backAt - tDrop} мс после обрыва` : 'нет');
const pingB = (await net(B)).ping;
check(`пинг похож на заданный (${MODE === 'local' ? PING : MODE})`, MODE !== 'local' || (pingB > PING * 0.6 && pingB < PING * 1.8), `${pingB} мс`);

const errs = [...errors.A.map((e) => `A: ${e}`), ...errors.B.map((e) => `B: ${e}`)].filter((e) => !/Failed to load resource|net::ERR|mediapipe|favicon/i.test(e));
check('нет ошибок в консоли', errs.length === 0, errs.slice(0, 5).join(' | '));

writeFileSync(join(OUT, `${MODE}-report.txt`), results.join('\n') + '\n');
console.log(`\nскриншоты и отчёт: ${OUT}`);
await browser.close();
server.kill();
if (relay) relay.kill();
process.exit(failures ? 1 : 0);
