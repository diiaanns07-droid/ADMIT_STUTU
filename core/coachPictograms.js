// ASHEN OATH — пиктограммы режима «ОШИБКА» (твист хакатона): «как сейчас → как надо» для каждой подсказки.
// Чистый модуль: без DOM и импортов, только строки SVG. Слева красная фигура (как сейчас), в центре
// золотая стрелка, справа зелёная (как надо); место ошибки обведено красным пунктиром.
// Фигуры строятся из параметрических моделей, а не рисуются по одной:
//   кисть — 21 точка как у MediaPipe (раскладка dev/handSynth.mjs: сгиб пальцев, большой палец, поворот
//   ладони, наклон), спроецированная в 2D как в зеркальном превью: левая рука игрока слева, у правой
//   ладонью к камере большой палец слева; пальцы — толстые скруглённые штрихи, ладонь — многоугольник;
//   тело — толстый «палочник» (спереди и сбоку); руны — путь штриха.
// SVG без id, <style>, ссылок и foreignObject — рисуется и в DOM, и на canvas через Image из data: URL.
// Обрезка кадром — вложенный <svg> (он обрезает содержимое по своим границам без clipPath и id).
//
// pictogramSvg(id, { width = 168, height = 72, labels = true, only = null | 'good' | 'bad' }) → '<svg …>' или ''.
// id: код COACH_HINTS (core/gestureCoach.js); 'squat_' + код SQUAT_HINTS; 'pushup_' + код PUSHUP_FAULTS;
// иконки жестов тренажёра 'g_ok', 'g_shield', … — одна зелёная фигура (с only:'bad' — та же красная).

const BAD = '#ff5a4a', GOOD = '#5fd28a', GOLD = '#c9a45c', INK = '#0d1016', MUTE = '#8f98aa';
const DEG = Math.PI / 180;
const CW = 64, CH = 56;              // ячейка одной фигуры (единицы рисунка)

// ───────── числа и пути: 1 знак после запятой, относительные координаты — строка короче ─────────
const r1 = (v) => Math.round(v * 10) / 10;
function f1(v) { const s = String(r1(v)); return s === '-0' ? '0' : s.replace(/^(-?)0\./, '$1.'); }
function nums(a) { let s = ''; for (let i = 0; i < a.length; i++) { const t = f1(a[i]); s += i && t[0] !== '-' ? ' ' + t : t; } return s; }
function pth(pts, closed) {
  let x0 = r1(pts[0][0]), y0 = r1(pts[0][1]);
  let d = 'M' + nums([x0, y0]);
  if (pts.length > 1) {
    const rel = [];
    for (let i = 1; i < pts.length; i++) { const x = r1(pts[i][0]), y = r1(pts[i][1]); rel.push(x - x0, y - y0); x0 = x; y0 = y; }
    d += 'l' + nums(rel);
  }
  return closed ? d + 'z' : d;
}
// дуга окружности как ломаная (центр, радиус, углы в градусах; 0° — вправо, 90° — вниз)
function arcPts(cx, cy, r, a0, a1, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + ((a1 - a0) * i) / n) * DEG; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}
const lerp2 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

