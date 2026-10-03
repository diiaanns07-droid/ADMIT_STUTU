// ASHEN OATH — загрузка VRM-персонажей (VRoid, CC0) и перенос на них анимаций Quaternius.
// VRM грузится через @pixiv/three-vrm (importmap → cdn.jsdelivr.net). Модели VRM 0.x
// разворачиваются лицом к +z (VRMUtils.rotateVRM0), как герой мира.
// Анимации: клипы моделей Quaternius (assets/quaternius/*.glb) сделаны на скелете Mixamo
// (Hips, Spine, Spine1, Spine2, Neck, Head, LeftArm…). Перенос — как в примере three-vrm
// «loadMixamoAnimation»: поворот кости в мире покоя источника → нормализованная кость VRM.
// Перемещение таза переводится в мировые оси и масштабируется по высоте таза.
//
// [HERO] Вторая библиотека клипов — KayKit Adventurers (assets/heroes/anims_kaykit.glb, CC0, скелет
// hips/spine/chest/head, upperarm.l…): стрейфы, шаг назад, рывки, касты, лук, блок, удары, победа.
// Конечности переносятся режимом 'full': поворот кости в мире относительно покоя источника
// (со скруткой предплечья и кисти), покой VRM сначала совмещается с покоем источника по направлению.
//
// export: loadVRM(THREE, url) → Promise<vrm>,
//         retargetClip(THREE, clip, srcScene, vrm, fps = 30, rig = 'mixamo' | 'kaykit') → AnimationClip,
//         createGltfLoader() → Promise<GLTFLoader> (с распаковщиком meshopt — для всех моделей assets/)

const MIXAMO_TO_VRM = {
  Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
  LeftShoulder: 'leftShoulder', LeftArm: 'leftUpperArm', LeftForeArm: 'leftLowerArm', LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder', RightArm: 'rightUpperArm', RightForeArm: 'rightLowerArm', RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg', LeftLeg: 'leftLowerLeg', LeftFoot: 'leftFoot', LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg', RightLeg: 'rightLowerLeg', RightFoot: 'rightFoot', RightToeBase: 'rightToes',
  LeftHandThumb1: 'leftThumbProximal', LeftHandThumb2: 'leftThumbIntermediate', LeftHandThumb3: 'leftThumbDistal',
  LeftHandIndex1: 'leftIndexProximal', LeftHandIndex2: 'leftIndexIntermediate', LeftHandIndex3: 'leftIndexDistal',
  RightHandThumb1: 'rightThumbProximal', RightHandThumb2: 'rightThumbIntermediate', RightHandThumb3: 'rightThumbDistal',
  RightHandIndex1: 'rightIndexProximal', RightHandIndex2: 'rightIndexIntermediate', RightHandIndex3: 'rightIndexDistal',
};

let vrmModP = null;
function vrmModule() {
  if (!vrmModP) vrmModP = import('@pixiv/three-vrm');
  return vrmModP;
}

// [LOAD] модели в assets/ сжаты tools/compress_assets.mjs (EXT_meshopt_compression + WebP-текстуры):
// каждому GLTFLoader нужен MeshoptDecoder (three/addons/libs, ~30 КБ, WASM внутри файла); несжатые
// модели тот же загрузчик открывает как раньше. Распаковщик не загрузился — ошибка (все модели
// assets/ без него не откроются), а не загрузчик без него: кэши загрузчиков сбрасываются и следующая
// попытка (смена героя, вход в бой) повторит загрузку распаковщика.
let meshoptP = null;
function meshoptDecoder() {
  if (!meshoptP) {
    meshoptP = import('three/addons/libs/meshopt_decoder.module.js').then((m) => m.MeshoptDecoder.ready.then(() => m.MeshoptDecoder));
    meshoptP.catch((e) => { console.warn('[LOAD] MeshoptDecoder недоступен:', e && e.message); meshoptP = null; });
  }
  return meshoptP;
}
export async function createGltfLoader() {
  const [{ GLTFLoader }, dec] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), meshoptDecoder()]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(dec);
  return loader;
}

export async function loadVRM(THREE, url) {
  const [loader, V] = await Promise.all([createGltfLoader(), vrmModule()]);
  loader.register((parser) => new V.VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('не VRM: ' + url);
  V.VRMUtils.removeUnnecessaryVertices(gltf.scene);
  V.VRMUtils.combineSkeletons ? V.VRMUtils.combineSkeletons(gltf.scene) : V.VRMUtils.removeUnnecessaryJoints(gltf.scene);
  V.VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; }
  });
  return vrm;
}

