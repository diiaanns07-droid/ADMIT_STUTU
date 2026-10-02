// Разбор записи позы с экрана тренировки: node dev/squat_replay.mjs запись.json [ключи]
//
// Запись делает игра: на экране тренировки F8 — файл ashen-pose-….json (последние ≈ 90 с, только числа,
// см. core/poseRecorder.js). Скрипт прогоняет её через счётчик так же, как игра (push на каждый новый кадр
// позы), и печатает:
//   • запись: длительность, кадров, частота и разброс интервалов, видимость плеч, таза, колен и лодыжек;
//   • повторы (засчитан/чистый, угол колена на дне, длительность) и незасчитанные попытки с причинами —
//     с временем от начала записи; переходы фаз счётчика; итог read().
// Ключи:
//   --mode novice|master        режим счётчика (по умолчанию — из записи, иначе — как у счётчика по умолчанию)
//   --exercise squats|pushups   упражнение (по умолчанию — из записи, иначе приседания)
//   --cfg '{"downDeg":105}'     подмена порогов счётчика (проверить правку на той же записи)
//   --trace [--every 100]       строка на каждые N мс: t, угол колена (сглаженный и сырой), фаза, вид — для графика
// Вместо файла можно «-» — запись со стандартного ввода.
// Как модуль: replayPose(запись, { mode, exercise, cfg, every }) → { summary, events, phases, trace }.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Squat from '../core/squatCounter.js';
import * as Pushup from '../core/pushupCounter.js';
import { loadPoseRecording } from '../core/poseRecorder.js';

const MODES = ['novice', 'master'];
const EXERCISE_NAMES = { squats: 'приседания', pushups: 'отжимания' };
const POINT_NAMES = {
  11: 'левое плечо', 12: 'правое плечо', 13: 'левый локоть', 14: 'правый локоть', 15: 'левое запястье', 16: 'правое запястье',
  23: 'левое бедро', 24: 'правое бедро', 25: 'левое колено', 26: 'правое колено', 27: 'левая лодыжка', 28: 'правая лодыжка',
};
// какие точки показывать в видимости: у приседаний — от плеч до лодыжек, у отжиманий — руки и таз
const VIS_POINTS = { squats: [11, 12, 23, 24, 25, 26, 27, 28], pushups: [11, 12, 13, 14, 15, 16, 23, 24] };
const ANKLES = [27, 28];
const PHASE_NAMES = { noPose: 'нет позы', setup: 'подготовка', top: 'наверху', descent: 'вниз', bottom: 'дно', ascent: 'подъём', up: 'верх', down: 'низ' };
const EXTRA_FIELDS = ['counted', 'clean', 'points', 'feet', 'mode'];   // поля нового счётчика — показываем, если есть
const GAP_MS = 100;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normExercise = (v) => (typeof v !== 'string' ? null : /^squat/i.test(v) ? 'squats' : /^push/i.test(v) ? 'pushups' : null);
const faultsOf = (lr) => (!lr ? [] : Array.isArray(lr.faults) ? lr.faults : lr.reason ? [lr.reason] : []);
// у отжиманий нет attempts: засчитанные + отклонённые + «мелко»
const attemptsOf = (r) => (fin(r.attempts) ? r.attempts : (r.reps || 0) + (r.rejected || 0) + (r.shallow || 0));
// попытка не засчитана: новый счётчик может пометить counted, старый — только ok
const isMiss = (lr) => lr.counted === false || (lr.counted === undefined && lr.ok === false);
const repKey = (lr) => (lr ? `${lr.tMs}|${lr.ok}|${lr.counted}|${faultsOf(lr).join(',')}` : null);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function recordStats(poses, exercise) {
  const n = poses.length;
  const seconds = n > 1 ? (poses[n - 1].tMs - poses[0].tMs) / 1000 : 0;
  const d = [];
  for (let i = 1; i < n; i++) d.push(poses[i].tMs - poses[i - 1].tMs);
  const s = d.slice().sort((a, b) => a - b);
  const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
  const sd = d.length ? Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length) : null;
  const r1 = (v) => (v === null ? null : +v.toFixed(1));
  const dt = { mean: r1(mean), sd: r1(sd), min: r1(quantile(s, 0)), median: r1(quantile(s, 0.5)), p95: r1(quantile(s, 0.95)), max: r1(quantile(s, 1)), gaps: d.filter((x) => x > GAP_MS).length };
  let noPoseFrames = 0;
  for (const p of poses) if (!p.landmarks.some(Boolean)) noPoseFrames++;
  const visibility = VIS_POINTS[exercise].map((i) => {
    let sum = 0, good = 0;
    for (const p of poses) { const v = p.landmarks[i] ? p.landmarks[i].visibility : 0; sum += v; if (v >= 0.5) good++; }
    const share = n ? good / n : 0;
    return { i, name: POINT_NAMES[i], mean: n ? +(sum / n).toFixed(3) : 0, share: +share.toFixed(3), low: share < 0.5 };
  });
  return { seconds: +seconds.toFixed(2), frames: n, hz: seconds > 0 ? +((n - 1) / seconds).toFixed(1) : null, dt, noPoseFrames, visibility };
}

