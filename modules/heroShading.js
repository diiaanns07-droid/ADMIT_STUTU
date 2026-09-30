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

// [HERO] Свет витрины (меню): ключевой, контровой и заполняющий — только на материалах героев, в шейдере.
// Настоящие источники не добавляются: число источников сцены не меняется (нет перекомпиляции всех
// материалов) и мир не платит за лишние источники в бою. Юниформы общие; вне меню интенсивность 0.
// Направления — в осях камеры (view space), их ставит modules/heroShowcase.js каждый кадр.
export const HERO_LIGHT = {
  heroKeyColor: { value: null }, heroKeyDir: { value: null },
  heroRimColor: { value: null }, heroRimDir: { value: null }, heroFillColor: { value: null },
};
let heroLightInit = false;
function initHeroLight(THREE) {
  if (heroLightInit) return;
  heroLightInit = true;
  HERO_LIGHT.heroKeyColor.value = new THREE.Color(0, 0, 0); HERO_LIGHT.heroKeyDir.value = new THREE.Vector3(0, 0, 1);
  HERO_LIGHT.heroRimColor.value = new THREE.Color(0, 0, 0); HERO_LIGHT.heroRimDir.value = new THREE.Vector3(0, 1, 0);
  HERO_LIGHT.heroFillColor.value = new THREE.Color(0, 0, 0);
}
export function patchHeroLight(THREE, mat) {
  if (!mat || mat.userData.heroLight || !(mat.isMeshStandardMaterial)) return mat;
  initHeroLight(THREE);
  mat.userData.heroLight = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(mat, shader, r);
    Object.assign(shader.uniforms, HERO_LIGHT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 heroKeyColor;\nuniform vec3 heroKeyDir;\nuniform vec3 heroRimColor;\nuniform vec3 heroRimDir;\nuniform vec3 heroFillColor;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 hN = normal;
    vec3 hV = normalize( vViewPosition );
    float hNL = dot( hN, heroKeyDir );
    float hDiff = mix( saturate( hNL ), saturate( ( hNL + 0.35 ) / 1.35 ), 0.35 );
    float hMet = 1.0 - 0.8 * metalnessFactor;
    totalEmissiveRadiance += diffuseColor.rgb * heroKeyColor * hDiff * hMet;
    vec3 hH = normalize( heroKeyDir + hV );
    float hSpec = pow( saturate( dot( hN, hH ) ), mix( 90.0, 12.0, roughnessFactor ) ) * ( 1.0 - roughnessFactor );
    totalEmissiveRadiance += heroKeyColor * hSpec * mix( vec3( 0.1 ), diffuseColor.rgb * 1.8 + 0.06, metalnessFactor ) * ( 1.0 + 0.6 * metalnessFactor );
    float hF = pow( 1.0 - saturate( dot( hN, hV ) ), 4.0 );   // узкая кромка: силуэт, а не заливка тёмных тканей
    totalEmissiveRadiance += heroRimColor * hF * saturate( dot( hN, heroRimDir ) * 0.6 + 0.45 );
    totalEmissiveRadiance += diffuseColor.rgb * heroFillColor * ( 0.4 + 0.6 * saturate( dot( hN, hV ) ) ) * hMet;
  }`);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'heroLight:' + (prevKey ? prevKey.call(mat) : '');
  mat.needsUpdate = true;
  return mat;
}

// [HERO] «Пробуждённые» латы: светящиеся жилы-трещины по металлу (маска — metalness карты ORM),
// узор в осях позы привязки (прилипает к доспеху), пульс и бегущая снизу вверх волна. HDR > 1 — ловит bloom.
export const HERO_TIME = { value: 0 };
// mode 'seams' — свет сочится только по кромкам пластин (где карта нормалей круто гнётся) и едва заметно
// по жилам; 'veins' — прежние жилы по всему металлу.
export function patchArmorGlow(THREE, mat, { color = 0xff7a2a, strength = 2.4, unit = 1, metalMask = true, mode = 'veins', gild = null } = {}) {
  if (!mat || mat.userData.heroArmorGlow || !mat.isMeshStandardMaterial) return mat;
  mat.userData.heroArmorGlow = true;
  const U = { heroTime: HERO_TIME, heroArmorColor: { value: new THREE.Color(color) }, heroArmorK: { value: strength }, heroArmorUnit: { value: unit }, heroGild: { value: new THREE.Color(gild || 0) } };
  mat.userData.heroArmorU = U;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(mat, shader, r);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeroObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vHeroObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeroObj;\nuniform float heroTime;\nuniform vec3 heroArmorColor;\nuniform float heroArmorK;\nuniform float heroArmorUnit;\nuniform vec3 heroGild;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 hp = vHeroObj * heroArmorUnit;
    vec3 q = hp * 11.0;
    float a = abs( sin( q.x + sin( q.y * 1.7 + q.z ) * 1.3 ) * sin( q.y * 1.3 + sin( q.z * 1.9 - q.x ) * 1.1 ) * sin( q.z * 1.1 + sin( q.x * 2.3 ) * 0.9 ) );
    float vein = 1.0 - smoothstep( 0.0, 0.045, a );
    float fine = 1.0 - smoothstep( 0.0, 0.02, abs( sin( q.y * 3.1 + sin( q.x * 2.7 ) * 2.0 ) ) );
    float mask = ${metalMask ? 'smoothstep( 0.45, 0.85, metalnessFactor )' : '1.0'};
    float flow = 0.45 + 0.55 * pow( 0.5 + 0.5 * sin( heroTime * 2.1 - hp.y * 5.0 ), 2.0 );
    float pulse = 0.8 + 0.2 * sin( heroTime * 5.3 + hp.x * 7.0 );
    ${gild && mat.normalMap ? `// позолота: полоса по фаске пластин (где карта нормалей гнётся), до лучей света — металл, гладкий
    {
      float gL = length( mapN.xy );
      float gild = smoothstep( 0.16, 0.34, gL ) * ( 1.0 - smoothstep( 0.62, 0.9, gL ) ) * ${metalMask ? 'smoothstep( 0.45, 0.85, metalnessFactor )' : '1.0'};
      diffuseColor.rgb = mix( diffuseColor.rgb, heroGild, gild * 0.9 );
      metalnessFactor = mix( metalnessFactor, 1.0, gild );
      roughnessFactor = mix( roughnessFactor, 0.28, gild );
    }` : ''}
    ${mode === 'seams' && mat.normalMap ? `float seam = smoothstep( 0.32, 0.8, length( mapN.xy ) );
    totalEmissiveRadiance += heroArmorColor * seam * seam * 1.6 * mask * flow * pulse * heroArmorK;` : 'totalEmissiveRadiance += heroArmorColor * ( vein + fine * 0.18 ) * mask * flow * pulse * heroArmorK;'}
  }`);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'heroArmor:' + mode + (metalMask ? 1 : 0) + (gild ? 'G' : '') + ':' + (prevKey ? prevKey.call(mat) : '');
  mat.needsUpdate = true;
  return mat;
}

