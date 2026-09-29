/*
 * ASHEN OATH — vision.test.mjs · API_VERSION=ASHEN_V1 · роль №2.
 * Запуск: node vision.test.mjs   (Node 18+, без сторонних зависимостей; файл рядом с vision.js
 * и vision-worker.js).
 *
 * ВАЖНО: это тесты на ИСКУССТВЕННЫХ landmarks и подделках браузерных API. Они проверяют
 * логику интерпретации, протокол worker и оболочку createVision, но НЕ реальную вебку,
 * реальный MediaPipe, GPU, FPS или задержку. Проверки с живой камерой — отдельно
 * (vision-webcam-check.html и чек-лист в 02_HANDOFF.txt).
 *
 * Разделы:
 *   A. Интерпретатор на синтетических позах (createPoseInterpreter).
 *   B. vision-worker.js в поддельном окружении worker с поддельным MediaPipe.
 *   C. Оболочка createVision с поддельными камерой, видео, часами и MediaPipe
 *      (главный поток и режим worker через поддельный Worker).
 */

const V = await import('../modules/vision.js');
const {
  createPoseInterpreter, createVision, mergeVisionConfig, unpackCompactLandmarks,
  resolveMediaPipe, mapCameraError, API_VERSION, COMPACT_INDICES, COMPACT_STRIDE, DEFAULT_VISION_CONFIG,
} = V;

// ───────────────────────── мини-харнесс ─────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(cond, msg) { if (!cond) throw new Error(msg || 'условие не выполнено'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'ожидалось равенство'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'ожидалась близость'}: ${a} vs ${b} (±${tol})`); }
async function rejects(p, code, msg) {
  let err = null;
  try { await p; } catch (e) { err = e; }
  ok(err, `${msg || 'ожидался отказ'}: промис выполнился`);
  if (code) eq(err.code, code, `${msg || 'код ошибки'}`);
  return err;
}

// ───────────────────── синтетические позы ─────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
const lerp = (a, b, u) => a + (b - a) * u;

/*
 * Модель сидящего человека в НЕзеркальном кадре камеры 640×480 (нормированные x,y).
 * lean — наклон к СОБСТВЕННОЙ правой стороне игрока в долях ширины плеч (sw): в сыром
 * кадре камеры это сдвиг влево по изображению. Правое плечо человека (idx 12) — слева.
 * up (0..1) — подъём руки: 0 — рука лежит, 1 — запястье заметно выше плеча.
 */
function defaultPoseState() {
  return {
    lean: 0, rightUp: 0, leftUp: 0, cx0: 0.5, shY: 0.55, sw: 0.26, scale: 1,
    shVis: 0.99, elVis: 0.95, wrVisR: 0.95, wrVisL: 0.95, visZero: false,
    noise: 0.0015, spike: 0, present: true, frames: true, w: 640, h: 480,
    // [глубина] noseDy — смещение носа вниз (доли кадра); persp — центр плеч масштабируется
    // вокруг центра кадра вместе с scale (камера-обскура: игрок сбоку от оси при приближении «уезжает» к краю)
    noseDy: 0, persp: false,
  };
}
function makeLandmarks(s, rng) {
  const n = () => (s.noise > 0 ? s.noise * gauss(rng) : 0);
  const sw = s.sw * s.scale;
  const cx = s.persp
    ? 0.5 + (s.cx0 - 0.5 - s.lean * s.sw) * s.scale + s.spike * s.sw
    : s.cx0 - s.lean * s.sw + s.spike * s.sw;
  const out = [];
  for (let i = 0; i < 33; i++) out.push({ x: cx + n(), y: 0.95, z: 0, visibility: s.visZero ? 0 : 0.3 });
  const vis = (v) => (s.visZero ? 0 : v);
  out[0] = { x: cx + n(), y: s.shY - 0.25 * s.scale + (s.noseDy || 0) + n(), z: -0.2, visibility: vis(0.99) };
  const arm = (side, up, wrVis) => {
    const dir = side === 'right' ? -1 : 1; // правая сторона человека — слева в сыром кадре
    const sx = cx + dir * sw / 2;
    const ex = sx + dir * sw * 0.15;
    const ey = s.shY + lerp(0.2, -0.02, up) * s.scale;
    const wx = sx + dir * sw * lerp(0.1, 0.25, up);
    const wy = s.shY + lerp(0.33, -0.28, up) * s.scale;
    return {
      sh: { x: sx + n(), y: s.shY + n(), z: 0, visibility: vis(s.shVis) },
      el: { x: ex + n(), y: ey + n(), z: 0, visibility: vis(s.elVis) },
      wr: { x: wx + n(), y: wy + n(), z: 0, visibility: vis(wrVis) },
    };
  };
  const R = arm('right', s.rightUp, s.wrVisR);
  const L = arm('left', s.leftUp, s.wrVisL);
  out[12] = R.sh; out[14] = R.el; out[16] = R.wr;
  out[11] = L.sh; out[13] = L.el; out[15] = L.wr;
  return out;
}

// Симулятор: видеокадры с частотой fps, игровые read() на 60 Гц — как у главного сборщика.
function createSim(config = {}, o = {}) {
  // корпусные стрейф/рывок проверяются в режиме отката torsoMove (в игре выключен, ASHEN_V2)
  const interp = createPoseInterpreter({ mirror: true, torsoMove: true, ...config });
  const rng = mulberry32(o.seed ?? 12345);
  const s = { ...defaultPoseState(), ...(o.state || {}) };
  let t = o.t0 ?? 10000;
  let nextFrame = t;
  let frameDt = 1000 / (o.fps ?? 30);
  function frameAt(tf, poseFn, tStart) {
    if (poseFn) poseFn(s, tf - tStart);
    if (s.frames) {
      interp.pushObservation({ tMs: tf, frameW: s.w, frameH: s.h, landmarks: s.present ? makeLandmarks(s, rng) : null });
    }
    s.spike = 0;
  }
  function run(ms, poseFn, opt = {}) {
    const tStart = t;
    const end = t + ms;
    const out = [];
    while (t < end - 1e-9) {
      const tn = Math.min(end, t + 1000 / 60);
      while (nextFrame <= tn) { frameAt(nextFrame, poseFn, tStart); nextFrame += frameDt; }
      t = tn;
      if (opt.tick) interp.tick(t);
      if (opt.read !== false) out.push({ ...interp.read(t), t, rel: t - tStart });
      if (opt.until && opt.until()) break;
    }
    return out;
  }
  function calibrate(poseFn) {
    interp.beginCalibration(t);
    const out = run(4000, poseFn, { until: () => { const c = interp.calibrationStatus(); return c && c.result; } });
    const c = interp.calibrationStatus();
    ok(c && c.result === 'done', `калибровка не завершилась: ${JSON.stringify(c)}`);
    interp.ackCalibration();
    return out;
  }
  return { interp, s, run, calibrate, now: () => t, setFps: (f) => { frameDt = 1000 / f; } };
}
const dashes = (frames) => frames.filter((f) => f.dash !== 0);
const moveTo = (from, to, ms, delay = 0) => (s, rel) => { s.lean = lerp(from, to, smooth((rel - delay) / ms)); };
const armTo = (key, from, to, ms, delay = 0) => (s, rel) => { s[key] = lerp(from, to, smooth((rel - delay) / ms)); };

// ═══════════════════ A. интерпретатор на синтетике ═══════════════════

test('A01 до калибровки ввод невалиден и обнулён', () => {
  const sim = createSim();
  const f = sim.run(500, null).pop();
  eq(f.valid, false, 'valid'); eq(f.calibrated, false, 'calibrated');
  eq(f.moveX, 0); eq(f.dash, 0); eq(f.attack, false); eq(f.shield, false); eq(f.burst, false);
  eq(f.source, 'cv');
});

test('A02 калибровка: медианы по окну, ширина плеч, высота рук, шум', () => {
  const sim = createSim();
  sim.run(300, null);
  const t0 = sim.now();
  const during = sim.calibrate(null);
  ok(during.slice(0, -1).every((f) => !f.valid && f.moveX === 0), 'во время калибровки ввод невалиден');
  const dur = sim.now() - t0;
  ok(dur >= 1400 && dur <= 2200, `длительность калибровки ${dur} мс`);
  const b = sim.interp.getBaseline();
  near(b.width, 0.26 * 640 / 480, 0.01, 'ширина плеч (ед. высоты кадра)');
  near(b.cx / b.aspect, 0.5, 0.005, 'центр плеч');
  near(b.restRise.right, (0.55 - 0.88) / (0.26 * 4 / 3), 0.05, 'естественная высота правой руки');
  ok(b.restRise.left !== null, 'высота левой руки');
  ok(b.noise >= DEFAULT_VISION_CONFIG.minNoise, 'шум не ниже минимума');
  ok(sim.interp.getDerived().deadZone >= 0.06, 'dead zone');
  const f = sim.run(100, null).pop();
  eq(f.valid, true, 'после калибровки valid'); eq(f.calibrated, true);
});

test('A03 нейтраль с шумом и одиночными выбросами: нет рывка, moveX≈0', () => {
  const sim = createSim();
  sim.calibrate(null);
  let spikes = 0;
  const out = sim.run(8000, (s, rel) => {
    const i = Math.round(rel / (1000 / 30)); // номер видеокадра
    if (i % 21 === 0) { s.spike = (i / 21) % 2 ? 0.7 : -0.7; spikes++; } // одиночный большой выброс
    else if (i % 21 === 10) s.spike = 0.3; // одиночный средний выброс (проходит отсечку, гасится фильтром)
  });
  eq(dashes(out).length, 0, 'рывков');
  // Одиночный выброс 0.7 sw отбрасывается полностью; одиночный 0.3 sw проходит отсечку и
  // даёт короткий слабый всплеск стрейфа (честно фиксируем, это не рывок).
  const maxMove = Math.max(...out.map((f) => Math.abs(f.moveX)));
  ok(maxMove < 0.35, `максимальный |moveX| = ${maxMove}`);
  let run = 0; let maxRun = 0;
  for (const f of out) { run = f.moveX !== 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
  ok(maxRun * (1000 / 60) <= 170, `самый длинный всплеск moveX ${Math.round(maxRun * 1000 / 60)} мс`);

  ok(sim.interp.getDebug().counters.rejectedSpikes >= spikes, `отброшено выбросов ${sim.interp.getDebug().counters.rejectedSpikes} из ${spikes}`);
});

test('A03b нейтраль с обычным шумом: moveX тождественно 0, рывков нет', () => {
  const sim = createSim({}, { seed: 99 });
  sim.calibrate(null);
  const out = sim.run(10000, null);
  eq(dashes(out).length, 0, 'рывков');
  const nonZero = out.filter((f) => f.moveX !== 0).length / out.length;
  ok(nonZero < 0.01, `доля ненулевого moveX ${nonZero}`);
});

test('A04 шумная камера: dead zone растёт по измеренному шуму, ложных рывков нет', () => {
  const clean = createSim({}, { state: { noise: 0.0015 } });
  clean.calibrate(null);
  const noisy = createSim({}, { state: { noise: 0.012 }, seed: 7 });
  noisy.calibrate(null);
  const dc = clean.interp.getDerived().deadZone;
  const dn = noisy.interp.getDerived().deadZone;
  ok(dn > dc, `dead zone шумной ${dn} > чистой ${dc}`);
  const out = noisy.run(6000, null);
  eq(dashes(out).length, 0, 'рывков на шумной нейтрали');
});

test('A05 медленный наклон: плавный moveX до 1, без рывка', () => {
  const sim = createSim();
  sim.calibrate(null);
  const out = sim.run(2600, moveTo(0, 0.4, 2000));
  eq(dashes(out).length, 0, 'рывков');
  const last = out[out.length - 1];
  ok(last.moveX > 0.95, `итоговый moveX ${last.moveX}`);
  const mid = out.find((f) => f.rel >= 1000);
  ok(mid.moveX > 0.05 && mid.moveX < 0.9, `промежуточный moveX ${mid.moveX}`);
  let drops = 0;
  for (let i = 1; i < out.length; i++) if (out[i].moveX < out[i - 1].moveX - 0.05) drops++;
  eq(drops, 0, 'moveX без провалов на монотонном наклоне');
  eq(sim.interp.getDebug().dash.reason, 'slow-lean', 'причина снятия взвода');
});

test('A06 умеренно быстрый, но комфортный наклон (0.4 sw за 600 мс) не рывок', () => {
  const sim = createSim();
  sim.calibrate(null);
  const out = sim.run(1200, moveTo(0, 0.4, 600));
  eq(dashes(out).length, 0, 'рывков');
});

test('A07 быстрый выход (0.4 sw за 180 мс): ровно один dash +1 во время движения', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const out = sim.run(1000, moveTo(0, 0.4, 180));
  const d = dashes(out);
  eq(d.length, 1, 'число рывков');
  eq(d[0].dash, 1, 'направление');
  ok(d[0].rel <= 200, `рывок выдан через ${d[0].rel.toFixed(0)} мс после начала движения (до завершения выхода)`);
  ok(out[out.length - 1].moveX > 0.95, 'после рывка удерживаемый наклон даёт стрейф');
});