// [HERO] GLB-герой на скелете Quaternius UAL (как у манекена UE: pelvis, spine_01…03, neck_01, Head,
// clavicle_l, upperarm_l…, thigh_l, calf_l, foot_l, ball_l, пальцы index_01_l…). Для него строится
// VRMHumanoid из three-vrm: нормализованный скелет (покой = T-поза модели), поэтому перенос клипов,
// позы и якоря работают так же, как у VRM. Возвращает «vrm»-подобный объект:
//   { scene, humanoid, expressionManager: null, springBoneManager: null, update(dt), isGlbHero: true }
const UAL_BONES = {
  hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'Head',
  leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
  rightShoulder: 'clavicle_r', rightUpperArm: 'upperarm_r', rightLowerArm: 'lowerarm_r', rightHand: 'hand_r',
  leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l', leftToes: 'ball_l',
  rightUpperLeg: 'thigh_r', rightLowerLeg: 'calf_r', rightFoot: 'foot_r', rightToes: 'ball_r',
};
for (const s of ['l', 'r']) {
  const S = s === 'l' ? 'left' : 'right';
  UAL_BONES[`${S}ThumbMetacarpal`] = `thumb_01_${s}`; UAL_BONES[`${S}ThumbProximal`] = `thumb_02_${s}`; UAL_BONES[`${S}ThumbDistal`] = `thumb_03_${s}`;
  for (const [f, q] of [['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) {
    UAL_BONES[`${S}${f}Proximal`] = `${q}_01_${s}`; UAL_BONES[`${S}${f}Intermediate`] = `${q}_02_${s}`; UAL_BONES[`${S}${f}Distal`] = `${q}_03_${s}`;
  }
}
// data — уже скачанные байты файла (ArrayBuffer, предзагрузка героев меню): разбор без повторной загрузки
export async function loadHumanoidGLB(THREE, url, boneMap = UAL_BONES, data = null) {
  const [loader, V] = await Promise.all([createGltfLoader(), vrmModule()]);
  const gltf = data ? await loader.parseAsync(data, url.slice(0, url.lastIndexOf('/') + 1)) : await loader.loadAsync(url);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const find = (n) => scene.getObjectByName(n) || scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n));
  // лицом к +z, как VRM: стопа → носок
  const foot = find(boneMap.leftFoot), toe = find(boneMap.leftToes);
  if (foot && toe) {
    const a = foot.getWorldPosition(new THREE.Vector3()), b = toe.getWorldPosition(new THREE.Vector3());
    if (b.z - a.z < 0) { scene.rotation.y = Math.PI; scene.updateMatrixWorld(true); }
  }
  const human = {};
  for (const [vName, sName] of Object.entries(boneMap)) { const n = find(sName); if (n) human[vName] = { node: n }; }
  if (!human.hips || !human.head || !human.leftUpperArm) throw new Error('нет костей гуманоида: ' + url);
  const humanoid = new V.VRMHumanoid(human, { autoUpdateHumanBones: true });
  scene.add(humanoid.normalizedHumanBonesRoot);
  scene.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; } });
  return {
    scene, humanoid, expressionManager: null, springBoneManager: null, lookAt: null, isGlbHero: true,
    update() { humanoid.update(); },
  };
}

