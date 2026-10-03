/* ASHEN OATH — движок презентации.
 *
 * Слайды регистрируются обычным скриптом (без модулей и fetch, работает из file://):
 *   (window.DECK_QUEUE = window.DECK_QUEUE || []).push({
 *     n: 7, sec: 45,
 *     html: `<section class="slide" data-slide="7" data-title="…">… <aside class="notes">…</aside></section>`,
 *     enter(el, dir, info) {}, leave(el) {}, step(el, k) {}
 *   });
 * Хуки необязательны. dir = 1 — вход вперёд с предыдущего слайда (шаги скрыты, можно анимировать);
 * dir = -1 — вход назад, переход по hash, Home/End: слайд показан целиком, сразу конечное состояние.
 * info = { prev, jump }. После каждой смены на document приходит событие deck:change { n, prev }.
 *
 * Общий договор разметки (для всех частей):
 *   data-step="1"…        — шаги; элементы одного шага раскрываются «лесенкой» (по 70 мс);
 *   .reveal               — проявляется при входе вперёд лесенкой (150 мс + 80 мс на элемент), внутри шага — с шагом;
 *   data-morph="ключ"     — «волшебный переход»: элемент с тем же ключом на соседнем слайде перелетает со старого
 *                           места и размера на новое (550 мс), остальное меняется переходом «чернила света»;
 *   data-countup          — число в тексте элемента считается от 0 (или data-from) до себя за 600 мс, когда видно;
 *                           data-countup="1050" — явное значение, подпись и единицы вокруг числа сохраняются;
 *   data-bg="путь.jpg|mp4" на <section> — фон слайда (видео — с data-bg-poster); data-bg-shade="left|bottom|full|none";
 *   data-depth="14"       — лёгкий параллакс слоя от мыши (на тач-устройствах и с «уменьшенным движением» нет);
 *   data-sparks           — (слайды 1 и 13) текст собирается из искр;
 *   data-action="autoplay"— кнопка автопросмотра; .num[data-ignite] — цифра «загорается руной».
 *   window.DECK.hit(pct, { shake, flash }) — полоса Регента теряет pct %, «−pct %», вздрагивание и вспышка.
 * Картинки слайдов грузятся лениво: активный и следующий сразу, остальные — когда страница освободится.
 *
 * Клавиши (по e.code — работают и в русской раскладке): → пробел PageDown Enter — вперёд;
 * ← PageUp Backspace — назад; Home/End; F — полный экран; A — автопросмотр; S — окно докладчика;
 * B и «.» — чёрный экран; ? — помощь. Номер слайда — в hash (#7). Щелчок по левой пятой части экрана — назад,
 * по правой — вперёд; на телефоне — свайп. */
