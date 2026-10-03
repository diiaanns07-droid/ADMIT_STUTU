/* ASHEN OATH — движок презентации.
 *
 * Слайды регистрируются обычным скриптом (без модулей и fetch, работает из file://):
 *   (window.DECK_QUEUE = window.DECK_QUEUE || []).push({
 *     n: 7, sec: 45,
 *     html: `<section class="slide" data-slide="7" data-title="…">… <aside class="notes">…</aside></section>`,
 *     enter(el, dir, info) {}, leave(el) {}, step(el, k) {}, demo(el, action) {}
 *   });
 * Хуки необязательны. dir = 1 — вход вперёд с предыдущего слайда (шаги скрыты, можно анимировать);
 * dir = -1 — вход назад, переход по hash, Home/End, «Содержание»: слайд показан целиком, сразу конечное состояние.
 * info = { prev, jump }. После каждой смены на document приходит событие deck:change { n, prev }.
 *
 * Общий договор разметки:
 *   data-step="1"…          — шаги (.is-on); элементы одного шага раскрываются лесенкой по 70 мс;
 *   .reveal                 — проявляется при входе вперёд лесенкой (150 мс + 80 мс на элемент), в шаге — с шагом;
 *   data-countup            — первое число в тексте считается от 0 (или data-from) до себя за 600 мс, когда видно;
 *                             data-countup="1050" — явное значение; подпись, единицы и разделители сохраняются;
 *   data-roll               — цифры прокручиваются барабаном до своего значения (900 мс, лесенкой по разрядам);
 *   data-particles          — элемент собирается из частиц при входе вперёд (≤ 1,5 с); значение — число частиц
 *                             (по умолчанию 1400); data-particles-from="селектор" — частицы вылетают из этого
 *                             элемента, а не с краёв кадра; data-particles-delay="мс" — задержка старта;
 *   data-morph="ключ"       — «волшебный переход»: элемент с тем же ключом на соседнем слайде перелетает на новое
 *                             место и размер (550 мс);
 *   data-demo="действие"    — кнопка демонстрации: щелчок (или клавиша D — первое действие слайда) вызывает хук
 *                             demo(el, действие) и событие deck:demo { n, action };
 *   data-bg="путь.jpg|mp4"  — фон слайда (видео — с data-bg-poster); data-bg-shade="left|bottom|full|none";
 *   data-action="autoplay"  — кнопка автопросмотра; .num[data-ignite] — цифра «загорается руной».
 * Видео: <video data-src="…" poster="…" muted loop playsinline preload="none"> + <img class="print-poster">;
 * src только у активного (играет) и следующего (подгружается) слайда. Картинки слайдов грузятся лениво.
 *
 * Клавиши (по e.code — работают и в русской раскладке): → пробел PageDown Enter — вперёд; ← PageUp Backspace — назад;
 * Home/End; O — «Содержание»; A — автопросмотр; D — демонстрация; F — полный экран; S — окно докладчика;
 * B и «.» — чёрный экран; ? — помощь. Номер слайда — в hash (#7). Щелчок по левой пятой части экрана — назад,
 * по правой — вперёд; на телефоне — свайп. */
