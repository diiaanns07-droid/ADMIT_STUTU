// ASHEN OATH — второй герой в сцене: соперник по сети (№2 [NET]).
//
// createRemotePlayer({ THREE, scene, world, heroFactory, camera })
//   → { push(st), pushEvents(list), update(dt), getState(), getAnchors(), setInfo({name, hero}),
//       setConnected(on), setVisible(on), dispose(), root }
//   push(st)   — декодированный пакет st (net/sync.js decodeState) сразу при приёме;
//   update(dt, nowMs?) — раз в кадр: буфер интерполяции ~100 мс + короткая экстраполяция (net/interp.js),
//                сглаженный поворот, высота по земле мира, анимации героя, табличка над головой;
//   getState() — для snap.opponent у №3 [PVP] (C4).
// Модель — createHeroModel (C5) на своём root: герой, которого соперник выбрал в hello. Пока VRM
// грузится (и для «Пепельного стража», у которого нет VRM-файла) — своё процедурное тело в плаще
// с багровой руной. При обрыве связи — призрачный силуэт и надпись «Связь потеряна».

import { createInterpBuffer } from '../net/interp.js';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const HERO_NAMES = { ashen: 'Пепельный страж', elf: 'Эльфийка', dark: 'Тёмная чародейка' };

// ---------------------------------------------------------------- процедурное тело (общие ресурсы)
let SHARED = null;
function shared(THREE) {
  if (SHARED && SHARED.THREE === THREE) return SHARED;
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.1, ...extra });
  SHARED = {
    THREE,
    mat: {
      cloak: std(0x2a1d22, { roughness: 0.9 }),
      coat: std(0x3d3238),
      skin: std(0xb89a86, { roughness: 0.6 }),
      leather: std(0x2b2320),
      gold: std(0xb08a48, { metalness: 0.7, roughness: 0.35 }),
      rune: new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      ghost: new THREE.MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    },
    geo: {
      leg: new THREE.CylinderGeometry(0.07, 0.055, 0.86, 8).translate(0, -0.43, 0),
      boot: new THREE.BoxGeometry(0.11, 0.09, 0.24).translate(0, -0.86, 0.04),
      torso: new THREE.CylinderGeometry(0.2, 0.16, 0.62, 10).translate(0, 0.31, 0),
      cloak: new THREE.ConeGeometry(0.42, 1.25, 14, 1, true).translate(0, -0.35, 0),
      arm: new THREE.CylinderGeometry(0.055, 0.045, 0.66, 8).translate(0, -0.33, 0),
      hand: new THREE.SphereGeometry(0.055, 8, 6).translate(0, -0.68, 0),
      head: new THREE.SphereGeometry(0.115, 14, 10),
      hood: new THREE.ConeGeometry(0.17, 0.36, 12, 1, true).translate(0, 0.08, -0.02),
      pauldron: new THREE.SphereGeometry(0.1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      rune: new THREE.RingGeometry(0.07, 0.1, 3, 1),
    },
  };
  SHARED.mat.cloak.side = THREE.DoubleSide;
  SHARED.mat.cloak.userData.netShared = true;
  return SHARED;
}

