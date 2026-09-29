// ASHEN OATH — [HERO] ткань плаща: симуляция Verlet на CPU (сетка ~13×18 частиц, ≈0,1 мс на шаг).
// Верхний ряд прибит к кости груди (плечи и загривок), остальное висит и падает под тяжестью:
//   связи растяжения, сдвига и изгиба; сопротивление воздуха (на бегу плащ развевается назад) и порывы ветра;
//   капсулы тела (таз, грудь, бёдра, голени, плечи) — ткань не проходит сквозь ноги и корпус;
//   плоскость «за спиной» — плащ не заворачивается между ног вперёд; пол.
// Отрисовка — сетка в 3 раза гуще по ширине и в 2 по длине (Catmull-Rom), складки-плиссе вдоль нормали.
// Частицы живут в мировых координатах (инерция естественная); меш — ребёнок обёртки героя.
//
// createCloth(THREE, { cols, rows, rest, anchor, parent, colliders, fwd, material, pleats, lod })
//   rest — Float32Array мировых позиций частиц (строка 0 — верх), anchor — кость, к которой прибит верх,
//   colliders — [{ a, b, r }] (кости-концы отрезка и радиус, м), fwd() → мировой вектор «вперёд» героя.
//   → { mesh, update(dt, lod), reset(), setWind(k), dispose() }

const H = 1 / 60;                 // шаг симуляции
const G = -9.8;

