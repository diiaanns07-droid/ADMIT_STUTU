// ASHEN OATH — [W4-НАРЯДЫ] наряды героинь поверх снаряжения heroGear: свой силуэт, ткани, украшения.
//   Эльфийка  — многослойные полы-«лепестки» (ткань heroCloth с разрезами, собирает heroGear), наплечник
//               из трёх золотых листьев со светящейся жилкой, браслеты; без грубых наручей и наплечника костюма;
//   Чародейка — высокий стоячий воротник со звёздной вышивкой изнутри (обрамляет лицо), асимметричные полы
//               остриём (heroGear), серебряные манжеты, подвеска-тика на лбу;
//   Лучница   — корсет со шнуровкой и наручи — «оболочки» по коже модели (скиннинг тот же, что у куртки:
//               не протыкаются при движении), пелерина-накидка с зубчатым подолом (heroGear), заколка.
// Ткани — шёлк, бархат, кожа: sheen и анизотропный блик на medium/high (MeshPhysicalMaterial), на low —
// дешёвый ворс и отлив в шейдере (те же формулы для всех уровней — образ не «скачет»). Вышивка светится
// цветом стихии и вспыхивает с заклинанием (setGlow героя). Камни украшений — искры: одна точка на камень,
// все искры героини — один вызов отрисовки (medium/high).
// Бюджет: low — ≤ 2 новых материала на героиню; детали костюма, которые наряд заменяет (наручи, ремни,
// наплечник), скрыты — вызовов отрисовки не больше, чем было.
//
// export: dressAttire(ctx) → { names, update(dt, t, lod, glow), setLod(l), setQuality(q), dispose() }
//         fabricMaterial(THREE, o), hideBase(root, prefixes), skinShell(THREE, parts, o), ATTIRE_CFG

import { surface, tube, gem, glintTexture, corsetTextures, corsetTop, corsetBot, sharedTextures, CORSET_V, BRACE_V } from './heroForge.js';

// общие настройки нарядов (main.js → heroGear.configureGear): «Уменьшенное движение» — ткань спокойнее
export const ATTIRE_CFG = { reducedMotion: false };

