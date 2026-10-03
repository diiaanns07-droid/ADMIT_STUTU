// [W5-ПОЛ] node-тест: герои стоят на полу и не «плывут» по высоте. Без браузера, на настоящих моделях
// (assets/heroes/*.glb) и клипах KayKit — тот же путь, что в игре: vrmKit.retargetClip → heroModel (посадка,
// микшер, слой поз heroPoses, наклон обёртки, подошва не ниже пола).
//   1. Перенос клипов: в кадрах, где стопа источника стоит, подошва цели на полу (не ниже, не выше 3 см) — у всех
//      клипов библиотеки и всех трёх моделей; в полёте (бег, прыжок, подскок рывка) — не ниже пола; таз без рывков
//      (шов цикла ≤ 1 мм, рывок за ключ — не больше чем на 3 см сверх переноса без поправки). Подошва кадра
//      (soleLowFast, по нормализованным костям) — та же, что скиннингом сетки (±0,1 мм), и без аллокаций.
//   2. Каждый из пяти героев по кругу: витрина меню, покой, ходьба, бег, рывок, касты, щит, сфера, «Небесный суд»,
//      удары по герою, победа, поражение, снова покой; смены героев между кругами, третий круг — герой повёрнут.
//      Подошва никогда не глубже 2 см под полом; стоя — |подошва − пол| ≤ 2 см; колено и голень — не ниже пола,
//      в поражении обе стопы на полу; носок не разворачивается рывком; таз и подошва в покое в конце — там же.
//      Остановка после бега, стрейфа, ходьбы — с первого кадра покоя подошва на полу (±2 см).
//   3. low / high: то же для покоя и победы; пол сцены выше корня (витрина) — подошва на нём.
//   4. Корень героя по земле (modules/rootFollow.js, и у соперника в дуэли): склон — без отставания, и в рывке;
//      ступень арены — плавно.
// three.js: ASHEN_THREE или vendor/ (как остальные тесты); 'three/addons/' и '@pixiv/three-vrm' — из vendor/.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VEND = join(HERE, '../vendor/npm');
const THREE_PATH = [process.env.ASHEN_THREE, join(VEND, 'three@0.185.1/build/three.module.min.js')].find((p) => p && existsSync(p));
assert.ok(THREE_PATH, 'three.js не найден (vendor/npm/three@0.185.1 или ASHEN_THREE)');
// импорты как importmap index.html: одна копия three на тест, загрузчик GLTF и three-vrm
const MAP = {
  three: pathToFileURL(THREE_PATH).href,
  addons: pathToFileURL(join(VEND, 'three@0.185.1/examples/jsm/')).href,
  vrm: pathToFileURL(join(VEND, '@pixiv/three-vrm@3.5.5/lib/three-vrm.module.min.js')).href,
};
register('data:text/javascript,' + encodeURIComponent(`const M = ${JSON.stringify(MAP)};
export async function resolve(s, c, n) {
  if (s === 'three') return { url: M.three, shortCircuit: true };
  if (s.startsWith('three/addons/')) return { url: M.addons + s.slice(13), shortCircuit: true };
  if (s === '@pixiv/three-vrm') return { url: M.vrm, shortCircuit: true };
  return n(s, c);
}`));
// модели и клипы — с диска (fetch по file:), GLTFLoader берёт URL у self; картинки текстур в node не нужны
const fetch0 = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (!s.startsWith('file:')) return fetch0(u, o);
  const b = readFileSync(fileURLToPath(s));
  return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};
globalThis.self = globalThis;
const quiet = { error: console.error, warn: console.warn };
const noise = [];
console.error = (...a) => noise.push(a.join(' ')); console.warn = (...a) => noise.push(a.join(' '));

