// ASHEN OATH — сеть для онлайн-дуэли (контракт C6). Владелец: №2 [NET].
//
// createNet({ transport: 'peer'|'lan'|'local', name, hero, lanHost, sim, peer, iceServers })
//   → { host():Promise<code>, join(code, opts):Promise, send(type, payload), on(type, fn), off(type, fn),
//       close(), state, ping, isHost, code, remote, clockOffset, sharedNow(), toLocalTime(t), setProfile() }
//
// Сообщения — JSON-объекты с полем t (C6): hello, st, ev, pr, hit, hitAck, duel, ping, pong, bye.
// Поверх транспорта net сам делает:
//   - hello {v:'ASHEN_NET_1', name, hero} при каждом (пере)подключении;
//   - ping/pong каждые 0,5 с: RTT (net.ping, мс) и смещение часов соперника (net.clockOffset);
//     sharedNow() — общее время по часам хоста (для duel.at у №3);
//   - heartbeat: 3 с без единого пакета → state 'lost' (событие 'lost'); гость сам переподключается
//     к тому же коду, хост ждёт; вернулись — state 'connected' и событие 'reconnected'.
// Служебные события (для лобби и №3) слушаются тем же on(): 'state' (state), 'open' (remote),
// 'lost', 'reconnected', 'left' (соперник вышел сам), 'error' ({code, message}), 'hello' (сообщение).
// Транспорты грузятся лениво: одиночная игра этот файл вообще не импортирует.

export const NET_VERSION = 'ASHEN_NET_1';
// без 0/O и 1/I: код диктуют голосом и переписывают с экрана
export const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const LOST_AFTER_MS = 3000;
const PING_EVERY_MS = 500;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function makeRoomCode(len = 4, rnd = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[Math.floor(rnd() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length];
  return s;
}
// ввод кода: приводим регистр и убираем пробелы/дефисы; 0, O, 1, I в алфавите нет — это ошибка ввода
export function normalizeRoomCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s\-_.]/g, '');
  return s;
}
export function isValidRoomCode(code) {
  if (typeof code !== 'string' || code.length < 4 || code.length > 5) return false;
  for (const ch of code) if (!ROOM_ALPHABET.includes(ch)) return false;
  return true;
}

// Понятные ошибки по-русски (лобби показывает message, №3 может смотреть code)
export const NET_ERRORS = {
  bad_code: 'Код комнаты — 4–5 символов: буквы A–Z и цифры 2–9 (без 0, O, 1, I).',
  room_not_found: 'Комната с таким кодом не найдена. Проверьте код и что хост ещё в лобби.',
  room_full: 'В комнате уже двое игроков.',
  room_taken: 'Код занят — создаём другой.',
  no_rtc: 'Сеть не пускает прямое соединение — раздайте интернет с телефона или включите LAN-режим.',
  peer_lib: 'Не загрузилась библиотека PeerJS (нужен интернет). Попробуйте LAN-режим.',
  peer_server: 'Нет связи с сервером комнат PeerJS. Проверьте интернет или включите LAN-режим.',
  lan_connect: 'Не удалось подключиться к ретранслятору. Проверьте IP хоста, что на его ноутбуке запущен START_ONLINE_HOST.cmd (tools/relay.py) и брандмауэр разрешает порт 8790.',
  lan_mixed: 'Страница открыта по https — браузер блокирует ws:// (mixed content). Для LAN откройте игру у себя через «python serve_game.py» (http://127.0.0.1:8765).',
  version: 'У соперника другая версия игры. Обновите страницу у обоих (Ctrl+F5).',
  timeout: 'Соединение не установилось вовремя.',
  closed: 'Соединение закрыто.',
  mode_unavailable: 'Этот режим связи не загрузился — обновите страницу или выберите другой.',
  no_bc: 'Этот браузер не поддерживает BroadcastChannel (режим двух вкладок).',
};
export function netError(code, extra) {
  const e = new Error((NET_ERRORS[code] || code) + (extra ? ` (${extra})` : ''));
  e.code = code;
  return e;
}

