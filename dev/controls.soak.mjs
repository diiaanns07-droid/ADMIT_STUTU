// [V6] Стресс-прогон управления «Руль» на «живом» синтетическом игроке (не реальная камера).
// node dev/controls.soak.mjs [--seeds 8] [--json]
//
// Игрок сидит перед камерой и минуту ведёт героя левой рукой: подъём с колен, ход прямо, повороты,
// бег, остановки, осознанные толчки щита, парирование. Поверх — то, чего нет в юнит-тестах:
// шум каждой точки MediaPipe, пропуски кадров сериями, покачивание корпуса и плеч позы, ладонь
// медленно гуляет к камере и обратно (±10 % размера), поворот кисти (ладонь то к камере, то ребром).
// Метрики по фазам с известным «правильным» ответом:
//   • ложный щит (кадры/включения вне фаз щита), ложные рывки;
//   • спотыкания: кадры «стоим» посреди ходьбы; мигание ход/стоп;
//   • дрожь руля: |поворот| на прямых участках, разброс поворота на дуге;
//   • задержки: подъём руки → ход, опускание → стоп, толчок → щит;
//   • осознанный щит: поднялся ли, опустился ли после «убрал ладонь»;
//   • игрок держит ладонь на ~10 см левее/правее нейтрали игры: герой всё равно идёт прямо;
//   • правая рука всё время колдует; 1 % кадров — выбросы трекинга (кисть на кадр «прыгает»).
// Ключи: --seeds N, --seed S (один прогон), --push K (сила толчка), --offset/--level (привычка игрока),
//   --right (правая колдует), --glitch P (доля кадров-выбросов), --fast MS (резкость руления), --save файл,
//   --cfg '{...}' (подмена настроек handGestures), --debug (по фазам), --json.
// Итог — таблица и жёсткие пороги (код выхода 1, если хуже порогов).

import { createHandGestures } from '../core/handGestures.js';
import { makeHand, makeScene, SHAPES, reseed, gauss, rnd } from './handSynth.mjs';
import { createInputRecorder } from '../core/inputRecorder.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = +argOf('--seeds', 8);
const ONLY = argOf('--seed', null);   // --seed N: один прогон с этим зерном
const SAVE = argOf('--save', null);   // --save файл.json: записать прогон (--seed) в формате игры (?rec=1) для dev/replay.mjs
const recorder = SAVE ? createInputRecorder({ meta: { source: 'controls.soak', moveMode: 'steer' } }) : null;
const JSON_OUT = argv.includes('--json');
const DEBUG = argv.includes('--debug');
const PUSH = +argOf('--push', 1.35);
const FAST_MS = +argOf('--fast', 150);
let RIGHT = argv.includes('--right');
let GLITCH = +argOf('--glitch', 0);
const BODY_GLITCH = +argOf('--body-glitch', 0);
let NO_SW = argv.includes('--no-sw');          // ширины плеч нет (левая ладонь закрыла плечо — поза не уверена)  // доля кадров, где середина плеч позы «прыгает» на 0.1–0.3 sw           // доля кадров-выбросов: кисть на один кадр «прыгает» (сбой MediaPipe)        // правая рука всё время колдует: «OK», руны, выброс, «Искра»          // длительность «резкого» движения руля, мс
const OFFSET = +argOf('--offset', 0);          // привычная ладонь игрока смещена от нейтрали игры (sw, + к середине груди)
const LEVEL = +argOf('--level', 0);            // и выше (+) / ниже (−) «уровня груди» (sw)          // сила осознанного толчка щита: во столько раз кисть растёт в кадре
const G_OPTS = JSON.parse(argOf('--cfg', '{}')); // подмена настроек handGestures (подбор порогов)
const byTag = {};   // --debug: по фазам — кадры, стоим при ходьбе, ложный щит
let DT = Math.round(1000 / +argOf('--fps', 30));   // шаг кадров камеры, мс (--fps 15 — слабый ноутбук)