test('A08 возврат к центру с перелётом не даёт противоположный рывок; повторный рывок после нейтрали', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const a = sim.run(700, moveTo(0, 0.4, 180));
  eq(dashes(a).length, 1, 'первый рывок');
  // быстрый возврат с перелётом на −0.15 sw и успокоение
  const b = sim.run(900, (s, rel) => {
    if (rel < 200) s.lean = lerp(0.4, -0.15, smooth(rel / 200));
    else s.lean = lerp(-0.15, 0, smooth((rel - 200) / 200));
  });
  eq(dashes(b).length, 0, 'рывков при возврате');
  const c = sim.run(800, moveTo(0, -0.4, 180));
  const d = dashes(c);
  eq(d.length, 1, 'рывок влево после устойчивой нейтрали');
  eq(d[0].dash, -1, 'направление влево');
});

test('A09 два рывка в одну сторону подряд — только через нейтраль', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const out = sim.run(2200, (s, rel) => {
    if (rel < 500) s.lean = lerp(0, 0.4, smooth(rel / 180));
    else if (rel < 1000) s.lean = lerp(0.4, 0, smooth((rel - 500) / 250));
    else s.lean = lerp(0, 0.4, smooth((rel - 1300) / 180));
  });
  const d = dashes(out);
  eq(d.length, 2, 'два рывка');
  ok(d.every((f) => f.dash === 1), 'оба вправо');
});

test('A10 маленькое быстрое движение (0.15 sw) не рывок, но даёт стрейф', () => {
  const sim = createSim();
  sim.calibrate(null);
  const out = sim.run(800, moveTo(0, 0.15, 100));
  eq(dashes(out).length, 0, 'рывков');
  const m = out[out.length - 1].moveX;
  ok(m > 0.05 && m < 0.6, `moveX ${m}`);
});

test('A11 чувствительность 2: меньшая амплитуда (0.2 sw) даёт рывок; при 1 — нет', () => {
  const s1 = createSim({ sensitivity: 1 });
  s1.calibrate(null); s1.run(300, null);
  eq(dashes(s1.run(700, moveTo(0, 0.2, 150))).length, 0, 'sensitivity 1');
  const s2 = createSim({ sensitivity: 2 });
  s2.calibrate(null); s2.run(300, null);
  eq(dashes(s2.run(700, moveTo(0, 0.2, 150))).length, 1, 'sensitivity 2');
  ok(s2.interp.getDerived().deadZone < s1.interp.getDerived().deadZone, 'dead zone уменьшилась');
});

test('A12 низкий FPS камеры: рывок распознаётся на 15 и 24 кадрах/с', () => {
  for (const fps of [15, 24]) {
    const sim = createSim({}, { fps });
    sim.calibrate(null);
    sim.run(400, null);
    const d = dashes(sim.run(900, moveTo(0, 0.4, 200)));
    eq(d.length, 1, `рывков при ${fps} к/с`);
    ok(d[0].rel <= 320, `${fps} к/с: рывок через ${d[0].rel.toFixed(0)} мс`);
  }
});

test('A12b порог амплитуды одинаков при 12/30/60 к/с (0.30 sw — рывок, 0.25 sw — нет)', () => {
  for (const fps of [12, 30, 60]) {
    for (const [amp, want] of [[0.3, 1], [0.25, 0]]) {
      const sim = createSim({}, { fps, seed: 3 });
      sim.calibrate(null);
      sim.run(400, null);
      eq(dashes(sim.run(900, moveTo(0, amp, 150))).length, want, `${fps} к/с, ${amp} sw`);
    }
  }
});

test('A13 сглаживание зависит от dt: moveX при 12 и 30 к/с совпадает', () => {
  const res = [];
  for (const fps of [12, 30, 60]) {
    const sim = createSim({}, { fps, state: { noise: 0 } });
    sim.calibrate(null);
    const out = sim.run(1500, moveTo(0, 0.3, 1200));
    res.push(out.find((f) => f.rel >= 900).moveX);
  }
  near(res[0], res[1], 0.12, '12 vs 30 к/с');
  near(res[2], res[1], 0.08, '60 vs 30 к/с');
});

test('A14 потеря плеч: moveX сразу 0, после grace valid=false, возврат не даёт рывок', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(1500, moveTo(0, 0.3, 1200));
  sim.run(400, armTo('rightUp', 0, 1, 120));
  const pre = sim.run(50, null).pop();
  ok(pre.moveX > 0.2 && pre.attack, `перед потерей moveX ${pre.moveX}, attack ${pre.attack}`);
  const lost = sim.run(1200, (s) => { s.shVis = 0.1; });
  const first = lost.find((f) => f.rel >= 40);
  eq(first.moveX, 0, 'moveX отпущен сразу');
  eq(first.attack, false, 'атака без достоверных плеч отпущена');
  ok(lost.filter((f) => f.rel < 600).every((f) => f.valid), 'valid в пределах grace');
  ok(lost.filter((f) => f.rel > 800).every((f) => !f.valid && f.moveX === 0 && !f.attack), 'после grace valid=false и нули');
  ok(sim.interp.getTracking(sim.now()).lost, 'tracking.lost');
  const back = sim.run(1000, (s) => { s.shVis = 0.99; });
  eq(dashes(back).length, 0, 'возвращение в наклоне не рывок');
  ok(back[back.length - 1].valid && back[back.length - 1].moveX > 0.2, 'стрейф восстановился');
  ok(back.every((f) => !f.attack), 'жест заблокирован до опускания рук');
  eq(sim.interp.getDebug().counters.reacquired, 1, 'счётчик возвращений');
  sim.run(400, armTo('rightUp', 1, 0, 120));
  const again = sim.run(600, armTo('rightUp', 0, 1, 120));
  ok(again.some((f) => f.attack), 'после опускания рук атака снова доступна');
});

test('A15 кратковременный провал посреди выхода отменяет рывок', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const out = sim.run(900, (s, rel) => {
    s.lean = lerp(0, 0.4, smooth(rel / 200));
    s.shVis = rel >= 140 && rel < 165 ? 0.1 : 0.99; // один кадр посреди выхода из нейтрали
  });
  eq(dashes(out).length, 0, 'рывков');
  eq(sim.interp.getDebug().dash.reason, 'dropout', 'причина');
});

test('A16 устаревший кадр не держит attack бесконечно', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(500, armTo('rightUp', 0, 1, 120));
  ok(sim.run(20, null).pop().attack, 'атака удерживается');
  const out = sim.run(1000, (s) => { s.frames = false; });
  const lastT = out[0].t - 1000 / 60; // кадры перестали приходить не позже этого
  ok(out.filter((f) => f.rel < 180).every((f) => f.attack), 'до staleMs атака держится');
  ok(out.filter((f) => f.rel > 290).every((f) => !f.attack && f.moveX === 0), 'после staleMs атака отпущена');
  ok(out.filter((f) => f.rel > 760).every((f) => !f.valid), 'после lostGraceMs valid=false');
  ok(lastT > 0);
});

test('A17 зеркало: знак moveX; руки не зависят от зеркала; swapHands', () => {
  for (const [mirror, sign] of [[true, 1], [false, -1]]) {
    const sim = createSim({ mirror });
    sim.calibrate(null);
    const m = sim.run(1500, moveTo(0, 0.3, 1000)).pop().moveX;
    ok(sign * m > 0.3, `mirror=${mirror}: moveX ${m}`);
    const arms = sim.run(600, armTo('rightUp', 0, 1, 120));
    ok(arms.some((f) => f.attack) && !arms.some((f) => f.shield), `mirror=${mirror}: правая рука → attack`);
  }
  const sw = createSim({ swapHands: true });
  sw.calibrate(null);
  const a = sw.run(600, armTo('rightUp', 0, 1, 120));
  ok(a.some((f) => f.shield) && !a.some((f) => f.attack), 'swapHands: метка правой руки → shield');
});

test('A18 одиночная рука: пауза распознавания, удержание, быстрое отпускание, невидимое запястье', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null); // после калибровки жесты взводятся, когда руки опущены armsDownRearmMs
  const up = sim.run(800, armTo('rightUp', 0, 1, 100));
  const firstAtk = up.find((f) => f.attack);
  ok(firstAtk, 'атака включилась');
  ok(firstAtk.rel >= 160 && firstAtk.rel <= 330, `задержка включения ${firstAtk.rel.toFixed(0)} мс`);
  ok(up.filter((f) => f.rel > firstAtk.rel).every((f) => f.attack), 'удержание стабильно');
  ok(!up.some((f) => f.shield || f.burst), 'без щита и burst');
  const down = sim.run(400, armTo('rightUp', 1, 0, 100));
  const off = down.find((f) => !f.attack);
  ok(off && off.rel <= 150, `отпускание через ${off && off.rel.toFixed(0)} мс`);
  sim.run(300, null);
  sim.run(600, armTo('rightUp', 0, 1, 100));
  const hid = sim.run(300, (s) => { s.wrVisR = 0.1; });
  const h = hid.find((f) => f.rel >= 40);
  eq(h.attack, false, 'невидимое запястье — атака отпущена сразу');
});

test('A19 левая рука — щит; щит приоритетнее атаки при последовательном подъёме', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const l = sim.run(700, armTo('leftUp', 0, 1, 100));
  ok(l.some((f) => f.shield) && !l.some((f) => f.attack), 'левая → shield');
  sim.run(400, armTo('leftUp', 1, 0, 100));
  sim.run(300, null);
  const r = sim.run(700, armTo('rightUp', 0, 1, 100));
  ok(r.some((f) => f.attack), 'правая → attack');
  const both = sim.run(1500, armTo('leftUp', 0, 1, 100));
  ok(!both.some((f) => f.attack && f.shield), 'attack и shield никогда одновременно');
});

