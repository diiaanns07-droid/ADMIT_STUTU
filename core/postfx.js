/*
 * ASHEN OATH — core/postfx.js. Owner: #3 (visuals); кинематографичная картинка — №8 [BDO].
 *
 * export function createPostFX({ THREE, renderer, scene, camera, quality, reducedMotion })
 *   -> { render(dt), setSize(w, h, pixelRatio), setQuality('low'|'medium'|'high'),
 *        setReducedMotion(bool), setSun(u, v, vis), punch(k, u, v),
 *        setMode(screen, settings), setFocus(meters), shockwave(u, v, strength), setToneMapping('agx'|'aces'),
 *        dispose(), get enabled(), get ready(), get tier(), get error(), whenReady: Promise<boolean>, info() }
 * export function queueShockwave(u, v, strength) — [BDO] для №7 [VFX]: кольцо ударной волны (экранные uv 0..1,
 *   y вверх, strength 0..1). Работает и до создания postfx (очередь, свежие ≤0.45 с доигрываются).
 * export function setFocus(meters) — [BDO] фокус DOF меню (по умолчанию 3.0 м), для №4 [HERO] (витрина героя).
 *
 * createPostFX returns immediately. The addons are loaded with dynamic import('three/addons/...')
 * (the importmap in index.html maps them to three@0.185.1). Until they are ready, on 'low', and after
 * any failure, render() is a plain renderer.render(scene, camera) and `enabled` is false.
 *
 * Tiers
 *   low    — plain render, no composer at all (renderer.toneMapping = ACES, как было).
 *   medium — RenderPass → UnrealBloom (порог 1.0 в HDR: светятся только магия/угли/корона)
 *            → OutputPass (AgX + sRGB) → FXAA → Grade → screen.
 *   high   — RenderPass → GTAO (half resolution, modest) → [Bokeh DOF, только меню] → Bloom → Output → SMAA → Grade.
 *            GTAO/SMAA are loaded lazily the first time 'high' is requested; until then high = medium.
 *            BokehPass грузится лениво при первом входе в меню на high; на medium/low DOF не бывает никогда.
 *
 * [BDO] Grade — один полноэкранный проход (никаких новых проходов на medium):
 *   ударные волны (искажение UV, до 4 колец, только ALU) → 5 выборок: центр + крест для резкости CAS
 *   → +2 выборки хроматической аберрации только во время всплеска после удара (uniform-ветка)
 *   → [радиальный рывок 7 выборок и лучи короны 16 — как раньше, только когда активны]
 *   → lift/gain → мягкий S-контраст → split-tone (бирюзовые тени, тёплые света) → насыщенность + vibrance
 *   → виньетка → зерно + дизеринг.
 *   Параметры грейда = профиль экрана (setMode: бой / меню / интро / пауза / победа / поражение, плавный
 *   переход ~0.6 с) + настроение зоны ZONE_MOOD_STATE из modules/atmosphere.js (подмешивается по w).
 *
 * Tone mapping / colour space — [BDO] выбран AgX (сравнение ACES/AgX — TEST_REPORT/отчёт №8):
 *   ACES (фит three.js) пережигает корону и огни в плоское белое пятно и сдвигает огонь в жёлтый, а тени
 *   давит в чёрную кашу; AgX мягко сворачивает света (огонь остаётся оранжевым, у короны видна кромка),
 *   а контраст и сочность возвращает наш грейд. Поэтому на medium/high postfx сам ставит
 *   renderer.toneMapping = AgXToneMapping и на время composer.render() умножает toneMappingExposure на
 *   AGX.exposure (у ACES в three.js зашито ×1/0.6, у AgX нет — без поправки картинка темнее).
 *   На low (без composer и грейда), до готовности аддонов, после ошибки и после dispose() — возвращается
 *   исходный тонмаппинг main.js (ACES): без грейда ACES выглядит сочнее, чем «сырой» AgX.
 *   QA: ?tm=aces|agx в адресе страницы или postfx.setToneMapping('aces') — сравнить на одной сцене.
 *   main.js оставляет renderer.toneMapping = ACESFilmicToneMapping и outputColorSpace = SRGBColorSpace.
 *   three.js applies tone mapping and the sRGB transfer only when rendering to the canvas (render target
 *   null), so RenderPass writes linear HDR into the composer's HalfFloat targets and OutputPass applies
 *   renderer.toneMapping / toneMappingExposure / outputColorSpace once. The grade pass after it works in
 *   display space and uses no tone-mapping/colour-space chunks. Nothing is applied twice.
 *   The canvas MSAA (antialias:true) is unused while the composer is active (FXAA/SMAA do AA).
 * Sizing: call setSize(cssW, cssH, renderer.getPixelRatio()) after renderer.setSize/setPixelRatio.
 *   render() also re-syncs automatically if the renderer size or pixel ratio changed.
 */

import { ZONE_MOOD_STATE } from '../modules/atmosphere.js';

