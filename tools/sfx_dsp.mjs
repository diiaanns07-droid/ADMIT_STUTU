// ASHEN OATH — офлайн-DSP для запекания звуков (tools/sfx_bake.mjs). Без зависимостей.
// Всё моно, 44.1 кГц, Float32Array. Случайность — только через rng(seed): запекание повторяемо.

export const SR = 44100;
export const TAU = Math.PI * 2;

export function rng(seed) {
  let a = (seed >>> 0) || 1;
  const r = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

export const len = (sec) => Math.max(1, Math.round(sec * SR));
export const buf = (sec) => new Float32Array(len(sec));

// ---------------------------------------------------------------- огибающие
// Кусочная огибающая: точки [t, v] или [t, v, 'exp'] (экспоненциальный участок к точке).
export function curve(n, pts) {
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    while (k < pts.length - 1 && t > pts[k + 1][0]) k++;
    if (k >= pts.length - 1) { out[i] = pts[pts.length - 1][1]; continue; }
    const [t0, v0] = pts[k], [t1, v1, mode] = pts[k + 1];
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
    if (mode === 'exp' && v0 > 0 && v1 > 0) out[i] = v0 * Math.pow(v1 / v0, u);
    else if (mode === 'sin') out[i] = v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * u));
    else out[i] = v0 + (v1 - v0) * u;
  }
  return out;
}
// Удар: атака a (с), затем экспоненциальный спад с постоянной tau (с).
export function perc(n, a, tau, peak = 1) {
  const out = new Float32Array(n);
  const an = Math.max(1, Math.round(a * SR));
  for (let i = 0; i < n; i++) {
    out[i] = i < an ? peak * (i / an) * (i / an) * (3 - 2 * i / an) : peak * Math.exp(-(i - an) / (tau * SR));
  }
  return out;
}

// ---------------------------------------------------------------- генераторы
export function noise(n, kind, r) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    } else if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02; out[i] = last * 3.5;
    } else out[i] = w;
  }
  return out;
}
// Осциллятор с произвольной частотой (число или Float32Array). type: sine|tri|saw|square|pulse
// Пила/меандр — с PolyBLEP, чтобы на высоких нотах не было алиасинга («цифровой писк»).
export function osc(n, freq, type = 'sine', phase0 = 0, pw = 0.5) {
  const out = new Float32Array(n);
  let ph = phase0 % 1;
  const blep = (t, dt) => {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  };
  for (let i = 0; i < n; i++) {
    const f = typeof freq === 'number' ? freq : freq[i];
    const dt = Math.min(0.5, Math.abs(f) / SR);
    let v;
    if (type === 'sine') v = Math.sin(TAU * ph);
    else if (type === 'tri') v = 1 - 4 * Math.abs(((ph + 0.25) % 1) - 0.5);
    else if (type === 'saw') v = 2 * ph - 1 - blep(ph, dt);
    else { // square / pulse
      v = ph < pw ? 1 : -1;
      v += blep(ph, dt);
      v -= blep((ph + 1 - pw) % 1, dt);
    }
    out[i] = v;
    ph += f / SR;
    ph -= Math.floor(ph);
  }
  return out;
}

// ---------------------------------------------------------------- фильтры (RBJ biquad)
// f: число или Float32Array (частота по времени; коэффициенты пересчитываются каждые 16 отсчётов).
export function biquad(x, type, f, q = 0.707, gainDb = 0) {
  const n = x.length, out = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const coef = (fc) => {
    const w = TAU * Math.min(Math.max(fc, 10), SR * 0.49) / SR, cw = Math.cos(w), sw = Math.sin(w);
    const al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let B0, B1, B2, A0, A1, A2;
    switch (type) {
      case 'lowpass': B0 = (1 - cw) / 2; B1 = 1 - cw; B2 = (1 - cw) / 2; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case 'highpass': B0 = (1 + cw) / 2; B1 = -(1 + cw); B2 = (1 + cw) / 2; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case 'bandpass': B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; break;
      case 'peak': B0 = 1 + al * A; B1 = -2 * cw; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * cw; A2 = 1 - al / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * al;
        B0 = A * ((A + 1) - (A - 1) * cw + s); B1 = 2 * A * ((A - 1) - (A + 1) * cw); B2 = A * ((A + 1) - (A - 1) * cw - s);
        A0 = (A + 1) + (A - 1) * cw + s; A1 = -2 * ((A - 1) + (A + 1) * cw); A2 = (A + 1) + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * al;
        B0 = A * ((A + 1) + (A - 1) * cw + s); B1 = -2 * A * ((A - 1) + (A + 1) * cw); B2 = A * ((A + 1) + (A - 1) * cw - s);
        A0 = (A + 1) - (A - 1) * cw + s; A1 = 2 * ((A - 1) - (A + 1) * cw); A2 = (A + 1) - (A - 1) * cw - s; break;
      }
      default: throw new Error('biquad type ' + type);
    }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  };
  const varying = typeof f !== 'number';
  if (!varying) coef(f);
  for (let i = 0; i < n; i++) {
    if (varying && (i & 15) === 0) coef(f[i]);
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}
export const lp = (x, f, q) => biquad(x, 'lowpass', f, q ?? 0.707);
export const hp = (x, f, q) => biquad(x, 'highpass', f, q ?? 0.707);
export const bp = (x, f, q) => biquad(x, 'bandpass', f, q ?? 1);

