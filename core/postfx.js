/*
 * ASHEN OATH — core/postfx.js. Owner: #3 (visuals).
 *
 * export function createPostFX({ THREE, renderer, scene, camera, quality, reducedMotion })
 *   -> { render(dt), setSize(w, h, pixelRatio), setQuality('low'|'medium'|'high'),
 *        setReducedMotion(bool), dispose(), get enabled(), get ready(), get tier(), get error(),
 *        whenReady: Promise<boolean>, info() }
 *
 * createPostFX returns immediately. The addons are loaded with dynamic import('three/addons/...')
 * (the importmap in index.html maps them to three@0.185.1). Until they are ready, on 'low', and after
 * any failure, render() is a plain renderer.render(scene, camera) and `enabled` is false.
 *
 * Tiers
 *   low    — plain render, no composer at all.
 *   medium — RenderPass → UnrealBloom (high threshold: only emissive magic/embers/moon)
 *            → OutputPass (tone mapping + sRGB) → FXAA → Grade (contrast, split tone, vignette,
 *            edge chromatic aberration, animated grain unless reducedMotion) → screen.
 *   high   — RenderPass → GTAO (half resolution, modest) → Bloom → Output → SMAA → Grade.
 *            GTAO/SMAA are loaded lazily the first time 'high' is requested; until then high = medium.
 *   [HERO] menu (medium/high): + Bokeh DOF after RenderPass/GTAO — setMode(screen) turns it on only for
 *            'menu', setFocus(metres) is fed by heroShowcase (distance to the hero / to the face).
 *
 * Tone mapping / colour space — what main.js must do:
 *   Keep renderer.toneMapping = ACESFilmicToneMapping and renderer.outputColorSpace = SRGBColorSpace
 *   exactly as now. three.js applies tone mapping and the sRGB transfer only when rendering to the
 *   canvas (render target null), so RenderPass writes linear HDR into the composer's HalfFloat
 *   targets and OutputPass applies renderer.toneMapping / toneMappingExposure / outputColorSpace once.
 *   The grade pass after it works in display space and uses no tone-mapping/colour-space chunks.
 *   Nothing is applied twice. main should NOT set toneMapping to NoToneMapping.
 *   The canvas MSAA (antialias:true) is unused while the composer is active (FXAA/SMAA do AA).
 * Sizing: call setSize(cssW, cssH, renderer.getPixelRatio()) after renderer.setSize/setPixelRatio.
 *   render() also re-syncs automatically if the renderer size or pixel ratio changed.
 *
 * [W3-КИНО] Экранные события боя (публичный API для эффектов, ультимейта, финала):
 *   postfx.pulse(kind, strength = 1, screenPos?, opts?) -> bool (принят ли импульс)
 *   import { pulse } from 'core/postfx.js' — то же для всех живых экземпляров (без ссылки на postfx).
 *     kind: 'shockwave' (рябь-искажение кольцом от точки), 'dash' (радиальное размытие рывка),
 *           'punch' (короткий радиальный рывок удара), 'hurt' (красная аберрация и виньетка — героя ранили),
 *           'flash' (засветка; opts.color — 0xRRGGBB или [r,g,b], opts.dur — спад, с), 'ultimate' (засветка +
 *           волна + рывок разом), 'bars' (кинорамка: strength — высота 0..1, opts.hold — сколько держать, с).
 *     strength 0..1. screenPos: {x, y} — uv экрана 0..1 (y вверх) | [x, y] | мировая точка {x, y, z}
 *           (проецируется камерой; за спиной камеры — волна не ставится). Без screenPos — центр экрана.
 *     Время импульсов — реальное (render(dtReal)), замедление боя их не растягивает.
 *     reducedMotion: без волн и размытий, засветка вдвое слабее. 'low': только дешёвое — виньетка, тон фазы,
 *     ранение, засветка, кинорамка (один полноэкранный треугольник поверх кадра, без копии кадра).
 *   queueShockwave(u, v, strength) — контракт modules/fx/kit.js (distort): волна в uv.
 *   postfx.setLook(look) — цвет по фазам боя, каждый кадр из world.atmosphere.look:
 *     { red (фаза 2), dawn (победа), dark (поражение), zone (вес зоны-леса: там прежний грейд) }.
 *     Фаза 1 — холодная синь в тенях и золото в светах, фаза 2 — багровые тени и виньетка, лучи краснеют.
 *   high: лучи от короны — отдельный проход в половинном разрешении по HDR (порог по яркости, 40 шагов
 *     с дрожанием), на medium — прежние 16 шагов внутри грейда.
 */

const TIERS = ['low', 'medium', 'high'];
const normTier = (q) => (TIERS.includes(q) ? q : 'medium');