// Сценарий: фазы { ms, want, hand(u, k) → { x, y, size, shape, palm, yaw } | null }.
// x, y — координаты показа в ширинах плеч от середины плеч (x вправо на экране, y вниз).
// want: 'rest' | 'walk' | 'run' | 'turnL' | 'turnR' | 'shield' | 'any'
let NX = -0.55 + OFFSET;     // нейтраль руля (перед левым плечом) на зеркальном экране — у этого игрока
const CHEST = 0.28 - LEVEL;  // «на уровне груди» (y вниз): ход
const SHOULDER = -0.25;      // «у плеча и выше»: бег
const LAP = 1.45;            // на коленях
const SIZE = 0.075;
const ease = (u) => (u < 0 ? 0 : u > 1 ? 1 : u * u * (3 - 2 * u));
const lerp = (a, b, u) => a + (b - a) * u;

function scenario() {
  const P = [];
  const add = (ms, want, hand, tag) => P.push({ ms, want, hand, tag: tag || want });
  const open = (x, y, size = SIZE, extra = {}) => ({ x, y, size, shape: 'open', ...extra });
  add(1200, 'rest', () => open(NX, LAP), 'сидит, рука на коленях');
  add(450, 'any', (u) => open(NX, lerp(LAP, CHEST, ease(u / 0.9)), SIZE * lerp(0.9, 1.05, ease(u))), 'подъём');
  add(5000, 'walk', () => open(NX, CHEST), 'ход прямо');
  add(350, 'any', (u) => open(lerp(NX, NX - 0.42, ease(u)), CHEST), 'в поворот влево');
  add(2500, 'turnL', () => open(NX - 0.42, CHEST), 'дуга влево');
  add(500, 'any', (u) => open(lerp(NX - 0.42, NX + 0.4, ease(u)), CHEST), 'перекладка');
  add(2500, 'turnR', () => open(NX + 0.4, CHEST), 'дуга вправо');
  add(350, 'any', (u) => open(lerp(NX + 0.4, NX, ease(u)), CHEST), 'выровнять');
  add(3000, 'walk', () => open(NX, CHEST), 'ход прямо 2');
  add(400, 'any', (u) => open(NX, lerp(CHEST, SHOULDER, ease(u)), SIZE * lerp(1.05, 1.12, ease(u))), 'рука к плечу');
  add(4000, 'run', () => open(NX, SHOULDER, SIZE * 1.12), 'бег');
  add(300, 'any', (u) => open(NX, lerp(SHOULDER, LAP, ease(u))), 'рука вниз');
  add(1500, 'rest', () => open(NX, LAP), 'стоп на коленях');
  add(450, 'any', (u) => open(NX, lerp(LAP, CHEST, ease(u / 0.9)), SIZE * lerp(0.9, 1.05, ease(u))), 'подъём 2');
  add(2500, 'walk', () => open(NX, CHEST), 'ход');
  // осознанный щит: толчок ладонью к камере (+35 % размера за ~0,2 с), подержать, убрать назад
  add(220, 'any', (u) => open(NX, CHEST, SIZE * lerp(1.0, PUSH, ease(u / 0.85))), 'толчок щита');
  add(1800, 'shield', () => open(NX, CHEST, SIZE * PUSH), 'держит щит');
  add(300, 'any', (u) => open(NX, CHEST, SIZE * lerp(PUSH, 1.0, ease(u))), 'убрал ладонь');
  add(2500, 'walk', () => open(NX, CHEST), 'снова идёт');
  add(3000, 'walk', () => open(NX, CHEST), 'ход, ладонь ребром', );
  // резкие, но обычные движения руля (не дёрг-рывок): быстро увести руку в поворот и вернуть
  add(FAST_MS, 'any', (u) => open(lerp(NX, NX - 0.45, ease(u)), CHEST), 'резко влево');
  add(1200, 'turnL', () => open(NX - 0.45, CHEST), 'дуга влево 2');
  add(FAST_MS, 'any', (u) => open(lerp(NX - 0.45, NX + 0.4, ease(u)), CHEST), 'резко вправо');
  add(1200, 'turnR', () => open(NX + 0.4, CHEST), 'дуга вправо 2');
  add(FAST_MS, 'any', (u) => open(lerp(NX + 0.4, NX, ease(u)), CHEST), 'резко прямо');
  add(1500, 'walk', () => open(NX, CHEST), 'ход 3');
  add(FAST_MS, 'any', (u) => open(NX, lerp(CHEST, SHOULDER, ease(u)), SIZE * lerp(1, 1.1, ease(u))), 'резко к плечу');
  add(1500, 'run', () => open(NX, SHOULDER, SIZE * 1.1), 'бег 2');
  add(300, 'any', (u) => open(NX, lerp(CHEST, LAP, ease(u))), 'рука вниз 2');
  add(2000, 'rest', () => open(NX, LAP), 'отдых');
  return P;
}

