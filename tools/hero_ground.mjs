// [W5-ПОЛ] Стопы героев и пол: |подошва − пол| по кадрам виртуального времени (как tools/visual_budget.mjs —
// performance.now и requestAnimationFrame подменены, кадр = заданный шаг игрового времени).
//   Меню: 6 кругов смены пяти героев, у каждого 2 с (всего 60 с) — витрина, визитки, жест «выхода».
//   Бой (у каждого героя): 100 с «Отладки с клавиатуры» по кругу 20 с — ходьба, бег и рывок (W), рывки Space/Q/E,
//   поворот на месте (A/D), огонь J, выброс L, щит K, «Врата бури» X, «Столп небес» G, «Искра» U, руны 1–0,
//   сфера O, удар I; шкала ярости полна — U «Небесный суд»; затем добивание Регента и 8 с победы.
//   Отдельно — поражение (Регент бьёт втрое, герой стоит): 6 с на колене.
// Каждый кадр — window.__ASHEN__.heroFeet(): нижняя точка подошвы (вершины сетки стоп) и видимый пол под ней.
//   node tools/hero_ground.mjs --quality medium --out /tmp/hg-medium.json [--heroes ashen,elf] [--root DIR] [--quick]
//   node tools/hero_ground.mjs --report docs/hero-ground --after a.json,b.json [--before c.json,d.json]
//        — без прогона: таблица .md и графики .svg (|зазор| по времени у каждого героя, до и после)

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { HERE, args, HERO_IDS, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame, sleep } from './visual_common.mjs';

const A = args();
const T0 = Date.now();
const log = (m) => console.error(`[hero_ground ${((Date.now() - T0) / 1000).toFixed(0)} с] ${m}`);
const TOL = 0.02;   // цель: |подошва − пол| ≤ 2 см

// ------------------------------------------------------------------ сводка ряда кадров
export function summarizeRows(rows) {
  const g = rows.map((r) => r.gap).filter(Number.isFinite);
  if (!g.length) return { frames: 0 };
  const s = [...g].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
  // «наземные» кадры: обе стопы не в полёте (зазор не больше 6 см) — по ним дрейф (первые и последние 25%)
  const ground = rows.filter((r) => Number.isFinite(r.gap) && r.gap < 0.06);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y.gap, 0) / a.length : null);
  const k = Math.max(1, Math.floor(ground.length / 4));
  const r4 = (x) => (x == null ? null : +x.toFixed(4));
  return {
    frames: g.length, min: r4(s[0]), p5: r4(q(0.05)), median: r4(q(0.5)), p95: r4(q(0.95)), max: r4(s[s.length - 1]),
    sinkMax: r4(Math.max(0, -s[0])),                                         // самое глубокое погружение
    over: +(g.filter((x) => x < -TOL).length / g.length).toFixed(3),        // доля кадров глубже 2 см
    driftFirst: r4(mean(ground.slice(0, k))), driftLast: r4(mean(ground.slice(-k))),
  };
}

