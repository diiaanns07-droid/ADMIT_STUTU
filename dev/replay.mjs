// [V6 · CONTROLS] Разбор записи кистей с живой камеры: node dev/replay.mjs запись.json [ключи]
//
// Запись делает игра: адрес с ?rec=1 (например http://127.0.0.1:87xx/?rec=1), в бою F8 — файл
// ashen-hands-….json. Скрипт прогоняет её через core/handGestures.js (как в игре) и печатает:
//   • хронологию: щит вверх/вниз, рывки, парирование, ход/стоп, подсказки — с временем от начала;
//   • сводку: сколько раз и надолго поднимался щит, сколько раз герой вставал, дрожь руля, провалы кисти.
// Ключи:
//   --mode steer|stick      схема движения (по умолчанию — из записи, иначе «Руль»)
//   --cfg '{"shieldPushRatioSteer":1.3}'  подмена порогов handGestures (проверить правку на той же записи)
//   --quiet                 только сводка
//   --json                  сводка в JSON
//   --push-debug            в хронологии щита — признаки толчка (span/fast/scale/turned)
//   --combat                ещё и прогнать героя в настоящем бою (modules/combat.js, 60 Гц, без босса):
//                           сколько прошёл, сколько раз вставал посреди хода, сколько стоял со щитом

import { readFileSync } from 'node:fs';
import { createHandGestures } from '../core/handGestures.js';
import { unpackFrame } from '../core/inputRecorder.js';
import { createCombat, DEFAULT_LAYOUT } from '../modules/combat.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--') && !/^\{/.test(a) && argv[argv.indexOf(a) - 1] !== '--mode' && argv[argv.indexOf(a) - 1] !== '--cfg');
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
if (!file) {
  console.log('Использование: node dev/replay.mjs запись.json [--mode steer|stick] [--cfg \'{…}\'] [--quiet] [--json] [--push-debug]');
  console.log('Запись: откройте игру с ?rec=1, в бою нажмите F8.');
  process.exit(2);
}
const rec = JSON.parse(readFileSync(file, 'utf8'));
if (!rec || rec.kind !== 'ashen-hands' || !Array.isArray(rec.frames)) { console.error('Это не запись ashen-hands'); process.exit(2); }
const mode = argOf('--mode', rec.moveMode === 'stick' ? 'stick' : 'steer');
const cfg = JSON.parse(argOf('--cfg', '{}'));
const QUIET = argv.includes('--quiet') || argv.includes('--json');
const PUSH_DBG = argv.includes('--push-debug');

const g = createHandGestures({ ...cfg, moveMode: mode });
const frames = rec.frames.map(unpackFrame).filter(Boolean);
if (!frames.length) { console.error('В записи нет кадров'); process.exit(2); }
const t0 = frames[0].tMs;
const ts = (t) => `${((t - t0) / 1000).toFixed(2).padStart(7)} с`;
const log = (t, s) => { if (!QUIET) console.log(`${ts(t)}  ${s}`); };

const S = {
  seconds: (frames[frames.length - 1].tMs - t0) / 1000, frames: frames.length,
  shieldUps: 0, shieldMs: 0, shieldShort: 0, dashes: 0, parries: 0, sparks: 0, bursts: 0, runes: 0,
  moveMs: 0, stops: 0, stopsShort: 0, noLeftFrames: 0, turnStraightSum: 0, turnStraightN: 0, hints: {},
};
let prev = null, shieldAt = null, stopAt = null, lastT = t0;
for (const obs of frames) {
  g.push(obs);
  const t = obs.tMs, dt = t - lastT; lastT = t;
  const f = g.read(t);
  const moving = f.moveZ > 0 || Math.abs(f.moveX) > 0.02;
  if (!f.left) S.noLeftFrames++;
  if (prev) {
    if (f.shield && !prev.shield) {
      S.shieldUps++; shieldAt = t;
      const p = g.getDebug().left.push;
      log(t, `ЩИТ ▲${PUSH_DBG && p ? '  ' + JSON.stringify(p) : ''}`);
    }
    if (!f.shield && prev.shield) {
      const ms = t - shieldAt; S.shieldMs += ms; if (ms < 400) S.shieldShort++;
      log(t, `щит ▼ (держался ${Math.round(ms)} мс)`);
    }
    if (prev.moving && !moving) { stopAt = t; S.stops++; }
    if (!prev.moving && moving && stopAt !== null) {
      const ms = t - stopAt;
      if (ms < 300) { S.stopsShort++; log(t, `запинка: герой стоял ${Math.round(ms)} мс${f.shield || prev.shield ? ' (щит)' : ''}`); }
      stopAt = null;
    }
  }
  if (moving) S.moveMs += dt;
  if (f.dashDir) { S.dashes++; log(t, `РЫВОК x=${f.dashDir.x.toFixed(2)} z=${f.dashDir.z.toFixed(2)}`); }
  if (f.parry) { S.parries++; log(t, 'парирование'); }
  if (f.spark) S.sparks++;
  if (f.burst) S.bursts++;
  if (f.rune) { S.runes++; log(t, `руна ${f.rune}`); }
  if (f.hint) { S.hints[f.hint.code] = (S.hints[f.hint.code] || 0) + 1; log(t, `подсказка ${f.hint.code}`); }
  if (f.moveZ > 0 && f.stick && f.stick.mode === 'steer' && Math.abs(f.moveX) < 0.3) { S.turnStraightSum += Math.abs(f.moveX); S.turnStraightN++; }
  prev = { shield: f.shield, moving };
}
if (prev && prev.shield) S.shieldMs += lastT - shieldAt;

