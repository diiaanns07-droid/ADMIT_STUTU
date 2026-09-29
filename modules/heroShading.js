// ASHEN OATH — [HERO] реалистичные материалы героев VRoid (settings.heroShading = 'realistic').
// MToon (аниме-заливка) заменяется на MeshPhysicalMaterial с теми же текстурами:
//   кожа   — мягкий фейковый подповерхностный свет: «обёрнутый» диффуз с тёплым оттенком на терминаторе,
//            лёгкий sheen (пушок), низкий specular;
//   ткань  — sheen цвета самой ткани, шум нормалей «плетения», высокая шероховатость;
//   волосы — анизотропный блик вдоль прядей (anisotropy по V развёртки VRoid), sheen;
//   глаза  — радужка под лаком (clearcoat — блик от неба), белок полуматовый, блик-текстура светится;
//   контур (outline MToon) выключается — в BDO его нет.
// Контровой rim и заполняющий свет — общий шейдерный патч атмосферы мира (atmosphere.patchLit 'hero'),
// отражения — PMREM неба (atmosphere.useEnv). Режим 'anime' возвращает исходные MToon.
// На quality 'low' — MeshStandardMaterial (без sheen/anisotropy/clearcoat), кожа с тем же «обёрнутым» светом.
//
// export: shadeHero(THREE, vrm, { mode, atmosphere, quality, heroId }) → { setMode, setQuality, update, dispose, stats() }
//         classifyMaterial(name) → 'skin' | 'hair' | 'cloth' | 'iris' | 'eyeWhite' | 'eyeHi' | 'lash' | 'mouth' | 'other'

export function classifyMaterial(name = '') {
  const n = String(name);
  // Quaternius (GLB-герои): MI_Regular_* — кожа, MI_Hair_* — волосы, MI_Eyes — глаза, остальное — снаряжение
  if (/^MI_Regular/i.test(n)) return 'skin';
  if (/^MI_Hair/i.test(n)) return 'hair';
  if (/^MI_Eye/i.test(n)) return 'iris';
  if (/^MI_/i.test(n)) return 'armor';
  if (/EyeHighlight/i.test(n)) return 'eyeHi';
  if (/EyeIris|EyeExtra/i.test(n)) return 'iris';
  if (/EyeWhite/i.test(n)) return 'eyeWhite';
  if (/FaceEyeline|FaceEyelash|FaceBrow/i.test(n)) return 'lash';
  if (/FaceMouth/i.test(n)) return 'mouth';
  if (/_SKIN|Face_00|Body_00/i.test(n)) return 'skin';
  if (/_HAIR|Hair/i.test(n)) return 'hair';
  if (/_CLOTH|Tops|Bottoms|Onepi|Shoes|Accessory|Cloth/i.test(n)) return 'cloth';
  return 'other';
}

// Подобранные параметры по классам (quality medium/high)
const PRESET = {
  skin: { roughness: 0.52, specularIntensity: 0.32, sheen: 0.22, sheenRoughness: 0.55, sheenColor: [1.0, 0.72, 0.62], env: 0.35 },
  mouth: { roughness: 0.45, specularIntensity: 0.4, env: 0.3 },
  hair: { roughness: 0.42, specularIntensity: 0.55, anisotropy: 0.72, sheen: 0.35, sheenRoughness: 0.35, sheenColor: [0.9, 0.9, 1.0], env: 0.55 },
  cloth: { roughness: 0.8, specularIntensity: 0.25, sheen: 0.35, sheenRoughness: 0.8, sheenColor: [0.4, 0.4, 0.4], env: 0.35, weave: true },
  iris: { roughness: 0.25, specularIntensity: 0.6, clearcoat: 1, clearcoatRoughness: 0.04, env: 1.1 },
  eyeWhite: { roughness: 0.35, specularIntensity: 0.5, clearcoat: 0.6, clearcoatRoughness: 0.08, env: 0.7 },
  lash: { roughness: 0.9, specularIntensity: 0.1, env: 0.1 },
  other: { roughness: 0.65, specularIntensity: 0.4, env: 0.45 },
  // атлас снаряжения Quaternius: металл и кожа по карте ORM; лак и лёгкий sheen поверх
  armor: { specularIntensity: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.4, sheen: 0.12, sheenRoughness: 0.7, sheenColor: [0.5, 0.45, 0.4], env: 0.85 },
};

