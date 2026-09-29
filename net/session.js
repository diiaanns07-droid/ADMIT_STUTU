// ASHEN OATH — онлайн-сессия (№2 [NET]): сеть + удалённый герой + лобби + кадр игры.
// main.js создаёт её лениво по кнопке «Онлайн-дуэль» (или ?netAuto=… для тестов) и зовёт frame() раз в кадр.
//
// createNetSession({ THREE, scene, world, camera, heroFactory, heroes, settings, uiRoot, hooks })
//   hooks: { saveSettings(patch), onReady(info), onLeave(), setDebug(on), isDebug() }
//   → { openLobby(), closeLobby(), frame(dt, now, snap, input, events) → { events, snapshot },
//       host(mode, lanHost), join(mode, code, lanHost), setReady(on), leave(),
//       net, remote, get active, getOpponent(), debug() }
//
// Протокол поверх C6 (добавлены только новые типы): lobby {ready, name, hero} — готовность в лобби;
// go {at} — хост назначает старт по общим часам (sharedNow), оба стартуют одновременно.

import { createNet, isValidRoomCode, normalizeRoomCode, NET_ERRORS } from './net.js';
import { encodeState, decodeState, encodeEvent, decodeEvent, encodeProjectiles, decodeProjectiles } from './sync.js';
import { createRemotePlayer } from '../modules/remotePlayer.js';

const ST_EVERY_MS = 50;    // 20 Гц
const LAST_KEY = 'ashen-oath.net.last';
const LAST_TTL_MS = 15 * 60 * 1000;   // хост перезагрузил страницу — та же комната ещё 15 минут
function readLast() {
  try { const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); return v && Date.now() - v.at < LAST_TTL_MS && isValidRoomCode(v.code) ? v : null; } catch (e) { return null; }
}
function saveLast(code, role, mode) { try { localStorage.setItem(LAST_KEY, JSON.stringify({ code, role, mode, at: Date.now() })); } catch (e) { /* ignore */ } }
const PR_EVERY_MS = 100;   // 10 Гц
const START_DELAY_MS = 3200;

function urlOpts() {
  const o = {};
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('net')) o.transport = q.get('net');
    if (q.get('netAuto')) o.auto = q.get('netAuto');           // host | join
    if (q.get('room')) o.room = normalizeRoomCode(q.get('room'));
    if (q.get('netName')) o.name = q.get('netName');
    if (q.get('netHero')) o.hero = q.get('netHero');
    if (q.get('lanHost')) o.lanHost = q.get('lanHost');
    if (q.has('netReady')) o.ready = true;
  } catch (e) { /* ignore */ }
  return o;
}

