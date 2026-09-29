// ASHEN OATH — выбираемый герой (settings.hero). [HERO] V6: контракт C5, несколько экземпляров.
//   'ashen' — Пепельный страж: процедурный герой мира (world.js), модель не грузится;
//   'elf'   — Эльфийка: VRoid AvatarSample_F (assets/vroid/elf.vrm, CC0);
//   'dark'  — Тёмная чародейка: VRoid Darkness (assets/vroid/dark.vrm, CC0).
// VRM грузится через modules/vrmKit.js. Анимации — KayKit Adventurers (assets/heroes/anims_kaykit.glb,
// CC0: стрейфы, шаг назад, рывки в 4 стороны, касты одной и двумя руками, лук, блок, удары, победа),
// запасной набор — Quaternius woman.glb (6 клипов). Клипы переносятся на VRM один раз на файл модели
// и делятся между экземплярами (данные клипа только читаются); миксер, материалы и сцена у каждого
// экземпляра свои.
//
// Нижний слой — передвижение: бленд вперёд / назад / влево / вправо по скорости в осях героя, фаза
// шага общая и идёт по пройденному пути (ноги не скользят). В lock-on грудь довёрнута к цели.
// Верхний слой — действия по событиям боя (пока герой идёт — только корпус и руки). Поверх — поза
// setPose (лук, чары рукой) и зеркало рук игрока setMirror (как world.setMirror у процедурного героя),
// затем дыхание и оглядывание в покое.
//
// createHeroModel({ THREE, heroRoot?, heroBody?, extras?, markers?, scene?, hero, shading?, quality?,
//                   atmosphere?, remote?, baseUrl?, vrmUrl?, heroesUrl? })
//   → { root, update(dt, snapLike, events), setHero(id), setPose(p), setMirror(m), getAnchors(),
//       setShading(mode), setQuality(q), setLod(level), get ready, get hero, state(), dispose() }
// heroRoot не задан — экземпляр создаёт свой root (для удалённого игрока) и сам ставит его по snapLike.player.
// snapLike: нужен только { player: { position, yaw, velocity, action, hp, … как в snapshot } }.

import { loadVRM, loadHumanoidGLB, retargetClip } from './vrmKit.js';

// Карточки героев: имя, класс, стихия и три строки описания — для меню №8 и витрины (heroShowcase).
export const HEROES = Object.freeze({
  ashen: {
    id: 'ashen', name: 'Пепельный страж', vrm: null, glb: 'knight.glb', height: 1.84, cls: 'Воин-маг', element: 'Пепел и пламя',
    desc: ['Клятвенный страж павшего святилища.', 'Латы из закалённой стали, посох с углём клятвы.', 'Держит удар и отвечает огнём.'],
    gear: 'warden', stance: 'staff', adduct: 0.3, menuStance: 'Stance',
    fx: { style: 'ember', color: 0xff7a2a, color2: 0xffd08a, armor: 0xff5a18, armorK: 2.2, armorMode: 'seams', visorEyes: 0xff8a30 },
    // воронёная сталь, тёмно-багровая ткань, золото кантов (атлас Quaternius Knight: серебро, красный, белый)
    recolor: { MI_Knight: [
      { h: [338, 14], minS: 0.35, toH: 354, s: 0.95, v: 0.5 },
      { h: [24, 60], minS: 0.3, minV: 0.5, toH: 40, s: 0.95, v: 1.08 },
      { h: [8, 48], minS: 0.2, maxV: 0.5, toH: 24, s: 0.85, v: 0.62 },
      { h: [0, 360], minS: 0, toH: 28, s: 0.35, v: 0.62 },
    ] },
  },
  // [HERO] V6: эльфийка и чародейка — реалистичные (тело и костюм Quaternius Ranger, перекраска, своё снаряжение)
  elf: {
    id: 'elf', name: 'Эльфийка', vrm: null, glb: 'ranger.glb', height: 1.74, cls: 'Лучница-заклинательница', element: 'Гроза',
    desc: ['Следопыт Сияющего леса.', 'Лук из белого ясеня и перстни-руны на пальцах.', 'Бьёт издалека и уходит рывком.'],
    gear: 'sylvan', stance: 'bow', adduct: 0.42, menuStance: null, menuPose: { bowActive: true, bowDraw: 0.1, aim: { x: 0.45, y: -0.55 } }, ears: true, hair: { color: 0xe6dcc0, len: 0.95, fringe: 'swept' }, brows: 0.62, circlet: { gem: 0x7fe8ff }, lashes: 0x5a4230, hoodTrim: { base: 0xe9efe9, thread: 0xd4ad62 },
    makeup: { lips: 0xd97c86, lipsA: 0.7, shadow: 0xb08a6a, shadowA: 0.35, liner: 0x3a2a20, blush: 0xf09090, blushA: 0.16 },
    // зелёная ткань → белый шёлк с бирюзой, кожа доспеха → светлая замша
    recolor: { MI_Ranger: [{ h: [0, 360], minS: 0, metal: 'only', toH: 195, s: 0.3, v: 1.12 }, { h: [65, 175], toH: 172, s: 0.35, v: 1.55, metal: false }, { h: [8, 48], toH: 38, s: 0.55, v: 1.45, metal: false }], MI_Regular_Female: [{ h: [0, 60], minS: 0.04, toH: 16, s: 0.52, v: 1.3 }] },
    fx: { style: 'wind', color: 0x9ff4ff, color2: 0xfff3c0, armor: 0x7fe8ff, armorK: 1.1, armorMode: 'seams', eyes: 0x7fe8ff, eyesK: 0.3 },
  },
  dark: {
    id: 'dark', name: 'Тёмная чародейка', vrm: null, glb: 'ranger.glb', height: 1.72, cls: 'Чародейка', element: 'Тьма и лёд',
    desc: ['Изгнанница из башни Затмения.', 'Посох с кристаллом ночи, плащ с живыми рунами.', 'Сковывает льдом и рвёт тьмой.'],
    // [HERO] на витрине — спокойная стойка (широкая «двуручная» не к лицу чародейке)
    gear: 'witchQ', stance: 'staff', adduct: 0.42, menuStance: null, hide: ['Female_Ranger_Acc_Pauldrons'], makeup: { lips: 0x7a2a52, lipsA: 0.85, shadow: 0x5a3a7a, shadowA: 0.6, liner: 0x0c0610, blush: 0xc08aa0, blushA: 0.1 }, hair: { color: 0x1c1426, len: 1.05, fringe: 'straight' }, brows: 0.6, lashes: 0x08050c, hoodTrim: { base: 0x1c1228, thread: 0xb49cff },
    // зелёная ткань → глубокий фиолетовый, кожа → почти чёрная
    recolor: { MI_Ranger: [{ h: [0, 360], minS: 0, metal: 'only', toH: 262, s: 0.45, v: 0.92 }, { h: [65, 175], toH: 272, s: 1.1, v: 0.62, metal: false }, { h: [8, 48], toH: 255, s: 0.35, v: 0.42, metal: false }], MI_Regular_Female: [{ h: [0, 60], minS: 0.04, toH: 12, s: 0.45, v: 1.26 }] },
    fx: { style: 'frost', color: 0xb58cff, color2: 0x9fe0ff, armor: 0xa77bff, armorK: 1.4, armorMode: 'seams', eyes: 0xa77bff, eyesK: 0.4 },
  },
  // [HERO] новые герои (Quaternius Modular Fantasy, CC0)
  ranger: {
    id: 'ranger', name: 'Лучница', vrm: null, glb: 'ranger.glb', height: 1.72, cls: 'Лучница', element: 'Ветер',
    desc: ['Разведчица пограничных застав.', 'Капюшон следопыта, длинный лук и колчан за спиной.', 'Натягивает тетиву рукой — стрела летит в цель.'],
    gear: 'scout', stance: 'bow', adduct: 0.42, menuStance: null, recolor: { MI_Regular_Female: [{ h: [0, 60], minS: 0.04, toH: 19, s: 0.72, v: 1.14 }] },
    makeup: { lips: 0xc8706a, lipsA: 0.55, liner: 0x2a1a12, blush: 0xe89080, blushA: 0.2, freckles: 0x8a5a3a }, menuPose: { bowActive: true, bowDraw: 0.1, aim: { x: 0.45, y: -0.55 } }, hair: { color: 0x5a3220, len: 0.85, fringe: 'swept' }, brows: 0.7, lashes: 0x1c120c, hoodTrim: { base: 0x24381c, thread: 0xc9a05a },
    fx: { style: 'wind', color: 0xc8ff9a, color2: 0xffe08a },
  },
  archmage: {
    id: 'archmage', name: 'Архимаг', vrm: null, glb: 'wizard.glb', height: 1.8, cls: 'Архимаг', element: 'Буря',
    desc: ['Последний магистр Грозовой коллегии.', 'Посох-громоотвод и плащ, прошитый рунами.', 'Лепит сферы молний двумя руками.'],
    gear: 'magus', stance: 'staff', adduct: 0.3, menuStance: 'Stance',
    lashes: 0x5a524a,
    fx: { style: 'storm', color: 0x8fd0ff, color2: 0xe8f6ff, armor: 0x6fc0ff, armorK: 1.6, armorMode: 'seams', eyes: 0x9fdcff, eyesK: 0.3 },
  },
});
// прежние аниме-героини VRoid: не в меню и не в лобби (HEROES), но setHero их знает
export const EXTRA_HEROES = Object.freeze({
  elfVroid: {
    id: 'elfVroid', name: 'Эльфийка (VRoid)', vrm: 'elf.vrm', height: 1.72, cls: 'Лучница-заклинательница', element: 'Гроза',
    desc: ['Следопыт Сияющего леса.', 'Аниме-модель VRoid (CC0).', 'Прежний вид героини.'],
    gear: 'ranger', stance: 'bow', menuStance: 'IdleCalm', hidden: true,
  },
  darkVroid: {
    id: 'darkVroid', name: 'Тёмная чародейка (VRoid)', vrm: 'dark.vrm', height: 1.7, cls: 'Чародейка', element: 'Тьма и лёд',
    desc: ['Изгнанница из башни Затмения.', 'Аниме-модель VRoid (CC0).', 'Прежний вид героини.'],
    gear: 'witch', stance: 'staff', menuStance: 'CastHold', hidden: true,
  },
});
// порядок карточек в меню (№8 может брать отсюда)
export const HERO_ORDER = Object.freeze(['ashen', 'elf', 'dark', 'ranger', 'archmage']);