// [HERO] Микрорельеф атласа снаряжения (атлас Quaternius — 512² на всё тело, вблизи «мыло»).
// Процедурно в осях позы привязки (узор прилипает к ткани при анимации), в метрах:
//   ткань и кожа — плетение 2.4 мм, зерно 5 мм, мягкие неровности 2.5 см;
//   металл — «кованые» вмятины 3 см и мелкое зерно; шероховатость металла пятнами (захватанность).
// Нормаль — по Миккелсену (градиент высоты в экранных производных, без нормализации — в метрах);
// каждая октава гаснет, когда пиксель крупнее половины её длины волны (без муара и мерцания),
// наклон ограничен — у силуэта (вырожденный якобиан) нормаль не ломается и не даёт NaN.
// mode 'skin' — кожа: зерно 3/9 мм и пятна шероховатости; lips — влажный блеск губ (UV женского лица);
// mode 'hair' — причёска и борода Quaternius (MI_Hair): бороздки пучков и волосков вдоль потока вниз-назад.
export const HERO_MICRO = { value: 1 };
export function patchMicro(THREE, mat, { unit = 1, mode = 'gear', lips = false } = {}) {
  if (!mat || mat.userData.heroMicro || !mat.isMeshStandardMaterial) return mat;
  mat.userData.heroMicro = true;
  const U = { heroMicroK: HERO_MICRO, heroMicroUnit: { value: unit } };
  if (mode === 'hair') { initHeroLight(THREE); U.heroMicroKeyC = HERO_LIGHT.heroKeyColor; U.heroMicroKeyD = HERO_LIGHT.heroKeyDir; }
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(mat, shader, r);
    Object.assign(shader.uniforms, U);
    const hair = mode === 'hair';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeroMicro;' + (hair ? '\nvarying vec3 vHeroMicroN;' : ''))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vHeroMicro = position;' + (hair ? '\n  vHeroMicroN = normal;' : ''));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vHeroMicro;${hair ? '\nvarying vec3 vHeroMicroN;\nuniform vec3 heroMicroKeyC;\nuniform vec3 heroMicroKeyD;' : ''}