export function createNetSession({ THREE, scene, world, camera, heroFactory, heroes, settings, uiRoot, hooks = {} }) {
  const U = urlOpts();
  const S = {
    net: null, mode: U.transport === 'lan' ? 'lan' : U.transport === 'local' ? 'local' : 'peer',
    status: 'idle', message: '', error: null, errorCode: null,
    meReady: false, oppReady: false, startAt: 0, started: false, startTimer: null,
    seq: 0, lastSt: -1e9, lastPr: -1e9, prSentEmpty: true,
    inEvents: [], remoteProj: [], remoteProjAt: 0,
    lanHost: U.lanHost || (settings && settings.netLanHost) || '',
    lobbyOpen: false, busy: false, oppGone: false,
  };
  const remote = createRemotePlayer({ THREE, scene, world, heroFactory, camera });
  // значок связи в бою: соперник и пинг; при обрыве — «переподключение»
  let badge = null, badgeKey = '', badgeAt = 0;
  function updateBadge(now, inFight) {
    if (now - badgeAt < 200) return;
    badgeAt = now;
    const net = S.net;
    const show = inFight && !S.lobbyOpen && net && (net.state === 'connected' || net.state === 'lost');
    if (!badge) {
      if (!show) return;
      badge = document.createElement('div');
      badge.className = 'nl-badge';
      badge.setAttribute('role', 'status');
      badge.innerHTML = '<span class="nl-badge__dot"></span><span class="nl-badge__txt"></span>';
      document.body.appendChild(badge);
      import('../modules/netLobby.js').then((m) => m.ensureLobbyCss && m.ensureLobbyCss()).catch(() => {});
    }
    const opp = net && net.remote ? net.remote.name : 'Соперник';
    const lost = net && net.state === 'lost';
    const key = show ? `${lost ? 'L' : 'C'}|${opp}|${lost ? '' : Math.round(net.ping / 5) * 5}` : 'hidden';
    if (key === badgeKey) return;
    badgeKey = key;
    badge.hidden = !show;
    if (!show) return;
    badge.classList.toggle('is-lost', !!lost);
    badge.classList.toggle('is-slow', !lost && net.ping > 180);
    badge.querySelector('.nl-badge__txt').textContent = lost ? `${opp} · связь потеряна — переподключение…` : `${opp} · пинг ${Math.round(net.ping)} мс`;
  }
  remote.setVisible(true);
  let lobby = null;
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(view()); } catch (e) { console.warn('[NET] lobby', e); } } };

  const profile = () => ({
    name: (settings && settings.netName) || U.name || 'Игрок',
    hero: U.hero || (settings && settings.hero) || 'ashen',
  });

  // ------------------------------------------------------------ сеть
  function bind(net0) {
    // события старой сети (после «Выйти из комнаты» или смены режима) больше ничего не меняют
    const net = { on: (t, fn) => net0.on(t, (x) => { if (S.net === net0) fn(x); }), get isHost() { return net0.isHost; }, sharedToLocal: (t) => net0.sharedToLocal(t) };
    net.on('state', (s) => {
      S.status = s;
      remote.setConnected(s !== 'lost');
      if (s === 'idle') { S.oppReady = false; }
      changed();
    });
    net.on('open', (r) => { S.oppGone = false; remote.setInfo(r); S.message = `Соперник: ${r.name}`; sendLobby(); changed(); });
    net.on('hello', (m) => { remote.setInfo({ name: m.name, hero: m.hero }); changed(); });
    net.on('reconnected', () => { S.message = 'Связь восстановлена'; remote.setConnected(true); sendLobby(); changed(); });
    net.on('lost', () => { S.message = net.isHost ? 'Связь с соперником потеряна — ждём его…' : 'Связь потеряна — переподключаемся к той же комнате…'; changed(); });
    net.on('left', () => { S.message = 'Соперник вышел из комнаты'; S.oppReady = false; S.oppGone = true; changed(); });
    net.on('error', (e) => { S.error = e && e.message; S.errorCode = e && e.code; changed(); });
    net.on('rtt', () => { if (lobby && S.lobbyOpen) changed(); });
    net.on('st', (m) => { const st = decodeState(m); if (st) { S.oppGone = false; remote.push(st); } });
    net.on('ev', (m) => { const e = decodeEvent(m); if (e) S.inEvents.push(e); if (S.inEvents.length > 128) S.inEvents.splice(0, 64); });
    net.on('pr', (m) => { S.remoteProj = decodeProjectiles(m); S.remoteProjAt = performance.now(); });
    net.on('lobby', (m) => {
      S.oppReady = !!m.ready;
      if (m.name || m.hero) remote.setInfo({ name: m.name, hero: m.hero });
      if (net.isHost) maybeGo();
      changed();
    });
    net.on('go', (m) => { if (!net.isHost && Number.isFinite(m.at)) scheduleStart(net.sharedToLocal(m.at)); });
  }

  function newNet(mode) {
    if (S.net) { try { S.net.close(); } catch (e) { /* ignore */ } }
    const p = profile();
    S.mode = mode;
    S.net = createNet({ transport: mode, name: p.name, hero: p.hero, lanHost: S.lanHost });
    bind(S.net);
    return S.net;
  }

  async function host(mode = S.mode, lanHost) {
    if (S.busy) return null;
    if (lanHost !== undefined) setLanHost(lanHost);
    S.busy = true; S.error = null; S.errorCode = null; S.meReady = false; S.oppReady = false; S.started = false;
    S.message = mode === 'peer' ? 'Создаём комнату на сервере PeerJS…' : mode === 'lan' ? `Подключаемся к ретранслятору ${S.lanHost || '127.0.0.1'}:8790…` : 'Создаём комнату (две вкладки)…';
    changed();
    const net = newNet(mode);
    try {
      // тот же код, что и до перезагрузки страницы (гость переподключится сам); занят — будет новый
      const last = readLast();
      const want = U.auto === 'host' && isValidRoomCode(U.room || '') ? U.room : last && last.role === 'host' && last.mode === mode ? last.code : undefined;
      const code = await net.host({ code: want });
      saveLast(code, 'host', mode);
      S.message = 'Комната создана. Продиктуйте код сопернику.';
      return code;
    } catch (e) {
      S.error = (e && e.message) || String(e); S.errorCode = e && e.code;
      S.message = '';
      return null;
    } finally { S.busy = false; changed(); }
  }

  async function join(mode = S.mode, rawCode, lanHost) {
    if (S.busy) return false;
    if (lanHost !== undefined) setLanHost(lanHost);
    const code = normalizeRoomCode(rawCode);
    S.error = null; S.errorCode = null; S.meReady = false; S.oppReady = false; S.started = false;
    if (!isValidRoomCode(code)) { S.error = NET_ERRORS.bad_code; S.errorCode = 'bad_code'; changed(); return false; }
    S.busy = true;
    S.message = `Входим в комнату ${code}…`;
    changed();
    const net = newNet(mode);
    try {
      await net.join(code);
      saveLast(code, 'guest', mode);
      S.message = 'Вы в комнате.';
      return true;
    } catch (e) {
      S.error = (e && e.message) || String(e); S.errorCode = e && e.code;
      S.message = '';
      return false;
    } finally { S.busy = false; changed(); }
  }

  function setLanHost(v) {
    S.lanHost = String(v || '').trim().replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
    if (hooks.saveSettings) hooks.saveSettings({ netLanHost: S.lanHost });
  }

  function sendLobby() {
    if (!S.net) return;
    const p = profile();
    S.net.send('lobby', { ready: S.meReady, name: p.name, hero: p.hero });
  }
  function setReady(on) {
    S.meReady = !!on;
    sendLobby();
    if (S.net && S.net.isHost) maybeGo();
    if (!S.meReady && S.startTimer) { clearTimeout(S.startTimer); S.startTimer = null; S.startAt = 0; }
    changed();
  }
  function maybeGo() {
    const net = S.net;
    if (!net || !net.isHost || S.startTimer || S.started) return;
    if (!(S.meReady && S.oppReady && net.state === 'connected')) return;
    const at = net.sharedNow() + START_DELAY_MS;
    net.send('go', { at });
    scheduleStart(net.sharedToLocal(at));
  }
  function scheduleStart(localAt) {
    if (S.startTimer) clearTimeout(S.startTimer);
    S.startAt = localAt;
    const tick = () => {
      const left = S.startAt - performance.now();
      if (left <= 0) { S.startTimer = null; start(); return; }
      changed();
      S.startTimer = setTimeout(tick, Math.min(250, left));
    };
    tick();
  }
  function start() {
    S.started = true;
    S.startAt = 0;
    closeLobby();
    const net = S.net;
    const info = { net, remote, isHost: net ? net.isHost : false, code: net ? net.code : null, opponent: net ? net.remote : null, mode: S.mode, seed: net && net.code ? hashCode(net.code) : 0 };
    try { if (hooks.onReady) hooks.onReady(info); } catch (e) { console.error('[NET] onReady', e); }
    changed();
  }

  function leave() {
    if (S.startTimer) { clearTimeout(S.startTimer); S.startTimer = null; }
    if (S.net) { try { S.net.close(); } catch (e) { /* ignore */ } }
    S.net = null; S.status = 'idle'; S.meReady = false; S.oppReady = false; S.started = false; S.message = ''; S.error = null;
    S.remoteProj = []; S.inEvents.length = 0;
    S.oppGone = true;
    if (hooks.onLeave) { try { hooks.onLeave(); } catch (e) { /* ignore */ } }
    changed();
  }

  // ------------------------------------------------------------ кадр
  const EMPTY = Object.freeze([]);
  function frame(dt, now, snap, input, events) {
    const net = S.net;
    const live = net && (net.state === 'connected' || net.state === 'lost');
    let outEvents = events || EMPTY, outSnap = snap;
    if (live) {
      // своё состояние 20 Гц
      if (snap && snap.player && now - S.lastSt >= ST_EVERY_MS) {
        S.lastSt += ST_EVERY_MS;                       // в среднем ровно 20 Гц при любом fps
        if (now - S.lastSt > ST_EVERY_MS) S.lastSt = now;
        const st = encodeState(snap.player, input, S.seq++, now);
        if (st) net.send('st', st);
      }
      // свои события — надёжно
      if (events && events.length) {
        for (const e of events) { const x = encodeEvent(e); if (x) net.send('ev', { e: x }); }
      }
      // свои снаряды 10 Гц (пустой список — один раз, чтобы у соперника они исчезли)
      if (snap && now - S.lastPr >= PR_EVERY_MS) {
        const pr = encodeProjectiles(snap.projectiles, now);
        if (pr.l.length || !S.prSentEmpty) { net.send('pr', pr); S.lastPr = now; }
        S.prSentEmpty = pr.l.length === 0;
      }
    }
    // соперник виден только в бою (в меню снимка нет) и пока он в комнате
    remote.setVisible(!!snap && !!net && net.state !== 'idle' && !S.oppGone);
    updateBadge(now, !!snap);
    // соперник: события → его модель и общий массив (data.remote = true)
    let inc = null;
    if (S.inEvents.length) { inc = S.inEvents.splice(0, S.inEvents.length); remote.pushEvents(inc); }
    remote.update(dt);
    if (inc && inc.length) outEvents = outEvents.length ? outEvents.concat(inc) : inc;
    // снаряды соперника: последний снимок + экстраполяция по скорости
    if (S.remoteProj.length && snap) {
      const age = now - S.remoteProjAt;
      if (age > 400) S.remoteProj = [];
      else {
        const lead = (age + (net ? net.ping / 2 : 0)) / 1000;
        const list = S.remoteProj.map((p) => ({ ...p, position: { x: p.position.x + p.velocity.x * lead, y: p.position.y + p.velocity.y * lead, z: p.position.z + p.velocity.z * lead } }));
        outSnap = { ...snap, projectiles: (snap.projectiles || []).concat(list) };
      }
    }
    return { events: outEvents, snapshot: outSnap };
  }

  // ------------------------------------------------------------ лобби
  function view() {
    const net = S.net;
    const p = profile();
    return {
      mode: S.mode, status: net ? net.state : 'idle', busy: S.busy, message: S.message, error: S.error, errorCode: S.errorCode,
      code: net ? net.code : null, isHost: net ? net.isHost : false, ping: net ? net.ping : 0,
      opponent: net && net.remote ? { ...net.remote, heroName: heroes && heroes[net.remote.hero] ? heroes[net.remote.hero].name : net.remote.hero } : null,
      meReady: S.meReady, oppReady: S.oppReady, startIn: S.startAt ? Math.max(0, S.startAt - performance.now()) : 0, started: S.started,
      name: p.name, hero: p.hero, lanHost: S.lanHost, https: typeof location !== 'undefined' && location.protocol === 'https:',
      lastCode: (() => { const l = readLast(); return l && l.role === 'guest' ? l.code : ''; })(),
      heroes: heroes ? Object.values(heroes).map((h) => ({ id: h.id, name: h.name })) : [],
      showLocal: S.mode === 'local' || U.transport === 'local' || !!(hooks.isDebug && hooks.isDebug()),
    };
  }

  async function openLobby() {
    S.lobbyOpen = true;
    // повторный матч: после боя лобби открывается снова — готовность заново
    if (S.started) { S.started = false; S.meReady = false; S.startAt = 0; sendLobby(); }
    if (!lobby) {
      const m = await import('../modules/netLobby.js');
      lobby = m.createNetLobby({
        root: uiRoot || document.body,
        actions: {
          host: (mode, lanHost) => host(mode, lanHost),
          join: (mode, code, lanHost) => join(mode, code, lanHost),
          ready: (on) => setReady(on),
          leave: () => leave(),
          close: () => closeLobby(),
          mode: (m2) => { if (!S.net || S.net.state === 'idle') { S.mode = m2; changed(); } },
          profile: (patch) => { if (hooks.saveSettings) hooks.saveSettings(patch); if (S.net) S.net.setProfile(profile()); sendLobby(); changed(); },
        },
      });
      listeners.add((v) => lobby.render(v));
    }
    lobby.show(true);
    changed();
  }
  function closeLobby() {
    S.lobbyOpen = false;
    if (lobby) lobby.show(false);
  }

  // автозапуск для тестов: ?net=local&netAuto=host&room=TEST&netReady
  if (U.auto === 'host' || U.auto === 'join') {
    (async () => {
      await openLobby();
      if (U.auto === 'host') await host(S.mode);
      else {
        for (let i = 0; i < 20; i++) { if (await join(S.mode, U.room)) break; await new Promise((r) => setTimeout(r, 500)); }
      }
      if (U.ready) setReady(true);
    })();
  }

  return {
    openLobby, closeLobby, frame, host, join, setReady, leave, remote,
    get net() { return S.net; },
    get active() { return !!(S.net && S.net.state !== 'idle'); },
    get lobbyOpen() { return S.lobbyOpen; },
    getOpponent: () => remote.getState(),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    debug: () => ({ ...view(), stats: S.net ? S.net.stats() : null, remote: remote.debug(), remoteProj: S.remoteProj.length }),
  };
}

function hashCode(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
