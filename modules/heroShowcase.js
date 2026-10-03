// ASHEN OATH — [HERO] витрина героя в меню (экран выбора в духе BDO).
// Крупный герой в кинематографичном свете: тёплый ключевой (спереди-справа-сверху), холодный контровой
// (сзади-слева, отрисовывает силуэт), мягкий заполняющий и световое пятно на земле. Свет — шейдерный,
// только на материалах героев (heroShading.HERO_LIGHT): источники сцены не добавляются, поэтому при
// выходе из меню ничего не перекомпилируется и мир в бою не платит за лишние источники. Медленный облёт камеры
// по дуге перед героем, герой в стойке класса (HEROES[id].menuStance через heroModel.setStance).
// DOF и виньетку делает postfx №8 на 'high' (режим меню) — здесь только фокус на дистанцию до героя.
// Разметку карточки (имя, класс, стихия, описание) рисует ui.js №8 из HERO_OPTIONS.
//
// Как на экране выбора BDO: колесо мыши (щипок на тач-экране, двойной клик) приближает камеру к лицу героя,
// перетаскивание поворачивает героя с инерцией; через 8 с без касания облёт плавно возвращается.
// События — только с холста (dom): над панелью меню их получает сама панель.
//
// [W4-ВИТРИНА] «Обложка игры»:
//  • свет «три точки»: ключевой тёплый, заполняющий холодный, контровой — цветом стихии героя, со стороны
//    портала за спиной (обрисовывает силуэт и волосы); по-прежнему только юниформы HERO_LIGHT — в бою 0;
//  • сцена modules/menuStage.js: портал в руинах, частицы стихии, дымка у ног, пол с отражением —
//    строится при входе в меню, освобождается через 2 с после выхода (в бою её нет вовсе);
//  • камера: медленный облёт, при входе в меню — плавный подлёт, при смене героя — «наезд» к лицу и обратно;
//    фокус глубины резкости (postfx.setFocus) — всегда на лице;
//  • появление героя: вспышка ауры (heroModel.appear) + руническая волна по полу + поза-«визитка»
//    (heroModel.signaturePose(id), если есть: строка — имя клипа для flourish, число — сколько секунд
//    не трогать позу; нет функции — обычный idle);
//  • табличка героя (имя, класс, стихия с иконкой) — DOM в экране меню, стили — modules/ui.css;
//  • пока модель грузится — столп призыва, спираль частиц и рунный круг с подписью «Призыв героя…».
//  [W5-СМЕНА] Смена героя: пока новый собирается, на витрине стоит прежний (heroModel.shown); в кадр подмены прежний
//  рассыпается светящимся силуэтом, новый выходит из вспышки (heroModel) — витрина в тот же кадр даёт волну, вспышку
//  портала и наезд (по счётчику подмен heroModel.swaps). Стойка и поза — у показанного героя, табличка и цвет круга —
//  у выбранного. В простое (2,5 с на витрине) собираются соседи по карточкам (heroModel.prebuild) — следующая смена
//  мгновенная; выход из меню — отмена. ?prebuild=0 — без предсборки (QA: замер «холодной» смены).
//  Анимации таблички и подписи — по performance.now (без CSS-переходов): идут и под виртуальными часами записи.
//
// createHeroShowcase({ THREE, scene, heroRoot, heroModel, getPostfx, settings, dom })
//   → { update(dt, active, camera) → true, если камера выставлена витриной; get weight; get stage; dispose() }
// Свет включается только в меню (active) и плавно гаснет при выходе в бой; тени витрина не бросает.

import { createMenuStage } from './menuStage.js';   // [W4-ВИТРИНА] сцена витрины — сразу, до общей сборки шейдеров

// [W4-ВИТРИНА] иконки стихий (по id героя: у эльфийки стиль частиц «wind», а стихия — гроза)
const ELEMENT_ICON = {
  // пламя
  ashen: '<path d="M32 6c3 9 13 14 13 27a13 13 0 0 1-26 0c0-6 3-10 6-13 0 5 2 8 5 9-2-8 0-16 2-23z" fill="currentColor" opacity=".9"/><path d="M32 30c2 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z" fill="#fff4dc" opacity=".85"/>',
  // гроза: молния в кольце
  elf: '<circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="2" opacity=".55"/><path d="M36 8 20 35h10l-4 21 18-29H34z" fill="currentColor"/><path d="M33 16 25 31h7l-2 10 8-13h-6z" fill="#f4feff" opacity=".8"/>',
  // тьма и лёд: полумесяц и кристалл
  dark: '<path d="M40 10a22 22 0 1 0 14 34A18 18 0 0 1 40 10z" fill="currentColor" opacity=".55"/><g stroke="#eef6ff" stroke-width="2.4" stroke-linecap="round"><path d="M34 18v28M22 32h24M25 23l18 18M43 23 25 41"/></g><circle cx="34" cy="32" r="3.4" fill="#fff"/>',
  // ветер: три вихря
  ranger: '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M8 24h30a7 7 0 1 0-7-7"/><path d="M6 34h42a8 8 0 1 1-8 8"/><path d="M12 44h18"/></g><path d="M47 14c4 1 7 5 6 10-4-1-7-5-6-10z" fill="#fffbe6" opacity=".8"/>',
  // буря: смерч с разрядом
  archmage: '<g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".75"><path d="M10 14h44"/><path d="M15 23h34"/><path d="M20 32h24"/><path d="M25 41h14"/></g><path d="M35 30 27 44h6l-3 12 10-16h-6z" fill="#f2f9ff"/>',
};

