// ASHEN OATH — запекание звуков игры в assets/sfx/*.ogg.
// Запуск: node tools/sfx_bake.mjs [имя ...]   (нужен ffmpeg с libvorbis в PATH)
// Звуки собственные: синтез офлайн (tools/sfx_dsp.mjs), без чужих сэмплов. Детерминированно (rng(seed)).
// В рантайме каждый звук — один AudioBufferSourceNode (modules/sfx.js), поэтому здесь можно позволить
// тяжёлую обработку: десятки слоёв, сатурацию, модальный металл, ревербацию.
//
// Правила микса: всё нормируется к пику -1 dBFS; громкость задаёт таблица SFX в modules/sfx.js.
// Бас всегда с сатурацией — гармоники 150–600 Гц слышны на динамиках ноутбука, чистый саб — нет.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SR, rng, len, buf, curve, perc, noise, osc, biquad, lp, hp, bp, mul, add, drive, normalize, fadeIn, fadeOut,
  trim, modal, sweep, reverb, loopify, wav,
} from './sfx_dsp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'sfx');

// Частота ноты по имени: 'A4' = 440, '#' и 'b' поддерживаются.
const NOTE = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
function hz(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  const semi = NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * Math.pow(2, semi / 12);
}

// Гранулы «крошки»: короткие щелчки в полосе (гравий, камень, угли).
function grains(n, r, { count, t0 = 0, t1 = 0.1, f0 = 2000, f1 = 5000, q = 2, dur = [0.004, 0.012], amp = [0.3, 1] }) {
  const out = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const d = r.range(dur[0], dur[1]);
    const g = mul(noise(len(d), 'white', r), perc(len(d), 0.0005, d / 3, r.range(amp[0], amp[1])));
    add(out, bp(g, r.range(f0, f1), q), 1, r.range(t0, t1));
  }
  return out;
}
// «Брасс»: стопка расстроенных пил через фильтр, который открывается в атаке (как у духовых).
function brass(sec, f, r, { amp = 1, open = 2600, attack = 0.04, release = 0.4, voices = 3, vib = 0 } = {}) {
  const n = len(sec), out = new Float32Array(n);
  for (let v = 0; v < voices; v++) {
    const det = 1 + (v - (voices - 1) / 2) * 0.004 + r.range(-0.001, 0.001);
    const fr = new Float32Array(n);
    for (let i = 0; i < n; i++) fr[i] = f * det * (1 + vib * Math.sin(2 * Math.PI * 5.2 * i / SR) * Math.min(1, i / SR / 0.3));
    add(out, osc(n, fr, 'saw', r()), 1 / voices);
  }
  const fc = curve(n, [[0, f * 1.5], [attack * 2, open, 'exp'], [sec, Math.max(f * 2, open * 0.45), 'exp']]);
  const e = curve(n, [[0, 0], [attack, 1], [attack + 0.12, 0.8], [Math.max(attack + 0.13, sec - release), 0.7], [sec, 0]]);
  return mul(biquad(out, 'lowpass', fc, 0.9), mul(e, amp));
}
// Колокольчик/кристалл: почти гармонические моды, мягкая атака без щелчка.
// Колокольчик/кристалл: стеклянные (негармонические) моды и короткий удар — звон, а не «пищалка» из синусов.
function bell(sec, f, r, { amp = 1, bright = 1, decay = 1 } = {}) {
  const n = len(sec);
  const x = modal(n, f, [[1, 1, 0.9 * decay], [2.0, 0.3 * bright, 0.45 * decay], [2.76, 0.35 * bright, 0.3 * decay], [5.4, 0.18 * bright, 0.12 * decay], [8.93, 0.08 * bright, 0.05 * decay]], r, 0.001);
  add(x, mul(hp(noise(n, 'white', r), 4000), perc(n, 0.0003, 0.003, 0.5 * bright)));
  return mul(x, curve(n, [[0, 0], [0.003, amp], [sec * 0.6, amp], [sec, 0, 'sin']])); // хвост гаснет, а не обрывается
}
// Петля для loop=true: после конца — копия первых 0,1 с. Vorbis при декодировании в Chromium дописывает
// хвост-паддинг; в игре петля идёт по loopEnd = SFX[...].len, и паддинг за ним не слышен.
function loopTail(x) { const t = x.slice(0, len(0.1)), out = new Float32Array(x.length + t.length); out.set(x); out.set(t, x.length); return out; }

// ================================================================== рецепты
// Каждый рецепт: (r, i) => Float32Array; i — номер варианта (повторы звучат по-разному).
const R = {};

// ---- шаг по камню/пеплу: глухой удар пятки + хруст пепла. Тихий, короткий.
R.step = (r) => {
  const n = len(0.2), x = new Float32Array(n);
  add(x, mul(lp(noise(n, 'brown', r), r.range(260, 380), 0.9), perc(n, 0.002, 0.022, 1.0)));
  add(x, mul(bp(noise(n, 'white', r), r.range(1800, 2600), 0.7), perc(n, 0.001, 0.010, 0.45)));
  add(x, mul(bp(noise(n, 'pink', r), r.range(600, 900), 0.9), perc(n, 0.001, 0.018, 1.2)));  // слышно на ноутбуке
  add(x, grains(n, r, { count: 6, t0: 0.004, t1: 0.06, f0: 2500, f1: 6000, q: 1.5, amp: [0.1, 0.3] }));
  add(x, mul(osc(n, sweep(n, r.range(150, 170), 90, 0.05), 'sine'), perc(n, 0.002, 0.03, 0.12)));
  return trim(x, -50);
};

