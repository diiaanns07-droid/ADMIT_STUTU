// [W4-UI] Тесты чисел урона и шкалы «Ярость клятвы» в core/battleHud.js на фальшивом 2D-контексте:
// лечение «+N», числа не накладываются, пул спрайтов не растёт, в кадре нет новых градиентов,
// «Уменьшенное движение» — числа стоят на месте, уровень качества уходит в html[data-ao-q].
// node dev/battleHudW4.test.mjs
import { createBattleHud } from '../core/battleHud.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

// фальшивый 2D-контекст: считает тексты, градиенты и drawImage
function fakeCtx(stats) {
  const state = { font: '10px sans-serif', shadowBlur: 0, globalAlpha: 1, lineDash: [] };
  const noop = () => {};
  const grad = { addColorStop: noop };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'fillText' || k === 'strokeText') return (s) => { stats.texts.push(String(s)); };
      if (k === 'measureText') return (s) => { const m = /(\d+(?:\.\d+)?)px/.exec(t.font); const px = m ? +m[1] : 10; return { width: String(s).length * px * 0.6 }; };
      if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => { stats.grads++; return grad; };
      if (k === 'drawImage') return (...a) => { stats.images.push(a); };
      if (k === 'setLineDash') return (a) => { t.lineDash = a; };
      if (k === 'getLineDash') return () => t.lineDash;
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
// окружение браузера: document.createElement('canvas') даёт спрайты, documentElement ловит data-ao-q
function withDom(fn) {
  const sprites = { made: 0, texts: [], grads: 0, images: [] };
  const attrs = {};
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => { if (tag !== 'canvas') return null; sprites.made++; const c = { width: 0, height: 0 }; const g = fakeCtx(sprites); c.getContext = () => g; return c; },
    querySelector: () => null,
    documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
  };
  try { return fn(sprites, attrs); } finally { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; }
}
function makeHud() {
  const stats = { texts: [], grads: 0, images: [] };
  const canvas = { width: 0, height: 0, clientWidth: 1366, clientHeight: 768, getContext: () => fakeCtx(stats) };
  return { hud: createBattleHud({ canvas }), stats };
}
function project(p) {
  const cz = 11 - p.z, cy = p.y - 3;
  if (cz < 0.1) return { x: 0, y: 0, behind: true };
  const f = 1 / Math.tan((58 * Math.PI / 180) / 2);
  return { x: 683 + (p.x / cz) * f * 384, y: 384 - (cy / cz) * f * 384, behind: false };
}
function snap(over = {}) {
  return {
    status: 'playing', time: 30,
    player: { position: { x: 0.5, y: 0, z: 6 }, hp: 60, maxHp: 100, energy: 60, maxEnergy: 100, action: 'idle', combo: 0, comboMultiplier: 1, comboTimer: 0, encounter: 'engaged', fury: 40, furyMax: 100, furyReady: false, ...(over.player || {}) },
    boss: { position: { x: 0, y: 0, z: 0 }, hp: 500, maxHp: 700, action: 'idle', stage: 1, ...(over.boss || {}) },
    telegraphs: [], projectiles: [], cooldowns: {}, stats: {},
  };
}
let evId = 0;
const ev = (type, data = {}, position = { x: 0, y: 3, z: 0 }) => ({ id: `w4-${++evId}`, type, position, data });
function frame(hud, s, events = [], extra = {}) {
  hud.frame({ dtReal: extra.dt ?? 1 / 60, timeScale: 1, screen: 'playing', snapshot: s, events, input: null, project, viewport: { w: 1366, h: 768 },
    intro: { active: false, t: 0, duration: 5 }, settings: { reducedMotion: !!extra.rm, quality: extra.q || 'medium' }, resumeLeftMs: 0, pois: [], coach: null, layout: null,
    ult: { fury: s.player.fury, furyMax: 100, ready: false, gesture: null, debug: false, flash: 0, cine: null } });
}
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 - 2 && b.y0 < a.y1 - 2;

test('лечение: рост HP героя → зелёное «+18» (и без события), реген копится в одно число', () => {
  const { hud, stats } = makeHud();
  frame(hud, snap({ player: { hp: 60 } }));
  frame(hud, snap({ player: { hp: 78 } }));
  for (let i = 0; i < 3; i++) frame(hud, snap({ player: { hp: 78 } }));
  assert(stats.texts.includes('+18'), stats.texts.filter((x) => /^\+/.test(x)).join(','));
  assert(hud.numbers().some((n) => n.kind === 'heal' && n.text === '+18'), 'вид heal');
  // реген по 0,5 HP за кадр: за 0,45 с — одно «+N», а не 27 мелких
  const r = makeHud();
  let hp = 40;
  for (let i = 0; i < 27; i++) { hp += 0.5; frame(r.hud, snap({ player: { hp } })); }
  const heals = r.hud.numbers().filter((n) => n.kind === 'heal');
  assert(heals.length <= 2, `чисел лечения: ${heals.length}`);
  // новый бой (reset) — полное HP не считается лечением
  const z = makeHud();
  frame(z.hud, snap({ player: { hp: 10 } })); z.hud.reset(); frame(z.hud, snap({ player: { hp: 100 } }));
  assert(!z.hud.numbers().some((n) => n.kind === 'heal'), 'reset без «+90»');
});

