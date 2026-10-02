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

// ---------------------------------------------------------------- cinemaFeed: события боя → импульсы
const { createCinemaFeed, CINE } = await import('../core/cinemaFeed.js');
function makeFeed() {
  const calls = [];
  const feed = createCinemaFeed({
    pulse: (kind, k, pos, o) => { calls.push({ kind, k, pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, color: o ? o.color : undefined, dur: o ? o.dur : undefined }); return true; },
    now: () => 0,
  });
  return { feed, calls };
}
const snapT = (time, py = 0) => ({ status: 'playing', time, player: { position: { x: 0, y: py, z: 6 } }, boss: { maxHp: 1000 } });
const ev = (type, data = {}, position = { x: 0, y: 1.4, z: 6 }) => ({ id: type + Math.random(), type, position, data });
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

await test('cinemaFeed: прежние реакции (ранение, рывок, удары Регента, выброс), события соперника — мимо', async () => {
  const { feed, calls } = makeFeed();
  feed.feed([
    ev('player_hit', { amount: 20 }),
    ev('player_dash', {}, { x: 1, y: 0, z: 2 }),
    ev('perfect_dodge'),
    ev('boss_impact', { attackKind: 'slam' }, { x: 0, y: 0, z: 0 }),
    ev('boss_impact', { attackKind: 'nova' }, { x: 0, y: 0, z: 0 }),
    ev('boss_impact', { attackKind: 'slam', launch: true }),
    ev('boss_impact', { attackKind: 'orb' }),
    ev('burst', { power: 1 }, { x: 0, y: 2, z: 0 }),
    ev('player_hit', { amount: 30, remote: true }),
  ], snapT(1));
  const kinds = calls.map((c) => c.kind).join(',');
  ok(kinds === 'hurt,dash,dash,shockwave,shockwave,shockwave', kinds);
  ok(near(calls[0].k, 0.45 + 20 / 40), 'ранение по урону ' + calls[0].k);
  ok(near(calls[1].k, 0.6) && near(calls[1].pos.y, 1.2), 'рывок от груди героя');
  ok(near(calls[2].k, 1), 'идеальный рывок');
  ok(near(calls[3].k, 0.75) && near(calls[4].k, 1), 'slam 0,75, nova 1');
  ok(near(calls[5].k, 1), 'выброс полным зарядом');
});

await test('cinemaFeed: «Врата бури» — вспышка и волна у ног, волны по пути, у Регента волна и тёплая вспышка (по времени боя)', async () => {
  const { feed, calls } = makeFeed();
  const from = { x: 0, y: 1.4, z: 9 }, to = { x: 0, y: 2.5, z: 0 };
  feed.feed([ev('sigil_cast', { sigil: 'gate', power: 1, eta: 0.6, reach: true, from, to }, from)], snapT(10, 0));
  ok(calls.length === 2 && calls[0].kind === 'flash' && calls[0].color === CINE.gate.castColor, 'тёплая вспышка сразу ' + JSON.stringify(calls[0]));
  ok(calls[1].kind === 'shockwave' && near(calls[1].pos.y, CINE.gate.groundLift) && near(calls[1].pos.z, 9), 'волна у ног героя ' + JSON.stringify(calls[1]));
  // пауза: время боя стоит — ничего не срабатывает
  for (let i = 0; i < 30; i++) feed.feed([], snapT(10, 0));
  ok(calls.length === 2 && feed.debug().pending === 4, 'в паузе ждём ' + JSON.stringify(feed.debug()));
  feed.feed([], snapT(10.2, 0));
  ok(calls.length === 3 && calls[2].kind === 'shockwave' && near(calls[2].pos.z, 9 - 9 * 0.33, 1e-4) && near(calls[2].pos.y, CINE.gate.groundLift), 'первая волна пути ' + JSON.stringify(calls[2]));
  feed.feed([], snapT(10.4, 0));
  ok(calls.length === 4 && near(calls[3].pos.z, 9 - 9 * 0.66, 1e-4), 'вторая волна пути');
  feed.feed([], snapT(10.6, 0));
  const hit = calls.slice(4).map((c) => c.kind).sort().join(',');
  ok(hit === 'flash,shockwave', 'у цели ' + hit);
  const fl = calls.slice(4).find((c) => c.kind === 'flash');
  ok(fl.color === CINE.gate.hitColor && near(fl.pos.z, 0), 'тёплая вспышка у Регента');
  ok(feed.debug().pending === 0, 'очередь пуста');
});

