// node dev/net.test.mjs — сеть онлайн-дуэли (№2 [NET]): коды комнат, упаковка st/ev/pr,
// буфер интерполяции (пинг 150 мс, 5% потерь — без телепортов), net.js поверх транспорта 'local'
// (BroadcastChannel есть в Node ≥ 18): hello, ping/RTT, обрыв за 3 с и восстановление, bye.
import assert from 'node:assert/strict';
import { makeRoomCode, isValidRoomCode, normalizeRoomCode, ROOM_ALPHABET, createNet } from '../net/net.js';
import { encodeState, decodeState, encodeEvent, decodeEvent, encodeProjectiles, decodeProjectiles } from '../net/sync.js';
import { createInterpBuffer } from '../net/interp.js';

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

// ------------------------------------------------------------ коды
await t('код комнаты: 4–5 символов без 0/O/1/I', () => {
  for (const ch of '0O1I') assert.ok(!ROOM_ALPHABET.includes(ch));
  for (let i = 0; i < 500; i++) { const c = makeRoomCode(i % 2 ? 5 : 4); assert.ok(isValidRoomCode(c), c); }
  assert.equal(normalizeRoomCode(' ab-3k '), 'AB3K');
  assert.ok(!isValidRoomCode('AB0K'));
  assert.ok(!isValidRoomCode('ABC'));
  assert.ok(!isValidRoomCode('ABCDEF'));
});

