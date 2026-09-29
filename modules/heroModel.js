// ASHEN OATH — выбираемый герой (settings.hero):
//   'ashen' — Пепельный страж: процедурный герой мира (world.js), модель не грузится;
//   'elf'   — Эльфийка: VRoid AvatarSample_F (assets/vroid/elf.vrm, CC0);
//   'dark'  — Тёмная чародейка: VRoid Darkness (assets/vroid/dark.vrm, CC0).
// VRM грузится через modules/vrmKit.js; анимации — клипы Quaternius (assets/quaternius/*.glb, CC0,
// скелет Mixamo), перенесённые на VRM по направлениям костей. vrm.update(dt) каждый кадр:
// физика волос и одежды (spring bones), моргание. Модель вешается на heroRoot мира (позиция и
// поворот — из боя), процедурное тело прячется. Не загрузилась — остаётся процедурный герой.
//
// Нижний слой — передвижение: стоим / шаг / бег (скорость клипа по скорости героя); вбок корпус
// доворачивается в сторону хода, назад — шаг с обратным временем. Верхний слой — действия:
// каст/удар — «Punch», щит и чары — поза «Punch» на пике, рывок — «Jump», смерть — «Death».
// Пока герой идёт, действия играют только на корпусе и руках (дорожки ног вырезаны).
//
// createHeroModel({ THREE, heroRoot, heroBody, extras, hero, baseUrl, vrmUrl })
//   → { update(dt, snap, events), setHero(id), get ready, get hero, state(), dispose() }

import { loadVRM, retargetClip } from './vrmKit.js';

