// Проверки симулятора позы приседающего перед камерой ноутбука (dev/squatSim.mjs). node dev/squatSim.test.mjs
// Проверяется сам симулятор (геометрия, камера, шум, частота, сценарий), не счётчик приседаний.
import {
  simulateSquatSession, repsPreset, synthPoseAt, poseGeometry, kneeForThigh, thighForEst, estForThigh,
  COMPACT_INDICES, FEET_INDICES, SQUAT_PRESETS,
} from './squatSim.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, m) { if (!c) throw new Error(m); }

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const col = (frames, i, k) => frames.filter((f) => f.landmarks && f.landmarks[i]).map((f) => f.landmarks[i][k]);
const f3 = (v) => (+v).toFixed(3);
const stand = (o = {}) => simulateSquatSession({ seed: 5, reps: [], standS: 6, tailS: 0, ...o });

test('детерминизм: тот же seed — те же кадры и сценарий, другой seed — другие', () => {
  const o = { seed: 7, reps: 'novice', n: 3, walk: true, fidget: true, arms: true, anklesHidden: true, outlierRate: 0.02 };
  const a = JSON.stringify(simulateSquatSession(o)), b = JSON.stringify(simulateSquatSession(o));
  assert(a === b, 'повтор с тем же seed отличается');
  assert(a !== JSON.stringify(simulateSquatSession({ ...o, seed: 8 })), 'другой seed дал то же самое');
  assert(JSON.stringify(repsPreset('clean', 4, 3)) === JSON.stringify(repsPreset('clean', 4, 3)), 'шаблон не детерминирован');
});

test('стоя лицом на 2,5 м, камера 1,0 м и +8°: голова в кадре, лодыжки у нижнего края или за ним, видимость низкая', () => {
  const S = stand({ distanceM: 2.5, cameraHeightM: 1.0, cameraPitchDeg: 8 });
  for (const i of [0, 7, 8, 11, 12]) {
    const y = mean(col(S.frames, i, 'y'));
    assert(y > 0.05 && y < 0.6, `точка ${i}: y ${f3(y)}`);
  }
  assert(mean(col(S.frames, 0, 'visibility')) > 0.85, 'нос плохо виден');
  for (const i of [27, 28]) {
    const y = mean(col(S.frames, i, 'y')), v = mean(col(S.frames, i, 'visibility'));
    assert(y >= 0.97, `лодыжка ${i} в кадре: y ${f3(y)}`);
    assert(v < 0.35, `лодыжка ${i}: видимость ${f3(v)}`);
  }
  const g = poseGeometry({ distanceM: 2.5 }, { heightM: 1.0, pitchDeg: 8 });
  assert(!g.image[27].inFrame && g.image[25].inFrame && g.image[0].inFrame, 'геометрия: лодыжки за кадром, колени и нос в кадре');
});

test('на 3,5 м (наклон 0) и с камерой 0,6 м (наклон 0) — лодыжки в кадре и видны; full дальше видит лучше lite', () => {
  for (const o of [{ distanceM: 3.5, cameraHeightM: 1.0, cameraPitchDeg: 0 }, { distanceM: 2.5, cameraHeightM: 0.6, cameraPitchDeg: 0 }]) {
    const S = stand(o);
    for (const i of [27, 28]) {
      const y = mean(col(S.frames, i, 'y')), v = mean(col(S.frames, i, 'visibility'));
      assert(y > 0.6 && y < 0.95, `${JSON.stringify(o)} лодыжка ${i}: y ${f3(y)}`);
      assert(v > 0.45, `${JSON.stringify(o)} лодыжка ${i}: видимость ${f3(v)}`);
    }
  }
  const far = { distanceM: 3.5, cameraPitchDeg: 0 };
  const lite = mean(col(stand(far).frames, 27, 'visibility')), full = mean(col(stand({ ...far, model: 'full' }).frames, 27, 'visibility'));
  const near = mean(col(stand({ distanceM: 2.2, cameraHeightM: 0.6, cameraPitchDeg: 0 }).frames, 27, 'visibility'));
  assert(full > lite + 0.1 && near > lite, `лодыжки: lite 3,5 м ${f3(lite)}, full ${f3(full)}, lite 2,2 м ${f3(near)}`);
});