// Клипы: [имя в игре, файл, имя клипа в файле, петля]. Первый найденный файл — основной.
const KAY = 'anims_kaykit.glb';
const CLIPS_KAY = [
  ['Idle', 'Idle', true], ['IdleCalm', 'Unarmed_Idle', true], ['Walk', 'Walking_A', true], ['WalkBack', 'Walking_Backwards', true],
  ['Run', 'Running_A', true], ['StrafeL', 'Running_Strafe_Left', true], ['StrafeR', 'Running_Strafe_Right', true],
  ['DodgeF', 'Dodge_Forward'], ['DodgeB', 'Dodge_Backward'], ['DodgeL', 'Dodge_Left'], ['DodgeR', 'Dodge_Right'],
  ['Cast1', 'Spellcast_Shoot'], ['Cast2', 'Spellcast_Long'], ['CastRaise', 'Spellcast_Raise'], ['CastHold', 'Spellcasting', true],
  ['BowAim', '2H_Ranged_Aiming', true], ['BowShoot', '2H_Ranged_Shoot'], ['Block', 'Block'], ['Blocking', 'Blocking', true],
  ['BlockHit', 'Block_Hit'], ['Hit', 'Hit_A'], ['HitB', 'Hit_B'], ['Victory', 'Cheer', true], ['Death', 'Death_A'],
  ['Jump', 'Jump_Full_Short'], ['Slash', '1H_Melee_Attack_Slice_Horizontal'], ['Chop', '1H_Melee_Attack_Chop'],
  ['Punch', 'Unarmed_Melee_Attack_Punch_A'], ['Throw', 'Throw'], ['Stance', '2H_Melee_Idle', true],
];
// запасной набор (прежний): Quaternius woman.glb, скелет Mixamo
const CLIPS_QUAT = [
  ['Idle', 'Idle', true], ['Walk', 'Walking', true], ['Run', 'Running', true], ['Punch', 'Punch'], ['Death', 'Death'], ['Jump', 'Jump'],
];
const ALIAS = { // чего нет в запасном наборе
  IdleCalm: 'Idle', WalkBack: 'Walk', StrafeL: 'Run', StrafeR: 'Run', DodgeF: 'Jump', DodgeB: 'Jump', DodgeL: 'Jump', DodgeR: 'Jump',
  Cast1: 'Punch', Cast2: 'Punch', CastRaise: 'Punch', CastHold: 'Punch', BowAim: 'Punch', BowShoot: 'Punch', Block: 'Punch', Blocking: 'Punch',
  BlockHit: 'Punch', Hit: 'Punch', HitB: 'Punch', Victory: 'Jump', Slash: 'Punch', Chop: 'Punch', Throw: 'Punch', Stance: 'Idle',
};
const LOCO = ['Idle', 'Walk', 'Run', 'WalkBack', 'StrafeL', 'StrafeR'];
const LEG_VRM = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
const ANCHOR_NAMES = ['handL', 'handR', 'chest', 'head', 'bowSocket', 'staffTip'];
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---------------------------------------------------------------- общие кэши модуля
const gltfCache = new Map();   // url → Promise<gltf> (библиотеки клипов; только чтение)
const clipCache = new Map();   // vrmUrl + '|' + lib → Promise<{ clips, stride }>
let gltfLoaderP = null;
let defaults = { atmosphere: null, shading: 'realistic', quality: 'medium' };
// [HERO] общие настройки для экземпляров, созданных без явных параметров (удалённый игрок NET)
export function configureHeroes(patch = {}) { defaults = { ...defaults, ...patch }; }

function loadGltf(url) {
  if (!gltfCache.has(url)) {
    if (!gltfLoaderP) gltfLoaderP = import('three/addons/loaders/GLTFLoader.js').then((m) => new m.GLTFLoader());
    const p = gltfLoaderP.then((l) => l.loadAsync(url));
    p.catch(() => gltfCache.delete(url));
    gltfCache.set(url, p);
  }
  return gltfCache.get(url);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// Перенос всех клипов на VRM (кусками, чтобы не было длинного кадра) + длина шага клипов ходьбы.
async function buildClips(THREE, vrm, key, libUrls) {
  if (clipCache.has(key)) return clipCache.get(key);
  const p = (async () => {
    const { clone } = await import('three/addons/utils/SkeletonUtils.js');
    let lib = null, table = null, rig = 'kaykit';
    try { lib = await loadGltf(libUrls.kaykit); table = CLIPS_KAY; } catch (e) {
      console.warn('[HERO] anims_kaykit.glb не загрузилась — запасной набор Quaternius:', e && e.message);
      lib = await loadGltf(libUrls.quat); table = CLIPS_QUAT; rig = 'mixamo';
    }
    const src = clone(lib.scene);
    const clips = {};
    for (const [name, clipName] of table) {
      const c = lib.animations.find((a) => a.name.split('|').pop() === clipName);
      if (!c) continue;
      const clip = retargetClip(THREE, c, src, vrm, 30, rig);
      clip.name = name;
      clips[name] = clip;
      await tick();
    }
    const loops = new Set(table.filter((t) => t[2]).map((t) => t[0]));
    return { clips, loops, rig, stride: measureStrides(THREE, vrm, clips) };
  })();
  p.catch(() => clipCache.delete(key));
  clipCache.set(key, p);
  return p;
}

// Путь за цикл клипа (м, в масштабе VRM до подгонки роста): скорость опорной стопы назад × длительность.
function measureStrides(THREE, vrm, clips) {
  const out = {};
  const H = vrm.humanoid;
  const foot = H.getNormalizedBoneNode('leftFoot'), footR = H.getNormalizedBoneNode('rightFoot');
  if (!foot || !footR) return out;
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const v = new THREE.Vector3();
  for (const name of ['Walk', 'Run', 'WalkBack', 'StrafeL', 'StrafeR']) {
    const clip = clips[name];
    if (!clip) continue;
    const a = mixer.clipAction(clip);
    a.play();
    const N = 48, dur = clip.duration;
    const ys = [], ps = [];
    for (let i = 0; i <= N; i++) {
      mixer.setTime((i / N) * dur);
      vrm.scene.updateMatrixWorld(true);
      foot.getWorldPosition(v);
      ys.push(v.y); ps.push(v.clone());
    }
    a.stop(); mixer.uncacheClip(clip);
    const minY = Math.min(...ys);
    let dist = 0, n = 0;
    for (let i = 1; i <= N; i++) {
      if (ys[i] < minY + 0.03 && ys[i - 1] < minY + 0.03) { dist += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].z - ps[i - 1].z); n++; }
    }
    const dt = dur / N;
    const vSt = n ? dist / (n * dt) : 0;
    out[name] = vSt > 0.05 ? vSt * dur : null; // путь за цикл
  }
  if (H.resetNormalizedPose) H.resetNormalizedPose();
  mixer.uncacheRoot(vrm.scene);
  return out;
}