await test('cinemaFeed: «Врата бури» не долетели — sigil_miss снимает остаток пути; попадание раньше таймера играет удар сразу и один раз', async () => {
  const { feed, calls } = makeFeed();
  const from = { x: 0, y: 1.4, z: 30 }, to = { x: 0, y: 2.5, z: 0 };
  feed.feed([ev('sigil_cast', { sigil: 'gate', power: 0.5, eta: 1.8, reach: false, from, to }, from)], snapT(5));
  ok(feed.debug().pending === 2, 'без удара — только путь ' + feed.debug().pending);
  feed.feed([], snapT(5.7));   // первая волна пути (0,59 с)
  const n = calls.length;
  feed.feed([ev('sigil_miss', { sigil: 'gate' }, to)], snapT(5.9));
  ok(feed.debug().pending === 0 && calls.length === n, 'остаток пути снят');
  // долетели, boss_hit пришёл на кадр раньше таймера
  calls.length = 0;
  feed.feed([ev('sigil_cast', { sigil: 'gate', power: 1, eta: 0.5, reach: true, from: { x: 0, y: 1.4, z: 8 }, to }, from)], snapT(6));
  calls.length = 0;
  feed.feed([ev('boss_hit', { sigil: 'gate', source: 'sigil', amount: 60 }, to)], snapT(6.49));
  const kinds = calls.map((c) => c.kind).sort().join(',');
  ok(kinds === 'flash,punch,shockwave', 'удар сразу + рывок крупного урона: ' + kinds);
  feed.feed([], snapT(7));
  ok(calls.length === 3 && feed.debug().pending === 0, 'по таймеру ещё раз не играет');
});

await test('cinemaFeed: «Столп небес» — бело-голубая засветка и волна у Регента в момент удара (delay), раньше — по boss_hit', async () => {
  const { feed, calls } = makeFeed();
  const to = { x: 1, y: 2.5, z: -1 };
  feed.feed([ev('sigil_cast', { sigil: 'pillar', power: 1, delay: 0.45, reach: true, to })], snapT(20));
  ok(calls.length === 0, 'до удара — ничего');
  feed.feed([], snapT(20.4));
  ok(calls.length === 0, 'ещё рано');
  feed.feed([], snapT(20.45));
  const fl = calls.find((c) => c.kind === 'flash'), sw = calls.find((c) => c.kind === 'shockwave');
  ok(fl && sw && calls.length === 2, 'засветка и волна ' + JSON.stringify(calls));
  ok(fl.color === CINE.pillar.color && near(fl.k, CINE.pillar.flash + CINE.pillar.flashP), 'бело-голубая, по силе жеста');
  ok(near(sw.pos.x, 1) && near(sw.pos.z, -1) && near(sw.k, CINE.pillar.wave), 'волна у Регента');
  // boss_hit пришёл раньше таймера: сразу, один раз
  calls.length = 0;
  feed.feed([ev('sigil_cast', { sigil: 'pillar', power: 0.5, delay: 0.45, to })], snapT(30));
  feed.feed([ev('boss_hit', { sigil: 'pillar', source: 'sigil', amount: 30 }, to)], snapT(30.43));
  ok(calls.map((c) => c.kind).sort().join(',') === 'flash,shockwave', 'сразу по попаданию ' + calls.map((c) => c.kind));
  feed.feed([], snapT(31));
  ok(calls.length === 2, 'и не повторяется');
  // промах столпа (Регент дальше range) — удар всё равно виден
  calls.length = 0;
  feed.feed([ev('sigil_cast', { sigil: 'pillar', delay: 0.45, reach: false, to })], snapT(40));
  feed.feed([ev('sigil_miss', { sigil: 'pillar' }, to)], snapT(40.45));
  ok(calls.length === 2 && feed.debug().pending === 0, 'промах — тоже удар');
});

await test('cinemaFeed: крупный урон → punch, мелкий и ультимейт — нет; ultimate_strike → ultimate, без второй кинорамки', async () => {
  const { feed, calls } = makeFeed();
  const p = { x: 0, y: 2.5, z: 0 };
  feed.feed([ev('boss_hit', { amount: 14, source: 'spark' }, p), ev('boss_hit', { amount: 44, source: 'rune' }, p)], snapT(1));
  ok(calls.length === 0, 'до 45 — без рывка');
  feed.feed([ev('boss_hit', { amount: 45, source: 'rune' }, p), ev('boss_hit', { amount: 200, source: 'burst' }, p)], snapT(1));
  ok(calls.length === 2 && near(calls[0].k, CINE.bigHit.k0) && near(calls[1].k, CINE.bigHit.k1), 'рывок по урону ' + calls.map((c) => c.k));
  calls.length = 0;
  feed.feed([
    ev('ultimate_start', { duration: 3.6, strikeAt: 2.3 }),
    ev('ultimate_strike', { amount: 300 }, p),
    ev('boss_hit', { amount: 300, source: 'ultimate', ultimate: true }, p),
    ev('ultimate_end', { struck: true }),
  ], snapT(2));
  ok(calls.length === 1 && calls[0].kind === 'ultimate' && near(calls[0].pos.y, 2.5), 'одна «ultimate», без bars и без рывка ' + JSON.stringify(calls));
});