test('θ больше — таз ниже в кадре, угол колена меньше (спереди и боком)', () => {
  for (const yawDeg of [0, 90]) {
    let prevY = -1, prevK = 181;
    for (const th of [0, 20, 40, 60, 80, 100]) {
      const L = synthPoseAt({ thighDeg: th, yawDeg, distanceM: 3 }, { heightM: 0.6, pitchDeg: 0 });
      const y = (L[23].y + L[24].y) / 2, k = kneeForThigh(th);
      assert(y > prevY + 0.01, `yaw ${yawDeg} θ ${th}: таз y ${f3(y)} ≤ ${f3(prevY)}`);
      assert(k < prevK, `θ ${th}: колено ${k.toFixed(1)}`);
      prevY = y; prevK = k;
    }
  }
  const g = poseGeometry({ thighDeg: 90 });
  assert(Math.abs(g.world[23].y - g.world[25].y) < 0.03, 'на параллели таз на высоте колена ' + f3(g.world[23].y - g.world[25].y));
});

test('боком (yaw 90) ширина таза в кадре мала; под 45° — между; дальняя сторона видна хуже', () => {
  const w = (yawDeg) => { const L = synthPoseAt({ yawDeg, distanceM: 3 }, { heightM: 0.6, pitchDeg: 0 }); return Math.abs(L[23].x - L[24].x); };
  const w0 = w(0), w45 = w(45), w90 = w(90);
  assert(w90 < 0.12 * w0 && w90 < 0.01, `таз: лицом ${f3(w0)}, боком ${f3(w90)}`);
  assert(w45 > w90 && w45 < w0 * 0.85, `под 45°: ${f3(w45)}`);
  const L = synthPoseAt({ yawDeg: 90, distanceM: 3 }, { heightM: 0.6, pitchDeg: 0 });
  // yaw 90: правый бок к камере — дальняя сторона левая (23, 25, 27)
  assert(L[23].visibility < L[24].visibility && L[25].visibility < L[26].visibility, `видимость: таз ${L[23].visibility}/${L[24].visibility}`);
});

test('частота: hz соблюдается, интервалы неравномерны (±20%), есть пропуски кадров', () => {
  for (const hz of [12, 15, 30]) {
    const S = stand({ hz, standS: 20 });
    const t = S.frames.map((f) => f.tMs), dts = t.slice(1).map((v, k) => v - t[k]);
    const base = 1000 / hz, rate = ((t.length - 1) * 1000) / (t[t.length - 1] - t[0]);
    assert(rate > hz * 0.9 && rate < hz * 1.02, `hz ${hz}: вышло ${rate.toFixed(2)}`);
    assert(dts.every((d) => d >= base * 0.8 - 0.2), `hz ${hz}: интервал ${Math.min(...dts)} < 0,8·${base.toFixed(1)}`);
    const single = dts.filter((d) => d <= base * 1.2 + 0.2);
    assert(single.length > dts.length * 0.9 && sd(single) > base * 0.05, `hz ${hz}: интервалы ровные (σ ${sd(single).toFixed(2)})`);
    assert(dts.some((d) => d > base * 1.6), `hz ${hz}: нет пропусков`);
    assert(t[0] === 1000, 't0 ' + t[0]);
  }
  const E = stand({ hz: 20, ideal: true, standS: 3, t0: 5000 });
  const d = E.frames.slice(1).map((f, k) => f.tMs - E.frames[k].tMs);
  assert(E.frames[0].tMs === 5000 && d.every((x) => Math.abs(x - 50) < 0.11), 'ideal: ровно 50 мс');
});

