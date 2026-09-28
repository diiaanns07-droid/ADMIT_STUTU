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
 */

const TIERS = ['low', 'medium', 'high'];
const normTier = (q) => (TIERS.includes(q) ? q : 'medium');

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
uniform float uCA;
uniform float uContrast;
uniform float uSat;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 d = vUv - 0.5;
  vec2 off = d * (uCA * dot(d, d));           // grows toward the corners, ~0 in the centre
  vec3 col;
  col.r = texture2D(tDiffuse, vUv - off).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv + off).b;
  col = clamp(col, 0.0, 1.0);
  // gentle filmic S-curve (display space)
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, uContrast);
  // split tone: cool shadows, warm highlights (chroma offsets, luminance kept)
  const vec3 W = vec3(0.2126, 0.7152, 0.0722);
  float lum = dot(col, W);
  col += uShadowTint * (1.0 - smoothstep(0.0, 0.42, lum)) + uHighTint * smoothstep(0.38, 1.0, lum);
  lum = dot(col, W);
  col = mix(vec3(lum), col, uSat);
  // vignette (elliptical, wider than tall)
  vec2 q = d * 2.0; q.x *= 0.86;
  float r = length(q) / 1.32;
  col *= 1.0 - uVignette * smoothstep(0.42, 1.02, r);
  // film grain (luma-weighted, stronger in darks) + 1/255 dither against banding
  float g = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 911.0) - 0.5;
  col += g * uGrain * (1.0 - 0.55 * lum);
  col += (hash12(gl_FragCoord.xy * 1.37 + 17.17) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Visual Bible, разд. 16: порог 1.0 в HDR — светится только эмиссия > 1 (магия, огонь, корона), камень никогда.
const BLOOM = { strength: 0.7, radius: 0.42, threshold: 1.0, knee: 0.15, maxInputWidth: 1280 };
const GTAO_SCALE = 0.5; // AO targets at half the composer resolution
const GTAO_PARAMS = { radius: 0.55, distanceExponent: 1.4, thickness: 1.6, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false };
const GTAO_BLEND = 0.7;
const GRADE = { grain: 0.036, vignette: 0.45, ca: 0.0, contrast: 0.16, sat: 1.04,
  shadowTint: [-0.010, 0.002, 0.026], highTint: [0.028, 0.010, -0.020] };

export function createPostFX({ THREE, renderer, scene, camera, quality = 'medium', reducedMotion = false } = {}) {
  if (!THREE || !renderer || !scene || !camera) throw new Error('[postfx] need THREE, renderer, scene, camera');
  const S = {
    tier: normTier(quality), reduced: !!reducedMotion, ready: false, failed: false, disposed: false, error: null,
    w: 1, h: 1, pr: 1, time: 0, highLoading: false, highReady: false, highFailed: false, mods: null,
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
      },
      vertexShader: GRADE_VERT, fragmentShader: GRADE_FRAG,
    });
    for (const k of ['render', 'bloom', 'output', 'fxaa', 'grade']) composer.addPass(P[k]);
    resizeComposer();
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

  function applyTier() {
    if (!composer) return;
    const high = S.tier === 'high' && S.highReady;
    if (P.gtao) P.gtao.enabled = high;
    if (P.smaa) P.smaa.enabled = high;
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

  function render(dt) {
    if (S.disposed) return;
    if (!active()) { renderer.render(scene, camera); return; }
    renderer.getSize(_sz);
    const pr = renderer.getPixelRatio() || 1;
    if ((_sz.x | 0) !== S.w || (_sz.y | 0) !== S.h || pr !== S.pr) { S.w = Math.max(1, _sz.x | 0); S.h = Math.max(1, _sz.y | 0); S.pr = pr; resizeComposer(); }
    const d = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 1 / 60;
    S.time = (S.time + d) % 1000;
    P.grade.uniforms.uTime.value = S.reduced ? 0 : S.time;
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

  function setReducedMotion(b) {
    S.reduced = !!b;
    try { applyTier(); } catch (e) { /* ignore */ }
  }

  function dispose() {
    if (S.disposed) return;
    S.disposed = true;
    destroy();
  }

  const whenReady = init().then((ok) => !!ok && !S.failed, (e) => { fail('init', e); return false; });

  return {
    render, setSize, setQuality, setReducedMotion, dispose, whenReady,
    get enabled() { return active(); },
    get ready() { return S.ready && !S.failed; },
    get tier() { return S.tier; },
    get error() { return S.error; },
    info() {
      return {
        tier: S.tier, enabled: active(), ready: S.ready, failed: S.failed, error: S.error, highReady: S.highReady,
        size: [S.w, S.h, S.pr], passes: composer ? composer.passes.filter((p) => p.enabled).map((p) => (p.constructor && p.constructor.name) || '?') : [],
      };
    },
  };
}
