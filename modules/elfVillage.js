// ASHEN OATH — Эльфийская деревня (зона большой карты, ASHEN_V3+).
//
// Светлый остров посреди пепельного мира: великое Древо с серебряной корой и золотой светящейся
// кроной (на нём дом-на-дереве с площадкой и винтовой лестницей), шесть эльфийских домов из белого
// камня с резными изогнутыми крышами-лепестками, золотой отделкой и тёплыми окнами, врата и арка
// с рунами, хрустальные фонари, клумбы светящихся цветов, трава, ручей от родника с кристаллами
// в пруд с кувшинками и горбатый мостик, светлячки и пыльца, мягкие лучи сквозь крону.
// Местный свет: тёплая полусфера и до 4 точечных огней (без теней) — их число постоянно
// (переключается только сменой качества), ближе к деревне интенсивность растёт; туман редеет
// (atmosphere.setLocalClear, если есть), пепел мир прореживает по village.weight.
// Жители — 7 аниме-эльфов VRoid (assets/vroid, CC0; клипы Quaternius перенесены modules/vrmKit.js):
// стражница с копьём у врат, гуляющие по кругу и через мостик, две собеседницы, сидящая у пруда,
// мастерица за работой. Подошёл ближе ~4 м — эльф поворачивается (корпус и голова), над головой
// имя и приветствие. Если VRM не загрузился — тот же житель на модели Quaternius.
// [LOAD] Жители грузятся лениво — при подходе к деревне или в простое после минуты игры (loadNpcs).
//
// Геометрия слита по материалам (≈20 вызовов отрисовки на всю деревню), мелочь — InstancedMesh
// с уровнями качества. Анимация жителей: один AnimationMixer на эльфа; обновляются только ближние
// (≤80 м, на low ≤40 м), дальние от 25 м — через кадр.
//
// Скелеты Quaternius «Animated Woman» и «Animated Human» НЕ взаимозаменяемы по клипам напрямую
// (разная поза покоя и масштаб костей — сырой клип другой модели ломает позу), поэтому запасные
// жители играют только клипы своей модели (сидящие — Woman, SitIdle; работа — Human, Working);
// для VRM клипы переносятся по мировым направлениям костей (vrmKit.retargetClip) — это корректно.
//
// export: ELF_VILLAGE (центр, радиус, уровень земли, место угля), createElfVillage(opts)
//   createElfVillage({ THREE, parent, groundY, quality, reducedMotion, camera, atmosphere, lightUnit })
//     → { root, update(dt, playerPos), setQuality(q), configure(patch), dispose(),
//         center, radius, colliders, groundAt(x, z), get weight, stats() }

import { applyLook, clipMap } from './characterLooks.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep = (a, b, v) => smooth01(clamp((v - a) / (b - a), 0, 1));
const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);
const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Зона на карте: восток, за дорогой «город ↔ кладбище». Рельеф в круге r ровняет world.terrainH
// (к уровню level), поэтому видимая земля и земля раскладки совпадают.
export const ELF_VILLAGE = Object.freeze({
  id: 'elf-village', name: 'Эльфийская деревня',
  x: 178, z: 14, r: 30, level: -4.2,
  ember: Object.freeze({ dx: -19, dz: -6.5 }),   // поляна под уголь клятвы сразу за воротами
  gate: Object.freeze({ dx: -30, dz: 0 }),        // врата смотрят на запад, к дороге от арены
});

const QV = {
  low:    { leaves: 1100, flowers: 700,  grass: 500,  flies: 160, lights: 0, animR: 40, orbs: 0.5, npcR: 45, shadowR: 0 },
  medium: { leaves: 2000, flowers: 1400, grass: 1100, flies: 340, lights: 2, animR: 70, orbs: 1, npcR: 65, shadowR: 12 },
  high:   { leaves: 2800, flowers: 2100, grass: 1800, flies: 520, lights: 3, animR: 90, orbs: 1, npcR: 80, shadowR: 14 },
};
const normQ = (q) => (q === 'low' || q === 'high' ? q : 'medium');

// Жители — аниме-эльфы VRoid (assets/vroid/*.vrm, CC0) с клипами Quaternius, перенесёнными
// modules/vrmKit.js. Каждый файл VRM грузится один раз: из него делается «шаблон» (меши слиты по
// материалам: ~100 → ~20 вызовов отрисовки на эльфа; уши эльфа на кости головы), клипы
// переносятся на шаблон один раз и «запекаются» на сырые кости, а жители — клоны шаблона
// (SkeletonUtils.clone) со своим AnimationMixer. Пружинные кости (волосы) у клонов не считаются.
// Если VRM не загрузился (нет @pixiv/three-vrm в importmap и т. п.) — житель на модели
// Quaternius (q.model, q.look через characterLooks.applyLook).
// mode: guard | walk | idle | sit | work.
const GUARD_Q = { skin: '#efd6c0', dark: '#1d2a26', hair: '#efe6c8', top: '#d9ded2', pants: '#2f6a55', shoes: '#6a4a2e', ears: true, circlet: '#ffd88a', cape: '#1f7a5c', glow: '#7dffcf' };
const NPC_DEFS = [
  { id: 'guard', vrm: 'elf', h: 1.74, q: { model: 'woman', look: GUARD_Q, h: 1.8 }, name: 'Страж врат Аэлирэн', hello: 'Добро пожаловать, путник', mode: 'guard', dx: -28.2, dz: 2.25, yaw: -Math.PI / 2 + 0.3, spear: true },
  { id: 'walker-a', vrm: 'villager_e', h: 1.58, q: { model: 'woman', look: 'elfA', h: 1.72 }, name: 'Лаэрвен', hello: 'Затмение не властно над нашей рощей', mode: 'walk', path: 'ringOut', speed: 1.1, s0: 0.05 },
  { id: 'walker-b', vrm: 'villager_g', h: 1.68, q: { model: 'woman', look: 'elfD', h: 1.74 }, name: 'Садовница Элвэн', hello: 'Цветы здесь помнят солнце', mode: 'walk', path: 'bridge', speed: 1.05, s0: 0 },
  { id: 'talk-a', vrm: 'villager_g', h: 1.68, q: { model: 'woman', look: 'elfC', h: 1.76 }, name: 'Сказительница Ильмарэ', hello: 'Послушай песнь о первом рассвете', mode: 'idle', dx: -9.9, dz: 11.3, faceTo: 'talk-b' },
  { id: 'talk-b', vrm: 'villager_e', h: 1.55, q: { model: 'woman', look: 'elfB', h: 1.66 }, name: 'Юная Ниэль', hello: 'Ты пришёл из пепла? Расскажи!', mode: 'idle', dx: -8.75, dz: 12.35, faceTo: 'talk-a' },
  { id: 'sit-pond', vrm: 'villager_g', h: 1.66, q: { model: 'woman', look: 'elfB', h: 1.74 }, name: 'Мирэа', hello: 'По ночам вода здесь поёт', mode: 'sit', bench: 'pond' },
  { id: 'worker', vrm: 'villager_e', h: 1.58, q: { model: 'human', look: 'elfC', h: 1.8 }, name: 'Мастерица Орэна', hello: 'Кристалл любит терпение', mode: 'work', dx: -11, dz: -15.9, yaw: Math.PI },
];
const VRM_FILES = { elf: 'elf.vrm', villager_e: 'villager_e.vrm', villager_g: 'villager_g.vrm' };
const VRM_EARS = { villager_e: '#fbe0d0', villager_g: '#fde6d8' };   // у elf.vrm уши свои
// клип жителя → [модель-источник Quaternius, имя клипа в ней]
const CLIP_SRC = { Idle: ['woman', 'Idle'], Walk: ['woman', 'Walking'], SitIdle: ['woman', 'SitIdle'], Working: ['human', 'Working'] };
const MTOON_LIT = 0.5;   // множитель освещённого/теневого цвета MToon (см. prepareVrmTemplate)
const clipsFor = (d) => (d.mode === 'walk' ? ['Walk', 'Idle'] : d.mode === 'sit' ? ['SitIdle'] : d.mode === 'work' ? ['Working', 'Idle'] : ['Idle']);

/* ------------------------------ Текстуры ------------------------------ */
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function valueNoise(seed) {
  const rnd = mulberry32(seed), N = 64, g = new Float32Array(N * N);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (x, y) => g[((y % N + N) % N) * N + ((x % N + N) % N)];
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v);
  };
}
function paintMarble(size, seed) {
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const n = valueNoise(seed), P = 8 / size; // период 8 клеток шума — бесшовно
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const f = n(x * P, y * P) * 0.5 + n(x * P * 2, y * P * 2) * 0.3 + n(x * P * 4, y * P * 4) * 0.2;
    const vein = Math.pow(1 - Math.abs(Math.sin((x * P + f * 3.2) * Math.PI)), 18) * 0.12;
    const v = clamp(0.86 + (f - 0.5) * 0.16 - vein, 0, 1) * 255;
    const i = (y * size + x) * 4;
    d[i] = v; d[i + 1] = v * 0.99; d[i + 2] = v * 0.965; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function paintBark(size, seed) {
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const n = valueNoise(seed), P = 8 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const s = n(x * P * 4, y * P * 0.5) * 0.6 + n(x * P * 8, y * P) * 0.4;       // продольные волокна
    const len = n(x * P * 2 + 7, y * P * 6 + 3);                                  // поперечные чечевички
    const dash = len > 0.78 ? (len - 0.78) * 2.2 : 0;
    const v = clamp(0.8 + (s - 0.5) * 0.35 - dash, 0, 1) * 255;
    const i = (y * size + x) * 4;
    d[i] = v * 0.97; d[i + 1] = v; d[i + 2] = v * 0.98; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
function paintWood(w, h, seed) {
  const c = canvas(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
  const n = valueNoise(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = n(x * 0.5, y * 0.03) * 0.7 + n(x * 1.3, y * 0.08) * 0.3;
    const v = clamp(0.72 + (g - 0.5) * 0.5 + 0.1 * Math.sin(x * 0.9 + g * 6), 0, 1) * 255;
    const i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// Черепица-лепестки: ряды скруглённых чешуй, светлый верх, тёмная кромка.
function paintShingles(size) {
  const c = canvas(size, size), ctx = c.getContext('2d');
  ctx.fillStyle = '#6f6f6f'; ctx.fillRect(0, 0, size, size);
  const rows = 8, cols = 6, rh = size / rows, cw = size / cols;
  for (let r = rows; r >= -1; r--) {
    const off = (r & 1) * cw * 0.5;
    for (let k = -1; k <= cols; k++) {
      const cx = k * cw + off + cw / 2, top = r * rh;
      const gr = ctx.createLinearGradient(0, top, 0, top + rh * 1.35);
      gr.addColorStop(0, '#f2f2f2'); gr.addColorStop(0.7, '#d0d0d0'); gr.addColorStop(1, '#7c7c7c');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(cx - cw / 2, top);
      ctx.lineTo(cx - cw / 2, top + rh * 0.6);
      ctx.quadraticCurveTo(cx - cw / 2, top + rh * 1.35, cx, top + rh * 1.4);
      ctx.quadraticCurveTo(cx + cw / 2, top + rh * 1.35, cx + cw / 2, top + rh * 0.6);
      ctx.lineTo(cx + cw / 2, top);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, top + rh * 0.2); ctx.lineTo(cx, top + rh * 1.2); ctx.stroke();
    }
  }
  return c;
}
function paintLeaf() {
  const c = canvas(64, 128), ctx = c.getContext('2d');
  const gr = ctx.createLinearGradient(0, 0, 64, 0);
  gr.addColorStop(0, '#d9d9d9'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(1, '#cfcfcf');
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.moveTo(32, 124);
  ctx.bezierCurveTo(4, 96, 2, 40, 32, 3);
  ctx.bezierCurveTo(62, 40, 60, 96, 32, 124);
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,150,150,0.8)'; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(32, 122); ctx.lineTo(32, 10); ctx.stroke();
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 6; i++) {
    const y = 104 - i * 16;
    ctx.beginPath(); ctx.moveTo(32, y); ctx.lineTo(14, y - 14); ctx.moveTo(32, y); ctx.lineTo(50, y - 14); ctx.stroke();
  }
  return c;
}
function paintFlowers(seed) {
  const c = canvas(128, 128), ctx = c.getContext('2d'), rnd = mulberry32(seed);
  ctx.lineCap = 'round';
  const heads = [];
  for (let i = 0; i < 7; i++) heads.push([14 + rnd() * 100, 16 + rnd() * 62, 7 + rnd() * 7]);
  // стебли и листья (тёмные — оттенок экземпляра их почти не меняет)
  ctx.strokeStyle = '#38583a'; ctx.lineWidth = 2.4;
  for (const [x, y] of heads) { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + (rnd() - 0.5) * 14, (y + 128) / 2, x + (rnd() - 0.5) * 10, 128); ctx.stroke(); }
  ctx.fillStyle = '#44683f';
  for (let i = 0; i < 6; i++) {
    const x = 10 + rnd() * 108, y = 100 + rnd() * 26;
    ctx.beginPath(); ctx.ellipse(x, y, 4, 13, (rnd() - 0.5) * 1.4, 0, TAU); ctx.fill();
  }
  for (const [x, y, r] of heads) {
    ctx.fillStyle = '#ffffff';
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * TAU + rnd();
      ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.55, r * 0.32, a, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#fff1b8';
    ctx.beginPath(); ctx.arc(x, y, r * 0.28, 0, TAU); ctx.fill();
  }
  return c;
}
function paintGrass(seed) {
  const c = canvas(64, 64), ctx = c.getContext('2d'), rnd = mulberry32(seed);
  for (let i = 0; i < 14; i++) {
    const x = 4 + rnd() * 56, h = 30 + rnd() * 32, w = 2 + rnd() * 2.5, lean = (rnd() - 0.5) * 18;
    const gr = ctx.createLinearGradient(0, 64, 0, 64 - h);
    gr.addColorStop(0, '#5a5a5a'); gr.addColorStop(1, '#f4f4f4');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.moveTo(x - w, 64); ctx.quadraticCurveTo(x + lean * 0.3, 64 - h * 0.6, x + lean, 64 - h); ctx.quadraticCurveTo(x + lean * 0.3 + 1, 64 - h * 0.6, x + w, 64); ctx.fill();
  }
  return c;
}
// Эльфийские руны: плавные дуги, петли, стебли и точки — горизонтальная лента из 8 знаков.
function paintRunes(seed) {
  const c = canvas(512, 64), ctx = c.getContext('2d'), rnd = mulberry32(seed);
  ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 4;
  for (let g = 0; g < 8; g++) {
    const x0 = g * 64 + 32, y0 = 32;
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(x0 - 4 + (rnd() - 0.5) * 6, y0 + 20);
    ctx.lineTo(x0 - 4 + (rnd() - 0.5) * 6, y0 - 20 + rnd() * 8);          // стебель
    ctx.stroke();
    const k = (rnd() * 4) | 0;
    ctx.beginPath();
    if (k === 0) ctx.arc(x0 + 4, y0 - 6, 9, Math.PI * 0.8, Math.PI * 2.3);          // крюк
    else if (k === 1) { ctx.moveTo(x0 - 4, y0 - 14); ctx.bezierCurveTo(x0 + 18, y0 - 22, x0 + 18, y0 + 4, x0 - 4, y0); } // петля
    else if (k === 2) ctx.arc(x0 + 5, y0 + 6, 8, -Math.PI * 0.6, Math.PI * 0.9);      // чаша
    else { ctx.moveTo(x0 - 4, y0 + 2); ctx.quadraticCurveTo(x0 + 14, y0 - 16, x0 + 16, y0 + 12); }
    ctx.stroke();
    if (rnd() < 0.7) { ctx.beginPath(); ctx.arc(x0 + 10 + rnd() * 6, y0 - 22 + rnd() * 6, 2.6, 0, TAU); ctx.fill(); }  // тэхта-точка
    if (rnd() < 0.5) { ctx.beginPath(); ctx.moveTo(x0 - 16, y0 + 22); ctx.quadraticCurveTo(x0, y0 + 14, x0 + 16, y0 + 22); ctx.stroke(); }
  }
  return c;
}
// Каустика: ячейки Вороного (бесшовно), светлые — края ячеек.
function paintCaustics(size, seed) {
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const rnd = mulberry32(seed), pts = [];
  for (let i = 0; i < 14; i++) pts.push([rnd() * size, rnd() * size]);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let d1 = 1e9, d2 = 1e9;
    for (const [px, py] of pts) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const dx = x - px - ox * size, dy = y - py - oy * size, dd = dx * dx + dy * dy;
      if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) d2 = dd;
    }
    const e = Math.sqrt(d2) - Math.sqrt(d1);
    const v = clamp(Math.pow(clamp(1 - e / 9, 0, 1), 3) * 0.95 + 0.05, 0, 1) * 255;
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
// Луг: мшистая зелень с пятнами, светлые штрихи травинок и редкие цветочные точки (бесшовно).
function paintMeadow(size, seed) {
  const c = canvas(size, size), ctx = c.getContext('2d'), img = ctx.createImageData(size, size), d = img.data;
  const n = valueNoise(seed), P = 8 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const f = n(x * P, y * P) * 0.55 + n(x * P * 3, y * P * 3) * 0.3 + n(x * P * 9, y * P * 9) * 0.15;
    const i = (y * size + x) * 4;
    d[i] = clamp(52 + f * 50, 0, 255); d[i + 1] = clamp(92 + f * 72, 0, 255); d[i + 2] = clamp(44 + f * 34, 0, 255); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rnd = mulberry32(seed + 1);
  ctx.lineCap = 'round';
  for (let k = 0; k < 900; k++) {
    const x = rnd() * size, y = rnd() * size, l = 2 + rnd() * 5, a = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(170,215,120,0.55)' : 'rgba(40,80,35,0.5)';
    ctx.lineWidth = 0.8 + rnd();
    for (const ox of [0, -size, size]) for (const oy of [0, -size, size]) {
      ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l); ctx.stroke();
    }
  }
  const dots = ['#fff4d6', '#ffd66b', '#ffb3d9', '#c8b0ff'];
  for (let k = 0; k < 70; k++) {
    ctx.fillStyle = dots[(rnd() * dots.length) | 0];
    ctx.beginPath(); ctx.arc(rnd() * size, rnd() * size, 0.9 + rnd() * 1.1, 0, TAU); ctx.fill();
  }
  return c;
}
function paintGlow(size) {
  const c = canvas(size, size), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.65, 'rgba(255,255,255,0.1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return c;
}
function paintLabel(name, hello) {
  const c = canvas(512, 128), ctx = c.getContext('2d');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.95)'; ctx.shadowBlur = 8;
  ctx.font = 'bold 40px Georgia, "Times New Roman", serif';
  ctx.fillStyle = '#ffe3a0';
  ctx.fillText(name, 256, hello ? 38 : 64);
  if (hello) {
    ctx.font = 'italic 30px Georgia, "Times New Roman", serif';
    ctx.fillStyle = '#f2fff8';
    ctx.fillText('«' + hello + '»', 256, 92, 500);
  }
  return c;
}