const THREE = await import('three');
const K = await import('../modules/vrmKit.js');
const HM = await import('../modules/heroModel.js');
const { clone } = await import('three/addons/utils/SkeletonUtils.js');
const HEROES_URL = pathToFileURL(join(HERE, '../assets/heroes/')).href;
const bytes = (f) => { const b = readFileSync(join(HERE, '../assets/heroes', f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const TOL = 0.02;
// бесшовные циклы KayKit, которые игра играет по кругу (heroModel: покой, ходьба, бег, стрейфы, щит, победа);
// прицел из лука (2H_Ranged_Aiming) на краях — разные позы таза и ног (51–60°), бесшовным его не считаем
const LOOPED = /^(Idle|Unarmed_Idle|Walking_|Running_|Spellcasting$|Blocking$|Cheer|2H_Melee_Idle)/;
const cm = (x) => `${(x * 100).toFixed(1)} см`;
const out = [];
const log = (m) => out.push(m);

// ---------------------------------------------------------------- 1. перенос клипов: опора на полу
{
  const loader = await K.createGltfLoader();
  const lib = await loader.parseAsync(bytes('anims_kaykit.glb'), '');
  const src = clone(lib.scene);
  // опора источника — как в retargetClip: голеностоп и носок над своим покоем (нижняя из четырёх точек)
  const byName = (n) => src.getObjectByName(n) || src.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  src.updateMatrixWorld(true);
  const sf = ['foot.l', 'toes.l', 'foot.r', 'toes.r'].map((n) => byName(n)).filter(Boolean);
  assert.equal(sf.length, 4, 'у KayKit есть кости стоп и носков');
  const sf0 = sf.map((o) => o.getWorldPosition(new THREE.Vector3()).y);
  const hips0 = byName('hips').getWorldPosition(new THREE.Vector3()).y;
  const v = new THREE.Vector3();
  for (const f of ['knight.glb', 'ranger.glb', 'wizard.glb']) {
    const vrm = await K.loadHumanoidGLB(THREE, HEROES_URL + f, undefined, bytes(f));
    const m = K.soleMarkers(THREE, vrm);
    assert.ok(m && m.L.length >= 3 && m.R.length >= 3, `${f}: точки подошвы обеих стоп`);
    // подошва в покое — низ модели (пол модели), точки — на ней
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    assert.ok(Math.abs(m.restY - box.min.y) < 0.01, `${f}: подошва в покое — низ модели (${cm(m.restY)} и ${cm(box.min.y)})`);
    assert.ok(m.knee && m.knee.nodes.length >= 2, `${f}: точки колена и голени обеих ног`);
    let worst = { c: 0, f: 0, seam: 0, spike: 0 };
    for (const clip of lib.animations) {
      const rc = K.retargetClip(THREE, clip, src, vrm, 30, 'kaykit');
      // таз: шов зацикленного клипа — как у переноса без поправки (≤ 1 мм), рывок за ключ (вторая разность) —
      // не больше чем на 3 см сверх переноса без поправки
      const r0 = K.retargetClip(THREE, clip, src, vrm, 30, 'kaykit', { ground: false });
      const yy = (c) => { const v = c.tracks.find((t) => t.name.endsWith('.position')).values; return (i) => v[i * 3 + 1]; };
      const y1 = yy(rc), y0 = yy(r0), nk = rc.tracks[0].times.length, name = clip.name.split('|').pop();
      if (LOOPED.test(name)) {
        const seam = Math.abs(y1(0) - y1(nk - 1));
        worst.seam = Math.max(worst.seam, seam);
        assert.ok(seam <= Math.abs(y0(0) - y0(nk - 1)) + 0.001, `${f} «${name}»: на шве цикла таз прыгает на ${cm(seam)}`);
      }
      let s0 = 0, s1 = 0;
      for (let i = 1; i + 1 < nk; i++) { s0 = Math.max(s0, Math.abs(y0(i) - (y0(i - 1) + y0(i + 1)) / 2)); s1 = Math.max(s1, Math.abs(y1(i) - (y1(i - 1) + y1(i + 1)) / 2)); }
      worst.spike = Math.max(worst.spike, s1 - s0);
      assert.ok(s1 - s0 <= 0.03, `${f} «${name}»: рывок таза за ключ ${cm(s1)} против ${cm(s0)} без поправки`);
      const contact = rc.userData && rc.userData.contact;
      assert.ok(contact && contact.length === nk, `${f} «${name}»: кадры касания`);
      const mixS = new THREE.AnimationMixer(src), aS = mixS.clipAction(clip);
      aS.setLoop(THREE.LoopOnce, 1); aS.clampWhenFinished = true; aS.play();
      const mixT = new THREE.AnimationMixer(vrm.scene), aT = mixT.clipAction(rc);
      aT.play();
      // ключевые кадры клипа (касание — на них) и середины между ними (там — только «не ниже пола»)
      const keys = Array.from(rc.tracks[0].times), ts = [];
      for (let i = 0; i < keys.length; i++) { ts.push([keys[i], true]); if (i + 1 < keys.length && i % 3 === 0) ts.push([(keys[i] + keys[i + 1]) / 2, false]); }
      for (const [t, key] of ts) {
        const ki = key ? keys.indexOf(t) : -1;
        mixS.setTime(t); src.updateMatrixWorld(true);
        mixT.setTime(t); vrm.humanoid.update(); vrm.scene.updateMatrixWorld(true);
        const lift = Math.min(...sf.map((o, j) => o.getWorldPosition(v).y - sf0[j]));
        const gap = K.soleHeightSkinned(m) - m.restY;
        worst.fast = Math.max(worst.fast || 0, Math.abs(K.soleHeightFast(m) - m.restY - gap));
        // касание (стопа источника стоит, и кадр не отброшен как ложный): подошва на полу — не ниже и не выше 3 см (поправка
        // таза сглажена: шум высоты подошвы не уходит в таз; до 2,5 см — удар стопы на бегу); полёт и между кадрами — не ниже пола
        const touch = key && lift <= K.CONTACT * hips0 && contact[ki];
        if (touch) worst.c = Math.max(worst.c, Math.abs(gap)); else worst.f = Math.min(worst.f, gap);
        assert.ok(!touch || gap <= 0.03, `${f} «${name}» t=${t.toFixed(2)}: касание, а подошва ${cm(gap)} над полом`);
        // на ключевых кадрах подошва не ниже пола; между ними (линейная смесь двух поз при смене опорной ноги) — до 2 см
        assert.ok(gap >= (key ? -0.006 : -TOL), `${f} «${clip.name}» t=${t.toFixed(2)}: подошва под полом на ${cm(-gap)}`);
      }
      aS.stop(); mixS.uncacheRoot(src); aT.stop(); mixT.uncacheRoot(vrm.scene);
      vrm.humanoid.resetNormalizedPose(); vrm.humanoid.update();
    }
    assert.ok(m.fast && worst.fast < 1e-4, `${f}: подошва по нормализованным костям расходится со скиннингом на ${(worst.fast * 1000).toFixed(3)} мм`);
    log(`перенос ${f}: ${lib.animations.length} клипов, касание — до ${cm(worst.c)} от пола, полёт — не ниже ${cm(worst.f)}; быстрая подошва — до ${(worst.fast * 1000).toFixed(3)} мм от скиннинга; шов цикла — до ${cm(worst.seam)}, рывок таза сверх переноса — до ${cm(worst.spike)}`);
    if (f === 'wizard.glb') {
      // без аллокаций в кадре: 50 000 вызовов — ни одной сборки мусора и куча почти не растёт
      const { PerformanceObserver } = await import('node:perf_hooks');
      let gcs = 0;
      const ob = new PerformanceObserver((l) => { gcs += l.getEntries().length; });
      ob.observe({ entryTypes: ['gc'] });
      const res = new Float64Array(3);
      for (let i = 0; i < 5000; i++) K.soleLowFast(m, res);
      await new Promise((r) => setTimeout(r, 20));
      gcs = 0;
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 50000; i++) K.soleLowFast(m, res);
      const dh = process.memoryUsage().heapUsed - h0;
      await new Promise((r) => setTimeout(r, 20));
      ob.disconnect();
      // любая аллокация в вызове — от 16 Б (800 КБ за 50 000); холодный старт JIT даёт до ~100 КБ шума без сборок
      assert.ok(gcs === 0 && dh < 50000 * 4, `soleLowFast аллоцирует: сборок мусора ${gcs}, куча +${(dh / 1024).toFixed(0)} КБ за 50 000 вызовов`);
      log(`быстрая подошва: 50 000 вызовов — сборок мусора ${gcs}, куча +${(dh / 1024).toFixed(1)} КБ`);
    }
  }
}

// ---------------------------------------------------------------- 2. пять героев по кругу (medium)
HM.configureHeroes({ quality: 'medium', shading: 'realistic' });
const model = HM.createHeroModel({ THREE, hero: HM.HERO_ORDER[0], quality: 'medium', heroesUrl: HEROES_URL, baseUrl: pathToFileURL(join(HERE, '../assets/quaternius/')).href });
model.setGround(() => 0);   // земля мира ровная — путь «стопа на ступени» проходит в каждом кадре и ничего не меняет
async function ready(id) {
  for (let i = 0; i < 4000 && !(model.ready && model.hero === id); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(model.ready && model.hero === id, `герой ${id} загрузился (${noise.slice(-3).join(' | ')})`);
}
const DT = 1 / 30;
const P = { x: 0, z: 0, yaw: 0 };
function snap({ vx = 0, vz = 0, action = 'idle', status = 'playing', ult = null, hold = {}, sprint = 0 } = {}) {
  P.x += vx * DT; P.z += vz * DT;
  return { status, ultimate: ult, player: { position: { x: P.x, y: 0, z: P.z }, yaw: P.yaw, velocity: { x: vx, y: 0, z: vz }, action, hp: 80, maxHp: 100, sprint, ...hold } };
}
// кадр: обновление модели и замер подошвы (пол — корень героя, y = 0, плюс подъём пола сцены)
function step(s, ev = [], floor = 0, legs = false) {
  model.update(DT, s, ev);
  const f = model.feet({ legs });
  return { gap: f.sole - floor, hips: f.hips, sole: f.sole, gapL: f.soleL - floor, gapR: f.soleR - floor, knee: f.knee === null ? NaN : f.knee - floor, legLow: f.legLow === null ? NaN : f.legLow - floor, yawL: f.toeYawL, yawR: f.toeYawR };
}
// сценарий одного героя: [название, кадров, снимок(i), события(i), стоя?]
const ev = (type, data = {}) => [{ type, data }];
const SCRIPT = [
  ['меню', 120, () => null, (i) => (i === 30 ? 'flourish' : []), true],
  ['покой', 120, () => snap(), () => [], true],
  ['ходьба', 90, () => snap({ vz: 2, action: 'move' }), () => [], false],
  ['бег', 90, () => snap({ vz: 5, action: 'move' }), () => [], false],
  ['спринт', 60, () => snap({ vz: 8, action: 'move', sprint: 1 }), () => [], false],
  ['стрейф', 60, () => snap({ vx: 4, action: 'move' }), () => [], false],
  ['назад', 45, () => snap({ vz: -2, action: 'move' }), () => [], false],
  ['рывок', 30, () => snap({ action: 'dash' }), (i) => (i === 0 ? ev('player_dash', { worldDirection: { x: 0, z: 1 } }) : []), false],
  ['выброс', 45, () => snap({ action: 'cast' }), (i) => (i === 0 ? ev('burst') : []), true],
  ['врата бури', 45, () => snap({ action: 'cast' }), (i) => (i === 0 ? ev('sigil_cast', { sigil: 'gate' }) : []), true],
  ['столп небес', 45, () => snap({ action: 'cast' }), (i) => (i === 0 ? ev('sigil_cast', { sigil: 'pillar' }) : []), true],
  ['залп', 30, () => snap({ action: 'cast' }), (i) => (i % 10 === 0 ? ev('player_cast', { ability: 'bolt' }) : []), true],
  ['руна', 45, () => snap({ action: 'cast' }), (i) => (i === 0 ? ev('rune_cast') : []), true],
  ['бросок сферы', 30, () => snap({ action: 'cast' }), (i) => (i === 0 ? ev('hand_spell_throw', { dir: { x: 0.3, y: 0 } }) : []), true],
  ['щит', 45, () => snap({ action: 'shield', hold: { shielding: true } }), (i) => (i === 0 ? ev('shield_start') : []), true],
  ['сфера', 45, (i) => snap({ action: 'conjure', hold: { conjure: { charge: i / 45 } } }), () => [], true],
  ['небесный суд', 108, (i) => snap({ action: 'cast', ult: { active: true, t: i * DT, strikeAt: 2.3 } }), (i) => (i === 0 ? ev('ultimate_start') : []), true],
  ['удары', 45, () => snap({ action: 'hit' }), (i) => (i % 15 === 0 ? ev('player_hit', { amount: 25, direction: { x: 1, z: 0 } }) : []), true],
  ['победа', 120, () => snap({ status: 'victory' }), () => [], true],
  ['покой после победы', 45, () => snap(), () => [], true],
  ['поражение', 120, () => snap({ status: 'defeat', action: 'dead' }), () => [], true],
  ['снова покой', 120, () => snap(), () => [], true],
];
// окна стойки: меню и покой — где вес «действия» отыгран (первые 0,5 с перехода не берём)
const idleStat = (rows) => { const r = rows.slice(15); const mean = (k) => r.reduce((a, x) => a + x[k], 0) / r.length; return { gap: mean('gap'), hips: mean('hips') }; };
const first = {};
let worstSink = { v: 0 }, worstStand = { v: 0 }, worstKnee = { v: 0 }, worstToe = { v: 0 };
// третий круг — герой повёрнут на 1,2 рад (поворот стопы не должен сбиваться на оси мира)
const TOE_PHASES = new Set(['меню', 'покой', 'выброс', 'удары', 'победа', 'поражение', 'снова покой']);
for (const [round, ids, yaw] of [[1, HM.HERO_ORDER, 0], [2, [...HM.HERO_ORDER].reverse(), 0], [3, ['ashen', 'elf', 'archmage'], 1.2]]) {
  for (const id of ids) {
    model.setHero(id);
    await ready(id);
    P.x = 0; P.z = 0; P.yaw = yaw;
    const seen = {};
    for (const [name, n, mk, evs, standing] of SCRIPT) {
      const rows = [];
      for (let i = 0; i < n; i++) {
        const e = evs(i);
        if (e === 'flourish') { model.flourish(); }
        const r = step(mk(i), Array.isArray(e) ? e : [], 0, name === 'поражение' && i >= 45);
        rows.push(r);
        assert.ok(Number.isFinite(r.gap) && Number.isFinite(r.hips), `${id} «${name}»: замер`);
        if (-r.gap > worstSink.v) worstSink = { v: -r.gap, id, name, i };
        assert.ok(r.gap >= -TOL, `${id} «${name}» кадр ${i}: подошва в полу на ${cm(-r.gap)}`);
        if (standing && i >= 8) {
          if (Math.abs(r.gap) > worstStand.v) worstStand = { v: Math.abs(r.gap), id, name, i };
          assert.ok(Math.abs(r.gap) <= TOL, `${id} «${name}» кадр ${i}: стоя, а подошва ${cm(r.gap)} от пола`);
        }
        // колено и голень не ниже пола (поза на колене); в поражении — обе стопы на полу (опорная и носок колена)
        assert.ok(Number.isFinite(r.knee), `${id} «${name}»: нет точек колена`);
        assert.ok(r.knee >= -TOL, `${id} «${name}» кадр ${i}: колено в полу на ${cm(-r.knee)}`);
        if (name === 'поражение' && i >= 45) {
          // на колене: обе стопы на полу, нижняя вершина ног (полный скиннинг, не те же точки) — не глубже 2 см
          assert.ok(Math.max(r.gapL, r.gapR) <= TOL, `${id} поражение кадр ${i}: стопа над полом — L ${cm(r.gapL)}, R ${cm(r.gapR)}`);
          if (-r.legLow > worstKnee.v) worstKnee = { v: -r.legLow, id, name, i };
          assert.ok(r.legLow >= -TOL, `${id} поражение кадр ${i}: колено (сетка ног) в полу на ${cm(-r.legLow)}`);
        }
        // носок не мечется: разворот стопы относительно взгляда героя за кадр — меньше 20°
        const pr = rows.length > 1 ? rows[rows.length - 2] : null;
        if (pr && TOE_PHASES.has(name)) {
          const dy = Math.max(Math.abs(r.yawL - pr.yawL), Math.abs(r.yawR - pr.yawR));
          if (dy > worstToe.v) worstToe = { v: dy, id, name, i, yaw };
          assert.ok(dy < 20, `${id} «${name}» кадр ${i} (поворот ${yaw}): носок развернулся за кадр на ${dy.toFixed(0)}°`);
        }
      }
      seen[name] = rows;
    }
    // дрейф: покой в конце круга — там же, где в начале, и на втором круге (после смен героев) — там же, где на первом
    const a = idleStat(seen['покой']), b = idleStat(seen['снова покой']);
    // (таз в покое и так «дышит»: смена опорной ноги ±1–2 см, дыхание — окна сравниваем по среднему с допуском 1 см)
    assert.ok(Math.abs(a.gap - b.gap) < 0.003 && Math.abs(a.hips - b.hips) < 0.01, `${id}: покой в конце круга сдвинулся — подошва ${cm(b.gap - a.gap)}, таз ${cm(b.hips - a.hips)}`);
    if (round === 1) first[id] = a;
    else assert.ok(Math.abs(first[id].gap - a.gap) < 0.003 && Math.abs(first[id].hips - a.hips) < 0.01, `${id}: после смен героев покой сдвинулся — подошва ${cm(a.gap - first[id].gap)}, таз ${cm(a.hips - first[id].hips)}`);
    log(`круг ${round} ${id}: покой ${cm(a.gap)} → ${cm(b.gap)}, таз ${a.hips.toFixed(3)} → ${b.hips.toFixed(3)} м`);
  }
}
log(`medium: глубже всего ${cm(worstSink.v)} (${worstSink.id || '—'} «${worstSink.name || ''}»), стоя — до ${cm(worstStand.v)} от пола (${worstStand.id} «${worstStand.name}»)`);
log(`колено в поражении (сетка ног): глубже всего ${cm(worstKnee.v)} (${worstKnee.id || '—'} «${worstKnee.name || ''}»); носок за кадр — до ${worstToe.v.toFixed(1)}° (${worstToe.id} «${worstToe.name}», поворот ${worstToe.yaw})`);
P.yaw = 0;

// ---------------------------------------------------------------- остановка: бег, стрейф, ходьба → покой
// Клип бега в фазе полёта подмешан к покою (таз выше) — стопы висели на 2–12 см 0,2–0,3 с; посадка (groundFeet) опускает
// модель: с первого кадра покоя |подошва − пол| ≤ 2 см. Разная фаза шага на остановке; шаг кадра 1/30 и 1/15 с.
{
  let worst = { v: 0 };
  for (const id of ['ashen', 'dark', 'archmage']) {
    model.setHero(id); await ready(id);
    for (const dt of [1 / 30, 1 / 15]) {
      for (const [name, vx, vz] of [['бег', 0, 5], ['стрейф', 4, 0], ['ходьба', 0, 2], ['назад', 0, -2]]) {
        for (let off = 0; off < 6; off++) {
          const go = (vx2, vz2) => { P.x += vx2 * dt; P.z += vz2 * dt; return { status: 'playing', ultimate: null, player: { position: { x: P.x, y: 0, z: P.z }, yaw: 0, velocity: { x: vx2, y: 0, z: vz2 }, action: vx2 || vz2 ? 'move' : 'idle', hp: 80, maxHp: 100 } }; };
          for (let i = 0; i < Math.round(0.6 / dt) + off; i++) model.update(dt, go(vx, vz), []);
          for (let i = 0; i < Math.round(0.5 / dt); i++) {
            model.update(dt, go(0, 0), []);
            const g = model.feet().sole;
            if (Math.abs(g) > worst.v) worst = { v: Math.abs(g), id, name, off, i, dt };
            assert.ok(Math.abs(g) <= TOL, `${id} ${name} → покой (+${off}, кадр ${i}, шаг ${dt.toFixed(3)} с): подошва ${cm(g)} от пола`);
          }
        }
      }
    }
  }
  log(`остановка (бег, стрейф, ходьба, назад → покой): подошва до ${cm(worst.v)} от пола (${worst.id} ${worst.name})`);
}

// ---------------------------------------------------------------- ступень арены: корень ниже земли
// world сглаживает подъём корня на ступень (0,33 м за ~0,2 с), земля из снимка (combat: LAY.groundY) — уже наверху:
// подошва — на ступени, а не в ней. Второй экземпляр героя на своём корне (как heroRoot мира).
{
  const hr = new THREE.Group();
  const m2 = HM.createHeroModel({ THREE, heroRoot: hr, hero: 'ranger', quality: 'medium', heroesUrl: HEROES_URL, baseUrl: pathToFileURL(join(HERE, '../assets/quaternius/')).href });
  for (let i = 0; i < 4000 && !(m2.ready && m2.hero === 'ranger'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(m2.ready, 'второй герой загрузился');
  const at = (y) => ({ status: 'playing', ultimate: null, player: { position: { x: 0, y, z: 0 }, yaw: 0, velocity: { x: 0, y: 0, z: 0 }, action: 'idle', hp: 80, maxHp: 100 } });
  for (let i = 0; i < 30; i++) m2.update(DT, at(0), []);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 12; i++) {
    hr.position.y = 0.33 * (1 - Math.exp(-16 * (i + 1) * DT));   // корень догоняет ступень
    m2.update(DT, at(0.33), []);
    const g = m2.feet().sole - 0.33;
    lo = Math.min(lo, g); hi = Math.max(hi, g);
  }
  assert.ok(lo >= -TOL && hi <= TOL, `ступень 0,33 м: подошва ${cm(lo)}…${cm(hi)} от её верха`);
  log(`ступень арены (корень догоняет 0,2 с): подошва ${cm(lo)}…${cm(hi)} от верха ступени`);
  // ступень под одной стопой: земля 0,3 м слева от героя (+x), корень и центр — внизу. Левая стопа — на ступени
  // (IK ноги), правая — на полу, модель не поднимается целиком
  hr.position.y = 0;
  m2.setGround((x) => (x > 0.03 ? 0.3 : 0));
  let wl = { lo: Infinity, hi: -Infinity }, wr = { lo: Infinity, hi: -Infinity };
  for (let i = 0; i < 45; i++) {
    m2.update(DT, at(0), []);
    if (i < 10) continue;
    const f = m2.feet();
    wl.lo = Math.min(wl.lo, f.soleL - 0.3); wl.hi = Math.max(wl.hi, f.soleL - 0.3);
    wr.lo = Math.min(wr.lo, f.soleR); wr.hi = Math.max(wr.hi, f.soleR);
  }
  assert.ok(wl.lo >= -TOL && wl.hi <= TOL, `стопа на ступени: левая подошва ${cm(wl.lo)}…${cm(wl.hi)} от верха ступени`);
  assert.ok(wr.lo >= -TOL && wr.hi <= TOL, `стопа на ступени: правая подошва ${cm(wr.lo)}…${cm(wr.hi)} от пола`);
  m2.setGround(null);
  m2.dispose();
  log(`ступень под одной стопой: левая ${cm(wl.lo)}…${cm(wl.hi)} от ступени, правая ${cm(wr.lo)}…${cm(wr.hi)} от пола`);
}

// ---------------------------------------------------------------- долгий покой: таз не уплывает за 2 минуты
{
  const id = HM.HERO_ORDER[1];
  model.setHero(id); await ready(id);
  const hips = [];
  for (let i = 0; i < 3600; i++) { const r = step(i % 1200 < 600 ? null : snap()); hips.push(r.hips); assert.ok(r.gap >= -TOL, `${id}: 2 мин покоя, кадр ${i}: подошва в полу на ${cm(-r.gap)}`); }
  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const h0 = m(hips.slice(700, 1200)), h1 = m(hips.slice(3100, 3600));
  assert.ok(Math.abs(h1 - h0) < 0.01, `${id}: таз за 2 мин сдвинулся на ${cm(h1 - h0)}`);
  log(`2 мин ${id}: таз ${h0.toFixed(4)} → ${h1.toFixed(4)} м`);
}

// ---------------------------------------------------------------- 3. low / high и пол сцены
for (const q of ['low', 'high']) {
  model.setQuality(q);
  for (const id of ['ashen', 'ranger']) {
    model.setHero(id); await ready(id);
    for (const [name, n, mk] of [['меню', 90, () => null], ['покой', 90, () => snap()], ['бег', 60, () => snap({ vz: 5, action: 'move' })], ['победа', 90, () => snap({ status: 'victory' })], ['поражение', 120, () => snap({ status: 'defeat', action: 'dead' })]]) {
      for (let i = 0; i < n; i++) {
        const r = step(mk(i));
        assert.ok(r.gap >= -TOL, `${q} ${id} «${name}» кадр ${i}: подошва в полу на ${cm(-r.gap)}`);
        if (name !== 'бег' && i >= 30) assert.ok(Math.abs(r.gap) <= TOL, `${q} ${id} «${name}» кадр ${i}: стоя, а подошва ${cm(r.gap)} от пола`);
      }
    }
  }
}
model.setQuality('medium');
{
  // витрина: пол сцены на 1,2 см выше корня — подошва на нём, а не под ним
  model.setFloorLift(0.012);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 90; i++) { const r = step(null, [], 0.012); if (i >= 2) { lo = Math.min(lo, r.gap); hi = Math.max(hi, r.gap); } }
  assert.ok(lo >= -0.003 && hi <= TOL, `пол витрины +1,2 см: подошва ${cm(lo)}…${cm(hi)} от него`);
  model.setFloorLift(0);
  log(`пол витрины: подошва ${cm(lo)}…${cm(hi)} от него`);
}
model.dispose();

// ---------------------------------------------------------------- 4. корень героя по земле (modules/rootFollow.js)
{
  const { followRootY } = await import('../modules/world.js');
  // склон: подъём 1,6 м/с (спринт в гору 20%) — корень на земле в каждом кадре, без отставания
  const st = { rootY: NaN, groundY: NaN };
  let y = 0, lag = 0;
  for (let i = 0; i < 120; i++) { y += 1.6 / 60; followRootY(st, y, 1 / 60); lag = Math.max(lag, y - st.rootY); }
  assert.ok(lag < 1e-6, `склон: корень отстаёт на ${cm(lag)}`);
  // ступень арены 0,3 м — сглажена (не телепорт), за 0,3 с догоняет
  followRootY(st, y + 0.3, 1 / 60);
  assert.ok(st.rootY < y + 0.3 - 0.1, 'ступень: корень не прыгает на 0,3 м за кадр');
  for (let i = 0; i < 18; i++) followRootY(st, y + 0.3, 1 / 60);
  assert.ok(Math.abs(st.rootY - (y + 0.3)) < 0.02, `ступень: догнал за 0,3 с (${cm(y + 0.3 - st.rootY)})`);
  // рывок вверх по склону 15%: 3,6 м за 0,22 с (easeOutQuad, как combat) — корень на земле (порог — от пройденного)
  const R = await import('../modules/rootFollow.js');
  assert.equal(R.followRootY, followRootY, 'world.followRootY — та же функция, что у соперника (modules/rootFollow.js)');
  const sd = { rootY: NaN, groundY: NaN };
  let dlag = 0, px = 0;
  for (let i = 0; i <= 14; i++) {
    const u = Math.min(1, (i / 60) / 0.22), x = 3.6 * (1 - (1 - u) * (1 - u));
    followRootY(sd, 0.15 * x, 1 / 60, x - px); px = x;
    dlag = Math.max(dlag, 0.15 * x - sd.rootY);
  }
  assert.ok(dlag < 0.01, `рывок по склону: корень отстаёт на ${cm(dlag)}`);
  // ступень 0,3 м шагом (0,08 м за кадр) — по-прежнему плавно
  const sw = { rootY: 0, groundY: 0 };
  followRootY(sw, 0.3, 1 / 60, 0.08);
  assert.ok(sw.rootY < 0.2, 'ступень при ходьбе: корень не прыгает');
  log(`корень: склон без отставания (и в рывке: ${cm(dlag)}), ступень 0,3 м — плавно`);
}
console.error = quiet.error; console.warn = quiet.warn;
for (const m of out) console.log('  ' + m);
console.log('heroGround.test: ok');