test('A20 обе руки: нет одиночных действий, ровно один burst, повтор только после опускания', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  const out = sim.run(2000, (s, rel) => {
    s.rightUp = smooth(rel / 150);
    s.leftUp = smooth((rel - 100) / 150);
  });
  ok(!out.some((f) => f.attack || f.shield), 'подъём двух рук не дал выстрел/щит');
  const b = out.filter((f) => f.burst);
  eq(b.length, 1, 'burst ровно один');
  ok(b[0].rel >= 450 && b[0].rel <= 800, `burst через ${b[0].rel.toFixed(0)} мс`);
  const oneDown = sim.run(600, armTo('rightUp', 1, 0, 100));
  ok(!oneDown.some((f) => f.shield || f.attack || f.burst), 'после burst одна поднятая рука ничего не включает');
  const again = sim.run(1000, armTo('rightUp', 0, 1, 100));
  ok(!again.some((f) => f.burst), 'повторный burst без опускания обеих рук запрещён');
  sim.run(500, (s, rel) => { s.rightUp = 1 - smooth(rel / 100); s.leftUp = 1 - smooth(rel / 100); });
  const second = sim.run(1200, (s, rel) => { s.rightUp = smooth(rel / 120); s.leftUp = smooth(rel / 120); });
  eq(second.filter((f) => f.burst).length, 1, 'после опускания — новый burst');
  ok(!second.some((f) => f.attack || f.shield), 'и снова без одиночных');
});

test('A21 импульсы: read() потребляет, peek() нет, непрочитанный импульс сгорает по TTL', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(300, null);
  sim.run(400, moveTo(0, 0.4, 180), { read: false });
  const t = sim.now();
  // рывок был выдан во время движения; прошло ≤ pulseTtlMs? проверим отдельно ниже
  const sim2 = createSim();
  sim2.calibrate(null);
  sim2.run(300, null);
  let fired = null;
  sim2.run(600, moveTo(0, 0.4, 180), { read: false, until: () => { const p = sim2.interp.peek(sim2.now()); if (p.dash) { fired = sim2.now(); return true; } return false; } });
  ok(fired, 'импульс появился');
  eq(sim2.interp.peek(fired).dash, 1, 'peek видит импульс');
  eq(sim2.interp.peek(fired).dash, 1, 'peek не потребляет');
  eq(sim2.interp.read(fired).dash, 1, 'read выдаёт импульс');
  eq(sim2.interp.read(fired + 1).dash, 0, 'повторный read — 0');
  eq(sim.interp.read(t + 400).dash, 0, 'непрочитанный импульс сгорел по TTL');
});

test('A22 размер кадра: тот же формат сохраняет калибровку, другой — сбрасывает', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(1200, moveTo(0, 0.2, 1000));
  const out = sim.run(600, (s) => { s.w = 1280; s.h = 960; });
  ok(sim.interp.getBaseline(), 'калибровка сохранена при 1280×960');
  eq(dashes(out).length, 0, 'смена размера не даёт рывок');
  ok(out[out.length - 1].valid && out[out.length - 1].moveX > 0, 'стрейф продолжается');
  ok(sim.interp.getDebug().counters.resets > 0, 'история движения сброшена');
  const wide = sim.run(300, (s) => { s.w = 640; s.h = 360; });
  eq(sim.interp.getBaseline(), null, 'калибровка сброшена при 16:9');
  eq(sim.interp.getTracking(sim.now()).calibrationInvalid, 'aspect');
  ok(!wide[wide.length - 1].valid, 'ввод невалиден до новой калибровки');
});

test('A23 калибровка: поднятые руки и раскачивание не принимаются, таймаут через tick', () => {
  const sim = createSim();
  sim.interp.beginCalibration(sim.now());
  sim.run(2500, (s) => { s.rightUp = 1; });
  let c = sim.interp.calibrationStatus();
  eq(c.result, null, 'с поднятой рукой калибровка не завершается');
  ok(/Опустите руки/.test(c.hint), `подсказка: ${c.hint}`);
  sim.run(2500, (s, rel) => { s.rightUp = 0; s.lean = 0.2 * Math.sin(rel / 1000 * 2 * Math.PI * 1.2); });
  c = sim.interp.calibrationStatus();
  eq(c.result, null, 'при раскачивании калибровка не завершается');
  sim.run(2500, (s) => { s.lean = 0; }, { until: () => sim.interp.calibrationStatus().result });
  eq(sim.interp.calibrationStatus().result, 'done', 'неподвижно — калибровка завершилась');
  sim.interp.ackCalibration();
  const sim2 = createSim();
  sim2.interp.beginCalibration(sim2.now());
  sim2.run(26000, (s) => { s.frames = false; }, { tick: true, read: false }); // таймаут 25 с
  c = sim2.interp.calibrationStatus();
  eq(c.result, 'failed', 'таймаут без кадров');
  ok(/Калибровка не удалась/.test(c.message), c.message);
});

test('A24 модель без visibility (все нули): переход на геометрию', () => {
  const sim = createSim({}, { state: { visZero: true } });
  sim.run(1200, null);
  ok(sim.interp.getDebug().reliability.visibilityUnavailable, 'эвристика включилась');
  sim.calibrate(null);
  const m = sim.run(1500, moveTo(0, 0.3, 1000)).pop();
  ok(m.valid && m.moveX > 0.3, `moveX ${m.moveX}`);
  const never = createSim({ useVisibility: 'always' }, { state: { visZero: true } });
  never.interp.beginCalibration(never.now());
  never.run(3000, null);
  eq(never.interp.calibrationStatus().result, null, "useVisibility:'always' — без visibility плечи недостоверны");
});

test('A25 удерживаемый наклон не «уплывает» в центр (baseline не адаптируется)', () => {
  const sim = createSim();
  sim.calibrate(null);
  const b0 = JSON.stringify(sim.interp.getBaseline());
  sim.run(1200, moveTo(0, 0.3, 1000));
  const m0 = sim.run(100, null).pop().moveX;
  const m1 = sim.run(20000, null).pop().moveX;
  near(m1, m0, 0.05, 'moveX через 20 с');
  eq(JSON.stringify(sim.interp.getBaseline()), b0, 'baseline не изменился');
});

test('A26 сильное приближение/удаление: плечи недостоверны, предупреждение масштаба', () => {
  const sim = createSim();
  sim.calibrate(null);
  const out = sim.run(1200, (s) => { s.scale = 2.0; });
  ok(out.find((f) => f.rel > 50).moveX === 0, 'moveX отпущен');
  eq(sim.interp.getTracking(sim.now()).scaleWarning, 'near');
  ok(!out[out.length - 1].valid, 'после grace — lost');
  const back = sim.run(800, (s) => { s.scale = 1; });
  ok(back[back.length - 1].valid, 'в исходном положении снова valid');
  eq(dashes(back).length, 0, 'без рывка');
});

test('A27 перекалибровка сбрасывает историю и блокирует жесты', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(1200, moveTo(0, 0.3, 1000));
  const c = sim.calibrate((s) => { s.lean = 0.3; }); // новая нейтраль — текущая поза
  ok(c.slice(0, -1).every((f) => !f.valid), 'во время перекалибровки ввод невалиден');
  const after = sim.run(300, null).pop();
  ok(after.valid && after.moveX === 0, `новая нейтраль: moveX ${after.moveX}`);
});

test('A28 чистые функции: конфиг, распаковка, URL, ошибки камеры', () => {
  const m = mergeVisionConfig(DEFAULT_VISION_CONFIG, { sensitivity: 9, quality: 'high', volume: 0.3, deadZone: 'x', mediaPipe: { modelUrl: 'm.task' } });
  eq(m.sensitivity, 4, 'sensitivity ограничена');
  ok(!('quality' in m) && !('volume' in m), 'чужие ключи игнорируются');
  eq(m.deadZone, DEFAULT_VISION_CONFIG.deadZone, 'нечисловое значение отброшено');
  eq(m.mediaPipe.modelUrl, 'm.task'); ok(m.mediaPipe.moduleUrl.includes('@0.10.35'), 'остальные URL по умолчанию');
  const arr = new Float32Array(COMPACT_INDICES.length * COMPACT_STRIDE);
  const k12 = COMPACT_INDICES.indexOf(12);
  arr[k12 * COMPACT_STRIDE] = 0.25; arr[k12 * COMPACT_STRIDE + 3] = 0.5;
  for (const i of [23, 24, 25, 26, 27, 28, 7, 8]) ok(COMPACT_INDICES.includes(i), `точка ${i} для отжиманий (ASHEN_V2)`);
  const lm = unpackCompactLandmarks(arr);
  eq(lm.length, 33); near(lm[12].x, 0.25, 1e-6); near(lm[12].visibility, 0.5, 1e-6); eq(lm[20], null);
  eq(unpackCompactLandmarks(new Float32Array(3)), null, 'короткий массив');
  const r = resolveMediaPipe({ wasmRoot: 'https://cdn.example/npm/@mediapipe/tasks-vision@0.10.34/wasm/' });
  ok(!r.wasmRoot.endsWith('/'), 'wasmRoot без завершающего /');
  eq(r.versionMismatch, true, 'обнаружено расхождение версий');
  eq(resolveMediaPipe({}).versionMismatch, false);
  eq(mapCameraError({ name: 'NotAllowedError' }).code, 'permission-denied');
  eq(mapCameraError({ name: 'NotFoundError' }).code, 'no-device');
  eq(mapCameraError({ name: 'NotReadableError' }).code, 'device-busy');
  eq(mapCameraError({ name: 'Weird' }).code, 'camera-failed');
  ok(/[а-я]/i.test(mapCameraError({ name: 'NotAllowedError' }).message), 'русский текст');
});

test('A29 одинаковая или старая метка времени не обрабатывается повторно', () => {
  const sim = createSim();
  sim.calibrate(null);
  const n0 = sim.interp.getDebug().counters.observations;
  const lms = makeLandmarks(defaultPoseState(), mulberry32(1));
  const tLast = sim.now();
  eq(sim.interp.pushObservation({ tMs: tLast - 50, frameW: 640, frameH: 480, landmarks: lms }), false, 'старый кадр');
  eq(sim.interp.getDebug().counters.observations, n0, 'счётчик не вырос');
});

// ─────────── A30+. глубина (moveZ): наклон вперёд/назад по ширине плеч ───────────
// Синтетика: scale — масштаб фигуры (ширина плеч и вертикальные отступы), как при приближении
// к камере; noseDy — кивок; persp — ещё и центр плеч «уезжает» от центра кадра при приближении.
const zOf = (frames) => frames.map((f) => f.moveZ);
const maxAbs = (a) => Math.max(0, ...a.map((v) => Math.abs(v)));

