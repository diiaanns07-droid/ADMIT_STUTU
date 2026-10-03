// ASHEN OATH — [W5-СМЕНА] Кэш смены героя: общие инструменты heroModel и модулей оболочки героя.
//
// Почему смена героя тормозила (замер tools/hero_switch_bench.mjs, профиль Chrome): heroModel.clear() освобождал
// материалы прежнего героя ДО сборки нового — three уничтожал программы шейдеров (usedTimes → 0), и новый герой
// собирал их заново, даже с теми же ключами (эльфийка и чародейка — одни и те же программы); у ShaderMaterial
// (след посоха, аура) при этом рос номер исходника в ключе программы (WebGLShaderCache), а холсты ткани,
// перекраска атласа и лучи по телу считались с нуля одной синхронной задачей.
//
//   job = createJob({ idle })   — работа кусками: await job.slice() отдаёт поток, если кусок исчерпан.
//                                  idle — в простое браузера (requestIdleCallback), кусок ≤ 8 мс; иначе — спешно
//                                  (кадр за кадром, кусок ≤ 16 мс). job.abort() — следующий slice() бросит ABORT.
//   memo(key, make)             — детерминированный результат по ключу (лучи по телу, радиусы ткани, геометрия):
//                                  второй раз не считается. Ключ — id героя / пресет + уровень качества.
//   pinPrograms(renderer, mats) — программы материалов не уничтожаются при их dispose (usedTimes + 1, одна на ключ):
//                                  вернувшийся герой не собирает шейдеры заново.
//   retire(material)            — освободить материал; ShaderMaterial — первый по исходнику остаётся «хранителем»
//                                  (номер исходника в ключе программы не меняется, программа жива).
//   texturesOf(root, mats)      — текстуры героя (свойства материалов и юниформы).
//   showTextures(set) / hideTextures(set) — текстуры видимых героев; скрытый герой отдаёт видеопамять (dispose:
//                                  холст остаётся, three загрузит его снова при показе) — бюджет текстур как у одного.
//   uploadTextures(renderer, set, job) — загрузить текстуры заранее, кусками (до показа героя).

export const ABORT = Object.freeze({ abort: true, message: 'отменено' });
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------- работа кусками
const FG_SLICE = 16, IDLE_SLICE = 8;
let mc = null;
function macrotask() {
  // MessageChannel — без минимальной задержки setTimeout (4 мс после вложенных вызовов); в node порт с обработчиком
  // держал бы процесс живым — там setTimeout
  if (typeof MessageChannel === 'function' && typeof window !== 'undefined') {
    if (!mc) { mc = { ch: new MessageChannel(), q: [] }; mc.ch.port1.onmessage = () => { const f = mc.q.shift(); if (f) f(); }; }
    return new Promise((r) => { mc.q.push(r); mc.ch.port2.postMessage(0); });
  }
  return new Promise((r) => setTimeout(r, 0));
}
const hasIdle = typeof requestIdleCallback === 'function';
export function createJob({ idle = false } = {}) {
  const job = {
    idle, aborted: false, t0: nowMs(), budget: idle ? IDLE_SLICE : FG_SLICE,
    slices: 0, maxSlice: 0, work: 0,
    abort() { job.aborted = true; },
    // спешно: пользователь ждёт этого героя
    hurry() { if (job.idle) { job.idle = false; job.budget = FG_SLICE; } },
    async slice(force = false) {
      if (job.aborted) throw ABORT;
      const t = nowMs(), d = t - job.t0;
      if (!force && d < job.budget) return;
      job.work += d; job.slices++; if (d > job.maxSlice) job.maxSlice = d;
      if (job.idle && hasIdle) {
        await new Promise((res) => requestIdleCallback((dl) => {
          job.budget = Math.max(2, Math.min(IDLE_SLICE, (dl && dl.timeRemaining ? dl.timeRemaining() : IDLE_SLICE) - 1));
          res();
        }, { timeout: 4000 }));
      } else if (job.idle) await new Promise((r) => setTimeout(r, 30));
      else { await macrotask(); job.budget = FG_SLICE; }
      if (job.aborted) throw ABORT;
      job.t0 = nowMs();
    },
    // подождать следующий кадр (загрузка программ на видеокарте идёт в своём процессе)
    frame() { return new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16))); },
  };
  return job;
}

// ---------------------------------------------------------------- детерминированные результаты
const MEMO = new Map();
export function memo(key, make) {
  if (MEMO.has(key)) return MEMO.get(key);
  const v = make();
  MEMO.set(key, v);
  return v;
}
export function memoHas(key) { return MEMO.has(key); }

