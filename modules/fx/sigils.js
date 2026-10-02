// ASHEN OATH — modules/fx/sigils.js. Владелец: №7 [VFX].
// Печати двумя руками и базовые приёмы — хореография V6 (ритм как в runesFire.js):
//   ✋✋ ХЛОПОК  — громовой хлопок между ладонями, огромная ударная волна по земле, стена пыли, трещины; оглушение — треск на цели;
//   ⛩ ВРАТА    — золотой знак врат поднимается перед героем и раскрывается в шестигранный купол (fx.hex), мигает в конце;
//   ⌖ РАМКА    — тонкий луч от ладони к цели, прицел-рамка «защёлкивается» на ядре и медленно вращается, пока цель помечена;
//   ▲ ДЕЛЬТА   — треугольник света между ладонями, затем толстый луч (белое ядро + янтарная оболочка), удары-пульсы на цели;
//   ♥ КОР      — сердце из золотого света над героем, удар «сердцебиения», оболочка оберега, тёплый свет;
//   искра (стрелка-игла со следом), рассечение (серп клинка в духе BDO), нова (золотая волна), удары сферы/призмы (доп. слои).
// Луч и серп — свои лёгкие меши (по одному draw call на видимый луч/серп), всё остальное — kit/glyph/shock/decals/trails.

import { caster, runeCircle, gather, decal, trail, rampOf, clamp, easeOut, TAU, isNum, hasVec } from './common.js';
import { FX_OUT, FX_NOISE, premulBlend, hexLin } from './glsl.js';

const raw = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ------------------------------------------------------------------ луч и серп (свои меши)
// Луч: лента от A к B, всегда развёрнута к камере; ядро/оболочка/бегущие бусины — в шейдере.
const VS_BEAM = /* glsl */`
uniform vec3 uA; uniform vec3 uB; uniform float uW; uniform float uGrow; uniform float uTail;
varying vec2 vQ; varying float vLen;
void main() {
  float t = position.y + 0.5;
  float s = position.x * 2.0;
  float tt = mix(uTail, uGrow, t);
  vec3 ax = uB - uA; float L = length(ax);
  ax = L > 1e-4 ? ax / L : vec3(0.0, 1.0, 0.0);
  vec3 P = uA + ax * (L * tt);
  vec3 side = cross(ax, cameraPosition - P);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  P += side * s * uW;
  vQ = vec2(tt, s); vLen = L;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;
const FS_BEAM = /* glsl */`
uniform vec3 uCol; uniform vec3 uHot; uniform vec3 uCore;
uniform float uI; uniform float uTime; uniform float uSeed; uniform float uCoreW; uniform float uPulse; uniform float uFlow;
varying vec2 vQ; varying float vLen;
${FX_NOISE}
void main() {
  float t = vQ.x, s = abs(vQ.y), d = t * vLen;
  float n1 = fxNoise2(vec2(d * 1.1 - uTime * 15.0 * uFlow, vQ.y * 1.3 + uSeed));
  float n2 = fxNoise2(vec2(d * 3.3 - uTime * 29.0 * uFlow, vQ.y * 3.5 - uSeed));
  float wob = 0.72 + 0.4 * n1;
  float core = exp(-pow(s / max(0.02, uCoreW * (0.8 + 0.35 * n2) * (1.0 + 0.6 * uPulse)), 2.0));
  float sheath = exp(-pow(s / (0.6 * wob), 2.0));
  float halo = exp(-s * 2.6) * 0.3;
  float beads = pow(0.5 + 0.5 * sin(d * 4.2 - uTime * 38.0 * uFlow), 8.0) * sheath;
  float ends = smoothstep(0.0, 0.035, t) * (1.0 - smoothstep(0.975, 1.0, t));
  vec3 col = uCore * core * (2.2 + uPulse * 2.5)
           + uHot * (sheath * (0.45 + 0.55 * n2) + beads * 0.8)
           + uCol * (sheath * 0.45 + halo);
  col *= uI * ends;
  gl_FragColor = vec4(col, 0.0);
${FX_OUT}
}
`;
// Серп клинка: сектор кольца вокруг груди, окно «хвост → голова» бежит по дуге; кромка раскалена.
const VS_ARC = /* glsl */`
uniform vec3 uC; uniform float uA0; uniform float uSpan; uniform float uR0; uniform float uR1;
uniform float uY0; uniform float uY1; uniform float uDrop;
varying vec2 vQ;
void main() {
  float u = position.x + 0.5, v = position.y + 0.5;
  float a = uA0 + uSpan * u;
  float r = mix(uR0, uR1, v);
  vec3 P = uC + vec3(sin(a) * r, mix(uY0, uY1, u) + (1.0 - v) * uDrop, cos(a) * r);
  vQ = vec2(u, v);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}
`;
const FS_ARC = /* glsl */`
uniform vec3 uCol; uniform vec3 uHot; uniform vec3 uCore;
uniform float uI; uniform float uHead; uniform float uTailW; uniform float uTime; uniform float uFade;
varying vec2 vQ;
${FX_NOISE}
void main() {
  float u = vQ.x, v = vQ.y;
  float w = (u - (uHead - uTailW)) / max(uTailW, 1e-3);   // 0 — хвост, 1 — голова
  if (w <= 0.0 || w >= 1.0) discard;
  float th = 0.1 + 0.9 * pow(w, 0.85);                     // серп толще у головы
  float e = 1.0 - v;                                        // 0 — внешняя кромка клинка
  float body = 1.0 - smoothstep(th * 0.55, th, e);
  if (body <= 0.001) discard;
  float rim = exp(-e * 15.0 / (0.35 + 0.65 * w));
  float str = 0.6 + 0.4 * fxNoise2(vec2(u * 5.0 - uTime * 3.0, v * 24.0));
  float head = smoothstep(0.8, 0.97, w) * (1.0 - smoothstep(0.97, 1.0, w));
  float fall = pow(w, 1.5);
  vec3 col = uCore * (rim * 1.9 * fall + head * body * 1.3)
           + uHot * body * str * (0.2 + 0.85 * fall) * (1.0 - e * 0.55)
           + uCol * body * 0.4 * fall;
  col *= uI * uFade * smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.93, 1.0, u));
  gl_FragColor = vec4(col, 0.0);
