// ASHEN OATH — modules/fx/glyph.js. Владелец: №7 [VFX].
// Круги сотворения (в духе BDO) + атлас рун.
//  - RUNE_STROKES: канонические символы — ломаные в 0..1 (y вниз); общий источник для атласа,
//    рисования в воздухе и распознавания жестов;
//  - runeStroke(id): путь символа, ровно передискретизированный (~64 точки) — для анимации «рисования»;
//  - createGlyphs(deps): пул кругов (≤10, на low ≤5). ВСЕ круги — ОДИН draw call: InstancedBufferGeometry
//    (квад на круг, атрибуты экземпляра пишутся плотно каждый кадр), один ShaderMaterial (аддитив, premul).
//    Символ в центре — из атласа SDF (DataTexture 512×256 RGBA: R — расстояние, G — параметр пути
//    для «письма», B — расстояние до узлов-углов), атлас строится один раз при создании (~10–20 мс).
//    Узоры колец (руны-футарк, пунктир, спицы, октаграмма/гексаграмма, римские цифры) — процедурно в шейдере.
// Координаты — мировые метры (как у root без трансформации), Y вверх.

import { FX_OUT, FX_RIVAL, FX_NOISE, premulBlend, hexLin, ELEMENTS } from './glsl.js';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const POOL_MAX = 10;                               // размер буферов экземпляров
const CAPS = { low: 5, medium: 8, high: 10 };      // активных кругов по качеству
const GQ = { low: 0, medium: 1, high: 2 };         // ветка шейдера
const EXT = 1.12;                                  // квад шире круга — место под ореол
const CELL = 64, GX = 8, GY = 4, AW = CELL * GX, AH = CELL * GY;
const MARGIN = 0.12;                               // поле ячейки атласа (доля)
const DMAX = 0.13;                                 // макс. кодируемое расстояние (доли ячейки; ореол символа ≤ 0.114)
const STYLE = { rune: 0, clock: 1, hex: 2, sigil: 3 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ------------------------------------------------------------------ символы

const q3 = (v) => Math.round(v * 1000) / 1000;
function curve(n, f) { const o = []; for (let i = 0; i <= n; i++) { const p = f(i / n); o.push([q3(p[0]), q3(p[1])]); } return o; }
function arc(cx, cy, r, a0, a1, n) { return curve(n, (t) => { const a = (a0 + (a1 - a0) * t) * D2R; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }); }
const mirrorX = (pl) => pl.map((p) => [q3(1 - p[0]), p[1]]);
function deepFreeze(o) { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; }

function makeStrokes() {
  const pv = (k) => { const a = (-90 + 72 * k) * D2R; return [q3(0.5 + 0.5 * Math.cos(a)), q3(0.53 + 0.5 * Math.sin(a))]; };
  // полумесяц «)»: внешняя дуга + внутренняя, замкнуто на рогах
  const cres = [...arc(0.05, 0.5, 0.38, -60, 60, 16), ...arc(-0.4006, 0.5, 0.7206, 27.25, -27.25, 10)];
  // снежинка: 3 оси + «галочки» на 6 лучах
  const frost = [];
  for (let k = 0; k < 3; k++) {
    const a = k * 60 * D2R, dx = Math.sin(a) * 0.46, dy = -Math.cos(a) * 0.46;
    frost.push([[q3(0.5 - dx), q3(0.5 - dy)], [q3(0.5 + dx), q3(0.5 + dy)]]);
  }
  for (let k = 0; k < 6; k++) {
    const a = k * 60 * D2R, ux = Math.sin(a), uy = -Math.cos(a), px = -uy, py = ux;
    const mx = 0.5 + ux * 0.27, my = 0.5 + uy * 0.27, l = 0.13 * 0.7071;
    frost.push([[q3(mx + (ux + px) * l), q3(my + (uy + py) * l)], [q3(mx), q3(my)], [q3(mx + (ux - px) * l), q3(my + (uy - py) * l)]]);
  }
  const cloud = [
    ...arc(0.3, 0.42, 0.16, 170, 290, 8), ...arc(0.56, 0.34, 0.2, 215, 345, 10), ...arc(0.78, 0.46, 0.13, 280, 440, 8),
    [0.3, 0.588], ...arc(0.3, 0.42, 0.16, 90, 170, 5),
  ];
  return {
    ignis: [[[0.5, 0.06], [0.96, 0.9], [0.04, 0.9], [0.5, 0.06]]],
    fulgur: [[[0.66, 0.0], [0.26, 0.54], [0.74, 0.46], [0.34, 1.0]]],
    orbis: [curve(48, (t) => [0.5 - 0.5 * Math.sin(t * TAU), 0.5 - 0.5 * Math.cos(t * TAU)])],
    stella: [[pv(3), pv(0), pv(2), pv(4), pv(1), pv(3)]],
    spira: [curve(96, (t) => [0.5 + 0.5 * t * Math.cos(t * 2 * TAU), 0.5 + 0.5 * t * Math.sin(t * 2 * TAU)])],
    lemnis: [curve(64, (t) => [0.5 + 0.5 * Math.cos(t * TAU), 0.5 + 0.25 * Math.sin(2 * t * TAU)])],
    caret: [[[0.06, 0.84], [0.5, 0.16], [0.94, 0.84]]],
    vee: [[[0.06, 0.16], [0.5, 0.84], [0.94, 0.16]]],
    clepsydra: [[[0, 0], [1, 0], [0, 1], [1, 1], [0, 0]]],
    // ℓ-петля над «шевроном»: вверх-вправо, петля через верх, вниз-вправо (линии пересекаются под петлёй)
    alpha: [[[0.1, 1.0], ...arc(0.5, 0.25, 0.177, 47.3, -227.3, 28), [0.9, 1.0]]],
    clap: [cres, mirrorX(cres),
      [[0.5, 0.06], [0.5, 0.24]], [[0.5, 0.76], [0.5, 0.94]],
      [[0.37, 0.14], [0.44, 0.3]], [[0.63, 0.14], [0.56, 0.3]], [[0.37, 0.86], [0.44, 0.7]], [[0.63, 0.86], [0.56, 0.7]]],
    gate: [[[0.0, 0.08], [0.2, 0.16], [0.8, 0.16], [1.0, 0.08]], [[0.1, 0.34], [0.9, 0.34]],
      [[0.25, 0.16], [0.21, 1.0]], [[0.75, 0.16], [0.79, 1.0]], [[0.5, 0.16], [0.5, 0.34]]],
    frame: [[[0, 0.3], [0, 0], [0.3, 0]], [[0.7, 0], [1, 0], [1, 0.3]], [[1, 0.7], [1, 1], [0.7, 1]], [[0.3, 1], [0, 1], [0, 0.7]]],
    delta: [[[0.5, 0.02], [0.98, 0.9], [0.02, 0.9], [0.5, 0.02]], [[0.5, 0.4], [0.73, 0.78], [0.27, 0.78], [0.5, 0.4]]],
    cor: [curve(64, (t) => {
      const s = t * TAU, x = 16 * Math.pow(Math.sin(s), 3);
      const y = 13 * Math.cos(s) - 5 * Math.cos(2 * s) - 2 * Math.cos(3 * s) - Math.cos(4 * s);
      return [0.5 + x / 33, 0.5 - (y + 2.5) / 33];
    })],
    // стихии: алхимические знаки
    fire: [[[0.5, 0.04], [0.96, 0.92], [0.04, 0.92], [0.5, 0.04]],
      curve(28, (t) => { const s = t * TAU; return [0.5 + 0.15 * Math.sin(s) * Math.sin(s / 2), 0.62 - 0.22 * Math.cos(s)]; })],
    storm: [cloud, [[0.55, 0.62], [0.41, 0.8], [0.6, 0.78], [0.45, 1.0]]],
    frost,
    earth: [[[0.04, 0.08], [0.96, 0.08], [0.5, 0.92], [0.04, 0.08]], [[0.1, 0.38], [0.9, 0.38]]],
    bow: [arc(0.64, 0.5, 0.46, 110, 250, 16), [[0.483, 0.068], [0.72, 0.5], [0.483, 0.932]],
      [[0.86, 0.5], [0.04, 0.5]], [[0.14, 0.41], [0.04, 0.5], [0.14, 0.59]],
      [[0.76, 0.5], [0.84, 0.42]], [[0.76, 0.5], [0.84, 0.58]], [[0.82, 0.5], [0.9, 0.42]], [[0.82, 0.5], [0.9, 0.58]]],
  };
}

export const RUNE_STROKES = deepFreeze(makeStrokes());
const RUNE_IDS = Object.freeze(Object.keys(RUNE_STROKES));     // порядок = номер ячейки атласа
const RUNE_INDEX = Object.freeze(Object.fromEntries(RUNE_IDS.map((k, i) => [k, i])));
const symIndex = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(RUNE_INDEX, id) ? RUNE_INDEX[id] : -1);