// ---- рывок: «свист» воздуха с доплером (полоса шума вверх-вниз) + тонкий свист.
R.dash = (r) => {
  const n = len(0.6), x = new Float32Array(n);
  const fc = curve(n, [[0, 380], [0.11, r.range(2100, 2600), 'exp'], [0.42, 520, 'exp']]);
  const e = curve(n, [[0, 0], [0.09, 1, 'sin'], [0.45, 0, 'sin']]);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', fc, 1.3), mul(e, 2.2)));
  add(x, mul(hp(noise(n, 'white', r), 3500), mul(e, 0.12)));
  const wf = curve(n, [[0, 700], [0.11, 1500, 'exp'], [0.4, 650, 'exp']]);
  add(x, mul(osc(n, wf, 'sine'), mul(e, 0.035)));
  add(x, mul(lp(noise(n, 'brown', r), 240), mul(e, 0.5)));
  return trim(normalize(reverb(x, { room: 0.5, wet: 0.12, tail: 0.3 }), -1), -55);
};

// ---- рассечение: резкий свист клинка + металлический «шинг» + мягкий удар воздуха.
R.slash = (r) => {
  const n = len(0.6), x = new Float32Array(n);
  const fc = curve(n, [[0, 1200], [0.06, r.range(2600, 3200), 'exp'], [0.2, 1600, 'exp']]);
  const e = curve(n, [[0, 0], [0.05, 1, 'sin'], [0.2, 0, 'sin']]);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', fc, 1.6), mul(e, 2.2)));
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 300], [0.07, 1400, 'exp'], [0.2, 300, 'exp']]), 1), mul(e, 1.6)));
  const ring = modal(n, r.range(2300, 2700), [[1, 1, 0.22], [1.48, 0.6, 0.16], [2.13, 0.35, 0.1], [2.9, 0.2, 0.07]], r);
  add(x, mul(ring, curve(n, [[0, 0], [0.045, 0], [0.05, 0.05]])));
  return trim(normalize(reverb(x, { room: 0.6, wet: 0.14, tail: 0.35 }), -1), -55);
};

// ---- выстрел (огненный снаряд): щелчок + «фух» пламени + нисходящий зап + треск углей.
R.shot = (r) => {
  const n = len(0.5), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 1200), perc(n, 0.0005, 0.006, 0.6)));
  const fc = curve(n, [[0, 500], [0.05, r.range(1800, 2400), 'exp'], [0.25, 700, 'exp']]);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', fc, 1.1), mul(curve(n, [[0, 0], [0.018, 1], [0.26, 0, 'sin']]), 1.8)));
  const zf = sweep(n, r.range(520, 600), 170, 0.13);
  add(x, mul(lp(osc(n, zf, 'saw'), 2600), perc(n, 0.002, 0.05, 0.22)));
  add(x, mul(drive(osc(n, sweep(n, 170, 60, 0.1), 'sine'), 1.8), perc(n, 0.002, 0.045, 0.55)));
  add(x, grains(n, r, { count: 9, t0: 0.02, t1: 0.3, f0: 2500, f1: 7000, q: 2, amp: [0.04, 0.14] }));
  return trim(normalize(reverb(x, { room: 0.55, wet: 0.12, tail: 0.3 }), -1), -55);
};

// ---- попадание своего снаряда / искра: короткий треск разряда с шипением, без баса.
R.spark = (r) => {
  const n = len(0.4), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 2500), perc(n, 0.0005, 0.008, 0.7)));
  add(x, grains(n, r, { count: 14, t0: 0, t1: 0.12, f0: 3000, f1: 8000, q: 3, amp: [0.15, 0.5] }));
  add(x, mul(bp(noise(n, 'white', r), r.range(3800, 4600), 2), perc(n, 0.002, 0.06, 0.35)));
  add(x, mul(osc(n, sweep(n, r.range(1900, 2300), 800, 0.08), 'tri'), perc(n, 0.001, 0.03, 0.12)));
  add(x, mul(lp(noise(n, 'brown', r), 700), perc(n, 0.001, 0.03, 0.35)));
  return trim(normalize(reverb(x, { room: 0.5, wet: 0.1, tail: 0.25 }), -1), -55);
};

// ---- выброс: «фьюю» (свист, втягивание) → БАХ (саб + сатурация + обломки) → хвост в зале.
R.burst = (r) => {
  // удар — сразу (на кадре события вспышка и тряска), свист «фьюю» вспыхивает с ударом и падает после него
  const n = len(2.6), x = new Float32Array(n), T0 = 0.025;
  const wf = curve(n, [[0, 900], [T0, 2600, 'exp'], [T0 + 0.9, 600, 'exp']]);
  const we = curve(n, [[0, 0], [T0, 1, 'sin'], [T0 + 0.06, 0.8], [T0 + 0.9, 0, 'sin']]);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', wf, 1.6), mul(we, 5)));
  add(x, mul(osc(n, wf, 'sine'), mul(we, 0.1)));
  // удар: саб с падением высоты, через сатурацию (гармоники слышны и на ноутбуке)
  const boom = new Float32Array(n);
  add(boom, mul(osc(len(1.4), sweep(len(1.4), 150, 45, 0.5), 'sine'), perc(len(1.4), 0.003, 0.3, 1)), 1, T0);
  add(x, drive(boom, 3.2), 0.6);
  add(x, mul(biquad(noise(n, 'brown', r), 'lowpass', curve(n, [[0, 1600], [T0, 1600], [T0 + 0.5, 180, 'exp']]), 0.8), curve(n, [[0, 0], [T0, 0], [T0 + 0.003, 1.1], [T0 + 0.6, 0.02, 'exp'], [2.6, 0]])), 1);
  add(x, mul(hp(noise(n, 'white', r), 1800), curve(n, [[0, 0], [T0, 0], [T0 + 0.001, 0.9], [T0 + 0.05, 0.01, 'exp'], [T0 + 0.06, 0]])));
  // «мясо» удара в полосе, которую играют динамики ноутбука: плотный шум 250–1200 Гц и рычащая пила
  add(x, mul(bp(noise(n, 'pink', r), 520, 0.7), curve(n, [[0, 0], [T0, 0], [T0 + 0.004, 3.5], [T0 + 0.5, 0.02, 'exp'], [2.6, 0]])));
  const body = new Float32Array(n);
  add(body, mul(osc(len(1.0), sweep(len(1.0), 95, 42, 0.45), 'saw'), perc(len(1.0), 0.002, 0.22, 1)), 1, T0);
  add(x, lp(drive(body, 3), 1400), 0.55);
  // обломки и угли
  add(x, grains(n, r, { count: 30, t0: T0 + 0.05, t1: T0 + 1.2, f0: 1500, f1: 5500, q: 1.6, amp: [0.04, 0.16] }));
  // «склейка» сухого микса: плотнее и громче на ноутбуке
  return trim(normalize(reverb(drive(normalize(hp(x, 35), 0), 2.5), { room: 0.88, damp: 0.4, wet: 0.32, tail: 1.6, pre: 0.02 }), -1), -60, 0.1);
};

