// Тесты записи позы (core/poseRecorder.js, F8 на экране тренировки) и разбора dev/squat_replay.mjs.
// node dev/poseRecorder.test.mjs
// Синтетика, не реальная камера: поза — synthSquatPose вида спереди, только точки, что приходят в игре.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPoseRecorder, packPose, unpackPoseFrame, loadPoseRecording, POSE_RECORDING_VERSION } from '../core/poseRecorder.js';
import { createSquatCounter, synthSquatPose } from '../core/squatCounter.js';
import { replayPose } from './squat_replay.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

// точки, которые vision.getPose() отдаёт в игре (нос, уши, плечи, локти, запястья, бёдра, колени, лодыжки)
const COMPACT_INDICES = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
// сидовый ГПСЧ (mulberry32) — тесты детерминированы
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// поза «как с камеры»: все 15 точек, полная точность, часть — за краем кадра (MediaPipe экстраполирует)
function fullPose(rnd, tMs) {
  const L = new Array(33).fill(null);
  for (const i of COMPACT_INDICES) L[i] = { x: -0.3 + 1.6 * rnd(), y: -0.2 + 1.5 * rnd(), z: -0.8 + 1.6 * rnd(), visibility: rnd() };
  return { tMs, frameW: 1280, frameH: 720, mirror: true, landmarks: L };
}

// Синтетическая тренировка: стойка 1 с, reps медленных глубоких приседов вида спереди, стойка 1 с.
// Пятки и носки (29–32) обнулены — как в игре; небольшой шум точек и неровный шаг кадров (30 Гц ± 4 мс).
// Каждая поза подаётся в запись дважды — как getPose() на кадрах отрисовки без новой позы.
function synthSession({ reps = 3, fps = 30, downS = 1.6, upS = 1.2, holdS = 0.6, seed = 7, ankleVis, meta } = {}) {
  const rnd = rng(seed), noise = (a) => (rnd() * 2 - 1) * a;
  const rec = createPoseRecorder({ meta });
  const poses = [];
  let t = 50000;
  const frame = (k) => {
    const L = synthSquatPose(k, 'front');
    for (const j of [29, 30, 31, 32]) L[j] = null;
    const lm = L.map((p, i) => p && {
      x: p.x + noise(0.001), y: p.y + noise(0.001), z: noise(0.05),
      visibility: ankleVis !== undefined && (i === 27 || i === 28) ? ankleVis : Math.min(1, p.visibility + noise(0.03)),
    });
    const pose = { tMs: t, frameW: 640, frameH: 480, mirror: true, landmarks: lm };
    rec.add(pose); rec.add(pose);
    poses.push(pose);
    t += 1000 / fps + noise(4);
  };
  const ease = (i, n) => 0.5 - 0.5 * Math.cos(Math.PI * i / n);
  for (let i = 0; i < fps; i++) frame(0);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < fps * downS; i++) frame(ease(i, fps * downS));
    for (let i = 0; i < fps * upS; i++) frame(1 - ease(i, fps * upS));
    for (let i = 0; i < fps * holdS; i++) frame(0);
  }
  for (let i = 0; i < fps; i++) frame(0);
  return { rec, poses };
}

test('упаковка → JSON → распаковка: время, кадр, зеркало и 15 точек (x, y, z до 1e-4, vis до 1e-3)', () => {
  const rnd = rng(1);
  for (let n = 0; n < 50; n++) {
    const o = fullPose(rnd, 1234.56 + n * 33.3);
    const f = packPose(o);
    const u = unpackPoseFrame(JSON.parse(JSON.stringify(f)));
    assert(Math.abs(u.tMs - o.tMs) <= 0.05 && u.frameW === 1280 && u.frameH === 720 && u.mirror === true, 'шапка ' + JSON.stringify([u.tMs, u.frameW, u.mirror]));
    assert(Array.isArray(u.landmarks) && u.landmarks.length === 33, 'landmarks из 33');
    assert(Object.keys(f.lm).length === 15 && Object.keys(f.lm).every((k) => COMPACT_INDICES.includes(+k)), 'в кадре только непустые точки ' + Object.keys(f.lm));
    for (let i = 0; i < 33; i++) {
      const a = o.landmarks[i], b = u.landmarks[i];
      if (!a) { assert(b === null, `точка ${i} должна быть null`); continue; }
      const e = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
      assert(e <= 5e-5 + 1e-12 && Math.abs(a.visibility - b.visibility) <= 5e-4 + 1e-12, `точка ${i}: ошибка ${e}`);
    }
  }
  const u = unpackPoseFrame(packPose({ tMs: 5, mirror: false, landmarks: [] }));
  assert(u.mirror === false && u.frameW === 640 && u.frameH === 480 && u.landmarks.every((p) => p === null), 'зеркало выкл., размер по умолчанию');
});