uniform float heroMicroK;
uniform float heroMicroUnit;
float hmHash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.zyx + 31.32 ); return fract( ( p.x + p.y ) * p.z ); }
float hmNoise( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( hmHash( i ), hmHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( hmHash( i + vec3( 0.0, 1.0, 0.0 ) ), hmHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
              mix( mix( hmHash( i + vec3( 0.0, 0.0, 1.0 ) ), hmHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( hmHash( i + vec3( 0.0, 1.0, 1.0 ) ), hmHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
}
float hmAA( float lambda, float fw ) { return 1.0 - smoothstep( 0.3 * lambda, 0.6 * lambda, fw ); }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  vec3 hmP = vHeroMicro * heroMicroUnit;
  float hmFw = max( length( dFdx( hmP ) ), length( dFdy( hmP ) ) );
  float hmMet = smoothstep( 0.35, 0.75, metalnessFactor );
  ${hair ? `// волосы (грубые формы причёски и бороды Quaternius): бороздки пучков 9 мм и волосков 2 мм вдоль
  // «потока» вниз-назад. Поперёк потока почти везде ось x (макушка, затылок, борода); на висках (нормаль ≈ ±x)
  // — ось (0, 0.62, −0.78). Два семейства полос с НЕПОДВИЖНЫМИ осями смешиваются по нормали (как трипланар):
  // фаза не зависит от нормали — иначе |позиция| ≈ 1.7 м × поворот грани давал бы сантиметры фазы на пиксель
  vec3 hmN0 = normalize( vHeroMicroN );
  float hmW2 = smoothstep( 0.35, 0.8, abs( hmN0.x ) );
  float hmWarp = hmNoise( hmP * 40.0 ) * 1.2 + hmNoise( hmP * 12.0 + 3.0 ) * 1.5;
  float hmQ1 = hmP.x, hmQ2 = dot( hmP, vec3( 0.0, 0.62, -0.78 ) );
  float hmPC1 = hmQ1 / 0.009 + hmWarp * 0.5, hmPF1 = hmQ1 / 0.002 + hmWarp * 0.7;
  float hmPC2 = hmQ2 / 0.009 + hmWarp * 0.5, hmPF2 = hmQ2 / 0.002 + hmWarp * 0.7;
  float hmFm = 0.65 + 0.35 * hmNoise( hmP * 90.0 );
  float hmClump = mix( sin( 6.2832 * hmPC1 ), sin( 6.2832 * hmPC2 ), hmW2 );
  float hmFine = mix( sin( 6.2832 * hmPF1 ), sin( 6.2832 * hmPF2 ), hmW2 ) * hmFm;
  // линии гаснут заранее (≥ 4–10 пикселей на период): у предела частоты рельеф рассыпается в «шахматку»
  float hmCA = 1.0 - smoothstep( 0.1 * 0.009, 0.25 * 0.009, hmFw ), hmFA = 1.0 - smoothstep( 0.1 * 0.002, 0.25 * 0.002, hmFw );
  diffuseColor.rgb *= 1.0 - heroMicroK * ( 0.16 * ( 0.5 - 0.5 * hmClump ) * hmCA + 0.08 * ( 0.5 - 0.5 * hmFine ) * hmFA );
  roughnessFactor = clamp( roughnessFactor - 0.1 * heroMicroK * ( 0.5 + 0.5 * hmClump ) * hmCA, 0.2, 1.0 );` : ''}
  {
    // пятна «захватанности»: металл местами матовее, местами полирован; ткань — чуть неровная
    float sm = hmNoise( hmP * 16.0 ) * 0.5 + hmNoise( hmP * 47.0 ) * 0.5 - 0.5;
    ${mode === 'skin' ? 'roughnessFactor = clamp( roughnessFactor + sm * 0.1 * heroMicroK, 0.2, 1.0 );' : 'roughnessFactor = clamp( roughnessFactor + sm * mix( 0.08, 0.16, hmMet ) * heroMicroK, 0.06, 1.0 );'}
    ${lips ? `// губы (атлас женского лица Quaternius: центр 92,133 из 512) — влажный блеск
    vec2 hmL = ( vMapUv - vec2( 0.1797, 0.2598 ) ) / vec2( 0.03, 0.0125 );
    roughnessFactor = mix( roughnessFactor, 0.2, ( 1.0 - smoothstep( 0.55, 1.0, length( hmL ) ) ) * 0.85 );` : ''}
  }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    float hmH;
    ${hair ? `{
      hmH = 0.0;   // градиент — аналитически ниже (производные высоты крутой периодики рвутся по квадам 2×2)
    }` : mode === 'skin' ? `{
      // кожа: мелкое зерно 3 мм и мягкая неровность 9 мм (едва заметно — «живой» блик вместо пластика)
      hmH = ( ( hmNoise( hmP * 330.0 ) - 0.5 ) * 0.00006 * hmAA( 0.003, hmFw ) + ( hmNoise( hmP * 110.0 + 5.0 ) - 0.5 ) * 0.00012 * hmAA( 0.009, hmFw ) ) * heroMicroK;
    }` : `{
      // ткань/кожа: плетение (три семейства плоскостей — клетка на любой ориентации поверхности)
      vec3 w = sin( hmP * 2617.99 );   // 2π / 2.4 мм
      float weave = ( w.x * w.y + w.y * w.z + w.z * w.x ) * 0.00006 * hmAA( 0.0024, hmFw );
      float grain = ( hmNoise( hmP * 200.0 ) - 0.5 ) * 0.0002 * hmAA( 0.005, hmFw );
      float soft = ( hmNoise( hmP * 40.0 ) - 0.5 ) * 0.0005 * hmAA( 0.025, hmFw );
      // металл: кованые вмятины и мелкое зерно
      float dent = ( hmNoise( hmP * 33.0 + 7.0 ) - 0.5 ) * 0.0012 * hmAA( 0.03, hmFw );
      float mgr = ( hmNoise( hmP * 330.0 + 3.0 ) - 0.5 ) * 0.00012 * hmAA( 0.003, hmFw );
      hmH = mix( weave + grain + soft, dent + mgr, hmMet ) * heroMicroK;
    }`}
    vec3 hmSp = - vViewPosition;
    vec3 hmDx = dFdx( hmSp ), hmDy = dFdy( hmSp );
    ${hair ? `// производные гладких фаз × известный косинус (без «шахматки» квадов 2×2), семейства — с весами
    float hmKc = 6.2832 * 0.00025 * hmCA * heroMicroK, hmKf = 6.2832 * 0.00003 * hmFA * hmFm * heroMicroK;
    float hmC1 = cos( 6.2832 * hmPC1 ) * hmKc * ( 1.0 - hmW2 ), hmF1 = cos( 6.2832 * hmPF1 ) * hmKf * ( 1.0 - hmW2 );
    float hmC2 = cos( 6.2832 * hmPC2 ) * hmKc * hmW2, hmF2 = cos( 6.2832 * hmPF2 ) * hmKf * hmW2;
    float hmBx = hmC1 * dFdx( hmPC1 ) + hmF1 * dFdx( hmPF1 ) + hmC2 * dFdx( hmPC2 ) + hmF2 * dFdx( hmPF2 );
    float hmBy = hmC1 * dFdy( hmPC1 ) + hmF1 * dFdy( hmPF1 ) + hmC2 * dFdy( hmPC2 ) + hmF2 * dFdy( hmPF2 );` : 'float hmBx = dFdx( hmH ), hmBy = dFdy( hmH );'}
    vec3 hmR1 = cross( hmDy, normal ), hmR2 = cross( normal, hmDx );
    float hmDet = dot( hmDx, hmR1 );
    if ( abs( hmDet ) > 1e-16 ) {
      vec3 hmG = sign( hmDet ) * ( hmBx * hmR1 + hmBy * hmR2 ) / abs( hmDet );
      float hmL = length( hmG );
      if ( hmL > 0.6 ) hmG *= 0.6 / hmL;
      normal = normalize( normal - hmG );
    }
  }`);
    // волосы на витрине: «кольцо блеска» Каджия-Кей вдоль потока от портретного ключа (в бою ключ = 0).
    // Направление пряди в осях камеры — поперёк градиента неподвижных осей полос (экранные производные
    // гладких координат, до ветвлений); узкий светлый блик и широкий в цвет волос, рвутся по пучкам
    if (hair) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 kkSp = - vViewPosition, kkDx = dFdx( kkSp ), kkDy = dFdy( kkSp );
    float kkQ1x = dFdx( hmQ1 ), kkQ1y = dFdy( hmQ1 ), kkQ2x = dFdx( hmQ2 ), kkQ2y = dFdy( hmQ2 );
    vec3 kkR1 = cross( kkDy, normal ), kkR2 = cross( normal, kkDx );
    float kkDet = dot( kkDx, kkR1 );
    vec3 kkGa = mix( kkQ1x * kkR1 + kkQ1y * kkR2, kkQ2x * kkR1 + kkQ2y * kkR2, hmW2 ) * sign( kkDet );
    float kkGl = length( kkGa );
    if ( abs( kkDet ) > 1e-16 && kkGl > 1e-12 ) {
      vec3 kkT = normalize( cross( normal, kkGa / kkGl ) );
      vec3 kkH = normalize( heroMicroKeyD + normalize( vViewPosition ) );
      float kkSh = hmClump * 0.06;
      vec3 kt1 = normalize( kkT + normal * ( -0.08 + kkSh ) ), kt2 = normalize( kkT + normal * ( 0.12 + kkSh ) );
      float kd1 = dot( kt1, kkH ), kd2 = dot( kt2, kkH );
      float ks1 = pow( sqrt( max( 0.0, 1.0 - kd1 * kd1 ) ), 240.0 ), ks2 = pow( sqrt( max( 0.0, 1.0 - kd2 * kd2 ) ), 70.0 );
      float kkNL = saturate( dot( normal, heroMicroKeyD ) ) * 0.85 + 0.15;
      float kkM = 0.55 + 0.45 * ( 0.5 + 0.5 * hmClump );
      totalEmissiveRadiance += heroMicroKeyC * kkNL * kkM * ( ks1 * 0.12 + ks2 * 0.14 * diffuseColor.rgb );
    }
  }`);
    }
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'heroMicro:' + mode + (lips ? 'L' : '') + ':' + (prevKey ? prevKey.call(mat) : '');
  mat.needsUpdate = true;
  return mat;
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

// [HERO] Перекраска атласа костюма (процедурно, на canvas): правила по тону HSV.
//   rules: [{ h: [from°, to°], toH?, s?: множитель, v?: множитель, minS?, minV?, maxV? }] — первое подходящее правило.
// Нужна, чтобы из одного костюма Quaternius сделать разных героев (эльфийка, чародейка).
// [HERO] Макияж на атласе кожи Quaternius (женское лицо — левый верх атласа 512²: глаза ~(66,90)/(118,90),
// губы ~(92,133), щёки ~(55,118)/(130,118); координаты в долях атласа). spec: { lips, lipsA, shadow, shadowA,
// liner, blush, blushA, freckles } — цвета 0xRRGGBB. Рисуется поверх перекрашенного холста.
export function makeupPainter(spec) {
  if (!spec) return null;
  const hex = (c, a) => { const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255; return `rgba(${r},${g},${b},${a})`; };
  return (g, W, H) => {
    const X = (u) => u * W, Y = (v) => v * H, S = W / 512;
    const eyes = [[66 / 512, 90 / 512, -1], [118 / 512, 90 / 512, 1]];
    g.save();
    // тени: мягкое пятно над веком, вытянуто к виску
    if (spec.shadow !== undefined) {
      g.globalCompositeOperation = 'multiply';
      for (const [u, v, side] of eyes) {
        const cx = X(u) + side * 2 * S, cy = Y(v) - 4 * S;
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 15 * S);
        gr.addColorStop(0, hex(spec.shadow, spec.shadowA ?? 0.55)); gr.addColorStop(1, hex(spec.shadow, 0));
        g.fillStyle = gr; g.save(); g.translate(cx, cy); g.scale(1.35, 0.7); g.translate(-cx, -cy);
        g.beginPath(); g.arc(cx, cy, 15 * S, 0, Math.PI * 2); g.fill(); g.restore();
      }
    }
    // подводка: дуга по верхнему веку и «стрелка» к виску
    if (spec.liner !== undefined) {
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = hex(spec.liner, 0.85); g.lineCap = 'round'; g.lineWidth = 1.6 * S;
      for (const [u, v, side] of eyes) {
        const cx = X(u), cy = Y(v);
        g.beginPath(); g.moveTo(cx - side * 11 * S, cy - 1 * S);
        g.quadraticCurveTo(cx, cy - 7 * S, cx + side * 11 * S, cy - 2 * S);
        g.lineTo(cx + side * 16 * S, cy - 5 * S); g.stroke();
      }
    }
    // румянец
    if (spec.blush !== undefined) {
      g.globalCompositeOperation = 'source-over';
      for (const u of [55 / 512, 130 / 512]) {
        const cx = X(u), cy = Y(118 / 512);
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 16 * S);
        gr.addColorStop(0, hex(spec.blush, spec.blushA ?? 0.22)); gr.addColorStop(1, hex(spec.blush, 0));
        g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, 16 * S, 0, Math.PI * 2); g.fill();
      }
    }
    // губы: мягкий эллипс цвета, поверх — лёгкий блик
    if (spec.lips !== undefined) {
      const cx = X(92 / 512), cy = Y(133 / 512);
      g.globalCompositeOperation = 'multiply';
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 13 * S);
      gr.addColorStop(0, hex(spec.lips, spec.lipsA ?? 0.8)); gr.addColorStop(0.7, hex(spec.lips, (spec.lipsA ?? 0.8) * 0.8)); gr.addColorStop(1, hex(spec.lips, 0));
      g.fillStyle = gr; g.save(); g.translate(cx, cy); g.scale(1.25, 0.55); g.translate(-cx, -cy);
      g.beginPath(); g.arc(cx, cy, 13 * S, 0, Math.PI * 2); g.fill(); g.restore();
    }
    // веснушки по щекам и носу
    if (spec.freckles) {
      g.globalCompositeOperation = 'multiply';
      let sd = 5;
      const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      // мелкие и частые, гуще на спинке носа и скулах
      for (let i = 0; i < 140; i++) {
        const side = i % 2 ? 1 : -1, k = rnd(), cx = X(92 / 512) + side * (3 + k * k * 32) * S, cy = Y((106 + rnd() * 16 + k * 6) / 512);
        g.fillStyle = hex(spec.freckles, 0.14 + rnd() * 0.26);
        g.beginPath(); g.arc(cx, cy, (0.3 + rnd() * 0.45) * S, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  };
}

// Правила применяются мягко: у порогов тона/насыщенности/яркости — полосы перехода, а веса правил
// сглаживаются 3×3 (иначе на атласе 512² металл с шумной слабой насыщенностью покрывается «камуфляжем»).
// rule.metal === false — не трогать металл, 'only' — только металл (маска — канал B карты ORM: orm = изображение).
export function recolorTexture(THREE, tex, rules, paint = null, orm = null, scale = 1) {
  const img = tex && tex.image;
  if (!img || typeof document === 'undefined' || !rules || !rules.length) return tex;
  // scale 2 — холст вдвое крупнее (лицо с макияжем: подводка и веснушки чётче вблизи)
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  if (!w || !h) return tex;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h), px = d.data;
  let met = null;
  if (orm && orm.width && rules.some((R) => R.metal === false || R.metal === 'only')) {
    try {
      const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      const g2 = c2.getContext('2d', { willReadFrequently: true });
      g2.drawImage(orm, 0, 0, w, h);
      met = g2.getImageData(0, 0, w, h).data;
    } catch (e) { met = null; }
  }
  const N = w * h, nR = rules.length;
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const HS = new Float32Array(N * 3); // тон°, насыщенность, яркость
  const W = new Float32Array(N * nR); // веса правил («первое подходящее», мягко)
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = px[p] / 255, gg = px[p + 1] / 255, b = px[p + 2] / 255;
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), c = mx - mn;
    let hue = 0;
    if (c > 1e-5) hue = mx === r ? ((gg - b) / c) % 6 : mx === gg ? (b - r) / c + 2 : (r - gg) / c + 4;
    hue = (hue * 60 + 360) % 360;
    const sat = mx > 0 ? c / mx : 0, val = mx;
    HS[i * 3] = hue; HS[i * 3 + 1] = sat; HS[i * 3 + 2] = val;
    let left = 1;
    for (let k = 0; k < nR && left > 1e-4; k++) {
      const R = rules[k];
      const minS = R.minS ?? 0.12;
      let wk = minS > 0 ? ss(minS - 0.05, minS + 0.05, sat) : 1;
      if (R.minV !== undefined) wk *= ss(R.minV - 0.04, R.minV + 0.04, val);
      if (R.maxV !== undefined) wk *= 1 - ss(R.maxV - 0.04, R.maxV + 0.04, val);
      const [a0, a1] = R.h;
      if (!(a0 === 0 && a1 === 360)) {
        // расстояние от тона до дуги [a0, a1] (по кругу), полоса перехода 8°
        const span = (a1 - a0 + 360) % 360, off = (hue - a0 + 360) % 360;
        const dist = off <= span ? 0 : Math.min(off - span, 360 - off);
        wk *= 1 - ss(0, 8, dist);
      }
      if (met && R.metal === false) wk *= 1 - ss(0.3, 0.6, met[p + 2] / 255);
      if (R.metal === 'only') wk *= met ? ss(0.3, 0.6, met[p + 2] / 255) : 0;
      wk *= left;
      W[i * nR + k] = wk; left -= wk;
    }
  }
  // сглаживание весов 3×3 (разделимо)
  const tmp = new Float32Array(N);
  for (let k = 0; k < nR; k++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = (W[(x > 0 ? i - 1 : i) * nR + k] + 2 * W[i * nR + k] + W[(x < w - 1 ? i + 1 : i) * nR + k]) * 0.25;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      W[i * nR + k] = (tmp[y > 0 ? i - w : i] + 2 * tmp[i] + tmp[y < h - 1 ? i + w : i]) * 0.25;
    }
  }
  const hsv2rgb = (hue, sat, val, out) => {
    const C = val * sat, X = C * (1 - Math.abs(((hue / 60) % 2) - 1)), m = val - C;
    const k = Math.floor(hue / 60) % 6;
    const t = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][k];
    out[0] = t[0] + m; out[1] = t[1] + m; out[2] = t[2] + m;
  };
  const o = [0, 0, 0];
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const hue = HS[i * 3], sat = HS[i * 3 + 1], val = HS[i * 3 + 2];
    let r = 0, gg = 0, b = 0, left = 1;
    for (let k = 0; k < nR; k++) {
      const wk = W[i * nR + k];
      if (wk < 1e-4) continue;
      const R = rules[k];
      hsv2rgb(R.toH !== undefined ? R.toH : hue, R.s !== undefined ? Math.min(1, sat * R.s) : sat, R.v !== undefined ? Math.min(1, val * R.v) : val, o);
      r += o[0] * wk; gg += o[1] * wk; b += o[2] * wk; left -= wk;
    }
    if (left >= 0.9999) continue;
    left = Math.max(0, left);
    px[p] = (r * 255 + px[p] * left); px[p + 1] = (gg * 255 + px[p + 1] * left); px[p + 2] = (b * 255 + px[p + 2] * left);
  }
  g.putImageData(d, 0, 0);
  if (paint) { try { paint(g, w, h); } catch (e) { /* без макияжа */ } }
  const t = new THREE.CanvasTexture(cv);
  t.flipY = tex.flipY; t.colorSpace = tex.colorSpace; t.wrapS = tex.wrapS; t.wrapT = tex.wrapT;
  t.channel = tex.channel; t.anisotropy = tex.anisotropy || 4;
  return t;
}