const R = {
  file, mode, seconds: +S.seconds.toFixed(1), frames: S.frames, fps: +(S.frames / Math.max(1e-3, S.seconds)).toFixed(1),
  shieldUps: S.shieldUps, shieldShortUps: S.shieldShort, shieldSeconds: +(S.shieldMs / 1000).toFixed(1),
  heroMovingPct: +(100 * S.moveMs / Math.max(1, S.seconds * 1000)).toFixed(1),
  stops: S.stops, stumbles: S.stopsShort, dashes: S.dashes, parries: S.parries, sparks: S.sparks, bursts: S.bursts, runes: S.runes,
  leftHandMissingPct: +(100 * S.noLeftFrames / S.frames).toFixed(1),
  turnJitter: S.turnStraightN ? +(S.turnStraightSum / S.turnStraightN).toFixed(3) : null,
  hints: S.hints,
  steer: g.getDebug().stick && g.getDebug().stick.counters,
};
// герой в настоящем бою: тот же поток кадров → handGestures → combat.update (60 Гц), босс спит
if (argv.includes('--combat')) {
  const g2 = createHandGestures({ ...cfg, moveMode: mode });
  const idle = { reset() {}, update() { return { stage: 1, action: 'idle', attacks: [] }; } };
  const c = createCombat({ config: {}, bossBrain: idle, layout: { ...DEFAULT_LAYOUT, playerSpawn: { x: 0, z: 30, yaw: Math.PI } } });
  let fi = 0, dist = 0, prevP = null, stopsMid = 0, moving = false, shieldS = 0, prevYaw = null, prevRate = null, jerk = 0, n = 0;
  for (let t = t0; t < lastT; t += 1000 / 60) {
    while (fi < frames.length && frames[fi].tMs <= t) g2.push(frames[fi++]);
    const f = g2.read(t);
    c.update(1 / 60, { source: 'debug', valid: true, calibrated: true, tMs: t, moveX: f.moveX, moveZ: f.moveZ, dash: 0, attack: false, shield: f.shield, burst: false, moveMode: mode, stick: f.stick, dashDir: f.dashDir });
    const sn = c.getSnapshot(), p = sn.player.position;
    if (prevP) { const sp = Math.hypot(p.x - prevP.x, p.z - prevP.z) * 60; dist += sp / 60; if (moving && sp < 0.3) { stopsMid++; moving = false; } else if (sp > 0.8) moving = true; }
    if (sn.player.shielding) shieldS += 1 / 60;
    if (prevYaw !== null) { const rate = Math.atan2(Math.sin(sn.player.yaw - prevYaw), Math.cos(sn.player.yaw - prevYaw)) * 60; if (prevRate !== null) { jerk += Math.abs(rate - prevRate); n++; } prevRate = rate; }
    prevYaw = sn.player.yaw; prevP = { ...p };
  }
  R.combat = { meters: +dist.toFixed(1), stopsMidWalk: stopsMid, shieldSeconds: +shieldS.toFixed(1), headingJerk: n ? +(jerk / n).toFixed(4) : 0 };
}
if (argv.includes('--json')) console.log(JSON.stringify(R));
else {
  console.log('\nСводка (прогон записи через core/handGestures.js):');
  console.log(`  запись: ${R.seconds} с, ${R.frames} кадров (${R.fps} кадр/с), схема «${mode === 'steer' ? 'Руль' : 'Джойстик'}»`);
  console.log(`  щит: поднимался ${R.shieldUps} раз (из них коротких < 0,4 с: ${R.shieldShortUps}), всего ${R.shieldSeconds} с`);
  console.log(`  герой шёл ${R.heroMovingPct} % времени; остановок ${R.stops}, из них запинок < 0,3 с: ${R.stumbles}`);
  console.log(`  рывков ${R.dashes}, парирований ${R.parries}, искр ${R.sparks}, выбросов ${R.bursts}, рун ${R.runes}`);
  console.log(`  левая кисть потеряна (> 0,3 с) ${R.leftHandMissingPct} % кадров; дрожь руля на прямой ${R.turnJitter}`);
  if (Object.keys(R.hints).length) console.log(`  подсказки: ${JSON.stringify(R.hints)}`);
  if (R.steer) console.log(`  руль: подъёмов ${R.steer.raises}, стопов ${R.steer.stops}, выучено привычек ${R.steer.learned}, отклонено рывков-руления ${R.steer.dashSteer}`);
  if (R.combat) console.log(`  герой в бою: прошёл ${R.combat.meters} м, вставал посреди хода ${R.combat.stopsMidWalk} раз, со щитом ${R.combat.shieldSeconds} с, дёрганье курса ${R.combat.headingJerk}`);
}