// ---------------------------------------------------------------- операции над буферами
export function mul(x, e) { const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] * (typeof e === 'number' ? e : (e[i] ?? 0)); return o; }
export function add(dst, src, gain = 1, atSec = 0) {
  const off = Math.round(atSec * SR);
  for (let i = 0; i < src.length && i + off < dst.length; i++) if (i + off >= 0) dst[i + off] += src[i] * gain;
  return dst;
}
// Мягкая сатурация: tanh с нормировкой; drive > 1 добавляет гармоники (бас слышен на динамиках ноутбука).
export function drive(x, amount = 2) { const o = new Float32Array(x.length); const k = Math.tanh(amount); for (let i = 0; i < x.length; i++) o[i] = Math.tanh(x[i] * amount) / k; return o; }
export function peak(x) { let p = 0; for (const v of x) { const a = Math.abs(v); if (a > p) p = a; } return p; }
export function normalize(x, db = -1) { const p = peak(x) || 1, g = Math.pow(10, db / 20) / p; for (let i = 0; i < x.length; i++) x[i] *= g; return x; }
export function fadeIn(x, sec) { const n = Math.min(x.length, len(sec)); for (let i = 0; i < n; i++) x[i] *= i / n; return x; }
export function fadeOut(x, sec) { const n = Math.min(x.length, len(sec)); for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n; return x; }
// Обрезать тишину в хвосте (ниже thrDb от пика) и сделать короткое затухание.
export function trim(x, thrDb = -60, tailSec = 0.02) {
  const thr = peak(x) * Math.pow(10, thrDb / 20);
  let last = x.length - 1;
  while (last > 0 && Math.abs(x[last]) < thr) last--;
  const out = x.slice(0, Math.min(x.length, last + len(tailSec)));
  return fadeOut(out, tailSec);
}
// Модальный резонатор: сумма затухающих синусов (металл, стекло, колокол). modes: [[ratio, amp, decaySec], ...]
export function modal(n, f0, modes, r, detune = 0.002) {
  const out = new Float32Array(n);
  for (const [ratio, amp, dec] of modes) {
    const f = f0 * ratio * (1 + (r ? (r() - 0.5) * 2 * detune : 0));
    if (f >= SR * 0.45) continue;
    const ph = r ? r() : 0;
    const k = Math.exp(-1 / (dec * SR));
    let e = amp;
    for (let i = 0; i < n; i++) { out[i] += Math.sin(TAU * (f * i / SR + ph)) * e; e *= k; }
  }
  return out;
}
// Огибающая частоты: экспоненциальный переход f0 → f1 за sec.
export function sweep(n, f0, f1, sec, mode = 'exp') { return curve(n, [[0, f0], [Math.max(1e-3, sec), f1, mode]]); }

// Простая ревербация (Freeverb, моно): 8 гребенчатых + 4 фазовых фильтра.
export function reverb(x, { room = 0.8, damp = 0.35, wet = 0.25, dry = 1, pre = 0.012, tail = 1.2, scale = 1 } = {}) {
  // сухой сигнал обрывается на конце буфера — короткое затухание, иначе щелчок перед хвостом
  x = fadeOut(x.slice(), Math.min(0.06, x.length / SR / 4));
  const n = x.length + len(tail), out = new Float32Array(n), inp = new Float32Array(n);
  const preN = len(pre);
  for (let i = 0; i < x.length; i++) inp[i + preN < n ? i + preN : n - 1] += x[i];
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * scale * SR / 44100));
  const alls = [556, 441, 341, 225].map((d) => Math.round(d * scale * SR / 44100));
  const fb = 0.7 + 0.28 * room, d1 = damp, d2 = 1 - damp;
  const acc = new Float32Array(n);
  for (const L of combs) {
    const line = new Float32Array(L); let idx = 0, store = 0;
    for (let i = 0; i < n; i++) {
      const y = line[idx];
      store = y * d2 + store * d1;
      line[idx] = inp[i] * 0.015 + store * fb;
      idx = (idx + 1) % L;
      acc[i] += y;
    }
  }
  let s = acc;
  for (const L of alls) {
    const line = new Float32Array(L); let idx = 0; const o = new Float32Array(n);
    for (let i = 0; i < n; i++) { const b = line[idx]; o[i] = -s[i] + b; line[idx] = s[i] + b * 0.5; idx = (idx + 1) % L; }
    s = o;
  }
  for (let i = 0; i < n; i++) out[i] = (i < x.length ? x[i] * dry : 0) + s[i] * wet;
  return out;
}
// Бесшовная петля: последний xf секунд накладывается на начало (равномощный кроссфейд).
export function loopify(x, xf) {
  const m = len(xf), n = x.length - m, out = x.slice(0, n);
  for (let i = 0; i < m; i++) {
    const u = i / m, a = Math.cos(u * Math.PI / 2), b = Math.sin(u * Math.PI / 2);
    out[i] = x[i] * b + x[n + i] * a;
  }
  return out;
}

// ---------------------------------------------------------------- файлы
export function wav(x) {
  const n = x.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return b;
}
