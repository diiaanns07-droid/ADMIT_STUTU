// [FOREST] Проверки modules/brightForest.js без браузера: контракт C7, поляна дуэлей, рельеф.
// node dev/brightForest.test.mjs   (код выхода 1 при ошибке)
import { BRIGHT_FOREST as B, brightForestHeight, brightForestTint, FOREST_PLAN as P } from '../modules/brightForest.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };
const fin = (v) => Number.isFinite(v);

// C7: форма экспорта
ok(B.id === 'bright-forest' && B.name === 'Сияющий лес', 'id и name');
ok([B.x, B.z, B.r, B.level].every(fin) && B.r >= 55 && B.r <= 70, 'x, z, r (55–70), level');
ok(B.duel && [B.duel.x, B.duel.z, B.duel.r].every(fin) && B.duel.r >= 18 && B.duel.r <= 22, 'duel {x,z,r 18–22}');
ok(Array.isArray(B.duel.spawns) && B.duel.spawns.length === 2 && B.duel.spawns.every((s) => [s.x, s.z, s.yaw].every(fin)), 'duel.spawns: две точки {x,z,yaw}');
ok(Object.isFrozen(B) && Object.isFrozen(B.duel) && Object.isFrozen(B.duel.spawns), 'экспорт заморожен');

// Спавны: внутри круга, друг напротив друга, лицом к центру
const [a, b] = B.duel.spawns;
ok(Math.hypot(a.x - B.duel.x, a.z - B.duel.z) < B.duel.r - 4 && Math.hypot(b.x - B.duel.x, b.z - B.duel.z) < B.duel.r - 4, 'спавны внутри поляны (≥4 м от края)');
ok(Math.abs((a.x + b.x) / 2 - B.duel.x) < 0.01 && Math.abs((a.z + b.z) / 2 - B.duel.z) < 0.01, 'спавны симметричны относительно центра');
ok(Math.hypot(a.x - b.x, a.z - b.z) >= 18, 'между спавнами ≥ 18 м');
for (const s of [a, b]) {
  const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), tx = B.duel.x - s.x, tz = B.duel.z - s.z;
  ok((fx * tx + fz * tz) / Math.hypot(tx, tz) > 0.99, `спавн (${s.x}, ${s.z}) смотрит в центр`);
}

// Поляна ровная: высота = level во всём круге (±2 см), при любом y0 мира
let maxDev = 0;
for (let i = 0; i < 2000; i++) {
  const r = Math.sqrt(Math.random()) * B.duel.r, t = Math.random() * Math.PI * 2;
  const x = B.duel.x + Math.sin(t) * r, z = B.duel.z + Math.cos(t) * r;
  maxDev = Math.max(maxDev, Math.abs(brightForestHeight(x, z, -7 + Math.random() * 14) - B.level));
}
ok(maxDev < 0.02, `поляна ровная (отклонение ${maxDev.toFixed(4)} м)`);

// Укрытия — на краю поляны, не в центре; симметричны
ok(P.covers.length >= 4 && P.covers.length <= 6, 'укрытий 4–6');
ok(P.covers.every((c) => Math.hypot(c.x - B.duel.x, c.z - B.duel.z) > 6), 'укрытия не в центре');
ok(P.covers.every((c) => P.covers.some((d) => Math.abs(d.x + c.x - 2 * B.duel.x) < 0.01 && Math.abs(d.z + c.z - 2 * B.duel.z) < 0.01)), 'укрытия центрально-симметричны');
for (const s of [a, b]) ok(P.covers.every((c) => Math.hypot(c.x - s.x, c.z - s.z) > 3), 'укрытие не на спавне');

// Рельеф: вне зоны — мир как есть, шов без ступеней, без NaN
ok(brightForestHeight(B.x + B.r + 31, B.z, 3.3) === 3.3 && brightForestHeight(B.x, B.z - B.r - 40, -1) === -1, 'вне r+30 рельеф мира не меняется');
let nan = 0, jump = 0;
for (let k = 0; k < 360; k++) {
  const t = (k / 360) * Math.PI * 2;
  let prev = null;
  for (let r = 0; r <= B.r + 32; r += 0.5) {
    const x = B.x + Math.sin(t) * r, z = B.z + Math.cos(t) * r, h = brightForestHeight(x, z, -1.5);
    if (!fin(h)) nan++;
    if (prev !== null && Math.abs(h - prev) > 3.2) jump++;   // обрыв гряды ~11 м на 5 м — до 1.2 м на шаг 0.5
    prev = h;
  }
}
ok(nan === 0, 'рельеф без NaN');
ok(jump === 0, 'рельеф без ступеней (скачок > 3.2 м на 0.5 м)');
ok(brightForestTint(B.x, B.z) === 1 && brightForestTint(B.x + B.r + 40, B.z) === 0, 'тон земли: 1 в центре, 0 вне зоны');

// Вода и водопад: озеро ниже уровня поляны, гряда выше
ok(P.waterY < B.level, 'озеро ниже поляны');
ok(brightForestHeight(P.lake.x, P.lake.z, 0) < P.waterY - 0.5, 'дно озера под водой');
ok(brightForestHeight(P.fall.lip.x, P.fall.lip.z, 0) > P.waterY + 8, 'кромка водопада выше озера на 8+ м');
ok(Math.hypot(P.lake.x - B.duel.x, P.lake.z - B.duel.z) > B.duel.r + P.lake.r + 4, 'озеро не задевает поляну');

// Старт «Сияющий лес» и дорога: у врат, вне поляны
ok(B.start && [B.start.x, B.start.z, B.start.yaw].every(fin), 'start {x,z,yaw}');
const ds = Math.hypot(B.start.x - B.x, B.start.z - B.z);
ok(ds > B.r + 4 && ds < B.r + 16, `старт у края зоны (${ds.toFixed(1)} м от центра)`);
const last = B.road[B.road.length - 1];
ok(Math.hypot(last[0] - B.start.x, last[1] - B.start.z) < 3, 'дорога от арены приходит к месту старта');
ok(B.embers.length === 2, 'два угля клятвы');

if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log('\nВсе проверки Сияющего леса пройдены');
