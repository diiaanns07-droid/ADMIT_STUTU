// ASHEN OATH — эффект ультимейта «Небесный суд» [W3-ULT].
// Небо над Регентом раскалывается, из трещины падает огромный меч из света, вонзается в стража:
// столб света, две ударные волны по земле, искры и обломки (GPU-частицы V6, если слой включён).
//
// createUltimateFx({ THREE, scene, camera, getKit, groundY, reducedMotion }) → {
//   start({ target, hero, duration, strikeAt }) — начало сцены (событие ultimate_start);
//   update(t, dtReal) — t: секунды сцены (main.js синхронизирует с боем), dtReal — настенное время кадра;
//   setQuality('low'|'medium'|'high'), reset(), dispose(), active }
// Всё строится один раз при создании (скрыто): предкомпиляция шейдеров в main.js видит материалы заранее,
// в кадре нет аллокаций. «Низкое» качество: без ореола клинка и шума в столбе, частиц меньше (kit сам).
// «Уменьшенное движение»: без вспышек на весь экран и тряски (их делает main.js), свет мягче.

import { FX_OUT, FX_NOISE, premulBlend } from './glsl.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const smooth = (k) => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };

const RIFT_Y = 20;          // м над Регентом: трещина в небе (видна из облёта камеры, core/ultimate.js)
const SWORD_LEN = 9.5;      // клинок (острие → гарда), м
const GOLD = 0xffd98a, CORE = 0xfff6e0;

// ---------------------------------------------------------------- шейдеры
const VS_UV = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Трещина в небе: ломаная через всю плоскость, раскрывается от центра (uOpen), ядро белое, края золотые.
const FS_RIFT = /* glsl */`
uniform float uOpen; uniform float uTime; uniform float uGlow;
varying vec2 vUv;
${FX_NOISE}
float crack(vec2 p, float seed, float amp) {
  // ломаная: зигзаг из двух частот + шум, расстояние по y
  float y = amp * (0.55 * sin(p.x * 9.0 + seed) + 0.3 * sin(p.x * 23.0 + seed * 2.1) + 0.35 * (fxNoise2(vec2(p.x * 14.0, seed)) - 0.5));
  return abs(p.y - y);
}
void main() {
  vec2 p = vUv - 0.5; p.x *= 2.6;
  float reveal = 1.0 - smoothstep(uOpen * 1.35 - 0.12, uOpen * 1.35, abs(p.x));   // границы smoothstep — только по возрастанию
  float em = smoothstep(0.0, 0.14, vUv.x) * smoothstep(0.0, 0.14, 1.0 - vUv.x) * smoothstep(0.0, 0.25, vUv.y) * smoothstep(0.0, 0.25, 1.0 - vUv.y);
  float w = 0.004 + 0.035 * uOpen;
  float d = crack(p, 1.7, 0.10);
  float core = exp(-d / (w * 0.35));
  float edge = exp(-d / (w * 2.6));
  // ветви
  float b1 = crack(p * vec2(1.0, 1.4) + vec2(0.0, 0.05), 4.3, 0.16) * 1.4;
  float b2 = crack(p * vec2(1.0, 1.3) - vec2(0.0, 0.06), 7.9, 0.14) * 1.4;
  float br = exp(-min(b1, b2) / (w * 0.8)) * smoothstep(0.0, 0.5, uOpen) * 0.55;
  float flick = 0.85 + 0.15 * sin(uTime * 37.0) * sin(uTime * 11.0 + 1.3);
  float halo = exp(-length(p * vec2(0.55, 2.2)) * 3.0) * uOpen * 0.55;
  float a = ((core * 2.4 + edge * 0.9 + br) * reveal * flick + halo) * em;
  vec3 col = mix(vec3(1.0, 0.72, 0.32), vec3(1.0, 0.97, 0.9), clamp(core, 0.0, 1.0));
  a = clamp(a, 0.0, 4.0) * uGlow;
  gl_FragColor = vec4(col * a * 2.2, 0.0);
  ${FX_OUT}
}`;