test('дрожь: σ точек ≈ jitter/2 (y — доля высоты, x — столько же пикселей); без шума — ноль', () => {
  for (const jitter of [0.01, 0.02, 0.03]) {
    const S = stand({ ideal: true, jitter, hz: 30, standS: 12 });
    for (const i of [0, 11, 12]) {
      const sy = sd(col(S.frames, i, 'y')), sx = sd(col(S.frames, i, 'x'));
      assert(Math.abs(sy - jitter / 2) < jitter * 0.08, `jitter ${jitter} точка ${i}: σy ${sy.toFixed(4)}`);
      assert(Math.abs(sx - (jitter / 2) * 0.75) < jitter * 0.08, `jitter ${jitter} точка ${i}: σx ${sx.toFixed(4)}`);
    }
  }
  const Z = stand({ ideal: true, hz: 30 });
  assert(sd(col(Z.frames, 11, 'y')) < 1e-4 && sd(col(Z.frames, 25, 'x')) < 1e-4, 'ideal шумит');
  // выбросы: редкие большие отклонения
  const O = stand({ ideal: true, jitter: 0.02, outlierRate: 0.05, hz: 30, standS: 12 });
  const ys = col(O.frames, 11, 'y'), m = mean(ys);
  const big = ys.filter((y) => Math.abs(y - m) > 0.035).length / ys.length;
  assert(big > 0.01 && big < 0.08, 'доля выбросов ' + big.toFixed(3));
});

test('truth.reps совпадает со сценарием; standingIntervals — между повторами', () => {
  const reps = [
    { thighDeg: 90, downS: 1.0, upS: 0.8, bottomS: 0.2, topS: 0.5 },
    { thighDeg: 60, downS: 0.7, upS: 0.6, bottomS: 0, topS: 1.0, leanDeg: 50 },
    { thighDeg: 100, downS: 1.2, upS: 1.0, bottomS: 0.3, topS: 0.4, noLockout: true },
    { thighDeg: 85, downS: 1.1, upS: 0.9, bottomS: 0.1, topS: 0.6 },
  ];
  const S = simulateSquatSession({ seed: 2, reps, standS: 2, tailS: 1, ideal: true, hz: 30, trace: true });
  const R = S.truth.reps;
  assert(R.length === 4, 'повторов ' + R.length);
  assert(R[0].tStart === 3000, 'начало ' + R[0].tStart);
  R.forEach((r, i) => {
    const q = reps[i];
    assert(r.thighDeg === q.thighDeg && r.estDeg === 180 - q.thighDeg && r.estDeg === estForThigh(q.thighDeg), `θ/est ${i}: ${JSON.stringify(r)}`);
    assert(Math.abs(r.tBottom - r.tStart - q.downS * 1000) < 1 && Math.abs(r.tRise - r.tBottom - q.bottomS * 1000) < 1 && Math.abs(r.tEnd - r.tRise - q.upS * 1000) < 1, `времена ${i}: ${JSON.stringify(r)}`);
    if (i) assert(Math.abs(r.tStart - R[i - 1].tEnd - reps[i - 1].topS * 1000) < 1, `пауза перед ${i}`);
    assert(Math.abs(r.kneeDeg - kneeForThigh(q.thighDeg)) < 0.2 && r.kneeDeg < 180 - 1.2 * q.thighDeg && r.kneeDeg > 180 - 1.5 * q.thighDeg, `колено ${i}: ${r.kneeDeg}`);
    // в кадрах трассы θ на дне — как в сценарии
    const bot = S.truth.trace.filter((x) => x.tMs >= r.tBottom && x.tMs <= r.tRise);
    assert(!bot.length || bot.every((x) => Math.abs(x.thighDeg - q.thighDeg) < 0.01), `трасса на дне ${i}`);
  });
  assert(Math.abs(R[1].leanDeg - 50) < 0.5, 'явный наклон ' + R[1].leanDeg);
  assert(!R[2].lockout && R[2].topDeg >= 25 && R[2].topDeg <= 35 && R[0].lockout && R[0].topDeg === 0, 'noLockout ' + JSON.stringify(R[2]));
  assert(thighForEst(115) === 65, 'thighForEst');
  // стоит: в начале, в паузах после выпрямления, в конце; пауза без выпрямления — не стоит
  const SI = S.truth.standingIntervals;
  assert(SI[0].tStart === 1000 && SI[0].tEnd === 3000 && SI[SI.length - 1].tEnd === S.truth.durationMs + 1000, 'интервалы ' + JSON.stringify(SI));
  assert(SI.some((x) => x.tStart === R[0].tEnd) && !SI.some((x) => x.tStart === R[2].tEnd), 'пауза после noLockout — не «стоит»');
  // в кадрах таз на дне ниже, чем стоя
  const hipY = (tMs) => { const f = S.frames.reduce((b, x) => (Math.abs(x.tMs - tMs) < Math.abs(b.tMs - tMs) ? x : b)); return (f.landmarks[23].y + f.landmarks[24].y) / 2; };
  assert(hipY(R[0].tBottom) > hipY(2000) + 0.1, `таз: стоя ${f3(hipY(2000))}, дно ${f3(hipY(R[0].tBottom))}`);
});

