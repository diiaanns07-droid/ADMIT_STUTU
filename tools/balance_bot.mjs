// [W5-СЛОЖНОСТЬ] Замер баланса сложностей ботом (dev/balanceBot.mjs): таблица «уровень × мастерство».
// node tools/balance_bot.mjs [--levels easy,normal,hard,nightmare] [--skills novice,medium,expert] [--seeds 24]
//                            [--seed0 1] [--max 900] [--set '{"hard":{"bossHp":8}}'] [--config путь.js] [--json] [--md]
//   --set     — подмена множителей уровней поверх config.js (подбор баланса без правки файла);
//   --config  — взять config.js из другого файла (например, git show main:config.js > /tmp/c.js — замер «ДО»);
//   --md      — таблица Markdown (для PR), --json — сырые итоги.
// Бои считаются параллельно (worker_threads, по числу ядер − 0).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism, cpus } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

async function loadConfig(path) {
  const mod = await import(pathToFileURL(resolve(path || new URL('../config.js', import.meta.url).pathname)).href);
  return mod.config;
}

if (!isMainThread) {
  const { runBotFight } = await import('../dev/balanceBot.mjs');
  const { level, skill, seeds, seed0, maxSec, set, configPath } = workerData;
  const game = await loadConfig(configPath);
  const combat = JSON.parse(JSON.stringify(game.combat || {}));
  if (set) { combat.difficulty = combat.difficulty || {}; for (const [k, v] of Object.entries(set)) combat.difficulty[k] = { ...(combat.difficulty[k] || {}), ...v }; }
  const out = [];
  for (let k = 0; k < seeds; k++) {
    const r = runBotFight({ level, skill, seed: seed0 + k, maxSec, config: combat });
    out.push({ status: r.status, t: r.t, hp: r.hp, bossHp: r.bossHp, bossMaxHp: r.bossMaxHp, taken: r.taken, hits: r.hits, attacks: r.attacks, ults: r.ults });
  }
  parentPort.postMessage(out);
} else {
  const { summarize } = await import('../dev/balanceBot.mjs');
  const levels = argOf('--levels', 'easy,normal,hard,nightmare').split(',');
  const skills = argOf('--skills', 'novice,medium,expert').split(',');
  const seeds = +argOf('--seeds', 24), seed0 = +argOf('--seed0', 1), maxSec = +argOf('--max', 900);
  const set = argOf('--set', null) ? JSON.parse(argOf('--set')) : null;
  const configPath = argOf('--config', null);
  const jobs = [];
  for (const level of levels) for (const skill of skills) jobs.push({ level, skill });
  const N = Math.max(1, Math.min(jobs.length, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length)));
  // каждую пару «уровень × мастерство» режем на куски по seed, чтобы ядра были заняты ровно
  const chunks = [];
  const per = Math.max(1, Math.ceil(seeds / Math.max(1, Math.ceil(N * 2 / jobs.length))));
  for (const j of jobs) for (let s = 0; s < seeds; s += per) chunks.push({ ...j, seeds: Math.min(per, seeds - s), seed0: seed0 + s, maxSec, set, configPath });
  const results = new Map(jobs.map((j) => [`${j.level}|${j.skill}`, []]));
  const t0 = Date.now();
  let next = 0;
  await Promise.all(Array.from({ length: N }, async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      const rs = await new Promise((ok, fail) => {
        const w = new Worker(new URL(import.meta.url), { workerData: c });
        w.once('message', ok); w.once('error', fail);
      });
      results.get(`${c.level}|${c.skill}`).push(...rs);
    }
  }));
  const LV = { easy: 'Лёгкая', normal: 'Обычная', hard: 'Сложная', nightmare: 'Кошмар' };
  const SK = { novice: 'новичок', medium: 'средний', expert: 'опытный' };
  const mmss = (s) => { if (s === null) return '—'; const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
  const rows = [];
  for (const j of jobs) {
    const rs = results.get(`${j.level}|${j.skill}`);
    const s = summarize(rs);
    const hit = rs.reduce((a, r) => { for (const k of ['slam', 'orb', 'nova']) { a[k] += r.hits[k]; a.n += r.attacks[k]; } return a; }, { slam: 0, orb: 0, nova: 0, n: 0 });
    const minutes = rs.reduce((a, r) => a + r.t, 0) / 60;
    rows.push({ ...j, ...s, hitRate: hit.n ? (hit.slam + hit.orb + hit.nova) / hit.n : 0, takenPerMin: minutes ? rs.reduce((a, r) => a + r.taken, 0) / minutes : 0, ults: rs.reduce((a, r) => a + r.ults, 0) / rs.length, bossMaxHp: rs[0] ? rs[0].bossMaxHp : null });
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else if (argv.includes('--md')) {
    console.log('| Сложность | Бот | Победы | Поражения | Время победы, медиана [25–75%] | HP героя после победы | Урон по герою, HP/мин | Попаданий Регента, % атак |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${LV[r.level] || r.level} | ${SK[r.skill] || r.skill} | ${r.wins}/${r.n} | ${r.losses}${r.timeouts ? ` (+${r.timeouts} не успел)` : ''} | ${mmss(r.median)} [${mmss(r.p25)}–${mmss(r.p75)}] | ${r.hpLeft ?? '—'} | ${r.takenPerMin.toFixed(0)} | ${(r.hitRate * 100).toFixed(0)} |`);
    }
  } else {
    for (const r of rows) {
      console.log(`${(LV[r.level] || r.level).padEnd(8)} ${(SK[r.skill] || r.skill).padEnd(8)} побед ${String(r.wins).padStart(2)}/${r.n} пораж ${String(r.losses).padStart(2)} время ${mmss(r.median)} [${mmss(r.p25)}–${mmss(r.p75)}] HP ${String(r.hpLeft ?? '—').padStart(3)} урон/мин ${r.takenPerMin.toFixed(0).padStart(3)} попаданий ${(r.hitRate * 100).toFixed(0).padStart(2)}% ульт ${r.ults.toFixed(1)} HPрегента ${r.bossMaxHp}`);
    }
  }
  console.error(`(${jobs.length} пар, ${seeds} seed, ${((Date.now() - t0) / 1000).toFixed(1)} с, потоков ${N})`);
}