function polyLen(pl) { let s = 0; for (let i = 1; i < pl.length; i++) s += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]); return s; }

// Точки ломаной, ровно по длине (включая концы).
function samplePoly(pl, cnt, k, out) {
  const L = polyLen(pl);
  if (cnt < 2 || L <= 1e-9) { out.push({ x: pl[0][0], y: pl[0][1], k }); return; }
  let seg = 0, segStart = 0;
  for (let j = 0; j < cnt; j++) {
    const s = (L * j) / (cnt - 1);
    while (seg < pl.length - 2) {
      const sl = Math.hypot(pl[seg + 1][0] - pl[seg][0], pl[seg + 1][1] - pl[seg][1]);
      if (segStart + sl >= s) break;
      segStart += sl; seg++;
    }
    const a = pl[seg], b = pl[seg + 1], sl = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = sl > 1e-9 ? clamp01((s - segStart) / sl) : 0;
    out.push({ x: q3(a[0] + (b[0] - a[0]) * t), y: q3(a[1] + (b[1] - a[1]) * t), k });
  }
}

// Путь символа в порядке рисования: [{x, y, k}] (k — номер штриха; между штрихами «перо поднято»).
export function runeStroke(id, n) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(RUNE_STROKES, id)) return null;
  const pls = RUNE_STROKES[id];
  const N = clamp(Math.round(num(n, 64)), 8, 512);
  const lens = pls.map(polyLen);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const counts = lens.map((l) => Math.max(2, Math.round((N * l) / total)));
  const diff = N - counts.reduce((a, b) => a + b, 0);
  let bi = 0; for (let i = 1; i < counts.length; i++) if (lens[i] > lens[bi]) bi = i;
  counts[bi] = Math.max(2, counts[bi] + diff);
  const out = [];
  for (let k = 0; k < pls.length; k++) samplePoly(pls[k], counts[k], k, out);
  return out;
}

// ------------------------------------------------------------------ атлас SDF

function buildAtlasData() {
  const data = new Uint8Array(AW * AH * 4);
  data.fill(255);                                   // пустые ячейки: «далеко»
  const dist = new Float32Array(CELL * CELL), par = new Float32Array(CELL * CELL), nod = new Float32Array(CELL * CELL);
  const sc = 1 - 2 * MARGIN;
  const rasterSeg = (ax, ay, bx, by, s0, s1) => {
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - DMAX) * CELL)), x1 = Math.min(CELL - 1, Math.ceil((Math.max(ax, bx) + DMAX) * CELL));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by) - DMAX) * CELL)), y1 = Math.min(CELL - 1, Math.ceil((Math.max(ay, by) + DMAX) * CELL));
    const ex = bx - ax, ey = by - ay, ee = ex * ex + ey * ey || 1e-12;
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) / CELL;
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) / CELL;
        let t = ((px - ax) * ex + (py - ay) * ey) / ee; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - ax - ex * t, dy = py - ay - ey * t, d2 = dx * dx + dy * dy;
        const i = y * CELL + x;
        if (d2 < dist[i]) { dist[i] = d2; par[i] = s0 + (s1 - s0) * t; }
      }
    }
  };
  const rasterNode = (nx, ny) => {
    const x0 = Math.max(0, Math.floor((nx - DMAX) * CELL)), x1 = Math.min(CELL - 1, Math.ceil((nx + DMAX) * CELL));
    const y0 = Math.max(0, Math.floor((ny - DMAX) * CELL)), y1 = Math.min(CELL - 1, Math.ceil((ny + DMAX) * CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) / CELL - nx, dy = (y + 0.5) / CELL - ny, d2 = dx * dx + dy * dy, i = y * CELL + x;
      if (d2 < nod[i]) nod[i] = d2;
    }
  };
  const cosCorner = Math.cos(40 * D2R);
  for (let idx = 0; idx < RUNE_IDS.length && idx < GX * GY; idx++) {
    const pls = RUNE_STROKES[RUNE_IDS[idx]];
    dist.fill(DMAX * DMAX); nod.fill(DMAX * DMAX); par.fill(0);   // квадраты расстояний
    const total = pls.reduce((a, pl) => a + polyLen(pl), 0) || 1;
    let acc = 0;
    for (const pl of pls) {
      const m = pl.length;
      for (let i = 0; i + 1 < m; i++) {
        const l = Math.hypot(pl[i + 1][0] - pl[i][0], pl[i + 1][1] - pl[i][1]);
        rasterSeg(MARGIN + pl[i][0] * sc, MARGIN + pl[i][1] * sc, MARGIN + pl[i + 1][0] * sc, MARGIN + pl[i + 1][1] * sc, acc / total, (acc + l) / total);
        acc += l;
      }
      // узлы: концы незамкнутых штрихов и острые углы
      const closed = m > 2 && Math.hypot(pl[0][0] - pl[m - 1][0], pl[0][1] - pl[m - 1][1]) < 1e-3;
      for (let i = 0; i < m; i++) {
        let isNode = false;
        if (!closed && (i === 0 || i === m - 1)) isNode = true;
        else if (!(closed && i === m - 1)) {
          const pa = pl[i === 0 ? m - 2 : i - 1], pb = pl[i === m - 1 ? 1 : i + 1], p = pl[i];
          const ax = p[0] - pa[0], ay = p[1] - pa[1], bx = pb[0] - p[0], by = pb[1] - p[1];
          const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
          if (la > 1e-6 && lb > 1e-6 && (ax * bx + ay * by) / (la * lb) < cosCorner) isNode = true;
        }
        if (isNode) rasterNode(MARGIN + pl[i][0] * sc, MARGIN + pl[i][1] * sc);
      }
    }
    const cx = (idx % GX) * CELL, cy = Math.floor(idx / GX) * CELL;
    const kd = 255 / DMAX;
    for (let y = 0; y < CELL; y++) {
      let i = y * CELL, o = ((cy + y) * AW + cx) * 4;
      for (let x = 0; x < CELL; x++, i++, o += 4) {
        data[o] = Math.min(255, Math.sqrt(dist[i]) * kd + 0.5);      // Uint8Array сам отбросит дробь
        data[o + 1] = par[i] * 255 + 0.5;
        data[o + 2] = Math.min(255, Math.sqrt(nod[i]) * kd + 0.5);
      }
    }
  }
  return data;
}