export function createCloth(THREE, o) {
  const { cols, rows, rest, anchor, parent, colliders = [], material, pleats = 3.5, pleatDepth = 0.014 } = o;
  const N = cols * rows;
  const P = new Float32Array(N * 3), Q = new Float32Array(N * 3), W = new Float32Array(N), L = new Float32Array(N * 3);
  const m4 = new THREE.Matrix4(), v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), f = new THREE.Vector3();
  anchor.updateWorldMatrix(true, false);
  m4.copy(anchor.matrixWorld).invert();
  for (let k = 0; k < N; k++) {
    v.fromArray(rest, k * 3);
    P[k * 3] = Q[k * 3] = v.x; P[k * 3 + 1] = Q[k * 3 + 1] = v.y; P[k * 3 + 2] = Q[k * 3 + 2] = v.z;
    v.applyMatrix4(m4); v.toArray(L, k * 3);
    const j = Math.floor(k / cols);
    W[k] = j === 0 ? 0 : 1;
  }
  // связи: [i, j] + длина покоя + жёсткость
  const ci = [], cl = [], cs = [];
  const add = (i, j, s) => { ci.push(i, j); cl.push(Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2])); cs.push(s); };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    if (i + 1 < cols) add(k, k + 1, 1);
    if (j + 1 < rows) add(k, k + cols, 1);
    if (i + 1 < cols && j + 1 < rows) { add(k, k + cols + 1, 0.6); add(k + 1, k + cols, 0.6); }
    if (i + 2 < cols) add(k, k + 2, 0.22);
    if (j + 2 < rows) add(k, k + 2 * cols, 0.3);
  }
  const CI = Int32Array.from(ci), CL = Float32Array.from(cl), CS = Float32Array.from(cs), NC = CL.length;

  // ---------------------------------------------------------------- меш (гуще сетки частиц)
  const SU = 3, SV = 2;
  const rc = (cols - 1) * SU + 1, rr = (rows - 1) * SV + 1, RN = rc * rr;
  const geo = new THREE.BufferGeometry();
  const rpos = new Float32Array(RN * 3), ruv = new Float32Array(RN * 2);
  for (let j = 0; j < rr; j++) for (let i = 0; i < rc; i++) { const k = j * rc + i; ruv[k * 2] = i / (rc - 1); ruv[k * 2 + 1] = 1 - j / (rr - 1); }
  const idx = [];
  for (let j = 0; j < rr - 1; j++) for (let i = 0; i < rc - 1; i++) {
    const a0 = j * rc + i, a1 = a0 + 1, b0 = a0 + rc, b1 = b0 + 1;
    idx.push(a0, b0, a1, a1, b0, b1);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(rpos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(RN * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'cape';
  mesh.frustumCulled = false;
  mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh);

  // ---------------------------------------------------------------- шаг симуляции
  let wind = 1, time = 0, acc = 0, lastA = null;
  const segA = [], segB = [], segR = [];
  for (const c of colliders) { segA.push(new THREE.Vector3()); segB.push(new THREE.Vector3()); segR.push(c.r); }
  const fw = new THREE.Vector3(), hipP = new THREE.Vector3();
  function pinTop() {
    const e = anchor.matrixWorld.elements;
    for (let k = 0; k < cols; k++) {
      const x = L[k * 3], y = L[k * 3 + 1], z = L[k * 3 + 2];
      P[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  function rigid() {
    const e = anchor.matrixWorld.elements;
    for (let k = 0; k < N; k++) {
      const x = L[k * 3], y = L[k * 3 + 1], z = L[k * 3 + 2];
      P[k * 3] = Q[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[k * 3 + 1] = Q[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[k * 3 + 2] = Q[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  function collide(k) {
    let x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
    for (let c = 0; c < segA.length; c++) {
      const A = segA[c], B = segB[c], r = segR[c];
      const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z;
      const apx = x - A.x, apy = y - A.y, apz = z - A.z;
      const ab2 = abx * abx + aby * aby + abz * abz;
      let t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (A.x + abx * t), dy = y - (A.y + aby * t), dz = z - (A.z + abz * t);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-5) { x -= fw.x * r; z -= fw.z * r; continue; }
      const s = r / d;
      x = A.x + abx * t + dx * s; y = A.y + aby * t + dy * s; z = A.z + abz * t + dz * s;
    }
    // за спиной: ниже груди ткань не уходит вперёд за середину корпуса (иначе заворачивается между ног)
    const px = x - hipP.x, pz = z - hipP.z;
    const ahead = px * fw.x + pz * fw.z;
    if (y < hipP.y + backH && ahead > backLim) { x -= fw.x * (ahead - backLim); z -= fw.z * (ahead - backLim); }
    if (y < floorY) { y = floorY; Q[k * 3] += (x - Q[k * 3]) * 0.6; Q[k * 3 + 2] += (z - Q[k * 3 + 2]) * 0.6; }
    P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z;
  }
  let floorY = -1e9, backLim = 0.02, backH = 0.5;
  const DRAG = 2.4, DAMP = 0.992, ITER = 5;
  function step(h, iters) {
    time += h;
    // ветер: слабое дыхание и порывы (м/с), вдоль «назад» героя и чуть вбок
    const gust = (0.35 + 0.35 * Math.sin(time * 0.7) + 0.25 * Math.sin(time * 1.9 + 1.3)) * wind;
    const wx = -fw.x * gust * 0.8 + fw.z * gust * 0.3 * Math.sin(time * 0.5), wz = -fw.z * gust * 0.8 - fw.x * gust * 0.3 * Math.sin(time * 0.5);
    const h2 = h * h;
    for (let k = cols; k < N; k++) {
      const i3 = k * 3;
      const vx = (P[i3] - Q[i3]) * DAMP, vy = (P[i3 + 1] - Q[i3 + 1]) * DAMP, vz = (P[i3 + 2] - Q[i3 + 2]) * DAMP;
      Q[i3] = P[i3]; Q[i3 + 1] = P[i3 + 1]; Q[i3 + 2] = P[i3 + 2];
      const ph = (k % cols) * 0.7 + time * 3.1;
      const flut = Math.sin(ph + Math.floor(k / cols) * 0.45) * 0.6 * wind;
      P[i3] = P[i3] + vx + DRAG * (wx + flut * fw.z * 0.4 - vx / h) * h2;
      P[i3 + 1] = P[i3 + 1] + vy + (G + DRAG * (-vy / h)) * h2;
      P[i3 + 2] = P[i3 + 2] + vz + DRAG * (wz - flut * fw.x * 0.4 - vz / h) * h2;
    }
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < NC; c++) {
        const i = CI[c * 2], j = CI[c * 2 + 1];
        const wi = W[i], wj = W[j], ws = wi + wj;
        if (ws === 0) continue;
        const i3 = i * 3, j3 = j * 3;
        const dx = P[j3] - P[i3], dy = P[j3 + 1] - P[i3 + 1], dz = P[j3 + 2] - P[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const k = ((len - CL[c]) / len) * CS[c] / ws;
        P[i3] += dx * k * wi; P[i3 + 1] += dy * k * wi; P[i3 + 2] += dz * k * wi;
        P[j3] -= dx * k * wj; P[j3 + 1] -= dy * k * wj; P[j3 + 2] -= dz * k * wj;
      }
      for (let k = cols; k < N; k++) collide(k);
    }
  }

  // ---------------------------------------------------------------- отрисовка
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const tmpRow = new Float32Array(rc * rows * 3);
  const inv = new THREE.Matrix4();
  function write() {
    // 1) по ширине в каждом ряду частиц
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < rc; i++) {
        const u = i / SU, i1 = Math.min(cols - 1, Math.floor(u)), t = u - i1;
        const i0 = Math.max(0, i1 - 1), i2 = Math.min(cols - 1, i1 + 1), i3 = Math.min(cols - 1, i1 + 2);
        for (let c = 0; c < 3; c++) {
          tmpRow[(j * rc + i) * 3 + c] = t === 0 ? P[(j * cols + i1) * 3 + c] : cr(P[(j * cols + i0) * 3 + c], P[(j * cols + i1) * 3 + c], P[(j * cols + i2) * 3 + c], P[(j * cols + i3) * 3 + c], t);
        }
      }
    }
    // 2) по длине
    for (let j = 0; j < rr; j++) {
      const vv = j / SV, j1 = Math.min(rows - 1, Math.floor(vv)), t = vv - j1;
      const j0 = Math.max(0, j1 - 1), j2 = Math.min(rows - 1, j1 + 1), j3 = Math.min(rows - 1, j1 + 2);
      for (let i = 0; i < rc; i++) {
        for (let c = 0; c < 3; c++) {
          rpos[(j * rc + i) * 3 + c] = t === 0 ? tmpRow[(j1 * rc + i) * 3 + c] : cr(tmpRow[(j0 * rc + i) * 3 + c], tmpRow[(j1 * rc + i) * 3 + c], tmpRow[(j2 * rc + i) * 3 + c], tmpRow[(j3 * rc + i) * 3 + c], t);
        }
      }
    }
    // мир → оси родителя меша
    parent.updateWorldMatrix(true, false);
    inv.copy(parent.matrixWorld).invert();
    const e = inv.elements;
    for (let k = 0; k < RN; k++) {
      const x = rpos[k * 3], y = rpos[k * 3 + 1], z = rpos[k * 3 + 2];
      rpos[k * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      rpos[k * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      rpos[k * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    geo.computeVertexNormals();
    // складки-плиссе: смещение вдоль нормали, глубже к подолу; затем нормали заново (свет ловит складки)
    if (pleatDepth > 0) {
      const nr = geo.attributes.normal.array;
      const sc = 1 / (parent.getWorldScale(v).x || 1);
      for (let j = 1; j < rr; j++) {
        const t = j / (rr - 1), amp = pleatDepth * sc * (0.25 + 0.75 * t);
        for (let i = 0; i < rc; i++) {
          const u = i / (rc - 1), k = j * rc + i;
          const edge = Math.min(1, Math.min(u, 1 - u) * 8);
          const d = Math.sin(u * Math.PI * 2 * pleats + t * 1.3) * amp * edge;
          rpos[k * 3] += nr[k * 3] * d; rpos[k * 3 + 1] += nr[k * 3 + 1] * d; rpos[k * 3 + 2] += nr[k * 3 + 2] * d;
        }
      }
      geo.computeVertexNormals();
    }
    geo.attributes.position.needsUpdate = true;
  }

  function refresh() {
    anchor.updateWorldMatrix(true, false);
    for (let c = 0; c < colliders.length; c++) {
      colliders[c].a.getWorldPosition(segA[c]);
      colliders[c].b.getWorldPosition(segB[c]);
      if (colliders[c].shift) { segA[c].add(colliders[c].shift(a)); segB[c].add(colliders[c].shift(b)); }
    }
    if (o.fwd) o.fwd(fw); else fw.set(0, 0, 1);
    fw.y = 0; fw.normalize();
    if (o.hips) { o.hips.getWorldPosition(hipP); }
    if (o.floor) floorY = o.floor() + 0.015;
    if (o.back) { backLim = o.back.lim; backH = o.back.h; }
  }

  function update(dt, lod = 0) {
    if (!(dt > 0)) return;
    refresh();
    // телепорт или долгий разрыв кадров — сразу в покой
    const ax = anchor.matrixWorld.elements[12], az = anchor.matrixWorld.elements[14];
    const jump = lastA ? Math.hypot(ax - lastA[0], az - lastA[1]) : 0;
    lastA = [ax, az];
    if (lod >= 2 || jump > 3 || dt > 0.5) { rigid(); acc = 0; write(); return; }
    acc = Math.min(acc + dt, H * 4);
    const iters = lod >= 1 ? 3 : ITER;
    let n = 0;
    while (acc >= H && n < 4) {
      // верхний ряд — по положению кости, интерполируя внутри кадра (плавнее при низком fps)
      pinTop();
      step(H, iters);
      acc -= H; n++;
    }
    write();
  }
  function reset() { refresh(); rigid(); acc = 0; write(); }
  reset();
  // осадка: ткань ложится на спину до первого кадра
  for (let i = 0; i < 120; i++) { pinTop(); step(H, ITER); }
  write();

  return {
    mesh, update, reset,
    setWind(k) { wind = k; },
    get particles() { return P; },
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); },
  };
}

// ---------------------------------------------------------------- пряди волос
// Каждая прядь — цепочка частиц (первые pin прибиты к кости головы), связи соседей и через одну
// (изгиб), капсулы тела и головы. Отрисовка — «локон»: трубка с эллиптическим сечением (плоской
// стороной к телу), сужается к кончику; все пряди — один меш и один вызов отрисовки.
// createStrands(THREE, { locks, anchor, parent, colliders, material, spine })
//   locks: [{ pts: Vector3[] (мир, от корня), pin, r0, r1, flat, seed, tone }]
//   spine: [a, b] — кости оси тела (шея, таз): от неё считается «наружу» для плоской стороны локона.
export function createStrands(THREE, o) {
  const { locks, anchor, parent, colliders = [], material, spine = null, drag = 1.6 } = o;
  const LK = [];
  let N = 0;
  for (const lk of locks) { LK.push({ s: N, n: lk.pts.length, pin: Math.min(lk.pts.length, lk.pin ?? 2), lk }); N += lk.pts.length; }
  const P = new Float32Array(N * 3), Q = new Float32Array(N * 3), W = new Float32Array(N), L = new Float32Array(N * 3), R = new Float32Array(N);
  anchor.updateWorldMatrix(true, false);
  const inv0 = new THREE.Matrix4().copy(anchor.matrixWorld).invert();
  const v = new THREE.Vector3();
  const ci = [], cl = [], cs = [];
  for (const k of LK) {
    for (let i = 0; i < k.n; i++) {
      const g = k.s + i;
      v.copy(k.lk.pts[i]); v.toArray(P, g * 3); v.toArray(Q, g * 3);
      v.applyMatrix4(inv0); v.toArray(L, g * 3);
      W[g] = i < k.pin ? 0 : 1;
      R[g] = (k.lk.r0 ?? 0.015) * (1 - i / Math.max(1, k.n - 1)) + (k.lk.r1 ?? 0.006) * (i / Math.max(1, k.n - 1));
      const d = (a, b) => k.lk.pts[a].distanceTo(k.lk.pts[b]);
      if (i + 1 < k.n) { ci.push(g, g + 1); cl.push(d(i, i + 1)); cs.push(1); }
      if (i + 2 < k.n) { ci.push(g, g + 2); cl.push(d(i, i + 2)); cs.push(k.lk.stiff ?? 0.35); }
    }
  }
  const CI = Int32Array.from(ci), CL = Float32Array.from(cl), CS = Float32Array.from(cs), NC = CL.length;
  // меш: на каждую прядь SS точек оси × RU вершин сечения
  const SUB = 3, RU = 8;
  const rings = LK.map((k) => (k.n - 1) * SUB + 1);
  let RV = 0; for (const r of rings) RV += r * (RU + 1);
  const pos = new Float32Array(RV * 3), nrm = new Float32Array(RV * 3), uv = new Float32Array(RV * 2), col = new Float32Array(RV * 3);
  const idx = [];
  let base = 0;
  LK.forEach((k, li) => {
    const nr = rings[li], seed = k.lk.seed ?? li * 0.37, tone = k.lk.tone ?? 1;
    for (let j = 0; j < nr; j++) {
      const t = j / (nr - 1);
      for (let i = 0; i <= RU; i++) {
        const q = base + j * (RU + 1) + i;
        uv[q * 2] = (i / RU) * 0.5 + (seed % 1) * 0.5; uv[q * 2 + 1] = t * (k.lk.vScale ?? 1.5) + seed;
        // корни темнее (тень под капюшоном), кончики светлее, у каждой пряди свой тон
        const c = tone * (0.62 + 0.45 * Math.min(1, t * 1.6)) * (0.97 + 0.04 * Math.sin(i * 2.1 + seed * 9));
        col[q * 3] = col[q * 3 + 1] = col[q * 3 + 2] = c;
        if (j < nr - 1 && i < RU) { const a = q, b = q + RU + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      }
    }
    k.rb = base; k.nr = nr;
    base += nr * (RU + 1);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'hair-mesh'; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh);

  const segA = colliders.map(() => new THREE.Vector3()), segB = colliders.map(() => new THREE.Vector3());
  const spA = new THREE.Vector3(), spB = new THREE.Vector3();
  let acc = 0, time = 0, wind = 1, lastA = null;
  const HH = 1 / 60;
  function pin() {
    const e = anchor.matrixWorld.elements;
    for (let g = 0; g < N; g++) {
      if (W[g] !== 0) continue;
      const x = L[g * 3], y = L[g * 3 + 1], z = L[g * 3 + 2];
      P[g * 3] = e[0] * x + e[4] * y + e[8] * z + e[12]; P[g * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; P[g * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  function rigid() {
    const e = anchor.matrixWorld.elements;
    for (let g = 0; g < N; g++) {
      const x = L[g * 3], y = L[g * 3 + 1], z = L[g * 3 + 2];
      P[g * 3] = Q[g * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[g * 3 + 1] = Q[g * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[g * 3 + 2] = Q[g * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
  }
  function step(h, iters) {
    time += h;
    const h2 = h * h;
    for (let g = 0; g < N; g++) {
      if (W[g] === 0) continue;
      const i3 = g * 3;
      const vx = (P[i3] - Q[i3]) * 0.985, vy = (P[i3 + 1] - Q[i3 + 1]) * 0.985, vz = (P[i3 + 2] - Q[i3 + 2]) * 0.985;
      Q[i3] = P[i3]; Q[i3 + 1] = P[i3 + 1]; Q[i3 + 2] = P[i3 + 2];
      const wv = Math.sin(time * 1.7 + g * 0.9) * 0.25 * wind;
      P[i3] += vx + drag * (wv - vx / h) * h2;
      P[i3 + 1] += vy + (-9.8 - drag * vy / h) * h2;
      P[i3 + 2] += vz + drag * (wv * 0.6 - vz / h) * h2;
    }
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < NC; c++) {
        const i = CI[c * 2], j = CI[c * 2 + 1], wi = W[i], wj = W[j], ws = wi + wj;
        if (ws === 0) continue;
        const i3 = i * 3, j3 = j * 3;
        const dx = P[j3] - P[i3], dy = P[j3 + 1] - P[i3 + 1], dz = P[j3 + 2] - P[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-9) continue;
        const k = ((len - CL[c]) / len) * CS[c] / ws;
        P[i3] += dx * k * wi; P[i3 + 1] += dy * k * wi; P[i3 + 2] += dz * k * wi;
        P[j3] -= dx * k * wj; P[j3 + 1] -= dy * k * wj; P[j3 + 2] -= dz * k * wj;
      }
      for (let g = 0; g < N; g++) {
        if (W[g] === 0) continue;
        let x = P[g * 3], y = P[g * 3 + 1], z = P[g * 3 + 2];
        for (let c = 0; c < colliders.length; c++) {
          const A = segA[c], B = segB[c], r = colliders[c].r + R[g] * 0.7;
          const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z, ab2 = abx * abx + aby * aby + abz * abz;
          let t = ab2 > 1e-9 ? ((x - A.x) * abx + (y - A.y) * aby + (z - A.z) * abz) / ab2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = A.x + abx * t, cy = A.y + aby * t, cz = A.z + abz * t;
          const dx = x - cx, dy = y - cy, dz = z - cz, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r * r || d2 < 1e-12) continue;
          const s = r / Math.sqrt(d2);
          x = cx + dx * s; y = cy + dy * s; z = cz + dz * s;
        }
        P[g * 3] = x; P[g * 3 + 1] = y; P[g * 3 + 2] = z;
      }
    }
  }
  // отрисовка: ось — Catmull-Rom по частицам, сечение — эллипс (плоская сторона — к оси тела)
  const inv = new THREE.Matrix4(), c0 = new THREE.Vector3(), c1 = new THREE.Vector3(), T = new THREE.Vector3(), O = new THREE.Vector3(), S = new THREE.Vector3(), tmp = new THREE.Vector3();
  const axisPts = [];
  const crp = (k, u, out) => {
    const f = u * (k.n - 1), i1 = Math.min(k.n - 2, Math.floor(f)), t = f - i1;
    const at = (i) => k.s + Math.max(0, Math.min(k.n - 1, i));
    const i0 = at(i1 - 1), a1 = at(i1), a2 = at(i1 + 1), a3 = at(i1 + 2);
    const t2 = t * t, t3 = t2 * t;
    for (let c = 0; c < 3; c++) {
      const p0 = P[i0 * 3 + c], p1 = P[a1 * 3 + c], p2 = P[a2 * 3 + c], p3 = P[a3 * 3 + c];
      out.setComponent(c, 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
    }
    return out;
  };
  function write() {
    parent.updateWorldMatrix(true, false);
    inv.copy(parent.matrixWorld).invert();
    const sc = 1 / (parent.getWorldScale(tmp).x || 1);
    if (spine) { spine[0].getWorldPosition(spA); spine[1].getWorldPosition(spB); }
    for (const k of LK) {
      if (k.lk.static && k.done) continue;
      k.done = true;
      const nr = k.nr, flat = k.lk.flat ?? 0.45, taper = k.lk.taper ?? 0.92;
      axisPts.length = 0;
      for (let j = 0; j < nr; j++) axisPts.push(crp(k, j / (nr - 1), new THREE.Vector3()));
      for (let j = 0; j < nr; j++) {
        const t = j / (nr - 1);
        c0.copy(axisPts[j]);
        c1.copy(axisPts[Math.min(nr - 1, j + 1)]).sub(axisPts[Math.max(0, j - 1)]);
        T.copy(c1).normalize();
        // «наружу» — от оси тела (шея → таз), по горизонтали
        if (spine) {
          const abx = spB.x - spA.x, aby = spB.y - spA.y, abz = spB.z - spA.z, ab2 = abx * abx + aby * aby + abz * abz;
          let tt = ((c0.x - spA.x) * abx + (c0.y - spA.y) * aby + (c0.z - spA.z) * abz) / Math.max(1e-9, ab2);
          tt = Math.max(0, Math.min(1, tt));
          O.set(c0.x - (spA.x + abx * tt), 0, c0.z - (spA.z + abz * tt));
        } else O.set(0, 0, 1);
        O.addScaledVector(T, -O.dot(T));
        if (O.lengthSq() < 1e-10) O.set(1, 0, 0).addScaledVector(T, -T.x);
        O.normalize();
        S.crossVectors(T, O).normalize();
        const r0 = k.lk.r0 ?? 0.015, r1 = k.lk.r1 ?? 0.006;
        let r = r0 + (r1 - r0) * t;
        r *= (0.55 + 0.45 * Math.min(1, t * 6)) * (1 - taper * Math.pow(Math.max(0, (t - 0.72) / 0.28), 1.6));
        for (let i = 0; i <= RU; i++) {
          const a = (i / RU) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const q = k.rb + j * (RU + 1) + i;
          tmp.copy(c0).addScaledVector(S, ca * r).addScaledVector(O, sa * r * flat).applyMatrix4(inv);
          pos[q * 3] = tmp.x; pos[q * 3 + 1] = tmp.y; pos[q * 3 + 2] = tmp.z;
          tmp.copy(S).multiplyScalar(ca * flat).addScaledVector(O, sa).normalize().transformDirection(inv);
          nrm[q * 3] = tmp.x; nrm[q * 3 + 1] = tmp.y; nrm[q * 3 + 2] = tmp.z;
        }
      }
    }
    void sc;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
  }
  function refresh() {
    anchor.updateWorldMatrix(true, false);
    for (let c = 0; c < colliders.length; c++) { colliders[c].a.getWorldPosition(segA[c]); colliders[c].b.getWorldPosition(segB[c]); }
  }
  function update(dt, lod = 0) {
    if (!(dt > 0)) return;
    refresh();
    const ax = anchor.matrixWorld.elements[12], az = anchor.matrixWorld.elements[14];
    const jump = lastA ? Math.hypot(ax - lastA[0], az - lastA[1]) : 0;
    lastA = [ax, az];
    if (lod >= 2 || jump > 3 || dt > 0.5) { rigid(); acc = 0; write(); return; }
    acc = Math.min(acc + dt, HH * 4);
    let n = 0;
    while (acc >= HH && n < 4) { pin(); step(HH, lod >= 1 ? 2 : 4); acc -= HH; n++; }
    write();
  }
  refresh(); rigid();
  // осадка: пряди ложатся на грудь и спину до первого кадра
  for (let i = 0; i < 90; i++) { pin(); step(HH, 4); }
  write();
  return {
    mesh, update, setWind(k) { wind = k; },
    reset() { refresh(); rigid(); write(); },
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); },
  };
}

// Радиусы капсул по коже модели: вершины, ближайшие к отрезку кости (из списка), — 80-й процентиль расстояний.
// segs: [{ a, b }] (мировые позиции концов) → радиусы в метрах (мир).
export function fitCapsules(THREE, root, segs, { step = 3, pct = 0.8, minR = 0.04, maxR = 0.3 } = {}) {
  const dists = segs.map(() => []);
  const v = new THREE.Vector3();
  const segDist = (p, A, B) => {
    const ab = B.clone().sub(A), t = Math.max(0, Math.min(1, p.clone().sub(A).dot(ab) / Math.max(1e-9, ab.lengthSq())));
    return { d: p.distanceTo(A.clone().addScaledVector(ab, t)), t };
  };
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible || !o.geometry.attributes.position) return;
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i += step) {
      o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld);
      let best = -1, bd = 1e9, bt = 0;
      for (let s = 0; s < segs.length; s++) { const r = segDist(v, segs[s].a, segs[s].b); if (r.d < bd) { bd = r.d; best = s; bt = r.t; } }
      if (best >= 0 && bt > 0.05 && bt < 0.95) dists[best].push(bd);
    }
  });
  return dists.map((d) => {
    if (d.length < 20) return null;
    d.sort((x, y) => x - y);
    return Math.max(minR, Math.min(maxR, d[Math.floor(d.length * pct)]));
  });
}
