// [PVP] Регресс: бой с Регентом (без ?pvp) идёт как прежде — меню → DEBUG → бой, без ошибок; PvP-модуль не мешает.
// node dev/pvp.boss.browser.mjs --cdn DIR   (DIR/node_modules: three@0.185.1, @pixiv/three-vrm — вместо закрытого CDN)
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const CDN = argOf('--cdn', null), URL0 = argOf('--url', 'http://127.0.0.1:8765/');
let pw; for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { pw = require(p); break; } catch (e) { /* next */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await pw.chromium.launch({ executablePath: argOf('--browser', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-renderer-backgrounding'] });
const ctx = await b.newContext({ viewport: { width: 960, height: 540 } });
await ctx.addInitScript(() => {
  localStorage.setItem('ashen-oath.settings.v1', JSON.stringify({ quality: 'low', reducedMotion: true }));
  window.__pvpNoDraw = true;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) { const f = C.prototype[k]; C.prototype[k] = function (...a) { if (window.__pvpNoDraw) return undefined; return f.apply(this, a); }; }
});
if (CDN) await ctx.route(/cdn\.jsdelivr\.net\/npm\//, (route) => { const u = new URL(route.request().url()); const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^/@]+)@[^/]+\/(.*)$/); const f = m && join(CDN, 'node_modules', m[1], m[2]); if (f && existsSync(f)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(f) }); return route.fulfill({ status: 404, body: 'nf' }); });
await ctx.route((u) => !/^(127\.0\.0\.1|localhost|cdn\.jsdelivr\.net)/.test(u.hostname), (route) => route.abort());
const p = await ctx.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', (e) => errors.push('pageerror ' + e.message));
await p.goto(URL0, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120 && !(await p.evaluate(() => !!(window.__ASHEN__ && window.__ASHEN__.fps > 0)).catch(() => false)); i++) await sleep(500);
const click = (label) => p.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && x.textContent.trim() === l); if (!b) return 'missing'; b.click(); return 'ok'; }, label);
const out = {};
out.debug = await click('Отладка с клавиатуры'); await sleep(300);
out.start = await click('Играть'); await sleep(500);
out.nocam = await click('Продолжить без камеры (DEBUG)'); await sleep(500);
out.fight = await click('В бой'); await sleep(8000);
const s = await p.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { screen: window.__ASHEN__.screen, mode: s && s.mode, lock: s && s.lockTarget && s.lockTarget.kind, opp: s && s.opponent, bossHp: s && s.boss.hp, pvp: window.__ASHEN__.pvp() }; });
// идём к Регенту (W) и стреляем искрой, чтобы бой шёл
await p.keyboard.down('KeyW'); await sleep(4000); await p.keyboard.up('KeyW');
for (let i = 0; i < 5; i++) { await p.keyboard.press('KeyU'); await sleep(400); }
await sleep(1500);
const s2 = await p.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { screen: window.__ASHEN__.screen, bossHp: s.boss.hp, enc: s.player.encounter, dist: Math.hypot(s.player.position.x, s.player.position.z), brain: null }; });
console.log(JSON.stringify({ out, s, s2, errors }, null, 1));
await b.close();
process.exitCode = errors.length || s.mode !== 'boss' || s.screen !== 'playing' ? 1 : 0;
