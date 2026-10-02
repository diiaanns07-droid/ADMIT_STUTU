// ASHEN OATH — modules/fx/bossFinale.js. [W3-КИНО] Картинка боя как трейлер: две «сцены» Регента.
//
//  1. Переход в фазу 2 (boss_phase, stage 2) — 1,5 с: замедление, кинорамка, лавовые трещины бегут по броне
//     от ядра, небо рывком багровеет, рёв, ударная волна и красная вспышка, лёгкий наезд камеры на Регента.
//     Бой в это время честный: мозг Регента стоит в «смене стойки» 2 с (boss.js shiftDuration) — атак нет.
//  2. Гибель Регента (victory, не дуэль) — перегрев трещин, взрыв света, тело рассыпается на светящиеся
//     осколки и пепел, нимб падает, медленная камера облетает место гибели. Укладывается в outro main.js
//     (замедление и экран итогов — как были), осколки остывают и лежат на полу до следующего боя.
//
// export function createBossFinale({ THREE, scene, world, cue, shake, reducedMotion, quality })
//   -> { update(dt, dtReal, snap, events), timeScale(), applyCamera(camera, dtReal), reset(), dispose(),
//        get active(), debug() }
//   dt — боевое (замедленное) время: осколки и пепел летят в нём (зависают в замедлении, как в трейлере);
//   dtReal — настенное: тайминги сцен, камера, экранные импульсы.
//   timeScale() — множитель боевого времени на время сцены перехода (main умножает dt; HUD «SLOW» не видит).
//   applyCamera(camera) — после того как main поставил камеру риг-а: смешивает её с кинокамерой сцены.
//   world: world.bossFx { setLava(front, boost), shatter(), body, origin(out) } и world.atmosphere
//          { setPhaseBoost(k), flash(k) } — если чего-то нет, соответствующая часть сцены пропускается.
//   cue(name) — звук через публичный API (effects.cue), shake(k) — тряска камеры риг-а.
//   Экранные эффекты — postfx.pulse() (модульный, core/postfx.js), на low — только дешёвое.
// Всё создаётся один раз (шейдеры прогреваются вместе со сценой), без аллокаций в кадре, dispose() чистит.

import { pulse } from '../../core/postfx.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Тайминги (секунды настенного времени) и счёт частиц по уровням качества.
export const FINALE = {
  phase: { dur: 1.5, slow: 0.22, slowIn: 0.12, slowOut: 1.05, roarAt: 0.5, sweep: [0.08, 0.95], bars: 1.25, push: 0.12 },
  death: { overload: 0.38, shatterAt: 0.42, bars: 2.4, orbitSpeed: 0.2, orbitIn: 0.7 },
  q: {
    low: { shards: 48, embers: 120 },
    medium: { shards: 120, embers: 320 },
    high: { shards: 200, embers: 560 },
  },
  shardMax: 200, emberMax: 560,
};

