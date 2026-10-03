// ASHEN OATH — [W5-СТАРТ] порядок старта: что нужно меню сразу, а что — после него.
// Замер (tools/load_budget.mjs, профиль Chrome): до первого кадра меню собирались шейдеры всей сцены, включая нужные
// только в бою, а модули боя, камеры и дуэли грузились и строились вместе с героем на витрине. Здесь — правила, по
// которым main.js делит старт на «до меню» и «после меню».
//
// menuDrawables(root, { visibleOnly = true, keep = MENU_GROUPS }) → [Object3D]
//   Что рисует меню: видимые вместе с родителями объекты (без отсечения по кадру — витрина облетает героя) и всё внутри
//   групп keep, даже скрытое (сцена витрины скрыта до первого кадра меню, столп призыва и волна появления — до поры).
//   visibleOnly = false — все рисуемые объекты (пулы эффектов, магия рук, сцены Регента).
// compileSet(list) → объект для renderer.compile / compileAsync(obj, camera, scene): материалы — по traverse списка,
//   свет — из сцены (traverseVisible у списка пустой).
// createLateStart({ maxMs, idle }) → { add(load), tick(st), fire(), onDone(fn), get fired, get pending }
//   Отложенный старт. add(load) — load() вызовется после меню (или сразу, если старт уже был). tick({ now, screen,
//   menuFrameAt, heroBusy }) раз в ~200 мс: ушли из меню — старт сразу; первый кадр меню показан и герой не грузится —
//   в простое (idle); герой грузится дольше maxMs после первого кадра меню — всё равно старт. onDone(fn) — после того,
//   как все load() завершились (успешно или нет).
// createTrickleCompile({ renderer, scene, camera, perStep, gapMs, schedule, stopped }) → { start(list), step(), get done, get added }
//   Сборка шейдеров без KHR_parallel_shader_compile — по perStep новых программ за шаг: renderer.compile только ставит
//   сборку в очередь GPU-процесса, главный поток её не ждёт. stopped() → true (бой начался) — остановка: дальше, как
//   раньше, — при первом показе. schedule(fn, ms) — следующий шаг (в игре — таймер + requestIdleCallback).

export const MENU_GROUPS = Object.freeze(['hero-showcase', 'menu-stage']);

const drawable = (o) => !!((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o.material);

export function menuDrawables(root, { visibleOnly = true, keep = MENU_GROUPS } = {}) {
  const out = [];
  if (!root) return out;
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  const walk = (o, all) => {
    const inKeep = all || keepSet.has(o.name);
    if (!inKeep && visibleOnly && !o.visible) return;
    if (drawable(o)) out.push(o);
    const ch = o.children || [];
    for (let i = 0; i < ch.length; i++) walk(ch[i], inKeep);
  };
  walk(root, false);
  return out;
}

export function compileSet(list) {
  const items = Array.isArray(list) ? list : [];
  return {
    isCompileSet: true,
    traverse(fn) { for (let i = 0; i < items.length; i++) fn(items[i]); },
    traverseVisible() { /* свет — из сцены */ },
  };
}

export function createLateStart({ maxMs = 15000, idle = null } = {}) {
  const queue = [];
  const done = [];
  const runIdle = typeof idle === 'function' ? idle : (fn) => setTimeout(fn, 0);
  let fired = false, armed = false, pending = 0, settled = false;
  const finish = () => {
    if (settled || pending > 0) return;
    settled = true;
    for (const fn of done.splice(0)) { try { fn(); } catch (e) { /* ignore */ } }
  };
  const run = (load) => {
    let p = null;
    try { p = load(); } catch (e) { p = null; }
    if (p && typeof p.then === 'function') {
      pending++;
      p.then(() => {}, () => {}).then(() => { pending--; finish(); });
    }
  };
  function fire() {
    if (fired) return;
    fired = true;
    for (const load of queue.splice(0)) run(load);
    finish();
  }
  return {
    add(load) { if (typeof load !== 'function') return; if (fired) run(load); else queue.push(load); },
    tick({ now = 0, screen = 'menu', menuFrameAt = 0, heroBusy = false } = {}) {
      if (fired) return;
      if (screen !== 'menu') { fire(); return; }
      if (!menuFrameAt) return;
      if (now - menuFrameAt > maxMs) { fire(); return; }
      if (!heroBusy && !armed) { armed = true; runIdle(fire); }
    },
    fire,
    onDone(fn) { if (typeof fn !== 'function') return; if (settled) fn(); else done.push(fn); },
    get fired() { return fired; },
    get pending() { return fired ? pending : queue.length; },
  };
}

export function createTrickleCompile({ renderer, scene, camera, perStep = 2, gapMs = 250, schedule = null, stopped = null } = {}) {
  const S = { list: [], i: 0, done: false, started: false, added: 0, error: null };
  const next = typeof schedule === 'function' ? schedule : (fn, ms) => setTimeout(fn, ms);
  const isStopped = typeof stopped === 'function' ? stopped : () => false;
  const programs = () => (renderer && renderer.info && renderer.info.programs ? renderer.info.programs.length : 0);
  const hasProgram = (o) => (Array.isArray(o.material) ? o.material : [o.material]).every((m) => {
    const p = m && renderer.properties && renderer.properties.get(m);
    return !!(p && p.currentProgram);
  });
  function step() {
    if (S.done) return;
    const stop = isStopped();
    const n0 = programs();
    if (!stop) {
      try {
        while (S.i < S.list.length && programs() - n0 < perStep) {
          const o = S.list[S.i++];
          if (o.parent && !hasProgram(o)) renderer.compile(compileSet([o]), camera, scene);
        }
      } catch (e) { S.done = true; S.error = e; return; }   // сборка не удалась — дальше шейдеры соберутся при первом показе
    }
    S.added += programs() - n0;
    if (stop || S.i >= S.list.length) { S.done = true; return; }
    next(step, gapMs);
  }
  return {
    start(list) {
      if (S.started) return;
      S.started = true;
      if (!renderer || typeof renderer.compile !== 'function' || !renderer.properties) { S.done = true; return; }
      S.list = (Array.isArray(list) ? list : []).filter((o) => !hasProgram(o));
      step();
    },
    step,
    hasProgram,
    get done() { return S.done; },
    get added() { return S.added; },
    get stopped() { return S.done && !S.error && S.i < S.list.length; },
    get error() { return S.error; },
  };
}