export function createHeroShowcase({ THREE, scene, heroRoot, heroModel = null, getPostfx = null, settings = {}, dom = null } = {}) {
  const group = new THREE.Group();
  group.name = 'hero-showcase';
  scene.add(group);
  let HL = null;
  import('./heroShading.js').then((m) => { HL = m.HERO_LIGHT; }).catch(() => {});
  // [W4-ВИТРИНА] данные героев (имя, класс, стихия) — для таблички; модуль уже загружен main.js
  let HEROES = null;
  import('./heroModel.js').then((m) => { HEROES = m.HEROES; }).catch(() => {});
  const key = { position: new THREE.Vector3() }, rim = { position: new THREE.Vector3() }, rim2 = { position: new THREE.Vector3() }, fill = { position: new THREE.Vector3() };
  // световое пятно на земле под героем (аддитивный круг)
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(1.35, 40),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uK: { value: 0 }, uColor: { value: new THREE.Color(0xffc890) }, uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      // рунный круг пьедестала: мягкое пятно, три кольца, глифы по кольцу (вращаются), лучи между кольцами
      fragmentShader: `uniform float uK; uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
        const float TAU = 6.2831853;
        void main(){
          vec2 p = (vUv - 0.5) * 2.0; float r = length(p); float a = atan(p.y, p.x);
          float pool = pow(max(0.0, 1.0 - r), 2.2) * 0.55;
          float ring = smoothstep(0.014, 0.0, abs(r - 0.84)) + smoothstep(0.008, 0.0, abs(r - 0.75)) * 0.8 + smoothstep(0.007, 0.0, abs(r - 0.47)) * 0.7;
          float ar = a + uTime * 0.12;
          float sec = floor(ar / TAU * 28.0); float f = fract(ar / TAU * 28.0);
          float h = fract(sin(sec * 12.9898) * 43758.5453);
          float band = step(0.76, r) * step(r, 0.83);
          float glyph = band * step(0.2, f) * step(f, 0.8) * step(0.25, h) * smoothstep(0.02, 0.0, abs(r - (0.775 + 0.04 * h)) - 0.008 * (1.0 + h));
          glyph += band * smoothstep(0.03, 0.0, abs(f - 0.5) - 0.05) * step(0.6, h);
          float sp = step(0.48, r) * step(r, 0.74) * smoothstep(0.018, 0.0, abs(sin((a - uTime * 0.07) * 4.0))) * (0.4 + 0.6 * smoothstep(0.74, 0.5, r));
          float pulse = 0.85 + 0.15 * sin(uTime * 1.7);
          float c = (pool + (ring + glyph * 0.9 + sp * 0.5) * pulse) * smoothstep(1.0, 0.92, r);
          gl_FragColor = vec4(uColor * c * uK, c * uK);
        }`,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.renderOrder = 2;
  group.add(pool);

  const S = { w: 0, t: 0, angle: 0, stance: null, active: false };
  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _tgt = new THREE.Vector3();
  const _face = new THREE.Vector3(), _ft = new THREE.Vector3(), _portal = new THREE.Vector3();
  const _keyC = new THREE.Color(1.0, 0.82, 0.66), _fillC = new THREE.Color(0.42, 0.52, 0.76), _rimC = new THREE.Color(0.62, 0.78, 1.0), _elemC = new THREE.Color();

  // ---- приближение и поворот (ввод с холста)
  const U = { zoom: 0, zoomT: 0, yaw: 0, yawV: 0, idle: 99, faceOk: false, used: false };
  const ptrs = new Map();
  let pinch0 = 0;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const touched = () => { U.idle = 0; if (!U.used) { U.used = true; try { localStorage.setItem('ashen-oath.showcase-hint', '1'); } catch (e) { /* ignore */ } } };
  const onWheel = (e) => {
    if (!S.active) return;
    e.preventDefault();
    const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    U.zoomT = clamp01(U.zoomT - d * 0.0014); touched();
  };
  const onDown = (e) => {
    if (!S.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { dom.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
    U.yawV = 0; touched();
  };
  const onMove = (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || !S.active) return;
    const dx = e.clientX - p.x;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      const k = 5.5 / Math.max(320, (dom && dom.clientWidth) || 1280);   // ширина холста ≈ 5.5 рад
      U.yaw += dx * k; U.yawV = U.yawV * 0.6 + dx * k * 60 * 0.4;
    } else if (ptrs.size === 2 && pinch0 > 0) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      U.zoomT = clamp01(U.zoomT + (d - pinch0) * 0.004); pinch0 = d;
    }
    touched();
  };
  const onUp = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = 0; };
  const onDbl = () => { if (!S.active) return; U.zoomT = U.zoomT > 0.5 ? 0 : 1; touched(); };
  if (dom && dom.addEventListener) {
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('dblclick', onDbl);
    try { U.used = localStorage.getItem('ashen-oath.showcase-hint') === '1'; } catch (e) { /* ignore */ }
  }
  // подсказка в углу (пока игрок ни разу не приблизил/не повернул героя)
  let hint = null, summon = null, plate = null;
  const hasDom = !!(dom && typeof document !== 'undefined' && dom.parentElement);
  if (hasDom) {
    hint = document.createElement('div');
    hint.className = 'ao-showcase-hint';
    hint.textContent = 'Колесо — приблизить героя · перетащить — повернуть';
    hint.setAttribute('aria-hidden', 'true');
    Object.assign(hint.style, { position: 'absolute', right: '18px', bottom: '14px', fontSize: '13px', lineHeight: '1.3', fontFamily: 'inherit', letterSpacing: '0.04em', color: 'rgba(232,220,192,0.72)', textShadow: '0 1px 3px rgba(0,0,0,0.8)', pointerEvents: 'none', opacity: '0', transition: 'opacity 0.6s ease', zIndex: '1' });
    dom.parentElement.appendChild(hint);
    // [LOAD] пока модель героя грузится — подпись у рунного круга (сам круг в это время пульсирует).
    // [W4-ВИТРИНА] подпись — с рунным кольцом; стили — modules/ui.css (.ao-showcase-summon)
    summon = document.createElement('div');
    summon.className = 'ao-showcase-summon';
    summon.setAttribute('aria-hidden', 'true');
    summon.innerHTML = '<svg class="ao-showcase-summon__ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".7"/>'
      + '<circle cx="32" cy="32" r="21" fill="none" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2.5 4.2" opacity=".9"/>'
      + '<path d="M32 3v7M32 54v7M3 32h7M54 32h7M11.5 11.5l5 5M47.5 47.5l5 5M52.5 11.5l-5 5M16.5 47.5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
      + '<path d="M32 18 44 39H20z" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".8"/></svg>'
      + '<span class="ao-showcase-summon__text">Призыв героя<span class="ao-showcase-summon__dots"></span></span>';
    Object.assign(summon.style, { opacity: '0' });
    // [W4-ВИТРИНА] табличка героя
    plate = document.createElement('div');
    plate.className = 'ao-heroplate';
    plate.setAttribute('aria-hidden', 'true');   // имя героя и так в выбранной карточке меню
    plate.innerHTML = '<div class="ao-heroplate__cls"></div><div class="ao-heroplate__name"></div>'
      + '<div class="ao-heroplate__rule"><i></i></div>'
      + '<div class="ao-heroplate__elem"><span class="ao-heroplate__icon"><svg viewBox="0 0 64 64" aria-hidden="true"></svg></span><span class="ao-heroplate__elname"></span></div>'
      + '<div class="ao-heroplate__desc"></div>';
    Object.assign(plate.style, { opacity: '0' });
  }
  // табличка и подпись — внутри экрана меню (.ao-ui): прячутся вместе с ним и лежат под окнами интерфейса;
  // нет экрана меню (стенд) — поверх холста
  let mounted = false, mountTry = 0;
  function mount() {
    if (mounted || !hasDom) return;
    const host = document.querySelector('.ao-ui .ao-screen--menu');
    if (!host && ++mountTry < 120) return;
    const parent = host || dom.parentElement;
    if (!host) { summon.style.zIndex = '11'; plate.style.zIndex = '11'; }
    parent.appendChild(summon); parent.appendChild(plate);
    mounted = true;
  }
  const P = { hero: '', shown: 0, swapT: 0, op: '', tf: '', ls: '', loadOp: '', ring: '', dots: '' };
  function fillPlate(id) {
    const H = HEROES && HEROES[id];
    if (!plate || !H) return false;
    const q = (s) => plate.querySelector(s);
    q('.ao-heroplate__cls').textContent = H.cls || '';
    q('.ao-heroplate__name').textContent = H.name || '';
    q('.ao-heroplate__elname').textContent = H.element || '';
    q('.ao-heroplate__desc').textContent = (H.desc && H.desc[0]) || '';
    q('.ao-heroplate__icon svg').innerHTML = ELEMENT_ICON[id] || ELEMENT_ICON.ashen;
    const c = H.fx && H.fx.color != null ? H.fx.color : 0xd8b36a;
    plate.style.setProperty('--ao-elem', '#' + c.toString(16).padStart(6, '0'));
    if (summon) summon.style.setProperty('--ao-elem', '#' + c.toString(16).padStart(6, '0'));
    plate.dataset.hero = id;
    return true;
  }
  // табличка: при смене героя гаснет (0,22 с), меняет текст, въезжает справа с разрядкой букв (0,8 с)
  function platePulse(active, id, zc) {
    if (!plate || !mounted) return;
    // [W4-СБОРКА] вне меню табличка погасла — без строк стиля каждый кадр (витрина тикает и в бою)
    if (!active && !P.out && P.shown <= 0 && P.op === '0.000' && id === P.hero) return;
    const now = nowMs();
    if (id !== P.hero) {
      if (!P.hero || P.shown < 0.05) { if (fillPlate(id)) { P.hero = id; P.swapT = now; } }
      else P.out = true;
    }
    let op = 0, tx = 0, ls = 0;
    if (P.out) {
      P.shown = Math.max(0, P.shown - 1 / 0.22 * Math.min(0.1, S.dtc));
      op = P.shown;
      if (P.shown <= 0) { P.out = false; if (fillPlate(id)) { P.hero = id; P.swapT = now; } }
    } else if (P.hero) {
      const k = settings.reducedMotion ? 1 : Math.min(1, (now - P.swapT) / 800);
      const e = 1 - Math.pow(1 - k, 3);
      P.shown = active ? e : Math.max(0, P.shown - 4 * Math.min(0.1, S.dtc));
      op = active ? e : P.shown;
      tx = (1 - e) * 28; ls = (1 - e) * 0.22;
    }
    // крупный план (наезд, колесо): герой крупнее и заходит под табличку — она уходит, вернётся с облётом
    const zf = clamp01((zc - 0.18) / 0.32);
    op *= 1 - 0.88 * zf * zf * (3 - 2 * zf);
    const so = op.toFixed(3), st = `translate3d(${tx.toFixed(1)}px,0,0)`, sl = `${(0.03 + ls).toFixed(3)}em`;
    if (so !== P.op) { P.op = so; plate.style.opacity = so; }
    if (st !== P.tf) { P.tf = st; plate.style.transform = st; }
    if (sl !== P.ls) { P.ls = sl; const n = plate.querySelector('.ao-heroplate__name'); if (n) n.style.letterSpacing = sl; }
  }
  const heroes = () => (heroModel && heroModel.heroes) || null;

  // [LOAD] выбранный герой стоит на витрине 2,5 с — в простое скачиваем модели остальных героев меню,
  // чтобы смена героя не ждала сети. Ушли из меню (камера, бой) или грузится выбранный герой — отмена
  // (канал нужен MediaPipe и ему); то, что уже ждёт герой, heroModel не отменяет.
  // Экономия трафика в браузере (Save-Data) — без предзагрузки.
  // Время — по часам (performance.now): dt кадра main.js режет до 1/20 с и на слабом железе отстаёт.
  const PF = { since: 0, ctl: null, done: false };
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  // [W5-СМЕНА] предсборка соседей: своя отмена (выход из меню, смена героя) и свой «уже собраны» — по показанному герою
  const PB = { hero: null, ctl: null, off: typeof location !== 'undefined' && /[?&]prebuild=0/.test(location.search || '') };
  function prebuildNeighbors(active) {
    if (PB.off || !heroModel || typeof heroModel.prebuild !== 'function') return;
    const shown = heroModel.shown;
    if (!active || !heroModel.ready || !shown) { if (PB.ctl) { PB.ctl.abort(); PB.ctl = null; } PB.hero = null; return; }
    if (PB.hero === shown || nowMs() - PF.since < 2500 || !PF.since) return;
    if (PB.ctl) PB.ctl.abort();
    PB.hero = shown;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    PB.ctl = ctl;
    const ids = heroModel.neighbors ? heroModel.neighbors(shown) : [];
    const go = () => { if (PB.ctl === ctl && !(ctl && ctl.signal.aborted)) heroModel.prebuild(ids, { signal: ctl ? ctl.signal : undefined }).catch(() => {}); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 3000 }); else setTimeout(go, 0);
  }
  function prefetchHeroes(dt, active) {
    prebuildNeighbors(active);
    if (!active || !heroModel || !heroModel.ready) { if (PF.ctl) { if (PF.ctl.abort) PF.ctl.abort(); PF.ctl = null; } PF.since = 0; return; }
    if (!PF.since) PF.since = nowMs();   // [W5-СМЕНА] отсчёт простоя — и для предсборки соседей
    if (PF.done || PF.ctl || typeof heroModel.prefetch !== 'function') return;
    if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) { PF.done = true; return; }
    if (nowMs() - PF.since < 2500) return;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    PF.ctl = ctl || {};
    const go = () => {
      if (PF.ctl !== (ctl || PF.ctl)) return;
      // завершилась не отменой (успех или ошибка сети) — больше не повторяем
      heroModel.prefetch(undefined, { signal: ctl ? ctl.signal : undefined }).then(() => { if (PF.ctl === (ctl || PF.ctl)) { PF.ctl = null; PF.done = true; } });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 0);
  }

  // [W4-ВИТРИНА] сцена витрины: строится сразу (main.js собирает шейдеры сцены после создания витрины — её
  // программы соберутся вместе с миром, первый кадр меню без рывка); ошибка — витрина без сцены
  let stage = null, reflectKey = '';
  try { stage = createMenuStage({ THREE, scene, quality: settings.quality, reducedMotion: !!settings.reducedMotion, prebuild: true }); } catch (e) { console.warn('[W4-ВИТРИНА] сцена витрины', e); stage = null; }
  function stageTick(dt, active, camera, w, fxc, zc) {
    if (!stage) return;
    try {
      if (stage.quality !== settings.quality) stage.setQuality(settings.quality);
      stage.setReducedMotion(!!settings.reducedMotion);
      // отражение: новый герой загрузился — его меши в слой отражения
      // [W4-СБОРКА] без строки-ключа каждый кадр; [W5-СМЕНА] по номеру подмены: A→B→A и готовые из кэша — тоже в отражение
      const rk = heroModel ? (heroModel.swaps !== undefined ? heroModel.swaps : heroModel.hero) : '';
      if (heroModel && heroModel.ready && rk !== reflectKey) { reflectKey = rk; stage.setReflect(heroRoot); }
      const id = heroModel ? heroModel.hero : '';
      const H = HEROES && HEROES[id];
      V.w = w; V.active = active; V.heroPos = heroRoot.position; V.heroYaw = heroRoot.rotation.y; V.camera = camera;
      V.fx = fxc; V.element = H ? H.element : ''; V.key = key.position;
      V.appear = S.ap || 0;
      V.loading = S.loadT; V.fogColor = scene.fog && scene.fog.color ? scene.fog.color : null; V.zoom = zc; V.orbit = S.orbit || 0;
      stage.update(dt, V);
    } catch (e) { console.warn('[W4-ВИТРИНА] сцена витрины отключена', e); try { stage.dispose(); } catch (err) { /* ignore */ } stage = null; }
  }
  const V = { w: 0, active: false, heroPos: null, heroYaw: 0, camera: null, fx: null, element: '', key: null, appear: 0, loading: 0, fogColor: null, zoom: 0, orbit: 0 };

  function place(zc) {
    const hp = heroRoot.position, yaw = heroRoot.rotation.y;
    _f.set(Math.sin(yaw), 0, Math.cos(yaw));        // вперёд героя
    _r.set(-Math.cos(yaw), 0, Math.sin(yaw));        // вправо героя
    const at = (l, fwd, right, up) => l.position.copy(hp).addScaledVector(_f, fwd).addScaledVector(_r, right).setY(hp.y + up);
    // при приближении ключ уходит вбок и ниже — портретный свет (лицо лепится светотенью, а не заливается)
    const zk = zc * zc * (3 - 2 * zc);
    at(key, 2.2 - 1.0 * zk, 1.5 + 0.9 * zk, 2.7 - 0.6 * zk);
    at(rim, -2.3, -1.2, 2.5);
    at(rim2, -2.0, 1.6, 1.4);
    at(fill, 1.6, -1.8, 1.2);
    pool.position.set(hp.x, hp.y + 0.02, hp.z);
  }

  // [W4-ВИТРИНА] «наезд» при появлении героя: 0,3 с пауза (волна), 1 с к лицу, держим до 2,6 с, обратно к 4,4 с
  function pushCurve(t) {
    if (t < 0.3) return 0;
    if (t < 1.3) { const k = (t - 0.3) / 1.0; return k * k * (3 - 2 * k); }
    if (t < 2.6) return 1;
    if (t < 4.4) { const k = (t - 2.6) / 1.8; return 1 - k * k * (3 - 2 * k); }
    return 0;
  }
  function onAppear(id, first) {
    // [W5-СМЕНА] «Уменьшенное движение»: без волны по полу и ударной волны экрана — только мягкая засветка
    const reduced = !!settings.reducedMotion;
    if (stage && !reduced) stage.wave();
    // своя огибающая вспышки (1,3 с): heroModel.appear в меню у края арены не гаснет (там его update — боевой)
    S.ap = 1;
    S.pushT = first || settings.reducedMotion ? -1 : 0;
    S.sigHold = 0;
    // поза-«визитка» героя (агент №4): строка — клип для flourish, число — сколько секунд не трогать позу
    if (heroModel && typeof heroModel.signaturePose === 'function') {
      try {
        const r = heroModel.signaturePose(id);
        if (typeof r === 'string' && heroModel.flourish) heroModel.flourish(r);
        else if (typeof r === 'number' && r > 0) S.sigHold = r;
      } catch (e) { /* ignore */ }
    }
    // экран откликается на появление — волна и лёгкая засветка цветом стихии (medium/high; на low — без них)
    const pf = getPostfx && getPostfx();
    if (pf && typeof pf.pulse === 'function' && settings.quality !== 'low' && !first) {
      try {
        const fx = heroModel && heroModel.heroFx ? heroModel.heroFx(id) : null;
        _p.copy(heroRoot.position).setY(heroRoot.position.y + 0.9);
        if (!reduced) pf.pulse('shockwave', 0.32, { x: _p.x, y: _p.y, z: _p.z });
        pf.pulse('flash', reduced ? 0.07 : 0.14, undefined, { color: fx ? fx.color : 0xffd08a, dur: 0.7 });
      } catch (e) { /* ignore */ }
    }
  }

  function update(dt, active, camera) {
    S.t += dt;
    S.dtc = dt;
    if (S.active && !active) { U.zoomT = 0; U.yaw = 0; U.yawV = 0; ptrs.clear(); if (heroModel && heroModel.setGaze) heroModel.setGaze(0); }
    // [W4-ВИТРИНА] вход в меню — плавный подлёт камеры
    if (!S.active && active) S.intro = settings.reducedMotion ? 0 : 1;
    S.active = !!active;
    // щипок на тач-экране: в меню жесты холста наши (не масштаб страницы), в бою — как было
    if (dom && dom.style && S.touchA !== S.active) { S.touchA = S.active; dom.style.touchAction = S.active ? 'none' : ''; }
    if (hint) { const show = active && !U.used && S.t > 3 ? '1' : '0'; if (hint.style.opacity !== show) hint.style.opacity = show; }
    mount();
    // [LOAD] герой ещё грузится: подпись через 0,4 с по часам (без мигания при быстрой смене) и пульс круга
    const loading = !!(active && heroModel && !heroModel.ready);
    if (!loading) S.loadSince = 0; else if (!S.loadSince) S.loadSince = nowMs();
    S.loadT = loading ? (nowMs() - S.loadSince) / 1000 + 1e-3 : 0;
    if (summon) {
      const show = S.loadT > 0.4 ? clamp01((S.loadT - 0.4) / 0.35) : 0;
      S.sumOp = show > (S.sumOp || 0) ? show : Math.max(0, (S.sumOp || 0) - dt * 4);
      const so = S.sumOp.toFixed(2);
      if (so !== P.loadOp) { P.loadOp = so; summon.style.opacity = so; }
      if (S.sumOp > 0) {
        // рунное кольцо вращается, точки «…» набегают — по часам страницы
        const ring = summon.firstChild;
        const rs = `rotate(${((nowMs() / 1000) * 40 % 360).toFixed(1)}deg)`;
        if (ring && rs !== P.ring) { P.ring = rs; ring.style.transform = rs; }
        const dots = '.'.repeat(1 + (Math.floor(nowMs() / 420) % 3));
        if (dots !== P.dots) { P.dots = dots; const d = summon.querySelector('.ao-showcase-summon__dots'); if (d) d.textContent = dots; }
      }
    }
    prefetchHeroes(dt, active);
    const want = active ? 1 : 0;
    if (S.t === dt && active) S.w = 1;               // первый кадр в меню — сразу полный свет
    S.w += (want - S.w) * (1 - Math.exp(-(active ? 3 : 6) * dt));
    const w = S.w;
    group.visible = w > 0.01;
    // [W4-ВИТРИНА] наезд камеры и подлёт — эффективное приближение zc (приближение игрока U.zoom — отдельно)
    if (S.pushT >= 0) { S.pushT += dt; if (S.pushT > 4.4) S.pushT = -1; }
    // сглажено: быстрая смена героев (новый наезд, пока не кончился прежний) — без скачка камеры
    const pushT = S.pushT >= 0 ? pushCurve(S.pushT) : 0;
    S.push = (S.push || 0) + (pushT - (S.push || 0)) * (1 - Math.exp(-5 * dt));
    if (S.push < 1e-3 && pushT === 0) S.push = 0;
    const push = S.push;
    if (S.intro > 0) S.intro = Math.max(0, S.intro - dt / 3.2);
    if (S.ap > 0) S.ap = Math.max(0, S.ap - dt / 1.3);
    if (heroModel && heroModel.setReducedMotion && S.rm !== !!settings.reducedMotion) { S.rm = !!settings.reducedMotion; heroModel.setReducedMotion(S.rm); }
    if (heroModel && heroModel.setStance) {
      // [W5-СМЕНА] стойка, поза и жесты — у показанного героя (пока новый собирается, это прежний)
      const id = heroModel.shown !== undefined ? heroModel.shown || heroModel.hero : heroModel.hero;
      const st = active ? (heroModel.menuStance ? heroModel.menuStance(id) : null) : null;
      if (st !== S.stance) { S.stance = st; heroModel.setStance(st); }
      // [W4-ВИТРИНА] выбран другой герой (или первый в меню) — появление: волна, наезд, поза-«визитка»
      // [W5-СМЕНА] по номеру подмены (heroModel.swaps): появление ловится и при возврате к прежнему герою
      const ak = heroModel.swaps !== undefined ? `${id}#${heroModel.swaps}` : id;
      if (active && heroModel.ready && ak !== S.lastHero) {
        const first = !S.lastHero;
        S.lastHero = ak; S.idleT = 0; S.nextGesture = 7 + Math.random() * 4;
        onAppear(id, first);
      }
      if (S.sigHold > 0) S.sigHold = Math.max(0, S.sigHold - dt);
      // поза класса (лучницы: лук в руке, опущен наготове); вне меню позу задаёт ввод (main.js)
      const mp = active && heroModel.menuPose && !(S.sigHold > 0) ? heroModel.menuPose(id) : null;
      // [HERO] жест на витрине раз в 10–16 с: маги вздымают посох, лучницы вскидывают лук и натягивают тетиву
      if (active && heroModel.ready && !settings.reducedMotion && !(S.sigHold > 0)) {
        S.idleT = (S.idleT || 0) + dt;
        if (S.idleT > (S.nextGesture || 9) && U.zoom < 0.3 && push === 0) {
          S.idleT = 0; S.nextGesture = 10 + Math.random() * 6;
          if (mp) S.drawT = 2.2; else if (heroModel.flourish) heroModel.flourish('CastRaise');
        }
      }
      if (mp && U.zoom > 0.5) {
        // крупный план: лук убран за спину, руки свободны — лицо открыто
        if (S.posed !== 'zoom') { heroModel.setPose({ bowActive: false, bowDraw: 0, handSpell: 0 }); S.posed = 'zoom'; }
      } else if (mp) {
        let p = mp;
        if (S.drawT > 0) {
          S.drawT = Math.max(0, S.drawT - dt);
          const k = Math.sin(Math.PI * (1 - S.drawT / 2.2)) ** 0.8;
          p = { bowActive: true, bowDraw: mp.bowDraw + (0.9 - mp.bowDraw) * k, aim: { x: mp.aim.x + (0.15 - mp.aim.x) * k, y: mp.aim.y + (0.05 - mp.aim.y) * k } };
        }
        heroModel.setPose(p); S.posed = true;
      }
      else if (S.posed && !(S.sigHold > 0)) { heroModel.setPose({ bowActive: false, bowDraw: 0, handSpell: 0 }); S.posed = false; }
    }
    U.zoom += (U.zoomT - U.zoom) * (1 - Math.exp(-5 * dt));
    const z = U.zoom * U.zoom * (3 - 2 * U.zoom);
    const zc = Math.max(z, 0.6 * push);
    const fxc = heroModel && heroModel.heroFx ? heroModel.heroFx(heroModel.hero) : null;
    platePulse(active, heroModel ? heroModel.hero : '', zc);
    if (group.visible) place(zc);
    stageTick(dt, active, camera, w, fxc, zc);
    if (!group.visible) {
      if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.setRGB(0, 0, 0); HL.heroRimColor.value.setRGB(0, 0, 0); HL.heroFillColor.value.setRGB(0, 0, 0); }
      return false;
    }
    // появление героя: рунный круг вспыхивает вместе с аурой
    const ap = S.ap || 0;
    pool.material.uniforms.uK.value = 0.9 * w * (1 + 1.4 * ap * ap) * (S.loadT > 0 ? 1.25 + 0.35 * Math.sin(S.t * 3.2) : 1);
    pool.material.uniforms.uTime.value = S.t;
    // цвет круга — стихия выбранного героя
    if (fxc && fxc.color !== S.poolHex) { S.poolHex = fxc.color; pool.material.uniforms.uColor.value.set(fxc.color); }
    if (!active || !camera) {
      if ((S.bloomK ?? 1) !== 1) { const pf0 = getPostfx && getPostfx(); if (pf0 && pf0.setBloomK) { try { pf0.setBloomK(1); } catch (e) { /* ignore */ } } S.bloomK = 1; }
      if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.multiplyScalar(0.9); HL.heroRimColor.value.multiplyScalar(0.9); HL.heroFillColor.value.multiplyScalar(0.9); }
      return false;
    }
    // облёт: дуга перед героем, дистанция «по пояс», герой справа от панели меню
    const reduced = !!settings.reducedMotion;
    S.angle += dt * (reduced ? 0.03 : 0.11);
    // приближение/поворот: инерция поворота, через 8 с без касания — обратно к облёту
    U.idle += dt;
    if (!ptrs.size) { U.yaw += U.yawV * dt; U.yawV *= Math.exp(-3.5 * dt); }
    if (U.idle > 8 && !ptrs.size) {
      U.yaw = Math.atan2(Math.sin(U.yaw), Math.cos(U.yaw));
      U.yaw *= Math.exp(-0.6 * dt);
    }
    if (heroModel && heroModel.setGaze) heroModel.setGaze(z);
    const hp = heroRoot.position;
    // лицо героя (якорь головы), сглаженное — камера не трясётся вместе с дыханием
    const anc = heroModel && heroModel.getAnchors ? heroModel.getAnchors() : null;
    if (anc && anc.head && anc.head.parent && heroModel.ready) {
      anc.head.getWorldPosition(_ft); _ft.y -= 0.05;
      if (!U.faceOk || _face.distanceToSquared(_ft) > 1) { _face.copy(_ft); U.faceOk = true; }
      else _face.lerp(_ft, 1 - Math.exp(-4 * dt));
    } else if (!U.faceOk) _face.set(hp.x, hp.y + 1.58, hp.z);
    // [W4-ВИТРИНА] дуга облёта ±20° (было ±32°): портал за спиной героя доворачивается на половину дуги
    const orbit = 0.36 * Math.sin(S.angle) * (1 - 0.6 * zc);
    S.orbit = orbit * 0.55;
    const yaw = heroRoot.rotation.y + 0.18 * (1 - 0.6 * zc) + orbit + U.yaw;
    // [W4-ВИТРИНА] подлёт при входе в меню: дальше и выше, плавно к облёту
    const ik = S.intro > 0 ? S.intro * S.intro * (3 - 2 * S.intro) : 0;
    const dist = ((2.8 + 0.18 * Math.sin(S.angle * 0.7)) * (1 - zc) + 0.64 * zc) * (1 + 0.55 * ik);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // цель: «по пояс» (герой справа от панели меню) → лицо, сдвиг держит тот же угол от центра кадра
    const side = 0.85 * dist / 2.8;
    const cx = hp.x * (1 - zc) + _face.x * zc, cz = hp.z * (1 - zc) + _face.z * zc;
    const tgY = (hp.y + 1.12) * (1 - zc) + (_face.y - 0.05) * zc + 0.25 * ik;
    const camY = (hp.y + 1.38 + 0.08 * Math.sin(S.angle * 0.5)) * (1 - zc) + (_face.y + 0.01) * zc + 0.9 * ik;
    camera.position.set(cx + Math.sin(yaw) * dist, camY, cz + Math.cos(yaw) * dist);
    _tgt.set(cx - rx * side, tgY, cz - rz * side);
    camera.lookAt(_tgt);
    // шейдерный свет героев: направления на источники — в осях камеры
    if (HL && HL.heroKeyColor.value) {
      camera.updateMatrixWorld();
      const c = _p.copy(hp).setY(hp.y + 1.2);
      const q = settings.quality === 'low' ? 0.8 : 1;
      HL.heroKeyDir.value.copy(key.position).sub(c).normalize().transformDirection(camera.matrixWorldInverse);
      // [W4-ВИТРИНА] контровой — со стороны портала за спиной героя (чуть сверху), цветом стихии
      if (stage && stage.portalWorld) stage.portalWorld(_portal); else _portal.copy(rim.position);
      HL.heroRimDir.value.copy(_portal).sub(c).normalize().setY(0).normalize().multiplyScalar(0.85);
      HL.heroRimDir.value.y = 0.45;
      HL.heroRimDir.value.normalize().transformDirection(camera.matrixWorldInverse);
      HL.heroKeyColor.value.copy(_keyC).multiplyScalar(2.0 * w * q * (1 + 0.3 * zc) * (1 + 0.25 * ap * ap));   // портретный ключ сбоку — чуть ярче
      if (fxc) _elemC.set(fxc.color).lerp(_rimC, 0.18); else _elemC.copy(_rimC);
      HL.heroRimColor.value.copy(_elemC).multiplyScalar(1.9 * w * (1 + 1.2 * ap * ap));
      HL.heroFillColor.value.copy(_fillC).multiplyScalar(0.42 * w);
    }
    const pf = getPostfx && getPostfx();
    if (pf && typeof pf.setBloomK === 'function') { const bk = 1 - 0.6 * zc; if (Math.abs(bk - (S.bloomK ?? 1)) > 0.01) { S.bloomK = bk; try { pf.setBloomK(bk); } catch (e) { /* ignore */ } } }
    // [W4-ВИТРИНА] фокус глубины резкости — на лице
    if (pf && typeof pf.setFocus === 'function') { try { pf.setFocus(camera.position.distanceTo(_face)); } catch (e) { /* ignore */ } }
    void heroes;
    return true;
  }

  function dispose() {
    if (PF.ctl && PF.ctl.abort) PF.ctl.abort();
    scene.remove(group);
    if (stage) { try { stage.dispose(); } catch (e) { /* ignore */ } stage = null; }
    if (dom && dom.removeEventListener) {
      dom.removeEventListener('wheel', onWheel); dom.removeEventListener('pointerdown', onDown); dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp); dom.removeEventListener('pointercancel', onUp); dom.removeEventListener('dblclick', onDbl);
    }
    if (hint && hint.parentElement) hint.parentElement.removeChild(hint);
    if (summon && summon.parentElement) summon.parentElement.removeChild(summon);
    if (plate && plate.parentElement) plate.parentElement.removeChild(plate);
    pool.geometry.dispose(); pool.material.dispose();
    if (HL && HL.heroKeyColor.value) { HL.heroKeyColor.value.setRGB(0, 0, 0); HL.heroRimColor.value.setRGB(0, 0, 0); HL.heroFillColor.value.setRGB(0, 0, 0); }
  }
  return {
    update, dispose, get weight() { return S.w; }, get zoom() { return U.zoom; }, setZoom(v) { U.zoomT = clamp01(v); }, setYaw(v) { U.yaw = v; U.yawV = 0; U.idle = 0; }, group,
    get stage() { return stage ? { ...stage.info(), push: S.pushT >= 0 ? +S.pushT.toFixed(2) : -1, plate: P.hero, plateOp: +P.op || 0 } : null },   // [W4-ВИТРИНА] QA
  };
}
