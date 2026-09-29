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

export function dressHero(THREE, vrm, { preset = 'ranger', model = null, atmosphere = null, quality = 'medium', shading = 'realistic' } = {}) {
  const P = PRESETS[preset] || PRESETS.ranger;
  const H = vrm.humanoid;
  const raw = (b) => (H.getRawBoneNode ? H.getRawBoneNode(b) : null) || H.getNormalizedBoneNode(b);
  const owned = { geo: [], mat: [] };
  const G = (g) => { owned.geo.push(g); return g; };
  const Mt = (m) => {
    owned.mat.push(m);
    if (atmosphere && !m.isMeshBasicMaterial && !m.isShaderMaterial) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, m.metalness > 0.5 ? 0.9 : 0.4); } catch (e) { /* ignore */ } }
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
  // объект, поставленный в мире (pos, quat), приклеить к кости
  function stick(obj, boneName, pos, quat) {
    const b = raw(boneName);
    if (!b) return null;
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
      emissive: P.glow, emissiveMap: rune, emissiveIntensity: 0.0,
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
  totalEmissiveRadiance += emissive * smoothstep( 0.9, 0.99, vCapeT ) * 0.6;`);
    };
    cm.customProgramCacheKey = () => 'heroCape:' + len.toFixed(3);
    Mt(cm);
    const cape = new THREE.Mesh(G(capeGeo(THREE, Math.min(w * 0.8, shoulderW * 1.05), w, len)), cm);
    cape.name = 'cape';
    cape.frustumCulled = false;
    const grp = new THREE.Group(); grp.name = 'cape-root';
    grp.add(cape);
    // кант по низу
    const hem = new THREE.Mesh(G(new THREE.BoxGeometry(w * 1.25, 0.018, 0.004)), mats.trim);
    hem.visible = false; grp.add(hem);
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
    parts[parts.length - 1].spin = halo; parts[parts.length - 1].crystal = crystal;
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
      const strG = G(new THREE.CylinderGeometry(0.0016, 0.0016, 1.16, 3));
      const str = new THREE.Mesh(strG, Mt(new THREE.MeshBasicMaterial({ color: 0xf2e8d0 }))); str.position.z = 0.035; grp.add(str);
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
  }
  function setBowHeld(w) { void w; } // TODO: перенос лука в левую руку (C5 bowDraw) — №6 берёт через setPose
  function dispose() {
    for (const p of parts) if (p.obj.parent) p.obj.parent.remove(p.obj);
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) m.dispose();
    parts.length = 0;
  }
  void lodL;
  return { names, staffTip, bow, update, setLod, setQuality() {}, setShading() {}, setBowHeld, dispose, parts: () => parts.map((p) => p.obj.name) };
}
