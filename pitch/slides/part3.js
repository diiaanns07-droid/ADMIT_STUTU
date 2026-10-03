/* Слайды 7–11: как это работает, проверка, что изменилось после отбора.
 * Порядок: 7 — MediaPipe даёт точки, жесты наши; 8 — проверено; 9 — таймлайн «После отбора»;
 * 10 — «Было → стало» (шторка); 11 — «Красивее — и загружается в 3,5 раза легче».
 * Обычный скрипт без модулей: работает и из file://. Регистрация — в window.DECK_QUEUE (контракт К3).
 * Конечное состояние каждого слайда описано в part3.css (через .is-on шагов) и стоит по умолчанию:
 * вход назад, переход по hash, печать и «уменьшенное движение» показывают его сразу. Скрипт только
 * проигрывает путь к нему при входе вперёд: проезд шторки и сгорание кадров. Счёт цифр (data-countup)
 * и перелёт миниатюры Регента (data-morph="regent") делает движок deck.js — общий договор с каркасом.
 * Цифры сверены на 63f908a (слияние PR №38, 03.10), база сравнения — версия отбора 15298a8 (30.09). */
(function () {
  'use strict';

  // Стрелка: в шрифтах нет «→», её рисует общий класс .arr из deck.css.
  var AR = '<i class="arr"></i>';

  function reduced() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function printing() { return !!(window.matchMedia && window.matchMedia('print').matches); }
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function rgb(hex, fb) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return fb;
    var v = parseInt(m[1], 16); return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  // Номер шага, в котором стоит элемент (0 — виден сразу).
  function stepOf(e, slide) {
    for (var p = e; p && p !== slide; p = p.parentElement) if (p.hasAttribute && p.hasAttribute('data-step')) return +p.getAttribute('data-step') || 0;
    return 0;
  }
  // Невидимые метки шагов: сами ничего не показывают, по ним part3.css переключает состояния (:has(.is-on)).
  function marks(n) { var s = ''; for (var i = 1; i <= n; i++) s += '<i data-step="' + i + '"></i>'; return '<span class="p3-marks" aria-hidden="true">' + s + '</span>'; }

  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // ================================================================ 7. MediaPipe даёт точки — жесты распознаём сами
  // Схема из прежней презентации (слайд «Как работает»), перекрашена токенами. Все узлы на месте сразу, тусклые;
  // по шагам по линии бежит светящаяся точка и зажигает следующий узел. У «21 точки» кисть сначала появляется
  // по точкам (это даёт MediaPipe), потом точки соединяются линиями.
  // Узел: x — левый край, 256×250 на высоте 70; иконка — в квадрате ~72 по центру сверху.
  function node(i, x, icon, title, sub) {
    var cx = x + 128, y = 70;
    return '<g class="p3-d-node p3-d-node--' + i + '">' +
      '<rect class="p3-d-box" x="' + x + '" y="' + y + '" width="256" height="250" rx="3"/>' +
      '<path class="p3-d-gem" d="M' + (x + 228) + ' ' + (y - 14) + 'l14 14-14 14-14-14z"/>' +
      '<g class="p3-d-ico" transform="translate(' + cx + ' ' + (y + 78) + ')">' + icon + '</g>' +
      '<text class="p3-d-t" x="' + cx + '" y="' + (y + 186) + '">' + title + '</text>' +
      (sub ? '<text class="p3-d-s" x="' + cx + '" y="' + (y + 226) + '">' + sub + '</text>' : '') + '</g>';
  }
  // 21 точка кисти — те же координаты, что на схеме прежней презентации; k — масштаб иконки.
  var HP = [[150,320],[105,295],[75,260],[55,228],[40,198],[115,190],[108,140],[104,108],[100,78],[150,185],[150,130],[150,95],[150,62],[183,192],[190,142],[194,110],[197,82],[212,208],[225,170],[233,146],[240,122]];
  var HB = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
  function hand(k) {
    function p(i) { return [((HP[i][0] - 140) * k).toFixed(1), ((HP[i][1] - 191) * k).toFixed(1)]; }
    return '<g class="p3-hand__bones">' + HB.map(function (b, j) { var a = p(b[0]), c = p(b[1]); return '<line pathLength="1" style="--j:' + j + '" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + c[0] + '" y2="' + c[1] + '"/>'; }).join('') + '</g>' +
      '<g class="p3-hand__pts">' + HP.map(function (_, i) { var a = p(i); return '<circle class="p3-d-pt" style="--i:' + i + '" cx="' + a[0] + '" cy="' + a[1] + '" r="' + (i % 4 === 0 && i ? 3.2 : 2.4) + '"/>'; }).join('') + '</g>';
  }
  var ICON = {
    cam: '<rect x="-30" y="-18" width="60" height="38" rx="6"/><circle cx="0" cy="1" r="11"/><circle cx="0" cy="1" r="4.5"/><path d="M-12 -18v-6h24v6"/>',
    chip: '<rect x="-22" y="-22" width="44" height="44" rx="4"/><rect x="-11" y="-11" width="22" height="22" rx="2"/><path d="M-12 -22v-8M0 -22v-8M12 -22v-8M-12 22v8M0 22v8M12 22v8M-22 -12h-8M-22 0h-8M-22 12h-8M22 -12h8M22 0h8M22 12h8"/>',
    fsm: '<circle cx="0" cy="-20" r="9"/><circle cx="-24" cy="18" r="9"/><circle cx="24" cy="18" r="9"/><path d="M-5 -12-17 9M5 -12 17 9M-14 18h28"/>',
    tri: '<path d="M0 -30 28 24H-28z"/><path d="M0 -12 13 14H-13z"/>'
  };
  var X = [0, 344, 698, 1052, 1406];
  var LINKS = [0, 1, 2, 3].map(function (i) {
    var a = X[i] + 260, b = X[i + 1] - 6;
    return '<g class="p3-d-link p3-d-link--' + (i + 1) + '"><path class="p3-d-a" d="M' + a + ' 195H' + b + '"/><path class="p3-d-hot" pathLength="1" d="M' + a + ' 195H' + b + '"/></g>';
  }).join('');
  // Скобки над узлами: что даёт библиотека (узлы 2–3) и что написано нами (узлы 4–5).
  var BRACES = '<g class="p3-d-brace p3-d-brace--lib"><path d="M344 34V20H954V34"/><text class="p3-d-k" x="649" y="2">MediaPipe</text></g>' +
    '<g class="p3-d-brace p3-d-brace--own"><path d="M1052 34V20H1662V34"/><text class="p3-d-k" x="1357" y="2">Наш код</text></g>';
  var SVG7 = '<svg class="p3-d" viewBox="0 -30 1680 360" role="img" aria-label="Схема: камера, MediaPipe на видеокарте, 21 точка кисти и поза, жесты нашим кодом, бой на three.js">' +
    '<defs><marker id="p3-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" class="p3-d-ah"/></marker></defs>' +
    BRACES + LINKS +
    node(1, X[0], ICON.cam, 'Камера', '') +
    node(2, X[1], ICON.chip, 'MediaPipe', 'GPU') +
    node(3, X[2], '<g class="p3-hand">' + hand(0.4) + '</g>', '21 точка', '× 2 + поза') +
    node(4, X[3], ICON.fsm, 'Жесты', '') +
    node(5, X[4], ICON.tri, 'Бой', 'three.js') +
    '<circle class="p3-d-dot" cx="0" cy="195" r="9"/>' +
    '</svg>';

  Q.push({
    n: 7, sec: 40,
    html: `<section class="slide p3-slide p3-s7" data-slide="7" data-title="Как это работает">
  <p class="kicker">Под капотом</p>
  <h2 class="thesis">MediaPipe даёт точки — жесты распознаём сами</h2>
  <div class="p3-body">
    ${marks(4)}
    <div class="p3-s7__diagram">${SVG7}</div>
    <ul class="p3-s7__facts">
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M10 38V10h28v28z"/><path d="M19 19l-5 5 5 5M29 19l5 5-5 5"/></svg><span><b>24 жеста, автоматы состояний и 63 подсказки</b> — наш код</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34h21a8 8 0 0 0 1-15.9A11 11 0 0 0 15 16a9 9 0 0 0-1 18z"/><path d="M8 42 40 8"/></svg><span><b>Видео не уходит в сеть</b></span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M6 16 24 7l18 9v18l-18 9-18-9z"/><path d="M6 16l18 9 18-9M24 25v18"/></svg><span><b>Без интернета:</b> всё в vendor/, service worker</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M7 34a17 17 0 1 1 34 0"/><path d="M24 34 33 20"/><circle cx="24" cy="34" r="3"/></svg><span><b>Слабый ноутбук:</b> автонастройка качества, лёгкая модель позы</span></li>
    </ul>
  </div>
  <aside class="notes">Камера даёт кадр. MediaPipe на видеокарте превращает его в точки: двадцать одна на каждую кисть и поза тела — вот они появляются. Всё дальше — наш код: точки складываются в кисть, кисть — в 24 жеста, автоматы состояний и 63 подсказки «ОШИБКА», и уже это управляет боем. Видео не покидает ноутбук, все библиотеки лежат в репозитории — игра работает без интернета, на сцене и в школе. На слабом ноутбуке игра сама снижает качество и берёт лёгкую модель позы.</aside>
</section>`
  });

  // ================================================================ 8. Проверено: счётчики и шкалы
  // Цифры считает движок (data-countup, 600 мс), шкала под цифрой заполняется за то же время (part3.css).
  Q.push({
    n: 8, sec: 35,
    html: `<section class="slide p3-slide p3-s8" data-slide="8" data-title="Проверено">
  <p class="kicker">Проверка</p>
  <h2 class="thesis">Сложно — и проверено</h2>
  <div class="p3-body">
    <div class="p3-s8__tiles">
      <article class="corner p3-tile">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-36 -40 72 80" aria-hidden="true"><g class="p3-hand p3-hand--still">${hand(0.25)}</g></svg>
        <span class="num"><span data-countup="96">96</span>&nbsp;%</span>
        <span class="p3-meter" aria-hidden="true"><i class="p3-meter__fill" style="--v:.96"></i></span>
        <p class="p3-tile__txt">формы кисти на&nbsp;135 реальных фото <span class="p3-dim">(HaGRID)</span></p>
      </article>
      <article class="corner p3-tile" data-step="1">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="0 0 84 72" aria-hidden="true"><path d="M2 58h80"/><path class="p3-ticks" d="M7 52V22M17 52V22M27 52V22M37 52V22M47 52V22M57 52V22M67 52V22M77 52V22"/></svg>
        <span class="num"><span data-countup="8">8</span><span class="unit p3-hz">Гц</span></span>
        <span class="p3-meter p3-meter--range" aria-hidden="true"><i class="p3-meter__fill" style="--v:.83"></i></span>
        <p class="p3-tile__txt">распознавание 8&nbsp;раз в&nbsp;секунду: <span class="p3-nw">83–100&nbsp;%</span> попыток, 0&nbsp;ложных <span class="p3-dim">· синтетический тест</span></p>
      </article>
      <article class="corner p3-tile" data-step="2">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-40 -40 80 80" aria-hidden="true"><circle r="30"/><circle r="22" class="p3-thin"/><path d="M-12 1 -3 10 14 -9"/></svg>
        <span class="num"><span data-countup="1050">1050</span>+</span>
        <span class="p3-meter p3-meter--was" aria-hidden="true" style="--was:.525"><i class="p3-meter__fill" style="--v:1"></i></span>
        <p class="p3-tile__txt">проверок, 0&nbsp;падений; наборов <span class="p3-nw">31 ${AR} 59</span></p>
      </article>
    </div>
    <p class="src p3-s8__src">dev/handGestures.real.test.mjs · dev/lowfps.test.mjs · прогон всех наборов</p>
  </div>
  <aside class="notes">Жесты проверены на 135 реальных фотографиях рук из датасета HaGRID: 96 % форм кисти распознаются верно. В синтетическом тесте при 8 кадрах распознавания в секунду — это старый школьный ноутбук — жесты срабатывают в 83–100 % попыток и ни разу не ложно. Наборов тестов стало 59 вместо 31 — отметка на шкале, — больше 1050 проверок, ни одного падения.</aside>
</section>`
  });

  // ================================================================ 9. После отбора: таймлайн «Ярость клятвы»
  // На каждом шаге шкала доливается до узла, узел раскрывается и показывает две миниатюры волны.
  // Миниатюра Регента (data-morph="regent") при переходе на слайд 10 вырастает в кадр «после» шторки (движок).
  function thumbs(a, b) {
    return '<span class="p3-tl__thumbs">' + [a, b].map(function (t) {
      return '<img class="p3-tl__thumb" src="' + t[0] + '" alt="' + t[1] + '"' + (t[2] ? ' data-morph="' + t[2] + '"' : '') + ' width="400" height="225" decoding="async">';
    }).join('') + '</span>';
  }
  Q.push({
    n: 9, sec: 45,
    html: `<section class="slide p3-slide p3-s9" data-slide="9" data-title="После отбора">
  <p class="kicker">После отбора</p>
  <h2 class="thesis">Три волны до финала</h2>
  <div class="p3-body">
    <div class="p3-tl">
      <div class="p3-tl__rail" aria-hidden="true">
        <i class="p3-tl__fill p3-tl__fill--1"></i><i class="p3-tl__fill p3-tl__fill--2"></i><i class="p3-tl__fill p3-tl__fill--3"></i>
      </div>
      <ol class="p3-tl__nodes">
        <li class="p3-tl__node p3-tl__node--base">
          <span class="p3-tl__gem" aria-hidden="true"></span>
          <span class="p3-tl__date">30.09</span>
          <span class="p3-tl__name">версия отбора <span class="p3-tl__hash">15298a8</span></span>
        </li>
        <li class="p3-tl__node" data-step="1"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">02.10</span><h3 class="p3-tl__name">Доступнее</h3>
          ${thumbs(['media/p3/t_novice.jpg', 'Меню с режимом «Новичок»'], ['media/p3/t_autowalk.jpg', 'Автоход ведёт героя к Регенту'])}</li>
        <li class="p3-tl__node" data-step="2"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">02.10</span><h3 class="p3-tl__name">Глубже</h3>
          ${thumbs(['media/p3/t_ult.jpg', 'Ультимейт «Небесный суд»'], ['media/p3/t_challenge.jpg', '«Испытание · 60 с»: обратный отсчёт'])}</li>
        <li class="p3-tl__node" data-step="3"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">03.10</span><h3 class="p3-tl__name">Красивее</h3>
          ${thumbs(['media/p3/regent_after.jpg', 'Новый Регент: обсидиан с золотом', 'regent'], ['media/p3/t_attire.jpg', 'Новый наряд эльфийки'])}</li>
      </ol>
    </div>
    <ul class="p3-s9__nums">
      <li><span class="p3-s9__label">Вход в бой</span><span class="p3-s9__row"><span class="num" data-ignite>6${AR}2</span><span class="unit">клика</span></span></li>
      <li><span class="p3-s9__label">Жесты</span><span class="p3-s9__row"><span class="num">20${AR}24</span></span></li>
      <li><span class="p3-s9__label">Ассеты</span><span class="p3-s9__row"><span class="num">36${AR}10</span><span class="unit">МБ</span></span></li>
    </ul>
  </div>
  <aside class="notes">База — версия отбора от 30 сентября, коммит 15298a8. Первая волна, 2 октября — доступнее: режим «Новичок» и автоход, жесты держатся на 8–15 кадрах распознавания в секунду, вход в бой за два клика вместо шести, офлайн, свой звук, ассеты сжаты с 36 до 10 мегабайт. Вторая волна, тоже 2 октября — глубже: «Врата бури», «Столп небес», ультимейт «Небесный суд», «Дух игрока», «Испытание · 60 с», голос тренера, курсор-кисть; жестов стало 24 вместо 20. Третья, 3 октября — красивее: новый Регент, интерфейс уровня RPG, арена, лица, волосы и наряды героев, аура и витрина меню. Дальше посмотрим на Регента поближе.</aside>
</section>`
  });

  // ================================================================ 10. Было → стало: шторка
  // Первая пара — Регент (в неё прилетает миниатюра со слайда 9), шторка сама проезжает за 1,2 с до середины;
  // вторая пара — меню (шаг 1), шторка открывает его целиком. Дальше шторку можно тянуть мышью или пальцем.
  // Конечные положения (Регент — 50 %, меню — 0 %) заданы в part3.css; скрипт только проигрывает проезд.
  var wipeT = [];
  function wipeOf(el) { return el.querySelector('.p3-wipe'); }
  function wipeClear() { wipeT.forEach(clearTimeout); wipeT = []; }
  function wipeReset(el) {
    var w = wipeOf(el); if (!w) return;
    w.style.removeProperty('--p3-xa'); w.style.removeProperty('--p3-xb');
    w.classList.remove('is-drag', 'is-split', 'is-pre');
  }
  function wipeBind(el) {
    var w = wipeOf(el); if (!w || w.p3Bound) return; w.p3Bound = true;
    function put(e) {
      var r = w.getBoundingClientRect(); if (!r.width) return;
      var x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
      var second = !!el.querySelector('[data-step="1"].is-on');
      wipeClear(); w.classList.remove('is-pre');
      w.style.setProperty(second ? '--p3-xb' : '--p3-xa', x.toFixed(2) + '%');
      w.classList.toggle('is-split', x > 0.5 && x < 99.5);
    }
    // Щелчки и свайпы по шторке слайды не листают (у шторки data-interactive, касания гасим здесь).
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
  function wipeIntro(el, info) {
    var w = wipeOf(el); if (!w || reduced()) return;
    // Регент: стоит «после» целиком, затем шторка сама уезжает к середине и открывает «было» слева.
    w.classList.add('is-drag', 'is-pre'); w.style.setProperty('--p3-xa', '0%'); void w.offsetWidth; w.classList.remove('is-drag');
    // со слайда 9 сюда перелетает миниатюра Регента (data-morph, 550 мс) — шторка трогается после посадки
    var wait = (info && info.prev === 9 ? 600 : 0) + 200;
    wipeT.push(setTimeout(function () { w.classList.remove('is-pre'); w.style.removeProperty('--p3-xa'); }, wait));
  }

  Q.push({
    n: 10, sec: 50,
    html: `<section class="slide p3-slide p3-s10" data-slide="10" data-title="Было → стало">
  <p class="kicker">Было ${AR} стало</p>
  <h2 class="thesis">Та же игра, другой уровень</h2>
  <div class="p3-body">
    <figure class="p3-wipe" data-interactive aria-label="Шторка «до и после»: её можно тянуть мышью">
      <div class="p3-wipe__pair p3-wipe__pair--a">
        <img class="p3-wipe__img" src="media/p3/regent_before.jpg" alt="Регент Нимба в версии отбора">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="media/p3/regent_after.jpg" alt="Регент Нимба 3 октября: обсидиан с золотом" data-morph="regent">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
      <div class="p3-wipe__pair p3-wipe__pair--b">
        <img class="p3-wipe__img" src="../docs/screenshots/menu.jpg" alt="Меню в версии отбора: три кнопки">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="../docs/screenshots/w4-check/01_menu.jpg" alt="Меню 3 октября: пять режимов и книга заклинаний">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
    </figure>
    <ol class="p3-s10__caps">
      <li class="p3-s10__cap p3-s10__cap--a"><b>Регент:</b> обсидиан с золотом, корона-затмение</li>
      <li class="p3-s10__cap p3-s10__cap--b" data-step="1"><b>Меню:</b> 3 кнопки ${AR} 5 режимов и книга заклинаний</li>
    </ol>
    <div class="p3-s10__battle">
      <p class="p3-s10__cap"><b>Бой:</b> отладка ${AR} интерфейс RPG</p>
      <img class="p3-s10__shot" src="../docs/screenshots/battle.jpg" alt="Бой в версии отбора: отладочные надписи">
      ${AR}
      <img class="p3-s10__shot" src="../docs/screenshots/w4-check/03_battle.jpg" alt="Бой 3 октября: интерфейс RPG">
    </div>
    <p class="cap p3-s10__note">Кадры боя сняты с клавиатуры, с разных точек.</p>
  </div>
  <aside class="notes">Справа — сегодняшний main, слева — то, что видело жюри на отборе, тот же кадр. Регент теперь из обсидиана с золотом, с короной-затмением. В меню вместо трёх кнопок — пять режимов и книга заклинаний. Шторку можно потянуть мышью. Бой снят с разных точек, поэтому показываем его рядом: вместо отладочных надписей — интерфейс уровня RPG с «Яростью клятвы» и «Духом игрока».</aside>
</section>`,
    enter: function (el, dir, info) { wipeClear(); wipeReset(el); wipeBind(el); if (dir > 0) wipeIntro(el, info); },
    leave: function (el) { wipeClear(); wipeReset(el); },
    step: function (el) { wipeClear(); wipeReset(el); }
  });

  // ================================================================ 11. Красивее — и загружается в 3,5 раза легче
  // Пары «до → после» по шагам, крупно. Старый кадр выгорает по шумовой маске (900 мс) с искрами по кромке,
  // под ним — новый. По умолчанию (печать, вход назад, «уменьшенное движение») виден кадр «после».
  // Тезис «легче в бою» не держим: после визуальной волны высокое качество упирается в процессор (1c2c4ad).
  // «Легче» — про загрузку: assets/ 35,7 → 10,0 МБ (git ls-tree, 15298a8 → 63f908a; сжатие — eca6f51).
  var burnRaf = 0, burnT = [];
  function burnStop(el) {
    cancelAnimationFrame(burnRaf); burnRaf = 0; burnT.forEach(clearTimeout); burnT = [];
    if (el) el.querySelectorAll('.p3-burn__pair').forEach(function (p) {
      p.classList.remove('is-before', 'is-burning');
      var c = p.querySelector('canvas'); if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    });
  }
  // Шум: два октава сглаженного случайного поля + наклон снизу вверх (огонь идёт от нижнего края).
  var GW = 450, GH = 253;   // маска — в половину разрешения кадра 900×506: кромка без ступенек
  function noiseField(seed) {
    var r = seed * 9301 + 49297;
    function rnd() { r = (r * 9301 + 49297) % 233280; return r / 233280; }
    function octave(cw, ch) {
      var g = []; for (var i = 0; i < (cw + 1) * (ch + 1); i++) g.push(rnd());
      return function (x, y) {
        var fx = x / GW * cw, fy = y / GH * ch, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        var a = g[iy * (cw + 1) + ix], b = g[iy * (cw + 1) + ix + 1], c = g[(iy + 1) * (cw + 1) + ix], d = g[(iy + 1) * (cw + 1) + ix + 1];
        return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
      };
    }
    var o1 = octave(7, 4), o2 = octave(16, 9), o3 = octave(34, 19), f = new Float32Array(GW * GH), lo = 9, hi = -9;
    for (var y = 0; y < GH; y++) for (var x = 0; x < GW; x++) {
      var v = .5 * o1(x, y) + .3 * o2(x, y) + .2 * o3(x, y);
      v = .6 * v + .4 * (1 - y / (GH - 1));
      f[y * GW + x] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    for (var i2 = 0; i2 < f.length; i2++) f[i2] = (f[i2] - lo) / (hi - lo);
    return f;
  }
  function burn(pair, idx) {
    var cv = pair.querySelector('canvas'), before = pair.querySelector('.p3-burn__before');
    if (!cv || !before) return;
    var W = cv.width = 900, H = cv.height = 506, ctx = cv.getContext('2d');
    var field = pair.p3Field || (pair.p3Field = noiseField(idx + 3));
    // три слоя маски: что осталось от старого кадра, подпалина у кромки, светящаяся линия огня
    var mask = document.createElement('canvas'), char = document.createElement('canvas'), glow = document.createElement('canvas');
    mask.width = char.width = glow.width = GW; mask.height = char.height = glow.height = GH;
    var mctx = mask.getContext('2d'), cctx = char.getContext('2d'), gctx = glow.getContext('2d');
    var mimg = mctx.createImageData(GW, GH), cimg = cctx.createImageData(GW, GH), gimg = gctx.createImageData(GW, GH);
    var ember = rgb(token('--ember'), [255, 138, 60]), hot = rgb(token('--gold-hi'), [243, 220, 160]), ink = rgb(token('--ink'), [11, 10, 9]);
    for (var q = 0; q < GW * GH; q++) { cimg.data[q * 4] = ink[0]; cimg.data[q * 4 + 1] = ink[1]; cimg.data[q * 4 + 2] = ink[2]; }
    // спрайт искры: мягкое пятно из токенов
    var sp = document.createElement('canvas'); sp.width = sp.height = 24;
    var sg = sp.getContext('2d'), rg = sg.createRadialGradient(12, 12, 0, 12, 12, 12);
    rg.addColorStop(0, 'rgba(' + hot.join(',') + ',1)'); rg.addColorStop(.35, 'rgba(' + ember.join(',') + ',.8)'); rg.addColorStop(1, 'rgba(' + ember.join(',') + ',0)');
    sg.fillStyle = rg; sg.fillRect(0, 0, 24, 24);
    function cover() { // кадр «до» по размеру холста (object-fit: cover)
      var iw = before.naturalWidth, ih = before.naturalHeight, k = Math.max(W / iw, H / ih), dw = iw * k, dh = ih * k;
      ctx.drawImage(before, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    var BAND = .07, DUR = 900, sparks = [], t0 = 0, last = 0;
    ctx.clearRect(0, 0, W, H); cover();
    pair.classList.add('is-before');
    function frame(t) {
      if (!t0) { t0 = t; last = t; }
      var dt = Math.min(.05, (t - last) / 1000); last = t;
      var k = Math.min(1, (t - t0) / DUR), T = -BAND + k * (1 + 2 * BAND);
      var md = mimg.data, cd = cimg.data, gd = gimg.data, edge = [];
      for (var i = 0; i < GW * GH; i++) {
        var dlt = field[i] - T, j = i * 4;
        md[j + 3] = dlt <= 0 ? 0 : dlt >= BAND * .12 ? 255 : dlt / (BAND * .12) * 255;
        cd[j + 3] = dlt <= 0 || dlt >= BAND ? 0 : Math.pow(1 - dlt / BAND, 1.6) * 220;
        var g = dlt >= 0 ? 1 - dlt / (BAND * .35) : 1 - -dlt / (BAND * .25);
        if (g > 0) {
          var c = g > .55 ? hot : ember;
          gd[j] = c[0]; gd[j + 1] = c[1]; gd[j + 2] = c[2]; gd[j + 3] = g * 255;
          if (g > .7 && edge.length < 1500 && (i & 7) === 0) edge.push(i);
        } else gd[j + 3] = 0;
      }
      mctx.putImageData(mimg, 0, 0); cctx.putImageData(cimg, 0, 0); gctx.putImageData(gimg, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      if (k < 1) {
        cover();
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, W, H);
        ctx.globalCompositeOperation = 'source-atop'; ctx.drawImage(char, 0, 0, W, H);
        ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(glow, 0, 0, W, H);
      }
      // искры: рождаются на горящей кромке, летят вверх и гаснут; не больше 60 разом
      if (k < 1) for (var n = 0; n < 3 && edge.length && sparks.length < 60; n++) {
        var e = edge[(Math.random() * edge.length) | 0];
        sparks.push({ x: (e % GW + Math.random()) * W / GW, y: (((e / GW) | 0) + Math.random()) * H / GH, vx: (Math.random() - .5) * 60, vy: -(60 + Math.random() * 120), age: 0, life: .45 + Math.random() * .4, r: 6 + Math.random() * 8 });
      }
      ctx.globalCompositeOperation = 'lighter';
      for (var s = 0; s < sparks.length; s++) {
        var p = sparks[s]; p.age += dt;
        if (p.age >= p.life) { sparks.splice(s--, 1); continue; }
        p.vy -= 40 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        ctx.globalAlpha = Math.pow(1 - p.age / p.life, 1.5);
        ctx.drawImage(sp, p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (k < 1 || sparks.length) burnRaf = requestAnimationFrame(frame);
      else { ctx.clearRect(0, 0, W, H); pair.classList.remove('is-burning'); burnRaf = 0; }
    }
    burnT.push(setTimeout(function () {
      pair.classList.remove('is-before'); pair.classList.add('is-burning');
      burnRaf = requestAnimationFrame(frame);
    }, 800));
  }
  function burnPair(el, i) {
    if (reduced() || printing()) return;
    var pair = el.querySelector('.p3-burn__pair--' + i); if (!pair) return;
    var img = pair.querySelector('.p3-burn__before');
    if (img.complete && img.naturalWidth) burn(pair, i);
    else img.addEventListener('load', function () { burn(pair, i); }, { once: true });
  }
  function bpair(i, before, after, alt) {
    return '<div class="p3-burn__pair p3-burn__pair--' + i + '">' +
      '<img class="p3-burn__after" src="' + after + '" alt="' + alt + ' — после">' +
      '<img class="p3-burn__before" src="' + before + '" alt="' + alt + ' — до">' +
      '<canvas class="p3-burn__fx" width="900" height="506" aria-hidden="true"></canvas>' +
      '<span class="p3-burn__tag p3-burn__tag--before">до</span><span class="p3-burn__tag p3-burn__tag--after">после</span></div>';
  }

  Q.push({
    n: 11, sec: 35,
    html: `<section class="slide p3-slide p3-s11" data-slide="11" data-title="Красивее и легче">
  <p class="kicker">Картинка</p>
  <h2 class="thesis">Красивее — и&nbsp;загружается в&nbsp;3,5&nbsp;раза легче</h2>
  <div class="p3-body">
    <figure class="p3-burn">
      ${bpair(1, 'media/p3/burn1_before.jpg', 'media/p3/burn1_after.jpg', 'Наряд эльфийки')}
      ${bpair(2, 'media/p3/burn2_before.jpg', 'media/p3/burn2_after.jpg', 'Аура героя')}
      ${bpair(3, 'media/p3/burn3_before.jpg', 'media/p3/burn3_after.jpg', 'Удар по щиту Регента')}
    </figure>
    <div class="p3-s11__stat">
      <span class="num" data-ignite>3,5×</span>
      <span class="unit">ассеты 35,7 ${AR} 10&nbsp;МБ</span>
      <p class="cap">модели — meshopt, текстуры — WebP</p>
    </div>
    <ol class="p3-s11__caps">
      <li class="p3-s11__cap p3-s11__cap--1"><b>Наряды:</b> лепестки, звёздные полы</li>
      <li class="p3-s11__cap p3-s11__cap--2" data-step="1"><b>Аура:</b> контровой свет, руна «Ярости»</li>
      <li class="p3-s11__cap p3-s11__cap--3" data-step="2"><b>Удары:</b> щит звенит и&nbsp;ломается</li>
    </ol>
    <p class="src p3-s11__src">−26&nbsp;% вызовов отрисовки — до/после визуальной волны 03.10, docs/visual-budget.md</p>
  </div>
  <aside class="notes">Картинка стала другой. Наряды героев — лепестки эльфийки, корсет лучницы, звёздные полы чародейки. Аура — контровой свет и руна «Ярости» под ногами. Удары — щит звенит и ломается, броня трескается. При этом игра загружается в три с половиной раза легче: ассеты сжались с 36 до 10 мегабайт — модели через meshopt, текстуры в WebP.</aside>
</section>`,
    enter: function (el, dir) { burnStop(el); if (dir > 0) burnPair(el, 1); },
    step: function (el, k) { burnStop(el); burnPair(el, k + 1); },
    leave: function (el) { burnStop(el); }
  });
})();
