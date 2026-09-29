// node dev/net-session.test.mjs — онлайн-сессия (№2 [NET], net/session.js) без DOM: «Готов» у обоих → старт у обоих
// почти одновременно (по общим часам), отмена отсчёта, st → модель соперника, snap.opponent и снаряды для эффектов.
// Нужен three (как у dev/bdo_mood.test.mjs): ASHEN_THREE=/путь/к/three.module.js; без него тест пропускается.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

let THREE = null;
try {
  THREE = process.env.ASHEN_THREE ? await import(pathToFileURL(process.env.ASHEN_THREE).href) : await import('three');
} catch (e) { THREE = null; }
if (!THREE) { console.log('net-session: пропущен (нет three: ASHEN_THREE=…/three.module.js)'); process.exit(0); }
const { createNetSession } = await import('../net/session.js');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}
function mk(name, hero) {
  const scene = new THREE.Scene();
  const ready = [];
  const settings = { netName: name, hero };
  const ns = createNetSession({
    THREE, scene, world: null, camera: null, heroFactory: null, heroes: { ashen: { id: 'ashen', name: 'Страж' }, elf: { id: 'elf', name: 'Эльфийка' } },
    settings, hooks: { saveSettings: (p) => Object.assign(settings, p), onReady: (info) => ready.push({ at: performance.now(), info }) },
  });
  return { ns, ready, scene };
}
const P = (x, z) => ({ position: { x, y: 0, z }, yaw: 0.5, velocity: { x: 3, z: 0 }, hp: 80, maxHp: 100, energy: 50, maxEnergy: 100, action: 'move', locomotion: 'walk', shielding: true });

await t('«Готов» у обоих → старт у обоих, разница < 60 мс; снятие «Готов» отменяет отсчёт', async () => {
  const A = mk('Аида', 'elf'), B = mk('Бекзат', 'ashen');
  const code = await A.ns.host('local');
  assert.ok(code, 'код комнаты');
  assert.equal(await B.ns.join('local', code), true);
  assert.ok(await until(() => A.ns.net.state === 'connected' && B.ns.net.state === 'connected'));
  await sleep(700);                                         // пара ping/pong — смещение часов готово
  // отмена: оба готовы, гость передумал во время отсчёта
  A.ns.setReady(true); B.ns.setReady(true);
  await sleep(800);
  B.ns.setReady(false);
  await sleep(3500);
  assert.equal(A.ready.length + B.ready.length, 0, 'старт должен отмениться');
  // настоящий старт
  B.ns.setReady(true);
  assert.ok(await until(() => A.ready.length === 1 && B.ready.length === 1, 5000), `${A.ready.length} ${B.ready.length}`);
  assert.ok(Math.abs(A.ready[0].at - B.ready[0].at) < 60, `разница ${Math.abs(A.ready[0].at - B.ready[0].at).toFixed(0)} мс`);
  assert.equal(A.ready[0].info.isHost, true); assert.equal(B.ready[0].info.isHost, false);
  assert.equal(B.ready[0].info.opponent.name, 'Аида');
  A.ns.leave(); B.ns.leave();
});

await t('кадр: st → модель соперника, события и снаряды — в эффекты, snap.opponent', async () => {
  const A = mk('Хост', 'ashen'), B = mk('Гость', 'elf');
  const code = await A.ns.host('local');
  await B.ns.join('local', code);
  assert.ok(await until(() => A.ns.net.state === 'connected'));
  const snapA = { status: 'playing', player: P(5, 7), projectiles: [{ id: 'p1', owner: 'player', kind: 'bolt', position: { x: 5, y: 1.3, z: 7 }, velocity: { x: 0, y: 0, z: 20 }, radius: 0.3 }] };
  const evA = [{ id: 'ev1', type: 'player_cast', position: { x: 5, y: 1.3, z: 7 }, data: { ability: 'spark', projectileId: 'p1' } },
    { id: 'ev2', type: 'player_dash', position: { x: 5, y: 0, z: 7 }, data: {} }];
  const snapB = { status: 'playing', player: P(0, 0), projectiles: [] };
  let out = null, sawCast = false, sawDash = false, sawProj = false;
  for (let i = 0; i < 40; i++) {
    const now = performance.now();
    A.ns.frame(1 / 60, now, snapA, {}, i === 0 ? evA : []);
    out = B.ns.frame(1 / 60, now, snapB, {}, []);
    for (const e of out.events) { if (e.type === 'player_cast' && e.data.remote) sawCast = true; if (e.type === 'player_dash') sawDash = true; }
    if (out.snapshot.projectiles.some((p) => p.id === 'r:p1' && p.owner === 'opponent')) sawProj = true;
    await sleep(25);
  }
  assert.ok(sawCast, 'событие соперника с data.remote');
  assert.ok(!sawDash, 'рывок соперника в effects не идёт, пока нет effects.supportsRemote');
  assert.ok(sawProj, 'снаряд соперника в снимке для эффектов');
  const opp = out.snapshot.opponent;
  assert.ok(opp && Math.abs(opp.position.x - 5) < 0.6 && Math.abs(opp.position.z - 7) < 0.6, JSON.stringify(opp && opp.position));
  assert.equal(opp.name, 'Хост'); assert.equal(opp.shielding, true); assert.equal(opp.hp, 80);
  assert.equal(B.ns.getOpponent().name, 'Хост');
  // вне боя (снимка нет) соперник скрыт
  B.ns.frame(1 / 60, performance.now(), null, {}, []);
  assert.equal(B.ns.remote.root.visible, false);
  A.ns.leave(); B.ns.leave();
});

console.log(`\nnet-session: ${pass} проверок пройдено${process.exitCode ? ', ЕСТЬ ОШИБКИ' : ''}`);
setTimeout(() => process.exit(process.exitCode || 0), 100);
