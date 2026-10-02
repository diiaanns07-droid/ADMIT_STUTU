// [W4-БЮДЖЕТ] Бюджет кадра: сколько стоит каждая сцена игры на low / medium / high.
//   node tools/visual_budget.mjs                       — все сценарии, все уровни → docs/visual-budget.md и .json
//   node tools/visual_budget.mjs --quality low --only menu,burst --out /tmp/vb   — часть сценариев, в другую папку
//   node tools/visual_budget.mjs --check               — после замера сверить с config.visualBudget (код выхода 1)
//   node tools/visual_budget.mjs --root ../main-wt     — замерить другую папку игры (git worktree add … origin/main)
// Флаги: --size 480x270 (вьюпорт; вызовы и треугольники от него не зависят, а программный рендер быстрее)
//        --jobs 3 (уровни качества параллельно, отдельными процессами) --seed N --quick (короче окна замера)
//        --compare docs/visual-budget.json — в отчёт таблица «было → стало» против прошлого замера (для PR)
//
// Сценарии. Страница A: меню с каждым героем → бой в «Отладке с клавиатуры» (фаза 1) → каждое заклинание
// (J, L, O, X, G, U, руны 1–0). Регент на 3000 HP и без урона — бой не кончается, герой не гибнет.
// Страница B: Регент на 200 HP → выброс и руна → переход в фазу 2 (рёв, гроза), удар Регента, «Небесный суд»
// (шкала полна от урона), гибель Регента.
// Каждый кадр — ровно 1/30 с игрового времени (tools/visual_common.mjs: подмена performance.now и rAF).
// По кадрам окна сценария: вызовы отрисовки и треугольники (максимум и медиана), текстуры, геометрии и программы
// (renderer.info), источники света и тени, частицы (вершины Points + спрайты + активные элементы V6),
// время JS кадра (медиана и p95, настоящие часы) и полное время кадра на программном рендере (справочно).

import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  HERE, args, sleep, QUALITIES, HERO_IDS, SPELLS, SCENARIOS, checkBudget, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame, summarize,
} from './visual_common.mjs';