// Столб света: цилиндр без торцов, ярче к оси взгляда (френель наоборот), бегущие вниз полосы.
const VS_PILLAR = /* glsl */`
varying vec2 vUv; varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const FS_PILLAR = /* glsl */`
uniform float uAmt; uniform float uTime; uniform float uNoise;
varying vec2 vUv; varying float vFacing;
${FX_NOISE}
void main() {
  float core = pow(vFacing, 2.5);
  float streak = mix(1.0, 0.55 + 0.9 * fxNoise2(vec2(vUv.x * 22.0, vUv.y * 3.0 + uTime * 6.0)), uNoise);
  float ends = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
  float a = uAmt * core * streak * ends;
  vec3 col = mix(vec3(1.0, 0.75, 0.38), vec3(1.0, 0.98, 0.92), core);
  gl_FragColor = vec4(col * a * 1.7, 0.0);
  ${FX_OUT}
}`;

// Ударная волна: кольцо с мягкими краями (uv.x — по радиусу у RingGeometry нет, берём расстояние от центра).
const VS_RING = /* glsl */`
varying vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FS_RING = /* glsl */`
uniform float uAmt; uniform float uR; uniform float uW; uniform vec3 uCol;
varying vec2 vP;
void main() {
  float d = abs(length(vP) - uR);
  float a = uAmt * exp(-d / max(0.02, uW));
  gl_FragColor = vec4(uCol * a * 2.0, 0.0);
  ${FX_OUT}
}`;

