/*
 * ASHEN OATH — service worker. [OFFLINE] Второй запуск мгновенный и работает без сети.
 *
 * Кэши (Cache Storage, префикс ao-):
 *   ao-vendor-<VENDOR_VERSION> — vendor/: three, three-vrm, MediaPipe (bundle, WASM), модели .task, шрифты, peerjs.
 *                                Пути содержат версии → cache-first. Одна загрузка на файл: если предзагрузка
 *                                (offline.js) и движок MediaPipe просят модель одновременно, второй ждёт кэш.
 *                                Локальный файл не отдался → тот же путь с CDN (cdn.jsdelivr.net / storage.googleapis.com).
 *   ao-app-<VERSION>           — код и стили: network-first (свежий код сразу после обновления; сверка с сервером —
 *                                ответ 304 без тела). Кэш — без сети или если сеть молчит дольше 2,5 с.
 *                                На 127.0.0.1 (START_GAME.cmd) — всегда сначала сервер.
 *   ao-assets                  — assets/ (герои, мир): из кэша сразу, обновление в фоне; на 127.0.0.1 — сначала сервер.
 *   ao-cdn                     — ответы CDN (режим ?cdn=1 и запасной путь).
 * VERSION меняется при любом изменении кода/ассетов (tools/sw_manifest.mjs) — старые кэши удаляются в activate.
 * Выключить: ?sw=0 (offline.js снимает регистрацию и чистит кэш).
 */
'use strict';

