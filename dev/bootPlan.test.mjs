// node dev/bootPlan.test.mjs — [W5-СТАРТ] порядок старта (core/bootPlan.js): что собирается до меню, что — после.
// Сцена, рендерер и часы — фейковые: проверяется логика выбора и очереди, не скорость на железе
// (скорость — tools/load_budget.mjs).
import { menuDrawables, compileSet, createLateStart, createTrickleCompile, MENU_GROUPS } from '../core/bootPlan.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(v, msg) { if (!v) throw new Error(msg || 'ожидалось истинное значение'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ожидалось равенство'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ── фейковая сцена: узлы с visible, name, children; меши — с материалом (key — «исходник» шейдера)
function node(name, { visible = true, mesh = false, key = null, kind = 'isMesh' } = {}, children = []) {
  const o = { name, visible, children: [], parent: null };
  if (mesh) { o[kind] = true; o.material = { key: key || name }; }
  for (const c of children) { c.parent = o; o.children.push(c); }
  return o;
}
function names(list) { return list.map((o) => o.name).sort().join(','); }
function scene() {
  return node('scene', {}, [
    node('world', {}, [node('terrain', { mesh: true }), node('rock', { mesh: true }), node('hidden-ruin', { mesh: true, visible: false })]),
    node('fx-pool', { visible: false }, [node('spark', { mesh: true, kind: 'isPoints' }), node('trail', { mesh: true, kind: 'isLine' })]),
    node('hero-showcase', {}, [node('pool', { mesh: true }), node('summon', { mesh: true, visible: false })]),
    node('menu-stage', { visible: false }, [node('stone', { mesh: true }), node('menu-stage-wave', { mesh: true, visible: false })]),
    node('boss', {}, [node('regent', { mesh: true }), node('crown', { mesh: true, kind: 'isSprite' })]),
    node('empty-group', {}, [node('just-node')]),
  ]);
}

test('menuDrawables: видимое + вся сцена витрины, скрытые пулы эффектов — нет', () => {
  const s = scene();
  eq(names(menuDrawables(s)), 'crown,pool,regent,rock,stone,summon,menu-stage-wave,terrain'.split(',').sort().join(','), 'что рисует меню');
});
test('menuDrawables: сцена витрины скрыта целиком (до первого кадра меню) — всё равно в списке', () => {
  const s = scene();
  const st = s.children.find((c) => c.name === 'menu-stage');
  eq(st.visible, false, 'группа скрыта');
  ok(menuDrawables(s).some((o) => o.name === 'stone'), 'камень портала собирается до меню');
  ok(menuDrawables(s).some((o) => o.name === 'menu-stage-wave'), 'волна появления — тоже');
});
test('menuDrawables: visibleOnly=false — все рисуемые объекты сцены', () => {
  const all = menuDrawables(scene(), { visibleOnly: false });
  eq(all.length, 11, 'все меши, точки, линии и спрайты');
  ok(all.some((o) => o.name === 'spark') && all.some((o) => o.name === 'hidden-ruin'), 'в том числе скрытые');
  ok(!all.some((o) => o.name === 'just-node' || o.name === 'world'), 'группы и пустые узлы — нет');
});
test('menuDrawables: свой набор групп и пустой корень', () => {
  eq(menuDrawables(null).length, 0, 'нет сцены');
  const only = menuDrawables(scene(), { keep: ['fx-pool'] });
  ok(only.some((o) => o.name === 'spark'), 'группа из keep — целиком');
  ok(!only.some((o) => o.name === 'stone'), 'витрина не в keep — скрытая группа отброшена');
  ok(MENU_GROUPS.includes('menu-stage') && MENU_GROUPS.includes('hero-showcase'), 'группы витрины по умолчанию');
});
test('compileSet: traverse — по списку, traverseVisible — пусто (свет из сцены)', () => {
  const a = node('a', { mesh: true }), b = node('b', { mesh: true });
  const seen = [];
  const cs = compileSet([a, b]);
  cs.traverse((o) => seen.push(o.name));
  let lights = 0;
  cs.traverseVisible(() => lights++);
  eq(seen.join(','), 'a,b', 'обход списка');
  eq(lights, 0, 'источники света списка не добавляются');
  let n = 0; compileSet(null).traverse(() => n++); eq(n, 0, 'пустой список');
});