// Ореол клинка: обратные грани чуть больше клинка, светятся по краю.
const VS_GLOW = /* glsl */`
varying float vRim;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const FS_GLOW = /* glsl */`
uniform float uAmt;
varying float vRim;
void main() {
  float a = uAmt * (0.35 + 0.65 * (1.0 - vRim));
  gl_FragColor = vec4(vec3(1.0, 0.78, 0.4) * a * 0.9, 0.0);
  ${FX_OUT}
}`;

// Клинок из света: грани к камере — белые, скошенные — золотые (кристалл читается силуэтом и гранями).
const FS_BLADE = /* glsl */`
uniform float uAmt;
varying float vRim;
void main() {
  float f = 1.0 - vRim;
  vec3 col = mix(vec3(1.0, 0.62, 0.22) * 0.85, vec3(1.0, 0.97, 0.88) * 1.35, smoothstep(0.15, 0.85, f));
  gl_FragColor = vec4(col * uAmt, uAmt);
  ${FX_OUT}
}`;

// Клинок: вытянутая ромбовидная бипирамида (острие внизу, у гарды — шире), по оси Y от 0 до len.
function bladeGeometry(THREE, len, halfW, halfT) {
  const tipY = 0, baseY = len, shoulderY = len * 0.12;
  const v = [
    0, tipY, 0,                       // 0 острие
    -halfW * 0.9, shoulderY, 0,       // 1 плечо слева
    0, shoulderY, halfT,              // 2 ребро спереди
    halfW * 0.9, shoulderY, 0,        // 3 плечо справа
    0, shoulderY, -halfT,             // 4 ребро сзади
    -halfW, baseY, 0,                 // 5 у гарды слева
    0, baseY, halfT,                  // 6
    halfW, baseY, 0,                  // 7
    0, baseY, -halfT,                 // 8
  ];
  const idx = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 4, 8, 3, 8, 7, 4, 1, 5, 4, 5, 8,
    5, 6, 7, 5, 7, 8];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();   // плоские грани — гранёный «кристалл» света
  g.dispose();
  ng.computeVertexNormals();
  return ng;
}

export function createUltimateFx({ THREE, scene, camera, getKit = null, groundY = null, reducedMotion = () => false } = {}) {
  if (!THREE || !scene) throw new Error('[fx/ultimate] нужны THREE и scene');
  const rm = typeof reducedMotion === 'function' ? reducedMotion : () => !!reducedMotion;
  const root = new THREE.Group();
  root.name = 'ashen-ultimate-fx';
  root.visible = false;
  scene.add(root);
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };
  let quality = 'medium';

  // трещина в небе — плоскость, повёрнутая к камере
  const riftMat = keep(new THREE.ShaderMaterial({
    uniforms: { uOpen: { value: 0 }, uTime: { value: 0 }, uGlow: { value: 1 } },
    vertexShader: VS_UV, fragmentShader: FS_RIFT, side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE),
  }));
  const rift = new THREE.Mesh(keep(new THREE.PlaneGeometry(24, 9.5)), riftMat);
  rift.frustumCulled = false; rift.renderOrder = 6; rift.name = 'ult-rift';
  root.add(rift);

  // столб света (от трещины до земли) и тонкий «прицел» перед ударом
  const pillarMat = keep(new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uTime: { value: 0 }, uNoise: { value: 1 } },
    vertexShader: VS_PILLAR, fragmentShader: FS_PILLAR, side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE),
  }));
  const pillarGeo = keep(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true));
  pillarGeo.translate(0, 0.5, 0);   // от основания вверх
  const pillar = new THREE.Mesh(pillarGeo, pillarMat);
  pillar.frustumCulled = false; pillar.renderOrder = 5; pillar.name = 'ult-pillar';
  root.add(pillar);

  // меч: клинок, гарда, рукоять, навершие — один материал «раскалённого света» (выше порога bloom)
  // клинок — чуть выше порога bloom (1.0), чтобы светился, но читался силуэтом; гарда и рукоять — глубже по тону
  const swordMat = keep(new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 1 } }, vertexShader: VS_GLOW, fragmentShader: FS_BLADE,
    side: THREE.FrontSide, depthTest: true, depthWrite: true, fog: false, ...premulBlend(THREE),
  }));
  swordMat.depthWrite = true;
  const guardMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe0a040).multiplyScalar(0.95), transparent: true, opacity: 1, fog: false, toneMapped: false }));
  const sword = new THREE.Group();
  sword.name = 'ult-sword';
  const blade = new THREE.Mesh(keep(bladeGeometry(THREE, SWORD_LEN, 0.62, 0.16)), swordMat);
  const guard = new THREE.Mesh(keep(new THREE.BoxGeometry(3.4, 0.34, 0.42)), guardMat);
  guard.position.y = SWORD_LEN + 0.17;
  const grip = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.16, 0.2, 1.9, 10)), guardMat);
  grip.position.y = SWORD_LEN + 0.34 + 0.95;
  const pommel = new THREE.Mesh(keep(new THREE.OctahedronGeometry(0.42, 0)), guardMat);
  pommel.position.y = SWORD_LEN + 0.34 + 1.9 + 0.3;
  const glowMat = keep(new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 } }, vertexShader: VS_GLOW, fragmentShader: FS_GLOW,
    side: THREE.BackSide, depthTest: true, fog: false, ...premulBlend(THREE),
  }));
  const glow = new THREE.Mesh(blade.geometry, glowMat);
  glow.scale.set(2.3, 1.03, 3.2); glow.position.y = -0.12;
  for (const m of [blade, guard, grip, pommel, glow]) { m.frustumCulled = false; sword.add(m); }
  root.add(sword);

  // ударные волны: широкая золотая и быстрая белая; круг клятвы под героем
  const ringGeo = keep(new THREE.CircleGeometry(1, 72));
  function ringMesh(name, col) {
    const mat = keep(new THREE.ShaderMaterial({
      uniforms: { uAmt: { value: 0 }, uR: { value: 0.5 }, uW: { value: 0.1 }, uCol: { value: new THREE.Color(col) } },
      vertexShader: VS_RING, fragmentShader: FS_RING, side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE),
    }));
    const m = new THREE.Mesh(ringGeo, mat);
    m.rotation.x = -Math.PI / 2; m.frustumCulled = false; m.renderOrder = 4; m.name = name;
    root.add(m);
    return m;
  }
  const waveA = ringMesh('ult-wave-a', 0xffc46a), waveB = ringMesh('ult-wave-b', 0xfff1d0), oath = ringMesh('ult-oath', 0xffd98a);

  const s = {
    active: false, t: 0, dur: 3.6, strikeAt: 2.3, struck: false, sparkAcc: 0, motesAcc: 0,
    target: new THREE.Vector3(), ground: 0, hero: new THREE.Vector3(), heroGround: 0,
  };
  const _up = new THREE.Vector3(0, 1, 0);
  const _p = { x: 0, y: 0, z: 0 };
  // опции частиц, которые идут каждый кадр (след меча, свет из трещины), — один объект на всё время
  const TRAIL = { at: { x: 0, y: 0, z: 0 }, shape: 'box', box: { x: 0.4, y: SWORD_LEN * 0.5, z: 0.4 }, count: 0, dir: { x: 0, y: 1, z: 0 }, cone: 0.5, speed: [1, 4], life: [0.3, 0.7], size: [0.1, 0.02], ramp: 'gold', intensity: 2.2, drag: 1 };
  const MOTES = { at: { x: 0, y: 0, z: 0 }, shape: 'box', box: { x: 9, y: 0.5, z: 3 }, count: 0, dir: { x: 0, y: -1, z: 0 }, cone: 0.15, speed: [6, 12], life: [1, 1.8], size: [0.09, 0.03], ramp: 'gold', intensity: 2, drag: 0.2 };

  function gy(x, z, d) {
    if (typeof groundY !== 'function') return d;
    let g = NaN; try { g = Number(groundY(x, z)); } catch (e) { g = NaN; }
    return fin(g) ? g : d;
  }
  function kit() { try { const k = typeof getKit === 'function' ? getKit() : null; return k && typeof k.emit === 'function' ? k : null; } catch (e) { return null; } }

  function setQuality(q) {
    quality = q === 'low' || q === 'high' ? q : 'medium';
    glow.visible = quality !== 'low';
    pillarMat.uniforms.uNoise.value = quality === 'low' ? 0 : 1;
  }
  setQuality('medium');

  function hideAll() {
    root.visible = false;
    riftMat.uniforms.uOpen.value = 0; pillarMat.uniforms.uAmt.value = 0; glowMat.uniforms.uAmt.value = 0;
    for (const w of [waveA, waveB, oath]) w.material.uniforms.uAmt.value = 0;
  }

  function start(o = {}) {
    const T = o.target || {};
    s.target.set(fin(T.x) ? T.x : 0, fin(T.y) ? T.y : 2.2, fin(T.z) ? T.z : 0);
    s.ground = gy(s.target.x, s.target.z, 0);
    const Hh = o.hero || {};
    s.hero.set(fin(Hh.x) ? Hh.x : 0, fin(Hh.y) ? Hh.y : 0, fin(Hh.z) ? Hh.z : 6);
    s.heroGround = gy(s.hero.x, s.hero.z, s.hero.y);
    s.dur = fin(o.duration) && o.duration > 0 ? o.duration : 3.6;
    s.strikeAt = fin(o.strikeAt) ? clamp(o.strikeAt, 0.4, s.dur) : 2.3;
    s.t = 0; s.struck = false; s.sparkAcc = 0; s.motesAcc = 0;
    s.active = true;
    root.visible = true;
    rift.position.set(s.target.x, s.ground + RIFT_Y, s.target.z);
    pillar.position.set(s.target.x, s.ground, s.target.z);
    pillar.scale.set(0.001, RIFT_Y, 0.001);
    sword.visible = false;
    for (const w of [waveA, waveB]) w.position.set(s.target.x, s.ground + 0.06, s.target.z);
    oath.position.set(s.hero.x, s.heroGround + 0.05, s.hero.z);
    // клятва: золотые искры поднимаются вокруг героя
    const k = kit();
    if (k) {
      _p.x = s.hero.x; _p.y = s.heroGround + 0.2; _p.z = s.hero.z;
      k.emit({ at: _p, shape: 'ring', radius: 1.3, count: 70, dir: _up, cone: 0.25, speed: [2.5, 6], life: [0.7, 1.4], size: [0.12, 0.02], ramp: 'gold', intensity: 2.2, drag: 0.6, turb: 0.6, essential: true });
      _p.y = s.heroGround + 1.4;
      k.flash(_p, { color: GOLD, size: [0.6, 3.2], dur: 0.5, intensity: 3 });
      k.light(_p, { color: 0xffd08a, intensity: 1.2, range: 10, dur: 1.1, attack: 0.15 });
    }
  }

  function strike() {
    s.struck = true;
    const k = kit();
    if (!k) return;
    _p.x = s.target.x; _p.y = s.ground + 0.4; _p.z = s.target.z;
    // искры фонтаном, обломки, пыль кольцом, вспышка, свет
    k.emit({ at: _p, count: 160, dir: _up, cone: 1.1, speed: [8, 20], life: [0.5, 1.2], size: [0.18, 0.03], ramp: 'gold', intensity: 2.6, gravity: 9, drag: 0.4, stretch: 0.06, essential: true });
    k.emit({ at: _p, shape: 'ring', radius: 1.6, count: 60, dir: _up, cone: 0.9, speed: [4, 10], life: [0.8, 1.6], size: [0.22, 0.12], ramp: 'stone', blend: 'alpha', sprite: 'debris', gravity: 14, spin: [-6, 6], ground: s.ground });
    k.emit({ at: _p, shape: 'ring', radius: 2.2, count: 46, radial: 7, speed: [0.5, 2], life: [1.2, 2.2], size: [0.9, 2.6], ramp: 'dust', blend: 'alpha', sprite: 'smoke', drag: 1.6 });
    _p.y = s.ground + 3;
    k.flash(_p, { color: CORE, size: [1.2, 6], dur: 0.32, intensity: 2.6, sprite: 'glow' });
    k.flash(_p, { color: GOLD, size: [1.5, 5], dur: 0.28, intensity: 2.4, sprite: 'star' });
    k.light(_p, { color: 0xffe0a0, intensity: 1.4, range: 22, dur: 1.4, attack: 0.02 });
  }

  // t — секунды сцены, dtReal — настенное время кадра
  function update(t, dtReal) {
    if (!s.active) return;
    if (fin(t)) s.t = t; else s.t += fin(dtReal) ? dtReal : 0;
    const T = s.t, D = s.dur, S = s.strikeAt, dt = fin(dtReal) ? clamp(dtReal, 0, 0.1) : 0;
    if (T >= D) { s.active = false; hideAll(); return; }
    const k = kit();
    // трещина: раскрывается 0,4 → S−0,9; держится; закрывается после удара
    const open = smooth((T - 0.35) / Math.max(0.2, S - 1.25)) * (1 - smooth((T - (S + 0.55)) / Math.max(0.2, D - S - 0.7)));
    riftMat.uniforms.uOpen.value = open;
    riftMat.uniforms.uTime.value = T;
    riftMat.uniforms.uGlow.value = rm() ? 0.6 : 1;
    if (camera) { rift.quaternion.copy(camera.quaternion); }
    // столб: тонкий «прицел» перед ударом → широкий столб в момент удара → гаснет
    let pw = 0, pa = 0;
    if (T < S) { const a = smooth((T - (S - 0.85)) / 0.6); pw = 0.12 * a; pa = 0.5 * a; }
    else { const u = T - S; pw = 0.12 + 0.75 * smooth(u / 0.08) * (1 - smooth((u - 0.12) / 0.5)); pa = (1 - smooth((u - 0.05) / 0.5)) * 0.8; }
    pillar.visible = pa > 0.002;
    pillar.scale.set(Math.max(0.001, pw), RIFT_Y, Math.max(0.001, pw));
    pillarMat.uniforms.uAmt.value = pa * (rm() ? 0.6 : 1);
    pillarMat.uniforms.uTime.value = T;
    // меч: появляется из трещины за 0,85 с до удара, разгоняется вниз, острие уходит в землю у Регента
    const fallT = 0.85, embed = s.ground - 1.2;
    if (T >= S - fallT) {
      sword.visible = true;
      const u = clamp((T - (S - fallT)) / fallT, 0, 1);
      const y0 = s.ground + RIFT_Y - 2, y = y0 + (embed - y0) * (u * u * u);   // ускорение
      sword.position.set(s.target.x, y, s.target.z);
      sword.rotation.set(0, T * 0.15, 0);
      const fade = 1 - smooth((T - (D - 0.55)) / 0.5);
      const appear = smooth((T - (S - fallT)) / 0.15);
      swordMat.uniforms.uAmt.value = appear * fade; guardMat.opacity = appear * fade;
      glowMat.uniforms.uAmt.value = appear * fade * (T >= S ? 1.3 - 0.5 * smooth((T - S) / 0.6) : 0.9);
      sword.scale.setScalar(1 + 0.08 * smooth((T - (D - 0.55)) / 0.5));
      // след падения: искры вдоль клинка
      if (k && T < S) {
        s.sparkAcc += dt * 70;
        const n = Math.floor(s.sparkAcc);
        if (n > 0) {
          s.sparkAcc -= n;
          TRAIL.at.x = s.target.x; TRAIL.at.y = y + SWORD_LEN * 0.5; TRAIL.at.z = s.target.z; TRAIL.count = n;
          k.emit(TRAIL);
        }
      }
    } else sword.visible = false;
    if (!s.struck && T >= S) strike();
    // ударные волны
    const u = T - S;
    const wa = waveA.material.uniforms, wb = waveB.material.uniforms;
    if (u >= 0) {
      wa.uR.value = 1 + 15 * smooth(u / 0.9); wa.uW.value = 0.4 + 0.4 * u; wa.uAmt.value = (1 - smooth(u / 0.95)) * 1.0;
      wb.uR.value = 0.5 + 22 * smooth(u / 0.5); wb.uW.value = 0.15; wb.uAmt.value = (1 - smooth(u / 0.5)) * 1.3;
    } else { wa.uAmt.value = 0; wb.uAmt.value = 0; }
    waveA.scale.setScalar(Math.max(1, wa.uR.value + wa.uW.value * 4)); waveB.scale.setScalar(Math.max(1, wb.uR.value + wb.uW.value * 4));
    // шейдер кольца считает радиус в единицах геометрии — переводим в доли масштаба
    wa.uR.value /= waveA.scale.x; wa.uW.value /= waveA.scale.x; wb.uR.value /= waveB.scale.x; wb.uW.value /= waveB.scale.x;
    // круг клятвы под героем: вспыхивает в начале, гаснет к удару
    const oa = oath.material.uniforms;
    oath.scale.setScalar(2.4);
    oa.uR.value = (0.55 + 0.1 * smooth(T / 0.6)); oa.uW.value = 0.035; oa.uAmt.value = smooth(T / 0.25) * (1 - smooth((T - S + 0.2) / 0.5)) * 1.2;
    // свет падает из трещины
    if (k && open > 0.3 && T < S + 0.4) {
      s.motesAcc += dt * 40 * open;
      const n = Math.floor(s.motesAcc);
      if (n > 0) {
        s.motesAcc -= n;
        MOTES.at.x = s.target.x; MOTES.at.y = s.ground + RIFT_Y - 1; MOTES.at.z = s.target.z; MOTES.count = n;
        k.emit(MOTES);
      }
    }
  }

  function reset() { s.active = false; s.t = 0; hideAll(); }
  function dispose() {
    reset();
    scene.remove(root);
    for (const d of disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    disposables.length = 0;
  }

  return {
    start, update, setQuality, reset, dispose,
    get active() { return s.active; },
    get struck() { return s.struck; },
    get group() { return root; },
  };
}