test('A30 глубина: шире плечи (вперёд) → moveZ>0, уже (назад) → moveZ<0, насыщение; стрейф и рывок не задеты', () => {
  const fwd = createSim();
  fwd.calibrate(null);
  const f = fwd.run(1500, armTo('scale', 1, 1.12, 600));
  const lf = f[f.length - 1];
  ok(lf.valid && lf.moveZ > 0.3 && lf.moveZ < 0.8, `вперёд на 12%: moveZ ${lf.moveZ}`);
  eq(dashes(f).length, 0, 'рывков');
  ok(maxAbs(f.map((x) => x.moveX)) < 0.1, `стрейф при чистом наклоне вперёд: ${maxAbs(f.map((x) => x.moveX))}`);
  let drops = 0;
  // ширина плеч — разность двух точек, поэтому шумнее центра: на удержании moveZ дрожит ≈ ±0.05
  for (let i = 1; i < f.length; i++) if (f[i].moveZ < f[i - 1].moveZ - 0.1) drops++;
  eq(drops, 0, 'moveZ без провалов на монотонном наклоне');
  const back = createSim();
  back.calibrate(null);
  const lb = back.run(1500, armTo('scale', 1, 0.88, 600)).pop();
  ok(lb.valid && lb.moveZ < -0.3, `назад на 12%: moveZ ${lb.moveZ}`);
  near(-lb.moveZ, lf.moveZ, 0.12, 'симметрия вперёд/назад');
  const full = createSim();
  full.calibrate(null);
  ok(full.run(1200, armTo('scale', 1, 1.2, 500)).pop().moveZ > 0.97, 'полный ход к 20%');
  for (const sc of [1.3, 1.5]) {
    const x = full.run(800, (s) => { s.scale = sc; }).pop();
    ok(x.valid && x.moveZ === 1, `scale ${sc}: valid=${x.valid} moveZ=${x.moveZ}`);
    eq(full.interp.getTracking(full.now()).scaleWarning, null, `scale ${sc} — ещё не «слишком близко»`);
  }
  const bk = full.run(1200, (s) => { s.scale = 0.7; }).pop();
  ok(bk.valid && bk.moveZ === -1, `scale 0.7: valid=${bk.valid} moveZ=${bk.moveZ}`);
});

test('A31 глубина: мёртвая зона ±3.5% и нейтраль с шумом → moveZ тождественно 0', () => {
  const sim = createSim();
  sim.calibrate(null);
  near(sim.interp.getDerived().depthDeadZone, 0.055, 1e-9, 'мёртвая зона по умолчанию');
  const a = sim.run(2000, armTo('scale', 1, 1.035, 500));
  ok(a.filter((f) => f.rel > 800).every((f) => f.moveZ === 0), `+3.5%: max ${maxAbs(zOf(a))}`);
  const b = sim.run(2000, armTo('scale', 1.035, 0.965, 500));
  ok(b.filter((f) => f.rel > 800).every((f) => f.moveZ === 0), `−3.5%: max ${maxAbs(zOf(b))}`);
  const n = createSim({}, { seed: 5 });
  n.calibrate(null);
  const out = n.run(10000, null);
  const nz = out.filter((f) => f.moveZ !== 0).length / out.length;
  ok(nz < 0.01, `доля ненулевого moveZ на нейтрали ${nz}`);
  const noisy = createSim({}, { state: { noise: 0.012 }, seed: 7 });
  noisy.calibrate(null);
  ok(noisy.interp.getDerived().depthDeadZone > sim.interp.getDerived().depthDeadZone, 'шумная камера — шире мёртвая зона глубины');
  const no = noisy.run(6000, null);
  ok(no.filter((f) => Math.abs(f.moveZ) > 0.1).length / no.length < 0.02, 'шумная нейтраль: |moveZ|>0.1 реже 2%');
});

test('A32 глубина: чувствительность делит пороги, но полный ход остаётся в полосе widthRatio', () => {
  const s1 = createSim({ sensitivity: 1 });
  s1.calibrate(null);
  eq(s1.run(1500, armTo('scale', 1, 1.045, 500)).pop().moveZ, 0, 'sensitivity 1, +4.5%');
  const s2 = createSim({ sensitivity: 2 });
  s2.calibrate(null);
  const m2 = s2.run(1500, armTo('scale', 1, 1.045, 500)).pop().moveZ;
  ok(m2 > 0.1, `sensitivity 2, +4.5%: moveZ ${m2}`);
  ok(s2.interp.getDerived().depthDeadZone < s1.interp.getDerived().depthDeadZone, 'мёртвая зона уменьшилась');
  ok(s2.interp.getDerived().depthFull < s1.interp.getDerived().depthFull, 'полный ход ближе');
  const s4 = createSim({ sensitivity: 0.25 });
  s4.calibrate(null);
  const d4 = s4.interp.getDerived();
  ok(d4.depthFull <= 0.3 && d4.depthDeadZone <= 0.2, `sensitivity 0.25: dead ${d4.depthDeadZone}, full ${d4.depthFull}`);
  ok(1 - d4.depthFull >= DEFAULT_VISION_CONFIG.widthRatioMin && 1 + d4.depthFull <= DEFAULT_VISION_CONFIG.widthRatioMax, 'полный ход внутри полосы достоверности');
  s1.interp.configure({ sensitivity: 2 });
  near(s1.interp.getDerived().depthDeadZone, s2.interp.getDerived().depthDeadZone, 0.003, 'configure пересчитывает пороги глубины');
});

test('A33 глубина: 0 без плеч, на устаревших кадрах, «слишком близко»; возврат без рывка', () => {
  const sim = createSim();
  sim.calibrate(null);
  sim.run(1200, armTo('scale', 1, 1.15, 400));
  ok(sim.run(50, null).pop().moveZ > 0.5, 'наклон вперёд держится');
  const lost = sim.run(1200, (s) => { s.shVis = 0.1; });
  eq(lost.find((f) => f.rel >= 40).moveZ, 0, 'без плеч moveZ сразу 0');
  ok(lost.filter((f) => f.rel > 800).every((f) => !f.valid && f.moveZ === 0), 'после grace valid=false и moveZ=0');
  const back = sim.run(1000, (s) => { s.shVis = 0.99; });
  ok(back[back.length - 1].valid && back[back.length - 1].moveZ > 0.5, 'после возврата наклон снова даёт moveZ');
  eq(dashes(back).length, 0, 'возврат без рывка');
  const stale = createSim();
  stale.calibrate(null);
  stale.run(1200, armTo('scale', 1, 1.15, 400));
  const st = stale.run(1000, (s) => { s.frames = false; });
  ok(st.filter((f) => f.rel < 180).every((f) => f.moveZ > 0.5), 'до staleMs держится');
  ok(st.filter((f) => f.rel > 290).every((f) => f.moveZ === 0), 'после staleMs moveZ=0');
  const near2 = createSim();
  near2.calibrate(null);
  const nr = near2.run(1200, (s) => { s.scale = 1.9; });
  eq(nr.find((f) => f.rel > 50).moveZ, 0, 'за полосой (×1.9) moveZ=0');
  eq(near2.interp.getTracking(near2.now()).scaleWarning, 'near', 'предупреждение «ближе, чем при калибровке»');
  ok(!nr[nr.length - 1].valid, 'после grace — lost, как раньше');
  const far = near2.run(1200, (s) => { s.scale = 0.5; });
  eq(far.find((f) => f.rel > 50).moveZ, 0, '×0.5 — тоже вне полосы');
  eq(near2.interp.getTracking(near2.now()).scaleWarning, 'far');
  const ret = near2.run(1000, (s) => { s.scale = 1.15; });
  ok(ret[ret.length - 1].valid && ret[ret.length - 1].moveZ > 0.5, 'в рабочем диапазоне снова valid');
  eq(dashes(ret).length, 0, 'без рывка');
});

test('A34 глубина: EMA по реальному dt (12/30/60 к/с) и одиночный выброс ширины не двигает', () => {
  const res = [];
  for (const fps of [12, 30, 60]) {
    const sim = createSim({}, { fps, state: { noise: 0 } });
    sim.calibrate(null);
    const out = sim.run(1500, armTo('scale', 1, 1.2, 1200));
    res.push(out.find((f) => f.rel >= 900).moveZ);
  }
  near(res[0], res[1], 0.12, '12 vs 30 к/с');
  near(res[2], res[1], 0.08, '60 vs 30 к/с');
  const sp = createSim();
  sp.calibrate(null);
  const out = sp.run(4000, (s, rel) => {
    const i = Math.round(rel / (1000 / 30));
    s.scale = i % 20 === 10 ? 1.4 : i % 20 === 15 ? 0.7 : 1; // одиночные кадры с «прыжком» ширины
  });
  eq(maxAbs(zOf(out)), 0, 'одиночные выбросы ширины отброшены');
  ok(sp.interp.getDebug().counters.rejectedDepthSpikes >= 10, `отброшено ${sp.interp.getDebug().counters.rejectedDepthSpikes}`);
});

test('A35 глубина: кивок сам по себе не двигает; вместе с наклоном — усиливает; вес 0 выключает', () => {
  for (const sensitivity of [1, 2]) {
    const sim = createSim({ sensitivity });
    sim.calibrate(null);
    const out = sim.run(2000, armTo('noseDy', 0, 0.08, 300));
    ok(maxAbs(zOf(out)) < 0.05, `sensitivity ${sensitivity}: кивок даёт |moveZ| ${maxAbs(zOf(out))}`);
    const d = sim.interp.getDebug();
    ok(Math.abs(d.depth.nose) <= 0.6 * sim.interp.getDerived().depthDeadZone + 1e-3, `вклад носа ограничен: ${d.depth.nose}`);
  }
  const lean = (cfg, noseDy) => {
    const sim = createSim(cfg, { state: { noise: 0 } });
    sim.calibrate(null);
    return sim.run(1500, (s, rel) => { s.scale = lerp(1, 1.08, smooth(rel / 500)); s.noseDy = lerp(0, noseDy, smooth(rel / 500)); }).pop().moveZ;
  };
  const widthOnly = lean({}, 0);
  const both = lean({}, 0.03);
  ok(widthOnly > 0.05, `ширина +8%: ${widthOnly}`);
  ok(both > widthOnly + 0.05, `ширина + голова вниз: ${both} > ${widthOnly}`);
  near(lean({ depthNoseWeight: 0 }, 0.03), widthOnly, 0.02, 'depthNoseWeight 0 — только ширина');
  const baseNoNose = createSim({}, { state: { noise: 0 } });
  baseNoNose.calibrate(null);
  ok(finite0(baseNoNose.interp.getBaseline().noseGap), 'нос в калибровке');
});
const finite0 = (v) => typeof v === 'number' && Number.isFinite(v);

test('A36 стрейф с поправкой на перспективу: игрок сбоку от камеры при наклоне вперёд не «уезжает» вбок', () => {
  const res = {};
  for (const comp of [true, false]) {
    const sim = createSim({ depthLateralComp: comp }, { state: { cx0: 0.72, persp: true } });
    sim.calibrate(null);
    const out = sim.run(1500, armTo('scale', 1, 1.2, 600));
    res[comp] = { moveX: out[out.length - 1].moveX, moveZ: out[out.length - 1].moveZ, dashes: dashes(out).length };
    ok(res[comp].moveZ > 0.9, `comp=${comp}: moveZ ${res[comp].moveZ}`);
  }
  ok(Math.abs(res.true.moveX) < 0.05 && res.true.dashes === 0, `с поправкой moveX ${res.true.moveX}`);
  ok(Math.abs(res.false.moveX) > 0.2, `контроль: без поправки снос ${res.false.moveX} (проблема в модели реальна)`);
  const sim = createSim({}, { state: { cx0: 0.72, persp: true } });
  sim.calibrate(null);
  sim.run(1200, armTo('scale', 1, 1.2, 500));
  const side = sim.run(1500, armTo('lean', 0, 0.3, 800)).pop();
  ok(side.moveX > 0.3 && side.moveZ > 0.9, `наклон вбок в наклоне вперёд: moveX ${side.moveX}, moveZ ${side.moveZ}`);
  const plain = createSim({ depthLateralComp: true });
  plain.calibrate(null);
  ok(plain.run(1500, moveTo(0, 0.4, 2000)).pop().moveX > 0.5, 'по центру кадра поправка не мешает стрейфу');
});

