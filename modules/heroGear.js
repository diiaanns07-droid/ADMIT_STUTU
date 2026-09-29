// ASHEN OATH — [HERO] снаряжение поверх VRM-героя (процедурное, без внешних файлов).
// Наплечники из пластин с гравировкой-рунами, наручи, пояс с подсумками и пряжкой, кинжал на поясе,
// кольца-руны на пальцах, светящиеся узоры, плащ (ветер и инерция в вершинном шейдере), оружие:
// посох мага с кристаллом (правая рука), лук и колчан за спиной (№6 берёт лук в руку через setPose).
// Всё крепится к «сырым» костям VRM: деталь ставится в мировых координатах в позе Idle и затем
// «прилипает» к кости (Object3D.attach), поэтому раскладка не зависит от осей костей модели.
// Материалы создаются на каждый вызов (у каждого героя свои); общие только процедурные текстуры.
//
// export: dressHero(THREE, vrm, { preset, heroId, model, atmosphere, quality, shading })
//   → { names, staffTip, bow, cloth, update(dt, root, lod), setLod(l), setQuality(q), setShading(m), setBowHeld(on, grip, nock, draw), setGlow(k), dispose() }
// opts.grips = { R, L } — узлы хвата кистей из heroModel (центр кулака; y — вдоль большого пальца).

const PRESETS = {
  // Эльфийка: следопыт — кожа и золото, лук и колчан за спиной, короткий плащ, грозовые руны
  ranger: {
    metal: 0xc9a45c, metal2: 0x8c6a3a, leather: 0x4a3322, cloth: 0x1f5a44, glow: 0x7fe8ff,
    pauldrons: 'leather', bracers: true, belt: true, pouches: 3, dagger: 'left', rings: true,
    cape: { w: 0.44, len: 0.95, color: 0x1d4f3d, trim: 0xc9a45c, emblem: 'leaf', lining: 0x6b5a2e }, bow: { wood: 0x5a3a22 }, quiver: 'hip',
  },
  // Тёмная чародейка: воронёная сталь, фиолетово-ледяные руны, длинный плащ, посох с кристаллом
  witch: {
    metal: 0x3a3a48, metal2: 0x8f8fb5, leather: 0x241d2a, cloth: 0x19142a, glow: 0x9d7bff,
    pauldrons: 'plate', bracers: true, belt: true, pouches: 2, dagger: 'right', rings: true,
    cape: { w: 0.5, len: 1.25, color: 0x16121f, trim: 0x8f8fb5, emblem: 'moon', lining: 0x3b2160 }, staff: { crystal: 0x8fd8ff, glow: 0x9d7bff, style: 'crescent', wood: 0x1b1522 },
  },
  // Пепельный страж (латы Quaternius Knight): плащ, посох с углём клятвы, пылающая печать на груди
  warden: {
    metal: 0x8a6a45, metal2: 0xd8b070, leather: 0x2c2018, cloth: 0x3a1f1a, glow: 0xff8a3a,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 2, dagger: null, rings: false, sigil: true,
    cape: { w: 0.66, len: 1.32, color: 0x2a1512, trim: 0xd8a860, emblem: 'flame', lining: 0x6a140f }, staff: { crystal: 0xffb46a, glow: 0xff7a2a, style: 'crown', wood: 0x2a1b14 },
    plume: { color: 0x8c1a12, len: 0.46 },
  },
  // Эльфийка на теле Quaternius: короткий белый плащ, лук и колчан, грозовые руны
  sylvan: {
    metal: 0xd8c08a, metal2: 0xe8d6a0, leather: 0x8a6a4a, cloth: 0xe8e4d8, glow: 0x7fe8ff,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 1, dagger: 'left', rings: false, sigil: false,
    cape: { w: 0.5, len: 0.98, color: 0xd6cdb8, trim: 0xc9a45c, emblem: 'leaf', lining: 0x5f7d6a }, bow: { wood: 0xb9a888, rough: 0.62 }, quiver: 'hip',
  },
  // Тёмная чародейка на теле Quaternius: воронёные наплечники, длинный плащ, посох с кристаллом ночи
  witchQ: {
    metal: 0x34303e, metal2: 0x9a8fc4, leather: 0x1e1826, cloth: 0x160f22, glow: 0xa77bff,
    pauldrons: 'plate', bracers: false, belt: 'pouches', pouches: 2, dagger: 'right', rings: false, sigil: true,
    cape: { w: 0.6, len: 1.3, color: 0x1a1128, trim: 0xb8aee0, emblem: 'moon', lining: 0x40235f }, staff: { crystal: 0x9fe0ff, glow: 0xa77bff, style: 'crescent', wood: 0x1b1522 },
  },
  // Лучница (Quaternius Ranger): лук и колчан, кинжал
  scout: {
    metal: 0xb0b4bc, metal2: 0xc9a45c, leather: 0x4a3322, cloth: 0x234a2a, glow: 0x9dffb0,
    pauldrons: null, bracers: false, belt: 'pouches', pouches: 2, dagger: 'right', rings: false,
    bow: { wood: 0x5a3a22 }, quiver: 'back',
  },
  // Архимаг (Quaternius Wizard): посох-громоотвод, плащ с рунами, наручи, перстни
  magus: {
    metal: 0x6a6f7c, metal2: 0xd8b070, leather: 0x2a2230, cloth: 0x1c2438, glow: 0x8fd8ff,
    pauldrons: 'plate', bracers: true, belt: 'pouches', pouches: 2, dagger: null, rings: true, sigil: false,
    cape: { w: 0.66, len: 1.35, color: 0x16203a, trim: 0xd8b070, emblem: 'bolt', lining: 0x7a5a22 }, staff: { crystal: 0xbfe8ff, glow: 0x6fb8ff, style: 'hoop', wood: 0x4a3526 },
  },
};

import { patchHeroLight } from './heroShading.js';
import { buildStaff, buildBow, buildArrow, buildQuiver, buildBrooch, capeTextures, runeRingTexture, glintTexture, tube, gem, gem as gemGeo } from './heroForge.js';
import { createCloth, createStrands, fitCapsules } from './heroCloth.js';

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

