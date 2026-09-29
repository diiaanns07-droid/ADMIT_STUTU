// ASHEN OATH — транспорт 'lan' (№2 [NET]): WebSocket к ретранслятору tools/relay.py в локальной сети.
// opts.lanHost — «IP» или «IP:порт» ноутбука, где запущен ретранслятор (пусто — 127.0.0.1), порт 8790.
// Важно: со страницы https (GitHub Pages) браузер блокирует ws:// (mixed content) — в LAN оба игрока
// открывают игру у себя через «python serve_game.py» (http://127.0.0.1:8765).
// Ретранслятор присылает служебные {t:'_relay', ev}: hosted, peer_open, peer_close, no_room, full, room_taken.
// Обрыв сокета: хост сам переоткрывает его с тем же кодом и ключом (комната сохраняется),
// гость — через rejoin() из net.js (каждые 2 с).

import { netError } from './net.js';

const DEFAULT_PORT = 8790;

export function parseLanHost(raw, port = DEFAULT_PORT) {
  let s = String(raw || '').trim().replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!s) s = '127.0.0.1';
  const m = s.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  const host = m ? m[1] : s;
  const p = m && m[2] ? +m[2] : port;
  return { host, port: p };
}

export function createLanTransport(opts = {}) {
  const tr = { onMessage: null, onPeerOpen: null, onPeerClose: null, onError: null, kind: 'lan' };
  const key = Math.random().toString(36).slice(2, 12);
  const { host: lanIp, port } = parseLanHost(opts.lanHost, (opts.net && opts.net.relayPort) || DEFAULT_PORT);
  let ws = null, role = null, code = null, closed = false, peer = false, dropUntil = 0;
  let pend = null;          // { resolve, reject, want: 'hosted'|'peer_open', timer }
  let hostRetry = null;

  function url() { return `ws://${lanIp.includes(':') ? `[${lanIp}]` : lanIp}:${port}/ws?room=${encodeURIComponent(code)}&role=${role}&key=${key}`; }

  function settle(err) {
    if (!pend) return;
    const p = pend; pend = null;
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve();
  }

  function open(want, timeoutMs) {
    if (typeof location !== 'undefined' && location.protocol === 'https:') return Promise.reject(netError('lan_mixed'));
    return new Promise((resolve, reject) => {
      pend = { resolve, reject, want, timer: setTimeout(() => settle(netError(want === 'peer_open' ? 'room_not_found' : 'lan_connect', `${lanIp}:${port}`)), timeoutMs) };
      let sock;
      try { sock = new WebSocket(url()); } catch (e) { settle(netError('lan_connect', e && e.message)); return; }
      ws = sock;
      let opened = false;
      sock.onopen = () => { opened = true; };
      sock.onmessage = (ev) => {
        if (sock !== ws) return;
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m && m.t === '_relay') { onControl(m.ev); return; }
        if (Date.now() < dropUntil) return;
        if (tr.onMessage) tr.onMessage(m);
      };
      sock.onerror = () => { if (!opened) settle(netError('lan_connect', `${lanIp}:${port}`)); };
      sock.onclose = () => {
        if (sock !== ws) return;
        ws = null;
        if (!opened) { settle(netError('lan_connect', `${lanIp}:${port}`)); return; }
        settle(netError('closed'));
        if (peer) { peer = false; if (tr.onPeerClose) tr.onPeerClose(); }
        if (!closed && role === 'host') scheduleHostRetry();
      };
    });
  }

  function onControl(ev) {
    switch (ev) {
      case 'hosted': if (pend && pend.want === 'hosted') settle(); break;
      case 'peer_open':
        peer = true;
        if (pend && pend.want === 'peer_open') settle();
        if (tr.onPeerOpen) tr.onPeerOpen();
        break;
      case 'peer_close':
        if (peer) { peer = false; if (tr.onPeerClose) tr.onPeerClose(); }
        break;
      case 'no_room': settle(netError('room_not_found')); break;
      case 'full': settle(netError('room_full')); break;
      case 'room_taken': settle(netError('room_taken')); break;
      default: break;
    }
  }

  function scheduleHostRetry() {
    clearTimeout(hostRetry);
    hostRetry = setTimeout(() => {
      if (closed || ws) return;
      open('hosted', 4000).catch(() => { if (!closed && !ws) scheduleHostRetry(); });
    }, 2000);
  }

  tr.host = (c) => { code = c; role = 'host'; return open('hosted', opts.timeoutMs || 5000); };
  tr.join = (c, jo = {}) => { code = c; role = 'guest'; return open('peer_open', jo.timeoutMs || 6000); };
  tr.rejoin = () => {
    if (closed || role !== 'guest') return Promise.resolve();
    if (ws && ws.readyState <= 1) return Promise.resolve();   // сокет жив — связь вернётся сама
    return open('peer_open', 4000).catch(() => {});
  };
  tr.send = (obj) => {
    if (!ws || ws.readyState !== 1 || Date.now() < dropUntil) return 0;
    const s = JSON.stringify(obj);
    ws.send(s);
    return s.length;
  };
  tr.drop = (ms) => { dropUntil = Date.now() + Math.max(0, ms); };
  tr.kill = () => { if (ws) { try { ws.close(); } catch (e) { /* ignore */ } } };
  tr.close = () => {
    closed = true;
    clearTimeout(hostRetry);
    settle(netError('closed'));
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    ws = null;
  };
  return tr;
}
