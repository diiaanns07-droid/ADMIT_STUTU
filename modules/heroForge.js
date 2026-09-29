// ASHEN OATH — [HERO] кузница: процедурная геометрия оружия и снаряжения героев в духе BDO и
// процедурные текстуры (вышитая кайма и герб плаща). Без внешних файлов.
//   buildStaff — резной витой посох: кованый наконечник, кожаная обмотка рукояти, узорные кольца,
//                навершие 'crown' (языки пламени-когти), 'crescent' (полумесяц), 'hoop' (кольцо бури),
//                огранённый кристалл с ядром света, руническое кольцо и осколки на орбите;
//   buildBow   — рекурсивный лук: плечи-лопасти сечением «суперэллипс», рукоять с обмоткой, крылья-клинки,
//                накладки, светящиеся руны вдоль плеч, наконечники с камнями;
//   buildArrow, buildQuiver, capeTextures.
// Ось посоха — +y, хват (центр кулака) в начале координат. Лук: плечи по ±y, тетива на стороне +z
// (к лучнику), рукоять (кулак) в начале координат, полка стрелы — сторона −x.
//
// M — материалы из heroGear: { wood, metal, trim, leather, glow, crystal, inlay }.

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- геометрия
// Параметрическая поверхность: fn(u, v, out) — u по окружности (0..1, замкнуто) или по ширине, v — вдоль.
// Нормаль = ∂u × ∂v (центральные разности); у лейта (x = r·cos, z = −r·sin) она смотрит наружу.
export function surface(THREE, fn, nu, nv, { closedU = true } = {}) {
  const cols = nu + 1, rows = nv + 1, N = cols * rows;
  const pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), uvs = new Float32Array(N * 2);
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  const e = 5e-4;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const u = i / nu, v = j / nv, k = j * cols + i;
    fn(u, v, p);
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    const nrmAt = (vv) => {
      const u0 = closedU ? u - e : Math.max(0, u - e), u1 = closedU ? u + e : Math.min(1, u + e);
      fn(u1, vv, a); fn(u0, vv, b); a.sub(b);
      fn(u, Math.min(1, vv + e), c); fn(u, Math.max(0, vv - e), d); c.sub(d);
      return a.cross(c);
    };
    let n = nrmAt(v);
    if (n.lengthSq() < 1e-18) n = nrmAt(v < 0.5 ? v + 0.03 : v - 0.03);
    n.normalize();
    nrm[k * 3] = n.x; nrm[k * 3 + 1] = n.y; nrm[k * 3 + 2] = n.z;
    uvs[k * 2] = u; uvs[k * 2 + 1] = v;
  }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a0 = j * cols + i, a1 = a0 + 1, b0 = a0 + cols, b1 = b0 + 1;
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// Тело вращения: prof(v) → [r, y] (y растёт с v), mod(θ, v, y) — множитель радиуса (резьба).
export function lathe(THREE, prof, nv, nu = 16, mod = null) {
  return surface(THREE, (u, v, out) => {
    const [r0, y] = prof(v);
    const th = u * TAU;
    const r = mod ? r0 * mod(th, v, y) : r0;
    out.set(r * Math.cos(th), y, -r * Math.sin(th));
  }, nu, nv);
}
// Тело вращения по списку точек [r, y] (ломаная, плавная по Catmull-Rom).
export function latheFromPoints(THREE, pts, nu = 16, sub = 4) {
  const n = pts.length - 1;
  const at = (i) => pts[Math.max(0, Math.min(n, i))];
  return lathe(THREE, (v) => {
    const f = v * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const cr = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t);
    return [Math.max(0, cr(0)), cr(1)];
  }, n * sub, nu);
}