const TIERS = ['low', 'medium', 'high'];
const normTier = (q) => (TIERS.includes(q) ? q : 'medium');
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Display-space grade. Works on the output of OutputPass (+AA), writes to the canvas.
const GRADE_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GRADE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uCA;         // постоянная аберрация к углам кадра («объектив»), 0 — выкл
uniform float uCAPunch;    // [BDO] всплеск аберрации на мощном ударе 0..1 (гаснет ~0.25 с)
uniform float uSharp;      // [BDO] резкость CAS 0..1
uniform float uContrast;
uniform float uSat;
uniform float uVibrance;   // [BDO] добавка насыщенности блёклым цветам (яркие не пережигает)
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec3 uLift;        // [BDO] lift/gain (как ASC CDL): col*gain + lift*(1-col)
uniform vec3 uGain;
uniform vec2 uSunPos;      // экранные uv короны затмения
uniform float uSunVis;     // 0 — корона за кадром/сзади
uniform float uRays;       // сила лучей
uniform vec2 uPunchC;      // центр удара (uv)
uniform float uPunch;      // 0..1 радиальный рывок экрана на сильном попадании
uniform vec4 uWave[4];     // [BDO] ударные волны: xy — центр (uv), z — фаза 0..1, w — сила (0 — слот пуст)
uniform float uWaveOn;     // [BDO] 1 — есть хоть одна волна
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv;
  // [BDO] ударные волны: кольцо расширяется и «линзой» выталкивает картинку наружу (без выборок)
  if (uWaveOn > 0.5) {
    float aspect = uRes.x / max(uRes.y, 1.0);
    for (int i = 0; i < 4; i++) {
      vec4 wv = uWave[i];
      if (wv.w > 0.0) {
        vec2 dv = (vUv - wv.xy) * vec2(aspect, 1.0);
        float dist = length(dv);
        float x = (dist - wv.z * 0.6) / (0.03 + 0.07 * wv.z);
        float ring = max(0.0, 1.0 - x * x);
        float fade = 1.0 - wv.z;
        uv -= (dv / max(dist, 1e-4)) * vec2(1.0 / aspect, 1.0) * (wv.w * fade * fade * 0.028 * ring * ring);
      }
    }
  }
  vec2 px = 1.0 / max(uRes, vec2(1.0));
  vec3 c0 = texture2D(tDiffuse, uv).rgb;
  vec3 col = c0;
  // [BDO] резкость: облегчённый CAS (AMD FidelityFX) — сила по локальному контрасту, края не звенят
  if (uSharp > 0.001) {
    vec3 cN = texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb;
    vec3 cS = texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb;
    vec3 cE = texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb;
    vec3 cW = texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb;
    vec3 mn = min(c0, min(min(cN, cS), min(cE, cW)));
    vec3 mx = max(c0, max(max(cN, cS), max(cE, cW)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 w = amp * (-1.0 / mix(8.0, 5.0, uSharp));
    col = (c0 + (cN + cS + cE + cW) * w) / (1.0 + 4.0 * w);
  }
  // хроматическая аберрация: постоянная к углам + всплеск на ударе (2 выборки, только когда нужна)
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  float ca = uCA * r2 + uCAPunch * (0.0056 + 0.006 * r2);
  if (ca > 1e-5) {
    vec2 off = d * ca;
    col.r += texture2D(tDiffuse, uv - off).r - c0.r;
    col.b += texture2D(tDiffuse, uv + off).b - c0.b;
  }
  // радиальный рывок: размытие от точки удара наружу (как «зум» на мощном попадании)
  if (uPunch > 0.002) {
    vec2 dv = uv - uPunchC;
    vec3 acc = col;
    for (int i = 1; i < 8; i++) {
      float k = 1.0 - uPunch * 0.07 * float(i) / 7.0;
      acc += texture2D(tDiffuse, uPunchC + dv * k).rgb;
    }
    col = acc / 8.0;
  }
  // лучи от короны: марш от пикселя к короне, копим только яркое (корона, огни, магия)
  if (uSunVis > 0.002 && uRays > 0.0) {
    vec2 step = (uSunPos - uv) / 16.0;
    vec2 p = uv;
    float decay = 1.0, acc = 0.0;
    for (int i = 0; i < 16; i++) {
      p += step;
      vec2 pc = clamp(p, 0.0, 1.0);
      vec3 c = texture2D(tDiffuse, pc).rgb;
      acc += max(dot(c, vec3(0.2126, 0.7152, 0.0722)) - 0.55, 0.0) * decay;
      decay *= 0.93;
    }
    vec2 ds = (uv - uSunPos) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
    float fall = 1.0 - smoothstep(0.1, 1.25, length(ds));
    col += vec3(1.0, 0.84, 0.62) * (acc / 16.0) * uRays * uSunVis * fall;
  }
  col = clamp(col, 0.0, 1.0);
  // [BDO] lift/gain: чуть «холодный» пол чёрного, тёплый потолок светов
  col = col * uGain + uLift * (1.0 - col);
  // мягкий плёночный S-контраст (display space): глубже тени, плотнее середина
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uContrast);
  // split tone: бирюзовые тени, тёплые света (сдвиги цветности, яркость почти не меняется)
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float lum = dot(col, W);
  float wS = (1.0 - smoothstep(0.0, 0.45, lum)) * (0.35 + 0.65 * smoothstep(0.0, 0.1, lum));
  col += uShadowTint * wS + uHighTint * smoothstep(0.35, 1.0, lum);
  // насыщенность + vibrance: блёклое сочнее, уже насыщенное (огонь, кровь) не пережигаем
  lum = dot(col, W);
  float mxc = max(col.r, max(col.g, col.b)), mnc = min(col.r, min(col.g, col.b));
  float satNow = (mxc - mnc) / max(mxc, 1e-4);
  col = mix(vec3(lum), col, uSat + uVibrance * (1.0 - satNow));
  // vignette (elliptical, wider than tall)
  vec2 q = (vUv - 0.5) * 2.0; q.x *= 0.86;
  float r = length(q) / 1.32;
  col *= 1.0 - uVignette * smoothstep(0.42, 1.02, r);
  // film grain (luma-weighted, stronger in darks) + 1/255 dither against banding
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 911.0) - 0.5;
  col += g * uGrain * (1.0 - 0.55 * lum);
  col += (hash12(gl_FragCoord.xy * 1.37 + 17.17) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Visual Bible, разд. 16: порог 1.0 в HDR — светится только эмиссия > 1 (магия, огонь, корона), камень никогда.
// [BDO] мягче: колено 0.35 (едва-за-порогом почти не светится), радиус шире, сила чуть ниже; в светлой зоне
// (лес под солнцем, ключ ×1.5) порог растёт до 1.0 × (1 + zoneThreshold·w) — освещённый камень не «горит».
const BLOOM = { strength: 0.62, radius: 0.55, threshold: 1.0, knee: 0.35, zoneThreshold: 0.9, maxInputWidth: 1280 };
const GTAO_SCALE = 0.5; // AO targets at half the composer resolution
const GTAO_PARAMS = { radius: 0.55, distanceExponent: 1.4, thickness: 1.6, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false };
const GTAO_BLEND = 0.7;
const RAYS = { strength: 1.35 }; // лучи от короны (medium/high); на low постобработки нет
// [BDO] тонмаппинг: AgX + поправка экспозиции (у ACES в three.js зашито ×1/0.6)
const AGX = { exposure: 0.92 };
// [BDO] всплеск хроматической аберрации на ударе и ударные волны
const CA_PUNCH = { tau: 0.08 };            // затухание: через 0.25 с остаётся ~4%
const WAVE = { life: 0.45, slots: 4, autoK: 0.75 };
// [BDO] DOF меню (только high): фокус на герое в ~3 м, фон мягко размыт; плавное включение ~0.35 с
const DOF = { focus: 3.0, aperture: 0.0045, maxblur: 0.011, tau: 0.35, focusTau: 0.25 };

// [BDO] Профили грейда. Индексы полей в Float32Array — без аллокаций в кадре.
const G_CON = 0, G_SAT = 1, G_VIB = 2, G_VIG = 3, G_SH = 4, G_HI = 7, G_LIFT = 10, G_GAIN = 13, G_SHARP = 16, G_BLOOM = 17, G_CA = 18, G_GRAIN = 19, G_N = 20;
function gradeProfile(o) {
  const a = new Float32Array(G_N);
  a[G_CON] = o.contrast; a[G_SAT] = o.sat; a[G_VIB] = o.vib; a[G_VIG] = o.vignette;
  a.set(o.shadow, G_SH); a.set(o.high, G_HI); a.set(o.lift, G_LIFT); a.set(o.gain, G_GAIN);
  a[G_SHARP] = o.sharp; a[G_BLOOM] = o.bloom; a[G_CA] = o.ca; a[G_GRAIN] = o.grain;
  return a;
}
// бой / исследование: сочно, но читаемо; виньетка лёгкая (HUD по углам). Контраст/насыщенность выше, чем
// были под ACES: AgX сам по себе мягкий и блёклый, S-кривая и lift вниз возвращают глубину теней.
const GRADE_PLAY = gradeProfile({ contrast: 0.38, sat: 1.2, vib: 0.22, vignette: 0.36,
  shadow: [-0.02, 0.008, 0.026], high: [0.035, 0.014, -0.03], lift: [-0.016, -0.012, -0.004], gain: [1.03, 1.0, 0.97],
  sharp: 0.35, bloom: 1.0, ca: 0.0, grain: 0.022 });
const GRADE = {
  playing: GRADE_PLAY,
  // меню, выбор героя, экраны-панели: кинематографичнее — теплее света, глубже виньетка, плотнее тени
  menu: gradeProfile({ contrast: 0.44, sat: 1.22, vib: 0.22, vignette: 0.64,
    shadow: [-0.022, 0.008, 0.03], high: [0.05, 0.02, -0.038], lift: [-0.02, -0.015, -0.006], gain: [1.07, 1.0, 0.92],
    sharp: 0.3, bloom: 1.15, ca: 0.0, grain: 0.028 }),
  intro: gradeProfile({ contrast: 0.42, sat: 1.21, vib: 0.22, vignette: 0.52,
    shadow: [-0.021, 0.008, 0.028], high: [0.044, 0.018, -0.034], lift: [-0.018, -0.014, -0.005], gain: [1.05, 1.0, 0.95],
    sharp: 0.32, bloom: 1.1, ca: 0.0, grain: 0.026 }),
  // пауза: мир за панелью притихает (меньше цвета, чуть темнее) — интерфейс читается лучше
  paused: gradeProfile({ contrast: 0.38, sat: 0.95, vib: 0.08, vignette: 0.56,
    shadow: [-0.018, 0.006, 0.022], high: [0.024, 0.01, -0.02], lift: [-0.018, -0.014, -0.008], gain: [0.94, 0.93, 0.92],
    sharp: 0.3, bloom: 0.9, ca: 0.0, grain: 0.022 }),
  // победа: рассвет — золотисто-розовые света, приподнятые тени, больше свечения
  victory: gradeProfile({ contrast: 0.36, sat: 1.26, vib: 0.26, vignette: 0.44,
    shadow: [-0.01, 0.006, 0.02], high: [0.058, 0.03, -0.02], lift: [-0.008, -0.008, -0.006], gain: [1.09, 1.03, 0.96],
    sharp: 0.32, bloom: 1.25, ca: 0.0, grain: 0.022 }),
  // поражение: холодно и выцветше, плотная виньетка
  defeat: gradeProfile({ contrast: 0.44, sat: 0.66, vib: 0.0, vignette: 0.66,
    shadow: [-0.024, 0.002, 0.034], high: [-0.014, 0.0, 0.022], lift: [-0.02, -0.014, -0.004], gain: [0.92, 0.95, 1.0],
    sharp: 0.3, bloom: 0.8, ca: 0.0, grain: 0.03 }),
};
const MODE_OF = { playing: 'playing', intro: 'intro', paused: 'paused', victory: 'victory', defeat: 'defeat' }; // прочие экраны — 'menu'
const GRADE_TAU = 0.6; // с — плавный переход грейда между экранами

// [BDO] Модульные очереди: queueShockwave/setFocus работают и до createPostFX (main грузит postfx лениво).
let _live = null;                 // последний созданный и не уничтоженный экземпляр
const _pendingWaves = [];         // [{ u, v, k, t }] — до WAVE.slots штук
let _focusDefault = DOF.focus;
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** [BDO] Кольцо ударной волны в экранных uv (0..1, y вверх), strength 0..1. До 4 колец одновременно. */
export function queueShockwave(u, v, strength = 1) {
  try {
    if (_live) { _live.shockwave(u, v, strength); return; }
    if (!Number.isFinite(+u) || !Number.isFinite(+v)) return;
    if (_pendingWaves.length >= WAVE.slots) _pendingWaves.shift();
    _pendingWaves.push({ u: +u, v: +v, k: clamp01(+strength || 0), t: nowMs() });
  } catch (e) { /* волна — украшение, игра важнее */ }
}
/** [BDO] Фокус DOF меню в метрах (по умолчанию 3.0). */
export function setFocus(meters) {
  try {
    const m = +meters;
    if (!Number.isFinite(m) || m <= 0) return;
    _focusDefault = Math.max(0.3, Math.min(200, m));
    if (_live) _live.setFocus(_focusDefault);
  } catch (e) { /* ignore */ }
}

export function createPostFX({ THREE, renderer, scene, camera, quality = 'medium', reducedMotion = false } = {}) {
  if (!THREE || !renderer || !scene || !camera) throw new Error('[postfx] need THREE, renderer, scene, camera');
  const S = {
    tier: normTier(quality), reduced: !!reducedMotion, ready: false, failed: false, disposed: false, error: null,
    w: 1, h: 1, pr: 1, time: 0, sun: { x: 0.5, y: 0.2, vis: 0 }, punch: 0, punchC: { x: 0.5, y: 0.5 }, highLoading: false, highReady: false, highFailed: false, mods: null,
    // [BDO]
    mode: 'menu', screen: null, modeInit: false, ca: 0,
    dofLoading: false, dofFailed: false, dof: 0, focus: _focusDefault, focusTarget: _focusDefault,
    tm0: renderer.toneMapping, tmName: 'agx', tmApplied: null,
  };
  // [BDO] QA: ?tm=aces|agx — сравнить тонмаппинг на одной сцене
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('tm') : null;
    if (q === 'aces' || q === 'agx') S.tmName = q;
  } catch (e) { /* ignore */ }
  const P = {}; // passes
  let composer = null;
  const _sz = new THREE.Vector2();
  // [BDO] текущий грейд (плавно идёт к профилю экрана), итог с настроением зоны — в uniform-ы
  const gCur = new Float32Array(GRADE.menu);
  const gFin = new Float32Array(G_N);
  const waves = [];
  for (let i = 0; i < WAVE.slots; i++) waves.push({ x: 0.5, y: 0.5, age: 0, k: 0 });
  readRendererSize();

  function readRendererSize() {
    renderer.getSize(_sz);
    S.w = Math.max(1, _sz.x | 0); S.h = Math.max(1, _sz.y | 0); S.pr = renderer.getPixelRatio() || 1;
  }
  function fail(where, e) {
    if (S.failed) return;
    S.failed = true;
    S.error = `${where}: ${(e && e.message) || e}`;
    console.warn('[postfx] fallback to plain render —', S.error);
    try { destroy(); } catch (e2) { /* ignore */ }
    try { applyToneMapping(); } catch (e3) { /* ignore */ }
  }

  function canHalfFloat() {
    const ex = renderer.extensions;
    return !!(ex && (ex.has('EXT_color_buffer_float') || ex.has('EXT_color_buffer_half_float')));
  }

  async function init() {
    if (!canHalfFloat()) throw new Error('no float colour buffers (EXT_color_buffer_float)');
    const base = 'three/addons/postprocessing/';
    const [EC, RP, UB, OP, FX, SP] = await Promise.all([
      import(base + 'EffectComposer.js'), import(base + 'RenderPass.js'), import(base + 'UnrealBloomPass.js'),
      import(base + 'OutputPass.js'), import(base + 'FXAAPass.js'), import(base + 'ShaderPass.js'),
    ]);
    if (S.disposed) return false;
    S.mods = { EC, RP, UB, OP, FX, SP };
    build();
    S.ready = true;
    applyTier();
    if (S.tier === 'high') loadHigh();
    return true;
  }

  function build() {
    const { EC, RP, UB, OP, FX, SP } = S.mods;
    const rt = new THREE.WebGLRenderTarget(S.w * S.pr, S.h * S.pr, { type: THREE.HalfFloatType });
    rt.texture.name = 'AshenPost.rt';
    composer = new EC.EffectComposer(renderer, rt);
    P.render = new RP.RenderPass(scene, camera);
    P.bloom = new UB.UnrealBloomPass(new THREE.Vector2(S.w, S.h), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    P.bloom.highPassUniforms.smoothWidth.value = BLOOM.knee; // soft knee instead of a hard 0.01 edge
    {
      // Bloom is blurry anyway: cap its input resolution (cost does not grow with pixel ratio).
      const orig = P.bloom.setSize.bind(P.bloom);
      P.bloom.setSize = (w, h) => { const k = Math.min(1, BLOOM.maxInputWidth / Math.max(1, w)); orig(Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k))); };
    }
    P.output = new OP.OutputPass();
    P.fxaa = new FX.FXAAPass();
    const g = GRADE.menu;
    const V3 = (a, i) => new THREE.Vector3(a[i], a[i + 1], a[i + 2]);
    const waveU = [];
    for (let i = 0; i < WAVE.slots; i++) waveU.push(new THREE.Vector4(0.5, 0.5, 0, 0));
    P.grade = new SP.ShaderPass({
      name: 'AshenGrade',
      uniforms: {
        tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uGrain: { value: g[G_GRAIN] }, uVignette: { value: g[G_VIG] }, uCA: { value: g[G_CA] }, uCAPunch: { value: 0 },
        uSharp: { value: g[G_SHARP] }, uContrast: { value: g[G_CON] }, uSat: { value: g[G_SAT] }, uVibrance: { value: g[G_VIB] },
        uShadowTint: { value: V3(g, G_SH) }, uHighTint: { value: V3(g, G_HI) }, uLift: { value: V3(g, G_LIFT) }, uGain: { value: V3(g, G_GAIN) },
        uSunPos: { value: new THREE.Vector2(0.5, 0.2) }, uSunVis: { value: 0 }, uRays: { value: RAYS.strength },
        uPunchC: { value: new THREE.Vector2(0.5, 0.5) }, uPunch: { value: 0 },
        uWave: { value: waveU }, uWaveOn: { value: 0 },
      },
      vertexShader: GRADE_VERT, fragmentShader: GRADE_FRAG,
    });
    for (const k of ['render', 'bloom', 'output', 'fxaa', 'grade']) composer.addPass(P[k]);
    resizeComposer();
  }

  // Прячем для служебных проходов (нормали/глубина) всё, что не непрозрачная геометрия: спрайты,
  // частицы, аддитивные/прозрачные слои, небо без записи глубины — иначе они «перекрывают» то, что за ними.
  function hideNonOpaque(cache) {
    scene.traverseVisible((o) => {
      let hide = o.isPoints || o.isLine || o.isLine2 || o.isSprite || (o.userData && o.userData.noAO);
      if (!hide && o.isMesh && o.material) {
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        hide = !!m && (m.transparent === true || m.depthWrite === false || m.blending === THREE.AdditiveBlending);
      }
      if (hide) cache.push(o);
    });
    for (const o of cache) o.visible = false;
  }

  // Lazily add GTAO + SMAA for the high tier.
  function loadHigh() {
    if (S.highLoading || S.highReady || S.highFailed || S.failed || S.disposed) return;
    S.highLoading = true;
    const base = 'three/addons/postprocessing/';
    Promise.all([import(base + 'GTAOPass.js'), import(base + 'SMAAPass.js')]).then(([GT, SM]) => {
      S.highLoading = false;
      if (S.disposed || S.failed || !composer) return;
      try {
        const gtao = new GT.GTAOPass(scene, camera, Math.max(1, Math.round(S.w * S.pr * GTAO_SCALE)), Math.max(1, Math.round(S.h * S.pr * GTAO_SCALE)));
        gtao.updateGtaoMaterial(GTAO_PARAMS);
        gtao.blendIntensity = GTAO_BLEND;
        const origSet = gtao.setSize.bind(gtao);
        gtao.setSize = (w, h) => origSet(Math.max(1, Math.round(w * GTAO_SCALE)), Math.max(1, Math.round(h * GTAO_SCALE)));
        // The normal/depth pre-pass uses an opaque override material: hide everything that is not
        // opaque geometry (sprites, additive/transparent layers, no-depth-write sky), or they would
        // occlude and darken what is behind them.
        gtao._overrideVisibility = function () { hideNonOpaque(this._visibilityCache); };
        // The pre-pass must not re-render the shadow maps (RenderPass already did this frame).
        const origOverride = gtao._renderOverride.bind(gtao);
        gtao._renderOverride = (r, ...rest) => {
          const au = r.shadowMap.autoUpdate;
          r.shadowMap.autoUpdate = false;
          try { origOverride(r, ...rest); } finally { r.shadowMap.autoUpdate = au; }
        };
        const smaa = new SM.SMAAPass();
        composer.insertPass(gtao, composer.passes.indexOf(P.render) + 1);
        composer.insertPass(smaa, composer.passes.indexOf(P.fxaa) + 1);
        P.gtao = gtao; P.smaa = smaa;
        S.highReady = true;
        resizeComposer();
        applyTier();
      } catch (e) {
        S.highFailed = true;
        console.warn('[postfx] high tier (GTAO/SMAA) unavailable, using medium passes:', e);
      }
    }, (e) => { S.highLoading = false; S.highFailed = true; console.warn('[postfx] high tier modules failed to load:', e && e.message); });
  }

  // [BDO] DOF меню: BokehPass грузится лениво при первом входе в меню на high. Проход стоит до bloom
  // (размытие в линейном HDR — огни фона расплываются мягкими пятнами), выключен, когда не нужен.
  function loadDof() {
    if (P.dof || S.dofLoading || S.dofFailed || S.failed || S.disposed || !composer) return;
    S.dofLoading = true;
    import('three/addons/postprocessing/BokehPass.js').then((BP) => {
      S.dofLoading = false;
      if (S.disposed || S.failed || !composer) return;
      try {
        const dof = new BP.BokehPass(scene, camera, { focus: S.focus, aperture: DOF.aperture, maxblur: 0 });
        const origRender = dof.render.bind(dof);
        const cache = [];
        dof.render = (r, ...rest) => {
          // глубина — только непрозрачная геометрия и без повторного рендера карт теней
          const au = r.shadowMap.autoUpdate;
          r.shadowMap.autoUpdate = false;
          cache.length = 0;
          try { hideNonOpaque(cache); origRender(r, ...rest); } finally {
            for (let i = 0; i < cache.length; i++) cache[i].visible = true;
            cache.length = 0;
            r.shadowMap.autoUpdate = au;
          }
        };
        dof.enabled = false;
        composer.insertPass(dof, composer.passes.indexOf(P.bloom));
        P.dof = dof;
        resizeComposer();
      } catch (e) {
        S.dofFailed = true;
        console.warn('[postfx] DOF (BokehPass) unavailable:', e);
      }
    }, (e) => { S.dofLoading = false; S.dofFailed = true; console.warn('[postfx] BokehPass failed to load:', e && e.message); });
  }

  // [BDO] тонмаппинг: AgX на medium/high (с грейдом), исходный (ACES из main.js) на low и без composer
  function applyToneMapping() {
    const want = (active() && S.tmName === 'agx') ? THREE.AgXToneMapping : S.tm0;
    if (S.tmApplied === want && renderer.toneMapping === want) return;
    renderer.toneMapping = want;
    S.tmApplied = want;
  }

  function applyTier() {
    if (!composer) { applyToneMapping(); return; }
    const high = S.tier === 'high' && S.highReady;
    if (P.gtao) P.gtao.enabled = high;
    if (P.smaa) P.smaa.enabled = high;
    P.fxaa.enabled = !high;
    if (P.dof && S.tier !== 'high') { P.dof.enabled = false; S.dof = 0; }
    P.grade.uniforms.uGrain.value = S.reduced ? 0 : gCur[G_GRAIN];
    if (S.reduced) clearFx();
    applyToneMapping();
  }

  function resizeComposer() {
    if (!composer) return;
    composer.setPixelRatio(S.pr);
    composer.setSize(S.w, S.h);
    P.grade.uniforms.uRes.value.set(S.w * S.pr, S.h * S.pr);
  }

  function destroy() {
    for (const k of Object.keys(P)) { try { P[k].dispose(); } catch (e) { /* ignore */ } delete P[k]; }
    if (composer) { try { composer.dispose(); } catch (e) { /* ignore */ } composer = null; }
    S.ready = false;
  }

  const active = () => S.ready && !S.failed && !S.disposed && !!composer && S.tier !== 'low';

  // [BDO] всплески (CA, волны, рывок) — снять сразу (reducedMotion)
  function clearFx() {
    S.ca = 0; S.punch = 0;
    for (let i = 0; i < waves.length; i++) waves[i].k = 0;
  }

  // [BDO] грейд: профиль экрана (плавно) + настроение зоны (по w) → uniform-ы; ни одной аллокации
  function updateGrade(d) {
    const tgt = GRADE[S.mode] || GRADE_PLAY;
    const a = S.modeInit ? 1 - Math.exp(-d / GRADE_TAU) : 1;
    S.modeInit = true;
    for (let i = 0; i < G_N; i++) gCur[i] += (tgt[i] - gCur[i]) * a;
    gFin.set(gCur);
    // настроение зоны заменяет «базу» боя, отличие экрана (меню/победа/поражение) остаётся поверх:
    // fin = cur + w·(zone − play). ZONE_MOOD_STATE уже умножен на w: shadow/high/contrast = zone·w, sat = 1 + (zone−1)·w.
    const Z = ZONE_MOOD_STATE, w = Z && Number.isFinite(Z.w) ? clamp01(Z.w) : 0;
    if (w > 0.0005 && Z.grade) {
      const zg = Z.grade;
      for (let i = 0; i < 3; i++) {
        gFin[G_SH + i] += (+zg.shadow[i] || 0) - w * GRADE_PLAY[G_SH + i];
        gFin[G_HI + i] += (+zg.high[i] || 0) - w * GRADE_PLAY[G_HI + i];
      }
      gFin[G_SAT] += (Number.isFinite(zg.sat) ? zg.sat : 1) - 1 + w - w * GRADE_PLAY[G_SAT];
      gFin[G_CON] += (+zg.contrast || 0) - w * GRADE_PLAY[G_CON];
    }
    const U = P.grade.uniforms;
    U.uContrast.value = gFin[G_CON]; U.uSat.value = gFin[G_SAT]; U.uVibrance.value = gFin[G_VIB]; U.uVignette.value = gFin[G_VIG];
    U.uShadowTint.value.set(gFin[G_SH], gFin[G_SH + 1], gFin[G_SH + 2]);
    U.uHighTint.value.set(gFin[G_HI], gFin[G_HI + 1], gFin[G_HI + 2]);
    U.uLift.value.set(gFin[G_LIFT], gFin[G_LIFT + 1], gFin[G_LIFT + 2]);
    U.uGain.value.set(gFin[G_GAIN], gFin[G_GAIN + 1], gFin[G_GAIN + 2]);
    U.uSharp.value = gFin[G_SHARP]; U.uCA.value = gFin[G_CA];
    U.uGrain.value = S.reduced ? 0 : gFin[G_GRAIN];
    P.bloom.strength = BLOOM.strength * gFin[G_BLOOM];
    P.bloom.threshold = BLOOM.threshold * (1 + BLOOM.zoneThreshold * w);
  }

  // [BDO] всплеск CA и ударные волны: затухание и запись в uniform-ы
  function updateFx(d) {
    const U = P.grade.uniforms;
    S.ca = S.reduced ? 0 : S.ca * Math.exp(-d / CA_PUNCH.tau);
    if (S.ca < 0.003) S.ca = 0;
    U.uCAPunch.value = S.ca;
    // волны, пришедшие до создания postfx (или до готовности аддонов)
    if (_pendingWaves.length) {
      const t = nowMs();
      for (let i = 0; i < _pendingWaves.length; i++) {
        const q = _pendingWaves[i], age = (t - q.t) / 1000;
        if (age < WAVE.life) addWave(q.u, q.v, q.k, age);
      }
      _pendingWaves.length = 0;
    }
    let on = 0;
    for (let i = 0; i < waves.length; i++) {
      const wv = waves[i], u = U.uWave.value[i];
      if (wv.k > 0) {
        wv.age += d;
        if (wv.age >= WAVE.life || S.reduced) wv.k = 0;
      }
      if (wv.k > 0) { on = 1; u.set(wv.x, wv.y, wv.age / WAVE.life, wv.k); } else if (u.w !== 0) u.w = 0;
    }
    U.uWaveOn.value = on;
  }
  function addWave(x, y, k, age = 0) {
    if (S.reduced || !(k > 0)) return;
    let slot = null;
    for (let i = 0; i < waves.length; i++) { if (waves[i].k <= 0) { slot = waves[i]; break; } }
    if (!slot) { slot = waves[0]; for (let i = 1; i < waves.length; i++) if (waves[i].age > slot.age) slot = waves[i]; }
    slot.x = x; slot.y = y; slot.k = clamp01(k); slot.age = Math.max(0, age);
  }

  // [BDO] DOF: только high, только меню; плавно; фокус тоже сглажен
  function updateDof(d) {
    const want = S.tier === 'high' && S.mode === 'menu' && !S.dofFailed;
    if (want && !P.dof) loadDof();
    if (!P.dof) return;
    const tgt = want ? 1 : 0;
    S.dof += (tgt - S.dof) * (1 - Math.exp(-d / DOF.tau));
    if (!want && S.dof < 0.01) S.dof = 0;
    S.focus += (S.focusTarget - S.focus) * (1 - Math.exp(-d / DOF.focusTau));
    P.dof.enabled = S.dof > 0.001;
    if (P.dof.enabled) {
      const u = P.dof.uniforms;
      u.maxblur.value = DOF.maxblur * S.dof;
      u.focus.value = S.focus;
      u.aperture.value = DOF.aperture;
      u.aspect.value = camera.aspect || (S.w / S.h);
    }
  }

  function render(dt) {
    if (S.disposed) return;
    if (!active()) { applyToneMapping(); renderer.render(scene, camera); return; }
    renderer.getSize(_sz);
    const pr = renderer.getPixelRatio() || 1;
    if ((_sz.x | 0) !== S.w || (_sz.y | 0) !== S.h || pr !== S.pr) { S.w = Math.max(1, _sz.x | 0); S.h = Math.max(1, _sz.y | 0); S.pr = pr; resizeComposer(); }
    const d = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 1 / 60;
    S.time = (S.time + d) % 1000;
    P.grade.uniforms.uTime.value = S.reduced ? 0 : S.time;
    // лучи короны и радиальный рывок: сглаживание видимости, затухание рывка
    const U = P.grade.uniforms;
    U.uSunPos.value.set(S.sun.x, S.sun.y);
    U.uSunVis.value += (S.sun.vis - U.uSunVis.value) * (1 - Math.exp(-d * 6));
    S.punch = S.reduced ? 0 : S.punch * Math.exp(-d * 7);
    U.uPunch.value = S.punch;
    U.uPunchC.value.set(S.punchC.x, S.punchC.y);
    // [BDO] грейд, всплески, DOF — ошибка здесь не должна ронять кадр
    try { updateGrade(d); updateFx(d); updateDof(d); } catch (e) { if (!S.fxWarned) { S.fxWarned = true; console.warn('[postfx] grade/fx update:', e); } }
    applyToneMapping();
    // The composer calls renderer.render()/fullscreen quads several times per frame; with the default
    // info.autoReset only the last quad would be counted. Accumulate the whole frame instead, so
    // renderer.info.render.calls/triangles keep meaning "this frame" for QA/diagnostics.
    const info = renderer.info;
    const autoReset = info.autoReset;
    // [BDO] поправка экспозиции под AgX только на время composer (atmosphere пишет экспозицию каждый кадр)
    const ex = renderer.toneMappingExposure;
    const exK = renderer.toneMapping === THREE.AgXToneMapping ? AGX.exposure : 1;
    info.autoReset = false;
    info.reset();
    try {
      renderer.toneMappingExposure = ex * exK;
      composer.render(d);
    } catch (e) {
      renderer.toneMappingExposure = ex;
      fail('render', e);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    } finally {
      renderer.toneMappingExposure = ex;
      info.autoReset = autoReset;
    }
  }

  function setSize(w, h, pixelRatio) {
    S.w = Math.max(1, Math.round(+w || 1)); S.h = Math.max(1, Math.round(+h || 1));
    S.pr = Number.isFinite(+pixelRatio) && +pixelRatio > 0 ? +pixelRatio : (renderer.getPixelRatio() || 1);
    if (composer) { try { resizeComposer(); } catch (e) { fail('setSize', e); } }
  }

  function setQuality(q) {
    const t = normTier(q);
    if (t !== S.tier) clearFx(); // [BDO] не доигрывать застрявшие волны после смены уровня
    S.tier = t;
    if (S.tier === 'high') loadHigh();
    try { applyTier(); } catch (e) { fail('setQuality', e); }
  }

  // Корона затмения на экране (uv 0..1, y вверх); vis 0..1 — за кадром/сзади гаснет плавно.
  function setSun(x, y, vis) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { S.sun.vis = 0; return; }
    S.sun.x = x; S.sun.y = y; S.sun.vis = Math.max(0, Math.min(1, +vis || 0));
  }
  // Радиальный рывок экрана от точки (uv) — мощное попадание, выброс, руна.
  // [BDO] + всплеск хроматической аберрации (~0.25 с) и, при k ≥ 0.75, кольцо ударной волны.
  function punch(strength, x = 0.5, y = 0.5) {
    if (S.reduced) return;
    const k = Math.max(0, Math.min(1, +strength || 0));
    const px = Number.isFinite(x) ? x : 0.5, py = Number.isFinite(y) ? y : 0.5;
    if (k > S.punch) { S.punch = k; S.punchC.x = px; S.punchC.y = py; }
    try {
      if (k > S.ca) S.ca = k;
      if (k >= WAVE.autoK) addWave(px, py, 0.55 + 0.45 * k);
    } catch (e) { /* ignore */ }
  }
  // [BDO] кольцо ударной волны (для №7 [VFX] через queueShockwave)
  function shockwave(u, v, strength = 1) {
    if (S.reduced || S.disposed || !active()) return;
    const x = +u, y = +v;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try { addWave(x, y, clamp01(+strength || 0)); } catch (e) { /* ignore */ }
  }

  // [BDO] Экран игры → профиль грейда и DOF. Зовётся каждый кадр: дёшево, ранний выход без изменений.
  function setMode(screen, settings) {
    if (screen === S.screen) return;
    S.screen = screen;
    S.mode = MODE_OF[screen] || 'menu';
    void settings; // качество приходит через setQuality, reducedMotion — через setReducedMotion
  }
  function setFocus(meters) {
    const m = +meters;
    if (!Number.isFinite(m) || m <= 0) return;
    S.focusTarget = Math.max(0.3, Math.min(200, m));
    if (!S.modeInit) S.focus = S.focusTarget;
  }
  // [BDO] QA: 'agx' | 'aces'
  function setToneMapping(name) {
    if (name !== 'agx' && name !== 'aces') return;
    S.tmName = name;
    try { applyToneMapping(); } catch (e) { /* ignore */ }
  }

  function setReducedMotion(b) {
    S.reduced = !!b;
    try { applyTier(); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (S.disposed) return;
    S.disposed = true;
    destroy();
    try { renderer.toneMapping = S.tm0; } catch (e) { /* ignore */ }
    if (_live === api) _live = null;
  }

  const whenReady = init().then((ok) => !!ok && !S.failed, (e) => { fail('init', e); return false; });

  const api = {
    render, setSize, setQuality, setReducedMotion, setSun, punch, dispose, whenReady,
    setMode, setFocus, shockwave, setToneMapping, // [BDO]
    get enabled() { return active(); },
    get ready() { return S.ready && !S.failed; },
    get tier() { return S.tier; },
    get error() { return S.error; },
    info() {
      const tm = renderer.toneMapping === THREE.AgXToneMapping ? 'agx' : renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'aces' : String(renderer.toneMapping);
      let wavesOn = 0;
      for (let i = 0; i < waves.length; i++) if (waves[i].k > 0) wavesOn++;
      return {
        tier: S.tier, enabled: active(), ready: S.ready, failed: S.failed, error: S.error, highReady: S.highReady,
        size: [S.w, S.h, S.pr], passes: composer ? composer.passes.filter((p) => p.enabled).map((p) => (p.constructor && p.constructor.name) || '?') : [],
        toneMapping: tm, mode: S.mode, screen: S.screen, zoneW: +(ZONE_MOOD_STATE.w || 0).toFixed(3),
        dof: +S.dof.toFixed(3), focus: +S.focus.toFixed(2), ca: +S.ca.toFixed(3), waves: wavesOn,
        grade: { contrast: +gFin[G_CON].toFixed(3), sat: +gFin[G_SAT].toFixed(3), vignette: +gFin[G_VIG].toFixed(3), sharp: +gFin[G_SHARP].toFixed(2) },
      };
    },
  };
  // [BDO] QA/стенд (dev/postfx-stand.html): подбор констант грейда на одной сцене; игра это не использует
  Object.defineProperty(api, '_qa', { enumerable: false, value: Object.freeze({
    AGX, BLOOM, DOF, WAVE, GRADE,
    idx: { contrast: G_CON, sat: G_SAT, vib: G_VIB, vignette: G_VIG, shadow: G_SH, high: G_HI, lift: G_LIFT, gain: G_GAIN, sharp: G_SHARP, bloom: G_BLOOM, ca: G_CA, grain: G_GRAIN },
    snap() { S.modeInit = false; },
  }) });
  _live = api;
  return api;
}