function simulate(seed, gOpts = {}) {
  reseed(seed);
  const S = makeScene({ cx: 0.5, cy: 0.4, sw: 0.3 });
  const g = createHandGestures({ moveMode: 'steer', ...gOpts });
  const phases = scenario();
  let t = 1000;
  // медленные «живые» колебания
  const osc = (f, ph) => Math.sin(2 * Math.PI * f * t / 1000 + ph);
  const ph = Array.from({ length: 8 }, () => rnd() * 6.28);
  let dropLeft = 0;
  const M = {
    frames: 0, falseShieldFrames: 0, falseShieldOn: 0, falseDash: 0,
    walkFrames: 0, walkStops: 0, flips: 0, straightTurnSum: 0, straightFrames: 0, straightTurnMax: 0,
    arcStdSum: 0, arcN: 0, wrongTurn: 0,
    riseLatency: [], stopLatency: [], shieldLatency: null, shieldHeld: 0, shieldFrames: 0, shieldDropped: false,
    restMove: 0, castStops: 0,
  };
  let prevShield = false, prevMoving = null;
  const recent = [];   // --debug: были ли кадры кисти (x) или пропуск (.)
  for (const P of phases) {
    const t0 = t;
    const arc = [];
    let riseSeen = false, stopSeen = false;
    for (; t < t0 + P.ms; t += DT) {
      const u = (t - t0) / P.ms;
      const q = P.hand(u);
      // живость: корпус качается, ладонь гуляет к камере и вбок, кисть поворачивается
      const sway = 0.06 * osc(0.23, ph[0]);
      S.cx = 0.5 + sway * S.sw / S.aspect;
      S.cy = 0.4 + 0.02 * osc(0.17, ph[1]) * S.sw;
      let hand = null;
      if (dropLeft > 0) dropLeft--;
      else if (rnd() < 0.04) dropLeft = 1 + Math.floor(rnd() * 6);    // серии пропусков 1–6 кадров
      if (q && dropLeft === 0) {
        const edge = P.tag.includes('ребром');
        const wobSize = 1 + 0.1 * osc(0.4, ph[2]) + 0.03 * gauss();
        // выброс: кисть на один кадр сместилась на 0.2–0.4 ширины плеч и/или «выросла» на ±20 %
        const gl = GLITCH > 0 && rnd() < GLITCH;
        const gx = gl ? (rnd() - 0.5) * 0.8 : 0, gy = gl ? (rnd() - 0.5) * 0.8 : 0, gs = gl ? 1 + (rnd() - 0.5) * 0.4 : 1;
        const at = S.at(q.x + gx + 0.05 * osc(0.6, ph[3]) + 0.015 * gauss(), q.y + gy + 0.05 * osc(0.5, ph[4]) + 0.015 * gauss());
        hand = makeHand({
          side: 'left', aspect: S.aspect, ...SHAPES[q.shape], size: q.size * wobSize * gs,
          yaw: (edge ? 1.1 : 0.25) * osc(0.3, ph[5]) + (edge ? 0.3 : 0), pitch: 0.2 * osc(0.35, ph[6]), roll: 0.15 * osc(0.2, ph[7]),
          noise: 0.035, cx: at.cx, cy: at.cy,
        });
        // сдвиг всей сцены (корпус качнулся) уже учтён в S.at
      }
      const hands = hand ? [hand] : [];
      // правая рука: цикл 4 с — «OK» у груди (огонь), указательным рисует ▲ у середины груди,
      // кулак → раскрыть (выброс), расслабленная ладонь; с шумом и пропусками, как левая
      if (RIGHT && P.want !== 'rest' && rnd() > 0.06) {
        const c = ((t - 1000) % 4000) / 1000;
        let q2;
        if (c < 1) q2 = { x: 0.45, y: 0.15, shape: 'ok' };
        else if (c < 2.2) { const a = (c - 1) / 1.2 * 3, k = Math.floor(a), f = a - k; const V = [[0.1, -0.2], [0.35, 0.25], [-0.15, 0.25], [0.1, -0.2]]; q2 = { x: lerp(V[k][0], V[k + 1][0], f), y: lerp(V[k][1], V[k + 1][1], f), shape: 'point' }; }
        else if (c < 3) q2 = { x: 0.5, y: 0.3, shape: 'fist' };
        else if (c < 3.3) q2 = { x: 0.5, y: 0.3, shape: 'open' };
        else q2 = { x: 0.55, y: 0.6, shape: 'open', yaw: 0.9 };
        const at2 = S.at(q2.x + 0.015 * gauss(), q2.y + 0.015 * gauss());
        hands.push(makeHand({ side: 'right', aspect: S.aspect, ...SHAPES[q2.shape], size: SIZE * (1 + 0.03 * gauss()), yaw: q2.yaw || 0.15 * osc(0.3, ph[5] + 1), noise: 0.035, cx: at2.cx, cy: at2.cy }));
      }
      recent.push(hand ? 'x' : '.'); if (recent.length > 16) recent.shift();
      const wr = hand ? { x: hand.landmarks[0].x + 0.004 * gauss(), y: hand.landmarks[0].y + 0.004 * gauss(), visibility: 0.9 } : null;
      const obs = {
        tMs: t, frameW: 640, frameH: 480, mirror: true, hands,
        poseWrists: { left: wr, right: hands[1] ? { x: hands[1].landmarks[0].x, y: hands[1].landmarks[0].y, visibility: 0.9 } : null },
        bodyCenter: (() => { const bg = BODY_GLITCH > 0 && rnd() < BODY_GLITCH; const j = bg ? (rnd() < 0.5 ? -1 : 1) * (0.1 + 0.2 * rnd()) * S.sw : 0; return { x: S.cx + j / S.aspect + 0.004 * gauss(), y: S.cy + (bg ? (rnd() - 0.5) * 0.2 * S.sw : 0) + 0.004 * gauss() }; })(),
        shoulderWidth: NO_SW ? null : S.sw * (1 + 0.02 * gauss()),
      };
      g.push(obs);
      if (recorder) recorder.add(obs);
      const f = g.read(t);
      M.frames++;
      const moving = f.moveZ > 0;
      if (f.dash || f.dashDir) { M.falseDash++; if (DEBUG) console.log(`ложный рывок: seed=${seed} «${P.tag}» +${t - t0} мс`, JSON.stringify(g.getDebug().stick.dash)); }
      // щит вне осознанного толчка — ложный (и в переходах: подъём руки, рука к плечу, резкое руление)
      if (P.want !== 'shield' && P.tag !== 'толчок щита' && P.tag !== 'убрал ладонь' && !(P.tag === 'снова идёт' && prevShield)) {
        if (f.shield) M.falseShieldFrames++;
        if (f.shield && !prevShield) { M.falseShieldOn++; if (DEBUG) console.log(`ложный щит: seed=${seed} «${P.tag}» +${t - t0} мс`, JSON.stringify(g.getDebug().left.push), 'recent hand frames:', recent.join('')); }
      }
      if (P.want === 'walk' || P.want === 'run' || P.want === 'turnL' || P.want === 'turnR') {
        M.walkFrames++;
        if (!moving) M.walkStops++;
        if (!moving && f.stick && f.stick.hold === 'cast') M.castStops++;
        if (prevMoving !== null && moving !== prevMoving) M.flips++;
        if (!riseSeen && moving) riseSeen = true;
      }
      if (P.want === 'walk' || P.want === 'run') {
        const a = Math.abs(f.moveX);
        M.straightTurnSum += a; M.straightFrames++; M.straightTurnMax = Math.max(M.straightTurnMax, a);
      }
      if ((P.want === 'turnL' || P.want === 'turnR') && t - t0 > 500) {
        arc.push(f.moveX);
        if (P.want === 'turnL' ? f.moveX > 0.05 : f.moveX < -0.05) M.wrongTurn++;
      }
      if (P.want === 'rest' && (f.moveZ !== 0 || f.moveX !== 0)) { M.restMove++; if (DEBUG) console.log(`ход в покое: seed=${seed} «${P.tag}» +${t - t0} мс z=${f.moveZ.toFixed(2)} x=${f.moveX.toFixed(2)} рука=${!!hand}`, recent.join('')); }
      if (P.tag === 'подъём' || P.tag === 'подъём 2') { if (moving && !riseSeen) { riseSeen = true; M.riseLatency.push(t - t0); } }
      if (P.tag.startsWith('рука вниз')) { if (!moving && !stopSeen) { stopSeen = true; M.stopLatency.push(t - t0); } }
      if (P.tag === 'толчок щита' || P.tag === 'держит щит') {
        if (f.shield && M.shieldLatency === null) M.shieldLatency = t - (P.tag === 'толчок щита' ? t0 : t0 - 220);
      }
      if (P.want === 'shield') { M.shieldFrames++; if (f.shield) M.shieldHeld++; }
      const trace = process.env.TRACE_TAG ? P.tag === process.env.TRACE_TAG && t - t0 >= +(process.env.TRACE_FROM || 0) && t - t0 <= +(process.env.TRACE_TO || 1e9)
        : (P.tag === 'толчок щита' || (P.tag === 'держит щит' && t - t0 < 500));
      if (DEBUG && trace && process.env.SEED == seed) {
        const d = g.getDebug();
        console.log(P.tag, t - t0, 'shield', f.shield, 'raw', d.left.raw, 'facing', d.left.palmFacing, 'turn', f.moveX.toFixed(2), 'hand', !!hand, JSON.stringify(d.left.push));
      }
      if (P.tag === 'снова идёт' && t - t0 > 600 && f.shield) M.shieldDropped = false;
      if (P.tag === 'снова идёт' && t - t0 > 600 && !f.shield && M.shieldDropped === false && t - t0 < 700) M.shieldDropped = true;
      if (DEBUG) {
        const b = byTag[P.tag] || (byTag[P.tag] = { frames: 0, stops: 0, shield: 0, noHand: 0, stopShield: 0 });
        b.frames++; if (!moving) b.stops++; if (f.shield) b.shield++; if (!hand) b.noHand++; if (!moving && f.shield) b.stopShield++;
      }
      prevShield = f.shield; prevMoving = moving;
    }
    if (arc.length > 3) {
      const m = arc.reduce((a, b) => a + b, 0) / arc.length;
      M.arcStdSum += Math.sqrt(arc.reduce((a, b) => a + (b - m) * (b - m), 0) / arc.length); M.arcN++;
    }
  }
  return M;
}

