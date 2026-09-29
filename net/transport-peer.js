// ASHEN OATH — транспорт 'peer' (№2 [NET]): PeerJS (WebRTC DataChannel) через интернет по коду комнаты.
// Библиотека (закреплённая версия DEPS.peerjs) грузится <script> только при выборе «Интернет».
// Сигнальный сервер — бесплатное облако PeerJS (0.peerjs.com) или свой (config.net.peer / ?peerHost=…).
// ID хоста — 'ashen-oath-v1-<КОД>'. STUN — Google; TURN (если найдётся бесплатный) — в config.net.iceServers.
// Ошибки — понятные по-русски: код не найден, сервер недоступен, сеть не пускает прямое соединение.

import { netError } from './net.js';
import { DEPS, config } from '../config.js';

export const PEER_ID_PREFIX = 'ashen-oath-v1-';
let libP = null;

function loadPeerJs() {
  const w = typeof window !== 'undefined' ? window : globalThis;
  if (w.peerjs && w.peerjs.Peer) return Promise.resolve(w.peerjs.Peer);
  if (!libP) {
    libP = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = DEPS.peerjs.scriptUrl;
      s.async = true;
      s.crossOrigin = 'anonymous';
      const to = setTimeout(() => { libP = null; reject(netError('peer_lib', 'timeout')); }, 15000);
      s.onload = () => { clearTimeout(to); if (w.peerjs && w.peerjs.Peer) resolve(w.peerjs.Peer); else { libP = null; reject(netError('peer_lib')); } };
      s.onerror = () => { clearTimeout(to); libP = null; s.remove(); reject(netError('peer_lib')); };
      document.head.appendChild(s);
    });
  }
  return libP;
}

function peerOptions(opts) {
  const netCfg = (config && config.net) || {};
  const o = { debug: 1, config: { iceServers: opts.iceServers || netCfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] } };
  const custom = opts.peer || netCfg.peer;
  if (custom && typeof custom === 'object') Object.assign(o, custom);
  // для проверки со своим PeerServer: ?peerHost=127.0.0.1&peerPort=9000&peerPath=/&peerSecure=0
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('peerHost')) {
      o.host = q.get('peerHost');
      o.port = +(q.get('peerPort') || 443);
      o.path = q.get('peerPath') || '/';
      o.secure = q.get('peerSecure') !== '0';
      if (q.get('peerKey')) o.key = q.get('peerKey');
    }
  } catch (e) { /* ignore */ }
  return o;
}

function serverErr(err) {
  const type = err && err.type;
  if (type === 'peer-unavailable') return netError('room_not_found');
  if (type === 'unavailable-id') return netError('room_taken');
  if (type === 'browser-incompatible' || type === 'webrtc') return netError('no_rtc', type);
  return netError('peer_server', type || (err && err.message));
}

