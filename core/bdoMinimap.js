// ASHEN OATH — core/bdoMinimap.js. Владелец: №8 [BDO].
// Мини-карта BDO (canvas): схема мира из world.layout — дороги, зоны, угли, соперник, герой.
// createMinimap({ canvas, rotate }) → { draw(f, info), dispose() }; info = { size (css px), dpr }.
// Рисует только круглое содержимое карты (clip по кругу + тонкая внутренняя кромка); кольцо-рамку
// и подписи зоны вокруг рисует DOM-слой core/bdoHud.js.
//
// Как устроено (слабые ноутбуки):
//  • статика — земля с «чернильной» текстурой, обрыв края мира в туман, дороги, свечение зон,
//    постройки из layout.colliders — печётся ОДИН раз в offscreen-canvas всей карты (≈2 px/м)
//    при первом draw с новым layout;
//  • спрайты меток (герой, босс, соперник, угли, подписи зон) — пререндер при смене размера/dpr;
//  • кадр: один drawImage нужного фрагмента + тонкие векторные линии (кромки зон, рунное кольцо
//    арены) + drawImage спрайтов. Без new/массивов/строк в draw.
// Соглашения мира (modules/combat.js): взгляд героя = (sin yaw, cos yaw) в (x, z); на карте
// x — вправо, z — вниз, т.е. «север» (−Z, куда смотрит герой со старта на арену) — вверху.

import { BDO, preloadFonts } from './bdoTheme.js';

const TAU = Math.PI * 2;
const VIEW_EXPLORE = 90;     // м — радиус видимости вне арены
const VIEW_ENGAGED = 40;     // м — в бою у арены
const FOG = '#0d1216';       // синеватая мгла за краем мира (фон за пределами offscreen тоже)
const EDGE_SAMPLES = 720;

// ------------------------------------------------------------------ помощник для HUD
/**
 * Зона, в которой стоит точка: ближайшая по нормированной дистанции d/r среди тех, где d ≤ r;
 * иначе — ближайшая по кромке с inside:false; нет зон — null.
 * → { id, name, inside, dist (м до центра), edge (м до кромки, <0 — внутри), zone }.
 * out — необязательный объект для переиспользования (без аллокаций в кадре).
 */
export function zoneAt(layout, x, z, out) {
  try {
    const L = layout && layout.landmarks;
    if (!L || !L.length || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    let bestIn = null, bestInN = Infinity, bestInD = 0;
    let bestOut = null, bestOutE = Infinity, bestOutD = 0;
    for (let i = 0; i < L.length; i++) {
      const m = L[i];
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.z)) continue;
      const r = m.r > 0 ? m.r : 1;
      const d = Math.hypot(x - m.x, z - m.z);
      if (d <= r) { const n = d / r; if (n < bestInN) { bestInN = n; bestIn = m; bestInD = d; } }
      else if (d - r < bestOutE) { bestOutE = d - r; bestOut = m; bestOutD = d; }
    }
    const m = bestIn || bestOut;
    if (!m) return null;
    const o = out || {};
    const d = bestIn ? bestInD : bestOutD;
    o.id = m.id; o.name = m.name || ''; o.inside = !!bestIn; o.dist = d; o.edge = d - (m.r > 0 ? m.r : 1); o.zone = m;
    return o;
  } catch (e) { return null; }
}

// ------------------------------------------------------------------ мелочи
function makeCanvas(w, h) {
  w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}
