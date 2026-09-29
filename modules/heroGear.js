// ASHEN OATH — [HERO] снаряжение поверх VRM-героя (процедурное, без внешних файлов).
// Наплечники из пластин с гравировкой-рунами, наручи, пояс с подсумками и пряжкой, кинжал на поясе,
// кольца-руны на пальцах, светящиеся узоры, плащ (ветер и инерция в вершинном шейдере), оружие:
// посох мага с кристаллом (правая рука), лук и колчан за спиной (№6 берёт лук в руку через setPose).
// Всё крепится к «сырым» костям VRM: деталь ставится в мировых координатах в позе Idle и затем
// «прилипает» к кости (Object3D.attach), поэтому раскладка не зависит от осей костей модели.
// Материалы создаются на каждый вызов (у каждого героя свои); общие только процедурные текстуры.
//
// export: dressHero(THREE, vrm, { preset, heroId, model, atmosphere, quality, shading })
//   → { names, staffTip, update(dt, root, lod), setLod(l), setQuality(q), setShading(m), setBowHeld(w), dispose() }

const PRESETS = {
  // Эльфийка: следопыт — кожа и золото, лук и колчан за спиной, короткий плащ, грозовые руны
  ranger: {
    metal: 0xc9a45c, metal2: 0x8c6a3a, leather: 0x4a3322, cloth: 0x1f5a44, glow: 0x7fe8ff,
    pauldrons: 'leather', bracers: true, belt: true, pouches: 3, dagger: 'left', rings: true,
    cape: { w: 0.44, len: 0.95, color: 0x1d4f3d, trim: 0xc9a45c }, bow: true, quiver: true,
  },
  // Тёмная чародейка: воронёная сталь, фиолетово-ледяные руны, длинный плащ, посох с кристаллом
  witch: {
    metal: 0x3a3a48, metal2: 0x8f8fb5, leather: 0x241d2a, cloth: 0x19142a, glow: 0x9d7bff,
    pauldrons: 'plate', bracers: true, belt: true, pouches: 2, dagger: 'right', rings: true,
    cape: { w: 0.5, len: 1.25, color: 0x16121f, trim: 0x8f8fb5 }, staff: { crystal: 0x8fd8ff, glow: 0x9d7bff },
  },
  // Пепельный страж (латы Quaternius Knight): плащ, посох с углём клятвы, пылающая печать на груди
  warden: {
    metal: 0x8a6a45, metal2: 0xd8b070, leather: 0x2c2018, cloth: 0x3a1f1a, glow: 0xff8a3a,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 2, dagger: null, rings: false, sigil: true,
    cape: { w: 0.62, len: 1.3, color: 0x2a1a17, trim: 0xd8b070 }, staff: { crystal: 0xffb46a, glow: 0xff7a2a },
  },
  // Эльфийка на теле Quaternius: короткий белый плащ, лук и колчан, грозовые руны
  sylvan: {
    metal: 0xd8c08a, metal2: 0xe8d6a0, leather: 0x8a6a4a, cloth: 0xe8e4d8, glow: 0x7fe8ff,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 1, dagger: 'left', rings: false, sigil: false,
    cape: { w: 0.5, len: 0.95, color: 0xe6e2d6, trim: 0xd8c08a }, bow: true, quiver: true,
  },
  // Тёмная чародейка на теле Quaternius: воронёные наплечники, длинный плащ, посох с кристаллом ночи
  witchQ: {
    metal: 0x34303e, metal2: 0x9a8fc4, leather: 0x1e1826, cloth: 0x160f22, glow: 0xa77bff,
    pauldrons: 'plate', bracers: false, belt: 'pouches', pouches: 2, dagger: 'right', rings: false, sigil: true,
    cape: { w: 0.56, len: 1.3, color: 0x140e1e, trim: 0x9a8fc4 }, staff: { crystal: 0x9fe0ff, glow: 0xa77bff },
  },
  // Лучница (Quaternius Ranger): лук и колчан, кинжал
  scout: {
    metal: 0xb0b4bc, metal2: 0xc9a45c, leather: 0x4a3322, cloth: 0x234a2a, glow: 0x9dffb0,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 2, dagger: 'right', rings: false,
    bow: true, quiver: true,
  },
  // Архимаг (Quaternius Wizard): посох-громоотвод, плащ с рунами, наручи, перстни
  magus: {
    metal: 0x6a6f7c, metal2: 0xd8b070, leather: 0x2a2230, cloth: 0x1c2438, glow: 0x8fd8ff,
    pauldrons: 'plate', bracers: true, belt: 'pouches', pouches: 2, dagger: null, rings: true, sigil: false,
    cape: { w: 0.62, len: 1.35, color: 0x1a2236, trim: 0xd8b070 }, staff: { crystal: 0xbfe8ff, glow: 0x6fb8ff },
  },
};

import { patchHeroLight } from './heroShading.js';

// ---------------------------------------------------------------- общие процедурные текстуры
const texCache = {};
function canvasTex(THREE, key, N, draw, color = false) {
  if (texCache[key]) return texCache[key];
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  draw(cv.getContext('2d'), N);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  texCache[key] = t;
  return t;
}
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
// шероховатость металла: царапины, потёртости по краям (R = G = B), металличность в той же карте не нужна
function roughTex(THREE) {
  return canvasTex(THREE, 'rough', 256, (g, N) => {
    g.fillStyle = 'rgb(95,95,95)'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 2200; i++) { const v = 60 + rnd() * 90; g.fillStyle = `rgba(${v},${v},${v},0.25)`; g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 3, 1 + rnd() * 3); }
    g.lineWidth = 0.7;
    for (let i = 0; i < 160; i++) {
      const v = 30 + rnd() * 50; g.strokeStyle = `rgba(${v},${v},${v},0.6)`;
      const x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI, l = 6 + rnd() * 26;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  });
}
// кожа брони: зерно и тиснение
function leatherTex(THREE) {
  return canvasTex(THREE, 'leather', 256, (g, N) => {
    g.fillStyle = 'rgb(170,170,170)'; g.fillRect(0, 0, N, N);
    for (let i = 0; i < 5000; i++) { const v = 120 + rnd() * 100; g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.beginPath(); g.arc(rnd() * N, rnd() * N, 0.5 + rnd() * 1.8, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = 'rgba(90,90,90,0.8)'; g.setLineDash([3, 3]); g.lineWidth = 1.2;
    g.strokeRect(6, 6, N - 12, N - 12);
  });
}
// гравировка-руны (маска свечения): вьющаяся линия и знаки
function runeTex(THREE) {
  return canvasTex(THREE, 'rune', 256, (g, N) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, N, N);
    g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = '#fff'; g.shadowBlur = 6; g.lineWidth = 3;
    g.beginPath();
    for (let x = 0; x <= N; x += 4) { const y = N * 0.5 + Math.sin((x / N) * Math.PI * 4) * N * 0.12; if (x === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
    g.lineWidth = 2.2;
    for (let i = 0; i < 6; i++) {
      const cx = (i + 0.5) * (N / 6), cy = N * 0.5 + Math.sin(((i + 0.5) / 6) * Math.PI * 4) * N * 0.12;
      g.beginPath(); g.moveTo(cx, cy - 18); g.lineTo(cx, cy + 18); g.moveTo(cx - 8, cy - 8); g.lineTo(cx, cy - 18); g.lineTo(cx + 8, cy - 8); g.stroke();
    }
  }, false);
}

// волосы: вертикальные пряди разной яркости, альфа тает к краям и к кончику (яркость — R, альфа — A)
function hairTex(THREE) {
  return canvasTex(THREE, 'hair', 128, (g, N) => {
    const W = N, H = N * 4;
    g.canvas.width = W; g.canvas.height = H;
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < 220; i++) {
      const x = rnd() * W, w = 1.2 + rnd() * 2.6, v = 150 + rnd() * 105, a = 0.55 + rnd() * 0.45;
      const tip = H * (0.72 + rnd() * 0.28);
      const grd = g.createLinearGradient(0, 0, 0, tip);
      grd.addColorStop(0, `rgba(${v},${v},${v},${a})`); grd.addColorStop(0.8, `rgba(${v},${v},${v},${a})`); grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (rnd() - 0.5) * 6, tip * 0.4, x + (rnd() - 0.5) * 8, tip * 0.8, x + (rnd() - 0.5) * 5, tip);
      g.lineTo(x + w, tip); g.bezierCurveTo(x + w, tip * 0.7, x + w, tip * 0.3, x + w, 0); g.closePath(); g.fill();
    }
    // края пряди мягче
    const edge = g.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, 'rgba(0,0,0,1)'); edge.addColorStop(0.12, 'rgba(0,0,0,0)'); edge.addColorStop(0.88, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = edge; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  }, true);
}

