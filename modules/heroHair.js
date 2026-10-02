// ASHEN OATH — [W4-ВОЛОСЫ] волосы героинь: объёмные мягкие причёски из карт прядей (hair cards).
//
// Причёска собирается один раз при одевании героя (heroGear.dressHero вызывает buildHair):
//   • «шапочка» — оболочка по настоящей форме черепа (радиус по направлениям из вершин кожи головы):
//     под прядями нет лысин, у линии роста волосы редеют (альфа вершин × альфа атласа);
//   • карты прядей в несколько слоёв: нижний — плотные пучки, верхний — пучки с просветами, на high ещё
//     выбившиеся волоски; ширина и плотность тают к кончикам, у корней — объём (сечение выгнуто наружу);
//   • косы (три переплетённые трубки), хвост с обмоткой — в той же геометрии и том же материале;
//   • длинные пряди «драпируются» при сборке: тяжесть + профиль тела по вершинам кожи (плечи, грудь,
//     спина), плащ и колчан — пряди ложатся на тело, а не проходят сквозь него.
// Атлас прядей — процедурный (canvas → DataTexture, кэш на весь сеанс): 4 столбца — плотные пряди,
// пучки, отдельные волоски, ровный срез («химэ»). Цвет корень → кончик и тон прядей — в цвете вершин.
//
// Движение — без физики на CPU: в кадре одна пружина на причёску (скорость и поворот головы, рывок,
// бег) и юниформы; изгиб прядей, ветер и выталкивание из капсул тела (корпус, плечи, руки, череп,
// колчан) — в вершинном шейдере. Пряди ниже затылка следуют за грудью (смесь двух костей), выше —
// за головой. «Уменьшенное движение» (settings.reducedMotion) — пружина и ветер втрое слабее.
//
// Свет волос — modules/heroShading.js (patchHairGloss): два блика Каджия-Кей (белый и цветной), мягкий
// терминатор и просвечивание на контровом свете — для настоящих источников и для света витрины.
//
// Качество (settings.quality → setQuality):
//   low    — MeshStandardMaterial, атлас 512², один проход с альфа-тестом (+alpha-to-coverage: на low
//            нет постобработки и холст с MSAA — края мягкие бесплатно), без выбившихся волосков: 1 вызов;
//   medium — MeshPhysicalMaterial, атлас 1024², ядро с альфа-тестом + проход мягкой кромки: 2 вызова;
//   high   — как medium + выбившиеся волоски: 2 вызова (+тень у обоих уровней выше low — 1 вызов).
// Карты прядей с альфа-тестом в проход нормалей GTAO не идут (userData.noAO): там они были бы квадратами.
//
// export: buildHair(THREE, ctx) → { names, capeGap, update(dt), setLod(l), setQuality(q), dispose(),
//   perf: { ms }, info() } | null;  hairHood(vrm, hairDef) → restore() | null — снять капюшон
//   ctx: { vrm, raw, bp, chestB, torsoR, bodyCaps, LEFT, UP, FWD, holder, quality, atmosphere, hair,
//          circlet, cape, quiver, stick, G, Mt, Std, mats, tube, gem }

import { patchHairGloss } from './heroShading.js';
import { config } from '../config.js';

// ---------------------------------------------------------------- стили
// color — база (×тон вершин), spec1/spec2 — цвета бликов (основной почти белый, вторичный — отлив),
// tt — просвечивание, len — длина от макушки (м, до масштаба героя), hood — капюшон оставить
const STYLES = {
  // эльфийка: длинные платиновые, прямой пробор, тонкие косы от висков назад (полу-распущенные), обруч
  elf: { spec1: [1.0, 0.97, 0.92], spec1K: 0.11, spec2: [1.0, 0.84, 0.58], spec2K: 0.07, tt: 0.4, kk: [140, 40, -0.08, 0.13], len: 0.9, motion: 1 },
  // чародейка: гладкие чёрные, ровная чёлка и боковые пряди «химэ», фиолетовый отлив
  hime: { spec1: [0.9, 0.88, 1.0], spec1K: 0.24, spec2: [0.5, 0.36, 1.0], spec2K: 0.09, tt: 0.2, kk: [320, 90, -0.06, 0.12], len: 0.8, motion: 0.8 },
  // лучница: каштановая высокая коса-хвост, выбившиеся пряди у лица
  ponytail: { spec1: [1.0, 0.95, 0.88], spec1K: 0.16, spec2: [1.0, 0.55, 0.3], spec2K: 0.1, tt: 0.5, kk: [260, 70, -0.08, 0.14], len: 0.42, motion: 1.15 },
};

// ---------------------------------------------------------------- атлас прядей (кэш)
// RGB — яркость волоска (серый, линейная), A — покрытие. Столбцы по u: 0 — плотные пряди, 1 — пучки
// с просветами, 2 — отдельные волоски, 3 — ровный срез на v ≈ 0.93. По v: 0 — корень, 1 — кончик (flipY
// выключен). Текстура — прямо с холста, в предумноженной альфе (пиксели с холста не читаются: это сотни мс
// на главном потоке): фильтрация и мип-уровни без тёмной каймы, шейдер делит цвет на альфу.
const atlasCanvas = {};   // N → готовый холст (рисунок переживает смену героя)
const atlasTex = {};      // N → { tex, refs }
const CUT_V = 0.93;     // где у столбца «ровный срез» кончаются пряди
// Рисование разбито на шаги (столбцы атласа, затем выборка пикселей): warmHairAtlas выполняет их в простое
// главного потока (requestIdleCallback), drawAtlas — дорисовывает оставшиеся сразу, если атлас нужен раньше.
const atlasJobs = {};   // N → { steps, i }
function atlasJob(N) {
  if (atlasJobs[N]) return atlasJobs[N];
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  if (!g) return null;   // холст недоступен (лимит памяти) — запасная клетка в acquireAtlas
  const k = N / 1024, C = N / 4;
  let sd = 20240611;
  const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  g.lineCap = 'round'; g.lineJoin = 'round';
  // яркость волоска — в линейном пространстве (текстура без sRGB: предумноженная альфа и sRGB плохо дружат)
  const lin = (l) => Math.round(Math.pow(Math.min(1, Math.max(0, l)), 2.2) * 255);
  // волосок: от (x0, y0) до (x1, y1) с плавным изгибом; тело — один путь, к кончику (последние tip доли)
  // тоньше и прозрачнее — три коротких штриха
  const hair = (x0, y0, x1, y1, w, l, a, sway, tip = 0.3) => {
    const n = 12, ph = rnd() * 6.28, fr = 0.5 + rnd() * 1.2, v = lin(l);
    const at = (t) => [x0 + (x1 - x0) * t + Math.sin(ph + t * fr * 3.1) * sway * Math.min(1, t * 2), y0 + (y1 - y0) * t];
    const tb = 1 - tip, nb = Math.max(1, Math.round(n * tb));
    g.strokeStyle = `rgba(${v},${v},${v},${a.toFixed(3)})`; g.lineWidth = Math.max(0.55, w);
    g.beginPath(); g.moveTo(x0, y0);
    for (let i = 1; i <= nb; i++) { const [x, y] = at((i / nb) * tb); g.lineTo(x, y); }
    g.stroke();
    let [px, py] = at(tb);
    for (let i = 1; i <= 3; i++) {
      const t = tb + (tip * i) / 3, f = Math.max(0.08, 1 - (i - 0.5) / 3);
      const [x, y] = at(t);
      g.strokeStyle = `rgba(${v},${v},${v},${(a * (0.25 + 0.75 * f)).toFixed(3)})`;
      g.lineWidth = Math.max(0.55, w * (0.3 + 0.7 * f));
      g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
      px = x; py = y;
    }
  };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const step = Math.max(1, Math.round(k));
  // плотная подложка: вертикальные полоски шириной в волосок, у краёв столбца — реже и прозрачнее,
  // низ каждой полоски — своя длина (рваный край) с градиентом
  const under = (c0, u0, u1, yEnd, lum, edge) => {
    for (let x = Math.round(u0 * C); x < Math.round(u1 * C); x += step) {
      const u = (x / C - u0) / (u1 - u0), e = sm(0, edge, u) * sm(1, 1 - edge, u);
      if (rnd() > 0.35 + 0.65 * e) continue;
      const a = (0.55 + 0.45 * e) * (0.75 + 0.25 * rnd()), y1 = yEnd(u) * N, vv = lin(lum * (0.88 + 0.24 * rnd()));
      const gr = g.createLinearGradient(0, 0, 0, y1);
      gr.addColorStop(0, `rgba(${vv},${vv},${vv},${a})`); gr.addColorStop(0.8, `rgba(${vv},${vv},${vv},${a})`); gr.addColorStop(1, `rgba(${vv},${vv},${vv},0)`);
      g.fillStyle = gr; g.fillRect(c0 + x, 0, step, y1);
    }
  };
  const steps = [
    // 0: плотные пряди (нижний слой, объём)
    () => {
      under(0, 0.04, 0.96, () => 0.66 + 0.24 * rnd(), 0.62, 0.3);
      for (let i = 0; i < 700; i++) {
        const u = 0.5 + (rnd() - 0.5) * (0.5 + 0.48 * rnd()), x0 = u * C, y1 = N * (0.6 + 0.39 * rnd());
        hair(x0, -2, x0 + (rnd() - 0.5) * 12 * k, y1, (0.8 + 1.1 * rnd()) * k, 0.55 + 0.4 * rnd(), 0.2 + 0.45 * rnd(), (rnd() - 0.5) * 9 * k, 0.35);
      }
    },
    // 1: пучки — 4 широких пучка, у корней сливаются, сужаются только к своим кончикам
    () => {
      const c0 = C;
      for (let p = 0; p < 4; p++) {
        const cx = C * (0.14 + 0.24 * p + (rnd() - 0.5) * 0.04), hw = C * (0.16 + 0.03 * rnd());
        const tipY = 0.74 + 0.24 * rnd(), body = tipY * (0.45 + 0.15 * rnd()), tipX = cx + (rnd() - 0.5) * C * 0.05, cl = 0.85 + 0.3 * rnd();
        const halfW = (y) => (y < body ? hw : hw * Math.pow(Math.max(0, 1 - (y - body) / (tipY - body)), 0.75));
        // сердцевина пучка
        for (let x = -hw; x < hw; x += step) {
          if (rnd() > 0.85) continue;
          const ux = x / hw;
          let yE = body;
          while (yE < tipY && Math.abs(x) < halfW(yE) * 0.8) yE += 0.004;
          const vv = lin(0.6 * cl * (0.85 + 0.25 * rnd())), a = 0.85 * (1 - 0.3 * ux * ux);
          const gr = g.createLinearGradient(0, 0, 0, yE * N);
          gr.addColorStop(0, `rgba(${vv},${vv},${vv},${a})`); gr.addColorStop(0.85, `rgba(${vv},${vv},${vv},${a})`); gr.addColorStop(1, `rgba(${vv},${vv},${vv},0)`);
          g.fillStyle = gr; g.fillRect(c0 + cx + x, 0, step, yE * N);
        }
        // волоски пучка: от корня (по всей ширине) к кончику пучка
        for (let i = 0; i < 150; i++) {
          const ux = (rnd() - 0.5) * 2, x0 = cx + ux * hw * 1.05;
          const len = tipY * (0.7 + 0.32 * rnd()), x1 = tipX + ux * halfW(len) + (rnd() - 0.5) * 3 * k;
          hair(c0 + x0, -2, c0 + x1, len * N, (0.8 + 1.0 * rnd()) * k, cl * (0.5 + 0.45 * rnd()), 0.35 + 0.45 * rnd(), (rnd() - 0.5) * 8 * k, 0.4);
        }
      }
      for (let i = 0; i < 30; i++) { const x0 = c0 + C * (0.05 + 0.9 * rnd()); hair(x0, -2, x0 + (rnd() - 0.5) * 24 * k, N * (0.4 + 0.55 * rnd()), (0.7 + 0.6 * rnd()) * k, 0.45 + 0.6 * rnd(), 0.5 + 0.4 * rnd(), 10 * k, 0.5); }
    },
    // 2: отдельные волоски и тонкие пучки по 3–6 (выбившиеся пряди)
    () => {
      for (let b = 0; b < 12; b++) {
        const x0 = 2 * C + C * (0.08 + 0.84 * rnd()), x1 = x0 + (rnd() - 0.5) * C * 0.3, len = N * (0.5 + 0.47 * rnd()), sw = (rnd() - 0.5) * 22 * k;
        const n = 3 + Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) hair(x0 + (rnd() - 0.5) * 5 * k, -2, x1 + (rnd() - 0.5) * 7 * k, len * (0.8 + 0.2 * rnd()), (0.9 + 1.3 * rnd()) * k, 0.4 + 0.65 * rnd(), 0.75 + 0.25 * rnd(), sw, 0.45);
      }
    },
    // 3: ровный срез на CUT_V (чёлка и боковые пряди «химэ»): почти прямая линия, разброс — в волосок
    () => {
      const c0 = 3 * C;
      under(c0, 0.03, 0.97, () => CUT_V - 0.004 * rnd(), 0.62, 0.18);
      for (let i = 0; i < 760; i++) {
        const u = 0.5 + (rnd() - 0.5) * 0.94, x0 = c0 + u * C;
        hair(x0, -2, x0 + (rnd() - 0.5) * 3 * k, (CUT_V + 0.006 * (rnd() - 0.5)) * N, (0.8 + 1.1 * rnd()) * k, 0.5 + 0.45 * rnd(), 0.3 + 0.45 * rnd(), (rnd() - 0.5) * 2.5 * k, 0.03);
      }
    },
    // готово: холст и есть атлас (без чтения пикселей)
    () => { atlasCanvas[N] = cv; },
  ];
  atlasJobs[N] = { steps, i: 0 };
  return atlasJobs[N];
}
function drawAtlas(N) {
  if (atlasCanvas[N]) return atlasCanvas[N];
  // рисуется сразу (оставшиеся шаги, если начат в простое): 512² — ~20 мс, 1024² — ~40 мс
  const job = atlasJob(N);
  if (!job) return null;
  while (job.i < job.steps.length) job.steps[job.i++]();
  delete atlasJobs[N];
  return atlasCanvas[N] || null;
}
// Атлас 1024² — заранее, по шагу в простое главного потока (модуль грузится вместе с оболочкой героя, ещё
// до одевания): первая героиня одевается без рисования холста. Без requestIdleCallback — ничего не делаем.
export function warmHairAtlas(N = 1024) {
  if (atlasCanvas[N] || typeof requestIdleCallback !== 'function') return;
  const job = atlasJob(N);
  if (!job) return;
  const tick = () => {
    if (atlasCanvas[N] || atlasJobs[N] !== job) return;   // уже дорисовал drawAtlas
    job.steps[job.i++]();
    if (job.i < job.steps.length) requestIdleCallback(tick, { timeout: 3000 });
    else delete atlasJobs[N];
  };
  requestIdleCallback(tick, { timeout: 3000 });
}
if (typeof window !== 'undefined' && typeof requestIdleCallback === 'function') requestIdleCallback(() => warmHairAtlas(1024), { timeout: 5000 });
// QA: рисунок атласа (RGBA, N×N, предумноженный) — для стенда и снимков (читает пиксели — только для QA)
export function hairAtlasData(N = 1024) { const cv = drawAtlas(N); return cv ? cv.getContext('2d').getImageData(0, 0, N, N).data : null; }
function acquireAtlas(THREE, N) {
  const e = atlasTex[N];
  if (e) { e.refs++; return e.tex; }
  const cv = drawAtlas(N);
  let tex;
  if (cv) {
    tex = new THREE.CanvasTexture(cv);
    tex.premultiplyAlpha = true;
    tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  } else {
    // без document (node-тесты) или холста: светлая непрозрачная клетка
    tex = new THREE.DataTexture(new Uint8Array([140, 140, 140, 255]), 1, 1, THREE.RGBAFormat);
  }
  tex.flipY = false; tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace; tex.anisotropy = 4; tex.name = 'hair-atlas-' + N;
  tex.needsUpdate = true;
  atlasTex[N] = { tex, refs: 1 };
  return tex;
}
function releaseAtlas(N) {
  const e = atlasTex[N];
  if (!e) return;
  if (--e.refs <= 0) { e.tex.dispose(); delete atlasTex[N]; }
}