// Display-space grade. Works on the output of OutputPass (+AA), writes to the canvas.
const GRADE_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GRADE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tRays;   // [W3-КИНО] лучи high (половинное разрешение, HDR)
uniform vec2 uRes;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform vec3 uVigTint;     // [W3-КИНО] цвет края виньетки (0 — чёрная, багровая в фазе 2)
uniform float uCA;
uniform float uContrast;
uniform float uSat;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform vec2 uSunPos;      // экранные uv короны затмения
uniform float uSunVis;     // 0 — корона за кадром/сзади
uniform float uRays;       // сила лучей
uniform float uRaysHQ;     // [W3-КИНО] 1 — лучи из tRays (high)
uniform vec3 uRaysTint;    // [W3-КИНО] цвет лучей по фазе
uniform vec2 uPunchC;      // центр удара (uv)
uniform float uPunch;      // доля радиального размытия (рывок удара, рывок героя)
uniform vec4 uWaves[4];    // [W3-КИНО] волны: xy — центр (uv), z — радиус (доли высоты), w — амплитуда (uv)
uniform float uWaveOn;
uniform float uWaveW;      // ширина фронта волны
uniform float uHurt;       // [W3-КИНО] 0..1 героя ранили
uniform vec4 uFlash;       // [W3-КИНО] rgb — цвет засветки, a — сила
uniform float uBars;       // [W3-КИНО] кинорамка 0..1
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float aspect = uRes.x / max(uRes.y, 1.0);
  // ударные волны: смещение uv производной гауссианы — впереди фронта толкает наружу, за ним тянет внутрь
  vec2 uv = vUv;
  vec2 wOff = vec2(0.0);
  float wGlow = 0.0;
  if (uWaveOn > 0.5) {
    for (int i = 0; i < 4; i++) {
      vec4 w = uWaves[i];
      if (w.w > 0.00005) {
        vec2 dv = (vUv - w.xy) * vec2(aspect, 1.0);
        float dl = length(dv);
        float x = (dl - w.z) / uWaveW;
        float g = exp(-x * x);
        wOff += (dv / max(dl, 1e-4)) * (-x * g * w.w);
        wGlow += g * w.w;
      }
    }
    wOff /= vec2(aspect, 1.0);
    uv += wOff;
  }
  vec2 d = uv - 0.5;
  vec2 off = d * ((uCA + uHurt * 0.05) * dot(d, d));   // grows toward the corners, ~0 in the centre
  vec3 col;
  col.r = texture2D(tDiffuse, uv - off + wOff * 0.4).r;  // на фронте волны каналы расходятся — радужная кромка
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv + off - wOff * 0.4).b;
  // радиальное размытие от точки (рывок экрана на сильном попадании, рывок героя)
  if (uPunch > 0.0005) {
    vec2 dv = uv - uPunchC;
    vec3 acc = col;
    for (int i = 1; i < 8; i++) {
      float k = 1.0 - uPunch * float(i) / 7.0;
      acc += texture2D(tDiffuse, uPunchC + dv * k).rgb;
    }
    col = acc / 8.0;
  }
  // лучи от короны
  if (uSunVis > 0.002 && uRays > 0.0) {
    vec2 ds = (vUv - uSunPos) * vec2(aspect, 1.0);
    float fall = 1.0 - smoothstep(0.1, 1.25, length(ds));
    if (uRaysHQ > 0.5) {
      vec3 r = texture2D(tRays, vUv).rgb;
      col += (vec3(1.0) - exp(-r * 1.5)) * uRaysTint * uRays * uSunVis * (0.35 + 0.65 * fall);
    } else {
      // марш от пикселя к короне, копим только яркое (корона, огни, магия)
      vec2 step = (uSunPos - vUv) / 16.0;
      vec2 p = vUv;
      float decay = 1.0, acc = 0.0;
      for (int i = 0; i < 16; i++) {
        p += step;
        vec2 pc = clamp(p, 0.0, 1.0);
        vec3 c = texture2D(tDiffuse, pc).rgb;
        acc += max(dot(c, W) - 0.55, 0.0) * decay;
        decay *= 0.93;
      }
      col += uRaysTint * (acc / 16.0) * uRays * uSunVis * fall;
    }
  }
  col += vec3(1.0, 0.9, 0.78) * min(wGlow * 1.6, 0.12);   // горячий воздух на фронте волны
  col = clamp(col, 0.0, 1.0);
  // gentle filmic S-curve (display space)
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uContrast);
  // split tone: cool shadows, warm highlights (chroma offsets, luminance kept)
  float lum = dot(col, W);
  col += uShadowTint * (1.0 - smoothstep(0.0, 0.42, lum)) + uHighTint * smoothstep(0.38, 1.0, lum);
  lum = dot(col, W);
  col = mix(vec3(lum), col, uSat);
  // vignette (elliptical, wider than tall); край тонируется uVigTint
  vec2 q = (vUv - 0.5) * 2.0; q.x *= 0.86;
  float r = length(q) / 1.32;
  col *= mix(vec3(1.0), uVigTint, uVignette * smoothstep(0.42, 1.02, r));
  // ранение: края в кровь, середина почти не тронута
  if (uHurt > 0.001) {
    float he = 0.18 + 0.82 * smoothstep(0.3, 1.0, r);   // середина чуть краснеет, края — в кровь
    float l2 = dot(col, W);
    col = mix(col, vec3(l2 * 1.15 + 0.07, l2 * 0.16, l2 * 0.14), clamp(uHurt * he * 0.85, 0.0, 1.0));
  }
  // засветка (screen-смешение к цвету вспышки)
  col = vec3(1.0) - (vec3(1.0) - col) * (vec3(1.0) - uFlash.rgb * uFlash.a);
  // film grain (luma-weighted, stronger in darks) + 1/255 dither against banding
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 911.0) - 0.5;
  col += g * uGrain * (1.0 - 0.55 * lum);
  col += (hash12(gl_FragCoord.xy * 1.37 + 17.17) - 0.5) / 255.0;
  // кинорамка — поверх всего, чистый чёрный
  if (uBars > 0.0005) {
    float bh = uBars * 0.12, px = 1.0 / max(uRes.y, 1.0);
    col *= 1.0 - smoothstep(0.5 - bh - px, 0.5 - bh + px, abs(vUv.y - 0.5));
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// [W3-КИНО] Лучи от короны для high: половинное разрешение, читает HDR сразу после RenderPass (до bloom),
// копит только то, что ярче порога (корона, магия, жаровни), 40 шагов с дрожанием — без полос.
const RAYS_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uSun;
uniform float uThresh;
uniform float uDensity;
uniform float uDecay;
uniform float uTime;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  vec2 stepv = (uSun - vUv) * (uDensity / 40.0);
  vec2 p = vUv + stepv * hash12(gl_FragCoord.xy + fract(uTime) * 61.0);
  vec3 acc = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < 40; i++) {
    p += stepv;
    vec3 c = texture2D(tDiffuse, clamp(p, 0.0, 1.0)).rgb;
    float l = dot(c, W);
    acc += c * (max(l - uThresh, 0.0) / max(l, 1e-3)) * decay;
    decay *= uDecay;
  }
  gl_FragColor = vec4(min(acc / 40.0, vec3(8.0)), 1.0);
}`;

// [W3-КИНО] low (и пока композер не готов): поверх обычного кадра один треугольник на весь экран.
// Смешение out = src + dst·(1 − a): слои «смешать dst с цветом c на долю k» складываются в одну пару (c, a).
const OVERLAY_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const OVERLAY_FRAG = /* glsl */`
uniform vec2 uRes;
uniform float uVignette;
uniform vec3 uVigTint;
uniform vec4 uTint;
uniform float uHurt;
uniform vec4 uFlash;
uniform float uBars;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  float a = 0.0, k;
  vec2 q = (vUv - 0.5) * 2.0; q.x *= 0.86;
  float r = length(q) / 1.32;
  k = uTint.a;                                         // тон фазы
  c = c * (1.0 - k) + uTint.rgb * k; a = 1.0 - (1.0 - a) * (1.0 - k);
  k = uVignette * smoothstep(0.42, 1.02, r) * 0.85;    // виньетка с оттенком края
  c = c * (1.0 - k) + uVigTint * 0.12 * k; a = 1.0 - (1.0 - a) * (1.0 - k);
  k = clamp(uHurt * (0.12 + 0.88 * smoothstep(0.3, 1.0, r)) * 0.7, 0.0, 1.0);   // ранение
  c = c * (1.0 - k) + vec3(0.36, 0.0, 0.01) * k; a = 1.0 - (1.0 - a) * (1.0 - k);
  k = uFlash.a;                                        // засветка
  c = c * (1.0 - k) + uFlash.rgb * k; a = 1.0 - (1.0 - a) * (1.0 - k);
  float bh = uBars * 0.12, px = 1.0 / max(uRes.y, 1.0);
  k = step(0.0005, uBars) * smoothstep(0.5 - bh - px, 0.5 - bh + px, abs(vUv.y - 0.5));   // кинорамка
  c = c * (1.0 - k); a = 1.0 - (1.0 - a) * (1.0 - k);
  gl_FragColor = vec4(c, a);
}`;

// Visual Bible, разд. 16: порог 1.0 в HDR — светится только эмиссия > 1 (магия, огонь, корона), камень никогда.
const BLOOM = { strength: 0.7, radius: 0.42, threshold: 1.0, knee: 0.15, maxInputWidth: 1280 };
const GTAO_SCALE = 0.5; // AO targets at half the composer resolution
const GTAO_PARAMS = { radius: 0.55, distanceExponent: 1.4, thickness: 1.6, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false };
const GTAO_BLEND = 0.7;
const RAYS = { strength: 1.35 }; // лучи от короны (medium/high); на low постобработки нет
// [HERO] глубина резкости витрины меню: размытие = (фокус − дистанция) · aperture (доли экрана), не больше maxblur
const DOF = { aperture: 0.0022, maxblur: 0.009 };
const GRADE = { grain: 0.036, vignette: 0.45, ca: 0.0, contrast: 0.16, sat: 1.04,
  shadowTint: [-0.010, 0.002, 0.026], highTint: [0.028, 0.010, -0.020] };

// [W3-КИНО] Цвет по фазам боя. base — прежний грейд (меню, лес); p1 — холодная синь и золото;
// p2 — Регент в ярости: багровые тени, красная виньетка, лучи краснеют; dawn — победа; dark — поражение.
// tint/tintA — тон кадра на low (там нет грейда, только наложение).
const LOOK = {
  base: { shadow: GRADE.shadowTint, high: GRADE.highTint, sat: GRADE.sat, contrast: GRADE.contrast, vignette: GRADE.vignette, vig: [0, 0, 0], rays: [1.0, 0.84, 0.62], ca: 0, tint: [0, 0, 0], tintA: 0 },
  p1: { shadow: [-0.026, 0.004, 0.052], high: [0.052, 0.03, -0.034], sat: 1.08, contrast: 0.24, vignette: 0.52, vig: [0.0, 0.01, 0.04], rays: [1.0, 0.82, 0.52], ca: 0.0015, tint: [0.03, 0.06, 0.16], tintA: 0.06 },
  p2: { shadow: [0.066, -0.016, -0.012], high: [0.07, 0.004, -0.05], sat: 1.14, contrast: 0.3, vignette: 0.68, vig: [0.5, 0.03, 0.02], rays: [1.0, 0.36, 0.22], ca: 0.004, tint: [0.32, 0.02, 0.02], tintA: 0.12 },
  dawn: { shadow: [0.0, 0.006, 0.022], high: [0.062, 0.04, 0.0], sat: 1.1, contrast: 0.16, vignette: 0.34, vig: [0.12, 0.07, 0.0], rays: [1.0, 0.9, 0.68], ca: 0, tint: [0.3, 0.2, 0.06], tintA: 0.05 },
  dark: { shadow: [-0.012, 0.0, 0.03], high: [0.0, -0.004, 0.004], sat: 0.6, contrast: 0.2, vignette: 0.7, vig: [0, 0, 0], rays: [0.8, 0.85, 0.95], ca: 0, tint: [0.02, 0.03, 0.06], tintA: 0.1 },
};
// [W3-КИНО] Импульсы. Волна: радиус растёт до r1·(доли высоты) с замедлением, амплитуда в uv гаснет к концу.
const PULSE = {
  wave: { dur: 0.8, r1: 0.95, amp: 0.05, width: 0.07, min: 0.15, mergeUv: 0.06, mergeSec: 0.12 },
  punchK: 0.07, dashK: 0.13, dashTau: 0.17, hurtTau: 0.4,
  flash: { tau: 0.24, minGap: 0.2, reducedK: 0.5 },
  bars: { hold: 1.5, rate: 5 },
};
const RAYS_HQ = { scale: 0.5, thresh: 1.05, density: 0.92, decay: 0.965, strength: 1.15 };
const KINDS = {
  shockwave: 'wave', wave: 'wave', distort: 'wave', ripple: 'wave',
  dash: 'dash', radial: 'dash', zoom: 'dash', blur: 'dash',
  punch: 'punch', hit: 'punch',
  hurt: 'hurt', damage: 'hurt', wound: 'hurt',
  flash: 'flash', whiteout: 'flash', light: 'flash',
  ultimate: 'ult', ult: 'ult',
  bars: 'bars', letterbox: 'bars', cinema: 'bars',
};
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const LIVE = []; // живые экземпляры — для модульных pulse()/queueShockwave()

/** [W3-КИНО] Импульс во все живые экземпляры postfx (см. заголовок). */
export function pulse(kind, strength = 1, screenPos, opts) {
  let ok = false;
  for (let i = 0; i < LIVE.length; i++) { try { ok = LIVE[i].pulse(kind, strength, screenPos, opts) || ok; } catch (e) { /* ignore */ } }
  return ok;
}
/** Контракт modules/fx/kit.js distort(): волна искажения в uv экрана (y вверх). */
export function queueShockwave(u, v, strength) {
  return pulse('shockwave', strength, { x: u, y: v });
}

export function createPostFX({ THREE, renderer, scene, camera, quality = 'medium', reducedMotion = false } = {}) {
  if (!THREE || !renderer || !scene || !camera) throw new Error('[postfx] need THREE, renderer, scene, camera');
  const S = {
    tier: normTier(quality), reduced: !!reducedMotion, ready: false, failed: false, disposed: false, error: null,
    w: 1, h: 1, pr: 1, time: 0, sun: { x: 0.5, y: 0.2, vis: 0 }, punch: 0, punchC: { x: 0.5, y: 0.5 }, highLoading: false, highReady: false, highFailed: false, mods: null,
    // [W3-КИНО] импульсы и цвет фаз
    clock: 0, bloomK: 1,
    waves: [0, 1, 2, 3].map(() => ({ x: 0.5, y: 0.5, t: 0, s: 0, at: -9 })),
    dash: 0, dashC: { x: 0.5, y: 0.5 }, hurt: 0,
    flash: 0, flashTau: PULSE.flash.tau, flashAt: -9, flashC: [1, 0.97, 0.9],
    bars: 0, barsTarget: 0, barsUntil: 0,
    lookIn: { red: 0, dawn: 0, dark: 0, zone: 0 }, lookW: 0, raysVis: 0,
    look: { shadow: [0, 0, 0], high: [0, 0, 0], sat: 1, contrast: 0, vignette: 0, vig: [0, 0, 0], rays: [1, 1, 1], ca: 0, tint: [0, 0, 0], tintA: 0 },
  };
  const P = {}; // passes
  let composer = null;
  const _sz = new THREE.Vector2();
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
    P.grade = new SP.ShaderPass({
      name: 'AshenGrade',
      uniforms: {
        tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uGrain: { value: GRADE.grain }, uVignette: { value: GRADE.vignette }, uCA: { value: GRADE.ca },
        uContrast: { value: GRADE.contrast }, uSat: { value: GRADE.sat },
        uShadowTint: { value: new THREE.Vector3(...GRADE.shadowTint) }, uHighTint: { value: new THREE.Vector3(...GRADE.highTint) },
        uSunPos: { value: new THREE.Vector2(0.5, 0.2) }, uSunVis: { value: 0 }, uRays: { value: RAYS.strength },
        uPunchC: { value: new THREE.Vector2(0.5, 0.5) }, uPunch: { value: 0 },
        // [W3-КИНО]
        tRays: { value: null }, uRaysHQ: { value: 0 }, uRaysTint: { value: new THREE.Vector3(1.0, 0.84, 0.62) },
        uVigTint: { value: new THREE.Vector3(0, 0, 0) },
        uWaves: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0.5, 0.5, 0, 0)) }, uWaveOn: { value: 0 }, uWaveW: { value: PULSE.wave.width },
        uHurt: { value: 0 }, uFlash: { value: new THREE.Vector4(1, 1, 1, 0) }, uBars: { value: 0 },
      },
      vertexShader: GRADE_VERT, fragmentShader: GRADE_FRAG,
    });
    for (const k of ['render', 'bloom', 'output', 'fxaa', 'grade']) composer.addPass(P[k]);
    resizeComposer();
  }

  // [W3-КИНО] Проход лучей high: свой HalfFloat-буфер в половинном разрешении, needsSwap=false.
  function makeRaysPass(PS) {
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    rt.texture.name = 'AshenPost.rays';
    const mat = new THREE.ShaderMaterial({
      name: 'AshenRays',
      uniforms: {
        tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uThresh: { value: RAYS_HQ.thresh },
        uDensity: { value: RAYS_HQ.density }, uDecay: { value: RAYS_HQ.decay }, uTime: { value: 0 },
      },
      vertexShader: GRADE_VERT, fragmentShader: RAYS_FRAG, depthTest: false, depthWrite: false,
    });
    const quad = new PS.FullScreenQuad(mat);
    const pass = new PS.Pass();
    pass.needsSwap = false;
    pass.rt = rt; pass.mat = mat;
    pass.setSize = (w, h) => rt.setSize(Math.max(2, Math.round(w * RAYS_HQ.scale)), Math.max(2, Math.round(h * RAYS_HQ.scale)));
    pass.render = (r, writeBuffer, readBuffer) => {
      // корона за кадром — проход не нужен (грейд тоже не читает tRays)
      if (P.grade.uniforms.uRaysHQ.value < 0.5) return;
      mat.uniforms.tDiffuse.value = readBuffer.texture;
      mat.uniforms.uSun.value.set(S.sun.x, S.sun.y);
      mat.uniforms.uTime.value = S.reduced ? 0 : S.time;
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt);
      quad.render(r);
      r.setRenderTarget(prev);
    };
    pass.warm = (r) => {
      const prev = r.getRenderTarget();
      try { r.setRenderTarget(rt); quad.render(r); } finally { r.setRenderTarget(prev); }
    };
    pass.dispose = () => { rt.dispose(); mat.dispose(); quad.dispose(); };
    return pass;
  }

  // Lazily add GTAO + SMAA for the high tier.
  function loadHigh() {
    if (S.highLoading || S.highReady || S.highFailed || S.failed || S.disposed) return;
    S.highLoading = true;
    const base = 'three/addons/postprocessing/';
    Promise.all([import(base + 'GTAOPass.js'), import(base + 'SMAAPass.js'), import(base + 'Pass.js')]).then(([GT, SM, PS]) => {
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
        gtao._overrideVisibility = function () {
          const cache = this._visibilityCache;
          this.scene.traverseVisible((o) => {
            let hide = o.isPoints || o.isLine || o.isLine2 || o.isSprite || (o.userData && o.userData.noAO);
            if (!hide && o.isMesh && o.material) {
              const m = Array.isArray(o.material) ? o.material[0] : o.material;
              hide = !!m && (m.transparent === true || m.depthWrite === false || m.blending === THREE.AdditiveBlending);
            }
            if (hide) cache.push(o);
          });
          for (const o of cache) o.visible = false;
        };
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
        // [W3-КИНО] лучи HQ: сразу после GTAO, до bloom (читает HDR, пишет в свою цель, кадр не меняет)
        try {
          const rays = makeRaysPass(PS);
          composer.insertPass(rays, composer.passes.indexOf(gtao) + 1);
          P.rays = rays;
          P.grade.uniforms.tRays.value = rays.rt.texture;
          rays.warm(renderer);   // шейдер компилируется сейчас, а не когда корона впервые войдёт в кадр
        } catch (e) { console.warn('[postfx] лучи high недоступны:', e); }
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

  // [HERO] DOF витрины (экран выбора в духе BDO): BokehPass грузится при первом входе в меню, включён только
  // там. Проход глубины — без обновления карт теней и без частиц/прозрачного/аддитивного (иначе квадраты
  // точек и спрайтов попадают в глубину и размывают героя вокруг искр).
  function loadDof() {
    if (S.dofLoading || S.dofReady || S.dofFailed || !composer) return;
    S.dofLoading = true;
    import('three/addons/postprocessing/BokehPass.js').then((BK) => {
      S.dofLoading = false;
      if (S.disposed || S.failed || !composer) return;
      try {
        const pass = new BK.BokehPass(scene, camera, { focus: S.focus || 3, aperture: DOF.aperture, maxblur: DOF.maxblur });
        const orig = pass.render.bind(pass);
        const hidden = [];
        pass.render = (r, wb, rb, dt, mask) => {
          hidden.length = 0;
          scene.traverseVisible((o) => {
            let hide = o.isPoints || o.isLine || o.isSprite;
            if (!hide && o.isMesh && o.material) {
              const m = Array.isArray(o.material) ? o.material[0] : o.material;
              hide = !!m && (m.transparent === true || m.depthWrite === false || m.blending === THREE.AdditiveBlending);
            }
            if (hide) hidden.push(o);
          });
          for (const o of hidden) o.visible = false;
          const au = r.shadowMap.autoUpdate;
          r.shadowMap.autoUpdate = false;
          try { orig(r, wb, rb, dt, mask); } finally { r.shadowMap.autoUpdate = au; for (const o of hidden) o.visible = true; }
        };
        pass.enabled = S.mode === 'menu';
        composer.insertPass(pass, composer.passes.indexOf(P.render) + 1 + (P.gtao ? 1 : 0));
        P.dof = pass; S.dofReady = true;
        resizeComposer();
      } catch (e) { S.dofFailed = true; console.warn('[postfx] DOF недоступен:', e); }
    }, (e) => { S.dofLoading = false; S.dofFailed = true; console.warn('[postfx] BokehPass не загрузился:', e && e.message); });
  }
  function setMode(screen) {
    S.mode = screen;
    const want = screen === 'menu' && S.tier !== 'low';
    if (want && !S.dofReady) loadDof();
    if (P.dof) P.dof.enabled = want;
  }
  function setFocus(m) {
    if (!(m > 0)) return;
    S.focus = m;
    if (P.dof) P.dof.uniforms.focus.value = m;
  }

  function applyTier() {
    if (!composer) return;
    const high = S.tier === 'high' && S.highReady;
    if (P.gtao) P.gtao.enabled = high;
    if (P.smaa) P.smaa.enabled = high;
    if (P.rays) P.rays.enabled = high;   // [W3-КИНО]
    P.fxaa.enabled = !high;
    P.grade.uniforms.uGrain.value = S.reduced ? 0 : GRADE.grain;
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

  // [W3-КИНО] затухание импульсов и цвет фаз — в реальном времени, на любом уровне
  const LOOK_V3 = ['shadow', 'high', 'vig', 'rays', 'tint'], LOOK_F = ['sat', 'contrast', 'vignette', 'ca', 'tintA'];
  function lerpLook(out, a, b, t) {
    for (let i = 0; i < LOOK_V3.length; i++) { const k = LOOK_V3[i], o = out[k], x = a[k], y = b[k]; o[0] = x[0] + (y[0] - x[0]) * t; o[1] = x[1] + (y[1] - x[1]) * t; o[2] = x[2] + (y[2] - x[2]) * t; }
    for (let i = 0; i < LOOK_F.length; i++) { const k = LOOK_F[i]; out[k] = a[k] + (b[k] - a[k]) * t; }
  }
  function tick(d) {
    S.clock += d;
    for (const w of S.waves) if (w.s > 0) { w.t += d; if (w.t >= PULSE.wave.dur) w.s = 0; }
    S.punch = S.reduced ? 0 : S.punch * Math.exp(-d * 7);
    S.dash = S.reduced || S.dash < 1e-3 ? 0 : S.dash * Math.exp(-d / PULSE.dashTau);
    S.hurt = S.hurt < 1e-3 ? 0 : S.hurt * Math.exp(-d / PULSE.hurtTau);
    S.flash = S.flash < 1e-3 ? 0 : S.flash * Math.exp(-d / S.flashTau);
    if (S.barsUntil > 0 && S.clock >= S.barsUntil) { S.barsTarget = 0; S.barsUntil = 0; }
    S.bars += (S.barsTarget - S.bars) * (1 - Math.exp(-d * PULSE.bars.rate));
    if (Math.abs(S.bars - S.barsTarget) < 1e-3) S.bars = S.barsTarget;
    // боевой грейд: фаза 1 → фаза 2 → победа / поражение; в меню и в лесу — прежний
    S.lookW += ((S.mode === 'menu' ? 0 : 1) - S.lookW) * (1 - Math.exp(-d * 3));
    const L = S.lookIn, o = S.look;
    lerpLook(o, LOOK.p1, LOOK.p2, L.red);
    if (L.dawn > 0) lerpLook(o, o, LOOK.dawn, L.dawn);
    if (L.dark > 0) lerpLook(o, o, LOOK.dark, L.dark);
    lerpLook(o, LOOK.base, o, S.lookW * (1 - L.zone));
  }
  function waveUniforms(U) {
    let on = 0;
    for (let i = 0; i < 4; i++) {
      const w = S.waves[i], u = U.uWaves.value[i];
      if (!(w.s > 0) || S.reduced) { u.w = 0; continue; }
      const k = Math.min(1, w.t / PULSE.wave.dur), e = 1 - (1 - k) * (1 - k) * (1 - k);
      u.set(w.x, w.y, PULSE.wave.r1 * (0.55 + 0.45 * w.s) * e, PULSE.wave.amp * w.s * Math.pow(1 - k, 1.5) * Math.min(1, w.t / 0.05));
      on = 1;
    }
    U.uWaveOn.value = on;
  }
  function applyGrade(U, d) {
    const o = S.look;
    U.uShadowTint.value.set(o.shadow[0], o.shadow[1], o.shadow[2]);
    U.uHighTint.value.set(o.high[0], o.high[1], o.high[2]);
    U.uSat.value = o.sat; U.uContrast.value = o.contrast; U.uVignette.value = o.vignette; U.uCA.value = GRADE.ca + o.ca;
    U.uVigTint.value.set(o.vig[0], o.vig[1], o.vig[2]);
    U.uRaysTint.value.set(o.rays[0], o.rays[1], o.rays[2]);
    waveUniforms(U);
    // рывок героя и рывок удара — одно радиальное размытие, берём сильнейшее
    const pk = S.punch * PULSE.punchK, dk = S.dash * PULSE.dashK;
    if (dk > pk) { U.uPunch.value = dk; U.uPunchC.value.set(S.dashC.x, S.dashC.y); } else { U.uPunch.value = pk; U.uPunchC.value.set(S.punchC.x, S.punchC.y); }
    U.uHurt.value = S.hurt;
    U.uFlash.value.set(S.flashC[0], S.flashC[1], S.flashC[2], Math.min(1, S.flash));
    U.uBars.value = S.bars;
    const hq = !!(P.rays && P.rays.enabled);
    U.uRaysHQ.value = hq && U.uSunVis.value > 0.002 ? 1 : 0;
    U.uRays.value = hq ? RAYS_HQ.strength : RAYS.strength;
    if (P.bloom) P.bloom.strength = BLOOM.strength * S.bloomK * (1 + Math.min(1, S.flash) * 0.6);
  }

  // [W3-КИНО] наложение для low: создаётся при первой нужде, рисуется только если есть что рисовать
  let ov = null;
  function overlay() {
    if (ov) return ov;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mat = new THREE.ShaderMaterial({
      name: 'AshenOverlay',
      uniforms: {
        uRes: { value: new THREE.Vector2(1, 1) }, uVignette: { value: 0 }, uVigTint: { value: new THREE.Vector3() },
        uTint: { value: new THREE.Vector4() }, uHurt: { value: 0 }, uFlash: { value: new THREE.Vector4() }, uBars: { value: 0 },
      },
      vertexShader: OVERLAY_VERT, fragmentShader: OVERLAY_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    ov = { geo, mat, mesh, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
    return ov;
  }
  function drawOverlay() {
    const o = S.look, w = S.lookW;
    const vig = o.vignette * w, tintA = o.tintA * w, fl = Math.min(1, S.flash) * 0.9;
    if (vig < 0.01 && tintA < 0.004 && S.hurt < 0.01 && fl < 0.01 && S.bars < 0.002) return;
    const { mat, mesh, cam } = overlay(), U = mat.uniforms;
    U.uRes.value.set(S.w * S.pr, S.h * S.pr);
    U.uVignette.value = vig;
    U.uVigTint.value.set(o.vig[0], o.vig[1], o.vig[2]);
    U.uTint.value.set(o.tint[0], o.tint[1], o.tint[2], tintA);
    U.uHurt.value = S.hurt;
    U.uFlash.value.set(S.flashC[0], S.flashC[1], S.flashC[2], fl);
    U.uBars.value = S.bars;
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.render(mesh, cam); } finally { renderer.autoClear = ac; }
  }
  function renderPlain() {
    const info = renderer.info, autoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    try {
      renderer.render(scene, camera);
      drawOverlay();
    } finally { info.autoReset = autoReset; }
  }

  function render(dt) {
    if (S.disposed) return;
    const d = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 1 / 60;
    tick(d);   // [W3-КИНО]
    if (!active()) { renderPlain(); return; }
    renderer.getSize(_sz);
    const pr = renderer.getPixelRatio() || 1;
    if ((_sz.x | 0) !== S.w || (_sz.y | 0) !== S.h || pr !== S.pr) { S.w = Math.max(1, _sz.x | 0); S.h = Math.max(1, _sz.y | 0); S.pr = pr; resizeComposer(); }
    S.time = (S.time + d) % 1000;
    P.grade.uniforms.uTime.value = S.reduced ? 0 : S.time;
    // лучи короны и радиальный рывок: сглаживание видимости, затухание рывка
    const U = P.grade.uniforms;
    U.uSunPos.value.set(S.sun.x, S.sun.y);
    U.uSunVis.value += (S.sun.vis - U.uSunVis.value) * (1 - Math.exp(-d * 6));
    applyGrade(U, d);   // [W3-КИНО] фазы, волны, рывок, ранение, засветка, кинорамка
    // The composer calls renderer.render()/fullscreen quads several times per frame; with the default
    // info.autoReset only the last quad would be counted. Accumulate the whole frame instead, so
    // renderer.info.render.calls/triangles keep meaning "this frame" for QA/diagnostics.
    const info = renderer.info;
    const autoReset = info.autoReset;
    info.autoReset = false;
    info.reset();
    try {
      composer.render(d);
    } catch (e) {
      fail('render', e);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    } finally {
      info.autoReset = autoReset;
    }
  }

  // [W3-КИНО] ---------------------------------------------------------------- импульсы
  const _pv = new THREE.Vector3();
  const _uv = { x: 0.5, y: 0.5, ok: true };
  function toUv(pos) {
    _uv.x = 0.5; _uv.y = 0.5; _uv.ok = true;
    if (!pos) return _uv;
    if (Array.isArray(pos)) {
      if (Number.isFinite(+pos[0]) && Number.isFinite(+pos[1])) { _uv.x = +pos[0]; _uv.y = +pos[1]; }
      return _uv;
    }
    if (typeof pos === 'object' && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      if (Number.isFinite(pos.z)) {   // мировая точка
        _pv.set(pos.x, pos.y, pos.z).project(camera);
        if (!(_pv.z < 1) || Math.abs(_pv.x) > 1.6 || Math.abs(_pv.y) > 1.6) { _uv.ok = false; return _uv; }
        _uv.x = _pv.x * 0.5 + 0.5; _uv.y = _pv.y * 0.5 + 0.5;
      } else { _uv.x = pos.x; _uv.y = pos.y; }
    }
    return _uv;
  }
  function addWave(p, k) {
    const W = PULSE.wave;
    if (S.reduced || !p.ok || k < W.min || !active()) return false;
    let slot = null, weakest = Infinity;
    for (const w of S.waves) {
      if (w.s > 0 && w.t < W.mergeSec && Math.abs(w.x - p.x) < W.mergeUv && Math.abs(w.y - p.y) < W.mergeUv) { w.s = Math.max(w.s, k); return true; }
      const left = w.s > 0 ? w.s * (1 - w.t / W.dur) : -1;
      if (left < weakest) { weakest = left; slot = w; }
    }
    slot.x = p.x; slot.y = p.y; slot.t = 0; slot.s = k;
    return true;
  }
  function addFlash(k, o) {
    const F = PULSE.flash;
    if (S.clock - S.flashAt < F.minGap) k *= 0.5;   // без стробоскопа
    if (S.reduced) k *= F.reducedK;
    if (k < S.flash) return true;
    S.flash = k; S.flashAt = S.clock;
    S.flashTau = o && Number.isFinite(+o.dur) && +o.dur > 0 ? +o.dur : F.tau;
    const c = o && o.color;
    if (typeof c === 'number') { S.flashC[0] = ((c >> 16) & 255) / 255; S.flashC[1] = ((c >> 8) & 255) / 255; S.flashC[2] = (c & 255) / 255; }
    else if (Array.isArray(c) && c.length >= 3) { S.flashC[0] = clamp01(+c[0]); S.flashC[1] = clamp01(+c[1]); S.flashC[2] = clamp01(+c[2]); }
    else { S.flashC[0] = 1; S.flashC[1] = 0.97; S.flashC[2] = 0.9; }
    return true;
  }
  function setCinema(k, hold = 0) {
    S.barsTarget = clamp01(+k || 0);
    S.barsUntil = S.barsTarget > 0 && hold > 0 ? S.clock + hold : 0;
  }
  function pulseFn(kind, strength = 1, pos, opts) {
    if (S.disposed) return false;
    const kd = KINDS[String(kind || '').toLowerCase()];
    if (!kd) return false;
    const k = clamp01(Number.isFinite(+strength) ? +strength : 1);
    const o = opts && typeof opts === 'object' ? opts : null;
    if (kd === 'bars') { setCinema(k, o && Number.isFinite(+o.hold) ? +o.hold : PULSE.bars.hold); return true; }
    if (!(k > 0)) return false;
    const p = toUv(pos);
    switch (kd) {
      case 'wave': return addWave(p, k);
      case 'dash':
        if (S.reduced || !p.ok) return false;
        if (k >= S.dash) { S.dash = k; S.dashC.x = p.x; S.dashC.y = p.y; }
        return true;
      case 'punch': if (S.reduced) return false; punch(k, p.ok ? p.x : 0.5, p.ok ? p.y : 0.5); return true;
      case 'hurt': S.hurt = Math.max(S.hurt, k); return true;
      case 'flash': return addFlash(k, o);
      case 'ult':
        addFlash(k, o || { dur: 0.5 });
        addWave(p, k);
        if (!S.reduced && p.ok && k * 0.8 >= S.dash) { S.dash = k * 0.8; S.dashC.x = p.x; S.dashC.y = p.y; }
        return true;
      default: return false;
    }
  }
  const n01 = (v) => clamp01(Number.isFinite(+v) ? +v : 0);
  function setLook(look) {
    const L = S.lookIn, n = n01;
    if (!look || typeof look !== 'object') { L.red = 0; L.dawn = 0; L.dark = 0; L.zone = 0; return; }
    L.red = n(look.red); L.dawn = n(look.dawn); L.dark = n(look.dark); L.zone = n(look.zone);
  }

  function setSize(w, h, pixelRatio) {
    S.w = Math.max(1, Math.round(+w || 1)); S.h = Math.max(1, Math.round(+h || 1));
    S.pr = Number.isFinite(+pixelRatio) && +pixelRatio > 0 ? +pixelRatio : (renderer.getPixelRatio() || 1);
    if (composer) { try { resizeComposer(); } catch (e) { fail('setSize', e); } }
  }

  function setQuality(q) {
    S.tier = normTier(q);
    if (S.tier === 'high') loadHigh();
    try { applyTier(); } catch (e) { fail('setQuality', e); }
  }

  // Корона затмения на экране (uv 0..1, y вверх); vis 0..1 — за кадром/сзади гаснет плавно.
  function setSun(x, y, vis) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { S.sun.vis = 0; return; }
    S.sun.x = x; S.sun.y = y; S.sun.vis = Math.max(0, Math.min(1, +vis || 0));
  }
  // Радиальный рывок экрана от точки (uv) — мощное попадание, выброс, руна.
  function punch(strength, x = 0.5, y = 0.5) {
    if (S.reduced) return;
    const k = Math.max(0, Math.min(1, +strength || 0));
    if (k > S.punch) { S.punch = k; S.punchC.x = Number.isFinite(x) ? x : 0.5; S.punchC.y = Number.isFinite(y) ? y : 0.5; }
  }

  // [HERO] ослабление bloom (витрина меню при приближении к лицу: светлый герой на полэкрана иначе
  // уходит в молочную пелену): k = 1 — как задано, меньше — слабее и выше порог
  function setBloomK(k) {
    if (!P.bloom) return;
    k = Math.max(0, Math.min(1, Number.isFinite(+k) ? +k : 1));
    S.bloomK = k;   // [W3-КИНО] засветка усиливает bloom поверх этого множителя
    P.bloom.strength = BLOOM.strength * k;
    P.bloom.threshold = BLOOM.threshold + (1 - k) * 1.2;
  }

  function setReducedMotion(b) {
    S.reduced = !!b;
    try { applyTier(); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (S.disposed) return;
    S.disposed = true;
    destroy();
    if (ov) { ov.geo.dispose(); ov.mat.dispose(); ov = null; }   // [W3-КИНО]
    const i = LIVE.indexOf(api);
    if (i >= 0) LIVE.splice(i, 1);
  }

  const whenReady = init().then((ok) => !!ok && !S.failed, (e) => { fail('init', e); return false; });

  const api = {
    render, setSize, setQuality, setReducedMotion, setSun, punch, setBloomK, setMode, setFocus, dispose, whenReady,
    pulse: pulseFn, setLook, setCinema,   // [W3-КИНО]
    get enabled() { return active(); },
    get ready() { return S.ready && !S.failed; },
    get tier() { return S.tier; },
    get error() { return S.error; },
    info() {
      return {
        tier: S.tier, enabled: active(), ready: S.ready, failed: S.failed, error: S.error, highReady: S.highReady,
        size: [S.w, S.h, S.pr], passes: composer ? composer.passes.filter((p) => p.enabled).map((p) => (p.constructor && p.constructor.name) || '?') : [],
        // [W3-КИНО] QA: импульсы и цвет фаз
        fx: { waves: S.waves.filter((w) => w.s > 0).length, dash: +S.dash.toFixed(3), hurt: +S.hurt.toFixed(3), flash: +S.flash.toFixed(3), bars: +S.bars.toFixed(3), look: { ...S.lookIn }, lookW: +S.lookW.toFixed(3), raysHQ: !!(P.rays && P.rays.enabled) },
      };
    },
  };
  LIVE.push(api);   // [W3-КИНО] для модульных pulse()/queueShockwave()
  return api;
}