test('мусор не бросает: нефинитные точки пропускаются, поза потеряна — lm: null', () => {
  const r = createPoseRecorder();
  for (const x of [null, undefined, 5, 'x', {}, { tMs: NaN }, { tMs: Infinity, landmarks: [] }, [1, 2]]) assert(r.add(x) === false, 'мусор записан: ' + JSON.stringify(x));
  assert(r.size() === 0, 'мусор не пишется');
  const L = [null, { x: NaN, y: 0.5 }, { x: 0.5, y: 'a' }, { x: 0.5, y: 0.5, z: Infinity }, { x: 0.5, y: 0.5, visibility: NaN }, { x: 0.1, y: 0.2 }, 7, 'p'];
  assert(r.add({ tMs: 10, landmarks: L }) && r.add({ tMs: 20, landmarks: 'x' }) && r.add({ tMs: 30, landmarks: null }), 'кадры с валидным временем');
  const fr = r.snapshot().frames;
  assert(fr.length === 3 && JSON.stringify(fr[0].lm) === '{"5":[0.1,0.2,0,1]}', 'осталась одна точка (z → 0, vis → 1): ' + JSON.stringify(fr[0].lm));
  assert(fr[1].lm === null && fr[2].lm === null, 'поза потеряна — lm: null');
  assert(unpackPoseFrame(fr[2]).landmarks === null, 'распаковка: landmarks null, как у vision.getPose() при потере');
  assert(unpackPoseFrame(null) === null && unpackPoseFrame({ t: 'x' }) === null, 'распаковка мусора → null');
  const u = unpackPoseFrame({ t: 1, lm: { 40: [0.1, 0.1], '-1': [0.1, 0.1], 3: [NaN, 1], 4: 'x', 5: [0.3, 0.4] } });
  assert(u.landmarks.length === 33 && u.landmarks.filter(Boolean).length === 1 && u.landmarks[5].visibility === 1, 'чужие индексы и мусор в точках');
});

test('повтор того же tMs подряд не пишется', () => {
  const r = createPoseRecorder();
  const p = synthSquatPose(0, 'front');
  assert(r.add({ tMs: 100, landmarks: p }) === true, 'первый кадр');
  assert(r.add({ tMs: 100, landmarks: p }) === false && r.add({ tMs: 100, landmarks: synthSquatPose(1, 'front') }) === false, 'повтор');
  r.add({ tMs: 133.3, landmarks: p }); r.add({ tMs: 133.3, landmarks: p });
  const s = r.snapshot();
  assert(r.size() === 2 && s.frames.map((f) => f.t).join() === '100,133.3', JSON.stringify(s.frames.map((f) => f.t)));
});

test('кольцевой буфер: старые кадры уходят, dropped считается; clear — с чистого листа; по умолчанию 2700', () => {
  const r = createPoseRecorder({ maxFrames: 10 });
  for (let i = 0; i < 25; i++) r.add({ tMs: i, landmarks: synthSquatPose(i / 25, 'front') });
  const s = r.snapshot();
  assert(r.size() === 10 && s.dropped === 15 && s.frames.length === 10, JSON.stringify({ n: r.size(), d: s.dropped }));
  assert(s.frames.map((f) => f.t).join() === '15,16,17,18,19,20,21,22,23,24', 'порядок ' + s.frames.map((f) => f.t));
  const u = unpackPoseFrame(s.frames[9]), p = synthSquatPose(24 / 25, 'front');
  assert(Math.abs(u.landmarks[25].y - p[25].y) < 1e-4, 'содержимое последнего кадра');
  r.clear();
  assert(r.size() === 0 && r.snapshot().dropped === 0 && r.snapshot().frames.length === 0, 'clear');
  r.add({ tMs: 24, landmarks: p });
  assert(r.size() === 1, 'после clear тот же tMs снова пишется');
  const big = createPoseRecorder();
  for (let i = 0; i < 2750; i++) big.add({ tMs: i * 33.3, landmarks: null });
  assert(big.size() === 2700 && big.snapshot().dropped === 50, 'по умолчанию 2700 кадров: ' + big.size());
});

