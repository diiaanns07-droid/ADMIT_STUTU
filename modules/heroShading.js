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
    // [W4-ЛИЦО] кожа: «обёрнутый» ключевой свет с тёплой полосой у терминатора (дешёвая имитация SSS)
    // и просвет тонких мест (уши, крылья носа, кромка щёк) против контрового — без новых источников и проходов
    const skin = mat.userData.heroKind === 'skin';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 heroKeyColor;\nuniform vec3 heroKeyDir;\nuniform vec3 heroRimColor;\nuniform vec3 heroRimDir;\nuniform vec3 heroFillColor;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 hN = normal;
    vec3 hV = normalize( vViewPosition );
    float hNL = dot( hN, heroKeyDir );
    float hMet = 1.0 - 0.8 * metalnessFactor;
    ${skin ? `float hDiff = saturate( hNL );
    float hWrap = saturate( ( hNL + 0.5 ) / 1.5 );
    totalEmissiveRadiance += diffuseColor.rgb * heroKeyColor * ( hDiff + max( hWrap - hDiff, 0.0 ) * vec3( 0.62, 0.34, 0.26 ) ) * hMet;
    float hTr = pow( saturate( dot( hV, - heroRimDir ) ), 3.0 ) * pow( 1.0 - saturate( dot( hN, hV ) ), 1.5 );
    totalEmissiveRadiance += heroRimColor * diffuseColor.rgb * vec3( 1.0, 0.36, 0.24 ) * hTr * 1.4;` : `float hDiff = mix( saturate( hNL ), saturate( ( hNL + 0.35 ) / 1.35 ), 0.35 );
    totalEmissiveRadiance += diffuseColor.rgb * heroKeyColor * hDiff * hMet;`}
    vec3 hH = normalize( heroKeyDir + hV );
    float hSpec = pow( saturate( dot( hN, hH ) ), mix( 90.0, 12.0, roughnessFactor ) ) * ( 1.0 - roughnessFactor );
    totalEmissiveRadiance += heroKeyColor * hSpec * mix( vec3( 0.1 ), diffuseColor.rgb * 1.8 + 0.06, metalnessFactor ) * ( 1.0 + 0.6 * metalnessFactor );
    float hF = pow( 1.0 - saturate( dot( hN, hV ) ), 4.0 );   // узкая кромка: силуэт, а не заливка тёмных тканей
    totalEmissiveRadiance += heroRimColor * hF * saturate( dot( hN, heroRimDir ) * 0.6 + 0.45 );
    totalEmissiveRadiance += diffuseColor.rgb * heroFillColor * ( 0.4 + 0.6 * saturate( dot( hN, hV ) ) ) * hMet;
  }`);
  };
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'heroLight:' + (mat.userData.heroKind === 'skin' ? 'S:' : '') + (prevKey ? prevKey.call(mat) : '');
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
    ${lips ? `// губы (атлас женского лица Quaternius: центр 94.1, 133.5 из 512 — на оси лица) — влажный блеск
    vec2 hmL = ( vMapUv - vec2( 0.18376, 0.2607 ) ) / vec2( 0.031, 0.0128 );
    roughnessFactor = mix( roughnessFactor, ${(0.32 - 0.16 * (typeof lips === 'number' ? lips : 0.6)).toFixed(3)}, ( 1.0 - smoothstep( 0.5, 1.0, length( hmL ) ) ) * 0.88 );` : ''}
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
  mat.customProgramCacheKey = () => 'heroMicro:' + mode + (lips ? 'L' + (typeof lips === 'number' ? lips.toFixed(2) : '') : '') + ':' + (prevKey ? prevKey.call(mat) : '');
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
    shader.uniforms.heroSkinAmb = uniforms.amb;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float heroSkinWrap;\nuniform vec3 heroSkinTint;\nuniform vec3 heroSkinAmb;')
      .replace(`#include <${pars}>`, patched)
      // [W4-ЛИЦО] рассеянный свет на коже теплее (свет, прошедший под кожей, — красноватый): тень на лице живая, не серая
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= heroSkinAmb;');
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

// =====================================================================================================
// [W4-ЛИЦО] Лица героинь (одна модель Quaternius Ranger на трёх; описание — characterLooks.FACE_LOOKS).
// Морфов и костей лица у модели нет, поэтому всё — на загрузке, один раз:
//   пропорции — деформация вершин кожи, глаз и подводки в позе привязки (нормали — через якобиан деформации,
//               шов шеи с телом не двигается); глаза — «линза» вокруг центра яблока (яблоко, веки и ресницы
//               вместе, heroGear строит веки уже по новым глазам);
//   брови     — треугольники бровей-«плашек» убраны из меша Eyebrows, вместо них лента по коже (проекция на
//               лицо) с процедурной текстурой волосков: тонкая, с изломом и «омбре» от головки к хвосту;
//               тот же меш (1 вызов отрисовки вместо прежнего), тени не бросает;
//   подводка  — полоски век из меша Eyebrows: тоньше, «стрелка» короче (у чародейки — полная), цвет подводки;
//   макияж    — facePainter: консилер запечённых теней вокруг глаз, тени век по стихии, контур носа и скул,
//               румянец, губы по маске их собственного цвета, нежные веснушки (холст атласа 1024², на low 512²);
//   радужка   — масштаб внутри глаза (userData.heroIris на материале глаз, читает buildFromStandard).
// Атлас женского лица Quaternius (512²): центры глаз (68.6, 91) и (119.6, 91), разрез глаза 12×12 px,
// кончик носа (94.1, 113.5), губы — центр (94.1, 133.5), рот — v ≈ 133.5.
const FACE_UV = { eyeL: [119.6, 91.0], eyeR: [68.6, 91.0], mid: 94.08, eyeW: 6.2, eyeTop: 85.2, eyeBot: 96.9, nose: 113.5, sub: 121.5, lips: 133.5 };
const faceTexCache = new Map();
const fss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// части головы героини: кожа лица (MI_Regular_Female, самый высокий меш), глаза (MI_Eyes), брови (меш Eyebrows)
function faceParts(vrm) {
  const P = { face: null, eyes: null, brows: null };
  let top = -Infinity;
  vrm.scene.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || !o.material || !o.geometry || !o.geometry.attributes.position) return;
    const n = o.material.name || '';
    if (/^MI_Regular_Female/.test(n) && o.geometry.attributes.uv && o.geometry.index) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.geometry.boundingBox.max.y > top) { top = o.geometry.boundingBox.max.y; P.face = o; }
    } else if (/^MI_Eyes/.test(n)) P.eyes = o;
    else if (/Eyebrow/i.test(o.name) && o.geometry.index) P.brows = o;
  });
  if (!P.face || !P.eyes) return null;
  // сферы глаз по половинам меша глаз (ось «лево–право» — x позы привязки)
  const pa = P.eyes.geometry.attributes.position, eyes = [];
  for (const s of [1, -1]) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pa.count; i++) {
      if (Math.sign(pa.getX(i)) !== s) continue;
      const v = [pa.getX(i), pa.getY(i), pa.getZ(i)];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
    if (!Number.isFinite(lo[0])) return null;
    eyes.push({ s, c: lo.map((x, k) => (x + hi[k]) / 2), r: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 });
  }
  if (!(eyes[0].r > 0.005 && eyes[0].r < 0.04)) return null;   // не та развёртка/масштаб — лицо не трогаем
  P.eyeList = eyes;
  return P;
}

