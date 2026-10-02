// ASHEN OATH — modules/fx/sigilPillar.js. Владелец: №7 [VFX]. [W3-МАГИЯ]
// «Столп небес» (sigil_cast pillar): тучи над Регентом, столп света сверху, ветвящиеся молнии, кольцо пыли и камней.
//
// Ритм (время боевое, delay = d.delay ‖ 0.45 с — бой бьёт столпом ровно через delay):
//   t=0       у героя в точке сгустка (fx.shared.sigil.pos) — вертикальный разрыв-вспышка и «нить» света в небо;
//   0..delay  над целью на 6,5–7,5 м (в кадре камеры за спиной героя) закручиваются тучи: тёмное кольцо дыма вращается вокруг вертикальной оси и
//             стягивается к центру, внутри разгорается золотое пятно, вниз сыплются искры;
//   t=delay   столп света (свой меш-цилиндр, аддитивный шейдер: вертикальный градиент + бегущий вниз шум) бьёт
//             с неба до земли толщиной с Регента; вспышка в ядре, экран, свет, тряска; 3–6 ветвящихся молний
//             вокруг столпа, кольцо удара, пыль и камни по кругу, кратер; столп живёт 0.6–0.9 с и гаснет.
//   оглушение snap.boss.stunned после boss_stunned{source:'pillar'} — мягкое золотое свечение и кольцо искр
//             вокруг ядра Регента (молнии над оглушённым уже рисует runesFire.js).
// Соперник (d.remote): палитра rival, цель — наш герой, удар по своему таймеру (boss_stunned для него не придёт).
// d.reach === false: столп всё равно бьёт в точку цели, но без вспышки по ядру, хит-стопа и сочных искр.
// [W4-ЗАКЛИНАНИЯ] цвет — стихия героя (fx.heroEl/heroPal, st.ramp): свет столпа, пятно, искры, молнии, кольца, свечение
// оглушённого; у тьмы — фиолетовые тучи и чёрные струи внутри столпа (darkcore поверх света). Ядра белее, ореолы ярче.

import { clamp, easeOut, TAU, isNum, hasVec, rampOf } from './common.js';
import { FX_OUT, FX_NOISE, premulBlend, hexLin } from './glsl.js';

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const num = (v, f) => (isNum(v) ? v : f);

// ------------------------------------------------------------------ столп (свой меш)
// Открытый цилиндр 0..1 по высоте, масштаб (r, H, r). Свет «растёт» сверху вниз (uGrow), шум бежит вниз,
// ядро ярче в середине по экрану (|N·V| в горизонтальной плоскости), у земли — всплеск, к небу — растворение.
const VS_PILLAR = /* glsl */`
varying vec3 vW; varying vec3 vN; varying float vH;
void main() {
  vH = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const FS_PILLAR = /* glsl */`