// Трубка вдоль кривой с переменным радиусом rFn(v) (и сплющиванием flat: 1 — круг).
export function tube(THREE, curve, nv, nu, rFn, { flat = 1 } = {}) {
  const fr = curve.computeFrenetFrames(nv, false);
  const cols = nu + 1, rows = nv + 1;
  const pos = new Float32Array(cols * rows * 3), nrm = new Float32Array(cols * rows * 3), uvs = new Float32Array(cols * rows * 2);
  const P = new (curve.getPointAt(0).constructor)();
  for (let j = 0; j < rows; j++) {
    const v = j / nv;
    curve.getPointAt(v, P);
    const N = fr.normals[j], B = fr.binormals[j];
    const r = rFn(v);
    for (let i = 0; i < cols; i++) {
      const th = (i / nu) * TAU, c = Math.cos(th), s = Math.sin(th);
      const k = j * cols + i;
      pos[k * 3] = P.x + (N.x * c + B.x * s * flat) * r;
      pos[k * 3 + 1] = P.y + (N.y * c + B.y * s * flat) * r;
      pos[k * 3 + 2] = P.z + (N.z * c + B.z * s * flat) * r;
      let nx = N.x * c * flat + B.x * s, ny = N.y * c * flat + B.y * s, nz = N.z * c * flat + B.z * s;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      nrm[k * 3] = nx; nrm[k * 3 + 1] = ny; nrm[k * 3 + 2] = nz;
      uvs[k * 2] = i / nu; uvs[k * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a0 = j * cols + i, a1 = a0 + 1, b0 = a0 + cols, b1 = b0 + 1;
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// Огранённый камень (плоские грани): павильон, рундист, корона и площадка. n — число граней.
export function gem(THREE, { r = 0.04, h = 0.16, n = 8, crown = 0.2, table = 0.35 } = {}) {
  const V = [];
  const ring = (y, rad, off) => Array.from({ length: n }, (_, i) => { const a = ((i + off) / n) * TAU; return [Math.cos(a) * rad, y, -Math.sin(a) * rad]; });
  const bottom = [0, -h * 0.55, 0], top = [0, h * 0.45, 0];
  const g0 = ring(0, r, 0), g1 = ring(h * crown, r * 0.78, 0.5), g2 = ring(h * 0.45 - 0.0001, r * table, 0);
  const tri = (a, b, c) => V.push(...a, ...b, ...c);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(bottom, g0[j], g0[i]);             // павильон
    tri(g0[i], g0[j], g1[i]);              // корона: нижние треугольники
    tri(g1[i], g0[j], g1[j]);
    tri(g1[i], g1[j], g2[j]);              // к площадке
    tri(g1[i], g2[j], g2[i]);
    tri(g2[i], g2[j], top);                // площадка (почти плоская)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
  g.computeVertexNormals();
  const uv = new Float32Array((V.length / 3) * 2);
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Лист/клинок: плоская фигура по контуру (ExtrudeGeometry с фаской).
function bladeGeo(THREE, len, wid, depth = 0.004, curve = 0.3) {
  const s = new THREE.Shape();
  s.moveTo(0, -wid * 0.5);
  s.bezierCurveTo(len * 0.35, -wid * 0.75, len * 0.7, -wid * (0.3 - curve * 0.4), len, wid * curve);
  s.bezierCurveTo(len * 0.72, wid * (0.4 + curve * 0.3), len * 0.35, wid * 0.62, 0, wid * 0.5);
  s.lineTo(0, -wid * 0.5);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.6, bevelSize: Math.min(wid * 0.18, 0.004), bevelSegments: 2, steps: 1, curveSegments: 10 });
  g.translate(0, 0, -depth / 2);
  return g;
}

// ---------------------------------------------------------------- посох
// S: { style: 'crown' | 'crescent' | 'hoop', bottom, top } → { group, tip, crystal, core, halo, shards }
export function buildStaff(THREE, M, S = {}) {
  const style = S.style || 'crown';
  const bottom = S.bottom ?? -0.64, top = S.top ?? 0.8;   // низ древка и верх древка (хват — в нуле)
  const grp = new THREE.Group(); grp.name = 'staff';
  const add = (g, m, name) => { const o = new THREE.Mesh(g, m); if (name) o.name = name; grp.add(o); return o; };
  // древко: три витые канавки, у рукояти гладкое, к навершию толще
  const rAt = (y) => (y < -0.16 ? lerp(0.0135, 0.0165, sstep(bottom, -0.16, y)) : y < 0.16 ? 0.0165 : lerp(0.0165, 0.0192, sstep(0.16, top, y)));
  const flute = (y) => 1 - sstep(-0.24, -0.16, y) * (1 - sstep(0.16, 0.24, y));
  add(lathe(THREE, (v) => { const y = lerp(bottom + 0.012, top, v); return [rAt(y), y]; }, 150, 18,
    (th, v, y) => 1 + 0.13 * flute(y) * Math.sin(3 * (th + y * TAU * 1.35))), M.wood, 'staff-shaft');
  // обмотка рукояти: кожаный ремень спиралью (плоский)
  const turns = 8.5;
  const helix = new THREE.Curve();
  helix.getPoint = (t, out = new THREE.Vector3()) => out.set(0.0178 * Math.cos(t * turns * TAU), lerp(-0.155, 0.155, t), -0.0178 * Math.sin(t * turns * TAU));
  add(tube(THREE, helix, 170, 6, () => 0.0042, { flat: 0.55 }), M.leather, 'staff-wrap');
  // кольца: бусина — обод — бусина
  const collar = (y, r0, big = 1) => add(latheFromPoints(THREE, [[r0 * 0.98, y - 0.02 * big], [r0 + 0.003 * big, y - 0.018 * big], [r0 + 0.0065 * big, y - 0.011 * big], [r0 + 0.0035 * big, y - 0.006 * big], [r0 + 0.009 * big, y], [r0 + 0.0035 * big, y + 0.006 * big], [r0 + 0.0065 * big, y + 0.011 * big], [r0 + 0.003 * big, y + 0.018 * big], [r0 * 0.98, y + 0.02 * big]], 18, 3), M.trim);
  collar(-0.172, 0.0168); collar(0.172, 0.0168); collar(0.47, rAt(0.47), 0.8); collar(bottom + 0.1, rAt(bottom + 0.1), 0.7);
  // кованый наконечник
  add(latheFromPoints(THREE, [[0.0, bottom - 0.085], [0.004, bottom - 0.078], [0.008, bottom - 0.055], [0.012, bottom - 0.03], [0.0155, bottom - 0.012], [0.0195, bottom], [0.02, bottom + 0.012], [0.016, bottom + 0.02], [0.0145, bottom + 0.028]], 16, 4), M.metal, 'staff-ferrule');
  // навершие: чаша-подставка
  const head = new THREE.Group(); head.position.y = top; grp.add(head);
  const cup = latheFromPoints(THREE, [[0.0185, -0.02], [0.021, 0.0], [0.0245, 0.022], [0.031, 0.042], [0.038, 0.055], [0.042, 0.062], [0.036, 0.067], [0.026, 0.07], [0.012, 0.072]], 20, 4);
  head.add(new THREE.Mesh(cup, M.metal));
  const crystY = style === 'crown' ? 0.165 : 0.2;
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  if (style === 'crown') {
    // пять когтей-языков пламени, закрученных по спирали, обнимают кристалл
    for (let i = 0; i < 5; i++) {
      const a0 = (i / 5) * TAU;
      const pts = [[0.034, 0.058, 0], [0.058, 0.1, 0.25], [0.07, 0.16, 0.5], [0.058, 0.22, 0.75], [0.03, 0.27, 1.0], [0.012, 0.29, 1.15]]
        .map(([r, y, tw]) => P(r * Math.cos(a0 + tw * 0.55), y, -r * Math.sin(a0 + tw * 0.55)));
      const c = new THREE.CatmullRomCurve3(pts);
      head.add(new THREE.Mesh(tube(THREE, c, 36, 7, (v) => lerp(0.0078, 0.0016, v) * (1 + 0.25 * Math.sin(v * 18) * (1 - v))), M.trim));
      // шип на спинке когтя
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.028, 5), M.metal);
      const q = c.getPointAt(0.42), tq = c.getTangentAt(0.42);
      sp.position.copy(q); sp.quaternion.setFromUnitVectors(P(0, 1, 0), P(q.x, 0, q.z).normalize().addScaledVector(tq, 0.4).normalize());
      head.add(sp);
    }
  } else if (style === 'crescent') {
    // большой полумесяц, открытый вверх; снаружи — шипы, внутри — тонкая вторая дуга
    const R = 0.125, cy = 0.2;
    const arc = (r, a0, a1) => { const c = new THREE.Curve(); c.getPoint = (t, out = new THREE.Vector3()) => { const a = lerp(a0, a1, t); return out.set(Math.cos(a) * r, cy + Math.sin(a) * r, 0); }; return c; };
    const A0 = -Math.PI / 2 - 2.55, A1 = -Math.PI / 2 + 2.55;
    head.add(new THREE.Mesh(tube(THREE, arc(R, A0, A1), 80, 8, (v) => lerp(0.0025, 0.012, Math.sin(v * Math.PI) ** 0.7), { flat: 0.55 }), M.trim));
    head.add(new THREE.Mesh(tube(THREE, arc(R * 0.8, A0 + 0.5, A1 - 0.5), 60, 6, (v) => lerp(0.0012, 0.004, Math.sin(v * Math.PI)), { flat: 0.6 }), M.metal));
    for (let i = 0; i < 6; i++) {
      const a = lerp(A0 + 0.45, A1 - 0.45, i / 5);
      if (Math.abs(a + Math.PI / 2) < 0.2) continue;
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.0045, 0.035, 5), M.metal);
      sp.position.set(Math.cos(a) * (R + 0.012), cy + Math.sin(a) * (R + 0.012), 0);
      sp.rotation.z = a - Math.PI / 2;
      head.add(sp);
    }
    // ножка полумесяца к чаше
    head.add(new THREE.Mesh(latheFromPoints(THREE, [[0.022, 0.06], [0.014, 0.068], [0.01, 0.075], [0.012, cy - R + 0.004]], 12, 3), M.metal));
  } else {
    // кольцо бури: вертикальный обод, четыре молнии-зубца наружу, навершие-звезда
    const R = 0.105, cy = 0.2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.0075, 10, 64), M.trim); ring.position.y = cy; head.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(R * 0.86, 0.0022, 6, 64), M.metal); ring2.position.y = cy; head.add(ring2);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * TAU;
      const d = P(Math.cos(a), Math.sin(a), 0), n = P(-Math.sin(a), Math.cos(a), 0);
      const base = P(0, cy, 0).addScaledVector(d, R);
      const pts = [base, base.clone().addScaledVector(d, 0.02).addScaledVector(n, 0.008), base.clone().addScaledVector(d, 0.034).addScaledVector(n, -0.008), base.clone().addScaledVector(d, 0.058)];
      head.add(new THREE.Mesh(tube(THREE, new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1), 20, 5, (v) => lerp(0.0055, 0.0008, v)), M.trim));
    }
    const fin = new THREE.Mesh(new THREE.OctahedronGeometry(0.018, 0), M.trim); fin.scale.set(0.6, 1.6, 0.6); fin.position.y = cy + R + 0.03; head.add(fin);
    head.add(new THREE.Mesh(latheFromPoints(THREE, [[0.022, 0.06], [0.013, 0.07], [0.01, cy - R + 0.004]], 12, 3), M.metal));
  }
  // кристалл: огранённый, вытянутый; внутри — ядро света (для bloom)
  const crystal = new THREE.Mesh(gem(THREE, { r: style === 'crown' ? 0.036 : 0.034, h: style === 'crown' ? 0.19 : 0.17, n: 8 }), M.crystal);
  crystal.name = 'staff-crystal'; crystal.position.y = crystY; head.add(crystal);
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.017, 1), M.core); core.name = 'staff-core'; core.position.y = crystY; head.add(core);
  // руническое кольцо (плоское, крутится) и осколки на орбите
  const halo = new THREE.Group(); halo.name = 'staff-halo'; halo.position.y = crystY; head.add(halo);
  const rg = new THREE.RingGeometry(0.068, 0.088, 64, 1);
  { const uv = rg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, (k % 65) / 64 * 6, Math.floor(k / 65)); } // полярная развёртка: руны по кругу
  const hr = new THREE.Mesh(rg, M.runeRing); hr.rotation.x = -Math.PI / 2; hr.name = 'staff-halo-ring'; halo.add(hr);
  const shards = new THREE.Group(); shards.name = 'staff-shards'; shards.position.y = crystY; head.add(shards);
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(gem(THREE, { r: 0.0075, h: 0.03, n: 5 }), M.crystal);
    const a = (i / 3) * TAU;
    s.position.set(Math.cos(a) * 0.1, (i - 1) * 0.02, -Math.sin(a) * 0.1);
    s.rotation.set(0.3 * i, a, 0.2);
    shards.add(s);
  }
  const tip = new THREE.Object3D(); tip.name = 'staff-tip'; tip.position.y = crystY; head.add(tip);
  // звёздный блик кристалла (спрайт, аддитивно): мерцает и медленно вращается
  let glint = null;
  const gt = glintTexture(THREE);
  if (gt && M.glint) {
    glint = new THREE.Sprite(M.glint); glint.name = 'staff-glint'; glint.scale.setScalar(0.2); glint.position.y = crystY + 0.02; head.add(glint);
  }
  return { group: grp, tip, crystal, core, halo, shards, glint, top, length: top - bottom + 0.3 };
}