// ── отложенный старт
function lateEnv(maxMs = 15000) {
  const idleQ = [];
  const late = createLateStart({ maxMs, idle: (fn) => idleQ.push(fn) });
  const calls = [];
  return { late, idleQ, calls, flushIdle: () => { while (idleQ.length) idleQ.shift()(); } };
}
test('createLateStart: до первого кадра меню и пока грузится герой — ничего не грузится', () => {
  const { late, idleQ, calls } = lateEnv();
  late.add(() => { calls.push('boss'); });
  late.tick({ now: 1000, screen: 'menu', menuFrameAt: 0, heroBusy: true });
  late.tick({ now: 2000, screen: 'menu', menuFrameAt: 1500, heroBusy: true });
  eq(calls.length, 0, 'модули не тронуты');
  eq(idleQ.length, 0, 'простой не заказан');
  eq(late.fired, false);
  eq(late.pending, 1, 'в очереди один модуль');
});
test('createLateStart: меню показано, герой готов — старт в простое, один раз', () => {
  const { late, idleQ, calls, flushIdle } = lateEnv();
  late.add(() => { calls.push('a'); });
  late.add(() => { calls.push('b'); });
  late.tick({ now: 5000, screen: 'menu', menuFrameAt: 4000, heroBusy: false });
  late.tick({ now: 5200, screen: 'menu', menuFrameAt: 4000, heroBusy: false });
  eq(idleQ.length, 1, 'простой заказан один раз');
  eq(calls.length, 0, 'до простоя — нет');
  flushIdle();
  eq(calls.join(','), 'a,b', 'по порядку добавления');
  late.fire();
  eq(calls.length, 2, 'повторный старт ничего не повторяет');
});
test('createLateStart: уход из меню (Играть, ?demo, дуэль) — сразу, даже до первого кадра меню', () => {
  const { late, calls } = lateEnv();
  late.add(() => { calls.push('pvp'); });
  late.tick({ now: 100, screen: 'camera', menuFrameAt: 0, heroBusy: true });
  eq(calls.join(','), 'pvp');
  late.add(() => { calls.push('after'); });
  eq(calls.join(','), 'pvp,after', 'добавленное после старта грузится сразу');
});
test('createLateStart: герой грузится дольше maxMs после первого кадра меню — старт без него', () => {
  const { late, calls } = lateEnv(15000);
  late.add(() => { calls.push('x'); });
  late.tick({ now: 10000, screen: 'menu', menuFrameAt: 1000, heroBusy: true });
  eq(calls.length, 0, '9 с — ждём');
  late.tick({ now: 16500, screen: 'menu', menuFrameAt: 1000, heroBusy: true });
  eq(calls.length, 1, '15,5 с — старт');
});
test('createLateStart: onDone — когда все загрузки завершились, в том числе с ошибкой', async () => {
  const { late } = lateEnv();
  let ok1 = null, bad = null;
  const pa = new Promise((r) => { ok1 = r; });
  const pb = new Promise((r, j) => { bad = j; });
  let doneN = 0;
  late.add(() => pa);
  late.add(() => pb);
  late.add(() => { throw new Error('синхронная ошибка модуля'); });
  late.onDone(() => doneN++);
  late.fire();
  await Promise.resolve();
  eq(doneN, 0, 'загрузки ещё идут');
  ok1(); bad(new Error('сеть'));
  await new Promise((r) => setTimeout(r, 0));
  eq(doneN, 1, 'после обеих — один раз');
  let late2 = 0; late.onDone(() => late2++);
  eq(late2, 1, 'подписка после завершения вызывается сразу');
});

// ── фоновая сборка без KHR_parallel_shader_compile
function fakeRenderer() {
  const props = new Map(), cache = new Map();
  const r = {
    info: { programs: [] }, compiled: [],
    properties: { get: (m) => { if (!props.has(m)) props.set(m, {}); return props.get(m); } },
    compile(obj, cam, sc) {
      obj.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if (!cache.has(m.key)) { const p = { key: m.key }; cache.set(m.key, p); r.info.programs.push(p); r.compiled.push(m.key); }
          props.get(m) || props.set(m, {});
          r.properties.get(m).currentProgram = cache.get(m.key);
        }
      });
      return new Set();
    },
  };
  return r;
}
function sceneWith(keys) {
  const root = node('scene');
  for (const [i, k] of keys.entries()) { const m = node('m' + i, { mesh: true, key: k }); m.parent = root; root.children.push(m); }
  return root;
}
test('createTrickleCompile: по 2 новые программы за шаг, общие материалы не считаются, до конца списка', () => {
  const r = fakeRenderer();
  const sc = sceneWith(['a', 'b', 'a', 'c', 'd', 'e']);
  const steps = [];
  const tc = createTrickleCompile({ renderer: r, scene: sc, camera: {}, perStep: 2, schedule: (fn) => steps.push(fn) });
  tc.start(menuDrawables(sc, { visibleOnly: false }));
  eq(r.info.programs.length, 2, 'первый шаг: две программы');
  while (steps.length) steps.shift()();
  eq(r.compiled.join(','), 'a,b,c,d,e', 'каждая программа — один раз');
  eq(tc.done, true); eq(tc.added, 5); eq(tc.stopped, false);
});
test('createTrickleCompile: уже собранное не пересобирается; бой начался — остановка', () => {
  const r = fakeRenderer();
  const sc = sceneWith(['a', 'b', 'c', 'd', 'e', 'f']);
  r.compile(compileSet([sc.children[0]]), {}, sc);   // «a» собрана до меню
  let fight = false;
  const steps = [];
  const tc = createTrickleCompile({ renderer: r, scene: sc, camera: {}, perStep: 2, schedule: (fn) => steps.push(fn), stopped: () => fight });
  tc.start(menuDrawables(sc, { visibleOnly: false }));
  eq(r.compiled.join(','), 'a,b,c', 'b и c — первый шаг');
  fight = true;
  steps.shift()();
  eq(tc.done, true, 'остановлено');
  eq(tc.stopped, true, 'признак остановки боем');
  eq(r.compiled.length, 3, 'в бою — ничего нового');
});
test('createTrickleCompile: ошибка сборки и рендерер без compile — тихо выключается', () => {
  const r = fakeRenderer();
  r.compile = () => { throw new Error('контекст потерян'); };
  const tc = createTrickleCompile({ renderer: r, scene: sceneWith(['a']), camera: {}, schedule: () => {} });
  tc.start([sceneWith(['a']).children[0]]);
  eq(tc.done, true); ok(tc.error && /контекст/.test(tc.error.message), 'ошибка запомнена');
  const tc2 = createTrickleCompile({ renderer: { info: { programs: [] } }, schedule: () => {} });
  tc2.start([]);
  eq(tc2.done, true, 'без compile — сразу готово');
});

// ───────────────────────────── запуск ─────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`PASS ${t.name}`); }
  catch (e) { failed++; console.log(`FAIL ${t.name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 3).join('\n     ')}`); }
}
console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено.`);
process.exitCode = failed ? 1 : 0;