// <AO_MANIFEST> — генерирует node tools/sw_manifest.mjs, руками не править
const VERSION = '7be50f6d5492';
const VENDOR_VERSION = 'b3f563930682';
const SHELL = [
  "./",
  "config.js",
  "core/battleHud.js",
  "core/bdoHud.js",
  "core/bdoMinimap.js",
  "core/bdoTheme.js",
  "core/bowGesture.js",
  "core/cameraRig.js",
  "core/coachOverlay.js",
  "core/coachPictograms.js",
  "core/debugInput.js",
  "core/gameFeel.js",
  "core/gestureCoach.js",
  "core/handFxOverlay.js",
  "core/handGestures.js",
  "core/handMagic.js",
  "core/handZone.js",
  "core/inputRecorder.js",
  "core/leftStick.js",
  "core/perfHud.js",
  "core/perfTuner.js",
  "core/postfx.js",
  "core/progression.js",
  "core/pushupCounter.js",
  "core/squatCounter.js",
  "core/steerStick.js",
  "core/trackingHud.js",
  "core/tutorialTrainer.js",
  "index.html",
  "main.js",
  "modules/atmosphere.js",
  "modules/bdoIcons.js",
  "modules/boss.js",
  "modules/brightForest.js",
  "modules/characterLooks.js",
  "modules/coach.css",
  "modules/combat.js",
  "modules/combatHand.js",
  "modules/effects.js",
  "modules/elfVillage.js",
  "modules/fx/bolts.js",
  "modules/fx/bossFinale.js",
  "modules/fx/bowHand.js",
  "modules/fx/combatFx.js",
  "modules/fx/common.js",
  "modules/fx/decals.js",
  "modules/fx/glsl.js",
  "modules/fx/glyph.js",
  "modules/fx/handMagic.js",
  "modules/fx/index.js",
  "modules/fx/kit.js",
  "modules/fx/runesFire.js",
  "modules/fx/runesLight.js",
  "modules/fx/runesSky.js",
  "modules/fx/runesWild.js",
  "modules/fx/shieldHex.js",
  "modules/fx/shock.js",
  "modules/fx/sigils.js",
  "modules/fx/trails.js",
  "modules/handVisuals.js",
  "modules/heroAura.js",
  "modules/heroCloth.js",
  "modules/heroForge.js",
  "modules/heroGear.js",
  "modules/heroGhost.js",
  "modules/heroModel.js",
  "modules/heroShading.js",
  "modules/heroShowcase.js",
  "modules/heroTrail.js",
  "modules/netLobby.css",
  "modules/netLobby.js",
  "modules/pvp.js",
  "modules/remotePlayer.js",
  "modules/sfx.js",
  "modules/techniqueTrainer.js",
  "modules/ui-onboard.css",
  "modules/ui.css",
  "modules/ui.js",
  "modules/vision-worker.js",
  "modules/vision.js",
  "modules/vrmKit.js",
  "modules/world.js",
  "net/diag.js",
  "net/interp.js",
  "net/net.js",
  "net/session.js",
  "net/sync.js",
  "net/transport-lan.js",
  "net/transport-local.js",
  "net/transport-peer.js",
  "offline.js",
  "styles.css",
  "vendor/fonts/alegreya-sans-400-cyrillic-ext.woff2",
  "vendor/fonts/alegreya-sans-400-cyrillic.woff2",
  "vendor/fonts/alegreya-sans-400-latin-ext.woff2",
  "vendor/fonts/alegreya-sans-400-latin.woff2",
  "vendor/fonts/alegreya-sans-500-cyrillic-ext.woff2",
  "vendor/fonts/alegreya-sans-500-cyrillic.woff2",
  "vendor/fonts/alegreya-sans-500-latin-ext.woff2",
  "vendor/fonts/alegreya-sans-500-latin.woff2",
  "vendor/fonts/alegreya-sans-700-cyrillic-ext.woff2",
  "vendor/fonts/alegreya-sans-700-cyrillic.woff2",
  "vendor/fonts/alegreya-sans-700-latin-ext.woff2",
  "vendor/fonts/alegreya-sans-700-latin.woff2",
  "vendor/fonts/alegreya-sans-italic-400-cyrillic-ext.woff2",
  "vendor/fonts/alegreya-sans-italic-400-cyrillic.woff2",
  "vendor/fonts/alegreya-sans-italic-400-latin-ext.woff2",
  "vendor/fonts/alegreya-sans-italic-400-latin.woff2",
  "vendor/fonts/cinzel-500-latin-ext.woff2",
  "vendor/fonts/cinzel-500-latin.woff2",
  "vendor/fonts/cormorant-garamond-500-cyrillic-ext.woff2",
  "vendor/fonts/cormorant-garamond-500-cyrillic.woff2",
  "vendor/fonts/cormorant-garamond-500-latin-ext.woff2",
  "vendor/fonts/cormorant-garamond-500-latin.woff2",
  "vendor/fonts/cormorant-garamond-italic-500-cyrillic-ext.woff2",
  "vendor/fonts/cormorant-garamond-italic-500-cyrillic.woff2",
  "vendor/fonts/cormorant-garamond-italic-500-latin-ext.woff2",
  "vendor/fonts/cormorant-garamond-italic-500-latin.woff2",
  "vendor/fonts/fonts.css",
  "vendor/fonts/forum-400-cyrillic-ext.woff2",
  "vendor/fonts/forum-400-cyrillic.woff2",
  "vendor/fonts/forum-400-latin-ext.woff2",
  "vendor/fonts/forum-400-latin.woff2",
  "vendor/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs",
  "vendor/npm/@pixiv/three-vrm@3.5.5/lib/three-vrm.module.min.js",
  "vendor/npm/peerjs@1.5.5/dist/peerjs.min.js",
  "vendor/npm/three@0.185.1/build/three.core.min.js",
  "vendor/npm/three@0.185.1/build/three.module.min.js",
  "vendor/npm/three@0.185.1/examples/jsm/libs/meshopt_decoder.module.js",
  "vendor/npm/three@0.185.1/examples/jsm/loaders/GLTFLoader.js",
  "vendor/npm/three@0.185.1/examples/jsm/math/SimplexNoise.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/BokehPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/EffectComposer.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/FXAAPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/GTAOPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/MaskPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/OutputPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/Pass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/RenderPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/SMAAPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/ShaderPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/postprocessing/UnrealBloomPass.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/BokehShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/CopyShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/FXAAShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/GTAOShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/LuminosityHighPassShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/OutputShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/PoissonDenoiseShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/shaders/SMAAShader.js",
  "vendor/npm/three@0.185.1/examples/jsm/utils/BufferGeometryUtils.js",
  "vendor/npm/three@0.185.1/examples/jsm/utils/SkeletonUtils.js",
];
const WARM = [
  "vendor/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  "vendor/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  "vendor/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_module_internal.js",
  "vendor/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_module_internal.wasm",
  "vendor/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  "vendor/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js",
  "vendor/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm",
  "assets/sfx/step_2.ogg",
  "assets/sfx/ui_error.ogg",
  "assets/sfx/step_4.ogg",
  "assets/sfx/step_3.ogg",
  "assets/sfx/step_1.ogg",
  "assets/sfx/spark_2.ogg",
  "assets/sfx/spark_3.ogg",
  "assets/sfx/spark_1.ogg",
  "assets/sfx/shot_3.ogg",
  "assets/sfx/shot_2.ogg",
  "assets/sfx/shot_1.ogg",
  "assets/sfx/slash_1.ogg",
  "assets/sfx/slash_3.ogg",
  "assets/sfx/slash_2.ogg",
  "assets/sfx/dash_1.ogg",
  "assets/sfx/dash_2.ogg",
  "assets/sfx/ui_ok.ogg",
  "assets/sfx/shield_down.ogg",
  "assets/sfx/boss_hit_3.ogg",
  "assets/sfx/block_1.ogg",
  "assets/sfx/boss_hit_1.ogg",
  "assets/sfx/boss_hit_2.ogg",
  "assets/sfx/player_hit_2.ogg",
  "assets/sfx/player_hit_1.ogg",
  "assets/sfx/block_2.ogg",
  "assets/sfx/shield_up.ogg",
  "assets/sfx/orb_hit_1.ogg",
  "assets/sfx/orb_hit_2.ogg",
  "assets/sfx/orb_launch_2.ogg",
  "assets/sfx/orb_launch_1.ogg",
  "assets/sfx/perfect.ogg",
  "assets/polyhaven/dark_rock_02/dark_rock_02_arm.webp",
  "assets/sfx/parry_2.ogg",
  "assets/sfx/parry_1.ogg",
  "assets/sfx/windup_nova.ogg",
  "assets/polyhaven/monastery_stone_floor/monastery_stone_floor_arm.webp",
  "assets/sfx/windup_orb.ogg",
  "assets/sfx/rune_star.ogg",
  "assets/sfx/rune_shadow.ogg",
  "assets/sfx/rune_storm.ogg",
  "assets/sfx/rune_wind.ogg",
  "assets/sfx/rune_fire.ogg",
  "assets/sfx/windup_slam.ogg",
  "assets/sfx/boss_slam_2.ogg",
  "assets/sfx/boss_slam_1.ogg",
  "assets/sfx/rune_light.ogg",
  "assets/sfx/defeat.ogg",
  "assets/sfx/burst.ogg",
  "assets/sfx/boss_nova.ogg",
  "assets/sfx/boss_phase.ogg",
  "assets/sfx/shield_loop.ogg",
  "assets/sfx/victory.ogg",
  "assets/polyhaven/dark_rock_02/dark_rock_02_diff.webp",
  "assets/polyhaven/monastery_stone_floor/monastery_stone_floor_nor_gl.webp",
  "assets/polyhaven/dark_rock_02/dark_rock_02_nor_gl.webp",
  "assets/polyhaven/monastery_stone_floor/monastery_stone_floor_diff.webp",
  "assets/sfx/ambient.ogg",
  "assets/quaternius/human.glb",
  "assets/heroes/anims_kaykit.glb",
  "assets/quaternius/woman.glb",
  "assets/heroes/knight.glb",
  "assets/heroes/wizard.glb",
  "assets/vroid/villager_e.vrm",
  "assets/heroes/ranger.glb",
  "assets/vroid/villager_g.vrm",
  "assets/vroid/elf.vrm",
  "assets/vroid/dark.vrm",
];
// </AO_MANIFEST>