// ---------------------------------------------------------------- лук
// B: { len (от кончика до кончика), brace (тетива от рукояти) } →
//   { group, tipT, tipB, nockRest, rest (полка стрелы), inlays[] }
export function buildBow(THREE, M, B = {}) {
  const L = B.len || 1.3, brace = B.brace || 0.17;
  const grp = new THREE.Group(); grp.name = 'bow';
  const add = (g, m, parent = grp) => { const o = new THREE.Mesh(g, m); parent.add(o); return o; };
  const half = L / 2, RY = 0.13;
  // ось плеча в плоскости y–z: от рукояти назад к лучнику, у кончика — загиб вперёд (рекурв)
  const yz = [[RY - 0.01, 0.012], [RY + 0.1, 0.04], [RY + 0.24, 0.1], [RY + 0.37, 0.158], [half - 0.07, 0.196], [half - 0.02, 0.19], [half, 0.16]];
  for (const sg of [1, -1]) {
    const pts = yz.map(([y, z]) => new THREE.Vector3(0, sg * y, z));
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const W = (s) => lerp(0.042, 0.013, s ** 0.85), T = (s) => lerp(0.021, 0.0085, s);
    const X = new THREE.Vector3(1, 0, 0), Pp = new THREE.Vector3(), Tt = new THREE.Vector3(), Nn = new THREE.Vector3();
    // сечение: суперэллипс (плоское плечо со скруглёнными кромками)
    const limb = surface(THREE, (u, v, out) => {
      c.getPointAt(v, Pp); c.getTangentAt(v, Tt);
      Nn.crossVectors(Tt, X).normalize(); // в плоскости y–z, поперёк плеча
      const th = u * TAU, cs = Math.cos(th), sn = Math.sin(th);
      const ex = Math.sign(cs) * Math.abs(cs) ** 0.55, ez = Math.sign(sn) * Math.abs(sn) ** 0.55;
      out.copy(Pp).addScaledVector(X, ex * W(v) * 0.5 * sg).addScaledVector(Nn, ez * T(v) * 0.5);
    }, 12, 40);
    add(limb, M.wood);
    // руническая вставка по спинке плеча (сторона −z, к цели): узкая светящаяся полоса
    const inlay = surface(THREE, (u, v, out) => {
      const s = lerp(0.06, 0.78, v);
      c.getPointAt(s, Pp); c.getTangentAt(s, Tt);
      Nn.crossVectors(Tt, X).normalize();
      const back = Nn.z < 0 ? 1 : -1;
      out.copy(Pp).addScaledVector(X, (u - 0.5) * W(s) * 0.32).addScaledVector(Nn, back * (T(s) * 0.5 + 0.0009));
    }, 2, 24, { closedU: false });
    add(inlay, M.inlay).name = 'bow-inlay';
    // наконечник плеча: кованый колпак и камень
    const tp = c.getPointAt(1), tt = c.getTangentAt(1);
    const cap = add(new THREE.ConeGeometry(0.0085, 0.05, 7), M.trim);
    cap.position.copy(tp).addScaledVector(tt, 0.012); cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tt);
    const g2 = add(gem(THREE, { r: 0.0055, h: 0.018, n: 5 }), M.crystal);
    g2.position.copy(c.getPointAt(0.93)).add(new THREE.Vector3(0, 0, -0.012 * 1)); g2.rotation.x = Math.PI / 2;
    // накладка у рукояти: кольцо-обойма
    const band = add(new THREE.TorusGeometry(1, 0.12, 6, 20), M.trim);
    const bp = c.getPointAt(0.03), bt = c.getTangentAt(0.03);
    band.position.copy(bp); band.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), bt); band.scale.set(0.024, 0.014, 0.014);
    // крыло-клинок на спинке (к цели), изогнутое наружу
    const wing = add(bladeGeo(THREE, 0.2, 0.035, 0.004, 0.45), M.metal);
    wing.position.set(0, sg * (RY - 0.02), -0.028);
    wing.rotation.set(0, Math.PI / 2, sg > 0 ? Math.PI / 2 + 0.55 : -Math.PI / 2 - 0.55);
    wing.scale.set(1, sg > 0 ? 1 : -1, 1);
  }
  // рукоять: овальное сечение, спинка выпуклая к цели
  const riser = surface(THREE, (u, v, out) => {
    const y = lerp(-RY, RY, v), th = u * TAU;
    const k = 1 - 0.18 * Math.exp(-((y / 0.05) ** 2));        // талия под кулак
    const rx = 0.0165 * k, rz = 0.026 * (1 + 0.25 * Math.exp(-((y / 0.07) ** 2)));
    const zc = -0.006 - 0.012 * Math.exp(-((y / 0.08) ** 2));
    out.set(rx * Math.cos(th), y, zc - rz * Math.sin(th));
  }, 16, 24);
  add(riser, M.wood);
  // обмотка рукояти
  const wrap = surface(THREE, (u, v, out) => {
    const y = lerp(-0.058, 0.058, v), th = u * TAU;
    const k = 1 - 0.18 * Math.exp(-((y / 0.05) ** 2));
    const rx = 0.0185 * k, rz = 0.0285 * (1 + 0.25 * Math.exp(-((y / 0.07) ** 2)));
    const zc = -0.006 - 0.012 * Math.exp(-((y / 0.08) ** 2));
    const rib = 1 + 0.06 * Math.max(0, Math.sin(v * TAU * 7 + th));
    out.set(rx * rib * Math.cos(th), y, zc - rz * rib * Math.sin(th));
  }, 16, 40);
  add(wrap, M.leather);
  // камень на спинке рукояти
  const sg0 = add(gem(THREE, { r: 0.011, h: 0.03, n: 6 }), M.crystal); sg0.position.set(0, 0.0, -0.05); sg0.rotation.x = -Math.PI / 2;
  const tipT = new THREE.Vector3(0, half - 0.012, 0.172), tipB = new THREE.Vector3(0, -half + 0.012, 0.172);
  const nockRest = new THREE.Vector3(0, 0, 0.172);
  const rest = new THREE.Vector3(-0.02, 0.07, -0.012);   // полка стрелы: над кулаком, со стороны −x
  void brace;
  return { group: grp, tipT, tipB, nockRest, rest };
}

