// Тесты core/handGestures.js на синтетической параметрической кисти. node dev/handGestures.test.mjs
// Синтетика проверяет логику (формы, гистерезис, заряд, руны, взмах, стороны, надёжность);
// точность на реальных кистях проверяет dev/handGestures.real.test.mjs (фикстуры MediaPipe).

import { createHandGestures, recognizeStroke, DEFAULT_HAND_CONFIG, RUNES, HAND_GESTURES_VERSION } from '../core/handGestures.js';

let pass = 0, fail = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(`PASS ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n     ${e.message}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// ───────── синтетическая кисть ─────────
// Локальная система кисти (метры): ладонь в плоскости z=0, пальцы вдоль +y, камера смотрит вдоль +z
// (MediaPipe: меньший z — ближе к камере). Базовая раскладка — ЛЕВАЯ кисть ладонью к камере
// (указательный слева в незеркальном кадре); правая получается зеркалом. Проверено на реальных
// кадрах HaGRID: у правой кисти ладонью к камере указательный правее мизинца, а метка handedness
// MediaPipe на незеркальном кадре совпадает со стороной человека.
let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

const MCP = [[-0.034, 0.088], [-0.012, 0.094], [0.01, 0.089], [0.03, 0.078]];
const SEG = [[0.043, 0.025, 0.021], [0.047, 0.029, 0.022], [0.044, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [70, 95, 65];

function fingerChain(base, segs, curl, splay) {
  const pts = [];
  let p = { x: base[0], y: base[1], z: 0 };
  pts.push(p);
  let phi = 0;
  for (let j = 0; j < 3; j++) {
    phi += (curl * FLEX[j] * Math.PI) / 180;
    const d = { x: Math.sin(splay) * Math.cos(phi), y: Math.cos(splay) * Math.cos(phi), z: -Math.sin(phi) };
    p = { x: p.x + d.x * segs[j], y: p.y + d.y * segs[j], z: p.z + d.z * segs[j] };
    pts.push(p);
  }
  return pts; // mcp, pip, dip, tip
}

/**
 * opts: side 'right'|'left', curls [index, middle, ring, pinky] 0..1, thumb 'out'|'in'|'pinch',
 *       palm 'camera'|'away', roll (rad, в плоскости кадра), pitch (rad, кисть наклонена к камере),
 *       yaw (rad, поворот вокруг вертикали: ладонь ребром к камере),
 *       cx, cy (центр ладони в кадре, незеркальные нормализованные), size (высота ладони в долях кадра),
 *       noise (доля размера ладони), aspect
 */
function makeHand(opts = {}) {
  const o = { side: 'right', curls: [0, 0, 0, 0], thumb: 'out', palm: 'camera', roll: 0, pitch: 0, yaw: 0, cx: 0.4, cy: 0.5, size: 0.14, noise: 0, aspect: 4 / 3, ...opts };
  const L = new Array(21);
  L[0] = { x: 0, y: 0, z: 0 };
  const splays = [0.12, 0.03, -0.06, -0.16];
  for (let f = 0; f < 4; f++) {
    const ch = fingerChain(MCP[f], SEG[f], o.curls[f], -splays[f]);
    for (let j = 0; j < 4; j++) L[5 + f * 4 + j] = ch[j];
  }
  // большой палец
  const cmc = { x: -0.022, y: 0.018, z: -0.005 };
  let dirs;
  if (o.thumb === 'out') dirs = [{ x: -0.75, y: 0.62, z: -0.2 }, { x: -0.55, y: 0.8, z: -0.2 }, { x: -0.4, y: 0.9, z: -0.15 }];
  else dirs = [{ x: -0.3, y: 0.6, z: -0.75 }, { x: 0.45, y: 0.55, z: -0.7 }, { x: 0.85, y: 0.3, z: -0.45 }];
  const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const tl = [0.032, 0.03, 0.026];
  L[1] = cmc;
  let p = cmc;
  for (let j = 0; j < 3; j++) { const d = norm(dirs[j]); p = { x: p.x + d.x * tl[j], y: p.y + d.y * tl[j], z: p.z + d.z * tl[j] }; L[2 + j] = p; }
  if (o.thumb === 'pinch') {
    const tip = L[8];
    const target = { x: tip.x - 0.004, y: tip.y - 0.004, z: tip.z - 0.003 };
    L[4] = target;
    L[3] = { x: (L[2].x + target.x) / 2 - 0.006, y: (L[2].y + target.y) / 2, z: (L[2].z + target.z) / 2 - 0.004 };
  }
  // левая кисть — зеркальная копия; «от камеры» — поворот на 180° вокруг оси y
  const tr = L.map((q) => {
    let x = q.x, y = q.y, z = q.z;
    if (o.side === 'right') x = -x;
    if (o.palm === 'away') { x = -x; z = -z; }
    // поворот вокруг вертикали (ладонь «ребром» к камере, например ладони друг к другу)
    const cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw);
    [x, z] = [x * cyw + z * syw, -x * syw + z * cyw];
    // наклон к камере (вокруг x)
    const cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    // крен в плоскости кадра (вокруг z)
    const cr = Math.cos(o.roll), sr = Math.sin(o.roll);
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    return { x, y, z };
  });
  const scale = o.size / 0.09; // высот кадра на метр
  const n = o.noise * o.size;
  const img = tr.map((q) => ({
    x: o.cx + (q.x * scale) / o.aspect + (n ? gauss() * n / o.aspect : 0),
    y: o.cy - q.y * scale + (n ? gauss() * n : 0),
    z: q.z * scale,
  }));
  let mx = 0, my = 0, mz = 0;
  for (const q of tr) { mx += q.x; my += q.y; mz += q.z; }
  mx /= 21; my /= 21; mz /= 21;
  const world = tr.map((q) => ({ x: q.x - mx, y: -(q.y - my), z: q.z - mz }));
  return { landmarks: img, world, handedness: o.side === 'right' ? 'Right' : 'Left', score: 0.95 };
}

const SHAPES = {
  open: { curls: [0, 0, 0, 0], thumb: 'out' },
  fist: { curls: [1, 1, 1, 1], thumb: 'in' },
  point: { curls: [0, 1, 1, 1], thumb: 'in' },
  victory: { curls: [0, 0, 1, 1], thumb: 'in' },
  pinch: { curls: [0.45, 0, 0, 0], thumb: 'pinch' }, // мудра OK: остальные пальцы выпрямлены
};

function obsOf(t, hands, extra) {
  extra = extra || {};
  return {
    tMs: t, frameW: 640, frameH: 480, mirror: true, hands,
    poseWrists: extra.poseWrists === undefined ? null : extra.poseWrists,
    bodyCenter: extra.bodyCenter || null, shoulderWidth: extra.shoulderWidth || 0.35,
  };
}
// Прогон: fn(t) -> массив рук; шаг dt мс
function run(g, t0, ms, fn, dt = 33, extra) {
  let t = t0;
  for (; t < t0 + ms; t += dt) g.push(obsOf(t, fn(t), typeof extra === 'function' ? extra(t) : extra));
  return t;
}
function shapeAfter(opts, ms = 400) {
  const g = createHandGestures();
  const t = run(g, 1000, ms, () => [makeHand(opts)]);
  const f = g.peek(t);
  return { f, g, t };
}

// ───────── тесты ─────────
test('API: версия, экспорты, форма HandIntent', () => {
  ok(HAND_GESTURES_VERSION.startsWith('ASHEN_V'));
  ok(DEFAULT_HAND_CONFIG.pinchOn < DEFAULT_HAND_CONFIG.pinchOff);
  eq(Object.keys(RUNES).join(','), 'ignis,fulgur,orbis');
  const g = createHandGestures();
  const f = g.read(0);
  for (const k of ['available', 'left', 'right', 'attack', 'shield', 'charge', 'burst', 'burstPower', 'rune', 'runeScore', 'runeFizzle', 'dash', 'drawing', 'trail', 'lastRune']) ok(k in f, `нет поля ${k}`);
  eq(f.available, false); eq(f.attack, false); eq(f.dash, 0);
});

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`форма ${name}: разные повороты, размеры, шум, обе кисти`, () => {
    for (const side of ['right', 'left']) for (const roll of [-0.5, 0, 0.45]) for (const size of [0.09, 0.14, 0.22]) {
      seed = 7 + Math.round(roll * 100) + Math.round(size * 1000);
      const { f } = shapeAfter({ ...shape, side, roll, size, noise: 0.01, cx: side === 'right' ? 0.35 : 0.65 });
      const st = side === 'right' ? f.right : f.left;
      ok(st, `${side}: кисть не найдена`);
      eq(st.shape, name, `${side} roll=${roll} size=${size}`);
    }
  });
}

test('палец к камере (наклон 55°) — всё ещё POINT, а не кулак', () => {
  const { f } = shapeAfter({ ...SHAPES.point, pitch: 0.95 });
  eq(f.right.shape, 'point');
});

test('ладонь к камере / от камеры', () => {
  eq(shapeAfter({ ...SHAPES.open, side: 'left', cx: 0.65 }).f.left.palmFacing, 'camera');
  eq(shapeAfter({ ...SHAPES.open, side: 'left', palm: 'away', cx: 0.65 }).f.left.palmFacing, 'away');
  eq(shapeAfter({ ...SHAPES.open, side: 'right' }).f.right.palmFacing, 'camera');
});

// [V3] щит поднимается толчком ладони к камере: кисть растёт в кадре
function pushLeft(g, t0, o = {}, others = () => []) {
  let t = run(g, t0, 500, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12, ...o }), ...others()]);
  t = run(g, t, 200, (tt) => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.12 + 0.04 * Math.min(1, (tt - t) / 180), ...o }), ...others()]);
  return run(g, t, 150, () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.65, size: 0.16, ...o }), ...others()]);
}

test('удержания: щипок правой = огонь, толчок ладонью левой к камере = щит, от камеры — нет щита', () => {
  let r = shapeAfter({ ...SHAPES.pinch });
  ok(r.f.attack && !r.f.shield, 'pinch → attack');
  r = shapeAfter({ ...SHAPES.open, side: 'left', cx: 0.65 });
  ok(!r.f.shield, 'просто поднятая раскрытая ладонь — ещё не щит');
  { const g = createHandGestures(); const t = pushLeft(g, 1000); const f = g.peek(t); ok(f.shield && !f.attack, 'толчок ладонью → щит'); }
  r = shapeAfter({ ...SHAPES.open, side: 'left', palm: 'away', cx: 0.65 });
  ok(!r.f.shield, 'palm away → no shield');
  r = shapeAfter({ ...SHAPES.pinch, side: 'left', cx: 0.65 });
  ok(!r.f.attack, 'левый щипок не стреляет');
});

test('форма не мигает: короткий выброс формы < hold не меняет состояние', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [makeHand(SHAPES.open)]);
  t = run(g, t, 40, () => [makeHand(SHAPES.fist)]); // ~1–2 кадра кулака
  t = run(g, t, 300, () => [makeHand(SHAPES.open)]);
  eq(g.peek(t).right.shape, 'open');
});

test('после появления кисти жесты заблокированы reacquireMs (нет мгновенного выстрела)', () => {
  const g = createHandGestures();
  run(g, 1000, 200, () => [makeHand(SHAPES.pinch)]);
  ok(!g.peek(1200).attack, 'рано');
  run(g, 1200, 300, () => [makeHand(SHAPES.pinch)]);
  ok(g.peek(1500).attack, 'после блокировки');
});

test('кулак → ладонь: выброс, сила = заряд; без заряда — нет; повтор требует нового кулака', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [makeHand(SHAPES.open)]);
  t = run(g, t, 1300, () => [makeHand(SHAPES.fist)]);
  ok(g.peek(t).charge > 0.9, `заряд ${g.peek(t).charge}`);
  let fired = null;
  for (let i = 0; i < 12 && !fired; i++) { g.push(obsOf(t, [makeHand(SHAPES.open)])); const f = g.read(t); if (f.burst) fired = f; t += 33; }
  ok(fired, 'выброс не сработал');
  ok(fired.burstPower > 0.9, `сила ${fired.burstPower}`);
  // сразу снова раскрытая ладонь — без нового кулака выброса нет
  let again = false;
  t = run(g, t, 800, () => [makeHand(SHAPES.open)]);
  if (g.read(t).burst) again = true;
  ok(!again, 'повторный выброс без кулака');
  // короткий кулак (заряд < minCharge)
  const g2 = createHandGestures();
  let t2 = run(g2, 1000, 500, () => [makeHand(SHAPES.open)]);
  t2 = run(g2, t2, 300, () => [makeHand(SHAPES.fist)]);
  let any = false;
  for (let i = 0; i < 15; i++) { g2.push(obsOf(t2, [makeHand(SHAPES.open)])); if (g2.read(t2).burst) any = true; t2 += 33; }
  ok(!any, 'выброс без заряда');
});

test('выброс двумя кулаками: бонус к силе', () => {
  const g = createHandGestures();
  const two = (sh) => [makeHand({ ...sh, side: 'right', cx: 0.35 }), makeHand({ ...sh, side: 'left', cx: 0.65 })];
  let t = run(g, 1000, 500, () => two(SHAPES.open));
  t = run(g, t, 700, () => two(SHAPES.fist)); // заряд ~0.45
  let fired = null;
  for (let i = 0; i < 15 && !fired; i++) { g.push(obsOf(t, two(SHAPES.open))); const f = g.read(t); if (f.burst) fired = f; t += 33; }
  ok(fired, 'нет выброса');
  ok(fired.burstPower > 0.6, `сила ${fired.burstPower} (ожидался бонус)`);
});

test('кулак не даёт огня/щита; щипок + ладонь левой — оба удержания', () => {
  const g = createHandGestures();
  const t = pushLeft(g, 1000, {}, () => [makeHand({ ...SHAPES.pinch, side: 'right', cx: 0.35 })]);
  const f = g.peek(t);
  ok(f.attack && f.shield, 'оба удержания');
  const g2 = createHandGestures();
  const t2 = run(g2, 1000, 600, () => [makeHand({ ...SHAPES.fist, side: 'left', cx: 0.65 })]);
  ok(!g2.peek(t2).shield, 'кулак левой не щит');
});

// ───────── руны ─────────
function strokeShape(kind, n = 40) {
  const pts = [];
  if (kind === 'triangle') {
    const V = [[0.5, 0], [1, 0.87], [0, 0.87], [0.5, 0]];
    for (let s = 0; s < 3; s++) for (let i = 0; i < n / 3; i++) { const u = i / (n / 3); pts.push([V[s][0] + (V[s + 1][0] - V[s][0]) * u, V[s][1] + (V[s + 1][1] - V[s][1]) * u]); }
    pts.push(V[3]);
  } else if (kind === 'circle') {
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; pts.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)]); }
  } else if (kind === 'zigzag') {
    const V = [[0.65, 0], [0.15, 0.55], [0.85, 0.45], [0.35, 1]];
    for (let s = 0; s < 3; s++) for (let i = 0; i < n / 3; i++) { const u = i / (n / 3); pts.push([V[s][0] + (V[s + 1][0] - V[s][0]) * u, V[s][1] + (V[s + 1][1] - V[s][1]) * u]); }
    pts.push(V[3]);
  } else if (kind === 'line') {
    for (let i = 0; i <= n; i++) pts.push([i / n, 0.5 + 0.02 * Math.sin(i)]);
  } else if (kind === 'scribble') {
    for (let i = 0; i <= n; i++) pts.push([0.5 + 0.45 * Math.sin(i * 1.7) * Math.cos(i * 0.43), 0.5 + 0.45 * Math.sin(i * 0.91 + 1)]);
  }
  return pts;
}

test('recognizeStroke: треугольник/круг/молния в обоих направлениях и под наклоном; отказ на линии и каракулях', () => {
  const cases = [['triangle', 'ignis'], ['circle', 'orbis'], ['zigzag', 'fulgur']];
  for (const [shape, rune] of cases) for (const rev of [false, true]) for (const rot of [-0.3, 0, 0.3]) for (const sc of [0.2, 0.5]) {
    let pts = strokeShape(shape).map(([x, y]) => ({ x, y }));
    if (rev) pts = pts.reverse();
    const c = Math.cos(rot), s = Math.sin(rot);
    pts = pts.map((p) => ({ x: (p.x * c - p.y * s) * sc + gauss() * 0.006, y: (p.x * s + p.y * c) * sc + gauss() * 0.006 }));
    const r = recognizeStroke(pts);
    eq(r.rune, rune, `${shape} rev=${rev} rot=${rot} sc=${sc} scores=${JSON.stringify(r.scores)} reason=${r.reason}`);
  }
  eq(recognizeStroke(strokeShape('line').map(([x, y]) => ({ x, y }))).rune, null, 'линия');
  eq(recognizeStroke(strokeShape('scribble', 80).map(([x, y]) => ({ x, y }))).rune, null, 'каракули');
});

function drawRune(g, t0, shapeName, { size = 0.3, cx = 0.45, cy = 0.45, dt = 33, msPerPt = 25, rev = false } = {}) {
  // Рисуем кончиком указательного правой кисти (форма POINT) в координатах ПОКАЗА.
  let pts = strokeShape(shapeName, 45);
  if (rev) pts = pts.reverse();
  let t = t0;
  const handAt = (dispX, dispY) => {
    const h = makeHand({ ...SHAPES.point, cx: 0.4, cy: 0.55 });
    const tip = h.landmarks[8];
    const rawX = 1 - dispX; // mirror
    const dx = rawX - tip.x, dy = dispY - tip.y;
    h.landmarks = h.landmarks.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
    return h;
  };
  const toDisp = ([x, y]) => [cx - size / 2 + x * size * 0.75, cy - size / 2 + y * size];
  // навести палец (удержание формы + блокировка появления)
  const [sx, sy] = toDisp(pts[0]);
  t = run(g, t, 450, () => [handAt(sx, sy)], dt);
  const total = pts.length * msPerPt;
  const start = t;
  for (; t < start + total; t += dt) {
    const k = Math.min(pts.length - 1, Math.floor((t - start) / msPerPt));
    const [x, y] = toDisp(pts[k]);
    g.push(obsOf(t, [handAt(x, y)]));
  }
  // палец неподвижен в конце → штрих завершён
  const [ex, ey] = toDisp(pts[pts.length - 1]);
  const out = [];
  for (let i = 0; i < 20; i++) { g.push(obsOf(t, [handAt(ex, ey)])); out.push(g.read(t)); t += dt; }
  return { t, frames: out };
}

test('руны в воздухе: указательный рисует треугольник/круг/молнию → нужный импульс, один раз', () => {
  for (const [shape, rune] of [['triangle', 'ignis'], ['circle', 'orbis'], ['zigzag', 'fulgur']]) for (const rev of [false, true]) {
    const g = createHandGestures();
    const { frames } = drawRune(g, 1000, shape, { rev });
    const runes = frames.filter((f) => f.rune);
    eq(runes.length, 1, `${shape} rev=${rev}: импульсов ${runes.length}; debug=${JSON.stringify(g.getDebug().lastRecognition)}`);
    eq(runes[0].rune, rune, shape);
  }
});

test('во время рисования нет огня; маленький штрих — не руна; каракули — fizzle', () => {
  const g = createHandGestures();
  drawRune(g, 1000, 'circle', { size: 0.05 });
  eq(g.getDebug().counters.runes, 0, 'крошечный круг');
  const g2 = createHandGestures();
  const { frames } = drawRune(g2, 1000, 'scribble', { size: 0.35 });
  ok(frames.every((f) => !f.rune), 'каракули не руна');
  ok(frames.every((f) => !f.attack), 'огонь во время рисования');
});

// ───────── взмах ─────────
function swipe(g, t0, dir, { speed = 2.6, mirror = true, bodyMoves = false } = {}) {
  let t = run(g, t0, 450, () => [makeHand({ ...SHAPES.open, cx: 0.5 })], 33, { bodyCenter: { x: 0.5, y: 0.6 } });
  const dur = 250;
  const start = t;
  const frames = [];
  for (; t < start + dur + 300; t += 33) {
    const u = Math.min(1, (t - start) / dur);
    // скорость в высотах кадра/с → смещение в нормализованном x
    const dxDisp = dir * u * (speed * dur / 1000) / (4 / 3);
    const rawDx = mirror ? -dxDisp : dxDisp;
    const body = bodyMoves ? { x: 0.5 + rawDx, y: 0.6 } : { x: 0.5, y: 0.6 };
    const o = obsOf(t, [makeHand({ ...SHAPES.open, cx: 0.5 + rawDx })], { bodyCenter: body });
    o.mirror = mirror;
    g.push(o);
    frames.push(g.read(t));
  }
  return frames;
}

test('взмах открытой правой ладонью = «Рассечение»: dir +1 вправо на экране, −1 влево (с зеркалом и без); рывка нет', () => {
  for (const mirror of [true, false]) for (const dir of [1, -1]) {
    const g = createHandGestures();
    const frames = swipe(g, 1000, dir, { mirror });
    const slashes = frames.filter((f) => f.slash);
    eq(slashes.length, 1, `mirror=${mirror} dir=${dir}`);
    eq(slashes[0].slash.dir, dir, `направление mirror=${mirror}`);
    ok(slashes[0].slash.power > 0 && slashes[0].slash.power <= 1, 'power');
    ok(frames.every((f) => f.dash === 0 && !f.dashDir), 'правая рука больше не делает рывок');
  }
});

test('медленное движение и движение корпуса вместе с рукой не дают «Рассечения»', () => {
  const g = createHandGestures();
  ok(swipe(g, 1000, 1, { speed: 0.8 }).every((f) => !f.slash), 'медленно');
  const g2 = createHandGestures();
  ok(swipe(g2, 1000, 1, { bodyMoves: true }).every((f) => !f.slash), 'корпус двигается вместе с кистью');
});

// ───────── стороны, надёжность ─────────
test('стороны игрока: по запястьям позы (важнее handedness), и по handedness без позы', () => {
  const g = createHandGestures();
  const h = makeHand({ ...SHAPES.open, side: 'right', cx: 0.3 });
  h.handedness = 'Left'; // намеренно «неправильная» метка
  const t = run(g, 1000, 400, () => [h], 33, { poseWrists: { right: { x: 0.3, y: 0.55, visibility: 0.9 }, left: { x: 0.7, y: 0.55, visibility: 0.9 } } });
  ok(g.peek(t).right && !g.peek(t).left, 'по позе → правая');
  const g2 = createHandGestures();
  const h2 = makeHand({ ...SHAPES.open, side: 'right', cx: 0.7 });
  h2.handedness = 'Right';
  const t2 = run(g2, 1000, 400, () => [h2]);
  ok(g2.peek(t2).right, 'Right от MediaPipe на незеркальном кадре = правая игрока');
});

test('координаты показа зеркалятся при mirror', () => {
  const g = createHandGestures();
  const t = run(g, 1000, 300, () => [makeHand({ ...SHAPES.open, cx: 0.3 })]);
  const f = g.peek(t);
  ok(f.right.center.x > 0.6, `центр ${f.right.center.x}`);
});

test('потеря кисти: удержания отпускаются сразу, состояние исчезает после lostGraceMs; устаревшие наблюдения', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [makeHand(SHAPES.pinch)]);
  ok(g.peek(t).attack);
  g.push(obsOf(t, []));
  ok(!g.peek(t).attack, 'удержание не отпущено');
  ok(g.peek(t).right, 'состояние ещё в grace');
  t = run(g, t + 33, 400, () => []);
  ok(!g.peek(t).right, 'состояние не сброшено');
  const g2 = createHandGestures();
  const t2 = run(g2, 1000, 500, () => [makeHand(SHAPES.pinch)]);
  ok(!g2.peek(t2 + 1000).attack, 'устаревшее наблюдение даёт удержание');
});

test('импульсы: read() потребляет, TTL гасит непрочитанные', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [makeHand(SHAPES.open)]);
  t = run(g, t, 1300, () => [makeHand(SHAPES.fist)]);
  let tBurst = null;
  for (let i = 0; i < 12 && tBurst === null; i++) { g.push(obsOf(t, [makeHand(SHAPES.open)])); if (g.peek(t).burst) tBurst = t; t += 33; }
  ok(tBurst !== null, 'нет выброса');
  ok(g.peek(tBurst + 100).burst, 'peek не должен потреблять');
  ok(!g.peek(tBurst + 1000).burst, 'TTL');
  g.read(tBurst + 100);
  ok(!g.peek(tBurst + 120).burst, 'read не потребил');
});

test('мусор на входе не ломает модуль', () => {
  const g = createHandGestures();
  const bad = [null, undefined, 5, {}, { tMs: 'x' }, { tMs: 10, hands: 'no' }, { tMs: 20, hands: [null, {}, { landmarks: [1, 2] }] },
    { tMs: 30, hands: [{ landmarks: new Array(21).fill({ x: NaN, y: 0 }) }] }, { tMs: 40, hands: [makeHand(SHAPES.open), makeHand(SHAPES.open), makeHand(SHAPES.fist)] },
    { tMs: 35, hands: [] }, { tMs: 50, frameW: 0, frameH: 0, hands: [makeHand(SHAPES.open)] }];
  for (const b of bad) g.push(b);
  const f = g.read(60);
  ok(typeof f.available === 'boolean');
  g.reset('test');
  eq(g.read(70).available, false);
});

// ───────── двуручные чары ─────────
// СФЕРА: обе кисти раскрыты, ладони друг к другу (поворот вокруг вертикали), кисти по бокам от центра.
function orbPose(o = {}) {
  const { half = 0.12, cx = 0.5, cy = 0.55, size = 0.14, yaw = 1.2 } = o;
  return [
    makeHand({ ...SHAPES.open, side: 'left', cx: cx + half, cy, yaw, size }),
    makeHand({ ...SHAPES.open, side: 'right', cx: cx - half, cy, yaw: -yaw, size }),
  ];
}
// ПРИЗМА: ладони к камере, указательные внутрь-вверх, кончики указательных и больших сходятся.
function prismPose(o = {}) {
  const { roll = 0.4, cy = 0.6, size = 0.14, cx = 0.5 } = o;
  const probe = makeHand({ ...SHAPES.open, side: 'left', cx: 0.5, cy, roll, size });
  const off = probe.landmarks[8].x - 0.5; // < 0: кончик указательного левее запястья
  return [
    makeHand({ ...SHAPES.open, side: 'left', cx: cx - off, cy, roll, size }),
    makeHand({ ...SHAPES.open, side: 'right', cx: cx + off, cy, roll: -roll, size }),
  ];
}

test('чары СФЕРА: ладони друг к другу → conjure orb; размер — от расстояния, заряд — от удержания; щит и огонь молчат', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => orbPose({ half: 0.1 }));
  let f = g.peek(t);
  ok(f.conjure && f.conjure.kind === 'orb', 'сфера не вызвана: ' + JSON.stringify(g.getDebug().conjure));
  eq(f.shield, false, 'открытая левая в позе сферы не должна ставить щит');
  eq(f.attack, false, 'огонь');
  const s1 = f.conjure.size;
  t = run(g, t, 400, () => orbPose({ half: 0.17 }));
  f = g.peek(t);
  ok(f.conjure && f.conjure.size > s1 + 0.1, `размер не вырос: ${s1} → ${f.conjure && f.conjure.size}`);
  t = run(g, t, 1300, () => orbPose({ half: 0.17 }));
  f = g.peek(t);
  ok(f.conjure.charge > 0.95, 'заряд ' + f.conjure.charge);
  ok(f.conjure.center && Math.abs(f.conjure.center.x - 0.5) < 0.02, 'центр между ладонями');
});

// ───────── [V3] двуручные печати ─────────
function collect(g, t0, ms, fn) { let t = t0; const seen = []; for (; t < t0 + ms; t += 33) { g.push(obsOf(t, fn(t))); const f = g.read(t); if (f.sigil) seen.push(f.sigil); } return { t, seen }; }

test('[V3] ХЛОПОК: раскрытые ладони быстро сходятся → sigil clap (сфера гаснет); медленно — нет', () => {
  let g = createHandGestures();
  let r = collect(g, 1000, 650, () => orbPose({ half: 0.17 }));
  const t1 = r.t;
  r = collect(g, t1, 180, (tt) => orbPose({ half: 0.17 - 0.135 * Math.min(1, (tt - t1) / 150) }));
  ok(r.seen.includes('clap'), 'хлопок: ' + JSON.stringify(r.seen) + ' ' + JSON.stringify(g.getDebug().conjure));
  ok(!g.peek(r.t).conjure, 'сфера погашена печатью');
  g = createHandGestures();
  r = collect(g, 1000, 650, () => orbPose({ half: 0.17 }));
  const t2 = r.t;
  r = collect(g, t2, 1600, (tt) => orbPose({ half: 0.17 - 0.135 * Math.min(1, (tt - t2) / 1500) }));
  ok(!r.seen.includes('clap'), 'медленное сведение — не хлопок: ' + JSON.stringify(r.seen));
});

test('[V3] ВРАТА: ладони вместе → резко развести → sigil gate; медленно развести — нет', () => {
  let g = createHandGestures();
  let r = collect(g, 1000, 800, () => orbPose({ half: 0.04 }));
  const t1 = r.t;
  r = collect(g, t1, 260, (tt) => orbPose({ half: 0.04 + 0.18 * Math.min(1, (tt - t1) / 200) }));
  ok(r.seen.includes('gate'), 'врата: ' + JSON.stringify(r.seen));
  g = createHandGestures();
  r = collect(g, 1000, 800, () => orbPose({ half: 0.04 }));
  const t2 = r.t;
  r = collect(g, t2, 1400, (tt) => orbPose({ half: 0.04 + 0.18 * Math.min(1, (tt - t2) / 1300) }));
  ok(!r.seen.includes('gate'), 'медленно — не врата: ' + JSON.stringify(r.seen));
});

test('[V3] РАМКА: две «Г» по диагонали → sigil frame один раз; правая «Г» не рисует руну', () => {
  const g = createHandGestures();
  const Lsh = { curls: [0, 1, 1, 1], thumb: 'out' };
  const pose = () => [makeHand({ ...Lsh, side: 'left', cx: 0.64, cy: 0.7 }), makeHand({ ...Lsh, side: 'right', cx: 0.36, cy: 0.42 })];
  const r = collect(g, 1000, 1400, pose);
  ok(r.seen.filter((k) => k === 'frame').length === 1, 'рамка ровно один раз: ' + JSON.stringify(r.seen) + ' ' + JSON.stringify(g.getDebug().right));
  ok(!g.peek(r.t).rune, 'руны нет');
  // одна «Г» — не рамка
  const g2 = createHandGestures();
  const r2 = collect(g2, 1000, 1000, () => [makeHand({ ...Lsh, side: 'left', cx: 0.64, cy: 0.7 }), makeHand({ ...SHAPES.open, side: 'right', cx: 0.36, cy: 0.42 })]);
  ok(!r2.seen.length, 'одна «Г» — нет печати');
});

test('чары ПРИЗМА: треугольник из больших и указательных → conjure prism', () => {
  const g = createHandGestures();
  const t = run(g, 1000, 600, () => prismPose());
  const f = g.peek(t);
  ok(f.conjure && f.conjure.kind === 'prism', 'призма не вызвана: ' + JSON.stringify(g.getDebug().conjure));
});

test('не чары: ладони наружу, руки опущены пальцами вниз, одна кисть', () => {
  for (const [name, pose] of [
    ['ладони наружу', () => orbPose({ yaw: -1.2 })],
    ['пальцы вниз', () => [makeHand({ ...SHAPES.open, side: 'left', cx: 0.62, cy: 0.5, yaw: 1.2, roll: Math.PI }), makeHand({ ...SHAPES.open, side: 'right', cx: 0.38, cy: 0.5, yaw: -1.2, roll: Math.PI })]],
    ['одна кисть', () => [orbPose()[0]]],
  ]) {
    const g = createHandGestures();
    const t = run(g, 1000, 700, pose);
    eq(g.peek(t).conjure, null, name);
  }
});

test('бросок толчком: обе кисти резко выросли в кадре → throw push; чары гаснут, удержания молчат', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => orbPose({ half: 0.14 }));
  ok(g.peek(t).conjure, 'сфера до броска');
  const t0 = t;
  let thr = null;
  t = run(g, t, 450, (tt) => {
    const k = Math.min(1, (tt - t0) / 200);
    const f = g.peek(tt);
    if (f.throw && !thr) thr = f.throw;
    return orbPose({ half: 0.14 * (1 + 0.45 * k), size: 0.14 * (1 + 0.45 * k) });
  });
  ok(thr, 'броска нет: ' + JSON.stringify(g.getDebug().conjure));
  eq(thr.kind, 'orb'); eq(thr.how, 'push');
  ok(thr.power >= DEFAULT_HAND_CONFIG.throwMinPower && thr.power <= 1, 'power ' + thr.power);
  ok(thr.size > 0 && thr.size <= 1, 'size');
  const f = g.read(t);
  eq(f.conjure, null, 'после броска чары погасли');
  eq(g.getDebug().counters.throws, 1, 'ровно один бросок');
});

test('наклон всем корпусом к камере (плечи выросли так же) — не бросок', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => orbPose({ half: 0.14 }));
  const t0 = t;
  let thr = null;
  const k = (tt) => Math.min(1, (tt - t0) / 200);
  t = run(g, t, 450, (tt) => { if (g.peek(tt).throw) thr = true; return orbPose({ half: 0.14 * (1 + 0.45 * k(tt)), size: 0.14 * (1 + 0.45 * k(tt)) }); }, 33,
    (tt) => ({ shoulderWidth: 0.35 * (1 + 0.45 * k(tt)) }));
  ok(!thr, 'наклон корпусом бросил чары');
  ok(g.peek(t).conjure, 'сфера держится');
});

test('бросок рывком вбок → throw fling, aimX в сторону рывка (координаты показа)', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => orbPose());
  const t0 = t;
  let thr = null;
  // в незеркальном кадре кисти уходят влево = на зеркальном экране вправо
  t = run(g, t, 300, (tt) => { const f = g.peek(tt); if (f.throw && !thr) thr = f.throw; return orbPose({ cx: 0.5 - Math.min(0.22, (tt - t0) / 1000 * 2.2) }); });
  ok(thr, 'броска нет: ' + JSON.stringify(g.getDebug().conjure));
  eq(thr.how, 'fling');
  ok(thr.aimX > 0.3, 'aimX ' + thr.aimX);
  eq(g.peek(t).dash, 0, 'мах руками при броске не должен давать рывок');
  eq(g.peek(t).dashDir, null, 'и рывок джойстиком тоже');
  eq(g.peek(t).slash, null, 'и «Рассечение»');
});

test('поза сломалась дольше conjureDropMs → чары гаснут без броска', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => orbPose());
  ok(g.peek(t).conjure);
  t = run(g, t, DEFAULT_HAND_CONFIG.conjureDropMs + 150, () => [makeHand({ ...SHAPES.fist, side: 'left', cx: 0.62 }), makeHand({ ...SHAPES.fist, side: 'right', cx: 0.38 })]);
  const f = g.peek(t);
  eq(f.conjure, null, 'чары остались');
  eq(f.throw, null, 'бросок без движения');
  eq(g.getDebug().counters.throws, 0);
});

// ───────── ASHEN_V2: левая рука — джойстик, щит, парирование; правая — «Искра», выброс ─────────
const L_AT = (o = {}) => makeHand({ side: 'left', cx: 0.62, cy: 0.55, ...o });
const R_AT = (o = {}) => makeHand({ side: 'right', cx: 0.36, cy: 0.55, ...o });
const BODYX = { bodyCenter: { x: 0.5, y: 0.4 }, shoulderWidth: 0.25 };

test('парирование: левый кулак → раскрытая ладонь к камере = parry (не burst)', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })]);
  let parry = false, burst = false;
  t = run(g, t, 400, (tt) => { const f = g.read(tt); parry = parry || f.parry; burst = burst || f.burst; return [L_AT({ ...SHAPES.open })]; });
  const f = g.read(t); parry = parry || f.parry; burst = burst || f.burst;
  ok(parry, 'parry: ' + JSON.stringify(g.getDebug().left));
  ok(!burst, 'левая одна больше не делает выброс');
  eq(g.getDebug().counters.parries, 1, 'ровно одно парирование');
});

test('парирование не срабатывает, если ладонь раскрыта НЕ к камере', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })]);
  let parry = false;
  t = run(g, t, 500, (tt) => { parry = parry || g.read(tt).parry; return [L_AT({ ...SHAPES.open, palm: 'away' })]; });
  ok(!parry, 'ладонь от камеры');
});

test('выброс: правая кулак → ладонь = burstHand right; оба кулака → both', () => {
  let g = createHandGestures();
  let t = run(g, 1000, 900, () => [R_AT({ ...SHAPES.fist })]);
  let got = null;
  t = run(g, t, 400, (tt) => { const f = g.read(tt); if (f.burst && !got) got = f; return [R_AT({ ...SHAPES.open })]; });
  ok(got && got.burstHand === 'right', 'правая: ' + JSON.stringify(got && got.burstHand));
  g = createHandGestures();
  t = run(g, 1000, 900, () => [L_AT({ ...SHAPES.fist }), R_AT({ ...SHAPES.fist })]);
  got = null;
  let parry = false;
  t = run(g, t, 400, (tt) => { const f = g.read(tt); if (f.burst && !got) got = f; parry = parry || f.parry; return [L_AT({ ...SHAPES.open }), R_AT({ ...SHAPES.open })]; });
  ok(got && got.burstHand === 'both', 'обе: ' + JSON.stringify(got && got.burstHand));
  ok(!parry, 'одновременное раскрытие двух рук — выброс, а не парирование');
});

test('«Искра»: правый кулак → выпрямить только указательный = spark; не выброс и не руна', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => [R_AT({ ...SHAPES.fist })]);
  let spark = 0, burst = false, drawing = false;
  t = run(g, t, 330, (tt) => { const f = g.read(tt); if (f.spark) spark++; burst = burst || f.burst; drawing = drawing || f.drawing; return [R_AT({ ...SHAPES.point })]; }); // окно блокировки руны после щелчка
  eq(spark, 1, 'ровно одна искра; debug: ' + JSON.stringify(g.getDebug().right));
  ok(!burst, 'искра — не выброс');
  ok(!drawing, 'сразу после щелчка руна не начинается');
});

test('раскрытие всей правой кисти из кулака — выброс, не «Искра»', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 900, () => [R_AT({ ...SHAPES.fist })]);
  let spark = false, burst = false;
  t = run(g, t, 400, (tt) => { const f = g.read(tt); spark = spark || f.spark; burst = burst || f.burst; return [R_AT({ ...SHAPES.open })]; });
  ok(burst && !spark, `burst=${burst} spark=${spark}`);
});

test('щит — только раскрытая левая ладонь прямо к камере (ладонь ребром — нет)', () => {
  let g = createHandGestures();
  let t = pushLeft(g, 1000, { cx: 0.62, cy: 0.55 });
  ok(g.peek(t).shield, 'ладонь к камере — щит');
  g = createHandGestures();
  t = pushLeft(g, 1000, { cx: 0.62, cy: 0.55, yaw: 1.35 });
  ok(!g.peek(t).shield, 'ладонь ребром — не щит даже с толчком');
});

test('[V3] ведение героя раскрытой ладонью к камере не поднимает щит; джойстик едет', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 600, () => [L_AT({ ...SHAPES.open })], 33, BODYX);     // хватка с раскрытой ладонью
  let shield = false, maxX = 0;
  t = run(g, t, 900, (tt) => { const u = Math.min(1, (tt - t) / 500); const f = g.peek(tt); shield = shield || f.shield; maxX = Math.max(maxX, f.moveX); return [L_AT({ ...SHAPES.open, cx: 0.62 - 0.12 * u })]; }, 33, BODYX);
  ok(!shield, 'щит не включился при ведении');
  ok(maxX > 0.4, 'джойстик ведёт вправо: moveX ' + maxX.toFixed(2));
  // тот же щит толчком — поднимается и держится при движении ладони
  t = run(g, t, 300, () => [L_AT({ ...SHAPES.open, cx: 0.5, size: 0.14 })], 33, BODYX);
  t = run(g, t, 200, (tt) => [L_AT({ ...SHAPES.open, cx: 0.5, size: 0.14 + 0.05 * Math.min(1, (tt - t) / 180) })], 33, BODYX);
  ok(g.peek(t).shield, 'толчок → щит');
  t = run(g, t, 400, (tt) => [L_AT({ ...SHAPES.open, cx: 0.5 + 0.08 * Math.min(1, (tt - t) / 300), size: 0.19 })], 33, BODYX);
  ok(g.peek(t).shield, 'щит держится, пока ладонь к камере');
  t = run(g, t, 400, () => [L_AT({ ...SHAPES.fist, cx: 0.58, size: 0.19 })], 33, BODYX);
  ok(!g.peek(t).shield, 'сжал кулак — щит опустился');
});

test('джойстик через конвейер кистей: хватка, ведение вправо на экране → moveX > 0, опустить руку → стоп', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })], 33, BODYX);
  let f = g.peek(t);
  ok(f.stick && f.stick.engaged, 'джойстик взят: ' + JSON.stringify(g.getDebug().stick));
  eq(f.moveX, 0, 'в центре стоим');
  // незеркальный кадр: влево = на зеркальном экране вправо
  t = run(g, t, 500, () => [L_AT({ ...SHAPES.fist, cx: 0.62 - 0.16 })], 33, BODYX);
  f = g.peek(t);
  ok(f.moveX > 0.5 && Math.abs(f.moveZ) < 0.3, `moveX=${f.moveX} moveZ=${f.moveZ}`);
  t = run(g, t, 200, () => [L_AT({ ...SHAPES.fist, cy: 0.98 })], 33, BODYX);
  f = g.peek(t);
  ok(f.moveX === 0 && f.moveZ === 0, 'рука на коленях — стоим');
});

test('дёрг левой рукой → dashDir в сторону дёрга (один раз)', () => {
  const g = createHandGestures();
  let t = run(g, 1000, 500, () => [L_AT({ ...SHAPES.fist })], 33, BODYX);
  const t0 = t;
  const dirs = [];
  t = run(g, t, 600, (tt) => { const f = g.read(tt); if (f.dashDir) dirs.push(f.dashDir); const k = Math.min(1, (tt - t0) / 100); return [L_AT({ ...SHAPES.fist, cx: 0.62 - 0.2 * k })]; }, 33, BODYX);
  eq(dirs.length, 1, 'рывков ' + dirs.length);
  ok(dirs[0].x > 0.8, 'вправо на экране: ' + JSON.stringify(dirs[0]));
});

test('производительность: push()+read() на кадр', () => {
  const g = createHandGestures();
  const frames = Array.from({ length: 60 }, (_, i) => [makeHand({ ...SHAPES.open, cx: 0.35 + i * 0.001 }), makeHand({ ...SHAPES.fist, side: 'left', cx: 0.65 })]);
  const t0 = performance.now();
  for (let i = 0; i < 3000; i++) { g.push(obsOf(1000 + i * 33, frames[i % 60])); g.read(1000 + i * 33); }
  const us = ((performance.now() - t0) / 3000) * 1000;
  results.push(`     (push+read: ${us.toFixed(1)} мкс/кадр на 2 кисти)`);
  ok(us < 500, `слишком медленно: ${us} мкс`);
});

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