function buildBody(THREE, ghost) {
  const R = shared(THREE);
  const m = (k) => (ghost ? R.mat.ghost : R.mat[k]);
  const g = new THREE.Group();
  g.name = ghost ? 'remote-ghost' : 'remote-body';
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(geo, mat);
    o.position.set(x, y, z);
    o.castShadow = !ghost;
    parent.add(o);
    return o;
  };
  const hips = new THREE.Group(); hips.position.y = 0.92; g.add(hips);
  const legL = new THREE.Group(); legL.position.set(0.1, 0, 0); hips.add(legL);
  const legR = new THREE.Group(); legR.position.set(-0.1, 0, 0); hips.add(legR);
  mesh(R.geo.leg, m('leather'), legL); mesh(R.geo.boot, m('leather'), legL);
  mesh(R.geo.leg, m('leather'), legR); mesh(R.geo.boot, m('leather'), legR);
  const chest = new THREE.Group(); chest.position.y = 0.02; hips.add(chest);
  mesh(R.geo.torso, m('coat'), chest);
  const cloak = mesh(R.geo.cloak, m('cloak'), chest, 0, 0.58, -0.03);
  cloak.scale.set(1, 1, 0.75);
  const shL = new THREE.Group(); shL.position.set(0.24, 0.56, 0); chest.add(shL);
  const shR = new THREE.Group(); shR.position.set(-0.24, 0.56, 0); chest.add(shR);
  mesh(R.geo.arm, m('coat'), shL); mesh(R.geo.hand, m('skin'), shL);
  mesh(R.geo.arm, m('coat'), shR); mesh(R.geo.hand, m('skin'), shR);
  mesh(R.geo.pauldron, m('gold'), chest, 0.25, 0.58, 0);
  mesh(R.geo.pauldron, m('gold'), chest, -0.25, 0.58, 0);
  const head = new THREE.Group(); head.position.y = 0.78; chest.add(head);
  mesh(R.geo.head, m('skin'), head);
  mesh(R.geo.hood, m('cloak'), head);
  // багровая руна на спине и на груди — видно, что это соперник, а не свой герой
  const runeB = mesh(R.geo.rune, ghost ? R.mat.ghost : R.mat.rune, chest, 0, 0.36, -0.2);
  runeB.rotation.y = Math.PI; runeB.castShadow = false;
  const runeF = mesh(R.geo.rune, ghost ? R.mat.ghost : R.mat.rune, chest, 0, 0.4, 0.17);
  runeF.scale.setScalar(0.6); runeF.castShadow = false;
  return { group: g, hips, legL, legR, chest, shL, shR, head, runeB, runeF };
}

// ---------------------------------------------------------------- табличка над головой
function makePlate(THREE) {
  const W = 512, H = 128;
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!cv) return null;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 998;
  sprite.scale.set(1.7, 0.425, 1);
  let key = '';
  function draw({ name, hp, maxHp, energy, maxEnergy, status }) {
    const k = `${name}|${Math.round(hp)}|${Math.round(maxHp)}|${Math.round((energy / Math.max(1, maxEnergy)) * 20)}|${status}`;
    if (k === key) return;
    key = k;
    ctx.clearRect(0, 0, W, H);
    // тёмная полупрозрачная плашка с тонкой золотой каймой
    const r = 14, x0 = 8, y0 = 8, w = W - 16, h = H - 16;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0); ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    ctx.lineTo(x0 + w, y0 + h - r); ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    ctx.lineTo(x0 + r, y0 + h); ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
    ctx.closePath();
    const bg = ctx.createLinearGradient(0, y0, 0, y0 + h);
    bg.addColorStop(0, 'rgba(22,16,14,0.86)'); bg.addColorStop(1, 'rgba(8,6,6,0.9)');
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(201,164,92,0.95)'; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,226,160,0.25)';
    ctx.strokeRect(x0 + 6, y0 + 6, w - 12, h - 12);
    // имя
    ctx.font = '600 36px "Cinzel", "Cormorant Garamond", Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = status === 'lost' ? 'rgba(170,190,220,0.9)' : '#f1dca6';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 6;
    const label = status === 'lost' ? `${name} · связь потеряна` : name;
    ctx.fillText(label.length > 26 ? `${label.slice(0, 25)}…` : label, W / 2, 44, w - 40);
    ctx.shadowBlur = 0;
    // полоса HP (багровая) и тонкая энергии
    const bx = 40, bw = W - 80, by = 74, bh = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(bx, by, bw, bh);
    const k1 = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    const hg = ctx.createLinearGradient(0, by, 0, by + bh);
    hg.addColorStop(0, status === 'lost' ? '#56607a' : '#d2383a'); hg.addColorStop(1, status === 'lost' ? '#323a4c' : '#7a1216');
    ctx.fillStyle = hg; ctx.fillRect(bx + 2, by + 2, (bw - 4) * k1, bh - 4);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(201,164,92,0.9)'; ctx.strokeRect(bx, by, bw, bh);
    ctx.font = '600 16px Georgia, serif'; ctx.fillStyle = '#fff3d6';
    ctx.fillText(`${Math.max(0, Math.round(hp))} / ${Math.round(maxHp)}`, W / 2, by + bh / 2 + 1);
    const k2 = Math.max(0, Math.min(1, energy / Math.max(1, maxEnergy)));
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(bx, by + bh + 4, bw, 6);
    ctx.fillStyle = '#e0b04a'; ctx.fillRect(bx + 1, by + bh + 5, (bw - 2) * k2, 4);
    tex.needsUpdate = true;
  }
  return { sprite, draw, dispose() { tex.dispose(); mat.dispose(); } };
}