// Стрела: от хвостовика (0) вдоль +y к острию (len).
export function buildArrow(THREE, M, { len = 0.78, fletch = 0xe8e1cf } = {}) {
  const grp = new THREE.Group(); grp.name = 'arrow';
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0034, 0.0034, len - 0.06, 6), M.wood); shaft.position.y = (len - 0.06) / 2 + 0.01; grp.add(shaft);
  const nock = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0036, 0.018, 6), M.trim); nock.position.y = 0.009; grp.add(nock);
  const head = new THREE.Mesh(bladeGeo(THREE, 0.06, 0.022, 0.0025, 0.0), M.metal); head.rotation.z = Math.PI / 2; head.position.y = len - 0.062; grp.add(head);
  const fm = M.fletch || M.leather;
  void fletch;
  const vane = new THREE.Shape(); vane.moveTo(0, 0); vane.bezierCurveTo(0.004, 0.03, 0.018, 0.08, 0.02, 0.1); vane.lineTo(0.004, 0.11); vane.lineTo(0, 0.1); vane.lineTo(0, 0);
  const vg = new THREE.ShapeGeometry(vane, 6);
  for (let i = 0; i < 3; i++) {
    const v = new THREE.Mesh(vg, fm); v.position.y = 0.03; v.rotation.y = (i / 3) * TAU; grp.add(v);
  }
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0042, 0.012, 6), M.trim); band.position.y = 0.15; grp.add(band);
  return grp;
}

