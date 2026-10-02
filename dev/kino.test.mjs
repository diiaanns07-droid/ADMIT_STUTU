// [W3-КИНО] Тесты экранных импульсов core/postfx.js (pulse, queueShockwave, setLook, наложение low)
// и сцен Регента modules/fx/bossFinale.js (переход в фазу 2, гибель, сброс, дуэль).
// node dev/kino.test.mjs
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE
// (…/three/build/three.module.js). Если three не найден, тест пропускается (код выхода 0).

import { pathToFileURL } from 'node:url';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  if (process.env.ASHEN_THREE) { try { THREE = await import(pathToFileURL(process.env.ASHEN_THREE).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP kino: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const postfxMod = await import('../core/postfx.js');
const { createPostFX, pulse, queueShockwave } = postfxMod;
const { createBossFinale, FINALE } = await import('../modules/fx/bossFinale.js');

let pass = 0, fail = 0;
const results = [];
const live = [];   // экземпляры postfx: убираются и при упавшей проверке (иначе модульный pulse видит «чужих»)
async function test(name, fn) {
  try { await fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.stack}`); }
  finally { while (live.length) live.pop().dispose(); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const warn = console.warn; console.warn = () => {};

// Рендерер-заглушка: без WebGL композер не строится (нет float-буферов) — postfx идёт обычным путём + наложение.
function fakeRenderer() {
  const calls = [];
  const r = {
    calls, autoClear: true, toneMappingExposure: 1,
    info: { autoReset: true, reset() { r.info.render.calls = 0; }, render: { calls: 0, triangles: 0 } },
    extensions: { has: () => false },
    getSize(v) { return v.set(640, 360); },
    getPixelRatio: () => 1,
    render(obj) { calls.push({ obj, autoClear: r.autoClear }); r.info.render.calls++; },
    setRenderTarget() {}, getRenderTarget: () => null,
  };
  return r;
}
function makePost(q = 'low') {
  const renderer = fakeRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 500);
  camera.position.set(0, 3, 9); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
  const post = createPostFX({ THREE, renderer, scene, camera, quality: q });
  live.push(post);
  return { renderer, scene, camera, post };
}

await test('API: pulse/setLook/setCinema есть, модульные pulse и queueShockwave экспортированы', async () => {
  const { post } = makePost();
  await post.whenReady;
  ok(typeof post.pulse === 'function' && typeof post.setLook === 'function' && typeof post.setCinema === 'function', 'методы');
  ok(typeof pulse === 'function' && typeof queueShockwave === 'function', 'модульные функции');
  ok(post.pulse('нет-такого', 1) === false, 'неизвестный вид — false');
  ok(post.pulse('hurt', 0) === false, 'нулевая сила — false');
  post.dispose();
});

await test('ранение, засветка и кинорамка живут в реальном времени и гаснут', async () => {
  const { post } = makePost();
  await post.whenReady;
  ok(post.pulse('hurt', 0.8) === true, 'hurt принят');
  ok(post.pulse('flash', 1, null, { color: 0xff0000, dur: 0.2 }) === true, 'flash принят');
  ok(post.pulse('bars', 1, null, { hold: 0.5 }) === true, 'bars принят');
  let fx = post.info().fx;
  ok(fx.hurt > 0.79 && fx.flash > 0.99, 'сразу после импульса ' + JSON.stringify(fx));
  for (let i = 0; i < 30; i++) post.render(1 / 60);   // 0,5 с
  fx = post.info().fx;
  ok(fx.hurt < 0.4 && fx.hurt > 0, 'ранение гаснет ' + fx.hurt);
  ok(fx.flash < 0.15, 'засветка гаснет ' + fx.flash);
  ok(fx.bars > 0.8, 'рамка выехала ' + fx.bars);
  for (let i = 0; i < 120; i++) post.render(1 / 60);
  fx = post.info().fx;
  ok(fx.hurt < 0.01 && fx.flash < 0.01, 'всё погасло ' + JSON.stringify(fx));
  ok(fx.bars < 0.01, 'рамка уехала после hold ' + fx.bars);
  post.dispose();
});

await test('засветка без стробоскопа: повтор в 0,2 с вдвое слабее; reducedMotion — без волн и рывков', async () => {
  const { post } = makePost();
  await post.whenReady;
  post.pulse('flash', 1);
  for (let i = 0; i < 60; i++) post.render(1 / 60);
  post.pulse('flash', 1);
  post.render(1 / 60);
  post.pulse('flash', 1);   // через 1 кадр — подавлена до 0,5 (меньше текущей → не перезаписывает)
  ok(post.info().fx.flash <= 1.0001, 'не больше 1');
  post.setReducedMotion(true);
  ok(post.pulse('dash', 1) === false, 'рывок выключен');
  ok(post.pulse('shockwave', 1, { x: 0.5, y: 0.5 }) === false, 'волна выключена');
  for (let i = 0; i < 60; i++) post.render(1 / 60);
  post.pulse('flash', 1);
  ok(Math.abs(post.info().fx.flash - 0.5) < 1e-6, 'засветка вдвое слабее ' + post.info().fx.flash);
  post.dispose();
});

await test('low: обычный кадр + одно наложение, счётчики кадра честные, autoClear и autoReset восстановлены', async () => {
  const { post, renderer, scene } = makePost('low');
  await post.whenReady;
  post.setLook({ red: 1 });
  for (let i = 0; i < 90; i++) post.render(1 / 60);   // вес боевого грейда набирается
  renderer.calls.length = 0;
  post.render(1 / 60);
  ok(renderer.calls.length === 2, 'сцена + наложение: ' + renderer.calls.length);
  ok(renderer.calls[0].obj === scene, 'сначала сцена');
  ok(renderer.calls[1].autoClear === false, 'наложение без очистки');
  ok(renderer.autoClear === true && renderer.info.autoReset === true, 'состояние рендерера восстановлено');
  ok(renderer.info.render.calls === 2, 'calls за кадр = 2: ' + renderer.info.render.calls);
  // меню: боевой грейд уходит, наложение не рисуется вовсе (как раньше на low)
  post.setMode('menu');
  for (let i = 0; i < 240; i++) post.render(1 / 60);
  renderer.calls.length = 0;
  post.render(1 / 60);
  ok(renderer.calls.length === 1, 'в меню только сцена: ' + renderer.calls.length);
  post.dispose();
});

await test('модульный pulse доходит до живого экземпляра и не доходит после dispose', async () => {
  const { post } = makePost();
  await post.whenReady;
  ok(pulse('hurt', 0.6) === true, 'доставлен');
  ok(post.info().fx.hurt > 0.59, 'hurt выставлен');
  post.dispose();
  ok(pulse('hurt', 0.6) === false, 'после dispose — никому');
  ok(queueShockwave(0.5, 0.5, 1) === false, 'волна без живого postfx — false');
});

await test('две формы вызова: pulse(kind, strength, pos, opts) и pulse(kind, { x, y, strength, … }) (ультимейт)', async () => {
  const { post } = makePost();
  await post.whenReady;
  const near = (a, b, m) => ok(Math.abs(a - b) < 1e-6, `${m}: ${a} ≠ ${b}`);
  // форма ультимейта: сила и точка в одном объекте
  ok(post.pulse('dash', { x: 0.2, y: 0.7, strength: 0.6 }) === true, 'объектная форма принята');
  let fx = post.info().fx;
  near(fx.dash, 0.6, 'сила из объекта');
  near(fx.last.x, 0.2, 'x из объекта'); near(fx.last.y, 0.7, 'y из объекта');
  // прежняя форма даёт то же самое
  for (let i = 0; i < 120; i++) post.render(1 / 60);
  ok(post.pulse('dash', 0.6, { x: 0.2, y: 0.7 }) === true, 'прежняя форма принята');
  fx = post.info().fx;
  near(fx.dash, 0.6, 'та же сила'); near(fx.last.x, 0.2, 'тот же x'); near(fx.last.y, 0.7, 'тот же y');
  // ровно как зовёт ультимейт: вспышка и волна по точке удара
  const n0 = fx.last.n;
  ok(post.pulse('flash', { x: 0.31, y: 0.62, strength: 1 }) === true, 'flash ультимейта');
  fx = post.info().fx;
  ok(fx.flash > 0.99 && fx.last.kind === 'flash' && fx.last.n === n0 + 1, 'засветка ' + JSON.stringify(fx.last));
  near(fx.last.x, 0.31, 'точка вспышки x'); near(fx.last.y, 0.62, 'точка вспышки y');
  // без strength — 1; опции (цвет, hold) из того же объекта; точка в .at
  for (let i = 0; i < 120; i++) post.render(1 / 60);
  ok(post.pulse('hurt', { at: [0.1, 0.9] }) === true && post.info().fx.hurt > 0.99, 'сила по умолчанию 1');
  near(post.info().fx.last.x, 0.1, '.at как точка');
  ok(post.pulse('bars', { strength: 0.8, hold: 0.2 }) === true, 'кинорамка из объекта');
  for (let i = 0; i < 12; i++) post.render(1 / 60);
  ok(post.info().fx.bars > 0.2, 'рамка выезжает ' + post.info().fx.bars);
  for (let i = 0; i < 120; i++) post.render(1 / 60);
  ok(post.info().fx.bars < 0.01, 'и уезжает после hold из объекта ' + post.info().fx.bars);
  // мировая точка в объекте проецируется; за спиной камеры рывок не ставится
  ok(post.pulse('dash', { x: 0, y: 2, z: 0, strength: 1 }) === true, 'мировая точка перед камерой');
  ok(Math.abs(post.info().fx.last.x - 0.5) < 0.02, 'проекция в центр ' + post.info().fx.last.x);
  for (let i = 0; i < 120; i++) post.render(1 / 60);
  ok(post.pulse('dash', { x: 0, y: 3, z: 30, strength: 1 }) === false, 'за спиной камеры — нет');
  // модульный pulse пропускает объектную форму как есть
  ok(pulse('hurt', { strength: 0.7 }) === true, 'модульный pulse');
  // ultimate: засветка гаснет медленнее обычной (0,5 с против 0,24 с), в том числе из объектной формы
  for (let i = 0; i < 240; i++) post.render(1 / 60);
  post.pulse('ultimate', { x: 0.5, y: 0.6, strength: 1 });
  for (let i = 0; i < 15; i++) post.render(1 / 60);
  const fUlt = post.info().fx.flash;
  for (let i = 0; i < 240; i++) post.render(1 / 60);
  post.pulse('flash', { strength: 1 });
  for (let i = 0; i < 15; i++) post.render(1 / 60);
  ok(fUlt > post.info().fx.flash * 1.5, `ult гаснет медленнее: ${fUlt} vs ${post.info().fx.flash}`);
  // повтор ультимейта и вспышки ультимейта тем же кадром (обе подписки) — засветка не удваивается
  for (let i = 0; i < 240; i++) post.render(1 / 60);
  post.pulse('ultimate', 1, { x: 0.5, y: 0.6 });
  post.pulse('flash', { x: 0.5, y: 0.6, strength: 1 });
  ok(post.info().fx.flash <= 1.0001, 'засветка ≤ 1: ' + post.info().fx.flash);
  post.dispose();
});

await test('мусор на входе не роняет', async () => {
  const { post } = makePost();
  await post.whenReady;
  for (const a of [[null], [undefined, NaN], ['flash', 'x', 'y'], ['bars', -1], ['hurt', Infinity, [NaN, 2]], ['shockwave', 1, { x: 1, y: 2, z: 3 }], ['dash', 1, [0.2, 0.3]]]) post.pulse(...a);
  post.setLook(null); post.setLook({ red: 'a', dawn: -5, dark: 9 });
  for (let i = 0; i < 10; i++) post.render(NaN);
  ok(true);
  post.dispose();
});

// ---------------------------------------------------------------- bossFinale
function makeWorld() {
  const body = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), new THREE.MeshBasicMaterial());
  m.position.y = 3; body.add(m);
  const lava = [], boosts = [], flashes = [];
  let shattered = 0;
  const world = {
    bossFx: {
      setLava(front, boost) { lava.push([front, boost]); },
      shatter() { shattered++; body.visible = false; },
      get body() { return body; },
      origin(out) { return out.set(0, 3, 0); },
    },
    atmosphere: { setPhaseBoost(k) { boosts.push(k); }, flash(k) { flashes.push(k); } },
    getAnchors: () => ({ bossCore: { x: 0, y: 3, z: 0 } }),
  };
  return { world, body, lava, boosts, flashes, get shattered() { return shattered; } };
}
const snapOf = (o = {}) => ({ status: 'playing', mode: 'boss', boss: { hp: 500, maxHp: 1000, stage: 1, position: { x: 0, y: 0, z: 0 } }, player: { position: { x: 0, y: 0, z: 6 } }, ...o });

await test('переход в фазу 2: замедление 1,5 с, лава бежит от ядра, рёв, небо багровеет, потом всё как было', async () => {
  const W = makeWorld();
  const scene = new THREE.Scene();
  const cues = [], shakes = [];
  const fin = createBossFinale({ THREE, scene, world: W.world, cue: (n) => cues.push(n), shake: (k) => shakes.push(k), quality: 'medium' });
  ok(fin.timeScale() === 1, 'до события — 1');
  const s2 = snapOf({ boss: { hp: 480, maxHp: 1000, stage: 2, position: { x: 0, y: 0, z: 0 } } });
  fin.update(1 / 60, 1 / 60, s2, [{ id: 'e1', type: 'boss_phase', data: { stage: 2, from: 1 } }]);
  ok(fin.active, 'сцена идёт');
  let minTs = 1;
  for (let t = 0; t < 1.6; t += 1 / 60) { fin.update(1 / 60, 1 / 60, s2, []); minTs = Math.min(minTs, fin.timeScale()); }
  ok(minTs < 0.3, 'замедление ' + minTs);
  ok(fin.timeScale() === 1 && !fin.active, 'после 1,5 с — обычное время');
  ok(cues.includes('boss_nova'), 'рёв ' + cues);
  ok(shakes.length >= 2, 'тряска');
  const fronts = W.lava.filter((l) => l[0] !== null).map((l) => l[0]);
  ok(fronts[0] < 0.1 && Math.max(...fronts) > 0.99, 'фронт лавы 0 → 1');
  ok(W.lava[W.lava.length - 1][0] === null, 'управление лавой вернулось world');
  ok(Math.max(...W.boosts) > 0.99, 'небо багровеет рывком');
  // повтор того же события и пробуждение во вступлении — не запускают сцену
  fin.update(1 / 60, 1 / 60, s2, [{ id: 'e1', type: 'boss_phase', data: { stage: 2 } }, { id: 'x', type: 'boss_phase', data: { stage: 1, awaken: true } }]);
  ok(!fin.active, 'дубликат/пробуждение игнорируются');
  fin.dispose();
  ok(scene.children.length === 0, 'dispose убрал группу');
});

await test('гибель Регента: перегрев → осколки и пепел по уровню качества → облёт камеры → сброс в новом бою', async () => {
  const W = makeWorld();
  const scene = new THREE.Scene();
  const fin = createBossFinale({ THREE, scene, world: W.world, quality: () => 'high' });
  const sv = snapOf({ status: 'victory', boss: { hp: 0, maxHp: 1000, stage: 2, position: { x: 0, y: 0, z: 0 } } });
  fin.update(1 / 60, 1 / 60, sv, [{ id: 'v', type: 'victory', data: {} }]);
  ok(fin.debug().death !== null && !fin.debug().shattered, 'перегрев до раскола');
  for (let t = 0; t < 0.7; t += 1 / 60) fin.update(1 / 240, 1 / 60, sv, []);   // боевое время в замедлении
  const d = fin.debug();
  ok(d.shattered && W.shattered === 1, 'тело рассыпалось один раз');
  ok(d.shards === FINALE.q.high.shards && d.embers === FINALE.q.high.embers, 'частицы high ' + JSON.stringify(d));
  ok(W.body.visible === false, 'тело скрыто');
  // камера: облёт набирает вес
  const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 500);
  cam.position.set(0, 3, 8); cam.lookAt(0, 2, 0);
  for (let t = 0; t < 1.2; t += 1 / 60) { fin.update(1 / 60, 1 / 60, sv, []); fin.applyCamera(cam, 1 / 60); }
  ok(fin.debug().camW > 0.99, 'облёт ' + fin.debug().camW);
  ok(Number.isFinite(cam.position.x) && Math.hypot(cam.position.x, cam.position.z) <= 10.6, 'камера в арене');
  // осколки падают и остывают, но остаются лежать
  for (let t = 0; t < 8; t += 1 / 60) fin.update(1 / 60, 1 / 60, sv, []);
  ok(fin.debug().shards > 0, 'осколки лежат');
  // новый бой: Регент жив, стадия 1 — всё сброшено
  fin.update(1 / 60, 1 / 60, snapOf(), []);
  const r = fin.debug();
  ok(r.death === null && r.shards === 0 && r.embers === 0 && r.camW === 0, 'сброс ' + JSON.stringify(r));
  fin.dispose();
});

await test('low: меньше осколков; дуэль и мусор не запускают сцен', async () => {
  const W = makeWorld();
  const scene = new THREE.Scene();
  const fin = createBossFinale({ THREE, scene, world: W.world, quality: 'low' });
  const pvp = snapOf({ mode: 'pvp', status: 'victory' });
  fin.update(1 / 60, 1 / 60, pvp, [{ id: 'p', type: 'victory', data: {} }, { id: 'q', type: 'boss_phase', data: { stage: 2 } }]);
  ok(!fin.active, 'дуэль — без сцен');
  fin.update(NaN, undefined, null, [null, 5, {}]);
  const sv = snapOf({ status: 'victory', boss: { hp: 0, maxHp: 1000, stage: 2, position: { x: 1, y: 0, z: 2 } } });
  for (let t = 0; t < 1; t += 1 / 60) fin.update(1 / 60, 1 / 60, sv, []);   // победа без события — по снимку
  ok(fin.debug().shards === FINALE.q.low.shards, 'low ' + fin.debug().shards);
  // мир без bossFx/atmosphere — ничего не падает
  const fin2 = createBossFinale({ THREE, scene, world: {}, quality: 'medium' });
  fin2.update(1 / 60, 1 / 60, snapOf({ boss: { hp: 400, maxHp: 1000, stage: 2 } }), [{ id: 'z', type: 'boss_phase', data: { stage: 2 } }]);
  for (let t = 0; t < 2; t += 1 / 60) fin2.update(1 / 60, 1 / 60, sv, []);
  ok(fin2.debug().shattered, 'без мира тоже рассыпается (точки вокруг ядра)');
  fin.dispose(); fin2.dispose();
});

console.warn = warn;
for (const r of results) console.log(r);
console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