// Перенос клипа на VRM по мировым направлениям костей (устойчив к разной позе покоя:
// у Quaternius руки в покое опущены, у VRM — T-поза).
//   корпус (таз, позвоночник, шея, голова): D(t) = Q_src(t)·Q_src_rest⁻¹, W_vrm(t) = D(t)·W_vrm_rest;
//   конечности: направление кость→дочерняя в источнике, W_vrm(t) = fromTo(dir_vrm_rest, dir_src(t))·W_vrm_rest.
// Локальный поворот нормализованной кости VRM = W_родителя⁻¹·W. Клип семплируется с частотой fps.
// srcScene — отдельная КОПИЯ сцены источника (SkeletonUtils.clone): её кости двигаются при семплировании.
const RIG = [
  // [кость VRM, кость источника, режим, дочерняя кость источника, дочерняя кость VRM]
  ['hips', 'Hips', 'delta'],
  ['spine', 'Spine', 'delta'], ['chest', 'Spine1', 'delta'], ['upperChest', 'Spine2', 'delta'],
  ['neck', 'Neck', 'delta'], ['head', 'Head', 'delta'],
  ['leftShoulder', 'LeftShoulder', 'dir', 'LeftArm', 'leftUpperArm'],
  ['leftUpperArm', 'LeftArm', 'dir', 'LeftForeArm', 'leftLowerArm'],
  ['leftLowerArm', 'LeftForeArm', 'dir', 'LeftHand', 'leftHand'],
  ['leftHand', 'LeftHand', 'dir', 'LeftHandIndex1', 'leftIndexProximal'],
  ['rightShoulder', 'RightShoulder', 'dir', 'RightArm', 'rightUpperArm'],
  ['rightUpperArm', 'RightArm', 'dir', 'RightForeArm', 'rightLowerArm'],
  ['rightLowerArm', 'RightForeArm', 'dir', 'RightHand', 'rightHand'],
  ['rightHand', 'RightHand', 'dir', 'RightHandIndex1', 'rightIndexProximal'],
  ['leftUpperLeg', 'LeftUpLeg', 'dir', 'LeftLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'LeftLeg', 'dir', 'LeftFoot', 'leftFoot'],
  ['leftFoot', 'LeftFoot', 'dir', 'LeftToeBase', 'leftToes'],
  ['rightUpperLeg', 'RightUpLeg', 'dir', 'RightLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'RightLeg', 'dir', 'RightFoot', 'rightFoot'],
  ['rightFoot', 'RightFoot', 'dir', 'RightToeBase', 'rightToes'],
];

// [HERO] KayKit: у скелета нет шеи и ключиц — они остаются в покое VRM.
// Кисть: у KayKit wrist.r в клипах неподвижна, настоящий поворот запястья — у её дочерней hand.r
// (6-е поле — кость, с которой берётся поворот; направление покоя — как прежде, wrist → hand).
const RIG_KAYKIT = [
  ['hips', 'hips', 'delta'],
  ['spine', 'spine', 'delta'], ['chest', 'chest', 'delta'], ['head', 'head', 'delta'],
  ['leftUpperArm', 'upperarm.l', 'full', 'lowerarm.l', 'leftLowerArm'],
  ['leftLowerArm', 'lowerarm.l', 'full', 'wrist.l', 'leftHand'],
  ['leftHand', 'wrist.l', 'full', 'hand.l', 'leftMiddleProximal', 'hand.l'],
  ['rightUpperArm', 'upperarm.r', 'full', 'lowerarm.r', 'rightLowerArm'],
  ['rightLowerArm', 'lowerarm.r', 'full', 'wrist.r', 'rightHand'],
  ['rightHand', 'wrist.r', 'full', 'hand.r', 'rightMiddleProximal', 'hand.r'],
  ['leftUpperLeg', 'upperleg.l', 'full', 'lowerleg.l', 'leftLowerLeg'],
  ['leftLowerLeg', 'lowerleg.l', 'full', 'foot.l', 'leftFoot'],
  // [W5-ПОЛ] стопа — дельтой от своего покоя, а не по направлению «стопа → носок» источника: у KayKit оно
  // смотрит вниз на 46° (высокий голеностоп), у героев Quaternius — на 22–27°; совмещение покоя наклоняло
  // каждую стопу носком вниз на 19–24°, и носки уходили в пол на 5–8 см. Носок источника — для опоры.
  ['leftFoot', 'foot.l', 'delta', 'toes.l', 'leftToes'],
  ['rightUpperLeg', 'upperleg.r', 'full', 'lowerleg.r', 'rightLowerLeg'],
  ['rightLowerLeg', 'lowerleg.r', 'full', 'foot.r', 'rightFoot'],
  ['rightFoot', 'foot.r', 'delta', 'toes.r', 'rightToes'],
];
export const RIGS = Object.freeze({ mixamo: RIG, kaykit: RIG_KAYKIT });

// [W5-ПОЛ] Подошва модели: точки сетки стоп, которые могут коснуться пола при любом наклоне стопы, — опорные точки
// всей сетки стопы (кость стопы и все её дочерние: носок, кончик носка) по направлениям «вниз», «вниз-вперёд/назад»
// до 75° и «вниз-вбок» до 45°: нижняя часть выпуклой оболочки (пятка, края подошвы, загнутый вверх носок сабатона —
// в покое он выше подошвы, но при наклоне стопы носком вниз первым уходит в пол). Точки — в осях нормализованных
// костей стопы и носка. Пол модели в покое — нижняя из них (restY, в осях vrm.scene). Один раз на модель (кэш).
//   soleMarkers(THREE, vrm) → { L: [{ node, p }], R: [...], restY } | null (нет костей стоп или сетки на них)
//   soleHeight(m, out?) → нижняя точка подошвы в мире (кости — с актуальными matrixWorld); out = { L, R, min }
const SOLES = new WeakMap();
// Вершина скин-сетки сразу в мире — как в шейдере: Σ w·(кость.matrixWorld · обратная привязки)·bindMatrix·v.
// SkinnedMesh.getVertexPosition делит ещё на bindMatrixInverse, а её three обновляет только в updateMatrixWorld
// сцены при отрисовке: до отрисовки кадра (и без неё) она отстаёт на сдвиг героя за кадр.
const _skM = new Map();
export function skinnedVertexWorld(mesh, i, out) {
  let t = _skM.get(out.constructor);
  if (!t) { t = { m: new mesh.matrixWorld.constructor(), b: new out.constructor(), v: new out.constructor() }; _skM.set(out.constructor, t); }
  const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, sk = mesh.skeleton;
  t.b.fromBufferAttribute(g.attributes.position, i).applyMatrix4(mesh.bindMatrix);
  out.set(0, 0, 0);
  for (let j = 0; j < 4; j++) {
    const w = sw.getComponent(i, j);
    if (w === 0) continue;
    const k = si.getComponent(i, j);
    t.m.multiplyMatrices(sk.bones[k].matrixWorld, sk.boneInverses[k]);
    out.addScaledVector(t.v.copy(t.b).applyMatrix4(t.m), w);
  }
  return out;
}
// кость и все её дочерние кости (у моделей Quaternius: стопа → носок → кончик носка)
export function boneSubtree(bone) {
  const out = new Set();
  if (bone) bone.traverse((o) => { if (o.isBone || o === bone) out.add(o); });
  return out;
}
export function soleMarkers(THREE, vrm) {
  if (SOLES.has(vrm)) return SOLES.get(vrm);
  const H = vrm.humanoid;
  const raw = (n) => (H.getRawBoneNode ? H.getRawBoneNode(n) : null) || H.getNormalizedBoneNode(n);
  // покой: нормализованный скелет и сетка (сырые кости) — в позе привязки
  if (H.resetNormalizedPose) H.resetNormalizedPose();
  if (H.update) H.update();
  vrm.scene.updateMatrixWorld(true);
  const toScene = new THREE.Matrix4().copy(vrm.scene.matrixWorld).invert();
  const v = new THREE.Vector3(), loc = new THREE.Vector3();
  const side = (s) => {
    const foot = raw(s + 'Foot'), toes = raw(s + 'Toes');
    return { all: boneSubtree(foot), toes: boneSubtree(toes), nf: H.getNormalizedBoneNode(s + 'Foot'), nt: H.getNormalizedBoneNode(s + 'Toes'), pts: [] };
  };
  const sides = { L: side('left'), R: side('right') };
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.skeleton || !o.visible || !o.geometry || !o.geometry.attributes.skinIndex) return;
    const bones = o.skeleton.bones, si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight, n = o.geometry.attributes.position.count;
    for (const S of Object.values(sides)) {
      if (!S.nf || !S.all.size) continue;
      const inF = new Set(), inT = new Set();
      bones.forEach((b, i) => { if (S.all.has(b)) inF.add(i); if (S.toes.has(b)) inT.add(i); });
      if (!inF.size) continue;
      for (let i = 0; i < n; i++) {
        let wf = 0, wt = 0;
        for (let j = 0; j < 4; j++) { const b = si.getComponent(i, j), w = sw.getComponent(i, j); if (inF.has(b)) { wf += w; if (inT.has(b)) wt += w; } }
        if (wf < 0.5) continue;
        skinnedVertexWorld(o, i, v);
        loc.copy(v).applyMatrix4(toScene);
        S.pts.push({ w: v.clone(), l: loc.clone(), toe: wt > wf - wt, mesh: o, i });
      }
    }
  });
  let restY = Infinity;
  for (const S of Object.values(sides)) for (const p of S.pts) restY = Math.min(restY, p.l.y);
  if (!Number.isFinite(restY)) { SOLES.set(vrm, null); return null; }
  const out = { L: [], R: [], restY, v: new THREE.Vector3(), bones: [] };
  const d = new THREE.Vector3();
  for (const [k, S] of Object.entries(sides)) {
    if (!S.pts.length) continue;
    const pick = new Set();
    for (let a = -75; a <= 75; a += 15) {
      for (const r of [-45, -20, 0, 20, 45]) {
        const ar = (a * Math.PI) / 180, rr = (r * Math.PI) / 180;
        d.set(Math.sin(rr), -Math.cos(rr) * Math.cos(ar), Math.cos(rr) * Math.sin(ar));
        let best = null, bd = -Infinity;
        for (const p of S.pts) { const q = p.l.dot(d); if (q > bd) { bd = q; best = p; } }
        pick.add(best);
      }
    }
    for (const p of pick) {
      const node = p.toe && S.nt ? S.nt : S.nf;
      out[k].push({ node, p: node.worldToLocal(p.w.clone()), mesh: p.mesh, i: p.i });
    }
  }
  // для точного замера (soleHeightSkinned): сырые кости, на которых висят точки (голень, стопа, носок…)
  const bs = new Set();
  for (const q of [...out.L, ...out.R]) {
    const si = q.mesh.geometry.attributes.skinIndex, sw = q.mesh.geometry.attributes.skinWeight;
    for (let j = 0; j < 4; j++) if (sw.getComponent(q.i, j) > 0) bs.add(q.mesh.skeleton.bones[si.getComponent(q.i, j)]);
  }
  out.bones = [...bs].filter(Boolean);
  SOLES.set(vrm, out);
  return out;
}
// Точно: те же точки как вершины сетки со всеми их весами (у пятки — доля голени: при сильно согнутом колене она
// уходит вниз, хотя кость стопы стоит ровно). Сырые кости должны быть уже в позе кадра (vrm.humanoid.update()).
export function soleHeightSkinned(m, out = null) {
  if (!m) return NaN;
  for (const b of m.bones) b.updateWorldMatrix(true, false);
  let min = Infinity;
  for (const k of ['L', 'R']) {
    let lo = Infinity;
    for (const q of m[k]) {
      const y = skinnedVertexWorld(q.mesh, q.i, m.v).y;
      if (y < lo) lo = y;
    }
    if (out) out[k] = lo;
    if (lo < min) min = lo;
  }
  if (out) out.min = min;
  return min;
}
// Быстро и без сетки: точки жёстко на костях стопы и носка (нормализованный скелет) — для IK ног слоя поз
export function soleHeight(m, out = null) {
  if (!m) return NaN;
  let min = Infinity;
  for (const k of ['L', 'R']) {
    let lo = Infinity;
    for (const { node, p } of m[k]) {
      const y = m.v.copy(p).applyMatrix4(node.matrixWorld).y;
      if (y < lo) lo = y;
    }
    if (out) out[k] = lo;
    if (lo < min) min = lo;
  }
  if (out) out.min = min;
  return min;
}