/** Прогнать запись (объект/строка JSON файла или { meta, poses } из loadPoseRecording) через счётчик. */
export function replayPose(recording, { mode, exercise, cfg, every = 0 } = {}) {
  const rec = recording && Array.isArray(recording.poses) ? recording : loadPoseRecording(recording);
  const meta = rec.meta || {};
  const poses = rec.poses;
  const ex = normExercise(exercise) || normExercise(meta.exercise) || 'squats';
  const userCfg = cfg && typeof cfg === 'object' ? cfg : {};
  const md = mode ?? userCfg.mode ?? (MODES.includes(meta.mode) ? meta.mode : undefined);
  const counterCfg = { ...userCfg, ...(md ? { mode: md } : {}) };
  const counter = ex === 'pushups' ? Pushup.createPushupCounter(counterCfg) : Squat.createSquatCounter(counterCfg);

  const t0 = poses.length ? poses[0].tMs : 0;
  const rel = (t) => +((t - t0) / 1000).toFixed(3);
  const events = [], phases = [], trace = [];
  let prevPhase, prevKey = null, prevAttempts = 0, nextTrace = t0;
  for (const p of poses) {
    const t = p.tMs;
    counter.push({ tMs: t, landmarks: p.landmarks, frameW: p.frameW, frameH: p.frameH });
    const got = counter.drain();
    const r = counter.read();
    const lr = r.lastRep, key = repKey(lr), changed = key !== prevKey, att = attemptsOf(r);
    for (const e of got) {
      const tMs = fin(e.tMs) ? e.tMs : t;
      const ev = { type: 'rep', tMs, t: rel(tMs), rep: e.rep ?? null, clean: typeof e.clean === 'boolean' ? e.clean : null, minKnee: e.minKnee ?? null, ms: e.ms ?? null, faults: Array.isArray(e.faults) ? e.faults : [] };
      // засчитан, но с ошибками: причины — из lastRep того же кадра
      if (!ev.faults.length && changed && lr && !isMiss(lr) && lr.tMs === e.tMs) ev.faults = faultsOf(lr);
      for (const k of ['points', 'depth', 'counted']) if (e[k] !== undefined) ev[k] = e[k];
      events.push(ev);
    }
    if (changed && lr && isMiss(lr)) {
      const tMs = fin(lr.tMs) ? lr.tMs : t;
      events.push({ type: 'miss', tMs, t: rel(tMs), faults: faultsOf(lr) });
    } else if (!changed && att > prevAttempts && !got.length) {
      events.push({ type: 'miss', tMs: t, t: rel(t), faults: [] });
    }
    prevKey = key; prevAttempts = att;
    const phase = r.phase ?? r.state ?? null;
    if (phase !== prevPhase) { phases.push({ tMs: t, t: rel(t), from: prevPhase ?? null, to: phase }); prevPhase = phase; }
    if (every > 0 && t >= nextTrace) {
      while (nextTrace <= t) nextTrace += every;
      const dbg = typeof counter.getDebug === 'function' ? counter.getDebug() : {};
      trace.push({
        tMs: t, t: rel(t), knee: r.knee ?? r.elbow ?? null, kneeRaw: dbg.kneeRaw ?? null, n: dbg.n ?? null,
        depth: r.depth ?? null, phase, view: r.view ?? null, reps: r.reps,
      });
    }
  }

  const { checks, ...last } = counter.read();
  const dbg = typeof counter.getDebug === 'function' ? counter.getDebug() : {};
  const extra = {};
  for (const k of EXTRA_FIELDS) if (last[k] !== undefined) extra[k] = last[k];
  const summary = {
    exercise: ex, mode: md ?? null, cfg: userCfg, version: dbg.version ?? null,
    ...recordStats(poses, ex), dropped: fin(meta.dropped) ? meta.dropped : 0,
    reps: last.reps, attempts: attemptsOf(last), faults: last.faults || {}, formScore: last.formScore ?? null,
    misses: events.filter((e) => e.type === 'miss').length, extra, final: last,
  };
  return { summary, events, phases, trace };
}