// ------------------------------------------------------------ упаковка
const P = {
  position: { x: 12.3456, y: 0.02, z: -7.891 }, yaw: 1.23456, velocity: { x: 3.333, z: -1.111 },
  hp: 87.66, maxHp: 120, energy: 44.4, maxEnergy: 100, action: 'shield', locomotion: 'run',
  shielding: true, invulnerable: false, dashing: true, dashDir: { x: 0.7, z: 0.7 }, sprint: 0.6,
  conjure: { kind: 'orb', size: 0.555, charge: 0.9 }, burstCharge: 0.42, warded: true,
};
await t('st: компактно и обратимо', () => {
  const input = { bow: { active: true, draw: 0.73, aimX: -0.2, aimY: 0.1, charged: true, element: 'fire' }, handSpell: { phase: 'hold', element: 'frost', power: 0.5, dir: { x: 0.1, y: -0.3 } } };
  const m = encodeState(P, input, 7, 1234.5);
  const json = JSON.stringify({ t: 'st', ...m });
  assert.ok(json.length < 330, `пакет ${json.length} байт`);
  const d = decodeState(JSON.parse(json));
  assert.equal(d.seq, 7); assert.equal(d.ts, 1235);
  assert.ok(Math.abs(d.position.x - 12.35) < 1e-9 && Math.abs(d.position.z + 7.89) < 1e-9);
  assert.ok(Math.abs(d.yaw - 1.235) < 1e-9);
  assert.equal(d.action, 'shield'); assert.equal(d.locomotion, 'run');
  assert.equal(d.shielding, true); assert.equal(d.dashing, true); assert.equal(d.invulnerable, false); assert.equal(d.warded, true);
  assert.deepEqual(d.dashDir, { x: 0.7, z: 0.7 });
  assert.equal(d.conjure.kind, 'orb'); assert.equal(d.burstCharge, 0.42);
  assert.equal(d.bow.draw, 0.73); assert.equal(d.bow.charged, true); assert.equal(d.bow.element, 'fire');
  assert.equal(d.handSpell.phase, 'hold'); assert.equal(d.handSpell.element, 'frost');
  assert.equal(d.hp, 87.7); assert.equal(d.maxHp, 120);
  // без лука/чар/щита — ещё короче
  const idle = encodeState({ ...P, conjure: null, dashing: false, burstCharge: 0, sprint: 0 }, {}, 1, 1);
  assert.ok(JSON.stringify(idle).length < 170, JSON.stringify(idle));
});
await t('ev: только нужные сопернику, data.remote = true, id снарядов с префиксом', () => {
  assert.equal(encodeEvent({ id: 'ev1', type: 'boss_hit', position: { x: 0, y: 0, z: 0 }, data: {} }), null);
  assert.equal(encodeEvent({ id: 'ev2', type: 'projectile_impact', position: { x: 0, y: 0, z: 0 }, data: { owner: 'boss' } }), null);
  assert.equal(encodeEvent({ id: 'ev3', type: 'player_cast', position: { x: 0, y: 0, z: 0 }, data: { remote: true } }), null, 'эхо чужого не пересылаем');
  const x = encodeEvent({ id: 'ev9', type: 'player_cast', position: { x: 1.23456, y: 1, z: 2 }, data: { ability: 'spark', projectileId: 'p5', velocity: { x: 1, y: 0, z: 2 } } });
  const e = decodeEvent(JSON.parse(JSON.stringify({ t: 'ev', e: x })));
  assert.equal(e.id, 'r-ev9'); assert.equal(e.type, 'player_cast');
  assert.equal(e.data.remote, true); assert.equal(e.data.projectileId, 'r:p5');
  assert.equal(e.position.x, 1.235);
  for (const ty of ['bow_release', 'hand_spell_throw', 'shield_start', 'player_slash', 'player_dash', 'rune_cast', 'sigil_cast', 'burst', 'parry']) {
    assert.ok(encodeEvent({ id: 'a', type: ty, position: { x: 0, y: 0, z: 0 }, data: {} }), ty);
  }
});
await t('pr: свои снаряды → чужие с префиксом r:', () => {
  const list = [
    { id: 'p1', owner: 'player', kind: 'bolt', position: { x: 1, y: 1.4, z: 2 }, velocity: { x: 0, y: 0, z: 20 }, radius: 0.3 },
    { id: 'o1', owner: 'boss', kind: 'orb', position: { x: 0, y: 3, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, radius: 0.6 },
    { id: 'p2', owner: 'player', kind: 'hand_orb', element: 'fire', position: { x: 0, y: 1, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, radius: 0.4 },
  ];
  const d = decodeProjectiles(JSON.parse(JSON.stringify(encodeProjectiles(list, 5))));
  assert.equal(d.length, 2);
  assert.equal(d[0].id, 'r:p1'); assert.equal(d[0].owner, 'opponent'); assert.equal(d[0].remote, true);
  assert.equal(d[1].element, 'fire'); assert.equal(d[1].kind, 'hand_orb');
});

// ------------------------------------------------------------ интерполяция
function simulateRun({ pingMs, jitterMs, loss, seconds = 6, seed = 1 }) {
  // соперник бежит по кругу R=8 м со скоростью 6 м/с и делает рывки; пакеты 20 Гц
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const clockSkew = 123456.7;           // часы соперника сдвинуты — буфер не должен зависеть от этого
  const truth = (tMs) => { const w = 6 / 8; const a = (tMs / 1000) * w; return { x: Math.sin(a) * 8, z: Math.cos(a) * 8, vx: Math.cos(a) * 6, vz: -Math.sin(a) * 6, yaw: a + Math.PI / 2 }; };
  const arrivals = [];
  for (let tMs = 0, seq = 0; tMs < seconds * 1000; tMs += 50, seq++) {
    if (rnd() < loss) continue;
    const p = truth(tMs);
    const st = { seq, ts: tMs + clockSkew, position: { x: p.x, y: 0, z: p.z }, yaw: p.yaw, velocity: { x: p.vx, z: p.vz } };
    arrivals.push({ at: tMs + pingMs / 2 + (rnd() * 2 - 1) * jitterMs, st });
  }
  arrivals.sort((a, b) => a.at - b.at);
  const buf = createInterpBuffer({ delayMs: 100 });
  let i = 0, maxStep = 0, maxErr = 0, prev = null, frames = 0, bad = 0;
  for (let now = 0; now < seconds * 1000; now += 1000 / 60) {
    while (i < arrivals.length && arrivals[i].at <= now) { buf.push(arrivals[i].st, arrivals[i].at); i++; }
    const o = buf.sample(now);
    if (!o.ok || now < 800) { prev = null; continue; }
    frames++;
    if (prev) {
      const step = Math.hypot(o.x - prev.x, o.z - prev.z);
      maxStep = Math.max(maxStep, step);
      if (step > 6 / 60 * 1.8) bad++;
    }
    // отставание от правды — примерно пинг/2 + буфер
    const lag = pingMs / 2 + 100 + jitterMs;
    const tr = truth(now - lag);
    maxErr = Math.max(maxErr, Math.hypot(o.x - tr.x, o.z - tr.z));
    prev = { x: o.x, z: o.z };
  }
  return { maxStep, maxErr, frames, bad };
}
await t('интерполяция: пинг 150 мс, 5% потерь — плавно, без телепортов', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = simulateRun({ pingMs: 150, jitterMs: 20, loss: 0.05, seed });
    // 6 м/с при 60 fps — 0,1 м за кадр; телепорт был бы > 0,3 м
    assert.ok(r.maxStep < 0.19, `seed ${seed}: шаг ${r.maxStep.toFixed(3)} м`);
    assert.ok(r.bad <= 2, `seed ${seed}: рывков ${r.bad}`);
    assert.ok(r.maxErr < 0.9, `seed ${seed}: ошибка ${r.maxErr.toFixed(2)} м`);
  }
});
await t('интерполяция: 15% потерь и пинг 300 мс — всё ещё без телепортов', () => {
  const r = simulateRun({ pingMs: 300, jitterMs: 40, loss: 0.15, seed: 9 });
  assert.ok(r.maxStep < 0.3, `шаг ${r.maxStep.toFixed(3)}`);
});
await t('интерполяция: рывок 15,6 м/с во время потерь — без скачка при коррекции', () => {
  // круг 6 м/с, раз в 2 с рывок ×2,6 на 0,22 с (как стенд dev/net-harness.html); 60 fps
  let worst = 0;
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    let s = seed;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const path = [];                        // истинная траектория с шагом 1/240 с
    let x = 0, z = 8, a = 0;
    for (let i = 0; i <= 8 * 240; i++) {
      const tt = i / 240, dash = (tt % 2) < 0.22 && tt > 1 ? 2.6 : 1;
      const vx = Math.cos(a) * 6 * dash, vz = -Math.sin(a) * 6 * dash;
      path.push({ x, z, vx, vz });
      x += vx / 240; z += vz / 240; a += (6 / 8) / 240;
    }
    const arrivals = [];
    for (let tMs = 0, seq = 0; tMs < 8000; tMs += 50, seq++) {
      if (rnd() < 0.05) continue;
      const p = path[Math.round(tMs * 0.24)];
      arrivals.push({ at: tMs + 75 + (rnd() * 2 - 1) * 15, st: { seq, ts: tMs, position: { x: p.x, y: 0, z: p.z }, yaw: 0, velocity: { x: p.vx, z: p.vz } } });
    }
    arrivals.sort((q1, q2) => q1.at - q2.at);
    const buf = createInterpBuffer({ delayMs: 100 });
    let i = 0, prev = null;
    for (let now = 0; now < 8000; now += 1000 / 60) {
      while (i < arrivals.length && arrivals[i].at <= now) { buf.push(arrivals[i].st, arrivals[i].at); i++; }
      const o = buf.sample(now);
      if (!o.ok || now < 800) continue;
      if (prev) worst = Math.max(worst, Math.hypot(o.x - prev.x, o.z - prev.z));
      prev = { x: o.x, z: o.z };
    }
  }
  // рывок сам по себе — 0,26 м за кадр; без сглаживания коррекция давала до ~0,9 м
  assert.ok(worst < 0.4, `max шаг ${worst.toFixed(3)} м`);
});
await t('интерполяция: скачок > 6 м (респаун) — сразу, без «полёта»', () => {
  const buf = createInterpBuffer({ delayMs: 100 });
  for (let k = 0; k < 10; k++) buf.push({ ts: k * 50, position: { x: k < 5 ? 0 : 20, y: 0, z: 0 }, yaw: 0, velocity: { x: 0, z: 0 } }, k * 50 + 40);
  const xs = [];
  for (let now = 300; now < 800; now += 16) xs.push(buf.sample(now).x);
  assert.ok(xs.every((x) => x === 0 || x === 20), xs.join(','));
});