await test('cinemaFeed: новый бой сбрасывает очередь, переполнение не роняет, мусор игнорируется', async () => {
  const { feed, calls } = makeFeed();
  feed.feed([ev('sigil_cast', { sigil: 'pillar', delay: 0.45, to: { x: 0, y: 2, z: 0 } })], snapT(50));
  feed.feed([], snapT(0.01));   // новый бой: время с нуля
  feed.feed([], snapT(1));
  ok(calls.length === 0 && feed.debug().pending === 0, 'удар прошлого боя не сыграл');
  for (let i = 0; i < 12; i++) feed.feed([ev('sigil_cast', { sigil: 'gate', eta: 1, reach: true, from: { x: 0, y: 1, z: 9 }, to: { x: 0, y: 2, z: 0 } })], snapT(1 + i * 0.01));
  ok(feed.debug().pending <= CINE.slots && feed.debug().dropped > 0, 'вытеснение ' + JSON.stringify(feed.debug()));
  feed.feed([null, 5, {}, { type: 'sigil_cast' }, { type: 'sigil_cast', data: { sigil: 'gate' } }, { type: 'boss_hit', data: null, position: null }, { type: 'player_dash' }], null);
  feed.feed(undefined, undefined);
  ok(true);
});

await test('cinemaFeed + postfx (low): импульсы доходят до настоящего postfx', async () => {
  const { post } = makePost('low');
  await post.whenReady;
  const feed = createCinemaFeed({ pulse: (kind, k, pos, o) => post.pulse(kind, k, pos, o) });
  feed.feed([ev('player_hit', { amount: 40 })], snapT(1));
  ok(post.info().fx.hurt > 0.99, 'ранение ' + post.info().fx.hurt);
  feed.feed([ev('sigil_cast', { sigil: 'pillar', power: 1, delay: 0.45, to: { x: 0, y: 2, z: 0 } })], snapT(2));
  feed.feed([], snapT(2.5));
  ok(post.info().fx.flash > 0.85 && post.info().fx.last.kind === 'flash', 'засветка столпа ' + JSON.stringify(post.info().fx));
  post.dispose();
});

// ---------------------------------------------------------------- atmosphere: цвет фаз и гроза второй фазы
const { createAtmosphere, STORM } = await import('../modules/atmosphere.js');
function makeAtmo(quality = 'medium', reducedMotion = false) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 1200);
  camera.position.set(0, 3, 10); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
  const renderer = { toneMappingExposure: 1 };   // PMREM упадёт мягко (нет WebGL)
  const atmo = createAtmosphere({ THREE, scene, renderer, camera, parent: scene, quality, reducedMotion });
  const heard = [];
  atmo.setStormListener((type, k) => heard.push({ type, k }));
  return { scene, atmo, heard };
}
const runAtmo = (atmo, sec, info) => { let out = null; for (let t = 0; t < sec; t += 1 / 60) out = atmo.update(1 / 60, info); return out; };
const P1 = { stageW: 0, status: 'playing' }, P2 = { stageW: 1, status: 'playing' };

await test('atmosphere.look и setPhaseBoost: postfx получает веса фаз, рывок сцены перехода — сразу', async () => {
  const { atmo } = makeAtmo();
  ok(atmo.look && typeof atmo.setPhaseBoost === 'function' && typeof atmo.setStormListener === 'function', 'API');
  runAtmo(atmo, 1, P1);
  ok(atmo.look.red < 0.01 && atmo.look.dawn === 0, 'фаза 1 ' + JSON.stringify(atmo.look));
  atmo.setPhaseBoost(1);
  runAtmo(atmo, 1 / 60, P1);
  ok(atmo.look.red > 0.99, 'рывок сразу ' + atmo.look.red);
  atmo.setPhaseBoost(0);
  runAtmo(atmo, 1 / 60, P1);
  ok(atmo.look.red < 0.05, 'снят ' + atmo.look.red);
  runAtmo(atmo, 8, { stageW: 1, status: 'victory' });
  ok(atmo.look.dawn > 0.9 && atmo.look.red < 0.05, 'победа — рассвет ' + JSON.stringify(atmo.look));
  atmo.dispose();
});