${FX_OUT}
}
`;

function createStrips(fx) {
  const THREE = fx.THREE, kit = fx.kit, root = kit && kit.root;
  if (!THREE || !root || typeof root.add !== 'function') return null;
  const V3 = THREE.Vector3;
  const CAP = 3;
  const pools = { beam: [], arc: [] };
  let gBeam = null, gArc = null;
  const lin = [0, 0, 0];
  const setC = (v, hex) => { hexLin((hex >>> 0) & 0xffffff, lin); v.set(lin[0], lin[1], lin[2]); };
  function make(kind) {
    const u = {
      uCol: { value: new V3() }, uHot: { value: new V3() }, uCore: { value: new V3() },
      uI: { value: 0 }, uTime: { value: 0 }, uFade: { value: 1 },
    };
    let vs, fs, geo;
    if (kind === 'beam') {
      Object.assign(u, { uA: { value: new V3() }, uB: { value: new V3(0, 1, 0) }, uW: { value: 0.2 }, uCoreW: { value: 0.2 }, uGrow: { value: 1 }, uTail: { value: 0 }, uPulse: { value: 0 }, uSeed: { value: 0 }, uFlow: { value: 1 } });
      vs = VS_BEAM; fs = FS_BEAM;
      geo = gBeam || (gBeam = new THREE.PlaneGeometry(1, 1, 1, 12));
    } else {
      Object.assign(u, { uC: { value: new V3() }, uA0: { value: 0 }, uSpan: { value: 1 }, uR0: { value: 1 }, uR1: { value: 2 }, uY0: { value: 0 }, uY1: { value: 0 }, uDrop: { value: 0 }, uHead: { value: 0 }, uTailW: { value: 0.7 } });
      vs = VS_ARC; fs = FS_ARC;
      geo = gArc || (gArc = new THREE.PlaneGeometry(1, 1, 36, 4));
    }
    const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: vs, fragmentShader: fs, side: THREE.DoubleSide, depthTest: true, fog: false, ...premulBlend(THREE) });
    mat.depthWrite = false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx-sigil-' + kind; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 24;
    mesh.matrixAutoUpdate = false; mesh.castShadow = false; mesh.receiveShadow = false;
    const s = { kind, mesh, mat, u, busy: false, touch: 0, gen: 0 };
    // страховка: если актор погиб без end (kit.clear, выключение V6) — лента гаснет сама
    mesh.onBeforeRender = () => { if (nowMs() - s.touch > 250) { mesh.visible = false; u.uI.value = 0; } };
    root.add(mesh);
    pools[kind].push(s);
    return s;
  }
  function acquire(kind) {
    const list = pools[kind], t = nowMs();
    let s = null;
    for (let i = 0; i < list.length; i++) if (!list[i].busy || t - list[i].touch > 600) { s = list[i]; break; }
    if (!s && list.length < CAP) { try { s = make(kind); } catch (e) { return null; } }
    if (!s) { for (let i = 0; i < list.length; i++) if (!s || list[i].touch < s.touch) s = list[i]; }
    if (!s) return null;
    s.busy = true; s.touch = t; s.gen++;
    return s;
  }
  const release = (s, gen) => { if (s.gen === gen) { s.busy = false; s.mesh.visible = false; s.u.uI.value = 0; } };

  /**
   * Луч. o: { ends(a, b) — заполняет концы каждый кадр, dur, grow, fade, width, coreW, color, hot, core, intensity, flow,
   *   onFrame(t, dt, a, b, ctl) }. Возвращает ctl { alive, until, pulse, t } — pulse/until можно менять снаружи.
   */
  function beam(o) {
    const s = acquire('beam');
    if (!s) return null;
    const gen = s.gen, u = s.u;
    setC(u.uCol.value, o.color); setC(u.uHot.value, o.hot); setC(u.uCore.value, o.core);
    u.uCoreW.value = o.coreW || 0.22; u.uSeed.value = Math.random() * 10; u.uPulse.value = 0; u.uFlow.value = o.flow || 1;
    u.uGrow.value = 0; u.uTail.value = 0;
    const W = o.width || 0.2, I = o.intensity || 1.5, grow = o.grow || 0.08, fade = o.fade || 0.15;
    const ctl = { alive: true, until: o.dur || 0.5, pulse: 0, t: 0 };
    const red = fx.reduced();
    kit.actor({
      dur: 12,
      update(t, k, dt) {
        if (s.gen !== gen) return false;
        ctl.t = t;
        o.ends(u.uA.value, u.uB.value);
        const out = t > ctl.until ? clamp((t - ctl.until) / fade, 0, 1) : 0;
        if (out >= 1) return false;
        u.uGrow.value = easeOut(t / grow);
        u.uTail.value = out * out;                             // хвост догоняет цель — луч «уходит» в неё
        ctl.pulse *= Math.exp(-dt * 10);
        u.uPulse.value = ctl.pulse;
        const flick = red ? 1 : 0.94 + 0.06 * Math.sin(t * 57) * Math.sin(t * 23);
        u.uW.value = W * (1 + 0.45 * ctl.pulse) * flick * (1 - 0.5 * out);
        u.uI.value = I * (1 + 0.5 * ctl.pulse) * (1 - 0.4 * out);
        u.uTime.value = kit.clock;
        s.touch = nowMs(); s.mesh.visible = true;
        if (o.onFrame) o.onFrame(t, dt, u.uA.value, u.uB.value, ctl);
        return true;
      },
      end() { release(s, gen); ctl.alive = false; },
    });
    return ctl;
  }

  /**
   * Серп. o: { center, a0, span, r0, r1, y0, y1, drop, dur, tail, color, hot, core, intensity, onFrame(k, headU, dt) }.
   */
  function crescent(o) {
    const s = acquire('arc');
    if (!s) return null;
    const gen = s.gen, u = s.u;
    setC(u.uCol.value, o.color); setC(u.uHot.value, o.hot); setC(u.uCore.value, o.core);
    u.uC.value.set(o.center.x, o.center.y, o.center.z);
    u.uA0.value = o.a0; u.uSpan.value = o.span; u.uR0.value = o.r0; u.uR1.value = o.r1;
    u.uY0.value = o.y0; u.uY1.value = o.y1; u.uDrop.value = o.drop || 0;
    const tail = o.tail || 0.75, dur = o.dur || 0.3, I = o.intensity || 1.6;
    u.uTailW.value = tail; u.uHead.value = 0;
    kit.actor({
      dur,
      update(t, k, dt) {
        if (s.gen !== gen) return false;
        const hk = 1 - Math.pow(1 - k, 2.3);                  // быстрый взмах, мягкий уход хвоста
        u.uHead.value = hk * (1 + tail);
        u.uFade.value = 1 - clamp((k - 0.55) / 0.45, 0, 1);
        u.uI.value = I;
        u.uTime.value = kit.clock;
        s.touch = nowMs(); s.mesh.visible = true;
        if (o.onFrame) o.onFrame(k, Math.min(1, u.uHead.value), dt);
        return true;
      },
      end() { release(s, gen); },
    });
    return true;
  }
  return { beam, crescent };
}

// ------------------------------------------------------------------ хореографии
export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const UP = { x: 0, y: 1, z: 0 };
  let strips = null;
  try { strips = createStrips(fx); } catch (e) { strips = null; }

  const au = (name, p) => { try { if (fx.legacy && fx.legacy.audio) fx.legacy.audio(name, p); } catch (e) { /* ignore */ } };
  const glyph = (o) => { if (!fx.glyph) return null; try { return fx.glyph.spawn(o); } catch (e) { return null; } };
  const gOk = (g, gen) => !!(g && g.alive && g.gen === gen);
  // ударная волна по земле/в воздухе: shock → старое кольцо effects.js (только по земле)
  function ring(pos, r0, r1, dur, P, R, o) {
    o = o || {};
    if (fx.shock) {
      try { fx.shock.ring({ pos, normal: o.normal, r0, r1, dur, color: P.mid, hot: P.core, intensity: o.intensity || 2, thickness: o.thickness, distort: o.distort, rival: R ? 1 : 0 }); return; } catch (e) { /* ignore */ }
    }
    if (o.normal && Math.abs(o.normal.y) < 0.7) return;
    const L = fx.legacy;
    if (L && L.ring) { try { L.ring(pos, r0, r1, dur, raw(P.mid), raw(P.core), o.opacity || 0.85, 3); } catch (e) { /* ignore */ } }
  }
  function wall(pos, r0, r1, h, dur, P, op) {
    if (fx.shock) return;  // у shock есть своё марево; старую стену рисуем только без него
    const L = fx.legacy;
    if (L && L.wall) { try { L.wall(pos, r0, r1, h, dur, raw(P.mid), op); } catch (e) { /* ignore */ } }
  }
  function sphere(pos, r0, r1, dur, P, R, o) {
    if (!fx.shock) return false;
    try { fx.shock.sphere({ pos, r0, r1, dur, color: P.hot, hot: P.core, intensity: (o && o.intensity) || 1.2, distort: (o && o.distort) ?? 1, rival: R ? 1 : 0 }); return true; } catch (e) { return false; }
  }
  const distort = (p, s) => { if (kit.distort) { try { kit.distort(p, s); } catch (e) { /* ignore */ } } };
  // оси экрана (правая/верхняя) из камеры
  const _cr = new V3(), _cu = new V3();
  function camAxes() {
    const cam = kit.camera;
    if (cam && cam.matrixWorld) { const e = cam.matrixWorld.elements; _cr.set(e[0], e[1], e[2]); _cu.set(e[4], e[5], e[6]); }
    else { _cr.set(1, 0, 0); _cu.set(0, 1, 0); }
  }

  // ============================================================ ✋✋ ХЛОПОК
  // Громовой хлопок: белая звезда между ладонями (подтянута к камере), разряд между руками, огромная волна по земле,
  // стена пыли наружу, трещины; оглушение — вспышка и треск разрядов на цели.
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, rival = c.rival;
    const P = fx.pal('storm', d);
    const ramp = rampOf('storm', R);
    const rad = clamp(isNum(d.radius) ? d.radius : 7, 2, 14);
    const mid = new V3().addVectors(c.hand, c.handL).multiplyScalar(0.5);
    if (mid.distanceTo(c.chest) > 0.9) mid.copy(c.chest);
    mid.addScaledVector(c.fwd, 0.25);
    const g = { x: c.feet.x, y: c.feet.y + 0.05, z: c.feet.z };
    // хлопок
    kit.flash(mid, { color: P.core, size: [0.25, 1.2], dur: 0.13, intensity: 5, sprite: 'star', pull: 0.7, rival: R });
    kit.flash(mid, { color: P.hot, size: [0.4, 1.2], dur: 0.32, intensity: 2.2, sprite: 'glow', pull: 0.7, rival: R });
    kit.flash(mid, { color: P.mid, size: [0.3, 1.15], dur: 0.22, intensity: 2, sprite: 'ring', pull: 0.7, rival: R });
    kit.emit({ at: mid, count: 26, speed: [3, 9], life: [0.12, 0.3], size: [0.06, 0.01], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, drag: 3.5, rival: R, essential: true });
    if (fx.bolts) {
      try {
        fx.bolts.arc({ from: c.hand, to: c.handL, color: P.mid, core: P.core, dur: 0.2, rate: 35, intensity: 2.6, rival });
        fx.bolts.arc({ from: c.handL, to: c.hand, color: P.mid, core: P.core, dur: 0.14, rate: 35, intensity: 2.2, rival });
      } catch (e) { /* ignore */ }
    }
    sphere(mid, 0.1, 1.1, 0.22, P, R, { intensity: 0.8 });
    distort(mid, 0.7);
    // знак под ногами
    runeCircle(fx, c, 'clap', 'storm', { radius: 1.9, dur: 1.3, spin: 1.8, motes: 18 });
    // ударная волна
    ring(g, 0.4, rad, 0.55, P, R, { intensity: 1.9, thickness: 0.18, distort: 1 });
    kit.after(0.07, () => ring(g, 0.3, rad * 0.6, 0.45, P, R, { intensity: 1.2, thickness: 0.14 }));
    wall(g, 0.4, rad, 1.0, 0.5, P, 0.3);
    // кромка волны: искры по земле наружу
    kit.emit({ at: { x: g.x, y: g.y + 0.12, z: g.z }, shape: 'ring', radius: 0.5, normal: UP, count: 56, radial: rad * 2.1, speed: [0, 0.5], dir: UP, cone: 0.25, life: [0.3, 0.5], size: [0.1, 0.02], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, drag: 2.2, rival: R, essential: true });
    // стена пыли: клубы по кругу, разлетаются и оседают (≤3.5 м — не наезжает на камеру)
    kit.emit({ at: { x: g.x, y: g.y + 0.2, z: g.z }, shape: 'ring', radius: 0.7, normal: UP, count: 44, radial: 11, speed: [0, 0.8], dir: UP, cone: 0.5, life: [0.6, 1.1], size: [0.45, 1.3], ramp: 'dust', alpha: 0.75, sprite: 'smoke', blend: 'alpha', drag: 3.2, gravity: -0.35, turb: 0.4, spin: [-1, 1] });
    kit.emit({ at: { x: g.x, y: g.y + 0.1, z: g.z }, shape: 'ring', radius: 0.6, normal: UP, count: 18, radial: 7, speed: [1.5, 3.5], dir: UP, cone: 0.6, life: [0.5, 0.9], size: [0.05, 0.03], ramp: 'stone', sprite: 'debris', blend: 'alpha', gravity: 9, drag: 1, ground: g.y + 0.02, spin: [-6, 6] });
    decal(fx, g, 'crack', 2.4, 'storm', R, { life: 6 });
    kit.light(mid, { color: P.hot, intensity: 1.6, range: 12, dur: 0.4, attack: 0.03 });
    kit.screenFlash(R ? 0xc8b4ff : 0xe6f4ff, 0.1, 0.1);
    kit.shake(0.32); kit.kick(UP, 0.02); kit.hitstop(35);
    // оглушение цели
    if (d.stunned) {
      const tg = c.target;
      kit.after(0.08, () => {
        kit.flash(tg, { color: P.core, size: [0.6, 2.6], dur: 0.2, intensity: 4.5, sprite: 'star', pull: 0.8, rival: R });
        kit.flash(tg, { color: P.mid, size: [1, 3.2], dur: 0.45, intensity: 2, sprite: 'glow', pull: 0.8, rival: R });
        kit.emit({ at: tg, radius: 0.3, count: 28, speed: [2, 7], life: [0.25, 0.6], size: [0.06, 0.012], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, gravity: 4, drag: 2, rival: R, essential: true });
        if (fx.bolts) {
          for (let i = 0; i < 3; i++) {
            const a1 = Math.random() * TAU, a2 = a1 + 1.4 + Math.random() * 2;
            try {
              fx.bolts.arc({
                from: { x: tg.x + Math.cos(a1) * 0.9, y: tg.y + (Math.random() - 0.5) * 1.4, z: tg.z + Math.sin(a1) * 0.9 },
                to: { x: tg.x + Math.cos(a2) * 0.9, y: tg.y + (Math.random() - 0.5) * 1.4, z: tg.z + Math.sin(a2) * 0.9 },
                color: P.mid, core: P.core, dur: 0.3, rate: 28, intensity: 2.6, width: 0.03, rival,
              });
            } catch (e) { /* ignore */ }
          }
        }
        kit.light(tg, { color: P.hot, intensity: 1.2, range: 10, dur: 0.35, attack: 0.05 });
      });
    }
    au('nova', mid);
    return true;
  }, (d) => d.sigil === 'clap');

  // ============================================================ ⛩ ВРАТА (бастион)
  // [W3-МАГИЯ] Каст «Врат бури» рисует sigilGate.js (стоит в CHOREO раньше и возвращает true); знак врат ниже —
  // запасной путь (если sigilGate упал). Шестигранный купол fx.hex живёт по снимку (bastion), мигает последние 1.2 с,
  // звенит от ударов. Момент своего каста — fx.shared.gateCastAt (пишет sigilGate.js, здесь — запасной путь):
  // раскрытие купола ждёт 0.4 с, пока вспыхнет разрыв.
  const useHex = !!fx.hex;
  if (useHex) fx.suppress('dome');
  const gateAt = () => (isNum(fx.shared.gateCastAt) ? fx.shared.gateCastAt : -1e9);
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, rival = c.rival;
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя (было золото)
    const ramp = rampOf(fx.heroEl(d), R);          // [W4-ЗАКЛИНАНИЯ]
    if (!R) fx.shared.gateCastAt = kit.clock;
    const gp = new V3().copy(c.feet).addScaledVector(c.fwd, 1.05);
    const y0 = c.feet.y + 0.25, y1 = c.feet.y + 1.2;
    gp.y = y0;
    const gh = glyph({
      pos: gp, normal: c.fwd, up: UP, radius: 0.95, symbol: 'gate', symbolScale: 0.62, style: 'sigil',
      color: P.mid, hot: P.core, intensity: 2.6, dur: 1.05, unfold: 0.22, fade: 0.45, spin: 0.7, rings: 2, ticks: 24, rival,
    });
    const ggen = gh ? gh.gen : -1;
    const setP = { pos: gp };
    const moteO = { at: gp, shape: 'ring', radius: 0.8, normal: c.fwd, count: 2, speed: [0.2, 0.8], dir: UP, cone: 0.4, life: [0.4, 0.8], size: [0.06, 0.01], ramp, intensity: 2.6, sprite: 'spark', stretch: 0.02, gravity: -0.5, drag: 1, rival: R };
    kit.actor({
      dur: 0.42,
      update(t, k) {
        gp.y = y0 + (y1 - y0) * easeOut(k);
        gp.x = c.feet.x + c.fwd.x * 1.05; gp.z = c.feet.z + c.fwd.z * 1.05;
        if (gOk(gh, ggen)) gh.set(setP);
        kit.emit(moteO);
        return true;
      },
      end() {
        if (gOk(gh, ggen)) { gh.flare(1); gh.fadeOut(0.5); }
        // вспышка раскрытия + искры по оболочке купола
        kit.flash(gp, { color: P.core, size: [0.4, 1.4], dur: 0.2, intensity: 4, sprite: 'star', pull: 0.4, rival: R });
        kit.flash(gp, { color: P.hot, size: [0.6, 1.5], dur: 0.4, intensity: 2, sprite: 'glow', pull: 0.4, rival: R });
        const hc = { x: c.feet.x, y: c.feet.y + 0.2, z: c.feet.z };
        kit.emit({ at: hc, shape: 'shell', radius: 1.5, count: 50, radial: -0.4, speed: [0.1, 0.5], life: [0.4, 0.8], size: [0.07, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.02, drag: 1.5, rival: R, essential: true });
        kit.emit({ at: gp, count: 24, speed: [2, 5], life: [0.25, 0.5], size: [0.06, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, drag: 2.5, rival: R, essential: true });
        ring({ x: c.feet.x, y: c.feet.y + 0.05, z: c.feet.z }, 0.3, 2.3, 0.55, P, R, { intensity: 2 });
        kit.light(hc, { color: P.hot, intensity: 1.1, range: 9, dur: 0.6, attack: 0.1 });
        kit.kick(UP, 0.012);
      },
    });
    // золотые «створки» — столб искр вокруг героя и кольцо у ног
    kit.emit({ at: { x: c.feet.x, y: c.feet.y + 0.1, z: c.feet.z }, shape: 'ring', radius: 1.4, normal: UP, count: 34, dir: UP, cone: 0.25, speed: [1.5, 3.5], life: [0.6, 1.1], size: [0.06, 0.01], ramp, intensity: 2.6, sprite: 'spark', stretch: 0.025, gravity: -0.4, drag: 1.2, rival: R });
    wall(c.feet, 0.3, 1.4, 2.2, 0.6, P, 0.3);
    kit.light(c.chest, { color: P.hot, intensity: 0.7, range: 7, dur: 0.5, attack: 0.3 });
    au('shieldUp', c.chest);
    return true;
  }, (d) => d.sigil === 'gate');

  // купол по снимку (свой — snap.player.bastion; соперника — snap.opponent.bastion, если есть)
  const domes = [
    { h: null, open: 0, want: false, startAt: 0, remote: false },
    { h: null, open: 0, want: false, startAt: 0, remote: true },
  ];
  const domeState = { pos: { x: 0, y: 0, z: 0 }, radius: 1.55, open: 0, yaw: 0, intensity: 1 };
  const _df = new V3(), _dp = new V3();
  function domeTick(D, dt, want, left) {
    if (want && !D.want) {
      // раскрытие ждёт подъёма знака врат (если его только что сотворили)
      const gc = gateAt(), ago = kit.clock - gc;
      D.startAt = !D.remote && ago >= 0 && ago < 0.5 ? gc + 0.4 : kit.clock;
    }
    D.want = want;
    if (want && !D.h && fx.hex) {
      const P = D.remote ? E.rival : fx.heroPal(null);   // [W4-ЗАКЛИНАНИЯ] купол в цвете героя
      try { D.h = fx.hex.create({ kind: 'dome', color: P.mid, hot: P.core, rival: D.remote ? 1 : 0 }); } catch (e) { D.h = null; }
      D.open = 0;
    }
    if (!D.h) return;
    const target = want && kit.clock >= D.startAt ? 1 : 0;
    D.open += (target - D.open) * (1 - Math.exp(-dt * (target ? 9 : 6)));
    if (!want && D.open < 0.02) {
      try { if (D.h.dispose) D.h.dispose(); } catch (e) { /* ignore */ }
      D.h = null; D.open = 0; return;
    }
    fx.anchor('feet', _dp, D.remote);
    fx.facing(_df, D.remote);
    domeState.pos.x = _dp.x; domeState.pos.y = _dp.y; domeState.pos.z = _dp.z;
    domeState.open = clamp(D.open, 0, 1);
    domeState.yaw = Math.atan2(_df.x, _df.z);
    let blink = 1;
    if (want && isNum(left) && left > 0 && left < 1.2) blink = fx.reduced() ? 0.75 + 0.25 * Math.cos(left * 5) : 0.55 + 0.45 * Math.cos(kit.clock * 17);
    domeState.intensity = (0.5 + 0.1 * Math.sin(kit.clock * 2.2)) * blink;
    try { D.h.setState(domeState); } catch (e) { /* ignore */ }
    if (D.h.alive === false) D.h = null;
  }
  fx.on('block', (ev, d) => {
    if (!d || !d.bastion) return;
    const D = domes[d.remote ? 1 : 0];
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя
    const p = fx.evPos(ev, new V3());
    if (D.h && p) { try { D.h.hit({ point: p, strength: 1 }); } catch (e) { /* ignore */ } }
    if (p) {
      kit.flash(p, { color: P.core, size: [0.3, 1.2], dur: 0.16, intensity: 3.6, sprite: 'star', pull: 0.3, rival: !!d.remote });
      kit.emit({ at: p, count: 16, speed: [2, 6], life: [0.2, 0.45], size: [0.06, 0.01], ramp: rampOf(fx.heroEl(d), d.remote), intensity: 3, sprite: 'spark', stretch: 0.025, gravity: 3, drag: 2, rival: !!d.remote, essential: true });   // [W4-ЗАКЛИНАНИЯ]
    }
  });

  // ============================================================ ⌖ РАМКА (метка цели)
  // Тонкий луч света от ладони к цели → рамка-прицел (hex + символ frame) «защёлкивается» с большого радиуса,
  // уголки вспыхивают; пока цель помечена — прицел медленно вращается на ядре цели.
  const useMark = !!fx.glyph;
  if (useMark) fx.suppress('mark');
  const mark = { g: null, gen: -1, until: 0, t0: -1e9, snapping: false };
  const _mt = new V3();
  const markSet = { intensity: 1.6, radius: 1.35 };
  const followTarget = () => fx.target(_mt, false);
  function spawnReticle(r0) {
    const P = fx.heroPal(null);                    // [W4-ЗАКЛИНАНИЯ] цвет героя
    const g = glyph({
      pos: fx.target(_mt, false), billboard: true, radius: r0, symbol: 'frame', symbolScale: 0.92, style: 'hex',
      color: P.mid, hot: P.core, intensity: 2.2, dur: Infinity, unfold: 0.12, spin: 0.35, rings: 2, ticks: 36, follow: followTarget,
    });
    mark.g = g; mark.gen = g ? g.gen : -1;
    return g;
  }
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя
    const ramp = rampOf(fx.heroEl(d), R);          // [W4-ЗАКЛИНАНИЯ]
    const dur = isNum(d.duration) ? clamp(d.duration, 0.5, 30) : 6;
    // тонкий луч ладонь → цель
    if (strips) {
      strips.beam({
        ends: (a, b) => { fx.anchor('handR', a, R); fx.target(b, R); },
        dur: 0.22, grow: 0.09, fade: 0.28, width: 0.05, coreW: 0.4, color: P.mid, hot: P.hot, core: P.core, intensity: 1.6, flow: 0.6,
      });
    }
    kit.emit({ at: c.hand, shape: 'line', to: c.target, count: 20, speed: [0, 0.3], life: [0.2, 0.45], size: [0.06, 0.01], ramp, intensity: 2.6, sprite: 'spark', rival: R, essential: true });
    kit.flash(c.hand, { color: P.core, size: [0.12, 0.5], dur: 0.12, intensity: 3.5, sprite: 'star', pull: 0.6, rival: R });
    const tg = c.target;
    if (!R) {
      if (gOk(mark.g, mark.gen)) mark.g.fadeOut(0.15);
      const g = useMark ? spawnReticle(2.8) : null;
      const gen = g ? g.gen : -1;
      mark.until = kit.clock + dur; mark.t0 = kit.clock; mark.snapping = true;
      const rs = { radius: 2.8, intensity: 2.6 };
      kit.actor({
        dur: 0.17,
        update(t, k) { if (gOk(g, gen)) { rs.radius = 2.8 - 1.45 * easeOut(k); g.set(rs); } return true; },
        end() {
          mark.snapping = false;
          if (gOk(g, gen)) { rs.radius = 1.35; g.set(rs); g.flare(1); }
          fx.target(_mt, false);
          kit.flash(_mt, { color: P.core, size: [0.5, 2.2], dur: 0.16, intensity: 4, sprite: 'star', pull: 0.8 });
          kit.flash(_mt, { color: P.hot, size: [0.8, 2.6], dur: 0.35, intensity: 1.8, sprite: 'glow', pull: 0.8 });
          // уголки рамки: короткие вспышки и искры, «щелчок» к центру
          camAxes();
          for (let i = 0; i < 4; i++) {
            const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
            const cx = _mt.x + (_cr.x * sx + _cu.x * sy) * 0.95, cy = _mt.y + (_cr.y * sx + _cu.y * sy) * 0.95, cz = _mt.z + (_cr.z * sx + _cu.z * sy) * 0.95;
            const cp = { x: cx, y: cy, z: cz };
            kit.flash(cp, { color: P.core, size: [0.2, 0.7], dur: 0.14, intensity: 3.6, sprite: 'star', pull: 0.8 });
            kit.emit({ at: cp, count: 4, dir: { x: _mt.x - cx, y: _mt.y - cy, z: _mt.z - cz }, cone: 0.3, speed: [3, 5], life: [0.1, 0.18], size: [0.07, 0.02], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, drag: 8, essential: true });
          }
          kit.light(_mt, { color: P.hot, intensity: 1, range: 10, dur: 0.35, attack: 0.05 });
          kit.shake(0.05);
        },
      });
    } else {
      // соперник пометил нас: знак рамки на земле под героем (не заслоняет обзор)
      const gg = fx.anchor('feet', new V3(), false);
      glyph({ pos: { x: gg.x, y: gg.y + 0.04, z: gg.z }, radius: 1.25, symbol: 'frame', symbolScale: 0.8, style: 'hex', color: P.mid, hot: P.core, intensity: 1.8, dur, unfold: 0.2, spin: -0.5, rings: 2, ticks: 36, rival: 1, follow: () => fx.anchor('feet', gg, false) });
      kit.flash(tg, { color: P.core, size: [0.3, 1.2], dur: 0.16, intensity: 3, sprite: 'star', pull: 0.6, rival: true });
    }
    au('cast', c.hand);
    return true;
  }, (d) => d.sigil === 'frame');

  // ============================================================ ▲ ДЕЛЬТА (луч)
  // Треугольник света между ладонями (глиф delta + три звезды на вершинах + грани из искр), затем толстый луч
  // грудь → цель ~1 с: белое ядро, янтарная оболочка, бегущие кольца; каждый sigil_hit — пульс удара на цели.
  const beams = [null, null];
  const bStreak = { at: null, to: null, shape: 'line', dir: null, cone: 0.01, count: 2, speed: [16, 24], life: [0.05, 0.09], size: [0.16, 0.06], ramp: 'whiteHold', intensity: 4, sprite: 'streak', stretch: 0.03, rival: false };
  const bSheath = { at: null, to: null, shape: 'line', radius: 0.1, count: 1, speed: [0.1, 0.5], life: [0.1, 0.18], size: [0.42, 0.2], ramp: 'gold', intensity: 2.2, sprite: 'glow', rival: false };
  const bRing = { at: null, dir: null, cone: 0, count: 1, speed: [20, 20], life: [0.3, 0.3], size: [0.7, 0.45], ramp: 'gold', intensity: 2.6, sprite: 'ring', rival: false, essential: true };
  const bSplash = { at: null, radius: 0.12, dir: null, cone: 1.1, count: 1, speed: [2, 7], life: [0.15, 0.35], size: [0.06, 0.01], ramp: 'gold', intensity: 3.2, sprite: 'spark', stretch: 0.03, gravity: 5, drag: 2, rival: false };
  const bFlash = { color: 0, size: [0.35, 0.75], dur: 0.06, intensity: 3, sprite: 'glow', pull: 0.6, rival: false };
  const _bd = new V3();
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote, rival = c.rival;
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя
    const ramp = rampOf(fx.heroEl(d), R);          // [W4-ЗАКЛИНАНИЯ]
    const ticks = isNum(d.ticks) ? clamp(Math.round(d.ticks), 1, 12) : 4;
    const beamDur = 0.25 + ticks * 0.21;
    const o = new V3().copy(c.chest).addScaledVector(c.dir, 0.45);
    // треугольник: вершины в плоскости, перпендикулярной лучу
    const rx = c.right.x, rz = c.right.z;
    const vtx = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + i * TAU / 3;
      vtx.push({ x: o.x + rx * Math.cos(a) * 0.5, y: o.y + Math.sin(a) * 0.5, z: o.z + rz * Math.cos(a) * 0.5 });
    }
    const gh = glyph({ pos: o, normal: c.dir, up: UP, radius: 0.62, symbol: 'delta', symbolScale: 0.7, style: 'sigil', color: P.mid, hot: P.core, intensity: 2.6, dur: beamDur + 0.35, unfold: 0.14, fade: 0.3, spin: 1.2, rings: 2, ticks: 18, rival });
    if (gh) kit.after(0.1, () => gh.flare && gh.flare(1));
    for (let i = 0; i < 3; i++) {
      const A = vtx[i], B = vtx[(i + 1) % 3];
      kit.flash(A, { color: P.core, size: [0.12, 0.55], dur: 0.35, intensity: 3.6, sprite: 'star', pull: 0.6, rival: R });
      kit.emit({ at: A, shape: 'line', to: B, count: 10, speed: [0, 0.15], life: [0.25, 0.5], size: [0.09, 0.02], ramp, intensity: 3, sprite: 'glow', fadeIn: 0.3, rival: R, essential: true });
    }
    gather(fx, o, fx.heroEl(d), R, { time: 0.13, radius: 0.9, count: 28, glow: 0.7, essential: true });   // [W4-ЗАКЛИНАНИЯ]
    kit.light(o, { color: P.hot, intensity: 0.8, range: 7, dur: 0.3, attack: 0.5 });
    for (const e of [bStreak, bSheath, bRing, bSplash]) e.rival = R;
    const slot = R ? 1 : 0;
    kit.after(0.12, () => {
      if (!strips) return;
      bSheath.ramp = bRing.ramp = bSplash.ramp = ramp;
      bFlash.color = P.hot; bFlash.rival = R;
      let ringAcc = 0, flAcc = 0;
      const ctl = strips.beam({
        ends: (a, b) => { fx.anchor('chest', a, R); fx.target(b, R); _bd.subVectors(b, a).normalize(); a.addScaledVector(_bd, 0.45); },
        dur: beamDur, grow: 0.07, fade: 0.14, width: 0.36, coreW: 0.2, color: P.mid, hot: P.hot, core: P.core, intensity: 1.7,
        onFrame(t, dt, a, b) {
          _bd.subVectors(b, a);
          const L = Math.max(0.5, _bd.length());
          _bd.multiplyScalar(1 / L);
          bStreak.at = a; bStreak.to = b; bStreak.dir = _bd; kit.emit(bStreak);
          bSheath.at = a; bSheath.to = b; kit.emit(bSheath);
          ringAcc += dt; flAcc += dt;
          if (ringAcc > 0.09) {
            ringAcc = 0;
            bRing.at = a; bRing.dir = _bd; bRing.speed[0] = bRing.speed[1] = L / 0.3; kit.emit(bRing);
          }
          if (flAcc > 0.05) { flAcc = 0; kit.flash(a, bFlash); }
          bSplash.at = b; bSplash.dir = _bd; _bd.negate(); kit.emit(bSplash); _bd.negate();
        },
      });
      beams[slot] = ctl;
      kit.light(c.target, { color: P.hot, intensity: 1.2, range: 12, dur: beamDur, attack: 0.1, follow: () => fx.target(_mt, R) });
      kit.kick(c.dir, 0.02);
    });
    au('cast', c.chest);
    return true;
  }, (d) => d.sigil === 'delta');

  fx.on('sigil_hit', (ev, d) => {
    const R = fx.isRemote(d);
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя
    const ramp = rampOf(fx.heroEl(d), R);          // [W4-ЗАКЛИНАНИЯ]
    const p = fx.evPos(ev, new V3()) || fx.target(new V3(), R);
    const ctl = beams[R ? 1 : 0];
    if (ctl && ctl.alive) { ctl.pulse = 1; ctl.until = Math.max(ctl.until, ctl.t + 0.18); }
    const src = hasVec(d.from) ? d.from : fx.anchor('chest', new V3(), R);
    const back = { x: src.x - p.x, y: src.y - p.y, z: src.z - p.z };
    const last = isNum(d.index) && d.index >= 3;
    kit.flash(p, { color: P.core, size: [0.5, last ? 2.6 : 1.9], dur: 0.13, intensity: 5, sprite: 'star', pull: 0.8, rival: R });
    kit.flash(p, { color: P.hot, size: [0.8, last ? 3 : 2.3], dur: 0.28, intensity: 2, sprite: 'glow', pull: 0.8, rival: R });
    kit.emit({ at: p, dir: back, cone: 1.1, count: last ? 30 : 20, speed: [3, 9], life: [0.2, 0.5], size: [0.07, 0.012], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.035, gravity: 6, drag: 1.8, rival: R, essential: true });
    ring(p, 0.2, last ? 1.6 : 1.1, 0.26, P, R, { normal: back, intensity: 1.5, thickness: 0.14 });
    if (last) { distort(p, 0.5); kit.shake(0.14); }
    kit.shake(0.06); kit.hitstop(20);
    return true;
  }, (d) => d.sigil === 'delta');

  // ============================================================ ♥ КОР (лечение + оберег)
  // Сердце из золотого света над героем рисуется от выемки к острию обеими половинами, затем «удар сердца»
  // разбрасывает искры наружу; круг с символом cor, оболочка оберега, тёплый свет, искры поднимаются от ног.
  fx.on('sigil_cast', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.heroPal(d);                       // [W4-ЗАКЛИНАНИЯ] цвет героя
    const ramp = rampOf(fx.heroEl(d), R);          // [W4-ЗАКЛИНАНИЯ]
    camAxes();
    const hc = new V3().copy(c.head); hc.y += 0.62;
    const S = 0.034;   // масштаб кривой (x ∈ ±16 → ±0.54 м)
    const N = 22;
    const hp = { x: 0, y: 0, z: 0 };
    const heartO = { at: hp, count: 2, radius: 0.02, speed: [0.02, 0.12], life: [0.9, 1.25], size: [0.15, 0.03], ramp, intensity: 3, sprite: 'glow', fadeIn: 0.25, at0: 0, rival: R, essential: true };
    const beatO = { at: hp, dir: null, cone: 0.25, count: 1, speed: [1.2, 2.4], life: [0.35, 0.6], size: [0.07, 0.01], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.02, drag: 2, at0: 0.5, rival: R, essential: true };
    const bd = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * Math.PI;
      const x = 16 * Math.pow(Math.sin(s), 3);
      const y = 13 * Math.cos(s) - 5 * Math.cos(2 * s) - 2 * Math.cos(3 * s) - Math.cos(4 * s) + 2.5;
      for (let side = -1; side <= 1; side += 2) {
        if (i === 0 && side > 0) continue;
        if (i === N && side > 0) continue;
        hp.x = hc.x + _cr.x * x * S * side + _cu.x * y * S;
        hp.y = hc.y + _cr.y * x * S * side + _cu.y * y * S;
        hp.z = hc.z + _cr.z * x * S * side + _cu.z * y * S;
        heartO.at0 = i * 0.012; kit.emit(heartO);
        if (i % 2 === 0) {
          bd.x = hp.x - hc.x; bd.y = hp.y - hc.y; bd.z = hp.z - hc.z;
          beatO.dir = bd; kit.emit(beatO);
        }
      }
    }
    // удар сердца: вспышка в центре
    kit.flash(hc, { color: P.core, size: [0.3, 1.3], dur: 0.25, intensity: 3.2, sprite: 'star', pull: 0.5, rival: R, delay: 0.48 });
    kit.flash(hc, { color: P.hot, size: [0.6, 1.5], dur: 0.6, intensity: 1.6, sprite: 'glow', pull: 0.5, rival: R, delay: 0.3 });
    runeCircle(fx, c, 'cor', fx.heroEl(d), { radius: 1.6, dur: 2.0, spin: 0.6, motes: 22 });   // [W4-ЗАКЛИНАНИЯ]
    // оберег: оболочка и кольцо
    kit.after(0.5, () => {
      if (!sphere(c.chest, 0.5, 1.35, 0.55, P, R, { intensity: 1.1, distort: 0.3 })) {
        kit.flash(c.chest, { color: P.hot, size: [1.2, 1.5], dur: 0.45, intensity: 1.1, sprite: 'ring', pull: 0.2, rival: R });
      }
      ring({ x: c.feet.x, y: c.feet.y + 0.05, z: c.feet.z }, 0.3, 2.4, 0.8, P, R, { intensity: 1.6 });
      kit.light(hc, { color: P.hot, intensity: 1.1, range: 9, dur: 0.7, attack: 0.1 });
    });
    kit.emit({ at: { x: c.feet.x, y: c.feet.y + 0.1, z: c.feet.z }, shape: 'disk', radius: 1.1, normal: UP, count: 30, dir: UP, cone: 0.3, speed: [0.6, 1.6], life: [0.9, 1.6], size: [0.06, 0.01], ramp: R ? 'rival' : 'heal', intensity: 2.4, sprite: 'spark', stretch: 0.015, gravity: -0.4, drag: 0.6, turb: 0.3, delay: 0.5, rival: R });
    kit.light(c.chest, { color: P.hot, intensity: 0.8, range: 8, dur: 0.6, attack: 0.4 });
    au('cast', c.chest);
    return true;
  }, (d) => d.sigil === 'cor');

  // ============================================================ ИСКРА (базовый выстрел)
  // Щелчок у правой ладони, раскалённая янтарная игла с коротким энергетическим следом, чёткий удар.
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d);
    const el = fx.heroEl(d), P = fx.pal(el, d), sr = rampOf(el, R);   // [W4-ЗАКЛИНАНИЯ] цвет героя
    if (!R) { sparkRamp = sr; sparkPal = P; }                          // [W4-ЗАКЛИНАНИЯ] палитра летящих искр — один раз на выстрел
    const p = fx.evPos(ev, new V3());
    const hand = p && p.y > fx.groundY(p.x, p.z, 0) + 0.4 ? p : fx.anchor('handR', new V3(), R);
    const dir = hasVec(d.velocity) ? d.velocity : null;
    kit.flash(hand, { ramp: 'whiteHold', size: [0.1, 0.55], dur: 0.08, intensity: 4.2, sprite: 'star', pull: 0.6, rival: R });   // [W4-ЗАКЛИНАНИЯ] белое ядро
    kit.flash(hand, { ramp: sr, size: [0.2, 0.7], dur: 0.13, intensity: 2.4, sprite: 'glow', pull: 0.6, rival: R });           // [W4-ЗАКЛИНАНИЯ] ореол стихии
    kit.emit({ at: hand, dir, cone: dir ? 0.5 : Math.PI, count: 4, speed: [3, 7], life: [0.1, 0.22], size: [0.05, 0.01], ramp: sr, intensity: 3.2, sprite: 'spark', stretch: 0.025, drag: 3, rival: R, essential: true });
    au('cast', hand);
    return true;
  }, (d) => d.ability === 'spark');

  fx.suppress('proj:spark');
  const sparks = new Map();   // id → { gen, tr }
  let sparkGen = 0;
  let sparkRamp = rampOf(fx.heroEl(null), false), sparkPal = fx.heroPal(null);   // [W4-ЗАКЛИНАНИЯ] цвет героя (обновляется при выстреле)
  // [W4-ЗАКЛИНАНИЯ] размеры искры ×1.3: голова, игла, осыпь, след
  const sHead = { at: null, count: 1, speed: [0, 0.1], life: [0.05, 0.06], size: [0.44, 0.16], ramp: 'gold', intensity: 3.2, sprite: 'glow', essential: true, rival: false };
  const sNeedle = { at: null, dir: null, cone: 0.01, count: 1, speed: [10, 12], life: [0.04, 0.05], size: [0.17, 0.1], ramp: 'whiteHold', intensity: 5, sprite: 'streak', stretch: 0.03, drag: 20, essential: true, rival: false };
  const sShed = { at: null, count: 1, radius: 0.05, speed: [0.3, 1.2], life: [0.12, 0.25], size: [0.065, 0.013], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.015, drag: 2, gravity: 2, rival: false };
  const _sp = new V3(), _sv = new V3();
  function drawSparks(snap) {
    sparkGen++;
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const pr = list[i];
        if (!pr || pr.kind !== 'spark' || !hasVec(pr.position)) continue;
        const id = pr.id == null ? '' : String(pr.id);
        if (id.startsWith('caret:')) continue;               // иглы «Карет» рисует их руна
        const R = !!(pr.remote || pr.owner === 'opponent');
        _sp.set(pr.position.x, pr.position.y, pr.position.z);
        if (hasVec(pr.velocity)) _sv.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else _sv.set(0, 0, -1);
        const v = _sv.length();
        const ramp = R ? 'rival' : sparkRamp;        // [W4-ЗАКЛИНАНИЯ] цвет героя
        sHead.at = _sp; sHead.ramp = ramp; sHead.rival = R; kit.emit(sHead);
        if (v > 0.1) {
          _sv.multiplyScalar(1 / v);
          sNeedle.at = _sp; sNeedle.dir = _sv; sNeedle.rival = R; sNeedle.speed[0] = v * 0.4; sNeedle.speed[1] = v * 0.5;
          sNeedle.stretch = clamp(0.5 / Math.max(1, v * 0.45), 0.004, 0.05);
          kit.emit(sNeedle);
        }
        sShed.at = _sp; sShed.ramp = ramp; sShed.rival = R; kit.emit(sShed);
        let e = sparks.get(id);
        if (!e) {
          const P = R ? E.rival : sparkPal;          // [W4-ЗАКЛИНАНИЯ] цвет героя; след шире ×1.3
          e = { gen: 0, tr: trail(fx, 'gold', R, { style: 'energy', width: 0.12, life: 0.12, intensity: 2.6, taper: 1, maxPoints: 14, color: P.mid, hot: P.core }) };
          sparks.set(id, e);
        }
        e.gen = sparkGen;
        if (e.tr) { try { e.tr.push(_sp); } catch (err) { e.tr = null; } }
      }
    }
    if (sparks.size) {
      for (const [id, e] of sparks) {
        if (e.gen === sparkGen) continue;
        if (e.tr) { try { e.tr.stop(); } catch (err) { /* ignore */ } }
        sparks.delete(id);
      }
    }
  }

  fx.on('projectile_impact', (ev, d) => {
    const R = fx.isRemote(d);
    const el = fx.heroEl(d), P = fx.pal(el, d);   // [W4-ЗАКЛИНАНИЯ] цвет героя (вспышки — по градиентам: hex-строки kit кончаются)
    const ramp = rampOf(el, R);                    // [W4-ЗАКЛИНАНИЯ]
    const p = fx.evPos(ev, new V3());
    if (!p) return;
    const back = hasVec(d.direction) ? { x: -d.direction.x, y: -d.direction.y, z: -d.direction.z } : null;
    kit.flash(p, { ramp: 'whiteHold', size: [0.25, 1.25], dur: 0.1, intensity: 5, sprite: 'star', pull: 0.7, rival: R });   // [W4-ЗАКЛИНАНИЯ]
    kit.flash(p, { ramp, size: [0.35, 1.5], dur: 0.2, intensity: 2.6, sprite: 'glow', pull: 0.7, rival: R });              // [W4-ЗАКЛИНАНИЯ] ореол ярче
    kit.flash(p, { ramp, size: [0.2, 1.0], dur: 0.16, intensity: 2, sprite: 'ring', pull: 0.7, rival: R });                // [W4-ЗАКЛИНАНИЯ]
    kit.emit({ at: p, dir: back, cone: back ? 0.9 : Math.PI, count: 16, speed: [3, 9], life: [0.15, 0.4], size: [0.06, 0.01], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, gravity: 6, drag: 2.5, rival: R, essential: true });
    kit.emit({ at: p, count: 8, speed: [0.5, 2], life: [0.3, 0.6], size: [0.04, 0.01], ramp: el === 'fire' ? 'ember' : ramp, intensity: 2.6, sprite: 'spark', gravity: 1.5, drag: 2, rival: R });   // [W4-ЗАКЛИНАНИЯ]
    kit.light(p, { color: P.hot, intensity: 0.7, range: 7, dur: 0.18, attack: 0.05 });
    kit.hitstop(12);
    au('boltImpact', p);
    return true;
  }, (d) => d.kind === 'spark');

  // ============================================================ РАССЕЧЕНИЕ
  // Серп клинка (свой меш): тонкая раскалённая кромка, янтарное тело, хвост гаснет первым; лента trails по кромке,
  // искры с головы; попадание — перекрестье двух росчерков на цели, вспышка, искры.
  const slSpark = { at: null, dir: null, cone: 0.35, count: 2, speed: [3, 7], life: [0.12, 0.3], size: [0.06, 0.01], ramp: 'gold', intensity: 3.4, sprite: 'spark', stretch: 0.03, drag: 3, gravity: 2, essential: true, rival: false };
  const _hp = new V3(), _ht = new V3();
  fx.on('player_slash', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const P = fx.pal('gold', d);
    const ramp = rampOf('gold', R);
    const A = d && typeof d.arc === 'object' && d.arc ? d.arc : null;
    const ctr = fx.evPos(ev, new V3());
    const o = ctr && ctr.y > c.feet.y + 0.4 ? ctr : new V3().copy(c.chest);
    const yaw = Math.atan2(c.fwd.x, c.fwd.z);
    const half = clamp((A && isNum(A.angleDeg) ? A.angleDeg : 110) * Math.PI / 360, 0.4, 1.4);
    const Rr = clamp(A && isNum(A.radius) ? A.radius * 0.42 : 1.8, 1.1, 2.4);
    const sgn = d.dir === 'left' || (isNum(d.dir) && d.dir < 0) ? -1 : 1;
    const pw = clamp(isNum(d.power) ? d.power : 0.6, 0, 1);
    const a0 = yaw + sgn * half * 1.1, span = -2 * sgn * half * 1.1;
    const y0 = 0.5, y1 = -0.38;
    const tr = trail(fx, 'gold', R, { style: 'energy', width: 0.12, life: 0.16, intensity: 2.8, taper: 1, maxPoints: 20, minDist: 0.05 });
    slSpark.ramp = ramp; slSpark.rival = R;
    const headAt = (u, out) => { const a = a0 + span * u; return out.set(o.x + Math.sin(a) * Rr, o.y + y0 + (y1 - y0) * u, o.z + Math.cos(a) * Rr); };
    if (strips) {
      strips.crescent({
        center: o, a0, span, r0: Rr * 0.5, r1: Rr, y0, y1, drop: -0.32, dur: 0.3, tail: 0.8,
        color: P.mid, hot: P.hot, core: P.core, intensity: 1.3 + 0.5 * pw,
        onFrame(k, u) {
          if (u >= 1) { if (tr) { try { tr.stop(); } catch (e) { /* ignore */ } } return; }
          headAt(u, _hp);
          headAt(Math.min(1, u + 0.02), _ht).sub(_hp);
          if (tr) { try { tr.push(_hp); } catch (e) { /* ignore */ } }
          slSpark.at = _hp; slSpark.dir = _ht; kit.emit(slSpark);
        },
      });
    } else {
      // запасной вариант без меша: веер вытянутых искр по дуге
      for (let i = 0; i < 9; i++) {
        const u = i / 8;
        headAt(u, _hp); headAt(Math.min(1, u + 0.05), _ht).sub(_hp);
        kit.emit({ at: _hp, dir: _ht, cone: 0.1, count: 3, speed: [5, 9], life: [0.1, 0.1 + 0.15 * u], size: [0.14, 0.04], ramp, intensity: 3.4, sprite: 'streak', stretch: 0.04, drag: 6, rival: R, essential: true, at0: u * 0.1 });
      }
    }
    kit.flash(headAt(0.5, new V3()), { color: P.hot, size: [0.4, 1.2], dur: 0.14, intensity: 1.6, sprite: 'glow', pull: 0.4, rival: R, delay: 0.04 });
    if (d.hit) {
      const tg = c.target;
      kit.after(0.07, () => {
        camAxes();
        // два крест-накрест росчерка: первый — по направлению взмаха, второй — через 50 мс
        for (let j = 0; j < 2; j++) {
          const sy = j === 0 ? -1 : 1;
          const dx = _cr.x * sgn + _cu.x * sy, dy = _cr.y * sgn + _cu.y * sy, dz = _cr.z * sgn + _cu.z * sy;
          const l = Math.hypot(dx, dy, dz) || 1;
          const dd = { x: dx / l, y: dy / l, z: dz / l };
          kit.emit({ at: { x: tg.x - dd.x * 0.9, y: tg.y - dd.y * 0.9, z: tg.z - dd.z * 0.9 }, shape: 'line', to: { x: tg.x + dd.x * 0.5, y: tg.y + dd.y * 0.5, z: tg.z + dd.z * 0.5 }, dir: dd, cone: 0.01, count: 5, speed: [16, 20], life: [0.14, 0.2], size: [0.2, 0.05], ramp: 'whiteHold', intensity: 4.5, sprite: 'streak', stretch: 0.045, drag: 12, rival: R, essential: true, at0: j * 0.05 });
          kit.emit({ at: tg, dir: dd, cone: 0.5, count: 8, speed: [4, 9], life: [0.15, 0.35], size: [0.06, 0.01], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.03, drag: 2.5, gravity: 4, rival: R, essential: true, at0: j * 0.05 });
        }
        kit.flash(tg, { color: P.core, size: [0.4, 1.6], dur: 0.12, intensity: 4.5, sprite: 'star', pull: 0.8, rival: R });
        kit.flash(tg, { color: P.hot, size: [0.6, 2], dur: 0.26, intensity: 1.8, sprite: 'glow', pull: 0.8, rival: R });
        kit.light(tg, { color: P.hot, intensity: 0.9, range: 9, dur: 0.25, attack: 0.05 });
        kit.shake(0.1); kit.hitstop(28);
      });
    }
    _ht.copy(c.right).multiplyScalar(sgn);
    kit.kick(_ht, 0.02);
    au('cast', o);
    return true;
  });

  // ============================================================ НОВА (burst)
  // Золотая нова: ядро-звезда у груди, расширяющаяся сфера (≤2.6 м — камера снаружи), огромная волна по земле,
  // плоский веер искр, огненно-золотые угли бегут кольцом, руна-печать на земле, свет, тряска.
  fx.on('burst', (ev, d) => {
    const c = caster(fx, ev, d);
    const R = c.remote;
    const el = fx.heroEl(d), P = fx.pal(el, d);   // [W4-ЗАКЛИНАНИЯ] нова в цвете героя (вспышки — по градиентам)
    const ramp = rampOf(el, R);                    // [W4-ЗАКЛИНАНИЯ]
    const p = fx.evPos(ev, new V3());
    const ctr = p && p.y > c.feet.y + 0.3 ? p : new V3().copy(c.chest);
    const rad = clamp(isNum(d.radius) ? d.radius : 7, 2, 14);
    const pw = clamp(isNum(d.power) ? d.power : 0.8, 0.2, 1);
    const g = { x: c.feet.x, y: c.feet.y + 0.05, z: c.feet.z };
    kit.flash(ctr, { ramp: 'whiteHold', size: [0.4, 1.5], dur: 0.18, intensity: 5, sprite: 'star', pull: 0.8, rival: R });   // [W4-ЗАКЛИНАНИЯ] белое ядро
    kit.flash(ctr, { ramp, size: [0.6, 1.5], dur: 0.42, intensity: 2.6, sprite: 'glow', pull: 0.8, rival: R });            // [W4-ЗАКЛИНАНИЯ] ореол ярче
    if (!sphere(ctr, 0.3, 1.7, 0.36, P, R, { intensity: 0.8, distort: 1 })) {
      kit.flash(ctr, { ramp, size: [0.5, 1.5], dur: 0.3, intensity: 1.8, sprite: 'ring', pull: 0.5, rival: R });           // [W4-ЗАКЛИНАНИЯ]
    }
    ring(g, 0.4, rad, 0.62, P, R, { intensity: 1.8, thickness: 0.16, distort: 1 });
    kit.after(0.06, () => ring(g, 0.2, rad * 0.55, 0.45, P, R, { intensity: 1.6, thickness: 0.3 }));
    wall(g, 0.4, rad, 1.2, 0.62, P, 0.35);
    // плоский веер искр
    kit.emit({ at: ctr, shape: 'ring', radius: 0.3, normal: UP, count: 64, speed: [rad * 1.2, rad * 2.2], life: [0.3, 0.6], size: [0.08, 0.015], ramp, intensity: 3.4, sprite: 'spark', stretch: 0.03, drag: 3, rival: R, essential: true });
    kit.emit({ at: ctr, count: 30, speed: [3, 8], life: [0.4, 0.9], size: [0.06, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.025, drag: 2, gravity: 2, rival: R });
    // кольцо углей по земле
    kit.emit({ at: { x: g.x, y: g.y + 0.1, z: g.z }, shape: 'ring', radius: 0.5, normal: UP, count: 48, radial: rad * 1.4, speed: [0, 0.4], dir: UP, cone: 0.2, life: [0.3, 0.55], size: [0.45, 0.1], ramp: el === 'fire' ? 'ember' : ramp, intensity: 2.6, sprite: 'ember', drag: 4.2, rival: R, essential: true });   // [W4-ЗАКЛИНАНИЯ]
    decal(fx, g, 'rune', 2.4, el, R, { life: 5, intensity: 0.9 });   // [W4-ЗАКЛИНАНИЯ]
    // золотые пылинки оседают
    kit.emit({ at: ctr, radius: 1.4, count: 26, dir: UP, cone: 0.6, speed: [0.2, 0.8], life: [0.8, 1.6], size: [0.05, 0.01], ramp, intensity: 2.2, sprite: 'ember', turb: 0.4, gravity: -0.3, drag: 1, delay: 0.3, rival: R });
    kit.light(ctr, { color: P.hot, intensity: 1.8, range: 14, dur: 0.6, attack: 0.03 });
    distort(ctr, 0.8);
    kit.screenFlash(R ? 0xc8b4ff : P.hot, 0.08 + 0.06 * pw, 0.1);   // [W4-ЗАКЛИНАНИЯ] тон стихии героя
    kit.shake(0.2 + 0.1 * pw); kit.kick(UP, 0.02); kit.hitstop(30);
    au('burst', ctr);
    return true;
  });

  // ============================================================ СФЕРА / ПРИЗМА — доп. слои к старому удару
  fx.on('projectile_impact', (ev, d) => {
    const R = fx.isRemote(d);
    const prism = d.kind === 'prism';
    const P = R ? E.rival : (prism ? { core: 0xfffdf6, hot: 0xfff2d0, mid: 0xf4e0ae } : E.gold);
    const p = fx.evPos(ev, new V3());
    if (!p) return;
    const gy = fx.groundY(p.x, p.z, 0);
    const near = p.y - gy < 3.4 || d.result === 'floor';
    const back = hasVec(d.direction) ? { x: -d.direction.x, y: -d.direction.y, z: -d.direction.z } : null;
    if (back) ring(p, 0.3, prism ? 1.6 : 1.9, 0.36, P, R, { normal: back, intensity: 1.3, thickness: 0.14, distort: 0.8 });
    if (near) {
      const g = { x: p.x, y: gy + 0.05, z: p.z };
      ring(g, 0.4, prism ? 3.6 : 4.2, 0.55, P, R, { intensity: 2 });
      decal(fx, g, prism ? 'crack' : 'rune', prism ? 2.2 : 2.6, 'gold', R, { life: 6 });
    }
    if (prism) {
      // блики граней: звёзды вспыхивают вразнобой вокруг точки удара
      for (let i = 0; i < 7; i++) {
        kit.flash({ x: p.x + (Math.random() - 0.5) * 2.4, y: p.y + (Math.random() - 0.5) * 2, z: p.z + (Math.random() - 0.5) * 2.4 }, { color: P.core, size: [0.1, 0.5 + Math.random() * 0.4], dur: 0.22, intensity: 4, sprite: 'star', pull: 0.6, rival: R, delay: Math.random() * 0.3 });
      }
      kit.emit({ at: p, radius: 0.4, count: 18, speed: [1, 4], life: [0.5, 1], size: [0.12, 0.03], color: P.hot, intensity: 3, sprite: 'star', drag: 1.5, gravity: 1, spin: [-3, 3], rival: R });
    } else {
      kit.emit({ at: p, radius: 0.6, count: 22, dir: UP, cone: 0.7, speed: [0.3, 1.2], life: [0.8, 1.5], size: [0.06, 0.01], ramp: rampOf('gold', R), intensity: 2.4, sprite: 'ember', turb: 0.4, gravity: -0.3, drag: 1, delay: 0.25, rival: R });
    }
    distort(p, 0.5);
    // старый удар сферы/призмы тоже рисуется (не возвращаем true)
  }, (d) => (d.kind === 'sphere' || d.kind === 'prism') && d.owner !== 'boss');

  // ============================================================ по снимку: иглы искр, купол, прицел
  fx.every((dt, snap) => {
    if (!snap) return;
    drawSparks(snap);
    const pl = snap.player;
    const alive = pl && pl.action !== 'dead';
    domeTick(domes[0], dt, !!(pl && pl.bastion && alive), pl ? pl.bastionRemaining : 0);
    const op = snap.opponent;
    domeTick(domes[1], dt, !!(op && op.bastion && op.action !== 'dead'), op ? op.bastionRemaining : 0);
    // прицел рамки
    if (useMark) {
      const bo = snap.boss;
      const flag = snap.mode === 'pvp' ? (op ? op.marked : undefined) : (bo ? bo.marked : undefined);
      const on = flag === true || (flag === undefined && kit.clock < mark.until) || kit.clock - mark.t0 < 0.35;
      const dead = snap.mode === 'pvp' ? (op && op.action === 'dead') : (bo && bo.action === 'dead');
      if (gOk(mark.g, mark.gen)) {
        if (!on || dead) { mark.g.fadeOut(0.4); mark.g = null; }
        else if (!mark.snapping) {
          markSet.intensity = fx.reduced() ? 1.6 : 1.5 + 0.25 * Math.sin(kit.clock * 3.1);
          markSet.radius = 1.35 + (fx.reduced() ? 0 : 0.05 * Math.sin(kit.clock * 2.3));
          mark.g.set(markSet);
        }
      } else if (flag === true && !dead) {
        spawnReticle(1.35);
        mark.t0 = kit.clock; mark.until = kit.clock;
      }
    }
  });
}