// ---------------------------------------------------------------- программы шейдеров
const PINNED = new Map();   // ключ программы → программа (usedTimes + 1 навсегда; ключей — конечное число)
const eachMat = (root, mats, fn) => {
  const seen = new Set();
  const one = (m) => { if (m && !seen.has(m)) { seen.add(m); fn(m); } };
  if (root) root.traverse((o) => { if (Array.isArray(o.material)) o.material.forEach(one); else one(o.material); if (o.customDepthMaterial) one(o.customDepthMaterial); if (o.customDistanceMaterial) one(o.customDistanceMaterial); });
  if (mats) for (const m of mats) one(m);
};
export function pinPrograms(renderer, root, mats) {
  if (!renderer || !renderer.properties) return 0;
  let n = 0;
  eachMat(root, mats, (m) => {
    if (m.isShaderMaterial || m.isRawShaderMaterial) return;   // их держит «хранитель» (retire)
    let pr = null;
    try { pr = renderer.properties.get(m).programs; } catch (e) { pr = null; }
    if (!pr || typeof pr.values !== 'function') return;
    for (const p of pr.values()) {
      if (!p || PINNED.has(p.cacheKey)) continue;
      p.usedTimes++; PINNED.set(p.cacheKey, p); n++;
    }
  });
  return n;
}
export function pinnedCount() { return PINNED.size; }

// ShaderMaterial: в ключе программы — номера исходников из WebGLShaderCache; когда освобождён последний
// материал с этим исходником, номер пропадает и следующий получает новый (новая программа). Первый
// собранный материал каждого исходника не освобождаем: юниформы-текстуры обнуляются, сам он невидим (вне сцены).
const KEEP = new Map();
let rendererRef = null;
export function setRenderer(r) { rendererRef = r || rendererRef; }
function compiled(m) {
  if (!rendererRef || !rendererRef.properties) return true;
  try { return !!rendererRef.properties.get(m).programs; } catch (e) { return true; }
}
export function retire(m) {
  if (!m) return;
  if ((m.isShaderMaterial || m.isRawShaderMaterial) && typeof m.vertexShader === 'string') {
    const k = `${m.vertexShader}\u0000${m.fragmentShader}\u0000${JSON.stringify(m.defines || {})}`;
    if (!KEEP.has(k) && compiled(m)) {
      KEEP.set(k, m);
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) u.value = null;
      return;
    }
    if (KEEP.get(k) === m) return;
  }
  m.dispose();
}
export function keptCount() { return KEEP.size; }

// ---------------------------------------------------------------- текстуры
const TEX_KEYS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'normalMap', 'displacementMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'lightMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularMap', 'specularColorMap', 'specularIntensityMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap', 'transmissionMap', 'thicknessMap', 'gradientMap', 'matcap'];
export function texturesOf(root, mats) {
  const out = new Set();
  const add = (t) => { if (t && t.isTexture) out.add(t); };
  eachMat(root, mats, (m) => {
    for (const k of TEX_KEYS) add(m[k]);
    if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u) { if (u.value && u.value.isTexture) add(u.value); }
  });
  return out;
}
// только «свои» текстуры с исходником в памяти: цели рендера (окружение PMREM, отражение) не трогаем
function evictable(t) {
  if (!t || t.isRenderTargetTexture || t.isDepthTexture || t.isFramebufferTexture || t.isVideoTexture || t.isCompressedTexture) return false;
  if (t.isCubeTexture || t.isData3DTexture || t.isDataArrayTexture) return false;
  const img = t.image;
  if (!img) return false;
  if (t.isDataTexture) return !!img.data;
  return (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas)
    || (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap)
    || (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement);
}
const SHOWN = new Set();   // наборы текстур видимых героев (всех экземпляров heroModel)
const inUse = (t) => { for (const s of SHOWN) if (s.has(t)) return true; return false; };
export function showTextures(set) { if (set) SHOWN.add(set); }
export function hideTextures(set) {
  if (!set) return 0;
  SHOWN.delete(set);
  let n = 0;
  for (const t of set) if (evictable(t) && !inUse(t)) { t.dispose(); n++; }
  return n;
}
// → сколько текстур отправлено видеокарте (уже загруженные не считаются: показ без ожидания GPU)
export async function uploadTextures(renderer, set, job) {
  if (!renderer || typeof renderer.initTexture !== 'function' || !set) return 0;
  let n = 0;
  for (const t of set) {
    if (!evictable(t)) continue;
    let fresh = true;
    try { const p = renderer.properties && renderer.properties.get(t); fresh = !p || p.__webglInit === undefined || p.__version !== t.version; } catch (e) { fresh = true; }
    if (!fresh) continue;
    try { renderer.initTexture(t); n++; } catch (e) { /* загрузится при первом кадре */ }
    if (job) await job.slice();
  }
  return n;
}

// QA
export function cacheInfo() { return { memo: MEMO.size, pinned: PINNED.size, kept: KEEP.size, texSets: SHOWN.size }; }
