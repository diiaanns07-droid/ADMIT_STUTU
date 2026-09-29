// ASHEN OATH — герой на скиннинговой модели (KayKit Adventurers «Mage», CC0, assets/kaykit).
// Модель вешается на heroRoot мира (позиция и поворот — как у процедурного героя), процедурное
// тело прячется, только когда модель загрузилась. Не загрузилась — остаётся процедурный герой.
//
// Анимации — из самого .glb (76 клипов). Нижний слой — передвижение по скорости в осях героя
// (стоим / шаг / бег / назад / стрейф); верхний — действие из снимка боя (player.action) и событий
// (каст, рассечение, выброс, руна, парирование, удар, рывок). Пока герой идёт, действие играет
// только на корпусе и руках (дорожки ног вырезаны), чтобы ноги не скользили.
//
// createHeroModel({ THREE, heroRoot, heroBody, url, height }) → { update(dt, snap, events), get ready, dispose() }

const LEG_BONES = /^(root|hips|upperleg|lowerleg|foot|toes|kneeIK|heelIK|IK-|control-)/;

// Клипы одиночных действий: имя в .glb, скорость, «держать» ли последний кадр.
const ONE_SHOT = {
  spark: { clip: 'Spellcast_Shoot', speed: 1.8 },
  cast: { clip: 'Spellcast_Shoot', speed: 1.3 },
  throw: { clip: 'Spellcast_Long', speed: 1.4 },
  slash: { clip: '1H_Melee_Attack_Slice_Horizontal', speed: 1.5 },
  burst: { clip: 'Spellcast_Raise', speed: 1.4 },
  rune: { clip: 'Spellcast_Long', speed: 1.6 },
  sigil: { clip: 'Spellcast_Raise', speed: 1.5 },
  parry: { clip: 'Block_Attack', speed: 1.6 },
  hit: { clip: 'Hit_A', speed: 1.3 },
};
// Удержания (пока действие в снимке): щит, чары двумя руками, огонь «OK».
const HOLD = { shield: 'Blocking', conjure: 'Spellcasting', firing: 'Spellcasting' };
const DODGE = { f: 'Dodge_Forward', b: 'Dodge_Backward', l: 'Dodge_Left', r: 'Dodge_Right' };

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createHeroModel({ THREE, heroRoot, heroBody, extras = [], url, height = 1.8 } = {}) {
  const S = { ready: false, failed: false, disposed: false };
  let model = null, mixer = null;
  const full = {}, upper = {};          // имя клипа → AnimationAction (всё тело / только верх)
  let loco = null, locoName = '';       // текущий клип передвижения
  let act = null, actName = '', actUntil = 0, actUpper = false, holdName = '';
  let time = 0, lastStatus = '';
  const yawV = new THREE.Vector3();

  (async () => {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(url);
      if (S.disposed) return;
      model = gltf.scene;
      model.name = 'hero-model';
      // лишний реквизит: книга и посох — прячем, жезл в правой руке оставляем (руки колдуют)
      model.traverse((o) => {
        if (/^(Spellbook|Spellbook_open|2H_Staff)$/.test(o.name)) o.visible = false;
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          o.frustumCulled = false; // скиннинг: рамка модели не следует за позой
          const m = o.material;
          if (m && m.isMeshStandardMaterial) {
            // мир тёмный и туманный: приглушить мультяшную палитру, добавить металла и шероховатости
            m.color.multiplyScalar(0.9);
            m.roughness = Math.max(m.roughness ?? 0.8, 0.75);
            m.envMapIntensity = 0.8;
          }
        }
      });
      // масштаб по росту
      const box = new THREE.Box3().setFromObject(model);
      const h = Math.max(1e-3, box.max.y - box.min.y);
      const k = height / h;
      model.scale.setScalar(k);
      model.position.y = -box.min.y * k;
      mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) {
        full[clip.name] = mixer.clipAction(clip);
        const up = clip.clone();
        up.name = clip.name + '#upper';
        up.tracks = up.tracks.filter((tr) => !LEG_BONES.test(tr.name.split('.')[0]));
        upper[clip.name] = mixer.clipAction(up);
      }
      heroRoot.add(model);
      if (heroBody) heroBody.visible = false;
      for (const o of extras) if (o) o.visible = false; // процедурный плащ с руной висит прямо на heroRoot
      setLoco('Idle', 0);
      S.ready = true;
    } catch (e) {
      S.failed = true;
      console.warn('[ASHEN] модель героя не загрузилась — процедурный герой:', e && e.message);
    }
  })();

  function setLoco(name, fade = 0.2) {
    if (name === locoName || !full[name]) return;
    const next = full[name];
    next.reset().setEffectiveWeight(1).play();
    if (loco) next.crossFadeFrom(loco, fade, false);
    loco = next; locoName = name;
  }

  function stopAct(fade = 0.2) {
    if (act) act.fadeOut(fade);
    act = null; actName = ''; holdName = '';
  }

  function playAct(name, { speed = 1, hold = false, upperOnly = false, fade = 0.12, loop = false } = {}) {
    const pool = upperOnly ? upper : full;
    const a = pool[name];
    if (!a) return;
    if (act && act !== a) act.fadeOut(fade);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.setEffectiveWeight(1).fadeIn(fade).play();
    act = a; actName = name; actUpper = upperOnly;
    actUntil = loop ? Infinity : time + a.getClip().duration / speed - 0.12;
    holdName = hold ? name : '';
  }

  // Направление рывка в осях героя → клип уклонения.
  function dodgeClip(d, yaw) {
    if (!d) return DODGE.f;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = d.x * c - d.z * s, lz = d.x * s + d.z * c;
    if (Math.abs(lz) >= Math.abs(lx)) return lz >= 0 ? DODGE.f : DODGE.b;
    return lx >= 0 ? DODGE.l : DODGE.r;
  }

  function update(dt, snap, events) {
    if (!S.ready || !snap || !snap.player) return;
    time += dt;
    const P = snap.player;
    const status = snap.status || 'playing';
    const yaw = heroRoot.rotation.y;
    // финал боя
    if (status !== lastStatus) {
      if (status === 'defeat' || P.action === 'dead') playAct('Death_A', { speed: 1, fade: 0.2 });
      else if (status === 'victory') playAct('Cheer', { loop: true, fade: 0.3 });
      else if (lastStatus === 'defeat' || lastStatus === 'victory') stopAct(0.1);
      lastStatus = status;
    }
    if (status === 'defeat' || status === 'victory') { mixer.update(dt); return; }

    // передвижение в осях героя (вперёд = +z модели)
    const vx = num(P.velocity && P.velocity.x), vz = num(P.velocity && P.velocity.z);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = vx * c - vz * s, lz = vx * s + vz * c;
    const sp = Math.hypot(vx, vz);
    let lname = 'Idle', rate = 1;
    if (sp > 0.35) {
      if (lz < -0.5 && Math.abs(lz) > Math.abs(lx)) { lname = 'Walking_Backwards'; rate = sp / 2.2; }
      else if (Math.abs(lx) > Math.abs(lz) * 1.3 && sp > 2.2) { lname = lx > 0 ? 'Running_Strafe_Left' : 'Running_Strafe_Right'; rate = sp / 4.5; }
      else if (sp < 3.0) { lname = 'Walking_A'; rate = sp / 1.9; }
      else { lname = 'Running_A'; rate = sp / 5.0; }
    }
    setLoco(lname);
    if (loco) loco.timeScale = Math.min(1.8, Math.max(0.6, rate));
    const moving = sp > 0.6;

    // одиночные действия по событиям
    let want = null;
    for (const e of Array.isArray(events) ? events : []) {
      if (!e) continue;
      const d = e.data || {};
      switch (e.type) {
        case 'player_dash': want = { name: dodgeClip(P.dashDir || d.dir, yaw), speed: 1.6, full: true }; break;
        case 'player_hit': if (!want) want = { ...ONE_SHOT.hit }; break;
        case 'player_slash': want = { ...ONE_SHOT.slash }; break;
        case 'burst': want = { ...ONE_SHOT.burst }; break;
        case 'rune_cast': want = { ...ONE_SHOT.rune }; break;
        case 'parry': want = { ...ONE_SHOT.parry }; break;
        case 'sigil_cast': want = { ...ONE_SHOT.sigil }; break;
        case 'player_cast':
          if (!want) want = { ...(d.ability === 'throw' ? ONE_SHOT.throw : d.ability === 'spark' ? ONE_SHOT.spark : ONE_SHOT.cast) };
          break;
        default: break;
      }
    }
    if (want) {
      const name = want.name || want.clip;
      playAct(name, { speed: want.speed, upperOnly: !want.full && moving });
    } else {
      // удержания из снимка: щит, чары, стрельба «OK»
      const holdKey = P.action === 'shield' ? 'shield' : P.action === 'conjure' ? 'conjure' : (P.action === 'cast' && P.firing !== false) ? 'firing' : null;
      const hname = holdKey ? HOLD[holdKey] : '';
      const oneShotBusy = act && !holdName && time < actUntil;
      if (hname && !oneShotBusy) {
        if (holdName !== hname || actUpper !== moving) playAct(hname, { loop: true, hold: true, upperOnly: moving, fade: 0.15 });
      } else if (!hname && holdName) stopAct(0.2);
      else if (act && !holdName && time >= actUntil) stopAct(0.25);
    }
    mixer.update(dt);
  }

  function dispose() {
    S.disposed = true;
    if (mixer) mixer.stopAllAction();
    if (model && model.parent) model.parent.remove(model);
    if (heroBody) heroBody.visible = true;
    for (const o of extras) if (o) o.visible = true;
  }

  return {
    update, dispose,
    get ready() { return S.ready; },
    get failed() { return S.failed; },
    state: () => ({ ready: S.ready, loco: locoName, locoRate: loco ? +loco.timeScale.toFixed(2) : 0, act: actName, upper: actUpper, hold: holdName }),
  };
}