// ───────── холст одной фигуры ─────────
// D.c — цвет фигуры, D.bad — фигура «как сейчас». Каждая деталь рисуется дважды: тёмная обводка, затем
// цвет — так согнутые пальцы, большой палец и конечности отделены от ладони и корпуса тонкой тёмной линией.
function canvas(color, bad) {
  const o = [];
  const D = {
    c: color, bad, o,
    put(s) { o.push(s); },
    group(attrs, fn) { o.push(`<g ${attrs}>`); fn(); o.push('</g>'); },
    // толстый штрих или залитый контур с обводкой
    part(d, w, opt = {}) {
      const col = opt.color || D.c;
      const ow = w + Math.min(2.2, 0.5 * w + 0.6);
      if (opt.fill) {
        o.push(`<path d="${d}" fill="${INK}" stroke="${INK}" stroke-width="${f1(ow)}"/>`);
        o.push(`<path d="${d}" fill="${col}" stroke="${col}" stroke-width="${f1(w)}"/>`);
      } else {
        o.push(`<path d="${d}" stroke="${INK}" stroke-width="${f1(ow)}"/>`);
        o.push(`<path d="${d}" stroke="${col}" stroke-width="${f1(w)}"/>`);
      }
    },
    line(pts, w, opt) { D.part(pth(pts, opt && opt.closed), w, opt); },
    // тонкая линия без обводки (ориентиры, пунктир, следы движения)
    thin(pts, w, opt = {}) {
      const a = [`d="${pth(pts, opt.closed)}"`, `stroke="${opt.color || D.c}"`, `stroke-width="${f1(w)}"`];
      if (opt.dash) a.push(`stroke-dasharray="${opt.dash}"`);
      if (opt.op != null) a.push(`opacity="${opt.op}"`);
      o.push(`<path ${a.join(' ')}/>`);
    },
    disc(x, y, r, opt = {}) {
      const col = opt.color || D.c;
      if (!opt.noOutline) o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r + 1.1)}" fill="${INK}"/>`);
      o.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="${col}"${opt.op != null ? ` opacity="${opt.op}"` : ''}/>`);
    },
    ring(x, y, r, w, opt = {}) {
      const a = [`cx="${f1(x)}"`, `cy="${f1(y)}"`, `r="${f1(r)}"`, `stroke="${opt.color || D.c}"`, `stroke-width="${f1(w)}"`];
      if (opt.dash) a.push(`stroke-dasharray="${opt.dash}"`);
      if (opt.op != null) a.push(`opacity="${opt.op}"`);
      o.push(`<circle ${a.join(' ')}/>`);
    },
  };
  return D;
}

// место ошибки: у «сейчас» — красный пунктирный кружок, у «надо» — сплошной зелёный (то же место)
function focus(D, x, y, r) {
  D.ring(x, y, r, 3.2, { color: INK, op: 0.75 });
  D.ring(x, y, r, 1.6, D.bad ? { dash: '2.6 1.8' } : {});
}
// стрелка с треугольным наконечником (по умолчанию цвет фигуры)
function arrow(D, x1, y1, x2, y2, opt = {}) {
  const w = opt.w || 2.4, hl = opt.head || w * 2.2, col = opt.color || D.c;
  const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
  const bx = x2 - ux * hl, by = y2 - uy * hl, hw = hl * 0.62;
  const head = [[x2, y2], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]];
  if (opt.dash) {
    D.thin([[x1, y1], [bx, by]], w, { dash: opt.dash, color: col });
    D.put(`<path d="${pth(head, true)}" fill="${col}" stroke="${col}" stroke-width="1"/>`);
  } else {
    D.part(pth([[x1, y1], [bx + ux * 0.6, by + uy * 0.6]]), w, { color: col });
    D.part(pth(head, true), 0.8, { color: col, fill: true });
  }
}
// дуговая стрелка (поворот)
function arcArrow(D, cx, cy, r, a0, a1, opt = {}) {
  const pts = arcPts(cx, cy, r, a0, a1, 8);
  const w = opt.w || 2;
  D.thin(pts.slice(0, -1), w, { color: opt.color });
  const p = pts[pts.length - 2], q = pts[pts.length - 1];
  arrow(D, p[0], p[1], q[0] + (q[0] - p[0]) * 0.6, q[1] + (q[1] - p[1]) * 0.6, { w, head: w * 2.3, color: opt.color });
}
// линии скорости: n штрихов позади движения (направление ang — куда движется)
function speedLines(D, x, y, ang, len, n = 3, gap = 4, opt = {}) {
  const ux = Math.cos(ang * DEG), uy = Math.sin(ang * DEG), px = -uy, py = ux;
  for (let i = 0; i < n; i++) {
    const k = i - (n - 1) / 2, l = len * (1 - Math.abs(k) * 0.25);
    const sx = x + px * k * gap, sy = y + py * k * gap;
    D.thin([[sx, sy], [sx - ux * l, sy - uy * l]], opt.w || 2, { op: opt.op ?? 0.9 });
  }
}
// «медленно»: редкий пунктир из точек
function slowDots(D, x, y, ang, n = 3, step = 4.5) {
  const ux = Math.cos(ang * DEG), uy = Math.sin(ang * DEG);
  for (let i = 1; i <= n; i++) D.disc(x - ux * step * i, y - uy * step * i, 1.3 - i * 0.15, { noOutline: true, op: 1 - i * 0.2 });
}
// толчок к камере: концентрические дуги по бокам
function pushArcs(D, x, y, r, n = 3, opt = {}) {
  for (let i = 0; i < n; i++) {
    const rr = r + i * (opt.step || 4.2), op = 1 - i * 0.22, w = (opt.w || 2.2) - i * 0.3;
    D.thin(arcPts(x, y, rr, -35, 35, 6), w, { op });
    D.thin(arcPts(x, y, rr, 145, 215, 6), w, { op });
  }
}
// всплеск: лучи вокруг точки
function rays(D, x, y, r0, r1, n, a0 = -90, span = 360, w = 2) {
  for (let i = 0; i < n; i++) {
    const a = (a0 + (span === 360 ? (360 / n) * i : (span / Math.max(1, n - 1)) * i - span / 2)) * DEG;
    D.thin([[x + Math.cos(a) * r0, y + Math.sin(a) * r0], [x + Math.cos(a) * r1, y + Math.sin(a) * r1]], w);
  }
}
// рамка кадра: тонкий прямоугольник + уголки видоискателя
function frameBox(D, x, y, w, h) {
  D.thin([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], 1, { closed: true, color: MUTE, op: 0.55 });
  const k = 7;
  for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) {
    D.thin([[cx, cy + sy * k], [cx, cy], [cx + sx * k, cy]], 2, { color: MUTE });
  }
}
// часы (подконтрольный темп)
function clock(D, x, y, r) {
  D.disc(x, y, r, { color: INK, noOutline: true });
  D.ring(x, y, r, 1.8);
  D.thin([[x, y - r * 0.6], [x, y], [x + r * 0.45, y + r * 0.25]], 1.6);
}
// песочные часы (слишком долго)
function hourglass(D, x, y, h) {
  const w = h * 0.62;
  D.part(pth([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x - w / 2, y + h / 2], [x + w / 2, y + h / 2]], true), 1.6);
  D.put(`<path d="${pth([[x - w * 0.28, y + h * 0.42], [x + w * 0.28, y + h * 0.42], [x, y + h * 0.12]], true)}" fill="${D.c}"/>`);
}
// точка «замри» в конце штриха
function freeze(D, x, y) {
  D.ring(x, y, 5.6, 1.4, { op: 0.75 });
  D.disc(x, y, 2.6);
}
// огненный сгусток
function flame(D, x, y, s, op = 1) {
  const p = [[x, y - s * 1.35], [x + s * 0.55, y - s * 0.55], [x + s * 0.85, y + s * 0.15], [x + s * 0.5, y + s * 0.8], [x, y + s], [x - s * 0.5, y + s * 0.8], [x - s * 0.85, y + s * 0.15], [x - s * 0.55, y - s * 0.55]];
  D.put(`<g opacity="${op}">`);
  D.part(pth(p, true), 1.4, { fill: true });
  D.put(`<path d="${pth([[x, y - s * 0.35], [x + s * 0.35, y + s * 0.25], [x, y + s * 0.6], [x - s * 0.35, y + s * 0.25]], true)}" fill="${INK}" opacity=".45"/>`);
  D.put('</g>');
}
// сфера между ладонями
function orb(D, x, y, r, solid = true) {
  if (solid) { D.disc(x, y, r + 3, { noOutline: true, op: 0.18 }); D.disc(x, y, r, { op: 0.9 }); D.disc(x - r * 0.3, y - r * 0.3, r * 0.3, { color: INK, noOutline: true, op: 0.35 }); }
  else D.ring(x, y, r, 1.6, { dash: '2.4 2', op: 0.8 });
}

// ───────── модель кисти (раскладка dev/handSynth.mjs) ─────────
// Локальные координаты: ладонь в z=0, пальцы вдоль +y, сгиб — к −z (к зрителю, если ладонь к камере).
// Базовая раскладка — ПРАВАЯ кисть ладонью к зрителю в зеркальном превью (большой палец слева, −x).
const MCP = [[-0.034, 0.088], [-0.012, 0.094], [0.01, 0.089], [0.03, 0.078]];
const SEG = [[0.043, 0.025, 0.021], [0.047, 0.029, 0.022], [0.044, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [70, 95, 65];
const SPLAY = [0.12, 0.03, -0.06, -0.16];
const FW = [0.0195, 0.0205, 0.019, 0.0165], TW = 0.0215;
const TL = [0.032, 0.03, 0.026];
const THUMB = {
  out: [[-0.75, 0.62, -0.2], [-0.55, 0.8, -0.2], [-0.4, 0.9, -0.15]],   // отставлен
  L: [[-0.95, 0.25, -0.1], [-1, 0.05, -0.05], [-1, -0.05, 0]],          // под прямым углом («Г»)
  in: [[-0.3, 0.6, -0.75], [0.45, 0.55, -0.7], [0.85, 0.3, -0.45]],     // прижат поперёк ладони (кулак)
  side: [[-0.55, 0.8, -0.25], [-0.25, 1, -0.15], [-0.1, 1, -0.1]],      // прижат вдоль указательного
};
const PALM = [[-0.025, -0.004], [0.022, -0.004], [0.036, 0.036], [0.038, 0.07], [0.03, 0.08], [0.01, 0.091], [-0.012, 0.096], [-0.034, 0.09], [-0.041, 0.072], [-0.038, 0.042], [-0.031, 0.014]];
const HAND_LEN = 0.192;              // запястье → кончик среднего (прямая кисть)
const norm3 = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
const add3 = (a, d, k) => [a[0] + d[0] * k, a[1] + d[1] * k, a[2] + d[2] * k];

// 21 точка кисти в локальных координатах
function handModel(o) {
  const curls = o.curls || [0, 0, 0, 0], bend = o.bend || [0, 0, 0, 0], spread = o.spread ?? 1;
  const P = new Array(21);
  P[0] = [0, 0, 0];
  for (let f = 0; f < 4; f++) {
    const sp = -SPLAY[f] * spread, ux = Math.sin(sp), uy = Math.cos(sp);
    const b = norm3(-bend[f], 0, -(1 - bend[f]));          // плоскость сгиба: к ладони, с долей вбок к большому
    let p = [MCP[f][0], MCP[f][1], 0], phi = 0;
    P[5 + f * 4] = p;
    for (let j = 0; j < 3; j++) {
      phi += (curls[f] * FLEX[j] * DEG);
      const c = Math.cos(phi), s = Math.sin(phi);
      p = add3(p, [ux * c + b[0] * s, uy * c, b[2] * s], SEG[f][j]);
      P[6 + f * 4 + j] = p;
    }
  }
  const cmc = [-0.022, 0.018, -0.005];
  P[1] = cmc;
  const th = o.thumb || 'out';
  if (th === 'pinch' || th === 'gap') {
    // щепоть: кончик большого у кончика указательного; 'gap' — не дотянулся (зазор)
    const L2 = add3(cmc, norm3(-0.85, 0.45, -0.3), 0.036);
    let tip = [P[8][0] - 0.002, P[8][1] - 0.004, P[8][2]];
    if (th === 'gap') tip = [L2[0] + (tip[0] - L2[0]) * 0.52 - 0.006, L2[1] + (tip[1] - L2[1]) * 0.52, (L2[2] + tip[2]) / 2];
    const vx = tip[0] - L2[0], vy = tip[1] - L2[1], vl = Math.hypot(vx, vy) || 1, bul = o.bulge ?? 0.014;
    P[2] = L2;
    P[3] = [(L2[0] + tip[0]) / 2 - (vy / vl) * bul, (L2[1] + tip[1]) / 2 + (vx / vl) * bul, (L2[2] + tip[2]) / 2];
    P[4] = tip;
  } else {
    const dirs = THUMB[th] || THUMB.out;
    let p = cmc;
    for (let j = 0; j < 3; j++) { p = add3(p, norm3(...dirs[j]), TL[j]); P[2 + j] = p; }
  }
  return P;
}

// поворот локальной точки в вид: ладонь от зрителя → yaw (вокруг y) → pitch (вокруг x) → roll (в плоскости) → левая зеркально
function viewOf(o) {
  const away = o.palm === 'away', mir = o.side === 'left' ? -1 : 1;
  const cy = Math.cos((o.yaw || 0) * DEG), sy = Math.sin((o.yaw || 0) * DEG);
  const cp = Math.cos((o.pitch || 0) * DEG), sp = Math.sin((o.pitch || 0) * DEG);
  const cr = Math.cos((o.roll || 0) * DEG), sr = Math.sin((o.roll || 0) * DEG);
  return (q) => {
    let [x, y, z] = q;
    if (away) { x = -x; z = -z; }
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    return [x * mir, y, z];
  };
}

// Рисует кисть. o: x, y — центр ладони (единицы рисунка); s — длина кисти; side; palm 'camera'|'away';
// curls [4] 0..1; bend [4] — доля сгиба вбок к большому; thumb 'out'|'L'|'in'|'side'|'pinch'|'gap';
// yaw/pitch/roll — градусы; spread; arm — длина обрубка предплечья (доля, 0 — без); crease — линии ладони.
// Возвращает { p: 21 точка [x, y] в единицах рисунка, k — масштаб }.
function hand(D, o) {
  const P = handModel(o), V = viewOf(o), k = o.s / HAND_LEN;
  const tp = P.map(V);
  let mx = 0, my = 0;
  for (const i of [0, 5, 9, 13, 17]) { mx += tp[i][0] / 5; my += tp[i][1] / 5; }
  const X = (q) => [o.x + (q[0] - mx) * k, o.y - (q[1] - my) * k];
  const depth = (pts, bias) => { let z = 0; for (const q of pts) z += V([q[0], q[1], q[2] + bias])[2]; return z / pts.length; };
  const nrm = V([0, 0, 1]), edge = Math.sqrt(Math.max(0, 1 - nrm[2] * nrm[2]));
  const parts = [];
  const arm = o.arm ?? 0.05;
  if (arm > 0) { const a = [[0, 0.004, 0.004], [0, -arm, 0.004]]; parts.push({ z: depth(a, 0.012), pts: a, w: 0.037 }); }
  const palm = PALM.map(([x, y]) => [x, y, 0]);
  parts.push({ z: depth(palm, 0.004), pts: palm, w: (0.007 + 0.019 * edge), palm: true });
  for (let f = 0; f < 4; f++) { const ch = [5, 6, 7, 8].map((j) => P[j + f * 4]); parts.push({ z: depth(ch, 0), pts: ch, w: FW[f] }); }
  // большой палец: основание (пястная кость) — за ладонью, его край даёт бугор у запястья; остальное — своим слоем
  const tb = [P[1], P[2]], thumb = [2, 3, 4].map((j) => P[j]);
  parts.push({ z: depth(palm, 0.006), pts: tb, w: TW * 1.15 });
  parts.push({ z: depth(thumb, o.thumb === 'in' ? -0.03 : -0.012), pts: thumb, w: TW });
  parts.sort((a, b) => b.z - a.z);
  const facing = V([0, 0, -1])[2] < -0.55;                     // ладонь (сторона сгиба) смотрит на зрителя
  for (const pt of parts) {
    const pts = pt.pts.map((q) => X(V(q)));
    D.part(pth(pts, pt.palm), pt.w * k, { fill: !!pt.palm });
    if (pt.palm && o.crease && facing) {
      const cr = [[[0.034, 0.06, 0], [0.012, 0.064, 0], [-0.016, 0.074, 0]], [[-0.03, 0.07, 0], [-0.018, 0.045, 0], [-0.014, 0.014, 0]]];
      for (const c of cr) D.thin(c.map((q) => X(V(q))), Math.max(0.8, 0.0055 * k), { color: INK, op: 0.55 });
    }
  }
  return { p: tp.map(X), k };
}

// формы кисти (как SHAPES в dev/handSynth.mjs, плюс боковой сгиб указательного для видимого кольца «OK»)
const OPEN = { curls: [0, 0, 0, 0], thumb: 'out' };
const FIST = { curls: [1, 1, 1, 1], thumb: 'in' };
const POINT = { curls: [0, 1, 1, 1], thumb: 'in' };
const VICTORY = { curls: [0, 0, 1, 1], thumb: 'in' };
const OKH = { curls: [0.55, 0, 0, 0], bend: [0.85, 0, 0, 0], thumb: 'pinch' };
const LSH = { curls: [0, 1, 1, 1], thumb: 'L' };
const PINCH = { curls: [0.5, 0.95, 1, 1], bend: [0.7, 0, 0, 0], thumb: 'pinch' };
const EDGE = { curls: [0.05, 0.05, 0.05, 0.05], thumb: 'side', spread: 0.35 };

// ───────── тело ─────────
// поворот точки вокруг центра
const rot = (p, c, a) => { const s = Math.sin(a * DEG), k = Math.cos(a * DEG), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * k - y * s, c[1] + x * s + y * k]; };
// локоть по двум звеньям (sgn — в какую сторону сгиб)
function elbow(S, H, a, b, sgn) {
  const dx = H[0] - S[0], dy = H[1] - S[1], d = Math.min(Math.hypot(dx, dy) || 1e-3, a + b - 0.01);
  const ang = Math.atan2(dy, dx) + sgn * Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  return [S[0] + Math.cos(ang) * a, S[1] + Math.sin(ang) * a];
}
// маленькая кисть на конце руки силуэта: 'open' — раскрытая ладонь, 'fist' — кулак
function miniHand(D, x, y, kind, side, s = 12, roll = 0) {
  if (kind === 'fist') hand(D, { x, y, s: s * 0.9, side, ...FIST, arm: 0, roll });
  else if (kind === 'open') hand(D, { x, y, s, side, ...OPEN, arm: 0, roll });
  else D.disc(x, y, 2.6);
}
// Силуэт спереди. o: x — центр, y — линия плеч, sw — ширина плеч, tilt — наклон корпуса (град, + по часовой),
// lh/rh — положение левой/правой кисти (в показе левая рука игрока слева), lk/rk — вид кисти, legs — ноги.
function bodyFront(D, o) {
  const x = o.x, y = o.y, sw = o.sw || 18, tl = o.tl || 17, pel = [x, y + tl], tilt = o.tilt || 0;
  const T = (p) => rot(p, pel, tilt);
  const sL = T([x - sw / 2, y + 1]), sR = T([x + sw / 2, y + 1]);
  if (o.legs) {
    for (const s of [-1, 1]) {
      const hip = [x + s * 4, y + tl], knee = [x + s * 5.5, y + tl + 9], ank = [x + s * 6, y + tl + 18];
      D.line([hip, knee, ank, [ank[0] + s * 3, ank[1]]], 5);
    }
  }
  const torso = [T([x - sw / 2, y]), T([x + sw / 2, y]), T([x + sw * 0.33, y + tl]), T([x - sw * 0.33, y + tl])];
  D.line(torso, 3.5, { closed: true, fill: true });
  const head = T([x, y - 6.2]);
  D.disc(head[0], head[1], 4.6);
  for (const [S, H, kind, side, sgn] of [[sL, o.lh, o.lk, 'left', -1], [sR, o.rh, o.rk, 'right', 1]]) {
    if (!H) continue;
    const E = elbow(S, H, 9, 9, H[1] < S[1] + 4 ? -sgn : sgn);
    D.line([S, E, H], 4);
    if (kind) miniHand(D, H[0], H[1] - (kind === 'open' ? 3 : 1), kind, side, o.hs || 12);
  }
  return { sL, sR, head, pel };
}
// Силуэт приседа сбоку (лицом вправо). o: ax — x голеностопа, fy — пол, shin/thigh/torso — углы от вертикали
// (голень и корпус — вперёд, бедро — назад), heel — подъём пятки (град), arms — руки вперёд.
function squatSide(D, o) {
  const ax = o.ax ?? 30, fy = o.fy ?? 53, shin = o.shin ?? 0, thigh = o.thigh ?? 0, torso = o.torso ?? 0, heel = o.heel || 0;
  const LS = 13, LT = 13, LB = 15, toeX = ax + 8;
  const toe = [toeX, fy];
  const ank = rot([ax, fy - 3], toe, -heel), heelP = rot([ax - 2.5, fy - 0.5], toe, -heel);
  const knee = [ank[0] + Math.sin(shin * DEG) * LS, ank[1] - Math.cos(shin * DEG) * LS];
  const hip = [knee[0] - Math.sin(thigh * DEG) * LT, knee[1] - Math.cos(thigh * DEG) * LT];
  const sh = [hip[0] + Math.sin(torso * DEG) * LB, hip[1] - Math.cos(torso * DEG) * LB];
  const ha = torso * 0.7, head = [sh[0] + Math.sin(ha * DEG) * 6.4, sh[1] - Math.cos(ha * DEG) * 6.4];
  const handP = o.arms === false ? null : [sh[0] + 13, sh[1] + (o.armDrop ?? 2)];
  D.line([heelP, toe], 3.6);
  D.line([hip, knee, ank], 5.4);
  D.line([hip, sh], 6.4);
  D.disc(head[0], head[1], 4.4);
  if (handP) D.line([sh, handP], 3.8);
  else D.line([sh, [sh[0] + 2, sh[1] + 9], [sh[0] + 1, sh[1] + 15]], 3.8);
  return { toe, ank, heel: heelP, knee, hip, sh, head, hand: handP };
}
// Присед спереди: ki — колени внутрь (−) / наружу (+), d — глубина 0..1
function squatFront(D, o) {
  const x = o.x ?? 32, fy = o.fy ?? 53, d = o.d ?? 1, kx = o.kx ?? 11;
  const pelY = fy - 26 + d * 9, kneeY = fy - 13 + d * 1.5;
  const hipL = [x - 5.5, pelY], hipR = [x + 5.5, pelY], ankL = [x - 10, fy - 2.5], ankR = [x + 10, fy - 2.5];
  const kL = [x - kx, kneeY], kR = [x + kx, kneeY];
  D.line([hipL, kL, ankL, [ankL[0] - 3.6, fy - 0.5]], 5.2);
  D.line([hipR, kR, ankR, [ankR[0] + 3.6, fy - 0.5]], 5.2);
  const shY = pelY - 16;
  D.line([[x - 8.5, shY], [x + 8.5, shY], [x + 5.5, pelY], [x - 5.5, pelY]], 3.4, { closed: true, fill: true });
  D.disc(x, shY - 6, 4.4);
  // руки вытянуты вперёд (к камере): короткие, кисти вместе у груди
  D.line([[x - 8.5, shY + 1], [x - 6, shY + 7], [x - 1.5, shY + 6]], 3.6);
  D.line([[x + 8.5, shY + 1], [x + 6, shY + 7], [x + 1.5, shY + 6]], 3.6);
  return { kL, kR, ankL, ankR, pelY };
}
// Отжимание сбоку (голова слева). o: down 0..1 — глубина, hip — смещение таза (+ провис вниз, − вверх),
// lift — кисть оторвана от пола, fy — пол.
function pushupSide(D, o) {
  const fy = o.fy ?? 50, down = o.down ?? 0, hipOff = o.hip || 0;
  const handP = [15 + (o.slide || 0), fy - 1.5 - (o.lift || 0)];
  const sh = [handP[0] + 2 - (o.slide || 0) * 0.3, fy - 17 + down * 10.5];
  const foot = [58, fy - 2];
  const mid = lerp2(sh, foot, 0.46);
  const hip = [mid[0], mid[1] + hipOff];
  const knee = lerp2(hip, foot, 0.5);
  const kneeP = [knee[0], knee[1] + hipOff * 0.18];
  const head = [sh[0] - 5.8, sh[1] - 2.6 + down * 0.6];
  D.thin([[2, fy + 1.2], [CW - 2, fy + 1.2]], 1.6, { color: MUTE, op: 0.8 });
  D.line([hip, kneeP, foot, [foot[0] + 3, foot[1] + 1.5]], 5);
  D.line([sh, hip], 6.2);
  D.disc(head[0], head[1], 4.2);
  const el = elbow(sh, handP, 9, 9, 1);
  D.line([sh, el, handP, [handP[0] - 2.6, handP[1]]], 3.8);
  return { sh, hip, foot, hand: handP, head };
}

// ───────── руны: путь штриха ─────────
const TRI = [[32, 7], [54, 47], [10, 47]];
function rune(D, pts, opt = {}) {
  const d = pth(pts, opt.closed);
  D.put(`<path d="${d}" stroke="${D.c}" stroke-width="${f1((opt.w || 3.4) + 4.5)}" opacity=".2"${opt.dash ? ` stroke-dasharray="${opt.dash}"` : ''}/>`);
  D.put(`<path d="${d}" stroke="${D.c}" stroke-width="${f1(opt.w || 3.4)}"${opt.dash ? ` stroke-dasharray="${opt.dash}"` : ''}/>`);
  if (opt.start !== false) D.ring(pts[0][0], pts[0][1], 2.6, 1.6, { color: D.c });
}
// треугольник со скруглёнными углами (r — доля скругления)
function roundTri(cx, cy, s, r) {
  const v = TRI.map(([x, y]) => [cx + (x - 32) * s, cy + (y - 29) * s]);
  const out = [];
  for (let i = 0; i < 3; i++) {
    const a = v[i], b = v[(i + 1) % 3], c = v[(i + 2) % 3];
    const p0 = lerp2(b, a, r), p1 = lerp2(b, c, r);
    for (let j = 0; j <= 6; j++) { const t = j / 6, u = 1 - t; out.push([u * u * p0[0] + 2 * u * t * b[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * b[1] + t * t * p1[1]]); }
  }
  return out;
}
const triAt = (cx, cy, s) => TRI.map(([x, y]) => [cx + (x - 32) * s, cy + (y - 29) * s]);

// ───────── лук ─────────
function bow(D, x, top, bot, bulge, pull) {
  const mid = (top + bot) / 2;
  const d = `M${nums([x, top])}Q${nums([x - bulge * 2, mid, x, bot])}`;
  D.part(d, 2.8);
  const nock = [x + pull, mid];
  D.thin([[x, top], nock, [x, bot]], 1.1, { color: D.c, op: 0.95 });
  return nock;
}

// ───────── фигуры ─────────
const FIG = {};
const pair = (id, bad, good) => { FIG[id] = { bad, good }; };
const one = (id, fn) => { FIG[id] = { one: fn }; };
const mid2 = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

// кадр и трекинг
pair('hand_edge',
  (D) => {
    frameBox(D, 3, 3, 46, 50);
    D.group('opacity=".28"', () => hand(D, { x: 50, y: 31, s: 40, ...OPEN }));
    D.put('<svg x="3" y="3" width="46" height="50" viewBox="3 3 46 50">');
    hand(D, { x: 50, y: 31, s: 40, ...OPEN });
    D.put('</svg>');
    D.thin([[49, 8], [49, 48]], 2, { dash: '3 2.4' });
  },
  (D) => { frameBox(D, 3, 3, 58, 50); hand(D, { x: 32, y: 32, s: 38, ...OPEN }); });
pair('hand_far',
  (D) => { frameBox(D, 3, 3, 58, 50); hand(D, { x: 32, y: 30, s: 13, ...OPEN, arm: 0.03 }); focus(D, 32, 28, 9); },
  (D) => { frameBox(D, 3, 3, 58, 50); hand(D, { x: 32, y: 31, s: 42, ...OPEN }); });
FIG.hand_far_stand = FIG.hand_far; // [СТОЯ] та же картинка: кисть мелкая → подойти ближе
pair('hands_missing',
  (D) => {
    frameBox(D, 3, 3, 58, 42);
    D.put('<svg x="3" y="3" width="58" height="42" viewBox="3 3 58 42">');
    bodyFront(D, { x: 32, y: 26, lh: [21, 52], rh: [43, 52], lk: 'open', rk: 'open', hs: 10 });
    D.put('</svg>');
    D.group('opacity=".3"', () => { miniHand(D, 21, 50, 'open', 'left', 10); miniHand(D, 43, 50, 'open', 'right', 10); });
    focus(D, 32, 49, 5.5);
  },
  (D) => { frameBox(D, 3, 3, 58, 42); bodyFront(D, { x: 32, y: 26, lh: [13, 22], rh: [51, 22], lk: 'open', rk: 'open', hs: 12 }); });

// движение: «Руль» (левая рука)
const chestLine = (D, y) => D.thin([[4, y], [60, y]], 1.2, { dash: '2.5 2', op: 0.7 });
pair('steer_low',
  (D) => { chestLine(D, 25); bodyFront(D, { x: 38, y: 18, lh: [21, 37], rh: [46, 41], lk: 'open' }); focus(D, 21, 35, 6); },
  (D) => { chestLine(D, 25); bodyFront(D, { x: 38, y: 18, lh: [20, 23], rh: [46, 41], lk: 'open' }); arrow(D, 9, 38, 9, 26, { w: 2.2 }); });
pair('steer_lean',
  (D) => { D.thin([[38, 4], [38, 52]], 1, { dash: '2 2', color: MUTE }); bodyFront(D, { x: 38, y: 16, tilt: -20, lh: [16, 26], rh: [48, 44], lk: 'open', legs: true }); arcArrow(D, 38, 33, 22, -75, -120, { w: 1.8 }); },
  (D) => { D.thin([[38, 4], [38, 52]], 1, { dash: '2 2', color: MUTE }); bodyFront(D, { x: 38, y: 16, lh: [14, 25], rh: [48, 42], lk: 'open', legs: true }); arrow(D, 21, 11, 6, 11, { w: 2.2 }); });

// правая рука: «OK» — снаряд
pair('ok_ring_open',
  (D) => { const h = hand(D, { x: 36, y: 33, s: 46, ...OKH, thumb: 'gap' }); const m = mid2(h.p[4], h.p[8]); focus(D, m[0], m[1], 6.5); },
  (D) => { const h = hand(D, { x: 36, y: 33, s: 46, ...OKH }); focus(D, h.p[4][0], h.p[4][1], 5); });
pair('ok_fingers',
  (D) => { const h = hand(D, { x: 34, y: 35, s: 46, ...OKH, curls: [0.55, 0.85, 0.9, 0.95] }); const m = mid2(h.p[12], h.p[20]); focus(D, m[0] + 1, m[1] - 2, 9); },
  (D) => { const h = hand(D, { x: 34, y: 35, s: 46, ...OKH }); for (const i of [12, 16, 20]) arrow(D, h.p[i][0], h.p[i][1] - 3.5, h.p[i][0], h.p[i][1] - 9, { w: 1.6 }); });
pair('spark_one',
  (D) => { const h = hand(D, { x: 32, y: 36, s: 44, ...VICTORY }); focus(D, h.p[12][0], h.p[12][1] + 2, 5.5); },
  (D) => { const h = hand(D, { x: 32, y: 36, s: 44, ...POINT }); rays(D, h.p[8][0], h.p[8][1] - 3, 3.5, 7.5, 6, -90, 360, 1.6); });
pair('slash_slow',
  (D) => { hand(D, { x: 34, y: 30, s: 40, ...EDGE, yaw: 80, roll: -35 }); slowDots(D, 50, 18, 210, 3, 5); D.thin(arcPts(26, 52, 34, -60, -40, 6), 1.6, { dash: '2 3', op: 0.7 }); },
  (D) => { hand(D, { x: 30, y: 32, s: 40, ...EDGE, yaw: 80, roll: 35 }); D.thin(arcPts(18, 48, 40, -78, -18, 10), 3); speedLines(D, 50, 14, 215, 10, 3, 4.5); });
// кольцо заряда вокруг кулака
function chargeRing(D, x, y, r, frac) {
  D.ring(x, y, r, 3, { op: 0.25 });
  if (frac >= 1) { D.ring(x, y, r, 3); return; }
  D.thin(arcPts(x, y, r, -90, -90 + 360 * frac, 12), 3);
}
pair('burst_short',
  (D) => { hand(D, { x: 32, y: 30, s: 40, ...FIST, arm: 0.04 }); chargeRing(D, 32, 27, 24, 0.3); focus(D, 32 + 24 * Math.cos(-0.2), 27 + 24 * Math.sin(-0.2), 4); },
  (D) => { hand(D, { x: 32, y: 30, s: 40, ...FIST, arm: 0.04 }); chargeRing(D, 32, 27, 24, 1); });
pair('burst_slow',
  (D) => { const h = hand(D, { x: 32, y: 34, s: 44, curls: [0, 0.35, 0.75, 1], thumb: 'side' }); focus(D, h.p[16][0] + 2, h.p[16][1], 8); slowDots(D, 52, 14, 135, 3); },
  (D) => { const h = hand(D, { x: 32, y: 35, s: 42, ...OPEN, spread: 1.6 }); rays(D, 32, 25, 22, 28, 7, -90, 180, 2); });

// левая рука: щит и парирование
pair('shield_palm',
  (D) => { hand(D, { x: 30, y: 34, s: 46, side: 'left', ...OPEN, spread: 0.6, yaw: 78 }); arcArrow(D, 30, 34, 22, 200, 250, { w: 1.6 }); },
  (D) => hand(D, { x: 32, y: 34, s: 46, side: 'left', ...OPEN, crease: true }));
pair('shield_push',
  (D) => { hand(D, { x: 32, y: 33, s: 36, side: 'left', ...OPEN, crease: true }); D.thin([[47, 50], [55, 50]], 2, { op: 0.8 }); D.thin([[47, 46], [55, 46]], 2, { op: 0.8 }); },
  (D) => {
    D.group('opacity=".3"', () => hand(D, { x: 32, y: 30, s: 28, side: 'left', ...OPEN, arm: 0 }));
    hand(D, { x: 32, y: 33, s: 46, side: 'left', ...OPEN, crease: true });
    pushArcs(D, 32, 26, 23, 2, { step: 5 });
  });
pair('parry_palm',
  (D) => { D.group('opacity=".35"', () => hand(D, { x: 10, y: 46, s: 15, side: 'left', ...FIST, arm: 0 })); hand(D, { x: 36, y: 33, s: 44, side: 'left', ...OPEN, spread: 0.6, yaw: 78 }); },
  (D) => { D.group('opacity=".35"', () => hand(D, { x: 10, y: 46, s: 15, side: 'left', ...FIST, arm: 0 })); hand(D, { x: 36, y: 33, s: 44, side: 'left', ...OPEN, crease: true }); rays(D, 36, 23, 22, 27, 5, -90, 140, 1.8); });
pair('parry_slow',
  (D) => { D.group('opacity=".35"', () => hand(D, { x: 10, y: 46, s: 15, side: 'left', ...FIST, arm: 0 })); const h = hand(D, { x: 36, y: 34, s: 44, side: 'left', curls: [0.55, 0.6, 0.65, 0.7], thumb: 'side' }); slowDots(D, 56, 12, 140, 3); focus(D, h.p[12][0], h.p[12][1], 9); },
  (D) => { D.group('opacity=".35"', () => hand(D, { x: 10, y: 46, s: 15, side: 'left', ...FIST, arm: 0 })); hand(D, { x: 36, y: 34, s: 44, side: 'left', ...OPEN, spread: 1.4 }); rays(D, 36, 24, 22, 28, 5, -90, 150, 2); });

// руны
pair('rune_small',
  (D) => { D.ring(32, 28, 21, 1, { dash: '2 2', color: MUTE }); rune(D, [...triAt(32, 29, 0.33), triAt(32, 29, 0.33)[0]], { w: 2.6, start: false }); focus(D, 32, 29, 10); },
  (D) => { D.ring(32, 28, 21, 1, { dash: '2 2', color: MUTE }); rune(D, [...triAt(32, 29, 1), TRI[0]]); });
pair('rune_fast',
  (D) => { rune(D, [...TRI, TRI[0]], { dash: '3 7' }); speedLines(D, 50, 12, 30, 9, 3, 3.5); },
  (D) => { rune(D, [...TRI, TRI[0]]); clock(D, 32, 34, 6.5); });
pair('rune_long',
  (D) => { rune(D, [...triAt(30, 27, 0.85), [30 + 2, 8], [44, 12], [40, 20], [52, 22], [48, 30], [58, 32]]); focus(D, 52, 26, 8); },
  (D) => { rune(D, [...triAt(32, 29, 1), TRI[0]]); freeze(D, 32, 7); });
pair('rune_line',
  (D) => { rune(D, [[10, 46], [54, 10]]); },
  (D) => {
    rune(D, [...triAt(13, 20, 0.36), triAt(13, 20, 0.36)[0]], { w: 2.6, start: false });
    rune(D, [[27, 11], [37, 20], [29, 23], [39, 31]], { w: 2.6, start: false });
    D.put(`<circle cx="51" cy="21" r="7.5" stroke="${D.c}" stroke-width="2.6"/>`);
    D.thin([[8, 42], [56, 42]], 1, { color: MUTE, op: 0.5 });
  });
pair('rune_open',
  (D) => { rune(D, [[34, 9], [54, 47], [10, 47], [25, 20]]); focus(D, 29.5, 14, 7.5); },
  (D) => { rune(D, [...TRI, TRI[0]]); focus(D, 32, 7, 5.5); });
pair('rune_corners',
  (D) => { rune(D, [...roundTri(32, 29, 1, 0.42)], { closed: true, start: false }); focus(D, 32, 10, 6); },
  (D) => { rune(D, [...TRI, TRI[0]], { start: false }); for (const [x, y] of TRI) D.disc(x, y, 2.4); focus(D, 32, 7, 6); });
pair('rune_zigzag',
  (D) => { const w = []; for (let i = 0; i <= 24; i++) { const t = i / 24; w.push([8 + t * 48, 28 - Math.sin(t * Math.PI * 3) * 12]); } rune(D, w); },
  (D) => { rune(D, [[8, 22], [24, 40], [34, 16], [46, 40], [56, 22]]); for (const p of [[24, 40], [34, 16], [46, 40]]) D.disc(p[0], p[1], 2); });
pair('rune_round',
  (D) => { const p = []; for (let i = 0; i <= 6; i++) { const a = (-90 + i * 60) * DEG; p.push([32 + Math.cos(a) * 21, 28 + Math.sin(a) * 21]); } rune(D, p, { start: false }); focus(D, 50.2, 17.5, 5.5); },
  (D) => { rune(D, arcPts(32, 28, 21, -90, 270, 36), { start: false }); });
pair('rune_near',
  (D) => { rune(D, [[31, 15], [37, 23], [40, 33], [44, 39], [36, 40], [24, 41], [21, 38], [27, 27], [33, 19]], { w: 2.8 }); },
  (D) => { rune(D, [...TRI, TRI[0]]); freeze(D, 32, 7); });
pair('rune_unclear',
  (D) => { rune(D, [[14, 30], [24, 14], [30, 34], [40, 18], [36, 40], [50, 30], [44, 12], [54, 24], [26, 46], [20, 26]], { w: 2.8 }); },
  (D) => { rune(D, [...TRI, TRI[0]]); freeze(D, 32, 7); });

// двумя руками
pair('orb_facing',
  (D) => { orb(D, 32, 27, 9, false); hand(D, { x: 12, y: 30, s: 32, side: 'left', ...OPEN }); hand(D, { x: 52, y: 30, s: 32, side: 'right', ...OPEN }); },
  (D) => { orb(D, 32, 27, 9.5); hand(D, { x: 13, y: 30, s: 32, side: 'left', ...OPEN, spread: 0.7, yaw: 62, curls: [0.15, 0.15, 0.15, 0.15] }); hand(D, { x: 51, y: 30, s: 32, side: 'right', ...OPEN, spread: 0.7, yaw: 62, curls: [0.15, 0.15, 0.15, 0.15] }); });
const ORBH = { ...OPEN, spread: 0.7, yaw: 62, curls: [0.15, 0.15, 0.15, 0.15] };
pair('orb_dy',
  (D) => { orb(D, 32, 27, 8.5); const a = hand(D, { x: 13, y: 21, s: 30, side: 'left', ...ORBH }); const b = hand(D, { x: 51, y: 38, s: 30, side: 'right', ...ORBH }); D.thin([[3, a.p[0][1]], [61, a.p[0][1]]], 1.2, { dash: '2.5 2', op: 0.8 }); D.thin([[3, b.p[0][1]], [61, b.p[0][1]]], 1.2, { dash: '2.5 2', op: 0.8 }); },
  (D) => { orb(D, 32, 27, 8.5); const a = hand(D, { x: 13, y: 30, s: 30, side: 'left', ...ORBH }); hand(D, { x: 51, y: 30, s: 30, side: 'right', ...ORBH }); D.thin([[3, a.p[0][1]], [61, a.p[0][1]]], 1.2, { dash: '2.5 2', op: 0.8 }); });
pair('orb_far',
  (D) => { orb(D, 32, 27, 6); hand(D, { x: 7, y: 30, s: 27, side: 'left', ...ORBH }); hand(D, { x: 57, y: 30, s: 27, side: 'right', ...ORBH }); focus(D, 32, 27, 10); },
  (D) => { orb(D, 32, 27, 9.5); hand(D, { x: 14, y: 30, s: 30, side: 'left', ...ORBH }); hand(D, { x: 50, y: 30, s: 30, side: 'right', ...ORBH }); arrow(D, 3, 50, 12, 50, { w: 1.8 }); arrow(D, 61, 50, 52, 50, { w: 1.8 }); });
const PRI = { ...LSH, roll: -38 };
pair('prism_tips',
  (D) => { const a = hand(D, { x: 14, y: 36, s: 30, side: 'left', ...PRI }); const b = hand(D, { x: 50, y: 36, s: 30, side: 'right', ...PRI }); focus(D, (a.p[8][0] + b.p[8][0]) / 2, (a.p[8][1] + b.p[8][1]) / 2, 6); focus(D, (a.p[4][0] + b.p[4][0]) / 2, (a.p[4][1] + b.p[4][1]) / 2, 6); },
  (D) => { const a = hand(D, { x: 18.5, y: 36, s: 30, side: 'left', ...PRI }); const b = hand(D, { x: 45.5, y: 36, s: 30, side: 'right', ...PRI }); const top = mid2(a.p[8], b.p[8]), bl = a.p[4], br = b.p[4]; D.thin([top, [bl[0] + 3, bl[1] - 1.5], [br[0] - 3, br[1] - 1.5]], 1.6, { closed: true, dash: '2.4 1.6' }); D.disc(top[0], top[1] + 0.5, 1.6, { noOutline: true }); });
pair('throw_weak',
  (D) => { orb(D, 32, 26, 7); hand(D, { x: 15, y: 31, s: 30, side: 'left', ...OPEN }); hand(D, { x: 49, y: 31, s: 30, side: 'right', ...OPEN }); D.thin(arcPts(32, 26, 11, -30, 30, 5), 1.6, { op: 0.6 }); },
  (D) => { orb(D, 32, 25, 9.5); hand(D, { x: 13, y: 32, s: 36, side: 'left', ...OPEN }); hand(D, { x: 51, y: 32, s: 36, side: 'right', ...OPEN }); pushArcs(D, 32, 25, 12, 2, { step: 4 }); });
pair('throw_hold',
  (D) => { orb(D, 32, 27, 9.5); hand(D, { x: 13, y: 30, s: 32, side: 'left', ...ORBH }); hand(D, { x: 51, y: 30, s: 32, side: 'right', ...ORBH }); hourglass(D, 32, 50, 9); },
  (D) => { D.group('opacity=".3"', () => orb(D, 32, 34, 6)); orb(D, 32, 15, 11); speedLines(D, 32, 30, -90, 8, 3, 5); hand(D, { x: 11, y: 36, s: 30, side: 'left', ...OPEN }); hand(D, { x: 53, y: 36, s: 30, side: 'right', ...OPEN }); });
pair('gate_slow',
  (D) => { hand(D, { x: 22, y: 32, s: 32, side: 'left', ...OPEN }); hand(D, { x: 42, y: 32, s: 32, side: 'right', ...OPEN }); slowDots(D, 13, 50, 180, 2, 3.5); slowDots(D, 51, 50, 0, 2, 3.5); arrow(D, 8, 50, 4, 50, { w: 1.4 }); arrow(D, 56, 50, 60, 50, { w: 1.4 }); },
  (D) => { hand(D, { x: 10, y: 30, s: 30, side: 'left', ...OPEN }); hand(D, { x: 54, y: 30, s: 30, side: 'right', ...OPEN }); arrow(D, 27, 30, 20, 30, { w: 2.4 }); arrow(D, 37, 30, 44, 30, { w: 2.4 }); speedLines(D, 30, 30, 180, 6, 2, 5, { w: 1.4 }); speedLines(D, 34, 30, 0, 6, 2, 5, { w: 1.4 }); });
pair('gate_horiz',
  (D) => { hand(D, { x: 20, y: 17, s: 26, side: 'left', ...OPEN }); hand(D, { x: 44, y: 41, s: 26, side: 'right', ...OPEN }); arrow(D, 32, 22, 32, 6, { w: 2 }); arrow(D, 32, 34, 32, 52, { w: 2 }); },
  (D) => { hand(D, { x: 11, y: 30, s: 30, side: 'left', ...OPEN }); hand(D, { x: 53, y: 30, s: 30, side: 'right', ...OPEN }); arrow(D, 30, 30, 22, 30, { w: 2.4 }); arrow(D, 34, 30, 42, 30, { w: 2.4 }); });
pair('frame_diag',
  (D) => { hand(D, { x: 16, y: 30, s: 30, side: 'left', ...LSH }); hand(D, { x: 48, y: 30, s: 30, side: 'right', ...LSH }); D.thin([[3, 20], [61, 20]], 1, { dash: '2 2', op: 0.7 }); },
  (D) => { const a = hand(D, { x: 12, y: 39, s: 28, side: 'left', ...LSH }); const b = hand(D, { x: 52, y: 17, s: 28, side: 'right', ...LSH, palm: 'away', roll: 180 }); D.thin([a.p[8], [b.p[4][0], a.p[8][1]], b.p[8], [a.p[4][0], b.p[8][1]]], 1.3, { closed: true, dash: '2.4 2', op: 0.85 }); });

// лук (вид сбоку: лук слева, тетива тянется вправо к уху)
pair('bow_fist',
  (D) => { bow(D, 22, 5, 51, 7, 0); hand(D, { x: 18, y: 30, s: 30, side: 'left', ...OPEN, arm: 0.04 }); focus(D, 18, 22, 11); },
  (D) => { bow(D, 22, 5, 51, 7, 0); hand(D, { x: 18, y: 30, s: 26, side: 'left', ...FIST, arm: 0.06, roll: -90 }); });
pair('bow_pinch',
  (D) => { const n = bow(D, 18, 5, 51, 7, 0); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); const h = hand(D, { x: 44, y: 34, s: 30, ...OKH, thumb: 'gap', roll: 20 }); focus(D, (h.p[4][0] + h.p[8][0]) / 2, (h.p[4][1] + h.p[8][1]) / 2, 5.5); void n; },
  (D) => { const n = bow(D, 18, 5, 51, 7, 6); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); D.thin([[n[0] + 8, n[1]], [2, n[1]]], 1.8); hand(D, { x: n[0] + 9, y: n[1] + 5, s: 26, ...PINCH, roll: 60 }); });
pair('bow_draw',
  (D) => { const n = bow(D, 18, 5, 51, 7, 7); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); D.thin([[n[0] + 6, n[1]], [2, n[1]]], 1.8); hand(D, { x: n[0] + 8, y: n[1] + 5, s: 26, ...PINCH, roll: 60 }); focus(D, n[0] + 3, n[1], 8); },
  (D) => { const n = bow(D, 18, 5, 51, 9, 34); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); D.thin([[n[0], n[1]], [2, n[1]]], 1.8); hand(D, { x: n[0] + 3, y: n[1] + 5, s: 26, ...PINCH, roll: 60 }); arrow(D, 34, 50, 54, 50, { w: 1.8 }); });
pair('bow_release',
  (D) => { const n = bow(D, 18, 5, 51, 9, 34); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); D.thin([[n[0], n[1]], [2, n[1]]], 1.8); const h = hand(D, { x: n[0] + 3, y: n[1] + 5, s: 26, ...PINCH, roll: 60 }); focus(D, h.p[4][0], h.p[4][1], 5.5); },
  (D) => { bow(D, 18, 5, 51, 7, 0); hand(D, { x: 14, y: 30, s: 22, side: 'left', ...FIST, arm: 0.05, roll: -90 }); arrow(D, 30, 18, 6, 18, { w: 1.8 }); speedLines(D, 36, 18, 180, 6, 2, 3, { w: 1.2 }); hand(D, { x: 50, y: 32, s: 26, ...OPEN, spread: 1.5, roll: 60 }); });
pair('bow_low',
  (D) => { chestLine(D, 25); bodyFront(D, { x: 40, y: 18, lh: [24, 40], rh: [48, 42], lk: 'fist' }); D.part(`M${nums([24, 30])}Q${nums([18, 40, 24, 50])}`, 1.8); focus(D, 23, 39, 6.5); },
  (D) => { chestLine(D, 25); bodyFront(D, { x: 40, y: 18, lh: [18, 25], rh: [48, 42], lk: 'fist' }); D.part(`M${nums([18, 14])}Q${nums([12, 25, 18, 36])}`, 1.8); arrow(D, 7, 44, 7, 30, { w: 2.2 }); });
pair('bow_forward',
  (D) => { bow(D, 34, 12, 46, 4, 0); hand(D, { x: 32, y: 30, s: 18, side: 'left', ...FIST, arm: 0.04, roll: -90 }); },
  (D) => { D.group('opacity=".3"', () => hand(D, { x: 32, y: 30, s: 16, side: 'left', ...FIST, arm: 0, roll: -90 })); bow(D, 36, 3, 55, 8, 0); hand(D, { x: 32, y: 29, s: 32, side: 'left', ...FIST, arm: 0.05, roll: -90 }); pushArcs(D, 32, 28, 16, 2, { step: 5 }); });

// магия рукой (правая)
pair('spell_throw_weak',
  (D) => { hand(D, { x: 34, y: 34, s: 40, ...OPEN }); flame(D, 34, 14, 6); D.thin(arcPts(34, 14, 12, -40, 40, 5), 1.6, { op: 0.6 }); },
  (D) => { D.group('opacity=".3"', () => hand(D, { x: 34, y: 34, s: 26, ...OPEN, arm: 0 })); hand(D, { x: 32, y: 36, s: 40, ...OPEN }); flame(D, 54, 12, 6.5); speedLines(D, 47, 18, -40, 9, 3, 3.5); pushArcs(D, 32, 28, 20, 2, { step: 4.5 }); });
pair('spell_hold',
  (D) => { hand(D, { x: 28, y: 40, s: 38, ...OPEN, pitch: -68, curls: [0.25, 0.2, 0.2, 0.25] }); flame(D, 28, 20, 7.5); hourglass(D, 54, 14, 10); },
  (D) => { hand(D, { x: 24, y: 40, s: 38, ...OPEN, pitch: -68, curls: [0.25, 0.2, 0.2, 0.25], roll: -25 }); flame(D, 50, 12, 7); speedLines(D, 41, 21, -40, 10, 3, 3.5); });
pair('spell_palm',
  (D) => { const h = hand(D, { x: 32, y: 34, s: 44, ...OPEN }); void h; },
  (D) => { hand(D, { x: 32, y: 42, s: 42, ...OPEN, pitch: -68, curls: [0.25, 0.2, 0.2, 0.25] }); flame(D, 32, 21, 8); arcArrow(D, 32, 40, 24, 190, 230, { w: 1.6 }); });

// приседания (вид сбоку и спереди)
const SQ = { shin: 34, thigh: 86, torso: 40 };
const floor = (D, y = 54.5) => D.thin([[3, y], [61, y]], 1.4, { color: MUTE, op: 0.8 });
pair('squat_shallow',
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 22, thigh: 42, torso: 26 }); D.thin([[8, s.knee[1]], [s.knee[0] + 6, s.knee[1]]], 1.2, { dash: '2.4 2', op: 0.8 }); focus(D, s.hip[0], (s.hip[1] + s.knee[1]) / 2 - 1, 7); },
  (D) => { floor(D); const s = squatSide(D, { ax: 30, ...SQ }); D.thin([[8, s.knee[1]], [s.knee[0] + 6, s.knee[1]]], 1.2, { dash: '2.4 2', op: 0.8 }); });
pair('squat_valgus',
  (D) => { floor(D); const s = squatFront(D, { kx: 3.2 }); focus(D, s.kL[0] + 1.5, s.kL[1], 5.5); focus(D, s.kR[0] - 1.5, s.kR[1], 5.5); },
  (D) => { floor(D); const s = squatFront(D, { kx: 12.5 }); arrow(D, s.kL[0] - 4, s.kL[1], s.kL[0] - 10, s.kL[1], { w: 1.8 }); arrow(D, s.kR[0] + 4, s.kR[1], s.kR[0] + 10, s.kR[1], { w: 1.8 }); });
pair('squat_knees_forward',
  (D) => { floor(D); const s = squatSide(D, { ax: 28, shin: 58, thigh: 92, torso: 22 }); D.thin([[s.toe[0], 54], [s.toe[0], 16]], 1.2, { dash: '2.4 2', op: 0.8 }); focus(D, s.knee[0], s.knee[1], 5.5); },
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 30, thigh: 86, torso: 44 }); D.thin([[s.toe[0], 54], [s.toe[0], 16]], 1.2, { dash: '2.4 2', op: 0.8 }); arrow(D, s.hip[0] - 3, s.hip[1] - 6, s.hip[0] - 11, s.hip[1] - 6, { w: 1.8 }); });
pair('squat_lean',
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 30, thigh: 86, torso: 72, armDrop: 8 }); focus(D, s.sh[0], s.sh[1], 6); },
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 34, thigh: 86, torso: 34 }); arrow(D, s.sh[0] - 6, s.sh[1] + 4, s.sh[0] - 6, s.sh[1] - 8, { w: 1.8 }); });
pair('squat_fast',
  (D) => { floor(D); squatSide(D, { ax: 28, ...SQ }); arrow(D, 54, 6, 54, 44, { w: 2.2 }); speedLines(D, 54, 30, 90, 0.1, 1); D.thin([[48, 10], [48, 30]], 1.4, { op: 0.7 }); D.thin([[60, 10], [60, 30]], 1.4, { op: 0.7 }); },
  (D) => { floor(D); squatSide(D, { ax: 28, ...SQ }); clock(D, 53, 11, 7); arrow(D, 53, 22, 53, 42, { w: 1.6, dash: '2 2.4' }); });
pair('squat_heels',
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 48, thigh: 88, torso: 34, heel: 28 }); focus(D, s.heel[0], s.heel[1] - 0.5, 5); },
  (D) => { floor(D); const s = squatSide(D, { ax: 30, ...SQ }); arrow(D, s.heel[0] - 1, s.heel[1] - 15, s.heel[0] - 1, s.heel[1] - 4, { w: 1.6 }); });
pair('squat_lockout',
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 18, thigh: 30, torso: 14, arms: false }); focus(D, s.knee[0], s.knee[1], 5.5); },
  (D) => { floor(D); const s = squatSide(D, { ax: 30, shin: 0, thigh: 0, torso: 0, arms: false }); arrow(D, s.head[0] + 10, s.knee[1], s.head[0] + 10, s.head[1], { w: 1.8 }); });
pair('squat_frame',
  (D) => {
    frameBox(D, 3, 3, 58, 36);
    D.put('<svg x="3" y="3" width="58" height="36" viewBox="3 3 58 36">');
    D.put('<g transform="translate(-14 -6) scale(1.45)">'); squatSide(D, { ax: 30, shin: 0, thigh: 0, torso: 0, arms: false }); D.put('</g>');
    D.put('</svg>');
    D.thin([[8, 39], [56, 39]], 2, { dash: '3 2.4' });
  },
  (D) => { frameBox(D, 3, 3, 58, 52); D.put('<g transform="translate(15 4) scale(.82)">'); squatSide(D, { ax: 30, shin: 0, thigh: 0, torso: 0, arms: false }); D.put('</g>'); arrow(D, 52, 30, 52, 44, { w: 1.6 }); });

// отжимания (вид сбоку)
pair('pushup_shallow',
  (D) => { const s = pushupSide(D, { down: 0.25 }); D.thin([[3, 41], [30, 41]], 1.2, { dash: '2.4 2', op: 0.8 }); focus(D, s.sh[0], s.sh[1] + 1, 6); },
  (D) => { const s = pushupSide(D, { down: 1 }); D.thin([[3, 41], [30, 41]], 1.2, { dash: '2.4 2', op: 0.8 }); arrow(D, 33, 23, 33, 34, { w: 1.8 }); void s; });
pair('pushup_fast',
  (D) => { pushupSide(D, { down: 0.6 }); arrow(D, 42, 8, 42, 30, { w: 2.2 }); D.thin([[37, 9], [37, 22]], 1.4, { op: 0.7 }); D.thin([[47, 9], [47, 22]], 1.4, { op: 0.7 }); },
  (D) => { pushupSide(D, { down: 0.6 }); clock(D, 42, 13, 7); });
pair('pushup_slow',
  (D) => { pushupSide(D, { down: 1 }); hourglass(D, 38, 16, 13); },
  (D) => { pushupSide(D, { down: 0 }); arrow(D, 40, 28, 40, 10, { w: 2 }); });
pair('pushup_hands',
  (D) => { const s = pushupSide(D, { down: 0.2, lift: 5, slide: -3 }); focus(D, s.hand[0] - 1, s.hand[1] + 2, 6); },
  (D) => { const s = pushupSide(D, { down: 0.2 }); D.thin([[s.hand[0] - 6, 53.5], [s.hand[0] + 3, 53.5]], 2.2); arrow(D, s.hand[0] - 9, 30, s.hand[0] - 9, 44, { w: 1.6 }); });
pair('pushup_sag',
  (D) => { const s = pushupSide(D, { down: 0.1, hip: 8 }); D.thin([s.sh, s.foot], 1.2, { dash: '2.4 2', op: 0.7 }); focus(D, s.hip[0], s.hip[1], 6); },
  (D) => { const s = pushupSide(D, { down: 0.1 }); D.thin([[s.sh[0] - 4, s.sh[1] - 4 * (s.foot[1] - s.sh[1]) / (s.foot[0] - s.sh[0])], s.foot], 1.2, { dash: '2.4 2', op: 0.9 }); });
pair('pushup_pike',
  (D) => { const s = pushupSide(D, { down: 0.1, hip: -11 }); D.thin([s.sh, s.foot], 1.2, { dash: '2.4 2', op: 0.7 }); focus(D, s.hip[0], s.hip[1], 6); },
  (D) => { const s = pushupSide(D, { down: 0.1 }); D.thin([[s.sh[0] - 4, s.sh[1] - 4 * (s.foot[1] - s.sh[1]) / (s.foot[0] - s.sh[0])], s.foot], 1.2, { dash: '2.4 2', op: 0.9 }); });

// иконки жестов для выбора в тренажёре (одна «правильная» фигура)
one('g_ok', (D) => hand(D, { x: 36, y: 33, s: 46, ...OKH }));
one('g_shield', (D) => { hand(D, { x: 32, y: 33, s: 44, side: 'left', ...OPEN, crease: true }); pushArcs(D, 32, 26, 22, 2, { step: 5 }); });
one('g_spark', (D) => { const h = hand(D, { x: 32, y: 36, s: 44, ...POINT }); rays(D, h.p[8][0], h.p[8][1] - 3, 3.5, 7.5, 6, -90, 360, 1.6); });
one('g_burst', (D) => { hand(D, { x: 32, y: 35, s: 42, ...OPEN, spread: 1.6 }); rays(D, 32, 25, 22, 28, 7, -90, 180, 2); });
one('g_parry', (D) => { D.group('opacity=".35"', () => hand(D, { x: 10, y: 46, s: 15, side: 'left', ...FIST, arm: 0 })); hand(D, { x: 36, y: 33, s: 44, side: 'left', ...OPEN, crease: true }); rays(D, 36, 23, 22, 27, 5, -90, 140, 1.8); });
one('g_orb', (D) => { orb(D, 32, 27, 9.5); hand(D, { x: 13, y: 30, s: 32, side: 'left', ...ORBH }); hand(D, { x: 51, y: 30, s: 32, side: 'right', ...ORBH }); });
one('g_squat', (D) => { floor(D); squatSide(D, { ax: 30, ...SQ }); });
one('g_pushup', (D) => { pushupSide(D, { down: 0.5 }); });

// [W3-ULT] «Небесный суд»: обе руки над головой (core/ultimate.js)
pair('ult_one_hand',
  (D) => { chestLine(D, 21); bodyFront(D, { x: 32, y: 30, lh: [24, 10], rh: [42, 50], lk: 'open', rk: 'open', hs: 10 }); focus(D, 42, 48, 6); },
  (D) => { chestLine(D, 21); bodyFront(D, { x: 32, y: 30, lh: [24, 10], rh: [40, 10], lk: 'open', rk: 'open', hs: 10 }); arrow(D, 55, 44, 55, 18, { w: 2.2 }); });
pair('ult_early',
  (D) => { chestLine(D, 21); bodyFront(D, { x: 28, y: 30, lh: [20, 10], rh: [36, 10], lk: 'open', rk: 'open', hs: 10 }); clock(D, 53, 13, 8); arrow(D, 53, 27, 53, 48, { w: 2, color: MUTE }); },
  (D) => { chestLine(D, 21); bodyFront(D, { x: 28, y: 30, lh: [20, 10], rh: [36, 10], lk: 'open', rk: 'open', hs: 10 }); clock(D, 53, 13, 8); D.ring(53, 13, 11, 2.2); });

export const PICTOGRAM_IDS = Object.freeze(Object.keys(FIG));

export function hasPictogram(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FIG, id);
}

// одна фигура в ячейке CW×CH: перенос + масштаб
function cell(fn, color, bad, tx, ty, k) {
  const D = canvas(color, bad);
  fn(D);
  return `<g transform="translate(${f1(tx)} ${f1(ty)})${k !== 1 ? ` scale(${+k.toFixed(3)})` : ''}" fill="none" stroke-linecap="round" stroke-linejoin="round">${D.o.join('')}</g>`;
}
const posNum = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

export function pictogramSvg(id, opts = {}) {
  if (!hasPictogram(id)) return '';
  const o = opts && typeof opts === 'object' ? opts : {};
  const width = posNum(o.width, 168), height = posNum(o.height, 72), labels = o.labels !== false;
  const only = o.only === 'good' || o.only === 'bad' ? o.only : null;
  const F = FIG[id];
  const head = (vb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${f1(width)}" height="${f1(height)}">`;
  if (F.one || only) {
    // одна фигура по центру, без стрелки и подписей
    const which = only || 'good';
    const fn = F.one || F[which];
    return head(`-3 -3 ${CW + 6} ${CH + 6}`) + cell(fn, which === 'bad' ? BAD : GOOD, which === 'bad', 0, 0, 1) + '</svg>';
  }
  // пара: «сейчас» → «надо» в поле 168×72
  const k = labels ? 1 : 1.08, top = labels ? 1 : (72 - CH * k) / 2;
  const lx = labels ? 2 : 1, rx = 168 - lx - CW * k, ay = top + (CH * k) / 2;
  let s = head('0 0 168 72');
  s += cell(F.bad, BAD, true, lx, top, k);
  s += cell(F.good, GOOD, false, rx, top, k);
  // золотая стрелка «→»
  const ax0 = lx + CW * k + 6, ax1 = rx - 6;
  s += `<path d="M${nums([ax0, ay])}H${f1(ax1 - 5)}" stroke="${GOLD}" stroke-width="3" stroke-linecap="round"/>`;
  s += `<path d="M${nums([ax1 - 7, ay - 6.5])}L${nums([ax1, ay])}L${nums([ax1 - 7, ay + 6.5])}z" fill="${GOLD}" stroke="${GOLD}" stroke-width="1.5" stroke-linejoin="round"/>`;
  if (labels) {
    const t = (x, col, txt) => `<text x="${f1(x)}" y="69" fill="${col}" font-family="system-ui, sans-serif" font-size="10.5" font-weight="700" text-anchor="middle" letter-spacing=".4">${txt}</text>`;
    s += t(lx + CW / 2, BAD, 'сейчас') + t(rx + CW / 2, GOOD, 'надо');
  }
  return s + '</svg>';
}
