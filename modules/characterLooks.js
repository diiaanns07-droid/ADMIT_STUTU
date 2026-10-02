// ASHEN OATH — внешность персонажей на моделях Quaternius (assets/quaternius, CC0).
// У «Animated Human» и «Animated Woman» один скелет (Mixamo: Hips, Spine…, Head, LeftHand…)
// и одна раскладка UV на палитру 32×32 из шести горизонтальных полос:
//   кожа, глаза/тёмное, волосы, верх одежды, штаны, обувь.
// Поэтому внешность = своя палитра + навесные детали на кости (уши эльфа, обруч, наплечники, плащ).
// Внимание: позы покоя и длины костей у двух моделей разные — клипы одной модели на другой
// напрямую НЕ играются (голова уходит под ноги). Для VRM-героев перенос — modules/vrmKit.js.
//
// export: LOOKS, makePalette(THREE, look), applyLook(THREE, root, lookId, opts), clipMap(animations)

// Полосы палитры сверху вниз и их высота в пикселях (из текстуры Woman: 6+5+6+6+5+4 = 32).
const BANDS = [['skin', 6], ['dark', 5], ['hair', 6], ['top', 6], ['pants', 5], ['shoes', 4]];

export const LOOKS = Object.freeze({
  // Эльфийка-чародейка (герой): светлая кожа, серебряные волосы, изумрудно-белое платье
  elfHero: { skin: '#f1d9c4', dark: '#1d2a26', hair: '#ece6d2', top: '#1f8a64', pants: '#e8e1cf', shoes: '#6d4a2c', ears: true, circlet: '#ffd88a', cape: '#0f5a44', glow: '#7dffcf', weapon: 'wand', belt: '#c9a45c' },
  // Воин: смуглая кожа, тёмные волосы, стальной доспех, кожаные штаны, чёрные сапоги
  warrior: { skin: '#c89877', dark: '#18181a', hair: '#2b1f17', top: '#59606c', pants: '#3b2c22', shoes: '#141414', pauldrons: '#8a8f99', cape: '#5a1d1d', weapon: 'sword', boots: '#1d1714', belt: '#4a3222' },
  // Жители эльфийской деревни (NPC): разные цвета одежды
  elfA: { skin: '#f3dcc7', dark: '#1d2a26', hair: '#f4e7b8', top: '#2fa37a', pants: '#f2ecde', shoes: '#7a5534', ears: true, circlet: '#ffe3a1' },
  elfB: { skin: '#eed3bd', dark: '#1d2a26', hair: '#d9d4c8', top: '#e9dfb8', pants: '#3d7a5c', shoes: '#5c4430', ears: true },
  elfC: { skin: '#f6e1cf', dark: '#1d2a26', hair: '#b86b3c', top: '#4bb3a0', pants: '#285e4d', shoes: '#5c4430', ears: true, cape: '#e8d9a6' },
  elfD: { skin: '#e9cdb4', dark: '#1d2a26', hair: '#f7f0dc', top: '#8fd18a', pants: '#e6dcc4', shoes: '#6a4a2e', ears: true, circlet: '#c9f5ff' },
});

const paletteCache = new Map();