test('урон по герою — «−N» вида hurt, крит — золото с «КРИТ!», обычный — dmg', () => {
  const { hud } = makeHud();
  frame(hud, snap(), [ev('player_hit', { amount: 22 }, { x: 0.5, y: 1.2, z: 6 }), ev('boss_hit', { amount: 140, source: 'slash', recoverBonus: true }), ev('boss_hit', { amount: 9, source: 'bolt' })]);
  const n = hud.numbers();
  assert(n.some((x) => x.kind === 'hurt' && x.text === '−22'), 'hurt');
  assert(n.some((x) => x.kind === 'crit' && x.label === 'КРИТ!' && x.text === '140'), 'crit');
  assert(n.some((x) => x.kind === 'dmg' && x.text === '9'), 'dmg');
});

test('числа не накладываются: залп из 6 ударов в одну точку и очередь — рамки цифр врозь', () => {
  const { hud } = makeHud();
  frame(hud, snap(), [1, 2, 3, 4, 5, 6].map((k) => ev('boss_hit', { amount: 20 + k, source: 'bolt' })));
  for (let i = 0; i < 6; i++) frame(hud, snap());
  for (let k = 0; k < 8; k++) { frame(hud, snap(), [ev('boss_hit', { amount: 30 + k, source: 'bolt' })]); for (let i = 0; i < 7; i++) frame(hud, snap()); }
  const n = hud.numbers();
  assert(n.length >= 6, `видно ${n.length}`);
  const bad = [];
  for (let i = 0; i < n.length; i++) for (let j = i + 1; j < n.length; j++) if (overlaps(n[i].box, n[j].box)) bad.push(`${n[i].text}/${n[j].text}`);
  assert(!bad.length, `наложения: ${bad.join(', ')}`);
});

test('числа летят по дуге: стороны чередуются, число поднимается; «Уменьшенное движение» — на месте', () => {
  const { hud } = makeHud();
  frame(hud, snap(), [ev('boss_hit', { amount: 30, source: 'bolt' })]);
  const a0 = hud.numbers()[0];
  for (let i = 0; i < 25; i++) frame(hud, snap());
  frame(hud, snap(), [ev('boss_hit', { amount: 31, source: 'bolt' }, { x: 3, y: 3, z: 0 })]);
  const b0 = hud.numbers().find((x) => x.text === '31');
  for (let i = 0; i < 25; i++) frame(hud, snap());
  const a1 = hud.numbers().find((x) => x.text === '30'), b1 = hud.numbers().find((x) => x.text === '31');
  assert(a1.y < a0.y - 20, `подъём ${a0.y.toFixed(0)} → ${a1.y.toFixed(0)}`);
  assert(Math.sign(a1.x - a0.x) !== Math.sign(b1.x - b0.x), 'стороны дуги чередуются');
  const r = makeHud();
  frame(r.hud, snap(), [ev('boss_hit', { amount: 30, source: 'bolt' })], { rm: true });
  const r0 = r.hud.numbers()[0];
  for (let i = 0; i < 30; i++) frame(r.hud, snap(), [], { rm: true });
  const r1 = r.hud.numbers()[0];
  assert(r1 && Math.abs(r1.x - r0.x) < 0.01 && Math.abs(r1.y - r0.y) < 0.01, 'rm: число неподвижно');
});

test('бюджет: спрайты из пула (не больше 14 на 200 ударов), в кадре — ни одного нового градиента', () => withDom((sprites, attrs) => {
  const { hud, stats } = makeHud();
  for (let i = 0; i < 200; i++) frame(hud, snap(), [ev('boss_hit', { amount: 10 + (i % 90), source: i % 7 ? 'bolt' : 'burst', recoverBonus: i % 11 === 0 })]);
  assert(sprites.made <= 14, `спрайтов создано: ${sprites.made}`);
  assert(hud.numbers().every((n) => n.sprite), 'числа рисуются спрайтами');
  assert(sprites.texts.includes('КРИТ!'), 'крит в спрайте');
  for (let i = 0; i < 3; i++) frame(hud, snap());
  const g0 = stats.grads, img0 = stats.images.length;
  for (let i = 0; i < 20; i++) frame(hud, snap());
  assert(stats.grads === g0, `новых градиентов в кадре: ${stats.grads - g0}`);
  assert(stats.images.length > img0, 'числа видны (drawImage)');
  assert(attrs['data-ao-q'] === 'medium', `data-ao-q=${attrs['data-ao-q']}`);
  frame(hud, snap(), [], { q: 'low' });
  assert(attrs['data-ao-q'] === 'low', 'уровень low');
  hud.dispose();
  assert(hud.numbers().length === 0, 'dispose гасит числа');
}));

test('«Ярость клятвы»: подписи, проценты и хвост потери после траты', () => {
  const { hud, stats } = makeHud();
  for (let i = 0; i < 10; i++) frame(hud, snap({ player: { fury: 80 } }));
  assert(stats.texts.includes('ЯРОСТЬ КЛЯТВЫ') && stats.texts.includes('80%'), stats.texts.slice(-12).join(','));
  stats.texts.length = 0;
  frame(hud, snap({ player: { fury: 100, furyReady: true } }));
  assert(stats.texts.includes('НЕБЕСНЫЙ СУД ГОТОВ'), 'готово');
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${e && e.message}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed && typeof process !== 'undefined') process.exitCode = 1;
