/*
 * ASHEN OATH — world.js
 * Роль №3: 3D-окружение, герой и босс (только визуал и анимация).
 * API_VERSION = ASHEN_V1
 *
 * export function createWorld({THREE, scene, renderer, camera, config})
 *   -> { update(dt, snapshot, events), setQuality(level), reset(), dispose(),
 *        // расширения (необязательны для сборщика):
 *        getAnchors(), configure(patch), root, apiVersion }
 *
 * Модуль НЕ вызывает renderer.render(), НЕ двигает камеру, НЕ меняет snapshot,
 * НЕ создаёт requestAnimationFrame. Все объекты висят на одном root-объекте.
 * Соглашение о yaw: поворот вокруг +Y в радианах; при yaw=0 модель смотрит в +Z;
 * направление взгляда = (sin(yaw), 0, cos(yaw)). Для другого соглашения есть config.world.yawOffset.
 */
import { createAtmosphere } from './atmosphere.js';

export const API_VERSION = 'ASHEN_V1';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, v) => smooth01(clamp((v - a) / (b - a), 0, 1));
const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const deg = (d) => (d * Math.PI) / 180;
const normQuality = (l) => (l === 'low' || l === 'high' ? l : 'medium');
function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function vec3(v, dx = 0, dy = 0, dz = 0) {
  return { x: num(v && v.x, dx), y: num(v && v.y, dy), z: num(v && v.z, dz) };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Хэш позиции (мм) -> [0,1): одинаковые вершины на стыках граней получают одинаковый сдвиг.
function hash3(x, y, z, seed) {
  let h =
    Math.imul(Math.round(x * 1000), 73856093) ^
    Math.imul(Math.round(y * 1000), 19349663) ^
    Math.imul(Math.round(z * 1000), 83492791) ^
    Math.imul(seed | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
}

// Периодический value-noise: при per>0 шум тайлится с периодом per ячеек.
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint16Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) val[i] = rnd();
  const mod = (a, m) => ((a % m) + m) % m;
  const h = (a, b) => val[perm[(perm[a & 255] + b) & 255]];
  function n2(x, y, per) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    let x0 = xi, x1 = xi + 1, y0 = yi, y1 = yi + 1;
    if (per) {
      x0 = mod(x0, per); x1 = mod(x1, per); y0 = mod(y0, per); y1 = mod(y1, per);
    }
    const a = h(x0, y0), b = h(x1, y0), c = h(x0, y1), d = h(x1, y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, per, oct = 4) {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * n2(x * f, y * f, per ? per * f : 0);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return s / norm;
  }
  return { n2, fbm };
}

/* ---------------------------- Canvas-текстуры ---------------------------- */

function makeCanvas(w, h) {
  if (typeof document === 'undefined') throw new Error('[world] нужен DOM (document) для Canvas-текстур');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Ломаные трещины (в пикселях), с ответвлениями.
function crackPaths(rnd, size, count, len, widthMin, widthMax) {
  const out = [];
  const walk = (x, y, a, L, w, depth) => {
    const pts = [[x, y]];
    const steps = 6 + ((rnd() * 8) | 0);
    const st = L / steps;
    for (let s = 0; s < steps; s++) {
      a += (rnd() - 0.5) * 0.95;
      x += Math.cos(a) * st;
      y += Math.sin(a) * st;
      pts.push([x, y]);
      if (depth < 2 && rnd() < 0.2) walk(x, y, a + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.7), L * 0.45, w * 0.6, depth + 1);
    }
    out.push({ pts, w });
  };
  for (let k = 0; k < count; k++) {
    walk(rnd() * size, rnd() * size, rnd() * TAU, len * (0.5 + rnd()), lerp(widthMin, widthMax, rnd()), 0);
  }
  return out;
}

function strokePaths(ctx, paths, widthMul, tileSize) {
  const offs = tileSize ? [-tileSize, 0, tileSize] : [0];
  for (const ox of offs) for (const oy of offs) {
    for (const p of paths) {
      ctx.beginPath();
      ctx.moveTo(p.pts[0][0] + ox, p.pts[0][1] + oy);
      for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i][0] + ox, p.pts[i][1] + oy);
      ctx.lineWidth = p.w * widthMul;
      ctx.stroke();
    }
  }
}

// Тайлящийся камень: крупные пятна, зерно, слоистость, каверны.
function paintStone(size, noise, o) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const S = o.scale || 4;
  const base = o.base;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n = noise.fbm(u * S, v * S, S, 5);
      const g = noise.fbm(u * S * 6 + 17.3, v * S * 6 + 5.1, S * 6, 2);
      const pit = noise.n2(u * S * 12 + 3.7, v * S * 12 + 9.2, S * 12);
      const strata = Math.sin((v * (o.strataFreq || 3) + n * 1.4) * TAU) * (o.strata || 0);
      let val = 0.52 + (n - 0.5) * (o.contrast || 0.6) + (g - 0.5) * (o.grain || 0.2) + strata;
      if (pit > 0.8) val -= (pit - 0.8) * (o.pits || 1.2);
      val = clamp(val, 0.05, 1.25);
      const warm = (n - 0.5) * (o.hueShift || 0.06);
      const i = (y * size + x) * 4;
      d[i] = clamp(base[0] * val * (1 + warm) * 255, 0, 255);
      d[i + 1] = clamp(base[1] * val * 255, 0, 255);
      d[i + 2] = clamp(base[2] * val * (1 - warm) * 255, 0, 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function paintCloth(size, noise) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const weave = (((x >> 1) + (y >> 1)) & 1) ? 0.06 : -0.06;
    const threadV = Math.sin(x * Math.PI * 0.5) * 0.03;
    const mott = (noise.fbm(u * 6, v * 6, 6, 4) - 0.5) * 0.35;
    const wear = noise.fbm(u * 3 + 7, v * 3 + 1, 3, 3) > 0.62 ? 0.08 : 0;
    const val = clamp(0.72 + weave + threadV + mott + wear, 0, 1);
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = val * 255;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function paintRadial(size, stops) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// Центральная печать клятвы: albedo (гравировка с золотой инкрустацией) + emissive (свечение линий).
function paintSigil(size, stoneCanvas, seed) {
  const albedo = makeCanvas(size, size);
  const glow = makeCanvas(size, size);
  const a = albedo.getContext('2d');
  const g = glow.getContext('2d');
  // основа: камень, слегка темнее к центру
  const pat = a.createPattern(stoneCanvas, 'repeat');
  a.fillStyle = pat;
  a.save();
  a.scale(1.4, 1.4);
  a.fillRect(0, 0, size, size);
  a.restore();
  const vg = a.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  vg.addColorStop(0, 'rgba(10,10,12,0.35)');
  vg.addColorStop(0.7, 'rgba(10,10,12,0.05)');
  vg.addColorStop(1, 'rgba(10,10,12,0.25)');
  a.fillStyle = vg;
  a.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);

  const cx = size / 2, cy = size / 2, R = size * 0.485;
  const draw = (ctx, mode) => {
    const rnd = mulberry32(seed);
    const lw = (w) => (mode === 'groove' ? w + size * 0.005 : w);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const arcBroken = (r, w, breaks) => {
      let a0 = rnd() * TAU;
      for (let i = 0; i < breaks; i++) {
        const len = TAU / breaks - (0.05 + rnd() * 0.12);
        ctx.beginPath();
        ctx.arc(cx, cy, r, a0, a0 + len);
        ctx.lineWidth = lw(w);
        ctx.stroke();
        a0 += TAU / breaks;
      }
    };
    arcBroken(R * 0.955, size * 0.009, 5);
    arcBroken(R * 0.8, size * 0.0045, 7);
    arcBroken(R * 0.62, size * 0.006, 9);
    arcBroken(R * 0.3, size * 0.0045, 4);
    arcBroken(R * 0.14, size * 0.004, 3);
    // пояс рун
    const runes = 30;
    for (let k = 0; k < runes; k++) {
      const ang = (k / runes) * TAU;
      ctx.save();
      ctx.translate(cx + Math.cos(ang) * R * 0.875, cy + Math.sin(ang) * R * 0.875);
      ctx.rotate(ang + Math.PI / 2);
      const s = size * 0.022;
      ctx.lineWidth = lw(size * 0.0035);
      const strokes = 2 + ((rnd() * 3) | 0);
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.lineTo(0, s);
      for (let q = 0; q < strokes; q++) {
        const t = rnd();
        const y0 = lerp(-s, s, rnd());
        if (t < 0.35) { ctx.moveTo(0, y0); ctx.lineTo((rnd() < 0.5 ? -1 : 1) * s * 0.7, y0 + s * 0.5); }
        else if (t < 0.65) { ctx.moveTo(-s * 0.55, y0); ctx.lineTo(s * 0.55, y0); }
        else { ctx.moveTo(s * 0.5, y0); ctx.arc(0, y0, s * 0.5, 0, Math.PI, rnd() < 0.5); }
      }
      ctx.stroke();
      ctx.restore();
    }
    // радиальные риски
    for (let k = 0; k < 63; k++) {
      const ang = (k / 63) * TAU;
      const r0 = R * 0.64, r1 = R * (k % 9 === 0 ? 0.79 : 0.7);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineWidth = lw(size * (k % 9 === 0 ? 0.004 : 0.0022));
      ctx.stroke();
    }
    // гептаграмма {7/3}
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const ang = -Math.PI / 2 + (k / 7) * TAU;
      pts.push([cx + Math.cos(ang) * R * 0.6, cy + Math.sin(ang) * R * 0.6]);
    }
    ctx.beginPath();
    for (let k = 0; k <= 7; k++) {
      const p = pts[(k * 3) % 7];
      if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.lineWidth = lw(size * 0.005);
    ctx.stroke();
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], size * 0.016, 0, TAU);
      ctx.lineWidth = lw(size * 0.004);
      ctx.stroke();
    }
  };
  // гравировка
  a.strokeStyle = 'rgba(14,12,10,0.95)';
  draw(a, 'groove');
  a.strokeStyle = 'rgb(150,116,58)';
  draw(a, 'gold');
  // свечение
  g.strokeStyle = 'rgb(255,236,200)';
  g.shadowColor = 'rgb(255,170,80)';
  g.shadowBlur = size * 0.012;
  draw(g, 'gold');
  g.shadowBlur = 0;
  // трещины рвут печать
  const rnd = mulberry32(seed + 99);
  const cracks = [];
  for (let k = 0; k < 6; k++) {
    let ang = rnd() * TAU, r = R * (0.15 + rnd() * 0.2);
    const pts = [[cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]];
    while (r < R * 1.02) {
      r += size * (0.02 + rnd() * 0.03);
      ang += (rnd() - 0.5) * 0.18;
      pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
    }
    cracks.push({ pts, w: size * (0.004 + rnd() * 0.004) });
  }
  g.strokeStyle = '#000';
  strokePaths(g, cracks, 2.2, 0);
  a.strokeStyle = 'rgba(8,7,6,0.9)';
  strokePaths(a, cracks, 1.0, 0);
  return { albedo, glow };
}

