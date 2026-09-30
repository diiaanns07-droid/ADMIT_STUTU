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
// ───────── прототип v2: «ведущий свидетель + подтверждающий» ─────────
export const TJ = {
  // полный наклон (=1.0): вбок 12° ⇔ сдвиг середины плеч 0.285 sw; крен плеч 12°; голова 0.42 sw
  tsFull: 0.285, rhoFull: 12, thFull: 0.42,
  fwdFull: 0.14, backFull: 0.075,               // ширина плеч +14 % (≈13° вперёд) / −7.5 % (≈9° назад)
  kLat: 0.5, kLatArm: 0.8, kDep: 0.6,           // подтверждение: второй свидетель ≥ k·ведущего
  latOn: 0.42, latOff: 0.3, fwdOn: 0.4, fwdOff: 0.28, backOn: 0.5, backOff: 0.35,
  runOn: 0.85, runOff: 0.7, walkMin: 0.25, walkMax: 0.6, snapDeg: 18, snap8: true, dashLateralOnly: true,
  confirmMs: 40, strictK: 1.35,
  primMin: 2.5, primBeta: 1.0, confMin: 1.5, confBeta: 0.8, oeD: 1.0,
  fastTau: 30, kDash: 0.6,
  preFreezeMs: 120, freezeMaxMs: 700, freezeDecayMs: 200, lockTailMs: 100,
  dashAmp: 1.25, dashAmpFwd: 1.35, dashAmpBack: 1.2, dashDelta: 0.8, dashFrom: 1.15, dashWindowMs: 300, dashMinSpan: 80, dashSpeed: 7.0, dashSpeedVeryLow: 5.0, dashAmpVeryLow: 1.45, dashSpeedBack: 6.5,
  dashRearm: 1.0, dashRearmMs: 150, dashRefractoryMs: 600, dashFreezeMs: 350, dashAlign: 0.7, dashFrames: 2, dashFramesLowFps: 1, lowFpsMs: 85,
  yawMaxDeg: 22, yawDepthGate: 14, noiseK: 3, noseK: 0.73,
};
function oneEuro(minC, beta, dC) {
  let x = null, dx = 0, lt = null;
  const alpha = (dt, fc) => 1 - Math.exp(-2 * Math.PI * fc * dt);
  return (t, v) => {
    if (x === null) { x = v; lt = t; return v; }
    const dt = Math.max(1e-3, (t - lt) / 1000); lt = t;
    const d = (v - x) / dt; dx += (d - dx) * alpha(dt, dC);
    x += (v - x) * alpha(dt, minC + beta * Math.abs(dx)); return x;
  };
}
// ведущий m подтверждается свидетелем c: выход m·clamp(c·sign(m) / (k·|m|), 0, 1)
const confirm = (m, c, k) => { if (m === null) return null; if (c === null) return m; const a = Math.abs(m); if (a < 0.05) return m; return m * clamp((c * Math.sign(m)) / (k * a), 0, 1); };
export function createTorsoJoy(over = {}) {
  const C = { ...TJ, ...over };
  let base = null; const cal = [];
  const F = { ts: oneEuro(C.primMin, C.primBeta, C.oeD), ds: oneEuro(C.dsMin ?? C.primMin, C.dsBeta ?? C.primBeta, C.oeD), r: oneEuro(C.confMin, C.confBeta, C.oeD), th: oneEuro(C.confMin + 0.5, C.confBeta, C.oeD), de: oneEuro(C.confMin, C.confBeta, C.oeD) };
  let fast = null, fastT = null;
  const s = { latOn: false, depOn: false, latSince: null, depSince: null, running: false, out: { x: 0, z: 0 }, hist: [], outHist: [],
    lock: null, lockSince: null, lockEnd: null, frozen: null, dashArmed: false, slowSince: null, refr: -Infinity, dashFreezeUntil: -Infinity, dashFreeze: null, pending: null, above: 0, dbg: null };
  function witnesses(lms, aspect, occl) {
    const P = (i) => ({ X: lms[i].x * aspect, Y: lms[i].y, c: lms[i].visibility });
    const Sr = P(12), Sl = P(11), Er = P(8), El = P(7), N = P(0);
    const shOk = Sr.c >= 0.5 && Sl.c >= 0.5 && !(occl && (occl.rs || occl.ls));
    const earOk = Er.c >= 0.5 && El.c >= 0.5 && !(occl && (occl.re || occl.le));
    const ws = Math.hypot(Sl.X - Sr.X, Sl.Y - Sr.Y), c0 = aspect / 2;
    const we = Math.hypot(El.X - Er.X, El.Y - Er.Y);
    const smx = (Sr.X + Sl.X) / 2, emx = (Er.X + El.X) / 2;
    return { shOk, earOk, ws, we, rho: Math.atan2(-(Sl.Y - Sr.Y), Sl.X - Sr.X) / D2R, sx: (smx - c0) / ws, ex: (emx - c0) / ws, off: (N.X - emx) / Math.max(1e-4, we) };
  }
  function finishCal() {
    const med = (k) => { const v = cal.map((w) => w[k]).sort((a, b) => a - b); return v[v.length >> 1]; };
    base = { rho: med('rho'), sx: med('sx'), ex: med('ex'), ws: med('ws'), we: med('we'), off: med('off') };
    // шум калибровки (MAD) → адаптивные мёртвые зоны: порог не ниже noiseK·σ после фильтра (≈0.8·σ сырого)
    const mad = (arr) => { const v = [...arr].sort((a, b) => a - b), m = v[v.length >> 1]; const d = v.map((x) => Math.abs(x - m)).sort((a, b) => a - b); return 1.4826 * d[d.length >> 1]; };
    const sTs = 0.8 * mad(cal.map((w) => w.sx)) / C.tsFull, sDs = 0.8 * mad(cal.map((w) => w.ws)) / base.ws;
    if (C.noiseK > 0) {
      C.latOn = Math.max(C.latOn, C.noiseK * sTs); C.latOff = Math.max(C.latOff, 0.7 * C.latOn);
      C.fwdOn = Math.max(C.fwdOn, C.noiseK * sDs / C.fwdFull); C.fwdOff = Math.max(C.fwdOff, 0.7 * C.fwdOn);
      C.backOn = Math.max(C.backOn, C.noiseK * sDs / C.backFull); C.backOff = Math.max(C.backOff, 0.7 * C.backOn);
    }
    base.noise = { sTs, sDs, latOn: C.latOn, fwdOn: C.fwdOn, backOn: C.backOn };
  }
  function signals(w, armUp) {
    const yaw = Math.atan((w.off - base.off) / C.noseK) / D2R;
    return {
      yaw,
      ts: w.shOk ? -(w.sx - base.sx) / C.tsFull : null,
      r: w.shOk && !armUp ? (w.rho - base.rho) / C.rhoFull : null,
      th: w.shOk && w.earOk ? -(w.ex - base.ex) / C.thFull : null,
      ds: w.shOk ? w.ws / base.ws - 1 : null,
      de: w.earOk && Math.abs(yaw) <= C.yawMaxDeg ? (w.we / Math.cos(yaw * D2R)) / base.we - 1 : null,
      yawBad: w.earOk && Math.abs(yaw) > C.yawDepthGate,
    };
  }
  function combine(S, armUp, kd = 1) {
    const lat = armUp ? confirm(S.ts, S.th, C.kLatArm * kd) : confirm(S.ts, S.r ?? S.th, (S.r !== null ? C.kLat : C.kLatArm) * kd);
    let dep = S.yawBad ? (S.ds === null ? null : 0) : confirm(S.ds, S.de, C.kDep * kd);
    if (dep !== null) dep = dep >= 0 ? dep / C.fwdFull : dep / C.backFull;
    return { lat, dep };
  }
  function push({ t, lms, aspect = 4 / 3, occl = null, lock = null, armUp = false }) {
    const w = witnesses(lms, aspect, occl);
    if (!base) { cal.push(w); return; }
    const S = signals(w, armUp);
    const Sf = { yawBad: S.yawBad, ts: S.ts === null ? null : F.ts(t, S.ts), ds: S.ds === null ? null : F.ds(t, S.ds), r: S.r === null ? null : F.r(t, S.r), th: S.th === null ? null : F.th(t, S.th), de: S.de === null ? null : F.de(t, S.de) };
    const { lat, dep } = combine(Sf, armUp);
    // быстрый канал рывка: все свидетели сырые с лёгкой EMA, подтверждение мягче (kDash)
    {
      const keys = ['ts', 'ds', 'r', 'th', 'de'];
      if (!fast) fast = {};
      const a = fastT === null ? 1 : 1 - Math.exp(-(t - fastT) / C.fastTau);
      for (const kk of keys) { const v = S[kk]; if (v === null) { fast[kk] = null; continue; } fast[kk] = fast[kk] === null || fast[kk] === undefined ? v : fast[kk] + (v - fast[kk]) * a; }
      fastT = t;
    }
    const fv = S.ts !== null && S.ds !== null ? combine({ ...fast, yawBad: S.yawBad }, armUp, C.kDash) : null;
    if (lock !== s.lock) {
      if (lock === 'freeze') { s.frozen = outAt(t - C.preFreezeMs); s.lockSince = t; }
      if (!lock && s.lock === 'freeze') s.lockEnd = t;
      s.lock = lock;
    }
    const k = lock === 'strict' ? C.strictK : 1;
    const axis = (v, on, off, st, sinceKey) => {
      if (v === null) return { val: 0, hold: true };
      const a = Math.abs(v);
      if (s[st]) { if (a < off * k) s[st] = false; }
      else if (a >= on * k) { if (s[sinceKey] === null) s[sinceKey] = t; if (t - s[sinceKey] >= C.confirmMs * (lock === 'strict' ? 2 : 1)) s[st] = true; }
      else s[sinceKey] = null;
      if (!s[st]) return { val: 0 };
      s[sinceKey] = null;
      return { val: v };  // направление — по сырому вектору (радиальная мёртвая зона не искажает диагонали)
    };
    const ax = axis(lat, C.latOn, C.latOff, 'latOn', 'latSince');
    const back = dep !== null && dep < 0;
    const az = axis(dep, back ? C.backOn : C.fwdOn, back ? C.backOff : C.fwdOff, 'depOn', 'depSince');
    let out;
    if (ax.hold || az.hold) out = { ...s.out };
    else {
      const R = Math.hypot(lat || 0, dep || 0);
      if (s.running ? R < C.runOff * k : R >= C.runOn * k) s.running = !s.running;
      const ux = ax.val, uz = az.val, m = Math.hypot(ux, uz);
      if (m < 1e-6) { out = { x: 0, z: 0 }; s.running = false; }
      else {
        let a = Math.atan2(ux, uz);
        const q = C.snap8 ? Math.PI / 4 : Math.PI / 2, c = Math.round(a / q) * q, d = a - c, wS = C.snapDeg * D2R;
        if (Math.abs(d) < wS) { const u = clamp((Math.abs(d) - 0.6 * wS) / (0.4 * wS), 0, 1); a = c + Math.sign(d) * wS * u * u * (3 - 2 * u); }
        const mag = s.running ? 1 : C.walkMin + (C.walkMax - C.walkMin) * clamp((m - 0.4) / (C.runOn - 0.4), 0, 1);
        out = { x: Math.sin(a) * mag, z: Math.cos(a) * mag };
      }
    }
    if (fv && fv.lat !== null && fv.dep !== null) detectDash(t, lock, fv);
    s.outHist.push({ t, x: out.x, z: out.z });
    while (s.outHist.length > 60) s.outHist.shift();
    if (s.lock === 'freeze' || (s.lockEnd !== null && t - s.lockEnd < C.lockTailMs)) {
      const held = t - s.lockSince;
      const fz = s.frozen || { x: 0, z: 0 };
      const dec = held <= C.freezeMaxMs ? 1 : clamp(1 - (held - C.freezeMaxMs) / C.freezeDecayMs, 0, 1);
      out = { x: fz.x * dec, z: fz.z * dec };
    } else s.lockEnd = null;
    if (t < s.dashFreezeUntil && s.dashFreeze) out = { ...s.dashFreeze };
    s.out = out;
    s.dbg = { lat, dep, fv, armed: s.dashArmed, S, fast: { ...fast } };
  }
  function outAt(tt) { for (let i = s.outHist.length - 1; i >= 0; i--) if (s.outHist[i].t <= tt) return { x: s.outHist[i].x, z: s.outHist[i].z }; return { x: 0, z: 0 }; }
  function detectDash(t, lock, fv) {
    const v = { x: fv.lat, z: fv.dep };
    if (s.hist.length) s.frameMs = s.frameMs === undefined ? t - s.hist[s.hist.length - 1].t : s.frameMs + (t - s.hist[s.hist.length - 1].t - s.frameMs) * 0.1;
    s.hist.push({ t, ...v });
    while (s.hist.length && t - s.hist[0].t > 600) s.hist.shift();
    const mag = Math.hypot(v.x, v.z);
    if (!s.dashArmed) {
      if (mag <= C.dashRearm && t >= s.refr) { if (s.slowSince === null) s.slowSince = t; if (t - s.slowSince >= C.dashRearmMs) s.dashArmed = true; }
      else s.slowSince = null;
      return;
    }
    if (lock) { s.above = 0; return; }
    if (C.dashLateralOnly && Math.abs(v.x) < Math.abs(v.z) * 1.4) { s.above = 0; return; }   // только вбок (±35°)
    const amp = v.z < -Math.abs(v.x) ? C.dashAmpBack : v.z > Math.abs(v.x) ? C.dashAmpFwd : C.dashAmp;
    if (mag < amp) { s.above = 0; return; }
    s.above++;
    if (s.above < (s.frameMs > C.lowFpsMs ? C.dashFramesLowFps : C.dashFrames)) return;
    const isBack = v.z < -Math.abs(v.x);
    for (let i = s.hist.length - 2; i >= 0; i--) {
      const p = s.hist[i], span = t - p.t;
      if (span > C.dashWindowMs + 120) break;
      if (span < C.dashMinSpan || Math.hypot(p.x, p.z) > C.dashFrom) continue;
      const dx = v.x - p.x, dz = v.z - p.z, d = Math.hypot(dx, dz);
      const vMin = isBack ? C.dashSpeedBack : s.frameMs > 120 ? C.dashSpeedVeryLow : C.dashSpeed;
      if (d < C.dashDelta || d / (span / 1000) < vMin || (s.frameMs > 120 && mag < C.dashAmpVeryLow)) continue;
      if ((dx * v.x + dz * v.z) / (d * mag) < C.dashAlign) continue;
      const a = Math.round(Math.atan2(v.x, v.z) / (Math.PI / 4)) * (Math.PI / 4);
      s.pending = { t, x: +Math.sin(a).toFixed(3), z: +Math.cos(a).toFixed(3) };
      s.dashArmed = false; s.slowSince = null; s.refr = t + C.dashRefractoryMs; s.above = 0;
      s.dashFreeze = outAt(p.t); s.dashFreezeUntil = t + C.dashFreezeMs;
      return;
    }
  }
  return {
    push, finishCal, calibrate: (lms, aspect = 4 / 3) => cal.push(witnesses(lms, aspect, null)),
    read: () => ({ ...s.out, running: s.running }), takeDash: () => { const d = s.pending; s.pending = null; return d; }, dbg: () => s.dbg,
    truth: (lms, armUp = false) => { const S = signals(witnesses(lms, 4 / 3, null), armUp); return combine(S, armUp); },
    get base() { return base; },
  };
}