test('шаблоны повторов: глубина и темп по описанию', () => {
  const all = (name, f) => repsPreset(name, 40, 11).every(f);
  assert(SQUAT_PRESETS.includes('clean') && SQUAT_PRESETS.includes('tooShallow'), 'список шаблонов');
  assert(all('clean', (r) => r.thighDeg >= 85 && r.thighDeg <= 100 && r.downS >= 1.0 && r.downS <= 1.4), 'clean');
  assert(all('novice', (r) => r.thighDeg >= 55 && r.thighDeg <= 75 && r.downS >= 0.6 && r.downS <= 1.0 && r.topS >= 0.3 && r.topS <= 0.8 && r.leanDeg >= 38), 'novice');
  assert(all('shallow115', (r) => estForThigh(r.thighDeg) >= 110 && estForThigh(r.thighDeg) <= 120), 'shallow115');
  assert(all('tooShallow', (r) => r.thighDeg >= 25 && r.thighDeg <= 40), 'tooShallow');
  assert(all('fast', (r) => r.downS >= 0.3 && r.downS <= 0.4 && r.upS >= 0.3 && r.upS <= 0.4), 'fast');
  assert(repsPreset('clean', 3, 1).length === 3 && JSON.stringify(repsPreset('clean', 3, 1)) !== JSON.stringify(repsPreset('clean', 3, 2)), 'n и seed');
  let threw = false;
  try { repsPreset('нет такого', 2, 1); } catch (e) { threw = true; }
  assert(threw, 'неизвестный шаблон — ошибка');
  const S = simulateSquatSession({ reps: 'fast', n: 4, seed: 3 });
  assert(S.truth.reps.length === 4 && S.truth.reps.every((r) => r.downS <= 0.4), 'reps по имени шаблона');
});

test('точки: по умолчанию только COMPACT_INDICES, withFeet — ещё пятки и носки', () => {
  const S = simulateSquatSession({ seed: 4, reps: 'clean', n: 1 });
  const f = S.frames[20];
  assert(f.frameW === 640 && f.frameH === 480 && f.mirror === true && f.landmarks.length === 33, 'кадр ' + JSON.stringify({ ...f, landmarks: undefined }));
  const filled = f.landmarks.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  assert(JSON.stringify(filled) === JSON.stringify(COMPACT_INDICES), 'заполнены ' + filled);
  const p = f.landmarks[11];
  assert(['x', 'y', 'z', 'visibility'].every((k) => Number.isFinite(p[k])) && p.visibility >= 0 && p.visibility <= 1, 'точка ' + JSON.stringify(p));
  const W = simulateSquatSession({ seed: 4, reps: 'clean', n: 1, withFeet: true }).frames[20].landmarks;
  assert(FEET_INDICES.every((i) => W[i]) && W.filter(Boolean).length === COMPACT_INDICES.length + 4, 'withFeet');
  // правая рука человека (12) — слева в незеркальном кадре
  assert(f.landmarks[12].x < f.landmarks[11].x, 'стороны');
});

