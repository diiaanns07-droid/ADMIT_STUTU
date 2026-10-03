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
 * Клавиши (по e.code — работают и в русской раскладке): → пробел PageDown Enter — вперёд;
 * ← PageUp Backspace — назад; Home/End; F — полный экран; S — окно докладчика; B и «.» — чёрный экран;
 * ? — помощь. Номер слайда — в hash (#7). Щелчок по левой пятой части экрана — назад, по правой — вперёд. */
(function () {
  'use strict';

  var TOTAL = 13;          // слайдов в докладе; недостающие показываются заглушкой «в сборке»
  var STUB_SEC = 40;       // время на слайд-заглушку в плане таймера
  var FADE_MS = 400;       // смена слайда
  var PRESENTER = 'ashen-presenter';

  var root = document.documentElement;
  var deckEl = document.getElementById('deck');
  var ashCanvas = document.getElementById('ash');
  var regentEl = document.getElementById('regent');
  var reducedMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

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
        '<p class="cap">Часть презентации ещё не слита в main.</p>' +
        '<aside class="notes">Слайд ' + n + ' ещё в сборке.</aside></section>'
    };
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
    return el;
  }

  var slides = [];
  for (var n = 1; n <= lastN; n++) {
    var def = byN[n] || stubDef(n);
    var el = build(def, n);
    deckEl.insertBefore(el, ashCanvas);
    slides.push({ n: n, sec: +def.sec > 0 ? +def.sec : STUB_SEC, el: el, def: def, shown: 0, max: 0, leaveT: 0 });
  }
  var PLAN = slides.reduce(function (a, s) { return a + s.sec; }, 0);

  /* ---------- Служебные слои: чёрный экран, помощь, подсказка, объявления для экранного диктора */
  function make(tag, cls, html) { var e = document.createElement(tag); e.className = cls; if (html) e.innerHTML = html; document.body.appendChild(e); return e; }
  var blackout = make('div', 'blackout');
  var help = make('div', 'help',
    '<div class="help__box" role="dialog" aria-label="Клавиши презентации"><h2>Клавиши</h2><dl>' +
    '<dt><kbd>→</kbd> <kbd>Пробел</kbd> <kbd>PgDn</kbd> <kbd>Enter</kbd></dt><dd>вперёд: сначала шаги слайда, потом следующий</dd>' +
    '<dt><kbd>←</kbd> <kbd>PgUp</kbd> <kbd>Backspace</kbd></dt><dd>назад: предыдущий слайд целиком</dd>' +
    '<dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>первый и последний слайд</dd>' +
    '<dt><kbd>F</kbd></dt><dd>полный экран</dd>' +
    '<dt><kbd>S</kbd></dt><dd>окно докладчика: заметки, следующий слайд, таймер</dd>' +
    '<dt><kbd>R</kbd></dt><dd>сбросить таймер докладчика</dd>' +
    '<dt><kbd>B</kbd> <kbd>.</kbd></dt><dd>чёрный экран</dd>' +
    '<dt><kbd>?</kbd> <kbd>Esc</kbd></dt><dd>эта подсказка</dd>' +
    '</dl><p>Щелчок по левой пятой части экрана — назад, по правой — вперёд. Номер слайда — в адресе: #7. ' +
    'Печать (Ctrl+P) — по слайду на страницу, все шаги раскрыты.</p></div>');
  var toastEl = make('div', 'toast');
  var sr = make('p', 'sr-only'); sr.setAttribute('aria-live', 'polite');
  var toastT = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('is-on');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2600);
  }

  /* ---------- Масштаб сцены */
  function fit() { root.style.setProperty('--s', Math.min(window.innerWidth / 1920, window.innerHeight / 1080)); }

  /* ---------- Шаги и «загорание» цифр */
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
  // Цифра загорается, когда её видно: слайд открыт и шаг, в котором она стоит, раскрыт.
  function ignite(s) {
    s.el.querySelectorAll('[data-ignite]').forEach(function (e) {
      if (stepOf(e, s.el) > s.shown || e.classList.contains('is-lit')) return;
      e.style.setProperty('--ignite-w', Math.max(0, e.offsetWidth - 3) + 'px');
      e.classList.add('is-lit');
    });
  }
  function unlight(s) { s.el.querySelectorAll('[data-ignite].is-lit').forEach(function (e) { e.classList.remove('is-lit'); }); }

  /* ---------- Видео: src только на активном слайде, при уходе — пауза, в начало, без src */
  function media(s, on) {
    s.el.querySelectorAll('video[data-src]').forEach(function (v) {
      if (on) {
        if (v.getAttribute('src') !== v.getAttribute('data-src')) v.setAttribute('src', v.getAttribute('data-src'));
        var p = v.play(); if (p && p.catch) p.catch(function () {});
      } else {
        try { v.pause(); v.currentTime = 0; } catch (e) { /* видео ещё не загружено */ }
        if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
      }
    });
  }

  /* ---------- К9 (а). Полоса Регента: ширина (последний − n) / (последний − 1), хвост потери догоняет */
  var regent = (function () {
    var fill = regentEl.querySelector('.regent__fill');
    var tail = regentEl.querySelector('.regent__tail');
    var label = regentEl.querySelector('.regent__label');
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
    // Сигнатурный момент слайда 13: полоса в ноль (300 мс), хвост стекает (500 мс), полоса рассыпается
    // на 40 угольков (900 мс), подпись меняется. Всё вместе — 2,1 с.
    function defeat(animate) {
      cancel();
      if (!animate) {
        setHp(0, true); regentEl.classList.add('is-defeated'); setLabel(DEAD, false);
        return;
      }
      setHp(0, false);
      later(function () {
        regentEl.classList.add('is-defeated');
        var r = barRect();
        ash.burst(r.x, r.x + r.w, r.y + r.h / 2, 40);
      }, 800);
      later(function () { setLabel(DEAD, true); }, 1000);
    }
    function barRect() { return { x: regentEl.offsetLeft, y: regentEl.offsetTop + regentEl.querySelector('.regent__frame').offsetTop, w: regentEl.offsetWidth, h: 10 }; }
    function show(n, mode) {
      var last = slides.length;
      var v = clamp((last - n) / (last - 1), 0, 1);
      if (n === last) { defeat(mode === 'fwd' && !reduced()); return; }
      cancel();
      regentEl.classList.remove('is-defeated');
      setLabel(NAME, false);
      setHp(v, mode === 'jump' || reduced());
    }
    return { show: show, defeat: defeat, cancel: cancel };
  })();

  /* ---------- К9 (б). Пепел: canvas 2D, DPR 1, не больше 60 частиц всего, только слайды 1 и 13 */
  var ash = (function () {
    var ctx = ashCanvas.getContext('2d');
    var W = 1920, H = 1080, MAX = 60;
    var flakes = [], embers = [], raf = 0, last = 0, want = 0, stopT = 0;
    var col = {};
    function rgb(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [216, 179, 106];
      var v = parseInt(m[1], 16); return [v >> 16 & 255, v >> 8 & 255, v & 255];
    }
    function colors() { col = { ash: rgb(token('--muted')), glow: rgb(token('--ember')), hi: rgb(token('--gold-hi')) }; }
    function flake(fresh) {
      return {
        x: Math.random() * W, y: fresh ? Math.random() * H : H + 10 + Math.random() * 60,
        vx: (Math.random() - .5) * 14, vy: -(10 + Math.random() * 26),
        r: .8 + Math.random() * 2.2, a: .12 + Math.random() * .38, ph: Math.random() * 6.3,
        hot: Math.random() < .22
      };
    }
    function frame(t) {
      raf = 0;
      var dt = last ? Math.min(.05, (t - last) / 1000) : .016; last = t;
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
      while (flakes.length < want && flakes.length + embers.length < MAX) flakes.push(flake(false));
      if (embers.length) {
        ctx.globalCompositeOperation = 'lighter';
        for (i = 0; i < embers.length; i++) {
          p = embers[i];
          p.age += dt;
          if (p.age >= p.life) { embers.splice(i--, 1); continue; }
          var k = p.age / p.life;
          p.vy -= 60 * dt; p.vx *= .985;
          p.x += p.vx * dt; p.y += p.vy * dt;
          var a = (1 - k) * (1 - k);
          var c2 = k < .35 ? col.hi : col.glow;
          ctx.fillStyle = 'rgba(' + c2[0] + ',' + c2[1] + ',' + c2[2] + ',' + a.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - k * .5), 0, 6.2832); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      if (want || flakes.length || embers.length) raf = requestAnimationFrame(frame);
      else last = 0;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(frame); }
    // count — сколько хлопьев пепла держать в воздухе; 0 — погасить (холст гаснет вместе со сменой слайда).
    function set(count) {
      clearTimeout(stopT);
      if (reduced()) count = 0;
      want = Math.min(count, MAX);
      if (want) {
        colors();
        if (!flakes.length) for (var i = 0; i < want; i++) flakes.push(flake(true));
        ashCanvas.style.opacity = '1';
        kick();
      } else {
        ashCanvas.style.opacity = '0';
        stopT = setTimeout(function () { flakes = []; embers = []; ctx.clearRect(0, 0, W, H); }, FADE_MS);
      }
    }
    // Полоса рассыпается на угольки: появляются вдоль полосы, летят вверх и гаснут за 0,9 с.
    function burst(x0, x1, y, count) {
      if (reduced()) return;
      colors();
      var room = Math.max(0, MAX - flakes.length);
      count = Math.min(count, room);
      for (var i = 0; i < count; i++) {
        embers.push({
          x: x0 + (x1 - x0) * (i + Math.random()) / count, y: y + (Math.random() - .5) * 8,
          vx: (Math.random() - .5) * 90, vy: -(40 + Math.random() * 130),
          r: 1.6 + Math.random() * 2.4, age: 0, life: .55 + Math.random() * .35
        });
      }
      ashCanvas.style.opacity = '1';
      kick();
    }
    ashCanvas.style.transition = 'opacity .4s cubic-bezier(.2,.7,.2,1)';
    ashCanvas.style.opacity = '0';
    return { set: set, burst: burst };
  })();
  var ASH_COUNT = { 1: 48, 13: 20 };   // на 13-м оставляем место для 40 угольков: всего ≤ 60

  /* ---------- Навигация */
  var cur = -1;
  var presenter = null;
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

    if (prev) {
      call(prev.def.leave, prev.def, [prev.el], 'leave');
      media(prev, false);
      prev.el.classList.remove('is-active');
      prev.el.classList.add('is-leaving');
      clearTimeout(prev.leaveT);
      prev.leaveT = setTimeout(function () {
        prev.el.classList.remove('is-leaving');
        if (slides[cur] !== prev) unlight(prev);
      }, FADE_MS + 20);
    }

    // Состояние входа ставим без переходов, чтобы шаги не «гасли» на глазах; вперёд — анимируем дальше.
    clearTimeout(s.leaveT);
    s.el.classList.remove('is-leaving');
    s.el.classList.add('is-instant');
    s.max = maxStep(s.el);
    unlight(s);
    setSteps(s, dir > 0 ? 0 : s.max);
    void s.el.offsetWidth;
    if (dir > 0 && !reduced()) s.el.classList.remove('is-instant');
    s.el.classList.add('is-active');
    cur = i;

    ignite(s);
    media(s, true);
    regent.show(s.n, mode);
    ash.set(ASH_COUNT[s.n] || 0);
    call(s.def.enter, s.def, [s.el, dir, { prev: prev ? prev.n : null, jump: mode === 'jump' }], 'enter');

    setHash(s.n);
    document.title = 'ASHEN OATH — ' + s.el.getAttribute('data-title');
    sr.textContent = 'Слайд ' + s.n + ' из ' + slides.length + ': ' + s.el.getAttribute('data-title');
    document.dispatchEvent(new CustomEvent('deck:change', { detail: { n: s.n, prev: prev ? prev.n : null } }));
    renderPresenter();
  }
  function next() {
    var s = slides[cur];
    if (s && s.shown < s.max) {
      setSteps(s, s.shown + 1);
      ignite(s);
      call(s.def.step, s.def, [s.el, s.shown], 'step');
      renderPresenter();
      return;
    }
    if (cur < slides.length - 1) go(cur + 1, 'fwd');
  }
  function prev() { if (cur > 0) go(cur - 1, 'back'); }
  function fromHash() {
    var k = parseInt((location.hash || '').replace('#', ''), 10);
    return isFinite(k) ? clamp(k, 1, slides.length) - 1 : 0;
  }

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
    // Enter и пробел на ссылке или кнопке работают как обычно, а не листают.
    if (t && t.closest && t.closest('a, button') && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) return;
    var c = e.code;
    if (help.classList.contains('is-on') && (c === 'Escape' || (c === 'Slash' && e.shiftKey))) { toggleHelp(false); e.preventDefault(); return; }
    if (NEXT[c]) { next(); e.preventDefault(); }
    else if (PREV[c]) { prev(); e.preventDefault(); }
    else if (c === 'Home') { go(0, 'jump'); e.preventDefault(); }
    else if (c === 'End') { go(slides.length - 1, 'jump'); e.preventDefault(); }
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
      '.black{color:var(--ember)}button{font:inherit;font-size:17px;color:var(--text);background:var(--coal-deep);border:1px solid var(--line);padding:6px 14px;cursor:pointer}' +
      '.btns{grid-column:1/3;display:flex;gap:10px;align-items:center;color:var(--muted);font-size:15px}' +
      '</style></head><body>' +
      '<div class="top"><span><span class="n" id="n"></span> <span class="k" id="state"></span></span><span class="clock" id="clock"></span></div>' +
      '<div class="main"><p class="k">Сейчас</p><div class="th" id="th"></div><div class="st" id="st"></div><div class="notes" id="notes"></div></div>' +
      '<div class="side"><div class="box"><p class="k">Время</p><div class="el" id="el">0:00</div>' +
      '<div class="row">План доклада: <b id="plan"></b></div><div class="row">К концу слайда по плану: <b id="due"></b></div>' +
      '<div class="row">На этом слайде: <b id="sec"></b></div></div>' +
      '<div class="box"><p class="k">Дальше</p><div class="nx" id="nx"></div></div></div>' +
      '<div class="btns"><button id="b-prev">← Назад</button><button id="b-next">Вперёд →</button><button id="b-reset">Сбросить таймер (R)</button>' +
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
    set('state', blackout.classList.contains('is-on') ? '· чёрный экран' : '');
    set('clock', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    set('th', esc(info(s)), true);
    set('st', s.max ? 'Шаг ' + s.shown + ' из ' + s.max : '');
    set('notes', notes ? notes.innerHTML : '<span style="color:var(--muted)">Заметок нет.</span>', true);
    set('el', mmss(elapsed));
    var el = d.getElementById('el'); if (el) el.className = 'el' + (elapsed > due ? ' late' : '');
    set('plan', mmss(PLAN));
    set('due', mmss(due));
    set('sec', mmss(s.sec));
    var nx = s.shown < s.max ? 'Шаг ' + (s.shown + 1) + ' из ' + s.max + ' на этом слайде'
      : slides[cur + 1] ? pad(slides[cur + 1].n) + ' · ' + info(slides[cur + 1]) : 'Конец доклада';
    set('nx', esc(nx), true);
  }

  /* ---------- Печать: на время печати все шаги раскрыты и все цифры горят, потом — как было */
  var printed = false;
  function beforePrint() {
    if (printed) return; printed = true;
    slides.forEach(function (s) {
      s.el.classList.add('is-instant');
      s.el.querySelectorAll('[data-step]').forEach(function (e) { e.classList.add('is-on'); });
      s.el.querySelectorAll('[data-ignite]').forEach(function (e) { e.classList.add('is-lit'); });
    });
  }
  function afterPrint() {
    if (!printed) return; printed = false;
    slides.forEach(function (s, i) {
      if (i === cur) { setSteps(s, s.shown); return; }
      s.el.classList.remove('is-instant');
      setSteps(s, s.shown);
      unlight(s);
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
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    var t = e.target;
    if (t.closest && t.closest('a, button, video, input, label, .help__box, [data-no-nav]')) return;
    if (help.classList.contains('is-on')) { toggleHelp(false); return; }
    var x = e.clientX / window.innerWidth;
    if (x < 0.2) prev(); else if (x > 0.8) next();
  });
  var tx = null, ty = null;
  document.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (tx === null) return;
    var dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; tx = ty = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) next(); else prev(); }
  });

  /* ---------- Старт */
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  window.addEventListener('hashchange', function () { var i = fromHash(); if (i !== cur) go(i, 'jump'); });
  window.addEventListener('beforeunload', function () { if (presenter && !presenter.closed) { try { presenter.close(); } catch (e) { /* окно уже закрыто */ } } });
  fit();
  go(fromHash(), 'jump');

  // Небольшой API для частей: переход, текущий номер, признак «уменьшенного движения».
  window.DECK = {
    go: function (n) { go(clamp(n, 1, slides.length) - 1, 'jump'); },
    next: next, prev: prev, reduced: reduced,
    get n() { return slides[cur] ? slides[cur].n : 0; },
    get total() { return slides.length; },
    burst: function (x0, x1, y, count) { ash.burst(x0, x1, y, count); }
  };
})();