function summarize(runs) {
  const sum = (k) => runs.reduce((a, r) => a + r[k], 0);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const all = (k) => runs.flatMap((r) => r[k]);
  return {
    seeds: runs.length,
    falseShieldOn: sum('falseShieldOn'),
    falseShieldPct: +(100 * sum('falseShieldFrames') / sum('frames')).toFixed(2),
    falseDash: sum('falseDash'),
    walkStopPct: +(100 * sum('walkStops') / sum('walkFrames')).toFixed(2),
    castStopPct: +(100 * sum('castStops') / sum('walkFrames')).toFixed(2),
    flipsPerMin: +(sum('flips') / (sum('walkFrames') * DT / 60000)).toFixed(1),
    straightTurnAvg: +(sum('straightTurnSum') / sum('straightFrames')).toFixed(3),
    straightTurnMax: +Math.max(...runs.map((r) => r.straightTurnMax)).toFixed(3),
    arcStd: +(runs.reduce((a, r) => a + r.arcStdSum, 0) / runs.reduce((a, r) => a + r.arcN, 0)).toFixed(3),
    wrongTurn: sum('wrongTurn'),
    restMove: sum('restMove'),
    riseMs: Math.round(avg(all('riseLatency'))),
    stopMs: Math.round(avg(all('stopLatency'))),
    shieldUp: runs.filter((r) => r.shieldLatency !== null).length + '/' + runs.length,
    shieldUpPct: +(100 * runs.filter((r) => r.shieldLatency !== null).length / runs.length).toFixed(1),
    shieldMs: Math.round(avg(runs.filter((r) => r.shieldLatency !== null).map((r) => r.shieldLatency))),
    shieldHeldPct: +(100 * sum('shieldHeld') / Math.max(1, sum('shieldFrames'))).toFixed(1),
    shieldDropped: runs.filter((r) => r.shieldDropped).length + '/' + runs.length,
  };
}

