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
//         retargetClip(THREE, clip, srcScene, vrm, fps = 30, rig = 'mixamo' | 'kaykit') → AnimationClip

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

export async function loadVRM(THREE, url) {
  const [{ GLTFLoader }, V] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), vrmModule()]);
  const loader = new GLTFLoader();
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
const RIG_KAYKIT = [
  ['hips', 'hips', 'delta'],
  ['spine', 'spine', 'delta'], ['chest', 'chest', 'delta'], ['head', 'head', 'delta'],
  ['leftUpperArm', 'upperarm.l', 'full', 'lowerarm.l', 'leftLowerArm'],
  ['leftLowerArm', 'lowerarm.l', 'full', 'wrist.l', 'leftHand'],
  ['leftHand', 'wrist.l', 'full', 'hand.l', 'leftMiddleProximal'],
  ['rightUpperArm', 'upperarm.r', 'full', 'lowerarm.r', 'rightLowerArm'],
  ['rightLowerArm', 'lowerarm.r', 'full', 'wrist.r', 'rightHand'],
  ['rightHand', 'wrist.r', 'full', 'hand.r', 'rightMiddleProximal'],
  ['leftUpperLeg', 'upperleg.l', 'full', 'lowerleg.l', 'leftLowerLeg'],
  ['leftLowerLeg', 'lowerleg.l', 'full', 'foot.l', 'leftFoot'],
  ['leftFoot', 'foot.l', 'full', 'toes.l', 'leftToes'],
  ['rightUpperLeg', 'upperleg.r', 'full', 'lowerleg.r', 'rightLowerLeg'],
  ['rightLowerLeg', 'lowerleg.r', 'full', 'foot.r', 'rightFoot'],
  ['rightFoot', 'foot.r', 'full', 'toes.r', 'rightToes'],
];
export const RIGS = Object.freeze({ mixamo: RIG, kaykit: RIG_KAYKIT });

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
  for (const [vName, sName, mode, sChild, vChild] of TABLE) {
    const node = H.getNormalizedBoneNode(vName), src = byName(sName);
    if (!node || !src) continue;
    const b = { vName, node, src, mode, restSrcQ: wq(src), restVrmW: wq(node) };
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
  // семплирование клипа источника
  const mixer = new THREE.AnimationMixer(srcScene);
  const action = mixer.clipAction(clip);
  action.play();
  const n = Math.max(2, Math.ceil(clip.duration * fps) + 1);
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
        w = wq(b.src).multiply(dq).multiply(b.alignW); // D(t)·A·W_rest
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
  }
  action.stop(); mixer.uncacheRoot(srcScene);
  const tracks = [];
  for (const b of bones) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.node.name}.quaternion`, times, qv.get(b)));
  if (hips) tracks.push(new THREE.VectorKeyframeTrack(`${hips.node.name}.position`, times, hp));
  return new THREE.AnimationClip(clip.name.split('|').pop(), clip.duration, tracks);
}
