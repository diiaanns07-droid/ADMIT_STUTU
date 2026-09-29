// ASHEN OATH — транспорт 'local' (№2 [NET]): BroadcastChannel, две вкладки/окна одного браузера.
// Для тестов и для №3 [PVP]. Имитация плохой сети: sim = { pingMs, jitterMs, loss }.
//   pingMs — желаемый RTT (в каждую сторону уходит половина), jitterMs — разброс ±,
//   loss — доля потерянных НЕнадёжных пакетов (st, pr, ping, pong). Надёжные (hello, ev, hit, duel…)
//   не теряются и приходят по порядку — как в настоящем канале PeerJS/WebSocket.
// Параметры можно задать и в адресе страницы: ?netPing=150&netJitter=20&netLoss=0.05
// drop(ms) — «выдернуть провод»: столько миллисекунд ничего не доставляется в обе стороны.

import { netError } from './net.js';

const UNRELIABLE = new Set(['st', 'pr', 'ping', 'pong']);

export function simFromUrl(search) {
  const out = {};
  try {
    const q = new URLSearchParams(search || (typeof location !== 'undefined' ? location.search : ''));
    if (q.has('netPing')) out.pingMs = Math.max(0, +q.get('netPing') || 0);
    if (q.has('netJitter')) out.jitterMs = Math.max(0, +q.get('netJitter') || 0);
    if (q.has('netLoss')) out.loss = Math.min(0.9, Math.max(0, +q.get('netLoss') || 0));
  } catch (e) { /* ignore */ }
  return out;
}

export function createLocalTransport(opts = {}) {
  if (typeof BroadcastChannel === 'undefined') throw netError('no_bc');
  const sim = { pingMs: 0, jitterMs: 0, loss: 0, ...simFromUrl(), ...(opts.sim || {}) };
  const me = Math.random().toString(36).slice(2, 10);
  let bc = null, role = null, code = null, other = null;
  let joinResolve = null, joinReject = null, joinTimer = null, joinPoll = null;
  let lastReliableAt = 0, dropUntil = 0, closed = false;
  const tr = { onMessage: null, onPeerOpen: null, onPeerClose: null, onError: null };

  function post(kind, extra) { if (bc && !closed) bc.postMessage({ kind, from: me, ...extra }); }

  function open(c) {
    code = c;
    bc = new BroadcastChannel(`ashen-net-${c}`);
    bc.onmessage = (ev) => onRaw(ev.data);
  }

  function deliver(data) {
    if (closed || Date.now() < dropUntil) return;
    if (tr.onMessage) tr.onMessage(data);
  }

  function onRaw(m) {
    if (!m || m.from === me || closed) return;
    if (m.to && m.to !== me) return;
    switch (m.kind) {
      case 'probe':   // кто-то хочет создать комнату с этим кодом
        if (role === 'host') post('taken', { to: m.from });
        break;
      case 'join':
        if (role !== 'host') break;
        if (other && other !== m.from) { post('full', { to: m.from }); break; }
        other = m.from;
        post('accept', { to: m.from });
        if (tr.onPeerOpen) tr.onPeerOpen();
        break;
      case 'accept':
        if (role !== 'guest') break;
        other = m.from;
        if (joinResolve) { const r = joinResolve; clearJoin(); r(); if (tr.onPeerOpen) tr.onPeerOpen(); }
        else if (tr.onPeerOpen) tr.onPeerOpen();   // переподключение
        break;
      case 'full':
        if (joinReject) { const r = joinReject; clearJoin(); r(netError('room_full')); }
        break;
      case 'leave':
        if (m.from === other) { other = null; if (tr.onPeerClose) tr.onPeerClose(); }
        break;
      case 'd':
        if (m.from !== other) break;
        if (Date.now() < dropUntil) break;
        if (m.at && m.at > Date.now()) setTimeout(() => deliver(m.data), m.at - Date.now());
        else deliver(m.data);
        break;
      default: break;
    }
  }
  function clearJoin() {
    clearTimeout(joinTimer); clearInterval(joinPoll);
    joinResolve = joinReject = null; joinTimer = joinPoll = null;
  }

  tr.host = (c) => new Promise((resolve, reject) => {
    open(c);
    role = 'probe';
    let taken = false;
    const onTaken = (ev) => { if (ev.data && ev.data.kind === 'taken' && ev.data.to === me) taken = true; };
    bc.addEventListener('message', onTaken);
    post('probe');
    setTimeout(() => {
      bc.removeEventListener('message', onTaken);
      if (taken) { bc.close(); bc = null; reject(netError('room_taken')); return; }
      role = 'host';
      resolve();
    }, 160);
  });

  tr.join = (c, jo = {}) => new Promise((resolve, reject) => {
    if (!bc || code !== c) { if (bc) bc.close(); open(c); }
    role = 'guest';
    joinResolve = resolve; joinReject = reject;
    post('join');
    joinPoll = setInterval(() => post('join'), 300);
    joinTimer = setTimeout(() => { const r = joinReject; clearJoin(); if (r) r(netError('room_not_found')); }, jo.timeoutMs || 4000);
  });

  tr.rejoin = () => { if (role === 'guest') post('join'); return Promise.resolve(); };

  tr.send = (obj) => {
    if (!bc || !other || closed) return 0;
    if (Date.now() < dropUntil) return 0;
    const unreliable = UNRELIABLE.has(obj.t);
    if (unreliable && sim.loss > 0 && Math.random() < sim.loss) return 0;
    let at = 0;
    const oneWay = sim.pingMs / 2;
    if (oneWay > 0 || sim.jitterMs > 0) {
      at = Date.now() + Math.max(0, oneWay + (Math.random() * 2 - 1) * sim.jitterMs);
      if (!unreliable) { at = Math.max(at, lastReliableAt + 1); lastReliableAt = at; }
    }
    post('d', { to: other, at, data: obj });
    return 0;
  };

  tr.drop = (ms) => { dropUntil = Date.now() + Math.max(0, ms); };
  tr.kill = () => { post('leave'); other = null; if (tr.onPeerClose) tr.onPeerClose(); };
  tr.setSim = (s) => Object.assign(sim, s || {});
  tr.close = () => {
    if (closed) return;
    post('leave');
    closed = true;
    clearJoin();
    if (bc) bc.close();
    bc = null; other = null;
  };
  tr.kind = 'local';
  return tr;
}
