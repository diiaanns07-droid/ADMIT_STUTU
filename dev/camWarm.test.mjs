// ASHEN OATH — dev/camWarm.test.mjs [W5-КАМЕРА]
// Запуск: node dev/camWarm.test.mjs
// «Дешёвый кадр», пока камера запускается, и страж трекинга в бою (core/camWarm.js).
import { camWarmWanted, createFightGuard, CAM_WARM, GUARD_DEFAULTS } from '../core/camWarm.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 3).join('\n     ')}`); }
}
function ok(c, m) { if (!c) throw new Error(m || 'условие не выполнено'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ожидалось'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

test('W01 дешёвый кадр: пока камера запускается (permission/loading/calibrating) — на любом экране', () => {
  for (const status of ['permission', 'loading', 'calibrating']) {
    for (const screen of ['camera', 'calibration', 'menu', 'paused', 'tutorial']) ok(camWarmWanted({ screen, status }), `${screen}/${status}`);
  }
});

test('W02 после «ready» с калибровкой — всё как было; меню и бой без камеры — как было', () => {
  eq(camWarmWanted({ screen: 'camera', status: 'ready', calibrated: true }), false, 'камера готова и откалибрована');
  eq(camWarmWanted({ screen: 'playing', status: 'ready', calibrated: true }), false, 'бой');
  eq(camWarmWanted({ screen: 'menu', status: 'idle' }), false, 'меню без камеры');
  eq(camWarmWanted({ screen: 'menu', status: 'ready', calibrated: false }), false, 'курсор-кисть в меню уже работает');
  eq(camWarmWanted({ screen: 'playing', status: 'lost', calibrated: true }), false, 'потеря в бою — не прогрев');
  eq(camWarmWanted({ screen: 'camera', status: 'error' }), false, 'ошибка камеры');
});

test('W03 экран камеры и калибровки: камера работает, калибровки ещё нет — дешёвый кадр держится (без мигания loading→ready→calibrating)', () => {
  ok(camWarmWanted({ screen: 'camera', status: 'ready', calibrated: false }));
  ok(camWarmWanted({ screen: 'camera', status: 'lost', calibrated: null }));
  ok(camWarmWanted({ screen: 'calibration', status: 'ready', calibrated: false }));
});

test('W04 отладка с клавиатуры, ?uncapped=1 и ?benchcam — без дешёвого кадра (замеры не меняются)', () => {
  eq(camWarmWanted({ screen: 'camera', status: 'loading', debug: true }), false);
  eq(camWarmWanted({ screen: 'camera', status: 'loading', off: true }), false);
  ok(CAM_WARM.prK < 1 && CAM_WARM.prK >= 0.5, 'плотность пикселей ниже, но не мыло');
  ok(CAM_WARM.gapMs > 1000 / 45 && CAM_WARM.gapMs < 1000 / 30, '≈30 к/с на экранах 60/120 Гц');
});

// поток статуса распознавания: hz(t) каждые 250 мс
function run(g, ms, hzAt, o = {}) {
  const acts = [];
  for (let t = o.t0 || 0; t <= (o.t0 || 0) + ms; t += 250) {
    const a = g.update(t, { active: o.active !== false, hz: hzAt(t), cameraFps: o.cam ?? 30, tier: o.tier(), auto: o.auto !== false });
    if (a) { acts.push({ t, ...a }); if (a.tier) o.setTier(a.tier); }
  }
  return acts;
}
function rig(tier0 = 'medium') {
  const st = { tier: tier0 };
  return { st, tier: () => st.tier, setTier: (q) => { st.tier = q; } };
}

test('W05 бой: распознаваний < 12 дольше 3 с → качество ниже (perfTuner), ещё 3 с плохо → предел 30 к/с', () => {
  const g = createFightGuard();
  const r = rig('high');
  const acts = run(g, 2750, () => 8, r);
  eq(acts.length, 0, 'меньше 3 с — ничего');
  const a2 = run(g, 500, () => 8, { ...r, t0: 3000 });
  eq(a2.length, 1, 'на 3-й секунде — ступень');
  eq(a2[0].level, 1); eq(a2[0].tier, 'medium', 'high → medium'); eq(a2[0].cap, false);
  eq(r.st.tier, 'medium');
  const a3 = run(g, 3500, () => 8, { ...r, t0: 3750 });
  eq(a3.length, 1); eq(a3[0].level, 2); eq(a3[0].cap, true, 'дальше — 30 к/с'); eq(a3[0].tier, undefined, 'уровень второй раз не трогаем');
  eq(run(g, 10000, () => 8, { ...r, t0: 7500 }).length, 0, 'ниже ступени 2 не идём');
});

test('W06 восстановилось (≥ 16/с 5 с) — ступени обратно, качество как было', () => {
  const g = createFightGuard();
  const r = rig('high');
  run(g, 7000, () => 8, r);
  eq(g.level, 2);
  const back = run(g, 12000, () => 25, { ...r, t0: 7250 });
  eq(back.map((a) => a.level).join(','), '1,0', 'по ступени');
  eq(back[0].cap, false, 'сначала снимается предел кадров');
  eq(back[1].tier, 'high', 'потом возвращается качество');
  eq(r.st.tier, 'high');
});

test('W07 качество уже low или выбрано вручную — сразу предел 30 к/с, уровень не трогаем', () => {
  for (const [tier, auto] of [['low', true], ['high', false]]) {
    const g = createFightGuard();
    const r = rig(tier);
    const acts = run(g, 3500, () => 6, { ...r, auto });
    eq(acts.length, 1, `${tier}/${auto}`); eq(acts[0].cap, true); eq(acts[0].tier, undefined); eq(r.st.tier, tier);
    const back = run(g, 6000, () => 25, { ...r, auto, t0: 3750 });
    eq(back.length, 1); eq(back[0].level, 0); eq(back[0].cap, false);
  }
});

test('W08 камера сама даёт 10 к/с (тусклый свет): распознавание 9/с — не повод понижать графику', () => {
  const g = createFightGuard();
  const r = rig('high');
  eq(run(g, 8000, () => 9, { ...r, cam: 10 }).length, 0);
  eq(run(g, 8000, () => 6, { ...r, cam: 10, t0: 8250 }).length > 0, true, 'а 6 из 10 — уже повод');
});

test('W09 снова плохо сразу после возврата — до конца боя без возвратов; конец боя — всё как было', () => {
  const g = createFightGuard();
  const r = rig('medium');
  run(g, 3500, () => 8, r);
  eq(r.st.tier, 'low');
  run(g, 5500, () => 25, { ...r, t0: 3750 });
  eq(r.st.tier, 'medium', 'вернули');
  run(g, 3500, () => 8, { ...r, t0: 9500 });
  eq(r.st.tier, 'low', 'снова ниже');
  eq(run(g, 20000, () => 30, { ...r, t0: 13250 }).length, 0, 'возвратов больше нет');
  ok(g.state().pinned, 'закреплено');
  const end = g.reset(40000);
  eq(end.tier, 'medium', 'конец боя — уровень как был'); eq(end.cap, false); eq(g.level, 0);
  eq(g.reset(41000), null, 'повторный сброс ничего не делает');
});

test('W10 вне боя (пауза, меню) и без данных распознавания — страж молчит', () => {
  const g = createFightGuard();
  const r = rig('high');
  eq(run(g, 8000, () => 4, { ...r, active: false }).length, 0, 'не бой');
  eq(run(g, 8000, () => null, r).length, 0, 'нет частоты');
  ok(GUARD_DEFAULTS.lowHz === 12 && GUARD_DEFAULTS.badMs === 3000, 'пороги из задачи: < 12/с дольше 3 с');
});

test('W11 уровень сменил сам perfTuner во время ступени — страж его не возвращает', () => {
  const g = createFightGuard();
  const r = rig('high');
  run(g, 3500, () => 8, r);
  eq(r.st.tier, 'medium');
  r.st.tier = 'low';   // perfTuner опустил ещё ниже сам
  const back = run(g, 12000, () => 25, { ...r, t0: 3750 });
  ok(back.every((a) => !a.tier), 'уровень не трогаем — им управляет perfTuner');
  eq(r.st.tier, 'low');
});

console.log(`\nИтог: ${passed} пройдено, ${failed} не пройдено.`);
process.exitCode = failed ? 1 : 0;