// волосы: пучки прядей вдоль v (яркость — R=G=B), без альфы; по u повторяется (обход локона)
function hairStrandTex(THREE) {
  return canvasTex(THREE, 'hairStrand', 256, (g, N) => {
    g.fillStyle = 'rgb(150,150,150)'; g.fillRect(0, 0, N, N);
    // крупные пучки: мягкие светлые и тёмные полосы
    for (let x = 0; x < N; x += 2) { const v = 150 + 22 * Math.sin((x / N) * Math.PI * 2 * 3 + 0.7) + 10 * Math.sin((x / N) * Math.PI * 2 * 7); g.fillStyle = `rgba(${v},${v},${v},0.55)`; g.fillRect(x, 0, 2, N); }
    // волоски
    for (let i = 0; i < 900; i++) {
      const x = rnd() * N, v = 105 + rnd() * 120, a = 0.18 + rnd() * 0.3, w = 0.6 + rnd() * 1.2;
      g.strokeStyle = `rgba(${v},${v},${v},${a})`; g.lineWidth = w;
      g.beginPath(); g.moveTo(x, -4);
      const wob = (rnd() - 0.5) * 6;
      g.bezierCurveTo(x + wob, N * 0.33, x - wob, N * 0.66, x + (rnd() - 0.5) * 3, N + 4); g.stroke();
    }
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
export function dressHero(THREE, vrm, opts = {}) {
  const { preset = 'ranger', model = null, atmosphere = null, quality = 'medium' } = opts;
  const P = PRESETS[preset] || PRESETS.ranger;
  const H = vrm.humanoid;
  const raw = (b) => (H.getRawBoneNode ? H.getRawBoneNode(b) : null) || H.getNormalizedBoneNode(b);
  const owned = { geo: [], mat: [] };
  const G = (g) => { owned.geo.push(g); return g; };
  const Mt = (m) => {
    owned.mat.push(m);
    if (atmosphere && !m.isMeshBasicMaterial && !m.isShaderMaterial && !m.isSpriteMaterial) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, m.metalness > 0.5 ? 0.9 : 0.4); } catch (e) { /* ignore */ } }
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
    wood: Mt(new Std({ name: 'gear-wood', color: (P.staff && P.staff.wood) || (P.bow && P.bow.wood) || 0x3b2a1e, metalness: 0, roughness: (P.bow && P.bow.rough) || 0.52, roughnessMap: leath, ...(physical ? { clearcoat: 0.3, clearcoatRoughness: 0.45 } : {}) })),
  };
  // [HERO] оружие: огранённый кристалл (плоские грани, свет изнутри и по кромкам), ядро света, руны
  const glowHex = (P.staff && P.staff.glow) || P.glow;
  mats.crystal = Mt(new Std({ name: 'gear-crystal', color: (P.staff && P.staff.crystal) || P.glow, emissive: glowHex, emissiveIntensity: 0.9, roughness: 0.05, metalness: 0.1, flatShading: true, ...(physical ? { clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.5, iridescenceIOR: 1.6 } : {}) }));
  {
    const cm0 = mats.crystal, prev = cm0.onBeforeCompile;
    cm0.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(cm0, sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  { float fr = 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) ); totalEmissiveRadiance *= 0.55 + 2.2 * fr * fr; }`);
    };
    const pk = cm0.customProgramCacheKey;
    cm0.customProgramCacheKey = () => 'gearCrystal:' + (pk ? pk.call(cm0) : '');
  }
  mats.core = Mt(new THREE.MeshBasicMaterial({ name: 'gear-core', color: new THREE.Color(glowHex).multiplyScalar(3.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  mats.runeRing = Mt(new THREE.MeshBasicMaterial({ name: 'gear-runering', map: runeRingTexture(THREE), color: new THREE.Color(glowHex).multiplyScalar(2.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  mats.inlay = Mt(new THREE.MeshBasicMaterial({ name: 'gear-inlay', color: new THREE.Color(P.glow).multiplyScalar(2.2) }));
  mats.glint = Mt(new THREE.SpriteMaterial({ name: 'gear-glint', map: glintTexture(THREE), color: new THREE.Color(glowHex).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(1.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  mats.fletch = Mt(new Std({ name: 'gear-fletch', color: 0xf2ece0, roughness: 0.85, side: THREE.DoubleSide, ...(physical ? { sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(1, 1, 1) } : {}) }));
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
  // (поддеревья с именами из KEEP не трогаем: они крутятся, светятся или двигаются сами)
  const KEEP = /^(staff-halo|staff-crystal|staff-core|staff-shards|hair-mesh|cape|bow-string-top|bow-string-bot|arrow|bow-nocked)$/;
  function compact(grp) {
    grp.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(grp.matrixWorld).invert();
    const byMat = new Map();
    const walk = (o) => {
      if (KEEP.test(o.name) || o.name === 'staff-tip') return;
      if (o.isMesh && o.visible && !o.children.length) {
        const g = o.geometry;
        if (g.attributes.position && g.attributes.normal && g.attributes.uv) {
          if (!byMat.has(o.material)) byMat.set(o.material, []);
          byMat.get(o.material).push(o);
        }
      }
      for (const c of o.children.slice()) walk(c);
    };
    walk(grp);
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

  // капсулы тела: радиусы — по вершинам кожи (латы стража толще, чем ткань лучницы)
  const capPairs = [
    ['hips', chestB], [chestB, 'neck'], ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg'],
    ['leftLowerLeg', 'leftFoot'], ['rightLowerLeg', 'rightFoot'], ['leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightLowerArm'],
  ];
  const bodyCaps = [];
  if (bp.hips && bp[chestB]) {
    const pairs = capPairs.filter(([x, y]) => raw(x) && raw(y));
    let radii = [];
    try { radii = fitCapsules(THREE, vrm.scene, pairs.map(([x, y]) => ({ a: wpos(raw(x)), b: wpos(raw(y)) }))); } catch (e) { radii = []; }
    const defR = { hips: 0.15, leftUpperLeg: 0.085, rightUpperLeg: 0.085, leftLowerLeg: 0.065, rightLowerLeg: 0.065, leftUpperArm: 0.055, rightUpperArm: 0.055 };
    pairs.forEach(([x, y], i) => bodyCaps.push({ a: raw(x), b: raw(y), r: (radii[i] || defR[x] || 0.13) + 0.018, name: x }));
  }
  const torsoR = bodyCaps.length ? Math.max(bodyCaps[0].r, bodyCaps[1] ? bodyCaps[1].r : 0) : 0.16;

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

  // ---------------- брошь-эмблема на груди (кованая, с камнем): ставится на поверхность груди лучом по коже
  if (P.sigil && bp[chestB]) {
    const grp = buildBrooch(THREE, mats, { emblem: (P.cape && P.cape.emblem) || 'flame', r: 0.048 });
    grp.name = 'sigil';
    const at = bp[chestB].clone().addScaledVector(UP, 0.03);
    let surf = at.clone().addScaledVector(FWD, 0.17);
    try {
      vrm.scene.updateMatrixWorld(true);
      const rc = new THREE.Raycaster(at.clone().addScaledVector(FWD, 0.6), FWD.clone().negate(), 0, 0.6);
      const meshes = [];
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh && o.visible) meshes.push(o); });
      const hit = rc.intersectObjects(meshes, false)[0];
      if (hit) surf = hit.point.clone().addScaledVector(FWD, 0.004);
    } catch (e) { /* без луча — прежнее смещение */ }
    stick(grp, chestB, surf, modelQ);
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

  // ---------------- глаза в прорези шлема (страж): два светящихся уголька
  let visorMat = null;
  if (opts.fx && opts.fx.visorEyes && bp.head) {
    const headBone = raw('head');
    let front = -1e9, minY = 1e9, maxY = -1e9;
    const hv = new THREE.Vector3(), rel = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
      const bi = o.skeleton.bones.indexOf(headBone);
      if (bi < 0) return;
      const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
      for (let i = 0; i < SI.count; i += 3) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (SI.getComponent(i, k) === bi) w += SW.getComponent(i, k);
        if (w < 0.6) continue;
        o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld); rel.copy(hv).sub(bp.head);
        const y = rel.dot(UP); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    });
    const eyeY = minY < maxY ? minY + (maxY - minY) * 0.56 : 0.1;
    // передний край шлема на высоте глаз
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
      const bi = o.skeleton.bones.indexOf(headBone);
      if (bi < 0) return;
      const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
      for (let i = 0; i < SI.count; i += 2) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (SI.getComponent(i, k) === bi) w += SW.getComponent(i, k);
        if (w < 0.6) continue;
        o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld); rel.copy(hv).sub(bp.head);
        if (Math.abs(rel.dot(UP) - eyeY) < 0.03 && Math.abs(rel.dot(LEFT)) < 0.03) front = Math.max(front, rel.dot(FWD));
      }
    });
    if (front < -1) front = 0.11;
    visorMat = Mt(new THREE.MeshBasicMaterial({ color: new THREE.Color(opts.fx.visorEyes).lerp(new THREE.Color(0xff3a08), 0.45).multiplyScalar(1.9), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const eyeG = G(new THREE.PlaneGeometry(0.028, 0.0075));
    const grp = new THREE.Group(); grp.name = 'visor-eyes';
    for (const sx of [1, -1]) {
      const e = new THREE.Mesh(eyeG, visorMat); e.position.set(sx * 0.03, 0, 0); e.rotation.z = sx * 0.12; grp.add(e);
    }
    stick(grp, 'head', bp.head.clone().addScaledVector(UP, eyeY).addScaledVector(FWD, front + 0.004), modelQ);
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

  // ---------------- волосы героинь: объёмные локоны на физике прядей (heroCloth.createStrands).
  // Чёлка (прямая до бровей или набок), пряди у лица — ложатся на ключицы и грудь, копна из-под капюшона
  // по спине. Локон — трубка с эллиптическим сечением (плоской стороной к телу), сужается к кончику;
  // корни темнее, кончики светлее; пряди не проходят сквозь голову, плечи и корпус (капсулы).
  let hair = null;
  if (opts.hair && bp.head) {
    const HO = opts.hair;
    const hairC = new THREE.Color(HO.color || 0x3a2418);
    // череп: вершины кожи головы (капюшон и шлем не в счёт) → эллипсоид в осях героя
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
    const cy = sk.minY + hH * 0.62, ry = (sk.maxY - cy) * 1.05;
    const cz = (sk.minZ + sk.maxZ) * 0.5 - 0.004, rz = (sk.maxZ - sk.minZ) * 0.5 * 1.04;
    const cx = (sk.minX + sk.maxX) * 0.5, rx = (sk.maxX - sk.minX) * 0.5 * 1.06;
    const toW = (x, y, z) => bp.head.clone().addScaledVector(LEFT, x).addScaledVector(UP, y).addScaledVector(FWD, z);
    // точка на эллипсоиде: az 0 — затылок, +π/2 — левый висок, π — лоб; polar 0 — макушка
    const sk3 = (az, polar, k = 1) => toW(cx + Math.sin(az) * Math.sin(polar) * rx * k, cy + Math.cos(polar) * ry * k, cz - Math.cos(az) * Math.sin(polar) * rz * k);
    const browY = sk.minY + hH * 0.58;
    const polarBrow = Math.acos(Math.max(-0.95, Math.min(0.95, (browY + 0.012 - cy) / ry)));
    const DOWN = UP.clone().negate();
    let sd = 7;
    const rr = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    const locks = [];
    const len = HO.len || 0.9;
    // 1) чёлка (неподвижна относительно головы)
    if (HO.fringe === 'straight') {
      const n = 11;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1), a = Math.PI + (u - 0.5) * 1.5, side = Math.abs(u - 0.5) * 2;
        const p0 = 0.52 + 0.3 * side * side;                   // корни — под краем капюшона (по бокам ниже)
        const pts = [];
        for (let j = 0; j <= 5; j++) { const t = j / 5; pts.push(sk3(a + (a - Math.PI) * 0.12 * t, p0 + (polarBrow - 0.06 - p0) * t - side * 0.04 * t, 1.02 + 0.045 * Math.sin(Math.PI * t * 0.8) + 0.02 * t)); }
        locks.push({ pts, pin: pts.length, static: true, r0: 0.017, r1: 0.014, flat: 0.32, taper: 0.4, seed: rr(), tone: 0.95 + rr() * 0.1, vScale: 0.4 });
      }
    } else {
      // набок: густая чёлка из-под капюшона, кончики сметены к правому виску (левая бровь открыта)
      const n = 13;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const side = Math.abs(u - 0.5) * 2;
        const a0 = Math.PI + (u - 0.5) * 1.45, p0 = 0.52 + 0.3 * side * side;   // корни — под краем капюшона
        const sweep = 0.35 + 0.25 * u;
        const p1 = polarBrow - 0.3 + 0.34 * u;                 // слева короче, справа ниже — к брови
        const pts = [];
        for (let j = 0; j <= 6; j++) {
          const t = j / 6, e = t * t * (3 - 2 * t);
          pts.push(sk3(a0 + sweep * e, p0 + (p1 - p0) * t + 0.05 * Math.sin(Math.PI * t), 1.02 + 0.05 * Math.sin(Math.PI * t * 0.85) + 0.012 * u));
        }
        locks.push({ pts, pin: pts.length, static: true, r0: 0.019, r1: 0.012, flat: 0.32, taper: 0.85, seed: rr(), tone: 0.92 + rr() * 0.16, vScale: 0.45 });
      }
    }
    // 2) пряди у лица: от висков вниз вдоль щёк, на ключицы и грудь
    const chestP = bp[chestB];
    for (const s of [1, -1]) {
      for (let j = 0; j < 3; j++) {
        const az = s * (Math.PI / 2 + 0.42 + 0.13 * j), pol = 1.3 + 0.08 * j;
        const L = len * (0.52 - 0.06 * j) * (HO.front || 1);
        const n = 9, pts = [];
        const p0 = sk3(az, pol, 1.02), p1 = sk3(az, pol + 0.32, 1.12);
        pts.push(p0, p1);
        const outV = LEFT.clone().multiplyScalar(s);
        for (let i = 2; i < n; i++) {
          const t = (i - 1) / (n - 2);
          const p = p1.clone().addScaledVector(DOWN, t * (L - p0.distanceTo(p1)));
          // держим снаружи груди и чуть сбоку — симуляция уложит на тело
          p.addScaledVector(outV, 0.015 + 0.02 * j - 0.03 * t);
          const zFront = chestP.clone().sub(p).dot(FWD);
          p.addScaledVector(FWD, Math.max(0, zFront + torsoR + 0.05) * Math.min(1, t * 2));
          pts.push(p);
        }
        locks.push({ pts, pin: 2, r0: 0.021 - 0.003 * j, r1: 0.013, flat: 0.5, seed: rr(), tone: 0.95 + rr() * 0.1, stiff: 0.25 });
      }
    }
    // 3) копна по спине: веер прядей из-под капюшона, два слоя
    for (let layer = 0; layer < 2; layer++) {
      const n = layer ? 6 : 9;
      for (let i = 0; i < n; i++) {
        const a = (i / (n - 1) - 0.5) * (layer ? 1.6 : 2.3);
        const root = sk3(a, 2.0 + 0.12 * Math.abs(a), 0.97);
        const L = len * (layer ? 0.8 : 1) * (0.92 + 0.12 * rr());
        const m = 10, pts = [root, root.clone().addScaledVector(DOWN, 0.05).addScaledVector(FWD, -0.03)];
        for (let k = 2; k < m; k++) {
          const t = (k - 1) / (m - 2);
          const p = root.clone().addScaledVector(DOWN, 0.05 + t * (L - 0.05)).addScaledVector(LEFT, Math.sin(a) * (0.03 + 0.07 * t));
          const zBack = p.clone().sub(chestP).dot(FWD);
          p.addScaledVector(FWD, -Math.max(0, zBack + torsoR + 0.03 + 0.012 * (1 - layer)));
          pts.push(p);
        }
        locks.push({ pts, pin: 2, r0: layer ? 0.024 : 0.028, r1: 0.017, flat: 0.42, seed: rr(), tone: (layer ? 0.9 : 1.0) + rr() * 0.12, stiff: 0.5, back: true });
      }
    }
    // материал: пряди-«пучки» с блеском вдоль волоса (анизотропия), лёгкий sheen, цвет по вершинам
    const strandTex = hairStrandTex(THREE);
    const hm = new Std({
      name: 'gear-hair', color: hairC, map: strandTex, bumpMap: strandTex, bumpScale: 2.2, vertexColors: true,
      roughness: 0.4, metalness: 0, envMapIntensity: 0.5,
      ...(physical ? { sheen: 0.4, sheenRoughness: 0.35, sheenColor: hairC.clone().multiplyScalar(1.5).lerp(new THREE.Color(1, 1, 1), 0.15), anisotropy: 0.65, anisotropyRotation: Math.PI / 2, specularIntensity: 0.5 } : {}),
    });
    Mt(hm);
    // коллайдеры: голова (шар в центре черепа), шея и корпус, плечи
    const skullC = new THREE.Object3D(); skullC.name = 'hair-skull';
    headBone.add(skullC); skullC.position.copy(headBone.worldToLocal(toW(cx, cy, cz)));
    const colliders = [{ a: skullC, b: skullC, r: Math.max(rx, rz) * 1.0 }];
    for (const c of bodyCaps) if (!/Leg/.test(c.name)) colliders.push({ a: c.a, b: c.b, r: c.r - 0.005 });
    // обруч-диадема поверх чёлки (эльфийка): золотая дуга от виска к виску и капля-камень на лбу
    if (opts.circlet) {
      const cp = [];
      for (let i = 0; i <= 24; i++) { const a = Math.PI + (i / 24 - 0.5) * 2.5; cp.push(sk3(a, polarBrow - 0.27 + 0.1 * Math.abs(i / 24 - 0.5), 1.09)); }
      const grp = new THREE.Group(); grp.name = 'circlet';
      grp.add(new THREE.Mesh(G(tube(THREE, new THREE.CatmullRomCurve3(cp), 60, 6, (v) => 0.0026 + 0.0012 * Math.sin(Math.PI * v), { flat: 0.6 })), mats.trim));
      const mid = sk3(Math.PI, polarBrow - 0.27, 1.095);
      const setting = new THREE.Mesh(G(new THREE.TorusGeometry(0.009, 0.0022, 6, 16)), mats.trim);
      const gemM = Mt(new Std({ name: 'gear-circlet-gem', color: opts.circlet.gem || 0x7fe8ff, emissive: opts.circlet.gem || 0x7fe8ff, emissiveIntensity: 0.8, roughness: 0.05, flatShading: true }));
      const drop = new THREE.Mesh(G(gem(THREE, { r: 0.007, h: 0.024, n: 6 })), gemM);
      const q = qFromTo(new THREE.Vector3(0, 0, 1), FWD);
      setting.position.copy(mid).addScaledVector(UP, -0.012); setting.quaternion.copy(q);
      drop.position.copy(mid).addScaledVector(UP, -0.013).addScaledVector(FWD, 0.004);
      grp.add(setting, drop);
      const c0 = mid.clone();
      for (const m of grp.children) { m.position.sub(c0); m.updateMatrix(); }
      stick(grp, 'head', c0, new THREE.Quaternion());
    }
    const _hq = new THREE.Quaternion(), holderH = model || vrm.scene;
    hair = createStrands(THREE, { locks, anchor: headBone, parent: headBone, colliders, material: hm, spine: [raw('neck') || raw(chestB), raw('hips')], fwd: (out) => out.set(0, 0, 1).applyQuaternion(holderH.getWorldQuaternion(_hq)) });
    parts.push({ obj: hair.mesh, bone: headBone }, { obj: skullC, bone: headBone });
    names.push('hair');
  }

  // ---------------- плюмаж на шлеме (страж): гребень алых прядей по верху шлема, струится назад
  let plume = null;
  if (P.plume && bp.head) {
    const headBone = raw('head');
    // профиль верха шлема по средней линии: для полос по «вперёд» — наибольшая высота
    const prof = new Map();
    const hv = new THREE.Vector3(), rel = new THREE.Vector3();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !/armet|helm/i.test(o.name) || !o.geometry.attributes.position) return;
      const n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) {
        o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld); rel.copy(hv).sub(bp.head);
        if (Math.abs(rel.dot(LEFT)) > 0.02) continue;
        const z = rel.dot(FWD), y = rel.dot(UP), key = Math.round(z / 0.012);
        if (!prof.has(key) || prof.get(key) < y) prof.set(key, y);
      }
    });
    const keys = [...prof.keys()].sort((a, b) => a - b);
    if (keys.length > 6) {
      const zMin = keys[0] * 0.012, zMax = keys[keys.length - 1] * 0.012;
      const yAt = (z) => { const k = Math.round(z / 0.012); for (let d = 0; d < 4; d++) { if (prof.has(k + d)) return prof.get(k + d); if (prof.has(k - d)) return prof.get(k - d); } return 0; };
      const topY = Math.max(...prof.values());
      const toW = (z, y, x = 0) => bp.head.clone().addScaledVector(FWD, z).addScaledVector(UP, y).addScaledVector(LEFT, x);
      const locks = [];
      const n = 11, L = P.plume.len || 0.5;
      let sd = 3;
      const rr = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const z = zMax - 0.03 - u * (zMax - zMin) * 0.62;            // от лба к затылку по гребню
        const y0 = yAt(z) + 0.006;
        if (y0 < topY - 0.09) continue;
        for (const x of [-0.006, 0.006]) {
          // корень гребня — жёсткая дуга вверх-назад (4 прибитые точки), дальше хвост свободно падает за спину
          const h = 0.05 + 0.03 * (1 - u);
          const pts = [toW(z, y0, x), toW(z - 0.03, y0 + h * 0.8, x), toW(z - 0.08, y0 + h, x * 1.5), toW(z - 0.13, y0 + h * 0.75, x * 2)];
          const len = L * (0.6 + 0.4 * u) * (0.9 + 0.2 * rr());
          for (let k = 4; k < 10; k++) {
            const t = (k - 3) / 6;
            pts.push(toW(z - 0.13 - t * len * 0.45, y0 + h * 0.75 - t * len * 0.85, x * (2 + 4 * t)));
          }
          locks.push({ pts, pin: 4, r0: 0.015 + 0.004 * (1 - u), r1: 0.011, flat: 0.3, seed: rr(), tone: 0.9 + rr() * 0.2, stiff: 0.6, taper: 0.9, back: true });
        }
      }
      const plC = new THREE.Color(P.plume.color || 0x7a1510);
      const pm = Mt(new Std({
        name: 'gear-plume', color: plC, map: hairStrandTex(THREE), vertexColors: true, roughness: 0.55, metalness: 0,
        ...(physical ? { sheen: 0.6, sheenRoughness: 0.4, sheenColor: plC.clone().multiplyScalar(1.8) } : {}),
      }));
      const helmR = Math.max(0.1, (zMax - zMin) * 0.5);
      const hc = new THREE.Object3D(); hc.name = 'plume-helm'; headBone.add(hc);
      hc.position.copy(headBone.worldToLocal(toW((zMax + zMin) * 0.5, topY - helmR * 0.95)));
      const colliders = [{ a: hc, b: hc, r: helmR * 0.98 }];
      for (const c of bodyCaps) if (/hips|Chest|chest|UpperArm/.test(c.name)) colliders.push({ a: c.a, b: c.b, r: c.r });
      const _pq = new THREE.Quaternion(), holderP = model || vrm.scene;
      plume = createStrands(THREE, { locks, anchor: headBone, parent: headBone, colliders, material: pm, drag: 2.0, carry: 0.6,
        spine: [raw('neck') || raw(chestB), raw('hips')], fwd: (out) => out.set(0, 0, 1).applyQuaternion(holderP.getWorldQuaternion(_pq)) });
      plume.mesh.name = 'plume';
      parts.push({ obj: plume.mesh, bone: headBone }, { obj: hc, bone: headBone });
      names.push('plume');
    }
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

  // ---------------- посох: в кулаке правой (узел хвата heroModel: древко поперёк пальцев, навершие у большого)
  let staffTip = null, staffRig = null, ribbons = null;
  if (P.staff && bp.rightHand) {
    staffRig = buildStaff(THREE, mats, { style: P.staff.style || 'crown' });
    const holder = new THREE.Group(); holder.name = 'staff-holder';
    holder.add(staffRig.group);
    const slot = opts.grips && opts.grips.R;
    if (slot) {
      slot.add(holder);
      holder.scale.setScalar(1 / (slot.getWorldScale(new THREE.Vector3()).x || 1));
      try { compact(holder); } catch (e) { /* без склейки */ }
      holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      parts.push({ obj: holder, bone: slot, staff: true });
      names.push('staff');
    } else {
      // без слота (запасные клипы): вертикально в кулаке
      const hand = bp.rightHand.clone();
      const fing = bp.rightMiddleProximal || hand.clone().addScaledVector(UP, -0.08);
      stick(holder, 'rightHand', hand.clone().lerp(fing, 0.8), modelQ);
      parts[parts.length - 1].staff = true;
    }
    staffTip = staffRig.tip;
    // подвески под навершием: две золотые цепочки с огранёнными кристаллами — качаются от шага и каста
    try {
      const sg = staffRig.group, top = staffRig.top;
      sg.updateWorldMatrix(true, true);
      const c0 = new THREE.Object3D(), c1 = new THREE.Object3D();
      c0.position.set(0, top - 0.04, 0); c1.position.set(0, top - 0.7, 0); sg.add(c0, c1);
      const locks = [];
      for (const [a, len] of [[0.7, 0.16], [2.6, 0.11]]) {
        const pts = [];
        for (let i = 0; i < 6; i++) pts.push(sg.localToWorld(new THREE.Vector3(Math.cos(a) * 0.038, top + 0.05 - (i / 5) * len, -Math.sin(a) * 0.038)));
        locks.push({ pts, pin: 1, r0: 0.0028, r1: 0.0024, flat: 1, taper: 0, seed: a, tone: 1, stiff: 0.05, vScale: 3 });
      }
      const _rq = new THREE.Quaternion(), holderR = model || vrm.scene;
      ribbons = createStrands(THREE, { locks, anchor: sg, parent: holderR, colliders: [{ a: c0, b: c1, r: 0.024 }], material: mats.trim, drag: 0.8, carry: 0.45,
        fwd: (out) => out.set(0, 0, 1).applyQuaternion(holderR.getWorldQuaternion(_rq)) });
      ribbons.mesh.name = 'staff-charms';
      const pend = [];
      for (let i = 0; i < 2; i++) {
        const g = new THREE.Mesh(G(gemGeo(THREE, { r: i ? 0.0085 : 0.011, h: i ? 0.034 : 0.045, n: 6 })), mats.crystal);
        g.name = 'staff-charm'; holderR.add(g); pend.push(g);
      }
      ribbons.pendants = pend;
        } catch (e) { ribbons = null; }
  }

  // ---------------- лук за спиной (в бою — в кулаке левой) и колчан
  let bow = null, bowRig = null, arrow = null;
  const gearCaps = []; // снаряжение, которое плащ обтекает (колчан на бедре)
  const rT0 = torsoR - 0.018;
  if ((P.bow || P.quiver) && bp[chestB]) {
    if (P.bow) {
      bowRig = buildBow(THREE, mats, { len: 1.3 });
      const grp = bowRig.group;
      // тетива из двух половин (кончик → точка натяжения): при натяжении тянется к пальцам правой
      const strG = G(new THREE.CylinderGeometry(0.0014, 0.0014, 1, 4)); strG.translate(0, 0.5, 0);
      const strM = Mt(new THREE.MeshBasicMaterial({ name: 'gear-string', color: 0xf2e8d0 }));
      const strTop = new THREE.Mesh(strG, strM), strBot = new THREE.Mesh(strG, strM);
      strTop.name = 'bow-string-top'; strBot.name = 'bow-string-bot';
      grp.add(strTop, strBot);
      grp.userData.string = { top: strTop, bot: strBot, tipT: bowRig.tipT, tipB: bowRig.tipB };
      // стрела на тетиве (видна при натяжении)
      arrow = buildArrow(THREE, mats, { len: 0.78 }); arrow.name = 'arrow'; arrow.visible = false;
      grp.add(arrow);
      // за спиной по диагонали: верх — у левого плеча, тетива наружу (от спины)
      const diag = UP.clone().multiplyScalar(0.93).addScaledVector(LEFT, 0.42).normalize();
      const q = qFromTo(new THREE.Vector3(0, 1, 0), diag);
      const zNow = new THREE.Vector3(0, 0, 1).applyQuaternion(q), want = FWD.clone().negate();
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(diag, Math.atan2(zNow.clone().cross(want).dot(diag), zNow.dot(want))));
      stick(grp, chestB, bp[chestB].clone().addScaledVector(FWD, -(rT0 + (P.cape ? 0.09 : 0.035))).addScaledVector(UP, -0.04), q);
      bow = grp;
    }
    if (P.quiver) {
      const qv = buildQuiver(THREE, mats, { h: 0.5, arrows: 8 });
      if (P.quiver === 'hip' && bp.hips) {
        // на правом бедре, наклонён назад (плащ не мешает)
        const dir = UP.clone().addScaledVector(FWD, -0.35).addScaledVector(LEFT, -0.12).normalize();
        stick(qv, 'hips', bp.hips.clone().addScaledVector(LEFT, -0.17).addScaledVector(FWD, -0.05).addScaledVector(UP, -0.32), qFromTo(new THREE.Vector3(0, 1, 0), dir));
        // колчан — препятствие для плаща (ткань обтекает его, а не проходит насквозь)
        const q0 = new THREE.Object3D(), q1 = new THREE.Object3D();
        q0.position.set(0, 0.06, 0); q1.position.set(0, 0.62, 0); qv.add(q0, q1);
        gearCaps.push({ a: q0, b: q1, r: 0.07, name: 'quiver' });
      } else {
        // за спиной: оперение над правым плечом
        const dir = UP.clone().multiplyScalar(0.95).addScaledVector(LEFT, -0.32).normalize();
        stick(qv, chestB, bp[chestB].clone().addScaledVector(FWD, -(rT0 + 0.06)).addScaledVector(LEFT, 0.05).addScaledVector(UP, -0.3), qFromTo(new THREE.Vector3(0, 1, 0), dir));
      }
    }
  }

  // ---------------- плащ: ткань (modules/heroCloth.js) — прибит к плечам, падает, развевается на бегу,
  // не проходит сквозь ноги и корпус (капсулы по коже модели); вышитая кайма и герб (heroForge.capeTextures)
  let cloth = null, capeMat = null;
  if (P.cape && bp[chestB] && bp.hips && bp.leftUpperArm) {
    const { w, len, color, trim, emblem } = P.cape;
    // поверх копны волос по спине — корпус для ткани толще
    const colliders = bodyCaps.map((c) => ({ ...c, r: c.r + (hair && /hips|Chest|chest/.test(c.name) ? 0.03 : 0) })).concat(gearCaps);
    const rT = torsoR + (hair ? 0.03 : 0);
    // исходная форма: верх — дуга по плечам и загривку, ниже — полотно за спиной, книзу шире
    const cols = 13, rows = 18;
    const neck = bp.neck || bp[chestB].clone().addScaledVector(UP, 0.14);
    const shY = Math.max(bp.leftUpperArm.y, bp.rightUpperArm.y);
    const yTop = Math.max(shY + 0.035, neck.y - 0.035);
    const base = neck.clone().setY(yTop);
    const halfTop = shoulderW * 0.5 + 0.025;
    const rest = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) {
      const t = j / (rows - 1);
      for (let i = 0; i < cols; i++) {
        const u = (i / (cols - 1)) * 2 - 1;
        let p;
        if (j === 0) {
          p = base.clone().addScaledVector(LEFT, u * halfTop).addScaledVector(FWD, -rT * 0.72 * (1 - 0.6 * u * u) + 0.015 * u * u).addScaledVector(UP, 0.02 * (1 - u * u));
        } else {
          const hw = halfTop + (w * 0.5 - halfTop) * Math.sqrt(t);
          p = base.clone().addScaledVector(UP, -t * len).addScaledVector(LEFT, u * hw).addScaledVector(FWD, -(rT + 0.035) - 0.07 * t + 0.05 * u * u);
        }
        p.toArray(rest, (j * cols + i) * 3);
      }
    }
    const tx = capeTextures(THREE, { base: color, trim, glow: P.glow, emblem, key: preset });
    capeMat = Mt(new Std({
      name: 'gear-cape', color: 0xffffff, map: tx.map || null, bumpMap: tx.bump || null, bumpScale: 1.4,
      emissive: 0xffffff, emissiveMap: tx.emissive || null, emissiveIntensity: tx.emissive ? 1.1 : 0,
      roughness: 0.82, metalness: 0, side: THREE.DoubleSide,
      ...(physical ? { sheen: 0.8, sheenRoughness: 0.55, sheenColor: new THREE.Color(color).lerp(new THREE.Color(trim), 0.35).multiplyScalar(1.6) } : {}),
    }));
    // подкладка: изнанка плаща (сторона к телу) — шёлк своего цвета, без вышивки и свечения
    if (P.cape.lining) {
      const lin = { value: new THREE.Color(P.cape.lining) };
      const prevC = capeMat.onBeforeCompile;
      capeMat.onBeforeCompile = (sh, r) => {
        if (prevC) prevC.call(capeMat, sh, r);
        sh.uniforms.capeLining = lin;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 capeLining;')
          .replace('#include <map_fragment>', `#include <map_fragment>
  if ( gl_FrontFacing ) diffuseColor.rgb = capeLining * ( 0.8 + 0.4 * dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) );`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if ( gl_FrontFacing ) totalEmissiveRadiance *= 0.0;`);
      };
      const pk = capeMat.customProgramCacheKey;
      capeMat.customProgramCacheKey = () => 'capeLining:' + (pk ? pk.call(capeMat) : '');
    }
    const holder = model || vrm.scene;
    const _mq = new THREE.Quaternion();
    cloth = createCloth(THREE, {
      cols, rows, rest, anchor: raw(chestB), parent: holder, colliders, material: capeMat,
      pleats: 3.5, pleatDepth: w > 0.55 ? 0.016 : 0.012,
      hips: raw('hips'), back: { lim: 0.035, h: Math.max(0.2, bp[chestB].y - bp.hips.y) },
      fwd: (out) => out.set(0, 0, 1).applyQuaternion(holder.getWorldQuaternion(_mq)),
      floor: () => holder.getWorldPosition(new THREE.Vector3()).y,
    });
    names.push('cape-root');
    // воротник-валик по верху плаща (прячет край, где ткань прибита) и застёжки с цепью на груди
    const grp = new THREE.Group(); grp.name = 'cape-collar';
    const topPts = [];
    for (let i = 0; i < cols; i++) topPts.push(new THREE.Vector3().fromArray(rest, i * 3));
    const topCurve = new THREE.CatmullRomCurve3(topPts);
    grp.add(new THREE.Mesh(G(tube(THREE, topCurve, 40, 10, (v) => 0.024 * (0.75 + 0.25 * Math.sin(v * Math.PI)))), capeMat));
    const trimLine = new THREE.Mesh(G(tube(THREE, topCurve, 40, 6, () => 0.006)), mats.trim); trimLine.position.addScaledVector(UP, 0.012); grp.add(trimLine);
    const claspG = G(new THREE.CylinderGeometry(0.024, 0.024, 0.01, 16)), claspGem = G(new THREE.OctahedronGeometry(0.01));
    const ends = [topPts[0], topPts[cols - 1]].map((p) => p.clone().addScaledVector(FWD, 0.035).addScaledVector(UP, -0.03));
    for (const e of ends) {
      const clasp = new THREE.Mesh(claspG, mats.trim); clasp.position.copy(e); clasp.quaternion.copy(qFromTo(new THREE.Vector3(0, 1, 0), FWD)); grp.add(clasp);
      const cg = new THREE.Mesh(claspGem, mats.glow); cg.position.copy(e).addScaledVector(FWD, 0.009); grp.add(cg);
    }
    // цепь между застёжками: провисает на груди
    const chest = bp[chestB];
    const mid = chest.clone().addScaledVector(FWD, rT + 0.02).setY((ends[0].y + ends[1].y) / 2 - 0.09);
    const chain = new THREE.QuadraticBezierCurve3(ends[0].clone().addScaledVector(FWD, 0.005), mid, ends[1].clone().addScaledVector(FWD, 0.005));
    grp.add(new THREE.Mesh(G(tube(THREE, chain, 40, 5, () => 0.0035)), mats.trim));
    // группа собрана в мировых координатах: переносим начало в грудь и прикрепляем
    const c0 = chest.clone();
    for (const m of grp.children) m.position.sub(c0);
    grp.children.forEach((m) => m.updateMatrix());
    stick(grp, chestB, c0, new THREE.Quaternion());
  }

  // ---------------- кадр: ткань, свечение, LOD
  let t = 0, lodL = 0;
  const perf = { cloth: 0, hair: 0 }; // мс на кадр (скользящее среднее) — для QA
  const _pv = new THREE.Vector3(), _pd = new THREE.Vector3(), _pInv = new THREE.Matrix4(), _pDown = new THREE.Vector3(0, -1, 0);
  function update(dt) {
    t += dt;
    const now = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
    let t0 = now();
    if (cloth) { try { cloth.update(dt, lodL); } catch (e) { /* ткань не критична */ } }
    let t1 = now(); perf.cloth += (t1 - t0 - perf.cloth) * 0.1; t0 = t1;
    if (hair) { try { hair.update(dt, lodL); } catch (e) { /* пряди не критичны */ } }
    if (plume) { try { plume.update(dt, lodL); } catch (e) { /* плюмаж не критичен */ } }
    if (ribbons) {
      try {
        ribbons.update(dt, lodL);
        // кристаллы-подвески: на концах цепочек, остриём вниз по последнему звену
        const holderR = model || vrm.scene;
        holderR.updateWorldMatrix(true, false);
        _pInv.copy(holderR.matrixWorld).invert();
        ribbons.pendants.forEach((g, i) => {
          ribbons.tipOf(i, _pv); ribbons.tipDir(i, _pd);
          _pv.addScaledVector(_pd, 0.018);
          g.position.copy(_pv).applyMatrix4(_pInv);
          _pd.transformDirection(_pInv);
          g.quaternion.setFromUnitVectors(_pDown, _pd);
          g.rotateY(t * 1.3 + i);
        });
      } catch (e) { /* подвески не критичны */ }
    }
    t1 = now(); perf.hair += (t1 - t0 - perf.hair) * 0.1;
    if (staffRig) {
      staffRig.halo.rotation.y = t * 0.9;
      staffRig.shards.rotation.y = -t * 0.7;
      staffRig.shards.children.forEach((s, i) => { s.rotation.y = t * (1.2 + i * 0.3); s.position.y = (i - 1) * 0.02 + Math.sin(t * 1.6 + i * 2.1) * 0.012; });
      staffRig.crystal.rotation.y = t * 0.35;
      const pulse = 0.85 + 0.15 * Math.sin(t * 2.6) + 0.05 * Math.sin(t * 7.1);
      staffRig.core.scale.setScalar(pulse * (0.8 + 0.3 * glowNow));
      mats.core.opacity = Math.min(1, 0.55 + 0.3 * glowNow);
      mats.crystal.emissiveIntensity = 0.75 + 0.35 * glowNow + 0.1 * Math.sin(t * 2.6);
      if (staffRig.glint) {
        const tw = 0.5 + 0.5 * Math.sin(t * 1.9) * Math.sin(t * 3.3 + 1.1);
        staffRig.glint.scale.setScalar((0.12 + 0.12 * tw) * (0.8 + 0.3 * glowNow));
        mats.glint.rotation = t * 0.25;
        mats.glint.opacity = 0.45 + 0.55 * tw;
      }
    }
    mats.runeMetal.emissiveIntensity = (2.0 + Math.sin(t * 2.1) * 0.6) * glowNow;
    mats.glow.color.copy(glowBase).multiplyScalar(0.6 + 0.4 * glowNow);
    mats.inlay.color.copy(inlayBase).multiplyScalar((0.7 + 0.3 * Math.sin(t * 1.7)) * (0.6 + 0.4 * glowNow));
    if (capeMat) capeMat.emissiveIntensity = (0.8 + 0.25 * Math.sin(t * 1.3)) * Math.min(2, glowNow);
    if (visorMat) visorMat.opacity = Math.min(1, 0.55 + 0.25 * Math.sin(t * 3.3) + 0.3 * (glowNow - 1));
  }
  function setLod(l) {
    lodL = l;
    for (const p of parts) p.obj.traverse((o) => { if (o.isMesh) o.castShadow = l === 0; });
    if (cloth) { cloth.mesh.castShadow = l === 0; cloth.setWind(l >= 2 ? 0 : 1); }
    if (hair) hair.setWind(l >= 2 ? 0 : 1);
    if (plume) plume.setWind(l >= 2 ? 0 : 1);
    if (ribbons) { ribbons.setWind(l >= 2 ? 0 : 1); ribbons.mesh.castShadow = l === 0; }
  }

  // лук в кулаке левой (поза лука C5): узел хвата heroModel (центр кулака, y — вдоль большого пальца,
  // z — к лучнику); тетива — к пальцам правой по натяжению, стрела лежит на полке и смотрит в цель
  const bowHome = bow ? { parent: bow.parent, pos: bow.position.clone(), quat: bow.quaternion.clone(), scale: bow.scale.clone() } : null;
  let bowHeld = false;
  const _nk = new THREE.Vector3(), _sd = new THREE.Vector3(), _sq = new THREE.Quaternion(), _sY = new THREE.Vector3(0, 1, 0), _inv = new THREE.Matrix4(), _ws = new THREE.Vector3();
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
  if (bow) layString(bowRig.nockRest);
  function setBowHeld(on, grip, nockNode = null, draw = 0) {
    if (!bow || !bowHome) return;
    if (!on) {
      if (bowHeld) {
        bowHeld = false;
        bowHome.parent.add(bow); bow.position.copy(bowHome.pos); bow.quaternion.copy(bowHome.quat); bow.scale.copy(bowHome.scale);
        layString(bowRig.nockRest);
      }
      if (arrow) arrow.visible = false;
      return;
    }
    if (!grip) return;
    if (!bowHeld || bow.parent !== grip) {
      bowHeld = true;
      grip.add(bow); bow.position.set(0, 0, 0); bow.quaternion.identity();
      bow.scale.setScalar(1 / (grip.getWorldScale(_ws).x || 1));
    }
    if (nockNode && draw > 0.03) {
      bow.updateWorldMatrix(true, false);
      nockNode.getWorldPosition(_nk);
      _nk.applyMatrix4(_inv.copy(bow.matrixWorld).invert());
      _nk.x *= 0.25; _nk.y *= 0.4;                                     // тетива остаётся в плоскости лука
      _nk.lerp(bowRig.nockRest, 1 - Math.min(1, draw * 1.25));
      if (_nk.z < bowRig.nockRest.z) _nk.z = bowRig.nockRest.z;
      if (_nk.length() > 0.78) _nk.setLength(0.78);
      layString(_nk);
    } else { _nk.copy(bowRig.nockRest); layString(_nk); }
    if (arrow) {
      arrow.visible = draw > 0.03;
      if (arrow.visible) {
        // хвостовик — на тетиве, древко — через полку к цели
        arrow.position.copy(_nk);
        _sd.copy(bowRig.rest).sub(_nk).normalize();
        arrow.quaternion.setFromUnitVectors(_sY, _sd);
      }
    }
  }
  function dispose() {
    if (cloth) cloth.dispose();
    if (hair) hair.dispose();
    if (plume) plume.dispose();
    if (ribbons) { ribbons.dispose(); for (const g of ribbons.pendants || []) if (g.parent) g.parent.remove(g); }
    for (const p of parts) if (p.obj.parent) p.obj.parent.remove(p.obj);
    if (bow && bow.parent) bow.parent.remove(bow);
    for (const g of owned.geo) g.dispose();
    if (bowRig || staffRig) {
      const extra = new Set();
      for (const r of [bowRig && bowRig.group, staffRig && staffRig.group, arrow]) if (r) r.traverse((o) => { if (o.isMesh && o.geometry) extra.add(o.geometry); });
      for (const g of extra) g.dispose();
    }
    for (const m of owned.mat) { if (atmosphere && atmosphere.releaseEnv) { try { atmosphere.releaseEnv(m); } catch (e) { /* ignore */ } } m.dispose(); }
    parts.length = 0;
  }
  // качество: на 'low' — без sheen/clearcoat/anisotropy/transmission (дешёвый шейдер), выше — как было
  const physSaved = owned.mat.filter((m) => m.isMeshPhysicalMaterial).map((m) => ({ m, v: { sheen: m.sheen, clearcoat: m.clearcoat, anisotropy: m.anisotropy, transmission: m.transmission, iridescence: m.iridescence } }));
  // low — без всех; medium — только sheen (clearcoat/anisotropy/transmission/iridescence — на 'high')
  let qTier = null;
  function setQuality(q) {
    const tq = q === 'low' || q === 'high' ? q : 'medium';
    if (tq === qTier) return;
    qTier = tq;
    // на 'medium' — sheen у всех и анизотропный блик у волос (главное в образе героинь)
    for (const { m, v } of physSaved) for (const k of Object.keys(v)) m[k] = tq === 'high' || (tq === 'medium' && (k === 'sheen' || (k === 'anisotropy' && m.name === 'gear-hair'))) ? v[k] : 0;
  }
  setQuality(quality);
  const glowBase = mats.glow.color.clone(), inlayBase = mats.inlay.color.clone();
  let glowNow = 1;
  function setGlow(k) { glowNow = k; }
  return {
    names, staffTip, bow, cloth, perf, setGlow, get glow() { return glowNow; }, update, setLod, setQuality, setShading() {}, setBowHeld, dispose,
    parts: () => parts.map((p) => p.obj.name),
  };
}