// ---------------------------------------------------------------- геометрия
function plateGeo(THREE, r, arc, lames, drop) {
  // наплечник: несколько выпуклых пластин-«ламелей» одна под другой
  const geos = [];
  for (let i = 0; i < lames; i++) {
    const g = new THREE.SphereGeometry(r * (1 - i * 0.07), 18, 6, -arc / 2, arc, 0, Math.PI * (0.32 + i * 0.05));
    g.translate(0, -i * drop, 0);
    geos.push(g);
  }
  return geos;
}
function capeGeo(THREE, topW, w, len, cols = 12, rows = 18) {
  const g = new THREE.PlaneGeometry(1, len, cols, rows);
  g.translate(0, -len / 2, 0);
  // сверху — по ширине плеч и огибает спину, книзу шире и ровнее; складки — лёгкая волна по ширине
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, -p.getY(i) / len)), u = p.getX(i) * 2; // u: −1..1
    const width = topW + (w - topW) * Math.sqrt(t);
    const wrapK = (1 - t) * 0.09 + 0.02;
    p.setX(i, u * width * 0.5);
    p.setZ(i, u * u * wrapK - 0.015 - t * t * 0.07 + Math.sin(u * 7.5) * 0.012 * t);
  }
  g.computeVertexNormals();
  return g;
}
function bowGeo(THREE, len) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24 - 0.5, y = t * len;
    const z = -Math.cos(t * Math.PI) * len * 0.14 + Math.sign(t) * Math.pow(Math.abs(t * 2), 4) * len * 0.05;
    pts.push(new THREE.Vector3(0, y, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, 40, 0.012, 6, false);
  // толще к рукояти
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / (len / 2), k = 1 + (1 - Math.min(1, Math.abs(y))) * 0.7;
    const c = curve.getPointAt(Math.min(1, Math.max(0, p.getY(i) / len + 0.5)));
    p.setX(i, c.x + (p.getX(i) - c.x) * k); p.setZ(i, c.z + (p.getZ(i) - c.z) * k);
  }
  g.computeVertexNormals();
  return { geo: g, tipZ: pts[0].z };
}