// Колчан: кожаный тубус с коваными ободами, гербом и стрелами. Ось +y, дно в нуле.
export function buildQuiver(THREE, M, { h = 0.52, arrows = 8 } = {}) {
  const grp = new THREE.Group(); grp.name = 'quiver';
  const body = new THREE.Mesh(latheFromPoints(THREE, [[0.0, 0.0], [0.03, 0.003], [0.036, 0.02], [0.04, h * 0.35], [0.046, h * 0.8], [0.05, h], [0.047, h + 0.002]], 16, 5), M.leather);
  body.material.side = 2; grp.add(body);
  for (const [y, r] of [[0.03, 0.037], [h * 0.5, 0.044], [h - 0.012, 0.05]]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0045, 6, 24), M.trim); band.rotation.x = Math.PI / 2; band.position.y = y; grp.add(band);
  }
  const plate = new THREE.Mesh(gem(THREE, { r: 0.014, h: 0.03, n: 6 }), M.crystal); plate.position.set(0, h * 0.62, 0.045); plate.rotation.x = Math.PI / 2; grp.add(plate);
  for (let i = 0; i < arrows; i++) {
    const a = (i / arrows) * TAU + 0.3, rr = 0.012 + 0.014 * ((i * 7) % 3) / 2;
    const ar = buildArrow(THREE, M, { len: 0.7 });
    ar.name = 'quiver-arrow'; // неподвижны — склеиваются с колчаном
    ar.rotation.z = Math.PI; // остриём вниз
    ar.position.set(Math.cos(a) * rr, h + 0.14 + (i % 3) * 0.02, -Math.sin(a) * rr);
    grp.add(ar);
  }
  return grp;
}