// ───────── прогон ─────────
export function run(scName, { fps = 15, seed = 1, latency = 90, algo = 'new', over = {}, noiseOpt = {} } = {}) {
  const sc = SC[scName];
  const noise = makeNoise(seed * 7919 + fps, noiseOpt);
  const zero = () => ({ dx: 0, dy: 0 });
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
    const armUp = (par.armR || 0) > 0.5;
    const lms = landmarks(par, noise, t, Math.max(1, dt), occl);
    const tArr = t + latency + (r() - 0.5) * 30;
    if (tj) {
      tj.push({ t, lms, occl, lock, armUp });
      if (!calDone && t >= 1600) { tj.finishCal(); calDone = true; }
      const o = tj.read(); const d = tj.takeDash();
      const tr = calDone ? tj.truth(landmarks(par, zero, t, 1, null), armUp) : null;
      frames.push({ t, tArr, x: o.x, z: o.z, run: o.running, dash: d, tr, dbg: tj.dbg(), base: tj.base });
    } else {
      old.pushObservation({ tMs: t, frameW: 640, frameH: 480, landmarks: lms });
      const f = old.read(tArr);
      frames.push({ t, tArr, x: f.moveX, z: f.moveZ, dash: f.dash ? { x: f.dash, z: 0 } : null });
    }
    t += (1000 / fps) * (0.85 + 0.3 * r());
  }
  return frames;
}