export function dressHero(THREE, vrm, opts = {}) {
  const { preset = 'ranger', model = null, atmosphere = null, quality = 'medium' } = opts;
  const P = PRESETS[preset] || PRESETS.ranger;
  const H = vrm.humanoid;
  const raw = (b) => (H.getRawBoneNode ? H.getRawBoneNode(b) : null) || H.getNormalizedBoneNode(b);
  const owned = { geo: [], mat: [] };
  const G = (g) => { owned.geo.push(g); return g; };
  const Mt = (m) => {
    owned.mat.push(m);
    if (atmosphere && !m.isMeshBasicMaterial && !m.isShaderMaterial) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, m.metalness > 0.5 ? 0.9 : 0.4); } catch (e) { /* ignore */ } }
    if (m.isMeshStandardMaterial) patchHeroLight(THREE, m);
    return m;
  };
  const physical = quality !== 'low';
  const Std = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const rough = roughTex(THREE), leath = leatherTex(THREE), rune = runeTex(THREE);
  const mats = {
    metal: Mt(new Std({ name: 'gear-metal', color: P.metal, metalness: 1, roughness: 0.42, roughnessMap: rough, ...(physical ? { clearcoat: 0.25, clearcoatRoughness: 0.35 } : {}) })),
    trim: Mt(new Std({ name: 'gear-trim', color: P.metal2, metalness: 1, roughness: 0.28, roughnessMap: rough })),
    leather: Mt(new Std({ name: 'gear-leather', color: P.leather, metalness: 0, roughness: 0.72, roughnessMap: leath, bumpMap: leath, bumpScale: 0.6, ...(physical ? { sheen: 0.3, sheenRoughness: 0.6, sheenColor: new THREE.Color(0.35, 0.3, 0.25) } : {}) })),
    runeMetal: Mt(new Std({ name: 'gear-rune', color: P.metal, metalness: 1, roughness: 0.4, roughnessMap: rough, emissive: P.glow, emissiveMap: rune, emissiveIntensity: 2.4 })),
    glow: Mt(new THREE.MeshBasicMaterial({ name: 'gear-glow', color: new THREE.Color(P.glow).multiplyScalar(2.2), toneMapped: true })),
    wood: Mt(new Std({ name: 'gear-wood', color: 0x3b2a1e, metalness: 0, roughness: 0.6, roughnessMap: leath })),
  };
  if (rune) { rune.repeat.set(1, 1); }
  const names = [];
  const parts = []; // { obj, bone }
  vrm.scene.updateMatrixWorld(true);
  const wpos = (b) => b.getWorldPosition(new THREE.Vector3());
  const modelQ = new THREE.Quaternion();
  (model || vrm.scene).getWorldQuaternion(modelQ);
  // оси героя в мире
  const FWD = new THREE.Vector3(0, 0, 1).applyQuaternion(modelQ), LEFT = new THREE.Vector3(1, 0, 0).applyQuaternion(modelQ), UP = new THREE.Vector3(0, 1, 0);
  const tmpM = new THREE.Matrix4();
  // склейка неподвижных деталей группы по материалу: меньше вызовов отрисовки (подсумки, кольца, пряжки…)
  const KEEP = /^(staff-halo|staff-crystal|hair-mesh|cape|bow-string-top|bow-string-bot)$/;
  function compact(grp) {
    grp.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(grp.matrixWorld).invert();
    const byMat = new Map();
    grp.traverse((o) => {
      if (!o.isMesh || !o.visible || KEEP.test(o.name) || o.children.some((c) => KEEP.test(c.name) || c.name === 'staff-tip')) return;
      const g = o.geometry;
      if (!g.attributes.position || !g.attributes.normal || !g.attributes.uv) return;
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(o);
    });
    for (const [mat, list] of byMat) {
      if (list.length < 2) continue;
      let nv = 0, ni = 0;
      for (const o of list) { nv += o.geometry.attributes.position.count; ni += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count; }
      const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), I = new Uint32Array(ni);
      let v0 = 0, i0 = 0;
      const m = new THREE.Matrix4(), nm = new THREE.Matrix3(), v = new THREE.Vector3();
      for (const o of list) {
        const g = o.geometry, pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv;
        m.multiplyMatrices(inv, o.matrixWorld); nm.getNormalMatrix(m);
        for (let k = 0; k < pa.count; k++) {
          v.fromBufferAttribute(pa, k).applyMatrix4(m); P.set([v.x, v.y, v.z], (v0 + k) * 3);
          v.fromBufferAttribute(na, k).applyMatrix3(nm).normalize(); N.set([v.x, v.y, v.z], (v0 + k) * 3);
          U[(v0 + k) * 2] = ua.getX(k); U[(v0 + k) * 2 + 1] = ua.getY(k);
        }
        if (g.index) for (let k = 0; k < g.index.count; k++) I[i0 + k] = g.index.getX(k) + v0;
        else for (let k = 0; k < pa.count; k++) I[i0 + k] = k + v0;
        v0 += pa.count; i0 += g.index ? g.index.count : pa.count;
        o.parent.remove(o);
      }
      const mg = new THREE.BufferGeometry();
      mg.setAttribute('position', new THREE.BufferAttribute(P, 3)); mg.setAttribute('normal', new THREE.BufferAttribute(N, 3)); mg.setAttribute('uv', new THREE.BufferAttribute(U, 2));
      mg.setIndex(new THREE.BufferAttribute(I, 1));
      const mm = new THREE.Mesh(G(mg), mat); mm.name = `${grp.name}-merged`;
      grp.add(mm);
    }
  }
  // объект, поставленный в мире (pos, quat), приклеить к кости
  function stick(obj, boneName, pos, quat) {
    const b = raw(boneName);
    if (!b) return null;
    try { compact(obj); } catch (e) { /* без склейки */ }
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    b.updateWorldMatrix(true, false);
    tmpM.compose(pos, quat || modelQ, new THREE.Vector3(1, 1, 1)).premultiply(new THREE.Matrix4().copy(b.matrixWorld).invert());
    b.add(obj);
    tmpM.decompose(obj.position, obj.quaternion, obj.scale);
    parts.push({ obj, bone: b });
    names.push(obj.name);
    return obj;
  }
  const qLook = (dir, up = UP) => { const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().negate(), up); return new THREE.Quaternion().setFromRotationMatrix(m); }; // +z → dir
  const qFromTo = (a, b) => new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());

  const bp = {};
  for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftIndexProximal', 'rightIndexProximal', 'leftRingProximal', 'rightMiddleProximal']) {
    const b = raw(n); if (b) bp[n] = wpos(b);
  }
  const chestB = bp.upperChest ? 'upperChest' : 'chest';
  const shoulderW = bp.leftUpperArm && bp.rightUpperArm ? bp.leftUpperArm.distanceTo(bp.rightUpperArm) : 0.3;

  // ---------------- наплечники
  if (P.pauldrons && bp.leftUpperArm) {
    const heavy = P.pauldrons === 'heavy', leather = P.pauldrons === 'leather';
    for (const side of ['left', 'right']) {
      if (leather && side === 'right') continue; // лучнице — один наплечник на левое (к тетиве не мешает)
      const up = bp[side + 'UpperArm'], lo = bp[side + 'LowerArm'];
      const s = side === 'left' ? 1 : -1;
      const grp = new THREE.Group(); grp.name = `pauldron-${side}`;
      const r = heavy ? 0.105 : leather ? 0.075 : 0.088;
      const lames = heavy ? 4 : 3;
      for (const [i, g] of plateGeo(THREE, r, Math.PI * 1.25, lames, r * 0.34).entries()) {
        const m = new THREE.Mesh(G(g), i === 0 ? (leather ? mats.leather : mats.runeMetal) : leather ? mats.leather : mats.metal);
        grp.add(m);
      }
      // кромка-кант
      const rim = new THREE.Mesh(G(new THREE.TorusGeometry(r * 0.99, 0.006, 5, 24, Math.PI * 1.25)), mats.trim);
      rim.rotation.set(Math.PI / 2, 0, Math.PI / 2 - Math.PI * 0.625); rim.position.y = r * 0.02;
      grp.add(rim);
      if (heavy) {
        const spike = new THREE.Mesh(G(new THREE.ConeGeometry(0.018, 0.09, 6)), mats.trim);
        spike.position.set(0, r * 0.95, 0); grp.add(spike);
      }
      // купол смотрит вверх-наружу, выпуклость наружу от тела
      const armDir = lo.clone().sub(up).normalize();
      const out = LEFT.clone().multiplyScalar(s);
      const domeUp = armDir.clone().negate().lerp(UP, 0.35).normalize();
      const q = qFromTo(new THREE.Vector3(0, 1, 0), domeUp);
      const faceOut = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(domeUp, Math.atan2(faceOut.clone().cross(out).dot(domeUp), faceOut.dot(out))));
      const pos = up.clone().addScaledVector(UP, 0.035).addScaledVector(out, 0.012);
      stick(grp, side + 'UpperArm', pos, q);
    }
  }

  // ---------------- нагрудник (страж)
  if (P.chest && bp[chestB]) {
    const grp = new THREE.Group(); grp.name = 'breastplate';
    const g = new THREE.SphereGeometry(0.16, 20, 10, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.18, Math.PI * 0.5);
    const m = new THREE.Mesh(G(g), mats.runeMetal); m.scale.set(1.05, 1.15, 0.75); grp.add(m);
    const gorget = new THREE.Mesh(G(new THREE.TorusGeometry(0.075, 0.014, 6, 20, Math.PI * 1.2)), mats.trim);
    gorget.rotation.set(Math.PI / 2, 0, -Math.PI * 0.1); gorget.position.set(0, 0.13, 0.02); grp.add(gorget);
    stick(grp, chestB, bp[chestB].clone().addScaledVector(UP, -0.02).addScaledVector(FWD, 0.015), modelQ);
  }

  // ---------------- печать клятвы на груди (светящийся знак поверх лат)
  if (P.sigil && bp[chestB]) {
    const grp = new THREE.Group(); grp.name = 'sigil';
    const disk = new THREE.Mesh(G(new THREE.CircleGeometry(0.055, 24)), Mt(new THREE.MeshBasicMaterial({ map: rune, color: new THREE.Color(P.glow).multiplyScalar(2.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    grp.add(disk);
    const ring = new THREE.Mesh(G(new THREE.TorusGeometry(0.06, 0.006, 5, 28)), mats.trim); grp.add(ring);
    const core = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.016)), mats.glow); core.position.z = 0.008; grp.add(core);
    stick(grp, chestB, bp[chestB].clone().addScaledVector(FWD, 0.17).addScaledVector(UP, 0.02), modelQ);
  }

  // ---------------- наручи
  if (P.bracers && bp.leftLowerArm) {
    for (const side of ['left', 'right']) {
      const lo = bp[side + 'LowerArm'], hd = bp[side + 'Hand'];
      if (!lo || !hd) continue;
      const len = lo.distanceTo(hd) * 0.62;
      const grp = new THREE.Group(); grp.name = `bracer-${side}`;
      const g = new THREE.CylinderGeometry(0.041, 0.034, len, 14, 1, true);
      const m = new THREE.Mesh(G(g), P.pauldrons === 'leather' ? mats.leather : mats.metal); m.material.side = THREE.DoubleSide; grp.add(m);
      for (const y of [-len / 2, len / 2]) {
        const ring = new THREE.Mesh(G(new THREE.TorusGeometry(y > 0 ? 0.034 : 0.041, 0.005, 5, 18)), mats.trim);
        ring.rotation.x = Math.PI / 2; ring.position.y = y; grp.add(ring);
      }
      const gem = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.012)), mats.glow);
      gem.position.set(0, 0, 0.042); gem.scale.set(1, 1.6, 0.6); grp.add(gem);
      const dir = hd.clone().sub(lo).normalize();
      const q = qFromTo(new THREE.Vector3(0, 1, 0), dir.clone().negate());
      stick(grp, side + 'LowerArm', lo.clone().lerp(hd, 0.62), q);
    }
  }

  // ---------------- пояс, подсумки, пряжка, кинжал
  if (P.belt && bp.hips) {
    const grp = new THREE.Group(); grp.name = 'belt';
    const y = (bp.spine ? bp.hips.y * 0.55 + bp.spine.y * 0.45 : bp.hips.y + 0.04);
    const rx = Math.max(0.13, shoulderW * 0.42), rz = rx * 0.78;
    if (P.belt !== 'pouches') {
      const belt = new THREE.Mesh(G(new THREE.TorusGeometry(1, 0.018, 6, 36)), mats.leather);
      belt.rotation.x = Math.PI / 2; belt.scale.set(rx, rz, 1.5);
      grp.add(belt);
      const buckle = new THREE.Mesh(G(new THREE.BoxGeometry(0.06, 0.05, 0.014)), mats.trim);
      buckle.position.set(0, 0, rz + 0.006); grp.add(buckle);
      const bgem = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.012)), mats.glow); bgem.position.set(0, 0, rz + 0.016); grp.add(bgem);
    }
    const pouchG = G(new THREE.BoxGeometry(0.06, 0.07, 0.035, 2, 2, 1));
    const flapG = G(new THREE.BoxGeometry(0.064, 0.025, 0.04));
    const n = P.pouches || 0;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.62 + (i / Math.max(1, n - 1 || 1)) * 0.55) * (i % 2 ? -1 : 1);
      const px = Math.sin(a) * rx * 1.04, pz = Math.cos(a) * rz * 1.04;
      const pouch = new THREE.Group();
      const body = new THREE.Mesh(pouchG, mats.leather); body.position.y = -0.03; pouch.add(body);
      const flap = new THREE.Mesh(flapG, mats.leather); flap.position.set(0, 0.0, 0.004); pouch.add(flap);
      const stud = new THREE.Mesh(G(new THREE.SphereGeometry(0.006, 6, 4)), mats.trim); stud.position.set(0, -0.005, 0.024); pouch.add(stud);
      pouch.position.set(px, 0, pz); pouch.rotation.y = a;
      grp.add(pouch);
    }
    if (P.dagger) {
      const s = P.dagger === 'left' ? 1 : -1;
      const dg = new THREE.Group(); dg.name = 'dagger';
      const blade = new THREE.Mesh(G(new THREE.CylinderGeometry(0.001, 0.012, 0.17, 4)), mats.trim); blade.position.y = -0.1; blade.scale.z = 0.35; dg.add(blade);
      const guard = new THREE.Mesh(G(new THREE.BoxGeometry(0.055, 0.008, 0.014)), mats.metal); dg.add(guard);
      const grip = new THREE.Mesh(G(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6)), mats.leather); grip.position.y = 0.038; dg.add(grip);
      const pom = new THREE.Mesh(G(new THREE.SphereGeometry(0.011, 8, 6)), mats.glow); pom.position.y = 0.078; dg.add(pom);
      const sheath = new THREE.Mesh(G(new THREE.CylinderGeometry(0.006, 0.016, 0.17, 6)), mats.leather); sheath.position.y = -0.095; sheath.scale.z = 0.5; dg.add(sheath);
      dg.position.set(s * rx * 0.98, -0.01, rz * 0.35); dg.rotation.set(0.2, s * 0.3, s * 0.45);
      grp.add(dg);
    }
    const c = bp.hips.clone(); c.y = y;
    stick(grp, 'hips', c, modelQ);
  }

  // ---------------- острые уши эльфа (сквозь капюшон — узнаваемый силуэт)
  if (opts.ears && bp.head) {
    const skin = Mt(new Std({ name: 'gear-ear', color: 0xc08463, roughness: 0.55, ...(physical ? { sheen: 0.2, sheenColor: new THREE.Color(1, 0.7, 0.6) } : {}) }));
    const earG = G(new THREE.ConeGeometry(0.013, 0.07, 6));
    earG.translate(0, 0.033, 0);
    for (const s of [1, -1]) {
      const ear = new THREE.Mesh(earG, skin); ear.name = `elf-ear-${s > 0 ? 'l' : 'r'}`;
      ear.scale.set(1, 1, 0.45);
      const dir = LEFT.clone().multiplyScalar(s).addScaledVector(UP, 0.85).addScaledVector(FWD, -0.55).normalize();
      stick(ear, 'head', bp.head.clone().addScaledVector(UP, 0.068).addScaledVector(LEFT, s * 0.066).addScaledVector(FWD, -0.012), qFromTo(new THREE.Vector3(0, 1, 0), dir));
    }
  }

  // ---------------- длинные волосы (девушки): пряди у лица до груди и копна по спине из-под капюшона.
  // Ленты-«карты» с текстурой прядей, одна геометрия на всю причёску; качание и инерция — в шейдере.
  let hairU = null;
  if (opts.hair && bp.head) {
    const H = opts.hair;
    const hairC = new THREE.Color(H.color || 0x3a2418);
    hairU = { uTime: { value: 0 }, uLag: { value: new THREE.Vector3() }, uWind: { value: 1 } };
    const hm = new Std({
      name: 'gear-hair', color: hairC, map: hairTex(THREE), alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.55, envMapIntensity: 0.35, metalness: 0,
      ...(physical ? { sheen: 0.3, sheenRoughness: 0.4, sheenColor: hairC.clone().multiplyScalar(1.6).lerp(new THREE.Color(1, 1, 1), 0.12), anisotropy: 0.45, anisotropyRotation: Math.PI / 2, specularIntensity: 0.35 } : {}),
    });
    hm.alphaToCoverage = true;
    hm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, hairU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aT; attribute float aSeed;
uniform float uTime; uniform vec3 uLag; uniform float uWind;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float t2 = aT * aT;
    float w = sin( uTime * 2.1 + aSeed * 6.0 + aT * 4.0 ) * 0.018 + sin( uTime * 3.3 + aSeed * 11.0 ) * 0.008;
    transformed.x += ( w * uWind - uLag.x * 0.35 ) * t2;
    transformed.z += ( w * 0.6 * uWind - uLag.z * 0.4 ) * t2;
    transformed.y += abs( uLag.z ) * 0.12 * t2;
  }`);
    };
    hm.customProgramCacheKey = () => 'heroHair';
    Mt(hm);
    const pos = [], nrm = [], uv = [], tA = [], sd = [], idx = [];
    // череп: вершины меша головы, привязанные к кости head (капюшоны и шлемы не считаются), в осях героя
    const headBone = raw('head');
    const sk = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0 };
    const hv = new THREE.Vector3(), rel = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || /hood|hat|helm|armet|hair/i.test(o.name) || !o.geometry.attributes.skinIndex) return;
      const bi = o.skeleton.bones.indexOf(headBone);
      if (bi < 0) return;
      const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
      for (let i = 0; i < SI.count; i += 2) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (SI.getComponent(i, k) === bi) w += SW.getComponent(i, k);
        if (w < 0.6) continue;
        o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld);
        rel.copy(hv).sub(bp.head);
        const x = rel.dot(LEFT), y = rel.dot(UP), z = rel.dot(FWD);
        sk.minX = Math.min(sk.minX, x); sk.maxX = Math.max(sk.maxX, x); sk.minY = Math.min(sk.minY, y); sk.maxY = Math.max(sk.maxY, y);
        sk.minZ = Math.min(sk.minZ, z); sk.maxZ = Math.max(sk.maxZ, z); sk.n++;
      }
    });
    if (sk.n < 50) Object.assign(sk, { minX: -0.075, maxX: 0.075, minY: -0.02, maxY: 0.21, minZ: -0.1, maxZ: 0.1 });
    const hH = sk.maxY - sk.minY;
    // эллипсоид верха головы (от бровей вверх): центр и полуоси
    const cy = sk.minY + hH * 0.62, ry = (sk.maxY - cy) * 1.05;
    const cz = (sk.minZ + sk.maxZ) * 0.5 - 0.004, rz = (sk.maxZ - sk.minZ) * 0.5 * 1.06;
    const cx = (sk.minX + sk.maxX) * 0.5, rx = (sk.maxX - sk.minX) * 0.5 * 1.08;
    const toW = (x, y, z) => bp.head.clone().addScaledVector(LEFT, x).addScaledVector(UP, y).addScaledVector(FWD, z);
    const headC = toW(cx, cy, cz);
    // точка на эллипсоиде по направлению (az: 0 — назад, polar: 0 — макушка) и нормаль
    const onSkull = (az, polar, k = 1) => {
      const dx = Math.sin(az) * Math.sin(polar), dy = Math.cos(polar), dz = -Math.cos(az) * Math.sin(polar);
      return { p: toW(cx + dx * rx * k, cy + dy * ry * k, cz + dz * rz * k), n: LEFT.clone().multiplyScalar(dx / rx).addScaledVector(UP, dy / ry).addScaledVector(FWD, dz / rz).normalize() };
    };
    const SEG = 12;
    // прядь: корень root, изгиб наружу out, падение вниз на длину len, смещение вперёд/назад drift
    const strand = (root, out, len, width, drift, seed) => {
      const base = pos.length / 3;
      const pts = [];
      for (let j = 0; j <= SEG; j++) {
        const t = j / SEG;
        const p = root.clone().addScaledVector(out, 0.035 * Math.sin(Math.min(1, t * 3) * Math.PI * 0.5) + 0.01 * t).addScaledVector(UP, -len * t).add(drift.clone().multiplyScalar(t * t));
        pts.push(p);
      }
      for (let j = 0; j <= SEG; j++) {
        const t = j / SEG, p = pts[j];
        const tan = (j < SEG ? pts[j + 1].clone().sub(p) : p.clone().sub(pts[j - 1])).normalize();
        const side = tan.clone().cross(out).normalize();
        const wv = width * (1 - 0.55 * t);
        for (const k of [-1, 1]) {
          const q = p.clone().addScaledVector(side, k * wv * 0.5);
          pos.push(q.x, q.y, q.z); nrm.push(out.x, out.y, out.z); uv.push(k < 0 ? 0 : 1, 1 - t); tA.push(t); sd.push(seed);
        }
        if (j < SEG) { const a = base + j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    };
    const len = H.len || 0.62;
    // шапка волос: купол по эллипсоиду черепа; линия роста — у лба над бровями, сзади — у затылка
    const capBase = pos.length / 3, CN = 20, CM = 9;
    const browY = sk.minY + hH * 0.58;
    for (let yI = 0; yI <= CM; yI++) {
      for (let xI = 0; xI <= CN; xI++) {
        const az = (xI / CN) * Math.PI * 2;
        const back = -Math.cos(az) * 0.5 + 0.5;                   // 1 — лоб, 0 — затылок
        const hl = browY + hH * (0.14 * back - 0.16 * (1 - back)); // высота линии роста
        const pm = Math.acos(Math.max(-0.95, Math.min(0.95, (hl - cy) / ry)));
        const { p, n } = onSkull(az, (yI / CM) * pm, 1.02);
        pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); uv.push(0.2 + 0.6 * (xI / CN), 1 - (yI / CM) * 0.6); tA.push(0); sd.push(0);
        if (yI < CM && xI < CN) { const i0 = capBase + yI * (CN + 1) + xI, i1 = i0 + CN + 1; idx.push(i0, i1, i0 + 1, i0 + 1, i1, i1 + 1); }
      }
    }
    const capIdx = idx.length;
    // копна по спине: веер корней по затылку, три слоя, до пояса
    for (let layer = 0; layer < 3; layer++) {
      const n = [11, 9, 7][layer];
      for (let i = 0; i < n; i++) {
        const a = (i / (n - 1) - 0.5) * [2.9, 2.4, 1.8][layer];      // угол от «прямо назад»
        const out = FWD.clone().multiplyScalar(-Math.cos(a)).addScaledVector(LEFT, Math.sin(a)).normalize();
        const root = onSkull(a, 1.2 + layer * 0.35, 1.02).p;
        const drift = FWD.clone().multiplyScalar(-0.08 - 0.04 * Math.cos(a)).addScaledVector(out, 0.035);
        strand(root, out, len * (0.92 + 0.16 * rnd()) * (1 - layer * 0.05), 0.11, drift, rnd());
      }
    }
    // пряди у лица: по четыре с каждой стороны, падают на грудь перед плечами
    for (const sgn of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const a = sgn * (1.62 + i * 0.2);
        const out = FWD.clone().multiplyScalar(-Math.cos(a)).addScaledVector(LEFT, Math.sin(a)).normalize();
        const root = onSkull(a, 1.35 + i * 0.12, 1.04).p;
        const drift = FWD.clone().multiplyScalar(0.1 + i * 0.012).addScaledVector(LEFT, sgn * (0.035 + i * 0.01));
        strand(root, out, len * (0.8 - i * 0.07), 0.085, drift, rnd());
      }
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    hg.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    hg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    hg.setAttribute('aT', new THREE.Float32BufferAttribute(tA, 1));
    hg.setAttribute('aSeed', new THREE.Float32BufferAttribute(sd, 1));
    hg.setIndex(idx);
    // вершины — в мировых координатах позы Idle; переводим в систему группы (начало — центр черепа)
    hg.translate(-headC.x, -headC.y, -headC.z);
    hg.addGroup(0, capIdx, 0); hg.addGroup(capIdx, idx.length - capIdx, 1);
    // шапка — непрозрачная (без альфы), пряди — с альфой и покачиванием
    const capM = Mt(new Std({ name: 'gear-hair-cap', color: hairC.clone().multiplyScalar(0.85), map: hairTex(THREE), roughness: 0.62, metalness: 0, envMapIntensity: 0.25, ...(physical ? { sheen: 0.25, sheenRoughness: 0.45, sheenColor: hairC.clone().multiplyScalar(1.5) } : {}) }));
    const hair = new THREE.Mesh(G(hg), [capM, hm]);
    hair.name = 'hair-mesh'; hair.frustumCulled = false;
    const grp = new THREE.Group(); grp.name = 'hair';
    grp.add(hair);
    stick(grp, 'head', headC, new THREE.Quaternion());
    hair.castShadow = true;
  }

  // ---------------- кольца-руны
  if (P.rings) {
    for (const bn of ['leftIndexProximal', 'rightMiddleProximal', 'leftRingProximal']) {
      const b = raw(bn), p = bp[bn];
      if (!b || !p) continue;
      const ring = new THREE.Mesh(G(new THREE.TorusGeometry(0.0095, 0.0028, 5, 12)), mats.trim);
      const gem = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.004)), mats.glow); gem.position.set(0, 0.011, 0); ring.add(gem);
      ring.name = `ring-${bn}`;
      // палец в покое Idle направлен вдоль кисти: кольцо — поперёк
      const child = b.children.find((o) => o.isBone);
      const dir = child ? wpos(child).sub(p).normalize() : UP.clone().negate();
      stick(ring, bn, p.clone().lerp(child ? wpos(child) : p, 0.45), qFromTo(new THREE.Vector3(0, 0, 1), dir));
    }
  }

  // ---------------- плащ (ветер и инерция в вершинном шейдере)
  let capeU = null;
  if (P.cape && bp[chestB]) {
    const { w, len, color, trim } = P.cape;
    capeU = { uTime: { value: 0 }, uLag: { value: new THREE.Vector3() }, uWind: { value: 1 } };
    const cm = new Std({
      name: 'gear-cape', color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
      ...(physical ? { sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(trim).multiplyScalar(0.35) } : {}),
      emissive: P.glow, emissiveMap: rune, emissiveIntensity: 0.55, // руна-волна поперёк плаща и тлеющая кромка
    });
    cm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, capeU);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTime; uniform vec3 uLag; uniform float uWind;
varying float vCapeT;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float t = clamp( -position.y / ${len.toFixed(3)}, 0.0, 1.0 );
    float t2 = t * t;
    vCapeT = t;
    float x = position.x;
    float wave = sin( uTime * 2.3 + t * 5.0 + x * 7.0 ) * 0.035 + sin( uTime * 3.7 + t * 9.0 - x * 11.0 ) * 0.015;
    transformed.z += ( wave * uWind - 0.05 * uWind ) * t2 - uLag.z * t2 * 0.55;
    transformed.x += sin( uTime * 1.7 + t * 3.0 ) * 0.02 * uWind * t2 - uLag.x * t2 * 0.45;
    transformed.y += uLag.y * t2 * 0.3 + max( 0.0, -uLag.z ) * t2 * 0.25;
  }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCapeT;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += emissive * smoothstep( 0.9, 0.995, vCapeT ) * 1.3;`);
    };
    cm.customProgramCacheKey = () => 'heroCape:' + len.toFixed(3);
    Mt(cm);
    const cape = new THREE.Mesh(G(capeGeo(THREE, Math.min(w * 0.8, shoulderW * 1.05), w, len)), cm);
    cape.name = 'cape';
    cape.frustumCulled = false;
    const grp = new THREE.Group(); grp.name = 'cape-root';
    grp.add(cape);
    // застёжки на плечах
    for (const s of [1, -1]) {
      const clasp = new THREE.Mesh(G(new THREE.CylinderGeometry(0.02, 0.02, 0.012, 12)), mats.trim);
      clasp.rotation.x = Math.PI / 2; clasp.position.set(s * w * 0.42, 0.015, 0.05);
      const cg = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.008)), mats.glow); cg.position.set(0, 0.008, 0); clasp.add(cg);
      grp.add(clasp);
    }
    // верх плаща — под наплечниками/воротом, вплотную к лопаткам (сверху кромка не видна)
    const neckY = bp.neck ? bp.neck.y : bp[chestB].y + 0.12;
    const top = bp[chestB].clone().setY(bp[chestB].y * 0.35 + neckY * 0.65 - 0.03).addScaledVector(FWD, -0.085);
    stick(grp, chestB, top, modelQ);
  }

  // ---------------- посох с кристаллом (правая рука)
  let staffTip = null;
  if (P.staff && bp.rightHand) {
    const grp = new THREE.Group(); grp.name = 'staff';
    const L = 1.62, grip = 0.72; // от низа до хвата
    const shaft = new THREE.Mesh(G(new THREE.CylinderGeometry(0.013, 0.017, L, 8)), mats.wood); shaft.position.y = L / 2 - grip; grp.add(shaft);
    for (const y of [0.1, 0.55, 1.2, 1.45]) {
      const band = new THREE.Mesh(G(new THREE.TorusGeometry(0.018, 0.005, 5, 14)), mats.trim); band.rotation.x = Math.PI / 2; band.position.y = y - grip; grp.add(band);
    }
    const ferrule = new THREE.Mesh(G(new THREE.ConeGeometry(0.016, 0.06, 8)), mats.metal); ferrule.rotation.x = Math.PI; ferrule.position.y = -grip - 0.02; grp.add(ferrule);
    // голова: оправа-«когти» и кристалл, вокруг — кольцо рун
    const head = new THREE.Group(); head.position.y = L - grip; grp.add(head);
    for (let i = 0; i < 3; i++) {
      const claw = new THREE.Mesh(G(new THREE.TorusGeometry(0.05, 0.007, 5, 12, Math.PI * 0.8)), mats.metal);
      claw.rotation.set(0, (i / 3) * Math.PI * 2, Math.PI / 2 + 0.2); claw.position.y = 0.05; head.add(claw);
    }
    const crystalMat = Mt(new Std({ name: 'gear-crystal', color: P.staff.crystal, emissive: P.staff.glow, emissiveIntensity: 2.2, roughness: 0.08, metalness: 0, ...(physical ? { transmission: 0.0, clearcoat: 1, clearcoatRoughness: 0.05 } : {}) }));
    const crystal = new THREE.Mesh(G(new THREE.OctahedronGeometry(0.045, 0)), crystalMat); crystal.scale.set(0.8, 1.7, 0.8); crystal.position.y = 0.1; crystal.name = 'staff-crystal'; head.add(crystal);
    const halo = new THREE.Mesh(G(new THREE.TorusGeometry(0.085, 0.004, 4, 32)), mats.glow); halo.position.y = 0.1; halo.rotation.x = Math.PI / 2; halo.name = 'staff-halo'; head.add(halo);
    staffTip = new THREE.Object3D(); staffTip.name = 'staff-tip'; staffTip.position.y = 0.1; head.add(staffTip);
    // в позе Idle: вертикально, чуть впереди и снаружи кулака
    const hand = bp.rightHand.clone();
    const fing = bp.rightMiddleProximal || hand.clone().addScaledVector(UP, -0.08);
    const palm = hand.clone().lerp(fing, 0.75).addScaledVector(FWD, 0.015);
    const q = qFromTo(new THREE.Vector3(0, 1, 0), UP.clone().addScaledVector(FWD, 0.12).normalize());
    stick(grp, 'rightHand', palm, q);
    parts[parts.length - 1].spin = halo; parts[parts.length - 1].crystal = crystal; parts[parts.length - 1].staff = true;
  }

  // ---------------- лук и колчан за спиной
  let bow = null;
  if ((P.bow || P.quiver) && bp[chestB]) {
    const back = bp[chestB].clone().addScaledVector(FWD, -0.14);
    if (P.bow) {
      const grp = new THREE.Group(); grp.name = 'bow';
      const { geo } = bowGeo(THREE, 1.18);
      const limb = new THREE.Mesh(G(geo), mats.wood); grp.add(limb);
      const tipZ = -Math.cos(0.5 * Math.PI) * 0.0 - 0.0;
      void tipZ;
      // тетива из двух половин (кончик → точка натяжения): при натяжении тянется к правой руке
      const strG = G(new THREE.CylinderGeometry(0.0016, 0.0016, 1, 3)); strG.translate(0, 0.5, 0);
      const strM = Mt(new THREE.MeshBasicMaterial({ color: 0xf2e8d0 }));
      const strTop = new THREE.Mesh(strG, strM), strBot = new THREE.Mesh(strG, strM);
      strTop.name = 'bow-string-top'; strBot.name = 'bow-string-bot';
      grp.add(strTop, strBot);
      grp.userData.string = { top: strTop, bot: strBot, tipT: new THREE.Vector3(0, 0.58, 0.035), tipB: new THREE.Vector3(0, -0.58, 0.035) };
      const gripM = new THREE.Mesh(G(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8)), mats.leather); gripM.position.z = -0.165; grp.add(gripM);
      for (const y of [-0.52, 0.52]) { const tip = new THREE.Mesh(G(new THREE.ConeGeometry(0.01, 0.05, 5)), mats.trim); tip.position.set(0, y * 1.04, 0.015); tip.rotation.x = y > 0 ? 0 : Math.PI; grp.add(tip); }
      const rg = new THREE.Mesh(G(new THREE.TorusGeometry(0.02, 0.004, 5, 14)), mats.glow); rg.position.set(0, 0.08, -0.16); rg.rotation.y = Math.PI / 2; grp.add(rg);
      // диагональ за спиной: от правого плеча к левому бедру, тетивой к спине
      const diag = UP.clone().multiplyScalar(0.95).addScaledVector(LEFT, -0.45).normalize();
      const q = qFromTo(new THREE.Vector3(0, 1, 0), diag);
      const zNow = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const want = FWD.clone(); // тетива к спине, рукоять выгибается назад от тела
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(diag, Math.atan2(zNow.clone().cross(want).dot(diag), zNow.dot(want))));
      stick(grp, chestB, back.clone().addScaledVector(FWD, -0.08), q);
      bow = grp;
    }
    if (P.quiver) {
      const grp = new THREE.Group(); grp.name = 'quiver';
      const body = new THREE.Mesh(G(new THREE.CylinderGeometry(0.045, 0.035, 0.5, 10, 1, true)), mats.leather); body.material.side = THREE.DoubleSide; grp.add(body);
      for (const y of [-0.2, 0.2]) { const r = new THREE.Mesh(G(new THREE.TorusGeometry(y > 0 ? 0.045 : 0.037, 0.005, 5, 14)), mats.trim); r.rotation.x = Math.PI / 2; r.position.y = y; grp.add(r); }
      const shaftG = G(new THREE.CylinderGeometry(0.003, 0.003, 0.62, 4));
      const fletchG = G(new THREE.BoxGeometry(0.018, 0.08, 0.002));
      const fm = Mt(new Std({ color: 0xe8e1cf, roughness: 0.8, side: THREE.DoubleSide }));
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2, rr = 0.022;
        const ar = new THREE.Mesh(shaftG, mats.wood); ar.position.set(Math.cos(a) * rr, 0.08 + (i % 3) * 0.02, Math.sin(a) * rr); grp.add(ar);
        const fl = new THREE.Mesh(fletchG, fm); fl.position.set(Math.cos(a) * rr, 0.36 + (i % 3) * 0.02, Math.sin(a) * rr); fl.rotation.y = a; grp.add(fl);
      }
      const diag = UP.clone().multiplyScalar(0.95).addScaledVector(LEFT, 0.35).normalize();
      stick(grp, chestB, back.clone().addScaledVector(LEFT, 0.07).addScaledVector(UP, -0.06).addScaledVector(FWD, -0.06), qFromTo(new THREE.Vector3(0, 1, 0), diag));
    }
  }

  // ---------------- кадр: плащ, свечение, LOD
  let t = 0, lodL = 0;
  const prevPos = new THREE.Vector3(), vel = new THREE.Vector3(), lag = new THREE.Vector3(), _q = new THREE.Quaternion();
  let havePrev = false;
  const capeRoot = parts.find((p) => p.obj.name === 'cape-root');
  function update(dt, root) {
    t += dt;
    if (capeU) {
      capeU.uTime.value = t;
      if (root && dt > 1e-4) {
        root.getWorldPosition(vel);
        if (havePrev) {
          const v = vel.clone().sub(prevPos).divideScalar(dt);
          prevPos.copy(vel);
          if (v.lengthSq() > 400) v.set(0, 0, 0); // телепорт
          // скорость → в оси плаща (кость груди); инерция — пружина
          if (capeRoot) { capeRoot.obj.getWorldQuaternion(_q); v.applyQuaternion(_q.invert()); }
          const k = 1 - Math.exp(-5 * dt);
          lag.x += (Math.max(-1.5, Math.min(1.5, v.x * 0.18)) - lag.x) * k;
          lag.y += (0 - lag.y) * k;
          lag.z += (Math.max(-1.6, Math.min(1.6, v.z * 0.2)) - lag.z) * k;
          capeU.uLag.value.copy(lag);
        } else { prevPos.copy(vel); havePrev = true; }
      }
    }
    if (hairU) {
      hairU.uTime.value = t;
      if (capeU) hairU.uLag.value.copy(capeU.uLag.value);
      else if (root && dt > 1e-4) {
        root.getWorldPosition(vel);
        if (havePrev) {
          const v = vel.clone().sub(prevPos).divideScalar(dt); prevPos.copy(vel);
          if (v.lengthSq() > 400) v.set(0, 0, 0);
          const hairRoot = parts.find((p) => p.obj.name === 'hair');
          if (hairRoot) { hairRoot.obj.getWorldQuaternion(_q); v.applyQuaternion(_q.invert()); }
          const k = 1 - Math.exp(-5 * dt);
          lag.x += (Math.max(-1.2, Math.min(1.2, v.x * 0.15)) - lag.x) * k;
          lag.z += (Math.max(-1.2, Math.min(1.2, v.z * 0.15)) - lag.z) * k;
          hairU.uLag.value.copy(lag);
        } else { prevPos.copy(vel); havePrev = true; }
      }
    }
    for (const p of parts) {
      if (p.spin) p.spin.rotation.z = t * 0.9;
      if (p.crystal) p.crystal.rotation.y = t * 0.6;
    }
    mats.runeMetal.emissiveIntensity = 2.0 + Math.sin(t * 2.1) * 0.6;
  }
  function setLod(l) {
    lodL = l;
    for (const p of parts) p.obj.traverse((o) => { if (o.isMesh) o.castShadow = l === 0; });
    if (capeU) capeU.uWind.value = l >= 2 ? 0 : 1;
    if (hairU) hairU.uWind.value = l >= 2 ? 0 : 1;
  }
  // посох идёт за кулаком, но остаётся почти вертикальным (лёгкий наклон по предплечью): иначе при
  // поднятой руке (зеркало рук игрока) он переворачивался бы вниз
  const staffPart = parts.find((p) => p.staff);
  let staffFree = false;
  const _sm = new THREE.Matrix4(), _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3(), _spi = new THREE.Matrix4();
  function followStaff(grip, forearm, fwd) {
    if (!staffPart) return;
    const obj = staffPart.obj;
    if (!staffFree) { staffFree = true; (model || vrm.scene).attach(obj); }
    _sy.copy(UP).addScaledVector(forearm, 0.35).normalize();
    _sz.copy(fwd).addScaledVector(_sy, -fwd.dot(_sy)).normalize();
    _sx.crossVectors(_sy, _sz).normalize();
    _sm.makeBasis(_sx, _sy, _sz).setPosition(grip);
    const par = obj.parent; par.updateWorldMatrix(true, false);
    _sm.premultiply(_spi.copy(par.matrixWorld).invert());
    _sm.decompose(obj.position, obj.quaternion, obj.scale);
  }

  // лук в левой руке (поза лука C5): отцепить от спины и держать рукоять в кулаке, тетивой к лучнику
  const bowHome = bow ? { parent: bow.parent, pos: bow.position.clone(), quat: bow.quaternion.clone() } : null;
  let bowHeld = false;
  const _bm = new THREE.Matrix4(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _bp = new THREE.Vector3(), _pi = new THREE.Matrix4();
  // тетива: две половины от кончиков к точке натяжения (в осях лука); без натяжения — прямая
  const _nk = new THREE.Vector3(), _sd = new THREE.Vector3(), _sq = new THREE.Quaternion(), _sY = new THREE.Vector3(0, 1, 0), _inv = new THREE.Matrix4();
  function layString(nockLocal) {
    const S = bow && bow.userData.string;
    if (!S) return;
    for (const [seg, tip] of [[S.top, S.tipT], [S.bot, S.tipB]]) {
      _sd.copy(tip).sub(nockLocal);
      const L = _sd.length();
      seg.position.copy(nockLocal);
      seg.quaternion.copy(_sq.setFromUnitVectors(_sY, _sd.divideScalar(Math.max(1e-6, L))));
      seg.scale.set(1, L, 1);
    }
  }
  if (bow) layString(_nk.set(0, 0, 0.035));
  function setBowHeld(on, hand, aimDir, up, drawHand = null, draw = 0) {
    if (!bow || !bowHome) return;
    if (!on && bowHeld) layString(_nk.set(0, 0, 0.035));
    if (on && !bowHeld) { bowHeld = true; (model || vrm.scene).attach(bow); }
    if (!on && bowHeld) { bowHeld = false; bowHome.parent.add(bow); bow.position.copy(bowHome.pos); bow.quaternion.copy(bowHome.quat); return; }
    if (!bowHeld || !hand || !aimDir) return;
    // базис лука: y — плечи лука (вверх, чуть наклонены), z — к лучнику (против прицела)
    _bz.copy(aimDir).negate().normalize();
    _by.copy(up || UP).addScaledVector(_bz, -_bz.dot(up || UP)).normalize();
    _by.applyAxisAngle(_bz, 0.18);                                   // лёгкий «кант» лука
    _bx.crossVectors(_by, _bz).normalize();
    hand.getWorldPosition(_bp);
    _bp.addScaledVector(_bz, 0.165);                                 // рукоять (z = −0.165) — в кулаке
    _bm.makeBasis(_bx, _by, _bz).setPosition(_bp);
    const par = bow.parent; par.updateWorldMatrix(true, false);
    _bm.premultiply(_pi.copy(par.matrixWorld).invert());
    _bm.decompose(bow.position, bow.quaternion, bow.scale);
    // натяжение: точка тетивы — к кулаку правой руки (не дальше 0,75 м от рукояти)
    if (drawHand && draw > 0.04) {
      bow.updateWorldMatrix(true, false);
      drawHand.getWorldPosition(_nk);
      _nk.applyMatrix4(_inv.copy(bow.matrixWorld).invert());
      _nk.x *= 0.3;
      _nk.lerp(_sd.set(0, 0, 0.035), 1 - Math.min(1, draw * 1.2));
      if (_nk.length() > 0.75) _nk.setLength(0.75);
      layString(_nk);
    } else layString(_nk.set(0, 0, 0.035));
  }
  function dispose() {
    for (const p of parts) if (p.obj.parent) p.obj.parent.remove(p.obj);
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) { if (atmosphere && atmosphere.releaseEnv) { try { atmosphere.releaseEnv(m); } catch (e) { /* ignore */ } } m.dispose(); }
    parts.length = 0;
  }
  void lodL;
  // качество: на 'low' — без sheen/clearcoat/anisotropy/transmission (дешёвый шейдер), выше — как было
  const physSaved = owned.mat.filter((m) => m.isMeshPhysicalMaterial).map((m) => ({ m, v: { sheen: m.sheen, clearcoat: m.clearcoat, anisotropy: m.anisotropy, transmission: m.transmission } }));
  // low — без всех четырёх; medium — только sheen (clearcoat/anisotropy/transmission — на 'high')
  let qTier = null;
  function setQuality(q) {
    const t = q === 'low' || q === 'high' ? q : 'medium';
    if (t === qTier) return;
    qTier = t;
    for (const { m, v } of physSaved) for (const k of Object.keys(v)) m[k] = t === 'high' || (t === 'medium' && k === 'sheen') ? v[k] : 0;
  }
  setQuality(quality);
  return { names, staffTip, bow, followStaff: staffPart ? followStaff : null, update, setLod, setQuality, setShading() {}, setBowHeld, dispose, parts: () => parts.map((p) => p.obj.name) };
}