// Палитра 32×32 как CanvasTexture (sRGB, без фильтрации — чёткие полосы).
export function makePalette(THREE, look) {
  const key = JSON.stringify(look);
  if (paletteCache.has(key)) return paletteCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 32;
  const g = cv.getContext('2d');
  let y = 0;
  for (const [name, h] of BANDS) {
    g.fillStyle = look[name] || '#808080';
    g.fillRect(0, y, 32, h);
    y += h;
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false; // как у текстур glTF
  paletteCache.set(key, tex);
  return tex;
}

function findBone(root, name) {
  let out = null;
  root.traverse((o) => { if (!out && o.isBone && o.name === name) out = o; });
  return out;
}

// Навесные детали крепятся к костям в их локальных осях. Модели Quaternius в сантиметровом
// масштабе (рост ~5 ед. до масштабирования), поэтому размеры задаём от роста модели.
export function applyLook(THREE, root, lookId, { height = 5.2 } = {}) {
  const look = typeof lookId === 'string' ? LOOKS[lookId] : lookId;
  if (!look) return root;
  const pal = makePalette(THREE, look);
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    const m = new THREE.MeshStandardMaterial({ map: pal, roughness: 0.82, metalness: 0.05 });
    if (src && src.side !== undefined) m.side = src.side;
    o.material = m;
    o.castShadow = true; o.receiveShadow = true;
  });
  root.updateMatrixWorld(true);
  const head = findBone(root, 'Head'), top = findBone(root, 'HeadTop_End');
  // Масштаб деталей — от реальной высоты головы (Head → HeadTop_End), в локальных единицах кости.
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const headH = head && top ? wp(head).distanceTo(wp(top)) : height * 0.09;
  const local = (b) => { const v = new THREE.Vector3(); b.getWorldScale(v); return 1 / Math.max(1e-9, v.x); };
  if (head) {
    const inv = local(head);
    const k = (v) => v * headH * inv; // v — доли высоты головы
    if (look.ears) {
      // острые уши: узкий конус из середины головы вбок-назад-вверх
      const earMat = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.7 });
      const earGeo = new THREE.ConeGeometry(k(0.09), k(0.55), 4);
      earGeo.translate(0, k(0.27), 0); // основание конуса — в точке крепления
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(earGeo, earMat);
        ear.position.set(side * k(0.36), k(0.42), k(-0.04));
        ear.rotation.set(-0.55, 0, -side * 1.2);
        ear.castShadow = true;
        ear.name = 'elf-ear';
        head.add(ear);
      }
    }
    if (look.circlet) {
      // тонкий светящийся обруч по лбу и камень над переносицей
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(k(0.42), k(0.028), 6, 28),
        new THREE.MeshStandardMaterial({ color: look.circlet, emissive: look.circlet, emissiveIntensity: 1.4, metalness: 0.3, roughness: 0.35 }),
      );
      ring.position.set(0, k(0.62), k(0.04));
      ring.rotation.x = Math.PI / 2 - 0.25;
      ring.scale.set(1, 1.08, 1);
      ring.name = 'circlet';
      head.add(ring);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(k(0.07)), new THREE.MeshBasicMaterial({ color: look.glow || look.circlet }));
      gem.position.set(0, k(0.6), k(0.46));
      gem.name = 'circlet-gem';
      head.add(gem);
    }
  }
  if (look.pauldrons) {
    for (const bn of ['LeftArm', 'RightArm']) {
      const b = findBone(root, bn);
      if (!b) continue;
      const inv = local(b);
      const k = (v) => v * headH * inv;
      const pad = new THREE.Mesh(
        new THREE.SphereGeometry(k(0.38), 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: look.pauldrons, metalness: 0.45, roughness: 0.4 }),
      );
      pad.position.set(0, k(0.05), 0);
      pad.rotation.z = 0;
      pad.scale.set(1.1, 0.75, 1.1);
      pad.castShadow = true;
      pad.name = 'pauldron';
      b.add(pad);
    }
  }
  if (look.cape) {
    // плащ на спине: свисает от лопаток, слегка отходит от спины книзу
    const sp = findBone(root, 'Spine2');
    if (sp) {
      const inv = local(sp);
      const k = (v) => v * headH * inv;
      const w = k(1.35), h = k(3.4);
      const geo = new THREE.PlaneGeometry(w, h, 1, 8);
      geo.translate(0, -h / 2, 0);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) { const t = -p.getY(i) / h; p.setZ(i, -k(0.1) - t * t * k(0.5)); p.setX(i, p.getX(i) * (0.8 + 0.35 * t)); }
      geo.computeVertexNormals();
      const cape = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: look.cape, roughness: 0.92, side: THREE.DoubleSide }));
      cape.position.set(0, k(0.55), -k(0.42));
      cape.castShadow = true;
      cape.name = 'cape';
      sp.add(cape);
    }
  }
  // оружие в правой руке: меч воина / жезл эльфийки со светящимся кристаллом
  if (look.weapon) {
    const hand = findBone(root, 'RightHand');
    if (hand) {
      const inv = local(hand);
      const k = (v) => v * headH * inv;
      const grp = new THREE.Group();
      grp.name = `weapon-${look.weapon}`;
      const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, metalness: 0.6, roughness: 0.3 });
      const leather = new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.9 });
      const gold = new THREE.MeshStandardMaterial({ color: 0xc9a45c, metalness: 0.7, roughness: 0.35 });
      if (look.weapon === 'sword') {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(k(0.14), k(3.1), k(0.035)), steel);
        blade.position.y = k(1.95);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(k(0.1), k(0.35), 4), steel);
        tip.position.y = k(3.67); tip.rotation.y = Math.PI / 4; tip.scale.z = 0.35;
        const guard = new THREE.Mesh(new THREE.BoxGeometry(k(0.75), k(0.1), k(0.14)), gold);
        guard.position.y = k(0.38);
        const grip = new THREE.Mesh(new THREE.CylinderGeometry(k(0.055), k(0.055), k(0.62), 6), leather);
        grip.position.y = k(0.03);
        const pommel = new THREE.Mesh(new THREE.SphereGeometry(k(0.09), 8, 6), gold);
        pommel.position.y = k(-0.3);
        grp.add(blade, tip, guard, grip, pommel);
      } else {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(k(0.045), k(0.06), k(2.2), 6), new THREE.MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.5 }));
        shaft.position.y = k(0.7);
        const cage = new THREE.Mesh(new THREE.TorusGeometry(k(0.16), k(0.025), 5, 16), gold);
        cage.position.y = k(1.9); cage.rotation.x = Math.PI / 2;
        const glow = look.glow || '#7dffcf';
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(k(0.2)), new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 2.2, roughness: 0.2 }));
        crystal.position.y = k(2.05); crystal.scale.y = 1.6;
        crystal.name = 'wand-crystal';
        grp.add(shaft, cage, crystal);
      }
      // рукоять — в кулаке: у кости кисти Mixamo +y идёт вдоль пальцев, +x — «вперёд» из кулака.
      // Оружие смотрит вперёд и на ~25° вверх (подобрано на стенде dev/models-check.html).
      grp.position.set(0, k(0.42), 0);
      grp.rotation.set(0, 0, -(Math.PI / 2 + 0.45));
      grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      hand.add(grp);
    }
  }
  // сапоги: короткие голенища на голенях (у модели Human босые стопы)
  if (look.boots) {
    for (const bn of ['LeftFoot', 'RightFoot']) {
      const b = findBone(root, bn);
      if (!b) continue;
      const inv = local(b);
      const k = (v) => v * headH * inv;
      const boot = new THREE.Mesh(new THREE.CylinderGeometry(k(0.2), k(0.22), k(0.7), 8, 1, true), new THREE.MeshStandardMaterial({ color: look.boots, roughness: 0.85, side: THREE.DoubleSide }));
      boot.position.y = k(0.18);
      boot.castShadow = true;
      boot.name = 'boot';
      b.add(boot);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(k(0.36), k(0.2), k(0.75)), new THREE.MeshStandardMaterial({ color: look.boots, roughness: 0.85 }));
      foot.position.set(0, k(-0.08), k(0.22));
      foot.castShadow = true;
      b.add(foot);
    }
  }
  // пояс на талии
  if (look.belt) {
    const sp = findBone(root, 'Spine');
    if (sp) {
      const inv = local(sp);
      const k = (v) => v * headH * inv;
      const belt = new THREE.Mesh(new THREE.TorusGeometry(k(0.62), k(0.07), 5, 20), new THREE.MeshStandardMaterial({ color: look.belt, roughness: 0.6, metalness: 0.3 }));
      belt.rotation.x = Math.PI / 2; belt.scale.set(1, 0.72, 1);
      belt.position.set(0, k(-0.1), 0);
      belt.name = 'belt';
      sp.add(belt);
    }
  }
  return root;
}