test('A37 контракт кадра: moveZ/conjure/throw есть всегда; debug.depth и калибровка глубины', () => {
  const sim = createSim();
  const pre = sim.run(300, null).pop();
  eq(pre.valid, false); eq(pre.moveZ, 0); eq(pre.conjure, null); eq(pre.throw, null);
  sim.calibrate(null);
  const f = sim.run(200, null).pop();
  eq(f.valid, true); eq(typeof f.moveZ, 'number'); eq(f.conjure, null, 'поза сама conjure не даёт'); eq(f.throw, null);
  const b = sim.interp.getBaseline();
  near(b.noseGap, 0.25 / (0.26 * 640 / 480), 0.02, 'зазор нос–плечи в sw');
  ok(b.widthNoise >= DEFAULT_VISION_CONFIG.minNoise && b.widthNoise < 0.03, `шум ширины ${b.widthNoise}`);
  const d = sim.interp.getDebug();
  ok(d.depth && 'widthRatio' in d.depth && 'moveZ' in d.depth && 'filtered' in d.depth, 'debug.depth');
  near(d.depth.widthRatio, 1, 0.03, 'widthRatio на нейтрали');
  eq(d.thresholds.widthRatioMin, 0.55); eq(d.thresholds.widthRatioMax, 1.8);
  ok(d.baseline.noseGap !== null && d.baseline.widthNoise !== null, 'baseline в debug');
});

// ═══════════════ B. vision-worker.js в поддельном окружении worker ═══════════════
// Настоящий код vision-worker.js исполняется в Node с подменёнными self, OffscreenCanvas,
// ImageBitmap и модулем MediaPipe. Реальный браузерный worker, WASM и GPU здесь не проверяются.

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await flush(); }

const gfx = { webgl2: true, lost: 0, bitmaps: [] };
function fakeBitmap(tag, w = 640, h = 480) {
  const b = { tag, width: w, height: h, closed: false, __bitmap: true, close() { this.closed = true; } };
  gfx.bitmaps.push(b);
  return b;
}
class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext(type) {
    if (type === '2d') return { fillStyle: '', fillRect() {}, clearRect() {} };
    if (type === 'webgl2') return gfx.webgl2 ? { getExtension: () => ({ loseContext() { gfx.lost++; } }) } : null;
    return null;
  }
  transferToImageBitmap() { return fakeBitmap('warmup', this.width, this.height); }
}

// Поддельный MediaPipe как ES-модуль по data: URL; поведение — через globalThis.__fakeMP.
const FAKE_MP_SRC = `
const H = () => globalThis.__fakeMP;
export const FilesetResolver = {
  async forVisionTasks(root, useModule) {
    const h = H(); h.calls.push({ fn: 'forVisionTasks', root, useModule: !!useModule });
    if (h.failFileset && h.failFileset(!!useModule)) throw new Error('fake fileset failure');
    return { wasmLoaderPath: root + (useModule ? '/vision_wasm_module_internal.js' : '/vision_wasm_internal.js') };
  },
};
export const PoseLandmarker = {
  async createFromOptions(fileset, opts) {
    const h = H(); const d = opts.baseOptions.delegate;
    h.calls.push({ fn: 'create', delegate: d, opts, fileset });
    if (h.failCreate && h.failCreate(d)) throw new Error('fake create failure ' + d);
    const inst = { delegate: d, closed: false,
      detectForVideo(src, ts) { return h.detect(src, ts, inst); },
      close() { inst.closed = true; h.calls.push({ fn: 'close', delegate: d }); } };
    h.instances.push(inst);
    return inst;
  },
};`;
const FAKE_MP_URL = 'data:text/javascript;base64,' + Buffer.from(FAKE_MP_SRC).toString('base64');
const BAD_MP_URL = 'data:text/javascript,' + encodeURIComponent('throw new Error("fake module load failure");');
const FAKE_MP = { moduleUrl: FAKE_MP_URL, wasmRoot: 'https://fake.invalid/npm/@mediapipe/tasks-vision@1.0.1/wasm', modelUrl: 'https://fake.invalid/pose_landmarker_lite.task' };

function resetFakeMP(over = {}) {
  const h = {
    calls: [], instances: [], results: [], tsList: [], detectSources: [], detectCalls: 0,
    pose: () => makeLandmarks(defaultPoseState(), mulberry32(2)),
    detect(src, ts, inst) {
      h.detectCalls++; h.tsList.push(ts); h.detectSources.push(src);
      if (h.detectThrows && h.detectThrows(src, inst)) throw new Error('fake detect failure');
      if (h.onDetect) h.onDetect(src, ts, inst);
      const lms = h.pose ? h.pose(src, ts) : null;
      const r = { landmarks: lms ? [lms] : [], worldLandmarks: [], closed: false, close() { r.closed = true; } };
      h.results.push(r);
      return r;
    },
    ...over,
  };
  globalThis.__fakeMP = h;
  return h;
}

function setGlobals(map) {
  const saved = {};
  for (const [k, v] of Object.entries(map)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    if (v === undefined) delete globalThis[k];
    else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: false });
  }
  return () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
    }
  };
}

let workerImportSeq = 0;
function makeScope() {
  const scope = {
    listeners: {}, outbox: [], closed: false,
    addEventListener(t, fn) { (scope.listeners[t] ||= []).push(fn); },
    postMessage(msg, transfer) { scope.outbox.push({ msg, transfer: transfer || [] }); if (scope.onPost) scope.onPost(msg, transfer || []); },
    close() { scope.closed = true; },
    send(data) { globalThis.self = scope; for (const fn of scope.listeners.message || []) fn({ data }); },
  };
  return scope;
}
async function loadWorkerScope() {
  const scope = makeScope();
  globalThis.self = scope;
  await import(`../modules/vision-worker.js?scope=${++workerImportSeq}`);
  return scope;
}
async function waitMsg(scope, type, maxTicks = 300) {
  for (let i = 0; i < maxTicks; i++) {
    const m = scope.outbox.find((o) => o.msg.type === type);
    if (m) return m;
    await flush();
  }
  throw new Error(`нет сообщения ${type}; получено: ${scope.outbox.map((o) => o.msg.type).join(',')}`);
}
const initMsg = (over = {}) => ({ type: 'init', apiVersion: API_VERSION, mp: { ...FAKE_MP }, delegate: 'GPU', options: { numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5, outputSegmentationMasks: false }, ...over });

async function withWorkerGlobals(fn) {
  const restore = setGlobals({ OffscreenCanvas: FakeOffscreenCanvas });
  const prevSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  gfx.webgl2 = true; gfx.lost = 0; gfx.bitmaps.length = 0;
  try { await fn(); } finally {
    restore();
    if (prevSelf) Object.defineProperty(globalThis, 'self', prevSelf); else delete globalThis.self;
  }
}

test('B01 worker: самопроверка (JS → WASM → модель → пробный кадр), затем кадры', () => withWorkerGlobals(async () => {
  const h = resetFakeMP();
  const sc = await loadWorkerScope();
  sc.send(initMsg());
  const ready = (await waitMsg(sc, 'ready')).msg;
  const stages = sc.outbox.filter((o) => o.msg.type === 'progress').map((o) => o.msg.stage);
  eq(stages.join(','), 'module,wasm,model,warmup', 'этапы загрузки');
  eq(ready.delegate, 'GPU');
  const fs = h.calls.find((c) => c.fn === 'forVisionTasks');
  eq(fs.useModule, true, 'module worker использует ES-модульный загрузчик WASM');
  eq(fs.root, FAKE_MP.wasmRoot, 'wasmRoot из init');
  const cr = h.calls.find((c) => c.fn === 'create');
  eq(cr.opts.baseOptions.modelAssetPath, FAKE_MP.modelUrl, 'modelUrl из init');
  eq(cr.opts.runningMode, 'VIDEO'); eq(cr.opts.numPoses, 1); eq(cr.opts.outputSegmentationMasks, false);
  eq(h.tsList[0], 1, 'пробный кадр ts=1');
  ok(gfx.bitmaps.filter((b) => b.tag === 'warmup').every((b) => b.closed), 'пробный bitmap закрыт');
  ok(gfx.lost >= 1, 'тестовый WebGL2-контекст освобождён');
  const pose = makeLandmarks(defaultPoseState(), mulberry32(2));
  const bmp = fakeBitmap('frame');
  sc.send({ type: 'frame', seq: 1, tMs: 1000.4, w: 640, h: 480, bitmap: bmp });
  const res = sc.outbox.find((o) => o.msg.type === 'result');
  ok(res, 'результат кадра');
  eq(res.msg.seq, 1); eq(res.msg.w, 640); eq(res.msg.tMs, 1000.4);
  ok(res.msg.landmarks instanceof Float32Array && res.msg.landmarks.length === COMPACT_INDICES.length * COMPACT_STRIDE, 'компактный Float32Array');
  ok(res.transfer.length === 1 && res.transfer[0] === res.msg.landmarks.buffer, 'буфер передаётся (transfer)');
  const k12 = COMPACT_INDICES.indexOf(12);
  near(res.msg.landmarks[k12 * COMPACT_STRIDE], pose[12].x, 1e-6, 'x правого плеча');
  near(res.msg.landmarks[k12 * COMPACT_STRIDE + 3], pose[12].visibility, 1e-6, 'visibility');
  ok(bmp.closed, 'ImageBitmap кадра закрыт');
  eq(h.tsList[1], 1000, 'метка времени VIDEO');
  const bmp2 = fakeBitmap('frame');
  sc.send({ type: 'frame', seq: 2, tMs: 999, w: 640, h: 480, bitmap: bmp2 });
  eq(h.tsList[2], 1001, 'метки строго растут');
  ok(bmp2.closed && h.results.every((r) => r.closed), 'все bitmap и результаты закрыты');
  sc.send({ type: 'close' });
  ok(h.instances[0].closed && sc.closed, 'close освобождает landmarker и завершает worker');
}));

test('B02 worker: GPU не создался → CPU, причина сообщается', () => withWorkerGlobals(async () => {
  const h = resetFakeMP({ failCreate: (d) => d === 'GPU' });
  const sc = await loadWorkerScope();
  sc.send(initMsg());
  const r = (await waitMsg(sc, 'ready')).msg;
  eq(r.delegate, 'CPU'); ok(/GPU/.test(r.fallbackFrom), r.fallbackFrom);
  eq(h.calls.filter((c) => c.fn === 'create').map((c) => c.delegate).join(','), 'GPU,CPU');
}));

test('B03 worker: пробный кадр на GPU упал → GPU закрыт, CPU прошёл самопроверку', () => withWorkerGlobals(async () => {
  const h = resetFakeMP({ detectThrows: (src, inst) => inst.delegate === 'GPU' });
  const sc = await loadWorkerScope();
  sc.send(initMsg());
  const r = (await waitMsg(sc, 'ready')).msg;
  eq(r.delegate, 'CPU');
  ok(h.instances[0].delegate === 'GPU' && h.instances[0].closed, 'GPU-экземпляр закрыт');
  ok(gfx.bitmaps.every((b) => b.closed), 'пробные bitmap закрыты и при ошибке');
}));