// ---------------------------------------------------------------- удалённый игрок
export function createRemotePlayer({ THREE, scene, world, heroFactory, camera, heroes = null, delayMs = 100 } = {}) {
  const root = new THREE.Group();
  root.name = 'remote-player';
  root.visible = false;
  scene.add(root);
  const body = buildBody(THREE, false);
  const ghost = buildBody(THREE, true);
  ghost.group.visible = false;
  root.add(body.group);
  root.add(ghost.group);
  const plate = makePlate(THREE);
  if (plate) root.add(plate.sprite);

  // признаки состояния соперника, которые effects рисует только у своего героя: щит, сфера чар, сгусток стихии
  const ELEM = { fire: 0xff6a2a, storm: 0x8fb8ff, frost: 0x9fe6ff, earth: 0xc79a52 };
  const addMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const fx = new THREE.Group(); fx.name = 'remote-fx'; root.add(fx);
  // щит — френель: яркая кромка, прозрачный центр (соперника видно сквозь щит)
  const shieldMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xff6a3c) }, opacity: { value: 0.5 } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 color; uniform float opacity; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4); gl_FragColor = vec4(color * (0.35 + 1.8 * f), opacity * (0.08 + 0.92 * f)); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const shield = new THREE.Mesh(new THREE.SphereGeometry(0.95, 24, 12, -Math.PI * 0.42, Math.PI * 0.84, Math.PI * 0.12, Math.PI * 0.62), shieldMat);
  shield.position.set(0, 1.05, 0.12); shield.visible = false; fx.add(shield);
  const rimMat = addMat(0xffc27a, 0.5);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.015, 6, 40), rimMat);
  rim.position.set(0, 1.15, 0.72); rim.visible = false; fx.add(rim);
  const orbMat = addMat(0xffb070, 0.85);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), orbMat);
  orb.position.set(0, 1.25, 0.45); orb.visible = false; fx.add(orb);
  const spellMat = addMat(0xff6a2a, 0.9);
  const spell = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), spellMat);
  spell.position.set(-0.28, 1.2, 0.35); spell.visible = false; fx.add(spell);
  function updateFx(st, lost) {
    const on = !lost && !!st;
    const pulse = 0.85 + 0.15 * Math.sin(S.t * 9);
    shield.visible = rim.visible = on && !!st.shielding;
    if (shield.visible) { shieldMat.uniforms.opacity.value = 0.55 * pulse; rimMat.opacity = 0.45 * pulse; }
    const cj = on && st.conjure;
    orb.visible = !!cj;
    if (cj) { orb.scale.setScalar(0.6 + 1.4 * Math.min(1, cj.size || 0.3)); orbMat.opacity = 0.55 + 0.4 * Math.min(1, cj.charge || 0); orbMat.color.setHex(cj.kind === 'prism' ? 0xd9b8ff : 0xffb070); }
    const hs = on && st.handSpell && st.handSpell.phase !== 'idle' && st.handSpell.phase !== 'throw' ? st.handSpell : null;
    spell.visible = !!hs;
    if (hs) { spell.scale.setScalar(0.6 + 1.2 * Math.min(1, hs.power || 0.3)); spellMat.color.setHex(ELEM[hs.element] || 0xff6a2a); spellMat.opacity = 0.42 + 0.15 * pulse; }
    // сгусток — у правой руки модели, если есть якорь
    if (hs && hm && hm.ready && typeof hm.getAnchors === 'function') {
      try { const a = hm.getAnchors().handR; if (a && a.parent) { a.getWorldPosition(_hand); fx.worldToLocal(_hand); spell.position.copy(_hand); } } catch (e) { /* ignore */ }
    }
  }
  const _hand = new THREE.Vector3();

  // призрак из самой модели героя: на время обрыва меши получают светящийся полупрозрачный материал
  // (встроенный MeshBasicMaterial сам поддерживает скиннинг и морфы), потом родные возвращаются
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  let ghosted = null;   // [{ mesh, mat }]
  function setModelGhost(model, on) {
    if (on && !ghosted && model) {
      ghosted = [];
      model.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.material) { ghosted.push({ mesh: o, mat: o.material, cast: o.castShadow }); o.material = Array.isArray(o.material) ? o.material.map(() => ghostMat) : ghostMat; o.castShadow = false; } });
    } else if (!on && ghosted) {
      for (const g of ghosted) { g.mesh.material = g.mat; g.mesh.castShadow = g.cast; }
      ghosted = null;
    }
  }

  const buf = createInterpBuffer({ delayMs });
  const S = {
    name: 'Соперник', hero: 'ashen', connected: true, visible: true, got: false,
    yaw: 0, rootY: null, walk: 0, t: 0, st: null, lastRecv: 0,
    slashT: 9, castT: 9, burstT: 9, dashT: 9, parryT: 9,
  };
  let events = [];
  let hm = null;

  const groundAt = (x, z) => {
    try {
      if (world && typeof world.groundAt === 'function') { const y = world.groundAt(x, z); if (Number.isFinite(y)) return y; }
      if (world && world.layout && typeof world.layout.groundY === 'function') { const y = world.layout.groundY(x, z); if (Number.isFinite(y)) return y; }
    } catch (e) { /* ignore */ }
    return null;
  };

  function makeHero(id) {
    if (typeof heroFactory !== 'function') return;
    try {
      if (hm && typeof hm.setHero === 'function') { hm.setHero(id); return; }
      // без heroBody: страж у удалённого игрока — на запасной VRM (№4), своё процедурное тело — пока грузится
      hm = heroFactory({ heroRoot: root, heroBody: null, extras: [], hero: id, remote: true });
    } catch (e) { console.warn('[NET] модель соперника — процедурное тело:', e && e.message); hm = null; }
  }

  function setInfo({ name, hero } = {}) {
    if (typeof name === 'string' && name.trim()) S.name = name.trim().slice(0, 20);
    if (typeof hero === 'string' && hero !== S.hero) { S.hero = hero; makeHero(hero); }
    else if (!hm && typeof hero === 'string') makeHero(hero);
  }

  function push(st) {
    if (!st) return;
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    S.lastRecv = t;
    buf.push(st, t);
    S.got = true;
  }
  function pushEvents(list) {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e) continue;
      events.push(e);
      switch (e.type) {
        case 'player_slash': S.slashT = 0; break;
        case 'player_cast': case 'rune_cast': case 'sigil_cast': case 'hand_spell_throw': case 'bow_release': S.castT = 0; break;
        case 'burst': S.burstT = 0; break;
        case 'player_dash': S.dashT = 0; break;
        case 'parry': S.parryT = 0; break;
        default: break;
      }
    }
    if (events.length > 64) events.splice(0, events.length - 64);
  }

  function setConnected(on) { S.connected = !!on; }
  function setVisible(on) { S.visible = !!on; root.visible = S.visible && S.got; }

  // процедурное тело: шаг по пройденному пути, руки — по действиям
  function animateBody(b, dt, st, sp) {
    const A = b;
    S.walk += sp * dt * 2.6;
    const amp = Math.min(1, sp / 4.5) * 0.7;
    const sw = Math.sin(S.walk) * amp;
    A.legL.rotation.x = sw; A.legR.rotation.x = -sw;
    A.hips.position.y = 0.92 + Math.abs(Math.cos(S.walk)) * amp * 0.05;
    let aL = -sw * 0.8, aR = sw * 0.8, zL = 0.08, zR = -0.08;
    const act = st ? st.action : 'idle';
    if (st && st.shielding) { aL = -1.45; zL = -0.2; }
    if (act === 'conjure' || (st && st.handSpell)) { aL = -1.2; aR = -1.2; zL = -0.35; zR = 0.35; }
    if (st && st.bow) { aL = -1.55; aR = -1.4; zR = 0.5 * (st.bow.draw || 0); }
    const cast = Math.max(0, 1 - S.castT / 0.35), slash = Math.max(0, 1 - S.slashT / 0.4), burst = Math.max(0, 1 - S.burstT / 0.5), parry = Math.max(0, 1 - S.parryT / 0.35);
    if (cast > 0 || act === 'cast' || act === 'spark') { aR = -1.5; zR = 0; }
    if (slash > 0) { aR = -1.2 + (1 - slash) * 0.6; zR = -1.4 + (1 - slash) * 2.6; }
    if (burst > 0) { aL = -1.5; aR = -1.5; zL = -0.5 * burst; zR = 0.5 * burst; }
    if (parry > 0) { aL = -1.6; zL = 0; }
    const k = damp(18, dt);
    A.shL.rotation.x += (aL - A.shL.rotation.x) * k; A.shL.rotation.z += (zL - A.shL.rotation.z) * k;
    A.shR.rotation.x += (aR - A.shR.rotation.x) * k; A.shR.rotation.z += (zR - A.shR.rotation.z) * k;
    const lean = Math.min(0.18, sp * 0.025) + Math.max(0, 1 - S.dashT / 0.3) * 0.3;
    A.chest.rotation.x += (lean - A.chest.rotation.x) * k;
    const pulse = 0.75 + 0.25 * Math.sin(S.t * 3);
    A.runeB.material.opacity = A.runeB.material === shared(THREE).mat.ghost ? 0.22 : pulse;
  }

  const snapLike = { status: 'playing', player: null };
  const EMPTY_EVENTS = Object.freeze([]);
  const _cam = new THREE.Vector3();

  // nowMs — время кадра (rAF): интерполяция идёт ровно по кадрам, без дрожи от момента вызова
  function update(dt, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : typeof performance !== 'undefined' ? performance.now() : Date.now();
    S.t += dt;
    S.slashT += dt; S.castT += dt; S.burstT += dt; S.dashT += dt; S.parryT += dt;
    root.visible = S.visible && S.got;
    if (!S.got || !S.visible) { events.length = 0; return; }   // в меню соперник не считается вовсе
    const s = buf.sample(now);
    if (!s.ok) { events.length = 0; return; }
    S.st = s.st;
    // позиция и высота по земле мира
    const gy = groundAt(s.x, s.z);
    const y = gy !== null ? gy : s.y;
    if (S.rootY === null || Math.abs(y - S.rootY) > 1.2 || dt <= 0) S.rootY = y;
    else S.rootY += (y - S.rootY) * damp(y > S.rootY ? 16 : 11, dt);
    root.position.set(s.x, S.rootY, s.z);
    if (world && typeof world.setForestHero2 === 'function') { try { world.setForestHero2(root.position); } catch (e) { /* ignore */ } } // трава Сияющего леса мнётся и под соперником
    // поворот: интерполированный yaw + сглаживание
    S.yaw += wrapPi(s.yaw - S.yaw) * damp(14, dt);
    S.yaw = wrapPi(S.yaw);
    root.rotation.y = S.yaw;

    const st = s.st;
    const lost = !S.connected;
    // призрак при обрыве: модель героя становится светящимся силуэтом; без модели — процедурный призрак
    const model = root.getObjectByName('hero-model');
    const vrmOn = !!(hm && hm.ready && model);
    if (ghosted && (!vrmOn || !model)) ghosted = null;      // модель сменилась — старые меши уже не наши
    setModelGhost(vrmOn ? model : null, lost && vrmOn);
    if (ghosted) ghostMat.opacity = 0.2 + 0.1 * Math.sin(S.t * 4);
    ghost.group.visible = lost && !vrmOn;
    if (model) model.visible = true;
    body.group.visible = !lost && !vrmOn;
    const sp = Math.hypot(s.vx, s.vz);
    if (lost) animateBody(ghost, dt, null, 0);
    else if (!vrmOn) animateBody(body, dt, st, sp);
    updateFx(st, lost);
    if (hm) {
      // при обрыве модель стоит в покое (скорость 0), а не бежит на месте
      const P = lost ? { ...st, position: { x: s.x, y: S.rootY, z: s.z }, yaw: S.yaw, velocity: { x: 0, z: 0 }, speed: 0, action: 'idle', locomotion: 'idle', shielding: false, conjure: null, bow: null, handSpell: null }
        : { ...st, position: { x: s.x, y: S.rootY, z: s.z }, yaw: S.yaw, velocity: { x: s.vx, z: s.vz }, speed: sp };
      snapLike.player = P;
      snapLike.status = st && st.dead ? 'defeat' : 'playing';
      // C5: поза лука / чар рукой поверх анимаций — из st.bow / st.handSpell соперника
      if (typeof hm.setPose === 'function') {
        const bw = P.bow, hs = P.handSpell;
        const hsW = hs ? (hs.phase === 'hold' ? 1 : hs.phase === 'form' ? 0.6 : hs.phase === 'throw' ? 0.3 : 0) : 0;
        try { hm.setPose({ bowDraw: bw ? bw.draw : 0, aim: { x: bw ? bw.aimX : 0, y: bw ? bw.aimY : 0 }, handSpell: hsW }); } catch (e) { /* ignore */ }
      }
      try { hm.update(dt, snapLike, lost ? EMPTY_EVENTS : events); } catch (e) { console.warn('[NET] heroModel соперника', e); }
    }
    events.length = 0;

    if (plate) {
      plate.sprite.position.set(0, (vrmOn ? 1.95 : 2.05) + 0.25, 0);
      if (camera) {
        camera.getWorldPosition(_cam);
        const d = _cam.distanceTo(root.position);
        // LOD модели соперника ведёт сам heroModel (авто-LOD по камере, №4) — здесь не трогаем
        const k = Math.min(3.6, Math.max(1, d / 9));   // почти постоянный экранный размер до ~32 м
        plate.sprite.scale.set(1.7 * k, 0.425 * k, 1);
      }
      plate.draw({ name: S.name, hp: num(st && st.hp), maxHp: num(st && st.maxHp, 100), energy: num(st && st.energy), maxEnergy: num(st && st.maxEnergy, 100), status: lost ? 'lost' : 'ok' });
    }
  }

  function getState() {
    const st = S.st;
    if (!S.got || !st) return null;
    return {
      id: 'remote', name: S.name, hero: S.hero, heroName: (heroes && heroes[S.hero] && heroes[S.hero].name) || HERO_NAMES[S.hero] || S.hero,
      position: { x: root.position.x, y: root.position.y, z: root.position.z },
      yaw: S.yaw,
      velocity: { x: st.velocity.x, z: st.velocity.z }, speed: st.speed,
      hp: st.hp, maxHp: st.maxHp, energy: st.energy, maxEnergy: st.maxEnergy,
      action: st.action, locomotion: st.locomotion,
      shielding: st.shielding, invulnerable: st.invulnerable, dashing: st.dashing,
      stunned: st.stunned, slowed: st.slowed, dead: st.dead,
      conjure: st.conjure, burstCharge: st.burstCharge, bow: st.bow, handSpell: st.handSpell,
      connected: S.connected,
      latest: buf.latest ? { position: { ...buf.latest.position }, ts: buf.latest.ts } : null,
    };
  }

  function dispose() {
    setModelGhost(null, false);
    ghostMat.dispose();
    for (const m of [shield, rim, orb, spell]) { m.geometry.dispose(); m.material.dispose(); }
    if (world && typeof world.setForestHero2 === 'function') { try { world.setForestHero2(null); } catch (e) { /* ignore */ } }
    try { if (hm && typeof hm.dispose === 'function') hm.dispose(); } catch (e) { /* ignore */ }
    hm = null;
    if (plate) plate.dispose();
    scene.remove(root);
  }

  // C5: якоря рук/груди/головы соперника — эффекты №7 и №6 крепят к ним его заклинания
  function getAnchors() {
    try { if (hm && hm.ready && typeof hm.getAnchors === 'function') return hm.getAnchors(); } catch (e) { /* ignore */ }
    return { handL: body.shL, handR: body.shR, chest: body.chest, head: body.head, bowSocket: body.chest, staffTip: body.shR };
  }

  return {
    root, push, pushEvents, update, getState, getAnchors, setInfo, setConnected, setVisible, dispose,
    debug: () => ({ size: buf.size, baseDelay: buf.baseDelay, hero: S.hero, name: S.name, connected: S.connected, model: hm && typeof hm.state === 'function' ? hm.state() : null, pos: { x: +root.position.x.toFixed(2), z: +root.position.z.toFixed(2) } }),
  };
}