// ------------------------------------------------------------------ шейдеры

const VS = /* glsl */`
#define EXT ${EXT.toFixed(3)}
attribute vec3 iPos;
attribute vec3 iU;
attribute vec3 iV;
attribute vec4 iCol;
attribute vec4 iHot;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
varying vec2 vP;
varying vec4 vCol;
varying vec4 vHot;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
void main() {
  vP = position.xy * EXT;
  vCol = iCol; vHot = iHot; vA = iA; vB = iB; vC = iC; vD = iD;
  vec3 w = iPos + (iU * position.x + iV * position.y) * EXT;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

// vP — координаты в радиусах круга; углы — по часовой от «верха» (оси V).
// vCol: rgb линий, w rival | vHot: rgb ядра, w flare | vA: x развёртка 0..1, y появление, z угол вращения, w стрелки
// vB: x стиль, y колец, z рун, w seed | vC: x ячейка символа (-1 нет), y symbolScale, z «письмо» 0..1, w symbolGlow
// vD: x яркость, y возраст (с), z «на земле», w затухание 1..0
const FS = /* glsl */`
#define TAU 6.2831853
#define PI 3.14159265
#define EXT ${EXT.toFixed(3)}
#define MARGIN ${MARGIN.toFixed(3)}
#define DMAX ${DMAX.toFixed(3)}
#define GXF ${GX.toFixed(1)}
#define GYF ${GY.toFixed(1)}
#define HTX ${(0.5 / CELL).toFixed(5)}
uniform sampler2D uAtlas;
varying vec2 vP;
varying vec4 vCol;
varying vec4 vHot;
varying vec4 vA;
varying vec4 vB;
varying vec4 vC;
varying vec4 vD;
${FX_RIVAL}
${FX_NOISE}
float PX, PR;
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
// тонкая линия полуширины w с AA; тоньше пикселя — тускнеет, а не мерцает
float ln(float d, float w) { float ww = max(w, PX * 0.5); return clamp((ww - d) / PX + 0.5, 0.0, 1.0) * (w / ww); }
float halo(float d, float w) { return w * w / (d * d + w * w); }
// кольцо: AA по радиальной производной — на наклонном круге (земля) линии остаются тонкими по всей окружности
float ring(float r, float c, float w) { float ww = max(w, PR * 0.5); return clamp((ww - abs(r - c)) / PR + 0.5, 0.0, 1.0) * (w / ww); }
float sweep(float a, float pr) { return pr >= 1.0 ? 1.0 : clamp((pr - a) / 0.006 + 0.5, 0.0, 1.0); }
float ticksR(float r, float a, float r0, float r1, float n, float w) {
  if (r < r0 || r > r1) return 0.0;
  return ln(abs(fract(a * n) - 0.5) * TAU * r / n, w);
}
float dots(float r, float a, float rc, float n, float w) { float u = fract(a * n) - 0.5; return ln(length(vec2(u * TAU * r / n, r - rc)), w); }
// рёбра правильного n-угольника, вписанного в R (вершина на угле rot)
float polyD(float r, float ac, float n, float R, float rot) {
  float sec = TAU / n; float af = mod(ac - rot - sec * 0.5, sec) - sec * 0.5;
  return abs(r * cos(af) - R * cos(PI / n));
}
float nodeD(float r, float ac, float n, float R, float rot) {
  float sec = TAU / n; float af = mod(ac - rot + sec * 0.5, sec) - sec * 0.5;
  return length(vec2(r * sin(af), r * cos(af) - R));
}
#define SG(ax, ay, bx, by) sdSeg(p, (vec2(ax, ay) - 0.5) * S, (vec2(bx, by) - 0.5) * S)
// процедурная руна (футарк) в ячейке k; p — метрически от центра знака, S — размер знака
float runeD(vec2 p, vec2 S, float k) {
  float h1 = fxH1(k * 1.37 + vB.w), h2 = fxH1(k * 2.71 + vB.w + 5.0);
  float fam = floor(h2 * 7.0);
  float d = h1 < 0.8 ? SG(0.5, 0.0, 0.5, 1.0) : 1e3;
  if (fam < 1.0)      d = min(d, min(SG(0.5, 1.0, 0.92, 0.74), SG(0.5, 0.7, 0.92, 0.44)));
  else if (fam < 2.0) d = min(d, min(SG(0.5, 1.0, 0.1, 0.66), SG(0.5, 1.0, 0.9, 0.66)));
  else if (fam < 3.0) d = min(d, min(SG(0.5, 0.92, 0.9, 0.7), SG(0.9, 0.7, 0.5, 0.46)));
  else if (fam < 4.0) d = min(d, min(SG(0.12, 0.1, 0.88, 0.9), SG(0.12, 0.9, 0.88, 0.1)));
  else if (fam < 5.0) d = min(d, min(SG(0.5, 0.45, 0.1, 0.85), SG(0.5, 0.45, 0.9, 0.85)));
  else if (fam < 6.0) d = min(d, SG(0.15, 0.72, 0.85, 0.28));
  else d = min(d, min(min(SG(0.5, 0.0, 0.88, 0.5), SG(0.88, 0.5, 0.5, 1.0)), min(SG(0.5, 1.0, 0.12, 0.5), SG(0.12, 0.5, 0.5, 0.0))));
#if GQ > 0
  if (fxH1(k * 4.13 + vB.w + 11.0) < 0.35) d = min(d, SG(0.5, 0.1, 0.84, 0.3));
#endif
  return d;
}
// лента рун между r0 и r1; a — угол 0..1 с учётом вращения; n — число знаков
float runeBand(float r, float a, float r0, float r1, float n, out float g) {
  g = 0.0;
  if (r < r0 || r > r1) return 0.0;
  float seg = a * n, k = floor(seg), u = fract(seg);
  float cw = TAU * r / n, h = r1 - r0;
  vec2 S = vec2(min(cw * 0.55, h * 0.52), h * 0.72);
  vec2 p = vec2((u - 0.5) * cw, r - (r0 + r1) * 0.5);
  float w = S.y * 0.06;
#if GQ > 0
  float d = runeD(p, S, k);
#else
  float d = SG(0.5, 0.0, 0.5, 1.0);
#endif
  float dd = length(vec2((0.5 - abs(u - 0.5)) * cw, p.y));
  g = halo(d, w * 3.0);
  return ln(d, w) + ln(dd, w * 1.2) * 0.8;
}
// римские цифры циферблата: k 0..11 (0 = XII)
float romanCode(float k, out float n) {
  n = 2.0;
  if (k < 0.5) { n = 3.0; return 23.0; }
  if (k < 1.5) { n = 1.0; return 1.0; }
  if (k < 2.5) return 5.0;
  if (k < 3.5) { n = 3.0; return 21.0; }
  if (k < 4.5) return 9.0;
  if (k < 5.5) { n = 1.0; return 2.0; }
  if (k < 6.5) return 6.0;
  if (k < 7.5) { n = 3.0; return 22.0; }
  if (k < 8.5) { n = 4.0; return 86.0; }
  if (k < 9.5) return 13.0;
  if (k < 10.5) { n = 1.0; return 3.0; }
  return 7.0;
}
float romanD(vec2 pp, float k, float cw, float ch) {
  float n; float code = romanCode(k, n);
  float W = n * cw;
  float xi = clamp(floor((pp.x + W * 0.5) / cw), 0.0, n - 1.0);
  float c = mod(floor(code / exp2(2.0 * xi) + 0.001), 4.0);
  vec2 p = vec2(pp.x + W * 0.5 - (xi + 0.5) * cw, pp.y);
  vec2 S = vec2(cw, ch);
  float d;
  if (c < 1.5) d = SG(0.5, 0.0, 0.5, 1.0);
  else if (c < 2.5) d = min(SG(0.12, 1.0, 0.5, 0.0), SG(0.88, 1.0, 0.5, 0.0));
  else d = min(SG(0.12, 0.0, 0.88, 1.0), SG(0.12, 1.0, 0.88, 0.0));
  float bx = max(abs(pp.x) - W * 0.5 - cw * 0.08, 0.0);
  return min(d, length(vec2(bx, abs(abs(pp.y) - ch * 0.5))));
}
// стрелка: sd, ось по углу ang (по часовой от верха), сужается от w0 к w1
float handSD(vec2 p, float ang, float len, float tail, float w0, float w1) {
  float s = sin(ang), c = cos(ang);
  vec2 q = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  float w = mix(w0, w1, clamp((q.y + tail) / (len + tail), 0.0, 1.0));
  return max(abs(q.x) - w, max(-tail - q.y, q.y - len));
}