const runs = [];
if (ONLY !== null) runs.push(simulate(+ONLY, G_OPTS));
else for (let s = 0; s < SEEDS; s++) runs.push(simulate(1000 + s * 7919, G_OPTS));
const R = summarize(runs);
// игроки, которым удобнее держать ладонь на ~10 см левее / правее нейтрали игры (привычка учится за подъёмы)
if (ONLY === null && !argv.includes('--offset')) {
  const off = [];
  for (const o of [-0.3, 0.3]) {
    NX = -0.55 + o;
    for (let s = 0; s < Math.max(2, SEEDS / 4); s++) off.push(simulate(5000 + s * 7919 + (o > 0 ? 1 : 0), G_OPTS));
  }
  NX = -0.55 + OFFSET;
  const O = summarize(off);
  R.offsetTurnAvg = O.straightTurnAvg; R.offsetShieldUpPct = O.shieldUpPct; R.offsetWrongTurn = O.wrongTurn;
}
// правая рука всё время колдует («OK», руна ▲ у середины груди, выброс) — левая ведёт как обычно
if (ONLY === null && !RIGHT) {
  RIGHT = true;
  const rr = [];
  for (let s = 0; s < Math.max(4, SEEDS / 2); s++) rr.push(simulate(9000 + s * 7919, G_OPTS));
  RIGHT = false;
  const Q = summarize(rr);
  R.rightFalseShieldOn = Q.falseShieldOn; R.rightWalkStopPct = Q.walkStopPct; R.rightCastStopPct = Q.castStopPct;
}
// слабый ноутбук: камера 15 кадров/с (пропуск трекером тех же 1–6 кадров длится вдвое дольше)
if (ONLY === null && !argv.includes('--fps')) {
  DT = 67;
  const ff = [];
  for (let s = 0; s < Math.max(4, SEEDS / 2); s++) ff.push(simulate(21000 + s * 7919, G_OPTS));
  DT = 33;
  const F = summarize(ff);
  R.fps15WalkStopPct = F.walkStopPct; R.fps15FlipsPerMin = F.flipsPerMin; R.fps15FalseShieldOn = F.falseShieldOn;
  R.fps15FalseDash = F.falseDash; R.fps15RestMove = F.restMove; R.fps15ShieldUpPct = F.shieldUpPct;
}
// левая ладонь закрыла плечо: ширины плеч нет — щит и «убрал ладонь» сравнивают размер кисти в кадре
if (ONLY === null && !NO_SW) {
  NO_SW = true;
  const nn = [];
  for (let s = 0; s < Math.max(8, SEEDS); s++) nn.push(simulate(17000 + s * 7919, G_OPTS));
  NO_SW = false;
  const N = summarize(nn);
  R.noSwFalseShieldOn = N.falseShieldOn; R.noSwShieldUpPct = N.shieldUpPct; R.noSwShieldDropped = N.shieldDropped; R.noSwRuns = nn.length;
}
// сбои трекинга: 1 % кадров кисть на один кадр «прыгает» на 0.2–0.4 ширины плеч и/или меняет размер
if (ONLY === null && !GLITCH) {
  GLITCH = 0.01;
  const gg = [];
  for (let s = 0; s < Math.max(4, SEEDS / 2); s++) gg.push(simulate(13000 + s * 7919, G_OPTS));
  GLITCH = 0;
  const Z = summarize(gg);
  R.glitchFalseDash = Z.falseDash; R.glitchWrongTurn = Z.wrongTurn; R.glitchFalseShieldOn = Z.falseShieldOn; R.glitchWalkStopPct = Z.walkStopPct;
}
if (DEBUG) console.table(byTag);
if (recorder) { writeFileSync(SAVE, JSON.stringify(recorder.snapshot())); console.log(`записано: ${SAVE} (${recorder.size()} кадров)`); }
if (JSON_OUT) console.log(JSON.stringify(R));
else {
  console.log('Стресс-прогон «Руль» (синтетика с шумом и пропусками кадров, не реальная камера):');
  for (const [k, v] of Object.entries(R)) console.log(`  ${k.padEnd(16)} ${v}`);
}