const n0 = (clip, fps) => Math.max(2, Math.ceil(clip.duration * fps) + 1);   // кадров семплирования клипа
// [W5-ПОЛ] касание: нижняя из точек стоп источника поднята над покоем не больше чем на 10% высоты его таза (у KayKit
// ~4 см). Голеностоп и носок — кости, не подошва: на ударе пяткой голеностоп выше покоя на 2 см, хотя пятка на полу;
// настоящий полёт (бег, прыжок, подскок удара) — 6–19 см
export const CONTACT = 0.1;

// [W5-ПОЛ] Высота таза по опоре. Кадры, где стопа источника стоит (поднята над покоем не выше eps = CONTACT), — касание:
// таз цели сдвигается по вертикали так, чтобы нижняя точка её подошвы была ровно на полу покоя. Между касаниями
// (полёт бега, прыжок, подскок рывка) поправка идёт линейно от соседних касаний — полёт клипа сохраняется,
// но подошва и там не ниже пола.
// Скелет цели ставится в позу кадра (прямая кинематика нормализованных костей) и в конце возвращается в покой.
function groundHips(THREE, vrm, bones, hips, qv, hp, lift, eps, soles, hipsParentInv) {
  const n = lift.length, H = vrm.humanoid;
  const sync = () => { if (H.update) H.update(); };   // нормализованный скелет → сырые кости (сетка)
  sync();
  vrm.scene.updateMatrixWorld(true);
  const rest = soleHeightSkinned(soles);
  const corr = new Float32Array(n).fill(NaN), floor = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    for (const b of bones) b.node.quaternion.fromArray(qv.get(b), f * 4);
    hips.node.position.fromArray(hp, f * 3);
    hips.node.updateMatrixWorld(true);
    sync();
    floor[f] = rest - soleHeightSkinned(soles);   // поправка, ставящая подошву ровно на пол
    if (lift[f] <= eps) corr[f] = floor[f];
  }
  if (H.resetNormalizedPose) H.resetNormalizedPose();
  sync();
  vrm.scene.updateMatrixWorld(true);
  // промежутки без касания — линейно между соседними касаниями (по краям — ближайшее); касаний нет — без поправки
  let prev = -1;
  for (let f = 0; f <= n; f++) {
    if (f < n && Number.isNaN(corr[f])) continue;
    for (let g = prev + 1; g < f; g++) {
      corr[g] = prev < 0 ? (f < n ? corr[f] : 0) : f >= n ? corr[prev] : corr[prev] + (corr[f] - corr[prev]) * ((g - prev) / (f - prev));
    }
    prev = f;
  }
  const d = new THREE.Vector3();
  for (let f = 0; f < n; f++) {
    if (corr[f] < floor[f]) corr[f] = floor[f];   // и в полёте подошва не уходит под пол
    d.set(0, corr[f], 0).applyQuaternion(hipsParentInv);
    hp[f * 3] += d.x; hp[f * 3 + 1] += d.y; hp[f * 3 + 2] += d.z;
  }
}