/* ------------------------------ Шейдеры ------------------------------ */
const POINTS_VERT = /* glsl */`
attribute vec3 aColor;
attribute vec4 aAnim;   // амплитуда, частота, фаза, мигание
attribute float aSize;
uniform float uTime;
uniform float uScale;
uniform float uMotion;
varying vec3 vColor;
void main() {
  vec3 p = position;
  float t = uTime * aAnim.y * uMotion;
  if ( aAnim.x > 0.0 ) {
    p += vec3( sin( t + aAnim.z ) + 0.5 * sin( t * 2.3 + aAnim.z * 1.7 ),
               0.6 * sin( t * 1.3 + aAnim.z * 2.1 ),
               cos( t * 0.9 + aAnim.z ) + 0.5 * cos( t * 1.9 + aAnim.z * 0.7 ) ) * aAnim.x;
  }
  float b = 0.86 + 0.14 * sin( uTime * 0.9 + aAnim.z );
  if ( aAnim.w > 0.0 ) { float s = 0.5 + 0.5 * sin( uTime * aAnim.w + aAnim.z * 3.0 ); b = 0.12 + 0.88 * s * s * s * s; }
  vColor = aColor * b;
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_PointSize = min( aSize * uScale / max( 0.2, - mv.z ), 320.0 );
  gl_Position = projectionMatrix * mv;
}`;
const POINTS_FRAG = /* glsl */`
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot( q, q ) * 4.0;
  float a = exp( - d2 * 5.0 ) + 0.35 * exp( - d2 * 40.0 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( vColor * a, 1.0 );
}`;
const RAY_VERT = /* glsl */`
attribute float aSeed;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vSeed;
void main() {
  vUv = uv; vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vN = normalize( normalMatrix * normal );
  vV = - mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const RAY_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying float vSeed;
void main() {
  float edge = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.6 );
  float fall = smoothstep( 0.0, 0.3, vUv.y ) * ( 1.0 - smoothstep( 0.7, 1.0, vUv.y ) );
  float flick = 0.75 + 0.25 * sin( uTime * 0.6 + vSeed * 6.2831 ) * sin( uTime * 0.23 + vSeed * 3.1 );
  float a = edge * fall * uIntensity * flick;
  gl_FragColor = vec4( uColor * a, 1.0 );
}`;

/* =============================== ДЕРЕВНЯ =============================== */
export function createElfVillage({
  THREE, parent, groundY, quality = 'medium', reducedMotion = false, camera = null,
  atmosphere = null, lightUnit = 1, seed = 4242, npcEager = false,
} = {}) {
  if (!THREE || !parent || typeof groundY !== 'function') throw new Error('[elfVillage] нужны THREE, parent и groundY');
  const V = ELF_VILLAGE, CX = V.x, CZ = V.z;
  // [W5-ПОЛ] луг лежит на MEADOW_LIFT выше рельефа и тает к краю; floorLift(x, z) — его высота для земли героя
  // (world.layoutGroundY), иначе стопы уходили в луг на 3,5 см
  const MEADOW_LIFT = 0.035, MEADOW_R = V.r + 1;
  const floorLift = (x, z) => { const d = Math.hypot(x - CX, z - CZ); return d >= MEADOW_R ? 0 : MEADOW_LIFT * (1 - smoothstep(MEADOW_R - 8, MEADOW_R - 0.5, d)); };
  const rnd = mulberry32(seed);
  const gy = (x, z) => { const y = groundY(x, z); return Number.isFinite(y) ? y : V.level; };
  const W = (dx, dz) => ({ x: CX + dx, z: CZ + dz });
  const state = { disposed: false, quality: normQ(quality), reduced: !!reducedMotion, time: 0, frame: 0, weight: 0, npcReady: false, npcError: null };

  const owned = { geo: new Set(), mat: new Set(), tex: new Set() };
  const G = (g) => { owned.geo.add(g); return g; };
  const M = (m) => { owned.mat.add(m); return m; };
  const T = (t) => { owned.tex.add(t); return t; };
  function tex(c, { repeat = true, srgb = true } = {}) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return T(t);
  }

  const root = new THREE.Group();
  root.name = 'elf-village';
  parent.add(root);
  const lightsGroup = new THREE.Group();   // огни — не внутри root: скрытие root не должно менять число источников
  lightsGroup.name = 'elf-village-lights';
  parent.add(lightsGroup);

  /* ----------------------------- Коллайдеры ----------------------------- */
  const colliders = [];
  const circle = (x, z, r) => colliders.push({ type: 'circle', x, z, r });
  const segment = (ax, az, bx, bz, r) => colliders.push({ type: 'segment', ax, az, bx, bz, r });

  /* ------------------------------ Текстуры ------------------------------ */
  const texMarble = tex(paintMarble(128, seed + 1));
  const texBark = tex(paintBark(128, seed + 2));
  const texWood = tex(paintWood(64, 128, seed + 3));
  const texShingle = tex(paintShingles(128));
  texShingle.repeat.set(10, 3);
  const texLeaf = tex(paintLeaf(), { repeat: false });
  const texFlower = tex(paintFlowers(seed + 4), { repeat: false });
  const texGrass = tex(paintGrass(seed + 5), { repeat: false });
  const texRunes = tex(paintRunes(seed + 6));
  const causticC = paintCaustics(128, seed + 7);
  const texCausticPond = tex(causticC);
  texCausticPond.repeat.set(3.4, 3.4);
  const texCausticStream = tex(causticC);
  texCausticStream.repeat.set(2.2, 2.2);
  const texGlow = tex(paintGlow(64), { repeat: false });

  /* ------------------------------ Материалы ------------------------------ */
  // Эмиссия по цвету вершины/экземпляра: один материал на окна, цветы и листья разных оттенков.
  function glowByColor(mat, k, key) {
    const u = { value: k };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uElfGlow = u;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uElfGlow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR ) || defined( USE_COLOR_ALPHA )
  totalEmissiveRadiance *= vColor.rgb * uElfGlow;