// Шум «плетения» ткани — карта нормалей 128×128, одна на модуль (текстура не материал: делить можно).
let weaveTex = null;
function weaveNormal(THREE) {
  if (weaveTex) return weaveTex;
  if (typeof document === 'undefined') return null;
  const N = 128, cv = document.createElement('canvas');
  cv.width = N; cv.height = N;
  const g = cv.getContext('2d');
  const img = g.createImageData(N, N);
  const h = new Float32Array(N * N);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // нити по двум осям + мелкий шум
    const wx = Math.sin((x / N) * Math.PI * 2 * 16) * 0.5 + 0.5, wy = Math.sin((y / N) * Math.PI * 2 * 16) * 0.5 + 0.5;
    h[y * N + x] = ((x >> 3) + (y >> 3)) % 2 ? wx * 0.8 + wy * 0.2 : wy * 0.8 + wx * 0.2;
    h[y * N + x] += (rnd() - 0.5) * 0.35;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const hx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
    const hy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    const s = 1.2;
    let nx = -hx * s, ny = -hy * s, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * N + x) * 4;
    img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255; img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  weaveTex = new THREE.CanvasTexture(cv);
  weaveTex.wrapS = weaveTex.wrapT = THREE.RepeatWrapping;
  weaveTex.repeat.set(18, 18);
  weaveTex.colorSpace = THREE.NoColorSpace;
  return weaveTex;
}

// «Обёрнутый» свет кожи: лишний диффуз у терминатора, тёплый — как свет, прошедший под кожей.
function patchSkin(THREE, mat, uniforms) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(mat, shader, r);
    shader.uniforms.heroSkinWrap = uniforms.wrap;
    shader.uniforms.heroSkinTint = uniforms.tint;
    const pars = mat.isMeshPhysicalMaterial || mat.isMeshStandardMaterial ? 'lights_physical_pars_fragment' : null;
    if (!pars) return;
    const chunk = THREE.ShaderChunk[pars];
    const needle = 'vec3 irradiance = dotNL * directLight.color;';
    if (!chunk || chunk.indexOf(needle) < 0) return;
    const patched = chunk.replace(needle, `${needle}
	{
		float heroW = saturate( ( dot( geometryNormal, directLight.direction ) + heroSkinWrap ) / ( 1.0 + heroSkinWrap ) );
		reflectedLight.directDiffuse += max( heroW - dotNL, 0.0 ) * directLight.color * heroSkinTint * BRDF_Lambert( material.diffuseContribution );
	}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float heroSkinWrap;\nuniform vec3 heroSkinTint;')
      .replace(`#include <${pars}>`, patched);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'heroSkin:' + (prevKey ? prevKey.call(mat) : '');
}