// ---------------------------------------------------------------- брошь-эмблема
// Контур эмблемы героя (в пределах радиуса R): 'flame' | 'moon' | 'bolt' | 'leaf'.
export function emblemShape(THREE, kind, R = 0.03) {
  const s = new THREE.Shape();
  const k = R / 60;
  const P = (x, y) => [x * k, -y * k];
  if (kind === 'moon') {
    s.absarc(0, 0, 52 * k, Math.PI * 0.28, Math.PI * 1.72, false);
    s.absarc(18 * k, 0, 42 * k, Math.PI * 1.62, Math.PI * 0.38, true);
  } else if (kind === 'bolt') {
    const pts = [[10, -62], [-26, 4], [-2, 4], [-14, 60], [28, -12], [4, -12]];
    s.moveTo(...P(...pts[0])); for (const p of pts.slice(1)) s.lineTo(...P(...p)); s.closePath();
  } else if (kind === 'leaf') {
    s.moveTo(...P(0, 60)); s.bezierCurveTo(...P(-50, 20), ...P(-40, -40), ...P(0, -62)); s.bezierCurveTo(...P(40, -40), ...P(50, 20), ...P(0, 60));
  } else {
    s.moveTo(...P(0, 58)); s.bezierCurveTo(...P(-46, 30), ...P(-30, -12), ...P(-8, -30)); s.bezierCurveTo(...P(-14, -2), ...P(4, 6), ...P(6, 18));
    s.bezierCurveTo(...P(10, -10), ...P(22, -30), ...P(4, -64)); s.bezierCurveTo(...P(40, -36), ...P(48, 20), ...P(0, 58));
  }
  return s;
}
// Кованая брошь: купол с кантом и бусинами, объёмная эмблема, камень, светящаяся нить. Лицом к +z.
export function buildBrooch(THREE, M, { emblem = 'flame', r = 0.05 } = {}) {
  const grp = new THREE.Group(); grp.name = 'brooch';
  const dome = latheFromPoints(THREE, [[0.0, 0.006], [r * 0.4, 0.0056], [r * 0.75, 0.0042], [r * 0.95, 0.002], [r, 0.0]], 32, 4);
  dome.rotateX(Math.PI / 2);
  grp.add(new THREE.Mesh(dome, M.metal));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0045, 8, 48), M.trim); grp.add(rim);
  const rim2 = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, 0.0016, 6, 48), M.inlay); rim2.position.z = 0.0045; grp.add(rim2);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU, b = new THREE.Mesh(new THREE.SphereGeometry(i % 3 ? 0.0028 : 0.0042, 8, 6), M.trim);
    b.position.set(Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08, 0.002); grp.add(b);
  }
  const eg = new THREE.ExtrudeGeometry(emblemShape(THREE, emblem, r * 0.62), { depth: 0.003, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 16 });
  const em = new THREE.Mesh(eg, M.trim); em.position.z = 0.0068; grp.add(em);
  const g = new THREE.Mesh(gem(THREE, { r: r * 0.13, h: r * 0.26, n: 8 }), M.crystal); g.rotation.x = Math.PI / 2; g.position.set(0, -r * 0.05, 0.0135); grp.add(g);
  return grp;
}

