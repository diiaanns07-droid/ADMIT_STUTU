// Тесты прогресса героя (core/progression.js) и combat.setUpgrades. node dev/progression.test.mjs
import { createProgression, UPGRADES, combineMods, EMBER_POINTS } from '../core/progression.js';
import { createCombat } from '../modules/combat.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }
function near(a, b, t, m) { if (!(Math.abs(a - b) <= t)) throw new Error(`${m}: ${a} vs ${b}`); }
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m }; }
const idleBrain = () => ({ update() { return null; }, reset() {} });
const I = (o = {}) => ({ source: 'debug', valid: true, calibrated: true, tMs: 0, moveX: 0, dash: 0, attack: false, shield: false, burst: false, ...o });

test('новый прогресс: ноль очков, все улучшения на 0, цена первого уровня', () => {
  const p = createProgression({ storage: memStore() });
  const v = p.getView();
  assert(v.points === 0 && v.earned === 0 && v.pushups === 0 && v.embers.length === 0, 'пусто');
  assert(v.upgrades.length === UPGRADES.length, 'все улучшения');
  for (const u of v.upgrades) assert(u.level === 0 && u.cost === UPGRADES.find((x) => x.id === u.id).costs[0] && !u.canBuy && u.next, 'уровень 0 ' + u.id);
});

test('отжимания дают очки; уголь — один раз', () => {
  const p = createProgression({ storage: memStore() });
  assert(p.addPushups(5) === 5 && p.getView().points === 5 && p.getView().pushups === 5, '5 повторов');
  assert(p.addPushups(-3) === 0 && p.addPushups(NaN) === 0 && p.addPushups('7') === 0, 'мусор не даёт очков');
  assert(p.lightEmber('ember-1') === EMBER_POINTS, 'уголь');
  assert(p.lightEmber('ember-1') === 0, 'тот же уголь второй раз — 0');
  assert(p.isEmberLit('ember-1') && !p.isEmberLit('ember-2'), 'isEmberLit');
  assert(p.getView().points === 5 + EMBER_POINTS && p.getView().earned === 5 + EMBER_POINTS, 'сумма');
});

test('покупка: списание, уровень, нехватка очков, потолок', () => {
  const p = createProgression({ storage: memStore() });
  assert(p.buy('vitality').reason === 'points', 'без очков нельзя');
  assert(p.buy('nope').reason === 'unknown', 'неизвестное');
  p.addPushups(100);
  const u = UPGRADES.find((x) => x.id === 'stride');
  let spent = 0;
  for (let i = 0; i < u.max; i++) { const r = p.buy('stride'); assert(r.ok && r.level === i + 1, 'уровень ' + (i + 1)); spent += u.costs[i]; }
  assert(p.buy('stride').reason === 'max', 'потолок');
  assert(p.getView().points === 100 - spent, 'списано ' + spent);
  const view = p.getView().upgrades.find((x) => x.id === 'stride');
  assert(view.cost === null && !view.canBuy && view.next === '' && view.now, 'вид на потолке');
});

test('модификаторы: аддитивные суммируются, множители перемножаются', () => {
  const m = combineMods({ vitality: 2, focus: 1, stride: 3, ward: 1 });
  assert(m.maxHp === 30 && m.maxEnergy === 12, 'аддитивные');
  near(m.energyRegenMul, 1.08, 1e-9, 'реген');
  near(m.dashCooldownMul, 0.7, 1e-9, 'кулдаун рывка');
  near(m.shieldDrainMul, 0.85, 1e-9, 'щит');
  assert(Object.keys(combineMods({})).length === 0, 'пусто');
});