// ------------------------------------------------------------------ прогон одного уровня качества
async function run() {
  const ROOT = resolve(A.of('--root', HERE));
  const Q = A.of('--quality', 'medium');
  const OUT = resolve(A.of('--out', join(HERE, `hero-ground-${Q}.json`)));
  const HEROES = (A.of('--heroes', HERO_IDS.join(',')) || '').split(',').filter((h) => HERO_IDS.includes(h));
  const QUICK = A.has('--quick');
  const SIZE = A.of('--size', '400x225').split('x').map(Number);
  const SEED = +A.of('--seed', '20261003');
  const { chromium } = loadPlaywright();
  const server = await startServer(ROOT);
  const browser = await launchBrowser(chromium, chromiumPath());
  const res = { quality: Q, root: ROOT, menu: [], battle: {}, defeat: {}, notes: [] };
  // В странице: n кадров по ms, клавиши — события keydown/keyup на window (как у core/debugInput.js) по номерам кадров,
  // после каждого кадра — heroFeet() и состояние боя; autoUlt — U, как только шкала ярости полна; stop — до конца боя
  const PAGE_RUN = async ({ n, ms, events, stop, autoUlt, phase, t0, every, fast }) => {
    const A = window.__ASHEN__, vb = window.__vb, rows = [];
    const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
    const at = new Map();
    for (const e of events || []) { if (!at.has(e[0])) at.set(e[0], []); at.get(e[0]).push(e); }
    let t = t0, ult = false, i = 0;
    for (; i < n; i++) {
      for (const [, act, code] of at.get(i) || []) { if (act !== 'up') key('keydown', code); if (act !== 'down') key('keyup', code); }
      if (fast) { vb.step(ms, false); if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0)); } else await vb.step(ms);
      t += ms / 1000;
      const s = A.snapshot();
      if (!every || i % every === 0) {
        const f = A.heroFeet ? A.heroFeet() : null;
        if (f) rows.push({ t: +t.toFixed(3), phase, gap: f.gap, gapL: f.gapL, gapR: f.gapR, sole: f.sole, floor: Math.min(f.floorL ?? 9, f.floorR ?? 9), root: f.root, ground: f.groundL, obj: f.floorObj, hero: f.hero,
          act: f.act, pose: f.pose, loco: f.loco, screen: f.screen, st: s ? s.status : null, pa: s ? s.player.action : null, dash: s ? !!s.player.dashing : null, ult: !!(s && s.ultimate && s.ultimate.active), lift: (A.hero() || {}).lift });
      }
      if (autoUlt && !ult && s && s.status === 'playing' && s.player.fury >= 100) { key('keydown', 'KeyU'); key('keyup', 'KeyU'); ult = true; }
      if (stop && s && s.status !== 'playing') { i++; break; }
    }
    for (const c of ['KeyW', 'KeyA', 'KeyD', 'KeyJ', 'KeyK', 'KeyX', 'KeyG', 'KeyO']) key('keyup', c);
    const s = A.snapshot();
    return { rows, t, ult, steps: i, status: s ? s.status : null };
  };
  // Без отрисовки (по умолчанию; --render — рисовать): логика героя и боя идёт в кадре до renderer.render, хук сам
  // обновляет матрицы героя, а программный рендер без видеокарты — секунды на кадр. Кадр игры не ждёт браузер.
  const RENDER = A.has('--render');
  const noRender = async (page) => {
    if (RENDER) return;
    await page.waitForFunction(() => !!(window.__vb.probe && window.__vb.probe.renderer), null, { timeout: 120000, polling: 100 });
    await page.evaluate(() => { const r = window.__vb.probe.renderer; if (!r.__hgRender) { r.__hgRender = r.render; r.render = function () {}; } });
  };
  // пачками по 240 кадров (один вызов страницы не упирается в тайм-аут Playwright)
  const runPaged = async (page, o) => {
    const rows = [];
    let t = o.t0 || 0, ult = !o.autoUlt, steps = 0, status = null;
    for (let s0 = 0; s0 < o.n; s0 += 240) {
      const n = Math.min(240, o.n - s0);
      const ev = (o.events || []).filter((e) => e[0] >= s0 && e[0] < s0 + n).map((e) => [e[0] - s0, e[1], e[2]]);
      const r = await page.evaluate(PAGE_RUN, { ...o, n, events: ev, t0: t, autoUlt: !ult, fast: !RENDER });
      rows.push(...r.rows); t = r.t; steps += r.steps; status = r.status; ult = ult || r.ult;
      if (o.stop && status !== 'playing') break;
    }
    return { rows, t, ult: o.autoUlt ? ult : false, steps, status };
  };
  try {
    // ---------------------------------------------------------------- меню
    if (!A.has('--no-menu')) {
      const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: HEROES[0] }, log: (m) => log(`${Q} меню: ${m}`) });
      const { page } = g;
      await noRender(page);
      let t = 0;
      const cycles = QUICK ? 2 : 6, per = QUICK ? 30 : 60;
      for (let c = 0; c < cycles; c++) {
        for (const h of HEROES) {
          await g.virtual(false);
          await page.locator('label.ao-herocard', { has: page.locator(`input[value="${h}"]`) }).click({ timeout: 240000 });
          await page.waitForFunction((id) => { const s = window.__ASHEN__.hero(); return s && s.hero === id && s.ready; }, h, { timeout: 240000, polling: 200 }).catch(() => res.notes.push(`меню ${h}: не загрузился`));
          await g.virtual(true);
          const r = await page.evaluate(PAGE_RUN, { n: per, ms: 1000 / 30, events: [], phase: 'menu', t0: t, every: 2, fast: !RENDER });
          t = r.t;
          for (const x of r.rows) res.menu.push({ ...x, cycle: c });
        }
        log(`${Q} меню: круг ${c + 1}/${cycles}`);
      }
      await g.ctx.close();
    }
    // ---------------------------------------------------------------- бой
    const STEP = 1000 / 15;   // шаг 1/15 с игрового времени
    const RUNES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
    // круг 20 с: [время, действие, клавиша]
    const CYCLE = [[0, 'down', 'KeyW'], [3, 'up', 'KeyW'], [3.2, 'press', 'Space'], [4, 'press', 'KeyQ'], [4.8, 'press', 'KeyE'],
      [5.5, 'down', 'KeyA'], [6.5, 'up', 'KeyA'], [6.6, 'down', 'KeyD'], [7.2, 'up', 'KeyD'], [7.5, 'down', 'KeyJ'], [8.7, 'up', 'KeyJ'],
      [9.5, 'press', 'KeyL'], [10.5, 'down', 'KeyK'], [12, 'up', 'KeyK'], [12.5, 'down', 'KeyX'], [14.1, 'up', 'KeyX'],
      [15, 'down', 'KeyG'], [16.6, 'up', 'KeyG'], [17, 'press', 'KeyU'], [17.6, 'press', 'RUNE'], [18.3, 'down', 'KeyO'], [19.4, 'up', 'KeyO'], [19.6, 'press', 'KeyI']];
    const BATTLE = QUICK ? 40 : 100;
    const events = [];
    for (let c = 0, r = 0; c * 20 < BATTLE; c++) for (const [tc, act, k] of CYCLE) { const i = Math.round(((c * 20 + tc) * 1000) / STEP); if (c * 20 + tc < BATTLE) events.push([i, act, k === 'RUNE' ? RUNES[r++ % RUNES.length] : k]); }
    for (const h of HEROES) {
      if (A.has('--no-battle')) break;
      const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: h }, patch: { bossHp: 2.5, bossDamage: 0.25 }, log: (m) => log(`${Q} бой ${h}: ${m}`) });
      const { page } = g;
      await g.toBattle();
      await noRender(page);
      const rows = [];
      let r = await runPaged(page, { n: Math.round((BATTLE * 1000) / STEP), ms: STEP, events, stop: true, autoUlt: true, phase: 'battle', t0: 0 });
      rows.push(...r.rows);
      log(`${Q} бой ${h}: ${r.steps} кадров, «Небесный суд» ${r.ult ? 'был' : 'не был'}, статус ${r.status}`);
      // добивание: выброс, руны, огонь — пока Регент жив (не больше 90 с)
      if (r.status === 'playing') {
        const HITS = ['KeyL', 'Digit1', 'Digit8', 'Digit7', 'Digit2', 'KeyU'];
        const ev = [];
        for (let i = 0; i < 1350; i += 10) ev.push([i, 'press', HITS[(i / 10) % HITS.length]]);
        r = await runPaged(page, { n: 1350, ms: STEP, events: ev, stop: true, autoUlt: !r.ult, phase: 'kill', t0: r.t });
        rows.push(...r.rows);
      }
      if (r.status !== 'victory') res.notes.push(`бой ${h}: победы нет (status ${r.status})`);
      r = await page.evaluate(PAGE_RUN, { n: 120, ms: STEP, events: [], phase: 'victory', t0: r.t, fast: !RENDER });
      rows.push(...r.rows);
      res.battle[h] = rows;
      log(`${Q} бой ${h}: ${rows.length} кадров, ${JSON.stringify(summarizeRows(rows))}`);
      await g.ctx.close();
    }
    // ---------------------------------------------------------------- поражение
    for (const h of HEROES) {
      if (A.has('--no-defeat')) break;
      const g = await openGame(browser, server, { size: SIZE, seed: SEED, settings: { quality: Q, hero: h }, patch: { bossHp: 3, bossDamage: 3 }, log: (m) => log(`${Q} поражение ${h}: ${m}`) });
      const { page } = g;
      await g.toBattle();
      await noRender(page);
      let r = await runPaged(page, { n: 1500, ms: 100, events: [[0, 'down', 'KeyW'], [45, 'up', 'KeyW']], stop: true, phase: 'wait', t0: 0, every: 5 });
      const rows = [...r.rows];
      if (r.status !== 'defeat') res.notes.push(`поражение ${h}: нет (status ${r.status})`);
      r = await page.evaluate(PAGE_RUN, { n: 90, ms: STEP, events: [], phase: 'defeat', t0: r.t, fast: !RENDER });
      rows.push(...r.rows);
      res.defeat[h] = rows;
      log(`${Q} поражение ${h}: ${JSON.stringify(summarizeRows(rows.filter((x) => x.phase === 'defeat')))}`);
      await g.ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(res));
  log(`записано ${OUT}`);
}