// поле деформации лица (метры позы привязки): возвращает out = f(p)
function faceWarp(P, shape, eyeK) {
  const eyes = P.eyeList, ey = eyes[0].c[1], r = eyes[0].r;
  const jaw = 0.075 * (shape.jaw || 0), chin = shape.chin || 0, nose = shape.nose || 0, cheek = shape.cheek || 0;
  // ориентиры от глаз (у модели: глаза y ≈ 1.656, кончик носа на 0.039 ниже, рот на 0.069, подбородок на 0.104)
  const yNose = ey - 0.0393, yMouth = ey - 0.069, yChin = ey - 0.104, zNose = eyes[0].c[2] + 0.0528;
  return (x, y, z, out) => {
    let X = x, Y = y, Z = z;
    const ax = Math.abs(x), sx = Math.sign(x) || 1;
    // челюсть: уже от скул к углу челюсти, у шеи и на затылке — без изменений (шов с телом на y ≈ 1.45)
    if (jaw > 0) {
      const wy = fss(ey - 0.024, ey - 0.068, y) * (1 - fss(ey - 0.112, ey - 0.142, y));
      const wz = fss(-0.045, -0.012, z), wx = fss(0.008, 0.045, ax);
      const w = wy * wz * wx;
      if (w > 0) { X = x * (1 - jaw * w); Y = y + 0.0018 * (jaw / 0.075) * w * fss(0.03, 0.06, ax); }
    }
    // подбородок: чуть уже, мягче и чуть меньше выступает вперёд
    if (chin > 0) {
      const d2 = (x / 0.02) ** 2 + ((y - yChin - 0.004) / 0.016) ** 2 + ((z - (zNose - 0.035)) / 0.03) ** 2;
      const w = Math.exp(-d2);
      if (w > 1e-3) { X *= 1 - 0.12 * chin * w; Z -= 0.0022 * chin * w; Y += 0.0012 * chin * w; }
    }
    // нос: уже крылья и спинка, кончик аккуратнее (чуть меньше, назад и вверх)
    if (nose > 0 && z > zNose - 0.04) {
      const wn = fss(zNose - 0.036, zNose - 0.02, z) * Math.exp(-(((y - yNose - 0.006) / 0.02) ** 2)) * (1 - fss(0.016, 0.03, ax));
      if (wn > 1e-3) X *= 1 - 0.2 * nose * wn;
      const dt = ((x / 0.009) ** 2 + ((y - yNose) / 0.008) ** 2 + ((z - zNose) / 0.012) ** 2);
      const wt = Math.exp(-dt);
      if (wt > 1e-3) { X *= 1 - 0.1 * nose * wt; Z -= 0.0016 * nose * wt; Y += 0.0007 * nose * wt; }
    }
    // скулы: яблочки чуть выше и мягче
    if (cheek > 0) {
      for (const e of eyes) {
        const d2 = ((x - e.c[0] * 0.95) / 0.016) ** 2 + ((y - (ey - 0.03)) / 0.014) ** 2;
        const w = Math.exp(-d2) * fss(0.02, 0.05, z);
        if (w > 1e-3) { Y += 0.0012 * cheek * w; Z += 0.0006 * cheek * w; }
      }
    }
    // глаза: «линза» вокруг центра яблока — внутри 1.15 r масштаб полный, к 2.3 r гаснет
    if (eyeK && eyeK !== 1) {
      for (const e of eyes) {
        const dx = X - e.c[0], dy = Y - e.c[1], dz = Z - e.c[2];
        const rho = Math.hypot(dx, dy, dz);
        if (rho > 2.3 * e.r) continue;
        const k = 1 + (eyeK - 1) * (1 - fss(1.15 * e.r, 2.3 * e.r, rho));
        X = e.c[0] + dx * k; Y = e.c[1] + dy * k; Z = e.c[2] + dz * k;
      }
    }
    void sx; void yMouth; void r;
    out[0] = X; out[1] = Y; out[2] = Z;
  };
}

// применить поле к своей копии геометрии меша; нормали (и касательные) — через якобиан конечными разностями
function warpMesh(mesh, warp) {
  const g = mesh.geometry.clone();
  const pa = g.attributes.position, na = g.attributes.normal, ta = g.attributes.tangent;
  const q = [0, 0, 0], qx = [0, 0, 0], qy = [0, 0, 0], qz = [0, 0, 0], e = 2e-4;
  let moved = 0;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
    warp(x, y, z, q);
    if ((q[0] - x) ** 2 + (q[1] - y) ** 2 + (q[2] - z) ** 2 < 1e-14) continue;
    moved++;
    if (na || ta) {
      warp(x + e, y, z, qx); warp(x, y + e, z, qy); warp(x, y, z + e, qz);
      // J — столбцы ∂f/∂x, ∂f/∂y, ∂f/∂z
      const a = (qx[0] - q[0]) / e, b = (qy[0] - q[0]) / e, c = (qz[0] - q[0]) / e;
      const d = (qx[1] - q[1]) / e, f = (qy[1] - q[1]) / e, h = (qz[1] - q[1]) / e;
      const k = (qx[2] - q[2]) / e, l = (qy[2] - q[2]) / e, m = (qz[2] - q[2]) / e;
      if (na) {
        // n' ∝ cof(J)·n (= det·J^-T·n): без деления на определитель
        const nx = na.getX(i), ny = na.getY(i), nz = na.getZ(i);
        const c00 = f * m - h * l, c01 = -(d * m - h * k), c02 = d * l - f * k;
        const c10 = -(b * m - c * l), c11 = a * m - c * k, c12 = -(a * l - b * k);
        const c20 = b * h - c * f, c21 = -(a * h - c * d), c22 = a * f - b * d;
        let ox = c00 * nx + c10 * ny + c20 * nz, oy = c01 * nx + c11 * ny + c21 * nz, oz = c02 * nx + c12 * ny + c22 * nz;
        const L = Math.hypot(ox, oy, oz) || 1;
        na.setXYZ(i, ox / L, oy / L, oz / L);
      }
      if (ta) {
        const tx = ta.getX(i), ty = ta.getY(i), tz = ta.getZ(i);
        let ox = a * tx + b * ty + c * tz, oy = d * tx + f * ty + h * tz, oz = k * tx + l * ty + m * tz;
        const L = Math.hypot(ox, oy, oz) || 1;
        ta.setXYZ(i, ox / L, oy / L, oz / L);
      }
    }
    pa.setXYZ(i, q[0], q[1], q[2]);
  }
  pa.needsUpdate = true; if (na) na.needsUpdate = true; if (ta) ta.needsUpdate = true;
  g.computeBoundingBox(); g.computeBoundingSphere();
  if (mesh.geometry.userData && mesh.geometry.userData.faceW4) mesh.geometry.dispose();   // своя прежняя копия
  g.userData.faceW4 = true;
  mesh.geometry = g;
  return moved;
}