test('сохранение: переживает пересоздание; битые данные и падающее хранилище не ломают', () => {
  const s = memStore();
  const a = createProgression({ storage: s });
  a.addPushups(9); a.lightEmber('e1'); a.buy('spark');
  const b = createProgression({ storage: s });
  const v = b.getView();
  assert(v.pushups === 9 && v.embers[0] === 'e1' && v.upgrades.find((u) => u.id === 'spark').level === 1, 'восстановлено');
  s.setItem('ashen.oath.v1', '{"points": -5, "levels": {"spark": 99, "hack": 3}, "embers": [1, "ok"]}');
  const c = createProgression({ storage: s }).getView();
  assert(c.points === 0 && c.upgrades.find((u) => u.id === 'spark').level === 4 && c.embers.length === 1, 'санитизация');
  s.setItem('ashen.oath.v1', 'not json');
  assert(createProgression({ storage: s }).getView().points === 0, 'битый JSON');
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const d = createProgression({ storage: bad });
  assert(d.addPushups(3) === 3 && d.getView().points === 3, 'без хранилища — в памяти');
  const e = createProgression({ storage: null });
  assert(e.addPushups(1) === 1, 'storage=null');
});

test('onChange и resetAll', () => {
  const p = createProgression({ storage: memStore() });
  const seen = [];
  const off = p.onChange((r) => seen.push(r));
  p.addPushups(4); p.lightEmber('x'); p.buy('vitality'); p.resetAll();
  off(); p.addPushups(1);
  assert(seen.join(',') === 'pushup,ember,buy,reset', seen.join(','));
  assert(p.getView().points === 1 && p.getView().embers.length === 0, 'сброс');
});

test('combat.setUpgrades: HP и энергия выше и полные; повтор не накапливает; reset хранит', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  const base = c.getConfig();
  c.setUpgrades(combineMods({ vitality: 2, focus: 1 }));
  let s = c.getSnapshot();
  assert(s.player.maxHp === base.player.maxHp + 30 && s.player.hp === s.player.maxHp, 'HP +30 и полное');
  assert(s.player.maxEnergy === base.player.maxEnergy + 12 && s.player.energy === s.player.maxEnergy, 'энергия');
  c.setUpgrades(combineMods({ vitality: 2, focus: 1 }));
  assert(c.getSnapshot().player.maxHp === base.player.maxHp + 30, 'не накапливается');
  c.reset();
  s = c.getSnapshot();
  assert(s.player.maxHp === base.player.maxHp + 30 && s.player.hp === s.player.maxHp, 'reset хранит улучшения');
  c.setUpgrades({});
  assert(c.getSnapshot().player.maxHp === base.player.maxHp && c.getSnapshot().player.hp === base.player.maxHp, 'снятие улучшений');
  assert(base.player.maxHp === 100, 'getConfig — база, не меняется');
});

test('combat.setUpgrades: кулдаун рывка, урон искры, щит, выброс; мусор игнорируется', () => {
  const c = createCombat({ config: {}, bossBrain: idleBrain() });
  const eff = c.setUpgrades({ dashCooldownMul: 0.7, sparkDamageMul: 1.6, shieldDrainMul: 0.7, burstDamageMul: 1.4, burstCooldownMul: 0.8, slashAngleAdd: 16, parryWindowAdd: 0.06, runSpeedMul: 1.12 });
  near(eff.dash.cooldown, 0.56, 1e-9, 'рывок');
  near(eff.spark.damage, 14 * 1.6, 1e-9, 'искра');
  near(eff.shield.drainPerSec, 25 * 0.7, 1e-9, 'щит');
  near(eff.burst.damage, 80 * 1.4, 1e-9, 'выброс');
  near(eff.slash.angleDeg, 126, 1e-9, 'дуга');
  near(eff.parry.window, 0.26, 1e-9, 'окно парирования');
  near(eff.player.runSpeed, 5.5 * 1.12, 1e-9, 'бег');
  // искра по Регенту наносит усиленный урон
  const ev = [];
  for (let i = 0; i < 90; i++) { c.update(1 / 60, I({ spark: i === 0 })); ev.push(...c.drainEvents()); }
  const hit = ev.find((e) => e.type === 'boss_hit');
  assert(hit && hit.data.amount >= 14 * 1.6 - 1e-6, 'урон искры ' + (hit && hit.data.amount));
  const g = c.setUpgrades({ maxHp: NaN, sparkDamageMul: 'x', dashCooldownMul: 0 });
  assert(g.player.maxHp === 100 && g.spark.damage === 14 && g.dash.cooldown >= 0.3, 'мусор и нижние пределы');
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed`);
if (pass !== tests.length) process.exitCode = 1;