// ---- щит поднят: «гул и звон» — шорох вверх, низкий гул и кристаллический звон.
R.shield_up = (r) => {
  const n = len(1.5), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 320], [0.22, 1900, 'exp'], [0.4, 900, 'exp']]), 1.4), mul(curve(n, [[0, 0], [0.12, 1, 'sin'], [0.42, 0, 'sin']]), 1.6)));
  const hum = new Float32Array(n);
  add(hum, osc(n, 110, 'sine')); add(hum, osc(n, 165.2, 'sine'), 0.5); add(hum, osc(n, 220.6, 'tri'), 0.25);
  add(x, mul(drive(hum, 1.6), curve(n, [[0, 0], [0.08, 0.5, 'sin'], [1.3, 0.001, 'exp']])));
  add(x, mul(bell(1.5, 880, r, { bright: 0.8, decay: 0.9 }), curve(n, [[0, 0], [0.06, 0], [0.07, 0.4]])));
  add(x, mul(bell(1.5, 1318.5, r, { bright: 0.6, decay: 0.8 }), curve(n, [[0, 0], [0.1, 0], [0.11, 0.22]])));
  return trim(normalize(reverb(x, { room: 0.75, wet: 0.22, tail: 0.9 }), -1), -55, 0.08);
};
// ---- гул удерживаемого щита: бесшовная петля 4 с (биения двух близких тонов + тихая «искристость»).
R.shield_loop = (r) => {
  const n = len(4.5), x = new Float32Array(n);
  add(x, osc(n, 220, 'sine'), 0.5); add(x, osc(n, 220.5, 'sine'), 0.5); add(x, osc(n, 110, 'sine'), 0.15);
  add(x, osc(n, 330, 'tri'), 0.18); add(x, osc(n, 440.4, 'sine'), 0.12);
  const am = curve(n, [[0, 0.6], [1.1, 1, 'sin'], [2.25, 0.6, 'sin'], [3.4, 1, 'sin'], [4.5, 0.6, 'sin']]);
  const sh = mul(bp(noise(n, 'pink', r), 1250, 1.2), am);
  const out = drive(mul(x, 0.8), 2.0);
  add(out, sh, 2.5);
  return loopTail(normalize(loopify(out, 0.5), -3));
};
// ---- щит опущен: шорох вниз и угасающий звон.
R.shield_down = (r) => {
  const n = len(0.6), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 1700], [0.3, 320, 'exp']]), 1.3), mul(curve(n, [[0, 0], [0.03, 1], [0.32, 0, 'sin']]), 1.4)));
  add(x, mul(osc(n, sweep(n, 330, 220, 0.3), 'sine'), curve(n, [[0, 0.12], [0.35, 0.001, 'exp']])));
  add(x, mul(bell(0.6, 1318.5, r, { bright: 0.4, decay: 0.4 }), 0.08));
  return trim(normalize(reverb(x, { room: 0.6, wet: 0.15, tail: 0.4 }), -1), -55);
};
// ---- удар по щиту: энергетический хлопок + металл щита + низкий толчок.
R.block = (r) => {
  const n = len(1.0), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 1500), perc(n, 0.0005, 0.01, 0.8)));
  add(x, mul(drive(osc(n, sweep(n, 140, 60, 0.12), 'sine'), 2), perc(n, 0.002, 0.07, 0.8)));
  add(x, mul(modal(n, r.range(500, 560), [[1, 1, 0.45], [2.76, 0.6, 0.25], [5.4, 0.35, 0.12], [8.93, 0.2, 0.06]], r), 0.28));
  add(x, mul(bell(1.0, 1046.5, r, { bright: 0.5, decay: 0.5 }), 0.12));
  add(x, grains(n, r, { count: 10, t0: 0, t1: 0.15, f0: 3500, f1: 8000, q: 3, amp: [0.1, 0.3] }));
  return trim(normalize(reverb(x, { room: 0.7, wet: 0.2, tail: 0.6 }), -1), -55);
};
// ---- парирование: звон металла (клинок о клинок), яркий и длинный.
R.parry = (r) => {
  const n = len(1.8), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 3000), perc(n, 0.0003, 0.004, 0.9)));
  // круглая пластина: негармонические моды
  const plate = [[1, 1, 1.1], [1.594, 0.7, 0.9], [2.136, 0.55, 0.7], [2.296, 0.45, 0.65], [2.653, 0.35, 0.5], [3.156, 0.25, 0.4], [3.501, 0.2, 0.32], [4.07, 0.12, 0.25]];
  add(x, mul(modal(n, r.range(1150, 1300), plate, r, 0.003), 0.3));
  add(x, mul(modal(n, r.range(420, 470), [[1, 1, 0.8], [2.76, 0.5, 0.45], [5.4, 0.25, 0.2]], r), 0.22));
  add(x, mul(bp(noise(n, 'white', r), 5200, 3), perc(n, 0.001, 0.08, 0.3)));
  add(x, mul(drive(osc(n, sweep(n, 180, 90, 0.08), 'sine'), 1.5), perc(n, 0.001, 0.04, 0.4)));
  return trim(normalize(reverb(x, { room: 0.8, wet: 0.22, tail: 1.0 }), -1), -60, 0.1);
};
// ---- попадание по Регенту (каменный страж): хруст камня + глухой удар + шипение нашего огня.
R.boss_hit = (r) => {
  const n = len(0.6), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 1500), perc(n, 0.0005, 0.006, 0.7)));
  add(x, mul(bp(noise(n, 'pink', r), r.range(650, 800), 0.9), perc(n, 0.001, 0.05, 3.0)));
  add(x, mul(drive(osc(n, sweep(n, r.range(240, 280), 110, 0.12), 'sine'), 2.2), perc(n, 0.002, 0.06, 0.35)));
  add(x, grains(n, r, { count: 16, t0: 0.003, t1: 0.09, f0: 900, f1: 3500, q: 1.8, amp: [0.3, 0.9] }));
  add(x, mul(bp(noise(n, 'white', r), 3200, 1.5), curve(n, [[0, 0], [0.02, 0.18], [0.3, 0.001, 'exp']])));
  add(x, mul(bp(noise(n, 'pink', r), r.range(700, 900), 1), perc(n, 0.001, 0.045, 1.4)));     // каменный «чок»
  add(x, mul(modal(n, r.range(360, 420), [[1, 1, 0.07], [2.3, 0.5, 0.05], [3.7, 0.3, 0.03]], r, 0.01), 0.35));
  return trim(normalize(reverb(drive(x, 1.4), { room: 0.7, wet: 0.16, tail: 0.45 }), -1), -55);
};
// ---- удар Регента по герою: тяжёлый глухой удар, дребезг доспеха, хруст.
R.player_hit = (r) => {
  const n = len(0.8), x = new Float32Array(n);
  add(x, mul(drive(osc(n, sweep(n, r.range(150, 170), 60, 0.16), 'sine'), 2.8), perc(n, 0.003, 0.11, 0.6)));
  add(x, mul(bp(noise(n, 'pink', r), 600, 0.8), perc(n, 0.002, 0.08, 2.4)));
  add(x, mul(bp(noise(n, 'white', r), 1200, 1), perc(n, 0.001, 0.025, 0.5)));
  add(x, mul(modal(n, r.range(290, 330), [[1, 1, 0.16], [2.4, 0.7, 0.12], [3.9, 0.5, 0.08], [5.6, 0.3, 0.05]], r, 0.01), 0.5));
  add(x, grains(n, r, { count: 8, t0: 0.01, t1: 0.12, f0: 1200, f1: 3500, q: 1.5, amp: [0.2, 0.6] }));
  add(x, mul(bp(noise(n, 'pink', r), 600, 0.9), perc(n, 0.002, 0.07, 1.5)));                   // «хрясь» в середине
  return trim(normalize(reverb(drive(x, 1.4), { room: 0.6, wet: 0.14, tail: 0.5 }), -1), -55);
};