#endif`);
    };
    mat.customProgramCacheKey = () => 'elfGlow:' + key;
    return u;
  }
  const std = (p) => M(new THREE.MeshStandardMaterial(p));
  const matWhite = std({ color: 0xf6f1e6, map: texMarble, roughness: 0.52, metalness: 0, vertexColors: true });
  const matWood = std({ color: 0xffffff, map: texWood, roughness: 0.74, metalness: 0, vertexColors: true });
  const matRoof = std({ color: 0xffffff, map: texShingle, roughness: 0.5, metalness: 0.05, vertexColors: true, side: THREE.DoubleSide, emissive: 0xffffff, emissiveIntensity: 1 });
  const roofGlow = glowByColor(matRoof, 0.07, 'roof');
  const matGold = std({ color: 0xeac46a, roughness: 0.26, metalness: 0.9, emissive: 0x7a5418, emissiveIntensity: 0.45 });
  const matGlow = M(new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }));
  const matCrystal = std({ color: 0xd8fbff, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.12, metalness: 0.1, flatShading: true, vertexColors: true });
  const crystalGlow = glowByColor(matCrystal, 2.2, 'crystal');
  const matBark = std({ color: 0xdfe3dc, map: texBark, roughness: 0.72, metalness: 0.05, vertexColors: true });
  const matVine = std({ color: 0x4f9c57, roughness: 0.8, metalness: 0 });
  const matLeaves = std({ color: 0xffffff, map: texLeaf, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, emissive: 0xffffff, emissiveIntensity: 1 });
  const leafGlow = glowByColor(matLeaves, 0.8, 'leaf');
  const matFlower = std({ color: 0xffffff, map: texFlower, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.7, emissive: 0xffffff, emissiveMap: texFlower, emissiveIntensity: 1 });
  const flowerGlow = glowByColor(matFlower, 0.42, 'flower');
  const matGrass = std({ color: 0xffffff, map: texGrass, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, emissive: 0xffffff, emissiveMap: texGrass, emissiveIntensity: 1 });
  glowByColor(matGrass, 0.06, 'grass');
  const matPath = std({ color: 0xf1ece0, map: texMarble, roughness: 0.8, metalness: 0 });
  const matRock = std({ color: 0xc4c8c0, roughness: 0.88, metalness: 0, flatShading: true });
  const matLily = std({ color: 0x3f8f52, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, emissive: 0x0d2a14, emissiveIntensity: 1 });
  const matOrb = M(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const matWater = std({ color: 0x0b3a46, roughness: 0.08, metalness: 0.15, emissive: 0x39e6d2, emissiveMap: texCausticPond, emissiveIntensity: 0.6 });
  const matStream = std({ color: 0x0b3a46, roughness: 0.08, metalness: 0.15, emissive: 0x39e6d2, emissiveMap: texCausticStream, emissiveIntensity: 0.55 });
  const matRunes = M(new THREE.MeshBasicMaterial({ map: texRunes, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  matRunes.color.setRGB(2.6, 1.9, 0.8);
  if (atmosphere && atmosphere.useEnv) { atmosphere.useEnv(matGold, 1.1); atmosphere.useEnv(matWater, 1.6); atmosphere.useEnv(matStream, 1.4); atmosphere.useEnv(matCrystal, 0.8); }

  /* ------------------------------ Геометрия ------------------------------ */
  const B = { white: [], wood: [], roof: [], gold: [], glow: [], crystal: [], bark: [], vine: [] };
  const _c = new THREE.Color();
  function put(list, g, color, x = 0, y = 0, z = 0, yaw = 0) {
    if (g.index === null && g.attributes.position.count === 0) return g;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    let r = 1, gg = 1, b = 1;
    if (Array.isArray(color)) [r, gg, b] = color;
    else if (color !== undefined && color !== null) { _c.set(color); r = _c.r; gg = _c.g; b = _c.b; }
    for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (yaw) g.rotateY(yaw);
    if (x || y || z) g.translate(x, y, z);
    list.push(g);
    return g;
  }
  function merge(list) {
    let vCount = 0, iCount = 0;
    for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2), col = new Float32Array(vCount * 3);
    const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    for (const g of list) {
      const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = g.attributes.color;
      pos.set(p.array.length === p.count * 3 && !p.isInterleavedBufferAttribute ? p.array : Float32Array.from({ length: p.count * 3 }, (_, k) => p.getComponent((k / 3) | 0, k % 3)), vo * 3);
      for (let i = 0; i < p.count; i++) {
        nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i);
        if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
        col[(vo + i) * 3] = c.getX(i); col[(vo + i) * 3 + 1] = c.getY(i); col[(vo + i) * 3 + 2] = c.getZ(i);
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      else for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      vo += p.count; io += g.index ? g.index.count : p.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return G(out);
  }
  const lathe = (prof, seg) => new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)), seg);
  // Труба по кривой с сужением r0 → r1 (ветви, корни, лозы, арки).
  function tube(pts, r0, r1 = r0, seg = 16, rad = 6) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))));
    const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
    const p = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      curve.getPointAt(t, c);
      const r = lerp(r0, r1, t);
      for (let j = 0; j <= rad; j++) {
        const k = i * (rad + 1) + j;
        v.fromBufferAttribute(p, k).sub(c).multiplyScalar(r).add(c);
        p.setXYZ(k, v.x, v.y, v.z);
      }
    }
    return g;
  }
  // Лента вдоль ломаной: side — полуширина-вектор в каждой точке, u — по длине (для рун/воды).
  function ribbon(pts, sides, uScale = 1, lift = null) {
    const n = pts.length, pos = new Float32Array(n * 2 * 3), uv = new Float32Array(n * 2 * 2), idx = [];
    let L = 0;
    for (let i = 0; i < n; i++) {
      if (i) L += pts[i].distanceTo(pts[i - 1]);
      const s = sides[i];
      for (let k = 0; k < 2; k++) {
        const sg = k ? 1 : -1, o = (i * 2 + k);
        pos[o * 3] = pts[i].x + s.x * sg; pos[o * 3 + 1] = pts[i].y + s.y * sg + (lift ? lift(i, k) : 0); pos[o * 3 + 2] = pts[i].z + s.z * sg;
        uv[o * 2] = L * uScale; uv[o * 2 + 1] = k;
      }
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // Стрельчатый проём-лист (окна, двери): плоская фигура в XY, низ в y=0.
  function leafArch(w, h, h0 = h * 0.55) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(-w / 2, h0);
    s.quadraticCurveTo(-w / 2, h0 + (h - h0) * 0.85, 0, h);
    s.quadraticCurveTo(w / 2, h0 + (h - h0) * 0.85, w / 2, h0);
    s.lineTo(w / 2, 0); s.closePath();
    return new THREE.ShapeGeometry(s, 6);
  }
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  /* ------------------------------ План деревни ------------------------------ */
  // Смещения (dx, dz) от центра; мировые координаты — W(dx, dz). Древо — в центре.
  const HOUSES = [
    { dx: -14, dz: 15, R: 3.0, H: 3.3, tower: true, roof: 0x5cbc72 },
    { dx: 3, dz: 22.5, R: 3.4, H: 3.6, tower: false, roof: 0x3fb0a0 },
    { dx: 20, dz: 20, R: 2.7, H: 3.1, tower: false, roof: 0xe0ae52 },
    { dx: 29, dz: -6, R: 3.0, H: 3.3, tower: true, roof: 0x6ccc80 },
    { dx: -2, dz: -23, R: 3.3, H: 3.7, tower: false, roof: 0x49b893 },
    { dx: -20, dz: -16, R: 2.6, H: 3.0, tower: false, roof: 0xd49a4a },
  ];
  const POND = { dx: 14, dz: -15, r: 5.2 };
  const STREAM_CP = [[31, 13], [27, 8.5], [23.5, 3.2], [20.8, -2], [18.6, -7], [16.8, -10.6], [15.8, -12.2]];
  const TRUNK_R = 4.2;                                     // коллайдер ствола с корнями
  const PLATFORM_Y = 8.4, PLATFORM_R0 = 1.75, PLATFORM_R1 = 5.2;
  const RING_R = 11;
  const center = { x: CX, y: gy(CX, CZ), z: CZ };
  const baseY = center.y;

  // Ручей: центральная линия (мировые x,z) по кривой Катмулла–Рома.
  const streamCurve = new THREE.CatmullRomCurve3(STREAM_CP.map(([dx, dz]) => V3(CX + dx, 0, CZ + dz)));
  const STREAM_N = 56;
  const streamPts = streamCurve.getSpacedPoints(STREAM_N);
  const streamW = (t) => lerp(0.7, 2.3, smoothstep(0, 0.18, t)) * (1 - 0.15 * smoothstep(0.85, 1, t));
  function distToPolyline(x, z, pts) {
    let best = 1e9;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1;
      const u = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
      const d = Math.hypot(x - a.x - ex * u, z - a.z - ez * u);
      if (d < best) best = d;
    }
    return best;
  }
  // Мостик: поперёк ручья там, где тропа от круга идёт к дому №4.
  const bridge = (() => {
    const target = W(20.9, -1.6);
    let bi = 0, bd = 1e9;
    streamPts.forEach((p, i) => { const d = Math.hypot(p.x - target.x, p.z - target.z); if (d < bd) { bd = d; bi = i; } });
    const p = streamPts[bi], q = streamPts[Math.min(STREAM_N, bi + 1)], r0 = streamPts[Math.max(0, bi - 1)];
    const tx = q.x - r0.x, tz = q.z - r0.z, tl = Math.hypot(tx, tz) || 1;
    let nx = tz / tl, nz = -tx / tl;                     // перпендикуляр к течению
    if (nx < 0) { nx = -nx; nz = -nz; }                   // «A» — западный берег
    const half = 2.9;
    const A = { x: p.x - nx * half, z: p.z - nz * half }, Bp = { x: p.x + nx * half, z: p.z + nz * half };
    return { A, B: Bp, cx: p.x, cz: p.z, ux: nx, uz: nz, half, w: 0.85, rise: 0.62, yA: gy(A.x, A.z), yB: gy(Bp.x, Bp.z) };
  })();
  function bridgeDeckY(u) { return lerp(bridge.yA, bridge.yB, u) + 0.05 + bridge.rise * Math.sin(Math.PI * u); }
  // Высота опоры на мостике (для героя и жителей) или null — обычная земля.
  function groundAt(x, z) {
    const dx = x - bridge.A.x, dz = z - bridge.A.z;
    const L = bridge.half * 2;
    const u = (dx * bridge.ux + dz * bridge.uz) / L;
    if (u < 0 || u > 1) return null;
    const v = Math.abs(-dx * bridge.uz + dz * bridge.ux);
    if (v > bridge.w) return null;
    return bridgeDeckY(u);
  }
  const floorAt = (x, z) => { const b = groundAt(x, z); return b !== null ? Math.max(b, gy(x, z)) : gy(x, z); };

  // Тропы: главная от врат, круг вокруг Древа, лучи к дверям, к мостику и дому за ручьём.
  const houseDoor = (h) => {
    const a = Math.atan2(-h.dx, -h.dz);                   // дверь смотрит на Древо
    return { a, x: CX + h.dx + Math.sin(a) * (h.R * 1.05 + 0.35), z: CZ + h.dz + Math.cos(a) * (h.R * 1.05 + 0.35) };
  };
  const ringPt = (x, z, r = RING_R) => { const a = Math.atan2(x - CX, z - CZ); return V3(CX + Math.sin(a) * r, 0, CZ + Math.cos(a) * r); };
  const PATHS = [];
  PATHS.push([V3(CX - 36, 0, CZ + 0.2), V3(CX - 22, 0, CZ), V3(CX - RING_R, 0, CZ)]);
  { const pts = []; for (let i = 0; i <= 64; i++) { const a = (i / 64) * TAU; pts.push(V3(CX + Math.sin(a) * RING_R, 0, CZ + Math.cos(a) * RING_R)); } PATHS.push(pts); }
  HOUSES.forEach((h, i) => {
    if (i === 3) return;                                  // дом за ручьём — через мостик
    const d = houseDoor(h);
    PATHS.push([ringPt(d.x, d.z), V3(d.x, 0, d.z)]);
  });
  const H4door = houseDoor(HOUSES[3]);
  const bridgePath = [ringPt(bridge.A.x - bridge.ux * 3, bridge.A.z - bridge.uz * 3), V3(bridge.A.x - bridge.ux * 0.4, 0, bridge.A.z - bridge.uz * 0.4),
    V3(bridge.A.x, 0, bridge.A.z), V3(bridge.B.x, 0, bridge.B.z), V3(bridge.B.x + bridge.ux * 0.5, 0, bridge.B.z + bridge.uz * 0.5), V3(H4door.x, 0, H4door.z)];
  PATHS.push(bridgePath);
  const BENCHES = {
    pond: (() => { const x = CX + POND.dx - 7.1, z = CZ + POND.dz + 1.2; return { x, z, yaw: Math.atan2(CX + POND.dx - x, CZ + POND.dz - z) }; })(),
    tree: (() => { const a = Math.PI * 0.27, r = 6.35; return { x: CX + Math.sin(a) * r, z: CZ + Math.cos(a) * r, yaw: a }; })(),
  };
  PATHS.push([ringPt(BENCHES.pond.x, BENCHES.pond.z), V3(BENCHES.pond.x - Math.sin(BENCHES.pond.yaw) * -0.9, 0, BENCHES.pond.z - Math.cos(BENCHES.pond.yaw) * -0.9)]);
  const WORKER = NPC_DEFS.find((d) => d.id === 'worker');
  const workBench = W(WORKER.dx, WORKER.dz - 0.62);
  const EMBER = W(V.ember.dx, V.ember.dz);
  const GATE = W(V.gate.dx, V.gate.dz);

  // Занятые места (для травы, цветов, фонарей).
  const houseW = HOUSES.map((h) => ({ ...W(h.dx, h.dz), R: h.R }));
  const pondW = W(POND.dx, POND.dz);
  function blocked(x, z, m = 0, { paths = true, pathM = 1.25 } = {}) {
    if (Math.hypot(x - CX, z - CZ) < TRUNK_R + 0.6 + m) return true;
    for (const h of houseW) if (Math.hypot(x - h.x, z - h.z) < h.R * 1.16 + m) return true;
    if (Math.hypot(x - pondW.x, z - pondW.z) < POND.r + 0.7 + m) return true;
    if (distToPolyline(x, z, streamPts) < 1.45 + m) return true;
    if (Math.hypot(x - EMBER.x, z - EMBER.z) < 4.6 + m) return true;
    if (Math.hypot(x - workBench.x, z - workBench.z) < 1.4 + m) return true;
    for (const b of Object.values(BENCHES)) if (Math.hypot(x - b.x, z - b.z) < 1.3 + m) return true;
    if (Math.abs(x - GATE.x) < 1.2 + m && Math.abs(z - GATE.z) < 3.5) return true;
    if (paths) for (const p of PATHS) if (distToPolyline(x, z, p) < pathM + m) return true;
    return false;
  }

  /* ------------------------------ Дома ------------------------------ */
  function house(h, i) {
    const x = CX + h.dx, z = CZ + h.dz, y0 = gy(x, z) - 0.12, R = h.R;
    const H = h.tower ? h.H + 2.2 : h.H;
    const door = houseDoor(h);
    // Стены: белый камень, расширяются к низу; цоколь-ступень.
    put(B.white, lathe([[R * 1.16, 0], [R * 1.1, 0.28], [R * 1.0, 0.62], [R * 0.965, H * 0.55], [R * 0.99, H]], 28), 0xffffff, x, y0, z);
    put(B.white, lathe([[R * 1.28, -0.3], [R * 1.3, 0.12], [R * 1.22, 0.2], [0.0005, 0.2]], 28), 0xe8e2d6, x, y0, z);
    put(B.gold, new THREE.TorusGeometry(R * 1.0, 0.07, 6, 40).rotateX(Math.PI / 2), null, x, y0 + H - 0.02, z);
    put(B.gold, new THREE.TorusGeometry(R * 1.12, 0.045, 6, 40).rotateX(Math.PI / 2), null, x, y0 + 0.3, z);
    // Деревянные рёбра по стене — изогнуты наружу, как стебли.
    for (let k = 0; k < 7; k++) {
      const a = door.a + Math.PI / 7 + (k / 7) * TAU;
      const pts = [];
      for (let s = 0; s <= 4; s++) {
        const t = s / 4, yy = t * H, rr = (t < 0.1 ? R * 1.1 : R * (0.965 + 0.02 * Math.sin(t * Math.PI))) + 0.06 + 0.16 * Math.sin(t * Math.PI);
        pts.push(V3(x + Math.sin(a + t * 0.25) * rr, y0 + yy, z + Math.cos(a + t * 0.25) * rr));
      }
      put(B.wood, tube(pts, 0.1, 0.07, 10, 5), 0x9b6b3f);
    }
    // Балкон башни: настил, перила-кольцо, столбики.
    if (h.tower) {
      const by = y0 + h.H - 0.2;
      put(B.wood, lathe([[R * 0.98, -0.16], [R * 1.5, -0.16], [R * 1.56, 0], [R * 1.5, 0.06], [R * 0.98, 0.06]], 32), 0xa77544, x, by, z);
      put(B.gold, new THREE.TorusGeometry(R * 1.5, 0.045, 6, 44).rotateX(Math.PI / 2), null, x, by + 0.95, z);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU;
        put(B.wood, new THREE.CylinderGeometry(0.035, 0.045, 0.95, 5), 0x8a5a32, x + Math.sin(a) * R * 1.5, by + 0.5, z + Math.cos(a) * R * 1.5);
      }
      // изогнутые кронштейны под балконом
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU + 0.3;
        put(B.wood, tube([[x + Math.sin(a) * R * 0.98, by - 1.1, z + Math.cos(a) * R * 0.98], [x + Math.sin(a) * R * 1.12, by - 0.5, z + Math.cos(a) * R * 1.12], [x + Math.sin(a) * R * 1.45, by - 0.18, z + Math.cos(a) * R * 1.45]], 0.07, 0.05, 6, 4), 0x8a5a32);
      }
      // окна второго яруса
      for (let k = 0; k < 4; k++) {
        const a = door.a + (k + 0.5) * (TAU / 4);
        const g = leafArch(0.5, 1.0); g.rotateY(a);
        put(B.glow, g, [3.0, 1.9, 0.75], x + Math.sin(a) * (R * 0.99 + 0.04), by + 0.45, z + Math.cos(a) * (R * 0.99 + 0.04));
      }
    }
    // Крыша: вогнутый купол-бутон, закрученный по спирали, край — лепестки.
    {
      const Hr = R * 2.3;
      const prof = [[R * 1.42, -0.42], [R * 1.34, -0.12], [R * 1.18, 0.22], [R * 0.95, Hr * 0.2], [R * 0.66, Hr * 0.4], [R * 0.4, Hr * 0.6], [R * 0.2, Hr * 0.78], [R * 0.08, Hr * 0.92], [0.02, Hr]];
      const g = new THREE.LatheGeometry(new THREE.SplineCurve(prof.map(([r, yy]) => new THREE.Vector2(r, yy))).getPoints(22), 48);
      const p = g.attributes.position, petals = 8, twist = 0.55 + (i % 3) * 0.15;
      const cd = i * 2.1 + 0.6, curl = R * 0.5, droop = R * 0.3;   // кончик крыши загибается, как у листа
      for (let k = 0; k < p.count; k++) {
        const px = p.getX(k), py = p.getY(k), pz = p.getZ(k);
        const t = clamp((py + 0.42) / (Hr + 0.42), 0, 1);
        const r = Math.hypot(px, pz), a0 = Math.atan2(px, pz);
        const lobe = 0.5 + 0.5 * Math.cos(petals * a0);
        const bottom = Math.pow(1 - t, 3);
        const rr = r * (1 + 0.16 * (lobe - 0.4) * bottom);
        const a = a0 + twist * t * t;
        const c3 = t * t * t;
        p.setXYZ(k, Math.sin(a) * rr + Math.sin(cd) * curl * c3, py - 0.42 * lobe * Math.pow(1 - t, 6) - droop * c3 * t, Math.cos(a) * rr + Math.cos(cd) * curl * c3);
      }
      g.computeVertexNormals();
      put(B.roof, g, h.roof, x, y0 + H, z);
      put(B.gold, new THREE.TorusGeometry(R * 1.2, 0.05, 6, 48).rotateX(Math.PI / 2), null, x, y0 + H + 0.2, z);
      // шпиль у загнутого кончика: золото + кристалл
      const tx = x + Math.sin(cd) * curl, tz = z + Math.cos(cd) * curl, ty = y0 + H + Hr - droop;
      put(B.gold, lathe([[0.12, 0], [0.09, 0.2], [0.04, 0.5], [0.0005, 0.8]], 8), null, tx, ty - 0.12, tz);
      put(B.crystal, new THREE.OctahedronGeometry(0.2, 0).scale(1, 1.8, 1), [0.55, 1.0, 1.0], tx, ty + 1.0, tz);
    }
    // Дверь (стрельчатая), золотая рама, ступени.
    {
      const a = door.a, rw = R * 1.02 + 0.05;
      const dx = x + Math.sin(a) * rw, dz = z + Math.cos(a) * rw;
      const g = leafArch(1.1, 2.25, 1.35); g.rotateY(a);
      put(B.wood, g, 0x6e4526, dx, y0 + 0.2, dz);
      const fr = tube([[-0.62, 0, 0], [-0.62, 1.4, 0], [-0.4, 2.1, 0], [0, 2.42, 0], [0.4, 2.1, 0], [0.62, 1.4, 0], [0.62, 0, 0]], 0.06, 0.06, 20, 5);
      fr.rotateY(a);
      put(B.gold, fr, null, dx + Math.sin(a) * 0.03, y0 + 0.2, dz + Math.cos(a) * 0.03);
      // тёплый свет над дверью (вставка-фрамуга)
      const tr = leafArch(0.42, 0.42, 0.1); tr.rotateY(a);
      put(B.glow, tr, [3.2, 2.1, 0.9], dx + Math.sin(a) * 0.02, y0 + 1.65, dz + Math.cos(a) * 0.02);
      for (let s = 0; s < 2; s++) {
        const st = new THREE.CylinderGeometry(1.0 - s * 0.22, 1.05 - s * 0.22, 0.14, 16, 1, false, a - Math.PI / 2, Math.PI);
        put(B.white, st, 0xece6da, dx, y0 + 0.07 + s * 0.14 + 0.05, dz);
      }
    }
    // Окна первого яруса.
    for (let k = 0; k < 3; k++) {
      const a = door.a + (k + 1) * (TAU / 4) + (k === 1 ? 0.25 : 0);
      const g = leafArch(0.62, 1.25); g.rotateY(a);
      put(B.glow, g, [3.1, 1.95, 0.8], x + Math.sin(a) * (R * 0.975 + 0.05), y0 + 1.05, z + Math.cos(a) * (R * 0.975 + 0.05));
      const fr = tube([[-0.36, 0, 0], [-0.36, 0.7, 0], [0, 1.33, 0], [0.36, 0.7, 0], [0.36, 0, 0]], 0.035, 0.035, 12, 4);
      fr.rotateY(a);
      put(B.gold, fr, null, x + Math.sin(a) * (R * 0.975 + 0.08), y0 + 1.02, z + Math.cos(a) * (R * 0.975 + 0.08));
    }
    circle(x, z, R * 1.16 + 0.15);
  }
  HOUSES.forEach(house);

  /* ------------------------------ Великое Древо ------------------------------ */
  const canopy = [];   // кластеры кроны {x,y,z,rx,ry}
  {
    const x = CX, z = CZ, y0 = baseY - 0.4;
    // Ствол: витой, с продольными желобами и лопастями корней у земли.
    const prof = [[3.9, -0.4], [3.3, 0.2], [2.7, 0.8], [2.3, 1.8], [2.05, 3.5], [1.9, 6], [1.8, 8.5], [1.75, 10.5], [1.95, 12.2], [2.4, 13.4]];
    const g = new THREE.LatheGeometry(new THREE.SplineCurve(prof.map(([r, yy]) => new THREE.Vector2(r, yy))).getPoints(30), 40);
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const px = p.getX(k), py = p.getY(k), pz = p.getZ(k);
      const r = Math.hypot(px, pz), a0 = Math.atan2(px, pz), a = a0 + py * 0.075;
      const flute = 1 + 0.07 * Math.cos(9 * a) * smoothstep(0.5, 2.5, py);
      const lobes = 1 + 0.38 * Math.pow(Math.max(0, Math.cos(5 * a0 + 0.4)), 3) * (1 - smoothstep(0, 2.8, py));
      p.setXYZ(k, Math.sin(a) * r * flute * lobes, py, Math.cos(a) * r * flute * lobes);
    }
    g.computeVertexNormals();
    // UV: по окружности и высоте, чтобы кора шла волокнами вверх
    const uvA = g.attributes.uv;
    for (let k = 0; k < p.count; k++) uvA.setXY(k, (Math.atan2(p.getX(k), p.getZ(k)) / TAU + 0.5) * 6, p.getY(k) / 3);
    put(B.bark, g, 0xffffff, x, y0, z);
    // Корни: семь лап от ствола к земле.
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + 0.4 + (rnd() - 0.5) * 0.3;
      if (Math.abs(wrapAngle(a - Math.PI * 0.27)) < 0.3) continue;         // не под скамьёй
      const r1 = 5.6 + rnd() * 1.4, sw = (rnd() - 0.5) * 0.5;
      const pts = [[x + Math.sin(a) * 2.2, y0 + 1.7, z + Math.cos(a) * 2.2], [x + Math.sin(a + sw * 0.3) * 3.6, y0 + 0.75, z + Math.cos(a + sw * 0.3) * 3.6],
        [x + Math.sin(a + sw * 0.7) * (r1 - 1.2), y0 + 0.35, z + Math.cos(a + sw * 0.7) * (r1 - 1.2)], [x + Math.sin(a + sw) * r1, y0 + 0.28, z + Math.cos(a + sw) * r1]];
      put(B.bark, tube(pts, 0.75, 0.1, 14, 7), [0.93, 0.95, 0.92]);
    }
    // Ветви к кластерам кроны.
    canopy.push({ x, y: y0 + 21.5, z, rx: 7.8, ry: 4.4 });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26, R = 7.8 + (k % 2) * 1.2;
      canopy.push({ x: x + Math.sin(a) * R, y: y0 + 16.4 + (k % 2) * 1.8 + rnd() * 0.6, z: z + Math.cos(a) * R, rx: 5.4 + rnd() * 0.8, ry: 3.3 });
    }
    canopy.forEach((c, k) => {
      if (k === 0) { put(B.bark, tube([[x, y0 + 12.5, z], [x + 0.4, y0 + 15.5, z - 0.3], [c.x, c.y - 2.5, c.z]], 1.1, 0.35, 10, 7), 0xffffff); return; }
      const a = Math.atan2(c.x - x, c.z - z);
      const pts = [[x + Math.sin(a) * 1.2, y0 + 11.6 + (k % 3) * 0.5, z + Math.cos(a) * 1.2], [x + Math.sin(a) * 3.8, y0 + 13.8, z + Math.cos(a) * 3.8],
        [c.x - Math.sin(a) * 1.5, c.y - 1.4, c.z - Math.cos(a) * 1.5], [c.x + Math.sin(a) * 1.0, c.y - 0.2, c.z + Math.cos(a) * 1.0]];
      put(B.bark, tube(pts, 0.78, 0.16, 14, 7), 0xffffff);
      // тонкие боковые веточки
      for (let s = 0; s < 2; s++) {
        const b = a + (s ? 0.7 : -0.7);
        put(B.bark, tube([[c.x - Math.sin(a) * 1.2, c.y - 1.1, c.z - Math.cos(a) * 1.2], [c.x + Math.sin(b) * 2.2, c.y + 0.1, c.z + Math.cos(b) * 2.2], [c.x + Math.sin(b) * 3.8, c.y + 0.8, c.z + Math.cos(b) * 3.8]], 0.26, 0.05, 8, 5), 0xffffff);
      }
    });
    // Площадка дома-на-дереве: кольцевой настил, золотой обод, перила, подпорки.
    const py = baseY + PLATFORM_Y;
    put(B.wood, lathe([[PLATFORM_R0, -0.2], [PLATFORM_R1, -0.2], [PLATFORM_R1 + 0.12, -0.05], [PLATFORM_R1, 0.08], [PLATFORM_R0, 0.08]], 44), 0xb07a46, x, py, z);
    put(B.gold, new THREE.TorusGeometry(PLATFORM_R1 + 0.1, 0.06, 6, 56).rotateX(Math.PI / 2), null, x, py - 0.06, z);
    put(B.gold, new THREE.TorusGeometry(PLATFORM_R1 - 0.12, 0.045, 6, 56, TAU - 0.9).rotateX(Math.PI / 2).rotateY(-Math.PI * 0.5 + 0.45), null, x, py + 1.02, z);
    for (let k = 0; k < 28; k++) {
      const a = (k / 28) * TAU;
      if (Math.abs(wrapAngle(a - Math.PI * 0.5)) < 0.42) continue;          // проход к лестнице (восток)
      put(B.wood, new THREE.CylinderGeometry(0.035, 0.045, 1.0, 5), 0x8a5a32, x + Math.sin(a) * (PLATFORM_R1 - 0.12), py + 0.55, z + Math.cos(a) * (PLATFORM_R1 - 0.12));
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + 0.2;
      put(B.wood, tube([[x + Math.sin(a) * 1.9, py - 3.2, z + Math.cos(a) * 1.9], [x + Math.sin(a) * 2.8, py - 1.4, z + Math.cos(a) * 2.8], [x + Math.sin(a) * 4.6, py - 0.22, z + Math.cos(a) * 4.6]], 0.13, 0.08, 8, 5), 0x8a5a32);
    }
    // Домик на площадке (к северу): малая башенка с крышей-бутоном.
    {
      const hx = x, hz = z + 3.5, R = 1.3, H = 2.3, y1 = py + 0.08;
      put(B.white, lathe([[R * 1.08, 0], [R, 0.3], [R * 0.97, H * 0.6], [R, H]], 20), 0xffffff, hx, y1, hz);
      put(B.gold, new THREE.TorusGeometry(R, 0.05, 6, 28).rotateX(Math.PI / 2), null, hx, y1 + H, hz);
      const Hr = R * 2.4;
      const rg = new THREE.LatheGeometry(new THREE.SplineCurve([[R * 1.45, -0.3], [R * 1.2, 0.15], [R * 0.7, Hr * 0.35], [R * 0.3, Hr * 0.7], [0.02, Hr]].map(([r, yy]) => new THREE.Vector2(r, yy))).getPoints(14), 32);
      const rp = rg.attributes.position;
      for (let k = 0; k < rp.count; k++) {
        const px2 = rp.getX(k), py2 = rp.getY(k), pz2 = rp.getZ(k), t = clamp((py2 + 0.3) / (Hr + 0.3), 0, 1);
        const a = Math.atan2(px2, pz2) + 0.8 * t * t, r = Math.hypot(px2, pz2) * (1 + 0.1 * Math.cos(6 * Math.atan2(px2, pz2)) * Math.pow(1 - t, 3));
        rp.setXYZ(k, Math.sin(a) * r, py2, Math.cos(a) * r);
      }
      rg.computeVertexNormals();
      put(B.roof, rg, 0x7fd08a, hx, y1 + H, hz);
      put(B.crystal, new THREE.OctahedronGeometry(0.16, 0).scale(1, 1.8, 1), [1.0, 0.85, 0.45], hx, y1 + H + Hr + 0.5, hz);
      for (let k = 0; k < 3; k++) {
        const a = Math.PI + (k - 1) * 1.1;
        const wg = leafArch(0.42, 0.9); wg.rotateY(a);
        put(B.glow, wg, [3.1, 2.0, 0.8], hx + Math.sin(a) * (R * 0.97 + 0.04), y1 + 0.8, hz + Math.cos(a) * (R * 0.97 + 0.04));
      }
    }
    // Винтовая лестница вокруг ствола: от земли (юго-восток) до площадки (восток).
    const steps = 30;
    for (let k = 0; k < steps; k++) {
      const t = k / (steps - 1), a = Math.PI * 0.5 - 0.35 - (1 - t) * TAU * 1.12;
      const sy = baseY + 0.35 + t * (PLATFORM_Y - 0.4);
      const trunkR = sy - baseY < 2.5 ? 2.6 : 2.05;
      const st = new THREE.BoxGeometry(1.25, 0.09, 0.46);
      st.translate(trunkR + 0.55, 0, 0); st.rotateY(a - Math.PI / 2);
      put(B.wood, st, 0xa06d3d, x, sy, z);
      if (k % 3 === 0) put(B.gold, new THREE.CylinderGeometry(0.025, 0.025, 0.9, 4), null, x + Math.sin(a) * (trunkR + 1.12), sy + 0.45, z + Math.cos(a) * (trunkR + 1.12));
    }
    circle(x, z, TRUNK_R);
  }

  /* ------------------------------ Врата и арка ------------------------------ */
  function arch(gx, gz, halfW, pillarH, topH, runes, vineSeed) {
    const yg = gy(gx, gz) - 0.1;
    for (const s of [-1, 1]) {
      const px = gx, pz = gz + s * halfW;
      put(B.white, lathe([[0.56, 0], [0.5, 0.26], [0.36, 0.46], [0.3, pillarH * 0.5], [0.27, pillarH * 0.9], [0.37, pillarH * 0.95], [0.45, pillarH], [0.2, pillarH + 0.2], [0.0005, pillarH + 0.25]], 16), 0xffffff, px, yg, pz);
      put(B.gold, new THREE.TorusGeometry(0.44, 0.05, 6, 20).rotateX(Math.PI / 2), null, px, yg + 0.5, pz);
      put(B.gold, new THREE.TorusGeometry(0.33, 0.045, 6, 20).rotateX(Math.PI / 2), null, px, yg + pillarH * 0.92, pz);
      circle(px, pz, 0.55);
      if (runes) {
        for (const f of [-1, 1]) {                                   // лента рун на лицевой и тыльной стороне
          const pts = [], sides = [];
          for (let k = 0; k <= 8; k++) { pts.push(V3(px + f * 0.33, yg + 0.9 + (k / 8) * (pillarH * 0.7), pz)); sides.push(V3(0, 0, 0.13)); }
          const rg = ribbon(pts, sides, 1 / 0.5);
          // руны читаются сверху вниз: u вдоль высоты
          const m = new THREE.Mesh(G(rg), matRunes);
          m.renderOrder = 3;
          root.add(m);
        }
      }
    }
    // Арка: стрельчатая белая дуга, внутри золотой прут, по ней лоза с огоньками.
    const ay = yg + pillarH;
    const curvePts = [V3(gx, ay, gz - halfW), V3(gx, ay + (topH - pillarH) * 0.55, gz - halfW * 0.9), V3(gx, ay + (topH - pillarH) * 0.9, gz - halfW * 0.5),
      V3(gx, yg + topH, gz), V3(gx, ay + (topH - pillarH) * 0.9, gz + halfW * 0.5), V3(gx, ay + (topH - pillarH) * 0.55, gz + halfW * 0.9), V3(gx, ay, gz + halfW)];
    put(B.white, tube(curvePts, 0.24, 0.24, 36, 8), 0xffffff);
    put(B.gold, tube(curvePts.map((p) => p.clone().setY(p.y - 0.3)), 0.07, 0.07, 36, 5), null);
    const curve = new THREE.CatmullRomCurve3(curvePts);
    if (runes) {
      const pts = [], sides = [];
      for (let k = 0; k <= 40; k++) {
        const t = 0.06 + (k / 40) * 0.88, p = curve.getPointAt(t), tg = curve.getTangentAt(t);
        pts.push(V3(p.x - 0.25, p.y, p.z)); sides.push(V3(0, -tg.z, tg.y).multiplyScalar(0.12));
      }
      const m = new THREE.Mesh(G(ribbon(pts, sides, 1 / 0.5)), matRunes);
      m.renderOrder = 3;
      root.add(m);
      // навершие: золотой лист и кристалл
      put(B.gold, new THREE.OctahedronGeometry(0.34, 0).scale(0.35, 1.3, 1), null, gx, yg + topH + 0.55, gz);
      put(B.crystal, new THREE.OctahedronGeometry(0.2, 0).scale(1, 1.7, 1), [1.0, 0.86, 0.45], gx, yg + topH + 1.25, gz);
    }
    const vr = mulberry32(vineSeed), vine = [], c = V3(0, 0, 0), tg = V3(0, 0, 0), nrm = V3(0, 0, 0), bin = V3(0, 0, 0);
    const turns = 7 + vr() * 3;
    for (let k = 0; k <= 120; k++) {
      const t = k / 120;
      curve.getPointAt(t, c); curve.getTangentAt(t, tg);
      nrm.set(1, 0, 0); bin.crossVectors(tg, nrm).normalize();
      const ph = t * turns * TAU, rr = 0.3;
      vine.push(V3(c.x + Math.cos(ph) * rr, c.y + bin.y * Math.sin(ph) * rr, c.z + bin.z * Math.sin(ph) * rr));
    }
    put(B.vine, tube(vine, 0.04, 0.03, 160, 4), null);
    for (let k = 0; k < 18; k++) {
      const p = vine[(4 + k * 6.3) | 0];
      const hdr = k % 3 === 0 ? [2.8, 1.2, 2.0] : k % 3 === 1 ? [0.8, 2.6, 2.3] : [2.9, 2.2, 0.9];
      put(B.glow, new THREE.IcosahedronGeometry(0.075, 0), hdr, p.x, p.y, p.z);
    }
  }
  arch(GATE.x, GATE.z, 2.85, 5.2, 8.3, true, seed + 11);
  arch(CX - 21, CZ, 2.15, 3.5, 5.7, false, seed + 12);

  /* ------------------------------ Ручей, пруд, мостик ------------------------------ */
  {
    // уровень пруда — чуть выше самой высокой точки земли под ним
    const pondY = (() => { let m = -1e9; for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; for (const f of [0, 0.5, 1]) m = Math.max(m, gy(pondW.x + Math.sin(a) * POND.r * f, pondW.z + Math.cos(a) * POND.r * f)); } return m + 0.06; })();
    // ручей
    const pts = [], sides = [];
    for (let i = 0; i <= STREAM_N; i++) {
      const p = streamPts[i], t = i / STREAM_N;
      const q = streamPts[Math.min(STREAM_N, i + 1)], r0 = streamPts[Math.max(0, i - 1)];
      const tx = q.x - r0.x, tz = q.z - r0.z, tl = Math.hypot(tx, tz) || 1;
      const w = streamW(t) / 2;
      // устье в пруду — чуть ниже его глади (пруд перекрывает стык)
      const inPond = Math.hypot(p.x - pondW.x, p.z - pondW.z) < POND.r - 0.3;
      const y = inPond ? pondY - 0.02 : Math.max(gy(p.x, p.z) + 0.07, i > STREAM_N * 0.8 ? pondY + 0.01 : -1e9);
      pts.push(V3(p.x, y, p.z)); sides.push(V3(tz / tl * w, 0, -tx / tl * w));
    }
    const sg = ribbon(pts, sides, 1 / 2.5);
    if (sg.attributes.normal.getY(0) < 0) {                    // лицом вверх (иначе грань отсекается)
      const ix = sg.index.array;
      for (let k = 0; k < ix.length; k += 3) { const tmp = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = tmp; }
      sg.index.needsUpdate = true;
      sg.computeVertexNormals();
    }
    const stream = new THREE.Mesh(G(sg), matStream);
    stream.receiveShadow = true;
    stream.name = 'elf-stream';
    root.add(stream);
    // пруд
    const pg = new THREE.CircleGeometry(POND.r, 48); pg.rotateX(-Math.PI / 2);
    const uvA = pg.attributes.uv; for (let k = 0; k < uvA.count; k++) uvA.setXY(k, uvA.getX(k) * 2.2, uvA.getY(k) * 2.2);
    const pond = new THREE.Mesh(G(pg), matWater);
    pond.position.set(pondW.x, pondY, pondW.z);
    pond.receiveShadow = true;
    pond.name = 'elf-pond';
    root.add(pond);
    circle(pondW.x, pondW.z, POND.r + 0.35);
    state.pondY = pondY;
  }
  // Мостик: горбатый настил, белые опоры-устои, золотые перила на столбиках.
  {
    const N = 18, pts = [], sides = [];
    for (let k = 0; k <= N; k++) {
      const u = k / N;
      pts.push(V3(bridge.A.x + bridge.ux * bridge.half * 2 * u, bridgeDeckY(u), bridge.A.z + bridge.uz * bridge.half * 2 * u));
      sides.push(V3(-bridge.uz * bridge.w, 0, bridge.ux * bridge.w));
    }
    const top = ribbon(pts, sides, 1 / 1.2);
    put(B.wood, top, 0xc08a52);
    const bot = ribbon(pts.map((p) => p.clone().setY(p.y - 0.16)), sides.map((s) => s.clone().negate()), 1 / 1.2);
    put(B.wood, bot, 0x8a5a32);
    for (const sgn of [-1, 1]) {
      const edge = pts.map((p) => V3(p.x + sgn * -bridge.uz * bridge.w, p.y, p.z + sgn * bridge.ux * bridge.w));
      const side = ribbon(edge.map((p) => p.clone().setY(p.y - 0.08)), edge.map(() => V3(0, 0.08, 0)), 1 / 1.2);
      put(B.gold, side, null);
      const rail = edge.map((p) => V3(p.x, p.y + 0.9, p.z));
      put(B.gold, tube(rail, 0.045, 0.045, 24, 5), null);
      for (let k = 0; k <= N; k += 3) put(B.white, new THREE.CylinderGeometry(0.05, 0.06, 0.9, 6), 0xffffff, edge[k].x, edge[k].y + 0.45, edge[k].z);
      segment(edge[0].x, edge[0].z, edge[N].x, edge[N].z, 0.14);
    }
    for (const [p, y] of [[bridge.A, bridge.yA], [bridge.B, bridge.yB]]) {
      const ab = new THREE.BoxGeometry(1.0, 0.5, bridge.w * 2 + 0.5);
      ab.rotateY(Math.atan2(bridge.ux, bridge.uz));
      put(B.white, ab, 0xe6e0d4, p.x - bridge.ux * 0.2 * (p === bridge.A ? 1 : -1), y - 0.12, p.z - bridge.uz * 0.2 * (p === bridge.A ? 1 : -1));
    }
  }
  // Родник: скала с кристаллами в истоке ручья.
  {
    const s = streamPts[0], y = gy(s.x, s.z);
    const back = V3(s.x - streamPts[3].x, 0, s.z - streamPts[3].z).normalize();
    const cx = s.x + back.x * 0.9, cz = s.z + back.z * 0.9;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU, r = 0.7 + rnd() * 0.5;
      const rg = new THREE.IcosahedronGeometry(0.7 + rnd() * 0.5, 0); rg.scale(1, 0.75, 1);
      put(B.white, rg, 0xd8d6cf, cx + Math.sin(a) * r, y + 0.25, cz + Math.cos(a) * r);
    }
    for (let k = 0; k < 6; k++) {
      const cg = new THREE.OctahedronGeometry(0.22 + rnd() * 0.18, 0); cg.scale(1, 2.6 + rnd(), 1);
      cg.rotateZ((rnd() - 0.5) * 0.7); cg.rotateX((rnd() - 0.5) * 0.7);
      put(B.crystal, cg, k % 2 ? [0.5, 1.0, 1.0] : [0.75, 0.95, 1.0], cx + (rnd() - 0.5) * 1.2, y + 0.9 + rnd() * 0.4, cz + (rnd() - 0.5) * 1.2);
    }
    circle(cx, cz, 1.5);
    state.spring = { x: cx, y: y + 1.2, z: cz };
  }

  /* ------------------------------ Скамьи, мастерская ------------------------------ */
  function bench(b) {
    const y = gy(b.x, b.z), ca = Math.cos(b.yaw), sa = Math.sin(b.yaw);
    // сиденье чуть позади точки сидящего (бёдра в позе SitIdle — над пяткой, ноги вперёд)
    const bx = b.x - sa * 0.1, bz = b.z - ca * 0.1;
    const seat = new THREE.BoxGeometry(1.7, 0.1, 0.5); seat.rotateY(b.yaw);
    put(B.wood, seat, 0xb88450, bx, y + 0.44, bz);
    for (const s of [-0.65, 0.65]) {
      const leg = lathe([[0.2, 0], [0.13, 0.1], [0.1, 0.28], [0.16, 0.39], [0.0005, 0.39]], 10);
      put(B.white, leg, 0xffffff, bx + ca * s, y, bz - sa * s);
    }
    circle(bx, bz, 0.8);
  }
  bench(BENCHES.pond); bench(BENCHES.tree);
  {
    const y = gy(workBench.x, workBench.z);
    const log = new THREE.CylinderGeometry(0.34, 0.38, 1.3, 12); log.rotateZ(Math.PI / 2);
    put(B.wood, log, 0x8a5a32, workBench.x, y + 0.3, workBench.z);
    const cg = new THREE.OctahedronGeometry(0.16, 0); cg.scale(1, 1.9, 1); cg.rotateZ(0.5);
    put(B.crystal, cg, [0.22, 0.42, 0.45], workBench.x + 0.3, y + 0.78, workBench.z);
    circle(workBench.x, workBench.z, 0.75);
  }

  /* ------------------------------ Фонари ------------------------------ */
  const halos = [];   // {x,y,z, size, col:[r,g,b]} — мягкие ореолы (Points)
  const lanterns = [];
  function lantern(x, z, warm) {
    const y = gy(x, z);
    put(B.white, lathe([[0.22, 0], [0.16, 0.12], [0.07, 0.3], [0.055, 1.55], [0.08, 1.62], [0.0005, 1.66]], 8), 0xffffff, x, y, z);
    // золотой полумесяц-держатель
    const hook = new THREE.TorusGeometry(0.2, 0.025, 5, 14, Math.PI * 1.25); hook.rotateZ(-Math.PI * 0.12);
    put(B.gold, hook, null, x, y + 1.85, z, rnd() * TAU);
    const cg = new THREE.OctahedronGeometry(0.14, 0); cg.scale(1, 2.0, 1);
    put(B.crystal, cg, warm ? [1.0, 0.8, 0.42] : [0.5, 1.0, 1.0], x, y + 1.9, z);
    halos.push({ x, y: y + 1.9, z, size: 1.6, col: warm ? [0.3, 0.19, 0.06] : [0.06, 0.25, 0.28] });
    circle(x, z, 0.24);
    lanterns.push({ x, z });
  }
  {
    let warm = false;
    for (const lx of [-26.2, -16.6, -12.2]) for (const s of [-1, 1]) lantern(CX + lx, CZ + s * 2.45, (warm = !warm));
    for (let k = 0; k < 10; k++) {
      let a = (k / 10) * TAU + 0.2;
      let x = CX + Math.sin(a) * (RING_R + 1.9), z = CZ + Math.cos(a) * (RING_R + 1.9);
      for (let tr = 0; tr < 6 && blocked(x, z, 0.2, { pathM: 1.3 }); tr++) { a += 0.09; x = CX + Math.sin(a) * (RING_R + 1.9); z = CZ + Math.cos(a) * (RING_R + 1.9); }
      if (!blocked(x, z, 0.2, { pathM: 1.3 })) lantern(x, z, k % 2 === 0);
    }
    for (let k = 0; k < 3; k++) {
      const a = Math.PI * 0.95 + k * 1.3;
      const x = pondW.x + Math.sin(a) * (POND.r + 1.6), z = pondW.z + Math.cos(a) * (POND.r + 1.6);
      if (!blocked(x, z, -0.9, { pathM: 1.2 }) || k === 0) lantern(x, z, false);
    }
    for (const [p, sgn] of [[bridge.A, -1], [bridge.B, 1]]) {
      const x = p.x + bridge.ux * 0.4 * sgn - bridge.uz * 1.35, z = p.z + bridge.uz * 0.4 * sgn + bridge.ux * 1.35;
      lantern(x, z, true);
    }
    HOUSES.forEach((h) => {
      const d = houseDoor(h), a = d.a + 0.9;
      const x = CX + h.dx + Math.sin(a) * (h.R * 1.16 + 0.9), z = CZ + h.dz + Math.cos(a) * (h.R * 1.16 + 0.9);
      lantern(x, z, true);
    });
  }

  /* ------------------------------ Луг поверх земли ------------------------------ */
  // Поляна деревни ровная (world.terrainH), поэтому сетка по той же высоте +3.5 см ложится без
  // зазоров; край растворяется (альфа вершин). Трещины и лужи пепельного камня под ней не видны.
  {
    const texMeadow = tex(paintMeadow(256, seed + 8));
    const Rm = MEADOW_R, N = 46, step = (2 * Rm) / N, pos = [], col = [], uv = [], idx = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const x = CX - Rm + i * step, z = CZ - Rm + j * step, d = Math.hypot(x - CX, z - CZ);
      pos.push(x, gy(x, z) + MEADOW_LIFT, z);   // [W5-ПОЛ]
      uv.push(x / 7, z / 7);
      col.push(1, 1, 1, 1 - smoothstep(Rm - 8, Rm - 0.5, d));
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, e = c + 1;
      if (col[a * 4 + 3] + col[b * 4 + 3] + col[c * 4 + 3] + col[e * 4 + 3] <= 0) continue;
      idx.push(a, c, b, b, c, e);
    }
    const g = G(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    // без polygonOffset: +3.5 см над землёй хватает, а вода (+6–7 см) должна перекрывать луг
    const matMeadow = std({ color: 0xffffff, map: texMeadow, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0,
      emissive: 0x0e1c0a, emissiveIntensity: 1 });
    const meadow = new THREE.Mesh(g, matMeadow);
    meadow.name = 'elf-meadow';
    meadow.receiveShadow = true;
    meadow.renderOrder = 1;
    root.add(meadow);
  }

  /* ------------------------------ Слить статичную геометрию ------------------------------ */
  function flush(list, mat, name, { cast = true, receive = true } = {}) {
    if (!list.length) return null;
    const m = new THREE.Mesh(merge(list), mat);
    m.name = name; m.castShadow = cast; m.receiveShadow = receive;
    root.add(m);
    return m;
  }
  flush(B.white, matWhite, 'elf-stone');
  flush(B.wood, matWood, 'elf-wood');
  flush(B.roof, matRoof, 'elf-roofs');
  flush(B.gold, matGold, 'elf-gold');
  flush(B.bark, matBark, 'elf-great-tree');
  flush(B.vine, matVine, 'elf-vines', { cast: false });
  flush(B.crystal, matCrystal, 'elf-crystals', { cast: false });
  flush(B.glow, matGlow, 'elf-glow', { cast: false, receive: false });

  /* ------------------------------ Экземпляры ------------------------------ */
  const tiers = [];   // {mesh, key}
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function instanced(geo, mat, items, { name, cast = false, receive = true, key = null } = {}) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(G(geo), mat, items.length);
    items.forEach((it, i) => {
      _e.set(it.rx || 0, it.ry || 0, it.rz || 0, 'YXZ');
      _q.setFromEuler(_e);
      _p.set(it.x, it.y, it.z); _s.set(it.sx, it.sy ?? it.sx, it.sz ?? it.sx);
      mesh.setMatrixAt(i, _m4.compose(_p, _q, _s));
      if (it.c) mesh.setColorAt(i, _c.setRGB(it.c[0], it.c[1], it.c[2]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = cast; mesh.receiveShadow = receive;
    mesh.name = name;
    mesh.computeBoundingSphere();
    root.add(mesh);
    if (key) tiers.push({ mesh, key, max: items.length });
    return mesh;
  }
  // Листва кроны: карточки-листья с изгибом по жилке, светятся золотом (эмиссия по цвету экземпляра).
  {
    const lg = new THREE.PlaneGeometry(0.42, 0.78, 2, 1);
    const lp = lg.attributes.position; for (let k = 0; k < lp.count; k++) if (Math.abs(lp.getX(k)) < 1e-4) lp.setZ(k, 0.06);
    lg.computeVertexNormals();
    const PAL = [[1.0, 0.72, 0.22], [0.96, 0.82, 0.3], [0.76, 0.88, 0.3], [1.0, 0.6, 0.17], [0.92, 0.76, 0.26]];
    const vol = canopy.map((c) => c.rx * c.rx * c.ry), vsum = vol.reduce((a, b) => a + b, 0);
    const items = [];
    const N = QV.high.leaves;
    canopy.forEach((c, ci) => {
      const n = Math.round((N * vol[ci]) / vsum);
      for (let k = 0; k < n; k++) {
        let dx, dy, dz, l;
        do { dx = rnd() * 2 - 1; dy = rnd() * 2 - 1; dz = rnd() * 2 - 1; l = dx * dx + dy * dy + dz * dz; } while (l > 1 || l < 0.02);
        l = Math.sqrt(l);
        const f = 0.55 + 0.45 * Math.pow(rnd(), 0.4);
        const sparkle = rnd() < 0.04;
        const col = sparkle ? [1.0, 0.97, 0.82] : PAL[(rnd() * PAL.length) | 0];
        const s = 0.8 + rnd() * 0.5;
        items.push({ x: c.x + (dx / l) * c.rx * f, y: c.y + (dy / l) * c.ry * f, z: c.z + (dz / l) * c.rx * f,
          rx: (rnd() - 0.5) * 2.4, ry: rnd() * TAU, rz: (rnd() - 0.5) * 2.4, sx: s, c: sparkle ? col.map((v) => v * 1.45) : col });
      }
    });
    instanced(lg, matLeaves, shuffle(items), { name: 'elf-canopy', key: 'leaves' });
    for (const c of canopy) halos.push({ x: c.x, y: c.y - c.ry * 0.2, z: c.z, size: c.rx * 2.0, col: [0.12, 0.075, 0.016] });
  }
  // Светящиеся «ягоды»-огоньки, свисающие из кроны на тонких лозах.
  {
    const items = [];
    for (let k = 0; k < 44; k++) {
      const c = canopy[1 + (k % 6)] || canopy[0];
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * c.rx * 0.75;
      const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r, top = c.y - c.ry * 0.55;
      const len = 1.6 + rnd() * 3.4, bottom = Math.max(top - len, baseY + 3.2);
      put(B.vine, new THREE.CylinderGeometry(0.012, 0.012, top - bottom, 3), null, x, (top + bottom) / 2, z);
      const warm = rnd() < 0.55;
      for (let y = bottom; y < top - 0.3; y += 0.55 + rnd() * 0.3) {
        const s = 0.05 + rnd() * 0.04;
        items.push({ x, y, z, sx: s, c: warm ? [2.8, 1.9, 0.7] : [0.7, 2.5, 2.3] });
      }
      halos.push({ x, y: bottom, z, size: 0.7, col: warm ? [0.35, 0.24, 0.08] : [0.08, 0.32, 0.3] });
    }
    flush(B.vine.splice(0), matVine, 'elf-hanging-vines', { cast: false });
    instanced(new THREE.IcosahedronGeometry(1, 1), matOrb, items, { name: 'elf-hanging-orbs', key: 'orbs' });
  }
  // Тропы: светлые плиты.
  {
    const items = [];
    for (const path of PATHS) {
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i], b = path[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
        const ux = (b.x - a.x) / (L || 1), uz = (b.z - a.z) / (L || 1);
        for (let d = 0; d < L; d += 0.95) {
          for (const side of [-0.55, 0.55]) {
            const x = a.x + ux * d - uz * side + (rnd() - 0.5) * 0.25, z = a.z + uz * d + ux * side + (rnd() - 0.5) * 0.25;
            if (groundAt(x, z) !== null || distToPolyline(x, z, streamPts) < 1.35 || Math.hypot(x - pondW.x, z - pondW.z) < POND.r + 0.5) continue;
            if (Math.hypot(x - CX, z - CZ) < TRUNK_R + 0.3) continue;
            const s = 0.36 + rnd() * 0.14, v = 0.86 + rnd() * 0.14;
            items.push({ x, y: gy(x, z) + 0.035, z, ry: rnd() * TAU, sx: s, sy: 0.1, sz: s * (0.8 + rnd() * 0.35), c: [v, v * 0.985, v * 0.95] });
          }
        }
      }
    }
    instanced(new THREE.CylinderGeometry(1, 1.05, 1, 7), matPath, items, { name: 'elf-path-stones', receive: true });
  }
  // Камни: берега ручья, обод пруда.
  {
    const items = [];
    for (let i = 1; i < STREAM_N - 1; i += 1) {
      const p = streamPts[i], q = streamPts[i + 1], tx = q.x - p.x, tz = q.z - p.z, tl = Math.hypot(tx, tz) || 1;
      const w = streamW(i / STREAM_N) / 2 + 0.2;
      for (const sg of [-1, 1]) {
        if (rnd() < 0.35) continue;
        const x = p.x + (tz / tl) * w * sg, z = p.z - (tx / tl) * w * sg;
        if (Math.hypot(x - bridge.cx, z - bridge.cz) < bridge.half + 0.6) continue;
        if (Math.hypot(x - pondW.x, z - pondW.z) < POND.r + 0.5) continue;
        const s = 0.18 + rnd() * 0.22;
        items.push({ x, y: gy(x, z) + s * 0.25, z, rx: rnd(), ry: rnd() * TAU, sx: s * 1.3, sy: s * 0.7, sz: s, c: [0.95, 0.96, 0.93] });
      }
    }
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * TAU;
      const x = pondW.x + Math.sin(a) * (POND.r + 0.05), z = pondW.z + Math.cos(a) * (POND.r + 0.05);
      if (distToPolyline(x, z, streamPts) < 1.1) continue;            // устье ручья открыто
      const s = 0.3 + rnd() * 0.18;
      items.push({ x, y: state.pondY - 0.05, z, rx: rnd(), ry: rnd() * TAU, sx: s * 1.4, sy: s * 0.8, sz: s, c: [0.97, 0.97, 0.94] });
    }
    instanced(new THREE.IcosahedronGeometry(1, 0), matRock, items, { name: 'elf-stones', cast: true });
  }
  // Кувшинки и светящиеся лотосы.
  {
    const pads = [], lotus = [];
    for (let k = 0; k < 16; k++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * (POND.r - 0.8);
      const x = pondW.x + Math.sin(a) * r, z = pondW.z + Math.cos(a) * r, s = 0.35 + rnd() * 0.3;
      pads.push({ x, y: state.pondY + 0.015, z, ry: rnd() * TAU, sx: s });
      if (rnd() < 0.55) lotus.push({ x: x + 0.05, y: state.pondY + 0.1, z, ry: rnd() * TAU, sx: 0.13 + rnd() * 0.05, c: rnd() < 0.5 ? [2.6, 1.3, 2.0] : [2.4, 2.3, 2.1] });
    }
    const padG = new THREE.CircleGeometry(1, 14, 0.25, TAU - 0.5); padG.rotateX(-Math.PI / 2);
    instanced(padG, matLily, pads, { name: 'elf-lily-pads' });
    const lotusG = new THREE.ConeGeometry(1, 1.1, 7, 1, true); lotusG.translate(0, 0.2, 0); lotusG.rotateX(Math.PI);
    instanced(lotusG, matOrb, lotus, { name: 'elf-lotus' });
    for (const l of lotus) halos.push({ x: l.x, y: l.y + 0.1, z: l.z, size: 0.8, col: [0.3, 0.16, 0.26] });
  }
  // Цветы: клумбы у домов, вдоль главной тропы, у пруда и корней, у врат; трава — везде свободно.
  {
    const PAL = [[1.0, 0.62, 0.82], [1.0, 0.97, 0.9], [1.0, 0.82, 0.38], [0.76, 0.58, 1.0], [0.5, 1.0, 0.9], [1.0, 0.58, 0.48], [0.62, 0.82, 1.0]];
    const beds = [];
    HOUSES.forEach((h) => {
      const d = houseDoor(h);
      for (let k = 0; k < 7; k++) {
        const a = d.a + 0.7 + (k / 7) * (TAU - 1.4);
        beds.push({ x: CX + h.dx + Math.sin(a) * (h.R * 1.4), z: CZ + h.dz + Math.cos(a) * (h.R * 1.4), r: 0.9, n: 26 });
      }
    });
    for (let x = -29; x <= -12; x += 2.2) for (const s of [-1, 1]) beds.push({ x: CX + x, z: CZ + s * 3.7, r: 1.1, n: 24 });
    for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; beds.push({ x: pondW.x + Math.sin(a) * (POND.r + 1.4), z: pondW.z + Math.cos(a) * (POND.r + 1.4), r: 0.9, n: 22 }); }
    for (let k = 0; k < 14; k++) { const a = (k / 14) * TAU; beds.push({ x: CX + Math.sin(a) * 6.8, z: CZ + Math.cos(a) * 6.8, r: 1.2, n: 26 }); }
    for (let k = 0; k < 10; k++) { const t = 0.08 + k * 0.09; const p = streamCurve.getPointAt(Math.min(0.95, t)); beds.push({ x: p.x + (k % 2 ? 1.9 : -1.9), z: p.z, r: 0.8, n: 16 }); }
    for (const s of [-1, 1]) beds.push({ x: GATE.x + 0.4, z: GATE.z + s * 4.2, r: 1.3, n: 40 }, { x: GATE.x - 1.6, z: GATE.z + s * 3.4, r: 1.0, n: 26 });
    const flowers = [];
    for (const b of beds) {
      const pal = PAL[(rnd() * PAL.length) | 0], pal2 = PAL[(rnd() * PAL.length) | 0];
      for (let k = 0; k < b.n; k++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * b.r, x = b.x + Math.sin(a) * r, z = b.z + Math.cos(a) * r;
        if (blocked(x, z, 0, { pathM: 1.0 })) continue;
        const c = rnd() < 0.7 ? pal : pal2, s = 0.32 + rnd() * 0.22, star = rnd() < 0.05;
        flowers.push({ x, y: gy(x, z) - 0.02, z, ry: rnd() * TAU, sx: s, sy: s * (0.8 + rnd() * 0.4), c: star ? c.map((v) => v * 2.6) : c });
      }
    }
    const cross = (w, h) => {
      const a = new THREE.PlaneGeometry(w, h); a.translate(0, h / 2, 0);
      const b = a.clone(); b.rotateY(Math.PI / 2);
      const parts = [a, b];
      for (const p of parts) put([], p, 0xffffff);
      return merge(parts);
    };
    instanced(cross(1, 0.95), matFlower, shuffle(flowers), { name: 'elf-flowers', key: 'flowers' });
    const grass = [];
    for (let k = 0; k < 20000 && grass.length < QV.high.grass; k++) {
      const a = rnd() * TAU, r = Math.sqrt(rnd()) * (V.r + 5), x = CX + Math.sin(a) * r, z = CZ + Math.cos(a) * r;
      if (blocked(x, z, 0, { pathM: 0.95 })) continue;
      const s = 0.5 + rnd() * 0.45, g = 0.75 + rnd() * 0.25;
      grass.push({ x, y: gy(x, z) - 0.03, z, ry: rnd() * TAU, sx: s, sy: s * (0.7 + rnd() * 0.5), c: [0.42 * g, 0.78 * g, 0.36 * g] });
    }
    instanced(cross(0.9, 0.62), matGrass, shuffle(grass), { name: 'elf-grass', key: 'grass' });
  }

  /* ------------------------------ Ореолы и светлячки (Points) ------------------------------ */
  const pointsU = { uTime: { value: 0 }, uScale: { value: 600 }, uMotion: { value: 1 } };
  const pointsMat = M(new THREE.ShaderMaterial({ uniforms: pointsU, vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  let fliesStart = 0;
  const points = (() => {
    const nH = halos.length + 2, nF = QV.high.flies, n = nH + nF;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), anim = new Float32Array(n * 4), size = new Float32Array(n);
    let i = 0;
    const add = (x, y, z, s, c, a0 = 0, a1 = 0, a2 = 0, a3 = 0) => {
      pos.set([x, y, z], i * 3); col.set(c, i * 3); anim.set([a0, a1, a2, a3], i * 4); size[i] = s; i++;
    };
    for (const h of halos) add(h.x, h.y, h.z, h.size, h.col, 0, 0, rnd() * TAU, 0);
    if (state.spring) add(state.spring.x, state.spring.y, state.spring.z, 3.2, [0.1, 0.4, 0.45], 0, 0, 1, 0);
    add(CX, baseY + PLATFORM_Y + 1.4, CZ + 3.5, 3.4, [0.3, 0.2, 0.07], 0, 0, 2, 0);
    fliesStart = i;
    for (let k = 0; k < nF; k++) {
      const inCanopy = k % 4 === 3;
      let x, y, z;
      if (inCanopy) { const c = canopy[(rnd() * canopy.length) | 0]; x = c.x + (rnd() - 0.5) * c.rx * 2.2; y = c.y + (rnd() - 0.7) * c.ry * 2; z = c.z + (rnd() - 0.5) * c.rx * 2.2; }
      else { const a = rnd() * TAU, r = Math.sqrt(rnd()) * (V.r + 2); x = CX + Math.sin(a) * r; z = CZ + Math.cos(a) * r; y = gy(x, z) + 0.3 + Math.pow(rnd(), 1.6) * 4.5; }
      const gold = rnd() < 0.62;
      const c = gold ? [3.2, 2.5, 0.8] : [1.2, 3.0, 2.7];
      add(x, y, z, 0.1 + rnd() * 0.08, c.map((v) => v * (0.7 + rnd() * 0.5)), 0.5 + rnd() * 1.1, 0.25 + rnd() * 0.45, rnd() * TAU, gold ? 1.2 + rnd() * 2.2 : 0);
    }
    const g = G(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aAnim', new THREE.BufferAttribute(anim, 4));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.computeBoundingSphere();
    const pts = new THREE.Points(g, pointsMat);
    pts.name = 'elf-glow-points';
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    const _v2 = new THREE.Vector2();
    pts.onBeforeRender = (renderer, scene, cam) => {
      renderer.getDrawingBufferSize(_v2);
      pointsU.uScale.value = _v2.y * 0.5 * cam.projectionMatrix.elements[5];
    };
    root.add(pts);
    return pts;
  })();

  /* ------------------------------ Лучи сквозь крону ------------------------------ */
  const rayU = { uColor: { value: new THREE.Color(1.0, 0.78, 0.4) }, uIntensity: { value: 0.12 }, uTime: { value: 0 } };
  {
    const parts = [];
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.16, 0, -0.2));
    const spots = [[-6.5, 4.5, 1.2], [5.5, -6, 1.5], [8, 5.5, 1.0], [-3, -8.5, 1.3], [1.5, 9.5, 1.1], [-9.5, -2, 0.9], [11, -1, 0.8]];
    spots.forEach(([dx, dz, r], k) => {
      const L = 17;
      const g = new THREE.CylinderGeometry(r * 0.55, r * 1.6, L, 16, 1, true);
      g.translate(0, L / 2, 0);
      g.applyQuaternion(tilt);
      g.translate(CX + dx, baseY - 0.2, CZ + dz);
      const seedA = new Float32Array(g.attributes.position.count).fill(k / spots.length);
      g.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
      parts.push(g);
    });
    // слить (атрибут aSeed — свой)
    let vc = 0, ic = 0;
    for (const g of parts) { vc += g.attributes.position.count; ic += g.index.count; }
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), sd = new Float32Array(vc), idx = new Uint16Array(ic);
    let vo = 0, io = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); uv.set(g.attributes.uv.array, vo * 2); sd.set(g.attributes.aSeed.array, vo);
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      vo += g.attributes.position.count; io += g.index.count; g.dispose();
    }
    const rg = G(new THREE.BufferGeometry());
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); rg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); rg.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    rg.setIndex(new THREE.BufferAttribute(idx, 1)); rg.computeBoundingSphere();
    const rays = new THREE.Mesh(rg, M(new THREE.ShaderMaterial({ uniforms: rayU, vertexShader: RAY_VERT, fragmentShader: RAY_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false })));
    rays.name = 'elf-light-shafts';
    rays.renderOrder = 4;
    root.add(rays);
  }

  /* ------------------------------ Дальнее сияние ------------------------------ */
  // Тёплый ореол над кроной, видный с дороги сквозь туман (вне root — не прячется издали).
  const farGlow = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: texGlow, color: 0xffd28a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
  farGlow.material.color.multiplyScalar(1.4);
  farGlow.position.set(CX, baseY + 17, CZ);
  farGlow.scale.set(46, 34, 1);
  farGlow.name = 'elf-far-glow';
  parent.add(farGlow);

  /* ------------------------------ Свет ------------------------------ */
  const hemi = new THREE.HemisphereLight(0xffe2b4, 0x3c6e46, 0);
  hemi.name = 'elf-hemi';
  lightsGroup.add(hemi);
  const LU = lightUnit;
  const pointDefs = [
    { color: 0xffc66e, i: 70, d: 44, decay: 1.2, x: CX, y: baseY + 10.5, z: CZ },                       // крона — золото
    { color: 0x58f0de, i: 16, d: 17, decay: 1.2, x: pondW.x, y: state.pondY + 2.2, z: pondW.z },        // пруд — бирюза
    { color: 0xffd9a0, i: 14, d: 15, decay: 1.2, x: GATE.x + 1.5, y: baseY + 4.2, z: GATE.z },           // врата
    { color: 0xffc98a, i: 16, d: 18, decay: 1.2, x: CX + 3, y: baseY + 4.5, z: CZ + 15 },               // северные дома
  ];
  const plights = pointDefs.map((d) => {
    const l = new THREE.PointLight(d.color, 0, d.d, d.decay);
    l.position.set(d.x, d.y, d.z);
    l.castShadow = false;
    l.userData.base = d.i * LU;
    lightsGroup.add(l);
    return l;
  });

  /* ------------------------------ Жители ------------------------------ */
  const npcRoot = new THREE.Group();
  npcRoot.name = 'elf-villagers';
  root.add(npcRoot);
  const npcs = [];
  const loadedSources = [];
  const vrmTemplates = {};   // файл VRM → { vrm, clips, h0, minY, boneNames, natural } | null
  const OUTLINE = new WeakMap();   // геометрия меша VRM → [материал, контур] (контур — только вблизи)
  const FACE_PARTS = new WeakSet(); // глаза, брови, рот: без тени, вдали (>22 м) скрыты
  const UP = new THREE.Vector3(0, 1, 0);
  // Пути гуляющих: круг снаружи/внутри и «через мостик к дому за ручьём» (туда-обратно с паузами).
  const PATH_DEFS = {
    ringOut: { loop: true, R: RING_R + 0.45, dir: 1 },
    bridge: { loop: false, pts: [bridgePath[0], ...bridgePath.slice(1, -1), V3(H4door.x - Math.sin(houseDoor(HOUSES[3]).a) * -0.2, 0, H4door.z)], pause: 3.5 },
  };
  for (const p of Object.values(PATH_DEFS)) {
    if (p.loop) { p.len = TAU * p.R; continue; }
    p.cum = [0];
    for (let i = 1; i < p.pts.length; i++) p.cum.push(p.cum[i - 1] + Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].z - p.pts[i - 1].z));
    p.len = p.cum[p.cum.length - 1];
  }
  function pathAt(p, s, out) {
    if (p.loop) {
      const ph = (s / p.R) * p.dir;
      out.x = CX + Math.sin(ph) * p.R; out.z = CZ + Math.cos(ph) * p.R;
      out.yaw = ph + (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      return out;
    }
    s = clamp(s, 0, p.len);
    let i = 1; while (i < p.cum.length - 1 && p.cum[i] < s) i++;
    const a = p.pts[i - 1], b = p.pts[i], L = p.cum[i] - p.cum[i - 1] || 1, u = (s - p.cum[i - 1]) / L;
    out.x = lerp(a.x, b.x, u); out.z = lerp(a.z, b.z, u);
    out.yaw = Math.atan2(b.x - a.x, b.z - a.z);
    return out;
  }

  const loaderCache = new Map();
  let loaderP = null;
  function loadModel(file) {
    const url = new URL('../assets/quaternius/' + file, import.meta.url).href;
    if (!loaderCache.has(url)) {
      if (!loaderP) { loaderP = import('./vrmKit.js').then((m) => m.createGltfLoader()); loaderP.catch(() => { loaderP = null; }); } // [LOAD] с распаковщиком meshopt
      loaderCache.set(url, loaderP.then((l) => l.loadAsync(url)));
    }
    return loaderCache.get(url);
  }
  function labelSprite(npc, greet) {
    const key = greet ? 'texHello' : 'texName';
    if (!npc[key]) npc[key] = T(new THREE.CanvasTexture(paintLabel(npc.def.name, greet ? npc.def.hello : '')));
    npc[key].colorSpace = THREE.SRGBColorSpace;
    if (!npc.label) {
      npc.label = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: npc[key], transparent: true, opacity: 0, depthWrite: false, fog: false })));
      npc.label.scale.set(2.5, 0.625, 1);
      npc.label.renderOrder = 6;
      npc.label.center.set(0.5, 0);
      npc.root.add(npc.label);
    }
    if (npc.label.material.map !== npc[key]) { npc.label.material.map = npc[key]; npc.label.material.needsUpdate = true; }
  }

  const yieldTask = () => new Promise((r) => setTimeout(r, 0));   // тяжёлые шаги — по разным задачам, без длинного кадра
  // Скорость «родного» шага клипа: стопа в опоре едет назад со скоростью хода (модель смотрит в +z).
  function measureWalk(scene, clip, fl, fr) {
    const mixer = new THREE.AnimationMixer(scene), a = mixer.clipAction(clip);
    a.play();
    const N = 48, T = clip.duration, rec = [], v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      mixer.setTime((T * i) / N); scene.updateMatrixWorld(true);
      fl.getWorldPosition(v1); fr.getWorldPosition(v2);
      rec.push([v1.y, v1.z, v2.y, v2.z]);
    }
    a.stop(); mixer.uncacheRoot(scene);
    const minY = Math.min(...rec.map((r) => Math.min(r[0], r[2]))), vs = [], dt = T / N;
    for (let i = 1; i <= N; i++) for (const k of [0, 2]) {
      if (rec[i][k] < minY + 0.03 && rec[i - 1][k] < minY + 0.03) vs.push(-(rec[i][k + 1] - rec[i - 1][k + 1]) / dt);
    }
    vs.sort((p, q) => p - q);
    const v = vs.length ? vs[vs.length >> 1] : 0;
    return v > 0.2 ? v : 1.2;
  }
  // Клип на нормализованных костях VRM → клип на сырых костях (его играют клоны без vrm.update).
  function bakeRaw(vrm, normClip, fps = 30) {
    const H = vrm.humanoid, raws = [];
    for (const name of Object.keys(H.humanBones || {})) {
      const node = H.getRawBoneNode(name);
      if (node && !raws.includes(node)) raws.push(node);
    }
    const hips = H.getRawBoneNode('hips');
    const mixer = new THREE.AnimationMixer(vrm.scene), a = mixer.clipAction(normClip);
    a.play();
    const n = Math.max(2, Math.ceil(normClip.duration * fps) + 1);
    const times = new Float32Array(n), qs = raws.map(() => new Float32Array(n * 4)), hp = new Float32Array(n * 3);
    for (let f = 0; f < n; f++) {
      const t = Math.min(normClip.duration, (f / (n - 1)) * normClip.duration);
      times[f] = t;
      mixer.setTime(t);
      H.update();
      raws.forEach((node, i) => node.quaternion.toArray(qs[i], f * 4));
      if (hips) hips.position.toArray(hp, f * 3);
    }
    a.stop(); mixer.uncacheRoot(vrm.scene);
    if (H.resetNormalizedPose) H.resetNormalizedPose();
    H.update();
    const tracks = raws.map((node, i) => new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, qs[i]));
    if (hips) tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, hp));
    return new THREE.AnimationClip(normClip.name, normClip.duration, tracks);
  }
  // Шаблон VRM: морфы (мимика) не нужны — убрать; меши с одним материалом — слить в один
  // SkinnedMesh (скелет один, матрицы привязки единичные): ~100 → ~20 вызовов отрисовки.
  async function prepareVrmTemplate(vrm, key) {
    const { mergeGeometries } = await import('three/addons/utils/BufferGeometryUtils.js');
    const scene = vrm.scene;
    scene.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert(), rel = new THREE.Matrix4();
    const isIdent = (m) => m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-5);
    const groups = new Map();
    const KEEP = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.geometry.morphAttributes = {};
      o.geometry.morphTargetsRelative = false;
      o.morphTargetInfluences = undefined; o.morphTargetDictionary = undefined;
      rel.multiplyMatrices(inv, o.matrixWorld);
      if (!isIdent(rel) || !isIdent(o.bindMatrix)) return;
      // ключ — основной материал (у каждого меша свой экземпляр материала-контура с теми же настройками)
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const k = mats[0].uuid + '#' + mats.length + '#' + o.skeleton.uuid + '#' + o.renderOrder;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geos = list.map((o) => {
        const g = o.geometry.clone();
        g.clearGroups();
        for (const a of Object.keys(g.attributes)) if (!KEEP.includes(a)) g.deleteAttribute(a);
        return g;
      });
      const mg = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!mg) continue;
      const o0 = list[0], nMat = Array.isArray(o0.material) ? o0.material.length : 1;
      if (nMat > 1) for (let i = 0; i < nMat; i++) mg.addGroup(0, mg.index ? mg.index.count : mg.attributes.position.count, i);
      const m = new THREE.SkinnedMesh(mg, o0.material);
      m.name = o0.name + '_merged';
      m.renderOrder = o0.renderOrder; m.castShadow = true; m.receiveShadow = true;
      m.bind(o0.skeleton, o0.bindMatrix);
      o0.parent.add(m);
      for (const o of list) { o.parent.remove(o); o.geometry.dispose(); }
    }
    // Контур MToon (второй материал) — только у близких эльфов (updateNpcs), по умолчанию выключен;
    // мелочь лица (глаза, брови, рот) тень не отбрасывает. Ключ — геометрия: клоны её разделяют.
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      if (Array.isArray(o.material) && o.material.length > 1) { OUTLINE.set(o.geometry, o.material); o.material = o.material[0]; }
      const m0 = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m0 && /_(FACE|EYE)$/i.test(m0.name || '')) { FACE_PARTS.add(o.geometry); o.castShadow = false; }
    });
    // MToon светит освещённую сторону целиком (тун-ступень вместо N·L) — под тёплыми огнями
    // деревни эльфы выходили вдвое ярче каменных домов и «горели» в bloom. Приглушаем свет и тень.
    const toned = new Set();
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      for (const m of OUTLINE.get(o.geometry) || [o.material]) {
        if (!m || toned.has(m) || !m.isMToonMaterial) continue;
        toned.add(m);
        if (m.color) m.color.multiplyScalar(MTOON_LIT);
        if (m.shadeColorFactor) m.shadeColorFactor.multiplyScalar(MTOON_LIT);
        if (m.parametricRimColorFactor) m.parametricRimColorFactor.multiplyScalar(0.6);
      }
    });
    // отсечение по кадру: сфера по позе привязки с запасом на движение (без покадрового пересчёта скиннинга)
    scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      o.boundingSphere = o.geometry.boundingSphere.clone();
      o.boundingSphere.radius += 0.6;
      o.frustumCulled = true;
    });
    // уши эльфа — на сырую кость головы (клоны получат их вместе со сценой)
    const earCol = VRM_EARS[key];
    const head = vrm.humanoid.getRawBoneNode('head');
    if (earCol && head) {
      scene.updateMatrixWorld(true);
      const hp = head.getWorldPosition(new THREE.Vector3());
      const box = new THREE.Box3().setFromObject(scene);
      const s = clamp((box.max.y - hp.y) / 0.23, 0.7, 1.4);
      const mat = M(new THREE.MeshStandardMaterial({ color: earCol, roughness: 0.6, metalness: 0, emissive: earCol, emissiveIntensity: 0.22 }));
      const geo = G(new THREE.ConeGeometry(0.021 * s, 0.105 * s, 6));
      geo.translate(0, 0.0525 * s, 0);
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(geo, mat);
        ear.name = 'elf-ear';
        ear.position.set(hp.x + side * 0.066 * s, hp.y + 0.083 * s, hp.z - 0.014 * s);
        ear.rotation.set(-0.42, 0, -side * 1.1);
        ear.scale.set(1, 1, 0.42);
        ear.castShadow = true;
        scene.add(ear);
        ear.updateMatrixWorld(true);
        head.attach(ear);
      }
    }
    scene.updateMatrixWorld(true);
  }

  // Общая часть жителя: обёртка, микшер, стартовая поза, место на карте.
  function addNpc(def, idx, model, clips, bones, natural) {
    const r = new THREE.Group();
    r.name = 'elf-npc-' + def.id;
    r.add(model);
    npcRoot.add(r);
    const npc = {
      def, i: idx, root: r, model, mixer: new THREE.AnimationMixer(model), bones, clips, actions: {}, cur: null, curName: '',
      x: 0, z: 0, y: 0, yaw: def.yaw || 0, baseYaw: def.yaw || 0, engaged: false, lookW: 0, acc: 0,
      s: 0, dirSign: 1, pauseT: 0, walkRate: def.speed ? def.speed / Math.max(0.2, natural) : 1, labelA: 0, greet: false, shadow: true,
    };
    if (def.mode === 'walk') {
      const p = PATH_DEFS[def.path];
      npc.path = p; npc.s = (def.s0 || 0) * p.len;
      pathAt(p, npc.s, _pt); npc.x = _pt.x; npc.z = _pt.z; npc.yaw = _pt.yaw;
    } else if (def.mode === 'sit') {
      const b = BENCHES[def.bench];
      npc.x = b.x; npc.z = b.z; npc.yaw = npc.baseYaw = b.yaw;
    } else {
      const w = W(def.dx, def.dz);
      npc.x = w.x; npc.z = w.z;
    }
    npcs.push(npc);
    const first = def.mode === 'walk' ? 'Walk' : def.mode === 'sit' ? 'SitIdle' : def.mode === 'work' ? 'Working' : 'Idle';
    setAnim(npc, first, 0);
    if (npc.cur) npc.cur.time = rnd() * npc.cur.getClip().duration;   // фазы вразнобой
    npc.mixer.update(0);
    if (def.spear && bones.RightHand) attachSpear(npc);
    return npc;
  }

  // [LOAD] Жители (~4 МБ моделей и перенос клипов в главном потоке) грузятся лениво: когда игрок
  // подходит ближе NPC_LOAD_R к центру деревни (от арены и от врат леса до деревни ~180–200 м) или в
  // простое после NPC_IDLE_SEC секунд движения героя, но не посреди боя (busy от world.js: перенос
  // клипов в главном потоке дал бы подвисания кадров) — тогда после победы, поражения или на прогулке.
  // В меню герой стоит — до него и в нём ни одного запроса. Дома, Древо, свет и коллайдеры строятся сразу.
  // npcEager: true — прежнее поведение (жители грузятся сразу при создании деревни).
  const NPC_LOAD_R = V.r + 110, NPC_IDLE_SEC = 60;
  const lazy = { started: false, playT: 0, last: null, idle: false, busy: false };
  function loadNpcs(reason = 'manual') {
    if (lazy.started || state.disposed) return;
    lazy.started = true; state.npcLoad = reason;
    spawn();
  }
  function watchNpcLoad(dt, px, pz, dP, hasPlayer, busy) {
    if (dP < NPC_LOAD_R) { loadNpcs('near'); return; }
    lazy.busy = busy;
    if (!hasPlayer || lazy.idle) return;
    // время движения героя: телепорты (сброс боя, смена места старта) не считаются
    if (lazy.last) { const d = Math.hypot(px - lazy.last.x, pz - lazy.last.z); if (d > 0.002 && d < 3) lazy.playT += dt; }
    lazy.last = { x: px, z: pz };
    if (lazy.playT < NPC_IDLE_SEC || busy) return;
    lazy.idle = true;
    const go = () => { if (lazy.busy) { lazy.idle = false; return; } loadNpcs('idle'); };   // бой начался, пока ждали простоя — позже
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 300);
  }

  async function spawn() {
    let clone, S;
    try {
      const [sk, gW, gH] = await Promise.all([import('three/addons/utils/SkeletonUtils.js'), loadModel('woman.glb'), loadModel('human.glb')]);
      if (state.disposed) return;
      clone = sk.clone;
      S = {};
      for (const [key, g] of [['woman', gW], ['human', gH]]) {
        g.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(g.scene);
        S[key] = { g, clips: clipMap(g.animations), h0: Math.max(1e-3, box.max.y - box.min.y), minY: box.min.y };
        loadedSources.push(g);
      }
    } catch (e) {
      state.npcError = (e && e.message) || String(e);
      console.warn('[elfVillage] клипы Quaternius не загрузились — жителей нет:', state.npcError);
      return;
    }
    // шаблоны VRM: по одному на файл, клипы — один раз на (файл, клип)
    const tpl = vrmTemplates;
    let kit = null;
    try { kit = await import('./vrmKit.js'); } catch (e) { state.vrmError = (e && e.message) || String(e); }
    const need = {};
    for (const d of NPC_DEFS) { if (!need[d.vrm]) need[d.vrm] = new Set(); clipsFor(d).forEach((c) => need[d.vrm].add(c)); }
    for (const [key, set] of Object.entries(need)) {
      if (!kit || state.disposed) break;
      try {
        const vrm = await kit.loadVRM(THREE, new URL('../assets/vroid/' + VRM_FILES[key], import.meta.url).href);
        if (state.disposed) return;
        await yieldTask();
        await prepareVrmTemplate(vrm, key);
        vrm.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(vrm.scene);
        const H = vrm.humanoid;
        const clips = {};
        for (const cn of set) {
          const [sk, sn] = CLIP_SRC[cn];
          const srcClip = S[sk].clips[sn];
          if (!srcClip) continue;
          const norm = kit.retargetClip(THREE, srcClip, clone(S[sk].g.scene), vrm);
          clips[cn] = bakeRaw(vrm, norm);
          clips[cn].name = cn;
          await yieldTask();
          if (state.disposed) return;
        }
        const names = { head: 'Head', neck: 'Neck', rightHand: 'RightHand' };
        const boneNames = {};
        for (const [vn, nn] of Object.entries(names)) { const b = H.getRawBoneNode(vn); if (b) boneNames[nn] = b.name; }
        let natural = 1.2;
        if (clips.Walk) {
          natural = measureWalk(vrm.scene, clips.Walk, H.getRawBoneNode('leftFoot'), H.getRawBoneNode('rightFoot'));
          if (H.resetNormalizedPose) H.resetNormalizedPose();
          H.update();
        }
        tpl[key] = { vrm, clips, h0: Math.max(0.5, box.max.y - box.min.y), minY: box.min.y, boneNames, natural };
      } catch (e) {
        state.vrmError = (e && e.message) || String(e);
        console.warn('[elfVillage] VRM', key, 'не загрузился — житель на модели Quaternius:', state.vrmError);
        tpl[key] = null;
      }
    }
    if (state.disposed) return;
    const byId = {};
    NPC_DEFS.forEach((def, idx) => {
      const T0 = tpl[def.vrm];
      let npc;
      if (T0) {
        const model = clone(T0.vrm.scene);
        model.name = 'elf-' + def.id;
        const k = def.h / T0.h0;
        model.scale.setScalar(k);
        model.position.y = -T0.minY * k;
        const bones = {};
        for (const [nn, name] of Object.entries(T0.boneNames)) bones[nn] = model.getObjectByName(name);
        npc = addNpc(def, idx, model, T0.clips, bones, T0.natural * k);
        npc.vrm = true;
      } else {
        const Q = S[def.q.model];
        const model = clone(Q.g.scene);
        model.name = 'elf-q-' + def.id;
        applyLook(THREE, model, def.q.look);
        const h = def.q.h || def.h, k = h / Q.h0;
        model.scale.set(k * 0.95, k, k * 0.95);
        model.position.y = -Q.minY * k;
        const bones = {};
        model.traverse((o) => {
          if (o.isBone) bones[o.name] = o;
          if (o.isMesh) {
            o.castShadow = true; o.receiveShadow = true;
            if (o.isSkinnedMesh) { o.computeBoundingSphere(); o.boundingSphere.radius *= 1.3; }
            if (o.isSkinnedMesh && o.material && atmosphere && atmosphere.patchLit && !o.material.userData.ashRim) atmosphere.patchLit(o.material, 'hero');
          }
        });
        // скорость клипа ходьбы: у Woman «Walking» ≈1.21 м/с, у Human «Walk» ≈1.53 м/с при росте 1.75 м
        const natural = (def.q.model === 'woman' ? 1.21 : 1.53) * (h / 1.75) * 0.95;
        npc = addNpc(def, idx, model, Q.clips, bones, natural);
      }
      byId[def.id] = npc;
    });
    for (const npc of npcs) {
      if (npc.def.faceTo && byId[npc.def.faceTo]) {
        const o = byId[npc.def.faceTo];
        npc.yaw = npc.baseYaw = Math.atan2(o.x - npc.x, o.z - npc.z);
      }
      if (npc.def.platform) npc.fixedY = baseY + PLATFORM_Y + 0.08;
      placeNpc(npc);
    }
    state.npcReady = true;
  }
  // Копьё стража: вертикально в покое, привязано к кисти (качается вместе с рукой).
  function attachSpear(npc) {
    const hand = npc.bones.RightHand;
    npc.root.position.set(0, 0, 0); npc.root.rotation.set(0, 0, 0);
    npc.root.updateMatrixWorld(true);
    const hp = new THREE.Vector3(), hq = new THREE.Quaternion(), hs = new THREE.Vector3();
    hand.matrixWorld.decompose(hp, hq, hs);
    const parts = [];
    const shaft = new THREE.CylinderGeometry(0.022, 0.028, 2.35, 6); shaft.translate(0, 1.175 - hp.y, 0.02);
    put(parts, shaft, 0xf2ead8);
    const blade = new THREE.OctahedronGeometry(0.11, 0); blade.scale(0.5, 2.6, 1); blade.translate(0, 2.55 - hp.y, 0.02);
    put(parts, blade, [0.55, 1.0, 1.0]);
    const ring = new THREE.TorusGeometry(0.045, 0.014, 4, 10); ring.rotateX(Math.PI / 2); ring.translate(0, 2.3 - hp.y, 0.02);
    put(parts, ring, 0xffd88a);
    const g = merge(parts);
    const spear = new THREE.Mesh(g, matSpear);
    spear.castShadow = true;
    spear.name = 'elf-spear';
    // локально в кисти: мировой поворот «вертикально» = hq⁻¹, масштаб — обратный масштабу кисти
    spear.quaternion.copy(hq).invert();
    spear.scale.set(1 / hs.x, 1 / hs.y, 1 / hs.z);
    spear.position.set(0, 0, 0);
    hand.add(spear);
  }
  const matSpear = std({ color: 0xffffff, vertexColors: true, roughness: 0.3, metalness: 0.6, emissive: 0xffffff, emissiveIntensity: 1 });
  glowByColor(matSpear, 0.25, 'spear');

  function setAnim(npc, name, fade = 0.35) {
    if (npc.curName === name) return;
    const clip = npc.clips[name];
    if (!clip) return;
    const a = npc.actions[name] || (npc.actions[name] = npc.mixer.clipAction(clip));
    a.enabled = true;
    a.reset().setEffectiveWeight(1).play();
    if (npc.cur && fade > 0) a.crossFadeFrom(npc.cur, fade, false);
    else if (npc.cur) npc.cur.stop();
    npc.cur = a; npc.curName = name;
    a.timeScale = name === 'Walk' ? npc.walkRate : 1;
  }
  function placeNpc(npc) {
    npc.y = npc.fixedY !== undefined ? npc.fixedY : floorAt(npc.x, npc.z);
    npc.root.position.set(npc.x, npc.y, npc.z);
    npc.root.rotation.y = npc.yaw;
  }
  const _qa = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _pt = { x: 0, z: 0, yaw: 0 };
  // Поворот головы и шеи к игроку в мировых осях (оси костей у моделей разные — считаем через мир).
  function lookBone(bone, ang) {
    if (!bone || !bone.parent || Math.abs(ang) < 1e-4) return;
    bone.parent.getWorldQuaternion(_qp);
    bone.getWorldQuaternion(_qh);
    _qa.setFromAxisAngle(UP, ang);
    _qh.premultiply(_qa);
    bone.quaternion.copy(_qp.invert().multiply(_qh));
    bone.updateMatrixWorld(true);
  }

  function updateNpcs(dt, px, pz, camX, camZ) {
    const q = QV[state.quality];
    for (const npc of npcs) {
      const dxp = px - npc.x, dzp = pz - npc.z, d = Math.hypot(dxp, dzp);
      const dc = Math.hypot(camX - npc.x, camZ - npc.z);
      const vis = dc < q.npcR;
      if (npc.root.visible !== vis) npc.root.visible = vis;
      if (!vis) continue;
      const dy = npc.fixedY !== undefined ? Math.abs((npc.fixedY) - (state.playerY ?? npc.fixedY)) : 0;
      // игрок рядом: остановиться и повернуться (гистерезис 3.8 / 5.5 м)
      const near = dy < 3 && (npc.engaged ? d < 5.5 : d < 3.8);
      npc.engaged = near;
      const faceYaw = Math.atan2(dxp, dzp);
      const mode = npc.def.mode;
      if (mode === 'walk') {
        const p = npc.path;
        if (npc.engaged) { setAnim(npc, 'Idle', 0.4); npc.yaw += wrapAngle(faceYaw - npc.yaw) * dampK(4, dt); }
        else if (npc.pauseT > 0) {
          npc.pauseT -= dt; setAnim(npc, 'Idle', 0.4);
          if (npc.pauseT <= 0) npc.dirSign = -npc.dirSign;
          const tgt = pathAt(p, npc.s + npc.dirSign * -0.5, _pt).yaw + (npc.dirSign > 0 ? Math.PI : 0);
          npc.yaw += wrapAngle(tgt - npc.yaw) * dampK(2.5, dt);
        } else {
          setAnim(npc, 'Walk', 0.4);
          npc.s += npc.def.speed * dt * (p.loop ? 1 : npc.dirSign);
          if (p.loop) npc.s %= p.len;
          else if (npc.s >= p.len || npc.s <= 0) { npc.s = clamp(npc.s, 0, p.len); npc.pauseT = p.pause || 2; }
          pathAt(p, npc.s, _pt);
          npc.x = _pt.x; npc.z = _pt.z;
          const tgt = _pt.yaw + (!p.loop && npc.dirSign < 0 ? Math.PI : 0);
          npc.yaw += wrapAngle(tgt - npc.yaw) * dampK(7, dt);
        }
      } else if (mode === 'sit') {
        // сидящие поворачивают только голову
      } else if (mode === 'work') {
        if (npc.engaged) { setAnim(npc, 'Idle', 0.5); npc.yaw += wrapAngle(faceYaw - npc.yaw) * dampK(3.5, dt); }
        else { npc.yaw += wrapAngle(npc.baseYaw - npc.yaw) * dampK(3, dt); if (Math.abs(wrapAngle(npc.baseYaw - npc.yaw)) < 0.15) setAnim(npc, 'Working', 0.5); }
      } else {
        const tgt = npc.engaged ? faceYaw : npc.baseYaw;
        npc.yaw += wrapAngle(tgt - npc.yaw) * dampK(npc.engaged ? 3.5 : 2, dt);
      }
      placeNpc(npc);
      // тень — только у ближних (камера тени ключа всё равно ~42 м вокруг героя)
      const wantShadow = d < q.shadowR;
      if (npc.shadow !== wantShadow) { npc.shadow = wantShadow; npc.model.traverse((o) => { if (o.isMesh) o.castShadow = wantShadow && !FACE_PARTS.has(o.geometry); }); }
      // контур MToon — только вблизи (вдали его не видно, а это +6 вызовов отрисовки на эльфа);
      // мелочь лица вдали — пара пикселей, прячем (−8 вызовов)
      if (npc.vrm) {
        const wantOutline = dc < 9, wantFace = dc < 22;
        if (npc.outline !== wantOutline || npc.face !== wantFace) {
          npc.outline = wantOutline; npc.face = wantFace;
          npc.model.traverse((o) => {
            if (!o.isMesh) return;
            const full = OUTLINE.get(o.geometry);
            if (full) o.material = wantOutline ? full : full[0];
            if (FACE_PARTS.has(o.geometry)) o.visible = wantFace;
          });
        }
      }
      // анимация: ближние — каждый кадр, дальше 25 м — через кадр, дальше q.animR — стоп
      npc.acc += dt;
      const animOn = d < q.animR;
      const every = d < 25 ? 1 : 2;
      let updated = false;
      if (animOn && (every === 1 || ((state.frame + npc.i) & 1) === 0)) { npc.mixer.update(npc.acc); npc.acc = 0; updated = true; }
      else if (!animOn) npc.acc = 0;
      // голова к игроку (после микшера: клип перезаписывает кости каждый кадр)
      const lookWant = d < 6.5 && dy < 3 ? 1 : 0;
      npc.lookW += (lookWant - npc.lookW) * dampK(3, dt);
      if (updated && npc.lookW > 0.01) {
        npc.root.updateMatrixWorld(true);
        const rel = wrapAngle(faceYaw - npc.yaw);
        const lim = mode === 'sit' ? 1.05 : 1.2;
        const ang = clamp(rel, -lim, lim) * npc.lookW;
        lookBone(npc.bones.Neck, ang * 0.35);
        lookBone(npc.bones.Head, ang * 0.65);
      }
      // имя и приветствие
      const wantA = d < 10 && dy < 3.5 ? smoothstep(10, 7, d) : 0;
      npc.labelA += (wantA - npc.labelA) * dampK(5, dt);
      if (npc.labelA > 0.01) {
        const greet = d < 4.6;
        if (!npc.label || greet !== npc.greet) { labelSprite(npc, greet); npc.greet = greet; }
        npc.label.visible = true;
        npc.label.material.opacity = npc.labelA;
        npc.label.position.set(0, npc.def.mode === 'sit' ? npc.def.h * 0.72 + 0.25 : npc.def.h + 0.28, 0);
      } else if (npc.label) npc.label.visible = false;
    }
  }

  /* ------------------------------ Качество ------------------------------ */
  function setQuality(qName) {
    if (state.disposed) return;
    state.quality = normQ(qName);
    const q = QV[state.quality];
    for (const t of tiers) t.mesh.count = t.key === 'orbs' ? Math.round(t.max * q.orbs) : Math.min(t.max, q[t.key]);
    points.geometry.setDrawRange(0, fliesStart + q.flies);
    plights.forEach((l, i) => { l.visible = i < q.lights; });
  }
  function configure(patch = {}) {
    if (patch && 'reducedMotion' in patch) state.reduced = !!patch.reducedMotion;
    if (patch && 'quality' in patch) setQuality(patch.quality);
  }

  /* ------------------------------ Кадр ------------------------------ */
  function update(dt, playerPos, busy = false) {
    if (state.disposed) return;
    dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
    state.time += dt; state.frame++;
    const t = state.time, rm = state.reduced ? 0.3 : 1;
    const cam = camera ? camera.position : null;
    const px = playerPos && Number.isFinite(playerPos.x) ? playerPos.x : cam ? cam.x : CX + 999;
    const pz = playerPos && Number.isFinite(playerPos.z) ? playerPos.z : cam ? cam.z : CZ + 999;
    state.playerY = playerPos && Number.isFinite(playerPos.y) ? playerPos.y : undefined;
    const camX = cam ? cam.x : px, camZ = cam ? cam.z : pz;
    const dP = Math.hypot(px - CX, pz - CZ), dC = Math.hypot(camX - CX, camZ - CZ);
    const w = smoothstep(V.r + 45, V.r + 4, dP);
    state.weight = w;
    if (!lazy.started) watchNpcLoad(dt, px, pz, dP, !!(playerPos && Number.isFinite(playerPos.x)), !!busy);   // [LOAD]
    // свет и воздух деревни — по близости игрока
    hemi.intensity = 1.25 * w;
    const fl = 1 + 0.04 * Math.sin(t * 1.7) * rm;
    for (const l of plights) l.intensity = l.userData.base * w * fl;
    if (atmosphere && typeof atmosphere.setLocalClear === 'function') atmosphere.setLocalClear(w);
    farGlow.material.opacity = 0.5 * smoothstep(40, 110, dC) * (1 - smoothstep(260, 340, dC));
    farGlow.visible = farGlow.material.opacity > 0.003;
    const vis = dC < 200;
    if (root.visible !== vis) root.visible = vis;
    if (!vis) return;
    pointsU.uTime.value = t; pointsU.uMotion.value = rm;
    rayU.uTime.value = t * rm;
    texCausticPond.offset.set(t * 0.012 * rm, t * 0.007 * rm);
    texCausticStream.offset.set(-t * 0.16 * rm, 0);
    leafGlow.value = 0.66 + 0.05 * Math.sin(t * 0.8) * rm;
    crystalGlow.value = 2.2 + 0.35 * Math.sin(t * 1.3) * rm;
    flowerGlow.value = 0.42 + 0.05 * Math.sin(t * 0.6 + 1) * rm;
    roofGlow.value = 0.07;
    if (state.npcReady) updateNpcs(dt, px, pz, camX, camZ);
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    if (atmosphere && typeof atmosphere.setLocalClear === 'function') atmosphere.setLocalClear(0);
    for (const npc of npcs) {
      npc.mixer.stopAllAction();
      npc.model.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.isSkinnedMesh && o.geometry) o.geometry.dispose();          // уши, обруч, плащ, копьё
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m) m.dispose();                            // палитру (кэш characterLooks) не трогаем
      });
    }
    for (const g of loadedSources) g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m) { for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
    });
    for (const t of Object.values(vrmTemplates)) if (t && t.vrm) t.vrm.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m) {
        for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose();
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) u.value.dispose();
        m.dispose();
      }
    });
    root.traverse((o) => { if (o.isInstancedMesh && o.dispose) o.dispose(); });
    for (const o of [root, lightsGroup, farGlow]) if (o.parent) o.parent.remove(o);
    for (const g of owned.geo) g.dispose();
    for (const m of owned.mat) m.dispose();
    for (const tx of owned.tex) tx.dispose();
    owned.geo.clear(); owned.mat.clear(); owned.tex.clear();
    npcs.length = 0;
  }

  setQuality(state.quality);
  if (npcEager) loadNpcs('eager');   // [LOAD] по умолчанию — лениво (watchNpcLoad в update)

  return {
    root,
    update,
    setQuality,
    configure,
    dispose,
    center,
    radius: V.r,
    colliders,
    groundAt,
    floorLift,   // [W5-ПОЛ]
    get weight() { return state.weight; },
    get ready() { return state.npcReady; },
    loadNpcs,   // [LOAD] загрузить жителей сейчас (стенды, QA)
    stats: () => ({
      quality: state.quality, npcs: npcs.length, npcReady: state.npcReady, npcError: state.npcError,
      npcLoad: lazy.started ? state.npcLoad : 'waiting', npcPlaySec: +lazy.playT.toFixed(1),   // [LOAD]
      vrmNpcs: npcs.filter((n) => n.vrm).length, vrmError: state.vrmError || null,
      animated: npcs.filter((n) => n.root.visible).length, weight: +state.weight.toFixed(3),
      lights: plights.filter((l) => l.visible).length, colliders: colliders.length,
      npcList: npcs.map((n) => ({ id: n.def.id, anim: n.curName, x: +n.x.toFixed(2), z: +n.z.toFixed(2), y: +n.y.toFixed(2), engaged: n.engaged })),
    }),
  };
}