const TAU = Math.PI * 2;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- ткани
// Ворс бархата (кромка силуэта светится в цвет ткани, сильнее со стороны ключевого света витрины) и отлив
// шёлка (широкий цветной блик) — поверх общего света героя (heroShading.patchHeroLight: heroKey*).
// o: { Mt, physical, name, tex: { map, bumpAlpha, emissive }, kind: 'silk'|'velvet'|'leather', color, sheen,
//      lining, alpha, emissiveK, side }
export function fabricMaterial(THREE, o) {
  const { Mt, physical = true, name = 'gear-fabric', tex = {}, kind = 'silk', color = 0xffffff, sheen = 0xffffff, lining = null, alpha = false, emissiveK = 1, side = THREE.DoubleSide } = o;
  const Std = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const velvet = kind === 'velvet', leather = kind === 'leather';
  const m = new Std({
    name, color, map: tex.map || null, bumpMap: tex.bumpAlpha || null, bumpScale: leather ? 1.3 : velvet ? 0.9 : 0.7,
    alphaMap: alpha && tex.bumpAlpha ? tex.bumpAlpha : null, alphaTest: alpha && tex.bumpAlpha ? 0.5 : 0,
    emissive: 0xffffff, emissiveMap: tex.emissive || null, emissiveIntensity: tex.emissive ? emissiveK : 0,
    roughness: velvet ? 0.88 : leather ? 0.58 : 0.4, metalness: 0, side,
    ...(physical ? {
      sheen: velvet ? 1 : leather ? 0.25 : 0.75, sheenRoughness: velvet ? 0.42 : leather ? 0.6 : 0.3, sheenColor: new THREE.Color(sheen),
      specularIntensity: velvet ? 0.22 : leather ? 0.5 : 0.7,
      ...(kind === 'silk' ? { anisotropy: 0.45, anisotropyRotation: Math.PI / 2 } : {}),
    } : {}),
  });
  Mt(m);
  const U = {
    fabTint: { value: new THREE.Color(sheen) },
    fabRim: { value: velvet ? 0.55 : leather ? 0.12 : 0.22 },
    fabRimP: { value: velvet ? 2.2 : 3.5 },
    fabSilk: { value: kind === 'silk' ? 0.32 : leather ? 0.12 : 0.05 },
    fabLining: { value: new THREE.Color(lining == null ? 0xffffff : lining) },
  };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(m, sh, r);
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 fabTint;\nuniform float fabRim;\nuniform float fabRimP;\nuniform float fabSilk;\nuniform vec3 fabLining;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  ${lining != null ? 'if ( gl_FrontFacing ) diffuseColor.rgb = fabLining * ( 0.8 + 0.4 * dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ) );' : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  ${lining != null ? 'if ( gl_FrontFacing ) totalEmissiveRadiance *= 0.0;' : ''}
  {
    vec3 fN = normal, fV = normalize( vViewPosition );
    float fNV = saturate( dot( fN, fV ) ), fNL = dot( fN, heroKeyDir );
    totalEmissiveRadiance += fabTint * diffuseColor.rgb * heroKeyColor * pow( 1.0 - fNV, fabRimP ) * ( 0.35 + 0.65 * saturate( fNL * 0.5 + 0.5 ) ) * fabRim;
    vec3 fH = normalize( heroKeyDir + fV );
    float fS = pow( saturate( dot( fN, fH ) ), 22.0 ) * saturate( fNL + 0.25 );
    totalEmissiveRadiance += heroKeyColor * mix( vec3( 1.0 ), diffuseColor.rgb * 1.6, 0.6 ) * fS * fabSilk;
  }`);
  };
  const pk = m.customProgramCacheKey;
  m.customProgramCacheKey = () => `fabric:${kind}:${lining != null}:` + (pk ? pk.call(m) : '');
  m.userData.fabric = { kind, base: emissiveK };
  return m;
}

// ---------------------------------------------------------------- детали костюма, которые наряд заменяет
export function hideBase(root, prefixes) {
  const hidden = [];
  if (prefixes && prefixes.length) root.traverse((o) => { if (o.isMesh && o.visible && prefixes.some((n) => o.name.startsWith(n))) { o.visible = false; hidden.push(o); } });
  return () => { for (const o of hidden) o.visible = true; hidden.length = 0; };
}

// ---------------------------------------------------------------- «оболочка» по коже модели
// Треугольники исходных SkinnedMesh, у которых все три вершины в области (uvOf(мир) → [u, v] | null),
// со сдвигом наружу по нормали на offset (м). Скиннинг (кости и веса) — исходный: одежда-оболочка
// гнётся вместе с курткой и не протыкается. Части с одним набором костей склеиваются в один меш.
// parts: [{ mesh, uvOf }] → [SkinnedMesh] (добавлены рядом с исходником, тот же transform)
export function skinShell(THREE, parts, { offset = 0.005, material, name = 'attire-shell', host = null } = {}) {
  const groups = [];   // { skel, bindMatrix, src, pos, nor, uv, si, sw }
  const v = new THREE.Vector3(), w = new THREE.Vector3(), mInv = new THREE.Matrix4(), mBind = new THREE.Matrix4(), nm = new THREE.Matrix3();
  for (const p of parts) {
    const src = p.mesh;
    if (!src || !src.isSkinnedMesh || !src.geometry.attributes.skinIndex) continue;
    src.updateWorldMatrix(true, false);
    // кости исходника → индексы общего скелета группы (кости — те же объекты, обратные матрицы совпадают)
    let G = null, remap = null;
    for (const g of groups) {
      const rm = src.skeleton.bones.map((b) => g.skel.bones.indexOf(b));
      const same = rm.every((i, k) => i >= 0 && g.skel.boneInverses[i].equals(src.skeleton.boneInverses[k]));
      if (same) { G = g; remap = rm; break; }
    }
    if (!G) { G = { skel: src.skeleton, bindMatrix: src.bindMatrix.clone(), src, pos: [], nor: [], uv: [], si: [], sw: [] }; groups.push(G); remap = src.skeleton.bones.map((_, k) => k); }
    // геометрия исходника → пространство привязки группы
    mBind.copy(G.bindMatrix).invert().multiply(src.bindMatrix);
    nm.getNormalMatrix(mBind);
    const geo = src.geometry, PA = geo.attributes.position, NA = geo.attributes.normal, SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight;
    const n = PA.count, uv = new Array(n);
    // масштаб «геометрия → мир» (сдвиг по нормали задан в метрах)
    let sg = 0, sw2 = 0;
    for (let i = 0; i + 7 < n && sw2 < 40; i += Math.max(1, Math.floor(n / 60))) {
      src.getVertexPosition(i, v).applyMatrix4(src.matrixWorld); src.getVertexPosition(i + 7, w).applyMatrix4(src.matrixWorld);
      const dw = v.distanceTo(w); v.fromBufferAttribute(PA, i); w.fromBufferAttribute(PA, i + 7);
      const dg = v.distanceTo(w);
      if (dg > 1e-6 && dw > 1e-6) { sg += dw / dg; sw2++; }
    }
    const k = sw2 ? sg / sw2 : 1, off = offset / k;
    for (let i = 0; i < n; i++) { src.getVertexPosition(i, v).applyMatrix4(src.matrixWorld); uv[i] = p.uvOf(v, i); }
    const idx = geo.index, tri = idx ? idx.count / 3 : n / 3;
    for (let t = 0; t < tri; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3, b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      if (!uv[a] || !uv[b] || !uv[c]) continue;
      // все три вершины по одну сторону контура (3-й элемент uv: −1 ниже, +1 выше) — треугольник прозрачен целиком
      if (uv[a][2] && uv[a][2] === uv[b][2] && uv[b][2] === uv[c][2]) continue;
      let ua = uv[a][0], ub = uv[b][0], uc = uv[c][0];
      // шов развёртки: треугольник через u = 0/1 — дальние вершины на +1 (текстура повторяется по u)
      if (Math.max(ua, ub, uc) - Math.min(ua, ub, uc) > 0.5) { if (ua < 0.5) ua += 1; if (ub < 0.5) ub += 1; if (uc < 0.5) uc += 1; }
      for (const [q, u] of [[a, ua], [b, ub], [c, uc]]) {
        w.fromBufferAttribute(NA, q).applyMatrix3(nm).normalize();
        v.fromBufferAttribute(PA, q).applyMatrix4(mBind).addScaledVector(w, off);
        G.pos.push(v.x, v.y, v.z); G.nor.push(w.x, w.y, w.z); G.uv.push(u, uv[q][1]);
        for (let j = 0; j < 4; j++) { G.si.push(Math.max(0, remap[SI.getComponent(q, j)])); G.sw.push(SW.getComponent(q, j)); }
      }
    }
  }
  const out = [];
  for (const G of groups) {
    if (!G.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(G.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(G.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(G.sw, 4));
    const m = new THREE.SkinnedMesh(g, material);
    // без тени и без остаточных образов рывка (у образа нет альфы — корсет вышел бы сплошной лентой)
    m.name = name; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true; m.userData.noShadow = true; m.userData.noGhost = true;
    m.bindMode = G.src.bindMode;
    // привязка «attached»: положение меша не важно (bindMatrixInverse = его matrixWorld⁻¹) — можно жить вне
    // сцены модели (её LOD включает тени всем своим мешам); «detached» — рядом с исходником, тот же transform
    if (host && m.bindMode === THREE.AttachedBindMode) host.add(m);
    else { G.src.parent.add(m); m.position.copy(G.src.position); m.quaternion.copy(G.src.quaternion); m.scale.copy(G.src.scale); }
    m.updateMatrixWorld(true);
    m.bind(G.skel, G.bindMatrix);
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------- лучи по коже (радиусы, точки поверхности)
function skinMeshes(root, skip = /Eye|Brow/i) {
  const out = [];
  root.traverse((o) => { if (o.isSkinnedMesh && o.visible && !skip.test(o.name)) out.push(o); });
  return out;
}
// расстояние от точки c до поверхности по направлению dir (луч снаружи внутрь); null — промах
function surfaceDist(THREE, rc, meshes, c, dir, far = 0.45) {
  rc.set(c.clone().addScaledVector(dir, far), dir.clone().negate()); rc.far = far;
  const hit = rc.intersectObjects(meshes, false)[0];
  return hit ? far - hit.distance : null;
}

// ---------------------------------------------------------------- наплечник из листьев (эльфийка)
// Три листа на сфере купола плеча: средний — от загривка через плечо вниз по руке, боковые — веером вперёд
// и назад, короче и ниже. Сечение — «линза» (тонкий край, выпуклая жилка), кончики чуть отогнуты наружу.
// Жилка по середине — светящаяся вставка цвета стихии; у основания — камень в оправе.
function leafPauldron(ctx, side) {
  const { THREE, mats, G, bp, UP, LEFT, FWD, vrm, quality } = ctx;
  const up = bp[side + 'UpperArm'], lo = bp[side + 'LowerArm'];
  if (!up || !lo) return null;
  const s = side === 'left' ? 1 : -1, out = LEFT.clone().multiplyScalar(s);
  const armDir = lo.clone().sub(up).normalize();
  const A = UP.clone().multiplyScalar(0.85).addScaledVector(out, 0.35).normalize();
  const B = armDir.clone().multiplyScalar(0.55).addScaledVector(out, 0.45); B.addScaledVector(A, -B.dot(A)).normalize();
  const C = up.clone().addScaledVector(out, -0.012).addScaledVector(UP, -0.004);
  // радиус купола — по коже и костюму (лучи из-за купола к центру), с запасом
  const rc = new THREE.Raycaster(), meshes = skinMeshes(vrm.scene);
  let Rd = 0.07;
  try {
    for (const d of [A, A.clone().add(B).normalize(), B, A.clone().addScaledVector(FWD, 0.7).normalize(), A.clone().addScaledVector(FWD, -0.7).normalize(), A.clone().addScaledVector(B, -0.6).normalize()]) {
      const r = surfaceDist(THREE, rc, meshes, C, d);
      if (r !== null && r < 0.16) Rd = Math.max(Rd, r);
    }
  } catch (e) { /* без лучей — по умолчанию */ }
  Rd += 0.011;
  const grp = new THREE.Group(); grp.name = `leaf-pauldron-${side}`;
  const leaves = [
    { psi: 0, len: 0.21, w: 0.064, lift: 0.007, ph0: -0.55 },
    { psi: 0.68, len: 0.16, w: 0.05, lift: 0.002, ph0: -0.3 },
    { psi: -0.68, len: 0.16, w: 0.05, lift: 0.002, ph0: -0.3 },
  ];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _s = new THREE.Vector3(), d = new THREE.Vector3();
  const inlayG = [];
  for (const L of leaves) {
    // ось листа: B, повёрнутая вокруг A на psi (веер); S — поперёк листа
    const Bk = B.clone().applyAxisAngle(A, L.psi * s), Sk = A.clone().cross(Bk).normalize();
    const R = Rd + L.lift;
    const at = (x, y, z, outV) => {
      const lam = x / R, ph = L.ph0 + y / R;
      d.copy(A).multiplyScalar(Math.cos(ph)).addScaledVector(Bk, Math.sin(ph));
      _a.copy(d).multiplyScalar(Math.cos(lam)).addScaledVector(Sk, Math.sin(lam));
      const tip = Math.max(0, y / L.len - 0.7) / 0.3;
      return outV.copy(C).addScaledVector(_a, R + z + 0.012 * tip * tip).sub(C);
    };
    const hw = (vv) => L.w * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(vv, 0.8))), 0.8) * (1 - 0.1 * vv) + 0.0008;
    const th = (vv) => 0.0022 + 0.0024 * Math.sin(Math.PI * vv);
    const geo = surface(THREE, (u, vv, o) => {
      const a = u * TAU, cs = Math.cos(a), sn = Math.sin(a);
      const x = hw(vv) * Math.sign(cs) * Math.pow(Math.abs(cs), 0.7);
      const ridge = 0.0016 * Math.max(0, 1 - Math.abs(x) / (hw(vv) * 0.35 + 1e-4));
      const z = sn > 0 ? th(vv) * sn + ridge * sn : th(vv) * 0.35 * sn;
      return at(x, vv * L.len, z, o);
    }, 10, 16);
    grp.add(new THREE.Mesh(G(geo), mats.trim));
    // жилка: узкая полоса над гребнем
    if (quality !== 'low') {
      inlayG.push(surface(THREE, (u, vv, o) => at((u - 0.5) * 0.0028 * (1 - vv * 0.7), (0.06 + 0.84 * vv) * L.len, th(0.06 + 0.84 * vv) + 0.0024, o), 1, 14, { closedU: false }));
    }
  }
  for (const g of inlayG) grp.add(new THREE.Mesh(G(g), mats.inlay));
  // камень в оправе у основания листьев
  const base = new THREE.Vector3().copy(A).multiplyScalar(Math.cos(-0.2)).addScaledVector(B, Math.sin(-0.2)).multiplyScalar(Rd + 0.006);
  const ring = new THREE.Mesh(G(new THREE.TorusGeometry(0.0085, 0.0022, 6, 16)), mats.trim);
  ring.position.copy(base); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), base.clone().normalize());
  const st = new THREE.Mesh(G(gem(THREE, { r: 0.0065, h: 0.016, n: 6 })), mats.crystal);
  st.position.copy(base).addScaledVector(base.clone().normalize(), 0.002); st.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), base.clone().normalize());
  grp.add(ring, st);
  const glint = new THREE.Object3D(); glint.name = 'glint'; glint.position.copy(base).addScaledVector(base.clone().normalize(), 0.012); grp.add(glint);
  void _b; void _s;
  return { grp, at: C, glint };
}

// ---------------------------------------------------------------- высокий воротник (чародейка)
// Стоячий веер из бархата за головой: от плеч к затылку выше, спереди открыт (лицо и пряди свободны),
// по верху — пять зубцов-«корон», кант серебром сверху и снизу. Радиус — по капюшону, волосам и коже
// с запасом (голова поворачивается внутри). Лицевая сторона (снаружи) — гладкий бархат подкладки,
// изнутри — звёздная вышивка полотнищ (тот же материал panelMat), она и светится, обрамляя лицо.
function highCollar(ctx, spec) {
  const { THREE, mats, G, bp, UP, LEFT, FWD, vrm, holder, chestB, shoulderW } = ctx;
  if (!bp.neck || !bp[chestB]) return null;
  const neck = bp.neck, shY = Math.max(bp.leftUpperArm ? bp.leftUpperArm.y : neck.y - 0.08, bp.rightUpperArm ? bp.rightUpperArm.y : neck.y - 0.08);
  const y0 = Math.max(shY + 0.02, neck.y - 0.05), Hm = spec.h || 0.2, a0 = spec.open || 0.95;
  // радиусы по секторам вокруг оси шеи на высотах воротника: капюшон, волосы, кожа
  const SEC = 32, rS = new Float32Array(SEC);
  const v = new THREE.Vector3();
  const scan = (o) => {
    const pa = o.geometry && o.geometry.attributes.position;
    if (!pa) return;
    const step = Math.max(1, Math.floor(pa.count / 4000));
    for (let i = 0; i < pa.count; i += step) {
      if (o.isSkinnedMesh) o.getVertexPosition(i, v); else v.fromBufferAttribute(pa, i);
      v.applyMatrix4(o.matrixWorld);
      if (v.y < y0 + 0.02 || v.y > y0 + Hm * 0.9) continue;
      v.sub(neck);
      const f = v.dot(FWD), l = v.dot(LEFT), r = Math.hypot(f, l);
      if (r > 0.135) continue;   // плечи и спина ниже — не в счёт: воротник облегает шею и капюшон
      const k = Math.floor(((Math.atan2(l, f) + TAU) % TAU) / TAU * SEC) % SEC;   // азимут 0 — перед, как в rBase(az)
      rS[k] = Math.max(rS[k], r);
    }
  };
  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse((o) => { if (o.isMesh && o.visible && !/Eye|Brow|Arms|Bracer|Pauldron/i.test(o.name) && (o.isSkinnedMesh || /hair/i.test(o.name))) scan(o); });
  if (holder !== vrm.scene) holder.traverse((o) => { if (o.isMesh && o.visible && /hair/i.test(o.name)) scan(o); });
  const rBase = (az) => {
    const x = ((az % TAU) + TAU) % TAU / TAU * SEC;
    let r = 0;
    for (let d = -2; d <= 2; d++) r = Math.max(r, rS[((Math.floor(x) + d) % SEC + SEC) % SEC] * (1 - Math.abs(d) * 0.04));
    return Math.min(0.13, Math.max(r, 0.075)) + 0.02;
  };
  const span = TAU - 2 * a0, NU = 48;
  const rB = Array.from({ length: NU + 1 }, (_, i) => rBase(a0 + span * (i / NU)));
  // сглаживание по кругу (без выбросов)
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < NU; i++) rB[i] = (rB[i - 1] + 2 * rB[i] + rB[i + 1]) / 4;
  const Hof = (u) => {
    const az = a0 + span * u;
    const crown = Math.pow(Math.max(0, Math.cos(5 * (az - Math.PI))), 10) * 0.07;
    return Hm * (0.35 + 0.65 * Math.pow(Math.sin(az / 2), 3)) * (1 + crown) * (0.7 + 0.3 * sstep(0, 0.25, Math.min(u, 1 - u)));
  };
  const flare = spec.flare ?? 0.06;
  const P = (u, vv, o) => {
    const az = a0 + span * u, i = Math.min(NU, Math.round(u * NU));
    const r = rB[i] + flare * Math.pow(vv, 1.5) * (0.6 + 0.4 * Math.pow(Math.sin(az / 2), 2));
    return o.copy(neck).setY(y0).addScaledVector(UP, vv * Hof(u)).addScaledVector(FWD, Math.cos(az) * r - 0.025 * vv).addScaledVector(LEFT, Math.sin(az) * r);
  };
  const geo = surface(THREE, P, NU, 6, { closedU: false });
  // развёртка: поперёк полосы вышивки — высота воротника, вдоль — обход
  const ua = geo.attributes.uv;
  for (let k = 0; k < ua.count; k++) { const u = ua.getX(k), vv = ua.getY(k); ua.setXY(k, 0.06 + 0.88 * vv, 0.2 + 0.72 * u); }
  const c0 = bp[chestB].clone();
  const pa = geo.attributes.position;
  for (let k = 0; k < pa.count; k++) pa.setXYZ(k, pa.getX(k) - c0.x, pa.getY(k) - c0.y, pa.getZ(k) - c0.z);
  const grp = new THREE.Group(); grp.name = 'attire-collar';
  const mesh = new THREE.Mesh(G(geo), spec.material); mesh.name = 'attire-collar-mesh';
  grp.add(mesh);
  // кант сверху и снизу
  const edge = (vv, n) => { const pts = []; for (let i = 0; i <= n; i++) pts.push(P(i / n, vv, new THREE.Vector3()).sub(c0)); return new THREE.CatmullRomCurve3(pts); };
  grp.add(new THREE.Mesh(G(tube(THREE, edge(1, 40), 84, 5, () => 0.0032)), mats.trim));
  grp.add(new THREE.Mesh(G(tube(THREE, edge(0, 24), 40, 5, () => 0.004)), mats.trim));
  // звезда-камень на центральном зубце (сзади) — искра
  const top = P(0.5, 1, new THREE.Vector3()).sub(c0);
  const st = new THREE.Mesh(G(gem(THREE, { r: 0.008, h: 0.024, n: 6 })), mats.crystal); st.position.copy(top).addScaledVector(UP, 0.012); grp.add(st);
  const glint = new THREE.Object3D(); glint.name = 'glint'; glint.position.copy(top).addScaledVector(UP, 0.014).addScaledVector(FWD, -0.01); grp.add(glint);
  void shoulderW;
  return { grp, at: c0, glint, mesh };
}

// ---------------------------------------------------------------- край капюшона у лица (для заколок и тики)
// Самые передние вершины капюшона по направлениям вокруг лица: ph — угол в плоскости «влево–вверх»
// от центра у переносицы (0 — левый висок, π/2 — над лбом). → rimAt(ph) | null
function hoodRim(THREE, vrm, head, LEFT, UP, FWD) {
  let hood = null;
  vrm.scene.traverse((o) => { if (o.isMesh && /Hood/i.test(o.name) && o.visible) hood = o; });
  if (!hood) return null;
  const cy = 0.08, B = 36, best = new Array(B).fill(null), v = new THREE.Vector3(), pa = hood.geometry.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    hood.getVertexPosition(i, v); v.applyMatrix4(hood.matrixWorld).sub(head);
    const x = v.dot(LEFT), y = v.dot(UP), z = v.dot(FWD);
    let ph = Math.atan2(y - cy, x); if (ph < -Math.PI / 2) ph += TAU;
    const b = Math.floor(((ph + Math.PI / 2) / TAU) * B) % B;
    if (!best[b] || z > best[b].z) best[b] = { x, y, z };
  }
  return (ph) => {
    const b = Math.floor((((ph + Math.PI / 2) % TAU + TAU) % TAU / TAU) * B) % B;
    const p = best[b] || best[(b + 1) % B] || best[(b + B - 1) % B];
    return p ? head.clone().addScaledVector(LEFT, p.x).addScaledVector(UP, p.y).addScaledVector(FWD, p.z) : null;
  };
}

// заколка с камнем на краю капюшона у виска: две лепестковые пластинки и камень (лицом к камере)
function rimPin(ctx, at, outDir, kind = 'leaf') {
  const { THREE, mats, G, UP, FWD } = ctx;
  const grp = new THREE.Group(); grp.name = 'attire-pin';
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), outDir);
  const blade = (ang, len, wid) => {
    const g = surface(THREE, (u, vv, o) => {
      const a = u * TAU, x = wid * Math.pow(Math.sin(Math.PI * Math.pow(vv, 0.8)), 0.8) * Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.7), z = 0.0012 * Math.sin(a);
      return o.set(x, vv * len, z + 0.004 * vv * vv);
    }, 8, 8);
    const m = new THREE.Mesh(G(g), mats.trim);
    m.rotation.z = ang; return m;
  };
  const inner = new THREE.Group();
  if (kind === 'star') { for (let i = 0; i < 4; i++) inner.add(blade((i / 4) * TAU, 0.014, 0.0045)); }
  else { inner.add(blade(0.5, 0.026, 0.008), blade(-0.35, 0.02, 0.007), blade(2.6, 0.016, 0.006)); }
  const st = new THREE.Mesh(G(gem(THREE, { r: 0.0055, h: 0.014, n: 6 })), mats.crystal); st.rotation.x = Math.PI / 2; st.position.z = 0.003;
  inner.add(st);
  inner.quaternion.copy(q);
  grp.add(inner);
  const glint = new THREE.Object3D(); glint.name = 'glint'; glint.position.copy(outDir).multiplyScalar(0.01); grp.add(glint);
  void UP; void FWD;
  return { grp, at, glint };
}

// тика: цепочка с края капюшона над лбом и капля-камень на лбу поверх чёлки
function tikka(ctx, rim, head) {
  const { THREE, mats, G, UP, FWD } = ctx;
  const a = rim(Math.PI / 2);
  if (!a) return null;
  const top = a.clone().addScaledVector(FWD, 0.004);
  const drop = top.clone().addScaledVector(UP, -0.045).addScaledVector(FWD, 0.014);
  const grp = new THREE.Group(); grp.name = 'attire-tikka';
  const mid = top.clone().lerp(drop, 0.5).addScaledVector(FWD, 0.006);
  grp.add(new THREE.Mesh(G(tube(THREE, new THREE.QuadraticBezierCurve3(top.clone().sub(head), mid.clone().sub(head), drop.clone().sub(head)), 16, 4, () => 0.0009)), mats.trim));
  const setting = new THREE.Mesh(G(new THREE.TorusGeometry(0.0062, 0.0016, 6, 14)), mats.trim);
  setting.position.copy(drop).sub(head).addScaledVector(UP, -0.008); setting.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), FWD); setting.scale.set(0.8, 1.2, 1);
  const st = new THREE.Mesh(G(gem(THREE, { r: 0.005, h: 0.02, n: 6 })), mats.crystal);
  st.position.copy(drop).sub(head).addScaledVector(UP, -0.009).addScaledVector(FWD, 0.002); st.rotation.z = Math.PI;
  grp.add(setting, st);
  const glint = new THREE.Object3D(); glint.name = 'glint'; glint.position.copy(drop).sub(head).addScaledVector(UP, -0.008).addScaledVector(FWD, 0.009); grp.add(glint);
  return { grp, at: head.clone(), glint };
}

// браслеты/манжеты на запястьях: радиус — по рукаву у запястья (вершины у сечения), n колец
function wristRings(ctx, side, spec) {
  const { THREE, mats, G, bp, vrm } = ctx;
  const lo = bp[side + 'LowerArm'], hd = bp[side + 'Hand'];
  if (!lo || !hd) return null;
  const ax = hd.clone().sub(lo), L = ax.length(); ax.normalize();
  const c = lo.clone().addScaledVector(ax, L * (spec.at ?? 0.86));
  let r = 0.03;
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !/Arms/.test(o.name) || /Bracer/.test(o.name)) return;
    const pa = o.geometry.attributes.position;
    for (let i = 0; i < pa.count; i += 2) {
      o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld).sub(c);
      const along = v.dot(ax);
      if (Math.abs(along) > 0.012) continue;
      const rr = Math.sqrt(Math.max(0, v.lengthSq() - along * along));
      if (rr < 0.07) r = Math.max(r, rr);
    }
  });
  const grp = new THREE.Group(); grp.name = `attire-wrist-${side}`;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax);
  (spec.rings || [[0, 0.0032], [0.014, 0.0022]]).forEach(([dy, tr]) => {
    const ring = new THREE.Mesh(G(new THREE.TorusGeometry(r + 0.003 + tr, tr, 5, 20)), mats.trim);
    ring.quaternion.copy(q); ring.position.copy(ax).multiplyScalar(-dy);
    grp.add(ring);
  });
  return { grp, at: c, bone: side + 'LowerArm' };
}

// ---------------------------------------------------------------- искры камней: одна точка на камень
function sparkles(THREE, anchors, color, holder) {
  const n = anchors.length;
  if (!n) return null;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.PointsMaterial({ name: 'gear-sparkle', map: glintTexture(THREE), size: 0.055, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'attire-sparkles'; pts.frustumCulled = false; pts.renderOrder = 4;
  holder.add(pts);
  const base = new THREE.Color(color).lerp(new THREE.Color(1, 1, 1), 0.45);
  const v = new THREE.Vector3(), inv = new THREE.Matrix4();
  const ph = anchors.map((_, i) => ({ w: 1.3 + ((i * 0.618) % 1) * 1.7, p: i * 2.39 }));
  return {
    points: pts, material: mat,
    update(t, glow) {
      holder.updateWorldMatrix(true, false);
      inv.copy(holder.matrixWorld).invert();
      for (let i = 0; i < n; i++) {
        anchors[i].getWorldPosition(v).applyMatrix4(inv);
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        // вспышка: короткий острый пик раз в 2–5 с и слабое мерцание между ними; с заклинанием — ярче
        const s = Math.sin(t * ph[i].w + ph[i].p), s2 = Math.sin(t * ph[i].w * 2.3 + ph[i].p * 1.7);
        const tw = 1.1 * Math.pow(Math.max(0, s), 10) + 0.45 * Math.pow(Math.max(0, s2), 6) + 0.3 + 0.08 * Math.sin(t * 7.3 + i);
        const k = tw * (0.75 + 0.45 * Math.min(2.4, glow));
        col[i * 3] = base.r * k; col[i * 3 + 1] = base.g * k; col[i * 3 + 2] = base.b * k;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    },
    dispose() { if (pts.parent) pts.parent.remove(pts); geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------- сборка наряда
// ctx — из heroGear.dressHero: { THREE, vrm, P, mats, Mt, G, stick, raw, bp, bodyCaps, FWD, LEFT, UP, modelQ,
//   holder, physical, quality, chestB, torsoR, shoulderW, parts, panelMat, glowHex }
export function dressAttire(ctx) {
  const { THREE, vrm, P, stick, bp, FWD, LEFT, UP, holder, physical, quality } = ctx;
  const A = P.attire || {};
  const names = [], owned = { mats: [], rel: [], shells: [] }, glints = [], extras = [];   // extras — детали только для medium/high
  const fabrics = [];
  const add = (r, bone, high = false) => {
    if (!r) return null;
    stick(r.grp, bone, r.at, new THREE.Quaternion());   // имя детали записывает сам stick (heroGear)
    if (r.glint) glints.push(r.glint);
    if (high) extras.push(r.grp);
    return r;
  };
  // эльфийка: наплечник-лист (левое плечо — рука с луком) и браслеты
  if (A.leafPauldron) add(leafPauldron(ctx, A.leafPauldron === 'right' ? 'right' : 'left'), (A.leafPauldron === 'right' ? 'right' : 'left') + 'UpperArm');
  if (A.wrists) for (const side of ['left', 'right']) { const r = wristRings(ctx, side, A.wrists); if (r) add(r, r.bone, true); }
  // чародейка: высокий воротник (материал — звёздная вышивка полотнищ)
  if (A.collar && ctx.panelMat) add(highCollar(ctx, { ...A.collar, material: ctx.panelMat }), ctx.chestB);
  // украшения у края капюшона: заколка у виска, тика на лбу
  if ((A.pin || A.tikka) && bp.head) {
    const rim = hoodRim(THREE, vrm, bp.head, LEFT, UP, FWD);
    if (rim && A.pin) {
      const ph = A.pin.side === 'right' ? Math.PI * 0.82 : Math.PI * 0.18;
      const p = rim(ph);
      if (p) { const out = p.clone().sub(bp.head).normalize().addScaledVector(FWD, 0.6).normalize(); add(rimPin(ctx, p.clone().addScaledVector(out, 0.004), out, A.pin.kind), 'head', true); }
    }
    if (rim && A.tikka) add(tikka(ctx, rim, bp.head), 'head', true);
  }
  // лучница: корсет и наручи — оболочки по куртке и рукавам (общий атлас и материал)
  if (A.corset && bp.hips && bp[ctx.chestB]) {
    const C = A.corset;
    const sz = quality === 'low' ? 256 : 512;
    const tx = sharedTextures(`corset:${C.leather}:${C.thread}:${C.metal}:${P.glow}:${sz}`, () => corsetTextures(THREE, { leather: C.leather, thread: C.thread, metal: C.metal, glow: P.glow, size: sz }));
    owned.rel.push(tx.release);
    const m = fabricMaterial(THREE, { Mt: ctx.Mt, physical, name: 'gear-corset', tex: tx.tex, kind: 'leather', sheen: C.sheen || 0xc8a070, alpha: true, emissiveK: 0.9, side: THREE.FrontSide });
    fabrics.push(m);
    const hips = bp.hips, chest = bp[ctx.chestB];
    const yLo = hips.y + (C.lo ?? 0.035), yHi = chest.y + (C.hi ?? 0.02);
    const span = CORSET_V[1] - CORSET_V[0];
    const uAz = (wp) => { const d = wp.clone().sub(hips); return 0.5 + Math.atan2(d.dot(LEFT), d.dot(FWD)) / TAU; };
    const corsetUV = (wp) => {
      const vh = (wp.y - yLo) / (yHi - yLo);
      if (vh < -0.3 || vh > 1.3) return null;
      const u = uAz(wp), side = vh < corsetBot(u) - 0.03 ? -1 : vh > corsetTop(u) + 0.03 ? 1 : 0;
      return [u, CORSET_V[0] + 0.002 + span * Math.min(1, Math.max(0, vh)) * 0.996, side];
    };
    const parts = [];
    vrm.scene.traverse((o) => { if (o.isSkinnedMesh && /Body$|Body_?\d*$/.test(o.name) && !/Belt/.test(o.name) && o.visible) parts.push({ mesh: o, uvOf: corsetUV }); });
    // наручи: от 8% до 90% предплечья, u — вокруг (0.5 — тыльная сторона, шов со шнуровкой — внутри)
    for (const side of ['left', 'right']) {
      const lo = bp[side + 'LowerArm'], hd = bp[side + 'Hand'];
      if (!lo || !hd || !A.bracers) continue;
      const ax = hd.clone().sub(lo), L = ax.length(); ax.normalize();
      const s = side === 'left' ? 1 : -1;
      const lat = LEFT.clone().multiplyScalar(s); lat.addScaledVector(ax, -lat.dot(ax)).normalize();
      const bn = ax.clone().cross(lat);
      const bspan = BRACE_V[1] - BRACE_V[0];
      const uvOf = (wp) => {
        const d = wp.clone().sub(lo), along = d.dot(ax) / L;
        if (along < 0.02 || along > 0.98) return null;
        const radial = d.clone().addScaledVector(ax, -d.dot(ax)).length();
        if (radial > 0.075) return null;
        const t = Math.min(1, Math.max(0, (0.92 - along) / 0.84));          // 0 — запястье, 1 — к локтю
        return [0.5 + Math.atan2(d.dot(bn) * s, d.dot(lat)) / TAU, BRACE_V[0] + 0.002 + bspan * t * 0.996];
      };
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh && /Arms/.test(o.name) && !/Bracer/.test(o.name) && o.visible) parts.push({ mesh: o, uvOf, side }); });
    }
    // область корсета не должна захватить рукава, наручей — куртку: свой uvOf на свой меш
    const shells = skinShell(THREE, parts, { offset: C.offset ?? 0.006, material: m, name: 'attire-corset', host: holder !== vrm.scene ? holder : null });
    for (const sh of shells) { owned.shells.push(sh); names.push(sh.name); }
  }
  // искры камней: новые украшения и камни снаряжения героинь (кулон, серьги, обруч)
  for (const pr of ctx.parts) {
    if (!/^(necklace|circlet|elf-ear-[lr]-grp)$/.test(pr.obj.name)) continue;
    pr.obj.traverse((o) => {
      if (!o.isMesh || !(o.material === ctx.mats.crystal || /circlet-gem/.test(o.material.name))) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const g = new THREE.Object3D(); g.name = 'glint';
      g.position.copy(o.geometry.boundingSphere.center).applyMatrix4(o.matrix);
      // чуть вперёд от камня: искра не прячется в собственной огранке
      const fw = FWD.clone().transformDirection(new THREE.Matrix4().copy(o.parent.matrixWorld).invert());
      g.position.addScaledVector(fw, 0.008 / (o.parent.getWorldScale(new THREE.Vector3()).x || 1));
      o.parent.add(g); glints.push(g); extras.push(g);
    });
  }
  let spark = null;
  if (glints.length && A.sparkles !== false) {
    spark = sparkles(THREE, glints, ctx.glowHex, holder);
    if (spark) names.push('attire-sparkles');
  }
  // уровни качества: на low — без мелких украшений и искр
  let lodL = 0, qTier = null;
  const vis = () => {
    const on = qTier !== 'low';
    for (const o of extras) if (o.isObject3D && o.type !== 'Object3D') o.visible = on;
    if (spark) spark.points.visible = on && lodL < 1;
  };
  function setQuality(q) { qTier = q === 'low' || q === 'high' ? q : 'medium'; vis(); }
  setQuality(quality);
  function setLod(l) { lodL = l; vis(); }
  function update(dt, t, lod, glow) {
    for (const m of fabrics) m.emissiveIntensity = m.userData.fabric.base * (0.82 + 0.18 * Math.sin(t * 1.4)) * Math.min(2.4, glow);
    if (spark && spark.points.visible) spark.update(t, glow);
    void dt; void lod;
  }
  function dispose() {
    if (spark) spark.dispose();
    for (const sh of owned.shells) { if (sh.parent) sh.parent.remove(sh); sh.geometry.dispose(); sh.skeleton = null; }
    for (const r of owned.rel) r();
    owned.shells.length = 0; owned.rel.length = 0;
  }
  return { names, fabrics, update, setLod, setQuality, dispose, get sparkCount() { return glints.length; } };
}