void styleRune(float r, float ac, float a01, float rv0, float rv1, float rv2, inout float L, inout float H, inout float G) {
  float spin = vA.z, rings = vB.y, n = vB.z;
  float o1 = ring(r, 0.985, 0.0042), o2 = ring(r, 0.952, 0.0024);
  float fine = ticksR(r, fract(a01 - spin * 0.03 + 1.0), 0.959, 0.978, n * 4.0, 0.0012);
  L += (o1 + o2 * 0.75 + fine * 0.55) * rv0;
  H += o1 * 0.55 * rv0;
  G += (halo(abs(r - 0.985), 0.016) * 0.13 + halo(abs(r - 0.952), 0.008) * 0.05) * rv0;
  float rg; float ru = runeBand(r, fract(a01 - spin / TAU + 1.0), 0.80, 0.935, n, rg);
  float bandFill = 0.018 * step(0.80, r) * step(r, 0.935);
  L += (ru * 0.95 + bandFill) * rv1; H += ru * 0.35 * rv1; G += rg * 0.1 * rv1;
  L += (ring(r, 0.79, 0.0032) + dots(r, fract(a01 + spin * 0.08 + 1.0), 0.757, n * 3.0, 0.0042) * 0.8) * rv2;
  if (rings > 1.5) {
    float aM = fract(a01 + spin * 1.3 / TAU + 1.0);
    float tk = ticksR(r, aM, 0.605, 0.642, 72.0, 0.0014) * 0.6 + ticksR(r, aM, 0.585, 0.69, 12.0, 0.0028);
    L += (ring(r, 0.60, 0.003) + tk) * rv2;
    float rot = spin * 0.35;
    float sq = min(polyD(r, ac, 4.0, 0.757, rot), polyD(r, ac, 4.0, 0.757, rot + TAU / 8.0));
    float inside = step(r, 0.76);
    L += ln(sq, 0.0028) * 0.9 * inside * rv2; H += ln(sq, 0.001) * 0.3 * inside * rv2;
    G += halo(sq, 0.012) * 0.06 * inside * rv2;
    if (rings > 2.5) {
      L += ring(r, 0.50, 0.0024) * 0.8 * rv2;
      float nd = nodeD(r, ac, 8.0, 0.757, rot);
      L += ln(abs(nd - 0.03), 0.0025) * rv2; H += ln(nd, 0.011) * 1.3 * rv2; G += halo(nd, 0.03) * 0.14 * rv2;
    }
  } else {
    L += ring(r, 0.56, 0.0025) * 0.7 * rv2;
  }
}