test('snapshot сериализуем в JSON и читается loadPoseRecording обратно (строкой и объектом)', () => {
  const rnd = rng(3);
  const r = createPoseRecorder({ meta: { exercise: 'squats', build: 'test' } });
  const src = [];
  for (let i = 0; i < 40; i++) { const p = fullPose(rnd, 1000 + i * 33.4); src.push(p); r.add(p); }
  const snap = r.snapshot({ mode: 'master' });
  assert(snap.version === POSE_RECORDING_VERSION && snap.kind === 'ashen-pose' && typeof snap.createdAt === 'string' && snap.dropped === 0, 'шапка');
  assert(snap.exercise === 'squats' && snap.build === 'test' && snap.mode === 'master', 'meta и extra');
  const text = JSON.stringify(snap);
  assert(JSON.stringify(JSON.parse(text)) === text, 'JSON туда-обратно');
  assert(JSON.stringify(snap.frames[7]) === JSON.stringify(packPose(src[7])), 'кадр в файле = packPose (Float32 в памяти не портит округление)');
  for (const input of [text, '﻿' + text, JSON.parse(text)]) {
    const { meta, poses } = loadPoseRecording(input);
    assert(meta.kind === 'ashen-pose' && meta.mode === 'master' && meta.exercise === 'squats' && !('frames' in meta), 'meta ' + JSON.stringify(meta));
    assert(poses.length === 40 && poses.every((p) => p.landmarks.length === 33), 'позы');
    assert(Math.abs(poses[39].landmarks[26].x - src[39].landmarks[26].x) <= 5e-5, 'точка');
  }
});

test('чужой файл — понятная ошибка по-русски; запись кистей — «это запись кистей, F8 на экране тренировки»', () => {
  const err = (x) => { try { loadPoseRecording(x); } catch (e) { return e.message; } return null; };
  const hands = err({ version: 1, kind: 'ashen-hands', frames: [] });
  assert(hands && /запись кистей/.test(hands) && /F8/.test(hands) && /тренировк/.test(hands), hands);
  const other = err({ kind: 'something', frames: [] });
  assert(other && /не запись позы/.test(other) && /something/.test(other), other);
  assert(/не запись позы/.test(err('{}')) && /не запись позы/.test(err('[1,2]')) && /не запись позы/.test(err(null)), 'пустой объект/массив/null');
  assert(/JSON/.test(err('{oops')), 'не JSON: ' + err('{oops'));
  assert(/версии 2/.test(err({ version: 2, kind: 'ashen-pose', frames: [] })), 'версия: ' + err({ version: 2, kind: 'ashen-pose', frames: [] }));
  assert(/frames/.test(err({ version: 1, kind: 'ashen-pose' })), 'нет кадров');
});

test('кадр с 15 точками в JSON < 1 КБ', () => {
  const rnd = rng(9);
  let max = 0;
  for (let i = 0; i < 200; i++) max = Math.max(max, Buffer.byteLength(JSON.stringify(packPose(fullPose(rnd, 123456.789 + i * 33.3)))));
  assert(max < 1024, `кадр ${max} байт`);
});