// Радиальные трещины пола, расходящиеся от печати (аддитивная декаль, чёрный = нет вклада).
function paintFloorCracks(size, seed, innerFrac) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const rnd = mulberry32(seed);
  const cx = size / 2, cy = size / 2, R = size / 2;
  const paths = [];
  const count = 11;
  for (let k = 0; k < count; k++) {
    let ang = (k / count) * TAU + (rnd() - 0.5) * 0.35;
    let r = R * innerFrac;
    const maxR = R * lerp(innerFrac + 0.22, 0.95, rnd());
    const pts = [[cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]];
    let w = size * (0.006 + rnd() * 0.004);
    while (r < maxR) {
      r += size * (0.012 + rnd() * 0.02);
      ang += (rnd() - 0.5) * 0.16;
      pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
      if (rnd() < 0.12) {
        const bp = [pts[pts.length - 1].slice()];
        let ba = ang + (rnd() < 0.5 ? 1 : -1) * (0.4 + rnd() * 0.5), br = 0;
        let bx = bp[0][0], by = bp[0][1];
        const bl = size * (0.04 + rnd() * 0.06);
        while (br < bl) {
          const st = size * 0.012;
          br += st; ba += (rnd() - 0.5) * 0.5;
          bx += Math.cos(ba) * st; by += Math.sin(ba) * st;
          bp.push([bx, by]);
        }
        paths.push({ pts: bp, w: w * 0.55 });
      }
    }
    paths.push({ pts, w });
    w *= 0.8;
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgb(120,120,120)';
  ctx.shadowColor = 'rgb(160,160,160)';
  ctx.shadowBlur = size * 0.01;
  strokePaths(ctx, paths, 1.6, 0);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgb(255,255,255)';
  strokePaths(ctx, paths, 0.55, 0);
  // затухание к краю
  const fade = ctx.createRadialGradient(cx, cy, R * innerFrac, cx, cy, R);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// Спиральная дымка портала.
function paintSpiral(size, seed) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const noise = makeNoise(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x - size / 2) / (size / 2), dy = (y - size / 2) / (size / 2);
    const r = Math.sqrt(dx * dx + dy * dy);
    const a = Math.atan2(dy, dx);
    const arm = 0.5 + 0.5 * Math.sin(a * 3 + r * 9 + noise.n2(dx * 3 + 5, dy * 3 + 5, 0) * 2.5);
    const v = Math.pow(arm, 3) * smoothstep(1.0, 0.25, r) * smoothstep(0.0, 0.18, r) + smoothstep(0.35, 0.0, r) * 0.45;
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = clamp(v * 255, 0, 255);
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------ Настройки ------------------------------ */

const WORLD_DEFAULTS = {
  arenaRadius: 10,
  quality: 'medium',
  ambientAsh: true,        // фоновый пепел (не боевой эффект); выключите, если №6 делает свой
  manageFog: true,         // world ставит scene.fog и scene.background, возвращает прежние в dispose
  manageShadowMap: true,   // world включает renderer.shadowMap.enabled (одно вмешательство в renderer)
  yawOffset: 0,            // добавка к snapshot yaw, если у combat другое соглашение
  heroYawRate: 18,         // скорость визуального догоняния yaw героя (1/с)
  bossYawRate: 7,
  bossScale: 1,
  reducedMotion: false,
  seed: 7331,
};

const QUALITY_PRESETS = {
  low:    { tier: 0, shadows: false, shadowSize: 512,  ash: 260,  brazierLights: 0, clothNormals: 2 },
  medium: { tier: 1, shadows: true,  shadowSize: 1024, ash: 650,  brazierLights: 2, clothNormals: 1 },
  high:   { tier: 2, shadows: true,  shadowSize: 2048, ash: 1300, brazierLights: 4, clothNormals: 1 },
};

export function createWorld({ THREE, scene, renderer, camera, config = {} } = {}) {
  if (!THREE || !scene) throw new Error('[world] createWorld: нужны THREE и scene');
  const wc = Object.assign({}, WORLD_DEFAULTS, (config && config.world) || {});
  const initialQuality = normQuality(
    (config && config.world && config.world.quality) || (config && config.quality) ||
    (config && config.settings && config.settings.quality) || wc.quality);
  if (config && config.settings && typeof config.settings.reducedMotion === 'boolean' &&
      !(config.world && 'reducedMotion' in config.world)) wc.reducedMotion = config.settings.reducedMotion;
  const K = num(wc.arenaRadius, 10) / 10; // масштаб радиусов композиции
  const REV = parseInt(THREE.REVISION, 10) || 0;

  // Единицы света: с r155 физические (кандела, без *PI), до этого — «легаси».
  let physicalLights = true;
  if (renderer) {
    // r155+: физические единицы по умолчанию (чтение .useLegacyLights в r155–r164 даёт deprecation-warning, не трогаем)
    if (REV >= 155) physicalLights = true;
    else if (REV >= 150) physicalLights = renderer.useLegacyLights === false;
    else physicalLights = renderer.physicallyCorrectLights === true;
  }
  const LI = physicalLights ? { dir: Math.PI, hemi: Math.PI, point: 1 } : { dir: 1, hemi: 1, point: 1 / 16 };

  /* ---------------------------- Учёт ресурсов ---------------------------- */
  const owned = { geo: new Set(), mat: new Set(), tex: new Set(), rt: [] };
  const G = (g) => { owned.geo.add(g); return g; };
  const M = (m) => { owned.mat.add(m); return m; };
  const T = (t) => { owned.tex.add(t); return t; };

  const root = new THREE.Group();
  root.name = 'ashen-world-root';
  scene.add(root);

  const seedRnd = mulberry32(wc.seed);
  const noise = makeNoise(wc.seed);

  /* ------------------------------ Геометрия ------------------------------ */
  function mergeGeos(list) {
    let vCount = 0, iCount = 0;
    const hasColor = list.some((g) => g.attributes.color);
    for (const g of list) {
      vCount += g.attributes.position.count;
      iCount += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const col = hasColor ? new Float32Array(vCount * 3).fill(1) : null;
    const idx = new Uint32Array(iCount);
    let vo = 0, io = 0;
    for (const g of list) {
      const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = g.attributes.color;
      for (let i = 0; i < p.count; i++) {
        pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
        if (n) { nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i); }
        if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
        if (c && col) { col[(vo + i) * 3] = c.getX(i); col[(vo + i) * 3 + 1] = c.getY(i); col[(vo + i) * 3 + 2] = c.getZ(i); }
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      else for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      vo += p.count;
      io += g.index ? g.index.count : p.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  }

  // UV-проекция по доминирующей оси нормали: одинаковый масштаб текстуры на всех гранях.
  function boxProjectUV(geo, scale, ox = 0, oy = 0) {
    const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
    if (!uv || !n) return geo;
    for (let i = 0; i < p.count; i++) {
      const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
      let u, v;
      if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); }
      else if (ay >= az) { u = p.getX(i); v = p.getZ(i); }
      else { u = p.getX(i); v = p.getY(i); }
      uv.setXY(i, u / scale + ox, v / scale + oy);
    }
    uv.needsUpdate = true;
    return geo;
  }

  // «Тёсаный» блок: фаски на рёбрах, сужение, детерминированная неровность.
  function chiseled(w, h, d, o = {}) {
    const bevel = o.bevel != null ? o.bevel : Math.min(w, h, d) * 0.12;
    const jit = o.jitter != null ? o.jitter : Math.min(w, h, d) * 0.035;
    const seg = o.seg || 2;
    const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
    const p = g.attributes.position;
    const hw = w / 2, hh = h / 2, hd = d / 2, eps = 1e-4;
    const sd = o.seed || 1;
    const tTop = o.taperTop != null ? o.taperTop : 1;
    const tTopD = o.taperTopD != null ? o.taperTopD : tTop;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ex = Math.abs(Math.abs(x) - hw) < eps, ey = Math.abs(Math.abs(y) - hh) < eps, ez = Math.abs(Math.abs(z) - hd) < eps;
      const edges = (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0);
      const r1 = hash3(x, y, z, sd), r2 = hash3(y, z, x, sd + 7), r3 = hash3(z, x, y, sd + 13);
      const ox = x, oy = y, oz = z;
      if (edges >= 2) {
        const b = bevel * (edges === 3 ? 1 : 0.55) * (0.7 + 0.6 * r1);
        if (ex) x -= Math.sign(ox) * b;
        if (ey) y -= Math.sign(oy) * b;
        if (ez) z -= Math.sign(oz) * b;
      }
      x += (r1 - 0.5) * jit; y += (r2 - 0.5) * jit; z += (r3 - 0.5) * jit;
      const t = (oy + hh) / h;
      x *= lerp(1, tTop, t);
      z *= lerp(1, tTopD, t);
      p.setXYZ(i, x, y, z);
    }
    if (o.uvScale) boxProjectUV(g, o.uvScale, (hash3(w, h, d, sd) * 10) % 1, (hash3(d, w, h, sd) * 10) % 1);
    g.computeVertexNormals();
    return g;
  }

  // Неровный валун/скол.
  function rockGeo(r, detail, seed, squash = 1) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 0.78 + hash3(x, y, z, seed) * 0.4;
      p.setXYZ(i, x * k, y * k * squash, z * k);
    }
    g.computeVertexNormals();
    boxProjectUV(g, 1.6, hash3(r, seed, 1, 2), hash3(seed, r, 3, 4));
    return g;
  }

  function lathe(profile, seg) {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y));
    return new THREE.LatheGeometry(pts, seg);
  }

  // Конечность вдоль -Y от шарнира: скруглённые концы.
  function limbGeo(r0, r1, len, seg = 10) {
    const prof = [
      [0.0005, -len - r1 * 0.55], [r1 * 0.72, -len - r1 * 0.38], [r1, -len],
      [lerp(r1, r0, 0.5) * 1.03, -len * 0.5], [r0, 0], [r0 * 0.72, r0 * 0.38], [0.0005, r0 * 0.55],
    ];
    return lathe(prof, seg);
  }

  /* ------------------------------ Текстуры ------------------------------ */
  const maxAniso = renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy
    ? renderer.capabilities.getMaxAnisotropy() : 1;
  function tex(canvas, { srgb = true, repeat = true, aniso = 4 } = {}) {
    const t = new THREE.CanvasTexture(canvas);
    if (srgb) {
      if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    }
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(aniso, maxAniso || 1);
    t.needsUpdate = true;
    return T(t);
  }

  const stoneCanvas = paintStone(512, noise, { base: [0.62, 0.61, 0.6], scale: 4, contrast: 0.55, grain: 0.22, strata: 0.025, pits: 1.4 });
  const floorCanvas = paintStone(512, makeNoise(wc.seed + 11), { base: [0.64, 0.64, 0.66], scale: 3, contrast: 0.42, grain: 0.18, strata: 0.0, pits: 1.0, hueShift: 0.04 });
  {
    const ctx = floorCanvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(22,20,18,0.55)';
    strokePaths(ctx, crackPaths(mulberry32(wc.seed + 5), 512, 7, 180, 0.8, 2.0), 1, 512);
    ctx.strokeStyle = 'rgba(210,205,195,0.10)';
    strokePaths(ctx, crackPaths(mulberry32(wc.seed + 6), 512, 12, 90, 0.8, 1.6), 1, 512);
  }
  // Камень босса и карта трещин — общие пути, чтобы тёмная щель и свечение совпадали.
  const bossStoneCanvas = paintStone(512, makeNoise(wc.seed + 21), { base: [0.66, 0.63, 0.58], scale: 3, contrast: 0.5, grain: 0.25, strata: 0.02, pits: 1.2, hueShift: 0.08 });
  const bossCrackCanvas = makeCanvas(512, 512);
  {
    const paths = crackPaths(mulberry32(wc.seed + 31), 512, 9, 260, 1.2, 2.8);
    const a = bossStoneCanvas.getContext('2d');
    a.lineCap = 'round'; a.lineJoin = 'round';
    a.strokeStyle = 'rgba(14,10,8,0.95)';
    strokePaths(a, paths, 1.35, 512);
    const e = bossCrackCanvas.getContext('2d');
    e.fillStyle = '#000'; e.fillRect(0, 0, 512, 512);
    e.lineCap = 'round'; e.lineJoin = 'round';
    e.strokeStyle = 'rgb(70,70,70)';
    e.shadowColor = 'rgb(110,110,110)'; e.shadowBlur = 6;
    strokePaths(e, paths, 1.5, 512);
    e.shadowBlur = 0;
    e.strokeStyle = 'rgb(255,255,255)';
    strokePaths(e, paths, 0.6, 512);
  }
  const clothCanvas = paintCloth(256, makeNoise(wc.seed + 41));
  const sigilC = paintSigil(1024, stoneCanvas, wc.seed + 51);
  const floorCrackCanvas = paintFloorCracks(1024, wc.seed + 61, 3.3 / 9.4);

  const texStone = tex(stoneCanvas);
  const texFloor = tex(floorCanvas, { aniso: 8 });
  const texBossStone = tex(bossStoneCanvas);
  const texBossCrack = tex(bossCrackCanvas);
  const texCloth = tex(clothCanvas);
  const texSigil = tex(sigilC.albedo, { repeat: false, aniso: 8 });
  const texSigilGlow = tex(sigilC.glow, { repeat: false, aniso: 8 });
  const texFloorCracks = tex(floorCrackCanvas, { repeat: false, aniso: 8 });
  const texGlow = tex(paintRadial(128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.55)'], [0.6, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]), { repeat: false });
  const texDot = tex(paintRadial(32, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]), { repeat: false });
  const texBlob = tex(paintRadial(128, [[0, 'rgba(0,0,0,0.85)'], [0.45, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]), { repeat: false, srgb: false });
  const texSpiral = tex(paintSpiral(256, wc.seed + 71), { repeat: false });

  /* ------------------------------ Материалы ------------------------------ */
  const std = (p) => M(new THREE.MeshStandardMaterial(p));
  const bumpS = REV >= 159 ? 1.2 : 0.02; // bump-масштаб изменился в r159

  // Пол — Physical ради specularIntensity: контровой ключ у самой земли давал «солнечный» пересвет
  // на мокром камне прямо под героем. Блеск остаётся в лужах (Библия: roughness ~0.2), но слабее.
  const matFloor = M(new THREE.MeshPhysicalMaterial({ color: 0x939599, map: texFloor, bumpMap: texFloor, bumpScale: bumpS, vertexColors: true, roughness: 0.94, metalness: 0, specularIntensity: 0.4 }));
  const matStone = std({ color: 0x8c8983, map: texStone, bumpMap: texStone, bumpScale: bumpS, roughness: 0.92, metalness: 0 });
  const matStoneFlat = std({ color: 0x7f7c76, map: texStone, roughness: 0.95, metalness: 0, flatShading: true });
  const matGround = std({ color: 0x5b5956, map: texStone, roughness: 0.97, metalness: 0, vertexColors: true });
  const matFar = std({ color: 0x3e4048, map: texStone, roughness: 1, metalness: 0 });
  const matGold = std({ color: 0xa27f45, roughness: 0.42, metalness: 0.72 });
  const matIron = std({ color: 0x34302c, roughness: 0.58, metalness: 0.55 });
  const matSigilTop = std({ color: 0xffffff, map: texSigil, emissive: 0xd7a15a, emissiveMap: texSigilGlow, emissiveIntensity: 0.6, roughness: 0.9, metalness: 0.05 });
  const matSigilSide = std({ color: 0x6d6a66, map: texStone, roughness: 0.93 });
  const matCoals = std({ color: 0x1a1210, emissive: 0xff7a30, emissiveIntensity: 4.0, roughness: 1, flatShading: true });

  // Персонажи
  const matCoat = std({ color: 0x4b505e, map: texCloth, bumpMap: texCloth, bumpScale: bumpS * 0.6, roughness: 0.96, side: THREE.DoubleSide });
  const matTunic = std({ color: 0x4a4436, map: texCloth, roughness: 0.95, side: THREE.DoubleSide });
  const matCape = std({ color: 0x2f333d, map: texCloth, bumpMap: texCloth, bumpScale: bumpS * 0.6, roughness: 0.97, side: THREE.DoubleSide });
  const matTrousers = std({ color: 0x2a2b30, map: texCloth, roughness: 0.95 });
  const matLeather = std({ color: 0x4a3525, roughness: 0.72, metalness: 0.05 });
  const matSkin = std({ color: 0x0d0b0b, roughness: 0.9 });
  const matHoodVoid = M(new THREE.MeshBasicMaterial({ color: 0x050507, side: THREE.BackSide }));
  const matHeroEyes = std({ color: 0x000000, emissive: 0x9cc4ff, emissiveIntensity: 0.9 });
  const matGloveR = std({ color: 0x2e241d, emissive: 0xffa24a, emissiveIntensity: 0.15, roughness: 0.7 });
  const matGloveL = std({ color: 0x2e241d, emissive: 0xa9ccff, emissiveIntensity: 0.12, roughness: 0.7 });
  const matAmulet = std({ color: 0x3a2a14, emissive: 0xffc27a, emissiveIntensity: 0.4, roughness: 0.4, metalness: 0.5 });
  const matLantern = std({ color: 0x3a2412, emissive: 0xffa04a, emissiveIntensity: 1.3, roughness: 0.5, transparent: false });

  const matBoss = std({
    color: 0xa8a49e, map: texBossStone, bumpMap: texBossStone, bumpScale: bumpS * 1.4,
    emissive: 0xff7a2e, emissiveMap: texBossCrack, emissiveIntensity: 0.45, roughness: 0.9, metalness: 0, flatShading: true,
  });
  const matBossDark = std({ color: 0x6a655e, map: texBossStone, emissive: 0xff7a2e, emissiveMap: texBossCrack, emissiveIntensity: 0.5, roughness: 0.92, flatShading: true });
  // Фарфоровая маска: глазурь (roughness ~0.3), в трещинах тлеет.
  const matBossMask = std({ color: 0xd9d2c4, roughness: 0.32, metalness: 0, emissive: 0xff5a3c, emissiveMap: texBossCrack, emissiveIntensity: 0.25 });
  const matHaloBronze = std({ color: 0x3b2f24, roughness: 0.42, metalness: 0.85 });
  const matHaloEdge = M(new THREE.MeshBasicMaterial({ color: 0xffb870, fog: false }));
  matHaloEdge.color.multiplyScalar(3.4); // HDR: горящий край нимба (порог bloom 1.0), не заливает диск затмения
  const matMaskCrack = M(new THREE.MeshBasicMaterial({ color: 0xffe6b8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  matMaskCrack.color.multiplyScalar(6);
  const matSunGlow = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffe2a8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  matSunGlow.color.multiplyScalar(2.2);
  const matSeal = M(new THREE.MeshBasicMaterial({ map: texSigilGlow, color: 0x9ff8ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  matSeal.color.multiplyScalar(2.2); // слабые точки: холодный бело-бирюзовый, пульс 1.2 Гц
  const matBossCore = std({ color: 0x2a2010, emissive: 0xffe2a8, emissiveIntensity: 2.4, roughness: 0.35, flatShading: true }); // «украденное солнце»
  const matBossEyes = std({ color: 0x000000, emissive: 0xffd08a, emissiveIntensity: 2.6 });
  const matBossRunes = std({ color: 0x3b3128, emissive: 0xffb060, emissiveIntensity: 0.9, roughness: 0.8, flatShading: true });

  const addMat = (color, opacity, map, fog = false) => M(new THREE.MeshBasicMaterial({
    color, map, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog,
  }));
  const matFloorCracks = addMat(0xff8a3a, 0.4, texFloorCracks);
  const matChestSigil = addMat(0xffa65a, 0.55, texSigilGlow);
  const matCoreGlow = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffd9a0, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const matBlob = M(new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: texBlob, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));

  /* =============================== ОКРУЖЕНИЕ =============================== */
  const env = new THREE.Group();
  env.name = 'ashen-environment';
  root.add(env);
  // [ASHEN_V2] раскладка для боя и камеры: коллайдеры совпадают с видимой геометрией (контракт К.9)
  const LAYOUT_COLLIDERS = [];
  const addCircle = (x, z, r) => { if ([x, z, r].every(Number.isFinite) && r > 0) LAYOUT_COLLIDERS.push({ type: 'circle', x, z, r }); };
  const addSegment = (ax, az, bx, bz, r) => { if ([ax, az, bx, bz, r].every(Number.isFinite)) LAYOUT_COLLIDERS.push({ type: 'segment', ax, az, bx, bz, r }); };
  const instTiers = []; // {mesh, counts:[low,med,high]}
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
  const polar = (aDeg, r, y = 0) => new THREE.Vector3(Math.sin(deg(aDeg)) * r, y, Math.cos(deg(aDeg)) * r);

  function instItem(pos, rot, scl, tier = 0, color = null) {
    _e.set(rot.x || 0, rot.y || 0, rot.z || 0, rot.order || 'XYZ');
    _q.setFromEuler(_e);
    return { m: new THREE.Matrix4().compose(pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), _q.clone(), new THREE.Vector3(scl.x, scl.y, scl.z)), tier, color };
  }
  function buildInstanced(geo, mat, items, { cast = true, receive = true, name = '' } = {}) {
    items.sort((a, b) => a.tier - b.tier);
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
    mesh.name = name;
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.color) mesh.setColorAt(i, it.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.frustumCulled = false; // экземпляры разнесены по кругу; старые ревизии считают bounds только по geometry
    const counts = [0, 1, 2].map((t) => items.filter((it) => it.tier <= t).length);
    mesh.count = counts[2];
    instTiers.push({ mesh, counts });
    env.add(mesh);
    return mesh;
  }

  // [ASHEN_V3] Экземпляры, разбросанные по большой карте: InstancedMesh на клетку chunk×chunk м
  // с настоящими границами — отсекаются по кадру и по теневой камере; дальше cull м — скрыты
  // (туман там и так почти сплошной).
  const culledChunks = [];   // {mesh, x, z, r, cull}
  function buildInstancedChunked(geo, mat, items, { chunk = 64, cull = 200, ...opts } = {}) {
    const groups = new Map();
    const p = new THREE.Vector3();
    for (const it of items) {
      p.setFromMatrixPosition(it.m);
      const k = Math.floor(p.x / chunk) * 4096 + Math.floor(p.z / chunk);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    for (const list of groups.values()) {
      const mesh = buildInstanced(geo, mat, list, opts);
      mesh.frustumCulled = true;
      if (mesh.computeBoundingSphere) mesh.computeBoundingSphere();
      const bs = mesh.boundingSphere;
      if (bs) culledChunks.push({ mesh, x: bs.center.x, z: bs.center.z, r: bs.radius, cull });
    }
  }

  /* ---------------- Небо, затмение, высотный туман (atmosphere.js) ---------------- */
  const atmo = createAtmosphere({
    THREE, scene, renderer, camera, parent: env, G, M, T,
    seed: wc.seed, reducedMotion: wc.reducedMotion, quality: initialQuality,
  });
  const skyR = atmo.skyRadius;
  for (const m of [matGold, matIron, matAmulet]) atmo.useEnv(m, 1.0);

  /* ------------------------------ Свет ------------------------------ */
  const lights = new THREE.Group();
  lights.name = 'ashen-lights';
  root.add(lights);
  // Библия, разд. 4: ключ — корона затмения за боссом (тени к камере, контур героя и босса),
  // заполнение — небо (#2A3850 сверху, #120E0C снизу) и IBL; персонажам — шейдерный fill и rim.
  const PL = LI.dir / Math.PI; // физические единицы r155+ -> легаси
  const HEMI_I = 3.6;
  const hemi = new THREE.HemisphereLight(0x2a3850, 0x120e0c, HEMI_I * PL);
  lights.add(hemi);
  const moonLight = new THREE.DirectionalLight(0xb9c9e6, 3.0 * PL); // имя историческое: это ключ от затмения
  moonLight.position.copy(atmo.keyDir).multiplyScalar(40);
  moonLight.target.position.set(0, 0, 0);
  lights.add(moonLight, moonLight.target);
  const SHADOW_HALF = 21;   // [ASHEN_V3] камера тени следует за героем (followShadow), свет — с 80 м по ключу
  moonLight.shadow.camera.left = -SHADOW_HALF; moonLight.shadow.camera.right = SHADOW_HALF;
  moonLight.shadow.camera.top = SHADOW_HALF; moonLight.shadow.camera.bottom = -SHADOW_HALF;
  moonLight.shadow.camera.near = 20; moonLight.shadow.camera.far = 150;
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0004;
  moonLight.shadow.normalBias = 0.035;
  const FILL_I = 0.55;
  const fillLight = new THREE.DirectionalLight(0x5d6a82, FILL_I * PL); // слабый встречный, без тени: камень у камеры не проваливается в чёрное
  fillLight.position.set(4, 7, 14);
  fillLight.target.position.set(0, 1.5, 0);
  lights.add(fillLight, fillLight.target);
  const prevShadowEnabled = renderer && renderer.shadowMap ? renderer.shadowMap.enabled : undefined;
  if (renderer && renderer.shadowMap && wc.manageShadowMap) renderer.shadowMap.enabled = true;

  /* --------------------- PBR-карты Poly Haven (CC0) и мокрый пол --------------------- */
  // Лужи: шум в мировых координатах, в луже шероховатость 0.07 и ровная нормаль — отражают корону и магию.
  const WET_GLSL = /* glsl */`
uniform vec4 ashWet;
varying vec3 vAshWorldPos;
float ashWH( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float ashWN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( ashWH( i ), ashWH( i + vec2( 1.0, 0.0 ) ), u.x ), mix( ashWH( i + vec2( 0.0, 1.0 ) ), ashWH( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float ashPuddle( vec2 xz ) {
  float n = ashWN( xz * 0.31 ) * 0.6 + ashWN( xz * 0.93 + 7.3 ) * 0.28 + ashWN( xz * 2.9 + 1.1 ) * 0.12;
  return smoothstep( 0.55, 0.61, n );
}`;
  // o = {x: сила луж, y: множитель шероховатости, z: насыщенность альбедо, w: яркость альбедо}
  function patchWet(mat, o) {
    mat.userData.ashWet = o;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.ashWet = { value: o };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAshWorldPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vAshWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + WET_GLSL)
        .replace('#include <map_fragment>', `#include <map_fragment>
  float ashPud = ashPuddle( vAshWorldPos.xz ) * ashWet.x;
  {
    float ashL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    diffuseColor.rgb = mix( vec3( ashL ), diffuseColor.rgb, ashWet.z ) * ashWet.w;
    diffuseColor.rgb *= mix( 1.0, 0.45, ashPud );
  }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor * ashWet.y, 0.2, ashPud );`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize( mix( normal, nonPerturbedNormal, ashPud * 0.92 ) );`);
    };
    mat.customProgramCacheKey = () => 'ashWet';
    mat.needsUpdate = true;
  }
  patchWet(matFloor, { x: 1, y: 1.0, z: 0.42, w: 1.55 });
  patchWet(matStone, { x: 0, y: 1, z: 0.4, w: 1.9 });
  patchWet(matStoneFlat, { x: 0, y: 1, z: 0.4, w: 1.75 });
  patchWet(matSigilSide, { x: 0, y: 1, z: 0.4, w: 1.6 });
  patchWet(matGround, { x: 0.35, y: 0.9, z: 0.35, w: 1.25 });
  patchWet(matFar, { x: 0, y: 1, z: 0.3, w: 1.1 });

  const pbrState = { pending: 0, loaded: 0, failed: 0 };
  function loadPBR(name, onReady) {
    if (typeof document === 'undefined' || !THREE.TextureLoader) return;
    const loader = new THREE.TextureLoader();
    const out = {};
    let left = 3, bad = false;
    pbrState.pending++;
    for (const kind of ['diff', 'nor_gl', 'arm']) {
      let url;
      try { url = new URL(`../assets/polyhaven/${name}/${name}_${kind}_1k.jpg`, import.meta.url).href; } catch (e) { url = `assets/polyhaven/${name}/${name}_${kind}_1k.jpg`; }
      loader.load(url, (t) => {
        if (disposed) { t.dispose(); return; }
        if (kind === 'diff') t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, maxAniso || 1);
        out[kind] = T(t);
        if (--left === 0 && !bad) { onReady(out); pbrState.pending--; pbrState.loaded++; }
      }, undefined, () => {
        if (!bad) { bad = true; pbrState.pending--; pbrState.failed++; }
        console.warn('[world] не загрузилась текстура', name, kind, '— остаётся процедурная');
      });
    }
  }
  function applyPBR(mat, t, { normal = 1, ao = 1, keepBump = false } = {}) {
    mat.map = t.diff;
    mat.normalMap = t.nor_gl;
    mat.normalScale = new THREE.Vector2(normal, normal);
    mat.roughnessMap = t.arm;
    mat.aoMap = t.arm;
    mat.aoMapIntensity = ao;
    if (!keepBump) mat.bumpMap = null;
    mat.color.setRGB(1, 1, 1);
    mat.needsUpdate = true;
  }
  loadPBR('dark_rock_02', (t) => {
    applyPBR(matFloor, t, { normal: 0.85 });
    applyPBR(matStone, t, { normal: 1 });
    applyPBR(matStoneFlat, t, { normal: 1 });
    applyPBR(matSigilSide, t, { normal: 0.8 });
    matFloor.roughness = 1; matStone.roughness = 1; matStoneFlat.roughness = 1; matSigilSide.roughness = 1;
    applyTerrainPBR(t);
  });
  loadPBR('monastery_stone_floor', (t) => { applyPBR(matGround, t, { normal: 0.9, ao: 0.8 }); matGround.roughness = 1; terrainU.tPave.value = t.diff; });
  // [ASHEN_V3] земля большой карты: трипланарный альбедо камня + нормали/шероховатость по плоской UV
  function applyTerrainPBR(t) {
    terrainU.tRock.value = t.diff;
    matTerrain.normalMap = t.nor_gl;
    matTerrain.normalScale = new THREE.Vector2(0.85, 0.85);
    matTerrain.roughnessMap = t.arm;
    matTerrain.roughness = 1;
    matTerrain.needsUpdate = true;
  }

  /* ------------------------------ Пол арены ------------------------------ */
  const FLOOR_UV = 3.2; // метров на повтор текстуры
  function buildFloor() {
    const pos = [], nor = [], uv = [], col = [], idx = [];
    const rnd = mulberry32(wc.seed + 101);
    const quad = (p, n, uvs, c) => {
      const b = pos.length / 3;
      // ориентация по нормали
      const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
      const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
      for (let i = 0; i < 4; i++) { pos.push(p[i][0], p[i][1], p[i][2]); nor.push(n[0], n[1], n[2]); uv.push(uvs[i][0], uvs[i][1]); col.push(c[0], c[1], c[2]); }
      if (flip) idx.push(b, b + 2, b + 1, b, b + 3, b + 2); else idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const GAP = 0.035;
    const rings = [
      { r0: 3.3, r1: 5.3, y: 0.0, seg: 14, drop: 0.32, broken: 0.1 },
      { r0: 5.3, r1: 7.45, y: 0.0, seg: 20, drop: 0.32, broken: 0.12 },
      { r0: 7.45, r1: 9.65, y: 0.0, seg: 26, drop: 0.32, broken: 0.14 },
      { r0: 9.65, r1: 10.9, y: 0.03, seg: 30, drop: 0.36, broken: 0.05, curb: true },
      { r0: 10.9, r1: 11.6, y: -0.3, seg: 34, drop: 0.34, broken: 0.16, missing: 0.04 },
      { r0: 11.6, r1: 12.3, y: -0.6, seg: 36, drop: 0.34, broken: 0.22, missing: 0.07 },
      { r0: 12.3, r1: 13.0, y: -0.9, seg: 38, drop: 0.2, broken: 0.28, missing: 0.1 },
    ];
    for (const ring of rings) {
      const r0 = ring.r0 * K, r1 = ring.r1 * K;
      // подложка-«шов» под плитами
      {
        const steps = 96;
        for (let s = 0; s < steps; s++) {
          const a0 = (s / steps) * TAU, a1 = ((s + 1) / steps) * TAU, yy = ring.y - 0.05;
          quad([[Math.sin(a0) * r0, yy, Math.cos(a0) * r0], [Math.sin(a0) * r1, yy, Math.cos(a0) * r1], [Math.sin(a1) * r1, yy, Math.cos(a1) * r1], [Math.sin(a1) * r0, yy, Math.cos(a1) * r0]],
            [0, 1, 0], [[0, 0], [0, 0], [0, 0], [0, 0]], [0.16, 0.16, 0.17]);
        }
      }
      for (let i = 0; i < ring.seg; i++) {
        if (ring.missing && rnd() < ring.missing) continue;
        const rm = (r0 + r1) / 2;
        const gapA = GAP / rm;
        const a0 = (i / ring.seg) * TAU + gapA / 2 + (rnd() - 0.5) * 0.006;
        const a1 = ((i + 1) / ring.seg) * TAU - gapA / 2;
        const ri = r0 + GAP / 2, ro = r1 - GAP / 2;
        const broken = rnd() < ring.broken;
        const h = ring.y + (rnd() - 0.5) * 0.022 - (broken ? 0.025 + rnd() * 0.04 : 0);
        const tx = (rnd() - 0.5) * (broken ? 0.05 : 0.008), tz = (rnd() - 0.5) * (broken ? 0.05 : 0.008);
        const am = (a0 + a1) / 2;
        const cxm = Math.sin(am) * rm, czm = Math.cos(am) * rm;
        const hy = (x, z) => h + tx * (x - cxm) + tz * (z - czm);
        const nl = Math.hypot(tx, 1, tz);
        const n = [-tx / nl, 1 / nl, -tz / nl];
        let tint = 0.8 + rnd() * 0.24;
        if (ring.curb) tint *= 0.86;
        if (broken) tint *= 0.88;
        const warm = (rnd() - 0.5) * 0.08;
        const c = [tint * (1 + warm), tint, tint * (1 - warm)];
        const cs = [c[0] * 0.62, c[1] * 0.62, c[2] * 0.64];
        const uo = rnd() * 7, vo = rnd() * 7;
        const steps = Math.max(2, Math.ceil(((a1 - a0) * ro) / 0.45));
        const bot = ring.y - ring.drop;
        for (let s = 0; s < steps; s++) {
          const aa = a0 + ((a1 - a0) * s) / steps, ab = a0 + ((a1 - a0) * (s + 1)) / steps;
          const P = (a, r) => { const x = Math.sin(a) * r, z = Math.cos(a) * r; return [x, hy(x, z), z]; };
          const p0 = P(aa, ri), p1 = P(aa, ro), p2 = P(ab, ro), p3 = P(ab, ri);
          const U = (p) => [p[0] / FLOOR_UV + uo, p[2] / FLOOR_UV + vo];
          quad([p0, p1, p2, p3], n, [U(p0), U(p1), U(p2), U(p3)], c);
          // внешняя и внутренняя грань (ступени читаются рёбрами)
          const oN = [Math.sin((aa + ab) / 2), 0, Math.cos((aa + ab) / 2)];
          const SU = (a, r, y) => [(a * r) / FLOOR_UV + uo, y / FLOOR_UV];
          quad([p1, [p1[0], bot, p1[2]], [p2[0], bot, p2[2]], p2], oN, [SU(aa, ro, p1[1]), SU(aa, ro, bot), SU(ab, ro, bot), SU(ab, ro, p2[1])], cs);
          quad([p0, p3, [p3[0], h - 0.12, p3[2]], [p0[0], h - 0.12, p0[2]]], [-oN[0], 0, -oN[2]], [SU(aa, ri, p0[1]), SU(ab, ri, p3[1]), SU(ab, ri, h - 0.12), SU(aa, ri, h - 0.12)], cs);
        }
        // торцы плиты в швах
        for (const [aE, sgn] of [[a0, -1], [a1, 1]]) {
          const tN = [Math.cos(aE) * sgn, 0, -Math.sin(aE) * sgn];
          const P = (r) => { const x = Math.sin(aE) * r, z = Math.cos(aE) * r; return [x, hy(x, z), z]; };
          const pi = P(ri), po = P(ro);
          quad([pi, po, [po[0], h - 0.1, po[2]], [pi[0], h - 0.1, pi[2]]], tN, [[0, 0], [0.3, 0], [0.3, 0.05], [0, 0.05]], cs);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return G(g);
  }
  const floor = new THREE.Mesh(buildFloor(), matFloor);
  floor.name = 'arena-floor';
  floor.receiveShadow = true;
  env.add(floor);

  // Центральная печать
  const sigil = new THREE.Mesh(G(new THREE.CylinderGeometry(3.22 * K, 3.26 * K, 0.16, 72, 1)), [matSigilSide, matSigilTop, matSigilSide]);
  sigil.position.y = 0.02 - 0.08;
  sigil.rotation.y = 0.3;
  sigil.receiveShadow = true;
  sigil.name = 'oath-sigil';
  env.add(sigil);
  // Золотая инкрустация по границе арены (с разрывами)
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * TAU + 0.1, len = TAU / 6 - 0.16 - (i % 2) * 0.08;
    const ring = new THREE.Mesh(G(new THREE.RingGeometry((wc.arenaRadius - 0.04) * 1, (wc.arenaRadius + 0.05) * 1, 48, 1, a0, len)), matGold);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.052;
    ring.receiveShadow = true;
    env.add(ring);
  }
  // Светящиеся трещины от печати (аддитивная декаль)
  const floorCracks = new THREE.Mesh(G(new THREE.RingGeometry(3.24 * K, 9.4 * K, 96, 1)), matFloorCracks);
  floorCracks.rotation.x = -Math.PI / 2;
  floorCracks.position.y = 0.034;
  floorCracks.renderOrder = 2;
  env.add(floorCracks);
  {
    // RingGeometry даёт плоские UV в диапазоне внешнего радиуса — они совпадают с раскладкой канваса
    const uvA = floorCracks.geometry.attributes.uv, pA = floorCracks.geometry.attributes.position;
    const R = 9.4 * K;
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, pA.getX(i) / (2 * R) + 0.5, pA.getY(i) / (2 * R) + 0.5);
    uvA.needsUpdate = true;
  }

  /* ----------------------- Внешняя земля и дальний план ----------------------- */
  // Плато обрывается в море тумана (Библия, разд. 2); к святилищу уходит широкий отрог.
  const SHRINE_AZ = 150;
  const EDGE = { base: 41, spur: 74, az: deg(SHRINE_AZ), w: 0.6 };
  function plateauEdge(a) {
    const da = wrapAngle(a - EDGE.az);
    const spur = Math.exp(-(da * da) / (EDGE.w * EDGE.w));
    const jag = (noise.fbm((a / TAU + 0.5) * 18, 4.4, 18, 3) - 0.5) * 8;
    return (lerp(EDGE.base, EDGE.spur, spur) + jag) * K;
  }
  /* ---------------- [ASHEN_V3] Большая карта 500×500 м: рельеф, зоны, дороги ---------------- */
  // Плато арены в центре — прежнее (coreY). За его краем земля не обрывается, а уходит холмами и
  // долинами до края мира — суперэллипса |x|^4+|z|^4 ≈ 238^4 (квадрат 500×500 со скруглёнными
  // углами), где скальный вал обрывается в море тумана. Одна функция terrainH кормит и видимую
  // землю, и раскладку боя (IK стоп, проходимость, высота героя).
  const WORLD_EDGE = 238;
  const LAKE_WL = -2.6;             // уровень воды Зеркального озера
  const ZONES = {
    city:   { id: 'city',   name: 'Нижний город',      x: 96,   z: 96,   r: 50 },
    forest: { id: 'forest', name: 'Пепельный лес',     x: -142, z: 4,    r: 72 },
    lake:   { id: 'lake',   name: 'Зеркальное озеро',  x: -80,  z: 110,  r: 30 },
    graves: { id: 'graves', name: 'Кладбище колоссов', x: 140,  z: -95,  r: 46 },
    hill:   { id: 'hill',   name: 'Холм клятвы',       x: -95,  z: -140, r: 14, top: 22 },
    gate:   { id: 'gate',   name: 'Павшие врата',      x: 0,    z: 214,  r: 16 },
  };
  const LAKE_ISLAND = { x: -72.9, z: 100.3, r: 5 };
  const LAKE_SHORE = { x: -61.8, z: 84.9 };
  // Дороги от арены к зонам: на полосе земля без складок и вымощена (текстура плит).
  const ROADS = [
    [[20, 22], [50, 52], [72, 74], [96, 96]],                          // → Нижний город
    [[-24, 6], [-44, 4], [-80, -6], [-112, 4], [-142, 4]],             // → Пепельный лес
    [[-22, 26], [-44, 56], [-58, 78], [LAKE_SHORE.x, LAKE_SHORE.z]],    // → Зеркальное озеро
    [[18, -14], [52, -22], [80, -55], [110, -80], [140, -95]],         // → Кладбище колоссов
    [[-14, -40], [-50, -70], [-72, -102], [-88, -126], [-95, -140]],   // → Холм клятвы
    [[0, 36], [4, 90], [-4, 150], [0, 230]],                           // → Павшие врата
    [[96, 96], [138, 46], [152, -20], [140, -95]],                     // город ↔ кладбище
    [[-142, 4], [-122, 50], [-100, 85]],                               // лес ↔ озеро
  ];
  const ROAD_HW = 1.9;
  const roadSegs = [];
  for (const pl of ROADS) for (let i = 0; i + 1 < pl.length; i++) {
    const [ax, az] = pl[i], [bx, bz] = pl[i + 1];
    const ex = bx - ax, ez = bz - az;
    roadSegs.push({ ax, az, ex, ez, L2: ex * ex + ez * ez || 1,
      x0: Math.min(ax, bx) - 8, x1: Math.max(ax, bx) + 8, z0: Math.min(az, bz) - 8, z1: Math.max(az, bz) + 8 });
  }
  function roadDist(x, z) {
    let best = 99;
    for (let i = 0; i < roadSegs.length; i++) {
      const s = roadSegs[i];
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const u = clamp(((x - s.ax) * s.ex + (z - s.az) * s.ez) / s.L2, 0, 1);
      const d = Math.hypot(x - s.ax - s.ex * u, z - s.az - s.ez * u);
      if (d < best) best = d;
    }
    return best;
  }
  const edgeJag = (a) => (noise.fbm((a / TAU + 0.5) * 32, 9.7, 32, 3) - 0.5) * 16;
  const superF = (a) => { const s = Math.sin(a), c = Math.cos(a); return Math.sqrt(Math.sqrt(s * s * s * s + c * c * c * c)); };
  // >0 — внутри мира (м до кромки обрыва), <0 — за краем
  function edgeDist(x, z) {
    const x2 = x * x, z2 = z * z;
    return WORLD_EDGE + edgeJag(Math.atan2(x, z)) - Math.sqrt(Math.sqrt(x2 * x2 + z2 * z2));
  }
  // точка на расстоянии off от кромки по азимуту a
  function edgePoint(a, off) {
    const rr = (WORLD_EDGE + edgeJag(a) - off) / superF(a);
    return { x: Math.sin(a) * rr, z: Math.cos(a) * rr };
  }
  // Прежнее плато (V1/V2): волны у колонн, ровно у арены.
  function coreY(x, z, r, a) {
    const hill = smoothstep(18, 36, r) * (noise.fbm((a / TAU + 0.5) * 12, r * 0.05, 12, 4) * 3.2 - 1.1);
    return -1.0 + Math.max(-0.5, hill) + (noise.n2(x * 0.4, z * 0.4, 0) - 0.5) * 0.18 * smoothstep(13, 16, r);
  }
  const smax = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(a, b, h) + k * h * (1 - h); };
  const segDist = (x, z, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, u = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1), 0, 1);
    return Math.hypot(x - ax - ex * u, z - az - ez * u);
  };
  function terrainH(x, z) {
    const r = Math.hypot(x, z);
    const wRoad = smoothstep(ROAD_HW + 4, ROAD_HW, roadDist(x, z));
    // крупные холмы и складки; складки дорога срезает (мелких нет — сетка земли их не передаст)
    let y = -1.5 + (noise.fbm(x / 120 + 31.7, z / 120 + 11.3, 0, 4) - 0.5) * 30;
    y += (noise.fbm(x / 30 + 71.1, z / 30 + 5.3, 0, 2) - 0.5) * 6 * (1 - wRoad * 0.9);
    const Z = ZONES;
    let d, w;
    d = Math.hypot(x - Z.city.x, z - Z.city.z);
    if (d < Z.city.r + 26) { w = smoothstep(Z.city.r + 26, Z.city.r, d); y = lerp(y, -2, w); }
    d = Math.hypot(x - Z.graves.x, z - Z.graves.z);
    if (d < Z.graves.r + 34) { w = smoothstep(Z.graves.r + 34, Z.graves.r, d); y = lerp(y, -5 + (noise.fbm(x / 14, z / 14, 0, 2) - 0.5) * 2.2, w); }
    d = Math.hypot(x - Z.gate.x, z - Z.gate.z);
    if (d < Z.gate.r + 24) { w = smoothstep(Z.gate.r + 24, Z.gate.r, d); y = lerp(y, -1, w); }
    d = Math.hypot(x - Z.hill.x, z - Z.hill.z);
    if (d < 130) y = smax(y, Z.hill.top - Math.max(0, d - Z.hill.r) * 0.4, 5);
    const L = Z.lake;
    d = Math.hypot(x - L.x, z - L.z);
    if (d < L.r + 30) {
      const q = d / L.r;
      const bowl = d < L.r ? LAKE_WL - 3.4 + 4.0 * q * q : LAKE_WL + 0.6 + (d - L.r) * 0.12;
      y = lerp(y, bowl, smoothstep(L.r + 30, L.r + 3, d));
      const di = Math.hypot(x - LAKE_ISLAND.x, z - LAKE_ISLAND.z);
      if (di < 14) y = Math.max(y, LAKE_WL + 0.9 - Math.max(0, di - LAKE_ISLAND.r) * 0.8);
      const dc = segDist(x, z, LAKE_SHORE.x, LAKE_SHORE.z, LAKE_ISLAND.x, LAKE_ISLAND.z);
      if (dc < 6) y = Math.max(y, LAKE_WL + 0.32 - Math.max(0, dc - 1.4) * 1.2);
    }
    // край мира: скальный вал и обрыв в море тумана
    const ed = edgeDist(x, z);
    if (ed < 18) {
      y += 3.4 * smoothstep(18, 5, ed) * (0.55 + 0.9 * noise.n2(x * 0.09, z * 0.09, 0));
      if (ed < 5) y = lerp(y, -58 + (noise.n2(x * 0.05, z * 0.05, 0) - 0.5) * 14, smoothstep(5, -9, ed));
    }
    // плато арены — как было
    if (r < 112) {
      const a = Math.atan2(x, z);
      const wCore = 1 - smoothstep(plateauEdge(a) - 4, plateauEdge(a) + 26, r);
      if (wCore > 0) y = lerp(y, coreY(x, z, r, a), wCore);
    }
    return y;
  }
  function groundY(x, z) {
    return { y: terrainH(x, z), cliff: smoothstep(7, -2, edgeDist(x, z)) };
  }
  function inDeepWater(x, z) {
    const L = ZONES.lake;
    return Math.hypot(x - L.x, z - L.z) < L.r + 1 && terrainH(x, z) < LAKE_WL - 0.45;
  }
  // городская сетка: локальные оси (u — поперёк, v — от арены)
  const CITY_TH = Math.PI / 4;
  const CITY_EX = { x: Math.cos(CITY_TH), z: -Math.sin(CITY_TH) }, CITY_EZ = { x: Math.sin(CITY_TH), z: Math.cos(CITY_TH) };
  const cityUV = (x, z) => { const dx = x - ZONES.city.x, dz = z - ZONES.city.z; return [dx * CITY_EX.x + dz * CITY_EX.z, dx * CITY_EZ.x + dz * CITY_EZ.z]; };
  const cityW = (u, v) => ({ x: ZONES.city.x + CITY_EX.x * u + CITY_EZ.x * v, z: ZONES.city.z + CITY_EX.z * u + CITY_EZ.z * v });

  // Материал земли: трипланар по камню (склоны без растяжки), плиты на дорогах и в городе,
  // крупные пятна против повтора, лужи на ровном (как на полу арены).
  const terrainU = { tRock: { value: texStone }, tPave: { value: texFloor }, ashWet: { value: { x: 0.5, y: 1, z: 0.42, w: 1.75 } } };
  const matTerrain = M(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.96, metalness: 0 }));
  matTerrain.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPave;\nvarying float vPave;\nvarying vec3 vAshWorldPos;\nvarying vec3 vTerN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vAshWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vTerN = normalize( mat3( modelMatrix ) * objectNormal );\n  vPave = aPave;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WET_GLSL + '\nuniform sampler2D tRock;\nuniform sampler2D tPave;\nvarying float vPave;\nvarying vec3 vTerN;')
      .replace('#include <map_fragment>', `
  vec3 ashTN = normalize( vTerN );
  vec3 ashBW = pow( abs( ashTN ), vec3( 4.0 ) ); ashBW /= ( ashBW.x + ashBW.y + ashBW.z );
  vec3 ashP = vAshWorldPos * 0.25;
  vec3 ashRock;
  if ( ashBW.y > 0.985 ) ashRock = texture2D( tRock, ashP.xz ).rgb;          // ровная земля — одна выборка
  else ashRock = texture2D( tRock, ashP.zy ).rgb * ashBW.x + texture2D( tRock, ashP.xz ).rgb * ashBW.y + texture2D( tRock, ashP.xy ).rgb * ashBW.z;
  float ashDist = length( vAshWorldPos - cameraPosition );
  float ashMac = ashWN( vAshWorldPos.xz * 0.043 ) * 0.62 + ashWN( vAshWorldPos.xz * 0.17 + 3.1 ) * 0.38;
  ashRock *= 0.72 + 0.56 * ashMac;
  float ashFlat = smoothstep( 0.55, 0.86, ashTN.y );
  float ashPw = clamp( vPave, 0.0, 1.0 ) * ashFlat;
  vec3 ashCol = ashRock;
  if ( ashPw > 0.004 ) ashCol = mix( ashRock, texture2D( tPave, vAshWorldPos.xz * 0.3125 ).rgb, ashPw );
  float ashLum = dot( ashCol, vec3( 0.2126, 0.7152, 0.0722 ) );
  ashCol = mix( vec3( ashLum ), ashCol, ashWet.z ) * ashWet.w;
  float ashPud = 0.0;                                                          // лужи — только вблизи
  if ( ashDist < 75.0 ) ashPud = ashPuddle( vAshWorldPos.xz ) * ashWet.x * ashFlat * ( 0.45 + 0.55 * ashPw ) * ( 1.0 - smoothstep( 50.0, 75.0, ashDist ) );
  ashCol *= mix( 1.0, 0.45, ashPud );
  diffuseColor.rgb *= ashCol;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor * ashWet.y, 0.2, ashPud );`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize( mix( normal, nonPerturbedNormal, ashPud * 0.92 ) );`);
  };
  matTerrain.customProgramCacheKey = () => 'ashTerrain';

  const TERRAIN_R0 = 12.95 * K, TERRAIN_R1 = 305;
  function paveAt(x, z, rd) {
    const brk = smoothstep(0.18, 0.4, noise.n2(x * 0.23 + 3.3, z * 0.23 + 9.1, 0));
    let p = smoothstep(ROAD_HW + 0.5, ROAD_HW - 0.7, rd);
    const [u, v] = cityUV(x, z);
    if (Math.abs(u) < 47 && Math.abs(v) < 47) p = Math.max(p, 0.9);
    if (Math.hypot(x - ZONES.hill.x, z - ZONES.hill.z) < 12) p = Math.max(p, 1);
    if (Math.hypot(x - ZONES.gate.x, z - ZONES.gate.z) < 20) p = Math.max(p, 0.85);
    return p * brk;
  }
  {
    const NA = initialQuality === 'low' ? 384 : 512;
    const rings = [];
    for (let r = TERRAIN_R0; ;) { rings.push(r); if (r >= TERRAIN_R1) break; r += Math.max(0.5, r * TAU / NA); }
    const NR = rings.length, NV = NR * NA;
    const pos = new Float32Array(NV * 3), uv = new Float32Array(NV * 2), col = new Float32Array(NV * 3), pave = new Float32Array(NV);
    for (let i = 0; i < NR; i++) {
      const r = rings[i];
      for (let j = 0; j < NA; j++) {
        const a = ((j + (i & 1) * 0.5) / NA) * TAU;
        const x = Math.sin(a) * r, z = Math.cos(a) * r, k = i * NA + j;
        const y = terrainH(x, z);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 4; uv[k * 2 + 1] = z / 4;
        const rd = roadDist(x, z);
        pave[k] = paveAt(x, z, rd);
        // пепельный тон, лес темнее и холоднее, у колоссов теплее, у воды мокрее
        let v0 = lerp(0.95, 0.78, smoothstep(14, 60, r)) * (0.82 + noise.n2(x * 0.07, z * 0.07, 0) * 0.36);
        let cr = 1, cg = 0.985, cb = 0.965;
        const fF = smoothstep(ZONES.forest.r + 14, ZONES.forest.r - 16, Math.hypot(x - ZONES.forest.x, z - ZONES.forest.z));
        v0 *= lerp(1, 0.62, fF); cr -= 0.05 * fF; cb += 0.02 * fF;
        const fG = smoothstep(ZONES.graves.r + 20, ZONES.graves.r - 10, Math.hypot(x - ZONES.graves.x, z - ZONES.graves.z));
        cr += 0.06 * fG; cb -= 0.07 * fG;
        const dl = Math.hypot(x - ZONES.lake.x, z - ZONES.lake.z) - ZONES.lake.r;
        v0 *= lerp(1, 0.62, smoothstep(6, -2, dl));
        const ed = edgeDist(x, z);
        v0 *= lerp(1, 0.7, smoothstep(6, -6, ed));
        col[k * 3] = v0 * cr; col[k * 3 + 1] = v0 * cg; col[k * 3 + 2] = v0 * cb;
      }
    }
    const idx = new Uint32Array((NR - 1) * NA * 6);
    let o = 0;
    for (let i = 0; i < NR - 1; i++) for (let j = 0; j < NA; j++) {
      const a = i * NA + j, b = i * NA + (j + 1) % NA, c = (i + 1) * NA + j, d = (i + 1) * NA + (j + 1) % NA;
      if (i & 1) { idx[o++] = a; idx[o++] = b; idx[o++] = d; idx[o++] = a; idx[o++] = d; idx[o++] = c; }
      else { idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aPave', new THREE.BufferAttribute(pave, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    // обход треугольников должен давать нормаль вверх
    if (g.attributes.normal.getY(NA * 4) < 0) {
      for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
      g.index.needsUpdate = true;
      g.computeVertexNormals();
    }
    // обрывы и склоны темнее
    const nA = g.attributes.normal;
    for (let k = 0; k < NV; k++) { const s = lerp(0.62, 1, smoothstep(0.45, 0.9, nA.getY(k))); col[k * 3] *= s; col[k * 3 + 1] *= s; col[k * 3 + 2] *= s; }
    g.computeBoundingSphere();
    const ground = new THREE.Mesh(G(g), matTerrain);
    ground.receiveShadow = true;
    ground.name = 'outer-ground';
    env.add(ground);
  }

  // Зеркальное озеро: глянцевая вода отражает небо затмения (IBL), рябь — в шейдере.
  const waterU = { uWT: { value: 0 } };
  const matWater = M(new THREE.MeshPhysicalMaterial({ color: 0x0a1016, roughness: 0.04, metalness: 0, ior: 1.33, specularIntensity: 1 }));
  matWater.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, waterU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vWWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWT;\nvarying vec3 vWWorld;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    vec2 wp = vWWorld.xz; float t = uWT;
    vec2 wg = vec2( sin( wp.x * 1.7 + t * 1.3 ) + 0.6 * sin( wp.y * 2.3 - t * 0.9 + wp.x * 0.7 ) + 0.3 * sin( ( wp.x + wp.y ) * 4.1 + t * 2.1 ),
                    cos( wp.y * 1.9 + t * 1.1 ) + 0.5 * cos( wp.x * 2.7 - t * 1.4 - wp.y * 0.5 ) + 0.3 * cos( ( wp.x - wp.y ) * 3.7 - t * 1.8 ) ) * 0.028;
    normal = normalize( normal + ( viewMatrix * vec4( wg.x, 0.0, wg.y, 0.0 ) ).xyz );
  }`);
  };
  matWater.customProgramCacheKey = () => 'ashWater';
  atmo.useEnv(matWater, 2.4);
  {
    const wg = new THREE.CircleGeometry(ZONES.lake.r + 4, 72);
    wg.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(G(wg), matWater);
    water.position.set(ZONES.lake.x, LAKE_WL, ZONES.lake.z);
    water.receiveShadow = true;
    water.name = 'mirror-lake';
    env.add(water);
  }

  // Хребты-силуэты: два кольца, туман разводит их по глубине.
  function ridge(radius, count, baseY, hMin, hMax, color, seed) {
    const pos = [], idx = [];
    const nz = makeNoise(seed);
    for (let i = 0; i <= count; i++) {
      const u = i / count, a = u * TAU;
      let h = hMin + (hMax - hMin) * nz.fbm(u * 9, 0.5, 9, 5);
      const spike = nz.n2(u * 40, 3.3, 40);
      if (spike > 0.83) h += (spike - 0.83) * 60;
      const r = radius * (1 + (nz.n2(u * 20, 7.1, 20) - 0.5) * 0.08);
      pos.push(Math.sin(a) * r, baseY, Math.cos(a) * r, Math.sin(a) * r, h, Math.cos(a) * r);
      if (i < count) { const b = i * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(G(g), M(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: true })));
    m.frustumCulled = false;
    env.add(m);
    return m;
  }
  ridge(skyR * 0.8, 260, -40, 22, 58, 0x1a202b, wc.seed + 112);

  /* --------------------------- Руины: колонны --------------------------- */
  const shaftGeo = (() => {
    const g = new THREE.CylinderGeometry(1, 1.06, 1, 32, 6, false);
    g.translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
      const r = Math.hypot(x, z);
      if (r < 0.5) continue;
      const a = Math.atan2(x, z);
      const k = 1 - 0.055 * Math.pow(0.5 + 0.5 * Math.cos(a * 14), 2) - (hash3(Math.round(a * 6), Math.round(y * 5), 0, 3) - 0.5) * 0.04;
      p.setX(i, (x / r) * r * k);
      p.setZ(i, (z / r) * r * k);
    }
    g.computeVertexNormals();
    boxProjectUV(g, 1.4);
    // для цилиндра лучше цилиндрическая развёртка боковины
    const uvA = g.attributes.uv, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) if (Math.abs(n.getY(i)) < 0.5) uvA.setXY(i, (Math.atan2(p.getX(i), p.getZ(i)) / TAU + 0.5) * 3, p.getY(i) * 3);
    return G(g);
  })();
  const brokenTopGeo = (() => {
    const g = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
    g.translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0.9) {
        const x = p.getX(i), z = p.getZ(i);
        const a = Math.atan2(x, z);
        const r = Math.hypot(x, z);
        const jag = r > 0.5 ? 0.15 + hash3(Math.round(a * 30), 1, 2, 9) * 0.85 * (0.6 + 0.4 * Math.sin(a * 2)) : 0.4;
        p.setY(i, jag);
      }
    }
    g.computeVertexNormals();
    boxProjectUV(g, 1.4);
    return G(g);
  })();
  const capitalGeo = (() => {
    const ech = lathe([[1.0, 0], [1.12, 0.08], [1.3, 0.22], [1.42, 0.34], [1.45, 0.4], [0.0005, 0.4]], 28);
    const aba = chiseled(3.1, 0.34, 3.1, { bevel: 0.05, jitter: 0.03, seed: 5 });
    aba.translate(0, 0.57, 0);
    const g = mergeGeos([ech, aba]);
    boxProjectUV(g, 1.4);
    return G(g);
  })();
  const plinthGeo = (() => { const g = chiseled(1, 1, 1, { bevel: 0.08, jitter: 0.03, seed: 11 }); g.translate(0, 0.5, 0); boxProjectUV(g, 1.4); return G(g); })();
  const blockGeo = (() => { const g = chiseled(1, 1, 1, { bevel: 0.07, jitter: 0.04, seed: 17 }); boxProjectUV(g, 1.2); return G(g); })();

  const shafts = [], tops = [], caps = [], plinths = [], blocks = [];
  const GROUND_Y = -1.0;
  const stoneTint = (rnd, k = 1) => { const v = (0.86 + rnd() * 0.22) * k; return new THREE.Color(v * 1.02, v, v * 0.97); };
  function column(aDeg, r, type, h, tier, rnd) {
    const base = polar(aDeg, r * K, GROUND_Y);
    const rad = 0.62 + rnd() * 0.1;
    const yaw = rnd() * TAU;
    const lean = type === 'tall' ? 0 : (rnd() - 0.5) * 0.06;
    const tint = stoneTint(rnd);
    addCircle(base.x, base.z, rad * 1.32);
    plinths.push(instItem(base, { y: yaw }, { x: rad * 2.5, y: 0.7, z: rad * 2.5 }, tier, tint));
    if (type === 'fallen') {
      // стоящий обрубок + лежащие барабаны
      shafts.push(instItem(base.clone().setY(GROUND_Y + 0.7), { x: lean, y: yaw }, { x: rad, y: 1.1, z: rad }, tier, tint));
      tops.push(instItem(base.clone().setY(GROUND_Y + 1.8), { y: yaw }, { x: rad, y: 0.45, z: rad }, tier, tint));
      const dir = deg(aDeg) + (rnd() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rnd() - 0.5) * 0.6);
      let d = 1.6;
      for (let k2 = 0; k2 < 3; k2++) {
        const len = 1.6 + rnd() * 0.9;
        const c = base.clone().add(new THREE.Vector3(Math.sin(dir) * (d + len / 2), 0, Math.cos(dir) * (d + len / 2)));
        c.y = GROUND_Y + rad * 0.92;
        { const ux = Math.sin(dir), uz = Math.cos(dir); addSegment(c.x - ux * len / 2, c.z - uz * len / 2, c.x + ux * len / 2, c.z + uz * len / 2, rad); }
        const it = instItem(new THREE.Vector3(0, 0, 0), {}, { x: rad, y: len, z: rad }, tier, tint);
        // цилиндр лёжа: ось Y -> горизонталь по dir
        const m = new THREE.Matrix4().makeTranslation(0, -len / 2, 0);
        const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(Math.PI / 2 + (rnd() - 0.5) * 0.2, dir + (rnd() - 0.5) * 0.25, 0, 'YXZ'));
        it.m = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(rot).multiply(m).multiply(new THREE.Matrix4().makeScale(rad, len, rad));
        shafts.push(it);
        d += len + 0.25 + rnd() * 0.5;
      }
      return;
    }
    shafts.push(instItem(base.clone().setY(GROUND_Y + 0.7), { x: lean, y: yaw, z: lean * 0.7 }, { x: rad, y: h, z: rad }, tier, tint));
    const topY = GROUND_Y + 0.7 + h;
    if (type === 'tall') {
      caps.push(instItem(base.clone().setY(topY), { y: yaw }, { x: rad, y: 1, z: rad }, tier, tint));
    } else {
      const tp = base.clone().setY(topY - 0.02);
      tp.x += Math.sin(lean) * h * 0.5; // учёт наклона — примерно
      tops.push(instItem(tp, { x: lean, y: yaw, z: lean * 0.7 }, { x: rad * 0.995, y: 0.35 + rnd() * 0.5, z: rad * 0.995 }, tier, tint));
    }
  }
  {
    const rnd = mulberry32(wc.seed + 121);
    const primary = [
      [148, 18.0, 'tall', 9.2], [163, 17.6, 'tall', 9.0], [197, 17.6, 'broken', 5.2], [212, 18.2, 'tall', 8.6],
      [128, 17.2, 'stump', 1.3], [108, 18.6, 'tall', 9.6], [88, 18.0, 'broken', 6.4], [70, 17.4, 'fallen', 0],
      [50, 18.2, 'broken', 3.8], [30, 18.8, 'tall', 8.8], [10, 17.6, 'stump', 1.9], [348, 18.0, 'broken', 4.6],
      [330, 18.6, 'tall', 9.1], [310, 17.2, 'fallen', 0], [290, 18.2, 'broken', 7.1], [252, 18.4, 'tall', 9.0],
      [236, 17.4, 'stump', 1.1], [232, 18.8, 'broken', 2.6],
    ];
    for (const [a, r, t, h] of primary) column(a, r, t, h, 0, rnd);
    for (let i = 0; i < 14; i++) {
      const a = i * 25.7 + rnd() * 10;
      if (Math.abs(wrapAngle(deg(a - 180))) < deg(12)) continue; // коридор к порталу
      const types = ['tall', 'broken', 'broken', 'stump'];
      const t = types[(rnd() * types.length) | 0];
      column(a, 27 + rnd() * 6, t, t === 'tall' ? 8 + rnd() * 3 : 2 + rnd() * 5, i % 2 === 0 ? 1 : 2, rnd);
    }
    // Архитравы на парах целых колонн
    const lintel = (aA, aB, r, y, tier, brokenFall) => {
      const pA = polar(aA, r * K), pB = polar(aB, r * K);
      const mid = pA.clone().add(pB).multiplyScalar(0.5);
      const len = pA.distanceTo(pB) + 1.6;
      const yaw = Math.atan2(pB.x - pA.x, pB.z - pA.z) + Math.PI / 2;
      if (!brokenFall) blocks.push(instItem(mid.setY(y), { y: yaw }, { x: len, y: 0.95, z: 1.3 }, tier, stoneTint(rnd, 0.95)));
      else blocks.push(instItem(mid.setY(GROUND_Y + 1.6), { y: yaw, z: 0.5, order: 'YXZ' }, { x: len, y: 0.95, z: 1.3 }, tier, stoneTint(rnd, 0.9)));
    };
    lintel(148, 163, 17.8, GROUND_Y + 0.7 + 9.0 + 0.4 + 0.72, 0, false);
    lintel(330, 348, 18.3, 0, 0, true);
    // Обломки: на земле, ступенях и у колонн
    const nR = 96;
    for (let i = 0; i < nR; i++) {
      const tier = i < 34 ? 0 : i < 64 ? 1 : 2;
      let a = rnd() * 360, r, y;
      const where = rnd();
      if (where < 0.18) { r = 11.0 + rnd() * 1.9; y = r < 11.6 ? -0.3 : r < 12.3 ? -0.6 : -0.9; }
      else { r = 13.3 + Math.pow(rnd(), 1.4) * 12; y = GROUND_Y; }
      const s = where < 0.18 ? 0.12 + rnd() * 0.22 : 0.18 + Math.pow(rnd(), 2) * 0.9;
      const p = polar(a, r * K, y + s * 0.35);
      if (s > 0.6) addCircle(p.x, p.z, s * 0.85);
      blocks.push(instItem(p, { x: rnd() * 0.6, y: rnd() * TAU, z: rnd() * 0.6 }, { x: s * (1.2 + rnd()), y: s * (0.6 + rnd() * 0.5), z: s * (1 + rnd()) }, tier, stoneTint(rnd, 0.85)));
    }
  }

  /* ------------------------------ Арки ------------------------------ */
  const keystones = [];
  function arch(aDeg, r, span, pierH, pierW, depth, thick, opts = {}) {
    const rnd = mulberry32(Math.round(aDeg * 13) + wc.seed);
    const base = polar(aDeg, r * K, GROUND_Y);
    const yaw = deg(aDeg);
    const world = new THREE.Matrix4().makeTranslation(base.x, base.y, base.z).multiply(new THREE.Matrix4().makeRotationY(yaw));
    const put = (lx, ly, lz, rz, sx, sy, sz, tier, list = blocks, geoOffsetY = 0) => {
      const loc = new THREE.Matrix4().makeTranslation(lx, ly, lz)
        .multiply(new THREE.Matrix4().makeRotationZ(rz))
        .multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
      if (geoOffsetY) loc.multiply(new THREE.Matrix4().makeTranslation(0, geoOffsetY, 0));
      list.push({ m: world.clone().multiply(loc), tier, color: stoneTint(rnd, 0.97) });
    };
    const half = span / 2 + pierW / 2;
    const hl = opts.brokenLeftH || pierH, hr = pierH;
    for (const side of [-1, 1]) addCircle(base.x + Math.cos(yaw) * half * side, base.z - Math.sin(yaw) * half * side, Math.max(pierW, depth) * 0.62);
    // опоры из крупных блоков
    for (const [side, hh] of [[-1, hl], [1, hr]]) {
      let y = 0;
      while (y < hh - 0.05) {
        const bh = Math.min(1.25 + rnd() * 0.4, hh - y);
        put(side * half + (rnd() - 0.5) * 0.06, y + bh / 2, 0, (rnd() - 0.5) * 0.015, pierW * (0.98 + rnd() * 0.05), bh, depth * (0.98 + rnd() * 0.04), 0);
        y += bh;
      }
      put(side * half, hh + 0.2, 0, 0, pierW * 1.18, 0.4, depth * 1.15, 0);
    }
    // вуссуары
    const rMid = span / 2 + thick / 2;
    const n = opts.blocks || 13;
    for (let i = 0; i < n; i++) {
      if (opts.missing && opts.missing.includes(i)) continue;
      const phi = Math.PI - ((i + 0.5) / n) * Math.PI;
      const key = i === (n >> 1);
      const lx = Math.cos(phi) * rMid, ly = pierH + 0.4 + Math.sin(phi) * rMid;
      const tl = ((Math.PI * rMid) / n) * 0.965;
      put(lx, ly, 0, phi - Math.PI / 2, tl * (key ? 1.25 : 1), thick * (key ? 1.25 : 1), depth * (key ? 1.08 : 1), 0);
      if (key && opts.rune) {
        const m = world.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly + 0.05, depth * 0.56));
        keystones.push(m);
      }
    }
    // упавшие камни у сломанной арки
    if (opts.missing) for (let i = 0; i < 5; i++) put(-half + 1 + rnd() * span, 0.35, (rnd() - 0.5) * 3 + (rnd() < 0.5 ? 2.2 : -2.2), rnd() * 0.8, 1.1, 0.7, depth * 0.8, 1);
  }
  arch(200, 25, 9.2, 8.2, 2.2, 1.9, 1.7, { blocks: 13, rune: true }); // не на оси затмения
  arch(100, 23, 6.2, 6.0, 1.7, 1.5, 1.3, { blocks: 11 });
  arch(262, 23.5, 6.4, 6.0, 1.7, 1.5, 1.3, { blocks: 11, missing: [0, 1, 2, 3], brokenLeftH: 3.2 });

  /* ===================== [ASHEN_V3] ЗОНЫ БОЛЬШОЙ КАРТЫ ===================== */
  // Всё крупное — в слитые меши по зоне (стены, башни, колоссы) или в общие InstancedMesh
  // (колонны, блоки, деревья, валуны): десяток вызовов отрисовки на всю карту.
  // Коллайдеры — из тех же размеров, что видно; мелочь (щебень, камешки) — без коллайдеров
  // и по уровням качества.
  const LANDMARKS = [];
  const lakeGlints = [];                // отражения фонарей на воде (поворачиваются к камере)
  const CLEARINGS = [];                 // поляны под угли: без деревьев и валунов
  const zoneParts = [];                 // слитый камень зон (matStone)
  const glowParts = [];                 // тёплые окна, руны путевых камней
  const treeItems = [[], [], []];
  const boulderItems = [], pebbleItems = [];
  const gyT = terrainH;
  const landmark = (z, extra = {}) => LANDMARKS.push(Object.freeze({ id: z.id, kind: 'landmark', name: z.name, x: z.x, y: gyT(z.x, z.z), z: z.z, r: z.r, ...extra }));
  // слитый меш зоны: у каждой зоны свои границы — вне кадра и вне теневой камеры не рисуется
  function flushZone(name) {
    if (!zoneParts.length) return;
    const m = new THREE.Mesh(G(mergeGeos(zoneParts.splice(0))), matStone);
    m.castShadow = true; m.receiveShadow = true;
    m.name = name;
    env.add(m);
  }
  function putGeo(g, x, y, z, yaw = 0, list = zoneParts) { if (yaw) g.rotateY(yaw); g.translate(x, y, z); list.push(g); return g; }
  function colliderFree(x, z, m) {
    for (const c of LAYOUT_COLLIDERS) {
      if (c.type === 'circle') { if (Math.hypot(x - c.x, z - c.z) < c.r + m) return false; }
      else if (segDist(x, z, c.ax, c.az, c.bx, c.bz) < c.r + m) return false;
    }
    return true;
  }
  function rubble(x, z, spread, n, rnd) {
    for (let i = 0; i < n; i++) {
      const s = 0.2 + Math.pow(rnd(), 2) * 0.55;
      const px = x + (rnd() - 0.5) * spread * 2, pz = z + (rnd() - 0.5) * spread * 2;
      blocks.push(instItem(new THREE.Vector3(px, gyT(px, pz) + s * 0.25, pz), { x: rnd() * 0.7, y: rnd() * TAU, z: rnd() * 0.7 },
        { x: s * (1 + rnd()), y: s * (0.6 + rnd() * 0.5), z: s * (1 + rnd()) }, rnd() < 0.5 ? 1 : 2, stoneTint(rnd, 0.82)));
    }
  }
  // Стена из секций по отрезку: у руин высота по шуму, провалы, зубцы, щебень у подножия.
  function wallRun(ax, az, bx, bz, h, t, o = {}) {
    const rnd = o.rnd || seedRnd;
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 0.5) return;
    const ux = dx / L, uz = dz / L, yaw = Math.atan2(-uz, ux);
    const n = Math.max(1, Math.round(L / (o.sec || 3.4))), sl = L / n;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * sl, cx = ax + ux * s, cz = az + uz * s;
      if ((o.gaps && o.gaps.some(([g0, g1]) => s > g0 && s < g1)) || (i > 0 && i < n - 1 && rnd() < (o.gap != null ? o.gap : 0.12))) {
        rubble(cx, cz, 1.5, 4, rnd);
        continue;
      }
      const prof = o.ruin === false ? 0.92 + rnd() * 0.08 : clamp(0.2 + 1.0 * noise.fbm(cx * 0.08 + 13, cz * 0.08 + 7, 0, 2) + (rnd() - 0.5) * 0.3, 0.16, 1);
      const hh = h * prof;
      const gA = gyT(cx - ux * sl / 2, cz - uz * sl / 2), gB = gyT(cx + ux * sl / 2, cz + uz * sl / 2);
      const y0 = Math.min(gA, gB) - 0.7, H = hh + Math.max(gA, gB) - y0;
      const tt = t * (0.95 + rnd() * 0.1);
      const g = chiseled(sl * 1.01, H, tt, { bevel: 0.1, jitter: 0.07, uvScale: 2.4, seed: 700 + zoneParts.length });
      g.translate(0, H / 2, 0);
      putGeo(g, cx, y0, cz, yaw);
      if (hh > 1.4 && rnd() < 0.4) {
        const bw = 0.6 + rnd() * 0.8, bh = 0.4 + rnd() * 0.5;
        const b = chiseled(bw, bh, tt * 0.92, { bevel: 0.06, jitter: 0.05, uvScale: 2.4, seed: 900 + zoneParts.length });
        b.translate((rnd() - 0.5) * (sl - bw), H + bh / 2 - 0.02, 0);
        putGeo(b, cx, y0, cz, yaw);
      }
      addSegment(cx - ux * sl / 2, cz - uz * sl / 2, cx + ux * sl / 2, cz + uz * sl / 2, tt / 2 + 0.05);
      if (rnd() < 0.3) { const sd = rnd() < 0.5 ? 1 : -1; rubble(cx - uz * sd * (tt / 2 + 0.9), cz + ux * sd * (tt / 2 + 0.9), 0.8, 2, rnd); }
    }
  }
  // Квадратная башня: карниз, зубцы или шатёр, тёплые окна.
  function towerAt(x, z, w, h, o = {}) {
    const rnd = o.rnd || seedRnd, yaw = o.yaw || 0, hw = w / 2;
    const y0 = Math.min(gyT(x - hw, z - hw), gyT(x + hw, z + hw), gyT(x - hw, z + hw), gyT(x + hw, z - hw)) - 0.8;
    const H = h + (gyT(x, z) - y0);
    const g = chiseled(w, H, w * 0.94, { bevel: 0.18, jitter: 0.12, taperTop: 0.9, uvScale: 2.6, seed: 400 + zoneParts.length });
    g.translate(0, H / 2, 0);
    putGeo(g, x, y0, z, yaw);
    for (const f of [0.34, 0.66]) {
      const band = chiseled(w * lerp(1.07, 0.97, f), 0.42, w * lerp(1.01, 0.91, f), { bevel: 0.08, jitter: 0.04, uvScale: 2.6, seed: 450 + zoneParts.length });
      band.translate(0, H * f, 0);
      putGeo(band, x, y0, z, yaw);
    }
    const tw = w * 0.9 / 2;
    if (o.roof) {
      const rh = w * (1.4 + rnd() * 0.8);
      const cone = new THREE.ConeGeometry(w * 0.74, rh, 4, 1);
      cone.rotateY(Math.PI / 4);
      cone.translate(0, H + rh / 2 - 0.05, 0);
      boxProjectUV(cone, 2.6);
      putGeo(cone, x, y0, z, yaw);
    } else {
      for (let k = 0; k < 8; k++) {
        if (rnd() < 0.35) continue;
        const side = k >> 1, t2 = (k & 1) ? 0.5 : -0.5;
        const lx = side === 0 ? t2 * tw * 1.4 : side === 1 ? tw - 0.3 : side === 2 ? t2 * tw * 1.4 : -tw + 0.3;
        const lz = side === 0 ? tw - 0.3 : side === 1 ? t2 * tw * 1.4 : side === 2 ? -tw + 0.3 : t2 * tw * 1.4;
        const bh = 0.7 + rnd() * 0.8;
        const b = chiseled(0.9, bh, 0.9, { bevel: 0.07, jitter: 0.05, uvScale: 2.4, seed: 480 + zoneParts.length });
        b.translate(lx, H + bh / 2 - 0.05, lz);
        putGeo(b, x, y0, z, yaw);
      }
    }
    if (o.windows) {
      const nWin = 2 + (rnd() * 4 | 0);
      for (let k = 0; k < nWin; k++) {
        const f = (rnd() * 4) | 0, fy = 0.45 + rnd() * 0.45, hwF = (w / 2) * lerp(1, 0.9, fy) + 0.03;
        const q = new THREE.PlaneGeometry(0.55, 1.05);
        q.rotateY(f * Math.PI / 2);
        const s = (rnd() - 0.5) * w * 0.45;
        const lx = f === 0 ? s : f === 1 ? hwF : f === 2 ? -s : -hwF, lz = f === 0 ? hwF * 0.94 : f === 1 ? -s : f === 2 ? -hwF * 0.94 : s;
        q.translate(lx, H * fy, lz);
        putGeo(q, x, y0, z, yaw, glowParts);
      }
    }
    addCircle(x, z, w * 0.64);
  }
  // Колонна на рельефе в общие InstancedMesh (tier 0 — у неё коллайдер).
  function colAt(x, z, h, type, rnd) {
    const y0 = gyT(x, z) - 0.35, rad = 0.55 + rnd() * 0.1, yaw = rnd() * TAU, tint = stoneTint(rnd);
    addCircle(x, z, rad * 1.32);
    const b = new THREE.Vector3(x, y0, z);
    plinths.push(instItem(b, { y: yaw }, { x: rad * 2.5, y: 0.7, z: rad * 2.5 }, 0, tint));
    shafts.push(instItem(b.clone().setY(y0 + 0.7), { y: yaw }, { x: rad, y: h, z: rad }, 0, tint));
    if (type === 'tall') caps.push(instItem(b.clone().setY(y0 + 0.7 + h), { y: yaw }, { x: rad, y: 1, z: rad }, 0, tint));
    else tops.push(instItem(b.clone().setY(y0 + 0.68 + h), { y: yaw }, { x: rad * 0.995, y: 0.35 + rnd() * 0.5, z: rad * 0.995 }, 0, tint));
  }
  // Мёртвое дерево: изогнутый ствол с раструбом, 5–7 сучьев с веточками, корни.
  function deadTreeGeo(seed) {
    const rr = mulberry32(seed * 7919 + 13);
    const parts = [];
    const H = 7.5 + rr() * 3.5, bx0 = (rr() - 0.5) * 1.4, bz0 = (rr() - 0.5) * 1.4;
    const bend = (y) => { const t = y / H; return [bx0 * t * t, bz0 * t * t]; };
    const trunk = new THREE.CylinderGeometry(0.09, 0.34, H, 6, 5, true);
    trunk.translate(0, H / 2, 0);
    { const p = trunk.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i), [bx, bz] = bend(y), fl = 1 + 1.1 * Math.pow(1 - clamp(y / 1.4, 0, 1), 2);
        const kn = 1 + (hash3(Math.round(Math.atan2(p.getX(i), p.getZ(i)) * 3), Math.round(y * 2), seed, 5) - 0.5) * 0.25;
        p.setXYZ(i, p.getX(i) * fl * kn + bx, y, p.getZ(i) * fl * kn + bz);
      } }
    parts.push(trunk);
    const up = new THREE.Vector3(0, 1, 0);
    const limb = (x, y, z, dir, len, r0, seg = 4) => {
      const c = new THREE.CylinderGeometry(Math.max(0.012, r0 * 0.25), r0, len, seg, 1, true);
      c.translate(0, len / 2, 0);
      const p = c.attributes.position;
      for (let i = 0; i < p.count; i++) { const t = p.getY(i) / len; p.setX(i, p.getX(i) + Math.sin(t * 3 + seed) * 0.12 * t * len * 0.1); }
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
      c.translate(x, y, z);
      parts.push(c);
    };
    const nb = 5 + ((rr() * 3) | 0);
    for (let i = 0; i < nb; i++) {
      const y = H * (0.34 + 0.56 * (i / nb) + rr() * 0.05), [bx, bz] = bend(y);
      const len = (1.5 + rr() * 2.6) * (1.15 - (y / H) * 0.55);
      const yb = rr() * TAU, pitch = deg(28 + rr() * 42);
      const dir = new THREE.Vector3(Math.sin(pitch) * Math.sin(yb), Math.cos(pitch), Math.sin(pitch) * Math.cos(yb));
      const r0 = 0.11 * (1 - y / H) + 0.035;
      limb(bx, y, bz, dir, len, r0);
      if (rr() < 0.75) {
        const t2 = 0.45 + rr() * 0.35;
        const d2 = dir.clone().add(new THREE.Vector3((rr() - 0.5) * 1.3, 0.5 + rr() * 0.4, (rr() - 0.5) * 1.3)).normalize();
        limb(bx + dir.x * len * t2, y + dir.y * len * t2, bz + dir.z * len * t2, d2, len * (0.4 + rr() * 0.25), r0 * 0.5, 3);
      }
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + rr() * 0.8;
      limb(0, 0.45, 0, new THREE.Vector3(Math.sin(a), -0.32, Math.cos(a)).normalize(), 1.3 + rr() * 0.6, 0.13, 4);
    }
    const g = mergeGeos(parts);
    boxProjectUV(g, 1.3);
    return G(g);
  }
  function addTree(x, z, variant, s, rnd, tint) {
    treeItems[variant].push(instItem(new THREE.Vector3(x, gyT(x, z) - 0.2, z), { x: (rnd() - 0.5) * 0.08, y: rnd() * TAU, z: (rnd() - 0.5) * 0.08 },
      { x: s, y: s * (0.9 + rnd() * 0.25), z: s }, 0, tint || new THREE.Color().setScalar(0.34 + rnd() * 0.2).multiply(new THREE.Color(1.04, 1, 0.96))));
    addCircle(x, z, 0.46 * s);
  }
  function addBoulder(x, z, s, rnd, collide = true, tier = 0) {
    const list = tier === 0 ? boulderItems : pebbleItems;
    list.push(instItem(new THREE.Vector3(x, gyT(x, z) - s * 0.3, z), { x: rnd() * 0.6, y: rnd() * TAU, z: rnd() * 0.6 },
      { x: s * (1 + rnd() * 0.5), y: s * (0.6 + rnd() * 0.4), z: s * (1 + rnd() * 0.4) }, tier, stoneTint(rnd, 0.78)));
    if (collide && s > 0.7) addCircle(x, z, s * 1.05);
  }

  /* ---------- Нижний город: сетка улиц под 45°, стена с воротами, кварталы руин, площадь ---------- */
  {
    const Cz = ZONES.city, rnd = mulberry32(wc.seed + 911);
    const yawC = Math.atan2(-CITY_EX.z, CITY_EX.x);   // локальная X → CITY_EX
    const wallUV = (u0, v0, u1, v1, h, t, o = {}) => { const a = cityW(u0, v0), b = cityW(u1, v1); wallRun(a.x, a.z, b.x, b.z, h, t, { rnd, ...o }); };
    const E = 47, streets = [-24, 0, 24];
    const gates = streets.map((s) => [s + E - 4.2, s + E + 4.2]);
    wallUV(-E, -E, E, -E, 7.5, 1.7, { gaps: gates, gap: 0.08 });
    wallUV(E, -E, E, E, 7.5, 1.7, { gaps: gates, gap: 0.14 });
    wallUV(E, E, -E, E, 7.5, 1.7, { gaps: gates, gap: 0.14 });
    wallUV(-E, E, -E, -E, 7.5, 1.7, { gaps: gates, gap: 0.1 });
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = cityW(su * E, sv * E); towerAt(p.x, p.z, 8, 14 + rnd() * 6, { rnd, yaw: yawC, windows: rnd() < 0.5 }); }
    // площадь: чаша фонтана и обломанный обелиск
    {
      const pc = cityW(0, 0), y0 = gyT(pc.x, pc.z);
      for (let i = 0; i < 14; i++) {
        if (i === 3 || i === 9) continue;
        const a = (i / 14) * TAU, g = chiseled(1.95, 0.75, 0.6, { bevel: 0.08, jitter: 0.04, uvScale: 2, seed: 1200 + i });
        g.translate(0, 0.3, 4.3);
        g.rotateY(a);
        g.translate(pc.x, y0, pc.z);
        zoneParts.push(g);
      }
      const pl = chiseled(2.8, 1.2, 2.8, { bevel: 0.1, uvScale: 2.2, seed: 1230 }); pl.translate(0, 0.5, 0); putGeo(pl, pc.x, y0, pc.z, yawC);
      const ob = chiseled(1.3, 7.5, 1.3, { bevel: 0.1, jitter: 0.06, taperTop: 0.55, uvScale: 2.2, seed: 1231 }); ob.translate(0, 1.1 + 3.75, 0); ob.rotateZ(0.05); putGeo(ob, pc.x, y0, pc.z, yawC + 0.3);
      const rn = new THREE.CircleGeometry(0.42, 18); rn.translate(0, 3.2, 0.62); putGeo(rn, pc.x, y0, pc.z, yawC + 0.3, glowParts);
      addCircle(pc.x, pc.z, 4.75);
    }
    const cells = [-36, -12, 12, 36];
    for (const cu of cells) for (const cv of cells) {
      const inner = Math.abs(cu) === 12 && Math.abs(cv) === 12;
      const su = Math.sign(cu), sv = Math.sign(cv);
      if (cu === 36 && cv === 36) {             // колокольня — ориентир над городом
        const p = cityW(36, 36); towerAt(p.x, p.z, 10, 34, { rnd, yaw: yawC, roof: true, windows: true });
        wallUV(27.5, 27.5, 44, 27.5, 3, 1, { gap: 0.3 });
        continue;
      }
      if (inner) {
        const p = cityW(cu + su * 4.5, cv + sv * 4.5);
        towerAt(p.x, p.z, 6.5, 12 + rnd() * 8, { rnd, yaw: yawC, windows: rnd() < 0.6, roof: rnd() < 0.3 });
        wallUV(cu - 7 * su, cv + 7.5 * sv, cu + 1 * su, cv + 7.5 * sv, 3.5 + rnd() * 2, 0.9, { gap: 0.2 });
        continue;
      }
      const kind = rnd();
      if (kind < 0.45) {                         // дом: четыре стены, дверной проём к улице
        const hu = 4.8 + rnd() * 2.6, hv = 4.5 + rnd() * 2.8, h = 4 + rnd() * 4.5, t = 0.8;
        const ou = (rnd() - 0.5) * (9 - hu) , ov = (rnd() - 0.5) * (9 - hv);
        const u0 = cu + ou - hu, u1 = cu + ou + hu, v0 = cv + ov - hv, v1 = cv + ov + hv;
        const door = [[hu - 1.3, hu + 1.3]];
        wallUV(u0, v0, u1, v0, h, t, { gaps: sv > 0 ? door : [], gap: 0.15, sec: 2.6 });
        wallUV(u1, v0, u1, v1, h, t, { gaps: su < 0 ? [[hv - 1.3, hv + 1.3]] : [], gap: 0.15, sec: 2.6 });
        wallUV(u1, v1, u0, v1, h, t, { gaps: sv < 0 ? door : [], gap: 0.15, sec: 2.6 });
        wallUV(u0, v1, u0, v0, h, t, { gaps: su > 0 ? [[hv - 1.3, hv + 1.3]] : [], gap: 0.15, sec: 2.6 });
        const pc = cityW(cu + ou, cv + ov); rubble(pc.x, pc.z, Math.min(hu, hv) - 1, 6, rnd);
      } else if (kind < 0.7) {                   // башня
        const p = cityW(cu + (rnd() - 0.5) * 5, cv + (rnd() - 0.5) * 5);
        towerAt(p.x, p.z, 6.5 + rnd() * 2.5, 15 + rnd() * 13, { rnd, yaw: yawC, windows: rnd() < 0.55, roof: rnd() < 0.4 });
      } else if (kind < 0.85) {                  // зал: два ряда колонн и задняя стена
        for (let k = 0; k < 4; k++) for (const s of [-1, 1]) {
          const p = cityW(cu + s * 3.6, cv - 6 + k * 4.1);
          const tall = rnd() < 0.35;
          colAt(p.x, p.z, tall ? 7 + rnd() * 2 : 1.5 + rnd() * 4.5, tall ? 'tall' : 'broken', rnd);
        }
        wallUV(cu - 6, cv + 8 * sv, cu + 6, cv + 8 * sv, 6 + rnd() * 2, 1.1, { gap: 0.2 });
      } else {                                   // развал: низкие стены и щебень
        wallUV(cu - 7, cv - 2, cu + 2, cv - 7, 1.6 + rnd() * 1.5, 0.9, { gap: 0.3 });
        wallUV(cu + 3, cv + 6, cu + 7, cv - 3, 1.4 + rnd() * 1.2, 0.9, { gap: 0.3 });
        const pc = cityW(cu, cv); rubble(pc.x, pc.z, 6, 14, rnd);
        const pb = cityW(cu - 2, cv + 3); addBoulder(pb.x, pb.z, 1.2 + rnd() * 0.6, rnd);
      }
    }
    // щебень на улицах
    for (let i = 0; i < 70; i++) { const p = cityW((rnd() - 0.5) * 90, (rnd() - 0.5) * 90); rubble(p.x, p.z, 1.2, 1, rnd); }
    flushZone('city-ruins');
    landmark(Cz);
  }

  /* ---------- Кладбище колоссов: павший исполин с воздетой кистью, меч, рёбра, стоящие ноги ---------- */
  {
    const Gz = ZONES.graves, rnd = mulberry32(wc.seed + 931);
    const parts = [], pieces = [];
    const seg = (p0, p1, w, d, o = {}) => { segBox(parts, p0, p1, w, d, { uvScale: 3, ...o }); pieces.push([p0, p1, w, d]); };
    // лежит на спине, голова к +X
    seg([-8, 1, 0], [-2, 1.2, 0], 12, 9);
    seg([-3, 1.5, 0], [12, 2.5, 0], 15, 9, { taperTop: 1.15 });
    seg([12.5, 2, 0.5], [20, 4.5, 1], 8.5, 8.5, { taperTop: 0.7 });
    seg([4, 2, 8], [0, 3, 17], 5, 5);                 // плечо
    seg([0, 3, 17], [3, 12, 22], 4.5, 4.5);           // предплечье вверх
    seg([3, 12, 22], [4.5, 16, 24], 5.5, 2.4);        // ладонь
    for (let f = 0; f < 4; f++) {                     // пальцы тянутся к затмению
      const ox = -1.6 + f * 1.1;
      const b = [4.5 + ox * 0.3, 16, 24 + ox], m = [5.5 + ox * 0.2, 19.5 - Math.abs(ox) * 0.4, 25.5 + ox * 1.1], t = [7 + ox * 0.1, 21.5 - Math.abs(ox) * 0.6, 25.2 + ox * 1.2];
      seg(b, m, 1.15, 1.15); seg(m, t, 0.95, 0.95);
    }
    seg([4, 2, -8], [-3, 1.5, -18], 5, 5);            // вторая рука отломана
    seg([-3.5, 1.2, -18.5], [-5.5, 1, -22], 4, 4, { jitter: 0.9 });
    for (const s of [-1, 1]) {
      seg([-8, 1.5, s * 3.5], [-20, 7, s * 4.5], 6, 6);   // бедро
      seg([-20, 7, s * 4.5], [-32, 0, s * 5], 5, 5);     // голень
    }
    // великий меч, воткнутый в землю
    seg([-4, -3, -30], [-7, 30, -33], 3.2, 0.8, { taperTop: 0.5 });
    seg([-6.6, 26.5, -38], [-6.9, 26.8, -28], 1.3, 1.3);
    seg([-7, 30, -33], [-7.5, 35, -33.5], 1, 1);
    // грудная клетка второго исполина
    seg([26, -0.8, 22], [46, -0.4, 22], 3.2, 3.2);
    for (let i = 0; i < 6; i++) {
      const x = 27 + i * 3.3, rr0 = 0.62 - i * 0.04;
      for (const s of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, -0.5, 22), new THREE.Vector3(x + 0.5, 6, 22 + s * 6.5), new THREE.Vector3(x + 1, 12, 22 + s * 4.5), new THREE.Vector3(x + 1.4, 14.8 - i * 0.6, 22 + s * 1.2)]);
        const tube = new THREE.TubeGeometry(curve, 18, rr0, 6, false);
        boxProjectUV(tube, 3);
        parts.push(tube);
      }
    }
    // стоящие ноги на постаменте
    seg([-26, 0, 34], [-26, 3, 34], 14, 9);
    seg([-29.5, 3, 34], [-29.5, 18, 34.6], 4.5, 5);
    seg([-22.5, 3, 34], [-22.2, 13, 33.5], 4.5, 5, { jitter: 0.8 });
    const phi = 0.55, cph = Math.cos(phi), sph = Math.sin(phi);
    const ox = Gz.x + 4, oz = Gz.z - 2, oy = -6.3;
    const W = (p) => ({ x: ox + p[0] * cph + p[2] * sph, z: oz - p[0] * sph + p[2] * cph });
    const g = mergeGeos(parts);
    g.rotateY(phi);
    g.translate(ox, oy, oz);
    const mesh = new THREE.Mesh(G(g), matStone);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'colossus-graveyard';
    env.add(mesh);
    for (const [p0, p1, w, d] of pieces) {
      if (Math.min(p0[1], p1[1]) > 4) continue;       // высоко над землёй — не мешает
      const a = W(p0), b = W(p1);
      addSegment(a.x, a.z, b.x, b.z, Math.max(w, d) * 0.45);
    }
    for (let i = 0; i < 6; i++) { const a = W([27 + i * 3.3, 0, 22]); addCircle(a.x, a.z, 1.3); }
    // ряды надгробий
    for (let row = 0; row < 3; row++) for (let k = 0; k < 9; k++) {
      const p = W([-6 + k * 3.4 + (rnd() - 0.5), 0, -46 - row * 4 + (rnd() - 0.5)]);
      if (!colliderFree(p.x, p.z, 1)) continue;
      const hS = 1.4 + rnd() * 0.9;
      blocks.push(instItem(new THREE.Vector3(p.x, gyT(p.x, p.z) + hS * 0.35, p.z), { x: (rnd() - 0.5) * 0.3, y: -phi + (rnd() - 0.5) * 0.3, z: (rnd() - 0.5) * 0.25 },
        { x: 1.1, y: hS, z: 0.34 }, 0, stoneTint(rnd, 0.8)));
      addCircle(p.x, p.z, 0.6);
    }
    landmark(Gz);
  }

  /* ---------- Холм клятвы: кольцо менгиров, ротонда, коленопреклонённая статуя ---------- */
  {
    const Hz = ZONES.hill, rnd = mulberry32(wc.seed + 941);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + 0.2, x = Hz.x + Math.sin(a) * 10.5, z = Hz.z + Math.cos(a) * 10.5;
      const y0 = gyT(x, z);
      if (i === 4) {                               // упавший
        const g = chiseled(1.5, 6, 0.9, { bevel: 0.12, jitter: 0.1, uvScale: 2.4, seed: 1300 + i });
        g.rotateZ(Math.PI / 2); g.translate(0, 0.5, 0);
        putGeo(g, x, y0, z, a);
        addSegment(x - Math.cos(a) * 3, z + Math.sin(a) * 3, x + Math.cos(a) * 3, z - Math.sin(a) * 3, 0.6);
        continue;
      }
      const h = 5 + rnd() * 2.8;
      const g = chiseled(1.5, h + 0.6, 0.9, { bevel: 0.12, jitter: 0.1, taperTop: 0.78, uvScale: 2.4, seed: 1300 + i });
      g.translate(0, (h + 0.6) / 2, 0); g.rotateX((rnd() - 0.5) * 0.12); g.rotateZ((rnd() - 0.5) * 0.12);
      putGeo(g, x, y0 - 0.6, z, a);
      const rn = new THREE.PlaneGeometry(0.28, 1.4); rn.rotateY(Math.PI); rn.translate(0, h * 0.6, -0.47);
      putGeo(rn, x, y0 - 0.6, z, a, glowParts);
      addCircle(x, z, 0.95);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.5;
      colAt(Hz.x + Math.sin(a) * 6.2, Hz.z + Math.cos(a) * 6.2, i % 3 === 0 ? 6.5 : 1.4 + rnd() * 3.5, i % 3 === 0 ? 'tall' : 'broken', rnd);
    }
    // статуя смотрит на арену, за кольцом со стороны края мира
    const dl = Math.hypot(Hz.x, Hz.z), sx = Hz.x + (Hz.x / dl) * 19, sz = Hz.z + (Hz.z / dl) * 19;
    const st = new THREE.Mesh(colossusGeo(1.2), matStone);
    st.position.set(sx, gyT(sx, sz) - 0.6, sz);
    st.scale.setScalar(0.3);
    st.rotation.y = Math.atan2(-sx, -sz);
    st.castShadow = true; st.receiveShadow = true;
    st.name = 'oath-statue';
    env.add(st);
    addCircle(sx, sz, 4.4);
    flushZone('hill-shrine');
    landmark(Hz, { y: gyT(Hz.x, Hz.z) });
  }

  /* ---------- Павшие врата: разбитая арка на краю мира, башни, стены вдоль обрыва ---------- */
  {
    const Gt = ZONES.gate, rnd = mulberry32(wc.seed + 951);
    arch(0, Gt.z, 11, 11, 3.4, 3.2, 2.4, { blocks: 15, missing: [9, 10, 11] });
    towerAt(-12.8, Gt.z, 7, 24, { rnd, windows: true });
    towerAt(12.8, Gt.z, 7, 17, { rnd });
    wallRun(16.5, Gt.z, 40, Gt.z - 3, 9, 2.2, { rnd, gap: 0.15 });
    wallRun(40, Gt.z - 3, 64, Gt.z - 12, 8, 2.2, { rnd, gap: 0.25 });
    wallRun(-16.5, Gt.z, -42, Gt.z - 2, 9, 2.2, { rnd, gap: 0.15 });
    wallRun(-42, Gt.z - 2, -66, Gt.z - 10, 7, 2.2, { rnd, gap: 0.3 });
    flushZone('fallen-gate');
    landmark(Gt);
  }

  /* ---------- Зеркальное озеро: гать из плит к острову ---------- */
  {
    const Lz = ZONES.lake, rnd = mulberry32(wc.seed + 961);
    const dx = LAKE_ISLAND.x - LAKE_SHORE.x, dz = LAKE_ISLAND.z - LAKE_SHORE.z, L = Math.hypot(dx, dz);
    for (let s = 0.8; s < L - LAKE_ISLAND.r + 1; s += 1.45) {
      const x = LAKE_SHORE.x + dx / L * s + (rnd() - 0.5) * 0.3, z = LAKE_SHORE.z + dz / L * s + (rnd() - 0.5) * 0.3;
      blocks.push(instItem(new THREE.Vector3(x, Math.max(gyT(x, z), LAKE_WL + 0.2) + 0.02, z), { y: Math.atan2(dx, dz) + (rnd() - 0.5) * 0.3 },
        { x: 1.5, y: 0.26, z: 1.15 }, 0, stoneTint(rnd, 0.9)));
    }
    addTree(LAKE_ISLAND.x - 2.6, LAKE_ISLAND.z + 2.2, 1, 1.25, rnd);
    // каменные фонари по берегу и их отражения-дорожки на воде (дорожка поворачивается к камере)
    const matGl = addMat(0xffa860, 0.85, texGlow, true);
    matGl.color.multiplyScalar(3.4);
    const glG = G(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const lampMat = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffb070, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, fog: true }));
    lampMat.color.multiplyScalar(3.2);
    const nL = 9;
    for (let i = 0; i < nL; i++) {
      const a = (i / nL) * TAU + 0.35 + (rnd() - 0.5) * 0.2;
      const x = Lz.x + Math.sin(a) * (Lz.r + 0.8), z = Lz.z + Math.cos(a) * (Lz.r + 0.8);
      if (Math.hypot(x - LAKE_SHORE.x, z - LAKE_SHORE.z) < 5) continue;
      const y0 = gyT(x, z);
      const post = chiseled(0.42, 1.5, 0.42, { bevel: 0.05, jitter: 0.03, taperTop: 0.8, uvScale: 1.6, seed: 1500 + i }); post.translate(0, 0.6, 0); putGeo(post, x, y0, z, a);
      const cap = chiseled(0.8, 0.22, 0.8, { bevel: 0.05, jitter: 0.03, uvScale: 1.6, seed: 1520 + i }); cap.translate(0, 1.72, 0); putGeo(cap, x, y0, z, a);
      const lamp = new THREE.Sprite(lampMat); lamp.position.set(x, y0 + 1.55, z); lamp.scale.set(0.9, 0.9, 1); env.add(lamp);
      addCircle(x, z, 0.4);
      const gx = Lz.x + Math.sin(a) * (Lz.r - 3.2), gz = Lz.z + Math.cos(a) * (Lz.r - 3.2);
      const gl = new THREE.Mesh(glG, matGl); gl.position.set(gx, LAKE_WL + 0.03, gz); gl.renderOrder = 3; env.add(gl);
      lakeGlints.push({ mesh: gl, x: gx, z: gz, len: 8 + rnd() * 3, wid: 1.1 });
    }
    { // отражение маяка угля на острове
      const gl = new THREE.Mesh(glG, addMat(0xff5a24, 0.8, texGlow, true)); gl.material.color.multiplyScalar(3.2);
      const gx = LAKE_ISLAND.x + 4.5, gz = LAKE_ISLAND.z - 5.5;
      gl.position.set(gx, LAKE_WL + 0.03, gz); gl.renderOrder = 3; env.add(gl);
      lakeGlints.push({ mesh: gl, x: gx, z: gz, len: 14, wid: 0.9 });
    }
    flushZone('lake-lanterns');
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU + rnd() * 0.3, r = Lz.r + 1 + rnd() * 5;
      const x = Lz.x + Math.sin(a) * r, z = Lz.z + Math.cos(a) * r;
      if (Math.hypot(x - LAKE_SHORE.x, z - LAKE_SHORE.z) < 7 || roadDist(x, z) < ROAD_HW + 1.5) continue;
      addBoulder(x, z, 0.9 + rnd() * 1.6, rnd);
    }
    landmark(Lz);
  }

  /* ---------- Путевые камни с рунами на дорогах ---------- */
  {
    const rnd = mulberry32(wc.seed + 971);
    ROADS.forEach((pl, i) => {
      const k = Math.max(1, (pl.length / 2) | 0);
      const [ax, az] = pl[k - 1], [bx, bz] = pl[k];
      const len = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / len, nz = (bx - ax) / len;
      const x = (ax + bx) / 2 + nx * (ROAD_HW + 1.6), z = (az + bz) / 2 + nz * (ROAD_HW + 1.6);
      const y0 = gyT(x, z), yaw = Math.atan2(nx, nz);
      const g = chiseled(0.9, 2.8, 0.6, { bevel: 0.1, jitter: 0.06, taperTop: 0.7, uvScale: 2, seed: 1400 + i });
      g.translate(0, 1.2, 0); g.rotateZ((rnd() - 0.5) * 0.1);
      putGeo(g, x, y0, z, yaw);
      const rn = new THREE.PlaneGeometry(0.3, 0.9); rn.rotateY(Math.PI); rn.translate(0, 1.6, -0.31);
      putGeo(rn, x, y0, z, yaw, glowParts);
      addCircle(x, z, 0.6);
    });
  }

  // Поляны под угли (места задаются ниже, в EMBER_SPOTS) — деревья и валуны их обходят.
  const EMBER_SPOTS = [
    { x: Math.sin(deg(28)) * 21, z: Math.cos(deg(28)) * 21, name: 'Плато Регента' },
    { x: Math.sin(deg(105)) * 31, z: Math.cos(deg(105)) * 31, name: 'Плато Регента' },
    { x: Math.sin(deg(150)) * 50, z: Math.cos(deg(150)) * 50, name: 'Врата святилища' },
    { ...cityW(0, -8), name: ZONES.city.name },
    { x: -142, z: 16, name: ZONES.forest.name },
    { x: LAKE_ISLAND.x + 1.2, z: LAKE_ISLAND.z - 0.8, name: ZONES.lake.name },
    { x: ZONES.graves.x - 8, z: ZONES.graves.z - 16, name: ZONES.graves.name },
    { x: ZONES.hill.x, z: ZONES.hill.z, name: ZONES.hill.name },
    { x: 5, z: ZONES.gate.z + 9, name: ZONES.gate.name },
    { ...cityW(24, 24), name: ZONES.city.name },
  ];
  for (const s of EMBER_SPOTS) CLEARINGS.push({ x: s.x, z: s.z, r: 4.5 });
  CLEARINGS.push({ x: -142, z: 16, r: 10 });   // поляна в лесу

  /* ---------- Пепельный лес и одиночные деревья, валуны, камешки, скальный вал у края ---------- */
  {
    const Fz = ZONES.forest, rnd = mulberry32(wc.seed + 981);
    const cell = 3.2, grid = new Map();
    const key = (x, z) => ((Math.floor(x / cell) + 512) << 10) | (Math.floor(z / cell) + 512);
    const spaced = (x, z, m) => {
      const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
        const l = grid.get(((ix + a + 512) << 10) | (iz + b + 512));
        if (l) for (const p of l) if ((p.x - x) ** 2 + (p.z - z) ** 2 < m * m) return false;
      }
      return true;
    };
    const mark = (x, z) => { const k = key(x, z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ x, z }); };
    const pre = LAYOUT_COLLIDERS.slice();
    const freeOfPre = (x, z, m) => pre.every((c) => (c.type === 'circle' ? Math.hypot(x - c.x, z - c.z) > c.r + m : segDist(x, z, c.ax, c.az, c.bx, c.bz) > c.r + m));
    const inCity = (x, z) => { const [u, v] = cityUV(x, z); return Math.abs(u) < 52 && Math.abs(v) < 52; };
    const okSpot = (x, z, m) => Math.hypot(x, z) > 82 && edgeDist(x, z) > 9 && roadDist(x, z) > ROAD_HW + 1.6
      && Math.hypot(x - ZONES.lake.x, z - ZONES.lake.z) > ZONES.lake.r + 3 && !inCity(x, z)
      && Math.hypot(x - ZONES.hill.x, z - ZONES.hill.z) > 24 && Math.hypot(x - ZONES.gate.x, z - ZONES.gate.z) > 26
      && CLEARINGS.every((c) => Math.hypot(x - c.x, z - c.z) > c.r) && spaced(x, z, m) && freeOfPre(x, z, m);
    let nForest = 0;
    for (let i = 0; i < 5200 && nForest < 360; i++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * Fz.r * 1.25;
      const x = Fz.x + Math.sin(a) * r, z = Fz.z + Math.cos(a) * r;
      const dens = smoothstep(Fz.r * 1.25, Fz.r * 0.55, r) * (0.55 + 0.9 * noise.n2(x * 0.05 + 4, z * 0.05 + 2, 0));
      if (rnd() > dens || !okSpot(x, z, 3.1)) continue;
      addTree(x, z, (rnd() * 3) | 0, 0.8 + rnd() * 0.55, rnd); mark(x, z); nForest++;
    }
    let nLone = 0;
    for (let i = 0; i < 4000 && nLone < 120; i++) {
      const x = (rnd() - 0.5) * 480, z = (rnd() - 0.5) * 480;
      if (Math.hypot(x - Fz.x, z - Fz.z) < Fz.r * 1.3 || Math.hypot(x - ZONES.graves.x, z - ZONES.graves.z) < ZONES.graves.r + 6) continue;
      if (noise.n2(x * 0.02 + 9, z * 0.02 + 1, 0) < 0.45 || !okSpot(x, z, 5)) continue;
      addTree(x, z, (rnd() * 3) | 0, 0.7 + rnd() * 0.6, rnd); mark(x, z); nLone++;
    }
    let nB = 0;
    for (let i = 0; i < 3000 && nB < 110; i++) {
      const x = (rnd() - 0.5) * 480, z = (rnd() - 0.5) * 480;
      if (!okSpot(x, z, 3.5)) continue;
      addBoulder(x, z, 0.9 + Math.pow(rnd(), 2) * 2.6, rnd); mark(x, z); nB++;
    }
    // скальный вал: крупные глыбы вдоль кромки обрыва
    for (let a = 0; a < TAU; a += deg(1.15)) {
      const off = 3 + rnd() * 6, p = edgePoint(a + (rnd() - 0.5) * 0.01, off);
      if (Math.hypot(p.x - ZONES.gate.x, p.z - ZONES.gate.z) < 12) continue;
      addBoulder(p.x, p.z, 1.6 + rnd() * 2.8, rnd, off > 5);
    }
    // мелочь без коллайдеров (уровни качества)
    let nP = 0;
    for (let i = 0; i < 6000 && nP < 700; i++) {
      const x = (rnd() - 0.5) * 480, z = (rnd() - 0.5) * 480;
      if (Math.hypot(x, z) < 40 || edgeDist(x, z) < 4 || inDeepWater(x, z)) continue;
      addBoulder(x, z, 0.15 + Math.pow(rnd(), 2) * 0.5, rnd, false, nP < 350 ? 1 : 2); nP++;
    }
    landmark(Fz);
  }
  {
    const treeGeos = [deadTreeGeo(1), deadTreeGeo(2), deadTreeGeo(3)];
    const matBark = std({ color: 0x5a524c, map: texStone, roughness: 0.97, metalness: 0 });
    patchWet(matBark, { x: 0, y: 1, z: 0.45, w: 1.5 });
    treeItems.forEach((items, i) => { if (items.length) buildInstancedChunked(treeGeos[i], matBark, items, { name: 'dead-trees-' + i, chunk: 72, cull: 210 }); });
    buildInstancedChunked(G(rockGeo(1, 1, 613, 0.72)), matStoneFlat, boulderItems, { name: 'boulders', chunk: 96, cull: 170 });
    buildInstancedChunked(G(rockGeo(1, 0, 617, 0.6)), matStoneFlat, pebbleItems, { name: 'pebbles', cast: false, chunk: 64, cull: 70 });
    flushZone('waystones');
    if (glowParts.length) {
      const matWin = M(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, fog: true }));
      matWin.color.setRGB(3.2, 1.45, 0.55);   // HDR: светится сквозь туман и цепляет bloom
      const wm = new THREE.Mesh(G(mergeGeos(glowParts)), matWin);
      wm.name = 'zone-glow';
      env.add(wm);
    }
  }

  buildInstanced(shaftGeo, matStone, shafts, { name: 'column-shafts' });
  buildInstanced(brokenTopGeo, matStone, tops, { name: 'column-broken-tops' });
  buildInstanced(capitalGeo, matStone, caps, { name: 'column-capitals' });
  buildInstanced(plinthGeo, matStone, plinths, { name: 'column-plinths' });
  buildInstanced(blockGeo, matStoneFlat, blocks, { name: 'stone-blocks' });
  // Руна в замковом камне главной арки
  const matKeyRune = std({ color: 0x1a1612, emissive: 0xffb866, emissiveMap: texSigilGlow, emissiveIntensity: 1.1, roughness: 0.9 });
  for (const m of keystones) {
    const rune = new THREE.Mesh(G(new THREE.CircleGeometry(0.55, 24)), matKeyRune);
    rune.applyMatrix4(m);
    rune.lookAt(0, rune.position.y, 0);
    env.add(rune);
  }

  /* --------------------- Дальнее святилище с порталом --------------------- */
  const portalGroup = new THREE.Group();
  portalGroup.name = 'far-shrine';
  {
    const base = polar(SHRINE_AZ, 56 * K, GROUND_Y);
    portalGroup.position.copy(base);
    portalGroup.rotation.y = deg(SHRINE_AZ) + Math.PI; // лицом к арене
    {
      const ry = portalGroup.rotation.y, cy = Math.cos(ry), sy = Math.sin(ry);
      const W = (x, z) => ({ x: base.x + x * cy + z * sy, z: base.z - x * sy + z * cy });
      const c4 = [W(-17, -6), W(17, -6), W(17, 6), W(-17, 6)];
      for (let i = 0; i < 4; i++) addSegment(c4[i].x, c4[i].z, c4[(i + 1) % 4].x, c4[(i + 1) % 4].z, 0.3);
    }
    env.add(portalGroup);
    const add = (geo, x, y, z, mat = matFar) => { const m = new THREE.Mesh(G(geo), mat); m.position.set(x, y, z); portalGroup.add(m); return m; };
    add(chiseled(34, 1.6, 12, { bevel: 0.3, jitter: 0.2, uvScale: 3 }), 0, 0.8, 0);
    add(chiseled(26, 1.6, 9, { bevel: 0.3, jitter: 0.2, uvScale: 3 }), 0, 2.4, -0.5);
    add(chiseled(19, 1.6, 7, { bevel: 0.3, jitter: 0.2, uvScale: 3 }), 0, 4.0, -1);
    for (const sx of [-1, 1]) {
      add(chiseled(4.6, 21, 4.6, { bevel: 0.3, jitter: 0.25, taperTop: 0.8, uvScale: 3 }), sx * 10.5, 4.8 + 10.5, -1);
      const cone = new THREE.ConeGeometry(3.2, 6.5, 4, 1);
      cone.rotateY(Math.PI / 4);
      add(cone, sx * 10.5, 4.8 + 21 + 3.2, -1);
    }
    // ворота с заострённым проёмом
    const W = 15, H = 21, hw = 4.1, hh = 15.5;
    const sh = new THREE.Shape();
    sh.moveTo(-W / 2, 0); sh.lineTo(W / 2, 0); sh.lineTo(W / 2, H); sh.lineTo(0, H + 3.2); sh.lineTo(-W / 2, H); sh.lineTo(-W / 2, 0);
    const hole = new THREE.Path();
    hole.moveTo(-hw, 0.01); hole.lineTo(hw, 0.01); hole.lineTo(hw, hh - hw * 1.2);
    hole.quadraticCurveTo(hw, hh - 0.8, 0, hh + 0.6);
    hole.quadraticCurveTo(-hw, hh - 0.8, -hw, hh - hw * 1.2);
    hole.lineTo(-hw, 0.01);
    sh.holes.push(hole);
    const gate = new THREE.ExtrudeGeometry(sh, { depth: 2.4, bevelEnabled: false, curveSegments: 10 });
    gate.translate(0, 4.8, -2.2);
    add(gate, 0, 0, 0);
    const pg = new THREE.PlaneGeometry(hw * 2, hh + 0.6);
    pg.translate(0, (hh + 0.6) / 2 + 4.8, -1);
    const veil = add(pg, 0, 0, 0, addMat(0xb9c6d8, 0.16, texGlow));
    veil.scale.set(1.05, 1, 1);
    const sw = new THREE.PlaneGeometry(9, 9);
    const swirl = add(sw, 0, 4.8 + 7.2, -0.8, addMat(0xd8b27a, 0.34, texSpiral));
    const swirl2 = add(sw.clone(), 0, 4.8 + 7.2, -0.7, addMat(0x8fb2de, 0.22, texSpiral));
    G(swirl2.geometry);
    portalGroup.userData.swirls = [swirl, swirl2];
    // далёкие руины-башни
    const rnd = mulberry32(wc.seed + 131);
    for (const [a, r, h0] of [[128, 44, 16], [218, 47, 13], [60, 50, 19], [300, 45, 15], [15, 52, 12], [258, 58, 22]]) {
      const pp = polar(a, r * K);
      const gy = Math.min(GROUND_Y, groundY(pp.x, pp.z).y);
      const h = h0 + (GROUND_Y - gy); // башня за обрывом вырастает из моря тумана
      const tw = new THREE.Mesh(G(chiseled(3.4 + rnd() * 1.4, h, 3.4 + rnd(), { bevel: 0.3, jitter: 0.4, taperTop: 0.75, uvScale: 3, seed: a })), matFar);
      tw.position.copy(polar(a, r * K, gy + h / 2 - 0.5));
      addCircle(tw.position.x, tw.position.z, 2.3);
      tw.rotation.y = rnd() * TAU;
      tw.rotation.z = (rnd() - 0.5) * 0.08;
      env.add(tw);
      const top = new THREE.Mesh(brokenTopGeo, matFar);
      top.position.copy(tw.position).setY(gy + h - 0.6);
      top.scale.set(2, 2.5, 2);
      env.add(top);
    }
  }

  /* ------------- Колоссы без кистей, шпили мёртвого города (Библия, разд. 2–3) ------------- */
  // Лестница масштаба: герой 1.8 м → босс → колонны → рёбра купола → колоссы → шпили.
  const matColossus = M(new THREE.MeshBasicMaterial({ color: 0x252c38, fog: true }));
  atmo.patchUnlit(matColossus);
  function segBox(parts, p0, p1, w, d, o = {}) {
    const a = new THREE.Vector3(p0[0], p0[1], p0[2]), b = new THREE.Vector3(p1[0], p1[1], p1[2]);
    const len = a.distanceTo(b);
    const g = chiseled(w, len, d, Object.assign({ bevel: Math.min(w, d) * 0.14, jitter: Math.min(w, d) * 0.07, seed: 300 + parts.length * 7 }, o));
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    const mid = a.add(b).multiplyScalar(0.5);
    g.translate(mid.x, mid.y, mid.z);
    parts.push(g);
  }
  function colossusGeo(armLift) {
    const parts = [];
    for (const s of [1, -1]) {
      segBox(parts, [s * 6.5, 3, -9], [s * 6.5, 3, 12], 6.5, 6);            // голени лёжа
      segBox(parts, [s * 6.5, 5, 12], [s * 5.5, 25, 2], 8, 8);              // бёдра
      segBox(parts, [s * 11, 50, -1], [s * 19, 63, 1], 6.5, 6.5);           // плечо
      segBox(parts, [s * 19, 63, 1], [s * (21 + armLift), 83, 3], 5.6, 5.6); // предплечье вверх
      segBox(parts, [s * (21 + armLift), 83, 3], [s * (21.3 + armLift), 86.5, 3.3], 6.4, 6.4, { jitter: 1.6 }); // обломанное запястье
    }
    segBox(parts, [0, 21, 1], [0, 30, 0], 17, 11);                            // таз
    segBox(parts, [0, 29, 0], [0, 53, -1], 20, 11, { taperTop: 1.18 });       // торс
    segBox(parts, [0, 52, -1], [0, 57, 0], 9, 8);                              // ворот
    segBox(parts, [0, 56, 0], [0, 67, 1.5], 10, 11, { taperTop: 0.62 });      // голова под капюшоном
    const skirt = new THREE.ConeGeometry(15, 24, 7, 1, true);
    skirt.translate(0, 14, 2);
    parts.push(skirt);
    return G(mergeGeos(parts));
  }
  for (const [a, lift, r] of [[160, 2.5, 372], [222, -1.5, 392]]) { // [ASHEN_V3] за краем большой карты
    const c = new THREE.Mesh(colossusGeo(lift), matColossus);
    const pos = polar(a, r);
    c.position.set(pos.x, -48, pos.z);
    c.scale.setScalar(1.35);
    c.rotation.y = Math.atan2(-pos.x, -pos.z) + (a < 190 ? -0.25 : 0.25);
    c.frustumCulled = false;
    c.name = 'colossus';
    env.add(c);
  }
  const windowPos = [];
  function spireLayer(r, n, hMin, hMax, span, seedL, color, windows) {
    const parts = [];
    const rr = mulberry32(seedL);
    const base = -44;
    for (let i = 0; i < n; i++) {
      const aDeg = 190 + (rr() - 0.5) * span;
      const a = deg(aDeg);
      const clear = Math.abs(wrapAngle(deg(aDeg - 190))) < deg(12) ? 0.55 : 1; // под затмением ниже
      const rad = r * (0.92 + rr() * 0.16);
      const h = lerp(hMin, hMax, Math.pow(rr(), 1.5)) * clear;
      const w = lerp(6, 15, rr()) * (0.55 + 0.45 * h / hMax);
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad;
      const roofH = w * lerp(1.4, 4.2, rr());
      const yaw = rr() * TAU;
      const tower = new THREE.BoxGeometry(w, h, w * (0.7 + rr() * 0.5));
      tower.translate(0, base + h / 2, 0);
      const roof = new THREE.ConeGeometry(w * 0.72, roofH, 4);
      roof.rotateY(Math.PI / 4);
      roof.translate(0, base + h + roofH / 2, 0);
      for (const g of [tower, roof]) { g.rotateY(yaw); g.translate(x, 0, z); parts.push(g); }
      if (rr() < 0.4) {
        const needle = new THREE.ConeGeometry(w * 0.16, roofH * 1.6, 4);
        needle.translate(x, base + h + roofH * 1.7, z);
        parts.push(needle);
      }
      if (windows && windowPos.length < 7 && rr() < 0.22) {
        const toC = Math.atan2(-x, -z);
        windowPos.push(x + Math.sin(toC) * w * 0.6, base + h * lerp(0.72, 0.92, rr()), z + Math.cos(toC) * w * 0.6);
      }
    }
    const mesh = new THREE.Mesh(G(mergeGeos(parts)), M(new THREE.MeshBasicMaterial({ color, fog: true })));
    mesh.frustumCulled = false;
    mesh.name = 'dead-city';
    env.add(mesh);
  }
  spireLayer(skyR * 0.46, 30, 34, 92, 170, wc.seed + 151, 0x161b24, true);
  spireLayer(skyR * 0.6, 38, 44, 122, 210, wc.seed + 152, 0x1b212c, true);
  spireLayer(skyR * 0.74, 44, 60, 150, 240, wc.seed + 153, 0x202732, false);
  {
    // 5–8 тёплых окон: «далёкая жизнь». HDR-цвет пробивается сквозь максимум тумана 0.97.
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(windowPos, 3));
    const wm = M(new THREE.PointsMaterial({ map: texDot, size: 3.2, sizeAttenuation: false, transparent: true, depthWrite: false, fog: true }));
    wm.color.setRGB(38, 17, 6);
    const win = new THREE.Points(G(wg), wm);
    win.frustumCulled = false;
    win.name = 'far-windows';
    env.add(win);
  }

  /* ------------------------- Рёбра обрушенного купола ------------------------- */
  // Верхняя треть кадра никогда не пустая: рёбра от вершин целых колонн тянутся к несуществующему своду.
  {
    const ribRnd = mulberry32(wc.seed + 161);
    const ribs = [[148, 18.0, 9.2, 0.78], [163, 17.6, 9.0, 0.5], [212, 18.2, 8.6, 0.84], [108, 18.6, 9.6, 0.62],
      [252, 18.4, 9.0, 0.7], [30, 18.8, 8.8, 0.74], [330, 18.6, 9.1, 0.58]];
    const apex = new THREE.Vector3(0, 25, 0);
    const chunkGeo = G(rockGeo(1.1, 1, 171, 0.8));
    for (const [a, r, h, keep] of ribs) {
      const y0 = GROUND_Y + 0.7 + h + 0.75;
      const curve = new THREE.CubicBezierCurve3(polar(a, r * K * 0.99, y0), polar(a, r * K * 0.82, y0 + 6.5), polar(a, r * K * 0.38, apex.y), apex.clone());
      const pts = [];
      for (let i = 0; i <= 24; i++) pts.push(curve.getPoint((i / 24) * keep));
      const part = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.Mesh(G(new THREE.TubeGeometry(part, 40, 0.62, 6, false)), matStone);
      tube.castShadow = true; tube.receiveShadow = true;
      tube.name = 'dome-rib';
      env.add(tube);
      const end = pts[pts.length - 1];
      const chunk = new THREE.Mesh(chunkGeo, matStone);
      chunk.position.copy(end);
      chunk.rotation.set(ribRnd() * 3, ribRnd() * 3, ribRnd() * 3);
      chunk.scale.setScalar(0.7 + ribRnd() * 0.3);
      chunk.castShadow = true;
      env.add(chunk);
    }
  }

  /* ------------------------------ Жаровни ------------------------------ */
  const braziers = [];
  {
    const pedGeo = G((() => { const g = lathe([[0.36, 0], [0.34, 0.08], [0.24, 0.16], [0.21, 0.72], [0.28, 0.82], [0.3, 0.9], [0.0005, 0.9]], 14); boxProjectUV(g, 1.2); return g; })());
    const bowlGeo = G(lathe([[0.0005, 0], [0.12, 0.0], [0.3, 0.08], [0.46, 0.26], [0.5, 0.36], [0.46, 0.37], [0.4, 0.28], [0.0005, 0.2]], 18));
    const coalGeo = G(rockGeo(0.34, 1, 44, 0.45));
    const decalGeo = G(new THREE.PlaneGeometry(1, 1));
    const matPool = addMat(0xff8a3a, 0.28, texGlow);
    const angles = [150, 210, 330, 30, 90, 270];
    angles.forEach((a, i) => {
      const grp = new THREE.Group();
      const p = polar(a, 11.25 * K, -0.3);
      grp.position.copy(p);
      addCircle(p.x, p.z, 0.5);
      env.add(grp);
      const ped = new THREE.Mesh(pedGeo, matStone); ped.castShadow = true; ped.receiveShadow = true; grp.add(ped);
      const bowl = new THREE.Mesh(bowlGeo, matIron); bowl.position.y = 0.88; bowl.castShadow = true; grp.add(bowl);
      const coals = new THREE.Mesh(coalGeo, matCoals); coals.position.y = 1.15; grp.add(coals);
      const outer = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: texGlow, color: 0xff7a30, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
      outer.material.color.multiplyScalar(1.6);
      outer.position.y = 1.55; outer.scale.set(1.5, 2.0, 1); grp.add(outer);
      const core = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffc27a, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
      core.material.color.multiplyScalar(4.2);
      core.position.y = 1.38; core.scale.set(0.55, 0.95, 1); grp.add(core);
      const pool = new THREE.Mesh(decalGeo, matPool);
      pool.rotation.x = -Math.PI / 2; pool.position.y = 0.02; pool.scale.set(4.2, 4.2, 1); pool.renderOrder = 2; grp.add(pool);
      const light = new THREE.PointLight(0xff8a3d, 14 * LI.point, 8, 2);
      light.position.y = 1.7;
      light.visible = false;
      grp.add(light);
      braziers.push({ grp, outer, core, light, phase: i * 1.7 });
    });
  }

  /* ------------------------------ Пепел ------------------------------ */
  const ASH_MAX = QUALITY_PRESETS.high.ash;
  const ashPos = new Float32Array(ASH_MAX * 3), ashCol = new Float32Array(ASH_MAX * 3), ashSeed = new Float32Array(ASH_MAX);
  {
    const rnd = mulberry32(wc.seed + 141);
    for (let i = 0; i < ASH_MAX; i++) {
      const r = Math.sqrt(rnd()) * 24, a = rnd() * TAU;
      ashPos[i * 3] = Math.sin(a) * r; ashPos[i * 3 + 1] = -1 + rnd() * 14; ashPos[i * 3 + 2] = Math.cos(a) * r;
      const ember = rnd() < 0.07;
      const v = 0.45 + rnd() * 0.3;
      ashCol[i * 3] = ember ? 1.0 : v; ashCol[i * 3 + 1] = ember ? 0.55 : v * 0.97; ashCol[i * 3 + 2] = ember ? 0.22 : v * 0.93;
      ashSeed[i] = rnd() * 100;
    }
  }
  const ashGeo = G(new THREE.BufferGeometry());
  ashGeo.setAttribute('position', new THREE.BufferAttribute(ashPos, 3));
  ashGeo.setAttribute('color', new THREE.BufferAttribute(ashCol, 3));
  ashGeo.setDrawRange(0, QUALITY_PRESETS.medium.ash);
  const ash = new THREE.Points(ashGeo, M(new THREE.PointsMaterial({ size: 0.065, map: texDot, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, sizeAttenuation: true })));
  ash.frustumCulled = false;
  ash.visible = !!wc.ambientAsh;
  ash.name = 'ambient-ash';
  env.add(ash);

  /* ======================= УГЛИ КЛЯТВЫ (ASHEN_V2) ======================= */
  // Пять алтарей на плато вне арены: плита с чашей угля и три стоячих камня со светящимися
  // прорезями. Незажжённый тлеет и светит тонким столбом — маяк, видный издалека. Герой подходит —
  // main.js начисляет очки клятвы и шлёт событие ember_lit; world только рисует (setPoiState).
  // Точечных источников света нет: вспышку при зажигании даёт effects.js.
  const EMBERS = [];
  const EMBER_POIS = [];
  {
    // [ASHEN_V3] углей 10: два на плато, у святилища и по зонам большой карты (EMBER_SPOTS)
    const isFree = (x, z, m) => colliderFree(x, z, m) && edgeDist(x, z) > 9 && !inDeepWater(x, z)
      && Math.abs(terrainH(x + 1.2, z) - terrainH(x - 1.2, z)) < 0.7 && Math.abs(terrainH(x, z + 1.2) - terrainH(x, z - 1.2)) < 0.7;
    const standG = G(chiseled(0.28, 1.55, 0.22, { bevel: 0.04, jitter: 0.02, taperTop: 0.7 }));
    const plinthG = G(chiseled(1.15, 0.5, 1.15, { bevel: 0.06, jitter: 0.03, taperTop: 0.86 }));
    const bowlG = G(lathe([[0.0005, 0], [0.1, 0.0], [0.26, 0.07], [0.38, 0.2], [0.42, 0.29], [0.38, 0.3], [0.33, 0.22], [0.0005, 0.16]], 16));
    const coalG = G(rockGeo(0.27, 1, 91, 0.45));
    const slitG = G(new THREE.PlaneGeometry(0.05, 0.85));
    const decalG = G(new THREE.PlaneGeometry(1, 1));
    const rnd = mulberry32(wc.seed + 509);
    const glowSprite = (hex, hdr, op) => {
      const m = M(new THREE.SpriteMaterial({ map: texGlow, color: hex, transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      m.color.multiplyScalar(hdr);
      return new THREE.Sprite(m);
    };
    EMBER_SPOTS.forEach((spot, i) => {
      let pos = null;
      for (let k = 0; k < 80 && !pos; k++) {
        const j = k === 0 ? 0 : 1.5 + k * 0.12, a = rnd() * TAU;
        const q = { x: spot.x + Math.sin(a) * j, z: spot.z + Math.cos(a) * j };
        if (isFree(q.x, q.z, 2.4)) pos = q;
      }
      if (!pos) { console.warn('[world] нет места под уголь', i, spot.name); return; }
      const gy = groundY(pos.x, pos.z).y;
      const grp = new THREE.Group();
      grp.name = 'ember-altar-' + i;
      grp.position.set(pos.x, gy, pos.z);
      grp.rotation.y = rnd() * TAU;
      env.add(grp);
      const plinth = new THREE.Mesh(plinthG, matStone); plinth.position.y = 0.2; plinth.castShadow = true; plinth.receiveShadow = true; grp.add(plinth);
      const bowl = new THREE.Mesh(bowlG, matIron); bowl.position.y = 0.46; bowl.castShadow = true; grp.add(bowl);
      const coalMat = std({ color: 0x1a1210, emissive: 0xff5a24, emissiveIntensity: 0.5, roughness: 1, flatShading: true });
      const coals = new THREE.Mesh(coalG, coalMat); coals.position.y = 0.66; grp.add(coals);
      addCircle(pos.x, pos.z, 0.72);
      const slitMat = addMat(0xff8a3a, 0.12, texGlow);
      slitMat.color.multiplyScalar(2.2);
      for (let j = 0; j < 3; j++) {
        const a = (j / 3) * TAU + 0.5, R = 1.35;
        const st = new THREE.Mesh(standG, matStone);
        st.position.set(Math.sin(a) * R, 0.62, Math.cos(a) * R);
        st.rotation.set((rnd() - 0.5) * 0.12, a, (rnd() - 0.5) * 0.16);
        st.castShadow = true; st.receiveShadow = true;
        grp.add(st);
        const sl = new THREE.Mesh(slitG, slitMat);
        sl.position.set(0, 0.1, -0.115); sl.rotation.y = Math.PI; sl.renderOrder = 3;
        st.add(sl);                                   // прорезь смотрит к чаше
        const wp = new THREE.Vector3(Math.sin(a) * R, 0, Math.cos(a) * R).applyAxisAngle(new THREE.Vector3(0, 1, 0), grp.rotation.y);
        addCircle(pos.x + wp.x, pos.z + wp.z, 0.22);
      }
      const ember = glowSprite(0xff5a24, 2.2, 0.35); ember.position.y = 0.78; ember.scale.set(0.8, 0.6, 1); grp.add(ember);
      const outer = glowSprite(0xff7a30, 1.8, 0); outer.position.y = 1.35; outer.scale.set(1.8, 2.5, 1); grp.add(outer);
      const core = glowSprite(0xffc27a, 4.4, 0); core.position.y = 1.08; core.scale.set(0.65, 1.15, 1); grp.add(core);
      const beacon = glowSprite(0xff6a2c, 2.0, 0.2); beacon.position.y = 4.6; beacon.scale.set(0.75, 9, 1); beacon.renderOrder = 2; grp.add(beacon);
      const poolMat = addMat(0xff8a3a, 0.08, texGlow);
      const pool = new THREE.Mesh(decalG, poolMat);
      pool.rotation.x = -Math.PI / 2; pool.position.y = 0.03; pool.scale.set(4.6, 4.6, 1); pool.renderOrder = 2; grp.add(pool);
      const id = 'ember-' + i;
      EMBERS.push({ id, x: pos.x, z: pos.z, grp, lit: false, litT: 9, ember, outer, core, beacon, pool, slitMat, coalMat, phase: i * 1.9 });
      EMBER_POIS.push(Object.freeze({ id, kind: 'ember', name: spot.name, x: pos.x, y: gy, z: pos.z, r: 1.9 }));
    });
  }
  function setPoiState(id, st) {
    const e = EMBERS.find((q) => q.id === id);
    if (!e || !st || typeof st !== 'object') return false;
    if (st.lit && !e.lit) { e.lit = true; e.litT = st.flash ? 0 : 9; }
    else if (st.lit === false) { e.lit = false; e.litT = 9; }
    return true;
  }
  function updateEmbers(dt) {
    const rm = wc.reducedMotion ? 0.4 : 1;
    for (const e of EMBERS) {
      // [ASHEN_V3] дальний алтарь — только маяк (экономия вызовов отрисовки)
      if (camera) {
        const near = Math.hypot(camera.position.x - e.x, camera.position.z - e.z) < 80;
        if (near !== e.near) { e.near = near; for (const c of e.grp.children) c.visible = near || c === e.beacon || c === e.ember; }
      }
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.1 + e.phase);
      if (!e.lit) {
        e.ember.material.opacity = 0.22 + 0.2 * pulse;
        e.beacon.material.opacity = 0.22 + 0.1 * pulse;
        e.beacon.scale.set(0.75, 9, 1);
        e.outer.material.opacity = 0; e.core.material.opacity = 0;
        e.coalMat.emissiveIntensity = 0.35 + 0.4 * pulse;
        e.slitMat.opacity = 0.08 + 0.06 * pulse;
        e.pool.material.opacity = 0.05 + 0.03 * pulse;
        continue;
      }
      e.litT += dt;
      const fl = e.litT < 2.2 ? 1 - e.litT / 2.2 : 0;          // вспышка зажигания
      const f = 0.82 + 0.1 * Math.sin(time * 11.3 + e.phase) + 0.08 * Math.sin(time * 23.7 + e.phase * 2.1) * rm;
      const g = 0.9 + 0.1 * Math.sin(time * 7.1 + e.phase * 1.3);
      const up = Math.min(1, e.litT / 0.35);
      e.outer.scale.set(1.8 * g * (1 + fl * 0.8), 2.5 * f * (1 + fl * 1.2), 1);
      e.core.scale.set(0.65 * f, 1.15 * g * (1 + fl * 0.6), 1);
      e.coalMat.emissiveIntensity = 3.2 + 1.5 * fl;
      e.outer.material.opacity = (0.42 + 0.12 * f) * up;
      e.core.material.opacity = 0.8 * up;
      e.ember.material.opacity = 0.5;
      e.beacon.material.opacity = 0.05 + 0.75 * fl * fl;
      e.beacon.scale.set(0.55 + 0.9 * fl, 8.5 + 6 * fl, 1);
      e.slitMat.opacity = 0.55 + 0.35 * fl + 0.08 * Math.sin(time * 5 + e.phase);
      e.pool.material.opacity = 0.22 + 0.2 * fl;
    }
  }

  /* ======================= РАСКЛАДКА КАРТЫ (ASHEN_V2) ======================= */
  // Земля: ступени арены (как в buildFloor) и плато за ней (groundY); проходимо до края обрыва.
  function layoutGroundY(x, z) {
    const r = Math.hypot(x, z) / K;
    if (r < 3.26) return 0.02;
    if (r < 9.65) return 0;
    if (r < 10.9) return 0.03;
    if (r < 11.6) return -0.3;
    if (r < 12.3) return -0.6;
    if (r < 12.95) return -0.9;
    return terrainH(x, z);
  }
  // [ASHEN_V3] ходить можно до скального вала у края мира и по мелководью озера
  function layoutWalkable(x, z) {
    if (Math.hypot(x, z) < 12.95 * K) return true;
    return edgeDist(x, z) > 6.5 && !inDeepWater(x, z);
  }
  // старт — снаружи арены, со стороны камеры (+Z), на свободном от коллайдеров месте
  const spawn = (() => {
    const free = (x, z) => LAYOUT_COLLIDERS.every((c) => c.type !== 'circle' || Math.hypot(x - c.x, z - c.z) > c.r + 0.9)
      && LAYOUT_COLLIDERS.every((c) => {
        if (c.type !== 'segment') return true;
        const ex = c.bx - c.ax, ez = c.bz - c.az, L2 = ex * ex + ez * ez || 1;
        const u = clamp(((x - c.ax) * ex + (z - c.az) * ez) / L2, 0, 1);
        return Math.hypot(x - c.ax - ex * u, z - c.az - ez * u) > c.r + 0.9;
      }) && layoutWalkable(x, z);
    for (let r = 26; r >= 16; r -= 1) for (const a of [0, 4, -4, 8, -8, 12, -12]) {
      const p = polar(a, r * K);
      if (free(p.x, p.z)) return { x: p.x, z: p.z, yaw: Math.atan2(-p.x, -p.z) };
    }
    return { x: 0, z: 6 * K, yaw: Math.PI };
  })();
  const layout = Object.freeze({
    version: 1,
    bounds: { minX: -262, maxX: 262, minZ: -262, maxZ: 262 },   // [ASHEN_V3] 500×500 м
    arena: { x: 0, z: 0, r: 13 * K, leash: 6 },
    bossHome: { x: 0, z: 0 },
    playerSpawn: spawn,
    colliders: Object.freeze(LAYOUT_COLLIDERS.map((c) => Object.freeze({ ...c }))),
    pois: Object.freeze(EMBER_POIS.slice()),
    // [ASHEN_V3] ориентиры зон для HUD/миникарты: {id, kind:'landmark', name, x, y, z, r}
    landmarks: Object.freeze([{ id: 'arena', kind: 'landmark', name: 'Арена Регента', x: 0, y: 0, z: 0, r: 13 * K },
      { id: 'shrine', kind: 'landmark', name: 'Врата святилища', x: Math.sin(deg(SHRINE_AZ)) * 56 * K, y: -1, z: Math.cos(deg(SHRINE_AZ)) * 56 * K, r: 17 }, ...LANDMARKS]),
    roads: Object.freeze(ROADS.map((pl) => Object.freeze(pl.map(([x, z]) => Object.freeze({ x, z }))))),
    worldEdge: WORLD_EDGE,
    edgeDistance: edgeDist,
    groundY: layoutGroundY,
    isWalkable: layoutWalkable,
  });

  /* ============================ СИСТЕМА ПОЗ ============================ */
  // Каналы позы: 'off' — смещение тела (x,y,z), остальные — Euler (x,y,z) шарниров.
  // Соглашения (модель смотрит в +Z, левая сторона персонажа = +X):
  //   rx>0 у конечности, висящей вниз, уводит её назад (-Z); rx<0 — вперёд.
  //   rz>0 уводит конечность к +X (для левой руки/ноги это отведение наружу).
  //   rx>0 у spine/chest — наклон вперёд.
  const JN = ['off', 'body', 'hips', 'spine', 'chest', 'neck', 'head', 'shL', 'shR', 'elL', 'elR', 'wrL', 'wrR', 'thL', 'thR', 'knL', 'knR', 'anL', 'anR'];
  const JI = {};
  JN.forEach((n, i) => { JI[n] = i; });
  const NCH = JN.length * 3;
  // Ключи с суффиксом '*' задаются для левой стороны и зеркалятся вправо: (x, -y, -z).
  function mkPose(def) {
    const v = new Float32Array(NCH), m = new Uint8Array(JN.length);
    const put = (k, a) => { const i = JI[k]; if (i === undefined) return; v[i * 3] = a[0] || 0; v[i * 3 + 1] = a[1] || 0; v[i * 3 + 2] = a[2] || 0; m[i] = 1; };
    for (const k in def) {
      const a = def[k];
      if (k.endsWith('*')) { const b = k.slice(0, -1); put(b + 'L', a); put(b + 'R', [a[0] || 0, -(a[1] || 0), -(a[2] || 0)]); }
      else put(k, a);
    }
    return { v, m };
  }
  function fullPose() { const p = mkPose({}); p.m.fill(1); return p; }
  function poseSet(p, k, x, y, z) { const i = JI[k] * 3; p.v[i] = x; p.v[i + 1] = y; p.v[i + 2] = z; p.m[JI[k]] = 1; }
  // Копировать отмеченные шарниры (over), смешать (blend), прибавить (add).
  function poseOver(dst, p) { for (let j = 0; j < JN.length; j++) if (p.m[j]) { const b = j * 3; dst[b] = p.v[b]; dst[b + 1] = p.v[b + 1]; dst[b + 2] = p.v[b + 2]; } }
  function poseBlend(dst, p, w) {
    if (w <= 1e-4) return;
    if (w > 1) w = 1;
    for (let j = 0; j < JN.length; j++) if (p.m[j]) { const b = j * 3; dst[b] += (p.v[b] - dst[b]) * w; dst[b + 1] += (p.v[b + 1] - dst[b + 1]) * w; dst[b + 2] += (p.v[b + 2] - dst[b + 2]) * w; }
  }
  function poseAdd(dst, p, w) {
    if (Math.abs(w) <= 1e-4) return;
    for (let j = 0; j < JN.length; j++) if (p.m[j]) { const b = j * 3; dst[b] += p.v[b] * w; dst[b + 1] += p.v[b + 1] * w; dst[b + 2] += p.v[b + 2] * w; }
  }
  // out = A → B с коэффициентом k (маска = объединение).
  function poseLerp(out, A, B, k) {
    out.v.set(A.v); out.m.set(A.m);
    for (let j = 0; j < JN.length; j++) if (B.m[j]) {
      const b = j * 3;
      out.v[b] += (B.v[b] - out.v[b]) * k; out.v[b + 1] += (B.v[b + 1] - out.v[b + 1]) * k; out.v[b + 2] += (B.v[b + 2] - out.v[b + 2]) * k;
      out.m[j] = 1;
    }
    return out;
  }
  function addCh(dst, k, x, y, z) { const i = JI[k] * 3; dst[i] += x; dst[i + 1] += y; dst[i + 2] += z; }

  function makeRig(rootObj, bodyObj) {
    const j = new Array(JN.length).fill(null);
    j[JI.body] = bodyObj; // канал 'body' = наклон всего тела вокруг точки на полу
    return { root: rootObj, body: bodyObj, j, contacts: [], markers: {}, groundY: 0 };
  }
  function joint(rig, name, parent, x, y, z, order = 'XYZ') {
    const o = new THREE.Group();
    o.name = name;
    o.position.set(x, y, z);
    o.rotation.order = order;
    parent.add(o);
    if (rig && JI[name] !== undefined) rig.j[JI[name]] = o;
    o.userData.rest = o.position.clone();
    return o;
  }
  function part(parent, geo, mat, x = 0, y = 0, z = 0, o = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (o.order) m.rotation.order = o.order;
    if (o.rx || o.ry || o.rz) m.rotation.set(o.rx || 0, o.ry || 0, o.rz || 0);
    if (o.s) { if (typeof o.s === 'number') m.scale.setScalar(o.s); else m.scale.set(o.s[0], o.s[1], o.s[2]); }
    m.castShadow = o.cast !== false;
    m.receiveShadow = o.receive !== false;
    parent.add(m);
    return m;
  }
  function marker(rig, name, parent, x, y, z, contact = false) {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    parent.add(o);
    rig.markers[name] = o;
    if (contact) rig.contacts.push(o);
    return o;
  }
  const _wp = new THREE.Vector3();
  // Применить позу и «приземлить»: нижняя точка контакта (подошвы, колени) = уровень пола.
  function applyPose(rig, v, scale = 1) {
    for (let j = 1; j < JN.length; j++) {
      const o = rig.j[j];
      if (o) o.rotation.set(v[j * 3], v[j * 3 + 1], v[j * 3 + 2]);
    }
    rig.body.position.set(v[0], v[1], v[2]);
    rig.root.updateMatrixWorld(true);
    let minY = Infinity;
    for (const c of rig.contacts) { _wp.setFromMatrixPosition(c.matrixWorld); if (_wp.y < minY) minY = _wp.y; }
    const parentY = rig.root.parent ? rig.root.parent.matrixWorld.elements[13] : 0;
    const rootY = rig.root.position.y + parentY;
    const lift = Number.isFinite(minY) ? -(minY - rootY) / scale : 0;
    rig.groundY = lift;
    rig.body.position.y += lift;
    rig.body.updateMatrixWorld(true);
  }

  /* ========================= ТКАНЬ (CPU-деформация) ========================= */
  const _qa = new THREE.Quaternion(), _va = new THREE.Vector3(), _vb = new THREE.Vector3();
  // Точки ноги (бедро, колено, лодыжка) в пространстве родителя бедра.
  function legPoints(th, kn, out) {
    out.p0.copy(th.position);
    _va.set(0, kn.position.y, 0).applyQuaternion(th.quaternion); // длина бедра = |kn.position.y|
    out.k.copy(out.p0).add(_va);
    _qa.copy(th.quaternion).multiply(kn.quaternion);
    _vb.set(0, out.shin, 0).applyQuaternion(_qa);
    out.a.copy(out.k).add(_vb);
    return out;
  }
  function legAtY(L, y, out) {
    const { p0, k, a } = L;
    if (y >= p0.y) return out.copy(p0);
    if (y >= k.y) { const t = (p0.y - y) / Math.max(1e-4, p0.y - k.y); return out.copy(p0).lerp(k, t); }
    if (y >= a.y) { const t = (k.y - y) / Math.max(1e-4, k.y - a.y); return out.copy(k).lerp(a, t); }
    return out.copy(a);
  }

  function colorArr(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }
  function makeClothGrid(cols, rows, uvS, colorFn) {
    const n = (cols + 1) * (rows + 1);
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
    const idx = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      uv[i * 2] = (c / cols) * uvS[0]; uv[i * 2 + 1] = (1 - r / rows) * uvS[1];
      const cc = colorFn(c / cols, r / rows);
      col[i * 3] = cc[0]; col[i * 3 + 1] = cc[1]; col[i * 3 + 2] = cc[2];
      if (r < rows && c < cols) { const a = i, b = i + 1, d = i + cols + 1, e = i + cols + 2; idx.push(a, d, b, b, d, e); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    return G(g);
  }

  /* ================================ ГЕРОЙ ================================ */
  const matCloth = std({ color: 0xffffff, map: texCloth, bumpMap: texCloth, bumpScale: bumpS * 0.6, vertexColors: true, roughness: 0.96, side: THREE.DoubleSide });
  const matHood = std({ color: 0xffffff, map: texCloth, vertexColors: true, roughness: 0.95 });
  // Руна вдоль спины (Библия, разд. 4): силуэт героя со спины опознаётся по ней с любого расстояния.
  const texRune = (() => {
    const c = makeCanvas(128, 256), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 128, 256);
    x.lineCap = 'round'; x.lineJoin = 'round';
    const stave = (w, a) => {
      x.strokeStyle = `rgba(255,255,255,${a})`; x.lineWidth = w;
      x.beginPath();
      x.moveTo(64, 26); x.lineTo(64, 104);             // ствол
      x.moveTo(64, 44); x.lineTo(46, 28); x.moveTo(64, 44); x.lineTo(82, 28); // ветви вверх
      x.moveTo(64, 70); x.lineTo(48, 86); x.moveTo(64, 70); x.lineTo(80, 86); // ветви вниз
      x.moveTo(56, 104); x.lineTo(72, 104);
      x.stroke();
      x.beginPath(); x.arc(64, 58, 7, 0, Math.PI * 2); x.stroke();
    };
    x.shadowColor = '#fff'; x.shadowBlur = 10; stave(7, 0.35);
    x.shadowBlur = 0; stave(2.6, 1);
    const t = tex(c, { repeat: false });
    t.repeat.set(1 / 1.6, 1 / 2.2); // UV плаща тайлятся под ткань (1.6 × 2.2)
    return t;
  })();
  const matCapeRune = std({
    color: 0xffffff, map: texCloth, bumpMap: texCloth, bumpScale: bumpS * 0.6, vertexColors: true, roughness: 0.96, side: THREE.DoubleSide,
    emissive: 0xffc27a, emissiveMap: texRune, emissiveIntensity: 1.6,
  });
  const matHandGlowR = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffa24a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const matHandGlowL = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xaecfff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const COAT = colorArr(0x4b505e), CAPE = colorArr(0x454b59), TUNIC = colorArr(0x575040), TRIM = colorArr(0x9a7640);

  const heroRoot = new THREE.Group();
  heroRoot.name = 'hero';
  root.add(heroRoot);
  const heroBody = new THREE.Group();
  heroBody.name = 'hero-body';
  heroRoot.add(heroBody);
  const hero = makeRig(heroRoot, heroBody);
  const H = {}; // ссылки на меши героя

  {
    const hips = joint(hero, 'hips', heroBody, 0, 1.03, 0);
    part(hips, G(lathe([[0.0005, -0.13], [0.12, -0.11], [0.165, -0.02], [0.16, 0.06], [0.0005, 0.075]], 14)), matTrousers, 0, 0, 0, { s: [1, 1, 0.74] });
    // пояс, пряжка, фонарь
    const belt = new THREE.TorusGeometry(0.168, 0.024, 6, 26); belt.rotateX(Math.PI / 2);
    part(hips, G(belt), matLeather, 0, 0.055, 0, { s: [1, 1, 0.76] });
    part(hips, G(chiseled(0.07, 0.06, 0.02, { bevel: 0.006, jitter: 0.002 })), matGold, 0, 0.055, 0.13);
    {
      const lan = new THREE.Group();
      lan.position.set(0.19, -0.06, 0.06);
      hips.add(lan);
      H.lantern = lan;
      part(lan, G(new THREE.CylinderGeometry(0.004, 0.004, 0.09, 4)), matIron, 0, 0.045, 0);
      part(lan, G(new THREE.CylinderGeometry(0.028, 0.035, 0.014, 8)), matIron, 0, 0.0, 0);
      part(lan, G(new THREE.CylinderGeometry(0.035, 0.03, 0.014, 8)), matIron, 0, -0.1, 0);
      H.lanternCore = part(lan, G(new THREE.CylinderGeometry(0.024, 0.026, 0.085, 8)), matLantern, 0, -0.05, 0, { cast: false });
      const barG = G(new THREE.BoxGeometry(0.006, 0.1, 0.006));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + 0.4; part(lan, barG, matIron, Math.sin(a) * 0.03, -0.05, Math.cos(a) * 0.03); }
    }
    // ноги
    const thighG = G(limbGeo(0.078, 0.062, 0.44, 12)), shinG = G(limbGeo(0.058, 0.046, 0.42, 12));
    const bootG = G(lathe([[0.0005, -0.425], [0.05, -0.42], [0.056, -0.33], [0.062, -0.22], [0.072, -0.17], [0.07, -0.155], [0.0005, -0.155]], 12));
    const footG = G(chiseled(0.1, 0.085, 0.26, { bevel: 0.022, jitter: 0.003, taperTop: 0.85 }));
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const th = joint(hero, 'th' + side, hips, s * 0.1, -0.05, 0);
      part(th, thighG, matTrousers);
      const kn = joint(hero, 'kn' + side, th, 0, -0.44, 0);
      part(kn, shinG, matTrousers);
      part(kn, bootG, matLeather);
      marker(hero, 'knee' + side, kn, 0, -0.035, 0.055, true);
      const an = joint(hero, 'an' + side, kn, 0, -0.42, 0);
      part(an, footG, matLeather, 0, -0.075, 0.055);
      marker(hero, 'heel' + side, an, 0, -0.118, -0.06, true);
      marker(hero, 'toe' + side, an, 0, -0.118, 0.18, true);
    }
    // корпус
    const spine = joint(hero, 'spine', hips, 0, 0.04, 0);
    part(spine, G(lathe([[0.0005, -0.02], [0.148, 0.0], [0.142, 0.13], [0.158, 0.26], [0.0005, 0.28]], 14)), matTunic, 0, 0, 0, { s: [1, 1, 0.72] });
    const chest = joint(hero, 'chest', spine, 0, 0.25, 0);
    part(chest, G(lathe([[0.0005, -0.03], [0.152, 0.0], [0.185, 0.1], [0.2, 0.2], [0.172, 0.28], [0.08, 0.335], [0.0005, 0.345]], 16)), matCoat, 0, 0, 0, { s: [1, 1, 0.68] });
    // накидка-пелерина с рваным краем
    {
      const g = lathe([[0.1, 0.38], [0.16, 0.345], [0.25, 0.27], [0.305, 0.17], [0.318, 0.085]], 28);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getY(i) < 0.1) {
          const a = Math.atan2(p.getX(i), p.getZ(i));
          p.setY(i, p.getY(i) - hash3(Math.round(a * 4.5), 0, 0, 77) * 0.075 - (Math.abs(a) > 2.6 ? 0.04 : 0));
        }
      }
      g.computeVertexNormals();
      const cols = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const t = p.getY(i) < 0.1 ? 1 : 0; const c = t ? TRIM : COAT; cols.set([lerp(COAT[0], c[0], 0.55), lerp(COAT[1], c[1], 0.55), lerp(COAT[2], c[2], 0.55)], i * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      H.mantle = part(chest, G(g), matCloth, 0, 0, -0.005, { s: [1, 1, 0.86] });
    }
    // амулет
    const am = new THREE.Group(); am.position.set(0, 0.16, 0.142); am.rotation.x = -0.25; chest.add(am);
    const amRing = new THREE.TorusGeometry(0.03, 0.007, 6, 16);
    part(am, G(amRing), matGold);
    H.amuletGem = part(am, G(new THREE.OctahedronGeometry(0.022, 0)), matAmulet, 0, 0, 0.004, { s: [1, 1.3, 0.5] });
    // шея, голова, капюшон
    const neck = joint(hero, 'neck', chest, 0, 0.3, 0.0);
    part(neck, G(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10)), matSkin, 0, 0.02, 0);
    const head = joint(hero, 'head', neck, 0, 0.07, 0.01);
    part(head, G(new THREE.SphereGeometry(0.075, 12, 9)), matSkin, 0, 0.08, -0.035);
    {
      const g = new THREE.SphereGeometry(0.162, 26, 18);
      const p = g.attributes.position;
      const cols = new Float32Array(p.count * 3);
      const peak = new THREE.Vector3(0, 0.62, -0.78).normalize();
      for (let i = 0; i < p.count; i++) {
        _va.set(p.getX(i), p.getY(i), p.getZ(i));
        const d = _vb.copy(_va).normalize();
        let x = _va.x * 1.0, y = _va.y * 1.12, z = _va.z * 1.1;
        const s = d.dot(peak);
        if (s > 0.55) { const k = Math.pow((s - 0.55) / 0.45, 2) * 0.16; x += peak.x * k; y += peak.y * k * 0.8; z += peak.z * k; }
        if (d.y < -0.15) { const f = (-d.y - 0.15); x *= 1 + f * 0.75; z *= 1 + f * 0.6; y -= f * 0.07; }
        // проём лица: глубокая ниша спереди
        const rec = smoothstep(0.35, 0.8, d.z) * (1 - smoothstep(0.32, 0.62, Math.abs(d.y + 0.08)));
        x *= 1 - 0.45 * rec; y = lerp(y, y * 0.9 - 0.005, rec); z *= 1 - 0.55 * rec;
        p.setXYZ(i, x, y, z);
        const shade = lerp(1, 0.035, Math.pow(rec, 0.6));
        cols[i * 3] = COAT[0] * shade; cols[i * 3 + 1] = COAT[1] * shade; cols[i * 3 + 2] = COAT[2] * shade;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      g.computeVertexNormals();
      H.hood = part(head, G(g), matHood, 0, 0.085, -0.005);
      const eyeG = G(new THREE.SphereGeometry(0.0105, 8, 6));
      for (const s of [1, -1]) part(head, eyeG, matHeroEyes, s * 0.03, 0.078, 0.075, { cast: false, s: [1.3, 0.65, 0.5] });
    }
    // руки
    const upperG = G(limbGeo(0.056, 0.048, 0.3, 12)), foreG = G(limbGeo(0.046, 0.037, 0.265, 10));
    const paulG = (() => { const g = new THREE.SphereGeometry(0.105, 14, 8, 0, TAU, 0, Math.PI * 0.56); return G(g); })();
    const sleeveG = (() => {
      const g = lathe([[0.062, 0.03], [0.07, -0.05], [0.09, -0.14], [0.118, -0.215], [0.128, -0.235]], 16);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) < -0.2) { const a = Math.atan2(p.getX(i), p.getZ(i)); p.setY(i, p.getY(i) - 0.035 * Math.max(0, -Math.cos(a)) - hash3(Math.round(a * 3), 1, 0, 91) * 0.02); }
      g.computeVertexNormals();
      const cols = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { const tr = p.getY(i) < -0.2 ? 0.5 : 0; cols.set([lerp(COAT[0], TRIM[0], tr), lerp(COAT[1], TRIM[1], tr), lerp(COAT[2], TRIM[2], tr)], i * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      return G(g);
    })();
    const bracerG = G(new THREE.CylinderGeometry(0.046, 0.042, 0.075, 10));
    const handG = G(chiseled(0.036, 0.095, 0.075, { bevel: 0.012, jitter: 0.002, taperTop: 0.9 }));
    const thumbG = G(limbGeo(0.014, 0.012, 0.05, 6));
    const gemG = G(new THREE.OctahedronGeometry(0.013, 0));
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const sh = joint(hero, 'sh' + side, chest, s * 0.2, 0.235, -0.005, 'YXZ');
      part(sh, paulG, matIron, s * 0.02, 0.02, 0, { s: [1.12, 0.6, 1.08], rz: s * -0.3 });
      part(sh, upperG, matCoat);
      const el = joint(hero, 'el' + side, sh, 0, -0.3, 0);
      part(el, foreG, matTunic);
      part(el, sleeveG, matCloth, 0, 0, 0);
      part(el, bracerG, matLeather, 0, -0.205, 0);
      const wr = joint(hero, 'wr' + side, el, 0, -0.265, 0);
      const gm = side === 'L' ? matGloveL : matGloveR;
      part(wr, handG, gm, 0, -0.05, 0.004);
      part(wr, thumbG, gm, -s * 0.004, -0.015, 0.035, { rx: -0.5, rz: -s * 0.25 });
      part(wr, gemG, gm, s * 0.021, -0.045, 0.0, { cast: false });
      const glow = new THREE.Sprite(side === 'L' ? matHandGlowL : matHandGlowR);
      glow.position.set(0, -0.07, 0.01); glow.scale.setScalar(0.34);
      glow.renderOrder = 3;
      wr.add(glow);
      H['glow' + side] = glow;
      marker(hero, 'hand' + side, wr, 0, -0.08, 0.01);
    }
    marker(hero, 'chestFront', chest, 0, 0.16, 0.16);
    marker(hero, 'headTop', head, 0, 0.26, 0);
  }

  // Юбки: туника (замкнутая, до колена) и распахнутые полы пальто (до середины голени).
  function makeSkirt(o) {
    const cols = o.cols, rows = o.rows;
    const geo = makeClothGrid(cols, rows, [o.closed ? 3 : 2.4, 1.2], (u, v) => {
      const trim = o.trim && v > 0.84 && v < 0.93 ? 0.55 : 0;
      const dirt = v > 0.93 ? 0.8 : 1;
      const c = o.color;
      return [lerp(c[0], TRIM[0], trim) * dirt, lerp(c[1], TRIM[1], trim) * dirt, lerp(c[2], TRIM[2], trim) * dirt];
    });
    const ang = new Float32Array(cols + 1), Lc = new Float32Array(cols + 1);
    for (let c = 0; c <= cols; c++) {
      ang[c] = o.closed ? (c / cols) * TAU : lerp(o.a0, o.a1, c / cols);
      const tat = o.tatter ? hash3(c, 3, 7, o.seed) * o.tatter + ((c & 1) ? o.tatter * 0.5 : 0) : 0;
      Lc[c] = o.L * (1 - tat) * (o.closed ? 1 : 1 + 0.06 * Math.max(0, -Math.cos(ang[c])));
    }
    if (o.closed) { Lc[cols] = Lc[0]; }
    const mesh = new THREE.Mesh(geo, matCloth);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    o.parent.add(mesh);
    return { mesh, geo, o, ang, Lc, off: new THREE.Vector2(), vel: new THREE.Vector2() };
  }
  const hipsJ = hero.j[JI.hips];
  const tunic = makeSkirt({ parent: hipsJ, cols: 22, rows: 6, closed: true, r0: 0.168, r1: 0.275, L: 0.5, y0: 0.045, color: TUNIC, tatter: 0.07, seed: 3 });
  const coatSkirt = makeSkirt({ parent: hipsJ, cols: 20, rows: 8, closed: false, a0: deg(34), a1: deg(326), r0: 0.19, r1: 0.4, L: 0.8, y0: 0.07, color: COAT, trim: true, tatter: 0.09, seed: 5 });
  const legTmp = { L: { p0: new THREE.Vector3(), k: new THREE.Vector3(), a: new THREE.Vector3(), shin: -0.42 }, R: { p0: new THREE.Vector3(), k: new THREE.Vector3(), a: new THREE.Vector3(), shin: -0.42 } };
  const _lp = new THREE.Vector3();

  function deformSkirt(sk, time, flutterAmp) {
    const { o, ang, Lc, off } = sk;
    const p = sk.geo.attributes.position.array;
    const cols = o.cols, rows = o.rows;
    const legs = [legTmp.L, legTmp.R];
    for (let c = 0; c <= cols; c++) {
      const a = ang[c], sa = Math.sin(a), ca = Math.cos(a);
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        let rr = lerp(o.r0, o.r1, t);
        const y = o.y0 - Lc[c] * t;
        for (const L of legs) {
          legAtY(L, y, _lp);
          const proj = _lp.x * sa + _lp.z * ca;
          const lat = Math.abs(_lp.x * ca - _lp.z * sa);
          const legR = 0.1 + 0.02 * t;
          if (lat < legR && proj > 0) { const need = proj + Math.sqrt(legR * legR - lat * lat); if (need > rr) rr = need; }
        }
        const w = Math.pow(t, 1.4);
        const fl = flutterAmp * t * Math.sin(time * 3.1 + a * 3 + t * 2.3);
        let x = sa * rr + off.x * w + ca * fl;
        let z = ca * rr + off.y * w - sa * fl;
        const yy = y + (Math.abs(off.x) + Math.abs(off.y)) * 0.35 * w * t;
        const i = (r * (cols + 1) + c) * 3;
        p[i] = x; p[i + 1] = yy; p[i + 2] = z;
      }
    }
    sk.geo.attributes.position.needsUpdate = true;
  }

  // Плащ за спиной: вершины считаются в пространстве heroRoot от точек крепления на груди.
  const CAPE_COLS = 12, CAPE_ROWS = 14;
  const capeGeo = makeClothGrid(CAPE_COLS, CAPE_ROWS, [1.6, 2.2], (u, v) => {
    const trim = v > 0.86 && v < 0.92 ? 0.6 : 0;
    const edge = (u < 0.04 || u > 0.96) ? 0.35 : 0;
    const t = Math.max(trim, edge);
    const shade = lerp(1.08, 0.82, v) * (v > 0.93 ? 0.75 : 1);
    return [lerp(CAPE[0], TRIM[0], t) * shade, lerp(CAPE[1], TRIM[1], t) * shade, lerp(CAPE[2], TRIM[2], t) * shade];
  });
  const cape = new THREE.Mesh(capeGeo, matCapeRune);
  cape.name = 'hero-cape';
  cape.castShadow = true; cape.receiveShadow = true;
  cape.frustumCulled = false;
  heroRoot.add(cape);
  const capeAnch = [], capeLc = new Float32Array(CAPE_COLS + 1);
  for (let c = 0; c <= CAPE_COLS; c++) {
    const u = (c / CAPE_COLS) * 2 - 1;
    capeAnch.push(new THREE.Vector3(u * 0.215, 0.205 - 0.035 * u * u, -0.2 + 0.07 * u * u));
    const tat = hash3(c, 9, 1, 13) * 0.09 + ((c & 1) ? 0.045 : 0) + (Math.abs(u) > 0.8 ? 0.05 : 0);
    capeLc[c] = 1.36 * (1 - tat);
  }
  const capeState = { off: new THREE.Vector2(), vel: new THREE.Vector2() };
  const _inv = new THREE.Matrix4(), _cm = new THREE.Matrix4(), _hm = new THREE.Matrix4(), _cv = new THREE.Vector3();
  const _hipsLocal = new THREE.Vector3(), _legK = { L: new THREE.Vector3(), R: new THREE.Vector3() }, _legA = { L: new THREE.Vector3(), R: new THREE.Vector3() };

  function deformCape(time, flutterAmp) {
    _inv.copy(heroRoot.matrixWorld).invert();
    _cm.multiplyMatrices(_inv, hero.j[JI.chest].matrixWorld);
    _hm.multiplyMatrices(_inv, hipsJ.matrixWorld);
    _hipsLocal.setFromMatrixPosition(_hm);
    for (const s of ['L', 'R']) _legK[s].setFromMatrixPosition(hero.markers['knee' + s].matrixWorld).applyMatrix4(_inv);
    const p = capeGeo.attributes.position.array;
    const off = capeState.off;
    const hipsZ = _hipsLocal.z, hipsY = _hipsLocal.y;
    for (let c = 0; c <= CAPE_COLS; c++) {
      const u = (c / CAPE_COLS) * 2 - 1;
      _cv.copy(capeAnch[c]).applyMatrix4(_cm);
      const ax = _cv.x, ay = _cv.y, az = _cv.z;
      for (let r = 0; r <= CAPE_ROWS; r++) {
        const t = r / CAPE_ROWS;
        const w = Math.pow(t, 1.25);
        let x = ax + u * 0.2 * t;
        let y = ay - capeLc[c] * t;
        let z = az - (0.07 + 0.07 * (1 - u * u)) * t + 0.06 * u * u * t;
        const fl = flutterAmp * t * Math.sin(time * 2.6 + u * 2.2 + t * 3.1);
        x += off.x * w; z += off.y * w + fl;
        y += (Math.abs(off.x) * 0.25 + Math.max(0, -off.y) * 0.45) * w * t;
        // не входить в корпус и полы пальто
        const skirtT = clamp((hipsY + 0.07 - y) / 0.8, 0, 1);
        let zMax;
        if (y > hipsY + 0.07) zMax = lerp(hipsZ - 0.19, az, clamp((y - hipsY - 0.07) / Math.max(0.05, ay - hipsY - 0.07), 0, 1)) - 0.02;
        else zMax = hipsZ - (0.2 + 0.21 * skirtT) - 0.04;
        for (const s of ['L', 'R']) {
          const K2 = _legK[s];
          if (y < K2.y + 0.25 && Math.abs(x - K2.x) < 0.16) zMax = Math.min(zMax, K2.z - 0.13);
        }
        if (z > zMax) z = zMax;
        const i = (r * (CAPE_COLS + 1) + c) * 3;
        p[i] = x; p[i + 1] = y; p[i + 2] = z;
      }
    }
    capeGeo.attributes.position.needsUpdate = true;
  }

  // Пятна-тени под персонажами (читаемость контакта с полом при выключенных тенях).
  const blobGeo = G(new THREE.PlaneGeometry(1, 1));
  blobGeo.rotateX(-Math.PI / 2);
  const heroBlob = new THREE.Mesh(blobGeo, matBlob);
  heroBlob.position.y = 0.012; heroBlob.scale.set(1.15, 1, 1.15); heroBlob.renderOrder = 1;
  heroRoot.add(heroBlob);

  /* ================================ БОСС ================================ */
  // Регент Нимба ~7.4 м до верха нимба (невидимые бёдра на 2.25 м), модель смотрит в +Z.
  const bossRoot = new THREE.Group();
  bossRoot.name = 'boss';
  bossRoot.scale.setScalar(num(wc.bossScale, 1));
  root.add(bossRoot);
  const bossBody = new THREE.Group();
  bossBody.name = 'boss-body';
  bossRoot.add(bossBody);
  const boss = makeRig(bossRoot, bossBody);
  const B = { fistGlow: {}, frags: [] };
  const matFistGlow = M(new THREE.SpriteMaterial({ map: texGlow, color: 0xff9a4a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));

  {
    const cs = (w, h, d, o = {}) => chiseled(w, h, d, Object.assign({ uvScale: 1.3, seg: 3 }, o));
    // Регент Нимба (Visual Bible, разд. 7): тела нет — парящая реликвия на невидимом скелете.
    // Суставы и точки контакта прежние (позы атак и логика boss.js не меняются), видимы только
    // маска, нимб, мантия, позвонки-реликварий и две сорванные со статуй каменные кисти.
    const hips = joint(boss, 'hips', bossBody, 0, 2.25, 0);
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const th = joint(boss, 'th' + side, hips, s * 0.45, -0.2, 0);
      const kn = joint(boss, 'kn' + side, th, 0, -0.95, 0);
      marker(boss, 'knee' + side, kn, 0, -0.1, 0.26, true);
      const an = joint(boss, 'an' + side, kn, 0, -0.85, 0);
      marker(boss, 'heel' + side, an, 0, -0.25, -0.28, true);
      marker(boss, 'toe' + side, an, 0, -0.25, 0.58, true);
    }
    const spine = joint(boss, 'spine', hips, 0, 0.3, 0);
    const chest = joint(boss, 'chest', spine, 0, 0.5, 0);
    B.verts = [];
    {
      // Семь позвонков вместо тела: покачиваются со сдвигом фаз (updateBoss).
      const vg = G(cs(0.5, 0.2, 0.42, { bevel: 0.05, jitter: 0.03, taperTop: 0.86, seed: 261 }));
      const pg = G(new THREE.ConeGeometry(0.07, 0.34, 4).rotateX(-Math.PI / 2 - 0.5));
      const ringG = G(new THREE.TorusGeometry(0.29, 0.022, 6, 22).rotateX(Math.PI / 2));
      const slots = [[chest, 0.62], [chest, 0.34], [chest, 0.06], [spine, 0.2], [spine, -0.06], [hips, -0.05], [hips, -0.34]];
      slots.forEach(([par, y], i) => {
        const g = new THREE.Group();
        g.position.set(0, y, -0.05);
        par.add(g);
        const k = 1 - Math.abs(i - 2.5) * 0.07;
        part(g, vg, matBossDark, 0, 0, 0, { s: [k, 1, k] });
        part(g, pg, matBossDark, 0, 0.02, -0.26, { s: k });
        if (i % 2 === 0) part(g, ringG, matGold, 0, 0, 0, { s: k * 1.12, cast: false });
        B.verts.push({ g, y, phase: i * 0.9 });
      });
    }
    // Реликварий с «украденным солнцем» — слабая точка второй фазы.
    {
      const med = new THREE.Group();
      med.position.set(0, 0.36, 0.06);
      chest.add(med);
      const cage = new THREE.Group();
      med.add(cage);
      B.cage = cage;
      const rg = G(new THREE.TorusGeometry(0.36, 0.028, 6, 30));
      part(cage, rg, matGold, 0, 0, 0, { cast: false });
      part(cage, rg, matGold, 0, 0, 0, { ry: Math.PI / 2, cast: false });
      part(cage, rg, matGold, 0, 0, 0, { rx: Math.PI / 2, s: 0.86, cast: false });
      B.core = part(med, G(new THREE.IcosahedronGeometry(0.19, 1)), matBossCore, 0, 0, 0, { cast: false });
      const sig = part(med, G(new THREE.PlaneGeometry(1.2, 1.2)), matChestSigil, 0, 0, 0.3, { cast: false, receive: false });
      sig.visible = false;
      const glow = new THREE.Sprite(matCoreGlow);
      glow.position.set(0, 0, 0.12); glow.scale.setScalar(1.1); glow.renderOrder = 3;
      med.add(glow);
      B.coreGlow = glow;
      const light = new THREE.PointLight(0xffd9a0, 6 * LI.point, 10, 2);
      light.position.set(0, -0.1, 1.2);
      med.add(light);
      B.coreLight = light;
      marker(boss, 'core', med, 0, 0, 0.2);
    }
    // Мантия на невидимых плечах: открыта спереди (видна пустота с позвонками), рваный тлеющий подол.
    {
      const COLS = 30, ROWS = 18, A0 = deg(38), A1 = deg(322), TOP = 0.98, BOT = -2.45;
      const pos = [], uv = [], idx = [];
      for (let r = 0; r <= ROWS; r++) {
        const v = r / ROWS;
        const y = lerp(TOP, BOT, v);
        const rad = lerp(0.6, 1.5, Math.pow(v, 0.8)) + Math.sin(v * 9) * 0.02;
        for (let c = 0; c <= COLS; c++) {
          const u = c / COLS;
          const a = lerp(A0, A1, u);
          const fold = Math.sin(u * TAU * 5.5 + v * 1.7) * 0.07 * (0.3 + v);
          pos.push(Math.sin(a) * (rad + fold), y, Math.cos(a) * (rad + fold) - 0.12);
          uv.push(u, 1 - v);
          if (r < ROWS && c < COLS) { const b = r * (COLS + 1) + c; idx.push(b, b + COLS + 1, b + 1, b + 1, b + COLS + 1, b + COLS + 2); }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      // рваный край, дыры и тлеющая кромка — одна карта: R — маска ткани, G — угли по краю разрыва
      const S2 = 256, cc = makeCanvas(S2, S2), cx = cc.getContext('2d');
      const im = cx.createImageData(S2, S2), d = im.data, nz = makeNoise(wc.seed + 271);
      for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) {
        const u = x / S2, v = 1 - y / S2; // v: 0 — ворот, 1 — подол
        const n = nz.fbm(u * 9, v * 5, 9, 4), strip = 0.5 + 0.5 * Math.sin(u * TAU * 11 + n * 3);
        const cut = Math.pow(Math.max(0, v - 0.5) / 0.5, 1.6) * (0.55 + 0.35 * strip) + (nz.n2(u * 26, v * 18, 26) > 0.86 ? 0.35 : 0) * v;
        const keep = n * 0.5 + 0.5 - cut;
        const i = (y * S2 + x) * 4;
        const on = keep > 0.36;
        d[i] = on ? 255 : 0;
        d[i + 1] = on ? clamp((0.44 - keep) / 0.08, 0, 1) * 255 : 0;
        d[i + 2] = 0; d[i + 3] = 255;
      }
      cx.putImageData(im, 0, 0);
      const tMask = tex(cc, { srgb: false, repeat: false });
      const matMantle = std({
        color: 0x3a322d, map: texCloth, alphaMap: tMask, alphaTest: 0.5, side: THREE.DoubleSide,
        emissive: 0xff6a2a, emissiveMap: tMask, emissiveIntensity: 2.2, roughness: 0.95, metalness: 0,
      });
      // alphaMap читает G, а маска ткани лежит в R; угли — в G эмиссии. Меняем каналы и добавляем ветер.
      const windU = { value: 0 }, burnU = { value: 0 };
      matMantle.userData.wind = windU;
      matMantle.userData.burn = burnU;
      matMantle.onBeforeCompile = (sh) => {
        sh.uniforms.ashWind = windU;
        sh.uniforms.ashBurn = burnU;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float ashWind;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float w = smoothstep( ${TOP.toFixed(2)}, ${BOT.toFixed(2)}, position.y );
    float ph = atan( position.x, position.z );
    transformed.x += sin( ashWind * 1.3 + ph * 3.0 + position.y * 1.7 ) * 0.09 * w * w;
    transformed.z += cos( ashWind * 1.1 + ph * 2.0 + position.y * 2.3 ) * 0.07 * w * w;
    transformed.y += sin( ashWind * 2.1 + ph * 5.0 ) * 0.03 * w;
  }`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float ashBurn;')
          .replace('#include <alphamap_fragment>', `#ifdef USE_ALPHAMAP
  float ashBurnLine = ashBurn * 0.55 + ( sin( vAlphaMapUv.x * 41.0 ) + sin( vAlphaMapUv.x * 17.0 + 1.3 ) ) * 0.02 * step( 0.001, ashBurn );
  float ashBurnt = step( vAlphaMapUv.y, ashBurnLine );
  float ashEmber = ( 1.0 - smoothstep( 0.0, 0.05, vAlphaMapUv.y - ashBurnLine ) ) * step( 0.001, ashBurn );
  diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).r * ( 1.0 - ashBurnt );
#endif`)
          .replace('#include <emissivemap_fragment>', `#ifdef USE_EMISSIVEMAP
  totalEmissiveRadiance *= vec3( max( texture2D( emissiveMap, vEmissiveMapUv ).g, ashEmber * 1.4 ) );
#endif`);
      };
      matMantle.customProgramCacheKey = () => 'ashMantle';
      B.mantleMat = matMantle;
      const mantle = part(chest, G(g), matMantle, 0, 0, 0);
      mantle.name = 'regent-mantle';
      B.mantle = mantle;
    }
    // шея, капюшон и фарфоровая маска со щелью
    const neck = joint(boss, 'neck', chest, 0, 1.18, 0.06);
    const head = joint(boss, 'head', neck, 0, 0.24, 0.04);
    {
      const hood = lathe([[0.0005, 1.12], [0.3, 1.06], [0.52, 0.86], [0.62, 0.5], [0.64, 0.12], [0.62, -0.28]], 20);
      const hp = hood.attributes.position;
      for (let i = 0; i < hp.count; i++) { if (hp.getZ(i) > 0.12) hp.setZ(i, 0.12 + (hp.getZ(i) - 0.12) * 0.25); }
      hood.computeVertexNormals();
      // капюшон — своя ткань: у LatheGeometry другие UV, рваный подол мантии на нём давал дыры
      B.hoodMat = std({ color: 0x3a322d, map: texCloth, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
      part(head, G(hood), B.hoodMat, 0, -0.1, -0.2, { s: [0.82, 0.84, 0.78] });

      const ms = new THREE.Shape();
      ms.moveTo(0, -0.72);
      ms.quadraticCurveTo(0.3, -0.62, 0.36, -0.1);
      ms.quadraticCurveTo(0.4, 0.42, 0.18, 0.62);
      ms.quadraticCurveTo(0, 0.7, -0.18, 0.62);
      ms.quadraticCurveTo(-0.4, 0.42, -0.36, -0.1);
      ms.quadraticCurveTo(-0.3, -0.62, 0, -0.72);
      const slit = new THREE.Path();
      slit.moveTo(-0.26, 0.1); slit.quadraticCurveTo(0, 0.07, 0.26, 0.1); slit.lineTo(0.25, 0.135);
      slit.quadraticCurveTo(0, 0.115, -0.25, 0.135); slit.lineTo(-0.26, 0.1);
      ms.holes.push(slit);
      const mg = new THREE.ExtrudeGeometry(ms, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 3, curveSegments: 14 });
      const mp = mg.attributes.position;
      for (let i = 0; i < mp.count; i++) { const x = mp.getX(i), y = mp.getY(i); mp.setZ(i, mp.getZ(i) - x * x * 1.1 - y * y * 0.18); }
      mg.computeVertexNormals();
      boxProjectUV(mg, 1.1);
      part(head, G(mg), matBossMask, 0, 0.36, 0.3, { rx: -0.08, s: 0.76 });
      part(head, G(new THREE.PlaneGeometry(0.38, 0.045)), matBossEyes, 0, 0.45, 0.36, { cast: false, rx: -0.08 });
      // вторая фаза: маска раскалывается по вертикали, за ней светит «украденное солнце»
      const crackShape = new THREE.Shape();
      crackShape.moveTo(0, 0.5); crackShape.lineTo(0.035, 0.24); crackShape.lineTo(-0.02, 0.02); crackShape.lineTo(0.03, -0.22);
      crackShape.lineTo(-0.01, -0.52); crackShape.lineTo(-0.03, -0.22); crackShape.lineTo(0.012, 0.02); crackShape.lineTo(-0.035, 0.24); crackShape.lineTo(0, 0.5);
      B.maskCrack = part(head, G(new THREE.ShapeGeometry(crackShape)), matMaskCrack, 0, 0.36, 0.39, { cast: false, receive: false, rx: -0.08 });
      B.maskCrack.visible = false;
      B.maskCrack.renderOrder = 3;
      B.sunGlow = new THREE.Sprite(matSunGlow);
      B.sunGlow.position.set(0, 0.4, 0.12);
      B.sunGlow.scale.setScalar(0.01);
      B.sunGlow.renderOrder = 2;
      head.add(B.sunGlow);
      marker(boss, 'headTop', head, 0, 0.95, 0.1);
    }
    // треснувший бронзовый нимб: 12 сегментов, 3 камня-замка, горящая внутренняя кромка
    {
      const halo = new THREE.Group();
      halo.name = 'boss-halo';
      halo.position.set(0, 3.05, -0.6);
      chest.add(halo);
      const ring = new THREE.Group();
      halo.add(ring);
      // две половины: A — сегменты 0–5 (верх), B — 6, 8–11; сегмент 7 выпал ещё до боя
      const halfA = new THREE.Group(), halfB = new THREE.Group();
      ring.add(halfA, halfB);
      B.haloHalves = [halfA, halfB];
      const R0 = 1.1, N = 12;
      const segRnd = mulberry32(wc.seed + 281);
      for (let i = 0; i < N; i++) {
        if (i === 7) continue; // выпавший сегмент — трещина нимба
        const a0 = (i / N) * TAU + 0.035, a1 = ((i + 1) / N) * TAU - 0.035;
        const sg = new THREE.TorusGeometry(R0, 0.095, 5, 8, a1 - a0);
        sg.scale(1, 1, 1.6);
        const m = part(i < 6 ? halfA : halfB, G(sg), matHaloBronze, 0, 0, 0, { rz: a0, receive: false });
        if (i === 6 || i === 8) { m.position.set(Math.cos(a0) * 0.05, Math.sin(a0) * 0.05, (segRnd() - 0.5) * 0.12); m.rotation.x = (segRnd() - 0.5) * 0.12; }
      }
      const edgeArc = (grp, from, to) => part(grp, G(new THREE.TorusGeometry(R0 - 0.11, 0.02, 4, Math.max(8, Math.round(96 * (to - from))), TAU * (to - from))), matHaloEdge, 0, 0, 0.02, { rz: from * TAU, cast: false, receive: false });
      edgeArc(halfA, 0, 6 / 12);
      edgeArc(halfB, 6 / 12, 7 / 12);
      edgeArc(halfB, 8 / 12, 1);
      const keyG = G(cs(0.3, 0.38, 0.26, { bevel: 0.05, jitter: 0.02, seed: 291 }));
      const sealG = G(new THREE.CircleGeometry(0.11, 20));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + Math.PI / 2;
        const grp = k === 0 ? halfA : halfB;
        part(grp, keyG, matBossDark, Math.cos(a) * R0, Math.sin(a) * R0, 0, { rz: a - Math.PI / 2 });
        const seal = part(grp, sealG, matSeal, Math.cos(a) * R0, Math.sin(a) * R0, 0.14, { cast: false, receive: false });
        seal.renderOrder = 3;
      }
      B.halo = halo;
      B.haloRing = ring;
    }
    // Каменные кисти колоссов на невидимых руках: ладонь, четыре пальца по две фаланги, большой палец.
    B.fingers = { L: [], R: [] };
    const palmG = G(cs(0.95, 1.0, 0.36, { bevel: 0.1, jitter: 0.03, taperTop: 1.12, seed: 301 }));
    const cuffG = G(cs(0.78, 0.3, 0.42, { bevel: 0.07, jitter: 0.04, seed: 303 }));
    const ph1G = (() => { const g = cs(0.2, 0.52, 0.22, { bevel: 0.05, jitter: 0.015, taperTop: 1.1, seed: 305 }); g.translate(0, -0.26, 0); return G(g); })();
    const ph2G = (() => { const g = cs(0.18, 0.44, 0.2, { bevel: 0.05, jitter: 0.015, taperTop: 1.18, seed: 307 }); g.translate(0, -0.22, 0); return G(g); })();
    const sealPalmG = G(new THREE.CircleGeometry(0.3, 28));
    for (const [s, side] of [[1, 'L'], [-1, 'R']]) {
      const sh = joint(boss, 'sh' + side, chest, s * 1.02, 0.86, 0, 'YXZ');
      const el = joint(boss, 'el' + side, sh, 0, -1.1, 0);
      const wr = joint(boss, 'wr' + side, el, 0, -1.0, 0);
      const hand = new THREE.Group();
      hand.scale.setScalar(0.78);
      wr.add(hand);
      part(hand, cuffG, matBossDark, 0, -0.1, 0);
      part(hand, palmG, matBoss, 0, -0.72, 0);
      for (let f = 0; f < 4; f++) {
        const fx = (f - 1.5) * 0.225 * s;
        const len = f === 1 || f === 2 ? 1 : 0.86;
        const base = new THREE.Group();
        base.position.set(fx, -1.2, 0);
        base.scale.setScalar(len);
        hand.add(base);
        part(base, ph1G, matBoss);
        const mid = new THREE.Group();
        mid.position.set(0, -0.52, 0);
        base.add(mid);
        part(mid, ph2G, matBoss);
        B.fingers[side].push({ base, mid, k: 0.8 + f * 0.1 });
      }
      const th = new THREE.Group();
      th.position.set(s * 0.5, -0.55, -0.05);
      th.rotation.set(0, 0, s * 0.7);
      hand.add(th);
      part(th, ph1G, matBoss, 0, 0, 0, { s: 1.1 });
      const thm = new THREE.Group(); thm.position.set(0, -0.56, 0); th.add(thm);
      part(thm, ph2G, matBoss);
      B.fingers[side].push({ base: th, mid: thm, k: 0.6, thumb: true });
      // печать в ладони (ладонь смотрит в -Z кисти): видна, когда ладонь раскрыта к игроку
      const seal = part(hand, sealPalmG, matSeal, 0, -0.72, -0.2, { ry: Math.PI, cast: false, receive: false });
      seal.renderOrder = 3;
      const fg = new THREE.Sprite(matFistGlow.clone());
      M(fg.material);
      fg.position.set(0, -0.58, -0.28); fg.scale.setScalar(1.4); fg.renderOrder = 3;
      wr.add(fg);
      B.fistGlow[side] = fg;
      marker(boss, 'fist' + side, wr, 0, -0.6, 0);
    }
    // парящие обломки
    const orbit = new THREE.Group();
    orbit.name = 'boss-fragments';
    orbit.position.set(0, 4.35, -0.1);
    orbit.rotation.set(0.18, 0, 0.1);
    bossBody.add(orbit);
    B.orbit = orbit;
    for (let i = 0; i < 4; i++) {
      const f = part(orbit, G(rockGeo(0.13 + (i % 3) * 0.04, 0, 251 + i, 1)), matBossDark);
      f.userData.phase = (i / 4) * TAU;
      f.userData.r = 2.3 + (i % 2) * 0.3;
      B.frags.push(f);
    }
  }
  const bossBlob = new THREE.Mesh(blobGeo, matBlob);
  bossBlob.position.y = 0.014; bossBlob.scale.set(4.6, 1, 4.6); bossBlob.renderOrder = 1;
  bossRoot.add(bossBlob);

  // Отваливающиеся при смерти части (гало, обломки): запоминаем исходный родитель и трансформ.
  const fallPieces = [B.halo, ...B.frags].map((obj, i) => ({
    obj, parent: obj.parent, pos: obj.position.clone(), quat: obj.quaternion.clone(), scl: obj.scale.clone(),
    v: new THREE.Vector3(), w: new THREE.Vector3(), rest: i === 0 ? 0.07 : 0.14, active: false, settled: false,
    flat: new THREE.Quaternion(), seed: i,
  }));

  /* ================================ ПОЗЫ ================================ */
  const HP = {
    idle: mkPose({ off: [0, 0, 0], body: [0, 0, 0], hips: [0.03, 0, 0], spine: [0.05, 0, 0], chest: [0.02, 0, 0], neck: [0.02, 0, 0], head: [-0.04, 0, 0],
      shL: [0.06, 0, 0.1], shR: [-0.12, 0.1, -0.14], elL: [-0.3, 0, 0], elR: [-0.75, 0, 0], wrL: [0, 0, 0.05], wrR: [-0.15, 0, 0],
      'th*': [-0.04, 0, 0.06], 'kn*': [0.1, 0, 0], 'an*': [-0.06, 0, -0.06] }),
    victory: mkPose({ spine: [0.0, 0, 0], chest: [-0.06, 0, 0], neck: [-0.05, 0, 0], head: [-0.16, 0, 0], 'sh*': [0.02, 0, 0.12], 'el*': [-0.22, 0, 0], 'wr*': [0, 0, 0], 'th*': [-0.02, 0, 0.07], 'kn*': [0.04, 0, 0] }),
    cast: mkPose({ spine: [0.06, 0.14, 0], chest: [0.02, 0.2, 0], neck: [0, -0.14, 0], head: [0.0, -0.18, 0],
      shR: [-1.48, -0.16, -0.05], elR: [-0.1, 0, 0], wrR: [-0.35, 0, 0], shL: [0.15, 0, 0.32], elL: [-0.7, 0, 0],
      thL: [-0.2, 0, 0.08], thR: [0.12, 0, -0.09], knL: [0.22, 0, 0], knR: [0.14, 0, 0] }),
    castArm: mkPose({ shR: [-1.45, -0.05, -0.05], elR: [-0.12, 0, 0], wrR: [-0.35, 0, 0] }),
    shield: mkPose({ spine: [0.08, -0.12, 0], chest: [0.04, -0.16, 0], neck: [0, 0.12, 0], head: [0.02, 0.14, 0],
      shL: [-1.35, -0.12, 0.12], elL: [-0.9, 0, 0], wrL: [-0.45, 0, 0], shR: [-0.25, 0, -0.3], elR: [-1.2, 0, 0], wrR: [-0.2, 0, 0],
      'th*': [-0.16, 0, 0.14], 'kn*': [0.38, 0, 0], 'an*': [-0.22, 0, -0.12], off: [0, 0, -0.02] }),
    gather: mkPose({ hips: [0.1, 0, 0], spine: [0.4, 0, 0], chest: [0.18, 0, 0], neck: [0.1, 0, 0], head: [0.25, 0, 0],
      'sh*': [0.35, 0, 0.38], 'el*': [-1.3, 0, 0], 'wr*': [-0.3, 0, 0], 'th*': [-0.55, 0, 0.16], 'kn*': [1.0, 0, 0], 'an*': [-0.45, 0, -0.1] }),
    release: mkPose({ hips: [0, 0, 0], spine: [-0.18, 0, 0], chest: [-0.2, 0, 0], neck: [-0.05, 0, 0], head: [-0.3, 0, 0],
      'sh*': [-2.35, 0, 0.5], 'el*': [-0.12, 0, 0], 'wr*': [-0.45, 0, 0], 'th*': [-0.06, 0, 0.2], 'kn*': [0.06, 0, 0], 'an*': [0.0, 0, -0.18] }),
    dead: mkPose({ off: [0, 0, 0], body: [0.06, 0, 0], hips: [0.12, 0, 0], spine: [0.42, 0, 0], chest: [0.3, 0, 0], neck: [0.3, 0, 0], head: [0.42, 0, 0.14],
      shL: [0.12, 0, 0.14], elL: [-0.2, 0, 0], wrL: [0, 0, 0], shR: [-0.55, 0.2, -0.05], elR: [-0.6, 0, 0], wrR: [-0.3, 0, 0],
      thL: [-1.5, 0, 0.12], knL: [1.58, 0, 0], anL: [-0.08, 0, -0.1], thR: [-0.02, 0, -0.08], knR: [1.62, 0, 0], anR: [0.75, 0, 0.05] }),
    hit: mkPose({ spine: [-0.24, 0, 0], chest: [-0.12, 0, 0], neck: [-0.08, 0, 0], head: [-0.22, 0, 0.1], 'sh*': [0.35, 0, 0.3], 'el*': [-0.35, 0, 0], 'kn*': [0.12, 0, 0], body: [-0.06, 0, 0], off: [0, 0, -0.07] }),
    castKick: mkPose({ shR: [0.28, 0, 0], elR: [-0.45, 0, 0], wrR: [-0.25, 0, 0], chest: [-0.05, 0.08, 0] }),
    blockKick: mkPose({ shL: [0.32, 0, 0], elL: [-0.35, 0, 0], spine: [-0.1, 0, 0], chest: [-0.05, 0, 0], off: [0, 0, -0.05] }),
  };
  const hDash = fullPose(), hBurst = fullPose(), hGait = fullPose(), hMisc = fullPose();
  const BP = {
    idle1: mkPose({ off: [0, 0, 0], body: [0, 0, 0], hips: [0.04, 0, 0], spine: [0.06, 0, 0], chest: [0.06, 0, 0], neck: [0.05, 0, 0], head: [0.1, 0, 0],
      'sh*': [0.08, 0, 0.2], 'el*': [-0.38, 0, 0], 'wr*': [0.1, 0, 0], 'th*': [-0.12, 0, 0.07], 'kn*': [0.24, 0, 0], 'an*': [-0.12, 0, -0.07] }),
    idle2: mkPose({ off: [0, 0, 0.05], hips: [0.1, 0, 0], spine: [0.2, 0, 0], chest: [0.14, 0, 0], neck: [-0.05, 0, 0], head: [-0.1, 0, 0],
      'sh*': [-0.28, 0, 0.42], 'el*': [-0.95, 0, 0], 'wr*': [0.25, 0, 0], 'th*': [-0.38, 0, 0.2], 'kn*': [0.68, 0, 0], 'an*': [-0.3, 0, -0.2] }),
    slamA: mkPose({ hips: [0, 0, 0], spine: [-0.12, 0, 0], chest: [-0.14, 0, 0], neck: [0.05, 0, 0], head: [0.15, 0, 0], 'sh*': [-2.3, 0, 0.32], 'el*': [-0.85, 0, 0], 'wr*': [-0.3, 0, 0],
      'th*': [-0.08, 0, 0.12], 'kn*': [0.18, 0, 0], 'an*': [-0.1, 0, -0.12] }),
    slamB: mkPose({ spine: [-0.28, 0, 0], chest: [-0.2, 0, 0], head: [0.2, 0, 0], 'sh*': [-2.85, 0, 0.18], 'el*': [-1.15, 0, 0], 'wr*': [-0.45, 0, 0],
      'th*': [-0.04, 0, 0.14], 'kn*': [0.1, 0, 0], 'an*': [-0.04, 0, -0.14], off: [0, 0, -0.1] }),
    slamHit: mkPose({ hips: [0.25, 0, 0], spine: [0.55, 0, 0], chest: [0.35, 0, 0], neck: [-0.15, 0, 0], head: [-0.3, 0, 0], 'sh*': [-1.05, 0, 0.14], 'el*': [-0.12, 0, 0], 'wr*': [0.1, 0, 0],
      'th*': [-0.75, 0, 0.26], 'kn*': [1.15, 0, 0], 'an*': [-0.42, 0, -0.26], off: [0, 0, 0.25] }),
    slamRec: mkPose({ hips: [0.15, 0, 0], spine: [0.35, 0, 0], chest: [0.2, 0, 0], head: [-0.15, 0, 0], 'sh*': [-0.55, 0, 0.3], 'el*': [-0.35, 0, 0], 'th*': [-0.45, 0, 0.2], 'kn*': [0.75, 0, 0], 'an*': [-0.3, 0, -0.2] }),
    orbA: mkPose({ spine: [0.05, -0.2, 0], chest: [0.02, -0.42, 0], neck: [0, 0.2, 0], head: [0.08, 0.22, 0], shR: [0.55, -0.1, -0.5], elR: [-1.6, 0, 0], wrR: [-0.4, 0, 0],
      shL: [-1.25, -0.25, 0.25], elL: [-0.35, 0, 0], wrL: [-0.2, 0, 0], thL: [-0.32, 0, 0.14], knL: [0.42, 0, 0], anL: [-0.1, 0, -0.14], thR: [0.22, 0, -0.16], knR: [0.34, 0, 0], anR: [-0.5, 0, 0.16] }),
    orbB: mkPose({ spine: [0.0, -0.28, 0], chest: [0.0, -0.65, 0], neck: [0, 0.3, 0], head: [0.1, 0.35, 0], shR: [0.85, 0.3, -0.7], elR: [-2.0, 0, 0], wrR: [-0.5, 0, 0], shL: [-1.35, -0.4, 0.2], elL: [-0.2, 0, 0] }),
    orbHit: mkPose({ spine: [0.25, 0.2, 0], chest: [0.12, 0.38, 0], neck: [0, -0.25, 0], head: [-0.05, -0.3, 0], shR: [-1.55, -0.3, -0.08], elR: [-0.05, 0, 0], wrR: [0.2, 0, 0],
      shL: [0.35, 0, 0.45], elL: [-0.9, 0, 0], thL: [-0.48, 0, 0.18], knL: [0.72, 0, 0], anL: [-0.26, 0, -0.18], thR: [0.32, 0, -0.12], knR: [0.3, 0, 0], anR: [-0.6, 0, 0.12], off: [0, 0, 0.15] }),
    orbRec: mkPose({ spine: [0.12, 0.05, 0], chest: [0.08, 0.1, 0], shR: [-0.4, 0, -0.3], elR: [-0.6, 0, 0], shL: [0.0, 0, 0.3], elL: [-0.6, 0, 0], 'th*': [-0.2, 0, 0.12], 'kn*': [0.4, 0, 0] }),
    novaA: mkPose({ hips: [0.1, 0, 0], spine: [0.28, 0, 0], chest: [0.22, 0, 0], neck: [0.1, 0, 0], head: [0.25, 0, 0], 'sh*': [-1.2, -0.85, 0.08], 'el*': [-1.55, 0, 0], 'wr*': [-0.3, 0, 0],
      'th*': [-0.48, 0, 0.2], 'kn*': [0.95, 0, 0], 'an*': [-0.45, 0, -0.2] }),
    novaB: mkPose({ spine: [0.42, 0, 0], chest: [0.3, 0, 0], head: [0.4, 0, 0], 'sh*': [-1.1, -1.05, 0.0], 'el*': [-1.9, 0, 0], 'th*': [-0.6, 0, 0.22], 'kn*': [1.2, 0, 0], 'an*': [-0.58, 0, -0.22] }),
    novaHit: mkPose({ hips: [-0.05, 0, 0], spine: [-0.25, 0, 0], chest: [-0.28, 0, 0], neck: [-0.1, 0, 0], head: [-0.35, 0, 0], 'sh*': [-0.45, 0.1, 1.45], 'el*': [-0.12, 0, 0], 'wr*': [0.3, 0, 0],
      'th*': [-0.18, 0, 0.36], 'kn*': [0.3, 0, 0], 'an*': [-0.1, 0, -0.36], off: [0, 0.05, 0] }),
    novaRec: mkPose({ spine: [0.1, 0, 0], chest: [0.0, 0, 0], 'sh*': [-0.3, 0, 0.6], 'el*': [-0.5, 0, 0], 'th*': [-0.22, 0, 0.24], 'kn*': [0.45, 0, 0], 'an*': [-0.2, 0, -0.24] }),
    roar: mkPose({ hips: [-0.04, 0, 0], spine: [-0.28, 0, 0], chest: [-0.22, 0, 0], neck: [-0.2, 0, 0], head: [-0.45, 0, 0], 'sh*': [-0.55, 0.35, 1.15], 'el*': [-1.1, 0, 0], 'wr*': [-0.3, 0, 0],
      'th*': [-0.25, 0, 0.3], 'kn*': [0.5, 0, 0], 'an*': [-0.25, 0, -0.3] }),
    hit: mkPose({ spine: [-0.12, 0, 0], chest: [-0.1, 0, 0], neck: [-0.05, 0, 0], head: [-0.18, 0, 0.08], 'sh*': [0.18, 0, 0.1], 'el*': [-0.15, 0, 0], off: [0, 0, -0.1] }),
    stagger: mkPose({ body: [-0.05, 0, 0], spine: [-0.2, 0, 0], chest: [-0.18, 0, 0], head: [-0.35, 0, 0.15], 'sh*': [0.2, 0, 0.35], 'el*': [-0.2, 0, 0], 'th*': [-0.1, 0, 0.12], 'kn*': [0.35, 0, 0], 'an*': [-0.2, 0, -0.12], off: [0, 0, -0.15] }),
    dead: mkPose({ body: [0.04, 0, 0], hips: [0.3, 0, 0], spine: [0.55, 0, 0], chest: [0.35, 0, 0], neck: [0.35, 0, 0], head: [0.55, 0, 0.15], 'sh*': [-0.25, 0, 0.12], 'el*': [-0.3, 0, 0], 'wr*': [0.2, 0, 0],
      'th*': [-0.2, 0, 0.12], 'kn*': [1.75, 0, 0], 'an*': [0.85, 0, -0.1], off: [0, 0, 0.1] }),
  };
  const BWIND = { slam: [BP.slamA, BP.slamB], orb: [BP.orbA, BP.orbB], nova: [BP.novaA, BP.novaB] };
  const BHIT = { slam: BP.slamHit, orb: BP.orbHit, nova: BP.novaHit };
  const BREC = { slam: BP.slamRec, orb: BP.orbRec, nova: BP.novaRec };
  const bWind = fullPose();

  const hCur = new Float32Array(NCH), hTgt = new Float32Array(NCH), hOut = new Float32Array(NCH);
  const bCur = new Float32Array(NCH), bTgt = new Float32Array(NCH), bOut = new Float32Array(NCH);
  const smoothPose = (cur, tgt, k) => { for (let i = 0; i < NCH; i++) cur[i] += (tgt[i] - cur[i]) * k; };

  /* ============================== СОСТОЯНИЕ ============================== */
  const DEF_HERO = { x: 0, y: 0, z: 6 * K }, DEF_BOSS = { x: 0, y: 0, z: 0 };
  let hs, bs, es;
  function initState() {
    hs = {
      phase: 0, hasPrev: false, prev: new THREE.Vector3(), vel: new THREE.Vector3(), vx: 0, vz: 0, speed: 0, yaw: Math.PI,
      moveW: 0, castHold: 0, castW: 0, shieldW: 0, shieldEvt: false, dashT: 9, dashDX: 0, dashDZ: 0, dashW: 0,
      burstT: 9, burstW: 0, hitT: 9, castKick: 0, blockKick: 0, deadW: 0, victoryW: 0, glowR: 0, glowL: 0, amulet: 0, prevAct: 'idle',
      accX: 0, accZ: 0, pwx: 0, pwz: 0, slashT: 9, slashDir: 1, slashPow: 0.6, parryT: 9, parryOk: false, sigilT: 9, sigilKind: null,
    };
    bs = {
      yaw: 0, stageW: 0, kind: 'slam', windT: 9, windDur: 1.2, prog: 0, strikeT: 9, recoverT: 9, roarT: 9, hitT: 9, hitFlash: 0,
      deadT: -1, fell: false, prevAct: 'idle', charge: 0, windupEvtFrame: false, aim: 0, curl: 0.38,
    };
    es = { sigilFlash: 0, frame: 0 };
  }
  initState();
  const recentIds = new Set(), recentQ = [];
  let time = 0, quality = initialQuality, clothEvery = 1, disposed = false;

  function normKind(k) {
    const s = String(k || '').toLowerCase();
    if (s.includes('slam') || s.includes('smash') || s.includes('stomp')) return 'slam';
    if (s.includes('orb') || s.includes('proj') || s.includes('bolt')) return 'orb';
    if (s.includes('nova') || s.includes('ring') || s.includes('wave')) return 'nova';
    return null;
  }
  // мир -> локаль модели (yaw=0 смотрит в +Z)
  const toLocal = (wx, wz, yaw) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [wx * c - wz * s, wx * s + wz * c]; };

  /* ============================== СОБЫТИЯ ============================== */
  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.id !== undefined && ev.id !== null) {
      if (recentIds.has(ev.id)) return;
      recentIds.add(ev.id); recentQ.push(ev.id);
      if (recentQ.length > 512) recentIds.delete(recentQ.shift());
    }
    const d = ev.data || {};
    switch (ev.type) {
      case 'player_cast':
        if (d.ability === 'spark') { hs.castHold = Math.max(hs.castHold, 0.22); hs.castKick = 1.4; hs.glowR = Math.max(hs.glowR, 1.4); }
        else { hs.castHold = 0.5; hs.castKick = 1; hs.glowR = Math.max(hs.glowR, 1.2); }
        break;
      case 'player_slash':   // [ASHEN_V2] «Рассечение»: мах правой по дуге в сторону взмаха
        hs.slashT = 0; hs.slashDir = d.dir === 'left' || (typeof d.dir === 'number' && d.dir < 0) ? -1 : 1;
        hs.slashPow = clamp(num(d.power, 0.6), 0, 1); hs.glowR = Math.max(hs.glowR, 1.5);
        break;
      case 'parry': hs.parryT = 0; hs.parryOk = !!d.success; hs.glowL = Math.max(hs.glowL, d.success ? 2 : 1); break;
      case 'sigil_cast': hs.sigilT = 0; hs.sigilKind = d.sigil; hs.glowL = Math.max(hs.glowL, 1.6); hs.glowR = Math.max(hs.glowR, 1.6); break; // [ASHEN_V3]
      case 'player_dash': {
        hs.dashT = 0;
        const dir = d.direction !== undefined ? d.direction : d.dir;
        const wd = d.worldDirection;   // [ASHEN_V2] рывок в любую сторону — берём мировой вектор
        if (wd && Number.isFinite(wd.x) && Number.isFinite(wd.z) && (wd.x || wd.z)) { const [lx, lz] = toLocal(wd.x, wd.z, hs.yaw); const l = Math.hypot(lx, lz) || 1; hs.dashDX = lx / l; hs.dashDZ = lz / l; }
        else if (typeof dir === 'number' && dir !== 0) { hs.dashDX = -Math.sign(dir); hs.dashDZ = 0; } // +1 = вправо на экране = локальный -X
        else if (dir && typeof dir === 'object') { const [lx, lz] = toLocal(num(dir.x, 0), num(dir.z, 0), hs.yaw); const l = Math.hypot(lx, lz) || 1; hs.dashDX = lx / l; hs.dashDZ = lz / l; }
        break;
      }
      case 'shield_start': hs.shieldEvt = true; hs.glowL = Math.max(hs.glowL, 0.8); break;
      case 'shield_end': hs.shieldEvt = false; break;
      case 'block': hs.blockKick = 1; hs.glowL = 1.6; break;
      case 'player_hit': hs.hitT = 0; break;
      case 'burst': hs.burstT = 0; hs.amulet = 1.5; es.sigilFlash = 1; break;
      case 'boss_hit': bs.hitT = 0; bs.hitFlash = 1; break;
      case 'boss_windup': {
        const k = normKind(d.attackKind || d.kind || d.attack || d.type);
        if (k) bs.kind = k;
        bs.windT = 0; bs.windDur = Math.max(0.2, num(d.duration, num(d.windup, 1.2)));
        bs.windupEvtFrame = true;
        break;
      }
      case 'boss_impact': if (bs.strikeT > 0.5) bs.strikeT = 0; break;
      case 'boss_phase': bs.roarT = 0; bs.hitFlash = 1.2; es.sigilFlash = 1; break;
      case 'victory': if (bs.deadT < 0) bs.deadT = 0; break;
      case 'defeat': hs.deadW = Math.max(hs.deadW, 0.01); break;
      case 'ember_lit': setPoiState(d.id, { lit: true, flash: true }); break;   // [ASHEN_V2] уголь клятвы
      default: break;
    }
  }

  /* =============================== ГЕРОЙ =============================== */
  // Зеркало рук игрока (main.js → setMirror): силуэт плеча и предплечья с камеры, в плоскости кадра,
  // поверх процедурной позы. Экран зеркальный, как превью: левая рука игрока — слева, как у героя со спины.
  const mirror = { data: null, w: 0, L: { sh: 0, el: 0, ok: false }, R: { sh: 0, el: 0, ok: false } };
  function setMirror(m) { mirror.data = m && m.valid ? m : null; }
  function applyMirror(dt, dead) {
    const m = mirror.data;
    const want = m && !dead ? 1 : 0;
    mirror.w += (want - mirror.w) * dampK(want ? 6 : 3, dt);
    for (const [side, key, out] of [['left', 'L', -1], ['right', 'R', 1]]) {
      const S = mirror[key];
      const a = m && m[side];
      if (a && a.upper && a.fore) {
        const th = Math.atan2(a.upper.x * out, a.upper.y);   // 0 — рука висит, π/2 — в сторону, π — вверх
        const rel = wrapAngle(Math.atan2(a.fore.x * out, a.fore.y) - th);
        if (!S.ok) { S.sh = th; S.el = rel; S.ok = true; }
        S.sh += (th - S.sh) * dampK(14, dt);
        S.el += (clamp(rel, -2.6, 2.6) - S.el) * dampK(14, dt);
      } else if (!m) S.ok = false;
      if (!S.ok || mirror.w < 0.01) continue;
      const k = mirror.w * 0.85;
      const sg = key === 'L' ? 1 : -1; // rz > 0 уводит левую руку наружу (+X), правую — внутрь
      const iS = JI['sh' + key] * 3, iE = JI['el' + key] * 3;
      hOut[iS] = lerp(hOut[iS], -0.12, k);                 // чуть вперёд, чтобы кисть не уходила в плащ
      hOut[iS + 2] = lerp(hOut[iS + 2], sg * S.sh, k);
      hOut[iE] = lerp(hOut[iE], -0.05, k);
      hOut[iE + 2] = lerp(hOut[iE + 2], sg * S.el * 0.9, k);
    }
  }

  /* ------------------- ПОХОДКА: фаза, стопы, IK ног (ASHEN_V2) ------------------- */
  // Фаза шага идёт по пройденному пути: за время опоры стопа уезжает назад ровно со скоростью
  // героя, поэтому ноги не скользят. Шаг и бег смешиваются по скорости (у бега — фаза полёта,
  // отрыв пятки, мах голенью). Стопы ставятся двухзвенным IK (бедро 0.44 + голень 0.42) на землю
  // раскладки; таз опускается ровно настолько, чтобы опорная стопа дотянулась. В стойке ноги
  // остаются на ручных позах (idle, щит, чары) — IK включается только в движении.
  const GAIT = { L1: 0.44, L2: 0.42, ankleH: 0.118, width: 0.115 };
  const mkFoot = () => ({ x: 0, z: 0, lift: 0, pitch: 0, stance: 0, swing: 0, fwd: 0 });
  const gait = { phase: 0, w: 0, rw: 0, dirX: 0, dirZ: 1, legX: 0, legZ: 1, hipYaw: 0, travel: 0.5, duty: 0.6, pelvis: 0, pelvisOk: false, feet: { L: mkFoot(), R: mkFoot() } };
  function resetGait() { gait.phase = 0; gait.w = 0; gait.rw = 0; gait.hipYaw = 0; gait.pelvis = 0; gait.pelvisOk = false; }

  function updateGait(dt, live) {
    const g = gait;
    let sp = hs.speed;
    // [V4] поворот на месте (lock-on обходит Регента, разворот в explore) — ноги переступают, а не «едут»
    const turnSp = Math.abs(hs.yawRate || 0) * 0.32;
    const turning = sp < 0.5 && turnSp > 0.45;
    if (turning) sp = Math.max(sp, Math.min(1.1, turnSp));
    const want = smoothstep(0.12, 0.7, sp) * live * (1 - hs.dashW) * (1 - hs.burstW * 0.85) * (1 - hs.victoryW);
    g.w += (want - g.w) * dampK(want > g.w ? 10 : 6, dt);
    g.rw += (smoothstep(2.9, 4.7, sp) - g.rw) * dampK(6, dt);
    if (turning) { g.dirX = Math.sign(hs.yawRate) || 1; g.dirZ = 0; }
    else if (sp > 0.05) { g.dirX = hs.vx / sp; g.dirZ = hs.vz / sp; }
    // Таз разворачивается в сторону хода (стрейф, диагональ назад), грудь компенсирует — ноги идут
    // почти «вперёд» в осях таза и не перекрещиваются. Назад-прямо — пятится без разворота.
    const th = Math.atan2(g.dirX, g.dirZ);
    const hyT = (Math.abs(th) <= 1.75 ? th : th - Math.sign(th) * Math.PI) * 0.78 * smoothstep(0.1, 0.6, sp) * (turning ? 0.3 : 1);
    g.hipYaw += (clamp(hyT, -1.2, 1.2) - g.hipYaw) * dampK(7, dt);
    g.legX = Math.sin(th - g.hipYaw); g.legZ = Math.cos(th - g.hipYaw);
    const rw = g.rw, side = Math.abs(g.legX);
    // [V4] спринт (до ~8 м/с): длиннее шаг и короче опора — каденс не «семенит»
    const sprintK = smoothstep(5.6, 8, sp);
    g.duty = lerp(lerp(0.6, 0.36, rw), 0.31, sprintK);
    const trWalk = clamp(sp * 0.42, 0.25, 0.85), trRun = clamp(0.8 + (sp - 4) * 0.11, 0.8, 1.25);
    g.travel = lerp(trWalk, trRun, rw) * lerp(1, 0.55, side);   // вбок шаг короче, ноги не перекрещиваются
    const center = lerp(-0.03, -0.1, rw);                       // бегун ставит стопу ближе к себе
    const liftH = lerp(0.09, 0.27, rw) * lerp(1, 0.6, side);
    const toePitch = lerp(0.35, 0.75, rw), heelPitch = -lerp(0.26, 0.08, rw);
    // частота из условия «стопа в опоре неподвижна»: travel = скорость × время опоры
    const f = sp > 0.05 ? sp * g.duty / Math.max(0.15, g.travel) : 0;
    g.phase = (g.phase + f * dt) % 1;
    for (const key of ['L', 'R']) {
      const F = g.feet[key], sgn = key === 'L' ? 1 : -1;
      const ph = (g.phase + (key === 'L' ? 0 : 0.5)) % 1;
      let along, lift = 0, pitch;
      if (ph < g.duty) {
        const u = ph / g.duty;
        along = center + g.travel * (0.5 - u);
        const toe = smoothstep(0.55, 1, u);                        // пятка отрывается, носок на земле
        lift = toe * lerp(0.05, 0.12, rw);
        pitch = toe * toePitch + (1 - smoothstep(0, 0.2, u)) * heelPitch;
        F.stance = Math.sin(Math.PI * u); F.swing = 0;
      } else {
        const u = (ph - g.duty) / (1 - g.duty);
        // мах считается в мире: стопа отрывается и садится с нулевой скоростью относительно земли
        // (в осях тела — со скоростью опоры), иначе в конце маха она «доезжает» по полу
        const D = g.travel * (1 - g.duty) / g.duty;   // путь тела за мах
        along = center - g.travel * 0.5 + (g.travel + D) * smooth01(u) - D * u;
        lift = liftH * Math.pow(Math.sin(Math.PI * Math.pow(u, lerp(1, 0.7, rw))), 0.85);
        pitch = lerp(toePitch, heelPitch, smoothstep(0.15, 0.85, u));
        F.stance = 0; F.swing = Math.sin(Math.PI * u);
      }
      F.fwd = along / Math.max(0.1, g.travel * 0.5);
      let x = sgn * (GAIT.width + 0.03 * side) + g.legX * along;          // в осях таза
      x = sgn > 0 ? Math.max(x, 0.05) : Math.min(x, -0.05);
      const z = 0.02 + g.legZ * along, ch = Math.cos(g.hipYaw), sh = Math.sin(g.hipYaw);
      F.x = x * ch + z * sh; F.z = -x * sh + z * ch; F.lift = lift; F.pitch = pitch;
    }
  }

  const _gt = new THREE.Vector3(), _gh = new THREE.Vector3(), _gv = new THREE.Vector3(), _gn = new THREE.Vector3(), _gu = new THREE.Vector3();
  const _gs = new THREE.Vector3(), _gk = new THREE.Vector3(), _gy = new THREE.Vector3(), _gz = new THREE.Vector3(), _gp = new THREE.Vector3();
  const _gm = new THREE.Matrix4(), _gqR = new THREE.Quaternion(), _gqP = new THREE.Quaternion(), _gq = new THREE.Quaternion(), _gq2 = new THREE.Quaternion();
  const _ge = new THREE.Euler();
  const footW = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  function footTarget(key, out) {
    const F = gait.feet[key];
    out.set(F.x, 0, F.z);
    heroRoot.localToWorld(out);
    const y0 = heroRoot.position.y;
    out.y = clamp(layoutGroundY(out.x, out.z), y0 - 0.35, y0 + 0.35) + GAIT.ankleH + F.lift;
    return out;
  }
  function applyGaitIK(dt) {
    const g = gait, w = g.w;
    if (w < 0.01) { g.pelvisOk = false; return; }
    footTarget('L', footW.L); footTarget('R', footW.R);
    // таз: присед бега и покачивание (шаг — выше в середине опоры, бег — ниже), затем досягаемость
    const st = g.feet.L.stance + g.feet.R.stance;
    let drop = 0.05 * g.rw - st * lerp(0.022, -0.045, g.rw);
    const R = (GAIT.L1 + GAIT.L2) * 0.985;
    for (const key of ['L', 'R']) {
      hero.j[JI['th' + key]].getWorldPosition(_gh);
      const t = footW[key], hx = t.x - _gh.x, hz = t.z - _gh.z, h2 = hx * hx + hz * hz;
      if (h2 < R * R) { const vy = _gh.y - drop - t.y, mx = Math.sqrt(R * R - h2); if (vy > mx) drop += vy - mx; }
    }
    drop = clamp(drop, -0.06, 0.2);
    if (!g.pelvisOk) { g.pelvis = drop; g.pelvisOk = true; }
    g.pelvis += (drop - g.pelvis) * dampK(24, dt);
    heroBody.position.y -= g.pelvis * w;
    heroBody.updateMatrixWorld(true);
    heroRoot.getWorldQuaternion(_gqR);
    const L1 = GAIT.L1, L2 = GAIT.L2;
    for (const key of ['L', 'R']) {
      const th = hero.j[JI['th' + key]], kn = hero.j[JI['kn' + key]], an = hero.j[JI['an' + key]];
      const par = th.parent;
      _gt.copy(footW[key]); par.worldToLocal(_gt);
      par.getWorldQuaternion(_gqP); _gqP.invert();
      { const ch = Math.cos(g.hipYaw), sh = Math.sin(g.hipYaw), px = key === 'L' ? 0.15 : -0.15; _gp.set(px * ch + sh, 0, -px * sh + ch); }
      _gp.applyQuaternion(_gqR).applyQuaternion(_gqP).normalize(); // колено — вперёд таза и чуть наружу
      _gv.subVectors(_gt, th.position);
      let d = _gv.length();
      if (d < 1e-4) continue;
      _gv.divideScalar(d);
      d = clamp(d, 0.2, L1 + L2 - 1e-3);
      const a = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
      const bend = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
      _gn.copy(_gp).addScaledVector(_gv, -_gp.dot(_gv));
      if (_gn.lengthSq() < 1e-8) _gn.set(0, 0, 1);
      _gn.normalize();
      _gu.copy(_gv).multiplyScalar(Math.cos(a)).addScaledVector(_gn, Math.sin(a));   // бедро
      _gs.copy(_gv).multiplyScalar(d).addScaledVector(_gu, -L1).divideScalar(L2);     // голень
      _gk.crossVectors(_gu, _gs);
      if (_gk.lengthSq() < 1e-8) _gk.crossVectors(_gu, _gy.set(0, 0, -1));
      _gk.normalize();
      // кость смотрит в −Y: базис X = ось колена, Y = −бедро, Z = X × Y
      _gy.copy(_gu).negate();
      _gz.crossVectors(_gk, _gy).normalize();
      _gk.crossVectors(_gy, _gz);
      _gm.makeBasis(_gk, _gy, _gz);
      _gq.setFromRotationMatrix(_gm);
      th.quaternion.slerp(_gq, w);
      _ge.set(bend, 0, 0, 'XYZ'); _gq.setFromEuler(_ge);
      kn.quaternion.slerp(_gq, w);
      th.updateMatrixWorld(true);
      // стопа: по курсу героя, носок чуть наружу, наклон по фазе (удар пятки → перекат → носок)
      _ge.set(g.feet[key].pitch, g.hipYaw * g.w + (key === 'L' ? 0.1 : -0.1), 0, 'YXZ');
      _gq2.setFromEuler(_ge);
      _gq.copy(_gqR).multiply(_gq2);
      kn.getWorldQuaternion(_gq2); _gq2.invert().multiply(_gq);
      an.quaternion.slerp(_gq2, w);
    }
    heroRoot.updateMatrixWorld(true);
  }

  // [ASHEN_V2] быстрые удары поверх позы: «Рассечение» (правая рука метёт дугу на уровне плеча,
  // грудь доворачивает за ней) и парирование (выпад левой ладонью вперёд). Каналы плеча — YXZ:
  // rx≈−1.45 — рука вперёд, ry — горизонтальный мах (+ к левому боку героя).
  function applyStrikes(dead) {
    if (dead) return;
    const lerpCh = (k, x, y, z, w) => { const i = JI[k] * 3; hOut[i] = lerp(hOut[i], x, w); hOut[i + 1] = lerp(hOut[i + 1], y, w); hOut[i + 2] = lerp(hOut[i + 2], z, w); };
    const env = (t, a, hold, r) => t < a ? smooth01(t / a) : t < a + hold ? 1 : 1 - smooth01(Math.min(1, (t - a - hold) / r));
    if (hs.slashT < 0.62) {
      const t = hs.slashT, w = env(t, 0.05, 0.22, 0.3), sd = hs.slashDir;       // sd=+1 — взмах вправо (к −X героя)
      const u = smooth01(clamp((t - 0.03) / 0.2, 0, 1));
      const sweep = sd * lerp(1.05, -1.1, u);                                       // от одного плеча к другому
      lerpCh('shR', -1.42 - 0.12 * hs.slashPow, sweep, -0.08, w);
      lerpCh('elR', -0.18, 0, 0, w);
      lerpCh('wrR', 0.1, 0, sd * 0.5, w);
      addCh(hOut, 'chest', 0.04 * w, sweep * 0.3 * w, 0);
      addCh(hOut, 'spine', 0.05 * w, sweep * 0.18 * w, 0);
      addCh(hOut, 'head', 0, -sweep * 0.2 * w, 0);
    }
    // [ASHEN_V3] печати двумя руками
    if (hs.sigilT < 1.1 && hs.sigilKind) {
      const t = hs.sigilT, k = hs.sigilKind;
      if (k === 'clap') {
        const w = env(t, 0.06, 0.16, 0.25);
        lerpCh('shL', -1.35, -0.45, 0.05, w); lerpCh('shR', -1.35, 0.45, -0.05, w);
        lerpCh('elL', -0.3, 0, 0, w); lerpCh('elR', -0.3, 0, 0, w);
        lerpCh('wrL', -0.2, 0, 0, w); lerpCh('wrR', -0.2, 0, 0, w);
        addCh(hOut, 'chest', 0.08 * w, 0, 0); addCh(hOut, 'spine', 0.06 * w, 0, 0);
      } else if (k === 'gate') {
        const w = env(t, 0.1, 0.35, 0.35);
        lerpCh('shL', -0.35, 0, 1.3, w); lerpCh('shR', -0.35, 0, -1.3, w);
        lerpCh('elL', -0.15, 0, 0, w); lerpCh('elR', -0.15, 0, 0, w);
        lerpCh('wrL', 0.3, 0, 0, w); lerpCh('wrR', 0.3, 0, 0, w);
        addCh(hOut, 'chest', -0.08 * w, 0, 0); addCh(hOut, 'head', -0.08 * w, 0, 0);
      } else if (k === 'frame') {
        const w = env(t, 0.12, 0.45, 0.3);
        lerpCh('shL', -1.5, -0.25, 0.1, w); lerpCh('shR', -1.5, 0.25, -0.1, w);
        lerpCh('elL', -1.1, 0, 0, w); lerpCh('elR', -1.1, 0, 0, w);
        addCh(hOut, 'head', -0.05 * w, 0, 0);
      }
    }
    if (hs.parryT < 0.55) {
      const t = hs.parryT, w = env(t, 0.06, hs.parryOk ? 0.2 : 0.12, 0.25);
      lerpCh('shL', -1.5, -0.28, 0.05, w);
      lerpCh('elL', -0.22, 0, 0, w);
      lerpCh('wrL', -1.05, 0, 0, w);                                                // ладонь к цели
      addCh(hOut, 'chest', 0.03 * w, -0.2 * w, 0);
      addCh(hOut, 'spine', 0.06 * w, -0.1 * w, 0);
      if (hs.parryOk) addCh(hOut, 'off', 0, 0, -0.04 * smooth01(clamp((t - 0.05) / 0.1, 0, 1)) * w);
    }
  }

  function updateHero(dt, snap) {
    const p = snap && snap.player ? snap.player : null;
    const b = snap && snap.boss ? snap.boss : null;
    const status = snap ? snap.status : 'playing';
    const pos = vec3(p && p.position, DEF_HERO.x, DEF_HERO.y, DEF_HERO.z);
    const bpos = vec3(b && b.position, 0, 0, 0);
    // [V4] корпус по высоте сглажен (ступени, кочки не дёргают героя); стопы IK встают на настоящую землю
    if (!Number.isFinite(hs.rootY) || Math.abs(pos.y - hs.rootY) > 1.2 || dt <= 0) hs.rootY = pos.y;
    else hs.rootY += (pos.y - hs.rootY) * dampK(pos.y > hs.rootY ? 16 : 11, dt);
    heroRoot.position.set(pos.x, hs.rootY, pos.z);
    const faceYaw = Math.atan2(bpos.x - pos.x, bpos.z - pos.z);
    const tYaw = num(p && p.yaw, faceYaw) + num(wc.yawOffset, 0);
    const yaw0 = hs.yaw;
    hs.yaw += wrapAngle(tYaw - hs.yaw) * dampK(num(wc.heroYawRate, 18), dt);
    hs.yaw = wrapAngle(hs.yaw);
    if (dt > 1e-4) hs.yawRate = (hs.yawRate || 0) + (wrapAngle(hs.yaw - yaw0) / dt - (hs.yawRate || 0)) * dampK(10, dt);
    hs.sprint = num(p && p.sprint, 0);
    heroRoot.rotation.y = hs.yaw;

    // скорость: из снимка (V2), иначе по разнице позиций
    const sv = p && p.velocity;
    if (sv && Number.isFinite(sv.x) && Number.isFinite(sv.z)) hs.vel.lerp(_va.set(sv.x, 0, sv.z), dampK(20, dt));
    else if (hs.hasPrev && dt > 1e-4) {
      const dx = pos.x - hs.prev.x, dz = pos.z - hs.prev.z;
      if (dx * dx + dz * dz > 9) hs.vel.set(0, 0, 0);
      else hs.vel.lerp(_va.set(dx / dt, 0, dz / dt), dampK(12, dt));
    }
    hs.prev.set(pos.x, pos.y, pos.z); hs.hasPrev = true;
    [hs.vx, hs.vz] = toLocal(hs.vel.x, hs.vel.z, hs.yaw);
    hs.speed = Math.hypot(hs.vx, hs.vz);
    // ускорение в мире → в осях героя: разгон/торможение и центростремительный крен на повороте
    if (dt > 1e-4) {
      const awx = clamp((hs.vel.x - hs.pwx) / dt, -40, 40), awz = clamp((hs.vel.z - hs.pwz) / dt, -40, 40);
      const [alx, alz] = toLocal(awx, awz, hs.yaw);
      hs.accX += (alx - hs.accX) * dampK(7, dt); hs.accZ += (alz - hs.accZ) * dampK(7, dt);
    }
    hs.pwx = hs.vel.x; hs.pwz = hs.vel.z;

    const act = p && typeof p.action === 'string' ? p.action : 'idle';
    const dead = act === 'dead' || status === 'defeat' || (p && num(p.hp, 1) <= 0 && num(p.maxHp, 0) > 0);
    const victory = status === 'victory' && !dead;
    const shielding = !dead && (p && typeof p.shielding === 'boolean' ? p.shielding : hs.shieldEvt) || act === 'shield';
    if (act === 'cast') hs.castHold = Math.max(hs.castHold, 0.35);
    if (act === 'dash' && hs.prevAct !== 'dash' && hs.dashT > 0.2) hs.dashT = 0;
    if (act === 'hit' && hs.prevAct !== 'hit' && hs.hitT > 0.3) hs.hitT = 0;
    hs.prevAct = act;
    hs.castHold -= dt; hs.dashT += dt; hs.burstT += dt; hs.hitT += dt; hs.slashT += dt; hs.parryT += dt; hs.sigilT += dt;
    if (hs.dashT < 0.08 && hs.speed > 2.5) { hs.dashDX = hs.vx / hs.speed; hs.dashDZ = hs.vz / hs.speed; }
    if (hs.dashT < 0.02 && hs.dashDX === 0 && hs.dashDZ === 0) hs.dashDX = 1;

    const dashOn = !dead && (hs.dashT < 0.3 || act === 'dash');
    const burstOn = !dead && hs.burstT < 1.2;
    hs.moveW += (clamp(hs.speed / 3.2, 0, 1.15) - hs.moveW) * dampK(8, dt);
    hs.castW += ((!dead && hs.castHold > 0 ? 1 : 0) - hs.castW) * dampK(hs.castHold > 0 ? 18 : 6, dt);
    hs.shieldW += ((shielding && !dead ? 1 : 0) - hs.shieldW) * dampK(shielding ? 16 : 7, dt);
    hs.dashW += ((dashOn ? 1 : 0) - hs.dashW) * dampK(dashOn ? 26 : 7, dt);
    hs.burstW += ((burstOn ? 1 : 0) - hs.burstW) * dampK(burstOn ? 20 : 6, dt);
    hs.deadW += ((dead ? 1 : 0) - hs.deadW) * dampK(dead ? 3.2 : 8, dt);
    hs.victoryW += ((victory ? 1 : 0) - hs.victoryW) * dampK(2, dt);
    hs.castKick *= Math.exp(-dt * 9); hs.blockKick *= Math.exp(-dt * 8);

    // целевая статическая поза
    hTgt.fill(0);
    poseOver(hTgt, HP.idle);
    poseBlend(hTgt, HP.victory, hs.victoryW);
    poseBlend(hTgt, HP.shield, hs.shieldW);
    poseBlend(hTgt, hs.shieldW > 0.5 ? HP.castArm : HP.cast, hs.castW);
    if (hs.dashW > 0.001) {
      const dx = hs.dashDX, dz = hs.dashDZ;
      poseSet(hDash, 'off', 0, 0, 0);
      poseSet(hDash, 'body', 0.26 * dz, 0, -0.3 * dx);
      poseSet(hDash, 'hips', 0.1, 0, 0); poseSet(hDash, 'spine', 0.25, 0, 0); poseSet(hDash, 'chest', 0.1, 0, 0);
      poseSet(hDash, 'neck', -0.05, 0, 0.1 * dx); poseSet(hDash, 'head', -0.18, 0, 0.18 * dx);
      poseSet(hDash, 'shL', 0.55, 0, 0.55); poseSet(hDash, 'shR', 0.55, 0, -0.55);
      poseSet(hDash, 'elL', -0.5, 0, 0); poseSet(hDash, 'elR', -0.5, 0, 0);
      poseSet(hDash, 'wrL', 0, 0, 0); poseSet(hDash, 'wrR', 0, 0, 0);
      poseSet(hDash, 'thL', -0.5 - 0.2 * dz, 0, 0.14 + 0.22 * Math.max(0, dx)); poseSet(hDash, 'thR', -0.2 + 0.1 * dz, 0, -0.14 - 0.22 * Math.max(0, -dx));
      poseSet(hDash, 'knL', 0.85, 0, 0); poseSet(hDash, 'knR', 0.5, 0, 0);
      poseSet(hDash, 'anL', -0.3, 0, -0.1); poseSet(hDash, 'anR', -0.15, 0, 0.1);
      poseBlend(hTgt, hDash, hs.dashW);
    }
    if (hs.burstW > 0.001) {
      const t = hs.burstT;
      if (t < 0.42) { poseLerp(hBurst, HP.gather, HP.gather, 0); poseBlend(hTgt, hBurst, smooth01(clamp(t / 0.3, 0, 1)) * hs.burstW); }
      else {
        poseLerp(hBurst, HP.gather, HP.release, smooth01(clamp((t - 0.42) / 0.12, 0, 1)));
        const w = t < 0.85 ? 1 : 1 - smooth01(clamp((t - 0.85) / 0.35, 0, 1));
        poseBlend(hTgt, hBurst, w * hs.burstW);
      }
    }
    poseBlend(hTgt, HP.dead, hs.deadW);
    smoothPose(hCur, hTgt, dampK(dead ? 5 : hs.burstW > 0.3 || hs.dashW > 0.3 ? 22 : 15, dt));

    // аддитивные слои: походка, дыхание, отдача, вздрагивание
    hOut.set(hCur);
    const live = 1 - hs.deadW;
    updateGait(dt, live);
    const gw = gait.w;
    if (gw > 0.002) {
      const g = gait, rw = g.rw, fz = g.dirZ, fx = g.dirX, FL = g.feet.L, FR = g.feet.R;
      // рука идёт в противофазе своей ноге: нога впереди → рука назад (rx > 0)
      const aL = clamp(FL.fwd * g.legZ, -1.2, 1.2), aR = clamp(FR.fwd * g.legZ, -1.2, 1.2);
      const freeL = 1 - hs.shieldW * 0.8, freeR = 1 - hs.castW * 0.9;
      const armA = lerp(0.3, 0.75, rw) * gw;
      addCh(hOut, 'shL', armA * aL * freeL, 0, 0.05 * rw * gw * freeL);
      addCh(hOut, 'shR', armA * aR * freeR, 0, -0.05 * rw * gw * freeR);
      const elb = lerp(0.12, 1.1, rw);   // на бегу локти согнуты, на заднем махе — сильнее
      addCh(hOut, 'elL', -(elb + 0.3 * Math.max(0, aL) * rw) * gw * freeL, 0, 0);
      addCh(hOut, 'elR', -(elb + 0.3 * Math.max(0, aR) * rw) * gw * freeR, 0, 0);
      addCh(hOut, 'wrL', -0.15 * rw * gw * freeL, 0, 0); addCh(hOut, 'wrR', -0.15 * rw * gw * freeR, 0, 0);
      // таз за выносимой ногой, грудь навстречу, голова держит горизонт; бедро маховой ноги проседает
      const twist = (aL - aR) * 0.5;
      const hy = g.hipYaw * gw;
      addCh(hOut, 'hips', 0, hy - lerp(0.1, 0.15, rw) * twist * gw, (FR.swing - FL.swing) * 0.05 * (1 - rw * 0.6) * gw);
      addCh(hOut, 'spine', lerp(0.03, 0.15, rw) * gw, -hy * 0.55 + lerp(0.05, 0.09, rw) * twist * gw, 0);
      addCh(hOut, 'chest', 0.05 * rw * gw, -hy * 0.45 + lerp(0.04, 0.07, rw) * twist * gw, 0);
      addCh(hOut, 'neck', -0.04 * rw * gw, -0.02 * twist * gw, 0);
      addCh(hOut, 'head', -lerp(0.02, 0.12, rw) * gw, -0.03 * twist * gw, 0);
      // вес над опорной ногой, наклон по ходу
      addCh(hOut, 'off', (FL.stance - FR.stance) * 0.022 * (1 - rw) * gw, 0, 0);
      addCh(hOut, 'body', (0.04 + 0.07 * rw + 0.07 * clamp(hs.sprint || 0, 0, 1)) * fz * gw, 0, -(0.04 + 0.06 * rw) * fx * gw);
    }
    // разгон/торможение наклоняют корпус, поворот на ходу — крен внутрь дуги
    addCh(hOut, 'body', clamp(hs.accZ * 0.028, -0.16, 0.16) * live * (1 - hs.dashW), 0, clamp(-hs.accX * 0.024, -0.2, 0.2) * live * (1 - hs.dashW));
    const br = Math.sin(time * 1.7) * live;
    addCh(hOut, 'chest', 0.018 * br, 0, 0);
    addCh(hOut, 'shL', 0, 0, 0.012 * br); addCh(hOut, 'shR', 0, 0, -0.012 * br);
    addCh(hOut, 'head', -0.01 * br, 0, 0);
    poseAdd(hOut, HP.castKick, hs.castKick * live);
    poseAdd(hOut, HP.blockKick, hs.blockKick * live);
    const hitE = hs.hitT < 0.06 ? hs.hitT / 0.06 : Math.exp(-(hs.hitT - 0.06) * 7);
    poseAdd(hOut, HP.hit, hitE * (dead ? 0.4 : 1));
    applyStrikes(dead);
    applyMirror(dt, dead);
    applyPose(hero, hOut, 1);
    applyGaitIK(dt);

    // ткань


    const tgtX = clamp(-hs.vx * 0.055, -0.24, 0.24), tgtZ = clamp(-hs.vz * 0.055, -0.24, 0.24);
    const flut = (wc.reducedMotion ? 0.5 : 1) * (0.6 + 0.4 * hs.moveW);
    for (const s of [tunic, coatSkirt]) {
      s.vel.x += ((tgtX - s.off.x) * 70 - s.vel.x * 10) * dt;
      s.vel.y += ((tgtZ - s.off.y) * 70 - s.vel.y * 10) * dt;
      s.off.x += s.vel.x * dt; s.off.y += s.vel.y * dt;
    }
    legPoints(hero.j[JI.thL], hero.j[JI.knL], legTmp.L);
    legPoints(hero.j[JI.thR], hero.j[JI.knR], legTmp.R);
    deformSkirt(tunic, time, 0.005 * flut);
    deformSkirt(coatSkirt, time, 0.011 * flut);
    {
      const cx = clamp(-hs.vx * 0.09, -0.5, 0.5), cz = clamp(-hs.vz * 0.09, -0.5, 0.5);
      const cs = capeState;
      cs.vel.x += ((cx - cs.off.x) * 38 - cs.vel.x * 6.5) * dt;
      cs.vel.y += ((cz - cs.off.y) * 38 - cs.vel.y * 6.5) * dt;
      cs.off.x += cs.vel.x * dt; cs.off.y += cs.vel.y * dt;
    }
    deformCape(time, 0.022 * flut);
    if (es.frame % clothEvery === 0) { capeGeo.computeVertexNormals(); tunic.geo.computeVertexNormals(); coatSkirt.geo.computeVertexNormals(); }

    // свечение перчаток, амулета, глаз
    hs.glowR = Math.max(hs.glowR * Math.exp(-dt * 5), hs.castW * 0.7, hs.burstT < 0.9 ? 0.9 : 0);
    hs.glowL = Math.max(hs.glowL * Math.exp(-dt * 5), hs.shieldW * 0.9, hs.burstT < 0.9 ? 0.9 : 0);
    hs.amulet *= Math.exp(-dt * 2.5);
    matGloveR.emissiveIntensity = 0.15 + hs.glowR * 1.8;
    matGloveL.emissiveIntensity = 0.12 + hs.glowL * 1.6;
    matHandGlowR.opacity = clamp(hs.glowR * 0.75, 0, 0.9) * live;
    matHandGlowL.opacity = clamp(hs.glowL * 0.7, 0, 0.9) * live;
    matAmulet.emissiveIntensity = (0.4 + hs.amulet * 2.2) * lerp(1, 0.2, hs.deadW);
    matHeroEyes.emissiveIntensity = 0.9 * lerp(1, 0.1, hs.deadW);
    matLantern.emissiveIntensity = (1.1 + 0.25 * Math.sin(time * 9.3) * Math.sin(time * 5.1)) * lerp(1, 0.4, hs.deadW);
    H.lantern.rotation.x = clamp(-hs.vz * 0.06, -0.5, 0.5) + Math.sin(time * 2.2) * 0.04;
    H.lantern.rotation.z = clamp(hs.vx * 0.06, -0.5, 0.5);
  }

  /* ================================ БОСС ================================ */
  const _hp = new THREE.Vector3();
  function updateBoss(dt, snap) {
    const b = snap && snap.boss ? snap.boss : null;
    const p = snap && snap.player ? snap.player : null;
    const status = snap ? snap.status : 'playing';
    const pos = vec3(b && b.position, DEF_BOSS.x, DEF_BOSS.y, DEF_BOSS.z);
    const hpos = vec3(p && p.position, DEF_HERO.x, DEF_HERO.y, DEF_HERO.z);
    bossRoot.position.set(pos.x, pos.y, pos.z);
    const toHero = Math.atan2(hpos.x - pos.x, hpos.z - pos.z);
    const act = b && typeof b.action === 'string' ? b.action : 'idle';
    const dead = act === 'dead' || status === 'victory' || (b && num(b.hp, 1) <= 0 && num(b.maxHp, 0) > 0);
    if (dead && bs.deadT < 0) bs.deadT = 0;
    if (!dead && bs.deadT >= 0 && status === 'playing') { bs.deadT = -1; restorePieces(); }
    const isDead = bs.deadT >= 0;
    if (!isDead) {
      const tYaw = num(b && b.yaw, toHero) + num(wc.yawOffset, 0);
      bs.yaw = wrapAngle(bs.yaw + wrapAngle(tYaw - bs.yaw) * dampK(num(wc.bossYawRate, 7), dt));
    }
    bossRoot.rotation.y = bs.yaw;
    const stage = b && num(b.stage, 1) >= 2 ? 2 : 1;
    bs.stageW += ((stage === 2 ? 1 : 0) - bs.stageW) * dampK(bs.roarT < 1.4 ? 2.5 : 1.5, dt);

    // фазы атаки
    if (act === 'windup' && bs.prevAct !== 'windup' && !bs.windupEvtFrame) bs.windT = 0;
    if (act === 'attack' && bs.prevAct !== 'attack') bs.strikeT = 0;
    if (act === 'recover' && bs.prevAct !== 'recover') bs.recoverT = 0;
    if (act === 'hit' && bs.prevAct !== 'hit' && bs.hitT > 0.3) { bs.hitT = 0; bs.hitFlash = Math.max(bs.hitFlash, 0.8); }
    bs.prevAct = act; bs.windupEvtFrame = false;
    bs.windT += dt; bs.strikeT += dt; bs.recoverT += dt; bs.roarT += dt; bs.hitT += dt;
    bs.hitFlash *= Math.exp(-dt * 7);
    if (isDead) bs.deadT += dt;

    // прогресс замаха: из телеграфа, иначе по таймеру
    const tgs = snap && Array.isArray(snap.telegraphs) ? snap.telegraphs : [];
    let best = null;
    for (const tg of tgs) {
      if (!tg) continue;
      const k = normKind(tg.kind);
      if (act === 'windup' && bs.windT < 0.05 && k && best === null) bs.kind = k;
      if (k && k !== bs.kind) continue;
      if (!best || num(tg.remaining, 9) < num(best.remaining, 9)) best = tg;
    }
    const winding = act === 'windup' && !isDead;
    let prog = 0;
    if (winding) {
      prog = best && num(best.duration, 0) > 0 ? 1 - num(best.remaining, 0) / num(best.duration, 1) : bs.windT / bs.windDur;
      prog = clamp(prog, 0, 1);
    }
    bs.prog = winding ? prog : Math.max(0, bs.prog - dt * 3);
    const striking = !isDead && (act === 'attack' || bs.strikeT < 0.45);
    const recovering = !isDead && !striking && act === 'recover';

    // целевая поза
    bTgt.fill(0);
    poseOver(bTgt, BP.idle1);
    poseBlend(bTgt, BP.idle2, bs.stageW);
    let rate = 3.5;
    if (isDead) {
      if (bs.deadT < 1.0) { poseBlend(bTgt, BP.stagger, 1); rate = 5; }
      else { poseBlend(bTgt, BP.dead, 1); rate = 2.2; }
    } else if (bs.roarT < 1.4) {
      poseBlend(bTgt, BP.roar, 1); rate = 6;
    } else if (winding) {
      const [A, Bp] = BWIND[bs.kind] || BWIND.slam;
      poseLerp(bWind, A, Bp, smoothstep(0.25, 0.95, prog));
      poseBlend(bTgt, bWind, 1); rate = 6;
    } else if (striking) {
      poseBlend(bTgt, BHIT[bs.kind] || BP.slamHit, 1); rate = 18;
    } else if (recovering) {
      if (bs.recoverT < 0.5) poseBlend(bTgt, BREC[bs.kind] || BP.slamRec, 1 - smoothstep(0.25, 0.5, bs.recoverT) * 0.5);
      rate = 3;
    }
    smoothPose(bCur, bTgt, dampK(rate, dt));

    // аддитивно: дыхание, дрожь заряда, вздрагивание, взгляд на героя, прицел корпусом
    bOut.set(bCur);
    const live = isDead ? Math.max(0, 1 - bs.deadT * 0.8) : 1;
    const br = Math.sin(time * (1.1 + bs.stageW * 0.7)) * (0.022 + bs.stageW * 0.02) * live;
    addCh(bOut, 'chest', br, 0, 0);
    addCh(bOut, 'shL', 0, 0, br * 0.6); addCh(bOut, 'shR', 0, 0, -br * 0.6);
    addCh(bOut, 'off', 0, br * 0.3, 0);
    if (winding && prog > 0.7 && !wc.reducedMotion) {
      const tr = (prog - 0.7) / 0.3 * 0.022;
      addCh(bOut, 'chest', Math.sin(time * 53) * tr, Math.sin(time * 41) * tr, 0);
      addCh(bOut, 'shL', Math.sin(time * 47) * tr, 0, 0); addCh(bOut, 'shR', Math.sin(time * 59) * tr, 0, 0);
    }
    const hitE = bs.hitT < 0.05 ? bs.hitT / 0.05 : Math.exp(-(bs.hitT - 0.05) * 8);
    poseAdd(bOut, BP.hit, hitE * live);
    const rel = clamp(wrapAngle(toHero - bs.yaw), -0.55, 0.55) * live;
    addCh(bOut, 'neck', 0, rel * 0.4, 0); addCh(bOut, 'head', 0, rel * 0.6, 0);
    const aimW = winding || striking ? 1 : 0;
    bs.aim += (aimW * clamp(wrapAngle(toHero - bs.yaw), -0.35, 0.35) - bs.aim) * dampK(5, dt);
    addCh(bOut, 'chest', 0, bs.aim, 0);
    applyPose(boss, bOut, bossRoot.scale.y);

    // Регент парит: подъём над полом, позвонки со сдвигом фаз, ветер в мантии, пальцы по типу атаки.
    const rmK = wc.reducedMotion ? 0.4 : 1;
    bossBody.position.y += (0.12 + Math.sin(time * 0.9) * 0.07 * rmK) * (isDead ? Math.max(0, 1 - bs.deadT * 0.7) : 1);
    for (const v of B.verts) v.g.position.y = v.y + Math.sin(time * 1.3 + v.phase) * 0.045 * live * rmK;
    B.mantleMat.userData.wind.value = time * rmK;
    B.cage.rotation.set(time * 0.23 * rmK, time * 0.5 * rmK, 0);
    const curlT = isDead ? 0.2 : winding || striking ? (bs.kind === 'orb' ? 0.95 : bs.kind === 'nova' ? 0.0 : 0.1) : 0.38;
    bs.curl += (curlT - bs.curl) * dampK(8, dt);
    for (const side of ['L', 'R']) for (const f of B.fingers[side]) { f.base.rotation.x = bs.curl * 0.9 * f.k; f.mid.rotation.x = bs.curl * 1.15 * f.k; }
    bossBody.updateMatrixWorld(true);

    // Вторая фаза (Библия, разд. 7): нимб расходится на две половины, маска трескается, мантия
    // сгорает снизу; за маской светит «украденное солнце».
    {
      const p2 = bs.stageW;
      const [hA, hB] = B.haloHalves;
      hA.position.set(0.16 * p2, 0.1 * p2, 0.05 * p2); hA.rotation.z = 0.1 * p2;
      hB.position.set(-0.18 * p2, -0.06 * p2, -0.04 * p2); hB.rotation.z = -0.13 * p2;
      B.maskCrack.visible = p2 > 0.02;
      matMaskCrack.opacity = clamp(p2 * 1.4, 0, 1) * (0.8 + 0.2 * Math.sin(time * 9.1)) * (isDead ? 0.3 : 1);
      matSunGlow.opacity = clamp(p2, 0, 1) * (0.55 + 0.15 * Math.sin(time * 2.3));
      B.sunGlow.scale.setScalar(0.01 + p2 * (1.6 + 0.12 * Math.sin(time * 1.7)));
      B.mantleMat.userData.burn.value = p2;
    }

    // обломки и гало
    const sp = (0.35 + bs.stageW * 0.45) * (wc.reducedMotion ? 0.5 : 1);
    for (const f of B.frags) {
      if (f.parent !== B.orbit) continue;
      const a = f.userData.phase + time * sp;
      f.position.set(Math.cos(a) * f.userData.r, Math.sin(time * 0.9 + f.userData.phase * 2) * 0.22, Math.sin(a) * f.userData.r);
      f.rotation.set(time * 0.4 + f.userData.phase, time * 0.3, 0);
    }
    if (B.halo.parent !== root) B.haloRing.rotation.z = time * (0.12 + bs.stageW * 0.2) * (wc.reducedMotion ? 0.5 : 1);
    if (isDead && bs.deadT > 1.1 && !bs.fell) startFall();
    updateFall(dt);

    // свечение: трещины, ядро, глаза, заряд в кулаках
    const hpFrac = b && num(b.maxHp, 0) > 0 ? clamp(num(b.hp, 0) / num(b.maxHp, 1), 0, 1) : 1;
    const charge = winding ? smoothstep(0.1, 1, prog) : striking ? Math.max(0, 1 - bs.strikeT * 3) : 0;
    bs.charge += (charge - bs.charge) * dampK(10, dt);
    const roarG = bs.roarT < 1.4 ? Math.sin(Math.PI * clamp(bs.roarT / 1.4, 0, 1)) : 0;
    const fade = isDead ? Math.max(0.04, 1 - smoothstep(0.2, 3.5, bs.deadT)) : 1;
    const pulse = Math.sin(time * (2.4 + bs.stageW * 2.8));
    const crack = (lerp(0.3, 1.0, bs.stageW) + (1 - hpFrac) * 0.3 + bs.hitFlash * 1.6 + bs.charge * 0.9 + roarG * 1.2 + pulse * 0.06) * fade;
    matBoss.emissiveIntensity = crack;
    matBossDark.emissiveIntensity = crack * 0.72;
    matBossCore.emissiveIntensity = (lerp(2.2, 3.4, bs.stageW) + pulse * 0.35 + bs.charge * 2.2 + bs.hitFlash + roarG * 2) * fade;
    matBossEyes.emissiveIntensity = (6 + bs.stageW * 2 + bs.charge * 3 + roarG * 2) * fade; // щель маски ~8 (Библия)
    matSeal.opacity = (0.55 + 0.35 * (0.5 + 0.5 * Math.sin(time * TAU * 1.2))) * fade;
    matBossRunes.emissiveIntensity = (lerp(0.9, 1.7, bs.stageW) + roarG) * fade;
    B.coreLight.intensity = (lerp(4, 8, bs.stageW) + bs.charge * 10 + roarG * 8 + pulse * 0.6) * LI.point * fade;
    matCoreGlow.opacity = clamp((0.34 + 0.12 * bs.stageW + bs.charge * 0.35 + roarG * 0.3 + pulse * 0.04) * fade, 0, 1);
    B.coreGlow.scale.setScalar(1.25 + bs.charge * (bs.kind === 'nova' ? 1.4 : 0.4) + roarG);
    matChestSigil.opacity = clamp((0.35 + 0.3 * bs.stageW + bs.charge * 0.3 + roarG * 0.3) * fade, 0, 1);
    const fistK = winding || striking ? bs.charge : 0;
    B.fistGlow.R.material.opacity = clamp(fistK * (bs.kind === 'orb' ? 1 : bs.kind === 'slam' ? 0.7 : 0.25), 0, 1) * fade;
    B.fistGlow.L.material.opacity = clamp(fistK * (bs.kind === 'slam' ? 0.7 : bs.kind === 'nova' ? 0.25 : 0.1), 0, 1) * fade;
    B.fistGlow.R.scale.setScalar(1.0 + fistK * 0.8);
    return { stageW: bs.stageW, fade, pulse, roarG, isDead };
  }

  // Падение гало и обломков после смерти (простая гравитация, без физики).
  function startFall() {
    bs.fell = true;
    const rnd = mulberry32(wc.seed + 777);
    for (const fp of fallPieces) {
      root.attach(fp.obj);
      const o = fp.obj.position;
      const dx = o.x - bossRoot.position.x, dz = o.z - bossRoot.position.z;
      const l = Math.hypot(dx, dz) || 1;
      const out = fp.seed === 0 ? 0.6 : 1.4 + rnd() * 1.4;
      fp.v.set((dx / l) * out, 0.6 + rnd() * 1.2, (dz / l) * out);
      fp.w.set((rnd() - 0.5) * 3, (rnd() - 0.5) * 2, (rnd() - 0.5) * 3);
      fp.flat.setFromEuler(_e.set(fp.seed === 0 ? -Math.PI / 2 : rnd() * TAU, rnd() * TAU, fp.seed === 0 ? 0 : rnd() * TAU, fp.seed === 0 ? 'XYZ' : 'YXZ'));
      if (fp.seed === 0) fp.flat.premultiply(_q.setFromAxisAngle(_v.set(0, 1, 0), bs.yaw));
      fp.active = true; fp.settled = false;
    }
  }
  function updateFall(dt) {
    for (const fp of fallPieces) {
      if (!fp.active || fp.settled) continue;
      const o = fp.obj;
      fp.v.y -= 9.8 * dt;
      o.position.addScaledVector(fp.v, dt);
      const rest = fp.rest * bossRoot.scale.y;
      if (o.position.y <= rest) {
        o.position.y = rest;
        fp.v.y *= -0.22; fp.v.x *= 0.55; fp.v.z *= 0.55; fp.w.multiplyScalar(0.5);
        if (Math.abs(fp.v.y) < 0.5) { fp.v.set(0, 0, 0); fp.w.set(0, 0, 0); }
      }
      if (fp.v.lengthSq() < 1e-4 && o.position.y <= rest + 1e-3) {
        o.quaternion.slerp(fp.flat, dampK(5, dt));
        if (o.quaternion.angleTo(fp.flat) < 0.01) fp.settled = true;
      } else {
        o.rotation.x += fp.w.x * dt; o.rotation.y += fp.w.y * dt; o.rotation.z += fp.w.z * dt;
        if (o.position.y <= rest + 0.3) o.quaternion.slerp(fp.flat, dampK(3, dt));
      }
    }
  }
  function restorePieces() {
    bs.fell = false;
    for (const fp of fallPieces) {
      fp.parent.add(fp.obj);
      fp.obj.position.copy(fp.pos); fp.obj.quaternion.copy(fp.quat); fp.obj.scale.copy(fp.scl);
      fp.active = false; fp.settled = false; fp.v.set(0, 0, 0); fp.w.set(0, 0, 0);
    }
  }

  /* ============================= ОКРУЖЕНИЕ ============================= */
  const ASH_TOP = 13, ASH_R = 24;
  function updateEnv(dt, snap, bInfo) {
    const rm = wc.reducedMotion ? 0.4 : 1;
    if (camera) for (const c of culledChunks) c.mesh.visible = Math.hypot(camera.position.x - c.x, camera.position.z - c.z) - c.r < c.cull;
    updateEmbers(dt);
    for (let i = 0; i < braziers.length; i++) {
      const bz = braziers[i];
      const f = 0.82 + 0.1 * Math.sin(time * 11.3 + bz.phase) + 0.08 * Math.sin(time * 23.7 + bz.phase * 2.1) * rm;
      const g = 0.9 + 0.1 * Math.sin(time * 7.1 + bz.phase * 1.3);
      bz.outer.scale.set(1.5 * g, 2.0 * f, 1);
      bz.core.scale.set(0.55 * f, 0.95 * g, 1);
      bz.outer.material.opacity = 0.45 + 0.12 * f;
      if (bz.light.visible) bz.light.intensity = 14 * LI.point * (0.85 + 0.3 * (f - 0.82));
    }
    if (ash.visible) {
      const n = ashGeo.drawRange.count;
      const a = ashPos;
      const wind = 0.18 * rm;
      const acx = heroRoot.position.x, acz = heroRoot.position.z, acy = heroRoot.position.y;
      for (let i = 0; i < n; i++) {
        const sd = ashSeed[i];
        const k = i * 3;
        a[k] += (wind + Math.sin(time * 0.37 + sd) * 0.14 * rm) * dt;
        a[k + 1] -= (0.22 + (sd % 1) * 0.28) * rm * dt;
        a[k + 2] += Math.cos(time * 0.31 + sd * 1.7) * 0.12 * rm * dt;
        // [ASHEN_V3] облако пепла идёт за героем: вышедшие за радиус переносятся на противоположную сторону
        const ddx = a[k] - acx, ddz = a[k + 2] - acz;
        if (a[k + 1] < acy - 2) {
          const h1 = hash3(sd, time, i, 3), h2 = hash3(i, sd, time, 5);
          const r = Math.sqrt(h1) * ASH_R, an = h2 * TAU;
          a[k] = acx + Math.sin(an) * r; a[k + 2] = acz + Math.cos(an) * r;
          a[k + 1] = acy + ASH_TOP - 1;
        } else if (ddx * ddx + ddz * ddz > ASH_R * ASH_R) {
          a[k] = acx - ddx * 0.97; a[k + 2] = acz - ddz * 0.97;
          if (a[k + 1] > acy + ASH_TOP) a[k + 1] = acy - 1 + hash3(sd, i, 1, 9) * ASH_TOP;
        }
      }
      ashGeo.attributes.position.needsUpdate = true;
    }
    waterU.uWT.value = time * (wc.reducedMotion ? 0.35 : 1);
    if (camera) for (const g of lakeGlints) {
      const dx = camera.position.x - g.x, dz = camera.position.z - g.z, d = Math.hypot(dx, dz) || 1;
      g.mesh.rotation.y = Math.atan2(dx, dz);
      const L = Math.min(g.len, d * 0.8), sh = 0.85 + 0.15 * Math.sin(time * 1.7 + g.x);
      g.mesh.scale.set(g.wid * sh, 1, L);
      g.mesh.position.x = g.x + (dx / d) * L * 0.42; g.mesh.position.z = g.z + (dz / d) * L * 0.42;
    }
    const sw = portalGroup.userData.swirls;
    sw[0].rotation.z = time * 0.16 * rm; sw[1].rotation.z = -time * 0.11 * rm;
    sw[0].material.opacity = 0.3 + 0.06 * Math.sin(time * 0.9);
    matKeyRune.emissiveIntensity = 1.0 + 0.25 * Math.sin(time * 1.3);
    matCapeRune.emissiveIntensity = (1.45 + 0.3 * Math.sin(time * 1.7) + hs.castW * 1.2) * (hs.deadW > 0.5 ? 0.15 : 1);
    es.sigilFlash *= Math.exp(-dt * 1.8);
    const status = snap ? snap.status : 'playing';
    const oath = status === 'victory' ? 1.6 : status === 'defeat' ? 0.25 : lerp(0.6, 1.0, bInfo.stageW);
    matSigilTop.emissiveIntensity += (oath + es.sigilFlash * 1.5 + bInfo.pulse * 0.05 - matSigilTop.emissiveIntensity) * dampK(4, dt);
    matFloorCracks.opacity = clamp((lerp(0.12, 0.6, bInfo.stageW) + bInfo.roarG * 0.3 + bInfo.pulse * 0.04) * (bInfo.isDead ? lerp(1, 0.35, 1 - bInfo.fade) : 1), 0, 1);
  }

  /* ================================= API ================================= */
  function update(dt, snapshot, events) {
    if (disposed) return;
    dt = clamp(num(dt, 1 / 60), 0, 0.1);
    time += dt;
    es.frame++;
    if (Array.isArray(events)) for (const ev of events) handleEvent(ev);
    const snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
    updateHero(dt, snap);
    const bInfo = updateBoss(dt, snap);
    updateEnv(dt, snap, bInfo);
    const aInfo = atmo.update(dt, {
      bossX: bossRoot.position.x, bossZ: bossRoot.position.z,
      stageW: bInfo.stageW, status: snap ? snap.status : 'playing',
    });
    followShadow();
    if (aInfo) {
      moonLight.color.copy(aInfo.keyColor);
      moonLight.intensity = aInfo.keyIntensity * PL;
      hemi.intensity = HEMI_I * PL * (1 + aInfo.skyFlash);
      fillLight.intensity = FILL_I * PL * (1 + aInfo.skyFlash);
    }
  }

  // [ASHEN_V3] теневая камера ключа едет за героем (в арене — ближе к центру, чтобы ловить колонны
  // и босса); центр привязан к texel-сетке света — тени не «кипят» при движении.
  const _sc = new THREE.Vector3(), _sr = new THREE.Vector3(), _su = new THREE.Vector3(), _sl = new THREE.Vector3();
  function followShadow() {
    const ld = _sl.copy(atmo.keyDir).normalize();
    const hx = heroRoot.position.x, hz = heroRoot.position.z;
    const k = 1 - 0.65 * smoothstep(30, 12, Math.hypot(hx, hz));
    _sc.set(hx * k, heroRoot.position.y, hz * k);
    _sr.set(0, 1, 0).cross(ld).normalize();
    _su.copy(ld).cross(_sr);
    const texel = (SHADOW_HALF * 2) / Math.max(256, moonLight.shadow.mapSize.x);
    const cr = _sc.dot(_sr), cu = _sc.dot(_su);
    _sc.addScaledVector(_sr, Math.round(cr / texel) * texel - cr).addScaledVector(_su, Math.round(cu / texel) * texel - cu);
    moonLight.target.position.copy(_sc);
    moonLight.position.copy(_sc).addScaledVector(ld, 80);
  }

  function setQuality(level) {
    if (disposed) return;
    quality = normQuality(level);
    const q = QUALITY_PRESETS[quality];
    const canShadow = !!(renderer && renderer.shadowMap && (renderer.shadowMap.enabled || wc.manageShadowMap));
    moonLight.castShadow = q.shadows && canShadow;
    if (moonLight.shadow.mapSize.x !== q.shadowSize) {
      moonLight.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (moonLight.shadow.map) { moonLight.shadow.map.dispose(); moonLight.shadow.map = null; }
    }
    for (const it of instTiers) it.mesh.count = it.counts[q.tier];
    ashGeo.setDrawRange(0, q.ash);
    braziers.forEach((bz, i) => { bz.light.visible = i < q.brazierLights; });
    clothEvery = q.clothNormals;
    matBlob.opacity = moonLight.castShadow ? 0.42 : 0.62;
    atmo.setQuality(quality);
  }

  function reset() {
    if (disposed) return;
    restorePieces();
    initState(); resetGait();
    time = 0;
    hCur.fill(0); poseOver(hCur, HP.idle);
    bCur.fill(0); poseOver(bCur, BP.idle1);
    tunic.off.set(0, 0); tunic.vel.set(0, 0); coatSkirt.off.set(0, 0); coatSkirt.vel.set(0, 0);
    capeState.off.set(0, 0); capeState.vel.set(0, 0);
    matSigilTop.emissiveIntensity = 0.6;
    mirror.data = null; mirror.w = 0; mirror.L.ok = false; mirror.R.ok = false;
    update(0, null, null);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (root.parent) root.parent.remove(root);
    atmo.dispose();
    if (renderer && renderer.shadowMap && wc.manageShadowMap && prevShadowEnabled !== undefined) renderer.shadowMap.enabled = prevShadowEnabled;
    root.traverse((o) => {
      if (o.isLight && o.shadow && o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
      if (o.isInstancedMesh && o.dispose) o.dispose();
    });
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) m.dispose();
    for (const t of owned.tex) t.dispose();
    owned.geo.clear(); owned.mat.clear(); owned.tex.clear();
    recentIds.clear(); recentQ.length = 0;
  }

  const plain = (o) => { _wp.setFromMatrixPosition(o.matrixWorld); return { x: _wp.x, y: _wp.y, z: _wp.z }; };
  // Точки для №6 (снаряды из руки, щит перед грудью и т.д.). Обычные {x,y,z}, актуальны после update().
  function getAnchors() {
    return {
      heroHandR: plain(hero.markers.handR), heroHandL: plain(hero.markers.handL), heroChest: plain(hero.markers.chestFront),
      heroHead: plain(hero.markers.headTop), heroFeet: { x: heroRoot.position.x, y: heroRoot.position.y, z: heroRoot.position.z },
      bossCore: plain(boss.markers.core), bossHead: plain(boss.markers.headTop), bossFistL: plain(boss.markers.fistL), bossFistR: plain(boss.markers.fistR),
    };
  }
  function configure(patch = {}) {
    if (!patch || typeof patch !== 'object') return;
    for (const k of ['reducedMotion', 'yawOffset', 'heroYawRate', 'bossYawRate']) if (k in patch) wc[k] = patch[k];
    if ('reducedMotion' in patch) atmo.configure({ reducedMotion: !!patch.reducedMotion });
    if ('ambientAsh' in patch) { wc.ambientAsh = !!patch.ambientAsh; ash.visible = wc.ambientAsh; }
    if ('quality' in patch) setQuality(patch.quality);
  }

  // Rim-шейдер и шейдерный fill (Библия, разд. 4): силуэт читается в любой точке арены.
  for (const m of [matCoat, matTunic, matCape, matTrousers, matLeather, matSkin, matGloveR, matGloveL, matCloth, matHood, matCapeRune]) {
    atmo.patchLit(m, 'hero');
    atmo.useEnv(m, 0.45);
  }
  for (const m of [matBoss, matBossDark, matBossMask, matBossRunes, B.mantleMat, B.hoodMat]) atmo.patchLit(m, 'boss');
  atmo.useEnv(matHaloBronze, 0.9);

  setQuality(initialQuality);
  reset();

  return {
    apiVersion: API_VERSION,
    root,
    update,
    setQuality,
    reset,
    dispose,
    getAnchors,
    configure,
    get quality() { return quality; },
    setMirror,
    setPoiState,
    layout,
    get assets() { return { pending: pbrState.pending, loaded: pbrState.loaded, failed: pbrState.failed }; },
    atmosphere: atmo,
  };
}