void styleClock(vec2 p, float r, float ac, float a01, float rv0, float rv1, float rv2, inout float L, inout float H, inout float G) {
  float spin = vA.z, rings = vB.y;
  float o1 = ring(r, 0.985, 0.0055), o2 = ring(r, 0.955, 0.0026);
  L += (o1 + o2 * 0.8) * rv0; H += o1 * 0.6 * rv0;
  G += halo(abs(r - 0.985), 0.016) * 0.13 * rv0;
  float mt = ticksR(r, a01, 0.905, 0.948, 60.0, 0.0018);
  float hm = ticksR(r, a01, 0.868, 0.948, 12.0, 0.0048);
  L += (mt * 0.7 + hm) * rv0; H += hm * 0.5 * rv0;
  float aH = a01 * 12.0, k = floor(aH + 0.5);
  float rd = romanD(vec2((aH - k) * TAU * r / 12.0, r - 0.785), mod(k, 12.0), 0.036, 0.085);
  L += ln(rd, 0.0042) * rv1; H += ln(rd, 0.0015) * 0.6 * rv1; G += halo(rd, 0.012) * 0.08 * rv1;
  L += (ring(r, 0.715, 0.003) + dots(r, a01, 0.688, 60.0, 0.0042) * 0.7) * rv2;
  if (rings > 1.5) {
    float aG = fract(a01 + spin / TAU + 1.0);
    L += (ring(r, 0.43, 0.0035) + ticksR(r, aG, 0.432, 0.475, 30.0, 0.011) * 0.4 + ticksR(r, aG, 0.432, 0.475, 30.0, 0.0022) * 0.6 + ring(r, 0.395, 0.002) * 0.7) * rv2;
  }
  if (rings > 2.5) {
    L += (dots(r, fract(a01 - spin * 0.11 + 1.0), 0.58, 36.0, 0.006) + ring(r, 0.615, 0.0022) * 0.6) * rv2;
  }
  float hands = vA.w;
  float hd = min(handSD(p, hands, 0.8, 0.12, 0.011, 0.0025), handSD(p, hands / 12.0, 0.54, 0.09, 0.02, 0.005));
  L += clamp(0.5 - hd / PX, 0.0, 1.0) * rv2;
  H += clamp(0.5 - (hd + 0.0045) / PX, 0.0, 1.0) * 1.2 * rv2;
  G += halo(max(hd, 0.0), 0.018) * 0.2 * rv2;
  L += ring(r, 0.05, 0.004) * rv2; H += ln(r, 0.022) * 1.5 * rv2;
}

void styleHex(float r, float ac, float a01, float rv0, float rv1, float rv2, inout float L, inout float H, inout float G) {
  float spin = vA.z, rings = vB.y;
  float o1 = ring(r, 0.985, 0.0042), o2 = ring(r, 0.955, 0.0022);
  L += (o1 + o2 * 0.75) * rv0; H += o1 * 0.5 * rv0; G += halo(abs(r - 0.985), 0.016) * 0.13 * rv0;
  float rg; float ru = runeBand(r, fract(a01 - spin / TAU + 1.0), 0.872, 0.948, floor(vB.z * 1.5), rg);
  L += ru * 0.85 * rv1; H += ru * 0.25 * rv1; G += rg * 0.08 * rv1;
  L += ring(r, 0.866, 0.0028) * rv1;
  float rot = spin * 0.4, R = 0.82;
  float tri = min(polyD(r, ac, 3.0, R, rot), polyD(r, ac, 3.0, R, rot + TAU / 6.0));
  float hx = polyD(r, ac, 6.0, R, rot);
  float inside = step(r, R + 0.006);
  L += (ln(tri, 0.0034) + ln(hx, 0.0018) * 0.55) * inside * rv2;
  H += ln(tri, 0.0012) * 0.5 * inside * rv2; G += halo(tri, 0.012) * 0.07 * inside * rv2;
  L += (ring(r, R, 0.0022) * 0.6 + ring(r, 0.41, 0.003)) * rv2;
  float nd = nodeD(r, ac, 6.0, R, rot);
  L += ln(abs(nd - 0.045), 0.0028) * rv2; H += ln(nd, 0.014) * 1.3 * rv2; G += halo(nd, 0.035) * 0.16 * rv2;
  if (rings > 1.5) L += dots(r, fract(a01 + spin * 0.2 + 1.0), 0.62, 48.0, 0.004) * 0.8 * rv2;
  if (rings > 2.5) L += (ring(r, 0.30, 0.002) * 0.7 + ln(polyD(r, ac, 6.0, 0.41, rot + TAU / 12.0), 0.0016) * step(r, 0.412) * 0.5) * rv2;
}

void styleSigil(float r, float ac, float a01, float rv0, float rv1, float rv2, inout float L, inout float H, inout float G) {
  float spin = vA.z, rings = vB.y;
  float band = smoothstep(0.893 - PX, 0.893 + PX, r) * (1.0 - smoothstep(0.99 - PX, 0.99 + PX, r));
  float e1 = ring(r, 0.99, 0.0055), e2 = ring(r, 0.893, 0.0045);
  float rg; float ru = runeBand(r, fract(a01 - spin / TAU + 1.0), 0.905, 0.978, vB.z, rg);
  L += (band * 0.24 + e1 + e2 * 0.9) * rv0; H += e1 * 0.5 * rv0;
  H += ru * 1.1 * rv1; G += (rg * 0.1 + halo(abs(r - 0.94), 0.05) * 0.06) * rv0;
  L += (ring(r, 0.855, 0.0028) + dots(r, fract(a01 + spin * 0.1 + 1.0), 0.825, vB.z * 2.0, 0.0045) * 0.8) * rv1;
  float R = 0.80;
  float td = polyD(r, ac, 3.0, R, 0.0), inside = step(r, R + 0.01);
  L += ln(td, 0.009) * inside * rv2; H += ln(td, 0.0035) * 1.1 * inside * rv2; G += halo(td, 0.025) * 0.15 * inside * rv2;
  float nd = nodeD(r, ac, 3.0, R, 0.0);
  L += ln(abs(nd - 0.06), 0.004) * rv2; H += ln(nd, 0.02) * 1.4 * rv2; G += halo(nd, 0.05) * 0.2 * rv2;
  L += ring(r, 0.40, 0.003) * rv2;
  if (rings > 1.5) L += ticksR(r, fract(a01 - spin * 0.15 + 1.0), 0.36, 0.392, 36.0, 0.0016) * 0.8 * rv2;
  if (rings > 2.5) L += (ring(r, 0.70, 0.002) * 0.6 + ln(polyD(r, ac, 3.0, R, PI / 3.0), 0.002) * inside * 0.45) * rv2;
}