await test('гроза второй фазы (medium): тучи набирают вес, первая молния вскоре, гром позже и по одному на молнию, дымка видна', async () => {
  const { atmo, heard, scene } = makeAtmo('medium');
  runAtmo(atmo, 5, P1);
  ok(atmo.storm.w === 0 && atmo.storm.bolts === 0 && atmo.storm.haze === 0, 'фаза 1 без грозы ' + JSON.stringify(atmo.storm));
  ok(!scene.getObjectByName('storm-haze').visible, 'дымка скрыта в фазе 1 (0 draw calls)');
  let tFirst = -1;
  for (let t = 0; t < 25; t += 1 / 60) { atmo.update(1 / 60, P2); if (tFirst < 0 && atmo.storm.bolts > 0) tFirst = t; }
  const s = atmo.storm;
  ok(s.w > 0.95 && s.hq, 'вес грозы ' + JSON.stringify(s));
  ok(tFirst > 0 && tFirst < 3.5, 'первая молния вскоре после перехода: ' + tFirst.toFixed(2));
  ok(s.bolts >= 3, 'молнии идут ' + s.bolts);
  const bolts = heard.filter((h) => h.type === 'bolt').length, th = heard.filter((h) => h.type === 'thunder').length;
  ok(bolts === s.bolts && th >= bolts - 1 && th <= bolts, `гром на каждую молнию: ${bolts}/${th}`);
  ok(heard[0].type === 'bolt' && heard[1].type === 'thunder', 'сначала свет, потом звук');
  ok(heard.every((h) => h.k > 0 && h.k <= 1.25), 'сила в разумных пределах');
  ok(s.haze === STORM.haze.medium && scene.getObjectByName('storm-haze').visible, 'дымка medium ' + s.haze);
  atmo.setQuality('high');
  runAtmo(atmo, 1 / 60, P2);
  ok(atmo.storm.haze === STORM.haze.high, 'дымка high ' + atmo.storm.haze);
  // победа: рассвет разгоняет тучи
  runAtmo(atmo, 12, { stageW: 1, status: 'victory' });
  ok(atmo.storm.w < 0.05 && atmo.storm.haze === 0, 'тучи ушли ' + JSON.stringify(atmo.storm));
  atmo.dispose();
  ok(!scene.getObjectByName('storm-haze'), 'dispose убрал дымку');
});

await test('гроза на low — только цвет; reducedMotion — без молний; в лесу (настроение зоны) — без грозы', async () => {
  const L = makeAtmo('low');
  runAtmo(L.atmo, 20, P2);
  ok(L.atmo.storm.w > 0.9 && !L.atmo.storm.hq, 'цвет грозы есть ' + JSON.stringify(L.atmo.storm));
  ok(L.atmo.storm.bolts === 0 && L.heard.length === 0 && L.atmo.storm.haze === 0, 'ни молний, ни дымки на low');
  L.atmo.dispose();
  const R = makeAtmo('high', true);
  runAtmo(R.atmo, 20, P2);
  ok(R.atmo.storm.bolts === 0 && R.heard.length === 0, 'reducedMotion — без вспышек');
  ok(R.atmo.storm.haze === STORM.haze.high, 'дымка остаётся');
  R.atmo.dispose();
  const F = makeAtmo('high');
  F.atmo.setZoneMood({ weight: 1 });
  runAtmo(F.atmo, 10, P2);
  ok(F.atmo.storm.w < 0.05 && F.atmo.storm.bolts === 0, 'в лесу гроза не видна ' + JSON.stringify(F.atmo.storm));
  F.atmo.dispose();
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
  // пауза посреди сцены замораживает её (рёв, рамка и наезд не «проигрываются» за панелью паузы)
  const fin3 = createBossFinale({ THREE, scene: new THREE.Scene(), world: makeWorld().world, quality: 'medium' });
  fin3.update(1 / 60, 1 / 60, s2, [{ id: 'p1', type: 'boss_phase', data: { stage: 2 } }], 'playing');
  for (let t = 0; t < 3; t += 1 / 60) fin3.update(0, 1 / 60, s2, [], 'paused');
  ok(fin3.active && fin3.debug().phase < 0.05, 'сцена стоит на паузе ' + fin3.debug().phase);
  for (let t = 0; t < 1.6; t += 1 / 60) fin3.update(1 / 60, 1 / 60, s2, [], 'playing');
  ok(!fin3.active, 'после паузы доигрывается');
  fin3.dispose();
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
  // выход в меню после победы — осколки убраны
  fin.update(1 / 60, 1 / 60, sv, [], 'menu');
  ok(fin.debug().shards === 0 && fin.debug().death === null, 'меню убирает финал');
  fin.update(1 / 60, 1 / 60, sv, [{ id: 'v2', type: 'victory', data: {} }], 'playing');
  for (let t = 0; t < 1; t += 1 / 60) fin.update(1 / 60, 1 / 60, sv, [], 'victory');
  ok(fin.debug().shards > 0, 'новая победа — снова осколки');
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
