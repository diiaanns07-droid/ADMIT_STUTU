// [OFFLINE] Игра без интернета: на сцене, в школе, на Wi-Fi площадки.
//  1. Регистрирует service worker (sw.js): второй запуск мгновенный и работает без сети.
//  2. Пока человек в меню — с низким приоритетом качает MediaPipe (модуль, WASM, модели позы и кистей),
//     чтобы «Разрешить камеру» не ждало ~25 МБ.
//  3. Потом в фоне докачивает остальное из списка sw.js (другие герои, лес, запасной WASM, точная модель позы).
// Ничего не ломает: без service worker (старый браузер, ?sw=0) остаётся обычная загрузка из сети.
// ?sw=0 — выключить и удалить service worker и его кэш; ?preload=0 — без предзагрузки (замеры «до»);
// на 127.0.0.1 предзагрузки и докачки нет (сервер рядом), ?preload=1 — включить.
// Состояние для QA: window.__aoOffline.state(), await window.__aoOffline.whenReady().
import { config, DEPS } from './config.js';
import { mediaPipePreloadList, preloadMediaPipe } from './modules/vision.js';

const Q = new URLSearchParams(location.search);
const SW_OFF = Q.get('sw') === '0';
// Локальный сервер (START_GAME.cmd, 127.0.0.1) отдаёт всё мгновенно и без интернета — заранее качать нечего,
// а фоновая работа мешала бы замерам кадров. ?preload=1 — включить и здесь.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
const PRELOAD_OFF = Q.get('preload') === '0' || (LOCAL && Q.get('preload') !== '1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.info('[offline]', ...a);

const st = {
  sw: 'off',            // off | unsupported | registering | active | error
  controlled: false,
  version: null,
  preload: { status: 'idle', loaded: 0, total: 0, file: null, ms: null, errors: [] },
  warm: { status: 'idle', done: 0, total: 0, skipped: 0, file: null, errors: 0 },
};
let readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });
const listeners = new Set();
function emit() { for (const f of listeners) { try { f(state()); } catch (e) { /* ignore */ } } }
function state() { return JSON.parse(JSON.stringify({ ...st, ready: isReady() })); }
function isReady() { return ['done', 'skipped', 'error'].includes(st.warm.status) && ['done', 'skipped', 'error'].includes(st.preload.status); }
function settle() { emit(); if (isReady()) readyResolve(state()); }

window.__aoOffline = Object.freeze({
  state,
  whenReady: () => readyP,
  onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
});

// ── service worker ──
async function setupServiceWorker() {
  const sw = navigator.serviceWorker;
  if (!sw || location.protocol === 'file:') { st.sw = 'unsupported'; return null; }
  if (SW_OFF) {
    try {
      for (const r of await sw.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) if (k.startsWith('ao-')) await caches.delete(k);
      log('service worker выключен (?sw=0), кэш удалён');
    } catch (e) { /* ignore */ }
    st.sw = 'off';
    return null;
  }
  st.sw = 'registering';
  try {
    await sw.register(new URL('./sw.js', import.meta.url).href, { scope: new URL('./', import.meta.url).href });
    const reg = await Promise.race([sw.ready, sleep(20000).then(() => null)]);
    if (!reg) { st.sw = 'error'; return null; }
    // первый запуск: страница ещё не под управлением — sw.js делает clients.claim(), ждём controllerchange
    if (!sw.controller) await Promise.race([new Promise((r) => sw.addEventListener('controllerchange', r, { once: true })), sleep(5000)]);
    st.controlled = !!sw.controller;
    st.sw = 'active';
    return reg;
  } catch (e) {
    st.sw = 'error';
    console.warn('[offline] service worker не зарегистрирован:', (e && e.message) || e);
    return null;
  }
}

// вопрос к sw.js через MessageChannel
function askSW(msg, timeoutMs = 4000) {
  const c = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!c) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const to = setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (ev) => { clearTimeout(to); resolve(ev.data); };
    c.postMessage(msg, [ch.port2]);
  });
}