const A = args();
const ROOT = resolve(A.of('--root', HERE));
const QS = A.of('--quality', QUALITIES.join(',')).split(',').filter((q) => QUALITIES.includes(q));
const SIZE = A.of('--size', '480x270').split('x').map(Number);
const ONLY = (A.of('--only', '') || '').split(',').filter(Boolean);
const OUT = resolve(A.of('--out', join(HERE, 'docs', 'visual-budget')));
const PART = A.of('--part', '');           // внутреннее: дочерний процесс пишет JSON уровня сюда
const JOBS = Math.max(1, +A.of('--jobs', '1'));
const SEED = +A.of('--seed', '20261002');
const QUICK = A.has('--quick');
const CHECK = A.has('--check');
const COMPARE = A.of('--compare', '');
const T0 = Date.now();
const log = (m) => console.error(`[visual_budget ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
const K = QUICK ? 0.5 : 1;                 // длина окон замера
const fr = (n) => Math.max(4, Math.round(n * K));

const want = (id) => !ONLY.length || ONLY.some((o) => id === o || id.startsWith(o));

// ------------------------------------------------------------------ один уровень качества
async function measureQuality(browser, server, q) {
  const res = {};
  const notes = [];
  const put = (id, frames, extra) => {
    if (!frames || !frames.length) { notes.push(`${id}: нет кадров`); return; }
    res[id] = { ...summarize(frames), ...(extra || {}) };
    const r = res[id];
    log(`${q} ${id}: вызовов ${r.calls}, треугольников ${r.triangles}, свет ${r.lights}, частиц ${r.particles}, JS ${r.jsMs} мс`);
  };
  const needA = SCENARIOS.filter((s) => s.group !== 'boss').some((s) => want(s.id));
  const needB = SCENARIOS.filter((s) => s.group === 'boss').some((s) => want(s.id));

  if (needA) {
    const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: q, hero: 'ashen' }, patch: { bossHp: 3, bossDamage: 0 }, log: (m) => log(`${q} A: ${m}`) });
    const { page } = g;
    // меню: каждый герой — выбор карточки, загрузка (в настоящем времени), окно замера с «выходом» героя
    for (const h of HERO_IDS) {
      if (!want(`menu_${h}`)) continue;
      await g.virtual(false);
      await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click({ timeout: 240000 });
      await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { timeout: 240000, polling: 200 }).catch(() => notes.push(`menu_${h}: герой не загрузился`));
      await g.virtual(true);
      await g.step(fr(6));
      put(`menu_${h}`, await g.sample(fr(24)), { hero: h });
    }
    const battle = SCENARIOS.filter((s) => s.group === 'battle').some((s) => want(s.id));
    if (battle) {
      await g.virtual(false);
      if (HERO_IDS.some((h) => want(`menu_${h}`))) {
        await page.locator('label.ao-herocard', { has: page.locator('input[value="ashen"]') }).click({ timeout: 240000 });
        await page.waitForFunction(() => { const s = window.__ASHEN__.hero(); return s && s.hero === 'ashen' && s.ready; }, null, { timeout: 240000, polling: 200 }).catch(() => {});
      }
      await g.toBattle();
      await g.walkToBoss();
      await g.virtual(true);
      await g.step(fr(20));
      if (want('battle_phase1')) put('battle_phase1', await g.sample(fr(60)));
      for (const s of SPELLS) {
        if (!want(s.id)) continue;
        // энергия и откат: ждём в «быстром» настоящем времени (кадры по 0,5 с), затем кадр в кадр
        await g.virtual(false);
        await page.waitForFunction(() => { const s = window.__ASHEN__.snapshot(); return s && s.player.energy >= 75 && s.player.action !== 'cast'; }, null, { timeout: 120000, polling: 200 }).catch(() => notes.push(`${s.id}: не дождались энергии`));
        await g.virtual(true);
        await g.step(3);
        const before = await g.snap();
        let frames = [];
        if (s.hold) {
          await page.keyboard.down(s.key);
          frames = frames.concat(await g.sample(s.hold));   // удержание — всегда полное: от него зависит сила заклинания
          await page.keyboard.up(s.key);
        } else {
          await page.keyboard.press(s.key);
        }
        frames = frames.concat(await g.sample(fr(s.after)));
        // сыграло ли: герой в «cast», провал энергии или урон Регенту за окно
        const minOf = (k) => Math.min(...frames.map((f) => f[k]).filter(Number.isFinite));
        put(s.id, frames, {
          cast: frames.some((f) => f.pAction === 'cast'),
          energyUsed: before ? Math.round(before.energy - minOf('energy')) : null,
          damage: before ? Math.round(before.hp - minOf('bossHp')) : null,
        });
      }
    }
    res.__errorsA = g.errors.slice(0, 10);
    await g.ctx.close();
  }

  if (needB) {
    // Регент на 400 HP: половина (фаза 2) — от выброса и рун, шкала «Ярость клятвы» полна от того же урона
    const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: q, hero: 'ashen' }, patch: { bossHp: 0.4, bossDamage: 0 }, log: (m) => log(`${q} B: ${m}`) });
    const { page } = g;
    await g.toBattle();
    await g.walkToBoss();
    const stateOf = () => page.evaluate(() => {
      const s = window.__ASHEN__.snapshot(), u = window.__ASHEN__.ult();
      return { st: s.status, stage: s.boss.stage, hp: s.boss.hp, maxHp: s.boss.maxHp, act: s.boss.action, fury: s.player.fury, energy: s.player.energy, cine: !!(u && u.cine) };
    });
    const HITS = ['KeyL', 'Digit1', 'Digit8', 'Digit7', 'Digit2'];
    // урон в «быстром» настоящем времени (кадры по 0,5 с), пока HP не дойдёт до половины
    let s = await stateOf();
    for (let i = 0; i < 40 && s.st === 'playing' && s.stage === 1 && s.hp > s.maxHp * 0.5; i++) {
      await page.keyboard.press(HITS[i % HITS.length]);
      await sleep(1500);
      s = await stateOf();
    }
    // переход в фазу 2 — кадр в кадр: Регент меняет стойку, когда освободится от атаки
    await g.virtual(true);
    s = await stateOf();
    for (let i = 0; i < 300 && s.stage !== 2 && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
    if (s.stage !== 2) notes.push(`phase2: Регент не перешёл в фазу 2 (${JSON.stringify(s)})`);
    if (want('phase2_shift')) put('phase2_shift', await g.sample(fr(45)), { hp: s.hp });
    else await g.step(fr(45));
    await g.step(fr(30));   // гроза набирает вес
    if (want('phase2')) put('phase2', await g.sample(fr(45)));
    // удар Регента: от замаха до удара
    s = await stateOf();
    for (let i = 0; i < 360 && s.act !== 'windup' && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
    if (s.act !== 'windup') notes.push(`boss_strike: не дождались замаха (${JSON.stringify(s)})`);
    if (want('boss_strike')) put('boss_strike', await g.sample(fr(45)), { bossAction: s.act });
    else await g.step(fr(45));
    if (want('ult') || want('boss_death')) {
      // «Небесный суд»: шкала полна, Регент свободен (во время его удара бой выберет «Искру»)
      s = await stateOf();
      for (let i = 0; i < 20 && s.fury < 100 && s.st === 'playing'; i++) {
        await g.virtual(false); await page.keyboard.press(HITS[(i + 1) % HITS.length]); await sleep(1500); await g.virtual(true); s = await stateOf();
      }
      for (let i = 0; i < 300 && s.act !== 'idle' && s.act !== 'recover' && s.st === 'playing'; i += 2) { await g.step(2); s = await stateOf(); }
      const furyBefore = s.fury;
      await page.keyboard.press('KeyU');
      let fu = await g.sample(10);
      const cineSeen = (await stateOf()).cine;
      fu = fu.concat(await g.sample(fr(100)));
      s = await stateOf();
      if (want('ult')) put('ult', fu, { furyBefore, cine: cineSeen });
      if (!cineSeen) notes.push(`ult: сцена «Небесного суда» не началась (шкала ${furyBefore})`);
      // добить: руны и выброс по очереди, гибель — кадр в кадр
      for (let i = 0; i < 16 && s.st === 'playing'; i++) {
        await page.keyboard.press(HITS[i % HITS.length]);
        await g.step(12); s = await stateOf();
      }
      if (s.st !== 'victory') notes.push(`boss_death: Регент не погиб (${JSON.stringify(s)})`);
      if (want('boss_death')) put('boss_death', await g.sample(fr(90)));
    }
    res.__errorsB = g.errors.slice(0, 10);
    await g.ctx.close();
  }
  res.__notes = notes;
  return res;
}

// ------------------------------------------------------------------ отчёт
function gitInfo(root) {
  try { return { commit: execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(), branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd: root }).toString().trim() }; } catch (e) { return {}; }
}
const fmtK = (n) => (n == null ? '—' : n >= 10000 ? `${Math.round(n / 1000)} тыс.` : String(n));

export async function loadBudget(root = HERE) {
  const m = await import('file://' + join(root, 'config.js') + '?vb=' + Date.now());
  return (m.config && m.config.visualBudget) || null;
}

function report(data, budget) {
  const L = [];
  L.push('# Бюджет кадра — замер по сценам');
  L.push('');
  L.push(`Сгенерировано \`node tools/visual_budget.mjs\` · ${data.generatedAt} · ветка \`${data.git.branch || '?'}\` @ \`${data.git.commit || '?'}\` · вьюпорт ${data.size} · ${data.fps} кадров/с виртуального времени · зерно ${data.seed}${data.quick ? ' · --quick' : ''}.`);
  L.push('');
  L.push('Цифры — по окну кадров каждого сценария: **вызовы** и **треугольники** — максимум за окно (медиана — в JSON), **текстуры / программы** — в памяти GPU на конец окна, **свет** — видимые источники в сцене (в скобках — с тенью), **частицы** — вершины Points + спрайты + активные элементы V6, **JS** — медиана времени JS кадра (настоящие часы, p95 — в JSON), **кадр SW** — полное время кадра на программном рендере SwiftShader (справочно: отражает заливку, в облаке без видеокарты).');
  L.push('');
  const over = checkBudget(data.results, budget);
  const overSet = new Set(over.map((o) => `${o.quality}|${o.scene}|${o.key}`));
  const mark = (q, id, key, v) => (overSet.has(`${q}|${id}|${key}`) ? `**${v}** ⚠` : v);
  for (const q of Object.keys(data.results)) {
    const R = data.results[q];
    L.push(`## ${q}`);
    L.push('');
    if (budget && budget[q]) {
      const b = budget[q];
      L.push(`Бюджет (config.js → visualBudget.${q}): вызовов ≤ ${b.calls}, треугольников ≤ ${fmtK(b.triangles)}, свет ≤ ${b.lights}, с тенью ≤ ${b.shadowLights}, текстур ≤ ${b.textures}, программ ≤ ${b.programs}, частиц ≤ ${b.particles}, JS ≤ ${b.jsMs} мс${b.menu ? ` · меню: вызовов ≤ ${b.menu.calls}, треугольников ≤ ${fmtK(b.menu.triangles)}` : ''}.`);
      L.push('');
    }
    L.push('| Сценарий | Вызовы | Треугольники | Текстуры | Программы | Свет | Частицы | JS, мс | Кадр SW, мс |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const sc of SCENARIOS) {
      const r = R[sc.id];
      if (!r) continue;
      L.push(`| ${sc.label} | ${mark(q, sc.id, 'calls', r.calls)} | ${mark(q, sc.id, 'triangles', fmtK(r.triangles))} | ${mark(q, sc.id, 'textures', r.textures)} | ${mark(q, sc.id, 'programs', r.programs)} | ${mark(q, sc.id, 'lights', r.lights)} (${r.shadowLights}) | ${mark(q, sc.id, 'particles', r.particles)} | ${mark(q, sc.id, 'jsMs', r.jsMs)} | ${r.wallMs} |`);
    }
    if (R.__notes && R.__notes.length) { L.push(''); L.push('Замечания прогона: ' + R.__notes.join('; ')); }
    L.push('');
  }
  // самые дорогие сцены — для оптимизатора
  L.push('## Самые дорогие сцены');
  L.push('');
  for (const q of Object.keys(data.results)) {
    const rows = Object.entries(data.results[q]).filter(([id]) => !id.startsWith('__'));
    const top = (key, n = 5) => rows.slice().sort((a, b) => (b[1][key] || 0) - (a[1][key] || 0)).slice(0, n)
      .map(([id, r]) => `${SCENARIOS.find((s) => s.id === id)?.label || id} — ${key === 'triangles' ? fmtK(r[key]) : r[key]}`).join('; ');
    L.push(`- **${q}** · вызовы: ${top('calls')}`);
    L.push(`- **${q}** · треугольники: ${top('triangles')}`);
    L.push(`- **${q}** · JS кадра, мс: ${top('jsMs')}`);
    L.push(`- **${q}** · кадр SwiftShader, мс: ${top('wallMs')}`);
  }
  L.push('');
  if (data.compare) {
    const C = data.compare;
    L.push(`## Было → стало (против ${C.file}: \`${C.git.branch || '?'}\` @ \`${C.git.commit || '?'}\`)`);
    L.push('');
    const d = (a, b, k = (x) => x) => (a == null || b == null ? '—' : a === b ? `${k(b)}` : `${k(a)} → **${k(b)}**`);
    for (const q of Object.keys(data.results)) {
      const R = data.results[q], P = C.results[q] || {};
      L.push(`### ${q}`);
      L.push('');
      L.push('| Сценарий | Вызовы | Треугольники | Текстуры | Программы | Свет | Частицы | JS, мс |');
      L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
      for (const sc of SCENARIOS) {
        const r = R[sc.id], p = P[sc.id];
        if (!r) continue;
        L.push(`| ${sc.label} | ${d(p && p.calls, r.calls)} | ${d(p && p.triangles, r.triangles, fmtK)} | ${d(p && p.textures, r.textures)} | ${d(p && p.programs, r.programs)} | ${d(p && p.lights, r.lights)} | ${d(p && p.particles, r.particles)} | ${d(p && p.jsMs, r.jsMs)} |`);
      }
      L.push('');
    }
  }
  L.push(over.length ? `## Превышения бюджета (${over.length})\n\n` + over.map((o) => `- ${o.quality} · ${o.scene} · ${o.key}: ${o.value} > ${o.limit}`).join('\n') : '## Превышения бюджета\n\nНет — все сцены в пределах config.visualBudget.');
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ запуск
async function runLevels(levels) {
  const { chromium } = loadPlaywright();
  const server = await startServer(ROOT);
  const browser = await launchBrowser(chromium, chromiumPath(A.of('--browser')));
  const out = {};
  try {
    for (const q of levels) out[q] = await measureQuality(browser, server, q);
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  return out;
}

async function runJobs(levels) {
  // уровни качества — отдельными процессами (каждый со своим сервером и Chromium)
  const parts = levels.map((q) => ({ q, file: join(tmpdir(), `vb_${process.pid}_${q}.json`) }));
  const pass = process.argv.slice(2).filter((a, i, arr) => !['--jobs', '--quality', '--part'].includes(a) && !['--jobs', '--quality', '--part'].includes(arr[i - 1]));
  const queue = parts.slice();
  const running = new Set();
  const runOne = (p) => new Promise((res) => {
    const ch = spawn(process.execPath, [process.argv[1], ...pass, '--quality', p.q, '--part', p.file], { stdio: ['ignore', 'inherit', 'inherit'] });
    ch.on('exit', (code) => res(code));
  });
  await new Promise((done) => {
    const next = () => {
      if (!queue.length && !running.size) return done();
      while (running.size < JOBS && queue.length) {
        const p = queue.shift();
        const pr = runOne(p).then(() => { running.delete(pr); next(); });
        running.add(pr);
      }
    };
    next();
  });
  const out = {};
  for (const p of parts) { try { out[p.q] = JSON.parse(readFileSync(p.file, 'utf8')); } catch (e) { out[p.q] = { __notes: [`уровень ${p.q}: дочерний процесс не записал результат`] }; } }
  return out;
}

const results = PART ? await runLevels(QS) : JOBS > 1 && QS.length > 1 ? await runJobs(QS) : await runLevels(QS);
if (PART) {
  writeFileSync(PART, JSON.stringify(results[QS[0]]));
  process.exit(0);
}
const data = {
  tool: 'tools/visual_budget.mjs', version: 1,
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  git: gitInfo(ROOT), root: relative(HERE, ROOT) || '.',
  size: `${SIZE[0]}x${SIZE[1]}`, fps: 30, seed: SEED, quick: QUICK, only: ONLY,
  scenarios: SCENARIOS.map(({ id, group, label }) => ({ id, group, label })),
  results,
};
if (COMPARE) {
  try {
    const prev = JSON.parse(readFileSync(resolve(COMPARE), 'utf8'));
    data.compare = { file: relative(HERE, resolve(COMPARE)), git: prev.git || {}, results: prev.results || {} };
  } catch (e) { log(`--compare: не прочитан ${COMPARE}: ${e.message}`); }
}
const budget = await loadBudget(HERE);
mkdirSync(resolve(OUT, '..'), { recursive: true });
writeFileSync(OUT + '.json', JSON.stringify({ ...data, compare: data.compare ? { file: data.compare.file, git: data.compare.git } : undefined }, null, 1) + '\n');
writeFileSync(OUT + '.md', report(data, budget));
const over = checkBudget(results, budget);
log(`готово за ${((Date.now() - T0) / 60000).toFixed(1)} мин → ${relative(HERE, OUT)}.md / .json; превышений бюджета: ${over.length}`);
for (const o of over) console.error(`  ПРЕВЫШЕНИЕ ${o.quality} · ${o.scene} · ${o.key}: ${o.value} > ${o.limit}`);
if (CHECK && over.length) process.exit(1);
