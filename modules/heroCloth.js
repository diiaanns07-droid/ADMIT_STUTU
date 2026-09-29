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

  return {
    mesh, update, reset,
    setWind(k) { wind = k; },
    get particles() { return P; },
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