uniform vec3 uCore; uniform vec3 uHot; uniform vec3 uCol;
uniform float uI; uniform float uTime; uniform float uGrow; uniform float uFade; uniform float uSeed; uniform float uH;
varying vec3 vW; varying vec3 vN; varying float vH;
${FX_NOISE}
void main() {
  float h = vH;
  float lead = 1.0 - uGrow;                       // фронт удара идёт сверху вниз
  float m = smoothstep(lead, lead + 0.035, h);
  if (m <= 0.001) discard;
  vec3 V = cameraPosition - vW;
  vec2 vh = normalize(V.xz + vec2(1e-5));
  vec2 nh = normalize(vN.xz + vec2(1e-5));
  float f = abs(dot(nh, vh));                     // 1 — середина столпа на экране, 0 — край
  float core = pow(f, 12.0);
  float body = pow(f, 2.2);
  float a = atan(vN.z, vN.x);
  float y = vW.y;
  float n1 = fxNoise3(vec3(cos(a) * 1.8, sin(a) * 1.8, y * 0.32 + uTime * 7.0 + uSeed));
  float n2 = fxNoise3(vec3(cos(a) * 4.5 + 3.1, sin(a) * 4.5, y * 0.11 + uTime * 2.6 - uSeed));
  float str = 0.45 + 0.9 * n1 * (0.4 + 0.6 * n2);
  float hm = h * uH;                              // метры от земли
  float base = 1.0 + 0.5 * exp(-hm * 0.9);        // всплеск у земли
  float top = 1.0 - smoothstep(0.72, 1.0, h);     // растворяется в тучах
  float head = exp(-abs(h - lead) * uH * 0.7) * step(0.002, lead + 0.002) * (1.0 - step(0.999, uGrow));
  vec3 col = uCore * (core * 1.0 + head * 0.8)
           + uHot * body * str * 0.35
           + uCol * (0.05 + 0.1 * n2) * body;
  col *= uI * uFade * m * top * base * (gl_FrontFacing ? 1.0 : 0.5);   // задняя стенка — вполсилы
  gl_FragColor = vec4(col, 0.0);
${FX_OUT}
}
`;

export function register(fx) {
  const THREE = fx.THREE;
  const V3 = THREE.Vector3;
  const kit = fx.kit;
  const UP = { x: 0, y: 1, z: 0 }, DOWN = { x: 0, y: -1, z: 0 };
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const qName = () => (kit.Q && kit.Q.name) || 'medium';
  const soft = () => { try { return fx.reduced() ? 0.6 : 1; } catch (e) { return 1; } };
  const audio = (n, p) => { try { if (fx.legacy && typeof fx.legacy.audio === 'function') fx.legacy.audio(n, p); } catch (e) { /* ignore */ } };
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- меш столпа: один на модуль, лениво
  let PIL = null, pilFailed = false;
  const lin = [0, 0, 0];
  const setC = (v, hex) => { hexLin((hex >>> 0) & 0xffffff, lin); v.set(lin[0], lin[1], lin[2]); };
  function ensurePillar() {
    if (PIL || pilFailed) return PIL;
    const root = kit.root;
    if (!root || typeof root.add !== 'function') { pilFailed = true; return null; }
    try {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 40, 1, true);
      geo.translate(0, 0.5, 0);
      const u = {
        uCore: { value: new V3(1, 1, 1) }, uHot: { value: new V3(1, 0.8, 0.4) }, uCol: { value: new V3(0.8, 0.4, 0.1) },
        uI: { value: 0 }, uTime: { value: 0 }, uGrow: { value: 0 }, uFade: { value: 1 }, uSeed: { value: 0 }, uH: { value: 12 },
      };
      const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS_PILLAR, fragmentShader: FS_PILLAR, side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE) });
      mat.depthWrite = false;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'fx-sigil-pillar'; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 25;
      mesh.matrixAutoUpdate = false; mesh.castShadow = false; mesh.receiveShadow = false;
      const p = { mesh, geo, mat, u, gen: 0, touch: 0 };
      // страховка: если актор погиб без end (kit.clear, выключение V6) — столп гаснет сам
      mesh.onBeforeRender = () => { if (nowMs() - p.touch > 250) { mesh.visible = false; u.uI.value = 0; } };
      root.add(mesh);
      PIL = p;
    } catch (e) { pilFailed = true; PIL = null; }
    return PIL;
  }
  const hidePillar = () => { if (PIL) { PIL.gen++; PIL.mesh.visible = false; PIL.u.uI.value = 0; } };

  // ---------------------------------------------------------------- предвыделенные опции (мутируем в кадре)
  // тучи: тёмное кольцо дыма, закрученное вокруг вертикальной оси через центр и стягивающееся внутрь
  const emCloud = { at: null, center: null, shape: 'ring', normal: UP, radius: 4, count: 1, speed: [0, 0.25], vel: { x: 0, y: -0.25, z: 0 },
    orbit: 1.7, rgrow: -0.22, life: [1.0, 1.5], size: [3.2, 4.6], sizeVar: 0.3, curve: 0.6, ramp: 'smoke', intensity: 1, alpha: 0.8,
    sprite: 'smoke', blend: 'alpha', turb: 0.3, spin: [-0.5, 0.5], fadeIn: 0.3, essential: true, rival: false };
  // золотое пятно внутри туч
  const emSpot = { at: null, center: null, shape: 'disk', normal: UP, radius: 1.4, count: 1, speed: [0, 0.2], orbit: 2.4,
    life: [0.25, 0.45], size: [1.6, 0.7], ramp: 'gold', intensity: 2.4, sprite: 'glow', fadeIn: 0.25, essential: true, rival: false };
  // искры, падающие из туч
  const emFall = { at: null, shape: 'disk', normal: UP, radius: 2.4, count: 1, dir: DOWN, cone: 0.12, speed: [5, 10],
    life: [0.9, 1.4], size: [0.09, 0.02], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.035, gravity: 5, drag: 0.2,
    ground: 0, essential: true, rival: false };
  // струи света вниз внутри столпа
  const emShaft = { at: null, to: null, shape: 'line', radius: 1, count: 1, dir: DOWN, cone: 0.02, speed: [14, 24],
    life: [0.14, 0.28], size: [0.3, 0.12], ramp: 'whiteHold', intensity: 3, sprite: 'streak', stretch: 0.05, fadeIn: 0.05,
    ground: 0, essential: true, rival: false };
  // брызги света у основания
  const emSplash = { at: null, shape: 'ring', normal: UP, radius: 2, count: 1, radial: 7, dir: UP, cone: 0.35, speed: [0.5, 3],
    life: [0.25, 0.5], size: [0.08, 0.015], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.04, gravity: 7, drag: 2.2,
    ground: 0, essential: true, rival: false };
  // свечение оглушённого Регента: вспышка-ореол и кольцо искр вокруг ядра
  const flGlow = { ramp: 'gold', size: [3.0, 4.0], curve: 0.6, dur: 0.32, intensity: 1.3, sprite: 'glow', pull: 0.9, fadeIn: 0.35 };
  const emHalo = { at: null, center: null, shape: 'ring', normal: UP, radius: 1.9, count: 1, speed: [0, 0.12], vel: { x: 0, y: 0.7, z: 0 },
    orbit: 2.3, life: [0.5, 0.85], size: [0.09, 0.02], ramp: 'gold', intensity: 2.6, sprite: 'spark', stretch: 0.02, fadeIn: 0.15,
    essential: true, rival: false };
  const emMote = { at: null, radius: 1.7, shape: 'shell', count: 1, speed: [0.1, 0.4], life: [0.6, 1.0], size: [0.32, 0.1],
    ramp: 'heal', intensity: 1.8, sprite: 'glow', gravity: -0.6, fadeIn: 0.3, essential: true, rival: false };
  const _b0 = new V3(), _b1 = new V3(), _gc = new V3();

  // ---------------------------------------------------------------- точка сгустка
  function sourcePoint(out, remote) {
    const sg = fx.shared && fx.shared.sigil;
    if (!remote && sg && hasVec(sg.pos) && isNum(sg.t) && kit.clock - sg.t < 0.6) return out.set(sg.pos.x, sg.pos.y, sg.pos.z);
    return fx.anchor('chest', out, remote);
  }

  // ---------------------------------------------------------------- 1. разрыв у героя и нить в небо
  function castRip(st) {
    const { src, P, R, rival, s } = st;
    const sf = soft();
    // [W4-ЗАКЛИНАНИЯ] стихия героя; белое ядро и ореол ярче
    kit.flash(src, { ramp: 'whiteHold', sprite: 'streak', rot: Math.PI / 2, size: [0.5, 2.6 * (0.7 + 0.3 * s)], curve: 0.4, dur: 0.24, intensity: 4.5 * sf, pull: 0.3, rival: R });
    kit.flash(src, { ramp: st.ramp, sprite: 'glow', size: [0.5, 1.8], dur: 0.32, intensity: 2.8 * sf, pull: 0.3, rival: R });
    kit.flash(src, { ramp: 'whiteHold', sprite: 'star', size: [0.3, 1.2], dur: 0.16, intensity: 3.8 * sf, pull: 0.35, rival: R });
    // вертикальная щель: искры вдоль короткой оси вверх-вниз
    kit.emit({ at: { x: src.x, y: src.y - 0.35, z: src.z }, shape: 'line', to: { x: src.x, y: src.y + 0.45, z: src.z }, radius: 0.03, count: 26 * (0.45 + 0.55 * s),
      speed: [0.6, 2.2], life: [0.18, 0.35], size: [0.06, 0.012], ramp: st.ramp, intensity: 3.2, sprite: 'spark', stretch: 0.03, drag: 3, rival: R });
    // нить вверх: частицы-струи
    kit.emit({ at: src, dir: UP, cone: 0.03, count: 22 * (0.45 + 0.55 * s), speed: [16, 26], life: [0.25, 0.45], size: [0.28, 0.1],
      ramp: 'whiteHold', intensity: 3, sprite: 'streak', stretch: 0.06, drag: 0.3, rival: R });
    if (fx.bolts) {
      try {
        _b1.set(src.x, src.y + 16, src.z);
        fx.bolts.strike({ from: src, to: _b1, color: P.hot, core: P.core, width: 0.035, jitter: 0.02, branches: 0, segments: 6,
          flicker: false, star: false, origin: false, dur: 0.32, intensity: 3, rival, seed: (Math.random() * 1e6) | 0 });
      } catch (e) { /* ignore */ }
    }
    kit.light(src, { color: P.hot, intensity: 0.8 * sf, range: 6, dur: 0.3, attack: 0.15 });
  }

  // ---------------------------------------------------------------- 2. тучи над целью
  function clouds(st) {
    const { sky, ground, P, R, rival, s, delay } = st;
    const ramp = st.ramp;                                  // [W4-ЗАКЛИНАНИЯ] стихия героя / rival
    const lowQ = qName() === 'low';
    // сбор туч: первая партия кольца дыма с разбросом старта
    kit.emit({ at: sky, center: sky, shape: 'ring', normal: UP, radius: 5.2 * s, count: 22 * (0.45 + 0.55 * st.power), speed: [0, 0.3],
      vel: { x: 0, y: -0.2, z: 0 }, orbit: 1.5, rgrow: -0.18, life: [1.1, 1.6], size: [3.4 * s, 4.8 * s], sizeVar: 0.3, curve: 0.6,
      ramp: st.cloud, intensity: 1, alpha: 0.8, sprite: 'smoke', blend: 'alpha', turb: 0.3, spin: [-0.5, 0.5], fadeIn: 0.35, delay: delay * 0.5 });
    // разгорающееся золотое пятно: одна вспышка, растёт до удара
    kit.flash(sky, { ramp, size: [1.2, 6.5 * s], curve: 1.6, dur: delay + 0.12, intensity: 2.4 * soft(), sprite: 'glow', pull: 0, fadeIn: 0.6, rival: R });
    if (!lowQ && fx.glyph) {
      try { fx.glyph.spawn({ pos: { x: sky.x, y: sky.y - 0.4, z: sky.z }, normal: UP, radius: 3.6 * s, symbol: 'storm', symbolScale: 0.5, style: 'sigil', color: P.mid, hot: P.core, intensity: 1.6, dur: delay + 0.55, unfold: Math.max(0.15, delay * 0.6), fade: 0.35, spin: 1.8, rings: 2, ticks: 24, rival }); } catch (e) { /* ignore */ }
    }
    const dur = delay + 0.9;
    kit.actor({
      dur,
      update(t, k, dt) {
        if (!(dt > 0)) return;
        const pre = clamp(t / Math.max(0.05, delay), 0, 1);
        const out = t > delay ? clamp((t - delay) / (dur - delay), 0, 1) : 0;
        const dc = decor();
        // тёмное кольцо — гуще к удару, после удара рассеивается
        st.accC += dt * (lowQ ? 14 : 26) * dc * (0.5 + 0.5 * pre) * (1 - out);
        let n = Math.floor(st.accC);
        if (n > 0) {
          st.accC -= n;
          emCloud.at = sky; emCloud.center = sky; emCloud.count = n; emCloud.radius = (4.6 - 1.4 * pre) * s; emCloud.ramp = st.cloud;
          emCloud.size[0] = 3.2 * s; emCloud.size[1] = 4.6 * s; emCloud.orbit = 1.4 + 1.6 * pre; emCloud.rgrow = out > 0 ? 0.25 : -0.22;
          kit.emit(emCloud);
        }
        // золотое пятно — до удара разгорается, после — гаснет
        st.accS += dt * 30 * dc * (out > 0 ? (1 - out) * 0.6 : 0.3 + pre);
        n = Math.floor(st.accS);
        if (n > 0) {
          st.accS -= n;
          emSpot.at = sky; emSpot.center = sky; emSpot.count = n; emSpot.ramp = ramp; emSpot.rival = R;
          emSpot.radius = (0.8 + 1.0 * pre) * s; emSpot.intensity = (1.6 + 1.4 * pre) * soft();
          kit.emit(emSpot);
        }
        // искры падают вниз
        st.accF += dt * 34 * dc * (0.3 + pre) * (1 - out);
        n = Math.floor(st.accF);
        if (n > 0) {
          st.accF -= n;
          emFall.at = sky; emFall.count = n; emFall.ramp = ramp; emFall.rival = R; emFall.ground = ground.y + 0.03; emFall.radius = 2.4 * s;
          kit.emit(emFall);
        }
      },
    });
  }

  // ---------------------------------------------------------------- 3. удар столпа
  function pillarMesh(st) {
    const p = ensurePillar();
    if (!p) return;
    const { ground, sky, P, s, R } = st;
    const gen = ++p.gen, u = p.u;
    const H = Math.max(4, sky.y - ground.y + 0.6);
    const r0 = st.radius;
    setC(u.uCore.value, P.core); setC(u.uHot.value, P.hot); setC(u.uCol.value, P.mid);
    u.uSeed.value = Math.random() * 10; u.uH.value = H; u.uGrow.value = 0; u.uFade.value = 1;
    const mesh = p.mesh;
    mesh.position.set(ground.x, ground.y - 0.05, ground.z);
    mesh.scale.set(r0, H, r0); mesh.updateMatrix();
    const life = 0.6 + 0.3 * st.power;
    const I = (0.58 + 0.28 * st.power) * soft() * (R ? 0.7 : 1);   // [W4-ЗАКЛИНАНИЯ] ядро столпа ярче (+15%)
    const red = fx.reduced();
    p.touch = nowMs(); mesh.visible = true;
    kit.actor({
      dur: life,
      update(t, k, dt) {
        if (p.gen !== gen) return false;
        const grow = easeOut(t / 0.07);
        const out = k > 0.5 ? Math.pow((k - 0.5) / 0.5, 1.3) : 0;
        const punch = Math.exp(-t * 9);
        const flick = red ? 1 : 0.92 + 0.08 * Math.sin(t * 61) * Math.sin(t * 27);
        // толщина: удар чуть шире, к концу столп «истончается»
        const r = r0 * (1 + 0.22 * punch) * (1 - 0.55 * out);
        mesh.scale.set(r, H, r); mesh.updateMatrix();
        u.uGrow.value = grow; u.uFade.value = (1 - out) * flick;
        u.uI.value = I * (1 + 0.4 * punch);
        u.uTime.value = kit.clock;
        p.touch = nowMs(); mesh.visible = true;
        if (!(dt > 0) || grow < 0.6) return;
        const dc = decor();
        // струи света вниз
        st.accSh += dt * (qName() === 'low' ? 30 : 60) * dc * (1 - out);
        let n = Math.floor(st.accSh);
        if (n > 0) {
          st.accSh -= n;
          emShaft.at = sky; emShaft.to = ground; emShaft.count = n; emShaft.radius = r * 0.7; emShaft.ground = ground.y + 0.05; emShaft.rival = R;
          emShaft.ramp = st.shaft; emShaft.blend = st.shaftBlend;   // [W4-ЗАКЛИНАНИЯ] у тьмы — чёрные струи
          kit.emit(emShaft);
        }
        // брызги у основания
        st.accSp += dt * 70 * dc * (1 - out) * (0.5 + 0.5 * punch);
        n = Math.floor(st.accSp);
        if (n > 0) {
          st.accSp -= n;
          _b0.set(ground.x, ground.y + 0.12, ground.z);
          emSplash.at = _b0; emSplash.count = n; emSplash.radius = r; emSplash.ramp = st.ramp; emSplash.rival = R; emSplash.ground = ground.y + 0.03;
          kit.emit(emSplash);
        }
      },
      end() { if (p.gen === gen) { mesh.visible = false; u.uI.value = 0; } },
    });
  }

  function strike(st) {
    const { sky, ground, tgt, P, R, rival, s, power, reach } = st;
    const sf = soft();
    const q = qName(), lowQ = q === 'low';
    const ramp = st.ramp;                                  // [W4-ЗАКЛИНАНИЯ] стихия героя / rival
    const gp = { x: ground.x, y: ground.y + 0.12, z: ground.z };
    const rr = st.radius;
    pillarMesh(st);
    // разрыв туч и вспышка в ядре
    // [W4-ЗАКЛИНАНИЯ] белое ядро удара и ореолы ярче (читается с проектора)
    kit.flash(sky, { ramp, size: [3, 8 * s], dur: 0.4, intensity: 2.6 * sf, sprite: 'glow', pull: 0, rival: R });
    kit.flash(gp, { ramp: 'whiteHold', size: [0.8, 2.8 * s], dur: 0.2, intensity: 3.2 * sf, sprite: 'star', pull: 0.8, rival: R });
    kit.flash(gp, { ramp, size: [1.4, 3.8 * s], dur: 0.4, intensity: 1.5 * sf, sprite: 'glow', pull: 0.8, rival: R });
    if (reach) {
      // сочный удар по цели: звезда в ядре, искры с тела
      kit.flash(tgt, { ramp: 'whiteHold', size: [0.8, 3.2 * s], dur: 0.22, intensity: 3.6 * sf, sprite: 'star', pull: 0.9, rival: R });
      kit.emit({ at: tgt, radius: 0.6, count: 70 * (0.45 + 0.55 * power), speed: [4, 12], life: [0.3, 0.8], size: [0.07, 0.014], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.04, gravity: 6, drag: 1.5, ground: ground.y + 0.03, rival: R });
    }
    kit.screenFlash(R ? 0xb49cff : P.core, (R ? 0.08 : 0.1 + 0.1 * power) * sf, 0.12);   // [W4-ЗАКЛИНАНИЯ] тон ядра стихии
    kit.light(gp, { color: P.hot, intensity: 0.8 + 0.3 * power, range: 12 + 4 * power, dur: 0.6, attack: 0.03 });
    kit.shake((R ? 0.18 : 0.24 + 0.22 * power) * (reach ? 1 : 0.7));
    if (reach) kit.hitstop(R ? 30 : 40 + 35 * power);
    // ветвящиеся молнии с неба вокруг столпа
    if (fx.bolts) {
      const nB = lowQ ? 3 : q === 'medium' ? (power > 0.65 ? 5 : 4) : (power > 0.5 ? 6 : 5);
      const a0 = Math.random() * TAU;
      for (let i = 0; i < nB; i++) {
        const a = a0 + (i / nB) * TAU + rnd(-0.35, 0.35);
        const fr = rnd(2.2, 4.2) * s, tr = rr * rnd(1.25, 2.6);
        const fx0 = sky.x + Math.cos(a) * fr, fz0 = sky.z + Math.sin(a) * fr, fy0 = sky.y + rnd(-0.6, 0.6);
        const a2 = a + rnd(-0.5, 0.5);
        const tx = ground.x + Math.cos(a2) * tr, tz = ground.z + Math.sin(a2) * tr;
        const ty = fx.groundY(tx, tz, ground.y);
        const at = i < 2 ? 0 : rnd(0.04, 0.32);
        const go = () => {
          if (!fx.bolts) return;
          _b0.set(fx0, fy0, fz0); _b1.set(tx, ty, tz);
          try {
            fx.bolts.strike({ from: _b0, to: _b1, color: P.hot, core: P.core, width: rnd(0.06, 0.1) * (0.8 + 0.2 * s), branches: lowQ ? 3 : 5, jitter: 0.14, segments: 20,
              dur: rnd(0.35, 0.5), intensity: 3.6, lift: 0.3, rival, seed: (Math.random() * 1e6) | 0 });
          } catch (e) { /* ignore */ }
          kit.flash(_b1, { ramp: 'whiteHold', size: [0.4, 1.8], dur: 0.16, intensity: 3.4 * sf, sprite: 'star', pull: 0.3, rival: R });
        };
        if (at <= 0) go(); else kit.after(at, go);
      }
      if (!lowQ) { try { fx.bolts.groundArcs({ center: ground, radius: rr * 2.2, count: q === 'high' ? 10 : 8, dur: 0.65, color: P.hot, core: P.core, intensity: 2.8, rival }); } catch (e) { /* ignore */ } }
    }
    // кольцо удара по земле и в небе
    if (fx.shock) {
      try { fx.shock.ring({ pos: { x: ground.x, y: ground.y + 0.05, z: ground.z }, r0: rr * 0.6, r1: (6 + 2 * power) * s, dur: 0.6, intensity: 2.2, thickness: 0.3, dustAmount: 2, wall: lowQ ? 0 : 1.3, color: P.mid, hot: P.core, rival }); } catch (e) { /* ignore */ }
      try { fx.shock.ring({ pos: sky, normal: UP, r0: 1, r1: 7 * s, dur: 0.5, intensity: 1.6, thickness: 0.25, dustAmount: 0.4, wall: 0, distort: 0.3, color: P.mid, hot: P.core, rival }); } catch (e) { /* ignore */ }
    }
    // пыль и камни по кругу
    const sp = 0.45 + 0.55 * power;
    kit.emit({ at: gp, shape: 'ring', normal: UP, radius: rr * 0.9, count: 30 * sp, radial: 6.5, speed: [0, 0.4], dir: UP, cone: 0.3, life: [0.9, 1.6], size: [1.4 * s, 3.2 * s],
      ramp: 'dust', intensity: 1, alpha: 0.8, sprite: 'smoke', blend: 'alpha', drag: 2.2, gravity: -0.25, spin: [-0.6, 0.6], fadeIn: 0.15 });
    kit.emit({ at: gp, shape: 'disk', normal: UP, radius: rr * 0.85, count: 26 * sp, dir: UP, cone: 0.75, speed: [4, 9], radial: 3, life: [0.8, 1.4], size: [0.18, 0.12], sizeVar: 0.5,
      ramp: 'stone', intensity: 1, sprite: 'debris', blend: 'alpha', gravity: 15, drag: 0.4, ground: ground.y + 0.04, spin: [-6, 6] });
    kit.emit({ at: gp, shape: 'ring', normal: UP, radius: rr, count: 46 * sp, radial: 9, dir: UP, cone: 0.5, speed: [1, 5], life: [0.3, 0.7], size: [0.08, 0.015],
      ramp, intensity: 3, sprite: 'spark', stretch: 0.04, gravity: 8, drag: 2, ground: ground.y + 0.03, rival: R });
    if (!lowQ) {
      // тлеющие золотые искры поднимаются над кратером
      kit.emit({ at: gp, shape: 'disk', normal: UP, radius: rr * 1.1, count: 30 * sp, dir: UP, cone: 0.4, speed: [0.4, 1.4], life: [0.8, 1.6], size: [0.06, 0.012],
        ramp, intensity: 2.4, sprite: 'ember', turb: 0.4, gravity: -0.5, drag: 0.8, delay: 0.5, rival: R });
    }
    // кратер и трещины
    if (fx.decals) {
      const PD = P;
      try { fx.decals.spawn({ pos: ground, radius: rr * 1.15, kind: 'crater', life: 7, rot: Math.random() * TAU, color: PD.mid, hot: PD.core, intensity: 1.1, rival }); } catch (e) { /* ignore */ }
      if (!lowQ) { try { fx.decals.spawn({ pos: ground, radius: rr * 2.1, kind: 'crack', life: 6, rot: Math.random() * TAU, color: PD.mid, hot: PD.core, intensity: 1.2, rival }); } catch (e) { /* ignore */ } }
    }
    audio('nova', gp);
  }

  // ---------------------------------------------------------------- событие каста
  fx.on('sigil_cast', (ev, d) => {
    const R = fx.isRemote(d);
    const rival = R ? 1 : 0;
    const el = fx.heroEl(d);                               // [W4-ЗАКЛИНАНИЯ] стихия героя (соперник — 'rival')
    const P = fx.pal(el, d);
    const power = clamp(num(d.power, 0.6), 0, 1);
    const delay = clamp(num(d.delay, 0.45), 0.05, 3);
    const reach = d.reach !== false;
    // цель: свой — ядро Регента (lockTarget), соперник — наш герой
    const tgt = fx.target(new V3(), R);
    const ground = fx.targetGround(new V3(), R);
    if (!R && !reach && hasVec(d.to)) {
      // промах (дальше 30 м): столп бьёт в точку прицела
      tgt.set(d.to.x, d.to.y, d.to.z);
      ground.set(d.to.x, fx.groundY(d.to.x, d.to.z, d.to.y - 2.2), d.to.z);
    }
    const s = (R ? 0.62 : 1) * (0.8 + 0.2 * power);
    const st = {
      R, rival, P, power, delay, reach, s,
      radius: (1.6 + 0.6 * power) * (R ? 0.6 : 1),
      src: sourcePoint(new V3(), R), tgt, ground,
      sky: new V3(ground.x, ground.y + (R ? 6 : 6.6 + 0.8 * power), ground.z),
      accC: 0, accS: 0, accF: 0, accSh: 0, accSp: 0,
      // [W4-ЗАКЛИНАНИЯ] градиенты: искры/свет — стихия, тучи и струи столпа (у тьмы — фиолетовый дым и чёрные струи)
      ramp: rampOf(el, R), cloud: el === 'void' ? 'voidsmoke' : 'smoke',
      shaft: el === 'void' ? 'darkcore' : 'whiteHold', shaftBlend: el === 'void' ? 'alpha' : 'add',
    };
    const sg = fx.shared && fx.shared.sigil;
    if (!R && sg && typeof sg === 'object') sg.release = 'pillar';
    castRip(st);
    clouds(st);
    kit.after(delay, () => strike(st));
    return true;
  }, (d) => d && d.sigil === 'pillar');

  // ---------------------------------------------------------------- 4. оглушённый Регент светится
  let glowOn = false, glowT0 = 0, glowDur = 1.2, glowAccF = 0, glowAccS = 0, glowAccM = 0;
  fx.on('boss_stunned', (ev, d) => {
    if (fx.isRemote(d)) return;
    glowOn = true; glowT0 = kit.clock; glowDur = Math.max(0.2, num(d.duration, 1.2));
    glowAccF = 1; glowAccS = 0; glowAccM = 0;
    flGlow.ramp = emHalo.ramp = emMote.ramp = rampOf(fx.heroEl(d), false);   // [W4-ЗАКЛИНАНИЯ] свечение в цвете героя
    // без return true: событие остаётся открытым для остальных слоёв
  }, (d) => d && d.source === 'pillar');

  fx.every((dt, snap) => {
    if (!glowOn) return;
    const b = snap && snap.boss;
    const age = kit.clock - glowT0;
    if (!b || snap.mode === 'pvp' || (!b.stunned && age > 0.15) || age > glowDur + 0.6) { glowOn = false; return; }
    if (!(dt > 0)) return;
    fx.target(_gc, false);
    const rem = isNum(b.stunRemaining) && b.stunRemaining > 0 ? clamp(b.stunRemaining / glowDur, 0, 1) : clamp(1 - age / glowDur, 0, 1);
    const kk = (0.35 + 0.65 * rem) * soft();
    const dc = decor();
    // мягкий ореол: вспышка раз в ~0.12 с (без стробоскопа — длинная жизнь, плавное появление)
    glowAccF += dt;
    if (glowAccF >= 0.12) {
      glowAccF = 0;
      flGlow.intensity = 2.1 * kk;   // [W4-ЗАКЛИНАНИЯ] ореол ярче
      kit.flash(_gc, flGlow);
    }
    // кольцо искр вокруг ядра поднимается и вращается
    glowAccS += dt * 36 * dc * kk;
    let n = Math.floor(glowAccS);
    if (n > 0) {
      glowAccS -= n;
      _b0.set(_gc.x, _gc.y - 1.4, _gc.z);
      emHalo.at = _b0; emHalo.center = _gc; emHalo.count = n;
      kit.emit(emHalo);
    }
    // тёплые пылинки по оболочке
    glowAccM += dt * 14 * dc * kk;
    n = Math.floor(glowAccM);
    if (n > 0) {
      glowAccM -= n;
      emMote.at = _gc; emMote.count = n;
      kit.emit(emMote);
    }
  });

  fx.onClear(() => {
    hidePillar();
    glowOn = false; glowAccF = 0; glowAccS = 0; glowAccM = 0;
  });
  fx.onDispose(() => {
    if (!PIL) return;
    const p = PIL; PIL = null;
    try { p.mesh.onBeforeRender = () => {}; if (p.mesh.parent) p.mesh.parent.remove(p.mesh); } catch (e) { /* ignore */ }
    try { p.geo.dispose(); p.mat.dispose(); } catch (e) { /* ignore */ }
  });
}