export function createPeerTransport(opts = {}) {
  const tr = { onMessage: null, onPeerOpen: null, onPeerClose: null, onError: null, kind: 'peer' };
  const timeoutMs = opts.connectTimeoutMs || (config.net && config.net.connectTimeoutMs) || 15000;
  let peer = null, conn = null, role = null, code = null, closed = false, dropUntil = 0, lastRx = 0;

  function attach(c) {
    conn = c;
    lastRx = Date.now();
    const onData = (d) => {
      if (c !== conn) return;
      lastRx = Date.now();
      if (Date.now() < dropUntil) return;
      let m = d;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { return; } }
      if (m && m.t === '_peer') return;           // служебное (full) — обрабатывается при входе
      if (tr.onMessage) tr.onMessage(m);
    };
    c.on('data', onData);
    const early = c.__early;
    if (c.__stopEarly) c.__stopEarly();
    c.__early = null; c.__stopEarly = null;
    c.on('close', () => { if (c === conn) { conn = null; if (tr.onPeerClose) tr.onPeerClose(); } });
    c.on('error', (e) => { if (tr.onError) tr.onError(netError('closed', e && e.type)); });
    watchIce(c);
    return early ? () => { for (const d of early) onData(d); } : () => {};
  }
  // ICE провалился (NAT/брандмауэр не пускает) — не ждём таймаута
  function watchIce(c, onFail) {
    const pc = c.peerConnection;
    if (!pc) return;
    const prev = pc.oniceconnectionstatechange;
    pc.oniceconnectionstatechange = (ev) => {
      if (typeof prev === 'function') prev.call(pc, ev);
      if (pc.iceConnectionState === 'failed') {
        if (onFail) onFail();
        else if (c === conn && tr.onError) tr.onError(netError('no_rtc'));
      }
    };
  }

  function makePeer(id) {
    return loadPeerJs().then((Peer) => new Promise((resolve, reject) => {
      const p = id ? new Peer(id, peerOptions(opts)) : new Peer(peerOptions(opts));
      const to = setTimeout(() => { cleanup(); try { p.destroy(); } catch (e) { /* ignore */ } reject(netError('peer_server', 'timeout')); }, 12000);
      const onOpen = () => { cleanup(); resolve(p); };
      const onErr = (e) => { cleanup(); try { p.destroy(); } catch (x) { /* ignore */ } reject(serverErr(e)); };
      function cleanup() { clearTimeout(to); p.off('open', onOpen); p.off('error', onErr); }
      p.on('open', onOpen);
      p.on('error', onErr);
    }));
  }

  function keepSignaling(p) {
    // обрыв связи с сигнальным сервером не рвёт DataChannel, но новые входы не пройдут — переподключаемся
    p.on('disconnected', () => { if (!closed && p === peer && !p.destroyed) { try { p.reconnect(); } catch (e) { /* ignore */ } } });
    p.on('error', (e) => {
      if (closed || p !== peer) return;
      if (e && e.type === 'peer-unavailable') return;   // обрабатывается в connect()
      if (tr.onError) tr.onError(serverErr(e));
    });
  }

  tr.host = async (c) => {
    code = c; role = 'host';
    peer = await makePeer(PEER_ID_PREFIX + c);
    keepSignaling(peer);
    peer.on('connection', (nc) => {
      const busy = conn && conn.open && Date.now() - lastRx < 3000;
      nc.on('open', () => {
        if (busy && nc !== conn) { try { nc.send({ t: '_peer', ev: 'full' }); } catch (e) { /* ignore */ } setTimeout(() => nc.close(), 300); return; }
        if (conn && conn !== nc) { const old = conn; conn = null; try { old.close(); } catch (e) { /* ignore */ } }
        attach(nc);
        if (tr.onPeerOpen) tr.onPeerOpen();
      });
    });
  };

  function connect(timeout) {
    return new Promise((resolve, reject) => {
      let done = false;
      const c = peer.connect(PEER_ID_PREFIX + code, { reliable: true, serialization: 'json' });
      const finish = (err) => {
        if (done) return;
        done = true; clearTimeout(to); peer.off('error', onErr);
        if (err) { try { c.close(); } catch (e) { /* ignore */ } reject(err); } else resolve(c);
      };
      const to = setTimeout(() => finish(netError('no_rtc', 'timeout')), timeout);
      const onErr = (e) => { if (e && e.type === 'peer-unavailable') finish(netError('room_not_found')); };
      peer.on('error', onErr);
      if (!c) { finish(netError('peer_server')); return; }
      watchIce(c, () => finish(netError('no_rtc')));
      c.on('open', () => {
        // хост может ответить «комната полна» сразу после открытия; всё, что пришло за эти 350 мс
        // (hello хоста!), копится и отдаётся после attach()
        c.__early = [];
        const early = (d) => {
          if (d && d.t === '_peer' && d.ev === 'full') { finish(netError('room_full')); return; }
          if (c.__early) c.__early.push(d);
        };
        c.on('data', early);
        c.__stopEarly = () => c.off('data', early);
        setTimeout(() => finish(), 350);
      });
      c.on('error', () => finish(netError('no_rtc')));
    });
  }

  tr.join = async (c, jo = {}) => {
    code = c; role = 'guest';
    if (!peer || peer.destroyed) { peer = await makePeer(null); keepSignaling(peer); }
    const nc = await connect(jo.timeoutMs || timeoutMs);
    const replay = attach(nc);
    if (tr.onPeerOpen) tr.onPeerOpen();
    replay();
  };

  let rejoining = false;
  tr.rejoin = async () => {
    if (closed || role !== 'guest' || rejoining) return;
    if (conn && conn.open && Date.now() - lastRx < 3000) return;
    rejoining = true;
    try {
      if (!peer || peer.destroyed) { peer = await makePeer(null); keepSignaling(peer); }
      else if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* ignore */ } await new Promise((r) => setTimeout(r, 800)); }
      const nc = await connect(10000);
      if (conn && conn !== nc) { const old = conn; conn = null; try { old.close(); } catch (e) { /* ignore */ } }
      const replay = attach(nc);
      if (tr.onPeerOpen) tr.onPeerOpen();
      replay();
    } finally { rejoining = false; }
  };

  tr.send = (obj) => {
    if (!conn || !conn.open || Date.now() < dropUntil) return 0;
    conn.send(obj);
    return 0;
  };
  tr.drop = (ms) => { dropUntil = Date.now() + Math.max(0, ms); };
  tr.kill = () => { if (conn) { try { conn.close(); } catch (e) { /* ignore */ } } };
  tr.close = () => {
    closed = true;
    if (conn) { try { conn.close(); } catch (e) { /* ignore */ } }
    conn = null;
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    peer = null;
  };
  return tr;
}