// ---------------------------------------------------------------- текстуры плаща
// Ткань с плетением, вышитая кайма (побеги и ромбы) по краям и подолу, герб на спине.
// → { map (sRGB), bump, emissive } — холсты 512×1024, u поперёк, v сверху вниз.
export function capeTextures(THREE, { base = 0x2a1a17, trim = 0xd8b070, glow = 0xff8a3a, emblem = 'flame', key = '' } = {}) {
  if (typeof document === 'undefined') return {};
  const W = 512, H = 1024;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const col = (hex, k = 1) => { const c = new THREE.Color(hex).multiplyScalar(k); return `rgb(${Math.round(Math.min(1, c.r) * 255)},${Math.round(Math.min(1, c.g) * 255)},${Math.round(Math.min(1, c.b) * 255)})`; };
  const cm = mk(), cb = mk(), ce = mk();
  const gm = cm.getContext('2d'), gb = cb.getContext('2d'), ge = ce.getContext('2d');
  // основа: цвет + плетение + лёгкие переливы
  gm.fillStyle = col(base); gm.fillRect(0, 0, W, H);
  const im = gm.getImageData(0, 0, W, H), px = im.data;
  let sd = 1234567;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const weave = ((x + y) % 4 < 2 ? 1.04 : 0.96) * (y % 3 === 0 ? 0.97 : 1.0);
    const n = 0.93 + rnd() * 0.12;
    const band = 1 + 0.05 * Math.sin(x * 0.05 + Math.sin(y * 0.01) * 2);
    const k = weave * n * band;
    px[i] = Math.min(255, px[i] * k); px[i + 1] = Math.min(255, px[i + 1] * k); px[i + 2] = Math.min(255, px[i + 2] * k);
  }
  gm.putImageData(im, 0, 0);
  gb.fillStyle = 'rgb(128,128,128)'; gb.fillRect(0, 0, W, H);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  const trimC = col(trim), trimD = col(trim, 0.55), glowC = col(glow, 1.0);
  const both = (fn) => { fn(gm, trimC, false); fn(gb, '#fff', true); };
  // кайма: боковые и нижняя полосы с орнаментом
  const bw = 40, bh = 64;
  const border = (g, c, bump) => {
    g.save();
    g.strokeStyle = c; g.fillStyle = c; g.lineCap = 'round'; g.lineJoin = 'round';
    // линии каймы
    g.lineWidth = bump ? 5 : 4;
    g.strokeRect(10, -10, W - 20, H - 12 + 10);
    g.lineWidth = bump ? 3 : 2;
    g.strokeRect(10 + bw, -10, W - 20 - bw * 2, H - 12 - bh + 10);
    // побеги по бокам
    for (const x0 of [10, W - 10 - bw]) {
      for (let y = 20; y < H - bh; y += 56) {
        g.beginPath(); g.lineWidth = bump ? 3 : 2.2;
        g.moveTo(x0 + bw / 2, y); g.bezierCurveTo(x0 + bw * 0.95, y + 14, x0 + bw * 0.05, y + 42, x0 + bw / 2, y + 56); g.stroke();
        // листики
        for (const [dx, dy, s] of [[0.78, 12, 1], [0.22, 40, -1]]) {
          g.beginPath(); const lx = x0 + bw * dx, ly = y + dy;
          g.moveTo(lx, ly); g.quadraticCurveTo(lx + s * 9, ly - 8, lx + s * 14, ly + 2); g.quadraticCurveTo(lx + s * 6, ly + 6, lx, ly); g.fill();
        }
        g.beginPath(); g.arc(x0 + bw / 2, y + 28, bump ? 3.5 : 3, 0, TAU); g.fill();
      }
    }
    // подол: ромбы и арки
    const y0 = H - 12 - bh;
    for (let x = 10; x < W - 10; x += 32) {
      g.beginPath(); g.lineWidth = bump ? 3 : 2;
      g.moveTo(x, y0 + bh * 0.5); g.lineTo(x + 16, y0 + 10); g.lineTo(x + 32, y0 + bh * 0.5); g.lineTo(x + 16, y0 + bh - 10); g.closePath(); g.stroke();
      g.beginPath(); g.arc(x + 16, y0 + bh * 0.5, bump ? 4 : 3.5, 0, TAU); g.fill();
    }
    g.restore();
  };
  both(border);
  // герб на спине (сверху, под лопатками)
  const cx = W / 2, cy = 250, R = 92;
  const sigil = (g, c, bump, glowPass = false) => {
    g.save(); g.translate(cx, cy);
    g.strokeStyle = c; g.fillStyle = c; g.lineCap = 'round'; g.lineJoin = 'round';
    if (!glowPass) {
      g.lineWidth = bump ? 6 : 4.5; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke();
      g.lineWidth = bump ? 3 : 2; g.beginPath(); g.arc(0, 0, R - 12, 0, TAU); g.stroke();
      for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; g.beginPath(); g.moveTo(Math.cos(a) * (R - 12), Math.sin(a) * (R - 12)); g.lineTo(Math.cos(a) * (R + 10), Math.sin(a) * (R + 10)); g.lineWidth = i % 2 ? 1.5 : 3; g.stroke(); }
    }
    g.lineWidth = glowPass ? 3 : bump ? 5 : 3.5;
    g.beginPath();
    if (emblem === 'flame') {
      g.moveTo(0, 58); g.bezierCurveTo(-46, 30, -30, -12, -8, -30); g.bezierCurveTo(-14, -2, 4, 6, 6, 18);
      g.bezierCurveTo(10, -10, 22, -30, 4, -64); g.bezierCurveTo(40, -36, 48, 20, 0, 58);
    } else if (emblem === 'moon') {
      g.arc(0, 0, 52, Math.PI * 0.2, Math.PI * 1.8); g.bezierCurveTo(8, -34, 8, 34, Math.cos(Math.PI * 0.2) * 52, Math.sin(Math.PI * 0.2) * 52);
      g.moveTo(20, -8); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i / 5) * TAU * 2; g.lineTo(20 + Math.cos(a) * 12, -8 + Math.sin(a) * 12); } g.closePath();
    } else if (emblem === 'bolt') {
      g.moveTo(10, -62); g.lineTo(-26, 4); g.lineTo(-2, 4); g.lineTo(-14, 60); g.lineTo(28, -12); g.lineTo(4, -12); g.closePath();
    } else {
      g.moveTo(0, 60); g.bezierCurveTo(-50, 20, -40, -40, 0, -62); g.bezierCurveTo(40, -40, 50, 20, 0, 60); g.moveTo(0, 58); g.lineTo(0, -54);
      for (let i = -3; i <= 3; i++) { g.moveTo(0, i * 14); g.lineTo(i % 2 ? 22 : -22, i * 14 - 14); }
    }
    g.stroke();
    g.restore();
  };
  sigil(gm, trimC, false); sigil(gb, '#fff', true);
  // свечение: руна герба и тонкая внутренняя нить каймы
  ge.shadowColor = glowC; ge.shadowBlur = 10;
  sigil(ge, glowC, false, true);
  ge.strokeStyle = col(glow, 0.45); ge.lineWidth = 1.5; ge.strokeRect(10 + bw, -10, W - 20 - bw * 2, H - 12 - bh + 10);
  // тень под вышивкой (объём): тёмный отлив
  gm.globalCompositeOperation = 'multiply'; gm.globalAlpha = 0.25; border(gm, trimD, false); gm.globalCompositeOperation = 'source-over'; gm.globalAlpha = 1;
  const tex = (cv, color) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  void key;
  return { map: tex(cm, true), bump: tex(cb, false), emissive: tex(ce, true) };
}