// ---- обучение: «✓ Распознано» — два кристальных тона вверх (квинта), мягко.
R.ui_ok = (r) => {
  const n = len(1.0), x = new Float32Array(n);
  add(x, bell(1.0, hz('E6'), r, { bright: 0.5, decay: 0.7 }), 0.7);
  add(x, bell(0.9, hz('B6'), r, { bright: 0.45, decay: 0.75 }), 0.55, 0.075);
  return trim(normalize(reverb(x, { room: 0.6, wet: 0.18, tail: 0.5 }), -1), -60, 0.08);
};
// ---- обучение: «ОШИБКА» — мягкий низкий деревянный «тук», без верхов и без звона.
R.ui_error = (r) => {
  const n = len(0.35), x = new Float32Array(n);
  const wood = modal(n, 240, [[1, 1, 0.07], [2.31, 0.45, 0.04], [3.92, 0.18, 0.025]], r, 0.002);
  add(x, mul(wood, curve(n, [[0, 0], [0.002, 1], [0.35, 1]])));
  add(x, mul(lp(noise(n, 'brown', r), 600), perc(n, 0.001, 0.012, 0.5)));
  add(x, mul(osc(n, sweep(n, 180, 120, 0.08), 'sine'), perc(n, 0.002, 0.05, 0.35)));
  return trim(normalize(lp(x, 2200), -1), -55, 0.03);
};

// ---- победа: короткие фанфары (ре мажор: D4-F#4-A4 → аккорд D), литавра, медь, тарелка.
R.victory = (r) => {
  const n = len(3.6), x = new Float32Array(n);
  const hits = [[0, ['D4', 'A4'], 0.16], [0.17, ['F#4', 'D5'], 0.16], [0.34, ['A4', 'F#5'], 0.16]];
  for (const [t, notes, d] of hits) for (const nm of notes) add(x, brass(d + 0.12, hz(nm), r, { amp: 0.5, open: 3200, release: 0.1 }), 1, t);
  for (const nm of ['D3', 'A3', 'D4', 'F#4', 'A4', 'D5']) add(x, brass(2.6, hz(nm), r, { amp: nm === 'D3' ? 0.34 : 0.22, open: 2800, attack: 0.06, release: 1.6, vib: 0.004 }), 1, 0.52);
  const timp = new Float32Array(len(1.6));
  add(timp, mul(osc(timp.length, sweep(timp.length, 150, 98, 0.15), 'sine'), perc(timp.length, 0.003, 0.4, 1)));
  add(timp, mul(lp(noise(timp.length, 'brown', r), 400), perc(timp.length, 0.002, 0.08, 0.7)));
  add(x, drive(timp, 1.8), 0.3, 0.5);
  add(x, mul(hp(noise(n, 'white', r), 5000), curve(n, [[0, 0], [0.5, 0], [0.52, 0.12], [3.0, 0.001, 'exp']])));
  return trim(normalize(reverb(x, { room: 0.85, wet: 0.25, tail: 1.4, pre: 0.025 }), -1), -60, 0.2);
};
// ---- поражение: нисходящая медь в миноре, приглушённая, низкий гонг.
R.defeat = (r) => {
  const n = len(3.6), x = new Float32Array(n);
  const steps = [[0, 'A4', 0.32], [0.34, 'F4', 0.32], [0.68, 'D4', 0.4]];
  for (const [t, nm, d] of steps) add(x, brass(d + 0.1, hz(nm), r, { amp: 0.48, open: 1800, release: 0.12 }), 1, t);
  for (const nm of ['D3', 'A3', 'D4', 'F4']) add(x, brass(2.4, hz(nm), r, { amp: 0.24, open: 1100, attack: 0.12, release: 1.6 }), 1, 1.08);
  const g = modal(len(3), 98, [[1, 1, 1.6], [1.47, 0.5, 1.1], [2.09, 0.35, 0.7], [2.56, 0.2, 0.5], [3.3, 0.12, 0.3]], r, 0.004);
  add(x, drive(mul(g, curve(g.length, [[0, 0], [0.01, 0.5], [3, 0.5]])), 1.4), 0.25, 1.08);
  return trim(normalize(lp(reverb(x, { room: 0.88, wet: 0.28, tail: 1.4, pre: 0.03 }), 5000), -1), -60, 0.2);
};