// ------------------------------------------------------------------ отчёт: таблица и графики
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// цвета: ряды — категориальные слоты 1–2 (проверены на различимость, в т. ч. при дальтонизме), текст и сетка — нейтральные
const INK = { text: '#0b0b0b', muted: '#52514e', grid: '#e4e3df', zero: '#8a8984', surface: '#fcfcfb', band: '#0b0b0b' };
function chart(title, series, { w = 760, h = 230, tMax = null, yMin = -0.1, yMax = 0.1 } = {}) {
  // series: [{ name, color, pts: [[t, gap]] }]; серая полоса — допуск ±2 см
  const L = 46, R = 12, T = 44, B = 28, W = w - L - R, H = h - T - B;
  const tm = tMax || Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p[0])));
  const X = (t) => L + (t / tm) * W, Y = (v) => T + (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * H;
  let o = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif" font-size="11">`;
  o += `<rect width="${w}" height="${h}" fill="${INK.surface}"/><text x="${L}" y="17" font-size="13" font-weight="600" fill="${INK.text}">${esc(title)}</text>`;
  o += `<rect x="${L}" y="${Y(TOL)}" width="${W}" height="${Y(-TOL) - Y(TOL)}" fill="${INK.band}" opacity="0.06"/>`;
  const stepV = yMax - yMin > 0.3 ? 0.1 : 0.02;
  for (let v = Math.ceil(yMin / stepV - 1e-9) * stepV; v <= yMax + 1e-9; v += stepV) {
    const zero = Math.abs(v) < 1e-9;
    o += `<line x1="${L}" x2="${L + W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${zero ? INK.zero : INK.grid}" stroke-width="1"/>`;
    o += `<text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" fill="${INK.muted}">${Math.round(v * 100)}</text>`;
  }
  o += `<text x="12" y="${T + H / 2}" transform="rotate(-90 12 ${T + H / 2})" text-anchor="middle" fill="${INK.muted}">зазор, см</text>`;
  const tick = tm > 100 ? 20 : tm > 30 ? 10 : 2;
  for (let s = 0; s <= tm + 1e-9; s += tick) o += `<text x="${X(s).toFixed(1)}" y="${h - 9}" text-anchor="middle" fill="${INK.muted}">${s} с</text>`;
  // легенда: ключ-линия цвета ряда, подпись — нейтральным цветом
  let lx = L;
  for (const s of series) {
    if (!s.pts.length) continue;
    o += `<line x1="${lx}" x2="${lx + 16}" y1="31" y2="31" stroke="${s.color}" stroke-width="2" stroke-linecap="round"/><text x="${lx + 21}" y="35" fill="${INK.text}">${esc(s.name)}</text>`;
    lx += 30 + 7 * s.name.length;
  }
  o += `<rect x="${lx}" y="26" width="16" height="10" fill="${INK.band}" opacity="0.12"/><text x="${lx + 21}" y="35" fill="${INK.text}">допуск ±2 см</text>`;
  for (const s of series) {
    if (!s.pts.length) continue;
    const d = s.pts.map((p, j) => `${j ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    o += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;
  }
  return o + '</svg>';
}

function report() {
  const DIR = resolve(A.of('--report', join(HERE, 'docs', 'hero-ground')));
  const load = (list) => (list || '').split(',').filter(Boolean).map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')));
  const after = load(A.of('--after', '')), before = load(A.of('--before', ''));
  mkdirSync(DIR, { recursive: true });
  const NAMES = { ashen: 'Пепельный страж', elf: 'Эльфийка', dark: 'Тёмная чародейка', ranger: 'Лучница', archmage: 'Архимаг' };
  const COL = { before: '#2a78d6', after: '#eb6834' };   // слоты 1 и 2 категориальной палитры
  const cm = (x) => (x == null ? '—' : (x * 100).toFixed(1));
  let md = '# Стопы героев и пол: |подошва − пол|\n\n';
  md += 'Замер `node tools/hero_ground.mjs` (виртуальное время, `window.__ASHEN__.heroFeet()`): зазор = нижняя точка подошвы ' +
    '(вершины сетки стоп) − видимый пол под ней; меньше нуля — стопа в полу. Цель — не глубже 2 см. «Дрейф» — средний зазор ' +
    'в первой и последней четверти кадров, когда стопа на земле.\n\n';
  const qualities = [...new Set([...after, ...before].map((r) => r.quality))];
  for (const q of qualities) {
    const a = after.find((r) => r.quality === q), b = before.find((r) => r.quality === q);
    md += `## ${q}\n\n| Сцена | Герой | до: глубже всего | до: медиана | до: кадров глубже 2 см | до: дрейф | после: глубже всего | после: медиана | после: кадров глубже 2 см | после: дрейф |\n|---|---|---|---|---|---|---|---|---|---|\n`;
    const line = (scene, hero, rb, ra) => {
      const S = (r) => { const x = r && r.length ? summarizeRows(r) : null; return x && x.frames ? x : null; };
      const sb = S(rb), sa = S(ra);
      const dr = (s) => (s && s.driftFirst != null ? `${cm(s.driftFirst)} → ${cm(s.driftLast)}` : '—');
      const cells = (s) => (s ? [cm(-s.sinkMax), cm(s.median), (s.over * 100).toFixed(0) + '%', dr(s)] : ['—', '—', '—', '—']);
      md += `| ${scene} | ${NAMES[hero] || hero} | ${cells(sb).join(' | ')} | ${cells(sa).join(' | ')} |\n`;
    };
    for (const h of HERO_IDS) {
      const pick = (r, f) => (r ? r.menu.filter((x) => x.hero === h) : null);
      line('меню, 6 кругов', h, pick(b), pick(a));
    }
    for (const h of HERO_IDS) line('бой 2 мин', h, b && b.battle[h], a && a.battle[h]);
    for (const h of HERO_IDS) line('поражение', h, b && b.defeat[h] && b.defeat[h].filter((x) => x.phase === 'defeat'), a && a.defeat[h] && a.defeat[h].filter((x) => x.phase === 'defeat'));
    md += '\n';
    // графики: меню (все герои подряд) и бой каждого героя
    const ser = (rows, name, color, tKey = 't') => ({ name, color, pts: (rows || []).filter((r) => Number.isFinite(r.gap)).map((r) => [r[tKey], r.gap]) });
    const files = [];
    const put = (name, svg) => { writeFileSync(join(DIR, name), svg); files.push(name); };
    // меню: визиты героя подряд (6 кругов по 2 с), время — внутри его визитов
    const menuOf = (r, h) => { if (!r) return null; let t = 0, prev = null; return r.menu.filter((x) => x.hero === h).map((x) => { t += prev === null || x.t - prev > 0.2 ? 1 / 15 : x.t - prev; prev = x.t; return { ...x, t: +t.toFixed(3) }; }); };
    for (const h of HERO_IDS) {
      const mb = menuOf(b, h), ma = menuOf(a, h);
      if ((mb && mb.length) || (ma && ma.length)) put(`${q}-menu-${h}.svg`, chart(`${q}, меню — ${NAMES[h]}: 6 появлений на витрине по 2 с`, [ser(mb, 'до', COL.before), ser(ma, 'после', COL.after)]));
      if ((a && a.battle[h]) || (b && b.battle[h])) put(`${q}-battle-${h}.svg`, chart(`${q}, бой — ${NAMES[h]}: ходьба, рывки, заклинания, «Небесный суд», победа`, [ser(b && b.battle[h], 'до', COL.before), ser(a && a.battle[h], 'после', COL.after)], { yMin: -0.14, yMax: 0.4 }));
    }
    md += files.map((f) => `![${f}](${f})`).join('\n') + '\n\n';
  }
  const notes = [...after, ...before].flatMap((r) => (r.notes || []).map((n) => `${r.quality}: ${n}`));
  if (notes.length) md += '## Заметки прогона\n\n' + notes.map((n) => `- ${n}`).join('\n') + '\n';
  writeFileSync(join(DIR, 'README.md'), md);
  console.log(md);
}

if (A.has('--report')) report();
else if (process.argv[1] && basename(process.argv[1]) === 'hero_ground.mjs') run().catch((e) => { console.error(e); process.exit(1); });
void sleep;