export function createHeroModel({
  THREE, heroRoot = null, heroBody = null, extras = [], markers = null, scene = null, hero = 'ashen',
  shading, quality, atmosphere, remote = false,
  baseUrl = './assets/quaternius/', vrmUrl = './assets/vroid/', heroesUrl = null,
} = {}) {
  const ownRoot = !heroRoot;
  const root = heroRoot || new THREE.Group();
  if (ownRoot) { root.name = remote ? 'hero-remote' : 'hero-instance'; if (scene) scene.add(root); }
  const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
  const heroesBase = heroesUrl || new URL('../assets/heroes/', import.meta.url).href;
  const libUrls = { kaykit: new URL(KAY, heroesBase).href, quat: new URL('woman.glb', new URL(baseUrl, base)).href };
  const opts = { shading: shading || defaults.shading, quality: quality || defaults.quality, atmosphere: atmosphere || defaults.atmosphere };
  const S = {
    ready: false, disposed: false, hero: 'ashen', token: 0, lean: 0, recoil: 0, prevYaw: null, yawRate: 0,
    blinkT: 2, blink: 0, phase: 0, idleT: 0, lookT: 3, look: 0, lookWant: 0, chestTwist: 0, lod: 0, lodAcc: 0,
    wLoco: { Idle: 1, Walk: 0, Run: 0, WalkBack: 0, StrafeL: 0, StrafeR: 0 }, stun: 0, autoLod: true,
  };
  let cur = null;   // { model, vrm, mixer, full, upper, stride, gear, shade, bones }
  let act = null, actName = '', actUntil = 0, actUpper = false, holdName = '';
  let time = 0, lastStatus = '';
  const pose = { bowDraw: 0, aimX: 0, aimY: 0, handSpell: 0, bowActive: false, w: 0, wBow: 0, wSpell: 0, wStaff: 0, draw: 0 };
  const mirror = { data: null, w: 0 };

  // ---------------------------------------------------------------- якоря C5 (постоянные объекты)
  const anchors = {};
  for (const n of ANCHOR_NAMES) { const o = new THREE.Object3D(); o.name = `hero-anchor-${n}`; anchors[n] = o; }
  function parentAnchors() {
    const put = (name, parent, x, y, z) => { const a = anchors[name]; if (!parent) return; parent.add(a); a.position.set(x, y, z); a.quaternion.identity(); };
    for (const n of ANCHOR_NAMES) { const a = anchors[n]; if (a.parent) a.parent.remove(a); }
    if (cur && cur.vrm) {
      const H = cur.vrm.humanoid;
      const raw = (b) => (H.getRawBoneNode ? H.getRawBoneNode(b) : null) || H.getNormalizedBoneNode(b);
      // якоря ставятся в осях героя (модель смотрит +z) и затем «прилипают» к кости
      const at = (name, bone, off) => {
        const b = raw(bone);
        if (!b) return;
        const a = anchors[name];
        cur.model.updateMatrixWorld(true);
        const p = new THREE.Vector3(); b.getWorldPosition(p);
        const q = new THREE.Quaternion(); cur.model.getWorldQuaternion(q);
        p.add(new THREE.Vector3(off[0], off[1], off[2]).applyQuaternion(q)); // смещение — метры в осях героя
        const wm = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
        b.updateWorldMatrix(true, false);
        wm.premultiply(b.matrixWorld.clone().invert());
        b.add(a);
        wm.decompose(a.position, a.quaternion, a.scale);
      };
      at('handL', 'leftHand', [0.075, -0.01, 0.0]);
      at('handR', 'rightHand', [-0.075, -0.01, 0.0]);
      at('chest', 'upperChest', [0, 0.02, 0.16]);
      at('head', 'head', [0, 0.1, 0.02]);
      at('bowSocket', 'upperChest', [0, 0.02, -0.16]);
      if (!anchors.chest.parent) at('chest', 'chest', [0, 0.05, 0.16]);
      if (!anchors.bowSocket.parent) at('bowSocket', 'chest', [0, 0.05, -0.16]);
      const tip = cur.gear && cur.gear.staffTip;
      if (tip) { tip.add(anchors.staffTip); anchors.staffTip.position.set(0, 0, 0); anchors.staffTip.quaternion.identity(); }
      else at('staffTip', 'rightHand', [-0.09, 0.0, 0.3]);
      return;
    }
    // процедурный герой мира: маркеры рига world.js
    const m = markers || {};
    put('handL', m.handL || root, 0, m.handL ? 0 : 1.0, 0);
    put('handR', m.handR || root, 0, m.handR ? 0 : 1.0, 0);
    put('chest', m.chestFront || root, 0, m.chestFront ? 0 : 1.35, m.chestFront ? 0 : 0.16);
    put('head', m.headTop || root, 0, m.headTop ? -0.1 : 1.65, 0);
    put('bowSocket', m.chestFront || root, 0, m.chestFront ? 0 : 1.35, m.chestFront ? -0.32 : -0.16);
    put('staffTip', m.handR || root, 0, m.handR ? -0.05 : 1.0, m.handR ? 0.35 : 0.3);
  }

  function showProcedural(on) {
    if (heroBody) heroBody.visible = on;
    for (const o of extras) if (o) o.visible = on;
  }

  function clear() {
    const curScene = cur && cur.vrm ? cur.vrm.scene : null;
    // якоря снять с костей до освобождения модели
    for (const n of ANCHOR_NAMES) { const a = anchors[n]; if (a.parent) a.parent.remove(a); }
    if (cur) {
      cur.mixer.stopAllAction();
      cur.mixer.uncacheRoot(cur.vrm.scene);
      if (cur.gear && cur.gear.dispose) { try { cur.gear.dispose(); } catch (e) { console.warn('[HERO] снаряжение не освободилось', e && e.message); } }
      if (cur.shade && cur.shade.dispose) { try { cur.shade.dispose(); } catch (e) { /* ignore */ } }
      if (cur.aura) { try { cur.aura.dispose(); } catch (e) { /* ignore */ } }
      if (cur.model.parent) cur.model.parent.remove(cur.model);
    }
    if (curScene) import('@pixiv/three-vrm').then((V) => { try { V.VRMUtils.deepDispose(curScene); } catch (e) { /* ignore */ } }).catch(() => {});
    cur = null; act = null; actName = ''; holdName = ''; lastStatus = ''; S.dead = false; S.pend = null;
    S.ready = false;
  }

  async function setHero(id) {
    let def = HEROES[id] || EXTRA_HEROES[id] || HEROES.ashen;
    // удалённый экземпляр не может взять процедурное тело мира: страж — на запасной модели
    if (!def.vrm && !def.glb && !heroBody) def = { ...def, glb: HEROES.ashen.glb, height: 1.84, fallbackOf: def.id };
    if (def.id === S.hero && (S.ready || (!def.vrm && !def.glb))) return;
    const token = ++S.token;
    S.hero = def.id;
    clear();
    // пока грузится новая модель — виден процедурный герой, якоря на его маркерах (или на root)
    showProcedural(true); parentAnchors();
    if (!def.vrm && !def.glb) { S.ready = !!heroBody; return; }
    try {
      const url = def.glb ? new URL(def.glb, heroesBase).href : new URL(def.vrm, new URL(vrmUrl, base)).href;
      const vrm = def.glb ? await loadHumanoidGLB(THREE, url) : await loadVRM(THREE, url);
      if (def.recolor) await recolorHero(vrm, def.recolor, def.makeup || null);
      if (def.hide) vrm.scene.traverse((o) => { if (o.isMesh && def.hide.some((n) => o.name.startsWith(n))) o.visible = false; });
      if (def.brows) thinBrows(vrm, def.brows);
      if (S.disposed || token !== S.token) { disposeVrm(vrm); return; }
      const lib = await buildClips(THREE, vrm, url, libUrls);
      if (S.disposed || token !== S.token) { disposeVrm(vrm); return; }
      // рост: VRoid ~1.5–1.6 м — подгоняем под героя
      if (vrm.humanoid.resetNormalizedPose) vrm.humanoid.resetNormalizedPose();
      vrm.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const h = Math.max(1e-3, box.max.y - box.min.y);
      const k = (def.height || 1.7) / h;
      const wrapG = new THREE.Group(); // поворот корпуса, наклон и масштаб — на обёртке
      wrapG.name = 'hero-model';
      wrapG.scale.setScalar(k);
      vrm.scene.position.y = -box.min.y;
      wrapG.add(vrm.scene);
      const mixer = new THREE.AnimationMixer(vrm.scene);
      const legNames = new Set(LEG_VRM.map((b) => { const n = vrm.humanoid.getNormalizedBoneNode(b); return n && n.name; }).filter(Boolean));
      const full = {}, upper = {}, lower = {};
      const names = new Set([...Object.keys(lib.clips), ...Object.keys(ALIAS)]);
      for (const name of names) {
        const clip = lib.clips[name] || lib.clips[ALIAS[name]];
        if (!clip) continue;
        full[name] = mixer.clipAction(clip);
        if (!upperClips.has(clip)) {
          const up = clip.clone();
          up.name = `${clip.name}#upper`;
          up.tracks = up.tracks.filter((tr) => !legNames.has(tr.name.split('.')[0]));
          upperClips.set(clip, up);
        }
        upper[name] = mixer.clipAction(upperClips.get(clip));
        // ноги отдельно: пока действие играет на корпусе, ноги целиком остаются на передвижении
        if (LOCO.includes(name)) {
          if (!lowerClips.has(clip)) {
            const lo = clip.clone();
            lo.name = `${clip.name}#lower`;
            lo.tracks = lo.tracks.filter((tr) => legNames.has(tr.name.split('.')[0]));
            lowerClips.set(clip, lo);
          }
          lower[name] = mixer.clipAction(lowerClips.get(clip));
        }
      }
      root.add(wrapG);
      const H = vrm.humanoid;
      const nb = (n) => H.getNormalizedBoneNode(n);
      const bones = {};
      for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftShoulder', 'rightShoulder']) bones[n] = nb(n);
      const midR = nb('rightMiddleProximal');
      const hands = setupHands(vrm, wrapG);
      // кости без дорожек в клипах (у KayKit — шея, ключицы, верх груди): их сбрасываем в покой каждый
      // кадр, иначе дыхание и поза накапливались бы
      const tracked = new Set();
      for (const clip of Object.values(lib.clips)) for (const tr of clip.tracks) tracked.add(tr.name.split('.')[0]);
      const free = Object.values(bones).filter((b) => b && !tracked.has(b.name));
      cur = { model: wrapG, vrm, mixer, full, upper, lower, midR, stride: lib.stride, loops: lib.loops, bones, free, scale: k, def, gear: null, shade: null, url, hands, rig: lib.rig };
      // оболочка: реалистичные материалы (modules/heroShading.js) и снаряжение (modules/heroGear.js)
      await dressUp(token);
      if (S.disposed || token !== S.token) return;
      showProcedural(false);
      for (const n of LOCO) if (full[n]) { full[n].play(); full[n].setEffectiveWeight(n === 'Idle' ? 1 : 0); if (lower[n]) { lower[n].play(); lower[n].setEffectiveWeight(0); } }
      mixer.update(0);
      parentAnchors();
      if (S.lod) { const l = S.lod; S.lod = -1; applyLod(l); }   // LOD, заданный до загрузки
      S.ready = true;
      if (stance) setStance(stance);
    } catch (e) {
      console.warn('[ASHEN] модель героя не загрузилась — процедурный герой:', e && e.message);
      if (token === S.token) { clear(); S.hero = heroBody ? 'ashen' : def.id; showProcedural(true); parentAnchors(); S.ready = !!heroBody; }
    }
  }
  const upperClips = new WeakMap(), lowerClips = new WeakMap();
  let heroTimeU = null; // общее время шейдеров героев (жилы лат, аура)
  function disposeVrm(vrm) { import('@pixiv/three-vrm').then((V) => { try { V.VRMUtils.deepDispose(vrm.scene); } catch (e) { /* ignore */ } }).catch(() => {}); }
  // [HERO] модель не загрузилась: страж — процедурное тело мира, прочие — запасная модель
  void disposeVrm;

  // ---------------------------------------------------------------- кисти: хват оружия и пальцы
  // В покое нормализованного скелета (T-поза, ладони вниз) по костям кисти находим центр кулака и оси:
  // древко (посох, рукоять лука) проходит сквозь кулак поперёк пальцев — вдоль оси «мизинец → большой палец».
  // Узлы хвата (дети нормализованных кистей): y — к большому пальцу, z — к запястью, x = y × z.
  //   правая — heroStaffGrip (посох), левая — heroBowGrip (лук: тетива к лучнику).
  // (Клипы KayKit держат оружие «варежкой» вдоль предплечья — для настоящих пальцев это не годится.)
  const FING = ['Index', 'Middle', 'Ring', 'Little'];
  function setupHands(vrm, wrapG) {
    const H = vrm.humanoid;
    const nb = (n) => H.getNormalizedBoneNode(n);
    if (H.resetNormalizedPose) H.resetNormalizedPose();
    wrapG.updateWorldMatrix(true, true);
    const wp = (o) => o.getWorldPosition(new THREE.Vector3());
    const out = { left: null, right: null, bowGrip: null, staffGrip: null, nock: nb('rightMiddleIntermediate') || nb('rightIndexProximal') || nb('rightHand') };
    const k = wrapG.getWorldScale(new THREE.Vector3()).x || 1;
    for (const side of ['left', 'right']) {
      const hand = nb(side + 'Hand');
      if (!hand) continue;
      const s = side === 'left' ? 1 : -1;
      const fingers = FING.map((f) => ['Proximal', 'Intermediate', 'Distal'].map((j) => nb(`${side}${f}${j}`)));
      const thumb = ['Metacarpal', 'Proximal', 'Distal'].map((j) => nb(`${side}Thumb${j}`));
      const H0 = { side, s, hand, fingers, thumb, w: { relax: 1, grip: 0, hook: 0, open: 0 } };
      const Ph = wp(hand), Pm = fingers[1][0] ? wp(fingers[1][0]) : Ph.clone().add(new THREE.Vector3(0.08 * s, 0, 0));
      const Pi = fingers[0][0] ? wp(fingers[0][0]) : Pm, Pl = fingers[3][0] ? wp(fingers[3][0]) : Pm;
      const d = Pm.clone().sub(Ph); const len = d.length(); d.normalize();
      const across = Pi.clone().sub(Pl); if (across.lengthSq() < 1e-8) across.set(0, 0, 1);
      across.addScaledVector(d, -across.dot(d)).normalize();             // к большому пальцу
      const n = d.clone().cross(across).normalize(); if (n.y > 0) n.negate(); // ладонь (вниз в T-позе)
      // центр кулака: у костяшек, на толщину пальцев к ладони
      const c = Ph.clone().addScaledVector(d, len * 0.92).addScaledVector(n, 0.026 * k).addScaledVector(across, -0.004 * k);
      H0.grip = hand.worldToLocal(c.clone());
      // оси в покое (у нормализованных костей покой — единичный поворот: оси кисти = оси пальцев)
      const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
      const dL = d.clone().transformDirection(inv), nL = n.clone().transformDirection(inv), aL = across.clone().transformDirection(inv);
      H0.axCurl = dL.clone().cross(nL).normalize();       // палец → к ладони
      H0.axSpread = dL.clone().cross(aL).normalize();     // палец → к большому
      H0.axThFlex = aL.clone().cross(nL).normalize();     // большой → к ладони
      H0.axThIn = aL.clone().cross(dL).normalize();       // большой → к пальцам
      H0.dL = dL; H0.aL = aL; H0.nL = nL;
      out[side] = H0;
      const g = new THREE.Object3D(); g.name = side === 'left' ? 'heroBowGrip' : 'heroStaffGrip';
      hand.add(g); g.position.copy(H0.grip);
      const by = across.clone(), bz = d.clone().negate(), bx = by.clone().cross(bz).normalize();
      const qW = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, by, bz));
      g.quaternion.copy(hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qW));
      if (side === 'left') out.bowGrip = g; else out.staffGrip = g;
    }
    return out;
  }
  // позы пальцев: сгиб [прокс., средн., дист.] для указательного…мизинца, развод пальцев, большой палец
  // [сгиб к ладони, увод к пальцам, сгиб 2-й фаланги, сгиб 3-й]
  const HAND_POSES = {
    relax: { curl: [[0.22, 0.34, 0.2], [0.28, 0.42, 0.24], [0.34, 0.48, 0.26], [0.42, 0.52, 0.28]], spread: [0.08, 0.01, -0.05, -0.12], thumb: [0.28, 0.12, 0.22, 0.18] },
    grip: { curl: [[1.3, 1.5, 0.9], [1.38, 1.55, 0.92], [1.45, 1.55, 0.92], [1.5, 1.5, 0.9]], spread: [0.03, 0, -0.03, -0.07], thumb: [0.75, 0.38, 0.5, 0.45] },
    hook: { curl: [[0.4, 1.25, 0.85], [0.45, 1.3, 0.9], [0.55, 1.3, 0.85], [1.25, 1.45, 0.9]], spread: [0.05, 0, -0.04, -0.08], thumb: [0.65, 0.32, 0.6, 0.5] },
    open: { curl: [[0.04, 0.08, 0.05], [0.05, 0.08, 0.05], [0.08, 0.1, 0.06], [0.1, 0.12, 0.08]], spread: [0.17, 0.02, -0.13, -0.26], thumb: [0.02, 0.32, 0.05, 0.05] },
  };
  const HP_KEYS = Object.keys(HAND_POSES);
  const _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion();
  function applyFingers(dt, want) {
    const hs = cur && cur.hands;
    if (!hs) return;
    const kf = 1 - Math.exp(-14 * dt);
    for (const side of ['left', 'right']) {
      const h = hs[side];
      if (!h) continue;
      const tw = want[side] || { relax: 1 };
      let sum = 0;
      for (const key of HP_KEYS) { h.w[key] += ((tw[key] || 0) - h.w[key]) * kf; sum += h.w[key]; }
      sum = sum || 1;
      for (let f = 0; f < 4; f++) {
        let spread = 0;
        const c = [0, 0, 0];
        for (const key of HP_KEYS) {
          const w = h.w[key] / sum;
          if (w < 1e-4) continue;
          const P = HAND_POSES[key];
          spread += P.spread[f] * w;
          for (let j = 0; j < 3; j++) c[j] += P.curl[f][j] * w;
        }
        const alive = (h.w.relax / sum) * 0.045 * Math.sin(time * (0.55 + 0.13 * f) + f * 1.7 + (h.s > 0 ? 0 : 2.3));
        for (let j = 0; j < 3; j++) {
          const b = h.fingers[f][j];
          if (!b) continue;
          b.quaternion.setFromAxisAngle(h.axCurl, c[j] + alive * (1 + 0.3 * j));
          if (j === 0) b.quaternion.premultiply(_fq.setFromAxisAngle(h.axSpread, spread));
        }
      }
      const t = [0, 0, 0, 0];
      for (const key of HP_KEYS) { const w = h.w[key] / sum; if (w < 1e-4) continue; for (let j = 0; j < 4; j++) t[j] += HAND_POSES[key].thumb[j] * w; }
      const [m, p, d] = h.thumb;
      if (m) m.quaternion.setFromAxisAngle(h.axThFlex, t[0]).premultiply(_fq.setFromAxisAngle(h.axThIn, t[1]));
      if (p) p.quaternion.setFromAxisAngle(h.axThFlex, t[2] * 0.6).premultiply(_fq2.setFromAxisAngle(h.axThIn, t[2] * 0.5));
      if (d) d.quaternion.setFromAxisAngle(h.axThFlex, t[3] * 0.5).premultiply(_fq2.setFromAxisAngle(h.axThIn, t[3] * 0.6));
    }
  }
  // чего хотят кисти в этом кадре: посох — кулак правой, лук — кулак левой и «крюк» правой, чары — ладони
  const _hw = { left: { relax: 1 }, right: { relax: 1 } };
  function handWants() {
    const staff = !!(cur.gear && cur.gear.staffTip);
    const bowHeld = !!pose.bowHeld;
    const spell = pose.wSpell > 0.3 && pose.wBow < 0.5;
    const L = _hw.left, R = _hw.right;
    L.relax = 1; L.grip = 0; L.hook = 0; L.open = 0;
    R.relax = 1; R.grip = 0; R.hook = 0; R.open = 0;
    if (bowHeld) { L.relax = 0; L.grip = 1; }
    else if (spell) { L.relax = 0; L.open = 1; }
    if (staff) { R.relax = 0; R.grip = 1; }
    else if (bowHeld) { const d = clamp(pose.draw * 3, 0, 1); R.relax = 1 - d; R.hook = d; }
    else if (spell) { R.relax = 0; R.open = 1; }
    return _hw;
  }

  // [HERO] тонкие брови: у Quaternius брови — толстые «бруски»; по полосам вдоль брови толщина сжимается
  // к средней линии (k — доля толщины). Оси позы привязки: Y — вверх, X — поперёк лица. Своя копия
  // геометрии (экземпляры одной модели её не делят).
  function thinBrows(vrm, k) {
    vrm.scene.traverse((o) => {
      if (!o.isMesh || !/Eyebrow/i.test(o.name)) return;
      const g = o.geometry.clone(), pa = g.attributes.position, n = pa.count;
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 0; i < n; i++) { const x = pa.getX(i); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      // средняя линия брови по полосам вдоль X (обе брови в одном меше — пустые полосы между ними пропускаем)
      const B = 48, lo = new Float32Array(B).fill(Infinity), hi = new Float32Array(B).fill(-Infinity);
      const bin = (x) => Math.min(B - 1, Math.max(0, Math.floor(((x - x0) / (x1 - x0 || 1)) * B)));
      for (let i = 0; i < n; i++) { const b = bin(pa.getX(i)), y = pa.getY(i); lo[b] = Math.min(lo[b], y); hi[b] = Math.max(hi[b], y); }
      const mid = new Float32Array(B), has = (b) => b >= 0 && b < B && Number.isFinite(lo[b]);
      for (let b = 0; b < B; b++) if (has(b)) mid[b] = (lo[b] + hi[b]) / 2;
      const sm = mid.map((v, b) => { let acc = 0, w = 0; for (const [d, k2] of [[-1, 1], [0, 2], [1, 1]]) if (has(b + d)) { acc += mid[b + d] * k2; w += k2; } return w ? acc / w : v; });
      // средняя линия — непрерывно (линейно между центрами полос), без ступенек на границах полос
      for (let i = 0; i < n; i++) {
        const x = pa.getX(i), f = ((x - x0) / (x1 - x0 || 1)) * B - 0.5, b0 = Math.floor(f), t = f - b0;
        const c0 = has(b0) ? sm[b0] : null, c1 = has(b0 + 1) ? sm[b0 + 1] : null;
        const c = c0 !== null && c1 !== null ? c0 + (c1 - c0) * t : (c0 ?? c1);
        if (c === null) continue;
        pa.setY(i, c + (pa.getY(i) - c) * k);
      }
      pa.needsUpdate = true; g.computeBoundingBox(); g.computeBoundingSphere();
      o.geometry = g;
    });
  }

  // перекраска атласа костюма (heroShading.recolorTexture) — у каждого экземпляра своя текстура
  async function recolorHero(vrm, rules, makeup = null) {
    try {
      const m = await import('./heroShading.js');
      const paint = makeup ? m.makeupPainter(makeup) : null;
      vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const mt of [].concat(o.material)) {
          const R = mt && rules[mt.name];
          if (!R || !mt.map || mt.userData.recolored) continue;
          const face = /^MI_Regular_Female/.test(mt.name) && !!paint;
          const nt = m.recolorTexture(THREE, mt.map, R, face ? paint : null, mt.metalnessMap ? mt.metalnessMap.image : null, face ? 2 : 1);
          if (nt !== mt.map) { mt.map = nt; mt.userData.recolored = true; mt.needsUpdate = true; }
        }
      });
    } catch (e) { console.warn('[HERO] перекраска', e && e.message); }
  }

  async function dressUp(token) {
    if (!cur) return;
    const c = cur;
    try {
      const m = await import('./heroShading.js');
      if (token !== S.token || cur !== c) return;
      c.shade = m.shadeHero(THREE, c.vrm, { mode: opts.shading, atmosphere: opts.atmosphere, quality: opts.quality, heroId: c.def.id, fx: c.def.fx || null, hairColor: c.def.hair ? c.def.hair.color : null });
      heroTimeU = m.HERO_TIME;
    } catch (e) { console.warn('[HERO] heroShading недоступен, MToon как есть:', e && e.message); }
    try {
      const g = await import('./heroGear.js');
      if (token !== S.token || cur !== c) return;
      // снаряжение крепится в позе Idle (кадр 0): рукоять посоха вертикально в опущенной руке
      if (c.full.Idle) { c.full.Idle.play(); c.full.Idle.setEffectiveWeight(1); c.mixer.update(0); }
      const add = c.def.adduct ?? 0.22; // та же поза рук, что в игре (см. applyLife)
      adduct(c.bones.leftUpperArm, -add); adduct(c.bones.rightUpperArm, add);
      c.vrm.update(0);
      c.gear = g.dressHero(THREE, c.vrm, { preset: c.def.gear, heroId: c.def.id, model: c.model, atmosphere: opts.atmosphere, quality: opts.quality, shading: opts.shading, ears: !!c.def.ears, hair: c.def.hair || null, circlet: c.def.circlet || null, lashes: c.def.lashes || null, hoodTrim: c.def.hoodTrim || null, fx: c.def.fx || null, grips: c.hands ? { R: c.hands.staffGrip, L: c.hands.bowGrip } : null });
      if (c.full.Idle) c.full.Idle.stop();
    } catch (e) { console.warn('[HERO] heroGear недоступен, без снаряжения:', e && e.message); }
    // аура класса (частицы стихии в шейдере) — modules/heroAura.js
    if (c.def.fx) {
      try {
        const am = await import('./heroAura.js');
        if (token !== S.token || cur !== c) return;
        c.aura = am.createHeroAura(THREE, c.model, c.def.fx, { quality: opts.quality, height: (c.def.height || 1.8) / (c.scale || 1) });
      } catch (e) { console.warn('[HERO] аура недоступна:', e && e.message); }
    }
  }

  function setShading(mode) {
    if (mode !== 'realistic' && mode !== 'anime') return;
    if (opts.shading === mode) return;
    opts.shading = mode;
    if (cur && cur.shade && cur.shade.setMode) cur.shade.setMode(mode);
    if (cur && cur.gear && cur.gear.setShading) cur.gear.setShading(mode);
  }
  function setQuality(q) {
    opts.quality = q;
    if (cur && cur.shade && cur.shade.setQuality) cur.shade.setQuality(q);
    if (cur && cur.gear && cur.gear.setQuality) cur.gear.setQuality(q);
  }
  // LOD: 0 — полный, 1 — пружины и ткань через кадр, без теней, 2 — без пружин, 10 Гц анимации
  const _lodV = new THREE.Vector3();
  function setLod(level) { S.autoLod = false; applyLod(level); }
  function applyLod(level) {
    const l = clamp(Math.round(num(level, 0)), 0, 2);
    if (l === S.lod) return;
    S.lod = l;
    if (cur) cur.vrm.scene.traverse((o) => { if (o.isMesh) o.castShadow = l === 0; });
    if (cur && cur.gear && cur.gear.setLod) cur.gear.setLod(l);
    if (cur && cur.aura) cur.aura.setLod(l);
  }

  // ---------------------------------------------------------------- слой действий
  function stopAct(fade = 0.2) {
    if (act) act.fadeOut(fade);
    act = null; actName = ''; holdName = '';
  }
  function playAct(name, { speed = 1, upperOnly = false, fade = 0.12, loop = false, holdKey = '', freezeAt = null } = {}) {
    if (!cur) return;
    const a = (upperOnly ? cur.upper : cur.full)[name];
    if (!a) return;
    if (act && act !== a) act.fadeOut(fade);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.setEffectiveWeight(1).fadeIn(fade).play();
    const dur = a.getClip().duration;
    if (freezeAt !== null) { a.time = dur * freezeAt; a.timeScale = 0; }
    act = a; actName = name; actUpper = upperOnly; holdName = holdKey;
    actUntil = loop || freezeAt !== null ? Infinity : time + dur / Math.max(0.01, speed) - 0.1;
  }

  // ---------------------------------------------------------------- передвижение: бленд по направлению
  function updateLoco(dt, lx, lz, sp, sprint) {
    const F = cur.full;
    const ang = Math.atan2(lx, lz); // 0 — вперёд, +π/2 — влево (+x героя)
    const moveW = smooth(0.25, 0.9, sp);
    const cf = Math.cos(ang), sf = Math.sin(ang);
    let wf = Math.max(0, cf), wb = Math.max(0, -cf), wl = Math.max(0, sf), wr = Math.max(0, -sf);
    const sum = wf + wb + wl + wr || 1;
    wf /= sum; wb /= sum; wl /= sum; wr /= sum;
    const runK = smooth(1.9, 3.6, sp);
    // поворот на месте: переступание боковым шагом
    let turnW = 0;
    if (sp < 0.3 && Math.abs(S.yawRate) > 1.1) {
      turnW = smooth(1.1, 3, Math.abs(S.yawRate)) * 0.55; // yaw растёт — поворот влево
    }
    const want = {
      Idle: Math.max(0, 1 - moveW - turnW),
      Walk: moveW * wf * (1 - runK), Run: moveW * wf * runK,
      WalkBack: moveW * wb, StrafeL: moveW * wl + (S.yawRate > 0 ? turnW : 0), StrafeR: moveW * wr + (S.yawRate < 0 ? turnW : 0),
    };
    // фаза шага по пройденному пути: общий цикл для всех клипов ходьбы
    const st = cur.stride || {};
    const k = cur.scale || 1;
    let dist = 0, wsum = 0;
    for (const n of ['Walk', 'Run', 'WalkBack', 'StrafeL', 'StrafeR']) {
      const d = st[n] ? st[n] * k : ({ Walk: 1.3, Run: 2.4, WalkBack: 1.1, StrafeL: 2.0, StrafeR: 2.0 })[n];
      dist += d * want[n]; wsum += want[n];
    }
    const cyc = wsum > 1e-3 ? dist / wsum : 1.4;
    const v = turnW && sp < 0.3 ? Math.abs(S.yawRate) * 0.35 : sp;
    S.phase = (S.phase + (dt * v) / Math.max(0.3, cyc)) % 1;
    const kf = 1 - Math.exp(-10 * dt);
    // действие перекрывает передвижение (микшер нормирует сумму весов — иначе вышло бы 50/50):
    // на всё тело — передвижение гаснет; только корпус — ноги берут отдельные «нижние» клипы
    const aw = act ? clamp(act.getEffectiveWeight(), 0, 1) : 0;
    const keepFull = 1 - aw, keepLower = actUpper ? aw : 0;
    for (const n of LOCO) {
      const a = F[n];
      if (!a) continue;
      S.wLoco[n] += ((want[n] || 0) - S.wLoco[n]) * kf;
      a.setEffectiveWeight(S.wLoco[n] * keepFull);
      a.enabled = true;
      const lo = cur.lower && cur.lower[n];
      if (lo) { lo.enabled = true; lo.setEffectiveWeight(S.wLoco[n] * keepLower); }
      if (n === 'Idle') { a.timeScale = 1; if (lo) { lo.timeScale = 0; lo.time = a.time; } continue; }
      a.timeScale = 0;
      a.time = S.phase * a.getClip().duration;
      if (lo) { lo.timeScale = 0; lo.time = a.time; }
    }
    void sprint;
  }

  // ---------------------------------------------------------------- поза поверх анимации (C5, зеркало)
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qm = new THREE.Quaternion();
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _rest = new THREE.Vector3();
  // Кость bone (нормализованная, покой = T-поза, направление покоя restDir в осях модели) направить
  // в сторону dirModel (оси героя: +z вперёд, +x влево, +y вверх) с весом w.
  function aimBone(bone, restDir, dirModel, w) {
    if (!bone || w <= 0.001) return;
    cur.vrm.scene.getWorldQuaternion(_qm);
    _rest.copy(restDir).applyQuaternion(_qm);
    _v.copy(dirModel).normalize().applyQuaternion(_qm);
    _q.setFromUnitVectors(_rest, _v).multiply(_qm);       // желаемый поворот в мире
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_q2);
    _q.premultiply(_q2.invert());                        // → локальный
    bone.quaternion.slerp(_q, clamp(w, 0, 1));
    bone.updateWorldMatrix(false, false);
  }
  // Кисть (нормализованная) развернуть: пальцы — по dirModel, большой палец — к thumbModel (оси героя).
  const _ob1 = new THREE.Matrix4(), _ob2 = new THREE.Matrix4(), _obx = new THREE.Vector3(), _oby = new THREE.Vector3(), _obz = new THREE.Vector3();
  function orientHand(h, dirModel, thumbModel, w) {
    if (!h || !h.hand || w <= 0.001) return;
    const bone = h.hand;
    cur.vrm.scene.getWorldQuaternion(_qm);
    _obx.copy(dirModel).normalize().applyQuaternion(_qm);
    _oby.copy(thumbModel).applyQuaternion(_qm);
    _oby.addScaledVector(_obx, -_oby.dot(_obx));
    if (_oby.lengthSq() < 1e-6) { _oby.set(0, 0, 1).applyQuaternion(_qm); _oby.addScaledVector(_obx, -_oby.dot(_obx)); }
    _oby.normalize();
    _obz.crossVectors(_obx, _oby);
    _ob1.makeBasis(_obx, _oby, _obz);                               // желаемые оси кисти в мире
    // оси покоя в осях кисти (dL — к пальцам, aL — к большому): Q_мир = B(цель) · B(покой)ᵀ
    _v.copy(h.dL); _v2.copy(h.aL).addScaledVector(h.dL, -h.aL.dot(h.dL)).normalize();
    _rest.crossVectors(_v, _v2);
    _ob2.makeBasis(_v, _v2, _rest).transpose().premultiply(_ob1);
    _q.setFromRotationMatrix(_ob2);
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_q2);
    _q.premultiply(_q2.invert());
    bone.quaternion.slerp(_q, clamp(w, 0, 1));
    bone.updateWorldMatrix(false, false);
  }
  // IK двух костей (плечо → локоть → кисть): кисть в точку targetW, локоть — в сторону poleW (мир)
  const _ikS = new THREE.Vector3(), _ikE = new THREE.Vector3(), _ikH = new THREE.Vector3(), _ikD = new THREE.Vector3(), _ikM = new THREE.Vector3(), _ikT = new THREE.Vector3(), _ikV = new THREE.Vector3();
  const _bw1 = new THREE.Vector3(), _bw2 = new THREE.Vector3(), _bw3 = new THREE.Vector3(), _bw4 = new THREE.Vector3(), _bw5 = new THREE.Vector3(), _bw6 = new THREE.Vector3();
  function aimBoneW(bone, restDir, dirW, w) {
    if (!bone || w <= 0.001) return;
    cur.vrm.scene.getWorldQuaternion(_qm);
    _rest.copy(restDir).applyQuaternion(_qm);
    _ikV.copy(dirW).normalize();
    _q.setFromUnitVectors(_rest, _ikV).multiply(_qm);
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_q2);
    _q.premultiply(_q2.invert());
    bone.quaternion.slerp(_q, clamp(w, 0, 1));
    bone.updateWorldMatrix(false, false);
  }
  function ikArm(upper, lower, hand, rest, targetW, poleW, w, maxReach = 1) {
    if (!upper || !lower || !hand || w <= 0.001) return;
    upper.updateWorldMatrix(true, true);
    upper.getWorldPosition(_ikS); lower.getWorldPosition(_ikE); hand.getWorldPosition(_ikH);
    const L1 = _ikS.distanceTo(_ikE), L2 = _ikE.distanceTo(_ikH);
    _ikD.copy(targetW).sub(_ikS);
    let dist = _ikD.length();
    if (dist < 1e-4) return;
    _ikD.divideScalar(dist);
    dist = clamp(dist, Math.abs(L1 - L2) + 1e-3, (L1 + L2) * maxReach - 1e-4);
    const ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sa = Math.sqrt(1 - ca * ca);
    _ikM.copy(poleW).addScaledVector(_ikD, -poleW.dot(_ikD));
    if (_ikM.lengthSq() < 1e-8) _ikM.set(0, -1, 0).addScaledVector(_ikD, _ikD.y);
    _ikM.normalize();
    _ikE.copy(_ikS).addScaledVector(_ikD, L1 * ca).addScaledVector(_ikM, L1 * sa);
    _ikT.copy(_ikS).addScaledVector(_ikD, dist);
    aimBoneW(upper, rest, _ikH.copy(_ikE).sub(_ikS), w);
    aimBoneW(lower, rest, _ikH.copy(_ikT).sub(_ikE), w);
  }
  const RL = new THREE.Vector3(1, 0, 0), RR = new THREE.Vector3(-1, 0, 0);
  const _upV = new THREE.Vector3();
  const dA = new THREE.Vector3(), dB = new THREE.Vector3();
  function applyPose(dt) {
    const B = cur.bones;
    const kf = (r) => 1 - Math.exp(-r * dt);
    const bowOn = pose.bowActive || pose.bowDraw > 0.02;
    pose.wBow += ((bowOn ? 1 : 0) - pose.wBow) * kf(bowOn ? 10 : 5);
    pose.wSpell += (clamp(pose.handSpell, 0, 1) - pose.wSpell) * kf(8);
    pose.draw += (clamp(pose.bowDraw, 0, 1) - pose.draw) * kf(18);
    const ax = clamp(pose.aimX, -1, 1), ay = clamp(pose.aimY, -1, 1);
    // лук: корпус боком к цели (левым плечом вперёд), голова — к цели; левая рука прямая по линии прицела,
    // правая (IK) тянет тетиву от лука к челюсти, локоть уходит назад-вбок и поднимается с натяжением
    if (pose.wBow > 0.01) {
      const w = pose.wBow, d = pose.draw, de = d * d * (3 - 2 * d);
      if (B.spine) { B.spine.rotateY(-0.22 * w); B.spine.updateWorldMatrix(false, false); }
      if (B.chest) { B.chest.rotateY(-0.5 * w); B.chest.updateWorldMatrix(false, false); }
      if (B.neck) B.neck.rotateY(0.32 * w);
      if (B.head) { B.head.rotateY(0.36 * w); B.head.rotateX(0.05 * w); }
      cur.vrm.scene.getWorldQuaternion(_qm);
      dA.set(-ax * 0.55, 0.06 + ay * 0.5, 1).normalize();          // линия прицела (оси героя; +x — влево)
      _bw1.copy(dA).applyQuaternion(_qm);
      B.leftUpperArm.updateWorldMatrix(true, false); B.leftUpperArm.getWorldPosition(_bw2);
      ikArm(B.leftUpperArm, B.leftLowerArm, B.leftHand, RL, _bw3.copy(_bw2).addScaledVector(_bw1, 2), _bw4.set(0.15, -1, 0).applyQuaternion(_qm), w, 0.97);
      // кисть левой: костяшки по линии прицела, большой палец вверх — лук стоит вертикально с лёгким кантом
      if (cur.hands) orientHand(cur.hands.left, dA, _upV.set(-0.22, 1, 0), w);
      // точка тетивы: у лука (покой) → у правой скулы (полное натяжение)
      B.leftHand.updateWorldMatrix(true, false); B.leftHand.getWorldPosition(_bw2);
      B.head.updateWorldMatrix(true, false); B.head.getWorldPosition(_bw3);
      _bw3.addScaledVector(_bw4.set(-0.055, -0.07, 0.06).applyQuaternion(_qm), 1);   // скула
      _bw4.copy(_bw3).sub(_bw2).normalize();
      _bw5.copy(_bw2).addScaledVector(_bw4, 0.2).lerp(_bw3, de);
      _bw5.addScaledVector(_bw1, -0.075);                                             // кисть — позади пальцев
      ikArm(B.rightUpperArm, B.rightLowerArm, B.rightHand, RR, _bw5, _bw6.set(-1, -0.45 + 0.95 * de, -0.55).applyQuaternion(_qm), w, 1);
      if (cur.hands) orientHand(cur.hands.right, dA, _upV.set(0, 1, 0), w * (0.4 + 0.6 * de));
    }
    // лук из-за спины — в кулак левой (узел хвата: рукоять в кулаке, тетивой к лучнику)
    if (cur.gear && cur.gear.setBowHeld && cur.gear.bow) {
      const held = pose.wBow > 0.35 || (pose.bowHeld && pose.wBow > 0.2);
      pose.bowHeld = held;
      if (held && cur.hands && cur.hands.bowGrip) {
        cur.vrm.scene.updateMatrixWorld(true);
        cur.gear.setBowHeld(true, cur.hands.bowGrip, cur.hands.nock, pose.draw);
      } else cur.gear.setBowHeld(false);
    }
    // посох: правая «несёт» его — плечо вниз, локоть согнут, предплечье вперёд, кулак большим пальцем вверх,
    // древко стоит вертикально (на бегу — наклон вперёд и мах руки в такт шагу). Во время действий слой
    // слабеет — посох идёт за кистью клипа (каст — навершием к цели, удар — взмах).
    if (cur.gear && cur.gear.staffTip && cur.hands) {
      const acting = !!act && holdName !== 'stance';
      pose.wStaff += ((acting ? 0.12 : 1) - pose.wStaff) * kf(acting ? 12 : 5);
      const w = pose.wStaff * (1 - pose.wBow) * (1 - pose.wSpell) * (1 - 0.85 * mirror.w);
      if (w > 0.01) {
        const mv = clamp(1 - S.wLoco.Idle, 0, 1), run = clamp(S.wLoco.Run + 0.6 * (S.wLoco.StrafeL + S.wLoco.StrafeR), 0, 1);
        const sw = Math.sin(S.phase * Math.PI * 2) * 0.2 * mv;
        aimBone(B.rightUpperArm, RR, dB.set(-0.16, -1, 0.14 + sw + 0.12 * run), w);
        aimBone(B.rightLowerArm, RR, dB.set(-0.2, -0.32 + 0.22 * run, 1), w);
        orientHand(cur.hands.right, dB.set(-0.1, -0.12, 1), _upV.set(-0.05, 1, 0.1 + 0.5 * run), w);
      }
    }
    // чары рукой: обе ладони перед грудью, сфера между ними; с силой руки расходятся
    if (pose.wSpell > 0.01 && pose.wBow < 0.9) {
      const w = pose.wSpell * (1 - pose.wBow);
      const spread = 0.25 + 0.2 * clamp(pose.handSpell, 0, 1);
      dA.set(spread - ax * 0.4, -0.35 + ay * 0.5, 1);
      aimBone(B.leftUpperArm, RL, dA, w);
      dA.set(-0.55 - ax * 0.3, 0.15 + ay * 0.4, 0.8);
      aimBone(B.leftLowerArm, RL, dA, w);
      dB.set(-spread - ax * 0.4, -0.35 + ay * 0.5, 1);
      aimBone(B.rightUpperArm, RR, dB, w);
      dB.set(0.55 - ax * 0.3, 0.15 + ay * 0.4, 0.8);
      aimBone(B.rightLowerArm, RR, dB, w);
    }
    // зеркало рук игрока: векторы плечо→локоть, локоть→кисть в кадре (x вправо, y вниз)
    const m = mirror.data;
    mirror.w += ((m ? 1 : 0) - mirror.w) * kf(m ? 6 : 3);
    if (mirror.w > 0.01 && m) {
      const w = mirror.w * 0.85 * (1 - pose.wBow) * (1 - pose.wSpell);
      for (const [side, up, lo, rest] of [['left', B.leftUpperArm, B.leftLowerArm, RL], ['right', B.rightUpperArm, B.rightLowerArm, RR]]) {
        const a = m[side];
        if (!a || !a.upper || !a.fore) continue;
        // экран: вправо = вправо героя (−x), вниз = −y; чуть вперёд, чтобы кисть не уходила в тело
        aimBone(up, rest, dA.set(-a.upper.x, -a.upper.y, 0.3), w);
        aimBone(lo, rest, dB.set(-a.fore.x, -a.fore.y, 0.45), w);
      }
    }
    // посох в зеркале рук и в позе чар: кулак большим пальцем вверх — древко остаётся почти вертикальным
    // (иначе при поднятой руке игрока посох ложился бы горизонтально или переворачивался)
    if (cur.gear && cur.gear.staffTip && cur.hands) {
      const actingNow = !!act && holdName !== 'stance';
      const wUp = Math.max(mirror.w * 0.9, pose.wSpell) * (1 - pose.wBow) * (actingNow ? 0.3 : 1);
      if (wUp > 0.01 && B.rightLowerArm && B.rightHand) {
        B.rightHand.updateWorldMatrix(true, false);
        B.rightLowerArm.getWorldPosition(_bw1); B.rightHand.getWorldPosition(_bw2);
        cur.vrm.scene.getWorldQuaternion(_qm);
        _bw2.sub(_bw1).normalize().applyQuaternion(_q.copy(_qm).invert());   // предплечье в осях героя
        // рука поднята/опущена отвесно — запястье сгибается к «вперёд», древко поднимается по диагонали
        const bend = smooth(0.55, 0.95, Math.abs(_bw2.y)) * 0.75;
        if (bend > 0) { _bw3.set(_bw2.x * 0.3, 0, 1).normalize(); _bw2.lerp(_bw3, bend).normalize(); }
        orientHand(cur.hands.right, _bw2, _upV.set(0, 1, 0.15), wUp);
      }
    }
  }

  // руки клипов KayKit (коренастые персонажи) разведены в стороны: сводим плечи к телу
  const _ax = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qp = new THREE.Quaternion();
  function adduct(bone, angle) {
    if (!bone || Math.abs(angle) < 1e-4) return;
    cur.model.getWorldQuaternion(_qp);
    _ax.set(0, 0, 1).applyQuaternion(_qp);                    // ось «вперёд» героя в мире
    _qa.setFromAxisAngle(_ax, angle);
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_qp);
    // local' = P⁻¹ · R · P · local
    bone.quaternion.premultiply(_qp).premultiply(_qa).premultiply(_qp.invert());
  }
  // дыхание, оглядывание в покое, доворот груди к цели
  const _lk = new THREE.Vector3();
  function applyLife(dt, idle, twist, menu = false) {
    const B = cur.bones;
    const add = (cur.def.adduct ?? 0.22) * (act ? 0.35 : 1);
    adduct(B.leftUpperArm, -add);
    adduct(B.rightUpperArm, add);
    S.idleT = idle ? S.idleT + dt : 0;
    const br = Math.sin(time * 1.7) * 0.022 * (idle ? 1 : 0.4);
    if (B.upperChest) B.upperChest.rotateX(-br);
    else if (B.chest) B.chest.rotateX(-br);
    if (B.leftShoulder) B.leftShoulder.rotateZ(br * 0.6);
    if (B.rightShoulder) B.rightShoulder.rotateZ(-br * 0.6);
    S.lookT -= dt;
    if (S.lookT <= 0) {
      S.lookT = 2.5 + Math.random() * 3.5;
      // на витрине меню герой то и дело смотрит на игрока (в камеру), иначе — оглядывается
      // приближенная витрина (setGaze) — почти всё время смотрит в камеру
      S.lookCam = menu && !!defaults.camera && Math.random() < 0.55 + 0.4 * (S.gaze || 0);
      S.lookWant = S.idleT > 4 ? (Math.random() - 0.5) * 0.6 : 0;
    }
    if (S.lookCam && menu && defaults.camera) {
      root.getWorldPosition(_lk);
      const ang = wrap(Math.atan2(defaults.camera.position.x - _lk.x, defaults.camera.position.z - _lk.z) - root.rotation.y);
      S.lookWant = Math.abs(ang) < 1.4 ? clamp(ang, -0.75, 0.75) : 0;
    }
    if (!idle) S.lookWant = 0;
    S.look += (S.lookWant - S.look) * (1 - Math.exp(-1.6 * dt));
    if (B.neck) B.neck.rotateY(S.look * 0.45);
    if (B.head) B.head.rotateY(S.look * 0.55);
    S.chestTwist += (twist - S.chestTwist) * (1 - Math.exp(-8 * dt));
    if (Math.abs(S.chestTwist) > 1e-3) {
      if (B.spine) B.spine.rotateY(S.chestTwist * 0.35);
      if (B.chest) B.chest.rotateY(S.chestTwist * 0.4);
      if (B.head) B.head.rotateY(S.chestTwist * 0.25);
    }
  }

  // ---------------------------------------------------------------- кадр
  function resetFree() { for (const b of cur.free) b.quaternion.identity(); }
  // Микшер three.js пишет в кость, только если значение клипа изменилось с прошлого кадра
  // (PropertyMixer.apply). Поэтому наши добавки (дыхание, оглядывание, поза, сведение рук) нельзя
  // оставлять на костях: после микшера запоминаем «чистую» позу и возвращаем её перед следующим кадром.
  function saveClean() {
    const L = cur.touched || (cur.touched = Object.values(cur.bones).filter(Boolean));
    if (!cur.clean) cur.clean = L.map(() => new THREE.Quaternion());
    for (let i = 0; i < L.length; i++) cur.clean[i].copy(L[i].quaternion);
  }
  function restoreClean() {
    if (!cur.clean) return;
    const L = cur.touched;
    for (let i = 0; i < L.length; i++) L[i].quaternion.copy(cur.clean[i]);
  }

  function update(dt, snap, events) {
    if (!S.ready || !cur) return;
    time += dt;
    if (heroTimeU) heroTimeU.value = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const P = snap && snap.player;
    if (ownRoot && P && P.position) {
      root.position.set(num(P.position.x), num(P.position.y), num(P.position.z));
      root.rotation.y = num(P.yaw, root.rotation.y);
    }
    // LOD по расстоянию до камеры (configureHeroes({ camera })); setLod() вручную выключает авто
    if (S.autoLod && defaults.camera && (S.lodTick = (S.lodTick || 0) + 1) % 15 === 0) {
      root.getWorldPosition(_lodV);
      const d = _lodV.distanceTo(defaults.camera.position);
      const want = d > 55 ? 2 : d > 28 ? 1 : 0;
      if (want !== S.lod) applyLod(want);
    }
    // LOD: реже обновляем удалённого/дальнего героя; события пропущенных кадров — в очередь
    if (S.lod >= 2 && Array.isArray(events) && events.length) { S.pend = (S.pend || []).concat(events).slice(-32); }
    if (S.lod >= 2) { S.lodAcc += dt; if (S.lodAcc < 0.1) return; dt = S.lodAcc; S.lodAcc = 0; }
    restoreClean();
    resetFree();
    if (!P) { // меню: покой (или стойка витрины)
      S.yawRate = 0; S.prevYaw = null;
      if (act && !holdName && time >= actUntil) { stopAct(0.3); if (stance) setStance(stance); }
      if (cur.shade && cur.shade.setGlow) cur.shade.setGlow(1);
      if (cur.aura && cur.aura.setIntensity) cur.aura.setIntensity(1);
      if (cur.gear && cur.gear.setGlow) cur.gear.setGlow(1);
      updateLoco(dt, 0, 0, 0, false);
      cur.mixer.update(dt);
      saveClean();
      applyLife(dt, true, 0, true);
      applyPose(dt);
      applyFingers(dt, handWants());
      S.inMenu = true;
      vrmTick(dt);
      return;
    }
    S.inMenu = false;
    const status = snap.status || 'playing';
    const yaw = root.rotation.y;
    const W = cur.model;
    // смерть — по статусу боя или по action 'dead' (PvP: статус боя не меняется); воскрешение — стоп
    const dead = status === 'defeat' || P.action === 'dead' || !!P.dead;
    if (dead && !S.dead) playAct('Death', { speed: 1, fade: 0.2 });
    else if (!dead && S.dead) stopAct(0.1);
    S.dead = dead;
    if (status !== lastStatus) {
      if (status === 'victory' && !dead) playAct('Victory', { loop: true, speed: 1, fade: 0.3 });
      else if (lastStatus === 'victory') stopAct(0.1);
      lastStatus = status;
    }
    if (dead || status === 'victory') {
      W.rotation.set(0, 0, 0);
      updateLoco(dt, 0, 0, 0, false);
      cur.mixer.update(dt); saveClean(); applyFingers(dt, handWants()); vrmTick(dt); return;
    }

    // скорость в осях героя (вперёд = +z, влево = +x)
    const vx = num(P.velocity && P.velocity.x), vz = num(P.velocity && P.velocity.z);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = vx * c - vz * s, lz = vx * s + vz * c;
    const sp = Math.hypot(vx, vz);
    if (dt > 1e-4) {
      const dy = wrap(yaw - (S.prevYaw ?? yaw));
      S.yawRate += (dy / dt - S.yawRate) * (1 - Math.exp(-10 * dt));
    }
    S.prevYaw = yaw;
    const sprint = num(P.sprint) > 0.5 || !!P.cruise;
    const moving = sp > 0.6;

    // действия по событиям боя (+ события кадров, пропущенных на LOD 2)
    let want = null;
    let evList = Array.isArray(events) ? events : [];
    if (S.pend && S.pend.length) { evList = S.pend.concat(S.lod >= 2 ? [] : evList); S.pend = null; }
    for (const e of evList) {
      if (!e) continue;
      const d = e.data || {};
      if (!!d.remote !== !!remote) continue; // C3: события соперника (data.remote) — только его модели
      switch (e.type) {
        case 'player_dash': {
          const wd = d.worldDirection || P.dashDir;
          let n = 'DodgeF';
          if (wd) {
            const dl = Math.atan2(num(wd.x) * c - num(wd.z) * s, num(wd.x) * s + num(wd.z) * c);
            n = Math.abs(dl) < 0.8 ? 'DodgeF' : Math.abs(dl) > 2.35 ? 'DodgeB' : dl > 0 ? 'DodgeL' : 'DodgeR';
          }
          want = { name: n, speed: 1.5, full: true };
          break;
        }
        case 'player_hit': S.hurt = 1; S.recoil = 1; if (!want) want = { name: P.shielding ? 'BlockHit' : num(d.amount) >= 20 ? 'HitB' : 'Hit', speed: 1.4 }; break;
        case 'player_slash': want = { name: 'Slash', speed: 1.8 }; break;
        case 'burst': want = { name: 'Cast2', speed: 1.5 }; break;
        case 'rune_cast': want = { name: 'CastRaise', speed: 1.4 }; break;
        case 'parry': want = { name: 'BlockHit', speed: 1.8 }; break;
        case 'sigil_cast': want = { name: 'Cast2', speed: 1.6 }; break;
        case 'hand_spell_throw': want = { name: 'Throw', speed: 1.6 }; break;
        case 'bow_release': if (!pose.wBow) want = { name: 'BowShoot', speed: 1.4 }; break;
        case 'player_cast': if (!want) want = { name: 'Cast1', speed: d.ability === 'spark' ? 2.2 : 1.6 }; break;
        default: break;
      }
    }
    // магия откликается: касты/выброс/руны/печати — вспышка ауры и жил лат
    for (const e of evList) {
      const ty = e && e.type;
      if (ty === 'player_cast' || ty === 'burst' || ty === 'rune_cast' || ty === 'sigil_cast' || ty === 'hand_spell_throw' || ty === 'bow_release' || ty === 'parry' || ty === 'player_slash') S.flare = Math.min(1.6, (S.flare || 0) + (ty === 'burst' || ty === 'sigil_cast' || ty === 'rune_cast' ? 1.2 : 0.6));
    }
    if (want) {
      playAct(want.name, { speed: want.speed, upperOnly: !want.full && moving });
    } else {
      // удержания: щит — блок, чары — каст в цикле, стрельба — рука вперёд
      const holdKey = P.action === 'shield' ? 'shield' : P.action === 'conjure' ? 'conjure' : P.action === 'cast' ? 'cast' : P.stunned ? 'stun' : '';
      const busy = act && !holdName && time < actUntil;
      if (holdKey && !busy) {
        if (holdName !== holdKey || actUpper !== moving) {
          if (holdKey === 'shield') playAct('Blocking', { holdKey, upperOnly: moving, fade: 0.15, loop: true });
          else if (holdKey === 'conjure') playAct('CastHold', { holdKey, upperOnly: moving, fade: 0.15, loop: true });
          else if (holdKey === 'stun') playAct('HitB', { holdKey, upperOnly: false, fade: 0.2, freezeAt: 0.45 });
          else playAct('Cast1', { holdKey, upperOnly: moving, fade: 0.15, freezeAt: 0.42 });
        }
      } else if (!holdKey && holdName) stopAct(0.2);
      else if (act && !holdName && time >= actUntil) stopAct(0.25);
    }

    updateLoco(dt, lx, lz, sp, sprint);

    // обёртка: наклон на бегу и отдача от удара (поворот корпуса по ходу больше не нужен — есть стрейф)
    const leanWant = lz > 2.5 ? (sprint ? 0.12 : 0.05) : 0;
    S.lean += (leanWant - S.lean) * (1 - Math.exp(-6 * dt));
    S.recoil = Math.max(0, S.recoil - dt * 3.5);
    W.rotation.set(S.lean - 0.18 * Math.sin(Math.PI * S.recoil), 0, 0);
    cur.mixer.update(dt);
    saveClean();

    // lock-on: грудь к цели (C4 snap.lockTarget, по умолчанию — босс в бою)
    let twist = 0;
    const tgt = (snap.lockTarget && snap.lockTarget.position) || (P.encounter === 'engaged' && snap.boss && snap.boss.position) || null;
    if (tgt && P.position) {
      const dx = num(tgt.x) - num(P.position.x), dz = num(tgt.z) - num(P.position.z);
      if (dx * dx + dz * dz > 0.25) twist = clamp(wrap(Math.atan2(dx, dz) - yaw), -0.7, 0.7);
    }
    applyLife(dt, !moving && !act, twist);
    applyPose(dt);
    applyFingers(dt, handWants());
    // жилы и аура: вспышка магии, при ранении — вздрог, при низком HP — мерцание и угасание
    S.flare = Math.max(0, (S.flare || 0) - dt * 2.2);
    S.hurt = Math.max(0, (S.hurt || 0) - dt * 3);
    const hpR = P.maxHp ? clamp(num(P.hp, P.maxHp) / P.maxHp, 0, 1) : 1;
    const low = hpR < 0.3 ? (0.45 + 0.55 * Math.abs(Math.sin(time * 9 + Math.sin(time * 23) * 2))) * (0.5 + hpR) : 1;
    const glowK = (1 + 1.6 * S.flare - 0.5 * S.hurt) * low;
    if (cur.shade && cur.shade.setGlow) cur.shade.setGlow(glowK);
    if (cur.aura && cur.aura.setIntensity) cur.aura.setIntensity(clamp(0.8 + 1.5 * S.flare, 0, 3) * (hpR < 0.3 ? 0.6 : 1));
    if (cur.gear && cur.gear.setGlow) cur.gear.setGlow(glowK);
    vrmTick(dt);
  }

  // VRM: моргание раз в 2–5 с, обновление (нормализованный скелет → меш, пружины волос и одежды), ткань
  function vrmTick(dt) {
    const vrm = cur && cur.vrm;
    if (!vrm) return;
    // моргание: быстро закрыть (35%), медленнее открыть; изредка — двойное
    S.blinkT -= dt;
    if (S.blinkT <= 0) { S.blink = 0.2; S.blinkT = Math.random() < 0.15 ? 0.32 : 2 + Math.random() * 3.5; }
    const bt = S.blink > 0 ? 1 - S.blink / 0.2 : 1;
    const bw = bt < 1 ? (bt < 0.35 ? Math.sin((bt / 0.35) * Math.PI / 2) : Math.cos(((bt - 0.35) / 0.65) * Math.PI / 2) ** 2) : 0;
    S.blink = Math.max(0, S.blink - dt);
    const em = vrm.expressionManager;
    if (em) { try { em.setValue('blink', bw); } catch (e) { /* нет выражения */ } }
    if (cur.gear && cur.gear.setBlink) cur.gear.setBlink(S.lod >= 2 ? 0 : bw);   // веки-шторки героинь (heroGear)
    if (S.lod >= 2 && vrm.springBoneManager) {
      // без пружин: только скелет и выражения
      vrm.humanoid.update(); if (em) em.update();
    } else vrm.update(Math.min(dt, 1 / 20));
    if (cur.gear && cur.gear.update) cur.gear.update(dt, root, S.lod);
    if (cur.aura) cur.aura.update(heroTimeU ? heroTimeU.value : time);
    if (cur.shade && cur.shade.update) cur.shade.update(dt);
    // взгляд: на витрине глаза следят за камерой, когда герой смотрит на игрока (или при приближении)
    if (cur.shade && cur.shade.updateGaze && S.lod < 2) {
      try { cur.shade.updateGaze(S.inMenu && defaults.camera && (S.lookCam || S.gaze) ? defaults.camera.position : null, dt); } catch (e) { /* без взгляда */ }
    }
  }

  // ---------------------------------------------------------------- C5
  function setPose(p = {}) {
    if (!p || typeof p !== 'object') return;
    if ('bowDraw' in p) pose.bowDraw = clamp(num(p.bowDraw), 0, 1);
    if ('bowActive' in p) pose.bowActive = !!p.bowActive;
    if (p.aim && typeof p.aim === 'object') { pose.aimX = clamp(num(p.aim.x), -1, 1); pose.aimY = clamp(num(p.aim.y), -1, 1); }
    if ('handSpell' in p) pose.handSpell = clamp(num(p.handSpell), 0, 1);
  }
  function setMirror(m) { mirror.data = m && m.valid ? m : null; }
  function getAnchors() { return anchors; }
  // [HERO] стойка класса в меню (витрина): клип в цикле на всё тело, пока нет боя
  let stance = null;
  function setStance(name) {
    stance = name || null;
    if (!cur) return;
    if (stance && cur.full[stance]) { if (holdName !== 'stance' || actName !== stance) playAct(stance, { loop: true, fade: 0.45, holdKey: 'stance' }); }
    else if (holdName === 'stance') stopAct(0.4);
  }

  function dispose() {
    S.disposed = true;
    clear();
    showProcedural(true);
    if (ownRoot && root.parent) root.parent.remove(root);
  }

  parentAnchors();
  setHero(hero);

  return {
    root, update, setHero, setPose, setMirror, getAnchors, setShading, setQuality, setLod, setStance, dispose,
    menuStance: (id) => (HEROES[id] && HEROES[id].menuStance) || null,
    menuPose: (id) => (HEROES[id] && HEROES[id].menuPose) || null,
    heroFx: (id) => (HEROES[id] && HEROES[id].fx) || null,
    // жест «выхода» в меню: клип один раз на всё тело, затем снова стойка
    setGaze(k) { const g = k > 0.5 ? 1 : 0; if (g !== (S.gaze || 0)) { S.gaze = g; if (g) S.lookT = 0; } },
        flourish(name = 'CastRaise') { if (cur && cur.full[name]) playAct(name, { speed: 1.1, fade: 0.2 }); },
    get ready() { return S.ready; },
    get hero() { return S.hero; },
    get vrm() { return cur ? cur.vrm : null; },
    get gear() { return cur ? cur.gear : null; },   // QA
    get shade() { return cur ? cur.shade : null; },   // QA
    get mixer() { return cur ? cur.mixer : null; },
    state: () => {
      let loco = 'Idle', wMax = -1;
      for (const n of LOCO) if (S.wLoco[n] > wMax) { wMax = S.wLoco[n]; loco = n; }
      return {
        hero: S.hero, ready: S.ready, loco, locoW: Object.fromEntries(LOCO.map((n) => [n, +S.wLoco[n].toFixed(2)])), phase: +S.phase.toFixed(3),
        act: actName, actW: act ? +act.getEffectiveWeight().toFixed(2) : 0, actRun: act ? act.isRunning() : false, upper: actUpper, hold: holdName, clips: cur ? Object.keys(cur.full).length : 0,
        shading: opts.shading, lod: S.lod, pose: { bow: +pose.wBow.toFixed(2), spell: +pose.wSpell.toFixed(2), mirror: +mirror.w.toFixed(2) },
        gear: cur && cur.gear ? cur.gear.names || [] : [],
        gearMs: cur && cur.gear && cur.gear.perf ? { cloth: +cur.gear.perf.cloth.toFixed(3), hair: +cur.gear.perf.hair.toFixed(3) } : null,
      };
    },
  };
}