// ---- эмбиент арены: ветер над плато, далёкий гул, редкий треск углей. Петля 24 с.
R.ambient = (r) => {
  const n = len(26), x = new Float32Array(n);
  const wfc = new Float32Array(n), wam = new Float32Array(n);
  const ph1 = r() * 6.28, ph2 = r() * 6.28, ph3 = r() * 6.28;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    wfc[i] = 750 + 250 * Math.sin(2 * Math.PI * t / 13 + ph1) + 90 * Math.sin(2 * Math.PI * t / 5.2 + ph2);
    wam[i] = 0.55 + 0.3 * Math.sin(2 * Math.PI * t / 8.6 + ph3) + 0.15 * Math.sin(2 * Math.PI * t / 3.1 + ph1);
  }
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', wfc, 0.7), wam), 1.4);
  add(x, mul(hp(noise(n, 'white', r), 4500), mul(wam, 0.025)));
  const drone = new Float32Array(n);
  add(drone, osc(n, 55, 'sine'), 0.5); add(drone, osc(n, 82.6, 'tri'), 0.18); add(drone, osc(n, 110.3, 'sine'), 0.1);
  add(x, lp(drive(drone, 1.5), 260), 0.12);
  add(x, grains(n, r, { count: 40, t0: 0, t1: 25.5, f0: 2000, f1: 6000, q: 2, dur: [0.002, 0.006], amp: [0.02, 0.09] }));
  return loopTail(normalize(loopify(x, 2), -6));
};

// ---- идеальный рывок: «замедление времени» — встречный шорох, стеклянный блеск, низкое «вуум».
R.perfect = (r) => {
  const n = len(1.4), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 4000), curve(n, [[0, 0], [0.22, 0.35, 'sin'], [0.26, 0], [1.4, 0]])));
  add(x, mul(drive(osc(n, sweep(n, 90, 45, 0.5), 'sine'), 1.6), curve(n, [[0, 0], [0.2, 0.6, 'sin'], [0.9, 0.001, 'exp']])));
  for (const [nm, t, a] of [['E6', 0.2, 0.45], ['B6', 0.25, 0.35], ['E7', 0.3, 0.22]]) add(x, bell(1.1, hz(nm), r, { bright: 0.4, decay: 0.6 }), a, t);
  return trim(normalize(reverb(x, { room: 0.8, wet: 0.28, tail: 0.8 }), -1), -60, 0.08);
};