const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(self.location.hostname);
const APP = `ao-app-${VERSION}`;
const VENDOR = `ao-vendor-${VENDOR_VERSION}`;
const ASSETS = 'ao-assets';
const CDN = 'ao-cdn';
const CDN_TWINS = [
  ['vendor/npm/', 'https://cdn.jsdelivr.net/npm/'],
  ['vendor/mediapipe-models/', 'https://storage.googleapis.com/mediapipe-models/'],
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NET_TIMEOUT_MS = 2500;
const abs = (p) => new URL(p, SCOPE).href;
const noSearch = (u) => { const x = new URL(u); return x.origin + x.pathname; };
const isVendor = (p) => p.startsWith('vendor/');
const cdnTwin = (path) => { for (const [a, b] of CDN_TWINS) if (path.startsWith(a)) return b + path.slice(a.length); return null; };

// ── установка: код, стили, шрифты и библиотеки (≈5 МБ). WASM, модели и ассеты докачивает offline.js. ──
async function precacheOne(path, appCache, vendorCache) {
  const url = abs(path);
  const cache = isVendor(path) ? vendorCache : appCache;
  if (await cache.match(url)) return;
  if (isVendor(path)) {
    // путь с версией → содержимое то же: берём из прежнего кэша, не качая
    const old = await caches.match(url);
    if (old) { await cache.put(url, old); return; }
  }
  const res = await fetch(url, { cache: isVendor(path) ? 'default' : 'no-cache' });
  if (res.ok) await cache.put(url, res);
}
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const [app, ven] = await Promise.all([caches.open(APP), caches.open(VENDOR)]);
    const queue = SHELL.slice();
    let failed = 0;
    // 6 параллельных загрузок; одна неудача не срывает установку (файл докачается при первом запросе)
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) { const p = queue.shift(); try { await precacheOne(p, app, ven); } catch (err) { failed++; } }
    }));
    if (failed) console.warn(`[sw] ${VERSION}: не закэшировано файлов: ${failed}`);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([APP, VENDOR, ASSETS, CDN]);
    for (const k of await caches.keys()) if (k.startsWith('ao-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (d.type === 'ao-manifest' && port) port.postMessage({ version: VERSION, vendor: VENDOR_VERSION, shell: SHELL.length, warm: WARM.map(abs) });
});