test('B04 worker: нет WebGL2 → сразу CPU', () => withWorkerGlobals(async () => {
  gfx.webgl2 = false;
  const h = resetFakeMP();
  const sc = await loadWorkerScope();
  sc.send(initMsg());
  const r = (await waitMsg(sc, 'ready')).msg;
  eq(r.delegate, 'CPU'); ok(/WebGL2/.test(r.fallbackFrom), r.fallbackFrom);
  eq(h.calls.filter((c) => c.fn === 'create').length, 1);
}));

test('B05 worker: ошибки загрузки модуля/версии → init-error, не ready', () => withWorkerGlobals(async () => {
  resetFakeMP();
  const a = await loadWorkerScope();
  a.send(initMsg({ mp: { ...FAKE_MP, moduleUrl: BAD_MP_URL } }));
  ok(/fake module load failure/.test((await waitMsg(a, 'init-error')).msg.message), 'ошибка модуля');
  ok(!a.outbox.some((o) => o.msg.type === 'ready'));
  const b = await loadWorkerScope();
  b.send(initMsg({ apiVersion: 'ASHEN_V0' }));
  ok(/API/.test((await waitMsg(b, 'init-error')).msg.message), 'несовпадение API');
  resetFakeMP({ failCreate: () => true });
  const c = await loadWorkerScope();
  c.send(initMsg());
  ok(/fake create failure/.test((await waitMsg(c, 'init-error')).msg.message), 'модель не загрузилась');
}));

test('B06 worker: кадр до готовности, сбой detect, кадр без позы — bitmap всегда закрыт', () => withWorkerGlobals(async () => {
  const h = resetFakeMP();
  const sc = await loadWorkerScope();
  const b0 = fakeBitmap('frame');
  sc.send({ type: 'frame', seq: 7, tMs: 5, w: 640, h: 480, bitmap: b0 });
  eq(sc.outbox[0].msg.type, 'frame-error'); eq(sc.outbox[0].msg.seq, 7); ok(b0.closed, 'закрыт до готовности');
  sc.send(initMsg());
  await waitMsg(sc, 'ready');
  h.detectThrows = () => true;
  const b1 = fakeBitmap('frame');
  sc.send({ type: 'frame', seq: 8, tMs: 100, w: 640, h: 480, bitmap: b1 });
  ok(sc.outbox.some((o) => o.msg.type === 'frame-error' && o.msg.seq === 8) && b1.closed, 'сбой detect');
  h.detectThrows = null; h.pose = () => null;
  const b2 = fakeBitmap('frame');
  sc.send({ type: 'frame', seq: 9, tMs: 200, w: 640, h: 480, bitmap: b2 });
  const r = sc.outbox.find((o) => o.msg.type === 'result' && o.msg.seq === 9);
  ok(r && r.msg.landmarks === null && r.transfer.length === 0 && b2.closed, 'поза не найдена');
}));

// ═══════════ C. оболочка createVision с поддельными камерой, видео, часами ═══════════
// Поддельные: performance.now (управляемые часы), navigator.mediaDevices, <video> с
// requestVideoFrameCallback, MediaPipe, Worker (исполняет настоящий vision-worker.js в этом
// же процессе), OffscreenCanvas, createImageBitmap. Реальный браузер здесь не участвует.

const clock = { t: 50000 };

function makeVideo(w, h) {
  const v = {
    readyState: 0, videoWidth: 0, videoHeight: 0, paused: true, currentTime: 0, srcObject: null,
    presented: 0, cbs: new Map(), nextId: 0,
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    play() { this.paused = false; this.readyState = 4; this.videoWidth = w; this.videoHeight = h; return Promise.resolve(); },
    pause() { this.paused = true; },
    requestVideoFrameCallback(cb) { const id = ++this.nextId; this.cbs.set(id, cb); return id; },
    cancelVideoFrameCallback(id) { this.cbs.delete(id); },
    present(now, same = false) {
      if (!same) this.presented++;
      const cbs = [...this.cbs.values()];
      this.cbs.clear();
      for (const cb of cbs) cb(now, { presentedFrames: this.presented, mediaTime: this.presented / 30 });
    },
  };
  return v;
}

function makeEnv(o = {}) {
  const W = o.videoW || 640;
  const H = o.videoH || 480;
  const env = {
    statuses: [], gum: [], stops: 0, state: { ...defaultPoseState(), w: W, h: H }, rng: mulberry32(11),
    framesOn: true, nextFrame: clock.t, captures: [], inferMs: 0, gumImpl: o.gumImpl || null,
  };
  const track = {
    readyState: 'live', l: {},
    stop() { env.stops++; track.readyState = 'ended'; },
    getSettings: () => ({ width: W, height: H, frameRate: 30 }),
    addEventListener(t, fn) { track.l[t] = fn; },
    removeEventListener(t, fn) { if (track.l[t] === fn) delete track.l[t]; },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  env.track = track;
  env.mediaDevices = {
    async getUserMedia(c) {
      env.gum.push(c);
      if (env.gumImpl) { const r = env.gumImpl(c, env.gum.length); if (r) throw r; }
      return stream;
    },
  };
  env.video = makeVideo(W, H);
  env.createImageBitmap = async (src, opts) => {
    env.captures.push(opts || null);
    return fakeBitmap('capture', opts && opts.resizeWidth ? opts.resizeWidth : src.videoWidth, opts && opts.resizeHeight ? opts.resizeHeight : src.videoHeight);
  };
  return env;
}
const domErr = (name) => Object.assign(new Error(name), { name });

class FakeWorker {
  static created = [];
  static hooks = { delayMs: 0, dropFrames: false };
  static reset() { FakeWorker.created = []; FakeWorker.hooks = { delayMs: 0, dropFrames: false }; }
  constructor(url, opts) {
    FakeWorker.created.push(this);
    this.url = String(url); this.opts = opts; this.listeners = {}; this.terminated = false;
    this.inflight = 0; this.maxInflight = 0; this.sent = []; this.held = [];
    const scope = makeScope();
    scope.onPost = (msg) => {
      if (this.terminated) return;
      if (msg.type === 'result' || msg.type === 'frame-error') this.inflight--;
      setTimeout(() => { if (!this.terminated) for (const fn of (this.listeners.message || []).slice()) fn({ data: msg }); }, FakeWorker.hooks.delayMs || 0);
    };
    this.scope = scope;
    const sep = this.url.includes('?') ? '&' : '?';
    this.loaded = (async () => { globalThis.self = scope; await import(`${this.url}${sep}fw=${++workerImportSeq}`); })();
    this.loaded.catch((e) => setTimeout(() => { for (const fn of this.listeners.error || []) fn({ message: String(e), preventDefault() {} }); }, 0));
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  postMessage(msg) {
    this.sent.push(msg);
    if (this.terminated) { if (msg.bitmap) msg.bitmap.close(); return; }
    if (msg.type === 'frame') { this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight); }
    this.loaded.then(() => setTimeout(() => {
      if (this.terminated) { if (msg.bitmap) msg.bitmap.close(); return; }
      if (msg.type === 'frame' && FakeWorker.hooks.dropFrames) { this.held.push(msg.bitmap); return; }
      this.scope.send(msg);
    }, FakeWorker.hooks.delayMs || 0), () => {});
  }
  terminate() { this.terminated = true; for (const b of this.held) b.close(); this.held = []; }
}

async function withShell(o, fn) {
  const env = makeEnv(o);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  const g = {
    performance: { now: () => clock.t, timeOrigin: 0 },
    navigator: o.noMediaDevices ? { userAgent: 'test' } : { mediaDevices: env.mediaDevices, userAgent: 'test' },
    isSecureContext: !o.insecure,
    Worker: o.worker ? FakeWorker : undefined,
    OffscreenCanvas: o.worker ? FakeOffscreenCanvas : undefined,
    createImageBitmap: o.worker ? env.createImageBitmap : undefined,
  };
  const restore = setGlobals(g);
  const prevSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  FakeWorker.reset();
  gfx.webgl2 = true; gfx.lost = 0; gfx.bitmaps.length = 0;
  env.warns = warns;
  let vision = null;
  try {
    vision = await createVision({
      video: env.video,
      overlayCanvas: o.overlayCanvas || null,
      onStatus: (s) => env.statuses.push(s),
      // torsoMove: true — тесты оболочки проверяют и корпусной откат; по умолчанию в игре он выключен (см. C16)
      config: { mediaPipe: FAKE_MP, rvfcStarveMs: 1e9, useWorker: o.worker ? 'auto' : 'off', torsoMove: true, ...(o.config || {}) },
      handInterpreter: o.handInterpreter,
    });
    env.vision = vision;
    env.h = resetFakeMP({
      pose: () => (env.state.present ? makeLandmarks(env.state, env.rng) : null),
      onDetect: (src) => { if (!src.__bitmap) clock.t += env.inferMs; },
    });
    await fn(env, vision);
  } finally {
    try { if (vision) vision.dispose(); } catch { /* ignore */ }
    await settle(4);
    restore();
    if (prevSelf) Object.defineProperty(globalThis, 'self', prevSelf); else delete globalThis.self;
    console.warn = origWarn;
  }
}

async function pump(env, ms, poseFn, opt = {}) {
  const out = [];
  const start = clock.t;
  const end = start + ms;
  if (env.nextFrame < start) env.nextFrame = start;
  while (clock.t < end - 1e-9) {
    const tn = Math.min(end, clock.t + 1000 / 60);
    while (env.nextFrame <= tn) {
      clock.t = Math.max(clock.t, env.nextFrame);
      if (poseFn) poseFn(env.state, clock.t - start);
      if (env.framesOn) env.video.present(clock.t);
      env.nextFrame += 1000 / 30;
      if (opt.worker) await settle(4);
    }
    clock.t = Math.max(clock.t, tn);
    if (opt.read !== false) out.push({ ...env.vision.read(), rel: clock.t - start });
    await flush();
    if (opt.until && opt.until()) break;
  }
  return out;
}
const statusSeq = (env) => env.statuses.map((s) => s.status).filter((s, i, a) => i === 0 || a[i - 1] !== s);
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));

test('C01 небезопасный контекст → insecure-context, камера не запрашивается', () => withShell({ insecure: true }, async (env, v) => {
  const e = await rejects(v.start(), 'insecure-context');
  ok(/https|localhost/.test(e.message), e.message);
  eq(env.gum.length, 0, 'getUserMedia не вызывался');
  eq(v.getStatus().status, 'error'); eq(v.getStatus().error, 'insecure-context');
}));

test('C02 нет mediaDevices → unsupported', () => withShell({ noMediaDevices: true }, async (env, v) => {
  await rejects(v.start(), 'unsupported');
  eq(v.getStatus().status, 'error');
}));

test('C03 отказ в доступе: permission → error, понятный текст, повтор после разрешения', () => withShell({ gumImpl: () => domErr('NotAllowedError') }, async (env, v) => {
  const p = v.start();
  eq(v.getStatus().status, 'permission', 'статус сразу после start()');
  const e = await rejects(p, 'permission-denied');
  ok(/запрещ/.test(e.message), e.message);
  eq(statusSeq(env).join(','), 'permission,error');
  eq(env.gum[0].audio, false, 'микрофон не запрашивается');
  eq(env.gum[0].video.facingMode, 'user');
  env.gumImpl = null;
  await v.start();
  await pump(env, 300, null);
  eq(v.getStatus().status, 'ready', 'после повторной попытки');
  ok(/калибровку/.test(v.getStatus().message), v.getStatus().message);
}));