void symbolLayer(vec2 p, float r, inout float L, inout float H, inout float G) {
  float side = max(vC.y, 0.05) * 1.3;
  vec2 q = vec2(p.x / side + 0.5, 0.5 - p.y / side);
  vec2 cuv = MARGIN + q * (1.0 - 2.0 * MARGIN);
  G += 0.035 * (1.0 - smoothstep(0.0, side * 0.75, r)) * vC.w;  // тёплое «дыхание» под знаком
  if (cuv.x <= 0.0 || cuv.x >= 1.0 || cuv.y <= 0.0 || cuv.y >= 1.0) return;
  vec2 cell = vec2(mod(vC.x, GXF), floor(vC.x / GXF + 0.001));
  vec4 t = texture2D(uAtlas, (cell + clamp(cuv, HTX, 1.0 - HTX)) / vec2(GXF, GYF));
  float k = side / (1.0 - 2.0 * MARGIN) * DMAX;
  float d = t.r * k, par = t.g, nd = t.b * k;
  float W = vC.z, sg = vC.w;
  float vis = W >= 0.999 ? 1.0 : 1.0 - smoothstep(W - 0.012, W + 0.004, par);
  float body = ln(d, side * 0.03), core = ln(d, side * 0.011);
  float x = 1.0 - clamp(d / (side * 0.15), 0.0, 1.0), glow = x * x * x;
  float node = ln(nd, side * 0.042);
  float pen = W < 0.999 ? (1.0 - smoothstep(0.0, 0.04, abs(par - W))) * step(0.001, W) : 0.0;
  L += (body * 0.85 + glow * 0.35) * vis * sg;
  H += (core * 1.5 + node * 1.2 + glow * 0.12) * vis * sg + pen * (body * 2.0 + glow * 0.7);
}