// ---------------------------------------------------------------- вершинный шейдер: две кости + пружина
// Контракт с heroShading.patchHairGloss: varying vHairT (касательная волоса, оси камеры), vHairS
// (x — сдвиг блика пряди, y — доля длины 0 корень … 1 кончик).
const HAIR_CAPS = 6;
const VERT_COMMON = `
attribute vec4 hairW;
attribute vec3 hairT;
uniform mat4 hairHead;
uniform mat4 hairChest;
uniform vec3 hairLin;
uniform vec3 hairAng;
uniform vec3 hairPivot;
uniform vec4 hairWind;
uniform vec4 hairCapA[ ${HAIR_CAPS} ];
uniform vec4 hairCapB[ ${HAIR_CAPS} ];
#ifndef HAIR_DEPTH
varying vec3 vHairT;
varying vec2 vHairS;
#endif
vec3 hairBase( vec3 p ) {
  return mix( ( hairHead * vec4( p, 1.0 ) ).xyz, ( hairChest * vec4( p, 1.0 ) ).xyz, hairW.x );
}
vec3 hairMove( vec3 hB ) {
  float hF = hairW.y, hF2 = hF * hF;
  vec3 hD = hairLin * hF2 + cross( hairAng, hB - hairPivot ) * hF;
  float hPh = hairW.z * 6.2831853;
  float hG = sin( hairWind.w * 1.9 + hPh + hB.y * 5.0 ) * 0.55 + sin( hairWind.w * 3.3 + hPh * 1.7 ) * 0.3 + sin( hairWind.w * 0.63 + hPh * 0.4 ) * 0.15;
  hD += hairWind.xyz * ( 0.55 + 0.45 * hG ) * hF2;
  hD += vec3( - hairWind.z, 0.0, hairWind.x ) * hG * 0.45 * hF2;
  vec3 hP = hB + hD;
  for ( int i = 0; i < ${HAIR_CAPS}; i ++ ) {
    vec4 ca = hairCapA[ i ], cb = hairCapB[ i ];
    if ( cb.w <= 0.0 ) continue;
    vec3 ab = cb.xyz - ca.xyz;
    float ab2 = max( dot( ab, ab ), 1e-8 );
    vec3 c = ca.xyz + ab * clamp( dot( hP - ca.xyz, ab ) / ab2, 0.0, 1.0 );
    vec3 dv = hP - c;
    float d = length( dv ), rr = cb.w;
    // капсулы «покоя» (корпус, череп): смещение не уводит прядь глубже, чем она лежит без него
    if ( ca.w > 0.5 ) { vec3 c0 = ca.xyz + ab * clamp( dot( hB - ca.xyz, ab ) / ab2, 0.0, 1.0 ); rr = min( rr, length( hB - c0 ) ); }
    if ( d < rr && d > 1e-5 ) hP = c + dv * ( rr / d );
  }
  return hP;
}
`;
function patchMotion(mat, U, depth) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    Object.assign(sh.uniforms, U.motion);
    let vs = sh.vertexShader.replace('#include <common>', `#include <common>\n${depth ? '#define HAIR_DEPTH\n' : ''}${VERT_COMMON}`);
    if (!depth) {
      vs = vs.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
  objectNormal = normalize( mix( mat3( hairHead ) * objectNormal, mat3( hairChest ) * objectNormal, hairW.x ) );`);
    }
    vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
  transformed = hairMove( hairBase( position ) );${depth ? '' : `
  vHairT = normalize( ( modelViewMatrix * vec4( mix( mat3( hairHead ) * hairT, mat3( hairChest ) * hairT, hairW.x ), 0.0 ) ).xyz + 1e-6 );
  vHairS = vec2( hairW.w, clamp( hairW.y, 0.0, 1.0 ) );`}`);
    sh.vertexShader = vs;
  };
  const pk = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'hairMove' + (depth ? 'D' : '') + ':' + (pk ? pk.call(mat) : '');
}
// альфа прядей: мип-уровни не съедают покрытие (волосы вдали не редеют); мягкий проход — только кромка
function patchAlpha(mat, N, soft, cut) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
  #ifdef USE_MAP
  // атлас в предумноженной альфе: цвет волоска — без неё
  { float hA = max( sampledDiffuseColor.a, 0.004 ); diffuseColor.rgb /= hA; sampledDiffuseColor.rgb /= hA; }
  #endif`)
      .replace('#include <alphatest_fragment>', `
  #ifdef USE_MAP
  {
    vec2 hDu = dFdx( vMapUv ) * ${N.toFixed(1)}, hDv = dFdy( vMapUv ) * ${N.toFixed(1)};
    float hLod = max( 0.0, 0.5 * log2( max( dot( hDu, hDu ), dot( hDv, hDv ) ) ) );
    diffuseColor.a *= 1.0 + 0.24 * hLod;
  }
  #endif
  ${soft ? `if ( diffuseColor.a >= ${cut.toFixed(3)} || diffuseColor.a < 0.05 ) discard;
  diffuseColor.a = smoothstep( 0.05, ${cut.toFixed(3)}, diffuseColor.a );` : ''}
  #include <alphatest_fragment>`);
  };
  const pk = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => 'hairAlpha' + N + (soft ? 'S' : '') + ':' + (pk ? pk.call(mat) : '');
}

// ---------------------------------------------------------------- капюшон
// hair.hood === false — причёска открыта: меш капюшона модели прячется (до каймы капюшона в heroGear —
// кайма берёт только видимый капюшон). → функция «вернуть как было» (для dispose) или null
export function hairHood(vrm, HO) {
  if (!HO || HO.hood !== false) return null;
  const hidden = [];
  vrm.scene.traverse((o) => { if (o.isMesh && /Hood/i.test(o.name) && o.visible) { o.visible = false; hidden.push(o); } });
  return () => { for (const o of hidden) o.visible = true; hidden.length = 0; };
}

