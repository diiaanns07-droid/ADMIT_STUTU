/* Слайды 7–11: как это работает, проверка, что изменилось после отбора.
 * Порядок: 7 — MediaPipe даёт точки, жесты наши; 8 — проверено; 9 — таймлайн «После отбора»;
 * 10 — «Было → стало» (шторка); 11 — «Красивее — и загружается в 3,5 раза легче».
 * Обычный скрипт без модулей: работает и из file://. Регистрация — в window.DECK_QUEUE (контракт К3).
 * Состояния шагов (заливка «Ярости», шторка, свет по схеме) описаны в part3.css через .is-on,
 * поэтому при входе назад и в печати слайд показан целиком без участия скрипта.
 * Цифры сверены на 63f908a (слияние PR №38, 03.10), база сравнения — версия отбора 15298a8 (30.09). */
(function () {
  'use strict';

  // Стрелка: в шрифтах нет «→», рисует общий класс .arr (запасной вид — в part3.css).
  var AR = '<i class="arr"></i>';

  // ---------------------------------------------------------------- шторка света: перетаскивание
  function wipeOf(el) { return el.querySelector('.p3-wipe'); }
  function wipeReset(el) {
    var w = wipeOf(el); if (!w) return;
    w.style.removeProperty('--p3-xa'); w.style.removeProperty('--p3-xb');
    w.classList.remove('is-drag', 'is-split');
  }
  function wipeBind(el) {
    var w = wipeOf(el); if (!w || w.p3Bound) return; w.p3Bound = true;
    function put(e) {
      var r = w.getBoundingClientRect(); if (!r.width) return;
      var x = Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
      var second = !!el.querySelector('[data-step="2"].is-on');
      w.style.setProperty(second ? '--p3-xb' : '--p3-xa', x.toFixed(2) + '%');
      w.classList.toggle('is-split', x > 0.5 && x < 99.5);
    }
    // Шторку тянут мышью или пальцем; щелчки и свайпы по ней слайды не листают.
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

  // Видео, которое браузер не может проиграть (нет H.264 — например, Chromium без кодеков), прячет постер.
  // Тогда на его месте показываем тот же кадр — .print-poster рядом с видео.
  function videoFallback(el) {
    el.querySelectorAll('video').forEach(function (v) {
      var box = v.parentNode; box.classList.remove('p3-vid-failed');
      if (v.p3Bound) return; v.p3Bound = true;
      v.addEventListener('error', function () { if (v.getAttribute('src')) box.classList.add('p3-vid-failed'); });
    });
  }

  var Q = (window.DECK_QUEUE = window.DECK_QUEUE || []);

  // ---------------------------------------------------------------- 7. MediaPipe даёт точки — жесты распознаём сами
  // Схема из прежней презентации (слайд «Как работает»), упрощена до пяти узлов и перекрашена токенами.
  // Узел: x — левый край, 256×250 на высоте 70; иконка — в квадрате 72 по центру сверху.
  function node(i, x, icon, title, sub) {
    var cx = x + 128, y = 70;
    return '<g class="p3-d-node p3-d-node--' + i + '">' +
      '<rect class="p3-d-box" x="' + x + '" y="' + y + '" width="256" height="250" rx="3"/>' +
      '<path class="p3-d-gem" d="M' + (x + 228) + ' ' + (y - 14) + 'l14 14-14 14-14-14z"/>' +
      '<g class="p3-d-ico" transform="translate(' + cx + ' ' + (y + 78) + ')">' + icon + '</g>' +
      '<text class="p3-d-t" x="' + cx + '" y="' + (y + 186) + '">' + title + '</text>' +
      (sub ? '<text class="p3-d-s" x="' + cx + '" y="' + (y + 226) + '">' + sub + '</text>' : '') + '</g>';
  }
  var HAND = (function () {
    // 21 точка кисти — те же координаты, что на схеме прежней презентации, в масштабе иконки.
    var P = [[150,320],[105,295],[75,260],[55,228],[40,198],[115,190],[108,140],[104,108],[100,78],[150,185],[150,130],[150,95],[150,62],[183,192],[190,142],[194,110],[197,82],[212,208],[225,170],[233,146],[240,122]];
    var B = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
    var k = 0.25, ox = -140, oy = -191;
    function p(i) { return [((P[i][0] + ox) * k).toFixed(1), ((P[i][1] + oy) * k).toFixed(1)]; }
    return B.map(function (b) { var a = p(b[0]), c = p(b[1]); return '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + c[0] + '" y2="' + c[1] + '"/>'; }).join('') +
      P.map(function (_, i) { var a = p(i); return '<circle class="p3-d-pt" cx="' + a[0] + '" cy="' + a[1] + '" r="' + (i % 4 === 0 && i ? 3 : 2.2) + '"/>'; }).join('');
  })();
  var ICON = {
    cam: '<rect x="-30" y="-18" width="60" height="38" rx="6"/><circle cx="0" cy="1" r="11"/><circle cx="0" cy="1" r="4.5"/><path d="M-12 -18v-6h24v6"/>',
    chip: '<rect x="-22" y="-22" width="44" height="44" rx="4"/><rect x="-11" y="-11" width="22" height="22" rx="2"/><path d="M-12 -22v-8M0 -22v-8M12 -22v-8M-12 22v8M0 22v8M12 22v8M-22 -12h-8M-22 0h-8M-22 12h-8M22 -12h8M22 0h8M22 12h8"/>',
    hand: HAND,
    fsm: '<circle cx="0" cy="-20" r="9"/><circle cx="-24" cy="18" r="9"/><circle cx="24" cy="18" r="9"/><path d="M-5 -12-17 9M5 -12 17 9M-14 18h28"/>',
    tri: '<path d="M0 -30 28 24H-28z"/><path d="M0 -12 13 14H-13z"/>'
  };
  var X = [0, 344, 698, 1052, 1406];
  var GAP = [0, 1, 2, 3].map(function (i) {
    var a = X[i] + 260, b = X[i + 1] - 6;
    return '<g class="p3-d-link p3-d-link--' + (i + 1) + '"><path class="p3-d-a" d="M' + a + ' 195H' + b + '"/><path class="p3-d-run" pathLength="100" d="M' + a + ' 195H' + b + '"/></g>';
  });
  // Скобки над узлами: что даёт библиотека (узлы 2–3) и что написано нами (узлы 4–5).
  var BR_LIB = '<g class="p3-d-brace"><path d="M344 34V20H954V34"/><text class="p3-d-k" x="649" y="2">MediaPipe</text></g>';
  var BR_OWN = '<g class="p3-d-brace p3-d-brace--own"><path d="M1052 34V20H1662V34"/><text class="p3-d-k" x="1357" y="2">Наш код</text></g>';
  var SVG7 = '<svg class="p3-d" viewBox="0 -30 1680 360" role="img" aria-label="Схема: камера, MediaPipe на видеокарте, 21 точка кисти и поза, жесты нашим кодом, бой на three.js">' +
    '<defs><marker id="p3-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z" class="p3-d-ah"/></marker></defs>' +
    node(1, X[0], ICON.cam, 'Камера', '') +
    '<g data-step="1">' + GAP[0] + node(2, X[1], ICON.chip, 'MediaPipe', 'GPU') + '</g>' +
    '<g data-step="2">' + GAP[1] + node(3, X[2], ICON.hand, '21 точка', '× 2 + поза') + BR_LIB + '</g>' +
    '<g data-step="3">' + GAP[2] + node(4, X[3], ICON.fsm, 'Жесты', '') + '</g>' +
    '<g data-step="4">' + GAP[3] + node(5, X[4], ICON.tri, 'Бой', 'three.js') + BR_OWN + '</g>' +
    '</svg>';

  Q.push({
    n: 7, sec: 40,
    html: `<section class="slide p3-slide p3-s7" data-slide="7" data-title="Как это работает">
  <p class="kicker">Под капотом</p>
  <h2 class="thesis">MediaPipe даёт точки — жесты распознаём сами</h2>
  <div class="p3-body">
    <div class="p3-s7__diagram">${SVG7}</div>
    <ul class="p3-s7__facts">
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M10 38V10h28v28z"/><path d="M19 19l-5 5 5 5M29 19l5 5-5 5"/></svg><span><b>24 жеста, автоматы состояний и 63 подсказки</b> — наш код</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34h21a8 8 0 0 0 1-15.9A11 11 0 0 0 15 16a9 9 0 0 0-1 18z"/><path d="M8 42 40 8"/></svg><span><b>Видео не уходит в сеть</b></span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M6 16 24 7l18 9v18l-18 9-18-9z"/><path d="M6 16l18 9 18-9M24 25v18"/></svg><span><b>Без интернета:</b> всё в vendor/, service worker</span></li>
      <li><svg class="p3-ico" viewBox="0 0 48 48" aria-hidden="true"><path d="M7 34a17 17 0 1 1 34 0"/><path d="M24 34 33 20"/><circle cx="24" cy="34" r="3"/></svg><span><b>Слабый ноутбук:</b> автонастройка качества, лёгкая модель позы</span></li>
    </ul>
  </div>
  <aside class="notes">MediaPipe — это только точки: двадцать одна на каждую кисть и поза тела. Всё остальное — наш код: 24 жеста, автоматы состояний и 63 подсказки «ОШИБКА». Распознавание идёт в браузере на видеокарте, видео не покидает ноутбук. Все библиотеки лежат в репозитории — игра работает без интернета, на сцене и в школе. На слабом ноутбуке игра сама снижает качество графики и берёт лёгкую модель позы.</aside>
</section>`
  });

  // ---------------------------------------------------------------- 8. Проверено
  Q.push({
    n: 8, sec: 35,
    html: `<section class="slide p3-slide p3-s8" data-slide="8" data-title="Проверено">
  <p class="kicker">Проверка</p>
  <h2 class="thesis">Сложно — и проверено</h2>
  <div class="p3-body">
    <div class="p3-s8__tiles">
      <article class="corner p3-tile">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-36 -40 72 80" aria-hidden="true"><g class="p3-hand">${HAND}</g></svg>
        <span class="num" data-ignite>96&nbsp;%</span>
        <p class="p3-tile__txt">формы кисти на&nbsp;135 реальных фото <span class="p3-dim">(HaGRID)</span></p>
      </article>
      <article class="corner p3-tile" data-step="1">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="0 0 84 72" aria-hidden="true"><path d="M2 58h80"/><path class="p3-ticks" d="M7 52V22M17 52V22M27 52V22M37 52V22M47 52V22M57 52V22M67 52V22M77 52V22"/></svg>
        <span class="num">8<span class="unit p3-hz">Гц</span></span>
        <p class="p3-tile__txt">распознавание 8&nbsp;раз в&nbsp;секунду: <span class="p3-nw">83–100&nbsp;%</span> попыток, 0&nbsp;ложных <span class="p3-dim">· синтетический тест</span></p>
      </article>
      <article class="corner p3-tile" data-step="2">
        <i class="p3-tile__bg" aria-hidden="true"></i>
        <svg class="p3-tile__ico" viewBox="-40 -40 80 80" aria-hidden="true"><circle r="30"/><circle r="22" class="p3-thin"/><path d="M-12 1 -3 10 14 -9"/></svg>
        <span class="num">1050+</span>
        <p class="p3-tile__txt">проверок, 0&nbsp;падений; наборов <span class="p3-nw">31 ${AR} 59</span></p>
      </article>
    </div>
    <p class="src p3-s8__src">dev/handGestures.real.test.mjs · dev/lowfps.test.mjs · прогон всех наборов</p>
  </div>
  <aside class="notes">Жесты проверены на 135 реальных фотографиях рук из датасета HaGRID: 96 % форм кисти распознаются верно. В синтетическом тесте при 8 кадрах распознавания в секунду — это старый школьный ноутбук — жесты срабатывают в 83–100 % попыток и ни разу не ложно. Наборов тестов стало 59 вместо 31, больше 1050 проверок, ни одного падения.</aside>
</section>`
  });

  // ---------------------------------------------------------------- 9. После отбора: таймлайн «Ярость клятвы»
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
        <li class="p3-tl__node" data-step="1"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">02.10</span><h3 class="p3-tl__name">Доступнее</h3></li>
        <li class="p3-tl__node" data-step="2"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">02.10</span><h3 class="p3-tl__name">Глубже</h3></li>
        <li class="p3-tl__node" data-step="3"><span class="p3-tl__gem" aria-hidden="true"></span><span class="p3-tl__date">03.10</span><h3 class="p3-tl__name">Красивее</h3></li>
      </ol>
    </div>
    <ul class="p3-s9__nums">
      <li><span class="p3-s9__label">Вход в бой</span><span class="p3-s9__row"><span class="num" data-ignite>6${AR}2</span><span class="unit">клика</span></span></li>
      <li><span class="p3-s9__label">Жесты</span><span class="p3-s9__row"><span class="num">20${AR}24</span></span></li>
      <li><span class="p3-s9__label">Ассеты</span><span class="p3-s9__row"><span class="num">36${AR}10</span><span class="unit">МБ</span></span></li>
    </ul>
  </div>
  <aside class="notes">База — версия отбора от 30 сентября, коммит 15298a8. Первая волна, 2 октября — доступнее: режим «Новичок» и автоход, жесты держатся на 8–15 кадрах распознавания в секунду, вход в бой за два клика вместо шести, офлайн, свой звук, ассеты сжаты с 36 до 10 мегабайт. Вторая волна, тоже 2 октября — глубже: «Врата бури», «Столп небес», ультимейт «Небесный суд», «Дух игрока», «Испытание · 60 с», голос тренера, курсор-кисть; жестов стало 24 вместо 20. Третья, 3 октября — красивее: новый Регент, интерфейс уровня RPG, арена, лица, волосы и наряды героев, аура и витрина меню.</aside>
</section>`
  });

  // ---------------------------------------------------------------- 10. Было → стало: шторка только для совпадающих кадров
  Q.push({
    n: 10, sec: 50,
    html: `<section class="slide p3-slide p3-s10" data-slide="10" data-title="Было → стало">
  <p class="kicker">Было ${AR} стало</p>
  <h2 class="thesis">Та же игра, другой уровень</h2>
  <div class="p3-body">
    <figure class="p3-wipe" data-interactive data-no-nav aria-label="Шторка «до и после»: её можно тянуть мышью">
      <div class="p3-wipe__pair p3-wipe__pair--a">
        <img class="p3-wipe__img" src="../docs/screenshots/menu.jpg" alt="Меню в версии отбора: три кнопки">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="../docs/screenshots/w4-check/01_menu.jpg" alt="Меню 3 октября: пять режимов и книга заклинаний">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
      <div class="p3-wipe__pair p3-wipe__pair--b">
        <img class="p3-wipe__img" src="media/p3/regent_before.jpg" alt="Регент Нимба в версии отбора">
        <span class="p3-wipe__tag p3-wipe__tag--before">версия отбора · 30.09</span>
        <div class="p3-wipe__after">
          <img class="p3-wipe__img" src="media/p3/regent_after.jpg" alt="Регент Нимба 3 октября: обсидиан с золотом">
          <span class="p3-wipe__tag p3-wipe__tag--after">03.10</span>
        </div>
        <i class="p3-wipe__edge" aria-hidden="true"></i>
      </div>
    </figure>
    <ol class="p3-s10__caps">
      <li class="p3-s10__cap" data-step="1"><b>Меню:</b> 3 кнопки ${AR} 5 режимов и книга заклинаний</li>
      <li class="p3-s10__cap" data-step="2"><b>Регент:</b> обсидиан с золотом, корона-затмение</li>
    </ol>
    <div class="p3-s10__battle">
      <p class="p3-s10__cap"><b>Бой:</b> отладка ${AR} интерфейс RPG</p>
      <img class="p3-s10__shot" src="../docs/screenshots/battle.jpg" alt="Бой в версии отбора: отладочные надписи">
      ${AR}
      <img class="p3-s10__shot" src="../docs/screenshots/w4-check/03_battle.jpg" alt="Бой 3 октября: интерфейс RPG">
    </div>
    <p class="cap p3-s10__note">Кадры боя сняты с клавиатуры, с разных точек.</p>
  </div>
  <aside class="notes">Слева то, что видело жюри на отборе, справа — сегодняшний main, тот же кадр. В меню вместо трёх кнопок — пять режимов и книга заклинаний. Регент теперь из обсидиана с золотом, с короной-затмением. Бой снят с разных точек, поэтому показываем его рядом: вместо отладочных надписей — интерфейс уровня RPG с «Яростью клятвы» и «Духом игрока».</aside>
</section>`,
    enter: function (el) { wipeReset(el); wipeBind(el); },
    leave: function (el) { wipeReset(el); },
    step: function (el) { wipeReset(el); }
  });

  // ---------------------------------------------------------------- 11. Красивее — и загружается в 3,5 раза легче
  // Тезис «легче в бою» не держим: после визуальной волны высокое качество упирается в процессор (1c2c4ad).
  // «Легче» — про загрузку: assets/ 35,7 → 10,0 МБ (git ls-tree, 15298a8 → 63f908a; сжатие — eca6f51).
  Q.push({
    n: 11, sec: 35,
    html: `<section class="slide p3-slide p3-s11" data-slide="11" data-title="Красивее и легче">
  <p class="kicker">Картинка</p>
  <h2 class="thesis">Красивее — и&nbsp;загружается в&nbsp;3,5&nbsp;раза легче</h2>
  <div class="p3-body">
    <figure class="p3-s11__look">
      <img src="../docs/screenshots/attire/lineup_before_after.jpg" alt="Герои до и после: наряды, лица, волосы">
      <span class="frame" aria-hidden="true"></span>
    </figure>
    <figure class="p3-s11__vid">
      <video data-src="../docs/video/spells_before_after.mp4" poster="media/p3/spells_ba.jpg" muted loop playsinline preload="none"></video>
      <img class="print-poster" src="media/p3/spells_ba.jpg" alt="">
    </figure>
    <div class="p3-s11__stat">
      <span class="num" data-ignite>3,5×</span>
      <span class="unit">ассеты 35,7 ${AR} 10&nbsp;МБ</span>
      <p class="cap">модели — meshopt, текстуры — WebP</p>
    </div>
    <ul class="p3-s11__steps">
      <li data-step="1"><b>Герои:</b> лица, волосы, наряды</li>
      <li data-step="2"><b>Арена:</b> живой огонь, мокрый пол</li>
      <li data-step="3"><b>Заклинания:</b> цвет стихии, ядро и ореол</li>
    </ul>
    <p class="src p3-s11__src">−26&nbsp;% вызовов отрисовки в бою — до/после визуальной волны 03.10, docs/visual-budget.md</p>
  </div>
  <aside class="notes">Картинка стала другой: новые лица, волосы и наряды героев, у арены живой огонь и мокрый пол, у заклинаний цвет стихии и яркое ядро. При этом игра загружается в три с половиной раза легче: ассеты сжались с 36 до 10 мегабайт — модели через meshopt, текстуры в WebP.</aside>
</section>`,
    enter: function (el) { videoFallback(el); }
  });
})();