function rng(seed) {                       // mulberry32 — детерминированная «случайность» запекания
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const isForest = (m) => /forest/.test(m.id || '') || /лес/i.test(m.name || '');
const isLake = (m) => /lake/.test(m.id || '') || /озер/i.test(m.name || '');
const isHill = (m) => /hill/.test(m.id || '') || /холм/i.test(m.name || '');

// ------------------------------------------------------------------ запекание статики
function edgeRing(layout) {
  const E = Number.isFinite(layout.worldEdge) ? layout.worldEdge : 238;
  const pts = new Float32Array(EDGE_SAMPLES * 2);
  const fn = typeof layout.edgeDistance === 'function' ? layout.edgeDistance : null;
  for (let i = 0; i < EDGE_SAMPLES; i++) {
    const a = (i / EDGE_SAMPLES) * TAU - Math.PI;
    const sx = Math.sin(a), cz = Math.cos(a);
    const sf = Math.sqrt(Math.sqrt(sx * sx * sx * sx + cz * cz * cz * cz));
    let t = E / sf;
    if (fn) {
      try {       // edgeDistance(t·dir) почти линейна по t: две пробы + шаг Ньютона
        const t1 = t * 0.6, t2 = t * 0.9;
        const d1 = fn(sx * t1, cz * t1), d2 = fn(sx * t2, cz * t2);
        const k = (d2 - d1) / (t2 - t1);
        if (Number.isFinite(k) && k < -1e-3) {
          let tt = t1 - d1 / k;
          const d0 = fn(sx * tt, cz * tt);
          if (Number.isFinite(d0)) tt -= d0 / k;
          if (Number.isFinite(tt) && tt > E * 0.5 && tt < E * 1.6) t = tt;
        }
      } catch (e) { /* суперэллипс */ }
    }
    pts[i * 2] = sx * t; pts[i * 2 + 1] = cz * t;
  }
  return pts;
}
function edgePath(g, pts, inset = 0) {
  g.beginPath();
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    let x = pts[i * 2], z = pts[i * 2 + 1];
    if (inset) { const l = Math.hypot(x, z) || 1; x -= (x / l) * inset; z -= (z / l) * inset; }
    if (i) g.lineTo(x, z); else g.moveTo(x, z);
  }
  g.closePath();
}
function blob(g, x, z, r, rgb, a) {
  const gr = g.createRadialGradient(x, z, 0, x, z, r);
  gr.addColorStop(0, `rgba(${rgb},${a})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(x - r, z - r, r * 2, r * 2);
}
function noiseTile(size, seed) {
  const c = makeCanvas(size, size);
  if (!c) return null;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const R = rng(seed);
  for (let i = 0; i < size * size; i++) {
    const v = R();
    const light = v > 0.5;
    img.data[i * 4] = light ? 200 : 0; img.data[i * 4 + 1] = light ? 180 : 0; img.data[i * 4 + 2] = light ? 150 : 0;
    img.data[i * 4 + 3] = Math.round(Math.abs(v - 0.5) * 2 * 20);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function bakeWorld(layout, ppm) {
  const E = Number.isFinite(layout.worldEdge) ? layout.worldEdge : 238;
  // запас за краем мира на радиус обзора — чтобы у обрыва не было шва на границе запекания
  const b = layout.bounds || {}, M = E + 18 + VIEW_EXPLORE * 0.72;
  const minX = Math.min(Number.isFinite(b.minX) ? b.minX : -M, -M), maxX = Math.max(Number.isFinite(b.maxX) ? b.maxX : M, M);
  const minZ = Math.min(Number.isFinite(b.minZ) ? b.minZ : -M, -M), maxZ = Math.max(Number.isFinite(b.maxZ) ? b.maxZ : M, M);
  const W = Math.ceil((maxX - minX) * ppm), H = Math.ceil((maxZ - minZ) * ppm);
  const cv = makeCanvas(W, H);
  if (!cv) return null;
  const g = cv.getContext('2d');
  const R = rng(0xa5e17);
  const toWorld = () => g.setTransform(ppm, 0, 0, ppm, -minX * ppm, -minZ * ppm);
  const L = Array.isArray(layout.landmarks) ? layout.landmarks : [];
  const edge = edgeRing(layout);
  toWorld();

  // --- туман за краем: глубокая мгла, у обрыва — светлее (поднимающийся туман) и клубы
  g.fillStyle = FOG;
  g.fillRect(minX, minZ, maxX - minX, maxZ - minZ);
  g.lineJoin = 'round';
  for (let i = 0; i < 12; i++) {
    edgePath(g, edge);
    g.lineWidth = 110 - i * 8.6;
    g.strokeStyle = 'rgba(104,118,132,0.036)';
    g.stroke();
  }
  for (let i = 0; i < 90; i++) {
    const a = R() * TAU, j = Math.floor(((a + Math.PI) / TAU) * EDGE_SAMPLES) % EDGE_SAMPLES;
    const off = 6 + R() * 46, ex = edge[j * 2], ez = edge[j * 2 + 1], l = Math.hypot(ex, ez) || 1;
    blob(g, ex + (ex / l) * off, ez + (ez / l) * off, 10 + R() * 26, i % 3 ? '100,114,128' : '138,150,160', 0.035 + R() * 0.05);
  }

  // --- земля (внутри кромки)
  g.save();
  edgePath(g, edge);
  g.clip();
  const land = g.createRadialGradient(0, 0, 10, 0, 0, E * 1.1);
  land.addColorStop(0, '#221b13'); land.addColorStop(0.55, '#1a1510'); land.addColorStop(1, '#120f0b');
  g.fillStyle = land;
  g.fillRect(minX, minZ, maxX - minX, maxZ - minZ);
  // «чернильные» разводы: тёплые светлые и тёмные пятна
  for (let i = 0; i < 46; i++) {           // крупные тональные пятна
    const x = (R() * 2 - 1) * E, z = (R() * 2 - 1) * E, r = 40 + R() * 60;
    if (i % 2) blob(g, x, z, r, '64,50,32', 0.07 + R() * 0.07); else blob(g, x, z, r, '0,0,0', 0.12 + R() * 0.12);
  }
  for (let i = 0; i < 240; i++) {
    const x = (R() * 2 - 1) * E, z = (R() * 2 - 1) * E, r = 8 + R() * 34;
    if (R() < 0.55) blob(g, x, z, r, '58,46,30', 0.05 + R() * 0.08);
    else blob(g, x, z, r, '0,0,0', 0.08 + R() * 0.12);
  }
  // холмы — горизонтали
  for (const m of L) {
    if (!m || !isHill(m)) continue;
    g.strokeStyle = 'rgba(176,138,82,0.14)';
    g.lineWidth = 0.9;
    for (let k = 1; k <= 4; k++) { g.beginPath(); g.ellipse(m.x, m.z, m.r * (0.35 + k * 0.32), m.r * (0.3 + k * 0.3), 0.4, 0, TAU); g.stroke(); }
  }
  // леса — тёмный полог и мелкие кроны
  for (const m of L) {
    if (!m || !isForest(m)) continue;
    const bright = /bright|сия/i.test((m.id || '') + (m.name || ''));
    for (let i = 0; i < 30; i++) {
      const a = R() * TAU, rr = Math.sqrt(R()) * m.r * 0.9;
      blob(g, m.x + Math.sin(a) * rr, m.z + Math.cos(a) * rr, 8 + R() * 16, bright ? '10,34,30' : '6,10,6', 0.22 + R() * 0.18);
    }
    const n = Math.round(m.r * m.r * 0.09);
    for (let i = 0; i < n; i++) {
      const a = R() * TAU, rr = Math.sqrt(R()) * m.r * 0.96, x = m.x + Math.sin(a) * rr, z = m.z + Math.cos(a) * rr, r = 0.9 + R() * 1.5;
      g.fillStyle = 'rgba(4,6,4,0.55)';
      g.beginPath(); g.arc(x, z, r, 0, TAU); g.fill();
      g.fillStyle = bright ? 'rgba(143,224,210,0.10)' : 'rgba(120,110,84,0.10)';
      g.beginPath(); g.arc(x - r * 0.3, z - r * 0.3, r * 0.5, 0, TAU); g.fill();
    }
  }
  // озеро — тёмная вода с неровным берегом
  for (const m of L) {
    if (!m || !isLake(m)) continue;
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * TAU, rr = m.r * (0.86 + 0.08 * Math.sin(a * 3 + 1.3) + 0.05 * Math.sin(a * 7));
      const x = m.x + Math.sin(a) * rr, z = m.z + Math.cos(a) * rr;
      if (i) g.lineTo(x, z); else g.moveTo(x, z);
    }
    g.closePath();
    const wg = g.createRadialGradient(m.x, m.z, 2, m.x, m.z, m.r);
    wg.addColorStop(0, 'rgba(18,34,44,0.96)'); wg.addColorStop(1, 'rgba(30,54,64,0.9)');
    g.fillStyle = wg; g.fill();
    g.strokeStyle = 'rgba(143,224,210,0.22)'; g.lineWidth = 0.8; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 2.6; g.stroke();
    g.strokeStyle = 'rgba(143,224,210,0.07)'; g.lineWidth = 0.6;
    for (let k = 0; k < 7; k++) { const z = m.z - m.r * 0.5 + k * m.r * 0.16, hw = m.r * (0.2 + R() * 0.3); g.beginPath(); g.moveTo(m.x - hw, z); g.lineTo(m.x + hw, z); g.stroke(); }
  }
  // зерно (пиксельный шум в пространстве канвы)
  const tile = noiseTile(96, 0x5eed);
  if (tile) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    const pat = g.createPattern(tile, 'repeat');
    if (pat) { g.fillStyle = pat; g.fillRect(0, 0, W, H); }
    toWorld();
  }
  // свечение зон (едва заметное)
  for (const m of L) {
    if (!m || !(m.r > 0) || m.id === 'arena') continue;
    const zg = g.createRadialGradient(m.x, m.z, 0, m.x, m.z, m.r);
    zg.addColorStop(0, 'rgba(216,179,106,0.075)'); zg.addColorStop(0.8, 'rgba(216,179,106,0.035)'); zg.addColorStop(1, 'rgba(216,179,106,0)');
    g.fillStyle = zg;
    g.beginPath(); g.arc(m.x, m.z, m.r, 0, TAU); g.fill();
  }
  // постройки, камни, деревья из коллайдеров — тёмные силуэты с тонким светлым кантом
  const C = Array.isArray(layout.colliders) ? layout.colliders : [];
  const nC = Math.min(C.length, 6000);
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    g.fillStyle = pass ? 'rgba(8,7,5,0.55)' : 'rgba(185,160,120,0.09)';
    g.strokeStyle = g.fillStyle;
    for (let i = 0; i < nC; i++) {
      const c = C[i];
      if (!c) continue;
      if (c.type === 'circle' && c.r > 0.35) {
        if (Math.hypot(c.x, c.z) < 13.5) continue;            // арену рисуем вживую
        g.beginPath(); g.arc(c.x - (pass ? 0 : 0.25), c.z - (pass ? 0 : 0.25), c.r + (pass ? 0 : 0.3), 0, TAU); g.fill();
      } else if (c.type === 'segment') {
        g.lineWidth = Math.max(0.5, (c.r || 0.3) * 2) + (pass ? 0 : 0.9);
        g.beginPath(); g.moveTo(c.ax, c.az); g.lineTo(c.bx, c.bz); g.stroke();
      }
    }
  }
  // под дорогами — утоптанная полоса (сами линии дорог рисуются вживую, см. roadPath)
  const roads = Array.isArray(layout.roads) ? layout.roads : [];
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.lineWidth = 7; g.strokeStyle = 'rgba(58,46,30,0.22)';
  for (const pl of roads) {
    if (!Array.isArray(pl) || pl.length < 2) continue;
    g.beginPath();
    for (let i = 0; i < pl.length; i++) { const p = pl[i]; if (!p) continue; if (i) g.lineTo(p.x, p.z); else g.moveTo(p.x, p.z); }
    g.stroke();
  }
  // у кромки земля тонет в дымке: холодная мгла наползает на несколько метров
  for (let i = 0; i < 8; i++) {
    edgePath(g, edge);
    g.lineWidth = 30 - i * 3.4;
    g.strokeStyle = 'rgba(70,82,94,0.07)';
    g.stroke();
  }
  g.restore();
  toWorld();

  // --- обрыв: мягкий переход в мглу — узкая полоса тумана поверх самой кромки
  g.lineJoin = 'round';
  for (let i = 0; i < 4; i++) {             // тёмный провал сразу за бровкой
    edgePath(g, edge, -1.6);
    g.lineWidth = 5 - i * 1.1;
    g.strokeStyle = 'rgba(6,8,10,0.16)';
    g.stroke();
  }
  // штриховка склона наружу — как на старых картах
  g.strokeStyle = 'rgba(150,160,170,0.09)';
  g.lineWidth = 0.7;
  g.beginPath();
  for (let i = 0; i < EDGE_SAMPLES; i += 2) {
    const x = edge[i * 2], z = edge[i * 2 + 1], l = Math.hypot(x, z) || 1, len = 3 + ((i * 7919) % 11) * 0.6;
    g.moveTo(x, z); g.lineTo(x + (x / l) * len, z + (z / l) * len);
  }
  g.stroke();
  // кромка обрыва: светлая бровка + тёмная тень внутрь
  edgePath(g, edge);
  g.strokeStyle = 'rgba(214,204,184,0.18)'; g.lineWidth = 0.8; g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: cv, minX, minZ, ppm, W, H };
}

// ------------------------------------------------------------------ спрайты меток
function sprite(sz, paint) {
  const c = makeCanvas(sz, sz);
  if (!c) return null;
  const g = c.getContext('2d');
  g.translate(sz / 2, sz / 2);
  paint(g);
  return c;
}
function arrowPath(g, u) {
  g.beginPath();
  g.moveTo(0, -9 * u); g.lineTo(6.6 * u, 6.2 * u); g.lineTo(0, 2.6 * u); g.lineTo(-6.6 * u, 6.2 * u); g.closePath();
}
function buildSprites(D, dpr, R) {
  const u = dpr * Math.max(0.78, Math.min(1.3, D / dpr / 170));
  const S = { u };
  // герой — золотая стрелка
  S.heroSz = Math.ceil(30 * u);
  S.hero = sprite(S.heroSz, (g) => {
    g.shadowColor = 'rgba(243,220,160,0.55)'; g.shadowBlur = 6 * u;
    arrowPath(g, u);
    const gr = g.createLinearGradient(0, -9 * u, 0, 6 * u);
    gr.addColorStop(0, BDO.goldHi); gr.addColorStop(0.55, BDO.gold); gr.addColorStop(1, BDO.goldDeep);
    g.fillStyle = gr; g.fill();
    g.shadowBlur = 0;
    g.lineJoin = 'round'; g.lineWidth = 1.4 * u; g.strokeStyle = 'rgba(24,16,6,0.95)'; g.stroke();
    g.beginPath(); g.moveTo(0, -7 * u); g.lineTo(-5 * u, 4.8 * u); g.lineTo(0, 2 * u); g.closePath();
    g.fillStyle = 'rgba(255,246,220,0.28)'; g.fill();
  });
  // конус взгляда
  S.coneR = Math.max(8, R * 0.5);
  S.coneSz = Math.ceil(S.coneR * 2 + 2);
  S.cone = sprite(S.coneSz, (g) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, S.coneR);
    gr.addColorStop(0, 'rgba(243,220,160,0.24)'); gr.addColorStop(0.6, 'rgba(243,220,160,0.08)'); gr.addColorStop(1, 'rgba(243,220,160,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, S.coneR, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62); g.closePath(); g.fill();
  });
  // босс — красная маска с короной
  S.bossSz = Math.ceil(34 * u);
  S.boss = sprite(S.bossSz, (g) => {
    const aura = g.createRadialGradient(0, 0, 0, 0, 0, 15 * u);
    aura.addColorStop(0, 'rgba(224,72,74,0.34)'); aura.addColorStop(1, 'rgba(224,72,74,0)');
    g.fillStyle = aura; g.fillRect(-16 * u, -16 * u, 32 * u, 32 * u);
    g.beginPath();
    g.moveTo(-5.8 * u, -3.4 * u); g.lineTo(-7 * u, -8.4 * u); g.lineTo(-3.4 * u, -5.4 * u); g.lineTo(0, -9.8 * u);
    g.lineTo(3.4 * u, -5.4 * u); g.lineTo(7 * u, -8.4 * u); g.lineTo(5.8 * u, -3.4 * u);
    g.quadraticCurveTo(6.4 * u, 3.4 * u, 0, 8.6 * u); g.quadraticCurveTo(-6.4 * u, 3.4 * u, -5.8 * u, -3.4 * u); g.closePath();
    const gr = g.createLinearGradient(0, -9 * u, 0, 8 * u);
    gr.addColorStop(0, BDO.bloodHi); gr.addColorStop(0.6, BDO.blood); gr.addColorStop(1, BDO.bloodDeep);
    g.shadowColor = 'rgba(224,72,74,0.7)'; g.shadowBlur = 5 * u;
    g.fillStyle = gr; g.fill();
    g.shadowBlur = 0;
    g.lineJoin = 'round'; g.lineWidth = 1.3 * u; g.strokeStyle = 'rgba(20,4,4,0.95)'; g.stroke();
    g.fillStyle = 'rgba(16,2,2,0.95)';
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * 4.4 * u, -1.4 * u); g.lineTo(s * 0.9 * u, 0.2 * u); g.lineTo(s * 1.2 * u, 1.6 * u); g.lineTo(s * 4 * u, 0.6 * u); g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(255,200,170,0.85)';
    g.beginPath(); g.arc(-2.3 * u, 0.4 * u, 0.55 * u, 0, TAU); g.arc(2.3 * u, 0.4 * u, 0.55 * u, 0, TAU); g.fill();
  });
  // соперник PvP — красная стрелка со светлой обводкой
  S.oppSz = Math.ceil(28 * u);
  S.opp = sprite(S.oppSz, (g) => {
    g.shadowColor = 'rgba(224,72,74,0.65)'; g.shadowBlur = 5 * u;
    g.scale(0.9, 0.9);
    arrowPath(g, u);
    const gr = g.createLinearGradient(0, -9 * u, 0, 6 * u);
    gr.addColorStop(0, '#ff7a6a'); gr.addColorStop(0.5, BDO.bloodHi); gr.addColorStop(1, BDO.bloodDeep);
    g.fillStyle = gr; g.fill();
    g.shadowBlur = 0;
    g.lineJoin = 'round'; g.lineWidth = 1.3 * u; g.strokeStyle = 'rgba(255,226,210,0.8)'; g.stroke();
  });
  // угли: незажжённый — янтарный ромб со свечением; зажжённый — тусклый
  S.emberSz = Math.ceil(22 * u);
  S.ember = sprite(S.emberSz, (g) => {
    const aura = g.createRadialGradient(0, 0, 0, 0, 0, 10 * u);
    aura.addColorStop(0, 'rgba(255,138,60,0.42)'); aura.addColorStop(1, 'rgba(255,138,60,0)');
    g.fillStyle = aura; g.fillRect(-11 * u, -11 * u, 22 * u, 22 * u);
    g.beginPath(); g.moveTo(0, -5.2 * u); g.lineTo(3.4 * u, 0); g.lineTo(0, 5.2 * u); g.lineTo(-3.4 * u, 0); g.closePath();
    const gr = g.createLinearGradient(0, -5 * u, 0, 5 * u);
    gr.addColorStop(0, BDO.emberHi); gr.addColorStop(1, BDO.ember);
    g.fillStyle = gr; g.fill();
    g.lineWidth = 1 * u; g.strokeStyle = 'rgba(40,16,4,0.95)'; g.stroke();
    g.fillStyle = 'rgba(255,245,220,0.8)';
    g.beginPath(); g.moveTo(0, -3 * u); g.lineTo(1.1 * u, 0); g.lineTo(0, 1 * u); g.lineTo(-1.1 * u, 0); g.closePath(); g.fill();
  });
  S.litSz = Math.ceil(10 * u);
  S.lit = sprite(S.litSz, (g) => {
    g.beginPath(); g.moveTo(0, -3.4 * u); g.lineTo(2.3 * u, 0); g.lineTo(0, 3.4 * u); g.lineTo(-2.3 * u, 0); g.closePath();
    g.fillStyle = 'rgba(138,106,62,0.55)'; g.fill();
    g.lineWidth = 0.9 * u; g.strokeStyle = 'rgba(8,6,4,0.85)'; g.stroke();
  });
  // стрелка к ближайшему углю на краю карты
  S.chevSz = Math.ceil(18 * u);
  S.chev = sprite(S.chevSz, (g) => {
    g.shadowColor = 'rgba(255,138,60,0.8)'; g.shadowBlur = 4 * u;
    g.beginPath(); g.moveTo(0, -4.6 * u); g.lineTo(4.6 * u, 2.4 * u); g.lineTo(0, 0.4 * u); g.lineTo(-4.6 * u, 2.4 * u); g.closePath();
    g.fillStyle = BDO.ember; g.fill();
    g.shadowBlur = 0;
    g.lineWidth = 0.9 * u; g.strokeStyle = 'rgba(40,16,4,0.9)'; g.stroke();
  });
  // метка севера
  S.northSz = Math.ceil(14 * u);
  S.north = sprite(S.northSz, (g) => {
    g.beginPath(); g.moveTo(0, -4 * u); g.lineTo(3.2 * u, 2.6 * u); g.lineTo(0, 1.2 * u); g.lineTo(-3.2 * u, 2.6 * u); g.closePath();
    g.fillStyle = BDO.gold; g.fill();
    g.lineWidth = 0.9 * u; g.strokeStyle = 'rgba(16,10,4,0.9)'; g.stroke();
  });
  return S;
}
function buildLabel(text, px, dpr) {
  const probe = makeCanvas(4, 4);
  if (!probe) return null;
  const fnt = `400 ${Math.round(px * dpr)}px ${BDO.fontDisplay}`;
  const pg = probe.getContext('2d');
  pg.font = fnt;
  const sp = 0.5 * dpr;
  if ('letterSpacing' in pg) pg.letterSpacing = `${sp}px`;
  const w = Math.ceil(pg.measureText(text).width + 8 * dpr), h = Math.ceil(px * dpr * 1.6);
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.font = fnt;
  if ('letterSpacing' in g) g.letterSpacing = `${sp}px`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(6,5,4,0.88)';
  g.strokeText(text, w / 2, h / 2);
  g.fillStyle = BDO.ivory;
  g.fillText(text, w / 2, h / 2);
  return c;
}

// Общий кэш запечённой карты: несколько мини-карт (стенд, пересоздание HUD) с одним layout
// не пекут её заново. refs — сколько карт держат запись.
const BAKED = { layout: null, ppm: 0, world: null, roads: null, refs: 0 };
function acquireWorld(layout, ppm) {
  if (BAKED.layout === layout && BAKED.ppm === ppm && BAKED.world) { BAKED.refs++; return BAKED; }
  if (BAKED.refs > 0) {        // занят другой раскладкой — отдельная (не кэшируемая) запись
    return { layout, ppm, world: bakeWorld(layout, ppm), roads: buildRoads(layout), refs: -1 };
  }
  releaseCanvas(BAKED.world);
  BAKED.layout = layout; BAKED.ppm = ppm; BAKED.world = bakeWorld(layout, ppm); BAKED.roads = buildRoads(layout); BAKED.refs = 1;
  return BAKED;
}
function releaseWorld(rec) {
  if (!rec) return;
  if (rec !== BAKED) { releaseCanvas(rec.world); rec.world = null; return; }
  BAKED.refs = Math.max(0, BAKED.refs - 1);
  if (!BAKED.refs) { releaseCanvas(BAKED.world); BAKED.world = null; BAKED.layout = null; BAKED.roads = null; }
}
function releaseCanvas(w) { if (w && w.canvas) { w.canvas.width = 1; w.canvas.height = 1; } }
// Дороги — один Path2D в метрах; trails — пунктирные тропы по плато от кромки арены к началу
// дорог (в данных дороги начинаются в 20–40 м от центра — без троп они «висят» вокруг арены).
function buildRoads(layout) {
  try {
    const roads = layout && Array.isArray(layout.roads) ? layout.roads : null;
    if (!roads || typeof Path2D === 'undefined') return null;
    const p = new Path2D(), tr = new Path2D();
    const A = layout.arena && Number.isFinite(layout.arena.x) && layout.arena.r > 0 ? layout.arena : null;
    let nT = 0;
    for (const pl of roads) {
      if (!Array.isArray(pl) || pl.length < 2) continue;
      for (let i = 0; i < pl.length; i++) { const q = pl[i]; if (!q || !Number.isFinite(q.x)) continue; if (i) p.lineTo(q.x, q.z); else p.moveTo(q.x, q.z); }
      if (!A) continue;
      for (const q of [pl[0], pl[pl.length - 1]]) {
        if (!q || !Number.isFinite(q.x)) continue;
        const dx = q.x - A.x, dz = q.z - A.z, d = Math.hypot(dx, dz);
        if (d < A.r + 4 || d > A.r + 36) continue;
        const r0 = A.r + 2.5;
        tr.moveTo(A.x + (dx / d) * r0, A.z + (dz / d) * r0); tr.lineTo(q.x, q.z); nT++;
      }
    }
    return { path: p, trails: nT ? tr : null };
  } catch (e) { return null; }
}

// ------------------------------------------------------------------ мини-карта
export function createMinimap({ canvas, rotate = false } = {}) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { draw() {}, dispose() {} };
  try { preloadFonts(); if (typeof document !== 'undefined' && document.fonts && document.fonts.load) document.fonts.load(`12px 'Forum'`).catch(() => {}); } catch (e) { /* ignore */ }

  const st = {
    layout: null, ppm: 0, rec: null, world: null, roads: null, failed: 0, bakeMs: 0,
    D: 0, dpr: 0, size: 0, spr: null, vign: null,
    labels: [], labelsDirty: true,
    viewR: 0, time: 0, lastNow: 0,
    dash: [0, 0],
    // подписи: выбор ближайших 3 зон без аллокаций
    selI: new Int16Array(3), selK: new Float32Array(3),
    box: new Float32Array(16),
  };
  const onFonts = () => { st.labelsDirty = true; };
  try { if (typeof document !== 'undefined' && document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', onFonts); } catch (e) { /* ignore */ }

  function ensureWorld(layout, quality) {
    const ppm = quality === 'low' ? 1.4 : quality === 'high' ? 2.4 : 1.8;
    if (st.layout === layout && st.ppm === ppm && (st.world || !layout || st.failed > 2)) return;
    st.layout = layout; st.ppm = ppm; st.labelsDirty = true;
    releaseWorld(st.rec);
    st.rec = null; st.world = null; st.roads = null;
    if (!layout) return;
    try {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      st.rec = acquireWorld(layout, ppm);
      st.world = st.rec.world; st.roads = st.rec.roads;
      st.bakeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    } catch (e) { st.rec = null; st.world = null; st.failed++; }
  }
  function ensureSize(size, dpr) {
    const D = Math.max(16, Math.round(size * dpr));
    if (canvas.width !== D || canvas.height !== D) { canvas.width = D; canvas.height = D; }
    try { if (canvas.style && !canvas.style.width) { canvas.style.width = `${size}px`; canvas.style.height = `${size}px`; } } catch (e) { /* ignore */ }
    if (st.D === D && st.dpr === dpr && st.spr) return;
    st.D = D; st.dpr = dpr; st.size = size; st.labelsDirty = true;
    const R = D / 2;
    st.spr = buildSprites(D, dpr, R);
    const vg = ctx.createRadialGradient(R, R, R * 0.58, R, R, R);
    vg.addColorStop(0, 'rgba(4,3,2,0)'); vg.addColorStop(0.75, 'rgba(4,3,2,0.22)'); vg.addColorStop(1, 'rgba(4,3,2,0.72)');
    st.vign = vg;
  }
  function ensureLabels() {
    if (!st.labelsDirty) return;
    st.labelsDirty = false;
    const L = (st.layout && st.layout.landmarks) || [];
    const px = Math.max(9.5, Math.min(13, st.size / 15));
    st.labels.length = 0;
    for (let i = 0; i < L.length; i++) {
      let c = null;
      try { c = L[i] && L[i].name ? buildLabel(L[i].name, px, st.dpr) : null; } catch (e) { c = null; }
      st.labels.push(c);
    }
  }

  // точка мира → экран (device px), в reusable-объект
  const P = { x: 0, y: 0, d: 0 };
  let cx = 0, cz = 0, kpx = 1, R0 = 1, rc = 1, rs = 0;
  function toScreen(x, z) {
    const dx = (x - cx) * kpx, dy = (z - cz) * kpx;
    P.x = R0 + dx * rc - dy * rs; P.y = R0 + dx * rs + dy * rc;
    P.d = Math.hypot(P.x - R0, P.y - R0);
    return P;
  }
  // метка: внутри — на месте; снаружи — на краю (если clampR>0)
  function blit(img, sz, x, y, ang, alpha, scale) {
    if (!img) return;
    const c = Math.cos(ang) * scale, s = Math.sin(ang) * scale;
    ctx.globalAlpha = alpha;
    ctx.setTransform(c, s, -s, c, x, y);
    ctx.drawImage(img, -sz / 2, -sz / 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawFrame(f, info) {
    const snap = f && f.snapshot;
    const settings = (f && f.settings) || {};
    const dpr = Math.max(1, Math.min(3, (info && info.dpr) || (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1));
    const size = Math.max(40, (info && info.size) || canvas.clientWidth || canvas.width / dpr || 170);
    ensureSize(size, dpr);
    ensureWorld(f && f.layout, settings.quality);
    ensureLabels();
    const D = st.D, S = st.spr, R = D / 2, rm = !!settings.reducedMotion;
    const pl = snap && snap.player;
    const pp = pl && pl.position;
    const px = pp && Number.isFinite(pp.x) ? pp.x : 0, pz = pp && Number.isFinite(pp.z) ? pp.z : 0;
    const yaw = pl && Number.isFinite(pl.yaw) ? pl.yaw : Math.PI;
    // время и масштаб
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let dt = f && Number.isFinite(f.dtReal) ? f.dtReal : (st.lastNow ? (now - st.lastNow) / 1000 : 0);
    st.lastNow = now;
    dt = dt < 0 ? 0 : dt > 0.25 ? 0.25 : dt;
    st.time += dt;
    const engaged = !!(pl && pl.encounter === 'engaged');
    const target = engaged ? VIEW_ENGAGED : VIEW_EXPLORE;
    if (!st.viewR) st.viewR = target;
    else st.viewR += (target - st.viewR) * (1 - Math.exp(-dt * (rm ? 8 : 3)));
    const viewR = st.viewR;
    cx = px; cz = pz; R0 = R; kpx = R / viewR;
    const mapRot = rotate ? yaw - Math.PI : 0;
    rc = Math.cos(mapRot); rs = Math.sin(mapRot);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, D, D);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 0.5, 0, TAU); ctx.clip();
    ctx.fillStyle = FOG;
    ctx.fillRect(0, 0, D, D);

    // --- статика: нужный фрагмент запечённой карты
    const W = st.world;
    if (W) {
      let sx = (cx - viewR - W.minX) * W.ppm, sy = (cz - viewR - W.minZ) * W.ppm, sw = viewR * 2 * W.ppm, sh = sw;
      let dx = 0, dy = 0, dw = D, dh = D;
      const q = dw / sw;
      if (sx < 0) { dx -= sx * q; dw += sx * q; sw += sx; sx = 0; }
      if (sy < 0) { dy -= sy * q; dh += sy * q; sh += sy; sy = 0; }
      if (sx + sw > W.W) { const cut = sx + sw - W.W; sw -= cut; dw -= cut * q; }
      if (sy + sh > W.H) { const cut = sy + sh - W.H; sh -= cut; dh -= cut * q; }
      if (sw > 0.5 && sh > 0.5 && dw > 0.5 && dh > 0.5) {
        if (mapRot) { ctx.translate(R, R); ctx.rotate(mapRot); ctx.translate(-R, -R); }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(W.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    } else {
      ctx.fillStyle = BDO.coal2;
      ctx.fillRect(0, 0, D, D);
    }

    const layout = f && f.layout;
    const L = (layout && layout.landmarks) || null;
    const u = S.u;
    // --- дороги: кэшированный Path2D в метрах, вид — через матрицу (чёткие при любом масштабе)
    if (st.roads) {
      const a = kpx * rc, b = kpx * rs, c = -kpx * rs, d = kpx * rc;
      ctx.setTransform(a, b, c, d, R0 - (a * cx + c * cz), R0 - (b * cx + d * cz));
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const wPx = Math.max(1.5 * dpr, Math.min(3.2 * dpr, 2.0 * kpx)), rp = st.roads.path;
      if (st.roads.trails) {
        st.dash[0] = (2.5 * dpr) / kpx; st.dash[1] = (3 * dpr) / kpx;
        ctx.setLineDash(st.dash);
        ctx.lineWidth = Math.max(1, 0.9 * dpr) / kpx; ctx.strokeStyle = 'rgba(208,190,150,0.34)'; ctx.stroke(st.roads.trails);
        ctx.setLineDash(EMPTY);
      }
      ctx.lineWidth = (wPx + 2.4 * dpr) / kpx; ctx.strokeStyle = 'rgba(8,6,4,0.62)'; ctx.stroke(rp);
      ctx.lineWidth = wPx / kpx; ctx.strokeStyle = 'rgba(208,190,150,0.82)'; ctx.stroke(rp);
      if (wPx > 2.2 * dpr) { ctx.lineWidth = (wPx * 0.3) / kpx; ctx.strokeStyle = 'rgba(248,236,204,0.35)'; ctx.stroke(rp); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // --- кромки зон: тонкий пунктир (вживую — чёткая линия при любом масштабе)
    if (L) {
      ctx.lineWidth = Math.max(1, 0.9 * dpr);
      st.dash[0] = 4 * dpr; st.dash[1] = 3.5 * dpr;
      ctx.setLineDash(st.dash);
      ctx.strokeStyle = 'rgba(216,179,106,0.34)';
      ctx.beginPath();
      for (let i = 0; i < L.length; i++) {
        const m = L[i];
        if (!m || !(m.r > 0) || m.id === 'arena') continue;
        const dd = Math.hypot(m.x - cx, m.z - cz);
        if (dd > viewR * 1.45 + m.r || dd < m.r - viewR * 1.45) continue;
        const p = toScreen(m.x, m.z);
        ctx.moveTo(p.x + m.r * kpx, p.y);
        ctx.arc(p.x, p.y, m.r * kpx, 0, TAU);
      }
      ctx.stroke();
      ctx.setLineDash(EMPTY);
    }
    // --- арена: круг с рунным кольцом
    const A = layout && layout.arena;
    if (A && Number.isFinite(A.x) && A.r > 0) {
      const dd = Math.hypot(A.x - cx, A.z - cz);
      if (dd < viewR * 1.45 + A.r + 4) {
        const p = toScreen(A.x, A.z), ar = A.r * kpx, ax = p.x, ay = p.y;
        ctx.fillStyle = engaged ? 'rgba(176,38,42,0.10)' : 'rgba(216,179,106,0.05)';
        ctx.beginPath(); ctx.arc(ax, ay, ar, 0, TAU); ctx.fill();
        ctx.lineWidth = Math.max(1, 1.2 * dpr);
        ctx.strokeStyle = engaged ? 'rgba(224,110,90,0.62)' : 'rgba(216,179,106,0.55)';
        ctx.beginPath(); ctx.arc(ax, ay, ar, 0, TAU); ctx.stroke();
        const ir = ar * 0.8;
        ctx.lineWidth = Math.max(0.8, 0.7 * dpr);
        ctx.strokeStyle = 'rgba(216,179,106,0.38)';
        ctx.beginPath(); ctx.arc(ax, ay, ir, 0, TAU);
        // рунные засечки между кольцами (24 шт., через одну — длинные)
        if (ar > 12 * dpr) {
          const n = 24;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU + (rm ? 0 : st.time * 0.05), ca = Math.cos(a), sa = Math.sin(a);
            const r1 = ir + (ar - ir) * 0.22, r2 = i % 2 ? ir + (ar - ir) * 0.55 : ir + (ar - ir) * 0.8;
            ctx.moveTo(ax + ca * r1, ay + sa * r1); ctx.lineTo(ax + ca * r2, ay + sa * r2);
          }
        }
        ctx.stroke();
        // четыре ромба по сторонам света
        ctx.fillStyle = 'rgba(243,220,160,0.7)';
        ctx.beginPath();
        const rr = (ar + ir) / 2, q = Math.max(1.5, (ar - ir) * 0.28);
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI / 2 + mapRot, ox = ax + Math.cos(a) * rr, oy = ay + Math.sin(a) * rr;
          ctx.moveTo(ox, oy - q); ctx.lineTo(ox + q * 0.7, oy); ctx.lineTo(ox, oy + q); ctx.lineTo(ox - q * 0.7, oy); ctx.closePath();
        }
        ctx.fill();
      }
    }

    // --- подписи ближайших 2–3 зон (Forum, пререндер)
    if (L && st.labels.length === L.length) {
      const selI = st.selI, selK = st.selK, maxLab = st.size < 160 ? 2 : 3;
      let nSel = 0;
      for (let i = 0; i < L.length; i++) {
        const m = L[i];
        if (!m || !st.labels[i]) continue;
        const dd = Math.hypot(m.x - cx, m.z - cz), r = m.r > 0 ? m.r : 1;
        if (dd > viewR + r) continue;
        const key = dd <= r ? dd / r - 2 : dd - r;
        if (nSel < maxLab) { selI[nSel] = i; selK[nSel] = key; nSel++; }
        else {
          let w = 0; for (let j = 1; j < maxLab; j++) if (selK[j] > selK[w]) w = j;
          if (key < selK[w]) { selI[w] = i; selK[w] = key; }
        }
      }
      // порядок: ближние первыми
      for (let a = 0; a < nSel; a++) for (let b = a + 1; b < nSel; b++) if (selK[b] < selK[a]) { const ti = selI[a]; selI[a] = selI[b]; selI[b] = ti; const tk = selK[a]; selK[a] = selK[b]; selK[b] = tk; }
      const box = st.box;
      let nBox = 0;
      const hb = 11 * u;                           // «окно» вокруг героя
      box[0] = R - hb; box[1] = R - hb; box[2] = R + hb; box[3] = R + hb; nBox = 1;
      const Rm = R - 5 * dpr;
      for (let s = 0; s < nSel; s++) {
        const i = selI[s], m = L[i], img = st.labels[i];
        const hw = img.width / 2, hh = img.height / 2;
        const p = toScreen(m.x, m.z);
        let lx = p.x - R, ly = p.y - R;
        if (m.id === 'arena' && A) ly -= Math.max(A.r * kpx, S.bossSz * 0.36) + hh + 2 * dpr;   // над рунным кольцом и маской босса
        // вписать прямоугольник подписи в круг, сдвигая к центру
        const aa = lx * lx + ly * ly, bb = 2 * (Math.abs(lx) * hw + Math.abs(ly) * hh), cc = hw * hw + hh * hh - Rm * Rm;
        if (cc >= 0) continue;
        if (aa > 1e-6 && (Math.abs(lx) + hw) ** 2 + (Math.abs(ly) + hh) ** 2 > Rm * Rm) {
          const t = (-bb + Math.sqrt(bb * bb - 4 * aa * cc)) / (2 * aa);
          lx *= t; ly *= t;
        }
        let x0 = R + lx - hw, y0 = R + ly - hh;
        // не налезать на героя и на уже поставленные подписи
        let ok = true;
        for (let k = 0; k < nBox && ok; k++) {
          const o = k * 4;
          if (x0 < box[o + 2] && x0 + hw * 2 > box[o] && y0 < box[o + 3] && y0 + hh * 2 > box[o + 1]) {
            if (k === 0 && box[3] + 1 + hh * 2 < R + Rm * 0.86) { y0 = box[3] + 1; k = -1; continue; }   // под героя
            ok = false;
          }
        }
        if (!ok || nBox >= 4) continue;
        const o = nBox * 4; box[o] = x0; box[o + 1] = y0; box[o + 2] = x0 + hw * 2; box[o + 3] = y0 + hh * 2; nBox++;
        ctx.globalAlpha = selK[s] < -1 ? 0.95 : 0.72;
        ctx.drawImage(img, Math.round(x0), Math.round(y0));
      }
      ctx.globalAlpha = 1;
    }

    // --- угли клятвы: все (зажжённые — тусклые), незажжённые — янтарные с мерцанием
    const unlit = f && Array.isArray(f.pois) ? f.pois : null;
    const allP = layout && Array.isArray(layout.pois) ? layout.pois : null;
    const edgeR = R - 9 * u;
    if (allP) {
      for (let i = 0; i < allP.length; i++) {
        const e = allP[i];
        if (!e || !Number.isFinite(e.x)) continue;
        let isUnlit = false;
        if (unlit) for (let j = 0; j < unlit.length; j++) if (unlit[j] === e || (unlit[j] && unlit[j].id === e.id)) { isUnlit = true; break; }
        if (isUnlit) continue;
        const p = toScreen(e.x, e.z);
        if (p.d < R - 4 * u) blit(S.lit, S.litSz, p.x, p.y, 0, 0.9, 1);
      }
    }
    if (unlit) {
      let nearD = Infinity, nearX = 0, nearY = 0;
      for (let i = 0; i < unlit.length; i++) {
        const e = unlit[i];
        if (!e || !Number.isFinite(e.x)) continue;
        const p = toScreen(e.x, e.z);
        if (p.d < R - 6 * u) {
          const ph = i * 1.7;
          const fl = rm ? 1 : 0.82 + 0.18 * Math.sin(st.time * 3.1 + ph) * Math.sin(st.time * 1.3 + ph * 0.5 + 1);
          blit(S.ember, S.emberSz, p.x, p.y, 0, fl, rm ? 1 : 0.94 + 0.08 * fl);
          nearD = -1;
        } else if (nearD >= 0 && p.d < nearD) { nearD = p.d; nearX = p.x; nearY = p.y; }
      }
      if (nearD > 0 && nearD < Infinity) {
        const dx = nearX - R, dy = nearY - R, l = nearD || 1;
        const ang = Math.atan2(dx, -dy);
        const pulse = rm ? 0 : Math.sin(st.time * 2.4) * 1.5 * u;
        blit(S.chev, S.chevSz, R + (dx / l) * (edgeR + pulse), R + (dy / l) * (edgeR + pulse), ang, 0.95, 1);
      }
    }

    // --- босс: красная маска (жив); вне радиуса — на краю
    const pvp = snap && snap.mode === 'pvp';
    const boss = snap && snap.boss;
    if (!pvp && boss && boss.position && boss.hp > 0 && boss.action !== 'dead') {
      const p = toScreen(boss.position.x, boss.position.z);
      if (p.d <= R - 8 * u) blit(S.boss, S.bossSz, p.x, p.y, 0, 1, 1);
      else { const l = p.d || 1; blit(S.boss, S.bossSz, R + ((p.x - R) / l) * (R - 9 * u), R + ((p.y - R) / l) * (R - 9 * u), 0, 0.8, 0.72); }
    }
    // --- соперник PvP: красная стрелка по его yaw
    const opp = snap && snap.opponent;
    if (opp && opp.position && Number.isFinite(opp.position.x) && !(opp.hp <= 0)) {
      const p = toScreen(opp.position.x, opp.position.z);
      const ang = (Number.isFinite(opp.yaw) ? Math.PI - opp.yaw : 0) + mapRot;
      if (p.d <= R - 8 * u) blit(S.opp, S.oppSz, p.x, p.y, ang, 1, 1);
      else { const l = p.d || 1; blit(S.opp, S.oppSz, R + ((p.x - R) / l) * (R - 9 * u), R + ((p.y - R) / l) * (R - 9 * u), ang, 0.8, 0.8); }
    }
    // --- герой: конус взгляда + золотая стрелка в центре
    const hAng = Math.PI - yaw + mapRot;
    blit(S.cone, S.coneSz, R, R, hAng, engaged ? 0.6 : 1, 1);
    blit(S.hero, S.heroSz, R, R, hAng, 1, 1);
    ctx.globalAlpha = 1;

    // --- внутренняя кромка: виньетка + тонкий золотой кант
    ctx.fillStyle = st.vign;
    ctx.fillRect(0, 0, D, D);
    ctx.restore();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath(); ctx.arc(R, R, R - 0.5 * dpr, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(216,179,106,0.30)';
    ctx.beginPath(); ctx.arc(R, R, R - 2.5 * dpr, 0, TAU); ctx.stroke();
    // засечки сторон света и метка севера
    ctx.strokeStyle = 'rgba(216,179,106,0.45)';
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const a = i * Math.PI / 2 - Math.PI / 2 + mapRot, ca = Math.cos(a), sa = Math.sin(a);
      ctx.moveTo(R + ca * (R - 3 * dpr), R + sa * (R - 3 * dpr)); ctx.lineTo(R + ca * (R - 7 * dpr), R + sa * (R - 7 * dpr));
    }
    ctx.stroke();
    const na = -Math.PI / 2 + mapRot;
    blit(S.north, S.northSz, R + Math.cos(na) * (R - 7 * u), R + Math.sin(na) * (R - 7 * u), mapRot, 1, 1);
    ctx.globalAlpha = 1;
  }

  return {
    draw(f, info) {
      try { drawFrame(f, info); }
      catch (e) {
        st.failed++;
        try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash(EMPTY); ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e2) { /* ignore */ }
      }
    },
    /** Для стендов/отладки: время запекания, размер offscreen. */
    stats() { return { bakeMs: st.bakeMs, world: st.world ? `${st.world.W}x${st.world.H}` : null, viewR: st.viewR }; },
    dispose() {
      try { if (typeof document !== 'undefined' && document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', onFonts); } catch (e) { /* ignore */ }
      releaseWorld(st.rec);
      st.rec = null; st.world = null; st.roads = null; st.spr = null; st.labels.length = 0; st.layout = null;
    },
  };
}
const EMPTY = Object.freeze([]);