test('видимость: anklesHidden — 0,05–0,45; провалы 0,1–0,4; за краем ≤ 0,3', () => {
  const H = stand({ anklesHidden: true, cameraHeightM: 0.6, cameraPitchDeg: 0 });
  const va = [...col(H.frames, 27, 'visibility'), ...col(H.frames, 28, 'visibility')];
  assert(va.every((v) => v >= 0.02 && v <= 0.45) && mean(va) > 0.12, `лодыжки скрыты: ${f3(Math.min(...va))}…${f3(Math.max(...va))}`);
  assert(mean(col(H.frames, 25, 'visibility')) > 0.5, 'колени при скрытых лодыжках видны');
  const D = stand({ ideal: true, dropoutRate: 0.1, hz: 30 });
  const vs = col(D.frames, 11, 'visibility');
  const low = vs.filter((v) => v < 0.5);
  assert(low.length > vs.length * 0.08 && low.every((v) => v >= 0.1 && v <= 0.4), `провалы: ${low.length}/${vs.length}`);
  const O = stand({});
  assert(col(O.frames, 27, 'visibility').every((v) => v <= 0.3), 'за краем видимость выше 0,3');
  const ys = col(O.frames, 27, 'y'), g = poseGeometry({}).image[27].y;
  assert(mean(ys) > 1 && mean(ys) < g, `за краем позиция поджата к краю: ${f3(mean(ys))} при истинной ${f3(g)}`);
});

test('корпус: автонаклон растёт с θ до 35–45° на параллели; leanDeg — явно', () => {
  let prev = -1;
  for (const th of [0, 30, 60, 90, 110]) {
    const a = poseGeometry({ thighDeg: th }).leanDeg;
    assert(a >= prev, `θ ${th}: α ${a.toFixed(1)} < ${prev.toFixed(1)}`);
    prev = a;
  }
  const a0 = poseGeometry({ thighDeg: 0 }).leanDeg, a90 = poseGeometry({ thighDeg: 90 }).leanDeg;
  assert(a0 < 3 && a90 >= 35 && a90 <= 45, `α стоя ${a0.toFixed(1)}, на параллели ${a90.toFixed(1)}`);
  assert(poseGeometry({ thighDeg: 90, leanDeg: 55 }).leanDeg === 55, 'leanDeg');
  const S = simulateSquatSession({ reps: [{ thighDeg: 90 }], leanDeg: 20, ideal: true });
  assert(Math.abs(S.truth.reps[0].leanDeg - 20) < 0.5, 'leanDeg сессии ' + S.truth.reps[0].leanDeg);
  // спереди при наклоне корпус в кадре короче
  const tor = (lean) => { const L = synthPoseAt({ thighDeg: 60, leanDeg: lean }, { heightM: 0.6, pitchDeg: 0 }); return L[23].y - L[11].y; };
  assert(tor(50) < tor(10) * 0.8, `корпус: ${f3(tor(10))} → ${f3(tor(50))}`);
});

test('колени: valgus — сходятся внутрь, kneesOut — шире (спереди, на дне)', () => {
  const q = (o) => { const L = synthPoseAt({ thighDeg: 90, ...o }, { heightM: 0.6, pitchDeg: 0 }); return Math.abs(L[25].x - L[26].x) / Math.abs(L[27].x - L[28].x); };
  const n = q({}), v = q({ valgus: 1 }), v5 = q({ valgus: 0.5 }), o = q({ kneesOut: 1 });
  assert(n > 0.95 && v < 0.5 && v5 < n * 0.75 && v5 > v && o > n + 0.1, `колени/лодыжки: норма ${f3(n)}, valgus ${f3(v)} / ${f3(v5)}, kneesOut ${f3(o)}`);
});