// ── какая модель позы понадобится: как в main.js visionProfile() ──
function poseModelUrl() {
  const forced = Q.get('pose');
  let model = forced === 'lite' || forced === 'full' ? forced : null;
  if (!model) { try { const p = window.__ASHEN__ && window.__ASHEN__.perf && window.__ASHEN__.perf(); model = p && p.poseModel; } catch (e) { /* ignore */ } }
  return model === 'full' && DEPS.mediaPipe.modelFullUrl ? DEPS.mediaPipe.modelFullUrl : DEPS.mediaPipe.modelUrl;
}
const cameraBusy = () => { try { const t = window.__ASHEN__ && window.__ASHEN__.tracking; return !!(t && t.status && t.status !== 'idle'); } catch (e) { return false; } };

async function preload() {
  if (PRELOAD_OFF) { st.preload.status = 'skipped'; return; }
  // игра уже качает модель сама (человек нажал «Разрешить камеру» раньше) — без service worker не дублируем
  if (cameraBusy() && !st.controlled) { st.preload.status = 'skipped'; return; }
  const mp = { ...config.vision.mediaPipe, modelUrl: poseModelUrl() };
  const urls = mediaPipePreloadList(mp);
  st.preload.status = 'loading';
  emit();
  const t0 = performance.now();
  const r = await preloadMediaPipe(urls, {
    priority: 'low',
    onProgress: (p) => { st.preload.loaded = p.loaded; st.preload.total = p.total; st.preload.file = p.file; emit(); },
  });
  st.preload.ms = Math.round(performance.now() - t0);
  st.preload.errors = r.errors;
  st.preload.status = r.ok ? 'done' : 'error';
  log(`MediaPipe заранее: ${(st.preload.loaded / 1048576).toFixed(1)} МБ за ${st.preload.ms} мс`, r.ok ? '' : r.errors);
  emit();
}

// ── докачка в фоне: всё из списка sw.js, чего ещё нет в кэше ──
async function warm() {
  if (PRELOAD_OFF) { st.warm.status = 'skipped'; return; }
  // на медленной сети service worker мог включиться уже после предзагрузки — ждём его до минуты
  const sw = navigator.serviceWorker;
  if (sw && !sw.controller && st.sw !== 'off' && st.sw !== 'unsupported') await Promise.race([new Promise((r) => sw.addEventListener('controllerchange', r, { once: true })), sleep(60000)]);
  st.controlled = !!(sw && sw.controller);
  if (!st.controlled) { st.warm.status = 'skipped'; return; }
  const m = await askSW({ type: 'ao-manifest' });
  if (!m || !Array.isArray(m.warm)) { st.warm.status = 'error'; return; }
  st.version = m.version;
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  const list = m.warm.filter((u) => !(saveData && /\/assets\//.test(u)));
  st.warm.total = list.length;
  st.warm.status = 'loading';
  emit();
  for (const url of list) {
    st.warm.file = url.split('/').pop();
    try {
      if (await caches.match(url, { ignoreSearch: true })) { st.warm.skipped++; st.warm.done++; continue; }
      const res = await fetch(url, { priority: 'low' });
      if (res.body && res.body.getReader) { const rd = res.body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; } }
      else await res.arrayBuffer();
      if (!res.ok) st.warm.errors++;
    } catch (e) { st.warm.errors++; }
    st.warm.done++;
    emit();
  }
  st.warm.file = null;
  st.warm.status = 'done';
  log(`офлайн-кэш готов (${st.version}): ${st.warm.done - st.warm.skipped} докачано, ${st.warm.skipped} уже было${st.warm.errors ? `, ошибок ${st.warm.errors}` : ''}`);
}

async function main() {
  if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r, { once: true }));
  await setupServiceWorker();
  emit();
  if (!window.__ASHEN__) { st.preload.status = 'skipped'; st.warm.status = 'skipped'; settle(); return; }   // игра не стартовала
  // не мешать миру и героям: сначала их ассеты (но не дольше 4 с — у MediaPipe низкий приоритет), потом MediaPipe
  for (let i = 0; i < 20; i++) {
    let pending = 0;
    try { const a = window.__ASHEN__.worldAssets && window.__ASHEN__.worldAssets(); pending = a ? a.pending : 0; } catch (e) { /* ignore */ }
    if (!pending) break;
    await sleep(200);
  }
  try { await preload(); } catch (e) { st.preload.status = 'error'; }
  emit();
  await sleep(1500);
  try { await warm(); } catch (e) { st.warm.status = 'error'; }
  settle();
}
main();