export function retargetClip(THREE, clip, srcScene, vrm, fps = 30, rig = 'mixamo') {
  const H = vrm.humanoid;
  const TABLE = RIGS[rig] || RIG;
  if (H.resetNormalizedPose) H.resetNormalizedPose();
  vrm.scene.updateMatrixWorld(true);
  srcScene.updateMatrixWorld(true);
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  // GLTFLoader чистит имена узлов (PropertyBinding.sanitizeNodeName: «upperarm.l» → «upperarml»)
  const byName = (n) => srcScene.getObjectByName(n) || (THREE.PropertyBinding ? srcScene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)) : null);
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  // покой: источник и VRM
  const bones = [];
  for (const [vName, sName, mode, sChild, vChild, sRot] of TABLE) {
    const node = H.getNormalizedBoneNode(vName), src = byName(sName);
    if (!node || !src) continue;
    const rot = (sRot && byName(sRot)) || src; // кость, с которой берётся поворот
    const b = { vName, node, src, rot, mode, restSrcQ: wq(rot), restVrmW: wq(node) };
    if (mode === 'dir' || mode === 'full') {
      const sc = byName(sChild), vc = H.getNormalizedBoneNode(vChild);
      if (!sc || !vc) { b.mode = 'delta'; } else {
        b.srcChild = sc;
        b.restVrmDir = wp(vc).sub(wp(node)).normalize();
        if (mode === 'full') {
          // совмещение покоя: VRM (T-поза) → направление кости источника в покое, затем дельта источника
          const srcDir = wp(sc).sub(wp(src)).normalize();
          b.alignW = new THREE.Quaternion().setFromUnitVectors(b.restVrmDir, srcDir).multiply(b.restVrmW);
        }
      }
    }
    bones.push(b);
  }
  const byNode = new Map(bones.map((b) => [b.node, b]));
  const hips = bones.find((b) => b.vName === 'hips');
  const box = new THREE.Box3().setFromObject(srcScene);
  // [HERO] библиотека без мешей (anims_kaykit.glb): рамка пустая — пол = начало сцены источника
  const srcFloor = box.isEmpty() ? wp(srcScene).y : box.min.y;
  const srcHipsH = hips ? wp(hips.src).y - srcFloor : 1;
  const vrmHipsH = hips ? wp(hips.node).y - wp(vrm.scene).y : 1;
  const posScale = srcHipsH > 1e-6 ? vrmHipsH / srcHipsH : 1;
  const restHipsSrcP = hips ? wp(hips.src) : new THREE.Vector3();
  const restHipsLocal = hips ? hips.node.position.clone() : new THREE.Vector3();
  const hipsParentInv = hips ? wq(hips.node.parent).invert() : new THREE.Quaternion();
  // [W5-ПОЛ] опора источника: на сколько голеностоп и носок каждой стопы поднялись над своим покоем (нижняя из
  // четырёх точек); подошва цели — точки сетки стоп (soleMarkers). Высоту таза из масштаба по высоте таза
  // («таз KayKit ниже корней ног» — масштаб не тот) поправляем по опоре: см. ниже, после семплирования.
  const srcFeet = [];
  for (const r of TABLE) if (r[0] === 'leftFoot' || r[0] === 'rightFoot') for (const o of [byName(r[1]), r[3] ? byName(r[3]) : null]) if (o) srcFeet.push([o, wp(o).y]);
  const soles = hips && srcFeet.length ? soleMarkers(THREE, vrm) : null;
  const lift = soles ? new Float32Array(n0(clip, fps)) : null;
  // семплирование клипа источника
  const mixer = new THREE.AnimationMixer(srcScene);
  const action = mixer.clipAction(clip);
  // [HERO] LoopOnce + clamp: иначе t = duration заворачивается в 0 и последний ключ = первый кадр
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const n = n0(clip, fps);
  const times = new Float32Array(n);
  const qv = new Map(bones.map((b) => [b, new Float32Array(n * 4)]));
  const hp = new Float32Array(n * 3);
  const W = new Map();
  const tmp = new THREE.Quaternion(), dq = new THREE.Quaternion(), dir = new THREE.Vector3();
  for (let f = 0; f < n; f++) {
    const t = Math.min(clip.duration, (f / (n - 1)) * clip.duration);
    times[f] = t;
    mixer.setTime(t);
    srcScene.updateMatrixWorld(true);
    W.clear();
    for (const b of bones) {
      let w;
      if (b.mode === 'dir') {
        dir.copy(wp(b.srcChild)).sub(wp(b.src)).normalize();
        w = new THREE.Quaternion().setFromUnitVectors(b.restVrmDir, dir).multiply(b.restVrmW);
      } else if (b.mode === 'full') {
        dq.copy(b.restSrcQ).invert();
        w = wq(b.rot).multiply(dq).multiply(b.alignW); // D(t)·A·W_rest
      } else {
        dq.copy(b.restSrcQ).invert();
        w = wq(b.src).multiply(dq).multiply(b.restVrmW); // D(t)·W_rest
      }
      W.set(b.node, w);
      // родитель в нормализованной иерархии: уже посчитанный (порядок RIG — от корня) или статичный
      let pw = null;
      for (let p = b.node.parent; p; p = p.parent) { if (W.has(p)) { pw = W.get(p); break; } if (!byNode.has(p)) continue; }
      if (!pw) pw = wq(b.node.parent);
      tmp.copy(pw).invert().multiply(w);
      tmp.toArray(qv.get(b), f * 4);
    }
    if (hips) {
      dir.copy(wp(hips.src)).sub(restHipsSrcP).multiplyScalar(posScale).applyQuaternion(hipsParentInv);
      hp[f * 3] = restHipsLocal.x + dir.x; hp[f * 3 + 1] = restHipsLocal.y + dir.y; hp[f * 3 + 2] = restHipsLocal.z + dir.z;
    }
    if (lift) { let m = Infinity; for (const [o, y0] of srcFeet) m = Math.min(m, wp(o).y - y0); lift[f] = m; }
  }
  action.stop(); mixer.uncacheRoot(srcScene);
  if (lift) groundHips(THREE, vrm, bones, hips, qv, hp, lift, CONTACT * Math.max(srcHipsH, 1e-3), soles, hipsParentInv);
  const tracks = [];
  for (const b of bones) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.node.name}.quaternion`, times, qv.get(b)));
  if (hips) tracks.push(new THREE.VectorKeyframeTrack(`${hips.node.name}.position`, times, hp));
  return new THREE.AnimationClip(clip.name.split('|').pop(), clip.duration, tracks);
}