// ---------------------------------------------------------------- сборка
export function buildHair(THREE, ctx) {
  const { vrm, raw, bp, chestB, LEFT, UP, FWD, holder, atmosphere = null } = ctx;
  const HO = ctx.hair || {};
  const styleId = HO.style || (HO.fringe === 'straight' ? 'hime' : 'elf');
  const ST = STYLES[styleId] || STYLES.elf;
  const headBone = raw('head'), chestBone = raw(chestB) || raw('chest');
  if (!headBone || !chestBone || !bp.head) return null;
  const V3 = () => new THREE.Vector3();
  const names = [];
  const hoodOn = HO.hood !== false;
  vrm.scene.updateMatrixWorld(true);
  holder.updateWorldMatrix(true, false);

  // ---------------- череп: центр, эллипсоид и радиус кожи по направлениям
  const hv = V3(), rel = V3();
  const sk = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, minZ: 1e9, maxZ: -1e9, n: 0 };
  const headPts = [], hoodPts = [];
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.geometry.attributes.skinIndex) return;
    const isHood = /hood/i.test(o.name);
    if (!isHood && /hat|helm|armet|hair|eye|brow/i.test(o.name)) return;
    const bi = o.skeleton.bones.indexOf(headBone);
    if (bi < 0) return;
    const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight;
    for (let i = 0; i < SI.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (SI.getComponent(i, k) === bi) w += SW.getComponent(i, k);
      if (w < (isHood ? 0.3 : 0.2)) continue;   // затылок и за ушами кожа делит вес с шеей
      o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld);
      if (isHood) { hoodPts.push(hv.clone()); continue; }
      headPts.push(hv.clone());
      if (w < 0.55) continue;
      rel.copy(hv).sub(bp.head);
      const x = rel.dot(LEFT), y = rel.dot(UP), z = rel.dot(FWD);
      sk.minX = Math.min(sk.minX, x); sk.maxX = Math.max(sk.maxX, x); sk.minY = Math.min(sk.minY, y); sk.maxY = Math.max(sk.maxY, y);
      sk.minZ = Math.min(sk.minZ, z); sk.maxZ = Math.max(sk.maxZ, z); sk.n++;
    }
  });
  if (sk.n < 50) Object.assign(sk, { minX: -0.075, maxX: 0.075, minY: -0.02, maxY: 0.21, minZ: -0.1, maxZ: 0.1 });
  const hH = sk.maxY - sk.minY;
  const cy = sk.minY + hH * 0.62, ry = (sk.maxY - cy) * 1.0;
  const cz = (sk.minZ + sk.maxZ) * 0.5 - 0.004, rz = (sk.maxZ - sk.minZ) * 0.5;
  const cx = (sk.minX + sk.maxX) * 0.5, rx = (sk.maxX - sk.minX) * 0.5;
  const O = bp.head.clone().addScaledVector(LEFT, cx).addScaledVector(UP, cy).addScaledVector(FWD, cz);
  // нижняя половина (затылок, за ушами): снаружи может быть шея меша тела — её вершины тоже «кожа»
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh || !o.visible || /hood|hat|helm|armet|hair|eye|brow/i.test(o.name)) return;
    const pa = o.geometry.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld);
      rel.copy(hv).sub(O); const r = rel.length();
      if (r > 0.17 || r < 1e-4 || rel.dot(UP) / r > Math.cos(1.45)) continue;
      headPts.push(hv.clone());
    }
  });
  const browY = sk.minY + hH * 0.58;                    // высота бровей (оси головы)
  // направление по сферическим углам: az 0 — затылок, +π/2 — левый висок, π — лоб; pol 0 — макушка
  const dirOf = (az, pol, out = V3()) => out.set(0, 0, 0).addScaledVector(LEFT, Math.sin(az) * Math.sin(pol)).addScaledVector(UP, Math.cos(pol)).addScaledVector(FWD, -Math.cos(az) * Math.sin(pol));
  const angOf = (d) => { const x = d.dot(LEFT), y = d.dot(UP), z = d.dot(FWD); return { az: Math.atan2(x, -z), pol: Math.acos(Math.max(-1, Math.min(1, y))) }; };
  const ellR = (d) => { const x = d.dot(LEFT) / rx, y = d.dot(UP) / ry, z = d.dot(FWD) / rz; return 1 / Math.sqrt(x * x + y * y + z * z); };
  // радиус кожи головы по корзинам направлений (36 × 18), пустые — по эллипсоиду, сглаживание
  const AZN = 36, PON = 18;
  const binsOf = (pts, pick) => {
    const B = new Float32Array(AZN * PON).fill(NaN), d = V3();
    for (const p of pts) {
      d.copy(p).sub(O); const r = d.length(); if (r < 1e-4) continue; d.divideScalar(r);
      const a = angOf(d);
      const ia = ((Math.floor(((a.az + Math.PI) / (Math.PI * 2)) * AZN) % AZN) + AZN) % AZN, ip = Math.min(PON - 1, Math.floor((a.pol / Math.PI) * PON));
      const k = ip * AZN + ia;
      B[k] = Number.isNaN(B[k]) ? r : pick(B[k], r);
    }
    return B;
  };
  const skinB = binsOf(headPts, Math.max);
  {
    const d = V3();
    for (let ip = 0; ip < PON; ip++) for (let ia = 0; ia < AZN; ia++) {
      const k = ip * AZN + ia, e = ellR(dirOf(((ia + 0.5) / AZN) * Math.PI * 2 - Math.PI, ((ip + 0.5) / PON) * Math.PI, d));
      skinB[k] = Number.isNaN(skinB[k]) ? e : Math.min(e * 1.6, Math.max(e * 0.8, skinB[k]));
    }
    const rawB = skinB.slice();
    for (let pass = 0; pass < 2; pass++) {
      const src = skinB.slice();
      for (let ip = 0; ip < PON; ip++) for (let ia = 0; ia < AZN; ia++) {
        let s = 0, w = 0;
        for (let dp = -1; dp <= 1; dp++) for (let da = -1; da <= 1; da++) {
          const p2 = ip + dp; if (p2 < 0 || p2 >= PON) continue;
          const ww = dp === 0 && da === 0 ? 2 : 1; s += src[p2 * AZN + ((ia + da + AZN) % AZN)] * ww; w += ww;
        }
        skinB[ip * AZN + ia] = s / w;
      }
    }
    // сглаживание не должно утопить оболочку в коже на выпуклостях (висок, затылок): не ниже сырого максимума
    // корзины и её соседей по азимуту
    for (let ip = 0; ip < PON; ip++) for (let ia = 0; ia < AZN; ia++) {
      const k = ip * AZN + ia;
      skinB[k] = Math.max(skinB[k], rawB[k], 0.5 * (rawB[ip * AZN + ((ia + 1) % AZN)] + rawB[ip * AZN + ((ia + AZN - 1) % AZN)]));
    }
  }
  const hoodB = hoodOn && hoodPts.length > 50 ? binsOf(hoodPts, Math.min) : null;
  const sampleB = (B, d) => {
    const a = angOf(d);
    const fa = ((a.az + Math.PI) / (Math.PI * 2)) * AZN - 0.5, fp = Math.min(PON - 1.001, Math.max(0, (a.pol / Math.PI) * PON - 0.5));
    const a0 = Math.floor(fa), p0 = Math.floor(fp), ta = fa - a0, tp = fp - p0;
    const g = (ia, ip) => B[Math.min(PON - 1, ip) * AZN + (((ia % AZN) + AZN) % AZN)];
    const v00 = g(a0, p0), v10 = g(a0 + 1, p0), v01 = g(a0, p0 + 1), v11 = g(a0 + 1, p0 + 1);
    if ([v00, v10, v01, v11].some((x) => Number.isNaN(x))) return NaN;
    return (v00 * (1 - ta) + v10 * ta) * (1 - tp) + (v01 * (1 - ta) + v11 * ta) * tp;
  };
  const skinR = (d) => sampleB(skinB, d);
  // точка поверх кожи головы на высоте lift; под капюшоном — не выше его внутренней поверхности
  const onScalp = (d, lift, out = V3()) => {
    let h = skinR(d) + lift;
    if (hoodB) { const hr = sampleB(hoodB, d); if (Number.isFinite(hr) && hr > skinR(d)) h = Math.min(h, Math.max(skinR(d) + 0.0015, hr - 0.0045)); }
    return out.copy(O).addScaledVector(d, h);
  };
  const S = (az, pol, lift = 0, out = V3()) => onScalp(dirOf(az, pol), lift, out);
  const polY = (yHead) => Math.acos(Math.max(-0.97, Math.min(0.97, (yHead - cy) / ry)));   // полярный угол высоты (оси головы)
  const polFront = polY(browY + 0.058);                 // линия роста надо лбом
  // линия роста: |az| 0 — затылок … π — лоб (кусочно-линейно); уши — открыты
  const HL = [[0, 2.45], [0.55, 2.36], [1.0, 2.14], [1.25, 1.62], [1.45, 1.42], [1.75, 1.42], [1.95, 1.66], [2.08, 1.66], [2.28, 1.28], [2.62, polFront + 0.06], [Math.PI, polFront]];
  const hairPol = (az) => {
    const a = Math.abs(Math.atan2(Math.sin(az), Math.cos(az)));
    for (let i = 1; i < HL.length; i++) if (a <= HL[i][0]) { const t = (a - HL[i - 1][0]) / (HL[i][0] - HL[i - 1][0]); return HL[i - 1][1] + (HL[i][1] - HL[i - 1][1]) * t; }
    return polFront;
  };

  // ---------------- профиль тела: радиус кожи вокруг оси позвоночника по высоте и азимуту
  const spinePts = ['hips', 'spine', 'chest', 'upperChest', 'neck'].map((n) => bp[n]).filter(Boolean).sort((a, b) => a.y - b.y);
  const axisAt = (y, out = V3()) => {
    if (y <= spinePts[0].y) return out.copy(spinePts[0]).setY(y);
    for (let i = 1; i < spinePts.length; i++) if (y <= spinePts[i].y) { const a = spinePts[i - 1], b = spinePts[i], t = (y - a.y) / Math.max(1e-6, b.y - a.y); return out.copy(a).lerp(b, t).setY(y); }
    return out.copy(spinePts[spinePts.length - 1]).setY(y);
  };
  const Y0 = bp.hips.y - 0.35, Y1 = (bp.neck || bp.head).y + 0.06, YS = 0.02, YN = Math.max(2, Math.ceil((Y1 - Y0) / YS)), SN = 32;
  const prof = new Float32Array(YN * SN);
  {
    const ax = V3();
    vrm.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.visible || /hood|hair|eye|brow/i.test(o.name)) return;
      const bi = o.skeleton.bones.indexOf(headBone);
      const SI = o.geometry.attributes.skinIndex, SW = o.geometry.attributes.skinWeight, pa = o.geometry.attributes.position;
      for (let i = 0; i < pa.count; i++) {
        if (bi >= 0 && SI) { let w = 0; for (let k = 0; k < 4; k++) if (SI.getComponent(i, k) === bi) w += SW.getComponent(i, k); if (w > 0.5) continue; }
        o.getVertexPosition(i, hv); hv.applyMatrix4(o.matrixWorld);
        if (hv.y < Y0 || hv.y >= Y1) continue;
        axisAt(hv.y, ax); rel.copy(hv).sub(ax);
        const x = rel.dot(LEFT), z = rel.dot(FWD), r = Math.hypot(x, z);
        if (r > 0.45) continue;
        const iy = Math.floor((hv.y - Y0) / YS), is = Math.floor(((Math.atan2(x, z) + Math.PI) / (Math.PI * 2)) * SN) % SN;
        const k = iy * SN + is; if (r > prof[k]) prof[k] = r;
      }
    });
    // пустые корзины — от соседей по азимуту и высоте
    for (let pass = 0; pass < 3; pass++) for (let iy = 0; iy < YN; iy++) for (let is = 0; is < SN; is++) {
      const k = iy * SN + is; if (prof[k] > 0) continue;
      let s = 0, n = 0;
      for (const [dy, ds] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const y2 = iy + dy; if (y2 < 0 || y2 >= YN) continue; const v = prof[y2 * SN + ((is + ds + SN) % SN)]; if (v > 0) { s += v; n++; } }
      if (n) prof[k] = (s / n) * 0.98;
    }
  }
  const bodyR = (p) => {
    const fy = (p.y - Y0) / YS - 0.5; if (fy < 0 || fy > YN - 1) return 0;
    axisAt(p.y, hv); rel.copy(p).sub(hv);
    const x = rel.dot(LEFT), z = rel.dot(FWD);
    const fs = ((Math.atan2(x, z) + Math.PI) / (Math.PI * 2)) * SN - 0.5;
    const y0 = Math.floor(fy), s0 = Math.floor(fs), ty = fy - y0, ts = fs - s0;
    const g = (iy, is) => prof[Math.min(YN - 1, iy) * SN + (((is % SN) + SN) % SN)];
    return (g(y0, s0) * (1 - ts) + g(y0, s0 + 1) * ts) * (1 - ty) + (g(y0 + 1, s0) * (1 - ts) + g(y0 + 1, s0 + 1) * ts) * ty;
  };
  // плащ (эльфийка): волосы лежат поверх — толщина плаща за спиной (как его исходная форма в heroGear)
  const CP = ctx.cape || null;
  const capeOff = (p) => {
    if (!CP) return 0;
    const t = (CP.yTop - p.y) / CP.len; if (t < -0.05 || t > 1.05) return 0;
    axisAt(p.y, hv); rel.copy(p).sub(hv);
    const x = rel.dot(LEFT), z = rel.dot(FWD);
    if (z > 0) return 0;
    const hw = CP.halfTop + (CP.w * 0.5 - CP.halfTop) * Math.sqrt(Math.max(0, t));
    const lat = Math.abs(x) / Math.max(0.05, hw);
    return lat > 1.15 ? 0 : (0.045 + 0.07 * Math.max(0, t)) * (lat < 0.85 ? 1 : (1.15 - lat) / 0.3);
  };
  // дополнительные капсулы сборки: ключицы, воротник плаща, колчан за спиной (мир)
  const extraCaps = [];
  if (bp.leftUpperArm && bp.rightUpperArm) extraCaps.push({ a: bp.leftUpperArm.clone().addScaledVector(UP, 0.035), b: bp.rightUpperArm.clone().addScaledVector(UP, 0.035), r: 0.055 });
  if (CP && CP.collar) for (let i = 1; i < CP.collar.length; i++) extraCaps.push({ a: CP.collar[i - 1], b: CP.collar[i], r: 0.03 });
  if (ctx.quiver) extraCaps.push({ a: ctx.quiver.a, b: ctx.quiver.b, r: ctx.quiver.r });
  const capPush = (p, a, b, r) => {
    const ab = rel.copy(b).sub(a), t = Math.max(0, Math.min(1, hv.copy(p).sub(a).dot(ab) / Math.max(1e-8, ab.lengthSq())));
    const c = hv.copy(a).addScaledVector(ab, t), d = p.distanceTo(c);
    if (d < r && d > 1e-6) p.sub(c).multiplyScalar(r / d).add(c);
  };
  const neckTopY = bp.neck ? bp.neck.y + 0.02 : O.y - ry * 0.8;
  // столкновения точки пряди при драпировке: череп, тело (+плащ), доп. капсулы; m — зазор слоя
  const dd = V3();
  const collide = (p, m) => {
    dd.copy(p).sub(O);
    const dl = dd.length();
    if (dl < 0.3 && dl > 1e-6) {
      dd.divideScalar(dl);
      const a = angOf(dd);
      if (a.pol < 2.45) { const rs = skinR(dd) + m; if (dl < rs) p.copy(O).addScaledVector(dd, rs); }
    }
    const rb = bodyR(p);
    if (rb > 0) {
      const rr = rb + m + capeOff(p);
      axisAt(p.y, dd); const hx = p.x - dd.x, hz = p.z - dd.z, r = Math.hypot(hx, hz);
      if (r < rr && r > 1e-6) { p.x = dd.x + (hx / r) * rr; p.z = dd.z + (hz / r) * rr; }
    }
    for (const c of extraCaps) capPush(p, c.a, c.b, c.r + m);
  };
  // драпировка цепочки: тяжесть, «тянуть» (pull — к груди или к спине), длины звеньев, столкновения
  const drape = (pts, pin, m, pull = null, iters = 70, stiff = 0.12) => {
    const n = pts.length, L = [0];
    for (let i = 1; i < n; i++) L.push(pts[i].distanceTo(pts[i - 1]));
    const d = V3();
    for (let it = 0; it < iters; it++) {
      for (let i = pin; i < n; i++) { pts[i].y -= 0.006; if (pull) pts[i].addScaledVector(pull, 0.004 * (i / (n - 1))); }
      for (let i = Math.max(1, pin); i < n; i++) { d.copy(pts[i]).sub(pts[i - 1]); const l = d.length() || 1; pts[i].copy(pts[i - 1]).addScaledVector(d, L[i] / l); }
      for (let i = pin; i < n; i++) collide(pts[i], m);
      if (stiff > 0) for (let i = Math.max(1, pin); i < n - 1; i++) { d.copy(pts[i - 1]).add(pts[i + 1]).multiplyScalar(0.5); pts[i].lerp(d, stiff); }
    }
    for (let i = Math.max(1, pin); i < n; i++) { d.copy(pts[i]).sub(pts[i - 1]); const l = d.length() || 1; pts[i].copy(pts[i - 1]).addScaledVector(d, L[i] / l); collide(pts[i], m); }
    return pts;
  };
  // путь по коже головы от p0 к цели (касательно), шаг step; lift — высота слоя
  const walk = (p0, target, step, lift, maxN = 60, stopFn = null) => {
    const pts = [p0.clone()], p = p0.clone(), D = V3(), n = V3();
    for (let i = 0; i < maxN; i++) {
      n.copy(p).sub(O).normalize();
      D.copy(target).sub(p); const dist = D.length(); if (dist < step * 0.6) break;
      D.addScaledVector(n, -D.dot(n)).normalize();
      p.addScaledVector(D, Math.min(step, dist));
      onScalp(n.copy(p).sub(O).normalize(), lift, p);
      pts.push(p.clone());
      if (stopFn && stopFn(p)) break;
    }
    return pts;
  };
  // продолжить цепочку вниз (свободная часть) длиной len шагом step с начальным направлением dir
  const extend = (pts, len, step, dir) => {
    const d = (dir || V3().copy(pts[pts.length - 1]).sub(pts[pts.length - 2] || O)).clone().normalize();
    let p = pts[pts.length - 1].clone();
    for (let s = step; s <= len + 1e-6; s += step) { d.lerp(UP.clone().negate(), 0.25).normalize(); p = p.clone().addScaledVector(d, step); pts.push(p); }
    return pts;
  };
  const arcLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += pts[i].distanceTo(pts[i - 1]); return s; };

  // ---------------- построитель геометрии
  const pos = [], nrm = [], uv = [], col = [], hw = [], ht = [], idx = [];
  const detailFrom = { at: -1 };   // индекс, с которого идут детали только для medium/high
  const napeY = O.y - ry * 0.55, shoulderY = bp.leftUpperArm ? Math.max(bp.leftUpperArm.y, bp.rightUpperArm ? bp.rightUpperArm.y : 0) + 0.02 : O.y - 0.3;
  const chestW = (p) => { const t = Math.max(0, Math.min(1, (napeY - p.y) / Math.max(0.05, napeY - shoulderY))); return t * t * (3 - 2 * t); };
  const out = (p, o = V3()) => {
    // наружу: у головы — от центра черепа, ниже — от оси тела по горизонтали
    const hd = o.copy(p).sub(O).normalize();
    if (p.y > neckTopY) return hd;
    axisAt(p.y, dd); const bx = p.x - dd.x, bz = p.z - dd.z, l = Math.hypot(bx, bz) || 1;
    const t = Math.max(0, Math.min(1, (neckTopY - p.y) / 0.08));
    return o.set(hd.x * (1 - t) + (bx / l) * t, hd.y * (1 - t), hd.z * (1 - t) + (bz / l) * t).normalize();
  };
  let sd = 9;
  const rr = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const vtx = (p, n, u, v, c, a, w, t) => {
    pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); uv.push(u, v); col.push(c[0], c[1], c[2], a); hw.push(w[0], w[1], w[2], w[3]); ht.push(t.x, t.y, t.z);
    return pos.length / 3 - 1;
  };
  // карта пряди вдоль направляющей pts (корень → кончик)
  const card = (pts, o) => {
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const L = curve.getLength();
    const rows = o.rows || Math.max(4, Math.min(18, Math.round(L / 0.03)));
    const cols = o.cols || 3, tile = o.tile || 0, ua = o.u0 ?? 0.04, ub = o.u1 ?? 0.96, va = o.v0 ?? 0, vb = o.v1 ?? 1;
    const tone = o.tone ?? 1, phase = rr(), shift = (rr() - 0.5) * 0.05;
    const base = pos.length / 3;
    const c = V3(), T = V3(), Ov = V3(), W = V3(), p = V3(), n = V3(), Wp = V3(), Wi = V3();
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      curve.getPointAt(t, c); curve.getTangentAt(t, T);
      if (o.rev) T.negate();
      // рамка карты: «наружу» от головы/тела, но без переворотов на изгибах — ширина переносится вдоль
      // пряди от предыдущего ряда и лишь подтягивается к идеальной
      out(c, Ov); Ov.addScaledVector(T, -Ov.dot(T));
      Wi.crossVectors(T, Ov);
      const wl = Wi.length();
      if (j === 0) { W.copy(wl > 1e-6 ? Wi.divideScalar(wl) : Wi.set(1, 0, 0).cross(T).normalize()); }
      else {
        W.copy(Wp).addScaledVector(T, -Wp.dot(T)).normalize();
        if (wl > 0.2) { Wi.divideScalar(wl); if (Wi.dot(W) < 0) Wi.negate(); W.lerp(Wi, 0.3).normalize(); }
      }
      Wp.copy(W);
      Ov.crossVectors(W, T).normalize();
      if (o.twist) { const a = o.twist * (t - 0.5); const ca = Math.cos(a), sa = Math.sin(a); const w2 = W.clone().multiplyScalar(ca).addScaledVector(Ov, sa); Ov.multiplyScalar(ca).addScaledVector(W, -sa); W.copy(w2); }
      const tw = o.rev ? 1 - t : t;   // доля длины от корня (rev — корень у кончика направляющей)
      const width = (o.w0 + (o.w1 - o.w0) * tw) * (o.taper === false ? 1 : 1 - 0.55 * Math.pow(Math.max(0, (tw - 0.7) / 0.3), 1.5));
      const s0 = (o.flex0 || 0) + (o.rev ? (1 - t) : t) * L;
      const fl = Math.min(1, Math.max(0, (s0 - (o.flexStart ?? 0.04)) / (o.flexLen ?? 0.45))) * (o.flexK ?? 1);
      const rd = o.rootDark ?? 0.62;
      // мягкая волна вдоль пряди (живые волосы, а не линейка): амплитуда растёт от корня
      const wv = (o.wave ?? 0.004) * Math.min(1, tw * 3) * Math.sin(phase * 6.283 + tw * L / 0.21 * 6.283);
      const shade = tone * (rd + (1 - rd) * Math.min(1, tw * 2.2)) * (0.96 + 0.08 * Math.min(1, tw * 1.3));
      const alpha = (o.alpha ? o.alpha(tw) : 1);
      for (let i = 0; i < cols; i++) {
        const s = i / (cols - 1) - 0.5;
        p.copy(c).addScaledVector(W, s * width + wv).addScaledVector(Ov, (o.bulge ?? 0.3) * width * (0.25 - s * s));
        n.copy(Ov).addScaledVector(W, s * (o.fan ?? 0.35)).normalize();
        // по длине: плотная часть атласа (v < 0.5) — до vTip длины, дальше кончики
        const tl = o.rev ? 1 - t : t, vt = o.vTip ?? 0.7, tv = o.vLin ? tl : (tl < vt ? 0.5 * tl / vt : 0.5 + 0.5 * (tl - vt) / (1 - vt));
        const u = (tile + ua + (ub - ua) * (s + 0.5)) * 0.25, v = va + (vb - va) * tv;
        const cw = o.chest !== undefined ? (typeof o.chest === 'function' ? o.chest(p, tw) : o.chest) : chestW(p);
        vtx(p, n, u, v, [shade, shade, shade], alpha, [cw, fl, phase, shift], T);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 1; i++) {
      const a = base + j * cols + i, b = a + cols;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  };
  // трубка (косы, обмотка хвоста): круглое сечение, текстура — середина плотного столбца
  const _on = V3();
  const tubeG = (pts, rad, sides, o = {}) => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const L = curve.getLength(), rows = o.rows || Math.max(6, Math.round(L / 0.006));
    const fr = curve.computeFrenetFrames(rows, false);
    const base = pos.length / 3, c = V3(), p = V3(), n = V3(), T = V3();
    const tone = o.tone ?? 1, phase = rr();
    for (let j = 0; j <= rows; j++) {
      const t = j / rows; curve.getPointAt(t, c); curve.getTangentAt(t, T);
      const r = rad(t), N0 = fr.normals[j], B0 = fr.binormals[j];
      const fl = Math.min(1, Math.max(0, ((o.flex0 || 0) + t * L - (o.flexStart ?? 0.04)) / (o.flexLen ?? 0.45))) * (o.flexK ?? 1);
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        n.copy(N0).multiplyScalar(Math.cos(a)).addScaledVector(B0, Math.sin(a));
        p.copy(c).addScaledVector(n, r);
        // нормаль: наполовину «наружу» от головы и тела — тонкая коса светится вместе с причёской
        n.add(out(c, _on)).normalize();
        const sh = (o.color ? 1 : tone * (0.8 + 0.2 * Math.max(0, n.dot(UP) + 0.5)));
        const cc = o.color || [sh, sh, sh];
        const cw = o.chest !== undefined ? (typeof o.chest === 'function' ? o.chest(p, t) : o.chest) : chestW(p);
        vtx(p, n, (0.3 + 0.4 * (i / sides)) * 0.25, (o.v0 ?? 0.08) + ((o.v1 ?? 0.7) - (o.v0 ?? 0.08)) * t, cc, 1, [cw, fl, phase, 0], T);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < sides; i++) {
      const a = base + j * (sides + 1) + i, b = a + sides + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };
  // коса из трёх прядей вдоль оси pts (radius — толщина пряди по доле длины, width — размах плетения)
  const braid = (pts, radius, width, period, o = {}) => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const L = curve.getLength(), n = Math.max(12, Math.round(L / (o.step || 0.0065)));
    const fr = curve.computeFrenetFrames(n, false), c = V3(), T = V3();
    // плоскость плетения: «наружу» от головы/тела
    for (let k = 0; k < 3; k++) {
      const lobe = [];
      for (let j = 0; j <= n; j++) {
        const t = j / n; curve.getPointAt(t, c); curve.getTangentAt(t, T);
        const Ov = out(c, V3()); Ov.addScaledVector(T, -Ov.dot(T)).normalize();
        const W = V3().crossVectors(T, Ov).normalize();
        const ph = (t * L / period) * Math.PI * 2 + (k * Math.PI * 2) / 3, w = width(t);
        lobe.push(c.clone().addScaledVector(W, Math.sin(ph) * w).addScaledVector(Ov, Math.sin(ph * 2) * w * 0.32 + w * 0.15));
      }
      if (o.ribbon) {
        // тонкая коса: пряди-ленты в плоскости плетения (втрое дешевле трубок, рисунок тот же)
        card(lobe, { ...o, tile: 0, cols: 2, rows: n, w0: radius(0) * 2.2, w1: radius(1) * 2.2, u0: 0.3, u1: 0.7, vLin: true, v0: 0.06, v1: 0.45, bulge: 0, wave: 0, taper: false, tone: (o.tone ?? 1) * (0.92 + 0.08 * k) });
      } else tubeG(lobe, (t) => radius(t) * (0.92 + 0.08 * Math.cos((t * L / period) * Math.PI * 4 + k)), o.sides || 5, { ...o, rows: n, tone: (o.tone ?? 1) * (0.94 + 0.06 * k) });
    }
  };
  // «шапочка»: оболочка вокруг полюса до линии роста; пряди — от полюса наружу (по v), к линии роста
  // кончики редеют (атлас + альфа вершин)
  const shell = (pole, lift, NT, ND, o = {}) => {
    const P = pole.clone().normalize(), E1 = V3().crossVectors(P, Math.abs(P.dot(UP)) > 0.9 ? FWD : UP).normalize(), E2 = V3().crossVectors(P, E1);
    const dirAt = (th, de, outv = V3()) => outv.copy(P).multiplyScalar(Math.cos(de)).addScaledVector(E1, Math.sin(de) * Math.cos(th)).addScaledVector(E2, Math.sin(de) * Math.sin(th));
    const inside = (d) => { const a = angOf(d); return a.pol < hairPol(a.az); };
    const dmax = [];
    for (let i = 0; i <= NT; i++) {
      const th = (i / NT) * Math.PI * 2; let lo = 0.05, hi = 2.6; const d = V3();
      if (!inside(dirAt(th, lo, d))) { dmax.push(lo); continue; }
      for (let it = 0; it < 22; it++) { const mid = (lo + hi) / 2; if (inside(dirAt(th, mid, d))) lo = mid; else hi = mid; }
      dmax.push(lo + (o.over ?? 0.06));
    }
    const base = pos.length / 3, d = V3(), p = V3(), T = V3();
    for (let i = 0; i <= NT; i++) {
      const th = (i / NT) * Math.PI * 2, tri = Math.abs(((i / NT) * (o.rep ?? 7)) % 2 - 1);
      for (let j = 0; j <= ND; j++) {
        const f = j / ND, de = dmax[i] * f;
        dirAt(th, de, d); onScalp(d, lift, p);
        // касательная — от полюса (направление пряди)
        T.copy(P).multiplyScalar(-Math.sin(de)).addScaledVector(E1, Math.cos(de) * Math.cos(th)).addScaledVector(E2, Math.cos(de) * Math.sin(th)).normalize();
        const sh = (o.tone ?? 0.62) * (0.85 + 0.15 * f);
        const a = f < 0.9 ? 1 : 1 - (f - 0.9) / 0.1 * (o.edge ?? 0.5);
        // плотная подложка атласа — до v ≈ 0.5, дальше кончики: у линии роста — только последние 10 %
        const vv = f < 0.9 ? 0.04 + 0.42 * (f / 0.9) : 0.46 + 0.4 * ((f - 0.9) / 0.1);
        vtx(p, d, (0.3 + 0.4 * tri) * 0.25, vv, [sh, sh, sh], a, [chestW(p), 0, rr(), 0], T);
      }
    }
    for (let i = 0; i < NT; i++) for (let j = 0; j < ND; j++) {
      const a = base + i * (ND + 1) + j, b = a + ND + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };

  // ---------------- причёски
  const lenK = (HO.len || 0.9) / 0.9;
  // корни карт проявляются плавно: нет видимого «среза» там, где карта начинается
  const rootFade = (t) => Math.min(1, 0.25 + t / 0.07);
  const hiDetail = () => { if (detailFrom.at < 0) detailFrom.at = idx.length; };
  if (styleId === 'elf') buildElf(); else if (styleId === 'hime') buildHime(); else buildPonytail();

  function buildElf() {
    shell(dirOf(0, 0.3), 0.0025, 40, 10, { tone: 0.55 });
    const L = (ST.len) * lenK;
    const back = FWD.clone().multiplyScalar(-1);
    // прямой пробор спереди: от линии роста надо лбом до макушки; пряди — в стороны и назад за уши
    for (const layer of [0, 1]) {
      const NP = layer ? 7 : 6;
      for (const s of [1, -1]) for (let k = 0; k < NP; k++) {
        const u = (k + (layer ? 0.5 : 0.15)) / NP, pol = polFront * (1 - u) + 0.12;
        const lift = 0.0045 + layer * 0.0045;
        const root = S(Math.PI, pol, lift - 0.002).addScaledVector(LEFT, s * (0.005 + 0.003 * layer));
        const pts = walk(root, S(s * (0.75 + 0.3 * (1 - u)), 1.32, lift), 0.018, lift, 30);
        const nW = pts.length;   // путь по коже — прибит, дальше свободно
        extend(pts, Math.max(0.12, L * (0.82 + 0.16 * rr()) - arcLen(pts)), 0.025, null);
        // тянуть назад и к середине спины: пряди ложатся за плечи, а не «крыльями» на руки
        drape(pts, nW, 0.006 + layer * 0.007, V3().copy(back).addScaledVector(LEFT, -s * 0.6), 110, 0.35);
        card(pts, { tile: layer ? 1 : 0, w0: 0.03, w1: layer ? 0.05 : 0.06, tone: (layer ? 1 : 0.86) * (0.97 + 0.06 * rr()), flexLen: 0.5, bulge: 0.2, alpha: rootFade });
      }
    }
    // с макушки — веером вниз по затылку и за ушами (закрывает корни нижнего слоя)
    for (const layer of [0, 1]) {
      const NC = layer ? 11 : 10;
      for (let k = 0; k < NC; k++) {
        const az = (k / (NC - 1) - 0.5) * 2.7 + (layer ? 0.1 : 0), lift = 0.004 + layer * 0.0045;
        const root = S(az * 0.25, 0.2 + 0.05 * rr(), lift - 0.002);
        const pts = walk(root, S(az, Math.min(1.75, hairPol(az) - 0.1), lift), 0.018, lift, 30);
        const nW = pts.length;
        extend(pts, Math.max(0.15, L * (0.86 + 0.14 * rr()) * (1 - 0.1 * Math.abs(az) / 1.65) - arcLen(pts)), 0.025, null);
        drape(pts, nW, 0.006 + layer * 0.007, V3().copy(back).addScaledVector(LEFT, -Math.sign(az) * 0.4 * Math.min(1, Math.abs(az))), 110, 0.35);
        card(pts, { tile: layer ? 1 : 0, w0: 0.03, w1: layer ? 0.06 : 0.075, tone: (layer ? 1 : 0.84) * (0.97 + 0.06 * rr()), flexLen: 0.5, bulge: 0.2, alpha: rootFade });
      }
    }
    // нижний слой по спине: густая масса под верхними прядями
    {
      const NA = 8;
      for (let k = 0; k < NA; k++) {
        const az = (k / (NA - 1) - 0.5) * 2.2, lift = 0.003;
        const root = S(az, Math.min(1.45 + 0.2 * Math.abs(az), hairPol(az) - 0.14), lift);
        const pts = [root];
        extend(pts, L * (0.72 + 0.14 * rr()), 0.025, V3().copy(dirOf(az, 2.1)).addScaledVector(UP, -1));
        drape(pts, 1, 0.004, back, 110, 0.35);
        card(pts, { tile: 0, w0: 0.05, w1: 0.08, tone: 0.72 + 0.1 * rr(), flexLen: 0.5, bulge: 0.2, alpha: rootFade });
      }
    }
    // пряди у лица: от висков перед ушами — на ключицы и грудь
    for (const s of [1, -1]) for (let k = 0; k < 2; k++) {
      const root = S(s * (Math.PI - 0.62 - 0.14 * k), polFront + 0.16 + 0.1 * k, 0.006);
      const pts = walk(root, S(s * (Math.PI / 2 + 0.55 - 0.08 * k), 1.62, 0.008), 0.016, 0.008, 20);
      const nW = pts.length;
      extend(pts, L * (0.5 - 0.06 * k), 0.03, null);
      drape(pts, nW, 0.012, FWD.clone(), 70, 0.22);
      card(pts, { tile: 1, w0: 0.02, w1: 0.03, tone: 1.0, flexLen: 0.35, flexK: 1.1, bulge: 0.3, alpha: rootFade });
    }
    // тонкие косы от висков: перед ушами вниз, на ключицы; на конце — золотая обмотка
    for (const s of [1, -1]) {
      const lift = 0.013;
      const pts = walk(S(s * (Math.PI - 0.52), polFront + 0.14, lift), S(s * (Math.PI / 2 + 0.5), 1.62, lift), 0.012, lift, 30);
      const nW = pts.length;
      extend(pts, L * 0.36, 0.025, null);
      drape(pts, nW, 0.016, FWD.clone(), 70, 0.25);
      const bc = new THREE.CatmullRomCurve3(pts, false, 'centripetal'), bl = bc.getLength();
      braid(pts, (t) => 0.0034 * (1 - 0.3 * t), (t) => 0.0052 * (1 - 0.25 * t), 0.02, { flexStart: 0.06, flexLen: 0.3, flexK: 1, tone: 1.1, ribbon: true, step: 0.0028 });
      const e0 = bc.getPointAt(0.97), e1 = bc.getPointAt(1);
      tubeG([e0.clone().lerp(e1, -2), e0, e1], () => 0.0042, 8, { color: [1.0, 0.78, 0.42], flexStart: 0.06, flexLen: 0.3, flexK: 1, flex0: bl * 0.94, rows: 3, v0: 0.3, v1: 0.35 });
    }
    hiDetail();
    // выбившиеся волоски поверх (только medium/high)
    for (let k = 0; k < 6; k++) {
      const s = k % 2 ? 1 : -1, u = 0.15 + 0.7 * rr();
      const root = S(Math.PI, polFront * (1 - u) + 0.12, 0.009).addScaledVector(LEFT, s * 0.01);
      const pts = walk(root, S(s * (0.8 + 0.5 * rr()), 1.35, 0.011), 0.02, 0.011, 26);
      const nW = pts.length;
      extend(pts, L * (0.45 + 0.3 * rr()), 0.04, null);
      drape(pts, nW, 0.02, back, 70, 0.22);
      card(pts, { tile: 2, w0: 0.025, w1: 0.04, tone: 1.06, flexLen: 0.4, flexK: 1.2, bulge: 0.05, alpha: rootFade });
    }
  }

  function buildHime() {
    shell(dirOf(0, 0.3), 0.0025, 36, 9, { tone: 0.55 });
    const L = (ST.len) * lenK;
    const yCut = O.y + (browY + 0.006 - cy) * 1;             // ровный срез чёлки — по бровям
    const cutAt = (y) => (p) => p.y <= y;
    // чёлка: два слоя, корни под краем капюшона, срез по линии бровей
    for (const layer of [0, 1]) {
      const NB = layer ? 13 : 11;
      for (let k = 0; k < NB; k++) {
        const u = (k + (layer ? 0.5 : 0)) / (NB - (layer ? 0 : 1)), az = Math.PI + (u - 0.5) * 1.9, side = Math.abs(u - 0.5) * 2;
        const lift = 0.004 + layer * 0.0035;
        const root = S(az, 0.55 + 0.22 * side * side, lift);
        const yC = yCut - 0.012 * side * side;
        const pts = walk(root, S(az + (az - Math.PI) * 0.08, polY(browY - 0.03), lift + 0.006), 0.012, lift, 40, cutAt(yC));
        // объём: середина чёлки отходит ото лба, кончики слегка подогнуты к нему
        const n = pts.length;
        for (let i = 1; i < n; i++) { const t = i / (n - 1); pts[i].addScaledVector(out(pts[i], V3()), 0.006 * Math.sin(Math.PI * t * 0.9)); }
        card(pts, { tile: 3, w0: 0.03, w1: 0.036, tone: 0.95 + 0.1 * rr(), vLin: true, v1: CUT_V + 0.002, taper: false, flexLen: 0.3, flexK: 0.18, bulge: 0.2, rootDark: 0.85 });
      }
    }
    // боковые пряди «химэ»: перед ушами до линии подбородка, срез ровный
    const yJaw = bp.head.y + (sk.minY + 0.012);
    for (const s of [1, -1]) for (let k = 0; k < 3; k++) {
      const az = s * (Math.PI / 2 + 0.62 + 0.15 * k), lift = 0.005 + 0.003 * k;
      const root = S(az, 0.95 + 0.08 * k, lift);
      const pts = walk(root, S(az, 1.45, lift + 0.004), 0.014, lift, 20);
      const last = pts[pts.length - 1];
      for (let y = last.y - 0.02; y > yJaw; y -= 0.02) pts.push(V3().copy(last).setY(y).addScaledVector(out(last, V3()), 0.004));
      pts.push(V3().copy(last).setY(yJaw).addScaledVector(out(last, V3()), 0.004));
      drape(pts, 2, 0.008 + 0.003 * k, null, 40, 0.25);
      card(pts, { tile: 3, w0: 0.03, w1: 0.034, tone: 0.95 + 0.08 * rr(), vLin: true, v1: CUT_V + 0.002, taper: false, flexLen: 0.25, flexK: 0.5, bulge: 0.3 });
    }
    // длинные пряди за боковыми: по плечам на грудь, срез ровный
    for (const layer of [0, 1]) for (const s of [1, -1]) for (let k = 0; k < (layer ? 3 : 2); k++) {
      const az = s * (Math.PI / 2 + 0.08 + 0.17 * k + layer * 0.07), lift = 0.006 + layer * 0.004;
      const root = S(az, 0.95, lift);
      const pts = walk(root, S(az - s * 0.1, 1.5, lift), 0.016, lift, 20);
      extend(pts, L * (0.62 + 0.04 * k) - arcLen(pts), 0.03, null);
      drape(pts, Math.min(pts.length - 1, 3), 0.01 + layer * 0.006, FWD.clone(), 80, 0.2);
      card(pts, { tile: layer ? 3 : 0, w0: 0.035, w1: 0.04, tone: 0.92 + 0.1 * rr(), v1: layer ? CUT_V + 0.002 : 0.97, taper: !layer, flexLen: 0.4, bulge: 0.3 });
    }
    // спина (капюшон снят): прямые длинные пряди с ровным срезом
    if (!hoodOn) {
      for (const layer of [0, 1]) {
        const NA = layer ? 9 : 8;
        for (let k = 0; k < NA; k++) {
          const az = (k / (NA - 1) - 0.5) * 2.2, lift = 0.004 + layer * 0.004;
          const root = S(az, 0.5 + 0.3 * Math.abs(az), lift);
          const pts = walk(root, S(az, 1.7, lift), 0.02, lift, 30);
          extend(pts, L * 0.95 - arcLen(pts), 0.035, null);
          drape(pts, Math.min(pts.length - 1, 4), 0.005 + layer * 0.006, FWD.clone().multiplyScalar(-1));
          card(pts, { tile: 3, w0: 0.05, w1: 0.06, tone: 0.9 + 0.1 * rr(), vLin: true, v1: CUT_V + 0.002, taper: false, flexLen: 0.5, bulge: 0.25 });
        }
      }
    }
    hiDetail();
    for (const s of [1, -1]) for (let k = 0; k < 2; k++) {
      const az = s * (Math.PI / 2 + 0.3 + 0.2 * k);
      const pts = walk(S(az, 0.95, 0.012), S(az, 1.5, 0.014), 0.016, 0.014, 20);
      extend(pts, L * 0.5, 0.03, null);
      drape(pts, Math.min(pts.length - 1, 3), 0.02, FWD.clone(), 70, 0.2);
      card(pts, { tile: 2, w0: 0.025, w1: 0.03, tone: 1.05, flexLen: 0.35, flexK: 1.1, bulge: 0.1 });
    }
  }

  function buildPonytail() {
    const tieDir = dirOf(0, 0.62);
    shell(tieDir, 0.0035, 40, 10, { tone: 0.58, rep: 9 });
    const tie = onScalp(tieDir, 0.012);
    // пряди от линии роста к узлу хвоста (гладко зачёсаны назад), кончики атласа — у линии роста
    const P = tieDir.clone(), E1 = V3().crossVectors(P, UP).normalize(), E2 = V3().crossVectors(P, E1);
    for (const layer of [0, 1]) {
      const NT = layer ? 20 : 18;
      for (let k = 0; k < NT; k++) {
        const th = ((k + (layer ? 0.5 : 0)) / NT) * Math.PI * 2;
        // точка на линии роста по лучу от полюса
        let lo = 0.05, hi = 2.6; const d = V3();
        const dirAt = (de) => d.copy(P).multiplyScalar(Math.cos(de)).addScaledVector(E1, Math.sin(de) * Math.cos(th)).addScaledVector(E2, Math.sin(de) * Math.sin(th));
        for (let it = 0; it < 20; it++) { const mid = (lo + hi) / 2; const a = angOf(dirAt(mid)); if (a.pol < hairPol(a.az)) lo = mid; else hi = mid; }
        const lift = 0.004 + layer * 0.0035;
        const start = onScalp(dirAt(lo + 0.03).clone(), lift);
        const pts = walk(start, tie, 0.016, lift, 40);
        pts.forEach((p, i) => { const t = i / Math.max(1, pts.length - 1); p.addScaledVector(out(p, V3()), 0.005 * t * t); });
        const front = Math.cos(th) < 0 ? 1 : 0;
        card(pts.reverse(), { tile: layer ? 1 : 0, w0: 0.03, w1: 0.05 + 0.01 * front, tone: (layer ? 1 : 0.85) * (0.95 + 0.1 * rr()), flexK: 0, chest: 0, bulge: 0.2, v0: 0.04, vLin: true, v1: layer ? 0.7 : 0.84, rootDark: 0.9, alpha: (t) => (t > 0.85 ? 1 - (t - 0.85) * 3 : 1) });
      }
    }
    // хвост: от узла чуть вверх-назад, затем вниз по спине; коса из трёх прядей, кисточка на конце
    const L = ST.len * lenK;
    const back = FWD.clone().negate();
    const axis = [tie.clone(), tie.clone().addScaledVector(back, 0.028).addScaledVector(UP, -0.004), tie.clone().addScaledVector(back, 0.048).addScaledVector(UP, -0.022)];
    extend(axis, L, 0.03, V3().copy(back).addScaledVector(UP, -1.6));
    drape(axis, 3, 0.03, back, 80, 0.2);
    const tail = (p, t) => 0.35 * Math.min(1, t * 1.5);
    // объём у основания: короткие пряди вокруг оси
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, base = axis.slice(0, 4).map((p) => p.clone());
      const T0 = V3().copy(base[1]).sub(base[0]).normalize(), e1 = V3().crossVectors(T0, UP).normalize(), e2 = V3().crossVectors(T0, e1);
      base.forEach((p, i) => { const r = 0.014 * Math.sin(Math.PI * Math.min(1, (i + 0.5) / 3.2)); p.addScaledVector(e1, Math.cos(a) * r).addScaledVector(e2, Math.sin(a) * r); });
      card(base, { tile: 0, w0: 0.022, w1: 0.02, tone: 0.95, flexK: 0.3, chest: 0, bulge: 0.5, vLin: true, v1: 0.75, taper: false });
    }
    const bAxis = new THREE.CatmullRomCurve3(axis, false, 'centripetal');
    const bl = bAxis.getLength(), bPts = [];
    for (let i = 0; i <= 40; i++) { const t = 0.06 + 0.82 * (i / 40); bPts.push(bAxis.getPointAt(Math.min(1, t * (L + 0.06) / bl))); }
    braid(bPts, (t) => 0.009 * (1 - 0.4 * t), (t) => 0.0105 * (1 - 0.38 * t), 0.046, { chest: tail, flexStart: 0.02, flexLen: 0.3, flexK: 1.3, flex0: 0.05, tone: 1.0 });
    // обмотка у основания (кожаный шнур) и у конца косы
    const wrapAt = (t0, r, len, colr) => {
      const p0 = bAxis.getPointAt(Math.min(1, t0)), p1 = bAxis.getPointAt(Math.min(1, t0 + len / bl));
      tubeG([p0, p0.clone().lerp(p1, 0.5), p1], () => r, 10, { color: colr, chest: tail, flexK: t0 > 0.5 ? 1.2 : 0.1, flex0: t0 * bl, rows: 3, v0: 0.3, v1: 0.4 });
    };
    wrapAt(0.0, 0.0165, 0.016, [0.32, 0.2, 0.13]);
    wrapAt(0.04, 0.0135, 0.004, [1.1, 0.82, 0.42]);
    const endT = Math.min(0.97, (0.06 + 0.82) * (L + 0.06) / bl);
    wrapAt(endT - 0.012 / bl, 0.0085, 0.012, [0.32, 0.2, 0.13]);
    // кисточка: веер коротких прядей из конца косы
    const tip = bAxis.getPointAt(endT), tipT = bAxis.getTangentAt(endT);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2, e1 = V3().crossVectors(tipT, UP).normalize(), e2 = V3().crossVectors(tipT, e1);
      const spread = V3().addScaledVector(e1, Math.cos(a)).addScaledVector(e2, Math.sin(a)).multiplyScalar(0.012);
      const pts = [tip.clone(), tip.clone().addScaledVector(tipT, 0.025).add(spread), tip.clone().addScaledVector(tipT, 0.055).addScaledVector(spread, 1.6)];
      card(pts, { tile: 1, w0: 0.016, w1: 0.024, tone: 0.86, v1: 0.92, chest: tail, flexK: 1.3, flex0: endT * bl, flexStart: 0, flexLen: 0.3, bulge: 0.3, taper: true });
    }
    // выбившиеся пряди у лица: от висков, перед ушами — до линии челюсти
    for (const s of [1, -1]) for (let k = 0; k < 2; k++) {
      const root = S(s * (Math.PI - 0.95 - 0.14 * k), polFront + 0.18 + 0.08 * k, 0.007);
      const pts = walk(root, S(s * (Math.PI / 2 + 0.72 - 0.06 * k), 1.72, 0.012), 0.015, 0.01, 18);
      extend(pts, 0.12 + 0.05 * k, 0.025, null);
      drape(pts, 2, 0.012, FWD.clone().multiplyScalar(0.4), 50, 0.2);
      card(pts, { tile: k ? 2 : 1, w0: 0.012, w1: 0.018, tone: 1.06, flexLen: 0.18, flexK: 1.3, bulge: 0.2, twist: 0.6 * s });
    }
    hiDetail();
    // тонкие волоски поверх зачёса
    for (let k = 0; k < 12; k++) {
      const th = rr() * Math.PI * 2, d = V3().copy(P).multiplyScalar(Math.cos(0.9)).addScaledVector(E1, Math.sin(0.9) * Math.cos(th)).addScaledVector(E2, Math.sin(0.9) * Math.sin(th));
      const a = angOf(d); if (a.pol > hairPol(a.az) - 0.05) continue;
      const pts = walk(onScalp(d, 0.012), tie, 0.02, 0.012, 30);
      card(pts.reverse(), { tile: 2, w0: 0.02, w1: 0.03, tone: 1.1, chest: 0, flexK: 0, bulge: 0.05, v1: 0.9 });
    }
  }

  // ---------------- обруч (эльфийка): золотая дуга по линии над лбом поверх волос, капля-камень
  if (ctx.circlet && ctx.stick && ctx.tube && ctx.gem) {
    const cp = [], pf = polFront - 0.16;
    for (let i = 0; i <= 24; i++) { const a = Math.PI + (i / 24 - 0.5) * 2.4; cp.push(S(a, pf + 0.08 * Math.abs(i / 24 - 0.5), 0.017)); }
    const grp = new THREE.Group(); grp.name = 'circlet';
    grp.add(new THREE.Mesh(ctx.G(ctx.tube(THREE, new THREE.CatmullRomCurve3(cp), 60, 6, (v) => 0.0026 + 0.0012 * Math.sin(Math.PI * v), { flat: 0.6 })), ctx.mats.trim));
    const mid = S(Math.PI, pf, 0.0175);
    const setting = new THREE.Mesh(ctx.G(new THREE.TorusGeometry(0.009, 0.0022, 6, 16)), ctx.mats.trim);
    const gemM = ctx.Mt(new ctx.Std({ name: 'gear-circlet-gem', color: ctx.circlet.gem || 0x7fe8ff, emissive: ctx.circlet.gem || 0x7fe8ff, emissiveIntensity: 0.8, roughness: 0.05, flatShading: true }));
    const drop = new THREE.Mesh(ctx.G(ctx.gem(THREE, { r: 0.007, h: 0.024, n: 6 })), gemM);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), FWD);
    setting.position.copy(mid).addScaledVector(UP, -0.012); setting.quaternion.copy(q);
    drop.position.copy(mid).addScaledVector(UP, -0.013).addScaledVector(FWD, 0.004);
    grp.add(setting, drop);
    const c0 = mid.clone();
    for (const m of grp.children) { m.position.sub(c0); m.updateMatrix(); }
    ctx.stick(grp, 'head', c0, new THREE.Quaternion());
  }

  // ---------------- геометрия в осях обёртки героя (holder)
  const W0inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
  const nm = new THREE.Matrix3().getNormalMatrix(W0inv);
  const nV = pos.length / 3, nTris = idx.length / 3;
  const nIdxLow = detailFrom.at >= 0 ? detailFrom.at : idx.length;
  const P32 = new Float32Array(pos), N32 = new Float32Array(nrm), T32 = new Float32Array(ht);
  for (let i = 0; i < nV; i++) {
    hv.fromArray(P32, i * 3).applyMatrix4(W0inv).toArray(P32, i * 3);
    hv.fromArray(N32, i * 3).applyMatrix3(nm).normalize().toArray(N32, i * 3);
    hv.fromArray(T32, i * 3).transformDirection(W0inv).toArray(T32, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P32, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N32, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.setAttribute('hairW', new THREE.BufferAttribute(new Float32Array(hw), 4));
  geo.setAttribute('hairT', new THREE.BufferAttribute(T32, 3));
  geo.setIndex(nV > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  // рабочие массивы сборки больше не нужны (живут замыкания — освобождаем содержимое)
  pos.length = nrm.length = uv.length = col.length = hw.length = ht.length = idx.length = 0;
  headPts.length = 0; hoodPts.length = 0;

  // кости и матрицы привязки: K = (кость в позе сборки)⁻¹ · (обёртка в позе сборки)
  const Kh = new THREE.Matrix4().copy(headBone.matrixWorld).invert().multiply(holder.matrixWorld);
  const Kc = new THREE.Matrix4().copy(chestBone.matrixWorld).invert().multiply(holder.matrixWorld);
  const pivotLocal = headBone.worldToLocal(O.clone());    // центр черепа в осях кости головы
  const skullR = Math.min(rx, ry, rz) * 0.92;

  // ---------------- юниформы (общие для всех проходов этой причёски)
  const capA = Array.from({ length: HAIR_CAPS }, () => new THREE.Vector4(0, 0, 0, 0)), capB = Array.from({ length: HAIR_CAPS }, () => new THREE.Vector4(0, 0, 0, 0));
  const U = {
    motion: {
      hairHead: { value: new THREE.Matrix4() }, hairChest: { value: new THREE.Matrix4() },
      hairLin: { value: V3() }, hairAng: { value: V3() }, hairPivot: { value: V3() },
      hairWind: { value: new THREE.Vector4(0, 0, 0, 0) }, hairCapA: { value: capA }, hairCapB: { value: capB },
    },
    gloss: {
      hairSpec1: { value: new THREE.Color().fromArray(ST.spec1).multiplyScalar(ST.spec1K) },
      hairSpec2: { value: new THREE.Color().fromArray(ST.spec2).multiplyScalar(ST.spec2K) },
      hairKK: { value: new THREE.Vector4(...ST.kk) },
      hairTT: { value: new THREE.Color(HO.color || 0x3a2418).lerp(new THREE.Color(1, 0.95, 0.85), 0.25).multiplyScalar(ST.tt) },
    },
  };
  // капсулы: корпус (таз → грудь), руки, ключицы, череп, колчан; w у A — «покой» (1) или толкать всегда (0)
  const bodyCapsDef = [];
  const capOf = (name) => (ctx.bodyCaps || []).find((c) => c.name === name);
  const hipsCap = capOf('hips');
  if (hipsCap) bodyCapsDef.push({ a: hipsCap.a, b: hipsCap.b, r: Math.max(0.06, hipsCap.r - 0.03), rest: 1 });
  for (const n of ['leftUpperArm', 'rightUpperArm']) { const c = capOf(n); if (c) bodyCapsDef.push({ a: c.a, b: c.b, r: Math.max(0.035, c.r - 0.012), rest: 0 }); }
  const LUA = raw('leftUpperArm'), RUA = raw('rightUpperArm');
  const clav = LUA && RUA ? { a: LUA, b: RUA, r: 0.05 } : null;
  const quiverObj = ctx.quiver && ctx.quiver.obj ? ctx.quiver : null;
  // кадр обновляет мировые матрицы один раз: цепочка головы (таз … голова) целиком, остальные кости капсул —
  // только их собственные звенья ниже этой цепочки (без повторных обходов до корня сцены)
  const headChain = new Set();
  for (let o = headBone; o; o = o.parent) headChain.add(o);
  const tails = [];
  const addTail = (o) => {
    if (!o) return;
    const ch = [];
    for (let x = o; x && !headChain.has(x); x = x.parent) ch.unshift(x);
    for (const x of ch) if (!tails.includes(x)) tails.push(x);
  };
  for (const c of bodyCapsDef) { addTail(c.a); addTail(c.b); }
  if (clav) { addTail(clav.a); addTail(clav.b); }
  if (quiverObj) addTail(quiverObj.obj);
  const _cA = V3(), _cB = V3(), _cs = V3();

  // ---------------- материалы и меши
  const hairC = new THREE.Color(HO.color || 0x3a2418);
  let tier = null, matKey = null, mats = null, atlasN = 0, lodL = 0;
  const CUT = 0.5;
  function makeMats(tq) {
    const N = tq === 'low' ? 512 : 1024;
    const tex = acquireAtlas(THREE, N);
    const phys = tq !== 'low';
    const Cls = phys ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const common = { color: hairC.clone(), map: tex, vertexColors: true, side: THREE.DoubleSide, roughness: 0.62, metalness: 0, envMapIntensity: 0.32 };
    const made = [];
    const fin = (m, soft) => {
      made.push(m);
      if (atmosphere) { try { atmosphere.patchLit(m, 'hero'); atmosphere.useEnv(m, 0.32); } catch (e) { /* без атмосферы */ } }
      patchHairGloss(THREE, m, U.gloss);
      patchMotion(m, U, false);
      patchAlpha(m, N, soft, CUT);
      return m;
    };
    try {
      const core = fin(new Cls({ ...common, name: 'hair-core', alphaTest: CUT, alphaToCoverage: tq === 'low', ...(phys ? { specularIntensity: 0.35 } : {}) }), false);
      // мягкая кромка: прозрачный двусторонний материал three рисует в два прохода — один (порядок внутри
      // причёски задан индексами: от кожи наружу)
      const soft = tq === 'low' ? null : fin(new Cls({ ...common, name: 'hair-soft', transparent: true, depthWrite: false, forceSinglePass: true, ...(phys ? { specularIntensity: 0.35 } : {}) }), true);
      const depth = new THREE.MeshDepthMaterial({ name: 'hair-depth', depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: CUT, side: THREE.DoubleSide });
      patchMotion(depth, U, true);
      return { core, soft, depth, N };
    } catch (e) {
      // не собралось — ничего не держим: материалы и ссылка на атлас освобождены
      freeMats({ core: made[0] || null, soft: made[1] || null, depth: null, N });
      throw e;
    }
  }
  function freeMats(m) {
    if (!m) return;
    for (const k of ['core', 'soft', 'depth']) {
      const x = m[k]; if (!x) continue;
      if (atmosphere && atmosphere.releaseEnv) { try { atmosphere.releaseEnv(x); } catch (e) { /* ignore */ } }
      x.dispose();
    }
    releaseAtlas(m.N);
  }
  const meshCore = new THREE.Mesh(geo), meshSoft = new THREE.Mesh(geo);
  meshCore.name = 'hair-core'; meshSoft.name = 'hair-soft';
  meshSoft.renderOrder = 1;
  for (const m of [meshCore, meshSoft]) {
    m.userData.noAO = true; m.userData.hair = U; m.receiveShadow = true;
    // вершины двигает шейдер (голова, грудь, пружина): сфера покоя не годится для отсечения — смерть,
    // кувырок, победа уводят голову на метр и больше; герой и так всегда в кадре
    m.frustumCulled = false;
  }
  meshSoft.castShadow = false;
  // качество: low — свой материал (Standard, 512², один проход); medium и high — общие материалы (Physical,
  // 1024², ядро + мягкая кромка), high добавляет выбившиеся волоски (детали в конце индексов)
  function setQuality(q) {
    const tq = q === 'low' || q === 'high' ? q : 'medium';
    if (tq === tier) return;
    const key = tq === 'low' ? 'low' : 'phys';
    if (key !== matKey) {
      const next = makeMats(tq);   // бросит — уровень и материалы остаются прежними
      const old = mats;
      mats = next; matKey = key; atlasN = next.N;
      meshCore.material = next.core;
      meshCore.customDepthMaterial = next.depth;
      meshSoft.material = next.soft || next.core;
      freeMats(old);
    }
    tier = tq;
    geo.setDrawRange(0, tq === 'high' ? Infinity : nIdxLow);
    applyVis();
  }

  // ---------------- пружина (одна на причёску) и кадр
  const SPR = { x: V3(), v: V3(), a: V3(), va: V3(), pPrev: V3(), vPrev: V3(), qPrev: new THREE.Quaternion(), has: false };
  const _hp = V3(), _hq = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _w = V3(), _tgt = V3(), _acc = V3(), _tgtA = V3();
  const _inv = new THREE.Matrix4(), _hs = V3(), _hq2 = new THREE.Quaternion(), _t2 = V3(), _hpos = V3();
  const MAXL = 0.13 * ST.motion, MAXA = 0.4 * ST.motion;
  const perf = { ms: 0 };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let time = 0, ci = 0, capSc = 1;
  function putCap(a, b, r, rest) { if (ci >= HAIR_CAPS) return; capA[ci].set(a.x, a.y, a.z, rest); capB[ci].set(b.x, b.y, b.z, r * capSc); ci++; }
  function update(dt) {
    const t0 = now();
    holder.updateWorldMatrix(true, false);
    headBone.updateWorldMatrix(true, false);
    for (let i = 0; i < tails.length; i++) tails[i].updateWorldMatrix(false, false);
    _inv.copy(holder.matrixWorld).invert();
    const Mo = U.motion;
    Mo.hairHead.value.multiplyMatrices(_inv, headBone.matrixWorld).multiply(Kh);
    Mo.hairChest.value.multiplyMatrices(_inv, chestBone.matrixWorld).multiply(Kc);
    // центр черепа (мир) и поворот головы
    _hp.copy(pivotLocal).applyMatrix4(headBone.matrixWorld);
    headBone.matrixWorld.decompose(_hpos, _hq, _hs);
    const rm = !!(config.settings && config.settings.reducedMotion);
    const gain = (rm ? 0.35 : 1) * ST.motion;
    const jump = SPR.has ? _hp.distanceTo(SPR.pPrev) : 0;
    if (!SPR.has || jump > 3 || dt > 0.5) {
      SPR.x.set(0, 0, 0); SPR.v.set(0, 0, 0); SPR.a.set(0, 0, 0); SPR.va.set(0, 0, 0); SPR.vPrev.set(0, 0, 0);
      SPR.pPrev.copy(_hp); SPR.qPrev.copy(_hq); SPR.has = true;
    } else if (dt > 1e-5) {
      // скорость головы (сглаженная) и её изменение
      _w.copy(_hp).sub(SPR.pPrev).divideScalar(dt);
      _acc.copy(_w).sub(SPR.vPrev).divideScalar(dt);
      if (_acc.length() > 60) _acc.setLength(60);
      SPR.vPrev.lerp(_w, Math.min(1, dt * 18));
      // встречный поток: пряди отстают от движения (бег, рывок); вверх-вниз — слабее
      _tgt.copy(SPR.vPrev).multiplyScalar(-0.017 * gain); _tgt.y *= 0.4;
      if (_tgt.length() > MAXL) _tgt.setLength(MAXL);
      // угловая скорость головы (рад/с): пряди запаздывают при повороте
      _dq.copy(_hq).multiply(_hq2.copy(SPR.qPrev).invert());
      if (_dq.w < 0) { _dq.x = -_dq.x; _dq.y = -_dq.y; _dq.z = -_dq.z; _dq.w = -_dq.w; }
      const ang = 2 * Math.acos(Math.min(1, _dq.w)), sn = Math.sqrt(Math.max(1e-12, 1 - _dq.w * _dq.w));
      _tgtA.set(_dq.x / sn, _dq.y / sn, _dq.z / sn).multiplyScalar(ang > 1e-5 ? -(ang / dt) * 0.06 * gain : 0);
      if (_tgtA.length() > MAXA) _tgtA.setLength(MAXA);
      // пружины с недодемпфированием (перехлёст и успокоение), шаг ≤ 1/120 с
      const n = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 120)))), h = dt / n;
      for (let i = 0; i < n; i++) {
        // инерция: голова рванула — пряди на миг остаются на месте (−ускорение опоры)
        SPR.v.addScaledVector(_t2.copy(_tgt).sub(SPR.x), 70 * h).addScaledVector(SPR.v, -7.5 * h).addScaledVector(_acc, -0.3 * gain * h);
        SPR.x.addScaledVector(SPR.v, h);
        SPR.va.addScaledVector(_t2.copy(_tgtA).sub(SPR.a), 55 * h).addScaledVector(SPR.va, -6.5 * h);
        SPR.a.addScaledVector(SPR.va, h);
      }
      if (SPR.x.length() > MAXL * 1.4) SPR.x.setLength(MAXL * 1.4);
      if (SPR.a.length() > MAXA * 1.4) SPR.a.setLength(MAXA * 1.4);
      SPR.pPrev.copy(_hp); SPR.qPrev.copy(_hq);
    }
    // в оси обёртки: смещение (масштаб обёртки) и ось поворота (только поворот)
    holder.matrixWorld.decompose(_hpos, _hq2, _hs);
    _hq2.invert();
    const sc = 1 / (_hs.x || 1);
    Mo.hairLin.value.copy(SPR.x).applyQuaternion(_hq2).multiplyScalar(sc);
    Mo.hairAng.value.copy(SPR.a).applyQuaternion(_hq2);
    Mo.hairPivot.value.copy(_hp).applyMatrix4(_inv);
    // ветер: лёгкий постоянный бриз с порывами (в шейдере), на LOD 2 — штиль
    time += Math.max(0, Math.min(dt, 0.1));
    const wk = (lodL >= 2 ? 0 : 0.012) * (rm ? 0.3 : 1) * sc;
    Mo.hairWind.value.set(0.8 * wk, 0, 0.35 * wk, time);
    // капсулы тела в осях обёртки (матрицы уже свежие — позиции прямо из них)
    ci = 0; capSc = sc;
    for (const c of bodyCapsDef) { _cA.setFromMatrixPosition(c.a.matrixWorld).applyMatrix4(_inv); _cB.setFromMatrixPosition(c.b.matrixWorld).applyMatrix4(_inv); putCap(_cA, _cB, c.r, c.rest); }
    if (clav) { _cA.setFromMatrixPosition(clav.a.matrixWorld).addScaledVector(UP, 0.03).applyMatrix4(_inv); _cB.setFromMatrixPosition(clav.b.matrixWorld).addScaledVector(UP, 0.03).applyMatrix4(_inv); putCap(_cA, _cB, clav.r, 1); }
    _cs.copy(_hp).applyMatrix4(_inv); putCap(_cs, _cs, skullR, 1);
    if (quiverObj) { _cA.copy(quiverObj.la).applyMatrix4(quiverObj.obj.matrixWorld).applyMatrix4(_inv); _cB.copy(quiverObj.lb).applyMatrix4(quiverObj.obj.matrixWorld).applyMatrix4(_inv); putCap(_cA, _cB, quiverObj.r, 1); }
    for (; ci < HAIR_CAPS; ci++) capB[ci].w = 0;
    perf.ms += (now() - t0 - perf.ms) * 0.1;
  }
  function applyVis() {
    meshCore.castShadow = lodL === 0 && tier !== 'low';
    // вдали мягкая кромка не видна — один проход
    meshSoft.visible = !!(mats && mats.soft) && lodL < 2;
  }
  function setLod(l) { lodL = l; applyVis(); }
  function dispose() {
    for (const m of [meshCore, meshSoft]) if (m.parent) m.parent.remove(m);
    geo.dispose();
    freeMats(mats); mats = null;
  }
  // меши — в обёртку героя только когда материалы собраны и первый кадр посчитан; иначе всё освобождаем
  try {
    setQuality(ctx.quality || 'medium');
    update(0);
  } catch (e) {
    geo.dispose(); freeMats(mats); mats = null;
    throw e;
  }
  holder.add(meshCore, meshSoft);
  names.push('hair');
  const api = {
    names, update, setLod, setQuality, dispose, perf,
    capeGap: 0,
    meshes: [meshCore, meshSoft],
    info: () => ({ style: styleId, verts: nV, tris: nTris, trisLow: nIdxLow / 3, tier, atlas: atlasN, hood: hoodOn }),
  };
  meshCore.userData.hairApi = api;   // QA: info() со стенда
  return api;
}