test('C04 ошибки устройства: занято, не найдено, Overconstrained → повтор с video:true', async () => {
  await withShell({ gumImpl: () => domErr('NotReadableError') }, async (env, v) => {
    const e = await rejects(v.start(), 'device-busy');
    ok(/занята/.test(e.message), e.message);
  });
  await withShell({ gumImpl: () => domErr('NotFoundError') }, async (env, v) => { await rejects(v.start(), 'no-device'); });
  await withShell({ gumImpl: (c, n) => (n === 1 ? domErr('OverconstrainedError') : null) }, async (env, v) => {
    await v.start();
    eq(env.gum.length, 2); eq(env.gum[1].video, true); eq(env.gum[1].audio, false);
  });
});

test('C05 модель не загрузилась → model-failed, поток камеры остановлен', () => withShell({}, async (env, v) => {
  env.h.failCreate = () => true;
  const e = await rejects(v.start(), 'model-failed');
  ok(/модел/.test(e.message), e.message);
  ok(env.stops >= 1, 'дорожка камеры остановлена');
  eq(env.video.srcObject, null);
  eq(v.getStatus().status, 'error');
  eq(env.h.calls.filter((c) => c.fn === 'create').map((c) => c.delegate).join(','), 'GPU,CPU', 'пробовали GPU, затем CPU');
}));

test('C06 основной поток: статусы, лимит частоты, дубли кадров, калибровка, рывок, lost, stop/start, dispose', () => withShell({}, async (env, v) => {
  env.inferMs = 25; // синхронный inference «занимает» 25 мс поддельного времени
  await v.start();
  let s = v.getStatus();
  eq(s.mode, 'main'); eq(s.debug.loopMode, 'rvfc'); eq(s.apiVersion, API_VERSION);
  ok(/useWorker/.test(s.debug.workerFallbackReason), s.debug.workerFallbackReason);
  eq(env.h.calls.find((c) => c.fn === 'forVisionTasks').useModule, false, 'главный поток — классический загрузчик');
  const r0 = v.read();
  eq(r0.valid, false); eq(r0.moveX, 0);
  await pump(env, 500, null);
  s = v.getStatus();
  eq(s.status, 'ready'); ok(/калибровку/.test(s.message), s.message);
  eq(statusSeq(env).slice(0, 3).join(','), 'permission,loading,ready');

  // один кадр — не больше одного inference
  clock.t += 200; env.video.present(clock.t);
  const d1 = env.h.detectCalls;
  clock.t += 200; env.video.present(clock.t, true);
  eq(env.h.detectCalls, d1, 'повторный callback того же кадра не запускает inference');

  // лимит частоты главного потока
  const d0 = env.h.detectCalls; const f0 = env.video.presented;
  await pump(env, 2000, null);
  const frames = env.video.presented - f0; const det = env.h.detectCalls - d0;
  s = v.getStatus();
  ok(det <= frames * 0.5 && det >= 12, `inference ${det} на ${frames} кадров`);
  ok(s.debug.inferenceHz <= 15.5, `частота ${s.debug.inferenceHz} Гц`);
  ok(s.debug.skippedRate > 0, 'кадры пропускались лимитом');
  near(s.debug.inferMs, 25, 3, 'оценка inferMs');

  // калибровка через оболочку
  let calibrated = false;
  const cp = v.calibrate();
  cp.then(() => { calibrated = true; }, () => {});
  eq(v.getStatus().status, 'calibrating');
  await pump(env, 3000, null, { until: () => calibrated });
  ok(calibrated, 'calibrate() выполнился');
  s = v.getStatus();
  eq(s.status, 'ready'); eq(s.calibrated, true); ok(/Калибровка завершена/.test(s.message), s.message);
  const prog = env.statuses.filter((x) => x.status === 'calibrating').map((x) => x.progress);
  ok(Math.max(...prog) >= 0.5, 'прогресс калибровки рос');
  ok(env.statuses.every((x) => x.progress >= 0 && x.progress <= 1 && x.confidence >= 0 && x.confidence <= 1 && /[а-я]/i.test(x.message)), 'поля статусов в диапазоне, тексты русские');

  // рывок на ~10 Гц inference
  await pump(env, 300, null);
  const dash = await pump(env, 900, moveTo(0, 0.45, 250));
  eq(dashes(dash).length, 1, 'рывок'); eq(dashes(dash)[0].dash, 1);
  ok(dash[dash.length - 1].moveX > 0.9, 'стрейф при удержании');
  await pump(env, 800, moveTo(0.45, 0, 300));

  // потеря человека
  const lost = await pump(env, 1200, (st) => { st.present = false; });
  s = v.getStatus();
  eq(s.status, 'lost'); ok(/плеч/.test(s.message), s.message); eq(s.confidence, 0);
  ok(!lost[lost.length - 1].valid, 'valid=false');
  const back = await pump(env, 600, (st) => { st.present = true; });
  s = v.getStatus();
  eq(s.status, 'ready'); ok(/восстановлен/.test(s.message), s.message);
  ok(back[back.length - 1].valid && dashes(back).length === 0, 'вернулся без рывка');

  // stop / start / dispose
  v.stop();
  s = v.getStatus();
  eq(s.status, 'idle'); ok(env.stops >= 1); eq(env.video.srcObject, null);
  const rs = v.read(); eq(rs.source, 'none'); eq(rs.valid, false);
  await rejects(v.calibrate(), 'not-running');
  const creates = env.h.calls.filter((c) => c.fn === 'create').length;
  await v.start();
  eq(env.h.calls.filter((c) => c.fn === 'create').length, creates, 'повторный start без перезагрузки модели');
  await pump(env, 400, null);
  ok(v.read().valid, 'после повторного start ввод валиден (калибровка сохранена)');
  v.dispose();
  ok(env.h.instances.every((i) => i.closed), 'landmarker закрыт');
  await rejects(v.start(), 'disposed');
}));

test('C07 калибровка прерывается stop() и перезапуском', () => withShell({}, async (env, v) => {
  await v.start();
  await pump(env, 300, null);
  const c1 = rejects(v.calibrate(), 'restarted');
  await pump(env, 200, null);
  const c2 = rejects(v.calibrate(), 'stopped');
  await c1;
  await pump(env, 300, null);
  v.stop();
  await c2;
  eq(v.getStatus().calibrated, false);
}));