// ---- руны: аккорд по стихии + слой стихии. Аккорд — «магия», слой — что именно сотворено.
// Мягкий пэд: пары расстроенных треугольников/синусов (хор), медленная атака.
function pad(sec, notes, r, { type = 'tri', amp = 0.2, attack = 0.12, lpf = 2400, vib = 0.003 } = {}) {
  const n = len(sec), x = new Float32Array(n);
  for (const nm of notes) {
    const f = typeof nm === 'number' ? nm : hz(nm);
    for (const d of [-0.0035, 0.0035]) {
      const fr = new Float32Array(n), ph = r() * 6.28;
      for (let i = 0; i < n; i++) fr[i] = f * (1 + d) * (1 + vib * Math.sin(2 * Math.PI * 4.7 * i / SR + ph));
      add(x, osc(n, fr, type, r()), amp / 2);
    }
  }
  return mul(lp(x, lpf), curve(n, [[0, 0], [attack, 1, 'sin'], [sec * 0.45, 0.75], [sec, 0, 'sin']]));
}
R.rune_fire = (r) => {
  const n = len(2.0), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 300], [0.25, 2600, 'exp'], [0.9, 500, 'exp']]), 1.2), curve(n, [[0, 0], [0.18, 1.4, 'sin'], [1.0, 0, 'sin']])));
  const flick = new Float32Array(n); for (let i = 0; i < n; i++) flick[i] = 0.6 + 0.4 * Math.sin(2 * Math.PI * 11 * i / SR + Math.sin(2 * Math.PI * 3.1 * i / SR) * 2);
  add(x, mul(lp(noise(n, 'brown', r), 1300), mul(flick, curve(n, [[0, 0], [0.12, 1.1], [1.6, 0.001, 'exp']]))));
  for (const nm of ['D3', 'A3', 'D4', 'F#4', 'A4']) add(x, brass(1.7, hz(nm), r, { amp: 0.16, open: 2200, attack: 0.05, release: 1.0 }), 1, 0.06);
  add(x, grains(n, r, { count: 26, t0: 0.05, t1: 1.4, f0: 2000, f1: 6500, q: 2, amp: [0.04, 0.14] }));
  add(x, mul(drive(osc(n, sweep(n, 160, 70, 0.3), 'sine'), 2), perc(n, 0.004, 0.18, 0.3)), 1);
  return trim(normalize(reverb(x, { room: 0.8, wet: 0.25, tail: 1.0 }), -1), -60, 0.1);
};
R.rune_storm = (r) => {
  const n = len(2.0), x = new Float32Array(n);
  // разряд: рваная серия щелчков + треск
  for (let k = 0; k < 7; k++) add(x, mul(hp(noise(len(0.05), 'white', r), 900), perc(len(0.05), 0.0004, r.range(0.004, 0.012), r.range(0.4, 1))), 1, k * r.range(0.008, 0.02));
  add(x, mul(bp(noise(n, 'white', r), 3000, 0.8), perc(n, 0.001, 0.09, 0.5)));
  // раскат: низкий гул с сатурацией
  add(x, mul(drive(lp(noise(n, 'brown', r), 260), 2.2), curve(n, [[0, 0], [0.06, 1.2], [0.4, 0.8], [1.8, 0.001, 'exp']])));
  // электрический аккорд: sus4 с быстрым тремоло
  const ch = pad(1.6, ['E4', 'A4', 'B4', 'E5'], r, { type: 'saw', amp: 0.12, attack: 0.02, lpf: 3200 });
  const trem = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) trem[i] = 0.65 + 0.35 * Math.sin(2 * Math.PI * 17 * i / SR);
  add(x, mul(ch, trem), 1, 0.03);
  return trim(normalize(reverb(x, { room: 0.85, wet: 0.28, tail: 1.1 }), -1), -60, 0.1);
};
R.rune_light = (r) => {
  const n = len(2.2), x = new Float32Array(n);
  add(x, pad(2.0, ['C4', 'E4', 'G4', 'B4', 'C5'], r, { type: 'tri', amp: 0.2, attack: 0.18, lpf: 2600 }));
  for (const [nm, t] of [['C6', 0.08], ['E6', 0.16], ['G6', 0.24], ['C7', 0.34]]) add(x, bell(1.4, hz(nm), r, { bright: 0.35, decay: 0.7 }), 0.28, t);
  add(x, mul(hp(noise(n, 'white', r), 6000), curve(n, [[0, 0], [0.3, 0.05, 'sin'], [1.8, 0, 'sin']])));
  return trim(normalize(reverb(x, { room: 0.88, wet: 0.32, tail: 1.2 }), -1), -60, 0.12);
};
R.rune_star = (r) => {
  const n = len(1.9), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 800], [0.3, 4200, 'exp']]), 1.5), curve(n, [[0, 0], [0.25, 0.7, 'sin'], [0.6, 0, 'sin']])));
  for (const [nm, t] of [['A5', 0], ['C#6', 0.06], ['E6', 0.12], ['A6', 0.18], ['C#7', 0.24]]) add(x, bell(1.4, hz(nm), r, { bright: 0.5, decay: 0.65 }), 0.3, t);
  add(x, pad(1.7, ['A4', 'E5', 'C#5'], r, { type: 'sine', amp: 0.18, attack: 0.1, lpf: 4000 }), 1, 0.05);
  return trim(normalize(reverb(x, { room: 0.88, wet: 0.3, tail: 1.1 }), -1), -60, 0.1);
};
R.rune_wind = (r) => {
  const n = len(2.0), x = new Float32Array(n);
  const fc = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; fc[i] = 1300 + 900 * Math.sin(2 * Math.PI * (2.5 * t + 2.2 * t * t)); }
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', fc, 2.2), curve(n, [[0, 0], [0.25, 2.2, 'sin'], [1.2, 1.2], [2.0, 0, 'sin']])));
  add(x, pad(1.9, ['F4', 'A4', 'B4', 'E5'], r, { type: 'tri', amp: 0.17, attack: 0.2, lpf: 2400, vib: 0.008 }));
  add(x, mul(osc(n, curve(n, [[0, 900], [0.6, 1600, 'exp'], [1.6, 1100, 'exp']]), 'sine'), curve(n, [[0, 0], [0.4, 0.03, 'sin'], [1.6, 0, 'sin']])));
  return trim(normalize(reverb(x, { room: 0.82, wet: 0.26, tail: 1.0 }), -1), -60, 0.1);
};
R.rune_shadow = (r) => {
  const n = len(1.9), x = new Float32Array(n);
  // обратный «вдох» (нарастающий шум) → глухой удар → тёмный минор с шёпотом
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 400], [0.3, 1800, 'exp']]), 1.3), curve(n, [[0, 0], [0.29, 1.3, 'exp'], [0.31, 0], [1.9, 0]])));
  add(x, mul(drive(osc(n, sweep(n, 160, 55, 0.4), 'sine'), 2.4), curve(n, [[0, 0], [0.3, 0], [0.305, 0.35], [1.1, 0.001, 'exp']])));
  for (const nm of ['D3', 'F3', 'A3', 'C#4']) add(x, brass(1.5, hz(nm), r, { amp: 0.22, open: 1800, attack: 0.08, release: 0.9 }), 1, 0.3);
  const wh = mul(bp(noise(n, 'white', r), 2800, 2), curve(n, [[0, 0], [0.35, 0], [0.6, 0.18, 'sin'], [1.7, 0, 'sin']]));
  const am = new Float32Array(n); for (let i = 0; i < n; i++) am[i] = 0.5 + 0.5 * Math.sin(2 * Math.PI * 6.5 * i / SR);
  add(x, mul(wh, am));
  return trim(normalize(reverb(x, { room: 0.85, wet: 0.3, tail: 1.0 }), -1), -60, 0.1);
};