// Имена клипов без префикса «Armature|…» → { Idle, Walk, Run, Punch, Death, Jump, … }.
// Нормализуем синонимы двух моделей (Walk/Walking, Run/Running).
export function clipMap(animations) {
  const out = {};
  for (const c of animations || []) {
    const n = c.name.split('|').pop();
    out[n] = c;
  }
  if (!out.Walk && out.Walking) out.Walk = out.Walking;
  if (!out.Run && out.Running) out.Run = out.Running;
  return out;
}

// [W4-ЛИЦО] Лица героинь. Все три — одна модель Quaternius Ranger (assets/heroes/ranger.glb), поэтому
// лицо задаётся описанием: брови (отдельная лента с волосками поверх кожи вместо толстых «плашек» модели),
// глаза (масштаб области глаза и радужки, тени век по стихии, подводка), кожа (румянец, веснушки,
// подповерхностный оттенок), губы и мягкая правка пропорций (челюсть, подбородок, нос — вершины в позе
// привязки: морфов и костей лица у модели нет). Применяет heroShading.beautifyFace (из heroModel.setHero).
// Координаты бровей — метры позы привязки модели: x — к левому виску героини, y — вверх (глаза на y ≈ 1.656,
// внутренний угол глаза x ≈ 0.020, внешний ≈ 0.049). Брови симметричны (правая — зеркало по x).
//   brow: { color, inner:[x,y], peak:[x,y], tail:[x,y], w:[головка, излом, хвост] (м), peakT — где излом
//           по длине (0…1), soft — мягкость головки (градиент «омбре»), hair — заметность волосков, seed }
//   eyes: { scale — область глаза (яблоко, веки, ресницы), iris — радужка внутри глаза, shadow/shadowA — тени
//           век, shadow2 — второй тон к внешнему углу, liner/linerW — цвет и толщина подводки у внешнего угла (м),
//           wing/wingUp — длина «стрелки» (м) и её подъём (рад), lower — дымка по нижнему веку }
//   skin: { blush/blushA, freckles/frecklesA, glow — тёплый подповерхностный оттенок (0…1), contour — лёгкий
//           контур скул, носа и челюсти (0…1), conceal — высветлить запечённые тени вокруг глаз (0…1) }
//   lips: { color, a — насыщенность, gloss — влажный блеск (0…1), tint — тон к центру нижней губы }
//   shape: { jaw — уже линия челюсти (0…1), chin — мягче и изящнее подбородок, nose — уже крылья и кончик носа,
//            cheek — чуть выше и мягче скулы }
export const FACE_LOOKS = Object.freeze({
  // Эльфийка (Гроза): светлые тонкие брови высокой дугой, серебристо-голубые тени, нежные розовые губы
  elf: {
    brow: { color: 0x7a6447, inner: [0.0135, 1.6738], peak: [0.0425, 1.6838], tail: [0.0608, 1.6772], w: [0.0040, 0.0034, 0.0009], peakT: 0.64, soft: 0.75, hair: 0.75, seed: 3 },
    eyes: { scale: 1.07, iris: 1.08, shadow: 0x7f9fd6, shadowA: 0.42, shadow2: 0xb6c8ee, liner: 0x3b2c24, linerW: 0.0006, wing: 0.0016, wingUp: 0.32, lower: 0.18 },
    skin: { blush: 0xf2959a, blushA: 0.2, glow: 0.8, contour: 0.55, conceal: 0.85 },
    lips: { color: 0xd8828c, a: 0.62, gloss: 0.75, tint: 0xf0a0a8 },
    shape: { jaw: 0.85, chin: 0.8, nose: 0.85, cheek: 0.5 },
  },
  // Тёмная чародейка (Тьма и лёд): тёмные выразительные брови с чётким изломом, фиолетовые тени, стрелка
  dark: {
    brow: { color: 0x1d1424, inner: [0.0128, 1.6732], peak: [0.0435, 1.6848], tail: [0.0625, 1.6772], w: [0.0043, 0.0036, 0.0009], peakT: 0.66, soft: 0.55, hair: 0.6, seed: 7 },
    eyes: { scale: 1.07, iris: 1.08, shadow: 0x6a3f9a, shadowA: 0.55, shadow2: 0x3a2050, liner: 0x0b0610, linerW: 0.00095, wing: 0.0058, wingUp: 0.42, lower: 0.3 },
    skin: { blush: 0xc98aa6, blushA: 0.1, glow: 0.6, contour: 0.7, conceal: 0.7 },
    lips: { color: 0x8a3058, a: 0.78, gloss: 0.85, tint: 0xb04a78 },
    shape: { jaw: 0.9, chin: 0.85, nose: 0.8, cheek: 0.6 },
  },
  // Лучница (Ветер): естественные мягкие брови, зелёно-золотые тени, свежий румянец, едва заметные веснушки
  ranger: {
    brow: { color: 0x5b3b27, inner: [0.0132, 1.6735], peak: [0.0420, 1.6822], tail: [0.0610, 1.6768], w: [0.0047, 0.0039, 0.0011], peakT: 0.6, soft: 0.85, hair: 0.95, seed: 11 },
    eyes: { scale: 1.06, iris: 1.07, shadow: 0x8f9a52, shadowA: 0.36, shadow2: 0xc9a85a, liner: 0x2a1a12, linerW: 0.00055, wing: 0.0011, wingUp: 0.25, lower: 0.15 },
    skin: { blush: 0xee9480, blushA: 0.22, freckles: 0xa86a4a, frecklesA: 0.5, glow: 0.85, contour: 0.45, conceal: 0.8 },
    lips: { color: 0xc8766c, a: 0.5, gloss: 0.6, tint: 0xe39a8c },
    shape: { jaw: 0.75, chin: 0.7, nose: 0.75, cheek: 0.45 },
  },
});
export function faceLookOf(id) { return FACE_LOOKS[id] || null; }