async function loadTransport(kind) {
  try {
    if (kind === 'local') return (await import('./transport-local.js')).createLocalTransport;
    if (kind === 'lan') return (await import('./transport-lan.js')).createLanTransport;
    if (kind === 'peer') return (await import('./transport-peer.js')).createPeerTransport;
  } catch (e) {
    throw netError('mode_unavailable', e && e.message);
  }
  throw netError('mode_unavailable', kind);
}

export function createNet(opts = {}) {
  const kind = opts.transport === 'peer' || opts.transport === 'lan' ? opts.transport : 'local';
  const listeners = new Map();   // type → Set<fn>
  const S = {
    state: 'idle', isHost: false, code: null, tr: null,
    profile: { name: String(opts.name || 'Игрок'), hero: String(opts.hero || 'ashen') },
    remote: null,                // { name, hero, v }
    lastRecv: 0, pingTimer: null, watchTimer: null, rejoinTimer: null,
    rtt: 0, rttSamples: [], offSamples: [], offset: 0, everOpen: false, closed: false,
    joinOpts: null, sent: 0, recv: 0, bytesOut: 0, bytesIn: 0,
  };

  function emit(type, arg) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(arg); } catch (e) { console.error('[NET] обработчик', type, e); }
    }
  }
  function setState(s) {
    if (S.state === s) return;
    S.state = s;
    emit('state', s);
  }

  // ------------------------------------------------------------ транспорт → net
  function wire(tr) {
    tr.onMessage = (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      S.lastRecv = nowMs();
      S.recv++;
      if (S.state === 'lost' && msg.t !== 'bye') { setState('connected'); emit('reconnected', S.remote); }
      switch (msg.t) {
        case 'ping': rawSend({ t: 'pong', a: msg.a, b: Math.round(nowMs() * 10) / 10 }); return;
        case 'pong': onPong(msg); return;
        case 'hello':
          if (msg.v !== NET_VERSION) { emit('error', netError('version', `${msg.v}`)); return; }
          S.remote = { name: String(msg.name || 'Соперник').slice(0, 20), hero: String(msg.hero || 'ashen'), v: msg.v };
          if (S.state !== 'connected') {
            setState('connected');
            emit(S.everOpen ? 'reconnected' : 'open', S.remote);
            S.everOpen = true;
          }
          emit('hello', msg);
          return;
        case 'bye':
          S.remote = null;
          S.everOpen = false;              // следующий гость — новое 'open', а не 'reconnected'
          setState(S.isHost ? 'connecting' : 'idle');
          emit('left', msg);
          if (!S.isHost) teardown();
          return;
        default: emit(msg.t, msg);
      }
    };
    tr.onPeerOpen = () => {
      S.lastRecv = nowMs();
      rawSend({ t: 'hello', v: NET_VERSION, name: S.profile.name, hero: S.profile.hero });
      sendPing();
    };
    tr.onPeerClose = () => { if (S.state === 'connected') markLost('transport'); };
    tr.onError = (err) => emit('error', err);
  }

  // имитация плохой сети для 'lan'/'peer' (у 'local' своя): только если заданы ?netPing/?netLoss или opts.sim.
  // Ненадёжные (st, pr, ping, pong) теряются с долей loss, всё — с задержкой ping/2 ± jitter, надёжные — по порядку.
  const SIM = kind === 'local' ? null : (() => {
    const q = (() => { try { return new URLSearchParams(location.search); } catch (e) { return null; } })();
    const o = { pingMs: 0, jitterMs: 0, loss: 0, ...(opts.sim || {}) };
    if (q && q.has('netPing')) o.pingMs = Math.max(0, +q.get('netPing') || 0);
    if (q && q.has('netJitter')) o.jitterMs = Math.max(0, +q.get('netJitter') || 0);
    if (q && q.has('netLoss')) o.loss = Math.min(0.9, Math.max(0, +q.get('netLoss') || 0));
    return o.pingMs > 0 || o.loss > 0 ? o : null;
  })();
  let simLastReliable = 0;
  function simSend(obj) {
    const unreliable = obj.t === 'st' || obj.t === 'pr' || obj.t === 'ping' || obj.t === 'pong';
    if (unreliable && SIM.loss > 0 && Math.random() < SIM.loss) return true;
    let at = nowMs() + Math.max(0, SIM.pingMs / 2 + (Math.random() * 2 - 1) * SIM.jitterMs);
    if (!unreliable) { at = Math.max(at, simLastReliable + 0.5); simLastReliable = at; }
    const tr = S.tr;
    setTimeout(() => { if (S.tr === tr && tr) { try { tr.send(obj); } catch (e) { /* ignore */ } } }, at - nowMs());
    return true;
  }

  function rawSend(obj) {
    if (!S.tr) return false;
    if (SIM) { S.sent++; return simSend(obj); }
    try {
      const n = S.tr.send(obj);
      S.sent++;
      if (typeof n === 'number') S.bytesOut += n;
      return true;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------------ ping, часы, heartbeat
  function sendPing() { rawSend({ t: 'ping', a: Math.round(nowMs() * 10) / 10 }); }
  function onPong(m) {
    const t = nowMs();
    if (typeof m.a !== 'number' || typeof m.b !== 'number') return;
    const rtt = Math.max(0, t - m.a);
    const off = m.b - (m.a + rtt / 2);      // часы соперника − мои
    S.rttSamples.push(rtt); if (S.rttSamples.length > 8) S.rttSamples.shift();
    S.offSamples.push({ rtt, off }); if (S.offSamples.length > 12) S.offSamples.shift();
    const sorted = [...S.rttSamples].sort((a, b) => a - b);
    S.rtt = sorted[Math.floor(sorted.length / 2)];
    // смещение — по трём замерам с наименьшим RTT (меньше всего искажены очередями)
    const best = [...S.offSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    S.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
    emit('rtt', S.rtt);
  }
  function markLost(why) {
    if (S.state !== 'connected') return;
    setState('lost');
    emit('lost', { reason: why });
    if (!S.isHost) scheduleRejoin();
  }
  function startTimers() {
    stopTimers();
    S.pingTimer = setInterval(() => { if (S.state === 'connected' || S.state === 'lost') sendPing(); }, PING_EVERY_MS);
    let lastWatch = nowMs();
    S.watchTimer = setInterval(() => {
      const t = nowMs(), gap = t - lastWatch;
      lastWatch = t;
      // своя вкладка «спала» (фриз на компиляции шейдеров, загрузка модели): пакеты соперника ещё
      // в очереди — это не обрыв, отсчёт 3 с начинаем заново
      if (gap > 1500) { S.lastRecv = Math.max(S.lastRecv, t - 1000); return; }
      if (S.state === 'connected' && t - S.lastRecv > LOST_AFTER_MS) markLost('timeout');
    }, 250);
  }
  function stopTimers() {
    clearInterval(S.pingTimer); clearInterval(S.watchTimer); clearTimeout(S.rejoinTimer);
    S.pingTimer = S.watchTimer = S.rejoinTimer = null;
  }

  // гость: тот же код, новые попытки каждые 2 с, пока не вернётся связь или не закроют
  function scheduleRejoin() {
    clearTimeout(S.rejoinTimer);
    S.rejoinTimer = setTimeout(async () => {
      if (S.closed || S.isHost || S.state !== 'lost') return;
      try {
        if (S.tr && typeof S.tr.rejoin === 'function') await S.tr.rejoin();
        else if (S.tr) { try { S.tr.close(); } catch (e) { /* ignore */ } await openTransport(); await S.tr.join(S.code, S.joinOpts || {}); }
      } catch (e) { /* попробуем ещё */ }
      if (S.state === 'lost') scheduleRejoin();
    }, 2000);
  }

  async function openTransport() {
    const make = await loadTransport(kind);
    const tr = make({ ...opts });
    wire(tr);
    S.tr = tr;
    return tr;
  }
  function teardown() {
    stopTimers();
    if (S.tr) { try { S.tr.close(); } catch (e) { /* ignore */ } }
    S.tr = null;
  }

  // ------------------------------------------------------------ публичное API
  async function host(opt = {}) {
    if (S.tr) teardown();
    S.closed = false; S.isHost = true; S.remote = null; S.everOpen = false;
    setState('connecting');
    try {
      await openTransport();
      let code = opt.code && isValidRoomCode(opt.code) ? opt.code : makeRoomCode(opt.len || 4);
      for (let i = 0; ; i++) {
        try { await S.tr.host(code); break; }
        catch (e) {
          if (e && e.code === 'room_taken' && i < 4) { code = makeRoomCode(opt.len || 4); continue; }
          throw e;
        }
      }
      S.code = code;
      S.lastRecv = nowMs();
      startTimers();
      emit('hosting', code);
      return code;
    } catch (e) {
      teardown(); setState('idle');
      throw e;
    }
  }

  async function join(rawCode, jopts = {}) {
    const code = normalizeRoomCode(rawCode);
    if (!isValidRoomCode(code)) throw netError('bad_code');
    if (S.tr) teardown();
    S.closed = false; S.isHost = false; S.remote = null; S.everOpen = false; S.code = code; S.joinOpts = jopts;
    setState('connecting');
    try {
      await openTransport();
      await S.tr.join(code, jopts);
      S.lastRecv = nowMs();
      startTimers();
      // hello отправлен из onPeerOpen; ждём ответный hello (state → connected)
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => { off('open', ok); reject(netError('timeout', 'hello')); }, jopts.helloTimeoutMs || 8000);
        function ok() { clearTimeout(to); off('open', ok); resolve(); }
        if (S.state === 'connected') { clearTimeout(to); resolve(); return; }
        on('open', ok);
      });
      return code;
    } catch (e) {
      teardown(); setState('idle');
      throw e;
    }
  }

  function send(type, payload) {
    if (S.state !== 'connected' && S.state !== 'lost') return false;
    const msg = payload && typeof payload === 'object' ? { ...payload, t: type } : { t: type };
    return rawSend(msg);
  }
  function on(type, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }
  function off(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); }

  function close() {
    if (S.closed) return;
    S.closed = true;
    if (S.state === 'connected' || S.state === 'lost') rawSend({ t: 'bye' });
    // bye уходит асинхронно (local-транспорт с задержкой) — рвём после короткой паузы
    const tr = S.tr;
    stopTimers();
    S.tr = null;
    setTimeout(() => { if (tr) { try { tr.close(); } catch (e) { /* ignore */ } } }, 60);
    S.remote = null;
    setState('idle');
  }

  function setProfile(p = {}) {
    if (typeof p.name === 'string' && p.name.trim()) S.profile.name = p.name.trim().slice(0, 20);
    if (typeof p.hero === 'string') S.profile.hero = p.hero;
    if (S.state === 'connected') rawSend({ t: 'hello', v: NET_VERSION, name: S.profile.name, hero: S.profile.hero });
  }

  // для отладки и тестов: обрыв «как у провода» (транспорт перестаёт доставлять)
  function simulateDrop(ms = 4000) { if (S.tr && typeof S.tr.drop === 'function') S.tr.drop(ms); }
  // «потерял Wi-Fi»: транспорт рвёт сокет/канал сам (net об этом не просил) — проверка переподключения
  function simulateSocketLoss() { if (S.tr && typeof S.tr.kill === 'function') S.tr.kill(); }

  return {
    host, join, send, on, off, close, setProfile, simulateDrop, simulateSocketLoss,
    get state() { return S.state; },
    get ping() { return Math.round(S.rtt); },
    get isHost() { return S.isHost; },
    get code() { return S.code; },
    get remote() { return S.remote; },
    get transport() { return kind; },
    get clockOffset() { return S.offset; },
    // часы: мои ms (performance.now) ↔ часы соперника; общее время — часы хоста
    now: nowMs,
    toLocalTime: (remoteMs) => remoteMs - S.offset,
    sharedNow: () => (S.isHost ? nowMs() : nowMs() + S.offset),
    sharedToLocal: (t) => (S.isHost ? t : t - S.offset),
    stats: () => ({ state: S.state, transport: kind, code: S.code, isHost: S.isHost, ping: Math.round(S.rtt), offset: Math.round(S.offset), sent: S.sent, recv: S.recv, sinceRecvMs: Math.round(nowMs() - S.lastRecv), remote: S.remote }),
  };
}