const SHARD_VERT = /* glsl */`
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3(1.0);
  #endif
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
// Грани осколка: ключ сверху-сбоку + кромка к камере; цвет — накал (HDR > 1 ловит bloom) или остывший камень.
const SHARD_FRAG = /* glsl */`
uniform vec3 uKey;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float facet = 0.5 + 0.5 * abs(dot(n, uKey));
  float rim = pow(1.0 - abs(dot(n, v)), 2.0);
  gl_FragColor = vec4(vCol * (facet + rim * 0.9), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createBossFinale({ THREE, scene, world, cue, shake, reducedMotion, quality } = {}) {
  if (!THREE || !scene) throw new Error('[bossFinale] нужны THREE и scene');
  const rm = () => { try { return typeof reducedMotion === 'function' ? !!reducedMotion() : !!reducedMotion; } catch (e) { return false; } };
  const qName = () => { let q = 'medium'; try { q = typeof quality === 'function' ? quality() : quality; } catch (e) { /* ignore */ } return FINALE.q[q] ? q : 'medium'; };
  const say = (name) => { if (typeof cue === 'function') { try { cue(name); } catch (e) { /* ignore */ } } };
  const quake = (k) => { if (typeof shake === 'function' && !rm()) { try { shake(k); } catch (e) { /* ignore */ } } };
  const bfx = () => (world && world.bossFx) || null;
  const atmo = () => (world && world.atmosphere) || null;
  const rnd = mulberry32(0x5eed2026);
  const V3 = THREE.Vector3;
  const owned = [];
  const own = (x) => { owned.push(x); return x; };

  // ---------------------------------------------------------------- ресурсы (создаются один раз)
  const root = new THREE.Group();
  root.name = 'boss-finale';
  scene.add(root);

  // мягкое пятно для искр и света
  function glowTexture() {
    let tex = null;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.6, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
    } catch (e) { tex = null; }   // node-тесты без DOM: спрайты без текстуры
    return tex ? own(tex) : null;
  }
  const texGlow = glowTexture();

  // осколки: один InstancedMesh, приплюснутые октаэдры с неравным масштабом
  const shardGeo = own(new THREE.OctahedronGeometry(1, 0));
  const shardMat = own(new THREE.ShaderMaterial({
    name: 'AshenShard',
    uniforms: { uKey: { value: new V3(0.35, 0.85, 0.4).normalize() } },
    vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
  }));
  const shards = new THREE.InstancedMesh(shardGeo, shardMat, FINALE.shardMax);
  shards.name = 'boss-finale-shards';
  shards.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(FINALE.shardMax * 3), 3);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shards.instanceColor.setUsage(THREE.DynamicDrawUsage);
  shards.count = 0;
  shards.frustumCulled = false;
  shards.visible = false;
  root.add(shards);
  const S = [];
  for (let i = 0; i < FINALE.shardMax; i++) {
    S.push({ p: new V3(), v: new V3(), axis: new V3(0, 1, 0), spin: 0, ang: 0, sc: new V3(1, 1, 1), heat: 1, cool: 0.5, cold: false, rest: false, delay: 0 });
  }

  // пепел и угли: Points, аддитивно, цвет гаснет к тёмному — частица исчезает
  const emberGeo = own(new THREE.BufferGeometry());
  const ePos = new Float32Array(FINALE.emberMax * 3);
  const eCol = new Float32Array(FINALE.emberMax * 3);
  emberGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3).setUsage(THREE.DynamicDrawUsage));
  emberGeo.setAttribute('color', new THREE.BufferAttribute(eCol, 3).setUsage(THREE.DynamicDrawUsage));
  emberGeo.setDrawRange(0, 0);
  const emberMat = own(new THREE.PointsMaterial({
    size: 0.11, map: texGlow, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
  }));
  const embers = new THREE.Points(emberGeo, emberMat);
  embers.name = 'boss-finale-embers';
  embers.frustumCulled = false;
  embers.visible = false;
  root.add(embers);
  const E = [];
  for (let i = 0; i < FINALE.emberMax; i++) E.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, age: 0, seed: 0, hot: 1 });

  // взрыв света: шар-ореол и столб света вверх
  const burstMat = own(new THREE.SpriteMaterial({ map: texGlow, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const burst = new THREE.Sprite(burstMat);
  burst.name = 'boss-finale-burst';
  burst.visible = false;
  root.add(burst);
  const pillarMat = own(new THREE.SpriteMaterial({ map: texGlow, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const pillar = new THREE.Sprite(pillarMat);
  pillar.name = 'boss-finale-pillar';
  pillar.visible = false;
  root.add(pillar);

  // ---------------------------------------------------------------- состояние
  const st = {
    phase: null,     // { t } — сцена перехода
    death: null,     // { t, shattered }
    camW: 0,         // вес кинокамеры
    orbit: { ang: 0, r: 9, y: 3.5, cx: 0, cz: 0, dir: 1, ok: false },
    camPos: new V3(), camTgt: new V3(),
    boost: 0,        // удержание багрового неба во 2-й фазе
    pvp: false,
    seen: new Set(), seenQ: [],
    shardsLive: false, embersLive: 0,
  };
  const _v = new V3(), _w = new V3(), _core = new V3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _c = new THREE.Color();
  const _look = new THREE.Object3D();

  function bossCore(snap, out) {
    const fx = bfx();
    if (fx && typeof fx.origin === 'function') { try { if (fx.origin(out)) return out; } catch (e) { /* ignore */ } }
    try { const a = world && world.getAnchors ? world.getAnchors() : null; if (a && a.bossCore) return out.set(a.bossCore.x, a.bossCore.y, a.bossCore.z); } catch (e) { /* ignore */ }
    const b = snap && snap.boss && snap.boss.position;
    return out.set(b ? b.x : 0, 3, b ? b.z : 0);
  }
  function setLava(front, boost) {
    const fx = bfx();
    if (fx && typeof fx.setLava === 'function') { try { fx.setLava(front, boost); } catch (e) { /* ignore */ } }
  }
  function phaseBoost(k) {
    const a = atmo();
    if (a && typeof a.setPhaseBoost === 'function') { try { a.setPhaseBoost(k); } catch (e) { /* ignore */ } }
  }
  function skyStrike(k) {
    const a = atmo();
    if (a && typeof a.flash === 'function') { try { a.flash(k); } catch (e) { /* ignore */ } }
  }

  // ---------------------------------------------------------------- сцена перехода в фазу 2
  function startPhase(snap) {
    if (st.death) return;
    st.phase = { t: 0, roared: false };
    bossCore(snap, _core);
    pulse('bars', 1, null, { hold: FINALE.phase.bars });
    pulse('flash', 0.28, _core, { color: 0xff4a2a, dur: 0.3 });
    quake(0.35);
    setLava(0, 0.5);
  }
  function updatePhase(dtR, snap) {
    const P = st.phase, F = FINALE.phase;
    P.t += dtR;
    const t = P.t;
    // лава бежит от ядра по броне, накал с горбом в момент рёва
    const front = sstep(F.sweep[0], F.sweep[1], t);
    const heat = 0.6 + 1.3 * Math.exp(-Math.pow((t - F.roarAt - 0.1) / 0.35, 2));
    setLava(front, heat * (1 - sstep(1.2, F.dur, t)) + 0.6 * sstep(1.2, F.dur, t));
    // небо багровеет рывком и остаётся (atmosphere.red догонит позже)
    st.boost = Math.max(st.boost, sstep(0.05, 0.7, t));
    phaseBoost(st.boost);
    if (!P.roared && t >= F.roarAt) {
      P.roared = true;
      bossCore(snap, _core);
      say('boss_nova');                                    // рёв — поверх авто-звука boss_phase
      pulse('shockwave', 1, _core);
      pulse('flash', 0.38, _core, { color: 0xff3a1e, dur: 0.34 });
      pulse('punch', 0.6, _core);
      skyStrike(1);
      quake(0.6);
    }
    if (t >= F.dur) { st.phase = null; setLava(null, 0); }
  }

  // ---------------------------------------------------------------- гибель Регента
  function startDeath(snap) {
    st.phase = null;
    st.death = { t: 0, shattered: false };
    bossCore(snap, _core);
    pulse('bars', 1, null, { hold: FINALE.death.bars });
    pulse('flash', 0.2, _core, { color: 0xffd28a, dur: 0.25 });
    // орбита камеры — вокруг места гибели
    const b = snap && snap.boss && snap.boss.position;
    st.orbit.cx = b ? b.x : 0; st.orbit.cz = b ? b.z : 0; st.orbit.ok = false;
  }
  function updateDeath(dt, dtR, snap) {
    const D = st.death, F = FINALE.death;
    D.t += dtR;
    if (!D.shattered) {
      // перегрев: трещины добела, вне затухания смерти
      setLava(1, 0.8 + 2.2 * sstep(0, F.overload, D.t));
      if (D.t >= F.shatterAt) shatter(snap);
    }
  }
  function shatter(snap) {
    const D = st.death;
    D.shattered = true;
    bossCore(snap, _core);
    spawnShards(_core);
    spawnEmbers(_core);
    const fx = bfx();
    if (fx && typeof fx.shatter === 'function') { try { fx.shatter(); } catch (e) { /* ignore */ } }
    setLava(null, 0);
    // взрыв света
    burst.position.copy(_core);
    burst.visible = true;
    pillar.position.set(_core.x, _core.y + 4, _core.z);
    pillar.visible = true;
    st.burstT = 0;
    pulse('flash', 0.55, _core, { color: 0xfff0c8, dur: 0.22 });   // короткий удар светом — дальше видны осколки
    pulse('shockwave', 1, _core);
    pulse('dash', 0.8, _core);
    skyStrike(1);
    say('boss_nova');
    quake(0.85);
  }

  // точки на видимых мешах тела Регента (в мире) — осколки рождаются там, где была броня
  const meshes = [];
  function collectMeshes() {
    meshes.length = 0;
    const fx = bfx();
    let body = fx && fx.body;
    if (!body && world && world.root && world.root.getObjectByName) body = world.root.getObjectByName('boss-body');
    if (!body) return;
    body.updateMatrixWorld(true);
    body.traverseVisible((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!m || m.transparent || m.blending === THREE.AdditiveBlending) return;
      if (o.geometry.attributes.position.count < 3) return;
      meshes.push(o);
    });
  }
  function samplePoint(out, core) {
    if (meshes.length) {
      const o = meshes[(rnd() * meshes.length) | 0];
      const pa = o.geometry.attributes.position;
      const i = (rnd() * pa.count) | 0;
      return out.set(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(o.matrixWorld);
    }
    // запасной вариант: столб вокруг ядра
    const a = rnd() * TAU, r = 0.2 + rnd() * 1.1;
    return out.set(core.x + Math.sin(a) * r, 0.6 + rnd() * 4.4, core.z + Math.cos(a) * r);
  }
  function spawnShards(core) {
    collectMeshes();
    const n = FINALE.q[qName()].shards;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      samplePoint(s.p, core);
      // наружу от оси Регента + вверх; ближние к ядру летят сильнее
      _v.set(s.p.x - core.x, 0, s.p.z - core.z);
      const l = _v.length() || 1;
      _v.multiplyScalar(1 / l);
      const near = clamp(1.6 - Math.abs(s.p.y - core.y) / 2.5, 0.4, 1.6);
      const sp = (1.8 + rnd() * 4.6) * near;
      s.v.set(_v.x * sp + (rnd() - 0.5) * 1.2, 1.0 + rnd() * 4.2 * near, _v.z * sp + (rnd() - 0.5) * 1.2);
      s.axis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      s.spin = (rnd() - 0.5) * 14;
      s.ang = rnd() * TAU;
      const big = rnd() < 0.15 ? 1.8 : 1;
      s.sc.set((0.06 + rnd() * 0.16) * big, (0.1 + rnd() * 0.3) * big, (0.05 + rnd() * 0.12) * big);
      s.cold = rnd() < 0.22;                 // часть — просто камень брони
      s.heat = s.cold ? 0.25 : 1;
      s.cool = 0.25 + rnd() * 0.45;
      s.rest = false;
    }
    shards.count = n;
    shards.visible = true;
    st.shardsLive = true;
    writeShards(0);
  }
  function shardColor(s, out) {
    // остывание: белый жар → оранжевая лава → тёмно-красные угли → камень
    const h = clamp(s.heat, 0, 1);
    if (h > 0.66) { const k = (h - 0.66) / 0.34; out.setRGB(lerp(3.4, 6.0, k), lerp(1.25, 4.2, k), lerp(0.3, 2.2, k)); }
    else if (h > 0.25) { const k = (h - 0.25) / 0.41; out.setRGB(lerp(0.55, 3.4, k), lerp(0.1, 1.25, k), lerp(0.04, 0.3, k)); }
    else { const k = h / 0.25; out.setRGB(lerp(0.05, 0.55, k), lerp(0.04, 0.1, k), lerp(0.035, 0.04, k)); }
    return out;
  }
  function writeShards(dt) {
    const n = shards.count;
    let moving = false;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      if (!s.rest && dt > 0) {
        s.v.y -= 9.8 * dt;
        const drag = Math.exp(-0.35 * dt);
        s.v.x *= drag; s.v.z *= drag;
        s.p.addScaledVector(s.v, dt);
        s.ang += s.spin * dt;
        const floor = 0.03 + s.sc.y * 0.35;
        if (s.p.y <= floor) {
          s.p.y = floor;
          s.v.y *= -0.25; s.v.x *= 0.5; s.v.z *= 0.5; s.spin *= 0.4;
          if (Math.abs(s.v.y) < 0.4 && s.v.x * s.v.x + s.v.z * s.v.z < 0.05) { s.v.set(0, 0, 0); s.spin = 0; s.rest = true; }
        }
      }
      if (dt > 0) s.heat = Math.max(0, s.heat - s.cool * dt * (s.rest ? 1.6 : 1));
      if (!s.rest || s.heat > 0) moving = true;
      _q.setFromAxisAngle(s.axis, s.ang);
      _m.compose(s.p, _q, s.sc);
      shards.setMatrixAt(i, _m);
      shards.setColorAt(i, shardColor(s, _c));
    }
    shards.instanceMatrix.needsUpdate = true;
    shards.instanceColor.needsUpdate = true;
    return moving;
  }

  function spawnEmbers(core) {
    const n = FINALE.q[qName()].embers;
    for (let i = 0; i < n; i++) {
      const e = E[i];
      samplePoint(_w, core);
      e.x = _w.x; e.y = _w.y; e.z = _w.z;
      _v.set(e.x - core.x, (rnd() - 0.3) * 0.6, e.z - core.z).normalize();
      const sp = 0.6 + rnd() * 3.2;
      e.vx = _v.x * sp; e.vy = 0.6 + rnd() * 2.2; e.vz = _v.z * sp;
      e.life = 2.2 + rnd() * 2.8; e.age = 0; e.seed = rnd() * 100; e.hot = 0.6 + rnd() * 0.8;
    }
    st.embersLive = n;
    emberGeo.setDrawRange(0, n);
    embers.visible = true;
  }
  function updateEmbers(dt) {
    const n = st.embersLive;
    if (!n) return;
    let alive = 0;
    const t = st.clock;
    for (let i = 0; i < n; i++) {
      const e = E[i], k = i * 3;
      if (e.age < e.life) {
        e.age += dt;
        // пепел всплывает (жар), кружит, тормозит
        const drag = Math.exp(-1.1 * dt);
        e.vx = e.vx * drag + Math.sin(t * 1.3 + e.seed) * 0.9 * dt;
        e.vz = e.vz * drag + Math.cos(t * 1.1 + e.seed * 1.7) * 0.9 * dt;
        e.vy = e.vy * drag + 0.55 * dt;
        e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
        alive++;
      }
      const a = clamp(1 - e.age / e.life, 0, 1);
      const f = a * a * e.hot;
      // угли: оранжевые → серо-красные → гаснут (аддитивно — чёрное невидимо)
      eCol[k] = f * lerp(0.5, 3.0, a); eCol[k + 1] = f * lerp(0.18, 1.1, a * a); eCol[k + 2] = f * lerp(0.12, 0.3, a);
      ePos[k] = e.x; ePos[k + 1] = e.y; ePos[k + 2] = e.z;
    }
    emberGeo.attributes.position.needsUpdate = true;
    emberGeo.attributes.color.needsUpdate = true;
    if (!alive) { st.embersLive = 0; embers.visible = false; emberGeo.setDrawRange(0, 0); }
  }
  function updateBurst(dtR) {
    if (!burst.visible) return;
    st.burstT += dtR;
    const t = st.burstT;
    const grow = 1 - Math.exp(-t * 9);
    const fade = Math.exp(-Math.max(0, t - 0.06) * 4.2);
    burst.scale.setScalar(1.0 + grow * 4.5);
    burstMat.color.setRGB(1.3 * fade, 0.95 * fade, 0.55 * fade);
    pillar.scale.set(0.6 + grow * 0.6, 4 + grow * 18, 1);
    const pf = Math.exp(-Math.max(0, t - 0.12) * 2.2);
    pillarMat.color.setRGB(1.1 * pf, 0.9 * pf, 0.6 * pf);
    if (fade < 0.01 && pf < 0.01) { burst.visible = false; pillar.visible = false; }
  }

  // ---------------------------------------------------------------- кадр
  st.clock = 0; st.burstT = 0;
  function update(dt, dtReal, snap, events) {
    const d = isNum(dt) ? clamp(dt, 0, 0.1) : 0;
    const dR = isNum(dtReal) ? clamp(dtReal, 0, 0.1) : d;
    st.clock += d;
    st.pvp = !!(snap && snap.mode === 'pvp');
    if (st.pvp) { if (st.phase || st.death || st.boost) reset(); return; }
    // новый бой: Регент жив и снова на первой стадии — всё вернуть
    if ((st.death || st.boost > 0) && snap && snap.status === 'playing' && snap.boss && snap.boss.hp > 0 && snap.boss.stage !== 2) reset();
    if (Array.isArray(events)) {
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        if (ev.id !== undefined && ev.id !== null) {
          if (st.seen.has(ev.id)) continue;
          st.seen.add(ev.id); st.seenQ.push(ev.id);
          if (st.seenQ.length > 256) st.seen.delete(st.seenQ.shift());
        }
        const dd = ev.data || {};
        if (ev.type === 'boss_phase' && dd.stage === 2 && !dd.awaken && !dd.remote && !st.death) startPhase(snap);
        else if (ev.type === 'victory' && !dd.remote && !st.death) startDeath(snap);
      }
    }
    // запасной путь: победа без события (снимок уже победный)
    if (!st.death && snap && snap.status === 'victory') startDeath(snap);
    if (st.phase) updatePhase(dR, snap);
    if (st.death) {
      updateDeath(d, dR, snap);
      st.boost = Math.max(0, st.boost - dR * 0.8);   // рассвет победы сменяет багровое небо
      phaseBoost(st.boost);
    } else if (st.boost > 0 && snap && snap.boss && snap.boss.stage === 2) {
      phaseBoost(st.boost);
    }
    if (st.shardsLive) st.shardsLive = writeShards(d);
    updateEmbers(d);
    updateBurst(dR);
  }

  // Множитель боевого времени: сцена перехода — замедление с плавным входом и выходом.
  function timeScale() {
    const P = st.phase;
    if (!P) return 1;
    const F = FINALE.phase, t = P.t;
    const slow = rm() ? 0.5 : F.slow;
    if (t < F.slowIn) return lerp(1, slow, t / F.slowIn);
    if (t < F.slowOut) return slow;
    return lerp(slow, 1, sstep(F.slowOut, F.dur, t));
  }

  // Кинокамера поверх риг-а: смешивание позиции и поворота (камера уже поставлена main).
  function applyCamera(camera, dtReal) {
    if (!camera) return;
    const dR = isNum(dtReal) ? clamp(dtReal, 0, 0.1) : 0;
    let want = 0;
    if (st.death) {
      const O = st.orbit, F = FINALE.death;
      if (!O.ok) {
        O.ang = Math.atan2(camera.position.x - O.cx, camera.position.z - O.cz);
        O.r = clamp(Math.hypot(camera.position.x - O.cx, camera.position.z - O.cz), 7.5, 10);
        O.y = clamp(camera.position.y, 2.4, 4.2);
        O.dir = O.ang >= 0 ? 1 : -1;
        O.ok = true;
      }
      if (!rm()) {
        O.ang += dR * F.orbitSpeed * O.dir;
        O.r = Math.min(10.5, O.r + dR * 0.25);   // медленный отъезд
        O.y = Math.min(4.8, O.y + dR * 0.18);
      }
      st.camPos.set(O.cx + Math.sin(O.ang) * O.r, O.y, O.cz + Math.cos(O.ang) * O.r);
      st.camTgt.set(O.cx, lerp(3.0, 1.6, sstep(0.4, 3.0, st.death.t)), O.cz);   // взгляд опускается к осколкам
      want = sstep(0, F.orbitIn, st.death.t);
    } else if (st.phase) {
      // лёгкий наезд и взгляд вверх, на Регента
      const F = FINALE.phase, t = st.phase.t;
      bossCore(null, _core);
      st.camPos.copy(camera.position).lerp(_core, F.push);
      st.camPos.y += 0.35;
      st.camTgt.set(_core.x, _core.y + 0.9, _core.z);
      want = sstep(0, 0.3, t) * (1 - sstep(1.05, F.dur, t)) * (rm() ? 0.4 : 0.55);
    }
    st.camW = want;
    if (want <= 0.001) return;
    _q.copy(camera.quaternion);
    camera.position.lerp(st.camPos, want);
    _look.position.copy(camera.position);
    _look.lookAt(st.camTgt);
    _q2.copy(_look.quaternion);
    // Object3D.lookAt смотрит +Z к цели, камера — −Z: разворот на π вокруг Y
    _q2.multiply(_qFlip);
    camera.quaternion.copy(_q).slerp(_q2, want);
    camera.updateMatrixWorld();
  }
  const _qFlip = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), Math.PI);

  function reset() {
    st.phase = null; st.death = null; st.camW = 0; st.boost = 0; st.orbit.ok = false;
    phaseBoost(0);
    setLava(null, 0);
    shards.count = 0; shards.visible = false; st.shardsLive = false;
    st.embersLive = 0; embers.visible = false; emberGeo.setDrawRange(0, 0);
    burst.visible = false; pillar.visible = false;
  }

  function dispose() {
    reset();
    if (root.parent) root.parent.remove(root);
    try { shards.dispose(); } catch (e) { /* ignore */ }
    for (const x of owned) { try { x.dispose(); } catch (e) { /* ignore */ } }
    owned.length = 0;
    st.seen.clear(); st.seenQ.length = 0;
  }

  return {
    update, timeScale, applyCamera, reset, dispose,
    get active() { return !!(st.phase || st.death); },
    debug() {
      return {
        phase: st.phase ? +st.phase.t.toFixed(2) : null, death: st.death ? +st.death.t.toFixed(2) : null,
        shattered: !!(st.death && st.death.shattered), shards: shards.count, embers: st.embersLive,
        camW: +st.camW.toFixed(3), boost: +st.boost.toFixed(3), timeScale: +timeScale().toFixed(3),
      };
    },
  };
}
