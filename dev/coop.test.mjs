// dev/coop.test.mjs — [КООП] «Вместе против Регента»: общий Регент двух боёв по сети в памяти.
// node dev/coop.test.mjs
import { createCombat } from '../modules/combat.js';
import { createMemoryNetPair } from '../modules/pvp.js';
import { createCoop, COOP_HP_EVERY_MS } from '../modules/coop.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e && e.message ? e.message : String(e) }); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assert'); }
function near(a, b, eps, msg) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg || 'near'}: ${a} ≠ ${b} ±${eps}`); }
const idleBrain = () => ({ reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } });
const hit = (amount, data = {}) => ({ id: 'x', type: 'boss_hit', position: { x: 0, y: 0, z: 0 }, data: { amount, source: 'burst', ...data } });

function makeCoop() {
  let T = 0;
  const pair = createMemoryNetPair({ latencyMs: 40, jitterMs: 10, seed: 3, clock: () => T });
  const A = createCombat({ config: {}, bossBrain: idleBrain() });   // хост
  const B = createCombat({ config: {}, bossBrain: idleBrain() });   // гость
  const cA = createCoop({ net: pair.a, combat: A });
  const cB = createCoop({ net: pair.b, combat: B });
  return {
    A, B, cA, cB, pair,
    step(ms, evA = [], evB = []) { T += ms; cA.afterUpdate(evA, T); cB.afterUpdate(evB, T); pair.pump(); },
    settle() { for (let i = 0; i < 10; i++) { T += 50; pair.pump(); } },
  };
}
const hp = (c) => c.getSnapshot().boss.hp;

test('урон хоста вычитается у Регента гостя, урон гостя — у хоста', () => {
  const D = makeCoop();
  const max = hp(D.A);
  near(hp(D.B), max, 1e-9, 'старт: здоровье одинаковое');
  D.step(16, [hit(30)], []);
  D.step(16, [], [hit(20), hit(5)]);
  D.settle();
  near(hp(D.B), max - 30, 1e-6, 'гость получил урон хоста');
  near(hp(D.A), max - 25, 1e-6, 'хост получил урон гостя');
});

test('свой урон не уходит обратно: удары напарника и события соперника не пересылаются', () => {
  const D = makeCoop();
  const max = hp(D.A);
  D.step(16, [hit(40, { remote: true }), hit(40, { target: 'opponent' }), { type: 'player_hit', data: { amount: 99 } }], []);
  D.settle();
  near(hp(D.B), max, 1e-9, 'ничего не переслано');
});

test('хост раз в 0,5 с присылает здоровье: гость догоняет пропущенный урон, но не лечится', () => {
  const D = makeCoop();
  const max = hp(D.A);
  D.A.coopDamage(100);                       // урон хоста, о котором гость не узнал (будто сообщение потерялось)
  D.step(COOP_HP_EVERY_MS + 1);
  D.settle();
  near(hp(D.B), max - 100, 1e-6, 'гость синхронизирован');
  D.B.coopDamage(50);                        // у гостя меньше — синхронизация не поднимает здоровье
  D.step(COOP_HP_EVERY_MS + 1);
  D.settle();
  near(hp(D.B), max - 150, 1e-6, 'здоровье гостя не выросло');
});

test('общая победа: добивает один — Регент повержен у обоих', () => {
  const D = makeCoop();
  const max = hp(D.A);
  D.step(16, [], [hit(max)]);
  D.settle();
  assert(D.A.getSnapshot().status === 'victory', `хост: ${D.A.getSnapshot().status}`);
  D.A.coopDamage(max);                        // повторный урон после победы — без ошибок
  D.step(COOP_HP_EVERY_MS + 1, [hit(max)], []);
  D.settle();
  assert(D.B.getSnapshot().status === 'victory', `гость: ${D.B.getSnapshot().status}`);
});

test('мусор в сообщениях и остановка', () => {
  const D = makeCoop();
  const max = hp(D.A);
  D.pair.b._fire('co', { t: 'co', d: 'abc' });
  D.pair.b._fire('co', { t: 'co', d: -5 });
  D.pair.b._fire('co', { t: 'co', d: 1e9 });
  D.pair.b._fire('coHp', { t: 'coHp', hp: NaN });
  near(hp(D.B), max, 1e-9, 'мусор не меняет здоровье');
  D.cB.stop();
  D.step(16, [hit(30)], []);
  D.settle();
  near(hp(D.B), max, 1e-9, 'после stop урон не применяется');
  assert(D.cB.active === false, 'stop выключает');
});

let fail = 0;
for (const r of results) { if (r.ok) console.log(`PASS ${r.name}`); else { fail++; console.log(`FAIL ${r.name}: ${r.err}`); } }
console.log(`${results.length - fail}/${results.length}`);
process.exit(fail ? 1 : 0);