export function shadeHero(THREE, vrm, { mode = 'realistic', atmosphere = null, quality = 'medium' } = {}) {
  const entries = []; // { mesh, index|-1, orig, real }
  const owned = [];
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  owned.push(hidden);
  const skinU = { wrap: { value: 0.55 }, tint: { value: new THREE.Color(1.0, 0.42, 0.32) } };
  let curMode = null, curQ = quality;

  function build(orig, q) {
    if (!orig) return orig;
    if (orig.isOutline) return hidden;
    const isMToon = !!(orig.isMToonMaterial || (orig.uniforms && orig.uniforms.litFactor));
    if (!isMToon && orig.isMeshStandardMaterial) return buildFromStandard(orig, q);
    if (!isMToon) return orig;
    const kind = classifyMaterial(orig.name);
    const P = PRESET[kind] || PRESET.other;
    const common = {
      name: `${orig.name}#real`,
      map: orig.map || null,
      color: orig.color ? orig.color.clone() : new THREE.Color(1, 1, 1),
      side: orig.side, transparent: !!orig.transparent, alphaTest: orig.alphaTest || 0,
      depthWrite: orig.transparent ? !!orig.depthWrite : true,
      emissive: orig.emissive ? orig.emissive.clone() : new THREE.Color(0, 0, 0),
      emissiveMap: orig.emissiveMap || null,
      emissiveIntensity: orig.emissiveIntensity !== undefined ? orig.emissiveIntensity : 1,
    };
    if (kind === 'eyeHi') {
      const m = new THREE.MeshBasicMaterial({ name: common.name, map: common.map, color: new THREE.Color(1.25, 1.25, 1.25), transparent: true, depthWrite: false, alphaTest: common.alphaTest, side: common.side });
      owned.push(m);
      return m;
    }
    const nm = orig.normalMap && orig.normalMap.image ? orig.normalMap : null;
    const physical = q !== 'low';
    const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const m = new Ctor({ ...common, roughness: P.roughness, metalness: 0 });
    if (nm) { m.normalMap = nm; if (orig.normalScale) m.normalScale.copy(orig.normalScale); }
    if (physical) {
      m.specularIntensity = P.specularIntensity;
      if (P.sheen) { m.sheen = P.sheen; m.sheenRoughness = P.sheenRoughness; m.sheenColor = new THREE.Color(...P.sheenColor); }
      if (kind === 'cloth' && m.map) m.sheenColorMap = m.map;
      if (P.anisotropy) { m.anisotropy = P.anisotropy; m.anisotropyRotation = Math.PI / 2; }
      if (P.clearcoat) { m.clearcoat = P.clearcoat; m.clearcoatRoughness = P.clearcoatRoughness; }
    }
    if (P.weave && !nm && q !== 'low') { const w = weaveNormal(THREE); if (w) { m.normalMap = w; m.normalScale.set(0.35, 0.35); } }
    if (kind === 'skin' || kind === 'mouth') patchSkin(THREE, m, skinU);
    if (atmosphere) {
      try {
        if (kind !== 'lash') atmosphere.patchLit(m, 'hero');
        atmosphere.useEnv(m, P.env);
      } catch (e) { /* атмосфера без патча */ }
    }
    m.userData.heroKind = kind;
    owned.push(m);
    return m;
  }

  // GLB-герой (MeshStandardMaterial с картами ORM): те же текстуры, Physical и классовые добавки
  function buildFromStandard(orig, q) {
    const kind = classifyMaterial(orig.name);
    const P = PRESET[kind] || PRESET.other;
    const physical = q !== 'low';
    const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const m = new Ctor({
      name: `${orig.name}#real`, map: orig.map, color: orig.color.clone(), side: orig.side,
      transparent: orig.transparent, alphaTest: orig.alphaTest, depthWrite: orig.depthWrite,
      normalMap: orig.normalMap, roughnessMap: orig.roughnessMap, metalnessMap: orig.metalnessMap, aoMap: orig.aoMap,
      roughness: orig.roughness, metalness: orig.metalness, emissive: orig.emissive.clone(), emissiveMap: orig.emissiveMap, emissiveIntensity: orig.emissiveIntensity,
    });
    if (orig.normalMap) m.normalScale.copy(orig.normalScale);
    if (kind === 'skin') { m.roughness = Math.max(0.45, orig.roughness * 0.85); }
    if (kind === 'iris') { m.roughness = 0.2; }
    if (physical) {
      m.specularIntensity = P.specularIntensity;
      if (P.sheen) { m.sheen = P.sheen; m.sheenRoughness = P.sheenRoughness; m.sheenColor = new THREE.Color(...P.sheenColor); }
      if (P.anisotropy) { m.anisotropy = P.anisotropy * 0.7; m.anisotropyRotation = Math.PI / 2; }
      if (P.clearcoat) { m.clearcoat = P.clearcoat; m.clearcoatRoughness = P.clearcoatRoughness; }
    }
    if (kind === 'skin') patchSkin(THREE, m, skinU);
    if (atmosphere) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, P.env); } catch (e) { /* ignore */ } }
    m.userData.heroKind = kind;
    owned.push(m);
    return m;
  }

  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) o.material.forEach((mt, i) => entries.push({ mesh: o, index: i, orig: mt, real: null, q: null }));
    else entries.push({ mesh: o, index: -1, orig: o.material, real: null, q: null });
  });

  function apply(modeWanted) {
    for (const e of entries) {
      let mat = e.orig;
      if (modeWanted === 'realistic') {
        if (!e.real || e.q !== curQ) { e.real = build(e.orig, curQ); e.q = curQ; }
        mat = e.real;
      }
      if (e.index >= 0) { const arr = e.mesh.material.slice(); arr[e.index] = mat; e.mesh.material = arr; }
      else e.mesh.material = mat;
    }
    curMode = modeWanted;
  }

  function setMode(m) { if (m !== 'realistic' && m !== 'anime') return; if (m !== curMode) apply(m); }
  function setQuality(q) {
    const tier = (x) => (x === 'low' ? 'low' : 'hi');
    if (tier(q) === tier(curQ)) { curQ = q; return; }
    curQ = q;
    if (curMode === 'realistic') apply('realistic');
  }
  function dispose() {
    // исходные MToon освобождает VRMUtils.deepDispose (если на меше они); наши — здесь
    for (const e of entries) {
      const current = e.index >= 0 ? e.mesh.material[e.index] : e.mesh.material;
      if (current !== e.orig && e.orig && e.orig.dispose) { try { e.orig.dispose(); } catch (err) { /* ignore */ } }
    }
    for (const m of owned) { const inUse = false; if (!inUse) m.dispose(); }
    owned.length = 0;
  }

  apply(mode === 'anime' ? 'anime' : 'realistic');
  return {
    setMode, setQuality, dispose, update() {},
    get mode() { return curMode; },
    materials: () => entries.map((e) => (e.index >= 0 ? e.mesh.material[e.index] : e.mesh.material)),
    stats: () => {
      const kinds = {};
      for (const e of entries) { const k = classifyMaterial(e.orig && e.orig.name); kinds[k] = (kinds[k] || 0) + 1; }
      return { mode: curMode, count: entries.length, kinds };
    },
  };
}