(function () {
  'use strict';

  var TOTAL = 13;          // слайдов в докладе; недостающие показываются заглушкой «в сборке»
  var STUB_SEC = 40;       // время на слайд-заглушку в плане таймера и в автопросмотре
  // Разделы доклада по порядку сборки: подпись на заглушке, пока часть не слита.
  var SECTION = { 7: 'Как работает', 8: 'Проверено', 9: 'После отбора в финал', 10: 'После отбора в финал',
    11: 'После отбора в финал', 12: 'Кому и что дальше' };
  var WIPE_MS = 500;       // переход «чернила света»
  var MORPH_MS = 550;      // «волшебный переход»
  var PRESENTER = 'ashen-presenter';
  var EASE = 'cubic-bezier(.2,.7,.2,1)';

  var root = document.documentElement;
  var deckEl = document.getElementById('p1-deck');
  var ashCanvas = document.getElementById('p1-ash');
  var regentEl = document.getElementById('p1-regent');
  var reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var fineMQ = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
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
  var fontsReady = (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
    .then(function () {}, function () {});

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
        '<span class="stub__n">' + pad(n) + '</span>' +
        '<p class="thesis">Слайд ' + n + ' — в сборке</p>' +
        '<p class="cap">' + (SECTION[n] ? 'Раздел «' + SECTION[n] + '». ' : '') + 'Часть презентации ещё не слита в main.</p>' +
        '<aside class="notes">Слайд ' + n + ' ещё в сборке.</aside></section>'
    };
  }
  // Фон слайда из data-bg: картинка или видео (видео — по общим правилам: src только у активного и следующего).
  function addBg(el) {
    var src = el.getAttribute('data-bg');
    if (!src) return;
    var video = /\.(mp4|webm|mov)(\?|$)/i.test(src), poster = el.getAttribute('data-bg-poster') || '';
    var layer = document.createElement('div');
    layer.className = 'slide__bg slide__bg--' + (el.getAttribute('data-bg-shade') || 'left');
    layer.setAttribute('aria-hidden', 'true');
    if (el.hasAttribute('data-bg-depth')) layer.setAttribute('data-depth', el.getAttribute('data-bg-depth'));
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
    el.querySelectorAll('video[poster]').forEach(function (v) {
      v.setAttribute('data-lazy-poster', v.getAttribute('poster')); v.removeAttribute('poster');
    });
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
    el.querySelectorAll('[data-depth]').forEach(function (e) { e.style.setProperty('--depth', (parseFloat(e.getAttribute('data-depth')) || 0) + 'px'); });
    el.querySelectorAll('[data-countup]').forEach(function (e) { e.setAttribute('data-final', e.textContent); });
    return el;
  }

  var slides = [];
  for (var n = 1; n <= lastN; n++) {
    var def = byN[n] || stubDef(n);
    var el = build(def, n);
    deckEl.insertBefore(el, ashCanvas);
    slides.push({ n: n, sec: +def.sec > 0 ? +def.sec : STUB_SEC, el: el, def: def, shown: 0, max: 0, leaveT: 0, loaded: false });
  }
  var PLAN = slides.reduce(function (a, s) { return a + s.sec; }, 0);
  var LAST = slides.length;

  // Открыто из file:// — игра так не запустится (модули и камера), поэтому ссылки на неё ведут на локальный
  // сервер: python3 serve_game.py → http://127.0.0.1:8765/.
  if (location.protocol === 'file:') {
    deckEl.querySelectorAll('a[href^="../index.html"]').forEach(function (a) {
      a.setAttribute('href', 'http://127.0.0.1:8765/index.html' + a.getAttribute('href').slice('../index.html'.length));
    });
  }

  /* ---------- Слои сцены: «чернила света», призраки переходов, вспышка, цифры урона */
  function layer(cls, parent) { var e = document.createElement('div'); e.className = cls; e.setAttribute('aria-hidden', 'true'); (parent || deckEl).appendChild(e); return e; }
  var inkEl = layer('ink');
  var morphLayer = layer('morph-layer');
  var flashEl = layer('flash');

  /* ---------- Служебные слои окна: чёрный экран, помощь, подсказка, автопросмотр, «поверните телефон» */
  function make(tag, cls, html) { var e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; document.body.appendChild(e); return e; }
  var PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
  var blackout = make('div', 'blackout');
  var help = make('div', 'help',
    '<div class="help__box" role="dialog" aria-label="Клавиши презентации"><h2>Клавиши</h2><dl>' +
    '<dt><kbd><i class="arr"></i></kbd> <kbd>Пробел</kbd> <kbd>PgDn</kbd> <kbd>Enter</kbd></dt><dd>вперёд: сначала шаги слайда, потом следующий</dd>' +
    '<dt><kbd><i class="arr arr--back"></i></kbd> <kbd>PgUp</kbd> <kbd>Backspace</kbd></dt><dd>назад: предыдущий слайд целиком</dd>' +
    '<dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>первый и последний слайд</dd>' +
    '<dt><kbd>F</kbd></dt><dd>полный экран</dd>' +
    '<dt><kbd>A</kbd></dt><dd>автопросмотр: слайды листаются сами, любая клавиша — вручную</dd>' +
    '<dt><kbd>S</kbd></dt><dd>окно докладчика: заметки, следующий слайд, таймер</dd>' +
    '<dt><kbd>R</kbd></dt><dd>сбросить таймер докладчика</dd>' +
    '<dt><kbd>B</kbd> <kbd>.</kbd></dt><dd>чёрный экран</dd>' +
    '<dt><kbd>?</kbd> <kbd>Esc</kbd></dt><dd>эта подсказка</dd>' +
    '</dl><p>Щелчок по левой пятой части экрана — назад, по правой — вперёд, на телефоне — свайп. Номер слайда — в адресе: #7. ' +
    'Печать (Ctrl+P) — по слайду на страницу, все шаги раскрыты.</p></div>');
  var hintEl = make('div', 'hint', '<i class="arr"></i> листать · клик · свайп · F — во весь экран');
  var autoEl = make('div', 'autopill', PLAY + '<span>Автопросмотр · любая клавиша или касание — листать самим</span>');
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

  /* ---------- Масштаб сцены: слайд 16:9 вписан в окно целиком, без обрезки */
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
    // Когда титул показан и страница освободилась — по слайду каждые 300 мс, чтобы печать и переходы были готовы.
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
  // Видео: src только у активного (играет) и следующего (подгружается) слайда; остальные — пауза, в начало, без src.
  var mediaReady = false;
  function setVideo(v, mode) {
    var src = v.getAttribute('data-src');
    if (mode === 'off') {
      try { v.pause(); v.currentTime = 0; } catch (e) { /* видео ещё не загружено */ }
      if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
      return;
    }
    if (v.getAttribute('src') !== src) { v.setAttribute('preload', mode === 'play' ? 'auto' : 'auto'); v.setAttribute('src', src); }
    if (mode === 'play') { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    else { try { v.pause(); } catch (e) { /* ещё не загружено */ } }
  }
  function syncMedia() {
    slides.forEach(function (s, i) {
      var mode = i === cur ? 'play' : (i === cur + 1 && mediaReady ? 'next' : 'off');
      if (i === cur && !mediaReady) mode = 'off';
      s.el.querySelectorAll('video[data-src]').forEach(function (v) { setVideo(v, mode); });
    });
  }

  /* ---------- Шаги, «лесенка», .reveal, загорание и счёт цифр */
  function maxStep(el) {
    var m = 0;
    el.querySelectorAll('[data-step]').forEach(function (e) { var k = parseInt(e.getAttribute('data-step'), 10); if (k > m) m = k; });
    return m;
  }
  function stepOf(e, slideEl) {
    for (var p = e; p && p !== slideEl; p = p.parentElement) {
      if (p.hasAttribute && p.hasAttribute('data-step')) return parseInt(p.getAttribute('data-step'), 10) || 0;
    }
    return 0;
  }
  function setSteps(s, k) {
    s.shown = k;
    s.el.querySelectorAll('[data-step]').forEach(function (e) {
      e.classList.toggle('is-on', (parseInt(e.getAttribute('data-step'), 10) || 0) <= k);
    });
  }
  // Элементы одного шага раскрываются лесенкой, по 70 мс.
  function stagger(s, k) {
    var j = 0;
    s.el.querySelectorAll('[data-step]').forEach(function (e) {
      if ((parseInt(e.getAttribute('data-step'), 10) || 0) === k) e.style.setProperty('--sd', (j++ * 70) + 'ms');
    });
  }
  // .reveal: видимые (не в скрытом шаге) — лесенкой; base — задержка первого.
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

  // data-countup: первое число в тексте считается до себя; подпись, единицы и разделители сохраняются.
  var NUM_RE = /(\d[\d    ]*\d|\d)([.,]\d+)?/;
  function countParts(e) {
    var fin = e.getAttribute('data-final') || '';
    var m = NUM_RE.exec(fin);
    if (!m) return null;
    var grp = (/[    ]/.exec(m[1]) || [''])[0];
    var dec = m[2] ? m[2][0] : '', places = m[2] ? m[2].length - 1 : 0;
    var val = parseFloat(m[1].replace(/[^\d]/g, '') + (m[2] ? '.' + m[2].slice(1) : ''));
    var attr = e.getAttribute('data-countup');
    if (attr && isFinite(parseFloat(attr.replace(',', '.')))) val = parseFloat(attr.replace(',', '.'));
    return { pre: fin.slice(0, m.index), post: fin.slice(m.index + m[0].length), val: val, grp: grp, dec: dec, places: places,
      from: parseFloat(e.getAttribute('data-from')) || 0 };
  }
  function fmt(p, v) {
    var s = v.toFixed(p.places), parts = s.split('.'), int = parts[0];
    if (p.grp) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, p.grp);
    return p.pre + int + (p.places ? p.dec + parts[1] : '') + p.post;
  }
  function setText(e, text) {
    // меняем только первый текстовый узел с числом — вложенные .unit и разметка остаются
    var w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT), node, first = null;
    while ((node = w.nextNode())) { if (/\d/.test(node.nodeValue)) { first = node; break; } }
    if (!first || e.childNodes.length === 1) { if (e.textContent !== text) e.textContent = text; return; }
    var m = NUM_RE.exec(first.nodeValue), n = NUM_RE.exec(text);
    if (m && n) first.nodeValue = first.nodeValue.slice(0, m.index) + n[0] + first.nodeValue.slice(m.index + m[0].length);
  }
  function countFinal(s) { s.el.querySelectorAll('[data-countup]').forEach(function (e) { e.__cnt = 0; setText(e, e.getAttribute('data-final')); }); }
  function countUp(s, onlyStep) {
    s.el.querySelectorAll('[data-countup]').forEach(function (e) {
      var k = stepOf(e, s.el);
      if (k > s.shown || (onlyStep !== undefined && k !== onlyStep) || e.__cnt === 2) return;
      var p = countParts(e);
      if (!p || reduced()) { setText(e, e.getAttribute('data-final')); e.__cnt = 2; return; }
      var t0 = performance.now(), id = (e.__id = (e.__id || 0) + 1);
      e.__cnt = 1;
      setText(e, fmt(p, p.from));
      (function tick(t) {
        if (e.__id !== id) return;
        var k2 = clamp((t - t0) / 600, 0, 1), v = p.from + (p.val - p.from) * (1 - Math.pow(1 - k2, 3));
        setText(e, k2 < 1 ? fmt(p, v) : e.getAttribute('data-final'));
        if (k2 < 1) requestAnimationFrame(tick); else e.__cnt = 2;
      })(t0);
    });
  }
  function countReset(s) {
    s.el.querySelectorAll('[data-countup]').forEach(function (e) {
      e.__id = (e.__id || 0) + 1; e.__cnt = 0;
      var p = countParts(e); if (p) setText(e, fmt(p, p.from));
    });
  }

  /* ---------- К9 (а). Полоса Регента: ширина (последний − n) / (последний − 1), хвост потери догоняет */
  var regent = (function () {
    var fill = regentEl.querySelector('.regent__fill');
    var tail = regentEl.querySelector('.regent__tail');
    var label = regentEl.querySelector('.regent__label');
    var frame = regentEl.querySelector('.regent__frame');
    var NAME = 'Регент Нимба', DEAD = 'Регент Нимба повержен';
    var hp = 1, timers = [];
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function cancel() { timers.forEach(clearTimeout); timers = []; label.classList.remove('is-swap'); }
    function setHp(v, instant) {
      var heal = v > hp;
      hp = v;
      regentEl.classList.toggle('is-heal', heal);
      if (instant) {
        fill.style.transition = tail.style.transition = 'none';
        fill.style.setProperty('--hp', v); tail.style.setProperty('--hp', v);
        void regentEl.offsetWidth;
        fill.style.transition = tail.style.transition = '';
      } else {
        fill.style.setProperty('--hp', v); tail.style.setProperty('--hp', v);
      }
    }
    function setLabel(text, animate) {
      if (label.textContent === text) return;
      if (!animate) { label.textContent = text; return; }
      label.classList.add('is-swap');
      later(function () { label.textContent = text; label.classList.remove('is-swap'); }, 300);
    }
    function defeated(animateLabel) {
      setHp(0, true); regentEl.classList.add('is-defeated'); setLabel(DEAD, animateLabel);
    }
    // Финал: полоса уже пуста (её остаток улетел в центр), подпись сменится чуть позже.
    function emptied() { setHp(0, true); regentEl.classList.add('is-defeated'); later(function () { setLabel(DEAD, true); }, 1000); }
    // Рамка полосы в координатах сцены (кончик заливки — для цифр урона).
    function barRect() { return stageRect(frame); }
    function tip() { var r = barRect(); return { x: r.x + r.w * hp, y: r.y }; }
    function show(n, mode) {
      var v = clamp((LAST - n) / (LAST - 1), 0, 1);
      cancel();
      if (n === LAST) { defeated(false); return; }
      regentEl.classList.remove('is-defeated');
      setLabel(NAME, false);
      setHp(v, mode === 'jump' || reduced());
    }
    function damage(frac) { cancel(); setHp(clamp(hp - frac, 0, 1), reduced()); }
    return { show: show, damage: damage, defeated: defeated, emptied: emptied, cancel: cancel, later: later, barRect: barRect, tip: tip, frame: frame, get hp() { return hp; } };
  })();

  // Цифра урона у полосы: «−8 %» при смене слайда, «−pct %» у DECK.hit.
  function popup(text, big) {
    if (reduced()) return;
    var t = regent.tip(), e = document.createElement('div');
    e.className = 'dmg' + (big ? ' dmg--big' : '');
    e.setAttribute('aria-hidden', 'true');
    e.textContent = text;
    e.style.left = Math.round(t.x) + 'px';
    e.style.top = Math.round(t.y + 14) + 'px';
    deckEl.appendChild(e);
    var a = e.animate([
      { transform: 'translate(-50%, 0) scale(.8)', opacity: 0 },
      { transform: 'translate(-50%, 10px) scale(1)', opacity: 1, offset: .25 },
      { transform: 'translate(-50%, 34px) scale(1)', opacity: 0 }
    ], { duration: big ? 600 : 560, easing: EASE });
    a.onfinish = a.oncancel = function () { e.remove(); };
  }
  function shake() {
    if (reduced() || !deckEl.animate) return;
    deckEl.animate([
      { translate: '0 0' }, { translate: '-6px 2px' }, { translate: '6px -2px' }, { translate: '-4px 1px' },
      { translate: '3px -1px' }, { translate: '0 0' }
    ], { duration: 250, easing: 'linear' });
  }
  function flash(strength) {
    if (reduced() || !flashEl.animate) return;
    flashEl.animate([{ opacity: 0 }, { opacity: strength || .55, offset: .3 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
  }

  /* ---------- К9 (б). Пепел и искры: один canvas 2D 1920×1080, DPR 1, только слайды 1 и 13.
   * Пепел — не больше 60 хлопьев. Искры собирают текст (логотип, клятва) — 1200–1800 точек, по реальным часам. */
  var fx = (function () {
    var ctx = ashCanvas.getContext('2d');
    var W = 1920, H = 1080, MAX = 60;
    var flakes = [], raf = 0, last = 0, want = 0, stopT = 0;
    var col = {}, sparks = null;
    function colors() { col = { ash: rgb(token('--muted')), glow: rgb(token('--gold-b')), hi: rgb(token('--gold-hi')), ember: rgb(token('--hand-right')) }; }
    function flake(fresh) {
      return {
        x: Math.random() * W, y: fresh ? Math.random() * H : H + 10 + Math.random() * 60,
        vx: (Math.random() - .5) * 14, vy: -(10 + Math.random() * 26),
        r: .8 + Math.random() * 2.2, a: .12 + Math.random() * .38, ph: Math.random() * 6.3,
        hot: Math.random() < .22
      };
    }
    function ease(u) { return u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
    function drawSparks(now) {
      var S = sparks, t = (now - S.t0) / 1000, done = true, fade = 1;
      if (S.fadeAt) { fade = clamp(1 - (now - S.fadeAt) / S.fadeMs, 0, 1); if (fade <= 0) { var cb = S.onGone; sparks = null; if (cb) cb(); return; } }
      ctx.globalCompositeOperation = 'lighter';
      var buckets = [[], [], []];
      for (var i = 0; i < S.p.length; i++) {
        var p = S.p[i], u = clamp((t - p.d) / p.T, 0, 1);
        if (u < 1) done = false;
        var e = ease(u), a = 1 - e, b = e;
        // квадратичная кривая: из точки старта через контрольную (вихрь или взрыв) в точку текста
        var x = a * a * p.sx + 2 * a * b * p.cx + b * b * p.tx, y = a * a * p.sy + 2 * a * b * p.cy + b * b * p.ty;
        buckets[u >= 1 ? 0 : (u > .55 ? 1 : 2)].push(x, y, p.s);
      }
      var cs = [col.hi, col.glow, col.ember], al = [.95, .8, .7];
      for (var k = 0; k < 3; k++) {
        var B = buckets[k]; if (!B.length) continue;
        ctx.fillStyle = 'rgba(' + cs[k].join(',') + ',' + (al[k] * fade * S.alpha).toFixed(3) + ')';
        for (var j = 0; j < B.length; j += 3) ctx.fillRect(B[j] - B[j + 2] / 2, B[j + 1] - B[j + 2] / 2, B[j + 2], B[j + 2]);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (done && !S.arrived) { S.arrived = true; if (S.onArrive) S.onArrive(); }
    }
    function frame(t) {
      raf = 0;
      // Хлопья живут на ограниченном шаге (рывок кадра не швыряет их), искры — по реальным часам.
      var real = last ? Math.min(.25, (t - last) / 1000) : .016, dt = Math.min(.05, real); last = t;
      ctx.clearRect(0, 0, W, H);
      var i, p;
      for (i = 0; i < flakes.length; i++) {
        p = flakes[i];
        p.ph += dt * .8; p.x += (p.vx + Math.sin(p.ph) * 9) * dt; p.y += p.vy * dt;
        if (p.y < -12 || p.x < -12 || p.x > W + 12) { if (flakes.length > want) { flakes.splice(i--, 1); continue; } flakes[i] = flake(false); continue; }
        var c = p.hot ? col.glow : col.ash;
        ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + p.a.toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
      }
      while (flakes.length < want && flakes.length < MAX) flakes.push(flake(false));
      if (sparks) drawSparks(performance.now());
      if (want || flakes.length || sparks) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    // count — сколько хлопьев пепла держать в воздухе; 0 — погасить (холст гаснет вместе со сменой слайда).
    function setAsh(count) {
      clearTimeout(stopT);
      if (reduced()) count = 0;
      want = Math.min(count, MAX);
      colors();
      if (want) {
        if (!flakes.length) for (var i = 0; i < want; i++) flakes.push(flake(true));
        ashCanvas.style.opacity = '1';
        kick();
      } else if (!sparks) {
        ashCanvas.style.opacity = '0';
        stopT = setTimeout(function () { flakes = []; ctx.clearRect(0, 0, W, H); }, WIPE_MS);
      }
    }
    // Точки текста: рисуем глифы элемента (каждую букву на её месте), SVG и сплошные .spk-solid в маску.
    function sample(el, count) {
      return fontsReady.then(function () {
        var box = stageRect(el), pad = 40;
        var bx = Math.max(0, Math.floor(box.x - pad)), by = Math.max(0, Math.floor(box.y - pad));
        var bw = Math.min(W - bx, Math.ceil(box.w + pad * 2)), bh = Math.min(H - by, Math.ceil(box.h + pad * 2));
        var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
        var g = cv.getContext('2d'), d = deckEl.getBoundingClientRect(), s = scale(), range = document.createRange();
        g.fillStyle = '#fff'; g.strokeStyle = '#fff';
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node;
        while ((node = walker.nextNode())) {
          var txt = node.nodeValue; if (!txt.trim()) continue;
          var cs = getComputedStyle(node.parentElement);
          g.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
          var asc = g.measureText('Hg').fontBoundingBoxAscent || parseFloat(cs.fontSize) * .9;
          var up = cs.textTransform === 'uppercase';
          for (var i = 0; i < txt.length; i++) {
            var ch = txt[i]; if (!ch.trim()) continue;
            range.setStart(node, i); range.setEnd(node, i + 1);
            var r = range.getBoundingClientRect(); if (!r.width) continue;
            g.fillText(up ? ch.toUpperCase() : ch, (r.left - d.left) / s, (r.top - d.top) / s + asc);
          }
        }
        el.querySelectorAll('.spk-solid').forEach(function (e) { var r = stageRect(e); g.fillRect(r.x, r.y, Math.max(2, r.w), Math.max(2, r.h)); });
        var svgs = [].slice.call(el.querySelectorAll('svg'));
        return Promise.all(svgs.map(function (svg) {
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
          for (var step = 2; step <= 6; step++) {
            pts = [];
            for (var y = 0; y < bh; y += step) for (var x = 0; x < bw; x += step) if (data[(y * bw + x) * 4 + 3] > 120) pts.push(bx + x, by + y);
            if (pts.length / 2 <= count * 3) break;
          }
          // перемешиваем и берём count точек
          var n = pts.length / 2, idx = [];
          for (var k = 0; k < n; k++) idx.push(k);
          for (k = n - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)), t = idx[k]; idx[k] = idx[j]; idx[j] = t; }
          var out = [];
          for (k = 0; k < Math.min(count, n); k++) out.push([pts[idx[k] * 2], pts[idx[k] * 2 + 1]]);
          return out;
        });
      });
    }
    // Искры летят в точки текста. from(i) — точка старта и контрольная точка кривой.
    function assemble(targets, opt) {
      colors();
      var p = targets.map(function (tg, i) {
        var f = opt.from(i, tg);
        return { sx: f[0], sy: f[1], cx: f[2], cy: f[3], tx: tg[0], ty: tg[1],
          d: Math.random() * opt.delay, T: opt.dur[0] + Math.random() * (opt.dur[1] - opt.dur[0]), s: 1.6 + Math.random() * 1.4 };
      });
      sparks = { p: p, t0: performance.now(), alpha: 1, onArrive: opt.onArrive, fadeAt: 0, fadeMs: 300, arrived: false };
      ashCanvas.style.opacity = '1';
      kick();
    }
    function fadeSparks(ms, cb) { if (!sparks) { if (cb) cb(); return; } sparks.fadeAt = performance.now(); sparks.fadeMs = ms; sparks.onGone = cb; }
    function stopSparks() { sparks = null; }
    function edges(i, tg) {
      // старт — по краям кадра, контрольная точка — с поворотом вокруг середины пути (вихрь)
      var side = i % 4, sx, sy;
      if (side === 0) { sx = Math.random() * W; sy = -20; } else if (side === 1) { sx = W + 20; sy = Math.random() * H; }
      else if (side === 2) { sx = Math.random() * W; sy = H + 20; } else { sx = -20; sy = Math.random() * H; }
      var mx = (sx + tg[0]) / 2, my = (sy + tg[1]) / 2, dx = tg[0] - sx, dy = tg[1] - sy, sw = (Math.random() - .5) * .9;
      return [sx, sy, mx - dy * sw, my + dx * sw];
    }
    ashCanvas.style.transition = 'opacity .4s cubic-bezier(.2,.7,.2,1)';
    ashCanvas.style.opacity = '0';
    return { setAsh: setAsh, sample: sample, assemble: assemble, fade: fadeSparks, stop: stopSparks, edges: edges, active: function () { return !!sparks; } };
  })();
  var ASH_COUNT = { 1: 48 };
  ASH_COUNT[LAST] = 20;

  /* ---------- Логотип и клятва из искр (слайды 1 и 13) */
  var sparkRun = 0;
  function sparkCancel(s) {
    sparkRun++;
    fx.stop();
    morphLayer.querySelectorAll('.regent-ghost').forEach(function (g) { g.remove(); });
    if (s) s.el.querySelectorAll('[data-sparks].is-sparking').forEach(function (e) { e.classList.remove('is-sparking'); });
  }
  // Титул: 1200–1800 искр слетаются с краёв в буквы за 1,8 с, затем — тёплое свечение и остальной текст.
  function sparkTitle(s, target) {
    var run = ++sparkRun;
    target.classList.add('is-sparking');
    fx.sample(target, 1600).then(function (pts) {
      if (run !== sparkRun) return;
      if (pts.length < 200) { finish(); return; }
      fx.assemble(pts, { from: fx.edges, delay: .4, dur: [1.0, 1.4], onArrive: finish });
    });
    function finish() {
      if (run !== sparkRun) return;
      target.classList.remove('is-sparking');
      target.classList.add('is-glow');
      fx.fade(300);
      reveal(s, 60);
    }
  }
  // Финал: полоса Регента слетает в центр, трескается, взрывается искрами, искры собираются в клятву. ≤ 3 с.
  function sparkFinale(s, target) {
    var run = ++sparkRun;
    target.classList.add('is-sparking');
    var r0 = regent.barRect();
    var ghost = document.createElement('div');
    ghost.className = 'regent-ghost';
    ghost.style.left = r0.x + 'px'; ghost.style.top = r0.y + 'px'; ghost.style.width = r0.w + 'px'; ghost.style.height = r0.h + 'px';
    ghost.appendChild(regent.frame.cloneNode(true));
    ghost.insertAdjacentHTML('beforeend', '<svg class="regent-ghost__crack" viewBox="0 0 640 10" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="M296 -16 L312 1 L300 5 L322 26 M312 1 L338 -8 M300 5 L276 18"/></svg>');
    var fillClone = ghost.querySelector('.regent__fill'), tailClone = ghost.querySelector('.regent__tail');
    if (fillClone) fillClone.style.setProperty('--hp', regent.hp || 1 / (LAST - 1));
    if (tailClone) tailClone.style.setProperty('--hp', regent.hp || 1 / (LAST - 1));
    morphLayer.appendChild(ghost);
    regent.emptied();
    var pts = null;
    fx.sample(target, 1500).then(function (p) { pts = p; });
    var dy = 540 - (r0.y + r0.h / 2);
    ghost.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(' + dy + 'px) scale(1.6)' }], { duration: 600, easing: EASE, fill: 'forwards' });
    var crack = ghost.querySelector('path');
    var len = 120;
    crack.style.strokeDasharray = len; crack.style.strokeDashoffset = len;
    regent.later(function () {
      if (run !== sparkRun) return;
      crack.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 250, easing: 'ease-out', fill: 'forwards' });
      ghost.animate([{ translate: '0 0' }, { translate: '-3px 1px' }, { translate: '3px -1px' }, { translate: '0 0' }], { duration: 250 });
    }, 600);
    regent.later(function () {
      if (run !== sparkRun) return;
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
      flash(.4);
      var cx = 960, cy = 540, halfW = r0.w * 1.6 / 2;
      var go2 = function (list) {
        fx.assemble(list, {
          delay: .25, dur: [.9, 1.25], onArrive: done,
          from: function () {
            // старт — по всей треснувшей полосе, контрольная точка — разлёт взрыва
            var sx = cx + (Math.random() * 2 - 1) * halfW, sy = cy + (Math.random() - .5) * 16;
            var ang = Math.random() * Math.PI * 2, R = 160 + Math.random() * 300;
            return [sx, sy, sx + Math.cos(ang) * R, sy + Math.sin(ang) * R * .7];
          }
        });
      };
      if (pts && pts.length) go2(pts); else fx.sample(target, 1500).then(function (p) { if (run === sparkRun) go2(p); });
    }, 850);
    function done() {
      if (run !== sparkRun) return;
      target.classList.remove('is-sparking');
      fx.fade(300);
      ghost.remove();
      reveal(s, 100);
    }
  }

  /* ---------- «Волшебный переход»: data-morph на уходящем и входящем слайде (FLIP, 550 мс) */
  var morphs = [];
  function morphFinishAll() {
    morphs.forEach(function (m) { m.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* уже завершена */ } }); m.end(); });
    morphs = [];
  }
  function ghostOf(e, r) {
    var g = e.cloneNode(true), cs = getComputedStyle(e);
    g.removeAttribute('data-morph'); g.removeAttribute('id'); g.removeAttribute('data-step'); g.removeAttribute('data-sparks');
    g.querySelectorAll('[id]').forEach(function (x) { x.removeAttribute('id'); });
    g.classList.remove('is-sparking', 'reveal');
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

  /* ---------- Переход «чернила света»: новый слайд проявляется за светлой чертой */
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

  /* ---------- Параллакс от мыши: --px/--py на сцене, слои с data-depth сдвигаются на ±depth px */
  var par = { x: 0, y: 0, tx: 0, ty: 0, raf: 0, frozen: false };
  function parallaxOn() { return !!(fineMQ && fineMQ.matches) && !reduced(); }
  function parTick() {
    par.raf = 0;
    var tx = par.frozen ? 0 : par.tx, ty = par.frozen ? 0 : par.ty;
    par.x += (tx - par.x) * .08; par.y += (ty - par.y) * .08;
    deckEl.style.setProperty('--px', par.x.toFixed(4)); deckEl.style.setProperty('--py', par.y.toFixed(4));
    if (Math.abs(tx - par.x) > .001 || Math.abs(ty - par.y) > .001) par.raf = requestAnimationFrame(parTick);
  }
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || !parallaxOn()) return;
    par.tx = clamp(e.clientX / window.innerWidth * 2 - 1, -1, 1); par.ty = clamp(e.clientY / window.innerHeight * 2 - 1, -1, 1);
    if (!par.raf) par.raf = requestAnimationFrame(parTick);
  });

  /* ---------- Навигация */
  var cur = -1;
  var presenter = null;
  var navigated = false;
  function info(s) {
    var t = s.el.querySelector('.thesis');
    return (t ? t.textContent : s.el.getAttribute('data-title') || '').replace(/\s+/g, ' ').trim();
  }
  function setHash(n) {
    if (location.hash === '#' + n) return;
    try { history.replaceState(null, '', '#' + n); } catch (e) { location.replace('#' + n); }
  }
  // mode: 'fwd' — вперёд на соседний; 'back' — назад; 'jump' — hash, Home, End, первый показ.
  function go(i, mode) {
    i = clamp(i, 0, slides.length - 1);
    if (i === cur) return;
    var prev = slides[cur] || null, s = slides[i];
    var dir = mode === 'fwd' ? 1 : -1;
    var animate = !reduced() && !!prev && (mode === 'fwd' || mode === 'back');
    if (prev) hideHint();

    morphFinishAll();
    sparkCancel(prev);
    slides.forEach(function (x) { if (x !== s && x !== prev) { x.el.classList.remove('is-leaving', 'is-dim', 'is-wipe', 'is-wipe-back'); } });

    // Состояние входа ставим без переходов, чтобы шаги не «гасли» на глазах; вперёд — анимируем дальше.
    clearTimeout(s.leaveT);
    loadImages(s); loadImages(slides[i + 1]);
    s.el.classList.remove('is-leaving', 'is-dim');
    s.el.classList.add('is-instant');
    s.max = maxStep(s.el);
    unlight(s); unreveal(s);
    setSteps(s, dir > 0 ? 0 : s.max);
    if (dir > 0 && !reduced()) countReset(s); else countFinal(s);
    void s.el.offsetWidth;
    if (animate && prev) morph(prev, s);

    if (prev) {
      call(prev.def.leave, prev.def, [prev.el], 'leave');
      prev.el.classList.remove('is-active', 'is-wipe', 'is-wipe-back');
      if (animate) {
        prev.el.classList.add('is-leaving', 'is-dim');
        clearTimeout(prev.leaveT);
        prev.leaveT = setTimeout(function () {
          prev.el.classList.remove('is-leaving', 'is-dim');
          if (slides[cur] !== prev) { unlight(prev); unreveal(prev); }
        }, WIPE_MS + 30);
      } else { unlight(prev); unreveal(prev); }
    }
    if (dir > 0 && !reduced()) s.el.classList.remove('is-instant');
    s.el.classList.add('is-active');
    if (animate) inkWipe(s, mode === 'back');
    cur = i;

    // Слайды 1 и 13: текст из искр — при первом показе титула и при входе вперёд в финал.
    var target = s.el.querySelector('[data-sparks]');
    var sparkOk = target && !reduced() && dir > 0 && (s.n === 1 ? !prev : s.n === LAST && prev && prev.n === LAST - 1);
    if (s.n === LAST) { if (sparkOk) regent.cancel(); else regent.show(s.n, mode); }
    else {
      regent.show(s.n, mode);
      if (animate && mode === 'fwd') setTimeout(function () { if (slides[cur] === s) popup('−' + Math.round(100 / (LAST - 1)) + ' %'); }, 120);
    }
    if (sparkOk) {
      par.frozen = true;
      if (s.n === 1) sparkTitle(s, target); else sparkFinale(s, target);
      setTimeout(function () { par.frozen = false; if (!par.raf) par.raf = requestAnimationFrame(parTick); }, 3000);
    } else if (dir > 0 && !reduced()) {
      reveal(s, 150);
    } else {
      reveal(s, 0);
      s.el.querySelectorAll('[data-sparks]').forEach(function (e) { e.classList.add('is-glow'); });
    }
    if (target && !sparkOk) target.classList.add('is-glow');

    ignite(s);
    if (dir > 0 && !reduced()) countUp(s, 0); else countFinal(s);
    syncMedia();
    fx.setAsh(ASH_COUNT[s.n] || 0);
    call(s.def.enter, s.def, [s.el, dir, { prev: prev ? prev.n : null, jump: mode === 'jump' }], 'enter');

    setHash(s.n);
    document.title = s.n === 1 ? BASE_TITLE : 'ASHEN OATH — ' + s.el.getAttribute('data-title');
    sr.textContent = 'Слайд ' + s.n + ' из ' + slides.length + ': ' + s.el.getAttribute('data-title');
    document.dispatchEvent(new CustomEvent('deck:change', { detail: { n: s.n, prev: prev ? prev.n : null } }));
    renderPresenter();
    if (auto.on) auto.schedule();
  }
  function next() {
    var s = slides[cur];
    hideHint();
    if (s && s.shown < s.max) {
      setSteps(s, s.shown + 1);
      stagger(s, s.shown);
      ignite(s);
      reveal(s, 120, s.shown);
      countUp(s, s.shown);
      call(s.def.step, s.def, [s.el, s.shown], 'step');
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

  /* ---------- Подсказка для зрителя: через 3 с внизу, гаснет после первого перелистывания */
  var hintT = 0;
  function hideHint() { navigated = true; clearTimeout(hintT); hintEl.classList.remove('is-on'); }

  /* ---------- Автопросмотр (A): шаги и слайды по времени из sec, любая клавиша или касание — вручную */
  var auto = {
    on: false, t: 0,
    start: function () {
      if (auto.on) return;
      auto.on = true; hideHint();
      autoEl.classList.add('is-on');
      deckEl.querySelectorAll('[data-action="autoplay"]').forEach(function (b) { b.setAttribute('aria-pressed', 'true'); });
      auto.schedule();
    },
    stop: function () {
      if (!auto.on) return;
      auto.on = false; clearTimeout(auto.t);
      autoEl.classList.remove('is-on');
      deckEl.querySelectorAll('[data-action="autoplay"]').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
    },
    schedule: function () {
      clearTimeout(auto.t);
      var s = slides[cur];
      if (!s) return;
      if (cur === slides.length - 1 && s.shown >= s.max) { auto.t = setTimeout(auto.stop, s.sec * 1000); return; }
      var parts = s.max + 1;
      auto.t = setTimeout(function () { if (auto.on) next(); }, Math.max(1500, s.sec * 1000 / parts));
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
    var t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    var c = e.code;
    if (c === 'KeyA' && !e.repeat) { if (auto.on) auto.stop(); else auto.start(); e.preventDefault(); return; }
    if (auto.on && c !== 'ShiftLeft' && c !== 'ShiftRight') auto.stop();
    // Enter и пробел на ссылке или кнопке работают как обычно, а не листают.
    if (t && t.closest && t.closest('a, button') && (c === 'Enter' || c === 'NumpadEnter' || c === 'Space')) return;
    if (help.classList.contains('is-on') && (c === 'Escape' || (c === 'Slash' && e.shiftKey))) { toggleHelp(false); e.preventDefault(); return; }
    if (NEXT[c]) { next(); e.preventDefault(); }
    else if (PREV[c]) { prev(); e.preventDefault(); }
    else if (c === 'Home') { hideHint(); go(0, 'jump'); e.preventDefault(); }
    else if (c === 'End') { hideHint(); go(slides.length - 1, 'jump'); e.preventDefault(); }
    else if (e.repeat) return;
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

  /* ---------- Печать: на время печати все шаги раскрыты, цифры горят и досчитаны, потом — как было */
  var printed = false;
  function beforePrint() {
    if (printed) return; printed = true;
    loadAll();
    morphFinishAll();
    slides.forEach(function (s) {
      s.el.classList.add('is-instant');
      s.el.querySelectorAll('[data-step]').forEach(function (e) { e.classList.add('is-on'); });
      s.el.querySelectorAll('[data-ignite]').forEach(function (e) { e.classList.add('is-lit'); });
      s.el.querySelectorAll('.reveal').forEach(function (e) { e.classList.add('is-shown'); });
      s.el.querySelectorAll('[data-sparks]').forEach(function (e) { e.classList.remove('is-sparking'); });
      countFinal(s);
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
  }, true);
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    var moved = down && Math.max(Math.abs(e.clientX - down.x), Math.abs(e.clientY - down.y)) > 6;
    down = null;
    if (moved) return;
    var t = e.target;
    var act = t.closest && t.closest('[data-action="autoplay"]');
    if (act) { e.preventDefault(); if (auto.on) auto.stop(); else auto.start(); return; }
    if (t.closest && t.closest('a, button, input, select, textarea, label, video, [data-interactive], .help__box')) return;
    if (help.classList.contains('is-on')) { toggleHelp(false); return; }
    var x = e.clientX / window.innerWidth;
    if (x < 0.2) prev(); else if (x > 0.8) next();
  });
  var tx = null, ty = null;
  document.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (tx === null) return;
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = ty = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2) { auto.stop(); if (dx < 0) next(); else prev(); }
  });

  /* ---------- Старт */
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', function () { var i = fromHash(); if (i !== cur) { hideHint(); go(i, 'jump'); } });
  window.addEventListener('beforeunload', function () { if (presenter && !presenter.closed) { try { presenter.close(); } catch (e) { /* окно уже закрыто */ } } });
  fit();
  // Открыли с первого слайда — титул собирается из искр; с любого другого — сразу целиком.
  var first = fromHash();
  go(first, first === 0 ? 'fwd' : 'jump');
  hintT = setTimeout(function () { if (!navigated && !auto.on) hintEl.classList.add('is-on'); }, 3000);
  // Видео и остальные картинки — после того как первый экран загружен: титул появляется быстрее.
  function afterLoad() { mediaReady = true; syncMedia(); setTimeout(scheduleIdleLoad, 1500); }
  if (document.readyState === 'complete') afterLoad(); else window.addEventListener('load', afterLoad, { once: true });

  // Небольшой API: удар по полосе Регента (слайд 4), готовность к печати (tools/pitch_pdf.mjs).
  window.DECK = {
    hit: function (pct, opt) {
      opt = opt || {};
      pct = clamp(+pct || 0, 0, 100);
      regent.damage(pct / 100);
      popup('−' + Math.round(pct) + ' %', true);
      if (opt.shake !== false) shake();
      if (opt.flash !== false) flash();
    },
    ready: function () { return fontsReady.then(imagesReady).then(function () { return slides.length; }); },
    go: function (n) { hideHint(); go(clamp(n, 1, slides.length) - 1, 'jump'); },
    get n() { return slides[cur] ? slides[cur].n : 0; },
    get total() { return slides.length; }
  };
})();