// ——— CLI ———

const USAGE = [
  'Использование: node dev/squat_replay.mjs запись.json [--mode novice|master] [--exercise squats|pushups] [--cfg \'{json}\'] [--trace] [--every мс]',
  'Запись: экран тренировки, F8 — файл ashen-pose-….json (см. core/poseRecorder.js).',
].join('\n');

function parseArgs(argv) {
  const o = { file: null, mode: undefined, exercise: undefined, cfg: undefined, trace: false, every: 100 };
  const WITH_VALUE = new Set(['--mode', '--exercise', '--cfg', '--every']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    if (a.startsWith('--') && a.includes('=')) { v = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    if (a === '--trace') { o.trace = true; continue; }
    if (WITH_VALUE.has(a)) {
      if (v === undefined) { if (i + 1 >= argv.length) throw new Error(`после ${a} нужно значение`); v = argv[++i]; }
      if (a === '--mode') { if (!MODES.includes(v)) throw new Error(`--mode: novice или master, а не «${v}»`); o.mode = v; }
      else if (a === '--exercise') { o.exercise = normExercise(v); if (!o.exercise) throw new Error(`--exercise: squats или pushups, а не «${v}»`); }
      else if (a === '--every') { o.every = Number(v); if (!fin(o.every) || o.every <= 0) throw new Error(`--every: число миллисекунд > 0, а не «${v}»`); }
      else {
        try { o.cfg = JSON.parse(v); } catch (e) { throw new Error(`--cfg: не JSON (${e.message})`); }
        if (!o.cfg || typeof o.cfg !== 'object' || Array.isArray(o.cfg)) throw new Error('--cfg: нужен объект, например \'{"downDeg":105}\'');
      }
      continue;
    }
    if (a.startsWith('--')) throw new Error(`неизвестный ключ ${a}`);
    if (o.file) throw new Error(`лишний аргумент «${a}»`);
    o.file = a;
  }
  return o;
}

const sec = (t) => `${t.toFixed(2).padStart(7)} с`;
const pct = (v) => `${Math.round(v * 100)}%`;
// тексты подсказок и названия фаз — из счётчика, если он их экспортирует (у новичка подсказки свои)
const hintOf = (S, code) => (S.exercise === 'pushups' ? Pushup.PUSHUP_FAULTS?.[code]
  : (S.mode === 'novice' && Squat.SQUAT_HINTS_NOVICE?.[code]) || Squat.SQUAT_HINTS?.[code]) ?? null;
const phaseRu = (p) => (Squat.SQUAT_PHASE_RU && Squat.SQUAT_PHASE_RU[p]) || PHASE_NAMES[p];
const phaseName = (p) => (p === null || p === undefined ? '—' : phaseRu(p) ? `${p} (${phaseRu(p)})` : String(p));
const faultList = (S, list) => list.map((c) => { const h = hintOf(S, c); return h ? `${c} («${h}»)` : c; }).join('; ');
const nonZero = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));