export function shadeHero(THREE, vrm, { mode = 'realistic', atmosphere = null, quality = 'medium', fx = null, hairColor = null } = {}) {
  const armorUs = []; // юниформы жил лат (вспышка на касте, мерцание при низком HP)
  // [HERO] V7.2 вспышка попадания: красная кромка по силуэту героя (френель), своя на каждого героя
  const hurtU = { heroHurtK: { value: 0 }, heroHurtC: { value: new THREE.Color(1.0, 0.26, 0.14) } };
  function patchHurt(m) {
    if (!m || m.userData.heroHurt || !m.isMeshStandardMaterial) return;
    m.userData.heroHurt = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(m, sh, r);
      Object.assign(sh.uniforms, hurtU);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float heroHurtK;\nuniform vec3 heroHurtC;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if ( heroHurtK > 0.001 ) {
    float hhF = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 4.0 );   // только кромка силуэта
    totalEmissiveRadiance += heroHurtC * heroHurtK * hhF;
  }`);
    };
    const pk = m.customProgramCacheKey;
    m.customProgramCacheKey = () => 'heroHurt:' + (pk ? pk.call(m) : '');
    m.needsUpdate = true;
  }
  // масштаб узора жил: единицы геометрии → метры (у Quaternius позиции в своих единицах)
  // armorUnit — по самому высокому ОТДЕЛЬНОМУ мешу: у разрезанных героев Quaternius (ноги ≈ 0.74 м) это ≈ 2.4×
  // «метра»; узоры лат, ткани и кожи подобраны на глаз именно в этой шкале — не менять.
  // bodyUnit — честные метры по общему габариту всех мешей (для рельефа волос, где важен масштаб пикселя).
  let armorUnit = 1, bodyUnit = 1;
  {
    let hMax = 0, y0 = Infinity, y1 = -Infinity;
    vrm.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      hMax = Math.max(hMax, b.max.y - b.min.y, b.max.z - b.min.z);
      y0 = Math.min(y0, b.min.y); y1 = Math.max(y1, b.max.y);
    });
    if (hMax > 1e-6) armorUnit = 1.8 / hMax;
    if (y1 - y0 > 1e-6) bodyUnit = 1.8 / (y1 - y0);
  }
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
      // anisotropy и clearcoat — только на 'high' (на medium слабые ноутбуки: только sheen)
      if (P.anisotropy && q === 'high') { m.anisotropy = P.anisotropy; m.anisotropyRotation = Math.PI / 2; }
      if (P.clearcoat && q === 'high') { m.clearcoat = P.clearcoat; m.clearcoatRoughness = P.clearcoatRoughness; }
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
    patchHurt(m);
    patchHeroLight(THREE, m);
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
    // брови и волосы модели — в цвет причёски героини (серая текстура × цвет)
    if (kind === 'hair' && hairColor !== null && hairColor !== undefined) m.color.set(hairColor).multiplyScalar(1.35);
    if (kind === 'iris') {
      m.roughness = 0.2;
      // светящаяся радужка (стихия героя): светится тёмная часть текстуры глаза, белок — нет
      if (fx && fx.eyes) {
        m.emissive = new THREE.Color(fx.eyes); m.emissiveIntensity = fx.eyesK || 1.6;
        const prevE = m.onBeforeCompile;
        m.onBeforeCompile = (sh, r) => {
          if (prevE) prevE.call(m, sh, r);
          sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance *= 1.0 - smoothstep( 0.3, 0.62, dot( diffuseColor.rgb, vec3( 0.333 ) ) );`);
        };
        const pk = m.customProgramCacheKey;
        m.customProgramCacheKey = () => 'heroEyes:' + (pk ? pk.call(m) : '');
      }
      // [HERO] радужка вблизи: лимбальное кольцо, радиальные волокна, светлый венчик у зрачка; запечённый в
      // текстуру блик убран (глаз теперь поворачивается — блик «ездил» бы с ним; живой блик — ниже).
      // Текстура Quaternius: радужка — диск в центре (0.5, 0.5), радиус ≈ 0.105.
      if (m.map) {
        const prevI = m.onBeforeCompile;
        m.onBeforeCompile = (sh, r) => {
          if (prevI) prevI.call(m, sh, r);
          sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec2 irD = ( vMapUv - vec2( 0.5 ) ) / 0.105;
    float irR = length( irD ), irA = atan( irD.y, irD.x );
    float irIn = 1.0 - smoothstep( 0.96, 1.06, irR );
    float irL = dot( diffuseColor.rgb, vec3( 0.333 ) );
    // запечённый блик: яркие пиксели внутри радужки → цвет зрачка/радужки вокруг
    float irHi = smoothstep( 0.55, 0.8, irL ) * ( 1.0 - smoothstep( 0.55, 0.75, irR ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.12 + vec3( 0.02 ), irHi );
    // волокна и венчик
    float fib = 0.5 + 0.5 * sin( irA * 41.0 + sin( irA * 7.0 ) * 2.0 + irR * 5.0 ) * sin( irA * 23.0 - irR * 9.0 );
    float band = smoothstep( 0.3, 0.45, irR ) * ( 1.0 - smoothstep( 0.9, 1.0, irR ) );
    diffuseColor.rgb *= 1.0 + ( fib - 0.5 ) * 0.45 * band * irIn;
    diffuseColor.rgb *= 1.0 + 0.22 * smoothstep( 0.36, 0.5, irR ) * ( 1.0 - smoothstep( 0.5, 0.66, irR ) );
    // лимбальное кольцо — тёмный ободок по краю радужки
    diffuseColor.rgb *= 1.0 - 0.6 * smoothstep( 0.8, 0.97, irR ) * ( 1.0 - smoothstep( 1.0, 1.12, irR ) );
  }`);
        };
        const pkI = m.customProgramCacheKey;
        m.customProgramCacheKey = () => 'heroIris:' + (pkI ? pkI.call(m) : '');
      }
      // блик в глазах: отражение «студийного» источника сверху-слева (глаза — сферы, выходит точка)
      const prevC = m.onBeforeCompile;
      m.onBeforeCompile = (sh, r) => {
        if (prevC) prevC.call(m, sh, r);
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 eyR = reflect( - normalize( vViewPosition ), normalize( normal ) );
    float eyC = pow( saturate( dot( eyR, normalize( vec3( -0.35, 0.55, 0.76 ) ) ) ), 220.0 );
    totalEmissiveRadiance += vec3( 1.25 ) * eyC;
  }`);
      };
      const pkC = m.customProgramCacheKey;
      m.customProgramCacheKey = () => 'heroCatch:' + (pkC ? pkC.call(m) : '');
      patchGaze(m);
    }
    if (physical) {
      m.specularIntensity = P.specularIntensity;
      if (P.sheen) { m.sheen = P.sheen; m.sheenRoughness = P.sheenRoughness; m.sheenColor = new THREE.Color(...P.sheenColor); }
      if (P.anisotropy && q === 'high') { m.anisotropy = P.anisotropy * 0.7; m.anisotropyRotation = Math.PI / 2; }
      if (P.clearcoat && q === 'high') { m.clearcoat = P.clearcoat; m.clearcoatRoughness = P.clearcoatRoughness; }
    }
    if (kind === 'skin') patchSkin(THREE, m, skinU);
    if (kind === 'armor' && q !== 'low') patchMicro(THREE, m, { unit: armorUnit });
    if (kind === 'skin' && q !== 'low' && m.map) patchMicro(THREE, m, { unit: armorUnit, mode: 'skin', lips: /^MI_Regular_Female/.test(orig.name) });
    if (kind === 'hair' && q !== 'low' && /^MI_Hair/.test(orig.name || '')) patchMicro(THREE, m, { unit: bodyUnit, mode: 'hair' });
    if (kind === 'armor' && fx && fx.armor && q !== 'low') { patchArmorGlow(THREE, m, { color: fx.armor, strength: fx.armorK || 2.4, unit: armorUnit, mode: fx.armorMode || 'veins', gild: fx.gild || null }); armorUs.push({ U: m.userData.heroArmorU, base: fx.armorK || 2.4 }); }
    if (atmosphere) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, P.env); } catch (e) { /* ignore */ } }
    m.userData.heroKind = kind;
    patchHurt(m);
    patchHeroLight(THREE, m);
    owned.push(m);
    return m;
  }

  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material)) o.material.forEach((mt, i) => entries.push({ mesh: o, index: i, orig: mt, real: null, q: null }));
    else entries.push({ mesh: o, index: -1, orig: o.material, real: null, q: null });
  });

  // [HERO] взгляд: глазные яблоки (MI_Eyes — две сферы в одном меше) поворачиваются вокруг своих центров
  // в вершинном шейдере (оси позы привязки). Направление — по трём вершинам глаз (кадр «привязка → мир»)
  // каждый кадр; «вперёд»/«вверх» головы в осях привязки — один раз (от затылка к глазам, мировой верх).
  const gazeU = { heroGazeRot: { value: new THREE.Matrix3() }, heroEyeCL: { value: new THREE.Vector3() }, heroEyeCR: { value: new THREE.Vector3() }, heroEyeLR: { value: new THREE.Vector3(1, 0, 0) }, heroEyeMid: { value: new THREE.Vector3() } };
  const G = { mesh: null, idx: null, b: null, fwd: null, up: null, left: null, yaw: 0, pitch: 0, ok: false };
  {
    const e = entries.find((x) => /^MI_Eye/.test(x.orig && x.orig.name) && x.mesh.isSkinnedMesh && x.index < 0);
    if (e) {
      const pa = e.mesh.geometry.attributes.position, lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9), v = new THREE.Vector3();
      for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i); lo.min(v); hi.max(v); }
      const ext = hi.clone().sub(lo), ax = ext.x >= ext.y && ext.x >= ext.z ? 0 : ext.y >= ext.z ? 1 : 2;
      const lr = new THREE.Vector3().setComponent(ax, 1), mid = lo.clone().add(hi).multiplyScalar(0.5);
      const box = [[new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(-1e9, -1e9, -1e9)], [new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(-1e9, -1e9, -1e9)]];
      let iA = 0, iB = 0, iC = 0, bestA = -1e9, bestB = 1e9, bestC = -1e9;
      const ax2 = (ax + 1) % 3;
      for (let i = 0; i < pa.count; i++) {
        v.fromBufferAttribute(pa, i);
        const sd = v.getComponent(ax) - mid.getComponent(ax), k = sd > 0 ? 0 : 1;
        box[k][0].min(v); box[k][1].max(v);
        if (sd > bestA) { bestA = sd; iA = i; }
        if (sd < bestB) { bestB = sd; iB = i; }
        if (v.getComponent(ax2) > bestC) { bestC = v.getComponent(ax2); iC = i; }
      }
      gazeU.heroEyeCL.value.copy(box[0][0]).add(box[0][1]).multiplyScalar(0.5);
      gazeU.heroEyeCR.value.copy(box[1][0]).add(box[1][1]).multiplyScalar(0.5);
      gazeU.heroEyeLR.value.copy(lr); gazeU.heroEyeMid.value.copy(mid);
      G.mesh = e.mesh; G.idx = [iA, iB, iC];
      G.b = G.idx.map((i) => new THREE.Vector3().fromBufferAttribute(pa, i));
      G.eyeMid = mid;
    }
  }
  function patchGaze(m) {
    const prevG = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      if (prevG) prevG.call(m, sh, r);
      Object.assign(sh.uniforms, gazeU);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat3 heroGazeRot;\nuniform vec3 heroEyeCL;\nuniform vec3 heroEyeCR;\nuniform vec3 heroEyeLR;\nuniform vec3 heroEyeMid;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  objectNormal = heroGazeRot * objectNormal;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    vec3 hgC = dot( position - heroEyeMid, heroEyeLR ) > 0.0 ? heroEyeCL : heroEyeCR;
    transformed = heroGazeRot * ( transformed - hgC ) + hgC;
  }`);
    };
    const pk = m.customProgramCacheKey;
    m.customProgramCacheKey = () => 'heroGaze:' + (pk ? pk.call(m) : '');
  }
  // кадр привязка → мир по трём вершинам (жёстко на кости головы)
  const _w = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], _Fb = new THREE.Matrix3(), _Fw = new THREE.Matrix3(), _Rbw = new THREE.Matrix3();
  const frame = (a, b, c, out) => {
    const e1 = b.clone().sub(a).normalize(), e2 = e1.clone().cross(c.clone().sub(a)).normalize(), e3 = e2.clone().cross(e1);
    return out.set(e1.x, e2.x, e3.x, e1.y, e2.y, e3.y, e1.z, e2.z, e3.z);
  };
  const _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4(), _d = new THREE.Vector3(), _cw = new THREE.Vector3();
  function updateGaze(target, dt) {
    if (!G.mesh) return;
    if (G.hold) { target = G.hold; dt = 1; }   // QA: зафиксированная точка взгляда (holdGaze)
    G.mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < 3; i++) { G.mesh.getVertexPosition(G.idx[i], _w[i]); _w[i].applyMatrix4(G.mesh.matrixWorld); }
    frame(G.b[0], G.b[1], G.b[2], _Fb); frame(_w[0], _w[1], _w[2], _Fw);
    _Rbw.copy(_Fw).multiply(_Fb.clone().transpose());   // направление: привязка → мир
    const Rwb = _Rbw.clone().transpose();
    // центр глаз в мире: _w0 + Rbw·(mid − b0)
    _cw.copy(G.eyeMid).sub(G.b[0]).applyMatrix3(_Rbw).add(_w[0]);
    if (!G.ok) {
      const head = vrm.humanoid && (vrm.humanoid.getRawBoneNode ? vrm.humanoid.getRawBoneNode('head') : null);
      if (!head) return;
      const hp = head.getWorldPosition(new THREE.Vector3());
      const lrW = gazeU.heroEyeLR.value.clone().applyMatrix3(_Rbw).normalize();
      const upW = new THREE.Vector3(0, 1, 0).addScaledVector(lrW, -lrW.y).normalize();
      const fwdW = lrW.clone().cross(upW).normalize();
      const toEyes = _cw.clone().sub(hp);
      if (fwdW.dot(toEyes) < 0) fwdW.negate();
      G.fwd = fwdW.applyMatrix3(Rwb).normalize(); G.up = upW.applyMatrix3(Rwb).normalize();
      G.left = G.up.clone().cross(G.fwd).normalize();
      G.ok = true;
    }
    let wy = 0, wp = 0;
    if (target) {
      _d.copy(target).sub(_cw).normalize().applyMatrix3(Rwb);
      const x = _d.dot(G.left), y = _d.dot(G.up), z = _d.dot(G.fwd);
      if (z > 0.2) { wy = Math.max(-0.38, Math.min(0.38, Math.atan2(x, z))); wp = Math.max(-0.22, Math.min(0.22, Math.atan2(y, Math.hypot(x, z)))); }
    }
    const k = 1 - Math.exp(-9 * Math.max(0, dt || 0));
    G.yaw += (wy - G.yaw) * k; G.pitch += (wp - G.pitch) * k;
    const dir = G.fwd.clone().multiplyScalar(Math.cos(G.pitch) * Math.cos(G.yaw)).addScaledVector(G.left, Math.cos(G.pitch) * Math.sin(G.yaw)).addScaledVector(G.up, Math.sin(G.pitch));
    _q.setFromUnitVectors(G.fwd, dir.normalize());
    gazeU.heroGazeRot.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q));
  }

  function apply(modeWanted) {
    for (const e of entries) {
      let mat = e.orig;
      if (modeWanted === 'realistic') {
        if (!e.real || e.q !== curQ) {
          // смена уровня качества: прежний реалистичный материал освобождаем
          if (e.real && e.real !== hidden && e.real !== e.orig) {
            const i = owned.indexOf(e.real);
            if (i >= 0) owned.splice(i, 1);
            if (atmosphere && atmosphere.releaseEnv) { try { atmosphere.releaseEnv(e.real); } catch (err) { /* ignore */ } }
            e.real.dispose();
          }
          e.real = build(e.orig, curQ); e.q = curQ;
        }
        mat = e.real;
      }
      if (e.index >= 0) { const arr = e.mesh.material.slice(); arr[e.index] = mat; e.mesh.material = arr; }
      else e.mesh.material = mat;
    }
    curMode = modeWanted;
  }

  function setMode(m) { if (m !== 'realistic' && m !== 'anime') return; if (m !== curMode) apply(m); }
  function setQuality(q) {
    const tier = (x) => (x === 'low' || x === 'high' ? x : 'medium');
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
    for (const m of owned) { if (atmosphere && atmosphere.releaseEnv) { try { atmosphere.releaseEnv(m); } catch (e) { /* ignore */ } } m.dispose(); }
    owned.length = 0;
  }

  apply(mode === 'anime' ? 'anime' : 'realistic');
  return {
    setMode, setQuality, dispose, update() {}, updateGaze, holdGaze(p) { G.hold = p || null; },
    // яркость жил лат: 1 — обычно, >1 — вспышка магии, <1 — ослаб
    setGlow(k) { for (const a of armorUs) a.U.heroArmorK.value = a.base * Math.max(0, k); },
    setHurt(k) { hurtU.heroHurtK.value = 1.6 * Math.min(1, Math.max(0, k)); },   // 0…1: вспышка попадания
    get mode() { return curMode; },
    materials: () => entries.map((e) => (e.index >= 0 ? e.mesh.material[e.index] : e.mesh.material)),
    stats: () => {
      const kinds = {};
      for (const e of entries) { const k = classifyMaterial(e.orig && e.orig.name); kinds[k] = (kinds[k] || 0) + 1; }
      return { mode: curMode, count: entries.length, kinds };
    },
  };
}