// фронтальная проекция на кожу лица: самое переднее пересечение луча вдоль −z (область бровей и век)
function faceSurface(P, box) {
  const g = P.face.geometry, pa = g.attributes.position, na = g.attributes.normal, ix = g.index;
  const T = [];
  for (let t = 0; t < ix.count; t += 3) {
    const a = ix.getX(t), b = ix.getX(t + 1), c = ix.getX(t + 2);
    const xs = [pa.getX(a), pa.getX(b), pa.getX(c)], ys = [pa.getY(a), pa.getY(b), pa.getY(c)], zs = [pa.getZ(a), pa.getZ(b), pa.getZ(c)];
    if (Math.max(...xs) < box[0] || Math.min(...xs) > box[1] || Math.max(...ys) < box[2] || Math.min(...ys) > box[3] || Math.max(...zs) < box[4]) continue;
    T.push([a, b, c, xs, ys, zs]);
  }
  return (x, y, outP, outN) => {
    let best = -Infinity, hit = null, w0 = 0, w1 = 0, w2 = 0;
    for (const tr of T) {
      const [, , , xs, ys, zs] = tr;
      const d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
      if (Math.abs(d) < 1e-14) continue;
      const l0 = ((ys[1] - ys[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (y - ys[2])) / d;
      const l1 = ((ys[2] - ys[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (y - ys[2])) / d;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const z = l0 * zs[0] + l1 * zs[1] + l2 * zs[2];
      if (z > best) { best = z; hit = tr; w0 = l0; w1 = l1; w2 = l2; }
    }
    if (!hit) return false;
    outP[0] = x; outP[1] = y; outP[2] = best;
    const [a, b, c] = hit;
    let nx = na.getX(a) * w0 + na.getX(b) * w1 + na.getX(c) * w2, ny = na.getY(a) * w0 + na.getY(b) * w1 + na.getY(c) * w2, nz = na.getZ(a) * w0 + na.getZ(b) * w1 + na.getZ(c) * w2;
    const L = Math.hypot(nx, ny, nz) || 1;
    outN[0] = nx / L; outN[1] = ny / L; outN[2] = nz / L;
    return true;
  };
}

// средняя линия брови (x от головки к хвосту): подъём к излому с замедлением, спуск к хвосту с ускорением
function browCurve(b) {
  const [xi, yi] = b.inner, [xp, yp] = b.peak, [xt, yt] = b.tail;
  return (t) => {
    const x = xi + (xt - xi) * t;
    let y;
    if (x <= xp) { const s = (x - xi) / (xp - xi); y = yi + (yp - yi) * (1 - (1 - s) * (1 - s)); }
    else { const s = (x - xp) / (xt - xp); y = yp - (yp - yt) * Math.pow(s, 1.7); }
    return [x, y];
  };
}
// толщина: скруглённая головка, полная к излому, тонкий хвост
function browWidth(b, t) {
  const [w0, w1, w2] = b.w, tp = b.peakT ?? 0.62;
  const w = t < tp ? w0 + (w1 - w0) * fss(0, tp, t) : w1 + (w2 - w1) * Math.pow(fss(tp, 1, t), 0.85);
  return w * (0.72 + 0.28 * fss(0, 0.07, t));
}

// текстура бровей и подводки (один холст — один материал, один вызов отрисовки):
//   верх холста (BROW_ROWS) — бровь: x — вдоль (головка → хвост), y — поперёк (верх холста — верх брови).
//   «Омбре»: головка прозрачнее и мягче, тон набирается к излому, хвост тает. Волоски «ёлочкой»: у головки
//   растут вверх, ниже средней линии — вверх-наружу, выше — вниз-наружу, в хвосте — вдоль;
//   низ холста — подводка: сплошная полоса с мягкими кромками (сглаживание тонкой линии).
// Между областями — прозрачный зазор (мип-уровни не смешивают бровь и подводку). Кэш по стилю брови.
const BROW_MARGIN = 1.7;
function browTexture(THREE, b, N) {
  const soft = b.soft ?? 0.7, hair = b.hair ?? 0.8, seed0 = b.seed ?? 3;
  const key = `brow:${soft}:${hair}:${seed0}:${N}`;
  if (faceTexCache.has(key)) return faceTexCache.get(key);
  if (typeof document === 'undefined') return null;
  const W = N, Hb = Math.max(16, N / 8), gap = Math.max(4, N / 64), Hl = Math.max(4, N / 64), H = Hb + gap + Hl;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const B = 1 / BROW_MARGIN;
  // маска формы брови (альфа 0…1)
  const mask = new Float32Array(W * Hb);
  for (let y = 0; y < Hb; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, s = 1 - (2 * (y + 0.5)) / Hb;
    const along = (0.3 + 0.7 * Math.pow(fss(0.0, 0.32, u), 0.55 + soft)) * (1 - Math.pow(fss(0.72, 1.0, u), 1.2));
    const half = B * (1.0 + 0.12 * (1 - u));
    const edge = 1 - fss(half * (0.42 - 0.12 * soft * (1 - u)), half * 1.05, Math.abs(s - 0.06 * (1 - u)));
    mask[y * W + x] = along * edge;
  }
  // «пудра» — мягкая база
  const img = g.createImageData(W, H);
  for (let i = 0; i < W * Hb; i++) { img.data[i * 4] = 236; img.data[i * 4 + 1] = 230; img.data[i * 4 + 2] = 224; img.data[i * 4 + 3] = Math.round(255 * Math.min(1, mask[i] * (0.62 - 0.22 * hair))); }
  // подводка: полоса на всю ширину, мягкие кромки поперёк
  for (let y = 0; y < Hl; y++) {
    const s = Math.abs((y + 0.5) / Hl - 0.5) * 2, a = 1 - fss(0.45, 1.0, s);
    for (let x = 0; x < W; x++) { const i = ((Hb + gap + y) * W + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(255 * a); }
  }
  g.putImageData(img, 0, 0);
  // волоски
  let sd = seed0 * 7919 + 17;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const n = Math.round((N / 512) * 520 * (0.6 + 0.6 * hair));
  g.save();
  g.beginPath(); g.rect(0, 0, W, Hb); g.clip();
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const u = Math.pow(rnd(), 0.9), s = (rnd() * 2 - 1) * B * 0.95;
    const m = mask[Math.min(Hb - 1, Math.max(0, Math.round((1 - s) * 0.5 * Hb - 0.5))) * W + Math.min(W - 1, Math.round(u * W - 0.5))];
    if (m < 0.08 || rnd() > m + 0.15) continue;
    // угол роста к оси брови (радианы, + — вверх)
    const head = 1 - fss(0.06, 0.2, u), tail = fss(0.62, 0.95, u);
    let ang = (s < 0 ? 0.42 : -0.3) * (1 - head) * (1 - tail) + 1.25 * head + 0.08 * tail;
    ang += (rnd() - 0.5) * 0.35;
    // холст почти изотропный: длина брови ≈ 48 мм на W px, ширина ленты ≈ 6 мм на Hb = W/8 px
    const len = (2.0 + rnd() * 1.6) * (1 - 0.35 * tail) * (W / 48);
    const x0 = u * W, y0 = (1 - s) * 0.5 * Hb;
    const dx = Math.cos(ang) * len, dy = -Math.sin(ang) * len;
    const v = 205 + rnd() * 50, a = (0.28 + rnd() * 0.42) * (0.55 + 0.45 * hair);
    g.strokeStyle = `rgba(${v | 0},${(v * 0.96) | 0},${(v * 0.92) | 0},${a.toFixed(3)})`;
    g.lineWidth = (0.7 + rnd() * 0.6) * (N / 512) * 1.4;
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(x0 + dx * 0.55, y0 + dy * 0.45, x0 + dx, y0 + dy); g.stroke();
  }
  g.restore();
  // форма — по маске (волоски у кромки тают, не торчат за контур)
  const d = g.getImageData(0, 0, W, Hb);
  for (let i = 0; i < W * Hb; i++) d.data[i * 4 + 3] = Math.round(d.data[i * 4 + 3] * Math.min(1, mask[i] * 1.6));
  g.putImageData(d, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // доли высоты холста (uv.v снизу вверх, flipY): подводка — [0, liner], бровь — [brow, 1]
  t.userData.faceV = { liner: Hl / H, brow: (Hl + gap) / H };
  faceTexCache.set(key, t);
  return t;
}

// верхнее веко по контуру разреза глаза: пересечения рёбер кожи со сферой глаза (передняя половина),
// выше линии уголков → функция y(x) на [xi, xo] (|x|, от внутреннего угла к внешнему)
function upperLid(P, e) {
  const g = P.face.geometry, pa = g.attributes.position, ix = g.index;
  const [cx, cy, cz] = e.c, r = e.r, s = Math.sign(cx) || 1;
  const pts = [];
  const sd = (i) => Math.hypot(pa.getX(i) - cx, pa.getY(i) - cy, pa.getZ(i) - cz) - r;
  for (let t = 0; t < ix.count; t += 3) for (let k = 0; k < 3; k++) {
    const a = ix.getX(t + k), b = ix.getX(t + ((k + 1) % 3));
    const da = sd(a), db = sd(b);
    if ((da < 0) === (db < 0)) continue;
    const w = da / (da - db);
    const z = pa.getZ(a) + (pa.getZ(b) - pa.getZ(a)) * w;
    if (z < cz) continue;
    pts.push([(pa.getX(a) + (pa.getX(b) - pa.getX(a)) * w) * s, pa.getY(a) + (pa.getY(b) - pa.getY(a)) * w]);
  }
  if (pts.length < 8) return null;
  let iIn = 0, iOut = 0;
  pts.forEach((p, i) => { if (p[0] < pts[iIn][0]) iIn = i; if (p[0] > pts[iOut][0]) iOut = i; });
  const [xi, yi] = pts[iIn], [xo, yo] = pts[iOut];
  const up = pts.filter((p) => p[1] >= yi + ((yo - yi) * (p[0] - xi)) / (xo - xi || 1) + 0.12 * r);
  up.push([xi, yi], [xo, yo]);
  up.sort((p, q) => p[0] - q[0]);
  // сглаживание 1-2-1 (рёбра сетки — ломаная)
  const sm = up.map((p, i) => (i === 0 || i === up.length - 1 ? p : [p[0], (up[i - 1][1] + 2 * p[1] + up[i + 1][1]) / 4]));
  const yAt = (x) => {
    if (x <= sm[0][0]) return sm[0][1];
    for (let i = 1; i < sm.length; i++) if (x <= sm[i][0]) { const t = (x - sm[i - 1][0]) / (sm[i][0] - sm[i - 1][0] || 1); return sm[i - 1][1] + (sm[i][1] - sm[i - 1][1]) * t; }
    return sm[sm.length - 1][1];
  };
  return { xi, xo, yi, yo, yAt };
}

// лента бровей и подводки на коже (обе стороны в одной геометрии, скиннинг — целиком на кость головы)
function buildBrows(THREE, P, b, E, quality) {
  const face = P.face, bones = face.skeleton && face.skeleton.bones;
  if (!bones) return null;
  let head = bones.findIndex((x) => /^head$/i.test(x.name));
  if (head < 0) head = bones.findIndex((x) => /head/i.test(x.name));
  if (head < 0) return null;
  const e0 = P.eyeList[0];
  const surf = faceSurface(P, [-0.09, 0.09, e0.c[1] - 1.4 * e0.r, e0.c[1] + 0.05, 0.0]);
  const tex = browTexture(THREE, b, quality === 'low' ? 256 : 512);
  const fv = (tex && tex.userData.faceV) || { liner: 0.08, brow: 0.12 };
  const pos = [], nor = [], uv = [], col = [], idx = [], sI = [], sW = [], linerV = [];
  const p = [0, 0, 0], nn = [0, 0, 0];
  const cB = new THREE.Color(b.color ?? 0x3a2a20), cL = new THREE.Color(E.liner ?? 0x1a1010);
  const lin = [Math.min(1, cL.r / Math.max(1e-4, cB.r)), Math.min(1, cL.g / Math.max(1e-4, cB.g)), Math.min(1, cL.b / Math.max(1e-4, cB.b))];
  // лента: centre(t) → [x, y], half(t) — полуширина, tan — направление; ряды поперёк → вершины на коже
  function ribbon(side, NA, rows, centre, half, vMap, rgb, lift = 0.00032) {
    const base = pos.length / 3;
    for (let i = 0; i <= NA; i++) {
      const t = i / NA, [cx, cy] = centre(t), [ax, ay] = centre(Math.min(1, t + 0.01)), [bx, by] = centre(Math.max(0, t - 0.01));
      let tx = ax - bx, ty = ay - by; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const hw = half(t);
      for (const v of rows) {
        const o = (v - 0.5) * 2 * hw;
        if (!surf(cx - ty * o, cy + tx * o, p, nn)) return false;
        pos.push(side * (p[0] + nn[0] * lift), p[1] + nn[1] * lift, p[2] + nn[2] * lift);
        nor.push(side * nn[0], nn[1], nn[2]);
        uv.push(t, vMap(v)); col.push(rgb[0], rgb[1], rgb[2], 1);
        sI.push(head, 0, 0, 0); sW.push(1, 0, 0, 0);
      }
    }
    const R = rows.length;
    for (let i = 0; i < NA; i++) for (let j = 0; j < R - 1; j++) {
      const a = base + i * R + j, c = a + R;
      if (side > 0) idx.push(a, c, a + 1, c, c + 1, a + 1); else idx.push(a, a + 1, c, c, a + 1, c + 1);
    }
    return true;
  }
  const curve = browCurve(b);
  for (const side of [1, -1]) {
    if (!ribbon(side, 30, [0, 0.25, 0.5, 0.75, 1], curve, (t) => browWidth(b, t) * BROW_MARGIN * 0.5, (v) => fv.brow + v * (1 - fv.brow), [1, 1, 1])) return null;
    // подводка: от внутреннего угла (тонко) к внешнему (толще) по краю века, дальше — «стрелка» вверх-наружу
    const e = P.eyeList.find((q) => Math.sign(q.c[0]) === 1) || e0;
    const lid = E.linerW ? upperLid(P, e) : null;
    if (lid) {
      const W0 = E.linerW, wl = E.wing || 0, up = E.wingUp ?? 0.3;
      // по веку — до 90% разреза (у самого угла веко круто уходит вниз — подводка от него отрывается),
      // дальше «стрелка» наружу и вверх под углом wingUp к горизонтали
      const span = lid.xo - lid.xi, x0 = lid.xi + span * 0.06, x1 = lid.xi + span * 0.9;
      const wx = Math.cos(up), wy = Math.sin(up);
      const lidLen = x1 - x0, tot = lidLen + wl, tl = lidLen / (tot || 1);
      const centre = (t) => {
        if (t <= tl || wl <= 0) { const x = x0 + (lidLen * Math.min(t, tl)) / (tl || 1); return [x, lid.yAt(x) + half(t) + 0.00012]; }
        const d = ((t - tl) / (1 - tl)) * wl;
        return [x1 + wx * d, lid.yAt(x1) + half(tl) + 0.00012 + wy * d];
      };
      function half(t) {
        const k = t <= tl ? 0.25 + 0.75 * fss(0, 0.8, t / (tl || 1)) : 1 - fss(0, 1, (t - tl) / (1 - tl || 1)) * 0.92;
        return W0 * 0.5 * k;
      }
      const v0 = pos.length / 3;
      if (ribbon(side, wl > 0.002 ? 28 : 20, [0, 0.5, 1], centre, half, (v) => v * fv.liner, lin, 0.00028)) linerV.push([v0, pos.length / 3]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sW, 4));
  g.setIndex(idx);
  // лицевая сторона треугольников — наружу (по нормали кожи)
  {
    const A = new THREE.Vector3().fromArray(pos, idx[0] * 3), Bv = new THREE.Vector3().fromArray(pos, idx[1] * 3), C = new THREE.Vector3().fromArray(pos, idx[2] * 3);
    const fn = Bv.sub(A).cross(C.sub(A));
    if (fn.dot(new THREE.Vector3().fromArray(nor, idx[0] * 3)) < 0) { for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; } g.setIndex(idx); }
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData.faceW4 = true;
  const mat = new THREE.MeshStandardMaterial({
    name: 'FaceBrow#W4', map: tex, color: cB, vertexColors: true, transparent: true, depthWrite: false,
    roughness: 0.78, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = 'BrowStrands';
  mesh.bind(face.skeleton, face.bindMatrix);
  mesh.bindMode = face.bindMode;
  mesh.position.copy(face.position); mesh.quaternion.copy(face.quaternion); mesh.scale.copy(face.scale);
  mesh.frustumCulled = false; mesh.receiveShadow = true;
  noShadowCast(mesh);
  mesh.renderOrder = 1;
  face.parent.add(mesh);
  if (linerV.length) blinkLiner(THREE, mesh, linerV);
  return mesh;
}

// Моргание: подводка лежит на неподвижной коже века, а шторка века (heroGear, группа 'eyelid') опускается —
// пока она закрыта, подводка тает (альфа вершинами; выгружается только диапазон подводки и только на моргании).
// Угол шторки — от её положения при открытом глазе (у открытого глаза шторка в нулевом масштабе).
function blinkLiner(THREE, mesh, ranges) {
  const ca = mesh.geometry.attributes.color;
  let pivots = null, tries = 0, alpha = 1;
  const q0 = [];
  mesh.onBeforeRender = () => {
    if (!pivots) {
      if (++tries > 240) { mesh.onBeforeRender = () => {}; return; }   // у героини нет век — проверять перестаём
      let root = mesh; while (root.parent) root = root.parent;
      const found = [];
      root.traverse((o) => { if (o.name === 'eyelid' && o.children.length) found.push(o); });
      if (!found.length) return;
      pivots = found; for (const pv of pivots) q0.push(pv.quaternion.clone());
    }
    let ang = 0;
    for (let i = 0; i < pivots.length; i++) {
      const pv = pivots[i], lid = pv.children[0];
      if (lid && lid.scale.x < 0.01) { q0[i].copy(pv.quaternion); continue; }   // открыт — запомнить покой
      const d = Math.abs(q0[i].dot(pv.quaternion));
      ang = Math.max(ang, 2 * Math.acos(Math.min(1, d)));
    }
    const a = 1 - fss(0.06, 0.32, ang);
    if (Math.abs(a - alpha) < 0.02) return;
    alpha = a;
    ca.clearUpdateRanges();
    for (const [lo, hi] of ranges) { for (let i = lo; i < hi; i++) ca.setW(i, a); ca.addUpdateRange(lo * 4, (hi - lo) * 4); }
    ca.needsUpdate = true;
  };
}
// тонкие детали лица теней не бросают (LOD героя переключает castShadow у всех мешей — здесь всегда «нет»)
function noShadowCast(o) {
  try { Object.defineProperty(o, 'castShadow', { get: () => false, set: () => {}, configurable: true }); } catch (e) { o.castShadow = false; }
}

// Лицо героини: пропорции, глаза, брови и подводка. Вызывать на свежезагруженной модели (поза привязки),
// до shadeHero и heroGear (они строят материалы, веки и ресницы по уже изменённому лицу).
// → { brows, moved } или null, если это не женская голова Quaternius
export function beautifyFace(THREE, vrm, look, { quality = 'medium' } = {}) {
  if (!look) return null;
  const P = faceParts(vrm);
  if (!P) return null;
  const eyeK = (look.eyes && look.eyes.scale) || 1;
  const warp = faceWarp(P, look.shape || {}, eyeK);
  const moved = warpMesh(P.face, warp) + warpMesh(P.eyes, warp);
  // глаза — новые центры и радиус после «линзы» (для подводки и проекции)
  const P2 = faceParts(vrm) || P;
  // брови-«плашки» и полоски век модели (меш Eyebrows) не рисуются: вместо них — лента бровей и подводки
  if (P.brows) { P.brows.visible = false; noShadowCast(P.brows); }
  const brows = look.brow ? buildBrows(THREE, P2, look.brow, look.eyes || {}, quality) : null;
  // радужка крупнее (читает buildFromStandard) и тёплый подповерхностный оттенок кожи
  if (look.eyes && look.eyes.iris) P.eyes.material.userData.heroIris = look.eyes.iris;
  if (look.skin && look.skin.glow !== undefined) P.face.material.userData.heroSkinGlow = look.skin.glow;
  if (look.lips && look.lips.gloss !== undefined) P.face.material.userData.heroLipGloss = look.lips.gloss;
  vrm.scene.userData.faceW4 = true;
  return { brows, moved };
}

// Макияж на атласе лица по описанию FACE_LOOKS (поверх перекрашенного холста; src — исходные пиксели атласа
// до перекраски, по ним — маска губ). Масштаб холста любой (координаты — в долях атласа 512²).
export function facePainter(look) {
  if (!look) return null;
  const hex = (c, a) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
  const E = look.eyes || {}, Sk = look.skin || {}, Lp = look.lips || null;
  return (g, W, H, src = null) => {
    const S = W / 512, X = (u) => u * S, Y = (v) => (v * H) / 512;
    const eyes = [[FACE_UV.eyeL, 1], [FACE_UV.eyeR, -1]];   // side: +1 — к внешнему углу +u
    const blob = (cx, cy, rx, ry, rot, col, a, op = 'source-over', inner = 0) => {
      g.save(); g.globalCompositeOperation = op;
      g.translate(X(cx), Y(cy)); g.rotate(rot); g.scale(1, ry / rx);
      const gr = g.createRadialGradient(0, 0, X(rx) * inner, 0, 0, X(rx));
      gr.addColorStop(0, hex(col, a)); gr.addColorStop(1, hex(col, 0));
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, X(rx), 0, Math.PI * 2); g.fill(); g.restore();
    };
    // тон кожи: средний цвет лба (после перекраски) — для консилера и бликов
    let skin = 0xd8a088;
    try {
      const d = g.getImageData(X(FACE_UV.mid - 8), Y(56), Math.max(1, X(16)), Math.max(1, Y(8))).data;
      let r = 0, gg = 0, b = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      if (n) skin = (Math.round(r / n) << 16) | (Math.round(gg / n) << 8) | Math.round(b / n);
    } catch (e) { /* холст без чтения — тон по умолчанию */ }
    const lift = (c, k) => { const f = (x) => Math.min(255, Math.round(x + (255 - x) * k)); return (f((c >> 16) & 255) << 16) | (f((c >> 8) & 255) << 8) | f(c & 255); };
    // 1. консилер: запечённые тени вокруг глаз (впалые глаза) мягче, под глазами свежее
    const conceal = Sk.conceal ?? 0;
    if (conceal > 0) for (const [[u, v], s] of eyes) {
      blob(u + s * 1.0, v + 1.5, 15.5, 12.5, 0, skin, 0.42 * conceal, 'source-over', 0.45);
      blob(u + s * 0.5, v + 8.5, 9.5, 4.0, 0, lift(skin, 0.06), 0.4 * conceal, 'source-over', 0.2);
    }
    // 2. контур: тонкий нос (тень по бокам спинки, свет по спинке), лёгкий свет на скулах
    const ct = Sk.contour ?? 0;
    if (ct > 0) {
      for (const s of [1, -1]) blob(FACE_UV.mid + s * 5.6, 105, 2.2, 10, 0, 0x8a5a44, 0.16 * ct, 'multiply', 0.1);
      blob(FACE_UV.mid, 104, 1.6, 9.5, 0, lift(skin, 0.22), 0.22 * ct, 'source-over', 0.2);
      for (const [[u], s] of eyes) blob(u + s * 4, 104.5, 7.5, 3.4, s * -0.35, lift(skin, 0.18), 0.2 * ct, 'source-over', 0.1);
    }
    // 3. тени век по стихии: основной тон по подвижному веку, второй — к внешнему углу, дымка по нижнему веку
    if (E.shadow !== undefined) for (const [[u, v], s] of eyes) {
      blob(u + s * 1.2, FACE_UV.eyeTop - 1.4, 9.5, 4.2, s * -0.18, E.shadow, E.shadowA ?? 0.4, 'multiply', 0.15);
      if (E.shadow2 !== undefined) blob(u + s * 5.5, FACE_UV.eyeTop - 2.6, 6.5, 3.2, s * -0.5, E.shadow2, (E.shadowA ?? 0.4) * 0.55, 'multiply', 0.1);
      blob(u - s * 1.0, FACE_UV.eyeTop - 2.2, 4.0, 2.4, 0, lift(skin, 0.28), 0.18, 'source-over', 0.1);   // свет в центре века
      if (E.lower) blob(u + s * 2.5, FACE_UV.eyeBot + 1.1, 6.5, 1.5, s * 0.12, E.shadow, E.lower, 'multiply', 0.1);
    }
    // 4. румянец на «яблочках» щёк
    if (Sk.blush !== undefined) for (const [[u], s] of eyes) blob(u + s * 3, 110, 13, 8, s * -0.25, Sk.blush, Sk.blushA ?? 0.18, 'source-over', 0.05);
    // 5. губы: маска — собственный цвет губ на исходном атласе (краснее кожи), тон — к центру нижней губы
    if (Lp && src) {
      const x0 = Math.floor(X(74)), x1 = Math.ceil(X(114)), y0 = Math.floor(Y(123)), y1 = Math.ceil(Y(144));
      const w = x1 - x0, h = y1 - y0;
      try {
        const d = g.getImageData(x0, y0, w, h), px = d.data;
        const lc = [(Lp.color >> 16) & 255, (Lp.color >> 8) & 255, Lp.color & 255], tc = Lp.tint !== undefined ? [(Lp.tint >> 16) & 255, (Lp.tint >> 8) & 255, Lp.tint & 255] : lc;
        const a = Lp.a ?? 0.6;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const gx = x0 + x, gy = y0 + y, si = (gy * W + gx) * 4;
          const R = src[si], G = src[si + 1];
          const red = (R - G) / (R + 1);
          const u = gx / S, v = (gy * 512) / H;
          const ell = 1 - fss(0.82, 1.08, Math.hypot((u - FACE_UV.mid) / 18.5, (v - FACE_UV.lips) / 9.5));
          const m = fss(0.29, 0.37, red) * ell;
          if (m < 0.01) continue;
          // нижняя губа (v > рта) светлее к центру — объём; линия рта темнее
          const low = fss(FACE_UV.lips + 0.5, FACE_UV.lips + 3.5, v) * (1 - fss(2, 11, Math.abs(u - FACE_UV.mid)));
          const line = 1 - fss(0.4, 1.6, Math.abs(v - FACE_UV.lips));
          const i = (y * w + x) * 4, k = m * a;
          for (let q = 0; q < 3; q++) {
            const c = lc[q] + (tc[q] - lc[q]) * low * 0.8;
            // цвет помады: смесь «умножения» на кожу губ (сохраняет рельеф атласа) и самого тона
            const tgt = Math.min(255, (c * px[i + q]) / 255 * 1.18) * 0.62 + c * 0.38;
            px[i + q] = (px[i + q] * (1 - k) + tgt * k) * (1 - 0.22 * line * m);
          }
        }
        g.putImageData(d, x0, y0);
      } catch (e) { /* без губ */ }
    }
    // 6. веснушки: мелкие и редкие, по спинке носа и верху щёк, гуще к центру — едва заметные
    if (Sk.freckles !== undefined && S >= 1.5) {
      let sd = 29;
      const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
      const fa = Sk.frecklesA ?? 0.5;
      for (let i = 0; i < 110; i++) {
        const s = rnd() < 0.5 ? -1 : 1, k = rnd();
        const du = s * (1.5 + k * k * 30), dv = (rnd() - 0.5) * 11 - Math.abs(du) * 0.06;
        const u = FACE_UV.mid + du, v = 106 + dv;
        if (Math.abs(du) < 4.5 && v > 109) continue;   // кончик носа и ноздри — чистые
        const fall = Math.exp(-(((Math.abs(du) - 10) / 16) ** 2));
        const a = (0.16 + rnd() * 0.22) * fa * (0.35 + 0.65 * fall);
        blob(u, v, 0.55 + rnd() * 0.45, 0.45 + rnd() * 0.35, rnd() * 3, Sk.freckles, a, 'multiply', 0.3);
      }
    }
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
  const src0 = paint ? new Uint8ClampedArray(px) : null;   // [W4-ЛИЦО] исходные пиксели: по ним маска губ макияжа
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
  if (paint) { try { paint(g, w, h, src0); } catch (e) { /* без макияжа */ } }
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
  // [W4-ЛИЦО] подповерхностный оттенок кожи: у героинь — по FACE_LOOKS.skin.glow (userData.heroSkinGlow на материале лица)
  const skinU = { wrap: { value: 0.55 }, tint: { value: new THREE.Color(1.0, 0.42, 0.32) }, amb: { value: new THREE.Color(1.04, 0.98, 0.95) } };
  vrm.scene.traverse((o) => {
    const mt = o.isMesh && !Array.isArray(o.material) ? o.material : null;
    const g = mt && mt.userData ? mt.userData.heroSkinGlow : undefined;
    if (g === undefined) return;
    const k = Math.max(0, Math.min(1, g));
    skinU.wrap.value = 0.5 + 0.15 * k;
    skinU.tint.value.setRGB(1.0, 0.42 - 0.06 * k, 0.32 - 0.07 * k).multiplyScalar(0.85 + 0.3 * k);
    skinU.amb.value.setRGB(1.03 + 0.04 * k, 0.98, 0.95 - 0.03 * k);
  });
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
    // [W4-ЛИЦО] лента бровей и подводки: цвет подводки — вершинами, смещение полигонов — поверх кожи без мерцания
    if (orig.vertexColors) m.vertexColors = true;
    if (orig.polygonOffset) { m.polygonOffset = true; m.polygonOffsetFactor = orig.polygonOffsetFactor; m.polygonOffsetUnits = orig.polygonOffsetUnits; }
    if (kind === 'skin') { m.roughness = Math.max(0.45, orig.roughness * 0.85); }
    // брови и волосы модели — в цвет причёски героини (серая текстура × цвет)
    if (kind === 'hair' && hairColor !== null && hairColor !== undefined) m.color.set(hairColor).multiplyScalar(1.35);
    if (kind === 'iris') {
      m.roughness = 0.2;
      // светящаяся радужка (стихия героя): светится радужка (тёмная часть текстуры глаза), белок — нет
      const glow = !!(fx && fx.eyes);
      if (glow) { m.emissive = new THREE.Color(fx.eyes); m.emissiveIntensity = fx.eyesK || 1.6; }
      // [HERO] радужка вблизи: лимбальное кольцо, радиальные волокна, светлый венчик у зрачка; запечённый в
      // текстуру блик убран (глаз теперь поворачивается — блик «ездил» бы с ним; живой блик — ниже).
      // Текстура Quaternius: радужка — диск в центре (0.5, 0.5), радиус ≈ 0.105.
      // [W4-ЛИЦО] радужка крупнее (userData.heroIris у героинь: выборка внутри 1.1 R сжата, к 1.5 R — как была);
      // глубина глаза: тень верхнего века и уголков на яблоке (оси глаза — из patchGaze), каустика — свет
      // сверху собирается роговицей в нижней части радужки; искра — чёткое ядро, ореол и вторая точка снизу.
      const irisU = { heroIrisK: { value: Math.max(1, Math.min(1.25, (orig.userData && orig.userData.heroIris) || 1)) } };
      const hasMap = !!m.map;
      const prevI = m.onBeforeCompile;
      m.onBeforeCompile = (sh, r) => {
        if (prevI) prevI.call(m, sh, r);
        Object.assign(sh.uniforms, irisU);
        let fs = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float heroIrisK;');
        fs = fs.replace('#include <map_fragment>', hasMap ? `vec2 irUv = vMapUv;
  {
    vec2 d0 = vMapUv - vec2( 0.5 );
    float r0 = length( d0 ) / 0.105, a0 = 1.1 * heroIrisK;
    float r1 = r0 < a0 ? r0 / heroIrisK : ( r0 < 1.5 ? mix( 1.1, 1.5, ( r0 - a0 ) / max( 1.5 - a0, 1e-3 ) ) : r0 );
    irUv = vec2( 0.5 ) + d0 * ( r1 / max( r0, 1e-4 ) );
  }
  diffuseColor *= texture2D( map, irUv );
  vec3 heroEyeTex = diffuseColor.rgb;
  vec2 irD = ( irUv - vec2( 0.5 ) ) / 0.105;
  float irR = length( irD ), irA = atan( irD.y, irD.x );
  float heroIrM = 1.0 - smoothstep( 0.96, 1.06, irR );
  {
    float irL = dot( diffuseColor.rgb, vec3( 0.333 ) );
    // запечённый блик: яркие пиксели внутри радужки → цвет зрачка/радужки вокруг
    float irHi = smoothstep( 0.55, 0.8, irL ) * ( 1.0 - smoothstep( 0.55, 0.75, irR ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.12 + vec3( 0.02 ), irHi );
    // волокна и венчик
    float fib = 0.5 + 0.5 * sin( irA * 41.0 + sin( irA * 7.0 ) * 2.0 + irR * 5.0 ) * sin( irA * 23.0 - irR * 9.0 );
    float band = smoothstep( 0.3, 0.45, irR ) * ( 1.0 - smoothstep( 0.9, 1.0, irR ) );
    diffuseColor.rgb *= 1.0 + ( fib - 0.5 ) * 0.45 * band * heroIrM;
    diffuseColor.rgb *= 1.0 + 0.22 * smoothstep( 0.36, 0.5, irR ) * ( 1.0 - smoothstep( 0.5, 0.66, irR ) );
    // лимбальное кольцо — тёмный ободок по краю радужки
    diffuseColor.rgb *= 1.0 - 0.6 * smoothstep( 0.8, 0.97, irR ) * ( 1.0 - smoothstep( 1.0, 1.12, irR ) );
    // глубина: тень верхнего века и уголков, белок к уголкам теплее; каустика в нижней части радужки
    float lidSh = smoothstep( 0.0, 0.3, vHeroEyeL.y ) * 0.85;
    float cornerSh = smoothstep( 0.55, 0.95, abs( vHeroEyeL.x ) ) * ( 1.0 - heroIrM );
    diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.74, 0.68, 0.66 ), lidSh ) * mix( vec3( 1.0 ), vec3( 0.86, 0.76, 0.74 ), cornerSh );
    float caus = heroIrM * smoothstep( 0.02, -0.34, vHeroEyeP.y ) * smoothstep( 0.3, 0.62, irR );
    diffuseColor.rgb *= 1.0 + 0.75 * caus;
  }` : '#include <map_fragment>\n  vec3 heroEyeTex = diffuseColor.rgb;\n  float heroIrM = 1.0;');
        fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  ${glow ? 'totalEmissiveRadiance *= heroIrM * ( 1.0 - smoothstep( 0.3, 0.62, dot( heroEyeTex, vec3( 0.333 ) ) ) );' : ''}
  {
    // блик в глазах: отражение «студийного» источника сверху-слева (глаза — сферы, выходит точка)
    vec3 eyR = reflect( - normalize( vViewPosition ), normalize( normal ) );
    float d1 = dot( eyR, normalize( vec3( -0.35, 0.55, 0.76 ) ) ), d2 = dot( eyR, normalize( vec3( 0.42, -0.2, 0.88 ) ) );
    float eyC = smoothstep( 0.9955, 0.9982, d1 ) * 1.4 + pow( saturate( d1 ), 90.0 ) * 0.16 + smoothstep( 0.9986, 0.9994, d2 ) * 0.5;
    totalEmissiveRadiance += vec3( 1.25 ) * eyC;
  }`);
        sh.fragmentShader = fs;
      };
      const pkI = m.customProgramCacheKey;
      m.customProgramCacheKey = () => 'heroIris:' + (glow ? 'G' : '') + (hasMap ? 'M' : '') + ':' + (pkI ? pkI.call(m) : '');
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
    if (kind === 'skin' && q !== 'low' && m.map) patchMicro(THREE, m, { unit: armorUnit, mode: 'skin', lips: /^MI_Regular_Female/.test(orig.name) ? (orig.userData && orig.userData.heroLipGloss !== undefined ? orig.userData.heroLipGloss : true) : false });   // [W4-ЛИЦО] сила блеска губ
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
  const gazeU = { heroGazeRot: { value: new THREE.Matrix3() }, heroEyeCL: { value: new THREE.Vector3() }, heroEyeCR: { value: new THREE.Vector3() }, heroEyeLR: { value: new THREE.Vector3(1, 0, 0) }, heroEyeMid: { value: new THREE.Vector3() }, heroEyeR: { value: 0.0165 } };
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
      { const ext0 = box[0][1].clone().sub(box[0][0]); const rr = Math.max(ext0.x, ext0.y, ext0.z) / 2; if (rr > 1e-5) gazeU.heroEyeR.value = rr; }   // [W4-ЛИЦО] радиус яблока
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
      // [W4-ЛИЦО] vHeroEyeP — точка в осях яблока (радиусы, без поворота взгляда), vHeroEyeL — после поворота
      // (оси головы: y — вверх): по ним тень века, уголки и каустика радужки
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat3 heroGazeRot;\nuniform vec3 heroEyeCL;\nuniform vec3 heroEyeCR;\nuniform vec3 heroEyeLR;\nuniform vec3 heroEyeMid;\nuniform float heroEyeR;\nvarying vec3 vHeroEyeL;\nvarying vec3 vHeroEyeP;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  objectNormal = heroGazeRot * objectNormal;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    vec3 hgC = dot( position - heroEyeMid, heroEyeLR ) > 0.0 ? heroEyeCL : heroEyeCR;
    vHeroEyeP = ( position - hgC ) / heroEyeR;
    transformed = heroGazeRot * ( transformed - hgC ) + hgC;
    vHeroEyeL = ( transformed - hgC ) / heroEyeR;
  }`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vHeroEyeL;\nvarying vec3 vHeroEyeP;');
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