// ---- Регент Нимба (каменный страж). Замах — нарастание, у которого «момент удара» ровно на WINDUP_HIT с:
// в игре сэмпл стартует со сдвигом (WINDUP_HIT − длительность замаха), и пик совпадает с ударом.
export const WINDUP_HIT = 2.0;
function riser(r, body) {
  const n = len(WINDUP_HIT + 0.35), x = new Float32Array(n);
  body(x, n);
  // последние 0.35 с — быстрое затухание: дальше звучит сам удар
  const e = curve(n, [[0, 1], [WINDUP_HIT - 0.02, 1], [WINDUP_HIT + 0.3, 0, 'sin'], [WINDUP_HIT + 0.35, 0]]);
  return normalize(mul(x, e), -1);
}
R.windup_slam = (r) => riser(r, (x, n) => {
  const up = curve(n, [[0, 0], [WINDUP_HIT, 1, 'sin']]);
  add(x, mul(drive(biquad(noise(n, 'brown', r), 'lowpass', curve(n, [[0, 90], [WINDUP_HIT, 700, 'exp']]), 0.9), 2), mul(up, 1.2)));
  add(x, mul(drive(osc(n, curve(n, [[0, 38], [WINDUP_HIT, 70, 'exp']]), 'saw'), 1.5), mul(up, 0.18)));
  add(x, grains(n, r, { count: 50, t0: 0.4, t1: WINDUP_HIT, f0: 900, f1: 3000, q: 1.5, amp: [0.03, 0.12] })); // осыпается камень
});
R.windup_orb = (r) => riser(r, (x, n) => {
  const up = curve(n, [[0, 0.02], [WINDUP_HIT, 1, 'exp']]);
  const f = curve(n, [[0, 110], [WINDUP_HIT, 330, 'exp']]);
  for (const k of [1, 1.5, 2.01]) add(x, mul(osc(n, mul(f, k), 'saw'), mul(up, 0.06 / k)));
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 600], [WINDUP_HIT, 3600, 'exp']]), 3), mul(up, 0.9)));
  add(x, mul(lp(noise(n, 'brown', r), 300), mul(up, 0.7)));
});
R.windup_nova = (r) => riser(r, (x, n) => {
  const up = curve(n, [[0, 0], [WINDUP_HIT, 1, 'sin']]);
  add(x, mul(pad(WINDUP_HIT + 0.35, [hz('D3'), hz('A3'), hz('D4'), hz('Eb4')], r, { type: 'saw', amp: 0.16, attack: WINDUP_HIT * 0.9, lpf: 1800 }), up));
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 300], [WINDUP_HIT, 2400, 'exp']]), 1.2), mul(up, 0.8)));
  add(x, mul(drive(lp(noise(n, 'brown', r), 220), 2), mul(up, 0.8)));
});
// ---- удар о землю: саб с сатурацией, грохот, треск камня, долгий хвост обломков
R.boss_slam = (r) => {
  const n = len(2.6), x = new Float32Array(n);
  add(x, mul(hp(noise(n, 'white', r), 1200), perc(n, 0.0005, 0.012, 0.9)));
  add(x, drive(mul(osc(n, sweep(n, 75, 27, 0.7), 'sine'), perc(n, 0.002, 0.45, 1)), 3.5), 0.9);
  add(x, mul(biquad(noise(n, 'brown', r), 'lowpass', sweep(n, 1800, 140, 0.8), 0.8), perc(n, 0.001, 0.3, 1.3)));
  add(x, grains(n, r, { count: 22, t0: 0, t1: 0.15, f0: 1200, f1: 3500, q: 1.4, amp: [0.2, 0.6] }));
  add(x, grains(n, r, { count: 45, t0: 0.12, t1: 1.8, f0: 800, f1: 4000, q: 1.6, amp: [0.04, 0.18] }));
  add(x, mul(bp(noise(n, 'pink', r), 420, 0.8), perc(n, 0.002, 0.14, 1.8))); // слышно и на ноутбуке
  const body = mul(osc(n, sweep(n, 70, 32, 0.6), 'saw'), perc(n, 0.002, 0.25, 1));
  add(x, lp(drive(body, 3), 1200), 0.5);
  return trim(normalize(reverb(drive(x, 1.5), { room: 0.9, damp: 0.45, wet: 0.3, tail: 1.5, pre: 0.02 }), -1), -60, 0.15);
};
// ---- нова: ударная волна холода — «вуумп» наружу, низкий удар, ледяной звон
R.boss_nova = (r) => {
  const n = len(2.4), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 250], [0.35, 3200, 'exp'], [1.2, 900, 'exp']]), 1.1), curve(n, [[0, 0], [0.02, 1.6], [1.2, 0.001, 'exp']])));
  add(x, drive(mul(osc(n, sweep(n, 90, 34, 0.6), 'sine'), perc(n, 0.003, 0.35, 1)), 3), 0.8);
  for (const [nm, t] of [['D6', 0.02], ['F6', 0.05], ['A6', 0.08], ['C#7', 0.11]]) add(x, bell(1.6, hz(nm), r, { bright: 0.3, decay: 0.8 }), 0.12, t);
  add(x, mul(hp(noise(n, 'white', r), 5000), curve(n, [[0, 0], [0.05, 0.12], [1.4, 0.001, 'exp']])));
  return trim(normalize(reverb(x, { room: 0.88, wet: 0.3, tail: 1.3 }), -1), -60, 0.12);
};
// ---- выпуск орба: тёмный «вжух» с рыком и треском энергии
R.orb_launch = (r) => {
  const n = len(1.0), x = new Float32Array(n);
  add(x, mul(biquad(noise(n, 'pink', r), 'bandpass', curve(n, [[0, 300], [0.25, 1800, 'exp'], [0.7, 600, 'exp']]), 1.5), curve(n, [[0, 0], [0.06, 1.4, 'sin'], [0.75, 0, 'sin']])));
  add(x, mul(drive(osc(n, curve(n, [[0, 55], [0.3, 110, 'exp'], [0.8, 70, 'exp']]), 'saw'), 2), curve(n, [[0, 0], [0.05, 0.3], [0.8, 0.001, 'exp']])));
  add(x, grains(n, r, { count: 14, t0: 0, t1: 0.5, f0: 2500, f1: 7000, q: 3, amp: [0.05, 0.2] }));
  return trim(normalize(reverb(x, { room: 0.7, wet: 0.2, tail: 0.6 }), -1), -55);
};
// ---- орб лопнул: глухой хлопок и холодный стеклянный треск
R.orb_hit = (r) => {
  const n = len(1.2), x = new Float32Array(n);
  add(x, drive(mul(osc(n, sweep(n, 110, 45, 0.3), 'sine'), perc(n, 0.002, 0.18, 1)), 2.5), 0.8);
  add(x, mul(lp(noise(n, 'brown', r), 900), perc(n, 0.001, 0.12, 1.1)));
  add(x, grains(n, r, { count: 20, t0: 0, t1: 0.25, f0: 3000, f1: 8000, q: 4, amp: [0.08, 0.3] }));
  add(x, mul(bell(1.0, hz('F#6'), r, { bright: 0.6, decay: 0.4 }), 0.12));
  add(x, mul(bp(noise(n, 'pink', r), 650, 0.9), perc(n, 0.002, 0.08, 1.3)));
  return trim(normalize(reverb(drive(x, 1.4), { room: 0.75, wet: 0.22, tail: 0.7 }), -1), -55);
};
// ---- пробуждение и вторая стадия: низкий гонг, рык (пила через «гортанные» полосы), диссонанс хора
R.boss_phase = (r) => {
  const n = len(3.6), x = new Float32Array(n);
  const g = modal(n, 55, [[1, 1, 2.2], [1.47, 0.6, 1.6], [2.09, 0.45, 1.1], [2.56, 0.3, 0.8], [3.3, 0.2, 0.5], [4.1, 0.12, 0.35]], r, 0.004);
  add(x, drive(mul(g, curve(n, [[0, 0], [0.01, 0.6], [3.6, 0.6]])), 2.2), 0.9);
  const rf = curve(n, [[0, 70], [0.5, 92, 'exp'], [2.2, 64, 'exp']]);
  const vib = new Float32Array(n); for (let i = 0; i < n; i++) vib[i] = rf[i] * (1 + 0.03 * Math.sin(2 * Math.PI * 7 * i / SR) + 0.02 * Math.sin(2 * Math.PI * 23 * i / SR));
  let roar = osc(n, vib, 'saw');
  const form = new Float32Array(n);
  for (const [f, q, a] of [[420, 4, 1], [880, 5, 0.7], [1650, 6, 0.35]]) add(form, bp(roar, f, q), a);
  roar = drive(form, 2.5);
  add(x, mul(roar, curve(n, [[0, 0], [0.25, 0.55, 'sin'], [1.6, 0.4], [2.6, 0, 'sin']])));
  add(x, mul(pad(3.4, ['D3', 'Eb3', 'A3', 'D4', 'Eb4'], r, { type: 'saw', amp: 0.1, attack: 0.9, lpf: 1600 }), 1, 0.2));
  add(x, mul(drive(lp(noise(n, 'brown', r), 200), 2), curve(n, [[0, 0], [0.4, 0.9], [3.2, 0.001, 'exp']])));
  return trim(normalize(reverb(x, { room: 0.92, damp: 0.45, wet: 0.3, tail: 1.6, pre: 0.03 }), -1), -60, 0.2);
};