// Звёздный блик: четыре луча и мягкое ядро (белое на чёрном, для аддитивного спрайта).
let glintTex = null;
export function glintTexture(THREE) {
  if (glintTex) return glintTex;
  if (typeof document === 'undefined') return null;
  const N = 128, cv = document.createElement('canvas'); cv.width = N; cv.height = N;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
  const c = N / 2;
  const core = g.createRadialGradient(c, c, 0, c, c, N * 0.22);
  core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.35, 'rgba(255,255,255,0.35)'); core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = 'lighter';
  for (const [a, len, w] of [[0, 0.5, 3], [Math.PI / 2, 0.5, 3], [Math.PI / 4, 0.28, 1.6], [-Math.PI / 4, 0.28, 1.6]]) {
    g.save(); g.translate(c, c); g.rotate(a);
    const gr = g.createLinearGradient(-N * len, 0, N * len, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.95)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(-N * len, -w, N * len * 2, w * 2);
    g.restore();
  }
  glintTex = new THREE.CanvasTexture(cv);
  glintTex.colorSpace = THREE.SRGBColorSpace;
  return glintTex;
}

// Руны по кругу (для кольца посоха): белые знаки на чёрном, альфа по яркости.
export function runeRingTexture(THREE) {
  if (typeof document === 'undefined') return null;
  const W = 1024, H = 64;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineCap = 'round'; g.shadowColor = '#fff'; g.shadowBlur = 6;
  g.beginPath(); g.moveTo(0, 8); g.lineTo(W, 8); g.moveTo(0, H - 8); g.lineTo(W, H - 8); g.stroke();
  let sd = 99;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  for (let x = 20; x < W - 20; x += 42) {
    g.beginPath();
    const cx = x + 10, cy = H / 2;
    const n = 2 + Math.floor(rnd() * 3);
    g.moveTo(cx, cy - 16); g.lineTo(cx, cy + 16);
    for (let i = 0; i < n; i++) { const y = cy - 12 + rnd() * 24, s = rnd() > 0.5 ? 1 : -1; g.moveTo(cx, y); g.lineTo(cx + s * (6 + rnd() * 8), y + (rnd() - 0.5) * 16); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