// пороги качества (см. BUILD_STATUS.md, раздел V6)
const LIMITS = [
  ['falseShieldOn', (v) => v === 0, 'щит не должен подниматься сам'],
  ['falseDash', (v) => v === 0, 'ложные рывки (в т.ч. резкий перехват руля за 0,15 с)'],
  ['walkStopPct', (v) => v <= 3, 'спотыкания при ходьбе, % кадров'],
  ['straightTurnAvg', (v) => v <= 0.03, 'руль на прямой'],
  ['wrongTurn', (v) => v === 0, 'поворот не в ту сторону'],
  ['restMove', (v) => v === 0, 'рука на коленях — герой стоит'],
  ['stopMs', (v) => v <= 250, 'рука вниз → стоп, мс'],
  ['shieldUpPct', (v) => v >= 90, 'осознанный толчок поднимает щит (кисть в симуляции теряется сериями кадров), %'],
  ['shieldDropped', (v) => v === `${runs.length}/${runs.length}`, 'убрал ладонь назад — щит опустился'],
  ['offsetTurnAvg', (v) => v === undefined || v <= 0.06, 'рука «не там» на 10 см: руль на прямой'],
  ['offsetShieldUpPct', (v) => v === undefined || v >= 90, 'рука «не там» на 10 см: толчок поднимает щит, %'],
  ['offsetWrongTurn', (v) => v === undefined || v === 0, 'рука «не там» на 10 см: поворот не в ту сторону'],
  ['rightFalseShieldOn', (v) => v === undefined || v === 0, 'правая колдует: щит не поднимается сам'],
  ['rightWalkStopPct', (v) => v === undefined || v <= 3, 'правая колдует: герой идёт, % кадров «стоим»'],
  ['noSwFalseShieldOn', (v) => v === undefined || v === 0, 'плечо закрыто ладонью: щит не поднимается сам'],
  ['noSwShieldUpPct', (v) => v === undefined || v >= 80, 'плечо закрыто ладонью: толчок поднимает щит, %'],
  ['noSwShieldDropped', (v) => v === undefined || v === `${R.noSwRuns}/${R.noSwRuns}`, 'плечо закрыто ладонью: убрал ладонь — щит опустился'],
  ['fps15WalkStopPct', (v) => v === undefined || v <= 1, 'камера 15 к/с: герой идёт, % кадров «стоим»'],
  ['fps15FlipsPerMin', (v) => v === undefined || v <= 3, 'камера 15 к/с: мигание ход/стоп в минуту'],
  ['fps15FalseShieldOn', (v) => v === undefined || v === 0, 'камера 15 к/с: щит не поднимается сам'],
  ['fps15FalseDash', (v) => v === undefined || v === 0, 'камера 15 к/с: ложные рывки'],
  ['fps15RestMove', (v) => v === undefined || v <= 3, 'камера 15 к/с: рука на коленях — герой стоит (кадров)'],
  ['glitchFalseDash', (v) => v === undefined || v <= 2, 'сбои трекинга 1 %: ложные рывки'],
  ['glitchWrongTurn', (v) => v === undefined || v === 0, 'сбои трекинга 1 %: поворот не в ту сторону'],
  ['glitchWalkStopPct', (v) => v === undefined || v <= 3, 'сбои трекинга 1 %: герой идёт, % кадров «стоим»'],
];
let bad = 0;
if (!JSON_OUT) console.log('');
for (const [k, fn, what] of LIMITS) {
  const okk = fn(R[k]);
  if (!okk) bad++;
  if (!JSON_OUT) console.log(`${okk ? 'PASS' : 'FAIL'} ${what}: ${k}=${R[k]}`);
}
process.exitCode = bad ? 1 : 0;