export const HEROES = Object.freeze({
  ashen: { id: 'ashen', name: 'Пепельный страж', vrm: null },
  elf: { id: 'elf', name: 'Эльфийка', vrm: 'elf.vrm', height: 1.72 },
  dark: { id: 'dark', name: 'Тёмная чародейка', vrm: 'dark.vrm', height: 1.7 },
});
// клипы Quaternius: [имя в игре, файл, имя клипа в файле]
const CLIPS = [
  ['Idle', 'woman.glb', 'Idle'], ['Walk', 'woman.glb', 'Walking'], ['Run', 'woman.glb', 'Running'],
  ['Punch', 'woman.glb', 'Punch'], ['Death', 'woman.glb', 'Death'], ['Jump', 'woman.glb', 'Jump'],
];
const LEG_VRM = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createHeroModel({ THREE, heroRoot, heroBody, extras = [], hero = 'ashen', baseUrl = './assets/quaternius/', vrmUrl = './assets/vroid/' } = {}) {
  const S = { ready: false, disposed: false, hero: 'ashen', token: 0, lean: 0, turn: 0, recoil: 0, prevYaw: null, yawRate: 0, blinkT: 2, blink: 0 };
  let loaderP = null;
  const cache = new Map(); // url → Promise<gltf>
  let cur = null;          // { model, vrm, mixer, full, upper }
  let loco = null, locoName = '';
  let act = null, actName = '', actUntil = 0, actUpper = false, holdName = '';
  let time = 0, lastStatus = '';

  function loadGltf(file) {
    const url = new URL(file, new URL(baseUrl, document.baseURI)).href;
    if (!cache.has(url)) {
      if (!loaderP) loaderP = import('three/addons/loaders/GLTFLoader.js').then((m) => new m.GLTFLoader());
      cache.set(url, loaderP.then((l) => l.loadAsync(url)));
    }
    return cache.get(url);
  }

  function showProcedural(on) {
    if (heroBody) heroBody.visible = on;
    for (const o of extras) if (o) o.visible = on;
  }

  function clear() {
    const curScene = cur && cur.vrm ? cur.vrm.scene : null;
    if (curScene) import('@pixiv/three-vrm').then((V) => { try { V.VRMUtils.deepDispose(curScene); } catch (e) { /* ignore */ } }).catch(() => {});
    if (cur) {
      cur.mixer.stopAllAction();
      if (cur.model.parent) cur.model.parent.remove(cur.model);
    }
    cur = null; loco = null; locoName = ''; act = null; actName = ''; holdName = ''; lastStatus = '';
    S.ready = false;
  }

  async function setHero(id) {
    const def = HEROES[id] || HEROES.ashen;
    if (def.id === S.hero && (S.ready || !def.vrm)) return;
    const token = ++S.token;
    S.hero = def.id;
    clear();
    if (!def.vrm) { showProcedural(true); return; }
    try {
      const { clone } = await import('three/addons/utils/SkeletonUtils.js');
      const files = [...new Set(CLIPS.map((c) => c[1]))];
      const [vrm, ...srcs] = await Promise.all([
        loadVRM(THREE, new URL(def.vrm, new URL(vrmUrl, document.baseURI)).href),
        ...files.map((f) => loadGltf(f)),
      ]);
      if (S.disposed || token !== S.token) return;
      const src = Object.fromEntries(files.map((f, i) => [f, srcs[i]]));
      // рост: VRoid ~1.5–1.6 м — подгоняем под героя
      vrm.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(vrm.scene);
      const h = Math.max(1e-3, box.max.y - box.min.y);
      const k = (def.height || 1.7) / h;
      const wrap = new THREE.Group(); // поворот «корпус по ходу», наклон и масштаб — на обёртке
      wrap.name = 'hero-model';
      wrap.scale.setScalar(k);
      vrm.scene.position.y = -box.min.y;
      wrap.add(vrm.scene);
      const mixer = new THREE.AnimationMixer(vrm.scene);
      const legNames = new Set(LEG_VRM.map((b) => { const n = vrm.humanoid.getNormalizedBoneNode(b); return n && n.name; }).filter(Boolean));
      const full = {}, upper = {};
      for (const [name, file, clipName] of CLIPS) {
        const g = src[file];
        const c = g && g.animations.find((a) => a.name.split('|').pop() === clipName);
        if (!c) continue;
        const clip = retargetClip(THREE, c, clone(g.scene), vrm);
        clip.name = name;
        full[name] = mixer.clipAction(clip);
        const up = clip.clone();
        up.name = `${name}#upper`;
        up.tracks = up.tracks.filter((tr) => !legNames.has(tr.name.split('.')[0]));
        upper[name] = mixer.clipAction(up);
      }
      if (vrm.humanoid.resetNormalizedPose) vrm.humanoid.resetNormalizedPose();
      heroRoot.add(wrap);
      showProcedural(false);
      cur = { model: wrap, vrm, mixer, full, upper };
      setLoco('Idle', 0);
      S.ready = true;
    } catch (e) {
      console.warn('[ASHEN] модель героя не загрузилась — процедурный герой:', e && e.message);
      if (token === S.token) { S.hero = 'ashen'; showProcedural(true); }
    }
  }

  function setLoco(name, fade = 0.2) {
    if (!cur || name === locoName || !cur.full[name]) return;
    const next = cur.full[name];
    next.reset().setEffectiveWeight(1).play();
    if (loco) next.crossFadeFrom(loco, fade, false);
    loco = next; locoName = name;
  }
  function stopAct(fade = 0.2) {
    if (act) act.fadeOut(fade);
    act = null; actName = ''; holdName = '';
  }
  // opts: speed, upperOnly, loop, hold (поза: остановиться на доле клипа freezeAt)
  function playAct(name, { speed = 1, upperOnly = false, fade = 0.1, loop = false, holdKey = '', freezeAt = null } = {}) {
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
    actUntil = loop || freezeAt !== null ? Infinity : time + dur / Math.max(0.01, speed) - 0.08;
  }

  function update(dt, snap, events) {
    if (!S.ready || !cur) return;
    if (!snap || !snap.player) { time += dt; cur.mixer.update(dt); vrmTick(dt); return; } // меню: стоим в покое
    time += dt;
    const P = snap.player;
    const status = snap.status || 'playing';
    const yaw = heroRoot.rotation.y;
    const W = cur.model;
    if (status !== lastStatus) {
      if (status === 'defeat' || P.action === 'dead') playAct('Death', { speed: 1, fade: 0.2 });
      else if (status === 'victory') playAct('Jump', { loop: true, speed: 0.9, fade: 0.3 });
      else if (lastStatus === 'defeat' || lastStatus === 'victory') stopAct(0.1);
      lastStatus = status;
    }
    if (status === 'defeat' || status === 'victory') { W.rotation.set(0, 0, 0); cur.mixer.update(dt); vrmTick(dt); return; }

    // скорость в осях героя (вперёд = +z)
    const vx = num(P.velocity && P.velocity.x), vz = num(P.velocity && P.velocity.z);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const lx = vx * c - vz * s, lz = vx * s + vz * c;
    const sp = Math.hypot(vx, vz);
    if (dt > 1e-4) {
      let dy = yaw - (S.prevYaw ?? yaw);
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      S.yawRate += (dy / dt - S.yawRate) * (1 - Math.exp(-10 * dt));
    }
    S.prevYaw = yaw;
    const sprint = num(P.sprint) > 0.5 || !!P.cruise;
    let lname = 'Idle', rate = 1, turnWant = 0;
    if (sp > 0.35) {
      const back = lz < -0.3 && Math.abs(lz) >= Math.abs(lx) * 0.8;
      if (back) { lname = 'Walk'; rate = -Math.min(1.6, sp / 1.6); }
      else {
        lname = sp < 2.8 ? 'Walk' : 'Run';
        rate = lname === 'Walk' ? sp / 1.6 : sp / (sprint ? 5.2 : 4.6);
        // вбок: корпус доворачивается к направлению хода (своих клипов стрейфа у моделей нет)
        turnWant = Math.max(-1.2, Math.min(1.2, Math.atan2(lx, Math.max(0.05, lz))));
      }
    } else if (Math.abs(S.yawRate) > 1.4) { lname = 'Walk'; rate = 0.7; }
    setLoco(lname);
    if (loco) loco.timeScale = Math.sign(rate || 1) * Math.min(1.9, Math.max(0.55, Math.abs(rate)));
    const moving = sp > 0.6;

    // действия по событиям боя
    let want = null;
    for (const e of Array.isArray(events) ? events : []) {
      if (!e) continue;
      const d = e.data || {};
      switch (e.type) {
        case 'player_dash': want = { name: 'Jump', speed: 2.2, full: true }; break;
        case 'player_hit': S.recoil = 1; break;
        case 'player_slash': want = { name: 'Punch', speed: 2.0 }; break;
        case 'burst': want = { name: 'Punch', speed: 1.4 }; break;
        case 'rune_cast': want = { name: 'Punch', speed: 1.2 }; break;
        case 'parry': want = { name: 'Punch', speed: 2.4 }; break;
        case 'sigil_cast': want = { name: 'Punch', speed: 1.3 }; break;
        case 'player_cast': if (!want) want = { name: 'Punch', speed: d.ability === 'spark' ? 2.6 : 1.8 }; break;
        default: break;
      }
    }
    if (want) {
      playAct(want.name, { speed: want.speed, upperOnly: !want.full && moving });
    } else {
      // удержания: щит / чары / стрельба «OK» — рука вперёд (поза «Punch» на пике)
      const holdKey = P.action === 'shield' ? 'shield' : P.action === 'conjure' ? 'conjure' : P.action === 'cast' ? 'cast' : '';
      const busy = act && !holdName && time < actUntil;
      if (holdKey && !busy) {
        if (holdName !== holdKey || actUpper !== moving) playAct('Punch', { holdKey, upperOnly: moving, fade: 0.15, freezeAt: holdKey === 'conjure' ? 0.35 : 0.5 });
      } else if (!holdKey && holdName) stopAct(0.2);
      else if (act && !holdName && time >= actUntil) stopAct(0.25);
    }

    // обёртка: корпус по ходу, наклон на бегу, отдача от удара
    const k = 1 - Math.exp(-8 * dt);
    S.turn += (turnWant * (holdName || act ? 0.4 : 1) - S.turn) * k;
    const leanWant = lz > 2.5 ? (sprint ? 0.16 : 0.07) : 0;
    S.lean += (leanWant - S.lean) * (1 - Math.exp(-6 * dt));
    S.recoil = Math.max(0, S.recoil - dt * 3.5);
    W.rotation.set(S.lean - 0.25 * Math.sin(Math.PI * S.recoil), S.turn, 0);
    cur.mixer.update(dt);
    vrmTick(dt);
  }

  // VRM: моргание раз в 2–5 с и обновление (нормализованный скелет → меш, физика волос/одежды)
  function vrmTick(dt) {
    const vrm = cur && cur.vrm;
    if (!vrm) return;
    S.blinkT -= dt;
    if (S.blinkT <= 0) { S.blink = 0.14; S.blinkT = 2 + Math.random() * 3; }
    const bw = S.blink > 0 ? Math.sin(Math.PI * (1 - S.blink / 0.14)) : 0;
    S.blink = Math.max(0, S.blink - dt);
    const em = vrm.expressionManager;
    if (em) { try { em.setValue('blink', bw); } catch (e) { /* нет выражения */ } }
    vrm.update(Math.min(dt, 1 / 20));
  }

  function dispose() {
    S.disposed = true;
    clear();
    showProcedural(true);
  }

  setHero(hero);

  return {
    update, setHero, dispose,
    get ready() { return S.ready; },
    get hero() { return S.hero; },
    state: () => ({ hero: S.hero, ready: S.ready, loco: locoName, locoRate: loco ? +loco.timeScale.toFixed(2) : 0, act: actName, upper: actUpper, hold: holdName }),
  };
}