// ================================================================== что и сколько печём
// [имя файла, рецепт, вариантов, seed]
export const BAKE = [
  ['step', 'step', 4, 11], ['dash', 'dash', 2, 21], ['slash', 'slash', 3, 31], ['shot', 'shot', 3, 41],
  ['spark', 'spark', 3, 51], ['burst', 'burst', 1, 61], ['shield_up', 'shield_up', 1, 71],
  ['shield_loop', 'shield_loop', 1, 72], ['shield_down', 'shield_down', 1, 73], ['block', 'block', 2, 81],
  ['parry', 'parry', 2, 91], ['boss_hit', 'boss_hit', 3, 101], ['player_hit', 'player_hit', 2, 111],
  ['ui_ok', 'ui_ok', 1, 121], ['ui_error', 'ui_error', 1, 131], ['victory', 'victory', 1, 141],
  ['defeat', 'defeat', 1, 151], ['ambient', 'ambient', 1, 161], ['perfect', 'perfect', 1, 171],
  ['rune_fire', 'rune_fire', 1, 181], ['rune_storm', 'rune_storm', 1, 182], ['rune_light', 'rune_light', 1, 183],
  ['rune_star', 'rune_star', 1, 184], ['rune_wind', 'rune_wind', 1, 185], ['rune_shadow', 'rune_shadow', 1, 186],
  ['windup_slam', 'windup_slam', 1, 191], ['windup_orb', 'windup_orb', 1, 192], ['windup_nova', 'windup_nova', 1, 193],
  ['boss_slam', 'boss_slam', 2, 201], ['boss_nova', 'boss_nova', 1, 211], ['orb_launch', 'orb_launch', 2, 221],
  ['orb_hit', 'orb_hit', 2, 231], ['boss_phase', 'boss_phase', 1, 241],
];

function encode(x, file, q) {
  const tmp = file.replace(/\.ogg$/, '.tmp.wav');
  writeFileSync(tmp, wav(x));
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-c:a', 'libvorbis', '-q:a', String(q), '-ac', '1', file]);
  } finally { rmSync(tmp, { force: true }); }
}

function main() {
  const only = new Set(process.argv.slice(2));
  mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const [name, recipe, count, seed] of BAKE) {
    if (only.size && !only.has(name)) continue;
    for (let i = 0; i < count; i++) {
      const r = rng(seed * 1000 + i * 7919);
      const x = R[recipe](r, i);
      for (let k = 0; k < x.length; k++) if (!Number.isFinite(x[k])) throw new Error(`${name}: NaN`);
      const file = join(OUT, count > 1 ? `${name}_${i + 1}.ogg` : `${name}.ogg`);
      // длинные фоновые петли — экономнее, короткие удары — чище
      encode(x, file, name === 'ambient' ? 2 : 4);
      const kb = statSync(file).size / 1024;
      total += kb;
      console.log(`${file.split('/').slice(-1)[0].padEnd(20)} ${(x.length / SR).toFixed(2)} с  ${kb.toFixed(1)} КБ`);
    }
  }
  let all = 0;
  for (const f of readdirSync(OUT)) if (f.endsWith('.ogg')) all += statSync(join(OUT, f)).size;
  console.log(`запечено ${total.toFixed(0)} КБ; всего в assets/sfx: ${(all / 1024).toFixed(0)} КБ`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
export { R };