export function metrics(scName, frames, latency = 90) {
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
    // алгоритмическая задержка: от пересечения порога «истинным» (без шума) сигналом + задержка трекера
    const cross = frames.find((f) => f.t >= T0 && f.tr && Math.max(Math.abs(f.tr.lat || 0) / TJ.latOn, Math.abs(f.tr.dep || 0) / ((f.tr.dep || 0) < 0 ? TJ.backOn : TJ.fwdOn)) >= 1);
    res.algoMs = on && cross ? Math.round(on.tArr - cross.t - latency) : null;
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
    if (k === 'dashes') { out[k] = v.reduce((a, b) => a + b, 0); continue; }
    const sorted = [...v].sort((a, b) => a - b);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    out[k] = k.endsWith('Ms') ? `${Math.round(sorted[sorted.length >> 1])} (p90 ${Math.round(sorted[Math.floor(sorted.length * 0.9)])})` : +mean.toFixed(3);
    if (k.endsWith('Ms') && v.length < list.length) out[k] += ` [нет в ${list.length - v.length}]`;
  }
  return out;
}

const args = process.argv.slice(2);
const SEEDS = +(args.find((a) => a.startsWith('--seeds='))?.slice(8) ?? 20);
const algos = args.includes('--old') ? ['new', 'old'] : args.includes('--oldonly') ? ['old'] : ['new'];
const fpsList = (args.find((a) => a.startsWith('--fps='))?.slice(6) ?? '10,15,30').split(',').map(Number);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const noiseArg = args.find((a) => a.startsWith('--noise='))?.slice(8);
const noiseOpt = noiseArg ? { white: +noiseArg.split(',')[0], ar: +noiseArg.split(',')[1] } : {};
const overArg = args.find((a) => a.startsWith('--over='))?.slice(7);
const over = overArg ? JSON.parse(overArg) : {};
for (const algo of algos) {
  console.log(`\n===== алгоритм: ${algo} ${noiseArg ? 'шум ' + noiseArg : ''} ${overArg || ''} =====`);
  for (const name of Object.keys(SC)) {
    if (only && !only.split('|').some((o) => name.startsWith(o))) continue;
    for (const fps of fpsList) {
      const list = [];
      for (let sd = 1; sd <= SEEDS; sd++) list.push(metrics(name, run(name, { fps, seed: sd, algo, noiseOpt, over })));
      console.log(`${name.padEnd(14)} ${String(fps).padStart(2)} fps`, JSON.stringify(agg(list)));
    }
  }
}