function print(res, meta, file, args) {
  const { summary: S, events, phases, trace } = res;
  const out = (s = '') => console.log(s);
  const modeFrom = args.mode ? 'ключ --mode' : args.cfg && args.cfg.mode ? '--cfg' : S.mode ? 'из записи' : null;
  out(`Запись позы: ${file}`);
  out(`  формат ${meta.kind} v${meta.version}${meta.createdAt ? `, создана ${meta.createdAt}` : ''}`);
  const other = Object.fromEntries(Object.entries(meta).filter(([k]) => !['version', 'kind', 'createdAt', 'dropped'].includes(k)));
  if (Object.keys(other).length) out(`  метаданные: ${JSON.stringify(other)}`);
  out(`  длительность ${S.seconds.toFixed(2)} с, кадров ${S.frames}${S.dropped ? ` (до начала буфера отброшено ${S.dropped})` : ''}, средняя частота ${S.hz ?? '—'} Гц`);
  if (S.dt.mean !== null) {
    const f1 = (v) => v.toFixed(1);
    out(`  интервалы между кадрами, мс: среднее ${f1(S.dt.mean)} ± ${f1(S.dt.sd)}; мин ${f1(S.dt.min)} · медиана ${f1(S.dt.median)} · 95% ${f1(S.dt.p95)} · макс ${f1(S.dt.max)}; пропусков > ${GAP_MS} мс: ${S.dt.gaps}`);
  }
  out(`  кадров без позы: ${S.noPoseFrames} (${pct(S.frames ? S.noPoseFrames / S.frames : 0)})`);
  out('');
  out('Видимость точек (средняя · доля кадров ≥ 0.5):');
  for (const v of S.visibility) {
    const note = v.low ? (ANKLES.includes(v.i) && S.exercise === 'squats' ? '  — лодыжки почти не видны' : '  — плохо видна') : '';
    out(`  ${String(v.i).padStart(2)} ${v.name.padEnd(16)} ${v.mean.toFixed(2)} · ${pct(v.share).padStart(4)}${note}`);
  }
  out('');
  const ctor = S.exercise === 'pushups' ? 'createPushupCounter' : 'createSquatCounter';
  const shown = { ...S.cfg, ...(S.mode ? { mode: S.mode } : {}) };
  out(`Прогон: ${EXERCISE_NAMES[S.exercise]}, ${ctor}(${Object.keys(shown).length ? JSON.stringify(shown) : ''})` +
    `; режим: ${S.mode ? `${S.mode} (${modeFrom})` : 'по умолчанию счётчика'}${S.version ? `; версия ${S.version}` : ''}`);
  out('');
  out('Повторы и попытки:');
  if (!events.length) out('  (нет)');
  for (const e of events) {
    if (e.type === 'rep') {
      const what = e.clean === true ? 'засчитан, чистый' : e.clean === false ? 'засчитан, не чистый' : 'засчитан';
      const parts = [];
      if (e.minKnee !== null) parts.push(`дно ${e.minKnee}°`);
      if (e.depth !== undefined && e.minKnee === null) parts.push(`глубина ${e.depth}`);
      if (e.ms !== null) parts.push(`${e.ms} мс`);
      if (e.points !== undefined) parts.push(`очков ${e.points}`);
      if (e.faults.length) parts.push(`ошибки: ${faultList(S, e.faults)}`);
      out(`  ${sec(e.t)}  повтор${e.rep !== null ? ` #${e.rep}` : ''} ${what}${parts.length ? ' — ' + parts.join(', ') : ''}`);
    } else {
      out(`  ${sec(e.t)}  попытка не засчитана${e.faults.length ? ': ' + faultList(S, e.faults) : ''}`);
    }
  }
  out('');
  out('Фазы счётчика:');
  for (const p of phases) out(`  ${sec(p.t)}  ${p.from === null ? '' : phaseName(p.from) + ' → '}${phaseName(p.to)}`);
  out('');
  out('Итог:');
  out(`  повторов ${S.reps}, попыток ${S.attempts}, не засчитано ${S.misses}${S.formScore !== null ? `, техника ${pct(S.formScore)}` : ''}`);
  const f = nonZero(S.faults);
  out(`  ошибки: ${Object.keys(f).length ? Object.entries(f).map(([k, v]) => `${k} ×${v}`).join(', ') : 'нет'}`);
  if (Object.keys(S.extra).length) out(`  ${Object.entries(S.extra).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')}`);
  if (S.final.message) out(`  последнее сообщение: «${S.final.message}»`);
  if (trace.length) {
    out('');
    out(`Трасса (каждые ${args.every} мс):`);
    const push = S.exercise === 'pushups';
    out(['t, с', push ? 'локоть' : 'колено', push ? 'n' : 'сырой', 'глубина', 'фаза', 'вид', 'повторов'].join('\t'));
    const f1 = (v) => (v === null || v === undefined ? '—' : fin(v) ? String(+v.toFixed(1)) : String(v));
    for (const r of trace) out([r.t.toFixed(2), f1(r.knee), f1(push ? r.n : r.kneeRaw), f1(r.depth), r.phase ?? '—', r.view ?? '—', r.reps].join('\t'));
  }
}

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`Ошибка: ${e.message}\n${USAGE}`); return 1; }
  if (!args.file) { console.error(USAGE); return 1; }
  let text;
  try { text = readFileSync(args.file === '-' ? 0 : args.file, 'utf8'); } catch (e) {
    console.error(`Не удалось прочитать ${args.file}: ${e.code === 'ENOENT' ? 'нет такого файла' : e.message}`);
    return 1;
  }
  let rec;
  try { rec = loadPoseRecording(text); } catch (e) { console.error(`${args.file}: ${e.message}`); return 1; }
  if (!rec.poses.length) { console.error(`${args.file}: в записи нет кадров позы`); return 1; }
  const res = replayPose(rec, { mode: args.mode, exercise: args.exercise, cfg: args.cfg, every: args.trace ? args.every : 0 });
  print(res, rec.meta, args.file, args);
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