test('replayPose: 3 медленных глубоких приседа спереди (30 Гц, без пяток и носков) → summary.reps === 3', () => {
  const { rec } = synthSession();
  const snap = JSON.parse(JSON.stringify(rec.snapshot()));
  const { summary, events, phases } = replayPose(snap);
  assert(summary.exercise === 'squats' && summary.reps === 3, 'reps ' + summary.reps + ' ' + JSON.stringify(summary.final));
  const reps = events.filter((e) => e.type === 'rep');
  assert(reps.length === 3 && reps.every((e, i) => e.t > 0 && (i === 0 || e.t > reps[i - 1].t)), 'события повторов по времени ' + JSON.stringify(reps));
  assert(phases.length >= 4 && phases[0].from === null && phases.every((p, i) => i === 0 || p.t >= phases[i - 1].t), 'фазы ' + phases.length);
  assert(summary.hz >= 29 && summary.hz <= 31 && summary.dt.median > 28 && summary.dt.median < 39 && summary.dt.gaps === 0, 'частота ' + JSON.stringify([summary.hz, summary.dt]));
  assert(summary.frames === snap.frames.length && summary.noPoseFrames === 0, 'кадров');
  const ank = summary.visibility.find((v) => v.i === 27);
  assert(summary.visibility.map((v) => v.i).join() === '11,12,23,24,25,26,27,28' && ank.share === 1 && !ank.low, 'видимость ' + JSON.stringify(ank));
});

test('разбор записи даёт то же, что счётчик вживую на тех же позах', () => {
  const { rec, poses } = synthSession({ reps: 4, seed: 11, holdS: 0.3 });
  const live = createSquatCounter();
  const liveReps = [];
  for (const p of poses) { live.push({ tMs: p.tMs, landmarks: p.landmarks, frameW: p.frameW, frameH: p.frameH }); liveReps.push(...live.drain()); }
  const { summary, events } = replayPose(loadPoseRecording(JSON.stringify(rec.snapshot())));
  const reps = events.filter((e) => e.type === 'rep');
  assert(summary.reps === live.read().reps && summary.attempts === live.read().attempts, `запись ${summary.reps}/${summary.attempts}, вживую ${live.read().reps}/${live.read().attempts}`);
  assert(reps.length === liveReps.length && reps.every((e, i) => Math.abs(e.tMs - liveReps[i].tMs) <= 0.05 && Math.abs((e.minKnee ?? 0) - (liveReps[i].minKnee ?? 0)) <= 1), 'события');
});

// [W3-SQUAT] эквивалентность и там, где разбор нужнее всего: поза пропадает, кадр не 4:3, «Новичок» и --cfg
test('разбор = вживую: потери позы, кадр 1280×720, «Новичок»; --cfg меняет результат', async () => {
  const { simulateSquatSession } = await import('./squatSim.mjs');
  let diff = 0, total = 0, cfgChanged = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const S = simulateSquatSession({ seed, n: 5, reps: 'novice', poseLossRate: 0.08, hz: 15, frameW: 1280, frameH: 720, cameraHeightM: 1.0, cameraPitchDeg: 8, distanceM: 2.7 });
    const rec = createPoseRecorder({ maxFrames: 100000 });
    const live = createSquatCounter({ mode: 'novice' });
    for (const f of S.frames) {
      const pose = Math.floor(f.tMs / 700) % 9 === 4 ? { ...f, landmarks: null } : f;   // ~0,7 с из 6 с — поза потеряна
      rec.add(pose); live.push({ tMs: pose.tMs, landmarks: pose.landmarks, frameW: pose.frameW, frameH: pose.frameH });
    }
    const recJson = loadPoseRecording(JSON.stringify(rec.snapshot()));
    const r = replayPose(recJson, { mode: 'novice' }).summary;
    total++;
    if (r.reps !== live.read().reps || r.attempts !== live.read().attempts) diff++;
    const r2 = replayPose(recJson, { mode: 'novice', cfg: { downDeg: 80 } }).summary;
    if (r2.reps !== r.reps) cfgChanged++;
  }
  assert(diff === 0, `разбор разошёлся с игрой в ${diff} из ${total} сессий`);
  assert(cfgChanged > 0, '--cfg (downDeg 80) должен менять счёт хотя бы в одной сессии');
});

