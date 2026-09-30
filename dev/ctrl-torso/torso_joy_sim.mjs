// Симулятор «Корпус-джойстик»: 3D-модель сидящего игрока → камера-обскура 640×480 → шум/задержка/fps →
// прототип нового алгоритма (свидетели + согласие) и, для сравнения, старый torsoMove (createPoseInterpreter).
import { createPoseInterpreter } from '../../modules/vision.js';

// ───────── ГСЧ ─────────
function rng32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gaussOf = (r) => () => { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ───────── тело и камера ─────────
const CAM = { y: 1.12, fx: 457, W: 640, H: 480 };
// точки относительно центра бёдер; правая сторона игрока — это −X мира (камера смотрит на игрока вдоль +Z)
const BODY = {
  rs: [-0.19, 0.52, 0], ls: [0.19, 0.52, 0], c7: [0, 0.54, 0.0],
  re: [-0.075, 0.76, -0.02], le: [0.075, 0.76, -0.02], nose: [0, 0.74, -0.12],
  rel: [-0.24, 0.26, -0.05], lel: [0.24, 0.26, -0.05], rw: [-0.2, 0.08, -0.25], lw: [0.2, 0.08, -0.25],
};
const rotZ = ([x, y, z], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z];
const rotX = ([x, y, z], a) => [x, y * Math.cos(a) + z * Math.sin(a), -y * Math.sin(a) + z * Math.cos(a)]; // a>0: верх к камере
const rotY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// p: { lat (°, + к своей правой), fwd (°, + к камере), twist (°), hYaw, hTilt, nod (°), shrugR (м), slideX (м), dist (м), armR (0..1) }
export function bodyPoints(p) {
  const hip = [p.slideX || 0, 0.55, 1.0 + (p.dist || 0)];
  const lean = (v) => rotZ(rotX(rotY(v, (p.twist || 0) * D2R), (p.fwd || 0) * D2R), (p.lat || 0) * D2R);
  const head = (v) => {
    // кивок — вокруг оси ушей; поворот и наклон головы — вокруг C7
    const earAx = [0, 0.76, -0.02];
    let q = add(earAx, rotX(sub(v, earAx), -(p.nod || 0) * D2R));
    q = add(BODY.c7, rotZ(rotY(sub(q, BODY.c7), (p.hYaw || 0) * D2R), (p.hTilt || 0) * D2R));
    return q;
  };
  const out = {};
  for (const k of Object.keys(BODY)) {
    let v = BODY[k];
    if (k === 're' || k === 'le' || k === 'nose') v = head(v);
    if (k === 'rs') v = add(v, [-(p.armR || 0) * 0.015, (p.shrugR || 0) + (p.armR || 0) * 0.025, 0]);
    out[k] = add(hip, lean(v));
  }
  return out;
}
export function project(P) { const Zc = P[2]; return { x: (320 + CAM.fx * P[0] / Zc) / 640, y: (240 - CAM.fx * (P[1] - CAM.y) / Zc) / 480 }; }

// ───────── шум трекера ─────────
function makeNoise(seed, o = {}) {
  const g = gaussOf(rng32(seed));
  const white = o.white ?? 1.5, ar = o.ar ?? 1.5, tau = o.tau ?? 300, outl = o.outl ?? 0.01;
  const st = {};
  return (key, t, dt) => {
    const s = st[key] || (st[key] = { x: 0, y: 0 });
    const a = Math.exp(-dt / tau), k = Math.sqrt(1 - a * a);
    s.x = s.x * a + k * ar * g(); s.y = s.y * a + k * ar * g();
    let ox = s.x + white * g(), oy = s.y + white * g();
    if (outl > 0 && Math.random() < outl) { ox += (Math.random() - 0.5) * 30; oy += (Math.random() - 0.5) * 30; }
    return { dx: ox / 640, dy: oy / 480 };
  };
}
const IDX = { nose: 0, le: 7, re: 8, ls: 11, rs: 12, lel: 13, rel: 14, lw: 15, rw: 16 };
function landmarks(p, noise, t, dt, occl) {
  const pts = bodyPoints(p);
  const arr = new Array(33).fill(null).map(() => ({ x: 0.5, y: 1.3, z: 0, visibility: 0.02 }));
  for (const [k, i] of Object.entries(IDX)) {
    const q = project(pts[k]); const n = noise(k, t, dt);
    let vis = k === 'rw' || k === 'lw' ? 0.3 : 0.98;
    let x = q.x + n.dx, y = q.y + n.dy;
    if (occl && occl[k]) { x += occl[k][0]; y += occl[k][1]; vis = 0.55; }
    arr[i] = { x, y, z: 0, visibility: vis };
  }
  return arr;
}

// ───────── сценарии ─────────
// сегмент: [t0, rampMs, holdMs, backMs, params]
function envelope(t, t0, ramp, hold, back) {
  const s = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  if (t < t0) return 0;
  if (t < t0 + ramp) return s((t - t0) / ramp);
  if (t < t0 + ramp + hold) return 1;
  if (back === Infinity) return 1;
  return 1 - s((t - t0 - ramp - hold) / back);
}
function scenarioParams(sc, t) {
  const p = {};
  for (const [t0, ramp, hold, back, par] of sc.segs) {
    const e = envelope(t, t0, ramp, hold, back);
    for (const [k, v] of Object.entries(par)) {
      if (k === 'osc') continue;
      p[k] = (p[k] || 0) + v * e;
    }
    if (par.osc && e > 0) for (const [k, amp, hz] of par.osc) p[k] = (p[k] || 0) + amp * e * Math.sin(2 * Math.PI * hz * (t - t0) / 1000);
  }
  return p;
}
const T0 = 3000; // после калибровки и покоя
const SC = {
  // намерения
  I_right: { kind: 'intent', dir: [1, 0], segs: [[T0, 250, 2000, 250, { lat: 12 }]] },
  I_left: { kind: 'intent', dir: [-1, 0], segs: [[T0, 250, 2000, 250, { lat: -12 }]] },
  I_fwd: { kind: 'intent', dir: [0, 1], segs: [[T0, 300, 2000, 300, { fwd: 15 }]] },
  I_back: { kind: 'intent', dir: [0, -1], segs: [[T0, 300, 2000, 300, { fwd: -9 }]] },
  I_fr: { kind: 'intent', dir: [0.707, 0.707], segs: [[T0, 300, 2000, 300, { lat: 9, fwd: 11 }]] },
  I_bl: { kind: 'intent', dir: [-0.707, -0.707], segs: [[T0, 300, 2000, 300, { lat: -9, fwd: -7 }]] },
  I_walk: { kind: 'intent', dir: [1, 0], segs: [[T0, 300, 2000, 300, { lat: 7 }]] },
  // уклоны
  D_right: { kind: 'dash', dir: [1, 0], segs: [[T0, 180, 200, 400, { lat: 22 }]] },
  D_left: { kind: 'dash', dir: [-1, 0], segs: [[T0, 180, 200, 400, { lat: -22 }]] },
  D_fwd: { kind: 'dash', dir: [0, 1], segs: [[T0, 200, 200, 400, { fwd: 22 }]] },
  D_back: { kind: 'dash', dir: [0, -1], segs: [[T0, 200, 200, 400, { fwd: -13 }]] },
  // быстрый старт бега (рывком не должен стать)
  F_runstart: { kind: 'intent', dir: [1, 0], segs: [[T0, 200, 1500, 300, { lat: 14 }]] },
  // помехи
  X_shrug: { kind: 'noise', segs: [[T0, 300, 2000, 300, { shrugR: 0.04 }]] },
  X_headTilt: { kind: 'noise', segs: [[T0, 300, 2000, 300, { hTilt: 18 }]] },
  X_nod: { kind: 'noise', segs: [[T0, 300, 2000, 300, { nod: 25 }]] },
  X_twist: { kind: 'noise', segs: [[T0, 300, 1500, 300, { twist: 20 }]] },
  X_headYaw: { kind: 'noise', segs: [[T0, 300, 2000, 300, { hYaw: 20 }]] },
  X_lookHand: { kind: 'noise', segs: [[T0, 300, 2000, 300, { twist: 12, hYaw: 12, nod: 15 }]] },
  X_slide: { kind: 'noise', segs: [[T0, 1200, 3000, Infinity, { slideX: -0.05 }]] },
  X_scootBack: { kind: 'noise', segs: [[T0, 1000, 3000, Infinity, { dist: 0.08 }]] },
  X_armRaise: { kind: 'noise', segs: [[T0, 300, 3000, 300, { armR: 1 }]] },
  X_slash: { kind: 'noise', lock: [[T0 + 50, 550, 'freeze']], segs: [[T0, 150, 0, 300, { twist: 22, lat: 5, hYaw: 15 }]] },
  X_slashNoLock: { kind: 'noise', segs: [[T0, 150, 0, 300, { twist: 22, lat: 5, hYaw: 15 }]] },
  X_throw: { kind: 'noise', lock: [[T0 + 60, 700, 'freeze']], segs: [[T0, 250, 100, 400, { fwd: 6 }]] },
  X_throwNoLock: { kind: 'noise', segs: [[T0, 250, 100, 400, { fwd: 6 }]] },
  X_rune: { kind: 'noise', lock: [[T0, 2300, 'strict']], occl: { re: [0.012, -0.01], rs: [0.0, -0.01] }, occlFrac: 0.5,
    segs: [[T0, 300, 2000, 300, { shrugR: 0.03, twist: 8, hYaw: 10, hTilt: 5, armR: 1, osc: [['twist', 4, 1.2], ['hYaw', 6, 1.2], ['shrugR', 0.01, 1.2]] }]] },
  X_runeNoLock: { kind: 'noise', occl: { re: [0.012, -0.01], rs: [0.0, -0.01] }, occlFrac: 0.5,
    segs: [[T0, 300, 2000, 300, { shrugR: 0.03, twist: 8, hYaw: 10, hTilt: 5, armR: 1, osc: [['twist', 4, 1.2], ['hYaw', 6, 1.2], ['shrugR', 0.01, 1.2]] }]] },
  // каст на ходу: бег вправо + руна
  M_runRune: { kind: 'intent', dir: [1, 0], lock: [[T0 + 800, 1500, 'strict']], occl: { re: [0.012, -0.01] }, occlFrac: 0.5, occlFrom: T0 + 800,
    segs: [[T0, 250, 2500, 250, { lat: 12 }], [T0 + 800, 300, 1000, 300, { shrugR: 0.03, twist: 8, hYaw: 10, hTilt: 5, armR: 1 }]] },
  N_idle: { kind: 'noise', segs: [], dur: 20000 },
};

// ───────── прототип нового алгоритма ─────────
export const TJ = {
  rhoFull: 12, tsFull: 0.285, thFull: 0.42,     // полный наклон вбок: 12° крена плеч, 0.285 sw сдвига плеч, 0.42 sw сдвига головы
  fwdFull: 0.12, backFull: 0.075,               // полный наклон вперёд +12 % ширины, назад −7.5 %
  latOn: 0.42, latOff: 0.3, fwdOn: 0.4, fwdOff: 0.28, backOn: 0.45, backOff: 0.32,
  runOn: 0.85, runOff: 0.7, walkMin: 0.25, walkMax: 0.6, snapDeg: 12,
  confirmMs: 60, strictK: 1.35,
  oeMin: 1.5, oeBeta: 0.8, oeD: 1.0,           // One Euro: мин. срез (Гц), бета (Гц на ед./с), срез производной
  fastTau: 25,
  preFreezeMs: 120, freezeMaxMs: 700, freezeDecayMs: 200, lockTailMs: 100,
  dashAmp: 1.5, dashAmpBack: 1.3, dashDelta: 0.9, dashFrom: 1.1, dashWindowMs: 300, dashSpeed: 4.0,
  dashRearm: 1.0, dashRearmMs: 150, dashRefractoryMs: 600, dashFreezeMs: 350, dashAlign: 0.7,
  yawMaxDeg: 22, noseK: 0.73,
};
function oneEuro(cfg) {
  let x = null, dx = 0, lt = null;
  const alpha = (dt, fc) => 1 - Math.exp(-2 * Math.PI * fc * dt);
  return (t, v) => {
    if (x === null) { x = v; lt = t; return v; }
    const dt = Math.max(1e-3, (t - lt) / 1000); lt = t;
    const d = (v - x) / dt; dx += (d - dx) * alpha(dt, cfg.oeD);
    const fc = cfg.oeMin + cfg.oeBeta * Math.abs(dx);
    x += (v - x) * alpha(dt, fc); return x;
  };
}
const agree = (a, b) => (a === null ? b : b === null ? a : Math.sign(a) === Math.sign(b) ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0);
export function createTorsoJoy(over = {}) {
  const C = { ...TJ, ...over };
  let base = null; const cal = [];
  const F = { r: oneEuro(C), ts: oneEuro(C), th: oneEuro(C), ds: oneEuro(C), de: oneEuro(C) };
  let fast = null, fastT = null;
  const s = { latOn: false, depOn: false, latSince: null, depSince: null, running: false, out: { x: 0, z: 0 }, hist: [], outHist: [],
    lock: null, lockSince: null, lockEnd: null, frozen: null, dashArmed: false, slowSince: null, refr: -Infinity, dashFreezeUntil: -Infinity, dashFreeze: null, pending: null, lastRaw: null };
  function witnesses(lms, aspect, occl) {
    const P = (i) => ({ X: lms[i].x * aspect, Y: lms[i].y, c: lms[i].visibility });
    const Sr = P(12), Sl = P(11), Er = P(8), El = P(7), N = P(0);
    const shOk = Sr.c >= 0.5 && Sl.c >= 0.5 && !(occl && (occl.rs || occl.ls));
    const earOk = Er.c >= 0.5 && El.c >= 0.5 && !(occl && (occl.re || occl.le));
    const ws = Math.hypot(Sl.X - Sr.X, Sl.Y - Sr.Y), c0 = aspect / 2;
    const we = Math.hypot(El.X - Er.X, El.Y - Er.Y);
    const smx = (Sr.X + Sl.X) / 2, emx = (Er.X + El.X) / 2;
    return {
      shOk, earOk, ws, we,
      rho: Math.atan2(-(Sl.Y - Sr.Y), Sl.X - Sr.X) / D2R,
      sx: (smx - c0) / ws, ex: (emx - c0) / ws, off: (N.X - emx) / Math.max(1e-4, we),
    };
  }
  function calibrate(w) { cal.push(w); }
  function finishCal() {
    const med = (k) => { const v = cal.map((w) => w[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    base = { rho: med('rho'), sx: med('sx'), ex: med('ex'), ws: med('ws'), we: med('we'), off: med('off') };
  }
  function push({ t, lms, aspect = 4 / 3, occl = null, lock = null }) {
    const w = witnesses(lms, aspect, occl);
    if (!base) { calibrate(w); return; }
    // сырые свидетели (+ — к своей правой / вперёд)
    const yaw = Math.atan((w.off - base.off) / C.noseK) / D2R;
    const r = w.shOk ? (w.rho - base.rho) / C.rhoFull : null;
    const ts = w.shOk ? -(w.sx - base.sx) / C.tsFull : null;
    const th = w.shOk && w.earOk ? -(w.ex - base.ex) / C.thFull : null;
    const ds = w.shOk ? w.ws / base.ws - 1 : null;
    const de = w.earOk && Math.abs(yaw) <= C.yawMaxDeg ? (w.we / Math.cos(yaw * D2R)) / base.we - 1 : null;
    const fr = r === null ? null : F.r(t, r), fts = ts === null ? null : F.ts(t, ts), fth = th === null ? null : F.th(t, th);
    const fds = ds === null ? null : F.ds(t, ds), fde = de === null ? null : F.de(t, de);
    const tN = fts === null ? null : fth === null ? fts : (fts + fth) / 2;
    const lat = fr === null || tN === null ? null : agree(fr, tN);
    let dep = fds === null || fde === null ? null : agree(fds, fde);
    if (dep !== null) dep = dep >= 0 ? dep / C.fwdFull : dep / C.backFull;
    // быстрый канал для рывка: согласие сырых, лёгкое сглаживание
    const rawLat = r === null || ts === null ? null : agree(r, th === null ? ts : (ts + th) / 2);
    let rawDep = ds === null || de === null ? null : agree(ds, de);
    if (rawDep !== null) rawDep = rawDep >= 0 ? rawDep / C.fwdFull : rawDep / C.backFull;
    if (rawLat !== null && rawDep !== null) {
      if (!fast) fast = { x: rawLat, z: rawDep };
      else { const a = 1 - Math.exp(-(t - fastT) / C.fastTau); fast.x += (rawLat - fast.x) * a; fast.z += (rawDep - fast.z) * a; }
      fastT = t;
    }
    // блокировка каста
    if (lock !== s.lock) {
      if (lock === 'freeze') { s.frozen = outAt(t - C.preFreezeMs); s.lockSince = t; }
      if (!lock && s.lock === 'freeze') s.lockEnd = t;
      s.lock = lock;
    }
    const k = lock === 'strict' ? C.strictK : 1;
    // оси с гистерезисом и подтверждением
    const axis = (v, on, off, st, sinceKey) => {
      if (v === null) return { act: s[st], val: 0, hold: true };
      const a = Math.abs(v);
      if (s[st]) { if (a < off * k) s[st] = false; }
      else if (a >= on * k) { if (s[sinceKey] === null) s[sinceKey] = t; if (t - s[sinceKey] >= C.confirmMs * (lock === 'strict' ? 2 : 1)) s[st] = true; }
      else s[sinceKey] = null;
      if (!s[st]) return { act: false, val: 0 };
      s[sinceKey] = null;
      return { act: true, val: Math.sign(v) * clamp((a - off * k) / (1 - off * k), 0, 1) };
    };
    const ax = axis(lat, C.latOn, C.latOff, 'latOn', 'latSince');
    const dOn = dep !== null && dep < 0 ? C.backOn : C.fwdOn, dOff = dep !== null && dep < 0 ? C.backOff : C.fwdOff;
    const az = axis(dep, dOn, dOff, 'depOn', 'depSince');
    let out;
    if (ax.hold || az.hold) out = { ...s.out };               // свидетели недоступны — держим прежнее
    else {
      const R = Math.hypot(lat || 0, dep || 0);
      if (s.running ? R < C.runOff * k : R >= C.runOn * k) s.running = !s.running;
      const ux = ax.val, uz = az.val, m = Math.hypot(ux, uz);
      if (m < 1e-6) { out = { x: 0, z: 0 }; s.running = false; }
      else {
        let a = Math.atan2(ux, uz);
        const q = Math.PI / 2, c = Math.round(a / q) * q, d = a - c, wS = C.snapDeg * D2R;
        if (Math.abs(d) < wS) { const u = clamp((Math.abs(d) - 0.6 * wS) / (0.4 * wS), 0, 1); a = c + Math.sign(d) * wS * u * u * (3 - 2 * u); }
        const mag = s.running ? 1 : C.walkMin + (C.walkMax - C.walkMin) * clamp(m / 0.75, 0, 1);
        out = { x: Math.sin(a) * mag, z: Math.cos(a) * mag };
      }
    }
    // рывок
    detectDash(t, lock);
    s.outHist.push({ t, x: out.x, z: out.z });
    while (s.outHist.length > 60) s.outHist.shift();
    // заморозки
    if (s.lock === 'freeze' || (s.lockEnd !== null && t - s.lockEnd < C.lockTailMs)) {
      const held = t - s.lockSince;
      const fz = s.frozen || { x: 0, z: 0 };
      const dec = held <= C.freezeMaxMs ? 1 : clamp(1 - (held - C.freezeMaxMs) / C.freezeDecayMs, 0, 1);
      out = { x: fz.x * dec, z: fz.z * dec };
    } else s.lockEnd = null;
    if (t < s.dashFreezeUntil && s.dashFreeze) out = { ...s.dashFreeze };
    s.out = out;
  }
  function outAt(tt) { for (let i = s.outHist.length - 1; i >= 0; i--) if (s.outHist[i].t <= tt) return { x: s.outHist[i].x, z: s.outHist[i].z }; return { x: 0, z: 0 }; }
  function detectDash(t, lock) {
    if (!fast) return;
    s.hist.push({ t, x: fast.x, z: fast.z });
    while (s.hist.length && t - s.hist[0].t > 600) s.hist.shift();
    const mag = Math.hypot(fast.x, fast.z);
    if (!s.dashArmed) {
      if (mag <= C.dashRearm && t >= s.refr) { if (s.slowSince === null) s.slowSince = t; if (t - s.slowSince >= C.dashRearmMs) s.dashArmed = true; }
      else s.slowSince = null;
      return;
    }
    if (lock) return;
    const amp = fast.z < -0.5 * Math.abs(fast.x) ? C.dashAmpBack : C.dashAmp;
    if (mag < amp) return;
    for (let i = s.hist.length - 2; i >= 0; i--) {
      const p = s.hist[i], span = t - p.t;
      if (span > C.dashWindowMs) break;
      if (Math.hypot(p.x, p.z) > C.dashFrom) continue;
      const dx = fast.x - p.x, dz = fast.z - p.z, d = Math.hypot(dx, dz);
      if (d < C.dashDelta || d / (span / 1000) < C.dashSpeed) continue;
      if ((dx * fast.x + dz * fast.z) / (d * mag) < C.dashAlign) continue;
      // направление — к ближайшей из 8 сторон
      const a = Math.round(Math.atan2(fast.x, fast.z) / (Math.PI / 4)) * (Math.PI / 4);
      s.pending = { t, x: Math.round(Math.sin(a) * 1000) / 1000, z: Math.round(Math.cos(a) * 1000) / 1000 };
      s.dashArmed = false; s.slowSince = null; s.refr = t + C.dashRefractoryMs;
      s.dashFreeze = outAt(p.t); s.dashFreezeUntil = t + C.dashFreezeMs;
      return;
    }
  }
  return {
    push, finishCal, read: () => ({ ...s.out, running: s.running }), takeDash: () => { const d = s.pending; s.pending = null; return d; },
    get base() { return base; },
  };
}

// ───────── прогон ─────────
function run(scName, { fps = 15, seed = 1, latency = 90, algo = 'new', over = {}, noiseOpt = {} } = {}) {
  const sc = SC[scName];
  const noise = makeNoise(seed * 7919 + fps, noiseOpt);
  const r = rng32(seed * 31 + 5);
  const dur = sc.dur ? T0 + sc.dur : T0 + 3800;
  const tj = algo === 'new' ? createTorsoJoy(over) : null;
  const old = algo === 'old' ? createPoseInterpreter({ mirror: true, torsoMove: true }) : null;
  if (old) { old.setActive(true); old.beginCalibration(0); }
  let t = 0, lastT = 0; const frames = [];
  let calDone = false;
  const occlRng = rng32(seed * 97 + 3);
  while (t < dur) {
    const dt = t - lastT; lastT = t;
    const par = scenarioParams(sc, t);
    let lock = null;
    for (const [a, len, kind] of sc.lock || []) if (t >= a && t < a + len) lock = kind;
    let occl = null;
    if (sc.occl && t >= (sc.occlFrom ?? T0) && t < T0 + 2600 && occlRng() < (sc.occlFrac ?? 1)) occl = sc.occl;
    const lms = landmarks(par, noise, t, Math.max(1, dt), occl);
    const tArr = t + latency + (r() - 0.5) * 30;
    if (tj) {
      tj.push({ t: tArr, lms, occl, lock });
      if (!calDone && t >= 1600) { tj.finishCal(); calDone = true; }
      const o = tj.read(); const d = tj.takeDash();
      frames.push({ t, tArr, x: o.x, z: o.z, run: o.running, dash: d });
    } else {
      old.pushObservation({ tMs: t, frameW: 640, frameH: 480, landmarks: lms });
      const f = old.read(tArr);
      frames.push({ t, tArr, x: f.moveX, z: f.moveZ, dash: f.dash ? { x: f.dash, z: 0 } : null });
    }
    t += (1000 / fps) * (0.85 + 0.3 * r());
  }
  return frames;
}

function metrics(scName, frames) {
  const sc = SC[scName];
  const after = frames.filter((f) => f.t >= T0 - 200);
  const moving = (f) => Math.hypot(f.x, f.z) > 0.01;
  const res = {};
  const dashes = after.filter((f) => f.dash);
  res.dashes = dashes.length;
  if (sc.kind === 'intent') {
    const [ix, iz] = sc.dir;
    const good = (f) => moving(f) && (f.x * ix + f.z * iz) / Math.hypot(f.x, f.z) > Math.cos(25 * D2R);
    const on = after.find((f) => f.t >= T0 && good(f));
    res.onsetMs = on ? Math.round(on.tArr - T0) : null;
    const runF = after.find((f) => f.t >= T0 && f.run && good(f));
    res.runMs = runF ? Math.round(runF.tArr - T0) : null;
    const seg = sc.segs[0]; const holdA = T0 + seg[1] + 150, holdB = T0 + seg[1] + seg[2];
    const hold = frames.filter((f) => f.t >= holdA && f.t <= holdB);
    res.holdGood = +(hold.filter(good).length / Math.max(1, hold.length)).toFixed(3);
    const errs = hold.filter(moving).map((f) => Math.abs(Math.atan2(f.x, f.z) - Math.atan2(ix, iz)) / D2R);
    res.dirErr = errs.length ? +(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1) : null;
    const relStart = holdB; const stopF = frames.find((f) => f.t >= relStart && !moving(f));
    res.stopMs = stopF ? Math.round(stopF.tArr - relStart) : null;
    res.wrongDir = +(after.filter((f) => moving(f) && !good(f)).length / Math.max(1, after.length)).toFixed(3);
  } else if (sc.kind === 'dash') {
    const [ix, iz] = sc.dir;
    const d = dashes[0];
    res.hit = d ? (d.dash.x * ix + d.dash.z * iz > 0.7 ? 1 : 0) : 0;
    res.latMs = d ? Math.round(d.tArr - T0) : null;
  } else {
    const mv = after.filter(moving);
    res.falseShare = +(mv.length / Math.max(1, after.length)).toFixed(3);
    res.maxMag = +Math.max(0, ...after.map((f) => Math.hypot(f.x, f.z))).toFixed(2);
    // суммарный путь героя (м) при скорости: шаг 2.4 м/с при 0.62, бег 5.5
    const spd = (m) => (m <= 0.06 ? 0 : m <= 0.62 ? 2.4 * ((m - 0.06) / 0.94) / 0.62 : 2.4 + 3.1 * ((m - 0.06) / 0.94 - 0.62) / 0.38);
    let dist = 0; for (let i = 1; i < after.length; i++) dist += spd(Math.hypot(after[i].x, after[i].z)) * (after[i].t - after[i - 1].t) / 1000;
    res.driftM = +dist.toFixed(2);
  }
  return res;
}

function agg(list) {
  const out = {};
  for (const k of Object.keys(list[0])) {
    const v = list.map((o) => o[k]).filter((x) => x !== null && x !== undefined);
    if (!v.length) { out[k] = null; continue; }
    if (k === 'hit') { out[k] = `${v.reduce((a, b) => a + b, 0)}/${list.length}`; continue; }
    const sorted = [...v].sort((a, b) => a - b);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    out[k] = k.endsWith('Ms') ? `${Math.round(sorted[sorted.length >> 1])} (p90 ${Math.round(sorted[Math.floor(sorted.length * 0.9)])})` : +mean.toFixed(3);
    if (k.endsWith('Ms') && v.length < list.length) out[k] += ` [нет в ${list.length - v.length}]`;
  }
  return out;
}

const args = process.argv.slice(2);
const SEEDS = +(args.find((a) => a.startsWith('--seeds='))?.slice(8) ?? 20);
const algos = args.includes('--old') ? ['new', 'old'] : ['new'];
const fpsList = (args.find((a) => a.startsWith('--fps='))?.slice(6) ?? '10,15,30').split(',').map(Number);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
for (const algo of algos) {
  console.log(`\n===== алгоритм: ${algo} =====`);
  for (const name of Object.keys(SC)) {
    if (only && !name.startsWith(only)) continue;
    if (algo === 'old' && (name.includes('NoLock') || name.startsWith('M_'))) { /* старый не знает блокировок */ }
    for (const fps of fpsList) {
      const list = [];
      for (let sd = 1; sd <= SEEDS; sd++) list.push(metrics(name, run(name, { fps, seed: sd, algo })));
      console.log(`${name.padEnd(14)} ${String(fps).padStart(2)} fps`, JSON.stringify(agg(list)));
    }
  }
}
