// node dev/net-lan.test.mjs — режим LAN (№2 [NET]): tools/relay.py (WebSocket RFC 6455 на stdlib)
// + net/transport-lan.js (глобальный WebSocket есть в Node ≥ 22). Без Python тест пропускается.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createNet } from '../net/net.js';
import { parseLanHost } from '../net/transport-lan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = ['python3', 'python'].find((p) => { try { return spawnSync(p, ['-c', 'print(1)']).status === 0; } catch (e) { return false; } });
if (!PY || typeof WebSocket === 'undefined') { console.log('net-lan: пропущен (нет Python 3 или WebSocket в Node)'); process.exit(0); }

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

const PORT = 18790 + Math.floor(Math.random() * 400);
const relay = spawn(PY, [join(ROOT, 'tools', 'relay.py'), '--port', String(PORT), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
let relayOut = '';
relay.stdout.on('data', (d) => { relayOut += d; });
relay.stderr.on('data', (d) => { relayOut += d; });
const up = await until(() => relayOut.includes('ASHEN relay is running'), 6000);
const lanHost = `127.0.0.1:${PORT}`;

await t('ретранслятор запустился и печатает IP', () => {
  assert.ok(up, relayOut);
  assert.match(relayOut, /\d+\.\d+\.\d+\.\d+/);
});
await t('HTTP GET / → «ASHEN relay OK» (проверка брандмауэра)', async () => {
  const r = await fetch(`http://${lanHost}/`);
  assert.equal((await r.text()).trim(), 'ASHEN relay OK');
});
await t('parseLanHost', () => {
  assert.deepEqual(parseLanHost(''), { host: '127.0.0.1', port: 8790 });
  assert.deepEqual(parseLanHost(' 192.168.1.23 '), { host: '192.168.1.23', port: 8790 });
  assert.deepEqual(parseLanHost('ws://10.0.0.5:9000/x'), { host: '10.0.0.5', port: 9000 });
});
await t('lan: комната, hello, st/ev, полная комната, неверный код', async () => {
  const A = createNet({ transport: 'lan', lanHost, name: 'Хост', hero: 'elf' });
  const B = createNet({ transport: 'lan', lanHost, name: 'Гость', hero: 'dark' });
  const C = createNet({ transport: 'lan', lanHost, name: 'Третий' });
  await assert.rejects(() => B.join('ZZZZ'), (e) => e.code === 'room_not_found');
  const code = await A.host();
  await B.join(code);
  assert.ok(await until(() => A.state === 'connected' && B.state === 'connected'));
  assert.equal(A.remote.name, 'Гость'); assert.equal(B.remote.hero, 'elf');
  await assert.rejects(() => C.join(code), (e) => e.code === 'room_full');
  const got = [];
  A.on('st', (m) => got.push(m.s));
  const big = 'x'.repeat(70000);   // длинный кадр (64-битная длина) и фрагменты не ломают ретранслятор
  let bigOk = false;
  A.on('ev', (m) => { if (m.e && m.e.pad === big) bigOk = true; });
  for (let i = 0; i < 30; i++) B.send('st', { s: i, ts: i });
  B.send('ev', { e: { id: 'x', type: 'player_cast', pad: big } });
  assert.ok(await until(() => got.length === 30 && bigOk, 3000), `st ${got.length} big ${bigOk}`);
  assert.deepEqual(got, [...Array(30).keys()], 'порядок сохраняется');
  assert.ok(await until(() => A.ping > 0, 2000));
  A.close(); B.close(); C.close();
});
await t('lan: обрыв 3 с → lost → связь вернулась; уход гостя; хост сохраняет комнату', async () => {
  const A = createNet({ transport: 'lan', lanHost, name: 'A' });
  const B = createNet({ transport: 'lan', lanHost, name: 'B' });
  const code = await A.host();
  await B.join(code);
  assert.ok(await until(() => A.state === 'connected'));
  const t0 = Date.now();
  B.simulateDrop(4000);
  assert.ok(await until(() => A.state === 'lost' && B.state === 'lost', 4500));
  assert.ok(Date.now() - t0 >= 2000 && Date.now() - t0 <= 3600, `${Date.now() - t0} мс`);
  assert.ok(await until(() => A.state === 'connected' && B.state === 'connected', 5000));
  // гость ушёл по-настоящему → хост ждёт, новый гость входит по тому же коду
  B.close();
  assert.ok(await until(() => A.state === 'connecting', 2000), A.state);
  await sleep(300);
  const B2 = createNet({ transport: 'lan', lanHost, name: 'B2' });
  await B2.join(code);
  assert.ok(await until(() => A.state === 'connected' && A.remote && A.remote.name === 'B2', 3000));
  A.close(); B2.close();
});
await t('lan: гость переподключается сам, если сокет оборвался', async () => {
  const A = createNet({ transport: 'lan', lanHost, name: 'A' });
  const B = createNet({ transport: 'lan', lanHost, name: 'B' });
  const code = await A.host();
  await B.join(code);
  assert.ok(await until(() => A.state === 'connected' && B.state === 'connected'));
  // «ноутбук гостя потерял Wi-Fi»: ретранслятор видит закрытие сокета гостя
  const lostSeen = [];
  B.on('lost', () => lostSeen.push('B'));
  A.on('lost', () => lostSeen.push('A'));
  B.simulateSocketLoss();
  assert.ok(await until(() => lostSeen.length > 0, 4500));
  assert.ok(await until(() => A.state === 'connected' && B.state === 'connected', 8000), `${A.state} ${B.state}`);
  A.close(); B.close();
});

relay.kill();
console.log(`\nnet-lan: ${pass} проверок пройдено${process.exitCode ? ', ЕСТЬ ОШИБКИ' : ''}`);
setTimeout(() => process.exit(process.exitCode || 0), 100);