// ── стратегии ──
const inflight = new Map();   // url → Promise, которая выполнится, когда файл ляжет в кэш

async function fetchVendor(req, path) {
  const twin = path ? cdnTwin(path) : null;
  try {
    const res = await fetch(req);
    if (res.ok || !twin) return res;
    if (res.status !== 404 && res.status < 500) return res;
  } catch (err) {
    if (!twin) throw err;   // нет сети или сервера — пробуем CDN
  }
  const cdn = await fetch(twin, { mode: 'cors', credentials: 'omit' });
  if (!cdn.ok) return cdn;
  console.warn('[sw] локального файла нет, взят с CDN:', path);
  // переупаковка: ответ CDN (cors) подходит к запросу любого режима
  return new Response(cdn.body, { status: 200, statusText: 'OK', headers: cdn.headers });
}

async function cacheFirst(e, req, cacheName, path) {
  const key = noSearch(req.url);
  const cache = await caches.open(cacheName);
  const hit = (await cache.match(key)) || (await caches.match(key));
  if (hit) return hit;
  if (inflight.has(key)) {
    try { await inflight.get(key); } catch (err) { /* качаем сами */ }
    const h = await cache.match(key);
    if (h) return h;
  }
  let done;
  inflight.set(key, new Promise((r) => { done = r; }));
  let res;
  try {
    res = await fetchVendor(req, path);
  } catch (err) {
    inflight.delete(key); done();
    throw err;
  }
  if (res.ok && res.status === 200) {
    e.waitUntil(cache.put(key, res.clone()).catch(() => {}).then(() => { inflight.delete(key); done(); }));
  } else { inflight.delete(key); done(); }
  return res;
}

async function networkFirst(e, req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic' && res.status === 200) e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    return res;
  });
  const fromCache = async () => (await cache.match(req, { ignoreSearch: true }))
    || (await caches.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? (await caches.match(abs('index.html'))) || (await caches.match(abs('./'))) : undefined);
  if (timeoutMs > 0) {
    const first = await Promise.race([net.catch(() => 'fail'), new Promise((r) => setTimeout(r, timeoutMs, 'slow'))]);
    if (first !== 'slow' && first !== 'fail') return first;
    const hit = await fromCache();
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }
  try { return await net; } catch (err) {
    const hit = await fromCache();
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(e, req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res.ok && res.type === 'basic' && res.status === 200) e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    return res;
  });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(SCOPE_PATH)) return;
    const path = decodeURIComponent(url.pathname.slice(SCOPE_PATH.length));
    if (path === 'sw.js') return;
    if (isVendor(path)) { e.respondWith(cacheFirst(e, req, VENDOR, path)); return; }
    if (path.startsWith('assets/')) { e.respondWith(LOOPBACK ? networkFirst(e, req, ASSETS, 0) : staleWhileRevalidate(e, req, ASSETS)); return; }
    if (req.mode === 'navigate' || path === '' || /\.(m?js|css|html|json)$/.test(path)) { e.respondWith(networkFirst(e, req, APP, LOOPBACK ? 0 : NET_TIMEOUT_MS)); return; }
    return;   // остальное — как без service worker
  }
  if (CDN_HOSTS.includes(url.hostname)) e.respondWith(cacheFirst(e, req, CDN, null));
});
