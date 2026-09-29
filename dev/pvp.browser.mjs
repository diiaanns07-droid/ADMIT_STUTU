// [PVP] Проверка дуэли в двух вкладках (DEBUG, клавиатура) через Playwright. Не входит в node-тесты.
// node dev/pvp.browser.mjs [--url http://127.0.0.1:8765/] [--browser /opt/pw-browsers/.../chrome] [--out DIR] [--full]
// Сервер должен быть запущен: python serve_game.py --no-browser
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL0 = argOf('--url', 'http://127.0.0.1:8765/');
const OUT = argOf('--out', join(process.cwd(), 'pvp_shots'));
const FULL = argv.includes('--full');
let pw;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(p); break; } catch (e) { /* next */ } }
if (!pw) { console.error('playwright не найден'); process.exit(2); }
const exe = argOf('--browser', ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => existsSync(p)));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proxy = argv.includes('--proxy') ? (process.env.HTTPS_PROXY || process.env.https_proxy) : null;
const browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}) });
const [VW, VH] = argOf('--size', '960x540').split('x').map(Number);
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
// качество low и без эффектов движения: headless-рендер программный (SwiftShader), иначе кадр — секунды
// рисование WebGL выключено (window.__pvpNoDraw), кроме скриншотов: логика идёт в реальном времени
await ctx.addInitScript(() => {
  window.__pvpNoDraw = true;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const f = C.prototype[k];
      if (typeof f === 'function') C.prototype[k] = function (...a) { if (window.__pvpNoDraw) return undefined; return f.apply(this, a); };
    }
  }
});
await ctx.addInitScript(() => { try { localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', reducedMotion: true })); } catch (e) { /* ignore */ } });
// --cdn DIR: node_modules с three@0.185.1 и @pixiv/three-vrm — отдаём их вместо cdn.jsdelivr.net (офлайн/закрытая сеть)
const CDN = argOf('--cdn', null);
if (CDN) {
  const { readFileSync } = await import('node:fs');
  await ctx.route(/cdn\.jsdelivr\.net\/npm\//, (route) => {
    const u = new URL(route.request().url());
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/(.*)$/);
    const f = m && join(CDN, 'node_modules', m[1], m[2]);
    if (f && existsSync(f)) return route.fulfill({ status: 200, contentType: f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body: readFileSync(f) });
    return route.fulfill({ status: 404, body: 'nf' });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost|cdn\.jsdelivr\.net|fonts\.)/.test(u.hostname), (route) => route.abort());
}
const errors = [];
// --stub: своя заглушка сети (?pvp=local); по умолчанию — сеть №2 (net/net.js, транспорт local, лобби с автоготовностью)
const STUB = argv.includes('--stub');
const ROOM = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');   // код комнаты №2: без 0, O, 1, I
async function open(name) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name} ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  const q = STUB ? '?pvp=local' : `?debug=1&net=local&room=${ROOM}&netReady&netAuto=${name === 'A' ? 'host' : 'join'}&netName=${name === 'A' ? 'Хост' : 'Гость'}`;
  await page.goto(`${URL0}${q}`, { waitUntil: 'domcontentloaded' });
  return page;
}
const A = await open('A');
await waitReady(A);
const B = await open('B');
async function waitReady(p) { for (let i = 0; i < 240; i++) { const ok = await p.evaluate(() => !!(window.__ASHEN__ && window.__ashenPvp && window.__ASHEN__.fps > 0)).catch(() => false); if (ok) return; await sleep(500); } }
const pv = (p) => p.evaluate(() => (window.__ASHEN__ && window.__ASHEN__.pvp ? window.__ASHEN__.pvp() : null));
const snap = (p) => p.evaluate(() => { const s = window.__ASHEN__.snapshot(); return s && { mode: s.mode, hp: s.player.hp, pos: s.player.position, opp: s.opponent && { hp: s.opponent.hp, pos: s.opponent.position, shielding: s.opponent.shielding }, lock: s.lockTarget, stats: s.stats, energy: s.player.energy }; });
async function waitPhase(p, ph, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const d = await pv(p); if (d && d.phase === ph) return d; await sleep(200); }
  throw new Error(`фаза ${ph} не наступила: ${JSON.stringify(await pv(p))} net=${JSON.stringify(await p.evaluate(() => { const n = window.__ASHEN__.net && window.__ASHEN__.net(); return n && { status: n.status, message: n.message, error: n.error, ready: [n.meReady, n.oppReady] }; }).catch(() => null))} screen=${await p.evaluate(() => window.__ASHEN__.screen).catch(() => '?')}`);
}
async function shot(p, file) {
  await p.evaluate(() => { window.__pvpNoDraw = false; });
  await sleep(2500);
  await p.screenshot({ timeout: 180000, path: join(OUT, file) });
  await p.evaluate(() => { window.__pvpNoDraw = true; });
}
// headless-Chromium даёт полный rAF только вкладке на переднем плане: действующую вкладку выводим вперёд
let front = null;
async function focus(p) { if (front !== p) { await p.bringToFront(); front = p; await sleep(400); } }
async function key(p, k, holdMs = 60) { await focus(p); await p.keyboard.down(k); await sleep(holdMs); await p.keyboard.up(k); }
const report = {};
// нажатие изнутри страницы, когда снаряд соперника ближе dist м (проверка рывка/парирования по-настоящему)
const reactWhenNear = (p, code, dist, holdMs = 80) => p.evaluate(({ code, dist, holdMs }) => new Promise((res) => {
  const t0 = performance.now();
  // с сетью №2 снаряды соперника есть только в снимке для эффектов (netSession.frame → snapshot): перехватываем
  const ns = window.__ASHEN__.netSession && window.__ASHEN__.netSession();
  if (ns && !ns.__pvpWrapped) { const f = ns.frame; ns.frame = (...a) => { const r = f(...a); window.__fxSnap = r && r.snapshot; return r; }; ns.__pvpWrapped = true; }
  const tick = () => {
    const s = window.__fxSnap || window.__ASHEN__.snapshot();
    const me = s && s.player.position;
    const g = s && s.projectiles.filter((q) => q.owner === 'opponent');
    const d = g && g.length ? Math.min(...g.map((q) => Math.hypot(q.position.x - me.x, q.position.z - me.z))) : Infinity;
    if (d <= dist) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      setTimeout(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); res({ d: Math.round(d * 10) / 10, t: Math.round(performance.now() - t0) }); }, holdMs);
      return;
    }
    if (performance.now() - t0 > 4000) { res({ d: null }); return; }
    requestAnimationFrame(tick);
  };
  tick();
}), { code, dist, holdMs });
const stats = async (p) => (await pv(p)).stats;
try {
  await waitPhase(A, 'fight'); await waitPhase(B, 'fight');
  await sleep(1800);                                   // неуязвимость появления 1.5 с
  report.fps = [await A.evaluate(() => window.__ASHEN__.fps), await B.evaluate(() => window.__ASHEN__.fps)];
  if (argv.includes('--focus')) {
    await A.bringToFront(); await sleep(3000);
    report.fpsFrontA = [await A.evaluate(() => window.__ASHEN__.fps), await B.evaluate(() => window.__ASHEN__.fps)];
    await B.bringToFront(); await sleep(3000);
    report.fpsFrontB = [await A.evaluate(() => window.__ASHEN__.fps), await B.evaluate(() => window.__ASHEN__.fps)];
  }
  if (argv.includes('--profile')) {
    const cdp = await ctx.newCDPSession(A);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    await sleep(5000);
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const dt = profile.timeDeltas || [];
    profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); });
    report.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`);
  }
  await focus(A);
  if (argv.includes('--trace')) {
    await A.keyboard.press('KeyU');
    report.trace = await A.evaluate(() => new Promise((res) => { const out = []; const t0 = performance.now(); const f = () => { const s = window.__ASHEN__.snapshot(); out.push([Math.round(performance.now() - t0), +s.time.toFixed(2), s.projectiles.map((q) => `${q.owner}:${q.kind}@${q.position.x.toFixed(1)},${q.position.y.toFixed(1)}`).join(' '), `${s.boss.position.x.toFixed(1)},${s.boss.position.y.toFixed(1)}`, s.player.action, s.pvp && s.pvp.phase]); if (performance.now() - t0 < 2500) requestAnimationFrame(f); else res(out); }; f(); }));
  }
  const hp0 = (await snap(B)).hp;
  report.pre = { A: await A.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { p: s.player.position, enc: s.player.encounter, opp: s.opponent && s.opponent.position, lock: s.lockTarget, boss: s.boss.position, n: window.__ASHEN__.net && window.__ASHEN__.net() && window.__ASHEN__.net().status }; }),
    B: await B.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { p: s.player.position, enc: s.player.encounter, opp: s.opponent && s.opponent.position }; }) };
  await key(A, 'KeyU'); await sleep(150);
  report.pre.proj = await A.evaluate(() => window.__ASHEN__.snapshot().projectiles.map((q) => [q.owner, q.kind, q.position, q.velocity]));
  await sleep(1500);
  for (let i = 0; i < 3; i++) { await key(A, 'KeyU'); await sleep(800); }
  await sleep(600);
  report.spark = { hpBefore: hp0, hpAfter: (await snap(B)).hp, A: await stats(A) };
  // щит: B держит K
  await focus(B); await B.keyboard.down('KeyK'); await sleep(250);
  for (let i = 0; i < 2; i++) { await key(A, 'KeyU'); await sleep(800); }
  await B.keyboard.up('KeyK'); await sleep(500);
  report.shield = { B: await stats(B), en: (await snap(B)).energy };
  // парирование: F, когда искра ближе 7 м → снаряд летит назад и бьёт A
  const aHp0 = (await snap(A)).hp;
  await focus(B);
  const par = reactWhenNear(B, 'KeyF', 7);
  await A.keyboard.down('KeyU'); await sleep(60); await A.keyboard.up('KeyU');
  report.parry = { react: await par };
  await sleep(1600);
  report.parry.B = await stats(B); report.parry.aHpBefore = aHp0; report.parry.aHpAfter = (await snap(A)).hp;
  // рывок: пробел, когда искра ближе 6 м
  await sleep(700);
  await focus(B);
  const dsh = reactWhenNear(B, 'Space', 6, 60);
  await A.keyboard.down('KeyU'); await sleep(60); await A.keyboard.up('KeyU');
  report.dash = { react: await dsh };
  await sleep(1200);
  report.dash.B = await stats(B);
  if (argv.includes('--disconnect')) {
    // обрыв: вкладка B закрывается посреди боя → у A пауза «Соперник отключился…»/техническая победа
    await focus(A);
    await B.close();
    const seen = [];
    for (let i = 0; i < 60; i++) { const v = (await pv(A)).view; seen.push(`${v.phase}${v.phase === 'paused' ? ':' + Math.ceil(v.disconnectLeft) : ''}`); if (v.phase === 'match_end') break; await sleep(1000); }
    report.disconnect = { seen: [...new Set(seen)], end: (await pv(A)).view.result };
    await shot(A, '5_disconnect_A.png');
  }
  if (FULL) {
    // матч из трёх раундов: 1 — бьёт A, 2 — бьёт B, 3 — снова A (итог 2:1). Все приёмы по кругу;
    // нажатия — событиями внутри страницы (debugInput слушает window), вперёд выводится вкладка атакующего.
    const press = (p, code, holdMs = 70) => p.evaluate(({ code, holdMs }) => new Promise((r) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      setTimeout(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); r(); }, holdMs);
    }), { code, holdMs });
    const MOVES = [['Digit1'], ['KeyU'], ['Digit2'], ['KeyO', 900], ['Digit4'], ['KeyU'], ['Digit7'], ['KeyL'], ['Digit8'], ['KeyZ'], ['Digit9'],
      ['KeyC'], ['KeyV'], ['KeyP', 900], ['Digit3'], ['KeyX'], ['Digit5'], ['KeyJ', 1200], ['Digit6'], ['KeyB'], ['KeyK', 500], ['KeyF'], ['Space'], ['KeyI'], ['Digit0'], ['KeyU']];
    report.rounds = [];
    let i = 0, lastRound = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 420000) {
      const d = await pv(A);
      if (!d) { await sleep(500); continue; }
      const v = d.view;
      if (v.round !== lastRound) { lastRound = v.round; report.rounds.push({ round: v.round, score: v.score.join(':'), t: Math.round((Date.now() - t0) / 1000) }); }
      if (v.phase === 'match_end') break;
      if (v.phase === 'round_end' && !report.roundEndShot) { report.roundEndShot = true; await shot(A, `3_round_end_A.png`); }
      if (v.phase !== 'fight') { await sleep(300); continue; }
      const att = v.round === 2 ? B : A;
      await focus(att);
      const [code, hold] = MOVES[i++ % MOVES.length];
      await press(att, code, hold || 70);
      await sleep(260);
    }
    await sleep(1200);
    report.endA = (await pv(A)).view; report.endB = (await pv(B)).view;
    await shot(A, '4_result_A.png'); await shot(B, '4_result_B.png');
  }
  if (!argv.includes('--disconnect')) { await shot(A, '2_fight_A.png'); await shot(B, '2_fight_B.png'); }
} catch (e) { report.error = String(e && e.stack || e); report.netB = await B.evaluate(() => { const n = window.__ASHEN__ && window.__ASHEN__.net && window.__ASHEN__.net(); return { screen: window.__ASHEN__ && window.__ASHEN__.screen, n: n && { status: n.status, message: n.message, error: n.error, errorCode: n.errorCode, code: n.code } , url: location.href }; }).catch((x) => String(x)); }
report.errors = errors;
console.log(JSON.stringify({ ...report, errors }, null, 1));
await browser.close();