test('C08 configure: чувствительность, чужие ключи, overlay рисует и очищается', async () => {
  const calls = { clear: 0, arc: 0, stroke: 0 };
  const ctx = { clearRect() { calls.clear++; }, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { calls.stroke++; }, arc() { calls.arc++; }, fill() {}, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  await withShell({ overlayCanvas: canvas, config: { overlay: true } }, async (env, v) => {
    await v.start();
    const dz1 = v.getStatus().debug.thresholds.deadZone;
    v.configure({ sensitivity: 2, quality: 'high', volume: 0.1 });
    const dz2 = v.getStatus().debug.thresholds.deadZone;
    near(dz2, dz1 / 2, 0.002, 'dead zone при sensitivity 2');
    await pump(env, 300, null);
    ok(calls.arc > 0 && canvas.width === 640, 'overlay нарисован');
    const c0 = calls.clear;
    v.configure({ overlay: false });
    ok(calls.clear > c0, 'overlay очищен при выключении');
    const a0 = calls.arc;
    await pump(env, 200, null);
    eq(calls.arc, a0, 'выключенный overlay не рисуется');
  });
});

test('C09 worker: module worker, самопроверка, ≤1 кадр в работе, bitmap закрываются, калибровка и рывок', () => withShell({ worker: true, videoW: 1280, videoH: 720 }, async (env, v) => {
  await v.start();
  let s = v.getStatus();
  eq(s.mode, 'worker'); eq(s.delegate, 'GPU');
  const w = FakeWorker.created[0];
  eq(FakeWorker.created.length, 1); eq(w.opts.type, 'module'); ok(/vision-worker\.js$/.test(w.url), w.url);
  const init = w.sent.find((m) => m.type === 'init');
  eq(init.apiVersion, API_VERSION); eq(init.mp.moduleUrl, FAKE_MP.moduleUrl); eq(init.mp.wasmRoot, FAKE_MP.wasmRoot); eq(init.mp.modelUrl, FAKE_MP.modelUrl);
  await pump(env, 500, null, { worker: true });
  eq(v.getStatus().status, 'ready');
  const cap = env.captures.find((c) => c);
  ok(cap && cap.resizeWidth === 640 && cap.resizeHeight === 360, `уменьшение кадра перед передачей: ${JSON.stringify(cap)}`);

  // медленный worker: новые кадры не копятся в очередь
  FakeWorker.hooks.delayMs = 40;
  const sb0 = v.getStatus().debug.skippedBusy;
  for (let i = 0; i < 12; i++) { clock.t += 1000 / 30; env.video.present(clock.t); await realWait(5); }
  await realWait(150);
  FakeWorker.hooks.delayMs = 0;
  env.nextFrame = clock.t;
  ok(v.getStatus().debug.skippedBusy > sb0, 'кадры пропущены, пока worker занят');
  ok(w.maxInflight <= 1, `одновременно в работе: ${w.maxInflight}`);

  let calibrated = false;
  v.calibrate().then(() => { calibrated = true; }, () => {});
  await pump(env, 3000, null, { worker: true, until: () => calibrated });
  ok(calibrated, 'калибровка через worker');
  await pump(env, 300, null, { worker: true });
  const d = dashes(await pump(env, 800, moveTo(0, 0.4, 180), { worker: true }));
  eq(d.length, 1, 'рывок через worker'); eq(d[0].dash, 1);
  s = v.getStatus();
  ok(s.debug.results > 20 && s.debug.errors === 0, `результатов ${s.debug.results}, ошибок ${s.debug.errors}`);
  v.stop();
  await realWait(60);
  const caps = gfx.bitmaps.filter((b) => b.tag === 'capture');
  ok(caps.length > 20 && caps.every((b) => b.closed), `закрыто ${caps.filter((b) => b.closed).length} из ${caps.length} ImageBitmap`);
}));

test('C10 worker не прошёл самопроверку → честный откат в главный поток', () => withShell({ worker: true }, async (env, v) => {
  env.h.failFileset = (useModule) => useModule; // ES-модульный загрузчик WASM не работает
  await v.start();
  const s = v.getStatus();
  eq(s.mode, 'main');
  ok(/fake fileset failure/.test(s.debug.workerFallbackReason), s.debug.workerFallbackReason);
  ok(FakeWorker.created[0].terminated, 'worker завершён');
  await pump(env, 400, null);
  eq(v.getStatus().status, 'ready');
  ok(env.h.detectSources.some((src) => src === env.video), 'inference идёт в главном потоке по <video>');
}));

test('C11 worker: повторные ошибки кадров → переключение в главный поток на лету', () => withShell({ worker: true }, async (env, v) => {
  await v.start();
  await pump(env, 300, null, { worker: true });
  env.h.detectThrows = (src) => !!src.__bitmap;
  await pump(env, 600, null, { worker: true });
  await settle(10);
  const s = v.getStatus();
  eq(s.mode, 'main'); ok(/повторные ошибки/.test(s.debug.workerFallbackReason), s.debug.workerFallbackReason);
  await pump(env, 400, null);
  eq(v.getStatus().status, 'ready', 'трекинг продолжается');
  ok(v.getStatus().debug.errors >= 3, `ошибок кадров в worker: ${v.getStatus().debug.errors}`);
}));

test('C16 ASHEN_V2: по умолчанию корпус героя не двигает (наклон и резкий сдвиг плеч → moveX=0, dash=0)', () => withShell({ config: { torsoMove: false } }, async (env, v) => {
  await v.start();
  await pump(env, 500, null);
  let calibrated = false;
  v.calibrate().then(() => { calibrated = true; }, () => {});
  await pump(env, 3000, null, { until: () => calibrated });
  ok(calibrated, 'калибровка');
  await pump(env, 300, null);
  const lean = await pump(env, 900, moveTo(0, 0.45, 250));
  eq(dashes(lean).length, 0, 'резкий сдвиг корпуса не даёт рывок');
  ok(lean.every((f) => f.moveX === 0 && f.moveZ === 0), 'наклон корпуса не двигает');
  ok(lean.some((f) => f.valid), 'кадры валидны — корпус нужен только для присутствия');
  ok(lean.every((f) => 'dashDir' in f && 'stick' in f && 'spark' in f && 'slash' in f && 'parry' in f && 'burstHand' in f), 'поля InputFrame V2');
}));

test('C12 worker не отвечает на кадр → таймаут и откат', () => withShell({ worker: true, config: { workerFrameTimeoutMs: 1000 } }, async (env, v) => {
  await v.start();
  await pump(env, 300, null, { worker: true });
  FakeWorker.hooks.dropFrames = true;
  await pump(env, 1300, null, { worker: true });
  await realWait(300); // сторож проверяет раз в 200 мс реального времени
  await settle(10);
  const s = v.getStatus();
  eq(s.mode, 'main'); ok(/не ответил/.test(s.debug.workerFallbackReason), s.debug.workerFallbackReason);
  FakeWorker.hooks.dropFrames = false;
  await pump(env, 400, null);
  ok(v.read().source === 'cv' && v.getStatus().status === 'ready', 'трекинг продолжается');
}));

test('C13 камера отключилась во время работы → device-lost, повторный start возможен', () => withShell({}, async (env, v) => {
  await v.start();
  await pump(env, 300, null);
  env.track.l.ended();
  const s = v.getStatus();
  eq(s.status, 'error'); eq(s.error, 'device-lost'); eq(v.read().valid, false);
  await v.start();
  eq(env.gum.length, 2);
}));

test('C14 rVFC не вызывается → переход на опрос без повторной обработки кадра', () => withShell({ config: { rvfcStarveMs: 600 } }, async (env, v) => {
  await v.start();
  await pump(env, 300, null);
  clock.t += 1000; // кадры перестали приходить через rVFC
  await realWait(260);
  const s = v.getStatus();
  eq(s.debug.loopMode, 'poll'); eq(s.debug.rvfcStarved, true);
  const d0 = env.h.detectCalls;
  await realWait(150); // часы стоят — «новых» кадров нет
  ok(env.h.detectCalls - d0 <= 1, `при неизменном времени inference: ${env.h.detectCalls - d0}`);
  clock.t += 200;
  await realWait(80);
  ok(env.h.detectCalls > d0, 'опрос обрабатывает новые кадры');
}));

// Поддельный интерпретатор кистей (API core/handGestures.js). Настоящий распознаватель
// «лепки» пишет другой участник; здесь проверяется только слияние в createVision.read().
function makeFakeHands() {
  const idle = () => ({
    available: false, left: null, right: null, attack: false, shield: false, charge: 0,
    burst: false, burstPower: 0, rune: null, runeScore: 0, runeFizzle: false, dash: 0,
    drawing: false, trail: [], lastRune: null, // без conjure/throw — как у старой версии
  });
  const fh = { hold: null, pulse: null, pushes: 0 };
  fh.both = (over = {}) => ({
    ...idle(), available: true,
    left: { shape: 'open', palmFacing: 'camera', charge: 0, center: { x: 0.4, y: 0.55 } },
    right: { shape: 'open', palmFacing: 'camera', charge: 0, center: { x: 0.6, y: 0.55 }, tip: { x: 0.6, y: 0.5 } },
    attack: true, shield: true, burst: true, burstPower: 0.9, rune: 'ignis', runeScore: 0.9, dash: 1, ...over,
  });
  fh.api = {
    push() { fh.pushes++; },
    peek() { return { ...(fh.hold || idle()), ...(fh.pulse || {}) }; },
    read() { const v = fh.api.peek(); fh.pulse = null; return v; },
    configure() {}, reset() { fh.pulse = null; }, getDebug: () => ({ fake: true }),
  };
  return fh;
}

test('C15 read(): conjure/throw кистей очищаются и сливаются, подавляют одиночные жесты; moveZ; невалидный кадр → null', async () => {
  const fh = makeFakeHands();
  await withShell({ handInterpreter: fh.api }, async (env, v) => {
    await v.start();
    await pump(env, 300, null);
    let r = v.read();
    eq(r.valid, false, 'до калибровки'); eq(r.moveZ, 0); eq(r.conjure, null); eq(r.throw, null);
    let calibrated = false;
    v.calibrate().then(() => { calibrated = true; }, () => {});
    await pump(env, 3000, null, { until: () => calibrated });
    ok(calibrated, 'калибровка');
    await pump(env, 300, null);
    ok(fh.pushes > 10, `кисти получают наблюдения: ${fh.pushes}`);
    r = v.read();
    eq(r.valid, true); eq(r.conjure, null, 'интерпретатор без поля conjure → null'); eq(r.throw, null);
    // удержание «лепки»: значения ограничены, лишние поля сохранены
    fh.hold = fh.both({ conjure: { kind: 'orb', size: 1.7, charge: 0.5, center: { x: 0.52, y: 0.61 }, heldMs: 420, shape: 'sphere-outline' } });
    r = v.read();
    eq(r.conjure.kind, 'orb'); eq(r.conjure.size, 1, 'size ≤ 1'); eq(r.conjure.charge, 0.5);
    eq(r.conjure.center.x, 0.52); eq(r.conjure.center.y, 0.61); eq(r.conjure.heldMs, 420); eq(r.conjure.shape, 'sphere-outline');
    eq(r.attack, false, 'щипок не стреляет'); eq(r.shield, false, 'ладонь не щит'); eq(r.burst, false); eq(r.burstPower, 0);
    eq(r.rune, null); eq(r.dash, 0, 'рывок взмахом кисти подавлен');
    fh.hold = fh.both({ conjure: { kind: 'prism', size: NaN, charge: 'x' } });
    r = v.read();
    eq(r.conjure.kind, 'prism'); eq(r.conjure.size, 0); eq(r.conjure.charge, 0); eq(r.conjure.center.x, 0.5); eq(r.conjure.heldMs, 0);
    for (const bad of [{ kind: 'cube', size: 0.5 }, 'orb', 42, null]) {
      fh.hold = fh.both({ conjure: bad });
      eq(v.read().conjure, null, `мусор ${JSON.stringify(bad)} → null`);
    }
    fh.hold = fh.both();
    ok(v.read().attack === false && v.read().shield, 'без conjure одиночные жесты кистей снова работают');
    // импульс броска
    fh.pulse = { throw: { kind: 'prism', size: 0.6, power: 1.4, aimX: -3, extra: 1 } };
    r = v.read();
    eq(r.throw.kind, 'prism'); eq(r.throw.size, 0.6); eq(r.throw.power, 1, 'power ≤ 1'); eq(r.throw.aimX, -1, 'aimX ≥ −1'); eq(r.throw.extra, 1);
    eq(r.burst, false, 'выброс в кадре броска подавлен'); eq(r.rune, null, 'руна в кадре броска подавлена');
    eq(v.read().throw, null, 'импульс потреблён');
    fh.pulse = { throw: { kind: 'orb', size: 'big', power: undefined, aimX: NaN } };
    r = v.read();
    eq(r.throw.size, 0.5); eq(r.throw.power, 0.5); eq(r.throw.aimX, 0);
    fh.pulse = { throw: { kind: 'sphere', size: 0.5 } };
    eq(v.read().throw, null, "kind вне контракта ('orb'|'prism') → null");
    // наклон вперёд через оболочку
    fh.hold = null;
    const lean = await pump(env, 1200, (st) => { st.scale = 1.15; });
    ok(lean[lean.length - 1].valid && lean[lean.length - 1].moveZ > 0.5, `moveZ через createVision: ${lean[lean.length - 1].moveZ}`);
    ok(v.getStatus().debug.depth && v.getStatus().debug.depth.moveZ > 0.5, 'getStatus().debug.depth');
    await pump(env, 800, (st) => { st.scale = 1; });
    // невалидный кадр: человек ушёл — conjure и throw обнулены, импульс кистей сожжён
    fh.hold = fh.both({ conjure: { kind: 'orb', size: 0.5, charge: 0.5, center: { x: 0.5, y: 0.5 }, heldMs: 100 } });
    const lost = await pump(env, 1200, (st) => { st.present = false; });
    const lf = lost[lost.length - 1];
    eq(lf.valid, false); eq(lf.conjure, null); eq(lf.throw, null); eq(lf.moveZ, 0);
    fh.pulse = { throw: { kind: 'orb', size: 0.5, power: 1, aimX: 0 } };
    r = v.read();
    eq(r.valid, false); eq(r.throw, null, 'бросок в невалидном кадре не проходит'); eq(fh.pulse, null, 'импульс кистей потреблён');
    // кисти выключены — поля есть, но пустые
    await pump(env, 800, (st) => { st.present = true; });
    v.configure({ hands: false });
    fh.pulse = { throw: { kind: 'orb', size: 0.5, power: 1, aimX: 0 } };
    r = v.read();
    eq(r.valid, true); eq(r.conjure, null); eq(r.throw, null); eq(typeof r.moveZ, 'number');
  });
});

test('C18 [CONTROLS] запись кистей: startRecording → кадры те же, что уходят в распознавание; takeRecording очищает; stop — выключает', async () => {
  const fh = makeFakeHands();
  await withShell({ handInterpreter: fh.api }, async (env, v) => {
    await v.start();
    eq(v.recordingSize(), 0, 'без startRecording не пишется');
    await pump(env, 300, null);
    eq(v.recordingSize(), 0, 'и после кадров');
    v.startRecording({ test: 1 });
    const p0 = fh.pushes;
    await pump(env, 500, null);
    const n = v.recordingSize();
    ok(n > 5 && n === fh.pushes - p0, `записано ${n}, в распознавание ушло ${fh.pushes - p0}`);
    const rec = JSON.parse(JSON.stringify(v.takeRecording()));
    ok(rec.kind === 'ashen-hands' && rec.frames.length === n && rec.test === 1 && rec.moveMode, 'формат и метаданные');
    ok(rec.frames.every((f, i) => i === 0 || f.t > rec.frames[i - 1].t), 'время растёт');
    eq(v.recordingSize(), 0, 'takeRecording — с чистого листа');
    await pump(env, 200, null);
    ok(v.recordingSize() > 0, 'запись продолжается');
    ok(v.stopRecording().frames.length > 0, 'stopRecording отдаёт остаток');
    eq(v.takeRecording(), null, 'после stop записи нет');
  });
});

// ───────────────────────────── запуск ─────────────────────────────
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let passed = 0;
let failed = 0;
const t0 = Date.now();
for (const t of tests) {
  if (only && !only.test(t.name)) continue;
  try {
    await t.fn();
    passed++;
    console.log(`PASS ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n     ')}`);
  }
}
console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено (${Date.now() - t0} мс). Синтетика и подделки — не реальная камера.`);
process.exitCode = failed ? 1 : 0;
