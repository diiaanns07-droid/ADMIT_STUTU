/* Слайды 8–10: что улучшили после первого этапа и планы развития.
 * 8 — «Было → стало»: шторка на весь экран, кадры Регента версии отбора (15298a8) и сегодняшнего main
 *     сняты стендом tools/boss_shots.mjs с одинаковых ракурсов в 1920×1080 — совпадают кадр в кадр;
 * 9 — «Три волны»: четыре цифры по шагам; старое значение собирается из искр, искры перестраиваются в новое;
 * 10 — «Что дальше»: дорожная карта «уже в игре → дальше → цель».
 * Обычный скрипт без модулей: работает и из file://. Регистрация — в window.DECK_QUEUE.
 * Конечное состояние слайдов описано в part3.css (через .is-on шагов) и стоит по умолчанию: вход назад,
 * переход по hash, печать и «уменьшенное движение» показывают его сразу. Скрипт только проигрывает путь к нему.
 * Цифры сверены по коду main на db29f87; база сравнения — версия отбора 15298a8 (30.09). */
(function () {
  'use strict';

  var AR = '<i class="arr"></i>';
  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function printing() { return !!(window.matchMedia && window.matchMedia('print').matches); }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function rgb(hex, fb) { var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return fb; var v = parseInt(m[1], 16); return [v >> 16 & 255, v >> 8 & 255, v & 255]; }
  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // ================================================================ 8. Было → стало: шторка на весь экран
  // Пара A — общий план боя, пара B (шаг 1) — Регент крупно. Шторка сама проезжает 1,2 с от края до середины
  // и открывает сегодняшний кадр справа; дальше её можно тянуть мышью или пальцем (data-interactive).
  var wipeT = [];
  function wipeOf(el) { return el.querySelector('.p3-wipe'); }
  function wipeClear() { wipeT.forEach(clearTimeout); wipeT = []; }
  function wipeReset(el) {
    var w = wipeOf(el); if (!w) return;
    w.style.removeProperty('--p3-xa'); w.style.removeProperty('--p3-xb');
    w.classList.remove('is-drag', 'is-pre');
  }
  function wipeBind(el) {
    var w = wipeOf(el); if (!w || w.p3Bound) return; w.p3Bound = true;
    function put(e) {
      var r = w.getBoundingClientRect(); if (!r.width) return;
      var x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
      wipeClear(); w.classList.remove('is-pre');
      w.style.setProperty(el.querySelector('[data-step="1"].is-on') ? '--p3-xb' : '--p3-xa', x.toFixed(2) + '%');
    }
    w.addEventListener('pointerdown', function (e) {
      if (e.button > 0) return;
      e.stopPropagation(); e.preventDefault();
      try { w.setPointerCapture(e.pointerId); } catch (err) { /* старый браузер — тянем без захвата */ }
      w.classList.add('is-drag'); put(e);
    });
    w.addEventListener('pointermove', function (e) { if (w.classList.contains('is-drag')) put(e); });
    function end() { w.classList.remove('is-drag'); }
    w.addEventListener('pointerup', end);
    w.addEventListener('pointercancel', end);
    w.addEventListener('click', function (e) { e.stopPropagation(); });
    w.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
    w.addEventListener('touchend', function (e) { e.stopPropagation(); });
  }
  // Проезд: стоим на «было» целиком, через паузу шторка едет к середине (переход в CSS, 1,2 с).
  function wipeRun(el, key, delay) {
    var w = wipeOf(el); if (!w || reduced()) return;
    var v = key === 'a' ? '--p3-xa' : '--p3-xb';
    w.classList.add('is-drag', 'is-pre'); w.style.setProperty(v, '100%'); void w.offsetWidth; w.classList.remove('is-drag');
    wipeT.push(setTimeout(function () { w.classList.remove('is-pre'); w.style.removeProperty(v); }, delay));
  }
  function pair(k, name, alt) {
    return '<div class="p3-wipe__pair p3-wipe__pair--' + k + '">' +
      '<img class="p3-wipe__img" src="media/p3/regent_' + name + '_before.jpg" alt="' + alt + ' — версия отбора, 30.09">' +
      '<span class="p3-wipe__tag p3-wipe__tag--before">Версия отбора · 30.09</span>' +
      '<div class="p3-wipe__after"><img class="p3-wipe__img" src="media/p3/regent_' + name + '_after.jpg" alt="' + alt + ' — сегодня, 03.10">' +
      '<span class="p3-wipe__tag p3-wipe__tag--after">Сегодня · 03.10</span></div>' +
      '<i class="p3-wipe__edge" aria-hidden="true"><i class="p3-wipe__knob"><i class="arr arr--back"></i><i class="arr"></i></i></i></div>';
  }
  Q.push({
    n: 8, sec: 45,
    html: `<section class="slide p3-slide p3-s8" data-slide="8" data-title="Было → стало">
  <figure class="p3-wipe" data-interactive aria-label="Шторка «было — стало»: её можно тянуть мышью">
    ${pair('a', 'game', 'Бой с Регентом')}
    ${pair('b', 'front', 'Регент Нимба крупно')}
  </figure>
  <i class="p3-s8__scrim" aria-hidden="true"></i>
  <p class="kicker">Что улучшили после отбора</p>
  <h2 class="title thesis">Тот же бой — другой уровень</h2>
  <p class="p3-s8__cap p3-s8__cap--a">Арена: живой огонь, мокрый пол</p>
  <p class="p3-s8__cap p3-s8__cap--b" data-step="1">Регент: обсидиан с&nbsp;золотом</p>
  <aside class="notes">Это один и тот же кадр: слева версия, которую жюри видело на отборе 30 сентября, справа — сегодняшний main. Шторку можно потянуть. Арена получила живой огонь и мокрый пол. Дальше — Регент крупно: теперь он из обсидиана с золотом, с короной-затмением.</aside>
</section>`,
    enter: function (el, dir) { wipeClear(); wipeReset(el); wipeBind(el); if (dir > 0) wipeRun(el, 'a', 500); },
    step: function (el, k) { wipeClear(); wipeReset(el); if (k === 1) wipeRun(el, 'b', 650); },
    leave: function (el) { wipeClear(); wipeReset(el); }
  });

  // ================================================================ 9. Три волны: цифры из искр
  // Наборы тестов считаются командой из README (tools/qa_node.mjs, dev/*.test.mjs, dev/*.test.js, dev/controls.soak.mjs):
  // на 15298a8 — 32, на db29f87 — 71, все проходят. Ассеты — папка assets/: 35,7 → 10,0 МиБ.
  // Каждый шаг — одна цифра. Сначала искры собираются в старое значение (тускло), потом перестраиваются
  // в новое (золотом) — видно, что именно изменилось. В конце искры гаснут, остаётся чёткий текст.
  var M = [
    { k: 'entry', label: 'Вход в бой', from: '6', fromU: 'кликов', to: '2', toU: 'клика', tag: 'Доступнее · 02.10' },
    { k: 'gest', label: 'Жесты', from: '20', fromU: 'жестов', to: '24', toU: 'жеста', tag: 'Глубже · 02.10' },
    { k: 'assets', label: 'Ассеты', from: '35,7', fromU: 'МБ', to: '10', toU: 'МБ', tag: 'Доступнее · 02.10' },
    { k: 'tests', label: 'Автотесты', from: '32', fromU: 'набора', to: '71', toU: 'набор', tag: 'Надёжнее · 0 падений' }
  ];
  var sp = { raf: 0, t: [], parts: null };
  function spStop() { cancelAnimationFrame(sp.raf); sp.raf = 0; sp.t.forEach(clearTimeout); sp.t = []; }
  // Точки текста: каждый символ элемента рисуем его же шрифтом на его месте в координатах холста.
  function sample(el, cv) {
    var W = cv.width, H = cv.height, g = document.createElement('canvas'); g.width = W; g.height = H;
    var x = g.getContext('2d'), cr = cv.getBoundingClientRect(), k = W / cr.width, range = document.createRange();
    x.fillStyle = '#fff';
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node;
    while ((node = walker.nextNode())) {
      var txt = node.nodeValue; if (!txt.trim()) continue;
      // Холст — в единицах сцены (W = ширина в CSS-пикселях), прямоугольники Range — в экранных: k их сводит.
      var cs = getComputedStyle(node.parentElement), fs = parseFloat(cs.fontSize) * W / cv.offsetWidth;
      x.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + fs + 'px ' + cs.fontFamily;
      x.textBaseline = 'alphabetic';
      // Прямоугольник символа начинается на высоте подъёма шрифта над базовой линией.
      var asc = x.measureText('Hg').fontBoundingBoxAscent || fs * .9;
      for (var i = 0; i < txt.length; i++) {
        if (!txt[i].trim()) continue;
        range.setStart(node, i); range.setEnd(node, i + 1);
        var r = range.getBoundingClientRect(); if (!r.width) continue;
        x.fillText(txt[i], (r.left - cr.left) * k, (r.top - cr.top) * k + asc);
      }
    }
    var d = x.getImageData(0, 0, W, H).data, pts = [];
    for (var step = 3; step < 9; step++) {
      pts = [];
      for (var yy = 0; yy < H; yy += step) for (var xx = 0; xx < W; xx += step) if (d[(yy * W + xx) * 4 + 3] > 128) pts.push(xx, yy);
      if (pts.length / 2 <= 2600) break;
    }
    return pts;
  }
  function burst(el, idx, first) {
    var cv = el.querySelector('.p3-s9__fx'), box = el.querySelector('.p3-s9__stage');
    var big = el.querySelector('.p3-big--' + M[idx].k);
    if (!cv || !big || reduced() || printing()) { if (box) box.classList.remove('is-sparking'); return; }
    var W = cv.width = Math.round(cv.offsetWidth), H = cv.height = Math.round(cv.offsetHeight), ctx = cv.getContext('2d');
    var oldP = sample(big.querySelector('.p3-big__from'), cv), newP = sample(big.querySelector('.p3-big__to'), cv);
    if (oldP.length < 40 || newP.length < 40) { box.classList.remove('is-sparking'); return; }
    var N = 1800, P = sp.parts;
    if (!P || first) { // первый показ: искры из тумана по всему холсту
      P = []; for (var i = 0; i < N; i++) P.push({ x: Math.random() * W, y: Math.random() * H, sx: 0, sy: 0, tx: 0, ty: 0, s: 1.4 + Math.random() * 1.6 });
    }
    sp.parts = P;
    var mut = rgb(token('--muted'), [185, 177, 161]), gold = rgb(token('--gold-hi'), [243, 220, 160]), ember = rgb(token('--ember'), [255, 138, 60]);
    function aim(pts) { // каждой искре — точка цели; лишние искры дублируют случайные точки
      var n = pts.length / 2;
      for (var i = 0; i < N; i++) { var j = (i < n ? i : (Math.random() * n) | 0) * 2; P[i].sx = P[i].x; P[i].sy = P[i].y; P[i].tx = pts[j] + (Math.random() - .5) * 1.5; P[i].ty = pts[j + 1] + (Math.random() - .5) * 1.5; P[i].d = Math.random() * .25; }
      for (var a = N - 1; a > 0; a--) { var b = (Math.random() * (a + 1)) | 0, tx = P[a].tx, ty = P[a].ty; P[a].tx = P[b].tx; P[a].ty = P[b].ty; P[b].tx = tx; P[b].ty = ty; }
    }
    function phase(pts, dur, col, swirl, done) {
      aim(pts); var t0 = 0;
      function frame(t) {
        if (!t0) t0 = t;
        var u = (t - t0) / dur; ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
        var settled = true;
        for (var i = 0; i < N; i++) {
          var p = P[i], v = Math.min(1, Math.max(0, (u - p.d) / (1 - .25))); if (v < 1) settled = false;
          var e = v < .5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2, a = 1 - e;
          // кривая через контрольную точку со сдвигом поперёк пути — искры закручиваются, а не едут по прямой
          var cx = (p.sx + p.tx) / 2 - (p.ty - p.sy) * swirl, cy = (p.sy + p.ty) / 2 + (p.tx - p.sx) * swirl;
          p.x = a * a * p.sx + 2 * a * e * cx + e * e * p.tx; p.y = a * a * p.sy + 2 * a * e * cy + e * e * p.ty;
          var c = v < 1 && v > .15 ? ember : col;
          ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (v < 1 ? .75 : .9) + ')';
          ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
        }
        ctx.globalCompositeOperation = 'source-over';
        if (!settled) sp.raf = requestAnimationFrame(frame); else done();
      }
      sp.raf = requestAnimationFrame(frame);
    }
    box.classList.add('is-sparking');
    phase(oldP, first ? 900 : 650, mut, first ? .35 : .18, function () {
      sp.t.push(setTimeout(function () {
        phase(newP, 900, gold, -.22, function () {
          box.classList.remove('is-sparking'); // чёткий текст проявляется, искры гаснут (CSS, 400 мс)
          sp.t.push(setTimeout(function () { ctx.clearRect(0, 0, W, H); }, 420));
        });
      }, 350));
    });
  }
  function big(m) {
    return '<div class="p3-big p3-big--' + m.k + '">' +
      '<p class="p3-big__from" aria-hidden="true"><span class="p3-big__n">' + m.from + '</span><span class="p3-big__u">' + m.fromU + '</span></p>' +
      '<p class="p3-big__to"><span class="p3-big__n">' + m.to + '</span><span class="p3-big__u">' + m.toU + '</span></p>' +
      '<p class="p3-big__tag">' + m.tag + '</p></div>';
  }
  function row(m, i) {
    return '<li class="p3-row p3-row--' + (i + 1) + '"' + (i ? ' data-step="' + i + '"' : '') + '><span class="p3-row__k">' + m.label + '</span>' +
      '<span class="p3-row__v">' + m.from + AR + m.to + '</span></li>';
  }
  Q.push({
    n: 9, sec: 45,
    html: `<section class="slide p3-slide p3-s9" data-slide="9" data-title="Три волны после отбора">
  <p class="kicker">После отбора · 30.09 ${AR} 03.10</p>
  <h2 class="title thesis">Доступнее, глубже, красивее</h2>
  <ol class="p3-rows">${M.map(row).join('')}</ol>
  <div class="p3-s9__stage">
    ${M.map(big).join('')}
    <canvas class="p3-s9__fx" aria-hidden="true"></canvas>
  </div>
  <aside class="notes">Три волны после отбора, 2 и 3 октября. Доступнее: вход в бой — два клика вместо шести, ассеты сжаты с 36 до 10 мегабайт, есть офлайн и режим «Новичок». Глубже: жестов стало 24 вместо 20 — «Врата бури», «Столп небес», ультимейт «Небесный суд». Красивее — это была шторка. И надёжнее: наборов автотестов 71 вместо 32, больше тысячи проверок, ни одного падения.</aside>
</section>`,
    enter: function (el, dir) {
      spStop(); sp.parts = null;
      if (dir > 0 && !reduced()) { el.querySelector('.p3-s9__stage').classList.add('is-sparking'); sp.t.push(setTimeout(function () { burst(el, 0, true); }, 350)); }
    },
    step: function (el, k) { spStop(); el.querySelector('.p3-s9__stage').classList.remove('is-sparking'); burst(el, k, false); },
    leave: function (el) { spStop(); var b = el.querySelector('.p3-s9__stage'); if (b) b.classList.remove('is-sparking'); }
  });

  // ================================================================ 10. Что дальше: дорожная карта
  // Дорога прочерчивается от станции к станции по шагам. Первая станция — то, что на отборе было «в работе»
  // и влито в main 03.10 (сборка 5: PR №39, лестница отката камеры, сложности до «Кошмара»); дальше — планы.
  // Станции стоят на точках дороги: (380, 130), (960, 100), (1540, 125) в координатах .p3-road (1920×660).
  var ROAD = 'M120 150 C 240 150, 290 130, 380 130 S 780 100, 960 100 S 1380 125, 1540 125 S 1740 116, 1800 114';
  Q.push({
    n: 10, sec: 40,
    html: `<section class="slide p3-slide p3-s10" data-slide="10" data-title="Что дальше">
  <p class="kicker">Планы развития</p>
  <h2 class="title thesis">Что дальше</h2>
  <div class="p3-road">
    <svg class="p3-road__svg" viewBox="0 0 1920 660" aria-hidden="true">
      <path class="p3-road__bed" d="${ROAD}"/>
      <path class="p3-road__lit p3-road__lit--1" pathLength="1" d="${ROAD}"/>
    </svg>
    <div class="p3-st p3-st--1">
      <i class="p3-st__gem" aria-hidden="true"></i>
      <p class="p3-st__k">Уже в игре · 03.10</p>
      <ul class="p3-st__list"><li class="chip">Быстрый вход</li><li class="chip">Камера на&nbsp;слабых ноутбуках</li><li class="chip">Сложность «Кошмар»</li></ul>
    </div>
    <div class="p3-st p3-st--2" data-step="1">
      <i class="p3-st__gem" aria-hidden="true"></i>
      <p class="p3-st__k">Дальше</p>
      <ul class="p3-st__list"><li class="chip">Казахский язык</li><li class="chip">Режим учителя</li></ul>
    </div>
    <div class="p3-st p3-st--3" data-step="2">
      <svg class="p3-st__rune" viewBox="-60 -60 120 120" aria-hidden="true"><circle r="54"/><circle r="40" class="p3-thin"/><path d="M0 -40 34.6 20H-34.6z"/><path d="M0 40-34.6-20H34.6z" class="p3-thin"/></svg>
      <p class="p3-st__k">Цель</p>
      <p class="p3-st__goal">Пилот в&nbsp;школе</p>
    </div>
  </div>
  <aside class="notes">То, что на отборе было в работе, уже в игре — влито 3 октября: быстрый вход; на слабом ноутбуке распознавание само спускается по ступеням — видеокарта в воркере, процессор в воркере, затем основной поток, — и камера не отваливается; две новые сложности — «Сложная» и «Кошмар». Дальше — казахский язык и режим учителя: класс играет, учитель видит технику каждого. Цель — пилот в школе: урок движения, где джойстик — это руки.</aside>
</section>`
  });
})();