// ------------------------------------------------------------ net.js + 'local'
await t('net local: hello, ping, st/ev, обрыв 3 с → lost → восстановление, bye', async () => {
  const A = createNet({ transport: 'local', name: 'Аня', hero: 'elf', sim: { pingMs: 150, jitterMs: 10, loss: 0.05 } });
  const B = createNet({ transport: 'local', name: 'Боря', hero: 'dark', sim: { pingMs: 150, jitterMs: 10, loss: 0.05 } });
  const log = [];
  A.on('state', (s) => log.push(`A:${s}`));
  B.on('state', (s) => log.push(`B:${s}`));
  const code = await A.host();
  assert.ok(isValidRoomCode(code));
  assert.equal(A.isHost, true);
  await assert.rejects(() => B.join('ZZZZ', { timeoutMs: 600 }), (e) => e.code === 'room_not_found');
  await B.join(code);
  assert.equal(B.state, 'connected');
  assert.ok(await until(() => A.state === 'connected'));
  assert.equal(A.remote.name, 'Боря'); assert.equal(B.remote.hero, 'elf');
  assert.ok(await until(() => A.ping > 0 && B.ping > 0, 3000));
  assert.ok(A.ping > 110 && A.ping < 230, `ping ${A.ping}`);
  // st и ev
  const got = [];
  A.on('st', (m) => got.push(m.s));
  const evs = [];
  A.on('ev', (m) => evs.push(m.e.type));
  for (let i = 0; i < 40; i++) { B.send('st', { s: i, ts: i }); if (i % 4 === 0) B.send('ev', { e: { id: `e${i}`, type: 'player_cast' } }); await sleep(5); }
  await sleep(400);
  assert.ok(got.length >= 30 && got.length < 40 + 1, `st ${got.length}`);
  assert.equal(evs.length, 10, 'надёжные ev не теряются');
  // обрыв: провод выдернут на 4 с → оба 'lost' за ~3 с
  const t0 = Date.now();
  B.simulateDrop(4200);
  assert.ok(await until(() => A.state === 'lost' && B.state === 'lost', 4500), log.join(' '));
  const dt = Date.now() - t0;
  // 3 с считаются от последнего полученного пакета (он мог прийти до 0,5 с раньше обрыва)
  assert.ok(dt >= 2000 && dt <= 3500, `обнаружено за ${dt} мс`);
  // провод вернули — связь сама восстанавливается
  assert.ok(await until(() => A.state === 'connected' && B.state === 'connected', 5000), log.join(' '));
  // гость уходит — хост снова ждёт
  let left = false;
  A.on('left', () => { left = true; });
  B.close();
  assert.ok(await until(() => left, 2000));
  assert.equal(A.state, 'connecting');
  // новый гость в ту же комнату — у хоста событие 'open' (не 'reconnected')
  let opened = null;
  A.on('open', (r) => { opened = r && r.name; });
  const B2 = createNet({ transport: 'local', name: 'Вера' });
  await B2.join(code);
  assert.ok(await until(() => opened === 'Вера', 2000), `open: ${opened}`);
  B2.close();
  A.close();
});
await t('net local: третий игрок в полную комнату не попадает', async () => {
  const A = createNet({ transport: 'local', name: 'A' });
  const B = createNet({ transport: 'local', name: 'B' });
  const C = createNet({ transport: 'local', name: 'C' });
  const code = await A.host();
  await B.join(code);
  await assert.rejects(() => C.join(code, { timeoutMs: 1500 }), (e) => e.code === 'room_full');
  A.close(); B.close(); C.close();
});
await t('net local: sharedNow() у хоста и гостя совпадает (±15 мс)', async () => {
  const A = createNet({ transport: 'local', name: 'A', sim: { pingMs: 120, jitterMs: 5 } });
  const B = createNet({ transport: 'local', name: 'B', sim: { pingMs: 120, jitterMs: 5 } });
  const code = await A.host();
  await B.join(code);
  await sleep(1800);
  // в одном процессе часы общие: смещение должно оцениться около 0
  assert.ok(Math.abs(B.clockOffset) < 15, `offset ${B.clockOffset}`);
  assert.ok(Math.abs(A.sharedNow() - B.sharedNow()) < 15);
  A.close(); B.close();
});

await t('проверка сети «Интернет»: сервер комнат отвечает / нет; без WebRTC — совет раздать с телефона или LAN', async () => {
  const { createServer } = await import('node:http');
  const { checkPeerServer, diagnoseInternet } = await import('../net/diag.js');
  const srv = createServer((req, res) => { if (req.url.startsWith('/peerjs/id')) { res.writeHead(200); res.end('abc'); } else { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal(await checkPeerServer({ host: '127.0.0.1', port, secure: false, path: '/' }), true);
  assert.equal(await checkPeerServer({ host: '127.0.0.1', port, secure: false, path: '/nope/' }), false);
  const d = await diagnoseInternet({ peer: { host: '127.0.0.1', port, secure: false, path: '/' } });
  assert.equal(d.server, 'ok');
  assert.equal(d.good, false);                              // в Node нет RTCPeerConnection
  assert.match(d.verdict, /телефона|LAN/);
  srv.close();
});

console.log(`\nnet: ${pass} проверок пройдено${process.exitCode ? ', ЕСТЬ ОШИБКИ' : ''}`);
setTimeout(() => process.exit(process.exitCode || 0), 100);