void main() {
  vec2 p = vP;
  float r = length(p);
  if (r > EXT) discard;
  PX = max(length(fwidth(p)), 1e-5);
  PR = max(fwidth(r), 1e-5);
  float U = vA.x;
  float ac = atan(p.x, p.y);
  float a01 = fract(ac / TAU + 1.0);
  float pr0 = clamp(U * 1.5, 0.0, 1.0), pr1 = clamp(U * 1.5 - 0.22, 0.0, 1.0), pr2 = clamp(U * 1.5 - 0.42, 0.0, 1.0);
  float rv0 = sweep(a01, pr0), rv1 = sweep(1.0 - a01, pr1), rv2 = sweep(a01, pr2);
  float L = 0.0, H = 0.0, G = 0.0;
  float st = vB.x;
  if (st < 0.5) styleRune(r, ac, a01, rv0, rv1, rv2, L, H, G);
  else if (st < 1.5) styleClock(p, r, ac, a01, rv0, rv1, rv2, L, H, G);
  else if (st < 2.5) styleHex(r, ac, a01, rv0, rv1, rv2, L, H, G);
  else styleSigil(r, ac, a01, rv0, rv1, rv2, L, H, G);
  if (vC.x > -0.5) symbolLayer(p, r, L, H, G);
  float age = vD.y;
  // бегущие по внешнему кольцу импульсы
  float o = ring(r, 0.985, 0.006);
  H += o * pow(0.5 + 0.5 * sin(ac * 3.0 - age * 3.5), 10.0) * 1.1 * rv0;
  // фронт развёртки — «комета» по внешнему кольцу
  if (pr0 > 0.0 && pr0 < 1.0) {
    float fa = pr0 * TAU;
    H += halo(length(p - vec2(sin(fa), cos(fa)) * 0.985), 0.02) * 1.6;
    H += (a01 < pr0 ? 1.0 - clamp((pr0 - a01) / 0.2, 0.0, 1.0) : 0.0) * o * 1.6;
  }
  // дымка диска (на земле — сильнее: «свет» на полу) и мягкий ореол за кромкой
  float haze = (0.008 + 0.012 * vD.z) * (1.0 - smoothstep(0.35, 1.0, r)) * pr0;
#if GQ > 1
  haze *= 0.5 + 0.9 * fxNoise2(p * 4.0 + vec2(age * 0.35, -age * 0.25) + vB.w);
  L *= 0.86 + 0.14 * sin(ac * 5.0 - age * 2.3) * sin(ac * 2.0 + age * 1.1);
#endif
  G += haze + halo(max(r - 0.985, 0.0), 0.04) * 0.035 * step(0.985, r) * pr0;
  float fk = vD.w, m = fk, edge = 0.0;
#if GQ > 0
  if (fk < 0.999) {  // линии распадаются на тлеющие дуги; дымка просто гаснет
    float nz = fxNoise2(p * 6.0 + vB.w * 3.1) * 0.75 + fxNoise2(p * 17.0 - vB.w) * 0.25;
    float th = (1.0 - fk) * 1.1 - 0.05;
    float keep = smoothstep(th, th + 0.08, nz);
    edge = keep * (1.0 - smoothstep(th + 0.01, th + 0.1, nz));
    m = keep * (0.35 + 0.65 * fk);
  }
#endif
  vec3 deep = vCol.rgb * vCol.rgb + vCol.rgb * 0.1;          // ореол — насыщеннее и глубже линии
  vec3 col = (vCol.rgb * L + vHot.rgb * H) * m + deep * G * fk + vHot.rgb * (L + H) * edge * 1.6;
  col *= vD.x * (1.0 + vHot.w * 1.8) * vA.y;
  col = fxRival(col, vCol.w);
  gl_FragColor = vec4(col, 0.0);
${FX_OUT}
}
`;

// ------------------------------------------------------------------ модуль

export function createGlyphs(deps) {
  const d = deps || {};
  const THREE = d.THREE;
  if (!THREE) throw new Error('createGlyphs: нужен deps.THREE');
  const root = d.root || null;
  const camera = d.camera || null;

  let quality = 'high', cap = CAPS.high, orderSeq = 0, spawnSeq = 0;
  const t0 = nowMs();
  const tex = new THREE.DataTexture(buildAtlasData(), AW, AH, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
  const atlasMs = nowMs() - t0;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (name, size) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(POOL_MAX * size), size);
    a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a;
  };
  const aPos = mk('iPos', 3), aU = mk('iU', 3), aV = mk('iV', 3);
  const aCol = mk('iCol', 4), aHot = mk('iHot', 4), aA = mk('iA', 4), aB = mk('iB', 4), aC = mk('iC', 4), aD = mk('iD', 4);
  const ATTRS = [aPos, aU, aV, aCol, aHot, aA, aB, aC, aD];
  geo.instanceCount = 0;

  const mat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: tex } },
    vertexShader: VS, fragmentShader: FS,
    defines: { GQ: GQ.high },
    side: THREE.DoubleSide, depthTest: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    ...premulBlend(THREE),
  });
  mat.depthWrite = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-glyphs'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false; mesh.renderOrder = 3; mesh.visible = false;
  if (root && typeof root.add === 'function') root.add(mesh);

  // --- пул кругов (объект слота = handle)
  const slots = [];
  const tmpUp = [0, 1, 0];
  function setBasis(s, n, up) {
    let nx = n.x, ny = n.y, nz = n.z, l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-6)) { nx = 0; ny = 1; nz = 0; l = 1; }
    nx /= l; ny /= l; nz /= l;
    // «верх» круга: заданный up → верх камеры → мировой верх, спроецированный на плоскость
    let hx, hy, hz;
    if (up) { hx = up.x; hy = up.y; hz = up.z; }
    else if (camera && camera.matrixWorld) { const e = camera.matrixWorld.elements; hx = e[4]; hy = e[5]; hz = e[6]; }
    else { hx = tmpUp[0]; hy = tmpUp[1]; hz = tmpUp[2]; }
    let k = hx * nx + hy * ny + hz * nz, vx = hx - nx * k, vy = hy - ny * k, vz = hz - nz * k, vl = Math.hypot(vx, vy, vz);
    if (vl < 1e-3) { hx = 0; hy = 0; hz = -1; if (Math.abs(nz) > 0.9) { hx = 0; hy = 1; hz = 0; } k = hx * nx + hy * ny + hz * nz; vx = hx - nx * k; vy = hy - ny * k; vz = hz - nz * k; vl = Math.hypot(vx, vy, vz) || 1; }
    vx /= vl; vy /= vl; vz /= vl;
    s.nx = nx; s.ny = ny; s.nz = nz; s.vx = vx; s.vy = vy; s.vz = vz;
    s.ux = vy * nz - vz * ny; s.uy = vz * nx - vx * nz; s.uz = vx * ny - vy * nx;   // U = V × N
  }
  function makeSlot(i) {
    const s = {
      alive: false, gen: 0, i,
      px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: -1,
      radius: 1.2, symScale: 0.55, sym: -1, style: 0, rings: 2, ticks: 24, col: [1, 1, 1], hot: [1, 1, 1],
      intensity: 1.6, dur: 1.6, unfold: 0.35, fade: 0.35, spin: 0.6, rival: 0, follow: null, billboard: false, lift: 0,
      age: 0, ang: 0, fl: 0, fadeStart: 0, fadeLen: 0, fadeFrom: 1, hands: 0, handsSet: false, symGlow: 1, seed: 0, order: 0, writeT0: 0, up: null,
    };
    s.set = (o) => {
      if (!s.alive || !o || typeof o !== 'object') return s;
      try {
        if (hasVec(o.pos)) { s.px = o.pos.x; s.py = o.pos.y; s.pz = o.pos.z; }
        if (isNum(o.radius) && o.radius > 0) s.radius = clamp(o.radius, 0.02, 60);
        if (isNum(o.intensity)) s.intensity = clamp(o.intensity, 0, 30);
        if (isNum(o.hands)) { s.hands = o.hands; s.handsSet = true; }
        if (isNum(o.symbolGlow)) s.symGlow = clamp(o.symbolGlow, 0, 10);
        if (isNum(o.color)) hexLin(o.color & 0xffffff, s.col);
        if (isNum(o.hot)) hexLin(o.hot & 0xffffff, s.hot);
        if (isNum(o.rival)) s.rival = clamp01(o.rival);
        if (isNum(o.spin)) s.spin = clamp(o.spin, -40, 40);
        if (hasVec(o.normal)) setBasis(s, o.normal, hasVec(o.up) ? o.up : s.up);
        if (o.symbol !== undefined) { const si = symIndex(o.symbol); if (si !== s.sym) { s.sym = si; s.writeT0 = s.age; } }
      } catch (e) { /* no-op */ }
      return s;
    };
    s.flare = (amount) => { if (s.alive) s.fl = Math.max(s.fl, clamp01(num(amount, 1))); return s; };
    s.fadeOut = (sec) => {
      if (!s.alive) return s;
      const len = clamp(num(sec, s.fade), 0.01, 30);
      s.fadeFrom = fadeK(s); s.fadeStart = s.age; s.fadeLen = len;
      return s;
    };
    s.kill = () => { if (s.alive) release(s); return s; };
    return s;
  }
  for (let i = 0; i < POOL_MAX; i++) slots.push(makeSlot(i));

  function fadeK(s) {
    let k = 1;
    if (s.dur !== Infinity) k = Math.min(k, (s.dur - s.age) / s.fade);
    if (s.fadeLen > 0) k = Math.min(k, s.fadeFrom * (1 - (s.age - s.fadeStart) / s.fadeLen));
    return k;
  }
  function release(s) { s.alive = false; s.follow = null; s.gen++; }
  function activeCount() { let n = 0; for (let i = 0; i < POOL_MAX; i++) if (slots[i].alive) n++; return n; }
  function takeSlot() {
    let free = null, oldest = null, n = 0;
    for (let i = 0; i < POOL_MAX; i++) {
      const s = slots[i];
      if (!s.alive) { if (!free || s.order < free.order) free = s; continue; }  // давно освобождённый — первым
      n++;
      const finite = s.dur !== Infinity || s.fadeLen > 0;
      if (finite && (!oldest || s.order < oldest.order)) oldest = s;
    }
    if (free && n < cap) return free;
    if (oldest) { release(oldest); return oldest; }
    return null;
  }

  function spawn(opts) {
    try {
      const o = opts || {};
      if (!hasVec(o.pos)) return null;
      const s = takeSlot();
      if (!s) return null;
      s.alive = true; s.order = ++orderSeq; s.gen++;
      s.px = o.pos.x; s.py = o.pos.y; s.pz = o.pos.z;
      s.billboard = !!o.billboard;
      s.up = hasVec(o.up) ? { x: o.up.x, y: o.up.y, z: o.up.z } : null;
      setBasis(s, hasVec(o.normal) ? o.normal : { x: 0, y: 1, z: 0 }, s.up);
      s.radius = clamp(num(o.radius, 1.2), 0.02, 60);
      s.sym = o.symbol == null ? -1 : symIndex(o.symbol);
      s.symScale = clamp(num(o.symbolScale, 0.55), 0.05, 1);
      hexLin((isNum(o.color) ? o.color : ELEMENTS.gold.mid) & 0xffffff, s.col);
      hexLin((isNum(o.hot) ? o.hot : ELEMENTS.gold.hot) & 0xffffff, s.hot);
      s.intensity = Math.min(2.4, clamp(num(o.intensity, 1.6), 0, 30) * 0.85); // [VFX] калибровка под bloom игры
      s.dur = o.dur === Infinity ? Infinity : Math.max(0.05, num(o.dur, 1.6));
      s.unfold = clamp(num(o.unfold, 0.35), 0, 10);
      s.fade = clamp(num(o.fade, 0.35), 0.01, 10);
      s.spin = clamp(num(o.spin, 0.6), -40, 40);
      s.rings = clamp(Math.round(num(o.rings, 2)), 1, 3);
      s.ticks = clamp(Math.round(num(o.ticks, 24)), 6, 64);
      s.style = typeof o.style === 'string' && Object.prototype.hasOwnProperty.call(STYLE, o.style) ? STYLE[o.style] : 0;
      s.rival = clamp01(num(o.rival, 0));
      s.follow = typeof o.follow === 'function' ? o.follow : null;
      s.lift = Math.abs(s.ny) > 0.7 ? clamp(num(o.lift, 0.015), 0, 1) : clamp(num(o.lift, 0), 0, 1);
      s.age = 0; s.ang = 0; s.fl = 0; s.fadeStart = 0; s.fadeLen = 0; s.fadeFrom = 1; s.writeT0 = 0;
      s.hands = num(o.hands, 0); s.handsSet = isNum(o.hands); s.symGlow = clamp(num(o.symbolGlow, 1), 0, 10);
      s.seed = ((++spawnSeq * 7.31) % 61) + 0.37;
      return s;
    } catch (e) { return null; }
  }

  function writeSlot(s, j) {
    const u = s.unfold > 0 ? clamp01(s.age / s.unfold) : 1;
    const fk = clamp01(fadeK(s));
    const sc = (0.6 + 0.4 * easeOutCubic(u)) * (1 + 0.08 * (1 - fk)) * (1 + 0.05 * s.fl) * s.radius;
    const wr = s.sym >= 0 ? clamp01((s.age - s.writeT0 - s.unfold * 0.3) / Math.max(0.2, s.unfold * 1.15)) : 0;
    const j3 = j * 3, j4 = j * 4;
    let a = aPos.array; a[j3] = s.px + s.nx * s.lift; a[j3 + 1] = s.py + s.ny * s.lift; a[j3 + 2] = s.pz + s.nz * s.lift;
    a = aU.array; a[j3] = s.ux * sc; a[j3 + 1] = s.uy * sc; a[j3 + 2] = s.uz * sc;
    a = aV.array; a[j3] = s.vx * sc; a[j3 + 1] = s.vy * sc; a[j3 + 2] = s.vz * sc;
    a = aCol.array; a[j4] = s.col[0]; a[j4 + 1] = s.col[1]; a[j4 + 2] = s.col[2]; a[j4 + 3] = s.rival;
    a = aHot.array; a[j4] = s.hot[0]; a[j4 + 1] = s.hot[1]; a[j4 + 2] = s.hot[2]; a[j4 + 3] = s.fl;
    a = aA.array; a[j4] = u; a[j4 + 1] = Math.min(1, s.age / 0.05); a[j4 + 2] = s.ang; a[j4 + 3] = s.handsSet ? s.hands : s.age * 1.2;
    a = aB.array; a[j4] = s.style; a[j4 + 1] = quality === 'low' ? Math.min(2, s.rings) : s.rings; a[j4 + 2] = s.ticks; a[j4 + 3] = s.seed;
    a = aC.array; a[j4] = s.sym; a[j4 + 1] = s.symScale; a[j4 + 2] = wr; a[j4 + 3] = s.symGlow;
    a = aD.array; a[j4] = s.intensity; a[j4 + 1] = s.age; a[j4 + 2] = Math.abs(s.ny) > 0.7 ? 1 : 0; a[j4 + 3] = fk;
  }

  function update(dt, clock) {
    try {
      const h = isNum(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
      let n = 0;
      for (let i = 0; i < POOL_MAX; i++) {
        const s = slots[i];
        if (!s.alive) continue;
        s.age += h;
        if (fadeK(s) <= 0) { release(s); continue; }
        if (s.follow) {
          try { const p = s.follow(); if (hasVec(p)) { s.px = p.x; s.py = p.y; s.pz = p.z; } } catch (e) { /* no-op */ }
        }
        if (s.billboard && camera && camera.matrixWorld) {
          const e = camera.matrixWorld.elements;
          s.nx = e[8]; s.ny = e[9]; s.nz = e[10]; s.vx = e[4]; s.vy = e[5]; s.vz = e[6]; s.ux = e[0]; s.uy = e[1]; s.uz = e[2];
        }
        s.ang += s.spin * h;
        if (s.ang > 1e4 || s.ang < -1e4) s.ang %= TAU;
        s.fl *= Math.exp(-h * 11);
        if (s.fl < 1e-3) s.fl = 0;
        writeSlot(s, n++);
      }
      geo.instanceCount = n;
      mesh.visible = n > 0;
      if (n > 0) for (let k = 0; k < ATTRS.length; k++) {
        const at = ATTRS[k];
        if (at.clearUpdateRanges) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); }
        at.needsUpdate = true;
      }
    } catch (e) { /* эффекты не роняют кадр */ }
  }

  function setQuality(name) {
    const q = Object.prototype.hasOwnProperty.call(CAPS, name) ? name : 'high';
    if (q === quality) return;
    quality = q; cap = CAPS[q];
    mat.defines.GQ = GQ[q]; mat.needsUpdate = true;
    while (activeCount() > cap) {
      let oldest = null;
      for (let i = 0; i < POOL_MAX; i++) { const s = slots[i]; if (s.alive && (!oldest || s.order < oldest.order)) oldest = s; }
      if (!oldest) break;
      release(oldest);
    }
  }

  function clear() { for (let i = 0; i < POOL_MAX; i++) if (slots[i].alive) release(slots[i]); geo.instanceCount = 0; mesh.visible = false; }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose(); mat.dispose(); tex.dispose();
  }

  function stats() { const a = activeCount(); return { active: a, drawCalls: a > 0 ? 1 : 0, cap, quality, atlasMs: Math.round(atlasMs * 10) / 10 }; }

  return { spawn, update, setQuality, clear, dispose, stats, mesh, symbols: RUNE_IDS };
}