test('помехи: walk меняет расстояние, fidget — наклон без приседа, arms — руки над головой; всё в truth.events', () => {
  const S = simulateSquatSession({ seed: 9, reps: 'clean', n: 4, walk: true, fidget: [0], arms: [-1], trace: true, ideal: true, cameraHeightM: 0.6, cameraPitchDeg: 0 });
  const ev = S.truth.events, kinds = ev.map((e) => e.kind).sort().join(',');
  assert(kinds === 'arms,fidget,walk', 'события ' + kinds);
  const w = ev.find((e) => e.kind === 'walk'), d = Math.abs(w.toM - w.fromM);
  assert(d >= 0.3 && d <= 0.6, 'шаг ' + JSON.stringify(w));
  const shW = (tMs) => { const f = S.frames.find((x) => x.tMs >= tMs); return Math.abs(f.landmarks[11].x - f.landmarks[12].x); };
  const ratio = shW(w.tEnd + 50) / shW(w.tStart - 50);
  assert(Math.abs(ratio - w.fromM / w.toM) < 0.05, `плечи в кадре ×${ratio.toFixed(3)} при ${w.fromM}→${w.toM} м`);
  const fid = ev.find((e) => e.kind === 'fidget'), tr = S.truth.trace.filter((x) => x.tMs >= fid.tStart && x.tMs <= fid.tEnd);
  assert(tr.every((x) => x.thighDeg <= 15) && Math.max(...tr.map((x) => x.leanDeg)) >= 25, 'fidget: θ ' + Math.max(...tr.map((x) => x.thighDeg)));
  const arm = ev.find((e) => e.kind === 'arms');
  assert(arm.tEnd <= S.truth.reps[0].tStart, 'руки — до первого повтора');
  const up = S.frames.filter((f) => f.tMs >= arm.tStart && f.tMs <= arm.tEnd && f.landmarks[15].y < f.landmarks[11].y);
  assert(up.length > 5, 'запястья над плечами: ' + up.length);
  assert(S.truth.reps.length === 4, 'повторы с помехами ' + S.truth.reps.length);
});

test('точка бедра на дне выше настоящей (hipShiftM); стоя — без смещения', () => {
  const y = (th, hipShiftM) => synthPoseAt({ thighDeg: th }, {}, { hipShiftM })[23].y;
  const d90 = y(90, 0) - y(90, 0.04), d0 = y(0, 0) - y(0, 0.04);
  assert(d90 > 0.012 && d90 < 0.03 && Math.abs(d0) < 1e-4, `смещение: дно ${f3(d90)}, стоя ${f3(d0)}`);
});

test('мусорные опции не ломают', () => {
  const S = simulateSquatSession({ hz: 'x', reps: [{}, null, { thighDeg: 'a', downS: -1 }], n: 'b', jitter: -1, model: '?' });
  assert(S.frames.length > 50 && S.truth.reps.length === 3 && S.truth.reps.every((r) => r.thighDeg === 90), JSON.stringify(S.truth.reps[0]));
  assert(S.frames.every((f) => f.landmarks.filter(Boolean).every((p) => Number.isFinite(p.x) && Number.isFinite(p.visibility))), 'NaN в точках');
  assert(Array.isArray(synthPoseAt()) && synthPoseAt().length === 33, 'synthPoseAt без аргументов');
});

let pass = 0;
for (const t of tests) {
  try { t.fn(); pass++; console.log('PASS ', t.name); } catch (e) { console.log('FAIL ', t.name, '\n      →', e.message); }
}
console.log(`${pass}/${tests.length} passed (симулятор позы, не реальная камера)`);
if (pass !== tests.length) process.exitCode = 1;