test('лодыжки почти не видны — видно в разборе; неглубокие приседы — незасчитанные попытки с причинами', () => {
  const low = replayPose(synthSession({ ankleVis: 0.2 }).rec.snapshot()).summary;
  assert(low.visibility.filter((v) => v.low).map((v) => v.i).join() === '27,28', 'низкая видимость ' + JSON.stringify(low.visibility));
  // глубина 0,5 — до параллели не дошёл: попытки есть, повторов нет
  const rec = createPoseRecorder();
  let t = 1000;
  const f = (k) => { const L = synthSquatPose(k, 'front'); for (const j of [29, 30, 31, 32]) L[j] = null; rec.add({ tMs: t, frameW: 640, frameH: 480, landmarks: L }); t += 33.3; };
  for (let i = 0; i < 30; i++) f(0);
  for (let r = 0; r < 2; r++) { for (let i = 0; i < 40; i++) f(0.5 * Math.sin(Math.PI * i / 40)); for (let i = 0; i < 20; i++) f(0); }
  const { summary, events } = replayPose(rec.snapshot());
  const miss = events.filter((e) => e.type === 'miss');
  assert(summary.reps === 0 && miss.length === 2 && summary.misses === 2, 'попытки ' + JSON.stringify(events));
  assert(miss.every((e) => Array.isArray(e.faults) && e.faults.length > 0), 'причины ' + JSON.stringify(miss));
});

test('упражнение и режим: из meta записи по умолчанию, ключ важнее; отжимания на этой записи не падают', () => {
  const { rec } = synthSession({ reps: 1, meta: { exercise: 'pushups', mode: 'master' } });
  const snap = rec.snapshot();
  const a = replayPose(snap);
  assert(a.summary.exercise === 'pushups' && a.summary.mode === 'master' && typeof a.summary.reps === 'number', 'из записи ' + JSON.stringify([a.summary.exercise, a.summary.mode]));
  const b = replayPose(snap, { exercise: 'squats', mode: 'novice' });
  assert(b.summary.exercise === 'squats' && b.summary.mode === 'novice' && typeof b.summary.reps === 'number', 'ключи ' + JSON.stringify([b.summary.exercise, b.summary.mode]));
  const c = replayPose(synthSession().rec.snapshot(), { exercise: 'pushups', every: 100 });
  assert(typeof c.summary.reps === 'number' && Array.isArray(c.events) && c.trace.length > 50 && c.summary.visibility.length === 8, 'отжимания');
});

test('трасса: строка на каждые every мс, с углом колена и фазой', () => {
  const { trace, summary } = replayPose(synthSession({ reps: 1 }).rec.snapshot(), { every: 250 });
  const want = Math.floor(summary.seconds * 1000 / 250) + 1;
  assert(Math.abs(trace.length - want) <= 1, `строк ${trace.length}, ожидалось ≈ ${want}`);
  assert(trace.every((r, i) => i === 0 || r.t - trace[i - 1].t >= 0.2) && trace.some((r) => r.knee !== null && r.knee < 110), 'шаг и угол');
  assert(trace.every((r) => typeof r.phase === 'string'), 'фаза');
  assert(replayPose(synthSession({ reps: 1 }).rec.snapshot()).trace.length === 0, 'без every — пусто');
});

test('CLI: запись со стандартного ввода — код 0 и разбор; нет файла или чужой файл — код 1 и сообщение', () => {
  const cli = fileURLToPath(new URL('./squat_replay.mjs', import.meta.url));
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8' });
  const ok = run(['-', '--trace', '--every', '500'], JSON.stringify(synthSession().rec.snapshot()));
  assert(ok.status === 0 && /повтор #3/.test(ok.stdout) && /Видимость точек/.test(ok.stdout) && /Трасса/.test(ok.stdout), 'код ' + ok.status + '\n' + ok.stderr + ok.stdout.slice(0, 400));
  const none = run(['/нет/такого/файла.json']);
  assert(none.status === 1 && /нет такого файла/.test(none.stderr), 'нет файла: ' + none.status + ' ' + none.stderr);
  const hands = run(['-'], JSON.stringify({ version: 1, kind: 'ashen-hands', frames: [] }));
  assert(hands.status === 1 && /запись кистей/.test(hands.stderr), 'кисти: ' + hands.stderr);
  const bad = run(['-', '--mode', 'pro'], '{}');
  assert(bad.status === 1 && /novice или master/.test(bad.stderr), 'режим: ' + bad.stderr);
});

let pass = 0;
for (const t of tests) {
  try { await t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed (синтетика, не реальная камера)`);
if (pass !== tests.length) process.exitCode = 1;