(function () {
  'use strict';

  var TOTAL = +window.DECK_TOTAL || 11;   // слайдов в докладе; недостающие показываются заглушкой «в сборке»
  var STUB_SEC = 40;                       // время на слайд-заглушку в плане таймера и в автопросмотре
  var WIPE_MS = 450;                       // переход «чернила света»
  var MORPH_MS = 550;                      // «волшебный переход»
  var PRESENTER = 'ashen-presenter';
  var EASE = 'cubic-bezier(.2,.7,.2,1)';

  var root = document.documentElement;
  var deckEl = document.getElementById('p1-deck');
  var reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var BASE_TITLE = document.title;

  function reduced() { return !!(reducedMQ && reducedMQ.matches); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mmss(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + pad(sec % 60); }
  function token(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function call(fn, ctx, args, what) {
    if (typeof fn !== 'function') return;
    try { fn.apply(ctx, args); } catch (err) { console.error('Слайд: ошибка в ' + what, err); }
  }
  function scale() { return parseFloat(root.style.getPropertyValue('--s')) || 1; }
  // Прямоугольник элемента в координатах сцены 1920×1080.
  function stageRect(e) {
    var r = e.getBoundingClientRect(), d = deckEl.getBoundingClientRect(), s = scale();
    return { x: (r.left - d.left) / s, y: (r.top - d.top) / s, w: r.width / s, h: r.height / s };
  }
  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [216, 179, 106];
    var v = parseInt(m[1], 16); return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  var fontsReady = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () {}, function () {});
  // Убираем слои прошлой версии разметки, если index.html ещё старый.
  ['p1-ash', 'p1-regent'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); });

  /* ---------- Сборка: очередь → слайды по порядку n, пропуски — заглушки */
  var byN = {};
  (window.DECK_QUEUE || []).forEach(function (def) {
    if (!def || !isFinite(def.n)) { console.warn('DECK_QUEUE: у слайда нет номера n', def); return; }
    var n = Math.round(def.n);
    if (byN[n]) { console.warn('DECK_QUEUE: слайд ' + n + ' зарегистрирован дважды — оставлен первый'); return; }
    byN[n] = def;
  });
  var lastN = TOTAL;
  Object.keys(byN).forEach(function (k) { lastN = Math.max(lastN, +k); });

  function stubDef(n) {
    return {
      n: n, sec: STUB_SEC, stub: true,
      html: '<section class="slide slide--stub" data-slide="' + n + '" data-title="Слайд ' + n + ' — в сборке">' +
        '<span class="stub__n">' + pad(n) + '</span><p class="title">Слайд ' + n + ' — в сборке</p>' +
        '<p class="cap">Часть презентации ещё не слита в main.</p><aside class="notes">Слайд ' + n + ' ещё в сборке.</aside></section>'
    };
  }
  // Фон слайда из data-bg: картинка или видео.
  function addBg(el) {
    var src = el.getAttribute('data-bg');
    if (!src) return;
    var video = /\.(mp4|webm|mov)(\?|$)/i.test(src), poster = el.getAttribute('data-bg-poster') || '';
    var layer = document.createElement('div');
    layer.className = 'slide__bg slide__bg--' + (el.getAttribute('data-bg-shade') || 'left');
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = video
      ? '<video data-src="' + esc(src) + '"' + (poster ? ' poster="' + esc(poster) + '"' : '') + ' muted loop playsinline preload="none"></video>' +
        (poster ? '<img class="print-poster" src="' + esc(poster) + '" alt="">' : '')
      : '<img src="' + esc(src) + '" alt="">';
    el.insertBefore(layer, el.firstChild);
  }
  // Ленивая загрузка: разметка ещё в <template> (инертна), поэтому src просто откладываем в data-lazy.
  function deferMedia(el) {
    el.querySelectorAll('img[src]').forEach(function (img) {
      if (img.getAttribute('loading') === 'eager') return;
      img.setAttribute('data-lazy', img.getAttribute('src')); img.removeAttribute('src');
    });
    el.querySelectorAll('video[poster]').forEach(function (v) { v.setAttribute('data-lazy-poster', v.getAttribute('poster')); v.removeAttribute('poster'); });
  }
  // data-roll: каждая цифра — барабан 0…9, сдвиг transform; остальные символы остаются как есть.
  function buildRoll(e) {
    var txt = e.textContent, html = '', k = 0;
    for (var i = 0; i < txt.length; i++) {
      var c = txt[i];
      if (/\d/.test(c)) {
        var strip = '';
        for (var d = 0; d <= 9; d++) strip += '<span>' + d + '</span>';
        html += '<span class="roll__col" aria-hidden="true"><span class="roll__strip" data-d="' + c + '" style="--rd:' + (k++ * 90) + 'ms">' + strip + '</span></span>';
      } else html += '<span aria-hidden="true">' + esc(c) + '</span>';
    }
    e.setAttribute('aria-label', txt.trim());
    e.innerHTML = html;
  }
  function build(def, n) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(def.html || '').trim();
    var el = tpl.content.querySelector('section.slide') || tpl.content.firstElementChild;
    if (!el) { console.warn('DECK_QUEUE: у слайда ' + n + ' пустая разметка — заглушка'); return build(stubDef(n), n); }
    el.classList.add('slide');
    var own = el.getAttribute('data-slide');
    if (own && +own !== n) console.warn('DECK_QUEUE: data-slide="' + own + '" у слайда n=' + n);
    el.setAttribute('data-slide', n);
    if (!el.getAttribute('data-title')) el.setAttribute('data-title', 'Слайд ' + n);
    addBg(el);
    deferMedia(el);
    el.querySelectorAll('[data-countup]').forEach(function (e) { e.setAttribute('data-final', e.textContent); });
    el.querySelectorAll('[data-roll]').forEach(buildRoll);
    return el;
  }

  var slides = [];
  for (var n = 1; n <= lastN; n++) {
    var def = byN[n] || stubDef(n);
    var el = build(def, n);
    deckEl.appendChild(el);
    slides.push({ n: n, sec: +def.sec > 0 ? +def.sec : STUB_SEC, el: el, def: def, shown: 0, max: 0, leaveT: 0, loaded: false });
  }
  var PLAN = slides.reduce(function (a, s) { return a + s.sec; }, 0);

  // Открыто из file:// — игра так не запустится (модули и камера), поэтому ссылки на неё ведут на локальный
  // сервер: python3 serve_game.py → http://127.0.0.1:8765/.
  if (location.protocol === 'file:') {
    deckEl.querySelectorAll('a[href^="../index.html"]').forEach(function (a) {
      a.setAttribute('href', 'http://127.0.0.1:8765/index.html' + a.getAttribute('href').slice('../index.html'.length));
    });
  }

  /* ---------- Слои сцены */
  function layer(cls, tag) { var e = document.createElement(tag || 'div'); e.className = cls; e.setAttribute('aria-hidden', 'true'); deckEl.appendChild(e); return e; }
  var inkEl = layer('ink');
  var fxCanvas = layer('fx', 'canvas'); fxCanvas.width = 1920; fxCanvas.height = 1080;
  var morphLayer = layer('morph-layer');
  var flashEl = layer('flash');
  var progressEl = layer('progress'); progressEl.innerHTML = '<i></i>';

  /* ---------- Плашка навигации: назад, номер, вперёд · «Содержание», «Смотреть», полный экран */
  var ICONS = {
    prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="7" height="6"/><rect x="13.5" y="4.5" width="7" height="6"/><rect x="3.5" y="13.5" width="7" height="6"/><rect x="13.5" y="13.5" width="7" height="6"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>'
  };
  var nav = document.createElement('nav');
  nav.className = 'navbar'; nav.setAttribute('aria-label', 'Навигация по презентации'); nav.setAttribute('data-interactive', '');
  nav.innerHTML =
    '<button type="button" data-nav="prev" aria-label="Назад">' + ICONS.prev + '</button>' +
    '<span class="navbar__count" aria-live="polite"></span>' +
    '<button type="button" data-nav="next" aria-label="Вперёд">' + ICONS.next + '</button>' +
    '<span class="navbar__sep"></span>' +
    '<button type="button" data-nav="overview" aria-label="Содержание (O)">' + ICONS.grid + '<span>Содержание</span></button>' +
    '<button type="button" data-action="autoplay" aria-pressed="false" aria-label="Смотреть: автопросмотр (A)">' + ICONS.play + '<span>Смотреть</span></button>' +
    '<button type="button" data-nav="full" aria-label="Во весь экран (F)">' + ICONS.full + '</button>';
  deckEl.appendChild(nav);
  var countEl = nav.querySelector('.navbar__count');
  var wakeT = 0;
  function wake() { nav.classList.add('is-awake'); clearTimeout(wakeT); wakeT = setTimeout(function () { nav.classList.remove('is-awake'); }, 2600); }
  document.addEventListener('mousemove', wake, { passive: true });

  /* ---------- «Содержание»: миниатюры всех слайдов в конечном состоянии */
  var ov = document.createElement('div');
  ov.className = 'overview'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Содержание'); ov.setAttribute('data-interactive', '');
  ov.innerHTML = '<div class="overview__head"><h2>Содержание</h2><p class="cap">Щелчок — перейти · Esc — закрыть</p></div><div class="overview__grid"></div>';
  deckEl.appendChild(ov);
  var ovGrid = ov.querySelector('.overview__grid');
  function thumbOf(s) {
    var c = s.el.cloneNode(true);
    c.classList.remove('is-active', 'is-leaving', 'is-dim', 'is-wipe', 'is-wipe-back', 'is-instant');
    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach(function (e) { e.removeAttribute('id'); });
    c.querySelectorAll('.notes, canvas, script').forEach(function (e) { e.remove(); });
    c.querySelectorAll('video').forEach(function (v) {
      var src = v.getAttribute('poster') || v.getAttribute('data-lazy-poster');
      if (src) { var img = document.createElement('img'); img.src = src; img.alt = ''; img.className = v.className; v.replaceWith(img); } else v.remove();
    });
    c.querySelectorAll('.print-poster').forEach(function (e) { e.remove(); });
    c.querySelectorAll('img[data-lazy]').forEach(function (img) { img.src = img.getAttribute('data-lazy'); img.removeAttribute('data-lazy'); });
    c.querySelectorAll('[data-step]').forEach(function (e) { e.classList.add('is-on'); });
    c.querySelectorAll('.reveal').forEach(function (e) { e.classList.add('is-shown'); });
    c.querySelectorAll('[data-countup]').forEach(function (e) { e.textContent = e.getAttribute('data-final'); });
    c.querySelectorAll('.roll__strip').forEach(function (st) { st.style.setProperty('--d', st.getAttribute('data-d')); });
    c.querySelectorAll('.is-forming, .is-morphing').forEach(function (e) { e.classList.remove('is-forming', 'is-morphing'); });
    c.querySelectorAll('a, button, [tabindex]').forEach(function (e) { e.setAttribute('tabindex', '-1'); });
    c.setAttribute('aria-hidden', 'true');
    return c;
  }
  function openOverview() {
    auto.stop();
    ovGrid.innerHTML = '';
    slides.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'thumb' + (i === cur ? ' is-current' : '');
      b.innerHTML = '<span class="thumb__box"></span><span class="thumb__cap"><b>' + pad(s.n) + '</b><span>' + esc(s.el.getAttribute('data-title')) + '</span></span>';
      b.querySelector('.thumb__box').appendChild(thumbOf(s));
      b.addEventListener('click', function () { closeOverview(); go(i, 'jump'); });
      ovGrid.appendChild(b);
    });
    ov.classList.add('is-on');
    var curBtn = ovGrid.children[cur]; if (curBtn) curBtn.focus();
  }
  function closeOverview() { ov.classList.remove('is-on'); ovGrid.innerHTML = ''; }
  function overviewOpen() { return ov.classList.contains('is-on'); }
  function overviewMove(dx) {
    var btns = [].slice.call(ovGrid.children), i = btns.indexOf(document.activeElement);
    if (i < 0) i = cur;
    i = clamp(i + dx, 0, btns.length - 1); btns[i].focus();
  }

  /* ---------- Служебные слои окна: чёрный экран, помощь, «поверните телефон» */
  function make(tag, cls, html) { var e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; document.body.appendChild(e); return e; }
  var blackout = make('div', 'blackout');
  var help = make('div', 'help',
    '<div class="help__box" role="dialog" aria-label="Клавиши презентации"><h2>Клавиши</h2><dl>' +
    '<dt><kbd><i class="arr"></i></kbd> <kbd>Пробел</kbd> <kbd>PgDn</kbd> <kbd>Enter</kbd></dt><dd>вперёд: сначала шаги слайда, потом следующий</dd>' +
    '<dt><kbd><i class="arr arr--back"></i></kbd> <kbd>PgUp</kbd> <kbd>Backspace</kbd></dt><dd>назад: предыдущий слайд целиком</dd>' +
    '<dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>первый и последний слайд</dd>' +
    '<dt><kbd>O</kbd></dt><dd>«Содержание»: все слайды миниатюрами</dd>' +
    '<dt><kbd>A</kbd></dt><dd>«Смотреть»: слайды листаются сами, любая клавиша — вручную</dd>' +
    '<dt><kbd>D</kbd></dt><dd>демонстрация на слайде, где она есть</dd>' +
    '<dt><kbd>F</kbd></dt><dd>полный экран</dd>' +
    '<dt><kbd>S</kbd> <kbd>R</kbd></dt><dd>окно докладчика: заметки, следующий слайд, таймер; R — сбросить таймер</dd>' +
    '<dt><kbd>B</kbd> <kbd>.</kbd></dt><dd>чёрный экран</dd>' +
    '<dt><kbd>?</kbd> <kbd>Esc</kbd></dt><dd>эта подсказка</dd>' +
    '</dl><p>Щелчок по левой пятой части экрана — назад, по правой — вперёд, на телефоне — свайп. Номер слайда — в адресе: #7. ' +
    'Печать (Ctrl+P) — по слайду на страницу, все шаги раскрыты.</p></div>');
  make('div', 'rotate',
    '<div class="rotate__box"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="22" width="36" height="22" rx="3"/>' +
    '<path d="M40 30v6"/><rect x="24" y="6" width="14" height="24" rx="2" stroke-dasharray="3 3" opacity=".55"/>' +
    '<path d="M48 12c5 3 8 8 8 14M56 26l-3.5-4M56 26l3-4.5"/></svg>' +
    '<p>Поверните телефон</p><p class="rotate__cap">Презентация в формате 16:9 — листайте свайпом</p></div>');
  var toastEl = make('div', 'toast');
  var sr = make('p', 'sr-only'); sr.setAttribute('aria-live', 'polite');
  var toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('is-on');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2600);
  }

  /* ---------- Масштаб сцены */
  function fit() { root.style.setProperty('--s', Math.min(window.innerWidth / 1920, window.innerHeight / 1080)); }

  /* ---------- Ленивая загрузка картинок и видео */
  function loadImages(s) {
    if (!s || s.loaded) return;
    s.loaded = true;
    s.el.querySelectorAll('img[data-lazy]').forEach(function (img) { img.setAttribute('src', img.getAttribute('data-lazy')); img.removeAttribute('data-lazy'); });
    s.el.querySelectorAll('video[data-lazy-poster]').forEach(function (v) { v.setAttribute('poster', v.getAttribute('data-lazy-poster')); v.removeAttribute('data-lazy-poster'); });
  }
  function loadAll() { slides.forEach(loadImages); }
  var idleLoad = 0;
  function scheduleIdleLoad() {
    var i = 0;
    clearInterval(idleLoad);
    idleLoad = setInterval(function () {
      while (i < slides.length && slides[i].loaded) i++;
      if (i >= slides.length) { clearInterval(idleLoad); return; }
      loadImages(slides[i]);
    }, 300);
  }
  function imagesReady() {
    loadAll();
    return Promise.all([].slice.call(deckEl.querySelectorAll('img')).map(function (img) {
      if (img.complete) return null;
      return new Promise(function (r) { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
    }));
  }
  var mediaReady = false;
  function setVideo(v, mode) {
    var src = v.getAttribute('data-src');
    if (mode === 'off') {
      try { v.pause(); v.currentTime = 0; } catch (e) { /* видео ещё не загружено */ }
      if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
      return;
    }
    if (v.getAttribute('src') !== src) { v.setAttribute('preload', 'auto'); v.setAttribute('src', src); }
    if (mode === 'play') { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    else { try { v.pause(); } catch (e) { /* ещё не загружено */ } }
  }
  function syncMedia() {
    slides.forEach(function (s, i) {
      var mode = i === cur ? (mediaReady ? 'play' : 'off') : (i === cur + 1 && mediaReady ? 'next' : 'off');
      s.el.querySelectorAll('video[data-src]').forEach(function (v) { setVideo(v, mode); });
    });
  }

  /* ---------- Шаги, лесенка, .reveal, загорание, счёт и барабан цифр */
  function stepNum(e) { return parseInt(e.getAttribute('data-step'), 10) || 0; }
  function maxStep(el) { var m = 0; el.querySelectorAll('[data-step]').forEach(function (e) { m = Math.max(m, stepNum(e)); }); return m; }
  function stepOf(e, slideEl) {
    for (var p = e; p && p !== slideEl; p = p.parentElement) if (p.hasAttribute && p.hasAttribute('data-step')) return stepNum(p);
    return 0;
  }
  function setSteps(s, k) {
    s.shown = k;
    s.el.querySelectorAll('[data-step]').forEach(function (e) { e.classList.toggle('is-on', stepNum(e) <= k); });
  }
  function stagger(s, k) {
    var j = 0;
    s.el.querySelectorAll('[data-step]').forEach(function (e) { if (stepNum(e) === k) e.style.setProperty('--sd', (j++ * 70) + 'ms'); });
  }
  function reveal(s, base, onlyStep) {
    var i = 0;
    s.el.querySelectorAll('.reveal').forEach(function (e) {
      var k = stepOf(e, s.el);
      if (e.classList.contains('is-shown') || k > s.shown || (onlyStep && k !== onlyStep)) return;
      e.style.setProperty('--rd', (base + i++ * 80) + 'ms');
      e.classList.add('is-shown');
    });
  }
  function unreveal(s) { s.el.querySelectorAll('.reveal.is-shown').forEach(function (e) { e.classList.remove('is-shown'); }); }
  function ignite(s) {
    s.el.querySelectorAll('[data-ignite]').forEach(function (e) {
      if (stepOf(e, s.el) > s.shown || e.classList.contains('is-lit')) return;
      e.style.setProperty('--ignite-w', Math.max(0, e.offsetWidth - 3) + 'px');
      e.classList.add('is-lit');
    });
  }
  function unlight(s) { s.el.querySelectorAll('[data-ignite].is-lit').forEach(function (e) { e.classList.remove('is-lit'); }); }
  // data-roll: барабаны в ноль без перехода, затем к своим цифрам (или сразу к ним — назад, по hash, в печати).
  function rollSet(s, onlyStep, final) {
    s.el.querySelectorAll('[data-roll]').forEach(function (e) {
      var k = stepOf(e, s.el);
      if (!final && (k > s.shown || (onlyStep !== undefined && k !== onlyStep))) return;
      e.querySelectorAll('.roll__strip').forEach(function (st) { st.style.setProperty('--d', st.getAttribute('data-d')); });
    });
  }
  function rollReset(s) { s.el.querySelectorAll('.roll__strip').forEach(function (st) { st.style.setProperty('--d', 0); }); }

  var NUM_RE = /(\d[\d    ]*\d|\d)([.,]\d+)?/;
  function countParts(e) {
    var fin = e.getAttribute('data-final') || '', m = NUM_RE.exec(fin);
    if (!m) return null;
    var grp = (/[    ]/.exec(m[1]) || [''])[0];
    var places = m[2] ? m[2].length - 1 : 0;
    var val = parseFloat(m[1].replace(/[^\d]/g, '') + (m[2] ? '.' + m[2].slice(1) : ''));
    var attr = e.getAttribute('data-countup');
    if (attr && isFinite(parseFloat(attr.replace(',', '.')))) val = parseFloat(attr.replace(',', '.'));
    return { pre: fin.slice(0, m.index), post: fin.slice(m.index + m[0].length), val: val, grp: grp, dec: m[2] ? m[2][0] : '', places: places,
      from: parseFloat(e.getAttribute('data-from')) || 0 };
  }
  function fmt(p, v) {
    var s = v.toFixed(p.places), parts = s.split('.'), int = parts[0];
    if (p.grp) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, p.grp);
    return p.pre + int + (p.places ? p.dec + parts[1] : '') + p.post;
  }
  function setText(e, text) {
    var w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), node, first = null;
    while ((node = w.nextNode())) { if (/\d/.test(node.nodeValue)) { first = node; break; } }
    if (!first || e.childNodes.length === 1) { if (e.textContent !== text) e.textContent = text; return; }
    var m = NUM_RE.exec(first.nodeValue), n2 = NUM_RE.exec(text);
    if (m && n2) first.nodeValue = first.nodeValue.slice(0, m.index) + n2[0] + first.nodeValue.slice(m.index + m[0].length);
  }
  function countFinal(s) { s.el.querySelectorAll('[data-countup]').forEach(function (e) { e.__id = (e.__id || 0) + 1; e.__cnt = 2; setText(e, e.getAttribute('data-final')); }); }
  function countReset(s) {
    s.el.querySelectorAll('[data-countup]').forEach(function (e) {
      e.__id = (e.__id || 0) + 1; e.__cnt = 0;
      var p = countParts(e); if (p) setText(e, fmt(p, p.from));
    });
  }
  function countUp(s, onlyStep) {
    s.el.querySelectorAll('[data-countup]').forEach(function (e) {
      var k = stepOf(e, s.el);
      if (k > s.shown || (onlyStep !== undefined && k !== onlyStep) || e.__cnt === 2) return;
      var p = countParts(e);
      if (!p || reduced()) { setText(e, e.getAttribute('data-final')); e.__cnt = 2; return; }
      var t0 = performance.now(), id = (e.__id = (e.__id || 0) + 1);
      e.__cnt = 1;
      (function tick(t) {
        if (e.__id !== id) return;
        var u = clamp((t - t0) / 600, 0, 1), v = p.from + (p.val - p.from) * (1 - Math.pow(1 - u, 3));
        setText(e, u < 1 ? fmt(p, v) : e.getAttribute('data-final'));
        if (u < 1) requestAnimationFrame(tick); else e.__cnt = 2;
      })(t0);
    });
  }

  /* ---------- Частицы (data-particles): canvas 2D 1920×1080, DPR 1, по реальным часам */
  var fx = (function () {
    var ctx = fxCanvas.getContext('2d'), W = 1920, H = 1080, raf = 0, sp = null, col = {};
    function colors() { col = { hi: rgb(token('--gold-hi')), b: rgb(token('--gold-b')), warm: rgb(token('--hand-right')) }; }
    function ease(u) { return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
    function frame() {
      raf = 0;
      ctx.clearRect(0, 0, W, H);
      if (!sp) return;
      var now = performance.now(), t = (now - sp.t0) / 1000, done = true, fade = 1;
      if (sp.fadeAt) { fade = clamp(1 - (now - sp.fadeAt) / 300, 0, 1); if (fade <= 0) { sp = null; return; } }
      ctx.globalCompositeOperation = 'lighter';
      var B = [[], [], []];
      for (var i = 0; i < sp.p.length; i++) {
        var p = sp.p[i], u = clamp((t - p.d) / p.T, 0, 1);
        if (u < 1) done = false;
        if (t < p.d) continue;
        var e = ease(u), a = 1 - e;
        var x = a * a * p.sx + 2 * a * e * p.cx + e * e * p.tx, y = a * a * p.sy + 2 * a * e * p.cy + e * e * p.ty;
        B[u >= 1 ? 0 : (u > .55 ? 1 : 2)].push(x, y, p.s);
      }
      var cs = [col.hi, col.b, col.warm], al = [.95, .85, .7];
      for (var k = 0; k < 3; k++) {
        var L = B[k]; if (!L.length) continue;
        ctx.fillStyle = 'rgba(' + cs[k].join(',') + ',' + (al[k] * fade).toFixed(3) + ')';
        for (var j = 0; j < L.length; j += 3) ctx.fillRect(L[j] - L[j + 2] / 2, L[j + 1] - L[j + 2] / 2, L[j + 2], L[j + 2]);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (done && !sp.arrived) { sp.arrived = true; if (sp.onArrive) sp.onArrive(); }
      raf = requestAnimationFrame(frame);
    }
    // Точки элемента: глифы (каждая буква на своём месте), SVG и сплошные .spk-solid — в маску, затем выборка.
    function sample(el, count) {
      return fontsReady.then(function () {
        var box = stageRect(el), pd = 40;
        var bx = Math.max(0, Math.floor(box.x - pd)), by = Math.max(0, Math.floor(box.y - pd));
        var bw = Math.min(W - bx, Math.ceil(box.w + pd * 2)), bh = Math.min(H - by, Math.ceil(box.h + pd * 2));
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var g = cv.getContext('2d'), d = deckEl.getBoundingClientRect(), s = scale(), range = document.createRange();
        g.fillStyle = '#fff';
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node;
        while ((node = walker.nextNode())) {
          var txt = node.nodeValue; if (!txt.trim()) continue;
          var cs = getComputedStyle(node.parentElement);
          g.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          var asc = g.measureText('Hg').fontBoundingBoxAscent || parseFloat(cs.fontSize) * .9, up = cs.textTransform === 'uppercase';
          for (var i = 0; i < txt.length; i++) {
            var ch = txt[i]; if (!ch.trim()) continue;
            range.setStart(node, i); range.setEnd(node, i + 1);
            var r = range.getBoundingClientRect(); if (!r.width) continue;
            g.fillText(up ? ch.toUpperCase() : ch, (r.left - d.left) / s, (r.top - d.top) / s + asc);
          }
        }
        el.querySelectorAll('.spk-solid').forEach(function (e) { var r = stageRect(e); g.fillRect(r.x, r.y, Math.max(2, r.w), Math.max(2, r.h)); });
        return Promise.all([].slice.call(el.querySelectorAll('svg')).map(function (svg) {
          return new Promise(function (res) {
            var r = stageRect(svg), img = new Image();
            var xml = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, '#fff');
            if (!/xmlns=/.test(xml)) xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
            img.onload = function () { g.drawImage(img, r.x, r.y, r.w, r.h); res(); };
            img.onerror = function () { res(); };
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
          });
        })).then(function () {
          var data = g.getImageData(bx, by, bw, bh).data, pts = [];
          for (var step = 2; step <= 7; step++) {
            pts = [];
            for (var y = 0; y < bh; y += step) for (var x = 0; x < bw; x += step) if (data[(y * bw + x) * 4 + 3] > 120) pts.push(bx + x, by + y);
            if (pts.length / 2 <= count * 3) break;
          }
          var n = pts.length / 2, idx = [], k;
          for (k = 0; k < n; k++) idx.push(k);
          for (k = n - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)), t = idx[k]; idx[k] = idx[j]; idx[j] = t; }
          var out = [];
          for (k = 0; k < Math.min(count, n); k++) out.push([pts[idx[k] * 2], pts[idx[k] * 2 + 1]]);
          return out;
        });
      });
    }
    function edges(i, tg) {
      var side = i % 4, sx, sy;
      if (side === 0) { sx = Math.random() * W; sy = -20; } else if (side === 1) { sx = W + 20; sy = Math.random() * H; }
      else if (side === 2) { sx = Math.random() * W; sy = H + 20; } else { sx = -20; sy = Math.random() * H; }
      var mx = (sx + tg[0]) / 2, my = (sy + tg[1]) / 2, dx = tg[0] - sx, dy = tg[1] - sy, sw = (Math.random() - .5) * .9;
      return [sx, sy, mx - dy * sw, my + dx * sw];
    }
    function fromRect(r) {
      return function () {
        var sx = r.x + Math.random() * r.w, sy = r.y + Math.random() * r.h, ang = Math.random() * Math.PI * 2, R = 120 + Math.random() * 260;
        return [sx, sy, sx + Math.cos(ang) * R, sy + Math.sin(ang) * R * .8];
      };
    }
    function run(targets, from, onArrive) {
      colors();
      var p = targets.map(function (tg, i) {
        var f = from(i, tg);
        return { sx: f[0], sy: f[1], cx: f[2], cy: f[3], tx: tg[0], ty: tg[1], d: Math.random() * .3, T: .8 + Math.random() * .3, s: 1.6 + Math.random() * 1.4 };
      });
      sp = { p: p, t0: performance.now(), onArrive: onArrive, arrived: false, fadeAt: 0 };
      if (!raf) raf = requestAnimationFrame(frame);
    }
    function fade() { if (sp) sp.fadeAt = performance.now(); }
    function stop() { sp = null; ctx.clearRect(0, 0, W, H); }
    return { sample: sample, run: run, fade: fade, stop: stop, edges: edges, fromRect: fromRect };
  })();

  var partRun = 0, partTimers = [];
  function particlesCancel() {
    partRun++; partTimers.forEach(clearTimeout); partTimers = []; fx.stop();
    deckEl.querySelectorAll('.is-forming').forEach(function (e) { e.classList.remove('is-forming'); });
  }
  // Собрать элементы слайда из частиц; .reveal остальных — после сборки.
  function particlesPlay(s) {
    var list = [].slice.call(s.el.querySelectorAll('[data-particles]')).filter(function (e) { return stepOf(e, s.el) <= s.shown; });
    if (!list.length) return false;
    var run = ++partRun;
    list.forEach(function (e) { e.classList.add('is-forming'); });
    var e = list[0], count = clamp(parseInt(e.getAttribute('data-particles'), 10) || 1400, 200, 1800);
    var fromSel = e.getAttribute('data-particles-from'), delay = parseInt(e.getAttribute('data-particles-delay'), 10) || 0;
    var pts = fx.sample(e, count);
    partTimers.push(setTimeout(function () {
      pts.then(function (targets) {
        if (run !== partRun) return;
        var src = fromSel && s.el.querySelector(fromSel);
        var from = src ? fx.fromRect(stageRect(src)) : fx.edges;
        if (targets.length < 100) { finish(); return; }
        fx.run(targets, from, finish);
      });
    }, delay));
    function finish() {
      if (run !== partRun) return;
      list.forEach(function (x) { x.classList.remove('is-forming'); });
      fx.fade();
      reveal(s, 60);
    }
    return true;
  }

  /* ---------- «Волшебный переход»: data-morph на уходящем и входящем слайде (FLIP, 550 мс) */
  var morphs = [];
  function morphFinishAll() {
    morphs.forEach(function (m) { m.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* уже завершена */ } }); m.end(); });
    morphs = [];
  }
  function ghostOf(e, r) {
    var g = e.cloneNode(true), cs = getComputedStyle(e);
    ['data-morph', 'id', 'data-step', 'data-particles'].forEach(function (a) { g.removeAttribute(a); });
    g.querySelectorAll('[id]').forEach(function (x) { x.removeAttribute('id'); });
    g.classList.remove('is-forming', 'reveal');
    g.classList.add('morph-ghost');
    ['font', 'color', 'letterSpacing', 'lineHeight', 'textTransform', 'textShadow', 'textAlign', 'whiteSpace'].forEach(function (k) { g.style[k] = cs[k]; });
    g.style.left = r.x + 'px'; g.style.top = r.y + 'px'; g.style.width = r.w + 'px'; g.style.height = r.h + 'px';
    return g;
  }
  function morph(prevS, s) {
    if (!deckEl.animate) return;
    prevS.el.querySelectorAll('[data-morph]').forEach(function (a) {
      var b = s.el.querySelector('[data-morph="' + a.getAttribute('data-morph') + '"]');
      if (!b) return;
      var r0 = stageRect(a), r1 = stageRect(b);
      if (!r0.w || !r1.w) return;
      var gA = ghostOf(a, r0), gB = ghostOf(b, r1);
      morphLayer.appendChild(gA); morphLayer.appendChild(gB);
      a.classList.add('is-morphing'); b.classList.add('is-morphing');
      var to = 'translate(' + (r1.x - r0.x) + 'px,' + (r1.y - r0.y) + 'px) scale(' + (r1.w / r0.w) + ',' + (r1.h / r0.h) + ')';
      var from = 'translate(' + (r0.x - r1.x) + 'px,' + (r0.y - r1.y) + 'px) scale(' + (r0.w / r1.w) + ',' + (r0.h / r1.h) + ')';
      var o = { duration: MORPH_MS, easing: EASE, fill: 'both' };
      var m = { anims: [
        gA.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: .35 }, { transform: to, opacity: 0 }], o),
        gB.animate([{ transform: from, opacity: 0 }, { opacity: 0, offset: .3 }, { transform: 'none', opacity: 1 }], o)
      ] };
      m.end = function () { gA.remove(); gB.remove(); a.classList.remove('is-morphing'); b.classList.remove('is-morphing'); };
      m.anims[1].onfinish = function () { m.end(); morphs = morphs.filter(function (x) { return x !== m; }); };
      morphs.push(m);
    });
  }

  /* ---------- Переход «чернила света» */
  function inkWipe(s, back) {
    s.el.classList.remove('is-wipe', 'is-wipe-back');
    void s.el.offsetWidth;
    s.el.classList.add(back ? 'is-wipe-back' : 'is-wipe');
    if (inkEl.animate) inkEl.animate([
      { transform: 'translateX(' + (back ? 1930 : -10) + 'px)', opacity: 0 },
      { opacity: 1, offset: .12 }, { opacity: 1, offset: .85 },
      { transform: 'translateX(' + (back ? -10 : 1930) + 'px)', opacity: 0 }
    ], { duration: WIPE_MS, easing: EASE });
  }

  /* ---------- Навигация */
  var cur = -1;
  var presenter = null;
  function info(s) {
    var t = s.el.querySelector('.title, .thesis');
    return (t ? t.textContent : s.el.getAttribute('data-title') || '').replace(/\s+/g, ' ').trim();
  }
  function setHash(n) {
    if (location.hash === '#' + n) return;
    try { history.replaceState(null, '', '#' + n); } catch (e) { location.replace('#' + n); }
  }
  // Прогресс: доля пройденного с учётом шагов текущего слайда.
  function progress() {
    var s = slides[cur]; if (!s) return;
    var p = (cur + (s.max ? s.shown / (s.max + 1) : 0)) / Math.max(1, slides.length - 1);
    progressEl.firstChild.style.setProperty('--p', clamp(p, 0, 1).toFixed(4));
    countEl.textContent = pad(s.n) + ' / ' + pad(slides.length);
    nav.querySelector('[data-nav="prev"]').disabled = cur === 0;
    nav.querySelector('[data-nav="next"]').disabled = cur === slides.length - 1 && s.shown >= s.max;
  }
  // mode: 'fwd' — вперёд на соседний; 'back' — назад; 'jump' — hash, Home, End, «Содержание», первый показ.
  function go(i, mode) {
    i = clamp(i, 0, slides.length - 1);
    if (i === cur) return;
    var prev = slides[cur] || null, s = slides[i];
    var dir = mode === 'fwd' ? 1 : -1;
    var animate = !reduced() && !!prev && (mode === 'fwd' || mode === 'back');

    morphFinishAll();
    particlesCancel();
    slides.forEach(function (x) { if (x !== s && x !== prev) x.el.classList.remove('is-leaving', 'is-dim', 'is-wipe', 'is-wipe-back'); });

    clearTimeout(s.leaveT);
    loadImages(s); loadImages(slides[i + 1]);
    s.el.classList.remove('is-leaving', 'is-dim');
    s.el.classList.add('is-instant');
    s.max = maxStep(s.el);
    unlight(s); unreveal(s);
    setSteps(s, dir > 0 ? 0 : s.max);
    var fresh = dir > 0 && !reduced();
    if (fresh) { countReset(s); rollReset(s); } else { countFinal(s); rollSet(s, undefined, true); }
    void s.el.offsetWidth;
    if (animate) morph(prev, s);

    if (prev) {
      call(prev.def.leave, prev.def, [prev.el], 'leave');
      prev.el.classList.remove('is-active', 'is-wipe', 'is-wipe-back');
      prev.el.querySelectorAll('[data-demo].is-playing').forEach(function (e) { e.classList.remove('is-playing'); });
      if (animate) {
        prev.el.classList.add('is-leaving', 'is-dim');
        clearTimeout(prev.leaveT);
        prev.leaveT = setTimeout(function () {
          prev.el.classList.remove('is-leaving', 'is-dim');
          if (slides[cur] !== prev) { unlight(prev); unreveal(prev); }
        }, WIPE_MS + 30);
      } else { unlight(prev); unreveal(prev); }
    }
    if (fresh) s.el.classList.remove('is-instant');
    s.el.classList.add('is-active');
    if (animate) inkWipe(s, mode === 'back');
    cur = i;

    // Частицы — при входе вперёд (и при первом показе титула); остальной .reveal — после сборки.
    if (!(fresh && particlesPlay(s))) reveal(s, fresh ? 150 : 0);
    ignite(s);
    if (fresh) { countUp(s, 0); requestAnimationFrame(function () { if (slides[cur] === s) rollSet(s, 0); }); }
    syncMedia();
    call(s.def.enter, s.def, [s.el, dir, { prev: prev ? prev.n : null, jump: mode === 'jump' }], 'enter');

    setHash(s.n);
    document.title = s.n === 1 ? BASE_TITLE : 'ASHEN OATH — ' + s.el.getAttribute('data-title');
    sr.textContent = 'Слайд ' + s.n + ' из ' + slides.length + ': ' + s.el.getAttribute('data-title');
    progress();
    document.dispatchEvent(new CustomEvent('deck:change', { detail: { n: s.n, prev: prev ? prev.n : null } }));
    renderPresenter();
    if (auto.on) auto.schedule();
  }
  function next() {
    var s = slides[cur];
    if (s && s.shown < s.max) {
      setSteps(s, s.shown + 1);
      stagger(s, s.shown);
      ignite(s);
      reveal(s, 120, s.shown);
      countUp(s, s.shown);
      rollSet(s, s.shown);
      call(s.def.step, s.def, [s.el, s.shown], 'step');
      progress();
      renderPresenter();
      if (auto.on) auto.schedule();
      return;
    }
    if (cur < slides.length - 1) go(cur + 1, 'fwd');
  }
  function prev() { if (cur > 0) go(cur - 1, 'back'); }
  function fromHash() {
    var k = parseInt((location.hash || '').replace('#', ''), 10);
    return isFinite(k) ? clamp(k, 1, slides.length) - 1 : 0;
  }

  /* ---------- Демонстрации: data-demo="действие" → хук demo(el, действие) */
  function demo(action, btn) {
    var s = slides[cur]; if (!s) return;
    if (!action) { var first = s.el.querySelector('[data-demo]'); if (!first) return; action = first.getAttribute('data-demo'); btn = first; }
    if (btn) { s.el.querySelectorAll('[data-demo].is-playing').forEach(function (e) { e.classList.remove('is-playing'); }); btn.classList.add('is-playing'); }
    call(s.def.demo, s.def, [s.el, action], 'demo');
    document.dispatchEvent(new CustomEvent('deck:demo', { detail: { n: s.n, action: action } }));
  }

  /* ---------- Автопросмотр («Смотреть», A): шаги и слайды по времени из sec, любая клавиша или касание — вручную */
  var auto = {
    on: false, t: 0,
    start: function () {
      if (auto.on) return;
      auto.on = true;
      deckEl.querySelectorAll('[data-action="autoplay"]').forEach(function (b) { b.setAttribute('aria-pressed', 'true'); });
      toast('Автопросмотр: любая клавиша или касание — листать самим');
      auto.schedule();
    },
    stop: function () {
      if (!auto.on) return;
      auto.on = false; clearTimeout(auto.t);
      deckEl.querySelectorAll('[data-action="autoplay"]').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    },
    schedule: function () {
      clearTimeout(auto.t);
      var s = slides[cur];
      if (!s) return;
      if (cur === slides.length - 1 && s.shown >= s.max) { auto.t = setTimeout(auto.stop, s.sec * 1000); return; }
      auto.t = setTimeout(function () { if (auto.on) next(); }, Math.max(1500, s.sec * 1000 / (s.max + 1)));
    }
  };

  /* ---------- Полный экран, чёрный экран, помощь */
  function fullscreen() {
    if (!document.fullscreenElement) { if (root.requestFullscreen) root.requestFullscreen().catch(function () {}); }
    else if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
  }
  function toggleBlack(on) { blackout.classList.toggle('is-on', on); renderPresenter(); }
  function toggleHelp(on) { help.classList.toggle('is-on', on); }

  /* ---------- Клавиши: по e.code, в обоих окнах — главном и докладчика */
  var NEXT = { ArrowRight: 1, ArrowDown: 1, Space: 1, PageDown: 1, Enter: 1, NumpadEnter: 1 };
  var PREV = { ArrowLeft: 1, ArrowUp: 1, PageUp: 1, Backspace: 1 };
  function onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target, c = e.code;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (overviewOpen()) {
      if (c === 'Escape' || c === 'KeyO') { closeOverview(); e.preventDefault(); }
      else if (c === 'ArrowRight') { overviewMove(1); e.preventDefault(); }
      else if (c === 'ArrowLeft') { overviewMove(-1); e.preventDefault(); }
      else if (c === 'ArrowDown') { overviewMove(4); e.preventDefault(); }
      else if (c === 'ArrowUp') { overviewMove(-4); e.preventDefault(); }
      return;   // Enter и пробел нажимают сфокусированную миниатюру
    }
    if (c === 'KeyA' && !e.repeat) { if (auto.on) auto.stop(); else auto.start(); e.preventDefault(); return; }
    if (auto.on && c !== 'ShiftLeft' && c !== 'ShiftRight') auto.stop();
    // Enter и пробел на ссылке или кнопке работают как обычно, а не листают.
    if (t && t.closest && t.closest('a, button') && (c === 'Enter' || c === 'NumpadEnter' || c === 'Space')) return;
    if (help.classList.contains('is-on') && (c === 'Escape' || (c === 'Slash' && e.shiftKey))) { toggleHelp(false); e.preventDefault(); return; }
    if (NEXT[c]) { next(); e.preventDefault(); }
    else if (PREV[c]) { prev(); e.preventDefault(); }
    else if (c === 'Home') { go(0, 'jump'); e.preventDefault(); }
    else if (c === 'End') { go(slides.length - 1, 'jump'); e.preventDefault(); }
    else if (e.repeat) return;
    else if (c === 'KeyO') { openOverview(); e.preventDefault(); }
    else if (c === 'KeyD') { demo(); e.preventDefault(); }
    else if (c === 'KeyF') { fullscreen(); e.preventDefault(); }
    else if (c === 'KeyS') { openPresenter(); e.preventDefault(); }
    else if (c === 'KeyR') { resetTimer(); }
    else if (c === 'KeyB' || c === 'Period' || c === 'NumpadDecimal') { toggleBlack(!blackout.classList.contains('is-on')); e.preventDefault(); }
    else if (c === 'Slash' && e.shiftKey) { toggleHelp(!help.classList.contains('is-on')); e.preventDefault(); }
    else if (c === 'Escape') { if (blackout.classList.contains('is-on')) toggleBlack(false); }
  }

  /* ---------- Окно докладчика (S): рисуется из главного окна, работает и из file:// */
  var timer = { t0: 0, tick: 0 };
  function resetTimer() { timer.t0 = Date.now(); renderPresenter(); }
  var ARROW = token('--arr-mask') || 'none';
  function plural(k, one, few, many) { var m10 = k % 10, m100 = k % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; }
  function presenterHTML() {
    var vars = ['--ink', '--coal', '--coal-deep', '--line', '--bronze', '--gold', '--gold-b', '--gold-hi', '--parch', '--text', '--muted', '--ember', '--ok']
      .map(function (v) { return v + ':' + token(v); }).join(';');
    var fonts = new URL('fonts/fonts.css', location.href).href;
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Докладчик — ASHEN OATH</title>' +
      '<link rel="stylesheet" href="' + esc(fonts) + '"><style>' +
      ':root{' + vars + '}*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--ink);color:var(--text);' +
      'font-family:"Alegreya Sans","Segoe UI",system-ui,Arial,sans-serif}' +
      'body{display:grid;grid-template-columns:1fr 340px;grid-template-rows:auto 1fr auto;gap:18px 28px;padding:22px 28px}' +
      '.top{grid-column:1/3;display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:12px}' +
      '.n{font-family:Cinzel,Forum,Georgia,serif;font-size:30px;color:var(--gold-b);letter-spacing:.06em}' +
      '.k{font-family:Forum,Georgia,serif;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-b)}' +
      '.clock{font-family:Cinzel,Forum,Georgia,serif;font-size:26px;color:var(--muted)}' +
      '.main{min-height:0;display:flex;flex-direction:column;gap:14px;overflow:auto}' +
      '.th{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;font-size:36px;line-height:1.12;color:var(--parch)}' +
      '.st{font-size:18px;color:var(--gold-hi)}' +
      '.notes{font-size:26px;line-height:1.45;color:var(--text);max-width:62ch}' +
      '.side{display:flex;flex-direction:column;gap:18px}' +
      '.box{border:1px solid var(--line);background:var(--coal);padding:14px 16px}' +
      '.el{font-family:Cinzel,Forum,Georgia,serif;font-size:58px;line-height:1;color:var(--ok)}.el.late{color:var(--ember)}' +
      '.row{font-size:17px;color:var(--muted);margin-top:8px}.row b{color:var(--text);font-weight:500}' +
      '.nx{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;font-size:24px;line-height:1.15;color:var(--parch);margin-top:6px}' +
      'button{font:inherit;font-size:17px;color:var(--text);background:var(--coal-deep);border:1px solid var(--line);padding:6px 14px;cursor:pointer}' +
      '.btns{grid-column:1/3;display:flex;gap:10px;align-items:center;color:var(--muted);font-size:15px}' +
      '.arr{display:inline-block;width:.9em;height:.55em;background:currentColor;-webkit-mask:' + ARROW + ' center/contain no-repeat;mask:' + ARROW + ' center/contain no-repeat}' +
      '.arr--back{transform:scaleX(-1)}' +
      '</style></head><body>' +
      '<div class="top"><span><span class="n" id="n"></span> <span class="k" id="state"></span></span><span class="clock" id="clock"></span></div>' +
      '<div class="main"><p class="k">Сейчас</p><div class="th" id="th"></div><div class="st" id="st"></div><div class="notes" id="notes"></div></div>' +
      '<div class="side"><div class="box"><p class="k">Время</p><div class="el" id="el">0:00</div>' +
      '<div class="row">План доклада: <b id="plan"></b></div><div class="row">К концу слайда по плану: <b id="due"></b></div>' +
      '<div class="row">На этом слайде: <b id="sec"></b></div></div>' +
      '<div class="box"><p class="k">Дальше</p><div class="nx" id="nx"></div><div class="row" id="nxs"></div></div></div>' +
      '<div class="btns"><button id="b-prev"><i class="arr arr--back"></i> Назад</button><button id="b-next">Вперёд <i class="arr"></i></button><button id="b-reset">Сбросить таймер (R)</button>' +
      '<span>Клавиши работают и в этом окне.</span></div></body></html>';
  }
  function openPresenter() {
    var w = null;
    try { w = window.open('', PRESENTER, 'width=1100,height=720'); } catch (e) { w = null; }
    if (!w) { toast('Окно докладчика заблокировано: разрешите всплывающие окна для этой страницы'); return; }
    try {
      w.document.open(); w.document.write(presenterHTML()); w.document.close();
    } catch (e) { toast('Окно докладчика не открылось'); return; }
    presenter = w;
    var d = w.document;
    d.addEventListener('keydown', onKey);
    d.getElementById('b-prev').addEventListener('click', prev);
    d.getElementById('b-next').addEventListener('click', next);
    d.getElementById('b-reset').addEventListener('click', resetTimer);
    if (!timer.t0) timer.t0 = Date.now();
    clearInterval(timer.tick);
    timer.tick = setInterval(renderPresenter, 500);
    renderPresenter();
    try { w.focus(); } catch (e) { /* фокус может запретить браузер */ }
  }
  function renderPresenter() {
    if (!presenter) return;
    if (presenter.closed) { presenter = null; clearInterval(timer.tick); return; }
    var d = presenter.document, s = slides[cur];
    if (!s || !d.getElementById('n')) return;
    function set(id, v, html) { var e = d.getElementById(id); if (e) e[html ? 'innerHTML' : 'textContent'] = v; }
    var elapsed = timer.t0 ? (Date.now() - timer.t0) / 1000 : 0;
    var due = 0; for (var i = 0; i <= cur; i++) due += slides[i].sec;
    var notes = s.el.querySelector('.notes');
    set('n', pad(s.n) + ' / ' + pad(slides.length));
    set('state', blackout.classList.contains('is-on') ? '· чёрный экран' : auto.on ? '· автопросмотр' : '');
    set('clock', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    set('th', esc(info(s)), true);
    set('st', s.max ? 'Шаг ' + s.shown + ' из ' + s.max : '');
    set('notes', notes ? notes.innerHTML : '<span style="color:var(--muted)">Заметок нет.</span>', true);
    set('el', mmss(elapsed));
    var el = d.getElementById('el'); if (el) el.className = 'el' + (elapsed > due ? ' late' : '');
    set('plan', mmss(PLAN));
    set('due', mmss(due));
    set('sec', mmss(s.sec));
    set('nx', esc(slides[cur + 1] ? pad(slides[cur + 1].n) + ' · ' + info(slides[cur + 1]) : 'Конец доклада'), true);
    set('nxs', s.shown < s.max ? 'Сначала ещё ' + (s.max - s.shown) + ' ' + plural(s.max - s.shown, 'шаг', 'шага', 'шагов') + ' на этом слайде' : '');
  }

  /* ---------- Печать: все шаги раскрыты, цифры горят и досчитаны, потом — как было */
  var printed = false;
  function beforePrint() {
    if (printed) return; printed = true;
    loadAll(); morphFinishAll(); particlesCancel(); closeOverview();
    slides.forEach(function (s) {
      s.el.classList.add('is-instant');
      s.el.querySelectorAll('[data-step]').forEach(function (e) { e.classList.add('is-on'); });
      s.el.querySelectorAll('[data-ignite]').forEach(function (e) { e.classList.add('is-lit'); });
      s.el.querySelectorAll('.reveal').forEach(function (e) { e.classList.add('is-shown'); });
      countFinal(s); rollSet(s, undefined, true);
    });
  }
  function afterPrint() {
    if (!printed) return; printed = false;
    slides.forEach(function (s, i) {
      setSteps(s, s.shown);
      if (i === cur) return;
      s.el.classList.remove('is-instant');
      unlight(s); unreveal(s);
    });
  }
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  if (window.matchMedia) {
    var pm = window.matchMedia('print');
    var onPm = function (e) { if (e.matches) beforePrint(); else afterPrint(); };
    if (pm.addEventListener) pm.addEventListener('change', onPm); else if (pm.addListener) pm.addListener(onPm);
  }

  /* ---------- Мышь и касания */
  var down = null;
  document.addEventListener('pointerdown', function (e) {
    down = { x: e.clientX, y: e.clientY };
    if (auto.on && !(e.target.closest && e.target.closest('[data-action="autoplay"]'))) auto.stop();
    if (e.pointerType !== 'mouse') wake();
  }, true);
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    var moved = down && Math.max(Math.abs(e.clientX - down.x), Math.abs(e.clientY - down.y)) > 6;
    down = null;
    var t = e.target;
    var act = t.closest && t.closest('[data-action="autoplay"]');
    if (act) { e.preventDefault(); if (auto.on) auto.stop(); else auto.start(); return; }
    var nb = t.closest && t.closest('[data-nav]');
    if (nb) {
      var k = nb.getAttribute('data-nav');
      if (k === 'prev') prev(); else if (k === 'next') next(); else if (k === 'overview') openOverview(); else if (k === 'full') fullscreen();
      return;
    }
    var db = t.closest && t.closest('[data-demo]');
    if (db && slides[cur] && slides[cur].el.contains(db)) { demo(db.getAttribute('data-demo'), db); return; }
    if (moved) return;
    if (overviewOpen()) { if (t === ov || t.classList.contains('overview__grid')) closeOverview(); return; }
    if (t.closest && t.closest('a, button, input, select, textarea, label, video, [data-interactive], .help__box')) return;
    if (help.classList.contains('is-on')) { toggleHelp(false); return; }
    var x = e.clientX / window.innerWidth;
    if (x < 0.2) prev(); else if (x > 0.8) next();
  });
  var tx = null, ty = null;
  document.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (tx === null || overviewOpen()) { tx = null; return; }
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = ty = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) { auto.stop(); if (dx < 0) next(); else prev(); }
  });

  /* ---------- Старт */
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', function () { var i = fromHash(); if (i !== cur) go(i, 'jump'); });
  window.addEventListener('beforeunload', function () { if (presenter && !presenter.closed) { try { presenter.close(); } catch (e) { /* окно уже закрыто */ } } });
  fit();
  // Открыли с первого слайда — титул собирается из частиц, как при входе вперёд; с любого другого — сразу целиком.
  var first = fromHash();
  go(first, first === 0 ? 'fwd' : 'jump');
  wake();
  // Видео и остальные картинки — после того как первый экран загружен: титул появляется быстрее.
  function afterLoad() { mediaReady = true; syncMedia(); setTimeout(scheduleIdleLoad, 1500); }
  if (document.readyState === 'complete') afterLoad(); else window.addEventListener('load', afterLoad, { once: true });

  // API: переход, готовность к печати (tools/pitch_pdf.mjs), демонстрация. hit — совместимость: вздрагивание и вспышка.
  window.DECK = {
    go: function (n) { go(clamp(n, 1, slides.length) - 1, 'jump'); },
    ready: function () { return fontsReady.then(imagesReady).then(function () { return slides.length; }); },
    hit: function (pct, opt) {
      opt = opt || {};
      if (reduced() || !deckEl.animate) return;
      if (opt.shake !== false) deckEl.animate([{ translate: '0 0' }, { translate: '-6px 2px' }, { translate: '6px -2px' }, { translate: '-4px 1px' }, { translate: '3px -1px' }, { translate: '0 0' }], { duration: 250 });
      if (opt.flash !== false) flashEl.animate([{ opacity: 0 }, { opacity: .55, offset: .3 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
    },
    demo: function (action) { demo(action); },
    get n() { return slides[cur] ? slides[cur].n : 0; },
    get total() { return slides.length; }
  };
})();
